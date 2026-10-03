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
const { sendInvoiceReceipt, isUnknownOutcome } = require('../services/invoice-receipt-resend');

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
  const unknownEmail = () => sendReceiptEmail.mockRejectedValueOnce(new Error('timeout of 10000ms exceeded'));

  test('what counts as an unknown outcome', () => {
    for (const e of ['timeout of 10000ms exceeded', 'ETIMEDOUT', 'socket hang up', 'Request timed out', 'ECONNRESET']) expect(isUnknownOutcome(e)).toBe(true);
    for (const e of ['PDF generation failed', 'no-phone', undefined, '']) expect(isUnknownOutcome(e)).toBe(false);
  });

  test('default (the route): the claim is released with no hold flag at all', async () => {
    unknownEmail();
    await sendInvoiceReceipt(ID, { via: 'email' });
    expect(releaseOperatorReceiptClaim.mock.calls[0][1]).not.toHaveProperty('holdForReconciliation');
  });

  test('opt-in: an unknown email or text outcome with the email undelivered holds the job', async () => {
    unknownEmail();
    await sendInvoiceReceipt(ID, { via: 'email', holdUnknownOutcome: true });
    expect(releaseOperatorReceiptClaim).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ holdForReconciliation: true }));
    sendReceiptEmail.mockResolvedValueOnce({ ok: false, error: 'PDF generation failed' });
    InvoiceService.sendReceipt.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    await sendInvoiceReceipt(ID, { via: 'both', holdUnknownOutcome: true });
    expect(releaseOperatorReceiptClaim).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ holdForReconciliation: true }));
  });

  test('opt-in but nothing unknown, or the email was delivered: no hold', async () => {
    sendReceiptEmail.mockResolvedValueOnce({ ok: false, error: 'PDF generation failed' });
    await sendInvoiceReceipt(ID, { via: 'email', holdUnknownOutcome: true });
    expect(releaseOperatorReceiptClaim.mock.calls[0][1]).not.toHaveProperty('holdForReconciliation');
    InvoiceService.sendReceipt.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    await sendInvoiceReceipt(ID, { via: 'both', holdUnknownOutcome: true });
    expect(releaseOperatorReceiptClaim.mock.calls[1][1]).not.toHaveProperty('holdForReconciliation');
  });
});
