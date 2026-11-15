// GENERATED COPY of sf-shared/lib — edit sf-shared/lib and run `npm run sync`.
// @ts-check
// Deterministic status digests and notification delivery (terminal, status file, webhook). No LLM involved.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, formatDuration, mkdirp, redact } from './util.mjs';
import { expandEnv } from './factory.mjs';

export function buildDigest(state, { events = [], now = Date.now(), title = 'sf status' } = {}) {
  const tasks = Object.entries(state.tasks);
  const counts = {};
  for (const [, t] of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  const done = counts.INTEGRATED ?? 0;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const elapsed = formatDuration(now - Date.parse(state.run.started_at));
  const lines = [];
  lines.push(`${title} — ${state.project_id} (${state.run.id}) — elapsed ${elapsed}`);
  lines.push(`Tasks: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'} (${tasks.length} total, ${pct}% integrated)`);
  lines.push(`Milestones: ${Object.entries(state.milestones).map(([id, m]) => {
    const mine = tasks.filter(([, t]) => t.milestone === id);
    return `${id} ${m.status} (${mine.filter(([, t]) => t.status === 'INTEGRATED').length}/${mine.length})`;
  }).join(' | ')}`);
  const active = tasks.filter(([, t]) => t.activity);
  if (active.length) {
    lines.push('In progress:');
    for (const [id, t] of active) {
      lines.push(`  - ${id} ${t.activity.kind} by ${t.activity.agent} for ${formatDuration(now - Date.parse(t.activity.started_at))} (attempt ${t.attempt}, rework ${t.rework_rounds})`);
    }
  }
  const blocked = tasks.filter(([, t]) => t.status === 'BLOCKED');
  const awaiting = Object.entries(state.milestones).filter(([, m]) => m.status === 'AWAITING_APPROVAL');
  const blockedM = Object.entries(state.milestones).filter(([, m]) => m.status === 'BLOCKED');
  if (blocked.length || awaiting.length || blockedM.length) {
    lines.push('Needs attention:');
    for (const [id, t] of blocked) lines.push(`  - ${id} BLOCKED: ${t.blocked_reason}  → "sf.mjs explain ${id}" / "sf.mjs unblock ${id}"`);
    for (const [id, m] of blockedM) lines.push(`  - milestone ${id} BLOCKED: ${m.blocked_reason}`);
    for (const [id] of awaiting) lines.push(`  - milestone ${id} awaiting approval  → "sf.mjs approve --milestone ${id}"`);
  }
  if (events.length) {
    lines.push('Recent events:');
    for (const e of events.slice(-6)) lines.push(`  - ${e.ts.slice(11, 19)} ${e.msg}`);
  }
  return lines.join('\n');
}

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 20) + '\n…[truncated]';
}

export function webhookRequest(channel, text, env = process.env) {
  const url = expandEnv(channel.url, env);
  if (url.missing.length) throw new Error(`webhook url references unset variable(s): ${url.missing.join(', ')}`);
  let body;
  const preset = channel.preset ?? (channel.body ? 'custom' : 'generic');
  if (preset === 'telegram') {
    const chat = expandEnv(String(channel.chat_id), env);
    if (chat.missing.length) throw new Error(`webhook chat_id references unset variable(s): ${chat.missing.join(', ')}`);
    body = JSON.stringify({ chat_id: /^-?\d+$/.test(chat.value) ? Number(chat.value) : chat.value, text: truncate(text, 4000), disable_web_page_preview: true });
  } else if (preset === 'slack') body = JSON.stringify({ text: truncate(text, 39000) });
  else if (preset === 'discord') body = JSON.stringify({ content: truncate(text, 1900) });
  else if (preset === 'custom') {
    const b = expandEnv(channel.body, env);
    if (b.missing.length) throw new Error(`webhook body references unset variable(s): ${b.missing.join(', ')}`);
    body = b.value.replace(/\{\{\s*text_json\s*\}\}/g, JSON.stringify(text));
  } else body = JSON.stringify({ text: truncate(text, 39000) });
  return {
    url: url.value,
    init: { method: channel.method ?? 'POST', headers: { 'Content-Type': 'application/json', ...(channel.headers ?? {}) }, body },
  };
}

export class Notifier {
  /**
   * @param {{channels:any[], intervalMinutes:number, paths:any, log?:(m:string)=>void, now?:()=>number, fetchImpl?:typeof fetch}} o
   */
  constructor(o) {
    this.channels = o.channels;
    this.intervalMs = Math.round(o.intervalMinutes * 60000);
    this.paths = o.paths;
    const rawLog = o.log ?? (() => {});
    this.log = (m) => rawLog(redact(m));
    this.now = o.now ?? Date.now;
    this.fetch = o.fetchImpl ?? globalThis.fetch;
    this.lastDigestAt = this.now();
    this.lastSeq = 0;
    this.pending = new Set();
  }

  wants(channel, severity) {
    return !channel.events || channel.events.includes(severity);
  }

  async deliver(rawText, severity) {
    const text = redact(rawText);
    for (const c of this.channels) {
      if (!this.wants(c, severity)) continue;
      try {
        if (c.type === 'terminal') process.stdout.write(`[${new Date(this.now()).toISOString().slice(11, 19)}] ${text.replace(/\n/g, '\n           ')}\n`);
        else if (c.type === 'file') {
          mkdirp(this.paths.runtime);
          fs.appendFileSync(path.join(this.paths.runtime, 'notifications.log'), `--- ${new Date(this.now()).toISOString()} [${severity}]\n${text}\n`);
        } else if (c.type === 'webhook') {
          const { url, init } = webhookRequest(c, text);
          const p = this.fetch(url, { ...init, signal: AbortSignal.timeout(10000) })
            .then(async (r) => { if (!r.ok) this.log(`webhook ${c.preset ?? 'custom'} responded ${r.status}: ${(await r.text()).slice(0, 200)}`); })
            .catch((e) => this.log(`webhook failed: ${e.message}`))
            .finally(() => this.pending.delete(p));
          this.pending.add(p);
        }
      } catch (e) {
        this.log(`notify ${c.type} failed: ${e.message}`);
      }
    }
  }

  /** Immediate notification for a notable event. */
  async event(severity, text) {
    await this.deliver(text, severity);
  }

  /** Always-fresh status file. */
  writeStatus(text) {
    atomicWrite(this.paths.status, `# sf status\n\n\`\`\`\n${text}\n\`\`\`\n`);
  }

  /** Send a periodic digest when the interval elapsed. Returns true if sent. */
  async maybeDigest(buildText) {
    if (this.intervalMs <= 0) return false;
    if (this.now() - this.lastDigestAt < this.intervalMs) return false;
    this.lastDigestAt = this.now();
    await this.deliver(buildText(), 'info');
    return true;
  }

  async flush() {
    await Promise.allSettled([...this.pending]);
  }
}
