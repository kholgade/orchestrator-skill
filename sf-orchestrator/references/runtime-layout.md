# Runtime layout and contracts (sf 0.0.8)

## Files
```
.sf/
  factory.yaml        agents, roles, limits, policy                         (sf-agent-setup)       committed
  spec.md / spec.index.json                                                  (sf-spec-builder)      committed
  plan.yaml                                                                  (sf-plan-builder)      committed
  ledger.jsonl        hash-chained governance record: spec/plan/milestone approvals, resume/reset/restore/prune
                      build_consent answers, decisions, decision notes, delegate results. who={confirmed_by, via, quote}.   committed
  drafts/             interview drafts (spec.answers.yaml, …)
  archive/<run-id>[.n]/   archived runs (manifest.json, state.json, events.jsonl, runs/, worktrees/, tasks/)   ignored
  runtime/            the ACTIVE run only (one per project)                                          ignored
    state.json        derived snapshot (rebuildable from events.jsonl)
    events.jsonl      hash-chained write-ahead event log (source of truth)
    supervisor.lock   {pid, fp(process start time), heartbeat_at, sf_version}
    state.lock        short mutation lock for offline CLI writes
    inbox/            commands queued for the running supervisor (single writer to the log)
    status.md, notifications.log, report.md, supervisor.log, doctor.json
    worktrees/<milestone>/<task>/, worktrees/<milestone>/_integration/
    runs/<task>/attempt-N/{brief.md, <agent>.stdout.log, <agent>.stderr.log, <agent>.meta.json, verify-*.log,
                            review-R-A/{brief.md, diff.patch, review-result.json, verdict.json}}
git refs: refs/sf/<run-id>/<task>/attempt-N and /integrated pin every attempt commit and the merge commit.
```

## Event schema (v1) — events.jsonl and ledger.jsonl
`{v, sf, seq, ts, run_id, severity, type, actor, entity, id, attempt?, op_id?, msg, data?, prev, hash}`
`hash = sha256(prev + "\n" + JSON(event without hash))`; `prev` of the first event is 64 zeros. `msg`/`data` are secret-redacted.
Severities: `info`, `warn`, `error`, `approval`, `done`. Actors: `supervisor`, `user`, `external:<id>`, `agent:<id>`.

Key types: `state_init` (full state) · `state_delta` (`{set:[[path[],value]], del:[path[]]}`; folding init+deltas reproduces state at any seq) ·
`task_transition` / `milestone_transition` · `scheduled` / `deferred` (why not dispatched) ·
`intent` + `result` pairs sharing `op_id` (`op-<intent seq>`) for `agent_run`, `commit`, `verify`, `review`, `merge` — an intent without a result is an interrupted operation ·
`scope_checked` · `git_op` (worktree add/remove, merges, resets with shas) · `review_verdict` · `review_adopted` · `reviewer_modified_worktree` ·
`orphan_killed` / `orphan_not_killed` · `ops_reconciled` · `state_repaired` · `resume_decision` · `task_reset` · `operator_command` · `note` · `approval_granted` · `supervisor_started/stopped` · `run_complete`.

`result` for `agent_run` carries: status, exit_code, duration_ms, pid, argv (redacted), stdout/stderr paths, session_id, artifacts[{path,size,sha256}].
`intent` for `agent_run` carries: agent, model, cwd, brief path + sha256, resumed_session.

## Run classes (assess)
`fresh` · `running` · `completed` · `clean_stop` · `crashed` (supervisor pid recorded, dead, no stop reason) · `inconsistent` (broken log chain, git contradicts state, tasks missing from plan).
`assessment_id` = hash of class + per-task git facts + drift + pending ops; a confirmed decision is bound to it and is single-use.

## Write-ahead rule
The `state_delta` event is appended BEFORE state.json is written. If state.json lags (crash in between) or is edited, the supervisor rebuilds it from the log on resume (`state_repaired`). If the log chain itself is broken the run is `inconsistent`.

## Task states
`PLANNED → READY → RUNNING → (REVIEW | REWORK | BLOCKED)`; `REVIEW → (PASS | REWORK | BLOCKED)`; `REWORK → RUNNING`; `PASS → INTEGRATED`; `BLOCKED → READY` (operator only).
Interrupted `RUNNING` → `READY` on resume (worktree kept; brief says partial work exists; agent session resumed if the profile supports it).

## Milestone states
`PLANNED → ACTIVE → GATE → (AWAITING_APPROVAL →) DONE`; `BLOCKED` from any active state; `BLOCKED → ACTIVE | GATE`.

## Review result contract (JSON)
Reviewer writes `{{result_file}}` and/or prints it as the last ```json block on stdout.
```json
{ "task_id": "T-001", "status": "PASS | FAIL | BLOCKED", "summary": "…", "reviewer": "agent-id",
  "criteria": [{ "criterion": "<exact text>", "status": "PASS | FAIL | NOT_VERIFIED", "evidence": "…" }],
  "findings": [{ "id": "F1", "severity": "blocking | major | minor | info", "file": "…", "description": "…", "required_fix": "…" }] }
```
PASS requires: automated evidence green, reviewer PASS, every criterion present with PASS and evidence, no blocking/major findings.

## Environment exposed to every agent run
`SF_AGENT_ID SF_ROLE (implementer|reviewer|spec|plan|doctor) SF_TASK_ID SF_ATTEMPT SF_BRIEF_FILE SF_RESULT_FILE SF_RUN_DIR SF_ROOT`

## Exit codes of `sf.mjs`
0 ok · 1 error/not ready · 2 usage · 3 `run --exit-when-idle` idle · 4 decision or confirmation required.
