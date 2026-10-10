// GATE_LAWN_REPORT_STAGE1_FIXES: five small fixes found on one real lawn report, all behind one dark gate
// (owner 2026-10-09). Gate off = the payload this report has always had; gate on = the new behaviour.
// Synthetic names and addresses only.
//
//   1. the damage finding names the pest a spot insecticide row targeted
//   2. "What to expect" prints a second line (insecticide row, else feeding row), from existing sentences
//   3. a frozen "add your irrigation settings" tip is left off beside a schedule on file
//   4. (client) the applied card that repeats Today's result is left out; see LawnReportV2.stage1.test.jsx
//   5. (client) the web hero leaves out the email and phone; see ReportViewPage.lawn-stage1.test.jsx

jest.mock('../services/lawn-assessment-history', () => ({
  installedForVisit: jest.fn(),
  historyForReport: jest.fn(),
  historyForAssessment: jest.fn(),
  restrictVisitHistory: (query) => query,
}));
jest.mock('../services/llm/call', () => {
  const actual = jest.requireActual('../services/llm/call');
  return { ...actual, dispatchWithFallback: jest.fn() };
});

const history = require('../services/lawn-assessment-history');
const featureGates = require('../config/feature-gates');
const { buildReportV1Data, resolveCanonicalLawnRender } = require('../services/service-report/report-data');
const { buildLawnReportV2 } = require('../services/service-report/lawn-report-v2');
const stage1 = require('../services/service-report/lawn-report-stage1');
const v6 = require('../services/service-report/lawn-copy-v6');
const { buildLawnExpectations } = require('../services/service-report/lawn-expectations');
const { SENTENCE, TECH_FOUND_PHRASES, TIE_PRODUCT_PHRASES } = require('../services/service-report/lawn-visit-summary');
const { customerCopyViolations } = require('../services/service-report/technician-report-copy');
const { TIPS } = require('../services/service-report/tip-library');

const GATE = 'GATE_LAWN_REPORT_STAGE1_FIXES';
const COPY_FIXES = 'GATE_LAWN_REPORT_COPY_FIXES';
const POLISH = 'GATE_LAWN_REPORT_POLISH';
const TECH_TIPS = 'GATE_TECH_TIPS';
const saved = Object.fromEntries([GATE, COPY_FIXES, POLISH, TECH_TIPS].map((k) => [k, process.env[k]]));
const gateOn = () => { process.env[GATE] = 'true'; };
const gateOff = () => { delete process.env[GATE]; };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

// ── the gate ────────────────────────────────────────────────────────────────
describe('the gate reader', () => {
  test('strict opt-in: only the exact string true', () => {
    gateOff();
    expect(featureGates.lawnReportStage1FixesLive()).toBe(false);
    for (const v of ['1', 'on', 'TRUE', 'True', 'yes', '']) {
      process.env[GATE] = v;
      expect(featureGates.lawnReportStage1FixesLive()).toBe(false);
    }
    gateOn();
    expect(featureGates.lawnReportStage1FixesLive()).toBe(true);
  });

  test('payload flag and PDF stamp: lawn only, only while live', () => {
    gateOff();
    expect(stage1.stage1PayloadFlag('lawn')).toEqual({});
    expect(stage1.stage1PdfStamp()).toBe('');
    gateOn();
    expect(stage1.stage1PayloadFlag('lawn')).toEqual({ lawnStage1Fixes: true });
    expect(stage1.stage1PayloadFlag('pest')).toEqual({});
    expect(stage1.stage1PayloadFlag('tree_shrub')).toEqual({});
    expect(stage1.stage1PdfStamp()).toBe(':s1=1');
  });

  test('gate off, a frozen stage 1 copy entry: the key part still follows the record (:s1f=1)', () => {
    gateOff();
    const notes = (entry) => JSON.stringify({ lawnCopyV6: { 'la-1': entry } });
    expect(stage1.stage1PdfStamp(notes({ v: 1, stage1Expect: true }))).toBe(':s1f=1');
    expect(stage1.stage1PdfStamp({ lawnCopyV6: { 'la-1': { stage1Expect: true } } })).toBe(':s1f=1');
    expect(stage1.stage1PdfStamp(notes({ v: 1 }))).toBe('');
    expect(stage1.stage1PdfStamp('not json')).toBe('');
    expect(stage1.stage1PdfStamp(null)).toBe('');
    gateOn();
    expect(stage1.stage1PdfStamp(notes({ v: 1 }))).toBe(':s1=1');
  });

  test('a partial feature-gates mock means off, never a crash', () => {
    jest.isolateModules(() => {
      jest.doMock('../config/feature-gates', () => ({}));
      const isolated = require('../services/service-report/lawn-report-stage1');
      expect(isolated.stage1Live()).toBe(false);
      expect(isolated.stage1PdfStamp()).toBe('');
    });
  });
});

// ── fixtures ────────────────────────────────────────────────────────────────
function baseAssessment(overrides = {}) {
  return {
    assessmentDate: '2026-10-08',
    // stressDamage 55 puts the stress card on "watch", so the damage finding exists
    scores: { turfDensity: 73, weedSuppression: 88, colorHealth: 77, stressDamage: 55, fungusControl: 95, overallScore: 78, season: 'shoulder' },
    overwateringSignal: false,
    droughtStress: 'none',
    turfProfile: { grassType: 'st_augustine' },
    observations: '',
    waterContext: {
      rainfallInches7d: 0.9, irrigationInchesPerWeek: 0.7, effectiveInches7d: 1.6, targetInchesPerWeek: 0.75,
      irrigationAdvice: { status: 'balanced', rainKnown: true, profileMissing: false, recommendedInchesPerWeek: 0.75, targetBasis: 'evapotranspiration' },
    },
    ...overrides,
  };
}
const ARENA = {
  product: { name: 'Arena 50 WDG', category: 'insecticide', active_ingredient: 'clothianidin' },
  method: 'spot_treatment', targets: ['Southern chinch bugs'], areaValue: 500, areaUnit: 'sqft',
};
const damageOf = (v2) => v2.insights.find((card) => card.category === 'damage');

// ── 1. the damage finding names the pest ────────────────────────────────────
describe('change 1: the damage finding names the targeted pest', () => {
  const OLD = {
    headline: 'A few stress patterns to monitor',
    whatWeSaw: 'Some stress patterns in the turf that we want to keep an eye on.',
  };

  test('gate off: the stock damage finding, whatever the visit applied', () => {
    gateOff();
    const v2 = buildLawnReportV2({ lawnAssessment: baseAssessment(), applications: [ARENA] });
    expect(damageOf(v2)).toMatchObject({ ...OLD, status: 'watch' });
    expect(v2.snapshot.watching).toEqual([OLD.headline]);
  });

  test('gate on, a spot insecticide with a chinch bug target: pest headline, the Visit Summary sentence, the product and area', () => {
    gateOn();
    const v2 = buildLawnReportV2({ lawnAssessment: baseAssessment(), applications: [ARENA] });
    const card = damageOf(v2);
    expect(card.headline).toBe('Chinch bug damage in one area — treated today');
    expect(card.whatWeSaw).toBe('Your technician found chinch bugs and treated that spot today.');
    expect(card.wavesAction).toBe('Applied Arena 50 WDG to about 500 sq ft.');
    // untouched: status, the next-visit plan, the why line
    expect(card.status).toBe('watch');
    expect(card.nextVisitPlan).toBe('Recheck these areas next visit to confirm what’s driving them.');
    // the snapshot's watch list repeats the new headline, not the old one
    expect(v2.snapshot.watching).toEqual([card.headline]);
  });

  test('the sentence is the Visit Summary\'s own (one table, no second copy)', () => {
    gateOn();
    const card = damageOf(buildLawnReportV2({ lawnAssessment: baseAssessment(), applications: [ARENA] }));
    expect(card.whatWeSaw).toBe(SENTENCE.tieTech(TECH_FOUND_PHRASES.chinch));
  });

  test('every new string passes the customer-copy screen', () => {
    gateOn();
    const card = damageOf(buildLawnReportV2({ lawnAssessment: baseAssessment(), applications: [ARENA] }));
    for (const text of [card.headline, card.whatWeSaw, card.wavesAction]) expect(customerCopyViolations(text)).toEqual([]);
  });

  test('caterpillar targets read the Visit Summary\'s caterpillar phrase', () => {
    gateOn();
    for (const target of ['Fall armyworms', 'Tropical sod webworms']) {
      const card = damageOf(buildLawnReportV2({ lawnAssessment: baseAssessment(), applications: [{ ...ARENA, targets: [target] }] }));
      expect(card.headline).toBe('Caterpillar damage in one area — treated today');
      expect(card.whatWeSaw).toBe('Your technician found caterpillars and treated that spot today.');
    }
  });

  test('a target that is not a known pest leaves the finding as it was', () => {
    gateOn();
    for (const target of ['White grubs', 'Fire ants', 'Large patch', 'Broadleaf weeds', 'Nematodes']) {
      const card = damageOf(buildLawnReportV2({ lawnAssessment: baseAssessment(), applications: [{ ...ARENA, targets: [target] }] }));
      expect(card).toMatchObject(OLD);
    }
  });

  test('not a spot row, not an insecticide, an inferred method, or no target: unchanged', () => {
    gateOn();
    const cases = [
      { ...ARENA, method: 'broadcast_spray' },
      { ...ARENA, method: 'spot_treatment', methodInferred: true },
      { ...ARENA, targets: [] },
      { ...ARENA, product: { name: 'Celsius WG', category: 'herbicide', active_ingredient: 'thiencarbazone' } },
    ];
    for (const app of cases) {
      expect(damageOf(buildLawnReportV2({ lawnAssessment: baseAssessment(), applications: [app] }))).toMatchObject(OLD);
    }
  });

  test('a product the expectation table locks to preventive (Acelepryn) with a target never makes the found-and-treated card', () => {
    gateOn();
    const acelepryn = { ...ARENA, product: { name: 'Acelepryn Insecticide', category: 'insecticide', active_ingredient: 'chlorantraniliprole' }, targets: ['Fall armyworms'] };
    const card = damageOf(buildLawnReportV2({ lawnAssessment: baseAssessment(), applications: [acelepryn] }));
    expect(card).toMatchObject(OLD);
    expect(card.wavesAction).toBe('Documented the areas for comparison next visit.');
  });

  test('a product the expectation table does not map has no known mode: unchanged', () => {
    gateOn();
    const unmapped = { ...ARENA, product: { name: 'Unlisted Insecticide 9000', category: 'insecticide' } };
    expect(damageOf(buildLawnReportV2({ lawnAssessment: baseAssessment(), applications: [unmapped] }))).toMatchObject(OLD);
  });

  test('a mapped product whose staff-edited name fails the screen falls back to the category phrase', () => {
    gateOn();
    const real = require('../services/service-report/lawn-expectations');
    const spy = jest.spyOn(real, 'classifyLawnProduct').mockReturnValue({ family: 'insecticide', modeLock: undefined });
    try {
      for (const name of ['Arena (safe for pets) 50 WDG', 'Arena gate code 4821', 'Arena guaranteed results']) {
        const app = { ...ARENA, product: { ...ARENA.product, name } };
        const card = damageOf(buildLawnReportV2({ lawnAssessment: baseAssessment(), applications: [app] }));
        expect(card.wavesAction).toBe(`Applied ${TIE_PRODUCT_PHRASES.insecticide} to about 500 sq ft.`);
        expect(customerCopyViolations(card.wavesAction)).toEqual([]);
        expect(card.wavesAction).not.toMatch(/4821|safe|guarantee/i);
      }
      // a clean name still prints
      const clean = damageOf(buildLawnReportV2({ lawnAssessment: baseAssessment(), applications: [ARENA] }));
      expect(clean.wavesAction).toBe('Applied Arena 50 WDG to about 500 sq ft.');
    } finally { spy.mockRestore(); }
  });

  test('no damage finding on the report (stress card healthy): nothing is added', () => {
    gateOn();
    const healthy = baseAssessment({ scores: { ...baseAssessment().scores, stressDamage: 90 } });
    expect(damageOf(buildLawnReportV2({ lawnAssessment: healthy, applications: [ARENA] }))).toBeUndefined();
  });

  test('area unknown: the headline and sentence change, the action line does not', () => {
    gateOn();
    const card = damageOf(buildLawnReportV2({ lawnAssessment: baseAssessment(), applications: [{ ...ARENA, areaValue: null, areaUnit: null }] }));
    expect(card.headline).toMatch(/^Chinch bug damage/);
    expect(card.wavesAction).toBe('Documented the areas for comparison next visit.');
  });

  test('a frozen spot text decides the area: a figure in it is used, a plain "Spot treatment" means none', () => {
    gateOn();
    const withText = damageOf(buildLawnReportV2({ lawnAssessment: baseAssessment(), applications: [{ ...ARENA, areaValue: 6000, areaUse: 'Spot treatment, about 250 sq ft' }] }));
    expect(withText.wavesAction).toBe('Applied Arena 50 WDG to about 250 sq ft.');
    const plain = damageOf(buildLawnReportV2({ lawnAssessment: baseAssessment(), applications: [{ ...ARENA, areaValue: 6000, areaUse: 'Spot treatment' }] }));
    expect(plain.wavesAction).toBe('Documented the areas for comparison next visit.');
  });

  test('a recorded area in another unit is not read as square feet', () => {
    gateOn();
    const card = damageOf(buildLawnReportV2({ lawnAssessment: baseAssessment(), applications: [{ ...ARENA, areaValue: 3, areaUnit: 'acres' }] }));
    expect(card.wavesAction).toBe('Documented the areas for comparison next visit.');
  });

  test('copy fixes live too: the product category phrase stands for the name', () => {
    gateOn();
    process.env[COPY_FIXES] = 'true';
    const card = damageOf(buildLawnReportV2({ lawnAssessment: baseAssessment(), applications: [ARENA] }));
    expect(card.wavesAction).toBe(`Applied ${TIE_PRODUCT_PHRASES.insecticide} to about 500 sq ft.`);
    expect(card.wavesAction).not.toMatch(/arena/i);
  });

  test('raw service_products shape (product_name, application_method) is read too', () => {
    gateOn();
    const raw = { product_name: 'Arena 50 WDG', product_category: 'insecticide', application_method: 'Spot treatment', targets: ['Southern chinch bugs'], area_value: 400, area_unit: 'sq_ft' };
    const card = damageOf(buildLawnReportV2({ lawnAssessment: baseAssessment(), applications: [raw] }));
    expect(card.wavesAction).toBe('Applied Arena 50 WDG to about 400 sq ft.');
  });
});

// ── 2. a second "What to expect" line ───────────────────────────────────────
describe('change 2: a second "What to expect" line', () => {
  const CELSIUS = { name: 'Celsius WG', kind: 'herbicide', method: 'spot_treatment', targets: [] };
  const ARENA_P = { name: 'Arena 50 WDG', kind: 'insecticide', method: 'spot_treatment', targets: ['Southern chinch bugs'] };
  const FEED = { name: 'LESCO 24-0-11', kind: 'fertilizer', method: 'granular_broadcast', targets: [] };
  const ctx = { visitDate: '2026-10-09', nextVisitGapDays: 30 };
  const build = (products) => v6._test.buildWhatToExpect({ treatment: { products } }, ctx, {});
  const words = (text) => String(text).trim().split(/\s+/).length;

  test('which feeding product the engine knows', () => {
    // guard for the fixtures below: the engine must classify the feed as the feeding family
    const built = buildLawnExpectations({ applications: [{ name: FEED.name }], visitDate: ctx.visitDate }, {});
    expect(built.rows.map((r) => r.id)).toContain('granular_fertilizer');
  });

  test('gate off: the weed line fills the cap and the insecticide line is lost (today)', () => {
    gateOff();
    const out = build([CELSIUS, ARENA_P]);
    expect(out.rows.map((r) => r.id)).toEqual(['herbicide_celsius']);
    expect(out.text).not.toMatch(/insects/);
  });

  test('gate on, spot insecticide: the weed line, then the insecticide row\'s visible-change sentence', () => {
    gateOn();
    const out = build([CELSIUS, ARENA_P]);
    expect(out.rows).toEqual([
      { id: 'herbicide_celsius', keys: ['visibleChange'] },
      { id: 'insecticide_curative', keys: ['visibleChange'] },
    ]);
    expect(out.text).toBe('Treated weeds stop growing within hours, then yellow or redden and die back over about 1 to 4 weeks, depending on the weed and the weather. This treatment works to stop the insects causing the damage.');
    expect(words(out.text)).toBeLessThanOrEqual(v6.FIELD_CAPS.whatToExpect);
  });

  test('gate on, no insecticide: the feeding row prints second', () => {
    gateOn();
    const out = build([CELSIUS, FEED]);
    expect(out.rows.map((r) => r.id)).toEqual(['herbicide_celsius', 'granular_fertilizer']);
    expect(out.text).toContain('Greening builds gradually as the feed releases.');
    expect(words(out.text)).toBeLessThanOrEqual(v6.FIELD_CAPS.whatToExpect);
  });

  test('gate on, both: the insecticide row wins over the feeding row', () => {
    gateOn();
    const out = build([CELSIUS, ARENA_P, FEED]);
    expect(out.rows.map((r) => r.id)).toEqual(['herbicide_celsius', 'insecticide_curative']);
  });

  test('curative insecticide row only: a spot insecticide with no target gets no insecticide line; the feeding row prints', () => {
    gateOn();
    const untargeted = { ...ARENA_P, targets: [] };
    const out = build([CELSIUS, untargeted, FEED]);
    expect(out.rows.map((r) => r.id)).toEqual(['herbicide_celsius', 'granular_fertilizer']);
    expect(out.text).not.toMatch(/insects/);
    // and with no feeding product either, the engine's own selection stands (the weed line alone)
    expect(build([CELSIUS, untargeted]).rows.map((r) => r.id)).toEqual(['herbicide_celsius']);
  });

  test('curative insecticide row only: a preventive-locked product (Acelepryn) with a target gets no insecticide line', () => {
    gateOn();
    const acelepryn = { name: 'Acelepryn Insecticide', kind: 'insecticide', method: 'spot_treatment', targets: ['Fall armyworms'] };
    const out = build([CELSIUS, acelepryn, FEED]);
    expect(out.rows.map((r) => r.id)).toEqual(['herbicide_celsius', 'granular_fertilizer']);
  });

  test('an insecticide that was not a spot row does not take the second line; the feeding row does', () => {
    gateOn();
    const out = build([CELSIUS, { ...ARENA_P, method: 'broadcast_spray' }, FEED]);
    expect(out.rows.map((r) => r.id)).toEqual(['herbicide_celsius', 'granular_fertilizer']);
  });

  test('the first row keeps its by-next-visit sentence when both lines fit the cap', () => {
    gateOn();
    // no herbicide: the insecticide row is the first row and the feeding row is the second line
    const out = build([ARENA_P, FEED]);
    expect(out.rows).toEqual([
      { id: 'insecticide_curative', keys: ['visibleChange', 'byNextVisit'] },
      { id: 'granular_fertilizer', keys: ['visibleChange'] },
    ]);
    expect(words(out.text)).toBeLessThanOrEqual(v6.FIELD_CAPS.whatToExpect);
  });

  test('the first row\'s by-next-visit sentence gives way when it would push the second line past the cap', () => {
    gateOn();
    const out = build([CELSIUS, ARENA_P]);
    expect(out.rows[0].keys).toEqual(['visibleChange']);
  });

  test('no second row to add: the engine\'s own selection stands, gate on or off', () => {
    const products = [CELSIUS];
    gateOff();
    const off = build(products);
    gateOn();
    expect(build(products)).toEqual(off);
  });

  test('every sentence is an approved row sentence, each at most the line cap, the block at most the field cap', () => {
    gateOn();
    const { MAX_LINE_WORDS } = require('../config/lawn-expectations');
    for (const products of [[CELSIUS, ARENA_P], [CELSIUS, FEED], [CELSIUS, ARENA_P, FEED]]) {
      const out = build(products);
      const rowsById = new Map(buildLawnExpectations({ applications: products.map((p) => ({ name: p.name, targets: p.targets })), visitDate: ctx.visitDate, nextVisitGapDays: 30, celsiusYtdCount: 3 }, {}).rows.map((r) => [r.id, r]));
      for (const sentence of out.sentences) expect(words(sentence.text)).toBeLessThanOrEqual(MAX_LINE_WORDS);
      for (const row of out.rows) {
        const approved = rowsById.get(row.id);
        expect(approved.approved).toBe(true);
        for (const key of row.keys) expect(approved.sentences.find((s) => s.key === key)).toBeTruthy();
      }
      expect(words(out.text)).toBeLessThanOrEqual(v6.FIELD_CAPS.whatToExpect);
    }
  });

  test('the gate-on block replays from the frozen sentences like any other (reschedule keeps the weed line)', async () => {
    gateOn();
    const built = v6.buildLawnCopyV6({ snapshot: {}, treatment: { products: [CELSIUS, ARENA_P] } }, ctx);
    expect(built.expectSentences.map((s) => s.key)).toEqual(['visibleChange', 'visibleChange']);
    expect(built.fields.whatToExpect).toMatch(/insects causing the damage\.$/);
    expect(built.stage1Expect).toBe(true);
  });

  test('the freeze marker is set only for a block built with the second line', () => {
    gateOn();
    expect(v6.buildLawnCopyV6({ snapshot: {}, treatment: { products: [CELSIUS] } }, ctx)).not.toHaveProperty('stage1Expect');
    gateOff();
    expect(v6.buildLawnCopyV6({ snapshot: {}, treatment: { products: [CELSIUS, ARENA_P] } }, ctx)).not.toHaveProperty('stage1Expect');
  });
});

// ── 3. no irrigation-settings tip beside a schedule on file ─────────────────
describe('change 3: the irrigation-settings tip', () => {
  const portal = TIPS.find((t) => t.id === 'lawn_irrigation_portal');
  const blade = TIPS.find((t) => t.id === 'lawn_sharp_blade');
  const tipOf = (t) => ({ id: t.id, copy: t.copy, source: 'library' });
  const ctxOf = (water) => ({ serviceLine: 'lawn', reportV2: { water } });

  test('the registry id the rule names is a real tip', () => {
    expect(portal).toBeTruthy();
    expect(stage1.IRRIGATION_PORTAL_TIP).toBe('lawn_irrigation_portal');
  });

  test('gate off: the same array comes back', () => {
    gateOff();
    const tips = [tipOf(portal)];
    expect(stage1.stage1TechTips(tips, ctxOf({ scheduleKind: 'runtime_only' }))).toBe(tips);
  });

  test('gate on, a runtime-only schedule (20 min): the tip is left off; the technician\'s other tip stays', () => {
    gateOn();
    const water = { scheduleKind: 'runtime_only', scheduleText: '20 min', scheduleOnFile: false };
    expect(stage1.stage1TechTips([tipOf(portal)], ctxOf(water))).toEqual([]);
    expect(stage1.stage1TechTips([tipOf(portal), tipOf(blade)], ctxOf(water))).toEqual([tipOf(blade)]);
  });

  test('gate on, weekly inches on file: the tip is left off', () => {
    gateOn();
    expect(stage1.stage1TechTips([tipOf(portal)], ctxOf({ scheduleKind: 'inches', scheduleOnFile: true }))).toEqual([]);
  });

  test('gate on, nothing on file: the tip stays (and the same array comes back)', () => {
    gateOn();
    const tips = [tipOf(portal)];
    expect(stage1.stage1TechTips(tips, ctxOf({ scheduleKind: 'none', scheduleOnFile: false }))).toBe(tips);
    expect(stage1.stage1TechTips(tips, ctxOf(null))).toBe(tips);
  });

  test('gate on, polish dark (no scheduleKind): the card\'s own flag decides', () => {
    gateOn();
    const tips = [tipOf(portal)];
    expect(stage1.stage1TechTips(tips, ctxOf({ scheduleOnFile: true }))).toEqual([]);
    expect(stage1.stage1TechTips(tips, ctxOf({ scheduleOnFile: false }))).toBe(tips);
  });

  test('a pest report is never touched', () => {
    gateOn();
    const tips = [tipOf(portal)];
    expect(stage1.stage1TechTips(tips, { serviceLine: 'pest', reportV2: { water: { scheduleKind: 'inches' } } })).toBe(tips);
  });

  test('a custom technician line is never touched', () => {
    gateOn();
    const custom = { id: 'custom', copy: 'Please keep the gate latched.', source: 'technician' };
    expect(stage1.stage1TechTips([custom], ctxOf({ scheduleKind: 'inches' }))).toEqual([custom]);
  });
});

// ── the real report builder: payload flag, PDF key, tips from your tech ─────────
function makeKnex(fixtures) {
  const knex = (table) => {
    let rows = [...(fixtures[table] || [])];
    const sortKeys = [];
    const q = {};
    const applySort = () => {
      rows = [...rows].sort((a, b) => {
        for (const { col, dir } of sortKeys) {
          const cmp = String(a[col] ?? '').localeCompare(String(b[col] ?? ''));
          if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
    };
    Object.assign(q, {
      select: () => q,
      leftJoin: () => q,
      modify(fn) { fn(q); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      where(a, b, c) {
        if (typeof a === 'function') return q;
        if (a && typeof a === 'object') {
          rows = rows.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        } else if (arguments.length === 2) {
          rows = rows.filter((r) => r[a] === b);
        } else if (arguments.length === 3) {
          rows = rows.filter((r) => {
            const left = String(r[a] ?? '');
            const right = String(c);
            if (b === '>') return left > right;
            if (b === '>=') return left >= right;
            if (b === '<') return left < right;
            if (b === '<=') return left <= right;
            return true;
          });
        }
        return q;
      },
      andWhere(a, b, c) {
        if (typeof a === 'function') {
          const likes = [];
          const sub = {
            whereRaw(_sql, params) { likes.push(String(params[0]).replace(/%/g, '').toLowerCase()); return sub; },
            orWhereRaw(_sql, params) { likes.push(String(params[0]).replace(/%/g, '').toLowerCase()); return sub; },
          };
          a(sub);
          if (likes.length) rows = rows.filter((r) => likes.some((needle) => String(r.service_type || '').toLowerCase().includes(needle)));
          return q;
        }
        return q.where(a, b, c);
      },
      whereIn(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
      whereNot(a, b) {
        if (a && typeof a === 'object') rows = rows.filter((r) => !Object.entries(a).every(([k, v]) => r[k] === v));
        else rows = rows.filter((r) => r[a] !== b);
        return q;
      },
      whereNotNull(col) { rows = rows.filter((r) => r[col] != null); return q; },
      whereNull(col) { rows = rows.filter((r) => r[col] == null); return q; },
      orderBy(col, dir = 'asc') { sortKeys.push({ col, dir }); applySort(); return q; },
      first() { return Promise.resolve(rows[0] || null); },
      columnInfo: () => Promise.resolve({}),
      catch: () => Promise.resolve(rows),
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    });
    return q;
  };
  knex.raw = (sql) => sql;
  return knex;
}

const CUSTOMER = 'cust-lawn-stage1';
const CUR = {
  id: 'la-cur', customer_id: CUSTOMER, service_record_id: 'svc-cur', confirmed_by_tech: true,
  service_date: '2026-10-08', visit_date: '2026-10-08', created_at: '2026-10-08T14:00:00Z', history_record_id: 'svc-cur',
  turf_density: 78, weed_suppression: 82, color_health: 75, stress_damage: 30,
};
const fixtures = (prefs = null) => ({
  service_products: [], property_geometries: [], property_zones: [], service_findings: [], service_photos: [],
  lawn_assessment_photos: [], lawn_water_intake_snapshots: [],
  scheduled_services: [{ id: 'ss-cur', customer_id: CUSTOMER, scheduled_date: '2026-10-08', status: 'completed', service_type: 'Lawn Care Treatment Program' }],
  property_preferences: prefs ? [{ customer_id: CUSTOMER, ...prefs }] : [], service_records: [], lawn_assessments: [CUR],
});
const tipOf = (id) => { const t = TIPS.find((x) => x.id === id); return { id: t.id, copy: t.copy, source: 'library' }; };
const lawnService = (techTips = null) => ({
  id: 'svc-cur', scheduled_service_id: 'ss-cur', customer_id: CUSTOMER, service_line: 'lawn',
  service_type: 'Lawn Care Treatment Program', service_date: '2026-10-08', completed_at: '2026-10-08T18:40:00Z',
  first_name: 'Test', last_name: 'Customer', areas_serviced: JSON.stringify(['Front Lawn']),
  structured_notes: JSON.stringify(techTips ? { techTips } : {}), service_data: JSON.stringify({}),
});

describe('payload flag, PDF key and tips on the real report builder (in-memory reader)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    history.installedForVisit.mockResolvedValue(CUR);
    history.historyForReport.mockResolvedValue({ current: CUR, rows: [CUR], identity: 'h', eligibleVisitIds: [], isBaseline: true });
    history.historyForAssessment.mockResolvedValue({ current: CUR, rows: [CUR], identity: 'h', eligibleVisitIds: [], isBaseline: true });
    require('../services/llm/call').dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'no_key' });
  });

  test('gate off: no lawnStage1Fixes key; gate on: the lawn payload gains the flag', async () => {
    gateOff();
    const off = await buildReportV1Data(lawnService(), 'tok-s1', makeKnex(fixtures()), {});
    expect('lawnStage1Fixes' in off).toBe(false);
    gateOn();
    const on = await buildReportV1Data(lawnService(), 'tok-s1', makeKnex(fixtures()), {});
    expect(on.lawnStage1Fixes).toBe(true);
  });

  test('gate on, a pest report: no flag', async () => {
    gateOn();
    const pest = { ...lawnService(), service_line: 'pest', service_type: 'Quarterly Pest Control' };
    const data = await buildReportV1Data(pest, 'tok-s1', makeKnex(fixtures()), {});
    expect('lawnStage1Fixes' in data).toBe(false);
  });

  test('gate on changes nothing else in a lawn payload that has no pest target, no spot insecticide, no tip', async () => {
    gateOff();
    const off = await buildReportV1Data(lawnService(), 'tok-s1', makeKnex(fixtures()), {});
    gateOn();
    const { lawnStage1Fixes, ...on } = await buildReportV1Data(lawnService(), 'tok-s1', makeKnex(fixtures()), {});
    expect(lawnStage1Fixes).toBe(true);
    expect(JSON.parse(JSON.stringify(on))).toEqual(JSON.parse(JSON.stringify(off)));
  });

  test('the lawn PDF cache signature moves only while the gate is live; a pest signature never moves', async () => {
    const sig = async (line) => (await resolveCanonicalLawnRender(
      { id: 'svc-cur', customer_id: CUSTOMER, service_line: line, service_date: '2026-10-08' },
      makeKnex(fixtures()),
    )).signature;
    gateOff();
    const off = await sig('lawn');
    expect(await sig('lawn')).toBe(off);
    gateOn();
    expect(await sig('lawn')).not.toBe(off);
    expect(await sig('pest')).toBe('');
    expect(await sig('tree_shrub')).toBe('');
    gateOff();
    expect(await sig('lawn')).toBe(off);
  });

  test('gate off, a record whose frozen v6 copy carries the stage 1 second line: the PDF key still moves; one without it does not', async () => {
    const notes = (entry) => JSON.stringify({ lawnCopyV6: { 'la-cur': entry } });
    const sig = async (structuredNotes) => (await resolveCanonicalLawnRender(
      { id: 'svc-cur', customer_id: CUSTOMER, service_line: 'lawn', service_date: '2026-10-08', structured_notes: structuredNotes },
      makeKnex(fixtures()),
    )).signature;
    gateOff();
    const plain = await sig(notes({ v: 1, assessmentId: 'la-cur' }));
    const frozen = await sig(notes({ v: 1, assessmentId: 'la-cur', stage1Expect: true }));
    expect(frozen).not.toBe(plain);
    expect(await sig(undefined)).toBe(plain);
    gateOn();
    // live gate and gate off with the frozen marker are different documents (the damage card), so different keys
    expect(await sig(notes({ v: 1, assessmentId: 'la-cur', stage1Expect: true }))).not.toBe(frozen);
  });

  describe('tips from your tech beside a 20-minute schedule on file', () => {
    const RUNTIME = { irrigation_run_minutes: 20, irrigation_system: true };
    const tips = [tipOf('lawn_irrigation_portal')];
    const build = (prefs, techTips) => buildReportV1Data(lawnService(techTips), 'tok-s1', makeKnex(fixtures(prefs)), {});

    test('the card says a runtime-only schedule is on file (the polish gate\'s state B)', async () => {
      process.env[POLISH] = 'true';
      const data = await build(RUNTIME, tips);
      expect(data.reportV2.water).toMatchObject({ scheduleKind: 'runtime_only', scheduleText: '20 min', scheduleOnFile: false });
    });

    test('gate off: the contradiction stands (tip beside "schedule on file")', async () => {
      process.env[TECH_TIPS] = 'true';
      process.env[POLISH] = 'true';
      gateOff();
      const data = await build(RUNTIME, tips);
      expect(data.techNote.tips.map((t) => t.id)).toEqual(['lawn_irrigation_portal']);
    });

    test('gate on: the tip is left off and, with no other tip, there is no tips note', async () => {
      process.env[TECH_TIPS] = 'true';
      process.env[POLISH] = 'true';
      gateOn();
      const data = await build(RUNTIME, tips);
      expect(data.techNote).toBeNull();
    });

    test('gate on, nothing on file: the tip stays', async () => {
      process.env[TECH_TIPS] = 'true';
      process.env[POLISH] = 'true';
      gateOn();
      const data = await build(null, tips);
      expect(data.reportV2.water.scheduleKind).toBe('none');
      expect(data.techNote.tips.map((t) => t.id)).toEqual(['lawn_irrigation_portal']);
    });
  });
});
