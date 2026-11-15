// Deterministic supervisor: scheduling, worktrees, dispatch, evidence, review gating, rework, integration,
// milestone gates, notifications, resume. LLM judgment happens only inside the agents it dispatches.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SfError, sleep, nowIso, readText, mkdirp, atomicWrite, writeJson, slug, isPidAlive, formatDuration, exists, sha256, processFingerprint, sameProcess, redact } from './lib/util.mjs';
import { loadFactory, agentById } from './lib/factory.mjs';
import { parseSpec, lintSpec, buildIndex } from './lib/spec.mjs';
import { loadPlanRaw, lintPlan, topoSort, pickImplementer, pickReviewer } from './lib/plan.mjs';
import { Store, acquireLock, releaseLock, touchLock, withStateLock, drainInbox, applyCommand, TASK_STATES } from './lib/state.mjs';
import { foldEvents, stripVolatile, verifyChain } from './lib/journal.mjs';
import { SF_VERSION } from './lib/version.mjs';
import { pendingOps } from './assess.mjs';
import * as G from './lib/git.mjs';
import { runAgent, killTree, tailFile } from './lib/runner.mjs';
import { render } from './lib/template.mjs';
import { Notifier, buildDigest } from './lib/notify.mjs';
import { readReviewResult, checkReviewResult, verdict } from './lib/review.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tpl = (name) => readText(path.join(here, '..', 'templates', name));
const bullets = (items, empty = '(none)') => (items.length ? items.map((s) => `- ${s}`).join('\n') : empty);
const numbered = (items) => items.map((s, i) => `${i + 1}. ${s}`).join('\n');

/** Run a shell command with a log file and timeout. Resolves {exitCode, ok, timedOut}. */
export function runShell(command, cwd, logPath, timeoutMs, signal) {
  mkdirp(path.dirname(logPath));
  const fd = fs.openSync(logPath, 'w');
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', fd, fd], detached: process.platform !== 'win32', env: { ...process.env, CI: '1' }, windowsHide: true });
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs) : null;
    const onAbort = () => killTree(child);
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = (code, error) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { fs.closeSync(fd); } catch { /* closed */ }
      resolve({ exitCode: code, ok: code === 0 && !timedOut, timedOut, error });
    };
    child.on('error', (e) => done(null, e.message));
    child.on('close', (code) => done(code));
  });
}

function defer() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

export class Supervisor {
  /**
   * @param {{root:string, exitWhenIdle?:boolean, allowUnverified?:boolean, log?:(m:string)=>void}} o
   */
  constructor(o) {
    this.root = o.root;
    this.exitWhenIdle = Boolean(o.exitWhenIdle);
    this.allowUnverified = Boolean(o.allowUnverified);
    this.log = o.log ?? ((m) => process.stdout.write(`${m}\n`));
    this.abort = new AbortController();
    this.stopRequested = false;
    this.running = new Map();
    this.jobs = new Set();
    this.integration = null;
    this.gates = new Set();
    this.finalizing = new Set();
    this.deferred = new Map();
    this.wake = defer();
    this.exitReason = null;
  }

  poke() {
    const w = this.wake;
    this.wake = defer();
    w.resolve();
  }

  requestStop(reason = 'stop requested') {
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.exitReason = reason;
    this.abort.abort();
    this.poke();
  }

  // ------------------------------------------------------------------ preparation

  prepare() {
    const { factory, paths } = loadFactory(this.root);
    this.factory = factory;
    this.paths = paths;
    acquireLock(paths);
    const rel = path.relative(this.root, paths.spec).split(path.sep).join('/');
    const parsed = parseSpec(readText(paths.spec), { filename: rel });
    const sl = lintSpec(parsed, { filename: rel });
    if (sl.errors.length) throw new SfError('Spec has lint errors', { code: 'BAD_SPEC', details: sl.errors });
    this.specIndex = buildIndex(parsed, { specPath: rel });
    const plan = loadPlanRaw(paths.plan);
    const pl = lintPlan(plan, { specIndex: this.specIndex, factory, requireApproved: factory.approvals.plan });
    if (pl.errors.length) throw new SfError('Plan has lint errors (fix with sf-plan-builder)', { code: 'BAD_PLAN', details: pl.errors });
    this.plan = plan;
    this.tasksById = new Map(plan.tasks.map((t) => [t.id, t]));
    this.milestonesById = new Map(plan.milestones.map((m) => [m.id, m]));
    this.taskOrder = topoSort(plan.tasks, (t) => t.depends_on).order;

    if (!G.isRepo(this.root)) throw new SfError('Project root is not a git repository. Run "git init" and commit first.', { code: 'NO_REPO' });
    if (!G.hasCommits(this.root)) throw new SfError('Repository has no commits yet; make an initial commit so worktrees can be created.', { code: 'NO_COMMITS' });
    this.repo = G.repoTop(this.root);
    this.worktreeRoot = path.resolve(this.root, factory.git.worktree_root);
    this.author = { name: factory.git.commit_author_name, email: factory.git.commit_author_email };

    if (!this.allowUnverified) {
      const doc = exists(paths.doctor) ? JSON.parse(readText(paths.doctor)) : { agents: {} };
      const used = new Set([...factory.roles.implementers, ...factory.roles.reviewers]);
      const bad = [...used].filter((id) => !doc.agents?.[id]?.ok);
      if (bad.length) throw new SfError(`Agents not verified: ${bad.join(', ')}. Run "node sf-agent-setup/scripts/setup.mjs doctor" (or pass --allow-unverified).`, { code: 'UNVERIFIED_AGENTS' });
    }

    this.store = new Store(paths, { actor: 'supervisor' });
    withStateLock(paths, () => {
      if (Store.exists(paths)) {
        this.store.load();
        this.repairFromLog();
        this.store.syncWithPlan(plan);
        this.resumed = true;
      } else {
        this.store.init(plan, { specHash: this.specIndex.spec_hash });
        this.resumed = false;
      }
    });
    const base = factory.git.base_branch === 'auto' ? (this.store.state.run.base_branch ?? G.currentBranch(this.repo)) : factory.git.base_branch;
    if (!G.branchExists(this.repo, base)) throw new SfError(`Base branch "${base}" does not exist (current HEAD: ${G.currentBranch(this.repo)})`, { code: 'NO_BASE' });
    this.base = base;
    this.store.state.run.base_branch = base;
    this.store.save();

    this.notifier = new Notifier({ channels: factory.notify.channels, intervalMinutes: factory.notify.interval_minutes, paths, log: (m) => this.log(`[notify] ${m}`) });
    this.store.onEvent = (ev) => {
      this.notifier.lastSeqSeen = ev.seq;
      if (['error', 'approval', 'done', 'warn'].includes(ev.severity)) {
        this.notifier.event(ev.severity, `${ev.severity === 'error' ? '🔴' : ev.severity === 'approval' ? '🟡' : ev.severity === 'done' ? '🟢' : '⚠️'} ${this.store.state.project_id}: ${ev.msg}${this.hintFor(ev)}`);
      }
    };
  }

  /** The event log is write-ahead truth: if the snapshot lags it (crash between log append and snapshot write), rebuild. */
  repairFromLog() {
    const chain = verifyChain(this.paths.events);
    if (!chain.ok) {
      this.store.emit('log_integrity_warning', { severity: 'warn', msg: `event log integrity: ${chain.reason} at seq ${chain.brokenAt}`, data: chain });
      return;
    }
    const folded = foldEvents(this.store.readEvents({ limit: Infinity }));
    if (folded && JSON.stringify(stripVolatile(folded)) !== JSON.stringify(stripVolatile(this.store.state))) {
      this.store.state = { ...folded, updated_at: nowIso() };
      atomicWrite(this.paths.state, JSON.stringify(this.store.state, null, 2) + '\n');
      this.store.shadow = JSON.parse(JSON.stringify(this.store.state));
      this.store.emit('state_repaired', { severity: 'warn', msg: 'state.json was out of step with the event log; rebuilt from the log' });
    }
  }

  hintFor(ev) {
    if (ev.severity === 'approval' && ev.entity === 'milestone') return `\n→ node sf-orchestrator/scripts/sf.mjs approve --milestone ${ev.id}`;
    if (ev.severity === 'error' && ev.entity === 'task') return `\n→ node sf-orchestrator/scripts/sf.mjs explain ${ev.id}`;
    return '';
  }

  /** After a crash/stop: kill orphan agents, put interrupted work back into a dispatchable state. */
  reconcile() {
    const s = this.store.state;
    const pend = pendingOps(this.store.readEvents({ limit: Infinity }));
    if (pend.length) this.store.emit('ops_reconciled', { severity: 'warn', msg: `${pend.length} operation(s) from the previous supervisor never finished: ${pend.map((o) => o.op).join(', ')}`, data: { ops: pend } });
    for (const [id, t] of Object.entries(s.tasks)) {
      const a = t.activity;
      if (a?.pid && isPidAlive(a.pid)) {
        if (a.fp && sameProcess(a.pid, a.fp)) {
          try { process.kill(process.platform === 'win32' ? a.pid : -a.pid, 'SIGKILL'); } catch { /* gone */ }
          this.store.emit('orphan_killed', { severity: 'warn', entity: 'task', id, msg: `${id}: killed orphaned ${a.kind} process ${a.pid} (identity verified)`, data: { pid: a.pid, agent: a.agent } });
        } else {
          this.store.emit('orphan_not_killed', { severity: 'warn', entity: 'task', id, msg: `${id}: pid ${a.pid} is alive but its identity could not be verified; NOT killed (possible pid reuse)`, data: { pid: a.pid } });
        }
      }
      if (t.status === 'RUNNING') this.store.setTask(id, 'READY', 'supervisor restarted while the implementer was running; worktree kept', { activity: null, interrupted: true });
      else if (t.activity) { t.activity = null; this.store.save(); }
    }
    for (const [id, m] of Object.entries(s.milestones)) {
      if (m.status === 'GATE') this.store.setMilestone(id, 'ACTIVE', 'supervisor restarted during gate; gate will re-run');
      if (m.integration_worktree && exists(m.integration_worktree)) {
        G.git(m.integration_worktree, ['merge', '--abort'], { allowFail: true });
      }
    }
    G.worktreePrune(this.repo);
  }

  // ------------------------------------------------------------------ main loop

  async run() {
    try {
      this.prepare();
    } catch (e) {
      if (this.paths) releaseLock(this.paths);
      throw e;
    }
    const s = this.store.state;
    const decision = s.run.resume_decision ?? null;
    s.run.supervisor_pid = process.pid;
    s.run.stop_reason = null;
    s.run.sf_version = SF_VERSION;
    if (decision && !decision.consumed) {
      decision.consumed = true;
      this.store.refreshPlanFingerprints(this.plan);
    }
    this.store.save();
    try {
      this.reconcile();
      this.store.emit('supervisor_started', { msg: `Supervisor started (pid ${process.pid}, ${this.resumed ? 'resumed' : 'fresh'}); base ${this.base}; ${Object.keys(s.tasks).length} tasks`, data: { pid: process.pid, resumed: this.resumed, decision: decision ?? null, sf_version: SF_VERSION } });
      this.log(`sf supervisor: project ${s.project_id}, ${this.resumed ? 'resumed' : 'new'} run ${s.run.id}, base branch ${this.base}`);
      await this.notifier.event('info', `▶ ${s.project_id}: orchestration ${this.resumed ? 'resumed' : 'started'} — ${Object.keys(s.tasks).length} tasks in ${Object.keys(s.milestones).length} milestone(s). Updates every ${this.factory.notify.interval_minutes} min.`);
      let digestSeq = this.store.seq;
      const pollMs = this.factory.execution.poll_seconds * 1000;
      for (;;) {
        if (Date.now() - (this.lastBeat ?? 0) > 5000) { touchLock(this.paths); this.lastBeat = Date.now(); }
        for (const cmd of drainInbox(this.paths)) this.handleCommand(cmd);
        if (this.stopRequested) break;
        const progressed = this.advance();
        this.maybeIntegrate();
        this.maybeGate();
        this.maybeFinalize();
        this.writeStatus();
        const sent = await this.notifier.maybeDigest(() => buildDigest(this.store.state, { events: this.store.readEvents({ since: digestSeq }) }));
        if (sent) digestSeq = this.store.seq;
        if (Object.values(this.store.state.milestones).every((m) => m.status === 'DONE')) {
          this.exitReason = 'complete';
          this.store.emit('run_complete', { severity: 'done', msg: `All ${Object.keys(this.store.state.tasks).length} tasks integrated; all milestones done. Report: ${path.join(this.paths.runtime, 'report.md')}` });
          atomicWrite(path.join(this.paths.runtime, 'report.md'), buildReport(this.store.state, this.plan));
          break;
        }
        const busy = this.running.size || this.integration || this.gates.size || this.finalizing.size;
        if (this.exitWhenIdle && !busy && !progressed) {
          this.exitReason = 'idle';
          break;
        }
        await Promise.race([sleep(pollMs), this.wake.promise]);
      }
    } finally {
      await this.shutdown();
    }
    return this.exitReason;
  }

  async shutdown() {
    this.abort.abort();
    await Promise.allSettled([...this.running.values(), ...this.jobs]);
    const s = this.store.state;
    for (const [id, t] of Object.entries(s.tasks)) {
      if (t.status === 'RUNNING') this.store.setTask(id, 'READY', 'supervisor stopped; worktree kept', { activity: null });
      else if (t.activity) { t.activity = null; }
    }
    s.run.supervisor_pid = null;
    s.run.stopped_at = nowIso();
    s.run.stop_reason = this.exitReason;
    this.store.save();
    this.writeStatus();
    this.store.emit('supervisor_stopped', { msg: `Supervisor stopped: ${this.exitReason}` });
    await this.notifier.event(this.exitReason === 'complete' ? 'done' : 'info', `⏹ ${s.project_id}: supervisor stopped (${this.exitReason}).\n${buildDigest(s, {})}`);
    await this.notifier.flush();
    releaseLock(this.paths);
  }

  writeStatus() {
    this.notifier.writeStatus(buildDigest(this.store.state, { events: this.store.readEvents({ limit: 8 }) }));
  }

  handleCommand(cmd) {
    try {
      if (cmd.kind === 'stop') {
        this.store.emit('operator_command', { actor: cmd.who?.confirmed_by ?? cmd.who?.by ?? 'user', msg: 'stop requested', data: { who: cmd.who ?? null } });
        this.requestStop('stopped by operator');
        return;
      }
      this.log(`command: ${applyCommand(this.store, cmd)}`);
    } catch (e) {
      this.store.emit('command_rejected', { severity: 'warn', msg: `Command ${cmd.kind} rejected: ${e.message}` });
    }
  }

  launch(name, fn) {
    const p = Promise.resolve()
      .then(fn)
      .catch((e) => this.store.emit('internal_error', { severity: 'error', msg: `${name} failed: ${e.message}` }))
      .finally(() => { this.jobs.delete(p); this.poke(); });
    this.jobs.add(p);
    return p;
  }

  // ------------------------------------------------------------------ scheduling

  advance() {
    const s = this.store.state;
    let progressed = false;
    for (const m of this.plan.milestones) {
      const rec = s.milestones[m.id];
      if (rec.status === 'PLANNED' && m.depends_on.every((d) => s.milestones[d].status === 'DONE')) {
        try {
          this.ensureMilestoneBranch(m.id);
          this.store.setMilestone(m.id, 'ACTIVE', `branch ${rec.branch} ready`);
        } catch (e) {
          this.store.setMilestone(m.id, 'BLOCKED', `could not prepare milestone branch: ${e.message}`);
        }
        progressed = true;
      }
    }
    for (const id of this.taskOrder) {
      const t = s.tasks[id];
      const pt = this.tasksById.get(id);
      if (t.status === 'PLANNED' && s.milestones[pt.milestone].status === 'ACTIVE' && pt.depends_on.every((d) => s.tasks[d].status === 'INTEGRATED')) {
        this.store.setTask(id, 'READY', 'dependencies integrated');
        progressed = true;
      }
    }
    const load = this.agentLoad();
    const runningScopes = [...this.running.keys()].flatMap((id) => this.tasksById.get(id).write_scopes);
    const defer = (id, reason) => {
      if (this.deferred.get(id) !== reason) {
        this.deferred.set(id, reason);
        this.store.emit('deferred', { entity: 'task', id, msg: `${id} not dispatched: ${reason}`, data: { reason } });
      }
    };
    for (const id of this.taskOrder) {
      if (this.stopRequested) break;
      const t = s.tasks[id];
      if (this.running.has(id) || !['READY', 'REWORK', 'REVIEW'].includes(t.status)) continue;
      if (this.running.size >= this.factory.execution.max_parallel_tasks) { defer(id, `max_parallel_tasks (${this.factory.execution.max_parallel_tasks}) reached`); continue; }
      const pt = this.tasksById.get(id);
      if (s.milestones[pt.milestone].status !== 'ACTIVE') continue;
      const clash = [...this.running.keys()].find((rid) => this.tasksById.get(rid).write_scopes.some((b) => pt.write_scopes.some((a) => G.scopesOverlap(a, b))));
      if (clash) { defer(id, `write scope overlaps running task ${clash}`); continue; }
      let agent = null;
      if (t.status === 'REVIEW') agent = null;
      else {
        agent = t.implementer && (t.status === 'REWORK' || t.pin_implementer) ? agentById(this.factory, t.implementer) : pickImplementer(this.factory, pt, load);
        if (!agent || (load[agent.id] ?? 0) >= agent.max_concurrency) { defer(id, 'no implementer with free capacity'); continue; }
        load[agent.id] = (load[agent.id] ?? 0) + 1;
      }
      this.deferred.delete(id);
      runningScopes.push(...pt.write_scopes);
      t.activity = { kind: t.status === 'REVIEW' ? 'review' : 'implement', agent: agent?.id ?? '(reviewer pending)', started_at: nowIso(), pid: null };
      this.store.save();
      this.store.emit('scheduled', { entity: 'task', id, attempt: t.attempt, msg: `${id} dispatched (${t.status}) → ${agent?.id ?? 'reviewer pending'}`, data: { status: t.status, agent: agent?.id ?? null, load: { ...load }, running: [...this.running.keys()] } });
      const p = this.driveTask(id, agent)
        .catch((e) => this.blockTask(id, `internal error: ${e.message}`))
        .finally(() => { this.running.delete(id); this.poke(); });
      this.running.set(id, p);
      progressed = true;
    }
    return progressed;
  }

  agentLoad() {
    const load = {};
    for (const t of Object.values(this.store.state.tasks)) {
      if (t.activity && t.activity.agent && !t.activity.agent.startsWith('(')) load[t.activity.agent] = (load[t.activity.agent] ?? 0) + 1;
    }
    return load;
  }

  blockTask(id, reason) {
    const t = this.store.task(id);
    if (t.status === 'BLOCKED' || t.status === 'INTEGRATED') return;
    t.activity = null;
    this.store.setTask(id, 'BLOCKED', reason);
  }

  // ------------------------------------------------------------------ git helpers

  milestoneBranch(mid) {
    return `${this.factory.git.milestone_branch_prefix}${slug(mid)}`;
  }

  integrationPath(mid) {
    return path.join(this.worktreeRoot, slug(mid), '_integration');
  }

  /** Create (or reattach) the milestone branch + its integration worktree; merge dependency milestone branches. */
  ensureMilestoneBranch(mid) {
    const rec = this.store.milestone(mid);
    const branch = this.milestoneBranch(mid);
    const wt = this.integrationPath(mid);
    rec.branch = branch;
    rec.integration_worktree = wt;
    this.store.save();
    if (!exists(wt)) {
      G.worktreePrune(this.repo);
      G.worktreeAdd(this.repo, wt, branch, this.base);
      this.store.emit('git_op', { entity: 'milestone', id: mid, msg: `worktree added ${path.relative(this.root, wt)} on ${branch}`, data: { op: 'worktree_add', path: wt, branch, base: this.base, sha: G.headSha(wt) } });
    }
    for (const dep of this.milestonesById.get(mid).depends_on) {
      const depBranch = this.milestoneBranch(dep);
      if (G.branchExists(this.repo, depBranch) && !G.isAncestor(wt, depBranch, 'HEAD')) {
        const r = G.mergeNoFf(wt, depBranch, `Include milestone ${dep} in ${mid}`, this.author);
        this.store.emit('git_op', { entity: 'milestone', id: mid, severity: r.ok ? 'info' : 'error', msg: `merge dependency ${depBranch} into ${branch}: ${r.ok ? 'ok' : 'FAILED'}`, data: { op: 'merge', from: depBranch, into: branch, ok: r.ok, sha: r.ok ? G.headSha(wt) : null } });
        if (!r.ok) throw new SfError(`merge of dependency milestone ${dep} into ${mid} failed: ${r.message}`);
      }
    }
    rec.branch = branch;
    rec.integration_worktree = wt;
    this.store.save();
    return wt;
  }

  ensureTaskWorktree(id) {
    const t = this.store.task(id);
    const pt = this.tasksById.get(id);
    const mrec = this.store.milestone(pt.milestone);
    const branch = `${this.factory.git.task_branch_prefix}${slug(id)}`;
    const wt = path.join(this.worktreeRoot, slug(pt.milestone), slug(id));
    t.branch = branch;
    t.worktree = wt;
    t.base_ref = mrec.branch;
    this.store.save();
    if (!exists(wt)) {
      G.worktreePrune(this.repo);
      G.worktreeAdd(this.repo, wt, branch, mrec.branch);
      this.store.emit('git_op', { entity: 'task', id, attempt: t.attempt, msg: `worktree added ${path.relative(this.root, wt)} on ${branch} from ${mrec.branch}`, data: { op: 'worktree_add', path: wt, branch, base: mrec.branch, sha: G.headSha(wt) } });
    }
    t.branch = branch;
    t.worktree = wt;
    t.base_ref = mrec.branch;
    this.store.save();
    return { branch, wt };
  }

  instructionFiles() {
    const files = this.factory.project.instructions.filter((f) => exists(path.resolve(this.root, f)));
    return bullets(files, '(no project instruction files configured)');
  }

  requirementsText(pt) {
    const lines = [];
    for (const rid of pt.requirements) {
      const r = this.specIndex.requirements.find((x) => x.id === rid);
      if (!r) continue;
      lines.push(`### ${r.id}: ${r.title} [${r.priority}]\n${r.statement}\n${r.criteria.map((c) => `- ${c.text}`).join('\n')}`);
    }
    return lines.join('\n\n') || '(no spec requirement; follow the goal and criteria)';
  }

  findingsText(findings) {
    if (!findings?.length) return '';
    return findings.map((f, i) => `${i + 1}. [${f.source}${f.severity ? `/${f.severity}` : ''}] ${f.description}${f.required_fix ? `\n   Required fix: ${f.required_fix}` : ''}${f.log ? `\n   Log: ${f.log}` : ''}`).join('\n');
  }

  // ------------------------------------------------------------------ task pipeline

  async driveTask(id, agent) {
    for (;;) {
      if (this.stopRequested) return;
      const t = this.store.task(id);
      if (t.status === 'READY' || t.status === 'REWORK') {
        const impl = agent ?? agentById(this.factory, t.implementer);
        agent = null;
        await this.implement(id, impl);
      } else if (t.status === 'REVIEW') await this.review(id);
      else return;
      const st = this.store.task(id).status;
      if (['PASS', 'BLOCKED', 'INTEGRATED'].includes(st)) return;
    }
  }

  async implement(id, agent) {
    const t = this.store.task(id);
    const pt = this.tasksById.get(id);
    const { branch, wt } = this.ensureTaskWorktree(id);
    const attempt = t.attempt + 1;
    const rework = t.status === 'REWORK' || t.rework_rounds > 0 || t.findings.length > 0;
    const partial = t.interrupted && (!G.isClean(wt) || (G.commitsAhead(wt, t.base_ref) ?? 0) > 0);
    const sessionId = t.interrupted && t.last_session?.agent === agent.id ? t.last_session.id : '';
    this.store.setTask(id, 'RUNNING', `attempt ${attempt} by ${agent.id}${rework ? ' (rework)' : ''}`, {
      attempt, implementer: agent.id, started_at: t.started_at ?? nowIso(), activity: { kind: 'implement', agent: agent.id, started_at: nowIso(), pid: null, fp: null }, interrupted: false,
    });
    const runDir = path.join(this.paths.runs, slug(id), `attempt-${attempt}`);
    const verifyText = pt.verify.length ? pt.verify.map((v) => `- ${v.name}: \`${v.run}\``).join('\n') : '(no automated commands; the reviewer will inspect the work)';
    const reworkSection = t.findings.length
      ? `\n## This is a REWORK round — fix exactly these unresolved findings (and nothing unrelated)\n${this.findingsText(t.findings)}\n${t.operator_note ? `\nOperator note: ${t.operator_note}\n` : ''}\nIf one finding is a merge conflict with the milestone branch, run \`git merge ${t.base_ref}\` inside the worktree, resolve conflicts keeping both sides' intent, and commit.\n`
      : '';
    const resumeNote = partial
      ? `\n## RESUMED after an interruption\nThe worktree already contains partial work from an earlier attempt (uncommitted changes and/or commits). Inspect \`git status\` and \`git diff ${t.base_ref}...HEAD\` first, keep what is correct, and continue; do not start over.\n`
      : '';
    const brief = render(tpl('agent-brief.md'), {
      task_id: id, title: pt.title, agent_id: agent.id, attempt, worktree: wt, branch, base_branch: t.base_ref,
      goal: pt.goal, instruction_files: this.instructionFiles(), spec_path: path.relative(this.root, this.paths.spec),
      requirements_text: this.requirementsText(pt), criteria_text: numbered(pt.acceptance_criteria),
      write_scopes_text: bullets(pt.write_scopes), verify_text: verifyText, rework_section: resumeNote + reworkSection,
    }, { what: 'agent-brief' });
    const opId = this.store.intent('agent_run', {
      role: 'implementer', agent: agent.id, model: agent.model ?? null, cwd: wt, brief: path.join(runDir, 'brief.md'), brief_sha256: sha256(brief),
      resumed_session: sessionId || null, partial_work_present: Boolean(partial),
    }, { entity: 'task', id, attempt });
    const res = await runAgent({
      agent, prompt: brief, promptFile: path.join(runDir, 'brief.md'), cwd: wt, root: this.root, runDir,
      vars: { role: 'implementer', task_id: id, attempt, result_file: path.join(runDir, 'result.json'), session_id: sessionId },
      timeoutMs: (agent.timeout_minutes ?? pt.timeout_minutes ?? this.factory.execution.task_timeout_minutes) * 60000,
      signal: this.abort.signal,
      onSpawn: (pid) => { t.activity.pid = pid; t.activity.fp = processFingerprint(pid); t.activity.op_id = opId; this.store.save(); },
    });
    this.store.result(opId, 'agent_run', {
      status: res.status, exit_code: res.exitCode, signal: res.signal, duration_ms: res.durationMs, pid: res.pid, argv: res.argv, error: res.error ?? null,
      stdout: res.stdoutPath, stderr: res.stderrPath, session_id: res.sessionId, artifacts: res.artifacts,
    }, { entity: 'task', id, attempt, severity: res.status === 'SUCCEEDED' ? 'info' : 'warn' });
    if (res.sessionId) t.last_session = { agent: agent.id, id: res.sessionId };
    if (this.stopRequested) return;
    t.activity = null;
    if (res.status === 'SPAWN_ERROR') return this.blockTask(id, `cannot start agent ${agent.id}: ${res.error}`);
    const findings = [];
    if (res.status !== 'SUCCEEDED') {
      findings.push({ source: 'agent', severity: 'blocking', description: `Agent run ${res.status}${res.exitCode !== null ? ` (exit ${res.exitCode})` : ''}. stderr tail: ${tailFile(res.stderrPath, 400).trim() || '(empty)'}`, log: res.stderrPath });
    }
    const commitOp = this.store.intent('commit', { cwd: wt }, { entity: 'task', id, attempt });
    const sha = G.commitAll(wt, `${id}: ${pt.title} (attempt ${attempt})`, this.author);
    t.head_sha = G.headSha(wt);
    const ref = `refs/sf/${this.store.state.run.id}/${slug(id)}/attempt-${attempt}`;
    G.updateRef(this.repo, ref, t.head_sha);
    this.store.result(commitOp, 'commit', { committed: Boolean(sha), sha: t.head_sha, ref }, { entity: 'task', id, attempt });
    const evidence = await this.collectEvidence(id, wt, runDir, pt);
    t.evidence = evidence;
    findings.push(...evidence.findings);
    this.store.save();
    if (findings.length) return this.failRound(id, findings, `evidence failed (${findings.length} finding(s))`);
    this.store.setTask(id, 'REVIEW', `implementation committed${sha ? ` ${sha.slice(0, 8)}` : ''}; verify and scope checks green`);
  }

  async collectEvidence(id, wt, runDir, pt) {
    const out = { at: nowIso(), ok: true, changed: [], scope: { ok: true, violations: [] }, verify: [], findings: [] };
    const t = this.store.task(id);
    out.changed = G.changedFiles(wt, t.base_ref);
    const inScope = G.scopeMatcher(pt.write_scopes);
    out.scope.violations = out.changed.filter((f) => !inScope(f) || f === '.sf' || f.startsWith('.sf/'));
    out.scope.ok = out.scope.violations.length === 0;
    this.store.emit('scope_checked', { entity: 'task', id, attempt: t.attempt, severity: out.scope.ok ? 'info' : 'warn', msg: `${id}: ${out.changed.length} file(s) changed, ${out.scope.violations.length} outside scope`, data: { changed: out.changed, violations: out.scope.violations, scopes: pt.write_scopes } });
    if (!out.scope.ok) {
      out.findings.push({ source: 'scope', severity: 'blocking', description: `Files changed outside the allowed write scopes: ${out.scope.violations.join(', ')}. Revert those changes (git checkout ${t.base_ref} -- <file> or delete new files).`, required_fix: `Only modify: ${pt.write_scopes.join(', ')}` });
    }
    if (out.changed.length === 0) out.findings.push({ source: 'scope', severity: 'blocking', description: 'The implementation produced no file changes.' });
    for (const [i, v] of pt.verify.entries()) {
      const log = path.join(runDir, `verify-${i + 1}-${slug(v.name)}.log`);
      const vop = this.store.intent('verify', { name: v.name, run: v.run, cwd: wt, log }, { entity: 'task', id, attempt: t.attempt });
      const vt0 = Date.now();
      const r = await runShell(v.run, wt, log, (v.timeout_minutes ?? 15) * 60000, this.abort.signal);
      this.store.result(vop, 'verify', { name: v.name, ok: r.ok, exit_code: r.exitCode, timed_out: r.timedOut, duration_ms: Date.now() - vt0, log }, { entity: 'task', id, attempt: t.attempt, severity: r.ok ? 'info' : 'warn' });
      out.verify.push({ name: v.name, run: v.run, exitCode: r.exitCode, ok: r.ok, timedOut: r.timedOut, log });
      if (!r.ok) {
        out.findings.push({ source: 'verify', severity: 'blocking', description: `Verification "${v.name}" (\`${v.run}\`) ${r.timedOut ? 'timed out' : `failed with exit code ${r.exitCode}`}. Output tail:\n${tailFile(log, 1500).trim()}`, log });
      }
    }
    out.ok = out.findings.length === 0;
    return out;
  }

  failRound(id, findings, reason) {
    const t = this.store.task(id);
    const pt = this.tasksById.get(id);
    const max = (pt.max_rework_rounds ?? this.factory.execution.max_rework_rounds) + t.extra_rounds;
    t.findings = findings;
    if (t.rework_rounds >= max) {
      return this.blockTask(id, `max rework rounds (${max}) exhausted: ${reason}`);
    }
    this.store.setTask(id, 'REWORK', `${reason}; rework round ${t.rework_rounds + 1}/${max}`, { rework_rounds: t.rework_rounds + 1, findings, activity: null }, 'warn');
  }

  evidenceText(ev) {
    if (!ev) return '(none)';
    const l = [`- Files changed: ${ev.changed.join(', ') || '(none)'}`, `- Write-scope check: ${ev.scope.ok ? 'OK' : `VIOLATIONS ${ev.scope.violations.join(', ')}`}`];
    for (const v of ev.verify) l.push(`- verify "${v.name}" (\`${v.run}\`): ${v.ok ? 'PASS (exit 0)' : `FAIL (exit ${v.exitCode})`}  log: ${v.log}`);
    if (!ev.verify.length) l.push('- No automated verify commands are configured for this task.');
    return l.join('\n');
  }

  async review(id) {
    const t = this.store.task(id);
    const pt = this.tasksById.get(id);
    const implementer = agentById(this.factory, t.implementer);
    let reviewer = null;
    const candidates = (pt.reviewer ? [pt.reviewer] : this.factory.roles.reviewers).map((rid) => agentById(this.factory, rid));
    for (;;) {
      if (this.stopRequested) return;
      reviewer = pickReviewer(this.factory, pt, implementer, this.agentLoad());
      if (reviewer) break;
      const anyIndependent = candidates.some((c) => pickReviewer(this.factory, { ...pt, reviewer: c.id }, implementer, {}));
      if (!anyIndependent) return this.blockTask(id, `no reviewer independent of ${implementer.id} (review_independence=${this.factory.execution.review_independence})`);
      await Promise.race([sleep(1000), this.wake.promise]);
    }
    const wt = t.worktree;
    for (let attemptNo = 1; attemptNo <= 2; attemptNo++) {
      t.reviewer = reviewer.id;
      t.activity = { kind: 'review', agent: reviewer.id, started_at: nowIso(), pid: null, fp: null };
      this.store.save();
      const runDir = path.join(this.paths.runs, slug(id), `attempt-${t.attempt}`, `review-${t.rework_rounds}-${attemptNo}`);
      mkdirp(runDir);
      const diff = G.diffAgainst(wt, t.base_ref, this.factory.verification.max_diff_bytes);
      const diffPath = path.join(runDir, 'diff.patch');
      atomicWrite(diffPath, diff.patch);
      const resultFile = path.join(runDir, 'review-result.json');
      const prev = t.review?.status === 'FAIL' ? `\n## Previous review found these issues — confirm each is truly fixed\n${this.findingsText(t.findings)}\n` : '';
      const brief = render(tpl('review-brief.md'), {
        task_id: id, title: pt.title, agent_id: reviewer.id, worktree: wt, branch: t.branch, base_branch: t.base_ref, goal: pt.goal,
        instruction_files: this.instructionFiles(), requirements_text: this.requirementsText(pt), criteria_text: numbered(pt.acceptance_criteria),
        criteria_json: JSON.stringify(pt.acceptance_criteria, null, 2), evidence_text: this.evidenceText(t.evidence),
        diff_stat: diff.stat.trim() || '(empty)', diff_path: diffPath, diff_note: diff.truncated ? '(truncated; read files directly)' : '', previous_findings: prev, result_file: resultFile,
      }, { what: 'review-brief' });
      const before = G.treeFingerprint(wt);
      const pend = t.pending_review;
      const adopt = attemptNo === 1 && pend && pend.tree_fp === before && pend.reviewer === reviewer.id && exists(pend.result_file);
      let res;
      if (adopt) {
        res = { status: 'SUCCEEDED', stdoutPath: pend.stdout, stderrPath: pend.stderr, adopted: true };
        this.store.emit('review_adopted', { entity: 'task', id, attempt: t.attempt, msg: `${id}: adopted review result left by the interrupted run (tree unchanged)`, data: { result_file: pend.result_file } });
      } else {
        const opId = this.store.intent('review', { reviewer: reviewer.id, cwd: wt, tree_fp: before, brief: path.join(runDir, 'brief.md'), brief_sha256: sha256(brief), result_file: resultFile, diff: diffPath }, { entity: 'task', id, attempt: t.attempt });
        t.pending_review = { reviewer: reviewer.id, tree_fp: before, result_file: resultFile, dir: runDir, op_id: opId, stdout: path.join(runDir, `${reviewer.id}.stdout.log`), stderr: path.join(runDir, `${reviewer.id}.stderr.log`) };
        this.store.save();
        res = await runAgent({
          agent: reviewer, prompt: brief, promptFile: path.join(runDir, 'brief.md'), cwd: wt, root: this.root, runDir,
          vars: { role: 'reviewer', task_id: id, attempt: t.attempt, result_file: resultFile },
          timeoutMs: (reviewer.timeout_minutes ?? this.factory.execution.review_timeout_minutes) * 60000,
          signal: this.abort.signal,
          onSpawn: (pid) => { t.activity.pid = pid; t.activity.fp = processFingerprint(pid); t.activity.op_id = opId; this.store.save(); },
        });
        this.store.result(opId, 'review_agent_run', {
          status: res.status, exit_code: res.exitCode, duration_ms: res.durationMs, argv: res.argv, stdout: res.stdoutPath, stderr: res.stderrPath, session_id: res.sessionId, artifacts: res.artifacts,
        }, { entity: 'task', id, attempt: t.attempt, severity: res.status === 'SUCCEEDED' ? 'info' : 'warn' });
      }
      if (this.stopRequested) return;
      t.activity = null;
      let problem = null;
      if (res.status === 'SPAWN_ERROR') return this.blockTask(id, `cannot start reviewer ${reviewer.id}: ${res.error}`);
      if (G.treeFingerprint(wt) !== before) {
        const touched = G.statusPorcelain(wt);
        this.store.emit('reviewer_modified_worktree', { severity: 'warn', entity: 'task', id, attempt: t.attempt, msg: `${id}: reviewer ${reviewer.id} modified the worktree; changes reverted and review discarded`, data: { reviewer: reviewer.id, status_porcelain: touched, diff: redact(G.git(wt, ['diff', 'HEAD'], { allowFail: true }).stdout.slice(0, 20000)) } });
        G.git(wt, ['reset', '--hard', 'HEAD']);
        G.git(wt, ['clean', '-fd']);
        problem = `reviewer ${reviewer.id} modified the worktree (reverted); review discarded`;
      } else if (res.status !== 'SUCCEEDED') problem = `reviewer run ${res.status}`;
      else {
        const read = readReviewResult(resultFile, res.stdoutPath);
        if (!read.result) problem = read.error;
        else {
          const errs = checkReviewResult(read.result, pt);
          if (errs.length) problem = `invalid review result: ${errs.slice(0, 3).join('; ')}`;
          else {
            const v = verdict(read.result, pt, t.evidence);
            atomicWrite(path.join(runDir, 'verdict.json'), JSON.stringify(v, null, 2));
            t.pending_review = null;
            this.store.emit('review_verdict', { entity: 'task', id, attempt: t.attempt, severity: v.pass ? 'info' : 'warn', msg: `${id}: review ${v.pass ? 'PASS' : 'FAIL'} by ${reviewer.id}`, data: { pass: v.pass, reasons: v.reasons, reviewer_status: read.result.status, summary: read.result.summary ?? '', findings: read.result.findings, criteria: read.result.criteria, result_file: resultFile } });
            t.review = { status: v.pass ? 'PASS' : 'FAIL', reviewer: reviewer.id, summary: read.result.summary ?? '', result: resultFile, at: nowIso() };
            if (v.pass) {
              t.findings = [];
              return this.store.setTask(id, 'PASS', `review PASS by ${reviewer.id}: ${read.result.summary ?? ''}`.trim(), { finished_at: nowIso() });
            }
            const findings = [
              ...v.reasons.map((r) => ({ source: 'review', severity: 'blocking', description: r })),
              ...read.result.findings.filter((f) => f.severity !== 'info').map((f) => ({ source: 'review', severity: f.severity, description: f.description + (f.file ? ` (${f.file})` : ''), required_fix: f.required_fix })),
            ];
            return this.failRound(id, findings, `review FAIL by ${reviewer.id}`);
          }
        }
      }
      this.store.emit('review_invalid', { severity: 'warn', entity: 'task', id, msg: `${id}: ${problem} (attempt ${attemptNo}/2)` });
    }
    this.blockTask(id, 'reviewer repeatedly failed to produce a valid result; inspect logs and re-run (unblock) or assign another reviewer');
  }

  // ------------------------------------------------------------------ integration, gates, milestones

  maybeIntegrate() {
    if (this.integration || this.stopRequested) return;
    const s = this.store.state;
    const next = this.taskOrder.find((id) => s.tasks[id].status === 'PASS' && s.milestones[s.tasks[id].milestone].status === 'ACTIVE');
    if (!next) return;
    this.integration = this.integrate(next)
      .catch((e) => this.blockTask(next, `integration error: ${e.message}`))
      .finally(() => { this.integration = null; this.poke(); });
  }

  async integrate(id) {
    const t = this.store.task(id);
    const pt = this.tasksById.get(id);
    const mrec = this.store.milestone(pt.milestone);
    const iw = mrec.integration_worktree && exists(mrec.integration_worktree) ? mrec.integration_worktree : this.ensureMilestoneBranch(pt.milestone);
    const pre = G.headSha(iw);
    const mop = this.store.intent('merge', { from: t.branch, into: mrec.branch, cwd: iw, pre_sha: pre }, { entity: 'task', id });
    const r = G.mergeNoFf(iw, t.branch, `Integrate ${id}: ${pt.title}`, this.author);
    this.store.result(mop, 'merge', { ok: r.ok, conflict: r.conflict ?? false, files: r.files ?? [], post_sha: r.ok ? G.headSha(iw) : null }, { entity: 'task', id, severity: r.ok ? 'info' : 'error' });
    if (!r.ok) {
      t.findings = [{ source: 'integration', severity: 'blocking', description: `Merge conflict integrating ${t.branch} into ${mrec.branch}${r.files?.length ? ` in: ${r.files.join(', ')}` : ''}. Merge ${mrec.branch} into the task branch and resolve.` }];
      return this.blockTask(id, `merge conflict integrating into ${mrec.branch}${r.files?.length ? ` (${r.files.join(', ')})` : ''}`);
    }
    const runDir = path.join(this.paths.runs, slug(id), 'integration');
    for (const [i, v] of pt.verify.entries()) {
      const log = path.join(runDir, `regress-${i + 1}-${slug(v.name)}.log`);
      const rop = this.store.intent('verify', { name: v.name, run: v.run, cwd: iw, log, phase: 'regression' }, { entity: 'task', id });
      const rr = await runShell(v.run, iw, log, (v.timeout_minutes ?? 15) * 60000, this.abort.signal);
      this.store.result(rop, 'verify', { name: v.name, ok: rr.ok, exit_code: rr.exitCode, log, phase: 'regression' }, { entity: 'task', id, severity: rr.ok ? 'info' : 'error' });
      if (!rr.ok) {
        G.resetHard(iw, pre);
        this.store.emit('git_op', { entity: 'task', id, severity: 'warn', msg: `${id}: merge reverted in ${mrec.branch} after regression`, data: { op: 'reset_hard', to: pre, cwd: iw } });
        t.findings = [{ source: 'integration', severity: 'blocking', description: `After merging into ${mrec.branch}, verification "${v.name}" failed (exit ${rr.exitCode}). Merge ${mrec.branch} into the task branch, fix the interaction, and re-run. Output tail:\n${tailFile(log, 1500).trim()}`, log }];
        return this.blockTask(id, `regression after integration: "${v.name}" failed on ${mrec.branch} (merge reverted)`);
      }
    }
    if (this.stopRequested) { G.resetHard(iw, pre); return; }
    G.updateRef(this.repo, `refs/sf/${this.store.state.run.id}/${slug(id)}/integrated`, G.headSha(iw));
    this.store.setTask(id, 'INTEGRATED', `merged into ${mrec.branch}`, { activity: null });
    if (this.factory.git.cleanup_after_integration && t.worktree && exists(t.worktree)) {
      try {
        if (G.isClean(t.worktree)) {
          const wtPath = t.worktree;
          G.worktreeRemove(this.repo, wtPath);
          t.worktree = null;
          this.store.save();
          this.store.emit('git_op', { entity: 'task', id, msg: `${id}: worktree removed after integration`, data: { op: 'worktree_remove', path: wtPath } });
        }
      } catch (e) {
        this.store.emit('cleanup_skipped', { severity: 'info', entity: 'task', id, msg: `${id}: worktree kept (${e.message})` });
      }
    }
  }

  maybeGate() {
    if (this.stopRequested) return;
    const s = this.store.state;
    for (const m of this.plan.milestones) {
      const rec = s.milestones[m.id];
      if (rec.status !== 'ACTIVE' || this.gates.has(m.id) || this.integration) continue;
      const mine = this.plan.tasks.filter((t) => t.milestone === m.id);
      if (!mine.every((t) => s.tasks[t.id].status === 'INTEGRATED')) continue;
      this.gates.add(m.id);
      this.store.setMilestone(m.id, 'GATE', `all ${mine.length} task(s) integrated; running milestone verification`);
      this.launch(`gate ${m.id}`, async () => {
        try {
          const iw = rec.integration_worktree && exists(rec.integration_worktree) ? rec.integration_worktree : this.ensureMilestoneBranch(m.id);
          const results = [];
          for (const [i, v] of m.verify.entries()) {
            const log = path.join(this.paths.runs, `milestone-${slug(m.id)}`, `gate-${i + 1}-${slug(v.name)}.log`);
            const gop = this.store.intent('verify', { name: v.name, run: v.run, cwd: iw, log, phase: 'milestone_gate' }, { entity: 'milestone', id: m.id });
            const rr = await runShell(v.run, iw, log, (v.timeout_minutes ?? 30) * 60000, this.abort.signal);
            this.store.result(gop, 'verify', { name: v.name, ok: rr.ok, exit_code: rr.exitCode, log, phase: 'milestone_gate' }, { entity: 'milestone', id: m.id, severity: rr.ok ? 'info' : 'error' });
            results.push({ name: v.name, run: v.run, ok: rr.ok, exitCode: rr.exitCode, log });
            if (!rr.ok) {
              rec.gate = { at: nowIso(), ok: false, results };
              return this.store.setMilestone(m.id, 'BLOCKED', `milestone verification "${v.name}" failed (exit ${rr.exitCode}); log ${log}`);
            }
          }
          if (this.stopRequested) return this.store.setMilestone(m.id, 'ACTIVE', 'gate interrupted by stop');
          rec.gate = { at: nowIso(), ok: true, results };
          if (this.factory.approvals.milestone_merge) {
            this.store.setMilestone(m.id, 'AWAITING_APPROVAL', `gate passed (${results.length} check(s)); branch ${rec.branch} awaits approval`);
          } else {
            await this.finalizeMilestone(m.id);
          }
        } finally {
          this.gates.delete(m.id);
        }
      });
    }
  }

  maybeFinalize() {
    const s = this.store.state;
    for (const [id, m] of Object.entries(s.milestones)) {
      if (m.status === 'AWAITING_APPROVAL' && m.approval === 'APPROVED' && !this.finalizing.has(id)) {
        this.finalizing.add(id);
        this.launch(`finalize ${id}`, () => this.finalizeMilestone(id).finally(() => this.finalizing.delete(id)));
      }
    }
  }

  async finalizeMilestone(id) {
    const rec = this.store.milestone(id);
    if (this.factory.git.milestone_merge === 'local') {
      const cur = G.currentBranch(this.repo);
      if (cur !== this.base) return this.store.setMilestone(id, 'BLOCKED', `local merge needs "${this.base}" checked out in ${this.repo} (currently "${cur}")`);
      if (!G.isCleanTracked(this.repo)) return this.store.setMilestone(id, 'BLOCKED', `local merge needs no uncommitted changes to tracked files in ${this.repo}`);
      const r = G.mergeNoFf(this.repo, rec.branch, `Milestone ${id}: ${this.milestonesById.get(id).title}`, this.author);
      this.store.emit('git_op', { entity: 'milestone', id, severity: r.ok ? 'info' : 'error', msg: `merge ${rec.branch} into ${this.base}: ${r.ok ? 'ok' : 'FAILED'}`, data: { op: 'merge', from: rec.branch, into: this.base, ok: r.ok, sha: r.ok ? G.headSha(this.repo) : null } });
      if (!r.ok) return this.store.setMilestone(id, 'BLOCKED', `merge of ${rec.branch} into ${this.base} failed: ${r.message}`);
      this.store.setMilestone(id, 'DONE', `${rec.branch} merged into ${this.base}`);
    } else {
      this.store.setMilestone(id, 'DONE', `${rec.branch} approved and ready; merge it into ${this.base} when you choose (git merge --no-ff ${rec.branch})`);
    }
    try {
      if (rec.integration_worktree && exists(rec.integration_worktree) && G.isClean(rec.integration_worktree)) {
        G.worktreeRemove(this.repo, rec.integration_worktree);
        rec.integration_worktree = null;
        this.store.save();
      }
    } catch { /* keep worktree */ }
  }
}

export function buildReport(state, plan) {
  const L = [`# Delivery report — ${state.project_id}`, '', `Run ${state.run.id}, started ${state.run.started_at}, updated ${state.updated_at}`, ''];
  const total = Object.keys(state.tasks).length;
  const integrated = Object.values(state.tasks).filter((t) => t.status === 'INTEGRATED').length;
  L.push(`**Tasks integrated:** ${integrated}/${total}`, '', '## Milestones');
  for (const m of plan.milestones) {
    const rec = state.milestones[m.id];
    L.push(`- **${m.id}** ${m.title}: ${rec.status}${rec.branch ? ` (branch \`${rec.branch}\`)` : ''}${rec.gate ? ` — gate ${rec.gate.ok ? 'passed' : 'FAILED'}` : ''}`);
    for (const g of rec.gate?.results ?? []) L.push(`  - gate check "${g.name}": ${g.ok ? 'PASS' : 'FAIL'}`);
  }
  L.push('', '## Tasks and evidence');
  for (const pt of plan.tasks) {
    const t = state.tasks[pt.id];
    L.push(`### ${pt.id}: ${pt.title} — ${t.status}`, `- Requirements: ${pt.requirements.join(', ') || '(none)'}`, `- Implementer: ${t.implementer ?? '-'}; reviewer: ${t.reviewer ?? '-'}; attempts: ${t.attempt}; rework rounds: ${t.rework_rounds}`);
    if (t.evidence) for (const v of t.evidence.verify) L.push(`- verify "${v.name}": ${v.ok ? 'PASS' : 'FAIL'} (log: ${v.log})`);
    if (t.review) L.push(`- Review: ${t.review.status} by ${t.review.reviewer} — ${t.review.summary}`);
    if (t.blocked_reason) L.push(`- **BLOCKED:** ${t.blocked_reason}`);
    L.push('');
  }
  const open = plan.tasks.filter((p) => state.tasks[p.id].status !== 'INTEGRATED');
  L.push('## Unresolved', open.length ? open.map((p) => `- ${p.id} (${state.tasks[p.id].status})`).join('\n') : 'None. All tasks integrated.');
  return L.join('\n') + '\n';
}

export { TASK_STATES, formatDuration, writeJson };
