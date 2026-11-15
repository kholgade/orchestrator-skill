---
name: sf-spec-builder
description: Produce an approved, lint-clean specification (.sf/spec.md with REQ ids and verifiable acceptance criteria plus .sf/spec.index.json) by user interview, structured answers YAML, or delegation to the configured spec-author agent. Run when no approved spec exists or the user defines/changes what to build. Required by sf-plan-builder and sf-orchestrator.
version: 0.0.6
---

# sf-spec-builder

CLI: `node <skill-dir>/scripts/spec.mjs <cmd>` (cwd = project root; Node ≥ 20). Format: `references/spec-format.md` (read before writing).

| cmd | effect |
|---|---|
| `init [--title T] [--force]` | scaffold draft `.sf/spec.md` |
| `from-answers <file> [--force]` | generate spec.md from answers YAML, then lint |
| `lint [--json]` | exit≠0 on errors; warnings printed |
| `index` | lint, write `.sf/spec.index.json` |
| `approve` + confirmation flags | requires clean lint + zero unresolved open questions; sets `status: approved`; writes index; appends `.sf/ledger.jsonl` |
| `status [--json]` | state summary |
| `brief --out f [--answers f] [--sources a,b]` | render authoring brief |
| `delegate [--answers f] [--sources a,b] [--rounds n]` | run `roles.spec_author` agent, lint, feed findings back (≤ rounds) |

Answers YAML keys: `title, goal, overview, sources[], scope{in[],out[]}, assumptions[], glossary[{term,definition}], requirements[{id?,title,type,priority,statement,criteria[],source?,depends[]?}], open_questions[{id?,text,resolved?}]`.

Confirmation flags: terminal use prompts and records `user`. Non-interactive: ask the user first, then `--confirmed-by user --quote "<their words>" [--via <you>]` (remote supervisor: `--confirmed-by external:<id>`). Never pass without the user's yes.

## Resume check (run first)
`status --json`. If `drafts` is non-empty or `exists: true` with `status: draft`: show the user what exists and ask **continue** or **start over**. Start over = move the draft/spec to `.sf/drafts/archive-<timestamp>/` (do not delete). During an interview, persist answers incrementally to `.sf/drafts/spec.answers.yaml` (answers YAML schema above) so a crashed session can continue; `from-answers` with no file reads it.

## Mode selection
- User supplied answers YAML → `from-answers`.
- User supplied finished spec.md → place at `.sf/spec.md`, `lint`.
- `roles.spec_author` ≠ `session` and user wants delegation → gather inputs, `delegate`, then review output with the user. If no `.sf/factory.yaml`: invoke `sf-agent-setup` first.
- Otherwise interview.

## Interview procedure
1. Discover: `status`; read README/docs/rule files/stack. Do not ask what the repo answers.
2. Ask one topic per message with a proposal to accept or amend, in order: purpose+users → scope in/out → functional behaviour → non-functional targets (numbers) → constraints+integrations → data → priorities → glossary/assumptions.
3. Draft requirements; show compact list; apply corrections. Keep the user's terminology. Report contradictions.
4. Unknowns → `- [ ] Q-NNN: …` open questions. Do not invent requirements.
5. Write file; `lint`; fix all errors; resolve warnings (vague wording → measurable value).

## Requirement rules
- One behaviour per requirement; "shall" statement; no design or task breakdown.
- ≥1 acceptance criterion each, verifiable by command/test/inspection, measurable.
- Ids `REQ-NNN` stable; never renumber after a plan exists. Criteria ids positional (`REQ-001.2`); do not reorder after planning.

## Finish
1. `lint` exit 0; open questions all `[x]` with decision text.
2. Show final requirement list; obtain explicit user confirmation.
3. `approve --confirmed-by user --quote "<their words>"`. Never approve without that confirmation.
4. Next: `sf-plan-builder` (or return to invoking skill). Spec edits after plan approval cause plan drift: plan needs `rehash` + re-approval.
