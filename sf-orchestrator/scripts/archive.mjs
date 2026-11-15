// Non-destructive run archiving: move run data and worktrees under .sf/archive/<run-id>, rename (never delete)
// branches to archive/<run-id>/..., and record everything in a manifest. Deleting is a separate, confirmed step.
import fs from 'node:fs';
import path from 'node:path';
import { SfError, nowIso, exists, readJson, writeJson, mkdirp, slug, atomicWrite } from './lib/util.mjs';
import { softFactory } from './lib/factory.mjs';
import { Store, supervisorAlive, withStateLock, newTaskRecord } from './lib/state.mjs';
import { ledgerAppend } from './lib/journal.mjs';
import { loadPlanRaw } from './lib/plan.mjs';
import { SF_VERSION } from './lib/version.mjs';
import * as G from './lib/git.mjs';

const RUNTIME_FILES = ['state.json', 'events.jsonl', 'status.md', 'notifications.log', 'report.md', 'supervisor.log'];

function ensureGitignore(paths) {
  const f = path.join(paths.sfDir, '.gitignore');
  const want = ['runtime/', 'archive/'];
  const have = exists(f) ? fs.readFileSync(f, 'utf8').split('\n').map((l) => l.trim()) : [];
  const missing = want.filter((w) => !have.includes(w));
  if (missing.length) atomicWrite(f, [...have.filter(Boolean), ...missing].join('\n') + '\n');
}

const archiveBranchName = (runId, name) => `archive/${runId}/${name}`;

function moveWorktree(root, from, to, record) {
  try {
    const dirty = exists(from) ? !G.isClean(from) : null;
    G.worktreeMove(root, from, to);
    record.push({ from, to, dirty, ok: true });
  } catch (e) {
    record.push({ from, to, ok: false, error: e.message });
  }
}

export function listRuns(root) {
  const { paths } = softFactory(root);
  const out = [];
  if (Store.exists(paths)) {
    const s = readJson(paths.state);
    out.push({ run_id: s.run.id, active: true, started_at: s.run.started_at, sf_version: s.sf_version ?? null, supervisor_alive: supervisorAlive(paths), stop_reason: s.run.stop_reason ?? null });
  }
  if (exists(paths.archive)) {
    for (const d of fs.readdirSync(paths.archive).sort()) {
      const mf = path.join(paths.archive, d, 'manifest.json');
      if (exists(mf)) {
        const m = readJson(mf);
        out.push({ run_id: d, active: false, archived_at: m.archived_at, reason: m.reason, archived_by: m.actor, task_summary: m.task_summary, pruned: Boolean(m.pruned_at) });
      }
    }
  }
  return out;
}

export function archiveRun(root, { reason, who }) {
  const { factory, paths } = softFactory(root);
  if (!factory) throw new SfError('factory.yaml is required to archive (need git.worktree_root and branch prefixes)');
  if (supervisorAlive(paths)) throw new SfError('A supervisor is running; stop it first (sf.mjs stop).', { code: 'LOCKED' });
  return withStateLock(paths, () => {
    if (!Store.exists(paths)) throw new SfError('No run state to archive.');
    const state = readJson(paths.state);
    const runId = state.run.id;
    let archiveId = runId;
    for (let n = 1; exists(path.join(paths.archive, archiveId)); ) archiveId = `${runId}.${++n}`;
    const dest = path.join(paths.archive, archiveId);
    mkdirp(dest);
    const wtRoot = path.resolve(root, factory.git.worktree_root);
    const moved = [];
    G.worktreePrune(root);
    const attached = new Set();
    for (const w of G.worktreeList(root)) {
      const p = path.resolve(w.worktree);
      if (p.startsWith(wtRoot + path.sep)) {
        if (w.branch) attached.add(w.branch.replace(/^refs\/heads\//, ''));
        moveWorktree(root, p, path.join(dest, 'worktrees', path.relative(wtRoot, p)), moved);
      }
    }
    // branches known to the state PLUS any branch attached to an sf worktree (covers a crash between "worktree add" and "state save")
    const names = new Set([...Object.values(state.tasks).map((t) => t.branch), ...Object.values(state.milestones).map((m) => m.branch), ...attached].filter(Boolean));
    const branches = [];
    for (const b of names) {
      if (!G.branchExists(root, b)) continue;
      const to = archiveBranchName(runId, b);
      try { G.branchRename(root, b, to); branches.push({ from: b, to, ok: true }); } catch (e) { branches.push({ from: b, to, ok: false, error: e.message }); }
    }
    for (const f of RUNTIME_FILES) if (exists(path.join(paths.runtime, f))) fs.renameSync(path.join(paths.runtime, f), path.join(dest, f));
    if (exists(paths.runs)) fs.renameSync(paths.runs, path.join(dest, 'runs'));
    if (exists(paths.inbox)) fs.rmSync(paths.inbox, { recursive: true, force: true });
    const pinRefs = G.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', `refs/sf/${runId}/`], { allowFail: true }).stdout.split('\n').filter(Boolean);
    const taskSummary = {};
    for (const t of Object.values(state.tasks)) taskSummary[t.status] = (taskSummary[t.status] ?? 0) + 1;
    const manifest = {
      run_id: runId, archive_id: archiveId, archived_at: nowIso(), reason: reason ?? null, actor: who, sf_version: SF_VERSION, run_sf_version: state.sf_version ?? null,
      task_summary: taskSummary, worktrees: moved, branches, pin_refs: pinRefs,
      delete_candidates: {
        note: 'Nothing has been deleted. Ask the user before pruning: `sf.mjs archive prune <run-id>` (worktrees + archived branches); add --logs to also remove logs.',
        worktrees: moved.filter((m) => m.ok).map((m) => ({ path: m.to, dirty: m.dirty })),
        branches: branches.filter((b) => b.ok).map((b) => b.to),
        logs: dest,
      },
    };
    writeJson(path.join(dest, 'manifest.json'), manifest);
    ensureGitignore(paths);
    ledgerAppend(paths, 'run_archived', { actor: who?.confirmed_by ?? 'user', msg: `run ${runId} archived`, data: { run_id: runId, reason: reason ?? null, who, archive: dest, worktrees: moved.length, branches: branches.length } });
    return manifest;
  });
}

export function restoreRun(root, runId, { who }) {
  const { factory, paths } = softFactory(root);
  if (supervisorAlive(paths)) throw new SfError('A supervisor is running; only one run may be active.', { code: 'LOCKED' });
  return withStateLock(paths, () => {
    if (Store.exists(paths)) throw new SfError('A run is already active in this project. Archive it first (resume --decision reset-run); only one run may be active at a time.', { code: 'RUN_ACTIVE' });
    const dest = path.join(paths.archive, runId);
    const mfFile = path.join(dest, 'manifest.json');
    if (!exists(mfFile)) throw new SfError(`No archived run "${runId}". Known: ${listRuns(root).filter((r) => !r.active).map((r) => r.run_id).join(', ') || '(none)'}`);
    const m = readJson(mfFile);
    if (m.pruned_at) throw new SfError(`Run ${runId} was pruned (${m.pruned_at}); worktrees/branches no longer exist, it cannot be restored.`);
    const problems = [];
    for (const w of m.worktrees.filter((x) => x.ok)) if (exists(w.from)) problems.push(`path already exists: ${w.from}`);
    for (const b of m.branches.filter((x) => x.ok)) if (G.branchExists(root, b.from)) problems.push(`branch already exists: ${b.from}`);
    if (problems.length) throw new SfError('Cannot restore: names are in use', { details: problems });
    for (const b of m.branches.filter((x) => x.ok)) G.branchRename(root, b.to, b.from);
    for (const w of m.worktrees.filter((x) => x.ok)) G.worktreeMove(root, w.to, w.from);
    mkdirp(paths.runtime);
    for (const f of RUNTIME_FILES) if (exists(path.join(dest, f))) fs.renameSync(path.join(dest, f), path.join(paths.runtime, f));
    if (exists(path.join(dest, 'runs'))) fs.renameSync(path.join(dest, 'runs'), paths.runs);
    m.restored_at = nowIso();
    writeJson(mfFile, m);
    ledgerAppend(paths, 'run_restored', { actor: who?.confirmed_by ?? 'user', msg: `run ${runId} restored`, data: { run_id: runId, who } });
    void factory;
    return m;
  });
}

/** Archive one task's worktree+branch and reset its record to PLANNED (not for INTEGRATED tasks). */
export function resetTask(root, taskId, { reason, who }) {
  const { factory, paths } = softFactory(root);
  if (supervisorAlive(paths)) throw new SfError('A supervisor is running; stop it first.', { code: 'LOCKED' });
  return withStateLock(paths, () => {
    const store = new Store(paths, { actor: who?.confirmed_by ?? 'user' });
    store.load();
    const t = store.task(taskId);
    if (t.status === 'INTEGRATED') throw new SfError(`${taskId} is INTEGRATED; its work is already merged into the milestone branch and cannot be reset safely.`);
    const plan = loadPlanRaw(paths.plan);
    const pt = plan.tasks.find((x) => x.id === taskId);
    if (!pt) throw new SfError(`${taskId} is not in the plan`);
    const runId = store.state.run.id;
    const n = (t.reset_count ?? 0) + 1;
    const dest = path.join(paths.archive, runId, 'tasks', `${slug(taskId)}-${n}`);
    mkdirp(dest);
    const moved = [];
    const wtPath = t.worktree ?? path.join(path.resolve(root, factory.git.worktree_root), slug(t.milestone), slug(taskId));
    let attachedBranch = null;
    if (exists(wtPath)) {
      attachedBranch = G.git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }).stdout.trim() || null;
      moveWorktree(root, wtPath, path.join(dest, 'worktree'), moved);
    }
    const branches = [];
    const branchName = t.branch ?? attachedBranch;
    if (branchName && branchName !== 'HEAD' && G.branchExists(root, branchName)) {
      const to = `${archiveBranchName(runId, branchName)}-${n}`;
      try { G.branchRename(root, branchName, to); branches.push({ from: branchName, to, ok: true }); } catch (e) { branches.push({ from: branchName, to, ok: false, error: e.message }); }
    }
    const fresh = newTaskRecord(pt);
    fresh.reset_count = n;
    const prevStatus = t.status;
    store.state.tasks[taskId] = fresh;
    store.save();
    store.emit('task_reset', { severity: 'warn', entity: 'task', id: taskId, actor: who?.confirmed_by ?? 'user', msg: `${taskId} reset from ${prevStatus}; work archived`, data: { who, reason: reason ?? null, archive: dest, worktrees: moved, branches } });
    writeJson(path.join(dest, 'reset.json'), { task: taskId, previous: t, who, reason: reason ?? null, at: nowIso(), worktrees: moved, branches });
    ensureGitignore(paths);
    ledgerAppend(paths, 'task_reset', { actor: who?.confirmed_by ?? 'user', msg: `${taskId} reset`, data: { run_id: runId, task: taskId, previous_status: prevStatus, who, reason: reason ?? null, archive: dest } });
    void factory;
    return { task: taskId, archive: dest, worktrees: moved, branches };
  });
}

/** Permanently remove an archived run's worktrees and archive branches (and optionally logs). Caller must have confirmation. */
export function pruneArchive(root, runId, { logs = false, who }) {
  const { paths } = softFactory(root);
  const dest = path.join(paths.archive, runId);
  const mfFile = path.join(dest, 'manifest.json');
  if (!exists(mfFile)) throw new SfError(`No archived run "${runId}"`);
  const m = readJson(mfFile);
  const removed = { worktrees: [], branches: [], logs: false };
  for (const w of m.worktrees.filter((x) => x.ok)) {
    if (!exists(w.to)) continue;
    try { G.worktreeRemove(root, w.to, { force: true }); removed.worktrees.push(w.to); } catch (e) { removed.worktrees.push(`${w.to} (failed: ${e.message})`); }
  }
  for (const b of m.branches.filter((x) => x.ok)) {
    if (G.branchExists(root, b.to)) { try { G.branchDelete(root, b.to); removed.branches.push(b.to); } catch { /* keep */ } }
  }
  G.worktreePrune(root);
  m.pruned_at = nowIso();
  m.pruned_by = who;
  writeJson(mfFile, m);
  if (logs) {
    for (const f of fs.readdirSync(dest)) if (f !== 'manifest.json') fs.rmSync(path.join(dest, f), { recursive: true, force: true });
    removed.logs = true;
  }
  ledgerAppend(paths, 'archive_pruned', { actor: who?.confirmed_by ?? 'user', msg: `archive ${runId} pruned`, data: { run_id: runId, who, removed } });
  return removed;
}

export function describeArchive(root, runId) {
  const { paths } = softFactory(root);
  const mf = path.join(paths.archive, runId, 'manifest.json');
  if (!exists(mf)) throw new SfError(`No archived run "${runId}"`);
  return readJson(mf);
}
