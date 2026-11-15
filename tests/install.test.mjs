import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './helpers.mjs';

const INSTALL = path.join(REPO, 'scripts', 'install.mjs');

function sandbox({ commands = [], dirs = [] } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-inst-')));
  const bin = path.join(base, 'bin');
  const home = path.join(base, 'home');
  const ws = path.join(base, 'ws');
  for (const d of [bin, home, ws]) fs.mkdirSync(d, { recursive: true });
  for (const c of commands) { fs.writeFileSync(path.join(bin, c), '#!/bin/sh\nexit 0\n'); fs.chmodSync(path.join(bin, c), 0o755); }
  for (const d of dirs) fs.mkdirSync(path.join(home, d), { recursive: true });
  const run = (args) => {
    const r = spawnSync(process.execPath, [INSTALL, '--workspace', ws, ...args], { encoding: 'utf8', env: { PATH: bin, HOME: home, USERPROFILE: home } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  return { base, ws, home, run };
}
const SKILLS = ['sf-agent-setup', 'sf-spec-builder', 'sf-plan-builder', 'sf-orchestrator', 'sf-apply-ste'];

test('multiple agents detected, non-interactive → options as JSON and exit 4, nothing written', () => {
  const s = sandbox({ commands: ['claude', 'codex'], dirs: ['.copilot'] });
  const r = s.run([]);
  assert.equal(r.code, 4);
  const j = JSON.parse(r.out);
  assert.equal(j.needs_decision, true);
  assert.deepEqual(j.detected.map((d) => d.id).sort(), ['claude', 'codex', 'copilot']);
  assert.equal(j.detected.find((d) => d.id === 'copilot').evidence, 'config-dir only');
  const flags = j.options.map((o) => o.rerun_with);
  for (const f of ['--agent claude', '--agent codex', '--all-detected', '--standard', '--agents-standard']) assert.ok(flags.includes(f), f);
  assert.equal(fs.existsSync(path.join(s.ws, '.claude')), false);
});

test('--agent claude installs all five self-contained skills into <workspace>/.claude/skills', () => {
  const s = sandbox({ commands: ['claude', 'codex'] });
  assert.equal(s.run(['--agent', 'claude']).code, 4, 'needs --yes when not interactive');
  const r = s.run(['--agent', 'claude', '--yes']);
  assert.equal(r.code, 0, r.err + r.out);
  for (const k of SKILLS) {
    const d = path.join(s.ws, '.claude/skills', k);
    assert.ok(fs.existsSync(path.join(d, 'SKILL.md')), k);
    assert.ok(fs.existsSync(path.join(d, '.sf-managed')));
  }
  assert.ok(fs.existsSync(path.join(s.ws, '.claude/skills/sf-orchestrator/scripts/lib/util.mjs')), 'shared lib is vendored into the skill');
  assert.ok(fs.existsSync(path.join(s.ws, '.sf/install.json')));
  assert.equal(fs.existsSync(path.join(s.home, '.claude')), false, 'workspace scope never touches HOME');
});

test('--all-detected dedupes identical directories; --standard adds .sf/skills and an AGENTS.md pointer', () => {
  const s = sandbox({ commands: ['codex', 'pi'] });
  let r = s.run(['--agent', 'codex', '--agents-standard', '--dry-run']);
  assert.equal(r.code, 0);
  assert.equal((r.out.match(/→ .*\.agents\/skills/g) ?? []).length, 1, 'codex and the cross-agent standard share one directory');
  r = s.run(['--all-detected', '--standard', '--yes']);
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(fs.existsSync(path.join(s.ws, '.agents/skills/sf-plan-builder/SKILL.md')));
  assert.ok(fs.existsSync(path.join(s.ws, '.pi/skills/sf-plan-builder/SKILL.md')));
  assert.ok(fs.existsSync(path.join(s.ws, '.sf/skills/sf-orchestrator/SKILL.md')));
  const agents = fs.readFileSync(path.join(s.ws, 'AGENTS.md'), 'utf8');
  assert.match(agents, /\.sf\/skills\/sf-orchestrator\/SKILL\.md/);
  s.run(['--standard', '--yes']);
  assert.equal((fs.readFileSync(path.join(s.ws, 'AGENTS.md'), 'utf8').match(/<!-- sf-skills -->/g) ?? []).length, 2, 'pointer block is not duplicated');
});

test('nothing detected → tool-neutral .sf/skills; unmanaged existing dirs are not overwritten without --force', () => {
  const s = sandbox();
  const r = s.run(['--yes']);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /No known coding agent detected/);
  assert.ok(fs.existsSync(path.join(s.ws, '.sf/skills/sf-spec-builder/SKILL.md')));
  const own = path.join(s.ws, '.cline/skills/sf-spec-builder');
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, 'SKILL.md'), 'mine');
  const r2 = s.run(['--agent', 'cline', '--yes']);
  assert.match(r2.out, /skipped .*sf-spec-builder.*not managed/);
  assert.equal(fs.readFileSync(path.join(own, 'SKILL.md'), 'utf8'), 'mine');
  s.run(['--agent', 'cline', '--yes', '--force']);
  assert.notEqual(fs.readFileSync(path.join(own, 'SKILL.md'), 'utf8'), 'mine');
});

test('--scope user installs under HOME; --list shows registry; --only limits skills; registry covers the top agents', () => {
  const s = sandbox({ commands: ['gemini'] });
  const r = s.run(['--agent', 'gemini', '--scope', 'user', '--only', 'sf-orchestrator,sf-agent-setup', '--yes']);
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(fs.existsSync(path.join(s.home, '.gemini/skills/sf-orchestrator/SKILL.md')));
  assert.equal(fs.existsSync(path.join(s.home, '.gemini/skills/sf-plan-builder')), false);
  const list = s.run(['--list']).out;
  for (const label of ['Claude Code', 'Codex', 'Copilot', 'Cursor', 'Gemini CLI', 'OpenCode', 'Kiro', 'Cline', 'Windsurf', 'Pi']) assert.match(list, new RegExp(label));
  assert.match(list, /✔ Gemini CLI/);
});

test('installed copy is self-contained: sf.mjs runs from the installed location', () => {
  const s = sandbox({ commands: ['claude'] });
  s.run(['--agent', 'claude', '--yes']);
  const sf = path.join(s.ws, '.claude/skills/sf-orchestrator/scripts/sf.mjs');
  const r = spawnSync(process.execPath, [sf, 'check', '--json', '--root', s.ws], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).next.skill, 'sf-agent-setup');
});
