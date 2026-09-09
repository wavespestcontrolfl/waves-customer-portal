/**
 * Why did we place this outbound call? — deterministic reason resolver for
 * the voicemail text-back (services/outbound-voicemail-sms.js).
 *
 * Scoped by the owner 2026-09-08 from 60 days of real outbound calls: the
 * only reasons the data supports naming to a customer, in priority order:
 *
 *   quote_request   the web quote-form auto-bridge (call_log.source) — they
 *                   just submitted a quote request; or a manual follow-up
 *                   call to someone who submitted a web quote form inside
 *                   the last 48h (a leads row from the form / website_quote
 *                   channel, or our own bridge call — the bridge does not
 *                   fire after hours, so the lead row is the primary signal).
 *
 *   Suppression (not a reason): visitInProgress() — the technician is en
 *   route to or on site at this customer right now. Those calls are about
 *   finding the address or getting access; the customer just received the
 *   en-route / arrived texts, and a "returning your call" or "quote request"
 *   text would be wrong. The send layer skips the text entirely.
 *   returning_call  a callback of a specific inbound call
 *                   (call_log.metadata.relatedCallId, set by the call-log
 *                   Call button), or the most recent inbound call from them
 *                   inside the lookback (spam / robocall / wrong-number /
 *                   vendor natures excluded).
 *   saw_text        an inbound text from them inside the lookback — a real
 *                   message, not a one-word acknowledgement ("Ok", "1",
 *                   "Great! Thank you", a bare emoji, an empty MMS) or a
 *                   reschedule-option reply; the audit over real calls
 *                   showed those producing "Saw your text" for nothing.
 *   generic         nothing we can honestly name — "Sorry we missed you."
 *
 * When several of {inbound call, inbound text, quote bridge} fall inside
 * their lookbacks, the most recent wins (that is what the office was
 * reacting to).
 * Estimate follow-ups, visit reminders, service requests and billing were
 * deliberately left out (owner ruling). No model call; plain queries only.
 */

const db = require('../models/db');
const logger = require('./logger');
const { isSmsReaction } = require('./sms-intent');

const REASONS = Object.freeze({
  QUOTE_REQUEST: 'quote_request',
  RETURNING_CALL: 'returning_call',
  SAW_TEXT: 'saw_text',
  GENERIC: 'generic',
});

const QUOTE_REQUEST_SOURCES = new Set(['lead-webhook-auto-bridge']);
// leads.first_contact_channel values written by the web quote funnels.
const QUOTE_FORM_CHANNELS = new Set(['form', 'website_quote']);
// Reply types that are answers to OUR texts, never a message to call back about.
const IGNORED_TEXT_TYPES = new Set(['reschedule_reply']);
const VISIT_IN_PROGRESS_STATUSES = ['en_route', 'on_site'];
const VISIT_IN_PROGRESS_WINDOW_MS = 3 * 60 * 60 * 1000;
// The customer-facing arrival texts — phone-keyed, so they cover a call row
// with no linked customer and a visit row with no en_route_at/arrived_at stamp.
const ARRIVAL_TEXT_TYPES = ['tech_en_route', 'tech_arrived'];
// Same set context-aggregator uses to keep junk calls out of customer context.
const NON_CONTACT_NATURES = new Set(['spam_solicitation', 'robocall', 'wrong_number', 'vendor_or_partner']);
const LOOKBACK_MS = 48 * 60 * 60 * 1000;

function last10(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function parseMetadata(metadata) {
  if (metadata && typeof metadata === 'object') return metadata;
  if (typeof metadata === 'string' && metadata) {
    try { return JSON.parse(metadata) || {}; } catch { return {}; }
  }
  return {};
}

function callNature(row) {
  const enriched = row?.ai_extraction_enriched;
  const obj = typeof enriched === 'string' ? (() => { try { return JSON.parse(enriched); } catch { return null; } })() : enriched;
  return String(obj?.call_nature || '').trim().toLowerCase();
}

// "From them" predicate shared by the call and text probes: the linked
// customer when the row has one, otherwise the dialed number's last 10.
function fromContact(qb, { customerId, phoneLast10, phoneColumn }) {
  return qb.where(function contact() {
    if (customerId) this.where('customer_id', customerId);
    if (phoneLast10) {
      const clause = db.raw(`right(regexp_replace(${phoneColumn}, '\\D', '', 'g'), 10) = ?`, [phoneLast10]);
      if (customerId) this.orWhere(clause); else this.where(clause);
    }
    if (!customerId && !phoneLast10) this.whereRaw('false');
  });
}

async function relatedInboundCall(relatedCallId) {
  if (!relatedCallId || relatedCallId === 'undefined') return null;
  const row = await db('call_log')
    .where({ id: relatedCallId, direction: 'inbound' })
    .first('id', 'created_at', 'ai_extraction_enriched');
  if (!row) return null;
  if (NON_CONTACT_NATURES.has(callNature(row))) return null;
  return row;
}

async function latestInboundCall({ customerId, phoneLast10, before, since }) {
  const rows = await fromContact(
    db('call_log')
      .where('direction', 'inbound')
      .where('created_at', '<', before)
      .where('created_at', '>=', since),
    { customerId, phoneLast10, phoneColumn: 'from_phone' },
  )
    .orderBy('created_at', 'desc')
    .limit(5)
    .select('id', 'created_at', 'ai_extraction_enriched');
  return rows.find((r) => !NON_CONTACT_NATURES.has(callNature(r))) || null;
}

// A text worth saying "saw your text" about: has words, is not a bare
// acknowledgement / emoji reaction, and is not a reply to a reschedule menu.
function isSubstantiveText(row) {
  if (IGNORED_TEXT_TYPES.has(String(row?.message_type || ''))) return false;
  const body = String(row?.message_body || '').trim();
  if (!body || !/[a-z]/i.test(body)) return false;
  if (isSmsReaction(body)) return false;
  // Short courtesy closers with no content ("ok", "thanks", "great thank you").
  if (/^(ok(ay)?|k|yes|no|yep|nope|sure|great|thanks?|thank you|ty|got it|sounds good|perfect|will do|1|2)[\s!.]*(thanks?|thank you)?[\s!.]*$/i.test(body)) return false;
  return true;
}

async function latestInboundText({ customerId, phoneLast10, before, since }) {
  const rows = await fromContact(
    db('sms_log')
      .where('direction', 'inbound')
      .where('created_at', '<', before)
      .where('created_at', '>=', since),
    { customerId, phoneLast10, phoneColumn: 'from_phone' },
  )
    .orderBy('created_at', 'desc')
    .limit(5)
    .select('id', 'created_at', 'message_body', 'message_type');
  return rows.find(isSubstantiveText) || null;
}

// A web quote-form lead from them inside the lookback (the form's own row —
// fires even when the after-hours bridge did not).
async function latestQuoteFormLead({ customerId, phoneLast10, before, since }) {
  return fromContact(
    db('leads')
      .whereNull('deleted_at')
      .whereIn('first_contact_channel', [...QUOTE_FORM_CHANNELS])
      .where('created_at', '<', before)
      .where('created_at', '>=', since),
    { customerId, phoneLast10, phoneColumn: 'phone' },
  )
    .orderBy('created_at', 'desc')
    .first('id', 'created_at');
}

/**
 * Is a technician en route to / on site at this customer right now (or was,
 * inside the last 3h before `before`)? Three signals, any one suffices: a
 * live en_route/on_site visit dated today; an en_route_at / arrived_at stamp
 * inside the window; or an en-route / arrived TEXT we sent that number inside
 * the window (phone-keyed — covers unlinked call rows and unstamped visits).
 */
async function visitInProgress({ customerId, phone = null, before = new Date() } = {}) {
  const phoneLast10 = last10(phone);
  if (!customerId && !phoneLast10) return false;
  const at = new Date(before);
  const since = new Date(at.getTime() - VISIT_IN_PROGRESS_WINDOW_MS);
  // Live status counts only for a visit dated today: the audit found rows
  // left at on_site for days (never transitioned), and a visit booked AFTER
  // the call must not suppress it. The en_route_at / arrived_at stamps are
  // exact and make the check replayable on history.
  const dayStart = new Date(at); dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 36 * 60 * 60 * 1000); // ET-safe slack over the UTC day
  const dayStartSlack = new Date(dayStart.getTime() - 12 * 60 * 60 * 1000);
  const row = await db('scheduled_services as ss')
    .modify((qb) => {
      // No linked customer on the call row → match the dialed number to a
      // customer record (the audit's "no name" click during a visit).
      if (customerId) qb.where('ss.customer_id', customerId);
      else qb.join('customers as c', 'c.id', 'ss.customer_id')
        .whereNull('c.deleted_at')
        .whereRaw("right(regexp_replace(c.phone, '\\D', '', 'g'), 10) = ?", [phoneLast10]);
    })
    .where('ss.created_at', '<', at)
    .where(function active() {
      this.where(function liveToday() {
        this.whereIn('ss.status', VISIT_IN_PROGRESS_STATUSES)
          .whereBetween('ss.scheduled_date', [dayStartSlack, dayEnd]);
      })
        .orWhereBetween('ss.en_route_at', [since, at])
        .orWhereBetween('ss.arrived_at', [since, at]);
    })
    .first('ss.id');
  if (row) return true;
  if (!phoneLast10) return false;
  const arrivalText = await db('sms_log')
    .where('direction', 'outbound')
    .whereIn('message_type', ARRIVAL_TEXT_TYPES)
    .where('created_at', '>=', since)
    .where('created_at', '<', at)
    .whereRaw("right(regexp_replace(to_phone, '\\D', '', 'g'), 10) = ?", [phoneLast10])
    .first('id');
  return !!arrivalText;
}

// Our own quote-form auto-bridge to this person inside the last 48h: the
// follow-up call is still about their quote request. The bridge row's
// to_phone is the admin cell; the prospect's number is metadata.leadPhone.
async function latestQuoteBridge({ customerId, phoneLast10, before, since }) {
  return db('call_log')
    .where('direction', 'outbound')
    .whereIn('source', [...QUOTE_REQUEST_SOURCES])
    .where('created_at', '<', before)
    .where('created_at', '>=', since)
    .where(function contact() {
      if (customerId) this.where('customer_id', customerId);
      if (phoneLast10) {
        const clause = db.raw("right(regexp_replace(metadata->>'leadPhone', '\\D', '', 'g'), 10) = ?", [phoneLast10]);
        if (customerId) this.orWhere(clause); else this.where(clause);
      }
      if (!customerId && !phoneLast10) this.whereRaw('false');
    })
    .orderBy('created_at', 'desc')
    .first('id', 'created_at');
}

/**
 * @param {object} p
 * @param {object} p.call      call_log row: source, customer_id, metadata, created_at
 * @param {string} p.phone     the customer number we dialed
 * @returns {Promise<{ reason: string, evidence: object }>}
 */
async function resolveOutboundCallReason({ call = {}, phone } = {}) {
  const source = String(call.source || '');
  if (QUOTE_REQUEST_SOURCES.has(source)) {
    return { reason: REASONS.QUOTE_REQUEST, evidence: { source } };
  }

  const before = call.created_at ? new Date(call.created_at) : new Date();
  const since = new Date(before.getTime() - LOOKBACK_MS);
  const customerId = call.customer_id || null;
  const phoneLast10 = last10(phone);
  const meta = parseMetadata(call.metadata);

  try {
    const related = await relatedInboundCall(meta.relatedCallId);
    if (related) {
      return { reason: REASONS.RETURNING_CALL, evidence: { related_call_id: related.id, at: related.created_at } };
    }

    const [inboundCall, inboundText, quoteLead, quoteBridge] = await Promise.all([
      latestInboundCall({ customerId, phoneLast10, before, since }),
      latestInboundText({ customerId, phoneLast10, before, since }),
      latestQuoteFormLead({ customerId, phoneLast10, before, since }),
      latestQuoteBridge({ customerId, phoneLast10, before, since }),
    ]);
    const candidates = [
      inboundCall && { reason: REASONS.RETURNING_CALL, at: inboundCall.created_at, evidence: { inbound_call_id: inboundCall.id, at: inboundCall.created_at } },
      inboundText && { reason: REASONS.SAW_TEXT, at: inboundText.created_at, evidence: { inbound_sms_id: inboundText.id, at: inboundText.created_at } },
      quoteLead && { reason: REASONS.QUOTE_REQUEST, at: quoteLead.created_at, evidence: { quote_lead_id: quoteLead.id, at: quoteLead.created_at } },
      quoteBridge && { reason: REASONS.QUOTE_REQUEST, at: quoteBridge.created_at, evidence: { quote_bridge_call_id: quoteBridge.id, at: quoteBridge.created_at } },
    ].filter(Boolean);
    if (candidates.length) {
      // Most recent wins; on a tie the order above (call, text, lead, bridge) holds.
      const best = candidates.reduce((a, b) => (new Date(b.at) > new Date(a.at) ? b : a));
      return { reason: best.reason, evidence: best.evidence };
    }
  } catch (e) {
    // A probe failure must never block the text — fall back to the generic
    // copy, which is always true.
    logger.warn(`[outbound-call-reason] probe failed — generic reason: ${e.code || e.name || 'db_error'}`);
    return { reason: REASONS.GENERIC, evidence: { error: e.code || e.name || 'db_error' } };
  }
  return { reason: REASONS.GENERIC, evidence: {} };
}

module.exports = {
  REASONS,
  LOOKBACK_MS,
  QUOTE_REQUEST_SOURCES,
  QUOTE_FORM_CHANNELS,
  NON_CONTACT_NATURES,
  VISIT_IN_PROGRESS_WINDOW_MS,
  resolveOutboundCallReason,
  visitInProgress,
  isSubstantiveText,
  _private: { last10, callNature, parseMetadata },
};
