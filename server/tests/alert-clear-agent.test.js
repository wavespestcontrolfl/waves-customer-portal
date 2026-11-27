/**
 * Alert clear-up agent (services/alert-clear-agent.js), shadow only. Mocked db and model: the timeline reader, the model and the
 * verdict writer are injected, so this pins the decisions, not the SQL (the SQL was run against a throwaway Postgres schema).
 */
jest.mock('../models/db', () => {
  const db = jest.fn(() => { throw new Error('db must not be read'); });
  db.raw = jest.fn(() => { throw new Error('db must not be read'); });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));
const mockLedger = jest.fn((provider, model, fn) => fn());
jest.mock('../services/llm-dispatch-metrics', () => ({ ledgerCall: (...args) => mockLedger(...args) }));

const db = require('../models/db');
const MODELS = require('../config/models');
const agent = require('../services/alert-clear-agent');

const NOW = new Date('2026-11-26T20:00:00Z');
const ALERT_AT = new Date('2026-11-26T14:00:00Z');
const after = (minutes) => new Date(ALERT_AT.getTime() + minutes * 60 * 1000);

const alertRow = (over = {}) => ({
  id: '11111111-1111-4111-8111-111111111111', category: 'inbound_sms', title: 'Text from Pat Sample', link: '/admin/communications?thread=22222222-2222-4222-8222-222222222222',
  metadata: { rungAt: ALERT_AT.toISOString() }, created_at: ALERT_AT, ...over,
});
const ev = (over = {}) => ({
  type: 'sms', id: 'sms-1', key: 'sms:sms-1', at: after(30), inbound: false, proof: null, draft: false, line: 'WAVES AUTOMATED TEXT (reminder): hi', ...over,
});
const staffText = (over = {}) => ev({ id: 'sms-9', key: 'sms:sms-9', proof: 'staff_text', line: 'WAVES STAFF TEXT: on it', ...over });
const timelineOf = (events = [], over = {}) => ({ alertAt: ALERT_AT, bellAt: ALERT_AT, trigger: 'sms:SM1', complete: true, customerKnown: true, ctx: ['CUSTOMER TEXT: Can you come Friday?'], events, call: null, reply: null, ...over });

const makeDeps = (over = {}) => ({
  cursor: jest.fn(async () => null),
  saveCursor: jest.fn(async () => {}),
  candidates: jest.fn(async () => [alertRow()]),
  lastVerdicts: jest.fn(async () => new Map()),
  aiCountToday: jest.fn(async () => 0),
  timeline: jest.fn(async () => timelineOf()),
  judge: jest.fn(async () => ({ outcome: 'still_owed', why: 'no reply yet', proof: null, model: 'm' })),
  save: jest.fn(async () => {}),
  reserve: jest.fn(async () => 'res-1'),
  finish: jest.fn(async () => {}),
  release: jest.fn(async () => {}),
  ...over,
});
// Every verdict written: plain-rule rows (save) and finished model rows (finish).
const saved = (deps) => [...deps.save.mock.calls.map(([row]) => row), ...deps.finish.mock.calls.map(([, row]) => row)];

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_ALERT_CLEAR_AGENT = 'shadow';
  delete process.env.ALERT_CLEAR_AGENT_DAILY_CAP;
});
afterAll(() => { delete process.env.GATE_ALERT_CLEAR_AGENT; });

describe('gate', () => {
  test.each([undefined, '', 'true', 'Shadow', 'live', ' shadow'])('%p is off: no db read, nothing injected is called', async (value) => {
    if (value === undefined) delete process.env.GATE_ALERT_CLEAR_AGENT; else process.env.GATE_ALERT_CLEAR_AGENT = value;
    const deps = makeDeps();
    const out = await agent.runAlertClearAgent({ now: NOW, deps });
    expect(out).toEqual({ skipped: 'gate_off' });
    expect(deps.candidates).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
    expect(db.raw).not.toHaveBeenCalled();
  });

  test('with the gate off and no injected deps the real readers are never reached', async () => {
    delete process.env.GATE_ALERT_CLEAR_AGENT;
    await expect(agent.runAlertClearAgent({ now: NOW })).resolves.toEqual({ skipped: 'gate_off' });
    expect(db).not.toHaveBeenCalled();
  });

  test('the model tier is the Sonnet class id of ROUTINE and the lane is registered', () => {
    expect(MODELS.ALERT_CLEAR).toBe(MODELS.ROUTINE);
    expect(require('../services/model-switchboard').LANES.some((l) => l.id === 'alert_clear_agent')).toBe(true);
  });
});

describe('rule 1: a quiet unknown missed call', () => {
  const missed = alertRow({ category: 'missed_call', title: 'Unknown caller', link: '/admin/communications#tab=calls&call=33333333-3333-4333-8333-333333333333' });
  const quiet = (over = {}) => timelineOf([], { customerKnown: false, call: { customerId: null, hasVoicemail: false, textBackSent: true }, ...over });
  const run = async (timeline, now = new Date(ALERT_AT.getTime() + 25 * 3600 * 1000)) => {
    const deps = makeDeps({ candidates: async () => [missed], timeline: async () => timeline });
    await agent.runAlertClearAgent({ now, deps });
    return { deps, rows: saved(deps) };
  };

  test('no customer, no voicemail, text-back sent, 24 h of silence: nothing_to_answer by rule, no model call', async () => {
    const { deps, rows } = await run(quiet());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'nothing_to_answer', source: 'rule', rule: 'quiet_unknown_missed_call' });
    expect(deps.judge).not.toHaveBeenCalled();
  });

  test.each([
    ['a voicemail was left', quiet({ call: { customerId: null, hasVoicemail: true, textBackSent: true } })],
    ['the text-back was not sent', quiet({ call: { customerId: null, hasVoicemail: false, textBackSent: false } })],
    ['the caller is a customer', quiet({ call: { customerId: 'c1', hasVoicemail: false, textBackSent: true } })],
    ['the number texted back', quiet({ events: [ev({ inbound: true, line: 'CUSTOMER TEXT: who called?' })] })],
    ['the number called again', quiet({ events: [ev({ type: 'call', id: 'call-2', key: 'call:call-2', inbound: true, line: 'CALL inbound' })] })],
  ])('not closed by the rule when %s', async (_name, timeline) => {
    const { rows } = await run(timeline);
    expect(rows.every((r) => r.rule !== 'quiet_unknown_missed_call')).toBe(true);
  });

  test('not closed before 24 hours have passed', async () => {
    const { rows } = await run(quiet(), new Date(ALERT_AT.getTime() + 3 * 3600 * 1000));
    expect(rows.every((r) => r.rule !== 'quiet_unknown_missed_call')).toBe(true);
  });

  test('the fingerprint changes once when the 24 hours pass, so the rule gets a fresh look', () => {
    const early = agent.fingerprintOf(missed, quiet(), new Date(ALERT_AT.getTime() + 3 * 3600 * 1000));
    const late = agent.fingerprintOf(missed, quiet(), new Date(ALERT_AT.getTime() + 25 * 3600 * 1000));
    expect(early).not.toBe(late);
  });
});

describe('rule 2: a person answered after the alert', () => {
  const answerOf = async (events, alert = alertRow()) => {
    const deps = makeDeps({ candidates: async () => [alert], timeline: async () => timelineOf(events) });
    await agent.runAlertClearAgent({ now: NOW, deps });
    return { deps, rows: saved(deps) };
  };

  test('a delivered staff text is answered, proof = that record, no model call', async () => {
    const { deps, rows } = await answerOf([staffText()]);
    expect(rows[0]).toMatchObject({ outcome: 'answered', source: 'rule', rule: 'staff_text', proof_type: 'sms', proof_id: 'sms-9' });
    expect(deps.judge).not.toHaveBeenCalled();
  });

  test('a sent staff email is answered', async () => {
    const { rows } = await answerOf([ev({ type: 'email', id: 'em-1', key: 'email:em-1:live', proof: 'staff_email' })]);
    expect(rows[0]).toMatchObject({ outcome: 'answered', rule: 'staff_email', proof_type: 'email', proof_id: 'em-1' });
  });

  test('a call a person answered is answered', async () => {
    const { rows } = await answerOf([ev({ type: 'call', id: 'call-5', key: 'call:call-5', proof: 'human_call' })]);
    expect(rows[0]).toMatchObject({ outcome: 'answered', rule: 'human_call', proof_id: 'call-5' });
  });

  test('an automated text, an unsent draft and a customer text are not an answer', async () => {
    const { deps } = await answerOf([ev(), ev({ type: 'email', id: 'em-2', key: 'email:em-2:draft', draft: true, line: 'WAVES EMAIL DRAFT (never sent)' }), ev({ id: 'sms-3', key: 'sms:sms-3', inbound: true })]);
    expect(deps.judge).toHaveBeenCalledTimes(1);
  });

  test('an event from before the alert is not an answer', async () => {
    const { deps } = await answerOf([staffText({ at: after(-5) })]);
    expect(deps.judge).toHaveBeenCalledTimes(1);
  });

  test('a text is a person\'s only when the caller says so (message_type manual alone is not enough)', () => {
    const row = { id: 'x', direction: 'outbound', message_type: 'manual', status: 'delivered', created_at: after(5), message_body: 'hi' };
    expect(agent.smsEvent(row, false).proof).toBeNull();
    expect(agent.smsEvent(row, true).proof).toBe('staff_text');
    expect(agent.smsEvent({ ...row, direction: 'inbound' }, false).proof).toBeNull();
  });
});

describe('what counts as a person on a call', () => {
  const row = (over) => ({ id: 'c1', created_at: after(1), ended_at: after(3), direction: 'outbound', answered_by: null, person_back: false, human_in: false, ...over });

  test('only the repo predicates make a call a person\'s: a staff bridge call back, or an inbound call a human answered', () => {
    expect(agent.callEvent(row({ person_back: true })).proof).toBe('human_call');
    expect(agent.callEvent(row({ direction: 'inbound', human_in: true, answered_by: 'human' })).proof).toBe('human_call');
  });

  test('seconds, a voicemail answer or a machine never make one', () => {
    expect(agent.callEvent(row({ duration_seconds: 300 })).proof).toBeNull();
    expect(agent.callEvent(row({ answered_by: 'voicemail' })).proof).toBeNull();
    expect(agent.callEvent(row({ answered_by: 'voice_agent' })).proof).toBeNull();
  });

  test('a call with no end stamp has no trustworthy end: no proof; with one, the event is dated by when it ended', () => {
    expect(agent.callEvent(row({ person_back: true, ended_at: null })).proof).toBeNull();
    expect(agent.callEvent(row({ person_back: true })).at).toEqual(after(3));
  });
});

describe('an alert that says we owe something', () => {
  const owedTitle = alertRow({ category: 'missed_call', title: 'Pat called back — we still owe a quote' });
  const owedMeta = alertRow({ category: 'missed_call', title: 'Pat called back', metadata: { rungAt: ALERT_AT.toISOString(), doneWhen: 'promise_fulfilled' } });

  test.each([['title', owedTitle], ['doneWhen', owedMeta]])('owed by %s: the model is never asked and cannot close it', async (_n, alert) => {
    const deps = makeDeps({ candidates: async () => [alert], timeline: async () => timelineOf([ev(), ev({ type: 'visit', id: 'v1', key: 'visit:v1:booked', proof: 'booking', line: 'VISIT created' })]) });
    await agent.runAlertClearAgent({ now: NOW, deps });
    expect(deps.judge).not.toHaveBeenCalled();
    expect(saved(deps)[0]).toMatchObject({ outcome: 'still_owed', source: 'rule', rule: 'owed_open' });
  });

  test('a quiet missed call that is owed is not closed by rule 1', async () => {
    const deps = makeDeps({
      candidates: async () => [owedTitle],
      timeline: async () => timelineOf([], { customerKnown: false, call: { customerId: null, hasVoicemail: false, textBackSent: true } }),
    });
    await agent.runAlertClearAgent({ now: new Date(ALERT_AT.getTime() + 30 * 3600 * 1000), deps });
    expect(saved(deps)[0].outcome).toBe('still_owed');
  });

  test('a sent estimate or a staff text answers it', async () => {
    const cases = [[ev({ type: 'estimate', id: 'es-1', key: 'estimate:es-1', proof: 'estimate_sent' }), 'estimate_sent'], [staffText(), 'staff_text']];
    for (const [event, rule] of cases) {
      const deps = makeDeps({ candidates: async () => [owedTitle], timeline: async () => timelineOf([event]) });
      await agent.runAlertClearAgent({ now: NOW, deps });
      expect(saved(deps)[0]).toMatchObject({ outcome: 'answered', rule, proof_id: event.id });
    }
  });
});

describe('the model verdict and the proof check', () => {
  const runWith = async (events, reply, extra = {}) => {
    const deps = makeDeps({ timeline: async () => timelineOf(events, extra), judge: jest.fn(async () => ({ model: 'm', ...reply })) });
    await agent.runAlertClearAgent({ now: NOW, deps });
    return { deps, row: saved(deps)[0] };
  };
  const booking = ev({ type: 'visit', id: 'v1', key: 'visit:v1:booked', proof: 'booking', at: after(45), line: 'VISIT created after the alert' });

  test('answered with a real record after the alert is kept, with that record as proof', async () => {
    const { row } = await runWith([ev(), booking], { outcome: 'answered', why: 'visit booked for Friday', proof: 'E2' });
    expect(row).toMatchObject({ outcome: 'answered', source: 'ai', proof_type: 'visit', proof_id: 'v1', model: 'm' });
  });

  test.each([
    ['an automated text', [ev()], 'E1'],
    ['an unsent draft', [ev({ type: 'email', id: 'em-2', key: 'email:em-2:draft', draft: true, line: 'DRAFT' })], 'E1'],
    ['an event from before the alert', [ev({ proof: 'booking', at: after(-10) })], 'E1'],
    ['a customer message', [ev({ inbound: true })], 'E1'],
    ['an id that is not in the timeline', [booking], 'E7'],
    ['no proof at all', [booking], null],
  ])('proof rejected: %s -> still_owed', async (_n, events, proof) => {
    const { row } = await runWith(events, { outcome: 'answered', why: 'looks done', proof });
    expect(row).toMatchObject({ outcome: 'still_owed', source: 'ai', rule: 'proof_rejected', proof_id: null });
  });

  test('nothing_to_answer from the model is kept for a plain thanks', async () => {
    const { row } = await runWith([], { outcome: 'nothing_to_answer', why: 'customer only said thanks', proof: null });
    expect(row).toMatchObject({ outcome: 'nothing_to_answer', source: 'ai' });
  });

  test('a bare yes to an offered time closes only when the model names the booking as the answer', async () => {
    const reply = { lastBody: 'Yes', prevOutbound: 'We could come Friday at 10 am. Does that work?', whole: true };
    const none = await runWith([], { outcome: 'nothing_to_answer', why: 'customer said yes', proof: null }, { reply });
    expect(none.row).toMatchObject({ outcome: 'still_owed', source: 'ai', rule: 'yes_to_offer_no_booking' });
    // A booking exists, but "nothing to answer" names no record: the model never said the booking is the answer.
    const unnamed = await runWith([booking], { outcome: 'nothing_to_answer', why: 'yes to a booked time', proof: null }, { reply });
    expect(unnamed.row).toMatchObject({ outcome: 'still_owed', rule: 'yes_to_offer_no_booking' });
    const named = await runWith([booking], { outcome: 'answered', why: 'booked Friday at 10', proof: 'E1' }, { reply });
    expect(named.row).toMatchObject({ outcome: 'answered', proof_id: 'v1' });
  });

  test('why is cut to 14 words and card numbers are masked in what the model sees', () => {
    const parsed = agent.parseJudgeReply('{"outcome":"still_owed","why":"one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen","proof":null}');
    expect(parsed.why.split(' ')).toHaveLength(14);
    const input = agent.judgeInput(alertRow(), timelineOf([], { ctx: ['CUSTOMER TEXT: my card is 4242 4242 4242 4242 thanks'] }), agent.computeFacts(timelineOf()));
    expect(input).not.toMatch(/4242 4242 4242 4242/);
    expect(input).toMatch(/FIXED FACTS/);
  });

  test('the fixed facts are computed in code from the timeline', () => {
    const facts = agent.computeFacts(timelineOf([ev({ type: 'email', id: 'em-2', key: 'email:em-2:draft', draft: true }), booking]));
    // a booking is another answer, so it is NOT drafts-only
    expect(facts).toMatchObject({ staffTextAfter: false, bookingOrDateChangeAfter: true, onlyDrafts: false, estimateSentAfter: false, customerOnFile: true });
  });
});

describe('errors fail safe', () => {
  const run = async (judge) => {
    const deps = makeDeps({ judge });
    const out = await agent.runAlertClearAgent({ now: NOW, deps });
    return { deps, out, rows: saved(deps) };
  };

  test.each([
    ['a thrown error', async () => { throw Object.assign(new Error('boom'), { status: 529 }); }],
    ['an unusable reply', async () => { throw new Error('unusable reply'); }],
  ])('%s -> still_owed with rule ai_error, never another outcome', async (_n, judge) => {
    const { rows } = await run(judge);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'still_owed', source: 'ai', rule: 'ai_error' });
  });

  test('a missing API key writes no row and gives the reservation back', async () => {
    const { rows, deps } = await run(async () => { throw new agent.NoKeyError('no key'); });
    expect(rows).toHaveLength(0);
    expect(deps.release).toHaveBeenCalledWith('res-1');
  });

  test('an incomplete timeline is not judged (a failed read is not "nothing happened")', async () => {
    const deps = makeDeps({ timeline: async () => timelineOf([], { complete: false }) });
    await agent.runAlertClearAgent({ now: NOW, deps });
    expect(deps.judge).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
  });

  test('an incomplete timeline is skipped before any rule: even one holding a staff text writes no verdict, and it is logged', async () => {
    const logger = require('../services/logger');
    const deps = makeDeps({ timeline: async () => timelineOf([staffText()], { complete: false }) });
    const out = await agent.runAlertClearAgent({ now: NOW, deps });
    expect(out.incomplete).toBe(1);
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.reserve).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/incomplete timeline/));
  });

  test('an alert that does not link to a record is still_owed by rule', async () => {
    const deps = makeDeps({ timeline: async () => ({ alertAt: ALERT_AT, unreadable: true, complete: true, ctx: [], events: [], call: null }) });
    await agent.runAlertClearAgent({ now: NOW, deps });
    expect(saved(deps)[0]).toMatchObject({ outcome: 'still_owed', source: 'rule', rule: 'unreadable' });
    expect(deps.judge).not.toHaveBeenCalled();
  });

  test('a failing alert does not stop the sweep', async () => {
    const second = alertRow({ id: '44444444-4444-4444-8444-444444444444' });
    const timeline = jest.fn().mockRejectedValueOnce(new Error('db gone')).mockResolvedValue(timelineOf());
    const deps = makeDeps({ candidates: async () => [alertRow(), second], timeline });
    const out = await agent.runAlertClearAgent({ now: NOW, deps });
    expect(out.errors).toBe(1);
    expect(saved(deps)).toHaveLength(1);
  });
});

describe('fingerprint skip', () => {
  test('same after-events: judged once; a new event: judged again', async () => {
    const rows = new Map();
    let events = [ev()];
    const remember = async (row) => { rows.set(row.notification_id, { ...row, created_at: NOW }); };
    const deps = makeDeps({
      timeline: async () => timelineOf(events),
      lastVerdicts: async () => new Map(rows),
      save: jest.fn(remember),
      finish: jest.fn(async (_id, row) => remember(row)),
    });
    await agent.runAlertClearAgent({ now: NOW, deps });
    const again = await agent.runAlertClearAgent({ now: new Date(NOW.getTime() + 600000), deps });
    expect(again.unchanged).toBe(1);
    expect(deps.judge).toHaveBeenCalledTimes(1);
    events = [ev(), ev({ id: 'sms-2', key: 'sms:sms-2', inbound: true })];
    await agent.runAlertClearAgent({ now: new Date(NOW.getTime() + 1200000), deps });
    expect(deps.judge).toHaveBeenCalledTimes(2);
  });

  test('the fingerprint is the same for the same ids in any order and differs when an id differs', () => {
    const a = agent.fingerprintOf(alertRow(), timelineOf([ev(), staffText()]), NOW);
    const b = agent.fingerprintOf(alertRow(), timelineOf([staffText(), ev()]), NOW);
    expect(a).toBe(b);
    expect(agent.fingerprintOf(alertRow(), timelineOf([ev()]), NOW)).not.toBe(a);
  });

  test('unchanged(): an ai_error row is retried only after an hour', () => {
    const fp = 'abc';
    const row = (age) => ({ fingerprint: fp, rule: 'ai_error', created_at: new Date(NOW.getTime() - age) });
    expect(agent.unchanged(row(10 * 60 * 1000), fp, NOW)).toBe(true);
    expect(agent.unchanged(row(61 * 60 * 1000), fp, NOW)).toBe(false);
    expect(agent.unchanged({ fingerprint: fp, rule: null, created_at: new Date(0) }, fp, NOW)).toBe(true);
    expect(agent.unchanged(undefined, fp, NOW)).toBe(false);
  });
});

describe('daily cap', () => {
  const many = (n) => Array.from({ length: n }, (_x, i) => alertRow({ id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}` }));

  test('at the cap the model is not called and no AI row is written; rule rows still are', async () => {
    process.env.ALERT_CLEAR_AGENT_DAILY_CAP = '5';
    const alerts = [...many(2), alertRow({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001' })];
    const deps = makeDeps({
      candidates: async () => alerts,
      aiCountToday: async () => 5,
      timeline: jest.fn(async (alert) => timelineOf(alert.id.startsWith('bbbbbbbb') ? [staffText()] : [])),
    });
    await agent.runAlertClearAgent({ now: NOW, deps });
    expect(deps.judge).not.toHaveBeenCalled();
    expect(saved(deps).map((r) => r.source)).toEqual(['rule']);
  });

  test('only the remaining count is spent in one sweep', async () => {
    process.env.ALERT_CLEAR_AGENT_DAILY_CAP = '5';
    const deps = makeDeps({ candidates: async () => many(8), aiCountToday: async () => 3 });
    await agent.runAlertClearAgent({ now: NOW, deps });
    expect(deps.judge).toHaveBeenCalledTimes(2);
  });

  test('default cap is 150 and one sweep spends at most 40', async () => {
    const deps = makeDeps({ candidates: async () => many(60) });
    await agent.runAlertClearAgent({ now: NOW, deps });
    expect(deps.judge).toHaveBeenCalledTimes(40);
  });
});

describe('the model call', () => {
  test('goes through ledgerCall with the lane id and the registry model, and reads text past a thinking block', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: '{"outcome":"still_owed","why":"no reply yet","proof":null}' }],
    });
    const out = await agent.callModel('ALERT');
    expect(out).toMatchObject({ outcome: 'still_owed', model: MODELS.ALERT_CLEAR });
    expect(mockLedger).toHaveBeenCalledWith('anthropic', MODELS.ALERT_CLEAR, expect.any(Function), { laneId: 'alert_clear_agent' });
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ model: MODELS.ALERT_CLEAR, system: agent.SYSTEM_PROMPT });
    expect(mockCreate.mock.calls[0][0].max_tokens).toBeGreaterThanOrEqual(1024);
  });

  test.each([
    ['a refusal', { stop_reason: 'refusal', content: [] }],
    ['a cut reply', { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"outcome"' }] }],
    ['bad JSON', { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }],
    ['an outcome outside the three', { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"outcome":"closed","why":"x","proof":null}' }] }],
  ])('%s throws, so the caller records still_owed', async (_n, response) => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockCreate.mockResolvedValue(response);
    await expect(agent.callModel('ALERT')).rejects.toThrow();
  });

  test('no key: nothing is called and the sweep writes no row for it', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const deps = makeDeps({ judge: agent.callModel });
    await agent.runAlertClearAgent({ now: NOW, deps });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
  });
});

describe('P0: nothing secret goes to the model', () => {
  const secretLine = 'WAVES AUTOMATED TEXT (receipt): your receipt https://pay.wavespestcontrol.com/r/Zk3pQ9xV7mN2bT8cL4wH5yJ6 and portal https://wavespestcontrol.com/portal/9f8e7d6c5b4a39281706f5e4d3c2b1a0 password: hunter2secret';

  test('bearer links, tokens and passwords are removed before the cut, and card numbers are masked', () => {
    const text = agent.clean('Pay here https://wavespestcontrol.com/pay/Zk3pQ9xV7mN2bT8cL4wH5yJ6 card 4242 4242 4242 4242 PIN is 4821');
    expect(text).not.toMatch(/Zk3pQ9xV7mN2bT8cL4wH5yJ6/);
    expect(text).not.toMatch(/4242 4242 4242 4242/);
    expect(text).not.toMatch(/4821/);
  });

  test('the whole input text is clean even when a line was built without clean()', () => {
    const input = agent.judgeInput(alertRow({ title: 'Text https://wavespestcontrol.com/estimate/9f8e7d6c5b4a39281706f5e4d3c2b1a0' }),
      timelineOf([ev({ line: secretLine })], { ctx: ['CUSTOMER TEXT: my link https://wavespestcontrol.com/portal/9f8e7d6c5b4a39281706f5e4d3c2b1a0'] }), agent.computeFacts(timelineOf()));
    expect(input).not.toMatch(/Zk3pQ9xV7mN2bT8cL4wH5yJ6|9f8e7d6c5b4a39281706f5e4d3c2b1a0|hunter2secret/);
    expect(input).toMatch(/FIXED FACTS/);
  });

  test('an automated text with a receipt link is built with the link already gone', () => {
    const line = agent.smsEvent({ id: 's', direction: 'outbound', message_type: 'receipt', status: 'sent', created_at: after(5), message_body: 'Receipt https://wavespestcontrol.com/receipt/Zk3pQ9xV7mN2bT8cL4wH5yJ6 thanks' }).line;
    expect(line).not.toMatch(/Zk3pQ9xV7mN2bT8cL4wH5yJ6/);
  });
});

describe('P0: the budget is reserved before the paid call', () => {
  test('the attempt row is written first, the call second, the finish third', async () => {
    const order = [];
    const deps = makeDeps({
      reserve: jest.fn(async () => { order.push('reserve'); return 'res-9'; }),
      judge: jest.fn(async () => { order.push('judge'); return { outcome: 'still_owed', why: 'no reply yet', proof: null, model: 'm' }; }),
      finish: jest.fn(async () => { order.push('finish'); }),
    });
    await agent.runAlertClearAgent({ now: NOW, deps });
    expect(order).toEqual(['reserve', 'judge', 'finish']);
    expect(deps.reserve.mock.calls[0][0]).toMatchObject({ source: 'ai', rule: 'ai_reserved', outcome: 'still_owed' });
    expect(deps.finish.mock.calls[0][0]).toBe('res-9');
  });

  test('a failed reservation means no paid call and the budget is given back', async () => {
    const deps = makeDeps({ reserve: jest.fn(async () => { throw new Error('insert failed'); }) });
    const out = await agent.runAlertClearAgent({ now: NOW, deps });
    expect(deps.judge).not.toHaveBeenCalled();
    expect(out.skipped).toBe(1);
  });

  test('a failed finish keeps the reservation row, so the paid call is still counted; the retry waits an hour', async () => {
    const deps = makeDeps({ finish: jest.fn(async () => { throw new Error('update failed'); }) });
    const out = await agent.runAlertClearAgent({ now: NOW, deps });
    expect(out.unsaved).toBe(1);
    expect(deps.release).not.toHaveBeenCalled();
    const fp = agent.fingerprintOf(alertRow(), timelineOf(), NOW);
    const row = (age) => ({ fingerprint: fp, rule: 'ai_reserved', created_at: new Date(NOW.getTime() - age) });
    expect(agent.unchanged(row(5 * 60 * 1000), fp, NOW)).toBe(true);
    expect(agent.unchanged(row(61 * 60 * 1000), fp, NOW)).toBe(false);
  });

  test('reservations count in the day cap: with the count already at the cap, even a retry cannot pay', async () => {
    process.env.ALERT_CLEAR_AGENT_DAILY_CAP = '3';
    const deps = makeDeps({ aiCountToday: async () => 3 });
    await agent.runAlertClearAgent({ now: NOW, deps });
    expect(deps.reserve).not.toHaveBeenCalled();
    expect(deps.judge).not.toHaveBeenCalled();
  });
});

describe('fingerprint: re-rings and state changes get a new look', () => {
  const fp = (alert, tl) => agent.fingerprintOf(alert, tl, NOW);
  test('a new ring, a new triggering message or a changed record state changes it', () => {
    const base = fp(alertRow(), timelineOf([ev()]));
    expect(fp(alertRow(), timelineOf([ev()], { bellAt: after(90) }))).not.toBe(base);
    expect(fp(alertRow(), timelineOf([ev()], { trigger: 'sms:SM2' }))).not.toBe(base);
    expect(fp(alertRow(), timelineOf([ev({ key: 'sms:sms-1:delivered:n' })]))).not.toBe(base);
    expect(fp(alertRow(), timelineOf([ev()]))).toBe(base);
  });
});

describe('row limits: proof and fingerprint see every row, only the excerpts are cut', () => {
  test('an answering record behind many other rows is still found by the rule', async () => {
    const lots = Array.from({ length: 80 }, (_x, i) => ev({ id: `a${i}`, key: `sms:a${i}`, at: after(i + 1) }));
    const deps = makeDeps({ timeline: async () => timelineOf([...lots, staffText({ at: after(200) })]) });
    await agent.runAlertClearAgent({ now: NOW, deps });
    expect(saved(deps)[0]).toMatchObject({ outcome: 'answered', rule: 'staff_text', proof_id: 'sms-9' });
  });

  test('the model sees every proof record and only the latest context lines', () => {
    const lots = Array.from({ length: 80 }, (_x, i) => ev({ id: `a${i}`, key: `sms:a${i}`, at: after(i + 1), line: `AUTO ${i}` }));
    const booking = ev({ type: 'visit', id: 'v1', key: 'visit:v1', proof: 'booking', at: after(5), line: 'VISIT early booking' });
    const input = agent.judgeInput(alertRow(), timelineOf([...lots, booking]), agent.computeFacts(timelineOf([booking])));
    expect(input).toMatch(/VISIT early booking/);
    expect(input).toMatch(/AUTO 79/);
    expect(input).not.toMatch(/AUTO 3\b/);
    expect((input.match(/^E\d+ \|/gm) || []).length).toBe(13);
  });
});

describe('the booking requirement holds on every path', () => {
  const reply = { lastBody: 'Yes', prevOutbound: 'We could come Friday at 10 am. Does that work?', whole: true };
  const run = async (events, extra = {}, judge) => {
    const deps = makeDeps({ timeline: async () => timelineOf(events, { reply, ...extra }), ...(judge ? { judge } : {}) });
    await agent.runAlertClearAgent({ now: NOW, deps });
    return { deps, row: saved(deps)[0] };
  };
  const booking = ev({ type: 'visit', id: 'v1', key: 'visit:v1:booked:pending', proof: 'booking', at: after(45), line: 'VISIT created' });
  const staffMove = ev({ type: 'reschedule', id: 'rl-1', key: 'reschedule:rl-1', proof: 'date_change', at: after(50), line: 'VISIT MOVED by Waves staff' });
  // Listed ids follow time: the staff text (minute 30) is E1, the booking or the move is E2.
  const judgeNames = (ref) => jest.fn(async () => ({ outcome: 'answered', why: 'done', proof: ref, model: 'm' }));

  // An unrelated move (9 to 11 after a yes to 3 PM) once lifted this guard and let a plain staff text close the yes. No rule closes a
  // yes now: the model judges the offered day and time and must name the booking or move it judged.
  test('no plain rule closes a bare yes to an offer: with a staff move it goes to the model, and an answer naming the staff text is held', async () => {
    const { deps, row } = await run([staffText(), staffMove], {}, judgeNames('E1'));
    expect(deps.judge).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({ outcome: 'still_owed', source: 'ai', rule: 'yes_to_offer_no_booking' });
  });

  // Whether a yes accepts an offered time is the model's reading ("yes_to_offer"); code holds the model to it. A reply that leaves
  // the field out keeps the booking requirement.
  test('the model says whether a bare yes accepts an offered time, and code holds it to that reading', async () => {
    const reads = (yesToOffer) => jest.fn(async () => ({ outcome: 'answered', why: 'staff replied', proof: 'E1', model: 'm', ...(yesToOffer === undefined ? {} : { yesToOffer }) }));
    const offered = await run([staffText()], {}, reads(true));
    expect(offered.deps.judge).toHaveBeenCalledTimes(1);
    expect(offered.row).toMatchObject({ outcome: 'still_owed', source: 'ai', rule: 'yes_to_offer_no_booking' });
    expect((await run([staffText()], {}, reads(undefined))).row).toMatchObject({ outcome: 'still_owed', rule: 'yes_to_offer_no_booking' });
    expect((await run([staffText()], {}, reads(false))).row).toMatchObject({ outcome: 'answered', source: 'ai', proof_id: 'sms-9' });
  });

  test('only an explicit false in the reply lifts the booking requirement', () => {
    const parse = (tail) => agent.parseJudgeReply(`{"outcome":"nothing_to_answer","why":"ok to a bill","proof":null${tail}}`);
    expect(parse(',"yes_to_offer":false').yesToOffer).toBe(false);
    expect(parse(',"yes_to_offer":true').yesToOffer).toBe(true);
    expect(parse('').yesToOffer).toBe(true);
    expect(parse(',"yes_to_offer":"false"').yesToOffer).toBe(true);
  });

  // A bell with no message id dates the reply by when it came, and always shows the model its latest text in, yes or not: the excerpt
  // can miss it (an inbox-only text, or one pushed out by later notices), and the alert is about it. A bell with a message id carries
  // that text in its excerpt already, so it is not repeated.
  test('a thread bell shows its latest text in, dated by when it came; a bell with a message id does not repeat it', () => {
    const came = new Date('2026-11-26T13:30:00Z');
    const thread = (lastBody, prevOutbound = '') => timelineOf([], { trigger: 'sms:none', reply: { lastBody, at: came, prevOutbound, prevAt: null, whole: !!prevOutbound } });
    const ask = agent.judgeInput(alertRow(), thread('Can you move my visit to Monday?'), agent.computeFacts(thread('x')));
    expect(ask).toMatch(/^THE CUSTOMER'S LATEST TEXT BEFORE THE ALERT \(sent Thursday 2026-11-26 8:30 AM\): Can you move my visit to Monday\?$/m);
    const yes = agent.judgeInput(alertRow(), thread('Yes', 'Friday at 10 am?'), agent.computeFacts(thread('x')));
    expect(yes).toMatch(/^- CUSTOMER REPLY \(Thursday 2026-11-26 8:30 AM\): Yes$/m);
    expect(yes).not.toMatch(/THE CUSTOMER'S LATEST TEXT/);
    const named = agent.judgeInput(alertRow(), timelineOf([], { reply: { lastBody: 'Can you move my visit?', at: came, prevOutbound: '' } }), agent.computeFacts(timelineOf()));
    expect(named).not.toMatch(/THE CUSTOMER'S LATEST TEXT/);
  });

  // The offer comes from its own query and can be older than the context lines (3 days, 12 texts; 4 thread emails), so the model is
  // shown the pair whole, redacted, and the pair is in the fingerprint.
  // The offer's send time comes with it: "tomorrow" sent on Wednesday is Thursday, whenever the customer replies.
  test('the model is shown the offer with its send time and the reply, redacted, and a changed offer changes the fingerprint', () => {
    const sent = new Date('2026-11-25T20:10:00Z');
    const tl = (prevOutbound, prevAt = sent, whole = true) => timelineOf([staffMove], { reply: { lastBody: 'Yes', prevOutbound, prevAt, whole }, ctx: ['CUSTOMER TEXT: thanks'] });
    const input = agent.judgeInput(alertRow(), tl('We could come tomorrow at 10 am. Does that work?'), agent.computeFacts(tl('x')));
    expect(input).toMatch(/THE YES AND THE MESSAGE IT ANSWERS/);
    expect(input).toMatch(/^- WAVES MESSAGE \(sent Wednesday 2026-11-25 3:10 PM\): We could come tomorrow at 10 am\. Does that work\?$/m);
    expect(input).toMatch(/^- CUSTOMER REPLY \(Thursday 2026-11-26 9:00 AM\): Yes$/m);
    const coded = agent.judgeInput(alertRow(), tl('Friday at 10 am works? Our tech will use the gate code 4821 at the front.'), agent.computeFacts(tl('x')));
    expect(coded).not.toMatch(/4821/);
    const plain = agent.judgeInput(alertRow(), timelineOf([staffMove], { reply: { lastBody: 'Can you come later?', prevOutbound: 'Friday at 10 am?' } }), agent.computeFacts(timelineOf()));
    expect(plain).not.toMatch(/THE YES AND THE MESSAGE/);
    // The whole message as read (up to 1,500 characters), so a time corrected late in a long text is seen.
    const long = `${'Thanks for bearing with us on the schedule this week. '.repeat(12)}Correction: we can come Friday at 2 pm instead.`;
    expect(long.length).toBeGreaterThan(600);
    expect(agent.judgeInput(alertRow(), tl(long), agent.computeFacts(tl('x')))).toMatch(/Correction: we can come Friday at 2 pm instead\.$/m);
    // A message longer than what was read is marked cut, so the model knows it may not see the offer.
    expect(agent.judgeInput(alertRow(), tl('Your bill is ready.', sent, false), agent.computeFacts(tl('x')))).toMatch(/Your bill is ready\. \[cut: the message is longer than shown\]$/m);
    const fp = (prevOutbound, prevAt) => agent.fingerprintOf(alertRow(), tl(prevOutbound, prevAt), NOW);
    expect(fp('We could come Friday at 10 am?')).not.toBe(fp('We could come Tuesday at 2 pm?'));
    expect(fp('We could come tomorrow at 10 am?')).not.toBe(fp('We could come tomorrow at 10 am?', new Date('2026-11-24T20:10:00Z')));
    expect(fp('We could come Friday at 10 am?')).toBe(fp('We could come Friday at 10 am?'));
  });

  // The audits' two cases. A numeric offer, a yes and an unrelated staff reply: never closed by the staff reply. An "OK" to a bill
  // that names a date: the model sees the exchange and may find nothing to answer; no word list decides it first.
  test('a yes to a numeric offer is held to a booking; an ok to a dated bill can be nothing to answer', async () => {
    const numeric = await run([staffText()], { reply: { lastBody: 'yes', prevOutbound: 'Can we visit 12/4 between 9 and 11?', whole: true } }, judgeNames('E1'));
    expect(numeric.row).toMatchObject({ outcome: 'still_owed', source: 'ai', rule: 'yes_to_offer_no_booking' });
    const bill = jest.fn(async () => ({ outcome: 'nothing_to_answer', why: 'ok to an invoice note', proof: null, model: 'm', yesToOffer: false }));
    const dated = await run([], { reply: { lastBody: 'OK', prevOutbound: 'Your invoice is due 12/4.', whole: true } }, bill);
    expect(bill.mock.calls[0][0]).toMatch(/- WAVES MESSAGE: Your invoice is due 12\/4\.$/m);
    expect(dated.row).toMatchObject({ outcome: 'nothing_to_answer', source: 'ai' });
  });

  // A yes whose message was not shown whole (cut short, none found in its own conversation, or no words) is answered by nothing:
  // neither the model's "accepts no offer" nor a booking can be checked against an offer no one saw. It stays owed by rule, so no
  // paid call is made.
  test('a cut, unpaired or empty message keeps a bare yes owed by rule, with no model call, even with a booking after', async () => {
    const bill = () => jest.fn(async () => ({ outcome: 'nothing_to_answer', why: 'ok to a bill', proof: null, model: 'm', yesToOffer: false }));
    const cut = await run([], { reply: { lastBody: 'OK', prevOutbound: 'Your bill is ready.', whole: false } }, bill());
    expect(cut.deps.judge).not.toHaveBeenCalled();
    expect(cut.row).toMatchObject({ outcome: 'still_owed', source: 'rule', rule: 'yes_offer_not_shown' });
    const unpaired = await run([booking], { reply: { lastBody: 'OK', prevOutbound: '', prevAt: null, whole: false } }, judgeNames('E1'));
    expect(unpaired.deps.judge).not.toHaveBeenCalled();
    expect(unpaired.row).toMatchObject({ outcome: 'still_owed', rule: 'yes_offer_not_shown' });
    // A message with no words (a picture text, an email whose body was never read) was never shown: "whole" alone is not enough.
    const empty = await run([], { reply: { lastBody: 'OK', prevOutbound: '  ', prevAt: after(-30), whole: true } }, bill());
    expect(empty.row).toMatchObject({ outcome: 'still_owed', rule: 'yes_offer_not_shown' });
    // The guard holds the same line for a model answer: a named booking cannot answer a yes to an offer that was not shown.
    const guarded = agent.guardBareYes({ outcome: 'answered', source: 'ai', proofType: 'visit', proofId: 'v1', model: 'm' }, timelineOf([booking], { reply: { lastBody: 'Yes', prevOutbound: 'Friday?', whole: false } }));
    expect(guarded).toMatchObject({ outcome: 'still_owed', source: 'ai', rule: 'yes_offer_not_shown', model: 'm' });
  });

  // What a bare yes answers is language, so the model judges it, shown the message: a staff reply never closes the yes by rule.
  // A reply that is not a bare yes still closes by the staff reply.
  test('a bare yes goes to the model, shown the message it answers, never to a plain rule', async () => {
    const missed = { lastBody: 'Yes', prevOutbound: 'Shall we pencil you in for early next month?', whole: true };
    const judge = jest.fn(async () => ({ outcome: 'still_owed', why: 'yes to a proposed visit, nothing booked', proof: null, model: 'm' }));
    const { deps, row } = await run([staffText()], { reply: missed }, judge);
    expect(deps.judge).toHaveBeenCalledTimes(1);
    expect(deps.judge.mock.calls[0][0]).toMatch(/- WAVES MESSAGE: Shall we pencil you in for early next month\?$/m);
    expect(row).toMatchObject({ outcome: 'still_owed', source: 'ai' });
    const asked = await run([staffText()], { reply: { lastBody: 'Can you call me instead?', prevOutbound: missed.prevOutbound } });
    expect(asked.row).toMatchObject({ outcome: 'answered', source: 'rule', rule: 'staff_text' });
  });

  // An owed alert never goes to the model, and no plain rule reads a bare yes, so it stays for the office.
  test('an owed alert with a bare yes stays owed', async () => {
    const owed = alertRow({ title: 'Pat texted back — we still owe a quote' });
    const deps = makeDeps({ candidates: async () => [owed], timeline: async () => timelineOf([staffText()], { reply: { lastBody: 'ok', prevOutbound: 'We will send your quote.' } }) });
    await agent.runAlertClearAgent({ now: NOW, deps });
    expect(deps.judge).not.toHaveBeenCalled();
    expect(saved(deps)[0]).toMatchObject({ outcome: 'still_owed', rule: 'owed_open' });
  });

  test('the booking or the held staff move the model names answers it', async () => {
    expect((await run([staffText(), booking], {}, judgeNames('E2'))).row).toMatchObject({ outcome: 'answered', proof_id: 'v1' });
    expect((await run([staffText(), staffMove], {}, judgeNames('E2'))).row).toMatchObject({ outcome: 'answered', proof_id: 'rl-1' });
  });

  test('a model answered with a sent estimate is held the same way', async () => {
    const estimate = ev({ type: 'estimate', id: 'es-1', key: 'estimate:es-1:sent', proof: 'estimate_sent', at: after(40), line: 'ESTIMATE handed' });
    const { row } = await run([estimate], {}, jest.fn(async () => ({ outcome: 'answered', why: 'estimate sent', proof: 'E1', model: 'm' })));
    expect(row).toMatchObject({ outcome: 'still_owed', rule: 'yes_to_offer_no_booking' });
  });
});

describe('a visit waiting for the customer to pick a time books nothing', () => {
  test('no proof, and its line says no time is booked; once it has a time it is a booking with its day and time', () => {
    const row = { id: 'v9', created_at: after(40), scheduled_date: new Date('2026-11-30T00:00:00Z'), window_start: null, window_end: null, customer_pick_by: after(1440), status: 'pending' };
    const waiting = agent.visitEvent(row);
    expect(waiting.proof).toBeNull();
    expect(waiting.line).toMatch(/now waiting for the customer to pick a time .*; no time is booked, so this is no answer$/);
    // A one-hour job at 10 is the 10-to-12 arrival window the customer was offered (window_start + 2 hours), never 10-11.
    const placed = agent.visitEvent({ ...row, window_start: '10:00:00', window_end: '11:00:00' });
    expect(placed).toMatchObject({ proof: 'booking', line: 'VISIT created after the alert, for Monday 2026-11-30, arrival 10:00-12:00 (pending)' });
  });

  // A day-only visit's stored start is the planner's, not a time the customer was given: a yes to "Monday at 10" must not read a
  // planned 10:00 as that time booked.
  test('a day-only booking states the day alone and says no time was given', () => {
    const row = { id: 'v10', created_at: after(40), scheduled_date: new Date('2026-11-30T00:00:00Z'), window_start: '10:00:00', window_end: '11:00:00', customer_pick_by: null, status: 'pending' };
    const e = agent.visitEvent(row, true);
    expect(e).toMatchObject({ proof: 'booking', line: 'VISIT created after the alert, for Monday 2026-11-30; the customer is told the day, not a time (pending)' });
    expect(agent.SYSTEM_PROMPT).toMatch(/a visit whose line says the customer is told the day, not a time, when a time was offered/);
  });
});

describe('open alerts are paged with a rotating cursor', () => {
  const page = (n, from = 0) => Array.from({ length: n }, (_x, i) => alertRow({ id: `cccccccc-cccc-4ccc-8ccc-${String(from + i).padStart(12, '0')}` }));

  test('the cursor is read, passed to the page query, and saved as the last alert read when the page is full', async () => {
    const alerts = page(agent.MAX_ALERTS);
    const deps = makeDeps({ cursor: async () => 'cccccccc-cccc-4ccc-8ccc-000000000000', candidates: jest.fn(async () => alerts), timeline: async () => timelineOf([staffText()]) });
    await agent.runAlertClearAgent({ now: NOW, deps });
    expect(deps.candidates).toHaveBeenCalledWith('cccccccc-cccc-4ccc-8ccc-000000000000');
    expect(deps.saveCursor).toHaveBeenCalledWith(alerts[alerts.length - 1].id);
  });

  test('a short page covered everything: the cursor resets', async () => {
    const deps = makeDeps({ candidates: async () => page(3), timeline: async () => timelineOf([staffText()]) });
    await agent.runAlertClearAgent({ now: NOW, deps });
    expect(deps.saveCursor).toHaveBeenCalledWith(null);
  });
});

describe('the model tier is selectable in the switchboard', () => {
  test('ALERT_CLEAR declares accepts.deep, as every selector whose default requires deep does, and its default is accepted', () => {
    const { SELECTORS } = require('../services/model-switchboard');
    const selector = SELECTORS.find((x) => x.key === 'ALERT_CLEAR');
    expect(selector.accepts).toMatchObject({ providers: ['anthropic'], cap: 'text', deep: true });
    expect(MODELS.MODEL_CATALOG[MODELS.ALERT_CLEAR]).toMatchObject({ provider: 'anthropic', requires: 'deep' });
  });
});

describe('an empty contact matches nothing', () => {
  // A query stand-in that records every call and runs the callbacks it is given.
  const recorder = () => {
    const calls = [];
    const q = new Proxy({}, {
      get: (_t, name) => (...args) => {
        calls.push([name, ...args.map((x) => (typeof x === 'function' ? 'fn' : x))]);
        args.filter((x) => typeof x === 'function').forEach((fn) => fn(q));
        return q;
      },
    });
    return { q, calls };
  };
  const scope = { customerColumn: 'os.customer_id', phoneColumns: ['os.to_phone', 'os.from_phone'] };
  const names = (calls) => calls.map((c) => c[0]);

  test.each([
    ['a null phone and no customer', { customerId: null, phone: null }],
    ['an empty phone', { customerId: '', phone: '' }],
    ['a blank phone and a blank customer id', { customerId: '   ', phone: '   ' }],
    ['a phone with no digits', { customerId: null, phone: '+' }],
    ['no key at all', undefined],
  ])('%s: the query is made to return no rows, with no phone clause', (_n, key) => {
    const { q, calls } = recorder();
    agent.scopeToContact(q, key, scope);
    expect(calls).toEqual([['whereRaw', '1 = 0']]);
  });

  test('a customer alone scopes by id; a phone alone by phone identity', () => {
    const byCustomer = recorder();
    agent.scopeToContact(byCustomer.q, { customerId: ' cust-1 ', phone: null }, scope);
    expect(byCustomer.calls).toEqual([['where', 'os.customer_id', 'cust-1']]);
    const byPhone = recorder();
    agent.scopeToContact(byPhone.q, { customerId: null, phone: '+19415550100' }, scope);
    expect(names(byPhone.calls).filter((n) => n === 'orWhereRaw')).toHaveLength(2);
    expect(names(byPhone.calls)).not.toContain('whereNull');
  });

  test('a known customer with a resolved phone also keeps rows with NO customer id on that number (the witnesses\' rule), never another customer\'s', () => {
    const { q, calls } = recorder();
    agent.scopeToContact(q, { customerId: 'cust-1', phone: '+19415550100' }, scope);
    expect(calls).toContainEqual(['where', 'os.customer_id', 'cust-1']);
    expect(calls).toContainEqual(['whereNull', 'os.customer_id']);
    expect(names(calls).filter((n) => n === 'orWhereRaw')).toHaveLength(2);
  });
});

describe('fingerprint: late evidence re-judges', () => {
  test('a transcript or customer link that arrives after the first look changes the fingerprint', () => {
    const call = (hasVoicemail, customerId, ctx) => timelineOf([], { trigger: `call:C1:vm${hasVoicemail ? 1 : 0}:c${customerId || ''}`, ctx });
    const alert = alertRow({ category: 'voicemail_callback' });
    const first = agent.fingerprintOf(alert, call(false, null, ['CALLER: x. No voicemail left.']), NOW);
    expect(agent.fingerprintOf(alert, call(true, null, ['CALLER: x. No voicemail left.']), NOW)).not.toBe(first);
    expect(agent.fingerprintOf(alert, call(false, 'cust-1', ['CALLER: x. No voicemail left.']), NOW)).not.toBe(first);
    expect(agent.fingerprintOf(alert, call(false, null, ['CALLER: x. Voicemail or call text: please call me']), NOW)).not.toBe(first);
  });
});

describe('a bare yes by email is held like one by text', () => {
  test('the email reply pair (the sent offer and the "yes") feeds the same booking guard', async () => {
    const reply = { lastBody: 'Yes', prevOutbound: 'Could we come Friday at 10 am?', whole: true };
    const deps = makeDeps({
      timeline: async () => timelineOf([staffText()], { reply, trigger: 'email:E1' }), candidates: async () => [alertRow({ category: 'inbound_email' })],
      judge: jest.fn(async () => ({ outcome: 'answered', why: 'staff replied', proof: 'E1', model: 'm' })),
    });
    await agent.runAlertClearAgent({ now: NOW, deps });
    expect(saved(deps)[0]).toMatchObject({ outcome: 'still_owed', rule: 'yes_to_offer_no_booking' });
  });
});

describe('quiet missed call: later call rows are contact evidence', () => {
  test('a later call row, even one with no end stamp or an outbound one, blocks the silence rule', async () => {
    const missed = alertRow({ category: 'missed_call', title: 'Unknown caller', link: '/admin/communications#tab=calls&call=33333333-3333-4333-8333-333333333333' });
    const unended = { type: 'call', id: 'c9', key: 'call:c9:n:o', at: after(300), inbound: false, proof: null, draft: false, line: 'CALL outbound' };
    const deps = makeDeps({
      candidates: async () => [missed],
      timeline: async () => timelineOf([unended], { customerKnown: false, call: { customerId: null, hasVoicemail: false, textBackSent: true } }),
    });
    await agent.runAlertClearAgent({ now: new Date(ALERT_AT.getTime() + 25 * 3600 * 1000), deps });
    expect(saved(deps).every((r) => r.rule !== 'quiet_unknown_missed_call')).toBe(true);
  });
});

describe('what the model reads is part of the fingerprint, and the facts and notes it gets are exact', () => {
  test('a changed status note or body on the same record re-judges', () => {
    const base = agent.fingerprintOf(alertRow(), timelineOf([ev()]), NOW);
    expect(agent.fingerprintOf(alertRow(), timelineOf([ev({ line: 'WAVES AUTOMATED TEXT (reminder): a different body' })]), NOW)).not.toBe(base);
    expect(agent.fingerprintOf(alertRow(), timelineOf([ev()]), NOW)).toBe(base);
  });

  test('drafts-only is true only when Waves wrote drafts and nothing else answered', () => {
    const draft = ev({ type: 'email', id: 'd1', key: 'email:d1:draft', draft: true, line: 'DRAFT' });
    const incoming = ev({ type: 'email', id: 'in1', key: 'email:in1:in', inbound: true, line: 'CUSTOMER EMAIL' });
    const only = (events) => agent.computeFacts(timelineOf(events)).onlyDrafts;
    expect(only([draft, incoming])).toBe(true);
    expect(only([draft, ev({ type: 'estimate', id: 'e1', key: 'estimate:e1', proof: 'estimate_sent' })])).toBe(false);
    expect(only([draft, ev({ type: 'email', id: 's1', key: 'email:s1:sent', proof: 'staff_email' })])).toBe(false);
    expect(only([draft, staffText()])).toBe(false);
    expect(only([incoming])).toBe(false);
  });

  test('a recording whose transcript is pending or failed never reads as "no voicemail"', () => {
    expect(agent.voicemailNote({ recording_sid: 'RE1', transcription_status: 'pending' }, true)).toMatch(/unread, so this is NOT a call with no voicemail/);
    expect(agent.voicemailNote({ recording_sid: 'RE1', transcription_status: 'failed' }, true)).toMatch(/failed/);
    expect(agent.voicemailNote({ recording_sid: 'RE1', transcription_status: 'completed', transcription: '[NO SPEECH]' }, false)).toMatch(/no speech/);
    expect(agent.voicemailNote({}, false)).toBe('No voicemail left.');
    expect(agent.voicemailNote({ recording_sid: 'RE1', transcription: 'please call me back' }, true)).toMatch(/please call me back/);
  });
});

describe('the prompt carries every citable record, drafts after them', () => {
  test('citable records are listed before drafts, drafts are capped, and more than the prompt can hold makes the timeline incomplete', async () => {
    const proofs = Array.from({ length: 5 }, (_x, i) => ev({ type: 'visit', id: `v${i}`, key: `visit:v${i}:booked`, proof: 'booking', at: after(10 + i), line: `VISIT ${i}` }));
    const drafts = Array.from({ length: 25 }, (_x, i) => ev({ type: 'email', id: `d${i}`, key: `email:d${i}:draft`, draft: true, at: after(100 + i), line: `DRAFT ${i}` }));
    const listed = agent.listedEvents(timelineOf([...proofs, ...drafts]));
    expect(listed.filter((e) => e.proof)).toHaveLength(5);
    expect(listed.filter((e) => e.draft)).toHaveLength(10);
    expect(agent.proofOverflow(timelineOf(proofs))).toBe(false);

    const many = Array.from({ length: 31 }, (_x, i) => ev({ type: 'visit', id: `w${i}`, key: `visit:w${i}:booked`, proof: 'booking', at: after(10 + i), line: `VISIT ${i}` }));
    expect(agent.proofOverflow(timelineOf(many))).toBe(true);
    const deps = makeDeps({ timeline: async () => timelineOf([...many, staffText()]) });
    const out = await agent.runAlertClearAgent({ now: NOW, deps });
    expect(out.incomplete).toBe(1);
    expect(deps.save).not.toHaveBeenCalled();
    expect(deps.reserve).not.toHaveBeenCalled();
  });
});

describe('fingerprint: the text-back state', () => {
  test('only the claim moving (dispatching to sent) changes it', () => {
    const missed = alertRow({ category: 'missed_call' });
    const tl = (state) => timelineOf([], { customerKnown: false, call: { customerId: null, hasVoicemail: false, textBackSent: state === 'sent:none', textBackState: state } });
    expect(agent.fingerprintOf(missed, tl('dispatching:none'), NOW)).not.toBe(agent.fingerprintOf(missed, tl('sent:none'), NOW));
    expect(agent.fingerprintOf(missed, tl('sent:none'), NOW)).toBe(agent.fingerprintOf(missed, tl('sent:none'), NOW));
  });
});

describe('property access codes never reach the model', () => {
  test('a gate code in a customer text, a voicemail transcript and a Waves text is masked in every line and in the whole prompt', () => {
    const text = agent.smsEvent({ id: 's', direction: 'inbound', created_at: after(5), message_body: 'The gate code is 4821, lockbox 9988, alarm code 1234' }).line;
    expect(text).not.toMatch(/4821|9988|1234/);
    expect(agent.voicemailNote({ transcription: 'hi it is Pat the gate code to my community is 3345 please call', recording_sid: 'RE1' }, true)).not.toMatch(/3345/);
    const input = agent.judgeInput(alertRow({ title: 'Voicemail: door code 7731' }),
      timelineOf([ev({ line: 'WAVES STAFF TEXT: use gate code 5566 on arrival' })], { ctx: ['CUSTOMER TEXT: alarm code is 8080'] }), agent.computeFacts(timelineOf()));
    expect(input).not.toMatch(/7731|5566|8080/);
    expect(input).toMatch(/FIXED FACTS/);
    expect(agent.redactForModel('call me at 941 555 0100 about Friday')).toBe('call me at 941 555 0100 about Friday');
  });
});

describe('the model never closes a silent missed call early', () => {
  const missed = alertRow({ category: 'missed_call', title: 'Unknown caller', link: '/admin/communications#tab=calls&call=33333333-3333-4333-8333-333333333333' });
  const run = async (call) => {
    const deps = makeDeps({
      candidates: async () => [missed],
      timeline: async () => timelineOf([], { customerKnown: false, call }),
      judge: jest.fn(async () => ({ outcome: 'nothing_to_answer', why: 'looks like a robocall', proof: null, model: 'm' })),
    });
    await agent.runAlertClearAgent({ now: NOW, deps });
    return saved(deps)[0];
  };

  test('a silent call (no voicemail): nothing_to_answer from the model becomes still_owed', async () => {
    expect(await run({ customerId: null, hasVoicemail: false, textBackSent: false })).toMatchObject({ outcome: 'still_owed', source: 'ai', rule: 'silent_call_wait' });
    expect(await run({ customerId: 'c1', hasVoicemail: false, textBackSent: false })).toMatchObject({ outcome: 'still_owed', rule: 'silent_call_wait' });
  });

  test('a call with a voicemail keeps the model\'s nothing_to_answer (a wrong number, a sales call)', async () => {
    expect(await run({ customerId: null, hasVoicemail: true, textBackSent: false })).toMatchObject({ outcome: 'nothing_to_answer', source: 'ai' });
  });

  // The trial's alerts said "waits for the 24-hour rule" on calls days old that the rule could never close.
  test('the reason it stays open is the true one, never "waits" on an alert days old', async () => {
    const days = new Date(ALERT_AT.getTime() + 3 * 24 * 3600 * 1000);
    const why = async (call, { events = [], now = days } = {}) => {
      const deps = makeDeps({
        candidates: async () => [missed],
        timeline: async () => timelineOf(events, { customerKnown: !!call.customerId, call }),
        judge: jest.fn(async () => ({ outcome: 'nothing_to_answer', why: 'robocall', proof: null, model: 'm' })),
      });
      await agent.runAlertClearAgent({ now, deps });
      const row = saved(deps)[0];
      expect(row).toMatchObject({ outcome: 'still_owed', rule: 'silent_call_wait' });
      return row.why;
    };
    const unknown = { customerId: null, hasVoicemail: false, textBackSent: false, textBackUnsent: false, robocall: null };
    expect(await why(unknown)).toBe('no text-back went out for this call');
    expect(await why({ ...unknown, textBackUnsent: true })).toBe('the text-back for this call has not reached the caller');
    const again = ev({ type: 'call', id: 'c2', key: 'call:c2', inbound: true, line: 'CALL inbound' });
    expect(await why({ ...unknown, textBackSent: true }, { events: [again] })).toBe('the number called or texted again after the alert');
    // A call from Waves that reached no one is Waves' call, never the caller calling again.
    const callBack = ev({ type: 'call', id: 'c3', key: 'call:c3', inbound: false, line: 'CALL outbound' });
    expect(await why({ ...unknown, textBackSent: true }, { events: [callBack] })).toBe('Waves called the number after the alert');
    expect(await why({ ...unknown, textBackSent: true }, { now: NOW })).toBe('under 24 hours since the call');
    expect(await why({ ...unknown, customerId: 'c1' })).toBe('a customer left no voicemail: only a real answer closes it');
  });
});

describe('rule 1 also closes a robocall that got no text-back', () => {
  const missed = alertRow({ category: 'missed_call', title: 'Unknown caller', link: '/admin/communications#tab=calls&call=33333333-3333-4333-8333-333333333333' });
  const robo = (robocall, over = {}) => timelineOf([], { customerKnown: false, call: { customerId: null, hasVoicemail: false, textBackSent: false, robocall }, ...over });
  const run = async (timeline, now = new Date(ALERT_AT.getTime() + 25 * 3600 * 1000)) => {
    const deps = makeDeps({ candidates: async () => [missed], timeline: async () => timeline });
    await agent.runAlertClearAgent({ now, deps });
    return { deps, rows: saved(deps) };
  };

  test('a caller who failed the press-1 screen closes after 24 hours of silence, with no model call', async () => {
    const { deps, rows } = await run(robo('screen_failed'));
    expect(rows).toEqual([expect.objectContaining({
      outcome: 'nothing_to_answer', source: 'rule', rule: 'quiet_robocall', why: 'robocall (failed the press-1 screen), no voicemail, silent 24 hours',
    })]);
    expect(deps.judge).not.toHaveBeenCalled();
  });

  test('not before 24 hours, not with a voicemail, not when the number called again', async () => {
    const again = ev({ type: 'call', id: 'c2', key: 'call:c2', inbound: true, line: 'CALL inbound' });
    for (const [timeline, now] of [
      [robo('screen_failed'), new Date(ALERT_AT.getTime() + 3 * 3600 * 1000)],
      [robo('screen_failed', { call: { customerId: null, hasVoicemail: true, textBackSent: false, robocall: 'screen_failed' } }), undefined],
      [robo('screen_failed', { events: [again] }), undefined],
    ]) {
      const { rows } = await run(timeline, now);
      expect(rows.every((r) => r.rule !== 'quiet_robocall')).toBe(true);
    }
  });
});

describe('the text-back for this call', () => {
  // A reader stand-in that answers each labelled read with a canned row.
  const reader = (claim, text) => {
    const labels = [];
    const read = async (label) => {
      labels.push(label);
      return label === 'text-back-claim' ? [claim].filter(Boolean).map((outcome) => ({ outcome })) : [text].filter(Boolean).map((status) => ({ status }));
    };
    return { conn: null, read, labels };
  };
  const CALL = { id: 'call-1', created_at: ALERT_AT };
  test.each([
    ['a sent claim and a delivered text', 'sent', 'delivered', { sent: true, unsent: false, state: 'sent:delivered' }],
    ['a sent claim with no text row yet', 'sent', null, { sent: true, unsent: false, state: 'sent:none' }],
    ['a sent claim whose text bounced', 'sent', 'undelivered', { sent: false, unsent: true, state: 'sent:undelivered' }],
    ['a sent claim whose text failed', 'sent', 'failed', { sent: false, unsent: true, state: 'sent:failed' }],
    ['a sent claim whose text was cancelled', 'sent', 'canceled', { sent: false, unsent: true, state: 'sent:canceled' }],
    ['an uncertain claim whose text the provider delivered', 'uncertain', 'delivered', { sent: true, unsent: false, state: 'uncertain:delivered' }],
    ['an uncertain claim whose text has no receipt', 'uncertain', 'sent', { sent: false, unsent: false, state: 'uncertain:sent' }],
    ['an uncertain claim whose text bounced', 'uncertain', 'undelivered', { sent: false, unsent: true, state: 'uncertain:undelivered' }],
    ['a claim still dispatching', 'dispatching', 'sent', { sent: false, unsent: false, state: 'dispatching:sent' }],
  ])('%s', async (_n, claim, text, expected) => {
    expect(await agent.textBackWasSent(reader(claim, text), CALL, '+19415550100')).toMatchObject(expected);
  });

  // The send pipeline keeps no call id on the text row: the number's text-back is this call's only when this call holds the claim.
  test('with no claim for this call, the number\'s text-back (an earlier call\'s) is not read and does not count', async () => {
    const r = reader(null, 'delivered');
    expect(await agent.textBackWasSent(r, { ...CALL, id: 'call-2' }, '+19415550100')).toMatchObject({ sent: false, unsent: false, state: 'none:none' });
    expect(r.labels).toEqual(['text-back-claim']);
  });
});

describe('a visit move answers only when Waves staff made it and the visit still holds it', () => {
  const day = (iso) => new Date(`${iso}T00:00:00Z`);
  const move = (over = {}) => ({
    id: 'rl-1', created_at: after(60), reason_code: 'admin_series', initiated_by: 'admin', original_date: day('2026-11-23'), new_date: day('2026-11-27'),
    original_window: '09:00-10:00', new_window: '15:00-16:00', visit_date: day('2026-11-27'), window_start: '15:00:00', window_end: '16:00:00', ...over,
  });

  test('a staff move the visit still holds is a date change, and the model reads where it went', () => {
    const e = agent.rescheduleEvent(move());
    expect(e.proof).toBe('date_change');
    // Each slot as the customer is told it: the weekday, and the arrival window (start + 2 hours), never the logged service end.
    expect(e.line).toBe('VISIT MOVED by Waves staff after the alert (admin_series), from Monday 2026-11-23, arrival 09:00-11:00 to Friday 2026-11-27, arrival 15:00-17:00; the visit still holds that time');
  });

  // The package follow-up date edit logs a day with no time. The visit's time now may come from a later job, so the move proves the
  // day only, and its line says so: it never claims the visit holds a time.
  test('a staff move that set no time is day-only evidence, whatever time the visit shows now', () => {
    const e = agent.rescheduleEvent(move({ reason_code: 'admin_edit', original_window: null, new_window: null }));
    expect(e.proof).toBe('date_change');
    expect(e.line).toMatch(/to Friday 2026-11-27; the visit is still on that day; this move set no time$/);
  });

  test('a move on a day-only visit states days alone: the planner\'s times are never shown as told ones', () => {
    const e = agent.rescheduleEvent(move(), true);
    expect(e.proof).toBe('date_change');
    expect(e.line).toBe('VISIT MOVED by Waves staff after the alert (admin_series), from Monday 2026-11-23 to Friday 2026-11-27; the visit is still on that day; the customer is told the day, not a time');
    const since = agent.rescheduleEvent(move({ visit_date: day('2026-12-02'), window_start: '11:00:00' }), true);
    expect(since.proof).toBeNull();
    expect(since.line).toMatch(/; not an answer now, as the visit has moved since, to Wednesday 2026-12-02$/);
  });

  test.each([
    ['the day planner moved it', { initiated_by: 'day_replan' }, /by an automatic job \(day_replan\).*; not an answer from Waves$/],
    ['auto-dispatch moved it', { initiated_by: 'auto_dispatch' }, /by an automatic job \(auto_dispatch\)/],
    ['the customer moved it', { initiated_by: 'customer_self_serve' }, /by the customer .*; not an answer from Waves$/],
    ['no mover is named', { initiated_by: null }, /by an unknown mover/],
    ['the visit moved to another day since', { visit_date: day('2026-12-05'), window_start: '12:00:00', window_end: '13:00:00' }, /not an answer now, as the visit has moved since, to Saturday 2026-12-05, arrival 12:00-14:00$/],
    ['the visit moved to another time that day since', { window_start: '08:00:00', window_end: '09:00:00' }, /moved since, to Friday 2026-11-27, arrival 08:00-10:00$/],
  ])('no proof when %s', (_n, over, line) => {
    const e = agent.rescheduleEvent(move(over));
    expect(e.proof).toBeNull();
    expect(e.line).toMatch(line);
  });

  test('the day and start decide: a 30-minute logged window holds on a one-hour visit; a move with no time holds on its day only', () => {
    expect(agent.rescheduleEvent(move({ new_window: '15:00-15:30' })).proof).toBe('date_change');
    expect(agent.rescheduleEvent(move({ new_window: null })).proof).toBe('date_change');
    expect(agent.rescheduleEvent(move({ new_window: null, visit_date: day('2026-11-28') })).proof).toBeNull();
    expect(agent.rescheduleEvent(move({ visit_date: null })).proof).toBeNull();
  });

  // A staff day-only edit, then a hand-off that parks the visit on that same day with no time: the edit "still holds" its day, but
  // the visit waits for the customer's pick, so the placeholder day is no answer.
  test('a staff move on a visit that now waits for the customer to pick a time is no proof', () => {
    const parked = { reason_code: 'admin_edit', original_window: null, new_window: null, window_start: null, window_end: null, visit_pick_by: after(1440) };
    const e = agent.rescheduleEvent(move(parked));
    expect(e.proof).toBeNull();
    expect(e.line).toMatch(/^VISIT MOVED by Waves staff after the alert \(admin_edit\), from Monday 2026-11-23 to Friday 2026-11-27; not an answer now, as the visit waits for the customer to pick a time$/);
    // A pick-by left on a visit that has its time again is no wait.
    expect(agent.rescheduleEvent(move({ visit_pick_by: after(1440) })).proof).toBe('date_change');
  });

  // The stale-move note carries ": " no more, and the reason and mover are cleaned when the line is built: the label before the first
  // ": " skips redactLine's second pass, so nothing from the request may sit there unredacted.
  test('the reason and the mover logged with a move pass the redaction step before they join the line', () => {
    const stale = { visit_date: day('2026-12-05'), window_start: '12:00:00', window_end: '13:00:00' };
    const coded = agent.rescheduleEvent(move({ ...stale, reason_code: 'gate code 4821' }));
    const job = agent.rescheduleEvent(move({ initiated_by: 'job gate code 5566' }));
    expect(coded.line).not.toMatch(/4821/);
    expect(job.line).not.toMatch(/5566/);
    const input = agent.judgeInput(alertRow(), timelineOf([{ ...coded, at: after(60) }, { ...job, at: after(70) }]), agent.computeFacts(timelineOf()));
    expect(input).not.toMatch(/4821|5566/);
  });

  test('a hand-off for the customer to pick a time books nothing: never a proof, whoever handed it off', () => {
    for (const initiatedBy of ['admin', 'tech', 'rain_out']) {
      const e = agent.rescheduleEvent(move({ initiated_by: initiatedBy, pick_handoff: true, new_window: null, window_start: null, window_end: null }));
      expect(e.proof).toBeNull();
      expect(e.line).toMatch(/^VISIT HANDED TO THE CUSTOMER TO PICK A TIME by .+ after the alert \(admin_series\), from Monday 2026-11-23, arrival 09:00-11:00; no time is booked, so this is no answer$/);
    }
  });

  test('a Quick Move by a tech, an Intelligence Bar move and a Schedule bulk move are a person\'s', () => {
    expect(agent.rescheduleEvent(move({ initiated_by: 'tech' })).proof).toBe('date_change');
    expect(agent.rescheduleEvent(move({ initiated_by: 'admin_ib' })).proof).toBe('date_change');
    expect(agent.rescheduleEvent(move({ initiated_by: 'admin_bulk' })).proof).toBe('date_change');
  });

  test('a move is a new day or a new start: a window written another way, or a new end alone, is no move', () => {
    const sameDay = (original, next) => move({ original_date: day('2026-11-27'), original_window: original, new_window: next });
    expect(agent.realMove(sameDay('09:00:00-10:00:00', '09:00-10:00'))).toBe(false);
    expect(agent.realMove(sameDay('09:00-10:00', '09:00-11:00'))).toBe(false);
    expect(agent.realMove(sameDay('09:00-10:00', '15:00-16:00'))).toBe(true);
    expect(agent.realMove(sameDay(null, '15:00-16:00'))).toBe(true);
    expect(agent.realMove(move())).toBe(true);
  });

  // The trial's case: a staff move matched "after 3", then the day planner and the customer moved the visit again.
  test('the model citing a move the visit no longer holds is refused, and a bare yes waits for a real booking', async () => {
    const stale = agent.rescheduleEvent(move({ visit_date: day('2026-12-05'), window_start: '12:00:00', window_end: '13:00:00' }));
    const judge = jest.fn(async () => ({ outcome: 'answered', why: 'moved to after 3', proof: 'E1', model: 'm' }));
    const deps = makeDeps({ timeline: async () => timelineOf([stale]), judge });
    await agent.runAlertClearAgent({ now: NOW, deps });
    expect(saved(deps)[0]).toMatchObject({ outcome: 'still_owed', rule: 'proof_rejected' });
    expect(agent.computeFacts(timelineOf([stale])).bookingOrDateChangeAfter).toBe(false);
    expect(agent.computeFacts(timelineOf([agent.rescheduleEvent(move())])).bookingOrDateChangeAfter).toBe(true);
  });
});
