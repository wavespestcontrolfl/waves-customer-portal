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

// A scheduled_services reader that answers the parent row to `where({ id: PARENT })` and the visit row to anything else.
function stageDb({ visit = null, parent = null, fail = false } = {}) {
  const calls = [];
  const dbh = (table) => {
    let byId = null;
    const query = {};
    for (const method of ['orWhereNull', 'whereIn', 'whereNotIn', 'join', 'leftJoin', 'select', 'orderByRaw', 'orderBy', 'andWhere', 'whereRaw', 'modify']) query[method] = () => query;
    query.where = (arg) => { if (arg && typeof arg === 'object' && 'id' in arg) byId = arg.id; return query; };
    query.first = async () => {
      calls.push({ table, byId });
      if (fail && byId) throw new Error('read failed');
      if (table !== 'scheduled_services') return null;
      return byId ? parent : visit;
    };
    query.then = (res, rej) => Promise.resolve([]).then(res, rej);
    query.catch = (fn) => Promise.resolve([]).catch(fn);
    return query;
  };
  dbh.raw = (sql) => sql;
  dbh.calls = calls;
  return dbh;
}

const child = (over = {}) => ({
  id: VISIT, service_type: 'Cockroach Treatment Service', service_key: 'cockroach_control', scheduled_date: '2026-12-15',
  recurring_parent_id: PARENT, recurring_ongoing: false, ...over,
});
const first = (over = {}) => ({
  id: PARENT, status: 'completed', scheduled_date: '2026-12-01', service_type: 'Cockroach Treatment Service', service_key_snapshot: 'cockroach_control',
  recurring_ongoing: false, ...over,
});

describe('isLaterPackageVisit', () => {
  test('a finite child of a finite first visit of the same package program is a later visit', async () => {
    expect(await isLaterPackageVisit(stageDb({ parent: first() }), child())).toBe(true);
    // The first visit may still be ahead of today: it is planned, and it is dated before this one.
    expect(await isLaterPackageVisit(stageDb({ parent: first({ status: 'pending' }) }), child())).toBe(true);
    // Flea and bed bug packages too, by name or by catalog key.
    expect(await isLaterPackageVisit(
      stageDb({ parent: first({ service_type: 'Flea Control Service', service_key_snapshot: 'flea_tick' }) }),
      child({ service_type: 'Flea Control Service', service_key: 'flea_tick' }),
    )).toBe(true);
    expect(await isLaterPackageVisit(
      stageDb({ parent: first({ service_type: 'Bed Bug Treatment Service', service_key_snapshot: null }) }),
      child({ service_type: 'Bed Bug Treatment Service', service_key: null, service_key_snapshot: null }),
    )).toBe(true);
    // A Date from the driver reads like a day string.
    expect(await isLaterPackageVisit(stageDb({ parent: first({ scheduled_date: new Date('2026-12-01T00:00:00Z') }) }), child({ scheduled_date: new Date('2026-12-15T00:00:00Z') }))).toBe(true);
  });

  test('a visit with no parent link, or an open-ended series, is never read', async () => {
    for (const visit of [child({ recurring_parent_id: null }), child({ recurring_ongoing: true }), child({ recurring_ongoing: null }), child({ id: PARENT })]) {
      const dbh = stageDb({ parent: first() });
      expect(await isLaterPackageVisit(dbh, visit)).toBe(false);
      expect(dbh.calls).toEqual([]);
    }
    expect(await isLaterPackageVisit(null, child())).toBe(false);
    expect(await isLaterPackageVisit(stageDb({ parent: first() }), null)).toBe(false);
  });

  test('a finite series of another program repeats one card and is not read', async () => {
    // Live 2026-11-26: finite children are mostly quarterly pest, lawn and seasonal mosquito series.
    for (const [name, key] of [['Quarterly Pest Control Service', 'pest_quarterly'], ['Monthly Mosquito Control Service', 'mosquito_monthly'], ['Monthly Lawn Care Service', null], ['Quarterly Rodent Bait Station Service', null], ['Termite Bait Station Service', null]]) {
      const dbh = stageDb({ parent: first({ service_type: name, service_key_snapshot: key }) });
      expect(await isLaterPackageVisit(dbh, child({ service_type: name, service_key: key }))).toBe(false);
      expect(dbh.calls).toEqual([]);
    }
  });

  test('the first visit must be finite, the same program, not called off, and dated before this visit', async () => {
    const no = async (parent, visit = child()) => expect(await isLaterPackageVisit(stageDb({ parent }), visit)).toBe(false);
    await no(null);
    await no(first({ recurring_ongoing: true }));
    await no(first({ recurring_ongoing: null }));
    await no(first({ service_type: 'Quarterly Pest Control Service', service_key_snapshot: null }));
    await no(first({ service_type: 'Flea Control Service', service_key_snapshot: 'flea_tick' }));
    // A cancelled, skipped, missed or moved-away first visit: this visit is the first treatment in fact.
    for (const status of ['cancelled', 'skipped', 'no_show', 'rescheduled', '', null]) await no(first({ status }));
    await no(first({ scheduled_date: '2026-12-15' }));
    await no(first({ scheduled_date: '2026-12-20' }));
    await no(first({ scheduled_date: null }));
    await no(first(), child({ scheduled_date: null }));
  });

  test('a read error keeps the card the visit has today', async () => {
    expect(await isLaterPackageVisit(stageDb({ parent: first(), fail: true }), child())).toBe(false);
  });
});

describe('the schedule panel routes read it for a booked visit', () => {
  const routeHandler = (routePath) => adminProtocolsRouter.stack.find((layer) => layer.route?.path === routePath && layer.route.methods.get).route.stack[0].handle;
  const CATALOG = [
    { id: 'ant', name: 'Atticus Antapex WSG', aliases: [] },
    { id: 'tek', name: 'Tekko Pro IGR', aliases: [] },
    { id: 'gel', name: 'Advion Evolution Cockroach Gel Bait', aliases: [] },
  ];
  let visitRow;
  let parentRow;
  const call = async (routePath, query) => {
    const res = { json: jest.fn(), status: jest.fn() };
    res.status.mockReturnValue(res);
    const next = jest.fn();
    await routeHandler(routePath)({ query }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    return JSON.parse(JSON.stringify(res.json.mock.calls[0][0]));
  };

  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = jest.fn((sql) => sql);
    db.mockImplementation((table) => {
      const rows = table === 'products_catalog' ? CATALOG : [];
      let byId = null;
      const query = {};
      for (const method of ['orWhereNull', 'whereIn', 'whereNotIn', 'join', 'leftJoin', 'select', 'orderByRaw', 'orderBy']) query[method] = () => query;
      query.where = (arg) => { if (arg && typeof arg === 'object' && 'id' in arg) byId = arg.id; return query; };
      query.first = async () => (table === 'scheduled_services' ? (byId ? parentRow : visitRow) : rows[0] || null);
      query.then = (res, rej) => Promise.resolve(rows).then(res, rej);
      query.catch = (fn) => Promise.resolve(rows).catch(fn);
      return query;
    });
  });

  test('a later flea package visit gets treatment 2 on /match and no growth regulator on /completion-actions', async () => {
    visitRow = { id: VISIT, service_type: 'Flea Control Service', service_key: 'flea_tick', scheduled_date: '2026-12-15', followup_source_service_id: null, recurring_parent_id: PARENT, recurring_ongoing: false };
    parentRow = { id: PARENT, status: 'completed', scheduled_date: '2026-12-01', service_type: 'Flea Control Service', service_key_snapshot: 'flea_tick', recurring_ongoing: false };
    const match = await call('/match', { serviceType: 'Flea Control Service', visitId: VISIT });
    expect([match.programKey, match.matchedVisit.visit, match.reason]).toEqual(['flea', 2, 'flea_followup']);
    const actions = await call('/completion-actions', { serviceType: 'Flea Control Service', visitId: VISIT });
    expect(actions).toMatchObject({ programKey: 'flea', visit: { visit: 2 } });
    expect(actions.actions.map((action) => action.product?.name).filter(Boolean)).not.toContain('Tekko Pro IGR');
  });

  test('the same visit with a cancelled first visit, or in an open-ended series, keeps treatment 1', async () => {
    visitRow = { id: VISIT, service_type: 'Flea Control Service', service_key: 'flea_tick', scheduled_date: '2026-12-15', followup_source_service_id: null, recurring_parent_id: PARENT, recurring_ongoing: false };
    parentRow = { id: PARENT, status: 'cancelled', scheduled_date: '2026-12-01', service_type: 'Flea Control Service', service_key_snapshot: 'flea_tick', recurring_ongoing: false };
    expect((await call('/match', { serviceType: 'Flea Control Service', visitId: VISIT })).matchedVisit.visit).toBe(1);
    visitRow = { ...visitRow, recurring_ongoing: true };
    parentRow = { ...parentRow, status: 'completed', recurring_ongoing: true };
    const actions = await call('/completion-actions', { serviceType: 'Flea Control Service', visitId: VISIT });
    expect(actions.visit.visit).toBe(1);
    expect(actions.actions.map((action) => action.product?.name).filter(Boolean)).toContain('Tekko Pro IGR');
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
    expect(text.match(/followup_source_service_id\s*(?:!= null)?\s*\|\|\s*await isLaterPackageVisit\(/g) || []).toHaveLength(uses);
    // Each query that feeds it selects the two link columns.
    expect((text.match(/recurring_parent_id/g) || []).length).toBeGreaterThanOrEqual(uses);
    expect((text.match(/recurring_ongoing/g) || []).length).toBeGreaterThanOrEqual(uses);
  });
});
