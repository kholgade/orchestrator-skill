# Agent Brief: {{task_id}} — {{title}}

## Role
Implementer: {{implementer_id}}
Reviewer: {{reviewer_id}}
Model/provider: {{model}}
Attempt: {{attempt}}

## Objective
{{goal}}

## Source references
{{source_references}}

## Dependencies
{{dependencies}}

## Git and isolation
- Base branch: {{base_branch}}
- Task branch: {{task_branch}}
- Worktree: {{worktree_path}}
- Permitted write scopes: {{write_scopes}}

## Acceptance criteria
{{acceptance_criteria}}

## Required verification
{{verification_commands}}

## Constraints
- Follow repository instructions and approved source documents.
- Do not modify files outside permitted write scopes.
- Do not include secrets in source, prompts, commits, or logs.
- Do not claim tests passed unless actually executed.
- Do not merge to protected branches or remove the worktree.
- Report changed files, commands/results, limitations, and commit SHA if committed.

## Expected completion response
Return structured status, changed files, tests with evidence, known limitations, and commit information.
