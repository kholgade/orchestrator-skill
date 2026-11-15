// GENERATED COPY of sf-shared/lib — edit sf-shared/lib and run `npm run sync`.
// @ts-check
// Generic agent runner: executes any CLI agent described by a factory.yaml agent profile.
// No agent-specific logic lives here; everything comes from the profile (command, args, env, input).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SfError, mkdirp, nowIso, atomicWrite, redact } from './util.mjs';
import { render } from './template.mjs';
import { expandEnv } from './factory.mjs';

const MINIMAL_ENV = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA'];

/** Resolve an executable on PATH (handles Windows PATHEXT). Returns absolute path or null. */
export function resolveExecutable(cmd, env = process.env) {
  const isWin = process.platform === 'win32';
  const exts = isWin ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const candidates = [];
  if (cmd.includes('/') || cmd.includes('\\')) candidates.push(path.resolve(cmd));
  else for (const dir of (env.PATH ?? '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, cmd));
  for (const c of candidates) {
    for (const ext of exts) {
      const full = isWin && path.extname(c) ? c : c + ext;
      try {
        const st = fs.statSync(full);
        if (st.isFile() && (isWin || (st.mode & 0o111))) return full;
      } catch { /* continue */ }
    }
  }
  return null;
}

/** Build argv from the profile args (supports {if: var, args: [...]} conditionals). */
export function buildArgs(agent, vars) {
  const out = [];
  for (const item of agent.args ?? []) {
    if (typeof item === 'string') out.push(render(item, vars, { what: `agent ${agent.id} args` }));
    else if (vars[item.if]) for (const a of item.args) out.push(render(a, vars, { what: `agent ${agent.id} args` }));
  }
  if (vars.session_id && agent.resume_args) for (const a of agent.resume_args) out.push(render(a, vars, { what: `agent ${agent.id} resume_args` }));
  return out;
}

export function buildEnv(agent, extra) {
  /** @type {Record<string,string>} */
  let env = {};
  if (agent.env_inherit === false) {
    for (const k of MINIMAL_ENV) if (process.env[k] !== undefined) env[k] = /** @type {string} */ (process.env[k]);
  } else env = { ...process.env };
  for (const [k, v] of Object.entries(agent.env ?? {})) {
    const { value, missing } = expandEnv(v);
    if (missing.length) throw new SfError(`agent ${agent.id}: env ${k} references unset variable(s): ${missing.join(', ')}`, { code: 'ENV_MISSING' });
    env[k] = value;
  }
  return { ...env, ...extra };
}

export function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  }, 5000).unref();
}

function winQuote(a) {
  return `"${String(a).replace(/"/g, '""')}"`;
}

/**
 * Run one agent invocation.
 * @param {object} o
 * @param {any} o.agent         factory agent profile
 * @param {string} o.prompt     full prompt text (brief)
 * @param {string} o.promptFile where the prompt is persisted (also used by {{prompt_file}})
 * @param {string} o.cwd
 * @param {string} o.root
 * @param {string} o.runDir     directory for logs (stdout.log / stderr.log / meta.json)
 * @param {Record<string,string|number>} o.vars   extra template vars (role, task_id, attempt, result_file ...)
 * @param {number} o.timeoutMs
 * @param {AbortSignal} [o.signal]
 * @param {(pid:number)=>void} [o.onSpawn]
 */
export async function runAgent(o) {
  const { agent, prompt, promptFile, cwd, root, runDir, timeoutMs, signal } = o;
  mkdirp(runDir);
  atomicWrite(promptFile, prompt);
  const stdoutPath = path.join(runDir, `${agent.id}.stdout.log`);
  const stderrPath = path.join(runDir, `${agent.id}.stderr.log`);
  const resultFile = String(o.vars.result_file ?? path.join(runDir, 'result.json'));
  const vars = {
    role: '', task_id: '', attempt: 1, session_id: '',
    ...o.vars,
    agent_id: agent.id,
    model: agent.model ?? '',
    prompt,
    prompt_file: promptFile,
    prompt_pointer: `Read the file at ${promptFile} and carry out the instructions in it exactly. Treat that file as your complete task brief.`,
    cwd,
    root,
    run_dir: runDir,
    result_file: resultFile,
  };
  const startedAt = nowIso();
  const base = { agent_id: agent.id, startedAt, stdoutPath, stderrPath, promptFile, cwd };

  const exe = resolveExecutable(agent.command);
  if (!exe) {
    return { ...base, status: 'SPAWN_ERROR', exitCode: null, finishedAt: nowIso(), durationMs: 0, error: `command not found on PATH: ${agent.command}` };
  }
  const args = buildArgs(agent, vars);
  const env = buildEnv(agent, {
    SF_AGENT_ID: agent.id,
    SF_ROLE: String(vars.role),
    SF_TASK_ID: String(vars.task_id),
    SF_ATTEMPT: String(vars.attempt),
    SF_BRIEF_FILE: promptFile,
    SF_RESULT_FILE: resultFile,
    SF_RUN_DIR: runDir,
    SF_ROOT: root,
  });

  const outFd = fs.openSync(stdoutPath, 'w');
  const errFd = fs.openSync(stderrPath, 'w');
  const winShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe);
  let child;
  try {
    child = spawn(winShell ? winQuote(exe) : exe, winShell ? args.map(winQuote) : args, {
      cwd,
      env,
      stdio: [agent.input === 'stdin' ? 'pipe' : 'ignore', outFd, errFd],
      detached: process.platform !== 'win32',
      shell: winShell,
      windowsHide: true,
    });
  } catch (e) {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    return { ...base, status: 'SPAWN_ERROR', exitCode: null, finishedAt: nowIso(), durationMs: 0, error: e.message };
  }
  if (child.pid && o.onSpawn) o.onSpawn(child.pid);
  if (agent.input === 'stdin' && child.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  }

  const t0 = Date.now();
  return await new Promise((resolve) => {
    let timedOut = false;
    let cancelled = false;
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs) : null;
    const onAbort = () => { cancelled = true; killTree(child); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const finish = (exitCode, sig, error) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { fs.closeSync(outFd); } catch { /* closed */ }
      try { fs.closeSync(errFd); } catch { /* closed */ }
      const ok = (agent.success_exit_codes ?? [0]).includes(exitCode);
      const status = cancelled ? 'CANCELLED' : timedOut ? 'TIMED_OUT' : error ? 'SPAWN_ERROR' : ok ? 'SUCCEEDED' : 'FAILED';
      const argv = [exe, ...args.map((a) => (a === prompt ? '<prompt>' : a.includes(prompt) ? a.split(prompt).join('<prompt>') : redact(a)))];
      const res = {
        ...base, status, exitCode, signal: sig ?? null, finishedAt: nowIso(), durationMs: Date.now() - t0, pid: child.pid, error: error ? redact(error) : undefined,
        argv, briefSha256: crypto.createHash('sha256').update(prompt).digest('hex'), resumed: Boolean(vars.session_id),
        sessionId: extractSessionId(agent, stdoutPath, stderrPath),
        artifacts: (() => { try { return collectArtifacts(agent, vars); } catch (e) { return [{ error: e.message }]; } })(),
      };
      try { fs.writeFileSync(path.join(runDir, `${agent.id}.meta.json`), JSON.stringify(res, null, 2)); } catch { /* best effort */ }
      resolve(res);
    };
    child.on('error', (e) => finish(null, null, e.message));
    child.on('close', (code, sig) => finish(code, sig, undefined));
  });
}

function hashFile(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

/** Record files an agent produced (session transcripts, JSON logs…) named by profile `artifacts` templates. */
export function collectArtifacts(agent, vars) {
  const out = [];
  for (const tplText of agent.artifacts ?? []) {
    const p = render(tplText, vars, { what: `agent ${agent.id} artifacts` });
    try {
      const st = fs.statSync(p);
      if (st.isFile()) out.push({ path: p, kind: 'file', size: st.size, sha256: hashFile(p) });
      else {
        const files = [];
        const walk = (d) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) walk(full);
            else if (files.length < 500) files.push({ path: full, size: fs.statSync(full).size, sha256: hashFile(full) });
          }
        };
        walk(p);
        out.push({ path: p, kind: 'dir', files });
      }
    } catch {
      out.push({ path: p, kind: 'missing' });
    }
  }
  return out;
}

export function extractSessionId(agent, ...logs) {
  if (!agent.session_id_regex) return null;
  const re = new RegExp(agent.session_id_regex);
  for (const log of logs) {
    const m = re.exec(tailFile(log, 200000));
    if (m?.[1]) return m[1];
  }
  return null;
}

/** Last `n` characters of a log file ('' when absent). */
export function tailFile(file, n = 4000) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.length > n ? text.slice(-n) : text;
  } catch {
    return '';
  }
}
