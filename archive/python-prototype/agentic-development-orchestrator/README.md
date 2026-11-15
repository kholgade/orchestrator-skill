# Agentic Development Orchestrator — Skill Bundle

A reusable, source-driven orchestration skill for coordinating internal/external agents, parallel subagents, isolated Git worktrees, independent verification, bounded rework, milestone gates, and evidence-based delivery.

## Contents

- `SKILL.md` — core orchestration instructions.
- `HOW_TO.md` — setup and operating guide.
- `config.example.yaml` — configurable project template.
- `scripts/orchestrator.py` — deterministic CLI for validation, DAG planning, state transitions, reports, and guarded worktree operations.
- `docs/state-machine.html` — self-contained HTML/SVG state machine.
- `docs/ADAPTERS.md` — agent adapter contract.
- `templates/` — task, review, and delivery templates.
- `schemas/` — structured review result schema.
- `examples/` — minimal project and ForgeNts adaptation.
- `tests/` — standard-library unit tests.

## Safety boundary

This bundle does not autonomously invoke arbitrary agents or run arbitrary verification commands. Those require trusted, explicitly configured adapters. The scripts provide deterministic control-plane operations and guarded Git worktree helpers.
See `HOW_TO.md` for details.
