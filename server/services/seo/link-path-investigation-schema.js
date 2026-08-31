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
  EXPECTED_PERSISTENCE, RENEWAL_PERIODS, FEE_SCOPES,
} = require('./link-registry');

const VERDICTS = Object.freeze(['qualified', 'not_reproducible', 'watching']);

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
    // §3.2 type consistency (the §6.3 validity step re-asserts this in step 4).
    {
      if: { properties: { acquisition_type: { enum: ['paid_listing', 'membership', 'association', 'sponsorship'] } } },
      then: { properties: { payment_required: { const: true } } },
    },
    {
      if: { properties: { acquisition_type: { const: 'self_service_free' } } },
      then: { properties: { payment_required: { const: false } } },
    },
  ],
};

const INVESTIGATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'watch_reason', 'paths'],
  properties: {
    verdict: { type: 'string', enum: [...VERDICTS] },
    watch_reason: nullableString(500),
    paths: { type: 'array', maxItems: 6, items: PATH_SCHEMA },
  },
  allOf: [
    {
      if: { properties: { verdict: { const: 'watching' } } },
      then: { properties: { watch_reason: { type: 'string', minLength: 1 } } },
    },
    // A qualified domain must show at least one path that is not a dead end.
    {
      if: { properties: { verdict: { const: 'qualified' } } },
      then: { properties: { paths: { type: 'array', minItems: 1 } } },
    },
  ],
};

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, formats: { uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i } });
const validateFn = ajv.compile(INVESTIGATION_SCHEMA);

// Returns { valid, errors } — errors formatted for the repair-retry prompt.
function validateInvestigation(data) {
  const valid = validateFn(data);
  return {
    valid,
    errors: valid ? [] : (validateFn.errors || []).map((e) => `${e.instancePath || '(root)'} ${e.message}`),
  };
}

module.exports = { INVESTIGATION_SCHEMA, PATH_SCHEMA, VERDICTS, validateInvestigation };
