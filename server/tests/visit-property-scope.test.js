// server/services/service-report/visit-property-scope.js — the shared
// stamp → property_id → source_estimate_id resolver (codex round-4 P1: a
// FOURTH consecutive parallel reimplementation of this exact chain missed
// the source_estimate_id leg). Unit-level coverage of the resolver itself,
// plus a source-level pin proving both callers this fix targeted
// (cross-sell.js and report-data.js) actually import it rather than
// re-deriving their own copy again.
const fs = require('fs');
const { resolveVisitPropertyScope, sameResolvedProperty, customerHasOnlyPrimaryPremises } = require('../services/service-report/visit-property-scope');

function fakeDb(tables = {}) {
  return (table) => {
    const rows = tables[table] || [];
    return {
      where(criteria) {
        const filtered = rows.filter((row) => Object.entries(criteria).every(([k, v]) => row[k] === v));
        return {
          first: (...cols) => Promise.resolve(filtered[0]
            ? (cols.length ? Object.fromEntries(cols.map((c) => [c, filtered[0][c]])) : filtered[0])
            : null),
          // customerHasOnlyPrimaryPremises reads customer_properties/
          // scheduled_services with select()/distinct() rather than first()
          // — both just materialize the whole filtered set here.
          select: (...cols) => Promise.resolve(filtered.map((row) => (cols.length
            ? Object.fromEntries(cols.map((c) => [c, row[c]]))
            : row))),
          distinct: (cols) => Promise.resolve(filtered.map((row) => (cols?.length
            ? Object.fromEntries(cols.map((c) => [c, row[c]]))
            : row))),
        };
      },
      // Mirrors the live scheduled_services schema so the proof's own
      // column-presence checks (stamp/property_id/source_estimate_id) don't
      // silently skip a leg in tests.
      columnInfo: () => Promise.resolve(table === 'scheduled_services'
        ? {
          service_address_line1: {}, service_address_line2: {},
          service_address_city: {}, service_address_zip: {},
          property_id: {}, source_estimate_id: {},
        }
        : {}),
    };
  };
}

const PROP_A = { id: 'prop-a', address_line1: '100 Sample Trail', address_line2: null, city: 'Bradenton', zip: '34211' };

describe('resolveVisitPropertyScope', () => {
  test('stamp present → resolves from the stamp, ignoring property_id/source_estimate_id entirely', async () => {
    const db = fakeDb({
      customer_properties: [{ id: 'prop-a', address_line1: 'WRONG', city: 'WRONG', zip: '00000' }],
    });
    const scope = await resolveVisitPropertyScope({
      service_address_line1: '100 Sample Trail', service_address_city: 'Bradenton', service_address_zip: '34211',
      property_id: 'prop-a',
    }, db);
    expect(scope).toEqual({ key: '100sampletrail|bradenton|34211', hasEvidence: true });
  });

  test('stamp present but lacks locality (no city, no zip) → fail closed', async () => {
    const scope = await resolveVisitPropertyScope({ service_address_line1: '100 Sample Trail' }, fakeDb());
    expect(scope).toEqual({ key: null, hasEvidence: true });
  });

  test('no stamp, property_id resolves → resolves from customer_properties', async () => {
    const db = fakeDb({ customer_properties: [PROP_A] });
    const scope = await resolveVisitPropertyScope({ property_id: 'prop-a' }, db);
    expect(scope).toEqual({ key: '100sampletrail|bradenton|34211', hasEvidence: true });
  });

  test('no stamp, property_id present but the property row is gone → fail closed', async () => {
    const scope = await resolveVisitPropertyScope({ property_id: 'prop-gone' }, fakeDb({ customer_properties: [] }));
    expect(scope).toEqual({ key: null, hasEvidence: true });
  });

  // The exact gap codex round-4 caught: customer-properties.js deliberately
  // leaves an estimate-backed row unanchored (no property_id), so the
  // source_estimate_id leg is the ONLY way to resolve it.
  test('no stamp, no property_id, source_estimate_id resolves → resolves from estimates.address', async () => {
    const db = fakeDb({ estimates: [{ id: 'est-1', address: '20 Duplicate Way, Nokomis, FL 34275' }] });
    const scope = await resolveVisitPropertyScope({ source_estimate_id: 'est-1' }, db);
    expect(scope).toEqual({ key: '20duplicateway|nokomis|34275', hasEvidence: true });
  });

  test('source_estimate_id present but the estimate row is gone → fail closed', async () => {
    const scope = await resolveVisitPropertyScope({ source_estimate_id: 'est-gone' }, fakeDb({ estimates: [] }));
    expect(scope).toEqual({ key: null, hasEvidence: true });
  });

  test('nothing at all (no stamp, property_id, or source_estimate_id) → no evidence, caller decides its own fallback', async () => {
    const scope = await resolveVisitPropertyScope({}, fakeDb());
    expect(scope).toEqual({ key: null, hasEvidence: false });
  });

  test('priority order: stamp beats property_id beats source_estimate_id', async () => {
    const db = fakeDb({
      customer_properties: [{ id: 'prop-x', address_line1: 'Property Address', city: 'City', zip: '11111' }],
      estimates: [{ id: 'est-x', address: 'Estimate Address, City, FL 22222' }],
    });
    const scope = await resolveVisitPropertyScope({
      service_address_line1: 'Stamp Address', service_address_city: 'City', service_address_zip: '33333',
      property_id: 'prop-x', source_estimate_id: 'est-x',
    }, db);
    expect(scope.key).toBe('stampaddress|city|33333');
  });

  test('a cache hit skips the query — a pre-populated propertyById/estimateById Map is read, not re-queried', async () => {
    const db = fakeDb(); // no tables at all — a real query here would resolve nothing
    const propertyById = new Map([['prop-cached', PROP_A]]);
    const scope = await resolveVisitPropertyScope({ property_id: 'prop-cached' }, db, { propertyById });
    expect(scope).toEqual({ key: '100sampletrail|bradenton|34211', hasEvidence: true });
  });

  test('a cached null (batched read found nothing for this id) fails closed without a fallback query', async () => {
    const db = fakeDb({ customer_properties: [PROP_A] }); // would resolve if actually queried
    const propertyById = new Map([['prop-a', null]]);
    const scope = await resolveVisitPropertyScope({ property_id: 'prop-a' }, db, { propertyById });
    expect(scope).toEqual({ key: null, hasEvidence: true });
  });
});

describe('sameResolvedProperty', () => {
  test('equal keys with shared locality match', () => {
    expect(sameResolvedProperty('100sampletrail|bradenton|34211', '100sampletrail|bradenton|34211')).toBe(true);
  });
  test('different streets never match', () => {
    expect(sameResolvedProperty('100sampletrail|bradenton|34211', '20duplicateway|nokomis|34275')).toBe(false);
  });
  test('same street, disjoint locality fields (city-only vs zip-only) that never share a field → no match', () => {
    expect(sameResolvedProperty('100sampletrail|bradenton|', '100sampletrail||34211')).toBe(false);
  });
  test('either side null/empty never matches', () => {
    expect(sameResolvedProperty(null, '100sampletrail|bradenton|34211')).toBe(false);
    expect(sameResolvedProperty('100sampletrail|bradenton|34211', null)).toBe(false);
  });
});

// customerHasOnlyPrimaryPremises: the single-premises proof (codex #3367 PR
// r11 P1; moved here round-5 so cross-sell.js and the upcoming-visits card
// share one implementation). round-6 P1 added the `unresolvedFails` option
// covered here — cross-sell.js's own tests already pin the function's
// DEFAULT (lenient) behavior end-to-end, so this file's job is the option
// itself: both modes, isolated from either caller.
describe('customerHasOnlyPrimaryPremises', () => {
  const PRIMARY_STREET = '100sampletrail|bradenton|34211';
  const PRIMARY_PROPERTY = { ...PROP_A, customer_id: 'customer-1' };

  describe('default mode (unresolvedFails omitted) — an unresolvable witness is not evidence of a second premises', () => {
    test('an unstamped witness row whose property_id resolves to nothing → continues; the proof still passes', async () => {
      const db = fakeDb({
        customer_properties: [PRIMARY_PROPERTY],
        scheduled_services: [
          { customer_id: 'customer-1', property_id: 'prop-ghost' },
        ],
      });
      expect(await customerHasOnlyPrimaryPremises(db, 'customer-1', {}, PRIMARY_STREET)).toBe(true);
    });

    test('an unstamped witness row whose source_estimate_id resolves to nothing → continues; the proof still passes', async () => {
      const db = fakeDb({
        customer_properties: [PRIMARY_PROPERTY],
        scheduled_services: [
          { customer_id: 'customer-1', source_estimate_id: 'est-ghost' },
        ],
        estimates: [],
      });
      expect(await customerHasOnlyPrimaryPremises(db, 'customer-1', {}, PRIMARY_STREET)).toBe(true);
    });

    test('a witness row whose source_estimate_id resolves but the estimate carries no address → continues; the proof still passes', async () => {
      const db = fakeDb({
        customer_properties: [PRIMARY_PROPERTY],
        scheduled_services: [
          { customer_id: 'customer-1', source_estimate_id: 'est-blank' },
        ],
        estimates: [{ id: 'est-blank', address: null }],
      });
      expect(await customerHasOnlyPrimaryPremises(db, 'customer-1', {}, PRIMARY_STREET)).toBe(true);
    });
  });

  describe('strict mode ({ unresolvedFails: true }) — an unresolvable witness fails the proof outright', () => {
    test('an unstamped witness row whose property_id resolves to nothing → the proof returns false', async () => {
      const db = fakeDb({
        customer_properties: [PRIMARY_PROPERTY],
        scheduled_services: [
          { customer_id: 'customer-1', property_id: 'prop-ghost' },
        ],
      });
      expect(await customerHasOnlyPrimaryPremises(db, 'customer-1', {}, PRIMARY_STREET, { unresolvedFails: true })).toBe(false);
    });

    test('an unstamped witness row whose source_estimate_id resolves to nothing → the proof returns false', async () => {
      const db = fakeDb({
        customer_properties: [PRIMARY_PROPERTY],
        scheduled_services: [
          { customer_id: 'customer-1', source_estimate_id: 'est-ghost' },
        ],
        estimates: [],
      });
      expect(await customerHasOnlyPrimaryPremises(db, 'customer-1', {}, PRIMARY_STREET, { unresolvedFails: true })).toBe(false);
    });

    test('a witness row whose source_estimate_id resolves but the estimate carries no address → the proof returns false (addressless, not just missing)', async () => {
      const db = fakeDb({
        customer_properties: [PRIMARY_PROPERTY],
        scheduled_services: [
          { customer_id: 'customer-1', source_estimate_id: 'est-blank' },
        ],
        estimates: [{ id: 'est-blank', address: null }],
      });
      expect(await customerHasOnlyPrimaryPremises(db, 'customer-1', {}, PRIMARY_STREET, { unresolvedFails: true })).toBe(false);
    });

    test('every witness resolves cleanly to the primary → the proof still passes (strict mode only fails on a genuinely unresolvable witness)', async () => {
      const db = fakeDb({
        customer_properties: [PRIMARY_PROPERTY],
        scheduled_services: [
          { customer_id: 'customer-1', property_id: 'prop-a' },
        ],
      });
      expect(await customerHasOnlyPrimaryPremises(db, 'customer-1', {}, PRIMARY_STREET, { unresolvedFails: true })).toBe(true);
    });
  });
});

// Source-level pin: both files this fix targeted must call the shared
// resolver instead of re-deriving their own stamp/property_id/estimate
// chain — that per-caller re-derivation is exactly what missed the
// source_estimate_id leg four rounds running.
describe('both callers import the shared resolver (codex round-4 structural fix)', () => {
  test('cross-sell.js requires visit-property-scope', () => {
    const src = fs.readFileSync(require.resolve('../services/service-report/cross-sell.js'), 'utf8');
    expect(src).toMatch(/require\(['"]\.\/visit-property-scope['"]\)/);
    expect(src).toContain('resolveVisitPropertyScope');
  });

  test('report-data.js requires visit-property-scope', () => {
    const src = fs.readFileSync(require.resolve('../services/service-report/report-data.js'), 'utf8');
    expect(src).toMatch(/require\(['"]\.\/visit-property-scope['"]\)/);
    expect(src).toContain('resolveVisitPropertyScope');
    expect(src).toContain('sameResolvedProperty');
  });
});
