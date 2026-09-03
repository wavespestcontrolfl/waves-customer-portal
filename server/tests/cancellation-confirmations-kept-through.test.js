/**
 * C3 end-of-coverage confirmations: an end_at_term cancel KEEPS paid visits
 * through term_end, so the generic whole-account copy ("upcoming visits are
 * off the calendar") would be materially false. The sender must pick the
 * end-of-term SMS template and hand the email the effective date + the
 * kept-through fact.
 */
const mockSend = jest.fn().mockResolvedValue({ sent: true });
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...a) => mockSend(...a) }));
const mockRender = jest.fn().mockResolvedValue('rendered body');
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: (...a) => mockRender(...a) }));
const mockEmail = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../services/account-membership-email', () => ({ sendCancellationReceived: (...a) => mockEmail(...a) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Send-once probe (messaging_audit_log): default = no prior accepted send.
// The probe's raw predicates are recorded so a test can assert whether the
// term clause was (not) added.
let mockPriorSmsRow = null;
let mockProbeSql = [];
jest.mock('../models/db', () => jest.fn(() => {
  const b = {
    where(c) { if (typeof c === 'function') c.call(b); return b; },
    whereNotNull() { return b; },
    whereRaw(sql, bindings) { mockProbeSql.push([sql, bindings]); return b; },
    orWhereRaw(sql, bindings) { mockProbeSql.push([sql, bindings]); return b; },
    first: async () => mockPriorSmsRow,
  };
  return b;
}));

const { sendCancellationConfirmations } = require('../services/cancellation-confirmations');

const customer = { id: 'cust-1', first_name: 'Pat', phone: '+15550000000' };
const request = { id: 'req-1', created_at: new Date('2026-08-31T14:00:00Z') };

beforeEach(() => { mockSend.mockClear(); mockRender.mockClear(); mockEmail.mockClear(); mockPriorSmsRow = null; mockProbeSql = []; });
const termClause = () => mockProbeSql.find(([sql]) => sql.includes('prepay_term_id'));

test('keptThrough whole-account: end-of-term template, email told the date and that visits stay', async () => {
  const out = await sendCancellationConfirmations({
    customer, request, result: { scope: [] }, processed: true,
    effectiveAt: '2027-02-28T12:00:00-05:00', keptThrough: true,
  });
  expect(out.smsTemplateKey).toBe('service_cancellation_end_of_term_confirmation');
  expect(mockRender.mock.calls[0][1].effective_date).toBe('February 28, 2027');
  expect(mockEmail).toHaveBeenCalledWith(expect.objectContaining({
    keptThrough: true, effectiveAt: '2027-02-28T12:00:00-05:00', processed: true,
  }));
});

test('immediate whole-account keeps the existing template', async () => {
  const out = await sendCancellationConfirmations({ customer, request, result: { scope: [] }, processed: true });
  expect(out.smsTemplateKey).toBe('service_cancellation_confirmation');
  expect(mockEmail).toHaveBeenCalledWith(expect.objectContaining({ keptThrough: false }));
});

test('scoped processed wins over keptThrough (a scoped cancel never has a kept term)', async () => {
  const out = await sendCancellationConfirmations({
    customer, request, result: { scope: ['lawn_care'], remaining: ['pest_control'] }, processed: true, keptThrough: true,
  });
  expect(out.smsTemplateKey).toBe('service_cancellation_scoped_confirmation');
});

test('the processor-verified fee waiver reaches the email (never warn about a waived fee)', async () => {
  await sendCancellationConfirmations({
    customer, request, result: { scope: [], lateFeeWaived: true }, processed: true,
  });
  expect(mockEmail).toHaveBeenCalledWith(expect.objectContaining({ feeWaived: true }));
  mockEmail.mockClear();
  await sendCancellationConfirmations({ customer, request, result: { scope: [] }, processed: true });
  expect(mockEmail).toHaveBeenCalledWith(expect.objectContaining({ feeWaived: false }));
});

test('unprocessed stays on the received (by-hand) template even with keptThrough', async () => {
  const out = await sendCancellationConfirmations({ customer, request, result: null, processed: false, keptThrough: true });
  expect(out.smsTemplateKey).toBe('service_cancellation_received');
});

test('a retry whose SMS already accepted for this request+template skips the resend and still reports the channel', async () => {
  // The audit log shows a provider-accepted send of this exact template for
  // this request — a retry driven by the OTHER channel's failure must not
  // text the same copy twice.
  mockPriorSmsRow = { id: 'audit-1' };
  const out = await sendCancellationConfirmations({ customer, request, result: { scope: [] }, processed: true });
  expect(out.smsSent).toBe(true);
  expect(mockSend).not.toHaveBeenCalled();
  // The email leg still runs (its own class-keyed idempotency dedupes it).
  expect(mockEmail).toHaveBeenCalled();
});

const EP = '2026-09-01T12:00:00.000Z';

test('end-of-term with a prepaid term + episode: send-once probes (term, episode) too; the audit row and the email carry both', async () => {
  await sendCancellationConfirmations({
    customer, request, result: { scope: [] }, processed: true,
    effectiveAt: '2027-02-28T12:00:00-05:00', keptThrough: true, prepayTermId: 'term-1', termEpisodeKey: EP,
  });
  expect(termClause()).toEqual([expect.stringContaining("churn_episode"), ['term-1', EP]]);
  expect(mockSend.mock.calls[0][0].metadata).toEqual(expect.objectContaining({ prepay_term_id: 'term-1', churn_episode: EP, service_request_id: 'req-1' }));
  expect(mockEmail).toHaveBeenCalledWith(expect.objectContaining({ keptThrough: true, prepayTermId: 'term-1', termEpisodeKey: EP }));
});

test('a prior end-of-term send for the SAME (term, episode) under an earlier request skips the resend', async () => {
  // A repeat end-of-coverage commit after the admin latch's 24h echo window
  // opens a NEW request; the audit log still shows the term already told.
  mockPriorSmsRow = { id: 'audit-term' };
  const out = await sendCancellationConfirmations({
    customer, request: { id: 'req-2', created_at: request.created_at }, result: { scope: [] }, processed: true,
    effectiveAt: '2027-02-28T12:00:00-05:00', keptThrough: true, prepayTermId: 'term-1', termEpisodeKey: EP,
  });
  expect(out.smsSent).toBe(true);
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockEmail).toHaveBeenCalledWith(expect.objectContaining({ prepayTermId: 'term-1', termEpisodeKey: EP }));
});

test('the term clause is only added for the end-of-term class with an episode — immediate, by-hand and unanchored stay request-keyed', async () => {
  await sendCancellationConfirmations({ customer, request, result: { scope: [] }, processed: true, prepayTermId: 'term-1', termEpisodeKey: EP });
  expect(termClause()).toBeUndefined();
  mockProbeSql = [];
  await sendCancellationConfirmations({ customer, request, result: null, processed: false, keptThrough: true, prepayTermId: 'term-1', termEpisodeKey: EP });
  expect(termClause()).toBeUndefined();
  mockProbeSql = [];
  // A term without an episode (unanchored churn) — request-keyed.
  await sendCancellationConfirmations({ customer, request, result: { scope: [] }, processed: true, keptThrough: true, prepayTermId: 'term-1' });
  expect(termClause()).toBeUndefined();
  mockProbeSql = [];
  // keptThrough without a term (no prepaid term resolved) — request-keyed.
  await sendCancellationConfirmations({ customer, request, result: { scope: [] }, processed: true, keptThrough: true });
  expect(termClause()).toBeUndefined();
});
