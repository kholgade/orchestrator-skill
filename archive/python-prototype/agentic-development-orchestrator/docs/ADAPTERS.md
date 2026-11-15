# Agent adapter contract

The core scripts deliberately do not invoke arbitrary agent commands. An adapter is an explicitly trusted integration owned by the deployment.

## Required adapter responsibilities

An adapter should accept a task envelope containing:
- `run_id`, `task_id`, `attempt`
- `agent_id`, `role`, `model/provider`
- `working_directory`
- `brief_path`
- `allowed_paths`
- `timeout_seconds`
- `correlation_id`

It should return:
- `status`: `SUCCEEDED`, `FAILED`, `TIMED_OUT`, or `CANCELLED`
- `exit_code` (when applicable)
- `started_at`, `finished_at`
- `changed_files`
- `artifact_paths`
- `stdout_path`, `stderr_path`
- `commit_sha` (if applicable)
- `completion_summary`

Review adapters must additionally return a structured review result and must be independent from the implementer.

## Security requirements

- Validate agent IDs and command allowlists.
- Do not concatenate untrusted text into shell commands.
- Prefer argument arrays over shell strings.
- Use a controlled working directory and environment.
- Redact secrets from logs.
- Enforce timeouts and process-tree cancellation.
- Record adapter version and model/provider.
- Treat agent output as untrusted data.
- Do not permit reviewers to modify the implementation worktree.

## Idempotency

Use `run_id + task_id + attempt + agent_id` as a dispatch idempotency key. Before retrying a dispatch after interruption, inspect adapter execution records to determine whether it is still running or already completed.
