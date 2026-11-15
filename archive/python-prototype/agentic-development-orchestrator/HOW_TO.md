# How to use the Agentic Development Orchestrator

## 1. Requirements

- Python 3.10 or newer.
- Git for repository and worktree operations.
- Optional: PyYAML for YAML parsing (`python -m pip install pyyaml`). The bundle does not install dependencies automatically.
- One or more agent runtimes (CLI/API/framework) configured by you. This bundle deliberately does not assume Cursor, Pi, Cline, Codex, Claude Code, LangGraph, CrewAI, or any provider.

## 2. Quick start

```bash
unzip agentic-development-orchestrator.zip
cd agentic-development-orchestrator

# Copy the minimal example and edit it.
cp examples/minimal/config.yaml ./config.yaml

# Validate configuration.
python3 scripts/orchestrator.py validate --config config.yaml

# Generate a deterministic task plan from the configured task list.
python3 scripts/orchestrator.py plan --config config.yaml --out .orchestrator/plan.json

# Initialize persistent execution state.
python3 scripts/orchestrator.py init --config config.yaml

# Inspect state.
python3 scripts/orchestrator.py status --state .orchestrator/state.json
```

The `plan` command validates the task DAG, detects cycles and write-scope collisions, and emits a topologically ordered plan. It does not read arbitrary documents and infer requirements; the LLM orchestrator performs source analysis and populates the configuration/plan inputs.

## 3. Use the skill with an AI orchestrator

Provide the entire bundle as skill context. Ask the orchestrator to:
1. Read `SKILL.md`.
2. Read your project instructions and all configured source documents.
3. Inspect the repository and existing working tree.
4. Fill missing configuration through an adaptive interview.
5. Generate requirement traceability and tasks.
6. Populate `config.yaml` or a project-specific configuration.
7. Run deterministic validation and planning scripts.
8. Present the plan and request configured approvals.
9. Execute through real agent adapters.
10. Persist state and evidence after each meaningful operation.

The LLM is responsible for semantic work: interpreting requirements, resolving ambiguity with the user, producing task briefs, selecting agents based on discovered capability, evaluating review evidence, and making bounded orchestration decisions. Scripts enforce deterministic invariants.

## 4. Configuration

Start with `examples/minimal/config.yaml`. For a project with existing requirements and a milestone plan, see `examples/forge-nets/config.yaml`.

Important fields:
- `project.repository`: absolute or relative repository path.
- `sources.documents`: source paths and declared authority.
- `agents`: agent IDs, roles, adapters and commands.
- `execution.parallelism`: concurrency ceilings.
- `execution.max_rework_rounds`: bounded repair attempts.
- `git.worktrees`: isolation policy.
- `verification`: required checks and independent reviewer policy.
- `approvals`: human-owned decisions.
- `state.path`: persistent state file.

A configured `command` is descriptive metadata for the orchestrator/adapter. The core scripts do not execute it. Agent invocation must be implemented by a trusted adapter and explicitly authorized.

## 5. Task planning format

The configuration's `tasks` list supports:
- `id`: stable unique task ID.
- `milestone`: milestone ID.
- `title`, `goal`.
- `depends_on`: task IDs.
- `write_scopes`: paths the task may modify.
- `requirements`: source requirement IDs.
- `acceptance_criteria`: verifiable outcomes.
- `implementer`, `reviewer`: IDs in the agent registry.
- `verification_commands`: commands to be run by your trusted execution adapter.

Do not give concurrent tasks overlapping write scopes. The planner detects obvious path overlap (including parent/child path relationships).

## 6. State machine

The state machine is documented visually in `docs/state-machine.html`. Open it in a browser. It is self-contained and includes inline SVG.

Task transitions:
- `PLANNED → READY → RUNNING → REVIEW`
- `REVIEW → PASS` or `REVIEW → REWORK`
- `REWORK → RUNNING`
- `PASS → INTEGRATED`
- Any active state may move to `BLOCKED` where allowed.
- `BLOCKED → READY` only after an explicit resolution.

Milestones use a separate state set and must not be marked complete merely because individual tasks passed.

Use `transition` to record an allowed state change. The script appends an event and atomically writes the state file.

## 7. Worktrees

The `worktree` commands are guarded wrappers around Git:
```bash
python3 scripts/orchestrator.py worktree-add \
  --repo /path/to/repo --branch task/TASK-001 \
  --base milestone/example --path /path/to/repo/.worktrees/TASK-001

python3 scripts/orchestrator.py worktree-list --repo /path/to/repo

python3 scripts/orchestrator.py worktree-remove \
  --repo /path/to/repo --path /path/to/repo/.worktrees/TASK-001
```

Removal refuses a dirty worktree unless `--force-dirty` is explicitly supplied. Avoid that option except after inspecting and preserving all changes. Worktree creation refuses to overwrite an existing path.

The scripts do not automatically merge branches. Review, integration, and merge policy must be handled by the orchestrator and trusted Git adapter, with approval where configured.

## 8. Resume after interruption

```bash
python3 scripts/orchestrator.py status --state .orchestrator/state.json
python3 scripts/orchestrator.py report --state .orchestrator/state.json --out .orchestrator/report.md
```

Before resuming, inspect Git branches/worktrees and reconcile actual repository state against the event log. The state file is not proof that a Git operation succeeded.

## 9. Tests

```bash
python3 -m unittest discover -s tests -v
```

The tests use temporary directories and do not modify your project repository.

## 10. Production hardening before team-wide use

This is a portable starter skill bundle, not a complete multi-user orchestration service. Before using it for a large team:
- Implement authenticated agent adapters and least-privilege credentials.
- Add process supervision, cancellation, heartbeats and leases.
- Use a transactional database for concurrent state updates.
- Add artifact storage and log redaction.
- Add policy enforcement for shell, network and filesystem operations.
- Add idempotency keys for dispatch and integration operations.
- Add distributed scheduling and resource accounting.
- Add signed provenance for review/evaluation artifacts.
- Add observability, audit retention and alerting.
