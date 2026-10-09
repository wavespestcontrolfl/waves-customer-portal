/**
 * What the estimate sold for an area add-on (`area_addon_scope`) survives every writer of
 * the visit and of its add-on rows (Codex round 7 P1 on #6135).
 *
 * The schedule's Update Details save deletes every `scheduled_service_addons` row of a visit
 * and inserts the submitted set. The posted lines carry no scope, so an unrelated date or
 * technician edit used to erase the sold area, tier and grass, and the job card then withheld
 * the St. Augustine rate. The SERVER keeps the scope: it reads the stored scopes before the
 * delete and puts each back on the row of the same catalog service. A client can neither
 * drop, forge nor widen it.
 *
 * No database: an in-memory fake of the two tables drives the real helpers and the real
 * `insertScheduledServiceAddons`. The writer inventory at the bottom pins, by source, that no
 * other writer copies or regenerates a scope.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const path = require('path');
const rows = require('../services/area-addon-visit-rows');
const { _test } = require('../routes/admin-schedule');

const SWEEP = 'area_addon_web_sweep';
const SPOT = 'area_addon_lawn_insect_spot';
const scopeFor = (key, extra = {}) => ({ v: 1, addOnKey: key.replace('area_addon_', ''), catalogServiceKey: key, areaSqFt: 1200, tierSqFt: 2000, grassType: null, ...extra });

// A small in-memory fake of scheduled_services and scheduled_service_addons: where / whereNull /
// whereNotNull / orderBy / select / first / update / del / insert / columnInfo.
function fakeTrx({ visits = [], addons = [], hasScopeColumn = true } = {}) {
  const state = { visits: visits.map((v) => ({ ...v })), addons: addons.map((a) => ({ ...a })), nextId: 100 };
  const tables = { scheduled_services: state.visits, scheduled_service_addons: state.addons };
  const columns = {
    scheduled_services: ['id', 'service_id', 'service_key_snapshot', ...(hasScopeColumn ? ['area_addon_scope'] : [])],
    scheduled_service_addons: ['id', 'scheduled_service_id', 'service_id', 'service_name', 'estimated_price', 'service_key_snapshot', 'recurring_pattern', 'created_at',
      ...(hasScopeColumn ? ['area_addon_scope'] : [])],
  };
  const stored = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
  const trx = (table) => {
    const list = tables[table];
    if (!list) throw new Error(`unexpected table ${table}`);
    const preds = [];
    const q = {
      where(cond) { preds.push((r) => Object.entries(cond).every(([k, v]) => String(r[k]) === String(v))); return q; },
      whereNull(col) { preds.push((r) => r[col] === null || r[col] === undefined); return q; },
      whereNotNull(col) { preds.push((r) => r[col] !== null && r[col] !== undefined); return q; },
      orderBy() { return q; },
      match() { return list.filter((r) => preds.every((p) => p(r))); },
      async select(...cols) { return q.match().map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))); },
      async first(...cols) { const r = q.match()[0]; return r ? Object.fromEntries(cols.map((c) => [c, r[c]])) : undefined; },
      async update(data) { const hit = q.match(); for (const r of hit) Object.assign(r, data.area_addon_scope === undefined ? data : { ...data, area_addon_scope: data.area_addon_scope === null ? null : stored(data.area_addon_scope) }); return hit.length; },
      async del() { for (const r of q.match()) list.splice(list.indexOf(r), 1); },
      async insert(data) {
        const row = { id: `new-${state.nextId++}`, ...data, area_addon_scope: data.area_addon_scope === undefined ? null : stored(data.area_addon_scope) };
        list.push(row);
      },
      async columnInfo() { return Object.fromEntries(columns[table].map((c) => [c, {}])); },
    };
    return q;
  };
  trx.schema = { hasColumn: async (table, col) => columns[table].includes(col) };
  trx.state = state;
  return trx;
}

const storedRow = (visit, key, extra = {}) => ({
  id: `old-${key}`, scheduled_service_id: visit, service_id: `id-${key}`, service_key_snapshot: key, service_name: key, estimated_price: 59,
  recurring_pattern: 'one_time', area_addon_scope: scopeFor(key), ...extra,
});

// The posted line the way normalizeUpdateDetailsAddons shapes it (the server's own catalog resolution).
const postedLine = (key, extra = {}) => ({ serviceId: `id-${key}`, serviceKey: key, serviceName: key, price: 59, base: 59, recurringPattern: 'one_time', ...extra });

// The exact sequence the Update Details route runs when it replaces the add-on rows.
async function replaceAddOnRows(trx, visitId, lines) {
  const addonCols = await trx('scheduled_service_addons').columnInfo();
  const carried = await rows.readAreaAddOnScopesToCarry(trx, visitId);
  await trx('scheduled_service_addons').where({ scheduled_service_id: visitId }).del();
  await _test.insertScheduledServiceAddons(trx, visitId, lines, addonCols, null);
  await rows.restoreCarriedAreaAddOnScopes(trx, visitId, carried);
}
const scopesOf = (trx, visitId) => trx.state.addons.filter((a) => a.scheduled_service_id === visitId).map((a) => [a.service_key_snapshot, a.area_addon_scope]);

describe('1. Update Details replaces the add-on rows and keeps what each add-on was sold for', () => {
  test('an unrelated edit that re-posts the same lines keeps every stored scope', async () => {
    const trx = fakeTrx({ addons: [storedRow('v1', SWEEP), storedRow('v1', SPOT, { area_addon_scope: scopeFor(SPOT, { grassType: 'st_augustine' }) })] });
    await replaceAddOnRows(trx, 'v1', [postedLine(SWEEP), postedLine(SPOT)]);
    expect(scopesOf(trx, 'v1')).toEqual([
      [SWEEP, scopeFor(SWEEP)],
      [SPOT, scopeFor(SPOT, { grassType: 'st_augustine' })],
    ]);
    // The rows were really replaced (new ids), and the scope came from the server's own copy.
    expect(trx.state.addons.every((a) => a.id.startsWith('new-'))).toBe(true);
  });

  test('a line re-ordered, or posted without its row id, still gets its own service\'s scope', async () => {
    const trx = fakeTrx({ addons: [storedRow('v1', SWEEP), storedRow('v1', SPOT, { area_addon_scope: scopeFor(SPOT, { areaSqFt: 900 }) })] });
    await replaceAddOnRows(trx, 'v1', [postedLine(SPOT), postedLine(SWEEP)]);
    expect(Object.fromEntries(scopesOf(trx, 'v1'))).toEqual({ [SWEEP]: scopeFor(SWEEP), [SPOT]: scopeFor(SPOT, { areaSqFt: 900 }) });
  });

  test('a scope never moves to another service: a removed add-on takes its scope with it', async () => {
    const trx = fakeTrx({ addons: [storedRow('v1', SWEEP), storedRow('v1', SPOT)] });
    await replaceAddOnRows(trx, 'v1', [postedLine(SWEEP), postedLine('area_addon_fire_ant_yard')]);
    expect(Object.fromEntries(scopesOf(trx, 'v1'))).toEqual({ [SWEEP]: scopeFor(SWEEP), area_addon_fire_ant_yard: null });
  });

  test('a client cannot forge or widen the scope: the stored value wins, and a row that had none gets none', async () => {
    const forged = { v: 1, addOnKey: 'web_sweep', catalogServiceKey: SWEEP, areaSqFt: 99999, tierSqFt: 99999, grassType: 'st_augustine' };
    const trx = fakeTrx({ addons: [storedRow('v1', SWEEP)] });
    await replaceAddOnRows(trx, 'v1', [
      postedLine(SWEEP, { areaAddonScope: forged, area_addon_scope: forged, scope: forged }),
      postedLine(SPOT, { areaAddonScope: forged, area_addon_scope: forged }),
    ]);
    expect(Object.fromEntries(scopesOf(trx, 'v1'))).toEqual({ [SWEEP]: scopeFor(SWEEP), [SPOT]: null });
  });

  test('another visit\'s rows are never read or restored', async () => {
    const trx = fakeTrx({ addons: [storedRow('v1', SWEEP), storedRow('v2', SWEEP, { area_addon_scope: scopeFor(SWEEP, { areaSqFt: 7 }) })] });
    await replaceAddOnRows(trx, 'v1', [postedLine(SWEEP)]);
    expect(scopesOf(trx, 'v1')).toEqual([[SWEEP, scopeFor(SWEEP)]]);
    expect(scopesOf(trx, 'v2')).toEqual([[SWEEP, scopeFor(SWEEP, { areaSqFt: 7 })]]);
  });

  test('before the column exists, or with nothing stored, the replace is exactly what it was', async () => {
    const noColumn = fakeTrx({ addons: [{ ...storedRow('v1', SWEEP), area_addon_scope: undefined }], hasScopeColumn: false });
    expect(await rows.readAreaAddOnScopesToCarry(noColumn, 'v1')).toEqual([]);
    await replaceAddOnRows(noColumn, 'v1', [postedLine(SWEEP)]);
    expect(noColumn.state.addons).toHaveLength(1);
    const none = fakeTrx({ addons: [{ ...storedRow('v1', 'pest_quarterly'), area_addon_scope: null }] });
    await replaceAddOnRows(none, 'v1', [postedLine('pest_quarterly')]);
    expect(scopesOf(none, 'v1')).toEqual([['pest_quarterly', null]]);
  });

  test('the Update Details route reads the scopes before the delete and restores them after the insert', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    const block = src.slice(src.indexOf('if (addonsReplaced) {'), src.indexOf('if (clearAddonDiscountsOnPriceEdit) {'));
    const order = ['readAreaAddOnScopesToCarry', ".del()", 'insertScheduledServiceAddons(trx', 'restoreCarriedAreaAddOnScopes'].map((needle) => block.indexOf(needle));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('1. the visit\'s own scope (scheduled_services.area_addon_scope) survives edits and is cleared by a service change', () => {
  const visit = (extra = {}) => ({ id: 'v1', service_id: 'id-spot', service_key_snapshot: SPOT, area_addon_scope: scopeFor(SPOT), ...extra });

  test('a date, technician or note edit (no service in the update) neither reads nor clears it', async () => {
    const trx = fakeTrx({ visits: [visit()] });
    expect(await rows.clearOwnAreaAddOnScopeOnServiceChange(trx, 'v1', { scheduled_date: '2026-11-01', technician_id: 't1' })).toBe(false);
    expect(trx.state.visits[0].area_addon_scope).toEqual(scopeFor(SPOT));
  });

  test('an edit that re-posts the same service keeps it', async () => {
    const trx = fakeTrx({ visits: [visit()] });
    expect(await rows.clearOwnAreaAddOnScopeOnServiceChange(trx, 'v1', { service_id: 'id-spot', service_key_snapshot: SPOT })).toBe(false);
    expect(trx.state.visits[0].area_addon_scope).toEqual(scopeFor(SPOT));
  });

  test('changing the visit to another service clears the scope, by key or by catalog id', async () => {
    const byKey = fakeTrx({ visits: [visit()] });
    expect(await rows.clearOwnAreaAddOnScopeOnServiceChange(byKey, 'v1', { service_id: 'id-pest', service_key_snapshot: 'pest_quarterly' })).toBe(true);
    expect(byKey.state.visits[0].area_addon_scope).toBeNull();
    const byId = fakeTrx({ visits: [visit({ service_key_snapshot: null })] });
    expect(await rows.clearOwnAreaAddOnScopeOnServiceChange(byId, 'v1', { service_id: 'id-pest' })).toBe(true);
    expect(byId.state.visits[0].area_addon_scope).toBeNull();
    const cleared = fakeTrx({ visits: [visit()] });
    expect(await rows.clearOwnAreaAddOnScopeOnServiceChange(cleared, 'v1', { service_id: null, service_key_snapshot: null })).toBe(true);
  });

  test('switching to a different add-on clears the old scope, and a visit with no scope is left alone', async () => {
    const trx = fakeTrx({ visits: [visit()] });
    expect(await rows.clearOwnAreaAddOnScopeOnServiceChange(trx, 'v1', { service_id: 'id-sweep', service_key_snapshot: SWEEP })).toBe(true);
    const plain = fakeTrx({ visits: [{ id: 'v2', service_id: 'id-pest', service_key_snapshot: 'pest_quarterly', area_addon_scope: null }] });
    expect(await rows.clearOwnAreaAddOnScopeOnServiceChange(plain, 'v2', { service_id: 'id-lawn', service_key_snapshot: 'lawn_care' })).toBe(false);
  });

  test('before the column exists nothing is read', async () => {
    const trx = fakeTrx({ visits: [{ id: 'v1', service_id: 'a', service_key_snapshot: 'b' }], hasScopeColumn: false });
    expect(await rows.clearOwnAreaAddOnScopeOnServiceChange(trx, 'v1', { service_id: 'x' })).toBe(false);
  });

  test('the Update Details route clears a stale scope right before it writes the visit update', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    const at = src.indexOf('clearOwnAreaAddOnScopeOnServiceChange(trx, req.params.id, updates)');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 400)).toContain("trx('scheduled_services').where({ id: req.params.id }).update(updates)");
  });
});

// Writer inventory. Every code path that inserts a visit, inserts add-on rows or replaces them,
// and why it is safe. A new writer must be added here or the count test fails.
describe('1. every other writer of visits and add-on rows', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const count = (src, re) => (src.match(re) || []).length;
  const schedule = read('routes/admin-schedule.js');

  test('one module writes area_addon_scope: the booking, the Update Details restore and the clear', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (!['node_modules', 'tests', 'migrations'].includes(entry.name)) walk(full); continue; }
        if (!full.endsWith('.js')) continue;
        if (/area_addon_scope\s*[:=]|\.area_addon_scope\s*=|'area_addon_scope'/.test(fs.readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(path.join(__dirname, '..'), full));
        }
      }
    };
    walk(path.join(__dirname, '..'));
    // area-addon-visit-rows.js is the single writer (the booking, the restore and the clear).
    expect(offenders.sort()).toEqual(['services/area-addon-visit-rows.js']);
  });

  test('the add-on row inserts of the schedule are the known four, and none of them reads a scope off a line', () => {
    expect(count(schedule, /trx\('scheduled_service_addons'\)\.insert\(/g) + count(schedule, /sp\('scheduled_service_addons'\)\.insert\(/g)
      + count(schedule, /conn\('scheduled_service_addons'\)\.insert\(/g)).toBe(4);
    expect(count(schedule, /insertScheduledServiceAddons\(trx/g)).toBeGreaterThanOrEqual(4);
    expect(schedule).not.toMatch(/addon(Data)?\.area_addon_scope|addon\.areaAddonScope/);
  });

  test('recurring and template regeneration never copies a one-time add-on row (and so never a scope)', () => {
    const { lineDueOnRecurringDate, filterAddonLinesForDate } = _test;
    if (!lineDueOnRecurringDate) {
      // Not exported: the source rule is what the series spawners all call.
      expect(schedule).toContain("if (pattern === 'one_time') return false;");
      return;
    }
    const row = { service_key_snapshot: SPOT, recurring_pattern: 'one_time' };
    expect(lineDueOnRecurringDate(row, '2026-11-01', '2027-02-01')).toBe(false);
    expect(filterAddonLinesForDate([row], '2026-11-01', '2027-02-01')).toEqual([]);
  });

  test('a rescheduled, moved, reassigned or cancelled visit is the same row: the writers update it in place', () => {
    // Reschedule / move / assign / status never insert a visit row for the existing visit.
    expect(read('services/rebooker.js')).not.toMatch(/scheduled_services'\)\s*\.insert/);
    expect(read('routes/admin-dispatch.js')).not.toMatch(/scheduled_services'\)\s*\.insert/);
  });

  test('visit spawners build their row from named fields, never by spreading a source row', () => {
    const spawners = ['services/recurring-appointment-seeder.js', 'services/completion-followup-booking.js', 'services/annual-prepay-renewals.js'];
    for (const rel of spawners) {
      expect(read(rel)).not.toMatch(/area_addon/);
    }
    // The schedule's own spawns (recurring children, boosters, visit-count top-up, auto-extend) copy named columns.
    expect(schedule).not.toMatch(/insert\(\{\s*\.\.\.(parent|existing|before|row)\b/);
  });

  test('the IB reprice tools save through the same Update Details handler', () => {
    const reprice = read('services/intelligence-bar/reprice-visits-tools.js');
    expect(/updateVisitDetails|update-details/.test(reprice) || /updateVisitDetails/.test(read('services/intelligence-bar/schedule-tools.js'))).toBe(true);
    expect(schedule).toContain('module.exports.updateVisitDetails = updateVisitDetails;');
  });
});

describe('3. the schedule feed lists each attached add-on with what it was sold for (host visits keep their own lane)', () => {
  const VISIT = '7c1b0a5e-2f3d-4a6b-9c8d-0e1f2a3b4c5d';
  const fakeFeed = (dbRows, { withScope = true } = {}) => {
    const knex = () => {
      const qb = { leftJoin: () => qb, whereIn: () => qb, orderBy: () => qb, select: () => qb, then: (res, rej) => Promise.resolve(dbRows).then(res, rej) };
      return qb;
    };
    knex.schema = { hasColumn: async () => withScope };
    return knex;
  };

  test('names, sold area, tier and grass come from the stored scope; a non-add-on row and a bad id are skipped', async () => {
    const out = await rows.areaAddOnSoldByVisit(fakeFeed([
      { scheduled_service_id: VISIT, service_key_snapshot: SPOT, service_name: 'Lawn Insect Spot Treatment', area_addon_scope: scopeFor(SPOT, { areaSqFt: 1200, tierSqFt: 2000, grassType: 'st_augustine' }) },
      { scheduled_service_id: VISIT, service_key_snapshot: SWEEP, service_name: 'Web Sweep', area_addon_scope: null },
      { scheduled_service_id: VISIT, service_key_snapshot: 'pest_quarterly', service_name: 'Quarterly Pest', area_addon_scope: null },
    ]), [VISIT, 'not-a-uuid']);
    expect(out.get(VISIT)).toEqual([
      { key: SPOT, name: 'Lawn Insect Spot Treatment', areaSqFt: 1200, tierSqFt: 2000, areaLabel: 'treated lawn', grassType: 'st_augustine' },
      { key: SWEEP, name: 'Web Sweep', areaSqFt: null, tierSqFt: null, areaLabel: null, grassType: null },
    ]);
    expect([...out.keys()]).toEqual([VISIT]);
  });

  test('before the scope column exists the list still answers, with no sold area; no ids means no query', async () => {
    const out = await rows.areaAddOnSoldByVisit(fakeFeed([{ scheduled_service_id: VISIT, service_key_snapshot: SPOT, service_name: 'Lawn Insect Spot Treatment' }], { withScope: false }), [VISIT]);
    expect(out.get(VISIT)).toEqual([expect.objectContaining({ key: SPOT, areaSqFt: null, tierSqFt: null })]);
    const never = () => { throw new Error('no query expected'); };
    never.schema = { hasColumn: never };
    expect((await rows.areaAddOnSoldByVisit(never, ['x'])).size).toBe(0);
  });
});

describe('4. the staff "Create Appointment" from a linked estimate writes the sold scope itself (Codex round 9)', () => {
  const { generateEstimate } = require('../services/pricing-engine');
  const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
  const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
  const savedGate = process.env.GATE_AREA_ADDONS;
  beforeAll(() => { process.env.GATE_AREA_ADDONS = 'true'; });
  afterAll(() => { if (savedGate === undefined) delete process.env.GATE_AREA_ADDONS; else process.env.GATE_AREA_ADDONS = savedGate; });
  const estimateWith = (areaAddOns) => {
    const v1Input = translateV2CallToV1Input({ homeSqFt: 2000, lotSqFt: 7500 }, ['OT_PEST'], { grassType: 'A', areaAddOns, areaAddOnVisit: 'sameTripAddOn' });
    return { id: 'e-1', service_interest: 'One-time service', estimate_data: { result: mapV1ToLegacyShape(generateEstimate(v1Input)) } };
  };
  const SPOT_ENTRY = { key: 'lawn_insect_spot', areaSqFt: 1200, grassType: 'st_augustine' };
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  test('the scope is rebuilt from the linked estimate and written on each kept row, never from the posted line', async () => {
    const trx = fakeTrx({ visits: [{ id: 'v-1', service_key_snapshot: 'one_time_pest' }], addons: [
      { id: 'a-1', scheduled_service_id: 'v-1', service_key_snapshot: SPOT, service_name: 'Lawn Insect Spot Treatment', area_addon_scope: null },
      { id: 'a-2', scheduled_service_id: 'v-1', service_key_snapshot: SWEEP, service_name: 'Web Sweep', area_addon_scope: null },
    ] });
    const estimate = estimateWith([SPOT_ENTRY, { key: 'web_sweep' }]);
    expect(await rows.writeStaffBookedAreaAddOnScopes(trx, { scheduledServiceId: 'v-1', estimate, ownServiceKey: 'one_time_pest' })).toBe(2);
    const spot = trx.state.addons.find((r) => r.id === 'a-1').area_addon_scope;
    expect(spot).toEqual({ v: 1, addOnKey: 'lawn_insect_spot', catalogServiceKey: SPOT, areaSqFt: 1200, tierSqFt: 2000, grassType: 'st_augustine' });
    expect(trx.state.addons.find((r) => r.id === 'a-2').area_addon_scope).toMatchObject({ addOnKey: 'web_sweep', catalogServiceKey: SWEEP });
  });

  test('the visit\'s own add-on gets its scope on the visit; a row the office removed is not added back; a row of another service takes nothing', async () => {
    const trx = fakeTrx({ visits: [{ id: 'v-1', service_key_snapshot: SPOT, area_addon_scope: null }], addons: [
      { id: 'a-3', scheduled_service_id: 'v-1', service_key_snapshot: 'pest_general_quarterly', service_name: 'Pest', area_addon_scope: null },
    ] });
    const estimate = estimateWith([SPOT_ENTRY, { key: 'web_sweep' }]);
    await rows.writeStaffBookedAreaAddOnScopes(trx, { scheduledServiceId: 'v-1', estimate, ownServiceKey: SPOT });
    expect(trx.state.visits[0].area_addon_scope).toMatchObject({ addOnKey: 'lawn_insect_spot', areaSqFt: 1200, tierSqFt: 2000, grassType: 'st_augustine' });
    // the web sweep was not among the kept lines: nothing is inserted (the office's lines are the office's)
    expect(trx.state.addons.map((r) => r.id)).toEqual(['a-3']);
    expect(trx.state.addons[0].area_addon_scope).toBeNull();
  });

  test('an estimate with no sold add-on, or none at all, runs no query', async () => {
    const never = () => { throw new Error('no query expected'); };
    never.schema = { hasColumn: never };
    for (const estimate of [null, { id: 'e', estimate_data: { result: { oneTime: { items: [{ service: 'one_time_pest', price: 150 }] } } } }]) {
      expect(await rows.writeStaffBookedAreaAddOnScopes(never, { scheduledServiceId: 'v-1', estimate })).toBe(0);
    }
  });

  test('the staff create runs it in the booking transaction, right after the add-on rows, from the linked estimate', () => {
    const src = read('routes/admin-schedule.js');
    const rowsInsert = src.indexOf('await insertScheduledServiceAddons(trx, svc.id, pricing.addonLines, addonCols);');
    const stamp = src.indexOf('writeStaffBookedAreaAddOnScopes(trx, {', rowsInsert);
    const groups = src.indexOf("maybeGroupRow(svc.id, { database: trx, createdBy: 'dispatch' })", rowsInsert);
    expect(stamp).toBeGreaterThan(rowsInsert);
    expect(groups).toBeGreaterThan(stamp);
    expect(src.slice(stamp, stamp + 220)).toContain('estimate: linkedEstimate');
    // the shared writer, not a second one
    expect(read('services/area-addon-visit-rows.js')).toContain('return writeAreaAddOnVisitRows(trx, { scheduledServiceId, serviceProfile: profile, ownServiceKey, addMissingRows: false });');
  });
});
