const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../models/db');
const { DELIVERY_CLAIM_NOT_LIVE_SQL, callSideBlockForEstimateData, REPRICE_PENDING_ABSENT_SQL } = require('../utils/estimate-claim-sql');
const smsTemplatesRouter = require('./admin-sms-templates');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
// Real handoffs kept in deliveryState.deliveredAt (oldest dropped first).
const DELIVERY_HISTORY_MAX = 25;
const { shortenOrPassthrough } = require('../services/short-url');
const { mintEstimateAcceptToken } = require('../utils/estimate-handoff-token');
const { leadIdForEstimate } = require('../services/estimate-lead-linkage');
const { wrapEmail, plainText } = require('../services/email-template');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const {
  estimateDataHasQuoteRequirement,
  estimateDataHasUnresolvedManagerApproval,
  commercialRiskTypeReviewNeeded,
  validateEstimateDeliveryOptions,
} = require('../services/estimate-delivery-options');
const EmailTemplateLibrary = require('../services/email-template-library');
const sendgrid = require('../services/sendgrid-mail');
const { clearRouteCacheForRequest } = require('../utils/route-cache');
const { clearEstimatePricingCache } = require('../services/estimate-pricing-cache');
const {
  buildEstimatePricingAudit,
  buildEstimatePricingRiskBatch,
  getLatestEstimatePricingAuditSnapshot,
  saveEstimatePricingAuditSnapshot,
} = require('../services/estimate-pricing-audit');
const { WAVEGUARD: PRICING_WAVEGUARD } = require('../services/pricing-engine/constants');
const {
  markLinkedLeadEstimateSent,
} = require('../services/lead-estimate-link');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');
const { smtpFallbackAllowed } = require('../services/email-fallback-gate');
const { markEstimateManuallyAccepted } = require('../services/estimate-manual-acceptance');
const { buildProposalFirstInvoice } = require('../services/proposal-win');
const { deliveredEstimateScope } = require('../services/triage-auto-resolve');
const {
  createOrReuseAdminEstimate,
  estimateExpiresAt,
  estimateReviseBlock,
  estimateEditVersion,
  estimateViewUrl,
  reviseAdminEstimate,
  lockScheduledGroupGuardGroups,
  assertNoRevisionDuringGroupSend,
  staleCallLinkageReason,
  completePendingInvalidation,
  takePendingInvalidation,
} = require('../services/admin-estimate-persistence');
const { estimateDataCarriesBermudaSuppression } = require('../services/pricing-engine/v1-legacy-mapper');
const {
  inferEstimateServiceInterest,
  inferEstimateServiceLines,
} = require('../services/estimate-service-lines');
const { normalizeProposal, computeProposalTotals, isCommercialProposalData } = require('../services/estimate-proposal');
const { generateEstimateProposalPDF } = require('../services/pdf/estimate-pdf');
const {
  acceptanceServiceLists,
  buildPricingBundle,
  bookingServiceFor,
} = require('./estimate-public');
const {
  leadEstimateAutoSendConfigFromEnv,
  previewLeadEstimateAutoSendAudit,
} = require('../services/lead-estimate-auto-send');
const {
  CONTENT_LIBRARY_VERSION,
  PRODUCT_REGISTRY_VERSION,
  PROTOCOL_VERSION,
  TEMPLATE_VERSION,
} = require('../services/lawn-service-outline');

// Hard ceiling for limit=all list fetches. The estimates pipeline computes
// all-time KPIs client-side from this list; if the table ever outgrows this
// cap the analytics silently truncate to the newest rows, so keep generous
// headroom (pricing-risk batch is pure compute after one inventory preload).
const ESTIMATE_LIST_LIMIT = 2000;
const SENDABLE_ESTIMATE_STATUSES = new Set(['draft', 'scheduled', 'sending', 'sent', 'viewed', 'send_failed']);
const SENT_ONLY_DELIVERY_ATTEMPT_STATUSES = ['scheduled', 'sending', 'send_failed'];

function estimateMatchesSentOnlyScope(estimate = {}) {
  return !!estimate.sent_at || SENT_ONLY_DELIVERY_ATTEMPT_STATUSES.includes(String(estimate.status || ''));
}

async function renderTemplate(templateKey, vars, context = {}) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars, context);
      if (body) return body;
    }
  } catch (err) {
    logger.warn(`[admin-estimates] SMS template ${templateKey} lookup failed: ${err.message}`);
  }
  logger.warn(`[admin-estimates] SMS template ${templateKey} missing/disabled/invalid`);
  return null;
}

function parseEstimateData(estimateData) {
  if (!estimateData) return null;
  if (typeof estimateData === 'string') {
    try {
      return JSON.parse(estimateData);
    } catch {
      return null;
    }
  }
  return typeof estimateData === 'object' ? estimateData : null;
}

// Operational delivery stamps may change while the claim is taken. Contact,
// property, scope, terms and dollars must still be the offer that was reviewed.
function estimateOfferVersion(row) {
  const data = { ...(parseEstimateData(row.estimate_data) || {}) };
  for (const key of ['sendSnapshot', 'deliveryState', 'manualSendAttempts']) delete data[key];
  if (data.estimatorEngine) {
    data.estimatorEngine = { ...data.estimatorEngine };
    delete data.estimatorEngine.delivering_at;
    delete data.estimatorEngine.delivering_token;
  }
  const fields = ['customer_id', 'property_id', 'estimate_group_id', 'customer_name', 'customer_phone', 'customer_email', 'address', 'notes', 'monthly_total', 'annual_total', 'onetime_total', 'show_one_time_option', 'bill_by_invoice'];
  return crypto.createHash('sha256').update(JSON.stringify([fields.map((key) => row[key]), data])).digest('hex');
}

// When an operator authors a commercial proposal, their line items ARE the
// quote — so the auto-quote-required state a commercial estimate is created
// with must be cleared, or the recursive estimateDataHasQuoteRequirement send
// gate keeps blocking delivery with the manual-review error. Clearing these
// raw booleans does NOT re-open the self-serve accept path: the public view
// derives its manual-acceptance state from estimate_data.proposal.enabled
// (see estimate-public resolveEstimateQuoteRequirement), not these flags.
function clearQuoteRequirementFlags(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return;
  if (Array.isArray(value)) {
    value.forEach((item) => clearQuoteRequirementFlags(item, depth + 1));
    return;
  }
  if (value.quoteRequired === true) value.quoteRequired = false;
  if (value.requiresCustomQuote === true) value.requiresCustomQuote = false;
  if (value.autoQuoteRequiresAdminApproval === true) value.autoQuoteRequiresAdminApproval = false;
  for (const v of Object.values(value)) clearQuoteRequirementFlags(v, depth + 1);
}

// Lead-created manual-quote estimates carry a blocking draft/lead automation
// status (manual_review_required / blocked / generation_failed) that
// assertEstimateSendable also rejects. The authored proposal IS that manual
// review output, so mark those automation nodes resolved when it's saved —
// otherwise the operator's finished proposal still can't be sent.
const BLOCKING_AUTOMATION_STATUSES = new Set(['manual_review_required', 'blocked', 'generation_failed']);
function resolveBlockingAutomationForProposal(data) {
  const automation = data?.automation;
  if (!automation || typeof automation !== 'object') return;
  for (const key of ['draftEstimateAutomation', 'leadEstimateAutomation']) {
    const node = automation[key];
    if (node && typeof node === 'object' && BLOCKING_AUTOMATION_STATUSES.has(node.status)) {
      node.status = 'manual_review_complete';
      node.resolvedByProposalAt = new Date().toISOString();
    }
  }
}

// proposalDelivery records how a PREVIOUS send delivered the proposal PDF
// (estimate_data.proposalDelivery.pdfEmailed drives the public "PDF emailed"
// copy). Re-authoring the proposal makes that emailed-PDF claim stale, so drop
// it when saving — the next send re-stamps it against the new PDF.
function clearStaleProposalDelivery(data) {
  if (data && typeof data === 'object') delete data.proposalDelivery;
}

function leadEstimateAutomationSummary(estimateData) {
  const data = parseEstimateData(estimateData) || {};
  const automation = data.automation || {};
  const draft = automation.draftEstimateAutomation || null;
  const gate = automation.leadEstimateAutomation || null;
  if (!draft && !gate) return null;

  const status = draft?.status || gate?.status || 'unknown';
  const review = [
    ...(Array.isArray(gate?.review) ? gate.review : []),
    ...(Array.isArray(draft?.review) ? draft.review : []),
  ];
  const missing = Array.isArray(gate?.missing) ? gate.missing : [];
  return {
    status,
    generated: draft?.generated === true,
    confidence: gate?.confidence || null,
    minimumConfidence: gate?.minimumConfidence || null,
    quoteRequired: draft?.quoteRequired === true || data.quoteRequired === true,
    unsupportedReason: draft?.unsupportedReason || null,
    quoteRequiredReason: draft?.quoteRequiredReason || data.quoteRequiredReason || null,
    review: [...new Set(review.filter(Boolean))],
    missing: [...new Set(missing.filter(Boolean))],
  };
}

function estimateDataHasBlockingLeadAutomation(estimateData) {
  const summary = leadEstimateAutomationSummary(estimateData);
  if (!summary) return false;
  return ['blocked', 'manual_review_required', 'generation_failed'].includes(summary.status);
}

function currentTierDiscounts() {
  const tiers = PRICING_WAVEGUARD.tiers || {};
  return Object.fromEntries(
    Object.entries(tiers).map(([key, value]) => [
      key.charAt(0).toUpperCase() + key.slice(1),
      Number(value?.discount || 0),
    ]),
  );
}

function canFallbackFromTemplateEmailError(err) {
  return /relation .*email_templates.* does not exist|active template not found|template version not found|template not found/i.test(err?.message || '');
}

function estimateEmailKeyPart(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return String(value);
}

function estimateEmailIdempotencyKey(estimate, explicitAttemptKey = null) {
  const normalizedEmail = String(estimate.customer_email || '').trim().toLowerCase();
  const explicit = String(explicitAttemptKey || '').trim().replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 120);
  const scheduledAt = estimateEmailKeyPart(estimate.scheduled_at);
  const status = String(estimate.status || '').toLowerCase();
  const scheduledGeneration = estimateEmailKeyPart(estimate.sent_at)
    || estimateEmailKeyPart(estimate.created_at)
    || 'initial';
  const scope = explicit
    ? `attempt:${explicit}`
    : scheduledAt && ['scheduled', 'sending'].includes(status)
    ? `scheduled:${scheduledGeneration}`
    : 'manual:legacy';
  const rawKey = `estimate.delivery:${estimate.id}:${normalizedEmail}:${scope}`;
  return `estimate.delivery:${crypto.createHash('sha256').update(rawKey).digest('hex')}`;
}

function moneySummary(estimate = {}, { allowTotals = false } = {}) {
  const monthlyTotal = parseFloat(estimate.monthly_total || estimate.monthlyTotal || 0);
  const annualTotal = parseFloat(estimate.annual_total || estimate.annualTotal || 0);
  const oneTimeTotal = parseFloat(estimate.onetime_total || estimate.oneTimeTotal || estimate.onetimeTotal || 0);
  if (monthlyTotal > 0) {
    // Commercial proposals (allowTotals) keep annual framing — boards budget
    // annually; the owner exempted them (2026-07-11). Residential emails
    // never restate monthly/annual totals: the linked estimate leads with
    // per-application pricing.
    if (allowTotals) {
      return annualTotal > 0
        ? `$${monthlyTotal.toFixed(2)}/mo · $${annualTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/yr`
        : `$${monthlyTotal.toFixed(2)}/mo`;
    }
    return 'Priced per application — full breakdown inside';
  }
  if (oneTimeTotal > 0) return `$${oneTimeTotal.toFixed(2)} one-time`;
  return '';
}

function estimateSendableAmount(estimate = {}) {
  const monthlyTotal = parseFloat(estimate.monthly_total || estimate.monthlyTotal || 0);
  const oneTimeTotal = parseFloat(estimate.onetime_total || estimate.oneTimeTotal || estimate.onetimeTotal || 0);
  return Math.max(
    Number.isFinite(monthlyTotal) ? monthlyTotal : 0,
    Number.isFinite(oneTimeTotal) ? oneTimeTotal : 0,
  );
}

// Commercial proposals are accepted manually (no online checkout), so the
// "accept it online" next-step copy would point the customer at a flow that
// is intentionally rejected for them. Use proposal-specific copy instead.
const PROPOSAL_NEXT_STEP_SUMMARY = 'Your formal proposal is attached as a PDF. There is no online checkout for a commercial bid — your Waves account manager will follow up to answer questions and finalize the agreement. Call (941) 297-5749 anytime.';

function estimateEmailPayload({ estimate, firstName, viewUrl, priceLine, proposalMode = false }) {
  const serviceSummary = inferEstimateServiceInterest({
    ...estimate,
    estimateData: estimate.estimate_data,
  });
  return {
    first_name: firstName,
    estimate_url: viewUrl,
    price_summary: priceLine || moneySummary(estimate, { allowTotals: proposalMode }),
    service_summary: serviceSummary || '',
    property_address: estimate.address || '',
    next_step_summary: proposalMode
      ? PROPOSAL_NEXT_STEP_SUMMARY
      : 'When you are ready, open the estimate and accept it online. We will collect the final setup details after that.',
  };
}

// True when the engine-authoritative pricing gate applies to THIS send: gate
// on and not an authored proposal (its line items ARE the quote). Delivered
// rows are NOT exempt — a revision of a live link can fall back too, and its
// resend would deliver the unverified price (pre-push codex P0). Shared by
// the pre-read check in assertEstimateSendable and by the send CLAIMS, which
// re-assert it as a WHERE predicate so a revision that stamps CLIENT_FALLBACK
// between the check and the claim loses the race instead of being delivered.
// The server-owned provenance marker PUT /:id/proposal stamps on every
// proposal it writes. It is the ONLY evidence that the proposal editor
// authored the price: `category` is not provenance (the estimator engine
// and Agent Estimate also create COMMERCIAL rows, and an older generic
// reuse could keep the category beside a browser-supplied blob — pre-push
// codex P0), and since #3750 the generic create/revise never persists a
// browser proposal at all. A proposal without the marker — legacy rows
// included, until re-saved in the editor — gets NO exemption from the
// pricing-authority gate or its telemetry (the manual-review exemption in
// assertEstimateSendable deliberately keeps the older enabled-only
// predicate so existing proposals stay sendable with the gate off).
const { PROPOSAL_PROVENANCE_SOURCE, isProposalAuthoredByEditor } = require('../services/estimate-proposal');
function isAuthoredProposalRow(estimate = {}) {
  return isProposalAuthoredByEditor(parseEstimateData(estimate.estimate_data || estimate.estimateData)?.proposal);
}

function sendRequiresServerPricingFor(estimate = {}) {
  if (!require('../config/feature-gates').isEnabled('sendRequiresServerPricing')) return false;
  return !isAuthoredProposalRow(estimate);
}
// The ONE authority predicate every send claim re-asserts — gated manual
// sends and every automated send alike: the explicit SERVER stamp, fail
// closed on NULL, unknown or fallback values (pre-push codex P0s — a
// negative CLIENT_FALLBACK check let unstamped legacy rows through).
const {
  SERVER_PRICING_AUTHORITY_SQL,
  GATED_SEND_AUTHORITY_SQL,
  gatedSendAuthorityPredicateApplies,
  rowPassesGatedSendAuthority,
  applyLinkVisibleSiblingScope,
  estimateDeliverableUnderGate,
  groupPassesGatedSendAuthority,
} = require('../services/pricing-authority-gate');
// The gated MANUAL claims (immediate, scheduled, grouped anchor + siblings)
// re-assert the whole verdict IN SQL on the row as it is at claim time —
// engine-verified, OR an authored proposal by provenance (category stamp +
// enabled flag). Evaluating the exemption in JS on the pre-read row let a
// proposal disabled between the pre-read and the claim ride the stale
// exemption straight to the customer (pre-push codex P0).
// GATED_SEND_AUTHORITY_SQL / gatedSendAuthorityPredicateApplies live in
// services/pricing-authority-gate.js — one verdict shared with the follow-up
// lanes and the persistence guards (GH codex P1 r12).

// Gate-off telemetry for the rollout count: one warn per delivery attempt
// that actually reached the funnel WITHOUT the SERVER stamp (CLIENT_FALLBACK,
// unstamped legacy rows, unknown values — everything the gate will refuse),
// emitted AFTER the funnel's own sendability check passed (so a later
// rejection never counts) and only from that one site (the pre-read assert
// used to log too and double-counted; GH codex P2 on #3750). Silent while
// the gate is on — the assert refuses the send instead.
// `handoff`: whether a REAL provider handoff happened for this delivery —
// the funnel's stampChannels distinction (an SMS suppressed by the SMS gate,
// template policy or owner kill reports ok with real:false and reaches no
// customer). Rollout counts must reflect actual customer exposure (GH codex
// P2 on #3750), so a suppressed-only attempt logs nothing.
function shadowLogFallbackDelivery(estimate = {}, { handoff = true } = {}) {
  if (!handoff) return false;
  const authority = String(estimate.pricing_authority || '').toUpperCase();
  if (authority === 'SERVER') return false;
  if (isAuthoredProposalRow(estimate)) return false;
  if (require('../config/feature-gates').isEnabled('sendRequiresServerPricing')) return false;
  logger.warn(`[pricing-authority] shadow: estimate ${estimate.id} is being delivered with pricing authority ${authority || 'NULL'} (GATE_SEND_REQUIRES_SERVER_PRICING off)`);
  return true;
}

// Automation never publishes a price the engine did not verify — gate or no
// gate (AGENTS.md estimator-engine authority; pre-push codex P0s). Only the
// explicit SERVER stamp passes: null, unknown and CLIENT_FALLBACK all fail
// closed. The lead auto-send lane claims its anchor with
// AUTO_SEND_PRICING_AUTHORITY_SQL; this is the same verdict for every
// grouped SIBLING that lane would publish, applied in the group preflight
// when the caller declares options.autoSend.
function assertAutoSendPricingAuthority(row = {}) {
  // An authored proposal (any stored proposal object) is never automation's
  // to publish, whatever stamp the underlying draft still carries.
  const proposalData = parseEstimateData(row.estimate_data || row.estimateData)?.proposal;
  const isProposal = !!(proposalData && typeof proposalData === 'object');
  if (!isProposal && String(row.pricing_authority || '').toUpperCase() === 'SERVER') return;
  const err = new Error('This estimate\'s price has no engine verification stamp (or was saved from the browser preview because the pricing engine could not verify it) — it is never auto-sent. Re-save it from the estimate tool and send it by hand.');
  err.statusCode = 422;
  err.code = 'PRICING_AUTHORITY_NOT_SERVER';
  throw err;
}

// Schedule-time preflight for grouped sends (GH codex P2 on #3750). The
// scheduled cron publishes every active sibling under one claim, and
// claimGroupSiblingsForPublish refuses a sibling whose pricing authority
// fails the gate — by then the operator is gone, the anchor lands in
// send_failed (a gate refusal is never retried) and the customer never gets
// the group link. The same per-sibling verdict is applied HERE, at request
// time, so the schedule is refused while someone can still fix the sibling.
// Sibling enumeration mirrors the claim exactly (active, unlocked,
// unarchived). Returns the first blocking sibling with the code the claim
// would have raised, or null.
// `forUpdate`: lock the sibling rows for the caller's transaction (the
// schedule route), so a concurrent revision of a sibling serializes against
// the scheduling write instead of slipping between this read and it.
async function findGroupSiblingBlockingSend(estimate, { database = db, autoSend = false, forUpdate = false } = {}) {
  if (!estimate?.estimate_group_id) return null;
  // Two sets are judged (never re-claimed): the PUBLISHABLE siblings this
  // send would publish (draft / scheduled / send_failed, unlocked) and every
  // sibling the customer's one link already renders — the shared
  // link-visible scope (sending / sent / viewed while unexpired, accepted /
  // declined always; GH codex P1 r6 + uncapped P1 r19), so a SERVER anchor
  // is never delivered beside an unverified price the link would show.
  let query = database('estimates')
    .where({ estimate_group_id: estimate.estimate_group_id })
    .whereNot({ id: estimate.id })
    .whereNull('archived_at')
    .where((q) => q
      .where((publishable) => publishable.whereIn('status', ['draft', 'scheduled', 'send_failed']).whereNull('price_locked_at'))
      .orWhere((visible) => applyLinkVisibleSiblingScope(visible)));
  if (forUpdate) query = query.forUpdate();
  const siblings = await query.select('id', 'status', 'price_locked_at', 'pricing_authority', 'estimate_data');
  for (const sibling of siblings) {
    // A sibling under a clarify re-price hold blocks the group at REQUEST
    // time — schedule and immediate alike — so the operator hears it now,
    // not from the cron parking the anchor at publication (codex r16 P2 on
    // #3804). The publish-time claim re-asserts it atomically.
    if (siblingRepricePending(sibling)) return { sibling, statusCode: 409, code: 'REPRICE_PENDING' };
    const authority = String(sibling.pricing_authority || '').toUpperCase();
    // Automation: the explicit SERVER stamp only. Manual sends: the ONE
    // shared row verdict — SERVER, a genuinely locked accepted price, or an
    // editor-authored proposal (uncapped codex P1 r21: a re-implemented
    // SERVER-or-proposal check blocked every group holding a legitimately
    // accepted property).
    if (autoSend) {
      if (authority === 'SERVER') continue;
      return { sibling, statusCode: 422, code: 'PRICING_AUTHORITY_NOT_SERVER' };
    }
    if (!gatedSendAuthorityPredicateApplies() || rowPassesGatedSendAuthority(sibling)) continue;
    return {
      sibling,
      statusCode: 409,
      code: authority === 'CLIENT_FALLBACK' ? 'CLIENT_FALLBACK_PRICING' : 'PRICING_AUTHORITY_NOT_SERVER',
    };
  }
  return null;
}

// The operator-facing reason a group cannot go out, from the preflight's
// verdict code — the same words the publish-time claim uses for a hold.
function blockingSiblingMessage(blockingSibling, beforeWhat) {
  const id = blockingSibling.sibling.id;
  if (blockingSibling.code === 'REPRICE_PENDING') {
    return `Grouped estimate ${id} is held for a re-price (a clarify answer replaces its dollars or address) — re-draft or revise it before ${beforeWhat}.`;
  }
  return `Grouped estimate ${id} has no engine-verified price — re-save it from the estimate tool before ${beforeWhat}.`;
}

function assertEstimateSendable(estimate, { engineReviewAcknowledged = false } = {}) {
  if (estimate.archived_at) {
    const err = new Error('Estimate is archived. Unarchive first.');
    err.statusCode = 400;
    throw err;
  }
  // A clarify re-price hold: nothing customer-facing goes out for a held
  // row — send, schedule, group publish AND the follow-up nudge, whose link
  // the public renderer now refuses (codex r6 P2 on #3804). The claim and
  // publication predicates re-assert it atomically.
  if (siblingRepricePending(estimate)) {
    const err = new Error('This estimate is held for a re-price (a customer clarify reply). Revise it with the answered unit before sending.');
    err.statusCode = 409;
    err.code = 'REPRICE_PENDING';
    throw err;
  }
  // One-tap purchase drafts are INTERNAL flow state, never a document to
  // publish (Codex #3395 r12 P2): sending one flips it to 'sent' — a state
  // the open purchase's confirm rejects and neither cleanup sweep reclaims
  // (their predicates are draft/expired) — and starts the normal estimate
  // comms for something the customer buys in-app.
  if (estimate.source === 'one_tap_purchase') {
    const err = new Error('This is an internal one-tap purchase draft — it is bought in the portal, never sent.');
    err.statusCode = 400;
    throw err;
  }
  // A persisted bermuda-suppression estimate is only sendable while the gate
  // is LIVE: the send path serves stored rows without re-entering
  // priceLawnCare, so a save-then-gate-off sequence would otherwise publish
  // a disabled add-on (codex #3272 r2). Same fail-closed rail as pricing.
  if (estimateDataCarriesBermudaSuppression(estimate.estimate_data || estimate.estimateData)
    && !require('../config/feature-gates').gateEnvValue('GATE_BERMUDA_SUPPRESSION')) {
    const err = new Error('This estimate includes the bermudagrass-suppression add-on, which is currently disabled (GATE_BERMUDA_SUPPRESSION). Re-enable the gate or rebuild the estimate without the add-on before sending.');
    err.statusCode = 409;
    err.code = 'BERMUDA_SUPPRESSION_GATED';
    throw err;
  }
  // Estimator-engine YELLOW drafts carry review reasons (fallback sqft
  // sources, comps outliers, constraint flags) the operator must see before
  // the first send — without this gate they read as ordinary priced drafts.
  // Green lanes stay one-click; a draft that already went out (sent_at) was
  // already reviewed, so resends/follow-ups don't re-prompt.
  {
    const engineReview = parseEstimateData(estimate.estimate_data || estimate.estimateData)?.estimatorEngine;
    if (engineReview?.lane === 'yellow' && !estimate.sent_at && !engineReviewAcknowledged) {
      const reasons = (engineReview.laneReasons || []).join('; ');
      const err = new Error(`This AI draft is flagged for review${reasons ? ` (${reasons})` : ''}. Open AI Draft Review on the estimate, then confirm the send.`);
      err.statusCode = 409;
      err.code = 'ENGINE_REVIEW_REQUIRED';
      throw err;
    }
  }
  // Some rows have no share token (quote-wizard mirrors, legacy imports).
  // Without this gate the customer link is built by template literal and the
  // SMS/email ships a literal /estimate/null — a dead link — while the
  // estimate still gets stamped `sent`.
  if (!String(estimate.token || '').trim()) {
    const err = new Error('This estimate has no customer link token, so there is nothing to send. Rebuild it in the estimate tool to mint a shareable link.');
    err.statusCode = 400;
    throw err;
  }
  if (!SENDABLE_ESTIMATE_STATUSES.has(String(estimate.status || 'draft'))) {
    const err = new Error(`Estimate status ${estimate.status || 'unknown'} cannot be sent.`);
    err.statusCode = 400;
    throw err;
  }
  // An authored commercial proposal IS the manual-review output — its line
  // items are the quote — so it is sendable even though it is intentionally
  // surfaced as quote-required to the customer for manual acceptance. Exempt it
  // at the gate rather than only scrubbing stored flags: the send snapshot
  // re-derives quoteRequired:true from proposal.enabled (via buildPricingBundle
  // → attachQuoteRequirement), which would otherwise re-block every resend.
  // The manual-review exemption keeps the pre-#3750 predicate — an enabled
  // proposal, marker or not — so proposals authored before the provenance
  // marker existed stay sendable with the gate off (GH codex P0 r9:
  // in-flight rows must keep working). The provenance requirement is scoped
  // to the pricing-authority gate (isAuthoredProposalRow), where an
  // un-marked legacy proposal fails closed until re-saved in the editor.
  const isAuthoredProposal = parseEstimateData(estimate.estimate_data || estimate.estimateData)?.proposal?.enabled === true;
  if (!isAuthoredProposal && estimateDataHasQuoteRequirement(estimate.estimate_data || estimate.estimateData)) {
    const err = new Error('Quote-required estimates need manual review before they can be sent to the customer.');
    err.statusCode = 400;
    throw err;
  }
  if (!isAuthoredProposal && estimateDataHasBlockingLeadAutomation(estimate.estimate_data || estimate.estimateData)) {
    const err = new Error('Automated lead estimates need manual review before they can be sent to the customer.');
    err.statusCode = 400;
    throw err;
  }
  // Engine-authoritative pricing (validation audit SEC-002, 2026-09-02). A
  // save whose server recompute failed or had no replayable inputs persists
  // the BROWSER preview as a NON-authoritative price (pricing_authority
  // CLIENT_FALLBACK — fail-open so a broken engine never blocks the save),
  // and nothing re-verified that price before delivery. Every send of such
  // a row — first send or resend — is refused while
  // GATE_SEND_REQUIRES_SERVER_PRICING is on and logged as a would-block
  // while it is off (shadow count before the flip). Re-saving from the
  // estimate tool reprices through the engine and clears the stamp. An
  // authored proposal IS the manual quote (exempt like the gates above).
  // Historical delivered rows are the data audit's job; a revision of a
  // delivered row that falls back is refused at save time while the gate
  // is on (reviseAdminEstimate).
  // The gate-off would-block telemetry lives in the delivery funnel
  // (shadowLogFallbackDelivery), not here: this assert runs on the pre-read
  // in the route AND again inside sendEstimateNowInner, and may run before
  // a later gate rejects the request — logging here double-counted exposure
  // (GH codex P2 on #3750). Fail closed: only the explicit SERVER stamp
  // sends while the gate is on — a NULL / unknown stamp is no proof the
  // engine priced the row (pre-push codex P0), and the fallback stamp is
  // proof it did not. Each gets the message that tells the operator why.
  if (sendRequiresServerPricingFor(estimate)) {
    const authority = String(estimate.pricing_authority || '').toUpperCase();
    if (authority !== 'SERVER') {
      const fallback = authority === 'CLIENT_FALLBACK';
      const err = new Error(fallback
        ? 'This estimate\'s price was saved from the browser preview because the pricing engine could not verify it. Open it in the estimate tool and save again so the engine prices it, then send.'
        : 'This estimate\'s price carries no engine verification stamp (it was saved before server-authoritative pricing, or by a path that does not stamp it). Open it in the estimate tool and save again so the engine prices it, then send.');
      err.statusCode = 409;
      err.code = fallback ? 'CLIENT_FALLBACK_PRICING' : 'PRICING_AUTHORITY_NOT_SERVER';
      throw err;
    }
  }
  assertEstimateManagerApprovalResolved(estimate);
  if (commercialRiskTypeReviewNeeded(estimate.estimate_data || estimate.estimateData)) {
    const err = new Error('Set the commercial business type before sending — it sets the pest/rodent service cadence.');
    err.statusCode = 400;
    throw err;
  }
  if (estimateSendableAmount(estimate) <= 0) {
    const err = new Error('Estimate must have a positive monthly or one-time total before it can be sent.');
    err.statusCode = 400;
    throw err;
  }
}

function assertEstimateManagerApprovalResolved(estimate) {
  if (estimateDataHasUnresolvedManagerApproval(estimate.estimate_data || estimate.estimateData)) {
    const err = new Error('Manager approval is required before this estimate can be sent to the customer.');
    err.statusCode = 400;
    throw err;
  }
}

// The property row an estimate prices, as the property_* columns the
// sweep's batch fetch also reads; none when the estimate carries no
// property or the lookup fails (the scope then stands on its address
// column alone — a street-only column fails the locality rule downstream,
// which is the fail-closed side).
async function pricedPropertyAddress(propertyId) {
  if (!propertyId) return {};
  try {
    const p = await db('customer_properties').where({ id: propertyId }).first('address_line1', 'address_line2', 'city', 'zip');
    return p ? { property_address_line1: p.address_line1, property_address_line2: p.address_line2, property_city: p.city, property_zip: p.zip } : {};
  } catch (err) {
    logger.warn(`[admin-estimates] send scope property lookup failed for property ${propertyId}: ${err.message}`);
    return {};
  }
}

// delivered: false = this attempt handed nothing to the customer (a
// suppressed send — SMS gate or template off — leaves lastDeliveredAt where
// it was), so the prior send's scope stamp is carried forward untouched.
// The scope THIS delivery stamps, plus the revision history it extends:
// scopeHistory keeps every delivered scope with its handoff time, oldest
// first, capped like deliveryState.deliveredAt. A resend overwrites
// sendSnapshot.scope, so without the history a complete quote delivered
// after a call and then edited and resent before the nightly sweep would
// leave only the incomplete latest scope for the triage sweep to judge
// (codex #3811 r32 P2). Malformed prior entries are dropped. deliveredAt is
// the GROUP handoff instant (the anchor's lastDeliveredAt) for the anchor
// and every sibling it publishes, so the sweep can pair the scopes one
// handoff delivered together and never combine an anchor's old revision
// with a sibling's newer one (codex r33 P1).
function scopeRevision(priorSendSnapshot, scope, deliveredAt) {
  const prior = Array.isArray(priorSendSnapshot?.scopeHistory)
    ? priorSendSnapshot.scopeHistory.filter((h) => h && typeof h === 'object' && typeof h.deliveredAt === 'string' && h.scope && typeof h.scope === 'object')
    : [];
  return { scope, scopeHistory: [...prior, { deliveredAt, scope }].slice(-DELIVERY_HISTORY_MAX) };
}

async function buildEstimateSendSnapshot(estimate, now = () => new Date(), { delivered = true, deliveredAt = null } = {}) {
  const estimateData = parseEstimateData(estimate.estimate_data) || {};
  const estimateDataForBundle = { ...estimateData };
  delete estimateDataForBundle.sendSnapshot;
  const snapshotAt = now().toISOString();
  const sendSnapshot = {
    ...(estimateData.sendSnapshot || {}),
    renderedAt: snapshotAt,
    tierDiscounts: currentTierDiscounts(),
  };
  // What THIS send delivers — the priced lines and the address — frozen
  // beside the pricing bundle, and moved ONLY by a real handoff: the same
  // send that advances deliveryState.lastDeliveredAt, so the triage
  // sweep's witness and the content it vouches for never drift apart. The
  // sweep binds a quote_promised card to the stamp, never to the row's
  // live content: a proposal re-authored in place keeps its deliveryState,
  // so live lines can grow past what the customer received without a new
  // handoff (codex r25 P1); a suppressed resend would otherwise re-stamp
  // undelivered content under the old witness (pre-push hook P1).
  // Independent of the bundle build below — it is content, not pricing.
  if (delivered) {
    Object.assign(sendSnapshot, scopeRevision(sendSnapshot, deliveredEstimateScope({ ...estimate, estimate_data: estimateDataForBundle, ...(await pricedPropertyAddress(estimate.property_id)) }), deliveredAt || snapshotAt));
  }

  try {
    clearEstimatePricingCache(estimate.id);
    sendSnapshot.pricingBundle = await buildPricingBundle({
      ...estimate,
      estimate_data: estimateDataForBundle,
    });
    // A prior send's persisted error was spread in above — a successful
    // rebuild must clear it or the validated-bundle check downstream
    // rejects a fresh bundle (GH codex P1).
    delete sendSnapshot.pricingBundleError;
    clearEstimatePricingCache(estimate.id);
  } catch (err) {
    logger.warn(`[admin-estimates] send pricing snapshot failed for estimate ${estimate.id}: ${err.message}`);
    // The spread above carries the PRIOR send's bundle forward. Keep it:
    // the public reader fast-paths sendSnapshot.pricingBundle, and
    // dropping it here would flip a still-live customer link from the
    // delivered quote to live pricing (GH codex P1). The AUDIT side never
    // promotes a snapshot carrying pricingBundleError (send path checks).
    sendSnapshot.pricingBundleError = err.message;
  }

  return {
    ...estimateData,
    sendSnapshot,
  };
}

function estimateSmtpContent({ firstName, viewUrl, priceLine, proposalMode }) {
  const heading = proposalMode ? 'Your Waves proposal is ready' : 'Your Waves estimate is ready';
  const intro = proposalMode
    ? `Hi ${firstName}, your formal proposal is attached as a PDF. There is no online checkout for a commercial bid — your Waves account manager will follow up to answer questions and finalize the agreement.`
    : `Hi ${firstName}, your customized service estimate is ready for review. Tap below to view the full breakdown, add-ons, and pick a time that works for you.`;
  const html = wrapEmail({
    preheader: proposalMode
      ? 'Your Waves commercial proposal is attached.'
      : (priceLine && priceLine.startsWith('$') ? `Your Waves estimate is ready — ${priceLine}.` : 'Your Waves estimate is ready to review.'),
    heading,
    intro,
    ctaHref: viewUrl,
    ctaLabel: proposalMode ? 'View Proposal Details' : 'View Your Estimate',
  });
  const text = plainText(proposalMode ? [
    `Hi ${firstName},`,
    '',
    'Your formal commercial proposal is attached as a PDF.',
    'There is no online checkout for a commercial bid — your Waves account manager will follow up to finalize the agreement.',
    '',
    `Proposal details: ${viewUrl}`,
    '',
    `Questions? Reply to this email or call ${WAVES_SUPPORT_PHONE_DISPLAY}.`,
    '- Waves Pest Control',
  ] : [
    `Hi ${firstName},`,
    '',
    'Your customized service estimate is ready for review.',
    '',
    `View your estimate: ${viewUrl}`,
    '',
    `Questions? Reply to this email or call ${WAVES_SUPPORT_PHONE_DISPLAY}.`,
    '- Waves Pest Control',
  ]);
  return { subject: 'Your Waves Pest Control Estimate is Ready', html, text };
}

function estimateEmailPriceLine(estimate) {
  if (!normalizeProposal(estimate).enabled) return moneySummary(estimate);
  // This is the same first-year/recurring/one-time breakdown printed by
  // the proposal PDF. It formats canonical totals; it never prices a quote.
  const pt = computeProposalTotals(normalizeProposal(estimate));
  const centsMoney = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return [
    pt.monthlyEquivalent > 0 && `${centsMoney(pt.monthlyEquivalent)}/mo`,
    pt.annualRecurring > 0 && `${centsMoney(pt.annualRecurring)}/yr recurring`,
    pt.oneTime > 0 && `${centsMoney(pt.oneTime)} one-time`,
    pt.firstYearTotal > 0 && `first-year total ${centsMoney(pt.firstYearTotal)}`,
  ].filter(Boolean).join(' · ');
}

// Uses the same template renderers as delivery, without minting tracked links,
// auditing a template issue, or calling a transport. Only the link is shortened
// at handoff; the manual send pins the base SMS template shown here.
async function buildEstimateSendPreview(estimate) {
  const firstName = estimate.customer_name?.split(' ')[0] || 'there';
  const viewUrl = `https://portal.wavespestcontrol.com/estimate/${estimate.token}`;
  const proposalMode = normalizeProposal(estimate).enabled;
  const priceLine = estimateEmailPriceLine(estimate);
  const sms = await smsTemplatesRouter.getTemplate('estimate_sent', {
    first_name: firstName, estimate_url: viewUrl,
  }, {}, { noVariants: true, audit: false });
  let email = null;
  const library = sendgrid.isConfigured() ? await EmailTemplateLibrary.loadTemplateByKey(proposalMode ? 'estimate.proposal_delivery' : 'estimate.delivery') : null;
  if (library?.activeVersion) {
    const rendered = EmailTemplateLibrary.renderTemplate({
      template: library.template, version: library.activeVersion,
      payload: estimateEmailPayload({ estimate, firstName, viewUrl, priceLine, proposalMode }),
    });
    email = { provider: 'sendgrid', subject: rendered.subject, text: rendered.text, versionId: library.activeVersion.id, contentHash: EmailTemplateLibrary.templateContentHash(library.template, library.activeVersion) };
  } else if (smtpFallbackAllowed()) {
    const rendered = estimateSmtpContent({ firstName, viewUrl, priceLine, proposalMode });
    email = { provider: 'smtp', subject: rendered.subject, text: rendered.text, contentHash: crypto.createHash('sha256').update(JSON.stringify(rendered)).digest('hex') };
  }
  const messages = { sms: sms || null, email };
  const attempts = parseEstimateData(estimate.estimate_data)?.manualSendAttempts;
  const uncertain = (Array.isArray(attempts) ? attempts : []).some((entry) => entry.startedAt && !entry.result);
  return {
    id: estimate.id, status: estimate.status, editVersion: estimateEditVersion(estimate),
    customerName: estimate.customer_name, customerPhone: estimate.customer_phone,
    customerEmail: estimate.customer_email, address: estimate.address,
    updatedAt: estimate.updated_at,
    uncertainAttempt: uncertain,
    groupVersions: estimate.estimate_group_id ? Object.fromEntries((await db('estimates')
      .where({ estimate_group_id: estimate.estimate_group_id }).whereNull('archived_at').orderBy('id').select('*'))
      .map((row) => [row.id, estimateOfferVersion(row)])) : null,
    previewPath: `/estimate/${estimate.token}?adminPreview=1`,
    customerUrl: ['sent', 'viewed'].includes(estimate.status) ? viewUrl : null,
    messages,
    messageVersion: crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex'),
  };
}

async function sendEstimateEmail({ estimate, firstName, viewUrl, priceLine, idempotencyKey, attachments = [], proposalMode = false, versionId = null, expectedContentHash = null, reviewedProvider = null, onDispatch = null }) {
  const provider = sendgrid.isConfigured() ? 'sendgrid' : 'smtp';
  if (reviewedProvider && reviewedProvider !== provider) return { ok: false, error: 'The reviewed email provider changed. Review the message again before sending.' };
  if (reviewedProvider === 'smtp') {
    const content = estimateSmtpContent({ firstName, viewUrl: `https://portal.wavespestcontrol.com/estimate/${estimate.token}`, priceLine, proposalMode });
    if (crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex') !== expectedContentHash) return { ok: false, error: 'The reviewed email content changed. Review the message again before sending.' };
  }
  if (provider === 'sendgrid') {
    try {
      const result = await EmailTemplateLibrary.sendTemplate({
        templateKey: proposalMode ? 'estimate.proposal_delivery' : 'estimate.delivery',
        ...(versionId ? { versionId } : {}),
        ...(expectedContentHash ? { expectedContentHash } : {}),
        to: estimate.customer_email,
        payload: estimateEmailPayload({ estimate, firstName, viewUrl, priceLine, proposalMode }),
        recipientType: estimate.customer_id ? 'customer' : 'lead',
        recipientId: estimate.customer_id || null,
        triggerEventId: `estimate_delivery:${estimate.id}`,
        idempotencyKey: estimateEmailIdempotencyKey(estimate, idempotencyKey),
        categories: ['estimate_delivery'],
        attachments: Array.isArray(attachments) ? attachments : [],
        onQueued: onDispatch,
      });
      if (result.blocked) {
        return { ok: false, blocked: true, error: result.reason || 'Email suppressed', template: proposalMode ? 'estimate.proposal_delivery' : 'estimate.delivery' };
      }
      return { ok: !!result.sent, messageId: result.message?.provider_message_id || null, template: proposalMode ? 'estimate.proposal_delivery' : 'estimate.delivery' };
    } catch (err) {
      if (versionId || !canFallbackFromTemplateEmailError(err)) {
        throw err;
      }
      logger.warn(`[admin-estimates] estimate.delivery template unavailable; falling back to SMTP for estimate ${estimate.id}: ${err.message}`);
    }
  }

  if (!smtpFallbackAllowed()) {
    logger.error(`[admin-estimates] SMTP fallback disabled in production for estimate ${estimate.id} — SendGrid template send required`);
    return {
      ok: false,
      error: 'Email send unavailable: SendGrid template path failed and SMTP fallback is disabled in production',
      template: 'estimate.delivery',
    };
  }

  if (!process.env.GOOGLE_SMTP_PASSWORD) {
    return { ok: false, error: 'Email not configured (SENDGRID_API_KEY or GOOGLE_SMTP_PASSWORD missing)' };
  }

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: 'contact@wavespestcontrol.com',
      pass: process.env.GOOGLE_SMTP_PASSWORD,
    },
  });
  const { html, text } = estimateSmtpContent({ firstName, viewUrl, priceLine, proposalMode });
  // Convert SendGrid-shaped attachments ({ content: base64, type }) to
  // nodemailer's shape ({ content: Buffer, contentType }) for the SMTP path.
  const smtpAttachments = (Array.isArray(attachments) ? attachments : []).map((a) => ({
    filename: a.filename,
    content: Buffer.from(a.content, 'base64'),
    contentType: a.type || 'application/pdf',
  }));
  onDispatch?.();
  await transporter.sendMail({
    from: '"Waves Pest Control, LLC" <contact@wavespestcontrol.com>',
    to: estimate.customer_email,
    subject: 'Your Waves Pest Control Estimate is Ready',
    html,
    text,
    ...(smtpAttachments.length ? { attachments: smtpAttachments } : {}),
  });
  return { ok: true, provider: 'smtp_fallback' };
}

router.use(adminAuthenticate, requireTechOrAdmin);
// 2026-08-25 role lockdown (first-hire prep): estimates are a sales/pricing
// surface — owner-only, with a NARROW staff read allowlist for the flows
// tech-visible surfaces actually use: the single-estimate read (/:id) and
// the schedule-source read the Create Appointment modal fires. The
// collection list, analytics (actuals-variance, win-loss, source
// performance), proposals, pricing audits, and every mutation require the
// admin role.
const STAFF_ESTIMATE_GET_RE = /^\/[A-Za-z0-9-]+(\/schedule-source)?$/;
const OWNER_ONLY_NAMED_GETS = new Set([
  '/actuals-variance', '/win-loss-slices', '/source-performance',
]);
router.use((req, res, next) => (
  req.method === 'GET'
    && STAFF_ESTIMATE_GET_RE.test(req.path)
    && !OWNER_ONLY_NAMED_GETS.has(req.path)
    ? next()
    : requireAdmin(req, res, next)
));

// Post-commit bell for a save whose engine recompute FAILED (validation audit
// SEC-002; pre-push codex P1): the resolver fails open and reports the
// reason, the route rings only after the create/revise transaction committed
// — never from a dryRun preflight — keyed per estimate so a preflight-plus-
// save or a retry never rings twice. Best-effort; never fails the request.
const PRICING_FALLBACK_BELL_DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;
function notifyPricingFallbackAfterCommit(estimate, reason) {
  if (reason !== 'ENGINE_ERROR' || !estimate?.id) return;
  try {
    const NotificationService = require('../services/notification-service');
    void NotificationService.notifyAdmin(
      'estimate',
      `Estimate saved without engine pricing: ${estimate.customer_name || estimate.id}`,
      'The pricing engine failed while this estimate was saved, so the browser preview was stored as a NON-authoritative price (pricing authority: client fallback). Open it in the estimate tool and save again so the engine prices it before it is sent.',
      {
        icon: '\u26A0\uFE0F',
        link: '/admin/estimates',
        // bell: true — an unverified price on a saved estimate must ring even
        // under GATE_ADMIN_BELL_POLICY, whose default denies the 'estimate'
        // category (pre-push codex P1; same override the commercial-schedule
        // bell carries).
        bell: true,
        // Bounded, not forever (GH codex P2 on #3750): a later engine
        // failure on the same estimate — after a successful SERVER re-save
        // — must ring again once the window has passed.
        dedupeKey: `estimate-pricing-fallback:${estimate.id}`,
        dedupeWindowMs: PRICING_FALLBACK_BELL_DEDUPE_WINDOW_MS,
        // customerId lets NotificationService apply its internal-test
        // suppression (GH codex P2 on #3750), like the neighbouring alerts.
        metadata: { estimateId: estimate.id, customerId: estimate.customer_id || null, pricingAuthority: 'CLIENT_FALLBACK', reason },
      },
    ).catch((err) => logger.warn(`[pricing-authority] fallback admin notify failed for estimate ${estimate.id}: ${err.message}`));
  } catch (err) {
    logger.warn(`[pricing-authority] fallback admin notify setup failed for estimate ${estimate.id}: ${err.message}`);
  }
}

// POST /api/admin/estimates — create estimate
router.post('/', async (req, res, next) => {
  try {
    const { estimate, reused, memberLinkageWarning, pricingFallbackReason } = await createOrReuseAdminEstimate({
      body: req.body,
      technicianId: req.technicianId,
      technician: req.technician,
    });
    notifyPricingFallbackAfterCommit(estimate, pricingFallbackReason);
    res.status(reused ? 200 : 201).json({
      id: estimate.id,
      token: estimate.token,
      editVersion: estimateEditVersion(estimate),
      status: estimate.status,
      viewUrl: estimateViewUrl(estimate.token),
      // Server-authoritative pricing (Decision #2): the UI compares these to the
      // client preview it sent and surfaces a "recomputed" notice if they differ.
      monthlyTotal: estimate.monthly_total != null ? Number(estimate.monthly_total) : null,
      annualTotal: estimate.annual_total != null ? Number(estimate.annual_total) : null,
      onetimeTotal: estimate.onetime_total != null ? Number(estimate.onetime_total) : null,
      pricingAuthority: estimate.pricing_authority || null,
      pricingDrift: estimate.pricing_drift || null,
      // Unlinked-member guard (2026-08-10): the typed address matches an
      // active member but no customer was linked, so member pricing was not
      // applied — the builder surfaces this beside the saved totals.
      // ADMIN ONLY (codex #3338 r23, same rule as the edit-source customer
      // block below): the reverse address lookup is unscoped, so returning
      // the matched customer's identity/tier to a technician token would
      // let an arbitrary-address save enumerate customers outside the
      // assignment gate. Technicians save fine; they just get no warning.
      memberLinkageWarning: req.techRole === 'admin' ? (memberLinkageWarning || null) : null,
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// PUT /api/admin/estimates/:id — revise an existing estimate in place. Same
// body + server-authoritative pricing pipeline as create, but the row keeps
// its id/token/status/expiry/linkage so the link the customer already has
// starts showing the updated quote. Blocked once the estimate leaves the
// editable window (accepted/declined/expired/sending/price-locked/archived)
// and for commercial proposals (their editor is PUT /:id/proposal).
router.put('/:id', async (req, res, next) => {
  try {
    // dryRun runs every guard + the full pricing pipeline without writing, so
    // the builder can confirm a server reprice with the operator BEFORE the
    // edit publishes to the customer's live link.
    const dryRun = req.body?.dryRun === true;
    const { estimate, memberLinkageWarning, pricingFallbackReason } = await reviseAdminEstimate({
      estimateId: req.params.id,
      body: req.body,
      technicianId: req.technicianId,
      technician: req.technician,
      dryRun,
    });
    if (!dryRun) {
      logger.info(`[estimates] Revised estimate ${estimate.id} in place (status ${estimate.status})`);
      // An operator revision IS the explicit price correction a pending
      // re-price waits for; reviseAdminEstimate lifts the marker it
      // observed inside its own locked write (a newer attempt stamped after
      // its pre-read keeps its guard — codex r2/r3 P1 on #3796).
      notifyPricingFallbackAfterCommit(estimate, pricingFallbackReason);
    }
    res.json({
      dryRun: dryRun || undefined,
      id: estimate.id,
      editVersion: estimateEditVersion(estimate),
      token: estimate.token,
      viewUrl: estimateViewUrl(estimate.token),
      status: estimate.status,
      monthlyTotal: estimate.monthly_total != null ? Number(estimate.monthly_total) : null,
      annualTotal: estimate.annual_total != null ? Number(estimate.annual_total) : null,
      onetimeTotal: estimate.onetime_total != null ? Number(estimate.onetime_total) : null,
      pricingAuthority: estimate.pricing_authority || null,
      pricingDrift: estimate.pricing_drift || null,
      // Unlinked-member guard (2026-08-10) — same contract and ADMIN-ONLY
      // scope as POST / (codex #3338 r23).
      memberLinkageWarning: req.techRole === 'admin' ? (memberLinkageWarning || null) : null,
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// GET /api/admin/estimates/customer-spend/:customerId — what a linked customer
// already buys and what they pay PER APPLICATION today, so the builder can show
// it beside the quote being written. Read-only projection of the same shared
// loader the Agent Estimate lane and the membership snapshot use, so all three
// surfaces quote the same figure.
//
// ADMIN ONLY: this router is requireTechOrAdmin and the payload is per-service
// pricing — technicians get 403 rather than a price list (same reasoning as the
// edit-source customer block below). Fail-soft on a loader error: the builder
// treats an errored response as "no context" and simply renders no panel, which
// was the behavior before this endpoint existed.
router.get('/customer-spend/:customerId', async (req, res, next) => {
  try {
    if (req.techRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { loadCurrentServiceSpendContext } = require('../services/estimate-membership-context');
    const spend = await loadCurrentServiceSpendContext(db, req.params.customerId);
    res.json({
      currentServices: spend.currentServices,
      currentSpendPerVisitTotal: spend.currentSpendPerVisitTotal,
      currentTierLabel: spend.currentTierLabel,
      currentDiscountPct: spend.currentDiscountPct,
      existingServiceKeys: spend.existingServiceKeys,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/estimates/:id/edit-source — everything the estimate builder
// needs to reopen an existing estimate for in-place editing: the saved builder
// inputs + engine profile (when the estimate was authored in the builder), the
// live contact columns, and the same editability verdict the revise write
// enforces. `inputs` is null for rows created outside the builder (lead
// auto-send / agent drafts) — the client falls back to contact-only seeding.
router.get('/:id/edit-source', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    const estData = parseEstimateData(estimate.estimate_data) || {};
    const block = estimateReviseBlock(estimate, estData);
    const inputs = estData.inputs && typeof estData.inputs === 'object' && !Array.isArray(estData.inputs)
      ? estData.inputs
      : null;
    const engineProfile = estData.engineRequest?.profile && typeof estData.engineRequest.profile === 'object'
      ? estData.engineRequest.profile
      : null;
    // The builder's Customer Lookup panel has exactly one linked-customer
    // visual (the existingCustomerMatch chip), and it renders from a live
    // customer object — without this block every opened estimate shows the
    // empty search state even when customer_id is set. Shape mirrors the
    // fields the chip and its setters read from the customer search results.
    // Best-effort: a lookup failure must not block opening the estimate.
    // ADMIN ONLY: this router is requireTechOrAdmin and the estimate lookup
    // is unscoped, so returning the payload to a technician token would leak
    // contact fields and office-only monthlyRate outside the customer APIs'
    // assignment gate (codex P1). Technicians get customer:null — the chip
    // simply doesn't render, which was the pre-PR behavior for everyone.
    let customer = null;
    if (estimate.customer_id && req.techRole === 'admin') {
      const c = await db('customers').where({ id: estimate.customer_id }).first().catch(() => null);
      if (c) {
        // hasActivePlan is the canonical membership verdict (admin-customers
        // hasMembership): sentinel tiers (One-Time/Commercial/…) are NOT
        // members even with a rate, and a rate-only member (null tier,
        // monthly_rate > 0) IS one — raw tier truthiness gets both wrong, so
        // the chip renders plan status from this boolean (codex P2 + P1 r4).
        // tier/monthlyRate stay raw for display.
        const { hasMembership } = require('./admin-customers');
        customer = {
          id: c.id,
          firstName: c.first_name || '',
          lastName: c.last_name || '',
          phone: c.phone || null,
          email: c.email || null,
          tier: c.waveguard_tier,
          monthlyRate: parseFloat(c.monthly_rate || 0),
          hasActivePlan: hasMembership(c),
        };
      }
    }
    res.json({
      id: estimate.id,
      status: estimate.status,
      editable: !block,
      editVersion: estimateEditVersion(estimate),
      blockReason: block ? block.message : null,
      customerId: estimate.customer_id,
      customerName: estimate.customer_name,
      customerPhone: estimate.customer_phone,
      customerEmail: estimate.customer_email,
      address: estimate.address,
      notes: estimate.notes,
      serviceInterest: estimate.service_interest,
      showOneTimeOption: !!estimate.show_one_time_option,
      billByInvoice: !!estimate.bill_by_invoice,
      satelliteUrl: estimate.satellite_url,
      propertyId: estimate.property_id || null,
      estimateGroupId: estimate.estimate_group_id || null,
      inputs,
      result: inputs ? estData.result || null : null,
      engineRequest: inputs ? estData.engineRequest || null : null,
      token: estimate.token,
      engineProfile,
      customer,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/estimates/:id/group — the multi-property group this estimate
// belongs to: every sibling (including the requested one) with the summary the
// builder's group strip renders. Ungrouped estimates return just themselves so
// the client needs no special case.
router.get('/:id/group', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    const siblings = estimate.estimate_group_id
      ? await db('estimates')
        .where({ estimate_group_id: estimate.estimate_group_id })
        .whereNull('archived_at')
        .orderBy('created_at', 'asc')
      : [estimate];
    res.json({
      estimateGroupId: estimate.estimate_group_id || null,
      estimates: siblings.map((e) => ({
        id: e.id,
        status: e.status,
        address: e.address,
        propertyId: e.property_id || null,
        customerId: e.customer_id || null,
        customerName: e.customer_name,
        monthlyTotal: e.monthly_total != null ? Number(e.monthly_total) : null,
        annualTotal: e.annual_total != null ? Number(e.annual_total) : null,
        onetimeTotal: e.onetime_total != null ? Number(e.onetime_total) : null,
        waveguardTier: e.waveguard_tier || null,
        isCurrent: e.id === estimate.id,
      })),
    });
  } catch (err) { next(err); }
});

// POST /api/admin/estimates/:id/send — send via SMS and/or email (immediate or scheduled)
router.get('/:id/send-preview', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    const preview = await buildEstimateSendPreview(estimate);
    try {
      assertEstimateSendable(estimate);
    } catch (err) {
      preview.blockReason = err.message;
      preview.requiresEngineReview = err.code === 'ENGINE_REVIEW_REQUIRED';
    }
    res.set('Cache-Control', 'private, no-store').json(preview);
  } catch (err) { next(err); }
});

router.post('/:id/send', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

    const sendMethod = req.body?.sendMethod || 'both';
    const scheduledAt = req.body?.scheduledAt || null;
    const idempotencyKey = req.body?.idempotencyKey || req.body?.idempotency_key || req.body?.sendAttemptId || null;
    const engineReviewAcknowledged = req.body?.acknowledgeEngineReview === true;

    if (!['sms', 'email', 'both'].includes(sendMethod)) {
      return res.status(400).json({ error: 'Invalid sendMethod' });
    }
    if (idempotencyKey && !/^[A-Za-z0-9_.:-]{1,120}$/.test(idempotencyKey)) {
      return res.status(400).json({ error: 'Invalid send attempt identifier' });
    }
    const attemptBinding = JSON.stringify([sendMethod, scheduledAt, req.body?.expectedEditVersion || null, req.body?.messageVersion || null, req.body?.groupVersions || null]);
    const attempts = parseEstimateData(estimate.estimate_data)?.manualSendAttempts;
    const previousAttempt = (Array.isArray(attempts) ? attempts : []).find((entry) => entry.key === idempotencyKey);
    if (previousAttempt) {
      if (previousAttempt.binding !== attemptBinding) return res.status(409).json({ error: 'This send attempt belongs to a different reviewed request.' });
      const receipt = previousAttempt.result || (!previousAttempt.startedAt && previousAttempt.scheduleResult);
      if (receipt) return res.status(receipt.sent || receipt.scheduled ? 200 : 422).json({ ...receipt, replayed: true });
      return res.status(409).json({ error: 'The earlier send may have reached a provider. Check its channel outcome before starting a new send.', code: 'SEND_OUTCOME_UNCERTAIN', channels: previousAttempt.channels || {} });
    }
    if ((Array.isArray(attempts) ? attempts : []).some((entry) => entry.startedAt && !entry.result) && req.body?.acknowledgeUncertainSend !== true) {
      return res.status(409).json({ error: 'An earlier send has an uncertain outcome. Check delivery records before authorizing a deliberate resend.', code: 'SEND_OUTCOME_UNCERTAIN' });
    }
    if (req.body?.expectedEditVersion && req.body.expectedEditVersion !== estimateEditVersion(estimate)) {
      return res.status(409).json({ error: 'This saved estimate changed. Close this dialog and review the current version before sending.', code: 'ESTIMATE_REVIEW_STALE' });
    }
    let reviewedMessages = null;
    if (req.body?.messageVersion) {
      const preview = await buildEstimateSendPreview(estimate);
      if (preview.messageVersion !== req.body.messageVersion) return res.status(409).json({ error: 'The delivery message changed. Close this dialog and review it again.', code: 'ESTIMATE_REVIEW_STALE' });
      reviewedMessages = preview.messages;
    }
    assertEstimateSendable(estimate, { engineReviewAcknowledged });

    if (scheduledAt) {
      const scheduledTime = new Date(scheduledAt);
      if (isNaN(scheduledTime.getTime())) {
        return res.status(400).json({ error: 'Invalid scheduledAt' });
      }
      if (scheduledTime <= new Date()) {
        return res.status(400).json({ error: 'scheduledAt must be in the future' });
      }
      // Grouped schedule: every active sibling must clear the pricing-
      // authority gate NOW, not when the cron's group claim refuses it
      // hours later with nobody watching (GH codex P2 on #3750) — and the
      // check is ATOMIC with the schedule write (GH codex P2 r5): the
      // sibling rows are locked FOR UPDATE under the group's advisory lock
      // inside the same transaction as the anchor's scheduling UPDATE, so a
      // concurrent revision that would stamp a sibling CLIENT_FALLBACK
      // either committed first (this schedule refuses it) or waits for this
      // commit (and is then refused by the scheduled-group guard in
      // admin-estimate-persistence assertNoFallbackRevisionInScheduledGroup).
      // The claim itself mirrors the immediate-send path below: the
      // assertEstimateSendable check above ran on a stale read, and writing
      // status='scheduled' unconditionally could clobber an in-flight
      // 'sending' row (its guarded sent-write then misses and the cron
      // re-sends — duplicate customer texts) or overwrite a concurrent
      // accept (money-bearing state lost, and the row re-enters the send
      // pipeline on a committed conversion).
      const scheduleResult = { success: true, scheduled: true, scheduledAt: scheduledTime.toISOString() };
      // A deliberate resend acknowledges only the uncertain attempts staff
      // reviewed now, not a later handoff that may fail before the cron runs.
      const acknowledgedUncertainAttemptKeys = req.body?.acknowledgeUncertainSend === true
        ? (Array.isArray(attempts) ? attempts : []).filter((entry) => entry.startedAt && !entry.result).map((entry) => entry.key)
        : [];
      const scheduledAttemptKey = idempotencyKey || (acknowledgedUncertainAttemptKeys.length ? crypto.randomUUID() : null);
      const scheduleOutcome = await db.transaction(async (trx) => {
        if (estimate.estimate_group_id) {
          await trx.raw(
            'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
            ['estimate-group-send', String(estimate.estimate_group_id)],
          );
        }
        const blockingSibling = await findGroupSiblingBlockingSend(estimate, { database: trx, forUpdate: true });
        if (blockingSibling) return { blockingSibling };
        await assertReviewedEstimateGroup(trx, estimate, req.body?.groupVersions);
        const lockedRow = await trx('estimates').where({ id: estimate.id }).forUpdate().first();
        if (req.body?.expectedEditVersion && estimateEditVersion(lockedRow) !== req.body.expectedEditVersion) {
          return { stale: true };
        }
        const lockedData = parseEstimateData(lockedRow?.estimate_data) || {};
        const priorAttempts = Array.isArray(lockedData.manualSendAttempts) ? lockedData.manualSendAttempts : [];
        const receipt = scheduledAttemptKey ? {
          key: scheduledAttemptKey, binding: attemptBinding, scheduleResult, channels: {},
          scheduleReview: { scheduledAt: scheduledTime.toISOString(), reviewedMessages, reviewedOffer: req.body?.expectedEditVersion ? estimateOfferVersion(lockedRow) : null, reviewedGroupVersions: req.body?.groupVersions || null, acknowledgedUncertainAttemptKeys },
        } : null;
        const claimed = await trx('estimates')
          .where({ id: estimate.id })
          // Same observed-membership pin as the immediate claim (GH codex
          // P1 r8): the sibling preflight above judged THIS group's rows —
          // a move to another group since the read must lose the race.
          .where({ estimate_group_id: estimate.estimate_group_id || null })
          .whereNull('price_locked_at')
          // Archived rows can never re-enter the send pipeline (codex P0,
          // PR #3304): a stale scheduling request racing an invalidation
          // must not restore status='scheduled' on the archived draft.
          .whereNull('archived_at')
          .whereNotIn('status', ['sending', 'accepted', 'declined', 'expired'])
          // A clarify hold stamped between assertEstimateSendable's pre-read
          // and this claim loses the race here (codex r13 P2 on #3804): the
          // immediate path re-asserts the hold inside sendEstimateNow, but a
          // scheduled row would otherwise report "scheduled" and the cron
          // would only refuse it later, with nothing unscheduling it if the
          // reply's own unschedule ran while the row was still a draft.
          .whereRaw(REPRICE_PENDING_ABSENT_SQL)
          // Same pricing-authority re-assertion as the immediate-send claim
          // (pre-push codex P1): a revision stamping CLIENT_FALLBACK between
          // the pre-read check and this UPDATE must lose the race with a 409
          // here, not report "scheduled" and have the cron burn retries.
          .modify((q) => {
            if (gatedSendAuthorityPredicateApplies()) q.whereRaw(GATED_SEND_AUTHORITY_SQL);
          })
          .update({
            status: 'scheduled',
            scheduled_at: scheduledTime,
            send_method: sendMethod,
            expires_at: estimateExpiresAt(() => scheduledTime),
            scheduled_send_attempts: 0,
            last_send_error: null,
            ...(receipt ? { estimate_data: JSON.stringify({ ...lockedData, manualSendAttempts: [...priorAttempts, receipt].slice(-DELIVERY_HISTORY_MAX) }) } : {}),
            updated_at: trx.fn.now(),
          });
        return { claimed };
      });
      if (scheduleOutcome.stale) return res.status(409).json({ error: 'The saved estimate changed before scheduling. Review the current offer.', code: 'ESTIMATE_REVIEW_STALE' });
      if (scheduleOutcome.blockingSibling) {
        const { blockingSibling } = scheduleOutcome;
        return res.status(blockingSibling.statusCode).json({
          error: blockingSiblingMessage(blockingSibling, 'scheduling this group (the scheduled send publishes every property together)'),
          code: blockingSibling.code,
          siblingEstimateId: blockingSibling.sibling.id,
        });
      }
      const scheduledClaim = scheduleOutcome.claimed;
      if (!scheduledClaim) {
        return res.status(409).json({
          error: 'This estimate is mid-send, already accepted, locked, or held for a re-price — refresh and retry.',
        });
      }
      return res.json(scheduleResult);
    }

    // Send immediately. Claim the row as `sending` first so a concurrent
    // proposal save (PUT /:id/proposal rejects `sending`) can't slip new
    // totals/PDF between this send's render and its sent-write — the
    // immediate-send save/send race the prior fresh-read could not fully close.
    // The scheduled-send cron and lead-auto-send already pre-claim before
    // calling sendEstimateNow, so the claim happens here only for immediate
    // sends. A crashed immediate send is recovered by the stale-claim sweep.
    // Grouped estimates claim their anchor INSIDE the group advisory lock
    // (codex #3248 r4): pre-claiming here let two concurrent sends of
    // different members each mark their own row 'sending' before either
    // took the lock — both then saw the other mid-send and both aborted,
    // delivering nothing. Ungrouped sends keep the standalone claim.
    if (!estimate.estimate_group_id) {
      const claimed = await db('estimates')
        .where({ id: estimate.id })
        // Claim ONLY the membership this send observed (GH codex P1 r8): a
        // SERVER revision grouping this row between the read above and this
        // claim would otherwise hand sendEstimateNow a stale ungrouped
        // object that skips the group claim while the public link renders
        // every viewable sibling — a fallback sibling included. Zero rows →
        // 409, the refreshed retry runs the grouped path.
        .whereNull('estimate_group_id')
        .whereNull('price_locked_at')
        // An ARCHIVED row is never claimable for send (codex P0, PR
        // #3304): linkage invalidation archives stale wrong-lead drafts
        // atomically, and a send that read the row earlier must not
        // deliver the old recipient's content after that commit.
        .whereNull('archived_at')
        .whereNotIn('status', ['sending', 'accepted', 'declined', 'expired'])
        // Re-assert the pricing-authority gate ON the claim (pre-push codex
        // P0): assertEstimateSendable checked the pre-read row, and a revision
        // committing CLIENT_FALLBACK between that check and this claim must
        // lose the race — a zero-row claim 409s, and the refreshed retry
        // meets the gate's own message.
        .modify((q) => {
          if (gatedSendAuthorityPredicateApplies()) q.whereRaw(GATED_SEND_AUTHORITY_SQL);
          if (req.body?.expectedEditVersion) {
            // CAS the snapshot observed before this claim. The later delivery
            // verdict also compares content; this pin stops two reviewed
            // clicks that both pre-read the same sent/draft row from winning
            // sequentially after the first handoff completes.
            q.where('status', estimate.status)
              .whereRaw("COALESCE(estimate_data, '{}'::jsonb) = ?::jsonb", [JSON.stringify(parseEstimateData(estimate.estimate_data) || {})]);
          }
          if (idempotencyKey) q.whereRaw("NOT (COALESCE(estimate_data->'manualSendAttempts', '[]'::jsonb) @> ?::jsonb)", [JSON.stringify([{ key: idempotencyKey }])]);
        })
        .update({ status: 'sending', updated_at: db.fn.now() });
      if (!claimed) {
        return res.status(409).json({
          error: 'This estimate is being sent or is locked right now. Wait a moment and retry.',
        });
      }
    }
    // Grouped sends claim inside the group lock; claimState.anchorClaimed
    // records whether THIS request won it, so a losing request never resets
    // a concurrent winner's in-flight claim (codex #3248 r5).
    const claimState = { anchorClaimed: !estimate.estimate_group_id };
    const releaseSendClaim = (failed = false) => (claimState.anchorClaimed
      ? db('estimates')
        .where({ id: estimate.id, status: 'sending' })
        .update({ status: failed && idempotencyKey && estimate.status === 'scheduled' ? 'send_failed' : estimate.status,
          ...(failed && idempotencyKey && estimate.status === 'scheduled' ? { scheduled_at: null } : {}), updated_at: db.fn.now() })
        .catch((e) => logger.warn(`[admin-estimates] failed to release send claim for estimate ${estimate.id}: ${e.message}`))
      : Promise.resolve());

    let result;
    try {
      result = await sendEstimateNow(
        estimate.estimate_group_id ? estimate : { ...estimate, status: 'sending' },
        sendMethod,
        {
          idempotencyKey, engineReviewAcknowledged, claimState,
          manualAttempt: idempotencyKey ? { key: idempotencyKey, binding: attemptBinding } : null,
          reviewedMessages,
          reviewedOffer: req.body?.expectedEditVersion ? estimateOfferVersion(estimate) : null,
          reviewedEditVersion: req.body?.expectedEditVersion || null,
          reviewedGroupVersions: req.body?.groupVersions || null,
        },
      );
    } catch (e) {
      await releaseSendClaim(true);
      throw e;
    }
    if (!result.sent) {
      // Known failures restore the editable prior state. An uncertain
      // immediate attempt cancels an old schedule until staff review it.
      await releaseSendClaim(result.uncertain === true);
      return res.status(422).json({
        success: false,
        error: 'Estimate was not sent on any requested channel',
        channels: result.channels,
      });
    }
    res.json({ success: true, ...result });
  } catch (err) {
    // err.code rides along so the client can distinguish the engine-review
    // gate (ENGINE_REVIEW_REQUIRED → confirm-and-retry) from other 4xx.
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    next(err);
  }
});

// Send-time "lead with one service" (GATE_ESTIMATE_LEAD_SERVICE_SEND).
// Scope, all deliberate: NEW residential customers only (no membership
// evidence — a member's combined tier is theirs to keep), ungrouped, not a
// proposal, EXACTLY two recurring lines with the non-lead one REMOVABLE per
// the opt-out resolver (one atomic park — never a partial multi-step mix).
// Lead = the estimator's first selected recurring service (engineRequest
// order, else section order). Every other removable line goes through the
// shared applyServiceMixChange rail as actor 'staff' — dry run, then commit
// bound to that preview — so the parked lines re-enter the plan through the
// customer's own "Add it" tap on the page. Returns the fresh row (or the
// input row untouched when nothing applied).
// `leadShapeRef` (from sendEstimateNow) receives the parked key the moment
// the commit lands — before any post-commit step can fail — so compensation
// never depends on this function returning normally.
async function applyLeadServiceForSend(estimate, { leadShapeRef = null, preserveReviewedOffer = false } = {}) {
  const untouched = { estimate, parkedKey: null };
  let parkedKey = null;
  const featureGates = require('../config/feature-gates');
  try {
    if (!estimate) return untouched;
    // Pending / structural restoration runs BEFORE any gate exit: a kill
    // switch flipped after an undelivered park must never let the next send
    // go out on the reduced totals (pre-push codex P0). Only NEW parking is
    // gated, below.
    const pendingRow = await db('estimates').where({ id: estimate.id }).first();
    if (!pendingRow) return untouched;
    let pendingData = {};
    try { pendingData = typeof pendingRow.estimate_data === 'string' ? JSON.parse(pendingRow.estimate_data) : (pendingRow.estimate_data || {}); }
    catch { pendingData = {}; }
    const OptOut = require('../services/estimate-service-opt-out');
    {
      const parkedEvent = OptOut.staffOfferedEvents(pendingData || {})[0] || null;
      const witnessedParkId = pendingData?.leadServiceHandoffParkId || null;
      const unwitnessed = parkedEvent
        && !(parkedEvent.parkId ? witnessedParkId === parkedEvent.parkId : Boolean(pendingData?.leadServiceHandoffAt));
      // AMBIGUOUS: a provider handoff was ATTEMPTED for this very park (the
      // pre-handoff intent stamp) but no witness landed — the customer may
      // already hold the reduced quote, so it is neither restored nor
      // resent; the send aborts and the office reviews (pre-push codex P1).
      const attempt = pendingData?.leadServiceHandoffAttempt || null;
      // A bound revert marker is CONFIRMED no-handoff (the wrapper writes it
      // only after every channel failed and compensation failed): it wins
      // over the attempt stamp, so a transient restore failure retries
      // instead of stranding the estimate in review (GH codex r9 P1).
      const boundMarker = pendingData?.leadServiceRevertPending || null;
      const markerBound = boundMarker && parkedEvent && boundMarker.serviceKey === parkedEvent.serviceKey
        && (!boundMarker.parkId || boundMarker.parkId === parkedEvent.parkId);
      if (!markerBound && unwitnessed && attempt && parkedEvent.parkId && attempt.parkId === parkedEvent.parkId) {
        await pageOfficeAmbiguousPark(estimate, parkedEvent.serviceKey).catch(() => {});
        const abort = new Error('This estimate needs a review: an earlier send may have delivered a single-service quote whose delivery could not be confirmed. Nothing was sent.');
        abort.statusCode = 409;
        abort.leadServiceAbort = true;
        throw abort;
      }
      const structuralPending = unwitnessed ? parkedEvent.serviceKey : null;
      // The marker is bound to its park: a customer who restored the offer
      // from the delivered link and then deliberately removed the same
      // service has superseded the park, and the retry must not restore
      // over that choice (GH codex r7 P2). A superseded marker is cleared.
      const marker = pendingData?.leadServiceRevertPending || null;
      let markerKey = marker?.serviceKey ? String(marker.serviceKey) : null;
      if (markerKey && marker.parkId
        && !(parkedEvent && parkedEvent.serviceKey === markerKey && parkedEvent.parkId === marker.parkId)) {
        await clearLeadServiceRevertPending(estimate.id);
        markerKey = null;
      }
      const pendingKey = markerKey || structuralPending;
      if (pendingKey) {
        const restored = await revertLeadServiceForSend(estimate.id, pendingKey, marker?.parkId || parkedEvent?.parkId || null);
        if (!restored) {
          const abort = new Error('This estimate is waiting on a review: an earlier undelivered send left an add-on offer unrestored. Nothing was sent.');
          abort.statusCode = 409;
          abort.leadServiceAbort = true;
          throw abort;
        }
        try {
          await clearLeadServiceRevertPending(estimate.id);
        } catch (err) {
          const abort = new Error(`Could not clear the add-on review marker (${err.message}). Nothing was sent.`);
          abort.statusCode = 503;
          abort.leadServiceAbort = true;
          throw abort;
        }
        const restoredRow = await db('estimates').where({ id: estimate.id }).first();
        if (!restoredRow) {
          const abort = new Error('Estimate disappeared while restoring an add-on offer. Nothing was sent.');
          abort.statusCode = 409;
          abort.leadServiceAbort = true;
          throw abort;
        }
        return { estimate: { ...restoredRow, status: estimate.status }, parkedKey: null };
      }
    }
    // An explicit staff review commits to the saved bundle. Automated sends
    // retain the existing lead-first rail; manual review never silently parks
    // a service after the operator has approved that bundle and its price.
    if (preserveReviewedOffer) return untouched;
    // NEW parking is gated (strict opt-in, needs opt-out + add).
    if (!featureGates.isEnabled('estimateLeadServiceSend')) return untouched;
    if (!featureGates.isEnabled('estimateServiceOptOut') || !featureGates.isEnabled('estimateServiceAdd')) return untouched;
    if (estimate.estimate_group_id || estimate.price_locked_at) return untouched;
    // Frozen restart quotes (plan_restart) carry the cancellation-time
    // families verbatim and accept validates that array — never reshape
    // them (GH codex r5 P1).
    if (String(estimate.source || '') === 'plan_restart') return untouched;
    // The category COLUMN is the scope — never default a missing one to
    // residential (same fail-closed rule as the add resolver).
    if (String(estimate.category || '').toUpperCase() !== 'RESIDENTIAL') return untouched;
    // The caller's object predates its own send claim (the route stamps
    // status='sending' + updated_at before calling in), and the rail's CAS
    // compares updated_at to the millisecond — a stale version would 409
    // every commit and silently send the full bundle (pre-push codex P1).
    // Work from the row as it is NOW; keep only the caller's in-flight status.
    const claimedRow = await db('estimates').where({ id: estimate.id }).first();
    if (!claimedRow || claimedRow.archived_at || claimedRow.price_locked_at) return untouched;
    // Scope re-applied to the row as it is NOW: a grouping or category change
    // between the route's read and the claim must not park one member of a
    // multi-property group (pre-push codex P1).
    if (claimedRow.estimate_group_id) return untouched;
    if (String(claimedRow.category || '').toUpperCase() !== 'RESIDENTIAL') return untouched;
    let current = { ...claimedRow, status: estimate.status };
    let estData = {};
    try { estData = typeof current.estimate_data === 'string' ? JSON.parse(current.estimate_data) : (current.estimate_data || {}); }
    catch { return untouched; }
    // Frozen restart quote, re-checked on the claimed row (source column or
    // the planRestart blob flag the public page keys on).
    if (String(claimedRow.source || '') === 'plan_restart' || estData?.planRestart === true) return untouched;
    // A pending revert from an earlier undelivered send is retried BEFORE
    // anything else; if it still fails the send aborts (the office was
    // paged when the marker was written). Success clears the marker and the
    // restored full bundle goes out (pre-push codex P1).
    if (estData?.serviceOptOut) return untouched; // already shaped once — never re-park on a resend
    // Member exclusion (security-critical, AGENTS.md): the ONE shared
    // evidence reader (snapshot flag, priors in any carrier, recurring flag
    // in any replay shape) PLUS a live active-plan check that fails CLOSED
    // (a lookup error keeps the full bundle). A member's combined tier is
    // theirs to keep.
    if (OptOut.memberEvidenceInEstimateData(estData)) return untouched;
    if (current.customer_id) {
      const { isActivePlanCustomer } = require('../services/waveguard-existing-services');
      let activeMember = true;
      // strict: a failed read THROWS (read as "member", i.e. never parked)
      // instead of the helper's default "no plan" (GH codex r9 P1).
      try { activeMember = await isActivePlanCustomer(db, current.customer_id, { strict: true }); } catch (_) { activeMember = true; }
      if (activeMember) return untouched;
    }
    const estimatePublic = require('./estimate-public');
    const bundle = await estimatePublic.buildPricingBundle(current).catch(() => null);
    const sections = Array.isArray(bundle?.services) ? bundle.services : [];
    const removable = OptOut.serviceOptOutRemovableKeys(estData, sections, current.waveguard_tier);
    if (removable.size < 1) return untouched;
    const recurringKeys = sections.filter((s) => s && s.isRecurring === true).map((s) => String(s.key || ''));
    // EXACTLY two recurring lines: one lead, one parked. A three-line
    // estimate would need a multi-step park that can refuse midway and send
    // a partial mix — neither the full bundle nor the single-service quote
    // (pre-push codex P0). Those go out as the full bundle, as today.
    if (recurringKeys.length !== 2) return untouched;
    // Lead: first selected recurring token in the estimator's own order —
    // the ONLY lead provenance. v1 estimator shapes (engineInputs, no
    // engineRequest) carry no selection order, and the renderer's section
    // order is not a substitute: the legacy mapper lists Lawn before Pest,
    // so falling back to it sent a pest-led Pest + Lawn quote as Lawn-only
    // (GH codex r9 P1). No provable lead = the full bundle goes out.
    const tokenToKey = Object.fromEntries(Object.entries(OptOut.SERVICE_OPT_OUT_KEYS)
      .flatMap(([key, spec]) => spec.selected.map((t) => [t, key])));
    const selectedOrder = (Array.isArray(estData.engineRequest?.selectedServices) ? estData.engineRequest.selectedServices : [])
      .map((t) => tokenToKey[String(t).toUpperCase()]).filter(Boolean);
    const leadKey = selectedOrder.find((k) => recurringKeys.includes(k));
    if (!leadKey) return untouched;
    const toPark = recurringKeys.filter((k) => k !== leadKey && removable.has(k));
    if (toPark.length !== 1) return untouched;

    for (const serviceKey of toPark) {
      // The rail's own resolver re-runs on every step (removability shrinks
      // as lines leave — the last recurring line is never removable).
      const preview = await estimatePublic.applyServiceMixChange({
        estimate: cloneEstimateRow(current), body: { serviceKey, included: false, dryRun: true }, actor: 'staff',
      });
      if (preview.status !== 200 || !preview.body?.previewBasis) {
        logger.info(`[admin-estimates] lead-service send: ${serviceKey} not parked on estimate ${estimate.id} (${preview.body?.error || preview.status})`);
        continue;
      }
      const commit = await estimatePublic.applyServiceMixChange({
        estimate: cloneEstimateRow(current), body: { serviceKey, included: false, previewBasis: preview.body.previewBasis }, actor: 'staff',
      });
      if (commit.status !== 200) {
        logger.warn(`[admin-estimates] lead-service send: commit for ${serviceKey} refused on estimate ${estimate.id} (${commit.body?.error || commit.status})`);
        continue;
      }
      parkedKey = serviceKey;
      if (leadShapeRef) {
        leadShapeRef.parkedKey = serviceKey;
        leadShapeRef.parkId = commit.body?.parkId || null;
      }
      // The park is COMMITTED. From here every failure must surface — a
      // swallowed reread would deliver full-bundle in-memory content over a
      // parked row and lose the key compensation needs (pre-push codex P1).
      const fresh = await db('estimates').where({ id: estimate.id }).first();
      if (!fresh) throw new Error('post-park reread found no row');
      // Keep the caller's in-flight status (the route-level 'sending' claim)
      // while taking every parked total from the row.
      current = { ...fresh, status: estimate.status };
    }
    return parkedKey ? { estimate: current, parkedKey } : untouched;
  } catch (err) {
    if (err && err.leadServiceAbort) throw err;
    if (parkedKey) {
      // Post-commit failure: abort the send (the wrapper compensates through
      // leadShapeRef, the route releases its claim on the throw).
      const abort = new Error(`lead-service send: ${err.message}`);
      abort.statusCode = 503;
      abort.leadServiceParkedKey = parkedKey;
      throw abort;
    }
    logger.warn(`[admin-estimates] lead-service send skipped for estimate ${estimate?.id}: ${err.message}`);
    return untouched;
  }
}

// The rail parses estimate_data and PRUNES the parsed carriers in place; when
// Postgres hands the JSONB column back as an object, that object IS the row's
// carrier, so a dry run would mutate the row the commit then re-reads —
// "service_not_removable" on every commit (GH codex r3 P1). Every rail call
// gets its own deep copy of the row.
function cloneEstimateRow(row) {
  if (!row || typeof row !== 'object') return row;
  const copy = { ...row };
  if (row.estimate_data && typeof row.estimate_data === 'object') {
    copy.estimate_data = JSON.parse(JSON.stringify(row.estimate_data));
  }
  return copy;
}

// Pre-handoff INTENT stamp for a park: written before the first provider
// call so a witness write that fails after a real handoff (then a crash
// before finalization) leaves an unambiguous "attempted" trace — the next
// send treats that park as ambiguous (abort + office review) instead of
// restoring a quote the customer may already hold (pre-push codex P1). If
// this stamp itself cannot be written, the send aborts BEFORE any provider
// call and the wrapper's compensation restores the park.
async function stampLeadHandoffAttempt(estimate, options) {
  const ref = options?.leadShapeRef;
  if (!ref || !ref.parkedKey) return;
  await db('estimates')
    .where({ id: estimate.id })
    .update({
      estimate_data: db.raw(
        "jsonb_set(COALESCE(estimate_data, '{}'::jsonb), '{leadServiceHandoffAttempt}', ?::jsonb)",
        [JSON.stringify({ parkId: String(ref.parkId || ''), at: new Date().toISOString() })],
      ),
    });
}

async function pageOfficeAmbiguousPark(estimate, serviceKey) {
  const NotificationService = require('../services/notification-service');
  await NotificationService.notifyAdmin(
    'estimate',
    `Estimate needs review: ${estimate.customer_name || 'customer'} — delivery of a single-service quote unconfirmed`,
    'A send may have delivered the single-service quote but its handoff could not be recorded. Confirm what the customer received before resending.',
    { link: `/admin/estimates?estimateId=${estimate.id}`, metadata: { estimateId: estimate.id, customerId: estimate.customer_id || null, serviceKey }, bell: true },
  );
}

// DURABLE per-park handoff witness, written the moment a provider accepted a
// message — inside the provider branch, before the next channel leg starts —
// so a termination between the SMS and email legs can never leave a
// delivered single-service quote looking undelivered (GH codex r5/r6 P1).
// Idempotent per send; a failure is logged loudly and the later
// firstDeliveredAt stamp remains the fallback witness.
async function stampLeadHandoffWitness(estimate, options) {
  const ref = options?.leadShapeRef;
  if (!ref || !ref.parkedKey) return;
  ref.delivered = true;
  if (ref.witnessStamped) return;
  // Three attempts; a persistent failure is logged loudly and the pre-handoff
  // intent stamp keeps the park classified as ambiguous, never undelivered.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const n = await db('estimates')
        .where({ id: estimate.id })
        .update({
          estimate_data: db.raw(
            "jsonb_set(jsonb_set(COALESCE(estimate_data, '{}'::jsonb), '{leadServiceHandoffAt}', to_jsonb(?::text)), '{leadServiceHandoffParkId}', to_jsonb(?::text))",
            [new Date().toISOString(), String(ref.parkId || '')],
          ),
        });
      if (!n) throw new Error('zero rows updated');
      ref.witnessStamped = true;
      return;
    } catch (err) {
      logger.error(`[admin-estimates] lead-service handoff witness attempt ${attempt} failed for estimate ${estimate.id}: ${err.message}`);
    }
  }
}

// Compensation for a send that delivered on NO channel: the parked line is
// restored through the same rail (actor 'staff', dry run → commit), against
// the row as it is now. Runs after the delivery claim is released.
async function revertLeadServiceForSend(estimateId, serviceKey, parkId = null) {
  try {
    const row = await db('estimates').where({ id: estimateId }).first();
    if (!row || row.archived_at || row.price_locked_at) return false;
    // Idempotent: the line may already be back — the customer restored it in
    // the park-to-claim gap, or an earlier attempt restored it and stopped
    // before clearing the marker. The estimate's own event log is the proof;
    // restoring again would refuse forever (pre-push codex P1).
    let parsed = {};
    try { parsed = typeof row.estimate_data === 'string' ? JSON.parse(row.estimate_data) : (row.estimate_data || {}); }
    catch { parsed = {}; }
    const { currentlyOptedOutKeys, staffOfferedEvents } = require('../services/estimate-service-opt-out');
    if (!currentlyOptedOutKeys(parsed).includes(serviceKey)) {
      logger.info(`[admin-estimates] lead-service revert: ${serviceKey} already on estimate ${estimateId}; nothing to restore`);
      return true;
    }
    // Bound to the park it compensates, on the row as it is NOW: a customer
    // who restored the offer from the delivered link and then removed the
    // same service deliberately has superseded the park, and the line being
    // opted out is no longer ours to restore (GH codex r9 P2 — the deferred
    // marker retry already binds this way; the immediate path must too).
    if (parkId) {
      const latestStaffPark = staffOfferedEvents(parsed).find((e) => e.serviceKey === serviceKey);
      if (!latestStaffPark || latestStaffPark.parkId !== parkId) {
        logger.info(`[admin-estimates] lead-service revert: park ${parkId} for ${serviceKey} on estimate ${estimateId} was superseded by a later change; nothing to restore`);
        return true;
      }
    }
    const estimatePublic = require('./estimate-public');
    const preview = await estimatePublic.applyServiceMixChange({
      estimate: cloneEstimateRow(row), body: { serviceKey, included: true, dryRun: true }, actor: 'staff',
    });
    if (preview.status !== 200 || !preview.body?.previewBasis) {
      logger.warn(`[admin-estimates] lead-service revert: preview refused for ${serviceKey} on estimate ${estimateId} (${preview.body?.error || preview.status})`);
      return false;
    }
    const commit = await estimatePublic.applyServiceMixChange({
      estimate: cloneEstimateRow(row), body: { serviceKey, included: true, previewBasis: preview.body.previewBasis }, actor: 'staff',
    });
    if (commit.status !== 200) {
      logger.warn(`[admin-estimates] lead-service revert: commit refused for ${serviceKey} on estimate ${estimateId} (${commit.body?.error || commit.status})`);
      return false;
    }
    logger.info(`[admin-estimates] lead-service revert: ${serviceKey} restored on estimate ${estimateId} after an undelivered send`);
    return true;
  } catch (err) {
    logger.warn(`[admin-estimates] lead-service revert failed for estimate ${estimateId}: ${err.message}`);
    return false;
  }
}

// Shared send logic — used by both immediate send and scheduled cron
// Multi-property group pre-flight (codex #3244 r1). Publishing the group makes
// every sibling token publicly acceptable, so BEFORE any channel delivery:
// (a) every publishable sibling must clear the same send gate as the anchor —
// a quote-required / unapproved / zero-amount sibling aborts the WHOLE send
// rather than partially publishing the group; (b) siblings are claimed to
// 'sending' one row at a time (claim = update WHERE id+current status, so a
// row a concurrent send already claimed is never stolen or released by this
// one) — two concurrent sends of different group members serialize, the loser
// aborts pre-delivery. Returns the claimed rows for later publish/release.
// Sibling rows are read whole inside the claim transaction; the marker
// lives in estimate_data (see estimate-clarify-asks.repricePendingActive).
function siblingRepricePending(row) {
  try {
    const data = typeof row.estimate_data === 'string' ? JSON.parse(row.estimate_data) : (row.estimate_data || {});
    return require('../services/estimate-clarify-asks').repricePendingActive(data?.estimatorEngine);
  } catch { return false; }
}

async function assertReviewedEstimateGroup(database, estimate, expectedVersions) {
  if (!expectedVersions || !estimate.estimate_group_id) return;
  const rows = await database('estimates').where({ estimate_group_id: estimate.estimate_group_id }).whereNull('archived_at').orderBy('id').forUpdate().select('*');
  const current = Object.fromEntries(rows.map((row) => [row.id, estimateOfferVersion(row)]));
  if (JSON.stringify(current) !== JSON.stringify(expectedVersions)) {
    throw Object.assign(new Error('A property on this estimate changed. Review the current group before sending.'), { statusCode: 409, code: 'ESTIMATE_REVIEW_STALE' });
  }
}

async function claimGroupSiblingsForPublish(estimate, { callerPreClaimed = false, autoSend = false, reviewedEditVersion = null, reviewedGroupVersions = null } = {}) {
  // Mid-send check, sibling enumeration, and the claims run in ONE
  // transaction under a group-scoped advisory xact lock (codex #3244 r8):
  // without it, two overlapping immediate sends of different members could
  // interleave check→claim so that A publishes while B's row was neither
  // claimed by A nor allowed to send itself. The lock releases at commit;
  // a competing route-level anchor claim serializes against the row-status
  // guards either way.
  return db.transaction(async (trx) => {
    await trx.raw(
      'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['estimate-group-send', String(estimate.estimate_group_id)],
    );
    await assertReviewedEstimateGroup(trx, estimate, reviewedGroupVersions);
    if (reviewedEditVersion) {
      const anchor = await trx('estimates').where({ id: estimate.id }).forUpdate().first();
      if (estimateEditVersion(anchor) !== reviewedEditVersion) {
        throw Object.assign(new Error('The saved estimate changed before its send claim. Review it again.'), { statusCode: 409, code: 'ESTIMATE_REVIEW_STALE' });
      }
    }
    // A sibling already mid-send is a concurrent publisher (another pod's
    // scheduled batch, or a parallel operator click): its send will publish
    // this group with its own message, so this send must abort rather than
    // deliver a second one.
    const midSendSibling = await trx('estimates')
      .where({ estimate_group_id: estimate.estimate_group_id, status: 'sending' })
      .whereNot({ id: estimate.id })
      .first('id');
    if (midSendSibling) {
      const err = new Error('Another send is publishing this multi-property group — wait a moment and retry.');
      err.statusCode = 409;
      throw err;
    }
    // Group-wide pricing-authority verdict at DELIVERY (GH codex P1 r6):
    // every viewable sibling — published ones included — must clear the
    // gate before this send hands the customer the group link. Same verdict
    // the schedule route applied at request time; here it runs under the
    // group lock on the rows the claims below will actually publish beside.
    const blockingSibling = await findGroupSiblingBlockingSend(estimate, { database: trx, autoSend });
    if (blockingSibling) {
      const err = new Error(blockingSiblingMessage(blockingSibling, 'sending this group (the group link shows every property together)'));
      err.statusCode = blockingSibling.statusCode;
      err.code = blockingSibling.code;
      throw err;
    }
    // Claim the ANCHOR here too, under the same lock (codex #3248 r4) —
    // unless a pre-claiming caller (scheduled cron, lead auto-send) already
    // moved it to 'sending' before calling.
    let anchorClaimedInLock = false;
    if (String(estimate.status || '') !== 'sending') {
      const anchorClaimed = await trx('estimates')
        // Observed-membership pin (GH codex P1 r8): the siblings enumerated
        // below are THIS group's; an anchor moved elsewhere since the read
        // must not be published beside them.
        .where({ id: estimate.id, status: estimate.status, estimate_group_id: estimate.estimate_group_id })
        .whereNull('price_locked_at')
        // Same archive guard as the standalone claim (codex P0, PR #3304).
        .whereNull('archived_at')
        .whereNotIn('status', ['accepted', 'declined', 'expired'])
        // Same pricing-authority re-assertion as the standalone claim.
        .modify((q) => {
          if (gatedSendAuthorityPredicateApplies()) q.whereRaw(GATED_SEND_AUTHORITY_SQL);
        })
        .update({ status: 'sending', updated_at: trx.fn.now() });
      if (!anchorClaimed) {
        const err = new Error('This estimate is being sent or is locked right now. Wait a moment and retry.');
        err.statusCode = 409;
        throw err;
      }
      anchorClaimedInLock = true;
    } else if (!callerPreClaimed) {
      // An anchor ALREADY 'sending' that this caller did not pre-claim
      // belongs to someone else's in-flight send (codex #3248 r6) —
      // proceeding would deliver a duplicate message on their claim.
      const err = new Error('This estimate is being sent or is locked right now. Wait a moment and retry.');
      err.statusCode = 409;
      throw err;
    }
    const siblings = await trx('estimates')
      .where({ estimate_group_id: estimate.estimate_group_id })
      .whereNot({ id: estimate.id })
      .whereNull('archived_at')
      .whereNull('price_locked_at')
      .whereIn('status', ['draft', 'scheduled', 'send_failed']);
    if (!siblings.length) {
      // No siblings to publish — the anchor claim above already ran under
      // this lock (codex #3248 r6: a second compare-and-set here required
      // the stale pre-claim status and 409'd every grouped resend whose
      // siblings were already published/terminal).
      return { claimed: [], anchorClaimedInLock };
    }
  for (const sibling of siblings) {
    try {
      // Acknowledgment is PER ESTIMATE (codex #3244 r4): the anchor's
      // acknowledged warning (or its scheduled-status implicit ack) says
      // nothing about a yellow-lane DRAFT sibling the operator never
      // reviewed. A sibling only carries its own implicit ack when it was
      // itself scheduled (it cleared its own request-time gate then); an
      // unacknowledged yellow draft aborts the whole group send.
      assertEstimateSendable(sibling, {
        engineReviewAcknowledged: ['scheduled', 'sending'].includes(String(sibling.status || '')),
      });
      // A sibling under a clarify re-price hold is not publishable either
      // — the anchor's verdict never inspects sibling markers (codex r1 P1
      // on #3804); the claim below re-asserts this atomically.
      if (siblingRepricePending(sibling)) {
        const held = new Error('it is held for a re-price (a clarify answer replaces its dollars or address) — re-draft or revise it first');
        held.statusCode = 409;
        throw held;
      }
      // Automation policy (pre-push codex P0): the gate-dependent check
      // above lets a CLIENT_FALLBACK sibling through while the gate is off;
      // an auto-send never publishes one.
      if (autoSend) assertAutoSendPricingAuthority(sibling);
    } catch (e) {
      const err = new Error(`Grouped property "${sibling.address || sibling.id}" is not sendable: ${e.message}`);
      err.statusCode = e.statusCode || 422;
      err.code = e.code || err.code;
      throw err;
    }
  }
    // Anchor-claim ownership rides back to the caller (codex #3248 r5):
    // the route must only release a claim THIS request actually won — a
    // loser releasing by status alone would flip the concurrent winner's
    // in-flight claim back to a stale status and strand its sent-write.
    const claimed = [];
    for (const sibling of siblings) {
      // updated_at joins the claim predicate (codex #3244 r5): a revision
      // between this transaction's read and the claim bumps updated_at, so
      // the claim misses and the group send aborts instead of publishing
      // (and snapshotting) a stale validation.
      const won = await trx('estimates')
        .where({ id: sibling.id, status: sibling.status, updated_at: sibling.updated_at })
        .whereNull('price_locked_at')
        .whereRaw(REPRICE_PENDING_ABSENT_SQL)
        // Same atomic re-assertion as the anchor claims: the preflight above
        // read the sibling before this lock; a fallback stamp landing in
        // between loses the race here.
        .modify((q) => {
          if (autoSend) q.whereRaw(SERVER_PRICING_AUTHORITY_SQL);
          else if (gatedSendAuthorityPredicateApplies()) q.whereRaw(GATED_SEND_AUTHORITY_SQL);
        })
        .update({ status: 'sending', updated_at: trx.fn.now() });
      if (won) claimed.push(sibling);
    }
    if (claimed.length !== siblings.length) {
      // Transaction rollback releases the partial claims atomically.
      const err = new Error('Another send is publishing this multi-property group — wait a moment and retry.');
      err.statusCode = 409;
      throw err;
    }
    return { claimed, anchorClaimedInLock };
  });
}

// Hand claimed siblings back to their pre-claim status. Scoped to rows still
// 'sending' so a sibling a concurrent accept moved off the claim keeps its
// terminal state.
async function releaseGroupSiblingClaims(claimedSiblings = []) {
  for (const sibling of claimedSiblings) {
    try {
      const restored = await db('estimates')
        .where({ id: sibling.id, status: 'sending' })
        .whereRaw(REPRICE_PENDING_ABSENT_SQL)
        .update({ status: sibling.status, updated_at: db.fn.now() });
      // A sibling HELD while claimed (a clarify reply stamps the hold on a
      // 'sending' row by design, past the reach of the reply's own
      // unschedule, which touches 'scheduled' rows only) goes back as an
      // INERT draft with no due time — restoring its pre-claim 'scheduled'
      // with scheduled_at intact would re-enter the cron, which the hold
      // promised to pull it off (codex r14 P2 on #3804). A row already
      // moved off 'sending' (accepted) keeps its terminal state either way.
      if (!restored) {
        await db('estimates')
          .where({ id: sibling.id, status: 'sending' })
          .update({ status: 'draft', scheduled_at: null, updated_at: db.fn.now() });
      }
    } catch (e) {
      logger.warn(`[admin-estimates] failed to release group sibling claim ${sibling.id}: ${e.message}`);
    }
  }
}

// Claim release + deferred-invalidation finalizer (see the delivery-claim
// protocol note in admin-estimate-persistence.js). Token-fenced: only THIS
// send's claim is cleared, so a rare back-to-back send on the same row never
// loses its own fresh claim to a predecessor's cleanup. If the reconciler
// recorded a PENDING invalidation while this send's claim was live (codex
// P0 r22 — deferrals must never be lost), the release COMPLETES it here:
// full marker, linkage keys removed, old-lead unlink, row archived. Failure
// is non-fatal — an uncleared claim ages out by TTL, the pending marker
// already blocks any resend, and the next reconcile (claim now stale)
// applies the full invalidation itself.
async function clearEstimateDeliveryClaim(estimateId, deliveryClaimToken) {
  if (!estimateId || !deliveryClaimToken) return;
  try {
    await db.transaction(async (trx) => {
      const row = await trx('estimates').where({ id: estimateId }).forUpdate().first('id', 'status', 'archived_at', 'estimate_data');
      if (!row) return;
      let data;
      try {
        data = typeof row.estimate_data === 'string'
          ? JSON.parse(row.estimate_data) : (row.estimate_data || {});
      } catch { return; }
      if (!data || typeof data !== 'object') return;
      const eng = data.estimatorEngine && typeof data.estimatorEngine === 'object' ? data.estimatorEngine : null;
      if (!eng || eng.delivering_token !== deliveryClaimToken) return;
      delete eng.delivering_at;
      delete eng.delivering_token;
      const pending = takePendingInvalidation(data);
      if (pending && !eng.linkage_invalidated_at) {
        // ONE shared transition (admin-estimate-persistence): the full
        // marker lands, linkage keys go, the old lead unlinks, and the row
        // archives back to an inert draft — EXCEPT a money-bearing
        // terminal, which keeps status, archive state, and money fields
        // (codex P0 r23/r26: an accept can race the pending marker through
        // the closing public gate; conversion is the operator's to unwind,
        // but the permanent public token must still die).
        const { terminal, status, obsolete, deferred } = await completePendingInvalidation(trx, estimateId, { row, data, pending });
        if (deferred) {
          logger.info(`[admin-estimates] deferred a pending invalidation on estimate ${estimateId} — a newer processing generation is mid-flight; the wedged-invalidation sweep re-attempts once the call settles`);
        } else if (obsolete) {
          logger.info(`[admin-estimates] discarded an OBSOLETE pending invalidation on estimate ${estimateId} — a later retry restored the recorded linkage`);
        } else if (terminal) {
          logger.warn(`[admin-estimates] deferred invalidation of estimate ${estimateId} met terminal status '${status}' — marker-only invalidation applied (status and money preserved), needs operator review`);
        } else {
          logger.info(`[admin-estimates] completed deferred invalidation of estimate ${estimateId} at delivery-claim release (${pending.from || pending.conflict || 'unlink'} → ${pending.to || 'none'})`);
        }
        return;
      }
      await trx('estimates').where({ id: estimateId })
        .update({ estimate_data: JSON.stringify(data), updated_at: trx.fn.now() });
    });
  } catch (e) {
    logger.warn(`[admin-estimates] delivery-claim clear failed for estimate ${estimateId}: ${e.message}`);
  }
}

// Last-instant re-check before each provider handoff (codex P0 r23, P1 GH
// r5): the verdict lock released moments ago, and BOTH an estimate marker
// AND a call-side correction can commit in between — a retry can stamp a
// new lead while its detached estimator run hasn't recorded the pending
// invalidation yet, leaving a real unmarked window that only the call row
// shows. So the linkage revalidation is repeated here, not just the marker
// read. Nothing can make a provider call atomic with a DB commit, but this
// shrinks the window to milliseconds — and the public routes fail closed
// on the markers, so a message that still slips out carries a link that
// serves nothing. DB failure fails CLOSED (the leg is retryable);
// unparseable estimate_data proceeds, matching the verdict read.
async function estimateInvalidatedJustBeforeHandoff(estimateId) {
  const row = await db('estimates').where({ id: estimateId }).first('archived_at', 'estimate_data');
  if (!row) return true;
  if (row.archived_at) return true;
  let data;
  try {
    data = typeof row.estimate_data === 'string'
      ? JSON.parse(row.estimate_data) : (row.estimate_data || {});
  } catch { return false; }
  const eng = data?.estimatorEngine;
  if (eng && (eng.linkage_invalidated_at || eng.invalidation_pending_at)) return true;
  // A bedroom re-price in flight (estimate-clarify-asks): the draft's
  // dollars are about to be replaced — not sendable meanwhile.
  if (require('../services/estimate-clarify-asks').repricePendingActive(eng)) return true;
  return !!(await staleCallLinkageReason(db, data));
}

async function recordManualSendAttempt(estimateId, attempt, patch) {
  if (!attempt) return;
  await db.transaction(async (trx) => {
    const row = await trx('estimates').where({ id: estimateId }).forUpdate().first('estimate_data');
    const data = parseEstimateData(row?.estimate_data);
    if (!data || !Array.isArray(data.manualSendAttempts)) throw new Error('Send attempt receipt is unavailable; check the provider outcome before retrying.');
    const entry = data.manualSendAttempts.find((item) => item.key === attempt.key && item.binding === attempt.binding);
    if (!entry) throw new Error('Send attempt receipt changed; check the provider outcome before retrying.');
    Object.assign(entry, patch);
    await trx('estimates').where({ id: estimateId }).update({ estimate_data: JSON.stringify(data) });
  });
}

async function sendEstimateNow(estimate, sendMethod, options = {}) {
  // The existing scheduled sender passes the claimed row. Carry the exact
  // reviewed offer/template from its scheduled receipt into the same delivery
  // claim used for immediate sends; no second scheduler or transport.
  if (options.callerPreClaimed && estimate.scheduled_at) {
    const scheduledAt = new Date(estimate.scheduled_at).toISOString();
    const attempts = parseEstimateData(estimate.estimate_data)?.manualSendAttempts;
    const scheduled = (Array.isArray(attempts) ? attempts : []).findLast((entry) => entry.scheduleReview?.scheduledAt === scheduledAt);
    const acknowledged = scheduled?.scheduleReview?.acknowledgedUncertainAttemptKeys || [];
    if ((Array.isArray(attempts) ? attempts : []).some((entry) => entry.startedAt && !entry.result && !acknowledged.includes(entry.key))) throw Object.assign(new Error('An earlier send has an uncertain outcome. Staff must review it before this schedule runs.'), { code: 'SEND_OUTCOME_UNCERTAIN', statusCode: 409 });
    if (scheduled) {
      if (scheduled.startedAt) throw Object.assign(new Error('This scheduled send already started. Review the recorded provider outcome before another send.'), { code: 'SEND_OUTCOME_UNCERTAIN', statusCode: 409 });
      options = { ...options, ...scheduled.scheduleReview, idempotencyKey: scheduled.key, manualAttempt: { key: scheduled.key, binding: scheduled.binding } };
    }
  }
  // The claim is stamped inside the verdict transaction (see below) and
  // MUST be released on every exit — success, partial failure, or throw —
  // or legitimate linkage corrections stay blocked until the TTL expires.
  const deliveryClaimToken = crypto.randomUUID();
  // Send-time lead service (GATE_ESTIMATE_LEAD_SERVICE_SEND) parks a line
  // BEFORE delivery; the inner send records the parked key HERE (not only in
  // its return value) so a throw after the park — the invalidation verdict,
  // a provider error — still reaches the compensation below (pre-push codex
  // P1).
  const leadShapeRef = { parkedKey: null, delivered: false };
  let result;
  let thrown = null;
  try {
    result = await sendEstimateNowInner(estimate, sendMethod, { ...options, leadShapeRef }, deliveryClaimToken);
  } catch (err) {
    thrown = err;
  } finally {
    await clearEstimateDeliveryClaim(estimate?.id, deliveryClaimToken);
  }
  // When NO channel delivered, the customer never saw the single-service
  // shape, so the park is compensated — the line is restored through the
  // same rail — after the delivery claim is released (the rail's write
  // refuses while a claim is live). `delivered` is the provider-handoff
  // witness: a throw AFTER a successful handoff (snapshot read, status
  // finalize) must not revert a quote the customer already holds (GH codex
  // P1). Best-effort: a failed revert is logged and the row keeps the offer
  // shape a resend would carry anyway.
  // Reverts on ANY exit without a real handoff — sent:false, a throw, or a
  // sent:true built only from suppression sentinels (r2).
  if (leadShapeRef.parkedKey && !leadShapeRef.delivered) {
    // Every channel conclusively failed (no throw): the attempt stamp is no
    // longer ambiguous evidence — clear it so a later retry is a retry, not
    // a review abort (GH codex r9 P1). Best-effort; the bound marker below
    // wins over the stamp regardless.
    if (!thrown && result && result.sent === false) {
      try {
        await db('estimates').where({ id: estimate?.id }).update({
          estimate_data: db.raw("COALESCE(estimate_data, '{}'::jsonb) - 'leadServiceHandoffAttempt'"),
        });
      } catch (err) { logger.warn(`[admin-estimates] attempt-stamp clear failed for estimate ${estimate?.id}: ${err.message}`); }
    }
    const restored = await revertLeadServiceForSend(estimate?.id, leadShapeRef.parkedKey, leadShapeRef.parkId || null);
    // A failed compensation is a DURABLE retry state, never a silent
    // reshape: the marker makes the next send retry the restore first (and
    // abort if it still fails), and the office is paged (pre-push codex P1).
    if (!restored) await markLeadServiceRevertPending(estimate, leadShapeRef.parkedKey, leadShapeRef.parkId || null);
  }
  if (thrown) throw thrown;
  if (options.manualAttempt && Object.values(result?.channels || {}).some((channel) => channel.uncertain)) {
    // No completed receipt: a provider timeout may already have handed off.
    // Preserve channel evidence and require deliberate review for a new key.
    await recordManualSendAttempt(estimate.id, options.manualAttempt, { channels: result.channels });
    return { ...result, uncertain: true };
  }
  await recordManualSendAttempt(estimate.id, options.manualAttempt, { result, completedAt: new Date().toISOString() });
  return result;
}

async function markLeadServiceRevertPending(estimate, serviceKey, parkId = null) {
  let markerWritten = false;
  let markerError = null;
  try {
    await db('estimates')
      .where({ id: estimate.id })
      .update({
        estimate_data: db.raw(
          "jsonb_set(COALESCE(estimate_data, '{}'::jsonb), '{leadServiceRevertPending}', ?::jsonb)",
          [JSON.stringify({ serviceKey, ...(parkId ? { parkId } : {}), at: new Date().toISOString() })],
        ),
        updated_at: db.fn.now(),
      });
    markerWritten = true;
  } catch (err) {
    markerError = err;
    logger.error(`[admin-estimates] lead-service revert-pending marker failed for estimate ${estimate?.id}: ${err.message}`);
  }
  try {
    const NotificationService = require('../services/notification-service');
    await NotificationService.notifyAdmin(
      'estimate',
      `Estimate needs review: ${estimate.customer_name || 'customer'} — add-on offer not restored`,
      'A send delivered on no channel and the parked service could not be restored automatically. The next send retries; check the estimate before resending.',
      { link: `/admin/estimates?estimateId=${estimate.id}`, metadata: { estimateId: estimate.id, customerId: estimate.customer_id || null, serviceKey }, bell: true },
    );
  } catch (err) {
    logger.error(`[admin-estimates] lead-service revert-pending bell failed for estimate ${estimate?.id}: ${err.message}`);
  }
  // Fail CLOSED when the durable marker could not persist (GH codex r4 P1):
  // the send already failed; surfacing the outage is right, and the next
  // send is still guarded structurally (a staff-parked line on a never-
  // delivered row is treated as pending — see applyLeadServiceForSend).
  if (!markerWritten) {
    const err = new Error(`Send delivered on no channel and the add-on review marker could not be written (${markerError?.message || 'unknown'}). Check the estimate before resending.`);
    err.statusCode = 503;
    throw err;
  }
}

async function clearLeadServiceRevertPending(estimateId) {
  await db('estimates')
    .where({ id: estimateId })
    .update({
      estimate_data: db.raw("COALESCE(estimate_data, '{}'::jsonb) - 'leadServiceRevertPending'"),
      updated_at: db.fn.now(),
    });
}


// A sibling that left 'sending' before publication (the public flow
// deliberately exposes siblings mid-'sending', and both accept and decline
// move the row off it; acceptance also sets price_locked_at — either way
// the guarded finalization update zero-rows). The customer SAW THIS
// delivery's scope, so: (1) merge the scope stamp UNDER the terminal row's
// sendSnapshot (its bundle is kept, never status / price lock) AND the
// anchor's deliveryState beside it — exactly as the superseded anchor path
// does. The accept witness alone cannot close a quote_promised card
// without the scope (codex r26 P1), and a DECLINED sibling has no accept
// witness and no anchor inheritance (its status disqualifies it), so its
// own deliveryState is the only proof the quote went out (codex r31 P1);
// real deliveries only. (2) Snapshot the terminal row for
// the pricing audit (GH codex P2), built from the PRE-ACCEPT sibling row +
// THIS delivery's freshly built bundle — an accept rewrites result/totals,
// and a stale prior sendSnapshot must not outrank the bundle just handed
// to the customer (GH codex P1); status reflects the delivered state. Both
// fail-soft: the accepted state stands. Lifted out of the publication
// retry loop so the flow reads flat (codex r30 P2).
// Send-time pricing snapshot for a PUBLISHED sibling (estimator audit M4):
// only the anchor wrote one, so grouped properties had no frozen quote
// provenance. NO re-read: a customer can accept the now-sent sibling
// before a re-read completes, and the acceptance rewrite would contaminate
// this permanent send-time record (GH codex P1). The pre-claim row + the
// patch just written IS the published state; status/expiry override to the
// delivered values, and the ANCHOR's channel is how it was delivered (the
// sibling's own send_method is cleared at publication). Fail-soft like the
// anchor's — an audit-snapshot failure never unwinds a delivered send.
async function snapshotPublishedSibling(sibling, siblingSnapshotPatch, { now, nextExpiresAt, sendMethod }) {
  try {
    const { saveEstimatePricingAuditSnapshot } = require('../services/estimate-pricing-audit');
    let publishedData = sibling.estimate_data;
    if (typeof publishedData === 'string') { try { publishedData = JSON.parse(publishedData); } catch { publishedData = {}; } }
    await saveEstimatePricingAuditSnapshot({
      ...sibling,
      status: sibling.viewed_at ? 'viewed' : 'sent',
      sent_at: now,
      expires_at: nextExpiresAt,
      estimate_data: { ...(publishedData || {}), ...siblingSnapshotPatch },
    }, { trigger: 'group_send', sendMethod });
  } catch (auditErr) {
    logger.warn(`[admin-estimates] sibling ${sibling.id} pricing audit snapshot failed (send stands): ${auditErr.message}`);
  }
}

async function recordTerminalSiblingDelivery(sibling, snapshot, { delivered, sendMethod, deliveryStatePatch }) {
  logger.warn(`[admin-estimates] sibling ${sibling.id} left 'sending' before publication (accepted or declined) — state preserved.`);
  if (delivered && snapshot.sendSnapshot.scope) {
    try {
      await db('estimates').where({ id: sibling.id }).update({
        estimate_data: db.raw(
          "jsonb_set(COALESCE(estimate_data, '{}'::jsonb), '{sendSnapshot}', COALESCE(estimate_data -> 'sendSnapshot', '{}'::jsonb) || ?::jsonb, true) || ?::jsonb",
          [JSON.stringify({ scope: snapshot.sendSnapshot.scope, scopeHistory: snapshot.sendSnapshot.scopeHistory }), JSON.stringify(deliveryStatePatch)],
        ),
        updated_at: db.fn.now(),
      });
    } catch (scopeErr) {
      logger.warn(`[admin-estimates] sibling ${sibling.id} delivered-scope merge failed (state stands): ${scopeErr.message}`);
    }
  }
  try {
    const { saveEstimatePricingAuditSnapshot } = require('../services/estimate-pricing-audit');
    let preAcceptData = sibling.estimate_data;
    if (typeof preAcceptData === 'string') { try { preAcceptData = JSON.parse(preAcceptData); } catch { preAcceptData = {}; } }
    preAcceptData = preAcceptData || {};
    await saveEstimatePricingAuditSnapshot({
      ...sibling,
      status: sibling.viewed_at ? 'viewed' : 'sent',
      estimate_data: { ...preAcceptData, sendSnapshot: snapshot.sendSnapshot },
    }, { trigger: 'group_send', sendMethod });
  } catch (auditErr) {
    logger.warn(`[admin-estimates] sibling ${sibling.id} pricing audit snapshot failed (state stands): ${auditErr.message}`);
  }
}

async function sendEstimateNowInner(estimate, sendMethod, options, deliveryClaimToken) {
  if (!['sms', 'email', 'both'].includes(sendMethod)) {
    const err = new Error('Invalid sendMethod');
    err.statusCode = 400;
    throw err;
  }
  // A row in 'scheduled'/'sending' already cleared the request-time gate
  // (the operator acknowledged the engine review when scheduling/clicking) —
  // the cron leg must not bounce it at execution time.
  const engineReviewAcknowledgedResolved = options.engineReviewAcknowledged === true
    || ['scheduled', 'sending'].includes(String(estimate.status || ''));
  assertEstimateSendable(estimate, {
    engineReviewAcknowledged: engineReviewAcknowledgedResolved,
  });

  // Send-time lead-with-one-service (GATE_ESTIMATE_LEAD_SERVICE_SEND): parks
  // the non-lead recurring lines as staff opt-out events BEFORE any delivery
  // so every channel carries the single-service quote. Best-effort by
  // design — a refusal or engine miss sends the full bundle exactly as today
  // (never a blocked send), and the row is re-read so the message text and
  // the delivery claim below see the parked totals.
  // The post-operator, PRE-park row is what the draft-to-send learning
  // event must see — an automated park is not an operator edit (GH codex
  // r9 P1).
  const preParkEstimate = estimate;
  const leadShape = await applyLeadServiceForSend(estimate, { leadShapeRef: options.leadShapeRef || null, preserveReviewedOffer: !!options.reviewedOffer });
  estimate = leadShape.estimate;
  if (leadShape.parkedKey) {
    // The operator acknowledged the pre-park bundle; the parked single-line
    // quote is a DIFFERENT recompute and must clear sendability on its own —
    // review-only output falls back to the full bundle (GH codex r9 P1).
    let shapedSendable = true;
    try {
      assertEstimateSendable(estimate, { engineReviewAcknowledged: engineReviewAcknowledgedResolved });
      let shapedData = {};
      try { shapedData = typeof estimate.estimate_data === 'string' ? JSON.parse(estimate.estimate_data) : (estimate.estimate_data || {}); } catch { shapedData = {}; }
      const lines = Array.isArray(shapedData?.engineResult?.lineItems) ? shapedData.engineResult.lineItems : [];
      // The rail's own predicate — the draft builder's flags PLUS the low
      // pricing-confidence grade it records separately (GH codex r10 P1).
      const { lineReviewOnly } = require('../services/estimate-service-opt-out');
      if (lines.some((li) => li && typeof li === 'object' && lineReviewOnly(li))) shapedSendable = false;
    } catch (_) { shapedSendable = false; }
    if (!shapedSendable) {
      logger.warn(`[admin-estimates] lead-service send: parked quote not sendable on estimate ${estimate.id}; restoring the full bundle`);
      const restored = await revertLeadServiceForSend(estimate.id, leadShape.parkedKey, options.leadShapeRef?.parkId || null);
      if (!restored) {
        const abort = new Error('The single-service quote needs a review and the full bundle could not be restored. Nothing was sent.');
        abort.statusCode = 409;
        abort.leadServiceAbort = true;
        throw abort;
      }
      const restoredRow = await db('estimates').where({ id: estimate.id }).first();
      if (!restoredRow) throw Object.assign(new Error('Estimate disappeared while restoring. Nothing was sent.'), { statusCode: 409, leadServiceAbort: true });
      estimate = { ...restoredRow, status: estimate.status };
      leadShape.parkedKey = null;
      if (options.leadShapeRef) { options.leadShapeRef.parkedKey = null; options.leadShapeRef.parkId = null; }
    }
  }

  // Group pre-flight runs before ANY channel delivery (see helper above).
  let claimedGroupSiblings = [];
  if (estimate.estimate_group_id) {
    const groupClaim = await claimGroupSiblingsForPublish(estimate, {
      callerPreClaimed: options.callerPreClaimed === true,
      autoSend: options.autoSend === true,
      reviewedEditVersion: options.reviewedEditVersion,
      reviewedGroupVersions: options.reviewedGroupVersions,
    });
    claimedGroupSiblings = groupClaim.claimed;
    // Signal claim ownership to the caller AFTER the claim transaction
    // committed. Ownership = this send claimed in-lock, or its CALLER
    // pre-claimed (scheduled cron / lead auto-send) — a bare 'sending'
    // status read is never proof (codex #3248 r6).
    if (options.claimState && (groupClaim.anchorClaimedInLock || options.callerPreClaimed === true)) {
      options.claimState.anchorClaimed = true;
    }
  }

  // FINAL pre-delivery verdict re-read (codex P0, PR #3304): a linkage
  // invalidation can archive the row after this send claimed it — the
  // in-memory estimate still carries the FORMER lead's recipient and
  // content, and delivering it would expose another customer's PII. A row
  // archived (or marked invalidated) since the claim releases back to
  // send_failed and aborts before any provider call.
  {
    // FOR UPDATE inside a short transaction (codex P0, PR #3304 r19/r20):
    // the same locked transaction that reads the verdict also STAMPS the
    // delivery claim (estimatorEngine.delivering_at + delivering_token),
    // making verdict-and-claim atomic. The reconciler and the identity
    // quarantine refuse to commit an invalidation while the claim is fresh
    // (deliveryClaimFresh in admin-estimate-persistence.js), so no marker
    // can slip in between this lock releasing and the provider handoff —
    // the lock itself is never held across provider calls.
    const invalidatedNow = await db.transaction(async (trx) => {
      const verdictRow = await trx('estimates')
        .where({ id: estimate.id })
        .forUpdate()
        .first();
      if (!verdictRow) return 'invalidated_before_delivery';
      if (verdictRow.archived_at) return 'invalidated_before_delivery';
      if (options.reviewedOffer && estimateOfferVersion(verdictRow) !== options.reviewedOffer) {
        return 'saved_offer_changed';
      }
      let data;
      try {
        data = typeof verdictRow.estimate_data === 'string'
          ? JSON.parse(verdictRow.estimate_data) : (verdictRow.estimate_data || {});
      } catch { data = null; }
      if (data?.estimatorEngine?.linkage_invalidated_at) return 'invalidated_before_delivery';
      // A PENDING invalidation (recorded by the reconciler while an
      // earlier send's claim was live, codex P0 r22) is as final as the
      // full marker for send purposes — the archive just hasn't landed
      // yet. Never re-send, and never stamp a new claim over it.
      if (data?.estimatorEngine?.invalidation_pending_at) return 'invalidated_before_delivery';
      // A bedroom re-price in flight replaces this draft's dollars —
      // never deliver the fallback price meanwhile (time-boxed marker,
      // see repricePendingActive).
      if (require('../services/estimate-clarify-asks').repricePendingActive(data?.estimatorEngine)) return 'reprice_pending';
      // LIVE call-linkage revalidation for engine-drafted rows (codex P0,
      // PR #3304 r21): the call processor can commit a corrected stamp
      // BEFORE its reconcile archives this draft — the marker check alone
      // misses that window, and stamping the claim below would then defer
      // the very reconcile meant to stop this send.
      const staleLinkage = await staleCallLinkageReason(trx, data);
      if (staleLinkage) return staleLinkage;
      // Unparseable estimate_data: verdict passes (matches the prior
      // read-only behavior) but no claim is stamped — a blind rewrite
      // would clobber whatever is in the column.
      if (data && typeof data === 'object') {
        if (options.manualAttempt) {
          const attempts = Array.isArray(data.manualSendAttempts) ? data.manualSendAttempts : [];
          const priorAttempt = attempts.find((entry) => entry.key === options.manualAttempt.key);
          if (priorAttempt?.startedAt) return 'send_attempt_already_started';
          const started = { ...priorAttempt, ...options.manualAttempt, startedAt: new Date().toISOString(), channels: {} };
          data.manualSendAttempts = [...attempts.filter((entry) => entry.key !== options.manualAttempt.key), started].slice(-DELIVERY_HISTORY_MAX);
        }
        data.estimatorEngine = {
          ...(data.estimatorEngine && typeof data.estimatorEngine === 'object' ? data.estimatorEngine : {}),
          delivering_at: new Date().toISOString(),
          delivering_token: deliveryClaimToken,
        };
        await trx('estimates').where({ id: estimate.id })
          .update({ estimate_data: JSON.stringify(data), updated_at: trx.fn.now() });
      }
      return null;
    });
    if (invalidatedNow) {
      if (invalidatedNow === 'saved_offer_changed') {
        throw Object.assign(new Error('The saved offer changed before delivery. Review the current version; nothing was sent.'), { statusCode: 409, code: 'ESTIMATE_REVIEW_STALE' });
      }
      await db('estimates')
        .where({ id: estimate.id, status: 'sending' })
        .update({ status: 'send_failed', last_send_error: invalidatedNow, updated_at: db.fn.now() });
      const err = new Error(invalidatedNow === 'reprice_pending'
        ? "This estimate is being re-priced from the customer's bedroom answer — the replacement draft is on its way. Nothing was sent."
        : 'This estimate was invalidated by a call-linkage correction before delivery. Nothing was sent.');
      err.statusCode = 409;
      throw err;
    }
  }
  // Park-to-claim gap (pre-push codex P1): the public service-mix route can
  // commit a customer change between the park above and the claim just
  // stamped (the claim blocks it from here on). Compose every message from
  // the row as it is NOW, never the parked snapshot.
  if (leadShape.parkedKey) {
    const postClaim = await db('estimates').where({ id: estimate.id }).first();
    if (!postClaim) {
      const err = new Error('Estimate disappeared before delivery. Nothing was sent.');
      err.statusCode = 409;
      throw err;
    }
    estimate = { ...postClaim, status: estimate.status };
  }

  // Intent stamp BEFORE any provider call (see stampLeadHandoffAttempt).
  if (leadShape.parkedKey) await stampLeadHandoffAttempt(estimate, options);

  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const nextExpiresAt = estimateExpiresAt(now);
  const requestedChannels = sendMethod === 'both' ? ['sms', 'email'] : [sendMethod];
  const longUrl = `https://portal.wavespestcontrol.com/estimate/${estimate.token}`;
  // One tracked short code PER CHANNEL LEG (same rule as estimate-follow-up
  // .js mintStageLinks): on sendMethod='both' either leg can fail alone
  // (missing/disabled SMS template, policy-blocked SMS, provider error), and
  // the click-followup candidate scan (services/click-followup.js) admits
  // sc.channel='sms' links only — a single sms-tagged code reused in the
  // email payload would let a click on an EMAIL-only delivery masquerade as
  // an SMS click and queue a proactive SMS nudge. Minting per leg keeps
  // every click attributable to the channel that actually carried it: a leg
  // that never goes out just leaves an undelivered (hence unclickable) code
  // behind, which is harmless. A leg without a contact handle skips the mint
  // entirely — the long-URL fallback mirrors shortenOrPassthrough's own
  // graceful degradation on shortener failure.
  const linkMeta = {
    kind: 'estimate', entityType: 'estimates', entityId: estimate.id, customerId: estimate.customer_id,
    leadId: await leadIdForEstimate(estimate),
    purpose: 'estimate_send',
  };
  const smsViewUrl = (sendMethod !== 'email' && estimate.customer_phone)
    ? await shortenOrPassthrough(longUrl, { ...linkMeta, channel: 'sms' })
    : longUrl;
  const emailViewUrl = (sendMethod !== 'sms' && estimate.customer_email)
    ? await shortenOrPassthrough(longUrl, { ...linkMeta, channel: 'email' })
    : longUrl;
  const firstName = estimate.customer_name?.split(' ')[0] || 'there';
  // Residential sends use the compliant summary (codex 2642 r1: the old
  // "$X/mo · $Y/yr" priceLine bypassed moneySummary's residential branch).
  // Commercial proposals rebuild their own totals line below (freshPriceLine).
  const priceLine = moneySummary(estimate);

  // Commercial proposal PDF — attached to the delivery email only when the
  // operator has authored a multi-building proposal (proposal.enabled). A
  // synthesized fallback proposal is NOT attached, so ordinary residential
  // estimate emails are unchanged. PDF failure is non-fatal: the link-based
  // email still goes out. SMS can't carry attachments (carrier MMS limits),
  // so the texted estimate link remains the SMS channel's payload.
  // The commercial proposal PDF attachment is built later, from a fresh row
  // read taken right before the email send (see the email branch below), so a
  // proposal saved during this send — the immediate-send PUT race that the
  // `sending`-status guard can't catch, since immediate sends don't claim the
  // row — is reflected in the attachment rather than a stale pre-send copy.

  const channels = {};
  // Tracks whether the formal proposal PDF actually went out as an email
  // attachment, so the public link can be channel-aware and never promise an
  // emailed PDF after an SMS-only (or email-failed) proposal send.
  let proposalPdfEmailed = false;

  // Send SMS
  if (sendMethod === 'sms' || sendMethod === 'both') {
    if (!estimate.customer_phone) {
      channels.sms = { ok: false, error: 'No phone on file' };
    } else {
      const digits = String(estimate.customer_phone).replace(/\D/g, '');
      const normalized = digits.length === 11 && digits.startsWith('1') ? `+${digits}`
        : digits.length === 10 ? `+1${digits}`
        : null;
      if (!normalized) {
        channels.sms = { ok: false, error: `Invalid phone format: ${estimate.customer_phone}` };
      } else {
        let smsDispatchStarted = false;
        try {
          const currentSmsBody = await smsTemplatesRouter.getTemplate('estimate_sent', { first_name: firstName, estimate_url: smsViewUrl }, {
            workflow: 'admin_estimate_send',
            entity_type: 'estimate',
            entity_id: estimate.id,
          }, { noVariants: !!options.reviewedMessages });
          if (!currentSmsBody) throw new Error('SMS template estimate_sent is missing or inactive');
          const smsBody = options.reviewedMessages
            ? options.reviewedMessages.sms?.split(smsTemplatesRouter.stripPortalUrlScheme(longUrl)).join(smsTemplatesRouter.stripPortalUrlScheme(smsViewUrl))
            : currentSmsBody;
          if (!smsBody) throw new Error('The reviewed text message is unavailable; nothing was sent');
          if (await estimateInvalidatedJustBeforeHandoff(estimate.id)) {
            throw new Error('invalidated_before_delivery');
          }
          smsDispatchStarted = true;
          const result = await sendCustomerMessage({
            to: normalized,
            body: smsBody,
            channel: 'sms',
            audience: estimate.customer_id ? 'customer' : 'lead',
            purpose: 'estimate_followup',
            customerId: estimate.customer_id || undefined,
            estimateId: estimate.id,
            identityTrustLevel: estimate.customer_id ? 'phone_matches_customer' : 'phone_provided_unverified',
            consentBasis: estimate.customer_id ? undefined : {
              status: 'transactional_allowed',
              source: 'admin_estimate_send',
              capturedAt: estimate.created_at || new Date().toISOString(),
            },
            entryPoint: 'admin_estimate_send',
            metadata: {
              original_message_type: 'estimate_sent',
            },
          });
          if (!result.sent) {
            channels.sms = { ok: false, uncertain: result.code === 'PROVIDER_FAILURE' && result.terminal !== true, error: result.reason || result.code || 'SMS send blocked/failed' };
            logger.error(`Estimate SMS failed: ${result.reason || result.code || 'unknown'}`);
          } else {
            // Suppression is not a provider handoff and never publishes an
            // offer or clears a promised-estimate obligation.
            const { isRealProviderSend } = require('../services/sms-auto-send');
            const real = isRealProviderSend(result);
            channels.sms = real
              ? { ok: true, real: true, status: 'provider_accepted' }
              : { ok: false, real: false, suppressed: true, error: result.reason || 'SMS suppressed; no provider handoff' };
            if (channels.sms.real) {
              if (options.leadShapeRef) options.leadShapeRef.delivered = true;
              await stampLeadHandoffWitness(estimate, options);
            }
          }
        } catch (e) {
          logger.error(`Estimate SMS failed: ${e.message}`);
          const { isRealProviderSend } = require('../services/sms-auto-send');
          if (channels.sms?.real || isRealProviderSend(e.providerOutcome)) {
            channels.sms = { ok: true, real: true, status: 'provider_accepted', warning: 'Provider accepted; some delivery bookkeeping failed.' };
            if (options.leadShapeRef) options.leadShapeRef.delivered = true;
          } else {
            const rejected = e.providerOutcome?.terminal === true || sendgrid.isDefiniteRejection({ status: e.providerOutcome?.providerHttpStatus || e.status });
            channels.sms = { ok: false, uncertain: smsDispatchStarted && !rejected, error: e.message };
          }
        }
      }
    }
  }

  await recordManualSendAttempt(estimate.id, options.manualAttempt, { channels: { ...channels } });

  // Send email through the template library when SendGrid is configured,
  // with the existing Workspace SMTP path kept only as an environment fallback.
  if (sendMethod === 'email' || sendMethod === 'both') {
    if (!estimate.customer_email) {
      channels.email = { ok: false, error: 'No email on file' };
    } else {
      let emailDispatchStarted = false;
      try {
        // Read the row fresh right before sending so the proposal state (and
        // its PDF) reflects any save that landed during this send. nextExpiresAt
        // is the validity window the link gets, so the attached PDF advertises
        // the same "valid through" date. PDF failure is non-fatal — the
        // link-based email still goes out.
        const freshEstimate = await db('estimates').where({ id: estimate.id }).first() || estimate;
        const proposalMode = normalizeProposal(freshEstimate).enabled;
        let proposalAttachments = [];
        let proposalPdfFailed = false;
        if (proposalMode) {
          try {
            // Browser document under GATE_ESTIMATE_DOC_PDF (falls back to the
            // pdfkit builder internally — this call throws only when BOTH
            // renderers fail, preserving the no-PDF-no-proposal-email rule).
            // nextExpiresAt travels as a signed display pin because the row's
            // expires_at persists later in this send flow; the pdfkit
            // fallback receives the same override on the row object.
            const { buildEstimateProposalEmailAttachmentPreferred } = require('../services/pdf/estimate-doc-pdf');
            proposalAttachments = [await buildEstimateProposalEmailAttachmentPreferred(
              freshEstimate,
              { validThrough: nextExpiresAt },
            )];
          } catch (e) {
            proposalPdfFailed = true;
            logger.error(`[admin-estimates] proposal PDF attachment failed for estimate ${estimate.id}: ${e.message}`);
          }
        }
        if (proposalPdfFailed) {
          // The proposal email + template promise an attached PDF, and the
          // public link doesn't expose it, so never send proposal copy with
          // nothing attached — fail the channel and let the operator retry.
          channels.email = { ok: false, error: 'Proposal PDF generation failed; proposal email not sent' };
        } else {
          // Render the email from the fresh row when it's a proposal, so the
          // SendGrid price summary / details match the attached PDF if totals
          // changed mid-send. The PDF was built from freshEstimate above.
          const freshPriceLine = estimateEmailPriceLine(freshEstimate);
          if (await estimateInvalidatedJustBeforeHandoff(estimate.id)) {
            throw new Error('invalidated_before_delivery');
          }
          if (options.reviewedMessages && !options.reviewedMessages.email) throw new Error('The reviewed email template was unavailable. Review a new message before sending.');
          const result = await sendEstimateEmail({
            estimate: proposalMode ? freshEstimate : estimate,
            firstName,
            viewUrl: emailViewUrl,
            priceLine: proposalMode ? freshPriceLine : priceLine,
            idempotencyKey: options.idempotencyKey || options.emailIdempotencyKey || null,
            attachments: proposalAttachments,
            proposalMode,
            versionId: options.reviewedMessages?.email?.versionId || null,
            expectedContentHash: options.reviewedMessages?.email?.contentHash || null,
            reviewedProvider: options.reviewedMessages?.email?.provider || null,
            onDispatch: () => { emailDispatchStarted = true; },
          });
          channels.email = result.ok
            ? { ok: true, provider: result.template || result.provider || 'email' }
            : { ok: false, error: result.error || 'Email send failed' };
          if (result.ok) {
            if (options.leadShapeRef) options.leadShapeRef.delivered = true;
            await stampLeadHandoffWitness(estimate, options);
          }
          if (proposalMode && result.ok && proposalAttachments.length > 0) {
            proposalPdfEmailed = true;
          }
        }
      } catch (e) {
        logger.error(`Estimate email failed: ${e.message}`);
        if (channels.email?.ok) channels.email.warning = "Provider accepted; some delivery bookkeeping failed.";
        else channels.email = { ok: false, uncertain: emailDispatchStarted && !sendgrid.isDefiniteRejection(e), error: e.message };
      }
    }
  }

  await recordManualSendAttempt(estimate.id, options.manualAttempt, { channels: { ...channels } });

  const sentChannels = requestedChannels.filter((ch) => channels[ch]?.ok);
  const failedChannels = requestedChannels.filter((ch) => !channels[ch]?.ok);
  // Channels whose delivery counts as a first response: sms only when the
  // provider send was REAL (not a suppression sentinel); email's ok already
  // implies a real handoff.
  const stampChannels = sentChannels.filter((ch) => (ch === 'sms' ? channels.sms?.real === true : true));
  // A REAL provider handoff succeeded: the customer holds the single-service
  // quote, so the send-time park must NEVER be reverted from here on — even
  // if the snapshot read or the status finalize below throws. A suppressed
  // SMS (gate/template/owner kill) reports ok with real:false and is NOT a
  // handoff, so it never sets this (GH codex P1 r1 + r2).
  // Safety net: each provider branch stamps the witness the moment it
  // succeeds (stampLeadHandoffWitness); this catches nothing new but keeps
  // the in-memory verdict aligned with the channels.
  if (options.leadShapeRef && stampChannels.length > 0) {
    await stampLeadHandoffWitness(estimate, options);
  }
  const sent = sentChannels.length > 0;

  if (!sent) {
    await releaseGroupSiblingClaims(claimedGroupSiblings);
    return {
      sent: false,
      channels,
      sentChannels,
      failedChannels,
    };
  }
  // Rollout telemetry from the FINAL delivered row — after the provider
  // handoff, after the send-time park recompute and every pre-delivery
  // check (GH codex P2 on #3750: counting earlier labelled aborted or
  // repriced attempts as fallback deliveries). Published siblings log
  // themselves below.
  shadowLogFallbackDelivery(estimate, { handoff: stampChannels.length > 0 });
  // Gate-off shadow count, GROUP-wide (GH codex P2 r30): a SERVER anchor
  // delivered beside an already-published fallback sibling hands the
  // customer that price too — the gate would refuse the send, so it counts
  // as a would-block delivery. Published siblings are never claimed, so the
  // per-sibling log below cannot see them.
  if (stampChannels.length > 0 && estimate.estimate_group_id
    && !require('../config/feature-gates').isEnabled('sendRequiresServerPricing')
    && !(await groupPassesGatedSendAuthority(db, estimate))) {
    logger.warn(`[pricing-authority] shadow: estimate ${estimate.id} delivered a group link whose visible siblings include a price without the SERVER stamp (GATE_SEND_REQUIRES_SERVER_PRICING off)`);
  }

  const updatePayload = {
    // Finalize the claim. The row is held as `sending` for the whole send (a
    // first view stamps viewed_at but does NOT leave `sending`, so the lock and
    // the PUT /:id/proposal block stay airtight), so resolve to `viewed` if the
    // customer opened the link mid-send, otherwise `sent`.
    status: db.raw("CASE WHEN viewed_at IS NOT NULL THEN 'viewed' ELSE 'sent' END"),
    sent_at: db.fn.now(),
    scheduled_at: null,
    send_method: null,
    expires_at: nextExpiresAt,
    scheduled_send_attempts: 0,
    last_send_error: null,
    updated_at: db.fn.now(),
  };
  // firstDeliveredAt: the FIRST real handoff, durable across resends and
  // suppressed later attempts (GitHub #3391 round). Each send replaces the
  // deliveryState key wholesale, so without carrying it forward a later
  // suppressed-SMS attempt would erase the real-delivery witness, and
  // sent_at (overwritten per resend) would inflate first-handoff latency.
  // Stamped only when stampChannels is non-empty — the same real-vs-
  // suppression-sentinel line drawn above — and consumed by the
  // click-mint delivery predicates (source-performance + watchers).
  const priorDeliveryState = (() => {
    try {
      const data = typeof estimate.estimate_data === 'string'
        ? JSON.parse(estimate.estimate_data)
        : estimate.estimate_data;
      return data?.deliveryState || null;
    } catch { return null; }
  })();
  const firstDeliveredAt = priorDeliveryState?.firstDeliveredAt
    || (stampChannels.length ? now().toISOString() : null);
  // lastDeliveredAt advances on every REAL handoff and is carried forward
  // (never dropped) by suppressed later attempts — the watcher predicates
  // compare it against their call/task boundary, because pairing mutable
  // sent_at with the mere existence of firstDeliveredAt let a pre-promise
  // delivery plus a later suppressed attempt falsely keep the promise
  // (uncapped audit on 573ee332e).
  const lastDeliveredAt = stampChannels.length
    ? now().toISOString()
    : (priorDeliveryState?.lastDeliveredAt || null);
  // deliveredAt: EVERY real handoff, oldest first, capped — the durable
  // send history. first/last alone lose the middle: an estimate delivered
  // before a call, resent inside its fulfillment window and resent again
  // after it would carry no in-window witness, and the commitment's
  // association hint would clear on refresh (codex #3811 r30 P2). Carried
  // forward untouched by suppressed attempts.
  const priorDeliveredAt = Array.isArray(priorDeliveryState?.deliveredAt) ? priorDeliveryState.deliveredAt.filter((t) => typeof t === 'string') : [];
  const deliveredAt = (stampChannels.length ? [...priorDeliveredAt, lastDeliveredAt] : priorDeliveredAt).slice(-DELIVERY_HISTORY_MAX);
  const deliveryStatePatch = {
    deliveryState: {
      attemptedAt: now().toISOString(),
      sentChannels,
      failedChannels,
      channels,
      ...(firstDeliveredAt ? { firstDeliveredAt } : {}),
      ...(lastDeliveredAt ? { lastDeliveredAt } : {}),
      ...(deliveredAt.length ? { deliveredAt } : {}),
    },
    // The per-park handoff witness rides the finalization write too, so a
    // transient failure of the in-branch stamp can never leave a delivered
    // park looking undelivered once finalization lands (pre-push codex P1).
    ...(options.leadShapeRef?.parkedKey && stampChannels.length
      ? {
        leadServiceHandoffAt: (lastDeliveredAt || firstDeliveredAt || now().toISOString()),
        leadServiceHandoffParkId: String(options.leadShapeRef.parkId || ''),
      }
      : {}),
  };
  // Delivery outcomes must survive even if snapshot construction fails;
  // partial-send retry state is operational data, not part of pricing QA.
  updatePayload.estimate_data = db.raw(
    "COALESCE(estimate_data, '{}'::jsonb) || ?::jsonb",
    [JSON.stringify(deliveryStatePatch)],
  );
  // Persist only the send-time pricing snapshot, merged into estimate_data via
  // a jsonb || merge rather than a full overwrite, so it replaces just the
  // `sendSnapshot` (+ proposalDelivery) keys and preserves any concurrently
  // saved top-level keys (proposal/etc.). Totals live in columns and are
  // intentionally left untouched here.
  const freshForSnapshot = await db('estimates').where({ id: estimate.id }).first() || estimate;
  const proposalEnabledForDelivery = normalizeProposal(freshForSnapshot).enabled;
  // Hoisted so the superseded-send branch can graft the rendered bundle
  // into ITS audit snapshot too (GH codex P2 on #3628).
  let builtSendSnapshot = null;
  try {
    const snapshot = await buildEstimateSendSnapshot({ ...freshForSnapshot, expires_at: nextExpiresAt }, now, { delivered: stampChannels.length > 0, deliveredAt: lastDeliveredAt });
    // Only a VALIDATED bundle feeds the audit — same rule as the sibling
    // and superseded branches (codex pre-push P1).
    builtSendSnapshot = snapshot.sendSnapshot && !snapshot.sendSnapshot.pricingBundleError
      ? snapshot.sendSnapshot
      : null;
    // Merge only the keys we own (sendSnapshot, and proposalDelivery for an
    // authored proposal) so a proposal save committing mid-send isn't clobbered
    // by a full estimate_data write. proposalDelivery is a sibling of proposal,
    // never a nested write, so the `||` merge can't drop the proposal itself.
    const mergePatch = {
      sendSnapshot: snapshot.sendSnapshot || {},
      ...deliveryStatePatch,
    };
    if (proposalEnabledForDelivery) {
      mergePatch.proposalDelivery = {
        stampedAt: now().toISOString(),
        pdfEmailed: proposalPdfEmailed,
        channels: sentChannels,
      };
    }
    updatePayload.estimate_data = db.raw(
      "COALESCE(estimate_data, '{}'::jsonb) || ?::jsonb",
      [JSON.stringify(mergePatch)],
    );
  } catch (e) {
    logger.warn(`[admin-estimates] estimate_data snapshot update failed for estimate ${estimate.id}: ${e.message}`);
  }
  // Finalize only while we still hold the `sending` claim. A customer can accept
  // while the SMS/email/PDF work is in flight (the public accept path price-locks
  // + creates invoice/conversion and moves the row off `sending`); scoping the
  // write to status='sending' leaves that accepted, money-bearing state intact.
  // A first view does NOT leave `sending` (it only stamps viewed_at), so the
  // normal send still finalizes here. When the claim is lost, a terminal state
  // won — leave it and skip the `sent` downstream effects (which would regress a
  // won lead back to sent). price_locked_at is belt-and-suspenders.
  const sentCount = await db('estimates')
    .where({ id: estimate.id, status: 'sending' })
    .whereNull('price_locked_at')
    // A clarify hold stamped after the pre-handoff check (a reply lands on
    // the 'sending' row by design) must not finalize the whole-building
    // quote as 'sent' — the delivered link would render it (codex r3 P1 on
    // #3804); the row parks as send_failed instead, like the pre-handoff
    // verdict, and the operator re-drafts and re-sends.
    .whereRaw(REPRICE_PENDING_ABSENT_SQL)
    .update(updatePayload);
  if (!sentCount) {
    const heldNow = await db('estimates').where({ id: estimate.id }).first('status', 'price_locked_at', 'estimate_data');
    if (heldNow && String(heldNow.status) === 'sending' && !heldNow.price_locked_at && siblingRepricePending(heldNow)) {
      await db('estimates')
        .where({ id: estimate.id, status: 'sending' })
        .update({ status: 'send_failed', last_send_error: 'reprice_pending', scheduled_at: null, updated_at: db.fn.now() });
      logger.warn(`[admin-estimates] estimate ${estimate.id} was held for a re-price while its send was in flight — parked as send_failed, not published.`);
      await releaseGroupSiblingClaims(claimedGroupSiblings);
      const held = new Error("This estimate was held for a re-price (the customer's clarify answer replaces its dollars or address) while the send was in flight. The message went out, but the link will not render until it is re-drafted and re-sent.");
      held.statusCode = 409;
      throw held;
    }
    logger.warn(`[admin-estimates] estimate ${estimate.id} left the 'sending' claim during send (likely accepted/declined concurrently); preserving its current state.`);
    // The channels DID deliver — a customer accepting mid-flight is exactly
    // the outcome the learning loop must not lose, so the first-send event
    // still stamps on this path (idempotent via the ledger's unique
    // constraint). Fail-soft: never turns a delivered send into an error.
    try {
      const { recordSentLearningEvent } = require('../services/estimate-learning');
      await recordSentLearningEvent({ estimateId: estimate.id, sentRow: preParkEstimate });
    } catch (e) {
      logger.warn(`[admin-estimates] learning event failed for estimate ${estimate.id}: ${e.message}`);
    }
    // The delivery WITNESS must survive losing the claim (GitHub #3391
    // round P1): when a customer accepts mid-flight, the guarded update
    // above misses and deliveryState would never persist — the click-mint
    // delivery predicates (source-performance + both watchers) would then
    // classify a genuinely delivered estimate as unsent forever. Merge
    // ONLY the deliveryState key into the accepted/declined row — never
    // status, sent_at, or expiry, which are exactly what must not be
    // regressed here. Real deliveries only; a suppressed attempt leaves
    // the terminal row untouched. Fail-soft like every branch below.
    // The scope THIS send delivered rides along — built from the
    // PRE-DELIVERY claimed row (the accept handler rewrites result /
    // totals) and merged UNDER sendSnapshot, never replacing the bundle
    // the accepted row now carries — or the triage sweep, which reads the
    // witness and the stamp together, could never close a quote_promised
    // card on an estimate accepted mid-flight (pre-push hook P1 on
    // 1b4240350).
    if (stampChannels.length) {
      try {
        const scope = deliveredEstimateScope({ ...estimate, ...(await pricedPropertyAddress(estimate.property_id)) });
        const revision = scopeRevision(parseEstimateData(estimate.estimate_data)?.sendSnapshot, scope, lastDeliveredAt || now().toISOString());
        await db('estimates').where({ id: estimate.id }).update({
          estimate_data: db.raw(
            "jsonb_set(COALESCE(estimate_data, '{}'::jsonb) || ?::jsonb, '{sendSnapshot}', COALESCE(estimate_data -> 'sendSnapshot', '{}'::jsonb) || ?::jsonb, true)",
            [JSON.stringify(deliveryStatePatch), JSON.stringify(revision)],
          ),
          updated_at: db.fn.now(),
        });
      } catch (e) {
        logger.warn(`[admin-estimates] superseded-send deliveryState merge failed for estimate ${estimate.id}: ${e.message}`);
      }
    }
    // The channels DID reach the customer even though the row moved on —
    // other same-contact open leads were still answered by this send. Loose
    // SLA stamp only (never status/linkage — the accepted/declined state is
    // exactly what must not be regressed here). Fail-soft.
    if (stampChannels.length) {
      try {
        const { stampFirstResponseByContact } = require('../services/lead-estimate-link');
        await stampFirstResponseByContact({
          phone: stampChannels.includes('sms') ? estimate.customer_phone : null,
          email: stampChannels.includes('email') ? estimate.customer_email : null,
        });
      } catch (e) {
        logger.warn(`[admin-estimates] superseded-send first-response stamp failed: ${e.message}`);
      }
    }
    // The customer SAW this quote (channels delivered) even though the row
    // moved on — the accepted/declined anchor still gets its send-time
    // pricing snapshot, with the rendered bundle grafted in for the audit
    // only when the terminal row lacks one (GH codex P2; same rule as the
    // accepted-mid-publication sibling). Fail-soft.
    try {
      const { saveEstimatePricingAuditSnapshot } = require('../services/estimate-pricing-audit');
      // Build from the PRE-DELIVERY claimed row (`estimate` — read before
      // the provider handoff): the accept handler rewrites
      // estimate_data.result/totals, and even freshForSnapshot is read
      // after channels delivered, so it can already carry the accepted
      // state (GH codex P1 x2). THIS delivery's freshly built bundle
      // outranks any stale sendSnapshot a prior send left behind.
      let preAcceptData = estimate.estimate_data;
      if (typeof preAcceptData === 'string') { try { preAcceptData = JSON.parse(preAcceptData); } catch { preAcceptData = {}; } }
      preAcceptData = preAcceptData || {};
      // ONLY a bundle rebuilt from the PRE-DELIVERY claimed row is
      // send-time truth — builtSendSnapshot came from freshForSnapshot,
      // which post-dates delivery and can carry the acceptance rewrite,
      // and a prior send's stored sendSnapshot is equally stale. When the
      // rebuild fails, the audit goes out with NO bundle rather than a
      // wrong one (codex pre-push P1).
      let raceBundle = null;
      try {
        const rebuilt = await buildEstimateSendSnapshot({ ...estimate, expires_at: nextExpiresAt }, now);
        if (rebuilt?.sendSnapshot && !rebuilt.sendSnapshot.pricingBundleError) raceBundle = rebuilt.sendSnapshot;
      } catch { /* no validated pre-delivery bundle */ }
      const { sendSnapshot: stalePriorSnapshot, ...preAcceptSansSnapshot } = preAcceptData;
      void stalePriorSnapshot;
      const auditRow = {
        ...estimate,
        status: estimate.viewed_at ? 'viewed' : 'sent',
        estimate_data: raceBundle
          ? { ...preAcceptSansSnapshot, sendSnapshot: raceBundle }
          : preAcceptSansSnapshot,
      };
      await saveEstimatePricingAuditSnapshot(auditRow, { trigger: 'send', sendMethod });
    } catch (auditErr) {
      logger.warn(`[admin-estimates] superseded-send pricing audit snapshot failed (state stands): ${auditErr.message}`);
    }
    // Superseded anchor: a concurrent accept/decline won the anchor row while
    // channels were in flight. Hand claimed siblings back rather than publish
    // a group whose anchor is no longer in a sent state — the operator can
    // re-send from a sibling if the group should still go out.
    await releaseGroupSiblingClaims(claimedGroupSiblings);
    return {
      sent: true,
      superseded: true,
      partialFailure: failedChannels.length > 0,
      channels,
      sentChannels,
      failedChannels,
    };
  }

  // Multi-property group publication: sending the anchor publishes its sibling
  // estimates too — the customer's ONE link renders every property, and each
  // sibling's own token must be acceptable, which requires sent status. Expiry
  // aligns to this send. Follow-up state is PRE-BURNED (booleans true, and the
  // engagement sweeps key on the same flags): the customer got one message for
  // the whole group, so only the anchor may ever drive follow-up comms —
  // sibling rows must never re-message the same person about the same link.
  // Publishes ONLY the rows this send claimed pre-delivery (validated
  // sendable + moved to 'sending' by claimGroupSiblingsForPublish) — a row
  // that lost the claim, or was accepted mid-flight, keeps its own state.
  // Per-sibling, each publication freezes the sibling's own send snapshot
  // (codex #3244 r2: without it the sibling link reprices live, so a pricing
  // change after the group message could alter what the customer accepts).
  // A failed publication retries; a sibling that still can't publish is
  // RELEASED back to its prior state (visible as unsent, operator re-sends)
  // rather than left dangling in 'sending' for the stale-claim sweep to
  // mislabel — and the failure is surfaced on the send result instead of
  // silently reporting a fully-published group.
  let groupPublicationFailures = 0;
  if (estimate.estimate_group_id && claimedGroupSiblings.length) {
    for (const sibling of claimedGroupSiblings) {
      let published = false;
      for (let attempt = 1; attempt <= 3 && !published; attempt += 1) {
        try {
          let siblingSnapshotPatch = { groupPublishedByEstimateId: estimate.id };
          // A snapshot whose pricing bundle failed is NOT a freeze — the
          // public page would fall back to live repricing, exactly what the
          // snapshot exists to prevent (codex #3244 r7). Treat it like any
          // other publication failure: throw into the retry loop; after the
          // final attempt the sibling is released for an operator re-send.
          // A sibling is delivered by the anchor's handoff — the same
          // real-channel test decides whether its scope stamp moves.
          const snapshot = await buildEstimateSendSnapshot({ ...sibling, expires_at: nextExpiresAt }, now, { delivered: stampChannels.length > 0, deliveredAt: lastDeliveredAt });
          if (!snapshot?.sendSnapshot || snapshot.sendSnapshot.pricingBundleError) {
            throw new Error(`sibling send snapshot did not freeze pricing${snapshot?.sendSnapshot?.pricingBundleError ? `: ${snapshot.sendSnapshot.pricingBundleError}` : ''}`);
          }
          siblingSnapshotPatch = { ...siblingSnapshotPatch, sendSnapshot: snapshot.sendSnapshot };
          const updated = await db('estimates')
            .where({ id: sibling.id, status: 'sending' })
            .whereNull('price_locked_at')
            // A hold stamped after the claim (a clarify reply lands on a
            // 'sending' row by design) fails the publication; the sibling
            // is released for the operator (codex r1 P1 on #3804).
            .whereRaw(REPRICE_PENDING_ABSENT_SQL)
            .update({
              // A customer can open the anchor link instantly and view this
              // sibling while it's still under the pre-delivery claim — the
              // view stamps viewed_at without touching 'sending'. Same
              // viewed-aware finalization as the anchor (codex #3244 r3).
              status: db.raw("CASE WHEN viewed_at IS NOT NULL THEN 'viewed' ELSE 'sent' END"),
              sent_at: db.fn.now(),
              expires_at: nextExpiresAt,
              scheduled_at: null,
              send_method: null,
              followup_unviewed_sent: true,
              followup_viewed_sent: true,
              followup_final_sent: true,
              followup_expiring_sent: true,
              estimate_data: db.raw(
                "COALESCE(estimate_data, '{}'::jsonb) || ?::jsonb",
                [JSON.stringify(siblingSnapshotPatch)],
              ),
              updated_at: db.fn.now(),
            });
          if (!updated) {
            // Zero rows is EITHER a mid-publication acceptance (price-locked,
            // handled below) OR a clarify hold stamped after the claim — a
            // still-'sending', unlocked, held row must not be reported as
            // published and left customer-viewable behind the anchor link
            // (codex r2 P1 on #3804): throw into the retry loop, whose final
            // attempt releases the sibling for the operator.
            const fresh = await db('estimates').where({ id: sibling.id }).first('status', 'price_locked_at', 'estimate_data');
            if (fresh && String(fresh.status) === 'sending' && !fresh.price_locked_at && siblingRepricePending(fresh)) {
              throw new Error('sibling is held for a re-price (a clarify answer replaces its dollars or address) — not published');
            }
          }
          published = true;
          // A sibling is a delivered row of its own after the confirmed
          // handoff — same telemetry as the anchor (a fallback sibling
          // behind a SERVER anchor was invisible before; GH codex P2 on
          // #3750) — on BOTH paths below: a sibling accepted mid-publication
          // (guarded update zero-rowed by price_locked_at) was exposed just
          // the same (GH codex P2 r3).
          shadowLogFallbackDelivery(sibling, { handoff: stampChannels.length > 0 });
          if (!updated) {
            await recordTerminalSiblingDelivery(sibling, snapshot, { delivered: stampChannels.length > 0, sendMethod, deliveryStatePatch });
          } else {
            await snapshotPublishedSibling(sibling, siblingSnapshotPatch, { now, nextExpiresAt, sendMethod });
          }
        } catch (e) {
          logger.error(`[admin-estimates] sibling ${sibling.id} publication attempt ${attempt} failed: ${e.message}`);
          if (attempt === 3) {
            groupPublicationFailures += 1;
            await releaseGroupSiblingClaims([sibling]);
          }
        }
      }
    }
    const publishedCount = claimedGroupSiblings.length - groupPublicationFailures;
    logger.info(`[admin-estimates] group ${estimate.estimate_group_id}: published ${publishedCount}/${claimedGroupSiblings.length} sibling estimate(s) with anchor ${estimate.id}${groupPublicationFailures ? ` (${groupPublicationFailures} released for re-send)` : ''}`);
  }
  // A sibling that was ALREADY sent/viewed before joining the group (operator
  // added a property to a live estimate) is public with its OWN expiry and
  // follow-up state (codex #3244 r4): left alone it keeps sending its own
  // reminders alongside the group's anchor and drops off the combined link
  // when its earlier expiry hits. Reconcile without any channel delivery:
  // align expiry forward-only and pre-burn the follow-up flags — the group's
  // anchor owns all further comms. Status/snapshot untouched (their original
  // send froze them).
  if (estimate.estimate_group_id) {
    const liveSiblings = () => db('estimates')
      .where({ estimate_group_id: estimate.estimate_group_id })
      .whereNot({ id: estimate.id })
      .whereIn('status', ['sent', 'viewed'])
      .whereNull('archived_at')
      .whereNull('price_locked_at');
    try {
      await liveSiblings()
        .update({
          // Forward-only expiry inside the SET (not the WHERE): a sibling
          // already extended past this send still needs its reminder flags
          // burned — the anchor owns all group comms (codex #3244 r5).
          expires_at: db.raw('GREATEST(COALESCE(expires_at, ?::timestamptz), ?::timestamptz)', [nextExpiresAt, nextExpiresAt]),
          followup_unviewed_sent: true,
          followup_viewed_sent: true,
          followup_final_sent: true,
          followup_expiring_sent: true,
          estimate_data: db.raw(
            "COALESCE(estimate_data, '{}'::jsonb) || ?::jsonb",
            [JSON.stringify({ groupPublishedByEstimateId: estimate.id })],
          ),
          updated_at: db.fn.now(),
        });
    } catch (e) {
      logger.warn(`[admin-estimates] live-sibling group reconciliation failed for estimate ${estimate.id}: ${e.message}`);
    }
    // The combined link this REAL handoff delivered carries each live
    // sibling's frozen scope too, so that scope joins its history at the
    // GROUP handoff instant: the triage sweep pairs a cited revision only
    // with sibling revisions of the same instant, and a sibling stamped
    // only at its own earlier send would drop out of a genuinely complete
    // group quote (codex #3811 r34 P2). ONE statement, reading the row's
    // snapshot as it is at write time — a customer's bond / interior /
    // service-mix selection landing on the sibling between a read and a
    // write deliberately drops pricingBundle / tierDiscounts, and a
    // rebuilt snapshot would restore the pre-selection pricing (r35 P1).
    // Only the history key is set; scope and pricing are never touched.
    // Same cap as scopeRevision; a non-array history is replaced.
    if (stampChannels.length > 0) {
      try {
        const history = "CASE WHEN jsonb_typeof(estimate_data->'sendSnapshot'->'scopeHistory') = 'array' THEN estimate_data->'sendSnapshot'->'scopeHistory' ELSE '[]'::jsonb END";
        const appended = `(${history} || jsonb_build_array(jsonb_build_object('deliveredAt', ?::text, 'scope', estimate_data->'sendSnapshot'->'scope')))`;
        await liveSiblings()
          .whereRaw("jsonb_typeof(estimate_data->'sendSnapshot'->'scope'->'lines') = 'array'")
          .update({
            estimate_data: db.raw(
              `jsonb_set(estimate_data, '{sendSnapshot,scopeHistory}', (SELECT COALESCE(jsonb_agg(e ORDER BY ord), '[]'::jsonb) FROM jsonb_array_elements(${appended}) WITH ORDINALITY AS h(e, ord) WHERE ord > jsonb_array_length(${appended}) - ?), true)`,
              [lastDeliveredAt, lastDeliveredAt, DELIVERY_HISTORY_MAX],
            ),
          });
      } catch (e) {
        logger.warn(`[admin-estimates] live-sibling scope stamp failed for estimate ${estimate.id}: ${e.message}`);
      }
    }
  }

  try {
    // stampChannels: only channels that actually delivered a REAL send gate
    // the loose first-response stamp (partial 'both' sends are permitted
    // above; sentinel-suppressed sms legs are excluded).
    await markLinkedLeadEstimateSent({ estimateId: estimate.id, sendMethod, sentChannels: stampChannels });
  } catch (e) {
    logger.warn(`[admin-estimates] linked lead status update failed for estimate ${estimate.id}: ${e.message}`);
  }

  try {
    // The audit basis must be UNCONTAMINATED by acceptance yet include a
    // proposal save that legitimately committed mid-send (GH codex P1 both
    // ways): freshForSnapshot — the same row the delivery itself rendered
    // from — is the basis UNLESS acceptance already rewrote it, in which
    // case the pre-delivery claimed row is; this delivery's built bundle
    // is grafted either way, and status/sent_at/expiry reflect the
    // published values.
    const acceptedMidSend = !!freshForSnapshot.accepted_at
      || freshForSnapshot.status === 'accepted'
      || !!freshForSnapshot.price_locked_at;
    const basisRow = acceptedMidSend ? estimate : freshForSnapshot;
    let basisData = basisRow.estimate_data;
    if (typeof basisData === 'string') { try { basisData = JSON.parse(basisData); } catch { basisData = {}; } }
    const auditAnchor = {
      ...basisRow,
      status: basisRow.viewed_at ? 'viewed' : 'sent',
      sent_at: now,
      expires_at: nextExpiresAt,
      // No validated bundle ⇒ no sendSnapshot at all in the anchor: a
      // prior send's frozen pricing must not be recorded as this send's
      // customer-shown truth (codex pre-push P1).
      estimate_data: builtSendSnapshot
        ? { ...(basisData || {}), sendSnapshot: builtSendSnapshot }
        : (() => { const { sendSnapshot: _stale, ...rest } = basisData || {}; return rest; })(),
    };
    await saveEstimatePricingAuditSnapshot(auditAnchor, {
      trigger: 'send',
      sendMethod,
    });
  } catch (e) {
    logger.warn(`[admin-estimates] pricing audit snapshot failed for estimate ${estimate.id}: ${e.message}`);
  }

  // Learning loop: stamp the draft→sent edit-distance event for AI-composed
  // drafts (first send only; the ledger's unique constraint makes resends
  // no-ops). The claimed snapshot — not a re-read — feeds the diff so a
  // customer accepting right after delivery can't have their own choices
  // counted as operator edits. Fail-soft — never blocks the send result.
  try {
    const { recordSentLearningEvent } = require('../services/estimate-learning');
    await recordSentLearningEvent({ estimateId: estimate.id, sentRow: estimate });
  } catch (e) {
    logger.warn(`[admin-estimates] learning event failed for estimate ${estimate.id}: ${e.message}`);
  }

  // Fire-and-forget: enroll the customer in the estimate_sent follow-up
  // automation (lands ~2h later with a neighborly "any questions?" note).
  // Enrollment is deduped by customer id when present, otherwise by lead
  // email, so re-sends of the same lead estimate won't spam.
  if (estimate.customer_email) {
    try {
      const AutomationRunner = require('../services/automation-runner');
      const parts = (estimate.customer_name || '').trim().split(/\s+/);
      await AutomationRunner.enrollCustomer({
        templateKey: 'estimate_sent',
        customer: {
          id: estimate.customer_id || null,
          email: estimate.customer_email,
          first_name: parts[0] || '',
          last_name: parts.slice(1).join(' ') || '',
        },
      });
    } catch (e) {
      logger.warn(`[admin-estimates] estimate_sent enroll failed: ${e.message}`);
    }
  }

  return {
    sent: true,
    partialFailure: failedChannels.length > 0,
    ...(groupPublicationFailures > 0 ? { groupPublicationFailures } : {}),
    channels,
    sentChannels,
    failedChannels,
  };
}

// Export for cron usage
router.sendEstimateNow = sendEstimateNow;

// GET /api/admin/estimates/lead-auto-send/preview — read-only dry-run audit.
router.get('/lead-auto-send/preview', async (req, res, next) => {
  try {
    const config = leadEstimateAutoSendConfigFromEnv({
      ...process.env,
      LEAD_ESTIMATE_AUTO_SEND_DELAY_MINUTES:
        req.query.delayMinutes || req.query.delay_minutes || process.env.LEAD_ESTIMATE_AUTO_SEND_DELAY_MINUTES,
      LEAD_ESTIMATE_AUTO_SEND_LIMIT:
        req.query.limit || process.env.LEAD_ESTIMATE_AUTO_SEND_LIMIT,
      LEAD_ESTIMATE_AUTO_SEND_STALE_CLAIM_MINUTES:
        req.query.staleClaimMinutes || req.query.stale_claim_minutes || process.env.LEAD_ESTIMATE_AUTO_SEND_STALE_CLAIM_MINUTES,
      LEAD_ESTIMATE_AUTO_SEND_ALLOWED_REVIEW_REASONS:
        req.query.allowedReviewReasons || req.query.allowed_review_reasons || process.env.LEAD_ESTIMATE_AUTO_SEND_ALLOWED_REVIEW_REASONS,
      LEAD_ESTIMATE_AUTO_SEND_METHOD:
        req.query.sendMethod || req.query.send_method || process.env.LEAD_ESTIMATE_AUTO_SEND_METHOD,
    });
    const audit = await previewLeadEstimateAutoSendAudit({
      config,
      limit: config.limit,
    });
    res.json({ success: true, dryRun: true, ...audit });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/estimates/actuals-variance — estimate-vs-actuals systematic
// bias per service line (sample sizes + average deltas; positive = actuals
// ran OVER the estimate). Ledger written nightly by the estimate-actuals cron.
router.get('/actuals-variance', async (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(7, parseInt(req.query.days, 10) || 90));
    const { varianceSummary } = require('../services/estimate-actuals');
    const serviceLines = await varianceSummary({ days });
    res.json({ success: true, days, serviceLines });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/estimates/win-loss-slices — resolved-only win/loss rates
// sliced by the property-lookup profile's fieldVerifyFlags (clean vs
// flagged, per flag field, per priority) and by price band, plus the
// recurring-band × flag cross, plus (estimator audit 2026-08-29) loss
// dispositions, service-line / lead-source / WaveGuard-tier win rates and
// the sent-cohort funnel. Won = accepted; lost = declined/expired — same
// semantics as the client's PipelineAnalytics. Read-only analytics.
router.get('/win-loss-slices', async (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(7, parseInt(req.query.days, 10) || 90));
    const { winLossSlices } = require('../services/estimate-winloss');
    const slices = await winLossSlices({ days });
    res.json({ success: true, ...slices });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/estimates/source-performance — drafted→sent funnel, close
// rate, send latency, and AI-draft edit stats per estimate source (learning
// loop). Won/lost mirror win-loss-slices semantics; edit stats read the
// estimate_learning_events ledger. Read-only analytics.
router.get('/source-performance', async (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(7, parseInt(req.query.days, 10) || 90));
    const { sourcePerformance } = require('../services/estimate-source-performance');
    const report = await sourcePerformance({ days });
    res.json({ success: true, ...report });
  } catch (err) {
    next(err);
  }
});

// Free-text filter for the estimates list. EVERY column here is
// table-qualified on purpose: the list query leftJoins `technicians`, and
// that table grew its own `address` column in the payroll-profile migration
// (20260428000007_technicians_payroll_profile). An unqualified `address`
// therefore compiles to a Postgres "column reference \"address\" is
// ambiguous" error, and every admin estimate search — by name, phone, or
// address alike — 500'd instead of returning rows. Qualify anything added
// here, even when the column is unique on `estimates` today.
function applyEstimateSearchFilter(query, search) {
  const s = `%${search}%`;
  return query.where(function () {
    this.whereILike('estimates.customer_name', s)
      .orWhereILike('estimates.customer_phone', s)
      .orWhereILike('estimates.address', s);
  });
}

// GET /api/admin/estimates — list
router.get('/', async (req, res, next) => {
  try {
    const { status, search, source, page = 1, limit = 50, archived: archivedRaw } = req.query;
    const includePricingRisk = ['1', 'true', 'yes'].includes(String(req.query.pricingRisk || '').toLowerCase());
    const sentOnly = ['1', 'true', 'yes'].includes(String(req.query.sentOnly || req.query.sent_only || '').toLowerCase());
    // archived=only → archived-only view. archived=all → include both.
    // Default (unset / any other value) → hide archived.
    const archived = archivedRaw === 'only' || archivedRaw === '1' || archivedRaw === 'true'
      ? 'only'
      : archivedRaw === 'all'
      ? 'all'
      : 'hide';

    let query = db('estimates')
      .leftJoin('technicians', 'estimates.created_by_technician_id', 'technicians.id')
      .select('estimates.*', 'technicians.name as created_by_name')
      .orderBy('estimates.created_at', 'desc');

    if (status) query = query.where('estimates.status', status);
    if (sentOnly) {
      query = query.where(function () {
        this.whereNotNull('estimates.sent_at')
          .orWhereIn('estimates.status', SENT_ONLY_DELIVERY_ATTEMPT_STATUSES);
      });
    }
    if (source) {
      const sources = source.split(',');
      query = query.whereIn('estimates.source', sources);
    }
    if (search) query = applyEstimateSearchFilter(query, search);
    if (archived === 'only') query = query.whereNotNull('estimates.archived_at');
    else if (archived !== 'all') query = query.whereNull('estimates.archived_at');

    let estimates;
    if (limit === 'all') {
      estimates = await query.limit(ESTIMATE_LIST_LIMIT);
    } else {
      const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
      const pg = Math.max(parseInt(page, 10) || 1, 1);
      const offset = (pg - 1) * lim;
      estimates = await query.limit(lim).offset(offset);
    }

    // Aggregate shortlink click telemetry per estimate. One estimate can
    // accumulate multiple short_codes rows when /send is hit again (re-send
    // / follow-up flows), so SUM the click counts and MAX the last-clicked
    // timestamp. Bot UAs are filtered upstream in public-shortlinks so the
    // numbers reflect real customer taps.
    const ids = estimates.map((e) => e.id);
    let clickStats = new Map();
    if (ids.length) {
      const rows = await db('short_codes')
        .where({ entity_type: 'estimates' })
        .whereIn('entity_id', ids)
        .groupBy('entity_id')
        .select('entity_id')
        .sum({ click_count: 'click_count' })
        .max({ last_clicked_at: 'last_clicked_at' });
      clickStats = new Map(rows.map((r) => [r.entity_id, r]));
    }

    let outlineByEstimateId = new Map();
    if (ids.length) {
      try {
        const outlineRows = await db('service_outline_packets')
          .whereIn('estimate_id', ids)
          .orderBy('created_at', 'desc')
          .select(
            'id',
            'estimate_id',
            'status',
            'validation_status',
            'turf_type',
            'sent_at',
            'first_viewed_at',
            'last_viewed_at',
            'view_count',
            'revoked_at',
            'expires_at',
            'created_at',
            'summary_json',
            'content_json',
            'content_library_version',
            'protocol_version',
            'product_registry_version',
            'template_version',
          );
        const outlineIds = outlineRows.map((row) => row.id).filter(Boolean);
        let outlineEventStats = new Map();
        if (outlineIds.length) {
          const eventRows = await db('service_outline_events')
            .whereIn('packet_id', outlineIds)
            .whereIn('event_type', ['cta_clicked'])
            .groupBy('packet_id')
            .select('packet_id')
            .count({ cta_click_count: '*' })
            .max({ last_cta_clicked_at: 'created_at' });
          outlineEventStats = new Map(eventRows.map((row) => [row.packet_id, row]));
        }
        for (const row of outlineRows) {
          if (!row.estimate_id || outlineByEstimateId.has(row.estimate_id)) continue;
          const stats = outlineEventStats.get(row.id) || {};
          const staleReasons = [
            row.content_library_version !== CONTENT_LIBRARY_VERSION ? 'content library updated' : null,
            row.protocol_version !== PROTOCOL_VERSION ? 'protocol updated' : null,
            row.product_registry_version !== PRODUCT_REGISTRY_VERSION ? 'product facts updated' : null,
            row.template_version !== TEMPLATE_VERSION ? 'template updated' : null,
          ].filter(Boolean);
          outlineByEstimateId.set(row.estimate_id, {
            id: row.id,
            status: row.status,
            validationStatus: row.validation_status,
            turfType: row.turf_type,
            sentAt: row.sent_at,
            firstViewedAt: row.first_viewed_at,
            lastViewedAt: row.last_viewed_at,
            viewCount: row.view_count || 0,
            revokedAt: row.revoked_at,
            expiresAt: row.expires_at,
            createdAt: row.created_at,
            ctaClickCount: Number(stats.cta_click_count || 0),
            lastCtaClickedAt: stats.last_cta_clicked_at || null,
            productCardCount: Number(row.summary_json?.productCardCount || row.content_json?.productCards?.length || 0),
            contentLibraryVersion: row.content_library_version,
            protocolVersion: row.protocol_version,
            productRegistryVersion: row.product_registry_version,
            templateVersion: row.template_version,
            currentContentLibraryVersion: CONTENT_LIBRARY_VERSION,
            currentProtocolVersion: PROTOCOL_VERSION,
            currentProductRegistryVersion: PRODUCT_REGISTRY_VERSION,
            currentTemplateVersion: TEMPLATE_VERSION,
            stale: staleReasons.length > 0,
            staleReasons,
          });
        }
      } catch (err) {
        logger.warn(`[admin-estimates] service outline summary unavailable: ${err.message}`);
      }
    }

    // Cross-reference confirmed appointments so the UI can flag estimates
    // whose customer is already on the schedule. Two paths in priority order:
    //   1) Linked: call-recording-processor stitches the scheduled_services.id
    //      it just created into estimate.estimate_data.scheduled_service_id
    //      when the same call produced both. That's an exact match.
    //   2) Fallback: the customer simply has *some* upcoming confirmed
    //      service. Less precise (e.g. an unrelated quarterly visit), but
    //      still a useful signal — flagged with linked:false so the UI can
    //      soften the wording.
    const customerIdsForAppt = [...new Set(estimates.map((e) => e.customer_id).filter(Boolean))];
    const linkedSvcIds = new Set();
    for (const e of estimates) {
      let data = e.estimate_data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
      if (data?.scheduled_service_id) linkedSvcIds.add(data.scheduled_service_id);
    }
    const apptByLinkedId = new Map();
    const apptBySourceEstimateId = new Map();
    const nextApptByCustomer = new Map();
    if (customerIdsForAppt.length || linkedSvcIds.size || ids.length) {
      // Compare scheduled_date (YYYY-MM-DD in ET) against today in ET so a
      // late-night UTC server doesn't show today's appointment as past.
      const todayET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
      const apptRows = await db('scheduled_services')
        .where('status', 'confirmed')
        .where('scheduled_date', '>=', todayET)
        .where(function () {
          if (customerIdsForAppt.length) this.whereIn('customer_id', customerIdsForAppt);
          if (linkedSvcIds.size) this.orWhereIn('id', [...linkedSvcIds]);
          if (ids.length) this.orWhereIn('source_estimate_id', ids);
        })
        .orderBy('scheduled_date', 'asc')
        .orderBy('window_start', 'asc')
        .select('id', 'customer_id', 'source_estimate_id', 'scheduled_date', 'window_start', 'window_display', 'service_type');
      for (const row of apptRows) {
        apptByLinkedId.set(row.id, row);
        if (row.source_estimate_id && !apptBySourceEstimateId.has(row.source_estimate_id)) {
          apptBySourceEstimateId.set(row.source_estimate_id, row);
        }
        if (row.customer_id && !nextApptByCustomer.has(row.customer_id)) {
          nextApptByCustomer.set(row.customer_id, row);
        }
      }
    }

    const pricingRiskById = new Map();
    if (includePricingRisk && estimates.length) {
      try {
        const batch = await buildEstimatePricingRiskBatch(estimates);
        for (const [id, risk] of batch.entries()) pricingRiskById.set(id, risk);
      } catch (err) {
        for (const estimate of estimates) {
          pricingRiskById.set(estimate.id, {
            status: 'warning',
            hasRisk: true,
            missingCogsCount: 0,
            lowMarginCount: 0,
            warningCount: 1,
            margin: null,
            estimatedCost: 0,
            labels: ['Audit Unavailable'],
            error: err.message,
          });
        }
      }
    }

    res.json({
      estimates: estimates.map(e => {
        let estData = e.estimate_data;
        if (typeof estData === 'string') { try { estData = JSON.parse(estData); } catch { estData = null; } }
        const monthlyTotal = parseFloat(e.monthly_total || 0);
        const onetimeTotal = parseFloat(e.onetime_total || 0);
        const hasBeenSent = !!e.sent_at;
        const serviceLines = inferEstimateServiceLines({
          ...e,
          estimateData: estData,
          serviceInterest: e.service_interest,
          monthlyTotal,
          onetimeTotal,
        });
        const serviceInterest = e.service_interest || inferEstimateServiceInterest({
          ...e,
          estimateData: estData,
          monthlyTotal,
          onetimeTotal,
        });
        const linkedSvcId = estData?.scheduled_service_id || null;
        const linkedAppt = linkedSvcId ? apptByLinkedId.get(linkedSvcId) : null;
        const sourceLinkedAppt = apptBySourceEstimateId.get(e.id) || null;
        const fallbackAppt = e.customer_id ? nextApptByCustomer.get(e.customer_id) : null;
        const apptRow = linkedAppt || sourceLinkedAppt || fallbackAppt;
        const confirmedAppointment = apptRow ? {
          id: apptRow.id,
          scheduledDate: apptRow.scheduled_date,
          windowDisplay: apptRow.window_display,
          windowStart: apptRow.window_start,
          serviceType: apptRow.service_type,
          linked: !!(
            (linkedAppt && linkedAppt.id === apptRow.id)
            || (sourceLinkedAppt && sourceLinkedAppt.id === apptRow.id)
          ),
        } : null;
        return {
          id: e.id, status: e.status, customerName: e.customer_name,
          customerId: e.customer_id,
          customerPhone: e.customer_phone, address: e.address,
          customerEmail: e.customer_email,
          updatedAt: e.updated_at,
          monthlyTotal,
          onetimeTotal,
          tier: e.waveguard_tier, createdBy: e.created_by_name,
          sentAt: e.sent_at,
          viewedAt: hasBeenSent ? e.viewed_at : null,
          acceptedAt: e.accepted_at,
          scheduledAt: e.scheduled_at,
          expiresAt: e.expires_at,
          sendMethod: e.send_method,
          declinedAt: e.declined_at,
          viewCount: hasBeenSent ? e.view_count || 0 : 0,
          lastViewedAt: hasBeenSent ? e.last_viewed_at : null,
          clickCount: parseInt(clickStats.get(e.id)?.click_count || 0, 10),
          lastClickedAt: clickStats.get(e.id)?.last_clicked_at || null,
          createdAt: e.created_at,
          source: e.source || 'manual',
          serviceInterest,
          serviceLines,
          leadSource: e.lead_source,
          leadSourceDetail: e.lead_source_detail,
          isPriority: e.is_priority,
          description: serviceInterest || e.notes,
          notes: e.notes,
          followUpCount: e.follow_up_count || 0,
          lastFollowUpAt: e.last_follow_up_at,
          declineReason: e.decline_reason,
          disposition: e.disposition || null,
          dispositionSource: e.disposition_source || null,
          dispositionNote: e.disposition_note || null,
          competitorName: e.competitor_name || null,
          competitorPrice: e.competitor_price != null ? parseFloat(e.competitor_price) : null,
          token: e.token,
          archivedAt: e.archived_at,
          showOneTimeOption: e.show_one_time_option,
          billByInvoice: e.bill_by_invoice,
          // Scaffolds count: a disabled machine-seeded proposal must route
          // to the proposal builder, not the normal edit flow (revise
          // rejects COMMERCIAL rows).
          isCommercialProposal: isCommercialProposalData(estData),
          confirmedAppointment,
          automation: leadEstimateAutomationSummary(estData),
          // Estimator-engine drafts keep their operator review material in
          // estimate_data (the notes COLUMN is customer-visible via the
          // public endpoint) — surface it here so the admin list can render
          // the lane + review reasons.
          estimatorEngine: estData?.estimatorEngine
            ? {
              lane: estData.estimatorEngine.lane || null,
              laneReasons: estData.estimatorEngine.laneReasons || [],
              reviewNotes: estData.estimatorEngine.reviewNotes || null,
              // Margin visibility (owner ruling: surfaced, never enforced):
              // the engine's report-only warnings ride the stored result —
              // without projecting them, an engine draft's review modal
              // shows no sub-35% signal (only the row badge does).
              marginWarnings: (() => {
                const result = estData?.result || estData?.engineResult || null;
                const list = result?.marginWarnings
                  || result?.recurring?.marginWarnings
                  || [];
                return Array.isArray(list) ? list.slice(0, 10) : [];
              })(),
            }
            : null,
          // ai_agent (IB quoting agent) drafts keep their reasoning /
          // assumptions / uncertainty in estimate_data for the same reason —
          // surface the operator review material so the pipeline can render
          // it before send.
          agentDraftReview: estData?.agentDraftReview
            ? {
              reasoning: estData.agentDraftReview.reasoning || null,
              assumptions: Array.isArray(estData.agentDraftReview.assumptions)
                ? estData.agentDraftReview.assumptions : [],
              uncertainty: Array.isArray(estData.agentDraftReview.uncertainty)
                ? estData.agentDraftReview.uncertainty : [],
              sqftSource: estData.agentDraftReview.sqftSource || null,
              belowTargetServices: Array.isArray(estData.agentDraftReview.marginCheck?.below_target_services)
                ? estData.agentDraftReview.marginCheck.below_target_services : [],
              // Priced lines whose margin could not be verified are a review
              // signal too — dropping this would show an unflagged badge for
              // a draft the engine could not fully vouch for.
              unverifiedLineCount: Number(estData.agentDraftReview.marginCheck?.unverified_line_count || 0),
              createdAt: estData.agentDraftReview.createdAt || null,
            }
            : null,
          pricingRisk: pricingRiskById.get(e.id) || null,
          riskTypeNeedsReview: commercialRiskTypeReviewNeeded(estData),
          lawnServiceOutline: outlineByEstimateId.get(e.id) || null,
        };
      }),
      // Signals the ESTIMATE_LIST_LIMIT cap was hit, so the client can warn that
      // list-derived KPIs may be incomplete instead of silently undercounting.
      truncated: estimates.length >= ESTIMATE_LIST_LIMIT,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/estimates/:id/pricing-audit — explain stored price, protocol,
// inventory COGS, and margin by estimate line.
router.get('/:id/pricing-audit', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    const audit = await buildEstimatePricingAudit(estimate);
    audit.snapshot = await getLatestEstimatePricingAuditSnapshot(estimate.id);
    res.json(audit);
  } catch (err) { next(err); }
});

// GET /api/admin/estimates/:id/proposal — read the normalized commercial
// proposal (multi-building line items) + computed totals. Always returns a
// proposal: an authored one if present, otherwise a synthesized single-
// building fallback the operator can promote to a real proposal.
router.get('/:id/proposal', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    const proposal = normalizeProposal(estimate);
    res.json({
      proposal,
      totals: computeProposalTotals(proposal),
      // Engine-composed prospect research (commercial proposal lane) — the
      // builder page shows it read-only above the line items. Additive:
      // null for operator-originated proposals.
      prospectBrief: parseEstimateData(estimate.estimate_data)?.commercialProspect || null,
      // Per-family inclusions/exclusions/responsibilities/taxability
      // registry: the INSTALL source for the builder's family-change resync
      // (codex 1A-ii r14). Pruning of generated responsibility lines rides
      // the proposal's own persisted generatedResponsibilities provenance,
      // never catalog membership (codex 1A-ii r15 — a hand-authored line
      // matching a stock sentence must survive), so reopened proposals
      // prune exactly what their generation installed.
      familyRegistry: require('../services/estimate-proposal-generate').buildFamilyRegistry(
        await require('../services/estimate-proposal-generate').loadTaxabilityMap(db),
      ),
      // Estimate summary for the standalone proposal-builder page, which loads
      // by id without the pipeline list. Additive — older consumers only read
      // `proposal`/`totals`.
      estimate: {
        id: estimate.id,
        status: estimate.status,
        customerName: estimate.customer_name,
        customerId: estimate.customer_id,
        customerEmail: estimate.customer_email,
        customerPhone: estimate.customer_phone,
        address: estimate.address,
        token: estimate.token,
        sentAt: estimate.sent_at,
        viewedAt: estimate.viewed_at,
        acceptedAt: estimate.accepted_at,
        expiresAt: estimate.expires_at,
        archivedAt: estimate.archived_at,
        priceLockedAt: estimate.price_locked_at,
        billByInvoice: estimate.bill_by_invoice,
        // The Mark-won gate mirrors the list's canMarkEstimateWon, which also
        // blocks one-time-option estimates (manual accept rejects them).
        showOneTimeOption: estimate.show_one_time_option,
        category: estimate.category,
      },
    });
  } catch (err) { next(err); }
});

// GET /api/admin/estimates/:id/proposal/generated — DRAFT structured
// sections derived from what the estimator already priced/knows (slice
// 1A-ii "generate from estimate"). Read-only; nothing becomes customer-
// visible until the operator edits and saves through PUT /:id/proposal.
router.get('/:id/proposal/generated', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    const { deriveProposalDraft } = require('../services/estimate-proposal-generate');
    res.json({ draft: await deriveProposalDraft(estimate, { database: db }) });
  } catch (err) { next(err); }
});

// PUT /api/admin/estimates/:id/proposal — author/replace the commercial
// proposal. Persisted into estimate_data.proposal (JSONB, no migration).
// The operator-entered line items ARE the commercial quote, so the three
// authoritative total columns are recomputed from them — that's what makes
// a manual-quote commercial estimate sendable.
router.put('/:id/proposal', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (estimate.archived_at) return res.status(400).json({ error: 'Estimate is archived. Unarchive first.' });

    // Re-pricing guard. Acceptance locks the price (price_locked_at) and spins
    // up downstream records (onboarding / invoice / booking); declined and
    // expired are closed; `sending` means a send is mid-flight (scheduled-send
    // cron claims the row as `sending` before dispatching, and that sender
    // rewrites estimate_data from its pre-send read). Saving a proposal rewrites
    // the authoritative totals + proposal JSON, so block it once the estimate
    // has left the editable window — otherwise a late edit corrupts a locked
    // accepted price, or races a send into a stale-PDF / clobbered-proposal split.
    // An EXPIRED proposal the pricing-authority gate refuses (no editor
    // provenance yet — saved before the marker existed) has no other way
    // back (uncapped codex P1 r32 on #3750): the extension is refused until
    // the row carries provenance, and only this editor can stamp it. Mirror
    // the ordinary expired-row recovery: the re-save is allowed, leaves the
    // row expired, and the operator extends it afterwards.
    const { expiredRowRecoverableUnderGate } = require('../services/admin-estimate-persistence');
    const expiredRecovery = estimate.status === 'expired' && expiredRowRecoverableUnderGate(estimate);
    const closedStatuses = expiredRecovery
      ? ['accepted', 'declined', 'sending']
      : ['accepted', 'declined', 'expired', 'sending'];
    if (estimate.price_locked_at || closedStatuses.includes(estimate.status)) {
      return res.status(409).json({
        error: estimate.price_locked_at
          ? 'This estimate is price-locked (accepted) and can no longer be re-priced.'
          : estimate.status === 'sending'
          ? 'This estimate is being sent right now. Wait for the send to finish, then retry.'
          : `A ${estimate.status} estimate can no longer be re-priced.`,
      });
    }

    const incoming = req.body?.proposal || req.body || {};
    // Programs-only callers may omit buildings entirely — normalize once
    // and use the array everywhere (pre-push codex P1: undefined.some threw).
    const incomingBuildings = Array.isArray(incoming.buildings) ? incoming.buildings : [];
    const hasBuildings = incomingBuildings.length > 0;
    const incomingPrograms = Array.isArray(incoming.programs) ? incoming.programs : null;
    const hasPrograms = Boolean(incomingPrograms && incomingPrograms.length);
    // One recurring itemization, never two that can disagree (slice 1A-ii):
    // a proposal is priced by its building line items OR by its service
    // programs. Program subdivisions carry the multi-building labels.
    // Corrective work ALONE is a valid itemization too — a one-time-only
    // commercial proposal has no recurring side (codex 1A-ii r2g).
    const hasCorrective = Array.isArray(incoming.correctiveWork) && incoming.correctiveWork.length > 0;
    if (!hasBuildings && !hasPrograms && !hasCorrective) {
      return res.status(400).json({ error: 'Add building line items, service programs, or corrective work — a proposal needs a priced itemization.' });
    }
    if (hasPrograms && hasBuildings
      && incomingBuildings.some((b) => Array.isArray(b?.lineItems || b?.line_items) && (b.lineItems || b.line_items).length > 0)) {
      return res.status(400).json({ error: 'Service programs are the recurring itemization — remove the building line items (use program subdivisions for building labels).' });
    }
    if (hasPrograms) {
      if (incomingPrograms.length > 10) {
        return res.status(400).json({ error: 'Proposals are limited to 10 service programs.' });
      }
      for (const program of incomingPrograms) {
        const freq = Number(program?.frequencyPerYear ?? program?.visitsPerYear);
        if (!Number.isInteger(freq) || freq < 1 || freq > 52) {
          return res.status(400).json({ error: 'Each program needs a whole-number service frequency between 1 and 52 visits per year.' });
        }
        // Finite, positive, cent-representable — 0.001 or Infinity would
        // normalize to a dropped program and rewrite the authoritative
        // totals to zero (pre-push codex P0).
        const price = Number(program?.pricePerApplication ?? program?.perApplication);
        if (!Number.isFinite(price) || price < 0.01
          || Math.abs(price * 100 - Math.round(price * 100)) > 1e-6) {
          return res.status(400).json({ error: 'Each program needs a per-application price of at least $0.01, in whole cents.' });
        }
        if (String(program?.label ?? program?.name ?? '').length > 120) {
          return res.status(400).json({ error: 'Program names are limited to 120 characters.' });
        }
        const overList = (arr, maxItems, maxLen) => Array.isArray(arr)
          && (arr.length > maxItems || arr.some((line) => String(line ?? '').length > maxLen));
        if (overList(program?.inclusions, 12, 200)) {
          return res.status(400).json({ error: 'Program inclusions are limited to 12 lines of 200 characters.' });
        }
        if (overList(program?.exclusions, 8, 160)) {
          return res.status(400).json({ error: 'Program exclusions are limited to 8 lines of 160 characters.' });
        }
        // Notes and subdivisions clamp silently in the normalizer — reject
        // oversize here so customer-facing scope can't vanish on save
        // (codex 1A-ii r1b).
        if (String(program?.note ?? '').length > 300) {
          return res.status(400).json({ error: 'Program notes are limited to 300 characters.' });
        }
        if (Array.isArray(program?.buildings)
          && (program.buildings.length > 12
            || program.buildings.some((b) => String(b?.name ?? '').length > 120 || String(b?.note ?? '').length > 300))) {
          return res.status(400).json({ error: 'Program subdivisions are limited to 12 buildings (names 120 chars, notes 300 chars).' });
        }
      }
    }
    // Reject negative line pricing outright so the operator sees the error
    // rather than a silently-clamped zero. (normalizeLineItem also clamps as a
    // last-resort safety net for any other entry path.)
    const hasNegativeLine = incomingBuildings.some((b) => Array.isArray(b?.lineItems || b?.line_items)
      && (b.lineItems || b.line_items).some((i) => Number(i?.unitPrice ?? i?.unit_price ?? i?.price) < 0
        || Number(i?.quantity) < 0));
    if (hasNegativeLine) {
      return res.status(400).json({ error: 'Proposal line items cannot have negative quantities or unit prices.' });
    }
    // Same feedback-over-silent-clamp rule for structured corrective-work
    // amounts (slice 1A-i) — they fold into the one-time totals like any
    // one_time line, so a negative here is the same repricing hazard.
    if (Array.isArray(incoming.correctiveWork)
      && incoming.correctiveWork.some((w) => Number(w?.amount ?? w?.price) < 0)) {
      return res.status(400).json({ error: 'Corrective work amounts cannot be negative.' });
    }
    // Every corrective amount must be finite and cent-representable, and a
    // corrective-ONLY itemization needs at least one positive amount — an
    // all-zero (or NaN/Infinity) payload would normalize to nothing, clear
    // the quote-required flags, and rewrite the authoritative totals to
    // zero (codex 1A-ii r2i).
    if (Array.isArray(incoming.correctiveWork) && incoming.correctiveWork.length) {
      for (const w of incoming.correctiveWork) {
        const amount = Number(w?.amount ?? w?.price ?? 0);
        if (!Number.isFinite(amount) || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
          return res.status(400).json({ error: 'Corrective work amounts must be whole-cent dollar values.' });
        }
      }
      if (!hasBuildings && !hasPrograms
        && !incoming.correctiveWork.some((w) => Number(w?.amount ?? w?.price) >= 0.01)) {
        return res.status(400).json({ error: 'A corrective-work-only proposal needs at least one item priced at $0.01 or more.' });
      }
    }
    // Oversized structured-section lists get a 400, not a silent clamp —
    // normalizeProposal truncates lines and drops over-limit entries as a
    // safety net, but an operator's contractual bullet must never vanish or
    // cut mid-sentence without explanation (codex #3297 r3).
    const overLimit = (arr, maxItems, maxLen, pick) => Array.isArray(arr)
      && (arr.length > maxItems || arr.some((entry) => String(pick(entry) ?? '').length > maxLen));
    if (Array.isArray(incoming.correctiveWork)) {
      if (incoming.correctiveWork.length > 24) {
        return res.status(400).json({ error: 'Corrective work is limited to 24 items.' });
      }
      for (const work of incoming.correctiveWork) {
        // Same alias expression the normalizer reads (label ?? description) —
        // validating only `label` let an aliased oversized description slip
        // through to the silent clamp (codex #3297 r5).
        if (String(work?.label ?? work?.description ?? '').length > 160) {
          return res.status(400).json({ error: 'Corrective work descriptions are limited to 160 characters.' });
        }
        if (overLimit(work?.includes, 12, 200, (line) => line)) {
          return res.status(400).json({ error: 'Each corrective work item is limited to 12 include lines of 200 characters.' });
        }
      }
    }
    if (overLimit(incoming.customerResponsibilities, 16, 200, (line) => line)) {
      return res.status(400).json({ error: 'Customer responsibilities are limited to 16 lines of 200 characters.' });
    }
    {
      const scopeItems = incoming.propertyScope?.items ?? (Array.isArray(incoming.propertyScope) ? incoming.propertyScope : null);
      if (Array.isArray(scopeItems)
        && (scopeItems.length > 24 || scopeItems.some((item) => String(item?.label ?? '').length > 80 || String(item?.value ?? '').length > 160))) {
        return res.status(400).json({ error: 'Property scope is limited to 24 rows (labels 80 chars, values 160 chars).' });
      }
    }
    // Present-but-invalid term numbers get a 400, not a silent normalize:
    // cleanBoundedInt rounds fractions and drops out-of-range values, so
    // without this the operator could see "1.5" or "61" months while the
    // saved proposal says "2 months" or omits the term (codex 1A-i r4).
    const badBoundedInt = (value, min, max) => value != null && String(value).trim() !== ''
      && (!Number.isInteger(Number(value)) || Number(value) < min || Number(value) > max);
    // Hoisted for the atomic UPDATE below: saving a canonical payment term
    // must be predicated on bill_by_invoice STILL being true at write time.
    let savingPaymentTerm = false;
    if (incoming.commercialTerms && typeof incoming.commercialTerms === 'object') {
      if (badBoundedInt(incoming.commercialTerms.initialTermMonths, 0, 60)) {
        return res.status(400).json({ error: 'Initial term must be a whole number of months between 0 and 60.' });
      }
      // Payment terms speak the canonical payer vocabulary only — free text
      // here would silently normalize to null (codex #3297 r2).
      const rawPaymentTerms = incoming.commercialTerms.paymentTerms;
      const canonicalPaymentTerms = rawPaymentTerms != null && String(rawPaymentTerms).trim() !== ''
        ? require('../services/estimate-proposal').normalizePaymentTerms(rawPaymentTerms)
        : null;
      if (rawPaymentTerms != null && String(rawPaymentTerms).trim() !== '' && canonicalPaymentTerms === null) {
        return res.status(400).json({ error: 'Payment terms must be one of: Due on receipt, Net-15, Net-30.' });
      }
      // Structured payment terms exist because billing CONSUMES them (the
      // acceptance invoice's due date). Only invoice-mode proposals have
      // that path — on any other proposal the field would render a promise
      // no invoice ever reads. Payment language for manually-billed
      // agreements belongs in Additional terms (codex #3297 r4).
      if (canonicalPaymentTerms && !estimate.bill_by_invoice) {
        return res.status(400).json({ error: 'Structured payment terms require Bill by invoice. Put payment language in Additional terms, or turn on invoice billing for this proposal.' });
      }
      savingPaymentTerm = Boolean(canonicalPaymentTerms);
      // A linked ACTIVE payer's terms are the standing billing relationship
      // (they drive statement accrual and the acceptance invoice via
      // resolveAcceptanceTermDays). Authoring a CONTRADICTING term here
      // would render a promise the invoice won't keep — reject it at the
      // only surface that authors terms, so agreement and invoice always
      // match (codex #3297 r2d).
      if (canonicalPaymentTerms && estimate.customer_id) {
        const { resolveForInvoice } = require('../services/payer');
        let payerResolution;
        try {
          // throwOnError: uncertainty must BLOCK authoring — fail-soft
          // self-pay would let a contradicting term publish (codex 1A-i r3).
          payerResolution = await resolveForInvoice({ customerId: estimate.customer_id, throwOnError: true });
        } catch (resolveErr) {
          logger.warn(`[admin-estimates] payer term check failed for estimate ${estimate.id}: ${resolveErr.message}`);
          return res.status(503).json({ error: 'Could not verify the customer’s payer billing terms just now — try saving again.' });
        }
        if (payerResolution?.payerId != null && payerResolution.paymentTerms
          && payerResolution.paymentTerms !== canonicalPaymentTerms) {
          const labels = { due_on_receipt: 'Due on receipt', net15: 'Net-15', net30: 'Net-30' };
          return res.status(400).json({
            error: `This customer bills through a payer on ${labels[payerResolution.paymentTerms] || payerResolution.paymentTerms} terms — set payment terms to match, or leave them unset.`,
          });
        }
      }
    }

    // per_application is a RENDERING-only cadence (the estimate PDF's
    // synthesized lines). It must never be persisted here: the editor payload
    // carries no visitsPerYear, so such a line annualizes to $0 and the UPDATE
    // below would write that into the estimate's authoritative annual_total
    // (codex #3120 r1, re-flagged pre-push r5 at the normalizer level).
    const hasRenderingOnlyCadence = incomingBuildings.some((b) => Array.isArray(b?.lineItems || b?.line_items)
      && (b.lineItems || b.line_items).some((i) => String(i?.frequency || '')
        .trim().toLowerCase().replace(/[\s-]+/g, '_') === 'per_application'));
    if (hasRenderingOnlyCadence) {
      return res.status(400).json({ error: 'Proposal line items cannot use the per-application cadence. Pick a billing cadence for each line.' });
    }

    // Normalize through the shared model so what we store matches what the
    // PDF and totals read. Force enabled:true — an explicit PUT means the
    // operator is authoring a real proposal (not the synthesized fallback).
    const normalized = normalizeProposal({
      ...estimate,
      estimate_data: { proposal: { ...incoming, enabled: true } },
    });
    normalized.enabled = true;
    normalized.synthesized = false;
    // Belt to the field checks above: if the normalizer dropped ANY
    // submitted program, persisting would silently rewrite the
    // authoritative totals without it (pre-push codex P0). Fail loud.
    if (hasPrograms && (normalized.programs?.length ?? 0) !== incomingPrograms.length) {
      return res.status(400).json({ error: 'One or more service programs failed validation and would be dropped — fix or remove them, then save again.' });
    }
    if (hasCorrective && (normalized.correctiveWork?.length ?? 0) !== incoming.correctiveWork.length) {
      return res.status(400).json({ error: 'One or more corrective-work items failed validation and would be dropped — fix or remove them, then save again.' });
    }
    const totals = computeProposalTotals(normalized);
    // estimates.monthly_total/annual_total/onetime_total are decimal(10,2)
    // — a finite-but-huge authored price (e.g. $2,000,000 × 52
    // applications) would overflow the UPDATE with a raw numeric error
    // instead of actionable validation (codex 1A-ii r10).
    const DB_TOTAL_MAX = 99999999.99;
    for (const [totalLabel, totalValue] of [
      ['annual recurring', totals.annualRecurring],
      ['monthly equivalent', totals.monthlyEquivalent],
      ['one-time', totals.oneTime],
    ]) {
      if (Number(totalValue) > DB_TOTAL_MAX) {
        return res.status(400).json({ error: `The proposal's ${totalLabel} total exceeds $99,999,999.99 — reduce the amounts before saving.` });
      }
    }
    // The acceptance invoice bills every program's first application PLUS all
    // corrective work (and tax) on ONE invoice — each estimate column can
    // pass the per-column bound while the combined first invoice overflows
    // invoices.subtotal/total, also decimal(10,2), at mark-won (codex 1A-ii
    // r14). Reuse the canonical builder so the bound matches exactly what a
    // win would bill. Checked regardless of the current billing mode —
    // bill_by_invoice can flip after authoring.
    const firstInvoice = buildProposalFirstInvoice(normalized);
    if (firstInvoice.subtotal > DB_TOTAL_MAX || firstInvoice.total > DB_TOTAL_MAX) {
      return res.status(400).json({ error: 'The combined acceptance invoice (first applications plus corrective work and tax) exceeds $99,999,999.99 — reduce the amounts before saving.' });
    }

    const existingData = parseEstimateData(estimate.estimate_data) || {};
    const nextData = {
      ...existingData,
      proposal: {
        ...normalized,
        updatedAt: new Date().toISOString(),
        // Server-owned provenance: the send gate's authored-proposal
        // exemption keys on THIS marker (isAuthoredProposalRow /
        // GATED_SEND_AUTHORITY_SQL), never on category or the blob alone.
        provenance: { source: PROPOSAL_PROVENANCE_SOURCE, stampedAt: new Date().toISOString(), stampedBy: req.technicianId || null },
      },
    };
    // The prior send's delivery state describes the PREVIOUS proposal PDF. Once
    // the operator re-authors the proposal, that emailed-PDF claim is stale, so
    // drop it — the public copy falls back to "your account manager has the
    // proposal" until the next send re-stamps proposalDelivery against the new
    // PDF. Otherwise the link would keep saying the edited proposal was emailed.
    clearStaleProposalDelivery(nextData);
    // Make the authored proposal sendable: clear the auto-quote-required
    // booleans the commercial estimate was created with, and resolve any
    // blocking lead/draft automation status. proposal.enabled (set above) is
    // what keeps acceptance manual in the public view, so this only unblocks
    // the admin send gate — it does not re-enable self-serve accept.
    clearQuoteRequirementFlags(nextData);
    resolveBlockingAutomationForProposal(nextData);

    // Atomic re-pricing guard. The status/price-lock check above runs on a
    // pre-read; scope the UPDATE to the same editable conditions so a customer
    // accept or another admin's Mark accepted landing between SELECT and UPDATE
    // can't overwrite the locked accepted price/proposal. 409 when it loses.
    // The write rides ONE transaction under the group's send advisory lock
    // (uncapped codex P0 r31): a grouped auto-send validates its published
    // siblings under that lock and releases it before the provider handoff,
    // so an unlocked proposal rewrite of a sibling could slip between the
    // verdict and the handoff and put authored pricing on the automated
    // link. Same lock order as every send/schedule path (group, then row);
    // a group with a member mid-send is refused for a retry.
    // Membership is observed INSIDE the transaction and pinned on the write
    // (uncapped codex P0 + GH codex P1 r32): the pre-transaction read can be
    // stale — a row moved into another group after it would otherwise be
    // rewritten under the wrong group's lock. Group lock first, then the row
    // lock; a membership change between the two reads is refused for a
    // retry. "In flight" is any member that is 'sending' OR still holds a
    // fresh delivery claim (GH codex P1 r32): an anchor accepted mid-handoff
    // leaves 'sending' while the automated link is still being delivered.
    const retry = (message) => { const err = new Error(message); err.statusCode = 409; return err; };
    const updatedCount = await db.transaction(async (trx) => {
    const observed = await trx('estimates').where({ id: estimate.id }).first('id', 'estimate_group_id');
    if (!observed) throw retry('This estimate changed while you were editing — reload and retry.');
    const groupId = observed.estimate_group_id || null;
    if (groupId) {
      await trx.raw(
        'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
        ['estimate-group-send', String(groupId)],
      );
    }
    const locked = await trx('estimates').where({ id: estimate.id }).forUpdate().first('id', 'estimate_group_id', 'status', 'estimate_data', 'address');
    if (!locked || (locked.estimate_group_id || null) !== groupId) {
      throw retry('This estimate changed groups while you were editing — reload and retry.');
    }
    // The engine block is carried from the LOCKED row, never the pre-read:
    // a clarify re-price guard stamped between the two would otherwise be
    // dropped by this whole-blob write. And the guard this save OBSERVED on
    // the pre-read is lifted HERE — an authored proposal IS the operator's
    // re-price, and reviseAdminEstimate (the residential path that lifts
    // it) refuses commercial rows, so without this every later send of a
    // held commercial scaffold failed as reprice_pending (codex r4 P1 on
    // #3796). A NEWER attempt the locked row carries stays.
    {
      const lockedEngine = parseEstimateData(locked.estimate_data)?.estimatorEngine;
      if (lockedEngine && typeof lockedEngine === 'object') {
        const nextEngine = { ...lockedEngine };
        const observedEngine = existingData.estimatorEngine && typeof existingData.estimatorEngine === 'object' ? existingData.estimatorEngine : {};
        if (observedEngine.reprice_pending_at && nextEngine.reprice_pending_at
          && String(nextEngine.reprice_attempt || '') === String(observedEngine.reprice_attempt || '')) {
          // A UNIT hold is lifted only once the row's address carries the
          // answered unit (the proposal save never edits the address column;
          // the operator corrects it first) — codex r1 P1 on #3804.
          // The proposal's EDITABLE address (proposal.propertyAddress) is
          // what the operator corrects — the base column is immutable here
          // and the residential revision refuses commercial rows (codex r3
          // P1 on #3804).
          const { unitHoldSatisfied } = require('../utils/estimate-claim-sql');
          if (await unitHoldSatisfied(trx, nextEngine.callLogId || null, normalized?.propertyAddress || locked.address)) {
            delete nextEngine.reprice_pending_at;
            delete nextEngine.reprice_attempt;
          }
        }
        nextData.estimatorEngine = nextEngine;
      }
    }
    if (groupId) {
      const inFlightMember = await trx('estimates')
        .where({ estimate_group_id: groupId })
        .whereNot({ id: estimate.id })
        .whereNull('archived_at')
        .where((q) => q.where({ status: 'sending' }).orWhereRaw(`NOT (${DELIVERY_CLAIM_NOT_LIVE_SQL})`))
        .first('id');
      if (inFlightMember) throw retry('This multi-property group is being sent right now — wait a moment and retry.');
    }
    const updateQuery = trx('estimates')
      .where({ id: estimate.id })
      .modify((qb) => (groupId ? qb.where({ estimate_group_id: groupId }) : qb.whereNull('estimate_group_id')))
      .whereNull('price_locked_at')
      // An ARCHIVED row is not editable (codex P1, PR #3304): a linkage
      // invalidation archiving the draft between this route's pre-read
      // and the write must win — the stale whole-blob rewrite would strip
      // linkage_invalidated_at and revive the old linkage data.
      .whereNull('archived_at')
      // …and neither a MARKER nor a live delivery CLAIM may be present
      // (codex P0, PR #3304 GH r8c): sendEstimateNow flips status back to
      // 'sent' BEFORE its finally block clears delivering_token, so a
      // proposal save that began earlier can land in that window and
      // overwrite a concurrently recorded invalidation_pending_* marker
      // and the claim itself — after which claim cleanup finds no matching
      // token and wrong-lead content stays public and sendable. The
      // status-only exclusion could not see that window.
      .whereRaw("COALESCE(estimate_data->'estimatorEngine'->>'linkage_invalidated_at', '') = ''")
      .whereRaw("COALESCE(estimate_data->'estimatorEngine'->>'invalidation_pending_at', '') = ''")
      .whereRaw(DELIVERY_CLAIM_NOT_LIVE_SQL)
      .whereNotIn('status', closedStatuses);
    // Payment terms are predicated on bill_by_invoice AT WRITE TIME too — a
    // concurrent PATCH turning invoice mode off between the pre-read guard
    // and this UPDATE must not persist a term no billing path enforces
    // (codex #3297 r4c).
    if (savingPaymentTerm) updateQuery.where({ bill_by_invoice: true });
    return updateQuery.update({
      estimate_data: JSON.stringify(nextData),
      category: 'COMMERCIAL',
      // Authored totals are NOT engine output: the engine stamp a generated
      // draft carried is cleared so the SERVER-only automation (lead
      // auto-send) can never deliver operator-authored proposal prices; the
      // manual send exemption rides the provenance marker instead (GH codex
      // P1 r30 on #3750).
      pricing_authority: null,
      monthly_total: totals.monthlyEquivalent,
      annual_total: totals.annualRecurring,
      onetime_total: totals.oneTime,
      updated_at: db.fn.now(),
    });
    });
    if (!updatedCount) {
      return res.status(409).json({
        error: savingPaymentTerm
          ? 'Estimate was accepted, locked, or switched off invoice billing while you were editing. Refresh and retry.'
          : 'Estimate was accepted or locked while you were editing. Refresh and retry.',
      });
    }

    logger.info(`[estimates] Saved commercial proposal for estimate ${estimate.id} (${normalized.buildings.length} buildings, first-year ${totals.firstYearTotal})`);
    res.json({ success: true, proposal: normalized, totals });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// GET /api/admin/estimates/:id/proposal.pdf — branded commercial proposal
// PDF (inline). Reuses the same generator that produces the email
// attachment, so the download and the emailed copy are byte-identical.
router.get('/:id/proposal.pdf', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    // Browser-rendered document (GATE_ESTIMATE_DOC_PDF) — same renderer as
    // the customer download so the operator's copy matches the customer's.
    // Only for rows the public /data route will serve (the headless page
    // fetches it): drafts/scheduled/expired/send_failed/archived rows keep
    // the pdfkit generator, which reads the row directly. Any render failure
    // also falls through to pdfkit — the admin download must never 500 on a
    // browser hiccup.
    const publicViewable = !estimate.archived_at
      && !['draft', 'scheduled', 'expired', 'send_failed'].includes(estimate.status)
      && !(estimate.expires_at && new Date(estimate.expires_at) < new Date() && !['accepted', 'declined'].includes(estimate.status));
    if (publicViewable && require('../config/feature-gates').isEnabled('estimateDocPdf')) {
      try {
        const { renderEstimateDocumentPdf } = require('../services/pdf/estimate-doc-pdf');
        const buffer = await renderEstimateDocumentPdf(estimate);
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', 'inline; filename="proposal.pdf"');
        return res.send(buffer);
      } catch (e) {
        const { sanitizeRenderError } = require('../services/pdf/estimate-doc-pdf');
        logger.warn(`[admin-estimates] browser document render failed for estimate ${estimate.id}; serving pdfkit fallback: ${sanitizeRenderError(e)}`);
      }
    }
    // Same live billing lane the customer-facing download resolves, so the
    // operator's copy and the customer's copy stay byte-identical.
    const { resolveProposalBillingContext } = require('../services/estimate-proposal-billing');
    const { acceptanceRecordForEstimate } = require('../services/estimate-acceptance-record');
    generateEstimateProposalPDF(estimate, res, {
      ...(await resolveProposalBillingContext(estimate)),
      // Same recorded acceptance the customer's download carries (strict: an
      // accepted document is never produced without its record).
      acceptance: await acceptanceRecordForEstimate(estimate, { strict: true }),
    });
  } catch (err) { next(err); }
});

// GET /:id/schedule-source — one estimate formatted exactly like a
// /admin/customers/:id/schedule-estimates row, so the New Appointment modal can
// surface a quote that has NO customer yet (a lead's estimate). This lets the
// operator schedule a verbal "yes" before the lead is converted; booking then
// attaches the estimate to the chosen customer (POST /admin/schedule). Returns
// the estimate's captured contact + lead linkage so the modal can prefill the
// customer it needs to create.
router.get('/:id/schedule-source', async (req, res, next) => {
  try {
    const estimate = await db('estimates')
      .where({ id: req.params.id })
      .whereNull('archived_at')
      .first(
        'id', 'customer_id', 'status', 'token', 'service_interest', 'estimate_data',
        'estimate_slug', 'monthly_total', 'annual_total', 'onetime_total', 'waveguard_tier',
        'bill_by_invoice', 'show_one_time_option', 'created_at', 'accepted_at', 'expires_at',
        'customer_name', 'customer_phone', 'customer_email', 'address',
      );
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

    const { indexServicesForSchedule, scheduleLinesFromEstimate } = require('./admin-customers')._private;
    const serviceRows = await db('services')
      .where({ is_active: true })
      .select(
        'id', 'service_key', 'name', 'short_name', 'category', 'billing_type',
        'frequency', 'visits_per_year', 'default_duration_minutes',
        'base_price', 'price_range_min', 'price_range_max',
      )
      .catch(() => []);
    const serviceIndex = indexServicesForSchedule(serviceRows);
    const lines = scheduleLinesFromEstimate(estimate, serviceIndex);

    // Already linked to a live appointment?
    let linked = null;
    try {
      linked = await db('scheduled_services')
        .where({ source_estimate_id: estimate.id })
        .whereNotIn('status', ['cancelled', 'rescheduled'])
        .orderBy('scheduled_date', 'asc')
        .orderBy('window_start', 'asc')
        .first('id', 'scheduled_date', 'window_start', 'service_type', 'status');
    } catch { linked = null; }

    let deposit = null;
    try {
      const { summarizeEstimateDeposit } = require('../services/estimate-deposits');
      deposit = await summarizeEstimateDeposit(
        estimate,
        linked ? { scheduledServiceId: linked.id, useLinkedFallback: false } : {},
      );
    } catch { deposit = null; }

    // Lead linkage — for the modal's customer prefill when there's no customer
    // yet. Prefer the FK (leads.estimate_id); fall back to the public-quote
    // mirror in estimate_data.lead_id.
    let leadId = null;
    try {
      const lead = await db('leads').where({ estimate_id: estimate.id }).whereNull('deleted_at').first('id');
      leadId = lead?.id || null;
      if (!leadId) {
        const data = typeof estimate.estimate_data === 'string'
          ? (() => { try { return JSON.parse(estimate.estimate_data); } catch { return null; } })()
          : estimate.estimate_data;
        leadId = data?.lead_id || null;
      }
    } catch { leadId = null; }

    const monthlyTotal = estimate.monthly_total != null ? Number(estimate.monthly_total) : null;
    const annualTotal = estimate.annual_total != null ? Number(estimate.annual_total) : null;
    const onetimeTotal = estimate.onetime_total != null ? Number(estimate.onetime_total) : null;
    // Mirror the customer endpoint: recurring period charge (monthly, or annual
    // only when there's no monthly) plus any one-time. annual_total is the
    // annualized monthly, so summing both would double-count.
    const quotedTotal = (monthlyTotal || annualTotal || 0) + (onetimeTotal || 0);

    // Whether the Schedule modal may offer one-step annual prepay for this
    // quote + the exact amount the prepay invoice would bill (discount + floor
    // applied). Server-derived so the modal never offers a billing term the
    // accept would reject. Fail-soft: no prepay offer on error.
    let prepay = { eligible: false, invoiceTotal: null };
    try {
      const e = await require('../services/estimate-manual-acceptance').prepayBookingEligibility(estimate);
      prepay = { eligible: !!e.eligible, invoiceTotal: e.invoiceTotal != null ? Number(e.invoiceTotal) : null };
    } catch { prepay = { eligible: false, invoiceTotal: null }; }

    const nameParts = String(estimate.customer_name || '').trim().split(/\s+/).filter(Boolean);

    res.json({
      estimate: {
        id: estimate.id,
        token: estimate.token,
        // Human-facing estimate number (EST-YYYY-NNNN) — matches the
        // schedule-estimates row shape so the provenance card can cite it.
        estimateSlug: estimate.estimate_slug || null,
        status: estimate.status,
        serviceInterest: estimate.service_interest,
        acceptedAt: estimate.accepted_at,
        createdAt: estimate.created_at,
        monthlyTotal,
        annualTotal,
        onetimeTotal,
        quotedTotal,
        waveguardTier: estimate.waveguard_tier,
        lines,
        deposit,
        prepay,
        linkedAppointment: linked ? {
          id: linked.id,
          scheduledDate: linked.scheduled_date,
          windowStart: linked.window_start,
          serviceType: linked.service_type,
          status: linked.status,
        } : null,
      },
      customerId: estimate.customer_id || null,
      leadId,
      contact: {
        firstName: nameParts[0] || '',
        lastName: nameParts.slice(1).join(' ') || '',
        phone: estimate.customer_phone || '',
        email: estimate.customer_email || '',
        address: estimate.address || '',
      },
    });
  } catch (err) { next(err); }
});

// POST /:id/archive — tuck an estimate out of the default list. Allowed
// for sent / viewed / declined / expired / accepted. Drafts can't be
// archived (they should be deleted instead — DELETE /:id). Archiving a
// sent or viewed estimate hides it from the admin queue but preserves the
// public token so the customer can still open the link they were sent.
router.post('/:id/archive', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (!['sent', 'viewed', 'declined', 'expired', 'accepted'].includes(estimate.status)) {
      return res.status(400).json({
        error: `Drafts can't be archived — delete the draft instead. Current status: ${estimate.status}.`,
      });
    }
    if (estimate.archived_at) return res.json(estimate);  // idempotent
    // Never park a LIVE estimate holding a received (unconsumed, unrefunded)
    // acceptance deposit: archived rows are excluded from expiration, and
    // sweepTerminalEstimateDeposits only scans declined/expired estimates —
    // archiving would strand the customer's deposit money forever. Same rule
    // as the converted-customer auto-archive sweep. Terminal rows (declined/
    // expired/accepted) archive freely: the sweep already covers them.
    if (['sent', 'viewed'].includes(estimate.status)) {
      const heldDeposit = await db('estimate_deposits')
        .where({ estimate_id: estimate.id, status: 'received' })
        .first('id');
      if (heldDeposit) {
        return res.status(409).json({
          error: 'This estimate holds a customer deposit. Decline it or let it expire first — the refund runs automatically from those states; archiving now would strand the deposit.',
        });
      }
    }
    const archiveUpdates = { archived_at: db.fn.now(), updated_at: db.fn.now() };
    // Parking a LIVE courtship is a loss outcome too (estimator audit
    // 2026-08-29 P0): an optional staff disposition in the body wins;
    // otherwise the row is classified archived_unresolved so it never
    // vanishes from the loss picture. Terminal rows already carry theirs.
    if (['sent', 'viewed'].includes(estimate.status) && !estimate.disposition) {
      const { staffDispositionUpdates } = require('../services/estimate-disposition');
      const given = req.body?.disposition !== undefined || req.body?.declineReason !== undefined
        ? staffDispositionUpdates(req.body)
        : null;
      if (given?.error) return res.status(400).json({ error: given.error });
      let systemUpdates = null;
      if (!given) {
        // Before defaulting to a LOSS, apply the conversion sweep's own
        // criteria (GH codex P1): evidence can land between sweep runs, and
        // this write sets archived_at — the sweep only scans unarchived
        // rows, so a false archived_unresolved here would be permanent.
        // customerConvertedSince fails toward converted on lookup errors
        // (guard-error), which must NOT mint a phantom conversion here.
        let disposition = 'archived_unresolved';
        try {
          const { whereConversionEligibilitySignal, whereNoConversionBeforeEstimate } = require('../services/estimate-conversion-guard');
          // EXACTLY the sweep's predicates (narrow paid-invoice/completed-
          // service evidence + none-before disqualifiers) — a pending
          // booking or customer stage must not mint a conversion here.
          const convertedRow = await db('estimates')
            .where({ id: estimate.id })
            .whereNotNull('customer_id')
            .modify(whereConversionEligibilitySignal)
            .modify(whereNoConversionBeforeEstimate)
            .first('id');
          if (convertedRow) disposition = 'converted_other_path';
        } catch { /* classification stays archived_unresolved */ }
        systemUpdates = {
          disposition,
          disposition_source: 'system',
          disposition_at: db.fn.now(),
        };
      }
      Object.assign(archiveUpdates, given?.updates || systemUpdates);
    }
    // Predicate on the OBSERVED state, not just id (codex pre-push P1
    // TOCTOU): a public decline / accept / conversion sweep committing
    // after the pre-read must not be overwritten by this stale archive
    // classification — the racing writer owns the row's story.
    const [updated] = await db('estimates')
      .where({ id: req.params.id, status: estimate.status })
      .whereNull('archived_at')
      .modify((q) => (estimate.disposition
        ? q.where({ disposition: estimate.disposition })
        : q.whereNull('disposition')))
      .update(archiveUpdates)
      .returning('*');
    if (!updated) {
      return res.status(409).json({ error: 'Estimate changed while you were archiving it. Refresh and retry.' });
    }
    // Post-write verification (GH codex P2): conversion evidence can commit
    // between the classification SELECT and the archive UPDATE, and the
    // sweep never rescans archived rows — so after a SYSTEM
    // archived_unresolved stamp, re-run the same predicates once. Evidence
    // seen now committed before this check and therefore effectively at
    // archive time; evidence landing later genuinely postdates archival.
    if (updated.disposition === 'archived_unresolved' && updated.disposition_source === 'system') {
      try {
        const { whereConversionEligibilitySignal, whereNoConversionBeforeEstimate } = require('../services/estimate-conversion-guard');
        const convertedNow = await db('estimates')
          .where({ id: updated.id })
          .whereNotNull('customer_id')
          .modify(whereConversionEligibilitySignal)
          .modify(whereNoConversionBeforeEstimate)
          .first('id');
        if (convertedNow) {
          const [upgraded] = await db('estimates')
            .where({ id: updated.id, disposition: 'archived_unresolved' })
            .update({ disposition: 'converted_other_path' })
            .returning('*');
          if (upgraded) return res.json(upgraded);
        }
      } catch { /* the unresolved stamp stands */ }
    }
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /:id/unarchive — pulls an archived estimate back into the default view.
router.post('/:id/unarchive', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    // A draft ARCHIVED by linkage invalidation is permanently
    // non-revivable (codex P0, PR #3304): its composed content —
    // recipient, address, pricing — belongs to the FORMER lead of a
    // repointed/unlinked call, and unarchiving would restore public-token
    // access and make the send claim succeed against the wrong customer.
    // The engine already rebuilt a corrected draft; this one is history.
    // Checked BEFORE the idempotent return (an invalidated-but-live row is
    // never blessed) and enforced ATOMICALLY in the UPDATE's own predicate
    // — a concurrent invalidation between read and write zero-rows into
    // the same 409 (codex P0 r16).
    const invalidatedMessage = 'This draft was invalidated by a call-linkage correction — its content belongs to a different lead. A corrected draft was rebuilt; this one cannot be unarchived.';
    // A draft SUPERSEDED by a clarify-reply re-draft is permanent too:
    // restoring it would put its stale fallback price and public token
    // back alongside the replacement.
    const supersededMessage = 'This draft was superseded by a re-priced replacement (customer answered the bedroom question). The replacement is the live draft; this one cannot be unarchived.';
    const markers = (() => {
      try {
        const data = typeof estimate.estimate_data === 'string'
          ? JSON.parse(estimate.estimate_data) : (estimate.estimate_data || {});
        return {
          invalidatedAt: data?.estimatorEngine?.linkage_invalidated_at || null,
          supersededAt: data?.estimatorEngine?.superseded_at || null,
        };
      } catch { return { invalidatedAt: null, supersededAt: null }; }
    })();
    if (markers.invalidatedAt) return res.status(409).json({ error: invalidatedMessage });
    if (markers.supersededAt) return res.status(409).json({ error: supersededMessage });
    if (!estimate.archived_at) return res.json(estimate);  // idempotent
    const [updated] = await db('estimates')
      .where({ id: req.params.id, status: estimate.status })
      // Observed-state guard, mirroring the archive route (codex pre-push
      // P1 TOCTOU): a concurrent decline/accept that resolved the archived
      // row owns its disposition — unarchiving from a stale pre-read must
      // not erase it.
      .whereNotNull('archived_at')
      .modify((q) => (estimate.disposition
        ? q.where({ disposition: estimate.disposition })
        : q.whereNull('disposition')))
      .whereRaw("estimate_data->'estimatorEngine'->>'linkage_invalidated_at' IS NULL")
      .whereRaw("estimate_data->'estimatorEngine'->>'superseded_at' IS NULL")
      .update({
        archived_at: null,
        updated_at: db.fn.now(),
        // A LIVE (sent/viewed) row can only have gotten its disposition from
        // the archive action — reviving the courtship un-classifies it, or a
        // later expiry would COALESCE-preserve a stale "archived" loss
        // (codex pre-push P1). Terminal rows (declined/expired/accepted)
        // keep theirs: those were stamped by their own resolution.
        ...(['sent', 'viewed'].includes(estimate.status) ? {
          disposition: null,
          disposition_source: null,
          disposition_at: null,
          disposition_note: null,
          competitor_name: null,
          competitor_price: null,
          // The archive path also wrote the legacy badge label — a revived
          // live row must not keep displaying a stale loss (codex P1).
          decline_reason: null,
        } : {}),
      })
      .returning('*');
    if (!updated) {
      // Zero rows: either a linkage marker (permanent) or a concurrent
      // writer moved the row. Re-read once to say which.
      const fresh = await db('estimates').where({ id: req.params.id }).first('status', 'archived_at', 'disposition');
      const changed = fresh && (fresh.status !== estimate.status || !fresh.archived_at || (fresh.disposition || null) !== (estimate.disposition || null));
      return res.status(409).json({ error: changed ? 'Estimate changed while you were unarchiving it. Refresh and retry.' : invalidatedMessage });
    }
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /api/admin/estimates/:id/follow-up — manually send a follow-up SMS
router.post('/:id/follow-up', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (!estimate.customer_phone) return res.status(400).json({ error: 'No phone on file' });
    if (estimate.status === 'accepted') return res.status(400).json({ error: 'Already accepted' });
    assertEstimateSendable(estimate);
    // Group-aware pricing-authority verdict (#3750, uncapped codex P0 r24):
    // this text carries the estimate link, and the link renders every
    // viewable sibling — a SERVER anchor beside an unverified sibling is
    // refused like any other send while the gate is on.
    if (gatedSendAuthorityPredicateApplies() && !(await estimateDeliverableUnderGate(db, estimate))) {
      return res.status(409).json({
        error: 'A property on this estimate\'s link has no engine-verified price — re-save it from the estimate tool before sending this follow-up.',
        code: 'PRICING_AUTHORITY_NOT_SERVER',
      });
    }

    const longUrl = `https://portal.wavespestcontrol.com/estimate/${estimate.token}`;
    const viewUrl = await shortenOrPassthrough(longUrl, {
      kind: 'estimate', entityType: 'estimates', entityId: estimate.id, customerId: estimate.customer_id,
      leadId: await leadIdForEstimate(estimate),
      channel: 'sms', purpose: 'estimate_followup_manual',
    });
    const firstName = estimate.customer_name?.split(' ')[0] || 'there';

    const msg = req.body.message || await renderTemplate('estimate_followup_unviewed', {
      first_name: firstName,
      estimate_url: viewUrl,
    }, {
      workflow: 'admin_estimate_followup',
      entity_type: 'estimate',
      entity_id: estimate.id,
    });
    if (!msg) return res.status(422).json({ error: 'SMS template estimate_followup_unviewed is missing or inactive' });

    const smsResult = await sendCustomerMessage({
      to: estimate.customer_phone,
      body: msg,
      channel: 'sms',
      audience: estimate.customer_id ? 'customer' : 'lead',
      purpose: 'estimate_followup',
      customerId: estimate.customer_id || undefined,
      estimateId: estimate.id,
      identityTrustLevel: estimate.customer_id ? 'phone_matches_customer' : 'phone_provided_unverified',
      consentBasis: estimate.customer_id ? undefined : {
        status: 'transactional_allowed',
        source: 'admin_estimate_follow_up',
        capturedAt: estimate.created_at || new Date().toISOString(),
      },
      entryPoint: 'admin_estimate_follow_up',
      metadata: { original_message_type: 'estimate_followup_manual' },
    });
    if (!smsResult.sent) {
      return res.status(422).json({ error: smsResult.reason || smsResult.code || 'SMS send blocked/failed' });
    }
    await db('estimates').where({ id: estimate.id }).update({
      follow_up_count: db.raw('COALESCE(follow_up_count, 0) + 1'),
      last_follow_up_at: db.fn.now(),
    });

    res.json({ success: true });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// POST /api/admin/estimates/:id/send-booking-link — manual override that
// mirrors the post-accept one-time booking SMS. Re-fires the same flow the
// system auto-runs when a customer accepts a one-time estimate: pre-select
// the service in /book via bookingServiceFor(), use the
// `estimate_accepted_onetime` template (same first_name + service_label +
// booking_url vars). Useful when (a) the auto SMS missed (carrier block,
// no phone at accept time, etc.), (b) admin marked accepted from verbal
// yes and the customer never got the booking text, or (c) operator wants
// to nudge a viewed estimate straight into scheduling without the accept
// step.
router.post('/:id/send-booking-link', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (!estimate.customer_phone) return res.status(400).json({ error: 'No phone on file' });

    // Status gate — only active offers can be booked. Drafts aren't real
    // offers yet; declined/expired/archived are intentionally closed and
    // shouldn't be quietly reopened by a self-schedule text.
    if (!['sent', 'viewed', 'accepted'].includes(estimate.status)) {
      return res.status(400).json({
        error: `Booking link can only be sent for sent/viewed/accepted estimates. Current status: ${estimate.status}.`,
      });
    }
    if (estimate.archived_at) {
      return res.status(400).json({ error: 'Estimate is archived. Unarchive first.' });
    }

    // Invoice mode skips the booking flow by design — acceptance generates
    // an invoice immediately and there's no slot to pick. Texting a /book
    // URL would bypass the pay-link delivery the customer is expecting.
    if (estimate.bill_by_invoice) {
      return res.status(400).json({
        error: 'Invoice mode is on for this estimate — booking link not applicable. Disable Invoice mode first.',
      });
    }
    assertEstimateManagerApprovalResolved(estimate);

    // Parse the same one-time line the auto-accept flow uses so we can
    // pre-select the service in /book. A missing one-time line on a
    // recurring estimate is a hard refusal: recurring customers belong in
    // onboarding, not the self-booking flow.
    let oneTimeLabel = '';
    try {
      const estData = typeof estimate.estimate_data === 'string'
        ? JSON.parse(estimate.estimate_data)
        : estimate.estimate_data;
      const { oneTimeList } = acceptanceServiceLists(estData || {});
      oneTimeLabel = oneTimeList[0]?.name || '';
    } catch (_) { /* fall through to recurring-only refusal below */ }
    if (!oneTimeLabel && Number(estimate.monthly_total || 0) > 0) {
      return res.status(400).json({
        error: 'No one-time service on this estimate — recurring offers route through onboarding, not /book.',
      });
    }
    const primarySvc = bookingServiceFor(oneTimeLabel);

    // Reservation collision guard. If the estimate is already linked to a
    // confirmed scheduled service, this customer has already picked a
    // slot — texting a fresh /book URL would invite a second appointment.
    try {
      const estData = typeof estimate.estimate_data === 'string'
        ? JSON.parse(estimate.estimate_data)
        : estimate.estimate_data;
      const linkedSvcId = estData?.scheduled_service_id || null;
      if (linkedSvcId) {
        const linked = await db('scheduled_services')
          .where({ id: linkedSvcId, status: 'confirmed' })
          .first();
        if (linked) {
          return res.status(409).json({
            error: `Customer already has a confirmed appointment on ${linked.scheduled_date} for this estimate. Use the Schedule view to manage the booking.`,
          });
        }
      }
    } catch (_) { /* on parse failure fall through — no false positive */ }

    // estimate_id stamps scheduled_services.source_estimate_id (same
    // correlation the accept-flow links carry) and the namespaced accept
    // token lets the recipient through the customers-only /book gate
    // (GATE_BOOKING_CUSTOMERS_ONLY) — without it this admin-sent link
    // dead-ends at the gate's 403 for anyone not yet on file. The token is
    // never a pricing input (wrong namespace for the pricing-handoff check).
    const gateToken = mintEstimateAcceptToken(
      estimate.id,
      estimate.accepted_at ? new Date(estimate.accepted_at).getTime() : Date.now(),
    );
    const longBookingUrl = `https://portal.wavespestcontrol.com/book?service=${primarySvc.id}&source=admin-manual-booking-resend&estimate_id=${estimate.id}${gateToken ? `&accept_token=${encodeURIComponent(gateToken)}` : ''}`;
    const bookingUrl = await shortenOrPassthrough(longBookingUrl, {
      kind: 'booking', entityType: 'estimates', entityId: estimate.id, customerId: estimate.customer_id,
      leadId: await leadIdForEstimate(estimate),
      channel: 'sms', purpose: 'estimate_booking_link',
    });
    const firstName = estimate.customer_name?.split(' ')[0] || 'there';

    // Use the same template as the post-accept SMS so the customer sees a
    // consistent voice. Admin can still override via req.body.message.
    const msg = req.body?.message || (await renderTemplate(
      'estimate_accepted_onetime',
      { first_name: firstName, service_label: primarySvc.label, booking_url: bookingUrl },
    ));
    if (!msg) return res.status(422).json({ error: 'SMS template estimate_accepted_onetime is missing or inactive' });

    const smsResult = await sendCustomerMessage({
      to: estimate.customer_phone,
      body: msg,
      channel: 'sms',
      audience: estimate.customer_id ? 'customer' : 'lead',
      purpose: 'estimate_followup',
      customerId: estimate.customer_id || undefined,
      estimateId: estimate.id,
      identityTrustLevel: estimate.customer_id ? 'phone_matches_customer' : 'phone_provided_unverified',
      consentBasis: estimate.customer_id ? undefined : {
        status: 'transactional_allowed',
        source: 'admin_estimate_send_booking_link',
        capturedAt: estimate.created_at || new Date().toISOString(),
      },
      entryPoint: 'admin_estimate_send_booking_link',
      metadata: {
        original_message_type: 'estimate_accepted_onetime_manual_resend',
        booking_service_id: primarySvc.id,
        booking_service_label: primarySvc.label,
      },
    });
    if (!smsResult.sent) {
      return res.status(422).json({ error: smsResult.reason || smsResult.code || 'SMS send blocked/failed' });
    }
    await db('estimates').where({ id: estimate.id }).update({
      follow_up_count: db.raw('COALESCE(follow_up_count, 0) + 1'),
      last_follow_up_at: db.fn.now(),
    });
    logger.info(`[estimates] Manual booking-link SMS sent for estimate ${estimate.id} → ${primarySvc.id}`);
    res.json({ success: true, bookingServiceId: primarySvc.id, bookingServiceLabel: primarySvc.label });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// POST /api/admin/estimates/:id/extend — push expires_at forward by N days
// and re-arm the expiring-nudge so the customer hears about the new
// deadline. Used when Adam knows a customer is still considering and
// doesn't want the estimate to lapse mid-decision.
//
// Body: { days: 7 | 14 | 30 | 90 | <any 1-180 int> }
// Send SMS by default; pass { silent: true } to skip the customer text.
// Core (expiry anchoring, status revival, nudge re-arm, estimate_extended
// SMS) lives in services/estimate-extension.js, shared with the public
// expired-screen auto-grant — behavior here is 1:1 with the pre-extraction
// inline version, including the 422-after-write template quirk.
router.post('/:id/extend', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

    const days = Number.parseInt(req.body?.days, 10);
    const { extendEstimate } = require('../services/estimate-extension');
    const { newExpiry, status, smsResult, emailResult } = await extendEstimate({
      estimate,
      days,
      silent: !!req.body?.silent,
      entryPoint: 'admin_estimate_extend',
      workflow: 'admin_estimate_extend',
      smsMetadata: { original_message_type: 'estimate_extended_manual' },
    });
    if (smsResult.reason === 'template_missing') {
      return res.status(422).json({ error: 'SMS template estimate_extended is missing or inactive' });
    }

    res.json({
      success: true,
      expires_at: newExpiry.toISOString(),
      days_added: days,
      status,
      sms: { sent: !!smsResult.sent, reason: smsResult.reason || null },
      email: { sent: !!emailResult?.sent, reason: emailResult?.reason || null },
    });
  } catch (err) {
    if (err.statusCode === 400 || err.statusCode === 409) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    next(err);
  }
});

// POST /api/admin/estimates/:id/mark-accepted — admin records a verbal yes.
// This is intentionally separate from PATCH status edits so accepted_at is
// stamped for funnel reporting and acceptance side effects run once.
router.post('/:id/mark-accepted', async (req, res, next) => {
  try {
    // The DURABLE call-side verdict blocks a MANUAL acceptance too (codex
    // P0, PR #3304 GH r10b): when estimate-side invalidation failed — the
    // exact case the queued marker covers — the public routes and the
    // delivery paths already refuse, but recording a verbal yes here
    // would still convert the customer and mint billing off a
    // wrong-identity or rejected-call estimate.
    {
      const row = await db('estimates').where({ id: req.params.id }).first('estimate_data');
      let data = row?.estimate_data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { data = null; }
      }
      if (data && typeof data === 'object') {
        const blocked = await callSideBlockForEstimateData(db, data);
        if (blocked) {
          return res.status(409).json({
            error: 'This estimate is quarantined by a call-linkage correction and cannot be accepted. Rebuild it from the corrected call.',
          });
        }
      }
    }
    const result = await markEstimateManuallyAccepted({
      estimateId: req.params.id,
      adminUserId: req.technicianId,
      source: req.body?.source || 'verbal_yes',
      billingTerm: req.body?.billingTerm || 'standard',
    });
    clearRouteCacheForRequest(req, ['/admin/dashboard']);
    res.json({ success: true, ...result });
  } catch (err) {
    // err.code rides along (same shape as POST /:id/send): the converter's
    // fail-closed pricing refusals (PER_APPLICATION_ADD_ON_UNPRICED,
    // LEGACY_MONTHLY_TERMITE_UNCONVERTIBLE — docs/public-route-contracts.md)
    // reach the admin UI machine-distinguishable (pre-push codex P1 on #3751).
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    next(err);
  }
});

// Estimate status values backed by the estimates_status_check constraint
// (models/migrations/20260518000003_estimate_scheduled_send_claims.js).
const ESTIMATE_STATUSES = [
  'draft', 'scheduled', 'sending', 'send_failed', 'sent', 'viewed',
  'accepted', 'declined', 'expired',
];

// The only status the admin UI writes through the generic PATCH is
// 'declined' (decline modals in EstimatePage / EstimateModalsV2 /
// OpportunityActions). Every other transition is owned by a deliberate
// path that stamps timestamps, locks pricing, or fires side effects:
//   accepted              → POST /:id/mark-accepted or the public accept
//   scheduled/sending/
//   send_failed/sent      → POST /:id/send + the scheduled-send cron claims
//   expired               → expiry cron; revival via POST /:id/extend
// Terminal statuses are not writable here: flipping accepted→sent would
// re-arm the public accept link (its guard is whereNotIn accepted/declined/
// expired) and re-run EstimateConverter — tier/monthly_rate rewritten and a
// duplicate first-application invoice.
const PATCHABLE_STATUS_TRANSITIONS = {
  draft: ['declined'],
  scheduled: ['declined'],
  send_failed: ['declined'],
  sent: ['declined'],
  viewed: ['declined'],
  // sending / accepted / declined / expired: no generic-PATCH transitions
};

function resolveEstimateStatusPatch(currentStatus, nextStatus) {
  if (typeof nextStatus !== 'string' || !ESTIMATE_STATUSES.includes(nextStatus)) {
    return {
      ok: false,
      httpStatus: 400,
      error: `Invalid status '${String(nextStatus)}'. Must be one of: ${ESTIMATE_STATUSES.join(', ')}.`,
    };
  }
  if (nextStatus === currentStatus) return { ok: true, noop: true };
  const allowed = PATCHABLE_STATUS_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(nextStatus)) {
    return {
      ok: false,
      httpStatus: 409,
      error: `Cannot change status from '${currentStatus}' to '${nextStatus}' here. Use the dedicated flow instead (mark-accepted, send, or extend).`,
    };
  }
  return { ok: true, noop: false };
}

// PATCH /api/admin/estimates/:id — update priority, decline reason, status
router.patch('/:id', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

    const updates = {};
    if (req.body.isPriority !== undefined) updates.is_priority = req.body.isPriority;
    // Decline reason is now a NORMALIZED disposition (estimator audit
    // 2026-08-29 P0). Clients send `disposition` (a staff code from
    // estimate-disposition.js, plus competitorName/competitorPrice/
    // dispositionNote) — a legacy `declineReason` label alone still maps to
    // a code so the pipeline's free-text action and older tabs keep working.
    // The human label is preserved in decline_reason for existing badges.
    const wantsDisposition = req.body.disposition !== undefined || req.body.declineReason !== undefined;
    if (wantsDisposition) {
      // Loss fields land ONLY on a decline transition in this same request
      // or a reason edit on an already-declined row (codex pre-push P1): a
      // live estimate stamped here would carry the stale staff loss through
      // expiry/conversion via their COALESCEs. Archive reasons belong to
      // the archive endpoint.
      if (req.body.status !== 'declined' && estimate.status !== 'declined') {
        return res.status(400).json({ error: 'A decline reason can only be set while declining the estimate (or editing an already-declined one).' });
      }
      const { staffDispositionUpdates } = require('../services/estimate-disposition');
      const verdict = staffDispositionUpdates(req.body);
      if (verdict.error) return res.status(400).json({ error: verdict.error });
      Object.assign(updates, verdict.updates);
    }
    if (req.body.showOneTimeOption !== undefined) {
      const nextShowOneTimeOption = !!req.body.showOneTimeOption;
      const deliveryError = nextShowOneTimeOption ? validateEstimateDeliveryOptions({
        showOneTimeOption: true,
        billByInvoice: false,
        onetimeTotal: estimate.onetime_total,
        monthlyTotal: estimate.monthly_total,
        annualTotal: estimate.annual_total,
        estimateData: estimate.estimate_data,
      }) : null;
      if (deliveryError) return res.status(400).json({ error: deliveryError });
      updates.show_one_time_option = nextShowOneTimeOption;
    }
    if (req.body.billByInvoice !== undefined) {
      const nextBillByInvoice = !!req.body.billByInvoice;
      const deliveryError = nextBillByInvoice ? validateEstimateDeliveryOptions({
        showOneTimeOption: false,
        billByInvoice: true,
        onetimeTotal: estimate.onetime_total,
        monthlyTotal: estimate.monthly_total,
        annualTotal: estimate.annual_total,
        estimateData: estimate.estimate_data,
      }) : null;
      if (deliveryError) return res.status(400).json({ error: deliveryError });
      // Structured payment terms exist only where invoice billing consumes
      // them — turning invoice mode OFF while the authored proposal still
      // promises a term would strand a promise no billing path enforces
      // (and Mark won would then 409). Same invariant as the proposal PUT
      // guard, enforced on the other side (codex #3297 r4b).
      if (!nextBillByInvoice && estimate.bill_by_invoice
        && parseEstimateData(estimate.estimate_data)?.proposal?.commercialTerms?.paymentTerms) {
        return res.status(400).json({ error: 'This proposal has structured payment terms, which require invoice billing. Clear the payment terms in the proposal editor first.' });
      }
      updates.bill_by_invoice = nextBillByInvoice;
    }
    if (req.body.status !== undefined) {
      // One-tap purchase drafts take NO generic status transitions (Codex
      // #3395 r13 P2): a staff decline flips the row out of 'draft', which
      // strands the open purchase ledger (confirm rejects; neither cleanup
      // sweep reclaims a declined row) and contaminates the declined
      // pipeline with an internal draft the customer never received.
      if (estimate.source === 'one_tap_purchase' && req.body.status !== estimate.status) {
        return res.status(400).json({ error: 'This is an internal one-tap purchase draft — its lifecycle is owned by the purchase flow.' });
      }
      const verdict = resolveEstimateStatusPatch(estimate.status, req.body.status);
      if (!verdict.ok) return res.status(verdict.httpStatus).json({ error: verdict.error });
      // A clarify re-price HOLD refuses the generic decline (codex r5 P0 on
      // #3804): a held row parked send_failed that staff flipped to
      // 'declined' would keep its stale whole-building quote as a terminal
      // nothing re-prices. Lift the hold first (revise the estimate with the
      // answered unit, or archive it). Mirrored on the UPDATE below.
      if (!verdict.noop && siblingRepricePending(estimate)) {
        return res.status(409).json({ error: 'This estimate is held for a re-price (a customer clarify reply). Revise it with the answered unit, or archive it, instead of declining.' });
      }
      // Same-status writes are a no-op for the status column (no declined_at
      // re-stamp); other fields in the same request still persist below.
      if (!verdict.noop) {
        updates.status = req.body.status;
        if (req.body.status === 'declined') {
          updates.declined_at = db.fn.now();
          // A decline without a reason is exactly the unexplained loss the
          // disposition layer exists to end — the modals always send one;
          // this closes the API path.
          if (!updates.disposition) {
            return res.status(400).json({ error: 'A decline reason (disposition) is required to mark an estimate declined.' });
          }
        }
      }
    }

    if (Object.keys(updates).length === 0) return res.json({ success: true });

    // Status flips are guarded optimistically: the UPDATE only lands while
    // the row still holds the status we validated against, so a customer
    // accept racing this PATCH can't be silently overwritten.
    let updateQuery = db('estimates').where({ id: req.params.id });
    if (updates.status !== undefined) updateQuery = updateQuery.where({ status: estimate.status }).whereRaw(REPRICE_PENDING_ABSENT_SQL);
    const changesDeliveryOptions = updates.show_one_time_option !== undefined || updates.bill_by_invoice !== undefined;
    if (changesDeliveryOptions) {
      updateQuery = updateQuery.whereNot({ status: 'sending' }).whereRaw(DELIVERY_CLAIM_NOT_LIVE_SQL);
      updates.updated_at = db.fn.now();
    }
    // Turning invoice mode OFF is predicated on the stored proposal STILL
    // having no structured payment term at write time — the pre-read guard
    // above can race a concurrent proposal PUT that saves one (the PUT's
    // write predicates on bill_by_invoice=true; this is the mirror side, so
    // the two writes serialize instead of interleaving into a promised term
    // with no billing path — codex #3297 r4d). JSONB path verified against
    // the live schema.
    if (updates.bill_by_invoice === false) {
      updateQuery = updateQuery.whereRaw(
        "COALESCE(estimate_data->'proposal'->'commercialTerms'->>'paymentTerms', '') = ''",
      );
    }
    const updatedCount = changesDeliveryOptions ? await db.transaction(async (trx) => {
      // Published siblings stay sent/viewed during a group handoff. Use the
      // same group-then-row lock and in-flight guard as a full revision.
      await lockScheduledGroupGuardGroups(trx, estimate);
      const locked = await trx('estimates').where({ id: estimate.id }).forUpdate().first();
      if (!locked || estimateEditVersion(locked) !== estimateEditVersion(estimate)) return 0;
      await assertNoRevisionDuringGroupSend(trx, locked);
      return updateQuery.transacting(trx).update(updates);
    }) : await updateQuery.update(updates);
    if (!updatedCount) {
      return res.status(409).json({ error: 'Estimate changed while you were editing. Refresh and retry.' });
    }
    logger.info(`[estimates] Updated estimate ${req.params.id}: ${JSON.stringify(Object.keys(updates))}`);
    res.json({ success: true });
  } catch (err) {
    if (err.statusCode === 409) return res.status(409).json({ error: err.message });
    next(err);
  }
});

// DELETE /api/admin/estimates/:id — delete a draft estimate only.
// Sent/customer-facing estimates must stay auditably available; use archive
// for closed rows instead of breaking public links.
router.delete('/:id', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ id: req.params.id }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (estimate.status !== 'draft') {
      return res.status(400).json({ error: 'Only draft estimates can be deleted. Archive closed estimates instead.' });
    }
    // One-tap ledger rows FK this estimate (NO ACTION): without removing
    // them first the delete below dies on 23503. A completed ledger row is
    // a consent artifact and must never be deleted — it also implies the
    // estimate is accepted, so the draft-only guard above already blocks it;
    // belt-and-braces refuse anyway. Live holds are the 15-min sweeper's
    // problem once the ledger row is gone.
    const oneTapRows = await db('one_tap_purchases')
      .where({ estimate_id: req.params.id })
      .select('id', 'status');
    if (oneTapRows.some((r) => r.status === 'completed')) {
      return res.status(400).json({ error: 'This estimate carries a completed one-tap purchase and cannot be deleted.' });
    }
    // A reserved attempt's LIVE hold also references this estimate
    // (scheduled_services.source_estimate_id, NO ACTION) — release it
    // through the slot-reservation mechanism first or the estimate delete
    // below still 23503s until the hold sweeper runs.
    const liveHolds = await db('scheduled_services')
      .where({ source_estimate_id: req.params.id })
      .whereNull('customer_id')
      .whereNotNull('reservation_expires_at')
      .select('id');
    for (const hold of liveHolds) {
      await require('../services/slot-reservation').releaseReservation({
        scheduledServiceId: hold.id,
        estimateId: req.params.id,
      });
    }
    await db.transaction(async (trx) => {
      if (oneTapRows.length) {
        await trx('one_tap_purchases')
          .whereIn('id', oneTapRows.map((r) => r.id))
          .whereNot({ status: 'completed' })
          .del();
      }
      await trx('leads')
        .where({ estimate_id: req.params.id })
        .update({ estimate_id: null, updated_at: new Date() });
      await trx('estimates').where({ id: req.params.id }).del();
    });
    logger.info(`[estimates] Deleted estimate ${req.params.id}`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// The old POST /cleanup-demo endpoint (bulk-delete estimates matching a
// hardcoded list of seed customer names) is intentionally GONE: it was live
// in production, reachable by any staff token, and deleted by name match
// alone — a real customer sharing a seed name would lose sent/accepted
// estimates permanently. One-off seed cleanup belongs in ops/agents/ scripts,
// not a standing route.

router._internals = {
  clearQuoteRequirementFlags,
  resolveBlockingAutomationForProposal,
  clearStaleProposalDelivery,
  assertEstimateSendable,
  sendRequiresServerPricingFor,
  isAuthoredProposalRow,
  PROPOSAL_PROVENANCE_SOURCE,
  shadowLogFallbackDelivery,
  SERVER_PRICING_AUTHORITY_SQL,
  GATED_SEND_AUTHORITY_SQL,
  assertAutoSendPricingAuthority,
  findGroupSiblingBlockingSend,
  notifyPricingFallbackAfterCommit,
  assertEstimateManagerApprovalResolved,
  leadEstimateAutomationSummary,
  estimateDataHasBlockingLeadAutomation,
  estimateMatchesSentOnlyScope,
  sendEstimateEmail,
  estimateEmailIdempotencyKey,
  smtpFallbackAllowed,
  resolveEstimateStatusPatch,
  applyEstimateSearchFilter,
};

module.exports = router;
// Publish-without-delivery consumers (report click-to-estimate mint) freeze
// the SAME send snapshot the send/sibling-publication paths do — one bundle
// builder, so a minted estimate's locked price replays exactly like a sent
// one. Lazy-required by services to avoid load-order cycles.
module.exports.buildEstimateSendSnapshot = buildEstimateSendSnapshot;
module.exports.applyLeadServiceForSend = applyLeadServiceForSend;
module.exports.revertLeadServiceForSend = revertLeadServiceForSend;
module.exports.markLeadServiceRevertPending = markLeadServiceRevertPending;
