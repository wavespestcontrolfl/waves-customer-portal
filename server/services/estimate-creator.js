/**
 * EstimateCreator — the single write path for new estimates.
 *
 * Every current write site (admin-estimates, intelligence-bar,
 * lead-webhook, lead-response-tools, voice-agent) gets migrated through
 * this module in Step 4. Direct inserts to `estimates` are deprecated
 * once that migration is complete.
 *
 * Guarantees:
 *   - Whitelisted source / pricing_source / reason vocab, enforced
 *     before any DB work
 *   - Exactly one v1 row in estimate_versions per estimate, written
 *     atomically with the estimates row in a single transaction
 *   - `estimates.current_version_id` always set on return
 *   - 256-bit hex token (crypto.randomBytes(32)) — replaces the 32-bit
 *     slug-based token the admin path was using
 *
 * Does NOT do:
 *   - Any SMS / email / notification / onboarding side effects. Those
 *     belong on /:id/send (for admin) and /:token/accept (for customer).
 *   - Mismatch detection between client and server totals. Column
 *     exists in the versions table for forward compat; the comparison
 *     waits on Session 11 when the modular server engine emits the
 *     tier/modifier/urgency/specItems fields the deprecated client
 *     engine currently produces. Until then there's nothing reliable
 *     to compare against.
 *   - tool_executions logging. Separate, smaller PR.
 */
const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { generateEstimate } = require('./pricing-engine');

// ---------- whitelists ----------

const VALID_PRICING_SOURCES = ['server_engine', 'client_submitted', 'placeholder'];

// Matches the existing estimates.source column vocabulary so BI queries
// over created_by_type don't need a translation layer.
const VALID_CREATED_BY_TYPES = [
  'manual',
  'lead_webhook',
  'lead_agent',
  'voice_agent',
  'ai_agent',
  'self_booked',
];

const VALID_REASONS_PLACEHOLDER = [
  'lead_webhook_placeholder',
  'lead_agent_placeholder',
  'voice_agent_placeholder',
];

// Only these sources may produce a placeholder (no engineInputs, no
// prebuiltData). Admin (`manual`) and AI agent paths must always pass
// something — otherwise the caller is a bug.
const PLACEHOLDER_ALLOWED_SOURCES = ['lead_webhook', 'lead_agent', 'voice_agent', 'self_booked'];

// ---------- validation ----------

function validate({ source, engineInputs, prebuiltData, customerId, customerPhone }) {
  if (!VALID_CREATED_BY_TYPES.includes(source)) {
    throw new Error(`invalid source: ${source}`);
  }

  const bothNull = engineInputs == null && prebuiltData == null;
  const bothSet = engineInputs != null && prebuiltData != null;

  if (bothSet) {
    throw new Error('pass engineInputs OR prebuiltData, not both');
  }

  if (bothNull && !PLACEHOLDER_ALLOWED_SOURCES.includes(source)) {
    throw new Error(`source ${source} requires engineInputs or prebuiltData`);
  }

  if (!customerId && !customerPhone) {
    throw new Error('customerId or customerPhone required');
  }
}

// ---------- pricing ----------

function buildPricing({ source, engineInputs, prebuiltData, clientTotals }) {
  // Case A — engine inputs → authoritative server pricing.
  if (engineInputs != null) {
    let engineResult;
    try {
      engineResult = generateEstimate(engineInputs);
    } catch (err) {
      const wrapped = new Error(`pricing engine failed: ${err.message}`);
      wrapped.stack = err.stack;
      throw wrapped;
    }
    const summary = engineResult?.summary || {};
    return {
      estimateData: { engineInputs, engineResult },
      pricingSource: 'server_engine',
      totals: {
        monthly: numOrNull(summary.recurringMonthlyAfterDiscount),
        annual: numOrNull(summary.recurringAnnualAfterDiscount),
        onetime: numOrNull(summary.oneTimeTotal),
      },
      waveguardTier: engineResult?.waveGuard?.tier ?? null,
      pricingVersion: engineResult?.pricingVersion ?? null,
    };
  }

  // Case B — client-submitted data (admin path today, until Session 11).
  if (prebuiltData != null) {
    return {
      estimateData: prebuiltData,
      pricingSource: 'client_submitted',
      totals: {
        monthly: numOrNull(clientTotals?.monthly),
        annual: numOrNull(clientTotals?.annual),
        onetime: numOrNull(clientTotals?.onetime),
      },
      waveguardTier: prebuiltData?.waveguard_tier ?? prebuiltData?.tier ?? null,
      pricingVersion: null,
    };
  }

  // Case C — placeholder (lead_webhook / lead_agent / voice_agent /
  // self_booked). No totals, no estimate_data body. Admin fills in via
  // the admin UI later, which creates v2.
  return {
    estimateData: {},
    pricingSource: 'placeholder',
    totals: { monthly: null, annual: null, onetime: null },
    waveguardTier: null,
    pricingVersion: null,
  };
}

function numOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------- reason for the v1 row ----------

function reasonFor(source, pricingSource) {
  if (pricingSource !== 'placeholder') return 'initial';
  const candidate = `${source}_placeholder`;
  if (!VALID_REASONS_PLACEHOLDER.includes(candidate)) {
    throw new Error(
      `placeholder reason '${candidate}' not whitelisted — add to VALID_REASONS_PLACEHOLDER ` +
      `if ${source} is a legitimate placeholder source`
    );
  }
  return candidate;
}

// ---------- main ----------

async function createEstimate({
  source,
  createdById,
  customerId,
  customerName,
  customerPhone,
  customerEmail,
  address,
  category,
  engineInputs,
  prebuiltData,
  clientTotals,
  notes,
  satelliteUrl,
  serviceInterest,
  urgency,
  isPriority,
  leadSourceId,
  expiresInDays,
}) {
  validate({ source, engineInputs, prebuiltData, customerId, customerPhone });

  const pricing = buildPricing({ source, engineInputs, prebuiltData, clientTotals });

  if (!VALID_PRICING_SOURCES.includes(pricing.pricingSource)) {
    throw new Error(`pricing_source ${pricing.pricingSource} not in whitelist`);
  }

  const reason = reasonFor(source, pricing.pricingSource);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + (expiresInDays || 7) * 86400000);

  // created_by_technician_id only makes sense for sources that run under
  // an admin/tech JWT. Webhook + autonomous-agent sources leave it null.
  const createdByTechnicianId =
    source === 'manual' || source === 'ai_agent' ? createdById || null : null;

  const estimatesRow = {
    customer_id: customerId || null,
    created_by_technician_id: createdByTechnicianId,
    estimate_data: JSON.stringify(pricing.estimateData),
    monthly_total: pricing.totals.monthly,
    annual_total: pricing.totals.annual,
    onetime_total: pricing.totals.onetime,
    waveguard_tier: pricing.waveguardTier,
    customer_name: customerName || null,
    customer_phone: customerPhone || null,
    customer_email: customerEmail || null,
    address: address || null,
    category: category || 'RESIDENTIAL',
    token,
    status: 'draft',
    source,
    service_interest: serviceInterest || null,
    urgency: urgency != null ? urgency : null,
    is_priority: !!isPriority,
    notes: notes || null,
    satellite_url: satelliteUrl || null,
    lead_source_id: leadSourceId || null,
    expires_at: expiresAt,
  };
  // Only stamp pricing_version when the engine reported one — otherwise
  // let the column's default ('v4.2') apply. Keeps the column's source
  // of truth in one place.
  if (pricing.pricingVersion) {
    estimatesRow.pricing_version = pricing.pricingVersion;
  }

  const { estimateId, versionId } = await db.transaction(async (trx) => {
    const [estRow] = await trx('estimates').insert(estimatesRow).returning('id');
    const estimateId = estRow.id || estRow;

    const [verRow] = await trx('estimate_versions').insert({
      estimate_id: estimateId,
      version_number: 1,
      estimate_data: JSON.stringify(pricing.estimateData),
      monthly_total: pricing.totals.monthly,
      annual_total: pricing.totals.annual,
      onetime_total: pricing.totals.onetime,
      waveguard_tier: pricing.waveguardTier,
      pricing_version: pricing.pricingVersion,
      pricing_source: pricing.pricingSource,
      created_by_type: source,
      created_by_id: createdById || null,
      reason,
      pricing_mismatch: null,
    }).returning('id');
    const versionId = verRow.id || verRow;

    await trx('estimates').where({ id: estimateId }).update({ current_version_id: versionId });

    return { estimateId, versionId };
  });

  logger.info('[estimate-creator] created', {
    estimateId,
    token: token.substring(0, 8) + '...',
    source,
    pricingSource: pricing.pricingSource,
    hasEngineInputs: !!engineInputs,
    hasPrebuiltData: !!prebuiltData,
    monthly: pricing.totals.monthly,
  });

  return {
    id: estimateId,
    token,
    versionId,
    pricingSource: pricing.pricingSource,
  };
}

module.exports = {
  createEstimate,
  VALID_PRICING_SOURCES,
  VALID_CREATED_BY_TYPES,
  VALID_REASONS_PLACEHOLDER,
  PLACEHOLDER_ALLOWED_SOURCES,
};
