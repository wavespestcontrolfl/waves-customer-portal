/**
 * Visit groups Phase 1 — pure decision helpers (visit-group-scope.md rev 5).
 * DB paths (locking, seq allocation) are exercised by the migration in the
 * from-empty gates CI job; these tests pin the join/dissolve/split/guard
 * contracts the doc rules.
 */
const {
  _test: {
    stopBaseKey, windowsOverlap, familiesCompatible, canJoin, canDissolve,
    canSplit, isRowVisitBlocked, toMinutes,
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
    ['customer', { customer_id: 'other' }],
    ['property', { property_id: 'other' }],
    ['date', { scheduled_date: '2026-08-31' }],
    ['not_groupable', { groupable: false }],
    ['family', { group_family: 'lawn_tree_shrub' }],
    ['technician', { technician_id: 't2' }],
    ['window', { window_start: '14:00', window_end: '16:00' }],
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
