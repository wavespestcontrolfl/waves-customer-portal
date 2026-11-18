/**
 * Referral code on the customer estimate page (owner-approved 2026-11-18,
 * GATE_ESTIMATE_REFERRAL_CODE): the customer types a referrer's code and the
 * existing program runs from there. The program is unchanged: both accounts
 * get their reward after the friend's first recurring service.
 *
 *   enter    one estimate_referral_codes row. It is referral evidence, the
 *            third kind beside a referral link and a referrer named on the
 *            first call (referral-inbound.js reads it). No money moves and
 *            nothing is sent.
 *   confirm  once the estimate is accepted and the customer is on a plan, the
 *            code's owner is confirmed as the referrer through the Queue's
 *            own confirm in its deferred-only form, the one the new-referral
 *            bell's Confirm runs: it sends nothing and pays nothing now, and
 *            it refuses, saving nothing, a household's own code, a customer
 *            whose first plan visit is done, a milestone conversion and
 *            rewards paid at once. A refused card waits in Referrals → Queue
 *            for the office, as a link card does.
 *
 * The gate is read on both legs.
 */
const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const engine = require('./referral-engine');
const inbound = require('./referral-inbound');

// The hourly pass looks only at estimates accepted this recently: long enough
// for a new customer to land on a plan, and it is the one bound on the work,
// since a card the confirm holds gets no answer row and would otherwise be
// read again every hour for good. An older card still waits in Referrals →
// Queue.
const SWEEP_WINDOW_DAYS = 45;

const gateOn = () => isEnabled('estimateReferralCode');

// The referee's reward as the estimate page words it, from the live program
// settings: never a dollar figure typed into the page.
function refereeNote(settings) {
  const cents = Number(settings?.referee_discount_cents || 0);
  return cents > 0
    ? `You’ll get a $${(cents / 100).toFixed(2)} account credit after your first recurring service.`
    : 'Your referral is on file.';
}

const appliedView = (row, settings) => ({ code: row.code, referral: true, note: refereeNote(settings) });

/**
 * What the estimate page shows for a referral code: the code on this
 * estimate, or that one may be entered. null when the gate is off, the
 * program is paused, or there is nothing to show.
 * `open`: the estimate can still be accepted (the route's own check).
 */
async function referralCodeViewForEstimate(estimate, { open = false, conn = db } = {}) {
  if (!gateOn() || !estimate?.id) return null;
  const settings = await engine.getLiveSettings(conn);
  if (!settings?.program_active) return null;
  const row = await conn('estimate_referral_codes').where({ estimate_id: estimate.id }).first();
  if (row) return { canEnter: false, applied: appliedView(row, settings) };
  return open ? { canEnter: true, applied: null } : null;
}

// The referrer a typed code names, with the code as issued, or null. Codes
// are stored as issued (some in mixed case) and a phone keyboard may change
// the case, so the stored spelling is found first, whatever case was typed.
async function referrerForTyped(conn, typed) {
  const lower = typed.toLowerCase();
  const issued = await conn('referral_promoters').whereRaw('LOWER(referral_code) = ?', [lower]).first('referral_code')
    || await conn('customers').whereNull('deleted_at').whereRaw('LOWER(referral_code) = ?', [lower]).first('referral_code');
  if (!issued) return null;
  const owner = await inbound.customerForCode(issued.referral_code, conn);
  return owner ? { owner, code: issued.referral_code } : null;
}

// A referee who cannot be referred: the referrer's own household, or a
// customer Waves has already serviced (the program is for new customers).
async function refereeBlocked(conn, customerId, owner) {
  if (!customerId) return false;
  const referee = await conn('customers').where({ id: customerId }).first('id', 'account_id', 'email', 'phone');
  if (!referee || inbound.sameHousehold(owner, referee)) return true;
  const served = await conn('service_records').where({ customer_id: customerId })
    .whereRaw("COALESCE(status, 'completed') = 'completed'").first('id');
  return Boolean(served);
}

/**
 * Record `rawCode` as the referral code on an open estimate. The caller owns
 * the gate, the token and the estimate's open state, and passes its
 * transaction holding the estimate row lock as `conn`.
 * Returns { ok: true, applied } or { ok: false, reason }:
 * 'code_already_entered' or the one generic 'invalid_code'.
 */
async function enterReferralCode({ estimate, rawCode }, conn = db) {
  const typed = String(rawCode == null ? '' : rawCode).trim();
  if (!inbound.CODE_RE.test(typed)) return { ok: false, reason: 'invalid_code' };
  const settings = await engine.getLiveSettings(conn);
  if (!settings?.program_active) return { ok: false, reason: 'invalid_code' };

  const named = await referrerForTyped(conn, typed);
  const existing = await conn('estimate_referral_codes').where({ estimate_id: estimate.id }).first();
  if (existing) {
    return named && existing.code === named.code
      ? { ok: true, applied: appliedView(existing, settings) }
      : { ok: false, reason: 'code_already_entered' };
  }
  if (!named || await refereeBlocked(conn, estimate.customer_id, named.owner)) {
    return { ok: false, reason: 'invalid_code' };
  }

  const [row] = await conn('estimate_referral_codes')
    .insert({ estimate_id: estimate.id, code: named.code })
    .returning('*');
  await conn('activity_log').insert({
    customer_id: estimate.customer_id || null,
    estimate_id: estimate.id,
    action: 'estimate_referral_code_entered',
    description: `Customer entered referral code ${named.code} on their estimate.`,
    metadata: JSON.stringify({ code: named.code, referrerCustomerId: named.owner.id }),
  });
  return { ok: true, applied: appliedView(row, settings) };
}

/**
 * Confirm the referrer a customer's typed code names, when the card is ready
 * for it: the customer is listed (on a plan, not yet answered) on a typed
 * code with one sure referrer. Returns 'confirmed', 'held' (the Queue's
 * confirm refused it; the card waits for the office) or 'none'.
 */
async function confirmTypedReferral(customerId) {
  const [card] = await inbound.listInboundReferrals(db, { customerId });
  if (!card || card.evidence.source !== 'code') return 'none';
  const sure = inbound.sureReferrerOf(card);
  if (!sure) return 'held';
  try {
    await inbound.confirmInboundReferral({
      customerId, referrerCustomerId: String(sure.customerId), reviewedBy: null, deferredOnly: true,
    });
    return 'confirmed';
  } catch (err) {
    // The confirm's own refusal (a hold, or answered meanwhile): never an error here.
    if (!err.statusCode) throw err;
    return 'held';
  }
}

/**
 * The step after an accept commits. Never throws: a referral problem must
 * not fail an acceptance. Safe to call again.
 * Returns 'confirmed' | 'held' | 'none' | 'off' | 'failed'.
 */
async function confirmReferralForAcceptedEstimate({ estimateId }) {
  if (!gateOn()) return 'off';
  if (!estimateId) return 'none';
  try {
    const row = await db('estimate_referral_codes as r')
      .join('estimates as e', 'e.id', 'r.estimate_id')
      .where({ 'r.estimate_id': estimateId, 'e.status': 'accepted' })
      .whereNotNull('e.customer_id')
      .first('e.customer_id');
    if (!row) return 'none';
    const outcome = await confirmTypedReferral(row.customer_id);
    if (outcome !== 'none') logger.info(`[estimate-referral-code] estimate ${estimateId}: ${outcome}`);
    return outcome;
  } catch (err) {
    logger.error(`[estimate-referral-code] estimate ${estimateId}: referral not confirmed (${err?.code || err?.message})`);
    return 'failed';
  }
}

/**
 * Hourly recovery (services/scheduler.js). The step after an accept is a fast
 * path: the customer may not be on a plan yet when it runs, or it may fail.
 * This runs the same step for every typed code on an estimate accepted in
 * the last SWEEP_WINDOW_DAYS whose customer has no answer yet. Nothing is sent.
 */
async function sweepTypedReferralCodes() {
  if (!gateOn()) return { checked: 0, confirmed: 0 };
  const waiting = await db('estimate_referral_codes as r')
    .join('estimates as e', 'e.id', 'r.estimate_id')
    .where({ 'e.status': 'accepted' })
    .where('e.accepted_at', '>=', new Date(Date.now() - SWEEP_WINDOW_DAYS * 86400000))
    .whereNotNull('e.customer_id')
    .whereNotExists(db('referral_inbound_reviews as v').whereRaw('v.customer_id = e.customer_id').select(db.raw('1')))
    // Every waiting code in the window, oldest first: no cap, so codes the
    // confirm holds can never keep another customer's from being tried.
    .orderBy('r.created_at', 'asc')
    .pluck('r.estimate_id');
  let confirmed = 0;
  for (const estimateId of waiting) {
    if (await confirmReferralForAcceptedEstimate({ estimateId }) === 'confirmed') confirmed += 1;
  }
  return { checked: waiting.length, confirmed };
}

module.exports = {
  referralCodeViewForEstimate,
  enterReferralCode,
  confirmReferralForAcceptedEstimate,
  sweepTypedReferralCodes,
};
