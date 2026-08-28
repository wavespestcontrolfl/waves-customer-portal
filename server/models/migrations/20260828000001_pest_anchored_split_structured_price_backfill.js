/**
 * Surface wizard-booked pest parents whose FIRST visit carries a structured
 * primary_line_price (follow-up to 20260827000002).
 *
 * The 08-27 backfill skipped every parent with primary_line_price > 0 on
 * the theory that a structured price meant an operator-priced renewal. In
 * prod the one such parent was a this-visit-only reprice of the first visit
 * (an initial fee folded into visit 1) on a series whose renewals would
 * therefore have templated at the first visit's price; it was reconciled
 * by hand with the edit-lane override. The resolver now honours the
 * seeder's anchored marker over a structured price, which covers every
 * FUTURE this-visit-only reprice (the marker survives it).
 *
 * Legacy rows are NOT stamped here: `primary_line_price > 0` says the price
 * is structured, not whether it was scoped to the first visit — and the
 * quote/child arithmetic proves only the original split, never the
 * operator's intent (pre-push P0). An unproven stamp would replace an
 * intentional renewal price. So this migration only SURFACES the
 * still-Ongoing ones lacking both the marker and an edit-lane price
 * override: row note + one admin bell, for the office to reconcile via
 * Edit appointment → apply to following.
 *
 * Guarded: no-op without recurring_template_overrides. Idempotent (re-run
 * finds the same rows; the note is appended once per distinct migration).
 */
const TAG = '[20260828000001]';
const DEDUPE_KEY = 'pest-renewal-price-unverified-20260828';
const NOTE = ' — RENEWAL PRICE UNVERIFIED (2026-08-28 migration): this self-booked pest plan has a repriced first visit and renews at that price until the per-visit amount is set via Edit appointment → apply to following';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'recurring_template_overrides'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'primary_line_price'))) return;
  if (!(await knex.schema.hasTable('estimates'))) return;

  const unproven = await knex('scheduled_services as p')
    .join('estimates as e', 'e.id', 'p.source_estimate_id')
    .whereNotNull('p.self_booking_id')
    .where('p.is_recurring', true)
    .where('p.recurring_ongoing', true)
    .whereNull('p.recurring_parent_id')
    .where('e.source', 'quote_wizard')
    .whereRaw("COALESCE(p.service_type, '') ~* '\\ypest\\y'")
    .whereRaw('p.primary_line_price > 0')
    .whereRaw("(p.recurring_template_overrides IS NULL OR NOT jsonb_exists(p.recurring_template_overrides, 'anchored_split_per_visit'))")
    .whereRaw("(p.recurring_template_overrides IS NULL OR NOT jsonb_exists(p.recurring_template_overrides, 'estimated_price'))")
    .whereRaw("(p.recurring_template_overrides IS NULL OR NOT jsonb_exists(p.recurring_template_overrides, 'primary_line_price'))")
    .whereRaw("COALESCE(p.notes, '') NOT LIKE ?", [`%${NOTE}%`])
    .select('p.id', 'p.customer_id');
  if (unproven.length) {
    const ids = unproven.map((r) => r.id);
    await knex('scheduled_services')
      .whereIn('id', ids)
      .update({ notes: knex.raw("COALESCE(notes, '') || ?", [NOTE]) });
    if (await knex.schema.hasTable('notifications')) {
      await knex('notifications').insert({
        recipient_type: 'admin',
        recipient_id: null,
        category: 'billing',
        title: 'Self-booked pest plans need a renewal-price check',
        body: `${unproven.length} self-booked pest plan(s) have a repriced first visit and renew at that price until reconciled. Open each series and set the per-visit amount via Edit appointment → apply to following.`,
        icon: null,
        link: '/admin/schedule',
        metadata: JSON.stringify({ dedupeKey: DEDUPE_KEY, scheduled_service_ids: ids, customer_ids: [...new Set(unproven.map((r) => String(r.customer_id)))] }),
      });
    }
  }
  console.log(`${TAG} renewal-price UNVERIFIED (structured first-visit price, surfaced): ${unproven.length} ongoing pest parent(s)`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  await knex('scheduled_services')
    .whereRaw('notes LIKE ?', [`%${NOTE}%`])
    .update({ notes: knex.raw('REPLACE(notes, ?, ?)', [NOTE, '']) });
  // The bell goes with the notes, so a rollback + re-apply never leaves two
  // (pre-push P1).
  if (await knex.schema.hasTable('notifications')) {
    await knex('notifications')
      .whereRaw("metadata ->> 'dedupeKey' = ?", [DEDUPE_KEY])
      .del();
  }
};
