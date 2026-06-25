/**
 * completion-defaults-resolver
 *
 * Builds the resolved one-tap completion snapshot — the bundle of
 * products, areas, customer-interaction state, and review routing
 * that the route persists via storeResolvedSnapshot and that
 * service_records keeps as the long-term audit copy. The route's
 * GET /complete-preview endpoint and (in a later PR) the POST
 * /complete?useProtocolDefaults=true path both call this one
 * resolver so the snapshot the tech saw on the preview is exactly
 * what gets persisted on submit.
 *
 * The resolver is intentionally pure with respect to its inputs:
 * given (serviceId, customerInteractionChoice, now) it always
 * returns the same snapshot AND the same stable hash for the same
 * underlying database state. Stability of the hash is what powers
 * the preview→submit handshake (PR #3): the client sends back the
 * hash it saw on preview; if the resolver computes a different
 * hash at submit time (active protocol template changed, products
 * renamed, etc.) the route returns 409 completion_preview_stale.
 *
 * Returns:
 *   { ok: true, snapshot, snapshotHash }                 — caller may proceed
 *   { ok: false, reason: 'no_active_protocol_template' } — service_type has no template
 *   { ok: false, reason: 'protocol_not_deterministic' }  — template flagged non-deterministic
 *   { ok: false, reason: 'customer_interaction_required' } — caller didn't supply a chip choice
 */

const db = require('../models/db');
const { hashResolvedSnapshot } = require('./completion-attempts');
const { CITY_TO_LOCATION: CANONICAL_CITY_TO_LOCATION } = require('../config/locations');

// Review GBP routing shares the canonical office map (config/locations.js) so
// cities added there — including ZIP-recovered ones (utils/zip-to-city.js) —
// route reviews to the right GBP automatically instead of silently defaulting
// to Bradenton. The overrides below are the deliberate review-only exceptions
// where a city's reviews go to a different GBP than its lead office (Palmetto
// and Longboat Key reviews route to the Bradenton GBP), plus finer-grained
// neighborhood keys that aren't needed for lead routing.
const REVIEW_GBP_BY_CITY = {
  ...CANONICAL_CITY_TO_LOCATION,
  'palmetto': 'bradenton',
  'longboat key': 'bradenton',
  'braden river': 'bradenton',
  'bee ridge': 'sarasota',
  'gulf gate': 'sarasota',
};

const CUSTOMER_INTERACTION_CHOICES = [
  'tech_home_spoke_with_them',
  'not_home_full_access',
  'not_home_partial_access',
  'customer_specific_concern',
];

const SNAPSHOT_VERSION = 'complete_service_one_tap_v1';
const ATTESTATION_VERSION = '2026.05';

function joinList(items) {
  if (!items.length) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function renderAttestation(template, { protocolName, products, areas }) {
  return template
    .replace('{protocol_name}', protocolName)
    .replace('{products}', joinList(products))
    .replace('{areas}', joinList(areas));
}

function resolveReviewRouting(customer) {
  const city = String(customer?.city || '').toLowerCase().trim();
  const gbp = REVIEW_GBP_BY_CITY[city] || 'bradenton';
  const routingReason = REVIEW_GBP_BY_CITY[city] ? `service_city_${city.replace(/\s+/g, '_')}` : 'default_fallback';
  return { gbpResolved: gbp, routingReason };
}

async function loadActiveTemplate(serviceType, knex) {
  // Real-world routine pest jobs use a wide range of service_type
  // labels — 'General Pest Control', 'General Pest Control (Quarterly)',
  // '(Bi-Monthly)', '(Monthly)', 'Quarterly Pest Control', 'Recurring
  // Pest Control', etc. Look up via the alias table so one
  // protocol_template can cover the full set without seeding a
  // separate template row per variant.
  //
  // Falls back to the legacy exact-match on protocol_templates.service_type
  // for any future templates that get seeded directly without an alias
  // row — e.g. a one-off mosquito or termite protocol whose service_type
  // is unambiguous.
  const aliased = await knex('protocol_template_service_types as pst')
    .join('protocol_templates as pt', 'pt.id', 'pst.protocol_template_id')
    .where('pst.service_type', serviceType)
    .andWhere('pt.status', 'active')
    .orderBy('pt.activated_at', 'desc')   // newest active wins on duplicate alias
    .first('pt.*');
  if (aliased) return aliased;
  return knex('protocol_templates')
    .where({ service_type: serviceType, status: 'active' })
    .first();
}

async function loadTemplateChildren(templateId, knex) {
  const [products, areas, actions] = await Promise.all([
    knex('protocol_template_products')
      .where({ protocol_template_id: templateId })
      .orderBy('sort_order', 'asc')
      .select('product_id', 'product_name_snapshot', 'rate_basis', 'rate', 'rate_unit', 'application_method', 'sort_order'),
    knex('protocol_template_areas')
      .where({ protocol_template_id: templateId })
      .orderBy('sort_order', 'asc')
      .select('area_key', 'area_label', 'sort_order'),
    knex('protocol_template_actions')
      .where({ protocol_template_id: templateId })
      .orderBy('sort_order', 'asc')
      .select('action_key', 'action_label', 'required', 'sort_order'),
  ]);
  return { products, areas, actions };
}

/**
 * Resolve the one-tap completion bundle for a scheduled service.
 *
 * @param {object} params
 * @param {string} params.serviceId
 * @param {string|null} params.customerInteractionChoice — one of
 *   CUSTOMER_INTERACTION_CHOICES, or null. When null and no historical
 *   inference is available, the resolver requires the caller to surface
 *   the chip and re-call with the choice.
 * @param {Date} params.now — server time, injected for determinism in
 *   tests.
 * @param {object} [params.trx] — optional knex transaction.
 * @returns {Promise<object>}
 */
async function resolveStandardCompletionDefaults({
  serviceId,
  customerInteractionChoice = null,
  now,
  trx,
}) {
  const knex = trx || db;
  const resolvedAt = (now || new Date()).toISOString();

  const service = await knex('scheduled_services')
    .where({ 'scheduled_services.id': serviceId })
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .select(
      'scheduled_services.id as service_id',
      'scheduled_services.service_type',
      'scheduled_services.customer_id',
      'customers.city as customer_city',
      'customers.first_name',
      'customers.last_name',
      'customers.has_left_google_review'
    )
    .first();
  if (!service) {
    return { ok: false, reason: 'service_not_found' };
  }

  const template = await loadActiveTemplate(service.service_type, knex);
  if (!template) {
    return { ok: false, reason: 'no_active_protocol_template', serviceType: service.service_type };
  }
  if (!template.is_deterministic) {
    return {
      ok: false,
      reason: 'protocol_not_deterministic',
      protocolTemplateId: template.id,
      protocolTemplateVersion: template.version,
    };
  }

  // Customer interaction — PR #2 scope: the chip is always required
  // unless the caller passes a valid choice. PR #3+ can layer the
  // "infer from last successful visit" fallback once there's a client
  // surface that needs it.
  let customerInteraction = null;
  let customerInteractionSource = null;
  if (customerInteractionChoice) {
    if (!CUSTOMER_INTERACTION_CHOICES.includes(customerInteractionChoice)) {
      return {
        ok: false,
        reason: 'customer_interaction_invalid',
        validChoices: CUSTOMER_INTERACTION_CHOICES,
      };
    }
    if (customerInteractionChoice === 'customer_specific_concern') {
      // A "specific concern" is incompatible with the one-tap attestation
      // path — the tech needs to record the concern detail, which lives
      // in the detailed-form flow. Caller should switch to detailed form.
      return {
        ok: false,
        reason: 'customer_concern_requires_detailed_form',
      };
    }
    customerInteraction = customerInteractionChoice;
    customerInteractionSource = 'tech_confirmed_at_completion';
  } else {
    return {
      ok: false,
      reason: 'customer_interaction_required',
      requiredChoices: CUSTOMER_INTERACTION_CHOICES.filter((c) => c !== 'customer_specific_concern'),
    };
  }

  const children = await loadTemplateChildren(template.id, knex);
  if (children.products.length === 0 || children.areas.length === 0) {
    // A deterministic template with no products or no areas is
    // misconfigured — the attestation would be vacuous. Treat as
    // operational not-deterministic.
    return {
      ok: false,
      reason: 'protocol_misconfigured',
      protocolTemplateId: template.id,
    };
  }

  const productNames = children.products.map((p) => p.product_name_snapshot);
  const areaLabels = children.areas.map((a) => a.area_label);
  const attestationText = renderAttestation(template.attestation_template, {
    protocolName: template.display_name,
    products: productNames,
    areas: areaLabels,
  });

  const reviewRouting = resolveReviewRouting({ city: service.customer_city });
  const reviewEligible = !service.has_left_google_review;

  const snapshot = {
    snapshotVersion: SNAPSHOT_VERSION,
    resolvedAt,

    visitOutcome: 'completed',
    completionSource: 'one_tap_completion',

    protocolDefaultsUsed: true,
    protocolTemplateId: template.id,
    protocolTemplateVersion: template.version,
    protocolKey: template.protocol_key,
    protocolName: template.display_name,

    techAttestationText: attestationText,
    techAttestationVersion: template.attestation_template_version || ATTESTATION_VERSION,

    products: children.products.map((p) => ({
      productId: p.product_id,
      productName: p.product_name_snapshot,
      rateBasis: p.rate_basis,
      rate: p.rate,
      rateUnit: p.rate_unit,
      applicationMethod: p.application_method,
      sortOrder: p.sort_order,
    })),
    areas: children.areas.map((a) => ({
      key: a.area_key,
      label: a.area_label,
      sortOrder: a.sort_order,
    })),
    actions: children.actions.map((a) => ({
      key: a.action_key,
      label: a.action_label,
      required: a.required,
      sortOrder: a.sort_order,
    })),

    customerInteraction,
    customerInteractionSource,

    sendSms: true,

    review: {
      requestReview: reviewEligible,
      eligible: reviewEligible,
      gbpResolved: reviewRouting.gbpResolved,
      routingReason: reviewRouting.routingReason,
    },

    recapMode: 'templated_sms_async_report',
  };

  // hashResolvedSnapshot strips volatile fields (resolvedAt) internally,
  // so the resolver-side preview hash and storeResolvedSnapshot's submit-
  // side persistence hash are byte-identical given the same deterministic
  // content. Without that symmetry the preview→submit handshake (PR #3)
  // would fire snapshot_hash_mismatch on every legitimate submit because
  // the wall-clock resolvedAt differs by 30 seconds.
  return {
    ok: true,
    snapshot,
    snapshotHash: hashResolvedSnapshot(snapshot),
  };
}

module.exports = {
  resolveStandardCompletionDefaults,
  CUSTOMER_INTERACTION_CHOICES,
  // Exported for testing and for the preview endpoint's reason→copy mapping.
  REVIEW_GBP_BY_CITY,
};
