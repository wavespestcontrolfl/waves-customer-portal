/**
 * Intelligence Bar — Stripe Webhook-Health Ops Tools
 * server/services/intelligence-bar/stripe-ops-tools.js
 *
 * Read-only visibility into Stripe state the app cannot see locally:
 * webhook delivery (if the webhook never lands, nothing local records it)
 * and payment attempts that never completed (an abandoned/incomplete
 * PaymentIntent fires no completion webhook, so it never reaches the
 * database). Money/business data that DID land lives in the local database
 * and is served by the revenue/banking tools — these tools deliberately do
 * NOT duplicate that.
 *
 * Auth: reuses the STRIPE_SECRET_KEY already configured for payments. Every
 * call here is a GET; event payloads (which contain customer data) are never
 * returned — only event type, timing, and delivery state.
 *
 * There are NO write operations here. Anything that mutates Stripe state
 * goes through the billing services and their own controls.
 */

const logger = require('../logger');

const STRIPE_API_BASE = process.env.STRIPE_API_BASE || 'https://api.stripe.com';
const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_HOURS = 24;
const MAX_HOURS = 24 * 7;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_ENABLED_EVENTS_SHOWN = 25;
// Stripe retries webhooks for days; delivery_success=false also returns
// events whose first attempts are simply still in flight. Younger than this
// is normal retry churn, not a failure signal.
const RECENT_PENDING_MINUTES = 10;
const EVENTS_PAGE_SIZE = 50;
const MAX_EVENT_PAGES = 5;
// Abandoned drafts surface days after the attempt, so the intent window is
// wider than the webhook window.
const PI_DEFAULT_HOURS = 72;
const PI_MAX_HOURS = 24 * 30;
// Mirrors the Stripe dashboard's Incomplete bucket. Deliberately excludes
// requires_capture — the one-time card-hold flow parks legitimate
// authorizations there awaiting capture; a hold is not an abandoned draft.
const PI_INCOMPLETE_STATUSES = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action']);
// requires_action with pending ACH micro-deposit verification is an ACTIVE
// payment session, not an abandoned draft — prepaid-pi-guard.js detects the
// same subtype. Excluded from the "incomplete" aggregate; still reachable
// via an explicit status filter, with next_action_type distinguishing it.
const ACH_VERIFICATION_NEXT_ACTION = 'verify_with_microdeposits';
// Live re-fetches for intents surfaced by the attempt event sweep
// (event snapshots go stale — the intent may have succeeded since).
const RETRY_LOOKUP_CAP = 10;
// A retried attempt on a reused intent surfaces as payment_failed OR as
// requires_action (card stopped at 3DS — the webhook handler treats both;
// see stripe-webhook.js) — sweep both or 3DS-stalled retries are missed.
const RETRY_EVENT_TYPES = ['payment_intent.payment_failed', 'payment_intent.requires_action'];
const PI_STATUSES = [
  'incomplete', 'requires_payment_method', 'requires_confirmation', 'requires_action',
  'processing', 'requires_capture', 'canceled', 'succeeded',
];

const STRIPE_OPS_TOOLS = [
  {
    name: 'get_stripe_webhook_endpoints',
    description: `List the Stripe webhook endpoints with their status (enabled/disabled), API version, and which events they subscribe to. Use to verify an event type (e.g. refund.failed) is actually subscribed.
Use for: "are the Stripe webhooks healthy?", "do we subscribe to refund.failed?", "is the webhook endpoint disabled?"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_stripe_webhook_failures',
    description: `Get recent Stripe events where webhook delivery FAILED for at least one endpoint (default last 24h). These are events the app may never have processed.
Use for: "did we miss any Stripe events?", "webhook delivery failures today?"`,
    input_schema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: `Look-back window in hours (default ${DEFAULT_HOURS}, max ${MAX_HOURS})` },
        limit: { type: 'number', description: `Max events to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
      },
    },
  },
  {
    name: 'get_stripe_payment_intents',
    description: `List recent Stripe PaymentIntents (live processor data), filterable by status and exact amount. This is the ONLY view of payment attempts that never completed — an incomplete "draft" fires no completion webhook, so it never reaches the local database and the revenue/banking tools cannot see it. The window covers intents CREATED in it plus older reused intents with a failed or action-stalled ATTEMPT in it (created_before_window + last_attempt_at mark those). last_payment_error.payment_method_type is the method the failed attempt actually used (payment_method_types is just the allowlist). Completed revenue questions still belong to the revenue tools.
Use for: "any incomplete payments?", "find the $33.33 drafts in Stripe", "did that payment attempt fail, and why?"`,
    input_schema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: `Look-back window in hours (default ${PI_DEFAULT_HOURS}, max ${PI_MAX_HOURS})` },
        status: {
          type: 'string',
          enum: PI_STATUSES,
          description: `Filter to one status. "incomplete" matches the dashboard's Incomplete bucket (requires_payment_method / requires_confirmation / requires_action) but excludes active ACH micro-deposit verifications (next_action_type verify_with_microdeposits — an in-progress bank payment, not abandoned). Note: requires_capture is a legitimate card hold awaiting capture, NOT an abandoned draft.`,
        },
        amount: { type: 'number', description: 'Match an exact amount in dollars (e.g. 33.33)' },
        limit: { type: 'number', description: `Max intents to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
      },
    },
  },
];

const NOT_CONFIGURED_MESSAGE = 'Stripe access is not configured. STRIPE_SECRET_KEY must be set in the Railway dashboard.';

async function stripeGet(path, params = {}) {
  const url = new URL(`${STRIPE_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    // Stripe repeats array params (types[]=a&types[]=b)
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.set(key, value);
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('Stripe rejected the key — check STRIPE_SECRET_KEY.');
    }
    if (!res.ok) throw new Error(`Stripe API returned HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Stripe API timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getStripeWebhookEndpoints() {
  const json = await stripeGet('/v1/webhook_endpoints', { limit: 10 });
  const endpoints = (json.data || []).map(e => {
    const events = e.enabled_events || [];
    return {
      id: e.id,
      url: e.url,
      status: e.status,
      api_version: e.api_version || 'account default',
      enabled_events: events.slice(0, MAX_ENABLED_EVENTS_SHOWN),
      enabled_events_total: events.length,
    };
  });
  return { endpoints, total: endpoints.length };
}

async function getStripeWebhookFailures(input) {
  const hours = Math.min(Math.max(Number(input.hours) || DEFAULT_HOURS, 1), MAX_HOURS);
  const limit = Math.min(Math.max(Number(input.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const createdGte = Math.floor((Date.now() - hours * 60 * 60 * 1000) / 1000);
  // Event payloads carry customer data — only type/timing/delivery state
  // leave this function.
  const pendingCutoff = Date.now() - RECENT_PENDING_MINUTES * 60 * 1000;
  const failing = [];
  const recentPending = [];
  let recentPendingSeen = 0;
  let failingSeen = 0;
  // Events come newest-first, so a burst of fresh pending deliveries can
  // fill the first page and hide older, genuinely failed events — page
  // (via starting_after) until enough real failures are collected or the
  // window is exhausted.
  let startingAfter = null;
  let pagesFetched = 0;
  let morePages = true;
  while (morePages && pagesFetched < MAX_EVENT_PAGES && failing.length < limit) {
    const params = { delivery_success: 'false', 'created[gte]': createdGte, limit: EVENTS_PAGE_SIZE };
    if (startingAfter) params.starting_after = startingAfter;
    const json = await stripeGet('/v1/events', params);
    pagesFetched += 1;
    const data = json.data || [];
    for (const e of data) {
      const createdMs = e.created * 1000;
      const mapped = {
        id: e.id,
        type: e.type,
        created: new Date(createdMs).toISOString(),
        pending_webhooks: e.pending_webhooks,
      };
      // Young events are usually mid-delivery, not failures — splitting them
      // out keeps a routine health check from raising false alarms.
      if (createdMs >= pendingCutoff) {
        recentPendingSeen += 1;
        if (recentPending.length < limit) recentPending.push(mapped);
      } else {
        failingSeen += 1;
        if (failing.length < limit) failing.push(mapped);
      }
    }
    morePages = Boolean(json.has_more) && data.length > 0;
    startingAfter = data.length ? data[data.length - 1].id : null;
  }
  return {
    window_hours: hours,
    undelivered_events: failing,
    recent_pending_events: recentPending,
    total_undelivered: failingSeen,
    total_recent_pending: recentPendingSeen,
    // Pending pages, or failures seen beyond the reported cap, both mean the
    // window may hold more failures than shown.
    scan_exhaustive: !morePages && failingSeen === failing.length,
    note: `Events younger than ${RECENT_PENDING_MINUTES} min are listed as recent_pending (likely still delivering, not failures). Event payloads are never exposed through the Intelligence Bar.`,
  };
}

function paymentIntentMatchesStatus(pi, filter) {
  if (!filter) return true;
  if (filter === 'incomplete') {
    if (!PI_INCOMPLETE_STATUSES.has(pi.status)) return false;
    // An in-progress ACH micro-deposit verification is not abandoned.
    return (pi.next_action && pi.next_action.type) !== ACH_VERIFICATION_NEXT_ACTION;
  }
  return pi.status === filter;
}

// Only identifiers, money state, and failure codes leave this mapper — never
// receipt emails, shipping/billing details, or raw charge/payment-method
// objects. `description` is app-written and can embed a customer name, which
// is why the tool is in the route's PII redaction set.
function mapPaymentIntent(pi) {
  const out = {
    id: pi.id,
    amount: Number((pi.amount / 100).toFixed(2)),
    currency: pi.currency,
    status: pi.status,
    created: new Date(pi.created * 1000).toISOString(),
    customer: pi.customer || null,
    description: pi.description || null,
    payment_method_types: pi.payment_method_types || [],
    // Type only, never the next_action object (it carries redirect/hosted
    // URLs). Distinguishes active flows (e.g. verify_with_microdeposits)
    // from truly abandoned drafts.
    next_action_type: (pi.next_action && pi.next_action.type) || null,
  };
  if (pi.last_payment_error) {
    out.last_payment_error = {
      code: pi.last_payment_error.code || null,
      decline_code: pi.last_payment_error.decline_code || null,
      message: pi.last_payment_error.message || null,
      // payment_method_types is only the ALLOWLIST — this is the method the
      // failed attempt actually used (type only, never the card object).
      payment_method_type: (pi.last_payment_error.payment_method && pi.last_payment_error.payment_method.type) || null,
    };
  }
  if (pi.status === 'canceled') {
    out.canceled_at = pi.canceled_at ? new Date(pi.canceled_at * 1000).toISOString() : null;
    out.cancellation_reason = pi.cancellation_reason || null;
  }
  return out;
}

async function getStripePaymentIntents(input) {
  const hours = Math.min(Math.max(Number(input.hours) || PI_DEFAULT_HOURS, 1), PI_MAX_HOURS);
  const limit = Math.min(Math.max(Number(input.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const statusFilter = typeof input.status === 'string' ? input.status.trim().toLowerCase() : null;
  const amountNumber = Number(input.amount);
  const amountCents = Number.isFinite(amountNumber) && amountNumber > 0 ? Math.round(amountNumber * 100) : null;
  const createdGte = Math.floor((Date.now() - hours * 60 * 60 * 1000) / 1000);

  // The list API has no status/amount filters — page newest-first and filter
  // here, same shape as the webhook-failures scan. matchedSeen keeps counting
  // past the display cap so totals stay honest when a page holds more matches
  // than the limit.
  const matched = [];
  const scannedIds = new Set();
  let matchedSeen = 0;
  let scanned = 0;
  const considerIntent = (pi, extra) => {
    scannedIds.add(pi.id);
    scanned += 1;
    if (!paymentIntentMatchesStatus(pi, statusFilter)) return;
    if (amountCents !== null && pi.amount !== amountCents) return;
    matchedSeen += 1;
    if (matched.length < limit) matched.push({ ...mapPaymentIntent(pi), ...extra });
  };
  let startingAfter = null;
  let pagesFetched = 0;
  let morePages = true;
  while (morePages && pagesFetched < MAX_EVENT_PAGES && matched.length < limit) {
    const params = { 'created[gte]': createdGte, limit: EVENTS_PAGE_SIZE };
    if (startingAfter) params.starting_after = startingAfter;
    const json = await stripeGet('/v1/payment_intents', params);
    pagesFetched += 1;
    const data = json.data || [];
    for (const pi of data) considerIntent(pi, undefined);
    morePages = Boolean(json.has_more) && data.length > 0;
    startingAfter = data.length ? data[data.length - 1].id : null;
  }

  // The list API bounds by ORIGINAL creation time, but the portal reuses
  // requires_payment_method intents across retries (stripe.js payment
  // flows), so an attempt today on an intent created before the window
  // would be invisible to the scan above. Sweep attempt events
  // (payment_failed + requires_action — a card stopped at 3DS emits the
  // latter) in the same window and re-fetch the LIVE intent for any id the
  // scan didn't cover (event snapshots go stale); the same filters apply to
  // the live state. Runs for every status filter — an older intent can fail
  // inside the window and be succeeded (or canceled) by now, and its live
  // state is what the filter sees.
  let retrySweepExhaustive = true;
  let retryLookupsDropped = 0;
  let retryLookupFailures = 0;
  {
    // id → newest in-window attempt event time (events arrive newest-first)
    const retryCandidates = new Map();
    let eventsAfter = null;
    let eventPages = 0;
    let moreEvents = true;
    while (moreEvents && eventPages < MAX_EVENT_PAGES) {
      const params = { 'types[]': RETRY_EVENT_TYPES, 'created[gte]': createdGte, limit: EVENTS_PAGE_SIZE };
      if (eventsAfter) params.starting_after = eventsAfter;
      const json = await stripeGet('/v1/events', params);
      eventPages += 1;
      const data = json.data || [];
      for (const event of data) {
        const snapshot = event.data && event.data.object;
        if (!snapshot || !snapshot.id) continue;
        if (scannedIds.has(snapshot.id) || retryCandidates.has(snapshot.id)) continue;
        retryCandidates.set(snapshot.id, event.created);
      }
      moreEvents = Boolean(json.has_more) && data.length > 0;
      eventsAfter = data.length ? data[data.length - 1].id : null;
    }
    retrySweepExhaustive = !moreEvents;
    retryLookupsDropped = Math.max(0, retryCandidates.size - RETRY_LOOKUP_CAP);
    // Concurrent lookups bound the whole phase to ~one request timeout
    // instead of cap × timeout when Stripe degrades. Results are folded in
    // candidate order so output stays deterministic.
    const candidateEntries = [...retryCandidates.entries()].slice(0, RETRY_LOOKUP_CAP);
    const lookups = await Promise.allSettled(
      candidateEntries.map(([id]) => stripeGet(`/v1/payment_intents/${id}`)),
    );
    for (let i = 0; i < lookups.length; i++) {
      const lookup = lookups[i];
      if (lookup.status !== 'fulfilled') {
        // An unevaluated candidate means the window may hold more than
        // shown — reported via retry_lookup_failures and scan_exhaustive.
        retryLookupFailures += 1;
        logger.warn(`[intelligence-bar:stripe-ops] Retry-sweep lookup failed: ${lookup.reason && lookup.reason.message}`);
        continue;
      }
      const pi = lookup.value;
      const attemptAt = candidateEntries[i][1];
      // Only present because an attempt happened inside the window — carry
      // when it happened (the intent's created can be weeks older), and flag
      // intents that predate the window.
      considerIntent(pi, {
        last_attempt_at: new Date(attemptAt * 1000).toISOString(),
        ...(pi.created < createdGte ? { created_before_window: true } : {}),
      });
    }
  }

  return {
    window_hours: hours,
    status_filter: statusFilter,
    amount_filter: amountCents !== null ? Number((amountCents / 100).toFixed(2)) : null,
    payment_intents: matched,
    total_matched: matchedSeen,
    total_scanned: scanned,
    retry_lookup_failures: retryLookupFailures,
    // Pending pages, matches beyond the display cap, a truncated retry
    // sweep, or a failed lookup all mean the window may hold more than
    // shown.
    scan_exhaustive: !morePages && matchedSeen === matched.length
      && retrySweepExhaustive && retryLookupsDropped === 0 && retryLookupFailures === 0,
    note: 'Live Stripe data; amounts are dollars. Incomplete intents never reach the local database, so the revenue tools cannot see them. requires_capture intents are card holds awaiting capture, and next_action_type verify_with_microdeposits marks an active ACH verification — neither is an abandoned draft. created_before_window marks an older intent surfaced by an in-window attempt; last_attempt_at is when that attempt happened.',
  };
}

async function executeStripeOpsTool(toolName, input = {}) {
  // "Not configured" is the expected DARK state, not a failure — an
  // { error } result would count against the shared admin circuit breaker
  // (see ops-tools.js for the full rationale).
  if (!process.env.STRIPE_SECRET_KEY) {
    return { configured: false, message: NOT_CONFIGURED_MESSAGE };
  }
  try {
    switch (toolName) {
      case 'get_stripe_webhook_endpoints': return await getStripeWebhookEndpoints();
      case 'get_stripe_webhook_failures': return await getStripeWebhookFailures(input);
      case 'get_stripe_payment_intents': return await getStripePaymentIntents(input);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:stripe-ops] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { STRIPE_OPS_TOOLS, executeStripeOpsTool };
