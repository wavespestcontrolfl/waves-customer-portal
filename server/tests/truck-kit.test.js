/**
 * services/truck-kit.js — the truck check (GATE_TRUCK_KIT): a technician's
 * truck is the vehicle row assigned to them, its kit is the rows on that
 * truck, a check writes one equipment_checks row, missing or damaged items
 * open tool alerts (deduped on the open one), present items close their own,
 * and one office bell per truck rings and clears itself.
 *
 * db is a small in-memory fake over four tables covering exactly the query
 * shapes the service issues. reportEquipmentIssue, raiseAdminAlert and the
 * alert-episode close are mocked; the captured bell spec is run through the
 * REAL composeAdminAlert so the copy rules (docs/admin-notifications.md)
 * are proven, not assumed. No Postgres.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ truckKitLive: jest.fn(() => true), gateEnvValue: jest.fn(() => false), isEnabled: jest.fn(() => false) }));
jest.mock('../models/db', () => {
  const state = { equipment: [], maintenance_alerts: [], equipment_checks: [], technicians: [], equipment_checklists: [], scheduled_services: [], scheduled_service_addons: [] };
  const norm = (col) => String(col).split('.').pop();
  const chain = (name) => {
    const table = String(name).split(' as ')[0];
    const c = { table, preds: [], order: [], patch: null, inserted: null, joins: [] };
    const add = (fn) => { c.preds.push(fn); return c; };
    c.where = (...args) => {
      if (args.length === 1 && typeof args[0] === 'object') return add((r) => Object.entries(args[0]).every(([k, v]) => r[norm(k)] === v));
      if (args.length === 2) return add((r) => r[norm(args[0])] === args[1]);
      throw new Error(`fake db: unsupported where ${JSON.stringify(args)}`);
    };
    c.whereIn = (col, vals) => add((r) => vals.includes(r[norm(col)]));
    c.whereNotIn = (col, vals) => add((r) => !vals.includes(r[norm(col)]));
    c.whereNull = (col) => add((r) => r[norm(col)] == null);
    c.whereNotNull = (col) => add((r) => r[norm(col)] != null);
    c.whereNot = (col, val) => add((r) => r[norm(col)] !== val);
    c.distinct = (...cols) => { c.cols = cols; c.distinctOn = cols; return c; };
    c.limit = (n) => { c.lim = n; return c; };
    c.leftJoin = (...args) => { c.joins.push(args); return c; };
    c.join = (...args) => { c.joins.push(args); return c; };
    c.orderBy = (...args) => {
      if (Array.isArray(args[0])) c.order = args[0].map((o) => ({ col: norm(o.column), dir: o.order || 'asc' }));
      else c.order = [{ col: norm(args[0]), dir: args[1] || 'asc' }];
      return c;
    };
    // Column projection like knex: 'c.id', 't.name as technician_name'.
    const project = (row, cols) => {
      if (!cols.length) return row;
      const out = {};
      for (const col of cols) {
        const [source, alias] = String(col).split(' as ');
        // A joined alias (t.name as technician_name) was already resolved by the join emulation.
        out[alias || norm(source)] = alias && row[alias] !== undefined ? row[alias] : row[norm(source)];
      }
      return out;
    };
    c.select = (...cols) => { c.cols = cols; return c; };
    c.insert = (row) => { c.inserted = row; return c; };
    c.update = (patch) => { c.patch = patch; return c; };
    const rows = () => {
      let list = state[table] || [];
      if (table === 'maintenance_alerts' && c.joins.length) {
        list = list.map((a) => ({ ...a, assigned_vehicle_id: (state.equipment.find((e) => e.id === a.equipment_id) || {}).assigned_vehicle_id }));
      }
      if (table === 'equipment_checks' && c.joins.length) {
        list = list.map((k) => ({ ...k, technician_name: (state.technicians.find((t) => t.id === k.technician_id) || {}).name || null }));
      }
      list = list.filter((r) => c.preds.every((p) => p(r)));
      for (const { col, dir } of [...c.order].reverse()) {
        list = [...list].sort((a, b) => {
          const x = a[col] instanceof Date ? a[col].getTime() : a[col];
          const y = b[col] instanceof Date ? b[col].getTime() : b[col];
          const cmp = x < y ? -1 : x > y ? 1 : 0;
          return dir === 'desc' ? -cmp : cmp;
        });
      }
      return c.lim ? list.slice(0, c.lim) : list;
    };
    c.first = async (...cols) => { const row = rows()[0]; return row ? project(row, cols) : null; };
    c.returning = async () => {
      const row = { id: `${table}-${state[table].length + 1}`, ...c.inserted };
      state[table].push(row);
      return [row];
    };
    c.then = (resolve, reject) => {
      let out;
      if (c.patch) {
        out = 0;
        for (const r of state[table]) if (c.preds.every((p) => p(r))) { Object.assign(r, c.patch); out += 1; }
      } else {
        out = rows().map((r) => project(r, c.cols || []));
        if (c.distinctOn) out = out.filter((r, i, all) => all.findIndex((x) => JSON.stringify(x) === JSON.stringify(r)) === i);
      }
      return Promise.resolve(out).then(resolve, reject);
    };
    return c;
  };
  const db = (name) => chain(name);
  db.__state = state;
  db.raw = jest.fn(async () => ({ rows: [] }));
  // A transaction over the in-memory tables: the callback runs on the same
  // handle, and a throw restores every table (so a test can prove rollback).
  db.transaction = jest.fn(async (fn) => {
    const snapshot = JSON.parse(JSON.stringify(state));
    try {
      return await fn(db);
    } catch (err) {
      for (const key of Object.keys(state)) state[key] = snapshot[key];
      throw err;
    }
  });
  return db;
});
jest.mock('../services/equipment-maintenance', () => ({
  reportEquipmentIssue: jest.fn(async (args) => {
    const db = require('../models/db');
    const row = {
      id: `alert-${db.__state.maintenance_alerts.length + 1}`, equipment_id: args.equipmentId, alert_type: args.alertType,
      severity: args.severity, title: args.title, description: args.description, status: 'new', created_at: new Date(),
    };
    db.__state.maintenance_alerts.push(row);
    return row;
  }),
}));
jest.mock('../services/admin-alert-compose', () => {
  const real = jest.requireActual('../services/admin-alert-compose');
  return { ...real, raiseAdminAlert: jest.fn(async () => ({ id: 'bell-1' })) };
});
jest.mock('../services/admin-alert-episodes', () => ({ closeAdminAlertKeys: jest.fn(async () => 1) }));

const db = require('../models/db');
const { reportEquipmentIssue } = require('../services/equipment-maintenance');
const { raiseAdminAlert, composeAdminAlert } = require('../services/admin-alert-compose');
const { closeAdminAlertKeys } = require('../services/admin-alert-episodes');
const truckKit = require('../services/truck-kit');

const TECH = '11111111-2222-4333-8444-555555555555';
const TRUCK = '22222222-2222-4333-8444-555555555555';
const METER = '33333333-2222-4333-8444-555555555555';
const SPRAYER = '44444444-2222-4333-8444-555555555555';
const RETIRED = '55555555-2222-4333-8444-555555555555';
const NOW = new Date('2026-10-23T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000);

function seed({ truckAssigned = true } = {}) {
  const s = db.__state;
  s.technicians = [{ id: TECH, name: 'Synthetic Tech' }];
  s.equipment = [
    { id: TRUCK, name: 'Ford Transit 250 AWD', asset_tag: 'VEH-001', category: 'vehicle', status: 'active', assigned_to: truckAssigned ? TECH : null },
    { id: METER, name: 'Moisture meter', asset_tag: 'T-002', category: 'tool', status: 'active', assigned_vehicle_id: TRUCK, condition_rating: 8 },
    { id: SPRAYER, name: 'B&G 1 gal. sprayer', asset_tag: 'T-001', category: 'sprayer', status: 'active', assigned_vehicle_id: TRUCK, condition_rating: 7 },
    { id: RETIRED, name: 'Old duster', category: 'tool', status: 'retired', assigned_vehicle_id: TRUCK },
  ];
  s.maintenance_alerts = [];
  s.equipment_checks = [];
  s.equipment_checklists = [];
  s.scheduled_services = [];
  s.scheduled_service_addons = [];
}

beforeEach(() => {
  jest.clearAllMocks();
  seed();
});

describe('truckKitStatus', () => {
  test('no truck assigned: nothing due, nothing listed', async () => {
    seed({ truckAssigned: false });
    expect(await truckKit.truckKitStatus(TECH, { now: NOW })).toEqual({ enabled: true, truck: null, kit: [], lastCheck: null, due: false, intervalDays: 7, gaps: [] });
  });

  test('lists the live rows on the truck, never a retired one, and is due with no check on record', async () => {
    const status = await truckKit.truckKitStatus(TECH, { now: NOW });
    expect(status.truck).toEqual({ id: TRUCK, name: 'Ford Transit 250 AWD', asset_tag: 'VEH-001' });
    expect(status.kit.map((i) => i.name)).toEqual(['B&G 1 gal. sprayer', 'Moisture meter']);
    expect(status.kit.every((i) => i.open_issue === null)).toBe(true);
    expect(status.lastCheck).toBeNull();
    expect(status.due).toBe(true);
  });

  test('a check 3 days ago is not due, 8 days ago is, and an open tool alert rides along as open_issue', async () => {
    db.__state.equipment_checks.push({ id: 'k1', vehicle_id: TRUCK, technician_id: TECH, checked_at: daysAgo(3), item_count: 2, missing_count: 0, damaged_count: 0 });
    let status = await truckKit.truckKitStatus(TECH, { now: NOW });
    expect(status.due).toBe(false);
    expect(status.lastCheck).toEqual(expect.objectContaining({ id: 'k1', technician_name: 'Synthetic Tech' }));

    db.__state.equipment_checks = [{ id: 'k0', vehicle_id: TRUCK, technician_id: TECH, checked_at: daysAgo(8), item_count: 2, missing_count: 1, damaged_count: 0 }];
    db.__state.maintenance_alerts.push({ id: 'a1', equipment_id: METER, alert_type: 'tool_missing', status: 'new', created_at: daysAgo(8) });
    status = await truckKit.truckKitStatus(TECH, { now: NOW });
    expect(status.due).toBe(true);
    expect(status.kit.find((i) => i.id === METER).open_issue).toBe('missing');
  });

  test('an empty kit is never due', async () => {
    db.__state.equipment = db.__state.equipment.filter((e) => e.category === 'vehicle');
    const status = await truckKit.truckKitStatus(TECH, { now: NOW });
    expect(status.kit).toEqual([]);
    expect(status.due).toBe(false);
  });
});

describe('recordTruckCheck', () => {
  const results = (meter, sprayer, notes = {}) => [
    { equipmentId: METER, state: meter, note: notes.meter },
    { equipmentId: SPRAYER, state: sprayer, note: notes.sprayer },
  ];

  test('refuses a technician with no truck', async () => {
    seed({ truckAssigned: false });
    await expect(truckKit.recordTruckCheck({ technicianId: TECH, results: [], now: NOW })).rejects.toMatchObject({ code: 'no_truck' });
  });

  test('two live trucks on one technician: the check and the status refuse, readiness shows a hold', async () => {
    db.__state.equipment.push({ id: '77777777-2222-4333-8444-555555555555', name: 'Second van', category: 'vehicle', status: 'active', assigned_to: TECH });
    await expect(truckKit.recordTruckCheck({ technicianId: TECH, results: results('present', 'present'), now: NOW })).rejects.toMatchObject({ code: 'ambiguous_truck' });
    await expect(truckKit.truckKitStatus(TECH, { now: NOW })).rejects.toMatchObject({ code: 'ambiguous_truck' });
    db.__state.equipment.find((e) => e.id === SPRAYER).kit_key = 'bg_sprayer';
    expect(await truckKit.toolGapIssue({ technicianId: TECH, serviceLine: 'termite' })).toEqual({ kind: 'tools', status: 'hold', label: 'Two trucks assigned to the technician', tools: [] });
    expect(db.__state.equipment_checks).toHaveLength(0);
  });

  test('a truck handed to someone else while the check was open writes nothing', async () => {
    // The lock is where the office's handover lands: once taken, the truck is no longer this technician's.
    db.raw.mockImplementationOnce(async () => { db.__state.equipment.find((e) => e.id === TRUCK).assigned_to = 'someone-else'; return { rows: [] }; });
    await expect(truckKit.recordTruckCheck({ technicianId: TECH, results: results('present', 'present'), now: NOW })).rejects.toMatchObject({ code: 'kit_changed' });
    expect(db.__state.equipment_checks).toHaveLength(0);
  });

  test('openToolAlertFor finds the open tool alert on one item only', async () => {
    db.__state.maintenance_alerts.push({ id: 'a1', equipment_id: METER, alert_type: 'tool_missing', status: 'resolved' }, { id: 'a2', equipment_id: METER, alert_type: 'maintenance_due', status: 'new' });
    expect(await truckKit.openToolAlertFor(METER)).toBeNull();
    db.__state.maintenance_alerts.push({ id: 'a3', equipment_id: METER, alert_type: 'tool_damaged', status: 'acknowledged' });
    expect(await truckKit.openToolAlertFor(METER)).toEqual({ id: 'a3' });
  });

  test('refuses bad results and a list that no longer matches the kit', async () => {
    await expect(truckKit.recordTruckCheck({ technicianId: TECH, results: 'nope', now: NOW })).rejects.toMatchObject({ code: 'invalid_results' });
    await expect(truckKit.recordTruckCheck({ technicianId: TECH, results: [{ equipmentId: METER, state: 'gone' }], now: NOW })).rejects.toMatchObject({ code: 'invalid_results' });
    const changed = truckKit.recordTruckCheck({ technicianId: TECH, results: [{ equipmentId: METER, state: 'present' }], now: NOW });
    await expect(changed).rejects.toMatchObject({ code: 'kit_changed', kit: expect.arrayContaining([expect.objectContaining({ id: SPRAYER })]) });
    expect(db.__state.equipment_checks).toHaveLength(0);
  });

  test('a clean check writes one row, opens no alert and closes the truck bell', async () => {
    const out = await truckKit.recordTruckCheck({ technicianId: TECH, results: results('present', 'present'), now: NOW });
    expect(out.check).toEqual(expect.objectContaining({ item_count: 2, missing_count: 0, damaged_count: 0 }));
    const [row] = db.__state.equipment_checks;
    expect(row).toEqual(expect.objectContaining({ vehicle_id: TRUCK, technician_id: TECH, checked_at: NOW, item_count: 2 }));
    // jsonb takes a string, never a JS array (waves-db 5d).
    expect(typeof row.results).toBe('string');
    expect(JSON.parse(row.results)).toEqual([
      { equipment_id: SPRAYER, state: 'present', note: '' },
      { equipment_id: METER, state: 'present', note: '' },
    ]);
    expect(reportEquipmentIssue).not.toHaveBeenCalled();
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(closeAdminAlertKeys).toHaveBeenCalledWith(expect.anything(), [`truck-kit:${TRUCK}`], 'tool_alerts_resolved', expect.objectContaining({ now: NOW }));
    // One transaction per check, serialized per truck.
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext(?))', [`truck-kit:${TRUCK}`]);
  });

  test('the check row, its alerts and the bell commit together: a failed bell leaves no check behind', async () => {
    raiseAdminAlert.mockRejectedValueOnce(new Error('notifications down'));
    await expect(truckKit.recordTruckCheck({ technicianId: TECH, results: results('missing', 'present'), now: NOW })).rejects.toThrow('notifications down');
    expect(db.__state.equipment_checks).toHaveLength(0);
    expect(db.__state.maintenance_alerts).toHaveLength(0);
    expect((await truckKit.truckKitStatus(TECH, { now: NOW })).due).toBe(true);
  });

  test('missing and damaged items open one alert each and ring one bell whose copy passes the rule', async () => {
    await truckKit.recordTruckCheck({ technicianId: TECH, results: results('missing', 'damaged', { sprayer: 'Pump leaks' }), now: NOW });
    expect(reportEquipmentIssue).toHaveBeenCalledTimes(2);
    expect(reportEquipmentIssue).toHaveBeenCalledWith(expect.objectContaining({
      equipmentId: METER, technicianId: TECH, alertType: 'tool_missing', severity: 'high', adjustCondition: false,
      title: 'Missing: Moisture meter T-002 (truck check by Synthetic Tech)',
    }));
    expect(reportEquipmentIssue).toHaveBeenCalledWith(expect.objectContaining({
      equipmentId: SPRAYER, alertType: 'tool_damaged', adjustCondition: true, description: expect.stringContaining('Pump leaks'),
    }));
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = raiseAdminAlert.mock.calls[0];
    expect(category).toBe('truck_kit');
    // The real composer throws on any copy-rule break (NODE_ENV=test).
    const composed = composeAdminAlert(spec);
    expect(composed.headline).toBe('Inventory — find or replace 2 tools on VEH-001');
    expect(composed.why).toBe('Synthetic found missing Moisture meter and damaged B&G 1 gal sprayer on the truck check');
    expect(composed.metadata).toEqual(expect.objectContaining({ subject: { type: 'equipment', id: TRUCK }, doneWhen: 'tool_alerts_resolved', who: 'person' }));
    // bellDefault, not bell: the owner can silence the truck_kit category in Settings.
    expect(opts).toEqual(expect.objectContaining({ dedupeKey: `truck-kit:${TRUCK}`, dedupeOpenOnly: true, refreshOnDedupe: true, bellDefault: true, trx: expect.anything(), dedupeVersion: expect.stringMatching(/^check:/) }));
    expect(opts.bell).toBeUndefined();
    expect(require('../services/notification-bell-policy').OVERRIDABLE_CATEGORIES).toContain('truck_kit');
    expect(reportEquipmentIssue.mock.calls.every(([args]) => args.conn)).toBe(true);
    expect(opts.detail).toBe('Missing: Moisture meter (T-002)\nDamaged: B&G 1 gal. sprayer (T-001) · Pump leaks');
    expect(closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('the same item still missing refreshes its open alert instead of doubling it; marking it present closes it', async () => {
    await truckKit.recordTruckCheck({ technicianId: TECH, results: results('missing', 'present'), now: daysAgo(7) });
    expect(db.__state.maintenance_alerts).toHaveLength(1);
    await truckKit.recordTruckCheck({ technicianId: TECH, results: results('missing', 'present', { meter: 'Still gone' }), now: NOW });
    expect(reportEquipmentIssue).toHaveBeenCalledTimes(1);
    expect(db.__state.maintenance_alerts).toHaveLength(1);
    expect(db.__state.maintenance_alerts[0]).toEqual(expect.objectContaining({ status: 'new', description: expect.stringContaining('Still gone'), updated_at: NOW }));
    expect(raiseAdminAlert).toHaveBeenCalledTimes(2);
    // A repeat with no note keeps the earlier description (where it was last seen).
    await truckKit.recordTruckCheck({ technicianId: TECH, results: results('missing', 'present'), now: NOW });
    expect(db.__state.maintenance_alerts).toHaveLength(1);
    expect(db.__state.maintenance_alerts[0].description).toContain('Still gone');

    await truckKit.recordTruckCheck({ technicianId: TECH, results: results('present', 'present'), now: NOW });
    expect(db.__state.maintenance_alerts[0]).toEqual(expect.objectContaining({ status: 'resolved', resolved_at: NOW, resolved_by: 'truck check by Synthetic Tech' }));
    expect(closeAdminAlertKeys).toHaveBeenCalledTimes(1);
  });

  test('a tool that was missing and is now damaged keeps one open alert', async () => {
    await truckKit.recordTruckCheck({ technicianId: TECH, results: results('missing', 'present'), now: daysAgo(7) });
    await truckKit.recordTruckCheck({ technicianId: TECH, results: results('damaged', 'present'), now: NOW });
    const open = db.__state.maintenance_alerts.filter((a) => a.status === 'new');
    expect(open).toHaveLength(1);
    expect(open[0]).toEqual(expect.objectContaining({ equipment_id: METER, alert_type: 'tool_damaged' }));
    expect(db.__state.maintenance_alerts.find((a) => a.alert_type === 'tool_missing')).toEqual(expect.objectContaining({ status: 'resolved', resolved_by: 'truck check by Synthetic Tech: now damaged' }));
  });

  test('a very long truck name still fits the headline', () => {
    const spec = truckKit.bellSpec({
      truck: { id: TRUCK, name: 'A truck with an unreasonably long display name for the fleet list', asset_tag: null },
      technician: { name: 'Synthetic Tech' }, missing: [{ name: 'Flashlight' }], damaged: [],
    });
    expect(composeAdminAlert(spec).headline.length).toBeLessThanOrEqual(60);
  });
});

describe('closeTruckBellIfClear', () => {
  test('leaves the bell while a tool alert on the truck is open, closes it once none is', async () => {
    db.__state.maintenance_alerts.push({ id: 'a1', equipment_id: METER, alert_type: 'tool_missing', status: 'acknowledged' });
    expect(await truckKit.closeTruckBellIfClear(TRUCK, NOW)).toBe(false);
    expect(closeAdminAlertKeys).not.toHaveBeenCalled();
    db.__state.maintenance_alerts[0].status = 'resolved';
    expect(await truckKit.closeTruckBellIfClear(TRUCK, NOW)).toBe(true);
    expect(closeAdminAlertKeys).toHaveBeenCalledTimes(1);
  });

  test('a maintenance alert that is not a tool alert never holds the bell', async () => {
    db.__state.maintenance_alerts.push({ id: 'a1', equipment_id: METER, alert_type: 'maintenance_due', status: 'new' });
    expect(await truckKit.closeTruckBellIfClear(TRUCK, NOW)).toBe(true);
  });
});

test('checkDue: never checked, or 7 or more days ago', () => {
  expect(truckKit.checkDue(null, NOW)).toBe(true);
  expect(truckKit.checkDue(daysAgo(6.9), NOW)).toBe(false);
  expect(truckKit.checkDue(daysAgo(7), NOW)).toBe(true);
  expect(truckKit.checkDue('not a date', NOW)).toBe(true);
});

// PR 2: the job-type gap check. Keys on checklist items name required tools;
// a truck with keyed rows that lacks one is a gap, for the readiness strip and
// the technician's Today page.
describe('tool gaps by kit key', () => {
  const CHECKLIST = (line, items) => ({ id: `c-${line}`, service_line: line, checklist_items: JSON.stringify([{ category: 'Inspection', items }]) });
  const seedKeys = () => {
    db.__state.equipment_checklists = [
      CHECKLIST('termite', [
        { item: 'Moisture meter', required: true, kit_key: 'moisture_meter' },
        { item: 'Foam drill kit', required: false, kit_key: 'foam_drill_kit' },
        { item: 'Product label available', required: true },
      ]),
      CHECKLIST('pest', [{ item: 'B&G 1 gal sprayer (interior)', required: true, kit_key: 'bg_sprayer' }, { item: 'Flashlight', required: true, kit_key: 'flashlight' }]),
    ];
    db.__state.scheduled_services = [];
  };
  beforeEach(seedKeys);

  test('a combined job reads every line its name mentions, once each', () => {
    expect(truckKit.serviceLinesFor('Quarterly Pest + Termite Bait Station')).toEqual(['pest', 'termite']);
    expect(truckKit.serviceLinesFor('Pest & Rodent Control')).toEqual(['pest', 'rodent']);
    expect(truckKit.serviceLinesFor('Termite Inspection')).toEqual(['termite']);
    expect(truckKit.serviceLinesFor('Lawn Pest Treatment')).toEqual(['lawn', 'pest']);
    expect(truckKit.serviceLinesFor('')).toEqual([]);
  });

  test('a consultation needs no treatment tools; a diagnostic inspection still does', () => {
    expect(truckKit.serviceLinesFor('Waves Assessment')).toEqual([]);
    expect(truckKit.serviceLinesFor('Property Review', { serviceKey: 'waves_assessment' })).toEqual([]);
    expect(truckKit.serviceLinesFor('Lawn Consultation')).toEqual([]);
    expect(truckKit.serviceLinesFor('New Customer Property Inspection', { serviceKey: 'new_customer_inspection' })).toEqual([]);
    expect(truckKit.serviceLinesFor('New Customer Property Inspection')).toEqual([]);
    expect(truckKit.serviceLinesFor('Pest Inspection Service', { serviceKey: 'pest_inspection' })).toEqual([]);
    expect(truckKit.serviceLinesFor('Pest Inspection Service')).toEqual([]);
    // The misting design visit is a consultation by the shared predicate; a misting service still needs the sprayer.
    expect(truckKit.serviceLinesFor('Mosquito Misting System', { serviceKey: 'mosquito_misting_system' })).toEqual([]);
    expect(truckKit.serviceLinesFor('Mosquito Misting System Refill')).toEqual(['mosquito']);
    // Catalog category "inspection" is NOT an exemption: the WDO letter needs the meter and probe.
    expect(truckKit.serviceLinesFor('WDO Inspection (Termite Letter)', { serviceKey: 'wdo_inspection' })).toEqual(['termite']);
    expect(truckKit.serviceLinesFor('Lawn Health Inspection', { serviceKey: 'lawn_inspection' })).toEqual(['lawn']);
    // The lawn_inspection row was renamed "Lawn Assessment": the key wins over the consultation-looking name.
    expect(truckKit.serviceLinesFor('Lawn Assessment', { serviceKey: 'lawn_inspection' })).toEqual(['lawn']);
    expect(truckKit.serviceLinesFor('Lawn Assessment')).toEqual([]);
  });

  test('a bait station or foam job promotes its optional kit to required', async () => {
    db.__state.equipment_checklists = [CHECKLIST('termite', [
      { item: 'Moisture meter', required: true, kit_key: 'moisture_meter' },
      { item: 'Bait station keys and replacement cartridges', required: false, kit_key: 'bait_station_key' },
      { item: 'Foam drill kit and patch materials', required: false, kit_key: 'foam_drill_kit' },
    ])];
    expect(truckKit.requirementsFor('Termite Bait Station System', { serviceKey: 'termite_bait' })).toEqual({ lines: ['termite'], promote: new Set(['bait_station_key']) });
    expect(truckKit.requirementsFor('Drill and Foam Treatment', { serviceKey: 'foam_drill' }).promote).toEqual(new Set(['foam_drill_kit']));
    expect(truckKit.requirementsFor('WDO Inspection (Termite Letter)', { serviceKey: 'wdo_inspection' }).promote).toEqual(new Set());
    db.__state.equipment.find((e) => e.id === METER).kit_key = 'moisture_meter';
    expect(await truckKit.toolGapIssue({ technicianId: TECH, serviceType: 'WDO Inspection (Termite Letter)' })).toBeNull();
    expect(await truckKit.toolGapIssue({ technicianId: TECH, serviceType: 'Termite Bait Station System', serviceKey: 'termite_bait' }))
      .toEqual(expect.objectContaining({ tools: ['bait_station_key'], label: 'Truck lacks Bait station keys and replacement cartridges' }));
    // A termite bait add-on on a pest visit promotes the same kit.
    expect(await truckKit.toolGapIssue({ technicianId: TECH, serviceType: 'Quarterly Pest Control', addons: [{ name: 'Termite Bait Station System', serviceKey: 'termite_bait' }] }))
      .toEqual(expect.objectContaining({ tools: expect.arrayContaining(['bait_station_key']) }));
  });

  test('a truck stays configured after its last keyed tool moves away: the latest check named a keyed row', async () => {
    db.__state.equipment.find((e) => e.id === METER).kit_key = 'moisture_meter';
    db.__state.equipment_checks = [{ id: 'k1', vehicle_id: TRUCK, technician_id: TECH, checked_at: daysAgo(1), results: JSON.stringify([{ equipment_id: METER, state: 'present', note: '' }, { equipment_id: SPRAYER, state: 'present', note: '' }]) }];
    db.__state.equipment.find((e) => e.id === METER).assigned_vehicle_id = null;
    expect(await truckKit.truckHasKeys(TRUCK)).toBe(true);
    expect(await truckKit.toolGapsForTruck(TRUCK, 'termite')).toEqual([{ kit_key: 'moisture_meter', label: 'Moisture meter' }]);
    // A truck that never had a keyed row or a check stays unjudged.
    db.__state.equipment_checks = [];
    expect(await truckKit.truckHasKeys(TRUCK)).toBe(false);
  });

  test('mechanical lawn work and the web sweep need no treatment tools', () => {
    expect(truckKit.serviceLinesFor('Lawn Dethatching Service')).toEqual([]);
    expect(truckKit.serviceLinesFor('Core Aeration', { serviceKey: 'lawn_aeration' })).toEqual([]);
    expect(truckKit.serviceLinesFor('Lawn Plugging Service', { serviceKey: 'plugging' })).toEqual([]);
    expect(truckKit.serviceLinesFor('Top Dressing', { serviceKey: 'top_dressing' })).toEqual([]);
    expect(truckKit.serviceLinesFor('Quarterly Pest Control', { addons: [{ name: 'Web Sweep', serviceKey: 'area_addon_web_sweep' }] })).toEqual(['pest']);
    expect(truckKit.serviceLinesFor('Lawn Care — Standard Visit', { serviceKey: 'lawn_standard' })).toEqual(['lawn']);
  });

  test('booked add-ons bring their own line, on readiness and on Today', async () => {
    expect(truckKit.serviceLinesFor('Quarterly Pest Control', { addons: [{ name: 'Tree & Shrub Care' }, { name: 'Termite Spot Treatment' }] })).toEqual(['pest', 'tree_shrub', 'termite']);
    expect(truckKit.serviceLinesFor('Quarterly Pest Control', { addons: [{ name: 'Waves Assessment' }] })).toEqual(['pest']);
    // Catalog identity picks the add-on's line: the fire ant yard add-on is lawn_care, a spreader job.
    expect(truckKit.serviceLinesFor('Quarterly Pest Control', { addons: [{ name: 'Fire Ant Yard Treatment', serviceKey: 'area_addon_fire_ant_yard', category: 'lawn_care' }] })).toEqual(['pest', 'lawn']);
    expect(truckKit.serviceLinesFor('Fire Ant Yard Treatment', { serviceKey: 'area_addon_fire_ant_yard', serviceCategory: 'lawn_care' })).toEqual(['lawn']);
    expect(truckKit.serviceLinesFor('Fire Ant Yard Treatment', { serviceCategory: 'inspection' })).toEqual(['pest']);
    db.__state.equipment.find((e) => e.id === SPRAYER).kit_key = 'bg_sprayer';
    db.__state.equipment.push({ id: '66666666-2222-4333-8444-555555555555', name: 'Flashlight', category: 'tool', status: 'active', assigned_vehicle_id: TRUCK, kit_key: 'flashlight' });
    expect(await truckKit.toolGapIssue({ technicianId: TECH, serviceType: 'Quarterly Pest Control', addons: [{ name: 'Termite Spot Treatment' }] }))
      .toEqual({ kind: 'tools', status: 'hold', label: 'Truck lacks Moisture meter', tools: ['moisture_meter'] });
    const today = require('../utils/datetime-et').etDateString(NOW);
    db.__state.scheduled_services = [{ id: 'v1', technician_id: TECH, scheduled_date: today, status: 'confirmed', service_type: 'Quarterly Pest Control' }];
    expect((await truckKit.truckKitStatus(TECH, { now: NOW })).gaps).toEqual([]);
    db.__state.scheduled_service_addons = [{ id: 'ad1', scheduled_service_id: 'v1', service_name: 'Termite Spot Treatment', service_key_snapshot: null }];
    expect((await truckKit.truckKitStatus(TECH, { now: NOW })).gaps).toEqual([{ serviceId: 'v1', serviceType: 'Quarterly Pest Control', missing: ['Moisture meter'] }]);
  });

  test('readinessToolIssue: nothing while dark, the hold when lit, null (never a throw) on a failed read', async () => {
    const gates = require('../config/feature-gates');
    gates.truckKitLive.mockReturnValueOnce(false);
    expect(await truckKit.readinessToolIssue({ technicianId: TECH, serviceType: 'Termite Inspection' })).toBeNull();
    db.__state.equipment.find((e) => e.id === SPRAYER).kit_key = 'bg_sprayer';
    expect(await truckKit.readinessToolIssue({ serviceId: 'v1', technicianId: TECH, serviceType: 'Termite Inspection' })).toEqual(expect.objectContaining({ kind: 'tools', label: 'Truck lacks Moisture meter' }));
    const spy = jest.spyOn(truckKit, 'toolGapIssue').mockRejectedValueOnce(new Error('kit_key column missing'));
    expect(await truckKit.readinessToolIssue({ serviceId: 'v1', technicianId: TECH, serviceType: 'Termite Inspection' })).toBeNull();
    spy.mockRestore();
  });

  test('a combined visit holds for the companion line\'s tools', async () => {
    db.__state.equipment.find((e) => e.id === SPRAYER).kit_key = 'bg_sprayer';
    db.__state.equipment.push({ id: '66666666-2222-4333-8444-555555555555', name: 'Flashlight', category: 'tool', status: 'active', assigned_vehicle_id: TRUCK, kit_key: 'flashlight' });
    // By line alone the pest checklist is satisfied; by service type the termite meter is a gap.
    expect(await truckKit.toolGapIssue({ technicianId: TECH, serviceLine: 'pest' })).toBeNull();
    expect(await truckKit.toolGapIssue({ technicianId: TECH, serviceLine: 'pest', serviceType: 'Quarterly Pest + Termite Bait Station' }))
      .toEqual({ kind: 'tools', status: 'hold', label: 'Truck lacks Moisture meter', tools: ['moisture_meter'] });
    expect(await truckKit.requiredToolsForLines(['pest', 'termite'])).toEqual([
      { kit_key: 'bg_sprayer', label: 'B&G 1 gal sprayer (interior)' }, { kit_key: 'flashlight', label: 'Flashlight' }, { kit_key: 'moisture_meter', label: 'Moisture meter' },
    ]);
  });

  test('requiredToolsForLine keeps only keyed, required items, once per key', async () => {
    expect(await truckKit.requiredToolsForLine('termite')).toEqual([{ kit_key: 'moisture_meter', label: 'Moisture meter' }]);
    expect(await truckKit.requiredToolsForLine('lawn')).toEqual([]);
    expect(await truckKit.requiredToolsForLine(null)).toEqual([]);
  });

  test('a truck with no keyed row is never judged; with keys, a missing or flagged tool is a gap', async () => {
    expect(await truckKit.toolGapsForTruck(TRUCK, 'termite')).toEqual([]);
    db.__state.equipment.find((e) => e.id === SPRAYER).kit_key = 'bg_sprayer';
    expect(await truckKit.toolGapsForTruck(TRUCK, 'termite')).toEqual([{ kit_key: 'moisture_meter', label: 'Moisture meter' }]);
    expect(await truckKit.toolGapsForTruck(TRUCK, 'pest')).toEqual([{ kit_key: 'flashlight', label: 'Flashlight' }]);
    db.__state.equipment.find((e) => e.id === METER).kit_key = 'moisture_meter';
    expect(await truckKit.toolGapsForTruck(TRUCK, 'termite')).toEqual([]);
    // Reported missing on the last check: not on the truck until found.
    db.__state.maintenance_alerts.push({ id: 'a1', equipment_id: METER, alert_type: 'tool_missing', status: 'new' });
    expect(await truckKit.toolGapsForTruck(TRUCK, 'termite')).toEqual([{ kit_key: 'moisture_meter', label: 'Moisture meter' }]);
  });

  test('a truck whose last keyed tool was marked lost is still judged: the lost tool is the gap', async () => {
    db.__state.equipment.find((e) => e.id === METER).kit_key = 'moisture_meter';
    expect(await truckKit.toolGapsForTruck(TRUCK, 'termite')).toEqual([]);
    db.__state.equipment.find((e) => e.id === METER).status = 'lost';
    expect(await truckKit.toolGapsForTruck(TRUCK, 'termite')).toEqual([{ kit_key: 'moisture_meter', label: 'Moisture meter' }]);
    const today = require('../utils/datetime-et').etDateString(NOW);
    db.__state.scheduled_services = [{ id: 'v1', technician_id: TECH, scheduled_date: today, status: 'confirmed', service_type: 'Termite Inspection' }];
    expect((await truckKit.truckKitStatus(TECH, { now: NOW })).gaps).toEqual([{ serviceId: 'v1', serviceType: 'Termite Inspection', missing: ['Moisture meter'] }]);
  });

  test('toolGapIssue is a hold with a readable label, and nothing behind the gate or without a truck', async () => {
    db.__state.equipment.find((e) => e.id === SPRAYER).kit_key = 'bg_sprayer';
    expect(await truckKit.toolGapIssue({ technicianId: TECH, serviceLine: 'termite' })).toEqual({ kind: 'tools', status: 'hold', label: 'Truck lacks Moisture meter', tools: ['moisture_meter'] });
    db.__state.equipment_checklists.push(CHECKLIST('termite', [{ item: 'Hammer drill', required: true, kit_key: 'hammer_drill' }]));
    expect((await truckKit.toolGapIssue({ technicianId: TECH, serviceLine: 'termite' })).label).toBe('Truck lacks Moisture meter and Hammer drill');
    db.__state.equipment_checklists.push(CHECKLIST('termite', [{ item: 'Ladder', required: true, kit_key: 'ladder' }]));
    expect((await truckKit.toolGapIssue({ technicianId: TECH, serviceLine: 'termite' })).label).toBe('Truck lacks 3 tools');
    expect((await truckKit.toolGapIssue({ technicianId: TECH, serviceLine: 'pest' })).label).toBe('Truck lacks Flashlight');
    expect(await truckKit.toolGapIssue({ technicianId: TECH, serviceLine: 'lawn' })).toBeNull();
    seed({ truckAssigned: false });
    expect(await truckKit.toolGapIssue({ technicianId: TECH, serviceLine: 'termite' })).toBeNull();
    const gates = require('../config/feature-gates');
    gates.truckKitLive.mockReturnValueOnce(false);
    expect(await truckKit.toolGapIssue({ technicianId: TECH, serviceLine: 'termite' })).toBeNull();
  });

  test("today's gaps cover the technician's live visits today only, by their service line", async () => {
    const today = require('../utils/datetime-et').etDateString(NOW);
    db.__state.equipment.find((e) => e.id === SPRAYER).kit_key = 'bg_sprayer';
    db.__state.scheduled_services = [
      { id: 'v1', technician_id: TECH, scheduled_date: today, status: 'confirmed', service_type: 'Termite Inspection' },
      { id: 'v2', technician_id: TECH, scheduled_date: today, status: 'completed', service_type: 'Termite Inspection' },
      { id: 'v3', technician_id: TECH, scheduled_date: '2000-01-01', status: 'confirmed', service_type: 'Termite Inspection' },
      { id: 'v4', technician_id: 'someone-else', scheduled_date: today, status: 'confirmed', service_type: 'Termite Inspection' },
      { id: 'v5', technician_id: TECH, scheduled_date: today, status: 'pending', service_type: 'Quarterly Pest Control' },
      { id: 'v6', technician_id: TECH, scheduled_date: today, status: 'pending', service_type: 'Quarterly Pest + Termite Bait Station' },
      { id: 'v7', technician_id: TECH, scheduled_date: today, status: 'pending', service_type: 'Waves Assessment' },
      { id: 'v8', technician_id: TECH, scheduled_date: today, status: 'pending', service_type: 'Property Review', service_key_snapshot: 'waves_assessment' },
    ];
    const status = await truckKit.truckKitStatus(TECH, { now: NOW });
    expect(status.gaps).toEqual([
      { serviceId: 'v1', serviceType: 'Termite Inspection', missing: ['Moisture meter'] },
      { serviceId: 'v5', serviceType: 'Quarterly Pest Control', missing: ['Flashlight'] },
      { serviceId: 'v6', serviceType: 'Quarterly Pest + Termite Bait Station', missing: ['Flashlight', 'Moisture meter'] },
    ]);
  });

  test('the key vocabulary merges checklist keys (with their text) and keys on rows', async () => {
    db.__state.equipment.find((e) => e.id === SPRAYER).kit_key = 'bg_sprayer';
    db.__state.equipment.find((e) => e.id === METER).kit_key = 'hammer_drill';
    expect(await truckKit.kitKeyVocabulary()).toEqual([
      { kit_key: 'bg_sprayer', label: 'B&G 1 gal sprayer (interior)' },
      { kit_key: 'flashlight', label: 'Flashlight' },
      { kit_key: 'foam_drill_kit', label: 'Foam drill kit' },
      { kit_key: 'hammer_drill', label: 'hammer drill' },
      { kit_key: 'moisture_meter', label: 'Moisture meter' },
    ]);
  });
});
