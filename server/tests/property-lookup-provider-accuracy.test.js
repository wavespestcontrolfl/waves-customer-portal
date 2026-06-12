/**
 * Per-provider accuracy scoring vs tech-verified facts.
 *
 * Pins: claims scored against verified overrides per provider and field,
 * the tech/verified entry never scores itself, numeric tolerance bands
 * (sqft 10%, lot 15%, exact for counts/years), unscoreable values skipped,
 * string jsonb tolerated, zero-row behavior.
 */

let mockDbHandler = () => { throw new Error('db handler not configured'); };
jest.mock('../models/db', () => {
  const mock = jest.fn((...args) => mockDbHandler(...args));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  return mock;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { providerAccuracy, _private } = require('../services/property-lookup/provider-accuracy');

function lookupsTable(rows) {
  const builder = {
    whereNotNull: () => builder,
    select: async () => rows,
  };
  return () => builder;
}

const evidence = (provider, value, extra = {}) => ({
  provider,
  value,
  sourceType: provider.endsWith('_pao') ? 'county' : 'ai_search',
  ...extra,
});

function row({ overrides, fieldEvidence }) {
  return {
    verified_overrides: overrides,
    property_record: { _fieldEvidence: fieldEvidence },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('valuesMatch', () => {
  const { valuesMatch } = _private;
  test('squareFootage within 10% is correct; beyond is not', () => {
    expect(valuesMatch('squareFootage', 1900, 2000)).toBe(true);
    expect(valuesMatch('squareFootage', 1700, 2000)).toBe(false);
  });
  test('count/year fields are exact', () => {
    expect(valuesMatch('stories', 2, 2)).toBe(true);
    expect(valuesMatch('stories', 1, 2)).toBe(false);
    expect(valuesMatch('yearBuilt', '2005', 2005)).toBe(true);
  });
  test('strings compare case-insensitively; enums mismatch fails', () => {
    expect(valuesMatch('constructionMaterial', 'cbs', 'CBS')).toBe(true);
    expect(valuesMatch('constructionMaterial', 'WOOD_FRAME', 'CBS')).toBe(false);
  });
  test('unscoreable: missing sides and non-numeric noise return null', () => {
    expect(valuesMatch('squareFootage', null, 2000)).toBeNull();
    expect(valuesMatch('squareFootage', 'unknown', 2000)).toBeNull();
    expect(valuesMatch('constructionMaterial', '', 'CBS')).toBeNull();
  });
});

describe('providerAccuracy', () => {
  test('scores each provider per field; tech entry never scores itself', async () => {
    mockDbHandler = lookupsTable([
      row({
        overrides: { squareFootage: { value: 2000, verifiedBy: 'adam', verifiedAt: 'x' } },
        fieldEvidence: {
          squareFootage: {
            evidence: [
              evidence('tech', 2000, { sourceType: 'verified' }),
              evidence('manatee_pao', 1980),  // within 10% → correct
              evidence('claude', 2500),       // 25% off → wrong
              evidence('openai', 'unknown'),  // unscoreable → skipped
            ],
          },
        },
      }),
      row({
        overrides: { stories: { value: 2 } },
        fieldEvidence: {
          stories: {
            evidence: [
              evidence('claude', 2),
              evidence('gemini', 1),
            ],
          },
        },
      }),
    ]);

    const report = await providerAccuracy();

    expect(report.lookupsScored).toBe(2);
    expect(report.comparisons).toBe(4);
    const byName = Object.fromEntries(report.providers.map((p) => [p.provider, p]));
    expect(byName.manatee_pao).toMatchObject({ checked: 1, correct: 1, accuracyPct: 100 });
    expect(byName.claude).toMatchObject({ checked: 2, correct: 1, accuracyPct: 50 });
    expect(byName.gemini).toMatchObject({ checked: 1, correct: 0, accuracyPct: 0 });
    expect(byName.tech).toBeUndefined();
    expect(byName.openai).toBeUndefined(); // only an unscoreable claim
    // Per-field breakdown rides each provider.
    expect(byName.claude.byField).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'squareFootage', checked: 1, correct: 0 }),
      expect.objectContaining({ field: 'stories', checked: 1, correct: 1 }),
    ]));
  });

  test('string jsonb rows parse; malformed rows are skipped, not crashed on', async () => {
    mockDbHandler = lookupsTable([
      {
        verified_overrides: JSON.stringify({ stories: { value: 1 } }),
        property_record: JSON.stringify({
          _fieldEvidence: { stories: { evidence: [evidence('claude', 1)] } },
        }),
      },
      { verified_overrides: 'not-json{', property_record: '{}' },
    ]);

    const report = await providerAccuracy();

    expect(report.lookupsScored).toBe(1);
    expect(report.providers[0]).toMatchObject({ provider: 'claude', accuracyPct: 100 });
  });

  test('verified field without retained evidence contributes nothing', async () => {
    mockDbHandler = lookupsTable([
      row({ overrides: { lotSize: { value: 9000 } }, fieldEvidence: {} }),
    ]);
    const report = await providerAccuracy();
    expect(report.lookupsScored).toBe(0);
    expect(report.comparisons).toBe(0);
    expect(report.providers).toEqual([]);
  });

  test('no verified rows → empty report, no division by zero', async () => {
    mockDbHandler = lookupsTable([]);
    const report = await providerAccuracy();
    expect(report).toMatchObject({ lookupsScored: 0, comparisons: 0, providers: [] });
  });
});
