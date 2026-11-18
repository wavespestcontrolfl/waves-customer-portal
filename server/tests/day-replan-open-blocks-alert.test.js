/**
 * Morning open-blocks notification (services/day-replan/open-blocks-alert.js, owner 2026-11-18): one admin row a
 * morning from the latest re-plan run's close-gaps numbers, the copy passes the notification rule, and an earlier
 * morning's row closes. Fake knex, synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/admin-alert-compose', () => {
  const actual = jest.requireActual('../services/admin-alert-compose');
  return { ...actual, raiseAdminAlert: jest.fn(async () => ({ id: 'n1', deduped: false })) };
});
jest.mock('../services/admin-alert-episodes', () => ({
  openAdminAlertKeys: jest.fn(async () => []), closeAdminAlertKeys: jest.fn(async (_c, keys) => keys.length),
}));

const { composeAdminAlert, raiseAdminAlert } = require('../services/admin-alert-compose');
const { openAdminAlertKeys, closeAdminAlertKeys } = require('../services/admin-alert-episodes');
const { runOpenBlocksAlert, _internals } = require('../services/day-replan/open-blocks-alert');

const NOW = new Date('2026-11-18T12:05:00Z'); // 07:05 ET
const TECH = '00000000-0000-4000-8000-000000000001';

const rec = (blocks, extra = {}) => ({
  v: 1,
  now: { driveMin: 90, endMin: 900, waitMin: 60, biggestMin: Math.max(0, ...blocks.map((b) => b.min)), sellableMin: blocks.filter((b) => b.min >= 60).reduce((n, b) => n + b.min, 0), lunch: true, blocks },
  packed: null, p1: { wouldAccept: false, reason: 'small_gain', gainMin: 0, lunchLost: false, changes: [] }, p2: null, s1: [], gaps: [],
  ...extra,
});
const tail = (start, min) => ({ kind: 'tail', start, min, before: null });
const wait = (start, min) => ({ kind: 'wait', start, min, before: 'v1' });

function fakeConn({ run = { run_id: 'run-1' }, rows = [], techs = [{ id: TECH, name: 'Pat Tester' }] } = {}) {
  const calls = [];
  const conn = (table) => {
    const q = {
      where(...args) { calls.push([table, 'where', args]); return q; },
      whereNotNull() { return q; },
      whereIn() { return q; },
      whereBetween(...args) { calls.push([table, 'whereBetween', args]); return q; },
      orderBy() { return q; },
      first: async () => run,
      select: async () => (table === 'technicians' ? techs : rows),
    };
    return q;
  };
  conn.raw = (sql) => sql;
  return { conn, calls };
}

beforeEach(() => jest.clearAllMocks());

describe('the copy', () => {
  const sum = _internals.summarize([
    { technician_id: TECH, day: '2026-11-21', close_gaps: rec([wait(545, 45), tail(695, 325)]) },
    { technician_id: TECH, day: '2026-11-19', close_gaps: JSON.stringify(rec([tail(815, 205)])) },
  ], new Map([[TECH, 'Pat']]));

  test('counts only blocks of an hour or more, and names the biggest', () => {
    expect(sum.totalMin).toBe(530);
    expect(sum.blocks.map((b) => b.day)).toEqual(['2026-11-19', '2026-11-21']);
    expect(sum.biggest).toMatchObject({ day: '2026-11-21', start: 695, min: 325 });
  });

  test('the spec passes the admin notification rule (headline, one-sentence why, link, structured parts)', () => {
    const spec = _internals.alertSpec(sum);
    const out = composeAdminAlert(spec);
    expect(out.headline).toBe('Schedule — sell 9 open hours in the next 7 days');
    expect(out.why).toBe('Biggest block: Sat Nov 21, 11:35 AM to 5:00 PM.');
    expect(out.link).toBe('/admin/schedule?date=2026-11-21');
    expect(out.metadata).toMatchObject({ severity: 'needs-you', who: 'person', subject: { type: 'check', id: 'open-blocks' } });
  });

  test('the why adds what re-timing would free when a measured rule frees an hour or more', () => {
    const packed = { ...rec([tail(600, 420)]).now };
    const withGain = _internals.summarize([{
      technician_id: TECH, day: '2026-11-21',
      close_gaps: rec([tail(695, 325)], { packed, p1: { wouldAccept: true, reason: 'bigger_block', gainMin: 95, lunchLost: false, changes: [] } }),
    }], new Map());
    expect(withGain.freedMin).toBe(95);
    expect(composeAdminAlert(_internals.alertSpec(withGain)).why).toBe('Biggest block: Sat Nov 21, 11:35 AM to 5:00 PM; re-timing booked jobs could free 1 h 35 min more.');
  });

  test('the detail lists each block with its technician and the measuring line', () => {
    const text = _internals.detailText(sum);
    expect(text).toContain('- Thu Nov 19, Pat: 1:35 PM to 5:00 PM (3 h 25 min)');
    expect(text).toContain('- Sat Nov 21, Pat: 11:35 AM to 5:00 PM (5 h 25 min)');
    expect(text).not.toContain('9:05 AM');
    expect(text).toContain('Measuring only (no visit changes)');
  });
});

describe('runOpenBlocksAlert', () => {
  test('raises one row keyed to this morning and closes an earlier morning\'s row', async () => {
    openAdminAlertKeys.mockResolvedValueOnce(['open-blocks:2026-11-17', 'open-blocks:2026-11-18']);
    const { conn, calls } = fakeConn({ rows: [{ technician_id: TECH, day: '2026-11-21', close_gaps: rec([tail(695, 325)]) }] });
    const out = await runOpenBlocksAlert({ conn, now: NOW });
    expect(out).toMatchObject({ status: 'raised', id: 'n1', openMin: 325, closed: 1 });
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = raiseAdminAlert.mock.calls[0];
    expect(category).toBe('schedule');
    expect(spec.link).toBe('/admin/schedule?date=2026-11-21');
    expect(opts).toMatchObject({ bell: true, dedupeKey: 'open-blocks:2026-11-18' });
    expect(closeAdminAlertKeys).toHaveBeenCalledWith(conn, ['open-blocks:2026-11-17'], 'next_morning_replaces', expect.any(Object));
    // Tomorrow through 7 days out, in ET.
    expect(calls).toContainEqual(['day_replan_plans', 'whereBetween', ['service_date', ['2026-11-19', '2026-11-25']]]);
  });

  test('no fresh re-plan run: nothing is raised or closed', async () => {
    const { conn } = fakeConn({ run: null });
    await expect(runOpenBlocksAlert({ conn, now: NOW })).resolves.toEqual({ status: 'no_run' });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('no open hour left: nothing is raised and every open morning row closes', async () => {
    openAdminAlertKeys.mockResolvedValueOnce(['open-blocks:2026-11-17']);
    const { conn } = fakeConn({ rows: [{ technician_id: TECH, day: '2026-11-21', close_gaps: rec([wait(545, 45)]) }] });
    await expect(runOpenBlocksAlert({ conn, now: NOW })).resolves.toEqual({ status: 'no_open_hours', closed: 1 });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(closeAdminAlertKeys).toHaveBeenCalledWith(conn, ['open-blocks:2026-11-17'], 'next_morning_replaces', expect.any(Object));
  });
});
