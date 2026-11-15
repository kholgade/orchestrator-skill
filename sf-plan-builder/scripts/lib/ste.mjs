// GENERATED COPY of sf-shared/lib — edit sf-shared/lib and run `npm run sync`.
// @ts-check
// Deterministic checks and safe fixes for Simplified Technical English (ASD-STE100) style.
// This is an APPROXIMATION built from published rule summaries, not the official specification or a certified checker.
// Covered: sentence length, paragraph length, contractions, ambiguous modal verbs, a curated list of non-STE words and
// phrases, ellipses, a passive-voice heuristic, and an optional word-list check. Not covered: noun-cluster length, verb tenses,
// -ing forms, and one-word-one-meaning. Those need a person or an agent (see sf-apply-ste/references/ste-rules.md).
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from './yaml.mjs';
import { validate } from './validate.mjs';
import { SfError } from './util.mjs';

export const STE_DEFAULTS = {
  max_words_descriptive: 25,
  max_words_procedural: 20,
  max_sentences_paragraph: 6,
  technical_terms: [],
  dictionary: '',
  paths: ['.sf/spec.md'],
  ignore: [],
};

const configSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sf: { const: 'ste/1' },
    paths: { type: 'array', items: { type: 'string' } },
    ignore: { type: 'array', items: { type: 'string' } },
    max_words_descriptive: { type: 'integer', minimum: 5, maximum: 60 },
    max_words_procedural: { type: 'integer', minimum: 5, maximum: 60 },
    max_sentences_paragraph: { type: 'integer', minimum: 1, maximum: 30 },
    technical_terms: { type: 'array', items: { type: 'string' } },
    dictionary: { type: 'string' },
  },
};

export function loadSteConfig(root) {
  const file = path.join(root, '.sf', 'ste.yaml');
  if (!fs.existsSync(file)) return { ...STE_DEFAULTS, _file: null };
  let raw;
  try {
    raw = parseYaml(fs.readFileSync(file, 'utf8'), { filename: file });
  } catch (e) {
    throw new SfError(e.message, { code: 'YAML' });
  }
  const errs = validate(raw ?? {}, configSchema);
  if (errs.length) throw new SfError(`Invalid ${file}`, { details: errs });
  return { ...STE_DEFAULTS, ...(raw ?? {}), _file: file };
}

// ------------------------------------------------------------------ rules data (curated; verify with the official dictionary)

/** word or phrase → suggestion. Matched case-insensitively on word boundaries. */
export const NON_STE = [
  ['utilize', 'use'], ['utilizes', 'uses'], ['utilized', 'used'], ['utilizing', 'using'], ['utilise', 'use'],
  ['leverage', 'use'], ['initiate', 'start'], ['commence', 'start'], ['terminate', 'stop'], ['ensure', 'make sure'],
  ['assist', 'help'], ['subsequently', 'then'], ['prior to', 'before'], ['in order to', 'to'], ['via', 'through, with, or by'],
  ['approximately', 'about'], ['e.g.', 'for example'], ['i.e.', 'that is'], ['etc.', 'list all the items'], ['etc', 'list all the items'],
  ['please', 'delete (use the imperative)'], ['robust', 'say what the system does'], ['seamless', 'say what the system does'],
  ['simply', 'delete'], ['just', 'delete or use "only"'], ['basically', 'delete'], ['as well as', 'and'], ['in addition', 'also'],
];
const MODALS = { may: 'use "can" (possible) or "must" (required)', might: 'use "can"', could: 'use "can"', should: 'use "must" (required) or rewrite', shall: 'use "must" (verify against the STE dictionary)' };
const CONTRACTION = /\b(?:\w+n't|\w+'ll|\w+'re|\w+'ve|\w+'d|I'm|let's|it's|that's|there's|here's|what's)\b/i;
const IRREGULAR_PARTICIPLES = 'made|done|shown|given|taken|written|chosen|broken|driven|kept|held|found|sent|built|put|set|run|known|seen|begun|left|lost|paid|read|told';
const PASSIVE = new RegExp(`\\b(?:is|are|was|were|be|been|being)\\s+(?:\\w{3,}ed|${IRREGULAR_PARTICIPLES})\\b`, 'i');
const ED_NOT_PARTICIPLE = new Set(['need', 'speed', 'feed', 'seed', 'indeed', 'proceed', 'succeed', 'exceed', 'embed']);

// ------------------------------------------------------------------ markdown → units

/** Split a markdown document into prose units (paragraphs, list items, headings, table cells). */
export function extractUnits(markdown) {
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/);
  const out = [];
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
    if (end > 0) i = end + 1;
  }
  let fence = null;
  let inComment = false;
  /** @type {{line:number,text:string[],kind:string}|null} */
  let cur = null;
  const flush = () => {
    if (cur) out.push({ line: cur.line, text: cur.text.join(' '), kind: cur.kind, procedural: cur.kind === 'ordered' });
    cur = null;
  };
  for (; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (inComment) { if (t.includes('-->')) inComment = false; continue; }
    if (t.startsWith('<!--')) { flush(); if (!t.includes('-->')) inComment = true; continue; }
    const fm = /^(```|~~~)/.exec(t);
    if (fm) { flush(); fence = fence ? (t.startsWith(fence) ? null : fence) : fm[1]; continue; }
    if (fence) continue;
    if (t === '') { flush(); continue; }
    if (/^#{1,6}\s/.test(t)) { flush(); out.push({ line: i + 1, text: t.replace(/^#{1,6}\s+/, ''), kind: 'heading', procedural: false }); continue; }
    if (t.startsWith('|')) {
      flush();
      if (/^\|?[\s:|-]+\|?$/.test(t)) continue;
      for (const cell of t.replace(/^\||\|$/g, '').split('|')) if (cell.trim()) out.push({ line: i + 1, text: cell.trim(), kind: 'cell', procedural: false });
      continue;
    }
    if (/^\[!\[/.test(t) || /^!\[/.test(t)) { flush(); continue; }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (li) { flush(); cur = { line: i + 1, text: [li[2]], kind: /\d/.test(li[1]) ? 'ordered' : 'list' }; continue; }
    const text = t.replace(/^>\s?/, '');
    if (cur && (cur.kind === 'list' || cur.kind === 'ordered') && /^\s{2,}/.test(raw)) cur.text.push(text);
    else if (cur && cur.kind === 'paragraph') cur.text.push(text);
    else { flush(); cur = { line: i + 1, text: [text], kind: 'paragraph' }; }
  }
  flush();
  return out;
}

/** Remove markup so only prose remains. Code becomes the token CODE. */
export function plain(text) {
  return text
    .replace(/`[^`]*`/g, 'CODE')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, 'URL')
    .replace(/\*\*|__/g, '')
    .replace(/(^|\s)\*(\S)/g, '$1$2')
    .replace(/(\S)\*(\s|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+(?=[A-Z("'\d])/).map((s) => s.trim()).filter(Boolean);
}

const wordCount = (s) => s.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;

// ------------------------------------------------------------------ check

/**
 * @param {string} text
 * @param {{file?:string, config?:any, dictionary?:Set<string>|null}} [o]
 */
export function checkText(text, { file = '<text>', config = STE_DEFAULTS, dictionary = null } = {}) {
  const cfg = { ...STE_DEFAULTS, ...config };
  const findings = [];
  const units = extractUnits(text);
  let sentences = 0;
  let words = 0;
  const unlisted = new Map();
  const terms = new Set(cfg.technical_terms.map((x) => x.toLowerCase()));
  const add = (line, rule, severity, message, suggestion, excerpt) => findings.push({ file, line, rule, severity, message, suggestion: suggestion ?? null, excerpt: excerpt.length > 110 ? `${excerpt.slice(0, 107)}...` : excerpt });

  for (const u of units) {
    const p = plain(u.text);
    if (!p) continue;
    const sents = splitSentences(p);
    if (u.kind === 'paragraph' && sents.length > cfg.max_sentences_paragraph) add(u.line, 'STE-PARA', 'warn', `paragraph has ${sents.length} sentences (limit ${cfg.max_sentences_paragraph})`, 'split the paragraph', p);
    for (const s of sents) {
      sentences += 1;
      const n = wordCount(s);
      words += n;
      const limit = u.procedural ? cfg.max_words_procedural : cfg.max_words_descriptive;
      if (u.kind !== 'heading' && n > limit) add(u.line, 'STE-LEN', 'error', `${u.procedural ? 'procedural' : 'descriptive'} sentence has ${n} words (limit ${limit})`, 'split into shorter sentences with one idea each', s);
      if (CONTRACTION.test(s)) add(u.line, 'STE-CONTRACTION', 'error', 'contraction', 'write the full words', s);
      for (const [w, sug] of Object.entries(MODALS)) {
        if (new RegExp(`\\b${w}\\b`, 'i').test(s)) add(u.line, 'STE-MODAL', w === 'shall' ? 'warn' : 'error', `ambiguous modal verb "${w}"`, sug, s);
      }
      for (const [w, sug] of NON_STE) {
        const re = new RegExp(`(^|[^\\w])${w.replace(/[.]/g, '\\.').replace(/ /g, '\\s+')}(?=$|[^\\w])`, 'i');
        if (re.test(s)) add(u.line, 'STE-WORD', 'error', `"${w}" is not a preferred STE word`, sug, s);
      }
      if (/\.\.\.|…/.test(s)) add(u.line, 'STE-ELLIPSIS', 'warn', 'ellipsis', 'list all the items or end the sentence', s);
      const pm = PASSIVE.exec(s);
      if (pm && !ED_NOT_PARTICIPLE.has(pm[0].split(/\s+/).pop().toLowerCase())) add(u.line, 'STE-PASSIVE', 'warn', `possible passive voice: "${pm[0]}"`, 'use the active voice: name the actor', s);
      if (dictionary) {
        for (const m of s.matchAll(/[A-Za-z][A-Za-z-]+/g)) {
          const w = m[0].toLowerCase();
          if (w === 'code' || w === 'url' || /^[A-Z]{2,}/.test(m[0]) || terms.has(w) || inDictionary(w, dictionary)) continue;
          if (!unlisted.has(w)) unlisted.set(w, u.line);
        }
      }
    }
  }
  if (unlisted.size) {
    const list = [...unlisted.entries()].slice(0, 40).map(([w, l]) => `${w}(${l})`).join(', ');
    add(0, 'STE-DICT', 'info', `${unlisted.size} word(s) not found in the word list (word lists need inflection handling; expect false positives)`, 'replace with an approved word, or add a technical term to .sf/ste.yaml', list);
  }
  return { findings, stats: { units: units.length, sentences, words } };
}

function inDictionary(w, dict) {
  if (dict.has(w)) return true;
  for (const suf of ['s', 'es', 'ed', 'd', 'ing', 'ly', 'er', 'est']) if (w.endsWith(suf) && dict.has(w.slice(0, -suf.length))) return true;
  if (w.endsWith('ies') && dict.has(`${w.slice(0, -3)}y`)) return true;
  if (w.endsWith('ied') && dict.has(`${w.slice(0, -3)}y`)) return true;
  return false;
}

export function loadDictionary(file) {
  const text = fs.readFileSync(file, 'utf8');
  return new Set(text.split(/\r?\n/).map((l) => l.split(/[\t,;]/)[0].trim().toLowerCase()).filter((l) => l && !l.startsWith('#')));
}

// ------------------------------------------------------------------ files

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc']);

function globToRegex(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { i++; if (g[i + 1] === '/') i++; re += '(?:.*/)?'; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|\\[\]]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Expand files and directories to a sorted list of text documents (absolute paths). */
export function expandPaths(targets, root, ignore = []) {
  const ig = ignore.map(globToRegex);
  const out = new Set();
  const visit = (p) => {
    const abs = path.resolve(root, p);
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (ig.some((r) => r.test(rel))) return;
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(abs)) {
        if (['.git', 'node_modules', '.sf'].includes(e) && abs !== path.join(root, '.sf')) continue;
        if (e === 'runtime' || e === 'archive') continue;
        visit(path.join(abs, e));
      }
    } else if (TEXT_EXT.has(path.extname(abs).toLowerCase())) out.add(abs);
  };
  for (const t of targets) visit(t);
  return [...out].sort();
}

// ------------------------------------------------------------------ safe fixes

const SAFE_MAP = [
  [/\bcan't\b/gi, 'cannot'], [/\bwon't\b/gi, 'will not'], [/\blet's\b/gi, 'let us'],
  [/\b(do|does|did|is|are|was|were|has|have|had|would|could|should|must)n't\b/gi, '$1 not'],
  [/\b(I|we|you|they|he|she|that|it)'ll\b/gi, '$1 will'], [/\b(you|we|they)'re\b/gi, '$1 are'],
  [/\b(I|we|you|they)'ve\b/gi, '$1 have'], [/\bI'm\b/g, 'I am'],
  [/\be\.g\./gi, 'for example'], [/\bi\.e\./gi, 'that is'],
  [/\butili[sz]e\b/gi, 'use'], [/\butili[sz]es\b/gi, 'uses'], [/\butili[sz]ed\b/gi, 'used'], [/\butili[sz]ing\b/gi, 'using'],
  [/\bprior to\b/gi, 'before'], [/\bin order to\b/gi, 'to'],
];

function matchCase(from, to) {
  return /^[A-Z]/.test(from) ? to.charAt(0).toUpperCase() + to.slice(1) : to;
}

/** Apply a transform to prose only: skips fences, front matter, comments, inline code, link targets, URLs, tags. */
export function mapProse(text, fn) {
  const lines = text.split(/\r?\n/);
  let i = 0;
  const out = [];
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
    if (end > 0) { out.push(...lines.slice(0, end + 1)); i = end + 1; }
  }
  let fence = null;
  let inComment = false;
  for (; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (inComment) { out.push(raw); if (t.includes('-->')) inComment = false; continue; }
    if (t.startsWith('<!--')) { out.push(raw); if (!t.includes('-->')) inComment = true; continue; }
    const fm = /^(```|~~~)/.exec(t);
    if (fm) { fence = fence ? (t.startsWith(fence) ? null : fence) : fm[1]; out.push(raw); continue; }
    if (fence) { out.push(raw); continue; }
    out.push(raw.split(/(`[^`]*`|\]\([^)]*\)|https?:\/\/\S+|<[^>]+>)/).map((seg, k) => (k % 2 ? seg : fn(seg))).join(''));
  }
  return out.join('\n');
}

/** Mechanical, meaning-preserving fixes only. Returns the new text and a change summary. Idempotent. */
export function safeFix(text) {
  const changes = new Map();
  const next = mapProse(text, (seg) => {
    let s = seg;
    for (const [re, to] of SAFE_MAP) {
      s = s.replace(re, (m, ...g) => {
        const rep = to.replace(/\$(\d)/g, (_x, n) => g[Number(n) - 1] ?? '');
        const r = matchCase(m, rep);
        changes.set(`${m.toLowerCase()} → ${r.toLowerCase()}`, (changes.get(`${m.toLowerCase()} → ${r.toLowerCase()}`) ?? 0) + 1);
        return r;
      });
    }
    return s;
  });
  return { text: next, changes: [...changes.entries()].map(([k, n]) => ({ change: k, count: n })) };
}
