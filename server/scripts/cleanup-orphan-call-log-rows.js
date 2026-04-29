#!/usr/bin/env node
/**
 * One-time cleanup of orphan call_log rows created by the pre-fix
 * /recording-status fallback insert (twilio-voice-webhook.js:201-209
 * before commit X). For inbound calls answered via <Dial>, that path
 * synthesized a row with to_phone = the *forwarding* destination (e.g.
 * Adam's cell) instead of the Twilio number that was actually dialed —
 * polluting the dashboard's calls-by-source widget with phantom
 * "Unmapped — <forwarded number>" entries.
 *
 * Selection criteria — must match ALL of:
 *   1. direction = 'inbound'
 *   2. to_phone is NOT in lead_sources.twilio_phone_number (i.e. the
 *      "Unmapped" universe — same set the dashboard widget surfaces)
 *   3. recording_sid IS NOT NULL  (only the rows the broken fallback
 *      inserted; pre-existing legitimately-unmapped entries don't
 *      have a recording attached)
 *   4. customer_id IS NULL  (defense-in-depth: a row that got linked
 *      to a customer means a human used it for something — don't delete)
 *
 * Dry-run by default. Pass --apply to actually delete.
 *
 *   node server/scripts/cleanup-orphan-call-log-rows.js
 *   node server/scripts/cleanup-orphan-call-log-rows.js --apply
 *
 * For prod: export DATABASE_URL to the prod DB before running.
 *
 * Idempotent: re-running after --apply finds 0 rows.
 */

const db = require('../models/db');

const APPLY = process.argv.includes('--apply');

(async () => {
  const baseQuery = () => db('call_log as c')
    .leftJoin('lead_sources as s', 'c.to_phone', 's.twilio_phone_number')
    .where('c.direction', 'inbound')
    .whereNull('s.id')
    .whereNotNull('c.recording_sid')
    .whereNull('c.customer_id');

  const rows = await baseQuery()
    .select(
      'c.id',
      'c.twilio_call_sid',
      'c.to_phone',
      'c.from_phone',
      'c.recording_sid',
      'c.created_at',
    )
    .orderBy('c.created_at', 'asc');

  console.log(`\nOrphan recording-status rows: ${rows.length}\n`);

  if (rows.length === 0) {
    await db.destroy();
    return;
  }

  for (const r of rows) {
    console.log(
      `  ${new Date(r.created_at).toISOString().slice(0, 19)}  ` +
      `to=${(r.to_phone || '<null>').padEnd(14)}  ` +
      `from=${(r.from_phone || '<null>').padEnd(14)}  ` +
      `rec=${r.recording_sid}  ` +
      `sid=${r.twilio_call_sid}`,
    );
  }

  if (!APPLY) {
    console.log(`\n  (dry-run — pass --apply to delete these ${rows.length} row(s))\n`);
    await db.destroy();
    return;
  }

  const ids = rows.map((r) => r.id);
  const deleted = await db('call_log').whereIn('id', ids).delete();
  console.log(`\n  ✓ Deleted ${deleted} row(s).\n`);

  await db.destroy();
})().catch(async (err) => {
  console.error(err);
  await db.destroy();
  process.exit(1);
});
