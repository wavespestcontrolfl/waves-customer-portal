/**
 * IB resend_receipt — the Invoices "Resend receipt" button as a carded write.
 * Preview (nothing sent, a re-send says so), the plain refusals, the confirmed
 * run (pins, drift, one shared writer, honest per-channel result), and the
 * admin-only rule. The shared writer's own behavior is in
 * invoice-receipt-resend.test.js and admin-invoices-send-receipt-claim.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/closeout-status', () => ({ getCloseoutStatus: jest.fn() }));
jest.mock('../services/service-report/pdf-queue', () => ({ ensureReportToken: jest.fn() }));
jest.mock('../services/service-report/delivery-queue', () => ({ enqueueServiceReportV1EmailDelivery: jest.fn() }));
jest.mock('../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn().mockResolvedValue(false) }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.example.test' }));
jest.mock('../services/completion-followup-booking', () => ({ bookCompletionFollowup: jest.fn() }));
jest.mock('../services/billing-recovery-bill', () => ({ assessVisitBillable: jest.fn(), billVisit: jest.fn(), previewBillVisit: jest.fn() }));
jest.mock('../services/invoice-email', () => ({ resolveReceiptEmailRecipient: jest.fn() }));
jest.mock('../services/invoice', () => ({
  explicitBillingAppSelected: jest.fn(async () => false),
  receiptAmountFor: jest.fn(async () => '129.00'),
}));
jest.mock('../services/receipt-delivery-queue', () => ({
  receiptEmailOptOutState: jest.fn(async () => ({ receiptKillSwitch: false, prefsLookupFailed: false })),
  expectedEmailSkip: jest.requireActual('../services/receipt-delivery-queue').expectedEmailSkip,
}));
jest.mock('../services/invoice-receipt-resend', () => ({ sendInvoiceReceipt: jest.fn() }));
jest.mock('../services/invoice-issued-closeout', () => ({ issuedCloseoutTarget: jest.fn(async () => null) }));
jest.mock('../config/feature-gates', () => ({ gates: { autoApplyAccountCredit: false } }));
jest.mock('../services/customer-credit', () => ({ customerAutoApplyEnabled: jest.fn(async () => true), getBalance: jest.fn(async () => 25) }));

const db = require('../models/db');
const Invoice = require('../services/invoice');
const { resolveReceiptEmailRecipient } = require('../services/invoice-email');
const { receiptEmailOptOutState } = require('../services/receipt-delivery-queue');
const { sendInvoiceReceipt } = require('../services/invoice-receipt-resend');
const { issuedCloseoutTarget } = require('../services/invoice-issued-closeout');
const { RECEIPT_RESEND_TOOLS, executeReceiptResendTool } = require('../services/intelligence-bar/receipt-resend-tools');
const gates = require('../services/intelligence-bar/write-gates');
const { executionOutcome } = require('../services/intelligence-bar/outcomes');
const { buildContract, previewFingerprint } = require('../services/intelligence-bar/authorization-contract');

const INV = '00000000-0000-0000-0000-00000000f001';
const SENT_AT = new Date('2026-10-02T18:14:00Z');
const CUSTOMER = { id: 'cust-1', first_name: 'Pat', last_name: 'Tester', email: 'pat@example.com', phone: '9415550100' };
const PAID = {
  id: INV, invoice_number: 'WPC-2026-0900', status: 'paid', receipt_sent_at: null, customer_id: 'cust-1', payer_id: null,
  paid_at: new Date('2026-10-01T15:00:00Z'),
};

// Table-keyed fake that honors object `where` filters (the running-job check needs them).
function fakeDb(tables) {
  const all = { customers: [CUSTOMER], invoices: [PAID], receipt_delivery_jobs: [], ...tables };
  return jest.fn((table) => {
    let rows = all[table] || [];
    const chain = {
      where: (cond) => {
        if (cond && typeof cond === 'object') rows = rows.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v));
        return chain;
      },
      whereIn: (column, values) => { rows = rows.filter((r) => values.includes(r[column])); return chain; },
      whereNot: (column, value) => { rows = rows.filter((r) => r[column] !== value); return chain; },
      first: async () => rows[0],
    };
    return chain;
  });
}

const run = (input, ctx) => executeReceiptResendTool('resend_receipt', { invoice_id: INV, ...input }, ctx);
// What the route does between the card and the click: re-run the preview and hand its _version to the executor.
const confirm = async (input = {}, ctx = {}) => {
  const preview = await run(input);
  return run({ ...input, confirmed: true, _verified_receipt_version: preview._version }, { technicianId: 'admin-1', ...ctx });
};

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation(fakeDb({}));
  resolveReceiptEmailRecipient.mockResolvedValue({ ok: true, recipient: { email: 'Pat@Example.com' }, customer: CUSTOMER });
  Invoice.receiptAmountFor.mockResolvedValue('129.00');
  issuedCloseoutTarget.mockResolvedValue(null);
  sendInvoiceReceipt.mockResolvedValue({ status: 200, body: { ok: true, email: { ok: true }, sms: { ok: true } }, closeout: null , delivery: { email: 'sent', sms: 'sent' } });
});

test('registered as an admin-only carded write with a uuid selector and the customer-contact label', () => {
  const tool = RECEIPT_RESEND_TOOLS.find((t) => t.name === 'resend_receipt');
  expect(tool.input_schema.properties.invoice_id.format).toBe('uuid');
  expect(tool.input_schema.properties.via.enum).toEqual(['email', 'sms', 'both']);
  expect(tool._sideEffects).toBe(true);
  expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has('resend_receipt')).toBe(true);
  const contract = buildContract({ toolName: 'resend_receipt', params: { invoice_id: INV }, preview: { preview: true } });
  expect(contract.notifies_customer).toBe(true);
  expect(contract.irreversible).toBe(true);
  expect(contract.action_label).toBe('Re-send a paid receipt');
});

test('an unsent invoice previews amount, paid date, channels and masked recipients — and sends nothing', async () => {
  const preview = await run({});
  expect(preview).toEqual(expect.objectContaining({
    preview: true, invoice_id: INV, invoice_number: 'WPC-2026-0900', amount: '129.00', paid_date: '2026-10-01',
    resend: false, receipt_status: 'No receipt is recorded as sent yet', channels: 'email and text',
  }));
  expect(preview.recipients).toBe("email to p***@example.com; text to ***0100, sent now if the customer's receipt settings allow");
  // The manual send's own resolver call: no billing category.
  expect(resolveReceiptEmailRecipient).toHaveBeenCalledWith(expect.objectContaining({ id: INV }), {});
  expect(Invoice.receiptAmountFor).toHaveBeenCalledWith(expect.objectContaining({ id: INV }), { failClosed: true });
  expect(sendInvoiceReceipt).not.toHaveBeenCalled();
  expect(executionOutcome(preview)).toBe('awaiting_approval');
});

test('an invoice whose receipt already went out previews as a RE-SEND with when it was sent', async () => {
  db.mockImplementation(fakeDb({ invoices: [{ ...PAID, receipt_sent_at: SENT_AT }] }));
  const preview = await run({});
  expect(preview.resend).toBe(true);
  expect(preview.receipt_status).toBe('Already sent on 2026-10-02 2:14 PM ET — this is a RE-SEND: the customer gets another receipt');
  const contract = buildContract({ toolName: 'resend_receipt', params: { invoice_id: INV }, preview });
  expect(contract.effects.some((e) => e.kind === 'comms' && /Customer will be contacted/.test(e.label))).toBe(true);
  expect(contract.effects.map((e) => e.label).join('\n')).toMatch(/RE-SEND/);
});

test('by invoice number: resolves to the invoice; an unknown number is a plain refusal', async () => {
  db.mockImplementation(fakeDb({}));
  const hit = await executeReceiptResendTool('resend_receipt', { invoice_number: ' wpc-2026-0900 ' });
  expect(hit.preview).toBe(true);
  db.mockImplementation(fakeDb({ invoices: [{ ...PAID, invoice_number: 'WPC-2026-0001' }] }));
  const miss = await executeReceiptResendTool('resend_receipt', { invoice_number: 'WPC-2026-0900' });
  expect(miss).toEqual(expect.objectContaining({ code: 'invoice_not_found' }));
  expect(miss.preview).toBeUndefined();
});

test('exactly one of invoice_id / invoice_number, and a valid via', async () => {
  expect(await executeReceiptResendTool('resend_receipt', {})).toEqual(expect.objectContaining({ code: 'invalid_target' }));
  expect(await executeReceiptResendTool('resend_receipt', { invoice_id: INV, invoice_number: 'WPC-2026-0900' })).toEqual(expect.objectContaining({ code: 'invalid_target' }));
  expect(await executeReceiptResendTool('resend_receipt', { invoice_id: 'not-a-uuid' })).toEqual(expect.objectContaining({ code: 'invalid_target' }));
  expect((await run({ via: 'carrier-pigeon' })).error).toMatch(/via must be/);
});

describe('plain refusals — nothing previewed, nothing sent', () => {
  test.each([
    ['invoice not found', { invoices: [] }, /invoice not found/],
    ['not paid', { invoices: [{ ...PAID, status: 'sent' }] }, /invoice is sent, not paid/],
    ['automatic receipt in flight', { receipt_delivery_jobs: [{ id: 'job-1', invoice_id: INV, status: 'running' }] }, /being delivered right now/],
  ])('%s', async (_name, tables, message) => {
    db.mockImplementation(fakeDb(tables));
    const out = await run({});
    expect(out.error).toMatch(message);
    expect(out.preview).toBeUndefined();
    expect(sendInvoiceReceipt).not.toHaveBeenCalled();
  });

  test('a queued (not running) automatic receipt does not block a resend', async () => {
    db.mockImplementation(fakeDb({ receipt_delivery_jobs: [{ id: 'job-1', invoice_id: INV, status: 'queued' }] }));
    expect((await run({})).preview).toBe(true);
  });

  test('customer opted out of receipts, or settings unreadable', async () => {
    receiptEmailOptOutState.mockResolvedValueOnce({ receiptKillSwitch: true, prefsLookupFailed: false });
    expect((await run({})).error).toMatch(/opted out of payment receipts/);
    receiptEmailOptOutState.mockResolvedValueOnce({ receiptKillSwitch: false, prefsLookupFailed: true });
    expect((await run({})).error).toMatch(/receipt settings could not be read/);
  });

  test('no recipient on file; email-only with no email; text-only for a payer-billed invoice', async () => {
    db.mockImplementation(fakeDb({ customers: [{ ...CUSTOMER, phone: null }] }));
    resolveReceiptEmailRecipient.mockResolvedValueOnce({ ok: false, error: 'No receipt recipient email' });
    expect((await run({})).error).toMatch(/No receipt recipient email/);
    resolveReceiptEmailRecipient.mockResolvedValueOnce({ ok: false, error: 'No receipt recipient email' });
    db.mockImplementation(fakeDb({}));
    expect((await run({ via: 'email' })).error).toMatch(/no receipt email on file/);
    db.mockImplementation(fakeDb({ invoices: [{ ...PAID, payer_id: 'payer-1' }] }));
    expect((await run({ via: 'sms' })).error).toMatch(/payer-billed receipt is never texted/);
  });

  test('an unverifiable amount refuses (fail closed)', async () => {
    Invoice.receiptAmountFor.mockRejectedValueOnce(new Error('payments read failed'));
    expect((await run({})).error).toMatch(/amount could not be verified/);
  });
});

test('confirmed: sends through the shared writer with the pinned channels, memo and unsent state, and says so per channel', async () => {
  const result = await confirm({ via: 'both', memo: '  Thanks for your business  ' });
  expect(sendInvoiceReceipt).toHaveBeenCalledTimes(1);
  // An unknown provider outcome must park a claimed automatic job, not re-queue it.
  // The writer also gets the approved version and a way to re-derive it: its own check, under its claim.
  expect(sendInvoiceReceipt).toHaveBeenCalledWith(INV, {
    memo: 'Thanks for your business', via: 'both', actorTechnicianId: 'admin-1', sawUnsent: true, holdUnknownOutcome: true,
    expect: { approved: expect.objectContaining({ invoice_id: INV, receipt_state: 'unsent' }), rederive: expect.any(Function) },
  });
  // No linked visit to close: the card and result say nothing about one.
  expect(result.visit_closeout).toBeUndefined();
  expect(result).toEqual(expect.objectContaining({ success: true, email: { status: 'sent' }, text: { status: 'sent' } }));
  expect(executionOutcome(result)).toBe('completed');
});

test('confirmed re-send: the claim is told the receipt was already stamped (sawUnsent false)', async () => {
  db.mockImplementation(fakeDb({ invoices: [{ ...PAID, receipt_sent_at: SENT_AT }] }));
  await confirm({ via: 'email' });
  expect(sendInvoiceReceipt).toHaveBeenCalledWith(INV, expect.objectContaining({ via: 'email', sawUnsent: false }));
});

test('confirmed without a verified card pin sends nothing', async () => {
  const out = await run({ confirmed: true });
  expect(out.error).toMatch(/confirmation card/);
  expect(sendInvoiceReceipt).not.toHaveBeenCalled();
});

describe('drift between the card and the click refuses — nothing sent', () => {
  const driftAfterPreview = async (mutate, input = {}) => {
    const preview = await run(input);
    mutate();
    return run({ ...input, confirmed: true, _verified_receipt_version: preview._version }, { technicianId: 'admin-1' });
  };

  test('a receipt sent in between (receipt_sent_at changed)', async () => {
    const out = await driftAfterPreview(() => db.mockImplementation(fakeDb({ invoices: [{ ...PAID, receipt_sent_at: SENT_AT }] })));
    expect(out).toEqual(expect.objectContaining({ preview_changed: true }));
    expect(sendInvoiceReceipt).not.toHaveBeenCalled();
  });

  test('a different recipient or amount', async () => {
    const recipient = await driftAfterPreview(() => resolveReceiptEmailRecipient.mockResolvedValue({ ok: true, recipient: { email: 'other@example.com' }, customer: CUSTOMER }));
    expect(recipient.preview_changed).toBe(true);
    resolveReceiptEmailRecipient.mockResolvedValue({ ok: true, recipient: { email: 'Pat@Example.com' }, customer: CUSTOMER });
    const amount = await driftAfterPreview(() => Invoice.receiptAmountFor.mockResolvedValue('99.00'));
    expect(amount.preview_changed).toBe(true);
    expect(sendInvoiceReceipt).not.toHaveBeenCalled();
  });

  test('the automatic receipt started delivering after the card', async () => {
    const out = await driftAfterPreview(() => db.mockImplementation(fakeDb({ receipt_delivery_jobs: [{ id: 'job-1', invoice_id: INV, status: 'running' }] })));
    expect(out.error).toMatch(/Nothing was sent/);
    expect(out.preview_changed).toBe(true);
    expect(sendInvoiceReceipt).not.toHaveBeenCalled();
  });

  test('same state → same fingerprint', async () => {
    expect(previewFingerprint(await run({}))).toBe(previewFingerprint(await run({})));
  });
});

describe('the writer refusing at the claim', () => {
  test.each([
    ['receipt_delivery_in_flight'],
    ['receipt_already_sent'],
  ])('%s: nothing sent, reported as changed', async (code) => {
    sendInvoiceReceipt.mockResolvedValue({ status: 409, body: { error: 'claim refused', code } });
    const out = await confirm({});
    expect(out).toEqual(expect.objectContaining({ code, preview_changed: true }));
    expect(out.error).toMatch(/Nothing was sent/);
  });
});

describe('honest per-channel results', () => {
  test('email sent, text skipped on the customer\'s own choice: still a clean success, with the reason', async () => {
    sendInvoiceReceipt.mockResolvedValue({ status: 200, body: { ok: true, email: { ok: true }, sms: { ok: false, error: 'channel_email_only' } } , delivery: { email: 'sent', sms: 'not_sent' } });
    const out = await confirm({});
    expect(out.success).toBe(true);
    expect(out.text).toEqual({ status: 'not_sent', detail: 'the customer chose email-only receipts', expected: true });
  });

  test('email sent, text failed for another reason: partial', async () => {
    sendInvoiceReceipt.mockResolvedValue({ status: 200, body: { ok: true, email: { ok: true }, sms: { ok: false, error: 'carrier rejected' } } , delivery: { email: 'sent', sms: 'not_sent' } });
    const out = await confirm({});
    expect(out.partial).toBe(true);
    expect(out.text).toEqual(expect.objectContaining({ status: 'not_sent', detail: 'carrier rejected' }));
    expect(executionOutcome(out)).toBe('partially_completed');
  });

  test('a provider timeout is unknown, never retried', async () => {
    sendInvoiceReceipt.mockResolvedValue({ status: 200, body: { ok: false, email: { ok: false, error: 'timeout of 10000ms exceeded' }, sms: { ok: false, skipped: true } } , delivery: { email: 'unknown', sms: 'not_requested' } });
    const out = await confirm({ via: 'email' });
    expect(out.outcome_unknown).toBe(true);
    expect(out.email.status).toBe('unknown');
    expect(out.text).toEqual({ status: 'not_requested' });
    expect(sendInvoiceReceipt).toHaveBeenCalledTimes(1);
    expect(executionOutcome(out)).toBe('outcome_unknown');
    // An unknown leg is never worded as not sent.
    expect(out.note).toMatch(/could not be confirmed/);
    expect(out.note).not.toMatch(/was not sent|did not go out/);
  });

  test('one leg sent and one unknown: the summary says unconfirmed, not "did not go out"', async () => {
    sendInvoiceReceipt.mockResolvedValue({ status: 200, body: { ok: true, email: { ok: true }, sms: { ok: false, error: 'receipt SMS blocked: PROVIDER_FAILURE' } }, closeout: null, delivery: { email: 'sent', sms: 'unknown' } });
    const out = await confirm({ via: 'both' });
    expect(out.note).toMatch(/could not be confirmed/);
    expect(out.note).not.toMatch(/did not go out/);
  });

  test('unknown comes from the writer\'s structured delivery verdict, not the error text', async () => {
    // A text failure whose message is the real "receipt SMS blocked: PROVIDER_FAILURE" (no timeout wording) but whose outcome is uncertain.
    sendInvoiceReceipt.mockResolvedValue({ status: 200, body: { ok: false, email: { ok: false, skipped: true }, sms: { ok: false, error: 'receipt SMS blocked: PROVIDER_FAILURE' } }, closeout: null, delivery: { email: 'not_requested', sms: 'unknown' } });
    const unknown = await confirm({ via: 'sms' });
    expect(unknown.outcome_unknown).toBe(true);
    expect(unknown.text.status).toBe('unknown');
    // And error text that merely mentions a timeout, with a definite verdict, is not unknown.
    sendInvoiceReceipt.mockResolvedValue({ status: 200, body: { ok: false, email: { ok: false, error: 'request timed out while building the PDF' }, sms: { ok: false, skipped: true } }, closeout: null, delivery: { email: 'not_sent', sms: 'not_requested' } });
    const definite = await confirm({ via: 'email' });
    expect(definite.failed).toBe(true);
    expect(definite.email.status).toBe('not_sent');
  });

  test('nothing delivered: a failure that names the reasons', async () => {
    sendInvoiceReceipt.mockResolvedValue({ status: 200, body: { ok: false, email: { ok: false, error: 'PDF generation failed' }, sms: { ok: false, error: 'no-phone' } } , delivery: { email: 'not_sent', sms: 'not_sent' } });
    const out = await confirm({});
    expect(out.failed).toBe(true);
    expect(out.email.detail).toBe('PDF generation failed');
    expect(out.text.detail).toBe('no phone on file');
    expect(executionOutcome(out)).toBe('failed');
  });

  test('a throw during an approved send is outcome-unknown, not a retryable error', async () => {
    sendInvoiceReceipt.mockRejectedValue(new Error('connection lost'));
    const out = await confirm({});
    expect(out).toEqual(expect.objectContaining({ outcome_unknown: true, code: 'execution_interrupted' }));
  });
});

describe('the visit closeout the shared writer runs ahead of the legs', () => {
  const VISIT = { visitId: '00000000-0000-0000-0000-00000000f0a1', serviceType: 'Pest Control', date: '2026-09-30', resuming: false };

  test('gate off or nothing to close: the card says nothing extra and the pin carries no visit', async () => {
    const preview = await run({});
    expect(preview.visit_closeout).toBeUndefined();
    expect(preview._version.closeout_visit).toBeNull();
    expect(issuedCloseoutTarget).toHaveBeenCalledWith(expect.objectContaining({ id: INV }), { trigger: 'paid' });
  });

  test('a visit the closeout would complete is named on the card, shown in the contract, and pinned', async () => {
    issuedCloseoutTarget.mockResolvedValue(VISIT);
    const preview = await run({});
    expect(preview.visit_closeout).toBe('Also completes the linked visit — Pest Control on 2026-09-30: creates its service record, even if the receipt itself does not go out; no completion text, report, review request or charge');
    expect(preview._version.closeout_visit).toBe(VISIT.visitId);
    const contract = buildContract({ toolName: 'resend_receipt', params: { invoice_id: INV }, preview });
    expect(contract.effects.map((e) => e.label).join('\n')).toMatch(/Also completes the linked visit — Pest Control on 2026-09-30/);
    issuedCloseoutTarget.mockResolvedValue({ ...VISIT, resuming: true });
    expect((await run({})).visit_closeout).toMatch(/Also finishes a closeout already started for the linked visit/);
  });

  test('drift: the visit appearing, changing or disappearing after the card refuses and sends nothing', async () => {
    const appeared = async (before, after) => {
      issuedCloseoutTarget.mockResolvedValue(before);
      const preview = await run({});
      issuedCloseoutTarget.mockResolvedValue(after);
      return run({ confirmed: true, _verified_receipt_version: preview._version }, { technicianId: 'admin-1' });
    };
    expect((await appeared(null, VISIT)).preview_changed).toBe(true);
    expect((await appeared(VISIT, { ...VISIT, visitId: '00000000-0000-0000-0000-00000000f0a2' })).preview_changed).toBe(true);
    expect((await appeared(VISIT, null)).preview_changed).toBe(true);
    expect(sendInvoiceReceipt).not.toHaveBeenCalled();
  });

  test('the closeout probe failing blocks the card (fail closed)', async () => {
    issuedCloseoutTarget.mockRejectedValue(new Error('profile read failed'));
    const out = await run({});
    expect(out.error).toMatch(/closeout could not be checked/);
    expect(out.preview).toBeUndefined();
  });

  test('the result reports the closeout outcome, including a visit completed while no receipt went out', async () => {
    issuedCloseoutTarget.mockResolvedValue(VISIT);
    sendInvoiceReceipt.mockResolvedValue({ status: 200, body: { ok: true, email: { ok: true }, sms: { ok: true } }, closeout: { closed: true, visitId: VISIT.visitId } , delivery: { email: 'sent', sms: 'sent' } });
    const ok = await confirm({});
    expect(ok).toEqual(expect.objectContaining({ success: true, visit_closeout: { status: 'completed', visit_id: VISIT.visitId } }));

    sendInvoiceReceipt.mockResolvedValue({ status: 200, body: { ok: false, email: { ok: false, error: 'PDF generation failed' }, sms: { ok: false, error: 'no-phone' } }, closeout: { closed: true, visitId: VISIT.visitId } , delivery: { email: 'not_sent', sms: 'not_sent' } });
    const none = await confirm({});
    expect(none.partial).toBe(true);
    expect(none.failed).toBeUndefined();
    expect(none.visit_closeout).toEqual({ status: 'completed', visit_id: VISIT.visitId });
    expect(none.note).toMatch(/linked visit was completed/);
    expect(executionOutcome(none)).toBe('partially_completed');

    sendInvoiceReceipt.mockResolvedValue({ status: 200, body: { ok: true, email: { ok: true }, sms: { ok: true } }, closeout: { closed: false, reason: 'visit_in_future', visitId: VISIT.visitId } , delivery: { email: 'sent', sms: 'sent' } });
    const refused = await confirm({});
    expect(refused.partial).toBe(true);
    expect(refused.visit_closeout).toEqual({ status: 'not_completed', visit_id: VISIT.visitId, detail: 'visit_in_future' });
  });

  test('an unknown outcome with a completed visit stays outcome-unknown and still reports the visit', async () => {
    issuedCloseoutTarget.mockResolvedValue(VISIT);
    sendInvoiceReceipt.mockResolvedValue({ status: 200, body: { ok: false, email: { ok: false, error: 'timeout of 10000ms exceeded' }, sms: { ok: false, skipped: true } }, closeout: { closed: true, visitId: VISIT.visitId } , delivery: { email: 'unknown', sms: 'not_requested' } });
    const out = await confirm({ via: 'email' });
    expect(out.outcome_unknown).toBe(true);
    expect(out.visit_closeout.status).toBe('completed');
    // The queue's own disposition decides what is said about the automatic job — never the unknown leg alone.
    expect(out.email.detail).not.toMatch(/retried|held/);
  });
});

describe('the writer\'s final check: the tool hands it the approved version and a re-derivation that uses the preview\'s own functions', () => {
  const rederiveFor = async (input = {}) => {
    const preview = await run(input);
    await run({ ...input, confirmed: true, _verified_receipt_version: preview._version }, { technicianId: 'admin-1' });
    return { preview, expectArg: sendInvoiceReceipt.mock.calls.at(-1)[1].expect };
  };

  test('re-deriving unchanged state returns exactly the approved version', async () => {
    const { preview, expectArg } = await rederiveFor({});
    expect(expectArg.approved).toEqual(preview._version);
    expect(await expectArg.rederive({ ownClaimToken: null })).toEqual(preview._version);
  });

  test.each([
    ['a different recipient', () => resolveReceiptEmailRecipient.mockResolvedValue({ ok: true, recipient: { email: 'other@example.com' }, customer: CUSTOMER })],
    ['a different amount', () => Invoice.receiptAmountFor.mockResolvedValue('99.00')],
    ['a different linked visit', () => issuedCloseoutTarget.mockResolvedValue({ visitId: '00000000-0000-0000-0000-00000000f0a9', serviceType: 'Pest Control', date: '2026-09-30', resuming: false })],
    ['a receipt stamped by a resend that landed first', () => db.mockImplementation(fakeDb({ invoices: [{ ...PAID, receipt_sent_at: SENT_AT }] }))],
  ])('%s after approval re-derives to something else (the writer then refuses)', async (_label, mutate) => {
    const { preview, expectArg } = await rederiveFor({});
    mutate();
    expect(await expectArg.rederive({ ownClaimToken: null })).not.toEqual(preview._version);
  });

  test('a blocker at re-check time is null (the writer refuses on it)', async () => {
    const { expectArg } = await rederiveFor({});
    db.mockImplementation(fakeDb({ invoices: [{ ...PAID, status: 'sent' }] }));
    expect(await expectArg.rederive({ ownClaimToken: null })).toBeNull();
  });

  test('the writer\'s own claim row is not a "running automatic receipt": only another holder blocks the re-check', async () => {
    const { preview, expectArg } = await rederiveFor({});
    db.mockImplementation(fakeDb({ receipt_delivery_jobs: [{ id: 'job-1', invoice_id: INV, status: 'running', locked_by: 'operator:me' }] }));
    expect(await expectArg.rederive({ ownClaimToken: 'operator:me' })).toEqual(preview._version);
    expect(await expectArg.rederive({ ownClaimToken: 'operator:other' })).toBeNull();
    expect(await expectArg.rederive({ ownClaimToken: null })).toBeNull();
  });

  test('the card discloses a queued automatic receipt (not pinned: the claim handles it)', async () => {
    db.mockImplementation(fakeDb({ receipt_delivery_jobs: [{ id: 'job-1', invoice_id: INV, status: 'queued' }] }));
    const preview = await run({});
    expect(preview.automatic_receipt).toMatch(/goes back in the queue and will try again on its own/);
    expect(JSON.stringify(preview._version)).not.toMatch(/job|queued/);
    db.mockImplementation(fakeDb({}));
    expect((await run({})).automatic_receipt).toBeUndefined();
  });
});

describe('result wording comes only from what the writer reported about the automatic receipt job', () => {
  const sent = { status: 200, body: { ok: true, email: { ok: true }, sms: { ok: true } }, closeout: null, delivery: { email: 'sent', sms: 'sent' } };
  const emailFailed = { status: 200, body: { ok: false, email: { ok: false, error: 'PDF generation failed' }, sms: { ok: false, skipped: true } }, closeout: null, delivery: { email: 'not_sent', sms: 'not_requested' } };
  const emailFailedTextSent = { status: 200, body: { ok: true, email: { ok: false, error: 'PDF generation failed' }, sms: { ok: true } }, closeout: null, delivery: { email: 'not_sent', sms: 'sent' } };
  const unknownEmail = { status: 200, body: { ok: false, email: { ok: false, error: 'provider response lost' }, sms: { ok: false, skipped: true } }, closeout: null, delivery: { email: 'unknown', sms: 'not_requested' } };

  test.each([
    ['definite email failure, job back in the queue: says it will be retried automatically — never "not retried"', emailFailed, 'returned_to_queue', /back in the queue and will try again on its own/, /NOT retried|nothing else will send/i],
    ['text sent, email failed, job back in the queue: says the email will go automatically', emailFailedTextSent, 'returned_to_queue', /back in the queue and will try again on its own/, /NOT re-sent|nothing else will send/i],
    ['email failed and no automatic job exists: says nothing else will send it', emailFailed, 'removed', /No automatic receipt is waiting in the queue, so nothing else will send this receipt/, /back in the queue/],
    ['email failed and the job was already finished: same', emailFailed, 'none', /nothing else will send this receipt/, /back in the queue/],
    ['unknown outcome, job held: says the queue will not send it again and to check first', unknownEmail, 'held_for_reconciliation', /held, not re-queued: the queue will not send it again\. Check whether the customer got the receipt/, /back in the queue/],
    ['job could not be settled: says the queue recovers it and may email again', emailFailed, 'release_failed', /could not be settled here; the queue recovers it on its own and may email the customer the receipt again/, /nothing else will send/],
    ['everything sent and the job closed: says nothing about the queue', sent, 'completed', /^The receipt was sent\.$/, /queue/],
    ['everything sent but a job went back to the queue (a text-only resend): still says it will email on its own', sent, 'returned_to_queue', /The receipt was sent\. The automatic receipt .* back in the queue/, /nothing else/],
  ])('%s', async (_label, writerResult, queue, mustMatch, mustNotMatch) => {
    sendInvoiceReceipt.mockResolvedValue({ ...writerResult, queue });
    const out = await confirm({});
    expect(out.automatic_receipt).toBe(queue);
    expect(out.note).toMatch(mustMatch);
    expect(out.note).not.toMatch(mustNotMatch);
  });

  test('no result sentence promises "not retried" / "not re-sent" unconditionally', async () => {
    for (const queue of ['returned_to_queue', 'removed', 'none', 'completed', 'held_for_reconciliation', 'release_failed', undefined]) {
      for (const r of [sent, emailFailed, emailFailedTextSent, unknownEmail]) {
        sendInvoiceReceipt.mockResolvedValue({ ...r, queue });
        const out = await confirm({});
        expect(JSON.stringify(out)).not.toMatch(/NOT retried|NOT re-sent|never retried|it is not retried/i);
      }
    }
  });

  test.each([
    ['before_text', { email: 'sent', sms: 'not_sent' }, /lost partway through \(before the text\).*not sent with "send lock lost" never ran/],
    ['before_email', { email: 'not_sent', sms: 'not_sent' }, /before the email/],
  ])('the send lock lost %s: per-leg verdicts stay honest and the wording says what never ran', async (step, delivery, mustMatch) => {
    const emailOk = delivery.email === 'sent';
    sendInvoiceReceipt.mockResolvedValue({
      status: 200,
      body: { ok: emailOk, email: emailOk ? { ok: true } : { ok: false, error: 'send lock lost' }, sms: { ok: false, error: 'send lock lost' } },
      closeout: null, delivery, queue: 'returned_to_queue', lockLost: step, stampWritten: emailOk ? false : null,
    });
    const out = await confirm({});
    expect(out.send_lock_lost).toBe(step);
    expect(out.text).toEqual(expect.objectContaining({ status: 'not_sent', detail: 'send lock lost' }));
    expect(out.note).toMatch(mustMatch);
    expect(out.partial === true || out.failed === true).toBe(true);
    if (emailOk) {
      expect(out.receipt_stamp_written).toBe(false);
      expect(out.note).toMatch(/sent-time stamp was not recorded/);
    }
  });

  test('the writer refusing at its own final check reports changed state and nothing sent', async () => {
    sendInvoiceReceipt.mockResolvedValue({ status: 409, body: { error: 'changed after it was approved', code: 'receipt_approval_changed' }, queue: 'returned_to_queue' });
    const out = await confirm({});
    expect(out).toEqual(expect.objectContaining({ code: 'receipt_approval_changed', preview_changed: true }));
    expect(out.error).toMatch(/Nothing was sent/);
  });
});

test('a non-admin actor is refused before anything is read', async () => {
  const out = await executeReceiptResendTool('resend_receipt', { invoice_id: INV }, { isAdmin: false });
  expect(out).toEqual({ error: 'Receipt re-sends are limited to admin accounts', code: 'permission_denied' });
  expect(db).not.toHaveBeenCalled();
  expect(sendInvoiceReceipt).not.toHaveBeenCalled();
});
