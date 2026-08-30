'use strict';

/**
 * Retention offer — the ONE money rail in the cancel flow (owner ruling
 * 2026-08-30): 15% off the next 2 charges of the service being cancelled,
 * $75 cap total, applied as its own line AFTER the WaveGuard tier discount,
 * once per customer per 18 months. Reasons that may reach it: price, diy.
 *
 * Eligibility is HARD FACTS ONLY (owner ruling 2026-08-29: the churn/risk
 * signal is broken and nothing may key on it). The predicate is pure so the
 * resolver and the tests share one definition; the ledger writes live below.
 */

const db = require('../../models/db');
const { etDateString } = require('../../utils/datetime-et');
const { RETENTION_OFFER } = require('./templates');

const OFFER_REASONS = Object.freeze(['price', 'diy']);
// Families the percentage may apply to. Termite bait (rented equipment),
// WDO and one-time work are excluded by ruling; unattributed never qualifies.
const OFFER_FAMILIES = Object.freeze(['pest_control', 'lawn_care', 'tree_shrub', 'mosquito']);
const MIN_TENURE_DAYS = 365;
const MIN_PAID_VISITS = 4;
const COOLDOWN_MONTHS = 18;
const OFFER_TTL_DAYS = 365;

// True 18-calendar-month boundary as an ET calendar DATE string
// ('YYYY-MM-DD'). Two traps handled here: setMonth overflows at month ends
// (Aug 31 minus 18 months would land on Mar 03 and let a Mar 01 offer
// through early), and Railway runs in UTC, so local Date getters shift the
// boundary by a day around the ET evening rollover — the calendar
// components come from etDateString instead (AGENTS.md America/New_York
// rule). Comparisons happen on ET dates, never on raw instants.
function etMonthsAgoFloor(now = new Date(), months = COOLDOWN_MONTHS) {
  const [y, m, d] = etDateString(now).split('-').map(Number);
  let ty = y;
  let tm = m - months;
  while (tm < 1) { tm += 12; ty -= 1; }
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate(); // day 0 of next month
  const td = Math.min(d, lastDay);
  return `${ty}-${String(tm).padStart(2, '0')}-${String(td).padStart(2, '0')}`;
}

function cooldownFloor(now = new Date()) {
  return etMonthsAgoFloor(now, COOLDOWN_MONTHS);
}

/**
 * Pure eligibility verdict. `facts` is the shape facts.js produces.
 * Returns { eligible, familyKey, blockers[] } — blockers name every failed
 * rule so the case row can record WHY no money card was shown.
 */
function offerEligibility(facts, { reasonCode, families = [], now = new Date() } = {}) {
  const blockers = [];
  if (!OFFER_REASONS.includes(reasonCode)) blockers.push('reason_not_money_eligible');
  const scope = families.length ? families : (facts.families || []);
  const familyKey = OFFER_FAMILIES.find((f) => scope.includes(f)) || null;
  if (!familyKey) blockers.push('no_eligible_family');
  if (!(facts.tenureDays >= MIN_TENURE_DAYS)) blockers.push('tenure_under_12_months');
  if (!(facts.completedPaidVisits >= MIN_PAID_VISITS)) blockers.push('under_4_paid_visits');
  if (facts.accountCurrent !== true) blockers.push('account_not_current');
  if (facts.openComplaint) blockers.push('open_complaint');
  if (facts.openCallbackLanes && facts.openCallbackLanes.length) blockers.push('open_callback');
  if (facts.prepay) blockers.push('annual_prepay');
  // Exact lane membership — NULL/unclassified (the legacy cohort) fails
  // closed: money never rides a lane we cannot prove is recurring.
  if (facts.billingMode !== 'monthly_membership' && facts.billingMode !== 'per_application') {
    blockers.push('billing_lane_not_recurring');
  }
  const floor = cooldownFloor(now);
  if (facts.priorRetentionOfferAt) {
    const at = new Date(facts.priorRetentionOfferAt);
    if (!Number.isNaN(at.getTime()) && etDateString(at) > floor) blockers.push('offer_within_18_months');
  }
  if (facts.manualPriceOverrideAt) {
    const at = new Date(facts.manualPriceOverrideAt);
    if (!Number.isNaN(at.getTime()) && etDateString(at) > floor) blockers.push('manual_override_within_18_months');
  }
  return { eligible: blockers.length === 0, familyKey, blockers };
}

/**
 * Grant = one retention_offers row. Idempotent per case: a second grant for
 * the same cancellation case returns the existing row. Caller passes a trx
 * when the grant is part of a larger commit.
 */
async function grantRetentionOffer({ customerId, cancellationCaseId, familyKey, reasonCode }, dbh = db) {
  if (!customerId || !familyKey) throw new Error('grantRetentionOffer requires customerId and familyKey');
  if (!OFFER_FAMILIES.includes(familyKey)) {
    const err = new Error('retention_offer_family_excluded');
    err.code = 'retention_offer_family_excluded';
    throw err;
  }
  const run = async (trx) => {
    // Per-customer advisory lock: two concurrent cancel commits for the same
    // customer serialize here, so the once-per-18-months rule holds even
    // when both passed the facts-level cooldown check.
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?::text))', [String(customerId)]);
    if (cancellationCaseId) {
      const existing = await trx('retention_offers').where({ cancellation_case_id: cancellationCaseId }).first();
      if (existing) return existing;
    }
    // Re-derive FULL eligibility from fresh facts under the advisory lock —
    // the preview verdict is stale by commit time and callers are never
    // trusted with money (tenure, paid visits, balance, complaints,
    // callbacks, lane, family can all have changed).
    const { loadCancellationFacts } = require('./facts');
    const facts = await loadCancellationFacts(customerId, { dbh: trx });
    const verdict = facts ? offerEligibility(facts, { reasonCode, families: [familyKey] }) : { eligible: false, blockers: ['no_facts'] };
    if (!verdict.eligible || verdict.familyKey !== familyKey) {
      const err = new Error('retention_offer_ineligible');
      err.code = 'retention_offer_ineligible';
      err.blockers = verdict.blockers;
      throw err;
    }
    const now = new Date();
    const floor = cooldownFloor(now);
    const recent = await trx('retention_offers')
      .where({ customer_id: customerId })
      .whereRaw("(granted_at AT TIME ZONE 'America/New_York')::date > ?", [floor])
      .first('id', 'granted_at');
    if (recent) {
      const err = new Error('retention_offer_cooldown');
      err.code = 'retention_offer_cooldown';
      err.existingOfferId = recent.id;
      throw err;
    }
    // Manual-override cooldown re-enforced at the money boundary, from the
    // durable audit trail (facts are advisory; this check is authoritative).
    const { MANUAL_RATE_AUDIT_ACTION } = require('../plan-rate-ledger');
    const manual = await trx('audit_log')
      .where({ action: MANUAL_RATE_AUDIT_ACTION, resource_type: 'customer', resource_id: customerId })
      .whereRaw("(created_at AT TIME ZONE 'America/New_York')::date > ?", [floor])
      .first('id');
    if (manual) {
      const err = new Error('manual_override_cooldown');
      err.code = 'manual_override_cooldown';
      throw err;
    }
    const [row] = await trx('retention_offers')
      .insert({
        customer_id: customerId,
        cancellation_case_id: cancellationCaseId || null,
        family_key: familyKey,
        percent_off: RETENTION_OFFER.percentOff,
        max_charges: RETENTION_OFFER.charges,
        cap_amount: RETENTION_OFFER.capAmount,
        status: 'granted',
        granted_at: now,
        expires_at: new Date(now.getTime() + OFFER_TTL_DAYS * 86400000),
      })
      .returning('*');
    return row;
  };
  // pg_advisory_xact_lock needs a transaction; reuse the caller's when given.
  return dbh.isTransaction ? run(dbh) : dbh.transaction(run);
}

/**
 * Pure: given an open offer row and the eligible recurring subtotal of ONE
 * invoice (after the tier discount), return the discount line to append and
 * the ledger delta — or null when nothing applies. The cap is on the TOTAL
 * across the offer's charges, so the last charge may be partial.
 */
function retentionDiscountForInvoice(offer, eligibleSubtotal, { now = new Date() } = {}) {
  if (!offer || offer.status !== 'granted') return null;
  if (offer.expires_at && new Date(offer.expires_at).getTime() <= now.getTime()) return null;
  const applied = Number(offer.charges_applied) || 0;
  if (applied >= Number(offer.max_charges)) return null;
  const subtotal = Number(eligibleSubtotal);
  if (!(subtotal > 0)) return null;
  // Money math in INTEGER CENTS (repo discipline — see stripe-pricing.js):
  // rounding after binary float multiplication drops cents (15% of $1.50
  // computed as floats is 0.22499999... → $0.22 instead of $0.23).
  const subtotalCents = Math.round(subtotal * 100);
  const capLeftCents = Math.round(Number(offer.cap_amount) * 100) - Math.round((Number(offer.amount_applied) || 0) * 100);
  if (!(capLeftCents > 0)) return null;
  const rawCents = Math.round((subtotalCents * Number(offer.percent_off)) / 100);
  const amountCents = Math.min(rawCents, capLeftCents);
  if (!(amountCents > 0)) return null;
  const amount = amountCents / 100;
  return {
    amount,
    lineItem: {
      description: `Stay offer — ${Number(offer.percent_off)}% off (${applied + 1} of ${Number(offer.max_charges)})`,
      quantity: 1,
      unit_price: -amount,
      amount: -amount,
      category: 'retention_offer',
    },
    exhaustsOffer: applied + 1 >= Number(offer.max_charges) || capLeftCents - amountCents <= 0,
  };
}

/**
 * Record one application against the offer. Runs inside the caller's trx;
 * guarded so two invoices minted in a race can never both take the same
 * charge slot (UPDATE ... WHERE charges_applied = expected).
 */
async function consumeRetentionOffer({ offerId, expectedChargesApplied, amount, invoiceId, exhaustsOffer }, dbh = db) {
  const updated = await dbh('retention_offers')
    .where({ id: offerId, status: 'granted', charges_applied: expectedChargesApplied })
    .where(function notExpired() {
      this.whereNull('expires_at').orWhere('expires_at', '>', new Date());
    })
    // Idempotent per invoice: a retry that reloads the offer and passes the
    // next expectedChargesApplied must not take a second slot for the same
    // invoice (double discount).
    .whereRaw("NOT (COALESCE(applied_invoice_ids, '[]'::jsonb) @> ?::jsonb)", [JSON.stringify([invoiceId])])
    .update({
      charges_applied: expectedChargesApplied + 1,
      amount_applied: dbh.raw('COALESCE(amount_applied, 0) + ?', [amount]),
      applied_invoice_ids: dbh.raw("COALESCE(applied_invoice_ids, '[]'::jsonb) || ?::jsonb", [JSON.stringify([invoiceId])]),
      status: exhaustsOffer ? 'exhausted' : 'granted',
      updated_at: new Date(),
    });
  return updated === 1;
}

module.exports = {
  OFFER_REASONS,
  OFFER_FAMILIES,
  MIN_TENURE_DAYS,
  MIN_PAID_VISITS,
  COOLDOWN_MONTHS,
  cooldownFloor,
  etMonthsAgoFloor,
  offerEligibility,
  grantRetentionOffer,
  retentionDiscountForInvoice,
  consumeRetentionOffer,
};
