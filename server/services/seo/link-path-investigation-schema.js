/**
 * Backlink Manager v2 — step 3: investigator output contract (plan §5, §3.2).
 *
 * The strict JSON schema for the ONE WORKHORSE call per domain. Design rules
 * it enforces mechanically:
 *   - The model NEVER emits an amount — no `*_cost_cents` field exists here
 *     (`additionalProperties: false`); it returns the quoted price text
 *     VERBATIM and the deterministic currency gate + parsePriceTextCents()
 *     derive the integer cents (link-path-investigator.js).
 *   - Every authority-relevant flag is a REQUIRED literal boolean (§3.2:
 *     the investigator must answer each explicitly).
 *   - Enums are the same frozen sets as link-registry.js (a test pins them
 *     equal); confidence is bounded [0,1] in the schema itself, so a
 *     malformed confidence can never clear a floor downstream.
 *   - `not_reproducible` is a first-class verdict, closing a domain honestly.
 */

const Ajv = require('ajv');
const {
  ACQUISITION_TYPES, PATH_LINK_TYPES, EXPECTED_REL, EXPECTED_INDEXABILITY,
  EXPECTED_PERSISTENCE, RENEWAL_PERIODS, FEE_SCOPES, OUTREACH_ACQUISITION_TYPES, pathKey,
} = require('./link-registry');

// Board lanes by executor — mirrors link-prospect-worker's SIGNUP_TYPES /
// OUTREACH_TYPES (asserted equal by the schema contract test; the worker
// module is not required here because it binds the DB on load).
const SIGNUP_LINK_TYPES = Object.freeze(['directory', 'citation', 'social']);
const OUTREACH_LINK_TYPES = Object.freeze(['editorial', 'resource', 'guest_post', 'haro']);

const VERDICTS = Object.freeze(['qualified', 'not_reproducible', 'watching']);

// Types that carry an executable identity — `unknown`/`not_reproducible`
// paths live only in the evidence (the investigator never writes them as
// rows), so a `qualified` verdict must contain at least one of these.
const EXECUTABLE_ACQUISITION_TYPES = Object.freeze(
  ACQUISITION_TYPES.filter((t) => t !== 'unknown' && t !== 'not_reproducible'),
);

// Types that execute THROUGH a site (form, listing, checkout, claim flow) —
// they are meaningless without a submission URL. Outreach-shaped types
// (resource/editorial outreach, partnership) contact a person and may
// legitimately carry none.
const URL_REQUIRED_ACQUISITION_TYPES = Object.freeze([
  'self_service_free', 'self_service_account', 'paid_listing', 'membership',
  'association', 'sponsorship', 'vendor_registration', 'business_claim', 'content_submission',
]);

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const nullableEnum = (values) => nullable({ type: 'string', enum: [...values] });
const nullableString = (maxLength) => nullable({ type: 'string', maxLength });

// One observed acquisition path. `price_text` / `renewal_price_text` are the
// verbatim quotes with the page URL each was read from (§5) — the ONLY money
// signal the model may produce.
const PATH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'acquisition_type', 'submission_url',
    'account_required', 'email_verification', 'payment_required', 'legal_attestation', 'agent_completable',
    'terms_accepted_by_send', 'execution_after_send',
    'link_type', 'expected_rel', 'expected_indexability', 'expected_persistence',
    'confidence', 'fee_scope', 'renewal_period',
    'price_text', 'price_page_url', 'renewal_price_text', 'renewal_price_page_url',
    'currency_evidence', 'merchant_binding', 'legal_terms_url', 'replaces_path_id',
    'reasons', 'quotes',
  ],
  properties: {
    acquisition_type: { type: 'string', enum: [...ACQUISITION_TYPES] },
    submission_url: nullableString(2048),
    account_required: { type: 'boolean' },
    email_verification: { type: 'boolean' },
    payment_required: { type: 'boolean' },
    legal_attestation: { type: 'boolean' },
    agent_completable: { type: 'boolean' },
    terms_accepted_by_send: { type: 'boolean' },
    execution_after_send: { type: 'boolean' },
    link_type: { type: 'string', enum: [...PATH_LINK_TYPES] },
    expected_rel: { type: 'string', enum: [...EXPECTED_REL] },
    expected_indexability: { type: 'string', enum: [...EXPECTED_INDEXABILITY] },
    expected_persistence: { type: 'string', enum: [...EXPECTED_PERSISTENCE] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    fee_scope: nullableEnum(FEE_SCOPES),
    renewal_period: nullableEnum(RENEWAL_PERIODS),
    price_text: nullableString(300),
    price_page_url: nullableString(2048),
    renewal_price_text: nullableString(300),
    renewal_price_page_url: nullableString(2048),
    // The authoritative USD marker the model OBSERVED (never inferred from a
    // bare `$`): 'USD'/'US$' in the quote, JSON-LD priceCurrency, or the
    // processor session currency — with where it was seen.
    currency_evidence: nullable({
      type: 'object',
      additionalProperties: false,
      required: ['marker', 'kind', 'page_url'],
      properties: {
        marker: { type: 'string', maxLength: 40 },
        kind: { type: 'string', enum: ['quote', 'jsonld_price_currency', 'processor_currency'] },
        page_url: nullableString(2048),
      },
    }),
    merchant_binding: nullable({
      type: 'object',
      additionalProperties: false,
      required: ['checkout_origin', 'processor', 'issuer_merchant_descriptor'],
      properties: {
        checkout_origin: nullableString(2048),
        processor: nullable({
          type: 'object',
          additionalProperties: false,
          required: ['host', 'merchant_account_id'],
          properties: {
            host: nullableString(255),
            merchant_account_id: nullableString(255),
          },
        }),
        issuer_merchant_descriptor: nullableString(255),
      },
    }),
    legal_terms_url: nullableString(2048),
    // Explicit predecessor match ONLY (§3.2 identity rule): the id of an
    // existing path this one supersedes (old URL gone/redirected/renamed).
    replaces_path_id: nullable({ type: 'string', format: 'uuid' }),
    reasons: { type: 'string', maxLength: 1000 },
    quotes: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 500 } },
  },
  allOf: [
    // A paid path must answer the fee scope; a free one must not invent one.
    {
      if: { properties: { payment_required: { const: true } } },
      then: { properties: { fee_scope: { type: 'string', enum: [...FEE_SCOPES] } } },
      else: { properties: { fee_scope: { type: 'null' } } },
    },
    // A site-executed type without a submission URL is not a path.
    {
      if: { properties: { acquisition_type: { enum: [...URL_REQUIRED_ACQUISITION_TYPES] } } },
      then: { properties: { submission_url: { type: 'string', minLength: 1 } } },
    },
    // §6.3 deadlock rule (plan L788): send-accepted terms force send-first
    // ordering — submit-first (execution_after_send=false) with
    // terms_accepted_by_send=true would make the submit require an
    // acceptance only the post-submit late send performs.
    {
      if: { properties: { terms_accepted_by_send: { const: true } } },
      then: { properties: { execution_after_send: { const: true } } },
    },
    // A send that legally ACCEPTS terms needs an attestation bound to the
    // agreement hash (§3.2): terms_accepted_by_send without
    // legal_attestation would bypass the terms-fetch/hash gate entirely.
    {
      if: { properties: { terms_accepted_by_send: { const: true } } },
      then: { properties: { legal_attestation: { const: true } } },
    },
    // §3.2 type consistency (the §6.3 validity step re-asserts this in step 4).
    {
      if: { properties: { acquisition_type: { enum: ['paid_listing', 'membership', 'association', 'sponsorship'] } } },
      then: { properties: { payment_required: { const: true } } },
    },
    {
      if: { properties: { acquisition_type: { const: 'self_service_free' } } },
      then: { properties: { payment_required: { const: false } } },
    },
    // Lane consistency: the path's link_type is the board lane a placement
    // moved onto it inherits, and the worker routes lanes to executors —
    // outreach lanes to the outreach worker, directory/citation/social to
    // the signup runner. An outreach acquisition type in a signup lane (or
    // a site-executed type in an outreach lane) would hand the placement to
    // the wrong executor.
    {
      if: { properties: { acquisition_type: { enum: [...OUTREACH_ACQUISITION_TYPES] } } },
      then: { properties: { link_type: { enum: [...OUTREACH_LINK_TYPES] } } },
      else: { properties: { link_type: { enum: [...SIGNUP_LINK_TYPES] } } },
    },
  ],
};

// The response contract caps the paths array — a verdict AT the cap may
// have been forced to omit real paths, so omission at the cap is never
// treated as disproof by the investigator.
const MAX_MODEL_PATHS = 6;

const INVESTIGATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'watch_reason', 'paths'],
  properties: {
    verdict: { type: 'string', enum: [...VERDICTS] },
    watch_reason: nullableString(500),
    paths: { type: 'array', maxItems: MAX_MODEL_PATHS, items: PATH_SCHEMA },
  },
  allOf: [
    {
      if: { properties: { verdict: { const: 'watching' } } },
      then: { properties: { watch_reason: { type: 'string', minLength: 1 } } },
    },
    // A not_reproducible verdict asserts NO path exists — it may carry
    // evidence entries (dead-end types, zero confidence) but never a
    // positive-confidence executable path beside the assertion.
    {
      if: { properties: { verdict: { const: 'not_reproducible' } } },
      then: {
        properties: {
          paths: {
            type: 'array',
            not: {
              contains: {
                type: 'object',
                required: ['acquisition_type', 'confidence'],
                properties: {
                  acquisition_type: { enum: [...ACQUISITION_TYPES.filter((t) => t !== 'unknown' && t !== 'not_reproducible')] },
                  confidence: { type: 'number', exclusiveMinimum: 0 },
                },
              },
            },
          },
        },
      },
    },
    // A qualified domain must show at least one EXECUTABLE path with real
    // confidence — a verdict backed only by unknown/not_reproducible or
    // zero-confidence paths would qualify a domain with no best path at all.
    {
      if: { properties: { verdict: { const: 'qualified' } } },
      then: {
        properties: {
          paths: {
            type: 'array',
            minItems: 1,
            contains: {
              type: 'object',
              required: ['acquisition_type', 'confidence'],
              properties: {
                acquisition_type: { enum: [...EXECUTABLE_ACQUISITION_TYPES] },
                confidence: { type: 'number', exclusiveMinimum: 0 },
              },
            },
          },
        },
      },
    },
  ],
};

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, formats: { uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i } });
const validateFn = ajv.compile(INVESTIGATION_SCHEMA);

// Returns { valid, errors } — errors formatted for the repair-retry prompt.
// Beyond the JSON Schema: every path must carry a DISTINCT persisted
// identity — the same derived (acquisition_type, normalized submission_url)
// key the write phase upserts on. Two entries collapsing onto one key (an
// apex and its www alias with different inferred fees) would otherwise
// upsert the same row twice, letting array order decide which price, flags
// and evidence survive and double-bumping revisions in one investigation.
function validateInvestigation(data) {
  const valid = validateFn(data);
  if (!valid) return { valid, errors: (validateFn.errors || []).map((e) => `${e.instancePath || '(root)'} ${e.message}`) };
  const seen = new Map();
  const replaces = new Map();
  for (const [i, p] of (data.paths || []).entries()) {
    const key = pathKey(p.acquisition_type, p.submission_url);
    if (seen.has(key)) {
      return { valid: false, errors: [`/paths/${i} duplicates the identity of /paths/${seen.get(key)} (${key}) — report each (acquisition_type, submission_url) once, merging what you observed`] };
    }
    seen.set(key, i);
    // ONE successor per predecessor: two paths naming the same
    // replaces_path_id would let array order decide which one retires the
    // predecessor and inherits its placements (and their worker lane)
    if (p.replaces_path_id) {
      const pred = String(p.replaces_path_id).toLowerCase(); // a UUID is case-insensitive — one predecessor, whatever the casing
      if (replaces.has(pred)) {
        return { valid: false, errors: [`/paths/${i} names the same replaces_path_id as /paths/${replaces.get(pred)} (${pred}) — a predecessor has exactly one successor; name it on the path you observed replacing it`] };
      }
      replaces.set(pred, i);
    }
  }
  return { valid: true, errors: [] };
}

module.exports = { INVESTIGATION_SCHEMA, PATH_SCHEMA, VERDICTS, EXECUTABLE_ACQUISITION_TYPES, URL_REQUIRED_ACQUISITION_TYPES, SIGNUP_LINK_TYPES, OUTREACH_LINK_TYPES, MAX_MODEL_PATHS, validateInvestigation };
