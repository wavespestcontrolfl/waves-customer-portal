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

test('an in-flight dedupe collision is reported as deduped (no false failure) and does not stamp', async () => {
  // The dedupe winner already holds a queued email_messages row; sendTemplate
  // raises EMAIL_SEND_IN_PROGRESS for the loser. That is not a delivery failure —
  // the statement IS being sent — so we return deduped and never stamp here.
  const updates = [];
  mockDbHandler = () => ({ where() { return this; }, first: async () => finalized(), update: async (p) => { updates.push(p); return 1; } });
  const collision = new Error('email send already in progress'); collision.code = 'EMAIL_SEND_IN_PROGRESS';
  mockSendTemplate.mockRejectedValueOnce(collision);
  const res = await sendStatementEmail(7);
  expect(res).toMatchObject({ ok: true, deduped: true });
  expect(updates).toHaveLength(0); // the winner stamps finalized→sent, not the loser
});

test('first delivery passes a stable idempotency key (no double-send on retry)', async () => {
  mockDbHandler = () => ({ where() { return this; }, first: async () => finalized(), update: async () => 1 });
  await sendStatementEmail(7);
  expect(mockSendTemplate).toHaveBeenCalledWith(expect.objectContaining({
    idempotencyKey: 'payer_statement_sent:7',
  }));
});

test('a normal (non-forced) send of a finalized statement stays keyed (no double-send)', async () => {
  // /send without force is still a first delivery → must keep the stable key so a
  // double-click / client retry can't email AP two copies.
  mockDbHandler = () => ({ where() { return this; }, first: async () => finalized(), update: async () => 1 });
  await sendStatementEmail(7); // forceResend defaults false
  expect(mockSendTemplate.mock.calls[0][0].idempotencyKey).toBe('payer_statement_sent:7');
});

test('forceResend on a BLOCKED first delivery advances to a retry-scoped key (fresh but still deduped)', async () => {
  // Base key (gen 0) blocked; gen 1 (:r1) has no row → that becomes the key. It
  // is fresh (so the retry sends) but STABLE, so a double-click of the retry
  // dedupes on :r1 rather than each inserting a keyless row.
  mockDbHandler = (t) => {
    if (t === 'email_messages') {
      let k = null;
      return { where(c) { k = c.idempotency_key; return this; }, whereIn() { return this; }, first: async () => (k === 'payer_statement_sent:7' ? { id: 99 } : undefined) };
    }
    return { where() { return this; }, first: async () => finalized(), update: async () => 1 };
  };
  await sendStatementEmail(7, { forceResend: true });
  expect(mockSendTemplate).toHaveBeenCalledTimes(1);
  expect(mockSendTemplate.mock.calls[0][0].idempotencyKey).toBe('payer_statement_sent:7:r1');
});

test('forceResend after an async bounce (status already "sent") is still generation-scoped, not keyless', async () => {
  // SendGrid accepted the first send (statement stamped sent), then the webhook
  // marked that row bounced. A force retry must STILL go through forcedRetryKey
  // (base blocked → :r1), never the keyless already-sent branch.
  mockDbHandler = (t) => {
    if (t === 'email_messages') {
      let k = null;
      return { where(c) { k = c.idempotency_key; return this; }, whereIn() { return this; }, first: async () => (k === 'payer_statement_sent:7' ? { id: 77 } : undefined) };
    }
    return { where() { return this; }, first: async () => finalized({ status: 'sent', sent_at: '2026-06-02T00:00:00Z' }), update: async () => 1 };
  };
  await sendStatementEmail(7, { forceResend: true });
  expect(mockSendTemplate.mock.calls[0][0].idempotencyKey).toBe('payer_statement_sent:7:r1');
});

test('forceResend WITHOUT a blocked prior stays on the base key — force cannot bypass dedupe', async () => {
  mockDbHandler = (t) => {
    if (t === 'email_messages') return { where() { return this; }, whereIn() { return this; }, first: async () => undefined };
    return { where() { return this; }, first: async () => finalized(), update: async () => 1 };
  };
  await sendStatementEmail(7, { forceResend: true });
  expect(mockSendTemplate.mock.calls[0][0].idempotencyKey).toBe('payer_statement_sent:7');
});

test('firstDelivery pins the base key even if the row is already stamped sent (close-chain race)', async () => {
  // Concurrent close-and-send: a sibling stamped the row 'sent' between this
  // request's freshness check and the send's re-read. firstDelivery must still
  // use the base key so the two dedupe instead of the late one going keyless.
  mockDbHandler = () => ({ where() { return this; }, first: async () => finalized({ status: 'sent', sent_at: '2026-06-03T00:00:00Z' }), update: async () => 1 });
  await sendStatementEmail(7, { firstDelivery: true });
  expect(mockSendTemplate.mock.calls[0][0].idempotencyKey).toBe('payer_statement_sent:7');
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
