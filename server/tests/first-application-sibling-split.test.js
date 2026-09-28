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
  divergenceStateFingerprint,
  representativeCandidatesByEstimate,
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

  // PR #5021 Codex r6 (head 2168cb0877): a completed sibling used to be
  // excluded here on the theory that completion is a "settled fact" — but
  // completing a visit never settles or rewrites the still-open COMBINED
  // invoice, so excluding it let the group silently read as "realigned"
  // (empty diverging set) the moment the moved sibling finished, and the
  // office lost the alert. A completed sibling now still counts.
  test('a completed sibling still counts — completion never settles the still-open combined invoice', () => {
    const a = anchor();
    const diverged = member('diverged', { scheduled_date: '2026-10-05', completed_at: new Date('2026-10-01') });
    expect(divergingSiblings(a, [a, diverged]).map((m) => m.id)).toEqual(['diverged']);
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

  test('a diverging sibling that already has its OWN live invoice → clear, split_completed (manual split done)', () => {
    const a = anchor();
    const b = member('b', { scheduled_date: '2026-10-05', has_own_live_invoice: true });
    const verdict = evaluateGroupDivergence({ anchor: a, members: [a, b], invoiceStatus: 'draft' });
    expect(verdict).toEqual({ action: 'clear', reason: 'split_completed' });
  });

  test('two diverging siblings, only one split off → alerts on the still-unresolved one only', () => {
    const a = anchor();
    const split = member('split-off', { scheduled_date: '2026-10-05', has_own_live_invoice: true });
    const unresolved = member('still-needs-split', { scheduled_date: '2026-10-09' });
    const verdict = evaluateGroupDivergence({ anchor: a, members: [a, split, unresolved], invoiceStatus: 'draft' });
    expect(verdict.action).toBe('alert');
    expect(verdict.diverging.map((m) => m.id)).toEqual(['still-needs-split']);
  });

  test('a diverging sibling with no invoice yet (has_own_live_invoice false/undefined) still alerts', () => {
    const a = anchor();
    const b = member('b', { scheduled_date: '2026-10-05', has_own_live_invoice: false });
    const verdict = evaluateGroupDivergence({ anchor: a, members: [a, b], invoiceStatus: 'draft' });
    expect(verdict.action).toBe('alert');
    expect(verdict.diverging.map((m) => m.id)).toEqual(['b']);
  });
});

describe('divergenceStateFingerprint', () => {
  const a = anchor();
  const b = member('b', { scheduled_date: '2026-10-05' });

  test('identical inputs → identical fingerprint (order of diverging members never matters)', () => {
    const c = member('c', { scheduled_date: '2026-10-09' });
    const fp1 = divergenceStateFingerprint({ anchor: a, diverging: [b, c], invoiceId: 'inv-1', invoiceTotal: 153.60 });
    const fp2 = divergenceStateFingerprint({ anchor: a, diverging: [c, b], invoiceId: 'inv-1', invoiceTotal: '153.60' });
    expect(fp1).toBe(fp2);
  });

  test('a different diverging date changes the fingerprint', () => {
    const fp1 = divergenceStateFingerprint({ anchor: a, diverging: [b], invoiceId: 'inv-1', invoiceTotal: 100 });
    const bMoved = member('b', { scheduled_date: '2026-10-09' });
    const fp2 = divergenceStateFingerprint({ anchor: a, diverging: [bMoved], invoiceId: 'inv-1', invoiceTotal: 100 });
    expect(fp1).not.toBe(fp2);
  });

  test('a different invoice id changes the fingerprint', () => {
    const fp1 = divergenceStateFingerprint({ anchor: a, diverging: [b], invoiceId: 'inv-1', invoiceTotal: 100 });
    const fp2 = divergenceStateFingerprint({ anchor: a, diverging: [b], invoiceId: 'inv-2', invoiceTotal: 100 });
    expect(fp1).not.toBe(fp2);
  });

  test('a different invoice total changes the fingerprint', () => {
    const fp1 = divergenceStateFingerprint({ anchor: a, diverging: [b], invoiceId: 'inv-1', invoiceTotal: 100 });
    const fp2 = divergenceStateFingerprint({ anchor: a, diverging: [b], invoiceId: 'inv-1', invoiceTotal: 142.50 });
    expect(fp1).not.toBe(fp2);
  });
});

describe('representativeCandidatesByEstimate', () => {
  const row = (over = {}) => ({
    source_estimate_id: 'est-1', invoice_status: 'draft', invoice_created_at: '2026-09-01T00:00:00Z', ...over,
  });

  test('a single row per estimate passes through unchanged', () => {
    const r = row();
    expect(representativeCandidatesByEstimate([r])).toEqual([r]);
  });

  test('a live row always wins over a settled row for the same estimate, regardless of order', () => {
    const live = row({ invoice_id: 'live', invoice_status: 'draft' });
    const settled = row({ invoice_id: 'settled', invoice_status: 'void', invoice_created_at: '2026-09-05T00:00:00Z' });
    expect(representativeCandidatesByEstimate([settled, live])).toEqual([live]);
    expect(representativeCandidatesByEstimate([live, settled])).toEqual([live]);
  });

  test('two live rows for the same estimate — the newer invoice wins', () => {
    const older = row({ invoice_id: 'older', invoice_created_at: '2026-09-01T00:00:00Z' });
    const newer = row({ invoice_id: 'newer', invoice_created_at: '2026-09-10T00:00:00Z' });
    expect(representativeCandidatesByEstimate([older, newer])).toEqual([newer]);
  });

  test('rows for different estimates are kept independently', () => {
    const a1 = row({ source_estimate_id: 'est-a', invoice_id: 'a' });
    const b1 = row({ source_estimate_id: 'est-b', invoice_id: 'b' });
    expect(representativeCandidatesByEstimate([a1, b1])).toEqual(expect.arrayContaining([a1, b1]));
    expect(representativeCandidatesByEstimate([a1, b1])).toHaveLength(2);
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
