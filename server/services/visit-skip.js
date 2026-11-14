'use strict';

/**
 * Skip one recurring plan visit (owner decision 2026-11-13: the office only, and a paid visit is moved, never skipped).
 *
 * A skip is not a cancel. A single-visit cancel of a plan visit books a make-up visit (owner rulings 2026-09-24 and
 * 2026-09-30, recurring-series-cancel-reseed.js); a skip marks the visit `skipped`, books nothing and texts nobody.
 * `skipped` is the status the plan-hold lifecycle already writes for a visit the customer is away for
 * (cancellation-resolution/holds.js applyHoldSkips): no make-up code runs for it, and the reminder trigger cancels the
 * visit's reminder row.
 *
 * Which visit may be skipped is NOT decided here. The bare-visit classifier the Intelligence Bar cancel card uses
 * (appointment-cancel-impact.js cardCancelRefusals, owner ruling 2026-09-28) lists every money, card and linked-visit
 * effect a cancel would have; a visit with any of them is not skipped, because a skip runs none of the cancel
 * follow-through (invoice void, card fee rails, linked-visit cascade). The one code a skip ignores is the make-up
 * visit itself.
 *
 * This module only reads. The write is the dispatch status route (PUT /admin/dispatch/:serviceId/status, status
 * 'skipped'), which asks skipVerdict before its transaction and assertSkippable under the visit's row lock.
 */

const db = require('../models/db');

const SKIPPABLE_FROM_STATUSES = ['pending', 'confirmed'];
// A cancel may book a make-up visit; a skip never does, so this refusal is not about a skip.
const MAKEUP_REFUSAL = 'plan_makeup_visit';

const MESSAGES = Object.freeze({
  ok: '',
  admin_only: 'Only the office can skip a visit.',
  not_live: 'This visit can no longer be skipped. Refresh and try again.',
  not_plan_visit: 'Only a visit of a recurring plan can be skipped. Cancel this visit instead.',
  prepaid: 'This visit is paid for already. Move it to a new date instead of skipping it.',
  has_money_or_links: 'This visit has an invoice, a card or a linked visit on it. Cancel it instead.',
});

function verdict(code) {
  return { eligible: code === 'ok', code, message: MESSAGES[code] };
}

// The visit's own state: an open plan visit nobody has started. Returns a refusal code or null.
function rowRefusal(row) {
  const { LIVE_TRACK_STATES } = require('./cancellation-eligibility');
  const { isPlanSeriesRow } = require('./recurring-series-cancel-reseed');
  if (!row || !SKIPPABLE_FROM_STATUSES.includes(String(row.status))) return 'not_live';
  if (LIVE_TRACK_STATES.includes(String(row.track_state))) return 'not_live';
  if (!isPlanSeriesRow(row)) return 'not_plan_visit';
  return null;
}

/**
 * May this visit be skipped right now? `row` needs id, status, track_state, is_recurring, recurring_parent_id,
 * is_callback and followup_included. `conn` is the caller's transaction at commit (the visit row is locked there);
 * it defaults to the pool for a read outside one. Throws when the money and card state cannot be read: a failed read
 * never passes for "bare".
 *
 * `piCache` (a Map) and `piCacheOnly` go to the classifier as they are (see computeCancelAppointmentImpact): a check
 * made before the lock fills the cache with any PaymentIntent it had to look up, and the check under the lock reads
 * from that cache alone, so no Stripe call is made while a row lock is held.
 */
async function skipVerdict(row, { conn = db, isAdmin = false, actorId = null, piCache = null, piCacheOnly = false } = {}) {
  if (!isAdmin) return verdict('admin_only');
  const refusal = rowRefusal(row);
  if (refusal) return verdict(refusal);
  const { computeCancelAppointmentImpact } = require('./appointment-cancel-impact');
  const impact = await computeCancelAppointmentImpact(row.id, { conn, actorId, ...(piCache ? { piCache, piCacheOnly } : {}) });
  if (!impact) return verdict('not_live');
  const refusals = (impact.card_cancel_refusals || []).filter((code) => code !== MAKEUP_REFUSAL);
  if (refusals.includes('prepaid_coverage')) return verdict('prepaid');
  return verdict(refusals.length ? 'has_money_or_links' : 'ok');
}

const VERDICT_COLUMNS = ['id', 'status', 'track_state', 'is_recurring', 'recurring_parent_id', 'is_callback', 'followup_included'];

/**
 * The commit-time check, under the caller's row lock on the visit. Throws a 409 with `code` and an operator sentence
 * when the visit may not be skipped (the dispatch status handler maps status + code to its reply). `piCache` is the
 * cache the caller's check before the lock filled: with it, this check makes no Stripe call (a PaymentIntent that
 * appeared since is a throw, so the skip fails closed).
 */
async function assertSkippable(trx, serviceId, { isAdmin = false, actorId = null, piCache = null } = {}) {
  const row = await trx('scheduled_services').where({ id: serviceId }).first(...VERDICT_COLUMNS);
  const result = await skipVerdict(row, { conn: trx, isAdmin, actorId, piCache, piCacheOnly: !!piCache });
  if (!result.eligible) {
    throw Object.assign(new Error(result.message), { status: result.code === 'admin_only' ? 403 : 409, code: `skip_${result.code}` });
  }
}

module.exports = {
  skipVerdict,
  assertSkippable,
  SKIPPABLE_FROM_STATUSES,
  _private: { rowRefusal, MESSAGES },
};
