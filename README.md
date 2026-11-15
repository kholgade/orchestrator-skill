# Skills for Factory (`sf-*`) — v0.0.8

[![version](https://img.shields.io/badge/version-0.0.8-blue)](package.json)
[![status](https://img.shields.io/badge/status-pre--release-orange)](#status-and-limits)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2020-339933?logo=nodedotjs&logoColor=white)](package.json)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](sf-shared/lib)
[![agent skills](https://img.shields.io/badge/Agent%20Skills-SKILL.md-8A2BE2)](https://agentskills.io)
[![agents](https://img.shields.io/badge/agents-Claude%20%C2%B7%20Codex%20%C2%B7%20Copilot%20%C2%B7%20Cursor%20%C2%B7%20Gemini%20%C2%B7%20OpenCode%20%C2%B7%20Kiro%20%C2%B7%20Cline%20%C2%B7%20Windsurf%20%C2%B7%20Pi-informational)](scripts/agent-registry.yaml)
[![tested on](https://img.shields.io/badge/tested%20on-macOS-lightgrey?logo=apple)](#status-and-limits)
[![workflow](https://img.shields.io/badge/docs-workflow%20diagrams-1f6feb)](docs/orchestrator-workflow.html)

> **NOTE:** Open [`docs/orchestrator-workflow.html`](docs/orchestrator-workflow.html) to see the complete workflow as diagrams.
> The command `npm run docs` generates the page from the code. A test fails when the page is out of date.

## Overview

The `sf-*` package has five skills. A skill is a text file with instructions for a coding agent.
Four skills form the delivery chain. They let one agent plan software and deliver it with a team of other agents.
The fifth skill is optional. It improves the writing of specs and design documents.

Scripts do all work that has a fixed result. The agent makes a decision only when a decision is necessary.

| Skill | Purpose | The agent does | The scripts do |
|---|---|---|---|
| `sf-agent-setup` | Builds `.sf/factory.yaml`. This file holds the agents, the roles, the limits, and the policy. | Interviews the user. Reads the `--help` output of each agent. | Probe each agent. Validate the file. Send a test prompt to each agent (`doctor`). |
| `sf-spec-builder` | Builds the approved specification `.sf/spec.md`. | Writes the requirements with the user. | Check the format. Check the IDs. Make the index and the hash. Record the approval. |
| `sf-plan-builder` | Builds the approved plan `.sf/plan.yaml`. | Divides the work into tasks. Chooses the verify commands. | Check the task graph, the paths, the coverage, and the drift. Record the approval. |
| `sf-apply-ste` | Rewrites specs and design documents in Simplified Technical English. This skill is optional. | Rewrites the sentences that a script cannot fix. | Check the style. Fix simple problems. Protect requirement IDs and approved specs. |
| `sf-orchestrator` | Delivers the plan with agents. Starts the other three skills when an input is missing. | Handles blocked tasks. Talks to the user. | Schedule tasks. Make worktrees. Start agents. Collect evidence. Merge. Send notifications. Resume. |

```
user ──► sf-orchestrator ──check──► sf-agent-setup ► sf-spec-builder ► sf-plan-builder   (only the missing parts)
              │
              ▼ run --detach
        supervisor (Node, no agent) ── dispatch ──► implementer agents (parallel, one git worktree each)
              │   ▲                                   │ commit
              │   └── rework with exact evidence ◄─ verify commands + path check (run by the supervisor)
              │                                       │ pass
              │                                       ▼
              │                              independent reviewer agent ── JSON verdict ── code decides PASS
              ▼
   integrate (--no-ff, one task at a time, verify again) ► milestone gate ► user approval ► DONE
   digest every 5 minutes + immediate alerts ► terminal / status.md / Telegram, Slack, Discord, webhook
```

## Design rules

- **Agent-neutral.** The file `factory.yaml` describes each agent. The description has the executable, the arguments, and the method to send the prompt. No agent name is in the code. The command `doctor` tests each description. You can mix agents. For example, Codex orchestrates, Claude plans, Pi and Cline implement, and another model reviews.
- **Platform-neutral.** The code uses Node 20 or later. It has no dependencies. It has its own strict YAML parser. It does not need a shell to start an agent.
- **One contract.** Each file format has a schema and a lint check. A requirement ID stays with the task, the review, and the final report. The tools detect a change to the spec after the plan approval.
- **Evidence first.** The supervisor runs the verify commands. The supervisor checks that the changes stay in the allowed paths. The reviewer must give evidence for each criterion. Code computes the verdict. After the allowed rework rounds, the task becomes BLOCKED.
- **Safe defaults.** Each task has its own worktree. No agent commits to the base branch. The user approves the plan and each milestone. Secrets stay in environment variables. A reviewer cannot change code. The supervisor reverts a change by a reviewer and discards that review.

## Resume and audit

- **One run in each project.** A lock enforces this rule. The lock holds the process ID, the process start time, and a heartbeat.
- **The event log is the source of truth.** The log is `.sf/runtime/events.jsonl`. Each event holds the hash of the event before it. The supervisor writes an event before it changes `state.json`. If `state.json` is behind, the supervisor rebuilds it from the log.
- **Intent and result events.** The supervisor records each action as an `intent` event and a `result` event. The actions are agent run, commit, verify, review, and merge. An `intent` event with no `result` event shows an interrupted action.
- **The `assess` command.** It compares the state, the log, the plan, the spec, and git. It changes nothing. It reports one class: `clean_stop`, `crashed`, or `inconsistent`.
- **A decision before a restart.** The `run` command refuses to continue a crashed, inconsistent, or changed run. The user must first confirm a decision. The decision uses `resume --assessment <id> --decision ...`.
- **Three ways to confirm.** In a terminal, the user types the confirmation word. An agent that asked the user passes `--confirmed-by user --quote "..."`. A remote supervisor passes `--confirmed-by external:<id>`.
- **Orphan processes.** The supervisor kills an orphan agent process only after it checks the process ID and the start time. This prevents the kill of an unrelated process.
- **A reset does not delete data.** The commands `reset-run` and `reset-task` move the state, the logs, the worktrees, and the branches to `.sf/archive/<run-id>`. The agent must ask the user before it runs `archive prune`. The user can restore an archived run when no run is active.
- **Replay and export.** Use `timeline`, `replay --to <seq>`, and `export --out <dir>` to examine a run. The command `export` makes a bundle with hashes and no secrets. An external supervisor uses `events --follow --json`.
- **Records.** The supervisor pins each attempt commit under `refs/sf/<run>/...`. Approvals and decisions go to `.sf/ledger.jsonl`. The system keeps all prompts, diffs, and logs. It removes secrets from them.

## Installation

The user runs one command to install the skills. The installer finds your agents. It copies the skills to the correct folders.

```bash
node scripts/install.mjs
```

The installer asks which agent to use. It shows the plan. Then it installs. These options are available:

- `--list`: show the agents found and their skill folders.
- `--agent claude,codex --yes`: install for the named agents. Do not ask questions.
- `--all-detected --standard --yes`: install for all agents found and for the neutral folder `.sf/skills`.
- `--agents-standard`: install in the shared folder `.agents/skills`.
- `--scope user`: install in the home folder.
- `--dry-run`: show the plan and stop.

You can also ask your agent to run the installer.

These rules apply:

1. The installer finds an agent when its command is in the PATH or its configuration folder exists.
2. The file `scripts/agent-registry.yaml` lists the supported agents. They are Claude Code, Codex, Copilot, Cursor, Gemini CLI, OpenCode, Kiro, Cline, Windsurf, and Pi. Each entry has a source and a confidence level. You can edit the file or use `--registry`.
3. The default scope is the workspace. The installer does not write to the home folder unless you use `--scope user`.
4. An agent that runs the script gets the options as JSON and exit code 4. The agent must ask the user. Then it must run the script again with flags and `--yes`.
5. Each target gets all five skills. The skills refer to each other as sibling folders. Each skill folder holds its own copy of the shared library.
6. The installer does not overwrite a folder that it did not create, unless you use `--force`. The option `--link` makes symbolic links. The file `.sf/install.json` records each installation.

## Quick start

1. Install the skills. See Installation.
2. Open your coding agent in your project. The project must be a git repository with at least one commit.
3. Invoke the skill:

```
/sf-orchestrator build <what you want>
```

4. Answer the questions of the agent.

If your agent has no slash command for skills, write the request in plain words. For example: "Use the sf-orchestrator skill to build a todo API." Each skill has a description. The agent uses the description to choose a skill. You can use the other skills alone: `/sf-agent-setup`, `/sf-spec-builder`, `/sf-plan-builder`, and `/sf-apply-ste`.

The agent does these steps:

1. It runs the readiness check.
2. It asks you before it builds a missing part. The parts are the agent setup, the spec, and the plan.
3. It asks you to approve the spec, the plan, and each milestone. The system records your answers in `.sf/ledger.jsonl`.
4. It starts the supervisor and tells you the progress.
5. It asks you only for decisions. A decision is, for example, a blocked task, an approval, or a recovery choice.

> **NOTE:** The agent runs the scripts. You do not type them. The syntax of a slash command depends on your agent. Some agents use `/name`. Some use a mention or automatic selection. These skills cannot change this.

For CI or a remote supervisor, the orchestrator script has the same operations as subcommands. See the section Commands in the HTML page. Normal use does not need them.

To get updates in Telegram, add this channel to `notify.channels`. Set both environment variables first.

```yaml
- {type: webhook, preset: telegram, url: "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage", chat_id: "${TELEGRAM_CHAT_ID}"}
```

Updates go in one direction only. You approve in the agent chat or in the terminal.

## Examples

The prompts below are examples. Use your own words. The syntax of the slash command depends on your agent.

### `/sf-agent-setup` — choose which agent does which job

```
/sf-agent-setup Claude implements, Codex reviews, Pi is a second implementer. Update me on Telegram every 5 minutes.
/sf-agent-setup add OpenCode as another reviewer
/sf-agent-setup check that all my agents still respond
```

The agent probes each agent command and reads its `--help` output. It asks you before it enables an auto-approve flag. It validates `.sf/factory.yaml`. It sends a test prompt to each agent. **Result:** a verified map of agents and roles.

### `/sf-spec-builder` — decide what to build

```
/sf-spec-builder I need a CLI that converts CSV to JSON and handles files larger than memory
/sf-spec-builder build the spec from docs/PRD.md
/sf-spec-builder add a requirement: the API must rate-limit to 100 requests per minute
```

The agent interviews you, reads a document, or reads a YAML answers file. An unknown fact becomes an open question. The agent does not guess. **Result:** `.sf/spec.md` with numbered requirements and measurable acceptance criteria. You approve it.

### `/sf-plan-builder` — decide how to build it

```
/sf-plan-builder plan the approved spec
/sf-plan-builder two milestones: API first, UI second; at most 3 tasks in parallel
/sf-plan-builder add a database-migration task to milestone 1
```

**Result:** `.sf/plan.yaml`. It has milestones and tasks. Tasks that run in parallel never write the same files. Each task has real verify commands. Each requirement links to a task. You approve it.

### `/sf-apply-ste` — write clear specs and design documents

```
/sf-apply-ste make the spec clearer, use simplified technical English
/sf-apply-ste apply STE to docs/design
/sf-apply-ste check my spec against the word list that I downloaded
```

The agent runs a style check. A script fixes the simple problems, for example contractions. The agent rewrites the other sentences. 

The agent does not change requirement IDs, numbers, or code. If you already approved the spec, the agent asks you first. The spec then returns to draft and you approve it again. **Result:** clearer documents and a list of plan criteria to update. The check approximates ASD-STE100. It is not the official checker.

### `/sf-orchestrator` — deliver the work

```
/sf-orchestrator build a REST API for a todo list in Go with PostgreSQL
/sf-orchestrator implement the approved plan
/sf-orchestrator what happened to my last run?          # assess a crashed or stopped run
/sf-orchestrator resume                                 # after you see the assessment
/sf-orchestrator task T-004 is blocked — retry it with a different agent
/sf-orchestrator export the audit trail for review
```

**Result:** merged and verified work on milestone branches. An independent agent reviews each task. You get a status update every 5 minutes and a final evidence report.

### A complete conversation (short, illustrative)

```
You:    /sf-orchestrator build a REST API for a todo list in Go with PostgreSQL
Agent:  Nothing is set up. Can I set up your agents first?  [yes / I supply a factory.yaml / stop]
You:    yes — Claude implements, Codex reviews
Agent:  Both agents answered a test prompt. There is no spec. Can I build one with you?
You:    yes
Agent:  (interviews you and writes 6 requirements with acceptance criteria) Do you approve this spec?
You:    approved
Agent:  The spec is approved. There is no plan. Can I draft one?  ...  The plan has 2 milestones, 7 tasks, and 3 parallel layers. Do you approve?
You:    approved
Agent:  I start now. I send you updates. The supervisor also sends a message every 5 minutes.
        ... T-003 needed one rework because a test failed. Then it passed the independent review ...
Agent:  Milestone M1 passed its gate. 3 tasks are merged into milestone/m1. Do you approve the milestone?
You:    approved
```

## Layout

```
sf-shared/lib/     source of the shared Node library (yaml, schemas, runner, git, state, spec, plan, notify)
sf-*/              the skills: SKILL.md, scripts/ (with a copy of the library in scripts/lib), templates/, references/
scripts/           sync-shared.mjs (copies the library into the skills), install.mjs, agent-registry.yaml
tests/             node:test suites, including an end-to-end run with a fake agent
docs/              orchestrator-workflow.html (the workflow as diagrams, generated by `npm run docs`)
```

To change the code, edit `sf-shared/lib`. Then run `npm run sync`. After you change states, commands, or the agent registry, run `npm run docs`. Then run `npm test`. The test run does the sync first. It has 48 tests and takes about 35 seconds.

## Status and limits

- A fake agent tests the complete flow on macOS. The tests cover parallel tasks, rework, path violations, approvals, crash and orphan recovery, reset, restore, prune, replay, export, local merge, and the detached supervisor.
- The command `doctor` verified the real agents `pi` and `cline`. This includes the capture of session artifacts and session IDs.
- **CAUTION:** Agent flags differ between tools and versions. Run `doctor` for each agent profile.
- The code has Windows support for paths, `.cmd` files, and process fingerprints. Nobody tested it.
- The system runs on one machine with one supervisor. It stores state in files. It is not a multi-user service.
- The flags of each agent limit what the agent can read and run. The supervisor adds git isolation, path checks, and detection of reviewer changes. It is not an operating system sandbox.
