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
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'wizard_recovery_reconciled_at'))) return;
  await knex('scheduled_services')
    .whereRaw("notes LIKE '%marked reconciled by migration (recovery sweep now covers pest)%'")
    .update({ wizard_recovery_reconciled_at: null });
};
