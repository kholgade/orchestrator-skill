// Read-only run assessment: compares persisted state, event log, plan/spec and actual git to decide how a
// previous run can be continued. Output is deterministic and binds confirmation decisions via assessment_id.
import fs from 'node:fs';
import path from 'node:path';
import { sha256, exists, readJson, readText, isPidAlive, sameProcess, nowIso, slug } from './lib/util.mjs';
import { softFactory } from './lib/factory.mjs';
import { Store, readLock, supervisorAlive, listInbox, taskDef, taskDefFingerprint } from './lib/state.mjs';
import { verifyChain, foldEvents, stripVolatile, readEvents } from './lib/journal.mjs';
import { parseSpec, lintSpec, buildIndex } from './lib/spec.mjs';
import { loadPlanRaw } from './lib/plan.mjs';
import * as G from './lib/git.mjs';
import { SF_VERSION } from './lib/version.mjs';
import { treeFingerprint } from './lib/git.mjs';

/** Intents with no matching result since the last reconciliation point. */
export function pendingOps(events) {
  let from = 0;
  for (const e of events) if (e.type === 'ops_reconciled') from = e.seq;
  const results = new Set(events.filter((e) => e.type === 'result' && e.seq > from).map((e) => e.op_id));
  return events
    .filter((e) => e.type === 'intent' && e.seq > from && !results.has(`op-${e.seq}`))
    .map((e) => ({ op_id: `op-${e.seq}`, seq: e.seq, op: e.data?.op, entity: e.entity, id: e.id, attempt: e.attempt ?? null, ts: e.ts }));
}

function safe(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

export function assess(root) {
  const sf = softFactory(root);
  const paths = sf.paths;
  const factory = sf.factory;
  const R = {
    assess_version: 1, sf_version: SF_VERSION, generated_at: nowIso(), root, class: null, reasons: [],
    run: null, supervisor: { alive: false }, integrity: {}, drift: { spec: null, plan: { added: [], removed: [], changed: [] }, breaking: false },
    tasks: [], milestones: [], orphans: [], unknown_git: { worktrees: [], branches: [] }, pending_ops: [], inbox: [], archived_runs: [],
    recommendation: null, options: [], assessment_id: null,
  };
  R.archived_runs = exists(paths.archive) ? fs.readdirSync(paths.archive).filter((d) => exists(path.join(paths.archive, d, 'manifest.json'))) : [];

  if (!Store.exists(paths)) {
    R.class = 'fresh';
    R.reasons.push('no run state');
    R.recommendation = { action: 'start', safe_auto: true, reasons: ['no previous run in this project'] };
    R.assessment_id = sha256('fresh').slice(0, 16);
    return R;
  }

  const state = readJson(paths.state);
  const events = readEvents(paths.events);
  const chain = verifyChain(paths.events);
  const folded = foldEvents(events);
  const stateMatches = folded ? JSON.stringify(stripVolatile(folded)) === JSON.stringify(stripVolatile(state)) : null;
  R.run = { id: state.run.id, started_at: state.run.started_at, sf_version: state.sf_version ?? null, stop_reason: state.run.stop_reason ?? null, supervisor_pid: state.run.supervisor_pid ?? null, last_event_seq: chain.lastSeq };
  R.integrity = {
    event_chain: chain.ok ? 'ok' : `broken: ${chain.reason} (seq ${chain.brokenAt})`,
    chain_ok: chain.ok,
    state_vs_log: stateMatches === null ? 'no_init_event' : stateMatches ? 'match' : 'differs',
    repairable_from_log: Boolean(chain.ok && folded),
  };

  const lock = readLock(paths);
  const alive = supervisorAlive(paths);
  const hbAge = lock?.heartbeat_at ? Math.round((Date.now() - Date.parse(lock.heartbeat_at)) / 1000) : null;
  R.supervisor = { alive, pid: lock?.pid ?? null, heartbeat_age_s: hbAge, stale_heartbeat: Boolean(alive && hbAge !== null && hbAge > 60), recorded_pid: state.run.supervisor_pid ?? null };

  // ---- spec / plan drift
  let specIndex = null;
  safe(() => {
    const rel = path.relative(root, paths.spec).split(path.sep).join('/');
    const parsed = parseSpec(readText(paths.spec), { filename: rel });
    if (!lintSpec(parsed, { filename: rel }).errors.length) specIndex = buildIndex(parsed, { specPath: rel });
  });
  if (specIndex && state.run.spec_hash) R.drift.spec = specIndex.spec_hash !== state.run.spec_hash;
  const plan = safe(() => loadPlanRaw(paths.plan));
  if (plan) {
    const planIds = new Set(plan.tasks.map((t) => t.id));
    for (const t of plan.tasks) {
      const rec = state.tasks[t.id];
      if (!rec) R.drift.plan.added.push(t.id);
      else if (rec.plan_fp !== taskDefFingerprint(t)) {
        const old = rec.plan_def ?? {};
        const now = taskDef(t);
        const fields = Object.keys(now).filter((k) => JSON.stringify(old[k]) !== JSON.stringify(now[k]));
        const started = !['PLANNED', 'READY'].includes(rec.status);
        R.drift.plan.changed.push({ id: t.id, status: rec.status, fields, breaking: started });
      }
    }
    for (const id of Object.keys(state.tasks)) if (!planIds.has(id)) R.drift.plan.removed.push({ id, status: state.tasks[id].status });
    R.drift.breaking = Boolean(R.drift.plan.changed.some((c) => c.breaking) || R.drift.plan.removed.some((r) => r.status !== 'INTEGRATED') || R.drift.spec);
  } else R.drift.plan.error = 'plan could not be loaded';

  // ---- git facts
  const repoOk = safe(() => G.isRepo(root), false);
  const wtEntries = repoOk ? safe(() => G.worktreeList(root), []) : [];
  const wtByPath = new Map(wtEntries.map((w) => [path.resolve(w.worktree), w]));
  const inconsistent = [];
  for (const [id, t] of Object.entries(state.tasks)) {
    const f = { id, status: t.status, attempt: t.attempt, rework_rounds: t.rework_rounds, branch: t.branch, worktree: t.worktree, issues: [], recommended: 'resume', reason: '' };
    const wtExists = Boolean(t.worktree && exists(t.worktree));
    f.worktree_exists = wtExists;
    f.branch_exists = t.branch && repoOk ? G.branchExists(root, t.branch) : false;
    f.dirty = wtExists ? safe(() => !G.isClean(t.worktree), null) : null;
    f.ahead = wtExists && t.base_ref ? safe(() => G.commitsAhead(t.worktree, t.base_ref), null) : null;
    f.branch_head = f.branch_exists ? safe(() => G.refSha(root, `refs/heads/${t.branch}`)) : null;
    f.merged_into_milestone = f.branch_exists && t.base_ref && G.branchExists(root, t.base_ref) ? safe(() => G.isAncestor(root, t.branch, t.base_ref), null) : null;
    if (t.activity?.pid) {
      const alive2 = isPidAlive(t.activity.pid);
      const same = alive2 && t.activity.fp ? sameProcess(t.activity.pid, t.activity.fp) : false;
      f.orphan = { pid: t.activity.pid, kind: t.activity.kind, agent: t.activity.agent, alive: alive2, identity_verified: same };
      if (alive2) R.orphans.push({ task: id, ...f.orphan });
    }
    switch (t.status) {
      case 'RUNNING':
        f.reason = wtExists ? `implementer interrupted${f.dirty ? '; worktree has uncommitted partial work' : ''}${f.ahead ? `; ${f.ahead} commit(s) ahead` : ''} — will re-dispatch in the same worktree` : 'implementer interrupted and the worktree is gone — task will restart from the milestone branch';
        break;
      case 'REVIEW': {
        const pr = t.pending_review;
        if (pr && exists(pr.result_file) && wtExists && safe(() => treeFingerprint(t.worktree)) === pr.tree_fp) f.reason = 'a review result from the interrupted run is on disk and the tree is unchanged — it will be adopted';
        else f.reason = 'review will be (re)run';
        if (!wtExists) { f.issues.push('worktree missing for a task awaiting review'); f.recommended = 'reset-task'; }
        break;
      }
      case 'REWORK': case 'READY': case 'PLANNED':
        f.reason = 'ready to continue';
        break;
      case 'PASS':
        f.reason = f.merged_into_milestone ? 'already merged into the milestone branch; will re-verify and mark INTEGRATED' : 'awaiting integration';
        if (!f.branch_exists) { f.issues.push('task branch missing for a PASS task'); f.recommended = 'reset-task'; }
        break;
      case 'INTEGRATED':
        f.reason = 'done';
        if (f.branch_exists && f.merged_into_milestone === false) { f.issues.push('state says INTEGRATED but the task branch is not merged into the milestone branch'); inconsistent.push(id); }
        break;
      case 'BLOCKED':
        f.recommended = 'needs-human';
        f.reason = `blocked: ${t.blocked_reason}`;
        break;
      default:
    }
    if (['REVIEW', 'PASS'].includes(t.status) && !f.branch_exists) inconsistent.push(id);
    R.tasks.push(f);
  }
  for (const [id, m] of Object.entries(state.milestones)) {
    const mf = { id, status: m.status, branch: m.branch, branch_exists: m.branch && repoOk ? G.branchExists(root, m.branch) : null, integration_worktree_exists: Boolean(m.integration_worktree && exists(m.integration_worktree)), issues: [] };
    if (['ACTIVE', 'GATE', 'AWAITING_APPROVAL', 'DONE'].includes(m.status) && m.branch && mf.branch_exists === false) { mf.issues.push('milestone branch missing'); inconsistent.push(`milestone ${id}`); }
    R.milestones.push(mf);
  }
  if (repoOk && factory) {
    const wtRoot = path.resolve(root, factory.git.worktree_root);
    const known = new Set([...Object.values(state.tasks).map((t) => t.worktree), ...Object.values(state.milestones).map((m) => m.integration_worktree)].filter(Boolean).map((p) => path.resolve(p)));
    for (const [p] of wtByPath) if (p.startsWith(wtRoot + path.sep) && !known.has(p)) R.unknown_git.worktrees.push(p);
    const knownBranches = new Set([...Object.values(state.tasks).map((t) => t.branch), ...Object.values(state.milestones).map((m) => m.branch)].filter(Boolean));
    for (const pre of [factory.git.task_branch_prefix, factory.git.milestone_branch_prefix]) {
      for (const b of safe(() => G.listBranches(root, pre), [])) if (!knownBranches.has(b)) R.unknown_git.branches.push(b);
    }
  }
  R.pending_ops = pendingOps(events);
  R.inbox = listInbox(paths).map((c) => ({ file: c.file, kind: c.kind, id: c.id ?? null }));

  // ---- classification
  const allDone = Object.values(state.milestones).every((m) => m.status === 'DONE');
  const torn = !chain.ok && /torn final line/.test(chain.reason ?? '');
  if (alive) R.class = 'running';
  else if (!chain.ok && !torn) { R.class = 'inconsistent'; R.reasons.push(`event log: ${R.integrity.event_chain}`); }
  else if (inconsistent.length) { R.class = 'inconsistent'; R.reasons.push(`git does not match state for: ${inconsistent.join(', ')}`); }
  else if (R.drift.plan.removed.some((r) => r.status !== 'INTEGRATED')) { R.class = 'inconsistent'; R.reasons.push('tasks missing from the plan that are not integrated'); }
  else if (allDone) R.class = 'completed';
  else if (state.run.supervisor_pid && !state.run.stop_reason) { R.class = 'crashed'; R.reasons.push(`supervisor pid ${state.run.supervisor_pid} is gone and no clean stop was recorded`); }
  else { R.class = 'clean_stop'; R.reasons.push(`supervisor stopped: ${state.run.stop_reason ?? 'unknown'}`); }
  if (R.integrity.state_vs_log === 'differs') R.reasons.push('state.json differs from the event log (will be rebuilt from the log on resume)');
  if (R.orphans.length) R.reasons.push(`${R.orphans.length} agent process(es) from the previous supervisor may still be running`);
  if (R.drift.breaking) R.reasons.push('spec or already-started tasks changed since the run began');

  // ---- recommendation
  const resets = R.tasks.filter((t) => t.recommended === 'reset-task').map((t) => t.id);
  const blocked = R.tasks.filter((t) => t.recommended === 'needs-human').map((t) => t.id);
  let action;
  let safeAuto = false;
  if (R.class === 'running') action = 'attach';
  else if (R.class === 'completed') action = 'none';
  else if (R.class === 'inconsistent') action = 'needs-human';
  else {
    action = 'resume';
    safeAuto = R.class === 'clean_stop' && !R.drift.breaking && R.orphans.length === 0 && R.integrity.state_vs_log === 'match' && resets.length === 0 && R.pending_ops.length === 0;
  }
  R.recommendation = { action, safe_auto: safeAuto, tasks_to_reset: resets, blocked_tasks: blocked, reasons: R.reasons };
  R.options = [
    { decision: 'resume', applicable: ['crashed', 'clean_stop'].includes(R.class), effect: 'continue the same run: kill verified orphans, re-dispatch interrupted work in existing worktrees, adopt valid review results, rebuild state from the log if needed' },
    { decision: 'reset-task', applicable: ['crashed', 'clean_stop', 'inconsistent'].includes(R.class), effect: 'archive the task worktree+branch and restart that task from PLANNED (not for INTEGRATED tasks)' },
    { decision: 'reset-run', applicable: R.class !== 'running' && R.class !== 'fresh', effect: 'archive the whole run (state, logs, worktrees, branches) under .sf/archive/<run-id> and start fresh; nothing is deleted' },
  ];
  R.assessment_id = sha256(JSON.stringify({
    c: R.class, run: R.run.id, t: R.tasks.map((t) => [t.id, t.status, t.branch_head, t.dirty, t.worktree_exists]),
    m: R.milestones.map((m) => [m.id, m.status]), d: [R.drift.spec, R.drift.plan], p: R.pending_ops.map((o) => o.op_id),
    o: R.orphans.map((o) => o.pid), i: R.integrity.state_vs_log,
  })).slice(0, 16);
  return R;
}

/** Does `run` need an explicit, confirmed decision before continuing? Returns a reason or null. */
export function decisionRequired(report) {
  if (['fresh', 'completed', 'running'].includes(report.class)) return null;
  if (report.class === 'clean_stop' && report.recommendation.safe_auto) return null;
  if (report.class === 'clean_stop' && !report.drift.breaking && report.orphans.length === 0 && report.recommendation.tasks_to_reset.length === 0) return null;
  return `previous run ${report.run.id} is "${report.class}": ${report.reasons.join('; ') || 'needs review'}`;
}

export function renderAssessment(R) {
  const L = [];
  L.push(`Assessment ${R.assessment_id} — run ${R.run?.id ?? '(none)'}: ${R.class.toUpperCase()}`);
  for (const r of R.reasons) L.push(`  • ${r}`);
  if (R.run) {
    L.push(`Supervisor: ${R.supervisor.alive ? `ALIVE pid ${R.supervisor.pid} (heartbeat ${R.supervisor.heartbeat_age_s}s ago${R.supervisor.stale_heartbeat ? ', STALE' : ''})` : 'not running'}; event log: ${R.integrity.event_chain}; state vs log: ${R.integrity.state_vs_log}`);
    const counts = {};
    for (const t of R.tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
    L.push(`Tasks: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}   Milestones: ${R.milestones.map((m) => `${m.id}=${m.status}`).join(' ')}`);
    for (const t of R.tasks.filter((x) => ['RUNNING', 'REVIEW', 'REWORK', 'PASS', 'BLOCKED'].includes(x.status) || x.issues.length)) {
      L.push(`  - ${t.id} ${t.status}: ${t.reason}${t.issues.length ? ` [ISSUES: ${t.issues.join('; ')}]` : ''}  → ${t.recommended}`);
    }
    if (R.drift.spec) L.push('Drift: the spec changed since the run started.');
    for (const c of R.drift.plan.changed) L.push(`Drift: task ${c.id} (${c.status}) changed fields: ${c.fields.join(', ')}${c.breaking ? '  [BREAKING: work already started]' : ''}`);
    if (R.drift.plan.added.length) L.push(`Drift: new tasks in plan: ${R.drift.plan.added.join(', ')} (additive)`);
    for (const r of R.drift.plan.removed) L.push(`Drift: task ${r.id} (${r.status}) removed from plan`);
    for (const o of R.orphans) L.push(`Orphan: ${o.kind} process pid ${o.pid} for ${o.task} alive; identity ${o.identity_verified ? 'verified (will be killed on resume)' : 'NOT verified (will not be killed)'}`);
    if (R.pending_ops.length) L.push(`Interrupted operations: ${R.pending_ops.map((o) => `${o.op}${o.id ? `(${o.id})` : ''}`).join(', ')}`);
    if (R.unknown_git.worktrees.length || R.unknown_git.branches.length) L.push(`Untracked leftovers: worktrees ${R.unknown_git.worktrees.join(', ') || '-'}; branches ${R.unknown_git.branches.join(', ') || '-'}`);
    if (R.inbox.length) L.push(`Unprocessed inbox commands: ${R.inbox.map((c) => c.kind).join(', ')}`);
  }
  if (R.archived_runs.length) L.push(`Archived runs: ${R.archived_runs.join(', ')}`);
  L.push(`Recommendation: ${R.recommendation.action}${R.recommendation.safe_auto ? ' (safe to auto-resume)' : ''}`);
  for (const o of R.options.filter((x) => x.applicable)) L.push(`  option ${o.decision}: ${o.effect}`);
  return L.join('\n');
}

/** Kill agent processes left by a dead supervisor, only when their identity (pid + start time) is verified. */
export function killVerifiedOrphans(state) {
  const out = [];
  for (const [id, t] of Object.entries(state.tasks)) {
    const a = t.activity;
    if (!a?.pid || !isPidAlive(a.pid)) continue;
    if (a.fp && sameProcess(a.pid, a.fp)) {
      try { process.kill(process.platform === 'win32' ? a.pid : -a.pid, 'SIGKILL'); out.push({ task: id, pid: a.pid, killed: true }); } catch { out.push({ task: id, pid: a.pid, killed: false }); }
    } else out.push({ task: id, pid: a.pid, killed: false, reason: 'identity not verified' });
  }
  return out;
}

export const _slug = slug;
