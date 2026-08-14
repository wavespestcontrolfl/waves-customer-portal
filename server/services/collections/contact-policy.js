/**
 * Collections contact policy — the single gate every balance-related outreach
 * decision consults (PR A: policy + shadow only; NOTHING here sends, dials,
 * or messages — it only answers "would contacting this customer on this
 * channel, for this purpose, right now be allowed?").
 *
 * FAIL CLOSED: any thrown error or unknown state evaluates to NOT ALLOWED
 * with an explicit denial reason. The reads here gate outbound contact, so a
 * DB blip must read as "no", never as "yes".
 *
 * Denial reasons are stable identifiers (tests pin them):
 *   unknown_channel, customer_not_found, customer_archived,
 *   no_eligible_balance, invoice_pending_settlement,
 *   flag_<flag> (one per active collections_flags row covering the channel),
 *   contact_within_24h, voice_contact_within_7d, live_conversation_within_7d,
 *   outside_call_window,
 *   pilot_requires_single_invoice, pilot_balance_below_minimum,
 *   pilot_balance_above_maximum, pilot_not_overdue_long_enough,
 *   pilot_overdue_too_long, pilot_insufficient_dunning_history,
 *   line_type_unknown, line_type_not_mobile, commercial_customer,
 *   consent_no_evidence, rnd_check_required,
 *   policy_evaluation_error
 */

const db = require('../../models/db');
const logger = require('../logger');
const { openBalanceInvoices } = require('../open-balance');
const { invoiceAmountDue } = require('../invoice-helpers');
const { etParts, etDateString, etCalendarDayOf } = require('../../utils/datetime-et');
const ConsentProvenance = require('./consent-provenance');

const CHANNELS = new Set(['sms', 'email', 'voice', 'manual_call']);

// Which channels each active flag blocks. Absolute flags block everything —
// including manual_call, so even a human dial-sheet consumer sees the denial.
const ALL_CHANNELS = ['sms', 'email', 'voice', 'manual_call'];
const FLAG_BLOCKED_CHANNELS = {
  do_not_collect: ALL_CHANNELS,
  collection_hold: ALL_CHANNELS,
  attorney_represented: ALL_CHANNELS,
  bankruptcy: ALL_CHANNELS,
  wrong_number: ALL_CHANNELS,
  do_not_call: ['voice', 'manual_call'],
  do_not_text: ['sms'],
  do_not_email: ['email'],
  automated_voice_consent_revoked: ['voice'],
};

// Voice pilot caps (owner-scoped): ONE invoice, $50.00–$500.00, 14–60 days
// overdue, ≥2 delivered dunning touches, mobile line, residential only.
const PILOT_MIN_BALANCE_CENTS = 5000;
const PILOT_MAX_BALANCE_CENTS = 50000;
const PILOT_MIN_DAYS_OVERDUE = 14;
const PILOT_MAX_DAYS_OVERDUE = 60;
const PILOT_MIN_DUNNING_TOUCHES = 2;

// Voice contact window: 9:00–17:59 ET, Monday–Friday.
const CALL_WINDOW_START_HOUR = 9;
const CALL_WINDOW_END_HOUR = 18; // exclusive

// Reassigned-number staleness: no customer-initiated contact from the number
// within 90 days ⇒ an RND check is required before any automated voice
// contact (the RND query itself is PR B / manual — here it is only a denial).
const RND_STALENESS_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

// Whole ET calendar days between a due value (date column or timestamp) and
// `now` — overdue age is COMPUTED from due_date, never read off a status.
function daysOverdueOn(now, dueValue) {
  const dueStr = etCalendarDayOf(dueValue);
  const nowStr = etDateString(now);
  const [dy, dm, dd] = dueStr.split('-').map(Number);
  const [ny, nm, nd] = nowStr.split('-').map(Number);
  return Math.round((Date.UTC(ny, nm - 1, nd) - Date.UTC(dy, dm - 1, dd)) / DAY_MS);
}

function isVoiceLike(channel) {
  return channel === 'voice' || channel === 'manual_call';
}

// Delivered dunning touches for ONE invoice: the per-invoice follow-up
// sequence's touches_sent (only incremented when a channel actually
// delivered) plus the legacy late-payment-checker's activity_log rows (one
// per delivered tier; metadata carries the invoice id).
async function deliveredDunningTouches(invoice) {
  let touches = 0;
  const seq = await db('invoice_followup_sequences')
    .where({ invoice_id: invoice.id })
    .first('touches_sent');
  if (seq) touches += Number(seq.touches_sent) || 0;

  const [row] = await db('activity_log')
    .where({ action: 'late_payment_reminder' })
    .whereRaw('metadata::text LIKE ?', [`%"invoiceId":"${invoice.id}"%`])
    .count('* as count');
  touches += parseInt(row?.count || 0, 10);
  return touches;
}

async function evaluate(customerId, { channel, purpose, now = new Date() } = {}) {
  const result = {
    allowed: false,
    denialReasons: [],
    eligibleInvoiceIds: [],
    eligibleBalanceCents: 0,
    nextEligibleAt: null,
    consentEvidence: null,
    activeHolds: [],
    recentContacts: [],
  };
  const deny = (reason) => {
    if (!result.denialReasons.includes(reason)) result.denialReasons.push(reason);
  };
  const proposeNextEligible = (at) => {
    if (!at) return;
    const d = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(d.getTime())) return;
    if (!result.nextEligibleAt || d.getTime() > result.nextEligibleAt.getTime()) {
      result.nextEligibleAt = d;
    }
  };

  try {
    if (!CHANNELS.has(channel)) {
      deny('unknown_channel');
      return result;
    }

    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) {
      deny('customer_not_found');
      return result;
    }
    if (customer.deleted_at) {
      deny('customer_archived');
      return result;
    }

    // ── Open-balance eligibility ────────────────────────────────────────
    // Reuse the existing open-balance authority (billing-v2 "Pay now"
    // selection, live payer re-resolution, payer/statement exclusion,
    // cents-positive remainder). Its fail-closed drop policy is inherited
    // deliberately: a row it cannot prove self-pay is not collectible here
    // either.
    const openInvoices = await openBalanceInvoices(customerId);
    // Invoice-level exclusion the loader doesn't make: a payment already in
    // flight. Status 'processing'/paid/void/draft never reach here (loader
    // selects sent/viewed/overdue only) and credit-covered rows are dropped
    // by its cents test, but a row with a Stripe PaymentIntent attached may
    // be mid-settlement — dunning it risks a double ask. Conservative drop.
    const eligible = [];
    let droppedPendingSettlement = false;
    for (const inv of openInvoices) {
      if (inv.stripe_payment_intent_id) {
        droppedPendingSettlement = true;
        continue;
      }
      eligible.push(inv);
    }
    result.eligibleInvoiceIds = eligible.map((inv) => inv.id);
    result.eligibleBalanceCents = eligible.reduce(
      (sum, inv) => sum + Math.round(invoiceAmountDue(inv) * 100),
      0,
    );
    if (!eligible.length) {
      if (droppedPendingSettlement) deny('invoice_pending_settlement');
      deny('no_eligible_balance');
    }

    // ── Hard flags ──────────────────────────────────────────────────────
    const flags = await db('collections_flags')
      .where({ customer_id: customerId })
      .whereNull('released_at')
      .select('*');
    result.activeHolds = flags;
    for (const row of flags) {
      const blocked = FLAG_BLOCKED_CHANNELS[row.flag];
      // Unknown flag string = fail closed on every channel.
      if (!blocked || blocked.includes(channel)) deny(`flag_${row.flag}`);
    }

    // ── Rolling frequency windows (collections ledger) ──────────────────
    const windowStart = new Date(now.getTime() - 7 * DAY_MS);
    const recent = await db('collections_contact_ledger')
      .where({ customer_id: customerId })
      .where('occurred_at', '>', windowStart)
      .orderBy('occurred_at', 'desc')
      .select('*');
    result.recentContacts = recent;
    const within = (row, ms) => now.getTime() - new Date(row.occurred_at).getTime() < ms;
    if (channel === 'voice') {
      const any24h = recent.find((r) => within(r, DAY_MS));
      if (any24h) {
        deny('contact_within_24h');
        proposeNextEligible(new Date(new Date(any24h.occurred_at).getTime() + DAY_MS));
      }
      // A manual call IS a voice contact for spacing purposes.
      const voice7d = recent.find((r) => isVoiceLike(r.channel));
      if (voice7d) {
        deny('voice_contact_within_7d');
        proposeNextEligible(new Date(new Date(voice7d.occurred_at).getTime() + 7 * DAY_MS));
      }
    } else if (channel === 'sms' || channel === 'email') {
      // A live conversation (either direction of a real call) supersedes the
      // automated text/email cadence for a week.
      const live = recent.find((r) => isVoiceLike(r.channel));
      if (live) {
        deny('live_conversation_within_7d');
        proposeNextEligible(new Date(new Date(live.occurred_at).getTime() + 7 * DAY_MS));
      }
    }

    // ── Voice-only checks ───────────────────────────────────────────────
    if (channel === 'voice') {
      // Quiet window: 9:00–17:59 ET, Monday–Friday, via datetime-et (never
      // raw new Date() ET math — the timestamptz trap).
      const et = etParts(now);
      const weekday = et.dayOfWeek >= 1 && et.dayOfWeek <= 5;
      const inHours = et.hour >= CALL_WINDOW_START_HOUR && et.hour < CALL_WINDOW_END_HOUR;
      if (!weekday || !inHours) deny('outside_call_window');

      if (purpose === 'late_payment') {
        if (eligible.length !== 1) {
          if (eligible.length > 1) deny('pilot_requires_single_invoice');
        } else {
          const invoice = eligible[0];
          if (result.eligibleBalanceCents < PILOT_MIN_BALANCE_CENTS) deny('pilot_balance_below_minimum');
          if (result.eligibleBalanceCents > PILOT_MAX_BALANCE_CENTS) deny('pilot_balance_above_maximum');

          // Overdue age is computed from due_date (created_at fallback — the
          // same reference the late-payment rails use), never status.
          const daysOverdue = daysOverdueOn(now, invoice.due_date || invoice.created_at);
          if (daysOverdue < PILOT_MIN_DAYS_OVERDUE) deny('pilot_not_overdue_long_enough');
          if (daysOverdue > PILOT_MAX_DAYS_OVERDUE) deny('pilot_overdue_too_long');

          const touches = await deliveredDunningTouches(invoice);
          if (touches < PILOT_MIN_DUNNING_TOUCHES) deny('pilot_insufficient_dunning_history');
        }

        // Mobile line only, from the EXISTING phone-keyed Lookup cache.
        // readCachedLineType is discriminated (hit/miss/error); its own
        // callers fail OPEN for cheap SMS, but an outbound voice policy
        // fails CLOSED: miss and error are both denials.
        const { readCachedLineType } = require('../messaging/validators/line-type');
        const lineType = await readCachedLineType(customer.phone);
        if (lineType.state !== 'hit') deny('line_type_unknown');
        else if (lineType.lineType !== 'mobile') deny('line_type_not_mobile');

        // Residential only in the pilot.
        if (String(customer.property_type || '').toLowerCase() === 'commercial') {
          deny('commercial_customer');
        }
      }

      // Consent provenance — required for ANY automated voice purpose.
      const evidence = await ConsentProvenance.resolve(customerId, customer.phone);
      result.consentEvidence = evidence;
      if (!evidence) deny('consent_no_evidence');

      // Reassigned-number staleness: >90 days without customer-initiated
      // contact (or none ever) requires an RND check before dialing.
      const freshAt = await ConsentProvenance.freshness(customerId, customer.phone);
      const staleness = freshAt ? now.getTime() - freshAt.getTime() : Infinity;
      if (staleness > RND_STALENESS_DAYS * DAY_MS) deny('rnd_check_required');
    }

    result.allowed = result.denialReasons.length === 0;
    return result;
  } catch (err) {
    logger.error(`[contact-policy] evaluation failed for customer ${customerId}: ${err.message}`);
    // FAIL CLOSED — an error is never "allowed".
    result.allowed = false;
    deny('policy_evaluation_error');
    return result;
  }
}

module.exports = {
  evaluate,
  // Exported for tests / PR B reuse.
  PILOT_MIN_BALANCE_CENTS,
  PILOT_MAX_BALANCE_CENTS,
  PILOT_MIN_DAYS_OVERDUE,
  PILOT_MAX_DAYS_OVERDUE,
  PILOT_MIN_DUNNING_TOUCHES,
  RND_STALENESS_DAYS,
  FLAG_BLOCKED_CHANNELS,
};
