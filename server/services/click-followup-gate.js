/**
 * Click-followup pre-send gate — the ONE guard stack for the
 * clicked-but-didn't-book lane, shared by BOTH moments a draft can move:
 *
 *   1. DRAFT time  — services/click-followup.js (the 30-min cron) evaluates
 *      the gate before queueing a message_drafts row, and
 *   2. SEND time   — routes/admin-drafts.js approve/revise re-evaluates the
 *      SAME gate before an owner-approved draft reaches the provider,
 *      because every one of these conditions can change while a draft sits
 *      pending (the customer converts, the estimate is declined/expires,
 *      another SMS goes out, the contact replies, a cadence stage comes due).
 *
 * Sharing one module is the point: a guard added here protects both moments
 * automatically — there is no way to fix the queue and forget the approval
 * path again.
 *
 * evaluateClickFollowupGate(input) → { ok: true } | { ok: false, code, reason? }
 *
 * Codes and how callers are expected to map them:
 *   estimate_terminal — estimate missing/archived/declined/expired/void/
 *                       accepted. Queue: dismiss. Approval: retire the draft.
 *   converted         — customer / lead / phone-evidence conversion.
 *                       Queue: mark converted. Approval: retire the draft +
 *                       flip the action to converted.
 *   suppressed        — opt-out / wrong number / DNC / known landline.
 *                       Queue: dismiss. Approval: retire the draft.
 *   cadence_due       — an estimate-followup stage (incl. the gated
 *                       deposit-abandonment stage) fires within 24h.
 *                       Queue: dismiss this click. Approval: HOLD (409,
 *                       draft stays pending — the condition passes).
 *   recent_outbound   — outbound SMS to the contact in the last 48h.
 *                       Queue: skip (no row). Approval: HOLD.
 *   replied_recently  — inbound SMS from the contact in the last 14d.
 *                       Queue: skip. Approval: HOLD.
 *   guard_error       — a conversion lookup failed; fail CLOSED. Queue:
 *                       skip. Approval: 503, draft stays pending.
 *
 * THIS MODULE NEVER SENDS ANYTHING — it only reads state and returns a
 * verdict (the click-followup NO-SEND test pins this file too).
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const {
  customerConvertedSince,
  NON_LIVE_APPOINTMENT_STATUSES,
} = require('./estimate-conversion-guard');
const { DEPOSIT_FOLLOWUP_WINDOW } = require('./estimate-deposits');
const { loadSuppressionState } = require('./messaging/validators/suppression');
const { readCachedLineType } = require('./messaging/validators/line-type');

// Estimate statuses the cadence treats as terminal (estimate-follow-up.js).
const TERMINAL_STATUSES = new Set(['declined', 'accepted', 'expired', 'void']);

function last10(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
}

function normalizeE164(phone) {
  const trimmed = String(phone || '').trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return trimmed.startsWith('+') ? trimmed : trimmed;
}

// Reply-pause: the contact has texted Waves recently → let staff handle it
// live. Mirrors estimate-follow-up's hasRepliedRecently (customer_id + phone
// match); soft-fails OPEN like both existing services so a missing table
// never breaks the loop — the worst case is a draft the owner declines.
async function hasRepliedRecently({ customerId, phone }, days = 14) {
  const cutoff = new Date(Date.now() - days * 86400000);
  const ten = last10(phone);
  if (!customerId && !ten) return false;
  try {
    const q = db('messages')
      .join('conversations', 'messages.conversation_id', 'conversations.id')
      .where('messages.direction', 'inbound')
      .where('messages.channel', 'sms')
      .where('messages.created_at', '>=', cutoff)
      .first('messages.id');
    q.andWhere(function () {
      if (customerId) this.orWhere('conversations.customer_id', customerId);
      if (ten) {
        this.orWhereRaw(
          "RIGHT(regexp_replace(COALESCE(conversations.contact_phone, ''), '[^0-9]', '', 'g'), 10) = ?",
          [ten],
        );
      }
    });
    return !!(await q);
  } catch (e) {
    logger.warn(`[click-followup-gate] reply-pause check skipped: ${e.message}`);
    return false; // fail open
  }
}

// Any outbound SMS to this contact in the last N hours → they just heard from
// us; another nudge would stack touches. Fails CLOSED (treat as recent) — a
// transient read error holds this attempt and a later one retries.
async function hasRecentOutboundSms({ customerId, phone }, hours = 48) {
  const cutoff = new Date(Date.now() - hours * 3600000);
  const ten = last10(phone);
  if (!customerId && !ten) return false;
  try {
    const q = db('sms_log')
      .where('direction', 'outbound')
      .where('created_at', '>=', cutoff)
      .first('id');
    q.andWhere(function () {
      if (customerId) this.orWhere('customer_id', customerId);
      if (ten) {
        this.orWhereRaw(
          "RIGHT(regexp_replace(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10) = ?",
          [ten],
        );
      }
    });
    return !!(await q);
  } catch (e) {
    logger.warn(`[click-followup-gate] outbound-48h check failed — holding: ${e.message}`);
    return true; // fail closed → retry later
  }
}

// Opt-out / wrong-number / DNC / known-landline. Reuses the messaging
// validators' state loaders (no paid Lookup from here — cached line types
// only). Returns true when the contact must never get this nudge.
async function isSuppressedContact(phone) {
  const e164 = normalizeE164(phone);
  if (!e164) return false;
  try {
    const contactState = await loadSuppressionState({ to: e164 }, {});
    if (contactState && contactState.suppression) return true;
  } catch (e) {
    logger.warn(`[click-followup-gate] suppression lookup failed (continuing): ${e.message}`);
  }
  try {
    const cached = await readCachedLineType(e164);
    if (cached && cached.state === 'hit' && cached.lineType === 'landline') return true;
  } catch (e) {
    logger.warn(`[click-followup-gate] line-type cache read failed (continuing): ${e.message}`);
  }
  return false;
}

// Is an estimate-followup cadence stage going to fire for this estimate
// within the next `soonHours`? Mirrors the stage predicates in
// estimate-follow-up.js checkAll() (flag unset + status + trigger window),
// widened by the lookahead — if the cadence is about to nudge anyway, the
// click-followup draft would stack a second touch on top of it.
function cadenceStageDueSoon(est, now = new Date(), soonHours = 24) {
  if (!est || est.archived_at) return false;
  if (TERMINAL_STATUSES.has(est.status)) return false;
  const H = 3600000;
  const nowMs = now.getTime();
  const overlapsSoon = (startMs, endMs) => startMs <= nowMs + soonHours * H && endMs >= nowMs;
  const flagUnset = (flag) => est[flag] === false || est[flag] == null;
  const ts = (v) => {
    if (!v) return null;
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? null : t;
  };
  const sentAt = ts(est.sent_at);
  const viewedAt = ts(est.viewed_at);
  const expiresAt = ts(est.expires_at);

  // 1. Unviewed nudge: sent 24–48h ago.
  if (est.status === 'sent' && !viewedAt && sentAt && flagUnset('followup_unviewed_sent')
      && overlapsSoon(sentAt + 24 * H, sentAt + 48 * H)) return true;
  // 2. Viewed-not-accepted: viewed 48–72h ago.
  if (est.status === 'viewed' && viewedAt && flagUnset('followup_viewed_sent')
      && overlapsSoon(viewedAt + 48 * H, viewedAt + 72 * H)) return true;
  // 3. Final nudge: viewed 5–6d ago.
  if (est.status === 'viewed' && viewedAt && flagUnset('followup_final_sent')
      && overlapsSoon(viewedAt + 5 * 24 * H, viewedAt + 6 * 24 * H)) return true;
  // 4. Expiring notice: expires in 1–3d.
  if (['sent', 'viewed'].includes(est.status) && expiresAt && flagUnset('followup_expiring_sent')
      && overlapsSoon(expiresAt - 3 * 24 * H, expiresAt - 24 * H)) return true;
  return false;
}

// Deposit-abandonment cadence stage (estimate-follow-up.js
// checkDepositAbandoned): fires when the estimate's latest PENDING deposit
// intent was last touched minAge–maxAge hours ago. Not modelable from the
// estimate row alone (the anchor lives in estimate_deposits), so it gets its
// own async check beside the four timestamp stages. Only live while its gate
// is on — off, that stage only shadow-logs and can't double-touch. Fails
// toward suppression: an unreadable deposits table holds this attempt.
async function depositStageDueSoon(est, now = new Date(), soonHours = 24) {
  if (!isEnabled('estimateDepositAbandonmentSms')) return false;
  if (!est || !['sent', 'viewed'].includes(est.status)) return false;
  if (!(est.followup_deposit_abandoned_sent === false || est.followup_deposit_abandoned_sent == null)) return false;
  try {
    const row = await db('estimate_deposits')
      .where({ estimate_id: est.id, status: 'pending' })
      .max('updated_at as latest_pending_at')
      .first();
    const latest = row && row.latest_pending_at ? new Date(row.latest_pending_at).getTime() : null;
    if (!latest || Number.isNaN(latest)) return false;
    const H = 3600000;
    const nowMs = now.getTime();
    // Stage window [latest+minAge, latest+maxAge] vs lookahead [now, now+soon].
    return latest + DEPOSIT_FOLLOWUP_WINDOW.minAgeHours * H <= nowMs + soonHours * H
      && latest + DEPOSIT_FOLLOWUP_WINDOW.maxAgeHours * H >= nowMs;
  } catch (e) {
    logger.warn(`[click-followup-gate] deposit-stage check failed — suppressing: ${e.message}`);
    return true;
  }
}

// Lead-side conversion for lead-only estimates. customerConvertedSince(est)
// short-circuits to false when the estimate carries no customer_id, but
// conversion CREATES the customer without backfilling the estimate (e.g. the
// admin booking-link flow books via /book?service=... with no estimate id).
// Evidence, in order: the lead's own conversion stamp / terminal 'won'
// status, else the linked customer (leads.customer_id) run through the same
// guard. Fails CLOSED like the guard itself.
async function leadConvertedSince(leadId, est) {
  if (!leadId) return { converted: false };
  try {
    const lead = await db('leads')
      .where({ id: leadId })
      .first('id', 'status', 'customer_id', 'converted_at');
    if (!lead) return { converted: false };
    if (lead.converted_at || lead.status === 'won') {
      return { converted: true, reason: lead.converted_at ? 'lead-converted' : 'lead-won' };
    }
    if (lead.customer_id) {
      return await customerConvertedSince({
        id: est.id,
        customer_id: lead.customer_id,
        created_at: est.created_at,
      });
    }
    return { converted: false };
  } catch (e) {
    logger.warn(`[click-followup-gate] lead conversion check failed — failing closed: ${e.message}`);
    return { converted: true, reason: 'guard-error' };
  }
}

// Phone-evidence conversion — the safety net for BOOKED lead-only booking
// clicks: the admin booking link targets /book?service=... with no lead_id
// or estimate_id, so the very booking the click produced leaves NO lead- or
// estimate-side evidence. A customers row created after the click, or a live
// scheduled_services booking created after the click whose customer matches
// the contact's last-10 phone, counts as converted. Deliberately biased to
// suppress: a false-positive phone match (shared household number) costs one
// nudge; texting "pick your first visit" to someone who already booked costs
// trust. Fails CLOSED (guard-error) like the other conversion checks.
async function phoneConvertedSince(phone, sinceTs) {
  const ten = last10(phone);
  if (!ten) return { converted: false };
  const since = sinceTs ? new Date(sinceTs) : null;
  if (!since || Number.isNaN(since.getTime())) return { converted: false };
  try {
    const cust = await db('customers')
      .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [ten])
      .where('created_at', '>=', since)
      .first('id');
    if (cust) return { converted: true, reason: 'phone-customer-created' };

    const booked = await db('scheduled_services as ss')
      .join('customers as c', 'ss.customer_id', 'c.id')
      .whereNotIn('ss.status', NON_LIVE_APPOINTMENT_STATUSES)
      .where('ss.created_at', '>=', since)
      .whereRaw("RIGHT(regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), 10) = ?", [ten])
      .first('ss.id');
    if (booked) return { converted: true, reason: 'phone-booking' };

    return { converted: false };
  } catch (e) {
    logger.warn(`[click-followup-gate] phone conversion check failed — failing closed: ${e.message}`);
    return { converted: true, reason: 'guard-error' };
  }
}

/**
 * The shared gate. See the module doc for inputs, codes, and caller mapping.
 *
 * @param {Object} input
 * @param {Object|null} input.estimate  fresh estimates row (or null/missing)
 * @param {string|null} input.customerId resolved contact customer id
 * @param {string|null} input.leadId     resolved contact lead id
 * @param {string|null} input.phone      contact phone (any format)
 * @param {*} input.sinceTs              conversion anchor for phone evidence
 *                                       (clicked_at; falls back to estimate
 *                                       created_at)
 * @param {Date} [input.now]
 */
async function evaluateClickFollowupGate({ estimate, customerId, leadId, phone, sinceTs, now = new Date() }) {
  // 1. The estimate must still be an open offer.
  if (!estimate || estimate.archived_at || TERMINAL_STATUSES.has(estimate.status)) {
    return { ok: false, code: 'estimate_terminal' };
  }

  // 2. Conversion — customer evidence, then lead-side, then phone evidence.
  let conv = await customerConvertedSince(estimate);
  if (!conv.converted && !estimate.customer_id && leadId) {
    conv = await leadConvertedSince(leadId, estimate);
  }
  if (!conv.converted && phone) {
    conv = await phoneConvertedSince(phone, sinceTs || estimate.created_at);
  }
  if (conv.converted && conv.reason === 'guard-error') {
    return { ok: false, code: 'guard_error' };
  }
  if (conv.converted) {
    return { ok: false, code: 'converted', reason: conv.reason };
  }

  // 3. Terminal recipient suppression (opt-out / DNC / landline).
  if (phone && await isSuppressedContact(phone)) {
    return { ok: false, code: 'suppressed' };
  }

  // 4. Cadence stages, incl. the gated deposit-abandonment stage.
  if (cadenceStageDueSoon(estimate, now) || await depositStageDueSoon(estimate, now)) {
    return { ok: false, code: 'cadence_due' };
  }

  // 5. Recent-touch holds.
  const contact = { customerId: customerId || estimate.customer_id || null, phone };
  if (await hasRecentOutboundSms(contact)) {
    return { ok: false, code: 'recent_outbound' };
  }
  if (await hasRepliedRecently(contact)) {
    return { ok: false, code: 'replied_recently' };
  }

  return { ok: true };
}

module.exports = {
  evaluateClickFollowupGate,
  cadenceStageDueSoon,
  depositStageDueSoon,
  leadConvertedSince,
  phoneConvertedSince,
  hasRepliedRecently,
  hasRecentOutboundSms,
  isSuppressedContact,
  last10,
  normalizeE164,
  TERMINAL_STATUSES,
};
