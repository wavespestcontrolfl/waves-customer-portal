// FLEX-TIER core rules (GATE_AUTO_DISPATCH_FLEX_TIER): the fixed ±5-day
// radius, the destination floor with the same-day-always-reachable carve-out,
// the series adjacent-occurrence guard (incl. date_exception_cadence_date
// ordering), and loadSeriesNeighbors' fail-closed evidence read.
const {
  FLEX_TIER_RADIUS_DAYS,
  FLEX_TIER_FREEZE_HOURS,
  seriesPosition,
  loadSeriesNeighbors,
  flexTierMoveWindow,
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
    const w = flexTierMoveWindow({ origDate: '2026-09-21', today, neighbors: {} });
    expect(w).toEqual({ dateFrom: '2026-09-16', dateTo: '2026-09-26' });
  });

  test('same-day re-time always stays reachable, even when the destination floor would otherwise exclude it', () => {
    // 4 days out: just past a 73h freeze in practice, but well inside the
    // 5-day destination floor (today+5). Without the same-day carve-out the
    // floor would push dateFrom PAST the visit's own current date.
    const w = flexTierMoveWindow({ origDate: '2026-09-05', today, neighbors: {} });
    expect(w.dateFrom).toBe('2026-09-05'); // clamped down to orig, not the floor (09-06)
    expect(w.dateTo).toBe('2026-09-10'); // orig+5, unaffected
  });

  test('destination floor still applies on the forward side when it does not conflict with orig', () => {
    // 6 days out: orig-5 = today+1, below the floor (today+MIN_DESTINATION_DAYS_OUT) — floored.
    const w = flexTierMoveWindow({ origDate: '2026-09-07', today, neighbors: {} });
    expect(w.dateFrom).toBe('2026-09-06'); // today + MIN_DESTINATION_DAYS_OUT (5)
    expect(w.dateTo).toBe('2026-09-12'); // orig+5, unaffected
  });

  test('guard: never reaches or crosses the NEXT occurrence', () => {
    // Next occurrence 3 days after orig — inside the ±5 radius, so it clamps
    // dateTo to next-1 instead of orig+5.
    const w = flexTierMoveWindow({ origDate: '2026-09-21', today, neighbors: { next: '2026-09-24' } });
    expect(w.dateTo).toBe('2026-09-23'); // next - 1, not orig+5 = 09-26
  });

  test('guard: never reaches or crosses the PREVIOUS occurrence', () => {
    const w = flexTierMoveWindow({ origDate: '2026-09-21', today, neighbors: { prev: '2026-09-18' } });
    expect(w.dateFrom).toBe('2026-09-19'); // prev + 1, not orig-5 = 09-16
  });

  test('both neighbors inside the radius clamp both sides at once', () => {
    const w = flexTierMoveWindow({
      origDate: '2026-09-21', today, neighbors: { prev: '2026-09-19', next: '2026-09-23' },
    });
    expect(w).toEqual({ dateFrom: '2026-09-20', dateTo: '2026-09-22' });
  });

  test('a neighbor exactly one day off degenerates the window to same-day-only, never empty', () => {
    const w = flexTierMoveWindow({
      origDate: '2026-09-21', today, neighbors: { prev: '2026-09-20', next: '2026-09-22' },
    });
    expect(w).toEqual({ dateFrom: '2026-09-21', dateTo: '2026-09-21' });
  });

  test('malformed data (prev floor past dateTo) empties the window — fails closed, not silently ignored', () => {
    // A "previous" occurrence recorded 6 days after orig (a data anomaly —
    // series positions should never invert) pushes the floor past orig+5.
    const w = flexTierMoveWindow({ origDate: '2026-09-21', today, neighbors: { prev: '2026-09-27' } });
    expect(w).toBeNull();
  });

  test('a malformed prev between orig and orig+radius still clamps dateFrom past orig (not silently corrected)', () => {
    // prev one day after orig is invalid data, but the pure clamp still runs:
    // dateFrom lands past orig, which the caller (index.js) never applies to
    // a real move because the visit's OWN date is now outside its window.
    const w = flexTierMoveWindow({ origDate: '2026-09-21', today, neighbors: { prev: '2026-09-22' } });
    expect(w).toEqual({ dateFrom: '2026-09-23', dateTo: '2026-09-26' });
  });

  test('missing inputs return null (fail closed)', () => {
    expect(flexTierMoveWindow({ origDate: null, today, neighbors: {} })).toBeNull();
    expect(flexTierMoveWindow({ origDate: '2026-09-21', today: null, neighbors: {} })).toBeNull();
  });
});

// ── Series-neighbor evidence (COALESCE(date_exception_cadence_date, scheduled_date)) ──
function seriesDbStub(rowsByParent) {
  return (table) => {
    expect(table).toBe('scheduled_services');
    const c = {};
    let parentId;
    c.where = (arg) => {
      if (typeof arg === 'function') {
        // Capture the parentId out of the `.where('id', parentId).orWhere(...)`
        // builder callback the module uses.
        const probe = {
          where: (col, val) => { if (col === 'id') parentId = val; return probe; },
          orWhere: () => probe,
        };
        arg.call(probe);
      }
      return c;
    };
    c.whereNotIn = () => c;
    c.select = async () => rowsByParent[parentId] || [];
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
  });

  test('query failure fails closed: returns null (guard-unknown for every visit)', async () => {
    const throwingChain = { whereNotIn: () => ({ select: async () => { throw new Error('db down'); } }) };
    const db = () => ({ where: () => throwingChain });
    const map = await loadSeriesNeighbors(db, [{ id: 's1', recurring_parent_id: 'p1' }]);
    expect(map).toBeNull();
  });
});
