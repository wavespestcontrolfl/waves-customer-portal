/**
 * Same-trip first-application billing ALERT — detection predicate (unit).
 *
 * evaluateGroupDivergence is the pure, DB-free decision the periodic sweep
 * (server/services/scheduler.js) makes for one estimate group on every
 * tick: alert, clear a standing alert, or do nothing. No mocks needed — see
 * first-application-sibling-split.postgres.test.js for the DB-touching
 * sweep/alert/clear coverage (candidate discovery, the dedupe advisory
 * lock, the clear-through-notifications mechanism).
 */
const {
  evaluateGroupDivergence,
  divergingSiblings,
  isInvoiceSettled,
  dateOnly,
  SETTLED_INVOICE_STATUSES,
} = require('../services/first-application-sibling-split');

const anchor = (over = {}) => ({ id: 'anchor-1', scheduled_date: '2026-10-01', completed_at: null, ...over });
const member = (id, over = {}) => ({ id, scheduled_date: '2026-10-01', completed_at: null, estimated_price: null, ...over });

describe('isInvoiceSettled', () => {
  test('paid/prepaid/void/refunded/canceled/cancelled are all settled', () => {
    for (const status of SETTLED_INVOICE_STATUSES) {
      expect(isInvoiceSettled(status)).toBe(true);
    }
  });
  test('draft/sent/viewed/overdue are not settled', () => {
    for (const status of ['draft', 'sent', 'viewed', 'overdue', 'processing']) {
      expect(isInvoiceSettled(status)).toBe(false);
    }
  });
});

describe('divergingSiblings', () => {
  test('excludes the anchor itself, and any member sharing the anchor date', () => {
    const a = anchor();
    const same = member('same', { scheduled_date: '2026-10-01' });
    const diverged = member('diverged', { scheduled_date: '2026-10-05' });
    expect(divergingSiblings(a, [a, same, diverged]).map((m) => m.id)).toEqual(['diverged']);
  });

  test('excludes a completed sibling — a settled fact a plain date move cannot change', () => {
    const a = anchor();
    const diverged = member('diverged', { scheduled_date: '2026-10-05', completed_at: new Date('2026-10-01') });
    expect(divergingSiblings(a, [a, diverged])).toEqual([]);
  });

  test('a diverging sibling with its OWN estimated_price still counts (Codex P1 fix)', () => {
    const a = anchor();
    const pricedDiverged = member('priced-diverged', { scheduled_date: '2026-10-05', estimated_price: 42 });
    expect(divergingSiblings(a, [a, pricedDiverged]).map((m) => m.id)).toEqual(['priced-diverged']);
  });
});

describe('evaluateGroupDivergence', () => {
  test('diverged + unpaid (open) invoice → alert', () => {
    const a = anchor();
    const b = member('b', { scheduled_date: '2026-10-05' });
    const verdict = evaluateGroupDivergence({ anchor: a, members: [a, b], invoiceStatus: 'sent' });
    expect(verdict.action).toBe('alert');
    expect(verdict.diverging.map((m) => m.id)).toEqual(['b']);
  });

  test('realigned (same date as the anchor) → clear', () => {
    const a = anchor();
    const b = member('b', { scheduled_date: '2026-10-01' });
    const verdict = evaluateGroupDivergence({ anchor: a, members: [a, b], invoiceStatus: 'sent' });
    expect(verdict).toEqual({ action: 'clear', reason: 'realigned' });
  });

  test('a priced sibling that has ALSO diverged still alerts', () => {
    const a = anchor();
    const b = member('b', { scheduled_date: '2026-10-09', estimated_price: 99 });
    const verdict = evaluateGroupDivergence({ anchor: a, members: [a, b], invoiceStatus: 'draft' });
    expect(verdict.action).toBe('alert');
    expect(verdict.diverging.map((m) => m.id)).toEqual(['b']);
  });

  test('paid invoice → no alert, even while the visits still diverge', () => {
    const a = anchor();
    const b = member('b', { scheduled_date: '2026-10-05' });
    const verdict = evaluateGroupDivergence({ anchor: a, members: [a, b], invoiceStatus: 'paid' });
    expect(verdict).toEqual({ action: 'clear', reason: 'invoice_settled' });
  });

  test('a voided invoice → no alert either', () => {
    const a = anchor();
    const b = member('b', { scheduled_date: '2026-10-05' });
    const verdict = evaluateGroupDivergence({ anchor: a, members: [a, b], invoiceStatus: 'void' });
    expect(verdict.action).toBe('clear');
  });

  test('bulk-moved-together — every member lands on the SAME new day → no alert', () => {
    const a = anchor({ scheduled_date: '2026-11-01' });
    const b = member('b', { scheduled_date: '2026-11-01' });
    const c = member('c', { scheduled_date: '2026-11-01' });
    const verdict = evaluateGroupDivergence({ anchor: a, members: [a, b, c], invoiceStatus: 'sent' });
    expect(verdict).toEqual({ action: 'clear', reason: 'realigned' });
  });

  test('fewer than two members (group dissolved) → clear, never throws', () => {
    const a = anchor();
    expect(evaluateGroupDivergence({ anchor: a, members: [a], invoiceStatus: 'sent' }))
      .toEqual({ action: 'clear', reason: 'no_group' });
  });

  test('no anchor at all → clear, never throws', () => {
    expect(evaluateGroupDivergence({ anchor: null, members: [], invoiceStatus: 'sent' }))
      .toEqual({ action: 'clear', reason: 'no_group' });
  });
});

describe('dateOnly', () => {
  test('normalizes a Date, a timestamp string, and a plain date string the same way', () => {
    expect(dateOnly(new Date('2026-10-01T14:00:00Z'))).toBe('2026-10-01');
    expect(dateOnly('2026-10-01T00:00:00.000Z')).toBe('2026-10-01');
    expect(dateOnly('2026-10-01')).toBe('2026-10-01');
    expect(dateOnly(null)).toBeNull();
  });
});
