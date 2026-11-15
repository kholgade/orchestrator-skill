// @ts-check
// Tamper-evident (hash-chained) JSONL event log, state-delta folding, and the durable governance ledger.
import fs from 'node:fs';
import { SF_VERSION } from './version.mjs';
import { nowIso, sha256, appendLine, redactDeep, redact, isPlainObject } from './util.mjs';

export const EVENT_SCHEMA = 1;
const ZERO = '0'.repeat(64);

export class EventLog {
  /**
   * @param {string} file
   * @param {{runId?:string|null, actor?:string}} [o]
   */
  constructor(file, o = {}) {
    this.file = file;
    this.runId = o.runId ?? null;
    this.actor = o.actor ?? 'supervisor';
    this.seq = 0;
    this.lastHash = ZERO;
  }

  load() {
    try {
      const text = fs.readFileSync(this.file, 'utf8').trimEnd();
      if (text) {
        const last = JSON.parse(text.slice(text.lastIndexOf('\n') + 1));
        this.seq = last.seq ?? 0;
        this.lastHash = last.hash ?? ZERO;
      }
    } catch { /* new log */ }
    return this;
  }

  /** @returns {any} the appended event */
  append(type, { severity = 'info', entity = null, id = null, msg = '', data, actor, attempt, op_id } = {}) {
    const ev = {
      v: EVENT_SCHEMA, sf: SF_VERSION, seq: ++this.seq, ts: nowIso(), run_id: this.runId, severity, type,
      actor: actor ?? this.actor, entity, id, ...(attempt !== undefined ? { attempt } : {}), ...(op_id ? { op_id } : {}),
      msg: redact(msg), ...(data !== undefined ? { data: redactDeep(data) } : {}), prev: this.lastHash,
    };
    ev.hash = sha256(`${ev.prev}\n${JSON.stringify(ev)}`);
    this.lastHash = ev.hash;
    appendLine(this.file, JSON.stringify(ev));
    return ev;
  }

  readAll({ since = 0, limit = Infinity } = {}) {
    return readEvents(this.file, { since, limit });
  }
}

export function readEvents(file, { since = 0, limit = Infinity } = {}) {
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  const evs = [];
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      if (e.seq > since) evs.push(e);
    } catch { /* torn line ignored */ }
  }
  return Number.isFinite(limit) ? evs.slice(-limit) : evs;
}

/** Verify the hash chain and sequence continuity. */
export function verifyChain(file) {
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return { ok: true, count: 0, lastSeq: 0 };
  }
  let prev = ZERO;
  let seq = 0;
  for (let i = 0; i < lines.length; i++) {
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      return { ok: false, count: i, lastSeq: seq, brokenAt: i + 1, reason: i === lines.length - 1 ? 'torn final line (crash during write)' : 'unparseable line' };
    }
    const { hash, ...rest } = e;
    if (e.seq !== seq + 1) return { ok: false, count: i, lastSeq: seq, brokenAt: e.seq, reason: `sequence gap (expected ${seq + 1}, found ${e.seq})` };
    if (e.prev !== prev) return { ok: false, count: i, lastSeq: seq, brokenAt: e.seq, reason: 'prev-hash mismatch (log edited or reordered)' };
    if (sha256(`${e.prev}\n${JSON.stringify(rest)}`) !== hash) return { ok: false, count: i, lastSeq: seq, brokenAt: e.seq, reason: 'event hash mismatch (event modified)' };
    prev = hash;
    seq = e.seq;
  }
  return { ok: true, count: lines.length, lastSeq: seq };
}

// ---------------------------------------------------------------- state deltas (event sourcing)

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Diff two state objects into {set:[[path[],value]], del:[path[]]}; ignores updated_at. */
export function diffState(prev, next) {
  const set = [];
  const del = [];
  const cmp = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const section of ['tasks', 'milestones']) {
    const pa = prev?.[section] ?? {};
    const na = next[section] ?? {};
    for (const id of new Set([...Object.keys(pa), ...Object.keys(na)])) {
      if (!(id in na)) del.push([section, id]);
      else if (!(id in pa)) set.push([[section, id], clone(na[id])]);
      else {
        for (const f of new Set([...Object.keys(pa[id]), ...Object.keys(na[id])])) {
          if (!(f in na[id]) || na[id][f] === undefined) { if (f in pa[id]) del.push([section, id, f]); }
          else if (!cmp(pa[id][f], na[id][f])) set.push([[section, id, f], clone(na[id][f])]);
        }
      }
    }
  }
  const skip = new Set(['tasks', 'milestones', 'updated_at']);
  const pr = prev ?? {};
  for (const k of new Set([...Object.keys(pr), ...Object.keys(next)])) {
    if (skip.has(k)) continue;
    if (!(k in next)) del.push([k]);
    else if (k === 'run') {
      const a = pr.run ?? {};
      const b = next.run;
      for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!(f in b) || b[f] === undefined) { if (f in a) del.push(['run', f]); }
        else if (!cmp(a[f], b[f])) set.push([['run', f], clone(b[f])]);
      }
    } else if (!cmp(pr[k], next[k])) set.push([[k], clone(next[k])]);
  }
  return { set, del };
}

export function applyDelta(state, delta) {
  for (const [p, v] of delta.set ?? []) {
    let cur = state;
    for (const k of p.slice(0, -1)) {
      if (!isPlainObject(cur[k])) cur[k] = {};
      cur = cur[k];
    }
    cur[p[p.length - 1]] = clone(v);
  }
  for (const p of delta.del ?? []) {
    let cur = state;
    for (const k of p.slice(0, -1)) {
      cur = cur?.[k];
      if (!cur) break;
    }
    if (cur) delete cur[p[p.length - 1]];
  }
  return state;
}

/** Rebuild state by folding state_init + state_delta events (optionally up to seq `to`). */
export function foldEvents(events, { to = Infinity } = {}) {
  let state = null;
  for (const e of events) {
    if (e.seq > to) break;
    if (e.type === 'state_init') state = clone(e.data.state);
    else if (e.type === 'state_delta' && state) applyDelta(state, e.data);
  }
  return state;
}

export const stripVolatile = (state) => {
  const c = clone(state);
  if (c) delete c.updated_at;
  return c;
};

// ---------------------------------------------------------------- durable ledger (committed governance record)

/** Append a governance record (approvals, decisions, resets) to .sf/ledger.jsonl. */
export function ledgerAppend(paths, type, { actor = 'user', msg = '', data } = {}) {
  const log = new EventLog(paths.ledger, { runId: null, actor }).load();
  return log.append(type, { severity: 'info', msg, data, actor });
}
