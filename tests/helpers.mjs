import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stringify } from '../sf-shared/lib/yaml.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FAKE = path.join(REPO, 'tests', 'fixtures', 'fake-agent.mjs');
export const script = (skill, name) => path.join(REPO, skill, 'scripts', name);

export function tmpRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-test-')));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  fs.writeFileSync(path.join(dir, 'verify.mjs'), "import fs from 'node:fs';process.exit(fs.readFileSync(process.argv[2],'utf8').trim()==='ok'?0:1);\n");
  fs.writeFileSync(path.join(dir, '.gitignore'), '.sf/runtime/\n.reviewed-*\n.slept-*\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

export function node(file, args, { cwd, env = {}, allowFail = false } = {}) {
  const r = spawnSync(process.execPath, [file, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0 && !allowFail) throw new Error(`${path.basename(file)} ${args.join(' ')} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function fakeAgent(id, { caps = ['coding'], env = {}, extra = {} } = {}) {
  return { id, command: process.execPath, args: [FAKE, '{{prompt_pointer}}'], capabilities: caps, env, max_concurrency: 2, timeout_minutes: 2, ...extra };
}

export function writeFactory(dir, { agents, roles, execution = {}, notify, approvals, git } = {}) {
  const f = {
    sf: 'factory/1',
    project: { id: 'e2e', name: 'E2E' },
    agents,
    roles: { spec_author: 'session', planner: 'session', ...roles },
    execution: { max_parallel_tasks: 2, max_rework_rounds: 2, poll_seconds: 0.05, ...execution },
    notify: notify ?? { interval_minutes: 0.005, channels: [{ type: 'file' }] },
    ...(approvals ? { approvals } : {}),
    ...(git ? { git } : {}),
  };
  fs.mkdirSync(path.join(dir, '.sf'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.sf', 'factory.yaml'), stringify(f));
}

export function writeSpec(dir) {
  const answers = {
    title: 'E2E Project',
    requirements: ['alpha', 'beta', 'gamma', 'delta'].map((n, i) => ({
      title: `Feature ${n}`, statement: `The system shall provide feature ${n}.`,
      criteria: [`Feature ${n} output file contains the word ok`],
      ...(n === 'gamma' ? { depends: ['REQ-001', 'REQ-002'] } : {}),
      id: `REQ-00${i + 1}`,
    })),
  };
  fs.writeFileSync(path.join(dir, 'answers.yaml'), stringify(answers));
  node(script('sf-spec-builder', 'spec.mjs'), ['from-answers', 'answers.yaml'], { cwd: dir });
  node(script('sf-spec-builder', 'spec.mjs'), ['approve', '--confirmed-by', 'user', '--quote', 'test'], { cwd: dir });
}

export function writePlan(dir, { maxRework } = {}) {
  const task = (id, milestone, req, scope, deps = []) => ({
    id, milestone, title: `Task ${id}`, goal: `Implement ${req}`, requirements: [req], depends_on: deps,
    write_scopes: [scope], acceptance_criteria: [`Feature ${{ 'REQ-001': 'alpha', 'REQ-002': 'beta', 'REQ-003': 'gamma', 'REQ-004': 'delta' }[req]} output file contains the word ok`],
    verify: [{ name: 'content check', run: `node verify.mjs ${scope}/${id}.txt` }],
    ...(maxRework !== undefined ? { max_rework_rounds: maxRework } : {}),
  });
  const plan = {
    sf: 'plan/1', project: { id: 'e2e' }, spec: { path: '.sf/spec.md' }, status: 'draft',
    milestones: [
      { id: 'M1', title: 'First', depends_on: [], verify: [{ name: 'all files ok', run: 'node verify.mjs src/a/T-001.txt' }] },
      { id: 'M2', title: 'Second', depends_on: ['M1'] },
    ],
    tasks: [
      task('T-001', 'M1', 'REQ-001', 'src/a'),
      task('T-002', 'M1', 'REQ-002', 'src/b'),
      task('T-003', 'M1', 'REQ-003', 'src/c', ['T-001', 'T-002']),
      task('T-004', 'M2', 'REQ-004', 'src/d'),
    ],
  };
  fs.writeFileSync(path.join(dir, '.sf', 'plan.yaml'), stringify(plan));
  node(script('sf-plan-builder', 'plan.mjs'), ['approve', '--confirmed-by', 'user', '--quote', 'test'], { cwd: dir });
}

export function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, '.sf', 'runtime', 'state.json'), 'utf8'));
}
export const gitOut = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
