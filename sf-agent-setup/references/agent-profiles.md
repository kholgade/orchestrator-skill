# Agent profiles

A profile tells the generic runner how to execute one agent CLI headlessly. The runner never uses a shell: it
builds an argv array, so quoting problems and injection through prompt text are not possible.

```yaml
- id: my-agent                     # stable id used by roles and plans
  command: my-cli                  # resolved on PATH (Windows PATHEXT aware)
  args:                            # argv after the command; placeholders below
    - "--non-interactive"
    - "{{prompt_pointer}}"
    - {if: model, args: ["--model", "{{model}}"]}     # only when `model` is set
  input: none                      # none | stdin (also pipe the full brief on stdin)
  model: some-model                # optional
  provider: some-vendor            # optional; for review_independence: provider
  env: {SOME_FLAG: "1"}            # extra env; values may use ${HOST_ENV_VAR}
  env_inherit: true                # false = pass only PATH/HOME/TEMP-type variables (+ env)
  capabilities: [coding, review]
  artifacts: []                    # files/dirs recorded after every run (path + size + sha256), placeholders allowed
  session_id_regex: ""              # optional; ONE capture group; matched against stdout/stderr to log the agent's session id
  resume_args: []                  # optional; appended on re-dispatch after an interruption when a session id was captured ({{session_id}})
  max_concurrency: 1
  timeout_minutes: 60
  success_exit_codes: [0]
  enabled: true
```

## Placeholders
`{{prompt_pointer}}` (recommended) — "Read the file at <brief path> and carry out the instructions": no argv size
limits, works for any prompt length. `{{prompt}}` — the whole brief inline (may hit OS argument limits).
`{{prompt_file}}` — absolute path of the brief. Also `{{model}} {{cwd}} {{root}} {{role}} {{task_id}} {{attempt}}
{{run_dir}} {{result_file}} {{agent_id}}`.

Every run also exports `SF_AGENT_ID SF_ROLE SF_TASK_ID SF_ATTEMPT SF_BRIEF_FILE SF_RESULT_FILE SF_RUN_DIR SF_ROOT`.

## Audit capture (all generic, driven only by the profile)
Always captured: argv (prompt replaced by `<prompt>`, secrets redacted), brief path + sha256, cwd, pid, exit status, duration, stdout/stderr logs.
Optional: `artifacts` (e.g. a per-run session/transcript directory the agent writes: `--session-dir {{run_dir}}/session` style flags if the CLI has one), `session_id_regex`, `resume_args`.
Structured streams (e.g. a JSON event output flag) need no config: they land in the stdout log.

Verified on 2026-11-15 with real CLIs through `doctor` (profiles are examples of the mechanism, not recommendations):
```yaml
- id: pi-impl
  command: pi
  args: ["-p", "--session-dir", "{{run_dir}}/pi-session", "{{prompt_pointer}}"]
  artifacts: ["{{run_dir}}/pi-session"]        # session transcript .jsonl captured with sha256
- id: cline-rev
  command: cline
  args: ["--json", "{{prompt_pointer}}"]        # JSON event stream → stdout log
  session_id_regex: "\"(?:sessionId|session_id|taskId)\"\\s*:\\s*\"([^\"]+)\""   # extracted: conv_… id
```

## Which delivery mode?
1. `{{prompt_pointer}}` as an argument — default. The agent must be allowed to read files under `<root>/.sf/runtime/`
   (briefs live there, while its cwd is the task worktree). Some tools restrict reads to the cwd; then:
2. `input: stdin` — the brief is piped on stdin (for CLIs with a "read prompt from stdin" print mode).
3. `{{prompt}}` — inline argument, for short briefs only.
Let `doctor` decide: it fails loudly when the agent never echoes the test token.

## Starting points — read this before trusting them
Flags change between versions. **Always derive the real flags from `probe <cmd>` output and prove them with
`doctor`.** The notes below record what `--help` showed on one machine on 2026-11-15; they are hints, not facts.

| CLI | Seen in `--help` (verified on that machine) | Notes |
|---|---|---|
| `claude` 2.1.x | `-p/--print` non-interactive; `--model <alias>`; `--permission-mode <acceptEdits\|auto\|bypassPermissions\|manual\|dontAsk\|plan>`; `--allowedTools`; `--add-dir` | Headless mode cannot answer permission prompts. Implementers need an edit-capable mode (e.g. `acceptEdits`, plus tool allow-lists for the verify commands they should run). `--add-dir`/`--allowedTools` are variadic: put them last or use `--flag=value`. Prefer `input: stdin` if reading the brief path is denied. |
| `pi` 1.5.x | `-p/--print` non-interactive; `--model`; `--provider`; `--tools`; `--no-session` | Prompt is a positional message. Tool allow-list flags control what it may do. |
| `cline` 3.0.x | prompt is a positional argument (act mode, auto-approve default true); `-y/--yolo`; `-m/--model`; `-c/--cwd`; `-t/--timeout`; `--json` | Auto-approval is on by default — only use in worktrees. |

Not verified here (CLI not installed on that machine) — treat purely as search terms for `--help`:
`codex` (a non-interactive `exec` subcommand), `cursor-agent` (a print flag), `kiro-cli` (a chat subcommand with a
non-interactive option), `opencode` (a `run` subcommand). Probe them, don't copy.

## Reviewer profiles
Reviewers must not edit the worktree (the supervisor detects and reverts changes, then discards the review).
Use a read-only/plan permission mode if the CLI has one, but allow it to run read-only commands such as the
project's tests when possible. The result is read from `{{result_file}}` if written, otherwise from the last
```json block on stdout — so a fully read-only reviewer works.
