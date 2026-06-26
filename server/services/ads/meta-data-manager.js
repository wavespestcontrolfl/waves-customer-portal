/**
 * Meta Conversions API (CAPI) — offline-conversion upload, the Meta analog of
 * data-manager.js (Google). Uploads qualified leads (event_name='Lead') and
 * completed-job revenue (event_name='Purchase') to the Meta pixel/dataset so
 * Meta optimises toward real outcomes, not just clicks.
 *
 * Reuses data-manager's candidate collectors + hashing so Meta and Google pull
 * the SAME qualified-lead / completed-job rows (those collectors now also carry
 * fbclid/fbc/fbp). Match keys: fbc/fbp (or fbc built from fbclid) + SHA-256
 * hashed email/phone.
 *
 * Safety: like the Google side, real uploads require META_CAPI_ALLOW_UPLOADS=true.
 * Otherwise (or when validateOnly) events go to Meta's Test Events tool via
 * META_CAPI_TEST_EVENT_CODE and are NOT counted — and we refuse to send at all
 * if neither is set, so nothing real leaks. De-duped per event_id via the
 * meta_conversion_uploads log.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { runExclusive } = require('../../utils/cron-lock');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const {
  collectCandidates, sha256Hex, normalizeEmail, normalizePhone,
} = require('./data-manager')._private;

const GRAPH = 'https://graph.facebook.com';
const DEFAULT_CURRENCY = 'USD';
const MAX_EVENTS_PER_REQUEST = 1000;
const MAX_LIMIT = 500;
const SENT = 'sent';
const VALIDATED = 'validated';

const EVENT_NAMES = { qualified_lead: 'Lead', completed_job_revenue: 'Purchase' };

function apiVersion() {
  return process.env.META_CAPI_API_VERSION || process.env.META_ADS_API_VERSION || 'v21.0';
}
function pixelId() {
  return String(process.env.META_CAPI_PIXEL_ID || '').trim() || null;
}
function isConfigured() {
  return !!(pixelId() && process.env.META_CAPI_ACCESS_TOKEN);
}
function boolEnv(name) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').toLowerCase());
}
function number(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}
function toUnixSeconds(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}
function dateRange(periodDays = 90) {
  const days = Math.min(Math.max(parseInt(periodDays, 10) || 90, 1), 365);
  return { days, since: etDateString(addETDays(new Date(), -days)), endDate: etDateString(addETDays(new Date(), -1)) };
}

// --- event construction (pure, exported for tests) --------------------------
function buildUserData(candidate, eventTimeSeconds) {
  const ud = {};
  const email = normalizeEmail(candidate.email);
  const phone = normalizePhone(candidate.phone); // '+1...' -> digits for Meta
  if (email) ud.em = [sha256Hex(email)];
  if (phone) ud.ph = [sha256Hex(phone.replace(/^\+/, ''))];
  let fbc = candidate.fbc || null;
  // Meta accepts an fbc rebuilt from fbclid: fb.1.<click_ms>.<fbclid>.
  if (!fbc && candidate.fbclid && eventTimeSeconds) {
    fbc = `fb.1.${eventTimeSeconds * 1000}.${candidate.fbclid}`;
  }
  if (fbc) ud.fbc = fbc;
  if (candidate.fbp) ud.fbp = candidate.fbp;
  return ud;
}

function buildEvent(candidate) {
  const eventTime = toUnixSeconds(candidate.eventTimestamp);
  if (!eventTime) return null;
  const userData = buildUserData(candidate, eventTime);
  if (!Object.keys(userData).length) return null; // no match key -> unsendable
  const event = {
    event_name: EVENT_NAMES[candidate.conversionType],
    event_time: eventTime,
    action_source: 'system_generated',
    event_id: candidate.transactionId, // dedupe key (also our log key)
    user_data: userData,
  };
  const value = number(candidate.conversionValue);
  if (value > 0) {
    event.custom_data = { value: Math.round(value * 100) / 100, currency: candidate.currency || DEFAULT_CURRENCY };
  }
  return event;
}

function skipReason(candidate) {
  if (!candidate.eventTimestamp) return 'missing_event_timestamp';
  if (!buildEvent(candidate)) return 'missing_match_keys';
  // A Purchase with no value is meaningless to Meta value optimisation.
  if (candidate.conversionType === 'completed_job_revenue' && !(number(candidate.conversionValue) > 0)) {
    return 'missing_conversion_value';
  }
  return null;
}

function matchKeySummary(candidate) {
  return {
    fbc: !!candidate.fbc,
    fbclid: !!candidate.fbclid,
    fbp: !!candidate.fbp,
    email: !!normalizeEmail(candidate.email),
    phone: !!normalizePhone(candidate.phone),
  };
}

// --- send + log -------------------------------------------------------------
async function sendEvents(events, { testCode, fetchImpl = global.fetch } = {}) {
  if (!fetchImpl) throw new Error('fetch is not available');
  const url = `${GRAPH}/${apiVersion()}/${pixelId()}/events`;
  const body = { data: events, access_token: process.env.META_CAPI_ACCESS_TOKEN };
  if (testCode) body.test_event_code = testCode;
  const resp = await fetchImpl(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) {
    const err = new Error(data?.error?.message || `HTTP ${resp.status}`);
    err.response = data;
    throw err;
  }
  return data; // { events_received, messages, fbtrace_id }
}

async function existingSent(conversionType, eventIds) {
  if (!eventIds.length) return new Set();
  const rows = await db('meta_conversion_uploads')
    .where({ conversion_type: conversionType, status: SENT })
    .whereIn('event_id', eventIds)
    .select('event_id');
  return new Set(rows.map((r) => r.event_id));
}

async function logUpload(candidate, { status, testMode, eventsReceived = null, errorMessage = null }) {
  const row = {
    conversion_type: candidate.conversionType,
    event_id: candidate.transactionId,
    event_name: EVENT_NAMES[candidate.conversionType],
    event_time: candidate.eventTimestamp,
    value: candidate.conversionValue || null,
    currency: candidate.currency || DEFAULT_CURRENCY,
    source_table: candidate.sourceTable || null,
    source_id: candidate.sourceId || null,
    lead_id: candidate.leadId || null,
    customer_id: candidate.customerId || null,
    invoice_id: candidate.invoiceId || null,
    service_record_id: candidate.serviceRecordId || null,
    status,
    test_mode: !!testMode,
    events_received: eventsReceived,
    error_message: errorMessage,
    match_keys: JSON.stringify(matchKeySummary(candidate)),
    sent_at: status === SENT ? db.fn.now() : null,
    updated_at: db.fn.now(),
  };
  await db('meta_conversion_uploads')
    .insert({ ...row, created_at: db.fn.now() })
    .onConflict(['conversion_type', 'event_id'])
    .merge(row);
}

// Real uploads require ALLOW_UPLOADS; otherwise we send to Test Events (not
// counted) via the test code, and refuse entirely if neither is available.
function resolveMode(validateOnly) {
  const live = boolEnv('META_CAPI_ALLOW_UPLOADS');
  const testCode = process.env.META_CAPI_TEST_EVENT_CODE || null;
  const wantTest = validateOnly === true || boolEnv('META_CAPI_VALIDATE_ONLY') || !live;
  return { live, testCode, testMode: wantTest, canSend: wantTest ? !!testCode : true };
}

async function uploadConversions({ conversionType = 'completed_job_revenue', periodDays = 90, limit = 200, validateOnly = false, force = false, fetchImpl } = {}) {
  if (!EVENT_NAMES[conversionType]) throw new Error(`Unsupported conversion type: ${conversionType}`);
  if (!isConfigured()) return { configured: false, conversionType, error: 'Meta CAPI not configured (META_CAPI_PIXEL_ID + META_CAPI_ACCESS_TOKEN).' };

  const mode = resolveMode(validateOnly);
  if (!mode.canSend) {
    return { configured: true, conversionType, skipped: true, reason: 'no_test_event_code', note: 'Set META_CAPI_ALLOW_UPLOADS=true for live, or META_CAPI_TEST_EVENT_CODE for a dry run.' };
  }

  return runExclusive(`meta-capi-upload:${conversionType}`, async () => {
    const range = dateRange(periodDays);
    const cap = Math.min(Math.max(parseInt(limit, 10) || 200, 1), MAX_EVENTS_PER_REQUEST, MAX_LIMIT);
    const candidates = await collectCandidates(conversionType, { ...range, limit: cap });
    const alreadySent = force ? new Set() : await existingSent(conversionType, candidates.map((c) => c.transactionId));

    const sendable = [];
    const skipped = [];
    for (const c of candidates) {
      const reason = skipReason(c);
      if (reason) { skipped.push({ event_id: c.transactionId, reason }); continue; }
      if (alreadySent.has(c.transactionId)) { skipped.push({ event_id: c.transactionId, reason: 'already_sent' }); continue; }
      sendable.push(c);
    }

    if (!sendable.length) {
      return { configured: true, conversionType, period: range, testMode: mode.testMode, sent: 0, candidates: candidates.length, skipped };
    }

    const events = sendable.map(buildEvent);
    try {
      const resp = await sendEvents(events, { testCode: mode.testMode ? mode.testCode : undefined, fetchImpl });
      const status = mode.testMode ? VALIDATED : SENT;
      await Promise.all(sendable.map((c) => logUpload(c, { status, testMode: mode.testMode, eventsReceived: resp.events_received })
        .catch((e) => logger.warn(`[meta-capi] log write failed: ${e.message}`))));
      return {
        configured: true, conversionType, period: range, testMode: mode.testMode,
        sent: mode.testMode ? 0 : sendable.length, validated: mode.testMode ? sendable.length : 0,
        eventsReceived: resp.events_received ?? null, candidates: candidates.length, skipped,
      };
    } catch (err) {
      logger.error(`[meta-capi] upload failed (${conversionType}): ${err.message}`);
      await Promise.all(sendable.map((c) => logUpload(c, { status: 'failed', testMode: mode.testMode, errorMessage: err.message })
        .catch(() => {})));
      return { configured: true, conversionType, period: range, testMode: mode.testMode, sent: 0, candidates: candidates.length, skipped, error: err.message };
    }
  });
}

async function buildReadiness({ periodDays = 90, limit = 50 } = {}) {
  const range = dateRange(periodDays);
  const mode = resolveMode(false);
  const conversions = {};
  for (const conversionType of Object.keys(EVENT_NAMES)) {
    try {
      const candidates = await collectCandidates(conversionType, { ...range, limit });
      const counts = { total: candidates.length, eligible: 0, missingMatchKeys: 0, missingConversionValue: 0 };
      for (const c of candidates) {
        const r = skipReason(c);
        if (!r) counts.eligible += 1;
        else if (r === 'missing_match_keys') counts.missingMatchKeys += 1;
        else if (r === 'missing_conversion_value') counts.missingConversionValue += 1;
      }
      conversions[conversionType] = { eventName: EVENT_NAMES[conversionType], candidates: counts };
    } catch (err) {
      conversions[conversionType] = { eventName: EVENT_NAMES[conversionType], error: err.message };
    }
  }
  return {
    configured: isConfigured(),
    endpoint: 'Meta Conversions API (events)',
    liveUploadsAllowed: mode.live,
    testEventCodeSet: !!mode.testCode,
    period: range,
    conversions,
  };
}

module.exports = {
  isConfigured,
  uploadConversions,
  buildReadiness,
  _private: {
    apiVersion, pixelId, buildUserData, buildEvent, skipReason, matchKeySummary, resolveMode, toUnixSeconds, EVENT_NAMES,
  },
};
