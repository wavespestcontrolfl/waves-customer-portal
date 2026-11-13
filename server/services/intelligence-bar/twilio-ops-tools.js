/**
 * Intelligence Bar — Twilio Delivery-Health Ops Tools
 * server/services/intelligence-bar/twilio-ops-tools.js
 *
 * Read-only visibility into carrier-side SMS/voice health that the local
 * database cannot see: Twilio debugger alerts (webhook failures, carrier
 * errors) and recently failed/undelivered messages.
 *
 * Auth: reuses the TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN already configured
 * for messaging. Uses the REST API directly (Basic auth) so responses can be
 * shaped here — message BODIES are never returned, only delivery metadata.
 *
 * get_texting_opt_out answers "can this ONE number get our texts?". It
 * reads the app's own do-not-text list (messaging_suppression), the
 * blocked-numbers list and the texting switch on the customer account, then
 * asks Twilio for that number's recent failed texts. The three database reads
 * need no Twilio credentials.
 *
 * There are NO write operations here — no sending, redacting, or deleting.
 * Anything that sends or mutates goes through the existing comms tools and
 * their write gates.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { toE164, phoneMatchDigits } = require('../../utils/phone');

const TWILIO_API_BASE = process.env.TWILIO_API_BASE || 'https://api.twilio.com';
const TWILIO_MONITOR_BASE = process.env.TWILIO_MONITOR_BASE || 'https://monitor.twilio.com';
const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_HOURS = 24;
const MAX_HOURS = 24 * 7;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MESSAGES_PAGE_SIZE = 100;
const MAX_MESSAGE_PAGES = 5;
const MAX_ALERT_TEXT_CHARS = 300;
const NUMBER_FAILURE_DAYS = 7;
const NUMBER_FAILURE_LIMIT = 10;

// Plain-word meanings for the delivery error codes a failed text carries
// (twilio.com/docs/api/errors). A code not listed here returns no meaning;
// the carrier's own error_message still goes out beside it.
const ERROR_MEANINGS = Object.freeze({
  21211: 'Not a valid phone number.',
  21408: 'Sending to this region is not turned on for the account.',
  21610: 'The person opted out (texted STOP). No text reaches them until they text START.',
  21614: 'Not a mobile number, so it cannot get texts.',
  30003: 'The phone was unreachable: off, out of service, or not able to get texts.',
  30004: 'The message was blocked for this number by the carrier.',
  30005: 'The carrier does not know this number. It may no longer exist.',
  30006: 'Landline, or a carrier that cannot be reached.',
  30007: 'The carrier filtered the message as spam.',
  30008: 'The carrier gave no reason.',
  30034: 'Sent from a number that is not registered for business texting.',
});

// messaging_suppression.reason in plain words (the reasons the send path
// knows: services/messaging/validators/suppression.js).
const SUPPRESSION_MEANINGS = Object.freeze({
  opt_out_keyword: 'Replied STOP or another opt-out keyword.',
  opt_out_natural_language: 'Asked in their own words to stop the texts.',
  opt_out: 'The carrier reported that the person opted out.',
  wrong_number: 'Said we have the wrong number.',
  manual_dnc: 'Staff marked the number do-not-contact.',
  non_mobile: 'Landline or a line that cannot get texts.',
});

const TWILIO_OPS_TOOLS = [
  {
    name: 'get_twilio_alerts',
    description: `Get recent Twilio debugger alerts — carrier errors, webhook failures, misconfigured numbers — over a recent window (default 24h). Catches delivery problems the app database can't see.
Use for: "any Twilio errors today?", "are our webhooks failing?", "SMS deliverability problems?"`,
    input_schema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: `Look-back window in hours (default ${DEFAULT_HOURS}, max ${MAX_HOURS})` },
        limit: { type: 'number', description: `Max alerts to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
      },
    },
  },
  {
    name: 'get_twilio_failed_messages',
    description: `Get recently FAILED or UNDELIVERED SMS messages from Twilio (default last 24h) with their carrier error codes. Message bodies are never included — delivery metadata only.
Use for: "did any texts fail today?", "why didn't the customer get the reminder?"`,
    input_schema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: `Look-back window in hours (default ${DEFAULT_HOURS}, max ${MAX_HOURS})` },
        limit: { type: 'number', description: `Max messages to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
      },
    },
  },
  {
    name: 'get_texting_opt_out',
    description: `Whether a phone number can get our texts: on the texting opt-out list (an opt-out, a wrong number, a landline, a staff do-not-contact), a blocked number, and the carrier's reason when texts to it were undelivered.
Use for: "did this number opt out of texts?", "is this number blocked?", "why were texts to this number undelivered?"`,
    input_schema: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'The phone number to check' },
      },
      required: ['phone'],
    },
  },
];

// Tools that answer from the app database first: they run without Twilio
// credentials (the Twilio half reports itself unavailable).
const DATABASE_TOOL_NAMES = new Set(['get_texting_opt_out']);

const NOT_CONFIGURED_MESSAGE = 'Twilio access is not configured. TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in the Railway dashboard.';

function clampHours(hours) {
  return Math.min(Math.max(Number(hours) || DEFAULT_HOURS, 1), MAX_HOURS);
}

function clampLimit(limit) {
  return Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
}

function twilioConfigured() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

function errorMeaning(code) {
  return ERROR_MEANINGS[code] || null;
}

function truncate(text, max = MAX_ALERT_TEXT_CHARS) {
  if (typeof text !== 'string') return text;
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

// Alerts carry the webhook request URL, which can embed query-string data
// (tokens, phone numbers). Only the path ever leaves this function.
function urlPathOnly(rawUrl) {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return String(rawUrl).split('?')[0];
  }
}

async function twilioGet(base, path, params = {}) {
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('Twilio rejected the credentials — check TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN.');
    }
    if (!res.ok) throw new Error(`Twilio API returned HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Twilio API timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getTwilioAlerts(input) {
  const hours = clampHours(input.hours);
  const limit = clampLimit(input.limit);
  const startDate = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const json = await twilioGet(TWILIO_MONITOR_BASE, '/v1/Alerts', {
    StartDate: startDate,
    PageSize: limit,
  });
  const alerts = (json.alerts || []).map(a => ({
    date: a.date_generated,
    level: a.log_level,
    error_code: a.error_code,
    text: truncate(a.alert_text),
    request_path: urlPathOnly(a.request_url),
  }));
  return { window_hours: hours, alerts, total: alerts.length };
}

async function getTwilioFailedMessages(input) {
  const hours = clampHours(input.hours);
  const limit = clampLimit(input.limit);
  const since = Date.now() - hours * 60 * 60 * 1000;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  // The Messages list has no status filter — page through recent messages
  // (newest first) and filter here. `DateSent>` narrows server-side to the
  // window's first day; pagination stops once a page runs past the window,
  // the failure limit is filled, or the page cap is hit (busy accounts can
  // have thousands of messages — the cap keeps this bounded, and the
  // response says whether the scan was exhaustive).
  const failed = [];
  let scanned = 0;
  let pagesFetched = 0;
  let nextPath = `/2010-04-01/Accounts/${sid}/Messages.json`;
  let params = {
    PageSize: MESSAGES_PAGE_SIZE,
    'DateSent>': new Date(since).toISOString().slice(0, 10),
  };

  while (nextPath && pagesFetched < MAX_MESSAGE_PAGES && failed.length < limit) {
    const json = await twilioGet(TWILIO_API_BASE, nextPath, params);
    pagesFetched += 1;
    const messages = json.messages || [];
    scanned += messages.length;
    for (const m of messages) {
      if (failed.length >= limit) break;
      if (m.status !== 'failed' && m.status !== 'undelivered') continue;
      if (m.date_sent && new Date(m.date_sent).getTime() < since) continue;
      failed.push({
        sid: m.sid,
        to: m.to,
        direction: m.direction,
        status: m.status,
        error_code: m.error_code,
        error_meaning: errorMeaning(m.error_code),
        error_message: truncate(m.error_message),
        date_sent: m.date_sent,
      });
    }
    // Newest-first ordering: once the page's last message predates the
    // window, later pages are entirely outside it.
    const last = messages[messages.length - 1];
    const pastWindow = Boolean(last?.date_sent && new Date(last.date_sent).getTime() < since);
    nextPath = !pastWindow && json.next_page_uri ? json.next_page_uri : null;
    params = undefined; // next_page_uri already carries the query string
  }
  // A pending next page OR a filled failure limit means the window may hold
  // more failures than reported — only an under-limit, fully-paged scan is
  // exhaustive (hitting the limit can also strand the tail of the last page).
  const exhaustive = !nextPath && failed.length < limit;

  return {
    window_hours: hours,
    failed_messages: failed,
    total: failed.length,
    scanned_recent_messages: scanned,
    scan_exhaustive: exhaustive,
    note: 'Delivery metadata only — message bodies are never exposed through the Intelligence Bar.',
  };
}

// The do-not-text row for a number. The table keys on the phone, so a number
// has one row: active while texts are refused, inactive once a START (or
// staff) cleared it. Rows are written in E.164; the raw input is matched too,
// the same pair the send path reads (loadSuppressionState).
function doNotTextState(rows) {
  const row = rows.find(r => r.active) || rows[0];
  if (!row) return { listed: false };
  if (!row.active) {
    // reason 'cleared' is the marker a START leaves for a number that had no row.
    return { listed: false, removed_at: row.cleared_at, removed_by: truncate(row.source, 80) };
  }
  return {
    listed: true,
    reason: row.reason,
    meaning: SUPPRESSION_MEANINGS[row.reason] || 'Listed for another reason.',
    since: row.created_at,
    recorded_by: truncate(row.source, 80),
  };
}

function blockedNumberState(row) {
  if (!row) return { blocked: false };
  return {
    blocked: true,
    block_type: row.block_type,
    auto_blocked: Boolean(row.auto_blocked),
    blocked_at: row.blocked_at,
    reason: truncate(row.reason, 200),
  };
}

// The number's failed texts from Twilio, newest first. One page with the To
// filter is the whole read: a single number rarely has 100 texts in a week,
// and `complete` says so when it does. A Twilio failure never hides the
// database facts above it — this half reports itself unavailable instead.
async function recentFailedTexts(e164) {
  if (!twilioConfigured()) return { available: false, reason: NOT_CONFIGURED_MESSAGE };
  const since = Date.now() - NUMBER_FAILURE_DAYS * 24 * 60 * 60 * 1000;
  try {
    const json = await twilioGet(TWILIO_API_BASE, `/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      To: e164,
      PageSize: MESSAGES_PAGE_SIZE,
      'DateSent>': new Date(since).toISOString().slice(0, 10),
    });
    const failures = (json.messages || [])
      .filter(m => m.status === 'failed' || m.status === 'undelivered')
      .filter(m => !m.date_sent || new Date(m.date_sent).getTime() >= since)
      .map(m => ({
        status: m.status,
        error_code: m.error_code,
        error_meaning: errorMeaning(m.error_code),
        error_message: truncate(m.error_message),
        date_sent: m.date_sent,
      }));
    return {
      available: true,
      window_days: NUMBER_FAILURE_DAYS,
      total: failures.length,
      failures: failures.slice(0, NUMBER_FAILURE_LIMIT),
      complete: !json.next_page_uri,
    };
  } catch (err) {
    logger.warn(`[intelligence-bar:twilio-ops] failed-text read for one number failed: ${err.message}`);
    return { available: false, reason: err.message };
  }
}

async function checkSmsSuppression(input) {
  const raw = typeof input.phone === 'string' ? input.phone.trim() : '';
  const digits = phoneMatchDigits(raw);
  if (!digits.length) return { error: 'A valid phone number is required' };
  const e164 = toE164(raw);
  const stored = [...new Set([raw, e164])];

  // The three database reads throw to the caller: a failed read must come
  // back as an error, never as "not on the list".
  const [suppressionRows, blockRow, textsOff] = await Promise.all([
    db('messaging_suppression').whereIn('phone', stored)
      .select('reason', 'active', 'source', 'created_at', 'cleared_at'),
    db('blocked_numbers').whereIn('number', stored)
      .first('block_type', 'auto_blocked', 'blocked_at', 'reason'),
    // The account switch (notification_prefs.sms_enabled) stops every text to
    // a customer without any do-not-text row: a customer can turn texts off in
    // their own settings. Counted for accounts whose MAIN phone is this number.
    // The per-notice switches on the same row are not read here.
    db('customers as c')
      .join('notification_prefs as np', 'np.customer_id', 'c.id')
      .whereNull('c.deleted_at')
      .where('np.sms_enabled', false)
      .whereIn(db.raw("regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g')"), digits)
      .count({ count: '*' })
      .first(),
  ]);
  const doNotText = doNotTextState(suppressionRows);
  const blockedNumber = blockedNumberState(blockRow);
  const accountsWithTextsOff = Number(textsOff?.count || 0);

  return {
    phone_last4: e164.slice(-4),
    texts_refused: doNotText.listed || accountsWithTextsOff > 0,
    do_not_text: doNotText,
    accounts_with_texts_off: accountsWithTextsOff,
    blocked_number: blockedNumber,
    recent_failed_texts: await recentFailedTexts(e164),
    note: 'do_not_text and accounts_with_texts_off stop OUR texts to this number. blocked_number stops THEIR texts and calls from reaching us. Single notice types a customer turned off are not checked here. This tool only reads: a START text from the number removes an opt-out, and the block list is changed on the Communications page.',
  };
}

async function executeTwilioOpsTool(toolName, input = {}) {
  // "Not configured" is the expected DARK state, not a failure — an
  // { error } result would count against the shared admin circuit breaker
  // (see ops-tools.js for the full rationale).
  if (!twilioConfigured() && !DATABASE_TOOL_NAMES.has(toolName)) {
    return { configured: false, message: NOT_CONFIGURED_MESSAGE };
  }
  try {
    switch (toolName) {
      case 'get_twilio_alerts': return await getTwilioAlerts(input);
      case 'get_twilio_failed_messages': return await getTwilioFailedMessages(input);
      case 'get_texting_opt_out': return await checkSmsSuppression(input);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:twilio-ops] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { TWILIO_OPS_TOOLS, executeTwilioOpsTool };
