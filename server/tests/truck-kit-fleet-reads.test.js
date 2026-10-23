/**
 * truck-kit.js fleet reads (scope PR 3): openToolAlerts (every open tool
 * alert with item, truck and holder), matchReceiptToOpenAlert (one alert
 * whose item name the purchase title contains; two is no match) and
 * trucksOverview (every live truck with kit size, open issues, last check).
 * The db is a fake keyed by the exact table expression each read uses.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const truckKit = require('../services/truck-kit');

function fakeConn(tables) {
  const calls = [];
  const conn = (table) => {
    const rows = () => (typeof tables[table] === 'function' ? tables[table](c) : tables[table]) || [];
    const c = { table, cond: [] };
    for (const m of ['join', 'leftJoin', 'whereIn', 'whereNotIn', 'orderBy', 'select']) c[m] = (...a) => { calls.push([table, m, ...a]); return c; };
    c.where = (...a) => { calls.push([table, 'where', ...a]); c.cond.push(a); return c; };
    c.first = async () => rows()[0] || null;
    c.then = (res, rej) => Promise.resolve(rows()).then(res, rej);
    return c;
  };
  conn.calls = calls;
  return conn;
}

const ALERT = (over) => ({ id: 'a1', alert_type: 'tool_missing', status: 'new', description: 'left at the shop', created_at: '2026-10-20T12:00:00Z',
  equipment_id: 'e1', name: 'Moisture meter', kit_key: 'moisture_meter', category: 'tool', vehicle_id: 'v1', vehicle_name: 'Truck 1', technician_name: 'Synthetic tech', ...over });

test('openToolAlerts joins item, truck and holder and keeps only open tool alerts', async () => {
  const conn = fakeConn({ 'maintenance_alerts as a': [ALERT()] });
  const out = await truckKit.openToolAlerts(conn);
  expect(out).toEqual([ALERT()]);
  const whereIns = conn.calls.filter(([, m]) => m === 'whereIn').map(([, , col, vals]) => [col, vals]);
  expect(whereIns).toEqual([['a.alert_type', ['tool_missing', 'tool_damaged']], ['a.status', ['new', 'acknowledged']]]);
  expect(conn.calls.filter(([, m]) => m === 'join' || m === 'leftJoin').map(([, , t]) => t)).toEqual(['equipment as e', 'equipment as v', 'technicians as t']);
});

describe('matchReceiptToOpenAlert', () => {
  test('every word of the item name (3+ letters) in the title = the match', async () => {
    const conn = fakeConn({ 'maintenance_alerts as a': [ALERT()] });
    expect((await truckKit.matchReceiptToOpenAlert('Extech MO55 Pin/Pinless Moisture Meter', conn)).equipment_id).toBe('e1');
    expect(await truckKit.matchReceiptToOpenAlert('Extech moisture reader', conn)).toBeNull();
    expect(await truckKit.matchReceiptToOpenAlert('', conn)).toBeNull();
  });

  test('two matching alerts is no match (the office picks); an item with no 3-letter word never matches', async () => {
    const conn = fakeConn({ 'maintenance_alerts as a': [ALERT(), ALERT({ id: 'a2', equipment_id: 'e2', name: 'Meter' })] });
    expect(await truckKit.matchReceiptToOpenAlert('Moisture Meter', conn)).toBeNull();
    const short = fakeConn({ 'maintenance_alerts as a': [ALERT({ name: 'B 2' })] });
    expect(await truckKit.matchReceiptToOpenAlert('B 2 thing', short)).toBeNull();
  });
});

test('trucksOverview: every live truck with holder, kit counts, open issues and last check', async () => {
  const conn = fakeConn({
    'equipment as v': [{ id: 'v1', name: 'Truck 1', asset_tag: 'VEH-1', assigned_to: 't1', technician_name: 'Synthetic tech' }, { id: 'v2', name: 'Truck 2', asset_tag: null, assigned_to: null, technician_name: null }],
    equipment: (c) => (c.cond[0][0].assigned_vehicle_id === 'v1' ? [{ id: 'e1', name: 'Moisture meter', kit_key: 'moisture_meter', category: 'tool' }, { id: 'e2', name: 'Duster', kit_key: null, category: 'tool' }] : []),
    maintenance_alerts: [{ equipment_id: 'e2', alert_type: 'tool_damaged' }],
    'equipment_checks as c': (c) => (c.cond[0][1] === 'v1' ? [{ id: 'c1', checked_at: '2026-10-01T12:00:00Z', missing_count: 0, damaged_count: 1 }] : []),
  });
  const out = await truckKit.trucksOverview(conn);
  expect(out).toEqual([
    { id: 'v1', name: 'Truck 1', asset_tag: 'VEH-1', technician_name: 'Synthetic tech', items: 2, keyed_items: 1, open_issues: [{ name: 'Duster', issue: 'damaged' }], last_check_at: '2026-10-01T12:00:00Z', due: true },
    { id: 'v2', name: 'Truck 2', asset_tag: null, technician_name: null, items: 0, keyed_items: 0, open_issues: [], last_check_at: null, due: false },
  ]);
  expect(conn.calls.find(([t, m]) => t === 'equipment as v' && m === 'whereNotIn')).toEqual(['equipment as v', 'whereNotIn', 'v.status', ['retired', 'sold', 'lost']]);
});
