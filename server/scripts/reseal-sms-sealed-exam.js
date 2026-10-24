#!/usr/bin/env node
/**
 * Reseal the SMS sealed exam from recent judged drafts.
 *
 * Why: the freezer only accepts drafts whose frozen facts carry the CURRENT drafter's fact contract. Every
 * wording edit to the static COMPANY FACTS section used to make every older draft incompatible, so the pool
 * held a handful of items. sealEvalItems now re-renders that static section onto the current one (rows get
 * schema_version "sms-sealed-eval.v1+rebased"), and rotates the oldest incompatible items out of the active
 * pool (active=false; nothing is deleted). This script runs that same pass once, on demand.
 *
 * Pure selection: no LLM call, no SMS, no email. Items already sealed are never edited.
 *
 * Usage (from the repo root, with the target database's DATABASE_URL):
 *   node server/scripts/reseal-sms-sealed-exam.js                 # DRY-RUN (default): prints the plan, writes nothing
 *   node server/scripts/reseal-sms-sealed-exam.js --execute       # seal + rotate for real
 *   --min-age-days N   draft must be at least N days old (default SEALED_EVAL_MIN_AGE_DAYS, 7)
 *   --target N         active pool size to fill (default SEALED_EVAL_TARGET, 100)
 * Run it with the PRODUCTION variables (railway run ...): the contract follows the gates this process sees,
 * and the script refuses a run that does not see the real-answers identity.
 *
 * Safe to re-run: the anti-join and the unique source_draft_id make a second pass a no-op.
 */
const db = require('../models/db');

const argv = process.argv.slice(2);
const EXECUTE = argv.includes('--execute');
const numArg = (name) => {
  const at = argv.indexOf(name);
  if (at < 0) return undefined;
  const n = Number(argv[at + 1]);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} needs a non-negative number`);
  return n;
};

async function main() {
  const { sealEvalItems, SEALED_EVAL_TARGET } = require('../services/sms-sealed-eval');
  const drafter = require('../services/sms-shadow-drafter');
  const target = numArg('--target') ?? SEALED_EVAL_TARGET;
  const minAgeDays = numArg('--min-age-days');
  console.log(`SMS sealed exam reseal - mode: ${EXECUTE ? 'EXECUTE (writing)' : 'DRY-RUN (no writes; pass --execute to write)'}`);
  console.log(`current prompt version: ${drafter.currentPromptVersion()}  target: ${target}  min age: ${minAgeDays ?? 'default'} day(s)`);
  // The fact contract comes from the prompt version THIS process would stamp, which reads the gate
  // variables. A shell without the production variables reads v11 and would seal the wrong contract.
  if (!String(drafter.currentPromptVersion()).startsWith('house_voice_v12_real_answers') && !argv.includes('--allow-other-version')) {
    throw new Error('this process does not see GATE_SMS_REAL_ANSWERS on - run it with the production variables (railway run), or pass --allow-other-version');
  }
  const opts = { target, dryRun: !EXECUTE, ...(minAgeDays === undefined ? {} : { minAgeDays }) };
  let result;
  if (EXECUTE) {
    // the same advisory lock as the weekly cron and the admin endpoint
    const { runExclusive } = require('../utils/cron-lock');
    result = await runExclusive('sms-sealed-eval-seal', () => sealEvalItems(opts), { recordHealth: false });
    if (result?.skipped) throw new Error('a seal pass is already running - try again in a minute');
  } else {
    result = await sealEvalItems(opts);
  }
  console.log(JSON.stringify(result, null, 2));
  if (!EXECUTE) console.log('\nDry run only. Re-run with --execute to apply.');
}

main()
  .then(() => db.destroy())
  .catch(async (err) => {
    console.error(`reseal failed: ${err.message}`);
    await db.destroy().catch(() => {});
    process.exitCode = 1;
  });
