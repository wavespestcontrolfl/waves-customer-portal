/**
 * Pest funnel joins the stranded-activation recovery (owner ruling
 * 2026-08-27, Option A) — BACKFILL for rows booked before that.
 *
 * The recovery sweep's claim is the parent-scoped shape: self-booked,
 * pay-at-visit, priced, auto-invoicing, not recurring, no children,
 * wizard-sourced, wizard_recovery_reconciled_at IS NULL. The pest funnel's
 * deliberate "duplicate-kept one-off" (a visit booked beside an existing
 * pest plan, kept billable, no second series) presents exactly that shape,
 * and only kept bookings made AFTER this deploy stamp the marker at
 * kept-time. Every earlier pest row matching the shape is therefore stamped
 * here so the sweep never strips a legitimately billable one-off — for a
 * genuinely stranded pre-deploy pest row this preserves the status quo (the
 * sweep never covered pest before), which the office reconciles by hand.
 *
 * Guarded: no-op without the marker column (migration 20260827000001).
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'wizard_recovery_reconciled_at'))) return;
  const updated = await knex('scheduled_services as ss')
    .whereNull('ss.wizard_recovery_reconciled_at')
    .whereNotNull('ss.self_booking_id')
    .where('ss.payment_method_preference', 'pay_at_visit')
    .where((qb) => qb.where('ss.is_recurring', false).orWhereNull('ss.is_recurring'))
    .whereNull('ss.recurring_parent_id')
    .whereRaw("COALESCE(ss.service_type, '') ~* '\\ypest\\y'")
    .whereExists(function wizardSource() {
      this.select(1).from('estimates as e').whereRaw('e.id = ss.source_estimate_id').where('e.source', 'quote_wizard');
    })
    .whereNotExists(function child() {
      this.select(1).from('scheduled_services as c').whereRaw('c.recurring_parent_id = ss.id');
    })
    .update({
      wizard_recovery_reconciled_at: knex.fn.now(),
      notes: knex.raw("COALESCE(notes, '') || ' — pre-2026-08-27 pest one-off: marked reconciled by migration (recovery sweep now covers pest)'"),
    });
   
  console.log(`[20260827000002] pest recovery backfill stamped ${updated} row(s)`);

  // Anchored-split PROVENANCE for series already on the books: the pest
  // funnel seeded every follow-up at the even per-visit quotient while the
  // parent kept the annual's remainder cents, and auto-extend renewed off
  // the parent. New seeds record the quotient as
  // recurring_template_overrides.anchored_split_per_visit (seeder-owned
  // key). For EXISTING self-booked, wizard-sourced pest parents the split
  // is RE-DERIVED from the stored quote annual and the fixed 4-visit plan
  // (perVisitAmountForEstimate's arithmetic, cent-exact): quotient =
  // floor(annual¢ / 4), first = annual¢ − 3·quotient. A parent is stamped
  // ONLY when its price equals `first` AND the THREE EARLIEST seeded
  // follow-ups (by date — the seeding transaction's own rows, cancelled or
  // not; later extensions are irrelevant) each equal `quotient`. The
  // stamped value is therefore the historical per-visit amount those
  // visits already carry, proven by exact reproduction of all four prices
  // — a draft that /calculate has since rewritten to a different program
  // cannot reproduce them and simply yields no stamp. Nothing is inferred
  // from a price pattern. Skips parents with a primary_line_price (the
  // financials path never reads estimated_price for those) or an existing
  // marker. jsonb_exists() rather than the `?` operator: knex.raw treats a
  // bare `?` as a bind placeholder.
  if (!(await knex.schema.hasColumn('scheduled_services', 'recurring_template_overrides'))) return;
  const stamped = await knex.raw(`
    WITH src AS (
      SELECT p.id AS parent_id,
             ROUND(p.estimated_price * 100) AS parent_cents,
             ROUND(COALESCE(NULLIF(e.annual_total, 0), e.monthly_total * 12) * 100) AS annual_cents
      FROM scheduled_services p
      JOIN estimates e ON e.id = p.source_estimate_id AND e.source = 'quote_wizard'
      WHERE p.self_booking_id IS NOT NULL
        AND p.is_recurring = TRUE
        AND p.recurring_parent_id IS NULL
        AND p.estimated_price IS NOT NULL
        AND (p.primary_line_price IS NULL OR p.primary_line_price <= 0)
        AND COALESCE(p.service_type, '') ~* '\\ypest\\y'
        AND (p.recurring_template_overrides IS NULL OR NOT jsonb_exists(p.recurring_template_overrides, 'anchored_split_per_visit'))
    ), split AS (
      SELECT parent_id, parent_cents, annual_cents,
             FLOOR(annual_cents / 4) AS quotient_cents,
             annual_cents - 3 * FLOOR(annual_cents / 4) AS first_cents
      FROM src
      WHERE annual_cents > 0
    ), seeded AS (
      SELECT c.recurring_parent_id AS parent_id, c.estimated_price,
             ROW_NUMBER() OVER (PARTITION BY c.recurring_parent_id ORDER BY c.scheduled_date ASC, c.created_at ASC, c.id ASC) AS rn
      FROM scheduled_services c
      JOIN split s ON s.parent_id = c.recurring_parent_id
    ), q AS (
      SELECT s.parent_id, s.quotient_cents / 100.0 AS per_visit
      FROM split s
      JOIN seeded c ON c.parent_id = s.parent_id AND c.rn <= 3
      WHERE s.parent_cents = s.first_cents
        AND s.quotient_cents > 0
      GROUP BY s.parent_id, s.quotient_cents
      HAVING COUNT(*) = 3
         AND BOOL_AND(c.estimated_price IS NOT NULL AND ROUND(c.estimated_price * 100) = s.quotient_cents)
    )
    UPDATE scheduled_services t
       SET recurring_template_overrides = COALESCE(t.recurring_template_overrides, '{}'::jsonb)
             || jsonb_build_object('anchored_split_per_visit', q.per_visit)
      FROM q
     WHERE t.id = q.parent_id
  `);
  console.log(`[20260827000002] anchored-split provenance stamped ${stamped?.rowCount ?? '?'} pest parent(s)`);

  // SURFACE every still-Ongoing self-booked pest series the arithmetic
  // could not prove (rewritten draft, repriced/partial seed, missing annual):
  // those keep auto-extending off the remainder-bearing parent until a
  // human reconciles them. Row note + ONE admin bell listing them.
  const unproven = await knex('scheduled_services as p')
    .join('estimates as e', 'e.id', 'p.source_estimate_id')
    .whereNotNull('p.self_booking_id')
    .where('p.is_recurring', true)
    .where('p.recurring_ongoing', true)
    .whereNull('p.recurring_parent_id')
    .where('e.source', 'quote_wizard')
    .whereRaw("COALESCE(p.service_type, '') ~* '\\ypest\\y'")
    // Mirror the provenance CTE (codex r2 P2): structured-price parents
    // (primary_line_price) never renew off estimated_price, so they are
    // neither stampable nor exposed — no alert for them.
    .whereRaw('(p.primary_line_price IS NULL OR p.primary_line_price <= 0)')
    .whereRaw("(p.recurring_template_overrides IS NULL OR NOT jsonb_exists(p.recurring_template_overrides, 'anchored_split_per_visit'))")
    .select('p.id', 'p.customer_id', 'p.scheduled_date');
  if (unproven.length) {
    const ids = unproven.map((r) => r.id);
    await knex('scheduled_services')
      .whereIn('id', ids)
      .update({
        notes: knex.raw("COALESCE(notes, '') || ' — RENEWAL PRICE UNVERIFIED (2026-08-27 migration): this self-booked pest plan still auto-extends off the first visit''s remainder-bearing price; confirm the per-visit amount and set it via Edit appointment → apply to following'"),
      });
    if (await knex.schema.hasTable('notifications')) {
      await knex('notifications').insert({
        recipient_type: 'admin',
        recipient_id: null,
        category: 'billing',
        title: 'Self-booked pest plans need a renewal-price check',
        body: `${unproven.length} self-booked pest plan(s) could not be auto-verified for the renewal price fix (their quote was re-run or repriced since booking). Until reconciled they keep renewing at the first visit's remainder-bearing price. Open each series and confirm the per-visit amount via Edit appointment → apply to following.`,
        icon: null,
        link: '/admin/schedule',
        metadata: JSON.stringify({ dedupeKey: 'pest-renewal-price-unverified-20260827', scheduled_service_ids: ids, customer_ids: [...new Set(unproven.map((r) => String(r.customer_id)))] }),
      });
    }
  }
  console.log(`[20260827000002] renewal-price UNVERIFIED (surfaced for reconciliation): ${unproven.length} ongoing pest parent(s)`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'wizard_recovery_reconciled_at'))) return;
  await knex('scheduled_services')
    .whereRaw("notes LIKE '%marked reconciled by migration (recovery sweep now covers pest)%'")
    .update({ wizard_recovery_reconciled_at: null });
};
