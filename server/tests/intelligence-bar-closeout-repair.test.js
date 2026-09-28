/**
 * IB closeout repair command (W3) — plan (two-step preview) and the
 * itemized confirmed run over the canonical closeout-status service.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/closeout-status', () => ({ getCloseoutStatus: jest.fn() }));
jest.mock('../services/service-report/pdf-queue', () => ({ ensureReportToken: jest.fn() }));
jest.mock('../services/service-report/delivery-queue', () => ({ enqueueServiceReportV1EmailDelivery: jest.fn() }));
jest.mock('../services/receipt-delivery-queue', () => ({ enqueueReceiptDelivery: jest.fn() }));
jest.mock('../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn().mockResolvedValue(false) }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.example.test' }));

const db = require('../models/db');
const { getCloseoutStatus } = require('../services/closeout-status');
const { ensureReportToken } = require('../services/service-report/pdf-queue');
const { enqueueServiceReportV1EmailDelivery } = require('../services/service-report/delivery-queue');
const { enqueueReceiptDelivery } = require('../services/receipt-delivery-queue');
const { CLOSEOUT_REPAIR_TOOLS, executeCloseoutRepairTool } = require('../services/intelligence-bar/closeout-repair-tools');
const gates = require('../services/intelligence-bar/write-gates');
const { executionOutcome } = require('../services/intelligence-bar/outcomes');
const { buildContract, previewFingerprint } = require('../services/intelligence-bar/authorization-contract');

const SVC = '00000000-0000-0000-0000-00000000d001';

// Table-keyed fake: first() answers from `tables`, writes are not expected
// through this handle (every write goes through a mocked service function).
function fakeDb(tables) {
  return jest.fn((table) => {
    const chain = {
      where: () => chain,
      first: async () => (tables[table] || [])[0],
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
    summary: { closedOut: false },
    facts: { ...base, ...facts },
  };
}

const RECORD = {
  id: 'rec-1', status: 'completed', report_template_version: 'service_report_v1',
  report_view_token: null, structured_notes: {}, recap_sms_sent_at: null, customer_id: 'cust-1', scheduled_service_id: SVC,
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

test('paid receipt never queued: plans queue_receipt only when the invoice is paid and has no job', async () => {
  const facts = { invoiceDelivery: { state: 'pending', reason: 'paid_receipt_not_sent', invoiceId: 'inv-1' } };
  getCloseoutStatus.mockResolvedValue(status({ facts }));
  db.mockImplementation(fakeDb({ service_records: [RECORD], invoices: [{ id: 'inv-1', status: 'paid', receipt_sent_at: null }] }));
  const preview = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
  expect(preview.steps).toEqual([expect.objectContaining({ step: 'queue_receipt', invoice_id: 'inv-1' })]);

  db.mockImplementation(fakeDb({ service_records: [RECORD], invoices: [{ id: 'inv-1', status: 'paid' }], receipt_delivery_jobs: [{ id: 'job-1' }] }));
  const blocked = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC });
  expect(blocked.code).toBe('nothing_repairable');
});

test('confirmed: runs the steps in order and returns an itemized receipt', async () => {
  getCloseoutStatus.mockResolvedValue(status({ facts: MISSING_REPORT }));
  const minted = { ...RECORD, report_view_token: 'b'.repeat(32) };
  let tokenMinted = false;
  db.mockImplementation(jest.fn((table) => {
    const chain = { where: () => chain, first: async () => (table === 'service_records' ? (tokenMinted ? minted : RECORD) : undefined) };
    return chain;
  }));
  ensureReportToken.mockImplementation(async () => { tokenMinted = true; return 'b'.repeat(32); });
  enqueueServiceReportV1EmailDelivery.mockResolvedValue({ ok: true, queued: true, delivery: { id: 'del-9', status: 'queued' } });

  const approved = [
    { step: 'publish_report', service_record_id: 'rec-1' },
    { step: 'queue_report_email', service_record_id: 'rec-1', depends_on: 'publish_report' },
  ];
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

test('confirmed: a failed prerequisite leaves its dependent not_attempted and the run partial', async () => {
  getCloseoutStatus.mockResolvedValue(status({ facts: {
    ...MISSING_REPORT,
    invoiceDelivery: { state: 'pending', reason: 'paid_receipt_not_sent', invoiceId: 'inv-1' },
  } }));
  db.mockImplementation(fakeDb({ service_records: [RECORD], invoices: [{ id: 'inv-1', status: 'paid', receipt_sent_at: null }] }));
  ensureReportToken.mockRejectedValue(new Error('db down'));
  enqueueReceiptDelivery.mockResolvedValue({ enqueued: true, job: { id: 'job-2' } });

  const approved = [
    { step: 'publish_report', service_record_id: 'rec-1' },
    { step: 'queue_report_email', service_record_id: 'rec-1', depends_on: 'publish_report' },
    { step: 'queue_receipt', invoice_id: 'inv-1' },
  ];
  const result = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, { confirmed: true, executionPins: { _verified_repair_steps: approved } });
  expect(result.partial).toBe(true);
  expect(executionOutcome(result)).toBe('partially_completed');
  expect(result.receipt.map((r) => [r.step, r.status])).toEqual([
    ['publish_report', 'failed'],
    ['queue_report_email', 'not_attempted'],
    ['queue_receipt', 'completed'],
  ]);
  expect(enqueueServiceReportV1EmailDelivery).not.toHaveBeenCalled();
  expect(enqueueReceiptDelivery).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: 'inv-1', source: 'ib_closeout_repair', customerInitiated: false }));
});

test('a params-level confirmed without the route signal still only plans', async () => {
  getCloseoutStatus.mockResolvedValue(status({ facts: MISSING_REPORT }));
  db.mockImplementation(fakeDb({ service_records: [RECORD] }));
  const res = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC, confirmed: true });
  expect(res.preview).toBe(true);
  expect(ensureReportToken).not.toHaveBeenCalled();
});

test('confirmed: never runs without the verified plan, and never adds a step the card lacked', async () => {
  const facts = {
    report: { state: 'pending', reason: 'no_report_artifact', posture: 'internal_only' },
    reportDelivery: { state: 'not_required', reason: 'frozen_posture_internal_only' },
    invoiceDelivery: { state: 'pending', reason: 'paid_receipt_not_sent', invoiceId: 'inv-1' },
  };
  getCloseoutStatus.mockResolvedValue(status({ facts }));
  db.mockImplementation(fakeDb({ service_records: [RECORD], invoices: [{ id: 'inv-1', status: 'paid', receipt_sent_at: null }] }));

  const unpinned = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, { confirmed: true });
  expect(unpinned.preview_changed).toBe(true);

  // The card approved only the report; the invoice was paid after it was shown.
  const drifted = await executeCloseoutRepairTool('repair_closeout', { service_id: SVC }, {
    confirmed: true, executionPins: { _verified_repair_steps: [{ step: 'publish_report', service_record_id: 'rec-1' }] },
  });
  expect(drifted.preview_changed).toBe(true);
  expect(ensureReportToken).not.toHaveBeenCalled();
  expect(enqueueReceiptDelivery).not.toHaveBeenCalled();
});
