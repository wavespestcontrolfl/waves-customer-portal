// GATE_LAWN_REPORT_COPY_V6 (lawn report rebuild P14) through the real report
// builder (buildReportV1Data) and the reconcile pass. Fixed sentences, no
// model (owner 2026-10-02); the shared dispatcher is mocked so no production
// LLM API is called by the report's other lanes. Synthetic data only.
//
// Pins: gate off (or lead gate off) = no write, no key, the same payload and
// PDF signature as before; gate on = the fields freeze at the first render
// (first writer wins per assessment) and reach the customer only through
// reportV2.lead (the carrier never leaves the process); a later render replays
// byte for byte whatever the facts now say; a degraded read creates no freeze.

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
const { applyLawnReportReconciliation } = require('../services/service-report/report-consistency');
const { storedLawnCopyV6For } = require('../services/service-report/lawn-copy-v6');
const { buildTreatmentSummary } = require('../services/service-report/treatment-summary');

const FAIL = Symbol('table read fails');
function makeKnex(fixtures) {
  const knex = (table) => {
    const failing = fixtures[table] === FAIL;
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


// service_records: an in-memory table with the freeze's semantics (the real SQL
// runs in lawn-visit-memory-postgres.test.js); every other table is the generic
// fixture reader above.
function withRecords(fixtures, records, hooks = {}) {
  const generic = makeKnex(fixtures);
  const log = { reads: [], updates: [] };
  const knex = (table) => {
    if (table !== 'service_records') return generic(table);
    const ctx = { where: {}, binding: null };
    const chain = {
      where(cond) { Object.assign(ctx.where, cond); return chain; },
      whereRaw(_sql, bindings) { ctx.binding = bindings?.[0] ?? null; return chain; },
      async update(patch) {
        const sql = patch.structured_notes?.__raw || '';
        if (!sql.includes('lawnCopyV6')) return 1; // week-weather / other freezes: out of scope here
        if (hooks.failUpdate) throw new Error('update failed');
        const rec = records[ctx.where.id];
        if (!rec) return 0;
        const map = (rec.structured_notes && rec.structured_notes.lawnCopyV6) || {};
        if (map[ctx.binding] != null) return 0;
        const add = JSON.parse(patch.structured_notes.bindings[0]);
        rec.structured_notes = { ...rec.structured_notes, lawnCopyV6: { ...map, ...add } };
        log.updates.push(add);
        return 1;
      },
      async first() {
        log.reads.push({ ...ctx.where });
        const rec = records[ctx.where.id];
        return rec ? { structured_notes: rec.structured_notes } : undefined;
      },
    };
    return chain;
  };
  knex.raw = (sql, bindings) => ({ __raw: sql, bindings });
  return { knex, log };
}


const CUSTOMER = 'cust-lawn-p14';
const SCORES = { turf_density: 78, weed_suppression: 82, color_health: 75, stress_damage: 30 };
const CUR = {
  id: 'la-cur', customer_id: CUSTOMER, service_record_id: 'svc-cur', confirmed_by_tech: true,
  service_date: '2026-09-30', visit_date: '2026-09-30', created_at: '2026-09-30T14:00:00Z', history_record_id: 'svc-cur', ...SCORES,
};
const fixtures = () => ({
  service_products: [{ id: 'sp-1', service_record_id: 'svc-cur', product_name: 'Test Herbicide B', product_category: 'herbicide', created_at: '2026-09-30T18:00:00Z' }],
  property_geometries: [], property_zones: [], service_findings: [], service_photos: [], lawn_assessment_photos: [],
  lawn_water_intake_snapshots: [],
  scheduled_services: [{ id: 'ss-cur', customer_id: CUSTOMER, scheduled_date: '2026-09-30', status: 'completed', service_type: 'Lawn Care Treatment Program' }],
  property_preferences: [],
  lawn_assessments: [CUR],
});
const service = (notes = {}) => ({
  id: 'svc-cur', scheduled_service_id: 'ss-cur', customer_id: CUSTOMER, service_line: 'lawn',
  service_type: 'Lawn Care Treatment Program', service_date: '2026-09-30', completed_at: '2026-09-30T18:40:00Z',
  first_name: 'Test', last_name: 'Customer', areas_serviced: JSON.stringify(['Front Lawn']),
  structured_notes: JSON.stringify(notes), service_data: JSON.stringify({}),
});

const WEEK = { assessmentId: 'la-cur', serviceDate: '2026-09-30', rainInches: 1, et0Inches: 1, dailyRain: [], rainConfidence: 'high' };
const NARRATIVE_LANE = 'lawn_visit_narratives';
const narrativeCalls = () => dispatchWithFallback.mock.calls.filter(([, payload]) => payload && payload.laneId === NARRATIVE_LANE);

describe('GATE_LAWN_REPORT_COPY_V6 on the report payload', () => {
  const ENV = ['GATE_LAWN_REPORT_COPY_V6', 'GATE_LAWN_REPORT_LEAD', 'LAWN_REPORT_V2_NARRATIVE'];
  const saved = {};
  beforeEach(() => {
    ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
    jest.clearAllMocks();
    history.installedForVisit.mockResolvedValue(CUR);
    history.historyForReport.mockResolvedValue({ current: CUR, rows: [CUR], identity: 'h', eligibleVisitIds: [], isBaseline: true });
    history.historyForAssessment.mockResolvedValue({ current: CUR, rows: [CUR], identity: 'h', eligibleVisitIds: [], isBaseline: true });
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'no_key' });
  });
  afterEach(() => { ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

  const records = () => ({ 'svc-cur': { structured_notes: { lawnWeekWeather: { 'la-cur': WEEK } } } });
  const render = (recs, patch = {}, svc = service(recs['svc-cur'].structured_notes), hooks) => {
    const { knex, log } = withRecords({ ...fixtures(), ...patch }, recs, hooks);
    return buildReportV1Data(svc, 'token-p14', knex, {}).then((data) => ({ data, log }));
  };
  const live = () => { process.env.GATE_LAWN_REPORT_COPY_V6 = 'true'; process.env.GATE_LAWN_REPORT_LEAD = 'true'; };
  // The hand-off is non-enumerable (a clone would drop it): reconcile a shallow copy, as the route does.
  const reconciled = (data) => applyLawnReportReconciliation({ ...data }, null);

  test('gate off: no write, no key, and the payload is what it was', async () => {
    const recs = records();
    const { data, log } = await render(recs);
    expect(log.updates).toHaveLength(0);
    expect(recs['svc-cur'].structured_notes.lawnCopyV6).toBeUndefined();
    expect(data.reportV2.copyV6).toBeUndefined();
    expect(JSON.stringify(reconciled(data))).not.toMatch(/copyV6|lawnCopyV6/);
  });

  test('the v6 gate alone (lead gate off) is inert: byte-identical payload, no write', async () => {
    const base = (await render(records())).data;
    process.env.GATE_LAWN_REPORT_COPY_V6 = 'true';
    const recs = records();
    const { data, log } = await render(recs);
    expect(log.updates).toHaveLength(0);
    expect(JSON.parse(JSON.stringify(data))).toEqual(JSON.parse(JSON.stringify(base)));
  });

  test('while v6 is live the old narrative overlay does not run, even with LAWN_REPORT_V2_NARRATIVE set, and no model is asked for lead copy', async () => {
    process.env.LAWN_REPORT_V2_NARRATIVE = 'true';
    live();
    await render(records());
    expect(narrativeCalls()).toHaveLength(0);
  });

  test('gate on: the first render freezes the fixed sentences once and the lead carries them; the carrier never leaves the payload', async () => {
    live();
    const recs = records();
    const { data, log } = await render(recs);
    expect(log.updates).toHaveLength(1);
    const frozen = storedLawnCopyV6For(recs['svc-cur'].structured_notes, 'la-cur');
    // Fixed sentences from this visit's facts; today's expectation table has no
    // approved row, so whatToExpect is null.
    expect(frozen.fields.headline).toBe(data.reportV2.snapshot.statusHeadline);
    expect(frozen.fields.whatWeDid).toBe(buildTreatmentSummary(data.reportV2.treatment, { noTiming: true }));
    expect(frozen.fields.whatWeDid).toBeTruthy();
    expect(frozen.fields.whatToExpect).toBeNull();
    expect(frozen.copyVersion).toBe('lawn_report_v6_fixed_1');
    expect(data.reportV2.copyV6).toEqual(frozen.fields);
    const out = reconciled(data);
    expect(out.reportV2.lead.headline).toBe(frozen.fields.headline);
    expect(out.reportV2.lead.applied).toBe(frozen.fields.whatWeDid);
    expect(Object.keys(out.reportV2.lead)).not.toContain('whatToExpect');
    expect(Object.prototype.hasOwnProperty.call(out.reportV2, 'copyV6')).toBe(false);
    expect(JSON.stringify(out)).not.toContain('copyV6');
    expect(Object.keys(data.reportV2)).not.toContain('copyV6');
    expect(data.lawnAssessment.weekWeatherUncacheable).toBe(false);
  });

  test('a later render replays byte for byte, whatever the visit facts now say', async () => {
    live();
    const recs = records();
    const first = (await render(recs)).data;
    const edited = { service_products: [{ id: 'sp-2', service_record_id: 'svc-cur', product_name: 'Test Fertilizer C', product_category: 'fertilizer', created_at: '2026-09-30T19:00:00Z' }] };
    const again = (await render(recs, edited, service(recs['svc-cur'].structured_notes))).data;
    expect(JSON.stringify(again.reportV2.copyV6)).toBe(JSON.stringify(first.reportV2.copyV6));
  });

  test('a frozen headline replaces the live status line, so a later assessment correction cannot reach the lead fallback or the PDF', async () => {
    live();
    const recs = records();
    await render(recs);
    // The record froze an older headline (the assessment was corrected since).
    recs['svc-cur'].structured_notes.lawnCopyV6['la-cur'].fields.headline = 'Stable — watching watering';
    const { data } = await render(recs, {}, service(recs['svc-cur'].structured_notes));
    expect(data.reportV2.snapshot.statusHeadline).toBe('Stable — watching watering');
    // Under a watering banner the lead drops the watering headline; its
    // fallback is now the same frozen line, never the corrected one.
    const banner = { state: 'hold', lines: ['Skip your turf watering until Thu 3 PM.'] };
    const { deriveLawnLead } = require('../services/service-report/lawn-report-lead');
    const withBanner = deriveLawnLead({ ...data.reportV2, banner }, { copyV6: data.reportV2.copyV6 });
    expect([null, 'Stable — watching watering']).toContain(withBanner.headline);
  });

  test('a failed freeze serves the copy and marks the render uncacheable', async () => {
    live();
    const { data } = await render(records(), {}, undefined, { failUpdate: true });
    expect(data.reportV2.copyV6.headline).toBe(data.reportV2.snapshot.statusHeadline);
    expect(data.lawnAssessment.weekWeatherUncacheable).toBe(true);
  });

  test('a degraded read (a failed service_products read) creates no freeze and ships the lead\'s own copy; recovery freezes', async () => {
    live();
    const recs = records();
    const { data, log } = await render(recs, { service_products: FAIL });
    expect(log.updates).toHaveLength(0);
    expect(recs['svc-cur'].structured_notes.lawnCopyV6).toBeUndefined();
    // An all-null carrier: the lead keeps the snapshot headline and shows no
    // applied line rather than the AI narrative in snapshot.treatmentSummary.
    expect(data.reportV2.copyV6).toEqual({ headline: null, whatWeDid: null, whatToExpect: null, watching: null });
    expect(data.lawnAssessment.weekWeatherUncacheable).toBe(true);
    data.reportV2.snapshot.treatmentSummary = 'An AI narrative paragraph.';
    const lead = reconciled(data).reportV2.lead;
    expect(lead.headline).toBe(data.reportV2.snapshot.statusHeadline);
    expect(lead.applied).toBeNull();
    const next = await render(recs);
    expect(storedLawnCopyV6For(recs['svc-cur'].structured_notes, 'la-cur')).toBeTruthy();
    expect(next.data.lawnAssessment.weekWeatherUncacheable).toBe(false);
  });

  test('a frozen entry still replays when a later read fails (the treatment check never hides stored copy)', async () => {
    live();
    const recs = records();
    const first = (await render(recs)).data;
    const { data } = await render(recs, { service_products: FAIL }, service(recs['svc-cur'].structured_notes));
    expect(JSON.stringify(data.reportV2.copyV6)).toBe(JSON.stringify(first.reportV2.copyV6));
    expect(reconciled(data).reportV2.lead.applied).toBe(first.reportV2.copyV6.whatWeDid);
  });

  describe('the next-visit gap counts only for this visit\'s property', () => {
    // The builder only takes scheduled dates after today's ET date: pin today
    // (Date only; timers stay real) so the 2027 fixture always qualifies.
    beforeEach(() => {
      jest.useFakeTimers({
        now: new Date('2026-10-02T16:00:00Z'),
        doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
      });
    });
    afterEach(() => { jest.useRealTimers(); });
    const HOME_A = { service_address_line1: '100 Test Palm Way', service_address_city: 'Bradenton', service_address_zip: '34201' };
    const HOME_B = { service_address_line1: '200 Sample Oak Ln', service_address_city: 'Sarasota', service_address_zip: '34232' };
    const gapFor = async (nextStamp, extraRows = [], patch = {}) => {
      live();
      const v6 = require('../services/service-report/lawn-copy-v6');
      const spy = jest.spyOn(v6, 'resolveLawnCopyV6ForRender').mockResolvedValue({ copy: null, unfrozen: true });
      try {
        await render(records(), {
          scheduled_services: [
            { id: 'ss-cur', customer_id: CUSTOMER, scheduled_date: '2026-09-30', status: 'completed', service_type: 'Lawn Care Treatment Program', ...HOME_A },
            { id: 'ss-next', customer_id: CUSTOMER, scheduled_date: '2027-01-15', status: 'confirmed', service_type: 'Lawn Care Treatment Program', ...nextStamp },
            ...extraRows,
          ],
          ...patch,
        });
        return spy.mock.calls[0][0].ctx.nextVisitGapDays;
      } finally {
        spy.mockRestore();
      }
    };

    test('the same home: the scheduled date sets the gap', async () => {
      expect(await gapFor(HOME_A)).toBe(107);
    });

    test('another home of the same customer: no gap (no by-next-visit sentence), never the other home\'s date', async () => {
      expect(await gapFor(HOME_B)).toBeNull();
    });

    test('the gap counts from the SELECTED assessment\'s date, not the record\'s service_date (an A→B re-do)', async () => {
      const redo = { ...CUR, service_date: '2026-10-01', visit_date: '2026-10-01' };
      history.installedForVisit.mockResolvedValue(redo);
      history.historyForReport.mockResolvedValue({ current: redo, rows: [redo], identity: 'h', eligibleVisitIds: [], isBaseline: true });
      history.historyForAssessment.mockResolvedValue({ current: redo, rows: [redo], identity: 'h', eligibleVisitIds: [], isBaseline: true });
      expect(await gapFor(HOME_A, [], { lawn_assessments: [redo] })).toBe(106);
    });

    test('an EARLIER booking at another home is skipped and the later booking at this home sets the gap', async () => {
      const later = { id: 'ss-later', customer_id: CUSTOMER, scheduled_date: '2027-02-12', status: 'confirmed', service_type: 'Lawn Care Treatment Program', ...HOME_A };
      expect(await gapFor(HOME_B, [later])).toBe(135);
    });

    test('no booking at this home: the gap is this visit\'s own plan cadence', async () => {
      live();
      const v6 = require('../services/service-report/lawn-copy-v6');
      const spy = jest.spyOn(v6, 'resolveLawnCopyV6ForRender').mockResolvedValue({ copy: null, unfrozen: true });
      try {
        const svc = { ...service(records()['svc-cur'].structured_notes), service_type: 'Lawn Care every 6 weeks' };
        await render(records(), {
          scheduled_services: [
            { id: 'ss-cur', customer_id: CUSTOMER, scheduled_date: '2026-09-30', status: 'completed', service_type: 'Lawn Care every 6 weeks', ...HOME_A },
            { id: 'ss-other', customer_id: CUSTOMER, scheduled_date: '2027-01-15', status: 'confirmed', service_type: 'Lawn Care every 6 weeks', ...HOME_B },
          ],
        }, svc);
        expect(spy.mock.calls[0][0].ctx.nextVisitGapDays).toBe(42);
      } finally {
        spy.mockRestore();
      }
    });

    describe('the "Next visit" line shows the same visit the copy is timed from', () => {
      const visitRows = (nextStamp, extra = []) => ({
        scheduled_services: [
          { id: 'ss-cur', customer_id: CUSTOMER, scheduled_date: '2026-09-30', status: 'completed', service_type: 'Lawn Care Treatment Program', ...HOME_A },
          { id: 'ss-next', customer_id: CUSTOMER, scheduled_date: '2027-01-15', status: 'confirmed', service_type: 'Lawn Care Treatment Program', ...nextStamp },
          ...extra,
        ],
      });

      test('a booking at another home is never shown; the later booking at this home is', async () => {
        live();
        const later = { id: 'ss-later', customer_id: CUSTOMER, scheduled_date: '2027-02-12', status: 'confirmed', service_type: 'Lawn Care Treatment Program', ...HOME_A };
        const { data } = await render(records(), visitRows(HOME_B, [later]));
        expect(data.reportV2.snapshot.nextVisit).toMatchObject({ source: 'scheduled' });
        expect(data.reportV2.snapshot.nextVisit.label).toMatch(/February 12/);
      });

      test('only another home has a booking and the plan names no cadence: no next visit is shown', async () => {
        live();
        const { data } = await render(records(), visitRows(HOME_B));
        expect(data.reportV2.snapshot.nextVisit).toBeUndefined();
      });

      test('a next booking whose property cannot be placed: nothing is shown, never a guess', async () => {
        live();
        const { data } = await render(records(), visitRows({}));
        expect(data.reportV2.snapshot.nextVisit).toBeUndefined();
      });

      test('this report\'s visit has no property evidence: the customer-wide booking counts only on a proven single-premises account', async () => {
        live();
        const rows = {
          scheduled_services: [
            { id: 'ss-cur', customer_id: CUSTOMER, scheduled_date: '2026-09-30', status: 'completed', service_type: 'Lawn Care Treatment Program' },
            { id: 'ss-next', customer_id: CUSTOMER, scheduled_date: '2027-01-15', status: 'confirmed', service_type: 'Lawn Care Treatment Program' },
          ],
          customers: [{ id: CUSTOMER, has_multi_home: false }],
          customer_properties: [],
        };
        const svc = { ...service(records()['svc-cur'].structured_notes), address_line1: '100 Test Palm Way', city: 'Bradenton', zip: '34201' };
        const single = await render(records(), rows, svc);
        expect(single.data.reportV2.snapshot.nextVisit.label).toMatch(/January 15/);
        const multi = await render(records(), { ...rows, customers: [{ id: CUSTOMER, has_multi_home: true }] }, svc);
        expect(multi.data.reportV2.snapshot.nextVisit).toBeUndefined();
      });

      test('two lawn jobs on one day: the one at this home is shown whichever order they come back in', async () => {
        live();
        const here = { id: 'ss-b', customer_id: CUSTOMER, scheduled_date: '2027-01-15', status: 'confirmed', service_type: 'Lawn Care Treatment Program', ...HOME_A };
        const unplaced = { id: 'ss-a', customer_id: CUSTOMER, scheduled_date: '2027-01-15', status: 'confirmed', service_type: 'Lawn Care Treatment Program' };
        const cur = { id: 'ss-cur', customer_id: CUSTOMER, scheduled_date: '2026-09-30', status: 'completed', service_type: 'Lawn Care Treatment Program', ...HOME_A };
        for (const order of [[cur, unplaced, here], [cur, here, unplaced]]) {
          const { data } = await render(records(), { scheduled_services: order });
          expect(data.reportV2.snapshot.nextVisit.label).toMatch(/January 15/);
        }
      });

      test('a completed report\'s FROZEN address is its property, whatever the linked visit resolves to now', async () => {
        live();
        const svc = {
          ...service(records()['svc-cur'].structured_notes),
          service_data: JSON.stringify({ reportIdentitySnapshot: { version: 1, address: { line1: '100 Test Palm Way', line2: null, city: 'Bradenton', state: 'FL', zip: '34201' } } }),
        };
        // The linked visit now resolves to another home (its property record was edited).
        const { data } = await render(records(), {
          scheduled_services: [
            { id: 'ss-cur', customer_id: CUSTOMER, scheduled_date: '2026-09-30', status: 'completed', service_type: 'Lawn Care Treatment Program', ...HOME_B },
            { id: 'ss-old-home', customer_id: CUSTOMER, scheduled_date: '2027-01-15', status: 'confirmed', service_type: 'Lawn Care Treatment Program', ...HOME_A },
            { id: 'ss-new-home', customer_id: CUSTOMER, scheduled_date: '2027-01-08', status: 'confirmed', service_type: 'Lawn Care Treatment Program', ...HOME_B },
          ],
        }, svc);
        expect(data.reportV2.snapshot.nextVisit.label).toMatch(/January 15/);
      });

      test('gate off: the customer-wide lookup, as before (the other home\'s date still shows)', async () => {
        const { data } = await render(records(), visitRows(HOME_B));
        expect(data.reportV2.snapshot.nextVisit.label).toMatch(/January 15/);
      });
    });

    test('a cadence estimate already in the past shows no next visit and times nothing', async () => {
      live();
      const v6 = require('../services/service-report/lawn-copy-v6');
      const spy = jest.spyOn(v6, 'resolveLawnCopyV6ForRender').mockResolvedValue({ copy: null, unfrozen: true });
      try {
        const old = { ...CUR, service_date: '2026-07-01', visit_date: '2026-07-01' };
        history.installedForVisit.mockResolvedValue(old);
        const svc = { ...service(records()['svc-cur'].structured_notes), service_type: 'Lawn Care every 6 weeks', service_date: '2026-07-01' };
        const { data } = await render(records(), {
          lawn_assessments: [old],
          scheduled_services: [{ id: 'ss-cur', customer_id: CUSTOMER, scheduled_date: '2026-07-01', status: 'completed', service_type: 'Lawn Care every 6 weeks', ...HOME_A }],
        }, svc);
        expect(data.reportV2.snapshot.nextVisit).toBeUndefined();
        expect(spy.mock.calls[0][0].ctx).toMatchObject({ nextVisitGapDays: null, nextVisitIso: null });
      } finally {
        spy.mockRestore();
      }
    });

    test('a next visit with no property evidence: no gap', async () => {
      expect(await gapFor({})).toBeNull();
    });

    test('a FAILED property lookup is a degraded read (no freeze), never read as "another home"', async () => {
      live();
      const v6 = require('../services/service-report/lawn-copy-v6');
      const spy = jest.spyOn(v6, 'resolveLawnCopyV6ForRender').mockResolvedValue({ copy: null, unfrozen: true });
      try {
        await render(records(), {
          customer_properties: FAIL,
          scheduled_services: [
            { id: 'ss-cur', customer_id: CUSTOMER, scheduled_date: '2026-09-30', status: 'completed', service_type: 'Lawn Care Treatment Program', ...HOME_A },
            { id: 'ss-next', customer_id: CUSTOMER, scheduled_date: '2027-01-15', status: 'confirmed', service_type: 'Lawn Care Treatment Program', property_id: 'prop-2' },
          ],
        });
        expect(spy.mock.calls[0][0].degraded).toBe(true);
        expect(spy.mock.calls[0][0].ctx.nextVisitGapDays).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });
  });

  test('a failed next-visit read (the gap that picks the by-next-visit sentence) is a degraded read: no freeze', async () => {
    live();
    const recs = records();
    // Only the v6 copy's next-visit scan fails; every other scheduled_services read answers.
    const { knex: base } = withRecords(fixtures(), recs);
    const knex = (table) => {
      const q = base(table);
      if (table !== 'scheduled_services') return q;
      const select = q.select;
      q.select = (...cols) => (cols.includes('service_type') && cols.includes('scheduled_date')
        ? { catch: (fn) => Promise.resolve(fn(new Error('read failed'))) }
        : select(...cols));
      return q;
    };
    knex.raw = base.raw;
    const data = await buildReportV1Data(service(recs['svc-cur'].structured_notes), 'token-p14', knex, {});
    expect(recs['svc-cur'].structured_notes.lawnCopyV6).toBeUndefined();
    expect(data.lawnAssessment.weekWeatherUncacheable).toBe(true);
  });

  describe('an emailed (pinned) PDF waits for frozen copy: lawnCopyV6Unfrozen', () => {
    test('a healthy render that froze carries no flag', async () => {
      live();
      const { data } = await render(records());
      expect(data.lawnAssessment.lawnCopyV6Unfrozen).toBeUndefined();
    });

    test('a failed read (retryable) sets it', async () => {
      live();
      const { data } = await render(records(), { service_products: FAIL });
      expect(data.lawnAssessment.lawnCopyV6Unfrozen).toBe(true);
    });

    test('a failed freeze write (copy served, not saved) sets it', async () => {
      live();
      const { data } = await render(records(), {}, undefined, { failUpdate: true });
      expect(data.lawnAssessment.lawnCopyV6Unfrozen).toBe(true);
    });

    test('a failed treatment-catalog check (the guard\'s own lookup, not in readFailures) still holds the email: no freeze, flag set', async () => {
      live();
      const recs = records();
      const products = [{ id: 'sp-9', service_record_id: 'svc-cur', product_name: 'Test Herbicide B', product_id: 'pc-1', created_at: '2026-09-30T18:00:00Z' }];
      const { knex: base } = withRecords({ ...fixtures(), service_products: products, products_catalog: [{ id: 'pc-1', name: 'Test Herbicide B' }] }, recs);
      const knex = (table) => {
        const q = base(table);
        if (table !== 'products_catalog') return q;
        const select = q.select;
        // Only the guard's direct category lookup fails.
        q.select = (...cols) => (cols.length === 2 && cols[0] === 'id' && cols[1] === 'category'
          ? Promise.reject(new Error('read failed'))
          : select(...cols));
        return q;
      };
      knex.raw = base.raw;
      const data = await buildReportV1Data(service(recs['svc-cur'].structured_notes), 'token-p14', knex, {});
      expect(recs['svc-cur'].structured_notes.lawnCopyV6).toBeUndefined();
      expect(data.lawnAssessment.lawnCopyV6Unfrozen).toBe(true);
    });

    test('gate off never sets it', async () => {
      const { data } = await render(records(), { service_products: FAIL });
      expect(data.lawnAssessment.lawnCopyV6Unfrozen).toBeUndefined();
    });

    test('the pinned delivery path defers with a retryable error on it', () => {
      const queueSource = require('fs').readFileSync(require('path').join(__dirname, '../services/service-report/pdf-queue.js'), 'utf8');
      expect(queueSource).toMatch(/lawnCopyV6Unfrozen && isDeliveryPin/);
      expect(queueSource).toMatch(/lawn_copy_v6_unfrozen/);
    });
  });

  test('the PDF cache signature moves with the gate only while it is live (gate off is the signature it was)', async () => {
    const sig = async () => {
      const knex = makeKnex({ ...fixtures(), service_records: [] });
      return (await resolveCanonicalLawnRender({ id: 'svc-cur', customer_id: CUSTOMER, service_line: 'lawn', service_date: '2026-09-30' }, knex)).signature;
    };
    const off = await sig();
    process.env.GATE_LAWN_REPORT_COPY_V6 = 'true';
    expect(await sig()).toBe(off); // lead gate off: inert
    process.env.GATE_LAWN_REPORT_LEAD = 'true';
    delete process.env.GATE_LAWN_REPORT_COPY_V6;
    const leadOnlySig = await sig();
    process.env.GATE_LAWN_REPORT_COPY_V6 = 'true';
    const both = await sig();
    expect(leadOnlySig).not.toBe(off);
    expect(both).not.toBe(leadOnlySig);
  });

  test('gate live: the PDF key follows the upcoming lawn bookings (a reschedule or cancellation re-keys it; a failed read never matches)', async () => {
    jest.useFakeTimers({
      now: new Date('2026-10-02T16:00:00Z'),
      doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
    });
    try {
      process.env.GATE_LAWN_REPORT_COPY_V6 = 'true';
      process.env.GATE_LAWN_REPORT_LEAD = 'true';
      // A row that already carries its premise (as the full render's does).
      const svc = {
        id: 'svc-cur', customer_id: CUSTOMER, service_line: 'lawn', service_date: '2026-09-30',
        address_line1: '100 Test Palm Way', address_line2: null, city: 'Bradenton', zip: '34201', stamped_address_diverges: false,
      };
      // A partial row whose premise cannot be read is unknown: it never matches.
      const bare = { id: 'svc-cur', customer_id: CUSTOMER, service_line: 'lawn', service_date: '2026-09-30' };
      const bareSig = () => resolveCanonicalLawnRender(bare, makeKnex({ ...fixtures(), service_records: [] })).then((r) => r.signature);
      expect(await bareSig()).not.toBe(await bareSig());
      const sigWith = async (scheduled) => (await resolveCanonicalLawnRender(svc, makeKnex({ ...fixtures(), service_records: [], scheduled_services: scheduled }))).signature;
      const visit = (date, status = 'confirmed') => ({ id: `ss-${date}`, customer_id: CUSTOMER, scheduled_date: date, status, service_type: 'Lawn Care Treatment Program' });
      const booked = await sigWith([visit('2026-11-11')]);
      expect(await sigWith([visit('2026-11-11')])).toBe(booked);
      expect(await sigWith([visit('2026-11-18')])).not.toBe(booked);
      expect(await sigWith([visit('2026-11-11', 'cancelled')])).not.toBe(booked);
      // A -> B -> A during a render: same day again, but a new revision, so the key moves.
      const revised = (updatedAt) => sigWith([{ ...visit('2026-11-11'), updated_at: updatedAt }]);
      expect(await revised('2026-10-02T15:00:00Z')).not.toBe(await revised('2026-10-02T15:05:00Z'));
      // A corrected address behind a linked property (same ids and dates) moves the key.
      const linked = (address) => resolveCanonicalLawnRender({ ...svc, scheduled_service_id: 'ss-cur' }, makeKnex({
        ...fixtures(),
        service_records: [],
        scheduled_services: [
          { id: 'ss-cur', customer_id: CUSTOMER, scheduled_date: '2026-09-30', status: 'completed', service_type: 'Lawn Care Treatment Program', service_address_line1: '100 Test Palm Way', service_address_city: 'Bradenton', service_address_zip: '34201' },
          { id: 'ss-next', customer_id: CUSTOMER, scheduled_date: '2026-11-11', status: 'confirmed', service_type: 'Lawn Care Treatment Program', property_id: 'prop-2' },
        ],
        customer_properties: [{ id: 'prop-2', address_line1: address, city: 'Bradenton', zip: '34201' }],
      })).then((r) => r.signature);
      expect(await linked('100 Test Palm Way')).not.toBe(await linked('200 Sample Oak Ln'));
      // No booking: the plan-cadence estimate keys the PDF, and so does its passing.
      const cadenceSvc = { ...svc, scheduled_service_id: 'ss-cur', service_type: 'Lawn Care every 6 weeks' };
      const cadenceSig = () => resolveCanonicalLawnRender(cadenceSvc, makeKnex({
        ...fixtures(),
        service_records: [],
        scheduled_services: [{ id: 'ss-cur', customer_id: CUSTOMER, scheduled_date: '2026-09-30', status: 'completed', service_type: 'Lawn Care every 6 weeks', service_address_line1: '100 Test Palm Way', service_address_city: 'Bradenton', service_address_zip: '34201' }],
      })).then((r) => r.signature);
      const ahead = await cadenceSig();
      jest.setSystemTime(new Date('2026-12-01T16:00:00Z'));
      expect(await cadenceSig()).not.toBe(ahead);
      jest.setSystemTime(new Date('2026-10-02T16:00:00Z'));
      const failedA = await sigWith(FAIL);
      expect(failedA).not.toBe(booked);
      expect(await sigWith(FAIL)).not.toBe(failedA);
    } finally {
      jest.useRealTimers();
    }
  });
});
