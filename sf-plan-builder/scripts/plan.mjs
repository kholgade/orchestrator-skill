#!/usr/bin/env node
// sf-plan-builder: derive, lint, visualise and approve the execution plan (milestones + task DAG).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliMain, parseArgs, findRoot, sfPaths, printJson, SfError, exists, atomicWrite, readText, nowIso } from './lib/util.mjs';
import { stringify } from './lib/yaml.mjs';
import { loadFactory, softFactory } from './lib/factory.mjs';
import { parseSpec, lintSpec, buildIndex } from './lib/spec.mjs';
import { loadPlanRaw, lintPlan, topoSort } from './lib/plan.mjs';
import { render } from './lib/template.mjs';
import { delegateAuthoring } from './lib/delegate.mjs';
import { CONFIRM_OPTIONS, confirmAction } from './lib/confirm.mjs';
import { ledgerAppend } from './lib/journal.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillFile = (...p) => path.join(here, '..', ...p);
const OPTS = {
  root: { type: 'string' }, json: { type: 'boolean' }, force: { type: 'boolean' }, out: { type: 'string' },
  preferences: { type: 'string' }, rounds: { type: 'string' }, 'require-approved': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  ...CONFIRM_OPTIONS,
};
const USAGE = `sf-plan-builder — turn an approved spec into a traceable, dependency-aware plan

Usage: node plan.mjs <command> [options]
  scaffold [--force]     draft .sf/plan.yaml from the spec: one task per requirement, criteria copied verbatim
  lint [--json]          schema + DAG + requirement coverage + write scopes + agent assignment + spec drift
  order                  print execution layers (tasks in a layer can run in parallel)
  graph                  print a Mermaid diagram of milestones and tasks
  coverage               requirement → task matrix, uncovered requirements
  approve                lint, user confirmation, then record spec hash + status: approved (the human gate)
  rehash                 after reviewing a spec change: update spec.hash and reset status to draft
  status [--json]
  brief --out <file> [--preferences f]    render the planning brief for an external agent
  delegate [--preferences f] [--rounds n] run roles.planner agent, lint, retry on findings
Options: --root <dir>
Confirmation (approve): interactive terminal prompt, or --confirmed-by user|external:<id> [--via name] [--quote "user's words"] after asking the user.`;

function context(root, { needFactory = false } = {}) {
  const loaded = needFactory ? loadFactory(root) : softFactory(root);
  const p = loaded.paths;
  if (!exists(p.spec)) throw new SfError(`No spec at ${p.spec}. Run the sf-spec-builder skill first.`, { code: 'NO_SPEC' });
  const rel = path.relative(root, p.spec).split(path.sep).join('/');
  const parsed = parseSpec(readText(p.spec), { filename: rel });
  const sl = lintSpec(parsed, { filename: rel });
  if (sl.errors.length) throw new SfError('Spec has lint errors; fix them with sf-spec-builder first', { details: sl.errors });
  return { p, factory: loaded.factory ?? null, specIndex: buildIndex(parsed, { specPath: rel }), specStatus: parsed.meta.status, specRel: rel };
}

function scaffold(ctx, projectId) {
  const idx = ctx.specIndex;
  const taskId = new Map(idx.requirements.map((r, i) => [r.id, `T-${String(i + 1).padStart(3, '0')}`]));
  return {
    sf: 'plan/1',
    project: { id: projectId, name: idx.title },
    spec: { path: ctx.specRel, hash: idx.spec_hash },
    status: 'draft',
    notes: 'Scaffolded: one task per requirement. Refine milestones, split/merge tasks, set REAL write_scopes and verify commands, then lint and approve.',
    milestones: [{ id: 'M1', title: 'Initial delivery', goal: `Deliver the requirements of ${idx.title}`, depends_on: [], exit_criteria: ['All milestone tasks integrated and verified'], verify: [] }],
    tasks: idx.requirements.map((r) => ({
      id: taskId.get(r.id), milestone: 'M1', title: r.title, goal: r.statement.split('\n')[0].slice(0, 300),
      requirements: [r.id], depends_on: r.depends.map((d) => taskId.get(d)).filter(Boolean),
      write_scopes: ['REPLACE_WITH_REAL_PATH'], acceptance_criteria: r.criteria.map((c) => c.text), verify: [],
    })),
  };
}

function setTopLevel(text, key, value, afterKey) {
  const re = new RegExp(`^${key}:.*$`, 'm');
  const line = `${key}: ${value}`;
  if (re.test(text)) return text.replace(re, line);
  if (afterKey) {
    const ra = new RegExp(`^${afterKey}:.*$`, 'm');
    if (ra.test(text)) return text.replace(ra, (m) => `${m}\n${line}`);
  }
  return text.replace(/^(sf:.*)$/m, `$1\n${line}`);
}

function setSpecHash(text, hash) {
  const flow = /^spec:\s*\{(.*)\}\s*(#.*)?$/m.exec(text);
  if (flow) {
    const pm = /path:\s*([^,}]+)/.exec(flow[1]);
    if (!pm) throw new SfError('plan.yaml: spec flow mapping has no path');
    return text.replace(flow[0], `spec:\n  path: ${pm[1].trim()}\n  hash: ${hash}`);
  }
  const m = /^spec:\s*\n((?:[ ]+.*\n?)*)/m.exec(text);
  if (!m) throw new SfError('plan.yaml: could not locate the "spec:" block to update spec.hash');
  let block = m[1];
  if (/^[ ]+hash:/m.test(block)) block = block.replace(/^([ ]+)hash:.*$/m, `$1hash: ${hash}`);
  else block = block.replace(/\n?$/, '\n') + `  hash: ${hash}\n`;
  return text.replace(m[1], block);
}

function lintAll(root, ctx, { requireApproved = false } = {}) {
  const plan = loadPlanRaw(ctx.p.plan);
  const res = lintPlan(plan, { specIndex: ctx.specIndex, factory: ctx.factory ?? undefined, requireApproved });
  for (const t of plan.tasks) for (const s of t.write_scopes) if (/REPLACE|TODO|TBD/i.test(s)) res.errors.push(`task ${t.id}: write scope "${s}" is still a placeholder`);
  if (!ctx.factory) res.warnings.push('no factory.yaml: agent assignment was not checked');
  return { plan, ...res };
}

function renderBrief(root, ctx, values) {
  const idx = ctx.specIndex;
  const reqs = idx.requirements.map((r) => `- ${r.id} [${r.priority}/${r.type}] ${r.title}\n${r.criteria.map((c) => `    - ${c.id}: ${c.text}`).join('\n')}`).join('\n');
  const agents = ctx.factory
    ? ctx.factory.agents.filter((a) => a.enabled !== false).map((a) => `- ${a.id}: capabilities [${a.capabilities.join(', ')}]${ctx.factory.roles.implementers.includes(a.id) ? ' (implementer)' : ''}${ctx.factory.roles.reviewers.includes(a.id) ? ' (reviewer)' : ''}`).join('\n')
    : '(no factory.yaml)';
  return render(readText(skillFile('templates', 'plan-brief.md')), {
    plan_path: ctx.p.plan, spec_path: ctx.p.spec, root, requirements: reqs, agents,
    preferences: values.preferences ? readText(path.resolve(values.preferences)) : '(none; use sensible defaults)',
    format_reference: readText(skillFile('references', 'plan-format.md')),
    max_parallel: ctx.factory?.execution.max_parallel_tasks ?? 2,
  }, { what: 'plan-brief template' });
}

cliMain(async () => {
  const { values, positionals } = parseArgs(process.argv.slice(2), OPTS);
  const cmd = positionals[0];
  if (!cmd || values.help) { console.log(USAGE); return cmd || values.help ? 0 : 2; }
  const root = findRoot(values.root);

  switch (cmd) {
    case 'scaffold': {
      const ctx = context(root);
      if (exists(ctx.p.plan) && !values.force) throw new SfError(`${ctx.p.plan} already exists (use --force to overwrite)`);
      const projectId = ctx.factory?.project.id ?? path.basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, '-') ?? 'project';
      atomicWrite(ctx.p.plan, stringify(scaffold(ctx, projectId)));
      console.log(`Scaffolded ${ctx.p.plan}. Replace placeholder write_scopes, add verify commands, split into milestones, then: lint`);
      return 0;
    }
    case 'lint': {
      const ctx = context(root);
      const r = lintAll(root, ctx, { requireApproved: values['require-approved'] });
      if (values.json) printJson({ ok: r.errors.length === 0, errors: r.errors, warnings: r.warnings, tasks: r.plan.tasks.length, milestones: r.plan.milestones.length });
      else {
        for (const w of r.warnings) console.log(`WARN: ${w}`);
        for (const e of r.errors) console.log(`ERROR: ${e}`);
        if (!r.errors.length) console.log(`Plan OK: ${r.plan.milestones.length} milestone(s), ${r.plan.tasks.length} task(s).`);
      }
      return r.errors.length ? 1 : 0;
    }
    case 'order': {
      const plan = loadPlanRaw(context(root).p.plan);
      const { layers, cycle } = topoSort(plan.tasks, (t) => t.depends_on);
      if (cycle) throw new SfError(`dependency cycle: ${cycle.join(', ')}`);
      layers.forEach((l, i) => console.log(`layer ${i + 1}: ${l.join(', ')}`));
      return 0;
    }
    case 'graph': {
      const plan = loadPlanRaw(context(root).p.plan);
      const L = ['graph TD'];
      for (const m of plan.milestones) {
        L.push(`  subgraph ${m.id.replace(/\W/g, '_')}["${m.id}: ${m.title.replace(/"/g, "'")}"]`);
        for (const t of plan.tasks.filter((x) => x.milestone === m.id)) L.push(`    ${t.id.replace(/\W/g, '_')}["${t.id}: ${t.title.replace(/"/g, "'")}"]`);
        L.push('  end');
      }
      for (const t of plan.tasks) for (const d of t.depends_on) L.push(`  ${d.replace(/\W/g, '_')} --> ${t.id.replace(/\W/g, '_')}`);
      for (const m of plan.milestones) for (const d of m.depends_on) L.push(`  ${d.replace(/\W/g, '_')} -.-> ${m.id.replace(/\W/g, '_')}`);
      console.log(L.join('\n'));
      return 0;
    }
    case 'coverage': {
      const ctx = context(root);
      const plan = loadPlanRaw(ctx.p.plan);
      const rows = ctx.specIndex.requirements.map((r) => ({ requirement: r.id, priority: r.priority, tasks: plan.tasks.filter((t) => t.requirements.includes(r.id)).map((t) => t.id) }));
      if (values.json) printJson(rows);
      else for (const r of rows) console.log(`${r.requirement.padEnd(14)} ${r.priority.padEnd(7)} ${r.tasks.length ? r.tasks.join(', ') : 'UNCOVERED'}`);
      return rows.some((r) => !r.tasks.length && r.priority !== 'could') ? 1 : 0;
    }
    case 'approve': {
      const ctx = context(root);
      if (ctx.specStatus !== 'approved') throw new SfError(`Spec is "${ctx.specStatus}"; approve the spec first (sf-spec-builder: approve)`);
      const before = readText(ctx.p.plan);
      let text = setSpecHash(before, ctx.specIndex.spec_hash);
      atomicWrite(ctx.p.plan, text);
      const r = lintAll(root, ctx);
      if (r.errors.length) { atomicWrite(ctx.p.plan, before); throw new SfError('Cannot approve plan', { details: r.errors }); }
      let who;
      try {
        who = await confirmAction({ values, word: 'approve plan', summary: `Approve plan: ${r.plan.milestones.length} milestone(s), ${r.plan.tasks.length} task(s), spec hash ${ctx.specIndex.spec_hash.slice(0, 12)}…` });
      } catch (e) { atomicWrite(ctx.p.plan, before); throw e; }
      text = setTopLevel(setTopLevel(readText(ctx.p.plan), 'status', 'approved'), 'approved_at', `"${nowIso()}"`, 'status');
      atomicWrite(ctx.p.plan, text);
      ledgerAppend(ctx.p, 'plan_approved', { actor: who.confirmed_by, msg: `plan approved (${r.plan.tasks.length} tasks)`, data: { spec_hash: ctx.specIndex.spec_hash, milestones: r.plan.milestones.length, tasks: r.plan.tasks.length, who } });
      for (const w of r.warnings) console.log(`WARN: ${w}`);
      console.log(`Plan approved (${r.plan.tasks.length} tasks, spec hash ${ctx.specIndex.spec_hash.slice(0, 12)}…). The orchestrator may now run.`);
      return 0;
    }
    case 'rehash': {
      const ctx = context(root);
      let text = setSpecHash(readText(ctx.p.plan), ctx.specIndex.spec_hash);
      text = setTopLevel(text, 'status', 'draft');
      atomicWrite(ctx.p.plan, text);
      console.log('spec.hash updated and plan reset to draft; re-run lint and approve after review.');
      return 0;
    }
    case 'status': {
      const ctx = context(root);
      const plan = loadPlanRaw(ctx.p.plan);
      const r = lintAll(root, ctx);
      const st = { status: plan.status, milestones: plan.milestones.length, tasks: plan.tasks.length, lint_errors: r.errors.length, lint_warnings: r.warnings.length, spec_status: ctx.specStatus, spec_drift: Boolean(plan.spec.hash && plan.spec.hash !== ctx.specIndex.spec_hash) };
      if (values.json) printJson(st); else console.log(Object.entries(st).map(([k, v]) => `${k}: ${v}`).join('\n'));
      return 0;
    }
    case 'brief': {
      if (!values.out) throw new SfError('brief needs --out <file>', { exitCode: 2 });
      atomicWrite(path.resolve(values.out), renderBrief(root, context(root, { needFactory: true }), values));
      console.log(`Wrote brief to ${values.out}`);
      return 0;
    }
    case 'delegate': {
      const ctx = context(root, { needFactory: true });
      const { factory, paths } = loadFactory(root);
      const brief = renderBrief(root, ctx, values);
      const check = () => { const r = lintAll(root, context(root, { needFactory: true })); return { errors: r.errors, warnings: r.warnings }; };
      const res = await delegateAuthoring({ root, factory, paths, agentId: factory.roles.planner, label: 'plan', brief, check, maxRounds: values.rounds ? Number(values.rounds) : 3 });
      ledgerAppend(paths, 'delegate_completed', { actor: `agent:${factory.roles.planner}`, msg: `plan delegate ${res.ok ? 'converged' : 'failed'}`, data: { ok: res.ok, rounds: res.rounds, errors: res.errors } });
      if (res.ok) { console.log(`Plan authored by ${factory.roles.planner} in ${res.rounds.length} round(s). Review it, then run: approve`); return 0; }
      console.log(`Delegated planning did not converge after ${res.rounds.length} round(s):`);
      for (const e of res.errors) console.log(`  - ${e}`);
      return 1;
    }
    default:
      throw new SfError(`Unknown command "${cmd}"\n${USAGE}`, { exitCode: 2 });
  }
});
