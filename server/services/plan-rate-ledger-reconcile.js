/**
 * Nightly Σ(components) == scalar reconciler for the plan-rate ledger
 * (owner request 2026-08-13 — the "invariant/watch problem" email loop).
 *
 * While GATE_PLAN_RATE_LEDGER is on, customers.monthly_rate is the ledger
 * SUM and every scalar writer either derives the scalar from the ledger
 * (estimate accepts) or resets the ledger to match (admin edits, IB tools,
 * offboarding, plan-sync). A row that still diverges therefore came from
 * outside those paths — a pre-flip advisory-mode failure the backfill
 * didn't see, a manual DB edit, or an old deploy's write — and until it is
 * reconciled the customer bills a figure the attribution can't explain,
 * and the next same-family re-quote misprices against the wrong components.
 *
 * Repair semantics are EXACTLY the ops backfill's pre-seeded audit
 * (ops/agents/backfill-plan-rate-ledger.js): the SCALAR is authoritative
 * and never changed here — the customer's billed amount is the business
 * fact; the ledger is the attribution.
 * - Shortfall (scalar > Σ components): park the difference as an
 *   'unattributed' component (source 'invariant_repair'), summing into any
 *   existing unattributed row. The pre-ledger limitation degrading
 *   gracefully; the owner is told, and the next accept's review machinery
 *   covers the re-quote.
 * - Overshoot (Σ components > scalar): NEVER auto-deleted — shrinking
 *   someone's attribution is the owner's call (same ruling as the
 *   backfill). Alert only.
 * Either way the owner gets one bell per distinct divergence (forever-
 * deduped on customer + both cent figures, so a re-broken customer rings
 * again but a merely-unfixed one doesn't ring daily).
 *
 * Scope mirrors the watch and the backfill: live-stage customers
 * (active_customer/won/at_risk, not deleted) that HAVE ledger rows. A
 * rate-bearing customer with an EMPTY ledger is a designed state (admin
 * create, pre-backfill row) handled by the accept-time empty-ledger cases,
 * not an invariant break.
 *
 * Per-customer transaction with a customers FOR UPDATE row lock and a
 * re-check of both figures under the lock — a live accept serializes on the
 * same lock (estimate-converter takes it before applyAcceptToLedger), so
 * the reconciler can never park a "shortfall" computed from a snapshot an
 * in-flight accept was already replacing.
 *
 * Dark behind GATE_PLAN_RATE_LEDGER_RECONCILE, and inert unless
 * GATE_PLAN_RATE_LEDGER is also on (with the ledger advisory, divergence is
 * expected pre-flip data accumulation, not a defect).
 */

const db = require('../models/db');
const NotificationService = require('./notification-service');
const { UNATTRIBUTED } = require('./plan-rate-ledger');

const MAX_ALERTS_PER_RUN = 25;

const cents = (value) => Math.round((Number(value) || 0) * 100);

// Forever-dedupe on the notifications metadata dedupeKey — same contract as
// schedule-integrity-watchdog / call-booking-miss-watchdog.
async function alreadyAlerted(database, dedupeKey) {
  const existing = await database('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
    .first();
  return !!existing;
}

async function runPlanRateLedgerReconcile({ database = db } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('planRateLedgerReconcile')) return { skipped: true, reason: 'gated_off' };
  // Advisory ledger (authority gate off): divergence is expected pre-flip
  // accumulation — parking it would bake half-collected data into
  // components the flip then bills. Only reconcile under scalar authority.
  if (!isEnabled('planRateLedger')) return { skipped: true, reason: 'ledger_advisory' };
  if (!(await database.schema.hasTable('customer_plan_rates'))) {
    return { skipped: true, reason: 'no_table' };
  }

  // Candidate snapshot: live-stage customers with ledger rows whose
  // component sum differs from the scalar by ≥ 1 cent. Cent-exact — both
  // figures are currency precision, so any difference is a real
  // discrepancy the billing cron charges (same rule as the backfill).
  const candidates = await database('customers as c')
    .join('customer_plan_rates as r', 'r.customer_id', 'c.id')
    .whereIn('c.pipeline_stage', ['active_customer', 'won', 'at_risk'])
    .whereNull('c.deleted_at')
    .groupBy('c.id', 'c.monthly_rate', 'c.first_name', 'c.last_name')
    .havingRaw(
      'ROUND(COALESCE(SUM(r.monthly_rate), 0) * 100) <> ROUND(COALESCE(c.monthly_rate, 0) * 100)',
    )
    .select('c.id', 'c.first_name', 'c.last_name', 'c.monthly_rate')
    .sum({ component_sum: 'r.monthly_rate' });

  let repaired = 0;
  let overshoots = 0;
  let alerted = 0;
  for (const candidate of candidates) {
    const outcome = await database.transaction(async (trx) => {
      // Row lock + re-check under it: accepts, admin edits, and the ops
      // backfill all serialize on this same customers row lock, so both
      // figures re-read here are the post-commit truth.
      const locked = await trx('customers')
        .where({ id: candidate.id })
        .forUpdate()
        .first('id', 'monthly_rate', 'pipeline_stage', 'deleted_at');
      if (!locked || locked.deleted_at
        || !['active_customer', 'won', 'at_risk'].includes(locked.pipeline_stage)) {
        return null;
      }
      const components = await trx('customer_plan_rates')
        .where({ customer_id: candidate.id })
        .select('family_key', 'monthly_rate', 'source');
      if (!components.length) return null; // concurrent reset/offboarding
      const scalarCents = cents(locked.monthly_rate);
      const sumCents = components.reduce((total, row) => total + cents(row.monthly_rate), 0);
      if (sumCents === scalarCents) return null; // concurrent writer already reconciled
      const shortfallCents = scalarCents - sumCents;
      if (shortfallCents > 0) {
        const shortfall = shortfallCents / 100;
        await trx('customer_plan_rates')
          .insert({
            customer_id: candidate.id,
            family_key: UNATTRIBUTED,
            monthly_rate: shortfall,
            source: 'invariant_repair',
            effective_at: new Date(),
            updated_at: new Date(),
          })
          .onConflict(['customer_id', 'family_key'])
          .merge({
            monthly_rate: trx.raw('customer_plan_rates.monthly_rate + excluded.monthly_rate'),
            source: 'invariant_repair',
            effective_at: new Date(),
            updated_at: new Date(),
          });
        return { kind: 'repaired', scalarCents, sumCents, components };
      }
      // Overshoot — owner-only (deleting/shrinking a component is not this
      // job's call). Report with the component detail so the bell is
      // actionable without a DB session.
      return { kind: 'overshoot', scalarCents, sumCents, components };
    });
    if (!outcome) continue;

    if (outcome.kind === 'repaired') repaired += 1;
    else overshoots += 1;

    if (alerted >= MAX_ALERTS_PER_RUN) continue; // repair still ran; bell rings for the rest next tick
    const dedupeKey = `plan-rate-invariant:${candidate.id}:${outcome.scalarCents}:${outcome.sumCents}`;
    if (await alreadyAlerted(database, dedupeKey)) continue;
    const name = `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim() || 'Customer';
    const componentList = outcome.components
      .map((row) => `${row.family_key} $${(Number(row.monthly_rate) || 0).toFixed(2)} (${row.source})`)
      .join(', ');
    const scalarDollars = (outcome.scalarCents / 100).toFixed(2);
    const sumDollars = (outcome.sumCents / 100).toFixed(2);
    const title = outcome.kind === 'repaired'
      ? 'Plan-rate ledger repaired — verify attribution'
      : 'Plan-rate components exceed billed rate — needs a decision';
    const body = outcome.kind === 'repaired'
      ? `${name} bills $${scalarDollars}/mo but their plan components summed $${sumDollars} — a rate write bypassed the ledger. The $${((outcome.scalarCents - outcome.sumCents) / 100).toFixed(2)} gap was parked as 'unattributed' so billing and attribution agree again; split it into the right plan family when you know what it is. Components before repair: ${componentList}.`
      : `${name} bills $${scalarDollars}/mo but their plan components sum $${sumDollars} — the attribution claims MORE than is billed, so a component is stale or the rate was lowered without clearing the ledger. Nothing was auto-deleted; adjust the components or the rate. Components: ${componentList}.`;
    const created = await NotificationService.notifyAdmin('alert', title, body, {
      link: `/admin/customers?customerId=${candidate.id}`,
      bell: true,
      metadata: {
        dedupeKey,
        customerId: candidate.id,
        scalarCents: outcome.scalarCents,
        componentSumCents: outcome.sumCents,
        kind: outcome.kind,
      },
    });
    // The repair committed regardless, but a silently lost overshoot bell
    // means an unbilled-attribution defect nobody ever hears about — fail
    // the run loudly (same posture as schedule-integrity-watchdog).
    if (!created || (created.id == null && !created.suppressed)) {
      throw new Error(`[plan-rate-reconcile] notification insert failed for ${dedupeKey} — pager output lost`);
    }
    alerted += 1;
  }

  return {
    skipped: false, checked: candidates.length, repaired, overshoots, alerted,
  };
}

module.exports = { runPlanRateLedgerReconcile };
