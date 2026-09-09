/**
 * Why did we place this outbound call? — deterministic reason resolver for
 * the voicemail text-back (services/outbound-voicemail-sms.js).
 *
 * Scoped by the owner 2026-09-08 from 60 days of real outbound calls: the
 * only reasons the data supports naming to a customer, in priority order:
 *
 *   quote_request   the web quote-form auto-bridge (call_log.source) — they
 *                   just submitted a quote request; or a manual follow-up
 *                   call to someone we quote-bridged inside the last 72h
 *                   (the replay showed the office redialing a form lead a
 *                   day or two later).
 *   returning_call  a callback of a specific inbound call
 *                   (call_log.metadata.relatedCallId, set by the call-log
 *                   Call button), or the most recent inbound call from them
 *                   inside the lookback (spam / robocall / wrong-number /
 *                   vendor natures excluded).
 *   saw_text        an inbound text from them inside the lookback.
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

const REASONS = Object.freeze({
  QUOTE_REQUEST: 'quote_request',
  RETURNING_CALL: 'returning_call',
  SAW_TEXT: 'saw_text',
  GENERIC: 'generic',
});

const QUOTE_REQUEST_SOURCES = new Set(['lead-webhook-auto-bridge']);
// Same set context-aggregator uses to keep junk calls out of customer context.
const NON_CONTACT_NATURES = new Set(['spam_solicitation', 'robocall', 'wrong_number', 'vendor_or_partner']);
const LOOKBACK_MS = 48 * 60 * 60 * 1000;
const QUOTE_BRIDGE_LOOKBACK_MS = 72 * 60 * 60 * 1000;

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

async function latestInboundText({ customerId, phoneLast10, before, since }) {
  return fromContact(
    db('sms_log')
      .where('direction', 'inbound')
      .where('created_at', '<', before)
      .where('created_at', '>=', since),
    { customerId, phoneLast10, phoneColumn: 'from_phone' },
  )
    .orderBy('created_at', 'desc')
    .first('id', 'created_at');
}

// Our own quote-form auto-bridge to this person inside the last 72h: the
// follow-up call is still about their quote request. The bridge row's
// to_phone is the admin cell; the prospect's number is metadata.leadPhone.
async function latestQuoteBridge({ customerId, phoneLast10, before }) {
  const since = new Date(before.getTime() - QUOTE_BRIDGE_LOOKBACK_MS);
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

    const [inboundCall, inboundText, quoteBridge] = await Promise.all([
      latestInboundCall({ customerId, phoneLast10, before, since }),
      latestInboundText({ customerId, phoneLast10, before, since }),
      latestQuoteBridge({ customerId, phoneLast10, before }),
    ]);
    const candidates = [
      inboundCall && { reason: REASONS.RETURNING_CALL, at: inboundCall.created_at, evidence: { inbound_call_id: inboundCall.id, at: inboundCall.created_at } },
      inboundText && { reason: REASONS.SAW_TEXT, at: inboundText.created_at, evidence: { inbound_sms_id: inboundText.id, at: inboundText.created_at } },
      quoteBridge && { reason: REASONS.QUOTE_REQUEST, at: quoteBridge.created_at, evidence: { quote_bridge_call_id: quoteBridge.id, at: quoteBridge.created_at } },
    ].filter(Boolean);
    if (candidates.length) {
      // Most recent wins; on a tie the order above (call, text, bridge) holds.
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
  QUOTE_BRIDGE_LOOKBACK_MS,
  QUOTE_REQUEST_SOURCES,
  NON_CONTACT_NATURES,
  resolveOutboundCallReason,
  _private: { last10, callNature, parseMetadata },
};
