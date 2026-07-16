/**
 * Estimator Engine — intent schema (v1).
 *
 * The composer LLM's ONLY output is an "estimate intent": which catalog
 * services the caller asked for, expressed as pricing-engine inputs, plus
 * verbatim evidence quotes and constraint flags. The schema deliberately has
 * NO price fields — every dollar figure comes from the deterministic pricing
 * engine downstream. A composer response that fails this schema is retried
 * once with the validation errors, then the call falls to the red lane
 * (notification only, no draft).
 */

const Ajv = require('ajv');

// Engine service keys the composer may select, with the option enums the
// pricing engine actually reads (see pricing-engine/estimate-engine.js).
// Keys NOT listed here (wdo, exclusion, rodentTrapping, foam, plugging,
// topDressing, dethatching, sanitation…) are deliberately excluded from
// autonomous drafting — they are manual-scope or transaction-driven services;
// the composer must `skip` with a reason instead of guessing.
const SERVICE_OPTION_SCHEMAS = {
  pest: {
    type: 'object',
    properties: {
      // The pest pricer's cadence normalizer recognizes exactly these three
      // — a schema-valid but engine-unknown cadence (e.g. semiannual) would
      // silently price at quarterly. Unsupported cadences skip instead.
      frequency: { enum: ['monthly', 'bimonthly', 'quarterly'] },
      roachType: { enum: ['none', 'german', 'american'] },
    },
    additionalProperties: false,
  },
  oneTimePest: { type: 'object', additionalProperties: false, properties: {} },
  lawn: {
    type: 'object',
    properties: {
      track: { enum: ['st_augustine', 'bahia', 'zoysia', 'bermuda', 'paspalum'] },
      tier: { enum: ['basic', 'standard', 'enhanced', 'premium'] },
    },
    additionalProperties: false,
  },
  oneTimeLawn: {
    type: 'object',
    properties: { treatmentType: { enum: ['fertilizer', 'weed'] } },
    additionalProperties: false,
  },
  lawnPestControl: { type: 'object', additionalProperties: false, properties: {} },
  treeShrub: { type: 'object', additionalProperties: false, properties: {} },
  mosquito: {
    type: 'object',
    properties: { tier: { enum: ['seasonal9', 'monthly12'] } },
    additionalProperties: false,
  },
  oneTimeMosquito: { type: 'object', additionalProperties: false, properties: {} },
  termite: {
    type: 'object',
    properties: {
      system: { enum: ['advance'] },
      monitoringTier: { enum: ['basic'] },
    },
    additionalProperties: false,
  },
  flea: { type: 'object', additionalProperties: false, properties: {} },
  bedBug: {
    type: 'object',
    properties: {
      method: { enum: ['CHEMICAL', 'HEAT'] },
      rooms: { type: 'integer', minimum: 1, maximum: 12 },
      severity: { enum: ['light', 'moderate', 'severe'] },
      // Exactly priceBedBugTreatment's vocab — schema-valid values outside
      // it would throw during pricing.
      prepStatus: { enum: ['ready', 'partial', 'poor', 'refused'] },
      occupancyType: { enum: ['singleFamily', 'apartment', 'hotel', 'studentHousing'] },
    },
    additionalProperties: false,
  },
  rodentBait: { type: 'object', additionalProperties: false, properties: {} },
  stinging: {
    type: 'object',
    properties: {
      species: { enum: ['PAPER_WASP', 'YELLOW_JACKET', 'HORNET', 'HONEY_BEE'] },
      tier: { type: 'integer', minimum: 1, maximum: 3 },
      // priceStingingInsect's removal add-on vocab — a generic 'NEST' fell
      // through with removalPrice = 0 (silent underquote).
      removal: { enum: ['NONE', 'SMALL', 'LARGE', 'HONEYCOMB', 'RELOCATE'] },
    },
    additionalProperties: false,
  },
};

const ALLOWED_SERVICE_KEYS = Object.keys(SERVICE_OPTION_SCHEMAS);

const COMMERCIAL_RISK_TYPE_VALUES = [
  'office_low', 'retail_standard', 'hoa_common_area', 'warehouse_distribution',
  'restaurant_food', 'healthcare_childcare', 'hotel_resort', 'multifamily',
];

const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    decision: { enum: ['draft', 'skip'] },
    skip_reason: { type: ['string', 'null'] },
    customer_name: { type: ['string', 'null'] },
    customer_phone: { type: ['string', 'null'] },
    customer_email: { type: ['string', 'null'] },
    address: { type: ['string', 'null'] },
    category: { enum: ['RESIDENTIAL', 'COMMERCIAL'] },
    is_commercial: { type: 'boolean' },
    commercial_risk_type: { enum: [...COMMERCIAL_RISK_TYPE_VALUES, null] },
    commercial_subtype: { type: ['string', 'null'] },
    services: {
      type: 'object',
      properties: SERVICE_OPTION_SCHEMAS,
      additionalProperties: false,
      minProperties: 0,
    },
    service_interest_label: { type: ['string', 'null'] },
    evidence: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        properties: {
          decision: { type: 'string' },
          // An empty/trivial quote would satisfy the coverage count while
          // giving the operator nothing to verify.
          quote: { type: 'string', minLength: 12 },
          speaker: { enum: ['caller', 'agent'] },
        },
        required: ['decision', 'quote'],
        additionalProperties: false,
      },
    },
    constraint_flags: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        properties: {
          flag: { type: 'string' },
          note: { type: 'string' },
          quote: { type: ['string', 'null'] },
        },
        required: ['flag', 'note'],
        additionalProperties: false,
      },
    },
    uncertainties: { type: 'array', maxItems: 10, items: { type: 'string' } },
    confidence: { enum: ['high', 'medium', 'low'] },
  },
  required: ['decision', 'category', 'is_commercial', 'services', 'evidence', 'confidence'],
  additionalProperties: false,
  // A draft with no supporting quotes defeats the operator-verification
  // design (the notes' evidence section is the 10-second review path) — a
  // schema-valid `evidence: []` draft must fail and trigger the repair retry.
  allOf: [
    {
      if: { properties: { decision: { const: 'draft' } } },
      then: { properties: { evidence: { type: 'array', minItems: 1 } } },
    },
  ],
};

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
const validateIntentFn = ajv.compile(INTENT_SCHEMA);

// Returns { valid, errors } — errors formatted for the repair-retry prompt.
function validateIntent(intent) {
  const valid = validateIntentFn(intent);
  return {
    valid,
    errors: valid ? [] : (validateIntentFn.errors || []).map(
      (e) => `${e.instancePath || '(root)'} ${e.message}`,
    ),
  };
}

module.exports = {
  INTENT_SCHEMA,
  ALLOWED_SERVICE_KEYS,
  SERVICE_OPTION_SCHEMAS,
  COMMERCIAL_RISK_TYPE_VALUES,
  validateIntent,
};
