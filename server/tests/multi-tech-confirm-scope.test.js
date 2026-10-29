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

  // Owner 2026-10-03, "Moves": the move probe is scoped to the technician the row is SAVED with
  // (every caller builds target.technicianId from its own write), no longer only under
  // capacityPlacement (which also switches on insertion placement and stays as it was). The
  // grouped-visit mover and the tech-out preview opt out with occupancyTechBlind.
  test('move probe scopes to target.technicianId unless the caller opts out via occupancyTechBlind', () => {
    const src = read('services/rebooker.js');
    const idx = src.indexOf('async function probeMoveConflicts');
    const block = src.slice(idx, idx + 4800);
    expect(block).toMatch(/options\.occupancyTechBlind !== true && target\.technicianId\s*\?\s*\{ technicianId: target\.technicianId \}/);
    // The scope no longer rides capacityPlacement (insertion placement keeps its own switch).
    expect(block).not.toContain('capacityPlacement === true && target.technicianId');
    expect(src).toContain("options.capacityPlacement === true && placementWindowChanged && keptTechId");
  });

  test('move paths hand the probe the technician they WRITE: day options, series disclosure, unit move, tech-out, rain-out advisory', () => {
    const rebooker = read('services/rebooker.js');
    // Day-option builder: the visit's own technician (rain-out and the admin picker keep it).
    const optIdx = rebooker.indexOf('async findRescheduleOptions');
    expect(rebooker.slice(optIdx, optIdx + 9000)).toContain('technicianId: service.technician_id || null,');
    // Series disclosure check = the follower's own technician, like the sweep probe.
    const discIdx = rebooker.indexOf('const clash = await findConflictingVisits({', rebooker.indexOf('const needsReviewedOccurrences'));
    expect(rebooker.slice(discIdx, discIdx + 900)).toContain('technicianId: row.technician_id || null,');
    // A grouped unit move that names a technician keeps member probes tech-blind.
    const groups = read('services/visit-groups.js');
    expect(groups).toMatch(/techProbeOpts = Object\.prototype\.hasOwnProperty\.call\(options, 'technicianId'\)\s*\? \{ occupancyTechBlind: true \} : \{\}/);
    expect(groups).toContain('...noticeOpts, ...techProbeOpts, expect: primaryExpect');
    expect(groups).toContain('...noticeOpts, ...techProbeOpts, expect: { ...target.expect, ...optOutFence }');
    // Tech-out's preview targets the ABSENT technician, so it stays the tech-blind selection gate.
    expect(read('services/tech-out-auto-move.js')).toContain('previewMoveConflicts(stop.id, date, window, { occupancyTechBlind: true })');
    // Auto-dispatch's all-day candidate read stays tech-blind (explicit null): its commit may be
    // more permissive than the offer, never stricter.
    expect(read('services/auto-dispatch/candidate-slots.js')).toMatch(/windowEnd: FULL_DAY_PROBE_WINDOW\.end,\s*technicianId: null,/);
    // Rain-out's Quick Move advisory judges the same route commit probes.
    const rain = read('services/rain-out.js');
    expect(rain).toContain('technicianId: service.technician_id');
    // getOptions presets, checkTarget, route-scope probe, and the route-checked
    // same-day hours (GATE_TECH_MOVE_ROUTE_TIMES): the visit's own technician.
    expect((rain.match(/technicianId: service\.technician_id/g) || []).length).toBe(4);
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
    // commitFollowup probes through window-rules' probeSlotOverlap with the
    // technician the row is saved with (read before the assignability
    // fallback, which row-locks the technician and must follow rung 1).
    expect(probeBlock(src, 'const overlap = await probeSlotOverlap({')).toContain('technicianId: insertData.technician_id || null');
  });

  // Overlap probes behind probeSlotOverlap (and the two direct sweeps) pass the
  // technician the row is SAVED with. Dark by construction: occupancy.js
  // ignores it unless techScopedConfirmActive() (off in production).
  describe('probeSlotOverlap callers pass the saved row\'s technician', () => {
    test('office bulk edit: the row keeps the technician it has (a bulk edit never reassigns)', () => {
      const src = read('routes/admin-schedule.js');
      const block = probeBlock(src, 'const bulkOverlap = await probeSlotOverlap({');
      expect(block).toContain('technicianId: svc.technician_id || null');
      expect(block).toContain('excludeServiceIds: [id]');
    });

    test('Intelligence Bar: the preview pin and the confirm probe the SAME technician', () => {
      const tools = read('services/intelligence-bar/tools.js');
      // Confirm: technician_id resolved (by pinned id or name) before the transaction.
      expect(probeBlock(tools, 'const overlap = await probeSlotOverlap({\n        trx, date: dateStr, windowStart: win.start, windowEnd, technicianId'))
        .toContain('technicianId: technician_id || null');
      // Preview: the rows read takes the technician and forwards it.
      expect(probeBlock(tools, 'return db.transaction((trx) => probeSlotOverlap({')).toContain('technicianId: technicianId || null');
      const route = read('routes/admin-intelligence-bar.js');
      expect(route).toContain('ibBookingOverlapProposal(params.scheduled_date, params.time_window, params.technician_id || null)');
      expect(route).toContain('ibBookingOverlapWho(params.scheduled_date, params.time_window, params.technician_id || null)');
      // The route pins params.technician_id (line "params.technician_id = tech.id") BEFORE the overlap pin.
      expect(route.indexOf('params.technician_id = tech.id;')).toBeGreaterThan(-1);
      expect(route.indexOf('params.technician_id = tech.id;')).toBeLessThan(route.indexOf('ibBookingOverlapProposal(params.scheduled_date'));
      // Move: the visit keeps its technician.
      expect(probeBlock(tools, 'excludeServiceIds: [appointment_id],\n          // A move keeps')).toContain('technicianId: appt.technician_id || null');
      expect(probeBlock(read('services/intelligence-bar/schedule-tools.js'), 'const overlap = await probeSlotOverlap({')).toContain('technicianId: s.technician_id || null');
    });

    test('new-caller booking: the technician the visit is inserted with', () => {
      const src = read('services/booking/new-caller-visit.js');
      expect(probeBlock(src, 'const clash = await probeSlotOverlap({')).toContain('technicianId: v.technicianId || null');
      expect(src).toContain('technician_id: v.technicianId,');
    });

    test('cancel-reseed probe: the added row carries the technician it was inserted with', () => {
      const src = read('routes/admin-schedule.js');
      expect(src).toContain('technicianId: row.technician_id || null,\n    });\n  }\n  if (result.added.length < need)');
      expect(probeBlock(src, 'const clash = await findConflictingVisits({\n      db: trx, date: child.date')).toContain('technicianId: child.technicianId || null');
    });

    test('/book plan activation: the seeded follow-up sweep passes the seeded row\'s technician (dropped only after a clash)', () => {
      const src = read('routes/booking.js');
      const i = src.indexOf('const clashes = await findConflictingVisits({');
      expect(i).toBeGreaterThan(-1);
      const block = src.slice(i, src.indexOf('if (clashes.length > 0)', i));
      expect(block).toContain('technicianId: row.technician_id || null');
      // The drop to unassigned happens after the probe, never before it.
      expect(src.indexOf("technician_id: null,\n                  window_start: null,", i)).toBeGreaterThan(i + block.length);
    });
  });

  // The change is dark by construction: with techScopedConfirmActive() false
  // (production today), a probe that now passes a technician builds exactly
  // the query it built without one, so a row on ANOTHER technician's route
  // still clashes.
  describe('probeSlotOverlap with a technician, scope off: identical to before', () => {
    const { probeSlotOverlap } = require('../services/scheduling/window-rules');
    const trace = async (extra, env = {}) => {
      Object.entries(env).forEach(([k, v]) => { process.env[k] = v; });
      const q = makeQuery();
      const rows = [{ id: 'other-tech-row', technician_id: 'tech-a', scheduled_date: '2099-01-05', window_start: '09:00', window_end: '10:00', status: 'confirmed' }];
      q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      q.orderBy = jest.fn(() => ({ then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject) }));
      db.mockReturnValue(q);
      const trx = db; trx.raw = jest.fn().mockResolvedValue({});
      const out = await probeSlotOverlap({ trx, date: '2099-01-05', windowStart: '09:00', windowEnd: '10:00', ...extra });
      const calls = {};
      Object.entries(q).forEach(([k, v]) => { if (v && v.mock) calls[k] = v.mock.calls.map((c) => c.filter((x) => typeof x !== 'function')); });
      return { out, calls, raw: trx.raw.mock.calls };
    };

    test('scope off (production): a row on another technician\'s route still clashes, and every query call is identical', async () => {
      expect(techScopedConfirmActive()).toBe(false);
      const blind = await trace({});
      const withTech = await trace({ technicianId: 'tech-b' });
      expect(withTech.out).toEqual(blind.out);
      expect(withTech.out.map((r) => r.id)).toEqual(['other-tech-row']);
      expect(withTech.calls).toEqual(blind.calls);
      expect(withTech.raw).toEqual(blind.raw);
      expect(withTech.calls.whereNull).not.toContainEqual(['technician_id']);
    });

    test('gate on but capacity off: still identical (offer side is tech-blind too)', async () => {
      const blind = await trace({}, { GATE_MULTI_TECH_CONFIRM: 'true' });
      const withTech = await trace({ technicianId: 'tech-b' }, { GATE_MULTI_TECH_CONFIRM: 'true' });
      expect(techScopedConfirmActive()).toBe(false);
      expect(withTech.calls).toEqual(blind.calls);
    });

    test('scope ON: the same call now scopes to that technician (so the plumbing is live once D1 is decided)', async () => {
      const blind = await trace({}, { GATE_MULTI_TECH_CONFIRM: 'true', GATE_SCHEDULING_CAPACITY: 'true' });
      const withTech = await trace({ technicianId: 'tech-b' }, { GATE_MULTI_TECH_CONFIRM: 'true', GATE_SCHEDULING_CAPACITY: 'true' });
      expect(blind.calls.whereNull).not.toContainEqual(['technician_id']);
      expect(withTech.calls.whereNull).toContainEqual(['technician_id']);
      expect(withTech.calls.orWhere).toContainEqual(['technician_id', 'tech-b']);
    });
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
    expect(src).toContain('if (bookingTechnicianPicked && bookingTechnicianId && (bookingTimeConflicts.length || pickedTechnicianBlocked)) {');
    expect(src).toContain('const repick = await pickBookingTechnician();');
    // A picked technician's capability is re-read under the share lock at save (fresh + reused).
    expect(src.match(/assertCapabilitiesActive\(trx, (insertData\.technician_id|reuseTechId),/g)).toHaveLength(2);
    // The reused row's pick is re-read under the tech-day locks, excluding only that row.
    expect(src).toContain('if (reuseTechId && reuseTechPicked && existing.window_start) {');
    expect(src).toMatch(/technicianFreeAt\(\{\s+conn: probeSp, technicianId: reuseTechId,[^}]*excludeServiceIds: \[existing\.id\],/);
    // Post-commit recheck judges each fresh row on its own technician.
    expect(src).toContain('technicianId: svc.technician_id || null,');
    expect(src).toContain('technicianId: followUpCreated.technician_id || null,');
    expect(src).toContain('technicianId: visit.technicianId || null,');
  });

  test('callers that must stay tech-blind never pass technicianId', () => {
    for (const p of [
      'services/availability.js', 'services/slot-reservation.js', 'services/visit-groups.js',
      'services/annual-prepay-renewals.js']) {
      expect(read(p)).not.toMatch(/findConflictingVisits\(\{[^}]*technicianId/s);
    }
  });
});
