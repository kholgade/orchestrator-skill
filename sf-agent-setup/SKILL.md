---
name: sf-agent-setup
description: Build and verify .sf/factory.yaml (agent CLIs, role map, limits, git/approval/notification policy). Run when .sf/factory.yaml is missing, invalid, has unverified agents, or the user changes agents, roles, models, parallelism, git policy, approvals or notifications. Other sf-* skills call this first.
version: 0.0.7
---

# sf-agent-setup

CLI: `node <skill-dir>/scripts/setup.mjs <cmd>` (cwd = project root; Node ≥ 20).

| cmd | effect |
|---|---|
| `init [--force]` | create `.sf/`, `.sf/.gitignore`, commented `factory.yaml` template |
| `probe <cli> [--json]` | path, `--version`, `--help` excerpt |
| `validate [--json]` | schema + semantic lint; exit≠0 on error |
| `doctor [--agent id] [--all] [--timeout s]` | real smoke prompt per agent → `.sf/runtime/doctor.json` |
| `show` | role map summary |
| `check [--json]` | exit 0 iff factory valid and used agents verified |

## Procedure
1. `check --json`. If `.sf/factory.yaml` exists, read it; ask only about gaps or requested changes.
2. Read repo rule files (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`); list them in `project.instructions`. Require git repo with ≥1 commit; otherwise tell the user to `git init` + commit.
3. Collect from the user, one topic per message, with a proposed default:
   - agent CLI names (any; never assume) → run `probe` on each;
   - roles: `spec_author`, `planner` (agent id | `session`), `implementers[]`, `reviewers[]`, `orchestrator` (informational);
   - per agent: `model`, `capabilities[]`, `max_concurrency`, `timeout_minutes`;
   - `execution.max_parallel_tasks`, `max_rework_rounds` (default 2), `review_independence` (`agent|model|provider`);
   - `git.milestone_merge` (`manual|local`), `git.base_branch` (`auto`);
   - `approvals.plan`, `approvals.milestone_merge` (default true);
   - `notify.interval_minutes` (default 5; 0 = off) and channels `terminal|file|webhook(preset telegram|slack|discord|generic)`;
   - per agent, optional audit capture: `artifacts[]` (files/dirs the agent writes, e.g. a session/transcript directory via its own flag + `{{run_dir}}`), `session_id_regex` (one capture group) and `resume_args` (agent-native resume). Derive from `probe` output only; skip when the CLI has no such feature. Structured-output flags (e.g. a JSON event stream) are captured automatically in the stdout log.
4. For each agent, derive from `probe` output (not memory): headless flag, prompt delivery (`{{prompt_pointer}}` arg | `{{prompt}}` | `input: stdin`), model flag as `{if: model, args: [...]}`, edit-permission flag. Read `references/agent-profiles.md`.
5. Permission/auto-approve flags: state what the flag permits; use the narrowest working mode; get explicit user consent before enabling. Reviewers: read-only mode when available; stdout JSON is accepted.
6. Write `.sf/factory.yaml` (strict YAML: spaces only; quote values containing `: `).
7. `validate` until exit 0. `doctor --all` until every used agent is OK. On failure read the printed stdout/stderr log paths, change `args`/`input`/`env`, repeat.
8. `show`; report role map, notification channels, and the env vars the user must export. Hand back to the invoking skill or name next: `sf-spec-builder`.

## Constraints
- Every command, flag and model must come from the user, the repo, or `probe`. Do not invent.
- Webhook secrets only as `${ENV_VAR}`; never write or request literal tokens.
- Do not finish with unverified agents unless the user explicitly accepts.
- Keep agent ids and `project.id` stable.

## Files
`references/agent-profiles.md` (profile fields, placeholders, delivery modes, CLI hints) · `templates/factory.template.yaml`.
