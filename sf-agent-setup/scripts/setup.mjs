#!/usr/bin/env node
// sf-agent-setup: probe agent CLIs, scaffold/validate .sf/factory.yaml, smoke-test every configured agent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cliMain, parseArgs, findRoot, sfPaths, printJson, SfError, exists, atomicWrite, mkdirp, readText, writeJson, readJson, nowIso } from './lib/util.mjs';
import { loadFactory, lintFactory } from './lib/factory.mjs';
import { resolveExecutable, runAgent, tailFile } from './lib/runner.mjs';
import { git } from './lib/git.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OPTS = {
  root: { type: 'string' },
  json: { type: 'boolean' },
  agent: { type: 'string' },
  all: { type: 'boolean' },
  force: { type: 'boolean' },
  timeout: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const USAGE = `sf-agent-setup — configure which coding agents play which roles

Usage: node setup.mjs <command> [options]
  init                 create .sf/ and a commented factory.yaml template (never overwrites without --force)
  probe <command>      inspect an agent CLI: location, --version, --help excerpt (JSON)
  validate             strictly validate .sf/factory.yaml (schema + semantics + executables on PATH)
  show                 print roles → agents summary
  doctor [--agent id|--all]   run a real smoke-test prompt through each configured agent
  check                machine-readable readiness for other sf-* skills (exit 0 = ready)
Options: --root <dir>  --json  --timeout <seconds>  --force`;

function probe(command) {
  const exe = resolveExecutable(command);
  if (!exe) return { command, found: false };
  const run = (args) => {
    const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 15000, windowsHide: true, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe) });
    return { args, exitCode: r.status, timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT'), output: ((r.stdout ?? '') + (r.stderr ?? '')).trim() };
  };
  const version = run(['--version']);
  const help = run(['--help']);
  return {
    command,
    found: true,
    path: exe,
    version: version.output.split('\n')[0] ?? '',
    help_excerpt: help.output.split('\n').slice(0, 120).join('\n'),
    notes: 'Use the help excerpt to find: the non-interactive/headless flag, how a prompt is passed (argument, stdin, file), the model flag, and the flag that allows file edits without prompting. Then run "doctor".',
  };
}

function cmdInit(root, force) {
  const p = sfPaths(root);
  mkdirp(p.sfDir);
  atomicWrite(path.join(p.sfDir, '.gitignore'), 'runtime/\narchive/\n');
  if (exists(p.factory) && !force) {
    console.log(`${p.factory} already exists (left untouched; use --force to overwrite).`);
  } else {
    const tpl = readText(path.join(here, '..', 'templates', 'factory.template.yaml'));
    atomicWrite(p.factory, tpl);
    console.log(`Wrote template ${p.factory}. Edit it (or let the setup interview fill it in), then run: validate && doctor --all`);
  }
  if (git(root, ['rev-parse', '--is-inside-work-tree'], { allowFail: true }).stdout.trim() !== 'true') {
    console.log('NOTE: this directory is not a git repository. The orchestrator needs git (worktrees). Run "git init" and make an initial commit before orchestrating.');
  }
}

function cmdValidate(root, json) {
  const { factory, warnings } = loadFactory(root);
  const extra = [...warnings];
  for (const a of factory.agents) {
    if (a.enabled === false) continue;
    if (!resolveExecutable(a.command)) extra.push(`agent "${a.id}": command "${a.command}" not found on PATH`);
  }
  const doctor = exists(sfPaths(root).doctor) ? readJson(sfPaths(root).doctor) : { agents: {} };
  const unverified = factory.agents.filter((a) => a.enabled !== false && !doctor.agents?.[a.id]?.ok).map((a) => a.id);
  if (json) printJson({ valid: true, warnings: extra, unverified_agents: unverified });
  else {
    console.log('factory.yaml is valid.');
    for (const w of extra) console.log(`WARN: ${w}`);
    if (unverified.length) console.log(`Not yet verified by "doctor": ${unverified.join(', ')}`);
  }
}

function cmdShow(root) {
  const { factory } = loadFactory(root);
  const r = factory.roles;
  console.log(`project:        ${factory.project.id}`);
  console.log(`orchestrator:   ${r.orchestrator ?? '(the interactive session)'}`);
  console.log(`spec author:    ${r.spec_author}`);
  console.log(`planner:        ${r.planner}`);
  console.log(`implementers:   ${r.implementers.join(', ')}`);
  console.log(`reviewers:      ${r.reviewers.join(', ')}`);
  console.log(`independence:   ${factory.execution.review_independence}; parallel tasks: ${factory.execution.max_parallel_tasks}; rework rounds: ${factory.execution.max_rework_rounds}`);
  console.log(`notify:         every ${factory.notify.interval_minutes} min → ${factory.notify.channels.map((c) => c.type + (c.preset ? `:${c.preset}` : '')).join(', ')}`);
  for (const a of factory.agents) console.log(`  agent ${a.id}: ${a.command} ${a.model ? `(model ${a.model})` : ''} caps=[${a.capabilities.join(',')}] ${a.enabled === false ? 'DISABLED' : ''}`);
}

async function cmdDoctor(root, values) {
  const { factory } = loadFactory(root);
  const p = sfPaths(root);
  const wanted = values.agent ? [values.agent] : factory.agents.filter((a) => a.enabled !== false).map((a) => a.id);
  if (values.agent && !factory.agents.some((a) => a.id === values.agent)) throw new SfError(`Unknown agent "${values.agent}"`);
  if (!values.agent && !values.all) console.log('(testing every enabled agent)');
  const prev = exists(p.doctor) ? readJson(p.doctor) : { agents: {} };
  const timeoutS = values.timeout ? Number(values.timeout) : 180;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-doctor-'));
  let failed = 0;
  for (const id of wanted) {
    const agent = factory.agents.find((a) => a.id === id);
    const nonce = `SF_OK_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const prompt = `This is an automated connectivity test. Reply with exactly this single token and nothing else: ${nonce}\nDo not create, edit or delete any files. Do not run any commands.\n`;
    const runDir = path.join(p.runs, 'doctor', id);
    process.stdout.write(`testing ${id} ... `);
    const res = await runAgent({
      agent, prompt, promptFile: path.join(runDir, 'brief.md'), cwd: sandbox, root, runDir,
      vars: { role: 'doctor', task_id: 'doctor', attempt: 1 }, timeoutMs: timeoutS * 1000,
    });
    const out = tailFile(res.stdoutPath, 20000);
    const ok = res.status === 'SUCCEEDED' && out.includes(nonce);
    const reason = ok ? 'ok' : res.status !== 'SUCCEEDED' ? `${res.status}${res.error ? `: ${res.error}` : ` (exit ${res.exitCode})`}` : 'agent ran but did not echo the test token (check how the prompt is delivered and that output is printed to stdout)';
    prev.agents[id] = { ok, checked_at: nowIso(), reason, durationMs: res.durationMs, stdout: res.stdoutPath, stderr: res.stderrPath };
    console.log(ok ? `OK (${Math.round(res.durationMs / 1000)}s)` : `FAILED — ${reason}`);
    if (!ok) {
      failed++;
      const err = tailFile(res.stderrPath, 600).trim();
      if (err) console.log(`   stderr: ${err.split('\n').slice(-5).join('\n           ')}`);
    }
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
  writeJson(p.doctor, prev);
  if (failed) {
    console.log(`${failed} agent(s) failed. Fix the profile in .sf/factory.yaml (args/input/env) and re-run doctor. Logs: ${path.join(p.runs, 'doctor')}`);
    return 1;
  }
  console.log('All tested agents responded correctly.');
  return 0;
}

function cmdCheck(root, json) {
  const p = sfPaths(root);
  const result = { ready: false, factory: false, problems: [], unverified_agents: [] };
  try {
    const { factory } = loadFactory(root);
    result.factory = true;
    const doctor = exists(p.doctor) ? readJson(p.doctor) : { agents: {} };
    const used = new Set([...factory.roles.implementers, ...factory.roles.reviewers, ...['spec_author', 'planner'].map((k) => factory.roles[k]).filter((x) => x && x !== 'session')]);
    for (const id of used) {
      if (!resolveExecutable(factory.agents.find((a) => a.id === id).command)) result.problems.push(`agent "${id}": command not on PATH`);
      if (!doctor.agents?.[id]?.ok) result.unverified_agents.push(id);
    }
    result.ready = result.problems.length === 0 && result.unverified_agents.length === 0;
  } catch (e) {
    if (!(e instanceof SfError)) throw e;
    result.problems.push(e.message, ...(Array.isArray(e.details) ? e.details : []));
  }
  if (json) printJson(result);
  else console.log(result.ready ? 'READY' : `NOT READY: ${[...result.problems, ...result.unverified_agents.map((a) => `agent "${a}" not verified by doctor`)].join('; ')}`);
  return result.ready ? 0 : 1;
}

cliMain(async () => {
  const { values, positionals } = parseArgs(process.argv.slice(2), OPTS);
  const cmd = positionals[0];
  if (!cmd || values.help) {
    console.log(USAGE);
    return cmd || values.help ? 0 : 2;
  }
  const root = findRoot(values.root);
  switch (cmd) {
    case 'init': return void cmdInit(root, values.force);
    case 'probe': {
      if (!positionals[1]) throw new SfError('probe needs a command name, e.g. "probe claude"', { exitCode: 2 });
      const r = probe(positionals[1]);
      if (values.json) printJson(r);
      else console.log(r.found ? `${r.command}: ${r.path}\nversion: ${r.version}\n\n--- --help (excerpt) ---\n${r.help_excerpt}\n\n${r.notes}` : `${r.command}: NOT FOUND on PATH`);
      return r.found ? 0 : 1;
    }
    case 'validate': return void cmdValidate(root, values.json);
    case 'show': return void cmdShow(root);
    case 'doctor': return await cmdDoctor(root, values);
    case 'check': return cmdCheck(root, values.json);
    default: throw new SfError(`Unknown command "${cmd}"\n${USAGE}`, { exitCode: 2 });
  }
});
