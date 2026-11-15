# ForgeNts — Implementation Plan

Personal software factory (Telegram ChatOps → GitHub Issues → Opus/Spec planning → Pi/Cline build → Cursor-subagent review → human merge).

**Authority:** [`AGENTS.md`](../AGENTS.md) is binding for every agent. This plan + [`META_PROMPT.md`](META_PROMPT.md) **must** be read together with it. On conflict, `AGENTS.md` wins.

## Repo layout (required)

All project content lives under these numbered folders. Do not invent other top-level content folders.

| Folder | Purpose |
|--------|---------|
| `01-specs/` | Specifications only: product/system/feature specs, this plan, meta prompt, task brief template, schemas |
| `02-design/` | Design only: architecture, ADRs, component/sequence diagrams, interface designs, threat model |
| `03-code/` | Implementation only: packages, apps, CLIs, agent scripts |
| `04-tests/` | Tests and evals only: unit, integration, smoke, e2e |
| `05-maintain/` | Post-deployment ops: runbooks, deploy/rollback, monitoring, secrets rotation notes (no secrets) |
| `06-user-doc/` | End-user documentation: how to submit ideas, ChatOps commands, approve merges |

Root may hold only: `AGENTS.md`, `README.md`, `.gitignore`, and tooling config named by a milestone.

`.worktrees/` stays gitignored at repo root for Pi/Cline task worktrees.

## Hard gate: Spec → Design → Implementation

**No implementation code under `03-code/` (except agent worktree helper scripts already named by this plan) and no tests under `04-tests/` until both of these have merged to `main`:**

1. **MS — Specification** milestone PASSed (Cursor subagent) and merged
2. **MD — Design** milestone PASSed (Cursor subagent) and merged

Order is fixed: **MS → MD → MI0…** Design must cite and satisfy the approved specs. Implementation must cite and satisfy the approved design. Skipping or parallelizing MS/MD with coding milestones is forbidden.

---

**Execution model (non-negotiable):**

| Role | Who | Responsibility |
|------|-----|----------------|
| Orchestrator | Parent Cursor agent | Milestone plan, spawn parallel work, gate merges |
| Implementer | Pi and/or Cline (Ollama cloud models) | Write artifacts per task brief (specs, design, then code/tests) |
| Reviewer | Cursor subagent(s) | Verify acceptance criteria, evals, leave comments or approve |
| Approver | You (human) | Idea promote, merge PRs, secrets, Telegram allowlist |

**Loop:** Orchestrator writes task brief → Pi/Cline works in a worktree → Cursor subagent reviews → if FAIL, rework in the same worktree until PASS → integrate onto milestone branch → **delete worktree** → next task. After all milestone tasks + milestone evals PASS (Cursor subagent), merge milestone branch → `main`.

**Parallelism:** Only after MS and MD are on `main`. Independent modules may then run on separate Pi/Cline worktrees under `.worktrees/`. No parallel edits to the same files without a merge owner.

---

## Git, branches, and worktrees (required)

### Milestone branches

| Rule | Detail |
|------|--------|
| One branch per milestone/phase | Name: `milestone/ms-specs`, `milestone/md-design`, `milestone/mi0-scaffold`, … |
| Cut from | Current `main` at milestone start |
| Land on `main` | **Only after** Cursor subagent PASSes (1) all task reviews on that branch and (2) the milestone eval checklist |
| Merge style | Open PR `milestone/…` → `main`; merge when reviewer PASSes |
| No direct commits to `main` | Implementers never push to `main` |

### Task worktrees (within a milestone)

| Rule | Detail |
|------|--------|
| Location | Always `<workspace>/.worktrees/<milestone-id>/<task-id>/` |
| Create | From the **milestone branch** via `03-code/scripts/agent/worktree-add.sh` |
| Implementer cwd | Pi/Cline **must** run with cwd = that worktree path |
| Parallel tasks | Separate worktree + task branch each; non-overlapping paths |
| On task PASS | Fold into milestone branch → push → **delete** worktree via `03-code/scripts/agent/worktree-remove.sh` |
| `.worktrees/` | Gitignored; never commit worktree contents |

### Lifecycle diagram

```
main
  └─ milestone/…            ← cut at phase start
        ├─ worktree task A  ← Pi/Cline → review → PASS → fold → DELETE worktree
        ├─ worktree task B  ← parallel, same rules
        └─ milestone evals + Cursor subagent PASS
              └─ PR → merge into main
```

---

## Product north star (v1)

Telegram text/voice → confirm idea → GitHub Issue(s) → factory job → Spec/plan artifact → Pi/Cline PR → automated + Cursor review → Telegram status → **you** approve merge.

Stack default (from research):

- Front door: Telegram bot
- Glue: n8n (or thin Node bot if n8n deferred in-repo)
- System of record: GitHub Issues/Projects
- Planning: Spec Kit prompts + strong model (Opus when available; Ollama cloud for implementers)
- Build: Pi + Cline
- Review: Cursor subagents (+ optional `ocr` / PR-Agent later)
- Merge: human only

---

## Milestone map

### MS — Specification building (blocker; before design and code)

**Branch:** `milestone/ms-specs`

**Goal:** Fully specify the v1 factory so design and code have unambiguous acceptance criteria. Outputs land only in `01-specs/`.

**Deliverables**

- `01-specs/PRODUCT.md` — problem, users, north star, non-goals, success metrics
- `01-specs/SYSTEM.md` — system context, actors, boundaries, data stores, external services
- `01-specs/FEATURES/` — one file per capability:
  - `telegram-intake.md` (text + voice confirm)
  - `github-system-of-record.md` (labels, transitions, issues)
  - `promote-and-plan.md`
  - `worker-dispatch.md` (Pi/Cline)
  - `review-loop.md` (Cursor subagent)
  - `status-and-merge.md` (human gate)
- `01-specs/DATA_MODEL.md` — `Idea`, `FactoryTask`, `AgentBrief`, `ReviewResult`, `JobStatus` fields and invariants
- `01-specs/ACCEPTANCE.md` — v1 definition of done as testable checklist
- `01-specs/NFR.md` — security (allowlist, secrets), reliability, concurrency limits, VPS/Mac constraints
- Keep `01-specs/IMPLEMENTATION_PLAN.md`, `META_PROMPT.md`, `TASK_BRIEF_TEMPLATE.md` aligned with this layout

**Evals**

- [ ] Every feature spec has: problem, actors, inputs/outputs, acceptance criteria, non-goals, failure modes
- [ ] `DATA_MODEL.md` covers every type named in feature specs
- [ ] `ACCEPTANCE.md` maps 1:1 to feature AC with no orphan items
- [ ] No design diagrams and no `03-code/` feature implementation in this milestone

**Review gate**

- Cursor subagent: specs are complete and testable; no implementation sneaking in; `AGENTS.md` held; human can understand promote/merge gates.

---

### MD — Design creation (blocker; after MS; before code)

**Branch:** `milestone/md-design`

**Goal:** Turn approved specs into an executable design. Outputs land only in `02-design/`. Must reference `01-specs/` documents by path.

**Deliverables**

- `02-design/ARCHITECTURE.md` — components, trust boundaries, deploy topology (Mac + VPS)
- `02-design/ADR/` — ADR-001 stack, ADR-002 Telegram ChatOps, ADR-003 agent roles (implementer vs reviewer)
- `02-design/INTERFACES.md` — CLI/API/Telegram command surfaces, GitHub label state machine
- `02-design/SEQUENCES.md` — sequences for: idea confirm, promote, dispatch, review rework, human merge
- `02-design/MODULE_MAP.md` — maps each feature to paths under `03-code/`, `04-tests/`, `05-maintain/`, `06-user-doc/`
- `02-design/THREAT_NOTES.md` — allowlist, token handling, no auto-merge, secret non-commit

**Evals**

- [ ] Every MS feature has a design section or sequence covering it
- [ ] `MODULE_MAP.md` names concrete target paths under the six folders
- [ ] State machine in `INTERFACES.md` matches `01-specs/FEATURES/github-system-of-record.md`
- [ ] No production feature code under `03-code/` in this milestone (agent helper scripts already on `main` may remain)

**Review gate**

- Cursor subagent: design satisfies MS specs; no skipped threats; module map is implementable; `AGENTS.md` held.

---

### MI0 — Scaffolding (after MD on `main`)

**Branch:** `milestone/mi0-scaffold`

**Goal:** Repo packaging, shared contracts, eval harness, remaining agent wrappers — matching `02-design/MODULE_MAP.md`.

**Deliverables**

- `03-code/packages/contracts/` — TypeScript types from `01-specs/DATA_MODEL.md`
- `03-code/scripts/agent/` — `run-pi.sh`, `run-cline.sh`, `worktree-add.sh`, `worktree-remove.sh`, `review-gate.md`
- `04-tests/smoke/` — runnable smoke evals against real contracts/CLI (no mocks)
- `.env.example` at root for Telegram + Ollama (no secrets)
- Briefs for later tasks may live under `01-specs/briefs/` only if a milestone lists them

**Evals**

- [ ] Contracts typecheck / build
- [ ] Sample `AgentBrief` JSON validates against schema under `01-specs/` or `03-code/packages/contracts`
- [ ] Smoke runner exits 0 on real hello fixture under `04-tests/smoke/`

**Review gate**

- Contracts match DATA_MODEL; paths match MODULE_MAP; no mocks/stubs; zero code comments; `AGENTS.md` held.

---

### MI1 — GitHub system of record client

**Branch:** `milestone/mi1-github-bridge`

**Deliverables**

- `03-code/packages/github-bridge/` — thin client over `gh` / Octokit per design
- Labels: `factory:idea`, `factory:ready`, `factory:planning`, `factory:building`, `factory:review`, `factory:awaiting-merge`, `factory:done`, `factory:blocked`
- CLI under `03-code/`: ensure-issue | transition | comment
- Tests under `04-tests/` for transition rules and dry-run behavior (real dry-run mode, no mock frameworks)

**Evals**

- [ ] Dry-run mode creates no resources but prints intended API calls
- [ ] Opt-in live test `FACTORY_GH_LIVE=1` creates + labels + closes a throwaway issue
- [ ] State machine rejects illegal transitions

**Review gate**

- Transition table, idempotency, error handling, no token logging.

---

### MI2 — Telegram intake (text + voice)

**Branch:** `milestone/mi2-telegram-intake`

**Deliverables**

- Bot under `03-code/` (grammY **or** n8n export under `05-maintain/n8n/telegram-intake.json` plus thin runner)
- Voice: OGG → Whisper → same confirm UX as text
- On confirm: create `factory:idea` issue
- Tests under `04-tests/` for allowlist and Idea shape normalization
- User-facing ChatOps notes under `06-user-doc/telegram.md`

**Evals**

- [ ] Allowlist rejects unknown user IDs
- [ ] Voice/text normalize to same `Idea` shape
- [ ] Confirm path creates exactly one GitHub issue in live/opt-in or dry-run record mode
- [ ] No auto-promote without explicit confirm

**Review gate**

- Token handling, allowlist, voice never skips confirm.

---

### MI3 — Promote + planning job

**Branch:** `milestone/mi3-promote-planning`

**Deliverables**

- Promote flow → child tasks + plan artifact under `01-specs/generated/<id>.md` (or path named in MODULE_MAP)
- Planner step (Opus path documented in `05-maintain/`; Ollama cloud fallback for automation)
- Tasks labeled `factory:ready`

**Evals**

- [ ] Promote without plan fails closed
- [ ] Spec artifact contains: problem, constraints, acceptance criteria, non-goals, test plan
- [ ] Replay promote is idempotent

**Review gate**

- AC testable; human can reject via Telegram.

---

### MI4 — Worker dispatch (Pi + Cline)

**Branch:** `milestone/mi4-worker-dispatch`

**Deliverables**

- Dispatcher in `03-code/`: claim → worktree → `run-pi.sh` / `run-cline.sh` with brief
- Brief includes repo path, branch, AC, scope, Ollama-only model profile
- On attempt complete: open/update PR, label `factory:review`, Telegram notify

**Evals**

- [ ] Dry-run dispatcher builds correct argv for Pi and Cline
- [ ] Concurrent claims cannot double-assign same issue
- [ ] Fixture brief produces PR body with AC checklist via real dispatcher dry-run

**Review gate**

- No merge rights for agent tokens; logs redacted.

---

### MI5 — Cursor-subagent review loop

**Branch:** `milestone/mi5-review-loop`

**Deliverables**

- Review protocol under `01-specs/REVIEW_PROTOCOL.md` (schema only; listed here so allowed)
- Orchestrator wiring per META_PROMPT
- FAIL → comments + `factory:building`; PASS → `factory:awaiting-merge` + Telegram approve

**Evals**

- [ ] FAIL path re-invokes implementer with comment pack
- [ ] PASS path never merges without human signal
- [ ] Max rounds configurable (default 3) then `factory:blocked`

**Review gate**

- Protocol cannot be skipped; human merge still required.

---

### MI6 — Status ChatOps + human merge

**Branch:** `milestone/mi6-status-merge`

**Deliverables**

- Status digest + Approve merge / Request changes
- Merge only after review PASS + CI green + Telegram confirm
- Post-merge: close issues, `factory:done`
- Ops notes in `05-maintain/merge-gate.md`; user steps in `06-user-doc/merge.md`

**Evals**

- [ ] Merge without PASS/CI rejected
- [ ] Allowlist enforced on merge
- [ ] Status matches GitHub for a real fixture project when live flag set

**Review gate**

- Security pass on merge path.

---

### MI7 — Hardening, maintain, user doc

**Branch:** `milestone/mi7-hardening`

**Deliverables**

- `04-tests/e2e/` — idea→PR→review→awaiting-merge dry-run (real local pipeline, no mock libraries)
- `05-maintain/RUNBOOK.md` — Mac + VPS, secrets, Ollama cloud, Telegram bot, rollback
- `06-user-doc/README.md` — end-user guide for the factory
- Optional secondary review signal (`ocr`) documented in `05-maintain/` only

**Evals**

- [ ] Full e2e dry-run green
- [ ] Agent failure → blocked + Telegram alert
- [ ] New machine can follow `05-maintain/RUNBOOK.md` to smoke test

**Review gate**

- Architecture vs this plan; follow-ups as issues.

---

## Parallel threading matrix

| After | Can parallelize |
|-------|-----------------|
| MS merged | MD only (no coding milestones) |
| MD merged | MI0 |
| MI0 done | MI1 ∥ MI2 ∥ smoke expansion |
| MI1+MI2 done | MI3 alone |
| MI3 done | MI4 ∥ MI5 protocol prep |
| MI4+MI5 | MI6 read-only status parts ∥ remaining review wiring |
| MI5+MI6 | MI7 |

**Rules**

1. MS then MD then implementation — never skip.
2. One milestone branch per phase; one worktree per in-flight task under `.worktrees/`.
3. Pi and Cline never write the same paths concurrently.
4. Spec or design changes that affect contracts freeze dependents until re-reviewed and merged.
5. Prefer 2 parallel implementer worktrees max on a laptop.
6. After task PASS: fold into milestone branch, then **delete** the worktree.
7. After milestone Cursor-subagent PASS: merge milestone branch → `main`.

---

## Per-task workflow (implementer ↔ reviewer)

```
[Orchestrator] ensure milestone branch exists (from main)
       │
       ├─ create .worktrees/<mX>/<task-id>/ + task branch
       ├─ write AgentBrief (cwd = that worktree)
       ├─ Pi|Cline implements inside worktree
       ▼
[Reviewer subagent] AC + task evals on worktree diff
       │
       ├─ FAIL → comments + re-brief → same worktree → re-review (max N)
       │
       └─ PASS → merge task branch → milestone branch
                 → delete .worktrees/<mX>/<task-id>/
                 → next task (or milestone evals if none left)
                        │
                        ▼
              [Reviewer] milestone eval checklist PASS
                        → PR milestone/* → main → merge
```

**AgentBrief must include:** milestone branch, worktree path, goal, AC, out-of-scope, files likely touched (under the six folders), commands to run, model=`ollama-cloud`, reviewer expectations, obey `AGENTS.md`.

**ReviewResult must include:** `status`, `summary`, `comments[]`, `evals_run[]`, `follow_up_brief?`, `agents_md_ok` (false ⇒ FAIL), plus for MS/MD: `spec_design_gate_ok` when relevant.

Any `AGENTS.md` violation is a **blocking** FAIL regardless of other AC.

---

## Definition of done (v1 product)

- [ ] MS + MD merged before feature code
- [ ] Text + voice idea → confirmed → GitHub issue
- [ ] Promote → plan + tasks
- [ ] Dispatcher runs Pi or Cline → PR
- [ ] Cursor subagent review loop with rework
- [ ] Telegram status + human merge gate
- [ ] Maintain runbook + user doc present
- [ ] Milestone evals documented and runnable under `04-tests/`

---

## Out of scope for v1

- Plane/Kaneo as required UI (API later OK)
- MetaGPT / OpenHands as orchestrator
- Auto-merge without human
- Local GPU model hosting requirement (Ollama cloud is enough)
