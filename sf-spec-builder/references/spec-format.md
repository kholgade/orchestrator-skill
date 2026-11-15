## Spec file format (`spec/1`)

A spec is one Markdown file (default `.sf/spec.md`): YAML front matter, then sections. A linter
(`node sf-spec-builder/scripts/spec.mjs lint`) enforces everything below.

### Front matter (required)
```yaml
---
sf: spec/1
title: "Project name"
status: draft          # draft | approved  (only `spec.mjs approve` should set approved)
version: 1             # integer, bump on material change
sources: [docs/brief.md]   # optional
---
```

### Sections
`## Overview`, `## Scope`, `## Assumptions`, `## Glossary` are free-form. Two sections are structured:

#### `## Requirements` (required)
Each requirement is a level-3 heading `### REQ-<ID>: <Title>` (id matches `REQ-[A-Z0-9]+(-[A-Z0-9]+)*`, e.g.
`REQ-001` or `REQ-AUTH-002`), followed by metadata bullets, the statement, and the criteria:

```markdown
### REQ-001: Health endpoint
- Type: functional        # functional | nfr | constraint | interface | data | security
- Priority: must          # must | should | could
- Source: docs/brief.md#health   # optional
- Depends: REQ-000        # optional, other requirement ids

The service shall expose an HTTP health endpoint.

**Acceptance criteria**
- GET /health returns HTTP 200 and JSON {"status":"ok"} within 200 ms on the reference machine.
- GET /health returns HTTP 503 when the database is unreachable.
```

Rules enforced by the linter:
- ids unique; Type and Priority present and valid; statement non-empty
- at least one acceptance criterion per requirement, written as bullets after the `**Acceptance criteria**` line
- no `TBD`, `TODO`, `FIXME` or `???` in statements/criteria
- `Depends` must reference existing requirements
- warnings for vague words (fast, robust, intuitive, scalable, etc.) with no number, very short criteria, duplicates

Criterion ids are positional: `REQ-001.1`, `REQ-001.2`, ... Do not reorder criteria after a plan exists without
re-planning.

#### `## Open questions`
```markdown
- [ ] Q-001: Should deleted records be recoverable?
- [x] Q-002: Which database? — PostgreSQL 16 (decided by the owner)
```
A spec cannot be approved while any question is unchecked.

### Approval and the index
`spec.mjs approve` sets `status: approved`, then writes `.sf/spec.index.json` containing every requirement, its
criteria and a content hash. The plan records that hash; the orchestrator refuses to run if the spec changed
afterwards (spec drift).
