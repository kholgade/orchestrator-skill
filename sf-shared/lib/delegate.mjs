// @ts-check
// Delegate an authoring job (spec / plan) to a configured external agent, then validate the result
// deterministically and feed lint findings back for a bounded number of rounds.
import path from 'node:path';
import { SfError, nowIso } from './util.mjs';
import { agentById } from './factory.mjs';
import { runAgent, tailFile } from './runner.mjs';

/**
 * @param {object} o
 * @param {string} o.root
 * @param {any} o.factory
 * @param {any} o.paths
 * @param {string} o.agentId           agent id, or "session" (rejected: caller must author directly)
 * @param {string} o.label             e.g. "spec" | "plan"
 * @param {string} o.brief             full instructions for the agent
 * @param {() => {errors:string[], warnings:string[]}} o.check   re-validates the produced artifact
 * @param {number} [o.maxRounds]
 */
export async function delegateAuthoring(o) {
  if (o.agentId === 'session') {
    throw new SfError(`roles for "${o.label}" is "session": the current agent session must author it directly (no delegation configured).`, { code: 'SESSION_ROLE' });
  }
  const agent = agentById(o.factory, o.agentId);
  const maxRounds = o.maxRounds ?? 3;
  const stamp = nowIso().replace(/[:.]/g, '-');
  const rounds = [];
  let findings = [];
  for (let round = 1; round <= maxRounds; round++) {
    const runDir = path.join(o.paths.runs, `delegate-${o.label}-${stamp}`, `round-${round}`);
    const brief = round === 1 ? o.brief : `${o.brief}\n\n---\n## Validation failed on the previous round — fix ALL of these, change nothing else\n${findings.map((f) => `- ${f}`).join('\n')}\n`;
    const run = await runAgent({
      agent, prompt: brief, promptFile: path.join(runDir, 'brief.md'), cwd: o.root, root: o.root, runDir,
      vars: { role: o.label, task_id: `delegate-${o.label}`, attempt: round },
      timeoutMs: (agent.timeout_minutes ?? o.factory.execution.task_timeout_minutes) * 60000,
    });
    const rec = { round, status: run.status, exitCode: run.exitCode, stdout: run.stdoutPath, stderr: run.stderrPath };
    rounds.push(rec);
    if (run.status !== 'SUCCEEDED') {
      findings = [`agent run ${run.status}${run.error ? `: ${run.error}` : ''}; stderr tail: ${tailFile(run.stderrPath, 500).trim()}`];
      continue;
    }
    let res;
    try {
      res = o.check();
    } catch (e) {
      res = { errors: e.details ?? [e.message], warnings: [] };
    }
    if (res.errors.length === 0) return { ok: true, rounds, warnings: res.warnings, errors: [] };
    findings = res.errors;
  }
  return { ok: false, rounds, warnings: [], errors: findings };
}
