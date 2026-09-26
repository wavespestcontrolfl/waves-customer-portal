/**
 * estimates.category persistence (owner ruling 2026-09-25,
 * server/services/commercial-suite-size/ follow-on, then a primary review
 * of b1150dec5c): the manual admin-tool save path never wrote
 * estimates.category, so every commercial estimate saved through
 * EstimateToolViewV2 kept the migration column default RESIDENTIAL — which
 * let a commercial row pass the AGENTS.md P0 "Estimate service-mix rail
 * member exclusion" guard's `category !== 'RESIDENTIAL'` check by accident.
 *
 * buildEstimatePersistenceFields emits `category: 'COMMERCIAL'` ONLY when
 * the saved payload is positively detected commercial — it never emits an
 * explicit 'RESIDENTIAL'. This is deliberate on BOTH create and update: an
 * omitted key falls to the column's migration default on create (byte-
 * identical to never writing it), and leaves an UPDATE's SET clause
 * untouched on revise — so a revise's partial payload (which legitimately
 * carries no commercial markers of its own) can never downgrade a row a
 * prior create, engine draft, or commercial proposal already stamped
 * COMMERCIAL.
 */

const { buildEstimatePersistenceFields } = require('../services/admin-estimate-persistence');

const baseBody = {
  address: '123 Palm Ave',
  customerName: 'Van Lee',
  customerPhone: '(941) 555-0101',
  customerEmail: 'van@example.com',
  leadId: 'lead-1',
  customerId: null,
  monthlyTotal: 125,
  annualTotal: 1500,
  onetimeTotal: 0,
  waveguardTier: null,
  notes: '',
  satelliteUrl: null,
  showOneTimeOption: false,
  billByInvoice: false,
};

describe('buildEstimatePersistenceFields — category', () => {
  test('a residential payload omits category (column default RESIDENTIAL applies on create; an update leaves the column untouched)', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      estimateData: { inputs: { address: '123 Palm Ave' }, result: { total: 125 } },
    });
    expect(fields.category).toBeUndefined();
    expect('category' in fields).toBe(false);
  });

  test('a commercial payload (isCommercial flag) persists category COMMERCIAL', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      estimateData: { inputs: { isCommercial: true, address: '4400 Test Commons Pkwy E #102' }, result: { total: 103 } },
    });
    expect(fields.category).toBe('COMMERCIAL');
  });

  test('a commercial payload identified only by a commercial_ service line still persists COMMERCIAL', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      estimateData: {
        result: { recurring: { services: [{ service: 'commercial_pest', name: 'Commercial Pest Control', mo: 103 }] } },
      },
    });
    expect(fields.category).toBe('COMMERCIAL');
  });

  test('a commercial payload identified by commercialSubtype persists COMMERCIAL', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      estimateData: { inputs: { commercialSubtype: 'restaurant' } },
    });
    expect(fields.category).toBe('COMMERCIAL');
  });

  test('no estimateData at all omits category, never throws', () => {
    const fields = buildEstimatePersistenceFields({ ...baseBody, estimateData: null });
    expect(fields.category).toBeUndefined();
    expect('category' in fields).toBe(false);
  });

  test('a commercial termite-only payload from the V2 form (string isCommercial "YES", no commercial_* line) persists COMMERCIAL', () => {
    // EstimateToolViewV2 stores its commercial toggle as the STRING "YES"/
    // "NO" (never a boolean), and a termite-only estimate has no
    // commercial_pest/commercial_* line item to key off of at all — this is
    // exactly the shape that slipped through as RESIDENTIAL before the fix.
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      estimateData: {
        inputs: { isCommercial: 'YES', address: '4400 Test Commons Pkwy E #102' },
        result: { recurring: { services: [{ service: 'termite_bait', name: 'Termite Baiting', mo: 45 }] } },
      },
    });
    expect(fields.category).toBe('COMMERCIAL');
  });

  test('a payload whose propertyType is the string "Commercial" (no isCommercial flag, no commercial_* line) persists COMMERCIAL', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      estimateData: {
        inputs: { propertyType: 'Commercial', address: '4400 Test Commons Pkwy E #102' },
        result: { recurring: { services: [{ service: 'termite_bait', name: 'Termite Baiting', mo: 45 }] } },
      },
    });
    expect(fields.category).toBe('COMMERCIAL');
  });

  test('a revise whose incremental payload carries no commercial markers omits category — the row keeps whatever it already had (never downgraded)', () => {
    // Simulates reviseAdminEstimate: the operator edited an unrelated field
    // (e.g. a discount) on an already-commercial estimate, and the payload
    // sent for THIS save happens to carry no commercial signal of its own
    // (a partial/legacy shape). The fix must never write RESIDENTIAL here —
    // only the update's OTHER fields change; category is left alone.
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      estimateData: { inputs: { address: '4400 Test Commons Pkwy E #102' }, result: { total: 103 } },
    });
    expect(fields.category).toBeUndefined();
    expect('category' in fields).toBe(false);
  });

  // Primary review of PR #4840 r7 P2: a FULL revision after correcting a
  // false-positive commercial-suite lookup to residential must actually
  // clear the stale COMMERCIAL column — the "never downgrade" rule exists
  // to protect a genuinely partial payload, not to permanently freeze a
  // row's category the moment it's ever stamped COMMERCIAL.
  test('a FULL revision explicitly marked residential (V2 form isCommercial "NO") downgrades a stale COMMERCIAL row to RESIDENTIAL', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      estimateData: {
        inputs: { isCommercial: 'NO', propertyType: 'Single Family', address: '123 Palm Ave' },
        result: { recurring: { services: [{ service: 'pest', name: 'Pest Control', mo: 45 }] } },
      },
    });
    expect(fields.category).toBe('RESIDENTIAL');
  });

  test('a genuinely partial payload with no isCommercial marker at all still omits category (never downgrades) — control', () => {
    // Same shape as the "incremental payload" test above, restated to make
    // the contrast with the explicit-marker case above explicit: no
    // inputs.isCommercial key at all (not even "NO") never writes RESIDENTIAL.
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      estimateData: { inputs: { address: '123 Palm Ave' }, result: { total: 45 } },
    });
    expect(fields.category).toBeUndefined();
    expect('category' in fields).toBe(false);
  });
});

describe('shared detector stays strict; YES is read for the category only', () => {
  test('isCommercialEstimateData still ignores the string "YES" (other readers depend on it)', () => {
    const { isCommercialEstimateData } = require('../services/estimate-delivery-options');
    expect(isCommercialEstimateData({ inputs: { isCommercial: 'YES' } })).toBe(false);
  });
});

describe('explicit V2 selection decides over stale derived signals', () => {
  test('a correction to residential with a stale commercialSubtype still writes RESIDENTIAL', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      estimateData: { inputs: { isCommercial: 'NO', commercialSubtype: 'office_retail' }, result: { total: 125 } },
    });
    expect(fields.category).toBe('RESIDENTIAL');
  });

  // Codex #4840 r9 P1: the two controls are independent, and the pricing
  // predicate prices Property Type = Commercial as commercial even with the
  // toggle left at "NO" — the saved category must agree.
  test('Property Type Commercial with the toggle left at "NO" saves COMMERCIAL', () => {
    const fields = buildEstimatePersistenceFields({
      ...baseBody,
      estimateData: { inputs: { isCommercial: 'NO', propertyType: 'Commercial' }, result: { total: 125 } },
    });
    expect(fields.category).toBe('COMMERCIAL');
  });
});
