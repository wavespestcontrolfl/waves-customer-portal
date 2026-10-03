/**
 * The standard wording a nothing-found report keeps, shown on the office
 * Complete Service form (GATE_STANDARD_WORDING_PREVIEW; owner mockup approval
 * 2026-10-03): services/service-report/standard-wording-preview.js and
 * POST /admin/dispatch/:serviceId/standard-wording.
 *
 *  - The sentences are the report's own Today's Result, built as /complete
 *    builds it: the visit's own form, the score the completion keeps, the
 *    visit number and trend from the customer's earlier scores.
 *  - They are answered only when the report keeps its standard wording (a
 *    write-up offered to it is refused); a record with activity answers none.
 *  - The route is dark with the gate off, reads the form from the visit's
 *    completion profile (never the client), keeps only the form's own
 *    fields, and keeps the completion routes' reach.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
let mockDbCurrent = null;
jest.mock('../models/db', () => {
  const proxy = (...args) => (mockDbCurrent ? mockDbCurrent(...args) : {});
  proxy.raw = (sql) => ({ toString: () => sql });
  proxy.fn = { now: () => new Date() };
  proxy.schema = { hasTable: async () => true, hasColumn: async () => true };
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/job-costing', () => ({
  calculateJobCost: jest.fn(async () => ({})),
  resolveServiceRecord: jest.requireActual('../services/job-costing').resolveServiceRecord,
}));
jest.mock('../services/time-tracking', () => ({ adminEditEntry: jest.fn(async () => ({})) }));
const mockResolveProfile = jest.fn();
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: (...args) => mockResolveProfile(...args),
}));

const ActivityIndicators = require('../services/service-report/activity-indicators');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { standardWordingPreview } = require('../services/service-report/standard-wording-preview');
const router = require('../routes/admin-dispatch');

const SVC = { id: 'svc-1', technician_id: 'tech-1', customer_id: 'cust-1', status: 'confirmed', scheduled_date: '2026-09-01', service_type: 'Termite Monitoring' };
const DAY = '2026-10-03';
const BAIT = { findingsType: 'termite_bait_station', serviceKey: 'termite_monitoring' };
const NOTHING = { stations_checked: '14', termite_activity: 'None observed', bait_consumption: 'None — bait intact' };

// The customer's earlier scores: the latest one and how many.
function scoresKnex({ prior = null, count = 0 } = {}) {
  const calls = [];
  const knex = (table) => {
    const chain = {};
    for (const m of ['where', 'orderBy']) chain[m] = (...args) => { calls.push([table, m, ...args]); return chain; };
    chain.first = async () => (prior == null ? null : { score: prior });
    chain.count = async () => [{ count: String(count) }];
    return chain;
  };
  knex.calls = calls;
  return knex;
}

describe('standardWordingPreview', () => {
  test('nothing found on a bait check: the report\'s own standard sentences', async () => {
    expect(await standardWordingPreview(scoresKnex(), { svc: SVC, serviceDate: DAY, profile: BAIT, values: NOTHING })).toEqual({
      headline: 'No termite activity was observed in the accessible bait stations today.',
      body: 'We inspected 14 termite bait stations around the exterior perimeter today.',
    });
  });

  test('activity found: the report uses a write-up, so there is no standard wording', async () => {
    expect(await standardWordingPreview(scoresKnex(), {
      svc: SVC, serviceDate: DAY, profile: BAIT, values: { ...NOTHING, termite_activity: 'Active termites present', bait_consumption: 'Heavy' },
    })).toBeNull();
  });

  test('a technician-set score of 0 on a trap check keeps the standard wording; any other does not', async () => {
    const trap = { findingsType: 'rodent_trapping', serviceKey: 'rodent_trapping' };
    const values = { species: 'Roof rat', trap_visit_type: 'Follow-up check', traps_checked: '8', captures: '0' };
    expect(await standardWordingPreview(scoresKnex(), { svc: SVC, serviceDate: DAY, profile: trap, values, techScore: 0 }))
      .toMatchObject({ headline: 'No active signs of rodent activity observed today.' });
    expect(await standardWordingPreview(scoresKnex(), { svc: SVC, serviceDate: DAY, profile: trap, values, techScore: 2 })).toBeNull();
  });

  test('the visit number and trend come from the customer\'s earlier scores, as /complete reads them', async () => {
    const knex = scoresKnex({ prior: 3, count: 2 });
    const wording = await standardWordingPreview(knex, { svc: SVC, serviceDate: DAY, profile: BAIT, values: NOTHING });
    const expected = ActivityIndicators.buildTypedReportSnapshot({
      projectType: 'termite_bait_station',
      values: NOTHING,
      serviceKey: 'termite_monitoring',
      serviceLabel: 'Termite Monitoring',
      visitSequence: 3,
      activity: {
        indicatorKey: 'termite_activity',
        label: 'Termite Activity',
        score: 0,
        trend: ActivityIndicators.trendDirection(0, 3),
        trendWord: ActivityIndicators.trendWordForScores(0, 3),
      },
      technicianReportBody: null,
    }).todaysResult;
    expect(wording).toEqual({ headline: expected.headline, body: expected.body });
    expect(knex.calls).toEqual(expect.arrayContaining([
      ['service_activity_scores', 'where', { customer_id: 'cust-1', indicator_key: 'termite_activity' }],
      ['service_activity_scores', 'where', 'service_date', '<=', DAY],
    ]));
  });

  test('no completion day, no wording', async () => {
    expect(await standardWordingPreview(scoresKnex(), { svc: SVC, serviceDate: null, profile: BAIT, values: NOTHING })).toBeNull();
  });

  test('no typed form, no wording', async () => {
    expect(await standardWordingPreview(scoresKnex(), { svc: SVC, serviceDate: DAY, profile: { findingsType: null }, values: NOTHING })).toBeNull();
  });
});

describe('POST /:serviceId/standard-wording', () => {
  const saved = process.env.GATE_STANDARD_WORDING_PREVIEW;
  let scores;
  const countedUpTo = () => scores.calls.filter((c) => c[1] === 'where' && c[2] === 'service_date').map((c) => c[4]);
  beforeEach(() => {
    mockResolveProfile.mockReset();
    mockResolveProfile.mockResolvedValue(BAIT);
    process.env.GATE_STANDARD_WORDING_PREVIEW = 'true';
    scores = scoresKnex();
    mockDbCurrent = (table) => (table === 'scheduled_services' ? { where: () => ({ first: async () => SVC }) } : scores(table));
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_STANDARD_WORDING_PREVIEW; else process.env.GATE_STANDARD_WORDING_PREVIEW = saved;
  });
  function invoke(body, actor = { techRole: 'admin', technicianId: 'admin-1' }) {
    const layer = router.stack.find((l) => l.route && l.route.path === '/:serviceId/standard-wording' && l.route.methods.post);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    return new Promise((resolve, reject) => {
      handler({ params: { serviceId: 'svc-1' }, body, ...actor }, res, (err) => (err ? reject(err) : resolve(res)))
        .then(() => resolve(res))
        .catch(reject);
    });
  }

  test.each([undefined, '', 'false', '1', 'TRUE'])('gate %p: unavailable, nothing read', async (value) => {
    if (value === undefined) delete process.env.GATE_STANDARD_WORDING_PREVIEW; else process.env.GATE_STANDARD_WORDING_PREVIEW = value;
    const res = await invoke({ values: NOTHING });
    expect(res.body).toEqual({ available: false });
    expect(mockResolveProfile).not.toHaveBeenCalled();
  });

  test('a nothing-found record answers the standard sentences, from the visit\'s own form', async () => {
    const res = await invoke({ values: { ...NOTHING, not_a_field: 'x' }, activityScore: 4 });
    expect(res.body).toEqual({
      available: true,
      headline: 'No termite activity was observed in the accessible bait stations today.',
      body: 'We inspected 14 termite bait stations around the exterior perimeter today.',
    });
  });

  test('dated as /complete dates it: today (Eastern) for a live completion', async () => {
    await invoke({ values: NOTHING });
    expect(countedUpTo()).toEqual([etDateString(), etDateString()]);
  });

  test('an office backdated closeout of a past visit counts up to the scheduled day', async () => {
    await invoke({ values: NOTHING, backfill: true });
    expect(countedUpTo()).toEqual(['2026-09-01', '2026-09-01']);
  });

  test('a technician cannot backdate: their own visit from 3 days ago counts up to today, as /complete would refuse the backfill', async () => {
    const recent = { ...SVC, scheduled_date: etDateString(addETDays(new Date(), -3)) };
    mockDbCurrent = (table) => (table === 'scheduled_services' ? { where: () => ({ first: async () => recent }) } : scores(table));
    const res = await invoke({ values: NOTHING, backfill: true }, { techRole: 'technician', technicianId: 'tech-1' });
    expect(res.body).toMatchObject({ available: true });
    expect(countedUpTo()).toEqual([etDateString(), etDateString()]);
  });

  test('a record with activity answers none', async () => {
    const res = await invoke({ values: { ...NOTHING, termite_activity: 'Active termites present', bait_consumption: 'Heavy' } });
    expect(res.body).toEqual({ available: false });
  });

  test('values must be an object', async () => {
    expect((await invoke({ values: 'x' })).statusCode).toBe(400);
  });

  test('another technician\'s visit is refused', async () => {
    const res = await invoke({ values: NOTHING }, { techRole: 'technician', technicianId: 'tech-2' });
    expect(res.statusCode).toBe(403);
  });

  test('a visit with no typed form answers none', async () => {
    mockResolveProfile.mockResolvedValue({ serviceKey: 'pest_general_quarterly', findingsType: null });
    expect((await invoke({ values: NOTHING })).body).toEqual({ available: false });
  });
});
