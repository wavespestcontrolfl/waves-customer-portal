/**
 * Retroactive call_log → customer linking.
 *
 * Why this exists: call_log.customer_id is a point-in-time snapshot. It is
 * set once at webhook intake by primary-phone lookup, and again during
 * processing only when THAT run resolves a customer (which requires a name
 * match against the extraction). A caller whose customer record is created
 * minutes later stays orphaned forever — observed 2026-07: a voicemail
 * arrived 18 minutes before the caller's quote-form record was created, and
 * the call sat customer_id NULL for two weeks. Orphaned calls are invisible
 * in the customer's call history and permanently ineligible for booking
 * automation (which requires customer_id). No backfill existed.
 *
 * Linking rule mirrors findSingleCustomerByPhone in twilio-voice-webhook.js
 * exactly: PRIMARY-phone-only (service-contact slot phones never auto-link —
 * see KNOWN_CALLER_PHONE_COLS commentary there), soft-deleted customers
 * excluded, and only an UNAMBIGUOUS single match links; 2+ customers sharing
 * a number stay unlinked.
 *
 * Deliberate unlinks stay unlinked. A NULL customer_id is not always a
 * missed attribution — the processor intentionally clears links in two
 * cases this job must never undo (both cited from
 * call-recording-processor.js):
 *   - forwarding-masked phantom links: an internal Waves number appearing
 *     as the call's contact must never key a customer (the phantom-customer
 *     collapse fix). We skip any call whose contact phone is internal AND
 *     any matched customer whose own phone is internal.
 *   - rejected empty voicemails: transcription is replaced with the
 *     rejection sentinel and the link is cleared so unified-message sync
 *     can't attach to a hallucinated customer. We exclude sentinel rows.
 *
 * Idempotent: only rows still NULL are touched (re-checked at write time),
 * nothing is ever re-linked or overwritten. The scan walks the ENTIRE
 * 30-day window via keyset pagination — a fixed newest-first cap would let
 * permanently-unmatchable rows starve older calls that have since become
 * matchable. Dark by default behind GATE_CALL_LOG_RELINK.
 */

const db = require('../models/db');
const logger = require('./logger');
const { toE164 } = require('../utils/phone');
const TWILIO_NUMBERS = require('../config/twilio-numbers');

// How far back each hourly run scans. Generous: the run is idempotent and the
// candidate set (unlinked calls with a usable number) is small.
const WINDOW_DAYS = 30;
// Keyset page size and a hard page ceiling — a runaway backstop, not a work
// cap: 20 pages × 500 covers far more unlinked calls than a 30-day window
// can realistically hold.
const PAGE_SIZE = 500;
const MAX_PAGES = 20;
// Verbatim sentinel from call-recording-processor.js — marks a rejected
// empty-voicemail row whose customer link was deliberately cleared.
const TRANSCRIPTION_REJECTED_SENTINEL = '[Recording had no usable speech; an implausible transcription was rejected.]';

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

async function findSingleCustomerByKey(conn, key) {
  const query = conn('customers').whereNull('deleted_at');
  if (key.length === 10) {
    query.whereRaw(
      "(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ? OR regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ?)",
      [key, `1${key}`]
    );
  } else {
    query.whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ?", [key]);
  }
  const matches = await query.orderBy('updated_at', 'desc').limit(2).select('id', 'phone');
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    logger.warn(`[call-relink] ${matches.length}+ customers share phone ${maskPhone(key)}; not auto-linking`);
  }
  return null;
}

async function relinkUnattributedCalls({ now = new Date(), conn = db } = {}) {
  const cutoff = new Date(now.getTime() - WINDOW_DAYS * 24 * 3600 * 1000);

  // Keyset walk of the whole window — no starvation: every unlinked row in
  // the window is examined every run. The cursor is id-only (uuid order,
  // arbitrary but stable): scan order is irrelevant to correctness here,
  // and a created_at cursor would silently fail to advance — JS Date params
  // carry millisecond precision while timestamptz stores microseconds, so
  // `(created_at, id) > (?, ?)` re-matches the row the cursor came from.
  const byKey = new Map();
  let scanned = 0;
  let skipped = 0;
  let cursorId = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = conn('call_log')
      .whereNull('customer_id')
      .where('created_at', '>=', cutoff)
      // Rejected empty voicemails were DELIBERATELY unlinked by the
      // processor; sync must never re-attach them.
      .whereRaw('transcription IS DISTINCT FROM ?', [TRANSCRIPTION_REJECTED_SENTINEL])
      .orderBy('id', 'asc')
      .limit(PAGE_SIZE)
      .select('id', 'direction', 'from_phone', 'to_phone', 'created_at');
    if (cursorId) {
      query.where('id', '>', cursorId);
    }
    const rows = await query;
    if (!rows.length) break;
    cursorId = rows[rows.length - 1].id;
    scanned += rows.length;
    for (const call of rows) {
      const contactPhone = pickContactPhone(call);
      // An internal Waves number (our lines, staff forwards) is never a real
      // external contact — forwarding legs surface them as From/To, and
      // linking on one re-creates the phantom-customer collapse the
      // processor's unlink guard exists to stop.
      if (TWILIO_NUMBERS.isInternalNumber(contactPhone)) {
        skipped += 1;
        continue;
      }
      const key = phoneLookupKey(contactPhone);
      // Sub-10-digit keys are shortcodes/anonymous/garbage — an exact-digit
      // match on those would link the wrong record more often than the right
      // one, and intake would only ever have seen them as unlinkable anyway.
      if (!key || key.length < 10) {
        skipped += 1;
        continue;
      }
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(call.id);
    }
    if (rows.length < PAGE_SIZE) break;
  }

  let linked = 0;
  let ambiguousOrUnmatched = 0;
  for (const [key, callIds] of byKey) {
    const customer = await findSingleCustomerByKey(conn, key);
    if (!customer) {
      ambiguousOrUnmatched += callIds.length;
      continue;
    }
    // A customer keyed on an internal number IS the phantom the processor's
    // unlink guard cleared — restoring that link hourly would undo the fix.
    if (TWILIO_NUMBERS.isInternalNumber(customer.phone)) {
      skipped += callIds.length;
      logger.warn(`[call-relink] matched customer ${customer.id} is keyed on an internal number; not linking ${callIds.length} call(s)`);
      continue;
    }
    // whereNull again at write time: another writer (processing re-link,
    // admin action) may have linked the row since we read it.
    const updated = await conn('call_log')
      .whereIn('id', callIds)
      .whereNull('customer_id')
      .update({ customer_id: customer.id, updated_at: new Date() });
    if (updated > 0) {
      linked += updated;
      logger.info(`[call-relink] Linked ${updated} call(s) on ${maskPhone(key)} to customer ${customer.id}`);
    }
  }
  return { scanned, linked, ambiguousOrUnmatched, skipped };
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
  TRANSCRIPTION_REJECTED_SENTINEL,
  WINDOW_DAYS,
  PAGE_SIZE,
  MAX_PAGES,
};
