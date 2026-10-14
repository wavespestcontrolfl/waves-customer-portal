// Calibration replay for the lawn progress engine (P13). Synthetic fixture and
// a fake knex; no database, never run against production.

// The DB loader pairs through the report's canonical history; here it is a fake.
jest.mock('../services/lawn-assessment-history', () => ({ historyForAssessment: jest.fn() }));
const { historyForAssessment } = require('../services/lawn-assessment-history');

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  pairAssessments,
  replayLawnProgress,
  formatReport,
  loadReplayRows,
  main,
} = require('../scripts/replay-lawn-progress');

const S = (over = {}) => ({
  turf_density: 70, weed_suppression: 70, color_health: 70, stress_damage: 70, overall: 70, ...over,
});

// Synthetic customers only (A..E).
const FIXTURE = [
  // A: baseline, then a good month, then a visit whose photos cannot support a comparison.
  { id: 'a0000001', customerId: 'cust-a', propertyId: 'prop-a', date: '2026-04-01', season: 'peak', isBaseline: true, scores: S(), photos: [80, 80], applied: [{ name: 'Celsius WG' }, { name: 'LESCO 24-0-11' }] },
  { id: 'a0000002', customerId: 'cust-a', propertyId: 'prop-a', date: '2026-05-01', season: 'peak', scores: S({ weed_suppression: 85, color_health: 85, overall: 78 }), photos: [80, 80, 55], applied: [] },
  { id: 'a0000003', customerId: 'cust-a', propertyId: 'prop-a', date: '2026-06-20', season: 'peak', scores: S({ color_health: 60, overall: 66 }), photos: [30], applied: [] },
  // B: winter to spring, color down, granular and an iron spray applied in winter (granular builds no
  // item since 2026-10-03; the iron spray is the color metric the season change is judged on).
  { id: 'b0000001', customerId: 'cust-b', propertyId: 'prop-b', date: '2026-01-10', season: 'dormant', scores: S(), photos: [80, 80], applied: [{ name: 'LESCO 24-0-11' }, { name: 'LESCO Chelated Iron Plus' }, { name: 'Brand New Product' }] },
  { id: 'b0000002', customerId: 'cust-b', propertyId: 'prop-b', date: '2026-03-01', season: 'shoulder', scores: S({ color_health: 50, overall: 60 }), photos: [80, 80], applied: [] },
  // C: two visits two days apart, no photo evidence on the second.
  { id: 'c0000001', customerId: 'cust-c', propertyId: 'prop-c', date: '2026-05-01', season: 'peak', scores: S(), photos: [80, 80], applied: [{ name: 'Celsius WG' }] },
  { id: 'c0000002', customerId: 'cust-c', propertyId: 'prop-c', date: '2026-05-03', season: 'peak', scores: S({ weed_suppression: 30, overall: 60 }), applied: [] },
  // D: one assessment, nothing to compare.
  { id: 'd0000001', customerId: 'cust-d', propertyId: 'prop-d', date: '2026-05-01', season: 'peak', scores: S(), photos: [80, 80], applied: [{ name: 'Celsius WG' }] },
  // E: a month after a herbicide the weeds have not moved, a large swing in density, models disagreed on color.
  { id: 'e0000001', customerId: 'cust-e', propertyId: 'prop-e', date: '2026-06-01', season: 'peak', scores: S(), photos: [80, 80, 80], applied: [{ name: 'Celsius WG' }, { name: 'LESCO K-Flow 0-0-25' }] },
  { id: 'e0000002', customerId: 'cust-e', propertyId: 'prop-e', date: '2026-07-01', season: 'peak', scores: S({ turf_density: 35, overall: 55 }), photos: [80, 80, 80], divergenceFlags: [{ metric: 'color_health', gap: 40 }], applied: [] },
];

describe('pairAssessments', () => {
  it('pairs each assessment with the latest strictly earlier one at the same customer and property', () => {
    const pairs = pairAssessments(FIXTURE);
    const prior = Object.fromEntries(pairs.map((p) => [p.current.id, p.prior?.id || null]));
    expect(prior['a0000001']).toBeNull();
    expect(prior['a0000002']).toBe('a0000001');
    expect(prior['a0000003']).toBe('a0000002');
    expect(prior['d0000001']).toBeNull();
  });

  it('never pairs across customers or properties, and a same-day row is not a prior', () => {
    const rows = [
      { id: 'x1', customerId: 'c1', propertyId: 'p1', date: '2026-05-01', scores: S() },
      { id: 'x2', customerId: 'c1', propertyId: 'p2', date: '2026-06-01', scores: S() },
      { id: 'x3', customerId: 'c2', propertyId: 'p1', date: '2026-06-01', scores: S() },
      { id: 'x4', customerId: 'c1', propertyId: 'p1', date: '2026-05-01', order: 'b', scores: S() },
    ];
    const prior = Object.fromEntries(pairAssessments(rows).map((p) => [p.current.id, p.prior?.id || null]));
    expect(prior).toEqual({ x1: null, x2: null, x3: null, x4: null });
  });
});

describe('replayLawnProgress over the fixture', () => {
  const result = replayLawnProgress(FIXTURE);
  const { summary: s, oddities: o } = result;

  it('counts assessments, first visits, baselines and compared pairs', () => {
    expect(s.assessments).toBe(10);
    expect(s.noPrior).toBe(4); // b1, c1, d1, e1 are first visits
    expect(s.baseline).toBe(1); // a1
    expect(s.pairs).toBe(5);
  });

  it('reports the distribution of states, confidence levels and directions', () => {
    expect(Object.keys(s.itemStates)).toEqual(['improving', 'on_track', 'holding_steady', 'too_early', 'behind', 'unclear', 'seasonal']);
    expect(s.confidence).toEqual({ moderate: 1, insufficient: 1, high: 2, unknown: 1 });
    const total = Object.values(s.itemStates).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    expect(Object.values(s.overall).reduce((a, b) => a + b, 0)).toBe(5);
  });

  it('a2: a good month after the herbicide and feed: Celsius is on track, and the granular feed (no progress window) builds no item', () => {
    const a2 = result.pairs.find((p) => p.assessment === 'a0000002');
    expect(a2).toBeTruthy();
    // Granular color and density were judged until 2026-10-03; their day counts were unsourced.
    expect(a2.items.map((i) => `${i.item}=${i.state}`)).toEqual(['herbicide_celsius:weed_suppression=on_track']);
  });

  it('a3: one poor photo cannot support a comparison, so everything is unclear and the direction unknown', () => {
    const a3 = result.pairs.find((p) => p.date === '2026-06-20');
    expect(a3.confidence).toBe('insufficient');
    expect(a3.overall).toBe('unknown');
  });

  it('b2: winter color change is seasonal and the unmapped name is listed', () => {
    const b2 = result.pairs.find((p) => p.date === '2026-03-01');
    expect(b2.items.map((i) => i.item)).toEqual(['iron_micros:color_health']);
    expect(b2.items[0].state).toBe('seasonal');
    expect(o.unmappedProducts).toEqual({ 'Brand New Product': 1 });
  });

  it('flags the oddities a person should read before sign-off', () => {
    expect(o.invariantViolations).toEqual([]);
    expect(o.shortGap.map((r) => r.date)).toEqual(['2026-05-03']);
    expect(o.confidenceUnknown.map((r) => r.date)).toEqual(['2026-05-03']);
    expect(o.scoreSwing.map((r) => r.date)).toContain('2026-05-03'); // weed_suppression -40
    expect(o.scoreSwing.map((r) => r.date)).toContain('2026-07-01'); // turf_density -35
    expect(o.noMappedProducts.map((r) => r.date)).toEqual(['2026-06-20']);
  });

  it('a divergent metric is unclear while the rest of the pair compares (e2 color)', () => {
    const e2 = result.pairs.find((p) => p.date === '2026-07-01');
    // Celsius (weeds, 30 days, delta 0) is behind; the feed row has no windows (K-Flow) and is judged by its own metric
    expect(e2.items.find((i) => i.item === 'herbicide_celsius:weed_suppression').state).toBe('behind');
    expect(e2.items.find((i) => i.item === 'potassium_feed:color_health').state).toBe('unclear');
  });

  it('reports the behind share of judged items and warns above a quarter', () => {
    expect(s.judgedItems).toBeGreaterThan(0);
    expect(s.behindShare).toBeGreaterThan(0.25);
    expect(s.behindAboveLine).toBe(true);
    expect(formatReport(result)).toMatch(/WARNING: behind is above 25% of judged items/);
    expect(formatReport(result)).not.toMatch(/widen the dead-band/);
    expect(formatReport(result)).toMatch(/wider band makes gain-mode rows MORE likely to be behind/);
  });

  it('the band sweep reports each band, and the default band matches the summary', () => {
    expect(result.bandSweep.map((b) => b.band)).toEqual([4, 6, 8, 10, 12]);
    for (const b of result.bandSweep) expect(b.behindShare).toBeGreaterThanOrEqual(0);
    expect(result.bandSweep.find((b) => b.band === 8).behindShare).toBe(s.behindShare);
  });

  it('a wider band is passed through', () => {
    const wide = replayLawnProgress(FIXTURE, { band: 12, overallBand: 6 });
    expect(wide.summary).toMatchObject({ band: 12, overallBand: 6 });
  });

  it('since limits which visits are judged but still uses earlier ones as priors', () => {
    const recent = replayLawnProgress(FIXTURE, { since: '2026-06-15' });
    expect(recent.summary.assessments).toBe(2); // a3 and e2
    expect(recent.pairs.map((p) => p.date)).toEqual(['2026-06-20', '2026-07-01']);
  });

  it('an empty list is a clean empty report', () => {
    const empty = replayLawnProgress([]);
    expect(empty.summary).toMatchObject({ assessments: 0, pairs: 0, judgedItems: 0, behindShare: 0, behindAboveLine: false });
    expect(formatReport(empty)).toMatch(/Assessments 0/);
  });

  it('prints a readable report with states, gates and oddities, and names no customer', () => {
    const text = formatReport(result);
    expect(text).toMatch(/Lawn progress replay \(band 8 per category, 4 overall\)/);
    expect(text).toMatch(/Item states \(\d+ items\)/);
    expect(text).toMatch(/seasonal\s+\d+/);
    expect(text).toMatch(/Band sweep/);
    expect(text).toMatch(/unmapped product names 1: Brand New Product/);
    expect(text).not.toMatch(/cust-[a-e]/);
  });
});

describe('main with --fixture (no database)', () => {
  let file;
  beforeEach(() => {
    file = path.join(os.tmpdir(), `lawn-progress-replay-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({ assessments: FIXTURE }));
  });
  afterEach(() => { try { fs.unlinkSync(file); } catch { /* already gone */ } });

  const capture = async (argv) => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await main(argv, {});
      return log.mock.calls.map((c) => c[0]).join('\n');
    } finally {
      log.mockRestore();
    }
  };

  it('prints the text report', async () => {
    const out = await capture(['--fixture', file]);
    expect(out).toMatch(/Lawn progress replay/);
    expect(out).toMatch(/compared pairs 5/);
  });

  it('prints JSON with --json, and the band flags reach the engine', async () => {
    const out = JSON.parse(await capture(['--fixture', file, '--json', '--band', '10', '--overall-band', '5']));
    expect(out.summary).toMatchObject({ band: 10, overallBand: 5, pairs: 5 });
    expect(out.bandSweep).toHaveLength(5);
  });

  it('accepts a bare array fixture', async () => {
    fs.writeFileSync(file, JSON.stringify(FIXTURE));
    expect(await capture(['--fixture', file])).toMatch(/compared pairs 5/);
  });

  it('an invariant violation would set a failing exit code (none here)', async () => {
    const before = process.exitCode;
    await capture(['--fixture', file]);
    expect(process.exitCode).toBe(before);
  });
});

describe('loadReplayRows', () => {
  it('runs only SELECTs inside a READ ONLY transaction and shapes the rows', async () => {
    const calls = [];
    const trx = {
      raw: jest.fn(async (sql, params) => {
        calls.push({ sql, params });
        if (/FROM lawn_assessments/.test(sql)) {
          return {
            rows: [{
              id: 'a1', customer_id: 'c1', property_id: 'p1', date: '2026-05-01', season: 'peak', is_baseline: false,
              service_record_id: 'r1', divergence_flags: '[{"metric":"color_health","gap":30}]',
              turf_density: 80, weed_suppression: 60, color_health: 70, fungus_control: 50, thatch_level: 40, stress_damage: null,
              overall_score: null, confirmed_order: '2026-05-01T12:00:00.000000',
            }],
          };
        }
        if (/FROM lawn_assessment_photos/.test(sql)) {
          return {
            rows: [
              { assessment_id: 'a1', quality_score: '80.00' },
              { assessment_id: 'a1', quality_score: null },
              // Legacy row: quality_score is a lawn-health blend, judged by its gate.
              { assessment_id: 'a1', quality_score: '31.00', turf_density: 20, quality_gate_passed: true },
            ],
          };
        }
        if (/FROM service_products/.test(sql)) return { rows: [{ service_record_id: 'r1', product_name: 'Celsius WG', targets: ['Clover'] }] };
        return { rows: [] };
      }),
    };
    const db = { transaction: jest.fn(async (fn, opts) => fn(trx, opts)) };
    historyForAssessment.mockReset();
    historyForAssessment.mockResolvedValue({ current: { id: 'a1', visit_date: '2026-05-01' }, rows: [{ id: 'a1', visit_date: '2026-05-01', service_record_id: 'r1' }], previous: null, isBaseline: false });
    const rows = await loadReplayRows(db);
    expect(historyForAssessment).toHaveBeenCalledWith({ id: 'a1', customer_id: 'c1' }, { knex: trx });
    expect(db.transaction.mock.calls[0][1]).toEqual({ readOnly: true });
    expect(calls[0].sql).toMatch(/SET TRANSACTION READ ONLY/);
    expect(calls.slice(1).every((c) => /^\s*SELECT/.test(c.sql))).toBe(true);
    expect(calls.filter((c) => /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i.test(c.sql))).toEqual([]);
    expect(rows).toEqual([{
      id: 'a1',
      customerId: 'c1',
      propertyId: 'p1',
      date: '2026-05-01',
      season: 'peak',
      isBaseline: false,
      scores: { turf_density: 80, weed_suppression: 60, color_health: 70, stress_damage: 40, overall: expect.any(Number) },
      photos: ['80.00', null, 'limited'],
      photosTrustingLegacy: ['80.00', null, 'adequate'],
      divergenceFlags: [{ metric: 'color_health', gap: 30 }],
      // Shaped like the frozen visit memory (appliedFromProducts).
      applied: [{ name: 'Celsius WG', activeIngredient: null, kind: 'other', tag: 'lawn treatment', targets: ['Clover'] }],
      order: '2026-05-01T12:00:00.000000',
      priorId: null,
      superseded: false,
    }]);
  });

  it('a visit that froze its memory replays the frozen entry, not the live products or live prior', async () => {
    const row = (id, date, rec) => ({
      id, customer_id: 'c1', property_id: 'p1', date, season: 'peak', is_baseline: false, service_record_id: rec, divergence_flags: null,
      turf_density: 70, weed_suppression: 70, color_health: 70, fungus_control: 70, thatch_level: 70, stress_damage: 70, overall_score: 70, confirmed_order: '',
    });
    const FROZEN_SINCE = { v: 1, priorAssessmentId: 'v1', priorDate: '2026-05-01', applied: [{ name: 'Celsius WG', targets: [] }], checks: [] };
    const trx = {
      raw: jest.fn(async (sql) => {
        if (/FROM lawn_assessments/.test(sql)) return { rows: [row('v1', '2026-05-01', 'r1'), row('vb', '2026-05-20', 'rb'), row('v2', '2026-06-01', 'r2')] };
        if (/FROM service_records/.test(sql)) {
          return {
            rows: [
              { id: 'r1', structured_notes: { lawnVisitMemory: { v1: { v: 1, assessmentId: 'v1', serviceDate: '2026-05-01', applied: [{ name: 'Celsius WG', targets: [] }], checks: [] } } } },
              { id: 'r2', structured_notes: { lawnVisitMemory: { v2: { v: 1, assessmentId: 'v2', serviceDate: '2026-06-01', applied: [], checks: [], sinceLast: FROZEN_SINCE } } } },
            ],
          };
        }
        // Live products were edited after the freeze: never read for a frozen visit.
        if (/FROM service_products/.test(sql)) return { rows: [{ service_record_id: 'r1', product_name: 'Atticus Talak', targets: [] }] };
        return { rows: [] };
      }),
    };
    const db = { transaction: jest.fn(async (fn, opts) => fn(trx, opts)) };
    historyForAssessment.mockReset();
    // A backfilled visit (vb) now sits between v1 and v2 in live history.
    const H = { v1: { id: 'v1', visit_date: '2026-05-01', service_record_id: 'r1' }, vb: { id: 'vb', visit_date: '2026-05-20', service_record_id: 'rb' }, v2: { id: 'v2', visit_date: '2026-06-01', service_record_id: 'r2' } };
    historyForAssessment.mockImplementation(async ({ id }) => ({ current: H[id], rows: Object.values(H), previous: null, isBaseline: id === 'v1' }));
    const rows = await loadReplayRows(db);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by.v1.applied).toEqual([{ name: 'Celsius WG', targets: [] }]);
    expect(by.v2).toMatchObject({ priorId: 'v1', frozenSinceLast: FROZEN_SINCE });
    expect(by.vb).not.toHaveProperty('frozenSinceLast');
    const result = replayLawnProgress(rows);
    const pair = result.pairs.find((p) => p.assessment === 'v2');
    expect(pair.prior).toBe('v1');
    expect(pair.days).toBe(31);
  });

  it('a frozen prior that left the visit\'s canonical history (replaced or out of scope) judges nothing', async () => {
    const row = (id, date, rec) => ({
      id, customer_id: 'c1', property_id: 'p1', date, season: 'peak', is_baseline: false, service_record_id: rec, divergence_flags: null,
      turf_density: 70, weed_suppression: 70, color_health: 70, fungus_control: 70, thatch_level: 70, stress_damage: 70, overall_score: 70, confirmed_order: '',
    });
    const trx = {
      raw: jest.fn(async (sql) => {
        if (/FROM lawn_assessments/.test(sql)) return { rows: [row('v1', '2026-05-01', 'r1'), row('v2', '2026-06-01', 'r2')] };
        if (/FROM service_records/.test(sql)) {
          return { rows: [{ id: 'r2', structured_notes: { lawnVisitMemory: { v2: { v: 1, assessmentId: 'v2', serviceDate: '2026-06-01', applied: [], checks: [], sinceLast: { v: 1, priorAssessmentId: 'v1', priorDate: '2026-05-01', applied: [{ name: 'Celsius WG', targets: [] }], checks: [] } } } } }] };
        }
        return { rows: [] };
      }),
    };
    const db = { transaction: jest.fn(async (fn, opts) => fn(trx, opts)) };
    historyForAssessment.mockReset();
    // v1 is no longer in v2's canonical history (a reset or a scope change).
    const V2 = { id: 'v2', visit_date: '2026-06-01', service_record_id: 'r2' };
    historyForAssessment.mockImplementation(async ({ id }) => (id === 'v1'
      ? { current: { id: 'v1', visit_date: '2026-05-01', service_record_id: 'r1' }, rows: [], previous: null, isBaseline: true }
      : { current: V2, rows: [V2], previous: null, isBaseline: false }));
    const rows = await loadReplayRows(db);
    expect(rows.find((r) => r.id === 'v2').priorId).toBeNull();
    expect(replayLawnProgress(rows).pairs.find((p) => p.assessment === 'v2')).toBeUndefined();
  });

  it('takes the prior, visit date and baseline from canonical history, and marks re-done attempts superseded', async () => {
    const row = (id, date) => ({
      id, customer_id: 'c1', property_id: 'p1', date, season: 'peak', is_baseline: false, service_record_id: null, divergence_flags: null,
      turf_density: 70, weed_suppression: 70, color_health: 70, fungus_control: 70, thatch_level: 70, stress_damage: 70, overall_score: 70, confirmed_order: '',
    });
    const trx = { raw: jest.fn(async (sql) => (/FROM lawn_assessments/.test(sql) ? { rows: [row('v1', '2026-05-01'), row('v2a', '2026-06-01'), row('v2b', '2026-06-02')] } : { rows: [] })) };
    const db = { transaction: jest.fn(async (fn, opts) => fn(trx, opts)) };
    historyForAssessment.mockReset();
    // v2a and v2b are two attempts of one visit (appointment 2026-06-01); v2b is installed.
    // v0 is a same-day visit before v1 (never a prior); v1x has no service record (never a prior).
    const H1 = { id: 'v1', visit_date: '2026-05-01', service_record_id: 'r-v1' };
    const H2 = { id: 'v2b', visit_date: '2026-06-01', service_record_id: 'r-v2' };
    const SAME_DAY = { id: 'v2-same', visit_date: '2026-06-01', service_record_id: 'r-same' };
    const NO_RECORD = { id: 'v1x', visit_date: '2026-05-15', service_record_id: null };
    historyForAssessment.mockImplementation(async ({ id }) => ({
      v1: { current: H1, rows: [H1], previous: null, isBaseline: true },
      v2a: { current: H2, rows: [H1, NO_RECORD, SAME_DAY, H2], previous: SAME_DAY, isBaseline: false },
      v2b: { current: H2, rows: [H1, NO_RECORD, SAME_DAY, H2], previous: SAME_DAY, isBaseline: false },
    }[id]));
    const rows = await loadReplayRows(db);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by.v1).toMatchObject({ isBaseline: true, priorId: null, superseded: false });
    expect(by.v2a).toMatchObject({ superseded: true, priorId: null });
    // The report's selector: not the same-day row, not the row with no record.
    expect(by.v2b).toMatchObject({ superseded: false, priorId: 'v1', date: '2026-06-01' });
    const pairs = pairAssessments(rows);
    expect(pairs.map((p) => [p.current.id, p.prior?.id || null])).toEqual([['v1', null], ['v2b', 'v1']]);
  });
});

describe('--trust-legacy-photos (calibration only)', () => {
  const legacyRow = (id, date, isBaseline = false) => ({
    id, customerId: 'cust-l', propertyId: 'prop-l', date, season: 'peak', isBaseline,
    scores: S(id === 'l2' ? { weed_suppression: 85 } : {}),
    photos: ['limited', 'limited'], photosTrustingLegacy: ['adequate', 'adequate'],
    applied: id === 'l1' ? [{ name: 'Celsius WG' }] : [],
  });
  const rows = [legacyRow('l1', '2026-05-01', true), legacyRow('l2', '2026-06-01')];
  it('off (the report\'s reading): legacy-only visits are low confidence, every item unclear', () => {
    const r = replayLawnProgress(rows);
    expect(r.summary.trustLegacyPhotos).toBe(false);
    expect(r.summary.itemStates.unclear).toBeGreaterThan(0);
    expect(r.summary.judgedItems).toBe(0);
  });
  it('on: the pass reads as adequate, items are judged, and the report header says so', () => {
    const r = replayLawnProgress(rows, { trustLegacyPhotos: true });
    expect(r.summary.trustLegacyPhotos).toBe(true);
    expect(r.summary.judgedItems).toBeGreaterThan(0);
    expect(formatReport(r)).toMatch(/ASSUMPTION --trust-legacy-photos/);
  });
});

describe('the real history resolver never loads the ambient database (codex r5 on #5566)', () => {
  it('requiring it and keying an address never loads models/db.js, knexfile or customer-properties', () => {
    jest.isolateModules(() => {
      jest.doMock('../models/db', () => { throw new Error('models/db.js must not be loaded'); });
      jest.doMock('../knexfile', () => { throw new Error('knexfile.js must not be loaded'); });
      jest.doMock('../services/customer-properties', () => { throw new Error('customer-properties.js loads models/db'); });
      const history = jest.requireActual('../services/lawn-assessment-history');
      const row = {
        id: 'a1', customer_id: 'c1', confirmed_by_tech: true, history_address_line1: '100 Example St', history_city: 'Testville', history_zip: '34000',
      };
      const scope = { customerId: 'c1', propertyId: 'p1', propertyAddressKey: 'nomatch', includeUnlinked: true };
      expect(history.isEligible(row, scope)).toBe(false); // address key compared, no database touched
    });
  });
});

describe('connection handling', () => {
  it('requiring the engine and the replay script never loads models/db.js or knexfile.js', () => {
    jest.isolateModules(() => {
      jest.doMock('../models/db', () => { throw new Error('models/db.js must not be loaded'); });
      jest.doMock('../knexfile', () => { throw new Error('knexfile.js must not be loaded'); });
      expect(() => {
        require('../services/service-report/lawn-progress');
        require('../scripts/replay-lawn-progress');
      }).not.toThrow();
      const loaded = Object.keys(require.cache).filter((k) => /models[\\/]db\.js$|knexfile\.js$/.test(k));
      expect(loaded).toEqual([]);
    });
  });

  it('main builds its own connection from --database-url, ahead of DATABASE_URL, and always closes it', async () => {
    const trx = { raw: jest.fn(async () => ({ rows: [] })) };
    const instance = { transaction: jest.fn(async (fn) => fn(trx)), destroy: jest.fn(async () => {}) };
    const knexFactory = jest.fn(() => instance);
    let run;
    jest.isolateModules(() => {
      jest.doMock('knex', () => knexFactory);
      jest.doMock('../models/db', () => { throw new Error('models/db.js must not be loaded'); });
      ({ main: run } = require('../scripts/replay-lawn-progress'));
    });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run(['--database-url', 'postgres://flag-host/flagdb'], { DATABASE_URL: 'postgres://env-host/envdb' });
    } finally {
      log.mockRestore();
    }
    expect(knexFactory).toHaveBeenCalledTimes(1);
    expect(knexFactory.mock.calls[0][0].connection.connectionString).toBe('postgres://flag-host/flagdb');
    expect(instance.destroy).toHaveBeenCalled();
  });

  it('refuses to run with no database at all', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(main([], {})).rejects.toThrow(/No database/);
    } finally {
      err.mockRestore();
    }
  });
});
