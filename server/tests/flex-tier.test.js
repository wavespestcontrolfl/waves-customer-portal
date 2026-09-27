// FLEX-TIER core rules (GATE_AUTO_DISPATCH_FLEX_TIER): the fixed ±5-day
// radius, the destination floor with the same-day-always-reachable carve-out,
// the series adjacent-occurrence guard (incl. date_exception_cadence_date
// ordering), loadSeriesNeighbors' bulk fail-closed evidence read, the
// durable-anchor bound on cumulative drift, and ownScheduleFrozen's
// canonical (grouped) arrival.
jest.mock('../services/appointment-reminders', () => ({
  // A realistic composer (mirrors the real module's own logic), without
  // pulling in the full appointment-reminders module and its dependencies.
  composeScheduledApptTime: jest.fn((svc) => {
    if (!svc) return null;
    const datePart = String(svc.scheduled_date || '').slice(0, 10);
    const timePart = svc.window_start ? String(svc.window_start).slice(0, 8) : null;
    if (!datePart || !timePart) return null;
    return require('../utils/datetime-et').parseETDateTime(`${datePart}T${timePart}`);
  }),
}));

const {
  FLEX_TIER_RADIUS_DAYS,
  FLEX_TIER_FREEZE_HOURS,
  seriesPosition,
  loadSeriesNeighbors,
  flexTierMoveWindow,
  flexWindowAdmits,
  ownScheduleFrozen,
  destinationFrozen,
} = require('../services/auto-dispatch/flex-tier');
const { MIN_DESTINATION_DAYS_OUT } = require('../services/auto-dispatch/route-tiers');

describe('constants match the approved policy', () => {
  test('±5 days, 73h freeze, shared destination floor', () => {
    expect(FLEX_TIER_RADIUS_DAYS).toBe(5);
    expect(FLEX_TIER_FREEZE_HOURS).toBe(73);
    expect(MIN_DESTINATION_DAYS_OUT).toBe(5); // reused from route-tiers, not re-derived
  });
});

describe('seriesPosition', () => {
  test('a plain row positions on its own scheduled_date', () => {
    expect(seriesPosition({ scheduled_date: '2026-09-10' })).toBe('2026-09-10');
  });
  test('a date_exception row positions on its cadence date, not the deviated date', () => {
    expect(seriesPosition({
      scheduled_date: '2026-09-17', date_exception: true, date_exception_cadence_date: '2026-09-10',
    })).toBe('2026-09-10');
  });
  test('date_exception=true with no cadence date recorded falls back to scheduled_date', () => {
    expect(seriesPosition({ scheduled_date: '2026-09-10', date_exception: true, date_exception_cadence_date: null }))
      .toBe('2026-09-10');
  });
});

describe('flexTierMoveWindow — ±5 days ∩ destination floor ∩ occurrence guard', () => {
  const today = '2026-09-01';

  test('unconstrained visit: full ±5 window around its date', () => {
    // 20 days out — well past the floor, no neighbors.
    const w = flexTierMoveWindow({ origDate: '2026-09-21', anchorDate: '2026-09-21', today, neighbors: {} });
    expect(w).toEqual({ dateFrom: '2026-09-16', dateTo: '2026-09-26' });
  });

  test('same-day re-time always stays reachable, even when the destination floor would otherwise exclude it', () => {
    // 4 days out: just past a 73h freeze in practice, but well inside the
    // 5-day destination floor (today+5). Without the same-day carve-out the
    // floor would push dateFrom PAST the visit's own current date.
    const w = flexTierMoveWindow({ origDate: '2026-09-05', anchorDate: '2026-09-05', today, neighbors: {} });
    expect(w.dateFrom).toBe('2026-09-05'); // clamped down to orig, not the floor (09-06)
    expect(w.dateTo).toBe('2026-09-10'); // orig+5, unaffected
  });

  test('below the floor, ONLY the current date is exempt — never the dates between it and the floor (Codex #4995 r3 P1)', () => {
    // 3 days out (a late appointment just past the 73h freeze): the floor is
    // 09-06, so 09-05 must not be a legal day move.
    const w = flexTierMoveWindow({ origDate: '2026-09-04', anchorDate: '2026-09-04', today, neighbors: {} });
    expect(w).toEqual({ dateFrom: '2026-09-04', dateTo: '2026-09-09', dayMoveFrom: '2026-09-06' });
    expect(flexWindowAdmits(w, '2026-09-04', '2026-09-04')).toBe(true); // same-day re-time
    expect(flexWindowAdmits(w, '2026-09-04', '2026-09-05')).toBe(false); // below the floor
    expect(flexWindowAdmits(w, '2026-09-04', '2026-09-06')).toBe(true);
    expect(flexWindowAdmits(w, '2026-09-04', '2026-09-09')).toBe(true);
    expect(flexWindowAdmits(w, '2026-09-04', '2026-09-10')).toBe(false);
    expect(flexWindowAdmits(null, '2026-09-04', '2026-09-04')).toBe(false);
  });

  test('when the next occurrence sits before the floor, the window is same-day only', () => {
    const w = flexTierMoveWindow({ origDate: '2026-09-04', anchorDate: '2026-09-04', today, neighbors: { next: '2026-09-06' } });
    expect(w).toEqual({ dateFrom: '2026-09-04', dateTo: '2026-09-04' });
  });

  test('destination floor still applies on the forward side when it does not conflict with orig', () => {
    // 6 days out: orig-5 = today+1, below the floor (today+MIN_DESTINATION_DAYS_OUT) — floored.
    const w = flexTierMoveWindow({ origDate: '2026-09-07', anchorDate: '2026-09-07', today, neighbors: {} });
    expect(w.dateFrom).toBe('2026-09-06'); // today + MIN_DESTINATION_DAYS_OUT (5)
    expect(w.dateTo).toBe('2026-09-12'); // orig+5, unaffected
  });

  test('guard: never reaches or crosses the NEXT occurrence', () => {
    // Next occurrence 3 days after orig — inside the ±5 radius, so it clamps
    // dateTo to next-1 instead of orig+5.
    const w = flexTierMoveWindow({ origDate: '2026-09-21', anchorDate: '2026-09-21', today, neighbors: { next: '2026-09-24' } });
    expect(w.dateTo).toBe('2026-09-23'); // next - 1, not orig+5 = 09-26
  });

  test('guard: never reaches or crosses the PREVIOUS occurrence', () => {
    const w = flexTierMoveWindow({ origDate: '2026-09-21', anchorDate: '2026-09-21', today, neighbors: { prev: '2026-09-18' } });
    expect(w.dateFrom).toBe('2026-09-19'); // prev + 1, not orig-5 = 09-16
  });

  test('both neighbors inside the radius clamp both sides at once', () => {
    const w = flexTierMoveWindow({
      origDate: '2026-09-21', anchorDate: '2026-09-21', today, neighbors: { prev: '2026-09-19', next: '2026-09-23' },
    });
    expect(w).toEqual({ dateFrom: '2026-09-20', dateTo: '2026-09-22' });
  });

  test('a neighbor exactly one day off degenerates the window to same-day-only, never empty', () => {
    const w = flexTierMoveWindow({
      origDate: '2026-09-21', anchorDate: '2026-09-21', today, neighbors: { prev: '2026-09-20', next: '2026-09-22' },
    });
    expect(w).toEqual({ dateFrom: '2026-09-21', dateTo: '2026-09-21' });
  });

  test('malformed data (prev floor past dateTo) empties the window — fails closed, not silently ignored', () => {
    // A "previous" occurrence recorded 6 days after orig (a data anomaly —
    // series positions should never invert) pushes the floor past orig+5.
    const w = flexTierMoveWindow({ origDate: '2026-09-21', anchorDate: '2026-09-21', today, neighbors: { prev: '2026-09-27' } });
    expect(w).toBeNull();
  });

  test('a neighbor on the wrong side of the current date leaves no legal move — never the band past it (Codex #4995 r7 P1)', () => {
    // prev one day AFTER orig: any day move from 09-21 would cross it.
    expect(flexTierMoveWindow({ origDate: '2026-09-21', anchorDate: '2026-09-21', today, neighbors: { prev: '2026-09-22' } })).toBeNull();
    // next one day BEFORE orig: the same, mirrored.
    expect(flexTierMoveWindow({ origDate: '2026-09-21', anchorDate: '2026-09-21', today, neighbors: { next: '2026-09-20' } })).toBeNull();
    // A neighbor ON the current date is not inverted: the visit keeps its
    // date, and moving away from that neighbor stays legal.
    expect(flexTierMoveWindow({ origDate: '2026-09-21', anchorDate: '2026-09-21', today, neighbors: { prev: '2026-09-21' } }))
      .toEqual({ dateFrom: '2026-09-21', dateTo: '2026-09-26' });
  });

  test('missing inputs return null (fail closed)', () => {
    expect(flexTierMoveWindow({ origDate: null, anchorDate: null, today, neighbors: {} })).toBeNull();
    expect(flexTierMoveWindow({ origDate: '2026-09-21', anchorDate: '2026-09-21', today: null, neighbors: {} })).toBeNull();
    // An unknown anchor (resolveAnchor → null) never guesses a budget.
    expect(flexTierMoveWindow({ origDate: '2026-09-21', anchorDate: null, today, neighbors: {} })).toBeNull();
  });
});

describe('flexTierMoveWindow — the ±5 days are measured from the durable original date too (Codex #4995 r1 P1)', () => {
  const today = '2026-09-01';

  test('a visit already moved +5 from its original date can never be pushed further out on a later night', () => {
    // Originally 09-16; last night's move put it on 09-21. Without the
    // anchor the window would reset to 09-16..09-26 and allow another +5.
    const w = flexTierMoveWindow({ origDate: '2026-09-21', anchorDate: '2026-09-16', today, neighbors: {} });
    expect(w).toEqual({ dateFrom: '2026-09-16', dateTo: '2026-09-21' });
  });

  test('a partly-spent allowance leaves only what is left on each side of the original date', () => {
    const w = flexTierMoveWindow({ origDate: '2026-09-18', anchorDate: '2026-09-16', today, neighbors: {} });
    expect(w).toEqual({ dateFrom: '2026-09-13', dateTo: '2026-09-21' });
  });

  test('a visit already outside its original band keeps its own date as a lone exception — never the dates between (Codex #4995 r5 P2)', () => {
    // 7 days past its original date (a staff move, say): its own date stays
    // legal for a same-day re-time, and day moves stay inside anchor ± 5 —
    // 09-22 is still six days past the anchor.
    const w = flexTierMoveWindow({ origDate: '2026-09-23', anchorDate: '2026-09-16', today, neighbors: {} });
    expect(w).toEqual({ dateFrom: '2026-09-18', dateTo: '2026-09-23', dayMoveTo: '2026-09-21' });
    expect(flexWindowAdmits(w, '2026-09-23', '2026-09-23')).toBe(true);
    expect(flexWindowAdmits(w, '2026-09-23', '2026-09-22')).toBe(false);
    expect(flexWindowAdmits(w, '2026-09-23', '2026-09-21')).toBe(true);
    expect(flexWindowAdmits(w, '2026-09-23', '2026-09-18')).toBe(true);
  });

  test('the series guard still clamps inside the anchored window', () => {
    const w = flexTierMoveWindow({
      origDate: '2026-09-18', anchorDate: '2026-09-16', today, neighbors: { prev: '2026-09-15' },
    });
    expect(w).toEqual({ dateFrom: '2026-09-16', dateTo: '2026-09-21' });
  });
});

// ── Series-neighbor evidence (COALESCE(date_exception_cadence_date, scheduled_date)) ──
// Models the bulk read: `.where(fn)` whose builder callback runs
// `.whereIn('id', parentIds).orWhereIn('recurring_parent_id', parentIds)`;
// returns every requested series' rows, children tagged with their parent.
// `locks` records any row-lock clauses (forShare / noWait) the read adds.
function seriesDbStub(rowsByParent, calls = [], locks = []) {
  return (table) => {
    expect(table).toBe('scheduled_services');
    const c = {};
    c.forShare = () => { locks.push('forShare'); return c; };
    c.noWait = () => { locks.push('noWait'); return c; };
    let parentIds = [];
    c.where = (arg) => {
      if (typeof arg === 'function') {
        const probe = {
          whereIn: (col, vals) => { if (col === 'id') parentIds = vals; return probe; },
          orWhereIn: () => probe,
        };
        arg.call(probe);
      }
      return c;
    };
    c.whereNotIn = () => c;
    c.select = async () => {
      calls.push(parentIds);
      return parentIds.flatMap((pid) => (rowsByParent[pid] || [])
        .map((r) => ({ recurring_parent_id: r.id === pid ? null : pid, ...r })));
    };
    return c;
  };
}

describe('loadSeriesNeighbors', () => {
  test('no eligible services (no recurring_parent_id) is a clean no-op, no query', async () => {
    const db = jest.fn();
    const map = await loadSeriesNeighbors(db, [{ id: 's1', recurring_parent_id: null }]);
    expect(map.size).toBe(0);
    expect(db).not.toHaveBeenCalled();
  });

  test('middle occurrence gets both neighbors; first/last get one side null', async () => {
    const db = seriesDbStub({
      p1: [
        { id: 'p1', scheduled_date: '2026-09-01' }, // the series' first visit (parent row)
        { id: 's1', scheduled_date: '2026-09-08' },
        { id: 's2', scheduled_date: '2026-09-15' },
        { id: 's3', scheduled_date: '2026-09-22' },
      ],
    });
    const services = [
      { id: 's1', recurring_parent_id: 'p1' },
      { id: 's2', recurring_parent_id: 'p1' },
      { id: 's3', recurring_parent_id: 'p1' },
    ];
    const map = await loadSeriesNeighbors(db, services);
    expect(map.get('s1')).toEqual({ prev: '2026-09-01', next: '2026-09-15' }); // parent counts as the first occurrence
    expect(map.get('s2')).toEqual({ prev: '2026-09-08', next: '2026-09-22' });
    expect(map.get('s3')).toEqual({ prev: '2026-09-15', next: null });
  });

  test('a cancelled sibling never anchors the guard', async () => {
    // The production query's whereNotIn(TERMINAL_STATUSES) excludes a
    // cancelled row before it ever reaches this module — modeled here by a
    // stub that (like the real query) omits it, so s2's previous occurrence
    // is the parent row, not the cancelled visit in between.
    const db = seriesDbStub({
      p1: [
        { id: 'p1', scheduled_date: '2026-09-01' },
        { id: 's2', scheduled_date: '2026-09-15' },
      ],
    });
    const map = await loadSeriesNeighbors(db, [{ id: 's2', recurring_parent_id: 'p1' }]);
    expect(map.get('s2')).toEqual({ prev: '2026-09-01', next: null });
  });

  test('date_exception_cadence_date orders a moved occurrence by its ORIGINAL series slot', async () => {
    // s2 physically sits on 09-30 (moved out for a customer trip) but its
    // cadence position is 09-15 — it must still sort BETWEEN s1 and s3.
    const db = seriesDbStub({
      p1: [
        { id: 'p1', scheduled_date: '2026-09-01' },
        { id: 's1', scheduled_date: '2026-09-08' },
        {
          id: 's2', scheduled_date: '2026-09-30', date_exception: true, date_exception_cadence_date: '2026-09-15',
        },
        { id: 's3', scheduled_date: '2026-09-22' },
      ],
    });
    const map = await loadSeriesNeighbors(db, [{ id: 's3', recurring_parent_id: 'p1' }]);
    // s3's previous occurrence is s2's CADENCE position (09-15), not its
    // actual (later) physical date (09-30).
    expect(map.get('s3').prev).toBe('2026-09-15');
    // ...and s2 physically sits AFTER s3 now, so its actual date bounds s3
    // from above as well (Codex #4995 P1).
    expect(map.get('s3').next).toBe('2026-09-30');
  });

  test('a neighbor rescheduled INSIDE its cadence slot bounds the move by its actual date (Codex #4995 P1)', async () => {
    // A is 11-10; its next occurrence B has cadence 11-17 but was moved to
    // 11-13. A -> 11-14 would cross B, so the bound is B's actual 11-13.
    const db = seriesDbStub({
      p1: [
        { id: 'p1', scheduled_date: '2026-11-03' },
        { id: 'a', scheduled_date: '2026-11-10' },
        {
          id: 'b', scheduled_date: '2026-11-13', date_exception: true, date_exception_cadence_date: '2026-11-17',
        },
      ],
    });
    const map = await loadSeriesNeighbors(db, [{ id: 'a', recurring_parent_id: 'p1' }]);
    expect(map.get('a')).toEqual({ prev: '2026-11-03', next: '2026-11-13' });
    const w = flexTierMoveWindow({ origDate: '2026-11-10', anchorDate: '2026-11-10', today: '2026-10-01', neighbors: map.get('a') });
    expect(w).toEqual({ dateFrom: '2026-11-05', dateTo: '2026-11-12' });
  });

  test('a date-exception visit sitting ahead of its previous occurrence\'s slot gets no window at all (Codex #4995 r7 P1)', async () => {
    // A is on 09-14 by exception (cadence 09-22); its previous occurrence P
    // holds cadence 09-15 but was moved to 09-20. Bounds: prev 09-15 (the
    // cadence slot A already sits ahead of), next 09-20 (P's actual date).
    const db = seriesDbStub({
      p1: [
        { id: 'p1', scheduled_date: '2026-09-01' },
        {
          id: 'P', scheduled_date: '2026-09-20', date_exception: true, date_exception_cadence_date: '2026-09-15',
        },
        {
          id: 'A', scheduled_date: '2026-09-14', date_exception: true, date_exception_cadence_date: '2026-09-22',
        },
      ],
    });
    const map = await loadSeriesNeighbors(db, [{ id: 'A', recurring_parent_id: 'p1' }]);
    expect(map.get('A')).toEqual({ prev: '2026-09-15', next: '2026-09-20' });
    // Moving A to 09-16..09-19 would cross P's 09-15 slot: nothing is legal.
    expect(flexTierMoveWindow({ origDate: '2026-09-14', anchorDate: '2026-09-14', today: '2026-09-01', neighbors: map.get('A') })).toBeNull();
  });

  test('a NON-adjacent occurrence rescheduled closer than the cadence neighbor bounds it too', async () => {
    // C's cadence slot (11-24) is two occurrences away, but it was moved to
    // 11-12 — nearer to A than A's cadence neighbor B (11-17).
    const db = seriesDbStub({
      p1: [
        { id: 'p1', scheduled_date: '2026-11-03' },
        { id: 'a', scheduled_date: '2026-11-10' },
        { id: 'b', scheduled_date: '2026-11-17' },
        {
          id: 'c', scheduled_date: '2026-11-12', date_exception: true, date_exception_cadence_date: '2026-11-24',
        },
      ],
    });
    const map = await loadSeriesNeighbors(db, [{ id: 'a', recurring_parent_id: 'p1' }]);
    expect(map.get('a')).toEqual({ prev: '2026-11-03', next: '2026-11-12' });
  });

  test('a service missing from its own series read gets no entry (callers fail closed)', async () => {
    const db = seriesDbStub({ p1: [{ id: 'p1', scheduled_date: '2026-09-01' }] });
    const map = await loadSeriesNeighbors(db, [{ id: 's9', recurring_parent_id: 'p1' }]);
    expect(map.has('s9')).toBe(false);
  });

  test('only the authoritative (lock) read row-locks — FOR SHARE NOWAIT; the planning read never locks', async () => {
    const rows = { p1: [{ id: 'p1', scheduled_date: '2026-09-01' }, { id: 's1', scheduled_date: '2026-09-08' }] };
    const planningLocks = [];
    await loadSeriesNeighbors(seriesDbStub(rows, [], planningLocks), [{ id: 's1', recurring_parent_id: 'p1' }]);
    expect(planningLocks).toEqual([]);
    const applyLocks = [];
    const map = await loadSeriesNeighbors(seriesDbStub(rows, [], applyLocks), [{ id: 's1', recurring_parent_id: 'p1' }], { lock: true });
    expect(applyLocks).toEqual(['forShare', 'noWait']);
    expect(map.get('s1')).toEqual({ prev: '2026-09-01', next: null });
  });

  test('many series load in ONE query (never one round trip per series), partitioned correctly', async () => {
    const calls = [];
    const rowsByParent = {};
    const services = [];
    for (let i = 0; i < 300; i++) {
      const pid = `p${i}`;
      rowsByParent[pid] = [
        { id: pid, scheduled_date: '2026-09-01' },
        { id: `s${i}`, scheduled_date: '2026-09-08' },
        { id: `n${i}`, scheduled_date: '2026-09-15' },
      ];
      services.push({ id: `s${i}`, recurring_parent_id: pid });
    }
    const map = await loadSeriesNeighbors(seriesDbStub(rowsByParent, calls), services);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(300);
    expect(map.get('s0')).toEqual({ prev: '2026-09-01', next: '2026-09-15' });
    expect(map.get('s299')).toEqual({ prev: '2026-09-01', next: '2026-09-15' });
  });

  test('query failure fails closed: returns null (guard-unknown for every visit)', async () => {
    const throwingChain = { whereNotIn: () => ({ select: async () => { throw new Error('db down'); } }) };
    const db = () => ({ where: () => throwingChain });
    const map = await loadSeriesNeighbors(db, [{ id: 's1', recurring_parent_id: 'p1' }]);
    expect(map).toBeNull();
  });
});

describe('ownScheduleFrozen — 73h from the canonical arrival (Codex #4995 r1 P1)', () => {
  // 2026-09-10 08:00 ET = 12:00Z; 15:00 ET = 19:00Z. At 2026-09-07 12:00Z the
  // 08:00 arrival is 72h away (frozen) while the 15:00 work slot is 79h away.
  const NOW = new Date('2026-09-07T12:00:00Z');

  test('a member of a combined allocation freezes on the group\'s earlier shared arrival, not its later work slot', async () => {
    const conn = { raw: jest.fn(async () => ({ rows: [{ window_start: '08:00:00' }] })) };
    const service = {
      id: 's1', scheduled_date: '2026-09-10', window_start: '15:00', reservation_service_mix: { allocatedServiceIds: ['s0', 's1'] },
    };
    await expect(ownScheduleFrozen(conn, service, NOW)).resolves.toBe(true);
    expect(conn.raw).toHaveBeenCalledWith('SELECT reservation_arrival_start(?) AS window_start', ['s1']);
  });

  test('a plain visit uses its own window_start with no query', async () => {
    const conn = { raw: jest.fn() };
    await expect(ownScheduleFrozen(conn, { id: 's1', scheduled_date: '2026-09-10', window_start: '15:00' }, NOW)).resolves.toBe(false);
    await expect(ownScheduleFrozen(conn, { id: 's1', scheduled_date: '2026-09-10', window_start: '08:00' }, NOW)).resolves.toBe(true);
    expect(conn.raw).not.toHaveBeenCalled();
  });

  test('an uncomposable time fails closed (frozen); an unreadable arrival throws, never a silent freeze (Codex #4995 r5 P2)', async () => {
    await expect(ownScheduleFrozen({ raw: jest.fn() }, { id: 's1', scheduled_date: '2026-09-20', window_start: null }, NOW)).resolves.toBe(true);
    const conn = { raw: jest.fn(async () => { throw new Error('db down'); }) };
    const grouped = {
      id: 's1', scheduled_date: '2026-09-20', window_start: '15:00', reservation_service_mix: { allocatedServiceIds: ['s0', 's1'] },
    };
    await expect(ownScheduleFrozen(conn, grouped, NOW)).rejects.toThrow('db down');
  });
});

describe('destinationFrozen — the DESTINATION instant must clear 73h too (Codex #4995 P1)', () => {
  // Mon 2026-10-05 15:00 ET (EDT) = 19:00Z. Thu 10-08 17:00 ET is 74h away;
  // Thu 10-08 09:00 ET is 66h away.
  const NOW = new Date('2026-10-05T19:00:00Z');

  test('Thu 17:00 -> Thu 09:00 same-day re-time is frozen; keeping 17:00 or a later day is not', () => {
    const svc = { id: 's1', scheduled_date: '2026-10-08', window_start: '17:00' };
    expect(destinationFrozen(svc, '2026-10-08', '09:00', NOW)).toBe(true);
    expect(destinationFrozen(svc, '2026-10-08', '17:00', NOW)).toBe(false);
    expect(destinationFrozen(svc, '2026-10-12', '08:00', NOW)).toBe(false);
  });

  test('no destination start fails closed', () => {
    expect(destinationFrozen({ id: 's1' }, '2026-10-20', null, NOW)).toBe(true);
  });

  test('a combined-allocation member landing back in its booked slot freezes on the shared arrival; a stale stamp does not (Codex #4995 r4 P2)', () => {
    // s1 is allocation index 2 under a 15:00 arrival: its booked slot is
    // 17:00 (74h out), but the customer was promised 15:00 (72h out).
    const stamped = {
      id: 's1',
      reservation_service_mix: { allocatedServiceIds: ['s0', 'sx', 's1'], scheduledDate: '2026-10-08', arrivalWindowStart: '15:00' },
    };
    expect(destinationFrozen(stamped, '2026-10-08', '17:00', NOW)).toBe(true);
    // Any other start on that date is outside the booked slot, so
    // reservation_arrival_start ignores the stamp — 18:00 (75h) is legal.
    expect(destinationFrozen(stamped, '2026-10-08', '18:00', NOW)).toBe(false);
    // Another date: the stamp does not apply.
    expect(destinationFrozen(stamped, '2026-10-12', '08:00', NOW)).toBe(false);
    // A row the stamp does not allocate, or a malformed arrival, is ignored too.
    expect(destinationFrozen({ ...stamped, id: 's9' }, '2026-10-08', '17:00', NOW)).toBe(false);
    const malformed = { ...stamped, reservation_service_mix: { ...stamped.reservation_service_mix, arrivalWindowStart: '3pm' } };
    expect(destinationFrozen(malformed, '2026-10-08', '17:00', NOW)).toBe(false);
  });
});
