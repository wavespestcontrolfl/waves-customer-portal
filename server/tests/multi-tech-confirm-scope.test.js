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

  test('gate + capacity on but no technicianId (rebooker series, availability, unassigned rows): tech-blind', async () => {
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

  // Owner ruling 2026-10-03: with two technicians, staff booking or moving a
  // visit for one technician are not warned about the OTHER technician's
  // customer. admin-schedule.js therefore passes the row's technician to its
  // advisory probes (create, recurring children/boosters, the series
  // destination guard); occupancy.js still ignores it unless the gate and
  // capacity mode are on. The same ruling covers the four callers below,
  // whose saved row already carries a technician; the rest were not ruled on
  // and stay tech-blind.
  test('admin create and series probes pass the row technician (advisory, gate-scoped in occupancy.js)', () => {
    const src = read('routes/admin-schedule.js');
    for (const pin of ['technicianId: insertData.technician_id || null', 'technicianId: childData.technician_id || null',
      'technicianId: boosterData.technician_id || null', 'technicianId: row.technician_id || null']) {
      expect(src).toContain(pin);
    }
  });

  // The slice from the call to its closing `});` must carry the pin, so a
  // technicianId added to some OTHER probe in the file does not satisfy it.
  const probeBlock = (src, call) => {
    const i = src.indexOf(call);
    expect(i).toBeGreaterThan(-1);
    return src.slice(i, src.indexOf('});', i));
  };

  test('phone agent commit probe passes the technician the offer row is written with', () => {
    const block = probeBlock(read('services/voice-agent/relay-booking.js'), 'const clash = await findConflictingVisits({');
    expect(block).toContain('technicianId: insertRow.technician_id || null');
  });

  test('call follow-up re-spacing probe passes the child technician (the write CASes on it)', () => {
    const src = read('services/call-booking-catalog.js');
    expect(probeBlock(src, 'await findConflictingVisits({')).toContain('technicianId: k.technician_id || null');
    expect(src).toContain('technician_id: k.technician_id ?? null,');
  });

  test('staff lead booking probe passes the technician the row is inserted with', () => {
    const src = read('routes/admin-leads.js');
    expect(probeBlock(src, 'const clash = await findConflictingVisits({')).toContain('technicianId: technicianId || null');
    expect(src).toContain('technician_id: technicianId || null,');
  });

  test('completion follow-up dry-run probe passes the resolved technician; the write path is unchanged', () => {
    const src = read('services/completion-followup-booking.js');
    expect(probeBlock(src, 'const overlap = insertData.window_start && insertData.window_end')).toContain('technicianId: wouldTechnicianId || null');
    // commitFollowup still probes through window-rules' probeSlotOverlap
    // (tech-blind, runs before the inherited technician is final).
    expect(src).toContain('await probeSlotOverlap({ trx, date,');
  });

  test('after-call booking: the picked technician is the one fenced, probed and saved', () => {
    const src = read('services/call-recording-processor.js');
    // Fresh insert: pick → fence → probe → insert all use bookingTechnicianId.
    expect(src).toContain("require('./scheduling/pick-technician').pickTechnicianForVisit({");
    expect(src).toContain('fenceBookingDay(fenceSp, { date: scheduledDate, techId: bookingTechnicianId || null })');
    expect(src).toContain('technicianId: bookingTechnicianId || null,');
    expect(src).toContain('technician_id: bookingTechnicianId,');
    expect(src).not.toContain('technician_id: defaultTechnicianId,');
    // Reused unassigned row: the pick excludes the row itself.
    expect(src).toMatch(/excludeServiceIds: \[existing\.id\],\s+excludeCustomerId: null,/);
    // …and reads the row's OWN day and window, not the time this call stated.
    expect(src).toContain('date: callBookingDateOnly(existing.scheduled_date),');
    expect(src).toContain('followUpProbeEnd(existing.window_start, existing.window_end, existing.estimated_duration_minutes)');
    expect(src).toContain('let reuseTechId = reuseCandidateTechId;');
    expect(src).toContain('serviceType: existing.service_type || serviceType,');
    // A pick taken before the fence is re-made under it when the fenced read clashes.
    expect(src).toContain('if (bookingTechnicianPicked && bookingTechnicianId && bookingTimeConflicts.length) {');
    expect(src).toContain('const repick = await pickBookingTechnician();');
    // A picked technician's capability is re-read under the share lock at save (fresh + reused).
    expect(src.match(/assertCapabilitiesActive\(trx, (insertData\.technician_id|reuseTechId),/g)).toHaveLength(2);
    // Post-commit recheck judges each fresh row on its own technician.
    expect(src).toContain('technicianId: svc.technician_id || null,');
    expect(src).toContain('technicianId: followUpCreated.technician_id || null,');
    expect(src).toContain('technicianId: visit.technicianId || null,');
  });

  test('callers that must stay tech-blind never pass technicianId', () => {
    for (const p of ['services/scheduling/window-rules.js',
      'services/availability.js', 'services/slot-reservation.js', 'services/visit-groups.js',
      'services/annual-prepay-renewals.js']) {
      expect(read(p)).not.toMatch(/findConflictingVisits\(\{[^}]*technicianId/s);
    }
  });
});
