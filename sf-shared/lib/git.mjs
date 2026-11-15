// @ts-check
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SfError, toPosix, sha256 } from './util.mjs';

/**
 * Run git. Returns {code, stdout, stderr}. Throws SfError unless allowFail.
 * @param {string} cwd
 * @param {string[]} args
 */
export function git(cwd, args, { allowFail = false, env = {}, input } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    input,
  });
  if (r.error) throw new SfError(`git not runnable: ${r.error.message}`, { code: 'NO_GIT' });
  const res = { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  if (res.code !== 0 && !allowFail) {
    throw new SfError(`git ${args.slice(0, 3).join(' ')} failed: ${res.stderr.trim() || res.stdout.trim()}`, { code: 'GIT_FAILED', details: { cwd, args } });
  }
  return res;
}

const out = (cwd, args) => git(cwd, args).stdout.trim();

export function isRepo(dir) {
  return git(dir, ['rev-parse', '--is-inside-work-tree'], { allowFail: true }).stdout.trim() === 'true';
}
export function repoTop(dir) {
  return path.resolve(out(dir, ['rev-parse', '--show-toplevel']));
}
export function currentBranch(dir) {
  return out(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
}
export function headSha(dir) {
  return out(dir, ['rev-parse', 'HEAD']);
}
export function hasCommits(dir) {
  return git(dir, ['rev-parse', '--verify', 'HEAD'], { allowFail: true }).code === 0;
}
export function branchExists(dir, name) {
  return git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { allowFail: true }).code === 0;
}
export function isClean(dir) {
  return out(dir, ['status', '--porcelain']) === '';
}
export function isCleanTracked(dir) {
  return out(dir, ['status', '--porcelain', '--untracked-files=no']) === '';
}
export function statusPorcelain(dir) {
  return out(dir, ['status', '--porcelain']);
}
export function isAncestor(dir, a, b) {
  return git(dir, ['merge-base', '--is-ancestor', a, b], { allowFail: true }).code === 0;
}

export function worktreeAdd(repo, wtPath, branch, base) {
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  if (fs.existsSync(wtPath)) throw new SfError(`Worktree path already exists: ${wtPath}`);
  if (branchExists(repo, branch)) git(repo, ['worktree', 'add', wtPath, branch]);
  else git(repo, ['worktree', 'add', '-b', branch, wtPath, base]);
}

export function updateRef(dir, ref, sha) {
  git(dir, ['update-ref', ref, sha]);
}
export function refSha(dir, ref) {
  const r = git(dir, ['rev-parse', '--verify', '--quiet', ref], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}
export function commitsAhead(dir, base, head = 'HEAD') {
  const r = git(dir, ['rev-list', '--count', `${base}..${head}`], { allowFail: true });
  return r.code === 0 ? Number(r.stdout.trim()) : null;
}
export function listBranches(dir, prefix = '') {
  return out(dir, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}`]).split('\n').filter(Boolean);
}
export function branchRename(dir, from, to) {
  git(dir, ['branch', '-m', from, to]);
}
export function branchDelete(dir, name) {
  git(dir, ['branch', '-D', name]);
}
export function worktreeMove(repo, from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  git(repo, ['worktree', 'move', from, to]);
}

export function worktreeRemove(repo, wtPath, { force = false } = {}) {
  git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), wtPath]);
}

export function worktreePrune(repo) {
  git(repo, ['worktree', 'prune'], { allowFail: true });
}

export function worktreeList(repo) {
  const text = out(repo, ['worktree', 'list', '--porcelain']);
  return text
    .split(/\n\n/)
    .map((b) => Object.fromEntries(b.split('\n').map((l) => [l.split(' ')[0], l.split(' ').slice(1).join(' ')])))
    .filter((x) => x.worktree);
}

function identityArgs(author) {
  return ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, '-c', 'commit.gpgsign=false'];
}

/** Stage and commit everything. Returns sha or null when nothing to commit. */
export function commitAll(dir, message, author) {
  git(dir, ['add', '-A']);
  if (out(dir, ['status', '--porcelain']) === '') return null;
  git(dir, [...identityArgs(author), 'commit', '-m', message, '--no-verify']);
  return headSha(dir);
}

/** Merge branch with --no-ff. Returns {ok, conflict, message}. On conflict the merge is aborted. */
export function mergeNoFf(dir, branch, message, author) {
  const r = git(dir, [...identityArgs(author), 'merge', '--no-ff', '-m', message, branch], { allowFail: true });
  if (r.code === 0) return { ok: true, conflict: false, message: r.stdout.trim() };
  const conflicted = out(dir, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
  git(dir, ['merge', '--abort'], { allowFail: true });
  return { ok: false, conflict: conflicted.length > 0, files: conflicted, message: (r.stderr || r.stdout).trim() };
}

export function resetHard(dir, sha) {
  git(dir, ['reset', '--hard', sha]);
}

/** Files changed in `dir` relative to `base` (committed + staged + unstaged + untracked), posix paths. */
export function changedFiles(dir, base) {
  const set = new Set();
  const add = (text) => text.split('\n').filter(Boolean).forEach((f) => set.add(toPosix(f)));
  add(out(dir, ['diff', '--name-only', `${base}...HEAD`]));
  add(out(dir, ['diff', '--name-only', 'HEAD']));
  add(out(dir, ['ls-files', '--others', '--exclude-standard']));
  return [...set].sort();
}

export function diffAgainst(dir, base, maxBytes = 200000) {
  const patch = git(dir, ['diff', `${base}...HEAD`, '--no-color'], { allowFail: true }).stdout;
  const stat = git(dir, ['diff', '--stat', `${base}...HEAD`, '--no-color'], { allowFail: true }).stdout;
  const truncated = patch.length > maxBytes;
  return { patch: truncated ? patch.slice(0, maxBytes) + '\n[... diff truncated ...]\n' : patch, stat, truncated };
}

/** Fingerprint of the working tree state (used to prove a reviewer did not modify files). */
export function treeFingerprint(dir) {
  const status = out(dir, ['status', '--porcelain']);
  const head = headSha(dir);
  const diff = git(dir, ['diff', 'HEAD'], { allowFail: true }).stdout;
  return sha256(`${head}\n${status}\n${diff}`);
}

// ------------------------------------------------------------------ scope matching

function segs(p) {
  return toPosix(p).replace(/\/+$/, '').split('/').filter((s) => s !== '' && s !== '.');
}

/** Static (non-wildcard) leading path segments of a scope. */
export function scopePrefix(scope) {
  const out2 = [];
  for (const s of segs(scope)) {
    if (/[*?[]/.test(s)) break;
    out2.push(s);
  }
  return out2;
}

export function scopesOverlap(a, b) {
  const pa = scopePrefix(a);
  const pb = scopePrefix(b);
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) if (pa[i] !== pb[i]) return false;
  return true;
}

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') i++;
        re += '(?:.*/)?';
        if (i + 1 >= glob.length) re = re.replace(/\(\?:\.\*\/\)\?$/, '.*');
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|\\[\]]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Returns fn(relPath) → true when the path is inside any scope. A plain path scope covers its subtree. */
export function scopeMatcher(scopes) {
  const compiled = scopes.map((s) => {
    const norm = toPosix(s).replace(/\/+$/, '');
    if (norm === '' || norm === '.') return () => true;
    if (!/[*?]/.test(norm)) return (p) => p === norm || p.startsWith(norm + '/');
    const re = globToRegex(norm);
    return (p) => re.test(p);
  });
  return (p) => compiled.some((fn) => fn(toPosix(p)));
}
