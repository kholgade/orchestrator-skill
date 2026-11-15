// GENERATED COPY of sf-shared/lib — edit sf-shared/lib and run `npm run sync`.
// @ts-check
import { parse as parseYaml } from './yaml.mjs';
import { validate, applyDefaults } from './validate.mjs';
import { factorySchema } from './schemas.mjs';
import { placeholders } from './template.mjs';
import { SfError, readText, exists, sfPaths } from './util.mjs';

export const AGENT_VARS = [
  'prompt', 'prompt_file', 'prompt_pointer', 'cwd', 'root', 'model', 'role',
  'task_id', 'attempt', 'run_dir', 'result_file', 'agent_id', 'session_id',
];
const PROMPT_VARS = ['prompt', 'prompt_file', 'prompt_pointer'];

export function loadYamlFile(file) {
  const text = readText(file);
  try {
    return parseYaml(text, { filename: file });
  } catch (e) {
    if (e.name === 'YamlError') throw new SfError(e.message, { code: 'YAML' });
    throw e;
  }
}

/** Expand ${VAR} references. Returns {value, missing[]}. */
export function expandEnv(str, env = process.env) {
  const missing = [];
  const value = String(str).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, n) => {
    if (env[n] === undefined || env[n] === '') {
      missing.push(n);
      return '';
    }
    return env[n];
  });
  return { value, missing };
}

export function independent(a, b, mode = 'agent') {
  if (a.id === b.id) return false;
  if (mode === 'agent') return true;
  const key = mode === 'model' ? 'model' : 'provider';
  return Boolean(a[key] && b[key] && a[key] !== b[key]);
}

/** Semantic validation beyond schema. Returns {errors, warnings}. */
export function lintFactory(f, env = process.env) {
  const errors = [];
  const warnings = [];
  const byId = new Map();
  for (const [i, a] of f.agents.entries()) {
    if (byId.has(a.id)) errors.push(`$.agents[${i}].id: duplicate agent id "${a.id}"`);
    byId.set(a.id, a);
    const at = `$.agents[${i}](${a.id})`;
    for (const item of a.args ?? []) {
      const names = typeof item === 'string' ? placeholders(item) : [...placeholders(item.args.join(' ')), item.if];
      for (const n of names) if (!AGENT_VARS.includes(n)) errors.push(`${at}: unknown placeholder {{${n}}} (allowed: ${AGENT_VARS.join(', ')})`);
    }
  }
  for (const [i, a] of f.agents.entries()) {
    for (const n of placeholders((a.resume_args ?? []).join(' '))) if (!AGENT_VARS.includes(n)) errors.push(`$.agents[${i}](${a.id}).resume_args: unknown placeholder {{${n}}}`);
    for (const n of placeholders((a.artifacts ?? []).join(' '))) if (!AGENT_VARS.includes(n)) errors.push(`$.agents[${i}](${a.id}).artifacts: unknown placeholder {{${n}}}`);
    if (a.session_id_regex) {
      try {
        const re = new RegExp(a.session_id_regex);
        if (!/\((?!\?)/.test(a.session_id_regex)) errors.push(`$.agents[${i}](${a.id}).session_id_regex: needs one capture group, e.g. "session[: ]+([A-Za-z0-9-]+)"`);
        void re;
      } catch (e) { errors.push(`$.agents[${i}](${a.id}).session_id_regex: invalid regex (${e.message})`); }
    }
    if (a.resume_args && !a.session_id_regex) errors.push(`$.agents[${i}](${a.id}): resume_args needs session_id_regex`);
  }
  const resolve = (id, where) => {
    const a = byId.get(id);
    if (!a) errors.push(`${where}: unknown agent "${id}" (defined: ${[...byId.keys()].join(', ')})`);
    else if (a.enabled === false) errors.push(`${where}: agent "${id}" is disabled`);
    return a;
  };
  const impls = f.roles.implementers.map((id, i) => resolve(id, `$.roles.implementers[${i}]`)).filter(Boolean);
  const revs = f.roles.reviewers.map((id, i) => resolve(id, `$.roles.reviewers[${i}]`)).filter(Boolean);
  for (const k of ['spec_author', 'planner']) {
    const v = f.roles[k];
    if (v && v !== 'session') resolve(v, `$.roles.${k}`);
  }
  const used = new Set([...impls, ...revs, ...['spec_author', 'planner'].map((k) => byId.get(f.roles[k])).filter(Boolean)]);
  for (const a of used) {
    const reachable = (a.args ?? []).some((item) => (typeof item === 'string' ? placeholders(item) : placeholders(item.args.join(' '))).some((n) => PROMPT_VARS.includes(n)));
    if (!reachable && a.input !== 'stdin') {
      errors.push(`agent "${a.id}": never receives the prompt; add "{{prompt_pointer}}" (or {{prompt}}/{{prompt_file}}) to args, or set input: stdin`);
    }
  }
  const mode = f.execution.review_independence;
  if (f.verification.require_independent_review && impls.length && revs.length) {
    const ok = impls.some((i) => revs.some((r) => independent(i, r, mode)));
    if (!ok) errors.push(`roles: no implementer/reviewer pair satisfies review_independence="${mode}" (agents need different ${mode === 'agent' ? 'ids' : mode + 's'}; set "model"/"provider" on agents if using that mode)`);
    if (mode !== 'agent' && [...impls, ...revs].some((a) => !a[mode])) warnings.push(`review_independence="${mode}" but some agents have no "${mode}" set; they can never be paired`);
  }
  for (const [i, c] of f.notify.channels.entries()) {
    const at = `$.notify.channels[${i}]`;
    if (c.type !== 'webhook') continue;
    if (!c.url) errors.push(`${at}.url: required for webhook channels (use \${ENV_VAR} for secrets, never inline tokens)`);
    if (c.preset === 'telegram' && (c.chat_id === undefined || c.chat_id === '')) errors.push(`${at}.chat_id: required for the telegram preset`);
    if (!c.preset && !c.body) warnings.push(`${at}: webhook without preset or body will POST {"text": ...}`);
    for (const field of ['url', 'chat_id', 'body']) {
      if (c[field] === undefined) continue;
      const { missing } = expandEnv(c[field], env);
      for (const m of missing) warnings.push(`${at}.${field}: environment variable ${m} is not set (required when the supervisor runs)`);
    }
    if (c.url && /^https?:\/\/[^/]*:[^/@]*@/.test(c.url)) errors.push(`${at}.url: must not embed credentials; use \${ENV_VAR}`);
    if (c.url && /bot\d{6,}:[A-Za-z0-9_-]{20,}/.test(c.url)) errors.push(`${at}.url: contains what looks like a literal Telegram bot token; use \${TELEGRAM_BOT_TOKEN}`);
  }
  if (f.roles.implementers.length > 1 && f.execution.max_parallel_tasks === 1) warnings.push('multiple implementers configured but execution.max_parallel_tasks is 1');
  return { errors, warnings };
}

/**
 * Load, default-fill, and fully validate the factory config.
 * @returns {{factory: any, paths: ReturnType<typeof sfPaths>, warnings: string[]}}
 */
export function loadFactory(root, { env = process.env } = {}) {
  const base = sfPaths(root);
  if (!exists(base.factory)) {
    throw new SfError(`No factory config at ${base.factory}. Run the sf-agent-setup skill first (node sf-agent-setup/scripts/setup.mjs init).`, { code: 'NO_FACTORY' });
  }
  const raw = loadYamlFile(base.factory);
  const schemaErrors = validate(raw, factorySchema);
  if (schemaErrors.length) throw new SfError(`Invalid ${base.factory}`, { code: 'BAD_FACTORY', details: schemaErrors });
  const factory = applyDefaults(raw, factorySchema);
  const { errors, warnings } = lintFactory(factory, env);
  if (errors.length) throw new SfError(`Invalid ${base.factory}`, { code: 'BAD_FACTORY', details: errors });
  const paths = sfPaths(root, factory.paths ?? {});
  return { factory, paths, warnings };
}

/**
 * Like loadFactory but never throws: used by skills that only need path overrides.
 * @returns {{factory:any|null, paths:ReturnType<typeof sfPaths>, problem:string|null}}
 */
export function softFactory(root) {
  try {
    const { factory, paths } = loadFactory(root);
    return { factory, paths, problem: null };
  } catch (e) {
    if (!(e instanceof SfError)) throw e;
    if (e.code === 'NO_FACTORY') return { factory: null, paths: sfPaths(root), problem: null };
    process.stderr.write(`WARN: ${e.message} — ${(e.details ?? []).join('; ')}; using default paths. Fix with sf-agent-setup.\n`);
    return { factory: null, paths: sfPaths(root), problem: e.message };
  }
}

export function agentById(factory, id) {
  const a = factory.agents.find((x) => x.id === id);
  if (!a) throw new SfError(`Unknown agent "${id}"`, { code: 'NO_AGENT' });
  return a;
}
