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

describe('parsePropertyJSON unitCount rejects ranges and fractions (codex P2)', () => {
  test('ranges never concatenate into a large count', () => {
    expect(_private.parsePropertyJSON(JSON.stringify({ ...BASE_RAW, unitCount: '4-8' })).unitCount).toBeNull();
    expect(_private.parsePropertyJSON(JSON.stringify({ ...BASE_RAW, unitCount: '1 to 8' })).unitCount).toBeNull();
    expect(_private.parsePropertyJSON(JSON.stringify({ ...BASE_RAW, unitCount: '4–8' })).unitCount).toBeNull();
  });

  test('fractional counts are unknown, not rounded', () => {
    expect(_private.parsePropertyJSON(JSON.stringify({ ...BASE_RAW, unitCount: 4.5 })).unitCount).toBeNull();
    expect(_private.parsePropertyJSON(JSON.stringify({ ...BASE_RAW, unitCount: '4.5' })).unitCount).toBeNull();
  });

  test('integer strings and a plain "units" suffix still parse; snake/camel aliases honored', () => {
    expect(_private.parsePropertyJSON(JSON.stringify({ ...BASE_RAW, unitCount: '48' })).unitCount).toBe(48);
    expect(_private.parsePropertyJSON(JSON.stringify({ ...BASE_RAW, unitCount: '48 units' })).unitCount).toBe(48);
    expect(_private.parsePropertyJSON(JSON.stringify({ ...BASE_RAW, unit_count: 12 })).unitCount).toBe(12);
    expect(_private.parsePropertyJSON(JSON.stringify({ ...BASE_RAW, numberOfUnits: '6' })).unitCount).toBe(6);
  });

  test('coerceStrictInt contract', () => {
    expect(_private.coerceStrictInt(48, 1, 2000)).toBe(48);
    expect(_private.coerceStrictInt('4-8', 1, 2000)).toBeNull();
    expect(_private.coerceStrictInt(2001, 1, 2000)).toBeNull();
    expect(_private.coerceStrictInt(true, 1, 2000)).toBeNull();
    expect(_private.coerceStrictInt(undefined, 1, 2000)).toBeNull();
  });
});

describe('hasAnyPropertyFact treats a multi-unit count as a usable fact (codex P2)', () => {
  const EMPTY = {
    squareFootage: null, lotSize: null, yearBuilt: null, bedrooms: null,
    bathrooms: null, stories: null, propertyType: null,
  };
  test('a count-only verified record is kept, not discarded', () => {
    expect(_private.hasAnyPropertyFact({ ...EMPTY, unitCount: 48 })).toBe(true);
  });
  test('a bare 1 is not a fact — indistinguishable from the seed', () => {
    expect(_private.hasAnyPropertyFact({ ...EMPTY, unitCount: 1 })).toBe(false);
    expect(_private.hasAnyPropertyFact({ ...EMPTY, unitCount: null })).toBe(false);
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

  test('a county aggregate count outranks a web listing count in the merge (codex P1)', () => {
    // The aggregate cadastral path stamps its count AFTER evidence build —
    // it carries an explicit authoritative entry so a listing's 200 cannot
    // overwrite the county's 48.
    const county = {
      ..._private.shapeAsPropertyRecord({ ...BASE_RAW, unitCount: null, source: null }, ADDRESS, 'manatee_pao'),
      _source: 'county',
      unitCount: 48,
      _fieldEvidence: {
        unitCount: [{
          field: 'unitCount', value: 48, provider: 'manatee_pao', url: null,
          sourceType: 'county', sourceQuality: 100, providerConfidence: 'high',
        }],
      },
    };
    const listing = _private.shapeAsPropertyRecord({ ...BASE_RAW, unitCount: 200 }, ADDRESS, 'gemini');
    const merged = _private.mergePropertyRecords([county, listing], ADDRESS);
    expect(merged.unitCount).toBe(48);
    expect(merged._fieldEvidence?.unitCount).toMatchObject({ value: 48, sourceType: 'county' });
  });

  test('re-merging an ALREADY-MERGED county record keeps its provenance against a listing (pre-push codex P1 r3)', () => {
    // Merged records carry OBJECT-shaped evidence; fieldEvidenceFromRecord
    // used to read `[0]` on it and fall back to _aiSourceType, so a
    // second merge let a listing's 200 outrank the county's 48.
    const county = {
      ..._private.shapeAsPropertyRecord({ ...BASE_RAW, unitCount: null, source: null }, ADDRESS, 'manatee_pao'),
      _source: 'county',
      unitCount: 48,
      _fieldEvidence: {
        unitCount: [{
          field: 'unitCount', value: 48, provider: 'manatee_pao', url: null,
          sourceType: 'county', sourceQuality: 100, providerConfidence: 'high',
        }],
      },
    };
    const firstPass = _private.mergePropertyRecords([county], ADDRESS);
    expect(Array.isArray(firstPass._fieldEvidence?.unitCount)).toBe(false);
    const listing = _private.shapeAsPropertyRecord({ ...BASE_RAW, unitCount: 200 }, ADDRESS, 'gemini');
    const remerged = _private.mergePropertyRecords([firstPass, listing], ADDRESS);
    expect(remerged.unitCount).toBe(48);
    expect(remerged._fieldEvidence?.unitCount).toMatchObject({ value: 48, sourceType: 'county' });
  });
});
