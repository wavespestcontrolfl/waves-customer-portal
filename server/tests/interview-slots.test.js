/**
 * Interview self-scheduling slots (server/services/interview-slots.js):
 * default weekly windows, env override + invalid-JSON fallback, the
 * 4-hour lead time, route-conflict exclusion with its 15-minute buffer,
 * other-applicant conflict exclusion, excludeApplicationId self-exclusion,
 * and isOfferedSlot's re-validation contract.
 *
 * Fixed `now` far from today (2027-03-16, a Tuesday) per the AGENTS
 * near-today rule.
 */

const mockDb = jest.fn((table) => {
  const rows = (mockDb.__tables && mockDb.__tables[table]) || [];
  let filtered = rows.slice();
  let selectedCols = null;
  const builder = {
    where(col, val) {
      if (typeof col === 'object' && col !== null) {
        filtered = filtered.filter((r) => Object.entries(col).every(([k, v]) => r[k] === v));
      } else {
        filtered = filtered.filter((r) => r[col] === val);
      }
      return builder;
    },
    whereNot(col, val) {
      filtered = filtered.filter((r) => r[col] !== val);
      return builder;
    },
    whereIn(col, arr) {
      filtered = filtered.filter((r) => arr.includes(r[col]));
      return builder;
    },
    whereNotIn(col, arr) {
      filtered = filtered.filter((r) => !arr.includes(r[col]));
      return builder;
    },
    whereNotNull(col) {
      filtered = filtered.filter((r) => r[col] != null);
      return builder;
    },
    modify(fn) {
      fn(builder);
      return builder;
    },
    select(...cols) {
      selectedCols = cols.flat();
      return builder;
    },
    first() {
      return Promise.resolve(filtered[0]);
    },
    then(resolve, reject) {
      const out = selectedCols
        ? filtered.map((r) => Object.fromEntries(selectedCols.map((c) => [c, r[c]])))
        : filtered;
      return Promise.resolve(out).then(resolve, reject);
    },
  };
  return builder;
});
mockDb.schema = { hasTable: jest.fn(async () => true) };
jest.mock('../models/db', () => mockDb);

const {
  listInterviewSlots, isOfferedSlot, SLOT_MINUTES, LEAD_HOURS, BUFFER_MINUTES, DEFAULT_WINDOWS,
  _internals,
} = require('../services/interview-slots');

// Tuesday, 8:00 AM ET (EDT, UTC-4 in mid-March).
const NOW = new Date('2027-03-16T12:00:00.000Z');
const TODAY = '2027-03-16';
const WED = '2027-03-17';
const SAT = '2027-03-20';
const SUN = '2027-03-21';

function reset(tables = {}) {
  mockDb.__tables = {
    scheduled_services: [],
    job_applications: [],
    ...tables,
  };
}

beforeEach(() => {
  reset();
  delete process.env.RECRUITING_INTERVIEW_WINDOWS;
});

describe('default windows', () => {
  test('Mon-Fri offer 4-6pm ET, Sat 9-12, Sun none', async () => {
    const slots = await listInterviewSlots({ now: NOW });
    const byDate = {};
    for (const s of slots) {
      (byDate[s.date] = byDate[s.date] || []).push(s);
    }
    // Today (Tue) has the full 4-6pm window: 4 slots of 30 min.
    expect(byDate[TODAY]).toHaveLength(4);
    expect(byDate[TODAY][0].start).toBe(new Date('2027-03-16T20:00:00.000Z').toISOString()); // 4:00pm EDT = 20:00 UTC
    expect(byDate[TODAY][0].label).toBe('Tue Mar 16, 4:00 PM');
    // Wed also 4-6pm.
    expect(byDate[WED]).toHaveLength(4);
    // Saturday offers 9am-12pm ET: 6 slots of 30 min.
    expect(byDate[SAT]).toHaveLength(6);
    // Sunday offers nothing.
    expect(byDate[SUN]).toBeUndefined();
  });

  test('every offered slot is exactly SLOT_MINUTES long', async () => {
    const slots = await listInterviewSlots({ now: NOW });
    for (const s of slots) {
      const durationMin = (new Date(s.end).getTime() - new Date(s.start).getTime()) / 60000;
      expect(durationMin).toBe(SLOT_MINUTES);
    }
  });
});

describe('RECRUITING_INTERVIEW_WINDOWS override', () => {
  test('a valid override replaces the default windows', async () => {
    process.env.RECRUITING_INTERVIEW_WINDOWS = JSON.stringify({ 2: [['14:00', '15:00']] }); // Tuesday only, after the lead-time cutoff
    const slots = await listInterviewSlots({ now: NOW });
    const byDate = {};
    for (const s of slots) (byDate[s.date] = byDate[s.date] || []).push(s);
    expect(byDate[TODAY]).toHaveLength(2); // 10:00-10:30, 10:30-11:00
    expect(byDate[WED]).toBeUndefined();
    expect(byDate[SAT]).toBeUndefined();
  });

  test('invalid JSON falls back to the default windows with one warn, no throw', async () => {
    process.env.RECRUITING_INTERVIEW_WINDOWS = '{not json';
    await expect(listInterviewSlots({ now: NOW })).resolves.toBeDefined();
    const windows = _internals.loadWindows();
    expect(windows).toEqual(DEFAULT_WINDOWS);
  });

  test('a malformed shape (bad weekday key, bad time pair) also falls back to default', () => {
    process.env.RECRUITING_INTERVIEW_WINDOWS = JSON.stringify({ 8: [['10:00', '11:00']] });
    expect(_internals.loadWindows()).toEqual(DEFAULT_WINDOWS);

    process.env.RECRUITING_INTERVIEW_WINDOWS = JSON.stringify({ 2: [['25:00', '11:00']] });
    expect(_internals.loadWindows()).toEqual(DEFAULT_WINDOWS);

    process.env.RECRUITING_INTERVIEW_WINDOWS = JSON.stringify({ 2: [['11:00', '10:00']] }); // end before start
    expect(_internals.loadWindows()).toEqual(DEFAULT_WINDOWS);
  });

  test('an out-of-range HH or MM (24:00, 16:60) also falls back to default', () => {
    process.env.RECRUITING_INTERVIEW_WINDOWS = JSON.stringify({ 2: [['24:00', '16:00']] });
    expect(_internals.loadWindows()).toEqual(DEFAULT_WINDOWS);

    process.env.RECRUITING_INTERVIEW_WINDOWS = JSON.stringify({ 2: [['16:00', '16:60']] });
    expect(_internals.loadWindows()).toEqual(DEFAULT_WINDOWS);
  });

  test('isValidHHMM accepts 00:00-23:59 and rejects out-of-range values', () => {
    expect(_internals.isValidHHMM('00:00')).toBe(true);
    expect(_internals.isValidHHMM('23:59')).toBe(true);
    expect(_internals.isValidHHMM('24:00')).toBe(false);
    expect(_internals.isValidHHMM('16:60')).toBe(false);
  });
});

describe('lead time', () => {
  test('excludes a slot starting before now + LEAD_HOURS', async () => {
    // now = 8:00am ET; LEAD_HOURS=4 pushes the cutoff to 12:00pm ET, well
    // before the 4pm window, so today's window survives untouched (checked
    // above). Push `now` to 3:45pm ET on the SAME day so the 4:00pm slot
    // falls inside the lead window and must be excluded.
    const lateNow = new Date('2027-03-16T19:45:00.000Z'); // 3:45pm EDT
    const slots = await listInterviewSlots({ now: lateNow });
    const today = slots.filter((s) => s.date === TODAY);
    // Cutoff is 7:45pm ET — the 4:00/4:30/5:00/5:30 slots all start before
    // it; only slots starting at/after 7:45pm would qualify, and none exist
    // in a 4-6pm window, so today offers nothing.
    expect(today).toHaveLength(0);
  });

  test(`LEAD_HOURS is ${LEAD_HOURS}`, () => {
    expect(LEAD_HOURS).toBe(4);
  });
});

describe('route-conflict exclusion with buffer', () => {
  test('a scheduled_services window blocks slots within BUFFER_MINUTES on either side', async () => {
    // Route stop 4:30-5:00pm ET today blocks 4:00 (ends 4:30, +15min buffer
    // reaches 4:45 > 4:30 stop start) through 5:15 (starts 5:00, -15min
    // buffer reaches 4:45 < 5:00 stop end)... i.e. every slot from 4:00
    // through 5:00 is excluded; 5:30 survives (5:30 - 15min = 5:15, stop
    // ends 5:00, no overlap).
    reset({
      scheduled_services: [{
        scheduled_date: TODAY, status: 'confirmed',
        window_start: '16:30:00', window_end: '17:00:00', estimated_duration_minutes: null,
      }],
    });
    const slots = await listInterviewSlots({ now: NOW });
    const today = slots.filter((s) => s.date === TODAY).map((s) => s.label);
    expect(today).toEqual(['Tue Mar 16, 5:30 PM']);
  });

  test('cancelled/completed route stops do not block', async () => {
    reset({
      scheduled_services: [
        { scheduled_date: TODAY, status: 'cancelled', window_start: '16:00:00', window_end: '18:00:00' },
        { scheduled_date: TODAY, status: 'completed', window_start: '16:00:00', window_end: '18:00:00' },
      ],
    });
    const slots = await listInterviewSlots({ now: NOW });
    expect(slots.filter((s) => s.date === TODAY)).toHaveLength(4);
  });

  test('skipped/no_show/rescheduled route rows also do not block (shared stops-ahead status set)', async () => {
    reset({
      scheduled_services: [
        { scheduled_date: TODAY, status: 'skipped', window_start: '16:00:00', window_end: '18:00:00' },
        { scheduled_date: TODAY, status: 'no_show', window_start: '16:00:00', window_end: '18:00:00' },
        { scheduled_date: TODAY, status: 'rescheduled', window_start: '16:00:00', window_end: '18:00:00' },
      ],
    });
    const slots = await listInterviewSlots({ now: NOW });
    expect(slots.filter((s) => s.date === TODAY)).toHaveLength(4);
  });

  test('a window with no window_end falls back to estimated_duration_minutes (default 60)', async () => {
    reset({
      scheduled_services: [{
        scheduled_date: TODAY, status: 'confirmed',
        window_start: '16:00:00', window_end: null, estimated_duration_minutes: null,
      }],
    });
    // 4:00pm start, no end, defaults to 60min -> blocks through 5:00pm, plus
    // the 15min buffer on both sides -> 3:45pm through 5:15pm. Every 4-6pm
    // slot up to 5:00 overlaps; only 5:30 survives.
    const slots = await listInterviewSlots({ now: NOW });
    const today = slots.filter((s) => s.date === TODAY).map((s) => s.label);
    expect(today).toEqual(['Tue Mar 16, 5:30 PM']);
  });
});

describe('v2 combined-allocation route conflicts use the canonical occupiedRows sum', () => {
  test('a v2 allocation whose members SUM past their own window_end blocks a later slot a per-row check would miss', async () => {
    // Two combined-allocation members sharing one start (4:00pm) and each
    // with only a 10-minute own window_end (4:10pm) — a per-row parallel
    // start/end check (the P1 this replaced) would only ever block through
    // ~4:25pm (10min + 15min buffer) and let the 4:30 slot through. The
    // canonical occupiedRows sum occupies the SUM of both members (20min)
    // from the shared start -> real occupied span 4:00-4:20pm, and the 4:30
    // slot's buffer reaches back to 4:15pm, which still falls inside it.
    const mix = { version: 2, allocatedServiceIds: ['row-a', 'row-b'] };
    reset({
      scheduled_services: [
        {
          id: 'row-a', customer_id: 'cust-1', technician_id: 'tech-1', scheduled_date: TODAY,
          status: 'confirmed', window_start: '16:00:00', window_end: '16:10:00',
          estimated_duration_minutes: null, reservation_service_mix: mix,
        },
        {
          id: 'row-b', customer_id: 'cust-1', technician_id: 'tech-1', scheduled_date: TODAY,
          status: 'confirmed', window_start: '16:00:00', window_end: '16:10:00',
          estimated_duration_minutes: null, reservation_service_mix: mix,
        },
      ],
    });
    const slots = await listInterviewSlots({ now: NOW });
    const today = slots.filter((s) => s.date === TODAY).map((s) => s.label);
    expect(today).not.toContain('Tue Mar 16, 4:00 PM');
    expect(today).not.toContain('Tue Mar 16, 4:30 PM');
    expect(today).toEqual(['Tue Mar 16, 5:00 PM', 'Tue Mar 16, 5:30 PM']);
  });
});

describe('other-applicant conflict exclusion', () => {
  test('a 4:00-4:30 booking removes the 4:30 slot too (BUFFER_MINUTES either side, same as route stops)', async () => {
    // interview_at 20:00 UTC / interview_end_at 20:30 UTC = 4:00-4:30pm ET.
    // Buffered +/-15min either side -> 3:45pm-4:45pm occupied. The 4:00 slot
    // overlaps outright; the 4:30 slot (4:30-5:00) now also overlaps the
    // buffered interval (4:30 < 4:45) where an unbuffered check would have
    // let it through (Codex P2) — only 5:00/5:30 clear the buffer.
    reset({
      job_applications: [{
        id: 'other-app', status: 'interview',
        interview_at: '2027-03-16T20:00:00.000Z', interview_end_at: '2027-03-16T20:30:00.000Z',
      }],
    });
    const slots = await listInterviewSlots({ now: NOW });
    const today = slots.filter((s) => s.date === TODAY).map((s) => s.label);
    expect(today).not.toContain('Tue Mar 16, 4:00 PM');
    expect(today).not.toContain('Tue Mar 16, 4:30 PM');
    // The next offered slot on the 30-minute grid after the 4:45pm buffer
    // boundary is 5:00pm — it and 5:30pm are unaffected.
    expect(today).toEqual(['Tue Mar 16, 5:00 PM', 'Tue Mar 16, 5:30 PM']);
  });

  test('a rejected/withdrawn application interview_at does not block (not in interview/offer)', async () => {
    reset({
      job_applications: [{
        id: 'other-app', status: 'withdrawn',
        interview_at: '2027-03-16T20:00:00.000Z', interview_end_at: '2027-03-16T20:30:00.000Z',
      }],
    });
    const slots = await listInterviewSlots({ now: NOW });
    expect(slots.filter((s) => s.date === TODAY)).toHaveLength(4);
  });

  test('excludeApplicationId self-exclusion: the applicant re-picking a time does not block itself', async () => {
    reset({
      job_applications: [{
        id: 'self-app', status: 'interview',
        interview_at: '2027-03-16T20:00:00.000Z', interview_end_at: '2027-03-16T20:30:00.000Z',
      }],
    });
    const slots = await listInterviewSlots({ now: NOW, excludeApplicationId: 'self-app' });
    expect(slots.filter((s) => s.date === TODAY)).toHaveLength(4);
  });
});

describe('isOfferedSlot', () => {
  test('true for a currently offered start, false for a tampered one', async () => {
    const slots = await listInterviewSlots({ now: NOW });
    const real = slots[0].start;
    await expect(isOfferedSlot(real, { now: NOW })).resolves.toBe(true);
    const tampered = new Date(new Date(real).getTime() + 5 * 60000).toISOString(); // shift 5 min
    await expect(isOfferedSlot(tampered, { now: NOW })).resolves.toBe(false);
    await expect(isOfferedSlot('not-a-real-iso', { now: NOW })).resolves.toBe(false);
  });
});

describe('bookedInterviewWindowsForDate (reciprocal occupancy for customer scheduling)', () => {
  test('returns HH:MM ET windows with the 15-minute buffer either side, bounded to the day', async () => {
    const { bookedInterviewWindowsForDate } = require('../services/interview-slots');
    const rows = [
      { interview_at: '2027-03-16T20:00:00.000Z', interview_end_at: '2027-03-16T20:30:00.000Z' }, // 4:00–4:30 PM ET
      { interview_at: '2027-03-16T04:05:00.000Z', interview_end_at: null }, // 12:05 AM ET, no end -> 30 min
    ];
    const q = {};
    ['whereIn', 'whereNotNull', 'where'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.select = jest.fn(async () => rows);
    const conn = jest.fn(() => q);
    const windows = await bookedInterviewWindowsForDate('2027-03-16', { conn });
    expect(conn).toHaveBeenCalledWith('job_applications');
    expect(q.whereIn).toHaveBeenCalledWith('status', ['interview', 'offer']);
    expect(windows).toEqual([
      { start: '15:45', end: '16:45' },
      { start: '00:00', end: '00:50' },
    ]);
  });
});

describe('bookedInterviewWindowsForDate — ET day boundary (Codex r5 P2)', () => {
  test('a next-day early-morning interview never bleeds into the previous ET date', async () => {
    const { bookedInterviewWindowsForDate } = require('../services/interview-slots');
    const q = {};
    ['whereIn', 'whereNotNull'].forEach((m) => { q[m] = jest.fn(() => q); });
    const bounds = [];
    q.where = jest.fn((col, op, val) => { bounds.push([op, val instanceof Date ? val.toISOString() : val]); return q; });
    q.select = jest.fn(async () => []);
    const conn = jest.fn(() => q);
    await bookedInterviewWindowsForDate('2027-03-16', { conn });
    // 2027-03-16 (EDT) spans 04:00Z on the 16th to 04:00Z on the 17th — the
    // upper bound is the NEXT ET MIDNIGHT, never noon UTC of the next day.
    expect(bounds).toEqual([['>=', '2027-03-16T04:00:00.000Z'], ['<', '2027-03-17T04:00:00.000Z']]);
  });
});
