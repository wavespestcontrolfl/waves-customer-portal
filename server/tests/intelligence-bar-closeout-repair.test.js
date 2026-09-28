/**
 * IB closeout repair command (W3) — plan (two-step preview) and the
 * itemized confirmed run over the canonical closeout-status service.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/closeout-status', () => ({ getCloseoutStatus: jest.fn() }));
jest.mock('../services/service-report/pdf-queue', () => ({ ensureReportToken: jest.fn() }));
jest.mock('../services/service-report/delivery-queue', () => ({ enqueueServiceReportV1EmailDelivery: jest.fn() }));
jest.mock('../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn().mockResolvedValue(false) }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.example.test' }));
jest.mock('../services/receipt-delivery-queue', () => ({
  enqueueReceiptDelivery: jest.fn(),
  receiptEmailOptOutState: jest.fn(async () => ({ receiptKillSwitch: false, prefsLookupFailed: false })),
}));
jest.mock('../services/invoice-email', () => ({ resolveReceiptEmailRecipient: jest.fn() }));
jest.mock('../services/invoice', () => ({ explicitBillingAppSelected: jest.fn(async () => false) }));

const db = require('../models/db');
const { getCloseoutStatus } = require('../services/closeout-status');
const { ensureReportToken } = require('../services/service-report/pdf-queue');
const { enqueueServiceReportV1EmailDelivery } = require('../services/service-report/delivery-queue');
const { enqueueReceiptDelivery, receiptEmailOptOutState } = require('../services/receipt-delivery-queue');
const { resolveReceiptEmailRecipient } = require('../services/invoice-email');
const { explicitBillingAppSelected } = require('../services/invoice');
const { CLOSEOUT_REPAIR_TOOLS, executeCloseoutRepairTool } = require('../services/intelligence-bar/closeout-repair-tools');
const gates = require('../services/intelligence-bar/write-gates');
const { executionOutcome } = require('../services/intelligence-bar/outcomes');
const { buildContract, previewFingerprint } = require('../services/intelligence-bar/authorization-contract');

const SVC = '00000000-0000-0000-0000-00000000d001';

// Table-keyed fake: first() answers from `tables`, writes are not expected
// through this handle (every write goes through a mocked service function).
// Fixture customer (no real PII): the recipient resolvers read it.
const CUSTOMER = { id: 'cust-1', first_name: 'Pat', last_name: 'Tester', email: 'pat@example.com', phone: '9415550100' };

function fakeDb(tables) {
  const all = { customers: [CUSTOMER], ...tables };
  return jest.fn((table) => {
    const chain = {
      where: () => chain,
      first: async () => (all[table] || [])[0],
    };
    return chain;
  });
}

function status({ facts = {}, packet = null } = {}) {
  const base = Object.fromEntries(['completion', 'application', 'photos', 'report', 'reportDelivery', 'invoice', 'invoiceDelivery', 'comms', 'followUp', 'license']
    .map((n) => [n, { state: 'done', reason: 'x' }]));
  return {
    found: true,
    packet,
    visit: { customerId: 'cust-1', technicianId: 'tech-1' },
    record: { id: 'rec-1' },
    reportRecordId: 'rec-1',
    summary: { closedOut: false },
    facts: { ...base, ...facts },
  };
}

const RECORD = {
  id: 'rec-1', status: 'completed', report_template_version: 'service_report_v1',
  report_view_token: null, structured_notes: {}, recap_sms_sent_at: null, customer_id: 'cust-1', scheduled_service_id: SVC,
  service_line: 'pest', service_type: 'Pest Control',
};

const MISSING_REPORT = {
  report: { state: 'pending', reason: 'no_report_artifact', posture: 'auto_send' },
  reportDelivery: { state: 'pending', reason: 'report_not_published', posture: 'auto_send' },
};

let env;
beforeEach(() => {
  jest.clearAllMocks();
  env = process.env.SERVICE_REPORT_EMAIL_DELIVERY_ENABLED;
  process.env.SERVICE_REPORT_EMAIL_DELIVERY_ENABLED = 'true';
});
afterEach(() => {
  if (env === undefined) delete process.env.SERVICE_REPORT_EMAIL_DELIVERY_ENABLED;
  else process.env.SERVICE_REPORT_EMAIL_DELIVERY_ENABLED = env;
});

test('registered as a two-step write with a uuid selector', () => {
  const tool = CLOSEOUT_REPAIR_TOOLS.find((t) => t.name === 'repair_closeout');
  expect(tool.input_schema.properties.service_id.format).toBe('uuid');
  expect(gates.WRITE_TWO_STEP_TOOL_NAMES.has('repair_closeout')).toBe(true);
});

test('unconfirmed: plans publish + email for a missing report, writes nothing, card says customer contact', async () => {
  getCloseoutStatus.mockResolvedValue(status({ facts: MISSING_REPORT }));
  db.mockImplementation(fakeDb({ service_records: [RECORD] }));
  const preview = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
  expect(preview.preview).toBe(true);
  expect(preview.steps.map((s) => s.step)).toEqual(['publish_report', 'queue_report_email']);
  expect(preview.steps[1].depends_on).toBe('publish_report');
  expect(preview.notifies_customer).toBe(true);
  expect(ensureReportToken).not.toHaveBeenCalled();
  expect(enqueueServiceReportV1EmailDelivery).not.toHaveBeenCalled();
  expect(executionOutcome(preview)).toBe('awaiting_approval');

  const contract = buildContract({ toolName: 'repair_closeout', params: { service_id: SVC }, preview });
  expect(contract.notifies_customer).toBe(true);
  expect(contract.effects.map((e) => e.label).join('\n')).toMatch(/Publish the service report link/);
  expect(contract.effects.some((e) => e.kind === 'comms' && /report email/.test(e.label))).toBe(true);
  // Same state → same fingerprint (the confirm-time drift check binds it).
  const again = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
  expect(previewFingerprint(again)).toBe(previewFingerprint(preview));
});

test('internal_only / backfill / flag-off postures never plan an email', async () => {
  getCloseoutStatus.mockResolvedValue(status({ facts: {
    report: { state: 'pending', reason: 'no_report_artifact', posture: 'internal_only' },
    reportDelivery: { state: 'not_required', reason: 'frozen_posture_internal_only' },
  } }));
  db.mockImplementation(fakeDb({ service_records: [RECORD] }));
  let preview = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
  expect(preview.steps.map((s) => s.step)).toEqual(['publish_report']);
  expect(preview.notifies_customer).toBe(false);

  getCloseoutStatus.mockResolvedValue(status({ facts: MISSING_REPORT }));
  db.mockImplementation(fakeDb({ service_records: [{ ...RECORD, structured_notes: { backfill: true } }] }));
  preview = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
  expect(preview.steps.map((s) => s.step)).toEqual(['publish_report']);
  expect(preview.manual).toEqual(expect.arrayContaining([expect.objectContaining({ fact: 'reportDelivery', fix: expect.stringMatching(/backfill/) })]));

  process.env.SERVICE_REPORT_EMAIL_DELIVERY_ENABLED = 'false';
  db.mockImplementation(fakeDb({ service_records: [RECORD] }));
  preview = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
  expect(preview.steps.map((s) => s.step)).toEqual(['publish_report']);
});

test('grouped visits and existing delivery rows leave the email to their owners', async () => {
  getCloseoutStatus.mockResolvedValue(status({ facts: MISSING_REPORT, packet: { id: 'pkt-1' } }));
  db.mockImplementation(fakeDb({ service_records: [RECORD] }));
  let preview = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
  expect(preview.steps.map((s) => s.step)).toEqual(['publish_report']);

  getCloseoutStatus.mockResolvedValue(status({ facts: {
    reportDelivery: { state: 'pending', reason: 'not_enqueued', posture: 'auto_send' },
  } }));
  db.mockImplementation(fakeDb({ service_records: [{ ...RECORD, report_view_token: 'a'.repeat(32) }], service_report_deliveries: [{ id: 'del-1' }] }));
  const res = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
  expect(res.code).toBe('nothing_repairable');
  expect(res.manual[0]).toEqual(expect.objectContaining({ fact: 'reportDelivery', fix: expect.stringMatching(/already exists/) }));
});

test('completion not done: nothing planned, completion is the only manual item', async () => {
  getCloseoutStatus.mockResolvedValue(status({ facts: {
    completion: { state: 'pending', reason: 'completion_resumable' },
    ...MISSING_REPORT,
  } }));
  db.mockImplementation(fakeDb({ service_records: [RECORD] }));
  const res = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
  expect(res.code).toBe('nothing_repairable');
  expect(res.manual.map((m) => m.fact)).toEqual(['completion']);
});

test('field evidence, billing and unknown facts are listed manual, never planned', async () => {
  getCloseoutStatus.mockResolvedValue(status({ facts: {
    photos: { state: 'pending', reason: 'photo_count_short' },
    invoice: { state: 'pending', reason: 'expected_invoice_not_minted' },
    license: { state: 'unknown', reason: 'technicians_lookup_failed' },
  } }));
  db.mockImplementation(fakeDb({ service_records: [RECORD] }));
  const res = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
  expect(res.code).toBe('nothing_repairable');
  expect(res.manual.map((m) => m.fact).sort()).toEqual(['invoice', 'license', 'photos']);
  expect(res.manual.find((m) => m.fact === 'license').fix).toMatch(/unverified, not missing/);
});

test('confirmed: runs the steps in order and returns an itemized receipt', async () => {
  getCloseoutStatus.mockResolvedValue(status({ facts: MISSING_REPORT }));
  const minted = { ...RECORD, report_view_token: 'b'.repeat(32) };
  let tokenMinted = false;
  db.mockImplementation(jest.fn((table) => {
    const chain = {
      where: () => chain,
      first: async () => (table === 'service_records' ? (tokenMinted ? minted : RECORD) : table === 'customers' ? CUSTOMER : undefined),
    };
    return chain;
  }));
  ensureReportToken.mockImplementation(async () => { tokenMinted = true; return 'b'.repeat(32); });
  enqueueServiceReportV1EmailDelivery.mockResolvedValue({ ok: true, queued: true, delivery: { id: 'del-9', status: 'queued' } });

  const { steps: approved } = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
  const result = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, { confirmed: true, executionPins: { _verified_repair_steps: approved } });
  expect(result.success).toBe(true);
  expect(executionOutcome(result)).toBe('completed');
  expect(result.receipt.map((r) => [r.step, r.status])).toEqual([['publish_report', 'completed'], ['queue_report_email', 'completed']]);
  expect(enqueueServiceReportV1EmailDelivery).toHaveBeenCalledWith(expect.objectContaining({
    serviceRecordId: 'rec-1',
    token: 'b'.repeat(32),
    reportUrl: `https://portal.example.test/report/${'b'.repeat(32)}`,
    payload: expect.objectContaining({ source: 'ib_closeout_repair' }),
  }), expect.anything());
});

test('confirmed: a failed prerequisite leaves its dependent not_attempted; a later failure makes the run partial', async () => {
  getCloseoutStatus.mockResolvedValue(status({ facts: MISSING_REPORT }));
  db.mockImplementation(fakeDb({ service_records: [RECORD] }));
  const { steps: approved } = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
  ensureReportToken.mockRejectedValue(new Error('db down'));
  const failed = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, { confirmed: true, executionPins: { _verified_repair_steps: approved } });
  expect(executionOutcome(failed)).toBe('failed');
  expect(failed.receipt.map((r) => [r.step, r.status])).toEqual([['publish_report', 'failed'], ['queue_report_email', 'not_attempted']]);
  expect(enqueueServiceReportV1EmailDelivery).not.toHaveBeenCalled();

  // Link published, email refused → partial, reported, never re-run.
  const minted = { ...RECORD, report_view_token: 'd'.repeat(32) };
  db.mockImplementation(fakeDb({ service_records: [minted] }));
  ensureReportToken.mockResolvedValue('d'.repeat(32));
  enqueueServiceReportV1EmailDelivery.mockResolvedValue({ ok: false, error: 'queue unavailable' });
  getCloseoutStatus.mockResolvedValue(status({ facts: MISSING_REPORT }));
  // The plan is built from a tokenless record; execution re-reads the minted one.
  let reads = 0;
  db.mockImplementation(jest.fn((table) => {
    const chain = {
      where: () => chain,
      first: async () => {
        if (table === 'customers') return CUSTOMER;
        if (table !== 'service_records') return undefined;
        reads += 1;
        return reads === 1 ? RECORD : minted;
      },
    };
    return chain;
  }));
  const partial = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, { confirmed: true, executionPins: { _verified_repair_steps: approved } });
  expect(partial.partial).toBe(true);
  expect(executionOutcome(partial)).toBe('partially_completed');
  expect(partial.receipt.map((r) => [r.step, r.status])).toEqual([['publish_report', 'completed'], ['queue_report_email', 'failed']]);
});

test('a params-level confirmed without the route signal still only plans', async () => {
  getCloseoutStatus.mockResolvedValue(status({ facts: MISSING_REPORT }));
  db.mockImplementation(fakeDb({ service_records: [RECORD] }));
  const res = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC, confirmed: true });
  expect(res.preview).toBe(true);
  expect(ensureReportToken).not.toHaveBeenCalled();
});

test('confirmed: never runs without the verified plan, and never adds a step the card lacked', async () => {
  getCloseoutStatus.mockResolvedValue(status({ facts: MISSING_REPORT }));
  db.mockImplementation(fakeDb({ service_records: [RECORD] }));

  const unpinned = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, { confirmed: true });
  expect(unpinned.preview_changed).toBe(true);

  // The card approved only the report link; the email became plannable after it was shown.
  const drifted = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, {
    confirmed: true, executionPins: { _verified_repair_steps: [{ step: 'publish_report', service_record_id: 'rec-1' }] },
  });
  expect(drifted.preview_changed).toBe(true);
  expect(ensureReportToken).not.toHaveBeenCalled();
  expect(enqueueServiceReportV1EmailDelivery).not.toHaveBeenCalled();
});

test('report steps bind to the record owning the report artifact, not the primary record', async () => {
  const sibling = { ...RECORD, id: 'rec-sibling', report_view_token: 'c'.repeat(32) };
  getCloseoutStatus.mockResolvedValue({
    ...status({ facts: { reportDelivery: { state: 'pending', reason: 'not_enqueued', posture: 'auto_send' } } }),
    record: { id: 'rec-primary' },
    reportRecordId: 'rec-sibling',
  });
  const seen = [];
  db.mockImplementation(jest.fn((table) => {
    const chain = {
      where: (w) => { if (table === 'service_records') seen.push(w.id); return chain; },
      first: async () => (table === 'service_records' ? sibling : table === 'customers' ? CUSTOMER : undefined),
    };
    return chain;
  }));
  const preview = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
  expect(preview.steps).toEqual([expect.objectContaining({ step: 'queue_report_email', service_record_id: 'rec-sibling' })]);
  expect(preview.service_record_id).toBe('rec-sibling');
  expect(seen).not.toContain('rec-primary');
});

test('the card names the customer, the visit and the masked recipients, and nobody-to-email is not offered', async () => {
  getCloseoutStatus.mockResolvedValue({
    ...status({ facts: MISSING_REPORT }),
    visit: { customerId: 'cust-1', technicianId: 'tech-1', scheduledDate: '2026-09-27', serviceType: 'Pest Control' },
  });
  db.mockImplementation(fakeDb({ service_records: [RECORD], invoices: [{ id: 'inv-1', status: 'paid', receipt_sent_at: null }] }));
  const preview = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
  expect(preview.customer_name).toBe('Pat Tester');
  expect(preview.visit).toBe('2026-09-27 · Pest Control');
  const email = preview.steps.find((s) => s.step === 'queue_report_email');
  expect(email.recipients).toEqual(['p***@example.com']);
  expect(JSON.stringify(preview)).not.toMatch(/pat@example\.com|9415550100/);
  const contract = buildContract({ toolName: 'repair_closeout', params: { service_id: SVC }, preview });
  const labels = contract.effects.map((e) => e.label).join('\n');
  expect(labels).toMatch(/Visit: 2026-09-27 · Pest Control — Pat Tester/);
  expect(labels).toMatch(/report email.*to p\*\*\*@example\.com/);

  // Report emails turned off for this customer: the email step is not offered.
  db.mockImplementation(fakeDb({ service_records: [RECORD], notification_prefs: [{ customer_id: 'cust-1', service_completed: false }], invoices: [{ id: 'inv-1', status: 'paid', receipt_sent_at: null }] }));
  const off = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
  expect(off.steps.map((s) => s.step)).toEqual(['publish_report']);
  expect(off.manual).toEqual(expect.arrayContaining([expect.objectContaining({ fact: 'reportDelivery', fix: expect.stringMatching(/no report email recipient/) })]));
});

test('lawn reports never get a repair email — grounding is only verified by completion', async () => {
  getCloseoutStatus.mockResolvedValue(status({ facts: MISSING_REPORT }));
  for (const lawn of [{ service_line: 'lawn' }, { service_line: null, service_type: 'Lawn Care Visit' }]) {
    db.mockImplementation(fakeDb({ service_records: [{ ...RECORD, ...lawn }] }));
    const preview = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    expect(preview.steps.map((s) => s.step)).toEqual(['publish_report']);
    expect(preview.manual).toEqual(expect.arrayContaining([expect.objectContaining({ fact: 'reportDelivery', fix: expect.stringMatching(/lawn report/) })]));
  }
});

test('a recipient swapped behind the same mask changes the plan: fingerprint and execution both refuse', async () => {
  getCloseoutStatus.mockResolvedValue(status({ facts: MISSING_REPORT }));
  db.mockImplementation(fakeDb({ service_records: [RECORD], customers: [{ ...CUSTOMER, email: 'pat@example.com' }] }));
  const before = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
  db.mockImplementation(fakeDb({ service_records: [RECORD], customers: [{ ...CUSTOMER, email: 'paula@example.com' }] }));
  const after = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
  const mask = (p) => p.steps.find((st) => st.step === 'queue_report_email').recipients;
  expect(mask(after)).toEqual(mask(before));
  expect(previewFingerprint(after)).not.toBe(previewFingerprint(before));

  const run = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, {
    confirmed: true, executionPins: { _verified_repair_steps: before.steps },
  });
  expect(run.preview_changed).toBe(true);
  expect(ensureReportToken).not.toHaveBeenCalled();
});

describe('queue_receipt — the receipt worker, with its own recipient resolution on the card', () => {
  const UNSENT = { invoiceDelivery: { state: 'pending', reason: 'paid_receipt_not_sent', invoiceId: 'inv-1' } };
  const PAID = { id: 'inv-1', status: 'paid', receipt_sent_at: null, customer_id: 'cust-1', payer_id: null };

  test('names the resolved receipt email and a conditional text; the worker resolver gets the payment_receipt category', async () => {
    getCloseoutStatus.mockResolvedValue(status({ facts: UNSENT }));
    db.mockImplementation(fakeDb({ service_records: [RECORD], invoices: [PAID] }));
    resolveReceiptEmailRecipient.mockResolvedValue({ ok: true, recipient: { email: 'Billing@Example.com' }, customer: { phone: '9415550100' } });
    const preview = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    expect(resolveReceiptEmailRecipient).toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-1' }), { billingDeliveryCategory: 'payment_receipt' });
    expect(preview.steps).toEqual([expect.objectContaining({ step: 'queue_receipt', invoice_id: 'inv-1', recipients: ['b***@example.com'], text_to: '***0100', payer_billed: false })]);
    expect(preview.notifies_customer).toBe(true);
    expect(JSON.stringify(preview)).not.toMatch(/billing@example\.com|9415550100/i);
    const contract = buildContract({ toolName: 'repair_closeout', params: { service_id: SVC }, preview });
    expect(contract.notifies_customer).toBe(true);
    expect(contract.effects).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: 'comms', label: expect.stringMatching(/email to b\*\*\*@example\.com; may also send text \*\*\*0100, per the customer's receipt settings \(texts wait for 8 AM–8 PM\)/),
    })]));
  });

  test("a payer-billed receipt names the payer's inbox and no text", async () => {
    getCloseoutStatus.mockResolvedValue(status({ facts: UNSENT }));
    db.mockImplementation(fakeDb({ service_records: [RECORD], invoices: [{ ...PAID, payer_id: 'payer-1' }] }));
    resolveReceiptEmailRecipient.mockResolvedValue({ ok: true, recipient: { email: 'ap@builder.example' }, customer: { phone: '9415550100' } });
    const preview = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    expect(preview.steps[0]).toEqual(expect.objectContaining({ recipients: ['a***@builder.example'], text_to: null, payer_billed: true }));
    expect(preview.steps[0].effect).toMatch(/payer's billing inbox — a payer-billed receipt is never texted/);
    expect(explicitBillingAppSelected).not.toHaveBeenCalled();
  });

  test('a phone-less customer who chose App for receipts is still reachable, and the card says so (GH Codex P1)', async () => {
    getCloseoutStatus.mockResolvedValue(status({ facts: UNSENT }));
    db.mockImplementation(fakeDb({ service_records: [RECORD], invoices: [PAID], customers: [{ ...CUSTOMER, phone: null }] }));
    resolveReceiptEmailRecipient.mockResolvedValue({ ok: false, error: 'Receipt email is not selected', code: 'billing_email_not_selected' });
    explicitBillingAppSelected.mockResolvedValueOnce(true);
    const preview = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    expect(explicitBillingAppSelected).toHaveBeenCalledWith('cust-1', 'payment_receipt');
    expect(preview.steps[0]).toEqual(expect.objectContaining({ step: 'queue_receipt', recipients: [], text_to: null, app: true }));
    expect(preview.steps[0].effect).toMatch(/may also send a Waves app notification/);
  });

  test('opted out, unreadable settings, no recipient, or an existing job → manual, never planned', async () => {
    getCloseoutStatus.mockResolvedValue(status({ facts: UNSENT }));
    db.mockImplementation(fakeDb({ service_records: [RECORD], invoices: [PAID] }));
    receiptEmailOptOutState.mockResolvedValueOnce({ receiptKillSwitch: true, prefsLookupFailed: false });
    let res = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    expect(res.manual[0].fix).toMatch(/opted out of payment receipts/);

    receiptEmailOptOutState.mockResolvedValueOnce({ receiptKillSwitch: false, prefsLookupFailed: true });
    res = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    expect(res.manual[0].fix).toMatch(/could not be read/);

    resolveReceiptEmailRecipient.mockResolvedValueOnce({ ok: false, error: 'No receipt recipient email' });
    db.mockImplementation(fakeDb({ service_records: [RECORD], invoices: [PAID], customers: [{ ...CUSTOMER, phone: null }] }));
    res = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    expect(res.manual[0].fix).toMatch(/No receipt recipient email/);

    db.mockImplementation(fakeDb({ service_records: [RECORD], invoices: [PAID], receipt_delivery_jobs: [{ id: 'job-1' }] }));
    res = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    expect(res.manual[0].fix).toMatch(/receipt job already exists/);
  });

  test('confirmed: queues through enqueueReceiptDelivery as a machine receipt; a recipient change refuses', async () => {
    getCloseoutStatus.mockResolvedValue(status({ facts: UNSENT }));
    db.mockImplementation(fakeDb({ service_records: [RECORD], invoices: [PAID] }));
    resolveReceiptEmailRecipient.mockResolvedValue({ ok: true, recipient: { email: 'billing@example.com' }, customer: { phone: '9415550100' } });
    const { steps: approved } = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    enqueueReceiptDelivery.mockResolvedValue({ enqueued: true, job: { id: 'job-9' } });
    const run = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, { confirmed: true, executionPins: { _verified_repair_steps: approved } });
    expect(run.success).toBe(true);
    expect(enqueueReceiptDelivery).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: 'inv-1', source: 'ib_closeout_repair', customerInitiated: false }));

    enqueueReceiptDelivery.mockClear();
    resolveReceiptEmailRecipient.mockResolvedValue({ ok: true, recipient: { email: 'bob@example.com' }, customer: { phone: '9415550100' } });
    const drift = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, { confirmed: true, executionPins: { _verified_repair_steps: approved } });
    expect(drift.preview_changed).toBe(true);
    expect(enqueueReceiptDelivery).not.toHaveBeenCalled();
  });
});
