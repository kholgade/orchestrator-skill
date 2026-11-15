#!/usr/bin/env node
// Deterministic stand-in for a coding agent, used by the end-to-end tests. Behaviour is driven by env vars:
//   FAKE_BAD_FIRST=T-002,...    first attempt of these tasks writes wrong content (verify fails → rework)
//   FAKE_ALWAYS_OUT_OF_SCOPE=T-001  always also writes a file outside the allowed scope
//   FAKE_REVIEW_FAIL_FIRST=T-003   reviewer FAILs the first review of these tasks
//   FAKE_SLEEP_MS=n                sleep before working (to exercise timeouts / parallelism)
import fs from 'node:fs';
import path from 'node:path';

const role = process.env.SF_ROLE;
const task = process.env.SF_TASK_ID;
const attempt = Number(process.env.SF_ATTEMPT ?? '1');
const brief = fs.readFileSync(process.env.SF_BRIEF_FILE, 'utf8');
const list = (name) => (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
await new Promise((r) => setTimeout(r, Number(process.env.FAKE_SLEEP_MS ?? 0)));
const sleptMarker = path.join(process.env.SF_ROOT ?? '.', `.slept-${task}`);
if (role === 'implementer' && list('FAKE_SLEEP_TASKS').includes(task) && process.env.FAKE_SLEEP_ATTEMPT1_MS && !fs.existsSync(sleptMarker)) {
  fs.writeFileSync(sleptMarker, '1');
  await new Promise((r) => setTimeout(r, Number(process.env.FAKE_SLEEP_ATTEMPT1_MS)));
}

if (role === 'doctor') {
  console.log(brief.match(/SF_OK_[A-Z0-9]+/)[0]);
} else if (role === 'implementer') {
  const scopeBlock = brief.split('## Allowed write scope')[1].split('\n').filter((l) => l.startsWith('- '));
  const scope = scopeBlock[0].slice(2).trim();
  const bad = list('FAKE_BAD_FIRST').includes(task) && Number(process.env.FAKE_REWORK_ROUND ?? attempt) === 1 && attempt === 1;
  fs.mkdirSync(path.join(process.cwd(), scope), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), scope, `${task}.txt`), bad ? 'bad\n' : 'ok\n');
  if (list('FAKE_ALWAYS_OUT_OF_SCOPE').includes(task)) fs.writeFileSync(path.join(process.cwd(), 'outside.txt'), 'x\n');
  console.log(`implemented ${task} attempt ${attempt}`);
} else if (role === 'reviewer') {
  const criteria = JSON.parse(brief.split('Criteria to echo, as a JSON array:')[1].trim());
  const fail = list('FAKE_REVIEW_FAIL_FIRST').includes(task) && !fs.existsSync(path.join(process.env.SF_ROOT, '.reviewed-' + task));
  if (fail) fs.writeFileSync(path.join(process.env.SF_ROOT, '.reviewed-' + task), '1');
  const result = {
    task_id: task,
    status: fail ? 'FAIL' : 'PASS',
    summary: fail ? 'criteria not met' : 'all criteria verified',
    reviewer: process.env.SF_AGENT_ID,
    criteria: criteria.map((c) => ({ criterion: c, status: fail ? 'FAIL' : 'PASS', evidence: fail ? 'missing behaviour' : 'inspected output file and verify logs' })),
    findings: fail ? [{ id: 'F1', severity: 'blocking', description: 'behaviour missing', required_fix: 'implement it' }] : [],
  };
  fs.writeFileSync(process.env.SF_RESULT_FILE, JSON.stringify(result));
  console.log('```json\n' + JSON.stringify(result) + '\n```');
}
