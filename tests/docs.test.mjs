import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, script } from './helpers.mjs';
import { TASK_TRANSITIONS, MILESTONE_TRANSITIONS } from '../sf-shared/lib/state.mjs';
import { SF_VERSION } from '../sf-shared/lib/version.mjs';
import { parse } from '../sf-shared/lib/yaml.mjs';

const HTML = path.join(REPO, 'docs', 'orchestrator-workflow.html');
const html = () => fs.readFileSync(HTML, 'utf8');

test('docs are up to date with the code (run `npm run docs` after changing states, commands or the registry)', () => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'build-docs.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('docs show the current version and every state of both state machines', () => {
  const h = html();
  assert.match(h, new RegExp(`data-sf-version="${SF_VERSION.replace(/\./g, '\\.')}"`));
  for (const s of [...Object.keys(TASK_TRANSITIONS), ...Object.keys(MILESTONE_TRANSITIONS)]) assert.ok(h.includes(`>${s}</text>`) || h.includes(`${s} —`), `state ${s} missing from the diagrams`);
  for (const [a, ts] of Object.entries(TASK_TRANSITIONS)) for (const t of ts) if (t !== 'BLOCKED') assert.ok(h.includes(`${a} → ${t}`), `transition ${a} → ${t} missing`);
});

test('every documented command exists in sf.mjs --help, and every sf.mjs command is documented', () => {
  const help = spawnSync(process.execPath, [script('sf-orchestrator', 'sf.mjs'), '--help'], { encoding: 'utf8' }).stdout;
  const documented = [...html().matchAll(/data-cmd="([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(documented.length >= 15);
  for (const c of documented) assert.match(help, new RegExp(`\\b${c}\\b`), `documented command "${c}" is not in sf.mjs --help`);
  const real = ['check', 'consent', 'assess', 'resume', 'run', 'status', 'wait', 'events', 'explain', 'approve', 'unblock', 'note', 'runs', 'archive', 'timeline', 'replay', 'export', 'report', 'stop'];
  for (const c of real) assert.ok(documented.includes(c), `command "${c}" is not documented in the HTML`);
});

test('docs list every agent in the install registry; docs/orchestrator-workflow.html is the only HTML file', () => {
  const reg = parse(fs.readFileSync(path.join(REPO, 'scripts', 'agent-registry.yaml'), 'utf8'));
  for (const a of reg.agents) assert.ok(html().includes(a.label.replace(/&/g, '&amp;')), a.label);
  const stale = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['.git', 'node_modules'].includes(e.name)) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.html') && f !== HTML) stale.push(path.relative(REPO, f));
    }
  };
  walk(REPO);
  assert.deepEqual(stale, []);
});

test('docs have a working light/dark/auto theme switch', () => {
  const h = html();
  assert.match(h, /id="theme"/);
  assert.match(h, /:root\[data-theme="dark"\]\{/);
  assert.match(h, /:root:not\(\[data-theme="light"\]\)/);
  assert.match(h, /localStorage\.setItem\('sf-docs-theme'/);
  for (const m of ['auto', 'light', 'dark']) assert.ok(h.includes(m));
});

test('repository root is tidy', () => {
  const allowed = new Set(['.git', '.gitignore', 'README.md', 'package.json', 'docs', 'scripts', 'sf-agent-setup', 'sf-orchestrator', 'sf-plan-builder', 'sf-shared', 'sf-spec-builder', 'tests']);
  const extra = fs.readdirSync(REPO).filter((n) => !allowed.has(n) && n !== '.DS_Store');
  assert.deepEqual(extra, []);
});
