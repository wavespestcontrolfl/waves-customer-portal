'use strict';

/**
 * Cancel-flow C1 — the SERVER-computed before/after facts for screen 1.
 *
 * The portal deliberately renders no client-computed dollars (static-catalog
 * "savings" math was removed for lying); every number on the impact screen
 * comes from here, derived from the same authorities the processor uses:
 * planScopedWindDown (ledger components + live tier discounts) for the money
 * table, the eligibility sweep for visit counts, open-balance for what is
 * owed, coveredTermsAsOf for prepay. Nulls mean "not applicable / unknown" —
 * the UI omits the row rather than guessing.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');
const { CANCELLABLE_STATUSES, LIVE_TRACK_STATES } = require('../cancellation-eligibility');
const { familyLabel } = require('./templates');

const labelOf = (key) => familyLabel(key) || String(key || '').replace(/_/g, ' ');

async function buildCancellationImpact(customerId, requestedFamilies = [], { after = null, keepVisitIds = null, keepScoped = false } = {}) {
  const { planScopedWindDown, familyOfServiceRow } = require('../cancellation-processor');
  const { inferTierFromServiceCount } = require('../self-booking-plan-sync');

  const customer = await db('customers').where({ id: customerId })
    .first('waveguard_tier', 'monthly_rate', 'billing_mode', 'per_application_fee', 'autopay_enabled', 'next_charge_date', 'termite_stations_rented');
  if (!customer) return null;

  const today = etDateString();
  const rows = await db('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .where('s.customer_id', customerId)
    .where(function liveOrRecurring() {
      this.where('s.recurring_ongoing', true)
        .orWhere(function upcoming() {
          this.whereIn('s.status', CANCELLABLE_STATUSES)
            .where(function dateOrRescheduled() {
              this.where('s.scheduled_date', '>=', today).orWhere('s.status', 'rescheduled');
            });
        });
    })
    .select('s.*', 'sv.service_key', 'sv.name as service_name');

  // Coverage identity for the keep-through exemption — the LIVE term's
  // canonical covered rows (keepVisitIds, from coverageRowsForTerm), exactly
  // like the processor's sweep. A stamp/term-id classifier is NOT coverage:
  // a refunded prior term keeps its audit link with the stamps cleared.
  const keepIds = after && Array.isArray(keepVisitIds) ? new Set(keepVisitIds.map(String)) : null;
  const perFamily = new Map();
  // Rows with no WaveGuard family (commercial, rodent-led, unmatched text)
  // have no bucket in the money table, but a WHOLE-account sweep still
  // pulls them — their identities must reach the pulled count and the
  // approved-facts fingerprint or Confirm removes appointments the preview
  // never showed (and an unclassified visit appearing mid-window could not
  // trigger preview_changed).
  const unclassified = { upcoming: 0, pulled: 0, nextVisitDate: null, nextPulledDate: null, pulledKeys: [] };
  for (const row of rows) {
    const family = familyOfServiceRow(row);
    let slot = unclassified;
    if (family) {
      if (!perFamily.has(family)) perFamily.set(family, { upcoming: 0, pulled: 0, nextVisitDate: null, nextPulledDate: null, pulledKeys: [] });
      slot = perFamily.get(family);
    }
    const d = String(row.scheduled_date).slice(0, 10);
    const upcoming = CANCELLABLE_STATUSES.includes(String(row.status)) && (d >= today || row.status === 'rescheduled');
    if (upcoming) {
      slot.upcoming += 1;
      if (!slot.nextVisitDate || d < slot.nextVisitDate) slot.nextVisitDate = d;
      // Keep-through boundary (C3 end-of-coverage): only the LIVE term's
      // covered rows (keepIds — same set the processor keeps) are KEPT
      // through the boundary; a mixed account's uncovered rows and a dead
      // refunded term's audit-linked rows are pulled now. An
      // undated/rescheduled row has no date to keep.
      const covered = !!keepIds && keepIds.has(String(row.id));
      const kept = after && covered && row.status !== 'rescheduled' && d <= String(after);
      // Live/done on the track layer: the processor's sweep excludes rows
      // whose track_state is complete / en_route / on_property (null-safe —
      // legacy rows have no track_state) and parks them for manual review,
      // so "visits pulled" must not count them either.
      const trackExcluded = row.track_state != null
        && (row.track_state === 'complete' || LIVE_TRACK_STATES.includes(row.track_state));
      if (!kept && !trackExcluded) {
        slot.pulled += 1;
        if (!slot.nextPulledDate || d < slot.nextPulledDate) slot.nextPulledDate = d;
        // Stable identity for the approved-facts fingerprint: a reschedule
        // (same count, different date) must still read as changed facts.
        slot.pulledKeys.push(`${row.id}:${d}`);
      }
    }
  }
  const owned = [...perFamily.keys()];

  // Money table: the wind-down PLAN is the single authority (never applied
  // here). For a whole-account selection there is nothing remaining to
  // reprice — tierAfter is null and the totals go to zero.
  const scope = (requestedFamilies || []).filter((f) => owned.includes(f));
  // keepScoped (admin repair retries): a scoped cancellation whose accepted
  // family already lost every live row must stay SCOPED — an empty owned
  // intersection means "nothing left to pull for that family", not a
  // whole-account cancel of whatever remains (which would preview and
  // fingerprint the OTHER family's visits and a tier drop to zero that the
  // repair-only processor never performs).
  const wholeAccount = keepScoped ? false : (!scope.length || scope.length === owned.length);
  let plan = null;
  if (!wholeAccount && scope.length) {
    try {
      plan = await planScopedWindDown(customerId, scope);
      if (!plan.ok) plan = null;
    } catch (err) {
      logger.warn(`[cancel-impact] wind-down plan failed for ${customerId}: ${err.message}`);
      plan = null;
    }
  }

  const { loadComponents } = require('../plan-rate-ledger');
  let components = [];
  try { components = await loadComponents(db, customerId); } catch (err) { components = []; }
  const rateOf = (family) => {
    const row = components.find((c) => c.family_key === family);
    return row ? Number(row.monthly_rate) : null;
  };

  // The ONE remainder-aware balance authority (codex r2 P1: summing
  // invoice face values ignored credit_applied).
  let openBalance = null;
  try {
    const { openBalanceSummary } = require('../open-balance');
    const summary = await openBalanceSummary(customerId);
    openBalance = summary && Number.isFinite(Number(summary.total)) ? Number(summary.total) : null;
  } catch (err) { openBalance = null; }

  // Live annual-prepay term: real columns only (term_end, plan_label,
  // monthly_rate); the remaining-visit count is not stored on the term, so
  // it is honestly null rather than an invented number (codex r2 P1).
  let prepay = null;
  try {
    const { coveredTermsAsOf } = require('../annual-prepay-renewals');
    const term = await coveredTermsAsOf(db, today).where('t.customer_id', customerId).first('t.id', 't.term_end', 't.plan_label', 't.prepay_amount');
    if (term) {
      prepay = {
        covered: true,
        endsAt: term.term_end ? String(term.term_end).slice(0, 10) : null,
        planLabel: term.plan_label || null,
        prepaidAmount: term.prepay_amount == null ? null : Number(term.prepay_amount),
        visitsRemaining: null,
      };
    }
  } catch (err) {
    logger.warn(`[cancel-impact] prepay term lookup failed for ${customerId}: ${err.message}`);
    prepay = null;
  }

  const cancelledFamilies = wholeAccount ? owned : scope;
  const visitsCancelled = cancelledFamilies.reduce((sum, f) => sum + (perFamily.get(f)?.pulled || 0), 0)
    + (wholeAccount ? unclassified.pulled : 0);
  const nextVisitCancelled = [
    ...cancelledFamilies.map((f) => perFamily.get(f)?.nextPulledDate),
    ...(wholeAccount ? [unclassified.nextPulledDate] : []),
  ].filter(Boolean).sort()[0] || null;
  // Stable identities of the visits this cancel pulls (id:date, sorted) —
  // the approved-facts fingerprint keys on them so a reschedule or a
  // complete-and-appear swap never slips past an unchanged count.
  const pulledVisitKeys = [
    ...cancelledFamilies.flatMap((f) => perFamily.get(f)?.pulledKeys || []),
    ...(wholeAccount ? unclassified.pulledKeys : []),
  ].sort();

  const tierBefore = customer.waveguard_tier || inferTierFromServiceCount(owned.length);
  const monthly = customer.monthly_rate == null ? null : Number(customer.monthly_rate);

  // The processor raises the retrieval task only when ITS OWN predicate
  // finds rental state (active Waves-owned termite stations, or the
  // customer flag when none are mapped) — so the preview asks the same
  // question: family scope alone promises tasks that never come, and the
  // stale customer flag alone hides one that will (mapped stations on a
  // whole-account cancel). Unverifiable falls back to the flag/family
  // heuristic rather than dropping the warning.
  let termiteRental = false;
  if (wholeAccount || cancelledFamilies.includes('termite_bait')) {
    try {
      const { rentedTermiteStationState } = require('../cancellation-processor');
      const rental = await rentedTermiteStationState(customerId);
      termiteRental = rental.rented.length > 0 || rental.flaggedRental === true;
    } catch (err) {
      logger.warn(`[cancel-impact] rental-state lookup failed for ${customerId}: ${err.message}`);
      termiteRental = customer.termite_stations_rented === true || cancelledFamilies.includes('termite_bait');
    }
  }

  return {
    families: owned.map((f) => ({
      key: f,
      label: labelOf(f),
      monthlyRate: rateOf(f),
      perAppRate: null,
      upcomingVisits: perFamily.get(f)?.upcoming || 0,
      nextVisitDate: perFamily.get(f)?.nextVisitDate || null,
      prepay: !!prepay,
    })),
    tierBefore,
    tierAfter: wholeAccount ? null : (plan ? plan.tierAfter : null),
    // Percentage POINTS — the client renders `${n}% off` (codex r2 P2).
    tierDiscountBefore: plan ? Math.round(plan.discountBefore * 100) : null,
    tierDiscountAfter: wholeAccount ? null : (plan ? Math.round(plan.discountAfter * 100) : null),
    accountMonthlyBefore: monthly,
    accountMonthlyAfter: wholeAccount ? (monthly == null ? null : 0) : (plan ? plan.scalarAfter : null),
    remaining: wholeAccount ? [] : (plan ? plan.remainingRates.map((r) => ({ key: r.family, label: labelOf(r.family), monthlyBefore: r.before, monthlyAfter: r.after })) : []),
    // Per-application lane (scoped): the wind-down repricess every surviving
    // uninvoiced visit — real customer charge changes the operator must see
    // and approve (they ride the fingerprint like every displayed number).
    perAppChanges: !wholeAccount && plan && Array.isArray(plan.perAppRows)
      ? plan.perAppRows.map((r) => ({ id: r.id, family: r.family, label: labelOf(r.family), before: r.before, after: r.after }))
      : [],
    visitsCancelled,
    nextVisitCancelled,
    pulledVisitKeys,
    lateCancelFee: null,
    openBalance,
    payUrl: null,
    prepay,
    autopayOn: customer.autopay_enabled === true,
    termiteRental,
    effectiveDate: today,
    billingMode: customer.billing_mode || null,
    wholeAccount,
    // Scoped-cancel feasibility for the picker: when a partial selection
    // cannot be priced the UI disables per-service and says why.
    scopedSupported: wholeAccount ? null : !!plan,
  };
}

module.exports = { buildCancellationImpact };
