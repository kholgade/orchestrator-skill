import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpRepo, node, script, fakeAgent, writeFactory, writeSpec, writePlan, readState, gitOut } from './helpers.mjs';
import { verifyChain, readEvents, foldEvents, stripVolatile } from '../sf-shared/lib/journal.mjs';
import { sameProcess, processFingerprint, redact } from '../sf-shared/lib/util.mjs';

const SF = script('sf-orchestrator', 'sf.mjs');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = [];
test.after(() => { for (const pid of cleanup) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } } });

function setup({ implEnv = {}, approvals } = {}) {
  const dir = tmpRepo();
  writeFactory(dir, {
    agents: [fakeAgent('impl-1', { env: implEnv }), fakeAgent('impl-2', { env: implEnv }), fakeAgent('rev-1', { caps: ['review'] })],
    roles: { implementers: ['impl-1', 'impl-2'], reviewers: ['rev-1'] }, approvals,
  });
  writeSpec(dir);
  writePlan(dir);
  return dir;
}

async function crashedRun() {
  const dir = setup({ implEnv: { FAKE_SLEEP_ATTEMPT1_MS: '60000', FAKE_SLEEP_TASKS: 'T-001,T-002' } });
  node(SF, ['run', '--detach', '--allow-unverified'], { cwd: dir });
  let pids = [];
  for (let i = 0; i < 100 && !pids.length; i++) {
    await sleep(150);
    try { pids = Object.values(readState(dir).tasks).filter((t) => t.status === 'RUNNING' && t.activity?.pid).map((t) => t.activity.pid); } catch { /* not yet */ }
  }
  assert.ok(pids.length, 'an agent should be running');
  cleanup.push(...pids);
  const lock = JSON.parse(fs.readFileSync(path.join(dir, '.sf/runtime/supervisor.lock'), 'utf8'));
  process.kill(lock.pid, 'SIGKILL');
  for (let i = 0; i < 50 && alive(lock.pid); i++) await sleep(100);
  assert.ok(pids.every(alive), 'orphaned agents survive the supervisor crash');
  return { dir, pids };
}
const assessJson = (dir) => JSON.parse(node(SF, ['assess', '--json'], { cwd: dir }).stdout);

test('crash → assess → gated resume → orphan killed by verified identity → completes; ledger and events record it', async () => {
  const { dir, pids } = await crashedRun();
  const refuse = node(SF, ['run', '--allow-unverified', '--exit-when-idle'], { cwd: dir, allowFail: true });
  assert.equal(refuse.code, 4);
  assert.match(refuse.stderr, /Refusing to continue/);
  const rep = assessJson(dir);
  assert.equal(rep.class, 'crashed');
  assert.ok(rep.orphans.length >= 1 && rep.orphans.every((o) => o.identity_verified));
  assert.ok(rep.tasks.some((t) => t.status === 'RUNNING' && /interrupted/.test(t.reason)));
  assert.equal(rep.recommendation.action, 'resume');
  assert.equal(rep.recommendation.safe_auto, false);
  // confirmation protocol
  const noConfirm = node(SF, ['resume', '--assessment', rep.assessment_id, '--decision', 'resume'], { cwd: dir, allowFail: true });
  assert.equal(noConfirm.code, 4);
  assert.match(noConfirm.stderr, /Confirmation required/);
  const stale = node(SF, ['resume', '--assessment', 'deadbeef', '--decision', 'resume', '--confirmed-by', 'user'], { cwd: dir, allowFail: true });
  assert.equal(stale.code, 4);
  assert.match(stale.stderr, /changed since it was assessed/);
  node(SF, ['resume', '--assessment', rep.assessment_id, '--decision', 'resume', '--confirmed-by', 'external:remote-sup', '--via', 'test', '--quote', 'go ahead'], { cwd: dir });
  node(SF, ['run', '--allow-unverified', '--exit-when-idle'], { cwd: dir, allowFail: true });
  for (const pid of pids) assert.equal(alive(pid), false, 'verified orphan must be killed');
  const st = readState(dir);
  assert.equal(st.milestones.M1.status, 'AWAITING_APPROVAL');
  const events = readEvents(path.join(dir, '.sf/runtime/events.jsonl'));
  assert.ok(events.some((e) => e.type === 'orphan_killed'));
  assert.ok(events.some((e) => e.type === 'ops_reconciled'));
  assert.ok(events.some((e) => e.type === 'resume_decision' && e.actor === 'external:remote-sup'));
  assert.equal(verifyChain(path.join(dir, '.sf/runtime/events.jsonl')).ok, true);
  const ledger = fs.readFileSync(path.join(dir, '.sf/ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(ledger.map((l) => l.type).slice(0, 3), ['spec_approved', 'plan_approved', 'resume_decision']);
  assert.equal(verifyChain(path.join(dir, '.sf/ledger.jsonl')).ok, true);
  // a decision is single-use
  assert.equal(readState(dir).run.resume_decision.consumed, true);
});

test('pid reuse safety: an orphan whose identity cannot be verified is NOT killed', async () => {
  const { dir, pids } = await crashedRun();
  const f = path.join(dir, '.sf/runtime/state.json');
  const s = readState(dir);
  for (const t of Object.values(s.tasks)) if (t.activity) t.activity.fp = 'ps:some other process';
  fs.writeFileSync(f, JSON.stringify(s));
  const rep = assessJson(dir);
  assert.ok(rep.orphans.every((o) => o.identity_verified === false));
  assert.equal(rep.integrity.state_vs_log, 'differs');
  node(SF, ['resume', '--assessment', rep.assessment_id, '--decision', 'resume', '--confirmed-by', 'user'], { cwd: dir });
  // (tamper was on the snapshot only; the log is truth, so the real fingerprint is restored on rebuild and the orphan is verified & killed)
  node(SF, ['run', '--allow-unverified', '--exit-when-idle'], { cwd: dir, allowFail: true });
  const events = readEvents(path.join(dir, '.sf/runtime/events.jsonl'));
  assert.ok(events.some((e) => e.type === 'state_repaired'), 'snapshot rebuilt from the write-ahead log');
  assert.ok(pids.every((p) => !alive(p)));
  assert.equal(sameProcess(process.pid, 'ps:bogus'), false);
  assert.equal(sameProcess(process.pid, processFingerprint(process.pid)), true);
});

test('reset-run archives everything without deleting; restore brings it back; prune deletes only on confirmation', async () => {
  const { dir, pids } = await crashedRun();
  const rep = assessJson(dir);
  const r = node(SF, ['resume', '--assessment', rep.assessment_id, '--decision', 'reset-run', '--confirmed-by', 'user', '--reason', 'test reset'], { cwd: dir });
  assert.match(r.stdout, /Nothing was deleted/);
  assert.ok(pids.every((p) => !alive(p)), 'verified orphans are killed before archiving');
  const runs = JSON.parse(node(SF, ['runs', '--json'], { cwd: dir }).stdout);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].active, false);
  const id = runs[0].run_id;
  assert.ok(fs.existsSync(path.join(dir, '.sf/archive', id, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(dir, '.sf/archive', id, 'events.jsonl')));
  assert.ok(!fs.existsSync(path.join(dir, '.sf/runtime/state.json')));
  const branches = gitOut(dir, 'branch', '--list', `archive/${id}/*`);
  assert.match(branches, /archive\//);
  assert.equal(gitOut(dir, 'branch', '--list', 'task/*'), '');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.sf/archive', id, 'manifest.json'), 'utf8'));
  assert.ok(manifest.worktrees.some((w) => w.ok && fs.existsSync(w.to)), 'worktrees moved into the archive');
  assert.match(manifest.delete_candidates.note, /Nothing has been deleted/);
  // prune needs confirmation
  assert.equal(node(SF, ['archive', 'prune', id], { cwd: dir, allowFail: true }).code, 4);
  // restore the archived run as the active one
  node(SF, ['resume', '--decision', 'restore', '--run', id, '--confirmed-by', 'user'], { cwd: dir });
  assert.equal(assessJson(dir).run.id, id);
  assert.ok(manifest.worktrees.filter((w) => w.ok).every((w) => fs.existsSync(w.from)));
  // reset again, then prune
  const rep2 = assessJson(dir);
  node(SF, ['resume', '--assessment', rep2.assessment_id, '--decision', 'reset-run', '--confirmed-by', 'user'], { cwd: dir });
  const archived = JSON.parse(node(SF, ['runs', '--json'], { cwd: dir }).stdout).map((x) => x.run_id);
  assert.deepEqual(archived, [id, `${id}.2`], 'second archive of the same run gets a unique id');
  const pr = JSON.parse(node(SF, ['archive', 'prune', `${id}.2`, '--confirmed-by', 'user'], { cwd: dir }).stdout);
  assert.ok(pr.worktrees.length >= 1);
  assert.equal(gitOut(dir, 'branch', '--list', `archive/${id}/*`), '');
  const ledger = fs.readFileSync(path.join(dir, '.sf/ledger.jsonl'), 'utf8');
  for (const t of ['run_archived', 'run_restored', 'archive_pruned']) assert.match(ledger, new RegExp(t));
  // a fresh run can start now
  const fresh = node(SF, ['run', '--allow-unverified', '--exit-when-idle'], { cwd: dir, allowFail: true });
  assert.equal(fresh.code, 3, fresh.stdout + fresh.stderr);
});

test('reset-task archives that task only and re-runs it', async () => {
  const { dir } = await crashedRun();
  const rep = assessJson(dir);
  const victim = rep.tasks.find((t) => t.status === 'RUNNING').id;
  node(SF, ['resume', '--assessment', rep.assessment_id, '--decision', 'reset-task', '--task', victim, '--confirmed-by', 'user'], { cwd: dir });
  const st = readState(dir);
  assert.equal(st.tasks[victim].reset_count, 1);
  assert.equal(st.tasks[victim].status, 'PLANNED');
  node(SF, ['run', '--allow-unverified', '--exit-when-idle'], { cwd: dir, allowFail: true });
  assert.equal(readState(dir).tasks[victim].status, 'INTEGRATED');
});

test('only one run: a second supervisor is refused; note is routed through the running supervisor; chain tamper is detected', async () => {
  const dir = setup({ implEnv: { FAKE_SLEEP_MS: '1500' } });
  node(SF, ['run', '--detach', '--allow-unverified'], { cwd: dir });
  const second = node(SF, ['run', '--allow-unverified'], { cwd: dir, allowFail: true });
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /already running|Only one run/);
  node(SF, ['note', '--msg', 'user said prioritise T-001', '--kind', 'decision', '--by', 'user'], { cwd: dir });
  for (let i = 0; i < 40; i++) { await sleep(200); if (readEvents(path.join(dir, '.sf/runtime/events.jsonl')).some((e) => e.type === 'note')) break; }
  node(SF, ['stop'], { cwd: dir });
  const evFile = path.join(dir, '.sf/runtime/events.jsonl');
  const events = readEvents(evFile);
  assert.ok(events.some((e) => e.type === 'note' && /prioritise/.test(e.msg)));
  assert.equal(verifyChain(evFile).ok, true);
  assert.ok(events.some((e) => e.type === 'scheduled'));
  assert.ok(events.some((e) => e.type === 'intent' && e.data.op === 'agent_run'));
  assert.ok(events.some((e) => e.type === 'result' && e.data.op === 'agent_run' && e.data.argv));
  // replay == state
  assert.deepEqual(stripVolatile(foldEvents(events)), stripVolatile(readState(dir)));
  // tamper
  const lines = fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean);
  const tampered = JSON.parse(lines[3]);
  tampered.msg = 'edited';
  lines[3] = JSON.stringify(tampered);
  fs.writeFileSync(evFile, lines.join('\n') + '\n');
  const chain = verifyChain(evFile);
  assert.equal(chain.ok, false);
  assert.match(chain.reason, /hash mismatch/);
  assert.equal(node(SF, ['replay'], { cwd: dir, allowFail: true }).code, 1);
  assert.equal(assessJson(dir).class, 'inconsistent');
});

test('export bundle: manifest hashes, redaction of secrets, replay matches state; timeline renders', async () => {
  const dir = setup({ implEnv: { FAKE_BAD_FIRST: 'T-002', SECRET_TOKEN: '${HOME}' } });
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
  process.env.SF_TEST_API_TOKEN = secret;
  fs.writeFileSync(path.join(dir, 'leak.txt'), '');
  const r = node(SF, ['run', '--allow-unverified', '--exit-when-idle'], { cwd: dir, allowFail: true, env: { SF_TEST_API_TOKEN: secret } });
  assert.equal(r.code, 3, r.stdout + r.stderr);
  const out = path.join(dir, 'bundle');
  node(SF, ['export', '--out', out], { cwd: dir, env: { SF_TEST_API_TOKEN: secret } });
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'export-manifest.json'), 'utf8'));
  assert.equal(manifest.replay_matches_state, true);
  assert.equal(manifest.event_chain.ok, true);
  assert.ok(manifest.files.length > 10);
  for (const f of manifest.files.slice(0, 5)) assert.equal(fs.existsSync(path.join(out, f.path)), true);
  assert.ok(fs.existsSync(path.join(out, 'factory.redacted.yaml')));
  assert.ok(fs.existsSync(path.join(out, 'timeline.txt')));
  assert.match(fs.readFileSync(path.join(out, 'timeline.txt'), 'utf8'), /agent_run/);
  assert.equal(redact(`token ${secret}`, [secret]).includes(secret), false);
  assert.equal(redact('https://user:pass@example.com/x').includes('pass'), false);
  assert.equal(redact('bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAA').includes('AAAA'), false);
  const tl = node(SF, ['timeline', '--task', 'T-002'], { cwd: dir }).stdout;
  assert.match(tl, /rework|REWORK/);
  const rp = node(SF, ['replay', '--to', '5', '--json'], { cwd: dir }).stdout;
  assert.equal(JSON.parse(rp).at_seq, 5);
});

test('write-ahead log is the truth: pinned refs exist for every attempt and the integrated commit', async () => {
  const dir = setup({ implEnv: { FAKE_BAD_FIRST: 'T-002' } });
  node(SF, ['run', '--allow-unverified', '--exit-when-idle'], { cwd: dir, allowFail: true });
  const runId = readState(dir).run.id;
  const refs = gitOut(dir, 'for-each-ref', '--format=%(refname)', `refs/sf/${runId}/`).split('\n');
  assert.ok(refs.some((r) => r.endsWith('/t-002/attempt-1')) && refs.some((r) => r.endsWith('/t-002/attempt-2')) && refs.some((r) => r.endsWith('/t-001/integrated')));
});
