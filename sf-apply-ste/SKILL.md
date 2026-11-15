---
name: sf-apply-ste
description: Rewrite specs and design documents in Simplified Technical English (ASD-STE100 style) — short, active, unambiguous sentences — with deterministic checks, safe mechanical fixes and a seal step that protects requirement IDs and approved specs. Run when the user asks for STE, simplified or unambiguous technical writing, or clearer specs/design docs. Run before sf-spec-builder approve, or on an approved spec only with the user's consent.
version: 0.0.8
---

# sf-apply-ste

CLI: `node <skill-dir>/scripts/ste.mjs <cmd> [paths…]` (cwd = project root; Node ≥ 20). Rules and coverage: `references/ste-rules.md` (read before rewriting).

| cmd | effect |
|---|---|
| `init` | write `.sf/ste.yaml` (paths, limits, `technical_terms`, optional `dictionary`) |
| `scope` | show resolved files and limits |
| `check [paths] [--json] [--strict] [--dictionary f]` | style findings with line, rule, suggestion; exit 1 on errors |
| `fix [paths] [--write]` | mechanical fixes only (contractions, `e.g.`/`i.e.`, `utilize`, `prior to`, `in order to`); dry run without `--write` |
| `seal [paths] [--force]` | after edits: re-check; for the spec verify format and IDs, set an approved spec to draft, list stale plan criteria, append `.sf/ledger.jsonl` |

Default scope: `paths` in `.sf/ste.yaml`, else `.sf/spec.md`. Design documents: pass their folder or files.

## Honest limits (state them to the user)
- The checker approximates the standard. It is not the official specification and not a certified checker.
- Not checked by script: noun-cluster length (≤3 words), verb tenses, `-ing` forms, one word one meaning. You judge these.
- Vocabulary is checked only if the user gives an approved-word list (`--dictionary`, from the official ASD-STE100 download). Say when it was not checked.

## Procedure
1. `scope`. If `.sf/ste.yaml` is missing and the project has technical terms (product names, tool names), propose `init` and fill `technical_terms`.
2. Target an approved spec? Stop and ask the user: rewriting changes the spec hash. Consequence: spec returns to draft; plan needs re-approval. Continue only after explicit consent (`note --kind decision` via sf-orchestrator, or tell the user the quote you rely on).
3. `check` → read findings. `fix` (dry run), show the summary, `fix --write`.
4. Rewrite the remaining findings by hand:
   - split sentences: ≤25 words descriptive, ≤20 words procedural, one idea each, one instruction per step;
   - active voice, simple present tense; name the actor; use `must` for obligation, `can` for possibility; no `may`/`might`/`could`/`should`;
   - one term per concept across the whole document; keep the user's technical names;
   - replace non-STE words with the suggestion; no ellipses, slang, idioms; articles (`the`, `a`) kept;
   - use `NOTE:`, `CAUTION:`, `WARNING:` for safety or important text.
5. Meaning must not change. Never edit: requirement IDs, numbers, units, thresholds, code, commands, paths, quoted strings, front matter keys. If a simpler sentence loses a condition or a value, keep the original and ask the user.
6. Repeat `check` until errors are 0 (or the user accepts named exceptions). Warnings: fix or justify.
7. `seal`. Exit 0 required. Read every `PROBLEM` and `NOTE`:
   - `PROBLEM` about IDs, criteria count, type or priority → undo the change that caused it; do not seal around it.
   - spec set to draft → show the user a short before/after summary (`git diff --stat`, 3 sample sentences), obtain approval with sf-spec-builder (`approve --confirmed-by user --quote "<words>"`), then run sf-plan-builder `rehash`, update stale plan criteria, and `approve`.
8. Report: files changed, findings fixed, exceptions kept, what was not checked.

## Constraints
- Rewrite only the files in scope. Do not rewrite code files.
- Do not approve a spec or plan for the user.
- Do not claim ASD-STE100 compliance. Say "checked against the approximate STE rules in this tool".

## Examples
- User: "make the spec clearer, use simplified technical English" → `scope`; spec approved? ask consent and explain the draft/re-approval consequence; `check`; `fix --write`; rewrite remaining sentences; `check` to 0 errors; `seal`; show summary; sf-spec-builder `approve` after the user's yes; sf-plan-builder `rehash` and update stale criteria.
- User: "apply STE to docs/design" → `scope docs/design`; `check docs/design`; `fix docs/design --write`; hand rewrite; `seal docs/design` (no spec checks; ledger entry only).
- User: "check my spec against the STE word list I downloaded" → `check --dictionary <path>`; report unlisted words as candidates only (inflection handling is approximate); do not auto-replace.
