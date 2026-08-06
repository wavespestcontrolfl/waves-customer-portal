/**
 * estimate property linkage — Phase 2 (estimates) of the multi-property model
 * (docs/multi-property-model.md), accept-time half.
 *
 * When an estimate is accepted, resolve WHICH customer_properties row the
 * quoted address is (creating a non-primary row for a new second address —
 * the relational replacement for the frozen "Additional property" sibling-
 * customer pattern), link estimates.property_id, stamp the visits the
 * acceptance booked (scheduled_services.property_id + service_address_*),
 * and refresh customers.has_multi_home — the eligibility flag the catalog
 * Multi-Home Discount (discount_key 'multi_home', 10%) requires.
 *
 * Behind GATE_CUSTOMER_PROPERTIES (default off), same as every other
 * customer_properties writer. Best-effort by contract: the acceptance and its
 * money movement have already committed — a linkage failure logs and returns
 * null, never throws into the accept response path.
 */

const db = require('../models/db');
const logger = require('./logger');
const {
  addressKey,
  ensurePrimaryProperty,
  recordCallProperty,
} = require('./customer-properties');

const customerPropertiesGateOn = () => process.env.GATE_CUSTOMER_PROPERTIES === 'true';

/**
 * Parse the single free-text estimates.address snapshot — typically a Google
 * Places formatted address ("123 Main St, Bradenton, FL 34205, USA") — into
 * structured parts. Returns null for blank input. When the "street, city, ST
 * zip" shape doesn't match, returns the whole line as address_line1 with
 * partial:true so callers can decide whether a lossy fallback is acceptable.
 */
function parseEstimateAddress(raw) {
  const line = String(raw || '').replace(/,?\s*(USA|United States)\s*$/i, '').trim();
  if (!line) return null;
  const m = line.match(/^(.*),\s*([^,]+),\s*([A-Za-z]{2})\.?\s*(\d{5})(?:-\d{4})?$/);
  if (!m) {
    return { address_line1: line, city: '', state: 'FL', zip: '', partial: true };
  }
  return {
    address_line1: m[1].trim(),
    city: m[2].trim(),
    state: m[3].toUpperCase(),
    zip: m[4],
    partial: false,
  };
}

/**
 * Refresh customers.has_multi_home from the live property count (≥2 active
 * customer_properties rows). Fill-forward only when the count says true —
 * an admin who hand-set the flag for a customer whose second property isn't
 * in the table yet must not be un-flagged by an accept.
 */
async function refreshHasMultiHome(customerId, database = db) {
  if (!customerId) return false;
  const [{ count } = {}] = await database('customer_properties')
    .where({ customer_id: customerId, active: true })
    .count('id as count');
  const multi = Number(count) >= 2;
  if (multi) {
    await database('customers')
      .where({ id: customerId })
      .update({ has_multi_home: true, updated_at: new Date() });
  }
  return multi;
}

/**
 * Post-accept linkage: resolve/create the customer_properties row for the
 * accepted estimate's address, link estimates.property_id, stamp the booked
 * visits, refresh has_multi_home. Runs POST-COMMIT on the global pool.
 * Returns { propertyId, hasMultiHome } or null. Never throws.
 */
async function linkAcceptedEstimateProperty({ estimateId, customerId, database = db }) {
  try {
    if (!customerPropertiesGateOn() || !estimateId || !customerId) return null;
    const estimate = await database('estimates').where({ id: estimateId }).first();
    if (!estimate) return null;

    // Lazy primary backfill (same contract as the call pipeline): the
    // customer's on-file address takes the primary slot before the quoted
    // address is classified, so a second property never lands as primary.
    await ensurePrimaryProperty(customerId);

    let propertyId = null;
    if (estimate.property_id) {
      const linked = await database('customer_properties').where({ id: estimate.property_id }).first();
      if (linked && String(linked.customer_id) === String(customerId) && linked.active !== false) {
        propertyId = linked.id;
      }
    }

    let parts = null;
    if (!propertyId) {
      parts = parseEstimateAddress(estimate.address);
      if (!parts || !String(parts.address_line1 || '').trim()) return null;
      // A partial parse (street-only / legacy snapshot) carries no city/zip,
      // so addressKey can never match the customer's backfilled structured
      // primary — inserting it would mint a FALSE second property and
      // permanently flip has_multi_home + discount eligibility (codex #3244
      // r1). Reconcile partials by normalized street against the existing
      // rows; no confident match → skip linkage rather than invent one.
      if (parts.partial) {
        const normalizeStreet = (v) => String(v || '')
          .toLowerCase()
          .replace(/[^a-z0-9 ]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const street = normalizeStreet(parts.address_line1);
        if (!street) return null;
        const rows = await database('customer_properties').where({ customer_id: customerId, active: true });
        const matched = rows.find((p) => normalizeStreet(p.address_line1) === street);
        if (!matched) {
          logger.info(`[estimate-property-linkage] estimate ${estimateId}: partial address didn't match an existing property — linkage skipped`);
          return null;
        }
        propertyId = matched.id;
      }
    }
    if (!propertyId && parts) {
      const created = await recordCallProperty({
        customerId,
        address_line1: parts.address_line1,
        address_line2: null,
        city: parts.city || null,
        state: parts.state || 'FL',
        zip: parts.zip || null,
        occupancyType: 'unknown',
        label: null,
        source: 'estimate_accept',
      });
      propertyId = created.propertyId;
      if (!propertyId) {
        // Address already on file — resolve the existing row by the same
        // normalized key recordCallProperty deduped against.
        const key = addressKey({ address_line1: parts.address_line1, address_line2: null, city: parts.city, zip: parts.zip });
        const rows = await database('customer_properties').where({ customer_id: customerId, active: true });
        const matched = rows.find((p) => addressKey(p) === key);
        propertyId = matched ? matched.id : null;
      }
    }
    if (!propertyId) return null;

    if (!estimate.property_id || estimate.property_id !== propertyId) {
      await database('estimates').where({ id: estimateId }).update({ property_id: propertyId });
    }

    // Stamp the visits this acceptance booked (converter inserts + slot
    // commits carry source_estimate_id). Only unstamped, non-terminal rows —
    // a stamp already present was agreed at booking time and wins.
    const property = await database('customer_properties').where({ id: propertyId }).first();
    if (property) {
      await database('scheduled_services')
        .where({ source_estimate_id: estimateId })
        .whereNull('property_id')
        .whereNotIn('status', ['completed', 'cancelled', 'canceled', 'skipped', 'no_show'])
        .update({
          property_id: propertyId,
          service_address_line1: property.address_line1,
          service_address_line2: property.address_line2 || null,
          service_address_city: property.city || null,
          service_address_state: property.state || 'FL',
          service_address_zip: property.zip || null,
        });
    }

    const hasMultiHome = await refreshHasMultiHome(customerId, database);
    logger.info(`[estimate-property-linkage] estimate ${estimateId} linked to property ${propertyId} (customer ${customerId}${hasMultiHome ? ', multi-home' : ''})`);
    return { propertyId, hasMultiHome };
  } catch (e) {
    logger.warn(`[estimate-property-linkage] link skipped for estimate ${estimateId}: ${e.message}`);
    return null;
  }
}

module.exports = {
  parseEstimateAddress,
  refreshHasMultiHome,
  linkAcceptedEstimateProperty,
};
