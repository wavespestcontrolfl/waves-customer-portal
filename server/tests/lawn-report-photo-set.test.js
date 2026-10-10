// GATE_LAWN_REPORT_PHOTO_SET (lawn report rebuild P23) on the lawn report: the
// visit's photos as a labeled set in shot order, only for a visit captured under
// the shot list (the stored photoVocabulary marker), only while the gate is live.
// Gate off, or a visit with no marker, is the payload and PDF key this report has
// always had. Real report builder over an in-memory reader; synthetic data only.

jest.mock('../services/lawn-assessment-history', () => ({
  installedForVisit: jest.fn(),
  historyForReport: jest.fn(),
  historyForAssessment: jest.fn(),
  restrictVisitHistory: (query) => query,
}));
jest.mock('../services/service-report/lawn-report-v2', () => {
  const actual = jest.requireActual('../services/service-report/lawn-report-v2');
  return { ...actual, buildLawnReportV2: jest.fn(actual.buildLawnReportV2) };
});
jest.mock('../services/llm/call', () => {
  const actual = jest.requireActual('../services/llm/call');
  return { ...actual, dispatchWithFallback: jest.fn() };
});

const history = require('../services/lawn-assessment-history');
const { dispatchWithFallback } = require('../services/llm/call');
const { buildReportV1Data, resolveCanonicalLawnRender } = require('../services/service-report/report-data');
const { buildLawnPhotoSet, UNTAGGED_LABEL } = require('../services/service-report/lawn-photo-set');
const shots = require('../services/lawn-photo-shots');
const featureGates = require('../config/feature-gates');

function makeKnex(fixtures, failTables = [], failFirst = {}) {
  const remaining = { ...failFirst };
  const knex = (table) => {
    // failTables: every read of the table fails; failFirst: only the first N reads fail.
    const failing = failTables.includes(table) || (remaining[table] > 0 && (remaining[table] -= 1, true));
    let rows = failing ? [] : [...(fixtures[table] || [])];
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
          // the lawn/turf service-type scope: whereRaw('LOWER(service_type) LIKE ?')
          const likes = [];
          const sub = {
            whereRaw(_sql, params) { likes.push(String(params[0]).replace(/%/g, '').toLowerCase()); return sub; },
            orWhereRaw(_sql, params) { likes.push(String(params[0]).replace(/%/g, '').toLowerCase()); return sub; },
          };
          a(sub);
          if (likes.length) {
            rows = rows.filter((r) => likes.some((needle) => String(r.service_type || '').toLowerCase().includes(needle)));
          }
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
      first() { return failing ? Promise.reject(new Error('read failed')) : Promise.resolve(rows[0] || null); },
      columnInfo: () => Promise.resolve({}),
      catch: (fn) => (failing ? Promise.resolve(fn(new Error('read failed'))) : Promise.resolve(rows)),
      then: (resolve, reject) => (failing ? Promise.reject(new Error('read failed')) : Promise.resolve(rows)).then(resolve, reject),
    });
    return q;
  };
  knex.raw = (sql) => sql;
  return knex;
}




const CUSTOMER = 'cust-lawn-p23';
const MARKER = [{ filename: 'a.jpg', photoVocabulary: shots.PHOTO_VOCABULARY }, { filename: 'b.jpg', photoVocabulary: shots.PHOTO_VOCABULARY }];
const LEGACY_META = [{ filename: 'a.jpg' }, { filename: 'b.jpg' }];
const curRow = (photos) => ({
  id: 'la-cur', customer_id: CUSTOMER, service_record_id: 'svc-cur', confirmed_by_tech: true,
  service_date: '2026-09-30', visit_date: '2026-09-30', created_at: '2026-09-30T14:00:00Z', history_record_id: 'svc-cur',
  turf_density: 78, weed_suppression: 82, color_health: 75, stress_damage: 30, photos,
});
// Captured in this order on purpose: not shot order, and the best photo is not first.
const CAPTURE = ['trouble', 'close_up', 'front', 'trouble', 'blade_crown', 'back'];
const photoRows = () => CAPTURE.map((zone, i) => ({
  id: `ph-${i}`, assessment_id: 'la-cur', customer_visible: true, zone, photo_type: 'general',
  is_best_photo: i === 2, quality_score: 70 + i, photo_order: i, s3_key: `lawn/ph-${i}.jpg`,
}));
const fixtures = (cur, photos = photoRows(), runs = []) => ({
  service_products: [], property_geometries: [], property_zones: [], service_findings: [], service_photos: [],
  lawn_assessment_photos: photos, lawn_water_intake_snapshots: [],
  scheduled_services: [{ id: 'ss-cur', customer_id: CUSTOMER, scheduled_date: '2026-09-30', status: 'completed', service_type: 'Lawn Care Treatment Program' }],
  property_preferences: [], service_records: [], lawn_assessments: [cur], lawn_assessment_runs: runs,
});
const service = () => ({
  id: 'svc-cur', scheduled_service_id: 'ss-cur', customer_id: CUSTOMER, service_line: 'lawn',
  service_type: 'Lawn Care Treatment Program', service_date: '2026-09-30', completed_at: '2026-09-30T18:40:00Z',
  first_name: 'Test', last_name: 'Customer', areas_serviced: JSON.stringify(['Front Lawn']),
  structured_notes: JSON.stringify({}), service_data: JSON.stringify({}),
});

describe('GATE_LAWN_REPORT_PHOTO_SET on the lawn report payload', () => {
  const saved = { set: process.env.GATE_LAWN_REPORT_PHOTO_SET, shots: process.env.GATE_LAWN_SHOT_LIST, findings: process.env.GATE_LAWN_REPORT_PHOTO_FINDINGS };
  let cur;
  beforeEach(() => {
    jest.clearAllMocks();
    cur = curRow(MARKER);
    history.installedForVisit.mockImplementation(async () => cur);
    history.historyForReport.mockImplementation(async () => ({ current: cur, rows: [cur], identity: 'h', eligibleVisitIds: [], isBaseline: true }));
    history.historyForAssessment.mockImplementation(async () => ({ current: cur, rows: [cur], identity: 'h', eligibleVisitIds: [], isBaseline: true }));
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'no_key' });
    jest.spyOn(require('../services/photos'), 'getViewUrl').mockImplementation(async (key) => `https://example.test/signed/${key}?sig=fresh`);
    delete process.env.GATE_LAWN_REPORT_PHOTO_SET;
    delete process.env.GATE_LAWN_REPORT_PHOTO_FINDINGS;
    process.env.GATE_LAWN_SHOT_LIST = 'true';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const [name, value] of [['GATE_LAWN_REPORT_PHOTO_SET', saved.set], ['GATE_LAWN_SHOT_LIST', saved.shots], ['GATE_LAWN_REPORT_PHOTO_FINDINGS', saved.findings]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  const render = async (failTables = [], failFirst = {}) => buildReportV1Data(service(), 'token-p23', makeKnex(fixtures(cur), failTables, failFirst), {});
  const snapshotOf = (data) => JSON.stringify({ lawnAssessment: data.lawnAssessment, reportV2: data.reportV2, photos: data.photos });

  test('the gate reader is strict: only the exact string true', () => {
    for (const value of [undefined, '', '1', 'on', 'TRUE', 'false']) {
      if (value === undefined) delete process.env.GATE_LAWN_REPORT_PHOTO_SET; else process.env.GATE_LAWN_REPORT_PHOTO_SET = value;
      expect(featureGates.lawnReportPhotoSetLive()).toBe(false);
    }
    process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
    expect(featureGates.lawnReportPhotoSetLive()).toBe(true);
  });

  test('gate off: a marked visit has no photoSet key and the payload is byte-identical to an unmarked visit', async () => {
    const marked = await render();
    expect(Object.prototype.hasOwnProperty.call(marked.lawnAssessment, 'photoSet')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(marked.reportV2, 'photoSet')).toBe(false);
    cur = curRow(LEGACY_META);
    const unmarked = await render();
    expect(snapshotOf(marked)).toBe(snapshotOf(unmarked));
  });

  test('gate on, visit with no marker: byte-identical to the gate off payload', async () => {
    cur = curRow(LEGACY_META);
    const off = await render();
    process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
    const on = await render();
    expect(snapshotOf(on)).toBe(snapshotOf(off));
    expect(Object.prototype.hasOwnProperty.call(on.reportV2, 'photoSet')).toBe(false);
  });

  test('gate on, marked visit: the set is in shot order with the fixed customer labels', async () => {
    process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
    const data = await render();
    const expected = [
      { shot: 'front', label: 'Front yard', url: 'https://example.test/signed/lawn/ph-2.jpg?sig=fresh' },
      { shot: 'back', label: 'Back yard', url: 'https://example.test/signed/lawn/ph-5.jpg?sig=fresh' },
      { shot: 'close_up', label: 'Close-up', url: 'https://example.test/signed/lawn/ph-1.jpg?sig=fresh' },
      { shot: 'blade_crown', label: 'Blade close-up', url: 'https://example.test/signed/lawn/ph-4.jpg?sig=fresh' },
      { shot: 'trouble', label: 'Trouble spot', url: 'https://example.test/signed/lawn/ph-0.jpg?sig=fresh' },
      { shot: 'trouble', label: 'Trouble spot', url: 'https://example.test/signed/lawn/ph-3.jpg?sig=fresh' },
    ];
    expect(data.reportV2.photoSet).toEqual(expected);
    expect(data.lawnAssessment.photoSet).toEqual(expected);
    // Nothing else in the report changed: the strip and the findings are the same.
    process.env.GATE_LAWN_REPORT_PHOTO_SET = '';
    const off = await render();
    const { photoSet: _a, ...onV2 } = data.reportV2;
    expect(JSON.stringify(onV2)).toBe(JSON.stringify(off.reportV2));
  });

  test('every set URL is signed again on each view, never stored', async () => {
    process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
    const photoService = require('../services/photos');
    photoService.getViewUrl.mockImplementation(async (key, ttl) => `https://example.test/${key}?ttl=${ttl}&n=${photoService.getViewUrl.mock.calls.length}`);
    const first = await render();
    const second = await render();
    expect(second.reportV2.photoSet[0].url).not.toBe(first.reportV2.photoSet[0].url);
    expect(first.reportV2.photoSet[0].url).toContain(`ttl=${photoService.CUSTOMER_DWELL_TTL_SECONDS}`);
  });

  test('a failed photo read leaves the key off (the old strip rules), never a broken block', async () => {
    process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
    const data = await render(['lawn_assessment_photos']);
    expect(Object.prototype.hasOwnProperty.call(data.lawnAssessment, 'photoSet')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(data.reportV2, 'photoSet')).toBe(false);
  });

  test('only the initial photo read fails: no set, and the view is counted uncacheable (the gallery read still works)', async () => {
    const baseline = await render();
    process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
    const data = await render([], { lawn_assessment_photos: 1 });
    expect(Object.prototype.hasOwnProperty.call(data.reportV2, 'photoSet')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(data.lawnAssessment, 'photoSet')).toBe(false);
    // The scenario: the gallery copies loaded fine, so only the new count can tell.
    expect(data.photos.some((p) => String(p.id).startsWith('lawn-'))).toBe(true);
    expect(data.imageResolutionFailures).toBeGreaterThan(baseline.imageResolutionFailures);
    // After recovery the set is back and nothing is counted.
    const recovered = await render();
    expect(recovered.reportV2.photoSet).toHaveLength(CAPTURE.length);
    expect(recovered.imageResolutionFailures).toBe(baseline.imageResolutionFailures);
  });

  test('a failed photo read on a visit that is not eligible counts nothing (gate off, or no marker)', async () => {
    const baseline = await render();
    const gateOff = await render([], { lawn_assessment_photos: 1 });
    expect(gateOff.imageResolutionFailures).toBe(baseline.imageResolutionFailures);
    process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
    cur = curRow(LEGACY_META);
    const unmarked = await render([], { lawn_assessment_photos: 1 });
    expect(unmarked.imageResolutionFailures).toBe(baseline.imageResolutionFailures);
  });

  test('a set built for the visit that does not reach the report (the V2 build fails soft) is counted uncacheable', async () => {
    const baseline = await render();
    process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
    require('../services/service-report/lawn-report-v2').buildLawnReportV2.mockImplementationOnce(() => { throw new Error('v2 build failed'); });
    const data = await render();
    expect(data.reportV2).toBeNull();
    expect(data.lawnAssessment.photoSet.length).toBe(CAPTURE.length);
    expect(data.imageResolutionFailures).toBeGreaterThan(baseline.imageResolutionFailures);
  });

  test('one photo that will not sign withholds the whole set and counts as an image failure (all or nothing)', async () => {
    const photoService = require('../services/photos');
    const baseline = await render();
    process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
    // Fails only for the set's own signing pass; the gallery pass for the same
    // photo may succeed, which is exactly why the count must not rely on it.
    let failedOnce = false;
    photoService.getViewUrl.mockImplementation(async (key) => {
      if (key === 'lawn/ph-2.jpg' && !failedOnce) { failedOnce = true; throw new Error('sign failed'); }
      return `https://example.test/signed/${key}?sig=fresh`;
    });
    const data = await render();
    expect(Object.prototype.hasOwnProperty.call(data.reportV2, 'photoSet')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(data.lawnAssessment, 'photoSet')).toBe(false);
    expect(data.imageResolutionFailures).toBeGreaterThanOrEqual(1);
    // The failure count never reaches the public payload as a key of its own.
    expect(Object.keys(data.lawnAssessment)).not.toContain('photoSetUnresolved');
    // A clean render counts nothing.
    photoService.getViewUrl.mockImplementation(async (key) => `https://example.test/signed/${key}?sig=fresh`);
    const clean = await render();
    expect(clean.reportV2.photoSet).toHaveLength(CAPTURE.length);
    expect(clean.imageResolutionFailures).toBe(baseline.imageResolutionFailures);
  });

  describe('with the capture gate (GATE_LAWN_SHOT_LIST) off or rolled back', () => {
    const EIGHT = ['front', 'back', 'side', 'close_up', 'blade_crown', 'hot_edge', 'shade', 'trouble'];
    const eightRows = () => EIGHT.map((zone, i) => ({
      id: `ph-${i}`, assessment_id: 'la-cur', customer_visible: true, zone, photo_type: 'general',
      is_best_photo: i === 0, quality_score: 90 - i, photo_order: i, s3_key: `lawn/ph-${i}.jpg`,
    }));
    const renderEight = async () => buildReportV1Data(service(), 'token-p23', makeKnex(fixtures(cur, eightRows())), {});
    beforeEach(() => { delete process.env.GATE_LAWN_SHOT_LIST; });

    test('set gate on, marked visit: all eight photos reach the set', async () => {
      process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
      const data = await renderEight();
      expect(data.reportV2.photoSet.map((p) => p.shot)).toEqual(EIGHT);
      expect(data.reportV2.photoSet).toHaveLength(8);
    });

    test('set gate on, visit with no marker: the old five-photo limit and the old payload', async () => {
      cur = curRow(LEGACY_META);
      const off = await renderEight();
      process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
      const on = await renderEight();
      expect(on.lawnAssessment.photos).toHaveLength(5);
      expect(snapshotOf(on)).toBe(snapshotOf(off));
    });

    test('set gate off, marked visit: still the five-photo limit, no photoSet', async () => {
      const data = await renderEight();
      expect(data.lawnAssessment.photos).toHaveLength(5);
      expect(Object.prototype.hasOwnProperty.call(data.reportV2, 'photoSet')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(data.lawnAssessment.photos[0], 'zoneLabel')).toBe(false);
    });
  });

  describe('"What the photos showed" (photoFindings)', () => {
    // Both gates on, and a weed score that puts the weed card at "watch" (the
    // damage card is already at "needs_attention" with the default stress score).
    beforeEach(() => {
      process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
      process.env.GATE_LAWN_REPORT_PHOTO_FINDINGS = 'true';
      cur = { ...curRow(MARKER), weed_suppression: 55 };
    });
    // ph-2 front, ph-5 back, ph-1 close_up, ph-4 blade_crown, ph-0 and ph-3 trouble.
    const RUN_PHOTO_IDS = ['ph-2', 'ph-5', 'ph-1', 'ph-4', 'ph-0', 'ph-3'];
    const reviewed = (over = []) => over.length ? over : [
      { label: 'weed pressure', severity: 'moderate', keep: true, can_determine: true, photo_refs: [3, 1], observed_evidence: ['STORED TEXT'] },
      { label: 'general lawn stress', severity: 'mild', keep: true, can_determine: false, photo_refs: [2], cannot_determine_reason: 'STORED REASON' },
    ];
    const runRow = (over = {}) => ({
      assessment_id: 'la-cur', customer_id: CUSTOMER, reviewed_at: '2026-09-30T15:00:00Z', photo_ids: RUN_PHOTO_IDS, reviewed_findings: reviewed(), ...over,
    });
    const renderRun = async ({ runs = [runRow()], opts = { lawnPhotoFindings: true }, failTables = [], reads = [], photos = photoRows() } = {}) => {
      const inner = makeKnex(fixtures(cur, photos, runs), failTables);
      const knex = (table) => { reads.push(table); return inner(table); };
      knex.raw = inner.raw;
      return buildReportV1Data(service(), 'token-p23', knex, opts);
    };

    test('gate on + marked + confirmed reviewed run: each finding with the photos it cites, from the signed set', async () => {
      process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
      const data = await renderRun();
      const url = (key) => `https://example.test/signed/lawn/${key}.jpg?sig=fresh`;
      expect(data.reportV2.photoFindings).toEqual([
        { label: 'Weed pressure', photos: [{ url: url('ph-1'), label: 'Close-up' }, { url: url('ph-2'), label: 'Front yard' }] },
        // this visit already has a blade close-up and trouble photos, so no shot is missing to name
        { label: 'General lawn stress', photos: [{ url: url('ph-5'), label: 'Back yard' }] },
      ]);
      // the unfiltered block never reaches the public assessment object
      expect(Object.keys(data.lawnAssessment)).not.toContain('photoFindings');
      expect(JSON.stringify(data.lawnAssessment)).not.toContain('Weed pressure');
      // every thumbnail is a photo of the set
      const setUrls = data.reportV2.photoSet.map((p) => p.url);
      for (const finding of data.reportV2.photoFindings) for (const photo of finding.photos) expect(setUrls).toContain(photo.url);
      expect(JSON.stringify(data.reportV2.photoFindings)).not.toMatch(/STORED/);
    });

    test('a visit with only the minimum shots: the undetermined finding names the shot that would confirm it', async () => {
      process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
      const minimum = photoRows().filter((row) => ['front', 'back', 'close_up'].includes(row.zone));
      const ids = minimum.map((row) => row.id);
      const data = await renderRun({
        photos: minimum,
        runs: [runRow({ photo_ids: ids, reviewed_findings: [{ label: 'general lawn stress', severity: 'mild', keep: true, can_determine: false, photo_refs: [1, 2] }] })],
      });
      expect(data.reportV2.photoFindings).toHaveLength(1);
      expect(data.reportV2.photoFindings[0].confirm).toBe('The photos from this visit cannot confirm this. A blade close-up photo would let us confirm it.');
    });

    test('the block never contradicts a card: a strong weed card hides the weed finding, a concerned one shows it', async () => {
      cur = { ...curRow(MARKER), weed_suppression: 95 };
      const strong = await renderRun();
      expect(strong.reportV2.diagnosis.find((c) => c.key === 'weed_pressure').status).toBe('strong');
      expect(strong.reportV2.photoFindings.map((f) => f.label)).toEqual(['General lawn stress']);
      cur = { ...curRow(MARKER), weed_suppression: 55 };
      const watch = await renderRun();
      expect(watch.reportV2.diagnosis.find((c) => c.key === 'weed_pressure').status).toBe('watch');
      expect(watch.reportV2.photoFindings.map((f) => f.label)).toEqual(['Weed pressure', 'General lawn stress']);
    });

    test('every finding hidden by its card: the key is an empty list, nothing prints, and it is not counted as a failure', async () => {
      cur = { ...curRow(MARKER), weed_suppression: 95, stress_damage: 95 };
      const baseline = await renderRun({ runs: [] });
      const data = await renderRun();
      expect(data.reportV2.photoFindings).toEqual([]);
      expect(data.imageResolutionFailures).toBe(baseline.imageResolutionFailures);
    });

    test('named-cause labels from the run never reach the block', async () => {
      const data = await renderRun({
        runs: [runRow({ reviewed_findings: [
          { label: 'chinch bug activity', severity: 'severe', keep: true, can_determine: true, photo_refs: [1] },
          { label: 'gray leaf spot', severity: 'severe', keep: true, can_determine: true, photo_refs: [1] },
          { label: 'weed pressure', severity: 'mild', keep: true, can_determine: true, photo_refs: [1] },
        ] })],
      });
      expect(data.reportV2.photoFindings.map((f) => f.label)).toEqual(['Weed pressure']);
    });

    test('NEW GATE OFF (photo set on): no run read at all, and the payload equals the one without the opt-in', async () => {
      delete process.env.GATE_LAWN_REPORT_PHOTO_FINDINGS;
      const reads = [];
      const withOptIn = await renderRun({ reads });
      const without = await renderRun({ opts: {} });
      expect(reads).not.toContain('lawn_assessment_runs');
      expect(Object.prototype.hasOwnProperty.call(withOptIn.reportV2, 'photoFindings')).toBe(false);
      expect(withOptIn.reportV2.photoSet).toHaveLength(CAPTURE.length);
      expect(snapshotOf(withOptIn)).toBe(snapshotOf(without));
      expect(withOptIn.imageResolutionFailures).toBe(without.imageResolutionFailures);
    });

    test('NEW GATE ON WITHOUT the photo set gate: no block, no run read', async () => {
      delete process.env.GATE_LAWN_REPORT_PHOTO_SET;
      const reads = [];
      const data = await renderRun({ reads });
      expect(Object.prototype.hasOwnProperty.call(data.reportV2, 'photoFindings')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(data.reportV2, 'photoSet')).toBe(false);
      expect(reads).not.toContain('lawn_assessment_runs');
    });

    test('opt-in: without it the key is absent and the run table is never read', async () => {
      process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
      const reads = [];
      const data = await renderRun({ opts: {}, reads });
      expect(Object.prototype.hasOwnProperty.call(data.reportV2, 'photoFindings')).toBe(false);
      expect(data.reportV2.photoSet).toHaveLength(CAPTURE.length);
      expect(reads).not.toContain('lawn_assessment_runs');
    });

    test('gate off, or a visit with no marker: byte-identical payload and the run table is never read', async () => {
      delete process.env.GATE_LAWN_REPORT_PHOTO_SET;
      delete process.env.GATE_LAWN_REPORT_PHOTO_FINDINGS;
      const reads = [];
      const offBaseline = await renderRun({ opts: {} });
      const off = await renderRun({ reads });
      expect(snapshotOf(off)).toBe(snapshotOf(offBaseline));
      expect(reads).not.toContain('lawn_assessment_runs');
      process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
      process.env.GATE_LAWN_REPORT_PHOTO_FINDINGS = 'true';
      cur = curRow(LEGACY_META);
      const unmarkedReads = [];
      const unmarked = await renderRun({ reads: unmarkedReads });
      expect(Object.prototype.hasOwnProperty.call(unmarked.reportV2, 'photoFindings')).toBe(false);
      expect(unmarkedReads).not.toContain('lawn_assessment_runs');
    });

    test('an unreviewed run, a run of another assessment or no run: set still shows, no block, nothing counted', async () => {
      process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
      const baseline = await renderRun({ runs: [] });
      for (const runs of [[], [runRow({ reviewed_at: null })], [runRow({ assessment_id: 'la-superseded' })], [runRow({ reviewed_findings: [{ label: 'invented', keep: true }] })]]) {
        const data = await renderRun({ runs });
        expect(Object.prototype.hasOwnProperty.call(data.reportV2, 'photoFindings')).toBe(false);
        expect(data.reportV2.photoSet).toHaveLength(CAPTURE.length);
        expect(data.imageResolutionFailures).toBe(baseline.imageResolutionFailures);
      }
    });

    test('a failed run read omits the block, keeps the set, and counts as an image failure (no cached PDF)', async () => {
      process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
      const baseline = await renderRun();
      const data = await renderRun({ failTables: ['lawn_assessment_runs'] });
      expect(Object.prototype.hasOwnProperty.call(data.reportV2, 'photoFindings')).toBe(false);
      expect(data.reportV2.photoSet).toHaveLength(CAPTURE.length);
      expect(data.imageResolutionFailures).toBeGreaterThan(baseline.imageResolutionFailures);
      expect(Object.keys(data.lawnAssessment)).not.toContain('photoFindingsUnresolved');
    });

    test('a block built but lost before the report is counted as an image failure', async () => {
      process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
      const baseline = await renderRun();
      require('../services/service-report/lawn-report-v2').buildLawnReportV2.mockImplementationOnce(() => { throw new Error('v2 build failed'); });
      const data = await renderRun();
      expect(data.reportV2).toBeNull();
      expect(data.imageResolutionFailures).toBeGreaterThan(baseline.imageResolutionFailures);
    });

    test('a withheld set (one photo would not sign) means no block either', async () => {
      process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
      let failedOnce = false;
      require('../services/photos').getViewUrl.mockImplementation(async (key) => {
        if (key === 'lawn/ph-2.jpg' && !failedOnce) { failedOnce = true; throw new Error('sign failed'); }
        return `https://example.test/signed/${key}`;
      });
      const data = await renderRun();
      expect(Object.prototype.hasOwnProperty.call(data.reportV2, 'photoSet')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(data.reportV2, 'photoFindings')).toBe(false);
    });
  });

  describe('the PDF cache key follows the run\'s reviewed findings', () => {
    beforeEach(() => {
      process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
      process.env.GATE_LAWN_REPORT_PHOTO_FINDINGS = 'true';
    });

    const runRow = (over = {}) => ({
      assessment_id: 'la-cur', customer_id: CUSTOMER, reviewed_at: '2026-09-30T15:00:00Z', photo_ids: ['ph-2', 'ph-1'],
      reviewed_findings: [{ label: 'weed pressure', severity: 'moderate', keep: true, can_determine: true, photo_refs: [1] }], ...over,
    });
    const sig = async (runs) => (await resolveCanonicalLawnRender(
      { id: 'svc-cur', customer_id: CUSTOMER, service_line: 'lawn', service_date: '2026-09-30' },
      makeKnex(fixtures(cur, photoRows(), runs)),
    )).signature;

    test('a visit with a block is stamped, and the stamp moves when the findings change', async () => {
      process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
      const noRun = await sig([]);
      const a = await sig([runRow()]);
      expect(a).not.toBe(noRun);
      expect(await sig([runRow()])).toBe(a);
      expect(await sig([runRow({ reviewed_findings: [{ label: 'thinning turf', severity: 'moderate', keep: true, photo_refs: [1] }] })])).not.toBe(a);
      expect(await sig([runRow({ reviewed_findings: [{ label: 'weed pressure', severity: 'moderate', keep: true, photo_refs: [2] }] })])).not.toBe(a);
    });

    test('a visit that would print no block keeps the key it has without a run', async () => {
      process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
      const noRun = await sig([]);
      expect(await sig([runRow({ reviewed_at: null })])).toBe(noRun);
      expect(await sig([runRow({ reviewed_findings: [{ label: 'no major visible stress', keep: true, photo_refs: [1] }] })])).toBe(noRun);
      expect(await sig([runRow({ assessment_id: 'la-superseded' })])).toBe(noRun);
    });

    test('gate off, or a visit with no marker: the run never changes the key', async () => {
      delete process.env.GATE_LAWN_REPORT_PHOTO_SET;
      delete process.env.GATE_LAWN_REPORT_PHOTO_FINDINGS;
      const off = await sig([]);
      expect(await sig([runRow()])).toBe(off);
      process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
      cur = curRow(LEGACY_META);
      const unmarkedOn = await sig([]);
      expect(await sig([runRow()])).toBe(unmarkedOn);
    });

    test('NEW GATE OFF (photo set on): the run is never read and the key is the one the photo set gate alone gives', async () => {
      delete process.env.GATE_LAWN_REPORT_PHOTO_FINDINGS;
      const reads = [];
      const inner = makeKnex(fixtures(cur, photoRows(), [runRow()]));
      const knex = (table) => { reads.push(table); return inner(table); };
      knex.raw = inner.raw;
      const withRun = (await resolveCanonicalLawnRender({ id: 'svc-cur', customer_id: CUSTOMER, service_line: 'lawn', service_date: '2026-09-30' }, knex)).signature;
      expect(reads).not.toContain('lawn_assessment_runs');
      expect(withRun).toBe(await sig([]));
      expect(withRun).toBe(await sig([runRow({ reviewed_findings: [{ label: 'thinning turf', keep: true, photo_refs: [2] }] })]));
    });

    test('an unreadable run read fails the signature closed (the caller then uses its unique token)', async () => {
      process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
      await expect(resolveCanonicalLawnRender(
        { id: 'svc-cur', customer_id: CUSTOMER, service_line: 'lawn', service_date: '2026-09-30' },
        makeKnex(fixtures(cur), ['lawn_assessment_runs']),
      )).rejects.toThrow();
    });
  });

  describe('the PDF cache key', () => {
    const sig = async () => (await resolveCanonicalLawnRender(
      { id: 'svc-cur', customer_id: CUSTOMER, service_line: 'lawn', service_date: '2026-09-30' },
      makeKnex(fixtures(cur)),
    )).signature;

    test('gate on + marked visit: stamped, and back to the old key when the gate goes off', async () => {
      const off = await sig();
      expect(await sig()).toBe(off);
      process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
      expect(await sig()).not.toBe(off);
      delete process.env.GATE_LAWN_REPORT_PHOTO_SET;
      expect(await sig()).toBe(off);
    });

    test('gate on + unmarked visit: identical to the gate off key (no re-key of legacy PDFs)', async () => {
      cur = curRow(LEGACY_META);
      const off = await sig();
      process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
      expect(await sig()).toBe(off);
    });

    test('gate on + stored photo metadata that cannot be read: no stamp', async () => {
      cur = curRow('not json');
      const off = await sig();
      process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
      expect(await sig()).toBe(off);
      cur = curRow(null);
      expect(await sig()).toBe(off);
    });
  });
});

describe('buildLawnPhotoSet', () => {
  const row = (zone, order, url = `https://example.test/${zone}-${order}.jpg`) => ({ zone, photoOrder: order, url });

  test('orders by shot, then by the technician order inside a shot', () => {
    const set = buildLawnPhotoSet([row('trouble', 5), row('shade', 1), row('front', 3), row('trouble', 2), row('hot_edge', 0)]);
    expect(set.map((p) => [p.shot, p.url.split('/').pop()])).toEqual([
      ['front', 'front-3.jpg'], ['hot_edge', 'hot_edge-0.jpg'], ['shade', 'shade-1.jpg'], ['trouble', 'trouble-2.jpg'], ['trouble', 'trouble-5.jpg'],
    ]);
  });

  test('every label is the shared customer label, never the technician name', () => {
    const set = buildLawnPhotoSet(shots.SHOT_KEYS.map((key, i) => row(key, i)));
    expect(set.map((p) => p.label)).toEqual(shots.SHOTS.map((s) => s.reportLabel));
  });

  test('a side photo is captioned Side yard and a back photo keeps Back yard', () => {
    const set = buildLawnPhotoSet([row('side', 0), row('back', 1)]);
    expect(set.map((p) => [p.shot, p.label])).toEqual([['back', 'Back yard'], ['side', 'Side yard']]);
  });

  test('an untagged or unknown-zone photo goes last with a plain label', () => {
    const set = buildLawnPhotoSet([row(null, 0), row('mystery', 1), row('close_up', 2)]);
    expect(set.map((p) => p.shot)).toEqual(['close_up', null, null]);
    expect(set.slice(1).map((p) => p.label)).toEqual([UNTAGGED_LABEL, UNTAGGED_LABEL]);
  });

  test('a photo with no link is dropped, and a non-array gives an empty set', () => {
    expect(buildLawnPhotoSet([row('front', 0, null), row('back', 1, '')])).toEqual([]);
    expect(buildLawnPhotoSet(null)).toEqual([]);
    expect(buildLawnPhotoSet(undefined)).toEqual([]);
  });
});

describe('carriesShotListMarker', () => {
  test('true only for the explicit marker, as an array or JSON text', () => {
    expect(shots.carriesShotListMarker(MARKER)).toBe(true);
    expect(shots.carriesShotListMarker(JSON.stringify(MARKER))).toBe(true);
    expect(shots.carriesShotListMarker(LEGACY_META)).toBe(false);
    expect(shots.carriesShotListMarker(null)).toBe(false);
    expect(shots.carriesShotListMarker('not json')).toBe(false);
    expect(shots.carriesShotListMarker([{ photoVocabulary: 'something_else' }])).toBe(false);
  });
});

describe('GATE_LAWN_PHOTO_LABEL_PICK on the photo set labels', () => {
  const rows = [
    { url: 'https://example.test/a.jpg', zone: 'shade', photoOrder: 0, pickedLabel: 'Close-up' },
    { url: 'https://example.test/b.jpg', zone: 'front', photoOrder: 1 },
  ];

  test('a picked label replaces the slot wording but the photo keeps its slot and its place in shot order', () => {
    expect(buildLawnPhotoSet(rows)).toEqual([
      { url: 'https://example.test/b.jpg', shot: 'front', label: 'Front yard' },
      { url: 'https://example.test/a.jpg', shot: 'shade', label: 'Close-up' },
    ]);
  });

  test('no pickedLabel key: the set is exactly what it has always been', () => {
    const plain = rows.map(({ pickedLabel: _drop, ...row }) => row);
    expect(buildLawnPhotoSet(plain).map((p) => p.label)).toEqual(['Front yard', 'Shaded area']);
  });
});
