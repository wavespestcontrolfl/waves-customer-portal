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
  groupCandidatesByEstimate,
  isInvoiceSettled,
  dateOnly,
  SETTLED_INVOICE_STATUSES,
  selectFreshBatch,
  FRESH_BATCH_LIMIT,
} = require('../services/first-application-sibling-split');

const anchor = (over = {}) => ({ id: 'anchor-1', scheduled_date: '2026-10-01', completed_at: null, ...over });
const member = (id, over = {}) => ({
  id, scheduled_date: '2026-10-01', completed_at: null, estimated_price: null, status: 'confirmed', ...over,
});

describe('isInvoiceSettled', () => {
  test('paid/prepaid/processing/void/refunded/canceled/cancelled are all settled', () => {
    for (const status of SETTLED_INVOICE_STATUSES) {
      expect(isInvoiceSettled(status)).toBe(true);
    }
  });

  // Codex P2 (PR #5021 r7): 'processing' used to be missing from this
  // module's own locally-duplicated settled list even though
  // invoice-helpers.js's canonical INVOICE_UNCOLLECTIBLE_STATUSES already
  // treated a mid-settlement (card charging) invoice as uncollectible —
  // a drift that could raise a live alert against an invoice that is,
  // everywhere else in the app, already settled.
  test("'processing' is settled — SETTLED_INVOICE_STATUSES now reuses invoice-helpers.js's canonical list", () => {
    expect(SETTLED_INVOICE_STATUSES).toContain('processing');
    expect(isInvoiceSettled('processing')).toBe(true);
  });

  test('draft/sent/viewed/overdue are not settled', () => {
    for (const status of ['draft', 'sent', 'viewed', 'overdue']) {
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

  // Codex P1 (PR #5021 r7): cancelling a sibling never removes its share of
  // the still-open combined invoice (voidOpenInvoicesForCancelledService
  // only voids an invoice linked to the CANCELLED service's OWN
  // scheduled_service_id) — a cancelled top-level sibling needs review even
  // when it NEVER diverged by date at all, since a same-day cancellation
  // leaves exactly as stale a charge as one that also moved.
  test('a cancelled sibling that NEVER diverged by date still alerts (stale charge, not a realign)', () => {
    const a = anchor();
    const cancelled = member('cancelled-same-day', { scheduled_date: '2026-10-01', status: 'cancelled' });
    const verdict = evaluateGroupDivergence({ anchor: a, members: [a, cancelled], invoiceStatus: 'sent' });
    expect(verdict.action).toBe('alert');
    expect(verdict.diverging.map((m) => m.id)).toEqual(['cancelled-same-day']);
  });

  test('a cancelled sibling that ALSO diverged by date still alerts, once, with cancelled status on it', () => {
    const a = anchor();
    const cancelled = member('cancelled-moved', { scheduled_date: '2026-10-09', status: 'cancelled' });
    const verdict = evaluateGroupDivergence({ anchor: a, members: [a, cancelled], invoiceStatus: 'sent' });
    expect(verdict.action).toBe('alert');
    expect(verdict.diverging).toHaveLength(1);
    expect(verdict.diverging[0]).toMatchObject({ id: 'cancelled-moved', status: 'cancelled' });
  });

  test('a cancelled sibling that already has its OWN live invoice → clear, split_completed', () => {
    const a = anchor();
    const cancelled = member('cancelled-resolved', { scheduled_date: '2026-10-01', status: 'cancelled', has_own_live_invoice: true });
    const verdict = evaluateGroupDivergence({ anchor: a, members: [a, cancelled], invoiceStatus: 'sent' });
    expect(verdict).toEqual({ action: 'clear', reason: 'split_completed' });
  });

  test('a cancelled sibling never triggers a plain "realigned" clear — always split_completed once resolved', () => {
    const a = anchor();
    // Cancelled same-day, but resolved (own live invoice) — even though it
    // never diverged by date, the reason must say something WAS resolved,
    // never the misleading "realigned" (there was never a date mismatch to
    // realign).
    const cancelled = member('c', { scheduled_date: '2026-10-01', status: 'cancelled', has_own_live_invoice: true });
    const verdict = evaluateGroupDivergence({ anchor: a, members: [a, cancelled], invoiceStatus: 'sent' });
    expect(verdict.reason).toBe('split_completed');
  });

  test('a genuinely diverged-then-cancelled sibling and a plain diverged sibling are both reported together', () => {
    const a = anchor();
    const cancelled = member('cancelled', { scheduled_date: '2026-10-09', status: 'cancelled' });
    const moved = member('moved', { scheduled_date: '2026-10-12' });
    const verdict = evaluateGroupDivergence({ anchor: a, members: [a, cancelled, moved], invoiceStatus: 'sent' });
    expect(verdict.action).toBe('alert');
    expect(verdict.diverging.map((m) => m.id).sort()).toEqual(['cancelled', 'moved']);
  });

  // Codex P1 (PR #5021 r8): 'skipped' and 'no_show' are equally terminal,
  // equally never-serviced statuses (scheduled_services.status CHECK
  // constraint, AGENTS.md) and must be covered exactly like 'cancelled' —
  // never excluded from divergence detection just because they aren't the
  // one status this module originally handled.
  test.each(['skipped', 'no_show'])('a %s sibling that NEVER diverged by date still alerts', (status) => {
    const a = anchor();
    const neverRanSibling = member('never-ran-same-day', { scheduled_date: '2026-10-01', status });
    const verdict = evaluateGroupDivergence({ anchor: a, members: [a, neverRanSibling], invoiceStatus: 'sent' });
    expect(verdict.action).toBe('alert');
    expect(verdict.diverging.map((m) => m.id)).toEqual(['never-ran-same-day']);
  });

  test.each(['skipped', 'no_show'])('a %s sibling with its OWN live invoice already → clear, split_completed', (status) => {
    const a = anchor();
    const resolved = member('resolved', { scheduled_date: '2026-10-01', status, has_own_live_invoice: true });
    const verdict = evaluateGroupDivergence({ anchor: a, members: [a, resolved], invoiceStatus: 'sent' });
    expect(verdict).toEqual({ action: 'clear', reason: 'split_completed' });
  });

  // A still-active status (confirmed, en_route, on_site, rescheduled,
  // pending) must never be swept into the never-ran bucket — only a
  // genuinely diverging OR never-ran member gets flagged.
  test.each(['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'])(
    'a sibling with active status %s and no date divergence is never flagged',
    (status) => {
      const a = anchor();
      const active = member('active', { scheduled_date: '2026-10-01', status });
      const verdict = evaluateGroupDivergence({ anchor: a, members: [a, active], invoiceStatus: 'sent' });
      expect(verdict).toEqual({ action: 'clear', reason: 'realigned' });
    },
  );
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

  // Codex P1 (PR #5021 r7): a member going diverged→cancelled (or a
  // cancelled member gaining its own live invoice — resolved) is a genuine
  // state change and must reopen a dismissed alert on its own, never rely
  // on the incidental body-text diff to trigger a refresh.
  test('a member becoming cancelled (same date, same invoice) changes the fingerprint', () => {
    const fp1 = divergenceStateFingerprint({ anchor: a, diverging: [b], invoiceId: 'inv-1', invoiceTotal: 100 });
    const bCancelled = member('b', { scheduled_date: '2026-10-05', status: 'cancelled' });
    const fp2 = divergenceStateFingerprint({ anchor: a, diverging: [bCancelled], invoiceId: 'inv-1', invoiceTotal: 100 });
    expect(fp1).not.toBe(fp2);
  });

  // Codex P1 (PR #5021 r8): widened from 'cancelled' alone to every
  // never-ran status — skipped/no_show must be just as fingerprint-visible.
  test.each(['skipped', 'no_show'])('a member becoming %s (same date, same invoice) changes the fingerprint', (status) => {
    const fp1 = divergenceStateFingerprint({ anchor: a, diverging: [b], invoiceId: 'inv-1', invoiceTotal: 100 });
    const bNeverRan = member('b', { scheduled_date: '2026-10-05', status });
    const fp2 = divergenceStateFingerprint({ anchor: a, diverging: [bNeverRan], invoiceId: 'inv-1', invoiceTotal: 100 });
    expect(fp1).not.toBe(fp2);
  });

  // Every never-ran status buckets to the SAME fingerprint value — moving
  // between two never-ran statuses (a real but rare transition) still
  // registers as unchanged here; that's fine, since neither state needs a
  // fresh alert. What must never happen is treating an ACTIVE lifecycle
  // change (confirmed → en_route → on_site) as fingerprint-significant —
  // that's pure visit-lifecycle noise for an otherwise-unresolved diverging
  // member, never a real change in the billing conflict.
  test('active-status churn (confirmed → en_route → on_site) never changes the fingerprint on its own', () => {
    const fp1 = divergenceStateFingerprint({ anchor: a, diverging: [b], invoiceId: 'inv-1', invoiceTotal: 100 });
    for (const status of ['en_route', 'on_site', 'rescheduled', 'pending']) {
      const bActive = member('b', { scheduled_date: '2026-10-05', status });
      expect(divergenceStateFingerprint({ anchor: a, diverging: [bActive], invoiceId: 'inv-1', invoiceTotal: 100 })).toBe(fp1);
    }
  });
});

// groupCandidatesByEstimate is a PLAIN grouping, never a pick-one filter
// (Codex history on heads 3681fe5c5e and daf724131f: "prefer live over
// settled, newest wins" and "only the group's earliest live invoice" were
// both tried and both broke on a real multi-anchor scenario — see the
// module header). evaluateEstimateCandidates evaluates every row in each
// group together instead.
describe('groupCandidatesByEstimate', () => {
  const row = (over = {}) => ({
    source_estimate_id: 'est-1', invoice_status: 'draft', invoice_created_at: '2026-09-01T00:00:00Z', ...over,
  });

  test('a single row per estimate becomes a group of one', () => {
    const r = row();
    expect(groupCandidatesByEstimate([r])).toEqual([[r]]);
  });

  test('multiple rows for the same estimate stay grouped together, in order', () => {
    const a = row({ invoice_id: 'a' });
    const b = row({ invoice_id: 'b', invoice_status: 'void' });
    expect(groupCandidatesByEstimate([a, b])).toEqual([[a, b]]);
  });

  test('rows for different estimates are kept in separate groups', () => {
    const a1 = row({ source_estimate_id: 'est-a', invoice_id: 'a' });
    const b1 = row({ source_estimate_id: 'est-b', invoice_id: 'b' });
    expect(groupCandidatesByEstimate([a1, b1])).toEqual([[a1], [b1]]);
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

// Codex P2 (PR #5021 r7): bound the FRESH structural sweep in fair,
// wrapping keyset batches so no single tick runs unbounded and no
// candidate is starved behind an always-same head of the list. Never
// applies to established-anchor groups (see runSweepInner) — this is
// purely the fresh-candidate pagination helper.
describe('selectFreshBatch', () => {
  const freshGroup = (estimateId) => [{ source_estimate_id: estimateId, candidate_source: 'fresh' }];
  // Sorted ascending, exactly like loadCandidates' own ORDER BY.
  const ids = Array.from({ length: FRESH_BATCH_LIMIT + 50 }, (_, i) => `est-${String(i).padStart(4, '0')}`);
  const groups = ids.map(freshGroup);

  test('at or under the limit, every group is returned untouched regardless of cursor', () => {
    const small = groups.slice(0, FRESH_BATCH_LIMIT);
    expect(selectFreshBatch(small, null)).toBe(small);
    expect(selectFreshBatch(small, 'est-0005')).toBe(small);
  });

  test('over the limit with no cursor, starts from the beginning', () => {
    const batch = selectFreshBatch(groups, null);
    expect(batch).toHaveLength(FRESH_BATCH_LIMIT);
    expect(batch[0][0].source_estimate_id).toBe(ids[0]);
    expect(batch[batch.length - 1][0].source_estimate_id).toBe(ids[FRESH_BATCH_LIMIT - 1]);
  });

  test('resumes strictly after the cursor', () => {
    const cursor = ids[10];
    const batch = selectFreshBatch(groups, cursor);
    expect(batch[0][0].source_estimate_id).toBe(ids[11]);
    expect(batch).toHaveLength(FRESH_BATCH_LIMIT);
  });

  test('wraps around to the start once the cursor is near the end — nothing is starved forever', () => {
    const cursor = ids[ids.length - 5];
    const batch = selectFreshBatch(groups, cursor);
    expect(batch).toHaveLength(FRESH_BATCH_LIMIT);
    // The last 4 ids, then wraps to the beginning.
    expect(batch.slice(0, 4).map((g) => g[0].source_estimate_id)).toEqual(ids.slice(ids.length - 4));
    expect(batch[4][0].source_estimate_id).toBe(ids[0]);
  });

  test('a cursor for an estimate no longer present (evaluated then resolved) still resumes from the next-highest id', () => {
    const withoutTen = groups.filter((g) => g[0].source_estimate_id !== ids[10]);
    const batch = selectFreshBatch(withoutTen, ids[10]);
    expect(batch[0][0].source_estimate_id).toBe(ids[11]);
  });

  test('a cursor past every remaining id wraps to the start', () => {
    const batch = selectFreshBatch(groups, ids[ids.length - 1]);
    expect(batch[0][0].source_estimate_id).toBe(ids[0]);
  });
});
