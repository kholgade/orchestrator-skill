---
name: sf-plan-builder
description: Produce an approved execution plan (.sf/plan.yaml) from an approved spec — milestones, task DAG, non-overlapping write scopes, verify commands, requirement traceability — by analysis with user review, or delegation to the configured planner agent. Run when no approved plan exists, after a spec change, or when work must be restructured or amended. Required by sf-orchestrator.
version: 0.0.7
---

# sf-plan-builder

CLI: `node <skill-dir>/scripts/plan.mjs <cmd>` (cwd = project root; Node ≥ 20). Format: `references/plan-format.md` (read before writing).

| cmd | effect |
|---|---|
| `scaffold [--force]` | draft plan: one task per requirement, spec criteria copied verbatim, placeholder scopes |
| `lint [--json] [--require-approved]` | schema, DAG, coverage, scopes, spec drift, agent assignment; exit≠0 on errors |
| `order` / `graph` / `coverage [--json]` | layers / Mermaid / REQ→task matrix |
| `approve` + confirmation flags | requires approved spec; lint; records `spec.hash`, `status: approved`; appends `.sf/ledger.jsonl` |
| `rehash` | after spec change: update `spec.hash`, reset to draft |
| `status [--json]` | summary incl. spec drift |
| `brief --out f [--preferences f]` / `delegate [--preferences f] [--rounds n]` | planner-agent authoring with lint feedback loop |

Confirmation flags: terminal use prompts and records `user`. Non-interactive: ask the user first, then `--confirmed-by user --quote "<their words>" [--via <you>]` (remote supervisor: `--confirmed-by external:<id>`). Never pass without the user's yes.

## Resume check (run first)
`status --json`. If a plan exists with `status: draft`, show the user its state (`lint`, `coverage`) and ask **continue** or **start over**. Start over = copy to `.sf/drafts/plan.archive-<timestamp>.yaml`, then `scaffold --force`. The plan file itself is the durable draft; edit it incrementally.

## Preconditions
- Approved spec: `node ../sf-spec-builder/scripts/spec.mjs status`. If not approved → run `sf-spec-builder`.
- `.sf/factory.yaml` present for assignment checks. If absent → run `sf-agent-setup`.

## Mode selection
- User supplied plan YAML → copy to `.sf/plan.yaml`, `lint`, review, `approve`.
- `roles.planner` ≠ `session` and user wants delegation → `delegate`, then review output with the user.
- Otherwise: `scaffold`, then refine as below.

## Procedure
1. Inspect repo: stack, layout, tests, build/lint commands (package.json, Makefile, pyproject, CI), rule files.
2. Milestones: each ends in a testable state; set `exit_criteria` and gate `verify`.
3. Tasks: 1–3 h of agent work, independently verifiable, `requirements[]` set. If no test harness exists, first task creates it; others depend on it.
4. `write_scopes`: relative paths/globs, never `.sf/`. Tasks with no dependency path between them get disjoint scopes. Shared files (lockfiles, registries, indexes) go to one task or are serialized via `depends_on`.
5. `acceptance_criteria`: spec criteria verbatim + task-specific only when needed.
6. `verify[]`: real, fast, exit-code-based commands. Execute each candidate once to confirm it works before recording it.
7. Assignment: leave `implementer`/`reviewer` unset unless user pins; use `requires[]` for capability needs.
8. `lint` exit 0; read warnings (scope overlap, missing verify). Show `order`, `coverage`, `graph`.
9. Present milestones, tasks, dependencies, parallel layers, assumptions (also in `notes`). Obtain explicit user approval. `approve --confirmed-by user --quote "<their words>"`. Never approve without it.
10. Next: `sf-orchestrator`.

## Amending an existing plan
Edit plan (add; never delete non-INTEGRATED tasks) → `lint` → user approval → `rehash` if spec changed → `approve` → `sf.mjs stop`, `sf.mjs assess`, then follow sf-orchestrator Step 1. New tasks sync into existing state; edits to started tasks are "breaking" and need a confirmed resume decision.

## Constraints
- Every must/should requirement covered by ≥1 task.
- No placeholders (`REPLACE_…`, TODO) in the plan.
- Do not implement.
