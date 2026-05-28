#!/usr/bin/env node
/**
 * facts-population-worklist.js — prints the GSC-weighted facts-population
 * worklist: which facts-bank files, if populated, would unlock the
 * highest-value blocked pages.
 *
 * Joins the facts-bank readiness matrix (auditor) with opportunity_queue
 * (miner output). Reads opportunity_queue; writes nothing.
 *
 * Usage:
 *   ASTRO_REPO_DIR=/path/to/wavespestcontrol-astro \
 *     node server/scripts/facts-population-worklist.js
 *   node server/scripts/facts-population-worklist.js --json
 *   node server/scripts/facts-population-worklist.js --fresh-mine   # see sub-threshold demand
 *
 * --fresh-mine ranks against a fresh, non-persisting mine instead of the
 * persisted opportunity_queue. The queue only holds rows above minScoreToAct,
 * so the default view under-reports facts gaps for cities whose pages don't yet
 * clear the act threshold. Use --fresh-mine for facts-population planning.
 *
 * For prod data:
 *   railway run -s Postgres -- bash -c '
 *     DATABASE_URL=$DATABASE_PUBLIC_URL \
 *       node server/scripts/facts-population-worklist.js --fresh-mine
 *   '
 */

const db = require('../models/db');
const worklist = require('../services/content/facts-population-worklist');

function parseArgs(argv) {
  const flags = argv.slice(2);
  return { json: flags.includes('--json'), freshMine: flags.includes('--fresh-mine') };
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await worklist.build({ db, source: args.freshMine ? 'mine' : 'queue' });

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  const s = result.summary;
  console.log('\n=== Facts-Population Worklist ===');
  console.log(`Generated: ${result.generated_at}`);
  if (s.error) {
    console.log(`ERROR: ${s.error}`);
    return;
  }
  console.log(`Source:                   ${s.source}${s.source === 'mine' ? ' (fresh mine — incl. sub-threshold)' : ' (persisted queue)'}`);
  console.log(`Opportunities scanned:    ${s.opportunities_scanned}`);
  console.log(`Blocked (facts-gated):    ${s.blocked_facts_gated}`);
  console.log(`Sufficient combinations:  ${s.combinations_sufficient}/${s.combinations_total}`);
  console.log(`Files in worklist:        ${s.files_in_worklist}`);

  if (result.worklist.length === 0) {
    console.log('\n(no blocked facts-gated opportunities — either the queue is empty or all combos are sufficient)');
    return;
  }

  console.log('\n--- Ranked (populate these facts files first) ---');
  console.log('priority  sole-unlock  contrib  blocked  file');
  for (const f of result.worklist) {
    const line = [
      String(f.priority).padStart(8),
      `${String(f.sole_unlock_value).padStart(5)} (${f.sole_unlock_count})`.padStart(11),
      String(f.contributing_value).padStart(7),
      String(f.blocked_count).padStart(7),
      `  ${f.file_type}/${f.file_id}`,
    ].join('  ');
    console.log(line);
    if (f.example_combos.length) {
      const ex = f.example_combos.slice(0, 3).map((c) => `${c.city}×${c.service}`).join(', ');
      console.log(`          e.g. ${ex}`);
    }
  }
  console.log('\nsole-unlock = value this file unlocks on its own (count of pages); contrib = value where it is one of several blockers.');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('facts-population-worklist failed:', err.message);
  process.exit(1);
});
