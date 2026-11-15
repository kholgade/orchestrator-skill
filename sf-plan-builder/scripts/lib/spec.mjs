// GENERATED COPY of sf-shared/lib — edit sf-shared/lib and run `npm run sync`.
// @ts-check
// Spec format: Markdown with YAML front matter and "### REQ-xxx: Title" requirement blocks.
// This module parses, lints and indexes a spec deterministically. See sf-spec-builder/references/spec-format.md.
import { parse as parseYaml } from './yaml.mjs';
import { validate } from './validate.mjs';
import { SfError, sha256, nowIso, readText, exists, isPlainObject } from './util.mjs';

export const REQ_ID = /^REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
export const REQ_TYPES = ['functional', 'nfr', 'constraint', 'interface', 'data', 'security'];
export const PRIORITIES = ['must', 'should', 'could'];

const frontMatterSchema = {
  type: 'object',
  required: ['sf', 'title', 'status', 'version'],
  additionalProperties: false,
  properties: {
    sf: { const: 'spec/1' },
    title: { type: 'string', minLength: 1 },
    status: { enum: ['draft', 'approved'] },
    version: { type: 'integer', minimum: 1 },
    approved_at: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
  },
};

const WEASEL = ['fast', 'quick', 'quickly', 'easy', 'easily', 'user-friendly', 'intuitive', 'robust', 'scalable', 'seamless', 'efficient', 'efficiently', 'appropriate', 'as needed', 'etc', 'and so on', 'good', 'nice', 'modern', 'flexible'];
const PLACEHOLDER = /\b(TBD|TODO|FIXME)\b|\?\?\?/;

function splitFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ''));
  if (!m) throw new SfError('Spec must begin with a YAML front matter block delimited by "---" lines', { code: 'SPEC_FORMAT' });
  const fmLines = m[1].split(/\r?\n/).length + 2;
  return { fm: m[1], body: m[2], bodyOffset: fmLines };
}

/**
 * Parse a spec document.
 * @returns {{meta:any, body:string, requirements:any[], openQuestions:any[], errors:string[], warnings:string[]}}
 */
export function parseSpec(text, { filename = 'spec.md' } = {}) {
  const errors = [];
  const warnings = [];
  const { fm, body, bodyOffset } = splitFrontMatter(text);
  let meta;
  try {
    meta = parseYaml(fm, { filename: `${filename} (front matter)` });
  } catch (e) {
    throw new SfError(e.message, { code: 'SPEC_FORMAT' });
  }
  if (!isPlainObject(meta)) throw new SfError('Spec front matter must be a YAML mapping', { code: 'SPEC_FORMAT' });
  for (const e of validate(meta, frontMatterSchema, 'front matter')) errors.push(e);

  const lines = body.split(/\r?\n/);
  const requirements = [];
  const openQuestions = [];
  let section = '';
  let cur = null;
  let mode = 'meta';
  let inFence = false;
  let sawRequirementsSection = false;

  const flush = () => {
    if (!cur) return;
    cur.statement = cur.statementLines.join('\n').trim();
    delete cur.statementLines;
    requirements.push(cur);
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1 + bodyOffset;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      if (cur && mode !== 'criteria') {
        if (mode === 'meta') mode = 'statement';
        pushStatement(line);
      }
      continue;
    }
    if (inFence) {
      if (cur && mode !== 'criteria') pushStatement(line);
      continue;
    }
    const h2 = /^##\s+(.+?)\s*#*$/.exec(line);
    if (h2 && !line.startsWith('###')) {
      flush();
      section = h2[1].trim().toLowerCase();
      if (section === 'requirements') sawRequirementsSection = true;
      continue;
    }
    const h3 = /^###\s+(.+?)\s*#*$/.exec(line);
    if (h3 && section === 'requirements') {
      flush();
      const hm = /^(\S+?)\s*[:—–-]\s+(.+)$/.exec(h3[1]);
      if (!hm) {
        errors.push(`${filename}:${lineNo}: requirement heading must look like "### REQ-001: Title" (got "${h3[1]}")`);
        cur = null;
        continue;
      }
      if (!REQ_ID.test(hm[1])) errors.push(`${filename}:${lineNo}: invalid requirement id "${hm[1]}" (expected e.g. REQ-001 or REQ-AUTH-001)`);
      cur = { id: hm[1], title: hm[2].trim(), type: null, priority: null, source: null, depends: [], statementLines: [], criteria: [], line: lineNo };
      mode = 'meta';
      continue;
    }
    if (section === 'open questions') {
      const q = /^\s*[-*]\s+\[( |x|X)\]\s+(Q-[A-Za-z0-9-]+)\s*:\s*(.+)$/.exec(line);
      if (q) openQuestions.push({ id: q[2], text: q[3].trim(), resolved: q[1] !== ' ', line: lineNo });
      else if (/^\s*[-*]\s+\S/.test(line)) errors.push(`${filename}:${lineNo}: open question must look like "- [ ] Q-001: question text"`);
      continue;
    }
    if (!cur) continue;

    const crit = /^(?:\*\*|####\s*)?\s*acceptance criteria\s*(?:\*\*)?\s*:?\s*(?:\*\*)?\s*$/i.test(line.trim());
    if (crit) {
      mode = 'criteria';
      continue;
    }
    if (mode === 'meta') {
      const meta2 = /^\s*[-*]\s*(type|priority|source|depends)\s*:\s*(.*)$/i.exec(line);
      if (meta2) {
        const k = meta2[1].toLowerCase();
        const v = meta2[2].trim();
        if (k === 'type') cur.type = v.toLowerCase();
        else if (k === 'priority') cur.priority = v.toLowerCase();
        else if (k === 'source') cur.source = v;
        else cur.depends = v.split(/[\s,]+/).filter(Boolean);
        continue;
      }
      if (line.trim() === '') {
        pushStatement(line);
        continue;
      }
      mode = 'statement';
      pushStatement(line);
      continue;
    }
    if (mode === 'statement') {
      pushStatement(line);
      continue;
    }
    if (mode === 'criteria') {
      const b = /^(\s*)(?:[-*]|\d+[.)])\s+(.+)$/.exec(line);
      if (b && b[1].length < 2) {
        cur.criteria.push({ id: `${cur.id}.${cur.criteria.length + 1}`, text: b[2].trim(), line: lineNo });
      } else if (line.trim() === '') {
        /* blank */
      } else if (/^\s{2,}\S/.test(line) && cur.criteria.length) {
        appendCont(line);
      } else {
        errors.push(`${filename}:${lineNo}: unexpected text after "Acceptance criteria" (use bullet items): "${line.trim().slice(0, 60)}"`);
      }
    }
  }
  flush();

  function pushStatement(l) {
    cur.statementLines.push(l);
  }
  function appendCont(l) {
    const last = cur.criteria[cur.criteria.length - 1];
    if (last) last.text += ' ' + l.trim();
  }

  if (!sawRequirementsSection) errors.push(`${filename}: missing "## Requirements" section`);
  return { meta, body, requirements, openQuestions, errors, warnings };
}

/** Lint a parsed spec. Returns {errors, warnings} (including parse errors). */
export function lintSpec(parsed, { filename = 'spec.md' } = {}) {
  const errors = [...parsed.errors];
  const warnings = [...parsed.warnings];
  const ids = new Map();
  if (!parsed.requirements.length) errors.push(`${filename}: no requirements found under "## Requirements"`);
  for (const r of parsed.requirements) {
    const at = `${filename}:${r.line} ${r.id}`;
    if (ids.has(r.id)) errors.push(`${at}: duplicate requirement id (first at line ${ids.get(r.id)})`);
    ids.set(r.id, r.line);
    if (!r.type) errors.push(`${at}: missing "- Type: ..." (${REQ_TYPES.join('|')})`);
    else if (!REQ_TYPES.includes(r.type)) errors.push(`${at}: invalid Type "${r.type}" (${REQ_TYPES.join('|')})`);
    if (!r.priority) errors.push(`${at}: missing "- Priority: ..." (${PRIORITIES.join('|')})`);
    else if (!PRIORITIES.includes(r.priority)) errors.push(`${at}: invalid Priority "${r.priority}" (${PRIORITIES.join('|')})`);
    if (!r.statement) errors.push(`${at}: empty statement`);
    if (!r.criteria.length) errors.push(`${at}: needs at least one acceptance criterion under "**Acceptance criteria**"`);
    for (const text of [r.statement, ...r.criteria.map((c) => c.text)]) {
      if (PLACEHOLDER.test(text)) errors.push(`${at}: unresolved placeholder (TBD/TODO/FIXME/???) in "${text.slice(0, 60)}"`);
    }
    const seen = new Set();
    for (const c of r.criteria) {
      if (c.text.length < 8) warnings.push(`${filename}:${c.line} ${c.id}: criterion is very short; make it verifiable`);
      const low = c.text.toLowerCase();
      if (seen.has(low)) warnings.push(`${filename}:${c.line} ${c.id}: duplicate criterion text`);
      seen.add(low);
      for (const w of WEASEL) {
        if (new RegExp(`(^|[^a-z-])${w.replace(/ /g, '\\s+')}([^a-z-]|$)`, 'i').test(c.text) && !/\d/.test(c.text)) {
          warnings.push(`${filename}:${c.line} ${c.id}: vague word "${w}" without a measurable value`);
          break;
        }
      }
    }
  }
  for (const r of parsed.requirements) {
    for (const d of r.depends) if (!ids.has(d)) errors.push(`${filename}:${r.line} ${r.id}: depends on unknown requirement "${d}"`);
  }
  const qids = new Set();
  for (const q of parsed.openQuestions) {
    if (qids.has(q.id)) errors.push(`${filename}:${q.line}: duplicate open question id ${q.id}`);
    qids.add(q.id);
  }
  return { errors, warnings };
}

export function contentHash(parsed) {
  return sha256(parsed.body.replace(/\r\n/g, '\n').trim());
}

/** Build the machine-readable index consumed by the plan builder and orchestrator. */
export function buildIndex(parsed, { specPath }) {
  return {
    sf: 'spec-index/1',
    spec_path: specPath,
    spec_hash: contentHash(parsed),
    generated_at: nowIso(),
    title: parsed.meta.title,
    status: parsed.meta.status,
    version: parsed.meta.version,
    requirements: parsed.requirements.map((r) => ({
      id: r.id, title: r.title, type: r.type, priority: r.priority, source: r.source, depends: r.depends,
      statement: r.statement,
      criteria: r.criteria.map((c) => ({ id: c.id, text: c.text })),
    })),
    open_questions: parsed.openQuestions.map((q) => ({ id: q.id, text: q.text, resolved: q.resolved })),
  };
}

/** Load + lint a spec file. Throws SfError with all findings when there are errors. */
export function loadSpec(file, { requireApproved = false } = {}) {
  if (!exists(file)) throw new SfError(`Spec not found: ${file}`, { code: 'NO_SPEC' });
  const parsed = parseSpec(readText(file), { filename: file });
  const { errors, warnings } = lintSpec(parsed, { filename: file });
  if (requireApproved && parsed.meta.status !== 'approved') errors.push(`${file}: spec status is "${parsed.meta.status}", must be "approved"`);
  if (errors.length) throw new SfError(`Spec has ${errors.length} error(s)`, { code: 'BAD_SPEC', details: errors });
  return { parsed, warnings };
}
