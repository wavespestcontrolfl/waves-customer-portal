// claimInvoiceForSend's first-delivery / stale-claim-review-hold guards
// (slice 3, #4131).
//
//   - alreadyDeliveredForFirstSend: a firstDeliveryOnly claim against a row
//     that already carries a delivery stamp (sent_at/sms_sent_at/
//     email_sent_at) or a delivered-looking status is refused atomically
//     with code `already_delivered` instead of being treated as an
//     intentional resend. An ordinary (non-first-delivery) claim against the
//     same row is unaffected — that IS what Resend is for.
//   - isStaleClaimReviewHold: a row processScheduledSends parked for
//     operator review (status 'scheduled', scheduled_send_at NULL,
//     scheduled_send_error carrying the park text) refuses an automatic
//     claimant (no operatorInitiated) with code `stale_claim_review_hold`,
//     but a deliberate operator Resend (operatorInitiated: true) still
//     claims it — the intended way off the hold.

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  fn.fn = { now: jest.fn(() => 'now()') };
  fn.transaction = jest.fn(async (callback) => callback(fn));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimate-deposits', () => ({
  assertInvoiceDepositSettlementReady: jest.fn(async () => undefined),
}));

const db = require('../models/db');
const { STALE_SEND_PARK_ERROR } = require('../services/invoice-helpers');
const InvoiceService = require('../services/invoice');
const { claimInvoiceForSend } = InvoiceService;
const { evaluateWhereRaw } = require('./helpers/sql-predicate');

const INVOICE_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

// Dispatches by table name: 'invoices' serves `first`/`update().returning()`
// off the SAME mutable row (so a successful claim's status flip is visible
// to a subsequent read); 'sms_log' (the pay-link queue lookup) always
// reports no live row — every scenario here turns on the invoices row
// alone.
//
// Round-2 Codex P1 (PR #4633): the claim's atomic flip now carries the
// first-delivery/review-hold guards as REAL predicates
// (.whereNull(...)/.whereRaw(...)) on the UPDATE, not just the snapshot
// checked earlier — so a lost flip (another worker's write lands between
// the read and this claim's own UPDATE) must be reachable here. Each
// `db('invoices')` call now returns a FRESH query object (matching real
// knex — a new builder per call) that accumulates its own where-family
// predicates and evaluates them against the CURRENT shared row only when
// `.update()` runs; a non-matching update leaves the row untouched and
// `.returning()` resolves empty, exactly like a real lost UPDATE...WHERE.
// `mutateAfterFirstRead` optionally mutates the shared row once, right
// after the FIRST `.first()` snapshot resolves — modeling another
// worker's write landing in the window between the snapshot and the flip
// (the ABA race the round-2 fix closes).
function makeDb(invoiceRow, { mutateAfterFirstRead = null } = {}) {
  let row = { ...invoiceRow };
  let firstReadCount = 0;
  const updateSpy = jest.fn();
  const firstSpy = jest.fn();

  function makeInvoicesQuery() {
    const predicates = [];
    const q = {};
    q.where = jest.fn((criteria) => {
      if (criteria && typeof criteria === 'object') {
        predicates.push((r) => Object.entries(criteria).every(([k, v]) => r[k] === v));
      }
      return q;
    });
    q.whereNull = jest.fn((col) => { predicates.push((r) => r[col] == null); return q; });
    q.whereNotNull = jest.fn((col) => { predicates.push((r) => r[col] != null); return q; });
    q.whereRaw = jest.fn((sql, bindings) => { predicates.push((r) => evaluateWhereRaw(sql, bindings, r)); return q; });
    q.forUpdate = jest.fn(() => q);
    q.first = jest.fn(async () => {
      firstSpy();
      firstReadCount += 1;
      const snapshot = { ...row };
      if (firstReadCount === 1 && mutateAfterFirstRead) row = { ...row, ...mutateAfterFirstRead };
      return snapshot;
    });
    q.update = jest.fn((payload) => {
      updateSpy(payload);
      q.__matched = predicates.every((p) => p(row));
      if (q.__matched) row = { ...row, ...payload };
      return q;
    });
    q.returning = jest.fn(async () => (q.__matched ? [{ ...row }] : []));
    return q;
  }

  const smsLogTable = {};
  smsLogTable.whereRaw = jest.fn(() => smsLogTable);
  smsLogTable.first = jest.fn(async () => null);

  db.mockImplementation((table) => (table === 'invoices' ? makeInvoicesQuery() : smsLogTable));
  return { invoicesTable: { update: updateSpy, first: firstSpy }, currentRow: () => row };
}

describe('claimInvoiceForSend — first-delivery already-delivered refusal', () => {
  beforeEach(() => jest.clearAllMocks());

  test('firstDeliveryOnly refuses a row already stamped sent (already_delivered), atomically — no status flip', async () => {
    const { invoicesTable } = makeDb({
      id: INVOICE_ID, status: 'sent', sent_at: new Date(), send_claim_token: null,
      scheduled_send_at: null, scheduled_send_error: null,
    });
    await expect(claimInvoiceForSend(INVOICE_ID, { firstDeliveryOnly: true }))
      .rejects.toMatchObject({ code: 'already_delivered' });
    // Refused before ever attempting the claim's status UPDATE.
    expect(invoicesTable.update).not.toHaveBeenCalled();
  });

  test('firstDeliveryOnly refuses a draft row already carrying an email_sent_at stamp — status alone is not the signal', async () => {
    makeDb({
      id: INVOICE_ID, status: 'draft', email_sent_at: new Date(), send_claim_token: null,
      scheduled_send_at: null, scheduled_send_error: null,
    });
    await expect(claimInvoiceForSend(INVOICE_ID, { firstDeliveryOnly: true }))
      .rejects.toMatchObject({ code: 'already_delivered' });
  });

  test('the SAME row claims normally as an explicit Resend (firstDeliveryOnly: false)', async () => {
    makeDb({
      id: INVOICE_ID, status: 'sent', sent_at: new Date(), send_claim_token: null,
      scheduled_send_at: null, scheduled_send_error: null,
    });
    const result = await claimInvoiceForSend(INVOICE_ID, { firstDeliveryOnly: false });
    expect(result.claimed).toBe(true);
    expect(result.invoice.status).toBe('sending');
  });

  test('a first delivery on a genuinely undelivered draft row claims normally', async () => {
    makeDb({
      id: INVOICE_ID, status: 'draft', sent_at: null, sms_sent_at: null, email_sent_at: null,
      send_claim_token: null, scheduled_send_at: null, scheduled_send_error: null,
    });
    const result = await claimInvoiceForSend(INVOICE_ID, { firstDeliveryOnly: true });
    expect(result.claimed).toBe(true);
    expect(result.invoice.status).toBe('sending');
  });
});

describe('claimInvoiceForSend — stale-claim review hold (third audit P1: EXPLICIT overridesReviewHold, never inferred)', () => {
  beforeEach(() => jest.clearAllMocks());

  function parkedRow() {
    return {
      id: INVOICE_ID, status: 'scheduled', send_claim_token: null,
      scheduled_send_at: null, scheduled_send_error: STALE_SEND_PARK_ERROR,
    };
  }

  test('a parked row with overridesReviewHold: true is claimable — the one explicit way off the hold', async () => {
    makeDb(parkedRow());
    const result = await claimInvoiceForSend(INVOICE_ID, { overridesReviewHold: true });
    expect(result.claimed).toBe(true);
    expect(result.invoice.status).toBe('sending');
  });

  test('a parked row with firstDeliveryOnly: true is refused — a first delivery may never override the hold', async () => {
    makeDb(parkedRow());
    await expect(claimInvoiceForSend(INVOICE_ID, { firstDeliveryOnly: true }))
      .rejects.toMatchObject({ code: 'stale_claim_review_hold' });
  });

  // Round-1 Codex P1 (PR #4633): a parked row can ALSO carry a delivery
  // stamp from the same unverified attempt (the provider may have accepted
  // the message before the crash that stranded the claim). The review hold
  // must win over already-delivered — surfacing for operator review, not
  // resolving itself as a benign "already sent" no-op that hides the
  // unverified delivery.
  test('a parked row that ALSO carries a delivery stamp surfaces the review hold, never already_delivered', async () => {
    makeDb({ ...parkedRow(), sms_sent_at: new Date(), email_sent_at: new Date() });
    await expect(claimInvoiceForSend(INVOICE_ID, { firstDeliveryOnly: true }))
      .rejects.toMatchObject({ code: 'stale_claim_review_hold' });
  });

  // The third audit P1: operatorInitiated must NEVER be read as an implicit
  // override — main routes pass it unconditionally true (it keeps its own,
  // unrelated meaning, the quiet-hours bypass), so a claim with neither
  // explicit flag set still reaches this gate carrying operatorInitiated:
  // true. It must still be refused.
  test('a claim with neither flag is refused even WITH operatorInitiated: true — operatorInitiated is not an override', async () => {
    const { invoicesTable } = makeDb(parkedRow());
    await expect(claimInvoiceForSend(INVOICE_ID, { operatorInitiated: true }))
      .rejects.toMatchObject({ code: 'stale_claim_review_hold' });
    expect(invoicesTable.update).not.toHaveBeenCalled();
  });

  test('a row NOT parked (ordinary scheduled_send_error) is unaffected regardless of either flag', async () => {
    makeDb({
      id: INVOICE_ID, status: 'scheduled', send_claim_token: null,
      scheduled_send_at: new Date(), scheduled_send_error: null,
    });
    const result = await claimInvoiceForSend(INVOICE_ID, {});
    expect(result.claimed).toBe(true);

    makeDb({
      id: INVOICE_ID, status: 'scheduled', send_claim_token: null,
      scheduled_send_at: new Date(), scheduled_send_error: null,
    });
    const firstDeliveryResult = await claimInvoiceForSend(INVOICE_ID, { firstDeliveryOnly: true });
    expect(firstDeliveryResult.claimed).toBe(true);
  });
});

describe('claimInvoiceForSend — ABA race between the snapshot and the atomic flip (round-2 Codex P1, PR #4633)', () => {
  beforeEach(() => jest.clearAllMocks());

  function undeliveredScheduledRow() {
    return {
      id: INVOICE_ID, status: 'scheduled', send_claim_token: null,
      scheduled_send_at: new Date(), scheduled_send_error: null,
      sent_at: null, sms_sent_at: null, email_sent_at: null,
    };
  }

  // The snapshot read sees a clean, undelivered row and passes both guards
  // — but another worker's write (an uncertain-outcome claim, then
  // stale-claim recovery parking it) lands before this claim's own UPDATE.
  // The park takes priority: a first delivery must surface the review
  // hold, never a benign already_delivered no-op that hides it.
  test('the row is parked AND stamped between the read and the flip — rejects with the review hold, not already_delivered', async () => {
    const { invoicesTable } = makeDb(undeliveredScheduledRow(), {
      mutateAfterFirstRead: {
        sms_sent_at: new Date(),
        scheduled_send_at: null,
        scheduled_send_error: `${STALE_SEND_PARK_ERROR}: recovered mid-claim`,
      },
    });
    await expect(claimInvoiceForSend(INVOICE_ID, { firstDeliveryOnly: true }))
      .rejects.toMatchObject({ code: 'stale_claim_review_hold' });
    // The flip's own UPDATE ran (and lost) — it never actually flips a row
    // whose predicates it can't satisfy.
    expect(invoicesTable.update).toHaveBeenCalledTimes(1);
  });

  // Same race, but the row picks up ONLY the delivery stamp (no park) —
  // the already-delivered guard is what the latest row trips.
  test('the row is ONLY stamped between the read and the flip — rejects with already_delivered', async () => {
    makeDb(undeliveredScheduledRow(), {
      mutateAfterFirstRead: { sms_sent_at: new Date() },
    });
    await expect(claimInvoiceForSend(INVOICE_ID, { firstDeliveryOnly: true }))
      .rejects.toMatchObject({ code: 'already_delivered' });
  });

  // Pre-push audit P1 (PR #4633): two first-delivery claims race the SAME
  // flip. The loser's UPDATE...WHERE status = 'scheduled' matches nothing
  // (the winner already flipped status to 'sending') — the latest row is
  // neither parked nor stamped, so neither existing guard fires. This must
  // read as a legitimate supersession (the customer's pay link IS on its
  // way, from the WINNER's claim), never a generic "not sendable" that the
  // UI would show as "Failed to send invoice".
  test('a concurrent claim wins the flip race — rejects with delivery_in_progress, not the generic not-sendable error', async () => {
    makeDb(undeliveredScheduledRow(), {
      mutateAfterFirstRead: { status: 'sending', send_claim_token: 'winner-token-123' },
    });
    await expect(claimInvoiceForSend(INVOICE_ID, { firstDeliveryOnly: true }))
      .rejects.toMatchObject({ code: 'delivery_in_progress' });
  });

  // Same race, but the claim is a deliberate operator Resend authorized to
  // clear the hold — the park lands mid-claim with NO delivery stamp, and
  // overridesReviewHold means the flip's predicates never exclude it.
  test('the row is parked (no stamp) between the read and the flip, but overridesReviewHold: true — still claims', async () => {
    makeDb(undeliveredScheduledRow(), {
      mutateAfterFirstRead: {
        scheduled_send_at: null,
        scheduled_send_error: STALE_SEND_PARK_ERROR,
      },
    });
    const result = await claimInvoiceForSend(INVOICE_ID, { overridesReviewHold: true });
    expect(result.claimed).toBe(true);
    expect(result.invoice.status).toBe('sending');
  });
});

describe('claimInvoiceForSend — mutual exclusivity of intent (fourth audit gap #4131)', () => {
  test('firstDeliveryOnly && overridesReviewHold together is refused before any row is even read', async () => {
    const { invoicesTable } = makeDb({
      id: INVOICE_ID, status: 'scheduled', send_claim_token: null,
      scheduled_send_at: new Date(), scheduled_send_error: null,
    });
    await expect(claimInvoiceForSend(INVOICE_ID, { firstDeliveryOnly: true, overridesReviewHold: true }))
      .rejects.toThrow(/cannot be both a first delivery and a deliberate Resend/);
    expect(invoicesTable.first).not.toHaveBeenCalled();
  });
});


describe('sendViaSMS — allowClaimed branch forwards firstDeliveryOnly to the claim (round-0 audit P1)', () => {
  beforeEach(() => jest.clearAllMocks());

  // Same shape claimInvoiceForSend's own already-delivered check reads:
  // status 'sent' + sent_at, claimed under the caller's own preclaim token.
  function deliveredRow() {
    return {
      id: INVOICE_ID, status: 'sent', sent_at: new Date(),
      send_claim_token: 'tok', scheduled_send_at: null, scheduled_send_error: null,
    };
  }

  test('a preclaimed sendViaSMS forwards firstDeliveryOnly to the claim — refused with already_delivered', async () => {
    makeDb(deliveredRow());
    await expect(InvoiceService.sendViaSMS(INVOICE_ID, {
      allowClaimed: true, claimToken: 'tok', firstDeliveryOnly: true, operatorInitiated: true,
    })).rejects.toMatchObject({ code: 'already_delivered' });
  });

  test('the SAME preclaimed call WITHOUT firstDeliveryOnly proceeds past the claim (fails later, not on already_delivered)', async () => {
    makeDb(deliveredRow());
    await expect(InvoiceService.sendViaSMS(INVOICE_ID, {
      allowClaimed: true, claimToken: 'tok', operatorInitiated: true,
    })).rejects.not.toMatchObject({ code: 'already_delivered' });
  });
});

describe('claimPacketInvoiceForSend — the queue worker due-claim is never a first delivery or an override (round-0 + third audit P1)', () => {
  test('requireDue together with firstDeliveryOnly is refused before any claim is attempted', async () => {
    const { claimPacketInvoiceForSend } = require('../services/invoice');
    await expect(claimPacketInvoiceForSend('inv-1', 'pkt-1', { requireDue: true, firstDeliveryOnly: true }))
      .rejects.toThrow(/cannot be a first delivery/);
  });

  test('requireDue together with overridesReviewHold is ALSO refused — the queue worker never overrides the hold', async () => {
    const { claimPacketInvoiceForSend } = require('../services/invoice');
    await expect(claimPacketInvoiceForSend('inv-1', 'pkt-1', { requireDue: true, overridesReviewHold: true }))
      .rejects.toThrow(/cannot be a first delivery or override the review hold/);
  });
});

// claimInvoiceForSend's zero-due re-checks (#4131 slice 4): a visit-linked
// invoice whose amount due has gone to zero (credit, prepaid coverage, a
// retotal) must never have a claim handed out for it — settle it instead.
// InvoiceService.settleZeroBalance is a full-transaction method with its own
// extensive coverage elsewhere; these tests mock it directly so a failure
// here always points at the RE-CHECK wiring, not settleZeroBalance itself.
describe('claimInvoiceForSend — zero-due visit invoice guard (#4131 slice 4)', () => {
  let settleSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    settleSpy = jest.spyOn(InvoiceService, 'settleZeroBalance');
  });

  afterEach(() => settleSpy.mockRestore());

  function zeroDueRow(overrides = {}) {
    return {
      id: INVOICE_ID, status: 'draft', scheduled_service_id: 'svc-1',
      total: 100, credit_applied: 100, send_claim_token: null,
      scheduled_send_at: null, scheduled_send_error: null,
      ...overrides,
    };
  }

  test('a zero-due visit invoice is settled and refused BEFORE the claim ever flips the row', async () => {
    const { invoicesTable, currentRow } = makeDb(zeroDueRow());
    settleSpy.mockResolvedValue({ settled: true, invoice: { ...zeroDueRow(), status: 'prepaid' } });

    await expect(claimInvoiceForSend(INVOICE_ID)).rejects.toMatchObject({ code: 'zero_due' });

    expect(settleSpy).toHaveBeenCalledWith(INVOICE_ID, expect.anything());
    // Never flipped to 'sending' — the guard runs BEFORE the claim update.
    expect(invoicesTable.update).not.toHaveBeenCalled();
    expect(currentRow().status).toBe('draft');
  });

  test('a zero-due visit invoice that cannot settle right now is refused as retryable, not a $0 claim', async () => {
    makeDb(zeroDueRow());
    settleSpy.mockResolvedValue({ settled: false, reason: 'invoice_delivery_in_flight', invoice: null });

    await expect(claimInvoiceForSend(INVOICE_ID)).rejects.toMatchObject({ code: 'deposit_settlement_pending' });
  });

  test('a total that is exactly covered by credit, but NOT visit-linked, claims normally (guard is visit-linked only)', async () => {
    const row = zeroDueRow({ scheduled_service_id: null });
    makeDb(row);

    const result = await claimInvoiceForSend(INVOICE_ID);
    expect(result.claimed).toBe(true);
    expect(settleSpy).not.toHaveBeenCalled();
  });

  test('a retotal to zero landing between the pre-claim read and the flip is caught by the post-claim re-check and restores the row', async () => {
    // The pre-claim read sees a normal $100-due invoice (no scheduled_service_id
    // yet visible to the guard because total/credit don't net to zero); the
    // retotal actually lands in the window the ABA mutation models, changing
    // BOTH the credit and the visit link atomically — mirroring a real retotal
    // that flips both scheduled_service_id linkage and amount due together.
    const { currentRow } = makeDb(
      { id: INVOICE_ID, status: 'draft', scheduled_service_id: null, total: 100, credit_applied: 0,
        send_claim_token: null, scheduled_send_at: null, scheduled_send_error: null },
      { mutateAfterFirstRead: { scheduled_service_id: 'svc-1', credit_applied: 100 } },
    );
    settleSpy.mockResolvedValue({ settled: true, invoice: { id: INVOICE_ID, status: 'prepaid' } });

    await expect(claimInvoiceForSend(INVOICE_ID)).rejects.toMatchObject({ code: 'zero_due' });

    expect(settleSpy).toHaveBeenCalledWith(INVOICE_ID, expect.anything());
    // The claim was taken (the flip DID match, on the pre-mutation predicate)
    // and then given all the way back — never left sitting on 'sending'.
    expect(currentRow().status).toBe('draft');
    expect(currentRow().send_claim_token).toBeNull();
  });

  test('a PRECLAIMED row (the scheduled-send worker\'s own claim) rediscovering zero-due marks the throw deliveryNeverAttempted', async () => {
    // processScheduledSends preclaims (flips scheduled -> sending) BEFORE
    // calling back in with allowClaimed: true; this models the rare race
    // where the retotal lands in between. The allowClaimed branch never
    // touches the invoice row itself, so the caller's own retry handling —
    // not this claim — must decide what happens next; the flag is how it
    // knows this is safe to treat as an ordinary (retryable) send failure.
    makeDb({
      id: INVOICE_ID, status: 'sending', scheduled_service_id: 'svc-1',
      total: 100, credit_applied: 100, send_claim_token: 'worker-tok',
      scheduled_send_at: null, scheduled_send_error: null,
    });
    settleSpy.mockResolvedValue({ settled: true, invoice: { id: INVOICE_ID, status: 'prepaid' } });

    let caught = null;
    try {
      await claimInvoiceForSend(INVOICE_ID, { allowClaimed: true, claimToken: 'worker-tok' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 'zero_due', deliveryNeverAttempted: true });
  });

  test('an unexpected throw from settleZeroBalance (a bug, a DB error) propagates — never silently reinterpreted as a retryable business refusal', async () => {
    // Pre-push audit P1 (#4131 slice 4): a catch-all here previously turned
    // ANY error from settleZeroBalance into deposit_settlement_pending,
    // which would loop a permanently unsettleable invoice forever with no
    // visible failure. Only settleZeroBalance's OWN returned {settled:
    // false, reason} outcomes are recognized business refusals.
    makeDb(zeroDueRow());
    const boom = new Error('connection terminated unexpectedly');
    settleSpy.mockRejectedValue(boom);

    await expect(claimInvoiceForSend(INVOICE_ID)).rejects.toBe(boom);
  });

  test('a PRECLAIMED row\'s UNEXPECTED settle failure is NOT marked deliveryNeverAttempted — only zero_due/deposit_settlement_pending are', async () => {
    // Pre-push audit P1: tagging every caught error here reclassified a
    // genuine bug/DB failure as an ordinary retryable send failure
    // downstream — the caller (processScheduledSends) would then silently
    // retry a crash forever instead of letting it propagate.
    makeDb({
      id: INVOICE_ID, status: 'sending', scheduled_service_id: 'svc-1',
      total: 100, credit_applied: 100, send_claim_token: 'worker-tok',
      scheduled_send_at: null, scheduled_send_error: null,
    });
    const boom = new Error('connection terminated unexpectedly');
    settleSpy.mockRejectedValue(boom);

    let caught = null;
    try {
      await claimInvoiceForSend(INVOICE_ID, { allowClaimed: true, claimToken: 'worker-tok' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
    expect(caught.deliveryNeverAttempted).toBeUndefined();
  });
});
