// ops/agents/satellite-vision-model-bakeoff.js — the pure half. The scorer
// must never turn an unreported optional read (estimatedHedgeLinearFt: null)
// into a measured zero (Codex #6398 r7).
const path = require('path');
const { numericRead, score, FIELDS } = require(path.join(__dirname, '..', '..', 'ops', 'agents', 'satellite-vision-model-bakeoff.js'));

describe('satellite-vision-model-bakeoff numericRead', () => {
  test('null / undefined / blank are "not read", never zero; an explicit zero and numeric strings are reads', () => {
    expect(numericRead(null)).toBeNull();
    expect(numericRead(undefined)).toBeNull();
    expect(numericRead('')).toBeNull();
    expect(numericRead('  ')).toBeNull();
    expect(numericRead('n/a')).toBeNull();
    expect(numericRead(-3)).toBeNull();
    expect(numericRead(0)).toBe(0);
    expect(numericRead('240')).toBe(240);
    expect(numericRead(1200)).toBe(1200);
  });

  test('a null hedge read is skipped by the scorer instead of scoring a 100% miss', () => {
    expect(FIELDS).toContain('hedgeLinearFt');
    // runCase stores numericRead(analysis[field]) per field; a null read is null here.
    const cases = [{
      known: { hedgeLinearFt: 200, bedAreaSf: 900 },
      reads: [{ model: 'm', ok: true, ms: 10, values: { hedgeLinearFt: numericRead(null), bedAreaSf: numericRead(1000), ornamentalTrees: null, palms: null } }],
    }];
    const out = score(cases, ['m']);
    // ...but it is COUNTED as unavailable against the known value, so selective
    // omission cannot buy a better error score (Codex #6398 r11).
    expect(out.m.fields.hedgeLinearFt).toMatchObject({ known: 1, unavailable: 1, n: 0, pctN: 0, pctErr: 0 });
    expect(out.m.fields.bedAreaSf).toMatchObject({ known: 1, unavailable: 0, n: 1, pctN: 1, absErr: 100 });
    // No known value: neither scored nor counted.
    expect(out.m.fields.palms).toMatchObject({ known: 0, unavailable: 0, n: 0 });
  });

  test('a failed read (schema / API miss) counts as unavailable on every known field, never as a clean skip (Codex #6398 r15)', () => {
    const cases = [
      { known: { hedgeLinearFt: 200, bedAreaSf: 900, shrubDensity: 'moderate' }, reads: [{ model: 'm', ok: false, ms: 10, values: {} }] },
      { known: { bedAreaSf: 1200 }, reads: [{ model: 'm', ok: true, ms: 10, values: { bedAreaSf: numericRead(1300), hedgeLinearFt: null, ornamentalTrees: null, palms: null } }] },
    ];
    const out = score(cases, ['m']);
    // The known density counts in the denominator with no hit (Codex #6398 r18).
    expect(out.m).toMatchObject({ reads: 2, misses: 1, shrubDensityKnown: 1, shrubDensityHits: 0 });
    expect(out.m.fields.bedAreaSf).toMatchObject({ known: 2, unavailable: 1, n: 1, absErr: 100 });
    expect(out.m.fields.hedgeLinearFt).toMatchObject({ known: 1, unavailable: 1, n: 0 });
    expect(out.m.fields.palms).toMatchObject({ known: 0, unavailable: 0, n: 0 });
  });
});
