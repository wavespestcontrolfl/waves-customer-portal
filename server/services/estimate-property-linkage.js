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
// A trailing free-text segment counts as a CITY only when it looks like one
// (codex #3431 r13 P1): the admin estimate address stays a free-form input,
// and "100 Main St, yellow house" must not mint city="yellow house" — the
// locality mismatch against the real primary would refuse adoption, re-add
// the rate, and seed a duplicate series. Structured producers join real DB
// city values — short Title-Cased names ("Venice", "North Port",
// "St. Petersburg") — so the bar is 1–3 Title-Cased words. A failing
// segment is treated as an address NOTE: the parse keeps the street half
// alone (street-only key → the conservative borrow/fail-closed paths). A
// Title-Cased note can still slip through, but a wrong-city segment only
// reproduces the locality-mismatch behavior the unparsed fallback had.
function looksLikeCityName(v) {
  return /^(?:[A-Z][A-Za-z.'-]*)(?:\s+[A-Z][A-Za-z.'-]*){0,2}$/.test(String(v || '').trim());
}

function parseEstimateAddress(raw) {
  const line = String(raw || '').replace(/,?\s*(USA|United States)\s*$/i, '').trim();
  if (!line) return null;
  const m = line.match(/^(.*),\s*([^,]+),\s*([A-Za-z]{2})\.?\s*(\d{5})(?:-\d{4})?$/)
    // One-comma shape "street, City ST 34208" (codex #3431 r1 P1): city,
    // state, and zip share the single trailing segment. Without this, the
    // whole value collapses into a partial street token that embeds the
    // locality — so scope keys built from it can never equal a structured
    // stamped/primary key for the SAME property, and property-scoped
    // consumers (adoption, the duplicate-series guard) mis-refuse or
    // mis-admit. Lazy city capture keeps multi-word cities intact ("North
    // Port FL 34287").
    || line.match(/^(.*),\s*([^,]+?)\s+([A-Za-z]{2})\.?\s*(\d{5})(?:-\d{4})?$/)
    // Fully comma-delimited "street[, unit], City, ST, 34285" shape (codex
    // #3431 r7 P1): customer-pricing-ai's addressForCustomer join puts the
    // state and zip in separate comma segments (and may interpose the unit
    // line). The greedy street capture keeps a composite "street, Apt 4"
    // intact for the trailing-unit split below.
    || line.match(/^(.*),\s*([^,]+),\s*([A-Za-z]{2})\.?,\s*(\d{5})(?:-\d{4})?$/)
    // Three-segment "street, City, 34285" engine shape (codex #3431 r5 P1):
    // intent-composer joins [address_line1, city, zip] with NO state, so
    // neither stateful regex above matches and the whole value would fall
    // through as a partial street with the locality folded in — the exact
    // key poisoning the shapes above exist to prevent. City and zip are
    // both present, so this parses as a FULL address; the empty state
    // capture defaults to FL below.
    || line.match(/^(.*),\s*([A-Za-z][^,]*?),\s*()(\d{5})(?:-\d{4})?$/);
  let shaped;
  if (m) {
    shaped = {
      address_line1: m[1].trim(),
      city: m[2].trim(),
      state: (m[3] || 'FL').toUpperCase(),
      zip: m[4],
      partial: false,
    };
    // Filtered producer combinations (codex #3431 r9 P1): the pricing-ai
    // join filters missing fields, so an omitted CITY shifts the next
    // segment into the city capture — "100 Main St, FL, 34285" reads
    // "FL" as the city, and "100 Main St, Apt 4, FL, 34285" reads the
    // unit line as it. A bare 2-letter city on the state-less match IS
    // the state; a unit-designator city is the unit line (re-joined into
    // line1 for the trailing-unit split below). Both leave the parse
    // CITY-LESS, so it degrades to partial:true — reconcile-only, never
    // a property-row mint whose key couldn't match the real primary.
    if (!m[3] && /^[A-Za-z]{2}$/.test(shaped.city)) {
      shaped.state = shaped.city.toUpperCase();
      shaped.city = '';
      shaped.partial = true;
    } else if (/^(?:unit|apt|apartment|suite|ste|#)\.?\s*[\w-]+$/i.test(shaped.city)) {
      shaped.address_line1 = `${shaped.address_line1}, ${shaped.city}`;
      shaped.city = '';
      shaped.partial = true;
    }
  } else {
    // Two-segment "street, City" producer shape (codex #3431 r4 P1):
    // booking-predraft writes `${service_address_line1}, ${city}` with no
    // state/zip. Without this branch the whole value collapses into one
    // partial street token with the city folded in — a key that can never
    // equal a structured stamped/primary key for the SAME property, so the
    // widened property-scope consumers mis-classify the customer's own
    // plan/series. Guards: the street half must carry a digit and must not
    // be a bare unit designator (that's the "Unit 4, 100 Beach Rd"
    // leading-unit form, split below), and the city half is alphabetic —
    // any digit there means the trailing segment is a street, not a city.
    // An optional trailing 2-letter state token folds into `state`. Stays
    // partial:true — with no zip, property INSERTS must still refuse to
    // mint rows from it; scope keys simply gain the city locality segment.
    // No-ZIP comma-delimited "street[, unit], City, ST" (codex #3431 r10
    // P1): a customer record without a zip filter-joins to exactly this.
    // Greedy street capture keeps a composite "street, Apt 4" intact for
    // the trailing-unit split below; city half is alphabetic; trailing
    // segment must be a bare 2-letter state. Stays partial:true (no zip —
    // reconcile-only, no property inserts).
    // Middle segment: an alphabetic city OR a unit designator (the
    // state-only "street, Apt 4, FL" filtered shape — codex #3431 r11).
    const cityState = line.match(/^(.*),\s*((?:unit|apt|apartment|suite|ste|#)\.?\s*[\w-]+|[A-Za-z][A-Za-z .'-]*?),\s*([A-Za-z]{2})\.?$/i);
    const twoSeg = !cityState && line.match(/^([^,]*\d[^,]*),\s*([A-Za-z][A-Za-z .'-]*?)(?:\s+([A-Za-z]{2})\.?)?$/);
    // "street, 34285" composer fallback (codex #3431 r6 P1): the intent
    // composer filter-joins [line1, city, zip], so a legacy profile with a
    // null city yields street + ZIP. The zip becomes the key's locality
    // segment; stays partial:true like the street-city shape (no property
    // inserts from a city-less parse).
    const zipSeg = !twoSeg && line.match(/^([^,]*\d[^,]*),\s*(\d{5})(?:-\d{4})?$/);
    // Unit-and-city-only "street, Apt 4, Venice" (codex #3431 r12 P1):
    // a customer with line2 + city but neither state nor zip filter-joins
    // to exactly this. Middle segment must be a unit designator; the city
    // half is alphabetic. Unit re-joins into line1 for the trailing-unit
    // split; stays partial:true.
    const unitCity = !cityState && !twoSeg && !zipSeg
      && line.match(/^([^,]*\d[^,]*),\s*((?:unit|apt|apartment|suite|ste|#)\.?\s*[\w-]+),\s*([A-Za-z][A-Za-z .'-]*)$/i);
    if (cityState) {
      shaped = {
        address_line1: cityState[1].trim(),
        city: cityState[2].trim(),
        state: cityState[3].toUpperCase(),
        zip: '',
        partial: true,
      };
      // State-only filtered shape "street, Apt 4, FL" (codex #3431 r11
      // P1): a customer with neither city nor zip filter-joins to street
      // + unit + state — the "city" capture is really the unit line.
      // Re-join it into line1 for the trailing-unit split below.
      if (/^(?:unit|apt|apartment|suite|ste|#)\.?\s*[\w-]+$/i.test(shaped.city)) {
        shaped.address_line1 = `${shaped.address_line1}, ${shaped.city}`;
        shaped.city = '';
      } else if (!looksLikeCityName(shaped.city)) {
        // Free-text note, not a city (codex #3431 r13) — keep the street
        // half alone.
        shaped.city = '';
      }
    } else if (twoSeg && !/^(?:unit|apt|apartment|suite|ste|#)\.?\s*[\w-]+$/i.test(twoSeg[1].trim())) {
      shaped = {
        address_line1: twoSeg[1].trim(),
        city: twoSeg[2].trim(),
        state: (twoSeg[3] || 'FL').toUpperCase(),
        zip: '',
        partial: true,
      };
      // State-only filtered shape "street, FL" (codex #3431 r11 P1): a
      // bare 2-letter "city" here is really the state — leaving it as a
      // city would stamp malformed service_address_city onto fresh
      // visits and break every locality compare against the primary.
      if (/^[A-Za-z]{2}$/.test(shaped.city)) {
        shaped.state = shaped.city.toUpperCase();
        shaped.city = '';
      } else if (!looksLikeCityName(shaped.city)) {
        // Free-text note, not a city (codex #3431 r13) — keep the street
        // half alone (street-only key, conservative paths).
        shaped.city = '';
      }
    } else if (zipSeg && !/^(?:unit|apt|apartment|suite|ste|#)\.?\s*[\w-]+$/i.test(zipSeg[1].trim())) {
      shaped = {
        address_line1: zipSeg[1].trim(),
        city: '',
        state: 'FL',
        zip: zipSeg[2],
        partial: true,
      };
    } else if (unitCity) {
      shaped = {
        address_line1: `${unitCity[1].trim()}, ${unitCity[2].trim()}`,
        // Free-text note in the city slot keeps the street+unit alone
        // (codex #3431 r13).
        city: looksLikeCityName(unitCity[3]) ? unitCity[3].trim() : '',
        state: 'FL',
        zip: '',
        partial: true,
      };
    } else {
      shaped = { address_line1: line, city: '', state: 'FL', zip: '', partial: true };
    }
  }
  // Canonicalize a LEADING unit segment into address_line2 ("Unit 4, 100
  // Beach Rd" → line1 "100 Beach Rd", line2 "Unit 4"): existing
  // customer_properties rows store the unit in line 2, and addressKey
  // preserves token order — leaving the unit in line 1 makes the same
  // property produce two different keys and mints a false second property
  // (codex #3244 r6). Trailing "#4"-style suffixes already live in line 1 on
  // both sides, so only the comma-separated leading form needs the split.
  const unit = shaped.address_line1.match(/^((?:unit|apt|apartment|suite|ste|#)\.?\s*[\w-]+)\s*,\s*(.+)$/i);
  // TRAILING comma-separated unit segment too ("100 Main St, Apt 4" — the
  // r7 four-segment producer interposes the unit line after the street).
  const trailingUnit = !unit && shaped.address_line1.match(/^(.+?),\s*((?:unit|apt|apartment|suite|ste|#)\.?\s*[\w-]+)$/i);
  if (unit) {
    shaped.address_line2 = unit[1].trim();
    shaped.address_line1 = unit[2].trim();
  } else if (trailingUnit) {
    shaped.address_line1 = trailingUnit[1].trim();
    shaped.address_line2 = trailingUnit[2].trim();
  } else {
    // INLINE trailing form too ("100 Beach Rd Apt 4" — codex #3244 r8): the
    // same property is commonly stored as line1 "100 Beach Rd" + line2
    // "Apt 4", so leaving the unit inline breaks every canonical-order
    // compare. Split only when a real street remains in front of it.
    const inline = shaped.address_line1.match(/^(.+?\S)\s+((?:unit|apt|apartment|suite|ste|#)\.?\s*[\w-]+)$/i);
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
async function linkAcceptedEstimateProperty({ estimateId, customerId, database = db, onlyServiceIds = null }) {
  try {
    if (!estimateId || !customerId) return null;
    // Optional id scope (codex #3504 r10 hook P0): quote-wizard drafts are
    // REVIVED and reused for later quotes, so `source_estimate_id` alone
    // can also match an OLDER activation's still-unstamped rows (a
    // primary-address series deliberately stays unstamped) — an unscoped
    // stamp from a later quote would retarget that older series to the new
    // address. Callers that know exactly which rows this linkage is FOR
    // (the wizard activation passes its parent + just-seeded children)
    // pin every visit update to those ids; accept-path callers, whose
    // estimates are never reused, pass nothing and keep today's behavior.
    const scopeToActivation = (qb) => {
      if (Array.isArray(onlyServiceIds) && onlyServiceIds.length) qb.whereIn('id', onlyServiceIds);
    };
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
        .first('estimate_group_id', 'address', 'property_id');
      const gparts = parseEstimateAddress(grouped?.address);
      const gKeys = makeEstimateScopeKeys(grouped?.address);
      // property_id-linked fallback (codex #3431 r11 P1): an estimate with
      // a blank/rejected address but a linked property still books fresh
      // visits under the widened pid-aware scopes — unstamped, dispatch
      // would route them to the customer's PRIMARY. Reading the linked
      // customer_properties row is not a relational WRITE (those stay
      // dark); stamp its address unless the linked property IS the
      // primary (same shared-locality rule as the address path below).
      if ((!gparts || !String(gparts.address_line1 || '').trim() || !gKeys) && grouped?.property_id) {
        const prop = await database('customer_properties').where({ id: grouped.property_id }).first();
        if (!prop || String(prop.customer_id) !== String(customerId) || prop.active === false
          || !String(prop.address_line1 || '').trim()) return null;
        try {
          const cust = await database('customers').where({ id: customerId }).first('address_line1', 'address_line2', 'city', 'zip');
          const propKey = normalizedStampedStreet(prop.address_line1, prop.address_line2, prop.city, prop.zip);
          const primKey = normalizedStampedStreet(cust?.address_line1, cust?.address_line2, cust?.city, cust?.zip);
          if (propKey && primKey && sameScopeKey(propKey, primKey)
            && scopeKeysShareLocality(propKey, primKey)) return null;
        } catch { /* unknown primary → stamp anyway: the id says non-primary */ }
        // Both the unstamped rows AND rows already carrying this
        // property_id with no address (an ID-matched ADOPTED visit —
        // codex #3431 r13): either shape would dispatch to the primary.
        await database('scheduled_services')
          .where({ source_estimate_id: estimateId }).modify(scopeToActivation)
          .whereNull('service_address_line1')
          .where((builder) => {
            builder.whereNull('property_id').orWhere('property_id', grouped.property_id);
          })
          .whereNotIn('status', ['completed', 'cancelled', 'canceled', 'skipped', 'no_show'])
          .update({
            service_address_line1: prop.address_line1,
            service_address_line2: prop.address_line2 || null,
            service_address_city: prop.city || null,
            service_address_state: prop.state || 'FL',
            service_address_zip: prop.zip || null,
            lat: prop.latitude != null ? prop.latitude : null,
            lng: prop.longitude != null ? prop.longitude : null,
          });
        logger.info(`[estimate-property-linkage] estimate ${estimateId}: visit addresses stamped from linked property ${grouped.property_id} (gate off, no usable estimate address)`);
        return null;
      }
      if (!gparts || !String(gparts.address_line1 || '').trim()) return null;
      if (!grouped?.estimate_group_id) {
        // UNGROUPED accepts stamp too when the quoted address is a
        // DIFFERENT property than the customer's primary (codex #3431 r1
        // P1): the widened duplicate-series scope now seeds fresh visits
        // for an ungrouped new-property accept, and with the gate off the
        // relational path below never runs — unstamped rows would dispatch
        // to the primary address, the exact wrong-property routing this
        // lane fixes. Same-street ungrouped accepts (the single-property
        // common case) keep the legacy no-stamp shape: stamping them adds
        // nothing and the lat/lng reset would churn re-geocodes. Unknown
        // primary → conservative legacy no-stamp. Unit-aware compare (codex
        // #3431 r2): a unitless estimate at the customer's unit-bearing
        // primary is the SAME property, not a stamp-worthy second one.
        const keys = makeEstimateScopeKeys(grouped?.address);
        const estKey = keys ? keys.estimateKey : '';
        let primaryKey = '';
        try {
          const cust = await database('customers').where({ id: customerId }).first('address_line1', 'address_line2', 'city', 'zip');
          primaryKey = keys ? keys.primaryKey(cust?.address_line1, cust?.address_line2, cust?.city, cust?.zip) : '';
        } catch { /* fall through to the no-stamp default */ }
        if (!estKey || !primaryKey) return null;
        // Shared-locality-aware primary match (codex #3431 r7 P1): a
        // locality-bearing estimate (city or zip present) matches the
        // primary only on SHARED evidence — a street+city estimate against
        // a street+zip primary is NOT proven to be the primary, and the
        // adoption predicate refuses such a candidate, so the fresh row
        // MUST be stamped or dispatch falls back to the primary address.
        // Truly street-only estimates keep the wildcard match (legacy
        // no-stamp). sameScopeKey(estKey, primaryKey) still gates the
        // street itself.
        const estimateMatchesPrimary = sameScopeKey(estKey, primaryKey)
          && (scopeKeyLacksLocality(estKey) || scopeKeysShareLocality(estKey, primaryKey));
        if (estimateMatchesPrimary) return null;
      }
      await database('scheduled_services')
        .where({ source_estimate_id: estimateId }).modify(scopeToActivation)
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
    // On the caller's connection (codex #3504 r11): the wizard activation
    // runs this inside a transaction that already holds the customers row.
    await ensurePrimaryProperty(customerId, { conn: database });

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
        // City-aware when the partial parse carries one (codex #3431 r5
        // P1 — the "street, City" producer shape): the same numbered
        // street in two cities must not reconcile to the wrong property
        // row. Wildcard when either side lacks a city, matching every
        // other locality compare in this module.
        const normCity = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        const parsedCity = normCity(parts.city);
        // ZIP-aware too (codex #3431 r7 P1 — the "street, ZIP" form has no
        // city): same both-sides-present wildcard semantics as the city.
        const { normalizeZip } = require('./customer-properties');
        const parsedZip = normalizeZip(parts.zip);
        // An EXPLICIT estimate unit requires the property row to carry and
        // match it (codex #3431 r12 P1) — a unit-less same-street row is
        // NOT a wildcard match: linking it would stamp the accepted Apt 4
        // visits with the building's unitless address and dispatch them
        // wrong. (Locality fields keep both-sides-present wildcards; the
        // unit is the estimate's own explicit statement.)
        const candidates = rows.filter((p) => normalizeStreet(p.address_line1) === street
          && (!unit || normalizeStreet(p.address_line2) === unit)
          && (!parsedCity || !normCity(p.city) || normCity(p.city) === parsedCity)
          && (!parsedZip || !normalizeZip(p.zip) || normalizeZip(p.zip) === parsedZip));
        // Exact-locality-first (codex #3431 r8 P1): the wildcard clauses
        // above admit rows that merely LACK the estimate's locality field,
        // and the query is unordered — "100 Main St, Venice" must not link
        // to an incomplete same-street row when the exact Venice row also
        // exists. A row POSITIVELY matching a supplied city or zip wins;
        // with no positive winner, a SINGLE surviving candidate is
        // unambiguous, while multiple wildcard survivors are ambiguous —
        // skip linkage rather than stamp the first row's property onto the
        // accepted visits.
        const exact = (parsedCity || parsedZip)
          ? candidates.filter((p) => (parsedCity && normCity(p.city) === parsedCity)
            || (parsedZip && normalizeZip(p.zip) === parsedZip))
          : [];
        // A UNIQUE exact match is required (codex #3431 r9 P1): a
        // city-only estimate can put several same-street rows in `exact`
        // (same city, different ZIPs) and picking the first would bypass
        // the ambiguity protection below. Plural exact matches are as
        // ambiguous as plural wildcard survivors — skip linkage.
        const matched = exact.length === 1 ? exact[0]
          : (exact.length === 0 && candidates.length === 1 ? candidates[0] : null);
        if (!matched) {
          // No property row to link — but a GROUPED accept's visits must
          // still carry the quoted address or dispatch COALESCEs to the
          // customer's primary property (codex #3244 r4). Stamp what the
          // partial parse did yield (street is non-negotiable, city/zip
          // best-effort); the property insert stays skipped.
          //
          // UNGROUPED accepts stamp here too when the quoted street differs
          // from the customer's primary (codex #3431 r2 P1): the widened
          // duplicate-series scope refuses the primary property's series and
          // seeds a FRESH visit for an ungrouped new-property accept, and
          // with no matched property row the relational stamp below never
          // runs — an unstamped row would dispatch to the primary address,
          // the exact wrong-property routing this lane fixes. Same-street
          // partials (the single-property common case) and an unknown
          // primary keep the legacy no-stamp shape, mirroring the gate-off
          // branch above. Unit-aware compare: the estimate's unit
          // discriminates only when it supplies one.
          let stampUngrouped = false;
          if (!estimate.estimate_group_id) {
            try {
              const keys = makeEstimateScopeKeys(estimate.address);
              const cust = await database('customers').where({ id: customerId }).first('address_line1', 'address_line2', 'city', 'zip');
              const primaryKey = keys ? keys.primaryKey(cust?.address_line1, cust?.address_line2, cust?.city, cust?.zip) : '';
              // Same shared-locality-aware primary match as the gate-off
              // branch (codex #3431 r7): disjoint locality evidence is
              // NOT a primary match — stamp the fresh row.
              stampUngrouped = !!(keys?.estimateKey && primaryKey
                && !(sameScopeKey(keys.estimateKey, primaryKey)
                  && (scopeKeyLacksLocality(keys.estimateKey) || scopeKeysShareLocality(keys.estimateKey, primaryKey))));
            } catch { /* keep the legacy no-stamp default */ }
          }
          if (estimate.estimate_group_id || stampUngrouped) {
            await database('scheduled_services')
              .where({ source_estimate_id: estimateId }).modify(scopeToActivation)
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
          logger.info(`[estimate-property-linkage] estimate ${estimateId}: partial address didn't match an existing property — linkage skipped${(estimate.estimate_group_id || stampUngrouped) ? ' (visit addresses stamped)' : ''}`);
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
        conn: database,
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
        .where({ source_estimate_id: estimateId }).modify(scopeToActivation)
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
      // ID-MATCHED but address-less rows too (codex #3431 r13 P1): the
      // pid-first adoption predicate can adopt a row that already carries
      // this property_id with NO service address — the whereNull above
      // skips it, and dispatch would fall back to the customer's PRIMARY
      // address. Fill the missing address from the property row; rows
      // stamped with an address (any property) stay untouched.
      await database('scheduled_services')
        .where({ source_estimate_id: estimateId, property_id: propertyId })
        .whereNull('service_address_line1')
        .whereNotIn('status', ['completed', 'cancelled', 'canceled', 'skipped', 'no_show'])
        .update({
          service_address_line1: property.address_line1,
          service_address_line2: property.address_line2 || null,
          service_address_city: property.city || null,
          service_address_state: property.state || 'FL',
          service_address_zip: property.zip || null,
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

// At least one locality field (city or zip) present on BOTH keys and equal.
// sameScopeKey compares each locality field only when both sides carry it,
// so disjoint evidence — a city-only key against a zip-only key — matches
// across cities (codex #3367 PR r6/r7). Consumers that need property
// EQUALITY proof (not merely absence of contradiction) call this after
// sameScopeKey passes.
function scopeKeysShareLocality(a, b) {
  const [, ac, az] = String(a || '').split('|');
  const [, bc, bz] = String(b || '').split('|');
  return (!!ac && !!bc && ac === bc) || (!!az && !!bz && az === bz);
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

// A PARTIAL parse counts as property evidence only when it actually looks
// like a street address (codex #3431 r3 P1): legacy estimates carry free
// text ("the yellow house behind the marina"), and keying that whole line
// as a street would arm every property-scope consumer with a key that can
// never match the customer's real address — the series guard would then
// treat the customer's real series as another property's and acceptance
// would seed a duplicate. A leading house number is the evidence bar (the
// shape quoted addresses actually take, and what the unit-splitting above
// normalizes toward). Applied to BOTH sides of every compare: the estimate
// whose keys are being built AND raw source-estimate addresses recovered
// for candidates (codex #3431 r4 P1 — an old free-text source estimate
// must fall back to the primary, not mint a garbage key). Full parses
// matched the structured address regexes and always qualify.
function partialPartsHaveAddressEvidence(parts) {
  // Applies to FULL parses too (codex #3431 r10 P1): locality-suffixed
  // prose ("the yellow house behind the marina, Venice, FL, 34285")
  // satisfies the structured regexes, and a junk street key from it would
  // mis-scope the customer's real primary plan exactly like the partial
  // free-text case. The street itself must look like a street either way.
  //
  // Delegates to the engine's canonical house-number recognizer (codex
  // #3431 r6 P1): alphanumeric ("123A Main St"), hyphenated-range
  // ("123-125 Main St"), and slashed ("123/2 Main St") house numbers are
  // all supported street shapes a narrower digits-then-space regex
  // rejected — reverting those estimates to the no-evidence fail-open
  // path. Lazy require: unit-scope-model is an estimator-engine module.
  const { hasPrimaryStreetNumber } = require('./estimator-engine/unit-scope-model');
  return hasPrimaryStreetNumber(String(parts?.address_line1 || ''));
}

// Unit-aware scope keys for ESTIMATE-vs-candidate property compares (codex
// #3431 r2): the unit token discriminates only when the ESTIMATE side
// supplies one — the same established semantics estimateQuotesCustomerAddress
// documents below. A legacy unitless estimate ("100 Main St") still quotes
// the customer's "100 Main St" + "Apt 4" primary; keying both sides with the
// unit retained made every such compare a false mismatch, so adoption
// refused the customer's own appointment and the widened converter scopes
// classified the primary plan as another property's money. When the estimate
// DOES carry a unit, the unit-retaining keys stand ("Unit 4" != "Unit 5").
// Key shape is street|city|zip either way — sameScopeKey /
// scopeKeyLacksLocality work unchanged on both modes. Returns null when the
// estimate address doesn't parse (callers keep their no-evidence behavior).
function makeEstimateScopeKeys(estimateRaw) {
  const parts = parseEstimateAddress(estimateRaw);
  if (!parts) return null;
  if (!partialPartsHaveAddressEvidence(parts)) return null;
  const estimateHasUnit = !!String(parts.address_line2 || '').trim();
  // Unit-BLIND builder: streetKey strips the trailing unit from line1 and
  // the unit line (line2) is dropped entirely; locality segments mirror
  // normalizedStampedStreet so the key shape stays identical. Used for the
  // PRIMARY compat compare and for street-IDENTITY questions (is this the
  // same street, units aside?).
  //
  // Blind ONLY when the estimate itself is unitless (codex #3431 r10 P1):
  // an estimate that explicitly quotes Apt 5 must keep Apt 4 as a
  // DIFFERENT property everywhere — the unit-only-mismatch fallbacks and
  // the borrow/proof segment compares consume this builder, and a
  // unit-stripping blindKey there would erase an explicit unit
  // distinction (suppressing Apt 5's series as an "Apt 4 duplicate").
  // When the estimate carries a unit, blindKey degrades to the
  // unit-retaining builder and every blind compare becomes the strict one.
  const unitStrippedKey = (line1, line2, city, zip) => {
    const { streetKey, normalizeZip } = require('./customer-properties');
    const street = String(streetKey(String(line1 || '').trim()) || '').replace(/[^a-z0-9]/g, '');
    if (!street) return '';
    const cityKey = String(city || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    return `${street}|${cityKey}|${normalizeZip(zip)}`;
  };
  const blindKey = (line1, line2, city, zip) => (estimateHasUnit
    ? normalizedStampedStreet(line1, line2, city, zip)
    : unitStrippedKey(line1, line2, city, zip));
  // Candidate keys RETAIN unit identity unconditionally (codex #3431 r9
  // P1): a unitless estimate must not blanket-match every unit at a
  // multi-unit street — an independently stamped "Apt 4" candidate keeps
  // its unit token, so only the estimate's own unit (or a unit-free
  // candidate) matches. The unitless-compatibility behavior
  // (estimateQuotesCustomerAddress semantics) applies ONLY to the
  // customer's known primary via primaryKey below.
  const candidateKey = (line1, line2, city, zip) => normalizedStampedStreet(line1, line2, city, zip);
  // Primary compat: a unitless estimate still quotes the customer's
  // "100 Main St / Apt 4" primary (codex #3431 r2) — the unit
  // discriminates only when the ESTIMATE supplies one.
  const primaryKey = (line1, line2, city, zip) => (estimateHasUnit
    ? normalizedStampedStreet(line1, line2, city, zip)
    : blindKey(line1, line2, city, zip));
  const candidateKeyFromRaw = (raw) => {
    const p = parseEstimateAddress(raw);
    if (!p || !partialPartsHaveAddressEvidence(p)) return '';
    return candidateKey(p.address_line1, p.address_line2, p.city, p.zip);
  };
  const blindKeyFromRaw = (raw) => {
    const p = parseEstimateAddress(raw);
    if (!p || !partialPartsHaveAddressEvidence(p)) return '';
    return blindKey(p.address_line1, p.address_line2, p.city, p.zip);
  };
  return {
    estimateHasUnit,
    estimateKey: candidateKey(parts.address_line1, parts.address_line2, parts.city, parts.zip),
    blindEstimateKey: blindKey(parts.address_line1, parts.address_line2, parts.city, parts.zip),
    candidateKey,
    candidateKeyFromRaw,
    blindKey,
    blindKeyFromRaw,
    primaryKey,
  };
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
  makeEstimateScopeKeys,
  normalizedStampedStreet,
  sameScopeKey,
  scopeKeyLacksLocality,
  scopeKeysShareLocality,
  normalizedEstimatePropertyKey,
  samePropertyKey,
  estimateQuotesCustomerAddress,
  refreshHasMultiHome,
  linkAcceptedEstimateProperty,
};
