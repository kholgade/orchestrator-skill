// @ts-check
// Schemas for every file format shared between the sf-* skills.

const ID = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$', patternHint: 'letters, digits, ".", "_", "-"' };
const strList = { type: 'array', items: { type: 'string', minLength: 1 } };

export const verifyCommand = {
  type: 'object',
  required: ['name', 'run'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    run: { type: 'string', minLength: 1 },
    timeout_minutes: { type: 'number', minimum: 0.1 },
  },
};

const argItem = {
  anyOf: [
    { type: 'string' },
    {
      type: 'object',
      required: ['if', 'args'],
      additionalProperties: false,
      properties: { if: { type: 'string', minLength: 1 }, args: { type: 'array', items: { type: 'string' } } },
    },
  ],
};

export const agentSchema = {
  type: 'object',
  required: ['id', 'command'],
  additionalProperties: false,
  properties: {
    id: ID,
    label: { type: 'string' },
    command: { type: 'string', minLength: 1 },
    args: { type: 'array', items: argItem, default: [] },
    input: { enum: ['stdin', 'none'], default: 'none' },
    model: { type: 'string' },
    provider: { type: 'string' },
    env: { type: 'object', additionalProperties: { type: 'string' } },
    env_inherit: { type: 'boolean', default: true },
    timeout_minutes: { type: 'number', minimum: 0.1 },
    max_concurrency: { type: 'integer', minimum: 1, default: 1 },
    capabilities: { type: 'array', items: { type: 'string' }, default: [] },
    success_exit_codes: { type: 'array', items: { type: 'integer' }, default: [0] },
    version_args: { type: 'array', items: { type: 'string' }, default: ['--version'] },
    artifacts: { type: 'array', items: { type: 'string' }, default: [] },
    session_id_regex: { type: 'string' },
    resume_args: { type: 'array', items: { type: 'string' } },
    enabled: { type: 'boolean', default: true },
    notes: { type: 'string' },
  },
};

const channel = {
  type: 'object',
  required: ['type'],
  additionalProperties: false,
  properties: {
    type: { enum: ['terminal', 'file', 'webhook'] },
    preset: { enum: ['telegram', 'slack', 'discord', 'generic'] },
    url: { type: 'string' },
    chat_id: { type: ['string', 'integer'] },
    method: { enum: ['POST', 'PUT'] },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
    body: { type: 'string' },
    events: { type: 'array', items: { enum: ['info', 'warn', 'error', 'approval', 'done'] } },
  },
};

export const factorySchema = {
  type: 'object',
  required: ['sf', 'project', 'agents', 'roles'],
  additionalProperties: false,
  properties: {
    sf: { const: 'factory/1' },
    project: {
      type: 'object',
      required: ['id'],
      additionalProperties: false,
      properties: {
        id: ID,
        name: { type: 'string' },
        instructions: { ...strList, default: [] },
      },
    },
    paths: {
      type: 'object',
      additionalProperties: false,
      properties: {
        spec: { type: 'string', default: '.sf/spec.md' },
        plan: { type: 'string', default: '.sf/plan.yaml' },
      },
    },
    agents: { type: 'array', minItems: 1, items: agentSchema },
    roles: {
      type: 'object',
      required: ['implementers', 'reviewers'],
      additionalProperties: false,
      properties: {
        orchestrator: { type: 'string' },
        spec_author: { type: 'string', default: 'session' },
        planner: { type: 'string', default: 'session' },
        implementers: { type: 'array', minItems: 1, items: { type: 'string' } },
        reviewers: { type: 'array', minItems: 1, items: { type: 'string' } },
      },
    },
    execution: {
      type: 'object',
      additionalProperties: false,
      properties: {
        max_parallel_tasks: { type: 'integer', minimum: 1, default: 2 },
        max_rework_rounds: { type: 'integer', minimum: 0, default: 2 },
        task_timeout_minutes: { type: 'number', minimum: 0.1, default: 60 },
        review_timeout_minutes: { type: 'number', minimum: 0.1, default: 30 },
        poll_seconds: { type: 'number', minimum: 0.05, default: 2 },
        review_independence: { enum: ['agent', 'model', 'provider'], default: 'agent' },
      },
    },
    git: {
      type: 'object',
      additionalProperties: false,
      properties: {
        base_branch: { type: 'string', default: 'auto' },
        milestone_branch_prefix: { type: 'string', default: 'milestone/' },
        task_branch_prefix: { type: 'string', default: 'task/' },
        worktree_root: { type: 'string', default: '.sf/runtime/worktrees' },
        cleanup_after_integration: { type: 'boolean', default: true },
        milestone_merge: { enum: ['manual', 'local'], default: 'manual' },
        commit_author_name: { type: 'string', default: 'sf-orchestrator' },
        commit_author_email: { type: 'string', default: 'sf-orchestrator@localhost' },
      },
    },
    verification: {
      type: 'object',
      additionalProperties: false,
      properties: {
        require_independent_review: { type: 'boolean', default: true },
        max_diff_bytes: { type: 'integer', minimum: 1000, default: 200000 },
      },
    },
    approvals: {
      type: 'object',
      additionalProperties: false,
      properties: {
        plan: { type: 'boolean', default: true },
        milestone_merge: { type: 'boolean', default: true },
      },
    },
    notify: {
      type: 'object',
      additionalProperties: false,
      properties: {
        interval_minutes: { type: 'number', minimum: 0, default: 5 },
        channels: { type: 'array', items: channel, default: [{ type: 'terminal' }, { type: 'file' }] },
      },
    },
  },
};

const criteriaList = { type: 'array', minItems: 1, items: { type: 'string', minLength: 3 } };

export const planSchema = {
  type: 'object',
  required: ['sf', 'project', 'spec', 'status', 'milestones', 'tasks'],
  additionalProperties: false,
  properties: {
    sf: { const: 'plan/1' },
    project: {
      type: 'object',
      required: ['id'],
      additionalProperties: false,
      properties: { id: ID, name: { type: 'string' } },
    },
    spec: {
      type: 'object',
      required: ['path'],
      additionalProperties: false,
      properties: { path: { type: 'string' }, hash: { type: 'string' } },
    },
    status: { enum: ['draft', 'approved'] },
    approved_at: { type: 'string' },
    notes: { type: 'string' },
    milestones: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'title'],
        additionalProperties: false,
        properties: {
          id: ID,
          title: { type: 'string', minLength: 1 },
          goal: { type: 'string' },
          depends_on: { type: 'array', items: { type: 'string' }, default: [] },
          exit_criteria: { type: 'array', items: { type: 'string' }, default: [] },
          verify: { type: 'array', items: verifyCommand, default: [] },
        },
      },
    },
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'milestone', 'title', 'goal', 'requirements', 'write_scopes', 'acceptance_criteria'],
        additionalProperties: false,
        properties: {
          id: ID,
          milestone: { type: 'string' },
          title: { type: 'string', minLength: 1 },
          goal: { type: 'string', minLength: 3 },
          requirements: { type: 'array', items: { type: 'string' } },
          depends_on: { type: 'array', items: { type: 'string' }, default: [] },
          write_scopes: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          acceptance_criteria: criteriaList,
          verify: { type: 'array', items: verifyCommand, default: [] },
          implementer: { type: 'string' },
          reviewer: { type: 'string' },
          requires: { type: 'array', items: { type: 'string' }, default: [] },
          max_rework_rounds: { type: 'integer', minimum: 0 },
          notes: { type: 'string' },
        },
      },
    },
  },
};

export const reviewResultSchema = {
  type: 'object',
  required: ['task_id', 'status', 'criteria', 'findings'],
  additionalProperties: false,
  properties: {
    task_id: { type: 'string' },
    status: { enum: ['PASS', 'FAIL', 'BLOCKED'] },
    summary: { type: 'string' },
    reviewer: { type: 'string' },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        required: ['criterion', 'status'],
        additionalProperties: false,
        properties: {
          criterion: { type: 'string' },
          status: { enum: ['PASS', 'FAIL', 'NOT_VERIFIED'] },
          evidence: { type: 'string' },
        },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'description'],
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          severity: { enum: ['blocking', 'major', 'minor', 'info'] },
          file: { type: 'string' },
          description: { type: 'string', minLength: 1 },
          required_fix: { type: 'string' },
        },
      },
    },
  },
};
