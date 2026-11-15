import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify, YamlError } from '../sf-shared/lib/yaml.mjs';
import { validate, applyDefaults } from '../sf-shared/lib/validate.mjs';
import { render } from '../sf-shared/lib/template.mjs';
import { scopeMatcher, scopesOverlap } from '../sf-shared/lib/git.mjs';
import { parseSpec, lintSpec } from '../sf-shared/lib/spec.mjs';
import { lintPlan, topoSort } from '../sf-shared/lib/plan.mjs';
import { planSchema, factorySchema } from '../sf-shared/lib/schemas.mjs';
import { lintFactory } from '../sf-shared/lib/factory.mjs';
import { webhookRequest, buildDigest } from '../sf-shared/lib/notify.mjs';
import { verdict, checkReviewResult, extractJson } from '../sf-shared/lib/review.mjs';
import { Store, TASK_TRANSITIONS } from '../sf-shared/lib/state.mjs';
import { runAgent, buildArgs } from '../sf-shared/lib/runner.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('yaml: parses the supported subset and round-trips', () => {
  const doc = parse(`
# c
a: 1
b: [x, "y z", 3.5, true, null]
c:
  - d: 1
    e: |
      line1
      line2
  - plain
f: {k: v, n: 2}
g: 'it''s'
`);
  assert.deepEqual(doc, { a: 1, b: ['x', 'y z', 3.5, true, null], c: [{ d: 1, e: 'line1\nline2\n' }, 'plain'], f: { k: 'v', n: 2 }, g: "it's" });
  assert.deepEqual(parse(stringify(doc)), doc);
});

test('yaml: strictness — user mistakes are errors with line numbers', () => {
  const bad = {
    'a: 1\na: 2': /duplicate key "a"/,
    'a:\n\tb: 1': /tabs/,
    'a: yes': /ambiguous/,
    'a: x: y': /contains ": "/,
    'a: &x 1': /unsupported/,
    'a:\n  b: 1\n c: 2': /indentation|unexpected/,
    'a: [1, 2': /unterminated/,
    'a: 1\n b: 2': /indentation/,
    'a: "open': /unterminated/,
    '---\na: 1\n---\nb: 2': /multiple/,
  };
  for (const [src, re] of Object.entries(bad)) {
    assert.throws(() => parse(src, { filename: 't.yaml' }), (e) => e instanceof YamlError && re.test(e.message) && /t\.yaml:\d+:/.test(e.message), src);
  }
});

test('validate: unknown fields get did-you-mean hints; defaults apply', () => {
  const errs = validate({ sf: 'factory/1', project: { id: 'x' }, agents: [{ id: 'a', command: 'c', max_concurency: 2 }], roles: { implementers: ['a'], reviewers: ['a'] }, execution: { max_paralel_tasks: 2 } }, factorySchema);
  assert.ok(errs.some((e) => /max_concurency.*max_concurrency/.test(e)), errs.join('\n'));
  assert.ok(errs.some((e) => /max_paralel_tasks.*max_parallel_tasks/.test(e)));
  const filled = applyDefaults({ sf: 'factory/1', project: { id: 'x' }, agents: [{ id: 'a', command: 'c' }], roles: { implementers: ['a'], reviewers: ['a'] } }, factorySchema);
  assert.equal(filled.execution.max_rework_rounds, 2);
  assert.equal(filled.notify.interval_minutes, 5);
  assert.equal(filled.agents[0].max_concurrency, 1);
});

test('template: missing variables throw', () => {
  assert.equal(render('hi {{a.b}}', { a: { b: 1 } }), 'hi 1');
  assert.throws(() => render('hi {{nope}}', {}), /unknown variable/);
});

test('scopes: matching and overlap', () => {
  const m = scopeMatcher(['src/a', 'docs/**/*.md', 'package.json']);
  assert.ok(m('src/a/x/y.js') && m('package.json') && m('docs/g/h.md') && m('docs/h.md'));
  assert.ok(!m('src/ab/x.js') && !m('src/b/x.js') && !m('docs/h.txt'));
  assert.ok(scopesOverlap('src', 'src/a') && scopesOverlap('src/**', 'src/a/b') && !scopesOverlap('src/a', 'src/b'));
});

const SPEC = `---
sf: spec/1
title: T
status: draft
version: 1
---
## Requirements

### REQ-001: One
- Type: functional
- Priority: must

The thing shall work.

**Acceptance criteria**
- It returns 200 within 100 ms
- It handles empty input

### REQ-002: Two
- Type: nfr
- Priority: could

Another.

**Acceptance criteria**
- Is fast
`;

test('spec: parse + lint', () => {
  const p = parseSpec(SPEC);
  assert.equal(p.requirements.length, 2);
  assert.equal(p.requirements[0].criteria[1].id, 'REQ-001.2');
  const l = lintSpec(p);
  assert.deepEqual(l.errors, []);
  assert.ok(l.warnings.some((w) => /vague word "fast"/.test(w)));
  const bad = lintSpec(parseSpec(SPEC.replace('- Priority: must', '- Priority: urgent').replace('It handles empty input', 'TBD')));
  assert.ok(bad.errors.some((e) => /invalid Priority/.test(e)) && bad.errors.some((e) => /placeholder/.test(e)));
  assert.ok(lintSpec(parseSpec(SPEC.replace(/\*\*Acceptance criteria\*\*\n- Is fast/, ''))).errors.some((e) => /acceptance criterion/.test(e)));
});

const idx = { spec_hash: 'h', requirements: [{ id: 'REQ-001', priority: 'must' }, { id: 'REQ-002', priority: 'could' }] };
const mkPlan = (over = {}) => applyDefaults({
  sf: 'plan/1', project: { id: 'p' }, spec: { path: 's', hash: 'h' }, status: 'approved',
  milestones: [{ id: 'M1', title: 'm' }],
  tasks: [
    { id: 'A', milestone: 'M1', title: 'a', goal: 'goal a', requirements: ['REQ-001'], write_scopes: ['src/a'], acceptance_criteria: ['does a thing'] },
    { id: 'B', milestone: 'M1', title: 'b', goal: 'goal b', requirements: [], write_scopes: ['src/b'], acceptance_criteria: ['does b thing'], depends_on: ['A'] },
  ],
  ...over,
}, planSchema);

test('plan: lint catches cycles, coverage, drift, unknown refs, overlap', () => {
  assert.deepEqual(lintPlan(mkPlan(), { specIndex: idx }).errors, []);
  const cyc = mkPlan();
  cyc.tasks[0].depends_on = ['B'];
  assert.ok(lintPlan(cyc, { specIndex: idx }).errors.some((e) => /cycle/.test(e)));
  const unc = mkPlan();
  unc.tasks[0].requirements = [];
  assert.ok(lintPlan(unc, { specIndex: idx }).errors.some((e) => /REQ-001.*not covered/.test(e)));
  assert.ok(lintPlan(mkPlan({ spec: { path: 's', hash: 'other' } }), { specIndex: idx }).errors.some((e) => /spec drift/.test(e)));
  const unk = mkPlan();
  unk.tasks[1].depends_on = ['ZZ'];
  assert.ok(lintPlan(unk, { specIndex: idx }).errors.some((e) => /unknown task "ZZ"/.test(e)));
  const ov = mkPlan();
  ov.tasks[1].depends_on = [];
  ov.tasks[1].write_scopes = ['src/a/sub'];
  assert.ok(lintPlan(ov, { specIndex: idx }).warnings.some((w) => /overlapping write scopes/.test(w)));
  const sfScope = mkPlan();
  sfScope.tasks[0].write_scopes = ['.sf/plan.yaml'];
  assert.ok(lintPlan(sfScope, { specIndex: idx }).errors.some((e) => /\.sf/.test(e)));
  assert.equal(topoSort([{ id: 'x', d: ['y'] }, { id: 'y', d: [] }], (t) => t.d).order.join(), 'y,x');
});

test('factory lint: independence, prompt delivery, secrets in webhook url', () => {
  const base = () => applyDefaults({
    sf: 'factory/1', project: { id: 'p' },
    agents: [{ id: 'a', command: 'x', args: ['{{prompt_pointer}}'] }, { id: 'b', command: 'x', args: ['{{prompt_pointer}}'] }],
    roles: { implementers: ['a'], reviewers: ['b'] },
  }, factorySchema);
  assert.deepEqual(lintFactory(base(), {}).errors, []);
  const same = base();
  same.roles.reviewers = ['a'];
  assert.ok(lintFactory(same, {}).errors.some((e) => /no implementer\/reviewer pair/.test(e)));
  const noPrompt = base();
  noPrompt.agents[0].args = ['--flag'];
  assert.ok(lintFactory(noPrompt, {}).errors.some((e) => /never receives the prompt/.test(e)));
  noPrompt.agents[0].input = 'stdin';
  assert.equal(lintFactory(noPrompt, {}).errors.length, 0);
  const model = base();
  model.execution.review_independence = 'model';
  assert.ok(lintFactory(model, {}).errors.length > 0);
  model.agents[0].model = 'm1';
  model.agents[1].model = 'm2';
  assert.equal(lintFactory(model, {}).errors.length, 0);
  const hook = base();
  hook.notify.channels = [{ type: 'webhook', preset: 'telegram', url: 'https://api.telegram.org/bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/sendMessage', chat_id: '1' }];
  assert.ok(lintFactory(hook, {}).errors.some((e) => /literal Telegram bot token/.test(e)));
  const unknownVar = base();
  unknownVar.agents[0].args = ['{{prompt_pointer}}', '{{nope}}'];
  assert.ok(lintFactory(unknownVar, {}).errors.some((e) => /unknown placeholder/.test(e)));
});

test('notify: telegram/slack/discord webhook requests', () => {
  const env = { TOKEN: 'T0K', CHAT: '-100123', URL: 'https://hooks.example/x' };
  const tg = webhookRequest({ type: 'webhook', preset: 'telegram', url: 'https://api.telegram.org/bot${TOKEN}/sendMessage', chat_id: '${CHAT}' }, 'hello', env);
  assert.equal(tg.url, 'https://api.telegram.org/botT0K/sendMessage');
  assert.deepEqual(JSON.parse(tg.init.body), { chat_id: -100123, text: 'hello', disable_web_page_preview: true });
  assert.deepEqual(JSON.parse(webhookRequest({ type: 'webhook', preset: 'slack', url: '${URL}' }, 'hi', env).init.body), { text: 'hi' });
  assert.deepEqual(JSON.parse(webhookRequest({ type: 'webhook', preset: 'discord', url: '${URL}' }, 'hi', env).init.body), { content: 'hi' });
  const custom = webhookRequest({ type: 'webhook', url: '${URL}', body: '{"msg": {{text_json}}, "k": "${CHAT}"}' }, 'a "q"\nb', env);
  assert.deepEqual(JSON.parse(custom.init.body), { msg: 'a "q"\nb', k: '-100123' });
  assert.throws(() => webhookRequest({ type: 'webhook', preset: 'slack', url: '${MISSING}' }, 'x', env), /unset variable/);
});

test('review: verdict requires evidence for every criterion and no blocking findings', () => {
  const task = { id: 'T', acceptance_criteria: ['does x', 'does y'] };
  const ok = { task_id: 'T', status: 'PASS', criteria: [{ criterion: 'does x', status: 'PASS', evidence: 'ran it' }, { criterion: 'Does  y', status: 'PASS', evidence: 'saw it' }], findings: [] };
  assert.deepEqual(checkReviewResult(ok, task), []);
  assert.equal(verdict(ok, task, { ok: true }).pass, true);
  assert.equal(verdict(ok, task, { ok: false }).pass, false);
  const noEv = structuredClone(ok);
  noEv.criteria[0].evidence = '';
  assert.equal(verdict(noEv, task, { ok: true }).pass, false);
  const major = structuredClone(ok);
  major.findings = [{ severity: 'major', description: 'bad' }];
  assert.equal(verdict(major, task, { ok: true }).pass, false);
  const missing = { ...ok, criteria: [ok.criteria[0]] };
  assert.ok(checkReviewResult(missing, task).some((e) => /does not assess/.test(e)));
  assert.deepEqual(extractJson('noise\n```json\n{"a":1}\n```\n'), { a: 1 });
});

test('state: illegal transitions are rejected and events are logged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-state-'));
  const paths = { state: path.join(dir, 's.json'), events: path.join(dir, 'e.jsonl') };
  const store = new Store(paths);
  store.init({ project: { id: 'p' }, status: 'approved', tasks: [{ id: 'T', milestone: 'M', title: 't' }], milestones: [{ id: 'M' }] }, { specHash: 'h' });
  assert.throws(() => store.setTask('T', 'PASS', 'skip ahead'), /Illegal task transition/);
  store.setTask('T', 'READY', 'ok');
  store.setTask('T', 'RUNNING', 'go');
  assert.equal(store.setTask('T', 'BLOCKED', 'why') ?? 'x', 'x');
  assert.equal(store.state.tasks.T.blocked_reason, 'why');
  assert.ok(store.readEvents().some((e) => e.severity === 'error'));
  assert.ok(Object.values(TASK_TRANSITIONS).flat().every((s) => s in TASK_TRANSITIONS));
  assert.match(buildDigest(store.state, {}), /1 BLOCKED/);
});

test('runner: argv rendering, conditionals, timeout kill, missing command', async () => {
  const agent = { id: 'x', command: process.execPath, args: ['-e', 'setTimeout(()=>{},60000)', { if: 'model', args: ['--m', '{{model}}'] }], model: '', env_inherit: true };
  assert.deepEqual(buildArgs(agent, { model: '' }), ['-e', 'setTimeout(()=>{},60000)']);
  assert.deepEqual(buildArgs({ ...agent, model: 'z' }, { model: 'z' }), ['-e', 'setTimeout(()=>{},60000)', '--m', 'z']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-run-'));
  const t0 = Date.now();
  const res = await runAgent({ agent, prompt: 'p', promptFile: path.join(dir, 'b.md'), cwd: dir, root: dir, runDir: dir, vars: {}, timeoutMs: 400 });
  assert.equal(res.status, 'TIMED_OUT');
  assert.ok(Date.now() - t0 < 10000);
  const missing = await runAgent({ agent: { id: 'm', command: 'definitely-not-a-command-xyz', args: [] }, prompt: 'p', promptFile: path.join(dir, 'c.md'), cwd: dir, root: dir, runDir: dir, vars: {}, timeoutMs: 1000 });
  assert.equal(missing.status, 'SPAWN_ERROR');
  const ok = await runAgent({ agent: { id: 'ok', command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'], input: 'stdin' }, prompt: 'echo me', promptFile: path.join(dir, 'd.md'), cwd: dir, root: dir, runDir: dir, vars: {}, timeoutMs: 5000 });
  assert.equal(ok.status, 'SUCCEEDED');
  assert.equal(fs.readFileSync(ok.stdoutPath, 'utf8'), 'echo me');
});
