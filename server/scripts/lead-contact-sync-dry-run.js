#!/usr/bin/env node
/**
 * Dry run for the lead contact sync (GATE_LEAD_STATUS_FOLLOWS_CONTACT, owner
 * 2026-11-04). SELECTs only: it judges the same 'new' leads the sweep judges
 * and prints COUNTS, no names, phones, emails or ids:
 *   - how many 'new' leads would move to 'contacted', by evidence type;
 *   - how many stay 'new', by reason (no contact, shared phone, ...).
 *
 * Usage: node server/scripts/lead-contact-sync-dry-run.js [--json]
 * The gate does not need to be on: nothing is written.
 */
const db = require('../models/db');
const { candidateLeadsQuery, judgeLeads, LOOKBACK_DAYS } = require('../services/lead-contact-sync');

async function main() {
  const leads = await candidateLeadsQuery(db, new Date())
    .orderBy('first_contact_at', 'desc')
    .select('id', 'customer_id', 'phone', 'email', 'first_contact_at');
  const verdicts = await judgeLeads(db, leads);
  const wouldMove = {};
  const stay = {};
  for (const lead of leads) {
    const verdict = verdicts.get(String(lead.id));
    if (verdict && !verdict.skip) wouldMove[verdict.evidenceType] = (wouldMove[verdict.evidenceType] || 0) + 1;
    else {
      const reason = verdict?.skip || 'no_contact_evidence';
      stay[reason] = (stay[reason] || 0) + 1;
    }
  }
  const total = Object.values(wouldMove).reduce((a, b) => a + b, 0);
  const report = { lookbackDays: LOOKBACK_DAYS, newLeadsJudged: leads.length, wouldMoveToContacted: total, byEvidence: wouldMove, staysNew: stay };
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`New leads judged (first contact in the last ${LOOKBACK_DAYS} days): ${leads.length}`);
    console.log(`Would move to contacted: ${total}`);
    for (const [type, n] of Object.entries(wouldMove)) console.log(`  ${type}: ${n}`);
    console.log('Stay new:');
    for (const [reason, n] of Object.entries(stay)) console.log(`  ${reason}: ${n}`);
  }
}

main()
  .then(() => db.destroy && db.destroy())
  .catch(async (err) => {
    console.error(`lead-contact-sync dry run failed: ${err.message}`);
    try { await (db.destroy && db.destroy()); } catch { /* noop */ }
    process.exit(1);
  });
