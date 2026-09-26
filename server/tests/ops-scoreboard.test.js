jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { parseETDateTime } = require('../utils/datetime-et');
const {
  computeOpsScoreboard,
  classifyCall,
  classifyBooking,
  planFollowed,
  resolveWindow,
} = require('../services/ops-scoreboard');

// ─── classifyCall ──────────────────────────────────────────────────────
describe('classifyCall', () => {
  test('AI-handled, no transfer', () => {
    expect(classifyCall({ answered_by: 'ai_agent', call_outcome: null })).toBe('ai_handled');
    expect(classifyCall({ answered_by: 'ai_agent', call_outcome: 'ai_handled' })).toBe('ai_handled');
  });
  test('a transferred AI call is NOT counted as AI-handled', () => {
    expect(classifyCall({ answered_by: 'ai_agent', call_outcome: 'ai_transferred' })).toBe('transferred');
  });
  test('human and voicemail are their own buckets', () => {
    expect(classifyCall({ answered_by: 'human', call_outcome: null })).toBe('human');
    expect(classifyCall({ answered_by: 'voicemail', call_outcome: 'voicemail' })).toBe('voicemail');
  });
});

// ─── classifyBooking ───────────────────────────────────────────────────
describe('classifyBooking', () => {
  test('each AI source_action buckets as ai', () => {
    expect(classifyBooking({ source_action: 'ai_call_pipeline' })).toBe('ai');
    expect(classifyBooking({ source_action: 'voice_agent' })).toBe('ai');
    expect(classifyBooking({ source_action: 'ai_call_outbound_review' })).toBe('ai');
  });
  test('a self-booked or reservice-link row is customer_self_serve', () => {
    expect(classifyBooking({ self_booking_id: 'sba-1', source: 'direct' })).toBe('customer_self_serve');
    expect(classifyBooking({ source: 'reservice_link' })).toBe('customer_self_serve');
  });
  test('admin_manual and plain admin (no source_estimate_id ambiguity signal) are staff', () => {
    expect(classifyBooking({ source: 'admin_manual' })).toBe('staff');
    expect(classifyBooking({ source: 'admin' })).toBe('staff');
  });
  test('GAP: an admin-sourced row with source_estimate_id set is counted as staff, not guessed as customer self-serve', () => {
    // Per the brief: the customer-facing estimate-accept flow never stamps a
    // distinct `source`, so this row is indistinguishable from a staff
    // conversion by the data alone. classifyBooking only sees source/
    // self_booking_id/source_action, so this is bucketed as staff.
    expect(classifyBooking({ source: 'admin', source_estimate_id: 'est-1' })).toBe('staff');
  });
});

// ─── planFollowed ──────────────────────────────────────────────────────
describe('planFollowed', () => {
  const plan = { date: '2026-09-08', technician_id: 'tech-1', plannedStops: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  const onRoute = { scheduled_date: '2026-09-08', technician_id: 'tech-1' };
  const stop = (fields) => ({ ...onRoute, ...fields });
  const rowsById = (overrides) => new Map(Object.entries({
    a: stop({ status: 'completed', arrived_at: '2026-09-08T12:00:00Z' }),
    b: stop({ status: 'completed', arrived_at: '2026-09-08T13:00:00Z' }),
    c: stop({ status: 'completed', arrived_at: '2026-09-08T14:00:00Z' }),
    ...overrides,
  }));

  test('arrival order matches the plan order -> followed', () => {
    expect(planFollowed(plan, rowsById())).toBe(true);
  });

  test('arrival order out of the plan order -> not followed', () => {
    const rows = rowsById({
      a: stop({ status: 'completed', arrived_at: '2026-09-08T14:00:00Z' }),
      c: stop({ status: 'completed', arrived_at: '2026-09-08T12:00:00Z' }),
    });
    expect(planFollowed(plan, rows)).toBe(false);
  });

  test('falls back to check_in_time when arrived_at is missing', () => {
    const rows = rowsById({
      a: stop({ status: 'completed', arrived_at: null, check_in_time: '2026-09-08T14:00:00Z' }),
      c: stop({ status: 'completed', arrived_at: null, check_in_time: '2026-09-08T12:00:00Z' }),
    });
    expect(planFollowed(plan, rows)).toBe(false);
  });

  test('fewer than 2 timed completed stops cannot violate an order -> followed', () => {
    const onlyOneCompleted = new Map([
      ['a', stop({ status: 'completed', arrived_at: '2026-09-08T12:00:00Z' })],
      ['b', stop({ status: 'pending' })],
      ['c', stop({ status: 'cancelled' })],
    ]);
    expect(planFollowed(plan, onlyOneCompleted)).toBe(true);
  });

  test('a missing row (never dispatched) does not count as completed and cannot break the order', () => {
    const rows = new Map([
      ['a', stop({ status: 'completed', arrived_at: '2026-09-08T12:00:00Z' })],
      ['b', stop({ status: 'completed', arrived_at: '2026-09-08T13:00:00Z' })],
    ]); // 'c' absent entirely
    expect(planFollowed(plan, rows)).toBe(true);
  });

  test('a stop moved to another day or reassigned does not judge this route', () => {
    const rows = rowsById({
      a: { status: 'completed', arrived_at: '2026-09-09T14:00:00Z', scheduled_date: '2026-09-09', technician_id: 'tech-1' },
      c: { status: 'completed', arrived_at: '2026-09-08T09:00:00Z', scheduled_date: '2026-09-08', technician_id: 'tech-2' },
    });
    // Only b is still on this route: nothing left to contradict the plan.
    expect(planFollowed(plan, rows)).toBe(true);
  });

  test('a tech-day with no completed stop left on it is not scored', () => {
    const rows = new Map([
      ['a', stop({ status: 'pending' })],
      ['b', { status: 'completed', arrived_at: '2026-09-09T13:00:00Z', scheduled_date: '2026-09-09', technician_id: 'tech-1' }],
    ]);
    expect(planFollowed(plan, rows)).toBeNull();
  });
});

// ─── resolveWindow ─────────────────────────────────────────────────────
describe('resolveWindow', () => {
  test('defaults to the last completed 7-day week ending yesterday', () => {
    const { from, to } = resolveWindow({});
    const days = Math.round((parseETDateTime(`${to}T12:00`) - parseETDateTime(`${from}T12:00`)) / 86400000) + 1;
    expect(days).toBe(7);
  });
  test('caps the window at 92 days', () => {
    const { from, to } = resolveWindow({ from: '2020-01-01', to: '2020-12-31' });
    const days = Math.round((parseETDateTime(`${to}T12:00`) - parseETDateTime(`${from}T12:00`)) / 86400000) + 1;
    expect(days).toBeLessThanOrEqual(92);
  });
  test('an invalid date falls back to the default rather than reaching SQL', () => {
    const { from, to } = resolveWindow({ from: 'not-a-date', to: 'also-not-a-date' });
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ─── computeOpsScoreboard: query-shape + isolation + null-share tests ──
// A minimal filtering fake knex: records every where*/whereRaw/whereNot call
// on a builder and, at resolution time, replays them against the table's
// canned rows. Covers exactly the predicate shapes ops-scoreboard.js issues
// (two-arg equality where, whereNull/whereNotNull, whereIn, the three
// whereRaw patterns it uses, and a whereNot(fn) grouped negation) — not a
// general SQL engine.
function evalRaw(row, sql, bindings = []) {
  if (sql.includes(">= ?::timestamp AT TIME ZONE")) {
    const column = sql.split(' >=')[0].trim();
    const bound = parseETDateTime(bindings[0]);
    return row[column] != null && new Date(row[column]).getTime() >= bound.getTime();
  }
  if (sql.includes("<  (?::timestamp + INTERVAL '1 day') AT TIME ZONE")) {
    const column = sql.split(' <')[0].trim();
    const bound = parseETDateTime(bindings[0]);
    return row[column] != null && new Date(row[column]).getTime() < bound.getTime() + 86400000;
  }
  if (sql.startsWith("COALESCE(??, '') <> ?")) {
    const [column, value] = bindings;
    return (row[column] ?? '') !== value;
  }
  if (sql.includes("COALESCE(source, '') NOT ILIKE '%import%'")) {
    return !String(row.source ?? '').toLowerCase().includes('import');
  }
  return true;
}

function evalCall(row, [method, args]) {
  switch (method) {
    case 'where': {
      if (args.length === 3) {
        const [column, op, value] = args;
        const cell = row[column];
        if (op === '>=') return cell >= value;
        if (op === '<=') return cell <= value;
        if (op === '>') return cell > value;
        if (op === '<') return cell < value;
        return cell === value;
      }
      return row[args[0]] === args[1];
    }
    case 'whereNull': return row[args[0]] == null;
    case 'whereNotNull': return row[args[0]] != null;
    case 'whereIn': return (args[1] || []).includes(row[args[0]]);
    case 'whereRaw': return evalRaw(row, args[0], args[1]);
    case 'whereNot': {
      const sub = makeRecorder([]);
      args[0](sub);
      return !sub.calls.every((call) => evalCall(row, call));
    }
    default: return true;
  }
}

function makeRecorder(calls = []) {
  const builder = { calls };
  ['where', 'whereNull', 'whereNotNull', 'whereIn', 'whereRaw', 'whereNot'].forEach((m) => {
    builder[m] = (...args) => { calls.push([m, args]); return builder; };
  });
  builder.modify = (fn) => { fn(builder); return builder; };
  builder.select = () => builder;
  builder.orderBy = () => builder;
  builder.limit = () => builder;
  return builder;
}

function makeFilteringDb(rowsByTable, { throwOnTable } = {}) {
  const dbFn = (table) => {
    if (throwOnTable === table) {
      throw new Error(`simulated failure for ${table}`);
    }
    const recorder = makeRecorder();
    const rows = rowsByTable[table] || [];
    const resolved = () => rows.filter((row) => recorder.calls.every((call) => evalCall(row, call)));
    recorder.then = (resolve, reject) => Promise.resolve(resolved()).then(resolve, reject);
    recorder.first = () => Promise.resolve(resolved()[0]);
    return recorder;
  };
  dbFn.raw = (sql) => sql;
  return dbFn;
}

const WIN = { from: '2026-09-01', to: '2026-09-07' };
function etTs(dateStr) { return `${dateStr}T12:00:00.000Z`; } // safely inside any ET calendar day

describe('computeOpsScoreboard — ai_call_share', () => {
  test('sandbox calls are excluded from both numerator and denominator', async () => {
    const rows = {
      call_log: [
        { direction: 'inbound', answered_by: 'ai_agent', call_outcome: null, source: 'voice_relay_sandbox', created_at: etTs('2026-09-03') },
        { direction: 'inbound', answered_by: 'human', call_outcome: null, source: 'twilio', created_at: etTs('2026-09-03') },
      ],
    };
    const out = await computeOpsScoreboard(WIN, makeFilteringDb(rows));
    expect(out.aiCallShare).toEqual({ numerator: 0, denominator: 1, share: 0, aiHandled: 0, transferred: 0, voicemail: 0, humanAnswered: 1 });
  });

  test('a transferred AI call counts in the denominator but not the AI-handled numerator', async () => {
    const rows = {
      call_log: [
        { direction: 'inbound', answered_by: 'ai_agent', call_outcome: 'ai_transferred', source: 'twilio', created_at: etTs('2026-09-03') },
        { direction: 'inbound', answered_by: 'ai_agent', call_outcome: null, source: 'twilio', created_at: etTs('2026-09-04') },
      ],
    };
    const out = await computeOpsScoreboard(WIN, makeFilteringDb(rows));
    expect(out.aiCallShare).toMatchObject({ numerator: 1, denominator: 2, transferred: 1, aiHandled: 1 });
    expect(out.aiCallShare.share).toBeCloseTo(0.5);
  });

  test('a voicemail is neither answered nor AI-handled', async () => {
    const rows = { call_log: [{ direction: 'inbound', answered_by: 'voicemail', call_outcome: 'voicemail', source: 'twilio', created_at: etTs('2026-09-03') }] };
    const out = await computeOpsScoreboard(WIN, makeFilteringDb(rows));
    expect(out.aiCallShare).toEqual({ numerator: 0, denominator: 0, share: null, aiHandled: 0, transferred: 0, voicemail: 1, humanAnswered: 0 });
  });

  test('outside-the-window calls are excluded', async () => {
    const rows = { call_log: [{ direction: 'inbound', answered_by: 'human', call_outcome: null, source: 'twilio', created_at: etTs('2026-08-15') }] };
    const out = await computeOpsScoreboard(WIN, makeFilteringDb(rows));
    expect(out.aiCallShare).toEqual({ numerator: 0, denominator: 0, share: null, aiHandled: 0, transferred: 0, voicemail: 0, humanAnswered: 0 });
  });
});

describe('computeOpsScoreboard — bookings_without_staff', () => {
  const base = (overrides) => ({
    recurring_parent_id: null, parent_service_id: null, source: 'admin_manual',
    customer_id: 'cust-1', reservation_expires_at: null, created_at: etTs('2026-09-03'),
    source_action: null, self_booking_id: null,
    ...overrides,
  });

  test('recurring series children are excluded', async () => {
    const rows = { scheduled_services: [base({ recurring_parent_id: 'parent-1' })] };
    const out = await computeOpsScoreboard(WIN, makeFilteringDb(rows));
    expect(out.bookingsWithoutStaff).toEqual({ numerator: 0, denominator: 0, share: null, ai: 0, customerSelfServe: 0, staff: 0, aiPendingReview: 0 });
  });

  test('auto-created follow-up visits are excluded', async () => {
    const rows = { scheduled_services: [base({ parent_service_id: 'primary-1' })] };
    const out = await computeOpsScoreboard(WIN, makeFilteringDb(rows));
    expect(out.bookingsWithoutStaff.denominator).toBe(0);
  });

  test('import rows are excluded', async () => {
    const rows = { scheduled_services: [base({ source: 'legacy_import' })] };
    const out = await computeOpsScoreboard(WIN, makeFilteringDb(rows));
    expect(out.bookingsWithoutStaff.denominator).toBe(0);
  });

  test('an uncommitted estimate slot hold (customer_id null + a live expiry) is excluded', async () => {
    const rows = { scheduled_services: [base({ customer_id: null, reservation_expires_at: '2026-09-05T00:00:00Z' })] };
    const out = await computeOpsScoreboard(WIN, makeFilteringDb(rows));
    expect(out.bookingsWithoutStaff.denominator).toBe(0);
  });

  test('each bucket counts independently: ai, customer_self_serve, staff', async () => {
    const rows = {
      scheduled_services: [
        base({ source_action: 'ai_call_pipeline' }),
        base({ source_action: 'voice_agent' }),
        base({ self_booking_id: 'sba-1', source: 'direct' }),
        base({ source: 'reservice_link' }),
        base({ source: 'admin_manual' }),
        base({ source: 'admin' }), // plain admin, no estimate ambiguity
      ],
    };
    const out = await computeOpsScoreboard(WIN, makeFilteringDb(rows));
    expect(out.bookingsWithoutStaff).toEqual({
      numerator: 4, denominator: 6, share: 4 / 6, ai: 2, customerSelfServe: 2, staff: 2, aiPendingReview: 0,
    });
  });

  test('an AI booking still awaiting office review is not a booking yet; once confirmed it counts as ai', async () => {
    const rows = {
      scheduled_services: [
        base({ source_action: 'voice_agent', status: 'pending', customer_confirmed: false }),
        base({ source_action: 'ai_call_outbound_review', status: 'pending', customer_confirmed: false }),
        base({ source_action: 'voice_agent', status: 'confirmed', customer_confirmed: true }),
      ],
    };
    const out = await computeOpsScoreboard(WIN, makeFilteringDb(rows));
    expect(out.bookingsWithoutStaff).toMatchObject({ ai: 1, denominator: 1, aiPendingReview: 2 });
  });
});

describe('computeOpsScoreboard — drive_minutes_per_stop', () => {
  test('averages the en-route → arrived taps of completed stops in the window', async () => {
    const rows = {
      scheduled_services: [
        { status: 'completed', scheduled_date: '2026-09-02', en_route_at: '2026-09-02T13:00:00Z', arrived_at: '2026-09-02T13:10:00Z' },
        { status: 'completed', scheduled_date: '2026-09-03', en_route_at: '2026-09-03T14:00:00Z', arrived_at: '2026-09-03T14:20:00Z' },
      ],
      mileage_log: [
        { trip_date: '2026-09-02', duration_minutes: 30, distance_miles: 12.5 },
        { trip_date: '2026-09-03', duration_minutes: 45, distance_miles: 20 },
        { trip_date: '2026-08-20', duration_minutes: 99, distance_miles: 99 },
      ],
    };
    const out = await computeOpsScoreboard(WIN, makeFilteringDb(rows));
    expect(out.driveMinutesPerStop).toMatchObject({ denominator: 2, completedStops: 2, timedStops: 2, vanDrivingMinutes: 75, vanDrivingMiles: 32.5 });
    expect(out.driveMinutesPerStop.share).toBeCloseTo(15);
  });

  test('a stop missing a tap, a reversed pair, or a >3h gap is not timed — but still counts as completed', async () => {
    const rows = {
      scheduled_services: [
        { status: 'completed', scheduled_date: '2026-09-02', en_route_at: null, arrived_at: '2026-09-02T13:10:00Z' },
        { status: 'completed', scheduled_date: '2026-09-02', en_route_at: '2026-09-02T14:10:00Z', arrived_at: '2026-09-02T14:00:00Z' },
        { status: 'completed', scheduled_date: '2026-09-03', en_route_at: '2026-09-03T08:00:00Z', arrived_at: '2026-09-03T12:00:00Z' },
        { status: 'completed', scheduled_date: '2026-09-03', en_route_at: '2026-09-03T15:00:00Z', arrived_at: '2026-09-03T15:08:00Z' },
        { status: 'pending', scheduled_date: '2026-09-03', en_route_at: '2026-09-03T16:00:00Z', arrived_at: '2026-09-03T16:30:00Z' },
      ],
      mileage_log: [],
    };
    const out = await computeOpsScoreboard(WIN, makeFilteringDb(rows));
    expect(out.driveMinutesPerStop).toMatchObject({ completedStops: 4, timedStops: 1, vanDrivingMinutes: 0 });
    expect(out.driveMinutesPerStop.share).toBeCloseTo(8);
  });
});

describe('computeOpsScoreboard — failure isolation', () => {
  test('a failing metric query yields { error } for that metric only', async () => {
    const rows = {
      call_log: [{ direction: 'inbound', answered_by: 'human', call_outcome: null, source: 'twilio', created_at: etTs('2026-09-03') }],
      scheduled_services: [],
      route_optimization_planner_runs: [],
    };
    const db = makeFilteringDb(rows, { throwOnTable: 'mileage_log' });
    const out = await computeOpsScoreboard(WIN, db);
    expect(out.driveMinutesPerStop).toEqual({ error: 'unavailable' });
    expect(out.aiCallShare).toMatchObject({ denominator: 1 });
    expect(out.bookingsWithoutStaff).toMatchObject({ denominator: 0 });
    expect(out.aiRouteDays).toMatchObject({ denominator: 0, share: null });
  });
});

describe('computeOpsScoreboard — zero denominators never read as 0%', () => {
  test('no data anywhere -> every share is null, not 0', async () => {
    const db = makeFilteringDb({ mileage_log: [], scheduled_services: [], call_log: [], route_optimization_planner_runs: [] });
    const out = await computeOpsScoreboard(WIN, db);
    expect(out.driveMinutesPerStop.share).toBeNull();
    expect(out.aiCallShare.share).toBeNull();
    expect(out.bookingsWithoutStaff.share).toBeNull();
    expect(out.aiRouteDays.share).toBeNull();
  });
});

// ─── ai_route_days: followed / applied-reorder / missing-snapshot ──────
describe('computeOpsScoreboard — ai_route_days', () => {
  function makeRouteDayDb({ runs, plannedRows, completedRows }) {
    const dbFn = (table) => {
      if (table === 'route_optimization_planner_runs') {
        const recorder = makeRecorder();
        recorder.then = (resolve) => resolve(runs);
        return recorder;
      }
      if (table === 'scheduled_services') {
        // Distinguish the plannedIds lookup (uses whereIn) from the
        // completed-work sweep (uses where('status', 'completed')) by which
        // builder method the caller reaches for.
        const recorder = { calls: [] };
        let usedWhereIn = false;
        recorder.whereIn = (...args) => { usedWhereIn = true; recorder.calls.push(args); return recorder; };
        recorder.where = () => recorder;
        recorder.select = () => recorder;
        recorder.then = (resolve) => resolve(usedWhereIn ? plannedRows : completedRows);
        return recorder;
      }
      throw new Error(`unexpected table ${table}`);
    };
    dbFn.raw = (sql) => sql;
    return dbFn;
  }

  const RUN_WINDOW = { from: '2026-09-08', to: '2026-09-08' };

  function makeRun({ techId = 'tech-1', phase = 'loaded_schedule', stopIds = ['a', 'b'] }) {
    return {
      id: 'run-1',
      created_at: '2026-09-07T10:00:00Z',
      result: {
        route_quality: [{
          date: '2026-09-08', technician_id: techId, as_of: '2026-09-07T08:00:00Z', snapshot_phase: phase,
          plannedStops: stopIds.map((id) => ({ id, serviceMinutes: 30, arrivalWindow: { startMin: 480, endMin: 600 } })),
        }],
      },
    };
  }

  test('a tech-day driven in plan order is followed', async () => {
    const db = makeRouteDayDb({
      runs: [makeRun({})],
      plannedRows: [
        { id: 'a', status: 'completed', arrived_at: '2026-09-08T12:00:00Z', scheduled_date: '2026-09-08', technician_id: 'tech-1' },
        { id: 'b', status: 'completed', arrived_at: '2026-09-08T13:00:00Z', scheduled_date: '2026-09-08', technician_id: 'tech-1' },
      ],
      completedRows: [{ technician_id: 'tech-1', scheduled_date: '2026-09-08' }],
    });
    const out = await computeOpsScoreboard(RUN_WINDOW, db);
    expect(out.aiRouteDays).toEqual({
      numerator: 1, denominator: 1, share: 1,
      daysFollowed: 1, totalTechDaysWithSnapshot: 1, techDaysWithNoCompletedPlannedStop: 0, daysWithAppliedReorder: 0, completedTechDaysWithNoSnapshot: 0,
    });
  });

  test('a tech-day driven out of plan order is not followed, and an applied_reorder snapshot is counted separately', async () => {
    const db = makeRouteDayDb({
      runs: [makeRun({ phase: 'applied_reorder' })],
      plannedRows: [
        { id: 'a', status: 'completed', arrived_at: '2026-09-08T13:00:00Z', scheduled_date: '2026-09-08', technician_id: 'tech-1' },
        { id: 'b', status: 'completed', arrived_at: '2026-09-08T12:00:00Z', scheduled_date: '2026-09-08', technician_id: 'tech-1' },
      ],
      completedRows: [],
    });
    const out = await computeOpsScoreboard(RUN_WINDOW, db);
    expect(out.aiRouteDays).toMatchObject({
      numerator: 0, denominator: 1, share: 0, daysWithAppliedReorder: 1,
    });
  });

  test('completed work with no matching plan snapshot is reported separately, not folded into the denominator', async () => {
    const db = makeRouteDayDb({
      runs: [],
      plannedRows: [],
      completedRows: [{ technician_id: 'tech-2', scheduled_date: '2026-09-08' }],
    });
    const out = await computeOpsScoreboard(RUN_WINDOW, db);
    expect(out.aiRouteDays).toEqual({
      numerator: 0, denominator: 0, share: null,
      daysFollowed: 0, totalTechDaysWithSnapshot: 0, techDaysWithNoCompletedPlannedStop: 0, daysWithAppliedReorder: 0, completedTechDaysWithNoSnapshot: 1,
    });
  });
});
