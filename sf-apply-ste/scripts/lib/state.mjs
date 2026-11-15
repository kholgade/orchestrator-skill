// GENERATED COPY of sf-shared/lib — edit sf-shared/lib and run `npm run sync`.
// @ts-check
// Persistent run state. The hash-chained event log is the write-ahead source of truth; state.json is a
// derived snapshot that can always be rebuilt (foldEvents). Also: supervisor lock, state mutation lock, command inbox.
import fs from 'node:fs';
import path from 'node:path';
import { SfError, nowIso, atomicWrite, readJson, exists, mkdirp, isPidAlive, processFingerprint, sameProcess, sleepSync, sha256 } from './util.mjs';
import { SF_VERSION } from './version.mjs';
import { EventLog, readEvents, diffState, foldEvents, ledgerAppend } from './journal.mjs';

export const TASK_TRANSITIONS = {
  PLANNED: ['READY', 'BLOCKED'],
  READY: ['RUNNING', 'BLOCKED'],
  RUNNING: ['REVIEW', 'REWORK', 'BLOCKED', 'READY'],
  REVIEW: ['PASS', 'REWORK', 'BLOCKED'],
  REWORK: ['RUNNING', 'BLOCKED'],
  PASS: ['INTEGRATED', 'BLOCKED'],
  INTEGRATED: [],
  BLOCKED: ['READY'],
};
export const MILESTONE_TRANSITIONS = {
  PLANNED: ['ACTIVE', 'BLOCKED'],
  ACTIVE: ['GATE', 'BLOCKED'],
  GATE: ['AWAITING_APPROVAL', 'DONE', 'BLOCKED', 'ACTIVE'],
  AWAITING_APPROVAL: ['DONE', 'BLOCKED'],
  DONE: [],
  BLOCKED: ['ACTIVE', 'GATE'],
};

export const TASK_STATES = Object.keys(TASK_TRANSITIONS);
export const ACTIVE_TASK_STATES = ['RUNNING', 'REVIEW', 'REWORK'];

/** The parts of a task definition that matter to execution (used for plan-drift detection). */
export function taskDef(t) {
  return {
    milestone: t.milestone, goal: t.goal, requirements: t.requirements, depends_on: t.depends_on, write_scopes: t.write_scopes,
    acceptance_criteria: t.acceptance_criteria, verify: t.verify, implementer: t.implementer ?? null, reviewer: t.reviewer ?? null, requires: t.requires ?? [],
  };
}
export const taskDefFingerprint = (t) => sha256(JSON.stringify(taskDef(t))).slice(0, 16);

export function newTaskRecord(t) {
  return {
    status: 'PLANNED', milestone: t.milestone, title: t.title, plan_fp: taskDefFingerprint(t), plan_def: taskDef(t),
    attempt: 0, rework_rounds: 0, extra_rounds: 0,
    implementer: null, reviewer: null, branch: null, worktree: null, base_ref: null, head_sha: null,
    evidence: null, review: null, findings: [], blocked_reason: null, activity: null,
    started_at: null, finished_at: null,
  };
}

export const newMilestoneRecord = () => ({ status: 'PLANNED', branch: null, integration_worktree: null, approval: 'NONE', gate: null, blocked_reason: null });

const clone = (v) => JSON.parse(JSON.stringify(v));

export class Store {
  /** @param {ReturnType<import('./util.mjs').sfPaths>} paths */
  constructor(paths, { actor = 'supervisor' } = {}) {
    this.paths = paths;
    this.actor = actor;
    /** @type {any} */
    this.state = null;
    this.shadow = null;
    /** @type {EventLog|null} */
    this.log = null;
    /** @type {((ev:any)=>void)|null} */
    this.onEvent = null;
  }

  static exists(paths) {
    return exists(paths.state);
  }

  get seq() {
    return this.log?.seq ?? 0;
  }

  init(plan, { specHash }) {
    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.state = {
      sf: 'state/1',
      sf_version: SF_VERSION,
      project_id: plan.project.id,
      run: { id: runId, started_at: nowIso(), supervisor_pid: null, spec_hash: specHash, plan_status: plan.status },
      tasks: Object.fromEntries(plan.tasks.map((t) => [t.id, newTaskRecord(t)])),
      milestones: Object.fromEntries(plan.milestones.map((m) => [m.id, newMilestoneRecord()])),
      updated_at: nowIso(),
    };
    this.log = new EventLog(this.paths.events, { runId, actor: this.actor }).load();
    this.emit('state_init', { msg: `Run ${runId} initialized`, data: { state: clone(this.state) } });
    atomicWrite(this.paths.state, JSON.stringify(this.state, null, 2) + '\n');
    this.shadow = clone(this.state);
    this.emit('run_initialized', { msg: `Run ${runId} initialized: ${plan.tasks.length} tasks in ${plan.milestones.length} milestone(s)` });
    return this.state;
  }

  load() {
    this.state = readJson(this.paths.state);
    this.log = new EventLog(this.paths.events, { runId: this.state.run.id, actor: this.actor }).load();
    this.shadow = clone(this.state);
    return this.state;
  }

  lastSeq() {
    return this.log ? this.log.seq : new EventLog(this.paths.events).load().seq;
  }

  /** Write-ahead: append the delta event first, then the snapshot. */
  save() {
    const delta = diffState(this.shadow, this.state);
    if (delta.set.length || delta.del.length) this.emit('state_delta', { msg: `${delta.set.length} set, ${delta.del.length} del`, data: delta });
    this.state.updated_at = nowIso();
    atomicWrite(this.paths.state, JSON.stringify(this.state, null, 2) + '\n');
    this.shadow = clone(this.state);
  }

  /** Append an event. severity: info|warn|error|approval|done */
  emit(type, { severity = 'info', entity = null, id = null, msg = '', data = undefined, actor, attempt, op_id } = {}) {
    const ev = this.log.append(type, { severity, entity, id, msg, data, actor, attempt, op_id });
    try { this.onEvent?.(ev); } catch { /* listeners must never break state handling */ }
    return ev;
  }

  /** Journal the start of a side effect. Pair with result(); an intent without result marks an interrupted operation. */
  intent(op, data = {}, { entity = null, id = null, attempt } = {}) {
    const ev = this.emit('intent', { entity, id, attempt, msg: `${op} started${id ? ` (${id})` : ''}`, data: { op, ...data } });
    return `op-${ev.seq}`;
  }

  result(opId, op, data = {}, { entity = null, id = null, attempt, severity = 'info', msg } = {}) {
    return this.emit('result', { severity, entity, id, attempt, op_id: opId, msg: msg ?? `${op} finished${id ? ` (${id})` : ''}`, data: { op, ...data } });
  }

  task(id) {
    const t = this.state.tasks[id];
    if (!t) throw new SfError(`Unknown task "${id}"`, { code: 'NO_TASK' });
    return t;
  }

  milestone(id) {
    const m = this.state.milestones[id];
    if (!m) throw new SfError(`Unknown milestone "${id}"`, { code: 'NO_MILESTONE' });
    return m;
  }

  /** Validated task transition; persists state and logs an event. */
  setTask(id, to, reason, patch = {}, severity = 'info', actor) {
    if (to === 'BLOCKED') severity = 'error';
    const t = this.task(id);
    const from = t.status;
    if (from !== to && !TASK_TRANSITIONS[from].includes(to)) {
      throw new SfError(`Illegal task transition ${id}: ${from} -> ${to}`, { code: 'ILLEGAL_TRANSITION' });
    }
    Object.assign(t, patch, { status: to });
    if (to === 'BLOCKED') t.blocked_reason = reason;
    else t.blocked_reason = patch.blocked_reason ?? null;
    this.save();
    this.emit('task_transition', { severity, entity: 'task', id, actor, attempt: t.attempt, msg: `${id}: ${from} -> ${to} — ${reason}`, data: { from, to, reason } });
  }

  setMilestone(id, to, reason, patch = {}, severity = 'info', actor) {
    if (to === 'BLOCKED') severity = 'error';
    if (to === 'AWAITING_APPROVAL') severity = 'approval';
    if (to === 'DONE') severity = 'done';
    const m = this.milestone(id);
    const from = m.status;
    if (from !== to && !MILESTONE_TRANSITIONS[from].includes(to)) {
      throw new SfError(`Illegal milestone transition ${id}: ${from} -> ${to}`, { code: 'ILLEGAL_TRANSITION' });
    }
    Object.assign(m, patch, { status: to });
    if (to === 'BLOCKED') m.blocked_reason = reason;
    this.save();
    this.emit('milestone_transition', { severity, entity: 'milestone', id, actor, msg: `milestone ${id}: ${from} -> ${to} — ${reason}`, data: { from, to, reason } });
  }

  /** Add plan tasks/milestones missing from state (plan amended between runs). */
  syncWithPlan(plan) {
    const known = new Set(plan.tasks.map((t) => t.id));
    for (const [id, t] of Object.entries(this.state.tasks)) {
      if (!known.has(id) && t.status !== 'INTEGRATED') throw new SfError(`Task ${id} (${t.status}) exists in state but not in the plan; restore it in plan.yaml or reset the run (sf.mjs assess).`, { code: 'PLAN_STATE_MISMATCH' });
    }
    const added = [];
    for (const t of plan.tasks) if (!this.state.tasks[t.id]) { this.state.tasks[t.id] = newTaskRecord(t); added.push(t.id); }
    for (const m of plan.milestones) if (!this.state.milestones[m.id]) this.state.milestones[m.id] = newMilestoneRecord();
    if (added.length) {
      this.save();
      this.emit('plan_synced', { msg: `Plan amended: added task(s) ${added.join(', ')}`, data: { added } });
    }
    return added;
  }

  /** Adopt a newer task definition (operator-approved plan change) for a task that has not started. */
  refreshPlanFingerprints(plan) {
    const changed = [];
    for (const t of plan.tasks) {
      const rec = this.state.tasks[t.id];
      if (!rec) continue;
      const fp = taskDefFingerprint(t);
      if (rec.plan_fp !== fp) { rec.plan_fp = fp; rec.plan_def = taskDef(t); changed.push(t.id); }
    }
    if (changed.length) this.save();
    return changed;
  }

  readEvents({ since = 0, limit = 1000 } = {}) {
    return readEvents(this.paths.events, { since, limit });
  }

  /** Rebuild state from the event log (used to repair a snapshot that is behind the log). */
  static rebuildFromLog(paths) {
    return foldEvents(readEvents(paths.events));
  }
}

// ---------------------------------------------------------------- locks

export function readLock(paths) {
  try {
    return JSON.parse(fs.readFileSync(paths.lock, 'utf8'));
  } catch {
    return null;
  }
}

/** Alive = pid exists and (when a fingerprint was recorded) is the same process that took the lock. */
export function supervisorAlive(paths) {
  const l = readLock(paths);
  if (!l || !isPidAlive(l.pid)) return false;
  return l.fp ? sameProcess(l.pid, l.fp) : true;
}

export function acquireLock(paths) {
  mkdirp(paths.runtime);
  const body = () => JSON.stringify({ pid: process.pid, fp: processFingerprint(process.pid), started_at: nowIso(), heartbeat_at: nowIso(), sf_version: SF_VERSION });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(paths.lock, 'wx');
      fs.writeSync(fd, body());
      fs.closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (supervisorAlive(paths)) {
        const l = readLock(paths);
        throw new SfError(`Another supervisor is already running (pid ${l.pid}). Only one run may be active; use "status", "wait" or "stop".`, { code: 'LOCKED' });
      }
      try { fs.unlinkSync(paths.lock); } catch { /* raced */ }
    }
  }
  throw new SfError('Could not acquire supervisor lock', { code: 'LOCKED' });
}

export function touchLock(paths) {
  const l = readLock(paths);
  if (l && l.pid === process.pid) {
    l.heartbeat_at = nowIso();
    try { atomicWrite(paths.lock, JSON.stringify(l)); } catch { /* best effort */ }
  }
}

export function releaseLock(paths) {
  const l = readLock(paths);
  if (l && l.pid === process.pid) {
    try { fs.unlinkSync(paths.lock); } catch { /* gone */ }
  }
}

/** Short mutation lock for offline state writes (CLI commands, reset/archive). Synchronous. */
export function withStateLock(paths, fn, { timeoutMs = 8000 } = {}) {
  mkdirp(paths.runtime);
  const t0 = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(paths.stateLock, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: nowIso() }));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(paths.stateLock, 'utf8')); } catch { /* torn */ }
      if (!holder || !isPidAlive(holder.pid)) { try { fs.unlinkSync(paths.stateLock); } catch { /* raced */ } continue; }
      if (Date.now() - t0 > timeoutMs) throw new SfError(`State is locked by pid ${holder.pid}; try again`, { code: 'STATE_LOCKED' });
      sleepSync(40);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(paths.stateLock); } catch { /* gone */ }
  }
}

// ---------------------------------------------------------------- command inbox

export function enqueueCommand(paths, cmd) {
  mkdirp(paths.inbox);
  const name = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 6)}.json`;
  atomicWrite(path.join(paths.inbox, name), JSON.stringify({ ...cmd, queued_at: nowIso() }));
  return name;
}

export function listInbox(paths) {
  if (!exists(paths.inbox)) return [];
  return fs.readdirSync(paths.inbox).filter((x) => x.endsWith('.json')).sort().map((f) => {
    try { return { file: f, ...JSON.parse(fs.readFileSync(path.join(paths.inbox, f), 'utf8')) }; } catch { return { file: f, kind: 'corrupt' }; }
  });
}

export function drainInbox(paths) {
  if (!exists(paths.inbox)) return [];
  const out = [];
  for (const f of fs.readdirSync(paths.inbox).filter((x) => x.endsWith('.json')).sort()) {
    const full = path.join(paths.inbox, f);
    try { out.push(JSON.parse(fs.readFileSync(full, 'utf8'))); } catch { /* corrupt command dropped */ }
    try { fs.unlinkSync(full); } catch { /* gone */ }
  }
  return out;
}

/**
 * Apply a state-only command (used by the supervisor and by the CLI when no supervisor runs).
 * cmd.who = {confirmed_by, via, quote, by} records provenance in the event log and the durable ledger.
 */
export function applyCommand(store, cmd) {
  const who = cmd.who ?? { confirmed_by: 'user' };
  const actor = who.confirmed_by ?? who.by ?? 'user';
  switch (cmd.kind) {
    case 'approve_milestone': {
      const m = store.milestone(cmd.id);
      if (m.status !== 'AWAITING_APPROVAL') throw new SfError(`Milestone ${cmd.id} is ${m.status}, not AWAITING_APPROVAL`, { code: 'BAD_COMMAND' });
      m.approval = 'APPROVED';
      m.approved_by = who;
      store.save();
      store.emit('approval_granted', { severity: 'info', entity: 'milestone', id: cmd.id, actor, msg: `Milestone ${cmd.id} approved${cmd.note ? `: ${cmd.note}` : ''}`, data: { who, note: cmd.note ?? null } });
      ledgerAppend(store.paths, 'milestone_approved', { actor, msg: `milestone ${cmd.id} approved`, data: { run_id: store.state.run.id, milestone: cmd.id, branch: m.branch, who, note: cmd.note ?? null } });
      return `milestone ${cmd.id} approved`;
    }
    case 'unblock_task': {
      const t = store.task(cmd.id);
      if (t.status !== 'BLOCKED') throw new SfError(`Task ${cmd.id} is ${t.status}, not BLOCKED`, { code: 'BAD_COMMAND' });
      const patch = { extra_rounds: t.extra_rounds + (cmd.extra_rounds ?? 0), activity: null };
      if (cmd.implementer) { patch.implementer = cmd.implementer; patch.pin_implementer = true; }
      if (cmd.note) patch.operator_note = cmd.note;
      if (cmd.reset_rounds) patch.rework_rounds = 0;
      store.setTask(cmd.id, 'READY', `unblocked by ${actor}${cmd.note ? `: ${cmd.note}` : ''}`, patch, 'info', actor);
      store.emit('operator_command', { entity: 'task', id: cmd.id, actor, msg: `unblock ${cmd.id}`, data: { cmd: { ...cmd, who: undefined }, who } });
      return `task ${cmd.id} unblocked`;
    }
    case 'unblock_milestone': {
      const m = store.milestone(cmd.id);
      if (m.status !== 'BLOCKED') throw new SfError(`Milestone ${cmd.id} is ${m.status}, not BLOCKED`, { code: 'BAD_COMMAND' });
      store.setMilestone(cmd.id, cmd.to === 'GATE' ? 'GATE' : 'ACTIVE', `unblocked by ${actor}${cmd.note ? `: ${cmd.note}` : ''}`, { blocked_reason: null }, 'info', actor);
      store.emit('operator_command', { entity: 'milestone', id: cmd.id, actor, msg: `unblock milestone ${cmd.id}`, data: { who } });
      return `milestone ${cmd.id} unblocked`;
    }
    case 'note': {
      store.emit('note', { entity: cmd.task ? 'task' : null, id: cmd.task ?? null, actor, msg: cmd.msg, data: { kind: cmd.note_kind, who } });
      if (cmd.note_kind === 'decision') ledgerAppend(store.paths, 'decision', { actor, msg: cmd.msg, data: { run_id: store.state.run.id, task: cmd.task ?? null, who } });
      return 'note recorded';
    }
    default:
      throw new SfError(`Unknown command kind "${cmd.kind}"`, { code: 'BAD_COMMAND' });
  }
}
