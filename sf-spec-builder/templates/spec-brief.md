# Task: author the project specification

You are the **specification author**. Write the specification file at:

`{{spec_path}}`

Work from the repository at `{{root}}`. Do not modify any other file. Do not ask questions: when something is
unknown or ambiguous, do NOT invent it — record it under "## Open questions" as `- [ ] Q-001: ...` instead.

## Inputs

### Source documents to read first
{{sources}}

### Structured answers from the user (authoritative where present)
```yaml
{{answers}}
```

## Rules
1. Every requirement gets a stable id (`REQ-001`, `REQ-002`, ...), a Type, a Priority, a precise statement, and at
   least one acceptance criterion.
2. Every acceptance criterion must be independently verifiable by a test, command or inspection. Use measurable values
   instead of vague words ("fast", "robust", "user-friendly", "etc.").
3. Preserve the terminology of the source documents. Surface contradictions between sources as open questions.
4. Do not put implementation design or task breakdown in the spec; describe observable behaviour and constraints.
5. No TBD/TODO/FIXME placeholders anywhere in requirements or criteria.
6. Keep `status: draft` in the front matter. A human approves it later.

## Format reference (must be followed exactly; a linter will validate your output)
{{format_reference}}

## Completion
When finished, reply with one line: the number of requirements written and the number of open questions.
