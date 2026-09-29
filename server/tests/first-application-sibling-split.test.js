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
  neverRanCoveredMembers,
  buildDivergenceAlertCopy,
  divergenceStateFingerprint,
  resolveGoverningInvoice,
  groupCandidatesByInvoice,
  isInvoiceSettled,
  isInvoicePaid,
  isInvoicePaymentPending,
  PAID_INVOICE_STATUSES,
  dateOnly,
  SETTLED_INVOICE_STATUSES,
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

// P1-C: the PAID (collected) subset of SETTLED_INVOICE_STATUSES —
// void/refunded/canceled/cancelled never collected outstanding money (or
// already gave it back), so isInvoicePaid must be false for them even
// though isInvoiceSettled is true for the whole set.
describe('isInvoicePaid', () => {
  test('paid/prepaid are paid', () => {
    expect([...PAID_INVOICE_STATUSES].sort()).toEqual(['paid', 'prepaid']);
    for (const status of PAID_INVOICE_STATUSES) {
      expect(isInvoicePaid(status)).toBe(true);
    }
  });

  // Codex round 14 P1: 'processing' is an ACH debit still in flight — settled
  // for collection, but NOT collected money (it can still bounce).
  test("'processing' is settled and payment-pending, but NOT paid", () => {
    expect(isInvoiceSettled('processing')).toBe(true);
    expect(isInvoicePaid('processing')).toBe(false);
    expect(isInvoicePaymentPending('processing')).toBe(true);
    for (const status of ['paid', 'prepaid', 'sent', 'void']) {
      expect(isInvoicePaymentPending(status)).toBe(false);
    }
  });

  test('void/refunded/canceled/cancelled are settled but NOT paid', () => {
    for (const status of ['void', 'refunded', 'canceled', 'cancelled']) {
      expect(isInvoiceSettled(status)).toBe(true);
      expect(isInvoicePaid(status)).toBe(false);
    }
  });

  test('an open status (draft/sent) is neither settled nor paid', () => {
    for (const status of ['draft', 'sent']) {
      expect(isInvoicePaid(status)).toBe(false);
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

// neverRanCoveredMembers is the shared pure helper (P1-C) behind BOTH
// evaluateGroupDivergence's open-invoice branch (neverRanNeedingReview) AND
// its new paid-invoice branch (paid_never_ran) — same membership question
// ("which covered members will never run and haven't been split off yet")
// regardless of the invoice's settlement state.
describe('neverRanCoveredMembers', () => {
  test.each(['cancelled', 'skipped', 'no_show'])('a %s member with no own live invoice is returned', (status) => {
    const a = anchor();
    const m = member('m', { status });
    expect(neverRanCoveredMembers(a, [a, m]).map((x) => x.id)).toEqual(['m']);
  });

  test('a never-ran member WITH its own live invoice is excluded — already hand-split', () => {
    const a = anchor();
    const m = member('m', { status: 'cancelled', has_own_live_invoice: true });
    expect(neverRanCoveredMembers(a, [a, m])).toEqual([]);
  });

  test.each(['confirmed', 'pending', 'en_route', 'on_site', 'rescheduled'])('an active member (status %s) is excluded', (status) => {
    const a = anchor();
    const m = member('m', { status });
    expect(neverRanCoveredMembers(a, [a, m])).toEqual([]);
  });

  test('a completed member is excluded — completed is never a never-ran status', () => {
    const a = anchor();
    const m = member('m', { status: 'completed', completed_at: new Date('2026-10-01') });
    expect(neverRanCoveredMembers(a, [a, m])).toEqual([]);
  });

  test('the anchor itself is never returned by default, even if its own status is never-ran', () => {
    const a = anchor({ status: 'cancelled' });
    const m = member('m', { status: 'confirmed' });
    expect(neverRanCoveredMembers(a, [a, m])).toEqual([]);
  });

  // Codex round 14 P1 (paid/processing review): the combined invoice bills
  // the anchor's own share too, so a never-ran anchor is returned — and no
  // invoice on the anchor counts as "split off", since the combined invoice
  // sits on the anchor's own id.
  test('includeAnchor: a never-ran anchor is returned, even with has_own_live_invoice', () => {
    const a = anchor({ status: 'cancelled', has_own_live_invoice: true });
    const m = member('m', { status: 'confirmed' });
    expect(neverRanCoveredMembers(a, [a, m], { includeAnchor: true }).map((x) => x.id)).toEqual(['anchor-1']);
  });

  test('includeAnchor: an active anchor is still excluded, and siblings keep their own split rule', () => {
    const a = anchor({ status: 'confirmed' });
    const split = member('split', { status: 'cancelled', has_own_live_invoice: true });
    const unsplit = member('unsplit', { status: 'skipped' });
    expect(neverRanCoveredMembers(a, [a, split, unsplit], { includeAnchor: true }).map((x) => x.id)).toEqual(['unsplit']);
  });

  test('multiple never-ran members are all returned, active/resolved ones excluded', () => {
    const a = anchor();
    const cancelled = member('cancelled', { status: 'cancelled' });
    const noShow = member('no-show', { status: 'no_show' });
    const resolved = member('resolved', { status: 'skipped', has_own_live_invoice: true });
    const active = member('active', { status: 'confirmed' });
    const result = neverRanCoveredMembers(a, [a, cancelled, noShow, resolved, active]).map((x) => x.id).sort();
    expect(result).toEqual(['cancelled', 'no-show']);
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

  // Renamed (P1-C follow-up): this test's own fixture only ever exercises
  // an ACTIVE diverging member (default status 'confirmed') — that
  // contract is still true (a paid invoice clears when nothing covered by
  // it is never-ran), but the old name's blanket "no alert" claim no
  // longer holds for every paid invoice — see the 'paid_never_ran' P1-C
  // block below for the exception (a covered member that will never run).
  test('paid invoice + an ACTIVE diverging member (not never-ran) → no alert, even though it still diverges', () => {
    const a = anchor();
    const b = member('b', { scheduled_date: '2026-10-05' });
    const verdict = evaluateGroupDivergence({ anchor: a, members: [a, b], invoiceStatus: 'paid' });
    expect(verdict).toEqual({ action: 'clear', reason: 'invoice_settled' });
  });

  // CONTRACT (Codex round 14, PR #5021): clearing a PAID group whose active
  // members merely diverged is safe only because the shared lookup
  // (findFirstApplicationInvoiceForEstimateService) now finds the combined
  // invoice by the member's stamp, so completing or charging the moved
  // sibling reuses the paid invoice instead of minting a second charge —
  // estimate-first-application-invoice.test.js and the PG suite pin that
  // side. No alert is added for paid-but-diverged active members.
  test.each(['paid', 'prepaid', 'processing'])('contract: %s + every active member diverged (money safe via the stamp-aware lookup) → clear, no alert', (status) => {
    const a = anchor();
    const moved = member('moved', { scheduled_date: '2026-10-20', estimated_price: null });
    const completedMoved = member('completed-moved', { scheduled_date: '2026-10-22', status: 'completed', completed_at: new Date('2026-10-22') });
    const verdict = evaluateGroupDivergence({ anchor: a, members: [a, moved, completedMoved], invoiceStatus: status });
    expect(verdict).toEqual({ action: 'clear', reason: 'invoice_settled' });
  });

  // -------------------------------------------------------------------
  // P1-C (Codex round 13 on PR #5021): a PAID (collected) governing
  // invoice does not clear unconditionally any more — a stamped member
  // that invoice's payment covers, but that will never run (cancelled/
  // skipped/no-show) and has no own live invoice, needs a refund/credit
  // alert instead of silently clearing.
  // -------------------------------------------------------------------
  describe('paid_never_ran (P1-C)', () => {
    test.each(['paid', 'prepaid'])('%s invoice + one never-ran covered member, no own live invoice → alert naming that member', (status) => {
      const a = anchor();
      const cancelled = member('cancelled-covered', { status: 'cancelled' });
      const verdict = evaluateGroupDivergence({ anchor: a, members: [a, cancelled], invoiceStatus: status });
      expect(verdict.action).toBe('alert');
      expect(verdict.reason).toBe('paid_never_ran');
      expect(verdict.diverging.map((m) => m.id)).toEqual(['cancelled-covered']);
    });

    test.each(['paid', 'prepaid', 'processing'])('%s invoice + every member still active → clear (nothing never-ran)', (status) => {
      const a = anchor();
      const b = member('b', { scheduled_date: '2026-10-05', status: 'confirmed' });
      const verdict = evaluateGroupDivergence({ anchor: a, members: [a, b], invoiceStatus: status });
      expect(verdict).toEqual({ action: 'clear', reason: 'invoice_settled' });
    });

    // A never-ran member that ALREADY has its own live invoice has been
    // hand-split off — no refund/credit alert needed for it.
    test('paid invoice + never-ran member WITH its own live invoice → clear, not alert', () => {
      const a = anchor();
      const cancelled = member('cancelled-resolved', { status: 'cancelled', has_own_live_invoice: true });
      const verdict = evaluateGroupDivergence({ anchor: a, members: [a, cancelled], invoiceStatus: 'paid' });
      expect(verdict).toEqual({ action: 'clear', reason: 'invoice_settled' });
    });

    // The uncollectible vocabulary (void/refunded/canceled/cancelled) never
    // collected outstanding money, or already gave it back — a covered
    // never-ran member needs no refund/credit action there, unlike the
    // PAID/PREPAID/PROCESSING case above. Keeps clearing unconditionally.
    test.each(['void', 'refunded', 'canceled', 'cancelled'])('%s invoice + a never-ran covered member → clear, never a refund alert', (status) => {
      const a = anchor();
      const cancelled = member('cancelled-covered', { status: 'cancelled' });
      const verdict = evaluateGroupDivergence({ anchor: a, members: [a, cancelled], invoiceStatus: status });
      expect(verdict).toEqual({ action: 'clear', reason: 'invoice_settled' });
    });

    // Codex round 14 P1: a cancelled/skipped/no-show ANCHOR on a paid
    // combined invoice holds money for work that will not happen too.
    test.each(['cancelled', 'skipped', 'no_show'])('paid invoice + %s ANCHOR (sibling active) → alert naming the anchor', (status) => {
      const a = anchor({ status });
      const b = member('b', { status: 'confirmed' });
      const verdict = evaluateGroupDivergence({ anchor: a, members: [a, b], invoiceStatus: 'paid' });
      expect(verdict.action).toBe('alert');
      expect(verdict.reason).toBe('paid_never_ran');
      expect(verdict.diverging.map((m) => m.id)).toEqual(['anchor-1']);
    });

    test('paid invoice + cancelled anchor WITH a separate live invoice on it → still alerts (the combined charge never moved)', () => {
      const a = anchor({ status: 'cancelled', has_own_live_invoice: true });
      const b = member('b', { status: 'completed', completed_at: new Date('2026-10-01') });
      const verdict = evaluateGroupDivergence({ anchor: a, members: [a, b], invoiceStatus: 'paid' });
      expect(verdict.reason).toBe('paid_never_ran');
      expect(verdict.diverging.map((m) => m.id)).toEqual(['anchor-1']);
    });

    // Codex round 19 P2: voidOpenInvoicesForCancelledService (job-status.js)
    // is fired-and-forget off the anchor's own cancel/skip/no-show — when it
    // fails, a still-OPEN combined invoice keeps charging for an anchor that
    // will never run. The open-invoice review now includes the anchor the
    // same way the paid/processing one already does, so this case raises
    // (or keeps) the alert instead of silently reading the group as
    // realigned.
    test.each(['cancelled', 'skipped', 'no_show'])('an OPEN invoice with a %s anchor (sibling active) → alert naming the anchor', (status) => {
      const a = anchor({ status });
      const b = member('b', { status: 'confirmed' });
      const verdict = evaluateGroupDivergence({ anchor: a, members: [a, b], invoiceStatus: 'sent' });
      expect(verdict.action).toBe('alert');
      expect(verdict.reason).toBe('diverged');
      expect(verdict.diverging.map((m) => m.id)).toEqual(['anchor-1']);
    });

    test('an OPEN invoice with a cancelled anchor WITH a separate live invoice on it → still alerts (the combined charge never moved)', () => {
      const a = anchor({ status: 'cancelled', has_own_live_invoice: true });
      const b = member('b', { status: 'confirmed' });
      const verdict = evaluateGroupDivergence({ anchor: a, members: [a, b], invoiceStatus: 'sent' });
      expect(verdict.action).toBe('alert');
      expect(verdict.reason).toBe('diverged');
      expect(verdict.diverging.map((m) => m.id)).toEqual(['anchor-1']);
    });

    test('an OPEN invoice, anchor back to an active status, no other divergence → clear, realigned (unaffected by the anchor fix)', () => {
      // An anchor that is NOT currently never-ran can never reach the alert
      // branch through neverRanCoveredMembers, whatever its status history —
      // the verdict is purely a function of current state. This pins that
      // the round 19 P2 fix only widens the ALERT case and leaves an
      // ordinary aligned, active group clearing exactly as before.
      const a = anchor({ status: 'confirmed' });
      const b = member('b', { status: 'confirmed' });
      const verdict = evaluateGroupDivergence({ anchor: a, members: [a, b], invoiceStatus: 'sent' });
      expect(verdict).toEqual({ action: 'clear', reason: 'realigned' });
    });

    test.each(['skipped', 'no_show'])('paid invoice + a %s covered member behaves exactly like cancelled → alert', (neverRanStatus) => {
      const a = anchor();
      const m = member('m', { status: neverRanStatus });
      const verdict = evaluateGroupDivergence({ anchor: a, members: [a, m], invoiceStatus: 'paid' });
      expect(verdict.action).toBe('alert');
      expect(verdict.reason).toBe('paid_never_ran');
      expect(verdict.diverging.map((d) => d.id)).toEqual(['m']);
    });

    // Diverged-by-date is irrelevant to this verdict — it fires purely off
    // never-ran status + no own live invoice, same-day or not.
    test('a never-ran member that ALSO diverged by date is still covered by the paid_never_ran verdict', () => {
      const a = anchor();
      const cancelled = member('cancelled-moved', { scheduled_date: '2026-11-20', status: 'cancelled' });
      const verdict = evaluateGroupDivergence({ anchor: a, members: [a, cancelled], invoiceStatus: 'prepaid' });
      expect(verdict.action).toBe('alert');
      expect(verdict.reason).toBe('paid_never_ran');
      expect(verdict.diverging.map((d) => d.id)).toEqual(['cancelled-moved']);
    });
  });

  // Codex round 14 P1: 'processing' is an ACH debit still in flight — the
  // money is not collected yet, so never "refund or credit" copy.
  describe('payment_pending_never_ran', () => {
    test('processing invoice + one never-ran covered member → pending alert naming that member', () => {
      const a = anchor();
      const cancelled = member('cancelled-covered', { status: 'cancelled' });
      const verdict = evaluateGroupDivergence({ anchor: a, members: [a, cancelled], invoiceStatus: 'processing' });
      expect(verdict).toEqual({ action: 'alert', reason: 'payment_pending_never_ran', diverging: [cancelled] });
    });

    test('processing invoice + cancelled anchor → pending alert naming the anchor', () => {
      const a = anchor({ status: 'cancelled' });
      const b = member('b', { status: 'confirmed' });
      const verdict = evaluateGroupDivergence({ anchor: a, members: [a, b], invoiceStatus: 'processing' });
      expect(verdict.reason).toBe('payment_pending_never_ran');
      expect(verdict.diverging.map((m) => m.id)).toEqual(['anchor-1']);
    });

    test('transitions: processing → paid switches to paid_never_ran; → refunded/void clears; member reactivated clears', () => {
      const a = anchor();
      const cancelled = member('c', { status: 'cancelled' });
      expect(evaluateGroupDivergence({ anchor: a, members: [a, cancelled], invoiceStatus: 'paid' }).reason).toBe('paid_never_ran');
      for (const status of ['refunded', 'void']) {
        expect(evaluateGroupDivergence({ anchor: a, members: [a, cancelled], invoiceStatus: status }))
          .toEqual({ action: 'clear', reason: 'invoice_settled' });
      }
      const reactivated = member('c', { status: 'confirmed' });
      expect(evaluateGroupDivergence({ anchor: a, members: [a, reactivated], invoiceStatus: 'processing' }))
        .toEqual({ action: 'clear', reason: 'invoice_settled' });
    });

    test('a bounced ACH (back to an open status) falls into the ordinary open-invoice review', () => {
      const a = anchor();
      const cancelled = member('c', { status: 'cancelled' });
      const verdict = evaluateGroupDivergence({ anchor: a, members: [a, cancelled], invoiceStatus: 'sent' });
      expect(verdict.reason).toBe('diverged');
    });
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

// buildDivergenceAlertCopy is the pure copy-builder extracted out of
// raiseDivergenceAlert — covers both the ordinary 'diverged' alert copy
// (unchanged) and the new 'paid_never_ran' copy (P1-C), which must name
// that the invoice was already paid and say to refund or credit the
// member's share, never "remove that charge" (that phrase is for a
// still-open invoice only).
describe('buildDivergenceAlertCopy', () => {
  const anchorDate = '2026-10-01';

  test("paid_never_ran: mentions the invoice was already paid, and says to refund or credit — never 'remove that charge'", () => {
    const cancelled = member('cancelled-covered', { status: 'cancelled' });
    const { detail, leadSentence, actionSentence } = buildDivergenceAlertCopy({
      diverging: [cancelled], anchorDate, alertKind: 'paid_never_ran',
    });
    expect(leadSentence.toLowerCase()).toContain('already been paid');
    expect(actionSentence.toLowerCase()).toMatch(/refund or credit/);
    expect(detail).toContain('refund or credit its share of the already-paid invoice');
    expect(detail).not.toContain('remove its charge from the combined invoice');
    expect(actionSentence).not.toContain('remove that charge');
    expect(actionSentence).not.toContain('split it by hand');
  });

  test.each(['skipped', 'no_show'])("paid_never_ran with a %s member says the same refund/credit action", (status) => {
    const m = member('m', { status });
    const { actionSentence } = buildDivergenceAlertCopy({ diverging: [m], anchorDate, alertKind: 'paid_never_ran' });
    expect(actionSentence.toLowerCase()).toMatch(/refund or credit/);
  });

  // The ordinary (still-open-invoice) copy is byte-identical to before —
  // P1-C's new branch must never leak into the default alertKind.
  test("the ordinary 'diverged' never-ran copy is unchanged — still says remove the charge, never refund/credit", () => {
    const cancelled = member('cancelled-covered', { status: 'cancelled' });
    const { detail, leadSentence, actionSentence } = buildDivergenceAlertCopy({
      diverging: [cancelled], anchorDate, alertKind: 'diverged',
    });
    expect(leadSentence).toBe('A same-trip visit from one estimate will not be serviced');
    expect(actionSentence).toBe('The combined first-application invoice still charges for it — remove that charge.');
    expect(detail).toContain('remove its charge from the combined invoice');
    expect(detail).not.toMatch(/refund or credit/);
    expect(leadSentence.toLowerCase()).not.toContain('already been paid');
  });

  test("the ordinary 'diverged' copy for a plain MOVED (not never-ran) member is unchanged — 'split it by hand'", () => {
    const moved = member('moved', { scheduled_date: '2026-10-09' });
    const { leadSentence, actionSentence, detail } = buildDivergenceAlertCopy({
      diverging: [moved], anchorDate, alertKind: 'diverged',
    });
    expect(leadSentence).toBe('Same-trip visits from one estimate landed on different days');
    expect(actionSentence).toBe('The combined first-application invoice still charges for both — split it by hand.');
    expect(detail).toContain(`visit ${moved.id} now on 2026-10-09 (was ${anchorDate})`);
  });

  // Tender-neutral (Codex r17 P2 on #5021): 'processing' is not only an ACH
  // debit — a card / Terminal / saved-card attempt parked for reconciliation
  // reads the same, so the copy never names ACH.
  test("payment_pending_never_ran: says the payment is still processing and to wait — never 'refund or credit' now, never 'ACH'", () => {
    const cancelled = member('cancelled-covered', { status: 'cancelled' });
    const { detail, leadSentence, actionSentence } = buildDivergenceAlertCopy({
      diverging: [cancelled], anchorDate, alertKind: 'payment_pending_never_ran',
    });
    expect(leadSentence).toContain('payment is still processing (not yet settled or reconciled)');
    expect(actionSentence).toMatch(/^Wait for that payment to settle, fail, or be reconciled before refunding or crediting/);
    expect(detail).toContain(`visit ${cancelled.id} was cancelled — its share is part of a payment that is still processing`);
    expect(`${leadSentence} ${actionSentence} ${detail}`).not.toMatch(/\bACH\b/);
    for (const text of [detail, leadSentence, actionSentence]) {
      expect(text).not.toMatch(/refund or credit/);
      expect(text).not.toContain('already been paid');
      expect(text).not.toContain('remove that charge');
    }
  });

  test('defaults to the ordinary diverged copy when alertKind is omitted', () => {
    const cancelled = member('cancelled-covered', { status: 'cancelled' });
    const { actionSentence } = buildDivergenceAlertCopy({ diverging: [cancelled], anchorDate });
    expect(actionSentence).toBe('The combined first-application invoice still charges for it — remove that charge.');
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

// resolveGoverningInvoice: which invoice actually governs a group's
// settlement/alerting right now, given the STAMPED invoice and every OTHER
// live invoice already found on the anchor's own scheduled_service_id
// (newest-first — see evaluateEstimateCandidates). Owner ruling 2026-09-27
// / Codex round 7 P1: the stamp is never rewritten, so once the stamped
// invoice goes terminal a live replacement must take over governance
// instead of letting the dead stamped row keep clearing the alert. Codex
// round-9 P1: governance is durable-evidence-only (the scheduled_service_id
// linkage) with NO title/notes text recognition — InvoiceService.update
// lets a live replacement's title/notes be edited on an unpaid invoice, so
// text recognition let a renamed replacement fall back to the dead stamped
// invoice and silently clear a still-diverged, still-charging pair. This
// alert is advisory: the office needs to look regardless of what the
// anchor's live invoice turns out to be, so ANY live invoice on the anchor
// governs — even one that looks completely unrelated.
describe('resolveGoverningInvoice', () => {
  // A replacement carries DURABLE base-application evidence: a positive line
  // tagged client_id `scheduled_<id>_primary` (what every service mint writes)
  // — not editable title/notes text (Codex r18 P1).
  const liveInvoice = (over = {}) => ({
    id: 'replacement-1',
    status: 'sent',
    title: 'First Service Application',
    notes: 'Auto-generated from accepted estimate #est-1. Customer selected pay per application — first application only.',
    line_items: [{ client_id: 'scheduled_anchor-1_primary', description: 'First service application', quantity: 1, unit_price: 153.6, amount: 153.6 }],
    ...over,
  });
  // An unrelated hand invoice on the same visit: no base-application line.
  const handInvoice = (over = {}) => ({
    id: 'hand-invoice-1', status: 'sent', title: 'Repair charge', notes: 'A one-off hand invoice for a broken sprinkler head.',
    line_items: [{ description: 'Sprinkler head repair', quantity: 1, unit_price: 45, amount: 45 }],
    ...over,
  });

  test('an OPEN stamped invoice always governs itself — never looks at any live invoice on the anchor', () => {
    const stamped = { id: 'stamped-1', status: 'sent' };
    expect(resolveGoverningInvoice(stamped, [liveInvoice()])).toBe(stamped);
  });

  test('a terminal (void) stamped invoice with a live invoice on the anchor → that invoice governs', () => {
    const stamped = { id: 'stamped-1', status: 'void' };
    const replacement = liveInvoice();
    expect(resolveGoverningInvoice(stamped, [replacement])).toBe(replacement);
  });

  test.each(['void', 'refunded', 'canceled', 'cancelled'])('every terminal status (%s) looks for a live invoice on the anchor', (status) => {
    const stamped = { id: 'stamped-1', status };
    const replacement = liveInvoice();
    expect(resolveGoverningInvoice(stamped, [replacement])).toBe(replacement);
  });

  test('a terminal stamped invoice with NO live invoice on the anchor → governs itself (today\'s behavior)', () => {
    const stamped = { id: 'stamped-1', status: 'void' };
    expect(resolveGoverningInvoice(stamped, [])).toBe(stamped);
    expect(resolveGoverningInvoice(stamped, null)).toBe(stamped);
  });

  // Codex round-9 P1 removed TEXT recognition here; Codex r18 P1 requires
  // DURABLE evidence instead: a live anchor invoice governs (and can drive a
  // refund instruction) only when a positive line bills the base
  // application (client_id `scheduled_<id>_primary` / "First service
  // application"). An unrelated hand invoice — a repair, a one-off charge —
  // never becomes "the combined invoice"; with no qualifying replacement the
  // terminal stamped invoice governs itself.
  test('an unrelated hand invoice on the anchor (no base-application line) never governs — the terminal stamped invoice does', () => {
    const stamped = { id: 'stamped-1', status: 'void' };
    expect(resolveGoverningInvoice(stamped, [handInvoice()])).toBe(stamped);
  });

  test('a RENAMED replacement (hand-looking title/notes) that carries a base-application line still governs — evidence is the line, not the text', () => {
    const stamped = { id: 'stamped-1', status: 'void' };
    const renamed = liveInvoice({ id: 'renamed-1', title: 'Custom title', notes: 'Edited by the office.' });
    expect(resolveGoverningInvoice(stamped, [renamed])).toBe(renamed);
  });

  test('base-application evidence works from a JSON-string line_items column too', () => {
    const stamped = { id: 'stamped-1', status: 'void' };
    const asString = liveInvoice({ line_items: JSON.stringify(liveInvoice().line_items) });
    expect(resolveGoverningInvoice(stamped, [asString])).toBe(asString);
  });

  // Codex round 14 P1: the NEWEST live invoice is not necessarily the one
  // still charging the group — a newer, unrelated, already-paid invoice on
  // the same visit must never hide an older, still-collectible replacement.
  describe('several live invoices on the anchor (Codex round 14 P1)', () => {
    const stamped = { id: 'stamped-1', status: 'void' };
    const olderSent = liveInvoice({ id: 'older-sent', status: 'sent', created_at: '2026-10-02T10:00:00Z' });
    const newerPaid = liveInvoice({ id: 'newer-paid', status: 'paid', created_at: '2026-10-05T10:00:00Z' });
    const olderPaid = liveInvoice({ id: 'older-paid', status: 'paid', created_at: '2026-10-02T10:00:00Z' });
    const newerSent = liveInvoice({ id: 'newer-sent', status: 'sent', created_at: '2026-10-05T10:00:00Z' });

    test('older collectible + newer paid → the older collectible governs, whatever the array order', () => {
      expect(resolveGoverningInvoice(stamped, [newerPaid, olderSent])).toBe(olderSent);
      expect(resolveGoverningInvoice(stamped, [olderSent, newerPaid])).toBe(olderSent);
    });

    test('older paid + newer collectible → the newer collectible governs, whatever the array order', () => {
      expect(resolveGoverningInvoice(stamped, [newerSent, olderPaid])).toBe(newerSent);
      expect(resolveGoverningInvoice(stamped, [olderPaid, newerSent])).toBe(newerSent);
    });

    test('two collectible → the OLDEST collectible governs', () => {
      expect(resolveGoverningInvoice(stamped, [newerSent, olderSent])).toBe(olderSent);
    });

    test.each(['paid', 'prepaid', 'processing'])('every live invoice settled (%s) → the NEWEST settled governs', (status) => {
      const older = liveInvoice({ id: 'older', status, created_at: '2026-10-02T10:00:00Z' });
      const newer = liveInvoice({ id: 'newer', status, created_at: '2026-10-05T10:00:00Z' });
      expect(resolveGoverningInvoice(stamped, [older, newer])).toBe(newer);
    });

    test('rows without created_at keep the caller\'s newest-first order', () => {
      const first = liveInvoice({ id: 'first', status: 'paid' });
      const second = liveInvoice({ id: 'second', status: 'paid' });
      expect(resolveGoverningInvoice(stamped, [first, second])).toBe(first);
      const collectibleA = liveInvoice({ id: 'a' });
      const collectibleB = liveInvoice({ id: 'b' });
      expect(resolveGoverningInvoice(stamped, [collectibleA, collectibleB])).toBe(collectibleB);
    });
  });
});

// groupCandidatesByInvoice groups stamped MEMBER rows by the invoice they
// carry (first_application_invoice_id) — owner ruling 2026-09-27: the
// stamp makes membership durable and unambiguous, replacing the old
// groupCandidatesByEstimate's estimate-keyed grouping (which existed only
// because the old design could find MORE THAN ONE structurally-eligible
// invoice row for the same estimate). A group of exactly one — a stray
// single stamp, should never happen given the converter's own 2+-only
// stamping guarantee at stamp time, but reachable afterward if an operator
// NULLs a partner's stamp by hand — is KEPT, not dropped (Codex round-11
// P2 on PR #5021): dropping it here meant evaluateEstimateCandidates'
// fresh-re-read "< 2 members -> clear" branch never got a turn to run, so
// a standing alert for that estimate could never auto-clear.
describe('groupCandidatesByInvoice', () => {
  const row = (over = {}) => ({
    invoice_id: 'inv-1', source_estimate_id: 'est-1', status: 'confirmed', ...over,
  });

  test('a single stamped row with no partner is kept as a group of one, not dropped', () => {
    const solo = row({ id: 'solo' });
    expect(groupCandidatesByInvoice([solo])).toEqual([[solo]]);
  });

  test('two rows stamped with the same invoice stay grouped together, in order', () => {
    const a = row({ id: 'a' });
    const b = row({ id: 'b', status: 'confirmed' });
    expect(groupCandidatesByInvoice([a, b])).toEqual([[a, b]]);
  });

  test('rows stamped with different invoices are kept in separate groups', () => {
    const a1 = row({ id: 'a1', invoice_id: 'inv-a' });
    const a2 = row({ id: 'a2', invoice_id: 'inv-a' });
    const b1 = row({ id: 'b1', invoice_id: 'inv-b' });
    const b2 = row({ id: 'b2', invoice_id: 'inv-b' });
    expect(groupCandidatesByInvoice([a1, b1, a2, b2])).toEqual([[a1, a2], [b1, b2]]);
  });

  test('a three-member group (partial split, one sibling still unstamped-resolved) stays one group', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];
    expect(groupCandidatesByInvoice(rows)).toEqual([rows]);
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

