// @ts-check
// Review result validation and the deterministic PASS/FAIL verdict.
import fs from 'node:fs';
import { validate } from './validate.mjs';
import { reviewResultSchema } from './schemas.mjs';

const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

/** Extract the last JSON object from a fenced ```json block (or a bare JSON document) in text. */
export function extractJson(text) {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const b of blocks.reverse()) {
    try {
      const v = JSON.parse(b);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch { /* try previous block */ }
  }
  const start = text.lastIndexOf('{"task_id"');
  if (start >= 0) {
    try { return JSON.parse(text.slice(start)); } catch { /* fall through */ }
  }
  return null;
}

/** Read a review result from resultFile, falling back to stdout. Returns {result, source} or {result:null}. */
export function readReviewResult(resultFile, stdoutPath) {
  try {
    if (fs.existsSync(resultFile)) return { result: JSON.parse(fs.readFileSync(resultFile, 'utf8')), source: 'file' };
  } catch (e) {
    return { result: null, error: `result file is not valid JSON: ${e.message}` };
  }
  try {
    const r = extractJson(fs.readFileSync(stdoutPath, 'utf8'));
    if (r) return { result: r, source: 'stdout' };
  } catch { /* none */ }
  return { result: null, error: 'reviewer produced neither a result file nor a ```json block' };
}

/** Structural validation against the task. Returns error strings. */
export function checkReviewResult(result, task) {
  const errors = validate(result, reviewResultSchema, 'review');
  if (errors.length) return errors;
  if (result.task_id !== task.id) errors.push(`review.task_id "${result.task_id}" does not match task "${task.id}"`);
  const expected = task.acceptance_criteria.map(norm);
  const got = result.criteria.map((c) => norm(c.criterion));
  for (const e of expected) if (!got.includes(e)) errors.push(`review does not assess criterion: "${e.slice(0, 80)}"`);
  return errors;
}

/**
 * Deterministic verdict. PASS requires: reviewer PASS, every task criterion PASS, no blocking/major findings,
 * and (if provided) script evidence green. Returns {pass, reasons[], findings[]}.
 */
export function verdict(result, task, evidence) {
  const reasons = [];
  if (evidence && !evidence.ok) reasons.push('automated evidence failed (verify commands or write-scope check)');
  if (result.status !== 'PASS') reasons.push(`reviewer status is ${result.status}`);
  const byText = new Map(result.criteria.map((c) => [norm(c.criterion), c]));
  for (const c of task.acceptance_criteria) {
    const r = byText.get(norm(c));
    if (!r) reasons.push(`criterion not assessed: ${c}`);
    else if (r.status !== 'PASS') reasons.push(`criterion ${r.status}: ${c}${r.evidence ? ` — ${r.evidence}` : ''}`);
    else if (!r.evidence || r.evidence.trim().length < 3) reasons.push(`criterion PASS without evidence: ${c}`);
  }
  const blocking = result.findings.filter((f) => f.severity === 'blocking' || f.severity === 'major');
  for (const f of blocking) reasons.push(`${f.severity} finding: ${f.description}`);
  return { pass: reasons.length === 0, reasons, findings: result.findings };
}
