#!/usr/bin/env node
// Install the sf-* skills for the coding agents on this machine.
//   • Detects major agents (CLI on PATH or config dir) using scripts/agent-registry.yaml.
//   • With several detected, asks which MAIN agent to install for, or ALL detected, or the tool-neutral
//     workspace setup (.sf/skills), or the cross-agent standard (.agents/skills).
//   • Default scope is the workspace (project) — nothing in your home directory unless --scope user.
//   • Non-interactive callers (e.g. an agent) get the options as JSON and exit code 4: ask the user, then re-run with flags.
// Usage: node scripts/install.mjs [--workspace dir] [--scope workspace|user]
//          [--agent id[,id]] [--all-detected] [--standard] [--agents-standard] [--dest dir]
//          [--only skills] [--link] [--yes] [--dry-run] [--force] [--list] [--registry file] [--no-agents-md]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from '../sf-shared/lib/yaml.mjs';
import { resolveExecutable } from '../sf-shared/lib/runner.mjs';
import { SF_VERSION } from '../sf-shared/lib/version.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    workspace: { type: 'string' }, scope: { type: 'string' }, agent: { type: 'string' }, 'all-detected': { type: 'boolean' },
    standard: { type: 'boolean' }, 'agents-standard': { type: 'boolean' }, dest: { type: 'string' }, only: { type: 'string' },
    link: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' }, 'dry-run': { type: 'boolean' }, force: { type: 'boolean' },
    list: { type: 'boolean' }, registry: { type: 'string' }, 'no-agents-md': { type: 'boolean' }, 'agents-md': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  },
  strict: true,
});

const HELP = `Install sf-* skills for your coding agents.
  (no options)            detect agents; if several, choose main agent / all detected / .sf/skills standard / .agents/skills
  --agent claude,codex    install for specific agents      --all-detected   every detected agent
  --standard              tool-neutral <workspace>/.sf/skills (+ AGENTS.md pointer)
  --agents-standard       cross-agent <workspace>/.agents/skills
  --dest <dir>            custom skills directory           --scope workspace|user (default workspace)
  --only a,b  --link  --yes  --dry-run  --force  --list  --registry <file>  --workspace <dir>  --no-agents-md`;
if (values.help) { console.log(HELP); process.exit(0); }

const env = process.env;
const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
const workspace = path.resolve(values.workspace ?? process.cwd());
const scope = values.scope ?? 'workspace';
if (!['workspace', 'user'].includes(scope)) { console.error('--scope must be workspace or user'); process.exit(2); }
const expandHome = (p) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);

const registryFile = values.registry ? path.resolve(values.registry) : path.join(repo, 'scripts', 'agent-registry.yaml');
let registry;
try { registry = parseYaml(fs.readFileSync(registryFile, 'utf8'), { filename: registryFile }); } catch (e) { console.error(`ERROR: ${e.message}`); process.exit(1); }

const allSkills = fs.readdirSync(repo).filter((d) => d.startsWith('sf-') && fs.existsSync(path.join(repo, d, 'SKILL.md')));
const skills = values.only ? values.only.split(',').map((s) => s.trim()).filter(Boolean) : allSkills;
for (const s of skills) if (!allSkills.includes(s)) { console.error(`unknown skill "${s}" (available: ${allSkills.join(', ')})`); process.exit(2); }

// ------------------------------------------------------------------ detection
function detect() {
  return registry.agents.map((a) => {
    const cli = (a.commands ?? []).map((c) => resolveExecutable(c, env)).filter(Boolean);
    const cfg = (a.config_dirs ?? []).map(expandHome).filter((d) => fs.existsSync(d));
    return { ...a, detected: cli.length > 0 || cfg.length > 0, evidence: { cli, config_dirs: cfg }, strength: cli.length ? 'cli' : cfg.length ? 'config-dir only' : 'none' };
  });
}
const detected = detect();
const found = detected.filter((a) => a.detected);

if (values.list) {
  console.log(`Registry: ${registryFile}\n`);
  for (const a of detected) {
    console.log(`${a.detected ? '✔' : '·'} ${a.label.padEnd(40)} workspace: ${a.workspace.padEnd(20)} user: ${(a.user ?? '').padEnd(28)} [${a.confidence}] ${a.detected ? `(${a.strength}: ${[...a.evidence.cli, ...a.evidence.config_dirs].join(', ')})` : ''}`);
  }
  console.log(`\nGeneric: ${registry.generic.agents_standard.workspace} (cross-agent), ${registry.generic.sf_standard.workspace} (tool-neutral)`);
  process.exit(0);
}

// ------------------------------------------------------------------ choose targets
const dirFor = (entry) => (scope === 'user' ? (entry.user ? expandHome(entry.user) : null) : path.join(workspace, entry.workspace));
const stdEntry = registry.generic.sf_standard;
const crossEntry = registry.generic.agents_standard;

async function ask(question, options) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(question);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}`));
  const ans = (await rl.question(`Choose 1-${options.length}: `)).trim();
  rl.close();
  const idx = Number(ans) - 1;
  return options[idx] ?? null;
}

/** @returns {Promise<{id:string,label:string,entry:any,note?:string,confidence?:string}[]>} */
async function chooseTargets() {
  if (values.dest) return [{ id: 'custom', label: 'custom', dir: path.resolve(values.dest) }];
  const picks = [];
  const byId = (id) => {
    const a = registry.agents.find((x) => x.id === id);
    if (!a) { console.error(`unknown agent "${id}" (known: ${registry.agents.map((x) => x.id).join(', ')})`); process.exit(2); }
    return a;
  };
  if (values.agent) for (const id of values.agent.split(',').map((s) => s.trim()).filter(Boolean)) picks.push(byId(id));
  if (values['all-detected']) picks.push(...found);
  const explicit = Boolean(values.agent || values['all-detected'] || values.standard || values['agents-standard']);
  const generic = [];
  if (values.standard) generic.push({ id: 'sf-standard', label: stdEntry.label, ...stdEntry });
  if (values['agents-standard']) generic.push({ id: 'agents-standard', label: crossEntry.label, ...crossEntry });
  if (explicit) return [...picks, ...generic];

  const options = [];
  if (found.length === 0) {
    console.log('No known coding agent detected on this machine; using the tool-neutral workspace setup.');
    return [{ id: 'sf-standard', label: stdEntry.label, ...stdEntry }];
  }
  for (const a of found) options.push({ label: `${a.label}${found.length > 1 ? ' as the main agent' : ''}  → ${scope === 'user' ? a.user : a.workspace}  (${a.strength})`, pick: [a], flags: `--agent ${a.id}` });
  if (found.length > 1) options.push({ label: `All detected agents (${found.map((a) => a.label).join(', ')})`, pick: found, flags: '--all-detected' });
  options.push({ label: `${stdEntry.label} — not auto-discovered; AGENTS.md pointer added`, pick: [{ id: 'sf-standard', label: stdEntry.label, ...stdEntry }], flags: '--standard' });
  options.push({ label: `${crossEntry.label} — read by ${crossEntry.read_by.join(', ')}`, pick: [{ id: 'agents-standard', label: crossEntry.label, ...crossEntry }], flags: '--agents-standard' });
  if (!tty) {
    console.log(JSON.stringify({
      needs_decision: true, workspace, scope,
      detected: found.map((a) => ({ id: a.id, label: a.label, evidence: a.strength, target: dirFor(a), confidence: a.confidence })),
      options: options.map((o) => ({ label: o.label, rerun_with: o.flags })),
      instruction: 'Ask the user which option they want, then re-run with the matching flag (add --yes to skip the confirmation). Combine flags for several targets, e.g. --agent claude,codex --standard.',
    }, null, 2));
    process.exit(4);
  }
  const choice = await ask(`Detected ${found.length} agent(s). Install the sf-* skills for:`, options);
  if (!choice) { console.error('No valid choice; aborting.'); process.exit(4); }
  return choice.pick;
}

const targets = await chooseTargets();

// ------------------------------------------------------------------ plan
const plan = new Map();
for (const t of targets) {
  const dir = t.dir ?? dirFor(t);
  if (!dir) { console.log(`skip ${t.label}: no ${scope} skills directory known`); continue; }
  const e = plan.get(dir) ?? { dir, agents: [], notes: [] };
  e.agents.push(t.label ?? t.id);
  if (t.note && !e.notes.includes(t.note)) e.notes.push(t.note);
  if (t.confidence && t.confidence !== 'official') e.notes.push(`(${t.label}: ${t.confidence} path — verify)`);
  plan.set(dir, e);
}
if (!plan.size) { console.error('Nothing to install.'); process.exit(1); }
const touchesStd = [...plan.keys()].some((d) => d === path.join(workspace, stdEntry.workspace));
const agentsMdFile = values['agents-md'] ? path.resolve(values['agents-md']) : path.join(workspace, 'AGENTS.md');
const wantsPointer = !values['no-agents-md'] && (touchesStd || Boolean(values['agents-md']));

console.log(`\nInstall plan (sf ${SF_VERSION}, scope ${scope}, ${values.link ? 'symlink' : 'copy'}): ${skills.join(', ')}`);
for (const e of plan.values()) {
  console.log(`  → ${e.dir}\n      for: ${e.agents.join(', ')}`);
  for (const n of e.notes) console.log(`      note: ${n}`);
  for (const s of skills) {
    const dest = path.join(e.dir, s);
    const state = !fs.existsSync(dest) && !isLink(dest) ? 'new' : isManaged(dest) ? 'replace (managed by sf installer)' : values.force ? 'REPLACE (--force)' : 'EXISTS, not managed — will be skipped unless --force';
    console.log(`      ${s}: ${state}`);
  }
}
if (wantsPointer) console.log(`  → ${agentsMdFile}: append a pointer block to the skills`);
if (values['dry-run']) { console.log('\n(dry run: nothing written)'); process.exit(0); }

function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }
function isManaged(p) { return isLink(p) || fs.existsSync(path.join(p, '.sf-managed')); }

if (!values.yes) {
  if (!tty) { console.error('\nConfirmation required: re-run with --yes after the user approves this plan (or use --dry-run).'); process.exit(4); }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question('\nProceed? [y/N] ')).trim().toLowerCase();
  rl.close();
  if (a !== 'y' && a !== 'yes') { console.log('Aborted.'); process.exit(4); }
}

// ------------------------------------------------------------------ install
const installed = [];
for (const e of plan.values()) {
  fs.mkdirSync(e.dir, { recursive: true });
  for (const s of skills) {
    const dest = path.join(e.dir, s);
    const exists = fs.existsSync(dest) || isLink(dest);
    if (exists && !isManaged(dest) && !values.force) { console.log(`skipped ${dest} (exists, not managed by this installer; use --force)`); continue; }
    if (exists) fs.rmSync(dest, { recursive: true, force: true });
    if (values.link) fs.symlinkSync(path.join(repo, s), dest, 'dir');
    else {
      fs.cpSync(path.join(repo, s), dest, { recursive: true, filter: (src) => !/(__pycache__|\.DS_Store|node_modules)/.test(src) });
      fs.writeFileSync(path.join(dest, '.sf-managed'), JSON.stringify({ sf_version: SF_VERSION, installed_at: new Date().toISOString(), source: repo }) + '\n');
    }
    installed.push(dest);
    console.log(`${values.link ? 'linked' : 'copied'} ${s} -> ${dest}`);
  }
}

if (wantsPointer) {
  const marker = '<!-- sf-skills -->';
  const base = [...plan.keys()].find((d) => d === path.join(workspace, stdEntry.workspace)) ?? [...plan.keys()][0];
  const rel = (p) => (path.relative(path.dirname(agentsMdFile), p) || '.').split(path.sep).join('/');
  const snippet = `${marker}
## sf-* delivery skills
To build software with multiple agents, read and follow these skill files (Markdown + Node scripts, Node >= 20):
${skills.map((s) => `- ${rel(path.join(base, s, 'SKILL.md'))}`).join('\n')}
Order: sf-agent-setup -> sf-spec-builder -> sf-plan-builder -> sf-orchestrator. Start with: node ${rel(path.join(base, 'sf-orchestrator/scripts/sf.mjs'))} check
${marker}
`;
  const existing = fs.existsSync(agentsMdFile) ? fs.readFileSync(agentsMdFile, 'utf8') : '';
  if (existing.includes(marker)) console.log(`${agentsMdFile} already has the sf-skills block; unchanged.`);
  else { fs.writeFileSync(agentsMdFile, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + (existing ? '\n' : '') + snippet); console.log(`appended sf-skills pointer to ${agentsMdFile}`); }
}

// record
const recFile = path.join(workspace, '.sf', 'install.json');
try {
  fs.mkdirSync(path.dirname(recFile), { recursive: true });
  const rec = fs.existsSync(recFile) ? JSON.parse(fs.readFileSync(recFile, 'utf8')) : { installs: [] };
  rec.installs.push({ at: new Date().toISOString(), sf_version: SF_VERSION, scope, mode: values.link ? 'link' : 'copy', targets: [...plan.values()].map((e) => ({ dir: e.dir, agents: e.agents })), skills });
  fs.writeFileSync(recFile, JSON.stringify(rec, null, 2) + '\n');
} catch { /* best effort */ }

console.log(`\nDone: ${installed.length} skill folder(s) installed. Skills reference each other as siblings (../sf-spec-builder/...), so each target holds all selected skills.`);
for (const e of plan.values()) for (const n of e.notes) if (/Kiro|experimental|reload/i.test(n)) console.log(`NOTE: ${n}`);
