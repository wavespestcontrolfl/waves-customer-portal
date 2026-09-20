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
jest.mock('../services/review-request', () => ({ enrollForPaidInvoice: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const { enrollForPaidInvoice } = require('../services/review-request');
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
function makeDb(invoiceRow, { mutateAfterFirstRead = null, mutateAfterNthRead = null } = {}) {
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
      // mutateAfterNthRead: { n, patch } — mutates after the Nth `.first()`
      // read specifically (Codex round-6 P2 #4131), for races landing
      // between two SPECIFIC reads rather than right after the first one.
      if (mutateAfterNthRead && firstReadCount === mutateAfterNthRead.n) row = { ...row, ...mutateAfterNthRead.patch };
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
describe('claimInvoiceForSend — zero-due DETECTION only (#4131 slice 4 round-5)', () => {
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

  test('a zero-due visit invoice throws zero_due_detected BEFORE the claim ever flips the row — never settles itself', async () => {
    // Codex round-5 #4131: settleZeroBalance is invoked from exactly ONE
    // place now (settleZeroDueBeforeSend) — a claim path only detects.
    const { invoicesTable, currentRow } = makeDb(zeroDueRow());

    await expect(claimInvoiceForSend(INVOICE_ID)).rejects.toMatchObject({ code: 'zero_due_detected' });

    expect(settleSpy).not.toHaveBeenCalled();
    // Never flipped to 'sending' — the guard runs BEFORE the claim update.
    expect(invoicesTable.update).not.toHaveBeenCalled();
    expect(currentRow().status).toBe('draft');
  });

  test('a total that is exactly covered by credit, but NOT visit-linked, claims normally (guard is visit-linked only)', async () => {
    const row = zeroDueRow({ scheduled_service_id: null });
    makeDb(row);

    const result = await claimInvoiceForSend(INVOICE_ID);
    expect(result.claimed).toBe(true);
    expect(settleSpy).not.toHaveBeenCalled();
  });

  test('a retotal to zero landing between the pre-claim read and the flip is caught by the post-claim re-check, restores the row, and throws zero_due_detected — never settles itself', async () => {
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

    await expect(claimInvoiceForSend(INVOICE_ID)).rejects.toMatchObject({ code: 'zero_due_detected' });

    expect(settleSpy).not.toHaveBeenCalled();
    // The claim was taken (the flip DID match, on the pre-mutation predicate)
    // and then given all the way back — never left sitting on 'sending'.
    expect(currentRow().status).toBe('draft');
    expect(currentRow().send_claim_token).toBeNull();
  });

  test('a PRECLAIMED row (the scheduled-send worker\'s own claim) rediscovering zero-due throws zero_due_detected marked deliveryNeverAttempted — never settles itself, never touches the row', async () => {
    // processScheduledSends preclaims (flips scheduled -> sending) BEFORE
    // calling back in with allowClaimed: true; this models the rare race
    // where the retotal lands in between. The allowClaimed branch never
    // touches the invoice row itself, so the caller's own retry handling —
    // not this claim — must decide what happens next; the flag is how it
    // knows this is safe to treat as an ordinary (retryable) send failure.
    const { invoicesTable } = makeDb({
      id: INVOICE_ID, status: 'sending', scheduled_service_id: 'svc-1',
      total: 100, credit_applied: 100, send_claim_token: 'worker-tok',
      scheduled_send_at: null, scheduled_send_error: null,
    });

    let caught = null;
    try {
      await claimInvoiceForSend(INVOICE_ID, { allowClaimed: true, claimToken: 'worker-tok' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 'zero_due_detected', deliveryNeverAttempted: true });
    expect(settleSpy).not.toHaveBeenCalled();
    expect(invoicesTable.update).not.toHaveBeenCalled();
  });
});

describe('settleZeroDueBeforeSend — THE zero-due chokepoint (#4131 slice 4 round-5)', () => {
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
      visit_completion_packet_id: null, payer_id: null,
      ...overrides,
    };
  }

  test('settled: calls settleZeroBalance through the top-level db and returns the settled descriptor', async () => {
    makeDb(zeroDueRow());
    settleSpy.mockResolvedValue({ settled: true, invoice: { ...zeroDueRow(), status: 'prepaid' } });

    const outcome = await InvoiceService._settleZeroDueBeforeSend(INVOICE_ID);

    expect(settleSpy).toHaveBeenCalledWith(INVOICE_ID, expect.anything());
    expect(outcome.kind).toBe('settled');
  });

  test('refused: a business refusal from settleZeroBalance maps to a retryable refused descriptor', async () => {
    makeDb(zeroDueRow());
    settleSpy.mockResolvedValue({ settled: false, reason: 'invoice_delivery_in_flight', invoice: null });

    const outcome = await InvoiceService._settleZeroDueBeforeSend(INVOICE_ID);

    expect(outcome).toMatchObject({ kind: 'refused', code: 'deposit_settlement_pending', reason: 'invoice_delivery_in_flight' });
  });

  test('terminal: visit_never_ran is preserved as its own kind — never collapsed into deposit_settlement_pending', async () => {
    // Codex round-5 P1 #4131: the throw-shaped claim path used to lose the
    // terminal distinction entirely, always reporting a generic retryable
    // refusal for visit_never_ran instead of routing to the void cleanup.
    makeDb(zeroDueRow());
    settleSpy.mockResolvedValue({ settled: false, reason: 'visit_never_ran', invoice: null });

    const outcome = await InvoiceService._settleZeroDueBeforeSend(INVOICE_ID);

    expect(outcome.kind).toBe('terminal');
    expect(outcome.code).not.toBe('deposit_settlement_pending');
  });

  test('not_zero_due: a row that is not actually zero-due never calls settleZeroBalance', async () => {
    makeDb(zeroDueRow({ total: 100, credit_applied: 0 }));

    const outcome = await InvoiceService._settleZeroDueBeforeSend(INVOICE_ID);

    expect(outcome).toEqual({ kind: 'not_zero_due' });
    expect(settleSpy).not.toHaveBeenCalled();
  });

  test('settled: a review-enrollment failure after the settlement already committed is best-effort — outcome is still settled (Codex round-5 audit non-P1 #4131 slice 4)', async () => {
    // enrollPacketReviewAfterCredit already guards its OWN awaited calls,
    // but settleZeroDueBeforeSend used to await it with no catch of its
    // own — a throw reaching past every one of the callee's internal
    // guards (forced here via a poisoned getter, since the callee is
    // otherwise fully defensive) would have rejected settleZeroDueBeforeSend
    // AFTER settleZeroBalance had already committed, so the worker would
    // count a genuinely settled invoice as failed.
    makeDb(zeroDueRow({ visit_completion_packet_id: 'pkt-1' }));
    settleSpy.mockResolvedValue({ settled: true, invoice: { ...zeroDueRow(), status: 'prepaid' } });
    enrollForPaidInvoice.mockResolvedValue({
      get enrolled() { throw new Error('poisoned enrollment result'); },
      recorded: false,
    });

    const outcome = await InvoiceService._settleZeroDueBeforeSend(INVOICE_ID);

    expect(outcome.kind).toBe('settled');
    expect(settleSpy).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(INVOICE_ID));
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

    await expect(InvoiceService._settleZeroDueBeforeSend(INVOICE_ID)).rejects.toBe(boom);
  });
});

describe('sendViaSMS — resolving the zero-due chokepoint after catching zero_due_detected (#4131 slice 4)', () => {
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

  test('sendViaSMS resolves a structured, non-throwing success when the under-claim race settles the invoice zero-due (Codex round-1 P1)', async () => {
    // Ruling: mirrors the covered_by_credit precedent — direct callers
    // (collections-conversation.js, the AI-assistant send tool, batch
    // sendImmediately, the from-service SMS path) treat ANY thrown error
    // from sendViaSMS as an ambiguous delivery outcome; a genuine
    // settlement success must never reach them as a throw.
    makeDb(zeroDueRow());
    settleSpy.mockResolvedValue({ settled: true, invoice: { ...zeroDueRow(), status: 'prepaid' } });

    const result = await InvoiceService.sendViaSMS(INVOICE_ID);

    expect(result).toMatchObject({ sent: false, ok: true, code: 'zero_due', settled_zero_due: true });
    expect(typeof result.reason).toBe('string');
  });

  test('sendViaSMS resolves a definite not-sent, retryable result when the under-claim race is refused as deposit_settlement_pending (Codex round-2 P1)', async () => {
    // Same seam, other verdict: settlement refused for now (not settled,
    // not a bug) is verified pre-provider — a definite not-sent, retryable
    // outcome, not the ambiguous failure a thrown error reads as downstream.
    makeDb(zeroDueRow());
    settleSpy.mockResolvedValue({ settled: false, reason: 'invoice_delivery_in_flight', invoice: null });

    const result = await InvoiceService.sendViaSMS(INVOICE_ID);

    expect(result).toMatchObject({
      sent: false, ok: false, code: 'deposit_settlement_pending', deliveryOutcome: 'not_sent', retryable: true,
    });
    expect(typeof result.reason).toBe('string');
  });

  test('a not_zero_due outcome (a concurrent credit reversal / retotal restored a positive balance) retries the send ONCE and DELIVERS, rather than refusing a now-collectible invoice as deposit_settlement_pending (Codex round-6 P2 #4131)', async () => {
    // Between the claim's own zero-due detection (read #2) and the
    // chokepoint's fresh re-read (read #3), the balance is restored —
    // exactly the race #4131 slice 4 round-6 raised: the invoice is
    // collectible again, but the OLD fallthrough mapped kind:
    // 'not_zero_due' the same as a business refusal. mockImplementationOnce
    // lets THIS (outer) call run for real; the recursive retry it makes is
    // intercepted by the very next queued mock value, proving the retry
    // happened and that its own (delivered) result is what the caller sees.
    makeDb(zeroDueRow(), { mutateAfterNthRead: { n: 2, patch: { credit_applied: 0 } } });
    const deliveredResult = { sent: true, ok: true, payUrl: 'https://pay.example/x' };
    const original = InvoiceService.sendViaSMS.bind(InvoiceService);
    const spy = jest.spyOn(InvoiceService, 'sendViaSMS');
    spy.mockImplementationOnce(original).mockResolvedValueOnce(deliveredResult);

    const result = await InvoiceService.sendViaSMS(INVOICE_ID);

    expect(result).toEqual(deliveredResult);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith(INVOICE_ID, expect.objectContaining({ _zeroDueRetried: true }));
    expect(settleSpy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('an unexpected throw from the chokepoint (a bug, a DB error) propagates out of sendViaSMS too — never silently reinterpreted', async () => {
    // Codex round-5 #4131: sendViaSMS's own catch calls settleZeroDueBeforeSend
    // to resolve a zero_due_detected — if THAT throws unexpectedly, it must
    // keep propagating, exactly like claimInvoiceForSend's caller never
    // reinterpreting an unexpected settleZeroBalance failure as a business
    // refusal.
    makeDb(zeroDueRow());
    const boom = new Error('connection terminated unexpectedly');
    settleSpy.mockRejectedValue(boom);

    await expect(InvoiceService.sendViaSMS(INVOICE_ID)).rejects.toBe(boom);
  });

  test('sendViaSMSAndEmail: a not_zero_due outcome (a concurrent credit reversal / retotal restored a positive balance) retries ONCE and DELIVERS, rather than refusing a now-collectible invoice (Codex round-6 P2 #4131)', async () => {
    // Same seam as sendViaSMS's own round-6 test above, on the OTHER
    // caller sendViaSMSAndEmail retries: the accrual pre-check (read #1),
    // the claim's own zero-due snapshot (read #2, still zero-due — throws
    // zero_due_detected), then the chokepoint's fresh re-read (read #3,
    // mutated to no longer be zero-due) triggers retryOnce().
    // mockImplementationOnce lets THIS (outer) call run for real; the
    // recursive retry it makes is intercepted by the very next queued
    // mock value, proving the retry happened and its own (delivered)
    // result is what the caller sees. estimate-deposits is mocked at the
    // top of this file, so no extra db read runs between #2 and #3.
    makeDb(zeroDueRow(), { mutateAfterNthRead: { n: 2, patch: { credit_applied: 0 } } });
    const deliveredResult = { ok: true, sms: { ok: true }, email: { ok: true }, payUrl: 'https://pay.example/x' };
    const original = InvoiceService.sendViaSMSAndEmail.bind(InvoiceService);
    const spy = jest.spyOn(InvoiceService, 'sendViaSMSAndEmail');
    spy.mockImplementationOnce(original).mockResolvedValueOnce(deliveredResult);

    const result = await InvoiceService.sendViaSMSAndEmail(INVOICE_ID, {});

    expect(result).toEqual(deliveredResult);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith(INVOICE_ID, expect.objectContaining({ _zeroDueRetried: true }));
    expect(settleSpy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('a PRECLAIMED row rediscovering zero-due resolves through the chokepoint too — deposit_settlement_pending, since settleZeroBalance itself refuses a "sending" row', async () => {
    makeDb({
      id: INVOICE_ID, status: 'sending', scheduled_service_id: 'svc-1',
      total: 100, credit_applied: 100, send_claim_token: 'worker-tok',
      scheduled_send_at: null, scheduled_send_error: null,
    });
    settleSpy.mockResolvedValue({ settled: false, reason: 'invoice_delivery_in_flight', invoice: null });

    const result = await InvoiceService.sendViaSMS(INVOICE_ID, { allowClaimed: true, claimToken: 'worker-tok' });

    expect(result).toMatchObject({ sent: false, ok: false, code: 'deposit_settlement_pending' });
  });
});

describe('zeroDueDirectSendOutcome / zeroDueWrapperOutcome — a safety-refused terminal void must not be reported handled (Codex round-6 audit P1 #4131)', () => {
  let voidSpy;

  beforeEach(() => {
    voidSpy = jest.spyOn(InvoiceService, 'voidOpenInvoicesForCancelledService');
  });

  afterEach(() => voidSpy.mockRestore());

  const terminalOutcome = { kind: 'terminal', reason: 'visit_never_ran', scheduledServiceId: 'svc-1' };

  test('direct (sendViaSMS) shape: a safety-refused void reports a distinct code, logs a warning, and is never treated as handled', async () => {
    // The sweep itself refused to void (a live PaymentIntent, money in
    // flight, an unverifiable Stripe lookup) — voidOpenInvoicesForCancelledService
    // returns a list that does NOT include this invoice.
    voidSpy.mockResolvedValue([]);

    const result = await InvoiceService._zeroDueDirectSendOutcome(INVOICE_ID, terminalOutcome);

    expect(voidSpy).toHaveBeenCalledWith('svc-1');
    expect(result).toMatchObject({
      sent: false, ok: false, code: 'INVOICE_VISIT_TERMINAL_UNVOIDED', voided: false,
      deliveryOutcome: 'not_sent', retryable: true,
    });
    expect(result.code).not.toBe('INVOICE_VISIT_TERMINAL');
    expect(typeof result.reason).toBe('string');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(INVOICE_ID));
  });

  test('wrapper (sendViaSMSAndEmail) shape: same fix — a distinct code on both legs, never reported handled', async () => {
    voidSpy.mockResolvedValue([]);

    const result = await InvoiceService._zeroDueWrapperOutcome(INVOICE_ID, terminalOutcome);

    expect(voidSpy).toHaveBeenCalledWith('svc-1');
    expect(result).toMatchObject({
      ok: false, code: 'INVOICE_VISIT_TERMINAL_UNVOIDED', voided: false,
      sms: { ok: false, code: 'INVOICE_VISIT_TERMINAL_UNVOIDED', deliveryOutcome: 'not_sent' },
      email: { ok: false, code: 'INVOICE_VISIT_TERMINAL_UNVOIDED', deliveryOutcome: 'not_sent' },
    });
    expect(result.code).not.toBe('INVOICE_VISIT_TERMINAL');
    expect(typeof result.error).toBe('string');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(INVOICE_ID));
  });

  test('the successful-void shape is UNCHANGED when the sweep actually voids it (direct shape)', async () => {
    voidSpy.mockResolvedValue([INVOICE_ID]);

    const result = await InvoiceService._zeroDueDirectSendOutcome(INVOICE_ID, terminalOutcome);

    expect(result).toEqual({
      sent: false, ok: false, code: 'INVOICE_VISIT_TERMINAL', deliveryOutcome: 'not_sent',
      reason: 'Linked visit is terminal; delivery not attempted',
    });
  });

  test('the successful-void shape is UNCHANGED when the sweep actually voids it (wrapper shape)', async () => {
    voidSpy.mockResolvedValue([INVOICE_ID]);

    const result = await InvoiceService._zeroDueWrapperOutcome(INVOICE_ID, terminalOutcome);

    expect(result).toEqual({
      ok: false, code: 'INVOICE_VISIT_TERMINAL', error: 'Linked visit is terminal; delivery not attempted',
      sms: { ok: false, code: 'INVOICE_VISIT_TERMINAL', deliveryOutcome: 'not_sent' },
      email: { ok: false, code: 'INVOICE_VISIT_TERMINAL', deliveryOutcome: 'not_sent' },
    });
  });
});
