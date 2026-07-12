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
 * There are NO write operations here — no sending, redacting, or deleting.
 * Anything that sends or mutates goes through the existing comms tools and
 * their write gates.
 */

const logger = require('../logger');

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
];

const NOT_CONFIGURED_MESSAGE = 'Twilio access is not configured. TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in the Railway dashboard.';

function clampHours(hours) {
  return Math.min(Math.max(Number(hours) || DEFAULT_HOURS, 1), MAX_HOURS);
}

function clampLimit(limit) {
  return Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
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

async function executeTwilioOpsTool(toolName, input = {}) {
  // "Not configured" is the expected DARK state, not a failure — an
  // { error } result would count against the shared admin circuit breaker
  // (see ops-tools.js for the full rationale).
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    return { configured: false, message: NOT_CONFIGURED_MESSAGE };
  }
  try {
    switch (toolName) {
      case 'get_twilio_alerts': return await getTwilioAlerts(input);
      case 'get_twilio_failed_messages': return await getTwilioFailedMessages(input);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:twilio-ops] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { TWILIO_OPS_TOOLS, executeTwilioOpsTool };
