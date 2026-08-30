'use strict';

/**
 * Churned-account residue backfill (owner-approved 2026-08-30, rides PR E).
 *
 * The 2026-08-30 prod audit (server/scripts/audit-churned-accounts-live-state.js)
 * found 18 churned/inactive accounts of which 5 carry stale live state: the
 * admin stage-flip path never deactivated (pipeline_stage='churned' but
 * active=true), tiers/rates linger (money leak: a partial win-back keeps the
 * old discount forever), and recurring_ongoing=true survives on CANCELLED
 * rows. $0 was moving (autopay off everywhere) — this is state hygiene, not
 * billing repair.
 *
 * Guarded: a churned-stage account is only wound down when it has NO
 * upcoming cancellable visit and NO live (non-cancelled) ongoing series —
 * an account an admin stage-flipped by mistake while service continues is
 * left alone and keeps showing up in the audit script instead.
 *
 * churn_mrr is snapshotted before the rate is cleared when the stamp is
 * missing (admin stage-flips never wrote it), so churn reporting keeps its
 * dollars. Rows changed get an audit note on the customer timeline.
 * No customer comms. Down = no-op (data fix; the audit script is the check).
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customers'))) return;

  // 1. Stale flag first, everywhere it is unambiguous: recurring_ongoing on a
  // CANCELLED row never dispatches but can confuse series-extension sweeps.
  await knex('scheduled_services')
    .where({ status: 'cancelled', recurring_ongoing: true })
    .update({ recurring_ongoing: false, updated_at: knex.fn.now() });

  // 2. Churned-stage accounts still carrying live state.
  const hasPerAppFee = await knex.schema.hasColumn('customers', 'per_application_fee');
  const candidates = await knex('customers')
    .where({ pipeline_stage: 'churned' })
    .where(function orResidue() {
      this.where('active', true)
        .orWhereNotNull('waveguard_tier')
        .orWhereRaw('COALESCE(monthly_rate, 0) > 0')
        // Per-application residue: the lane stamp + fee remain the live
        // price for a straggler completion (customer-offboarding.js) even
        // when tier/rate are already clear.
        .orWhere('billing_mode', 'per_application');
    })
    .select('id', 'active', 'waveguard_tier', 'monthly_rate', 'churn_mrr', 'billing_mode');

  const hasLedger = await knex.schema.hasTable('customer_plan_rates');
  const hasPrepayTerms = await knex.schema.hasTable('annual_prepay_terms');
  // ET calendar date for the prepay-coverage window (same rule as the visit
  // guard below).
  const [{ et_today: etToday }] = (await knex.raw("SELECT (now() AT TIME ZONE 'America/New_York')::date::text AS et_today")).rows;

  for (const customer of candidates) {
    const [liveSeries, upcoming, inProgress, coveredTerm] = await Promise.all([
      knex('scheduled_services')
        .where({ customer_id: customer.id, recurring_ongoing: true })
        .whereNot('status', 'cancelled')
        .first('id'),
      // ET calendar date, not UTC (AGENTS.md America/New_York rule): after
      // 8 PM ET a UTC "today" is tomorrow and would skip a same-day visit.
      knex('scheduled_services')
        .where({ customer_id: customer.id })
        .whereIn('status', ['pending', 'confirmed', 'scheduled', 'rescheduled'])
        .where(function dateOrRescheduled() {
          // 'rescheduled' rows keep their ORIGINAL (often past) date while
          // remaining live rebook intents (cancellation-eligibility.js) —
          // they are date-exempt here exactly as in the eligibility gate.
          this.whereRaw("scheduled_date >= (now() AT TIME ZONE 'America/New_York')::date")
            .orWhere('status', 'rescheduled');
        })
        .first('id'),
      // A tech actively working the property (any date) is live state too.
      knex('scheduled_services')
        .where({ customer_id: customer.id })
        .where(function liveWork() {
          this.whereIn('status', ['en_route', 'on_site'])
            .orWhereIn('track_state', ['en_route', 'on_property']);
        })
        .first('id'),
      // Live annual-prepay coverage (deliberately status-blind: ANY term
      // whose window covers today keeps the account out of this wind-down —
      // over-skipping is safe, the audit script keeps reporting it; the
      // opposite mistake deactivates a customer with paid coverage).
      hasPrepayTerms
        ? knex('annual_prepay_terms')
          .where({ customer_id: customer.id })
          .where('term_start', '<=', etToday)
          .where('term_end', '>=', etToday)
          .first('id')
        : Promise.resolve(null),
    ]);
    if (liveSeries || upcoming || inProgress || coveredTerm) continue; // possibly a mistaken stage-flip — leave for the audit script

    const update = {
      active: false,
      autopay_enabled: false,
      next_charge_date: null,
      waveguard_tier: null,
      monthly_rate: null,
      updated_at: knex.fn.now(),
    };
    if ((await knex.schema.hasColumn('customers', 'waveguard_tier_source'))) update.waveguard_tier_source = null;
    if (customer.churn_mrr == null && Number(customer.monthly_rate) > 0) update.churn_mrr = customer.monthly_rate;
    if (customer.billing_mode === 'per_application') {
      update.billing_mode = null;
      if (hasPerAppFee) update.per_application_fee = null;
    }
    await knex('customers').where({ id: customer.id }).update(update);
    // Independent charge rails (mirrors cancellation-processor): Stripe picks
    // a method by payment_methods.autopay_enabled ALONE, and the failed-
    // payment retry ladder never checks active/churn — disarm both.
    await knex('payment_methods')
      .where({ customer_id: customer.id })
      .update({ autopay_enabled: false });
    await knex('payments')
      .where({ customer_id: customer.id, status: 'failed' })
      .whereNull('superseded_by_payment_id')
      .whereNotNull('next_retry_at')
      .update({ next_retry_at: null });
    if (hasLedger) await knex('customer_plan_rates').where({ customer_id: customer.id }).del();

    await knex('customer_interactions').insert({
      customer_id: customer.id,
      interaction_type: 'note',
      subject: 'Churn residue backfill (2026-08-30)',
      body:
        'One-off cleanup with the cancellation engine ship: account was pipeline_stage=churned but still carried ' +
        `${customer.active ? 'active=true' : ''}${customer.active && (customer.waveguard_tier || Number(customer.monthly_rate) > 0) ? ' and ' : ''}` +
        `${customer.waveguard_tier ? `tier ${customer.waveguard_tier}` : ''}${customer.waveguard_tier && Number(customer.monthly_rate) > 0 ? ' / ' : ''}` +
        `${Number(customer.monthly_rate) > 0 ? `rate $${Number(customer.monthly_rate).toFixed(2)}` : ''}` +
        `${customer.billing_mode === 'per_application' ? ' (per-application lane + fee cleared)' : ''}` +
        '. Deactivated, cleared tier/rate/plan-rate components, autopay off. No visits or billing were live; no customer contact.',
    }).catch(() => {});
  }
};

exports.down = async function down() {
  // Data fix — nothing to restore; re-run the audit script to verify state.
};
