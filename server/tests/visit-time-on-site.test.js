const fs = require('fs');
const path = require('path');

jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
const logger = require('../services/logger');
const {
  loadGpsOnSiteMinutes, pickMeasuredOnSite, resolveVisitTimeOnSite, resetTableCache,
} = require('../services/visit-time-on-site');
const { computeOnSiteMin } = require('../services/service-report/metrics-band');

// Chainable knex stand-in: records the calls and resolves select() with the given rows.
function fakeConn({ rows = [], hasTable = true, selectError = null } = {}) {
  const calls = [];
  const conn = jest.fn((table) => {
    const builder = {
      whereIn: (...args) => { calls.push(['whereIn', table, ...args]); return builder; },
      where: (...args) => { calls.push(['where', table, ...args]); return builder; },
      select: async () => { if (selectError) throw selectError; return rows; },
    };
    return builder;
  });
  conn.schema = { hasTable: jest.fn(async () => hasTable) };
  return { conn, calls };
}

beforeEach(() => { resetTableCache(); jest.clearAllMocks(); });

describe('loadGpsOnSiteMinutes', () => {
  test('asks once for matched legs of all ids and keeps only believable minutes', async () => {
    const { conn, calls } = fakeConn({ rows: [
      { scheduled_service_id: 'a', gps_on_site_minutes: '34.00' },
      { scheduled_service_id: 'b', gps_on_site_minutes: 480 },
      { scheduled_service_id: 'c', gps_on_site_minutes: '481' },
      { scheduled_service_id: 'd', gps_on_site_minutes: 0 },
      { scheduled_service_id: 'e', gps_on_site_minutes: null },
      { scheduled_service_id: 'f', gps_on_site_minutes: 'abc' },
    ] });
    const result = await loadGpsOnSiteMinutes(conn, ['a', 'b', 'c', 'd', 'e', 'f', 'a', null]);
    expect([...result]).toEqual([['a', 34], ['b', 480]]);
    expect(conn).toHaveBeenCalledTimes(1);
    expect(calls).toContainEqual(['where', 'visit_gps_legs', { status: 'matched' }]);
    expect(calls.find(([method]) => method === 'whereIn')[3]).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  test('no ids, no query', async () => {
    const { conn } = fakeConn();
    expect((await loadGpsOnSiteMinutes(conn, [])).size).toBe(0);
    expect(conn).not.toHaveBeenCalled();
  });

  test('a missing table gives an empty map without a warning', async () => {
    const { conn } = fakeConn({ hasTable: false, rows: [{ scheduled_service_id: 'a', gps_on_site_minutes: 30 }] });
    expect((await loadGpsOnSiteMinutes(conn, ['a'])).size).toBe(0);
    expect(conn).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('a read error never reaches the caller: empty map and a warning', async () => {
    const { conn } = fakeConn({ selectError: new Error('connection reset') });
    expect((await loadGpsOnSiteMinutes(conn, ['a'])).size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('connection reset'));
    resetTableCache();
    const broken = { schema: { hasTable: async () => { throw new Error('boom'); } } };
    expect((await loadGpsOnSiteMinutes(broken, ['a'])).size).toBe(0);
  });
});

describe('precedence: corrected by hand, then GPS, then what is shown today', () => {
  test('a hand correction beats GPS', () => {
    expect(pickMeasuredOnSite({ correctedMinutes: 30, gpsMinutes: 34 })).toEqual({ minutes: 30, evidence: 'operator_corrected' });
  });

  test('GPS is picked when there is a believable matched leg; a junk or missing one does not count', () => {
    expect(pickMeasuredOnSite({ gpsMinutes: 34 })).toEqual({ minutes: 34, evidence: 'gps_measured' });
    for (const gpsMinutes of [undefined, null, 0, -5, 481, NaN]) expect(pickMeasuredOnSite({ gpsMinutes })).toBeNull();
  });

  test('resolveVisitTimeOnSite: no leg returns today\'s exact value, marked not GPS', () => {
    expect(resolveVisitTimeOnSite({ adjustedMinutes: null, gpsMinutes: undefined, fallbackMinutes: 95 })).toEqual({ minutes: 95, evidence: 'not_gps' });
    expect(resolveVisitTimeOnSite({ fallbackMinutes: null })).toEqual({ minutes: null, evidence: 'not_gps' });
    expect(resolveVisitTimeOnSite({ adjustedMinutes: 40, gpsMinutes: 34, fallbackMinutes: 95 })).toEqual({ minutes: 40, evidence: 'operator_corrected' });
    expect(resolveVisitTimeOnSite({ gpsMinutes: 34, fallbackMinutes: 95 })).toEqual({ minutes: 34, evidence: 'gps_measured' });
  });

  test('a no_stop leg is ignored: the loader asks for matched legs only', async () => {
    // The status filter is the loader's; a table holding only a no_stop row returns nothing to the query.
    const { conn, calls } = fakeConn({ rows: [] });
    const result = await loadGpsOnSiteMinutes(conn, ['a']);
    expect(resolveVisitTimeOnSite({ gpsMinutes: result.get('a'), fallbackMinutes: 70 })).toEqual({ minutes: 70, evidence: 'not_gps' });
    expect(calls).toContainEqual(['where', 'visit_gps_legs', { status: 'matched' }]);
  });
});

describe('the customer report and job cost do not read GPS minutes', () => {
  test('computeOnSiteMin ignores a GPS leg field on the record', () => {
    const record = { started_at: '2026-11-10T14:00:00Z', ended_at: '2026-11-10T15:30:00Z' };
    expect(computeOnSiteMin(record)).toBe(90);
    expect(computeOnSiteMin({ ...record, gps_on_site_minutes: 34, gpsOnSiteMinutes: 34 })).toBe(90);
    expect(computeOnSiteMin({ timeOnSite: '45:00', gps_on_site_minutes: 34 })).toBe(45);
  });

  test('no customer-facing or costing file imports the GPS reader', () => {
    const root = path.join(__dirname, '..');
    const files = ['services/job-costing.js', 'services/job-cost-recost.js', 'services/complete-scheduled-service.js',
      'services/trip-link.js', 'routes/reports-public.js'];
    const reportDir = path.join(root, 'services/service-report');
    for (const name of fs.readdirSync(reportDir)) if (name.endsWith('.js')) files.push(`services/service-report/${name}`);
    for (const file of files) {
      expect(fs.readFileSync(path.join(root, file), 'utf8')).not.toMatch(/visit-time-on-site/);
    }
  });
});
