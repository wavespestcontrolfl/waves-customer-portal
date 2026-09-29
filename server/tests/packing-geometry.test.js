/**
 * scheduling/packing-geometry.js — the shared anchor loader + packed-bounds
 * formula every customer-facing picker (find-time.js, availability.js's
 * legacy engine, routes/booking.js's fan-out) now calls instead of
 * reimplementing its own copy (Codex r5, three straight rounds of "one more
 * forgotten input").
 */
jest.mock('../services/scheduling/occupancy', () => ({
  listOccupiedWindows: jest.fn(),
}));

const { listOccupiedWindows } = require('../services/scheduling/occupancy');
const { loadPackingAnchors, packedBounds } = require('../services/scheduling/packing-geometry');

beforeEach(() => jest.clearAllMocks());

describe('loadPackingAnchors', () => {
  test('always reads WITH coords, regardless of any travel-gap gate (Codex r5 P1)', async () => {
    listOccupiedWindows.mockResolvedValue([]);
    await loadPackingAnchors({ dateFrom: '2099-01-01', dateTo: '2099-01-02' });
    expect(listOccupiedWindows).toHaveBeenCalledWith(expect.objectContaining({
      dateFrom: '2099-01-01', dateTo: '2099-01-02', withCoords: true,
    }));
  });

  test('passes db and excludeServiceIds through', async () => {
    const db = jest.fn();
    listOccupiedWindows.mockResolvedValue([]);
    await loadPackingAnchors({ db, dateFrom: '2099-01-01', dateTo: '2099-01-02', excludeServiceIds: ['svc-1'] });
    expect(listOccupiedWindows).toHaveBeenCalledWith(expect.objectContaining({
      db, excludeServiceIds: ['svc-1'],
    }));
  });

  test('reshapes a listOccupiedWindows row to raw/expected-end fields', async () => {
    listOccupiedWindows.mockResolvedValue([{
      id: 's1', technician_id: 't1', customer_id: 'c1', date: '2099-01-01',
      startMin: 540, endMin: 660, windowMinutes: 120, expectedMinutes: 30,
      lat: 27.4, lng: -82.4, hold: false,
    }]);
    const [anchor] = await loadPackingAnchors({ dateFrom: '2099-01-01', dateTo: '2099-01-01' });
    expect(anchor).toEqual({
      id: 's1', technician_id: 't1', customer_id: 'c1', date: '2099-01-01',
      rawStartMin: 540, rawEndMin: 660, expectedEndMin: 570, // 540 + 30
      lat: 27.4, lng: -82.4, hold: false,
    });
  });

  test('a version-2 combined allocation\'s expanded endMin (from listOccupiedWindows/occupiedRows) becomes rawEndMin (Codex r5 P1 #4)', async () => {
    // listOccupiedWindows already expands v2 allocations via occupiedRows
    // (visit-capacity.js) before this wrapper sees them — a member stamped
    // 09:00-10:00 whose allocation really runs through 11:00 arrives with
    // endMin already at the combined 660, not its own row's 600.
    listOccupiedWindows.mockResolvedValue([{
      id: 'member-1', technician_id: 't1', customer_id: 'c1', date: '2099-01-01',
      startMin: 540, endMin: 660, windowMinutes: 120, expectedMinutes: 120,
      lat: null, lng: null, hold: false,
    }]);
    const [anchor] = await loadPackingAnchors({ dateFrom: '2099-01-01', dateTo: '2099-01-01' });
    expect(anchor.rawEndMin).toBe(660);
  });

  test('no expectedMinutes/windowMinutes on the row (mirror unavailable) falls back to the raw window — zero padding', async () => {
    listOccupiedWindows.mockResolvedValue([{
      id: 's1', technician_id: 't1', customer_id: null, date: '2099-01-01',
      startMin: 540, endMin: 600, lat: null, lng: null,
    }]);
    const [anchor] = await loadPackingAnchors({ dateFrom: '2099-01-01', dateTo: '2099-01-01' });
    expect(anchor.expectedEndMin).toBe(600); // no credit -> raw end
  });

  test('an empty/invalid range still returns []', async () => {
    listOccupiedWindows.mockResolvedValue([]);
    expect(await loadPackingAnchors({ dateFrom: null, dateTo: null })).toEqual([]);
  });
});

describe('packedBounds', () => {
  const anchor = (rawStartMin, rawEndMin, expectedEndMin = rawEndMin) => ({ rawStartMin, rawEndMin, expectedEndMin });

  test('Codex r5 P1 #3 — earliest-after-prev floors at prev\'s RAW end, never before it, however much credit prev carries', () => {
    // Stop 09:00-11:00 (540-660), expected 30 -> expectedEndMin 570.
    const prev = anchor(540, 660, 570);
    const { earliestStart } = packedBounds({ prev, next: null, durationMinutes: 60, buffer: 15 });
    // Credit-only would give 570 (+0 drive +0 buffer, since prev padding 90
    // already swallows the 15-min buffer) — the bug this finding fixed. The
    // fix floors it at prev.rawEndMin (660 = 11:00).
    expect(earliestStart).toBe(660);
  });

  test('Codex r4 P1 — latest-before-next caps at next.rawStartMin - durationMinutes, never overlapping next\'s raw window', () => {
    // Next stop at noon (720), candidate duration 90, credited only 60
    // expected minutes, co-located (zero drive).
    const next = anchor(720, 780, 720);
    const { latestStart } = packedBounds({
      next, prev: null, durationMinutes: 90, expectedMinutes: 60, buffer: 15,
    });
    // Credit-only bound: 720 - 60 = 660 (11:00) -> real end 750, overlapping
    // next's raw start (720). Capped instead at 720 - 90 = 630 (10:30).
    expect(latestStart).toBe(630);
  });

  test('Codex r5 P2 #2 — a co-located noon stop with real padding correctly offers 11:00, not 10:00', () => {
    // 60-minute candidate, 45 expected, 15 buffer, co-located (zero drive)
    // next stop at noon (720).
    const next = anchor(720, 780, 720);
    const { latestStart } = packedBounds({
      next, prev: null, durationMinutes: 60, expectedMinutes: 45, buffer: 15,
    });
    // candidatePadding = 60-45=15; nextBuffer = max(0,15-15)=0.
    // latestEnd = 720-0-0=720; latestStart = min(720-45, 720-60) = min(675,660) = 660 (11:00).
    expect(latestStart).toBe(660);
  });

  test('no credit (expectedMinutes omitted) degrades to the legacy drive+buffer bound on both sides', () => {
    const prev = anchor(540, 600); // 09:00-10:00, no credit (expectedEndMin = rawEndMin)
    const next = anchor(780, 840); // 13:00-14:00, no credit
    const { earliestStart, latestStart } = packedBounds({
      prev, next, durationMinutes: 60, driveIn: 5, driveOut: 5, buffer: 15,
    });
    expect(earliestStart).toBe(600 + 5 + 15); // prev raw end + drive + full buffer
    expect(latestStart).toBe(780 - 5 - 15 - 60); // next raw start - drive - full buffer - duration
  });

  test('buffer 0 (gate off / staff caller) never reduces below the plain drive-only shape, and the overlap clamp still holds', () => {
    const next = anchor(720, 780, 690); // credited, but buffer is 0
    const { latestStart } = packedBounds({ next, prev: null, durationMinutes: 60, expectedMinutes: 30, buffer: 0, driveOut: 0 });
    // nextBuffer = max(0, 0 - padding) = 0 regardless of credit; latestEnd = 720.
    // latestStart = min(720-30, 720-60) = min(690,660) = 660.
    expect(latestStart).toBe(660);
  });

  test('prev/next null (HQ leg, day edge) returns null for that side only', () => {
    const next = anchor(720, 780, 720);
    const boundsNoNeighbours = packedBounds({ prev: null, next: null, durationMinutes: 60 });
    expect(boundsNoNeighbours).toEqual({ earliestStart: null, latestStart: null, arrivalFloor: null });
    const boundsNextOnly = packedBounds({ prev: null, next, durationMinutes: 60 });
    expect(boundsNextOnly.earliestStart).toBeNull();
    expect(boundsNextOnly.latestStart).not.toBeNull();
    expect(boundsNextOnly.arrivalFloor).toBeNull();
  });

  test('expectedMinutes greater than durationMinutes is clamped, never manufacturing negative padding', () => {
    const next = anchor(720, 780, 720);
    const { latestStart } = packedBounds({ next, prev: null, durationMinutes: 60, expectedMinutes: 999, buffer: 15 });
    // ownExpected clamped to 60 -> padding 0 -> nextBuffer 15.
    expect(latestStart).toBe(Math.min(720 - 15 - 60, 720 - 60));
  });

  describe('arrival grace (A5, owner ruling 2026-09-28)', () => {
    // The plan's own G1 shape: prev = lawn (600-660, expected 50 -> 10 min
    // padding), driveIn 11, buffer 15 -> prevBuffer 5 -> arrivalFloor 666.
    const lawnPrev = anchor(600, 660, 650);

    test('grace shifts earliestStart below arrivalFloor (666 -> 660), never past prev.rawEndMin', () => {
      const { earliestStart, arrivalFloor } = packedBounds({
        prev: lawnPrev, next: null, durationMinutes: 30, expectedMinutes: 30, driveIn: 11, buffer: 15, grace: 90,
      });
      expect(arrivalFloor).toBe(666);
      expect(earliestStart).toBe(660); // max(666-90, 660) = max(576,660)=660
    });

    test('grace 0 reproduces arrivalFloor exactly — no behavior change', () => {
      const bounds0 = packedBounds({ prev: lawnPrev, next: null, durationMinutes: 30, expectedMinutes: 30, driveIn: 11, buffer: 15 });
      const boundsGraceZero = packedBounds({
        prev: lawnPrev, next: null, durationMinutes: 30, expectedMinutes: 30, driveIn: 11, buffer: 15, grace: 0,
      });
      expect(bounds0).toEqual({ earliestStart: 666, latestStart: null, arrivalFloor: 666 });
      expect(boundsGraceZero).toEqual(bounds0);
    });

    test('earliestStart never drops below prev.rawEndMin, however large grace is', () => {
      const { earliestStart } = packedBounds({
        prev: lawnPrev, next: null, durationMinutes: 30, expectedMinutes: 30, driveIn: 11, buffer: 15, grace: 999,
      });
      expect(earliestStart).toBe(660); // prev.rawEndMin
    });

    test('A6 — a live hold on prev gets NO grace at all', () => {
      const heldPrev = { ...lawnPrev, hold: true };
      const { earliestStart, arrivalFloor } = packedBounds({
        prev: heldPrev, next: null, durationMinutes: 30, expectedMinutes: 30, driveIn: 11, buffer: 15, grace: 90,
      });
      expect(earliestStart).toBe(arrivalFloor); // no reduction — same as grace 0
    });

    test('an arrivalMin already on prev (chained projection) shifts arrivalFloor forward', () => {
      // prev's OWN arrival was projected 20 minutes late (e.g. by
      // annotateProjectedArrivals upstream) — its effective end and this
      // gap's arrivalFloor both move with it.
      const lateArrivalPrev = { ...lawnPrev, arrivalMin: lawnPrev.rawStartMin + 20 };
      const { arrivalFloor } = packedBounds({
        prev: lateArrivalPrev, next: null, durationMinutes: 30, expectedMinutes: 30, driveIn: 11, buffer: 15, grace: 90,
      });
      // effectiveEnd now 620+50=... base=arrivalMin(620)+expected(50)=670 (vs 650 unshifted) -> arrivalFloor = max(670+11+prevBuffer,660).
      expect(arrivalFloor).toBeGreaterThan(666);
    });

    test('sentinel: latestStart goes to -Infinity ONLY when grace > 0 and the real (un-graced) timeline cannot clear next', () => {
      // Candidate's real work (arrivalFloor + ownExpected + driveOut + nextBuffer)
      // would land past next's raw start — genuinely no room in this gap.
      const next = anchor(700, 760, 700); // next starts at 700 (11:40)
      const tightArgs = {
        prev: lawnPrev, next, durationMinutes: 30, expectedMinutes: 30, driveIn: 11, driveOut: 5, buffer: 15,
      };
      // arrivalFloor 666 + ownExpected 30 + driveOut 5 + nextBuffer(15) = 716 > 700 -> infeasible gap.
      expect(packedBounds({ ...tightArgs, grace: 0 }).latestStart).not.toBe(-Infinity);
      expect(packedBounds({ ...tightArgs, grace: 90 }).latestStart).toBe(-Infinity);
    });
  });
});
