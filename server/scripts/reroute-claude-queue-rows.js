#!/usr/bin/env node
/**
 * One-time mover for GATE_ALERT_CLAUDE_QUEUE (owner 2026-10-26): open admin bell rows written before
 * the gate went on that the routing table sends to Claude's queue (services/admin-alert-routing.js:
 * a Mac reminder job's row except an owner ask, and our own engineering-fault classes) move to the
 * Activity feed and are stamped who=claude, severity and class. Visibility only: read state, done
 * state, text and link stay, so nothing rings. Sends nothing to anyone.
 *
 * Usage (prod: through the Railway env so the Postgres connection and the gate are the live ones):
 *   railway run --service <portal> node server/scripts/reroute-claude-queue-rows.js            # DRY RUN
 *   railway run --service <portal> node server/scripts/reroute-claude-queue-rows.js --execute  # write
 *
 * Refuses to run while GATE_ALERT_CLAUDE_QUEUE is not exactly `true`. Safe to re-run: a stamped row is
 * skipped. Undo for one class: remove the feed, who, severity and claudeQueue keys from the rows' metadata.
 */
const db = require('../models/db');
const { rerouteOpenRows } = require('../services/admin-alert-routing');

const EXECUTE = process.argv.includes('--execute');

(async () => {
  const result = await rerouteOpenRows(db, { execute: EXECUTE });
  console.log(`${EXECUTE ? 'EXECUTE' : 'DRY RUN (no writes; pass --execute to write)'}: scanned ${result.scanned} open candidate row(s), ${result.matched} match.`);
  for (const [name, n] of Object.entries(result.byClass)) {
    console.log(`  ${name}: ${n}`);
    for (const s of result.samples[name]) console.log(`    e.g. ${s.id}  ${s.title}`);
  }
  if (EXECUTE) console.log(`Moved ${result.moved} row(s); ${result.changedSinceRead} skipped because the row changed since it was read.`);
})()
  .then(() => db.destroy())
  .catch(async (err) => {
    console.error(err.message);
    await db.destroy().catch(() => {});
    process.exit(1);
  });
