#!/usr/bin/env node
/**
 * One-time backfill: stamp the text_number_differs cards filed before card <-> hold bindings existed
 * (#6112 cards, no payload.hold_bindings) with the hold they were filed for.
 *
 * A card is bound to the hold rows of ITS OWN call that are for the same canonical line as the card's
 * ani_phone and were armed within 5 minutes of the card's created_at (the card is built a moment before
 * the hold row is written, in the same pass). Each match becomes { line_e164, held_at } in
 * payload.hold_bindings, appended and never replaced. A card with no such hold stays unstamped and binds to
 * nothing. Idempotent: a stamped card is skipped, so it is safe to run twice. Cleared holds count too: the
 * binding names the arming, and a later re-arm has a new held_at.
 *
 * Usage:
 *   node scripts/backfill-no-text-card-bindings.js            # dry run: prints what would be stamped
 *   node scripts/backfill-no-text-card-bindings.js --apply    # writes, in one transaction
 *
 * The owner runs it against production. Run the dry run first and read the list.
 */
const { canonicalPhoneSql, LEGACY_BINDING_WINDOW } = require('../server/services/disclaimed-number-holds');

const CANDIDATES_SQL = `
  SELECT t.id AS card_id, t.call_log_id, t.created_at,
         jsonb_agg(jsonb_build_object('line_e164', h.phone_e164, 'held_at', h.held_at::text) ORDER BY h.held_at) AS bindings
    FROM triage_items t
    JOIN disclaimed_number_holds h ON h.source_call_log_id = t.call_log_id
   WHERE t.reason_code = 'text_number_differs' AND t.payload->'hold_bindings' IS NULL
     AND h.held_at BETWEEN t.created_at - ${LEGACY_BINDING_WINDOW} AND t.created_at + ${LEGACY_BINDING_WINDOW}
     AND ${canonicalPhoneSql("t.payload->>'ani_phone'")} = h.phone_e164
   GROUP BY t.id, t.call_log_id, t.created_at
   ORDER BY t.created_at`;

async function backfill(conn, { apply = false } = {}) {
  const result = await conn.raw(CANDIDATES_SQL);
  const rows = result.rows || [];
  if (apply) {
    await conn.transaction(async (trx) => {
      for (const row of rows) {
        await trx.raw(
          `UPDATE triage_items SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('hold_bindings', ?::jsonb)
            WHERE id = ? AND payload->'hold_bindings' IS NULL`,
          [JSON.stringify(row.bindings), row.card_id],
        );
      }
    });
  }
  const unmatched = await conn.raw(
    `SELECT count(*)::int AS n FROM triage_items WHERE reason_code = 'text_number_differs' AND payload->'hold_bindings' IS NULL`,
  );
  return { rows, apply, unstampedAfter: unmatched.rows[0].n - (apply ? 0 : rows.length) };
}

module.exports = { backfill, CANDIDATES_SQL };

if (require.main === module) {
  require('dotenv').config();
  const db = require('../server/models/db');
  const apply = process.argv.includes('--apply');
  backfill(db, { apply })
    .then(({ rows, unstampedAfter }) => {
      for (const r of rows) console.log(`${apply ? 'stamped' : 'would stamp'} card ${r.card_id} (call ${r.call_log_id}): ${r.bindings.map((b) => b.line_e164).join(', ')}`);
      console.log(`${apply ? 'Stamped' : 'Would stamp'} ${rows.length} card(s). Cards left without bindings (no hold within 5 minutes on the same line): ${unstampedAfter}.`);
      if (!apply) console.log('Dry run. Re-run with --apply to write.');
    })
    .catch((err) => { console.error(err.message); process.exitCode = 1; })
    .finally(() => db.destroy());
}
