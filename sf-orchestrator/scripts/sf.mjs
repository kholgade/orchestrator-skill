#!/usr/bin/env node
// sf-orchestrator CLI: readiness, supervisor control, assessment/resume/reset, status, audit/replay/export.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cliMain, parseArgs, findRoot, sfPaths, printJson, SfError, exists, readJson, readText, atomicWrite, sleep, isPidAlive, mkdirp, redact } from './lib/util.mjs';
import { softFactory } from './lib/factory.mjs';
import { parseSpec, lintSpec, buildIndex } from './lib/spec.mjs';
import { loadPlanRaw, lintPlan } from './lib/plan.mjs';
import { Store, readLock, supervisorAlive, enqueueCommand, applyCommand, withStateLock } from './lib/state.mjs';
import { buildDigest } from './lib/notify.mjs';
import { tailFile } from './lib/runner.mjs';
import { verifyChain, ledgerAppend } from './lib/journal.mjs';
import { CONFIRM_OPTIONS, confirmAction } from './lib/confirm.mjs';
import { SF_VERSION } from './lib/version.mjs';
import { Supervisor, buildReport } from './supervisor.mjs';
import { assess, decisionRequired, renderAssessment, killVerifiedOrphans } from './assess.mjs';
import { archiveRun, restoreRun, resetTask, listRuns, pruneArchive, describeArchive } from './archive.mjs';
import { runLocation, timeline, replayState, summarizeState, exportBundle } from './replay.mjs';
import { readEvents } from './lib/journal.mjs';

const self = fileURLToPath(import.meta.url);
const OPTS = {
  root: { type: 'string' }, json: { type: 'boolean' }, detach: { type: 'boolean' }, 'exit-when-idle': { type: 'boolean' },
  'allow-unverified': { type: 'boolean' }, milestone: { type: 'string' }, note: { type: 'string' }, 'extra-rounds': { type: 'string' },
  implementer: { type: 'string' }, 'reset-rounds': { type: 'boolean' }, timeout: { type: 'string' }, since: { type: 'string' },
  tail: { type: 'string' }, out: { type: 'string' }, follow: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  assessment: { type: 'string' }, decision: { type: 'string' }, task: { type: 'string' }, run: { type: 'string' }, reason: { type: 'string' },
  logs: { type: 'boolean' }, verbose: { type: 'boolean' }, to: { type: 'string' }, 'git-bundle': { type: 'boolean' },
  msg: { type: 'string' }, kind: { type: 'string' }, by: { type: 'string' }, 'then-run': { type: 'boolean' }, step: { type: 'string' },
  ...CONFIRM_OPTIONS,
};
const USAGE = `sf-orchestrator ${SF_VERSION} — deterministic multi-agent delivery supervisor

Usage: node sf.mjs <command> [options]
 Readiness / run
  check [--json]                      readiness agents→spec→plan; names the skill to run next + the question to ask the user before building anything missing
  consent --step agents|spec|plan --decision allow|decline [--quote t]   record the user's answer to that question (ledger)
  run [--detach] [--exit-when-idle] [--allow-unverified]   start/resume (refuses crashed/inconsistent runs without a confirmed decision)
  stop [--by who]                     graceful stop; state kept
 Observe
  status [--json] | digest | events [--tail n] [--since seq] [--follow] [--json]
  wait [--timeout s] [--since seq] [--json]
  explain <task> [--json]  | report [--out f]
 Resume / reset (one active run at all times; archives are never deleted automatically)
  assess [--json]                     read-only: what happened, what is recoverable, what is recommended
  resume --assessment <id> --decision resume|reset-task|reset-run|restore [--task T1,T2] [--run <archived-id>] [--reason t] [--then-run]
  runs [--json]                       active + archived runs
  archive show <run-id> | archive prune <run-id> [--logs]   (prune deletes archived worktrees/branches; needs confirmation)
 Audit
  timeline [--run id] [--task T] [--verbose] | replay [--run id] [--to seq] [--json] | export --out <dir> [--run id] [--git-bundle]
  note --msg <text> [--kind decision|note] [--task T] [--by who]
 Gates
  approve --milestone <id> [--note t]   unblock <task> [--extra-rounds n] [--implementer id] [--note t] [--reset-rounds] | unblock --milestone <id>
Confirmation (approve/resume/reset/prune): interactive terminal prompt as "user", or --confirmed-by user|external:<id> [--via name] [--quote "words"].
Options: --root <dir>`;

function readiness(root) {
  const steps = [];
  const sf = softFactory(root);
  const p = sf.paths;
  let agentsOk = false;
  if (!exists(p.factory)) steps.push({ step: 'agents', ok: false, detail: 'no .sf/factory.yaml', next: { skill: 'sf-agent-setup', action: 'interview the user about agents/roles/notifications, write .sf/factory.yaml, run validate and doctor' } });
  else if (!sf.factory) steps.push({ step: 'agents', ok: false, detail: `factory.yaml invalid: ${sf.problem}`, next: { skill: 'sf-agent-setup', action: 'fix factory.yaml (run setup.mjs validate)' } });
  else {
    const doc = exists(p.doctor) ? readJson(p.doctor) : { agents: {} };
    const used = [...new Set([...sf.factory.roles.implementers, ...sf.factory.roles.reviewers])];
    const bad = used.filter((id) => !doc.agents?.[id]?.ok);
    agentsOk = bad.length === 0;
    steps.push(agentsOk ? { step: 'agents', ok: true, detail: `implementers [${sf.factory.roles.implementers}] reviewers [${sf.factory.roles.reviewers}] verified` } : { step: 'agents', ok: false, detail: `not verified by doctor: ${bad.join(', ')}`, next: { skill: 'sf-agent-setup', action: 'run setup.mjs doctor' } });
  }
  let specIndex = null;
  if (!exists(p.spec)) steps.push({ step: 'spec', ok: false, detail: `no spec at ${path.relative(root, p.spec)}`, next: { skill: 'sf-spec-builder', action: 'interview the user (or from-answers <answers.yaml>), lint, then approve' } });
  else {
    try {
      const rel = path.relative(root, p.spec).split(path.sep).join('/');
      const parsed = parseSpec(readText(p.spec), { filename: rel });
      const l = lintSpec(parsed, { filename: rel });
      if (l.errors.length) steps.push({ step: 'spec', ok: false, detail: `${l.errors.length} lint error(s): ${l.errors[0]}`, next: { skill: 'sf-spec-builder', action: 'fix lint errors' } });
      else if (parsed.meta.status !== 'approved') steps.push({ step: 'spec', ok: false, detail: 'spec is a draft', next: { skill: 'sf-spec-builder', action: 'review with the user, resolve open questions, run approve' } });
      else { specIndex = buildIndex(parsed, { specPath: rel }); steps.push({ step: 'spec', ok: true, detail: `${specIndex.requirements.length} requirement(s), approved` }); }
    } catch (e) {
      steps.push({ step: 'spec', ok: false, detail: e.message, next: { skill: 'sf-spec-builder', action: 'repair the spec format' } });
    }
  }
  if (!exists(p.plan)) steps.push({ step: 'plan', ok: false, detail: `no plan at ${path.relative(root, p.plan)}`, next: { skill: 'sf-plan-builder', action: 'scaffold or delegate, refine, lint, then approve' } });
  else if (!specIndex) steps.push({ step: 'plan', ok: false, detail: 'cannot check plan until the spec is approved', next: null });
  else {
    try {
      const plan = loadPlanRaw(p.plan);
      const l = lintPlan(plan, { specIndex, factory: sf.factory ?? undefined, requireApproved: true });
      if (l.errors.length) steps.push({ step: 'plan', ok: false, detail: `${l.errors.length} problem(s): ${l.errors[0]}`, next: { skill: 'sf-plan-builder', action: l.errors.some((e) => /status is|spec drift/.test(e)) ? 'review then approve (or rehash after spec change)' : 'fix lint errors' } });
      else steps.push({ step: 'plan', ok: true, detail: `${plan.tasks.length} task(s) in ${plan.milestones.length} milestone(s), approved` });
    } catch (e) {
      steps.push({ step: 'plan', ok: false, detail: e.message, next: { skill: 'sf-plan-builder', action: 'repair the plan' } });
    }
  }
  const consents = new Set(readEvents(p.ledger).filter((e) => e.type === 'build_consent' && e.data?.decision === 'allow').map((e) => e.data.step));
  const declined = new Set(readEvents(p.ledger).filter((e) => e.type === 'build_consent' && e.data?.decision === 'decline').map((e) => e.data.step));
  const ASK = {
    agents: { question: 'No agent setup exists yet. May I run sf-agent-setup to interview you about which agents play which roles and build .sf/factory.yaml?', options: ['Yes, set up agents now', 'I will provide a factory.yaml (give the path)', 'Stop'] },
    spec: { question: 'There is no spec. May I build one now with sf-spec-builder? I can interview you, use a document or YAML you point me to, or have your configured spec-author agent draft it. Nothing is built or run until you review and approve the spec.', options: ['Yes, interview me', 'Yes, draft it from a file/YAML I give you (path)', 'I will write the spec myself', 'Stop'] },
    plan: { question: 'The spec is approved but there is no plan. May I draft an execution plan (milestones, tasks, write scopes, verify commands) with sf-plan-builder for your review? No agent work starts until you approve the plan.', options: ['Yes, draft the plan', 'I will provide a plan.yaml (give the path)', 'Stop'] },
  };
  for (const s of steps) {
    const missing = !s.ok && /^no /.test(s.detail);
    if (missing && ASK[s.step]) Object.assign(s, { ask: ASK[s.step], consent: declined.has(s.step) ? 'declined' : consents.has(s.step) ? 'allowed' : 'not_asked' });
  }
  const failing = steps.find((s) => !s.ok && s.next);
  return {
    ready: steps.every((s) => s.ok), steps,
    next: failing?.next ? { ...failing.next, because: failing.detail, ...(failing.ask ? { ask_user_first: failing.consent !== 'allowed', consent: failing.consent, ask: failing.ask } : {}) } : null,
    supervisor: readLock(p),
  };
}

function loadStore(root, actor = 'user') {
  const { paths } = softFactory(root);
  if (!Store.exists(paths)) throw new SfError('No run state yet. Start with: node sf.mjs run', { code: 'NO_STATE' });
  const store = new Store(paths, { actor });
  store.load();
  return { store, paths };
}

function summary(store, paths) {
  const s = store.state;
  const counts = {};
  for (const t of Object.values(s.tasks)) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return {
    project: s.project_id, run: s.run.id, sf_version: s.sf_version ?? null, supervisor_alive: supervisorAlive(paths), stop_reason: s.run.stop_reason ?? null,
    updated_at: s.updated_at, task_counts: counts,
    milestones: Object.fromEntries(Object.entries(s.milestones).map(([k, v]) => [k, v.status])),
    blocked: Object.entries(s.tasks).filter(([, t]) => t.status === 'BLOCKED').map(([id, t]) => ({ id, reason: t.blocked_reason })),
    awaiting_approval: Object.entries(s.milestones).filter(([, m]) => m.status === 'AWAITING_APPROVAL').map(([id]) => id),
    complete: Object.values(s.milestones).every((m) => m.status === 'DONE'),
  };
}

async function detach(root, argv) {
  const p = sfPaths(root);
  mkdirp(p.runtime);
  if (supervisorAlive(p)) throw new SfError(`Supervisor already running (pid ${readLock(p).pid}). Only one run may be active.`);
  const args = argv.filter((a) => a !== '--detach');
  const fd = fs.openSync(p.supervisorLog, 'a');
  const child = spawn(process.execPath, [self, ...args], { cwd: root, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  child.unref();
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (supervisorAlive(p)) { console.log(`Supervisor started in background (pid ${readLock(p).pid}). Log: ${p.supervisorLog}\nFollow with: node ${path.relative(root, self)} wait   |   status   |   events --follow`); return 0; }
    if (!isPidAlive(child.pid)) break;
  }
  console.log(`Supervisor did not start. Last log lines:\n${tailFile(p.supervisorLog, 1500)}`);
  return 1;
}

/** Route a state-changing command to the running supervisor (single writer) or apply it directly under the state lock. */
function dispatchCommand(root, cmdObj, actor) {
  const { paths } = softFactory(root);
  if (supervisorAlive(paths)) {
    enqueueCommand(paths, cmdObj);
    return { queued: true, text: `${cmdObj.kind} queued for the running supervisor.` };
  }
  return withStateLock(paths, () => {
    const store = new Store(paths, { actor });
    store.load();
    return { queued: false, text: applyCommand(store, cmdObj) };
  });
}

const whoFrom = (values) => ({ confirmed_by: values.by ?? 'user', by: values.by ?? 'user' });

async function resumeCommand(root, values) {
  const rep = assess(root);
  const decision = values.decision;
  if (!['resume', 'reset-task', 'reset-run', 'restore'].includes(decision)) throw new SfError('--decision must be resume | reset-task | reset-run | restore', { exitCode: 2 });
  if (rep.class === 'running') throw new SfError('A supervisor is running; one run only. Use "stop" first.', { code: 'LOCKED' });
  const { paths } = softFactory(root);
  if (decision !== 'restore') {
    if (!values.assessment) throw new SfError(`--assessment <id> is required (current id: ${rep.assessment_id}; run "assess" and show it to the user first)`, { exitCode: 2 });
    if (values.assessment !== rep.assessment_id) throw new SfError(`The run changed since it was assessed (given ${values.assessment}, now ${rep.assessment_id}). Re-run "assess" and re-confirm.`, { code: 'STALE_ASSESSMENT', exitCode: 4 });
  }
  const opt = rep.options.find((o) => o.decision === decision);
  if (decision !== 'restore' && !opt?.applicable) throw new SfError(`Decision "${decision}" is not applicable to a ${rep.class} run.`, { exitCode: 2 });
  const tasks = values.task ? values.task.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (decision === 'reset-task' && !tasks.length) throw new SfError('reset-task needs --task T1[,T2]', { exitCode: 2 });
  const summaryText = `${renderAssessment(rep)}\n\n=> DECISION: ${decision}${tasks.length ? ` ${tasks.join(',')}` : ''}${values.run ? ` ${values.run}` : ''}${decision === 'reset-run' ? '\n   (archives state, logs, worktrees and branches under .sf/archive; nothing is deleted)' : ''}`;
  const who = await confirmAction({ values, summary: summaryText, word: decision });
  const base = { who, reason: values.reason };
  let detail;
  const recordDecision = (assessmentId, kind) => withStateLock(paths, () => {
    const store = new Store(paths, { actor: who.confirmed_by });
    store.load();
    store.state.run.resume_decision = { decision: kind, assessment_id: assessmentId, decided_at: new Date().toISOString(), who, consumed: false };
    store.save();
    store.emit('resume_decision', { severity: 'info', actor: who.confirmed_by, msg: `decision "${kind}" confirmed by ${who.confirmed_by}${who.quote ? `: ${who.quote}` : ''}`, data: { decision: kind, assessment_id: assessmentId, who, tasks } });
  });
  if (decision === 'resume') {
    recordDecision(rep.assessment_id, 'resume');
    ledgerAppend(paths, 'resume_decision', { actor: who.confirmed_by, msg: `resume confirmed for ${rep.run.id}`, data: { run_id: rep.run.id, assessment_id: rep.assessment_id, class: rep.class, who } });
    detail = 'Decision recorded. Start with: node sf.mjs run --detach';
  } else if (decision === 'reset-task') {
    const killed = killVerifiedOrphans(readJson(paths.state));
    if (killed.length) console.log(`orphans: ${JSON.stringify(killed)}`);
    const out = tasks.map((t) => resetTask(root, t, base));
    const rep2 = assess(root);
    if (['crashed', 'clean_stop'].includes(rep2.class)) recordDecision(rep2.assessment_id, 'reset-task');
    ledgerAppend(paths, 'resume_decision', { actor: who.confirmed_by, msg: `reset-task ${tasks.join(',')}`, data: { run_id: rep.run.id, who, tasks, archives: out.map((o) => o.archive) } });
    detail = `Reset ${tasks.join(', ')}; archived to ${out.map((o) => o.archive).join(', ')}.\n${rep2.class === 'inconsistent' ? 'The run is still inconsistent; run "assess" again.' : 'Start with: node sf.mjs run --detach'}`;
  } else if (decision === 'reset-run') {
    const killed = killVerifiedOrphans(readJson(paths.state));
    if (killed.length) console.log(`orphans: ${JSON.stringify(killed)}`);
    const m = archiveRun(root, base);
    detail = `Run ${m.run_id} archived at ${path.join(paths.archive, m.run_id)}.\nNothing was deleted. ASK THE USER whether to delete the archived data:\n  worktrees: ${m.delete_candidates.worktrees.map((w) => `${w.path}${w.dirty ? ' (has uncommitted changes)' : ''}`).join(', ') || '(none)'}\n  branches: ${m.delete_candidates.branches.join(', ') || '(none)'}\n  to delete: node sf.mjs archive prune ${m.run_id} [--logs]\nStart a fresh run with: node sf.mjs run --detach`;
  } else {
    if (!values.run) throw new SfError('restore needs --run <archived-run-id>', { exitCode: 2 });
    restoreRun(root, values.run, base);
    const rep2 = assess(root);
    if (['crashed', 'clean_stop'].includes(rep2.class)) recordDecision(rep2.assessment_id, 'restore');
    detail = `Run ${values.run} restored as the active run (${rep2.class}). Start with: node sf.mjs run --detach`;
  }
  console.log(detail);
  if (values['then-run']) return await detach(root, ['run', '--root', root]);
  return 0;
}

cliMain(async () => {
  const argv = process.argv.slice(2);
  const { values, positionals } = parseArgs(argv, OPTS);
  const cmd = positionals[0];
  if (!cmd || values.help) { console.log(USAGE); return cmd || values.help ? 0 : 2; }
  const root = findRoot(values.root);

  switch (cmd) {
    case 'check': {
      const r = readiness(root);
      if (values.json) printJson(r);
      else {
        for (const s of r.steps) console.log(`${s.ok ? 'OK  ' : 'TODO'} ${s.step}: ${s.detail}${s.consent ? ` [consent: ${s.consent}]` : ''}`);
        if (r.next?.ask_user_first) console.log(`ASK THE USER FIRST: ${r.next.ask.question}\n  options: ${r.next.ask.options.join(' | ')}\n  then record: node sf.mjs consent --step ${r.steps.find((s) => s.ask)?.step} --decision allow|decline --confirmed-by user --quote "<their words>"`);
        console.log(r.ready ? 'READY to run: node sf.mjs run' : r.next ? `NEXT: invoke ${r.next.skill} — ${r.next.action}${r.next.ask_user_first ? ' (only after the user agrees)' : ''}` : 'NOT READY');
      }
      return r.ready ? 0 : 1;
    }
    case 'consent': {
      if (!['agents', 'spec', 'plan'].includes(values.step)) throw new SfError('consent needs --step agents|spec|plan', { exitCode: 2 });
      if (!['allow', 'decline'].includes(values.decision)) throw new SfError('consent needs --decision allow|decline', { exitCode: 2 });
      const { paths } = softFactory(root);
      const who = await confirmAction({ values, word: `${values.decision} ${values.step}`, summary: `Record: user ${values.decision === 'allow' ? 'ALLOWS' : 'DECLINES'} building the missing "${values.step}" as part of this delivery.` });
      ledgerAppend(paths, 'build_consent', { actor: who.confirmed_by, msg: `${values.decision} building ${values.step}`, data: { step: values.step, decision: values.decision, who } });
      console.log(values.decision === 'allow' ? `Recorded. Proceed with the ${values.step} step.` : `Recorded. Do not build ${values.step}; ask the user how they want to proceed (or stop).`);
      return 0;
    }
    case 'assess': {
      const rep = assess(root);
      if (values.json) printJson(rep); else console.log(renderAssessment(rep));
      return 0;
    }
    case 'resume': return await resumeCommand(root, values);
    case 'runs': {
      const runs = listRuns(root);
      if (values.json) printJson(runs);
      else if (!runs.length) console.log('No runs.');
      else for (const r of runs) console.log(`${r.active ? '* ACTIVE ' : '  archived'} ${r.run_id}${r.active ? ` (supervisor ${r.supervisor_alive ? 'running' : 'not running'}${r.stop_reason ? `, ${r.stop_reason}` : ''})` : ` ${r.archived_at}${r.pruned ? ' [pruned]' : ''} ${JSON.stringify(r.task_summary)}`}`);
      return 0;
    }
    case 'archive': {
      const sub = positionals[1];
      const id = positionals[2];
      if (!['show', 'prune'].includes(sub) || !id) throw new SfError('usage: archive show <run-id> | archive prune <run-id> [--logs]', { exitCode: 2 });
      if (sub === 'show') { printJson(describeArchive(root, id)); return 0; }
      const m = describeArchive(root, id);
      const sum = `Permanently delete archived run ${id}:\n${m.worktrees.filter((w) => w.ok).map((w) => `  worktree ${w.to}${w.dirty ? '  (HAS UNCOMMITTED CHANGES)' : ''}`).join('\n') || '  (no worktrees)'}\n${m.branches.filter((b) => b.ok).map((b) => `  branch ${b.to}`).join('\n') || '  (no branches)'}${values.logs ? `\n  and all logs under ${path.join(softFactory(root).paths.archive, id)}` : ''}`;
      const who = await confirmAction({ values, summary: sum, word: `delete ${id}` });
      printJson(pruneArchive(root, id, { logs: values.logs, who }));
      return 0;
    }
    case 'run': {
      const rep = assess(root);
      const need = decisionRequired(rep);
      if (rep.class === 'running') throw new SfError(`A supervisor is already running (pid ${rep.supervisor.pid}). Only one run may be active.`, { code: 'LOCKED' });
      if (need) {
        const { paths } = softFactory(root);
        const d = readJson(paths.state).run.resume_decision;
        const valid = d && !d.consumed && d.assessment_id === rep.assessment_id;
        if (!valid) {
          throw new SfError(`Refusing to continue: ${need}.`, { code: 'DECISION_REQUIRED', exitCode: 4, details: [
            `Assessment ${rep.assessment_id}; recommendation: ${rep.recommendation.action}.`,
            'Run "node sf.mjs assess", show the result to the user, then: node sf.mjs resume --assessment <id> --decision resume|reset-task|reset-run --confirmed-by user --quote "<their words>"',
            d && !valid ? 'A previous decision exists but no longer matches the run state (stale or already used).' : '',
          ].filter(Boolean) });
        }
      }
      if (values.detach) return await detach(root, argv.includes('--root') ? argv : [...argv, '--root', root]);
      const r = readiness(root);
      const blocking = r.steps.filter((s) => !s.ok && !(s.step === 'agents' && values['allow-unverified'] && /not verified/.test(s.detail)));
      if (blocking.length) throw new SfError('Not ready to run', { details: [...blocking.map((s) => `${s.step}: ${s.detail}`), r.next ? `Next: ${r.next.skill} — ${r.next.action}` : ''] });
      const sup = new Supervisor({ root, exitWhenIdle: values['exit-when-idle'], allowUnverified: values['allow-unverified'] });
      const onSig = () => sup.requestStop('interrupted by signal');
      process.on('SIGINT', onSig);
      process.on('SIGTERM', onSig);
      const reason = await sup.run();
      console.log(`supervisor exited: ${reason}`);
      return reason === 'complete' ? 0 : reason === 'idle' ? 3 : 0;
    }
    case 'status': {
      const { store, paths } = loadStore(root);
      const sm = summary(store, paths);
      if (values.json) printJson({ ...sm, tasks: Object.fromEntries(Object.entries(store.state.tasks).map(([id, t]) => [id, { status: t.status, milestone: t.milestone, attempt: t.attempt, rework_rounds: t.rework_rounds, implementer: t.implementer, reviewer: t.reviewer, blocked_reason: t.blocked_reason, activity: t.activity }])) });
      else console.log(`supervisor: ${sm.supervisor_alive ? `running (pid ${readLock(paths).pid})` : `not running${sm.stop_reason ? ` (${sm.stop_reason})` : ''}`}\n${buildDigest(store.state, { events: store.readEvents({ limit: 6 }) })}`);
      return 0;
    }
    case 'digest': {
      const { store } = loadStore(root);
      console.log(buildDigest(store.state, { events: store.readEvents({ limit: 6 }) }));
      return 0;
    }
    case 'events': {
      const { store, paths } = loadStore(root);
      if (values.follow) {
        let since = values.since ? Number(values.since) : Math.max(0, store.lastSeq() - (values.tail ? Number(values.tail) : 0));
        const deadline = values.timeout ? Date.now() + Number(values.timeout) * 1000 : Infinity;
        let quiet = 0;
        while (Date.now() < deadline) {
          const evs = readEvents(paths.events, { since });
          for (const e of evs) { process.stdout.write(JSON.stringify(e) + '\n'); since = e.seq; }
          quiet = evs.length ? 0 : quiet + 1;
          if (!supervisorAlive(paths) && quiet >= 3) break;
          await sleep(500);
        }
        return 0;
      }
      const evs = store.readEvents({ since: values.since ? Number(values.since) : 0, limit: values.tail ? Number(values.tail) : 30 });
      if (values.json) printJson(evs);
      else for (const e of evs) console.log(`#${e.seq} ${e.ts.slice(11, 19)} [${e.severity}] ${e.type}${e.id ? ` ${e.id}` : ''}: ${e.msg}`);
      return 0;
    }
    case 'timeline': {
      const loc = runLocation(root, values.run);
      console.log(timeline(readEvents(loc.events), { task: values.task, verbose: values.verbose }).join('\n'));
      return 0;
    }
    case 'replay': {
      const loc = runLocation(root, values.run);
      const events = readEvents(loc.events);
      const chain = verifyChain(loc.events);
      const to = values.to ? Number(values.to) : Infinity;
      const st = replayState(events, to);
      if (!st) throw new SfError('The log has no state_init event; cannot replay.');
      const out = { run: loc.id, chain, at_seq: Number.isFinite(to) ? to : chain.lastSeq, summary: summarizeState(st), state: values.json ? st : undefined };
      if (values.json) printJson(out);
      else {
        console.log(`run ${loc.id} @ seq ${out.at_seq} — event chain ${chain.ok ? 'OK' : `BROKEN (${chain.reason})`}`);
        console.log(`tasks: ${JSON.stringify(out.summary.tasks)}  milestones: ${JSON.stringify(out.summary.milestones)}`);
        for (const [id, t] of Object.entries(st.tasks)) console.log(`  ${id} ${t.status} attempt ${t.attempt} rework ${t.rework_rounds}${t.blocked_reason ? ` — ${t.blocked_reason}` : ''}`);
      }
      return chain.ok ? 0 : 1;
    }
    case 'export': {
      if (!values.out) throw new SfError('export needs --out <directory>', { exitCode: 2 });
      const r = exportBundle(root, { runId: values.run, out: path.resolve(values.out), gitBundle: values['git-bundle'] });
      console.log(`Exported ${r.files} files to ${r.out}; event chain ${r.chain.ok ? 'OK' : `BROKEN (${r.chain.reason})`}; replay ${r.replay_matches_state ? 'matches' : 'DOES NOT match'} state.json`);
      return 0;
    }
    case 'note': {
      if (!values.msg) throw new SfError('note needs --msg <text>', { exitCode: 2 });
      const cmdObj = { kind: 'note', note_kind: values.kind ?? 'note', msg: values.msg, task: values.task ?? null, who: whoFrom(values) };
      const { paths } = softFactory(root);
      if (!Store.exists(paths)) { ledgerAppend(paths, 'note', { actor: cmdObj.who.by, msg: values.msg, data: { kind: cmdObj.note_kind } }); console.log('Recorded in the ledger (no active run).'); return 0; }
      console.log(dispatchCommand(root, cmdObj, cmdObj.who.by).text);
      return 0;
    }
    case 'wait': {
      const timeoutMs = (values.timeout ? Number(values.timeout) : 300) * 1000;
      const { store, paths } = loadStore(root);
      let since = values.since !== undefined ? Number(values.since) : store.lastSeq();
      const start = Date.now();
      for (;;) {
        const fresh = new Store(paths);
        fresh.load();
        const evs = fresh.readEvents({ since });
        const notable = evs.filter((e) => ['error', 'approval', 'done'].includes(e.severity));
        const sm = summary(fresh, paths);
        const reason = notable.length ? 'event' : sm.complete ? 'complete' : !sm.supervisor_alive ? 'supervisor_not_running' : Date.now() - start >= timeoutMs ? 'timeout' : null;
        if (reason) {
          const out = { reason, last_seq: fresh.lastSeq(), events: (notable.length ? notable : evs.filter((e) => e.type !== 'state_delta').slice(-5)).map((e) => ({ seq: e.seq, severity: e.severity, type: e.type, id: e.id, msg: e.msg })), ...sm };
          if (values.json) printJson(out);
          else { console.log(`wait: ${reason} (last_seq ${out.last_seq})`); for (const e of out.events) console.log(`  #${e.seq} [${e.severity}] ${e.msg}`); console.log(buildDigest(fresh.state, {})); }
          return 0;
        }
        await sleep(1000);
      }
    }
    case 'explain': {
      const id = positionals[1];
      if (!id) throw new SfError('explain needs a task id', { exitCode: 2 });
      const { store } = loadStore(root);
      const t = store.task(id);
      const out = { id, ...t };
      if (values.json) { printJson(out); return 0; }
      console.log(`${id}: ${t.title} — ${t.status}${t.blocked_reason ? `\n  BLOCKED: ${t.blocked_reason}` : ''}`);
      console.log(`  milestone ${t.milestone}; implementer ${t.implementer ?? '-'}; reviewer ${t.reviewer ?? '-'}; attempt ${t.attempt}; rework ${t.rework_rounds} (+${t.extra_rounds} extra)`);
      console.log(`  branch ${t.branch ?? '-'}; worktree ${t.worktree ?? '(removed)'}`);
      if (t.findings.length) { console.log('  open findings:'); for (const f of t.findings) console.log(`    - [${f.source}/${f.severity ?? ''}] ${f.description.split('\n')[0]}${f.log ? `  (log: ${f.log})` : ''}`); }
      if (t.evidence) { console.log(`  evidence (${t.evidence.at}): scope ${t.evidence.scope.ok ? 'OK' : 'VIOLATION'}; changed ${t.evidence.changed.length} file(s)`); for (const v of t.evidence.verify) console.log(`    - ${v.name}: ${v.ok ? 'PASS' : `FAIL exit ${v.exitCode}`}  ${v.log}`); }
      if (t.review) console.log(`  review: ${t.review.status} by ${t.review.reviewer} — ${t.review.summary}\n    result: ${t.review.result}`);
      console.log(`  history: ${store.readEvents({ limit: 100000 }).filter((e) => e.id === id && e.type !== 'state_delta').slice(-8).map((e) => `\n    #${e.seq} ${e.msg}`).join('')}`);
      return 0;
    }
    case 'approve': {
      if (!values.milestone) throw new SfError('approve needs --milestone <id> (spec/plan approval belongs to sf-spec-builder / sf-plan-builder)', { exitCode: 2 });
      const { store } = loadStore(root);
      const m = store.milestone(values.milestone);
      const sum = `Approve milestone ${values.milestone} (${m.status}) — branch ${m.branch}\nGate: ${JSON.stringify(m.gate?.results?.map((g) => `${g.name}:${g.ok ? 'PASS' : 'FAIL'}`) ?? [])}`;
      const who = await confirmAction({ values, summary: sum, word: `approve ${values.milestone}` });
      const r = dispatchCommand(root, { kind: 'approve_milestone', id: values.milestone, note: values.note, who }, who.confirmed_by);
      console.log(r.text);
      if (!r.queued) console.log('Supervisor is not running; start it to finalize: node sf.mjs run --detach');
      return 0;
    }
    case 'unblock': {
      const base = { note: values.note, who: whoFrom(values) };
      const cmdObj = values.milestone
        ? { kind: 'unblock_milestone', id: values.milestone, ...base }
        : { kind: 'unblock_task', id: positionals[1], ...base, extra_rounds: values['extra-rounds'] ? Number(values['extra-rounds']) : 0, implementer: values.implementer, reset_rounds: values['reset-rounds'] };
      if (!cmdObj.id) throw new SfError('unblock needs a task id or --milestone <id>', { exitCode: 2 });
      const r = dispatchCommand(root, cmdObj, base.who.by);
      console.log(r.text);
      if (!r.queued) console.log('Supervisor is not running; start it to continue: node sf.mjs run --detach');
      return 0;
    }
    case 'stop': {
      const p = softFactory(root).paths;
      if (!supervisorAlive(p)) { console.log('Supervisor is not running.'); return 0; }
      enqueueCommand(p, { kind: 'stop', who: whoFrom(values) });
      for (let i = 0; i < 300; i++) { await sleep(100); if (!supervisorAlive(p)) { console.log('Supervisor stopped; state preserved. Resume with: node sf.mjs assess, then run'); return 0; } }
      console.log('Stop requested; supervisor is still shutting down.');
      return 1;
    }
    case 'report': {
      const { store } = loadStore(root);
      const plan = loadPlanRaw(softFactory(root).paths.plan);
      const text = buildReport(store.state, plan);
      if (values.out) { atomicWrite(path.resolve(values.out), text); console.log(`Wrote ${values.out}`); }
      else process.stdout.write(text);
      return 0;
    }
    default:
      throw new SfError(`Unknown command "${cmd}"\n${USAGE}`, { exitCode: 2 });
  }
});

void redact;
