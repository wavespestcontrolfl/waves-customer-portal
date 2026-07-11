/**
 * Intelligence Bar — Stripe Webhook-Health Ops Tools
 * server/services/intelligence-bar/stripe-ops-tools.js
 *
 * Read-only visibility into Stripe webhook delivery — the one billing
 * failure mode that is invisible to the app by definition (if the webhook
 * never lands, nothing local records it). Money/business data itself lives
 * in the local database and is served by the revenue/banking tools — these
 * tools deliberately do NOT duplicate that.
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
];

const NOT_CONFIGURED_MESSAGE = 'Stripe access is not configured. STRIPE_SECRET_KEY must be set in the Railway dashboard.';

async function stripeGet(path, params = {}) {
  const url = new URL(`${STRIPE_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
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
  const json = await stripeGet('/v1/events', {
    delivery_success: 'false',
    'created[gte]': createdGte,
    limit,
  });
  // Event payloads carry customer data — only type/timing/delivery state
  // leave this function.
  const events = (json.data || []).map(e => ({
    id: e.id,
    type: e.type,
    created: new Date(e.created * 1000).toISOString(),
    pending_webhooks: e.pending_webhooks,
  }));
  return {
    window_hours: hours,
    undelivered_events: events,
    total: events.length,
    has_more: Boolean(json.has_more),
    note: 'Event payloads are never exposed through the Intelligence Bar.',
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
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:stripe-ops] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { STRIPE_OPS_TOOLS, executeStripeOpsTool };
