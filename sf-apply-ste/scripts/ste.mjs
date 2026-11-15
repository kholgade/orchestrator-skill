#!/usr/bin/env node
// sf-apply-ste: check and fix Simplified Technical English style in specs and design documents.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliMain, parseArgs, findRoot, printJson, SfError, exists, readText, atomicWrite, readJson, sha256 } from './lib/util.mjs';
import { softFactory } from './lib/factory.mjs';
import { parseSpec, lintSpec, contentHash } from './lib/spec.mjs';
import { ledgerAppend } from './lib/journal.mjs';
import { loadPlanRaw } from './lib/plan.mjs';
import { checkText, safeFix, expandPaths, loadSteConfig, loadDictionary } from './lib/ste.mjs';
import { SF_VERSION } from './lib/version.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OPTS = {
  root: { type: 'string' }, json: { type: 'boolean' }, write: { type: 'boolean' }, strict: { type: 'boolean' }, force: { type: 'boolean' },
  dictionary: { type: 'string' }, 'max-words': { type: 'string' }, help: { type: 'boolean', short: 'h' },
};
const USAGE = `sf-apply-ste ${SF_VERSION} — Simplified Technical English (ASD-STE100 style) for specs and design documents

Usage: node ste.mjs <command> [paths...] [options]
  init                         write .sf/ste.yaml (paths, limits, technical terms, optional word list)
  scope                        show the files and limits that apply
  check [paths] [--json] [--strict] [--dictionary f] [--max-words n]
                               find style problems; exit 1 on errors (--strict: warnings too)
  fix [paths] [--write]        mechanical, meaning-preserving fixes only (contractions, e.g./i.e., a few words); dry run unless --write
  seal [paths] [--force]       run after edits: re-check; for the spec verify IDs and format, set an approved spec back to draft,
                               list plan criteria that no longer match, and record the change in .sf/ledger.jsonl
Approximation of the standard: see references/ste-rules.md for what is and is not checked.`;

function resolve(root, cfg, values, positionals) {
  const targets = positionals.length ? positionals : cfg.paths;
  const files = expandPaths(targets, root, cfg.ignore);
  if (!files.length) throw new SfError(`No text documents found in: ${targets.join(', ')}`, { code: 'NO_FILES' });
  return files;
}

function checkAll(root, cfg, files, values) {
  const dictFile = values.dictionary ?? (cfg.dictionary ? cfg.dictionary : '');
  const dictionary = dictFile ? loadDictionary(path.resolve(root, dictFile)) : null;
  const config = { ...cfg, ...(values['max-words'] ? { max_words_descriptive: Number(values['max-words']) } : {}) };
  const all = [];
  const perFile = [];
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    const r = checkText(readText(f), { file: rel, config, dictionary });
    all.push(...r.findings);
    perFile.push({ file: rel, errors: r.findings.filter((x) => x.severity === 'error').length, warnings: r.findings.filter((x) => x.severity === 'warn').length, info: r.findings.filter((x) => x.severity === 'info').length, ...r.stats });
  }
  return { findings: all, perFile, vocabulary_checked: Boolean(dictionary) };
}

function setStatusDraft(text) {
  return text.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (_m, fm) => `---\n${fm.split(/\r?\n/).map((l) => (/^status:/.test(l) ? 'status: draft' : l)).filter((l) => !/^approved_at:/.test(l)).join('\n')}\n---`);
}

function sealSpec(root, file, paths) {
  const problems = [];
  const notes = [];
  const text = readText(file);
  const rel = path.relative(root, file).split(path.sep).join('/');
  const parsed = parseSpec(text, { filename: rel });
  const lint = lintSpec(parsed, { filename: rel });
  for (const e of lint.errors) problems.push(`spec lint: ${e}`);
  const index = exists(paths.specIndex) ? readJson(paths.specIndex) : null;
  const after = parsed.requirements;
  let stalePlan = [];
  let draftSet = false;
  if (index) {
    const beforeIds = index.requirements.map((r) => r.id);
    const afterIds = after.map((r) => r.id);
    for (const id of beforeIds) if (!afterIds.includes(id)) problems.push(`requirement ${id} was removed or renamed`);
    for (const id of afterIds) if (!beforeIds.includes(id)) problems.push(`requirement ${id} is new (a style rewrite must not add requirements)`);
    for (const r of after) {
      const old = index.requirements.find((x) => x.id === r.id);
      if (old && old.criteria.length !== r.criteria.length) problems.push(`${r.id}: criteria count changed (${old.criteria.length} → ${r.criteria.length}); confirm with the user, then re-plan`);
      if (old && (old.priority !== r.priority || old.type !== r.type)) problems.push(`${r.id}: type or priority changed`);
    }
    const changed = contentHash(parsed) !== index.spec_hash;
    if (changed) {
      notes.push('The spec text changed after it was indexed. The plan and the index are out of date.');
      if (parsed.meta.status === 'approved') {
        atomicWrite(file, setStatusDraft(text));
        draftSet = true;
        notes.push('The spec status is now "draft". The user must approve it again (sf-spec-builder: approve). Then run sf-plan-builder: rehash, review, and approve.');
      } else notes.push('The spec is not approved. Approve it, then run sf-plan-builder: rehash and approve.');
      if (exists(paths.plan)) {
        try {
          const plan = loadPlanRaw(paths.plan);
          const currentTexts = new Set(after.flatMap((r) => r.criteria.map((c) => c.text)));
          const oldTexts = new Set(index.requirements.flatMap((r) => r.criteria.map((c) => c.text)));
          for (const t of plan.tasks) for (const c of t.acceptance_criteria) if (oldTexts.has(c) && !currentTexts.has(c)) stalePlan.push({ task: t.id, criterion: c });
          if (stalePlan.length) notes.push(`${stalePlan.length} plan criterion text(s) no longer match the spec. Update them in plan.yaml (sf-plan-builder).`);
        } catch { /* plan unreadable: reported by the plan skill */ }
      }
    }
  } else notes.push('No spec index found; ID and drift checks were skipped.');
  return { problems, notes, stalePlan, draftSet, hash: contentHash(parsed) };
}

cliMain(async () => {
  const { values, positionals } = parseArgs(process.argv.slice(2), OPTS);
  const cmd = positionals[0];
  const rest = positionals.slice(1);
  if (!cmd || values.help) { console.log(USAGE); return cmd || values.help ? 0 : 2; }
  const root = findRoot(values.root);
  const cfg = loadSteConfig(root);
  const { paths } = softFactory(root);

  switch (cmd) {
    case 'init': {
      const dest = path.join(root, '.sf', 'ste.yaml');
      if (exists(dest) && !values.force) throw new SfError(`${dest} already exists (use --force)`);
      atomicWrite(dest, fs.readFileSync(path.join(here, '..', 'templates', 'ste.template.yaml'), 'utf8'));
      console.log(`Wrote ${dest}`);
      return 0;
    }
    case 'scope': {
      const files = resolve(root, cfg, values, rest);
      const out = { config: cfg._file ?? '(defaults)', limits: { descriptive: cfg.max_words_descriptive, procedural: cfg.max_words_procedural, paragraph_sentences: cfg.max_sentences_paragraph }, technical_terms: cfg.technical_terms, dictionary: cfg.dictionary || null, files: files.map((f) => path.relative(root, f)) };
      if (values.json) printJson(out); else console.log(JSON.stringify(out, null, 2));
      return 0;
    }
    case 'check': {
      const files = resolve(root, cfg, values, rest);
      const r = checkAll(root, cfg, files, values);
      const errors = r.findings.filter((f) => f.severity === 'error').length;
      const warns = r.findings.filter((f) => f.severity === 'warn').length;
      if (values.json) printJson({ ok: errors === 0 && (!values.strict || warns === 0), errors, warnings: warns, vocabulary_checked: r.vocabulary_checked, files: r.perFile, findings: r.findings });
      else {
        for (const f of r.findings) console.log(`${f.file}:${f.line} ${f.severity.toUpperCase().padEnd(5)} ${f.rule}: ${f.message}${f.suggestion ? ` → ${f.suggestion}` : ''}\n    ${f.excerpt}`);
        console.log(`\n${r.perFile.length} file(s): ${errors} error(s), ${warns} warning(s)${r.vocabulary_checked ? '' : '. Vocabulary was NOT checked (no word list; see references/ste-rules.md).'}`);
      }
      return errors || (values.strict && warns) ? 1 : 0;
    }
    case 'fix': {
      const files = resolve(root, cfg, values, rest);
      let total = 0;
      for (const f of files) {
        const before = readText(f);
        const { text, changes } = safeFix(before);
        if (!changes.length) continue;
        const n = changes.reduce((a, c) => a + c.count, 0);
        total += n;
        console.log(`${path.relative(root, f)}: ${n} change(s) — ${changes.map((c) => `${c.change} ×${c.count}`).join(', ')}`);
        if (values.write) atomicWrite(f, text);
      }
      console.log(total ? (values.write ? `Wrote ${total} change(s). Run "check" for the remaining problems, then "seal".` : `Dry run: ${total} change(s). Add --write to apply.`) : 'Nothing to fix mechanically.');
      return 0;
    }
    case 'seal': {
      const files = resolve(root, cfg, values, rest);
      const r = checkAll(root, cfg, files, values);
      const errors = r.findings.filter((f) => f.severity === 'error');
      let failed = errors.length > 0 && !values.force;
      const report = [];
      for (const f of files) {
        const rel = path.relative(root, f).split(path.sep).join('/');
        const entry = { file: rel, sha256: sha256(readText(f)) };
        if (path.resolve(f) === path.resolve(paths.spec)) {
          const s = sealSpec(root, f, paths);
          Object.assign(entry, { spec: true, draft_set: s.draftSet, problems: s.problems, notes: s.notes, stale_plan_criteria: s.stalePlan });
          if (s.problems.length) failed = true;
        }
        report.push(entry);
      }
      if (!failed) ledgerAppend(paths, 'ste_applied', { actor: 'agent:sf-apply-ste', msg: `STE style applied to ${files.length} file(s)`, data: { files: report, errors_remaining: errors.length } });
      if (values.json) printJson({ ok: !failed, errors: errors.length, report });
      else {
        console.log(`style errors remaining: ${errors.length}${errors.length ? ' (run "check")' : ''}`);
        for (const e of report) {
          console.log(`- ${e.file}${e.spec ? ' (spec)' : ''}`);
          for (const p of e.problems ?? []) console.log(`    PROBLEM: ${p}`);
          for (const n of e.notes ?? []) console.log(`    NOTE: ${n}`);
          for (const s of e.stale_plan_criteria ?? []) console.log(`    STALE PLAN CRITERION ${s.task}: ${s.criterion}`);
        }
        console.log(failed ? 'NOT SEALED. Fix the problems above.' : 'Sealed and recorded in .sf/ledger.jsonl.');
      }
      return failed ? 1 : 0;
    }
    default:
      throw new SfError(`Unknown command "${cmd}"\n${USAGE}`, { exitCode: 2 });
  }
});
