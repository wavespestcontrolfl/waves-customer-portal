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
  const shaped = m
    ? {
      address_line1: m[1].trim(),
      city: m[2].trim(),
      state: m[3].toUpperCase(),
      zip: m[4],
      partial: false,
    }
    : { address_line1: line, city: '', state: 'FL', zip: '', partial: true };
  // Canonicalize a LEADING unit segment into address_line2 ("Unit 4, 100
  // Beach Rd" → line1 "100 Beach Rd", line2 "Unit 4"): existing
  // customer_properties rows store the unit in line 2, and addressKey
  // preserves token order — leaving the unit in line 1 makes the same
  // property produce two different keys and mints a false second property
  // (codex #3244 r6). Trailing "#4"-style suffixes already live in line 1 on
  // both sides, so only the comma-separated leading form needs the split.
  const unit = shaped.address_line1.match(/^((?:unit|apt|apartment|suite|ste|#)\s*[\w-]+)\s*,\s*(.+)$/i);
  if (unit) {
    shaped.address_line2 = unit[1].trim();
    shaped.address_line1 = unit[2].trim();
  } else {
    shaped.address_line2 = null;
  }
  return shaped;
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
    if (!estimateId || !customerId) return null;
    if (!customerPropertiesGateOn()) {
      // Gate OFF: no customer_properties writes — but a GROUPED accept still
      // stamps its booked visits' service address. service_address_* are
      // plain scheduled_services columns (not part of the gated relational
      // model), and dispatch resolves unstamped rows to the customer's
      // PRIMARY address — a technician would be routed to the wrong property
      // (codex #3244 r3). property_id / customer_properties / has_multi_home
      // stay dark until the gate flips.
      const grouped = await database('estimates')
        .where({ id: estimateId })
        .first('estimate_group_id', 'address');
      if (!grouped?.estimate_group_id) return null;
      const gparts = parseEstimateAddress(grouped.address);
      if (!gparts || !String(gparts.address_line1 || '').trim()) return null;
      await database('scheduled_services')
        .where({ source_estimate_id: estimateId })
        .whereNull('property_id')
        .whereNull('service_address_line1')
        .whereNotIn('status', ['completed', 'cancelled', 'canceled', 'skipped', 'no_show'])
        .update({
          service_address_line1: gparts.address_line1,
          service_address_line2: gparts.address_line2 || null,
          service_address_city: gparts.city || null,
          service_address_state: gparts.state || 'FL',
          service_address_zip: gparts.zip || null,
        });
      logger.info(`[estimate-property-linkage] estimate ${estimateId}: grouped visit addresses stamped (gate off — no property row)`);
      return null;
    }
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
          // No property row to link — but a GROUPED accept's visits must
          // still carry the quoted address or dispatch COALESCEs to the
          // customer's primary property (codex #3244 r4). Stamp what the
          // partial parse did yield (street is non-negotiable, city/zip
          // best-effort); the property insert stays skipped.
          if (estimate.estimate_group_id) {
            await database('scheduled_services')
              .where({ source_estimate_id: estimateId })
              .whereNull('property_id')
              .whereNull('service_address_line1')
              .whereNotIn('status', ['completed', 'cancelled', 'canceled', 'skipped', 'no_show'])
              .update({
                service_address_line1: parts.address_line1,
                service_address_line2: parts.address_line2 || null,
                service_address_city: parts.city || null,
                service_address_state: parts.state || 'FL',
                service_address_zip: parts.zip || null,
              });
          }
          logger.info(`[estimate-property-linkage] estimate ${estimateId}: partial address didn't match an existing property — linkage skipped${estimate.estimate_group_id ? ' (grouped visit addresses stamped)' : ''}`);
          return null;
        }
        propertyId = matched.id;
      }
    }
    if (!propertyId && parts) {
      const created = await recordCallProperty({
        customerId,
        address_line1: parts.address_line1,
        address_line2: parts.address_line2 || null,
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
        const key = addressKey({ address_line1: parts.address_line1, address_line2: parts.address_line2 || null, city: parts.city, zip: parts.zip });
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

// Canonical street extraction + normalization for property-scope compares
// (series guard, rate classifier, tier scoping, duplicate-address checks).
// parseEstimateAddress keeps the WHOLE street portion — "Unit 4, 100 Beach
// Rd" survives intact where a naive split(',')[0] would keep only "Unit 4"
// (codex #3244 r5). Returns '' when no street can be extracted.
function normalizedEstimateStreet(raw) {
  const parts = parseEstimateAddress(raw);
  return String(parts?.address_line1 || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  parseEstimateAddress,
  normalizedEstimateStreet,
  refreshHasMultiHome,
  linkAcceptedEstimateProperty,
};
