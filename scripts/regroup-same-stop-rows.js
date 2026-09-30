#!/usr/bin/env node
/**
 * Combine future same-day services at one stop that qualify for a visit group
 * but were never grouped, so the tech can close them out together (one packet,
 * one invoice with a line per service, one summary text).
 *
 *   node scripts/regroup-same-stop-rows.js                  # DRY RUN (default): writes nothing
 *   node scripts/regroup-same-stop-rows.js --apply          # groups through maybeGroupRow
 *   node scripts/regroup-same-stop-rows.js --from 2026-10-02 --to 2026-10-31
 *   node scripts/regroup-same-stop-rows.js --limit 200      # judge at most 200 candidate rows this run
 *
 * Needs GATE_VISIT_GROUPS=true in the environment (gate off = no-op, as at
 * every other grouping seam). Tomorrow onward only — today and earlier are
 * never touched. Eligibility is server/services/visit-groups.js (maybeGroupRow
 * / createOrJoinVisit); this only finds the rows. Grouping sends no customer
 * text. Prints row / customer / property / visit ids only, never a name.
 * Re-running is a no-op (grouped rows carry visit_id and stop being candidates).
 */
require('dotenv').config();

const db = require('../server/models/db');
const { regroupUngroupedSameStopRows, countRegroupCandidateRows } = require('../server/services/visit-regroup');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const fromDate = arg('--from');
  const toDate = arg('--to');
  const limitArg = arg('--limit');
  const limit = limitArg ? Number(limitArg) : undefined;
  if (limitArg && !(limit > 0)) throw new Error('--limit needs a positive number');
  for (const [flag, v] of [['--from', fromDate], ['--to', toDate]]) {
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${flag} needs YYYY-MM-DD`);
  }

  const before = await countRegroupCandidateRows({ fromDate, toDate });
  const result = await regroupUngroupedSameStopRows({ fromDate, toDate, dryRun: !apply, ...(limit ? { maxCandidates: limit } : {}) });
  console.log(`mode: ${apply ? 'APPLY' : 'DRY RUN (no writes)'}  window: ${result.fromDate} .. ${toDate || 'open'}`);
  if (result.skipped) {
    console.log(`skipped: ${result.skipped} (set GATE_VISIT_GROUPS=true to run)`);
    return;
  }
  console.log(`ungrouped rows with a same-stop partner before: ${before}`);
  for (const g of result.groups) {
    console.log(`${apply ? 'grouped' : 'would group'} ${g.date} customer=${g.customerId} property=${g.propertyId} rows=${g.rowIds.join(',')}${g.visitId ? ` visit=${g.visitId}` : ''}`);
  }
  for (const l of result.left) console.log(`left alone row=${l.rowId} reason=${l.reason}`);
  if (apply) {
    const after = await countRegroupCandidateRows({ fromDate, toDate });
    console.log(`ungrouped rows with a same-stop partner after: ${after}`);
  }
  console.log(`summary: candidates=${result.candidates} groups=${result.groups.length} left=${result.left.length}${result.capped ? ' (stopped at --limit; re-run for the rest)' : ''}`);
}

main()
  .then(() => db.destroy())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
