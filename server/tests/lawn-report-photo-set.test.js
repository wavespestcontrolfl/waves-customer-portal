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

function makeKnex(fixtures, failTables = []) {
  const knex = (table) => {
    const failing = failTables.includes(table);
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
const fixtures = (cur, photos = photoRows()) => ({
  service_products: [], property_geometries: [], property_zones: [], service_findings: [], service_photos: [],
  lawn_assessment_photos: photos, lawn_water_intake_snapshots: [],
  scheduled_services: [{ id: 'ss-cur', customer_id: CUSTOMER, scheduled_date: '2026-09-30', status: 'completed', service_type: 'Lawn Care Treatment Program' }],
  property_preferences: [], service_records: [], lawn_assessments: [cur],
});
const service = () => ({
  id: 'svc-cur', scheduled_service_id: 'ss-cur', customer_id: CUSTOMER, service_line: 'lawn',
  service_type: 'Lawn Care Treatment Program', service_date: '2026-09-30', completed_at: '2026-09-30T18:40:00Z',
  first_name: 'Test', last_name: 'Customer', areas_serviced: JSON.stringify(['Front Lawn']),
  structured_notes: JSON.stringify({}), service_data: JSON.stringify({}),
});

describe('GATE_LAWN_REPORT_PHOTO_SET on the lawn report payload', () => {
  const saved = { set: process.env.GATE_LAWN_REPORT_PHOTO_SET, shots: process.env.GATE_LAWN_SHOT_LIST };
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
    process.env.GATE_LAWN_SHOT_LIST = 'true';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const [name, value] of [['GATE_LAWN_REPORT_PHOTO_SET', saved.set], ['GATE_LAWN_SHOT_LIST', saved.shots]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  const render = async (failTables = []) => buildReportV1Data(service(), 'token-p23', makeKnex(fixtures(cur), failTables), {});
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

  test('a photo whose link would not sign is left out, the rest still show', async () => {
    process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
    require('../services/photos').getViewUrl.mockImplementation(async (key) => {
      if (key === 'lawn/ph-2.jpg') throw new Error('sign failed');
      return `https://example.test/${key}`;
    });
    const data = await render();
    expect(data.reportV2.photoSet.map((p) => p.shot)).toEqual(['back', 'close_up', 'blade_crown', 'trouble', 'trouble']);
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

  test('the PDF cache key moves only while the gate is live, for any visit', async () => {
    const sig = async () => (await resolveCanonicalLawnRender(
      { id: 'svc-cur', customer_id: CUSTOMER, service_line: 'lawn', service_date: '2026-09-30' },
      makeKnex(fixtures(cur)),
    )).signature;
    const off = await sig();
    expect(await sig()).toBe(off);
    process.env.GATE_LAWN_REPORT_PHOTO_SET = 'true';
    expect(await sig()).not.toBe(off);
    delete process.env.GATE_LAWN_REPORT_PHOTO_SET;
    expect(await sig()).toBe(off);
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
