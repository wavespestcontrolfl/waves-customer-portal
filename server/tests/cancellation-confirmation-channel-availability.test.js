// confirmationChannelAvailability — what the Cancel-plan card and the IB
// card PROMISE must be what the commit can deliver: every channel the send
// path blocks deterministically (landline, active STOP, email prefs off,
// malformed address, and — codex GH r28 P2 — an active email suppression:
// bounce / spam complaint / do-not-email) reads unavailable up front.
// Display-only: every lookup fails OPEN (the send-time handling is the
// authority).

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendCancellationReceived: jest.fn() }));
jest.mock('../services/messaging/compliance-contact-checks', () => ({
  latestContactCheck: jest.fn(async () => null),
  isSmsMobileLineType: (t) => t === 'mobile',
}));
const mockLoadTemplate = jest.fn(async () => ({ id: 't1', template_key: 'account.cancellation_received', send_stream: 'transactional' }));
const mockActiveSuppression = jest.fn(async () => null);
jest.mock('../services/email-template-library', () => ({
  loadTemplateByKey: (...a) => mockLoadTemplate(...a),
  activeSuppressionFor: (...a) => mockActiveSuppression(...a),
}));

let mockTables;
jest.mock('../models/db', () => jest.fn((table) => {
  const conds = [];
  const b = {
    where(c) { Object.entries(c).forEach(([k, v]) => conds.push((r) => r[k] === v)); return b; },
    whereNotNull() { return b; },
    whereRaw() { return b; },
    first: async () => (mockTables[table] || []).find((r) => conds.every((c) => c(r))) || null,
  };
  return b;
}));

const { confirmationChannelAvailability, sendCancellationConfirmations } = require('../services/cancellation-confirmations');
const { sendCancellationReceived: mockSendEmail } = require('../services/account-membership-email');
const { sendCustomerMessage: mockSendSms } = require('../services/messaging/send-customer-message');

const customer = { id: 'cust-1', phone: '+19415550100', email: 'pat@example.com' };

beforeEach(() => {
  mockTables = { customers: [{ id: 'cust-1', line_type: 'mobile' }], messaging_suppression: [], notification_prefs: [] };
  mockActiveSuppression.mockReset().mockResolvedValue(null);
  mockLoadTemplate.mockClear();
});

test('a reachable customer: both channels available', async () => {
  expect(await confirmationChannelAvailability(customer)).toEqual({ sms: true, email: true });
});

test('an active email suppression (bounce / complaint / do-not-email) makes email unavailable — the same authority the send consults, resolved against the cancellation template', async () => {
  mockActiveSuppression.mockResolvedValueOnce({ id: 's1', suppression_type: 'bounce' });
  expect(await confirmationChannelAvailability(customer)).toEqual({ sms: true, email: false });
  expect(mockLoadTemplate).toHaveBeenCalledWith('account.cancellation_received');
  expect(mockActiveSuppression).toHaveBeenCalledWith(expect.objectContaining({ template_key: 'account.cancellation_received' }), 'pat@example.com', null);
});

test('an unseeded template still consults the global suppression types', async () => {
  mockLoadTemplate.mockResolvedValueOnce(null);
  mockActiveSuppression.mockResolvedValueOnce({ id: 's2', suppression_type: 'do_not_email' });
  expect(await confirmationChannelAvailability(customer)).toEqual({ sms: true, email: false });
  expect(mockActiveSuppression).toHaveBeenCalledWith({}, 'pat@example.com', null);
});

test('an unreadable suppression store fails OPEN — display only, the send decides', async () => {
  mockActiveSuppression.mockRejectedValueOnce(new Error('suppressions down'));
  expect(await confirmationChannelAvailability(customer)).toEqual({ sms: true, email: true });
});

test('the earlier gates still stand: landline, active STOP, email prefs off, malformed address', async () => {
  mockTables.customers[0].line_type = 'landline';
  mockTables.notification_prefs = [{ customer_id: 'cust-1', email_enabled: false }];
  expect(await confirmationChannelAvailability(customer)).toEqual({ sms: false, email: false });
  mockTables.customers[0].line_type = 'mobile';
  mockTables.notification_prefs = [];
  mockTables.messaging_suppression = [{ id: 'm1', phone: customer.phone, active: true }];
  expect(await confirmationChannelAvailability({ ...customer, email: 'not-an-address' })).toEqual({ sms: false, email: false });
  // No suppression lookup for an address that never passes syntax.
  expect(mockActiveSuppression).not.toHaveBeenCalled();
});

test('the SEND honours the portal-wide email opt-out too — never just the preview (codex GH r29 P1)', async () => {
  mockTables.notification_prefs = [{ customer_id: 'cust-1', email_enabled: false }];
  mockSendEmail.mockClear();
  const out = await sendCancellationConfirmations({
    customer: { ...customer, first_name: 'Pat' }, request: { id: 'req-1', created_at: new Date() },
    result: { scope: [], remaining: [] }, processed: true, entryPoint: 'admin_cancel_plan', identityTrustLevel: 'admin_operator',
  });
  expect(mockSendEmail).not.toHaveBeenCalled();
  // Definitive recipient state: blocked, not failed — the run closes clean
  // on the other channel instead of retrying an opt-out forever.
  expect(out.emailSent).toBe(false);
  expect(out.emailBlocked).toBe(true);
  // Prefs on (or absent): the send goes out as before.
  mockTables.notification_prefs = [];
  mockSendEmail.mockResolvedValueOnce({ ok: true });
  const sent = await sendCancellationConfirmations({
    customer, request: { id: 'req-2', created_at: new Date() },
    result: { scope: [], remaining: [] }, processed: true, entryPoint: 'admin_cancel_plan', identityTrustLevel: 'admin_operator',
  });
  expect(mockSendEmail).toHaveBeenCalledTimes(1);
  expect(sent.emailSent).toBe(true);
});

test('only a DEFINITIVE SMS policy block reads as blocked — a transient consent-lookup failure stays a repairable not-sent (codex GH r33 P2)', async () => {
  const args = { customer: { ...customer, first_name: 'Pat' }, request: { id: 'req-3', created_at: new Date() }, result: { scope: [], remaining: [] }, processed: true, entryPoint: 'admin_cancel_plan', identityTrustLevel: 'admin_operator' };
  mockSendEmail.mockResolvedValue({ ok: true });
  // Transient: the validator could not read consent state — retry later.
  mockSendSms.mockResolvedValueOnce({ sent: false, blocked: true, code: 'CONSENT_LOOKUP_FAILED', reason: 'DB error during lookup' });
  let out = await sendCancellationConfirmations(args);
  expect(out.smsSent).toBe(false);
  expect(out.smsBlocked).toBe(false);
  // Marked retryable by the policy chain: same.
  mockSendSms.mockResolvedValueOnce({ sent: false, blocked: true, code: 'PROVIDER_FAILURE', retryable: true });
  out = await sendCancellationConfirmations({ ...args, request: { id: 'req-4', created_at: new Date() } });
  expect(out.smsBlocked).toBe(false);
  // Definitive: an opt-out is unfixable by retrying.
  mockSendSms.mockResolvedValueOnce({ sent: false, blocked: true, code: 'SUPPRESSED_OPT_OUT' });
  out = await sendCancellationConfirmations({ ...args, request: { id: 'req-5', created_at: new Date() } });
  expect(out.smsBlocked).toBe(true);
});
