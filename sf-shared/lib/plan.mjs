// @ts-check
// Plan loading, linting, DAG utilities and agent assignment.
import { validate, applyDefaults } from './validate.mjs';
import { planSchema } from './schemas.mjs';
import { SfError, exists } from './util.mjs';
import { loadYamlFile, independent } from './factory.mjs';
import { scopesOverlap } from './git.mjs';

export function loadPlanRaw(file) {
  if (!exists(file)) throw new SfError(`Plan not found: ${file}`, { code: 'NO_PLAN' });
  const raw = loadYamlFile(file);
  const errs = validate(raw, planSchema);
  if (errs.length) throw new SfError(`Invalid plan ${file}`, { code: 'BAD_PLAN', details: errs });
  return applyDefaults(raw, planSchema);
}

/** Transitive closure of depends_on for each task id → Set of ancestor ids. */
export function ancestors(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map();
  const visiting = new Set();
  const visit = (id) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return new Set();
    visiting.add(id);
    const set = new Set();
    for (const d of byId.get(id)?.depends_on ?? []) {
      if (!byId.has(d)) continue;
      set.add(d);
      for (const a of visit(d)) set.add(a);
    }
    visiting.delete(id);
    memo.set(id, set);
    return set;
  };
  for (const t of tasks) visit(t.id);
  return memo;
}

/** Kahn topological sort. Returns {order, layers, cycle:null|string[]}. */
export function topoSort(items, depsOf) {
  const ids = items.map((i) => i.id);
  const known = new Set(ids);
  const indeg = new Map(ids.map((id) => [id, 0]));
  const children = new Map(ids.map((id) => [id, []]));
  for (const it of items) {
    for (const d of depsOf(it)) {
      if (!known.has(d)) continue;
      indeg.set(it.id, indeg.get(it.id) + 1);
      children.get(d).push(it.id);
    }
  }
  const layers = [];
  let frontier = ids.filter((id) => indeg.get(id) === 0).sort();
  const order = [];
  while (frontier.length) {
    layers.push(frontier);
    const next = [];
    for (const id of frontier) {
      order.push(id);
      for (const c of children.get(id)) {
        indeg.set(c, indeg.get(c) - 1);
        if (indeg.get(c) === 0) next.push(c);
      }
    }
    frontier = next.sort();
  }
  const cycle = order.length === ids.length ? null : ids.filter((id) => !order.includes(id));
  return { order, layers, cycle };
}

/**
 * Full plan lint. Context is optional: specIndex enables requirement coverage + drift checks,
 * factory enables agent assignment checks.
 * @returns {{errors:string[], warnings:string[]}}
 */
export function lintPlan(plan, { specIndex, factory, requireApproved = false } = {}) {
  const errors = [];
  const warnings = [];
  const tasks = plan.tasks;
  const milestones = plan.milestones;

  const mIds = new Set();
  for (const m of milestones) {
    if (mIds.has(m.id)) errors.push(`milestone ${m.id}: duplicate id`);
    mIds.add(m.id);
  }
  const tIds = new Set();
  for (const t of tasks) {
    if (tIds.has(t.id)) errors.push(`task ${t.id}: duplicate id`);
    tIds.add(t.id);
  }
  for (const m of milestones) {
    for (const d of m.depends_on) if (!mIds.has(d)) errors.push(`milestone ${m.id}: depends on unknown milestone "${d}"`);
    if (m.depends_on.includes(m.id)) errors.push(`milestone ${m.id}: depends on itself`);
  }
  const mt = topoSort(milestones, (m) => m.depends_on);
  if (mt.cycle) errors.push(`milestone dependency cycle involving: ${mt.cycle.join(', ')}`);
  const tt = topoSort(tasks, (t) => t.depends_on);
  if (tt.cycle) errors.push(`task dependency cycle involving: ${tt.cycle.join(', ')}`);

  const mById = new Map(milestones.map((m) => [m.id, m]));
  const tById = new Map(tasks.map((t) => [t.id, t]));
  const mAnc = new Map();
  const mAncOf = (id, seen = new Set()) => {
    if (mAnc.has(id)) return mAnc.get(id);
    const s = new Set();
    for (const d of mById.get(id)?.depends_on ?? []) {
      if (seen.has(d)) continue;
      s.add(d);
      for (const a of mAncOf(d, new Set([...seen, id]))) s.add(a);
    }
    mAnc.set(id, s);
    return s;
  };

  const covered = new Set();
  for (const t of tasks) {
    const at = `task ${t.id}`;
    if (!mIds.has(t.milestone)) errors.push(`${at}: unknown milestone "${t.milestone}"`);
    for (const d of t.depends_on) {
      if (!tIds.has(d)) {
        errors.push(`${at}: depends on unknown task "${d}"`);
        continue;
      }
      if (d === t.id) errors.push(`${at}: depends on itself`);
      const dm = tById.get(d).milestone;
      if (dm !== t.milestone && mIds.has(dm) && mIds.has(t.milestone) && !mAncOf(t.milestone).has(dm)) {
        errors.push(`${at}: depends on ${d} from milestone ${dm}, but milestone ${t.milestone} does not depend on ${dm}`);
      }
    }
    for (const r of t.requirements) {
      covered.add(r);
      if (specIndex && !specIndex.requirements.some((x) => x.id === r)) errors.push(`${at}: references unknown requirement "${r}"`);
    }
    if (!t.requirements.length) warnings.push(`${at}: traces to no requirement (only valid for explicitly approved engineering work; note it in "notes")`);
    if (!t.verify.length) warnings.push(`${at}: no verify commands; evidence will rely on the reviewer alone`);
    for (const s of t.write_scopes) {
      if (/^\//.test(s) || /^[A-Za-z]:[\\/]/.test(s) || s.split(/[\\/]/).includes('..')) errors.push(`${at}: write scope "${s}" must be relative and inside the repository`);
      if (/^\.sf(\/|$)/.test(s.replace(/\\/g, '/'))) errors.push(`${at}: write scope "${s}" must not include .sf/ (orchestrator state)`);
    }
    for (const c of t.acceptance_criteria) if (/\b(TBD|TODO)\b/.test(c)) errors.push(`${at}: placeholder in acceptance criterion "${c}"`);
  }

  if (specIndex) {
    for (const r of specIndex.requirements) {
      if (!covered.has(r.id)) (r.priority === 'could' ? warnings : errors).push(`requirement ${r.id} (${r.priority}) is not covered by any task`);
    }
    if (plan.spec.hash && plan.spec.hash !== specIndex.spec_hash) errors.push(`spec drift: plan.spec.hash does not match the current spec (re-review the plan, then run "plan.mjs approve" or "plan.mjs rehash")`);
    if (plan.status === 'approved' && !plan.spec.hash) errors.push('approved plan must record spec.hash');
  }

  const anc = ancestors(tasks);
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i];
      const b = tasks[j];
      if (anc.get(a.id)?.has(b.id) || anc.get(b.id)?.has(a.id)) continue;
      const hit = a.write_scopes.flatMap((sa) => b.write_scopes.filter((sb) => scopesOverlap(sa, sb)).map((sb) => `${sa} ~ ${sb}`));
      if (hit.length) warnings.push(`tasks ${a.id} and ${b.id} have overlapping write scopes (${hit[0]}) and no dependency; the orchestrator will serialize them`);
    }
  }

  if (factory) {
    const agents = new Map(factory.agents.map((a) => [a.id, a]));
    const impls = factory.roles.implementers.map((id) => agents.get(id)).filter(Boolean);
    const revs = factory.roles.reviewers.map((id) => agents.get(id)).filter(Boolean);
    const mode = factory.execution.review_independence;
    for (const t of tasks) {
      const at = `task ${t.id}`;
      let cands = impls;
      if (t.implementer) {
        const a = agents.get(t.implementer);
        if (!a) errors.push(`${at}: implementer "${t.implementer}" is not a configured agent`);
        else if (!factory.roles.implementers.includes(a.id)) errors.push(`${at}: implementer "${a.id}" is not listed in roles.implementers`);
        cands = a ? [a] : [];
      }
      const capable = cands.filter((a) => t.requires.every((c) => a.capabilities.includes(c)));
      if (t.requires.length && !capable.length) errors.push(`${at}: no implementer has all required capabilities (${t.requires.join(', ')})`);
      let rcands = revs;
      if (t.reviewer) {
        const r = agents.get(t.reviewer);
        if (!r) errors.push(`${at}: reviewer "${t.reviewer}" is not a configured agent`);
        else if (!factory.roles.reviewers.includes(r.id)) errors.push(`${at}: reviewer "${r.id}" is not listed in roles.reviewers`);
        rcands = r ? [r] : [];
      }
      if (factory.verification.require_independent_review && capable.length && rcands.length && !capable.some((i) => rcands.some((r) => independent(i, r, mode)))) {
        errors.push(`${at}: no independent implementer/reviewer pair available (review_independence="${mode}")`);
      }
    }
  }
  if (requireApproved && plan.status !== 'approved') errors.push(`plan status is "${plan.status}", must be "approved" before execution`);
  return { errors, warnings };
}

/** Choose an implementer for a task given current per-agent load. Deterministic. */
export function pickImplementer(factory, task, load) {
  const agents = new Map(factory.agents.map((a) => [a.id, a]));
  const pool = (task.implementer ? [task.implementer] : factory.roles.implementers)
    .map((id) => agents.get(id))
    .filter((a) => a && a.enabled !== false && task.requires.every((c) => a.capabilities.includes(c)));
  return pool.filter((a) => (load[a.id] ?? 0) < a.max_concurrency).sort((x, y) => (load[x.id] ?? 0) - (load[y.id] ?? 0))[0] ?? null;
}

/** Choose a reviewer independent of the implementer. */
export function pickReviewer(factory, task, implementer, load) {
  const agents = new Map(factory.agents.map((a) => [a.id, a]));
  const mode = factory.execution.review_independence;
  const require = factory.verification.require_independent_review;
  const pool = (task.reviewer ? [task.reviewer] : factory.roles.reviewers)
    .map((id) => agents.get(id))
    .filter((a) => a && a.enabled !== false && (!require || independent(implementer, a, mode)));
  return pool.filter((a) => (load[a.id] ?? 0) < a.max_concurrency).sort((x, y) => (load[x.id] ?? 0) - (load[y.id] ?? 0))[0] ?? null;
}
