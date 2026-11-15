#!/usr/bin/env node
// Generates docs/orchestrator-workflow.html — a self-contained page (inline SVG, no dependencies) that shows the
// complete sf-orchestrator workflow. State machines, version and the agent table are read from the real code, so a
// missing/renamed state or a stale version fails the build (and tests/docs.test.mjs).
// Usage: node scripts/build-docs.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASK_TRANSITIONS, MILESTONE_TRANSITIONS } from '../sf-shared/lib/state.mjs';
import { SF_VERSION } from '../sf-shared/lib/version.mjs';
import { parse as parseYaml } from '../sf-shared/lib/yaml.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(repo, 'docs', 'orchestrator-workflow.html');
const registry = parseYaml(fs.readFileSync(path.join(repo, 'scripts', 'agent-registry.yaml'), 'utf8'));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ------------------------------------------------------------------ svg helpers
let uid = 0;
function svg(w, h, body, { label }) {
  const id = `m${++uid}`;
  return `<div class="scroll"><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}" style="min-width:${Math.min(w, 960)}px">
<defs>
<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="ah"/></marker>
<marker id="${id}g" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="ah g"/></marker>
<marker id="${id}r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="ah r"/></marker>
<marker id="${id}a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="ah a"/></marker>
</defs>${body.replaceAll('{M}', id)}</svg></div>`;
}
const tx = (x, y, s, cls = '', anchor = 'middle') => `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}">${esc(s)}</text>`;
function node({ x, y, w, h, kind = 'neutral', lines, dashed = false }) {
  const [t, ...rest] = Array.isArray(lines) ? lines : [lines];
  const n = rest.length;
  const top = y + h / 2 - (n * 15) / 2 + 4;
  return `<g class="node k-${kind}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9"${dashed ? ' stroke-dasharray="5 4"' : ''}/>${tx(x + w / 2, n ? top - 2 : y + h / 2 + 5, t, 'nt')}${rest.map((r, i) => tx(x + w / 2, top + 15 * (i + 1) - 2, r, 'ns')).join('')}</g>`;
}
function edge(pts, { kind = '', label, lx, ly, dashed = false, mk = '' } = {}) {
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ');
  const m = kind === 'g' ? '{M}g' : kind === 'r' ? '{M}r' : kind === 'a' ? '{M}a' : '{M}';
  return `<path d="${d}" class="ed ${kind}${dashed ? ' dash' : ''}" fill="none" marker-end="url(#${m})"/>${label ? tx(lx ?? (pts[0][0] + pts.at(-1)[0]) / 2, ly ?? (pts[0][1] + pts.at(-1)[1]) / 2 - 6, label, `el ${kind}`) : ''}`;
}

// ------------------------------------------------------------------ 1. pre-flight
function preflight() {
  const cols = [
    { x: 200, name: 'agents verified?', ask: ['ASK USER', 'May I set up agents?'], skill: ['sf-agent-setup', 'interview · probe CLIs', 'validate · doctor (test run)'], done: 'factory.yaml + doctor OK', step: 'agents' },
    { x: 400, name: 'spec approved?', ask: ['ASK USER', 'May I build the spec?'], skill: ['sf-spec-builder', 'interview | answers | delegate', 'lint · open questions · approve'], done: 'user approves → ledger', step: 'spec' },
    { x: 600, name: 'plan approved?', ask: ['ASK USER', 'May I draft the plan?'], skill: ['sf-plan-builder', 'scaffold | delegate · lint', 'coverage · graph · approve'], done: 'user approves → ledger', step: 'plan' },
  ];
  let b = '';
  b += node({ x: 20, y: 40, w: 130, h: 56, kind: 'script', lines: ['sf.mjs check', 'readiness steps'] });
  let prev = [150, 68];
  cols.forEach((c) => {
    b += node({ x: c.x, y: 40, w: 160, h: 56, kind: 'decision', dashed: true, lines: [c.name] });
    b += edge([prev, [c.x, 68]], { label: prev[0] === 150 ? '' : 'yes', ly: 60 });
    prev = [c.x + 160, 68];
    b += edge([[c.x + 80, 96], [c.x + 80, 150]], { kind: 'a' }) + tx(c.x + 88, 126, 'no (missing)', 'el a', 'start');
    b += node({ x: c.x, y: 150, w: 160, h: 58, kind: 'user', lines: c.ask });
    b += edge([[c.x + 80, 208], [c.x + 80, 262]], { kind: 'a' }) + tx(c.x + 88, 240, 'consent allow', 'el a', 'start');
    b += node({ x: c.x - 12, y: 262, w: 184, h: 76, kind: 'agent', lines: c.skill });
    b += tx(c.x + 80, 360, c.done, 'ns');
    b += edge([[c.x + 80, 366], [c.x + 80, 392]], { dashed: true });
  });
  b += node({ x: 800, y: 40, w: 150, h: 56, kind: 'good', lines: ['READY', 'agents · spec · plan OK'] });
  b += edge([prev, [800, 68]], { label: 'yes', ly: 60 });
  b += `<path d="M280 392 H${600 + 80} M85 392 H280" class="ed dash" fill="none"/>`;
  b += edge([[85, 392], [85, 96]], { dashed: true, label: 're-run check', lx: 85, ly: 250 }).replace('<text', '<text transform="rotate(-90 70 250)"').replace('x="85"', 'x="70"');
  b += tx(500, 416, 'after each skill finishes, run check again — the loop ends only when every step is OK', 'ns');
  b += `<g class="note"><rect x="20" y="430" width="940" height="26" rx="6"/>${tx(490, 447, 'decline → stop and ask how to proceed · a draft or lint-failing spec/plan is continued without re-asking · run is refused while any step is not OK', 'ns')}</g>`;
  return svg(980, 466, b, { label: 'Pre-flight: check, ask user, build missing inputs, loop until ready' });
}

// ------------------------------------------------------------------ 2. run classes
function classes() {
  const rows = [
    ['fresh', 'good', 'no previous run', ['confirm parameters (≤6 lines) → run --detach']],
    ['running', 'script', 'a live supervisor holds the lock', ['never start a second one → status · wait']],
    ['completed', 'good', 'all milestones DONE', ['report → ask before archiving (reset-run)']],
    ['clean_stop · safe', 'good', 'no drift · no orphans · log = state', ['run --detach']],
    ['clean_stop · unsafe  /  crashed', 'user', 'dead pid · orphans · drift', ['show the user the assessment → ASK: resume · reset-task · reset-run', 'resume --assessment <id> --decision … (confirmed) → run --detach']],
    ['inconsistent', 'bad', 'log chain broken · git ≠ state', ['never auto-resume → reset-task · reset-run · manual repair']],
  ];
  let b = node({ x: 20, y: 156, w: 130, h: 70, kind: 'script', lines: ['sf.mjs assess', 'read-only', 'assessment_id'] });
  rows.forEach((r, i) => {
    const y = 14 + i * 62;
    b += edge([[150, 191], [196, y + 25]]);
    b += node({ x: 196, y, w: 270, h: 50, kind: r[1], lines: [r[0], r[2]] });
    b += edge([[466, y + 25], [500, y + 25]]);
    b += `<g class="node k-neutral"><rect x="500" y="${y}" width="480" height="50" rx="9"/>${r[3].map((l, j) => tx(740, y + (r[3].length === 1 ? 30 : 21 + j * 17), l, 'nt2')).join('')}</g>`;
  });
  return svg(1000, 392, b, { label: 'assess classifies the previous run and decides the next action' });
}

// ------------------------------------------------------------------ 3. supervise loop
function superviseLoop() {
  let b = '';
  b += node({ x: 20, y: 24, w: 170, h: 58, kind: 'script', lines: ['run --detach', 'supervisor in background'] });
  b += edge([[190, 53], [250, 53]]);
  b += node({ x: 250, y: 24, w: 200, h: 58, kind: 'agent', lines: ['wait --timeout 300', 'returns on error/approval/done'] });
  b += edge([[450, 53], [510, 53]]);
  b += node({ x: 510, y: 24, w: 190, h: 58, kind: 'agent', lines: ['relay 2–4 lines', 'facts from status/events'] });
  b += edge([[600, 24], [600, 8], [350, 8], [350, 24]], { dashed: true, label: 'timeout → loop', lx: 475, ly: 20 });
  const ev = [
    ['task BLOCKED', 'bad', 'explain <id> → unblock (+rounds / other agent) · fix plan/spec · ask user'],
    ['merge conflict / regression', 'bad', 'unblock <id> → implementer resolves in its worktree'],
    ['milestone AWAITING_APPROVAL', 'user', 'show merged tasks + gate results → ASK user → approve --milestone (confirmed)'],
    ['milestone BLOCKED (gate failed)', 'bad', 'read gate log → add fix task or fix → unblock --milestone'],
    ['supervisor_not_running, work remains', 'script', 'assess first (never blind run) → resume flow'],
    ['complete', 'good', 'report → requirement → task → evidence summary, limitations, branches to merge'],
  ];
  ev.forEach((e, i) => {
    const y = 120 + i * 54;
    b += node({ x: 20, y, w: 270, h: 42, kind: e[1], lines: [e[0]] });
    b += edge([[290, y + 21], [326, y + 21]]);
    b += `<g class="node k-neutral"><rect x="326" y="${y}" width="654" height="42" rx="9"/>${tx(653, y + 26, e[2], 'nt2')}</g>`;
  });
  b += edge([[355, 82], [355, 110], [155, 110], [155, 120]], { kind: 'a', label: 'event', lx: 255, ly: 104 });
  b += tx(500, 462, 'Every non-trivial operator decision is recorded: note --kind decision --msg "…" (journal + ledger)', 'ns');
  return svg(1000, 476, b, { label: 'Operator loop: wait, relay, act per event type' });
}

// ------------------------------------------------------------------ 4. task pipeline (sequence)
function pipeline() {
  const lanes = [
    { id: 'S', x: 110, label: 'Supervisor', sub: 'script (no LLM)', kind: 'script' },
    { id: 'G', x: 300, label: 'Git', sub: 'worktrees · branches', kind: 'git' },
    { id: 'I', x: 490, label: 'Implementer', sub: 'any agent CLI', kind: 'agent' },
    { id: 'V', x: 680, label: 'Verify commands', sub: 'run by supervisor', kind: 'script' },
    { id: 'R', x: 870, label: 'Reviewer', sub: 'independent agent', kind: 'agent' },
    { id: 'J', x: 1060, label: 'Journal', sub: 'events · ledger · notify', kind: 'git' },
  ];
  const X = Object.fromEntries(lanes.map((l) => [l.id, l.x]));
  const steps = [
    ['S', 'J', 'scheduled · intent(agent_run)', ''],
    ['S', 'G', 'worktree add (task branch ← milestone branch)', ''],
    ['S', 'I', 'brief.md → run in the worktree (timeout, process group)', ''],
    ['I', 'G', 'edits files in its worktree', ''],
    ['S', 'G', 'commit + pin refs/sf/<run>/<task>/attempt-N', ''],
    ['S', 'V', 'scope check (diff ⊆ write_scopes) + verify commands', ''],
    ['V', 'S', 'exit codes = evidence · fail → REWORK with exact output', 'r'],
    ['S', 'R', 'review brief: criteria + diff + evidence', ''],
    ['R', 'S', 'JSON verdict per criterion (worktree untouched?)', ''],
    ['S', 'S', 'verdict() computed by code → PASS only if all evidence + criteria', 'g'],
    ['S', 'G', 'merge --no-ff into milestone branch (one at a time)', ''],
    ['S', 'V', 're-run task verify on the merged branch (revert on failure)', ''],
    ['S', 'J', 'INTEGRATED · result events · digest/alerts', 'g'],
  ];
  const y0 = 118;
  const dy = 44;
  let b = '';
  lanes.forEach((l) => {
    b += node({ x: l.x - 80, y: 10, w: 160, h: 52, kind: l.kind, lines: [l.label, l.sub] });
    b += `<line x1="${l.x}" y1="62" x2="${l.x}" y2="${y0 + steps.length * dy - 6}" class="life"/>`;
  });
  steps.forEach((s, i) => {
    const y = y0 + i * dy;
    const [a, c, label, k] = s;
    b += `<circle cx="14" cy="${y}" r="10" class="num"/>${tx(14, y + 4, String(i + 1), 'numt')}`;
    if (a === c) {
      b += `<path d="M${X[a]} ${y - 10} h46 v20 h-46" class="ed ${k}" fill="none" marker-end="url(#{M}${k === 'g' ? 'g' : ''})"/>${tx(X[a] + 56, y + 4, label, 'el2', 'start')}`;
    } else {
      const x1 = X[a];
      const x2 = X[c];
      b += edge([[x1, y], [x2 + (x2 > x1 ? -2 : 2), y]], { kind: k });
      const span = Math.abs(x2 - x1);
      if (label.length * 6.4 > span - 12) b += tx(Math.min(x1, x2) + 8, y - 7, label, 'el2', 'start');
      else b += tx((x1 + x2) / 2, y - 7, label, 'el2');
    }
  });
  const yb = y0 + steps.length * dy + 6;
  b += `<g class="note"><rect x="30" y="${yb}" width="940" height="26" rx="6"/>${tx(500, yb + 17, 'REWORK loop: failed evidence or review → findings go back to the implementer (same worktree), bounded by max_rework_rounds, then BLOCKED', 'ns')}</g>`;
  b += `<g class="note"><rect x="30" y="${yb + 34}" width="940" height="26" rx="6"/>${tx(500, yb + 51, 'A reviewer that modifies files is reverted and its review discarded · every step above is a journaled intent/result pair', 'ns')}</g>`;
  return svg(1160, yb + 72, b, { label: 'Lifecycle of one task across supervisor, git, agents and journal' });
}

// ------------------------------------------------------------------ 5. state machines (from code)
// Edges come from the real transition tables; layout/routes live here. A state with no layout fails the build.
function stateMachine({ transitions, nodes, bar, routes, labels, w, h, label }) {
  const missing = Object.keys(transitions).filter((s) => !nodes[s] && s !== 'BLOCKED');
  if (missing.length || !('BLOCKED' in transitions)) throw new Error(`build-docs: update scripts/build-docs.mjs layout for state(s): ${missing.join(', ') || 'BLOCKED'}`);
  const H = 44;
  const N = (s) => ({ ...nodes[s], h: H, cx: nodes[s].x + nodes[s].w / 2, cy: nodes[s].y + H / 2 });
  let body = '';
  for (const s of Object.keys(nodes)) body += node({ x: nodes[s].x, y: nodes[s].y, w: nodes[s].w, h: H, kind: nodes[s].kind, lines: [s] });
  body += `<g class="node k-bad"><rect x="${bar.x}" y="${bar.y}" width="${bar.w}" height="${H}" rx="9"/>${tx(bar.x + bar.w / 2, bar.y + 27, 'BLOCKED — reachable from any active state; only an operator action leaves it', 'nt')}</g>`;
  const legend = [];
  let n = 0;
  const badge = (x, y, num) => `<circle cx="${x}" cy="${y}" r="9" class="num"/>${tx(x, y + 4, String(num), 'numt')}`;
  const unknown = [];
  for (const [a, ts] of Object.entries(transitions)) {
    for (const t of ts) {
      const key = `${a}>${t}`;
      if (t === 'BLOCKED') {
        const A = N(a);
        const dx = nodes[a].down ?? -30;
        body += edge([[A.cx + dx, A.y + H], [A.cx + dx, bar.y]], { kind: 'r', dashed: true });
        continue;
      }
      let pts;
      let mid;
      if (a === 'BLOCKED') {
        const B = N(t);
        const xx = B.cx + 30;
        pts = [[xx, bar.y], [xx, B.y + H]];
        mid = [xx, (bar.y + B.y + H) / 2];
      } else if (routes[key]) {
        pts = routes[key];
        mid = pts.length === 2 ? [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2] : [(pts[1][0] + pts[2][0]) / 2, (pts[1][1] + pts[2][1]) / 2];
      } else {
        const A = N(a);
        const B = N(t);
        if (A.y !== B.y || B.x < A.x) { unknown.push(key); continue; }
        pts = [[A.x + A.w, A.cy], [B.x - 2, B.cy]];
        mid = [(pts[0][0] + pts[1][0]) / 2, A.cy];
      }
      const forward = /^(PLANNED>READY|READY>RUNNING|RUNNING>REVIEW|REVIEW>PASS|PASS>INTEGRATED|PLANNED>ACTIVE|ACTIVE>GATE|GATE>AWAITING_APPROVAL|AWAITING_APPROVAL>DONE|GATE>DONE|BLOCKED>)/.test(key);
      const kind = /REWORK/.test(key) ? 'a' : a === 'BLOCKED' ? 'g' : forward ? 'g' : '';
      body += edge(pts, { kind });
      n += 1;
      body += badge(mid[0], mid[1], n);
      legend.push([n, a, t, labels[key] ?? '']);
    }
  }
  if (unknown.length) throw new Error(`build-docs: no route for transition(s) ${unknown.join(', ')} — add them to the layout`);
  const ol = `<ol class="sm-legend">${legend.map((l) => `<li value="${l[0]}"><code>${l[1]} → ${l[2]}</code> ${esc(l[3])}</li>`).join('')}<li class="blk"><code>any active state → BLOCKED</code> retries exhausted, merge conflict, regression, spawn error, unverifiable review (dashed red)</li></ol>`;
  return svg(w, h, body, { label }) + ol;
}
const taskSM = () => stateMachine({
  transitions: TASK_TRANSITIONS, w: 1000, h: 330, label: 'Task state machine (generated from sf-shared/lib/state.mjs)',
  nodes: {
    PLANNED: { x: 14, y: 84, w: 118, kind: 'neutral' }, READY: { x: 184, y: 84, w: 118, kind: 'script' }, RUNNING: { x: 354, y: 84, w: 118, kind: 'agent' },
    REVIEW: { x: 524, y: 84, w: 118, kind: 'agent' }, PASS: { x: 694, y: 84, w: 118, kind: 'good' }, INTEGRATED: { x: 864, y: 84, w: 122, kind: 'good' },
    REWORK: { x: 439, y: 176, w: 118, kind: 'user', down: -30 },
  },
  bar: { x: 14, y: 270, w: 972 },
  routes: {
    'RUNNING>READY': [[385, 84], [385, 46], [243, 46], [243, 84]],
    'RUNNING>REWORK': [[440, 128], [475, 176]],
    'REWORK>RUNNING': [[455, 176], [420, 128]],
    'REVIEW>REWORK': [[575, 128], [535, 176]],
  },
  labels: {
    'PLANNED>READY': 'all dependencies INTEGRATED and milestone ACTIVE', 'READY>RUNNING': 'dispatched to an implementer (capacity + scope free)',
    'RUNNING>REVIEW': 'committed; scope check and verify commands green', 'RUNNING>REWORK': 'evidence failed (verify / scope / agent run) — findings attached',
    'REWORK>RUNNING': 're-dispatched in the same worktree', 'REVIEW>PASS': 'independent review verdict computed PASS',
    'REVIEW>REWORK': 'review FAIL or any non-PASS criterion', 'PASS>INTEGRATED': 'merged --no-ff + regression verify ok',
    'RUNNING>READY': 'supervisor restart / stop: interrupted work resumes (worktree kept)', 'BLOCKED>READY': 'operator unblock (extra rounds / other agent)',
  },
});
const milestoneSM = () => stateMachine({
  transitions: MILESTONE_TRANSITIONS, w: 1000, h: 250, label: 'Milestone state machine (generated from sf-shared/lib/state.mjs)',
  nodes: {
    PLANNED: { x: 14, y: 84, w: 120, kind: 'neutral' }, ACTIVE: { x: 214, y: 84, w: 120, kind: 'script', down: -30 }, GATE: { x: 414, y: 84, w: 120, kind: 'agent', down: -30 },
    AWAITING_APPROVAL: { x: 614, y: 84, w: 166, kind: 'user', down: -30 }, DONE: { x: 860, y: 84, w: 120, kind: 'good' },
  },
  bar: { x: 14, y: 190, w: 966 },
  routes: {
    'GATE>ACTIVE': [[430, 84], [430, 52], [318, 52], [318, 84]],
    'GATE>DONE': [[505, 84], [505, 28], [920, 28], [920, 84]],
  },
  labels: {
    'PLANNED>ACTIVE': 'dependency milestones DONE; branch + integration worktree ready', 'ACTIVE>GATE': 'every task INTEGRATED',
    'GATE>AWAITING_APPROVAL': 'milestone verify commands passed', 'AWAITING_APPROVAL>DONE': 'approved (confirmed) → merge policy applied',
    'GATE>DONE': 'when approvals.milestone_merge is false', 'GATE>ACTIVE': 'gate interrupted by stop', 'BLOCKED>ACTIVE': 'operator unblock → tasks continue',
    'BLOCKED>GATE': 'operator unblock → re-run gate',
  },
});

// ------------------------------------------------------------------ 6. crash / resume / reset
const wrap = (str, n) => {
  const out = [];
  let cur = '';
  for (const w of str.split(' ')) {
    if ((cur + ' ' + w).trim().length > n) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  return out;
};
function recovery() {
  let b = '';
  b += node({ x: 20, y: 20, w: 190, h: 56, kind: 'bad', lines: ['supervisor dies', 'kill -9 · reboot · crash'] });
  b += edge([[210, 48], [260, 48]]);
  b += node({ x: 260, y: 20, w: 210, h: 56, kind: 'neutral', lines: ['left behind', 'orphan agents · worktrees · lock'] });
  b += edge([[470, 48], [520, 48]]);
  b += node({ x: 520, y: 20, w: 200, h: 56, kind: 'script', lines: ['assess (read-only)', 'state · log · git · drift'] });
  b += edge([[720, 48], [770, 48]]);
  b += node({ x: 770, y: 20, w: 210, h: 56, kind: 'user', lines: ['ASK USER', 'resume · reset-task · reset-run'] });
  const opts = [
    ['resume', 'good', ['verify each orphan’s identity (pid + start time), then kill it', 'rebuild state.json from the event log if it lags', 'RUNNING → READY: re-dispatch in the same worktree; brief says partial work exists', 'adopt a review result left on disk if the tree is unchanged']],
    ['reset-task', 'agent', ['archive that task’s worktree and rename its branch to archive/…', 'task record → PLANNED, counters reset', 'all other tasks continue']],
    ['reset-run', 'bad', ['archive state, logs, worktrees and branches under .sf/archive/<run-id>', 'NOTHING is deleted — then ASK the user before “archive prune”', 'next run starts fresh; an archived run can be restored while none is active']],
  ];
  const lineH = 15;
  opts.forEach((o, i) => {
    const x = 20 + i * 330;
    const wrapped = o[2].map((t) => wrap(t, 47));
    const rows = wrapped.reduce((n, w) => n + w.length, 0);
    b += edge([[875, 76], [875, 106], [x + 150, 106], [x + 150, 124]], { kind: o[1] === 'bad' ? 'r' : '' });
    b += node({ x, y: 124, w: 300, h: 34, kind: o[1], lines: [o[0]] });
    b += `<g class="node k-neutral"><rect x="${x}" y="166" width="300" height="${rows * lineH + wrapped.length * 6 + 12}" rx="9"/>`;
    let yy = 186;
    wrapped.forEach((w) => { w.forEach((l, j) => { b += tx(x + 12, yy, (j === 0 ? '• ' : '  ') + l, 'ns', 'start'); yy += lineH; }); yy += 6; });
    b += '</g>';
  });
  b += tx(500, 352, 'A decision is bound to the assessment_id (single use). Confirmation: terminal prompt as user, or --confirmed-by user|external:<id> with the user’s quote.', 'ns');
  return svg(1000, 366, b, { label: 'Crash recovery: assess, ask, then resume or reset' });
}

// ------------------------------------------------------------------ 7. data & audit
function audit() {
  let b = '';
  b += node({ x: 20, y: 110, w: 160, h: 74, kind: 'script', lines: ['Supervisor', 'single writer', 'one run per project'] });
  b += node({ x: 20, y: 250, w: 160, h: 60, kind: 'script', lines: ['Notifier', 'digest every N min · alerts'] });
  b += edge([[100, 184], [100, 250]], { dashed: true });
  const mid = [
    [14, ['events.jsonl', 'write-ahead · hash-chained', 'intent/result · state_delta · actor']],
    [90, ['state.json', 'derived snapshot', 'rebuilt from the log if it lags']],
    [166, ['refs/sf/<run>/…', 'every attempt commit pinned', 'integrated merge commit']],
    [242, ['runs/<task>/attempt-N', 'briefs · stdout/stderr · diffs', 'verify logs · verdicts · artifacts']],
  ];
  mid.forEach((m) => {
    b += node({ x: 250, y: m[0], w: 240, h: 62, kind: 'git', lines: m[1] });
    b += edge([[180, 147], [250, m[0] + 31]]);
  });
  b += node({ x: 560, y: 14, w: 230, h: 66, kind: 'user', lines: ['ledger.jsonl (committed)', 'approvals · consent · resume · prune', 'who + quote + hashes'] });
  b += edge([[100, 110], [100, 4], [675, 4], [675, 14]], { kind: 'a', dashed: true });
  b += node({ x: 560, y: 120, w: 230, h: 104, kind: 'agent', lines: ['External supervisor / reviewer', 'events --follow --json (NDJSON)', 'timeline · replay --to <seq>', 'export: hashed, redacted bundle'] });
  b += edge([[490, 45], [525, 45], [525, 150], [560, 150]], { dashed: true });
  b += edge([[490, 273], [525, 273], [525, 196], [560, 196]], { dashed: true });
  ['terminal', 'status.md', 'Telegram · Slack · Discord', 'generic webhook'].forEach((n, i) => {
    b += node({ x: 760, y: 250 + i * 0, w: 0, h: 0, kind: 'neutral', lines: [''] }).slice(0, 0);
    b += node({ x: 560 + (i % 2) * 215, y: 262 + Math.floor(i / 2) * 36, w: 205, h: 30, kind: 'neutral', lines: [n] });
  });
  b += edge([[100, 310], [100, 336], [545, 336], [545, 277], [560, 277]]);
  b += tx(20, 360, 'Secrets are redacted everywhere; prompts, diffs, stdout/stderr and agent session artifacts are kept in full.', 'ns', 'start');
  return svg(1000, 374, b, { label: 'Journal, ledger, pinned refs and notification outputs' });
}

// ------------------------------------------------------------------ 8. skills & roles overview
function overview() {
  let b = '';
  const skills = [
    [20, 'sf-agent-setup', ['interview → factory.yaml', 'probe · validate · doctor']],
    [250, 'sf-spec-builder', ['interview | answers | delegate', 'lint · approve → spec.index']],
    [480, 'sf-plan-builder', ['scaffold | delegate', 'lint DAG · scopes · coverage']],
    [710, 'sf-orchestrator', ['check · assess · run · wait', 'supervisor · journal · replay']],
  ];
  skills.forEach((s, i) => {
    b += node({ x: s[0], y: 20, w: 210, h: 70, kind: i === 3 ? 'script' : 'agent', lines: [s[1], ...s[2]] });
    if (i < 3) b += edge([[s[0] + 210, 55], [skills[i + 1][0], 55]]);
  });
  b += `<path d="M815 90 V126 H125" class="ed a dash" fill="none"/>`;
  [125, 355, 585].forEach((x) => { b += edge([[x, 126], [x, 92]], { kind: 'a', dashed: true }); });
  b += tx(470, 120, 'invokes whatever is missing — after asking the user', 'el a');
  b += node({ x: 20, y: 160, w: 920, h: 44, kind: 'git', lines: ['sf-shared/lib — YAML parser · schemas · runner · git · state · journal · notify · confirm (vendored into every skill: each is self-contained)'] });
  const roles = [
    ['orchestrator', 'any agent session'], ['spec author', 'agent id | session'], ['planner', 'agent id | session'], ['implementers', 'parallel, one worktree each'], ['reviewers', 'independent of implementer'],
  ];
  roles.forEach((r, i) => { b += node({ x: 20 + i * 186, y: 232, w: 176, h: 46, kind: 'agent', lines: [r[0], r[1]] }); });
  b += tx(480, 304, 'Roles are data in .sf/factory.yaml — any mix of Claude, Codex, Copilot, Cursor, Gemini, OpenCode, Kiro, Cline, Windsurf, Pi, …', 'ns');
  return svg(960, 320, b, { label: 'The four skills, shared library and agent roles' });
}

// ------------------------------------------------------------------ page
const COMMANDS = [
  ['check', 'user/LLM', 'readiness + the question to ask before building anything'],
  ['consent', 'user/LLM', 'record the user’s answer to “may I build the spec/plan/setup?”'],
  ['assess', 'LLM', 'read-only classification of a previous run'],
  ['resume', 'user/LLM', 'confirmed decision: resume · reset-task · reset-run · restore'],
  ['run', 'LLM', 'start/continue the supervisor (refuses unconfirmed crashed runs)'],
  ['wait', 'LLM', 'block until error / approval / done'],
  ['status', 'LLM', 'digest of current state'],
  ['events', 'ext. supervisor', 'event log; --follow streams NDJSON'],
  ['explain', 'LLM', 'findings, evidence, logs of one task'],
  ['approve', 'user', 'milestone approval (confirmed)'],
  ['unblock', 'LLM', 'clear a BLOCKED task or milestone'],
  ['note', 'LLM/user', 'record a decision in journal + ledger'],
  ['runs', 'LLM', 'active and archived runs'],
  ['archive', 'user', 'show / prune archived runs (confirmed deletion)'],
  ['timeline', 'reviewer', 'human-readable audit trail'],
  ['replay', 'reviewer', 'rebuild state at any event'],
  ['export', 'reviewer', 'hashed, redacted evidence bundle'],
  ['report', 'LLM', 'delivery evidence report'],
  ['stop', 'LLM/user', 'graceful stop, state kept'],
];

function registryTable() {
  const rows = registry.agents.map((a) => `<tr><td>${esc(a.label)}</td><td><code>${esc(a.workspace)}</code></td><td><code>${esc(a.user)}</code></td><td>${esc(a.confidence)}</td></tr>`).join('');
  return `<table><thead><tr><th>Agent</th><th>Workspace skills dir</th><th>User skills dir</th><th>Path confidence</th></tr></thead><tbody>${rows}
<tr><td>Cross-agent standard</td><td><code>${esc(registry.generic.agents_standard.workspace)}</code></td><td><code>${esc(registry.generic.agents_standard.user)}</code></td><td>shared</td></tr>
<tr><td>Tool-neutral setup</td><td><code>${esc(registry.generic.sf_standard.workspace)}</code></td><td>—</td><td>AGENTS.md pointer</td></tr></tbody></table>`;
}

const DARK = 'color-scheme:dark;--bg:#10151b;--surface:#18202a;--text:#e6ebf1;--muted:#9aa7b5;--border:#2b3846;--blue:#6da2ff;--violet:#b595ff;--amber:#f0a94a;--green:#4fcb8a;--red:#ff7b6b;--teal:#4cc9c9;--ink:#b9c4d0';
const CSS = `
:root{color-scheme:light;--bg:#f7f8fa;--surface:#fff;--text:#16202b;--muted:#5b6876;--border:#d5dbe3;--blue:#2563c9;--violet:#7a45c9;--amber:#b86a00;--green:#1c7d4c;--red:#c0392b;--teal:#0e7a7a;--ink:#2b3846}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}
:root[data-theme="dark"]{${DARK}}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{padding:28px 20px 8px;max-width:1120px;margin:0 auto}
h1{font-size:26px;margin:0 0 4px}h2{font-size:20px;margin:0 0 4px}
.sub{color:var(--muted);margin:0}
nav{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(6px);border-bottom:1px solid var(--border)}
nav div{max-width:1120px;margin:0 auto;padding:8px 20px;display:flex;gap:6px 14px;flex-wrap:wrap;font-size:13px}
nav a{color:var(--blue);text-decoration:none}nav a:hover{text-decoration:underline}
main{max-width:1120px;margin:0 auto;padding:8px 20px 64px}
section{margin:28px 0;padding:18px;background:var(--surface);border:1px solid var(--border);border-radius:14px}
section p.lede{margin:2px 0 12px;color:var(--muted)}
.scroll{overflow-x:auto;border:1px solid var(--border);border-radius:10px;background:var(--bg);padding:6px}
svg{display:block;width:100%;height:auto;font-family:inherit}
.nt{font-size:13px;font-weight:650;fill:var(--text)}.nt2{font-size:13px;fill:var(--text)}.ns{font-size:11.5px;fill:var(--muted)}
.el{font-size:11.5px;fill:var(--ink)}.el2{font-size:12px;fill:var(--text)}.el.r{fill:var(--red)}.el.g{fill:var(--green)}.el.a{fill:var(--amber)}
.node rect{stroke-width:1.6}
.k-neutral rect{fill:var(--surface);stroke:var(--border)}
.k-script rect{fill:color-mix(in srgb,var(--blue) 13%,var(--surface));stroke:var(--blue)}
.k-agent rect{fill:color-mix(in srgb,var(--violet) 13%,var(--surface));stroke:var(--violet)}
.k-user rect{fill:color-mix(in srgb,var(--amber) 15%,var(--surface));stroke:var(--amber)}
.k-good rect{fill:color-mix(in srgb,var(--green) 14%,var(--surface));stroke:var(--green)}
.k-bad rect{fill:color-mix(in srgb,var(--red) 12%,var(--surface));stroke:var(--red)}
.k-git rect{fill:color-mix(in srgb,var(--teal) 13%,var(--surface));stroke:var(--teal)}
.k-decision rect{fill:var(--surface);stroke:var(--ink)}
.ed{stroke:var(--ink);stroke-width:1.6}.ed.g{stroke:var(--green)}.ed.r{stroke:var(--red)}.ed.a{stroke:var(--amber)}.dash{stroke-dasharray:5 4}
.ah{fill:var(--ink)}.ah.g{fill:var(--green)}.ah.r{fill:var(--red)}.ah.a{fill:var(--amber)}
.life{stroke:var(--border);stroke-width:1.5;stroke-dasharray:4 5}.num{fill:var(--ink)}.numt{font-size:11px;font-weight:700;fill:var(--bg);text-anchor:middle}
.theme{margin-left:auto;display:inline-flex;align-items:center;gap:6px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:999px;padding:3px 12px;font:inherit;font-size:12.5px;cursor:pointer}
.theme:hover{border-color:var(--blue)}.theme:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.sm-legend{columns:2 360px;column-gap:28px;margin:12px 0 4px;padding-left:28px;font-size:13px;color:var(--muted)}.sm-legend li{break-inside:avoid;margin:2px 0}.sm-legend li.blk{color:var(--red)}
.note rect{fill:color-mix(in srgb,var(--amber) 10%,var(--surface));stroke:var(--amber);stroke-width:1}
table{border-collapse:collapse;width:100%;font-size:13.5px}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--border);vertical-align:top}th{color:var(--muted);font-weight:600}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:color-mix(in srgb,var(--ink) 9%,transparent);padding:1px 5px;border-radius:5px}
.legend{display:flex;flex-wrap:wrap;gap:8px 16px;margin:10px 0 0;font-size:12.5px;color:var(--muted)}.legend span{display:inline-flex;align-items:center;gap:6px}
.legend i{width:14px;height:14px;border-radius:4px;border:1.6px solid;display:inline-block}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
.card{border:1px solid var(--border);border-radius:10px;padding:12px 14px;background:var(--bg)}.card h3{margin:0 0 4px;font-size:14px}.card p,.card ul{margin:0;font-size:13.5px;color:var(--muted)}.card ul{padding-left:18px}
footer{max-width:1120px;margin:0 auto;padding:0 20px 40px;color:var(--muted);font-size:12.5px}
@media (max-width:640px){body{font-size:14px}section{padding:12px}h1{font-size:22px}}
@media print{nav{display:none}section{break-inside:avoid}}
`;

const LEGEND = `<div class="legend"><span><i style="border-color:var(--blue);background:color-mix(in srgb,var(--blue) 13%,var(--surface))"></i>script / supervisor (deterministic)</span><span><i style="border-color:var(--violet);background:color-mix(in srgb,var(--violet) 13%,var(--surface))"></i>agent / LLM judgment</span><span><i style="border-color:var(--amber);background:color-mix(in srgb,var(--amber) 15%,var(--surface))"></i>user decision / gate</span><span><i style="border-color:var(--green);background:color-mix(in srgb,var(--green) 14%,var(--surface))"></i>success</span><span><i style="border-color:var(--red);background:color-mix(in srgb,var(--red) 12%,var(--surface))"></i>blocked / failure</span><span><i style="border-color:var(--teal);background:color-mix(in srgb,var(--teal) 13%,var(--surface))"></i>git / journal</span></div>`;

function page() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>sf-orchestrator workflow</title>
<meta name="generator" content="scripts/build-docs.mjs" data-sf-version="${SF_VERSION}">
<script>try{var t=localStorage.getItem('sf-docs-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}</script>
<style>${CSS}</style></head><body>
<header><h1>sf-orchestrator — complete workflow</h1>
<p class="sub">Skills for Factory <strong>v${SF_VERSION}</strong> · generated from the code by <code>npm run docs</code> · state machines and tables below are read from the source, not hand-drawn.</p></header>
<nav><div><a href="#overview">Overview</a><a href="#preflight">1 Pre-flight</a><a href="#assess">2 Existing run?</a><a href="#supervise">3 Run &amp; supervise</a><a href="#pipeline">4 Task pipeline</a><a href="#states">5 States</a><a href="#recovery">6 Crash &amp; reset</a><a href="#audit">7 Audit</a><a href="#commands">Commands</a><a href="#install">Install</a><button type="button" class="theme" id="theme" aria-label="Color theme: auto (follows system). Click to change" title="Color theme">◐ Auto</button></div></nav>
<main>
<section id="overview"><h2>Overview</h2><p class="lede">Four cooperating skills. Scripts do everything deterministic; the LLM interviews, judges escalations and talks to the user.</p>${overview()}${LEGEND}</section>

<section id="preflight"><h2>1 · Pre-flight: nothing is built or run without asking</h2><p class="lede"><code>check</code> names the first missing input. When a step is missing entirely the agent must ask the user first and record the answer (<code>consent</code>); each skill still ends with the user’s explicit approval, written to the committed ledger.</p>${preflight()}</section>

<section id="assess"><h2>2 · Is there a previous run?</h2><p class="lede">Always <code>assess</code> before <code>run</code>. One run is active per project (lock); <code>run</code> refuses crashed, inconsistent or drifted runs until a decision is confirmed.</p>${classes()}</section>

<section id="supervise"><h2>3 · Run and supervise</h2><p class="lede">The supervisor runs detached and pushes its own digests (default every 5 min) and alerts. The agent loops on <code>wait</code> and reacts only to events that need judgment.</p>${superviseLoop()}</section>

<section id="pipeline"><h2>4 · What the supervisor does for every task</h2><p class="lede">Parallel tasks each run this pipeline in their own worktree. Evidence is produced by the supervisor, not claimed by agents; the PASS verdict is computed by code.</p>${pipeline()}</section>

<section id="states"><h2>5 · State machines</h2><p class="lede">Generated from <code>TASK_TRANSITIONS</code> and <code>MILESTONE_TRANSITIONS</code>; illegal transitions throw.</p>
<h3>Task</h3>${taskSM()}<h3>Milestone</h3>${milestoneSM()}
<div class="grid2" style="margin-top:14px"><div class="card"><h3>Rework is bounded</h3><p><code>max_rework_rounds</code> (+ operator extras), then BLOCKED. A task cannot be marked passed by anyone but the verdict.</p></div><div class="card"><h3>Gates</h3><ul><li>plan approved before any run</li><li>milestone gate verify, then user approval</li><li>merge policy: <code>manual</code> (branch left for you) or <code>local</code></li></ul></div></div></section>

<section id="recovery"><h2>6 · Crash, resume and reset</h2><p class="lede">The event log is write-ahead truth; state is rebuilt from it. Nothing is deleted without a separate, confirmed prune.</p>${recovery()}</section>

<section id="audit"><h2>7 · Audit trail and replay</h2><p class="lede">Everything an external supervisor or reviewer needs to understand, replay or resume a run.</p>${audit()}</section>

<section id="commands"><h2>Commands</h2><p class="lede"><code>node sf-orchestrator/scripts/sf.mjs &lt;command&gt;</code>. Gated commands need a terminal confirmation, or <code>--confirmed-by user --quote "…"</code> after asking the user (<code>external:&lt;id&gt;</code> for a remote supervisor).</p>
<table><thead><tr><th>Command</th><th>Typical caller</th><th>Purpose</th></tr></thead><tbody>${COMMANDS.map((c) => `<tr data-cmd="${c[0]}"><td><code>${c[0]}</code></td><td>${c[1]}</td><td>${esc(c[2])}</td></tr>`).join('')}</tbody></table>
<p class="sub" style="margin-top:10px">Exit codes: 0 ok · 1 error/not ready · 2 usage · 3 idle (<code>run --exit-when-idle</code>) · 4 confirmation or decision required.</p></section>

<section id="install"><h2>Install: detected agents and where skills go</h2><p class="lede"><code>node scripts/install.mjs</code> detects installed agents (CLI on PATH or config dir). Several found → choose a main agent, all detected, <code>.sf/skills</code> or <code>.agents/skills</code>. Default scope is the workspace.</p>${registryTable()}</section>
</main>
<footer>Generated for sf ${SF_VERSION}. Edit <code>scripts/build-docs.mjs</code>, not this file. Related: <code>README.md</code>, <code>sf-orchestrator/SKILL.md</code>, <code>sf-orchestrator/references/runtime-layout.md</code>.</footer>
<script>
(function(){
  var root=document.documentElement,btn=document.getElementById('theme');
  var order=['auto','light','dark'],icons={auto:'◐ Auto',light:'☀ Light',dark:'☾ Dark'};
  function current(){var t=root.getAttribute('data-theme');return t==='light'||t==='dark'?t:'auto'}
  function paint(){var c=current();btn.textContent=icons[c];btn.setAttribute('aria-label','Color theme: '+c+(c==='auto'?' (follows system)':'')+'. Click to change')}
  btn.addEventListener('click',function(){
    var next=order[(order.indexOf(current())+1)%3];
    if(next==='auto')root.removeAttribute('data-theme');else root.setAttribute('data-theme',next);
    try{if(next==='auto')localStorage.removeItem('sf-docs-theme');else localStorage.setItem('sf-docs-theme',next)}catch(e){}
    paint();
  });
  paint();
})();
</script>
</body></html>
`;
}

export const COMMAND_NAMES = COMMANDS.map((c) => c[0]);
const html = page();
if (process.argv.includes('--check')) {
  const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (have !== html) { console.error('docs/orchestrator-workflow.html is stale; run `npm run docs`'); process.exit(1); }
  console.log('docs are up to date');
} else if (!process.argv.includes('--no-write')) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html);
  console.log(`wrote ${path.relative(repo, OUT)} (${html.length} bytes, sf ${SF_VERSION})`);
}
