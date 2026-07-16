/**
 * Intelligence Bar — Admin API Route
 * server/routes/admin-intelligence-bar.js
 *
 * POST /api/admin/intelligence-bar/query
 *   Takes a natural language prompt from the admin portal,
 *   sends it to Claude Opus 4.6 with business-aware tools,
 *   and returns structured results + actions.
 *
 * POST /api/admin/intelligence-bar/execute
 *   Executes a confirmed action (update, schedule, SMS send)
 *   that was previously proposed by the intelligence bar.
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { TOOLS, executeTool } = require('../services/intelligence-bar/tools');
const { SCHEDULE_TOOLS, executeScheduleTool } = require('../services/intelligence-bar/schedule-tools');
const { DASHBOARD_TOOLS, executeDashboardTool } = require('../services/intelligence-bar/dashboard-tools');
const { SEO_TOOLS, executeSeoTool } = require('../services/intelligence-bar/seo-tools');
const { PROCUREMENT_TOOLS, executeProcurementTool } = require('../services/intelligence-bar/procurement-tools');
const { REVENUE_TOOLS, executeRevenueTool } = require('../services/intelligence-bar/revenue-tools');
const { TECH_TOOLS, executeTechTool } = require('../services/intelligence-bar/tech-tools');
const { REVIEW_TOOLS, executeReviewTool } = require('../services/intelligence-bar/review-tools');
const { COMMS_TOOLS, COMMS_READ_TOOLS = [], executeCommsTool } = require('../services/intelligence-bar/comms-tools');
const { TAX_TOOLS, executeTaxTool } = require('../services/intelligence-bar/tax-tools');
const { LEADS_TOOLS, executeLeadsTool } = require('../services/intelligence-bar/leads-tools');
const { EMAIL_TOOLS, EMAIL_SHARED_TOOLS = [], executeEmailTool } = require('../services/intelligence-bar/email-tools');
const { BANKING_TOOLS, BANKING_QUERY_TOOLS, executeBankingTool } = require('../services/intelligence-bar/banking-tools');
const { ESTIMATE_TOOLS, executeEstimateTool } = require('../services/intelligence-bar/estimate-tools');
const { OPS_TOOLS, executeOpsTool } = require('../services/intelligence-bar/ops-tools');
const { SENTRY_OPS_TOOLS, executeSentryOpsTool } = require('../services/intelligence-bar/sentry-ops-tools');
const { CLOUDFLARE_OPS_TOOLS, executeCloudflareOpsTool } = require('../services/intelligence-bar/cloudflare-ops-tools');
const { TWILIO_OPS_TOOLS, executeTwilioOpsTool } = require('../services/intelligence-bar/twilio-ops-tools');
const { STRIPE_OPS_TOOLS, executeStripeOpsTool } = require('../services/intelligence-bar/stripe-ops-tools');
const { GITHUB_OPS_TOOLS, executeGithubOpsTool } = require('../services/intelligence-bar/github-ops-tools');
const { STORE_OPS_TOOLS, executeStoreOpsTool } = require('../services/intelligence-bar/store-ops-tools');
const { GROWTHBOOK_TOOLS, executeGrowthbookTool } = require('../services/intelligence-bar/growthbook-tools');
const { UI_GATED_WRITE_TOOL_NAMES, WRITE_TWO_STEP_TOOL_NAMES } = require('../services/intelligence-bar/write-gates');
const PendingActions = require('../services/intelligence-bar/pending-actions');
const { getBreaker } = require('../services/intelligence-bar/circuit-breaker');
const { recordToolEvent } = require('../services/intelligence-bar/tool-events');
const { isUserFeatureEnabled } = require('../services/feature-flags');
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');

const adminToolBreaker = getBreaker('intelligence-bar');
const SEO_CONFIRMED_ACTION_TOOL_NAMES = new Set(['run_seo_pipeline', 'approve_seo_action']);
const CONFIRMED_ACTION_TOOL_NAMES = new Set([
  'request_instant_payout',
  'request_standard_payout',
  ...SEO_CONFIRMED_ACTION_TOOL_NAMES,
]);

function isToolFailure(result) {
  return result && typeof result === 'object' && (result.error || result.failed === true);
}

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const MODELS = require('../config/models');

router.use(adminAuthenticate, requireTechOrAdmin);

const MODEL = process.env.INTELLIGENCE_BAR_MODEL || MODELS.FLAGSHIP;
const MAX_TOOL_ROUNDS = 8;
const IDEMPOTENCY_KEY_RE = /^[a-zA-Z0-9._:-]{8,120}$/;
const AGENT_ESTIMATE_FEATURE_KEY = 'agent_estimate';
const AGENT_ESTIMATE_WRITE_TOOL = 'create_agent_estimate_draft';

// Schedule tool names for routing execution
const SCHEDULE_TOOL_NAMES = new Set(SCHEDULE_TOOLS.map(t => t.name));
const DASHBOARD_TOOL_NAMES = new Set(DASHBOARD_TOOLS.map(t => t.name));
const SEO_TOOL_NAMES = new Set(SEO_TOOLS.map(t => t.name));
const PROCUREMENT_TOOL_NAMES = new Set(PROCUREMENT_TOOLS.map(t => t.name));
const REVENUE_TOOL_NAMES = new Set(REVENUE_TOOLS.map(t => t.name));
const TECH_TOOL_NAMES = new Set(TECH_TOOLS.map(t => t.name));
const REVIEW_TOOL_NAMES = new Set(REVIEW_TOOLS.map(t => t.name));
const COMMS_TOOL_NAMES = new Set(COMMS_TOOLS.map(t => t.name));
const TAX_TOOL_NAMES = new Set(TAX_TOOLS.map(t => t.name));
const LEADS_TOOL_NAMES = new Set(LEADS_TOOLS.map(t => t.name));
const EMAIL_TOOL_NAMES = new Set(EMAIL_TOOLS.map(t => t.name));
const BANKING_TOOL_NAMES = new Set(BANKING_TOOLS.map(t => t.name));
const ESTIMATE_TOOL_NAMES = new Set(ESTIMATE_TOOLS.map(t => t.name));
const OPS_TOOL_NAMES = new Set(OPS_TOOLS.map(t => t.name));
const SENTRY_OPS_TOOL_NAMES = new Set(SENTRY_OPS_TOOLS.map(t => t.name));
const CLOUDFLARE_OPS_TOOL_NAMES = new Set(CLOUDFLARE_OPS_TOOLS.map(t => t.name));
const TWILIO_OPS_TOOL_NAMES = new Set(TWILIO_OPS_TOOLS.map(t => t.name));
const STRIPE_OPS_TOOL_NAMES = new Set(STRIPE_OPS_TOOLS.map(t => t.name));
const GITHUB_OPS_TOOL_NAMES = new Set(GITHUB_OPS_TOOLS.map(t => t.name));
const STORE_OPS_TOOL_NAMES = new Set(STORE_OPS_TOOLS.map(t => t.name));
const GROWTHBOOK_TOOL_NAMES = new Set(GROWTHBOOK_TOOLS.map(t => t.name));
// Every infra module loads with the dashboard context and shares the
// admin-only guard that OPS_TOOLS established.
const INFRA_TOOLS = [
  ...OPS_TOOLS, ...SENTRY_OPS_TOOLS, ...CLOUDFLARE_OPS_TOOLS,
  ...TWILIO_OPS_TOOLS, ...STRIPE_OPS_TOOLS, ...GITHUB_OPS_TOOLS,
  ...STORE_OPS_TOOLS, ...GROWTHBOOK_TOOLS,
];
const INFRA_TOOL_NAMES = new Set(INFRA_TOOLS.map(t => t.name));
const SEO_QUERY_TOOLS = SEO_TOOLS.filter(t => !SEO_CONFIRMED_ACTION_TOOL_NAMES.has(t.name));

// Base toolset for every admin context: core customer/schedule/revenue tools
// plus read-only comms tools and the email read+reply subset, so SMS/call
// history and the inbox are visible from any page — not just the
// Communications/Email pages.
const BASE_TOOLS = [...TOOLS, ...COMMS_READ_TOOLS, ...EMAIL_SHARED_TOOLS];

function toolsNamed(tools, names) {
  const allowed = new Set(names);
  return tools.filter((tool) => allowed.has(tool.name));
}

// The Agent Estimate page gets a deliberately narrow tool cabinet. Property
// truth, pricing, protocols, and inventory are readable; its one write can
// only create/revise a draft through the UI-confirmation path. It cannot send,
// schedule, update a lead, or reach any other business-data write.
const AGENT_ESTIMATE_TOOLS = [
  ...toolsNamed(ESTIMATE_TOOLS, [
    'lookup_property',
    'compute_estimate',
    'read_pricing_config',
    'recent_pricing_changes',
    'find_similar_estimates',
    'match_existing_customer',
    'get_waveguard_tiers',
    'get_neighborhood_grass_profile',
    AGENT_ESTIMATE_WRITE_TOOL,
  ]),
  ...toolsNamed(TECH_TOOLS, ['get_protocol', 'get_product_info', 'search_knowledge_base']),
  ...toolsNamed(PROCUREMENT_TOOLS, ['query_products', 'analyze_margins', 'query_stock']),
];

// Tools whose REST equivalents guard with requireAdmin — technician tokens
// must not reach them through the intelligence bar either. The email surface
// (/api/admin/email) is requireAdmin, so every email tool is admin-only:
// this set blocks execution in the /query loop, /execute, and
// /confirm-action; getToolsForContext additionally hides them from
// non-admin tool lists.
const ADMIN_ONLY_TOOL_NAMES = new Set([
  'create_customer',
  ...EMAIL_TOOLS.map(t => t.name),
]);

// Tool calls whose inputs/outputs carry customer PII (names, phones, emails,
// addresses, SMS bodies). Their params and the surrounding prompt/response
// are redacted from logs and query telemetry per the PII-in-logs rule.
const PII_TOOL_NAMES = new Set([
  'create_customer',
  'update_property_access',
  'get_stop_details',
  'get_unanswered_threads',
  'get_conversation_thread',
  'search_messages',
  'get_call_log',
  'list_call_partners',
  'get_partner_call_history',
  'send_sms',
  'draft_sms_reply',
  'draft_sms',
  'lookup_property',
  'find_similar_estimates',
  'match_existing_customer',
  'create_pending_estimate',
  AGENT_ESTIMATE_WRITE_TOOL,
  // Email tools return sender names/addresses and message bodies, and reply
  // inputs carry the drafted body — same class of PII as the comms tools.
  'get_inbox_summary',
  'search_emails',
  'get_email_thread',
  'draft_email_reply',
  'send_email_reply',
  'reply_via_sms',
  'get_stock_movements',
  // Railway runtime logs can echo customer identifiers from app logging —
  // redact like any other PII-bearing tool result.
  'get_railway_logs',
  // Sentry reports with sendDefaultPii — issue titles, culprits, and event
  // messages/values can embed customer emails, phones, or request data.
  'get_sentry_top_issues',
  'get_sentry_new_issues',
  'get_sentry_issue_detail',
  // Twilio results carry recipient phone numbers (and alert texts can echo
  // them) — redact like the comms tools.
  'get_twilio_alerts',
  'get_twilio_failed_messages',
  // GrowthBook feature rules expose raw targeting `condition` predicates,
  // which are arbitrary attribute strings that can embed customer emails or
  // user identifiers — keep them out of query telemetry.
  'get_growthbook_features',
  'get_growthbook_experiments',
]);

function isNonAdminDashboardRequest(req) {
  return req.techRole !== 'admin';
}

// Photo attachments (vision). The operator/tech can attach images to a query —
// a screenshot of a portal page, a pest/insect to ID, a property condition.
// Images apply to the turn they're sent on; they are NOT persisted into the
// returned conversationHistory (a text marker stands in for them) so multi-turn
// payloads don't balloon and image bytes never land in query telemetry.
const MAX_QUERY_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Anthropic per-image decoded-size cap
const ALLOWED_IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
// Stack-safe (sliced) validation — a whole-string regex on a multi-megabyte
// payload is the CI-only 500 flake; see server/utils/base64-validate.js.
const { isValidBase64 } = require('../utils/base64-validate');
const IMAGE_TAINT_MARKER = '[Image attachment context may contain PII]';
const IMAGE_ATTACHMENT_HISTORY_RE = /\[Operator attached \d+ image(?:s)?\]/;

// Validate attachments server-side — never trust the client downscaler. Drop
// anything with an unsupported media type, non-base64 data, or a decoded size
// over the provider's per-image cap, so a stale/malformed/direct-API payload
// can't burn an AI request on a guaranteed provider error. Unsupported types
// are dropped, never relabeled. The size cap runs before base64 validation:
// it's plain arithmetic, and an oversized payload should never be scanned.
function sanitizeQueryImages(images) {
  if (!Array.isArray(images)) return [];
  const out = [];
  for (const img of images) {
    if (out.length >= MAX_QUERY_IMAGES) break;
    if (!img || !ALLOWED_IMAGE_MEDIA_TYPES.has(img.mediaType)) continue;
    if (typeof img.data !== 'string' || Math.floor((img.data.length * 3) / 4) > MAX_IMAGE_BYTES) continue;
    if (!isValidBase64(img.data)) continue;
    out.push({ mediaType: img.mediaType, data: img.data });
  }
  return out;
}

function hasImageTaintedHistory(conversationHistory) {
  if (!Array.isArray(conversationHistory)) return false;
  return conversationHistory.some((message) => {
    if (!message || typeof message.content !== 'string') return false;
    return message.content.includes(IMAGE_TAINT_MARKER)
      || IMAGE_ATTACHMENT_HISTORY_RE.test(message.content);
  });
}

function stripInternalHistoryMarkers(message) {
  if (!message || typeof message.content !== 'string') return message;
  return {
    ...message,
    content: message.content
      .split('\n')
      .filter((line) => line.trim() !== IMAGE_TAINT_MARKER)
      .join('\n')
      .trim(),
  };
}

function markImageTaintedContent(content, imageTainted) {
  if (!imageTainted || typeof content !== 'string' || content.includes(IMAGE_TAINT_MARKER)) {
    return content;
  }
  return `${content}\n${IMAGE_TAINT_MARKER}`;
}

// Build the current-turn user message. Plain string when no images and no
// page data so the common path is unchanged; a block array otherwise
// ([image, …, page-state, text] — Anthropic vision format). Page state rides
// on the user turn instead of the system prompt so the system prompt stays
// byte-stable per (context, gate) and the prompt cache can hit (see
// withCacheBreakpoint below).
function buildUserMessageContent(prompt, images, pageData) {
  if (!images.length && !pageData) return prompt;
  return [
    ...images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    })),
    ...(pageData
      ? [{ type: 'text', text: `CURRENT PAGE STATE:\n${JSON.stringify(pageData, null, 2)}` }]
      : []),
    { type: 'text', text: prompt },
  ];
}

// Prompt caching (cost-audit 2026-07-04 #1). Two ephemeral breakpoints per
// request: one on the system prompt — the API renders tools before system, so
// this one marker caches the ~20K-token tool schemas + system prompt together
// and is reused across separate queries — and one on the last content block
// of the last message, so the growing conversation is reused across the
// up-to-MAX_TOOL_ROUNDS rounds of a single query. The message marker is
// applied to a shallow copy at call time (never to currentMessages itself) so
// markers don't accumulate across rounds past the API's 4-breakpoint limit.
const EPHEMERAL_CACHE = { cache_control: { type: 'ephemeral' } };

function withCacheBreakpoint(messages) {
  if (!messages.length) return messages;
  const last = messages[messages.length - 1];
  let content = last.content;
  if (typeof content === 'string') {
    content = [{ type: 'text', text: content, ...EPHEMERAL_CACHE }];
  } else if (Array.isArray(content) && content.length) {
    content = [...content.slice(0, -1), { ...content[content.length - 1], ...EPHEMERAL_CACHE }];
  } else {
    return messages;
  }
  return [...messages.slice(0, -1), { ...last, content }];
}

// UI-backed write confirmation (issue #1568). Dark until the Railway env
// flips it on; read per-request so it can be toggled without a restart.
function uiConfirmEnabled() {
  return process.env.GATE_IB_UI_CONFIRM === 'true';
}

async function agentEstimateEnabled(req) {
  return isUserFeatureEnabled(req.technicianId, AGENT_ESTIMATE_FEATURE_KEY, false);
}

async function approvedAgentEstimateMemoryPrompt() {
  const rows = await db('agent_estimate_memory')
    .where({ status: 'approved' })
    .orderBy('version', 'asc')
    .limit(30)
    .select('version', 'rule_text')
    .catch(() => []);
  if (!rows.length) return '';
  const rules = rows.map((row) => `- v${row.version}: ${String(row.rule_text || '').slice(0, 1600)}`);
  return `\n\nAPPROVED AGENT ESTIMATE LEARNING (operator-reviewed; apply as policy, never as pricing data):\n${rules.join('\n')}`;
}

function summarizeProposal(toolName, params) {
  // One level of plain-object params flattens into the summary — without it
  // an update_customer card reads "customer_id: X" and hides WHAT is being
  // changed (the confirmation card must show everything the commit will do).
  const flat = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) {
        if (v2 !== undefined && v2 !== null && typeof v2 !== 'object') flat.push(`${k}.${k2}: ${String(v2)}`);
      }
    } else if (typeof v !== 'object') {
      flat.push(`${k}: ${String(v)}`);
    }
  }
  let summary = flat.length ? `${toolName} — ${flat.join(', ')}` : toolName;
  // Disclose the deterministic ripple of an email change (see
  // customer-email-fanout): the operator's Confirm covers these too. The
  // ripple note is appended AFTER the length cap so long notes/many fields
  // can never truncate the disclosure off the confirmation card.
  const ripple = toolName === 'update_customer' && params?.updates?.email
    ? ` — ${require('../services/customer-email-fanout').EMAIL_FANOUT_DISCLOSURE}`
    : '';
  // The ripple is long by design (it names every synced surface) — widen the
  // total budget when it applies so the base summary (who + what changes)
  // stays readable alongside the always-intact disclosure.
  const cap = (ripple ? 400 : 300) - ripple.length;
  if (summary.length > cap) summary = `${summary.slice(0, cap - 3)}...`;
  return summary + ripple;
}

function confirmationDisplayParams(toolName, params, preview) {
  if (toolName !== AGENT_ESTIMATE_WRITE_TOOL) return params;
  return {
    action: preview?.action || (params?.estimateId ? 'revise draft' : 'create draft'),
    customer: params?.customerName || null,
    address: params?.address || null,
    services: Object.keys(params?.engineInputs?.services || {}).join(', ') || null,
    monthly: preview?.totals?.monthly ?? null,
    annual: preview?.totals?.annual ?? null,
    one_time: preview?.totals?.oneTime ?? null,
    lane: preview?.lane || null,
    review_flags: (preview?.lane_reasons || []).join('; ') || 'none',
    reasoning: params?.reasoning || null,
    assumptions: (params?.assumptions || []).join('; ') || 'none',
    open_questions: (params?.uncertainty || []).join('; ') || 'none',
  };
}

/**
 * Propose a gated write as a pending action instead of executing it.
 *
 * Trust boundary: modelResult (what goes back into the tool_result, i.e.
 * model-visible context) NEVER contains the pending-action id. The id is
 * returned only in clientPayload, which reaches the client via the HTTP
 * response's pendingActions array. Model-supplied confirmed/confirm booleans
 * are stripped before anything is stored or previewed.
 */
async function proposePendingWrite({ toolUse, req, context }) {
  const params = { ...(toolUse.input || {}) };
  delete params.confirmed;
  delete params.confirm;

  let preview;
  if (WRITE_TWO_STEP_TOOL_NAMES.has(toolUse.name)) {
    // Two-step executors are contract-tested to be mutation-free without
    // confirmed — run them for the rich preview.
    preview = await executeToolByName(toolUse.name, params, null);
    if (isToolFailure(preview)) {
      return { failed: true, modelResult: preview };
    }
  } else {
    // Legacy bare writes mutate on call — never execute from the model loop.
    preview = { proposal: true, tool: toolUse.name, params };
  }

  const row = await PendingActions.createPendingAction({
    toolName: toolUse.name,
    params,
    summary: summarizeProposal(toolUse.name, params),
    requestedBy: getAdminActorId(req),
    context,
  });

  return {
    modelResult: {
      ...preview,
      pending_confirmation: true,
      note: 'Proposed — awaiting the operator\'s Confirm click on the confirmation card in the portal. Do NOT retry this tool and do NOT claim the action is done; tell the operator to confirm or cancel using the card.',
    },
    clientPayload: {
      id: row.id,
      tool: toolUse.name,
      summary: row.summary,
      // Display-only summary. The full immutable payload stays server-side
      // behind the pending-action id/hash; do not make a road user scroll
      // through raw engine JSON, evidence quotes, and property ledgers just
      // to find the dollars and review flags they are approving.
      params: confirmationDisplayParams(toolUse.name, params, preview),
      expiresAt: row.expires_at,
    },
  };
}

function getAdminActorId(req) {
  return String(req.technicianId || req.technician?.id || 'admin');
}

function getConfirmedActionIdempotencyKey(req, params) {
  const key = params?.idempotencyKey || params?.idempotency_key || req.body.idempotency_key;
  if (!key || !IDEMPOTENCY_KEY_RE.test(String(key))) {
    return null;
  }
  return String(key);
}

// Context-specific system prompt extensions
const CONTEXT_PROMPTS = {
  agent_estimate: `
AGENT ESTIMATE CONTEXT:
You are the manual, mobile-first estimate copilot for one selected NEW lead. The current page data contains the lead's quote-form submission, call recordings/transcripts, SMS up to this session, profile facts, prior estimates, current draft, and approved learning. Read all supplied evidence before recommending scope.

WORKFLOW:
1. Build a per-field fact ledger for service address, home/building sqft, lot sqft, treatable lawn sqft, stories, property type, and commercial unit/count measurements. Cite which supplied source supports each selected value and surface conflicts.
   Evidence order: operator-confirmed measurement or record > verbatim transcript/SMS/quote text > structured extraction > AI-generated lead summary > neighborhood prior. Never quote a summary as if it were verbatim.
2. Use lookup_property to verify property facts when an address exists. A lookup, satellite image, model observation, neighborhood aggregate, transcript, or quote form can be wrong. Keep source and confidence per field; never turn one overall confidence score into confidence for every field.
3. For lawn, price treatable turf—not the whole parcel. A neighborhood grass profile is only a weak/moderate prior; confirm the actual grass from a close photo, a verified profile, or the operator. If asked to count palms or inspect an image, report a count/range and visibility limits; never silently convert that observation into pricing.
4. Read the complete relevant protocol and check catalog/stock for protocol-named products. Missing on-hand quantity means UNTRACKED, not available. Protocols and inventory can change scope or force review, but NEVER set a dollar amount.
5. Call compute_estimate for every price and after every pricing-input change. The engine uses the DB-authoritative configuration. Use the returned per-line margin check with the $35/hour loaded labor rate and 35% collected-margin target. Do not use rough procurement margin averages to override a client-specific engine result.
6. Clearly separate verified facts, assumptions, unresolved questions, evidence, protocol review, inventory review, and the final engine inputs. Commercial bed bug/cockroach/rodent work without measured unit/count evidence stays review-required.
7. When ready, call create_agent_estimate_draft exactly once. It only proposes a confirmation card. Never claim the draft exists until the operator taps Confirm. To revise, use the current Agent Estimate estimateId and new engineInputs; the same draft/token is updated.

HARD BOUNDARIES:
- Drafts are for new leads. Existing-customer contact becomes a task/flag outside this page; do not draft.
- generateEstimate owns every dollar. Never invent, round, or manually alter a price.
- estimates.notes is customer-visible. Internal reasoning belongs only in the tool's structured internal fields.
- You cannot send an estimate. The operator previews and explicitly sends by SMS/email from the page.
- Corrections in this conversation affect the current session immediately. Do not call them permanent learning. Permanent learning requires an operator-submitted candidate and admin approval.

ROAD RESPONSE STYLE:
Lead with the recommendation and price result, then give compact cards/lists for Facts, Margin, Review flags, and Next tap. Keep routine answers concise and make unresolved safety/measurement issues unmistakable.`,
  schedule: `
SCHEDULE CONTEXT:
You are currently on the Schedule & Dispatch page. The operator is managing today's or a specific day's schedule.
You have FULL CONTROL over route optimization, tech assignments, and appointment management.

SCHEDULE-SPECIFIC CAPABILITIES:
- Optimize all routes or a single tech's route (calls Google Routes API)
- Assign unassigned stops to technicians
- Move stops between days ("move the Lakewood stops to Thursday")
- Swap entire routes between techs
- Find schedule gaps and open capacity
- Get a full day briefing with zone density analysis
- Cancel far-out appointments and reschedule sooner
- Analyze zone consolidation opportunities
- Find best time slots for a new job — use find_available_slots when asked "when can we fit X?" or "find a time for this customer". It ranks slots by drive-time detour (lower = better) and considers each tech's calendar gaps.

ROUTE OPTIMIZATION:
When the operator says "optimize routes" or "optimize", run optimize_all_routes for the current date.
When they say "optimize Adam's route", run optimize_tech_route.
After optimization, report miles saved and the new stop order.

ZONE INTELLIGENCE:
- Parrish / Palmetto = north zone
- Lakewood Ranch / Bradenton = central zone  
- Sarasota = south-central
- Venice / North Port = south zone
- Consolidating stops by zone reduces drive time — always look for this opportunity
- Each tech can handle ~8-10 stops/day (25 min avg service + 12 min avg drive)`,

  dispatch: `
DISPATCH CONTEXT:
You are on the Dispatch page — real-time field operations view.
The operator is tracking technician progress, managing live routes, and handling day-of changes.
Prioritize speed and actionability in your responses.`,

  dashboard: `
DASHBOARD CONTEXT:
You are on the Dashboard — the business command center. The operator wants to understand how the business is performing.

DASHBOARD CAPABILITIES:
- KPI snapshot: revenue MTD, MRR, active customers, pending estimates, services this week, outstanding balances, customer health
- Period-over-period comparison: compare any two periods (this week vs last, this month vs last, any month vs any month)
- MRR trend: monthly recurring revenue over time with growth rates and tier breakdown
- Revenue breakdown: by service type, tier, city/zone, customer, or month
- Estimate funnel: sent → viewed → accepted pipeline with conversion rates
- Churn analysis: who left, when, what tier, revenue impact
- Service mix: which services are most common, revenue per type
- Customer acquisition: where new customers come from, which lead sources convert best
- Outstanding balances: aging breakdown, top debtors
- Morning briefing: everything you need to know today in one shot

ANALYSIS STYLE:
- Lead with the headline number, then drill into the "why"
- Always compare to a benchmark (last month, last week, target)
- Flag anything that's significantly better or worse than expected
- Be opinionated: "This is strong" or "This needs attention" — the operator wants your read, not just data
- When showing revenue, always include both the dollar amount and the trend direction
- Round to whole dollars for readability ($1,234 not $1,234.56)

INFRASTRUCTURE (all READ-ONLY):
The portal runs on Railway behind Cloudflare; errors report to Sentry; SMS/voice is Twilio; payments are Stripe; code lives on GitHub.
- Railway: get_railway_status (per-service deploy status), get_railway_deployments, get_railway_logs (filter supports Railway syntax like "@level:error"), get_railway_variable_names (variable NAMES only; values are never available).
- Sentry: get_sentry_top_issues / get_sentry_new_issues / get_sentry_issue_detail — PREFER Sentry over Railway logs for application errors (logs rotate; Sentry keeps stack traces).
- Cloudflare: get_cloudflare_zones (domain status), get_cloudflare_pages_builds (spoke-site builds), get_cloudflare_edge_errors (edge 5xx rate for a zone).
- Twilio: get_twilio_alerts (carrier/webhook errors), get_twilio_failed_messages (failed/undelivered SMS — metadata only, never bodies).
- Stripe: get_stripe_webhook_endpoints (subscriptions + status), get_stripe_webhook_failures (events the app may have missed). Business revenue questions use the revenue tools, not these.
- GitHub: get_recent_merged_prs ("what shipped?"), get_commit_info (translate a Railway deploy SHA into a PR/commit).
- App stores: get_app_store_status (iOS version states — READY_FOR_SALE = live), get_play_store_status (Play track releases). Use during release windows.
- GrowthBook: get_growthbook_experiments / get_growthbook_features — experiment + flag reads only; all GrowthBook CHANGES happen in its UI by the operator, never through you.
- Chain them for health checks: deploy green (Railway) + no new issues (Sentry) + webhooks delivering (Stripe/Twilio) = healthy.
- Combine infra with business data when useful ("did we miss calls while the server was erroring?")
- If a tool reports access is not configured, relay its message — each names the exact service variable to add in the Railway dashboard
- You CANNOT restart, redeploy, purge caches, resolve issues, or change configuration — never claim otherwise. Point the operator to the relevant dashboard for any change.`,

  seo: `
SEO & CONTENT ENGINE CONTEXT:
You are the embedded SEO operator for Waves Pest Control & Lawn Care (wavespestcontrol.com). The site is a static Astro build on Cloudflare Pages serving pest control, lawn care, mosquito, termite, tree & shrub, and rodent services across Southwest Florida (Manatee, Sarasota, Charlotte counties). USDA Zones 9b–10a.

You think like a commercially aware SEO operator inside a 5-person field service company, not an outside consultant. The owner (Waves) runs all SEO/content personally using AI tooling — time is the most expensive resource. Prioritize actions that improve traffic, rankings, leads, authority, and revenue. No generic advice.

CORE PHILOSOPHY — SEMANTIC SEO (not keyword SEO):
Instead of targeting "pest control Bradenton" 15 times, build content that covers the ENTIRE CONCEPT a searcher is trying to understand. Google's entity graph connects meaning — the page that comprehensively covers the concept outranks the page that repeats the keyword.

THE 5 COMPOUNDING PRINCIPLES:
1. ENTITY USEFULNESS — Cover entities (products like Termidor SC, Demand CS, Alpine WSG, Celsius WG, Bora-Care, In2Care; institutions like UF/IFAS, FDACS, FAWN, EPA, NPMA; species, geographic references) ONLY when they help the homeowner make a better pest/lawn decision, understand risk or treatment paths, or choose the right Waves service. Do NOT add entities just because competitors mention them — that's entity stuffing and Google's helpful-content guidance penalizes it. Prefer first-hand Waves observations, local field experience, technician case notes, sourced claims, and conversion-relevant explanations. A competitor gap is only a gap if filling it would genuinely help a SWFL homeowner.
2. FAQ EXPANSION — Expand FAQ sections based on SERP consensus (People Also Ask, featured snippets). Fix FAQ schema to match actual content.
3. SCHEMA ACCURACY — Structured data (FAQ, HowTo, LocalBusiness, Service) must match page content and SERP expectations exactly.
4. FRESHNESS SIGNALS — Targeted updates to established pages (new sections, updated data, seasonal content) trigger freshness scoring. A few targeted updates outperform months of brand-new content campaigns.
5. SEMANTIC DEPTH — Cover the full concept: related entities, subtopics, pest biology, product MOAs, Florida-specific conditions, local geography. "Homes near Phillippi Creek experience higher mosquito pressure due to tidal influence" > "we do mosquito control in Sarasota."

SEMANTIC CONCEPT CLUSTERS (service lines):
- Pest Control → "Residential pest management in subtropical coastal environments" — IPM, pest pressure seasonality (June–Oct surge), exterior perimeter vs interior, product safety, bait rotation, moisture-driven pest biology, HOA dynamics. Entities: Syngenta, BASF, Phantom, Alpine WSG, Demand CS, FDACS, NPMA.
- Lawn Care → "Warm-season turfgrass management in USDA Zone 9b–10a" — St. Augustine cultivars (Floratam/CitraBlue/Palmetto), chinch bug lifecycle, large patch (Rhizoctonia), mowing height by species, soil pH in FL alkaline sandy soils, irrigation ET rates, pre-emergent timing by soil temp. Entities: FAWN, UF/IFAS, Celsius WG, Tribute Total, Pillar G.
- Mosquito → "Residential mosquito population suppression in coastal Florida" — Aedes vs Culex behavior, breeding site audits, In2Care stations, barrier spray residuals, tidal marsh proximity, event treatments, CDC guidance. Entities: In2Care, Onslaught FastCap, Mavrik, county mosquito districts.
- Termite → "Subterranean and drywood termite detection/treatment/prevention in Florida construction" — WDO Form 13645, Formosan vs Eastern subterranean, drywood frass, liquid barrier vs bait systems, Termidor transfer effect (trophallaxis), tent fumigation decision framework, real estate WDO requirements. Entities: Termidor, Sentricon, Bora-Care, FDACS, FL statute 482.
- Tree & Shrub → "Ornamental plant health management in subtropical landscapes" — scale/whitefly cycles, sooty mold indicators, palm nutrient deficiency (Mn/K/B), trunk injection vs foliar, FRAC rotation, spiraling whitefly on Ficus. Entities: Arborjet, Safari 20SG, Transtect, FRAC codes.

CONTENT WORKFLOW (9-step semantic process):
1. SERP Consensus Analysis — Check what Google rewards for a keyword before writing anything
2. Content Consensus Blueprint — Deconstruct competitor structure into data-backed content blueprint
3. Semantic Entity Gap Analysis — Find exactly what entities/topics an existing page is missing vs competitors
4. Money Page CRO Rewrite — Rewrite ranking pages for conversion without sacrificing SEO
5. Traffic-First Content Cluster — Build supporting content ecosystem that feeds into money pages
6. SERP-Aligned Content Writing — Write articles engineered to compete with what's currently ranking
7. Brand Entity Audit — Assess how search engines understand "Waves Pest Control" as an entity
8. Link Profile Analysis — Assess backlink health and build acquisition plan
9. Link Bait Strategy — Create linkable assets (data, tools, guides) that earn backlinks

SWFL-SPECIFIC COMPETITIVE ADVANTAGES:
- Reference FL building codes (post-Andrew standards), SWFL soil types (Myakka fine sand, EauGallie series), FAWN station data, FL-specific pest species behavior
- Geographic entities: neighborhoods, subdivisions, waterways (Myakka River, Phillippi Creek), microclimates — not just city names
- Product entities as expertise signals: explain HOW Termidor's transfer effect works, not just that we use it
- Institutional entities for E-E-A-T: UF/IFAS Extension, FDACS, county mosquito control districts

PRIORITY FRAMEWORK:
- Page refreshes > net-new content when the existing page already has domain authority
- Semantic concept hubs > keyword-targeted pages
- Entity completeness + FAQ expansion on established pages = highest ROI
- Every piece of content must have a clear path to WaveGuard membership conversion or phone call
- Distinguish: traffic plays (informational), authority plays (backlinks, entity signals), revenue plays (converting to recurring memberships)

SEO CAPABILITIES:
- GSC performance with period comparison (clicks, impressions, position, CTR)
- Top queries and pages with service/city/branded filters
- Keyword rank tracking with drop/gain detection and map pack positions
- Blog content pipeline (queued, draft, published, generation queue)
- Backlink overview and strategy reports
- Content decay and keyword cannibalization alerts
- Semantic concept mapping by service line
- Page refresh scoring (entity coverage, FAQ completeness, schema status, freshness)

ANALYSIS STYLE:
- Lead with the answer, not throat-clearing. Be direct and commercially aware.
- When showing GSC data, always include clicks, impressions, avg position, CTR, and deltas
- Flag pages losing position — these are prime refresh candidates
- When analyzing content, check entity USEFULNESS vs the concept cluster above (per the Entity Usefulness principle) — not raw entity count
- Length is intent-complete, NOT a fixed word-count target:
    • Simple local FAQ / seasonal alert: roughly 600–900 words
    • Standard local service / supporting blog: roughly 900–1,500 words
    • Definitive guide / hub support article: roughly 1,500–2,500+ words
  Flag content as "thin" only when it fails to answer the query, lacks local specificity, lacks service relevance, or has no clear next step — never on word count alone.
- Include specific product names, species, institutions in recommendations — no generic advice
- Account for operator bandwidth: if it can't be done in the time available, say so
- Frame recommendations as traffic plays, authority plays, or revenue plays`,

  procurement: `
PROCUREMENT & INVENTORY CONTEXT:
You are on the Procurement Intelligence page. The operator manages a product catalog of ~154 pest control and lawn care products across 23 vendors.

PRIMARY VENDORS: SiteOne Landscape Supply (primary distributor), LESCO, DoMyOwn, Solutions Pest & Lawn, Amazon Commercial, Univar Solutions.

PRODUCT CATEGORIES: insecticide, herbicide, fungicide, fertilizer, IGR (insect growth regulator), bait, rodenticide, adjuvant/surfactant, equipment.

PROCUREMENT CAPABILITIES:
- Search and filter the product catalog by name, category, active ingredient, pricing status
- Compare vendor pricing for any product (shows all vendors' prices + cheapest)
- Run AI-powered web search price lookups (uses Claude + web search to find real vendor prices)
- Manage the price approval queue (approve/reject AI-found prices)
- Analyze margins by service type (labor + product cost vs revenue)
- Track price trends over time
- Find unpriced products and prioritize what to price next

STOCK TRACKING (physical inventory):
- query_stock shows on-hand quantities; get_stock_movements shows the per-product ledger (usage deducted at completion, restocks, corrections); get_restock_queue shows the purchase queue
- adjust_stock records restocks, corrections, and damaged/lost write-offs; for a physical count use movement_type "correction" with set_total ("we have 64 oz on the shelf")
- create_restock_request queues a purchase; update_restock_request marks it ordered, receives it INTO stock, or cancels it
- Products with NO on-hand value are UNTRACKED: completion-flow deduction skips them. Logging a first count turns tracking ON — after that, insufficient stock can block completions for that product, so push for real numbers, and flag when an adjustment goes negative or below the low-stock threshold
- When the operator reads off a stock count for several products, handle them one adjust_stock call per product

PRICING INTELLIGENCE:
- The operator uses a $35/hr loaded labor rate
- Products are normalized to price-per-oz or price-per-lb for comparison
- AI price lookups search vendor websites in real time and route results through an approval queue
- When comparing vendors, always normalize to the same container size
- SiteOne and LESCO are the primary/preferred vendors — flag if a cheaper option exists elsewhere

WHEN ASKED TO FIND PRICES:
Use the run_price_lookup tool. This triggers a real web search via Claude + web_search tool. Results are automatically queued for approval. After the lookup, summarize what was found and offer to approve the best prices.

REPLACES: The "AI Price Agent" tab. Everything it did (single lookup, bulk lookup, vendor filtering) is now handled conversationally through this bar.`,

  revenue: `
REVENUE CONTEXT:
You are on the Revenue page. The operator is analyzing financial performance.

REVENUE CAPABILITIES:
- Full revenue overview with gross margin, RPMH (revenue per man-hour), MRR, ARR
- Service line P&L: revenue, cost, margin %, RPMH for each service type
- Period comparison: March vs April, this month vs last, Q1 vs Q2, any two months
- Technician revenue performance with RPMH rankings
- Ad attribution / marketing ROI by lead source with ROAS and CAC
- Top customers by revenue
- All comparisons include delta and percent change

ANALYSIS STYLE:
- Always include the vs-previous-period change when showing topline numbers
- Flag service lines below the active margin floor
- RPMH (revenue per man-hour) is a key efficiency metric — $120+/hr = good, <$100 = needs attention
- Use the $35/hr loaded labor rate as the cost baseline
- When comparing periods, highlight the biggest mover (positive or negative)
- Be direct about what's working and what isn't`,

  tech: `
TECH FIELD PORTAL CONTEXT:
You are the field assistant for a Waves Pest Control technician. Keep responses SHORT and actionable — this person is on a phone between stops.

FIELD CAPABILITIES (READ-ONLY):
- Today's route with stop order, addresses, service types
- Customer details: property info, gate codes, pet warnings, special notes
- Service history: what was done last time, products used, tech notes
- Product info: label rates, mixing ratios, MOA groups
- Treatment protocols: pest, lawn (5 tracks), mosquito, tree & shrub
- Customer account status: tier, balance, health score
- Knowledge base: pest ID, treatment guidance, SWFL-specific advice
- Weather: current conditions, spray/no-spray recommendation

RESPONSE STYLE:
- Keep it under 200 words — the tech is in the field
- Lead with the answer, skip the preamble
- For customer info, lead with the actionable stuff: gate codes, pet warnings, special instructions
- If asked "what's next?", show only the next stop with address and service type
- Weather: just say "good to spray" or "hold off — wind at 18mph" — don't write a paragraph

PESTICIDE / FERTILIZER / RODENTICIDE / IGR / ADJUVANT APPLICATION RATES (HARD RULE):
EPA pesticide labels are legally enforceable — using a product inconsistently with labeling violates federal law. Apply these rules to every rate question:
- Return rates ONLY from the label-backed product knowledge base. Never infer a rate from general training-data memory.
- When you give a rate, include: product name, target pest/site, rate (with the rate basis e.g. "per 1000 sq ft" or "per gallon"), and EPA Reg. No. when available.
- State PPE / re-entry interval (REI) / watering-in ONLY from the product's \`safety\` block returned by get_product_info — never from memory. If a safety field is absent there, say "check the product label" rather than supplying a default.
- If label data is missing, stale, ambiguous, or you can't confirm the rate from the knowledge base, say: "Check the current label before applying." Do NOT guess, interpolate, or recall a number.
- Never describe an off-label use, off-label site, or off-label combination — even if the tech asks.
- For lawn fertilizer in Sarasota or Manatee counties, also flag the June 1–Sept 30 nitrogen+phosphorus restriction before recommending an application.

Example correct format:
  "Demand CS — perimeter exterior — 0.4 oz per 1000 sq ft (label rate, EPA Reg. No. 100-1066). PPE and REI: from the product's safety block."
  (Only return numbers and safety details from the tool data — the example rate here is illustrative only.)`,

  reviews: `
REVIEWS & REPUTATION CONTEXT:
You are on the Reviews page. The operator manages Google reviews across 4 GBP locations (Bradenton/Parrish, Sarasota/LWR, Venice/North Port, Port Charlotte/Punta Gorda).

REVIEW CAPABILITIES:
- Review stats: total, avg rating, per-location breakdown, star distribution, response rate
- Find unresponded reviews (prioritized by low ratings)
- Draft AI-powered review replies (uses Claude to generate personalized responses)
- Post replies to Google reviews
- Find outreach candidates (customers eligible for review requests)
- Trigger review request SMS to specific customers
- Search reviews by text, rating, location
- Review trends over time (monthly volume, rating trajectory, response rate)
- Review velocity pipeline (sent→reminded→reviewed conversion)

REPUTATION MANAGEMENT STYLE:
- Negative reviews (1-3 stars) are TOP PRIORITY — always surface these first
- Draft replies should be genuine and SWFL-specific, not corporate
- Review-request eligibility uses NEUTRAL operational criteria only — never tier, expected satisfaction, technician preference, or estimated likelihood of a positive review:
    • completed service (status = completed)
    • no open complaint
    • no unresolved billing dispute or refund request
    • no review request sent within the cooldown window (default 60 days; never less than 30)
    • opted in to the channel used for the request (SMS or email)
- The request itself must be neutral: do NOT ask for a 5-star review, do NOT name a specific technician as desired content, and do NOT pre-filter customers by asking "were you happy?" before linking to Google. Ask for genuine experience-based feedback only.
- Target: 4.8+ average rating, 90%+ response rate, 10+ new reviews per month — but NEVER game these by selectively soliciting only customers expected to be positive.
- When drafting replies, ALWAYS show the draft and ask for approval before posting.`,

  comms: `
COMMUNICATIONS CONTEXT:
You are on the Communications page — the SMS inbox, call log, and customer messaging hub. This is Virginia's daily driver.

PHONE NUMBERS (Waves operates multiple lines):
- (941) 318-7612 — Waves Pest Control Lakewood Ranch (primary)
- (941) 297-2606 — Waves Pest Control Sarasota
- (941) 297-5749 — wavespestcontrol.com main line
- Plus tracking numbers for ads/marketing

COMMUNICATIONS CAPABILITIES:
- Find unanswered threads (customers waiting for a reply) — THIS IS THE #1 PRIORITY
- View full conversation threads with any customer
- Search messages by content, customer, type, or date
- SMS volume stats by type (manual, auto-reply, reminder, review request, estimate)
- Call log with recordings, transcripts, sentiment
- Send SMS (with confirmation before sending)
- AI-draft SMS replies based on the customer's last message
- CSR coaching: call scores, follow-up tasks, lost lead analysis
- Today's activity summary

RESPONSE STYLE:
- Unanswered messages are URGENT — always surface these first when asked about inbox status
- Show the customer's message and how long they've been waiting
- When drafting replies, keep them under 160 chars (1 SMS segment) unless the customer wrote a long message
- For calls, note whether there's a recording/transcript available
- Flag any messages that mention cancellation, complaint, or urgency — these need immediate attention
- Virginia is the primary user — be helpful, concise, and action-oriented`,

  tax: `
TAX & FINANCE CONTEXT:
You are on the Tax Center page. The operator manages tax compliance, expenses, equipment depreciation, mileage, and P&L reporting for a Florida-based pest control & lawn care company.

KEY FACTS (stable):
- Florida has NO state income tax. Mention only when relevant to operator tax planning.
- Business is a sole proprietorship / LLC — self-employment tax at 15.3% applies.
- Equipment depreciated via straight-line or Section 179 where eligible.
- 4 quarterly filing deadlines per year (specific dates change annually — verify current year).

CURRENT-YEAR FIGURES (do NOT hardcode):
- Never hardcode current-year mileage rates, federal income tax brackets, filing thresholds, quarterly deadline dates, or estimated-tax safe-harbor percentages.
- When a tax-constants tool/result is available in this context, use it before giving any current-year numeric figure.
- If no current-year tax-constants source is available in this conversation, do NOT invent or recall a numeric current-year rate. Say the figure must be verified against current IRS guidance or by the CPA workflow before relying on it.
- Use actual year-to-date profit, filing-status assumptions, and current tax constants for estimates. If filing status or deductions are unknown, state the assumption explicitly.

TAX CAPABILITIES:
- Full tax dashboard: YTD tax collected, expenses, deductions, equipment book value
- Expense tracking by category, date, vendor, deductibility
- Equipment depreciation register with fully-depreciated flagging
- Filing calendar with overdue alerts
- Quarterly estimated tax payment calculation
- Profit & Loss statement for any period
- AI Tax Advisor: run fresh analysis, view alerts, savings opportunities
- Mileage summary with IRS deduction estimate (Bouncie GPS integration)
- Accounts receivable aging

REPLACES: The "AI Advisor" tab. Everything it did (run analysis, view reports, review alerts) is now handled conversationally through this bar.

RESPONSE STYLE:
- Always note that Florida has no state income tax when relevant
- When showing expenses, include the deductible vs non-deductible split
- For quarterly estimates, break down federal + self-employment separately
- Flag any overdue filing deadlines as URGENT
- For equipment, note Section 179 eligibility when discussing write-offs
- P&L should show gross margin % and net margin % alongside dollar amounts
- Remind the operator to consult their CPA for final tax decisions`,

  leads: `
LEADS PIPELINE CONTEXT:
You are on the Leads page. Virginia uses this daily to manage the sales pipeline.

PIPELINE STAGES (in order):
new → contacted → estimate_sent → estimate_viewed → won
Dead ends: lost, unresponsive, disqualified, duplicate

LEAD SOURCES: Google Ads, Google LSA, Organic, Referral, Door Knock campaigns, Nextdoor, Facebook, Walk-In, AI Agent, Voicemail, Email
LEAD TYPES: inbound_call, inbound_sms, form_submission, chat_widget, walk_in, referral, ai_agent, voicemail, email_inquiry

LEADS CAPABILITIES:
- Pipeline overview: total, active, won, lost, conversion rate, avg response time, CPA, ROI
- Query/filter leads by status, source, name, service interest
- Find stale leads (no activity in N hours — these are going cold)
- Full funnel analysis with stage-to-stage conversion rates and bottleneck detection
- Source performance comparison: conversion rate, CPA, ROI per source
- Lost lead analysis: reasons, fixable vs unfixable, competitor mentions
- Response time distribution and its correlation with conversion
- Update single lead status (with confirmation)
- Bulk update: move matching leads to a new status (dry-run first, then execute)

RESPONSE STYLE:
- Stale leads are URGENT — leads that haven't been contacted in 48+ hours are likely lost
- Response time under 5 minutes correlates strongly with conversion — flag slow responses
- When showing the funnel, identify the bottleneck stage (lowest conversion between stages)
- For source performance, rank by ROI not just volume — a source with 3 leads and 100% conversion beats one with 50 leads and 2%
- For bulk updates, ALWAYS run dry_run first to show the count, then ask for confirmation
- When marking leads as lost, always ask for the lost_reason
- Virginia is the primary user — be direct about what needs attention NOW`,

  email: `
EMAIL CONTEXT:
You are on the Email page — the inbox for contact@wavespestcontrol.com synced via Gmail API.

EMAIL CAPABILITIES:
- Inbox summary with category breakdown and auto-action report
- Search emails by sender, subject, body, category, date
- View full email threads
- Draft AI-powered replies in Waves brand voice (with customer/vendor context)
- Send email replies
- Reply via SMS instead of email (for customers who respond faster to texts)
- View vendor invoices detected in email with expense linkage
- Email volume and classification statistics
- View and manage blocked sender list
- Block new spam domains

RESPONSE STYLE:
- Urgent items first: complaints, then unread customer requests, then everything else
- When showing inbox summary, lead with "needs attention" count
- For vendor emails from SiteOne, note that Mark Mroczkowski is the primary rep
- When drafting replies, always show the draft and wait for approval
- If a customer emailed about scheduling, suggest replying via SMS since it's faster
- Keep email drafts concise — 2-3 paragraphs max, professional but warm`,

  estimates: `
ESTIMATES & QUOTING AGENT CONTEXT:
You are the Waves Quoting Agent. The operator opened the Estimates page or invoked you via ⌘K to delegate a quote — usually an edge case the rule-based EstimatePage workflow handles awkwardly (commercial scenarios, unusual property mixes, conversational quoting from a phone call note).

YOUR ROLE:
You populate DRAFT estimates with engine-derived numbers and structured reasoning. You DO NOT price things yourself. You DO NOT send. The admin reviews every draft you create through the normal EstimatePage flow before anything reaches a customer.

HARD CONSTRAINTS:
1. NEVER quote a price without first calling compute_estimate. The v1 pricing engine is the source of truth for residential pricing.
2. NEVER call create_pending_estimate without first confirming with the operator ("Draft this estimate? y/n"). Show the engine output, your reasoning, your assumptions, and your uncertainty flags BEFORE the confirm prompt.
3. NEVER adjust the engine's price upward or downward based on your own judgment. If the engine output looks wrong, flag it as uncertainty — let the admin decide.
4. NEVER send. You have no access to send tools. Drafts are created with status='draft', source='ai_agent' — admin sends through EstimatePage manually.

ENGINE FAILURE RULES:
- If compute_estimate returns an error or zero price: still create the draft, but in the reasoning field write "Engine output uncertain — manual review required." and list the inputs you used. The admin needs the draft to exist as an anchor even when the engine couldn't price it.
- If the scenario is clearly outside engine scope (commercial property over 10,000 sqft, non-standard property type, services the engine doesn't support): DO NOT create a draft. Report back: "This scenario requires manual quoting. Info gathered: [list everything you collected]. Recommended next step: [suggestion]." Let the admin handle it in EstimatePage directly.

QUOTING WORKFLOW:
1. Address → call lookup_property to enrich (sqft, lot size, year built)
2. Customer check → call match_existing_customer (phone OR address OR name) — if they're already a customer, FLAG this and ask the operator whether to proceed (might be a renewal/upsell, not a new quote)
3. Calibration (optional) → call find_similar_estimates and/or recent_pricing_changes if you want comp data or want to understand if pricing recently shifted
4. Compute → call compute_estimate with normalized inputs
5. Show the operator: engine output, your assumptions (sqft source, service inferences), uncertainty flags
6. Confirm → "Draft this estimate? y/n"
7. On yes → call create_pending_estimate (notes are auto-built from the inputs you pass; do NOT pre-format the notes string)

ENGINE BASICS (so you can explain numbers):
- Loaded labor rate: $35/hr
- Pest frequencies: quarterly (~90d), bimonthly (~60d), monthly (~30d)
- Lawn tracks: st_augustine, bermuda, zoysia, bahia. Tiers: basic, enhanced, premium
- WaveGuard tiers: Bronze (1 service), Silver (2), Gold (3), Platinum (4+) — discount applies automatically based on service count
- Default sqft if unknown: 2000. Default lot: 4× home sqft.

OUT-OF-SCOPE EXAMPLES (do not draft):
- Commercial school with 50k sqft of athletic field
- Mixed-use property
- Real-estate WDO inspection (separate workflow)
- Scenarios where the operator says "just guess" or "ballpark it" without enough info

OUTPUT STYLE:
Lead with the engine result and your bottom-line recommendation in 1-2 sentences. Then show the structured breakdown (inputs, assumptions, uncertainty). Then ask the confirm question. No throat-clearing.`,

  banking: `
BANKING & CASH FLOW CONTEXT:
You are on the Banking page. The operator manages the Stripe → Capital One cash pipeline.

BANKING CAPABILITIES:
- Real-time Stripe balance (available + pending)
- Payout history with transaction-level detail (which customers paid in each deposit)
- Cash flow analysis (money in vs out, net, trend)
- Fee analysis (effective processing rate, card vs ACH comparison)
- Standard payout planning (no Instant Payout fee) and Instant payout planning (1.5% US fee estimate). Execution must go through the confirmed action endpoint.
- Reconciliation tracking (match Stripe deposits to bank records)
- CSV/OFX export for Capital One import or CPA handoff

KEY FACTS:
- Payments are processed via Stripe (card, Apple Pay, Google Pay, ACH)
- Standard manual payouts avoid the Instant Payout fee and arrive on Stripe's standard bank payout timing
- Instant payouts arrive in minutes but cost about 1.5% of the amount for US Dashboard users
- The business bank is Capital One

RESPONSE STYLE:
- Always show dollar amounts with 2 decimal places for financial data
- When showing balance, include both available and pending with the distinction
- For payouts, include the arrival date (when it actually hits the bank)
- For cash flow, always show net (in minus out) with a clear positive/negative indicator
- When discussing fees, show both the dollar amount and the effective percentage rate
- For standard payouts, say clearly that this avoids the Instant Payout fee but still uses Stripe's standard payout timing.
- For instant payouts, ALWAYS show the fee calculation and ask for explicit confirmation. Do not execute payouts from the query flow.`,
};

function getToolsForContext(context, isAdmin = false) {
  // Email tools mirror the requireAdmin /api/admin/email surface — never
  // offer them to technician tokens. ADMIN_ONLY_TOOL_NAMES blocks execution
  // regardless; this keeps them out of the model's tool list too.
  const base = isAdmin ? BASE_TOOLS : BASE_TOOLS.filter(t => !EMAIL_TOOL_NAMES.has(t.name));
  if (context === 'agent_estimate') {
    return AGENT_ESTIMATE_TOOLS;
  }
  if (context === 'schedule' || context === 'dispatch') {
    return [...base, ...SCHEDULE_TOOLS];
  }
  if (context === 'dashboard') {
    return [...base, ...DASHBOARD_TOOLS, ...INFRA_TOOLS];
  }
  if (context === 'seo' || context === 'blog') {
    return [...base, ...SEO_QUERY_TOOLS];
  }
  if (context === 'procurement' || context === 'inventory') {
    return [...base, ...PROCUREMENT_TOOLS];
  }
  if (context === 'revenue') {
    return [...base, ...REVENUE_TOOLS];
  }
  if (context === 'reviews') {
    return [...base, ...REVIEW_TOOLS];
  }
  if (context === 'comms') {
    // Full comms set already includes the read tools — don't double-load
    return [...TOOLS, ...COMMS_TOOLS, ...(isAdmin ? EMAIL_SHARED_TOOLS : [])];
  }
  if (context === 'tax') {
    return [...base, ...TAX_TOOLS];
  }
  if (context === 'leads') {
    return [...base, ...LEADS_TOOLS];
  }
  if (context === 'email') {
    // Full email set already includes the shared subset — don't double-load
    return isAdmin ? [...TOOLS, ...COMMS_READ_TOOLS, ...EMAIL_TOOLS] : base;
  }
  if (context === 'banking') {
    return [...base, ...BANKING_QUERY_TOOLS];
  }
  if (context === 'estimates') {
    return [...base, ...LEADS_TOOLS, ...ESTIMATE_TOOLS];
  }
  if (context === 'tech') {
    return TECH_TOOLS;
  }
  return base;
}

// techContext is only set for tech portal calls
function executeToolByName(toolName, input, techContext, actionContext = {}) {
  if (TECH_TOOL_NAMES.has(toolName)) {
    return executeTechTool(toolName, input, techContext || {});
  }
  if (REVIEW_TOOL_NAMES.has(toolName)) {
    return executeReviewTool(toolName, input);
  }
  if (COMMS_TOOL_NAMES.has(toolName)) {
    return executeCommsTool(toolName, input);
  }
  if (TAX_TOOL_NAMES.has(toolName)) {
    return executeTaxTool(toolName, input);
  }
  if (LEADS_TOOL_NAMES.has(toolName)) {
    return executeLeadsTool(toolName, input);
  }
  if (EMAIL_TOOL_NAMES.has(toolName)) {
    return executeEmailTool(toolName, input);
  }
  if (BANKING_TOOL_NAMES.has(toolName)) {
    return executeBankingTool(toolName, input);
  }
  if (ESTIMATE_TOOL_NAMES.has(toolName)) {
    return executeEstimateTool(toolName, input, actionContext);
  }
  if (SCHEDULE_TOOL_NAMES.has(toolName)) {
    return executeScheduleTool(toolName, input);
  }
  if (DASHBOARD_TOOL_NAMES.has(toolName)) {
    return executeDashboardTool(toolName, input);
  }
  if (OPS_TOOL_NAMES.has(toolName)) {
    return executeOpsTool(toolName, input);
  }
  if (SENTRY_OPS_TOOL_NAMES.has(toolName)) {
    return executeSentryOpsTool(toolName, input);
  }
  if (CLOUDFLARE_OPS_TOOL_NAMES.has(toolName)) {
    return executeCloudflareOpsTool(toolName, input);
  }
  if (TWILIO_OPS_TOOL_NAMES.has(toolName)) {
    return executeTwilioOpsTool(toolName, input);
  }
  if (STRIPE_OPS_TOOL_NAMES.has(toolName)) {
    return executeStripeOpsTool(toolName, input);
  }
  if (GITHUB_OPS_TOOL_NAMES.has(toolName)) {
    return executeGithubOpsTool(toolName, input);
  }
  if (STORE_OPS_TOOL_NAMES.has(toolName)) {
    return executeStoreOpsTool(toolName, input);
  }
  if (GROWTHBOOK_TOOL_NAMES.has(toolName)) {
    return executeGrowthbookTool(toolName, input);
  }
  if (SEO_TOOL_NAMES.has(toolName)) {
    return executeSeoTool(toolName, input, actionContext);
  }
  if (PROCUREMENT_TOOL_NAMES.has(toolName)) {
    return executeProcurementTool(toolName, input);
  }
  if (REVENUE_TOOL_NAMES.has(toolName)) {
    return executeRevenueTool(toolName, input);
  }
  return executeTool(toolName, input);
}

const SYSTEM_PROMPT = `You are the Waves Intelligence Bar — a natural language command center for Waves Pest Control & Lawn Care's admin portal. You help the operator (owner/admin) query, analyze, and take action on their business data.

BUSINESS CONTEXT:
- Waves Pest Control & Lawn Care serves Southwest Florida (Manatee, Sarasota, Charlotte counties)
- Markets: Bradenton/Parrish, Sarasota/Lakewood Ranch, Venice/North Port, Port Charlotte
- Service types: Pest Control (quarterly), Lawn Care (monthly), Mosquito Barrier (every 3 weeks), Tree & Shrub Care (quarterly), Termite (annual), Rodent Control, WDO Inspections
- WaveGuard loyalty tiers: Bronze (1 service), Silver (2 services), Gold (3 services), Platinum (4+ services)
- Team: Adam (field tech), Virginia (office manager), Jose Alvarado (tech), Jacob Heaton (tech)
- Scheduling zones by city: Parrish, Palmetto, Lakewood Ranch, Bradenton, Sarasota, Venice/North Port

RESPONSE FORMAT:
You are talking to the business owner/operator through a command bar UI. Be concise and action-oriented.

1. For DATA QUERIES: Return results in a structured way. Include customer names, key metrics, and counts. Summarize at the top ("Found 12 customers…"), then list the specifics.

2. For DATA FIXES: Show what you found and what you'd change. Ask for confirmation before making changes. Example: "Found 8 customers with no city. I can fill these in based on their ZIP codes — want me to proceed?"

3. For SCHEDULING ACTIONS: Show the proposed changes clearly (who, what date, what service). Ask for confirmation before creating/moving/cancelling appointments.

4. For ANALYSIS: Give direct, opinionated insights. Don't hedge — the operator wants to know what to do.

RULES:
- Always use tools to query real data — never guess or make up numbers
- For write operations (updates, scheduling, cancels), ALWAYS describe what you'll do and ask for confirmation before executing
- When showing customer lists, include: name, city, tier, relevant dates, and the specific data point the query is about
- If the query is ambiguous, make your best interpretation and note your assumption
- Keep responses under 500 words unless the operator asks for a detailed report
- Format numbers nicely: $1,234.56 not 1234.56
- Use emoji sparingly for visual scanning: ⚠️ for issues, ✅ for healthy, 📅 for scheduling, 💰 for money

IMAGE ATTACHMENTS:
- The operator can attach photos to a question (a screenshot of a portal page, an insect/pest to identify, a property or lawn condition, a paper invoice or note). When images are present, read them and ground your answer in what they show.
- Combine the image with your tools when useful — e.g. an attached photo of a customer's lawn alongside their service history.

CROSS-PAGE CAPABILITIES (available on every admin page, not just their home page):
- You CAN create new customers with create_customer
- You CAN read full SMS/call history with get_conversation_thread, search_messages, get_sms_stats, and get_call_log — never claim you only see last_contact_date
- Admin sessions CAN read the email inbox (contact@wavespestcontrol.com) with get_inbox_summary, search_emails, and get_email_thread — if those tools are available to you, never claim you can't see email. Use them to pull a sender's email address, find a customer's message, or check what came in.
- Admin sessions CAN respond to emails: draft_email_reply to draft (show the draft first), send_email_reply to send, or reply_via_sms to answer an email by text instead. (Email tools are admin-only — if you don't have them, say the operator needs an admin login for email.)
- Sending SMS from outside the Communications page: use draft_sms and let the operator send

SCHEDULING INTELLIGENCE:
- Quarterly pest = every ~90 days
- Monthly lawn = every ~30 days  
- Mosquito = every ~21 days
- Overdue = past their expected frequency with no upcoming appointment
- When scheduling, prefer clustering by zone/city on the same day for route efficiency
- Morning window = 8AM-12PM, Afternoon = 12PM-5PM

The current date is ${etDateString()}.`;


// ─── MAIN QUERY ENDPOINT ────────────────────────────────────────

router.post('/query', async (req, res, next) => {
  try {
    const { prompt, conversationHistory = [], context, pageData } = req.body;
    const images = sanitizeQueryImages(req.body.images);
    const imageTainted = images.length > 0 || hasImageTaintedHistory(conversationHistory);

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: 'Prompt is required' });
    }
    if (context === 'agent_estimate' && !(await agentEstimateEnabled(req))) {
      return res.status(404).json({ error: 'Agent Estimate is not enabled' });
    }
    if (context === 'dashboard' && isNonAdminDashboardRequest(req)) {
      return res.status(403).json({ error: 'Admin access required for dashboard intelligence' });
    }
    if (context === 'banking' && req.techRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required for banking intelligence' });
    }

    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({
        error: 'AI not configured',
        message: 'ANTHROPIC_API_KEY is not set. Intelligence Bar requires Claude API access.',
      });
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Build context-aware system prompt
    let systemPrompt = SYSTEM_PROMPT;
    if (context && CONTEXT_PROMPTS[context]) {
      systemPrompt += '\n\n' + CONTEXT_PROMPTS[context];
    }
    if (context === 'agent_estimate') {
      systemPrompt += await approvedAgentEstimateMemoryPrompt();
    }
    const uiConfirmActive = uiConfirmEnabled() || context === 'agent_estimate';
    // Write-confirmation guidance must match the active mechanism (#1568) —
    // the gate is read per-request, so the prompt is appended per-request.
    if (context !== 'tech') {
      systemPrompt += uiConfirmActive
        ? `\n\nWRITE CONFIRMATION (UI mode):
Write tools (creating/updating customers, scheduling, sending SMS, etc.) do NOT execute when you call them. Your call returns a preview, and the action appears as a confirmation card in the portal UI next to your response.
- NEVER call the same write tool again after a pending_confirmation result — that creates a duplicate card. One call per intended action.
- Adding confirmed: true does nothing; it is ignored. Only the operator's Confirm click on the card executes the write.
- NEVER claim the action is done. Say it is awaiting their confirmation on the card below your message.
- The result of a confirmed write appears in the UI, not in this conversation — if asked, suggest re-querying the data.`
        : `\n\nWRITE CONFIRMATION (conversational mode):
For create_customer, the route-optimization writes, and the inventory stock writes (adjust_stock, create_restock_request, update_restock_request): the first call returns a preview — show it to the operator and re-call with confirmed: true only after they approve. For all other writes: describe the change and get an explicit yes before calling the tool.`;
    }
    // Live page data (current date, schedule stats, etc.) is injected on the
    // current user turn by buildUserMessageContent, NOT here — appending it to
    // the system prompt made the prefix unique per request and defeated
    // prompt caching.

    // Build tech context for tech portal calls
    const techContext = context === 'tech' ? {
      techId: req.technicianId || null,
      techName: req.technicianName || pageData?.tech_name || null,
    } : null;

    // Select tools based on context and role (email tools are admin-only)
    const tools = getToolsForContext(context, req.techRole === 'admin');

    // For tech context, use a simpler model to reduce latency in the field
    const model = context === 'tech' ? (process.env.INTELLIGENCE_BAR_TECH_MODEL || MODELS.FLAGSHIP) : MODEL;

    // Build messages array (support multi-turn conversation). Attached photos
    // ride on the current user turn as vision blocks.
    const messages = [
      ...conversationHistory.slice(-10).map(stripInternalHistoryMarkers),
      { role: 'user', content: buildUserMessageContent(prompt, images, pageData) },
    ];

    let currentMessages = messages;
    let finalResponse = null;
    const toolCalls = [];
    const persistedToolCalls = []; // names + field keys only — telemetry never stores argument values
    const toolResults = [];
    const pendingProposals = []; // client-only payloads (carry the confirmation ids — never shown to the model)

    // Tool-use loop
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await anthropic.messages.create({
        model: model,
        max_tokens: context === 'tech' ? 1024 : 4096,
        // 1h TTL on the tools+system prefix: operator queries routinely arrive
        // more than 5 minutes apart, so the default TTL expired between them
        // and every query paid the cache-write premium with no read. The
        // per-round message breakpoint below stays at the 5-minute default
        // (rounds are seconds apart). Longer-TTL breakpoints must precede
        // shorter-TTL ones — system renders before messages, so this is safe.
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } }],
        tools,
        messages: withCacheBreakpoint(currentMessages),
      });

      // Cache-hit visibility: cache_read > 0 on repeat queries / later rounds
      // is the prod verification signal; all-zero across repeats means a
      // silent invalidator crept back into the prefix.
      const usage = response.usage || {};
      logger.info(
        `[intelligence-bar] usage round=${round} in=${usage.input_tokens ?? 0} ` +
        `cache_write=${usage.cache_creation_input_tokens ?? 0} ` +
        `cache_read=${usage.cache_read_input_tokens ?? 0} out=${usage.output_tokens ?? 0}`
      );

      const toolUses = response.content.filter(c => c.type === 'tool_use');
      const textBlocks = response.content.filter(c => c.type === 'text');

      if (toolUses.length === 0) {
        finalResponse = textBlocks.map(t => t.text).join('\n');
        break;
      }

      // Execute all tool calls using context-aware router
      const results = [];
      for (const toolUse of toolUses) {
        // PII-bearing tool inputs (name/phone/email/address/SMS search terms) — log keys only
        const loggableInput = PII_TOOL_NAMES.has(toolUse.name)
          ? { fields: Object.keys(toolUse.input || {}), confirmed: toolUse.input?.confirmed === true }
          : toolUse.input;
        logger.info(`[intelligence-bar] Tool call: ${toolUse.name}`, loggableInput);

        let result;
        let failed = false;
        let circuitOpen = false;
        let errorMessage = null;
        const toolStartedAt = Date.now();
        if ((DASHBOARD_TOOL_NAMES.has(toolUse.name) || INFRA_TOOL_NAMES.has(toolUse.name)) && isNonAdminDashboardRequest(req)) {
          result = { error: 'Admin access required for dashboard intelligence' };
          failed = true;
          errorMessage = result.error;
        } else if (ADMIN_ONLY_TOOL_NAMES.has(toolUse.name) && req.techRole !== 'admin') {
          result = { error: 'Admin access required for this action' };
          failed = true;
          errorMessage = result.error;
        } else if (CONFIRMED_ACTION_TOOL_NAMES.has(toolUse.name)) {
          result = { error: 'Explicit confirmation is required for this action. Use the confirmed action endpoint.' };
          failed = true;
          errorMessage = result.error;
        } else if (uiConfirmActive && UI_GATED_WRITE_TOOL_NAMES.has(toolUse.name)) {
          // Issue #1568: gated writes are proposed, never executed, from the
          // model loop. The confirmation id goes to the client only.
          try {
            const proposed = await proposePendingWrite({ toolUse, req, context });
            result = proposed.modelResult;
            if (proposed.failed) {
              failed = true;
              errorMessage = result.error || 'proposal failed';
            } else if (proposed.clientPayload) {
              pendingProposals.push(proposed.clientPayload);
            }
          } catch (err) {
            logger.error(`[intelligence-bar] Proposal for ${toolUse.name} threw:`, err);
            result = { error: err.message || 'Could not create the pending action' };
            failed = true;
            errorMessage = result.error;
          }
        } else if (adminToolBreaker.isTripped()) {
          result = adminToolBreaker.fastFailResult();
          failed = true;
          circuitOpen = true;
          errorMessage = result.message;
        } else {
          try {
            result = await executeToolByName(toolUse.name, toolUse.input, techContext);
            if (isToolFailure(result)) {
              failed = true;
              errorMessage = result.error || result.message || 'tool returned error';
              adminToolBreaker.recordFailure();
            } else {
              adminToolBreaker.recordSuccess();
            }
          } catch (err) {
            logger.error(`[intelligence-bar] Tool ${toolUse.name} threw:`, err);
            adminToolBreaker.recordFailure();
            result = { error: err.message || 'Tool execution failed' };
            failed = true;
            errorMessage = err.message;
          }
        }
        recordToolEvent({
          source: context === 'tech' ? 'tech-intelligence-bar' : 'intelligence-bar',
          context: context || null,
          toolName: toolUse.name,
          success: !failed,
          durationMs: Date.now() - toolStartedAt,
          circuitOpen,
          errorMessage,
        });

        results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
          ...(failed ? { is_error: true } : {}),
        });

        toolCalls.push({ name: toolUse.name, input: loggableInput });
        persistedToolCalls.push({ name: toolUse.name, fields: Object.keys(toolUse.input || {}) });
        toolResults.push({ name: toolUse.name, result });
      }

      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: results },
      ];
    }

    if (!finalResponse) {
      finalResponse = 'I ran into a complex query that needed too many steps. Try breaking it into smaller questions.';
    }

    // Log the query for analytics. tool_calls stores names + field keys only;
    // prompt/response are additionally redacted when a PII-bearing tool ran
    // (prompts carry typed customer contact details, responses echo SMS
    // bodies) OR when the conversation is image-tainted — the current turn has
    // attachments, or an earlier image turn is still in the window and its
    // OCR-derived answer can be echoed by a follow-up that carries no images
    // itself. Either way Claude can surface a customer's name/address/phone
    // with no tool call at all.
    const usedPiiTool = toolCalls.some(c => PII_TOOL_NAMES.has(c.name));
    const redactPii = usedPiiTool || imageTainted || context === 'agent_estimate';
    const redactNote = context === 'agent_estimate'
      ? '[redacted — Agent Estimate lead context]'
      : usedPiiTool
      ? '[redacted — PII-bearing tools used]'
      : '[redacted — image attachment may contain PII]';
    try {
      await db('intelligence_bar_queries').insert({
        prompt: redactPii ? redactNote : prompt,
        response: redactPii ? redactNote : finalResponse.substring(0, 5000),
        tool_calls: JSON.stringify(persistedToolCalls),
        created_at: new Date(),
      });
    } catch {
      // Table may not exist yet — non-critical
    }

    res.json({
      response: finalResponse,
      toolCalls,
      // Return the structured data from the last tool call for UI rendering
      structuredData: toolResults.length > 0 ? toolResults[toolResults.length - 1].result : null,
      // Pending write proposals for the client confirmation card. This is the
      // ONLY channel the confirmation ids travel on — the client must keep
      // them in component state, never in conversationHistory.
      ...(uiConfirmActive ? { pendingActions: pendingProposals } : {}),
      // Return conversation history for multi-turn. Attached images are not
      // round-tripped (a text marker stands in) — keeps follow-up payloads
      // small and image bytes out of the stored history.
      conversationHistory: [
        ...conversationHistory.slice(-8),
        {
          role: 'user',
          content: markImageTaintedContent(
            images.length
              ? `${prompt}\n[Operator attached ${images.length} image${images.length > 1 ? 's' : ''}]`
              : prompt,
            imageTainted,
          ),
        },
        { role: 'assistant', content: markImageTaintedContent(finalResponse, imageTainted) },
      ],
    });

  } catch (err) {
    logger.error('[intelligence-bar] Query failed:', err);
    next(err);
  }
});


// ─── EXECUTE CONFIRMED ACTION ───────────────────────────────────

router.post('/execute', async (req, res, next) => {
  try {
    const { action, params, confirmed } = req.body;

    if (!action) {
      return res.status(400).json({ error: 'Action is required' });
    }
    if (action === AGENT_ESTIMATE_WRITE_TOOL && !(await agentEstimateEnabled(req))) {
      return res.status(404).json({ error: 'Agent Estimate is not enabled' });
    }
    if ((DASHBOARD_TOOL_NAMES.has(action) || INFRA_TOOL_NAMES.has(action)) && isNonAdminDashboardRequest(req)) {
      return res.status(403).json({ error: 'Admin access required for dashboard actions' });
    }
    if (BANKING_TOOL_NAMES.has(action) && req.techRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required for banking actions' });
    }
    if (ADMIN_ONLY_TOOL_NAMES.has(action) && req.techRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required for this action' });
    }
    if ((uiConfirmEnabled() || action === AGENT_ESTIMATE_WRITE_TOOL) && UI_GATED_WRITE_TOOL_NAMES.has(action)) {
      // With the UI-confirm gate on, gated writes commit exclusively through
      // /confirm-action — /execute would skip the claim, payload hash, and
      // single-use replay protection.
      return res.status(409).json({ error: 'This write requires a confirmed pending action. Use /confirm-action with a pending_action_id.' });
    }
    if (SEO_CONFIRMED_ACTION_TOOL_NAMES.has(action) && req.techRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required for SEO actions' });
    }
    if (CONFIRMED_ACTION_TOOL_NAMES.has(action) && confirmed !== true) {
      return res.status(400).json({ error: 'Explicit confirmation is required for this action' });
    }

    let executionParams = params || {};
    if (CONFIRMED_ACTION_TOOL_NAMES.has(action)) {
      const idempotencyKey = getConfirmedActionIdempotencyKey(req, executionParams);
      if (!idempotencyKey) {
        return res.status(400).json({ error: 'A valid idempotency key is required for this action' });
      }
      executionParams = {
        ...executionParams,
        idempotencyKey,
        requestedBy: getAdminActorId(req),
      };
    }

    const actionContext = {
      isAdmin: req.techRole === 'admin',
      technicianId: req.technicianId || req.technician?.id || null,
      confirmed: confirmed === true,
    };
    const result = await executeToolByName(action, executionParams, null, actionContext);

    logger.info(`[intelligence-bar] Executed action: ${action}`, PII_TOOL_NAMES.has(action)
      ? { fields: Object.keys(executionParams) }
      : {
        ...executionParams,
        ...(executionParams.idempotencyKey ? { idempotencyKey: '[redacted]' } : {}),
      });

    res.json({
      success: !result.error,
      result,
    });

  } catch (err) {
    logger.error('[intelligence-bar] Execute failed:', err);
    next(err);
  }
});


// ─── UI-CONFIRMED PENDING ACTIONS (issue #1568) ─────────────────
// Called by the portal client only. These are NOT model tools — they never
// appear in any tools array, so the model cannot invoke them. The
// pending-action id is the confirmation credential: it travels client →
// server only, and only a real Confirm click produces it.

router.post('/confirm-action', async (req, res, next) => {
  try {
    const id = String(req.body?.pending_action_id || '').trim();
    if (!id) return res.status(400).json({ error: 'pending_action_id is required' });

    const claim = await PendingActions.claimForConfirm(id, getAdminActorId(req));
    if (claim.error) {
      const status = claim.error === 'not_found' ? 404
        : claim.error === 'actor_mismatch' ? 403
          : 409; // already_used | cancelled | expired | hash_mismatch
      return res.status(status).json({ error: `Pending action ${claim.error.replace(/_/g, ' ')}` });
    }
    const action = claim.action;

    if (action.tool_name === AGENT_ESTIMATE_WRITE_TOOL && !(await agentEstimateEnabled(req))) {
      await PendingActions.recordResult(action.id, { error: 'Agent Estimate is not enabled' });
      return res.status(404).json({ error: 'Agent Estimate is not enabled' });
    }

    if (ADMIN_ONLY_TOOL_NAMES.has(action.tool_name) && req.techRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required for this action' });
    }

    const execParams = { ...action.params };
    if (WRITE_TWO_STEP_TOOL_NAMES.has(action.tool_name)) {
      // Server-derived confirmation: the operator clicked Confirm. This is
      // the only place a confirmed flag is ever attached.
      execParams.confirmed = true;
    }

    const result = await executeToolByName(action.tool_name, execParams, null, {
      isAdmin: req.techRole === 'admin',
      technicianId: req.technicianId || req.technician?.id || null,
      confirmed: true,
    });
    await PendingActions.recordResult(action.id, result);

    logger.info(`[intelligence-bar:pending] Confirmed action ${action.id} (${action.tool_name})`, {
      success: !result?.error,
    });

    res.json({ success: !result?.error, tool: action.tool_name, result });
  } catch (err) {
    logger.error('[intelligence-bar] confirm-action failed:', err);
    next(err);
  }
});

router.post('/cancel-action', async (req, res, next) => {
  try {
    const id = String(req.body?.pending_action_id || '').trim();
    if (!id) return res.status(400).json({ error: 'pending_action_id is required' });

    const { cancelled } = await PendingActions.cancelPendingAction(id, getAdminActorId(req));
    if (!cancelled) return res.status(409).json({ error: 'Pending action not cancellable (missing, expired, consumed, or not yours)' });

    logger.info(`[intelligence-bar:pending] Cancelled action ${id}`);
    res.json({ success: true });
  } catch (err) {
    logger.error('[intelligence-bar] cancel-action failed:', err);
    next(err);
  }
});


// ─── QUICK ACTIONS (pre-built prompts for common tasks) ─────────

router.get('/quick-actions', async (req, res) => {
  const { context } = req.query;
  if (context === 'agent_estimate' && !(await agentEstimateEnabled(req))) {
    return res.status(404).json({ error: 'Agent Estimate is not enabled' });
  }
  if (context === 'dashboard' && isNonAdminDashboardRequest(req)) {
    return res.status(403).json({ error: 'Admin access required for dashboard intelligence' });
  }
  if (context === 'banking' && req.techRole !== 'admin') {
    return res.status(403).json({ error: 'Admin access required for banking intelligence' });
  }

  const baseActions = [
    { id: 'missing_city', group: 'Find', label: 'Missing Cities', prompt: 'Show me customers with no city on their profile' },
    { id: 'pest_overdue', group: 'Find', label: 'Pest Overdue', prompt: 'Which quarterly pest control customers are overdue for service?' },
    { id: 'lawn_overdue', group: 'Find', label: 'Lawn Overdue', prompt: 'Which monthly lawn care customers are overdue?' },
    { id: 'at_risk', group: 'Find', label: 'At Risk', prompt: 'Show me customers with health scores below 40' },
    { id: 'no_email', group: 'Find', label: 'Missing Emails', prompt: 'Customers with no email address' },
    { id: 'high_balance', group: 'Find', label: 'Outstanding Balances', prompt: 'Who has an outstanding balance over $100?' },
    { id: 'duplicates', group: 'Find', label: 'Duplicates', prompt: 'Find duplicate customers by phone number' },
    { id: 'win_back', group: 'Find', label: 'Win Back', prompt: 'Show churned customers from the last 6 months who were Gold or Platinum tier' },
    { id: 'schedule_gaps', group: 'Analyze', label: 'Schedule Gaps', prompt: `What does this week's schedule look like? Any gaps?` },
    { id: 'tech_performance', group: 'Analyze', label: 'Tech Performance', prompt: 'Compare technician performance this month' },
  ];

  const scheduleActions = [
    { id: 'day_briefing', group: 'Plan', label: 'Day Briefing', prompt: 'Give me a full briefing for today' },
    { id: 'find_time', group: 'Plan', label: 'Find a Time', prompt: 'Find the best time slot for a new customer — ask me for the address and service type' },
    { id: 'gaps_this_week', group: 'Plan', label: 'Gaps This Week', prompt: 'Where do we have open capacity this week?' },
    { id: 'optimize', group: 'Optimize', label: 'Optimize Routes', prompt: 'Optimize all routes for today' },
    { id: 'zone_density', group: 'Optimize', label: 'Zone Density', prompt: 'Analyze zone density for today — any consolidation opportunities?' },
    { id: 'far_out', group: 'Optimize', label: 'Far-Out Appointments', prompt: 'Find appointments scheduled more than 30 days out that we could move sooner' },
    { id: 'unassigned', group: 'Fix', label: 'Unassigned Stops', prompt: 'Show me unassigned stops and suggest tech assignments' },
    { id: 'overdue_no_appt', group: 'Fix', label: 'Overdue + No Appt', prompt: 'Which overdue customers have no upcoming appointment at all?' },
    { id: 'pest_overdue_sched', group: 'Fix', label: 'Pest Overdue', prompt: 'Quarterly pest customers overdue — schedule them into open slots this week' },
  ];

  const dashboardActions = [
    { id: 'briefing', group: 'Summary', label: 'Morning Briefing', prompt: 'Give me a morning briefing — what do I need to know today?' },
    { id: 'this_vs_last', group: 'Summary', label: 'This vs Last Week', prompt: 'How did we do this week compared to last week?' },
    { id: 'mrr', group: 'Metrics', label: 'MRR Trend', prompt: "What's our MRR trend over the last 6 months?" },
    { id: 'close_rate', group: 'Metrics', label: 'Close Rate', prompt: "What's our estimate close rate this month?" },
    { id: 'revenue_by_service', group: 'Metrics', label: 'Revenue by Service', prompt: 'Break down revenue by service type this month' },
    { id: 'churn', group: 'Metrics', label: 'Churn Check', prompt: 'Any churn this month? Who did we lose and what was the revenue impact?' },
    { id: 'lead_sources', group: 'Ops', label: 'Lead Sources', prompt: 'Where are new customers coming from? Which source converts best?' },
    { id: 'balances', group: 'Ops', label: 'Outstanding Balances', prompt: "What's outstanding? Show me the aging breakdown and top debtors" },
    { id: 'infra_check', group: 'Ops', label: 'Infra Check', prompt: 'Full infrastructure health check: Railway deploy status for each service, Sentry top and new issues in the last 24 hours, Cloudflare Pages build failures, and any Stripe or Twilio webhook/delivery failures.' },
    { id: 'error_check', group: 'Ops', label: 'Error Check', prompt: 'Check Sentry: top unresolved errors and any issues that first appeared in the last 24 hours.' },
    { id: 'shipped_today', group: 'Ops', label: 'What Shipped', prompt: 'What shipped recently? List merged PRs from the last 48 hours and confirm the latest Railway deploy is green.' },
  ];

  const seoActions = [
    { id: 'concept_map', group: 'Analyze', label: 'Concept Map', prompt: 'Show me the semantic concept map for pest control — what entities, subtopics, and related concepts should our pages cover?' },
    { id: 'entity_gaps', group: 'Analyze', label: 'Entity Gaps', prompt: 'Which pages are losing position and likely have entity gaps vs competitors? Check against the concept clusters.' },
    { id: 'drops', group: 'Analyze', label: 'Ranking Drops', prompt: 'Which keywords dropped in rankings this week? Cross-reference with entity coverage gaps.' },
    { id: 'top_queries', group: 'Analyze', label: 'Top Queries', prompt: 'What are our top 20 non-branded keywords by clicks? Which concept clusters do they belong to?' },
    { id: 'decay', group: 'Analyze', label: 'Content Decay', prompt: 'Any content decay alerts or keyword cannibalization issues?' },
    { id: 'refresh_score', group: 'Plan', label: 'Refresh Priority', prompt: 'Score all pages for refresh priority. Which pages have the highest ROI for a semantic update?' },
    { id: 'content_brief', group: 'Plan', label: 'Content Brief', prompt: 'Build a content workflow brief for "pest control bradenton fl" — SERP analysis, entity map, and content blueprint.' },
    { id: 'content_pipe', group: 'Plan', label: 'Content Pipeline', prompt: "What's in the content pipeline? How many posts need generation?" },
  ];

  if (context === 'agent_estimate') {
    res.json({ actions: [
      { id: 'build', group: 'Build', label: 'Build Estimate', prompt: 'Build the estimate from all available evidence. Verify property facts, protocols, inventory, and per-line margin, then propose the draft for my confirmation.' },
      { id: 'property', group: 'Verify', label: 'Verify Property', prompt: 'Double-check the home/building sqft, lot sqft, stories, and treatable lawn area. Show sources and conflicts per field.' },
      { id: 'margin', group: 'Verify', label: 'Check Margin', prompt: 'Re-run the current engine inputs and confirm each service line protects the 35% collected margin using $35/hour loaded labor.' },
      { id: 'protocol', group: 'Verify', label: 'Protocol + Stock', prompt: 'Read the complete protocols for the proposed services and check the named products in inventory. Treat missing counts as untracked.' },
      { id: 'grass', group: 'Property', label: 'Grass Type', prompt: 'What grass is typical in this ZIP, and what evidence do we still need to verify this actual lawn?' },
      { id: 'palms', group: 'Photo', label: 'Count Palms', prompt: 'Count the palm trees visible in the attached property image. Give a count or range, note occlusions, and do not change pricing until I confirm.' },
    ] });
  } else if (context === 'schedule' || context === 'dispatch') {
    res.json({ actions: scheduleActions });
  } else if (context === 'dashboard') {
    res.json({ actions: dashboardActions });
  } else if (context === 'seo' || context === 'blog') {
    res.json({ actions: seoActions });
  } else if (context === 'procurement' || context === 'inventory') {
    res.json({ actions: [
      { id: 'unpriced', group: 'Find', label: 'Unpriced Products', prompt: 'What products still need pricing? Prioritize by category.' },
      { id: 'cheapest', group: 'Find', label: 'Cheapest Sources', prompt: 'Where are we getting the best deals? Any products where a cheaper vendor exists?' },
      { id: 'herbicides', group: 'Find', label: 'Herbicide Prices', prompt: 'Compare prices on all our pre-emergent herbicides' },
      { id: 'approvals', group: 'Find', label: 'Approval Queue', prompt: 'Any pending price approvals? Show me what needs review.' },
      { id: 'compare', group: 'Analyze', label: 'Compare Vendors', prompt: 'Compare SiteOne vs LESCO pricing on our top 10 most-used products' },
      { id: 'margins', group: 'Analyze', label: 'Margin Analysis', prompt: 'What are our margins by service type?' },
      { id: 'trends', group: 'Analyze', label: 'Price Trends', prompt: 'Have any product prices gone up in the last 90 days?' },
      { id: 'price_check', group: 'Act', label: 'Run Price Check', prompt: 'Run a price check on Demand CS across all vendors' },
      { id: 'low_stock', group: 'Find', label: 'Low Stock', prompt: 'Which products are low or out of stock? Include anything at or below its low-stock threshold.' },
      { id: 'restock_queue', group: 'Find', label: 'Restock Queue', prompt: 'Show the open restock requests. Anything urgent or past its needed-by date?' },
      { id: 'stock_count', group: 'Act', label: 'Log Stock Count', prompt: 'I just did a physical stock count. Walk me through logging on-hand amounts product by product.' },
    ] });
  } else if (context === 'revenue') {
    res.json({ actions: [
      { id: 'overview', group: 'Overview', label: 'Revenue Overview', prompt: "How's revenue this month? Show me the full picture with margins." },
      { id: 'compare', group: 'Overview', label: 'This vs Last Month', prompt: 'Compare this month vs last month — revenue, margin, RPMH, everything' },
      { id: 'quarter', group: 'Overview', label: 'Quarter View', prompt: "How's revenue this quarter compared to last quarter?" },
      { id: 'service_lines', group: 'Analyze', label: 'Service Line P&L', prompt: 'Break down P&L by service line. Which has the best margin?' },
      { id: 'tech_perf', group: 'Analyze', label: 'Tech RPMH', prompt: 'Rank technicians by revenue per man-hour' },
      { id: 'top_customers', group: 'Analyze', label: 'Top 10 Customers', prompt: 'Who are our top 10 customers by revenue this month?' },
      { id: 'ad_roi', group: 'Analyze', label: 'Ad ROI', prompt: "What's our ad attribution? ROAS and CAC by channel?" },
      { id: 'low_margin', group: 'Watch', label: 'Low Margin Alert', prompt: 'Which service lines are below our active margin floor?' },
    ] });
  } else if (context === 'tech') {
    res.json({ actions: [
      { id: 'route', group: 'Today', label: "Today's Route", prompt: "What's my route today?" },
      { id: 'next', group: 'Today', label: "What's Next?", prompt: "What's my next stop? Any special notes?" },
      { id: 'remaining', group: 'Today', label: 'How Many Left?', prompt: 'How many stops do I have left today?' },
      { id: 'weather', group: 'Conditions', label: 'Spray Check', prompt: 'Can I spray right now? Check wind and rain.' },
      { id: 'protocol', group: 'Reference', label: 'Pest Protocol', prompt: 'What products and rates for quarterly pest control?' },
      { id: 'lawn_protocol', group: 'Reference', label: 'Lawn Protocol', prompt: 'Lawn care protocol for St. Augustine' },
    ] });
  } else if (context === 'reviews') {
    res.json({ actions: [
      { id: 'stats', group: 'Monitor', label: 'Review Stats', prompt: 'How are our Google reviews? Give me the full picture.' },
      { id: 'unresponded', group: 'Monitor', label: 'Needs Reply', prompt: 'Show me reviews that need a reply — prioritize negative ones' },
      { id: 'negative', group: 'Monitor', label: 'Negative Reviews', prompt: 'Show me all 1-2 star reviews. Any patterns?' },
      { id: 'trends', group: 'Monitor', label: 'Review Trends', prompt: 'Are our reviews improving? Show the 6-month trend.' },
      { id: 'by_location', group: 'Monitor', label: 'By Location', prompt: 'Compare review counts and ratings across all 4 locations' },
      { id: 'draft_all', group: 'Act', label: 'Draft Replies', prompt: 'Draft AI replies for all unresponded reviews' },
      { id: 'outreach', group: 'Act', label: 'Outreach Candidates', prompt: 'Who should we ask for reviews? Show Gold and Platinum customers first.' },
      { id: 'velocity', group: 'Analyze', label: 'Velocity Pipeline', prompt: "What's our review request conversion rate?" },
    ] });
  } else if (context === 'comms') {
    res.json({ actions: [
      { id: 'unanswered', group: 'Triage', label: 'Unanswered', prompt: 'Any unanswered messages? Who is waiting for a reply?' },
      { id: 'today', group: 'Triage', label: "Today's Activity", prompt: "What happened today? Messages, calls, anything missed?" },
      { id: 'calls', group: 'Triage', label: 'Recent Calls', prompt: "What calls came in today? Any with recordings?" },
      { id: 'stats', group: 'Analyze', label: 'SMS Stats', prompt: 'SMS volume breakdown this month by type' },
      { id: 'csr', group: 'Analyze', label: 'CSR Coach', prompt: "How's the CSR performance? Any follow-up tasks pending?" },
      { id: 'search', group: 'Search', label: 'Search Messages', prompt: 'Search messages about...' },
    ] });
  } else if (context === 'tax') {
    res.json({ actions: [
      { id: 'overview', group: 'Overview', label: 'Tax Overview', prompt: "Give me the full tax picture — expenses, deductions, equipment, upcoming deadlines." },
      { id: 'pnl', group: 'Overview', label: 'P&L', prompt: "Month-to-date P&L with gross and net margins" },
      { id: 'quarterly', group: 'Overview', label: 'Quarterly Estimate', prompt: "What's my estimated quarterly tax payment? Break down federal and self-employment." },
      { id: 'deadlines', group: 'Overview', label: 'Deadlines', prompt: 'When are my next tax deadlines? Anything overdue?' },
      { id: 'expenses', group: 'Details', label: 'Expenses YTD', prompt: 'Show me expenses by category this year. What percentage is deductible?' },
      { id: 'equipment', group: 'Details', label: 'Depreciation', prompt: 'Which equipment is fully depreciated? Any Section 179 candidates?' },
      { id: 'mileage', group: 'Details', label: 'Mileage', prompt: 'Mileage deduction so far this year?' },
      { id: 'ar', group: 'Details', label: 'A/R Aging', prompt: "Who owes us money? Show me the accounts receivable aging." },
      { id: 'advisor', group: 'Advise', label: 'Run Advisor', prompt: 'Run the AI tax advisor — check for savings opportunities and regulation changes.' },
    ] });
  } else if (context === 'leads') {
    res.json({ actions: [
      { id: 'overview', group: 'Pipeline', label: 'Pipeline Overview', prompt: 'How does the pipeline look? Active leads, conversion rate, response time.' },
      { id: 'new_leads', group: 'Pipeline', label: 'New Leads', prompt: 'Show me all new leads this week' },
      { id: 'stale', group: 'Pipeline', label: 'Stale Leads', prompt: "Which leads haven't been contacted in 48 hours? These are going cold." },
      { id: 'funnel', group: 'Analyze', label: 'Funnel', prompt: "Show me the funnel. Where's the bottleneck?" },
      { id: 'sources', group: 'Analyze', label: 'Source ROI', prompt: 'Compare lead sources by conversion rate and ROI' },
      { id: 'lost', group: 'Analyze', label: 'Lost Analysis', prompt: 'Why are we losing leads? Break down by reason.' },
      { id: 'response', group: 'Analyze', label: 'Response Times', prompt: 'How fast are we responding? Does speed correlate with conversion?' },
      { id: 'cleanup', group: 'Cleanup', label: 'Pipeline Cleanup', prompt: 'How many unresponsive leads older than 30 days should we move to lost?' },
    ] });
  } else if (context === 'email') {
    res.json({ actions: [
      { id: 'summary', group: 'Today', label: 'Inbox Summary', prompt: 'What came in today? Give me the full picture.' },
      { id: 'unread', group: 'Today', label: 'Unread', prompt: 'Show me all unread emails that need attention' },
      { id: 'invoices', group: 'Categorize', label: 'Vendor Invoices', prompt: 'Any vendor invoices to review? Show amounts and status.' },
      { id: 'leads', group: 'Categorize', label: 'Email Leads', prompt: 'How many leads came in via email this month? Show me the recent ones.' },
      { id: 'blocked', group: 'Categorize', label: 'Blocked Senders', prompt: 'How many spam senders are blocked? Show the top domains.' },
      { id: 'stats', group: 'Analyze', label: 'Email Stats', prompt: 'Email volume and classification breakdown this month' },
    ] });
  } else if (context === 'estimates') {
    res.json({ actions: [
      { id: 'quote_address', group: 'Draft', label: 'Quote an Address', prompt: 'I want to draft a quote. The address is __ , customer is __ , phone __ , services they want: __ . Walk me through it.' },
      { id: 'commercial', group: 'Draft', label: 'Commercial Scenario', prompt: 'Help me think through a commercial quote — gather the info you need first, then tell me whether the engine can handle it or if we need to do this manually.' },
      { id: 'comp_check', group: 'Context', label: 'Find Comps', prompt: 'Find recent estimates around $__/mo so I can sanity-check what we usually charge for that range' },
      { id: 'recent_changes', group: 'Context', label: 'Recent Pricing Changes', prompt: 'What pricing changes happened recently? Anything that would affect a quote I am about to draft?' },
      { id: 'review_drafts', group: 'Review', label: 'My Agent Drafts', prompt: 'Show me agent-created draft estimates that need review' },
    ] });
  } else if (context === 'banking') {
    res.json({ actions: [
      { id: 'balance', group: 'Status', label: 'Stripe Balance', prompt: "What's my Stripe balance right now?" },
      { id: 'payouts', group: 'Status', label: 'Recent Payouts', prompt: 'Show me recent payouts to the bank' },
      { id: 'cash_flow', group: 'Status', label: 'Cash Flow', prompt: 'Cash flow this month — am I cash positive?' },
      { id: 'fees', group: 'Analyze', label: 'Fee Analysis', prompt: 'How much are we paying in Stripe fees? What is the effective rate?' },
      { id: 'reconcile', group: 'Analyze', label: 'Reconciliation', prompt: 'Any unreconciled payouts?' },
      { id: 'export', group: 'Export', label: 'Export', prompt: 'Export this month payouts as CSV' },
    ] });
  } else {
    res.json({ actions: baseActions });
  }
});


module.exports = router;
// Exposed for the write-gate contract test — keeps the test's
// CONFIRMED_ENDPOINT_WRITES classification tied to the real route guard.
module.exports.CONFIRMED_ACTION_TOOL_NAMES = CONFIRMED_ACTION_TOOL_NAMES;
module.exports.AGENT_ESTIMATE_TOOL_NAMES = new Set(AGENT_ESTIMATE_TOOLS.map((tool) => tool.name));
