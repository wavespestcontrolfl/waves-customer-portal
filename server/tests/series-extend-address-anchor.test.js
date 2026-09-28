/**
 * customer-properties.anchorSeriesAddress — series-extension address
 * inheritance (prod 2026-09-28: a Square-imported quarterly series' parent
 * had no property_id/address stamp; extending the series fell all the way
 * through to the customer's CURRENT primary address, a different house than
 * every visit the series actually ran at). Precedence:
 *   1. copyStampedServiceAddressFields' own stamp from the parent — never
 *      touched here.
 *   2. The series' own UNANIMOUS address evidence (seriesAddressEvidence /
 *      seriesAddressStampFromEvidence) — a mixed/ambiguous series (e.g. one
 *      one-off visit moved to a different property) yields null rather than
 *      promoting the newest row (round-1 Codex P1).
 *   3. The existing sole-active-property fallback (anchorSoleProperty).
 *
 * Query semantics (status/NULL handling, the active-property JOIN, no-LIMIT
 * behavior on a large series) belong to a real database and are covered in
 * server/tests/series-address-evidence-postgres.test.js, not here. This
 * file covers two things a DB round trip can't isolate as cheaply: the pure
 * unanimity decision (seriesAddressStampFromEvidence, given already-decided
 * evidence rows) and anchorSeriesAddress's own precedence/guard/adoption
 * logic (given an already-resolved stamp).
 */
jest.mock('../models/db', () => ({}), { virtual: false });
const { anchorSeriesAddress, seriesAddressStampFromEvidence } = require('../services/customer-properties');

const COLS = {
  property_id: true,
  service_address_line1: true,
  service_address_line2: true,
  service_address_city: true,
  service_address_state: true,
  service_address_zip: true,
  lat: true,
  lng: true,
  zone: true,
  source_estimate_id: true,
};

describe('seriesAddressStampFromEvidence (pure)', () => {
  test('unanimous property evidence hydrates the stamp from the PROPERTY row, not each visit\'s own copy', () => {
    const rows = [
      // Newest first, as the caller's query orders them. Each row's OWN
      // service_address_* is stale/irrelevant on purpose — the stamp must
      // come from the joined customer_properties columns instead.
      {
        property_id: 'p-rental', service_address_line1: 'stale copy on this row',
        cp_address_line1: '20 Rental Ln', cp_address_line2: 'Unit 4', cp_city: 'Sarasota',
        cp_state: 'FL', cp_zip: '34231', cp_latitude: 27.38, cp_longitude: -82.39,
      },
      {
        property_id: 'p-rental', service_address_line1: 'even staler',
        cp_address_line1: '20 Rental Ln', cp_address_line2: 'Unit 4', cp_city: 'Sarasota',
        cp_state: 'FL', cp_zip: '34231', cp_latitude: 27.38, cp_longitude: -82.39,
      },
    ];
    expect(seriesAddressStampFromEvidence(rows)).toEqual({
      property_id: 'p-rental',
      service_address_line1: '20 Rental Ln',
      service_address_line2: 'Unit 4',
      service_address_city: 'Sarasota',
      service_address_state: 'FL',
      service_address_zip: '34231',
      lat: 27.38,
      lng: -82.39,
    });
  });

  test('unanimous address-only evidence (no property_id) stamps from the newest row', () => {
    const rows = [
      {
        property_id: null, service_address_line1: '5 Legacy St', service_address_line2: '',
        service_address_city: 'Sarasota', service_address_state: 'FL', service_address_zip: '34231',
        lat: 27.1, lng: -82.1,
      },
      {
        property_id: null, service_address_line1: '5 Legacy St', service_address_line2: '',
        service_address_city: 'Sarasota', service_address_state: 'FL', service_address_zip: '34231',
        lat: null, lng: null,
      },
    ];
    expect(seriesAddressStampFromEvidence(rows)).toEqual({
      property_id: null,
      service_address_line1: '5 Legacy St',
      service_address_line2: '',
      service_address_city: 'Sarasota',
      service_address_state: 'FL',
      service_address_zip: '34231',
      lat: 27.1,
      lng: -82.1,
    });
  });

  test('two distinct location keys (e.g. a one-off visit moved to another property) → null, never the newest row', () => {
    const rows = [
      { property_id: 'p-moved', cp_address_line1: '1 New Pl', cp_city: 'Venice', cp_state: 'FL', cp_zip: '34285' },
      { property_id: 'p-usual', cp_address_line1: '20 Rental Ln', cp_city: 'Sarasota', cp_state: 'FL', cp_zip: '34231' },
    ];
    expect(seriesAddressStampFromEvidence(rows)).toBeNull();
  });

  test('two distinct address-only keys (different street) → null', () => {
    const rows = [
      { property_id: null, service_address_line1: '1 New Pl', service_address_zip: '34285' },
      { property_id: null, service_address_line1: '20 Rental Ln', service_address_zip: '34231' },
    ];
    expect(seriesAddressStampFromEvidence(rows)).toBeNull();
  });

  test('the SAME address re-typed under a different visit (normalized street + zip match) is still one key', () => {
    const rows = [
      { property_id: null, service_address_line1: '20 rental ln.', service_address_zip: '34231-4521' },
      { property_id: null, service_address_line1: '20 Rental Ln', service_address_zip: '34231' },
    ];
    expect(seriesAddressStampFromEvidence(rows)).not.toBeNull();
  });

  test('unanimous property evidence but the property itself is missing a street/city/state/zip → null', () => {
    const rows = [
      { property_id: 'p-broken', cp_address_line1: null, cp_city: 'Sarasota', cp_state: 'FL', cp_zip: '34231' },
    ];
    expect(seriesAddressStampFromEvidence(rows)).toBeNull();
  });

  test('no evidence at all → null', () => {
    expect(seriesAddressStampFromEvidence([])).toBeNull();
    expect(seriesAddressStampFromEvidence(null)).toBeNull();
  });
});

// A minimal, non-filtering chain fake: it does NOT evaluate any WHERE/JOIN
// predicate (that belongs to the Postgres suite) — every chain method is a
// no-op passthrough, and the terminal .select() resolves with whatever rows
// this test configured. It exists only to hand anchorSeriesAddress a fixed
// evidence result so its OWN precedence/adoption logic can be pinned.
function fakeConnWithRows(rows) {
  const chain = {
    leftJoin() { return chain; },
    where() { return chain; },
    andWhere() { return chain; },
    orWhere() { return chain; },
    whereNull() { return chain; },
    whereNotNull() { return chain; },
    whereNotIn() { return chain; },
    whereRaw() { return chain; },
    orderBy() { return chain; },
    select: async () => rows,
  };
  const conn = () => chain;
  conn.isTransaction = false;
  return conn;
}

function throwingConn() {
  const conn = () => { throw new Error('anchorSeriesAddress must not query when already resolved'); };
  conn.isTransaction = false;
  return conn;
}

describe('anchorSeriesAddress', () => {
  test('precedence 1: an explicit property_id stamp is never touched, and no query runs', async () => {
    const target = { customer_id: 'cust-1', property_id: 'p-explicit' };
    await anchorSeriesAddress(target, 'parent-1', COLS, throwingConn());
    expect(target.property_id).toBe('p-explicit');
  });

  test('precedence 1: an already-stamped service address is never touched, and no query runs', async () => {
    const target = { customer_id: 'cust-1', property_id: null, service_address_line1: '9 Elsewhere Rd' };
    await anchorSeriesAddress(target, 'parent-1', COLS, throwingConn());
    expect(target.property_id).toBeNull();
    expect(target.service_address_line1).toBe('9 Elsewhere Rd');
  });

  test('estimate-linked row is left to the estimate linkage, untouched, and no query runs', async () => {
    const target = { customer_id: 'cust-1', property_id: null, source_estimate_id: 'est-1' };
    await anchorSeriesAddress(target, 'parent-1', COLS, throwingConn());
    expect(target.property_id).toBeNull();
    expect(target.service_address_line1).toBeUndefined();
  });

  test('a property-key stamp is adopted as one unit: address + coordinates replace what the addressless parent left, and zone is CLEARED (not kept)', async () => {
    const rows = [{
      property_id: 'p-rental',
      cp_address_line1: '20 Rental Ln', cp_address_line2: '', cp_city: 'Sarasota',
      cp_state: 'FL', cp_zip: '34231', cp_latitude: 27.38, cp_longitude: -82.39,
    }];
    // What copyStampedServiceAddressFields leaves on the row from an
    // addressless parent: the parent's own main-address geocode and
    // whatever routing zone it carried.
    const target = {
      customer_id: 'cust-1', property_id: null, service_address_line1: null,
      lat: 27.51, lng: -82.37, zone: 'north',
    };
    await anchorSeriesAddress(target, 'parent-1', COLS, fakeConnWithRows(rows));
    expect(target.property_id).toBe('p-rental');
    expect(target.service_address_line1).toBe('20 Rental Ln');
    expect(target.service_address_city).toBe('Sarasota');
    expect(target.lat).toBe(27.38);
    expect(target.lng).toBe(-82.39);
    expect(target.zone).toBeNull();
  });

  test('an address-only stamp is also adopted as one unit (property_id stays null) with zone cleared', async () => {
    const rows = [{
      property_id: null, service_address_line1: '5 Legacy St', service_address_line2: '',
      service_address_city: 'Sarasota', service_address_state: 'FL', service_address_zip: '34231',
      lat: 27.1, lng: -82.1,
    }];
    const target = { customer_id: 'cust-1', property_id: null, lat: 27.51, lng: -82.37, zone: 'north' };
    await anchorSeriesAddress(target, 'parent-1', COLS, fakeConnWithRows(rows));
    expect(target.property_id).toBeNull();
    expect(target.service_address_line1).toBe('5 Legacy St');
    expect(target.lat).toBe(27.1);
    expect(target.lng).toBe(-82.1);
    expect(target.zone).toBeNull();
  });

  test('no unanimous evidence (empty) falls through to the sole-property anchor, zone untouched', async () => {
    let propertyLookupRan = false;
    const evidenceChain = fakeConnWithRows([])('scheduled_services as ss');
    // Two active properties for this customer: soleActivePropertyId resolves
    // that ambiguity to null cleanly (rows.length > 1), so this test never
    // has to fake the lazy sole-property backfill path.
    const conn = (table) => {
      if (table === 'scheduled_services as ss') return evidenceChain;
      propertyLookupRan = true;
      return { where() { return this; }, limit() { return this; }, select: async () => [{ id: 'p1' }, { id: 'p2' }] };
    };
    conn.isTransaction = false;
    const target = { customer_id: 'cust-1', property_id: null, zone: 'north' };
    await anchorSeriesAddress(target, 'parent-1', COLS, conn);
    expect(target.property_id).toBeNull();
    expect(target.zone).toBe('north'); // never touched: no stamp was adopted
    expect(propertyLookupRan).toBe(true); // fell through to anchorSoleProperty
  });

  test('best-effort: a failing evidence lookup still resolves through the sole-property fallback, never throws', async () => {
    let calls = 0;
    const conn = (table) => {
      calls += 1;
      if (table === 'scheduled_services as ss') throw new Error('boom');
      return { where() { return this; }, limit() { return this; }, select: async () => [{ id: 'p-sole' }] };
    };
    conn.isTransaction = false;
    const target = { customer_id: 'cust-1', property_id: null };
    await anchorSeriesAddress(target, 'parent-1', COLS, conn);
    expect(target.property_id).toBe('p-sole');
    expect(calls).toBeGreaterThan(0);
  });
});

describe('at least one extension writer calls anchorSeriesAddress', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes/admin-schedule.js'), 'utf8');

  test('admin-schedule.js imports anchorSeriesAddress from customer-properties', () => {
    expect(src).toContain("const { anchorSoleProperty, anchorSeriesAddress } = require('../services/customer-properties');");
  });

  test('every series-extension writer (5) uses anchorSeriesAddress; the two brand-new-series spawn loops keep anchorSoleProperty', () => {
    const seriesAnchored = src.match(/copyStampedServiceAddressFields\((\w+), \w+, cols\);\n(?:[^\n]*\n)?\s*await anchorSeriesAddress\(\1, \w+(?:\.\w+)?, cols, (?:trx|conn)\);/g) || [];
    expect(seriesAnchored.length).toBe(5);
    const soleAnchored = src.match(/copyStampedServiceAddressFields\((\w+), \w+, cols\);\n\s*if \(!propertyOwnedByEstimateLinkage\) await anchorSoleProperty\(\1, cols, trx\);/g) || [];
    expect(soleAnchored.length).toBe(2);
    // reconcileRecurringSeriesVisitCount — the bug's own repro path.
    expect(src).toContain('copyStampedServiceAddressFields(data, parent, cols);\n    await anchorSeriesAddress(data, parentId, cols, trx);');
  });
});
