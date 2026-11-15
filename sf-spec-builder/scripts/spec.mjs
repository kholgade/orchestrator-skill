#!/usr/bin/env node
// sf-spec-builder: scaffold, generate, lint, index, approve and (optionally) delegate authoring of the spec.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliMain, parseArgs, findRoot, sfPaths, printJson, SfError, exists, atomicWrite, readText, writeJson, nowIso } from './lib/util.mjs';
import { stringify } from './lib/yaml.mjs';
import { validate } from './lib/validate.mjs';
import { loadFactory, loadYamlFile, softFactory } from './lib/factory.mjs';
import { parseSpec, lintSpec, buildIndex, REQ_ID, REQ_TYPES, PRIORITIES } from './lib/spec.mjs';
import { render } from './lib/template.mjs';
import { delegateAuthoring } from './lib/delegate.mjs';
import { CONFIRM_OPTIONS, confirmAction } from './lib/confirm.mjs';
import { ledgerAppend } from './lib/journal.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillFile = (...p) => path.join(here, '..', ...p);

const OPTS = {
  root: { type: 'string' }, json: { type: 'boolean' }, force: { type: 'boolean' },
  title: { type: 'string' }, answers: { type: 'string' }, out: { type: 'string' },
  sources: { type: 'string' }, rounds: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  ...CONFIRM_OPTIONS,
};

const USAGE = `sf-spec-builder — produce a lint-clean, machine-indexable specification

Usage: node spec.mjs <command> [options]
  init [--title T]            scaffold .sf/spec.md from the template (draft)
  from-answers <answers.yaml> generate spec.md deterministically from a structured answers file
  lint [--json]               validate format, ids, criteria, placeholders (exit 1 on errors)
  index                       lint, then write .sf/spec.index.json
  approve                     require clean lint + no open questions + user confirmation, set status: approved, write index
  status [--json]             summary of the current spec (also lists interview drafts in .sf/drafts/)
  brief --out <file> [--answers f] [--sources a,b]   render the authoring brief for an external agent
  delegate [--answers f] [--sources a,b] [--rounds n]  run roles.spec_author agent, validate, retry on findings
Options: --root <dir>  --force
Confirmation (approve): interactive terminal prompt, or --confirmed-by user|external:<id> [--via name] [--quote "user's words"] after asking the user.`;

const answersSchema = {
  type: 'object',
  required: ['title', 'requirements'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1 },
    goal: { type: 'string' },
    overview: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
    scope: { type: 'object', additionalProperties: false, properties: { in: { type: 'array', items: { type: 'string' } }, out: { type: 'array', items: { type: 'string' } } } },
    assumptions: { type: 'array', items: { type: 'string' } },
    glossary: { type: 'array', items: { type: 'object', required: ['term', 'definition'], additionalProperties: false, properties: { term: { type: 'string' }, definition: { type: 'string' } } } },
    requirements: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', required: ['title', 'statement', 'criteria'], additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: REQ_ID.source }, title: { type: 'string', minLength: 1 },
          type: { enum: REQ_TYPES, default: 'functional' }, priority: { enum: PRIORITIES, default: 'must' },
          statement: { type: 'string', minLength: 3 }, criteria: { type: 'array', minItems: 1, items: { type: 'string', minLength: 3 } },
          source: { type: 'string' }, depends: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    open_questions: { type: 'array', items: { type: 'object', required: ['text'], additionalProperties: false, properties: { id: { type: 'string' }, text: { type: 'string' }, resolved: { type: 'boolean' } } } },
  },
};

function generateFromAnswers(a) {
  const L = [];
  L.push('---', 'sf: spec/1', `title: ${stringify(a.title).trim()}`, 'status: draft', 'version: 1');
  if (a.sources?.length) L.push('sources:', ...a.sources.map((s) => `  - ${stringify(s).trim()}`));
  L.push('---', '', `# ${a.title}`, '');
  if (a.goal || a.overview) L.push('## Overview', '', [a.goal, a.overview].filter(Boolean).join('\n\n'), '');
  if (a.scope) {
    L.push('## Scope', '');
    if (a.scope.in?.length) L.push('**In scope**', ...a.scope.in.map((s) => `- ${s}`), '');
    if (a.scope.out?.length) L.push('**Out of scope**', ...a.scope.out.map((s) => `- ${s}`), '');
  }
  if (a.assumptions?.length) L.push('## Assumptions', '', ...a.assumptions.map((s) => `- ${s}`), '');
  if (a.glossary?.length) L.push('## Glossary', '', ...a.glossary.map((g) => `- **${g.term}**: ${g.definition}`), '');
  L.push('## Requirements', '');
  let n = 0;
  const used = new Set(a.requirements.map((r) => r.id).filter(Boolean));
  for (const r of a.requirements) {
    let id = r.id;
    while (!id) {
      n++;
      const cand = `REQ-${String(n).padStart(3, '0')}`;
      if (!used.has(cand)) { id = cand; used.add(cand); }
    }
    L.push(`### ${id}: ${r.title}`, `- Type: ${r.type ?? 'functional'}`, `- Priority: ${r.priority ?? 'must'}`);
    if (r.source) L.push(`- Source: ${r.source}`);
    if (r.depends?.length) L.push(`- Depends: ${r.depends.join(', ')}`);
    L.push('', r.statement.trim(), '', '**Acceptance criteria**', ...r.criteria.map((c) => `- ${c}`), '');
  }
  L.push('## Open questions', '');
  if (a.open_questions?.length) {
    let q = 0;
    for (const oq of a.open_questions) L.push(`- [${oq.resolved ? 'x' : ' '}] ${oq.id ?? `Q-${String(++q).padStart(3, '0')}`}: ${oq.text}`);
  } else L.push('_None._');
  L.push('');
  return L.join('\n');
}

function loadAndLint(root, { quiet = false } = {}) {
  const p = softFactory(root).paths;
  if (!exists(p.spec)) throw new SfError(`No spec at ${p.spec}. Run "init", "from-answers", or author it with the sf-spec-builder skill.`, { code: 'NO_SPEC' });
  const parsed = parseSpec(readText(p.spec), { filename: path.relative(root, p.spec) });
  const res = lintSpec(parsed, { filename: path.relative(root, p.spec) });
  if (!quiet) for (const w of res.warnings) console.log(`WARN: ${w}`);
  return { p, parsed, ...res };
}

function setFrontMatter(text, updates) {
  return text.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (_m, fm) => {
    let lines = fm.split(/\r?\n/);
    for (const [k, v] of Object.entries(updates)) {
      const re = new RegExp(`^${k}:`);
      const i = lines.findIndex((l) => re.test(l));
      const line = `${k}: ${v}`;
      if (i >= 0) lines[i] = line;
      else lines.push(line);
    }
    return `---\n${lines.join('\n')}\n---`;
  });
}

function sourceList(values) {
  return values.sources ? values.sources.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

function renderBrief(root, p, values) {
  const answers = values.answers ? readText(path.resolve(values.answers)) : '(none supplied — derive everything from the sources and the instructions)';
  const sources = sourceList(values);
  return render(readText(skillFile('templates', 'spec-brief.md')), {
    spec_path: p.spec,
    format_reference: readText(skillFile('references', 'spec-format.md')),
    answers,
    sources: sources.length ? sources.map((s) => `- ${s}`).join('\n') : '(none listed — inspect the repository for relevant documents)',
    root,
  }, { what: 'spec-brief template' });
}

cliMain(async () => {
  const { values, positionals } = parseArgs(process.argv.slice(2), OPTS);
  const cmd = positionals[0];
  if (!cmd || values.help) { console.log(USAGE); return cmd || values.help ? 0 : 2; }
  const root = findRoot(values.root);
  const p = softFactory(root).paths;

  switch (cmd) {
    case 'init': {
      if (exists(p.spec) && !values.force) throw new SfError(`${p.spec} already exists (use --force to overwrite)`);
      atomicWrite(p.spec, render(readText(skillFile('templates', 'spec.template.md')), { title: values.title ?? 'Project Specification' }));
      console.log(`Scaffolded ${p.spec}. Fill it in, then run: lint`);
      return 0;
    }
    case 'from-answers': {
      const file = positionals[1] ?? path.join(p.drafts, 'spec.answers.yaml');
      if (!exists(file)) throw new SfError(`from-answers needs an answers YAML file (default draft location: ${path.join(p.drafts, 'spec.answers.yaml')})`, { exitCode: 2 });
      if (exists(p.spec) && !values.force) throw new SfError(`${p.spec} already exists (use --force to overwrite)`);
      const a = loadYamlFile(path.resolve(file));
      const errs = validate(a, answersSchema, 'answers');
      if (errs.length) throw new SfError(`Invalid answers file ${file}`, { details: errs });
      atomicWrite(p.spec, generateFromAnswers(a));
      console.log(`Generated ${p.spec} from ${file}`);
      const { errors, warnings } = lintSpec(parseSpec(readText(p.spec)), { filename: path.relative(root, p.spec) });
      for (const w of warnings) console.log(`WARN: ${w}`);
      if (errors.length) { for (const e of errors) console.log(`ERROR: ${e}`); return 1; }
      console.log('Lint clean.');
      return 0;
    }
    case 'lint': {
      const r = loadAndLint(root, { quiet: values.json });
      if (values.json) printJson({ ok: r.errors.length === 0, errors: r.errors, warnings: r.warnings, requirements: r.parsed.requirements.length });
      else if (r.errors.length) for (const e of r.errors) console.log(`ERROR: ${e}`);
      else console.log(`Spec OK: ${r.parsed.requirements.length} requirement(s), ${r.parsed.requirements.reduce((n, x) => n + x.criteria.length, 0)} criteria.`);
      return r.errors.length ? 1 : 0;
    }
    case 'index': {
      const r = loadAndLint(root);
      if (r.errors.length) throw new SfError(`Spec has ${r.errors.length} error(s)`, { details: r.errors });
      const idx = buildIndex(r.parsed, { specPath: path.relative(root, p.spec).split(path.sep).join('/') });
      writeJson(p.specIndex, idx);
      console.log(`Wrote ${p.specIndex} (hash ${idx.spec_hash.slice(0, 12)}…)`);
      return 0;
    }
    case 'approve': {
      const r = loadAndLint(root);
      const problems = [...r.errors];
      for (const q of r.parsed.openQuestions) if (!q.resolved) problems.push(`open question ${q.id} is unresolved: ${q.text}`);
      if (problems.length) throw new SfError('Cannot approve spec', { details: problems });
      const who = await confirmAction({ values, word: 'approve spec', summary: `Approve specification "${r.parsed.meta.title}" v${r.parsed.meta.version}: ${r.parsed.requirements.length} requirement(s), ${r.parsed.requirements.reduce((n, x) => n + x.criteria.length, 0)} criteria.` });
      atomicWrite(p.spec, setFrontMatter(readText(p.spec), { status: 'approved', approved_at: `"${nowIso()}"` }));
      const again = loadAndLint(root, { quiet: true });
      const idx = buildIndex(again.parsed, { specPath: path.relative(root, p.spec).split(path.sep).join('/') });
      writeJson(p.specIndex, idx);
      ledgerAppend(p, 'spec_approved', { actor: who.confirmed_by, msg: `spec "${idx.title}" v${idx.version} approved`, data: { spec_hash: idx.spec_hash, version: idx.version, requirements: idx.requirements.length, who } });
      console.log(`Spec approved; index written to ${p.specIndex}. Plan builder may now run.`);
      return 0;
    }
    case 'status': {
      if (!exists(p.spec)) {
        const d = exists(p.drafts) ? fs.readdirSync(p.drafts) : [];
        const st0 = { exists: false, drafts: d };
        if (values.json) printJson(st0); else console.log(`exists: false\ndrafts: ${d.join(', ') || '(none)'}`);
        return 0;
      }
      const r = loadAndLint(root, { quiet: true });
      const open = r.parsed.openQuestions.filter((q) => !q.resolved).length;
      const drafts = exists(p.drafts) ? fs.readdirSync(p.drafts) : [];
      const st = { exists: true, drafts, status: r.parsed.meta.status, requirements: r.parsed.requirements.length, open_questions: open, lint_errors: r.errors.length, lint_warnings: r.warnings.length, indexed: exists(p.specIndex) };
      if (values.json) printJson(st);
      else console.log(Object.entries(st).map(([k, v]) => `${k}: ${v}`).join('\n'));
      return 0;
    }
    case 'brief': {
      if (!values.out) throw new SfError('brief needs --out <file>', { exitCode: 2 });
      atomicWrite(path.resolve(values.out), renderBrief(root, p, values));
      console.log(`Wrote brief to ${values.out}`);
      return 0;
    }
    case 'delegate': {
      const { factory, paths } = loadFactory(root);
      const brief = renderBrief(root, paths, values);
      const check = () => { const r = loadAndLint(root, { quiet: true }); return { errors: r.errors, warnings: r.warnings }; };
      const res = await delegateAuthoring({ root, factory, paths, agentId: factory.roles.spec_author, label: 'spec', brief, check, maxRounds: values.rounds ? Number(values.rounds) : 3 });
      ledgerAppend(paths, 'delegate_completed', { actor: `agent:${factory.roles.spec_author}`, msg: `spec delegate ${res.ok ? 'converged' : 'failed'}`, data: { ok: res.ok, rounds: res.rounds, errors: res.errors } });
      if (res.ok) { console.log(`Spec authored by ${factory.roles.spec_author} in ${res.rounds.length} round(s). Review it, resolve open questions, then run: approve`); return 0; }
      console.log(`Delegated authoring did not converge after ${res.rounds.length} round(s):`);
      for (const e of res.errors) console.log(`  - ${e}`);
      return 1;
    }
    default:
      throw new SfError(`Unknown command "${cmd}"\n${USAGE}`, { exitCode: 2 });
  }
});
