## Plan file format (`plan/1`) — `.sf/plan.yaml`

Strict YAML subset (spaces only; quote values containing `: `). Unknown fields are rejected.

```yaml
sf: plan/1
project: {id: my-project, name: My Project}
spec: {path: .sf/spec.md}          # hash is recorded by `plan.mjs approve`
status: draft                       # draft | approved
notes: Assumptions and decisions the planner made.

milestones:
  - id: M1
    title: Foundations
    goal: Project skeleton with working test harness
    depends_on: []                  # other milestone ids
    exit_criteria: [Harness runs in CI]
    verify:                         # integration gate, run in the milestone branch after all tasks merge
      - {name: full tests, run: npm test}

tasks:
  - id: T-001
    milestone: M1
    title: Project scaffold
    goal: Create the package layout and test harness.
    requirements: [REQ-001]         # traceability; every must/should REQ needs ≥1 task
    depends_on: []                  # task ids (same milestone, or a milestone M1's milestone depends on)
    write_scopes: [package.json, src, tests]   # relative paths or globs; subtree semantics for plain paths
    acceptance_criteria:            # reviewer must mark each PASS with evidence
      - npm test exits 0 on a clean checkout
    verify:                         # deterministic evidence run by the orchestrator in the task worktree
      - {name: unit tests, run: npm test, timeout_minutes: 10}
    implementer: pi                 # optional: pin an agent id from roles.implementers
    reviewer: claude                # optional: pin an agent id from roles.reviewers
    requires: [coding]              # optional: agent capability tags needed
    max_rework_rounds: 3            # optional override
```

### Semantics the orchestrator enforces
- A task starts only when all `depends_on` tasks are INTEGRATED and its milestone is ACTIVE.
- Milestone M starts only when every milestone in its `depends_on` is DONE.
- Tasks that overlap in `write_scopes` never run at the same time (lint warns; runtime serializes).
- After the implementer finishes, the orchestrator itself runs `verify`, checks that only `write_scopes` were
  touched, and only then asks an **independent** reviewer. Failures go straight back to rework with the evidence.
- `write_scopes` must not touch `.sf/`.

### Lint checks (`plan.mjs lint`)
schema/unknown fields · duplicate ids · unknown milestone/task/requirement references · dependency cycles ·
cross-milestone dependencies without a milestone dependency · requirement coverage · placeholder scopes ·
spec drift (hash mismatch) · implementer/reviewer existence, capability and independence against `factory.yaml`.

### Approval
`plan.mjs approve` re-lints, records `spec.hash`, sets `status: approved` and `approved_at`. That is the
human gate (`approvals.plan` in factory.yaml): the orchestrator refuses to run an unapproved plan.
