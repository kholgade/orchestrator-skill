# Independent Review Brief: {{task_id}}

You are the independent reviewer. Do not implement or modify feature code.

## Inputs
- Source requirements: {{source_references}}
- Task brief: {{task_brief_path}}
- Project instructions: {{project_instructions}}
- Diff: {{diff_reference}}
- Test commands: {{verification_commands}}

## Review
1. Verify every acceptance criterion against source and implementation.
2. Inspect the complete diff, including unintended changes.
3. Run required checks where permitted; distinguish NOT_RUN from PASS.
4. Check project governance, architecture, security, and scope.
5. Record evidence and precise locations for findings.
6. Return PASS only when all mandatory criteria pass and no blocking findings remain.

Return JSON matching `schemas/review-result.schema.json`.
Do not edit implementation files.
