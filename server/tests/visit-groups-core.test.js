/**
 * Visit groups Phase 1 — pure decision helpers (visit-group-scope.md rev 5).
 * DB paths (locking, seq allocation) are exercised by the migration in the
 * from-empty gates CI job; these tests pin the join/dissolve/split/guard
 * contracts the doc rules.
 */
const {
  _test: {
    stopBaseKey, windowsOverlap, familiesCompatible, canJoin, canDissolve,
    canSplit, isRowVisitBlocked, toMinutes, windowedMembersConnected,
  },
} = require('../services/visit-groups');

const CUST = 'c1';
const PROP = 'p1';
const baseRow = {
  customer_id: CUST,
  property_id: PROP,
  scheduled_date: '2026-08-30',
  window_start: '09:00',
  window_end: '11:00',
  technician_id: null,
  groupable: true,
  group_family: 'recurring_property_service',
};
const baseVisit = { ...baseRow, status: 'open' };

describe('stopBaseKey', () => {
  test('normalizes pg Date instances (UTC calendar day), not toString', () => {
    // pg parses `date` at UTC midnight; toString would give 'Sat Aug 29…'.
    expect(stopBaseKey({ propertyId: PROP, customerId: CUST, scheduledDate: new Date('2026-08-30T00:00:00Z') }))
      .toBe('p1:2026-08-30');
  });
  test('prefers property, falls back to customer, strips time from date', () => {
    expect(stopBaseKey({ propertyId: PROP, customerId: CUST, scheduledDate: '2026-08-30T00:00:00Z' }))
      .toBe('p1:2026-08-30');
    expect(stopBaseKey({ propertyId: null, customerId: CUST, scheduledDate: '2026-08-30' }))
      .toBe('c1:2026-08-30');
  });
  test('throws without an anchor', () => {
    expect(() => stopBaseKey({ scheduledDate: '2026-08-30' })).toThrow();
  });
});

describe('windowsOverlap (rev 5f: window lives on the visit, not the key)', () => {
  test('sharing any minute overlaps; disjoint does not', () => {
    expect(windowsOverlap('09:00', '11:00', '10:00', '12:00')).toBe(true);
    expect(windowsOverlap('09:00', '10:00', '10:00', '12:00')).toBe(true); // touching counts
    expect(windowsOverlap('08:00', '09:00', '13:00', '15:00')).toBe(false);
  });
  test('windowless rows join anything', () => {
    expect(windowsOverlap(null, null, '10:00', '12:00')).toBe(true);
    expect(windowsOverlap('09:00', '11:00', null, null)).toBe(true);
  });
  test('point windows (no end) compare by start', () => {
    expect(windowsOverlap('09:00', null, '09:30', '10:00')).toBe(false);
    expect(windowsOverlap('09:30', null, '09:00', '10:00')).toBe(true);
  });
  test('toMinutes tolerates HH:MM:SS and garbage', () => {
    expect(toMinutes('09:30:00')).toBe(570);
    expect(toMinutes('bogus')).toBe(null);
  });
});

describe('canJoin', () => {
  test('happy path joins', () => {
    expect(canJoin(baseRow, baseVisit).ok).toBe(true);
  });
  test.each([
    ['row_terminal', { status: 'completed' }],
    ['row_terminal', { status: 'cancelled' }],
    ['row_terminal', { status: 'skipped' }],
    ['row_terminal', { status: 'no_show' }],
    ['customer', { customer_id: 'other' }],
    ['property', { property_id: 'other' }],
    ['date', { scheduled_date: '2026-08-31' }],
    ['not_groupable', { groupable: false }],
    ['family', { group_family: 'lawn_tree_shrub' }],
    ['technician', { technician_id: 't2' }],
    ['window', { window_start: '14:00', window_end: '16:00' }],
    ['office_review', { status: 'pending', source_action: 'ai_call_outbound_review', customer_confirmed: false }],
  ])('%s mismatch refuses', (reason, patch) => {
    const visit = { ...baseVisit, technician_id: 't1' };
    const row = { ...baseRow, technician_id: 't1', ...patch };
    expect(canJoin(row, visit)).toEqual({ ok: false, reason });
  });
  test('null technician on the row joins an assigned visit', () => {
    expect(canJoin({ ...baseRow, technician_id: null }, { ...baseVisit, technician_id: 't1' }).ok).toBe(true);
  });
  test('closed visit refuses', () => {
    expect(canJoin(baseRow, { ...baseVisit, status: 'closed' })).toEqual({ ok: false, reason: 'visit_not_open' });
  });
  test('missing families never join (fail closed)', () => {
    expect(familiesCompatible(null, 'pest_rodent')).toBe(false);
    expect(canJoin({ ...baseRow, group_family: null }, baseVisit).ok).toBe(false);
  });
});

const untouched = {
  status: 'open',
  effectsStarted: false,
  enRouteAt: null,
  arrivedAt: null,
  activePacket: false,
  anyPacket: false,
  childRecords: false,
  childInvoices: false,
  childReports: false,
  linkIssued: false,
  paymentAttempted: false,
};

describe('canDissolve (rev 5: only while completely untouched)', () => {
  test('untouched open visit dissolves', () => {
    expect(canDissolve(untouched).ok).toBe(true);
  });
  test.each([
    ['effects_sent', { effectsStarted: true }],
    ['route_started', { enRouteAt: '2026-08-30T13:00:00Z' }],
    ['route_started', { arrivedAt: '2026-08-30T13:30:00Z' }],
    ['packet_exists', { anyPacket: true }],
    ['child_artifacts', { childRecords: true }],
    ['child_artifacts', { childInvoices: true }],
    ['link_issued', { linkIssued: true }],
    ['payment_attempted', { paymentAttempted: true }],
    ['visit_not_open', { status: 'closing' }],
  ])('%s blocks dissolution', (reason, patch) => {
    expect(canDissolve({ ...untouched, ...patch })).toEqual({ ok: false, reason });
  });
});

describe('canSplit (rev 5d membership freeze)', () => {
  test('reminder/tracker effects do NOT block a split', () => {
    expect(canSplit({ ...untouched, effectsStarted: true, enRouteAt: '2026-08-30T13:00:00Z' }).ok).toBe(true);
  });
  test('a done or failed packet also freezes membership (retry safety)', () => {
    expect(canSplit({ ...untouched, anyPacket: true })).toEqual({ ok: false, reason: 'packet_in_flight' });
  });
  test.each([
    ['packet_in_flight', { activePacket: true }],
    ['child_artifacts', { childInvoices: true }],
    ['link_issued', { linkIssued: true }],
    ['payment_attempted', { paymentAttempted: true }],
    ['visit_not_open', { status: 'closed' }],
  ])('%s freezes membership', (reason, patch) => {
    expect(canSplit({ ...untouched, ...patch })).toEqual({ ok: false, reason });
  });
});

describe('isRowVisitBlocked (legacy /complete guard, rev 5c)', () => {
  test('unattached row is never blocked', () => {
    expect(isRowVisitBlocked({ visit_id: null }, null)).toBe(false);
  });
  test('open, closing, and closed visits all block legacy completion', () => {
    for (const status of ['open', 'closing', 'closed']) {
      expect(isRowVisitBlocked({ visit_id: 'v1' }, { status })).toBe(true);
    }
  });
  test('dissolved visit restores per-row completion', () => {
    expect(isRowVisitBlocked({ visit_id: 'v1' }, { status: 'dissolved' })).toBe(false);
  });
  test('orphaned pointer fails CLOSED (never risk a duplicate completion)', () => {
    expect(isRowVisitBlocked({ visit_id: 'v1' }, null)).toBe(true);
  });
});

describe('windowedMembersConnected (codex #3590 r8/r12: one transitive chain = one stop)', () => {
  const w = (a, b) => ({ window_start: a, window_end: b });
  test('a transitive chain is connected regardless of input order', () => {
    const chain = [w('11:00', '12:00'), w('09:00', '10:00'), w('10:00', '11:00')];
    expect(windowedMembersConnected(chain)).toBe(true);
    expect(windowedMembersConnected(chain.reverse())).toBe(true);
  });
  test('a gap splits the stop; windowless members never break a chain', () => {
    expect(windowedMembersConnected([w('09:00', '10:00'), w('11:00', '12:00')])).toBe(false);
    expect(windowedMembersConnected([w('09:00', '10:00'), w(null, null), w('10:00', '11:00')])).toBe(true);
    expect(windowedMembersConnected([w(null, null), w(null, null)])).toBe(true);
    expect(windowedMembersConnected([])).toBe(true);
  });
  test('point windows (no end) chain by start', () => {
    expect(windowedMembersConnected([w('09:00', null), w('09:00', '10:00')])).toBe(true);
    expect(windowedMembersConnected([w('09:00', null), w('09:30', '10:00')])).toBe(false);
  });
});

describe('siblingEligibleFor (live fan-out, doc §3)', () => {
  const { siblingEligibleFor } = require('../services/visit-groups')._test;
  test('en_route accepts the pre-en-route statuses only; a rescheduled placeholder never follows a sibling', () => {
    expect(siblingEligibleFor('en_route', 'pending')).toBe(true);
    expect(siblingEligibleFor('en_route', 'confirmed')).toBe(true);
    expect(siblingEligibleFor('en_route', 'rescheduled')).toBe(false);
    expect(siblingEligibleFor('en_route', 'on_site')).toBe(false);
    expect(siblingEligibleFor('en_route', 'completed')).toBe(false);
  });
  test('on_site also accepts en_route; terminal never', () => {
    expect(siblingEligibleFor('on_site', 'en_route')).toBe(true);
    expect(siblingEligibleFor('on_site', 'pending')).toBe(true);
    expect(siblingEligibleFor('on_site', 'cancelled')).toBe(false);
    expect(siblingEligibleFor('completed', 'pending')).toBe(false);
  });
});

describe('visitSummariesForRows (schedule payload)', () => {
  const { visitSummariesForRows } = require('../services/visit-groups')._test;
  test('attaches one shared summary per visit; ungrouped rows untouched', () => {
    const rows = [
      { id: 'a', visitId: 'v1', status: 'completed', estimatedDuration: 30, serviceType: 'Pest' },
      { id: 'b', visitId: null, status: 'pending', estimatedDuration: 45 },
      { id: 'c', visitId: 'v1', status: 'pending', estimatedDuration: 25, serviceType: 'Rodent' },
    ];
    const map = visitSummariesForRows(rows);
    expect(map.size).toBe(1);
    expect(rows[1].visit).toBeUndefined();
    expect(rows[0].visit).toBe(rows[2].visit);
    expect(rows[0].visit).toMatchObject({
      id: 'v1', serviceCount: 2, memberIds: ['a', 'c'], primaryId: 'c',
      estimatedDuration: 55, serviceTypes: ['Pest', 'Rodent'], liveCount: 1,
    });
  });
  test('primary falls back to the first member when every member is terminal', () => {
    const rows = [
      { id: 'a', visitId: 'v1', status: 'completed' },
      { id: 'c', visitId: 'v1', status: 'skipped' },
    ];
    visitSummariesForRows(rows);
    expect(rows[0].visit.primaryId).toBe('a');
    expect(rows[0].visit.liveCount).toBe(0);
  });
});

describe('effectTypeForKind / dedupeKeyFor (reminder rails, spec §4)', () => {
  const { _test: { effectTypeForKind, dedupeKeyFor } } = require('../services/visit-groups');

  test('tracker kinds keep their historical mapping — unknown falls back to arrived', () => {
    expect(effectTypeForKind('en_route')).toBe('tracker_en_route');
    expect(effectTypeForKind('arrived')).toBe('tracker_arrived');
    expect(effectTypeForKind('on_site')).toBe('tracker_arrived');
    expect(effectTypeForKind('anything_else')).toBe('tracker_arrived');
  });

  test('reminder kinds map to their own effect types', () => {
    expect(effectTypeForKind('reminder_72h')).toBe('reminder_72h');
    expect(effectTypeForKind('reminder_24h')).toBe('reminder_24h');
  });

  test('tracker dedupe keys are byte-identical to the historical shape (existing prod rows must keep matching)', () => {
    const visit = { id: 'v1', scheduled_date: '2026-08-30' };
    expect(dedupeKeyFor(visit, 'tracker_en_route')).toBe('v1:tracker_en_route');
    expect(dedupeKeyFor(visit, 'tracker_arrived')).toBe('v1:tracker_arrived');
  });

  test('reminder keys carry the visit DATE — a moved visit claims fresh at the new date (fires once, never zero)', () => {
    const visit = { id: 'v1', scheduled_date: '2026-08-30' };
    expect(dedupeKeyFor(visit, 'reminder_72h')).toBe('v1:reminder_72h:2026-08-30');
    expect(dedupeKeyFor(visit, 'reminder_24h')).toBe('v1:reminder_24h:2026-08-30');
    const moved = { ...visit, scheduled_date: '2026-09-02' };
    expect(dedupeKeyFor(moved, 'reminder_72h')).toBe('v1:reminder_72h:2026-09-02');
    expect(dedupeKeyFor(moved, 'reminder_72h')).not.toBe(dedupeKeyFor(visit, 'reminder_72h'));
    // pg Date instance normalizes to the same calendar day.
    expect(dedupeKeyFor({ id: 'v1', scheduled_date: new Date('2026-08-30T00:00:00Z') }, 'reminder_72h'))
      .toBe('v1:reminder_72h:2026-08-30');
  });
});

describe('customerExcludedByAutopay (spec rev-2: autopay customers are not grouped)', () => {
  const knexFor = (customerRow) => (table) => ({
    where: () => ({ first: async () => (table === 'customers' ? customerRow : undefined) }),
  });

  afterEach(() => { jest.dontMock('../services/autopay-eligibility'); jest.resetModules(); });

  const freshVG = (onAutopayImpl, isPausedImpl = () => false) => {
    jest.doMock('../services/autopay-eligibility', () => ({ customerOnAutopay: onAutopayImpl, isPaused: isPausedImpl }));
    jest.resetModules();
    return require('../services/visit-groups');
  };

  test('an autopay customer is excluded; a non-autopay customer is not', async () => {
    const vg = freshVG(jest.fn(async (c) => c.autopay_enabled === true));
    expect(await vg.customerExcludedByAutopay('c-auto', knexFor({ id: 'c-auto', autopay_enabled: true }))).toBe(true);
    expect(await vg.customerExcludedByAutopay('c-plain', knexFor({ id: 'c-plain', autopay_enabled: false }))).toBe(false);
  });

  test('a PAUSED autopay customer is still excluded — enrollment excludes, not current chargeability (pre-push P0)', async () => {
    // customerOnAutopay returns FALSE during a pause; the explicit
    // enrollment flag must exclude anyway, or a group formed during the
    // pause persists into resumed autopay.
    const onAutopay = jest.fn(async () => false);
    const vg = freshVG(onAutopay);
    expect(await vg.customerExcludedByAutopay('c-paused', knexFor({
      id: 'c-paused', autopay_enabled: true, autopay_paused_until: '2099-01-01',
    }))).toBe(true);
    // Short-circuited on the enrollment flag — the chargeability predicate
    // is never even consulted.
    expect(onAutopay).not.toHaveBeenCalled();
  });

  test('fail closed: unreadable customer or throwing predicate refuses grouping', async () => {
    const vg = freshVG(jest.fn(async () => { throw new Error('autopay read down'); }));
    expect(await vg.customerExcludedByAutopay('c1', knexFor({ id: 'c1' }))).toBe(true);
    const vg2 = freshVG(jest.fn(async () => false));
    expect(await vg2.customerExcludedByAutopay('c-missing', knexFor(undefined))).toBe(true);
  });

  test('a paused LEGACY enrollment (NULL flag + live pause) is excluded via isPaused, and an explicit false is not (GH r3 P1)', async () => {
    // customerOnAutopay returns false for every pause before inspecting the
    // method — a NULL-flag legacy enrollment must be caught by the pause
    // itself (only enrolled accounts pause).
    const onAutopay = jest.fn(async () => false);
    const paused = jest.fn((c) => Boolean(c.autopay_paused_until));
    const vg = freshVG(onAutopay, paused);
    expect(await vg.customerExcludedByAutopay('c-legacy', knexFor({
      id: 'c-legacy', autopay_enabled: null, autopay_paused_until: '2099-01-01',
    }))).toBe(true);
    expect(onAutopay).not.toHaveBeenCalled();
    // Explicitly disabled = unenrolled, even with a stale pause stamp left
    // behind — never excluded, and never consults the predicates.
    expect(await vg.customerExcludedByAutopay('c-off', knexFor({
      id: 'c-off', autopay_enabled: false, autopay_paused_until: '2099-01-01',
    }))).toBe(false);
  });

  test('the predicate is called failClosed (an unreadable autopay state must throw, not read as unenrolled)', async () => {
    const spy = jest.fn(async () => false);
    const vg = freshVG(spy);
    await vg.customerExcludedByAutopay('c1', knexFor({ id: 'c1' }));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), expect.objectContaining({ failClosed: true }));
  });
});
