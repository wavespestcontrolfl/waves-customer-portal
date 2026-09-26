/**
 * The Monday BI briefing text is sent at most once per ET week
 * (server/services/bi-briefing-sms.js). An atomic sms_send_claims row keyed
 * to the week is taken before the send. It is kept once the text is sent or
 * its delivery is uncertain, and released only when the text definitively
 * did not go out (Codex #4870 r4: cross-instance and after-deadline dedupe).
 */
const mockRaw = jest.fn();
const mockDel = jest.fn();
const mockWhere = jest.fn(() => ({ del: mockDel }));
const mockSend = jest.fn();

jest.mock('../models/db', () => {
  const db = jest.fn(() => ({ where: mockWhere }));
  db.raw = (...args) => mockRaw(...args);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: (...a) => mockSend(...a),
  // The real canonical classifier: these tests pin how its verdict drives the claim.
  classifyDeliveryCertainty: jest.requireActual('../services/messaging/send-customer-message').classifyDeliveryCertainty,
}));

const { etWeekStart } = require('../utils/datetime-et');
const { sendBriefingSmsOnce, claimKeyFor } = require('../services/bi-briefing-sms');

const ORIGINAL_ENV = process.env;
const claimed = () => mockRaw.mockResolvedValueOnce({ rows: [{ id: 1 }] });
const alreadyClaimed = () => mockRaw.mockResolvedValueOnce({ rows: [] });

beforeEach(() => {
  jest.clearAllMocks();
  mockDel.mockResolvedValue(1);
  process.env = { ...ORIGINAL_ENV, ADAM_PHONE: '+19415550100' };
});
afterAll(() => { process.env = ORIGINAL_ENV; });

test('the claim key is the ET week the text belongs to', () => {
  expect(claimKeyFor()).toBe(`bi_briefing_sms:${etWeekStart()}`);
  expect(claimKeyFor('2026-09-28')).toBe('bi_briefing_sms:2026-09-28');
});

test('first send of the week claims the week, sends, and keeps the claim', async () => {
  claimed();
  mockSend.mockResolvedValueOnce({ sent: true, segmentCount: 2, encoding: 'UCS-2', deliveryOutcome: 'accepted' });
  await expect(sendBriefingSmsOnce('📊 Week of 9/28')).resolves.toEqual({ sent: true, segmentCount: 2, encoding: 'UCS-2' });
  expect(mockRaw).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO sms_send_claims[\s\S]*ON CONFLICT \(claim_key\) DO NOTHING/), [claimKeyFor()]);
  expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
    to: '+19415550100', body: '📊 Week of 9/28', purpose: 'internal_briefing', entryPoint: 'bi_agent_send_briefing_sms',
  }));
  expect(mockDel).not.toHaveBeenCalled();
});

test('a week already claimed (another instance, an earlier run, or a send still in flight) never reaches the provider', async () => {
  alreadyClaimed();
  const result = await sendBriefingSmsOnce('📊 again');
  expect(result).toMatchObject({ sent: false, skipped: true });
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockDel).not.toHaveBeenCalled();
});

test('a policy-blocked text releases the week so the agent can retry with a corrected message', async () => {
  claimed();
  mockSend.mockResolvedValueOnce({ sent: false, blocked: true, code: 'SEGMENTS_EXCEEDED', reason: 'too long', deliveryOutcome: 'not_sent' });
  await expect(sendBriefingSmsOnce('x'.repeat(900))).resolves.toEqual({ sent: false, blocked: true, code: 'SEGMENTS_EXCEEDED', reason: 'too long' });
  expect(mockWhere).toHaveBeenCalledWith({ claim_key: claimKeyFor() });
  expect(mockDel).toHaveBeenCalledTimes(1);
});

test('a definite provider failure (not_sent) releases the week', async () => {
  claimed();
  mockSend.mockResolvedValueOnce({ sent: false, code: 'PROVIDER_REJECTED', reason: 'invalid number', deliveryOutcome: 'not_sent' });
  await expect(sendBriefingSmsOnce('📊')).resolves.toMatchObject({ sent: false, blocked: false });
  expect(mockDel).toHaveBeenCalledTimes(1);
});

test('an uncertain provider outcome keeps the claim: the provider may still hold the text', async () => {
  claimed();
  mockSend.mockResolvedValueOnce({ sent: false, code: 'PROVIDER_TIMEOUT', deliveryOutcome: 'uncertain' });
  await expect(sendBriefingSmsOnce('📊')).resolves.toMatchObject({ sent: false, uncertain: true });
  expect(mockDel).not.toHaveBeenCalled();
});

test('a send that throws with no provider outcome keeps the claim and surfaces the error to the runner', async () => {
  claimed();
  mockSend.mockRejectedValueOnce(new Error('socket hang up'));
  await expect(sendBriefingSmsOnce('📊')).rejects.toThrow('socket hang up');
  expect(mockDel).not.toHaveBeenCalled();
});

test('a send that throws before dispatch (providerOutcome not_sent) releases the week (Codex r5)', async () => {
  claimed();
  mockSend.mockRejectedValueOnce(Object.assign(new Error('audit insert failed'), { providerOutcome: { sent: false, deliveryOutcome: 'not_sent' } }));
  await expect(sendBriefingSmsOnce('📊')).rejects.toThrow('audit insert failed');
  expect(mockDel).toHaveBeenCalledTimes(1);
});

test('a send that throws after the provider handoff (uncertain) keeps the claim', async () => {
  claimed();
  mockSend.mockRejectedValueOnce(Object.assign(new Error('audit failed after send'), { providerOutcome: { sent: false, deliveryOutcome: 'uncertain' } }));
  await expect(sendBriefingSmsOnce('📊')).rejects.toThrow('audit failed after send');
  expect(mockDel).not.toHaveBeenCalled();
});

test('a suppression sentinel (sent:true but nothing left) releases the week for a later run', async () => {
  claimed();
  mockSend.mockResolvedValueOnce({ sent: true, providerMessageId: 'template-disabled', deliveryOutcome: 'not_sent' });
  await expect(sendBriefingSmsOnce('📊')).resolves.toMatchObject({ sent: true });
  expect(mockDel).toHaveBeenCalledTimes(1);
});

test('a release that keeps failing is surfaced as claim_release_failed, never swallowed (Codex r7)', async () => {
  claimed();
  mockSend.mockResolvedValueOnce({ sent: false, blocked: true, code: 'SEGMENTS_EXCEEDED', reason: 'too long', deliveryOutcome: 'not_sent' });
  mockDel.mockRejectedValue(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
  await expect(sendBriefingSmsOnce('x'.repeat(900))).rejects.toMatchObject({ code: 'claim_release_failed' });
  expect(mockDel).toHaveBeenCalledTimes(3);
});

test('a transient release failure is retried and the week is freed', async () => {
  claimed();
  mockSend.mockResolvedValueOnce({ sent: false, blocked: true, code: 'SEGMENTS_EXCEEDED', reason: 'too long', deliveryOutcome: 'not_sent' });
  mockDel.mockRejectedValueOnce(new Error('connection reset')).mockResolvedValueOnce(1);
  await expect(sendBriefingSmsOnce('x'.repeat(900))).resolves.toMatchObject({ sent: false, blocked: true });
  expect(mockDel).toHaveBeenCalledTimes(2);
});

test('no ADAM_PHONE: nothing is claimed and nothing is sent', async () => {
  delete process.env.ADAM_PHONE;
  await expect(sendBriefingSmsOnce('📊')).resolves.toEqual({ error: 'ADAM_PHONE not set' });
  expect(mockRaw).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
});
