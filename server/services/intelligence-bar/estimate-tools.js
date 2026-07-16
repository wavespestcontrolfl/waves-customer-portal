/**
 * Intelligence Bar — Quoting Agent Tools
 * server/services/intelligence-bar/estimate-tools.js
 *
 * Lets the operator delegate edge-case quoting to Claude. Agent enriches the
 * address, calls the v1 pricing engine, gathers calibration context, then
 * writes a draft estimate for operator review. Agent Estimate drafts keep all
 * reasoning in estimate_data (estimates.notes is customer-visible), never
 * send, and can only be committed by the server-backed confirmation flow.
 */

const db = require('../../models/db');
const logger = require('../logger');
const crypto = require('crypto');
const {
  generateEstimate,
  needsSync,
  syncConstantsFromDB,
} = require('../pricing-engine');
const { deriveTotals } = require('../estimator-engine/draft-builder');
const { sameStreetAddress } = require('../estimator-engine/address-compare');
const { normalizeGrassType, grassTypeLabel } = require('../lawn-grass-context');
const { shortenOrPassthrough } = require('../short-url');
const { validateEstimateDeliveryOptions } = require('../estimate-delivery-options');
const {
  blockIfAutomatedEstimateDuplicate,
  withAutomatedEstimatePhoneLock,
  OPEN_ESTIMATE_STATUSES,
} = require('../estimate-automation-duplicates');
const { performPropertyLookup } = require('../../routes/property-lookup-v2');
const { buildAgentEstimateContext } = require('../agent-estimate-context');
const { toQualifyingKey } = require('../waveguard-existing-services');
const { computeMembershipContext, loadCurrentServiceSpendContext } = require('../estimate-membership-context');

const ESTIMATE_TOOLS = [
  {
    name: 'lookup_property',
    description: `Enrich an address with property data (sqft, lot size, year built, beds/baths) via AI property search plus Google satellite imagery. Always call this before compute_estimate when sqft/lot are not user-provided.
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
        leadId: { type: 'string', description: 'Selected lead UUID. Required on Agent Estimate so existing-customer services and membership pricing are loaded server-side.' },
        address: { type: 'string', description: 'Full service address being quoted. Scopes existing-customer duplicate checks to this property — a multi-property customer can be quoted the same service at a DIFFERENT property.' },
        homeSqFt: { type: 'number', description: 'Home interior square footage' },
        lotSqFt: { type: 'number', description: 'Lot size in square feet (defaults to ~4× homeSqFt if unknown)' },
        buildingSqFt: { type: 'number', description: 'Verified commercial building/treatment footprint square footage.' },
        buildingSizeMeasured: { type: 'boolean', description: 'True only when buildingSqFt is supported by a record, measurement, or operator confirmation.' },
        measuredTurfSf: { type: 'number', description: 'Verified treatable lawn/turf area. This is not the parcel area.' },
        estimatedTurfSf: { type: 'number', description: 'Estimated treatable turf when no verified measurement exists; requires a review flag.' },
        turfSource: { type: 'string', description: 'Source for turf area, such as measured, satellite_vision, county_prior, or operator_confirmed.' },
        stories: { type: 'number', description: 'Number of stories (1, 2, or 3). Default 1.' },
        propertyType: { type: 'string', description: 'Property type (e.g. "Single Family", "Townhouse", "Condo"). Default "Single Family".' },
        isCommercial: { type: 'boolean' },
        commercialSubtype: { type: 'string' },
        commercialRiskType: { type: 'string' },
        footprintSqFt: { type: 'number', description: 'Optional termite bait footprint sqft override' },
        perimeterLF: { type: 'number', description: 'Optional trenching/termite perimeter linear-foot override' },
        atticSqFt: { type: 'number', description: 'Optional Bora-Care attic/raw wood sqft override' },
        slabSqFt: { type: 'number', description: 'Optional Pre-Slab Termiticide slab sqft override' },
        buildingSlabSqFt: { type: 'number', description: 'Verified commercial/new-construction slab area.' },
        estimatedBedAreaSf: { type: 'number', description: 'Estimated ornamental bed area for services that use it.' },
        imperviousSurfacePercent: { type: 'number', description: 'Verified or satellite-estimated non-turf share of the lot, 0-100.' },
        palmCount: { type: 'number', description: 'Operator-confirmed treated palm count; an image count remains an observation until confirmed.' },
        yearBuilt: { type: 'number' },
        pool: { type: 'boolean' },
        poolCage: { type: 'boolean' },
        services: {
          type: 'object',
              description: 'Only services requested in this quote. The server selects the approved React presentation from priced line items. Recurring keys: pest, lawn, mosquito, treeShrub, termiteBait, rodentBait. One-time/specialty keys: oneTimePest, oneTimeLawn, lawnPestControl, oneTimeMosquito, germanRoach (multi-visit cleanout), pestInitialRoach (standalone cockroach treatment), flea, bedBug, stinging, rodentTrapping, trenching, boraCare, preSlabTermiticide. Never substitute generic pest for a specifically requested one-time or cockroach program.',
          properties: {
            pest: { type: 'object' },
            lawn: { type: 'object' },
            mosquito: { type: 'object' },
            treeShrub: { type: 'object' },
            termite: { type: 'object' },
            termiteBait: { type: 'object' },
            trenching: { type: 'object' },
            boraCare: { type: 'object' },
            preSlabTermiticide: { type: 'object' },
            preSlabTermidor: { type: 'object' },
            rodentBait: { type: 'object' },
            oneTimePest: { type: 'object' },
            oneTimeLawn: { type: 'object' },
            lawnPestControl: { type: 'object' },
            oneTimeMosquito: { type: 'object' },
            germanRoach: { type: 'object' },
            germanRoachInitial: { type: 'object' },
            pestInitialRoach: { type: 'object' },
            flea: { type: 'object' },
            bedBug: { type: 'object' },
            stinging: { type: 'object' },
            rodentTrapping: { type: 'object' },
            palm: { type: 'object' },
          },
        },
      },
      required: ['services'],
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
    description: `Search for an existing customer by phone, address, or name. Returns active recurring services and current per-application spend so an expansion quote preserves current service and prices only additions. Ambiguous matches are not pricing authority.
Use for: every quote when the selected lead is not already linked to a customer.`,
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
    name: 'get_neighborhood_grass_profile',
    description: `Return an aggregate, privacy-safe grass-type distribution for active customer turf profiles in one ZIP code. This is only a neighborhood prior, never property truth: use a close turf photo, a verified profile, or operator confirmation for the estimate. A small or mixed sample must be described as weak evidence.
Use for: "what grass is typical in this neighborhood?" before asking the operator to verify the actual lawn.`,
    input_schema: {
      type: 'object',
      properties: {
        postal_code: { type: 'string', description: 'Five-digit service-address ZIP code.' },
      },
      required: ['postal_code'],
    },
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
    name: 'create_agent_estimate_draft',
    description: `Preview a new Agent Estimate draft or a revision to the current Agent Estimate draft. The server re-runs generateEstimate from engineInputs; never pass or invent prices. The first call only creates a confirmation card. Only the operator's Confirm click writes. If estimateId points to an existing draft created by this tool, confirmation revises that same row/token in place. Never sends.
Use for: the final step on the Agent Estimate page, after lookup_property, protocol/stock checks, and compute_estimate. Use it again after the operator asks for a change, passing the revised engineInputs and current estimateId.`,
    input_schema: {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: 'Selected lead UUID. Keeps the draft linked to the lead.' },
        estimateId: { type: 'string', description: 'Existing Agent Estimate draft UUID when revising in place.' },
        customerName: { type: 'string' },
        customerPhone: { type: 'string' },
        customerEmail: { type: 'string' },
        address: { type: 'string', description: 'Full service address.' },
        engineInputs: { type: 'object', description: 'Exact engine_input returned by the latest compute_estimate call.' },
        reasoning: { type: 'string', description: 'Short operator-facing basis for service selections; stored internally, never in customer notes.' },
        assumptions: { type: 'array', items: { type: 'string' } },
        uncertainty: { type: 'array', items: { type: 'string' } },
        evidence: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string' },
              quote: { type: 'string' },
              decision: { type: 'string' },
            },
          },
        },
        propertyFacts: { type: 'object', description: 'Per-field selected values, sources, confidence, and conflicts. Lawn drafts must include the verified treatable-turf fact; commercial drafts must include the verified treated building/unit area.' },
        protocolReview: {
          type: 'array',
          description: 'One row per selected service after reading the complete protocol.',
          items: {
            type: 'object',
            properties: {
              serviceKey: { type: 'string' },
              programKey: { type: 'string' },
              visitCount: { type: 'number' },
              warning: { type: 'string' },
            },
          },
        },
        inventoryReview: {
          type: 'array',
          description: 'Products named by the selected protocols. A null count must be reported as untracked, never in stock.',
          items: {
            type: 'object',
            properties: {
              serviceKey: { type: 'string' },
              productName: { type: 'string' },
              status: { type: 'string' },
              onHand: { type: ['number', 'null'] },
            },
          },
        },
      },
      required: ['leadId', 'customerName', 'address', 'engineInputs', 'reasoning'],
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

async function executeEstimateTool(toolName, input, actionContext = {}) {
  try {
    switch (toolName) {
      case 'lookup_property': return await lookupProperty(input);
      case 'compute_estimate': return await computeEstimate(input);
      case 'read_pricing_config': return await readPricingConfig(input);
      case 'recent_pricing_changes': return await recentPricingChanges(input);
      case 'find_similar_estimates': return await findSimilarEstimates(input);
      case 'match_existing_customer': return await matchExistingCustomer(input);
      case 'get_waveguard_tiers': return await getWaveGuardTiers();
      case 'get_neighborhood_grass_profile': return await getNeighborhoodGrassProfile(input);
      case 'create_pending_estimate': return await createPendingEstimate(input);
      case 'create_agent_estimate_draft': return await createAgentEstimateDraft(input, actionContext);
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

  try {
    const lookup = await performPropertyLookup(address);
    const raw = lookup.propertyRecord || lookup.rentcast || null;
    const property = raw ? {
      formatted_address: raw.formattedAddress || raw.addressLine1 || address,
      home_sqft: raw.squareFootage || null,
      lot_sqft: raw.lotSize || null,
      year_built: raw.yearBuilt || null,
      bedrooms: raw.bedrooms || null,
      bathrooms: raw.bathrooms || null,
      property_type: raw.propertyType || null,
      stories: raw.stories || null,
      source: raw._source || 'ai',
      provider: raw._provider || null,
    } : null;
    const satellite = lookup.satellite ? {
      lat: lookup.satellite.lat,
      lng: lookup.satellite.lng,
      imageAvailable: !!(lookup.satellite.superCloseUrl || lookup.satellite.closeUrl || lookup.satellite.microCloseUrl),
      inServiceArea: lookup.satellite.inServiceArea,
      aiSources: lookup.aiAnalysis?._sources || [],
    } : null;

    if (satellite && satellite.inServiceArea === false) {
      return { error: 'Address is outside Waves service area (SW Florida).', property, satellite: null };
    }
    return { property, satellite, enriched: lookup.enriched || null, errors: lookup.errors || [] };
  } catch (e) {
    logger.error('[estimate-tools] AI property lookup failed', {
      errorName: e?.name || 'Error',
      errorCode: e?.code || null,
      status: extractStatusCode(e),
    });
    return { error: 'AI property lookup failed' };
  }
}

function extractStatusCode(err) {
  const message = err?.message || '';
  return message.match(/\b(\d{3})\b/)?.[1] || null;
}

const AGENT_FORBIDDEN_PRICING_INPUT_KEYS = new Set([
  'allowwarrantyoverride',
  'customcontaineroz',
  'customdiscount',
  'custommanageroverride',
  'customprice',
  'custompriceoverride',
  'customproductcost',
  'customproductozperfinishedgallon',
  'discountoverride',
  'fixedprice',
  'isrecurringcustomer',
  'lawnlaborminutesbase',
  'lawnlaborminutesperk',
  'lawnmaterialcostperk',
  'manageroverride',
  'manualdiscount',
  'margindivisor',
  'priceoverride',
  'pricingconfig',
  'priorqualifyingservices',
  'recurringcustomer',
  'routedriveminutes',
  'servicespecificcredits',
  'servicespecificdiscounts',
  'targetlawngrossmargin',
  'targetmargin',
  'uselawncostfloor',
  // services.pest.version selects the pricing VERSION (frequency multipliers)
  // — server-derived only.
  'version',
]);

// The engine's per-service options are open objects, so an exact-key list can
// never stay complete against its price levers (customPricePerPalm,
// customContainerCost, volumeDiscount, subcontractCost, ...). Deny the whole
// custom*, *override*, *discount*, and *subcontract* families by pattern —
// no legitimate agent-suppliable input uses any of these shapes, and a false
// positive just tells the model to drop the key and let DB-authoritative
// pricing rule.
const AGENT_FORBIDDEN_PRICING_INPUT_PATTERN = /^custom|override|discount|subcontract/;

function findForbiddenAgentPricingInputs(value, path = [], found = []) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenAgentPricingInputs(item, [...path, index], found));
    return found;
  }
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (AGENT_FORBIDDEN_PRICING_INPUT_KEYS.has(normalized)
      || AGENT_FORBIDDEN_PRICING_INPUT_PATTERN.test(normalized)) {
      found.push([...path, key].join('.'));
    } else {
      findForbiddenAgentPricingInputs(nested, [...path, key], found);
    }
  }
  return found;
}

function forbiddenPricingInputError(input) {
  const forbidden = [...new Set(findForbiddenAgentPricingInputs(input))];
  if (!forbidden.length) return null;
  return `Agent Estimate cannot set price, cost, discount, margin, or manager-override inputs (${forbidden.slice(0, 8).join(', ')}). Remove them and let generateEstimate use DB-authoritative pricing.`;
}

const APPROVED_REACT_SERVICE_TEMPLATES = Object.freeze({
  pest: 'pest_control',
  pest_control: 'pest_control',
  lawn: 'lawn_care',
  lawn_care: 'lawn_care',
  treeShrub: 'tree_shrub',
  tree_shrub: 'tree_shrub',
  mosquito: 'mosquito',
  termite: 'termite_bait',
  termiteBait: 'termite_bait',
  termite_bait: 'termite_bait',
  oneTimePest: 'one_time_pest',
  one_time_pest: 'one_time_pest',
  oneTimeLawn: 'one_time_lawn',
  one_time_lawn: 'one_time_lawn',
  lawnPestControl: 'lawn_pest_knockdown',
  oneTimeMosquito: 'one_time_mosquito',
  one_time_mosquito: 'one_time_mosquito',
  germanRoach: 'german_roach_cleanout',
  german_roach: 'german_roach_cleanout',
  germanRoachInitial: 'german_roach_initial',
  german_roach_initial: 'german_roach_initial',
  pestInitialRoach: 'cockroach_control',
  pest_initial_roach: 'cockroach_control',
  flea: 'flea_control',
  flea_package: 'flea_control',
  bedBug: 'bed_bug',
  bed_bug: 'bed_bug',
  bed_bug_chemical: 'bed_bug',
  bed_bug_heat: 'bed_bug',
  stinging: 'stinging_insect',
  stinging_v2: 'stinging_insect',
  rodentTrapping: 'rodent',
  rodent_trapping: 'rodent',
  rodentBait: 'rodent_bait',
  palm: 'palm_injection',
  palm_injection: 'palm_injection',
  trenching: 'termite_trenching',
  boraCare: 'bora_care',
  bora_care: 'bora_care',
  preSlabTermiticide: 'pre_slab_termiticide',
  pre_slab_termiticide: 'pre_slab_termiticide',
});

const ONE_TIME_REACT_TEMPLATES = new Set([
  'one_time_pest', 'one_time_lawn', 'lawn_pest_knockdown', 'one_time_mosquito',
  'german_roach_cleanout', 'german_roach_initial', 'cockroach_control',
  'flea_control', 'bed_bug', 'stinging_insect', 'rodent', 'palm_injection',
  'termite_trenching', 'bora_care', 'pre_slab_termiticide',
]);

function serviceTemplateKey(rawKey) {
  if (APPROVED_REACT_SERVICE_TEMPLATES[rawKey]) return APPROVED_REACT_SERVICE_TEMPLATES[rawKey];
  const qualifying = toQualifyingKey(rawKey);
  if (qualifying) return qualifying;
  return String(rawKey || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function presentationForServices(services = {}, engineResult = null) {
  const requestedKeys = Object.keys(services).map(serviceTemplateKey).filter(Boolean);
  const requestedSet = new Set(requestedKeys);
  // The engine prices lawnPestControl under the generic one_time_lawn service
  // key (only the display name says Lawn Pest Knockdown), so taking priced
  // keys verbatim would demote the approved lawn-pest template whenever the
  // engine prices successfully. Restore the requested specific template when
  // the generic key was not itself requested.
  const pricedKeys = (engineResult?.lineItems || [])
    .map((line) => serviceTemplateKey(line?.service))
    .filter(Boolean)
    .map((key) => (
      key === 'one_time_lawn' && !requestedSet.has('one_time_lawn') && requestedSet.has('lawn_pest_knockdown')
        ? 'lawn_pest_knockdown'
        : key
    ));
  const serviceTemplateKeys = [...new Set(pricedKeys.length ? pricedKeys : requestedKeys)];
  const hasOneTime = serviceTemplateKeys.some((key) => ONE_TIME_REACT_TEMPLATES.has(key));
  const hasRecurring = serviceTemplateKeys.some((key) => !ONE_TIME_REACT_TEMPLATES.has(key));
  return {
    template: serviceTemplateKeys.length > 1 ? 'multi_service_bundle' : (serviceTemplateKeys[0] || 'manual_review'),
    serviceTemplateKeys,
    reactPage: 'estimate_v2',
    mode: hasOneTime && hasRecurring ? 'mixed' : (hasOneTime ? 'one_time' : 'recurring'),
    selectionAuthority: pricedKeys.length ? 'priced_line_items' : 'requested_services',
  };
}

function accountPricingFromContext(context = {}) {
  const account = context.customer_account || {};
  const priorQualifyingServices = Array.isArray(account.existing_service_keys)
    ? [...new Set(account.existing_service_keys.filter(Boolean))]
    : [];
  // Duplicate checks must cover EVERY active recurring service, not just the
  // WaveGuard-qualifying set — rodent_bait / palm_injection live only in
  // current_services (loaded for spend recognition) and would otherwise be
  // quotable again as a duplicate draft. Pricing still uses the qualifying
  // set only. Each entry carries the property addresses the service is
  // active at, and commercial_* programs also match their base key so a
  // requested `pest` collides with an active "Commercial Pest Control".
  const activeServices = (Array.isArray(account.current_services) ? account.current_services : [])
    .flatMap((row) => {
      if (!row?.key) return [];
      // Addresses are trusted for property scoping only when EVERY active row
      // of this service carries one — a mixed known/unknown set could hide a
      // row that covers the quoted street, so it stays account-wide.
      const addresses = row.serviceAddressesComplete === true && Array.isArray(row.serviceAddresses)
        ? row.serviceAddresses.filter(Boolean)
        : [];
      const entries = [{ key: row.key, addresses }];
      if (row.key.startsWith('commercial_')) {
        entries.push({ key: row.key.slice('commercial_'.length), addresses });
      }
      return entries;
    });
  const coveredKeys = new Set(activeServices.map((entry) => entry.key));
  for (const key of priorQualifyingServices) {
    // Qualifying keys normally also appear in current_services with address
    // detail; a bare leftover stays an account-wide (address-less) block.
    if (!coveredKeys.has(key)) activeServices.push({ key, addresses: [] });
  }
  return {
    customerId: account.recognized ? account.customer_id : null,
    recognized: account.recognized === true,
    serviceContextUnavailable: account.service_context_unavailable === true,
    priorQualifyingServices,
    activeServices,
    customerAccount: account,
  };
}

// A recognized customer whose existing-service lookup failed has NO reliable
// tier or duplicate-service basis — pricing must refuse, not silently treat
// the account as service-free (which drops the membership discount and can
// quote an active service a second time).
function serviceContextUnavailableError(accountPricing) {
  if (!accountPricing.recognized || !accountPricing.serviceContextUnavailable) return null;
  return 'This recognized customer\'s existing-service context could not be loaded. Retry shortly — pricing without their current services could misapply the membership tier or re-quote an active service.';
}

function duplicateCurrentServices(services = {}, activeServices = [], quoteAddress = null) {
  const requestedKeys = [...new Set(Object.keys(services).map(serviceTemplateKey).filter(Boolean))];
  return requestedKeys.filter((key) => activeServices.some((service) => {
    if (service.key !== key) return false;
    // Property scoping: when the quoted address and every one of this
    // service's stamped addresses are known and street-differ, this is a
    // multi-property expansion, not a duplicate. An unknown address on
    // either side keeps the conservative account-wide block.
    if (quoteAddress && service.addresses?.length
      && service.addresses.every((address) => !sameStreetAddress(address, quoteAddress))) {
      return false;
    }
    return true;
  }));
}

// Transient input for generateEstimate only. The forbidden-input guard rejects
// model-supplied recurring-customer flags, so the germanRoachInitial discount
// flag is re-derived here from the server-loaded account (the engine's own
// definition: prior qualifying services make a recurring customer). Never
// merge this into the echoed/stored engineInputs — a persisted copy would be
// rejected by the guard on the next revision round-trip.
function buildAgentPricingInput(engineInput, accountPricing) {
  const priorQualifyingServices = accountPricing.priorQualifyingServices || [];
  let pricingInput = priorQualifyingServices.length
    ? { ...engineInput, priorQualifyingServices }
    : engineInput;
  const roachInitial = pricingInput.services?.germanRoachInitial;
  if (roachInitial) {
    pricingInput = {
      ...pricingInput,
      services: {
        ...pricingInput.services,
        germanRoachInitial: {
          ...(typeof roachInitial === 'object' ? roachInitial : {}),
          isRecurringCustomer: priorQualifyingServices.length > 0,
        },
      },
    };
  }
  return pricingInput;
}

// Every service key generateEstimate actually consumes. The engine silently
// ignores unrecognized keys, so a requested-but-unpriced service (e.g. a bare
// "rodent") would pass the zero-total check, appear in service_interest and
// the confirmation card, and never show up or charge on the customer estimate.
const AGENT_ALLOWED_SERVICE_KEYS = new Set([
  'pest', 'lawn', 'mosquito', 'treeShrub', 'termite', 'termiteBait', 'trenching',
  'boraCare', 'preSlabTermiticide', 'preSlabTermidor', 'rodentBait', 'oneTimePest',
  'oneTimeLawn', 'lawnPestControl', 'oneTimeMosquito', 'germanRoach',
  'germanRoachInitial', 'pestInitialRoach', 'flea', 'bedBug', 'stinging',
  'rodentTrapping', 'palm',
]);

function unknownServiceKeysError(services = {}) {
  const unknown = Object.keys(services).filter((key) => !AGENT_ALLOWED_SERVICE_KEYS.has(key));
  if (!unknown.length) return null;
  return `Unknown service key(s): ${unknown.join(', ')}. The pricing engine ignores unrecognized services, which would list a service the customer is never charged for. Use the documented service keys only (rodent control is rodentBait or rodentTrapping).`;
}

function optionalBoundedNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return null;
  return number;
}

function validateAgentEngineInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'engineInputs must be an object';
  if (!input.services || typeof input.services !== 'object' || Array.isArray(input.services)
    || !Object.keys(input.services).length) {
    return 'engineInputs.services must contain at least one service';
  }
  const unknownServices = unknownServiceKeysError(input.services);
  if (unknownServices) return unknownServices;
  const home = optionalBoundedNumber(input.homeSqFt, { min: 500, max: 10000000 });
  const building = optionalBoundedNumber(input.buildingSqFt, { min: 500, max: 10000000 });
  if (home === null || building === null || (home === undefined && building === undefined)) {
    return 'engineInputs requires homeSqFt or buildingSqFt between 500 and 10000000';
  }
  const lot = optionalBoundedNumber(input.lotSqFt, { min: 500, max: 10000000 });
  if (lot === null) return 'engineInputs.lotSqFt must be 500-10000000 when provided';
  const turf = optionalBoundedNumber(input.measuredTurfSf ?? input.lawnSqFt, { min: 0, max: 10000000 });
  if (turf === null) return 'engineInputs measured turf must be 0-10000000 when provided';
  const stories = optionalBoundedNumber(input.stories, { min: 1, max: 20 });
  if (stories === null) return 'engineInputs.stories must be 1-20 when provided';
  return null;
}

function normalizeEvidenceText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function verifyAgentEvidenceQuotes(evidence, context) {
  const haystack = normalizeEvidenceText([
    ...(context?.quote_form?.message_fields || []).map((row) => row.text),
    ...(context?.calls || []).flatMap((call) => [call.transcript, call.transcript_summary]),
    ...(context?.sms_thread || []).map((message) => message.body),
    ...(context?.activities || []).map((activity) => activity.description),
  ].filter(Boolean).join(' '));
  const quotedRows = (Array.isArray(evidence) ? evidence : [])
    .map((row, index) => ({ index, quote: row?.quote }))
    .filter((row) => String(row.quote || '').trim());
  const unverifiedIndexes = quotedRows.filter(({ quote }) => {
    const needle = normalizeEvidenceText(quote);
    return needle.length < 8 || !haystack.includes(needle);
  }).map(({ index }) => index);
  return {
    quoted: quotedRows.length,
    verified: quotedRows.length - unverifiedIndexes.length,
    unverified: unverifiedIndexes.length,
    unverifiedIndexes,
  };
}

async function computeEstimate(input) {
  const forbiddenError = forbiddenPricingInputError(input);
  if (forbiddenError) return { error: forbiddenError };

  const rawBuildingSqFt = optionalBoundedNumber(input.buildingSqFt, { min: 500, max: 10000000 });
  if (rawBuildingSqFt === null) return { error: 'buildingSqFt must be 500-10000000 when provided' };
  const rawHomeSqFt = optionalBoundedNumber(input.homeSqFt, { min: 500, max: 10000000 });
  if (rawHomeSqFt === null) return { error: 'homeSqFt must be 500-10000000 when provided' };
  const homeSqFt = rawHomeSqFt ?? rawBuildingSqFt;
  if (!homeSqFt) return { error: 'homeSqFt or buildingSqFt is required and must be at least 500' };

  const suppliedLotSqFt = optionalBoundedNumber(input.lotSqFt, { min: 500, max: 10000000 });
  if (suppliedLotSqFt === null) return { error: 'lotSqFt must be 500-10000000 when provided' };
  const lotSqFt = suppliedLotSqFt ?? Math.min(10000000, homeSqFt * 4);
  // Assert lot provenance: true only when a REAL lot was supplied, false when we
  // synthesized homeSqFt*4. Commercial mosquito reads this and stays a manual
  // quote rather than auto-pricing off the synthetic default.
  const lotSizeMeasured = suppliedLotSqFt !== undefined;
  const suppliedStories = optionalBoundedNumber(input.stories, { min: 1, max: 20 });
  if (suppliedStories === null) return { error: 'stories must be 1-20 when provided' };
  const stories = suppliedStories || 1;
  const propertyType = input.propertyType || 'Single Family';
  const services = input.services || {};

  if (Object.keys(services).length === 0) {
    return { error: 'At least one service is required in services object' };
  }
  const inactiveServices = Object.entries(services).filter(([, value]) => value === false || value == null);
  if (inactiveServices.length) {
    return { error: `Remove inactive services from the pricing request: ${inactiveServices.map(([key]) => key).join(', ')}` };
  }
  const unknownServices = unknownServiceKeysError(services);
  if (unknownServices) return { error: unknownServices };

  const measuredTurfSf = optionalBoundedNumber(input.measuredTurfSf ?? input.lawnSqFt, { min: 0, max: 10000000 });
  if (measuredTurfSf === null) return { error: 'measuredTurfSf must be 0-10000000 when provided' };
  const estimatedTurfSf = optionalBoundedNumber(input.estimatedTurfSf, { min: 0, max: 10000000 });
  if (estimatedTurfSf === null) return { error: 'estimatedTurfSf must be 0-10000000 when provided' };

  const engineInput = Object.fromEntries(Object.entries({
    homeSqFt,
    lotSqFt,
    lotSizeMeasured,
    stories,
    propertyType,
    isCommercial: input.isCommercial,
    commercialSubtype: input.commercialSubtype,
    commercialRiskType: input.commercialRiskType,
    buildingSqFt: rawBuildingSqFt,
    buildingSizeMeasured: input.buildingSizeMeasured === true,
    measuredTurfSf,
    estimatedTurfSf,
    turfSource: input.turfSource,
    services,
    footprintSqFt: input.footprintSqFt,
    perimeterLF: input.perimeterLF,
    atticSqFt: input.atticSqFt,
    slabSqFt: input.slabSqFt,
    buildingSlabSqFt: input.buildingSlabSqFt,
    estimatedBedAreaSf: input.estimatedBedAreaSf,
    palmCount: input.palmCount,
    imperviousSurfacePercent: input.imperviousSurfacePercent,
    yearBuilt: input.yearBuilt,
    pool: input.pool,
    poolCage: input.poolCage,
  }).filter(([, value]) => value !== undefined));

  let accountPricing = accountPricingFromContext();
  if (input.leadId) {
    const context = await buildAgentEstimateContext(input.leadId);
    if (context?.error) return { error: 'Selected lead could not be loaded for customer recognition' };
    accountPricing = accountPricingFromContext(context);
  }
  const spendUnavailableError = serviceContextUnavailableError(accountPricing);
  if (spendUnavailableError) return { error: spendUnavailableError };
  const duplicateServices = duplicateCurrentServices(services, accountPricing.activeServices, input.address || null);
  if (duplicateServices.length) {
    return {
      error: `The customer already has active ${duplicateServices.join(', ')} service. Keep current services as account context and quote only requested additions.`,
      customer_account: accountPricing.customerAccount,
    };
  }
  const pricingEngineInput = buildAgentPricingInput(engineInput, accountPricing);
  if (needsSync()) await syncConstantsFromDB(db);
  const estimate = generateEstimate(pricingEngineInput);

  const summary = estimate?.summary || {};
  const monthlyTotal = Number(summary.recurringMonthlyAfterDiscount || 0);
  const annualTotal = Number(summary.recurringAnnualAfterDiscount || 0);
  // Specialty (german roach cleanout, flea, bed bug) and installation charges
  // are upfront money the engine reports outside summary.oneTimeTotal — a
  // standalone cleanout would otherwise read as a zero-price/manual scenario
  // and a mixed quote would underreport onetime_total. Mirrors deriveTotals.
  const oneTimeTotal = Number(summary.oneTimeTotal || 0)
    + Number(summary.specialtyTotal || 0)
    + Number(summary.installationTotal || 0);
  const waveguardTier = summary.waveGuardTier || estimate?.waveGuardTier || null;
  const waveguardSavings = Number(summary.waveGuardSavings || 0);

  if (!monthlyTotal && !oneTimeTotal) {
    return {
      error: 'Engine returned zero price — scenario likely outside engine scope',
      engine_input: engineInput,
      raw_summary: summary,
    };
  }

  const compactLines = (estimate.lineItems || []).map(compactAgentLine);
  const pricedLines = compactLines.filter((line) => line.annual != null || line.one_time != null);
  const verifiedMarginLines = pricedLines.filter((line) => line.collected_margin != null);
  const belowTargetLines = verifiedMarginLines.filter((line) => line.margin_floor_ok === false);

  return {
    engine_input: engineInput,
    monthly_total: Math.round(monthlyTotal * 100) / 100,
    annual_total: Math.round(annualTotal * 100) / 100,
    onetime_total: Math.round(oneTimeTotal * 100) / 100,
    waveguard_tier: waveguardTier,
    waveguard_savings: Math.round(waveguardSavings * 100) / 100,
    annual_before_discount: Number(summary.recurringAnnualBeforeDiscount || 0),
    year1_total: Number(summary.year1Total || 0),
    line_items: compactLines,
    customer_account: accountPricing.customerAccount,
    presentation: presentationForServices(services, estimate),
    margin_check: {
      loaded_labor_rate_per_hour: 35,
      target_collected_margin: 0.35,
      all_recurring_lines_at_or_above_target: compactLines
        .filter((line) => line.annual != null && line.collected_margin != null)
        .every((line) => line.margin_floor_ok),
      all_priced_lines_verified_and_at_or_above_target:
        pricedLines.length > 0 && verifiedMarginLines.length === pricedLines.length && belowTargetLines.length === 0,
      verified_line_count: verifiedMarginLines.length,
      unverified_line_count: pricedLines.length - verifiedMarginLines.length,
      below_target_services: belowTargetLines.map((line) => line.service),
    },
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
  const accounts = await Promise.all(rows.map(async (row) => {
    try {
      return await loadCurrentServiceSpendContext(db, row.id);
    } catch {
      return { existingServiceKeys: [], currentServices: [], currentSpendPerVisitTotal: 0 };
    }
  }));
  return {
    count: rows.length,
    ambiguous: rows.length !== 1,
    pricing_authority: rows.length === 1 ? 'unambiguous_match' : 'none',
    matches: rows.map((r, index) => ({
      id: r.id,
      name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
      phone: r.phone,
      email: r.email,
      address: [r.address_line1, r.city, r.zip].filter(Boolean).join(', '),
      tier: r.waveguard_tier,
      existing_service_keys: accounts[index].existingServiceKeys,
      current_services: accounts[index].currentServices,
      current_spend_per_visit_total: accounts[index].currentSpendPerVisitTotal,
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

async function getNeighborhoodGrassProfile({ postal_code: postalCode }) {
  const zip = String(postalCode || '').match(/\b\d{5}\b/)?.[0] || null;
  if (!zip) return { error: 'A five-digit postal_code is required' };

  const rows = await db('customers as c')
    .leftJoin('customer_turf_profiles as tp', function activeProfileJoin() {
      this.on('tp.customer_id', '=', 'c.id').andOnVal('tp.active', '=', true);
    })
    .where('c.zip', zip)
    .whereNull('c.deleted_at')
    .select('tp.grass_type', 'c.lawn_type')
    .limit(250);

  const counts = {};
  for (const row of rows) {
    const key = normalizeGrassType(row.grass_type) || normalizeGrassType(row.lawn_type);
    if (key && key !== 'unknown') counts[key] = (counts[key] || 0) + 1;
  }
  const distribution = Object.entries(counts)
    .map(([grass, count]) => ({ grass, label: grassTypeLabel(grass), count }))
    .sort((a, b) => b.count - a.count);
  const knownSamples = distribution.reduce((sum, row) => sum + row.count, 0);
  const dominantShare = knownSamples ? (distribution[0]?.count || 0) / knownSamples : 0;
  const confidence = knownSamples >= 20 && dominantShare >= 0.75
    ? 'strong_prior'
    : knownSamples >= 8 && dominantShare >= 0.6
      ? 'moderate_prior'
      : 'weak_prior';

  return {
    postal_code: zip,
    sample_size: rows.length,
    known_grass_samples: knownSamples,
    distribution: distribution.map((row) => ({
      ...row,
      share: knownSamples ? Math.round((row.count / knownSamples) * 1000) / 1000 : 0,
    })),
    typical_grass: distribution[0]?.grass || null,
    confidence,
    warning: 'Neighborhood aggregate only. Verify this property from a close turf photo, a verified profile, or the operator before pricing lawn care.',
  };
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

  const creationResult = await withAutomatedEstimatePhoneLock(customerPhone, async (trx) => {
    const duplicateBlock = await blockIfAutomatedEstimateDuplicate(customerPhone, { database: trx });
    if (duplicateBlock) return { duplicateBlock };

    const [estimate] = await trx('estimates').insert({
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

    return { estimate };
  });

  if (creationResult.duplicateBlock) {
    const { duplicateBlock } = creationResult;
    logger.info(`[intelligence-bar:estimates] Agent draft blocked by duplicate estimate ${duplicateBlock.existingEstimateId}`);
    return {
      success: false,
      blocked: true,
      reason: duplicateBlock.reason,
      existing_estimate_id: duplicateBlock.existingEstimateId,
      existing_status: duplicateBlock.existingStatus,
      existing_source: duplicateBlock.existingSource,
      note_for_admin: duplicateBlock.message,
    };
  }

  const { estimate } = creationResult;

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
    // Staff preview link — bare /estimate/<token> serves the legacy
    // server-HTML renderer while the row is still a draft; ?adminPreview=1
    // routes staff to the real React page. Kept separate from
    // customer_view_url, which doubles as the customer's link after send.
    admin_preview_url: `https://portal.wavespestcontrol.com/estimate/${estimate.token}?adminPreview=1`,
    monthly_total: monthly,
    annual_total: annual,
    note_for_admin: 'Draft created. Open admin/estimates → 🤖 to review and send. To preview it yourself, use admin_preview_url (the customer link shows the draft in the old layout).',
  };
}

function parseStoredJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function titleWaveGuardTier(value) {
  const labels = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum' };
  return labels[String(value || '').toLowerCase()] || null;
}

function compactAgentLine(line) {
  const annual = Number(line.annualAfterDiscount ?? line.finalAnnual ?? line.annual ?? 0);
  const oneTime = Number(line.priceAfterDiscount ?? line.price ?? line.total ?? 0);
  const priceBasis = annual > 0 ? annual : oneTime;
  // Recurring lawn lines expose their annual cost as costs.total; without it
  // the margin falls back to line.margin, which was computed from the PRE-
  // discount price and overstates the collected margin whenever the WaveGuard
  // margin-floor guard caps annualAfterDiscount.
  const rawCost = annual > 0
    ? (line.costs?.annualCost ?? line.annualCost ?? line.costs?.total)
    : (line.costs?.oneTimeCost ?? line.costs?.total ?? line.oneTimeCost ?? line.estimatedCost);
  const cost = Number(rawCost);
  const hasCostBasis = Number.isFinite(cost) && cost >= 0;
  const collectedMargin = priceBasis > 0 && hasCostBasis
    ? Math.round(((priceBasis - cost) / priceBasis) * 1000) / 1000
    : (Number.isFinite(Number(line.manualFinalMargin ?? line.finalMargin ?? line.margin))
      ? Number(line.manualFinalMargin ?? line.finalMargin ?? line.margin)
      : null);
  return {
    service: line.service || line.name || 'unknown',
    monthly: Number(line.monthlyAfterDiscount ?? line.finalMonthly ?? line.monthly ?? 0) || null,
    annual: annual || null,
    one_time: oneTime || null,
    estimated_cost: hasCostBasis ? cost : null,
    estimated_annual_cost: annual > 0 && hasCostBasis ? cost : null,
    collected_margin: collectedMargin,
    margin_floor_ok: collectedMargin == null ? null : collectedMargin >= 0.35,
    pricing_confidence: line.pricingConfidence || null,
    review_reasons: line.manualReviewReasons || [],
  };
}

async function computeAgentDraftPreview(input, accountPricing = accountPricingFromContext()) {
  if (!input?.engineInputs || typeof input.engineInputs !== 'object' || Array.isArray(input.engineInputs)) {
    return { error: 'engineInputs must be the exact engine_input returned by compute_estimate' };
  }
  const forbiddenError = forbiddenPricingInputError(input.engineInputs);
  if (forbiddenError) return { error: forbiddenError };
  const validationError = validateAgentEngineInput(input.engineInputs);
  if (validationError) return { error: validationError };
  if (!input.leadId || !input.customerName || !input.address) {
    return { error: 'leadId, customerName, and address are required' };
  }
  if (!input.engineInputs.services || !Object.keys(input.engineInputs.services).length) {
    return { error: 'engineInputs.services must contain at least one service' };
  }

  const spendUnavailableError = serviceContextUnavailableError(accountPricing);
  if (spendUnavailableError) return { error: spendUnavailableError };
  const duplicateServices = duplicateCurrentServices(
    input.engineInputs.services,
    accountPricing.activeServices,
    input.address || null,
  );
  if (duplicateServices.length) {
    return { error: `The customer already has active ${duplicateServices.join(', ')} service. Quote only requested additions.` };
  }

  if (needsSync()) await syncConstantsFromDB(db);
  const pricingEngineInputs = buildAgentPricingInput(input.engineInputs, accountPricing);
  const engineResult = generateEstimate(pricingEngineInputs);
  const totals = deriveTotals(engineResult);
  if (!totals.monthly && !totals.annual && !totals.oneTime) {
    return { error: 'Pricing engine returned zero — keep this as a manual quote instead of drafting' };
  }

  const lines = (engineResult.lineItems || []).map(compactAgentLine);
  // The aggregate check above passes as long as ANY line priced, which would
  // let a mixed quote ship with an unpriced (quote-required/manual) service
  // still listed in service_interest and never charged. Every line must
  // carry a price or the whole draft is refused.
  const unpricedLines = lines.filter((line) => line.monthly == null && line.annual == null && line.one_time == null);
  if (unpricedLines.length) {
    return {
      error: `The engine returned no price for: ${unpricedLines.map((line) => line.service).join(', ')}. `
        + 'That service needs a manual quote — remove it from this draft or quote it manually.',
    };
  }
  const laneReasons = [];
  const serviceKeys = Object.keys(input.engineInputs.services || {});
  const propertyFacts = input.propertyFacts && typeof input.propertyFacts === 'object'
    ? input.propertyFacts
    : {};
  const propertyFactEntries = Object.entries(propertyFacts);
  const protocolReview = Array.isArray(input.protocolReview) ? input.protocolReview : [];
  const inventoryReview = Array.isArray(input.inventoryReview) ? input.inventoryReview : [];
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];

  if (accountPricing.recognized) {
    laneReasons.push('existing-customer expansion: verify current services, spend, and added-service scope before sending');
  }

  if (!evidence.some((row) => row && (row.source || row.quote || row.decision))) {
    laneReasons.push('source evidence was not attached to the draft');
  }
  if (input.evidenceVerification?.unverified > 0) {
    laneReasons.push(`${input.evidenceVerification.unverified} evidence quote(s) could not be verified against the selected lead`);
  }
  // A fact counts as VERIFIED only when it carries a usable value, a source,
  // and an affirmative confidence — an empty `{ address: {} }` placeholder
  // must not satisfy the key-presence checks below and green a draft whose
  // price-driving measurements were never verified.
  const isVerifiedFact = (fact) => {
    if (!fact || typeof fact !== 'object') return false;
    const hasValue = fact.value !== undefined && fact.value !== null && String(fact.value).trim() !== '';
    const confidence = String(fact.confidence || '').trim().toLowerCase();
    return hasValue && !!fact.source && !!confidence
      && !['low', 'weak', 'unknown', 'unverified'].includes(confidence);
  };
  const verifiedFactKeys = propertyFactEntries
    .filter(([, fact]) => isVerifiedFact(fact))
    .map(([key]) => key);
  if (!propertyFactEntries.length) {
    laneReasons.push('property facts were not verified');
  }
  if (!verifiedFactKeys.some((key) => /address/i.test(key))) {
    laneReasons.push('service address was not recorded as a verified property fact');
  }
  if (input.contactVerification?.addressMismatch) {
    laneReasons.push('draft service address differs from the selected lead address');
  }
  for (const [key, fact] of propertyFactEntries) {
    if (!isVerifiedFact(fact)) {
      laneReasons.push(`${key} lacks a verified value, source, or confidence`);
    }
    const confidence = String(fact?.confidence || '').toLowerCase();
    if (['low', 'weak', 'unknown', 'unverified'].includes(confidence)) {
      laneReasons.push(`${key} has ${confidence} confidence`);
    }
    if (fact?.conflict === true || (Array.isArray(fact?.conflicts) && fact.conflicts.length)) {
      laneReasons.push(`${key} has conflicting source values`);
    }
  }
  const hasLawnService = serviceKeys.some((key) => /lawn|turf/i.test(key));
  if (hasLawnService && !verifiedFactKeys.some((key) => /lawn|turf|treatable/i.test(key))) {
    laneReasons.push('treatable lawn area was not recorded as a verified property fact');
  }
  const isCommercial = input.engineInputs.isCommercial === true
    || String(input.engineInputs.propertyType || '').toLowerCase().includes('commercial');
  if (isCommercial && !verifiedFactKeys.some((key) => /commercial|building|unit/i.test(key))) {
    laneReasons.push('commercial treated building or unit area was not verified');
  }
  if (serviceKeys.some((key) => /mosquito/i.test(key))
    && !verifiedFactKeys.some((key) => /lot|outdoor|treatable|lawn|turf/i.test(key))) {
    laneReasons.push('mosquito treatable outdoor area was not verified');
  }
  if (serviceKeys.some((key) => /trench/i.test(key))
    && !verifiedFactKeys.some((key) => /perimeter|concrete|dirt|linear/i.test(key))) {
    laneReasons.push('trenching perimeter and concrete/dirt measurements were not verified');
  }
  if (serviceKeys.some((key) => /termite|bait/i.test(key))
    && !verifiedFactKeys.some((key) => /perimeter|footprint|building/i.test(key))) {
    laneReasons.push('termite footprint or perimeter measurement was not verified');
  }
  if (serviceKeys.some((key) => /palm/i.test(key))
    && !verifiedFactKeys.some((key) => /palm.*count|treated.*palm/i.test(key))) {
    laneReasons.push('treated palm count was not operator-confirmed');
  }
  if (!protocolReview.length) {
    laneReasons.push('complete protocols were not checked for the selected services');
  } else {
    const covered = new Set(protocolReview.map((row) => String(row?.serviceKey || '').toLowerCase()));
    for (const serviceKey of serviceKeys) {
      if (!covered.has(serviceKey.toLowerCase())) {
        laneReasons.push(`protocol review does not cover ${serviceKey}`);
      }
    }
    for (const row of protocolReview) {
      if (!row?.programKey || !Number.isFinite(Number(row?.visitCount)) || Number(row.visitCount) <= 0) {
        laneReasons.push(`protocol review for ${row?.serviceKey || 'a selected service'} lacks program/cadence metadata`);
      }
    }
  }
  if (!inventoryReview.length) {
    laneReasons.push('protocol product inventory was not checked');
  } else {
    const covered = new Set(inventoryReview.map((row) => String(row?.serviceKey || '').toLowerCase()));
    for (const serviceKey of serviceKeys) {
      if (!covered.has(serviceKey.toLowerCase())) {
        laneReasons.push(`inventory review does not cover ${serviceKey}`);
      }
    }
  }
  for (const text of input.assumptions || []) laneReasons.push(`assumption: ${text}`);
  for (const text of input.uncertainty || []) laneReasons.push(`open question: ${text}`);
  // Pricing/margin failures are collected separately and placed FIRST in the
  // stored/displayed list — a draft with 30+ evidence/protocol reasons must
  // not truncate "collected margin is below 35%" out of the operator-visible
  // approval summary.
  const pricingLaneReasons = [];
  for (const line of lines) {
    if (line.margin_floor_ok === false) pricingLaneReasons.push(`${line.service} collected margin is below 35%`);
    if (line.margin_floor_ok == null) pricingLaneReasons.push(`${line.service} collected margin could not be independently verified`);
    if (line.pricing_confidence && String(line.pricing_confidence).toLowerCase() !== 'high') {
      pricingLaneReasons.push(`${line.service} pricing confidence is ${line.pricing_confidence}`);
    }
    for (const reason of line.review_reasons || []) pricingLaneReasons.push(`${line.service}: ${reason}`);
  }
  for (const row of inventoryReview) {
    if (!row?.status) {
      laneReasons.push(`${row?.productName || row?.product || 'inventory'}: status missing`);
    } else if (!['in_stock', 'ok', 'available', 'not_applicable'].includes(String(row.status).toLowerCase())) {
      laneReasons.push(`${row.productName || row.product || 'inventory'}: ${row.status}`);
    }
  }
  for (const row of protocolReview) {
    if (row?.warning) laneReasons.push(`protocol: ${row.warning}`);
  }

  const allLaneReasons = [...new Set([...pricingLaneReasons, ...laneReasons])];
  return {
    preview: true,
    action: input.estimateId ? 'revise_agent_draft' : 'create_or_update_lead_agent_draft',
    totals,
    lines,
    lane: allLaneReasons.length ? 'yellow' : 'green',
    lane_reasons: allLaneReasons.slice(0, 30),
    engineResult,
    customer_account: accountPricing.customerAccount,
    presentation: presentationForServices(input.engineInputs.services, engineResult),
  };
}

function agentEstimatePayload(input, preview, existingData = {}, accountPricing = accountPricingFromContext()) {
  const previousEngine = existingData.estimatorEngine || {};
  const priorRevisions = Array.isArray(previousEngine.revisions)
    ? previousEngine.revisions
    : [];
  const previousSnapshot = existingData.engineInputs ? {
    revised_at: new Date().toISOString(),
    engine_inputs: existingData.engineInputs,
    totals: existingData.engineResult ? deriveTotals(existingData.engineResult) : null,
    reasoning: previousEngine.reasoning || null,
  } : null;
  const revisions = previousSnapshot
    ? [...priorRevisions, previousSnapshot].slice(-5)
    : priorRevisions.slice(-5);
  const serviceKeys = Object.keys(input.engineInputs.services || {});
  const isCommercial = String(input.engineInputs.propertyType || '').toLowerCase() === 'commercial'
    || (preview.engineResult?.lineItems || []).some((line) => String(line.service || '').startsWith('commercial_'));

  return {
    data: {
      engineInputs: input.engineInputs,
      engineResult: preview.engineResult,
      agentDraft: true,
      lead_id: input.leadId,
      ...(accountPricing.membershipSnapshot ? { membershipSnapshot: accountPricing.membershipSnapshot } : {}),
      ...(accountPricing.priorQualifyingServices.length
        ? { priorQualifyingServices: accountPricing.priorQualifyingServices }
        : {}),
      estimatorEngine: {
        version: 3,
        origin: 'manual_agent',
        origins: ['lead', 'manual_agent'],
        lane: preview.lane,
        laneReasons: preview.lane_reasons,
        evidence: Array.isArray(input.evidence) ? input.evidence.slice(0, 30) : [],
        evidenceVerification: input.evidenceVerification || null,
        propertyFacts: input.propertyFacts || {},
        contactVerification: input.contactVerification || null,
        protocolReview: Array.isArray(input.protocolReview) ? input.protocolReview.slice(0, 30) : [],
        inventoryReview: Array.isArray(input.inventoryReview) ? input.inventoryReview.slice(0, 50) : [],
        reasoning: String(input.reasoning || '').slice(0, 5000),
        assumptions: Array.isArray(input.assumptions) ? input.assumptions.slice(0, 30) : [],
        uncertainty: Array.isArray(input.uncertainty) ? input.uncertainty.slice(0, 30) : [],
        pricingAuthority: 'generateEstimate',
        loadedLaborRate: 35,
        targetCollectedMargin: 0.35,
        existingCustomerExpansion: accountPricing.recognized,
        presentationTemplate: preview.presentation?.template || 'manual_review',
        serviceTemplateKeys: preview.presentation?.serviceTemplateKeys || [],
        reactEstimatePage: preview.presentation?.reactPage || 'estimate_v2',
        presentationMode: preview.presentation?.mode || 'recurring',
        presentationSelectionAuthority: preview.presentation?.selectionAuthority || 'requested_services',
        revisions,
      },
    },
    fields: {
      address: input.address,
      customer_name: input.customerName,
      customer_phone: input.customerPhone || null,
      customer_email: input.customerEmail || null,
      monthly_total: preview.totals.monthly,
      annual_total: preview.totals.annual,
      onetime_total: preview.totals.oneTime,
      waveguard_tier: titleWaveGuardTier(preview.engineResult?.waveGuard?.tier),
      service_interest: serviceKeys.map((key) => key.replace(/([A-Z])/g, ' $1').trim())
        .map((key) => key.charAt(0).toUpperCase() + key.slice(1)).join(' + '),
      category: isCommercial ? 'COMMERCIAL' : 'RESIDENTIAL',
    },
  };
}

// Mirrors the client's open-lead statuses (LeadsTabs OPEN_FILTER_STATUSES).
// Agent Estimate is an open-lead workflow, and the check must hold at
// CONFIRMED-write time — the lead can be closed by another operator or an
// automation while a confirmation card is outstanding, so a render-time
// client check alone is not enough.
const OPEN_LEAD_STATUSES = new Set(['new', 'contacted', 'estimate_sent', 'estimate_viewed']);

async function loadAgentEstimateLead(leadId, database = db) {
  const lead = await database('leads').where({ id: leadId }).whereNull('deleted_at').first();
  if (!lead) return { error: 'Lead not found' };
  const status = String(lead.status || 'new').toLowerCase();
  if (!OPEN_LEAD_STATUSES.has(status)) {
    return { error: `This lead is ${status.replace(/_/g, ' ')} — Agent Estimate drafts open leads only. Reopen the lead before drafting.` };
  }
  return { lead };
}

function normalizeContactPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function addressIdentity(value) {
  const text = String(value || '').trim();
  return {
    streetNumber: text.match(/\b\d{1,7}\b/)?.[0] || null,
    zip: text.match(/\b\d{5}(?:-\d{4})?\b/)?.[0]?.slice(0, 5) || null,
    normalizedStreet: text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
  };
}

function anchorAgentEstimateContact(input, lead) {
  const leadPhone = String(lead.phone || '').trim();
  const inputPhone = String(input.customerPhone || '').trim();
  if (leadPhone && inputPhone && normalizeContactPhone(leadPhone) !== normalizeContactPhone(inputPhone)) {
    return { error: 'Draft phone does not match the selected lead. Refresh the lead evidence before drafting.' };
  }
  const leadEmail = String(lead.email || '').trim();
  const inputEmail = String(input.customerEmail || '').trim();
  if (leadEmail && inputEmail && leadEmail.toLowerCase() !== inputEmail.toLowerCase()) {
    return { error: 'Draft email does not match the selected lead. Refresh the lead evidence before drafting.' };
  }
  const leadName = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim();
  const leadAddress = [lead.address, lead.city, lead.zip].filter(Boolean).join(', ');
  const inputAddress = String(input.address || '').trim();
  const leadAddressIdentity = addressIdentity(leadAddress);
  const inputAddressIdentity = addressIdentity(input.address);
  // Compare the FULL normalized street line when the lead has one — a
  // number+ZIP-only identity lets "123 Main St" draft as "123 Oak St" without
  // the yellow-lane address flag. Number+ZIP stays as the fallback when the
  // lead carries no street line. A false positive only flags review; a false
  // negative persists a quote against the wrong property.
  const addressMismatch = !!(
    (lead.address && inputAddress && !sameStreetAddress(leadAddress, inputAddress))
    || (leadAddressIdentity.streetNumber && inputAddressIdentity.streetNumber
      && leadAddressIdentity.streetNumber !== inputAddressIdentity.streetNumber)
    || (leadAddressIdentity.zip && inputAddressIdentity.zip
      && leadAddressIdentity.zip !== inputAddressIdentity.zip)
  );
  return {
    input: {
      ...input,
      customerName: leadName || input.customerName,
      // The LEAD is the only recipient authority. When a lead field is blank
      // a model-supplied phone/email must NOT become the stored recipient —
      // the send path delivers the bearer estimate link to these columns, and
      // the confirmation card does not display them, so a hallucinated
      // contact would be undetectable until it was already sent.
      customerPhone: leadPhone || null,
      customerEmail: leadEmail || null,
      contactVerification: {
        addressMismatch,
        selectedLeadHasAddress: !!leadAddress,
      },
    },
  };
}

// Shared duplicate guard for BOTH Agent Estimate write paths. The phone
// helper alone returns only the newest open estimate, so this checks EVERY
// open estimate on the phone: a same-street open estimate blocks (pointing
// at that row), the different-property bypass applies only when every open
// estimate has a known, street-different address, and any unknown address
// keeps the conservative block.
async function agentEstimateDuplicateBlock(trx, phone, address, { excludeEstimateId = null } = {}) {
  let duplicateBlock = await blockIfAutomatedEstimateDuplicate(phone, { database: trx, excludeEstimateId });
  if (duplicateBlock?.existingEstimateId && address) {
    try {
      const phoneLast10 = String(phone || '').replace(/\D/g, '').slice(-10);
      let query = trx('estimates')
        .select('id', 'address')
        .whereRaw("right(regexp_replace(coalesce(customer_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [phoneLast10])
        .whereIn('status', OPEN_ESTIMATE_STATUSES)
        .whereNull('archived_at');
      if (excludeEstimateId) query = query.whereNot('id', excludeEstimateId);
      const openRows = await query;
      const sameProperty = openRows.find((row) => row.address && sameStreetAddress(row.address, address));
      if (sameProperty) {
        duplicateBlock = { ...duplicateBlock, existingEstimateId: sameProperty.id };
      } else if (openRows.length && openRows.every((row) => row.address)) {
        logger.info('[intelligence-bar:agent-estimate] duplicate guard bypassed — every open estimate on this phone is a different property');
        duplicateBlock = null;
      }
    } catch (dupErr) {
      logger.warn(`[intelligence-bar:agent-estimate] duplicate address compare failed (keeping block): ${dupErr.message}`);
    }
  }
  return duplicateBlock;
}

function duplicateBlockResult(duplicateBlock) {
  return {
    error: duplicateBlock.message || 'An automated estimate is already open for this phone number',
    blocked: true,
    existing_estimate_id: duplicateBlock.existingEstimateId,
  };
}

async function reviseOwnedAgentDraft(estimateId, input, preview, accountPricing = accountPricingFromContext()) {
  return db.transaction(async (trx) => {
    // Lock the lead row and revalidate its open status INSIDE the revision
    // transaction — the pre-transaction check goes stale while context
    // loading, repricing, and membership queries run, and another operator
    // can close the lead in that window (mirrors persistNewAgentDraft).
    await trx('leads').where({ id: input.leadId }).forUpdate().select('id');
    const leadCheck = await loadAgentEstimateLead(input.leadId, trx);
    if (leadCheck.error) return leadCheck;
    // Re-anchor recipients from the LOCKED lead row: a contact correction
    // that landed between the pre-transaction anchor and this lock must win,
    // or the draft persists (and later sends to) the stale phone/email.
    const reanchored = anchorAgentEstimateContact(input, leadCheck.lead);
    if (reanchored.error) return reanchored;
    const lockedInput = reanchored.input;
    const estimate = await trx('estimates').where({ id: estimateId }).forUpdate().first();
    if (!estimate) return { error: 'Agent Estimate draft not found' };
    if (estimate.status !== 'draft' || estimate.source !== 'estimator_engine') {
      return { error: 'Only an unsent estimator_engine draft can be revised from Agent Estimate' };
    }
    const currentData = parseStoredJson(estimate.estimate_data);
    if (currentData?.estimatorEngine?.origin !== 'manual_agent') {
      return { error: 'This draft was created by another estimator flow and will not be overwritten' };
    }
    if (currentData.lead_id && String(currentData.lead_id) !== String(input.leadId)) {
      return { error: 'This Agent Estimate draft belongs to a different lead and will not be overwritten' };
    }
    // A revision rewrites the stored address and recipient — recheck the
    // phone/property duplicate guard (excluding this row) so a correction to
    // another property can't leave two open estimates on the same
    // phone/street.
    const duplicateBlock = await agentEstimateDuplicateBlock(
      trx,
      lockedInput.customerPhone || null,
      lockedInput.address,
      { excludeEstimateId: estimate.id },
    );
    if (duplicateBlock) return duplicateBlockResult(duplicateBlock);
    const payload = agentEstimatePayload(lockedInput, preview, currentData, accountPricing);
    // Merge over the existing JSON instead of replacing it: an operator can
    // author a commercial proposal on a draft (estimate_data.proposal), and a
    // full overwrite would silently delete it. Agent-owned OPTIONAL keys are
    // explicitly cleared when the new payload no longer carries them, so a
    // lapsed membership or prior-services set can't survive the merge.
    const mergedData = { ...currentData, ...payload.data };
    if (!payload.data.membershipSnapshot) delete mergedData.membershipSnapshot;
    if (!payload.data.priorQualifyingServices) delete mergedData.priorQualifyingServices;
    const [updated] = await trx('estimates').where({ id: estimate.id, status: 'draft', source: 'estimator_engine' })
      .update({
        estimate_data: JSON.stringify(mergedData),
        ...payload.fields,
        // Recognition is reloaded for every confirmation — use ONLY the
        // current result. Falling back to the row's old customer_id would
        // keep a stale link after the lead was unlinked or its phone became
        // ambiguous, and acceptance would apply the quote to the wrong
        // account.
        customer_id: accountPricing.customerId || null,
        notes: null,
        updated_at: trx.fn.now(),
      })
      .returning(['id', 'token']);
    if (!updated) return { error: 'Draft changed while revising; refresh and try again' };
    await trx('leads').where({ id: input.leadId }).update({ estimate_id: updated.id });
    return { estimate: updated, revised: true };
  });
}

async function persistNewAgentDraft(input, preview, actionContext, accountPricing = accountPricingFromContext()) {
  const phone = input.customerPhone || null;
  const persist = async (trx) => {
    // Lock the lead row for the whole read-check-insert-update sequence —
    // on the email-only path there is no phone advisory lock, so two
    // confirmation cards for the same lead could otherwise both see no
    // estimate and create duplicate drafts.
    await trx('leads').where({ id: input.leadId }).forUpdate().select('id');
    const leadResult = await loadAgentEstimateLead(input.leadId, trx);
    if (leadResult.error) return leadResult;
    const lead = leadResult.lead;
    // Re-anchor recipients from the LOCKED lead row: a contact correction
    // that landed between the pre-transaction anchor and this lock must win,
    // or the draft persists (and later sends to) the stale phone/email.
    const reanchored = anchorAgentEstimateContact(input, lead);
    if (reanchored.error) return reanchored;
    const lockedInput = reanchored.input;

    if (lead.estimate_id) {
      const existing = await trx('estimates').where({ id: lead.estimate_id }).first();
      if (existing?.status === 'draft' && existing?.source === 'estimator_engine') {
        const existingData = parseStoredJson(existing.estimate_data);
        if (existingData?.estimatorEngine?.origin === 'manual_agent') {
          // Leave the phone-lock transaction before revising the row in its
          // own transaction; nesting a second transaction here can wait on
          // the lead/estimate locks held by this one.
          return { useExistingEstimateId: existing.id };
        }
      }
      if (existing && !existing.archived_at) {
        return { error: 'This lead is already linked to another active estimate; it was not overwritten.' };
      }
    }

    const duplicateBlock = await agentEstimateDuplicateBlock(trx, lockedInput.customerPhone || null, lockedInput.address);
    if (duplicateBlock) return duplicateBlockResult(duplicateBlock);

    const payload = agentEstimatePayload(lockedInput, preview, {}, accountPricing);
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const [estimate] = await trx('estimates').insert({
      estimate_data: JSON.stringify(payload.data),
      ...payload.fields,
      // ONLY the recognition this confirmation priced with. A lead.customer_id
      // fallback could adopt a customer linked AFTER pricing ran, attaching an
      // account whose services and tier the quote never accounted for.
      customer_id: accountPricing.customerId || null,
      notes: null,
      token,
      expires_at: expiresAt,
      status: 'draft',
      source: 'estimator_engine',
      created_by_technician_id: actionContext.technicianId || null,
    }).returning(['id', 'token']);
    await trx('leads').where({ id: lead.id }).update({ estimate_id: estimate.id });
    return { estimate, revised: false };
  };

  // withAutomatedEstimatePhoneLock runs the callback WITHOUT a transaction or
  // advisory lock when there is no 10-digit phone key — an email-only lead
  // still needs the sequence serialized, so open our own transaction (the
  // lead-row lock above is the duplicate key in that case).
  if (String(phone || '').replace(/\D/g, '').length >= 10) {
    return withAutomatedEstimatePhoneLock(phone, persist);
  }
  return db.transaction(persist);
}

async function createAgentEstimateDraft(input, actionContext = {}) {
  const leadResult = await loadAgentEstimateLead(input?.leadId);
  if (leadResult.error) return leadResult;
  const anchored = anchorAgentEstimateContact(input, leadResult.lead);
  if (anchored.error) return anchored;
  const leadContext = await buildAgentEstimateContext(input.leadId);
  if (leadContext?.error) return { error: 'Selected lead evidence could not be loaded' };
  const accountPricing = accountPricingFromContext(leadContext);
  const anchoredInput = {
    ...anchored.input,
    evidenceVerification: verifyAgentEvidenceQuotes(anchored.input.evidence, leadContext),
  };
  const preview = await computeAgentDraftPreview(anchoredInput, accountPricing);
  if (preview.error) return preview;

  if (accountPricing.customerId) {
    accountPricing.membershipSnapshot = await computeMembershipContext(db, {
      customerId: accountPricing.customerId,
      estData: {
        lineItems: preview.engineResult?.lineItems || [],
        // appliedRecurringRate reads this aggregate to detect margin-floor-
        // capped WaveGuard discounts; with lineItems alone it falls back to
        // the full tier rate and the public card can advertise a discount the
        // stored total doesn't include.
        recurring: {
          annualBeforeDiscount: Number(preview.engineResult?.summary?.recurringAnnualBeforeDiscount || 0),
          annualAfterDiscount: Number(preview.engineResult?.summary?.recurringAnnualAfterDiscount || 0),
        },
      },
    });
  }

  if (actionContext.confirmed !== true) {
    const { engineResult: _engineResult, ...safePreview } = preview;
    return {
      ...safePreview,
      pending_confirmation: true,
      note: 'No draft has been written. Confirm the action card to create or revise it.',
    };
  }

  let persisted = input.estimateId
    ? await reviseOwnedAgentDraft(input.estimateId, anchoredInput, preview, accountPricing)
    : await persistNewAgentDraft(anchoredInput, preview, actionContext, accountPricing);
  if (persisted.useExistingEstimateId) {
    persisted = await reviseOwnedAgentDraft(
      persisted.useExistingEstimateId,
      { ...anchoredInput, estimateId: persisted.useExistingEstimateId },
      preview,
      accountPricing,
    );
  }
  if (persisted.error) return persisted;

  const { estimate, revised } = persisted;
  logger.info('[intelligence-bar:agent-estimate] draft persisted', {
    estimateId: estimate.id,
    revised,
    lane: preview.lane,
  });
  return {
    success: true,
    revised,
    estimate_id: estimate.id,
    token: estimate.token,
    lane: preview.lane,
    lane_reasons: preview.lane_reasons,
    monthly_total: preview.totals.monthly,
    annual_total: preview.totals.annual,
    onetime_total: preview.totals.oneTime,
    customer_account: preview.customer_account,
    presentation_template: preview.presentation?.template || null,
    service_template_keys: preview.presentation?.serviceTemplateKeys || [],
    admin_preview_url: `/estimate/${estimate.token}?adminPreview=1`,
    note_for_admin: revised
      ? 'Draft revised in place. Preview it before sending.'
      : 'Draft created. Preview it before sending.',
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
  if (next) {
    const deliveryError = validateEstimateDeliveryOptions({
      showOneTimeOption: true,
      billByInvoice: false,
      onetimeTotal: estimate.onetime_total,
      monthlyTotal: estimate.monthly_total,
      annualTotal: estimate.annual_total,
      estimateData: estimate.estimate_data,
    });
    if (deliveryError) return { error: deliveryError };
  }
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

module.exports = {
  ESTIMATE_TOOLS,
  executeEstimateTool,
  _private: {
    agentEstimatePayload,
    compactAgentLine,
    computeAgentDraftPreview,
    getNeighborhoodGrassProfile,
    anchorAgentEstimateContact,
    presentationForServices,
    validateAgentEngineInput,
    verifyAgentEvidenceQuotes,
  },
};
