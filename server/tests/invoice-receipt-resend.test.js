/**
 * sendInvoiceReceipt — the one writer behind the Invoices "Resend receipt"
 * route and the IB resend_receipt tool. The route's HTTP behavior is pinned in
 * admin-invoices-send-receipt-claim.test.js; this covers the function's own
 * contract: the {status, body} shapes, the caller-supplied sawUnsent, the
 * actor passed to the closeout, stamping and the activity row.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.fn = { now: jest.fn(() => 'now()') };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The advisory lock needs a real connection; its own suite is intelligence-bar-receipt-resend-claim-postgres.
// lostAfter = how many ownership checks pass before the lock's session reads as lost.
const mockLock = { busy: false, reason: 'busy', lostAfter: Infinity, checks: 0 };
jest.mock('../services/receipt-send-lock', () => ({
  withReceiptSendLock: async (_id, run) => {
    if (mockLock.busy) return { acquired: false, reason: mockLock.reason };
    mockLock.checks = 0;
    return { acquired: true, value: await run({ lost: () => mockLock.checks++ >= mockLock.lostAfter }) };
  },
}));
jest.mock('../services/invoice-issued-closeout', () => ({ closeOutVisitForIssuedInvoice: jest.fn(async () => null) }));
jest.mock('../services/invoice-email', () => ({ sendReceiptEmail: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/invoice', () => ({ sendReceipt: jest.fn(async () => ({ sent: true })) }));
jest.mock('../services/receipt-delivery-queue', () => ({
  claimReceiptJobForOperatorSend: jest.fn(async () => ({ id: 'job-1', token: 'claim-1', prior: null })),
  recordOperatorReceiptDelivered: jest.fn(async () => undefined),
  releaseOperatorReceiptClaim: jest.fn(async () => undefined),
}));

const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const { sendReceiptEmail } = require('../services/invoice-email');
const { claimReceiptJobForOperatorSend, releaseOperatorReceiptClaim } = require('../services/receipt-delivery-queue');
const { closeOutVisitForIssuedInvoice } = require('../services/invoice-issued-closeout');
const { sendInvoiceReceipt } = require('../services/invoice-receipt-resend');

const ID = 'bbbbbbbb-2222-4222-8222-222222222222';
let invoice;
let updates;
let activity;

beforeEach(() => {
  jest.clearAllMocks();
  invoice = { id: ID, status: 'paid', customer_id: 'cust-1', invoice_number: 'WPC-2026-0900', receipt_sent_at: null };
  updates = [];
  activity = [];
  db.mockImplementation((table) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.first = jest.fn(async () => invoice);
    q.update = jest.fn(async (patch) => { updates.push({ table, patch }); return 1; });
    q.insert = jest.fn((row) => { activity.push({ table, row }); return Promise.resolve(); });
    return q;
  });
});

test('validation and refusals come back as {status, body}, with nothing claimed', async () => {
  expect(await sendInvoiceReceipt(ID, { via: 'pigeon' })).toEqual({ status: 400, body: { error: "via must be 'email', 'sms', or 'both'" } });
  invoice = null;
  expect(await sendInvoiceReceipt(ID, {})).toEqual({ status: 404, body: { error: 'Invoice not found' } });
  invoice = { id: ID, status: 'sent' };
  expect((await sendInvoiceReceipt(ID, {})).status).toBe(400);
  expect(claimReceiptJobForOperatorSend).not.toHaveBeenCalled();
});

test('both legs: stamps receipt_sent_at with the trimmed, cut memo, writes the activity row, returns the route body', async () => {
  const out = await sendInvoiceReceipt(ID, { via: 'both', memo: `  ${'x'.repeat(500)}  `, actorTechnicianId: 'admin-1' });
  expect(out.status).toBe(200);
  expect(out.body).toMatchObject({ ok: true, email: { ok: true }, sms: { ok: true }, invoice: { id: ID } });
  expect(sendReceiptEmail).toHaveBeenCalledWith(ID, { memo: 'x'.repeat(400) });
  expect(closeOutVisitForIssuedInvoice).toHaveBeenCalledWith({ invoiceId: ID, trigger: 'paid', actorTechnicianId: 'admin-1' });
  expect(InvoiceService.sendReceipt).toHaveBeenCalledWith(ID, { force: true, recordActivity: false, hasEmailLeg: true, operatorInitiated: true });
  expect(updates).toContainEqual({ table: 'invoices', patch: { receipt_sent_at: 'now()', receipt_memo: 'x'.repeat(400) } });
  expect(activity[0].row).toMatchObject({ action: 'invoice_receipt_sent', description: expect.stringMatching(/WPC-2026-0900 \(email \+ sms\) — memo: x{80}…/) });
});

test('sawUnsent defaults to the live row, and a caller-supplied value (the card\'s state) wins', async () => {
  await sendInvoiceReceipt(ID, {});
  expect(claimReceiptJobForOperatorSend).toHaveBeenLastCalledWith(ID, { sawUnsent: true });
  invoice.receipt_sent_at = new Date('2026-10-02T18:14:00Z');
  await sendInvoiceReceipt(ID, {});
  expect(claimReceiptJobForOperatorSend).toHaveBeenLastCalledWith(ID, { sawUnsent: false });
  await sendInvoiceReceipt(ID, { sawUnsent: true });
  expect(claimReceiptJobForOperatorSend).toHaveBeenLastCalledWith(ID, { sawUnsent: true });
});

test('both legs failing stamps nothing, writes no activity row, and still releases the claim', async () => {
  sendReceiptEmail.mockResolvedValueOnce({ ok: false, error: 'PDF generation failed' });
  InvoiceService.sendReceipt.mockResolvedValueOnce({ sent: false, reason: 'no-phone' });
  const out = await sendInvoiceReceipt(ID, { via: 'both' });
  expect(out.body).toMatchObject({ ok: false, email: { ok: false, error: 'PDF generation failed' }, sms: { ok: false, error: 'no-phone' } });
  expect(updates).toEqual([]);
  expect(activity).toEqual([]);
  expect(releaseOperatorReceiptClaim).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1' }), expect.objectContaining({ emailDelivered: false, smsDelivered: false }));
});

test('a thrown email send is a failed leg, not a thrown call', async () => {
  sendReceiptEmail.mockRejectedValueOnce(new Error('provider down'));
  const out = await sendInvoiceReceipt(ID, { via: 'email' });
  expect(out.body.email).toEqual({ ok: false, error: 'provider down' });
  expect(out.body.sms).toEqual({ ok: false, skipped: true });
});

test('the closeout outcome rides beside the body, never inside it (the route answers with the body only)', async () => {
  closeOutVisitForIssuedInvoice.mockResolvedValueOnce({ closed: true, visitId: 'visit-1' });
  const out = await sendInvoiceReceipt(ID, { via: 'email' });
  expect(out.closeout).toEqual({ closed: true, visitId: 'visit-1' });
  expect(Object.keys(out.body).sort()).toEqual(['email', 'invoice', 'ok', 'sms']);
});

describe('holdUnknownOutcome — only the tool opts in; the route keeps handing the job back', () => {
  // The structured evidence the senders carry: email results tag deliveryOutcome; a text failure
  // is an error whose providerOutcome is the messaging layer's own (what sendReceipt attaches).
  const unknownEmail = () => sendReceiptEmail.mockResolvedValueOnce({ ok: false, error: 'provider response lost', deliveryOutcome: 'uncertain' });
  const unknownText = () => InvoiceService.sendReceipt.mockRejectedValueOnce(
    Object.assign(new Error('receipt SMS blocked: PROVIDER_FAILURE'), { providerOutcome: { deliveryOutcome: 'uncertain', blocked: false } }),
  );

  test('delivery is read from the structured outcome, never the message text', async () => {
    // A message that LOOKS like a timeout but carries a definite outcome is not unknown...
    sendReceiptEmail.mockResolvedValueOnce({ ok: false, error: 'request timed out validating the PDF', deliveryOutcome: 'not_sent' });
    InvoiceService.sendReceipt.mockRejectedValueOnce(Object.assign(new Error('timeout'), { providerOutcome: { deliveryOutcome: 'not_sent', blocked: true } }));
    expect((await sendInvoiceReceipt(ID, { via: 'both' })).delivery).toEqual({ email: 'not_sent', sms: 'not_sent' });
    // ...and an uncertain outcome is unknown whatever the text says.
    unknownEmail();
    unknownText();
    expect((await sendInvoiceReceipt(ID, { via: 'both' })).delivery).toEqual({ email: 'unknown', sms: 'unknown' });
    // Accepted, not requested, and an untagged (pre-dispatch) throw.
    InvoiceService.sendReceipt.mockRejectedValueOnce(new Error('template lookup failed'));
    expect((await sendInvoiceReceipt(ID, { via: 'both' })).delivery).toEqual({ email: 'sent', sms: 'not_sent' });
    expect((await sendInvoiceReceipt(ID, { via: 'email' })).delivery).toEqual({ email: 'sent', sms: 'not_requested' });
  });

  test('a text the provider accepted before its bookkeeping threw is a delivered receipt', async () => {
    InvoiceService.sendReceipt.mockRejectedValueOnce(
      Object.assign(new Error('audit write failed'), { providerOutcome: { deliveryOutcome: 'accepted', blocked: false } }),
    );
    const out = await sendInvoiceReceipt(ID, { via: 'sms' });
    expect(out.delivery).toEqual({ email: 'not_requested', sms: 'sent' });
    expect(out.status).toBe(200);
    expect(out.body.ok).toBe(true);
    expect(out.body.sms).toEqual({ ok: true });
  });

  test('default (the route): the claim is released with no hold flag at all, and the body keeps its shape', async () => {
    unknownEmail();
    const out = await sendInvoiceReceipt(ID, { via: 'email' });
    expect(releaseOperatorReceiptClaim.mock.calls[0][1]).not.toHaveProperty('holdForReconciliation');
    expect(out.body.email).toEqual({ ok: false, error: 'provider response lost', deliveryOutcome: 'uncertain' });
    expect(Object.keys(out.body.sms)).toEqual(['ok', 'skipped']);
  });

  test('opt-in: an unknown email or text outcome with the email undelivered holds the job', async () => {
    unknownEmail();
    await sendInvoiceReceipt(ID, { via: 'email', holdUnknownOutcome: true });
    expect(releaseOperatorReceiptClaim).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ holdForReconciliation: true }));
    sendReceiptEmail.mockResolvedValueOnce({ ok: false, error: 'PDF generation failed' });
    unknownText();
    await sendInvoiceReceipt(ID, { via: 'both', holdUnknownOutcome: true });
    expect(releaseOperatorReceiptClaim).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ holdForReconciliation: true }));
  });

  test('opt-in but nothing unknown, or the email was delivered: no hold', async () => {
    sendReceiptEmail.mockResolvedValueOnce({ ok: false, error: 'PDF generation failed' });
    await sendInvoiceReceipt(ID, { via: 'email', holdUnknownOutcome: true });
    expect(releaseOperatorReceiptClaim.mock.calls[0][1]).not.toHaveProperty('holdForReconciliation');
    unknownText();
    await sendInvoiceReceipt(ID, { via: 'both', holdUnknownOutcome: true });
    expect(releaseOperatorReceiptClaim.mock.calls[1][1]).not.toHaveProperty('holdForReconciliation');
  });
});

describe('expect — the writer owns the final check, under the claim and ahead of every effect', () => {
  const approved = { receipt_state: 'unsent', amount: '129.00' };

  test('an unchanged re-derivation proceeds, and the re-check runs after the claim and before the closeout and both legs', async () => {
    const rederive = jest.fn(async () => ({ ...approved }));
    const out = await sendInvoiceReceipt(ID, { via: 'both', expect: { approved, rederive } });
    expect(out.status).toBe(200);
    expect(rederive).toHaveBeenCalledWith({ ownClaimToken: 'claim-1' });
    const at = rederive.mock.invocationCallOrder[0];
    expect(claimReceiptJobForOperatorSend.mock.invocationCallOrder[0]).toBeLessThan(at);
    expect(at).toBeLessThan(closeOutVisitForIssuedInvoice.mock.invocationCallOrder[0]);
    expect(at).toBeLessThan(sendReceiptEmail.mock.invocationCallOrder[0]);
    expect(at).toBeLessThan(InvoiceService.sendReceipt.mock.invocationCallOrder[0]);
  });

  test.each([
    ['a changed value (recipients, amount, linked visit or a receipt stamped since)', async () => ({ ...approved, amount: '99.00' })],
    ['a blocker (null)', async () => null],
    ['a re-check that throws', async () => { throw new Error('read failed'); }],
  ])('%s: 409 receipt_approval_changed, no closeout, no leg, nothing stamped, claim handed back untouched', async (_label, rederive) => {
    releaseOperatorReceiptClaim.mockResolvedValueOnce('returned_to_queue');
    const out = await sendInvoiceReceipt(ID, { via: 'both', holdUnknownOutcome: true, expect: { approved, rederive } });
    expect(out).toEqual({ status: 409, body: expect.objectContaining({ code: 'receipt_approval_changed' }), queue: 'returned_to_queue' });
    expect(closeOutVisitForIssuedInvoice).not.toHaveBeenCalled();
    expect(sendReceiptEmail).not.toHaveBeenCalled();
    expect(InvoiceService.sendReceipt).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(activity).toEqual([]);
    // Released as "nothing delivered, nothing unknown": the queued job goes back as it was.
    expect(releaseOperatorReceiptClaim).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1' }), expect.objectContaining({ emailDelivered: false, smsDelivered: false }));
    expect(releaseOperatorReceiptClaim.mock.calls[0][1]).not.toHaveProperty('holdForReconciliation');
  });

  test('no expect (the route): no re-check at all, behavior unchanged', async () => {
    const out = await sendInvoiceReceipt(ID, { via: 'email' });
    expect(out.status).toBe(200);
    expect(out.body.ok).toBe(true);
  });

  test('the automatic job disposition from the release rides beside the body', async () => {
    releaseOperatorReceiptClaim.mockResolvedValueOnce('held_for_reconciliation');
    const out = await sendInvoiceReceipt(ID, { via: 'email' });
    expect(out.queue).toBe('held_for_reconciliation');
    expect(Object.keys(out.body).sort()).toEqual(['email', 'invoice', 'ok', 'sms']);
  });
});

describe('one send per invoice at a time (advisory lock)', () => {
  afterEach(() => { Object.assign(mockLock, { busy: false, reason: 'busy', lostAfter: Infinity }); });

  test('a send that finds the lock held is refused in flight with no effect at all', async () => {
    mockLock.busy = true;
    const out = await sendInvoiceReceipt(ID, { via: 'both' });
    expect(out).toEqual({ status: 409, body: { error: expect.stringMatching(/Another receipt send for this invoice is in progress/), code: 'receipt_delivery_in_flight' } });
    expect(claimReceiptJobForOperatorSend).not.toHaveBeenCalled();
    expect(closeOutVisitForIssuedInvoice).not.toHaveBeenCalled();
    expect(sendReceiptEmail).not.toHaveBeenCalled();
    expect(InvoiceService.sendReceipt).not.toHaveBeenCalled();
    expect(releaseOperatorReceiptClaim).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test('the stamp and the claim release both happen before the lock is released (the second send sees the stamp)', async () => {
    const order = [];
    releaseOperatorReceiptClaim.mockImplementationOnce(async () => { order.push('release'); return 'completed'; });
    db.mockImplementation((table) => {
      const q = {};
      q.where = jest.fn(() => q);
      q.first = jest.fn(async () => invoice);
      q.update = jest.fn(async (patch) => { order.push(`stamp:${Object.keys(patch).join(',')}`); return 1; });
      q.insert = jest.fn(() => Promise.resolve());
      return q;
    });
    await sendInvoiceReceipt(ID, { via: 'sms' });
    // text-only success: stamped, then released; the lock (the callback's return) comes after both.
    expect(order).toEqual(['stamp:receipt_sent_at,receipt_memo', 'release']);
  });
});

describe('ownership of the send lock is checked before each effect', () => {
  afterEach(() => { Object.assign(mockLock, { busy: false, reason: 'busy', lostAfter: Infinity }); });

  test('no lock session could be had (slots exhausted / connect failed): refused like in flight, no effects', async () => {
    Object.assign(mockLock, { busy: true, reason: 'unavailable' });
    const out = await sendInvoiceReceipt(ID, { via: 'both' });
    expect(out).toEqual({ status: 409, body: { error: expect.stringMatching(/could not start.*nothing was sent/), code: 'receipt_delivery_in_flight' } });
    expect(claimReceiptJobForOperatorSend).not.toHaveBeenCalled();
    expect(sendReceiptEmail).not.toHaveBeenCalled();
  });

  // The checks run in this order: claim (1), closeout (2), email (3), text (4), stamp (5).
  test.each([
    [0, 'before_claim', { claim: 0, closeout: 0, email: 0, text: 0, stamp: 0 }],
    [1, 'before_closeout', { claim: 1, closeout: 0, email: 0, text: 0, stamp: 0 }],
    [2, 'before_email', { claim: 1, closeout: 1, email: 0, text: 0, stamp: 0 }],
    [3, 'before_text', { claim: 1, closeout: 1, email: 1, text: 0, stamp: 0 }], // the stamp check then finds the lock lost too
    [4, 'before_stamp', { claim: 1, closeout: 1, email: 1, text: 1, stamp: 0 }],
  ])('lost after %i passing check(s) (%s): nothing later starts', async (lostAfter, step, ran) => {
    mockLock.lostAfter = lostAfter;
    const out = await sendInvoiceReceipt(ID, { via: 'both' });
    expect(claimReceiptJobForOperatorSend).toHaveBeenCalledTimes(ran.claim);
    expect(closeOutVisitForIssuedInvoice).toHaveBeenCalledTimes(ran.closeout);
    expect(sendReceiptEmail).toHaveBeenCalledTimes(ran.email);
    expect(InvoiceService.sendReceipt).toHaveBeenCalledTimes(ran.text);
    expect(updates.filter((u) => u.patch.receipt_sent_at)).toHaveLength(ran.stamp);
    if (step === 'before_claim') {
      expect(out).toMatchObject({ status: 409, body: { code: 'receipt_delivery_in_flight' } });
      expect(releaseOperatorReceiptClaim).not.toHaveBeenCalled();
      return;
    }
    // Reported honestly: legs that never ran are not sent ("send lock lost"), what ran keeps its verdict.
    expect(out.status).toBe(200);
    expect(out.lockLost).toBe(step);
    expect(out.delivery).toEqual({
      email: ran.email ? 'sent' : 'not_sent',
      sms: ran.text ? 'sent' : 'not_sent',
    });
    if (!ran.email) expect(out.body.email).toEqual({ ok: false, error: 'send lock lost' });
    if (!ran.text) expect(out.body.sms).toEqual({ ok: false, error: 'send lock lost' });
    // Our own claim is still handed back (cleanup, not a new effect).
    expect(releaseOperatorReceiptClaim).toHaveBeenCalledTimes(1);
    // Only a stamp for a receipt that went out can be skipped.
    expect(out.stampWritten).toBe((ran.email || ran.text) ? false : null);
  });

  test('a lock that is never lost changes nothing', async () => {
    const out = await sendInvoiceReceipt(ID, { via: 'both' });
    expect(out.lockLost).toBeNull();
    expect(out.stampWritten).toBe(true);
  });
});
