import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpRepo, node, script, fakeAgent, writeFactory, writeSpec, writePlan, readState, gitOut } from './helpers.mjs';

const SF = script('sf-orchestrator', 'sf.mjs');
const SETUP = script('sf-agent-setup', 'setup.mjs');

function setup({ implEnv = {}, revEnv = {}, execution, maxRework, approvals, gitCfg } = {}) {
  const dir = tmpRepo();
  writeFactory(dir, {
    agents: [fakeAgent('impl-1', { env: implEnv }), fakeAgent('impl-2', { env: implEnv }), fakeAgent('rev-1', { caps: ['review'], env: revEnv })],
    roles: { implementers: ['impl-1', 'impl-2'], reviewers: ['rev-1'] },
    execution, approvals, git: gitCfg,
  });
  writeSpec(dir);
  writePlan(dir, { maxRework });
  return dir;
}

test('readiness check walks agents → spec → plan', () => {
  const dir = tmpRepo();
  let r = JSON.parse(node(SF, ['check', '--json'], { cwd: dir, allowFail: true }).stdout);
  assert.equal(r.ready, false);
  assert.equal(r.next.skill, 'sf-agent-setup');
  assert.equal(r.next.ask_user_first, true);
  assert.match(r.next.ask.question, /May I run sf-agent-setup/);
  writeFactory(dir, { agents: [fakeAgent('i'), fakeAgent('r', { caps: ['review'] })], roles: { implementers: ['i'], reviewers: ['r'] } });
  r = JSON.parse(node(SF, ['check', '--json'], { cwd: dir, allowFail: true }).stdout);
  assert.match(r.steps[0].detail, /not verified/);
  node(SETUP, ['doctor', '--all'], { cwd: dir });
  r = JSON.parse(node(SF, ['check', '--json'], { cwd: dir, allowFail: true }).stdout);
  assert.equal(r.steps[0].ok, true);
  assert.equal(r.next.skill, 'sf-spec-builder');
  assert.equal(r.next.ask_user_first, true);
  assert.match(r.next.ask.question, /no spec\. May I build one/);
  assert.equal(node(SF, ['consent', '--step', 'spec', '--decision', 'allow'], { cwd: dir, allowFail: true }).code, 4, 'consent needs confirmation');
  node(SF, ['consent', '--step', 'spec', '--decision', 'allow', '--confirmed-by', 'user', '--quote', 'yes build it'], { cwd: dir });
  r = JSON.parse(node(SF, ['check', '--json'], { cwd: dir, allowFail: true }).stdout);
  assert.equal(r.next.ask_user_first, false, 'already consented → do not ask again');
  assert.equal(r.next.consent, 'allowed');
  writeSpec(dir);
  r = JSON.parse(node(SF, ['check', '--json'], { cwd: dir, allowFail: true }).stdout);
  assert.equal(r.next.skill, 'sf-plan-builder');
  assert.equal(r.next.ask_user_first, true, 'spec approved, plan missing → ask before drafting the plan');
  assert.match(r.next.ask.question, /spec is approved but there is no plan/);
  node(SF, ['consent', '--step', 'plan', '--decision', 'decline', '--confirmed-by', 'user'], { cwd: dir });
  r = JSON.parse(node(SF, ['check', '--json'], { cwd: dir, allowFail: true }).stdout);
  assert.equal(r.next.consent, 'declined');
  assert.match(fs.readFileSync(path.join(dir, '.sf/ledger.jsonl'), 'utf8'), /build_consent/);
  writePlan(dir);
  r = JSON.parse(node(SF, ['check', '--json'], { cwd: dir, allowFail: true }).stdout);
  assert.equal(r.ready, true, JSON.stringify(r));
});

test('full run: parallel tasks, rework after failed verify, milestone approvals, resume, completion', () => {
  const dir = setup({ implEnv: { FAKE_BAD_FIRST: 'T-002' }, revEnv: { FAKE_REVIEW_FAIL_FIRST: 'T-003' } });
  // first run stops idle at the M1 approval gate (exit 3)
  let r = node(SF, ['run', '--allow-unverified', '--exit-when-idle'], { cwd: dir, allowFail: true });
  assert.equal(r.code, 3, r.stdout + r.stderr);
  let st = readState(dir);
  assert.deepEqual(Object.values(st.tasks).filter((t) => t.milestone === 'M1').map((t) => t.status), ['INTEGRATED', 'INTEGRATED', 'INTEGRATED']);
  assert.equal(st.milestones.M1.status, 'AWAITING_APPROVAL');
  assert.equal(st.tasks['T-002'].rework_rounds, 1, 'T-002 should have been reworked once after failing verify');
  assert.equal(st.tasks['T-003'].rework_rounds, 1, 'T-003 should have been reworked once after a reviewer FAIL');
  assert.equal(st.tasks['T-004'].status, 'PLANNED');
  assert.notEqual(st.tasks['T-001'].implementer, null);
  assert.equal(st.tasks['T-001'].reviewer, 'rev-1');
  // work is on the milestone branch, not on main
  assert.equal(gitOut(dir, 'show', 'milestone/m1:src/c/T-003.txt'), 'ok');
  assert.throws(() => gitOut(dir, 'show', 'main:src/c/T-003.txt'));
  // notifications were produced
  assert.ok(fs.existsSync(path.join(dir, '.sf/runtime/notifications.log')));
  assert.match(fs.readFileSync(path.join(dir, '.sf/runtime/status.md'), 'utf8'), /Milestones:/);
  // approve offline, resume
  node(SF, ['approve', '--milestone', 'M1', '--confirmed-by', 'user'], { cwd: dir });
  r = node(SF, ['run', '--allow-unverified', '--exit-when-idle'], { cwd: dir, allowFail: true });
  assert.equal(r.code, 3, r.stdout + r.stderr);
  st = readState(dir);
  assert.equal(st.milestones.M1.status, 'DONE');
  assert.equal(st.tasks['T-004'].status, 'INTEGRATED');
  assert.equal(st.milestones.M2.status, 'AWAITING_APPROVAL');
  assert.equal(gitOut(dir, 'show', 'milestone/m2:src/a/T-001.txt'), 'ok', 'M2 branch must include M1 work');
  node(SF, ['approve', '--milestone', 'M2', '--confirmed-by', 'user'], { cwd: dir });
  r = node(SF, ['run', '--allow-unverified'], { cwd: dir, allowFail: true });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  st = readState(dir);
  assert.ok(Object.values(st.milestones).every((m) => m.status === 'DONE'));
  assert.ok(fs.existsSync(path.join(dir, '.sf/runtime/report.md')));
  const report = node(SF, ['report'], { cwd: dir }).stdout;
  assert.match(report, /Tasks integrated:\*\* 4\/4/);
  assert.equal(fs.existsSync(path.join(dir, '.sf/runtime/worktrees/m1/t-001')), false, 'task worktrees cleaned after integration');
});

test('out-of-scope edits are rejected deterministically and exhaust rework → BLOCKED, dependants wait', () => {
  const dir = setup({ implEnv: { FAKE_ALWAYS_OUT_OF_SCOPE: 'T-001' }, maxRework: 1 });
  const r = node(SF, ['run', '--allow-unverified', '--exit-when-idle'], { cwd: dir, allowFail: true });
  assert.equal(r.code, 3, r.stdout + r.stderr);
  const st = readState(dir);
  assert.equal(st.tasks['T-001'].status, 'BLOCKED');
  assert.match(st.tasks['T-001'].blocked_reason, /max rework rounds/);
  assert.equal(st.tasks['T-003'].status, 'PLANNED', 'dependant must not start');
  assert.equal(st.tasks['T-002'].status, 'INTEGRATED', 'independent work continues');
  assert.equal(st.tasks['T-001'].attempt, 2);
  const ex = node(SF, ['explain', 'T-001'], { cwd: dir }).stdout;
  assert.match(ex, /outside the allowed write scopes/);
  // operator unblocks with extra rounds but the agent keeps failing → blocked again, no infinite loop
  node(SF, ['unblock', 'T-001', '--extra-rounds', '1', '--note', 'retry'], { cwd: dir });
  const r2 = node(SF, ['run', '--allow-unverified', '--exit-when-idle'], { cwd: dir, allowFail: true });
  assert.equal(r2.code, 3);
  assert.equal(readState(dir).tasks['T-001'].status, 'BLOCKED');
  assert.equal(readState(dir).tasks['T-001'].attempt, 4, '1 extra round allows exactly two more attempts');
});

test('refuses to run an unapproved plan and unverified agents', () => {
  const dir = setup();
  const noDoctor = node(SF, ['run', '--exit-when-idle'], { cwd: dir, allowFail: true });
  assert.notEqual(noDoctor.code, 0);
  assert.match(noDoctor.stderr, /not verified/);
  const planFile = path.join(dir, '.sf/plan.yaml');
  fs.writeFileSync(planFile, fs.readFileSync(planFile, 'utf8').replace('status: approved', 'status: draft'));
  const r = node(SF, ['run', '--allow-unverified', '--exit-when-idle'], { cwd: dir, allowFail: true });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /status is "draft"|approved/);
});

test('spec drift after plan approval blocks the run', () => {
  const dir = setup();
  const specFile = path.join(dir, '.sf/spec.md');
  fs.writeFileSync(specFile, fs.readFileSync(specFile, 'utf8').replace('The system shall provide feature alpha.', 'The system shall provide feature alpha, changed.'));
  const r = node(SF, ['run', '--allow-unverified', '--exit-when-idle'], { cwd: dir, allowFail: true });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /spec drift/);
});

test('detached supervisor can be waited on and stopped', () => {
  const dir = setup({ implEnv: { FAKE_SLEEP_MS: '300' } });
  const start = node(SF, ['run', '--detach', '--allow-unverified'], { cwd: dir });
  assert.match(start.stdout, /Supervisor started in background/);
  const w = JSON.parse(node(SF, ['wait', '--json', '--timeout', '60'], { cwd: dir, allowFail: true }).stdout);
  assert.ok(['event', 'complete', 'supervisor_not_running'].includes(w.reason), w.reason);
  const st = node(SF, ['status', '--json'], { cwd: dir }).stdout;
  assert.ok(JSON.parse(st).task_counts);
  node(SF, ['stop'], { cwd: dir, allowFail: true });
});

test('local milestone merge brings work onto the base branch', () => {
  const dir = setup({ approvals: { milestone_merge: false }, gitCfg: { milestone_merge: 'local' } });
  const r = node(SF, ['run', '--allow-unverified'], { cwd: dir, allowFail: true });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(gitOut(dir, 'show', 'main:src/d/T-004.txt'), 'ok');
  assert.equal(gitOut(dir, 'show', 'main:src/a/T-001.txt'), 'ok');
});
