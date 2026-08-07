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
    // INLINE trailing form too ("100 Beach Rd Apt 4" — codex #3244 r8): the
    // same property is commonly stored as line1 "100 Beach Rd" + line2
    // "Apt 4", so leaving the unit inline breaks every canonical-order
    // compare. Split only when a real street remains in front of it.
    const inline = shaped.address_line1.match(/^(.+?\S)\s+((?:unit|apt|apartment|suite|ste|#)\s*[\w-]+)$/i);
    if (inline && inline[1].trim().split(/\s+/).length >= 2) {
      shaped.address_line1 = inline[1].trim();
      shaped.address_line2 = inline[2].trim();
    } else {
      shaped.address_line2 = null;
    }
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
          // Restamping the address invalidates any coords the row inherited
          // at booking (dispatch prefers s.lat unconditionally — codex #3244
          // r7); null them so dispatch geocodes the stamped address.
          lat: null,
          lng: null,
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
        const unit = normalizeStreet(parts.address_line2);
        const rows = await database('customer_properties').where({ customer_id: customerId, active: true });
        // Unit-aware: when both sides carry a unit they must agree — a
        // street-only match could link Unit 4's accept to Unit 5's property
        // (codex #3244 r7).
        const matched = rows.find((p) => normalizeStreet(p.address_line1) === street
          && (!unit || !normalizeStreet(p.address_line2) || normalizeStreet(p.address_line2) === unit));
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
                // Restamping the address invalidates any coords the row inherited
                // at booking (dispatch prefers s.lat unconditionally — codex #3244
                // r7); null them so dispatch geocodes the stamped address.
                lat: null,
                lng: null,
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
          // The property row's own coords replace anything the visit
          // inherited at booking; null when unknown so dispatch geocodes
          // the stamped address instead of trusting stale primary coords
          // (codex #3244 r7).
          lat: property.latitude != null ? property.latitude : null,
          lng: property.longitude != null ? property.longitude : null,
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
// Both helpers delegate to customer-properties' canonical machinery
// (codex #3248 r1): stripUnitDesignators keeps the unit ID in PLACE (inline
// "100 Main St Apt 4" and split "100 Main St"+"Apt 4" produce one order),
// and canonicalizeAddress expands street suffixes ("St" == "Street") without
// stripping them — the exact drift codex caught between these keys and
// addressKey. Unit identity stays part of the key ("Unit 4" != "Unit 5").
function normalizedStampedStreet(line1, line2, city, zip) {
  const { canonicalizeAddress, stripUnitDesignators, normalizeZip } = require('./customer-properties');
  // Final fold matches addressKey exactly ([^a-z0-9] stripped — codex
  // #3248 r3): "100 O'Connor St" and "100 OConnor St" key identically.
  const street = canonicalizeAddress(stripUnitDesignators([line1, line2]
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .join(' ')))
    .replace(/[^a-z0-9]/g, '');
  if (!street) return '';
  // Locality-QUALIFIED key (codex #3248 r2): the duplicate guard admits the
  // same street+unit in different cities as distinct properties, so every
  // scope compare must carry locality too or accept-time consumers would
  // still merge them. City is punctuation-insensitive ("St. Petersburg" ==
  // "St Petersburg"); segments are empty when unknown and sameScopeKey
  // treats empty as wildcard.
  const cityKey = String(city || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `${street}|${cityKey}|${normalizeZip(zip)}`;
}

// True when a scope key carries a street but neither city nor zip — a
// partially stamped legacy row whose wildcard locality would otherwise
// match EVERY same-street property (codex #3248 r6); consumers use this to
// try the row's source estimate for a fully qualified key first.
function scopeKeyLacksLocality(key) {
  const [street, city, zip] = String(key || '').split('|');
  return !!street && !city && !zip;
}

// Strict on street, wildcard on locality segments either side lacks.
function sameScopeKey(a, b) {
  if (!a || !b) return false;
  const [as, ac, az] = String(a).split('|');
  const [bs, bc, bz] = String(b).split('|');
  if (!as || !bs || as !== bs) return false;
  if (ac && bc && ac !== bc) return false;
  if (az && bz && az !== bz) return false;
  return true;
}

function normalizedEstimateStreet(raw) {
  const parts = parseEstimateAddress(raw);
  return normalizedStampedStreet(parts?.address_line1, parts?.address_line2, parts?.city, parts?.zip);
}

// Full property tuple for DUPLICATE checks (codex #3248 r1): identical
// street+unit in different cities/ZIPs are DISTINCT properties (mirrors
// addressKey). City/zip only discriminate when BOTH sides carry them.
function normalizedEstimatePropertyKey(raw) {
  const parts = parseEstimateAddress(raw);
  if (!parts) return null;
  const { normalizeZip } = require('./customer-properties');
  return {
    street: normalizedStampedStreet(parts.address_line1, parts.address_line2),
    city: String(parts.city || '').toLowerCase().replace(/[^a-z0-9]+/g, ''),
    zip: normalizeZip(parts.zip),
  };
}

function samePropertyKey(a, b) {
  if (!a || !b || !a.street || !b.street) return false;
  if (a.street !== b.street) return false;
  if (a.city && b.city && a.city !== b.city) return false;
  if (a.zip && b.zip && a.zip !== b.zip) return false;
  return true;
}

// Does this estimate quote the CUSTOMER's on-file address? Full canonical
// tuple compare (street+unit, and city/zip when both sides have them) — a
// street-prefix test let "100 Main St, Sarasota" reuse the Bradenton
// primary's coordinates and capacity zone (codex #3244 r8). Uncertain parses
// return false (treat as a different property — the safe direction for
// routing/zone decisions).
function estimateQuotesCustomerAddress(estimateAddressRaw, customerRow = {}) {
  const parts = parseEstimateAddress(estimateAddressRaw);
  if (!parts) return true; // no quoted address at all — nothing contradicts the customer record
  // A unitless estimate ("100 Main St", common on legacy/partial rows) still
  // quotes the customer's own property when the primary is "100 Main St" +
  // "Apt 4" (codex #3248 r3): the unit discriminates only when the ESTIMATE
  // side carries one. streetKey strips trailing units + suffix-canonicalizes
  // + alnum-folds, mirroring customer-properties.
  const { streetKey } = require('./customer-properties');
  const estimateHasUnit = !!String(parts.address_line2 || '').trim();
  const estimateKey = estimateHasUnit
    ? normalizedStampedStreet(parts.address_line1, parts.address_line2)
    : streetKey(parts.address_line1);
  const customerKey = estimateHasUnit
    ? normalizedStampedStreet(customerRow.address_line1, customerRow.address_line2)
    : streetKey(customerRow.address_line1);
  if (!estimateKey || !customerKey || estimateKey !== customerKey) return false;
  // Punctuation-folded like the property tuple key (codex #3248 r5):
  // "St. Petersburg" == "St Petersburg".
  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (parts.city && customerRow.city && norm(parts.city) !== norm(customerRow.city)) return false;
  const { normalizeZip } = require('./customer-properties');
  const estimateZip = normalizeZip(parts.zip);
  const customerZip = normalizeZip(customerRow.zip);
  if (estimateZip && customerZip && estimateZip !== customerZip) return false;
  return true;
}

module.exports = {
  parseEstimateAddress,
  normalizedEstimateStreet,
  normalizedStampedStreet,
  sameScopeKey,
  scopeKeyLacksLocality,
  normalizedEstimatePropertyKey,
  samePropertyKey,
  estimateQuotesCustomerAddress,
  refreshHasMultiHome,
  linkAcceptedEstimateProperty,
};
