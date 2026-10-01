// Real migrated PostgreSQL, synthetic records. GATE_SERIES_MOVE_CARRIES_VISIT
// (owner ruling 2026-10-01: a pest visit riding a lawn visit is ONE
// appointment — when either moves, both move). A STAFF whole-schedule move of
// the lawn series carries each grouped pest partner to the occurrence's new
// stop inside the series transaction; the visit stays one visit, re-keyed to
// the new stop; the partner is a one-off date exception, so its own series
// cadence never shifts. Gate off, a customer caller, and a frozen visit keep
// today's refusal and write nothing.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

const { randomUUID } = require('node:crypto');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// Captures the customer tracker broadcast (customer:job_update) the
// post-commit cleanup sends for a rewound row.
const mockEmits = [];
jest.mock('../sockets', () => ({
  ...jest.requireActual('../sockets'),
  getIo: () => ({ to: (room) => ({ emit: (event, payload) => mockEmits.push({ room, event, payload }) }) }),
}));

jest.setTimeout(180000);

function addDays(dateStr, days) {
  return etDateString(addETDays(parseETDateTime(`${dateStr}T12:00`), days));
}

const dateOnly = (v) => (v instanceof Date ? require('../utils/datetime-et').etCalendarDayOf(v) : String(v).slice(0, 10));

postgres('staff series move carries grouped visit partners (GATE_SERIES_MOVE_CARRIES_VISIT)', () => {
  let db;
  let rebooker;
  let vg;
  // Far future, a Tuesday cadence: clear of every real row and of "near-term" rules.
  const LAWN_START = '2098-03-03';

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!localCI && !privateQa) throw new Error("Use disposable CI or this worktree's private QA database");
    db = require('../models/db');
    rebooker = require('../services/rebooker');
    vg = require('../services/visit-groups');
  });

  afterEach(() => {
    delete process.env.GATE_SERIES_MOVE_CARRIES_VISIT;
  });

  afterAll(async () => {
    await db?.destroy();
  });

  async function build() {
    const customerId = randomUUID();
    const techId = randomUUID();
    await db('technicians').insert({ id: techId, name: 'Synthetic carry tech', employment_status: 'active', field_dispatchable: true });
    await db('customers').insert({
      id: customerId,
      first_name: 'Carry',
      last_name: 'Fixture',
      email: `${customerId}@example.invalid`,
      phone: `+1941555${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
      address_line1: '100 Test Lane',
      city: 'Test City',
      zip: '00000',
      active: true,
      pipeline_stage: 'active_customer',
    });
    const base = {
      customer_id: customerId,
      is_recurring: true,
      recurring_ongoing: true,
      technician_id: techId,
      window_start: '09:00',
      window_end: '10:00',
      estimated_duration_minutes: 30,
    };
    // Real catalog rows (seeded by migrations): groupable, same group family —
    // the visit seam keeps a member only when its service is groupable.
    const svcId = async (key) => (await db('services').where({ service_key: key }).first('id')).id;
    const lawnServiceId = await svcId('lawn_care_6week');
    const pestServiceId = await svcId('pest_general_quarterly');
    const insert = async (o) => (await db('scheduled_services').insert({ id: randomUUID(), ...base, ...o }).returning('*'))[0];
    const lawnParent = await insert({
      status: 'completed', recurring_pattern: 'every_6_weeks', service_type: 'Lawn Care - Every 6 Weeks', service_id: lawnServiceId, scheduled_date: LAWN_START,
    });
    const lawn = [];
    for (let i = 1; i <= 3; i++) {
      lawn.push(await insert({
        status: 'pending', recurring_parent_id: lawnParent.id, recurring_pattern: 'every_6_weeks',
        service_type: 'Lawn Care - Every 6 Weeks', service_id: lawnServiceId, scheduled_date: addDays(LAWN_START, i * 42),
      }));
    }
    const pestParent = await insert({
      status: 'completed', recurring_pattern: 'quarterly', service_type: 'Quarterly Pest Control', service_id: pestServiceId, scheduled_date: addDays(LAWN_START, -7),
    });
    // Pest rides lawn occurrences 1 and 3 (12 weeks apart), same window and tech.
    const pest = [];
    for (const idx of [0, 2]) {
      pest.push(await insert({
        status: 'pending', recurring_parent_id: pestParent.id, recurring_pattern: 'quarterly',
        service_type: 'Quarterly Pest Control', service_id: pestServiceId, scheduled_date: dateOnly(lawn[idx].scheduled_date),
      }));
    }
    // Group each lawn occurrence with its pest partner into one open visit.
    const visits = [];
    for (const [k, idx] of [[0, 0], [1, 2]]) {
      const date = dateOnly(lawn[idx].scheduled_date);
      const [visit] = await db('service_visits').insert({
        customer_id: customerId,
        scheduled_date: date,
        window_start: '09:00',
        window_end: '10:00',
        stop_base_key: vg.stopBaseKey({ propertyId: null, customerId, scheduledDate: date }),
        stop_seq: 1,
        technician_id: techId,
        group_family: 'recurring_property_service',
        status: 'open',
        created_by: 'test',
      }).returning('*');
      await db('scheduled_services').whereIn('id', [lawn[idx].id, pest[k].id]).update({ visit_id: visit.id });
      visits.push(visit);
    }
    return { customerId, techId, lawnParent, lawn, pestParent, pest, visits };
  }

  async function rowsOf(ids) {
    const rows = await db('scheduled_services').whereIn('id', ids).select('*');
    return new Map(rows.map((r) => [String(r.id), r]));
  }

  function moveLawnSeries(f, { by = 'admin', days = 1 } = {}) {
    const anchor = f.lawn[0];
    return rebooker.rescheduleSeries(anchor.id, addDays(dateOnly(anchor.scheduled_date), days), '09:00-10:00', 'admin', by, {
      allowLive: true,
      adminWindowRules: true,
      sourceSurface: 'dispatch_board',
      notifyRequested: false,
      overlapAdvisory: true,
    });
  }

  test('gate on: each grouped pest partner moves with its lawn occurrence; the visit stays whole at the new stop', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    const f = await build();
    const pestParentBefore = await db('scheduled_services').where({ id: f.pestParent.id }).first();
    const result = await moveLawnSeries(f);
    expect(result.success).not.toBe(false);

    const after = await rowsOf([...f.lawn.map((r) => r.id), ...f.pest.map((r) => r.id)]);
    for (let i = 0; i < f.lawn.length; i++) {
      expect(dateOnly(after.get(String(f.lawn[i].id)).scheduled_date)).toBe(addDays(dateOnly(f.lawn[i].scheduled_date), 1));
    }
    for (const [k, idx] of [[0, 0], [1, 2]]) {
      const p = after.get(String(f.pest[k].id));
      const l = after.get(String(f.lawn[idx].id));
      expect(dateOnly(p.scheduled_date)).toBe(dateOnly(l.scheduled_date));
      expect(String(p.visit_id)).toBe(String(f.visits[k].id));
      expect(String(l.visit_id)).toBe(String(f.visits[k].id));
      expect(String(p.window_start).slice(0, 5)).toBe('09:00');
      // One-off exception on the PEST series: its cadence date is the old one.
      expect(p.date_exception).toBe(true);
      expect(dateOnly(p.date_exception_cadence_date)).toBe(dateOnly(f.pest[k].scheduled_date));
      const visit = await db('service_visits').where({ id: f.visits[k].id }).first();
      expect(visit.status).toBe('open');
      expect(dateOnly(visit.scheduled_date)).toBe(dateOnly(l.scheduled_date));
      expect(visit.stop_base_key).toBe(vg.stopBaseKey({ propertyId: null, customerId: f.customerId, scheduledDate: dateOnly(l.scheduled_date) }));
    }
    // The pest series root (template anchor) is untouched.
    const pestParentAfter = await db('scheduled_services').where({ id: f.pestParent.id }).first();
    expect(dateOnly(pestParentAfter.scheduled_date)).toBe(dateOnly(pestParentBefore.scheduled_date));
    // The operation record names the carried partners, apart from the cadence rows.
    const sm = await db('series_moves').where({ anchor_service_id: f.lawn[0].id }).orderBy('created_at', 'desc').first();
    const rows = typeof sm.rows === 'string' ? JSON.parse(sm.rows) : sm.rows;
    expect(rows.filter((r) => r.partner).map((r) => String(r.id)).sort()).toEqual(f.pest.map((r) => String(r.id)).sort());
  });

  test('a partner that starts earlier sets the stop start the notice quotes; carried partners are reminder occurrences, not follow-ups', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    const f = await build();
    // Pest arrives first at the first stop: 08:00, lawn 09:00.
    await db('scheduled_services').where({ id: f.pest[0].id }).update({ window_start: '08:00', window_end: '09:00' });
    await db('service_visits').where({ id: f.visits[0].id }).update({ window_start: '08:00' });
    const anchor = f.lawn[0];
    const result = await rebooker.rescheduleSeries(anchor.id, addDays(dateOnly(anchor.scheduled_date), 1), '10:00-11:00', 'admin', 'admin', {
      allowLive: true,
      adminWindowRules: true,
      sourceSurface: 'dispatch_board',
      notifyRequested: false,
      overlapAdvisory: true,
    });
    const pest = await db('scheduled_services').where({ id: f.pest[0].id }).first();
    // Shifted by the anchor's own +1h delta.
    expect(String(pest.window_start).slice(0, 5)).toBe('09:00');
    const anchorOcc = result.rescheduledOccurrences.find((o) => String(o.id) === String(anchor.id));
    expect(String(anchorOcc.windowStart).slice(0, 5)).toBe('10:00');
    expect(String(anchorOcc.visitWindowStart).slice(0, 5)).toBe('09:00');
    expect(anchorOcc.visitId).toBe(String(f.visits[0].id));
    expect(result.carriedVisitMembers.map((k) => String(k.id)).sort()).toEqual(f.pest.map((r) => String(r.id)).sort());
    expect(result.followUpOccurrences.map((k) => String(k.id))).not.toEqual(expect.arrayContaining([String(f.pest[0].id)]));
  });

  test('a live carried partner lands confirmed, and its tracker refresh says confirmed', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    const f = await build();
    await db('scheduled_services').where({ id: f.pest[0].id }).update({ status: 'en_route' });
    mockEmits.length = 0;
    await moveLawnSeries(f);
    const pest = await db('scheduled_services').where({ id: f.pest[0].id }).first();
    expect(pest.status).toBe('confirmed');
    const refresh = mockEmits.filter((e) => e.event === 'customer:job_update' && String(e.payload.job_id) === String(f.pest[0].id));
    expect(refresh.length).toBeGreaterThan(0);
    for (const e of refresh) expect(e.payload.status).toBe('confirmed');
  });

  test('a carried partner never lands on a day its own plan already has a visit', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    const f = await build();
    // A pest booster already sits on the day the first stop would move to.
    await db('scheduled_services').insert({
      id: randomUUID(), customer_id: f.customerId, technician_id: f.techId, status: 'pending',
      recurring_parent_id: f.pestParent.id, recurring_pattern: 'quarterly', service_type: 'Quarterly Pest Control',
      service_id: f.pest[0].service_id, scheduled_date: addDays(dateOnly(f.lawn[0].scheduled_date), 1),
      window_start: '13:00', window_end: '14:00', estimated_duration_minutes: 30,
    });
    const before = await rowsOf([...f.lawn.map((r) => r.id), ...f.pest.map((r) => r.id)]);
    await expect(moveLawnSeries(f)).rejects.toMatchObject({ statusCode: 409, code: 'SLOT_TAKEN', memberId: f.pest[0].id });
    const after = await rowsOf([...before.keys()]);
    for (const [id, r] of before) expect(dateOnly(after.get(id).scheduled_date)).toBe(dateOnly(r.scheduled_date));
  });

  test('a reviewed move (conflict snapshot) does not carry partners: today\'s refusal stands', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    const f = await build();
    const anchor = f.lawn[0];
    await expect(rebooker.rescheduleSeries(anchor.id, addDays(dateOnly(anchor.scheduled_date), 1), '09:00-10:00', 'admin', 'admin', {
      adminWindowRules: true,
      sourceSurface: 'call_reschedule',
      notifyRequested: false,
      overlapAdvisory: true,
      expectConflictSnapshot: [],
    })).rejects.toMatchObject({ statusCode: 409, code: 'VISIT_SERIES_MOVE_UNSUPPORTED' });
  });

  test('a partner that was a one-off exception and is carried back onto its cadence date rejoins the cadence', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    const f = await build();
    // The pest row was moved off its cadence day earlier: cadence = the day after.
    const cadence = addDays(dateOnly(f.pest[0].scheduled_date), 1);
    await db('scheduled_services').where({ id: f.pest[0].id }).update({
      date_exception: true, date_exception_source: 'admin', date_exception_at: new Date(), date_exception_cadence_date: cadence,
    });
    await moveLawnSeries(f);
    const pest = await db('scheduled_services').where({ id: f.pest[0].id }).first();
    expect(dateOnly(pest.scheduled_date)).toBe(cadence);
    expect(pest.date_exception).toBe(false);
    expect(pest.date_exception_cadence_date).toBeNull();
  });

  test('automatic initiators never carry: the call pipeline keeps the refusal', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    const f = await build();
    await expect(moveLawnSeries(f, { by: 'ai_call_pipeline' })).rejects.toMatchObject({ statusCode: 409 });
    const pest = await db('scheduled_services').where({ id: f.pest[0].id }).first();
    expect(dateOnly(pest.scheduled_date)).toBe(dateOnly(f.pest[0].scheduled_date));
  });

  test('a carried partner\'s pending call follow-up keeps its spacing', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    const f = await build();
    const followDay = addDays(dateOnly(f.pest[0].scheduled_date), 14);
    const [child] = await db('scheduled_services').insert({
      id: randomUUID(), customer_id: f.customerId, technician_id: f.techId, status: 'pending', customer_confirmed: false,
      parent_service_id: f.pest[0].id, source_action: 'ai_call_pipeline_followup', service_type: 'Quarterly Pest Control',
      scheduled_date: followDay, window_start: '13:00', window_end: '14:00', estimated_duration_minutes: 30,
    }).returning('*');
    const result = await moveLawnSeries(f, { days: 3 });
    const moved = await db('scheduled_services').where({ id: child.id }).first();
    expect(dateOnly(moved.scheduled_date)).toBe(addDays(followDay, 3));
    expect(result.followUpOccurrences.map((k) => String(k.id))).toContain(String(child.id));
  });

  test('a shortened window that would leave a partner off the stop refuses the whole move', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    const f = await build();
    // Lawn 09:00-11:00, pest 10:00-11:00: one stop.
    await db('scheduled_services').whereIn('id', f.lawn.map((r) => r.id)).update({ window_end: '11:00' });
    await db('scheduled_services').where({ id: f.pest[0].id }).update({ window_start: '10:00', window_end: '11:00' });
    await db('service_visits').where({ id: f.visits[0].id }).update({ window_end: '11:00' });
    const before = await rowsOf([...f.lawn.map((r) => r.id), ...f.pest.map((r) => r.id)]);
    const anchor = f.lawn[0];
    // Same start, end cut to 09:30: the pest window no longer touches it.
    await expect(rebooker.rescheduleSeries(anchor.id, addDays(dateOnly(anchor.scheduled_date), 1), '09:00-09:30', 'admin', 'admin', {
      allowLive: true, sourceSurface: 'dispatch_board', notifyRequested: false, overlapAdvisory: true,
    })).rejects.toMatchObject({ statusCode: 409, code: 'VISIT_MEMBER_WINDOW_INVALID' });
    const after = await rowsOf([...before.keys()]);
    for (const [id, r] of before) expect(dateOnly(after.get(id).scheduled_date)).toBe(dateOnly(r.scheduled_date));
  });

  test('a partner that is its own plan\'s root row is refused (its plan dates derive from it)', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    const f = await build();
    // Make the first pest occurrence the pest plan's live root.
    await db('scheduled_services').where({ id: f.pest[0].id }).update({ recurring_parent_id: null });
    const before = await rowsOf([...f.lawn.map((r) => r.id), ...f.pest.map((r) => r.id)]);
    await expect(moveLawnSeries(f)).rejects.toMatchObject({ statusCode: 409, code: 'VISIT_SERIES_MOVE_UNSUPPORTED', memberId: f.pest[0].id });
    const after = await rowsOf([...before.keys()]);
    for (const [id, r] of before) expect(dateOnly(after.get(id).scheduled_date)).toBe(dateOnly(r.scheduled_date));
  });

  test('carryVisit: false (the edit modal) keeps the refusal even with the gate on', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    const f = await build();
    const anchor = f.lawn[0];
    await expect(rebooker.rescheduleSeries(anchor.id, addDays(dateOnly(anchor.scheduled_date), 1), '09:00-10:00', 'admin', 'admin', {
      allowLive: true, sourceSurface: 'edit_modal', notifyRequested: false, overlapAdvisory: true, carryVisit: false,
    })).rejects.toMatchObject({ statusCode: 409, code: 'VISIT_SERIES_MOVE_UNSUPPORTED' });
  });

  test('a partner plan busy with maintenance is a retryable 409, never a wait', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    const f = await build();
    // Another transaction holds the pest plan's maintenance lock.
    await db.transaction(async (other) => {
      await other.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['recurring-series-maintenance', String(f.pestParent.id)]);
      await expect(moveLawnSeries(f)).rejects.toMatchObject({ statusCode: 409, code: 'VISIT_CHANGED_RETRY' });
    });
    const pest = await db('scheduled_services').where({ id: f.pest[0].id }).first();
    expect(dateOnly(pest.scheduled_date)).toBe(dateOnly(f.pest[0].scheduled_date));
  });

  test('a retried committed carry replays even after the gate is turned off', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    const f = await build();
    const anchor = f.lawn[0];
    const target = addDays(dateOnly(anchor.scheduled_date), 1);
    const opts = { allowLive: true, sourceSurface: 'dispatch_board', notifyRequested: false, overlapAdvisory: true, operationKey: `retry-${randomUUID()}` };
    const first = await rebooker.rescheduleSeries(anchor.id, target, '09:00-10:00', 'admin', 'admin', opts);
    delete process.env.GATE_SERIES_MOVE_CARRIES_VISIT;
    const again = await rebooker.rescheduleSeries(anchor.id, target, '09:00-10:00', 'admin', 'admin', opts);
    expect(again.seriesMoveId).toBe(first.seriesMoveId);
    expect(again.replayed).toBe(true);
  });

  test('a legacy row with no status in the partner plan still holds its day', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    const f = await build();
    const [legacy] = await db('scheduled_services').insert({
      id: randomUUID(), customer_id: f.customerId, technician_id: f.techId, status: 'pending',
      recurring_parent_id: f.pestParent.id, recurring_pattern: 'quarterly', service_type: 'Quarterly Pest Control',
      service_id: f.pest[0].service_id, scheduled_date: addDays(dateOnly(f.lawn[0].scheduled_date), 1),
      window_start: '15:00', window_end: '16:00', estimated_duration_minutes: 30,
    }).returning('id');
    await db.raw('UPDATE scheduled_services SET status = NULL WHERE id = ?', [legacy.id || legacy]);
    await expect(moveLawnSeries(f)).rejects.toMatchObject({ statusCode: 409, code: 'SLOT_TAKEN', memberId: f.pest[0].id });
  });

  test('a legacy partner with no status is never left behind: the whole move refuses', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    const f = await build();
    const [legacy] = await db('scheduled_services').insert({
      id: randomUUID(), customer_id: f.customerId, technician_id: f.techId, status: 'pending', visit_id: f.visits[0].id,
      service_type: 'Mosquito', scheduled_date: dateOnly(f.lawn[0].scheduled_date),
      window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 30,
    }).returning('id');
    const legacyId = legacy.id || legacy;
    await db.raw('UPDATE scheduled_services SET status = NULL WHERE id = ?', [legacyId]);
    const before = await rowsOf([...f.lawn.map((r) => r.id), ...f.pest.map((r) => r.id), legacyId]);
    await expect(moveLawnSeries(f)).rejects.toMatchObject({ statusCode: 409, code: 'VISIT_MEMBER_NOT_MOVABLE', memberId: legacyId });
    const after = await rowsOf([...before.keys()]);
    for (const [id, r] of before) expect(dateOnly(after.get(id).scheduled_date)).toBe(dateOnly(r.scheduled_date));
  });

  test('through reschedule(): a retried committed carry replays even after the visit froze', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    process.env.GATE_ADMIN_COLLECTIVE_MOVE = 'true';
    try {
      const f = await build();
      const anchor = f.lawn[0];
      const target = addDays(dateOnly(anchor.scheduled_date), 1);
      const opts = { allowLive: true, sourceSurface: 'dispatch_board', notifyRequested: false, overlapAdvisory: true, operationKey: `retry-${randomUUID()}` };
      const first = await rebooker.reschedule(anchor.id, target, '09:00-10:00', 'admin', 'admin', opts);
      expect(first.seriesMoveId).toBeTruthy();
      await db('service_visits').where({ id: f.visits[0].id }).update({ status: 'closing' });
      const again = await rebooker.reschedule(anchor.id, target, '09:00-10:00', 'admin', 'admin', opts);
      expect(again.seriesMoveId).toBe(first.seriesMoveId);
      expect(again.replayed).toBe(true);
    } finally {
      delete process.env.GATE_ADMIN_COLLECTIVE_MOVE;
    }
  });

  test('Quick Move never carries: its series shift keeps the refusal, so rain-out moves the stop alone', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    const f = await build();
    const anchor = f.lawn[0];
    await expect(rebooker.rescheduleSeries(anchor.id, addDays(dateOnly(anchor.scheduled_date), 1), '09:00-10:00', 'weather_rain', 'tech', {
      allowLive: true, sourceSurface: 'quick_move', notifyRequested: false, overlapAdvisory: true,
    })).rejects.toMatchObject({ statusCode: 409, code: 'VISIT_SERIES_MOVE_UNSUPPORTED' });
  });

  test('a visit whose ONLY partner has no status still counts as grouped: the move refuses', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    const f = await build();
    await db.raw('UPDATE scheduled_services SET status = NULL WHERE id = ?', [f.pest[0].id]);
    const before = await rowsOf([...f.lawn.map((r) => r.id), ...f.pest.map((r) => r.id)]);
    await expect(moveLawnSeries(f)).rejects.toMatchObject({ statusCode: 409, code: 'VISIT_MEMBER_NOT_MOVABLE', memberId: f.pest[0].id });
    const after = await rowsOf([...before.keys()]);
    for (const [id, r] of before) expect(dateOnly(after.get(id).scheduled_date)).toBe(dateOnly(r.scheduled_date));
  });

  test('a row of ANOTHER customer miswired into the visit is never carried: the move refuses', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    const f = await build();
    const otherCustomer = randomUUID();
    await db('customers').insert({ id: otherCustomer, first_name: 'Other', last_name: 'Fixture', email: `${otherCustomer}@example.invalid`, phone: '+19415550000', address_line1: '1 Elsewhere', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer' });
    await db('scheduled_services').where({ id: f.pest[0].id }).update({ customer_id: otherCustomer });
    const before = await rowsOf([...f.lawn.map((r) => r.id), ...f.pest.map((r) => r.id)]);
    await expect(moveLawnSeries(f)).rejects.toMatchObject({ statusCode: 409, code: 'VISIT_MEMBER_DETACHED', memberId: f.pest[0].id });
    const after = await rowsOf([...before.keys()]);
    for (const [id, r] of before) expect(dateOnly(after.get(id).scheduled_date)).toBe(dateOnly(r.scheduled_date));
  });

  test('an occurrence pointing at ANOTHER customer\'s visit carries nothing: the move refuses', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    const f = await build();
    const otherCustomer = randomUUID();
    await db('customers').insert({ id: otherCustomer, first_name: 'Other', last_name: 'Owner', email: `${otherCustomer}@example.invalid`, phone: '+19415550001', address_line1: '2 Elsewhere', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer' });
    // The visit and its pest partner belong to another customer; the lawn row points at it.
    await db('service_visits').where({ id: f.visits[0].id }).update({ customer_id: otherCustomer });
    await db('scheduled_services').where({ id: f.pest[0].id }).update({ customer_id: otherCustomer });
    const before = await rowsOf([...f.lawn.map((r) => r.id), ...f.pest.map((r) => r.id)]);
    await expect(moveLawnSeries(f)).rejects.toMatchObject({ statusCode: 409, code: 'VISIT_SERIES_MOVE_UNSUPPORTED' });
    const after = await rowsOf([...before.keys()]);
    for (const [id, r] of before) expect(dateOnly(after.get(id).scheduled_date)).toBe(dateOnly(r.scheduled_date));
  });

  test('each carried partner gets its own reschedule_log row tied to the operation', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    const f = await build();
    const result = await moveLawnSeries(f);
    const logs = await db('reschedule_log').whereIn('scheduled_service_id', f.pest.map((r) => r.id)).select('*');
    expect(logs.map((l) => String(l.scheduled_service_id)).sort()).toEqual(f.pest.map((r) => String(r.id)).sort());
    for (const l of logs) {
      expect(String(l.series_move_id)).toBe(String(result.seriesMoveId));
      expect(dateOnly(l.new_date)).toBe(addDays(dateOnly(l.original_date), 1));
    }
  });

  test('gate off: the grouped series move is refused exactly as before and nothing moves', async () => {
    const f = await build();
    const before = await rowsOf([...f.lawn.map((r) => r.id), ...f.pest.map((r) => r.id)]);
    await expect(moveLawnSeries(f)).rejects.toMatchObject({ statusCode: 409, code: 'VISIT_SERIES_MOVE_UNSUPPORTED' });
    const after = await rowsOf([...before.keys()]);
    for (const [id, r] of before) expect(dateOnly(after.get(id).scheduled_date)).toBe(dateOnly(r.scheduled_date));
  });

  test('a customer-initiated series move keeps today\'s refusal even with the gate on', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    const f = await build();
    const before = await rowsOf([...f.lawn.map((r) => r.id), ...f.pest.map((r) => r.id)]);
    await expect(moveLawnSeries(f, { by: 'customer_self_serve' })).rejects.toMatchObject({ statusCode: 409, code: 'VISIT_CUSTOMER_MOVE_UNSUPPORTED' });
    const after = await rowsOf([...before.keys()]);
    for (const [id, r] of before) expect(dateOnly(after.get(id).scheduled_date)).toBe(dateOnly(r.scheduled_date));
  });

  test('a frozen visit later in the series still refuses the move, and nothing is written', async () => {
    process.env.GATE_SERIES_MOVE_CARRIES_VISIT = 'true';
    const f = await build();
    await db('service_visits').where({ id: f.visits[1].id }).update({ status: 'closing' });
    const before = await rowsOf([...f.lawn.map((r) => r.id), ...f.pest.map((r) => r.id)]);
    await expect(moveLawnSeries(f)).rejects.toMatchObject({ statusCode: 409, code: 'VISIT_SERIES_MOVE_UNSUPPORTED' });
    const after = await rowsOf([...before.keys()]);
    for (const [id, r] of before) expect(dateOnly(after.get(id).scheduled_date)).toBe(dateOnly(r.scheduled_date));
  });
});
