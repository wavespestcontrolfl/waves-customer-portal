// Inbound-SMS shadow: gate off / ineligible = no provider call, no write; on =
// two questions asked and recorded beside the rule flags the webhook computed.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockDb = jest.fn();
jest.mock('../models/db', () => (...a) => mockDb(...a));
const mockAsk = jest.fn();
jest.mock('../services/typed-decisions/jev', () => ({ askPackage: (...a) => mockAsk(...a) }));
const mockRecord = jest.fn();
jest.mock('../services/typed-decisions/shadow-recorder', () => ({ recordDecisions: (...a) => mockRecord(...a) }));
const mockEligible = jest.fn();
jest.mock('../services/sms-operational-actions', () => ({ eligibleMessage: (...a) => mockEligible(...a) }));

const { shadowInboundSms } = require('../services/typed-decisions/sms-shadow');

const original = process.env.GATE_TYPED_DECISIONS;
const base = { smsLogId: 'sms-1', customerId: 'cust-1', body: 'Thanks so much!', lastOutboundBody: 'See you Tuesday.', rules: { courtesyOnly: true, rescheduleAsk: false } };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_TYPED_DECISIONS = 'true';
  mockAsk.mockResolvedValue({ ok: true, answers: { x: {} }, packageHash: 'h' });
  mockRecord.mockResolvedValue({ recorded: 1 });
  mockEligible.mockReturnValue(true);
});
afterAll(() => { if (original === undefined) delete process.env.GATE_TYPED_DECISIONS; else process.env.GATE_TYPED_DECISIONS = original; });

test('gate off: no provider call, no read, no write', async () => {
  delete process.env.GATE_TYPED_DECISIONS;
  expect(await shadowInboundSms(base)).toMatchObject({ skipped: 'gate_off', asked: 0 });
  expect(mockAsk).not.toHaveBeenCalled();
  expect(mockRecord).not.toHaveBeenCalled();
  expect(mockDb).not.toHaveBeenCalled();
});

test.each([
  ['no customer', { customerId: null }],
  ['empty body', { body: '   ' }],
  ['no sms row', { smsLogId: null }],
])('%s: skipped before any provider call', async (_n, over) => {
  expect(await shadowInboundSms({ ...base, ...over })).toMatchObject({ skipped: 'no_customer_or_body' });
  expect(mockAsk).not.toHaveBeenCalled();
});

test('an ineligible message (opt-out, reaction, help, AI line) is skipped', async () => {
  mockEligible.mockReturnValue(false);
  const out = await shadowInboundSms({ ...base, fromPhone: '+19415550100', toPhone: '+18445550100', messageType: 'inbound' });
  expect(out).toMatchObject({ skipped: 'ineligible_message' });
  expect(mockEligible).toHaveBeenCalledWith(expect.objectContaining({ direction: 'inbound', customer_id: 'cust-1', to_phone: '+18445550100', message_type: 'inbound' }));
  expect(mockAsk).not.toHaveBeenCalled();
});

test('asks both packages with the same state and records each beside its rule flag', async () => {
  const out = await shadowInboundSms({ ...base, receivedAt: new Date('2026-10-01T12:00:00Z') });
  expect(out).toEqual({ asked: 2, recorded: 2, failed: 0 });
  const state = { previous_waves_text: 'See you Tuesday.', customer_text: 'Thanks so much!' };
  expect(mockAsk).toHaveBeenCalledWith('sms_courtesy.v1', state);
  expect(mockAsk).toHaveBeenCalledWith('sms_reschedule.v1', state);
  const byPackage = Object.fromEntries(mockRecord.mock.calls.map(([a]) => [a.pkg.id, a]));
  expect(byPackage['sms_courtesy.v1']).toMatchObject({ capability: 'sms_courtesy', subjectType: 'sms_log', subjectId: 'sms-1', baselines: { is_courtesy_only: { rules: true } } });
  expect(byPackage['sms_courtesy.v1']).not.toHaveProperty('outcomeEvidence');
  expect(byPackage['sms_reschedule.v1']).toMatchObject({ capability: 'sms_reschedule', baselines: { wants_visit_change: { rules: false } } });
});

test('no previous Waves text is passed as null; the last outbound is read after the ack only when phones are given', async () => {
  await shadowInboundSms({ ...base, lastOutboundBody: undefined });
  expect(mockAsk.mock.calls[0][1].previous_waves_text).toBeNull();
  expect(mockDb).not.toHaveBeenCalled();

  const builder = {};
  for (const m of ['where', 'whereIn', 'whereNot', 'orWhereNull', 'modify', 'orderBy']) builder[m] = jest.fn(() => builder);
  builder.first = jest.fn(async () => ({ message_body: 'Your visit is tomorrow.' }));
  mockDb.mockReturnValue(builder);
  mockAsk.mockClear();
  await shadowInboundSms({ ...base, lastOutboundBody: undefined, fromPhone: '+19415550100', toPhone: '+18445550100', receivedAt: new Date() });
  expect(mockDb).toHaveBeenCalledWith('sms_log');
  expect(builder.where).toHaveBeenCalledWith({ direction: 'outbound', to_phone: '+19415550100', from_phone: '+18445550100' });
  expect(mockAsk.mock.calls[0][1].previous_waves_text).toBe('Your visit is tomorrow.');
});

test('a failed ask is counted, records nothing for it, and never throws', async () => {
  mockAsk.mockImplementation(async (id) => (id === 'sms_courtesy.v1' ? { ok: false, reason: 'error' } : { ok: true, answers: {} }));
  const out = await shadowInboundSms(base);
  expect(out).toEqual({ asked: 2, recorded: 1, failed: 1 });
  expect(mockRecord).toHaveBeenCalledTimes(1);
});

test('a provider throw or a recorder error is contained', async () => {
  mockAsk.mockRejectedValue(new Error('boom'));
  expect(await shadowInboundSms(base)).toEqual({ asked: 2, recorded: 0, failed: 2 });
  mockAsk.mockResolvedValue({ ok: true, answers: {} });
  mockRecord.mockRejectedValue(new Error('db down'));
  expect(await shadowInboundSms(base)).toEqual({ asked: 2, recorded: 0, failed: 2 });
});

describe('twilio-webhook wiring', () => {
  // Consumed replies (a reschedule reply, a lead-intake answer) return early;
  // the shadow must be registered before those returns or they are never
  // sampled. Source order is the contract here: the webhook harness cannot
  // reach both consumed paths cheaply.
  test('the shadow hook is registered before the reschedule-reply and lead-intake returns', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/twilio-webhook.js'), 'utf8');
    const hook = src.indexOf("require('../services/typed-decisions/sms-shadow').shadowInboundSms(");
    expect(hook).toBeGreaterThan(-1);
    expect(src.lastIndexOf('typed-decisions/sms-shadow')).toBe(hook + "require('../services/".length); // registered once
    expect(hook).toBeLessThan(src.indexOf('RescheduleSMS.handleRescheduleReply('));
    expect(hook).toBeLessThan(src.indexOf('LeadIntake.handleIntakeReply('));
    // and after the solicitation stop, which keeps no customer conversation
    expect(hook).toBeGreaterThan(src.indexOf('if (solicitationEnforced) return res.type('));
    expect(src.slice(hook - 400, hook)).toMatch(/res\.once\('finish'/);
  });
});
