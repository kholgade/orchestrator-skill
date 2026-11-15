# Skills for Factory (`sf-*`) — v0.0.6

> **See the whole workflow:** open [`docs/orchestrator-workflow.html`](docs/orchestrator-workflow.html) — pre-flight and consent, run assessment, supervision loop, per-task pipeline, state machines, crash recovery, audit trail. It is generated from the code (`npm run docs`) and checked by the tests, so it cannot silently go stale.

Four cooperating skills that let any coding agent (Claude, Codex, Cursor, Kiro, Pi, Cline, OpenCode, …) plan and
deliver software with a team of other agents — with as much as possible done by deterministic Node scripts, and the
LLM used only where judgment is needed.

| Skill | Job | LLM does | Scripts do |
|---|---|---|---|
| `sf-agent-setup` | Interview → `.sf/factory.yaml` (agents, role map, limits, git/approval/notify policy) | the interview, reading `--help`, choosing flags | probe CLIs, strict validation, real smoke-test (`doctor`) |
| `sf-spec-builder` | Interview / answers YAML / delegate → approved `.sf/spec.md` | drafting requirements with the user | format, lint, ids, index + hash, approval |
| `sf-plan-builder` | Approved spec → approved `.sf/plan.yaml` (milestones, task DAG, scopes, verify) | task slicing, choosing real verify commands | scaffold, DAG/coverage/scope/drift/assignment lint, graph, approval |
| `sf-orchestrator` | Runs the plan with agents; invokes the three above when inputs are missing | triage of blocked work, talking to the user | scheduling, worktrees, dispatch, evidence, scope check, review verdict, merge, gates, notifications, resume |

```
user ──► sf-orchestrator ──check──► sf-agent-setup ► sf-spec-builder ► sf-plan-builder   (only what is missing)
              │
              ▼ run --detach
        supervisor (Node, no LLM) ── dispatch ──► implementer agents (parallel, one git worktree each)
              │   ▲                                   │ commit
              │   └── rework with exact evidence ◄─ verify commands + write-scope check (run by the supervisor)
              │                                       │ green
              │                                       ▼
              │                              independent reviewer agent ── JSON verdict ── code decides PASS
              ▼
   integrate (--no-ff, one at a time, re-verify) ► milestone gate ► human approval ► DONE
   digests every 5 min + immediate alerts ► terminal / status.md / Telegram, Slack, Discord, webhook
```

## Principles
- **Agent-agnostic:** agents are data (`factory.yaml`): an executable, an argv template, how the prompt is delivered.
  No agent is hard-coded; `doctor` proves each profile works. Mix freely, e.g. Codex orchestrating, Claude planning,
  Pi/Cline/OpenCode implementing, another model reviewing.
- **Platform-agnostic:** plain Node ≥ 20 ES modules, zero dependencies (strict built-in YAML subset parser), no shell
  required for agent execution.
- **Shared contract:** spec → index → plan → state use schemas and linters; requirement ids trace through tasks,
  criteria, reviews and the final report. Spec changes after plan approval are detected (hash drift).
- **Evidence over claims:** the supervisor runs the verify commands and checks the diff itself; a reviewer must justify
  every criterion; the verdict is computed. Bounded rework, then BLOCKED for a human/LLM decision.
- **Safe by default:** isolated worktrees, no direct commits to the base branch, human gates for plan and milestones,
  secrets only via environment variables, reviewers cannot modify code (changes are reverted and the review discarded).

## Resumable and auditable by design
- **One active run per project**, enforced by a supervisor lock (pid + process start time + heartbeat) and a short state-mutation lock.
- **Write-ahead, hash-chained event log** (`.sf/runtime/events.jsonl`) is the source of truth; `state.json` is a derived snapshot that is rebuilt from the log if it ever lags. Every side effect is journaled as an `intent` / `result` pair (agent run, commit, verify, review, merge), so an interrupted operation is visible.
- **`assess`** (read-only) classifies a previous run — `clean_stop`, `crashed`, `inconsistent`, … — by comparing state, log, plan/spec drift and actual git (worktrees, branches, dirty files, orphan processes). **`run` refuses to continue a crashed/inconsistent/drifted run** until `resume --assessment <id> --decision …` is confirmed. Confirmation: interactive prompt as `user`, or `--confirmed-by user --quote "…"` (an agent that asked the user) / `--confirmed-by external:<id>` (remote supervisor).
- **Orphans** left by a dead supervisor are killed only after their identity (pid + start time) is verified, so a reused pid is never killed.
- **Reset never deletes:** `reset-run` / `reset-task` archive state, logs, worktrees and branches under `.sf/archive/<run-id>` and tell the agent to ask the user before `archive prune`. Archived runs can be restored while no run is active.
- **Replayable evidence:** `timeline`, `replay --to <seq>`, `export --out dir` (redacted, hashed bundle with state replayed from events), `events --follow --json` for external supervisors; every attempt commit is pinned under `refs/sf/<run>/…`; approvals and decisions go to the committed `.sf/ledger.jsonl`. Prompts, diffs, stdout/stderr and (profile-configured) agent session artifacts are retained in full; secrets are redacted.

## Install
```bash
node scripts/install.mjs                 # detect agents; choose main agent / all detected / .sf/skills / .agents/skills
node scripts/install.mjs --list          # what is detected + where each agent loads skills from
node scripts/install.mjs --agent claude,codex --yes        # specific agents, no prompt
node scripts/install.mjs --all-detected --standard --yes   # every detected agent + tool-neutral .sf/skills (+AGENTS.md pointer)
node scripts/install.mjs --agents-standard --dry-run       # cross-agent .agents/skills; show the plan only
node scripts/install.mjs --scope user --agent claude       # ~/.claude/skills instead of <workspace>/.claude/skills
```
- **Detection:** a CLI on PATH or an agent config directory, using `scripts/agent-registry.yaml` — Claude Code, Codex, Copilot, Cursor, Gemini CLI, OpenCode, Kiro, Cline, Windsurf, Pi (paths taken from each vendor's docs; sources and a `confidence` field are in the file; edit it or pass `--registry`).
- **Default scope is the workspace**; nothing in your home directory unless `--scope user`. Several agents detected → interactive menu; non-interactive callers (an agent running the script) get the options as JSON and exit 4, ask the user, and re-run with flags + `--yes`.
- All four skills go to every chosen target (they reference each other as siblings). Each skill folder is self-contained (shared lib vendored into `scripts/lib/`). Existing folders not created by the installer are never overwritten without `--force`. `--link` symlinks while developing; `.sf/install.json` records installs.

## Quick start (in your project, a git repo with ≥1 commit)
```bash
node sf-orchestrator/scripts/sf.mjs check          # tells you which skill to run next
# …follow sf-agent-setup → sf-spec-builder → sf-plan-builder (or just ask your agent: "use sf-orchestrator to build X")
node sf-orchestrator/scripts/sf.mjs run --detach   # supervisor in the background
node sf-orchestrator/scripts/sf.mjs wait           # returns on blocked / approval / done
node sf-orchestrator/scripts/sf.mjs approve --milestone M1
```
Telegram updates: `notify.channels: [{type: webhook, preset: telegram, url: "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage", chat_id: "${TELEGRAM_CHAT_ID}"}]`
with both variables exported. Updates are one-way; approvals happen through the CLI.

## Layout
```
sf-shared/lib/     source of truth for the shared Node library (yaml, schemas, runner, git, state, spec, plan, notify…)
sf-*/              the skills: SKILL.md, scripts/ (+ vendored scripts/lib), templates/, references/
scripts/           sync-shared.mjs (vendor lib into skills), install.mjs + agent-registry.yaml (detection + skill directories)
tests/             node:test suites incl. an end-to-end run with a fake agent
docs/              orchestrator-workflow.html — the complete workflow as diagrams (generated: `npm run docs`)
archive/           retired material: the Python prototype and the source prompts the design generalised from
```
Develop: edit `sf-shared/lib`, run `npm run sync` (and `npm run docs` after changing states, commands or the agent registry), then `npm test` (sync + 32 tests incl. crash/kill -9 recovery and installer, ~20 s).

## Status and limits (honest)
- Tested end to end with a deterministic fake agent on macOS (parallelism, rework, scope violations, approvals,
  crash + orphan recovery, reset/restore/prune, replay/export, local merge, detached supervisor) and `doctor`-verified
  against real `pi` and `cline` CLIs (including session-artifact and session-id capture). Real agent flags differ per
  CLI/version: always verify profiles with `doctor`. Windows paths, `.cmd` shims and process fingerprinting are
  implemented but untested.
- Single machine, single supervisor, file-based state. Not a multi-user service.
- Agent-level permissions (what an agent may read/run) are whatever the agent's own flags enforce; the supervisor
  adds git isolation, scope checks and reviewer-modification detection but is not an OS sandbox.
