const { buildReportCrossSell, _private } = require('../services/service-report/cross-sell');

// Recurring rows must be UPCOMING to count as live obligations (the ownership
// loader applies the lifecycle evidence unconditionally) — compute the date so
// the suite never ages out.
const FUTURE_SCHEDULED_DATE = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);

function dbForTables(tables = {}, { failCatalogJoin = false } = {}) {
  const dbFn = (table) => {
    if (failCatalogJoin && table === 'scheduled_services as s') {
      const boom = () => { throw new Error('join failed'); };
      return { leftJoin: boom, where: boom, select: boom };
    }
    const rows = tables[table] || [];
    const q = {
      where() { return q; },
      whereNotIn() { return q; },
      orWhereNull() { return q; },
      leftJoin() { return q; },
      orderBy() { return q; },
      select() { return rows; },
      limit() { return q; },
      first(col) {
        void col;
        return rows[0] || null;
      },
      columnInfo() {
        return table === 'scheduled_services' ? { is_recurring: {} } : {};
      },
    };
    return q;
  };
  // plan-rate-ledger's loadComponents probes schema.hasTable before reading.
  dbFn.schema = { hasTable: async (name) => Object.prototype.hasOwnProperty.call(tables, name) };
  return dbFn;
}

const CUSTOMER = (overrides = {}) => ({
  id: 'cust-1',
  active: true,
  waveguard_tier: 'Bronze',
  monthly_rate: 55,
  property_sqft: 4500,
  lot_sqft: 7000,
  lawn_type: 'St. Augustine',
  address_line1: '123 Gulf Dr',
  city: 'Sarasota',
  state: 'FL',
  zip: '34236',
  ...overrides,
});

const SERVICE = (overrides = {}) => ({
  id: 'sr-1',
  customer_id: 'cust-1',
  address_line1: '123 Gulf Dr',
  city: 'Sarasota',
  zip: '34236',
  // Recent by default: the report-identity guard only corroborates within
  // one recurrence window (PR r9) — fixtures model the fresh-report case
  // unless a test overrides the date.
  service_date: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString().slice(0, 10),
  ...overrides,
});

function recurringRows(serviceTypes) {
  return serviceTypes.map((service_type, index) => ({
    id: `svc-${index + 1}`,
    service_type,
    scheduled_date: FUTURE_SCHEDULED_DATE,
    status: 'scheduled',
    is_recurring: true,
  }));
}

function dbFor({ customer = CUSTOMER(), serviceTypes = [], turfProfile = null, estimates = [], planRates = [], catalogRows = [], stampRows = [], properties = [], failCatalogJoin = false } = {}) {
  const scheduled = recurringRows(serviceTypes);
  return dbForTables({
    customers: [customer],
    customer_properties: properties,
    // stampRows go FIRST so the builder's raw-stamp first() read sees them
    // (the fake's first() returns rows[0]); completed stamp rows carry no
    // upcoming lifecycle so the ownership loader ignores them.
    scheduled_services: [...stampRows, ...scheduled],
    // Catalog join returns the same rows: service_key/service_name stay
    // undefined, so classification falls to service_type text — the plain-row
    // legacy path the classifier documents. catalogRows adds rows visible to
    // the catalog join only (e.g. the report's completed visit).
    'scheduled_services as s': [...scheduled, ...catalogRows],
    customer_turf_profiles: turfProfile ? [turfProfile] : [],
    estimates,
    customer_plan_rates: planRates,
  }, { failCatalogJoin });
}

// Cache-only lookup default: a miss (null) prices from the profile alone.
const missLookup = async () => null;

describe('offer ladder', () => {
  const { pickOfferTarget, OFFER_LADDER } = _private;

  test('one offer per report, first missing family wins, mosquito never offered', () => {
    expect(OFFER_LADDER).toEqual(['pest_control', 'lawn_care', 'tree_shrub', 'termite']);
    expect(pickOfferTarget([])).toBe('pest_control');
    expect(pickOfferTarget(['pest_control'])).toBe('lawn_care');
    expect(pickOfferTarget(['lawn_care'])).toBe('pest_control');
    expect(pickOfferTarget(['pest_control', 'lawn_care'])).toBe('tree_shrub');
    expect(pickOfferTarget(['pest_control', 'lawn_care', 'tree_shrub'])).toBe('termite');
    // Ownership vocabulary termite_bait maps onto the ladder's termite rung.
    expect(pickOfferTarget(['pest_control', 'lawn_care', 'tree_shrub', 'termite_bait'])).toBe(null);
    // Mosquito ownership occupies no rung — the ladder position is unchanged.
    expect(pickOfferTarget(['mosquito'])).toBe('pest_control');
  });
});

describe('buildReportCrossSell', () => {
  test('pest-only customer is offered lawn care, priced from the turf profile', async () => {
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('lawn_care');
    expect(result.mode).toBe('priced');
    expect(result.option.perVisit).toBeGreaterThan(0);
    expect(result.option.cadence).toMatch(/applications/);
    // Plan owner → "add to your plan" copy stance, decided server-side.
    expect(result.relationship).toBe('add');
    // The modeled current-service inventory must never ride the public
    // bearer-token payload (codex #3367 PR r2).
    expect(result.currentServices).toBeUndefined();
  });

  test('customer with no recurring ownership at all gets the start-relationship copy stance', async () => {
    // One-time-treatment customer: no upcoming recurring rows, a report
    // identity that resolves no ownership family, no plan-rate rows. There
    // is no plan to "add" to — the server marks the offer as a start.
    const db = dbFor({ serviceTypes: [] });
    const result = await buildReportCrossSell(
      SERVICE({ service_type: 'German Cockroach Cleanout' }),
      db,
      { propertyLookup: missLookup },
    );
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
    expect(result.relationship).toBe('start');
  });

  test('lawn-only customer is offered pest control; no cached footprint demotes to quote CTA', async () => {
    const db = dbFor({ serviceTypes: ['Lawn Care'] });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
    // Home square footage only comes from the lookup; a cache miss must ask,
    // never guess — the card degrades to the unpriced CTA.
    expect(result.mode).toBe('quote_cta');
    expect(result.option).toBeNull();
  });

  test('lawn-only customer with a cached lookup gets a priced pest offer', async () => {
    // A lawn customer carries a measured turf profile; without one the
    // modeled current-lawn baseline raises an estimate-level turf verify
    // flag, and any estimate-level flag demotes the offer to the CTA (the
    // card never shows a price the portal pricing panel would flag).
    const db = dbFor({
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    // Stories ride along like a real cached county/vision read would — a
    // DEFAULTED story count is itself a manual-review reason
    // (stories_estimated) and correctly demotes the offer to the CTA.
    const lookup = async () => ({ enriched: { homeSqFt: 2400, lotSqFt: 8000, stories: 1 }, propertyRecord: {} });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: lookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
    expect(result.mode).toBe('priced');
    expect(result.option.perVisit).toBeGreaterThan(0);
  });

  test('pest + lawn customer is offered tree & shrub', async () => {
    const db = dbFor({
      customer: CUSTOMER({ bed_sqft: 1200 }),
      serviceTypes: ['Pest Control', 'Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500 },
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('tree_shrub');
  });

  test('pest + lawn + tree & shrub customer is offered termite (owner ruling: not mosquito)', async () => {
    const db = dbFor({ serviceTypes: ['Pest Control', 'Lawn Care', 'Tree & Shrub Care'] });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('termite');
  });

  test('customer owning the whole ladder gets no card (referral only)', async () => {
    const db = dbFor({ serviceTypes: ['Pest Control', 'Lawn Care', 'Tree & Shrub Care', 'Termite Bait Monitoring'] });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('one-time-only customer (no recurring rows) is offered a pest plan', async () => {
    const db = dbFor({ serviceTypes: [] });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
  });

  test('FAIL CLOSED: a broken ownership catalog join suppresses the card entirely', async () => {
    const db = dbFor({ serviceTypes: ['Pest Control'], failCatalogJoin: true });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('commercial property gets no card', async () => {
    const db = dbFor({
      customer: CUSTOMER({ property_type: 'Commercial' }),
      serviceTypes: ['Pest Control'],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('commercial classification from a trusted cached lookup suppresses the card even with a blank stored type', async () => {
    const db = dbFor({
      customer: CUSTOMER({ property_type: null }),
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    const lookup = async () => ({ enriched: { propertyType: 'Commercial', homeSqFt: 2400, lotSqFt: 8000, stories: 1 }, propertyRecord: {} });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: lookup });
    expect(result).toBeNull();
  });

  test('multifamily property gets no card (≥5-unit ruling rides normalizePropertyType)', async () => {
    const db = dbFor({
      customer: CUSTOMER({ property_type: 'multifamily' }),
      serviceTypes: ['Pest Control'],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('a line1-only raw stamp (no stamped city or zip) suppresses the card — locality unprovable', async () => {
    // The route COALESCEs stamped city/zip to the customer mirror, which
    // makes a line1-only stamp masquerade as the primary locality; the raw
    // stamp is the truth and an unlocalized one cannot rule out a
    // same-street property in another city.
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      stampRows: [{ id: 'stamp-1', status: 'completed', service_address_line1: '123 Gulf Dr' }],
    });
    const result = await buildReportCrossSell(SERVICE({ scheduled_service_id: 'stamp-1' }), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('a fully-localized raw stamp at the primary property keeps the card', async () => {
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      stampRows: [{
        id: 'stamp-1', status: 'completed',
        service_address_line1: '123 Gulf Dr', service_address_city: 'Sarasota', service_address_zip: '34236',
      }],
    });
    const result = await buildReportCrossSell(SERVICE({ scheduled_service_id: 'stamp-1' }), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('lawn_care');
  });

  test('a raw stamp on the same street in a DIFFERENT city suppresses the card', async () => {
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      stampRows: [{
        id: 'stamp-1', status: 'completed',
        service_address_line1: '123 Gulf Dr', service_address_city: 'Venice', service_address_zip: '34285',
      }],
    });
    const result = await buildReportCrossSell(SERVICE({ scheduled_service_id: 'stamp-1' }), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('disjoint locality evidence (city-only primary vs zip-only stamp) suppresses the card', async () => {
    // Neither key lacks locality, but they carry it in different fields —
    // sameScopeKey's per-field wildcard would accept the match across
    // cities; property equality needs one SHARED locality proof.
    const db = dbFor({
      customer: CUSTOMER({ zip: null }),
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      stampRows: [{
        id: 'stamp-1', status: 'completed',
        service_address_line1: '123 Gulf Dr', service_address_zip: '34236',
      }],
    });
    const result = await buildReportCrossSell(SERVICE({ scheduled_service_id: 'stamp-1' }), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('a one-time visit under a recurring catalog identity owns nothing — the ladder still offers that family', async () => {
    // estimate-accept one-time pest visit with a General Pest Control
    // catalog row: without the one-time gate the report identity claims
    // pest and the ladder would advance to lawn care.
    const db = dbFor({
      serviceTypes: [],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      catalogRows: [{ id: 'ot-1', service_key: 'general_pest_control', service_name: 'General Pest Control' }],
      stampRows: [{
        id: 'ot-1', status: 'completed', source: 'estimate-accept',
        service_address_line1: '123 Gulf Dr', service_address_city: 'Sarasota', service_address_zip: '34236',
      }],
    });
    const service = SERVICE({ service_type: 'Quarterly Pest Control', scheduled_service_id: 'ot-1' });
    const result = await buildReportCrossSell(service, db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
  });

  test('a callback report with no linked row owns nothing (persisted is_callback flag)', async () => {
    // Older service_records have nullable scheduled_service_id; the
    // persisted flag is the only lifecycle evidence — a re-service label
    // must not claim ownership and skip the ladder rung.
    const db = dbFor({
      serviceTypes: [],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    const service = SERVICE({ service_type: 'Quarterly Pest Control', is_callback: true });
    const result = await buildReportCrossSell(service, db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
  });

  test('an unstamped linked visit resolves through its creating estimate — another city suppresses', async () => {
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      stampRows: [{ id: 'v1', status: 'completed', source_estimate_id: 'est-9' }],
      estimates: [{ id: 'est-9', address: '123 Gulf Dr, Venice, FL 34285', status: 'sent' }],
    });
    const result = await buildReportCrossSell(SERVICE({ scheduled_service_id: 'v1' }), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('an owned recurring row with disjoint locality evidence suppresses the whole card', async () => {
    // Primary is city-only, the recurring row's stamp is zip-only: the row
    // may belong to another property, and both counting and dropping it
    // can be wrong — filterRowsToStreet throws for the strict scope and
    // the card fails closed.
    const db = dbFor({
      customer: CUSTOMER({ zip: null }),
      serviceTypes: [],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      stampRows: [{
        id: 'r1', service_type: 'Pest Control', scheduled_date: FUTURE_SCHEDULED_DATE,
        status: 'scheduled', is_recurring: true,
        service_address_line1: '123 Gulf Dr', service_address_zip: '34236',
      }],
    });
    expect(await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup })).toBeNull();
  });

  test('a recurring row linked only to a secondary property row never counts at the primary', async () => {
    // Unstamped lawn row whose property_id resolves to a different street:
    // dispatch's resolution order (stamp → property row → estimate →
    // primary) applies to ownership scoping too, so lawn is NOT owned at
    // the primary and the ladder still offers it — previously the row
    // defaulted to primary and the ladder advanced to tree & shrub.
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      stampRows: [{
        id: 'r2', service_type: 'Lawn Care', scheduled_date: FUTURE_SCHEDULED_DATE,
        status: 'scheduled', is_recurring: true, property_id: 'prop-9',
      }],
      properties: [{ id: 'prop-9', address_line1: '88 Palm Ave', city: 'Venice', zip: '34285' }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('lawn_care');
  });

  test('a property-linked row that cannot be resolved suppresses the strict scope entirely', async () => {
    // property_id set but no customer_properties row: the premises are
    // unprovable, and defaulting the row to the primary would count a
    // possibly-secondary plan there (pre-push P0) — the strict scope
    // throws and the card fails closed.
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      stampRows: [{
        id: 'r3', service_type: 'Lawn Care', scheduled_date: FUTURE_SCHEDULED_DATE,
        status: 'scheduled', is_recurring: true, property_id: 'prop-missing',
      }],
    });
    expect(await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup })).toBeNull();
  });

  test('an estimate-linked row that cannot be resolved suppresses the strict scope entirely', async () => {
    // source_estimate_id set but the estimate is missing/addressless: the
    // premises are unprovable, and defaulting to primary would count a
    // possibly-secondary plan there — same fail-closed rule as the
    // property_id leg.
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      stampRows: [{
        id: 'r4', service_type: 'Lawn Care', scheduled_date: FUTURE_SCHEDULED_DATE,
        status: 'scheduled', is_recurring: true, source_estimate_id: 'est-missing',
      }],
    });
    expect(await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup })).toBeNull();
  });

  test('a report stamped at a different property than the primary is suppressed', async () => {
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500 },
    });
    const service = SERVICE({ address_line1: '9 Rental Way', city: 'Venice', zip: '34285' });
    const result = await buildReportCrossSell(service, db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('the report row classifies from its catalog identity, not stale service_type text', async () => {
    // A rodent-monitoring visit completed under a stale generic
    // 'Pest Control' label: the informative catalog identity owns no
    // ladder family, so the report identity must not claim pest — the
    // ladder still offers the pest plan (stale text would have advanced
    // it to lawn care).
    const db = dbFor({
      serviceTypes: [],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      catalogRows: [{ id: 'done-1', service_key: 'rodent_monitoring', service_name: 'Rodent Monitoring' }],
    });
    const service = SERVICE({ service_type: 'Pest Control', scheduled_service_id: 'done-1' });
    const result = await buildReportCrossSell(service, db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
  });

  test('a street-only estimate address (no city/zip) never seeds — wildcard locality is ambiguous', async () => {
    // sameScopeKey treats missing locality as a wildcard, so a legacy
    // street-only key would match every same-street property; the seed is
    // refused instead of pricing an unproven premises.
    const db = dbFor({
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: [{
        id: 'est-1',
        address: '123 Gulf Dr',
        status: 'accepted',
        estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1, storiesSource: 'lookup' } }),
      }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
    expect(result.mode).toBe('quote_cta');
    expect(result.option).toBeNull();
  });

  test('a commercial catalog identity suppresses the card even under stale residential text', async () => {
    // 'Commercial Pest Control' catalog row, stale generic service_type,
    // blank stored property_type: the catalog-enriched identity must hit
    // the commercial gate — a residential price on a commercial report is
    // the ruled no-card-at-all case.
    const db = dbFor({
      customer: CUSTOMER({ property_type: null }),
      serviceTypes: [],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      catalogRows: [{ id: 'done-2', service_key: 'commercial_pest_control', service_name: 'Commercial Pest Control' }],
    });
    const service = SERVICE({ service_type: 'Pest Control', scheduled_service_id: 'done-2' });
    expect(await buildReportCrossSell(service, db, { propertyLookup: missLookup })).toBeNull();
  });

  test('a primary address without city or zip suppresses the card — anchor locality unprovable', async () => {
    // The primary key is the anchor every frame scopes to; without
    // locality it wildcard-matches every same-street property, so the
    // card fails closed exactly like raw stamps and estimate seeds.
    const db = dbFor({
      customer: CUSTOMER({ city: null, zip: null }),
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    expect(await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup })).toBeNull();
  });

  test('options carrying setup or one-time charges never price on the card', () => {
    // Per-application is the ONLY price field the public payload may carry
    // (r7 ruling): a termite-basic dueAtStart would price-lock an
    // undisclosed setup charge — such options demote to the quote CTA.
    const { optionIsPriceable } = _private;
    expect(optionIsPriceable({ perVisit: 42 })).toBe(true);
    expect(optionIsPriceable({ perVisit: 42, dueAtStart: 99 })).toBe(false);
    expect(optionIsPriceable({ perVisit: 42, oneTime: 150 })).toBe(false);
  });

  test('a HISTORICAL report identity does not advance the ladder without billing corroboration', async () => {
    // Former pest customer, plan cancelled: no upcoming rows, no ledger
    // row, and the permanent-token report is months old — pest must be
    // offered again, not skipped for a lawn offer labeled as a plan add.
    const db = dbFor({
      serviceTypes: [],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    const service = SERVICE({ service_type: 'Quarterly Pest Control', service_date: '2026-01-05' });
    const result = await buildReportCrossSell(service, db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
    expect(result.relationship).toBe('start');
  });

  test('a report identity counts when the AUTHORITATIVE ledger carries the family (gate on)', async () => {
    // Only gate-ON ledger rows are billing authority (advisory rows may
    // never advance the ladder) — with it, the unseeded-gap report keeps
    // its family and the ladder offers the next rung.
    // The feature-gate map is baked at module load, so the gate-on world
    // needs a fresh module registry.
    const prev = process.env.GATE_PLAN_RATE_LEDGER;
    process.env.GATE_PLAN_RATE_LEDGER = 'true';
    jest.resetModules();
    try {
      const { buildReportCrossSell: freshBuild } = require('../services/service-report/cross-sell');
      const db = dbFor({
        serviceTypes: [],
        turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
        planRates: [{ family_key: 'pest_control', monthly_rate: 60 }],
      });
      const service = SERVICE({ service_type: 'Quarterly Pest Control' });
      const result = await freshBuild(service, db, { propertyLookup: missLookup });
      expect(result).not.toBeNull();
      expect(result.serviceKey).toBe('lawn_care');
    } finally {
      if (prev === undefined) delete process.env.GATE_PLAN_RATE_LEDGER;
      else process.env.GATE_PLAN_RATE_LEDGER = prev;
      jest.resetModules();
    }
  });

  test('a UTC-midnight Date service_date reads as its own ET calendar day, not the day before', async () => {
    // pg DATE columns hydrate as UTC-midnight Dates; running one through
    // etDateString would shift it to the PREVIOUS Eastern day and expire
    // the 90-day ambiguity guard a day early (pre-push P1). A report dated
    // exactly 90 ET days ago must still suppress.
    const ninetyDaysAgo = new Date(Date.UTC(
      new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - 90, 0, 0, 0, 0,
    ));
    const db = dbFor({
      serviceTypes: [],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    const service = SERVICE({ service_type: 'Quarterly Pest Control', service_date: ninetyDaysAgo });
    expect(await buildReportCrossSell(service, db, { propertyLookup: missLookup })).toBeNull();
  });

  test('an old report + a stale ADVISORY ledger component never becomes a lawn request (gate off)', async () => {
    // The advisory component is not corroboration (it may be stale or
    // another property's), so the old report's pest identity drops; pest
    // becomes the ladder target, and the same advisory row then SUPPRESSES
    // the card at the target rung — no card, rather than a lawn request
    // for a customer with no current plan.
    const db = dbFor({
      serviceTypes: [],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      planRates: [{ family_key: 'pest_control', monthly_rate: 60 }],
    });
    const service = SERVICE({ service_type: 'Quarterly Pest Control', service_date: '2026-01-05' });
    expect(await buildReportCrossSell(service, db, { propertyLookup: missLookup })).toBeNull();
  });

  test('a seeded synthetic zero tree count is dropped — it never reads as an explicit count', async () => {
    // The v1 lookup adapter stores treeCount: 0 when nothing was observed;
    // replayed as explicit it would let priceTreeShrub skip its density
    // fallback and price zero trees. With the zero dropped, the seed with
    // and without the synthetic count must price identically.
    const estimateWith = (features) => [{
      id: 'est-1',
      address: '123 Gulf Dr, Sarasota, FL 34236',
      status: 'accepted',
      estimate_data: JSON.stringify({
        engineInputs: {
          homeSqFt: 2400, lotSqFt: 8000, stories: 1, storiesSource: 'lookup',
          bedArea: 3000, bedAreaSource: 'explicit', features,
        },
      }),
    }];
    const run = async (features) => buildReportCrossSell(SERVICE(), dbFor({
      serviceTypes: ['Pest Control', 'Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: estimateWith(features),
    }), { propertyLookup: missLookup });
    const withSyntheticZero = await run({ trees: 'moderate', treeCount: 0 });
    expect(withSyntheticZero).not.toBeNull();
    expect(withSyntheticZero.serviceKey).toBe('tree_shrub');
    // r10: a zero count has no provenance (operator-confirmed vs adapter
    // synthetic), so a tree & shrub offer built on it NEVER prices —
    // neither replaying zero trees nor a phantom density fallback is safe.
    expect(withSyntheticZero.mode).toBe('quote_cta');
    expect(withSyntheticZero.option).toBeNull();
  });

  test('report-family guard: a RECENT uncorroborated report identity suppresses the card entirely', async () => {
    // Recurring customer whose next visit isn't seeded — or a customer who
    // just cancelled: with no upcoming rows and no authoritative billing
    // evidence the two are indistinguishable (codex #3367 PR r10), and
    // offering pest vs advancing to lawn are each wrong in one of those
    // worlds. Both-answers-wrong → no card.
    const db = dbFor({
      serviceTypes: [],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    const service = SERVICE({ service_type: 'Quarterly Pest Control Service' });
    const result = await buildReportCrossSell(service, db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('plan-rate ledger evidence on the target rung suppresses the card — it never advances the ladder', async () => {
    // Pest via upcoming rows; lawn ONLY via a plan-rate row (next lawn visit
    // not seeded). Ledger rows are advisory-capable and never
    // property-scoped, so lawn must not be offered (may be owned) AND the
    // ladder must not advance to tree & shrub (the row may be stale or
    // billed at another property): no card at all.
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      planRates: [{ family_key: 'lawn_care', monthly_rate: 45 }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('plan-rate ledger evidence above the target rung demotes to CTA without moving the target', async () => {
    // Pest via upcoming rows, termite ONLY via a plan-rate row. The ladder
    // still offers lawn care (its rung carries no ledger evidence), but the
    // pricing baseline cannot model the termite plan, so no standalone
    // price may render.
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      planRates: [{ family_key: 'termite', monthly_rate: 80 }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('lawn_care');
    expect(result.mode).toBe('quote_cta');
  });

  test('recurring-but-tierless customer: owned rows dropped by the membership gate demote to CTA', async () => {
    // The documented transition: upcoming recurring lawn rows but no tier
    // and no monthly rate — ownership sees lawn, the membership-gated
    // pricing baseline does not, so a priced standalone pest offer would
    // miss the combined tier.
    const db = dbFor({
      customer: CUSTOMER({ waveguard_tier: 'none', monthly_rate: 0 }),
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: [{
        id: 'est-1',
        address: '123 Gulf Dr, Sarasota, FL 34236',
        status: 'accepted',
        estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1, storiesSource: 'lookup' } }),
      }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
    expect(result.mode).toBe('quote_cta');
  });

  test('an explicitly commercial report identity suppresses the card even with a blank property type', async () => {
    const db = dbFor({
      customer: CUSTOMER({ property_type: null }),
      serviceTypes: [],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
    });
    const service = SERVICE({ service_type: 'Commercial Pest Control' });
    const result = await buildReportCrossSell(service, db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('one-time report identities (cockroach cleanout) do NOT count as owned pest', async () => {
    const db = dbFor({ serviceTypes: [] });
    const service = SERVICE({ service_type: 'Cockroach Treatment' });
    const result = await buildReportCrossSell(service, db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
  });

  test('estimate seed prices a pest offer when profile and lookup carry nothing', async () => {
    // The dimensions that priced the customer's live plan fill the gaps —
    // prod audit 2026-08-11: without this, real reports never priced.
    const db = dbFor({
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: [{
        id: 'est-1',
        address: '123 Gulf Dr, Sarasota, FL 34236',
        status: 'accepted',
        estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1, storiesSource: 'lookup' } }),
      }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
    expect(result.mode).toBe('priced');
    expect(result.option.perVisit).toBeGreaterThan(0);
  });

  test('a seed with guessed stories keeps the manual-review demotion (CTA, no price)', async () => {
    const db = dbFor({
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: [{
        id: 'est-1',
        address: '123 Gulf Dr, Sarasota, FL 34236',
        status: 'accepted',
        // No storiesSource on the old estimate → seed replays 'estimated' →
        // stories_estimated manual review → the card refuses the price.
        estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1 } }),
      }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.serviceKey).toBe('pest_control');
    expect(result.mode).toBe('quote_cta');
  });

  test('non-accepted estimates never seed a price (drafts/sent/expired refused)', async () => {
    const db = dbFor({
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: [{
        id: 'est-1',
        address: '123 Gulf Dr, Sarasota, FL 34236',
        status: 'sent',
        estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1, storiesSource: 'lookup' } }),
      }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.mode).toBe('quote_cta');
  });

  test('an addressless estimate never seeds a customer with a primary street', async () => {
    const db = dbFor({
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: [{
        id: 'est-1',
        address: '',
        status: 'accepted',
        estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1, storiesSource: 'lookup' } }),
      }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.mode).toBe('quote_cta');
  });

  test('FAIL CLOSED: a customer with no primary street gets no card (property frames cannot be proven aligned)', async () => {
    const customer = CUSTOMER({ address_line1: null, city: null, zip: null });
    const db = dbFor({
      customer,
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: [{
        id: 'est-1',
        address: '123 Gulf Dr, Sarasota, FL 34236',
        status: 'accepted',
        estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1, storiesSource: 'lookup' } }),
      }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('an estimate stamped at a different street never seeds this property', async () => {
    const db = dbFor({
      serviceTypes: ['Lawn Care'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      estimates: [{
        id: 'est-1',
        address: '9 Rental Way, Venice, FL 34285',
        status: 'accepted',
        estimate_data: JSON.stringify({ engineInputs: { homeSqFt: 2400, lotSqFt: 8000, stories: 1, storiesSource: 'lookup' } }),
      }],
    });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).not.toBeNull();
    expect(result.mode).toBe('quote_cta');
  });

  test('inactive customer gets no card', async () => {
    const db = dbFor({ customer: CUSTOMER({ active: false }), serviceTypes: [] });
    const result = await buildReportCrossSell(SERVICE(), db, { propertyLookup: missLookup });
    expect(result).toBeNull();
  });

  test('missing customer_id or database returns null, never throws', async () => {
    expect(await buildReportCrossSell({}, dbFor({}))).toBeNull();
    expect(await buildReportCrossSell(SERVICE(), null)).toBeNull();
  });
});
