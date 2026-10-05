// The lawn assessment line the report writer is grounded on, under
// GATE_LAWN_LIGHTING (owner 2026-10-04): the color health delta against the prior
// visit reaches the writer only when both visits' photos were taken in known,
// compatible light AND the move is at least COLOR_NO_CHANGE_POINTS; every other
// category keeps its delta. Gate off: the line is what it always was.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { buildReportCopyContext } = require('../services/service-report/report-copy-context');

const PHOTOS = [
  { id: 'pt', assessment_id: 'a-today', zone: 'front' },
  { id: 'pp', assessment_id: 'a-prior', zone: 'front' },
];
// Permissive knex stub. lawn_assessments gets query-aware resolution: a
// where({ service_id }) chain resolves to the `linked` row (the visit-linked
// "today" lookup), a where('service_date', '<', …) chain resolves to the
// `prior` row — mirroring how the real queries differ.
function makeKnexStub({ customers = [], linked = null, prior = null, catalogProducts = [], runs = [], runsFail = false } = {}) {
  const calls = [];
  const stub = (table) => {
    calls.push(table);
    const chain = { _byServiceId: false, _priorHistory: false, _whereIns: [] };
    for (const method of ['whereNull', 'whereNot', 'andWhere', 'orWhere', 'orWhereNot', 'orderBy', 'orderByRaw', 'limit', 'select', 'join', 'groupBy', 'count', 'whereRaw', 'whereBetween']) {
      chain[method] = () => chain;
    }
    chain.whereIn = (column, values) => { chain._whereIns.push([column, values]); return chain; };
    // The prior-history query is the one that joins scheduled_services (its
    // bound runs on the linked visit's scheduled_date).
    chain.leftJoin = (joined) => {
      if (String(joined).includes('scheduled_services')) chain._priorHistory = true;
      return chain;
    };
    chain.modify = (fn) => { if (typeof fn === 'function') fn(chain); return chain; };
    chain.where = (...args) => {
      if (typeof args[0] === 'function') {
        args[0].call(chain);
        return chain;
      }
      if (args[0] && typeof args[0] === 'object' && 'service_id' in args[0]) chain._byServiceId = true;
      if (args[0] && typeof args[0] === 'object' && 'id' in args[0]) chain._byId = true;
      // The supersession probe (loadLawnAssessments: "any NEWER row on the
      // same visit") filters on created_at. The stub models a visit with no
      // newer retake, so that probe must resolve EMPTY — without this flag it
      // returned the linked row itself, the code read it as an in-progress
      // retake, and every "today" test failed even though the real SQL
      // (strictly-newer created_at) behaves correctly.
      if (args[0] === 'created_at') chain._newerCheck = true;
      return chain;
    };
    const resolveRows = () => {
      if (table === 'customers') return customers;
      if (table === 'lawn_assessment_runs') { if (runsFail) throw new Error('runs down'); return runs; }
      if (table === 'lawn_assessment_photos') return PHOTOS;
      if (table === 'products_catalog') {
        return chain._whereIns.reduce((rows, [column, values]) => (
          rows.filter((row) => values.includes(row[column]))
        ), catalogProducts);
      }
      // The prior query aliases the table ('lawn_assessments as la').
      if (!String(table).startsWith('lawn_assessments')) return [];
      if (chain._newerCheck) return [];
      if (chain._byId) return linked ? [linked] : [];
      if (chain._byServiceId) return linked ? [linked] : [];
      if (chain._priorHistory) return prior ? [prior] : [];
      return [];
    };
    chain.first = async () => resolveRows()[0];
    chain.then = (resolve, reject) => Promise.resolve(resolveRows()).then(resolve, reject);
    chain.catch = () => chain;
    return chain;
  };
  stub.calls = calls;
  // knex.raw is used for the coalesced visit-date select; the stub resolves
  // rows by table/flags, so the expression itself is inert here.
  stub.raw = (expression) => expression;
  return stub;
}


const CUSTOMER = { id: 'c1', first_name: 'Pat', last_name: 'Lawn', city: 'Bradenton', state: 'FL', latitude: null, longitude: null, lawn_type: 'st_augustine', waveguard_tier: 'silver' };
const row = (id, date, color, turf = 72) => ({
  id, service_date: date, is_baseline: false, turf_density: turf, weed_suppression: 81, color_health: color, stress_damage: 85, fungus_control: 90, thatch_level: 70,
});
const run = (assessmentId, photoId, light) => ({ assessment_id: assessmentId, photo_ids: [photoId], photo_quality: [{ photo: 1, quality: 'adequate', issue: '', ...light }] });
const SUN = { lighting: 'full_sun', hard_shadows: 'no' };
const CLOUD = { lighting: 'overcast', hard_shadows: 'no' };

const GATE = 'GATE_LAWN_LIGHTING';
const saved = process.env[GATE];
afterEach(() => { if (saved === undefined) delete process.env[GATE]; else process.env[GATE] = saved; });

async function context({ color = 74, runs = [], runsFail = false, baseline = false } = {}) {
  const knex = makeKnexStub({ customers: [CUSTOMER], linked: { ...row('a-today', '2026-07-28', color), is_baseline: baseline }, prior: row('a-prior', '2026-06-20', 64, 64), runs, runsFail });
  const out = await buildReportCopyContext({ customerId: 'c1', scheduledServiceId: 'svc-1', serviceType: 'Monthly Lawn Care Service', serviceDate: '2026-07-28', knex });
  return { text: out.contextText, tables: knex.calls };
}
const COLOR_WITH_DELTA = /color health \d+\/100 \(/;

describe('gate off', () => {
  test('every category keeps its delta, the color delta included, and no run is read', async () => {
    const { text, tables } = await context({ color: 66 });
    expect(text).toContain('color health 66/100 (+2 vs Jun 20, 2026)');
    expect(text).toContain('turf density 72/100 (+8 vs Jun 20, 2026)');
    expect(tables).not.toContain('lawn_assessment_runs');
  });
});

describe('gate on', () => {
  beforeEach(() => { process.env[GATE] = 'true'; });

  test('compatible light and a real move: the color delta is given, as before', async () => {
    const { text } = await context({ color: 74, runs: [run('a-today', 'pt', SUN), run('a-prior', 'pp', SUN)] });
    expect(text).toContain('color health 74/100 (+10 vs Jun 20, 2026)');
  });

  test('compatible light but a small move (under the 8-point band): today\'s score alone, no delta', async () => {
    const { text } = await context({ color: 66, runs: [run('a-today', 'pt', SUN), run('a-prior', 'pp', SUN)] });
    expect(text).toContain('color health 66/100,');
    expect(text).not.toMatch(/color health 66\/100 \(/);
    expect(text).toContain('turf density 72/100 (+8 vs Jun 20, 2026)'); // other categories untouched
  });

  test('different, unknown or unreadable light: no color delta whatever the move; other deltas stay', async () => {
    for (const input of [
      { color: 90, runs: [run('a-today', 'pt', CLOUD), run('a-prior', 'pp', SUN)] }, // different
      { color: 90, runs: [run('a-today', 'pt', SUN), run('a-prior', 'pp', {})] }, // a visit from before the gate
      { color: 90, runs: [] }, // no read at all
      { color: 90, runsFail: true }, // a failed read is unknown light
    ]) {
      const { text } = await context(input);
      expect(text).toMatch(/color health 90\/100,/);
      expect(text).not.toMatch(COLOR_WITH_DELTA);
      expect(text).toContain('turf density 72/100 (+8 vs Jun 20, 2026)');
    }
  });

  test('a baseline visit has no deltas to withhold and reads nothing', async () => {
    const { text, tables } = await context({ baseline: true });
    expect(text).toContain('baseline visit');
    expect(tables).not.toContain('lawn_assessment_runs');
  });
});
