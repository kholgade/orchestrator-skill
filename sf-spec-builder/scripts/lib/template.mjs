// GENERATED COPY of sf-shared/lib — edit sf-shared/lib and run `npm run sync`.
// @ts-check
import { SfError } from './util.mjs';

function lookup(vars, dotted) {
  let cur = vars;
  for (const part of dotted.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Strict {{name}} / {{a.b}} substitution. Missing variables throw (no silent blanks).
 * Values that are null render as empty string; arrays/objects render as JSON.
 */
export function render(template, vars, { what = 'template' } = {}) {
  const missing = new Set();
  const out = template.replace(/\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g, (_m, name) => {
    const v = lookup(vars, name);
    if (v === undefined) {
      missing.add(name);
      return '';
    }
    if (v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
  if (missing.size) throw new SfError(`${what}: unknown variable(s) {{${[...missing].join('}}, {{')}}}`, { code: 'TEMPLATE' });
  return out;
}

/** Names of all {{placeholders}} used in a string. */
export function placeholders(text) {
  return [...String(text).matchAll(/\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g)].map((m) => m[1]);
}
