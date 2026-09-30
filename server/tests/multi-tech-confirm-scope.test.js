/**
 * Tech-aware confirm scope (GATE_MULTI_TECH_CONFIRM, dark, owner 2026-09-29):
 * SQL shape of occupancy.js's opt-in `technicianId`, plus wiring pins for the
 * /book commit (zone/hold legs + global probe) and the public-reschedule probe.
 * The real-SQL behavior with two technicians is multi-tech-confirm-db.test.js.
 */
jest.mock('../models/db', () => jest.fn());

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const { findConflictingVisits, techScopedConfirmActive } = require('../services/scheduling/occupancy');
const { multiTechConfirmLive } = require('../config/feature-gates');

// Records every column tested for NULL / equality inside grouped wheres.
function makeQuery() {
  const calls = { whereNull: [], orWhere: [], orWhereNull: [] };
  const builder = {};
  Object.assign(builder, {
    where: jest.fn(function where(arg, ...rest) {
      if (typeof arg === 'function') arg.call(builder, builder);
      return builder;
    }),
    whereNotIn: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    orWhereRaw: jest.fn().mockReturnThis(),
    whereNull: jest.fn(function whereNull(col) { calls.whereNull.push(col); return builder; }),
    orWhereNull: jest.fn(function orWhereNull(col) { calls.orWhereNull.push(col); return builder; }),
    orWhere: jest.fn(function orWhere(col, val) { calls.orWhere.push([col, val]); return builder; }),
    orWhereNot: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
  });
  builder.calls = calls;
  return builder;
}

const ENV = ['GATE_SCHEDULING_CAPACITY', 'GATE_MULTI_TECH_CONFIRM', 'GATE_SLOT_TRAVEL_GAP'];
const saved = {};
beforeAll(() => { ENV.forEach((k) => { saved[k] = process.env[k]; }); });
afterAll(() => { ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });
beforeEach(() => { jest.clearAllMocks(); ENV.forEach((k) => delete process.env[k]); db.raw = jest.fn((s) => s); });

const args = { date: '2099-01-05', windowStart: '09:00', windowEnd: '10:00', technicianId: 'tech-b' };
const scoped = (q) => q.calls.orWhere.some(([col, val]) => col === 'technician_id' && val === 'tech-b');

describe('techScopedConfirmActive', () => {
  test('needs BOTH the gate and capacity mode (mirrors the offer predicate)', () => {
    expect(techScopedConfirmActive()).toBe(false);
    process.env.GATE_MULTI_TECH_CONFIRM = 'true';
    expect(multiTechConfirmLive()).toBe(true);
    expect(techScopedConfirmActive()).toBe(false); // capacity off
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    expect(techScopedConfirmActive()).toBe(true);
    delete process.env.GATE_MULTI_TECH_CONFIRM;
    expect(techScopedConfirmActive()).toBe(false); // gate off
  });
});

describe('findConflictingVisits technicianId scope', () => {
  test('gate off: technicianId is ignored — no technician predicate at all', async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    const q = makeQuery(); db.mockReturnValue(q);
    await findConflictingVisits({ db, ...args });
    expect(q.calls.whereNull).not.toContain('technician_id');
    expect(scoped(q)).toBe(false);
  });

  test('gate + capacity on: same technician OR unassigned (plain overlap SQL)', async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    process.env.GATE_MULTI_TECH_CONFIRM = 'true';
    const q = makeQuery(); db.mockReturnValue(q);
    await findConflictingVisits({ db, ...args });
    expect(q.calls.whereNull).toContain('technician_id');
    expect(scoped(q)).toBe(true);
  });

  test('gate + capacity on: same predicate on the travel-gap variant, qualified column', async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    process.env.GATE_MULTI_TECH_CONFIRM = 'true';
    process.env.GATE_SLOT_TRAVEL_GAP = 'true';
    const q = makeQuery(); db.mockReturnValue(q);
    await findConflictingVisits({ db, ...args, travel: { lat: 27.5, lng: -82.4 } });
    expect(q.calls.whereNull).toContain('scheduled_services.technician_id');
    expect(q.calls.orWhere).toContainEqual(['scheduled_services.technician_id', 'tech-b']);
  });

  test('gate + capacity on but no technicianId (admin, rebooker, phone agent): tech-blind', async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    process.env.GATE_MULTI_TECH_CONFIRM = 'true';
    const q = makeQuery(); db.mockReturnValue(q);
    await findConflictingVisits({ db, ...args, technicianId: null });
    expect(q.calls.whereNull).not.toContain('technician_id');
    expect(scoped(q)).toBe(false);
  });
});

describe('wiring', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

  test('/book commit: zone/city/hold legs are AND-scoped, gated on technician + gate + capacity mode', () => {
    const src = read('routes/booking.js');
    const scopeIdx = src.indexOf('if (technician_id && multiTechConfirmLive() && capacityEnabled()) {');
    const firstIdx = src.indexOf("const conflict = await conflictQuery.first('scheduled_services.id');");
    expect(scopeIdx).toBeGreaterThan(-1);
    expect(scopeIdx).toBeLessThan(firstIdx);
    const block = src.slice(scopeIdx, firstIdx);
    expect(block).toContain("q.whereNull('scheduled_services.technician_id')");
    expect(block).toContain(".orWhere('scheduled_services.technician_id', technician_id)");
    // The global probe passes the same technician.
    const probeIdx = src.indexOf('const globalClash = await findConflictingVisits({');
    expect(src.slice(probeIdx, probeIdx + 700)).toContain('technicianId: technician_id || null');
  });

  test('public reschedule probe opts in only via capacityPlacement (the public reschedule flag)', () => {
    const src = read('services/rebooker.js');
    const idx = src.indexOf('async function probeMoveConflicts');
    const block = src.slice(idx, idx + 3200);
    expect(block).toMatch(/options\.capacityPlacement === true && target\.technicianId\s*\?\s*\{ technicianId: target\.technicianId \}/);
  });

  test('callers that must stay tech-blind never pass technicianId', () => {
    for (const p of ['routes/admin-schedule.js', 'routes/admin-leads.js', 'services/scheduling/window-rules.js',
      'services/availability.js', 'services/slot-reservation.js', 'services/voice-agent/relay-booking.js',
      'services/call-booking-catalog.js', 'services/visit-groups.js', 'services/completion-followup-booking.js',
      'services/annual-prepay-renewals.js']) {
      expect(read(p)).not.toMatch(/findConflictingVisits\(\{[^}]*technicianId/s);
    }
  });
});
