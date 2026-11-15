// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs as nodeParseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

export class SfError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, details?: any, exitCode?: number}} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'SfError';
    this.code = opts.code ?? 'SF_ERROR';
    this.details = opts.details;
    this.exitCode = opts.exitCode ?? 1;
  }
}

export const nowIso = () => new Date().toISOString();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new SfError(`File not found: ${file}`, { code: 'ENOENT' });
    throw e;
  }
}

export function exists(file) {
  return fs.existsSync(file);
}

export function atomicWrite(file, content) {
  mkdirp(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function writeJson(file, value) {
  atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
}

export function readJson(file) {
  const text = readText(file);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new SfError(`Invalid JSON in ${file}: ${e.message}`, { code: 'BAD_JSON' });
  }
}

export function appendLine(file, line) {
  mkdirp(path.dirname(file));
  fs.appendFileSync(file, line.endsWith('\n') ? line : line + '\n');
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Convert a path to forward slashes and strip a leading "./". */
export function toPosix(p) {
  let s = String(p).replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

export function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[m][n];
}

export function closest(word, candidates) {
  let best = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(word, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best !== null && bestDist <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

/**
 * Strict CLI parsing. spec = { options: {name: {type, short?, multiple?}}, positionals?: true }
 */
export function parseArgs(argv, options = {}, { allowPositionals = true } = {}) {
  try {
    const { values, positionals } = nodeParseArgs({ args: argv, options, allowPositionals, strict: true });
    return { values, positionals };
  } catch (e) {
    throw new SfError(e.message, { code: 'USAGE', exitCode: 2 });
  }
}

/** Locate the project root: explicit, else nearest ancestor with .sf/, else git toplevel, else cwd. */
export function findRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, '.sf'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function sfPaths(root, overrides = {}) {
  const sfDir = path.join(root, '.sf');
  const runtime = path.join(sfDir, 'runtime');
  return {
    root,
    sfDir,
    factory: path.join(sfDir, 'factory.yaml'),
    spec: path.resolve(root, overrides.spec ?? '.sf/spec.md'),
    specIndex: path.join(sfDir, 'spec.index.json'),
    plan: path.resolve(root, overrides.plan ?? '.sf/plan.yaml'),
    runtime,
    state: path.join(runtime, 'state.json'),
    events: path.join(runtime, 'events.jsonl'),
    status: path.join(runtime, 'status.md'),
    lock: path.join(runtime, 'supervisor.lock'),
    inbox: path.join(runtime, 'inbox'),
    ledger: path.join(sfDir, 'ledger.jsonl'),
    archive: path.join(sfDir, 'archive'),
    drafts: path.join(sfDir, 'drafts'),
    stateLock: path.join(runtime, 'state.lock'),
    runs: path.join(runtime, 'runs'),
    doctor: path.join(runtime, 'doctor.json'),
    supervisorLog: path.join(runtime, 'supervisor.log'),
  };
}

/** Run a CLI main() with uniform error handling. */
export async function cliMain(main) {
  try {
    const code = await main();
    process.exitCode = typeof code === 'number' ? code : 0;
  } catch (e) {
    if (e instanceof SfError) {
      process.stderr.write(`ERROR: ${e.message}\n`);
      if (e.details) {
        const lines = Array.isArray(e.details) ? e.details : [e.details];
        for (const l of lines) process.stderr.write(`  - ${typeof l === 'string' ? l : JSON.stringify(l)}\n`);
      }
      process.exitCode = e.exitCode;
    } else {
      process.stderr.write(`FATAL: ${e?.stack ?? e}\n`);
      process.exitCode = 70;
    }
  }
}

export function printJson(v) {
  process.stdout.write(JSON.stringify(v, null, 2) + '\n');
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

// ---------------------------------------------------------------- redaction

const SECRET_NAME = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|WEBHOOK|AUTH|CREDENTIAL)/i;

export function secretValues(env = process.env) {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_NAME.test(k) && typeof v === 'string' && v.length >= 8)
    .map(([, v]) => v)
    .sort((a, b) => b.length - a.length);
}

/** Remove secrets (env-secret values, URL credentials, bot tokens, bearer tokens, common key shapes) from text. */
export function redact(input, extra = []) {
  let s = String(input);
  for (const v of [...secretValues(), ...extra]) s = s.split(v).join('[REDACTED]');
  s = s.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[REDACTED]@');
  s = s.replace(/bot\d{6,}:[A-Za-z0-9_-]{20,}/g, 'bot[REDACTED]');
  s = s.replace(/\b(?:sk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{20,}\b/g, '[REDACTED]');
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1[REDACTED]');
  return s;
}

export function redactDeep(v) {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}

// ---------------------------------------------------------------- process identity

/** Opaque identity string for a pid (start time). null when it cannot be determined. */
export function processFingerprint(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      const t = (r.stdout ?? '').trim();
      return r.status === 0 && t ? `win:${t}` : null;
    }
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
    const t = (r.stdout ?? '').trim();
    return r.status === 0 && t ? `ps:${t}` : null;
  } catch {
    return null;
  }
}

/** True only when pid is alive AND its fingerprint equals the recorded one (guards against pid reuse). */
export function sameProcess(pid, fp) {
  if (!isPidAlive(pid)) return false;
  if (!fp) return false;
  return processFingerprint(pid) === fp;
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
