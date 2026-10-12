#!/usr/bin/env node
/**
 * One-time backfill: stamp the text_number_differs cards filed before card <-> hold bindings existed
 * (#6112 cards, no payload.hold_bindings) with the hold they were filed for.
 *
 * The rule is the one the server applies to an unstamped card (legacyCardBoundSql): a hold of the card's own
 * call, on the card's line under the hold writer's phone rule (holdPhoneKey), armed within 5 minutes of the
 * card's created_at and not after the card closed, and no OTHER unstamped card of the call fits the same arming.
 * Each match becomes { line_e164, held_at } in payload.hold_bindings, appended and never replaced.
 * A card that fits more than one candidate is AMBIGUOUS: the script does not stamp it, lists it in the dry run
 * ("unbound: ambiguous") and on --apply, and it stays unbound. A card with no fitting hold is "unbound: no hold".
 * Idempotent: a stamped card is skipped, so it is safe to run twice. Cleared holds count too: the binding names
 * the arming, and a later re-arm has a new held_at.
 *
 * Usage:
 *   node scripts/backfill-no-text-card-bindings.js            # dry run: prints what would be stamped
 *   node scripts/backfill-no-text-card-bindings.js --apply    # writes, in one transaction
 *
 * The owner runs it against production. Run the dry run first and read the list.
 */
const { holdPhoneKeySql, legacyCardFitsArmingSql, legacyCardBoundSql } = require('../server/services/disclaimed-number-holds');

const CANDIDATES_SQL = `
  SELECT t.id AS card_id, t.call_log_id, t.created_at,
         jsonb_agg(jsonb_build_object('line_e164', h.phone_e164, 'held_at', h.held_at::text) ORDER BY h.held_at) AS bindings
    FROM triage_items t
    JOIN disclaimed_number_holds h ON ${legacyCardBoundSql('t', 'h')}
   GROUP BY t.id, t.call_log_id, t.created_at
   ORDER BY t.created_at`;

// Unstamped cards that fit some hold of their own call and line but are NOT bound, because another unstamped
// card of the call fits the same arming.
const AMBIGUOUS_SQL = `
  SELECT DISTINCT t.id AS card_id, t.call_log_id, t.created_at
    FROM triage_items t
    JOIN disclaimed_number_holds h ON ${legacyCardFitsArmingSql('t', 'h')}
     AND ${holdPhoneKeySql("t.payload->>'ani_phone'")} = h.phone_e164
   WHERE NOT (${legacyCardBoundSql('t', 'h')})
   ORDER BY t.created_at`;

async function backfill(conn, { apply = false } = {}) {
  const result = await conn.raw(CANDIDATES_SQL);
  const rows = result.rows || [];
  const ambiguous = (await conn.raw(AMBIGUOUS_SQL)).rows || [];
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
  return { rows, ambiguous, apply, unstampedAfter: unmatched.rows[0].n - (apply ? 0 : rows.length) };
}

module.exports = { backfill, CANDIDATES_SQL, AMBIGUOUS_SQL };

if (require.main === module) {
  require('dotenv').config();
  const db = require('../server/models/db');
  const apply = process.argv.includes('--apply');
  backfill(db, { apply })
    .then(({ rows, ambiguous, unstampedAfter }) => {
      for (const r of rows) console.log(`${apply ? 'stamped' : 'would stamp'} card ${r.card_id} (call ${r.call_log_id}): ${r.bindings.map((b) => b.line_e164).join(', ')}`);
      for (const r of ambiguous) console.log(`unbound: ambiguous card ${r.card_id} (call ${r.call_log_id}) fits more than one candidate; left unstamped`);
      console.log(`${apply ? 'Stamped' : 'Would stamp'} ${rows.length} card(s). Cards left without bindings (no hold within 5 minutes on the same line, or ambiguous): ${unstampedAfter}.`);
      if (!apply) console.log('Dry run. Re-run with --apply to write.');
    })
    .catch((err) => { console.error(err.message); process.exitCode = 1; })
    .finally(() => db.destroy());
}
