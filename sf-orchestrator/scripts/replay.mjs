// Replay, timeline and evidence-bundle export. Everything here is read-only with respect to the run.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SfError, exists, readText, mkdirp, atomicWrite, redact, formatDuration, nowIso, writeJson, readJson } from './lib/util.mjs';
import { softFactory, loadYamlFile } from './lib/factory.mjs';
import { stringify } from './lib/yaml.mjs';
import { readEvents, verifyChain, foldEvents, stripVolatile } from './lib/journal.mjs';
import { SF_VERSION } from './lib/version.mjs';
import * as G from './lib/git.mjs';

/** Resolve where a run's data lives: active runtime or archive/<run-id>. */
export function runLocation(root, runId) {
  const { paths } = softFactory(root);
  if (!runId || runId === 'active') {
    if (!exists(paths.state)) throw new SfError('No active run. Use --run <archived-run-id> (see "runs").');
    const s = readJson(paths.state);
    return { id: s.run.id, dir: paths.runtime, events: paths.events, state: paths.state, runs: paths.runs, active: true, paths };
  }
  const dir = path.join(paths.archive, runId);
  if (exists(path.join(paths.runtime, 'state.json')) && readJson(paths.state).run.id === runId) return runLocation(root, 'active');
  if (!exists(path.join(dir, 'manifest.json'))) throw new SfError(`Unknown run "${runId}"`);
  return { id: runId, dir, events: path.join(dir, 'events.jsonl'), state: path.join(dir, 'state.json'), runs: path.join(dir, 'runs'), active: false, paths };
}

const short = (s, n = 110) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Human-readable timeline. Groups nothing; one line per meaningful event with relative time. */
export function timeline(events, { task = null, verbose = false } = {}) {
  const skip = new Set(verbose ? [] : ['state_delta', 'state_init']);
  const t0 = events.length ? Date.parse(events[0].ts) : 0;
  const lines = [];
  for (const e of events) {
    if (skip.has(e.type)) continue;
    if (task && e.id !== task && !(e.type === 'supervisor_started' || e.type === 'supervisor_stopped')) continue;
    const rel = formatDuration(Date.parse(e.ts) - t0).padStart(7);
    const who = e.actor && e.actor !== 'supervisor' ? ` {${e.actor}}` : '';
    let detail = e.msg;
    if (e.type === 'intent') detail = `▶ ${e.data.op}${e.data.agent ? ` by ${e.data.agent}` : ''}${e.data.name ? ` "${e.data.name}"` : ''}`;
    if (e.type === 'result') detail = `◀ ${e.data.op}${e.data.status ? ` ${e.data.status}` : ''}${e.data.ok !== undefined ? (e.data.ok ? ' ok' : ' FAILED') : ''}${e.data.duration_ms ? ` (${formatDuration(e.data.duration_ms)})` : ''}${e.data.sha ? ` ${String(e.data.sha).slice(0, 8)}` : ''}`;
    lines.push(`${rel} #${String(e.seq).padStart(4)} ${e.severity.padEnd(8)} ${e.type.padEnd(22)} ${e.id ? `${e.id} ` : ''}${short(detail)}${who}`);
  }
  return lines;
}

/** State as of event `to` (default: all) rebuilt purely from the log. */
export function replayState(events, to = Infinity) {
  return foldEvents(events, { to });
}

export function summarizeState(state) {
  const counts = {};
  for (const t of Object.values(state.tasks)) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return { run: state.run.id, tasks: counts, milestones: Object.fromEntries(Object.entries(state.milestones).map(([k, v]) => [k, v.status])) };
}

function sha256File(f) {
  return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
}

function maskFactory(factory) {
  const f = JSON.parse(JSON.stringify(factory));
  for (const a of f.agents ?? []) {
    if (a.env) for (const k of Object.keys(a.env)) if (!/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(a.env[k])) a.env[k] = '[REDACTED]';
  }
  for (const c of f.notify?.channels ?? []) {
    if (c.type !== 'webhook') continue;
    for (const k of ['url', 'chat_id', 'body']) if (c[k] !== undefined && !/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(String(c[k]))) c[k] = '[REDACTED]';
    if (c.headers) for (const k of Object.keys(c.headers)) c.headers[k] = '[REDACTED]';
  }
  return f;
}

/**
 * Write a self-describing evidence bundle for one run. Text files are passed through secret redaction.
 * @returns {{out:string, files:number, chain:any, replay_matches_state:boolean}}
 */
export function exportBundle(root, { runId, out, gitBundle = false }) {
  const loc = runLocation(root, runId);
  const { paths, factory } = softFactory(root);
  if (exists(out) && fs.readdirSync(out).length) throw new SfError(`Output directory ${out} is not empty`);
  mkdirp(out);
  const files = [];
  const put = (rel, content) => {
    const full = path.join(out, rel);
    mkdirp(path.dirname(full));
    fs.writeFileSync(full, content);
    files.push({ path: rel, bytes: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex') });
  };
  const copyText = (src, rel) => {
    const st = fs.statSync(src);
    if (st.size > 8 * 1024 * 1024) { put(rel + '.TRUNCATED', redact(fs.readFileSync(src, 'utf8').slice(-2 * 1024 * 1024))); return; }
    const buf = fs.readFileSync(src);
    if (buf.includes(0)) { put(rel, buf); return; }
    put(rel, redact(buf.toString('utf8')));
  };
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), path.join(rel, e.name));
      else copyText(path.join(dir, e.name), path.join(rel, e.name));
    }
  };

  const events = readEvents(loc.events);
  const chain = verifyChain(loc.events);
  const folded = foldEvents(events);
  const stateNow = exists(loc.state) ? readJson(loc.state) : null;
  const matches = Boolean(folded && stateNow && JSON.stringify(stripVolatile(folded)) === JSON.stringify(stripVolatile(stateNow)));

  copyText(loc.events, 'events.jsonl');
  if (stateNow) put('state.json', redact(JSON.stringify(stateNow, null, 2)));
  if (folded) put('state.replayed.json', redact(JSON.stringify(folded, null, 2)));
  put('timeline.txt', timeline(events).join('\n') + '\n');
  if (exists(loc.runs)) walk(loc.runs, 'runs');
  if (!loc.active) {
    const mf = path.join(loc.dir, 'manifest.json');
    if (exists(mf)) copyText(mf, 'archive-manifest.json');
    for (const f of ['status.md', 'report.md', 'notifications.log', 'supervisor.log']) if (exists(path.join(loc.dir, f))) copyText(path.join(loc.dir, f), f);
    if (exists(path.join(loc.dir, 'tasks'))) walk(path.join(loc.dir, 'tasks'), 'tasks');
  } else {
    for (const f of ['status.md', 'report.md', 'notifications.log', 'supervisor.log']) if (exists(path.join(paths.runtime, f))) copyText(path.join(paths.runtime, f), f);
  }
  if (factory) put('factory.redacted.yaml', stringify(maskFactory(factory)));
  for (const [src, rel] of [[paths.spec, 'spec.md'], [paths.plan, 'plan.yaml'], [paths.specIndex, 'spec.index.json'], [paths.ledger, 'ledger.jsonl']]) {
    if (exists(src)) copyText(src, rel);
  }
  const refs = G.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', `refs/sf/${loc.id}/`, `refs/heads/archive/${loc.id}/`], { allowFail: true }).stdout;
  put('git-refs.txt', refs);
  if (gitBundle) {
    const bundle = path.join(out, 'run.gitbundle');
    const r = G.git(root, ['bundle', 'create', bundle, '--branches', `--glob=refs/sf/${loc.id}/*`], { allowFail: true });
    if (r.code === 0) files.push({ path: 'run.gitbundle', bytes: fs.statSync(bundle).size, sha256: sha256File(bundle) });
  }
  const manifest = {
    bundle_version: 1, sf_version: SF_VERSION, exported_at: nowIso(), run_id: loc.id, project_root_name: path.basename(root),
    event_count: events.length, event_chain: chain, replay_matches_state: matches, redaction: 'env-secret values, URL credentials, bot/bearer tokens and key-shaped strings removed from text files',
    how_to_replay: 'events.jsonl is hash-chained; fold state_init + state_delta events to rebuild state at any seq (state.replayed.json is the fold of all events). timeline.txt is the human view.',
    files,
  };
  writeJson(path.join(out, 'export-manifest.json'), manifest);
  return { out, files: files.length, chain, replay_matches_state: matches };
}
