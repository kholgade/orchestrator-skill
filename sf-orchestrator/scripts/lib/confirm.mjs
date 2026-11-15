// GENERATED COPY of sf-shared/lib — edit sf-shared/lib and run `npm run sync`.
// @ts-check
// Human-confirmation protocol for gated actions (approvals, resume, reset, delete).
//  • Direct terminal use: interactive prompt; confirmer is "user".
//  • Non-interactive: caller must pass --confirmed-by user|external:<id> [--via name] [--quote text].
import readline from 'node:readline/promises';
import { SfError } from './util.mjs';

export const CONFIRM_OPTIONS = {
  'confirmed-by': { type: 'string' },
  via: { type: 'string' },
  quote: { type: 'string' },
};

const WHO = /^(user|external:[A-Za-z0-9._-]+)$/;

/**
 * @param {{values:Record<string,any>, summary:string, word:string}} o
 * @returns {Promise<{confirmed_by:string, via:string|null, quote:string|null, interactive:boolean}>}
 */
export async function confirmAction({ values, summary, word }) {
  const given = values['confirmed-by'];
  if (given) {
    if (!WHO.test(given)) throw new SfError(`--confirmed-by must be "user" or "external:<id>" (got "${given}")`, { exitCode: 2 });
    return { confirmed_by: given, via: values.via ?? null, quote: values.quote ?? null, interactive: false };
  }
  if (process.stdin.isTTY && process.stdout.isTTY) {
    process.stdout.write(`${summary}\n`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`Type "${word}" to confirm (anything else aborts): `)).trim();
    rl.close();
    if (answer !== word) throw new SfError('Aborted: confirmation not given.', { code: 'NOT_CONFIRMED', exitCode: 4 });
    return { confirmed_by: 'user', via: null, quote: answer, interactive: true };
  }
  throw new SfError(
    `Confirmation required for: ${word}. Ask the user, then re-run with --confirmed-by user --quote "<their words>" ` +
      '(a remote supervisor may pass --confirmed-by external:<id>), or run this command in a terminal.',
    { code: 'CONFIRMATION_REQUIRED', exitCode: 4 },
  );
}
