// A later visit of a package booked up front (protocols audit 2026-11-26, item 4). Such a visit carries the first visit's name and is
// linked only by recurring_parent_id with recurring_ongoing = false on both rows, so every card reader gave it the first-treatment
// card again. Real handlers and real protocols.json; synthetic visit rows.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: jest.fn(), requireAdmin: jest.fn(), requireTechOrAdmin: jest.fn(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const adminProtocolsRouter = require('../routes/admin-protocols');
const { isLaterPackageVisit } = require('../services/protocol-package-stage');

const PARENT = '11111111-1111-4111-8111-111111111111';
const VISIT = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

// A reader that answers the series rows to the lineage read ("scheduled_services as ps") and the visit row to any other
// scheduled_services read.
function stageDb({ visit = null, series = [], fail = false, catalog = [] } = {}) {
  const calls = [];
  const dbh = (table) => {
    const name = String(table);
    const rows = name === 'scheduled_services as ps' ? series : (name === 'products_catalog' ? catalog : []);
    const query = {};
    for (const method of ['where', 'orWhere', 'orWhereNull', 'whereIn', 'whereNotIn', 'join', 'leftJoin', 'select', 'orderByRaw', 'orderBy', 'andWhere', 'whereRaw', 'modify']) query[method] = () => query;
    query.first = async () => (name === 'scheduled_services' ? visit : rows[0] || null);
    const settle = () => {
      if (name === 'scheduled_services as ps') { calls.push(name); if (fail) return Promise.reject(new Error('read failed')); }
      return Promise.resolve(rows);
    };
    query.then = (res, rej) => settle().then(res, rej);
    query.catch = (fn) => settle().catch(fn);
    return query;
  };
  dbh.raw = (sql) => sql;
  dbh.calls = calls;
  return dbh;
}

const link = (over = {}) => ({ id: VISIT, recurring_parent_id: PARENT, recurring_ongoing: false, ...over });
const row = (over = {}) => ({
  id: PARENT, status: 'completed', scheduled_date: '2026-12-01', service_type: 'Cockroach Treatment Service', service_key_snapshot: 'cockroach_control',
  catalog_service_key: null, recurring_ongoing: false, ...over,
});
// The visit's own row in the series, two weeks after the first.
const self = (over = {}) => row({ id: VISIT, status: 'pending', scheduled_date: '2026-12-15', ...over });
const later = (series, visit = link()) => isLaterPackageVisit(stageDb({ series }), visit);

describe('isLaterPackageVisit', () => {
  test('a finite visit after a finite first treatment of the same package program is a later visit', async () => {
    expect(await later([row(), self()])).toBe(true);
    // The first visit may still be ahead of today: it is planned, and it is dated before this one.
    expect(await later([row({ status: 'pending' }), self()])).toBe(true);
    // Flea and bed bug packages too.
    const flea = { service_type: 'Flea Control Service', service_key_snapshot: 'flea_tick' };
    expect(await later([row(flea), self(flea)])).toBe(true);
    const bedBug = { service_type: 'Bed Bug Treatment Service', service_key_snapshot: 'bed_bug_treatment' };
    expect(await later([row(bedBug), self(bedBug)])).toBe(true);
    // A Date from the driver reads like a day string.
    expect(await later([row({ scheduled_date: new Date('2026-12-01T00:00:00Z') }), self({ scheduled_date: new Date('2026-12-15T00:00:00Z') })])).toBe(true);
  });

  test('the catalog identity is the booking snapshot, else the live catalog row, for both visits', async () => {
    // A legacy booking: a generic name, no snapshot, and the live catalog key says flea.
    const legacy = { service_type: 'Pest Control Service', service_key_snapshot: null, catalog_service_key: 'flea_tick' };
    expect(await later([row(legacy), self(legacy)])).toBe(true);
    // Without a key the generic name is general pest: one card, repeated.
    const generic = { service_type: 'Pest Control Service', service_key_snapshot: null, catalog_service_key: null };
    expect(await later([row(generic), self(generic)])).toBe(false);
  });

  test('a visit with no parent link, no id, or in an open-ended series is never read', async () => {
    for (const visit of [link({ recurring_parent_id: null }), link({ recurring_ongoing: true }), link({ recurring_ongoing: null }), link({ id: PARENT }), link({ id: null }), null]) {
      const dbh = stageDb({ series: [row(), self()] });
      expect(await isLaterPackageVisit(dbh, visit)).toBe(false);
      expect(dbh.calls).toEqual([]);
    }
    expect(await isLaterPackageVisit(null, link())).toBe(false);
  });

  test('a finite series of another program repeats one card', async () => {
    // Live 2026-11-26: finite children are mostly quarterly pest, lawn and seasonal mosquito series.
    for (const name of ['Quarterly Pest Control Service', 'Monthly Mosquito Control Service', 'Monthly Lawn Care Service', 'Quarterly Rodent Bait Station Service', 'Termite Bait Station Service']) {
      const other = { service_type: name, service_key_snapshot: null };
      expect(await later([row(other), self(other)])).toBe(false);
    }
  });

  test('the earlier visit must be finite, the same program, a treatment, not called off, and dated before this visit', async () => {
    const no = async (first, own = self()) => expect(await later(first ? [first, own] : [own])).toBe(false);
    await no(null);
    await no(row({ recurring_ongoing: true }));
    await no(row({ recurring_ongoing: null }));
    await no(row(), self({ recurring_ongoing: true }));
    await no(row({ service_type: 'Quarterly Pest Control Service', service_key_snapshot: null }));
    await no(row({ service_type: 'Flea Control Service', service_key_snapshot: 'flea_tick' }));
    // A cancelled, skipped, missed or moved-away first visit: this visit is the first treatment in fact.
    for (const status of ['cancelled', 'skipped', 'no_show', 'rescheduled', '', null]) await no(row({ status }));
    await no(row({ scheduled_date: '2026-12-15' }));
    await no(row({ scheduled_date: '2026-12-20' }));
    await no(row({ scheduled_date: null }));
    await no(row(), self({ scheduled_date: null }));
    // The series read did not return the visit itself.
    expect(await later([row()])).toBe(false);
  });

  test('a bed bug inspection before the treatment is not a treatment; a treatment before it is', async () => {
    const treatment = { service_type: 'Bed Bug Treatment Service', service_key_snapshot: 'bed_bug_treatment' };
    expect(await later([row({ service_type: 'Bed Bug Inspection', service_key_snapshot: null }), self(treatment)])).toBe(false);
    expect(await later([row({ service_type: 'Bed Bug Heat Treatment', service_key_snapshot: null }), self(treatment)])).toBe(false);
    expect(await later([row(treatment), self(treatment)])).toBe(true);
  });

  test('with a skipped first visit, the second visit is the first treatment and the third is a later visit', async () => {
    const SECOND = '22222222-2222-4222-8222-222222222222';
    const series = [
      row({ status: 'skipped' }),
      row({ id: SECOND, status: 'completed', scheduled_date: '2026-12-08' }),
      self(),
    ];
    expect(await later(series)).toBe(true);
    expect(await later(series, link({ id: SECOND }))).toBe(false);
  });

  test('a read error is thrown: no reader shows the first-treatment card on an unknown stage', async () => {
    await expect(isLaterPackageVisit(stageDb({ series: [row(), self()], fail: true }), link())).rejects.toThrow('read failed');
  });
});

describe('the schedule panel routes read it for a booked visit', () => {
  const routeHandler = (routePath) => adminProtocolsRouter.stack.find((layer) => layer.route?.path === routePath && layer.route.methods.get).route.stack[0].handle;
  const CATALOG = [
    { id: 'ant', name: 'Atticus Antapex WSG', aliases: [] },
    { id: 'tek', name: 'Tekko Pro IGR', aliases: [] },
    { id: 'gel', name: 'Advion Evolution Cockroach Gel Bait', aliases: [] },
  ];
  const flea = { service_type: 'Flea Control Service', service_key_snapshot: 'flea_tick' };
  const visitRow = { id: VISIT, service_key: 'flea_tick', followup_source_service_id: null, recurring_parent_id: PARENT, recurring_ongoing: false };
  const use = (state) => {
    const dbh = stageDb({ catalog: CATALOG, ...state });
    db.raw = dbh.raw;
    db.mockImplementation(dbh);
  };
  const call = async (routePath, query) => {
    const res = { json: jest.fn(), status: jest.fn() };
    res.status.mockReturnValue(res);
    const next = jest.fn();
    await routeHandler(routePath)({ query }, res, next);
    return { res, next, body: res.json.mock.calls[0] ? JSON.parse(JSON.stringify(res.json.mock.calls[0][0])) : null };
  };
  const names = (body) => body.actions.map((action) => action.product?.name).filter(Boolean);

  beforeEach(() => { jest.clearAllMocks(); });

  test('a later flea package visit gets treatment 2 on /match and no growth regulator on /completion-actions', async () => {
    use({ visit: visitRow, series: [row(flea), self(flea)] });
    const match = (await call('/match', { serviceType: 'Flea Control Service', visitId: VISIT })).body;
    expect([match.programKey, match.matchedVisit.visit, match.reason]).toEqual(['flea', 2, 'flea_followup']);
    const actions = (await call('/completion-actions', { serviceType: 'Flea Control Service', visitId: VISIT })).body;
    expect(actions).toMatchObject({ programKey: 'flea', visit: { visit: 2 } });
    expect(names(actions)).not.toContain('Tekko Pro IGR');
  });

  test('the same visit with a cancelled first visit, or in an open-ended series, keeps treatment 1', async () => {
    use({ visit: visitRow, series: [row({ ...flea, status: 'cancelled' }), self(flea)] });
    expect((await call('/match', { serviceType: 'Flea Control Service', visitId: VISIT })).body.matchedVisit.visit).toBe(1);
    use({ visit: { ...visitRow, recurring_ongoing: true }, series: [row({ ...flea, recurring_ongoing: true }), self({ ...flea, recurring_ongoing: true })] });
    const actions = (await call('/completion-actions', { serviceType: 'Flea Control Service', visitId: VISIT })).body;
    expect(actions.visit.visit).toBe(1);
    expect(names(actions)).toContain('Tekko Pro IGR');
  });

  test('a failed series read answers an error, never treatment 1', async () => {
    use({ visit: visitRow, series: [row(flea), self(flea)], fail: true });
    for (const routePath of ['/match', '/completion-actions']) {
      const { res, next } = await call(routePath, { serviceType: 'Flea Control Service', visitId: VISIT });
      expect(res.json).not.toHaveBeenCalled();
      expect(next.mock.calls.length + res.status.mock.calls.length).toBeGreaterThan(0);
    }
  });
});

// The job card, the tank search and the completion product defaults OR the same answer into their follow-up flag.
describe('every card reader asks', () => {
  const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  test.each([
    ['services/job-card.js', 2],
    ['routes/admin-protocols.js', 1],
    ['services/completion-product-defaults.js', 1],
  ])('%s', (file, uses) => {
    const text = source(file);
    expect(text.match(/followup_source_service_id\s*(?:!= null)?\s*\|\|\s*await isLaterPackageVisit\([^)]*\{ protocols/g) || []).toHaveLength(uses);
    // Each query that feeds it selects the two link columns.
    expect((text.match(/recurring_parent_id/g) || []).length).toBeGreaterThanOrEqual(uses);
    expect((text.match(/recurring_ongoing/g) || []).length).toBeGreaterThanOrEqual(uses);
  });
});
