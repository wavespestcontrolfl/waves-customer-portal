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

const INVOICE_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

// Dispatches by table name: 'invoices' serves `first`/`update().returning()`
// off the SAME mutable row (so a successful claim's status flip is visible
// to a subsequent read); 'sms_log' (the pay-link queue lookup) always
// reports no live row — every scenario here turns on the invoices row
// alone.
function makeDb(invoiceRow) {
  let row = { ...invoiceRow };
  const invoicesTable = {};
  for (const m of ['where', 'whereRaw', 'whereNotNull', 'forUpdate']) invoicesTable[m] = jest.fn(() => invoicesTable);
  invoicesTable.first = jest.fn(async () => ({ ...row }));
  invoicesTable.update = jest.fn((payload) => {
    row = { ...row, ...payload };
    return invoicesTable;
  });
  invoicesTable.returning = jest.fn(async () => [{ ...row }]);

  const smsLogTable = {};
  smsLogTable.whereRaw = jest.fn(() => smsLogTable);
  smsLogTable.first = jest.fn(async () => null);

  db.mockImplementation((table) => (table === 'invoices' ? invoicesTable : smsLogTable));
  return { invoicesTable, currentRow: () => row };
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

describe('claimInvoiceForSend — stale-claim review hold', () => {
  beforeEach(() => jest.clearAllMocks());

  function parkedRow() {
    return {
      id: INVOICE_ID, status: 'scheduled', send_claim_token: null,
      scheduled_send_at: null, scheduled_send_error: STALE_SEND_PARK_ERROR,
    };
  }

  test('an automatic claimant (no operatorInitiated, no firstDeliveryOnly) is refused — the park holds', async () => {
    const { invoicesTable } = makeDb(parkedRow());
    await expect(claimInvoiceForSend(INVOICE_ID, {}))
      .rejects.toMatchObject({ code: 'stale_claim_review_hold' });
    expect(invoicesTable.update).not.toHaveBeenCalled();
  });

  test('a first-delivery claim (firstDeliveryOnly) is refused even with NO operatorInitiated', async () => {
    makeDb(parkedRow());
    await expect(claimInvoiceForSend(INVOICE_ID, { firstDeliveryOnly: true }))
      .rejects.toMatchObject({ code: 'stale_claim_review_hold' });
  });

  // The round-6 P1 regression: main routes now pass operatorInitiated:true
  // unconditionally (it keeps its ordinary meaning — an authenticated admin
  // action, e.g. the quiet-hours bypass), so a first delivery reaches this
  // gate WITH operatorInitiated:true. It must still be refused — the hold
  // is never overridable by firstDeliveryOnly alone, regardless of
  // operatorInitiated.
  test('a first-delivery claim is refused even WITH operatorInitiated: true — never the way off the hold', async () => {
    makeDb(parkedRow());
    await expect(claimInvoiceForSend(INVOICE_ID, { firstDeliveryOnly: true, operatorInitiated: true }))
      .rejects.toMatchObject({ code: 'stale_claim_review_hold' });
  });

  test('a deliberate operator Resend (operatorInitiated: true, firstDeliveryOnly: false) clears the hold and claims the row', async () => {
    const result = await (async () => {
      makeDb(parkedRow());
      return claimInvoiceForSend(INVOICE_ID, { operatorInitiated: true, firstDeliveryOnly: false });
    })();
    expect(result.claimed).toBe(true);
    expect(result.invoice.status).toBe('sending');
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
    const firstDeliveryResult = await claimInvoiceForSend(INVOICE_ID, { firstDeliveryOnly: true, operatorInitiated: true });
    expect(firstDeliveryResult.claimed).toBe(true);
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
