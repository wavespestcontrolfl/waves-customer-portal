/**
 * Intelligence Bar — SendGrid Deliverability Ops Tools
 * server/services/intelligence-bar/sendgrid-ops-tools.js
 *
 * Read-only visibility into email deliverability — bounces, blocks, and spam
 * reports. A bounced email fails silently from the operator's point of view
 * (the app "sent" it), and a suppressed address will swallow every future
 * send; both have already cost real customer touches. These tools ask
 * SendGrid directly.
 *
 * Auth: reuses the SENDGRID_API_KEY already configured for sending. All
 * reads; suppression list CHANGES stay in the SendGrid dashboard and the
 * bounce-recovery service. Results carry customer email addresses — both
 * tools are in the route's PII redaction set.
 */

const logger = require('../logger');

const SENDGRID_API_BASE = process.env.SENDGRID_API_BASE || 'https://api.sendgrid.com/v3';
const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_HOURS = 24 * 7;
const MAX_HOURS = 24 * 30;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const MAX_REASON_LENGTH = 200;

// The suppression lists a normal send can land on (global unsubscribes are
// /suppression/unsubscribes on the list API), plus permanent invalid
// addresses for the per-email check. ASM group unsubscribes are a separate
// API (/asm/suppressions) — the per-email check covers those too, since the
// newsletter/service sends here use asm groups and a group unsubscribe
// silently drops exactly those sends.
const SUPPRESSION_LISTS = ['bounces', 'blocks', 'spam_reports', 'unsubscribes'];
const PER_EMAIL_LISTS = ['bounces', 'blocks', 'spam_reports', 'invalid_emails'];

const SENDGRID_OPS_TOOLS = [
  {
    name: 'get_email_suppressions',
    description: `Recent SendGrid bounces, blocks, spam reports, and global unsubscribes (default last 7 days). Every address here silently swallows sends — the app reports success, the customer never sees the email.
Use for: "any bounced emails this week?", "did our emails deliver?", "who reported us as spam or unsubscribed?"`,
    input_schema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: `Look-back window in hours (default ${DEFAULT_HOURS}, max ${MAX_HOURS})` },
        limit: { type: 'number', description: `Max entries per list (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
      },
    },
  },
  {
    name: 'check_email_suppression',
    description: `Check whether ONE email address is on any SendGrid suppression list (bounces, blocks, spam reports, invalid emails, global unsubscribe, or an ASM group unsubscribe) — the "why does this customer never get our emails?" lookup.
Use for: "is jane@example.com suppressed?", "why didn't the invoice email arrive?", "did they unsubscribe?"`,
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'The email address to check' },
      },
      required: ['email'],
    },
  },
];

const NOT_CONFIGURED_MESSAGE = 'SendGrid access is not configured. SENDGRID_API_KEY must be set in the Railway dashboard.';

async function sendgridGet(path, params = {}) {
  const url = new URL(`${SENDGRID_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('SendGrid rejected the key — check SENDGRID_API_KEY.');
    }
    // Per-email lookups return 404 on some list endpoints when the address
    // is absent — that is "not suppressed", not a failure.
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`SendGrid API returned HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`SendGrid API timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function mapSuppression(entry, list) {
  return {
    list,
    email: entry.email,
    created: entry.created ? new Date(entry.created * 1000).toISOString() : null,
    reason: entry.reason ? String(entry.reason).slice(0, MAX_REASON_LENGTH) : null,
    status: entry.status || null,
  };
}

async function getEmailSuppressions(input) {
  const hours = Math.min(Math.max(Number(input.hours) || DEFAULT_HOURS, 1), MAX_HOURS);
  const limit = Math.min(Math.max(Number(input.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const startTime = Math.floor((Date.now() - hours * 60 * 60 * 1000) / 1000);
  const results = await Promise.all(SUPPRESSION_LISTS.map(list =>
    sendgridGet(`/suppression/${list}`, { start_time: startTime, limit })
  ));
  const byList = {};
  let total = 0;
  SUPPRESSION_LISTS.forEach((list, i) => {
    const entries = (Array.isArray(results[i]) ? results[i] : []).map(e => mapSuppression(e, list));
    byList[list] = entries;
    total += entries.length;
  });
  return {
    window_hours: hours,
    ...byList,
    total,
    // A full page means the window may hold more than shown.
    possibly_truncated: SUPPRESSION_LISTS.some((list) => byList[list].length >= limit),
    note: 'Suppressed addresses swallow every future send silently. Removing an address from a suppression list happens in the SendGrid dashboard or the bounce-recovery flow, never through this tool.',
  };
}

async function checkEmailSuppression(input) {
  const email = String(input.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return { error: 'A valid email address is required' };
  }
  const [listResults, globalUnsub, asmGroups] = await Promise.all([
    Promise.all(PER_EMAIL_LISTS.map(list =>
      sendgridGet(`/suppression/${list}/${encodeURIComponent(email)}`)
    )),
    // Global unsubscribe: returns { recipient_email } when present, {} when not
    sendgridGet(`/asm/suppressions/global/${encodeURIComponent(email)}`),
    // ASM group memberships: { suppressions: [{ id, name, suppressed }] }
    sendgridGet(`/asm/suppressions/${encodeURIComponent(email)}`),
  ]);
  const listings = [];
  PER_EMAIL_LISTS.forEach((list, i) => {
    const raw = listResults[i];
    // Per-email endpoints return an array of matches (empty when absent);
    // blocks/invalid return {} on some accounts — normalize.
    const entries = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.result) ? raw.result : []);
    for (const entry of entries) {
      if (!entry || (entry.email && entry.email.toLowerCase() !== email)) continue;
      listings.push(mapSuppression({ ...entry, email }, list));
    }
  });
  if (globalUnsub && !Array.isArray(globalUnsub) && globalUnsub.recipient_email) {
    listings.push({ list: 'global_unsubscribe', email, created: null, reason: null, status: null });
  }
  const groupEntries = (asmGroups && Array.isArray(asmGroups.suppressions))
    ? asmGroups.suppressions.filter(g => g && g.suppressed)
    : [];
  for (const group of groupEntries) {
    listings.push({
      list: 'asm_group_unsubscribe',
      email,
      created: null,
      reason: `Unsubscribed from group "${group.name}" (id ${group.id})`,
      status: null,
    });
  }
  return {
    email,
    suppressed: listings.length > 0,
    listings,
    note: listings.length > 0
      ? 'This address will NOT receive the affected emails until it is removed from the list(s) above (SendGrid dashboard, bounce-recovery flow, or — for unsubscribes — the customer resubscribing). ASM group unsubscribes only block sends in that group.'
      : 'Not on any SendGrid suppression list, not globally unsubscribed, and not unsubscribed from any ASM group — if emails still fail, the problem is downstream (mailbox full, recipient-side filtering).',
  };
}

async function executeSendgridOpsTool(toolName, input = {}) {
  // "Not configured" is the expected DARK state, not a failure — an
  // { error } result would count against the shared admin circuit breaker
  // (see ops-tools.js for the full rationale).
  if (!process.env.SENDGRID_API_KEY) {
    return { configured: false, message: NOT_CONFIGURED_MESSAGE };
  }
  try {
    switch (toolName) {
      case 'get_email_suppressions': return await getEmailSuppressions(input);
      case 'check_email_suppression': return await checkEmailSuppression(input);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:sendgrid-ops] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { SENDGRID_OPS_TOOLS, executeSendgridOpsTool };
