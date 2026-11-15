import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpRepo, node, script, writeSpec, writePlan, fakeAgent, writeFactory } from './helpers.mjs';
import { checkText, safeFix, extractUnits, STE_DEFAULTS } from '../sf-shared/lib/ste.mjs';

const STE = script('sf-apply-ste', 'ste.mjs');
const rules = (text, config) => checkText(text, { config }).findings.map((f) => f.rule);
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

test('length limits: 25 words descriptive, 20 words in numbered steps; headings and code are exempt', () => {
  assert.deepEqual(rules(`${words(25)}.`), []);
  assert.deepEqual(rules(`${words(26)}.`), ['STE-LEN']);
  assert.deepEqual(rules(`1. ${words(20)}.`), []);
  assert.deepEqual(rules(`1. ${words(21)}.`), ['STE-LEN']);
  assert.deepEqual(rules(`- ${words(24)}.`), [], 'a bullet is descriptive, not procedural');
  assert.deepEqual(rules(`# ${words(40)}`), []);
  assert.deepEqual(rules('```\n' + words(60) + '\n```\n'), []);
  assert.deepEqual(rules(`${words(10)} \`${words(40)}\` ${words(10)}.`), [], 'inline code counts as one word');
  assert.deepEqual(rules(`${words(12)}. ${words(12)}.`), [], 'the limit applies to each sentence');
});

test('contractions, modal verbs, non-STE words, ellipsis, passive voice', () => {
  assert.ok(rules("Don't touch the file.").includes('STE-CONTRACTION'));
  assert.ok(rules('The system may start the job.').includes('STE-MODAL'));
  assert.ok(rules('The agent should stop.').includes('STE-MODAL'));
  assert.ok(rules('Use the tool in order to start it.').includes('STE-WORD'));
  assert.ok(rules('Set up the files, e.g. the log.').includes('STE-WORD'));
  assert.ok(rules('Wait...').includes('STE-ELLIPSIS'));
  assert.ok(rules('The file is written by the agent.').includes('STE-PASSIVE'));
  assert.deepEqual(rules('The agent writes the file. The system can start the job.'), []);
  const shall = checkText('The system shall start.').findings[0];
  assert.equal(shall.rule, 'STE-MODAL');
  assert.equal(shall.severity, 'warn');
});

test('structure: front matter, comments, links, URLs and tables are handled', () => {
  const doc = `---\ntitle: ${words(40)}\n---\n<!-- ${words(40)} -->\nSee [the guide](https://example.com/${words(30)}) now.\n\n| Name | Meaning |\n|---|---|\n| a | ${words(30)} |\n`;
  const r = checkText(doc).findings;
  assert.deepEqual(r.map((f) => f.rule), ['STE-LEN'], 'only the long table cell is reported');
  assert.equal(r[0].line, 9);
  assert.equal(extractUnits('1. one\n   continues here\n2. two\n').length, 2);
});

test('paragraph length and configurable limits and technical terms', () => {
  assert.ok(rules(Array.from({ length: 7 }, () => 'The agent works.').join(' ')).includes('STE-PARA'));
  assert.deepEqual(rules(`${words(18)}.`, { ...STE_DEFAULTS, max_words_descriptive: 15 }), ['STE-LEN']);
  const dict = new Set(['the', 'agent', 'start', 'job']);
  const base = checkText('The agent starts the worktree job.', { dictionary: dict }).findings.find((f) => f.rule === 'STE-DICT');
  assert.match(base.excerpt, /worktree/);
  const withTerm = checkText('The agent starts the worktree job.', { dictionary: dict, config: { ...STE_DEFAULTS, technical_terms: ['worktree'] } }).findings.find((f) => f.rule === 'STE-DICT');
  assert.equal(withTerm, undefined);
});

test('safeFix: mechanical, case-preserving, skips code/URLs/fences, idempotent', () => {
  const src = "Don't run it. We can't wait, e.g. now. Let's utilize the tool prior to the test in order to win.\n`don't touch` https://x.test/don't\n```\ndon't here\n```\n";
  const a = safeFix(src);
  assert.match(a.text, /^Do not run it\. We cannot wait, for example now\. Let us use the tool before the test to win\./);
  assert.match(a.text, /`don't touch` https:\/\/x\.test\/don't/);
  assert.match(a.text, /```\ndon't here\n```/);
  assert.ok(a.changes.length >= 6);
  assert.equal(safeFix(a.text).text, a.text);
  assert.equal(safeFix(a.text).changes.length, 0);
});

test('CLI: check exit codes, json, fix dry-run vs write, init, scope', () => {
  const dir = tmpRepo();
  fs.mkdirSync(path.join(dir, 'docs/design'), { recursive: true });
  const f = path.join(dir, 'docs/design/arch.md');
  fs.writeFileSync(f, "# Design\n\nThe service may fail. Don't retry in order to save time.\n");
  const bad = node(STE, ['check', 'docs/design', '--json'], { cwd: dir, allowFail: true });
  assert.equal(bad.code, 1);
  const j = JSON.parse(bad.stdout);
  assert.deepEqual([...new Set(j.findings.map((x) => x.rule))].sort(), ['STE-CONTRACTION', 'STE-MODAL', 'STE-WORD']);
  const dry = node(STE, ['fix', 'docs/design'], { cwd: dir });
  assert.match(dry.stdout, /Dry run/);
  assert.match(fs.readFileSync(f, 'utf8'), /Don't/);
  node(STE, ['fix', 'docs/design', '--write'], { cwd: dir });
  const after = fs.readFileSync(f, 'utf8');
  assert.match(after, /Do not retry to save time/);
  assert.match(after, /may fail/, 'the modal verb needs a human decision and stays');
  assert.equal(node(STE, ['check', 'docs/design'], { cwd: dir, allowFail: true }).code, 1);
  fs.writeFileSync(f, '# Design\n\nThe service can fail. Do not retry.\n');
  assert.equal(node(STE, ['check', 'docs/design'], { cwd: dir }).code, 0);
  node(STE, ['init'], { cwd: dir });
  assert.ok(fs.existsSync(path.join(dir, '.sf/ste.yaml')));
  assert.match(node(STE, ['scope', 'docs/design'], { cwd: dir }).stdout, /arch\.md/);
  const seal = node(STE, ['seal', 'docs/design'], { cwd: dir });
  assert.match(seal.stdout, /Sealed/);
  assert.match(fs.readFileSync(path.join(dir, '.sf/ledger.jsonl'), 'utf8'), /ste_applied/);
});

function approvedProject() {
  const dir = tmpRepo();
  writeFactory(dir, { agents: [fakeAgent('i'), fakeAgent('r', { caps: ['review'] })], roles: { implementers: ['i'], reviewers: ['r'] } });
  writeSpec(dir);
  writePlan(dir);
  return dir;
}

test('seal on an approved spec: text change sets draft, records ledger, lists stale plan criteria', () => {
  const dir = approvedProject();
  const specFile = path.join(dir, '.sf/spec.md');
  let spec = fs.readFileSync(specFile, 'utf8');
  assert.match(spec, /status: approved/);
  spec = spec.replace('The system shall provide feature alpha.', 'The system must provide feature alpha.')
    .replace('Feature beta output file contains the word ok', 'The output file of feature beta contains the word ok');
  fs.writeFileSync(specFile, spec);
  const r = node(STE, ['seal', '--json'], { cwd: dir });
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  const entry = out.report.find((e) => e.spec);
  assert.equal(entry.draft_set, true);
  assert.equal(entry.stale_plan_criteria.length, 1);
  assert.equal(entry.stale_plan_criteria[0].task, 'T-002');
  assert.match(fs.readFileSync(specFile, 'utf8'), /status: draft/);
  assert.doesNotMatch(fs.readFileSync(specFile, 'utf8'), /approved_at/);
  assert.match(fs.readFileSync(path.join(dir, '.sf/ledger.jsonl'), 'utf8'), /ste_applied/);
  // the plan now shows spec drift
  const lint = node(script('sf-plan-builder', 'plan.mjs'), ['lint'], { cwd: dir, allowFail: true });
  assert.equal(lint.code, 1);
  assert.match(lint.stdout, /spec drift/);
});

test('seal refuses a rewrite that changes IDs, criteria count or leaves style errors; nothing is recorded', () => {
  const dir = approvedProject();
  const specFile = path.join(dir, '.sf/spec.md');
  const original = fs.readFileSync(specFile, 'utf8');
  const ledgerBefore = fs.readFileSync(path.join(dir, '.sf/ledger.jsonl'), 'utf8');

  fs.writeFileSync(specFile, original.replace('### REQ-002:', '### REQ-022:'));
  let r = node(STE, ['seal'], { cwd: dir, allowFail: true });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /REQ-002 was removed or renamed/);

  fs.writeFileSync(specFile, original.replace('- Feature gamma output file contains the word ok', '- Feature gamma output file contains the word ok\n- The file ends with a new line'));
  r = node(STE, ['seal'], { cwd: dir, allowFail: true });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /criteria count changed/);

  fs.writeFileSync(specFile, original.replace('The system shall provide feature delta.', 'The system may provide feature delta.'));
  r = node(STE, ['seal'], { cwd: dir, allowFail: true });
  assert.equal(r.code, 1, 'a style error blocks the seal');
  assert.match(r.stdout, /style errors remaining: 1/);

  assert.equal(fs.readFileSync(path.join(dir, '.sf/ledger.jsonl'), 'utf8'), ledgerBefore, 'a failed seal records nothing');
});

test('dogfood: the README has no STE errors', () => {
  const r = node(STE, ['check', path.join(REPO, 'README.md'), '--root', REPO, '--json'], { cwd: REPO, allowFail: true });
  const j = JSON.parse(r.stdout);
  assert.equal(j.errors, 0, JSON.stringify(j.findings.filter((f) => f.severity === 'error'), null, 1));
});
