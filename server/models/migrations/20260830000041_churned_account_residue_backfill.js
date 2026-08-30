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

  // Churned-stage accounts still carrying live state. (The stale
  // recurring_ongoing-on-cancelled-row flag is cleared per wound-down
  // customer inside the loop below — NEVER globally: a recurring parent
  // cancelled with scope='this_only' keeps its flag intentionally so the
  // remaining series continues to extend; admin-dispatch.js leaves it
  // intact by design.)
  const hasPerAppFee = await knex.schema.hasColumn('customers', 'per_application_fee');
  const hasLedgerForPredicate = await knex.schema.hasTable('customer_plan_rates');
  // Same churned-or-inactive scope as the audit script, and EVERY billing
  // rail counts as residue — not just tier/rate: an armed retry or a still-
  // enabled payment method can charge an account with no tier at all, and
  // surviving plan-rate components can resurrect an old rate on win-back.
  const candidates = await knex('customers')
    .where(function churnedOrInactive() {
      this.where({ pipeline_stage: 'churned' }).orWhere('active', false);
    })
    .where(function orResidue() {
      this.where(function activeChurned() {
        this.where('active', true).where('pipeline_stage', 'churned');
      })
        .orWhereNotNull('waveguard_tier')
        .orWhereRaw('COALESCE(monthly_rate, 0) > 0')
        // Per-application residue: the lane stamp + fee remain the live
        // price for a straggler completion (customer-offboarding.js) even
        // when tier/rate are already clear.
        .orWhere('billing_mode', 'per_application')
        .orWhere('autopay_enabled', true)
        .orWhereNotNull('next_charge_date')
        .orWhereExists(function methodArmed() {
          this.select(knex.raw('1')).from('payment_methods')
            .whereRaw('payment_methods.customer_id = customers.id')
            .where('payment_methods.autopay_enabled', true);
        })
        .orWhereExists(function retryArmed() {
          this.select(knex.raw('1')).from('payments')
            .whereRaw('payments.customer_id = customers.id')
            .where('payments.status', 'failed')
            .whereNull('payments.superseded_by_payment_id')
            .whereNotNull('payments.next_retry_at');
        });
      if (hasLedgerForPredicate) {
        this.orWhereExists(function ledgerResidue() {
          this.select(knex.raw('1')).from('customer_plan_rates')
            .whereRaw('customer_plan_rates.customer_id = customers.id');
        });
      }
    })
    .select('id', 'active', 'waveguard_tier', 'monthly_rate', 'churn_mrr', 'billing_mode');

  const hasLedger = await knex.schema.hasTable('customer_plan_rates');
  const hasPrepayTerms = await knex.schema.hasTable('annual_prepay_terms');
  // ET calendar date for the prepay-coverage window (same rule as the visit
  // guard below).
  const [{ et_today: etToday }] = (await knex.raw("SELECT (now() AT TIME ZONE 'America/New_York')::date::text AS et_today")).rows;

  for (const customer of candidates) {
    // Guard + wind-down are ONE transaction per customer, with the row
    // locked FIRST and every guard re-run under the lock — a concurrent
    // booking/reactivation committing between check and write can never
    // leave a newly re-won customer wound down.
     
    await knex.transaction(async (trx) => {
      // LOCK ORDER matches the booking writers (customers row FIRST, then
      // scheduled_services): a booking transaction updates the customers
      // row before inserting the visit, so taking the table lock first
      // while a booking holds the row lock would deadlock. The customer
      // FOR UPDATE happens inside windDownIfStillResidue before this table
      // lock is requested — see acquireTableLock there.
      await windDownIfStillResidue(trx, customer.id, customer);
    }).catch((err) => {
      // A concurrent booking raced this account mid-wind-down: everything
      // rolled back; the audit script keeps reporting it. Anything else is
      // a real failure and must stop the migration.
      if (err && err.code === 'BACKFILL_CONCURRENT_LIVE_WORK') return;
      throw err;
    });
  }

  // Every "leave this account alone" signal in one place, run TWICE per
  // customer: before the wind-down, and again after its writes — the row
  // lock does not serialize scheduled_services/payments inserts, so under
  // READ COMMITTED the post-write re-read sees a booking that committed
  // mid-transaction, and throwing here rolls the whole wind-down back.
  async function hasLiveState(trx, customerId) {
    const [liveSeries, upcoming, inProgress, coveredTerm] = await Promise.all([
      trx('scheduled_services')
        .where({ customer_id: customerId, recurring_ongoing: true })
        .whereNot('status', 'cancelled')
        .first('id'),
      // ET calendar date, not UTC (AGENTS.md America/New_York rule): after
      // 8 PM ET a UTC "today" is tomorrow and would skip a same-day visit.
      // 'rescheduled' rows keep their ORIGINAL (often past) date while
      // remaining live rebook intents — date-exempt as in the eligibility gate.
      trx('scheduled_services')
        .where({ customer_id: customerId })
        .whereIn('status', ['pending', 'confirmed', 'scheduled', 'rescheduled'])
        .where(function dateOrRescheduled() {
          this.whereRaw("scheduled_date >= (now() AT TIME ZONE 'America/New_York')::date")
            .orWhere('status', 'rescheduled');
        })
        .first('id'),
      // A tech actively working the property (any date) is live state too.
      trx('scheduled_services')
        .where({ customer_id: customerId })
        .where(function liveWork() {
          this.whereIn('status', ['en_route', 'on_site'])
            .orWhereIn('track_state', ['en_route', 'on_property']);
        })
        .first('id'),
      // Live annual-prepay coverage (deliberately status-blind: ANY covering
      // term keeps the account out — over-skipping is safe, the audit script
      // keeps reporting it).
      hasPrepayTerms
        ? trx('annual_prepay_terms')
          .where({ customer_id: customerId })
          .where('term_start', '<=', etToday)
          .where('term_end', '>=', etToday)
          .first('id')
        : Promise.resolve(null),
    ]);
    return !!(liveSeries || upcoming || inProgress || coveredTerm);
  }

  async function windDownIfStillResidue(trx, customerId, candidate) {
    // Lock and RE-FETCH — the candidate snapshot is stale by now; an admin
    // reactivation or reprice committed before this lock must win.
    const customer = await trx('customers')
      .where({ id: customerId })
      .forUpdate()
      .first('id', 'active', 'pipeline_stage', 'waveguard_tier', 'monthly_rate', 'churn_mrr', 'billing_mode');
    if (!customer) return;
    if (!(customer.pipeline_stage === 'churned' || customer.active === false)) return; // re-won — leave alone
    // A reprice committed between candidate selection and this lock wins:
    // any change to tier/rate/lane since the snapshot means an operator
    // touched the account — leave it to the audit script.
    if (
      String(customer.waveguard_tier || '') !== String(candidate.waveguard_tier || '')
      || Math.round((Number(customer.monthly_rate) || 0) * 100) !== Math.round((Number(candidate.monthly_rate) || 0) * 100)
      || String(customer.billing_mode || '') !== String(candidate.billing_mode || '')
    ) return;
    // Table lock AFTER the customer row lock (booking writers take the
    // customers row first, then insert the visit — same order avoids
    // deadlock). SHARE ROW EXCLUSIVE blocks every scheduled_services
    // writer for the tiny duration of this transaction, which is what
    // actually closes the concurrent-booking race; the pre/post read
    // guards remain as cheap belt-and-suspenders.
    await trx.raw('LOCK TABLE scheduled_services IN SHARE ROW EXCLUSIVE MODE');
    if (await hasLiveState(trx, customer.id)) return; // possibly a mistaken stage-flip — leave for the audit script
    const update = {
      active: false,
      autopay_enabled: false,
      next_charge_date: null,
      waveguard_tier: null,
      monthly_rate: null,
      updated_at: trx.fn.now(),
    };
    if ((await trx.schema.hasColumn('customers', 'waveguard_tier_source'))) update.waveguard_tier_source = null;
    if (customer.churn_mrr == null && Number(customer.monthly_rate) > 0) update.churn_mrr = customer.monthly_rate;
    let laneCleared = false;
    let laneRetainedForUninvoiced = false;
    if (customer.billing_mode === 'per_application') {
      // Same guard as the processor's lane wind-down: a COMPLETED but
      // uninvoiced application is priced from these fields by billing
      // recovery — keep them (the account stays in the audit script) until
      // the office settles the visit.
      const completedUninvoiced = await trx('scheduled_services as s')
        .where('s.customer_id', customer.id)
        .where('s.status', 'completed')
        .whereNotExists(function invoiced() {
          this.select(1).from('invoices').whereRaw('invoices.scheduled_service_id = s.id');
        })
        .first('s.id');
      if (!completedUninvoiced) {
        update.billing_mode = null;
        if (hasPerAppFee) update.per_application_fee = null;
        laneCleared = true;
      } else {
        laneRetainedForUninvoiced = true;
      }
    }
    await trx('customers').where({ id: customer.id }).update(update);
    // Stale series flag, scoped to THIS wound-down account only: with no
    // live series and no upcoming/in-progress work (guards above), a
    // cancelled row's recurring_ongoing=true is pure residue that could
    // still confuse series-extension sweeps.
    await trx('scheduled_services')
      .where({ customer_id: customer.id, status: 'cancelled', recurring_ongoing: true })
      .update({ recurring_ongoing: false, updated_at: trx.fn.now() });
    // Independent charge rails (mirrors cancellation-processor): Stripe picks
    // a method by payment_methods.autopay_enabled ALONE, and the failed-
    // payment retry ladder never checks active/churn — disarm both.
    await trx('payment_methods')
      .where({ customer_id: customer.id })
      .update({ autopay_enabled: false });
    await trx('payments')
      .where({ customer_id: customer.id, status: 'failed' })
      .whereNull('superseded_by_payment_id')
      .whereNotNull('next_retry_at')
      .update({ next_retry_at: null });
    if (hasLedger) await trx('customer_plan_rates').where({ customer_id: customer.id }).del();

    await trx('customer_interactions').insert({
      customer_id: customer.id,
      interaction_type: 'note',
      subject: 'Churn residue backfill (2026-08-30)',
      body:
        `One-off cleanup with the cancellation engine ship: account was ${customer.pipeline_stage === 'churned' ? 'pipeline_stage=churned' : `inactive (stage ${customer.pipeline_stage || 'unset'})`} but still carried ` +
        `${customer.active ? 'active=true' : ''}${customer.active && (customer.waveguard_tier || Number(customer.monthly_rate) > 0) ? ' and ' : ''}` +
        `${customer.waveguard_tier ? `tier ${customer.waveguard_tier}` : ''}${customer.waveguard_tier && Number(customer.monthly_rate) > 0 ? ' / ' : ''}` +
        `${Number(customer.monthly_rate) > 0 ? `rate $${Number(customer.monthly_rate).toFixed(2)}` : ''}` +
        `${laneCleared ? ' (per-application lane + fee cleared)' : ''}` +
        `${laneRetainedForUninvoiced ? ' (per-application lane + fee RETAINED — a completed visit is not yet invoiced; office settles it, then clears the lane)' : ''}` +
        '. Deactivated, cleared tier/rate/plan-rate components, autopay off. No upcoming or in-progress work was live; no customer contact.',
    });

    // Post-write re-check: a booking committed mid-transaction (customer
    // row locks do not serialize service inserts) makes this wind-down
    // wrong — roll the whole per-customer transaction back and leave the
    // account for the audit script.
    if (await hasLiveState(trx, customer.id)) {
      const raceErr = new Error('BACKFILL_CONCURRENT_LIVE_WORK');
      raceErr.code = 'BACKFILL_CONCURRENT_LIVE_WORK';
      throw raceErr;
    }
  }
};

exports.down = async function down() {
  // Data fix — nothing to restore; re-run the audit script to verify state.
};
