/**
 * unitCount plumbing through the AI web-search lookup (estimator-engine
 * audit 2026-08-30 follow-up, owner GO): shapeAsPropertyRecord used to
 * hardcode unitCount: 1 on every AI record, blinding every downstream
 * multi-unit signal (detectCategory's >4 vote, the multi-unit site-quote
 * guard, the condo unit-lot flag exemptions). A parsed count now rides in
 * WITH field evidence; absent one, the historical truthy-1 seed stands and
 * carries no evidence — so trust machinery can tell a real count from the
 * seed.
 */
const { _private } = require('../services/property-lookup/ai-property-lookup');

const BASE_RAW = {
  squareFootage: 63000,
  lotSize: 90000,
  yearBuilt: 1990,
  bedrooms: null,
  bathrooms: null,
  stories: 2,
  propertyType: 'Apartment',
  constructionMaterial: 'CBS',
  source: 'https://example.com/listing',
  confidence: 'medium',
};

describe('parsePropertyJSON unitCount', () => {
  test('a valid count parses and clamps to the bounded range', () => {
    expect(_private.parsePropertyJSON(JSON.stringify({ ...BASE_RAW, unitCount: 48 })).unitCount).toBe(48);
    expect(_private.parsePropertyJSON(JSON.stringify({ ...BASE_RAW, unitCount: 1 })).unitCount).toBe(1);
  });

  test('absent, garbage, or out-of-range counts parse to null (never guessed)', () => {
    expect(_private.parsePropertyJSON(JSON.stringify(BASE_RAW)).unitCount).toBeNull();
    expect(_private.parsePropertyJSON(JSON.stringify({ ...BASE_RAW, unitCount: 'many' })).unitCount).toBeNull();
    expect(_private.parsePropertyJSON(JSON.stringify({ ...BASE_RAW, unitCount: 0 })).unitCount).toBeNull();
    expect(_private.parsePropertyJSON(JSON.stringify({ ...BASE_RAW, unitCount: 5000 })).unitCount).toBeNull();
  });
});

describe('shapeAsPropertyRecord unitCount', () => {
  const ADDRESS = '1 Example Complex Dr, Testville, FL 00000';

  test('a parsed count lands on the record WITH field evidence', () => {
    const record = _private.shapeAsPropertyRecord({ ...BASE_RAW, unitCount: 48 }, ADDRESS, 'gemini');
    expect(record.unitCount).toBe(48);
    const ev = record._fieldEvidence?.unitCount;
    expect(Array.isArray(ev)).toBe(true);
    expect(ev[0]).toMatchObject({ field: 'unitCount', value: 48 });
  });

  test('no parsed count keeps the historical truthy-1 seed and carries NO evidence', () => {
    const record = _private.shapeAsPropertyRecord({ ...BASE_RAW, unitCount: null }, ADDRESS, 'gemini');
    expect(record.unitCount).toBe(1);
    expect(record._fieldEvidence?.unitCount).toBeUndefined();
  });

  test('the truthy-1 seed never becomes evidence through a merge (codex P1)', () => {
    // Two shaped records, neither with a real count: merging must not
    // synthesize authoritative unitCount evidence from the seed —
    // countyAttestedSmallResidential would read it as an attested 1 and
    // suppress the conservative commercial verdict.
    const a = _private.shapeAsPropertyRecord({ ...BASE_RAW, unitCount: null }, ADDRESS, 'gemini');
    const b = _private.shapeAsPropertyRecord({ ...BASE_RAW, unitCount: null, source: 'https://example.org/other' }, ADDRESS, 'claude');
    const merged = _private.mergePropertyRecords([a, b], ADDRESS);
    expect(merged._fieldEvidence?.unitCount).toBeUndefined();
    // A REAL parsed count still merges with its evidence intact.
    const c = _private.shapeAsPropertyRecord({ ...BASE_RAW, unitCount: 48 }, ADDRESS, 'gemini');
    const mergedReal = _private.mergePropertyRecords([c, b], ADDRESS);
    expect(mergedReal.unitCount).toBe(48);
    // Merged records carry the OBJECT evidence shape.
    expect(mergedReal._fieldEvidence?.unitCount).toMatchObject({ value: 48 });
  });
});
