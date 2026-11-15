// @ts-check
// Tiny JSON-Schema-subset validator with "did you mean" hints for unknown fields.
// Supported keywords: type, enum, const, pattern, minLength, minimum, maximum, minItems, uniqueItems,
// items, properties, required, additionalProperties(false|schema), anyOf, default (via applyDefaults).
import { closest, isPlainObject } from './util.mjs';

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

/**
 * @param {any} value
 * @param {any} schema
 * @param {string} [at]
 * @returns {string[]} error messages (empty when valid)
 */
export function validate(value, schema, at = '$') {
  const errors = [];
  walk(value, schema, at, errors);
  return errors;
}

function walk(value, schema, at, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.anyOf) {
    const attempts = schema.anyOf.map((s) => {
      const e = [];
      walk(value, s, at, e);
      return e;
    });
    if (!attempts.some((e) => e.length === 0)) {
      const best = attempts.reduce((a, b) => (a.length <= b.length ? a : b));
      errors.push(`${at}: does not match any allowed form (closest: ${best[0] ?? 'n/a'})`);
    }
    return;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push(`${at}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
      return;
    }
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) {
    const hint = typeof value === 'string' ? closest(value, schema.enum.filter((x) => typeof x === 'string')) : null;
    errors.push(`${at}: must be one of ${schema.enum.map((x) => JSON.stringify(x)).join(', ')}${hint ? ` (did you mean "${hint}"?)` : ''}`);
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: "${value}" does not match ${schema.patternHint ?? schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: must not be shorter than ${schema.minLength} characters`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: needs at least ${schema.minItems} item(s)`);
    if (schema.uniqueItems) {
      const seen = new Set();
      for (const v of value) {
        const k = JSON.stringify(v);
        if (seen.has(k)) errors.push(`${at}: duplicate item ${k}`);
        seen.add(k);
      }
    }
    if (schema.items) value.forEach((v, i) => walk(v, schema.items, `${at}[${i}]`, errors));
  }
  if (isPlainObject(value)) {
    const props = schema.properties ?? {};
    for (const req of schema.required ?? []) {
      if (!Object.hasOwn(value, req) || value[req] === undefined) errors.push(`${at}.${req}: required field is missing`);
    }
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) walk(v, props[k], `${at}.${k}`, errors);
      else if (schema.additionalProperties === false) {
        const hint = closest(k, Object.keys(props));
        errors.push(`${at}.${k}: unknown field${hint ? ` (did you mean "${hint}"?)` : ''}`);
      } else if (isPlainObject(schema.additionalProperties)) walk(v, schema.additionalProperties, `${at}.${k}`, errors);
    }
  }
}

/** Return a deep copy of value with schema `default`s filled in for missing object fields. */
export function applyDefaults(value, schema) {
  if (!schema || typeof schema !== 'object') return value;
  if (Array.isArray(value) && schema.items) return value.map((v) => applyDefaults(v, schema.items));
  if (isPlainObject(value)) {
    const out = { ...value };
    for (const [k, s] of Object.entries(schema.properties ?? {})) {
      if (out[k] === undefined) {
        if (s.default !== undefined) out[k] = structuredClone(s.default);
        else if (s.type === 'object' && s.properties && Object.values(s.properties).some((p) => p.default !== undefined || p.type === 'object')) {
          const filled = applyDefaults({}, s);
          if (Object.keys(filled).length) out[k] = filled;
        }
      }
      if (out[k] !== undefined) out[k] = applyDefaults(out[k], s);
    }
    return out;
  }
  return value;
}
