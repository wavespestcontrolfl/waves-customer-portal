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
  FLEX_TIER_WIDE_RADIUS_DAYS,
  FLEX_TIER_BIMONTHLY_RADIUS_DAYS,
  FLEX_TIER_WIDEST_MIN_INTERVAL_DAYS,
  FLEX_TIER_WIDE_MIN_INTERVAL_DAYS,
  flexRadiusDaysFor,
  FLEX_TIER_FREEZE_HOURS,
  seriesPosition,
  loadSeriesNeighbors,
  flexTierMoveWindow,
  flexBandRadius,
  flexWindowAdmits,
  ownScheduleFrozen,
  destinationFrozen,
} = require('../services/auto-dispatch/flex-tier');
const { MIN_DESTINATION_DAYS_OUT } = require('../services/auto-dispatch/route-tiers');

describe('constants match the approved policy', () => {
  test('±5 days, 73h freeze, shared destination floor', () => {
    expect(FLEX_TIER_RADIUS_DAYS).toBe(5);
    expect(FLEX_TIER_WIDE_RADIUS_DAYS).toBe(7); // owner 2026-11-22: 7-day range; 3 months or longer since 11-24
    expect(FLEX_TIER_BIMONTHLY_RADIUS_DAYS).toBe(6); // owner 2026-11-24: "make it 6 for bi monthly"
    expect(FLEX_TIER_WIDE_MIN_INTERVAL_DAYS).toBe(56);
    expect(FLEX_TIER_WIDEST_MIN_INTERVAL_DAYS).toBe(84);
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

describe('flexRadiusDaysFor — ±7 for a plan of 3 months or longer, ±6 for 2 months, ±5 for everything else', () => {
  const { MONTH_RECURRENCE_INTERVALS } = require('../services/rebooker');

  test.each(Object.entries(MONTH_RECURRENCE_INTERVALS))('month pattern %s (every %i month(s))', (pattern, months) => {
    expect(flexRadiusDaysFor({ recurring_pattern: pattern })).toBe(months >= 3 ? 7 : (months === 2 ? 6 : 5));
  });

  test('the month table reads: monthly is the only narrow one', () => {
    expect(Object.keys(MONTH_RECURRENCE_INTERVALS).filter((k) => flexRadiusDaysFor({ recurring_pattern: k }) === 5)).toEqual(['monthly']);
  });

  test('custom: 55 days is 5, 56 to 83 days is 6, 84 days is 7; a missing, zero or non-numeric interval is 5', () => {
    expect(flexRadiusDaysFor({ recurring_pattern: 'custom', recurring_interval_days: 55 })).toBe(5);
    expect(flexRadiusDaysFor({ recurring_pattern: 'custom', recurring_interval_days: 56 })).toBe(6);
    expect(flexRadiusDaysFor({ recurring_pattern: 'custom', recurring_interval_days: 83 })).toBe(6);
    expect(flexRadiusDaysFor({ recurring_pattern: 'custom', recurring_interval_days: 84 })).toBe(7);
    expect(flexRadiusDaysFor({ recurring_pattern: 'custom', recurring_interval_days: '90' })).toBe(7);
    expect(flexRadiusDaysFor({ recurring_pattern: 'custom', recurring_interval_days: 365 })).toBe(7);
    for (const bad of [undefined, null, 0, -90, '', 'abc', NaN, Infinity * 0]) {
      expect(flexRadiusDaysFor({ recurring_pattern: 'custom', recurring_interval_days: bad })).toBe(5);
    }
    expect(flexRadiusDaysFor({ recurring_pattern: 'custom' })).toBe(5);
  });

  test('every other named pattern is 5, and the interval column is ignored outside custom', () => {
    for (const pattern of ['monthly_nth_weekday', 'every_6_weeks', 'weekly', 'biweekly', 'daily', 'lawn_rounds_9', 'seasonal_feb_oct']) {
      expect(flexRadiusDaysFor({ recurring_pattern: pattern, recurring_interval_days: 120 })).toBe(5);
    }
  });

  test('null, undefined, unknown, a non-string pattern, a prototype key and a row with no pattern all fail closed to 5', () => {
    expect(flexRadiusDaysFor(null)).toBe(5);
    expect(flexRadiusDaysFor(undefined)).toBe(5);
    expect(flexRadiusDaysFor({})).toBe(5);
    for (const pattern of [null, undefined, '', 'every_other_tuesday', 'Quarterly', 7, {}, 'constructor', 'toString', '__proto__']) {
      expect(flexRadiusDaysFor({ recurring_pattern: pattern })).toBe(5);
    }
  });
});

describe('flexBandRadius — the wide band needs the pattern AND room in the series', () => {
  const origDate = '2026-09-21';

  test('7 with no other live occurrence (nearestDays null), and with the nearest one exactly 56 days away', () => {
    expect(flexBandRadius({ radiusDays: 7, neighbors: { nearestDays: null } })).toBe(7);
    expect(flexBandRadius({ radiusDays: 7, neighbors: { prev: '2026-07-27', next: '2026-11-16', nearestDays: 56 } })).toBe(7);
  });

  test('a live occurrence closer than 56 days reads 5 (a plan labeled bimonthly that runs 9 visits a year), 0 included', () => {
    expect(flexBandRadius({ radiusDays: 7, neighbors: { nearestDays: 55 } })).toBe(5);
    expect(flexBandRadius({ radiusDays: 7, neighbors: { nearestDays: 40 } })).toBe(5);
    expect(flexBandRadius({ radiusDays: 7, neighbors: { nearestDays: 0 } })).toBe(5);
  });

  test('an entry without the fact reads 5 (fail closed): the prev / next bounds alone never widen the band', () => {
    expect(flexBandRadius({ radiusDays: 7, neighbors: {} })).toBe(5);
    expect(flexBandRadius({ radiusDays: 7 })).toBe(5);
    expect(flexBandRadius({ radiusDays: 7, neighbors: { prev: '2026-01-01', next: '2027-01-01' } })).toBe(5);
    for (const bad of [undefined, NaN, '90', -1]) expect(flexBandRadius({ radiusDays: 7, neighbors: { nearestDays: bad } })).toBe(5);
  });

  test('the 2-month band is 6 with room in the series, and 5 with a live occurrence closer than 56 days', () => {
    expect(flexBandRadius({ radiusDays: 6, neighbors: { nearestDays: null } })).toBe(6);
    expect(flexBandRadius({ radiusDays: 6, neighbors: { nearestDays: 56 } })).toBe(6);
    expect(flexBandRadius({ radiusDays: 6, neighbors: { nearestDays: 55 } })).toBe(5);
    expect(flexBandRadius({ radiusDays: 6, neighbors: {} })).toBe(5);
  });

  test('the narrow band never widens; a bad radius reads 5', () => {
    expect(flexBandRadius({ radiusDays: 5, neighbors: { nearestDays: null } })).toBe(5);
    for (const bad of [undefined, null, 0, 4, 8, 30, NaN, '7', '6']) expect(flexBandRadius({ radiusDays: bad, neighbors: { nearestDays: null } })).toBe(5);
  });

  test('flexTierMoveWindow applies it: radius 7 with the next visit 40 days ahead is the ±5 window', () => {
    const today = '2026-09-01';
    const near = { next: '2026-10-31', nearestDays: 40 };
    expect(flexTierMoveWindow({ origDate, anchorDate: origDate, today, neighbors: near, radiusDays: 7 }))
      .toEqual(flexTierMoveWindow({ origDate, anchorDate: origDate, today, neighbors: near }));
    expect(flexTierMoveWindow({ origDate, anchorDate: origDate, today, neighbors: near, radiusDays: 7 }))
      .toEqual({ dateFrom: '2026-09-16', dateTo: '2026-09-26' });
    expect(flexTierMoveWindow({ origDate, anchorDate: origDate, today, neighbors: { next: '2026-12-21', nearestDays: 91 }, radiusDays: 7 }))
      .toEqual({ dateFrom: '2026-09-14', dateTo: '2026-09-28' });
  });
});

describe('flexTierMoveWindow — the radius a caller passes', () => {
  const today = '2026-09-01';
  const origDate = '2026-09-21';

  test('radius 7 reaches 7 days each side of BOTH the current date and the anchor (the anchor still limits it)', () => {
    expect(flexTierMoveWindow({
      origDate, anchorDate: origDate, today, neighbors: { nearestDays: null }, radiusDays: 7,
    })).toEqual({ dateFrom: '2026-09-14', dateTo: '2026-09-28' });
    // Already 6 days past its anchor: one more day out, not seven.
    expect(flexTierMoveWindow({
      origDate: '2026-09-22', anchorDate: '2026-09-16', today, neighbors: { nearestDays: null }, radiusDays: 7,
    })).toEqual({ dateFrom: '2026-09-15', dateTo: '2026-09-23' });
    // The anchor's own lower edge binds too: anchor 09-16 reaches back to 09-09, the current date to 09-15.
    expect(flexTierMoveWindow({
      origDate: '2026-09-22', anchorDate: '2026-09-16', today, neighbors: { nearestDays: null }, radiusDays: 7,
    }).dateFrom).toBe('2026-09-15');
  });

  test('the neighbor clamp and the destination floor still apply at radius 7', () => {
    expect(flexTierMoveWindow({
      origDate, anchorDate: origDate, today, neighbors: { prev: '2026-09-19', next: '2026-09-24' }, radiusDays: 7,
    })).toEqual({ dateFrom: '2026-09-20', dateTo: '2026-09-23' });
    // 09-04 is 3 days out: the 5-day floor lifts the lower edge to 09-06; the current date stays reachable.
    expect(flexTierMoveWindow({
      origDate: '2026-09-04', anchorDate: '2026-09-04', today, neighbors: { nearestDays: null }, radiusDays: 7,
    })).toEqual({ dateFrom: '2026-09-04', dateTo: '2026-09-11', dayMoveFrom: '2026-09-06' });
  });

  test('radius 7 admits a 7-day move; radius 5 refuses the same destination', () => {
    const wide = flexTierMoveWindow({ origDate, anchorDate: origDate, today, neighbors: { nearestDays: null }, radiusDays: 7 });
    const narrow = flexTierMoveWindow({ origDate, anchorDate: origDate, today, neighbors: {}, radiusDays: 5 });
    expect(flexWindowAdmits(wide, origDate, '2026-09-28')).toBe(true);
    expect(flexWindowAdmits(wide, origDate, '2026-09-29')).toBe(false);
    expect(flexWindowAdmits(narrow, origDate, '2026-09-27')).toBe(false);
    expect(flexWindowAdmits(narrow, origDate, '2026-09-26')).toBe(true);
  });

  test('no radius, or a radius that is not exactly 5 or 7, equals the old ±5 result', () => {
    const inputs = [
      { origDate, anchorDate: origDate, today, neighbors: {} },
      { origDate: '2026-09-22', anchorDate: '2026-09-16', today, neighbors: {} },
      { origDate: '2026-09-04', anchorDate: '2026-09-04', today, neighbors: { next: '2026-09-09' } },
      { origDate, anchorDate: origDate, today, neighbors: { prev: '2026-09-19', next: '2026-09-24' } },
    ];
    for (const input of inputs) {
      const expected = flexTierMoveWindow(input);
      expect(flexTierMoveWindow({ ...input, radiusDays: 5 })).toEqual(expected);
      for (const bad of [0, 6, 30, NaN, '7', null, undefined, -7, 7.5]) {
        expect(flexTierMoveWindow({ ...input, radiusDays: bad })).toEqual(expected);
      }
    }
    expect(flexTierMoveWindow({ origDate, anchorDate: origDate, today, neighbors: {} })).toEqual({ dateFrom: '2026-09-16', dateTo: '2026-09-26' });
  });
});

describe('loadSeriesNeighbors — withRadius (the apply-time read)', () => {
  const rows = {
    p1: [
      { id: 'p1', scheduled_date: '2026-09-01', recurring_pattern: 'quarterly' },
      { id: 's1', scheduled_date: '2026-12-01', recurring_pattern: 'quarterly' },
      { id: 's2', scheduled_date: '2027-03-01', recurring_pattern: 'monthly' },
    ],
  };
  const services = [{ id: 's1', recurring_parent_id: 'p1' }, { id: 's2', recurring_parent_id: 'p1' }];

  test('off by default: entries are exactly {prev, next}', async () => {
    const map = await loadSeriesNeighbors(seriesDbStub(rows), services);
    expect(map.get('s1')).toEqual({ prev: '2026-09-01', next: '2027-03-01' });
  });

  test('on: each entry carries the radius of its OWN row as the read saw it', async () => {
    const map = await loadSeriesNeighbors(seriesDbStub(rows), services, { withRadius: true });
    expect(map.get('s1')).toEqual({ prev: '2026-09-01', next: '2027-03-01', radiusDays: 7, nearestDays: 90 });
    expect(map.get('s2')).toEqual({ prev: '2026-12-01', next: null, radiusDays: 5, nearestDays: 90 });
  });

  test('nearestDays is by ACTUAL date: a sibling due 40 days later and rescheduled to 70 days later does not narrow the band', async () => {
    const moved = { p1: [
      { id: 's1', scheduled_date: '2026-12-01', recurring_pattern: 'bimonthly' },
      { id: 's2', scheduled_date: '2027-02-09', date_exception: true, date_exception_cadence_date: '2027-01-10', recurring_pattern: 'bimonthly' },
    ] };
    const entry = (await loadSeriesNeighbors(seriesDbStub(moved), [{ id: 's1', recurring_parent_id: 'p1' }], { withRadius: true })).get('s1');
    // The crossing guard still sees the old cadence date; the band reads where the sibling is now.
    expect(entry).toMatchObject({ next: '2027-01-10', nearestDays: 70, radiusDays: 6 }); // bimonthly: ±6 (owner 2026-11-24)
    expect(flexBandRadius({ radiusDays: entry.radiusDays, neighbors: entry })).toBe(6);
  });

  test('a sibling rescheduled onto the visit\'s own date is 0 days away: the band is narrow', async () => {
    const same = { p1: [
      { id: 's1', scheduled_date: '2026-12-01', recurring_pattern: 'quarterly' },
      { id: 's2', scheduled_date: '2026-12-01', date_exception: true, date_exception_cadence_date: '2027-03-01', recurring_pattern: 'quarterly' },
    ] };
    const entry = (await loadSeriesNeighbors(seriesDbStub(same), [{ id: 's1', recurring_parent_id: 'p1' }], { withRadius: true })).get('s1');
    expect(entry.nearestDays).toBe(0);
    expect(flexBandRadius({ radiusDays: entry.radiusDays, neighbors: entry })).toBe(5);
  });

  test('a live sibling with no readable date still counts (0 days): the band is narrow, the crossing guard ignores it', async () => {
    const blank = { p1: [
      { id: 's1', scheduled_date: '2026-12-01', recurring_pattern: 'quarterly' },
      { id: 's2', scheduled_date: null, recurring_pattern: 'quarterly' },
    ] };
    const entry = (await loadSeriesNeighbors(seriesDbStub(blank), [{ id: 's1', recurring_parent_id: 'p1' }], { withRadius: true })).get('s1');
    expect(entry).toEqual({ prev: null, next: null, radiusDays: 7, nearestDays: 0 });
    expect(flexBandRadius({ radiusDays: entry.radiusDays, neighbors: entry })).toBe(5);
  });

  test('a skipped, rescheduled or no-show sibling does not narrow the band; the crossing guard still sees its slot', async () => {
    for (const status of ['skipped', 'rescheduled', 'no_show']) {
      const rows = { p1: [
        { id: 's1', scheduled_date: '2026-12-01', recurring_pattern: 'quarterly', status: 'confirmed' },
        { id: 's2', scheduled_date: '2027-01-10', recurring_pattern: 'quarterly', status },
        { id: 's3', scheduled_date: '2027-03-01', recurring_pattern: 'quarterly', status: 'confirmed' },
      ] };
      const entry = (await loadSeriesNeighbors(seriesDbStub(rows), [{ id: 's1', recurring_parent_id: 'p1' }], { withRadius: true })).get('s1');
      expect(entry).toEqual({ prev: null, next: '2027-01-10', radiusDays: 7, nearestDays: 90 });
      expect(flexBandRadius({ radiusDays: entry.radiusDays, neighbors: entry })).toBe(7);
    }
  });

  test('a scheduled sibling 40 days away still narrows the band', async () => {
    const rows = { p1: [
      { id: 's1', scheduled_date: '2026-12-01', recurring_pattern: 'quarterly', status: 'confirmed' },
      { id: 's2', scheduled_date: '2027-01-10', recurring_pattern: 'quarterly', status: 'pending' },
    ] };
    const entry = (await loadSeriesNeighbors(seriesDbStub(rows), [{ id: 's1', recurring_parent_id: 'p1' }], { withRadius: true })).get('s1');
    expect(entry.nearestDays).toBe(40);
    expect(flexBandRadius({ radiusDays: entry.radiusDays, neighbors: entry })).toBe(5);
  });

  test('a series with no other live occurrence: nearestDays null, the pattern alone decides', async () => {
    const alone = { p1: [{ id: 's1', scheduled_date: '2026-12-01', recurring_pattern: 'quarterly' }] };
    const entry = (await loadSeriesNeighbors(seriesDbStub(alone), [{ id: 's1', recurring_parent_id: 'p1' }], { withRadius: true })).get('s1');
    expect(entry).toEqual({ prev: null, next: null, radiusDays: 7, nearestDays: null });
    expect(flexBandRadius({ radiusDays: entry.radiusDays, neighbors: entry })).toBe(7);
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
