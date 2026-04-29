/**
 * Intelligence Bar — Quoting Agent Tools
 * server/services/intelligence-bar/estimate-tools.js
 *
 * Lets the operator delegate edge-case quoting to Claude. Agent enriches the
 * address, calls the v1 pricing engine, gathers calibration context, then
 * writes a draft estimate (status='draft', source='ai_agent') with structured
 * reasoning in notes. Never sends. Admin reviews + sends through the normal
 * EstimatePage flow.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { generateEstimate } = require('../pricing-engine');
const { shortenOrPassthrough } = require('../short-url');

const RENTCAST_KEY = process.env.RENTCAST_API_KEY || '6dfcb2eaa9f34bf285e101b74e1a3ef6';
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyCvzQ84QWUKMby5YcbM8MhDBlEZ2oF7Bsk';

const ESTIMATE_TOOLS = [
  {
    name: 'lookup_property',
    description: `Enrich an address with property data (sqft, lot size, year built, beds/baths) via RentCast and a satellite image via Google. Always call this before compute_estimate when sqft/lot are not user-provided.
Use for: any address-driven quote where the operator only gave a street address.`,
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Full street address (e.g. "1234 Main St, Bradenton FL 34203")' },
      },
      required: ['address'],
    },
  },
  {
    name: 'compute_estimate',
    description: `Run inputs through the v1 pricing engine (generateEstimate). Returns the full summary including before/after-discount monthly + annual recurring, one-time totals, WaveGuard tier, and per-service breakdown. NEVER quote a price without calling this first. If the engine produces zero or fails, that is a signal the scenario is outside scope — flag uncertainty, do not invent a price.
Use for: every standard residential quote (pest, lawn, mosquito, tree & shrub, termite, rodent).`,
    input_schema: {
      type: 'object',
      properties: {
        homeSqFt: { type: 'number', description: 'Home interior square footage' },
        lotSqFt: { type: 'number', description: 'Lot size in square feet (defaults to ~4× homeSqFt if unknown)' },
        stories: { type: 'number', description: 'Number of stories (1, 2, or 3). Default 1.' },
        propertyType: { type: 'string', description: 'Property type (e.g. "Single Family", "Townhouse", "Condo"). Default "Single Family".' },
        services: {
          type: 'object',
          description: 'Which services to include. Each key optional. Pest: { frequency: "quarterly"|"bimonthly"|"monthly" }. Lawn: { track: "st_augustine"|"bermuda"|"zoysia"|"bahia", tier: "basic"|"enhanced"|"premium" }. Mosquito: { tier: "essential"|"enhanced"|"premium" }. Tree & shrub: { frequency: "quarterly" }.',
          properties: {
            pest: { type: 'object' },
            lawn: { type: 'object' },
            mosquito: { type: 'object' },
            treeShrub: { type: 'object' },
            termite: { type: 'object' },
            rodent: { type: 'object' },
          },
        },
      },
      required: ['homeSqFt', 'services'],
    },
  },
  {
    name: 'read_pricing_config',
    description: `Read current pricing engine constants from the pricing_config table. Useful for answering "what's the current bedroom multiplier?" or "what does the engine think a quarterly pest visit costs?"
Use for: explaining where a number came from, or sanity-checking the engine output.`,
    input_schema: {
      type: 'object',
      properties: {
        config_key: { type: 'string', description: 'Specific config key to fetch (exact match)' },
        category: { type: 'string', description: 'Filter by category (e.g. "pest", "lawn", "waveguard", "labor")' },
      },
    },
  },
  {
    name: 'recent_pricing_changes',
    description: `Get the last N entries from pricing_changelog. Useful when the operator asks "did pricing change recently?" or when calibrating a quote that feels off.
Use for: change-of-pricing context before drafting an estimate.`,
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many recent entries (default 10)' },
        category: { type: 'string', description: 'Filter by category (bug|leak|rule|cost|architecture|documentation|infrastructure)' },
      },
    },
  },
  {
    name: 'find_similar_estimates',
    description: `Find recent estimates with similar monthly_total and/or service interest. Pulls calibration anchors so the agent can sanity-check ("we quoted a similar property last month at $X"). Returns up to 10 estimates.
Use for: any quote where you want to compare your draft against historical comps.`,
    input_schema: {
      type: 'object',
      properties: {
        monthly_total: { type: 'number', description: 'Target monthly total — returns estimates within ±25% of this value' },
        service_interest: { type: 'string', description: 'Service interest substring to match (e.g. "Pest", "Lawn", "Mosquito")' },
        days: { type: 'number', description: 'How far back to look (default 90)' },
      },
    },
  },
  {
    name: 'match_existing_customer',
    description: `Search the customers table to check if the prospect is already a customer (by phone, address, or name). Prevents quoting a duplicate. Returns up to 10 matches.
Use for: every quote — call before create_pending_estimate.`,
    input_schema: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'Phone (any format)' },
        address: { type: 'string', description: 'Address substring' },
        name: { type: 'string', description: 'Name substring (matches first or last)' },
      },
    },
  },
  {
    name: 'get_waveguard_tiers',
    description: `Read WaveGuard loyalty tier definitions (Bronze, Silver, Gold, Platinum) from pricing_config — service-count thresholds and discount percentages.
Use for: explaining the discount applied, or telling the operator what tier the quote will land in.`,
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_pending_estimate',
    description: `Write a draft estimate to the database. status='draft', source='ai_agent'. Structured notes are auto-generated from the inputs you pass — DO NOT pre-format the notes string yourself. Returns the new estimate's id and admin URL. ALWAYS confirm with the operator ("Draft this estimate? y/n") before calling.
NEVER call this without first calling compute_estimate. NEVER call this if the engine returned zero or the scenario is outside scope — instead, report back to the operator that manual quoting is required.`,
    input_schema: {
      type: 'object',
      properties: {
        customerName: { type: 'string', description: 'Full name (first + last)' },
        customerPhone: { type: 'string', description: 'Phone (any format — server normalizes)' },
        customerEmail: { type: 'string' },
        address: { type: 'string', description: 'Full street address with city + zip if known' },
        engineInputs: { type: 'object', description: 'Exact inputs passed to compute_estimate (homeSqFt, lotSqFt, services, propertyType, etc.)' },
        engineResult: {
          type: 'object',
          description: 'Engine summary returned by compute_estimate (must include monthlyTotal, annualTotal, oneTimeTotal, waveguardTier)',
          properties: {
            monthlyTotal: { type: 'number' },
            annualTotal: { type: 'number' },
            oneTimeTotal: { type: 'number' },
            waveguardTier: { type: 'string' },
          },
          required: ['monthlyTotal', 'annualTotal'],
        },
        sqftSource: { type: 'string', enum: ['property_lookup', 'user_input'], description: 'Where the sqft came from' },
        reasoning: { type: 'string', description: '1-3 sentences explaining why this estimate fits the situation' },
        assumptions: { type: 'array', items: { type: 'string' }, description: 'Things you inferred but did not confirm (empty array if none)' },
        uncertainty: { type: 'array', items: { type: 'string' }, description: 'Things you flagged as unsure (empty array if none)' },
      },
      required: ['customerName', 'address', 'engineInputs', 'engineResult', 'sqftSource', 'reasoning'],
    },
  },
  {
    name: 'toggle_estimate_v2_view',
    description: `Flip the estimates.use_v2_view flag on a single estimate. When true, the customer opening /estimate/{token} sees the React redesign (PR B.2); false serves the legacy server-rendered HTML. Use when the operator says "enable v2 view for the Smith estimate", "flip the new estimate view on for estimate abc-123", or "turn off v2 for Sarah's quote". Accept UUID, token, or customer phone (last-matched estimate). When enabled is omitted, toggles the current value.
Use for: per-estimate v2 rollout during Virginia's UAT. Reversible — flipping off restores the legacy HTML view with no state loss.`,
    input_schema: {
      type: 'object',
      properties: {
        estimate_identifier: { type: 'string', description: 'Estimate UUID, token, or customer phone (phone resolves to their most recent estimate)' },
        enabled: { type: 'boolean', description: 'Optional. If omitted, toggle current value. Pass true/false to set explicitly.' },
      },
      required: ['estimate_identifier'],
    },
  },
  {
    name: 'toggle_show_one_time_option',
    description: `Flip the estimates.show_one_time_option flag on a single estimate. When true, the customer sees a segmented toggle above the price card that lets them switch between recurring pricing and one-time pricing. Default off — most customers see recurring-only. Use when the operator says "enable one-time option for [estimate]", "show one-time pricing to Adam", or "let them pick one-time or recurring". Accept UUID, token, or phone. When enabled is omitted, toggles the current value.
Use for: customers who explicitly want to weigh both recurring and one-time. Reversible — flipping off hides the toggle without losing state.`,
    input_schema: {
      type: 'object',
      properties: {
        estimate_identifier: { type: 'string', description: 'Estimate UUID, token, or customer phone (phone resolves to their most recent estimate)' },
        enabled: { type: 'boolean', description: 'Optional. If omitted, toggle current value. Pass true/false to set explicitly.' },
      },
      required: ['estimate_identifier'],
    },
  },
];

// ─── EXECUTION ──────────────────────────────────────────────────

async function executeEstimateTool(toolName, input) {
  try {
    switch (toolName) {
      case 'lookup_property': return await lookupProperty(input);
      case 'compute_estimate': return await computeEstimate(input);
      case 'read_pricing_config': return await readPricingConfig(input);
      case 'recent_pricing_changes': return await recentPricingChanges(input);
      case 'find_similar_estimates': return await findSimilarEstimates(input);
      case 'match_existing_customer': return await matchExistingCustomer(input);
      case 'get_waveguard_tiers': return await getWaveGuardTiers();
      case 'create_pending_estimate': return await createPendingEstimate(input);
      case 'toggle_estimate_v2_view': return await toggleEstimateV2View(input);
      case 'toggle_show_one_time_option': return await toggleShowOneTimeOption(input);
      default: return { error: `Unknown estimate tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:estimates] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

// ─── IMPLEMENTATIONS ────────────────────────────────────────────

async function lookupProperty({ address }) {
  if (!address) return { error: 'address required' };

  let property = null;
  try {
    const rcResp = await fetch(
      `https://api.rentcast.io/v1/properties?address=${encodeURIComponent(address)}`,
      { headers: { 'X-Api-Key': RENTCAST_KEY, 'Accept': 'application/json' } }
    );
    if (rcResp.ok) {
      const rcData = await rcResp.json();
      const raw = Array.isArray(rcData) ? rcData[0] : rcData;
      if (raw) {
        property = {
          formatted_address: raw.formattedAddress || raw.addressLine1 || address,
          home_sqft: raw.squareFootage || null,
          lot_sqft: raw.lotSize || null,
          year_built: raw.yearBuilt || null,
          bedrooms: raw.bedrooms || null,
          bathrooms: raw.bathrooms || null,
          property_type: raw.propertyType || null,
          stories: raw.stories || null,
        };
      }
    }
  } catch (e) {
    logger.error(`[estimate-tools] RentCast lookup failed: ${e.message}`);
  }

  let satellite = null;
  try {
    const gResp = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_KEY}`
    );
    const gData = await gResp.json();
    if (gData.status === 'OK' && gData.results?.length) {
      const loc = gData.results[0].geometry.location;
      if (loc.lat >= 24 && loc.lat <= 32 && loc.lng >= -88 && loc.lng <= -79) {
        satellite = {
          lat: loc.lat,
          lng: loc.lng,
          imageUrl: `https://maps.googleapis.com/maps/api/staticmap?center=${loc.lat},${loc.lng}&zoom=20&size=640x640&maptype=satellite&format=png&key=${GOOGLE_KEY}`,
        };
      } else {
        return { error: 'Address is outside Waves service area (SW Florida).', property, satellite: null };
      }
    }
  } catch (e) {
    logger.error(`[estimate-tools] Geocode failed: ${e.message}`);
  }

  return { property, satellite };
}

async function computeEstimate(input) {
  const homeSqFt = Math.max(500, Math.min(20000, Number(input.homeSqFt) || 0));
  if (!homeSqFt) return { error: 'homeSqFt required and must be 500-20000' };

  const lotSqFt = Math.max(500, Math.min(200000, Number(input.lotSqFt) || homeSqFt * 4));
  const stories = Number(input.stories) || 1;
  const propertyType = input.propertyType || 'Single Family';
  const services = input.services || {};

  if (Object.keys(services).length === 0) {
    return { error: 'At least one service is required in services object' };
  }

  const engineInput = { homeSqFt, lotSqFt, stories, propertyType, services };
  const estimate = generateEstimate(engineInput);

  const summary = estimate?.summary || {};
  const monthlyTotal = Number(summary.recurringMonthlyAfterDiscount || 0);
  const annualTotal = Number(summary.recurringAnnualAfterDiscount || 0);
  const oneTimeTotal = Number(summary.oneTimeTotal || 0);
  const waveguardTier = summary.waveGuardTier || estimate?.waveGuardTier || null;
  const waveguardSavings = Number(summary.waveGuardSavings || 0);

  if (!monthlyTotal && !oneTimeTotal) {
    return {
      error: 'Engine returned zero price — scenario likely outside engine scope',
      engine_input: engineInput,
      raw_summary: summary,
    };
  }

  return {
    engine_input: engineInput,
    monthly_total: Math.round(monthlyTotal * 100) / 100,
    annual_total: Math.round(annualTotal * 100) / 100,
    onetime_total: Math.round(oneTimeTotal * 100) / 100,
    waveguard_tier: waveguardTier,
    waveguard_savings: Math.round(waveguardSavings * 100) / 100,
    annual_before_discount: Number(summary.recurringAnnualBeforeDiscount || 0),
    year1_total: Number(summary.year1Total || 0),
    full_summary: summary,
  };
}

async function readPricingConfig({ config_key, category }) {
  let q = db('pricing_config').select('config_key', 'name', 'category', 'data', 'description');
  if (config_key) q = q.where('config_key', config_key);
  if (category) q = q.where('category', category);
  const rows = await q.orderBy('sort_order', 'asc').limit(50);
  return { count: rows.length, configs: rows };
}

async function recentPricingChanges({ limit = 10, category }) {
  let q = db('pricing_changelog')
    .select('id', 'version_from', 'version_to', 'changed_at', 'changed_by', 'category', 'summary', 'rationale')
    .orderBy('changed_at', 'desc')
    .limit(Math.min(Number(limit) || 10, 25));
  if (category) q = q.where('category', category);
  const rows = await q;
  return { count: rows.length, changes: rows };
}

async function findSimilarEstimates({ monthly_total, service_interest, days = 90 }) {
  const since = new Date(Date.now() - Number(days) * 86400000).toISOString();
  let q = db('estimates')
    .select('id', 'customer_name', 'address', 'monthly_total', 'annual_total', 'service_interest', 'category', 'waveguard_tier', 'status', 'source', 'created_at')
    .where('created_at', '>=', since)
    .orderBy('created_at', 'desc')
    .limit(10);

  if (monthly_total) {
    const target = Number(monthly_total);
    const lo = target * 0.75;
    const hi = target * 1.25;
    q = q.whereBetween('monthly_total', [lo, hi]);
  }
  if (service_interest) {
    q = q.whereILike('service_interest', `%${service_interest}%`);
  }

  const rows = await q;
  return {
    count: rows.length,
    period_days: days,
    estimates: rows.map(r => ({
      id: r.id,
      customer: r.customer_name,
      address: r.address,
      monthly: r.monthly_total ? parseFloat(r.monthly_total) : null,
      annual: r.annual_total ? parseFloat(r.annual_total) : null,
      services: r.service_interest,
      category: r.category,
      tier: r.waveguard_tier,
      status: r.status,
      source: r.source,
      created_at: r.created_at,
    })),
  };
}

async function matchExistingCustomer({ phone, address, name }) {
  if (!phone && !address && !name) {
    return { error: 'Provide at least one of: phone, address, name' };
  }

  let q = db('customers')
    .select('id', 'first_name', 'last_name', 'phone', 'email', 'address_line1', 'city', 'zip', 'waveguard_tier')
    .limit(10);

  q = q.where(function () {
    if (phone) {
      const digits = String(phone).replace(/\D/g, '').slice(-10);
      if (digits) this.orWhere(db.raw("regexp_replace(phone, '\\D', '', 'g')"), 'LIKE', `%${digits}%`);
    }
    if (address) {
      this.orWhereILike('address_line1', `%${address}%`);
    }
    if (name) {
      this.orWhereILike('first_name', `%${name}%`).orWhereILike('last_name', `%${name}%`);
    }
  });

  const rows = await q;
  return {
    count: rows.length,
    matches: rows.map(r => ({
      id: r.id,
      name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
      phone: r.phone,
      email: r.email,
      address: [r.address_line1, r.city, r.zip].filter(Boolean).join(', '),
      tier: r.waveguard_tier,
    })),
  };
}

async function getWaveGuardTiers() {
  const rows = await db('pricing_config')
    .where(function () {
      this.where('category', 'waveguard').orWhere('config_key', 'ILIKE', 'waveguard%');
    })
    .select('config_key', 'name', 'data', 'description')
    .orderBy('sort_order', 'asc');
  return { count: rows.length, tiers: rows };
}

function buildAgentNotes({ engineInputs, engineResult, sqftSource, reasoning, assumptions, uncertainty, address }) {
  const ts = new Date().toISOString();
  const services = engineInputs?.services
    ? Object.entries(engineInputs.services).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('; ')
    : '(none)';
  const ass = (assumptions && assumptions.length) ? assumptions.map(a => `  - ${a}`).join('\n') : '  (none)';
  const unc = (uncertainty && uncertainty.length) ? uncertainty.map(u => `  - ${u}`).join('\n') : '  (none)';
  const tier = engineResult?.waveguardTier || engineResult?.waveguard_tier || '(none)';

  return [
    `[AI Agent Draft — ${ts}]`,
    '',
    'Inputs:',
    `- Address: ${address}`,
    `- Sqft: ${engineInputs?.homeSqFt} (source: ${sqftSource})`,
    `- Lot sqft: ${engineInputs?.lotSqFt || '(default 4× home)'}`,
    `- Stories: ${engineInputs?.stories || 1}`,
    `- Property type: ${engineInputs?.propertyType || 'Single Family'}`,
    `- Services: ${services}`,
    '',
    `Engine result: $${engineResult.monthlyTotal}/mo · $${engineResult.annualTotal}/yr · WaveGuard tier: ${tier}`,
    '',
    `Reasoning: ${reasoning || '(not provided)'}`,
    '',
    'Assumptions made:',
    ass,
    '',
    'Uncertainty flags:',
    unc,
  ].join('\n');
}

async function createPendingEstimate(input) {
  const {
    customerName, customerPhone, customerEmail, address,
    engineInputs, engineResult, sqftSource, reasoning, assumptions = [], uncertainty = [],
  } = input;

  if (!customerName || !address || !engineResult || typeof engineResult.monthlyTotal !== 'number') {
    return { error: 'Missing required fields: customerName, address, engineResult.monthlyTotal' };
  }

  // Same token shape as POST /api/admin/estimates: 16 random bytes hex.
  // Old `name-slug-${4 bytes}` format was guessable.
  const crypto = require('crypto');
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  const monthly = Number(engineResult.monthlyTotal) || 0;
  const annual = Number(engineResult.annualTotal) || monthly * 12;
  const onetime = Number(engineResult.oneTimeTotal) || 0;
  const tier = engineResult.waveguardTier || engineResult.waveguard_tier || null;

  const notes = buildAgentNotes({ engineInputs, engineResult, sqftSource, reasoning, assumptions, uncertainty, address });

  const serviceInterest = engineInputs?.services
    ? Object.keys(engineInputs.services)
        .map(s => s.charAt(0).toUpperCase() + s.slice(1))
        .join(' + ')
    : null;

  const [estimate] = await db('estimates').insert({
    estimate_data: JSON.stringify({ engineInputs, engineResult, agentDraft: true }),
    address,
    customer_name: customerName,
    customer_phone: customerPhone || null,
    customer_email: customerEmail || null,
    monthly_total: monthly,
    annual_total: annual,
    onetime_total: onetime,
    waveguard_tier: tier,
    token,
    expires_at: expiresAt,
    notes,
    status: 'draft',
    source: 'ai_agent',
    service_interest: serviceInterest,
    category: 'RESIDENTIAL',
  }).returning(['id', 'token']);

  logger.info(`[intelligence-bar:estimates] Agent created draft ${estimate.id} for ${customerName}`);

  const customerViewUrl = await shortenOrPassthrough(
    `https://portal.wavespestcontrol.com/estimate/${estimate.token}`,
    { kind: 'estimate', entityType: 'estimates', entityId: estimate.id }
  );

  return {
    success: true,
    estimate_id: estimate.id,
    token: estimate.token,
    admin_url: `https://portal.wavespestcontrol.com/admin/estimates`,
    customer_view_url: customerViewUrl,
    monthly_total: monthly,
    annual_total: annual,
    note_for_admin: 'Draft created. Open admin/estimates → 🤖 to review and send.',
  };
}

// ─── toggle_estimate_v2_view ───────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveEstimateByIdentifier(identifier) {
  const id = String(identifier || '').trim();
  if (!id) return null;

  // UUID → direct lookup
  if (UUID_RE.test(id)) {
    return db('estimates').where({ id }).first();
  }

  // Treat as token first (most common when Virginia says "estimate abc-123")
  const byToken = await db('estimates').where({ token: id }).first();
  if (byToken) return byToken;

  // Fall back to phone → most recent non-terminal estimate
  const digits = id.replace(/\D/g, '');
  if (digits.length >= 10) {
    const normalized = digits.length === 11 && digits.startsWith('1') ? `+${digits}` : `+1${digits.slice(-10)}`;
    const byPhone = await db('estimates')
      .where((q) => q.where('customer_phone', normalized).orWhere('customer_phone', digits).orWhere('customer_phone', `+${digits}`))
      .orderBy('created_at', 'desc')
      .first();
    if (byPhone) return byPhone;
  }

  return null;
}

async function toggleEstimateV2View({ estimate_identifier, enabled }) {
  if (!estimate_identifier) {
    return { error: 'estimate_identifier required (UUID, token, or phone)' };
  }

  const estimate = await resolveEstimateByIdentifier(estimate_identifier);
  if (!estimate) {
    return { error: `No estimate found matching "${estimate_identifier}" (try a token, UUID, or phone)` };
  }

  const next = typeof enabled === 'boolean' ? enabled : !estimate.use_v2_view;
  await db('estimates').where({ id: estimate.id }).update({ use_v2_view: next });

  logger.info(`[estimate-v2] Toggled use_v2_view for estimate ${estimate.id} → ${next}`);

  return {
    estimateId: estimate.id,
    customerName: estimate.customer_name,
    token: estimate.token,
    useV2View: next,
    previewUrl: `https://portal.wavespestcontrol.com/estimate/${estimate.token}`,
  };
}

async function toggleShowOneTimeOption({ estimate_identifier, enabled }) {
  if (!estimate_identifier) {
    return { error: 'estimate_identifier required (UUID, token, or phone)' };
  }

  const estimate = await resolveEstimateByIdentifier(estimate_identifier);
  if (!estimate) {
    return { error: `No estimate found matching "${estimate_identifier}" (try a token, UUID, or phone)` };
  }

  const next = typeof enabled === 'boolean' ? enabled : !estimate.show_one_time_option;
  await db('estimates').where({ id: estimate.id }).update({ show_one_time_option: next });

  logger.info(`[estimate-v2] Toggled show_one_time_option for estimate ${estimate.id} → ${next}`);

  return {
    estimateId: estimate.id,
    customerName: estimate.customer_name,
    token: estimate.token,
    showOneTimeOption: next,
    previewUrl: `https://portal.wavespestcontrol.com/estimate/${estimate.token}`,
  };
}

module.exports = { ESTIMATE_TOOLS, executeEstimateTool };
