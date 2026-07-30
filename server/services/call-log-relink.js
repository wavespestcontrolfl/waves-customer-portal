/**
 * Retroactive call_log → customer linking.
 *
 * Why this exists: call_log.customer_id is a point-in-time snapshot. It is
 * set once at webhook intake by primary-phone lookup, and again during
 * processing only when THAT run resolves a customer (which requires a name
 * match against the extraction). A caller whose customer record is created
 * minutes later stays orphaned forever — 2026-07-17 Knorr/Riverwalk: the
 * voicemail arrived at 14:49, the quote-form record was created at 15:07,
 * and the call sat customer_id NULL for two weeks. Orphaned calls are
 * invisible in the customer's call history and permanently ineligible for
 * booking automation (which requires customer_id). No backfill existed.
 *
 * Linking rule mirrors findSingleCustomerByPhone in twilio-voice-webhook.js
 * exactly: PRIMARY-phone-only (service-contact slot phones never auto-link —
 * see KNOWN_CALLER_PHONE_COLS commentary there), soft-deleted customers
 * excluded, and only an UNAMBIGUOUS single match links; 2+ customers sharing
 * a number stay unlinked. Idempotent: only rows still NULL are touched,
 * nothing is ever re-linked or overwritten. Dark by default behind
 * GATE_CALL_LOG_RELINK.
 */

const db = require('../models/db');
const logger = require('./logger');
const { toE164 } = require('../utils/phone');

// How far back each hourly run scans. Generous: the run is idempotent and the
// candidate set (unlinked calls with a usable number) is small, so re-scanning
// costs one indexed query.
const WINDOW_DAYS = 30;
const MAX_CALLS_PER_RUN = 500;

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? `***${digits.slice(-4)}` : 'unknown';
}

// The customer's counterpart number on this call: who we dialed on outbound,
// who dialed us on inbound.
function pickContactPhone(call) {
  return String(call.direction || '').startsWith('outbound') ? call.to_phone : call.from_phone;
}

// Verbatim contract of customerPhoneLookupKey in twilio-voice-webhook.js —
// NANP numbers reduce to their 10-digit key; anything else matches on exact
// digits. Kept in lockstep so retro-links can never claim a number intake
// would have refused.
function phoneLookupKey(value) {
  const normalized = toE164(value);
  const digits = String(normalized || value || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

async function findSingleCustomerIdByKey(conn, key) {
  const query = conn('customers').whereNull('deleted_at');
  if (key.length === 10) {
    query.whereRaw(
      "(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ? OR regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ?)",
      [key, `1${key}`]
    );
  } else {
    query.whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ?", [key]);
  }
  const matches = await query.orderBy('updated_at', 'desc').limit(2).select('id');
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    logger.warn(`[call-relink] ${matches.length}+ customers share phone ${maskPhone(key)}; not auto-linking`);
  }
  return null;
}

async function relinkUnattributedCalls({ now = new Date(), conn = db } = {}) {
  const cutoff = new Date(now.getTime() - WINDOW_DAYS * 24 * 3600 * 1000);
  const calls = await conn('call_log')
    .whereNull('customer_id')
    .where('created_at', '>=', cutoff)
    .orderBy('created_at', 'desc')
    .limit(MAX_CALLS_PER_RUN)
    .select('id', 'direction', 'from_phone', 'to_phone');

  // Group by lookup key so a repeat caller costs one customer query, and an
  // ambiguous number is decided once for all its calls.
  const byKey = new Map();
  let noPhone = 0;
  for (const call of calls) {
    const key = phoneLookupKey(pickContactPhone(call));
    // Sub-10-digit keys are shortcodes/anonymous/garbage — an exact-digit
    // match on those would link the wrong record more often than the right
    // one, and intake would only ever have seen them as unlinkable anyway.
    if (!key || key.length < 10) {
      noPhone += 1;
      continue;
    }
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(call.id);
  }

  let linked = 0;
  let ambiguousOrUnmatched = 0;
  for (const [key, callIds] of byKey) {
    const customerId = await findSingleCustomerIdByKey(conn, key);
    if (!customerId) {
      ambiguousOrUnmatched += callIds.length;
      continue;
    }
    // whereNull again at write time: another writer (processing re-link,
    // admin action) may have linked the row since we read it.
    const updated = await conn('call_log')
      .whereIn('id', callIds)
      .whereNull('customer_id')
      .update({ customer_id: customerId, updated_at: new Date() });
    if (updated > 0) {
      linked += updated;
      logger.info(`[call-relink] Linked ${updated} call(s) on ${maskPhone(key)} to customer ${customerId}`);
    }
  }
  return { scanned: calls.length, linked, ambiguousOrUnmatched, noPhone };
}

async function runCallLogRelink({ now = new Date() } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('callLogRelink')) {
    return { skipped: true, reason: 'gated_off' };
  }
  const { runExclusive } = require('../utils/cron-lock');
  return runExclusive('call-log-relink', () => relinkUnattributedCalls({ now }));
}

module.exports = {
  runCallLogRelink,
  relinkUnattributedCalls,
  pickContactPhone,
  phoneLookupKey,
  WINDOW_DAYS,
  MAX_CALLS_PER_RUN,
};
