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
jest.mock('../services/completion-followup-booking', () => ({ bookCompletionFollowup: jest.fn() }));
jest.mock('../services/billing-recovery-bill', () => ({
  assessVisitBillable: jest.fn(), billVisit: jest.fn(),
  previewBillVisit: jest.fn(async () => ({ ok: true, total: 138.03, subtotal: 129, discountAmount: 0, taxAmount: 9.03, dueDate: '2026-09-14' })),
  pendingDepositForVisit: jest.fn().mockResolvedValue(0), liveCardHoldForVisit: jest.fn().mockResolvedValue(null),
}));
// The Send action's own recipient resolver and send.
jest.mock('../services/invoice-email', () => ({
  invoiceRecipientFor: jest.fn(() => ({ recipient: { email: 'Pat@Example.com' } })),
  resolveReceiptEmailRecipient: jest.fn(),
}));
jest.mock('../services/invoice', () => ({
  sendViaSMSAndEmail: jest.fn(),
  explicitBillingAppSelected: jest.fn(async () => false),
  receiptAmountFor: jest.fn(async () => '129.00'),
}));
jest.mock('../services/receipt-delivery-queue', () => ({
  enqueueReceiptDelivery: jest.fn(),
  receiptEmailOptOutState: jest.fn(async () => ({ receiptKillSwitch: false, prefsLookupFailed: false })),
  // The worker's real classification.
  expectedEmailSkip: jest.requireActual('../services/receipt-delivery-queue').expectedEmailSkip,
}));
jest.mock('../config/feature-gates', () => ({ gates: { autoApplyAccountCredit: false } }));
jest.mock('../services/customer-credit', () => ({ customerAutoApplyEnabled: jest.fn(async () => true), getBalance: jest.fn(async () => 25) }));

const db = require('../models/db');
const { getCloseoutStatus } = require('../services/closeout-status');
const { ensureReportToken } = require('../services/service-report/pdf-queue');
const { enqueueServiceReportV1EmailDelivery } = require('../services/service-report/delivery-queue');
const { bookCompletionFollowup } = require('../services/completion-followup-booking');
const BillingRecoveryBill = require('../services/billing-recovery-bill');
const InvoiceService = require('../services/invoice');
const { invoiceRecipientFor, resolveReceiptEmailRecipient } = require('../services/invoice-email');
const { explicitBillingAppSelected } = require('../services/invoice');
const { enqueueReceiptDelivery, receiptEmailOptOutState } = require('../services/receipt-delivery-queue');
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

test('field evidence, payer billing and unknown facts are listed manual, never planned', async () => {
  getCloseoutStatus.mockResolvedValue(status({ facts: {
    photos: { state: 'pending', reason: 'photo_count_short' },
    invoice: { state: 'pending', reason: 'expected_payer_not_minted' },
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

describe('bill_visit — the Billing Recovery "Bill" action as a repair step', () => {
  const UNBILLED = { invoice: { state: 'pending', reason: 'expected_invoice_not_minted', expectation: 'invoice', amount: 129 } };

  test('plans the invoice at its exact total (the rolled-back real mint) and the Send action to the resolved contacts', async () => {
    getCloseoutStatus.mockResolvedValue({ ...status({ facts: UNBILLED }), serviceId: SVC });
    db.mockImplementation(fakeDb({ service_records: [RECORD] }));
    BillingRecoveryBill.assessVisitBillable.mockResolvedValue({ ok: true, price: 129, rowPrice: 129, visit: {}, dueDate: '2026-09-14' });
    const preview = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    // Pinned to closeout-status's canonical completion record (GH Codex P2).
    expect(BillingRecoveryBill.assessVisitBillable).toHaveBeenCalledWith(SVC, expect.objectContaining({ serviceRecordId: 'rec-1', requireCompletedVisit: true }));
    expect(BillingRecoveryBill.previewBillVisit).toHaveBeenCalledWith(SVC, expect.objectContaining({
      serviceRecordId: 'rec-1', requireCompletedVisit: true, refuseDepositCredit: true, refuseLiveCardHold: true,
    }));
    expect(preview.steps).toEqual([
      expect.objectContaining({ step: 'bill_visit', scheduled_service_id: SVC, service_record_id: 'rec-1', amount: 129, total: 138.03, tax: 9.03, due_date: '2026-09-14', kind: 'billing' }),
      expect.objectContaining({ step: 'send_invoice', fact: 'invoiceDelivery', depends_on: 'bill_visit', recipients: ['p***@example.com'], text_to: '***0100', kind: 'comms' }),
    ]);
    expect(invoiceRecipientFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'cust-1' }), expect.anything(), null);
    expect(JSON.stringify(preview)).not.toMatch(/pat@example\.com|9415550100/i);
    expect(preview.notifies_customer).toBe(true);
    expect(BillingRecoveryBill.billVisit).not.toHaveBeenCalled();
    expect(InvoiceService.sendViaSMSAndEmail).not.toHaveBeenCalled();
    const contract = buildContract({ toolName: 'repair_closeout', params: { service_id: SVC }, preview });
    const labels = contract.effects.map((e) => e.label).join('\n');
    expect(labels).toMatch(/Create the invoice .*nothing is charged: \$138\.03 total \(\$129\.00 services, \$9\.03 tax\), due 2026-09-14/);
    expect(labels).toMatch(/Send the invoice to the customer .*: email to p\*\*\*@example\.com and text the pay link to \*\*\*0100 — this also starts the usual unpaid-invoice reminders/);
    expect(contract.notifies_customer).toBe(true);
    expect(contract.irreversible).toBe(true);
  });

  test('no invoice contact on file: the invoice is still planned, the send is listed manual', async () => {
    getCloseoutStatus.mockResolvedValue({ ...status({ facts: UNBILLED }), serviceId: SVC });
    db.mockImplementation(fakeDb({ service_records: [RECORD], customers: [{ ...CUSTOMER, phone: null }] }));
    BillingRecoveryBill.assessVisitBillable.mockResolvedValue({ ok: true, price: 129, rowPrice: 129, visit: {} });
    invoiceRecipientFor.mockReturnValueOnce({ recipient: null });
    const preview = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    expect(preview.steps.map((st) => st.step)).toEqual(['bill_visit']);
    expect(preview.manual).toEqual(expect.arrayContaining([expect.objectContaining({ fact: 'invoiceDelivery', fix: expect.stringMatching(/no invoice email or phone on file/) })]));
  });

  test('a visit with an open card hold stays manual (completion owns the hold rail)', async () => {
    getCloseoutStatus.mockResolvedValue({ ...status({ facts: UNBILLED }), serviceId: SVC });
    db.mockImplementation(fakeDb({ service_records: [RECORD] }));
    BillingRecoveryBill.assessVisitBillable.mockResolvedValue({ ok: true, price: 129, rowPrice: 129, visit: {} });
    BillingRecoveryBill.liveCardHoldForVisit.mockResolvedValueOnce({ id: 'hold-1', status: 'held' });
    const res = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    expect(res.code).toBe('nothing_repairable');
    expect(res.manual).toEqual([expect.objectContaining({ fact: 'invoice', fix: expect.stringMatching(/card hold is still open/) })]);
  });

  test('a visit carrying unapplied estimate deposit money stays manual', async () => {
    getCloseoutStatus.mockResolvedValue({ ...status({ facts: UNBILLED }), serviceId: SVC });
    db.mockImplementation(fakeDb({ service_records: [RECORD] }));
    BillingRecoveryBill.assessVisitBillable.mockResolvedValue({ ok: true, price: 129, rowPrice: 129, visit: {} });
    BillingRecoveryBill.pendingDepositForVisit.mockResolvedValueOnce(50);
    const res = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    expect(res.code).toBe('nothing_repairable');
    expect(res.manual).toEqual([expect.objectContaining({ fact: 'invoice', fix: expect.stringMatching(/deposit \(\$50\.00\)/) })]);
  });

  test('a Bill refusal (autopay, payer, prepaid…) is the manual fix; payer / auto-charge reasons never reach Bill', async () => {
    getCloseoutStatus.mockResolvedValue({ ...status({ facts: UNBILLED }), serviceId: SVC });
    db.mockImplementation(fakeDb({ service_records: [RECORD] }));
    BillingRecoveryBill.assessVisitBillable.mockResolvedValue({ ok: false, status: 409, error: 'Customer is on active autopay — billing-cron charges monthly_rate; invoicing would double-charge.' });
    const refused = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    expect(refused.code).toBe('nothing_repairable');
    expect(refused.manual).toEqual([expect.objectContaining({ fact: 'invoice', fix: expect.stringMatching(/active autopay/) })]);

    BillingRecoveryBill.assessVisitBillable.mockClear();
    for (const reason of ['expected_payer_not_minted', 'expected_auto_charge_not_minted', 'parked_manual_refunded_invoice', 'frozen_required_mint_not_minted']) {
      getCloseoutStatus.mockResolvedValue({ ...status({ facts: { invoice: { state: 'pending', reason } } }), serviceId: SVC });
      const res = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
      expect(res.code).toBe('nothing_repairable');
    }
    expect(BillingRecoveryBill.assessVisitBillable).not.toHaveBeenCalled();
  });

  test('confirmed: bills at the approved total, then sends that invoice as a first delivery; a total change refuses', async () => {
    getCloseoutStatus.mockResolvedValue({ ...status({ facts: UNBILLED }), serviceId: SVC });
    db.mockImplementation(fakeDb({ service_records: [RECORD], invoices: [{ id: 'inv-9', customer_id: 'cust-1', total: '138.03', status: 'draft' }], visit_billing_dispositions: [{ invoice_id: 'inv-9' }] }));
    BillingRecoveryBill.assessVisitBillable.mockResolvedValue({ ok: true, price: 129, rowPrice: 129, visit: {} });
    const { steps: approved } = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    BillingRecoveryBill.billVisit.mockResolvedValue({ ok: true, price: 129, invoice: { id: 'inv-9', invoice_number: 'WPC-2026-0042', total: '138.03', status: 'draft' } });
    InvoiceService.sendViaSMSAndEmail.mockResolvedValue({ ok: true, email: { ok: true }, sms: { ok: true } });
    const run = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, {
      confirmed: true, technicianId: 'tech-admin', executionPins: { _verified_repair_steps: approved },
    });
    expect(run.success).toBe(true);
    expect(run.receipt).toEqual([
      expect.objectContaining({ step: 'bill_visit', status: 'completed', invoice_id: 'inv-9', invoice_number: 'WPC-2026-0042' }),
      expect.objectContaining({ step: 'send_invoice', status: 'completed', detail: 'invoice sent (emailed, texted)', invoice_id: 'inv-9' }),
    ]);
    expect(BillingRecoveryBill.billVisit).toHaveBeenCalledWith(SVC, expect.objectContaining({
      actorId: 'tech-admin', expectedPrice: 129, expectedTotal: 138.03, expectedBreakdown: { subtotal: 129, discount: 0, tax: 9.03 }, refuseDepositCredit: true,
      serviceRecordId: 'rec-1', requireCompletedVisit: true, refuseLiveCardHold: true,
    }));
    expect(InvoiceService.sendViaSMSAndEmail).toHaveBeenCalledWith('inv-9', { firstDeliveryOnly: true, operatorInitiated: true, actorTechnicianId: 'tech-admin', skipAccountCreditAutoApply: true, expectedTotal: 138.03 });

    // A failed mint leaves the send not attempted.
    InvoiceService.sendViaSMSAndEmail.mockClear();
    BillingRecoveryBill.billVisit.mockResolvedValueOnce({ ok: false, status: 409, error: 'The invoice total changed since it was approved ($138.03 → $140.00).' });
    const failed = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, {
      confirmed: true, technicianId: 'tech-admin', executionPins: { _verified_repair_steps: approved },
    });
    expect(failed.receipt.map((r) => [r.step, r.status])).toEqual([['bill_visit', 'failed'], ['send_invoice', 'not_attempted']]);
    expect(InvoiceService.sendViaSMSAndEmail).not.toHaveBeenCalled();

    // A different previewed total after the card: the executor's plan no longer matches.
    BillingRecoveryBill.billVisit.mockClear();
    BillingRecoveryBill.previewBillVisit.mockResolvedValueOnce({ ok: true, total: 140, subtotal: 129, discountAmount: 0, taxAmount: 11, dueDate: '2026-09-14' });
    const drift = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, {
      confirmed: true, technicianId: 'tech-admin', executionPins: { _verified_repair_steps: approved },
    });
    expect(drift.preview_changed).toBe(true);
    expect(BillingRecoveryBill.billVisit).not.toHaveBeenCalled();
  });

  test('send: a recipient changed after approval refuses the send at the boundary (the invoice stays created)', async () => {
    getCloseoutStatus.mockResolvedValue({ ...status({ facts: UNBILLED }), serviceId: SVC });
    db.mockImplementation(fakeDb({ service_records: [RECORD], invoices: [{ id: 'inv-9', customer_id: 'cust-1', total: '138.03', status: 'draft' }], visit_billing_dispositions: [{ invoice_id: 'inv-9' }] }));
    BillingRecoveryBill.assessVisitBillable.mockResolvedValue({ ok: true, price: 129, rowPrice: 129, visit: {} });
    const { steps: approved } = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    BillingRecoveryBill.billVisit.mockResolvedValue({ ok: true, price: 129, invoice: { id: 'inv-9', total: '138.03' } });
    InvoiceService.sendViaSMSAndEmail.mockClear();
    // Planning (executor re-plan) still sees the approved email; the send boundary sees the new one.
    invoiceRecipientFor
      .mockReturnValueOnce({ recipient: { email: 'Pat@Example.com' } })
      .mockReturnValueOnce({ recipient: { email: 'someone.else@example.com' } });
    const run = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, { confirmed: true, executionPins: { _verified_repair_steps: approved } });
    expect(run.partial).toBe(true);
    expect(run.receipt[1]).toEqual(expect.objectContaining({ step: 'send_invoice', status: 'failed', detail: expect.stringMatching(/changed since the card was approved/) }));
    expect(InvoiceService.sendViaSMSAndEmail).not.toHaveBeenCalled();
  });

  test('send: a draft edited to a different total after creation refuses the send (the approved total is re-checked)', async () => {
    getCloseoutStatus.mockResolvedValue({ ...status({ facts: UNBILLED }), serviceId: SVC });
    db.mockImplementation(fakeDb({ service_records: [RECORD], invoices: [{ id: 'inv-9', customer_id: 'cust-1', total: '150.00', status: 'draft' }], visit_billing_dispositions: [{ invoice_id: 'inv-9' }] }));
    BillingRecoveryBill.assessVisitBillable.mockResolvedValue({ ok: true, price: 129, rowPrice: 129, visit: {} });
    const { steps: approved } = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    expect(approved[1]).toEqual(expect.objectContaining({ step: 'send_invoice', total: 138.03 }));
    BillingRecoveryBill.billVisit.mockResolvedValue({ ok: true, price: 129, invoice: { id: 'inv-9', total: '138.03' } });
    InvoiceService.sendViaSMSAndEmail.mockClear();
    const run = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, { confirmed: true, executionPins: { _verified_repair_steps: approved } });
    expect(run.receipt[1]).toEqual(expect.objectContaining({ step: 'send_invoice', status: 'failed', detail: expect.stringMatching(/total changed to \$150\.00/) }));
    expect(InvoiceService.sendViaSMSAndEmail).not.toHaveBeenCalled();
  });

  test('send: a terminal-visit void is the Send route\'s completed no-op, read through the shared classifier', async () => {
    getCloseoutStatus.mockResolvedValue({ ...status({ facts: UNBILLED }), serviceId: SVC });
    db.mockImplementation(fakeDb({ service_records: [RECORD], invoices: [{ id: 'inv-9', customer_id: 'cust-1', total: '138.03', status: 'draft' }], visit_billing_dispositions: [{ invoice_id: 'inv-9' }] }));
    BillingRecoveryBill.assessVisitBillable.mockResolvedValue({ ok: true, price: 129, rowPrice: 129, visit: {} });
    const { steps: approved } = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    BillingRecoveryBill.billVisit.mockResolvedValue({ ok: true, price: 129, invoice: { id: 'inv-9', total: '138.03' } });
    InvoiceService.sendViaSMSAndEmail.mockResolvedValueOnce({ ok: false, code: 'INVOICE_VISIT_TERMINAL', sms: { ok: false }, email: { ok: false } });
    const run = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, { confirmed: true, executionPins: { _verified_repair_steps: approved } });
    expect(run.success).toBe(true);
    expect(run.receipt[1]).toEqual(expect.objectContaining({ status: 'completed', detail: expect.stringMatching(/voided instead of sent/) }));
    InvoiceService.sendViaSMSAndEmail.mockResolvedValueOnce({ ok: true, settled_zero_due: true, sms: {}, email: {} });
    const zero = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, { confirmed: true, executionPins: { _verified_repair_steps: approved } });
    expect(zero.receipt[1]).toEqual(expect.objectContaining({ status: 'completed', detail: expect.stringMatching(/nothing was due/) }));
  });

  test('send: an invoice already delivered by another path is a completed no-op; a refused send is a failed step (partial run)', async () => {
    getCloseoutStatus.mockResolvedValue({ ...status({ facts: UNBILLED }), serviceId: SVC });
    db.mockImplementation(fakeDb({ service_records: [RECORD], invoices: [{ id: 'inv-9', customer_id: 'cust-1', total: '138.03', status: 'draft' }], visit_billing_dispositions: [{ invoice_id: 'inv-9' }] }));
    BillingRecoveryBill.assessVisitBillable.mockResolvedValue({ ok: true, price: 129, rowPrice: 129, visit: {} });
    const { steps: approved } = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    BillingRecoveryBill.billVisit.mockResolvedValue({ ok: true, price: 129, invoice: { id: 'inv-9', total: '138.03' } });
    InvoiceService.sendViaSMSAndEmail.mockRejectedValueOnce(Object.assign(new Error('already delivered'), { code: 'already_delivered' }));
    const noop = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, { confirmed: true, executionPins: { _verified_repair_steps: approved } });
    expect(noop.success).toBe(true);
    expect(noop.receipt[1]).toEqual(expect.objectContaining({ step: 'send_invoice', status: 'completed', detail: 'nothing re-sent (already delivered)' }));

    InvoiceService.sendViaSMSAndEmail.mockResolvedValueOnce({ ok: false, error: 'No invoice recipient email', sms: { ok: false }, email: { ok: false } });
    const partial = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, { confirmed: true, executionPins: { _verified_repair_steps: approved } });
    expect(partial.partial).toBe(true);
    expect(partial.receipt[1]).toEqual(expect.objectContaining({ status: 'failed', detail: 'No invoice recipient email' }));
  });
});

test('send_invoice: account credit the send would apply keeps the send manual (plan) and refuses it (run)', async () => {
  const gates = require('../config/feature-gates').gates;
  gates.autoApplyAccountCredit = true;
  try {
    getCloseoutStatus.mockResolvedValue({ ...status({ facts: { invoice: { state: 'pending', reason: 'expected_invoice_not_minted' } } }), serviceId: SVC });
    db.mockImplementation(fakeDb({ service_records: [RECORD], invoices: [{ id: 'inv-9', customer_id: 'cust-1', total: '138.03', status: 'draft' }], visit_billing_dispositions: [{ invoice_id: 'inv-9' }] }));
    BillingRecoveryBill.assessVisitBillable.mockResolvedValue({ ok: true, price: 129, rowPrice: 129, visit: {} });
    const preview = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    expect(preview.steps.map((st) => st.step)).toEqual(['bill_visit']);
    expect(preview.manual).toEqual(expect.arrayContaining([expect.objectContaining({ fact: 'invoiceDelivery', fix: expect.stringMatching(/apply \$25\.00 of the customer's account credit/) })]));

    // Credit that appears after an approved card: the run refuses the send.
    gates.autoApplyAccountCredit = false;
    const { steps: approved } = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    gates.autoApplyAccountCredit = true;
    BillingRecoveryBill.billVisit.mockResolvedValue({ ok: true, price: 129, invoice: { id: 'inv-9', total: '138.03' } });
    // Keep the executor's re-plan identical to the approval (credit shows up only at send time).
    const CustomerCredit = require('../services/customer-credit');
    CustomerCredit.getBalance.mockResolvedValueOnce(0).mockResolvedValueOnce(25);
    const run = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, { confirmed: true, executionPins: { _verified_repair_steps: approved } });
    expect(run.receipt[1]).toEqual(expect.objectContaining({ step: 'send_invoice', status: 'failed', detail: expect.stringMatching(/account credit/) }));
    expect(InvoiceService.sendViaSMSAndEmail).not.toHaveBeenCalled();
  } finally {
    gates.autoApplyAccountCredit = false;
  }
});

describe('book_followup — the Dispatch follow-up action as a repair step', () => {
  const OWED = { followUp: { state: 'pending', reason: 'followup_required_not_booked', windowDays: 14, frozen: true } };
  const WOULD = { status: 200, body: { dryRun: true, alreadyScheduled: false, wouldBook: { date: '2026-10-05', windowStart: '09:00:00', windowEnd: '10:00:00', technicianId: 'tech-1', status: 'pending' } } };

  test('plans the CTA booking from its own preview; the card names date, window, technician and the later reminders', async () => {
    getCloseoutStatus.mockResolvedValue({ ...status({ facts: OWED }), serviceId: SVC });
    db.mockImplementation(fakeDb({ service_records: [RECORD], technicians: [{ name: 'Adam' }] }));
    bookCompletionFollowup.mockResolvedValue(WOULD);
    const preview = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    expect(bookCompletionFollowup).toHaveBeenCalledWith(expect.objectContaining({ serviceId: SVC, useSuggestedDate: true, dryRun: true }));
    expect(preview.steps).toEqual([expect.objectContaining({ step: 'book_followup', date: '2026-10-05', technician_id: 'tech-1', technician_name: 'Adam' })]);
    expect(preview.notifies_customer).toBe(false);
    const contract = buildContract({ toolName: 'repair_closeout', params: { service_id: SVC }, preview });
    expect(contract.effects.map((e) => e.label).join('\n')).toMatch(/PENDING \$0 follow-up visit.*on 2026-10-05 09:00–10:00 with Adam — nothing is sent now; it is registered for the usual appointment reminders, which go out per the customer's reminder settings/);
    expect(preview.steps[0]).toEqual(expect.objectContaining({ customer_id: 'cust-1', overlap: false }));
  });

  test('a CTA refusal (date passed, already booked…) is the manual fix', async () => {
    getCloseoutStatus.mockResolvedValue({ ...status({ facts: OWED }), serviceId: SVC });
    db.mockImplementation(fakeDb({ service_records: [RECORD] }));
    bookCompletionFollowup.mockResolvedValue({ status: 400, body: { error: 'Follow-up date must be today or later', code: 'followup_date_past' } });
    const past = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    expect(past.code).toBe('nothing_repairable');
    expect(past.manual).toEqual([expect.objectContaining({ fact: 'followUp', fix: expect.stringMatching(/today or later/) })]);
  });

  test('confirmed: books through the CTA with the approved technician pinned and admin_ib attribution', async () => {
    getCloseoutStatus.mockResolvedValue({ ...status({ facts: OWED }), serviceId: SVC });
    db.mockImplementation(fakeDb({ service_records: [RECORD], technicians: [{ name: 'Adam' }] }));
    bookCompletionFollowup.mockResolvedValue(WOULD);
    const { steps: approved } = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    bookCompletionFollowup.mockImplementation(async (args) => (args.dryRun ? WOULD
      : { status: 200, body: { success: true, alreadyScheduled: false, appointment: { id: 'fu-1', scheduledDate: '2026-10-05', status: 'pending' } } }));
    const run = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, {
      confirmed: true, technicianId: 'admin-1', executionPins: { _verified_repair_steps: approved },
    });
    expect(run.success).toBe(true);
    expect(run.receipt).toEqual([expect.objectContaining({ step: 'book_followup', status: 'completed', appointment_id: 'fu-1' })]);
    expect(bookCompletionFollowup).toHaveBeenLastCalledWith(expect.objectContaining({
      serviceId: SVC, date: '2026-10-05', actorId: 'admin-1', sourceAction: 'admin_ib',
      expectedWindow: { start: '09:00:00', end: '10:00:00' }, expectedTechnicianId: 'tech-1', expectedCustomerId: 'cust-1',
    }));
    expect(bookCompletionFollowup.mock.calls.at(-1)[0].dryRun).toBeUndefined();
    expect(bookCompletionFollowup.mock.calls.at(-1)[0].useSuggestedDate).toBeUndefined();
  });

  test('confirmed: a technician change under the lock is a failed step, never a different booking', async () => {
    getCloseoutStatus.mockResolvedValue({ ...status({ facts: OWED }), serviceId: SVC });
    db.mockImplementation(fakeDb({ service_records: [RECORD], technicians: [{ name: 'Adam' }] }));
    bookCompletionFollowup.mockResolvedValue(WOULD);
    const { steps: approved } = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    bookCompletionFollowup.mockImplementation(async (args) => {
      if (args.dryRun) return WOULD;
      throw Object.assign(new Error('The follow-up technician changed since it was approved — ask again for a fresh card.'), { statusCode: 409, code: 'FOLLOWUP_TECH_CHANGED' });
    });
    const run = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, {
      confirmed: true, technicianId: 'admin-1', executionPins: { _verified_repair_steps: approved },
    });
    expect(executionOutcome(run)).toBe('failed');
    expect(run.receipt).toEqual([expect.objectContaining({ step: 'book_followup', status: 'failed', detail: expect.stringMatching(/technician changed/) })]);
  });
});

test('book_followup: an advisory overlap is shown on the card and carried to the receipt', async () => {
  getCloseoutStatus.mockResolvedValue({ ...status({ facts: { followUp: { state: 'pending', reason: 'followup_required_not_booked' } } }), serviceId: SVC });
  db.mockImplementation(fakeDb({ service_records: [RECORD], technicians: [{ name: 'Adam' }] }));
  const WOULD = { status: 200, body: { dryRun: true, alreadyScheduled: false, wouldBook: { date: '2026-10-05', windowStart: '09:00:00', windowEnd: '10:00:00', technicianId: 'tech-1', status: 'pending', overlap: true } } };
  bookCompletionFollowup.mockResolvedValue(WOULD);
  const preview = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
  expect(preview.steps[0].effect).toMatch(/overlaps another appointment on the schedule — both are kept/);
  bookCompletionFollowup.mockImplementation(async (args) => (args.dryRun ? WOULD
    : { status: 200, body: { success: true, alreadyScheduled: false, appointment: { id: 'fu-1', scheduledDate: '2026-10-05', status: 'pending' }, overlapWarning: 'Heads up: overlap' } }));
  const run = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, { confirmed: true, executionPins: { _verified_repair_steps: preview.steps } });
  expect(run.receipt[0]).toEqual(expect.objectContaining({ status: 'completed', warning: 'Heads up: overlap' }));
});

describe('queue_receipt — the receipt worker, with its own recipient resolution on the card', () => {
  const UNSENT = { invoiceDelivery: { state: 'pending', reason: 'paid_receipt_not_sent', invoiceId: 'inv-1' } };
  const PAID = { id: 'inv-1', invoice_number: 'INV-00042', status: 'paid', receipt_sent_at: null, customer_id: 'cust-1', payer_id: null };

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
      kind: 'comms', label: expect.stringMatching(/receipt for invoice INV-00042, \$129\.00 paid — email to b\*\*\*@example\.com; may also send text \*\*\*0100, per the customer's receipt settings \(texts wait for 8 AM–8 PM\)/),
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
    // The real routedReceiptRefusal shape for "Email is not the chosen receipt channel".
    resolveReceiptEmailRecipient.mockResolvedValue({ ok: false, skipped: true, error: 'billing_email_not_selected', code: 'billing_email_not_selected' });
    explicitBillingAppSelected.mockResolvedValueOnce(true);
    const preview = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    expect(explicitBillingAppSelected).toHaveBeenCalledWith('cust-1', 'payment_receipt');
    expect(preview.steps[0]).toEqual(expect.objectContaining({ step: 'queue_receipt', recipients: [], text_to: null, app: true }));
    expect(preview.steps[0].effect).toMatch(/may also send a Waves app notification/);
  });

  test('an email-resolution outage blocks the step even with a phone on file (GH Codex P1)', async () => {
    getCloseoutStatus.mockResolvedValue(status({ facts: UNSENT }));
    db.mockImplementation(fakeDb({ service_records: [RECORD], invoices: [PAID] }));
    resolveReceiptEmailRecipient.mockResolvedValueOnce({ ok: false, error: 'Receipt delivery preferences unavailable', code: 'billing_prefs_unavailable' });
    const res = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
    expect(res.code).toBe('nothing_repairable');
    expect(res.manual).toEqual([expect.objectContaining({ fact: 'invoiceDelivery', fix: expect.stringMatching(/could not be verified \(Receipt delivery preferences unavailable\)/) })]);
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
    const txDb = fakeDb({ service_records: [RECORD], invoices: [PAID] });
    db.transaction = jest.fn(async (fn) => fn((table) => { const q = txDb(table); q.forUpdate = () => q; return q; }));
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

test('queue_receipt: an unreadable payment amount blocks the plan; a receipt sent by hand in between refuses the enqueue', async () => {
  const UNSENT = { invoiceDelivery: { state: 'pending', reason: 'paid_receipt_not_sent', invoiceId: 'inv-1' } };
  const PAID = { id: 'inv-1', invoice_number: 'INV-00042', status: 'paid', receipt_sent_at: null, customer_id: 'cust-1', payer_id: null };
  getCloseoutStatus.mockResolvedValue(status({ facts: UNSENT }));
  db.mockImplementation(fakeDb({ service_records: [RECORD], invoices: [PAID] }));
  resolveReceiptEmailRecipient.mockResolvedValue({ ok: true, recipient: { email: 'billing@example.com' }, customer: { phone: '9415550100' } });
  const Invoice = require('../services/invoice');
  Invoice.receiptAmountFor.mockRejectedValueOnce(new Error('payments read failed'));
  const blocked = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
  expect(blocked.manual).toEqual([expect.objectContaining({ fact: 'invoiceDelivery', fix: expect.stringMatching(/amount could not be verified/) })]);
  expect(Invoice.receiptAmountFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-1' }), { failClosed: true });

  const { steps: approved } = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
  // The locked re-read inside the enqueue transaction sees the hand-sent stamp.
  const plain = fakeDb({ service_records: [RECORD], invoices: [PAID] });
  const trxDb = fakeDb({ invoices: [{ ...PAID, receipt_sent_at: '2026-09-28T10:00:00Z' }] });
  db.mockImplementation(plain);
  db.transaction = jest.fn(async (fn) => {
    const trx = (table) => { const q = trxDb(table); q.forUpdate = () => q; return q; };
    return fn(trx);
  });
  enqueueReceiptDelivery.mockClear();
  const run = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, { confirmed: true, executionPins: { _verified_repair_steps: approved } });
  expect(run.receipt).toEqual([expect.objectContaining({ step: 'queue_receipt', status: 'failed', detail: expect.stringMatching(/sent in the meantime/) })]);
  expect(enqueueReceiptDelivery).not.toHaveBeenCalled();
});

test('queue_receipt: a legacy payment_receipt_channel of push shows the App leg for a phone-bearing customer', async () => {
  const UNSENT = { invoiceDelivery: { state: 'pending', reason: 'paid_receipt_not_sent', invoiceId: 'inv-1' } };
  const PAID = { id: 'inv-1', invoice_number: 'INV-00042', status: 'paid', receipt_sent_at: null, customer_id: 'cust-1', payer_id: null };
  getCloseoutStatus.mockResolvedValue(status({ facts: UNSENT }));
  db.mockImplementation(fakeDb({ service_records: [RECORD], invoices: [PAID], notification_prefs: [{ customer_id: 'cust-1', payment_receipt_channel: 'push' }] }));
  resolveReceiptEmailRecipient.mockResolvedValue({ ok: true, recipient: { email: 'billing@example.com' }, customer: { phone: '9415550100' } });
  const preview = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
  expect(preview.steps[0]).toEqual(expect.objectContaining({ step: 'queue_receipt', app: true, text_to: '***0100' }));
  expect(preview.steps[0].effect).toMatch(/may also send text \*\*\*0100 or a Waves app notification/);
});
