// Lawn monthly program line (lawn report rebuild P9, GATE_LAWN_EXPECTATIONS).
// Synthetic payloads only.
//
// Pins: only a recurring lawn plan visit whose plan resolved the staged v13
// version (GATE_LAWN_V13 on) gets a line; every other visit gets null and the
// report keeps the season note, so the retired per-grass sentences can never
// reach a report; no line or qualifier names a soil test; Jun-Sep returns null
// when the visit applied nitrogen (analysis_n > 0); gate off leaves the payload
// byte-identical. The v13 copy rules and claim proofs live in
// lawn-v13-copy.test.js.

const lineModule = require('../services/service-report/lawn-program-line');
const { LAWN_V13_VERSION } = require('../services/lawn-program');
const { buildLawnReportV2 } = require('../services/service-report/lawn-report-v2');

const { buildProgramLine, PROGRAM_LINES_V13, NO_NITROGEN_MONTHS, QUALIFIERS } = lineModule;
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const GRASSES = ['st_augustine', 'bermuda', 'zoysia', 'bahia'];

const WATER_MOW = /\b(water\w*|irrigat\w*|sprinkl\w*|rain\w*|mow\w*|drought|soak\w*)/i;
const DIGITS = /\d/;
const BRANDS = /(prodiamine|celsius|acelepryn|tetrino|dimension|stonewall|nutra|artavia|velista|gravex|arena|talak|dylox|dismiss|certainty|dispatch|lesco|bifen|nis\b)/i;
const SOIL_TEST = /soil[- ]?test/i;

function withEnv(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
const withV13 = (fn) => withEnv({ GATE_LAWN_V13: 'true' }, fn);
const v13Visit = (extra = {}) => ({ programVisit: true, protocolVersion: LAWN_V13_VERSION, ...extra });

describe('only a visit that resolved v13 gets a program line', () => {
  test('GATE_LAWN_V13 on: the v13 month line for every month', () => {
    withV13(() => {
      for (const month of MONTHS) expect(buildProgramLine(v13Visit({ month }))).toBe(PROGRAM_LINES_V13[month].line);
    });
  });

  test('no recorded version or an older one: no line in any month, whatever GATE_LAWN_V13 says', () => {
    for (const gate of ['true', undefined, 'false']) {
      withEnv({ GATE_LAWN_V13: gate }, () => {
        for (const month of MONTHS) {
          for (const protocolVersion of [undefined, null, '', '2026.06', 'lawn-v4']) {
            expect({ gate, month, protocolVersion, line: buildProgramLine({ programVisit: true, month, protocolVersion }) })
              .toEqual({ gate, month, protocolVersion, line: null });
          }
        }
      });
    }
  });

  test('GATE_LAWN_V13 off: a visit that recorded v13 gets no line either', () => {
    for (const gate of [undefined, 'false', '']) {
      withEnv({ GATE_LAWN_V13: gate }, () => {
        for (const month of MONTHS) expect(buildProgramLine(v13Visit({ month }))).toBeNull();
      });
    }
  });

  test('one program for every grass: the grass on the turf profile never changes the line', () => {
    withV13(() => {
      for (const grassType of [...GRASSES, null, 'unknown', 'mixed']) {
        for (const month of MONTHS) expect(buildProgramLine(v13Visit({ month, grassType }))).toBe(PROGRAM_LINES_V13[month].line);
      }
    });
  });

  test('the retired per-grass and generic tables are gone', () => {
    for (const name of ['PROGRAM_LINES', 'DEFAULT_LINES', 'grassKeyFor', 'protocolMonths']) expect(lineModule[name]).toBeUndefined();
  });

  test('no valid month is a deliberate null', () => {
    withV13(() => {
      for (const month of [null, undefined, 0, 13, 1.5, 'x', NaN]) expect(buildProgramLine(v13Visit({ month }))).toBeNull();
      expect(buildProgramLine()).toBeNull();
    });
  });
});

describe('qualifier wording', () => {
  test('no line and no qualifier names a soil test (owner 2026-10-05: Waves runs no soil tests)', () => {
    for (const month of MONTHS) expect(PROGRAM_LINES_V13[month].line).not.toMatch(SOIL_TEST);
    for (const q of QUALIFIERS) expect(q).not.toMatch(SOIL_TEST);
  });

  test('qualifiers are neutral wording: no water, tier, count or product word', () => {
    for (const q of QUALIFIERS) {
      expect(q).not.toMatch(WATER_MOW);
      expect(q).not.toMatch(BRANDS);
      expect(q).not.toMatch(DIGITS);
      expect(q).not.toMatch(/\b(basic|standard|enhanced|premium|bronze|silver|gold|platinum|tier|visits?)\b/i);
    }
  });
});

describe('Jun-Sep with nitrogen applied is a deliberate null', () => {
  const nApp = { product: { name: 'Synthetic Fertilizer 24-0-11', analysis_n: 24 } };
  const kApp = { product: { name: 'Synthetic Potassium 0-0-25', analysis_n: 0 } };

  test.each([6, 7, 8, 9])('month %i: analysis_n > 0 -> null, analysis_n 0 or none -> line', (month) => {
    withV13(() => {
      expect(buildProgramLine(v13Visit({ month, applications: [nApp] }))).toBeNull();
      expect(buildProgramLine(v13Visit({ month, applications: [kApp, nApp] }))).toBeNull();
      expect(buildProgramLine(v13Visit({ month, applications: [kApp] }))).toBe(PROGRAM_LINES_V13[month].line);
      expect(buildProgramLine(v13Visit({ month, applications: [] }))).toBe(PROGRAM_LINES_V13[month].line);
    });
  });

  test('either report shape and a fertilizer-analysis name count as nitrogen', () => {
    withV13(() => {
      expect(buildProgramLine(v13Visit({ month: 7, applications: [{ analysis_n: '16' }] }))).toBeNull();
      expect(buildProgramLine(v13Visit({ month: 7, applications: [{ product: { name: 'Synthetic 24-0-11' } }] }))).toBeNull();
      expect(buildProgramLine(v13Visit({ month: 7, applications: [{ product: { name: 'Synthetic 0-0-25' } }] }))).toBe(PROGRAM_LINES_V13[7].line);
    });
  });

  test('the caller-supplied catalog answer wins over the shapes', () => {
    withV13(() => {
      expect(buildProgramLine(v13Visit({ month: 7, applications: [kApp], nitrogenApplied: true }))).toBeNull();
      expect(buildProgramLine(v13Visit({ month: 7, applications: [nApp], nitrogenApplied: false }))).toBe(PROGRAM_LINES_V13[7].line);
    });
  });

  test('other months do not care about nitrogen', () => {
    withV13(() => {
      for (const month of [1, 2, 3, 4, 5, 10, 11, 12]) expect(buildProgramLine(v13Visit({ month, applications: [nApp] }))).toBe(PROGRAM_LINES_V13[month].line);
    });
  });

  test('Jun-Sep lines never describe a nitrogen feeding (the program applies none)', () => {
    for (const month of NO_NITROGEN_MONTHS) expect(Object.keys(PROGRAM_LINES_V13[month].claims)).not.toContain('feed');
  });
});

// ── gate wiring in buildLawnReportV2 ────────────────────────────────────────
const GATE = 'GATE_LAWN_EXPECTATIONS';
// GATE_LAWN_V13 stays on here: these tests are about GATE_LAWN_EXPECTATIONS.
const withGate = (value, fn) => withEnv({ [GATE]: value, GATE_LAWN_V13: 'true' }, fn);

function assessment(overrides = {}) {
  return {
    assessmentDate: '2026-10-14',
    scores: { turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35, fungusControl: 95, overallScore: 68, season: 'shoulder' },
    overwateringSignal: false,
    droughtStress: 'minor',
    turfProfile: { grassType: 'st_augustine' },
    observations: 'Synthetic observation.',
    waterContext: {
      rainfallInches7d: 0.9, irrigationInchesPerWeek: 0.7, effectiveInches7d: 1.6, targetInchesPerWeek: 1.25,
      irrigationAdvice: { status: 'balanced', rainKnown: true, profileMissing: false, recommendedInchesPerWeek: 1.25 },
    },
    trend: [
      { date: '2026-04-15', overallScore: 60, turfDensity: 60, weedSuppression: 70, colorHealth: 65, stressDamage: 40, season: 'shoulder' },
      { date: '2026-10-14', overallScore: 68, turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35, season: 'shoulder' },
    ],
    ...overrides,
  };
}
const v13Report = (extra = {}) => buildLawnReportV2({ lawnAssessment: assessment(), programVisit: true, protocolVersion: LAWN_V13_VERSION, ...extra });

describe('buildLawnReportV2 and GATE_LAWN_EXPECTATIONS', () => {
  const OLD_SHOULDER = /transitional stretch/;

  test('gate off (unset or any non-true) is byte-identical: old note, no new key', () => {
    const baseline = withGate(undefined, () => v13Report());
    for (const value of ['', 'false', '0', 'off']) {
      const off = withGate(value, () => v13Report());
      expect(JSON.stringify(off)).toBe(JSON.stringify(baseline));
    }
    expect(baseline.snapshot.seasonalNote).toMatch(OLD_SHOULDER);
    expect(baseline.snapshot).not.toHaveProperty('seasonalNoteSource');
    expect(baseline).not.toHaveProperty('seasonalNote');
  });

  test('gate on: a v13 visit\'s snapshot.seasonalNote is the program line from the visit month, marked as program', () => {
    const on = withGate('true', () => v13Report());
    expect(on.snapshot.seasonalNote).toBe(PROGRAM_LINES_V13[10].line);
    expect(on.snapshot.seasonalNoteSource).toBe('program');
    expect(on).not.toHaveProperty('seasonalNote');
    // Only the season note differs from the gate-off payload.
    const off = withGate(undefined, () => v13Report());
    const strip = (v) => { const c = JSON.parse(JSON.stringify(v)); delete c.snapshot.seasonalNote; delete c.snapshot.seasonalNoteSource; return c; };
    // smsSummary and the rest are derived from other snapshot fields
    expect(strip(on)).toEqual(strip(off));
  });

  test('gate on: a visit that did not resolve v13 keeps the old note, unmarked, and is byte-identical to gate off', () => {
    for (const extra of [{ protocolVersion: undefined }, { protocolVersion: null }, { protocolVersion: '2026.06' }]) {
      const on = withGate('true', () => v13Report(extra));
      const off = withGate(undefined, () => v13Report(extra));
      expect(on.snapshot.seasonalNote).toMatch(OLD_SHOULDER);
      expect(on.snapshot).not.toHaveProperty('seasonalNoteSource');
      expect(JSON.stringify(on)).toBe(JSON.stringify(off));
    }
    // GATE_LAWN_V13 off: a visit that recorded v13 also keeps the old note.
    const v13Off = withEnv({ [GATE]: 'true', GATE_LAWN_V13: undefined }, () => v13Report());
    expect(v13Off.snapshot.seasonalNote).toMatch(OLD_SHOULDER);
    expect(v13Off.snapshot).not.toHaveProperty('seasonalNoteSource');
  });

  test('the month is the noon-UTC visit month; the grass does not change it', () => {
    const month = (date, grassType) => withGate('true', () => buildLawnReportV2({
      lawnAssessment: assessment({ assessmentDate: date, turfProfile: { grassType } }),
      programVisit: true,
      protocolVersion: LAWN_V13_VERSION,
    }).snapshot.seasonalNote);
    expect(month('2026-01-31', 'bermuda')).toBe(PROGRAM_LINES_V13[1].line);
    expect(month('2026-02-01', 'zoysia')).toBe(PROGRAM_LINES_V13[2].line);
    expect(month('2026-12-01', 'bahia')).toBe(PROGRAM_LINES_V13[12].line);
    expect(month('2026-03-10', 'weird')).toBe(PROGRAM_LINES_V13[3].line);
  });

  test('null line (Jun-Sep nitrogen, or no assessment date) falls back to the old note, unmarked', () => {
    const june = (extra) => withGate('true', () => buildLawnReportV2({
      lawnAssessment: assessment({ assessmentDate: '2026-06-18', scores: { turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35, fungusControl: 95, overallScore: 68, season: 'peak' } }),
      programVisit: true,
      protocolVersion: LAWN_V13_VERSION,
      ...extra,
    }));
    const withN = june({ nitrogenApplied: true });
    expect(withN.snapshot.seasonalNote).toMatch(/peak heat-and-pest/);
    expect(withN.snapshot).not.toHaveProperty('seasonalNoteSource');
    const noN = june({ nitrogenApplied: false });
    expect(noN.snapshot.seasonalNote).toBe(PROGRAM_LINES_V13[6].line);
    const byName = june({ applications: [{ product: { name: 'Synthetic 24-0-11' } }] });
    expect(byName.snapshot).not.toHaveProperty('seasonalNoteSource');

    const noDate = withGate('true', () => buildLawnReportV2({ lawnAssessment: assessment({ assessmentDate: null }), programVisit: true, protocolVersion: LAWN_V13_VERSION }));
    expect(noDate.snapshot.seasonalNote).toMatch(OLD_SHOULDER);
    expect(noDate.snapshot).not.toHaveProperty('seasonalNoteSource');
  });

  test('the gate reader is exported on its own line and reads at call time', () => {
    const gates = require('../config/feature-gates');
    expect(withGate('true', () => gates.lawnExpectationsLive())).toBe(true);
    expect(withGate('1', () => gates.lawnExpectationsLive())).toBe(true);
    expect(withGate(undefined, () => gates.lawnExpectationsLive())).toBe(false);
    expect(withGate('false', () => gates.lawnExpectationsLive())).toBe(false);
  });
});

describe('resolveNitrogenApplied (the report-data caller) fails closed', () => {
  const { resolveNitrogenApplied } = require('../services/service-report/lawn-program-line');
  const rowsFor = (rows) => async () => rows;
  const app = (catalogId, name = 'Synthetic Product') => ({ product: { name, ...(catalogId ? { catalogId } : {}) } });
  test('a failed product load counts as nitrogen applied, with no catalog read', async () => {
    const load = jest.fn();
    await expect(resolveNitrogenApplied({ applications: [], productsLoadFailed: true, loadCatalogRows: load })).resolves.toBe(true);
    expect(load).not.toHaveBeenCalled();
  });
  test('a failed catalog read counts as nitrogen applied', async () => {
    await expect(resolveNitrogenApplied({ applications: [app('c1')], loadCatalogRows: async () => { throw new Error('db'); } })).resolves.toBe(true);
  });
  test('a catalog analysis_n above zero counts', async () => {
    await expect(resolveNitrogenApplied({ applications: [app('c1')], loadCatalogRows: rowsFor([{ id: 'c1', analysis_n: 16, category: 'fertilizer' }]) })).resolves.toBe(true);
  });
  test('an applied product with no catalogId counts, whatever its name says (a removed catalog row nulls product_id)', async () => {
    const load = jest.fn(async () => []);
    await expect(resolveNitrogenApplied({ applications: [app(null, 'Synthetic Chelated Iron Plus')], loadCatalogRows: load })).resolves.toBe(true);
    await expect(resolveNitrogenApplied({ applications: [app('c1', 'Celsius WG'), app(null, 'Granular 24-0-11')], loadCatalogRows: rowsFor([{ id: 'c1', analysis_n: 0, category: 'herbicide' }]) })).resolves.toBe(true);
  });
  test('a catalogId whose row the catalog no longer returns counts', async () => {
    await expect(resolveNitrogenApplied({ applications: [app('missing')], loadCatalogRows: rowsFor([]) })).resolves.toBe(true);
    await expect(resolveNitrogenApplied({ applications: [app('c1'), app('c2')], loadCatalogRows: rowsFor([{ id: 'c1', analysis_n: 0, category: 'herbicide' }]) })).resolves.toBe(true);
  });
  test('a resolved fertilizer-type row with NULL analysis_n counts', async () => {
    for (const row of [{ id: 'c1', analysis_n: null, category: 'fertilizer' }, { id: 'c1', category: 'Lawn Fertilizer' }, { id: 'c1', analysis_n: null, product_type: 'fertilizer' }]) {
      await expect(resolveNitrogenApplied({ applications: [app('c1')], loadCatalogRows: rowsFor([row]) })).resolves.toBe(true);
    }
  });
  test('the name check stays an extra positive signal', async () => {
    await expect(resolveNitrogenApplied({ applications: [app('c1', 'Granular 24-0-11')], loadCatalogRows: rowsFor([{ id: 'c1', analysis_n: 0, category: 'herbicide' }]) })).resolves.toBe(true);
  });
  test('only fully resolved products with known analysis_n 0, or a non-fertilizer with none, clear it', async () => {
    await expect(resolveNitrogenApplied({ applications: [app('c1'), app('c2')], loadCatalogRows: rowsFor([
      { id: 'c1', analysis_n: 0, category: 'fertilizer' },
      { id: 'c2', analysis_n: null, category: 'herbicide' },
    ]) })).resolves.toBe(false);
    await expect(resolveNitrogenApplied({ applications: [], loadCatalogRows: jest.fn() })).resolves.toBe(false);
  });
});

describe('resolveProgramVisit: only recurring lawn plan visits get the line', () => {
  const { resolveProgramVisit } = require('../services/service-report/lawn-program-line');
  const visit = { id: 'v1', service_id: 's1', service_type: 'Lawn Care' };
  const profile = (overrides) => async () => ({ serviceKey: 'lawn_care_recurring', billingType: 'recurring', ...overrides });
  test('recurring lawn plan service identities qualify', async () => {
    for (const serviceKey of ['lawn_care_recurring', 'lawn_care_quarterly', 'lawn_care_monthly', 'lawn_care_6week', 'lawn_care']) {
      await expect(resolveProgramVisit({ scheduledService: visit, loadProfile: profile({ serviceKey }) })).resolves.toBe(true);
    }
  });
  test('one-time lawn jobs and other lines do not', async () => {
    for (const [serviceKey, billingType] of [['lawn_care_one_time', 'one_time'], ['lawn_pest_knockdown', 'one_time'], ['one_time_lawn', 'one_time'], ['lawn_care_one_time', 'recurring'], ['lawn_tree_shrub_combo', 'recurring'], ['lawn_aeration', 'one_time'], ['pest_control_quarterly', 'recurring'], [null, 'recurring']]) {
      await expect({ serviceKey, billingType, ok: await resolveProgramVisit({ scheduledService: visit, loadProfile: profile({ serviceKey, billingType }) }) }).toEqual({ serviceKey, billingType, ok: false });
    }
  });
  test('fails closed: no visit, a callback, a synthesized or missing profile, a lookup error, no resolver', async () => {
    await expect(resolveProgramVisit({ scheduledService: null, loadProfile: profile({}) })).resolves.toBe(false);
    await expect(resolveProgramVisit({ scheduledService: visit, isCallback: true, loadProfile: profile({}) })).resolves.toBe(false);
    await expect(resolveProgramVisit({ scheduledService: visit, loadProfile: profile({ synthesized: true }) })).resolves.toBe(false);
    await expect(resolveProgramVisit({ scheduledService: visit, loadProfile: async () => null })).resolves.toBe(false);
    await expect(resolveProgramVisit({ scheduledService: visit, loadProfile: async () => { throw new Error('db'); } })).resolves.toBe(false);
    await expect(resolveProgramVisit({ scheduledService: visit })).resolves.toBe(false);
    await expect(resolveProgramVisit()).resolves.toBe(false);
  });
  test('the frozen completion identity wins in both edit directions (repointing the scheduled row changes nothing)', async () => {
    const live = (serviceKey, billingType) => jest.fn(async () => ({ serviceKey, billingType }));
    // completed one-time visit later repointed to a recurring service: still no line
    const toRecurring = live('lawn_care_recurring', 'recurring');
    await expect(resolveProgramVisit({ serviceData: { completedServiceKey: 'lawn_care_one_time' }, scheduledService: visit, loadProfile: toRecurring })).resolves.toBe(false);
    await expect(resolveProgramVisit({ serviceData: { completedServiceKey: 'lawn_pest_knockdown' }, scheduledService: visit, loadProfile: toRecurring })).resolves.toBe(false);
    expect(toRecurring).not.toHaveBeenCalled();
    // genuine program visit later repointed to a one-time service, or the row gone: still gets the line
    const toOneTime = live('lawn_care_one_time', 'one_time');
    await expect(resolveProgramVisit({ serviceData: { completedServiceKey: 'lawn_care_quarterly' }, scheduledService: visit, loadProfile: toOneTime })).resolves.toBe(true);
    await expect(resolveProgramVisit({ serviceData: { completedServiceKey: 'lawn_care_monthly' }, scheduledService: null })).resolves.toBe(true);
    expect(toOneTime).not.toHaveBeenCalled();
  });
  test('a frozen but null / blank / non-lawn key is an unknown identity: no line and no live fallback', async () => {
    const loadProfile = jest.fn(async () => ({ serviceKey: 'lawn_care_recurring', billingType: 'recurring' }));
    for (const completedServiceKey of [null, '', undefined, 'pest_control_quarterly', 'lawn_tree_shrub_combo', 'lawn_aeration']) {
      await expect({ completedServiceKey, ok: await resolveProgramVisit({ serviceData: { completedServiceKey }, scheduledService: visit, loadProfile }) }).toEqual({ completedServiceKey, ok: false });
    }
    expect(loadProfile).not.toHaveBeenCalled();
  });
  test('a legacy record (no completedServiceKey) falls back to live resolution; a callback never qualifies', async () => {
    const live = jest.fn(async () => ({ serviceKey: 'lawn_care_recurring', billingType: 'recurring' }));
    await expect(resolveProgramVisit({ serviceData: {}, scheduledService: visit, loadProfile: live })).resolves.toBe(true);
    await expect(resolveProgramVisit({ serviceData: null, scheduledService: visit, loadProfile: live })).resolves.toBe(true);
    await expect(resolveProgramVisit({ serviceData: { completedServiceName: 'Lawn Care' }, scheduledService: visit, loadProfile: async () => ({ serviceKey: 'lawn_care_one_time', billingType: 'one_time' }) })).resolves.toBe(false);
    await expect(resolveProgramVisit({ serviceData: { completedServiceKey: 'lawn_care_recurring' }, scheduledService: visit, isCallback: true, loadProfile: live })).resolves.toBe(false);
  });
  test('the WaveGuard tier is never read', async () => {
    const loadProfile = jest.fn(async () => ({ serviceKey: 'lawn_care_recurring', billingType: 'recurring' }));
    await resolveProgramVisit({ scheduledService: { ...visit, waveguard_tier: 'Platinum', service_tier: 'Gold' }, loadProfile });
    expect(loadProfile).toHaveBeenCalledTimes(1);
    expect(resolveProgramVisit.toString()).not.toMatch(/tier/i);
  });
  test('buildProgramLine returns null unless programVisit is exactly true (fail closed, default off)', () => {
    withV13(() => {
      for (const programVisit of [undefined, null, false, 0, 'true', 1]) {
        expect(buildProgramLine({ month: 3, protocolVersion: LAWN_V13_VERSION, programVisit })).toBeNull();
      }
      expect(buildProgramLine({ month: 3, protocolVersion: LAWN_V13_VERSION })).toBeNull();
      expect(buildProgramLine(v13Visit({ month: 3 }))).toBe(PROGRAM_LINES_V13[3].line);
    });
  });
  test('buildLawnReportV2: gate on with no / false programVisit keeps the old note, unmarked', () => {
    for (const extra of [{}, { programVisit: false }, { programVisit: null }]) {
      const out = withGate('true', () => buildLawnReportV2({ lawnAssessment: assessment(), protocolVersion: LAWN_V13_VERSION, ...extra }));
      expect(out.snapshot.seasonalNote).toMatch(/transitional stretch/);
      expect(out.snapshot).not.toHaveProperty('seasonalNoteSource');
    }
  });
  test('buildLawnReportV2 never crashes on a partial feature-gates mock (gate missing = off)', () => {
    jest.isolateModules(() => {
      jest.doMock('../config/feature-gates', () => ({ isEnabled: () => false, gateEnvValue: () => false, lawnReportLeadLive: () => false }));
      const { buildLawnReportV2: build } = require('../services/service-report/lawn-report-v2');
      const out = build({ lawnAssessment: assessment(), programVisit: true, protocolVersion: LAWN_V13_VERSION });
      expect(out.snapshot.seasonalNote).toMatch(/transitional stretch/);
      expect(out.snapshot).not.toHaveProperty('seasonalNoteSource');
    });
  });
});

describe('GATE_LAWN_PROGRAM_DETAIL (owner 2026-10-06)', () => {
  const { PROGRAM_DETAIL_V13, buildProgramDetail } = require('../services/service-report/lawn-program-line');
  const withBoth = (detail, fn) => withEnv({ [GATE]: 'true', GATE_LAWN_V13: 'true', GATE_LAWN_PROGRAM_DETAIL: detail }, fn);

  test('every month has why-now, what-you-will-see and watering lines', () => {
    for (let m = 1; m <= 12; m += 1) {
      const d = PROGRAM_DETAIL_V13[m];
      expect(d.whyNow).toEqual(expect.any(String));
      expect(d.whatYouSee).toEqual(expect.any(String));
      expect(d.watering.length).toBeGreaterThan(0);
    }
  });

  test('the copy names no product, brand, active ingredient or rate', () => {
    const all = JSON.stringify(PROGRAM_DETAIL_V13);
    expect(all).not.toMatch(/LESCO|Stonewall|Dimension|Celsius|Certainty|Artavia|Velista|Arena|Acelepryn|Tetrino|Dylox|Gravex|Dismiss|Nutra|prodiamine|dithiopyr|azoxystrobin|\bper 1,000\b|\blb\b|fl oz/i);
  });

  test('no detail without a program line', () => {
    expect(buildProgramDetail({ month: 10, programLine: null })).toBeNull();
    expect(buildProgramDetail({ month: 10, programLine: 'x' })).toBe(PROGRAM_DETAIL_V13[10]);
  });

  test('gate off: no seasonalDetail key and the payload is unchanged', () => {
    const off = withBoth(undefined, () => v13Report());
    expect(off.snapshot).not.toHaveProperty('seasonalDetail');
    expect(JSON.stringify(withBoth('false', () => v13Report()))).toBe(JSON.stringify(off));
  });

  test('gate on: the v13 month detail rides beside the program line', () => {
    const on = withBoth('true', () => v13Report());
    expect(on.snapshot.seasonalNoteSource).toBe('program');
    expect(on.snapshot.seasonalDetail).toEqual(PROGRAM_DETAIL_V13[10]);
  });

  test('gate on without the program line (expectations off): no detail', () => {
    const on = withEnv({ [GATE]: undefined, GATE_LAWN_V13: 'true', GATE_LAWN_PROGRAM_DETAIL: 'true' }, () => v13Report());
    expect(on.snapshot).not.toHaveProperty('seasonalDetail');
  });
});
