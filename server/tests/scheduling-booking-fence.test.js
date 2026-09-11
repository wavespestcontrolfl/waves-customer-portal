/**
 * fenceBookingDay — the bounded, NON-BLOCKING scheduling fence the phone-
 * booking writer takes before each INSERT (owner ruling 2026-09-11, capacity
 * activation option 1). Contract under test:
 *   - rung 1 (`occupancy:<date>`) is tried before rung 3 (`<tech|unassigned>:<date>`)
 *   - only pg_try_advisory_xact_lock is ever issued (never the blocking form)
 *   - a busy rung is re-tried until the cap, then reported as a miss — never thrown
 *   - a rung already granted is not re-requested on later polls
 *   - a partial grant (rung 1 yes, rung 3 no at the cap) reports acquired=false
 *   - CALL_BOOKING_FENCE_WAIT_MS overrides the cap; a bad value falls back
 */
const occupancy = require('../services/scheduling/occupancy');

const { fenceBookingDay, CALL_BOOKING_FENCE_WAIT_MS } = occupancy;

function fakeTrx(answers) {
  // answers: array of booleans consumed per try-lock statement, in order.
  const queue = [...answers];
  const raw = jest.fn(async (sql) => {
    expect(sql).toContain('pg_try_advisory_xact_lock');
    expect(sql).not.toMatch(/pg_advisory_xact_lock\(/);
    const locked = queue.length ? queue.shift() : true;
    return { rows: [{ locked }] };
  });
  return { raw };
}

function clock() {
  let t = 0;
  return { now: () => t, sleep: jest.fn(async (ms) => { t += ms; }) };
}

describe('fenceBookingDay', () => {
  afterEach(() => { delete process.env.CALL_BOOKING_FENCE_WAIT_MS; });

  test('grants rung 1 then rung 3 in canonical order on the first try', async () => {
    const trx = fakeTrx([true, true]);
    const c = clock();
    const out = await fenceBookingDay(trx, { date: '2099-01-05T00:00:00.000Z', techId: 'tech-1', waitMs: 1500, pollMs: 50, ...c });
    expect(out).toEqual({ acquired: true, keys: ['occupancy:2099-01-05', 'tech-1:2099-01-05'], deadline: 1500 });
    expect(trx.raw.mock.calls.map((call) => call[1])).toEqual([
      ['slot-reserve', 'occupancy:2099-01-05'],
      ['slot-reserve', 'tech-1:2099-01-05'],
    ]);
    expect(c.sleep).not.toHaveBeenCalled();
  });

  test('an unassigned booking fences the unassigned-day rung', async () => {
    const trx = fakeTrx([true, true]);
    const out = await fenceBookingDay(trx, { date: '2099-01-05', techId: null, waitMs: 0, pollMs: 50, ...clock() });
    expect(out.acquired).toBe(true);
    expect(trx.raw.mock.calls[1][1]).toEqual(['slot-reserve', 'unassigned:2099-01-05']);
  });

  test('a busy date rung is polled until granted, and is never re-requested once held', async () => {
    // rung 1 busy twice, then granted; rung 3 granted.
    const trx = fakeTrx([false, false, true, true]);
    const c = clock();
    const out = await fenceBookingDay(trx, { date: '2099-01-05', techId: 'tech-1', waitMs: 1500, pollMs: 50, ...c });
    expect(out.acquired).toBe(true);
    expect(c.sleep).toHaveBeenCalledTimes(2);
    expect(trx.raw.mock.calls.map((call) => call[1][1])).toEqual([
      'occupancy:2099-01-05', 'occupancy:2099-01-05', 'occupancy:2099-01-05', 'tech-1:2099-01-05',
    ]);
  });

  test('a rung held past the cap is reported as a miss, never thrown', async () => {
    const trx = fakeTrx([false, false, false, false, false, false]);
    const c = clock();
    const out = await fenceBookingDay(trx, { date: '2099-01-05', techId: 'tech-1', waitMs: 120, pollMs: 50, ...c });
    expect(out).toEqual({ acquired: false, keys: [], reason: 'date_busy', deadline: 120 });
    // Tries at 0/50/100ms; the last sleep is CLAMPED to the 20ms left and,
    // once the timer wakes AT the deadline, no further try is made — the
    // cap is a hard cap on wall time (codex r1 + r3 P2).
    expect(trx.raw).toHaveBeenCalledTimes(3);
    expect(c.sleep.mock.calls.map((call) => call[0])).toEqual([50, 50, 20]);
    expect(c.now()).toBe(120);
  });

  test('an oversleeping timer never leads to a try past the cap, even if the rung frees up meanwhile (codex r3 P2)', async () => {
    // Production timers can wake late; the clock here jumps 500ms on the
    // final sleep. The rung is free by then — it must NOT be taken.
    const trx = fakeTrx([false, false, false, true, true]);
    let t = 0;
    const sleep = jest.fn(async (ms) => { t += ms === 20 ? 500 : ms; });
    const out = await fenceBookingDay(trx, { date: '2099-01-05', techId: 'tech-1', waitMs: 120, pollMs: 50, sleep, now: () => t });
    expect(out).toEqual({ acquired: false, keys: [], reason: 'date_busy', deadline: 120 });
    expect(trx.raw).toHaveBeenCalledTimes(3);
  });

  test('a rung released before the deadline is still granted within the cap', async () => {
    const trx = fakeTrx([false, false, true, true]);
    const c = clock();
    const out = await fenceBookingDay(trx, { date: '2099-01-05', techId: 'tech-1', waitMs: 120, pollMs: 50, ...c });
    expect(out.acquired).toBe(true);
    expect(c.now()).toBe(100);
  });

  test('rung 1 granted but the tech-day rung busy at the cap is a PARTIAL grant → acquired=false, key kept', async () => {
    const trx = fakeTrx([true, false, false, false]);
    const c = clock();
    const out = await fenceBookingDay(trx, { date: '2099-01-05', techId: 'tech-1', waitMs: 60, pollMs: 50, ...c });
    expect(out).toEqual({ acquired: false, keys: ['occupancy:2099-01-05'], reason: 'tech_day_busy', deadline: 60 });
    // rung 1 was requested exactly once; the rest are rung-3 retries.
    expect(trx.raw.mock.calls.filter((call) => call[1][1] === 'occupancy:2099-01-05')).toHaveLength(1);
  });

  test('a missing date is a no-op miss', async () => {
    const trx = fakeTrx([]);
    expect(await fenceBookingDay(trx, { date: null, techId: 'tech-1', ...clock() }))
      .toEqual({ acquired: false, keys: [], reason: 'no_date', deadline: 1500 });
    expect(trx.raw).not.toHaveBeenCalled();
  });

  test('CALL_BOOKING_FENCE_WAIT_MS sets the cap; a bad value falls back to the default', async () => {
    process.env.CALL_BOOKING_FENCE_WAIT_MS = '0';
    let trx = fakeTrx([false]);
    let out = await fenceBookingDay(trx, { date: '2099-01-05', techId: 'tech-1', pollMs: 50, ...clock() });
    expect(out.acquired).toBe(false);
    expect(trx.raw).toHaveBeenCalledTimes(1);

    process.env.CALL_BOOKING_FENCE_WAIT_MS = 'soon';
    trx = fakeTrx([false, false, true, true]);
    const c = clock();
    out = await fenceBookingDay(trx, { date: '2099-01-05', techId: 'tech-1', pollMs: 500, ...c });
    expect(out.acquired).toBe(true);
    expect(CALL_BOOKING_FENCE_WAIT_MS).toBe(1500);
    expect(c.sleep).toHaveBeenCalledTimes(2);
  });

  test('an absolute `deadline` wins over waitMs, so a re-fence runs inside the FIRST attempt\'s budget (codex r2 P2)', async () => {
    // First attempt: tech-1 busy for the whole 100ms budget → miss at t=100.
    const c = clock();
    let trx = fakeTrx([true, false, false, false]);
    const first = await fenceBookingDay(trx, { date: '2099-01-05', techId: 'tech-1', waitMs: 100, pollMs: 50, ...c });
    expect(first).toMatchObject({ acquired: false, reason: 'tech_day_busy', deadline: 100 });
    expect(c.now()).toBe(100);
    // Re-fence on the unassigned rung with that deadline: budget exhausted →
    // exactly one try per rung, no sleep, and the miss carries the SAME deadline.
    trx = fakeTrx([true, false]);
    const again = await fenceBookingDay(trx, { date: '2099-01-05', techId: null, deadline: first.deadline, waitMs: 1500, pollMs: 50, ...c });
    expect(again).toEqual({ acquired: false, keys: ['occupancy:2099-01-05'], reason: 'tech_day_busy', deadline: 100 });
    expect(trx.raw).toHaveBeenCalledTimes(2);
    expect(c.now()).toBe(100);
    // With budget left, the re-fence polls only up to the ORIGINAL deadline.
    const c2 = clock();
    trx = fakeTrx([true, false, false, false, false, false]);
    const partial = await fenceBookingDay(trx, { date: '2099-01-05', techId: null, deadline: 120, waitMs: 1500, pollMs: 50, ...c2 });
    expect(partial.acquired).toBe(false);
    expect(c2.now()).toBe(120);
    expect(trx.raw).toHaveBeenCalledTimes(4);
  });

  test('a lock query that returns past the deadline ends the attempt: no next rung, no late grant counted (codex r4 P2)', async () => {
    // rung 1 granted, but the round trip itself took 200ms of a 120ms budget.
    let t = 0;
    const raw = jest.fn(async (sql, binds) => { t += binds[1].startsWith('occupancy:') ? 200 : 0; return { rows: [{ locked: true }] }; });
    let out = await fenceBookingDay({ raw }, { date: '2099-01-05', techId: 'tech-1', waitMs: 120, pollMs: 50, sleep: jest.fn(), now: () => t });
    expect(out).toEqual({ acquired: false, keys: ['occupancy:2099-01-05'], reason: 'deadline_exceeded', deadline: 120 });
    expect(raw).toHaveBeenCalledTimes(1);
    // rung 1 in time, rung 3 granted but only after the cap: held, not counted.
    t = 0;
    const raw2 = jest.fn(async (sql, binds) => { t += binds[1].startsWith('occupancy:') ? 10 : 200; return { rows: [{ locked: true }] }; });
    out = await fenceBookingDay({ raw: raw2 }, { date: '2099-01-05', techId: 'tech-1', waitMs: 120, pollMs: 50, sleep: jest.fn(), now: () => t });
    expect(out).toEqual({ acquired: false, keys: ['occupancy:2099-01-05', 'tech-1:2099-01-05'], reason: 'deadline_exceeded', deadline: 120 });
    expect(raw2).toHaveBeenCalledTimes(2);
  });

  test('a query failure propagates (the caller treats the fence as best-effort)', async () => {
    const trx = { raw: jest.fn(async () => { throw new Error('connection reset'); }) };
    await expect(fenceBookingDay(trx, { date: '2099-01-05', techId: 'tech-1', ...clock() }))
      .rejects.toThrow('connection reset');
  });
});
