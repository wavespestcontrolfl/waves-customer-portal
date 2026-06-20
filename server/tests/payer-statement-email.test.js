// Statement delivery (Phase 2 — deliver). Verifies the gate, the dry-run path,
// and the load-bearing invariant: with no payer AP email the send FAILS — it
// never falls back to billing the homeowner.

let mockDbHandler = () => { throw new Error('db handler not configured'); };
jest.mock('../models/db', () => {
  const fn = jest.fn((...args) => mockDbHandler(...args));
  fn.fn = { now: jest.fn(() => 'NOW') };
  return fn;
});
const mockIsEnabled = jest.fn(() => true);
jest.mock('../config/feature-gates', () => ({ isEnabled: (...a) => mockIsEnabled(...a) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockBuildPdf = jest.fn(async () => Buffer.from('%PDF-statement'));
jest.mock('../services/pdf/payer-statement-pdf', () => ({ buildPayerStatementPDFBuffer: (...a) => mockBuildPdf(...a) }));
const mockLoadLines = jest.fn(async () => [{ invoice_number: 'INV-1', total: 100 }, { invoice_number: 'INV-2', total: 221 }]);
jest.mock('../services/payer-statements', () => ({ loadStatementLines: (...a) => mockLoadLines(...a) }));
const mockGetPayer = jest.fn(async () => null);
jest.mock('../services/payer', () => ({ getPayer: (...a) => mockGetPayer(...a) }));
const mockSendTemplate = jest.fn(async () => ({ sent: true }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: (...a) => mockSendTemplate(...a) }));
const mockSgConfigured = jest.fn(() => true);
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: (...a) => mockSgConfigured(...a) }));
jest.mock('../services/email-fallback-gate', () => ({ smtpFallbackAllowed: () => false }));

const { sendStatementEmail } = require('../services/payer-statement-email');

const finalized = (over = {}) => ({
  id: 7, payer_id: 9, status: 'finalized', terms_snapshot: 'net30',
  period_start: '2026-05-01', period_end: '2026-05-31', due_date: '2026-07-01',
  subtotal: '300.00', tax_amount: '21.00', total: '321.00', invoice_count: 2,
  payer_snapshot: { company_name: 'West Bay', ap_email: 'ap@westbay.com' },
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockIsEnabled.mockReturnValue(true);
  mockSgConfigured.mockReturnValue(true);
  mockGetPayer.mockResolvedValue(null);
});

test('is a no-op when the gate is off', async () => {
  mockIsEnabled.mockReturnValue(false);
  const res = await sendStatementEmail(7);
  expect(res).toEqual({ ok: false, skipped: 'gate_off' });
  expect(mockBuildPdf).not.toHaveBeenCalled();
});

test('FAILS with no AP email — never falls back to the homeowner', async () => {
  mockDbHandler = () => ({ where() { return this; }, first: async () => finalized({ payer_snapshot: { ap_email: null } }), update: async () => 1 });
  mockGetPayer.mockResolvedValue({ active: true, ap_email: null }); // live payer also has none
  const res = await sendStatementEmail(7);
  expect(res.ok).toBe(false);
  expect(res.error).toBe('no_ap_email');
  expect(mockSendTemplate).not.toHaveBeenCalled();   // nothing sent anywhere
  expect(mockBuildPdf).not.toHaveBeenCalled();
});

test('recovers a missing snapshot AP email from the live payer', async () => {
  const updates = [];
  mockDbHandler = () => ({ where() { return this; }, first: async () => finalized({ payer_snapshot: { ap_email: null } }), update: async (p) => { updates.push(p); return 1; } });
  mockGetPayer.mockResolvedValue({ active: true, ap_email: 'live-ap@westbay.com' });
  const res = await sendStatementEmail(7);
  expect(res.ok).toBe(true);
  expect(res.recipient.email).toBe('live-ap@westbay.com');
  expect(mockSendTemplate).toHaveBeenCalledTimes(1);
});

test('dry-run builds the PDF + resolves recipient but never sends or stamps', async () => {
  const updates = [];
  mockDbHandler = () => ({ where() { return this; }, first: async () => finalized(), update: async (p) => { updates.push(p); return 1; } });
  const res = await sendStatementEmail(7, { dryRun: true });
  expect(res).toMatchObject({ ok: true, dryRun: true });
  expect(res.recipient).toMatchObject({ email: 'ap@westbay.com', count: 2 });
  expect(mockBuildPdf).toHaveBeenCalledTimes(1);
  expect(mockSendTemplate).not.toHaveBeenCalled();
  expect(updates).toHaveLength(0);                   // no finalized→sent stamp
});

test('sends via SendGrid + stamps finalized→sent', async () => {
  const updates = [];
  mockDbHandler = () => ({ where(w) { this._w = w; return this; }, first: async () => finalized(), update: async (p) => { updates.push(p); return 1; } });
  const res = await sendStatementEmail(7);
  expect(res.ok).toBe(true);
  expect(mockSendTemplate).toHaveBeenCalledWith(expect.objectContaining({
    templateKey: 'payer.statement.sent', to: 'ap@westbay.com',
  }));
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({ status: 'sent' });
});

test('first delivery passes a stable idempotency key (no double-send on retry)', async () => {
  mockDbHandler = () => ({ where() { return this; }, first: async () => finalized(), update: async () => 1 });
  await sendStatementEmail(7);
  expect(mockSendTemplate).toHaveBeenCalledWith(expect.objectContaining({
    idempotencyKey: 'payer_statement_sent:7',
  }));
});

test('an explicit resend (already sent) is keyless — intentional re-delivery', async () => {
  mockDbHandler = () => ({ where() { return this; }, first: async () => finalized({ status: 'sent', sent_at: '2026-06-01T00:00:00Z' }), update: async () => 1 });
  await sendStatementEmail(7);
  expect(mockSendTemplate).toHaveBeenCalledTimes(1);
  expect(mockSendTemplate.mock.calls[0][0].idempotencyKey).toBeUndefined();
});

test('refuses to send an OPEN (not-yet-finalized) statement', async () => {
  mockDbHandler = () => ({ where() { return this; }, first: async () => finalized({ status: 'open' }), update: async () => 1 });
  const res = await sendStatementEmail(7);
  expect(res.ok).toBe(false);
  expect(res.error).toBe('statement_not_finalized');
  expect(mockSendTemplate).not.toHaveBeenCalled();
});

test('refuses to email a VOID statement (never reaches AP as "Due")', async () => {
  mockDbHandler = () => ({ where() { return this; }, first: async () => finalized({ status: 'void' }), update: async () => 1 });
  const res = await sendStatementEmail(7);
  expect(res.ok).toBe(false);
  expect(res.error).toBe('statement_not_sendable');
  expect(mockBuildPdf).not.toHaveBeenCalled();
  expect(mockSendTemplate).not.toHaveBeenCalled();
});
