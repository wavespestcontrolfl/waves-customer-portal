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

const { shadowInboundSms, shadowUnknownSenderSms } = require('../services/typed-decisions/sms-shadow');

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
  // the digest of exactly the state Jev was given (previous Waves text + the customer's text)
  const { smsSubjectHash } = require('../services/typed-decisions/subject-hash');
  expect(byPackage['sms_courtesy.v1'].subjectHash).toBe(smsSubjectHash({ previous: 'See you Tuesday.', body: 'Thanks so much!' }));
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
    expect(src.split('.shadowInboundSms(').length - 1).toBe(1); // registered once
    expect(hook).toBeLessThan(src.indexOf('RescheduleSMS.handleRescheduleReply('));
    expect(hook).toBeLessThan(src.indexOf('LeadIntake.handleIntakeReply('));
    // a message with an attachment is never shadowed (Jev would see only the caption)
    expect(src.slice(hook - 600, hook)).toMatch(/if \(Body && !smsReaction && inboundMedia\.length === 0 && customer\?\.id && smsLogEntry\?\.id\)/);
    // and after the solicitation stop, which keeps no customer conversation
    expect(hook).toBeGreaterThan(src.indexOf('if (solicitationEnforced) return res.type('));
    expect(src.slice(hook - 400, hook)).toMatch(/res\.once\('finish'/);
  });

  test('the unknown-sender hook sees exactly the texts the spam screen sees, after the response, registered once', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/twilio-webhook.js'), 'utf8');
    const hook = src.indexOf("require('../services/typed-decisions/sms-shadow').shadowUnknownSenderSms(");
    expect(hook).toBeGreaterThan(-1);
    expect(src.split('.shadowUnknownSenderSms(').length - 1).toBe(1);
    // the screen's own eligibility: not complianceEligible (which covers the AI line), no reaction, no media
    expect(src.slice(hook - 600, hook)).toMatch(/if \(Body && !smsReaction && inboundMedia\.length === 0 && !complianceEligible && smsLogEntry\?\.id\)/);
    expect(src.slice(hook - 400, hook)).toMatch(/res\.once\('finish'/);
    // after the inbound row persists, BEFORE the enforcement stop: a silenced text is shadowed too
    expect(hook).toBeGreaterThan(src.indexOf("const [smsLogEntry] = await db('sms_log').insert("));
    expect(hook).toBeLessThan(src.indexOf('if (solicitationEnforced) return res.type('));
    // it is handed the screen's verdict, whatever the gate's mode
    expect(src.slice(hook, hook + 300)).toMatch(/verdict: solicitation,/);
  });
});

describe('second provider (Cloudflare Clef) leg', () => {
  const clefBefore = process.env.GATE_TYPED_DECISIONS_CLEF;
  afterAll(() => { if (clefBefore === undefined) delete process.env.GATE_TYPED_DECISIONS_CLEF; else process.env.GATE_TYPED_DECISIONS_CLEF = clefBefore; });
  const jevAnswers = { is_courtesy_only: { p: 0.9, yes: true, confident: true }, wants_visit_change: { p: 0.1, yes: false, confident: true } };
  const clefAnswers = { is_courtesy_only: { p: 0.2, yes: false, confident: true }, wants_visit_change: { p: 0.15, yes: false, confident: true } };
  const askBy = (provider) => mockAsk.mock.calls.filter(([, , opts]) => (opts && opts.provider) === provider || (!provider && !(opts && opts.provider)));

  test('Clef gate off: only Jev is asked and recorded, exactly as before (no provider option, no siblings)', async () => {
    delete process.env.GATE_TYPED_DECISIONS_CLEF;
    const out = await shadowInboundSms(base);
    expect(out).toEqual({ asked: 2, recorded: 2, failed: 0 });
    expect(mockAsk.mock.calls.every(([, , opts]) => opts === undefined)).toBe(true);
    expect(mockRecord.mock.calls.every(([a]) => a.provider === 'typesafe' && Object.keys(a.siblingAnswers || {}).length === 0)).toBe(true);
  });

  test('Clef gate on: both providers are asked per package and each row carries the other provider\'s answer as its sibling', async () => {
    process.env.GATE_TYPED_DECISIONS_CLEF = 'true';
    mockAsk.mockImplementation(async (_pkg, _state, opts) => ({ ok: true, packageHash: 'h', provider: opts?.provider || 'typesafe', answers: opts?.provider === 'cloudflare' ? clefAnswers : jevAnswers }));
    const out = await shadowInboundSms(base);
    expect(out).toEqual({ asked: 4, recorded: 4, failed: 0 });
    expect(askBy(undefined)).toHaveLength(2);
    expect(askBy('cloudflare')).toHaveLength(2);
    const courtesy = mockRecord.mock.calls.map(([a]) => a).filter((a) => a.pkg.id === 'sms_courtesy.v1');
    const jev = courtesy.find((a) => a.provider === 'typesafe');
    const clef = courtesy.find((a) => a.provider === 'cloudflare');
    expect(jev.siblingAnswers).toEqual({ is_courtesy_only: [clefAnswers.is_courtesy_only] });
    expect(clef.siblingAnswers).toEqual({ is_courtesy_only: [jevAnswers.is_courtesy_only] });
    expect(clef.baselines).toEqual({ is_courtesy_only: { rules: true } }); // the same rule baseline for both
    expect(clef.subjectHash).toBe(jev.subjectHash);
  });

  test('the Clef leg failing never blocks the Jev row: it is recorded with no siblings, and the failure is counted', async () => {
    process.env.GATE_TYPED_DECISIONS_CLEF = 'true';
    mockAsk.mockImplementation(async (_pkg, _state, opts) => (opts?.provider === 'cloudflare' ? { ok: false, reason: 'cloudflare_429' } : { ok: true, packageHash: 'h', answers: jevAnswers }));
    const out = await shadowInboundSms(base);
    expect(out).toEqual({ asked: 4, recorded: 2, failed: 2 });
    expect(mockRecord.mock.calls.every(([a]) => a.provider === 'typesafe' && Object.keys(a.siblingAnswers).length === 0)).toBe(true);
  });

  test('a Clef throw is contained the same way', async () => {
    process.env.GATE_TYPED_DECISIONS_CLEF = 'true';
    mockAsk.mockImplementation(async (_pkg, _state, opts) => { if (opts?.provider === 'cloudflare') throw new Error('boom'); return { ok: true, packageHash: 'h', answers: jevAnswers }; });
    const out = await shadowInboundSms(base);
    expect(out).toEqual({ asked: 4, recorded: 2, failed: 2 });
  });
});


describe('unknown-sender shadow (sms_solicitation.v1: evidence for GATE_SMS_SPAM_CLASSIFIER)', () => {
  const PITCH = 'We can grow your business with booked pest jobs';
  const ASK = 'Hi, do you treat for roaches? I need someone this week.';
  const originalClef = process.env.GATE_TYPED_DECISIONS_CLEF;
  afterEach(() => { if (originalClef === undefined) delete process.env.GATE_TYPED_DECISIONS_CLEF; else process.env.GATE_TYPED_DECISIONS_CLEF = originalClef; });

  test('gate off, no body, help and opt keywords: no provider call, no write', async () => {
    expect(await shadowUnknownSenderSms({ smsLogId: 's1', body: '   ' })).toMatchObject({ skipped: 'no_body', asked: 0 });
    expect(await shadowUnknownSenderSms({ smsLogId: 's1', body: 'HELP' })).toMatchObject({ skipped: 'help' });
    expect(await shadowUnknownSenderSms({ smsLogId: 's1', body: 'STOP' })).toMatchObject({ skipped: 'opt_keyword' });
    delete process.env.GATE_TYPED_DECISIONS;
    expect(await shadowUnknownSenderSms({ smsLogId: 's1', body: PITCH })).toMatchObject({ skipped: 'gate_off' });
    expect(mockAsk).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('asks sms_solicitation.v1 and records beside the screen regex; no classifier verdict = no production baseline', async () => {
    const out = await shadowUnknownSenderSms({ smsLogId: 's1', body: PITCH });
    expect(mockAsk).toHaveBeenCalledTimes(1);
    expect(mockAsk.mock.calls[0][0]).toBe('sms_solicitation.v1');
    expect(mockAsk.mock.calls[0][1]).toEqual({ previous_waves_text: null, customer_text: PITCH });
    const args = mockRecord.mock.calls[0][0];
    expect(args).toMatchObject({ capability: 'sms_solicitation', provider: 'typesafe', subjectType: 'sms_log', subjectId: 's1' });
    expect(args.baselines).toEqual({ is_solicitation: { rules: true } });
    expect(out).toEqual({ asked: 1, recorded: 1, failed: 0 });
  });

  test('the classifier\'s own model verdict is the production baseline; its regex fast path is not', async () => {
    await shadowUnknownSenderSms({ smsLogId: 's2', body: ASK, verdict: { solicitation: false, confidence: 0.9, method: 'model' } });
    expect(mockRecord.mock.calls[0][0].baselines).toEqual({ is_solicitation: { rules: false, production: false } });
    mockRecord.mockClear();
    await shadowUnknownSenderSms({ smsLogId: 's3', body: PITCH, verdict: { solicitation: true, confidence: 1, method: 'regex' } });
    expect(mockRecord.mock.calls[0][0].baselines).toEqual({ is_solicitation: { rules: true } });
  });

  test('Clef on: both providers answer, each row carries the other\'s answer', async () => {
    process.env.GATE_TYPED_DECISIONS_CLEF = 'true';
    const JEV = { ok: true, answers: { is_solicitation: { p: 0.9, yes: true, confident: true } }, packageHash: 'h' };
    const CLEF = { ok: true, answers: { is_solicitation: { p: 0.4, yes: false, confident: false } }, packageHash: 'h' };
    mockAsk.mockImplementation(async (_id, _state, opts) => (opts?.provider === 'cloudflare' ? CLEF : JEV));
    const out = await shadowUnknownSenderSms({ smsLogId: 's4', body: PITCH });
    const byProvider = Object.fromEntries(mockRecord.mock.calls.map(([a]) => [a.provider, a]));
    expect(byProvider.typesafe.siblingAnswers).toEqual({ is_solicitation: [CLEF.answers.is_solicitation] });
    expect(byProvider.cloudflare.siblingAnswers).toEqual({ is_solicitation: [JEV.answers.is_solicitation] });
    expect(out).toEqual({ asked: 2, recorded: 2, failed: 0 });
  });
});
