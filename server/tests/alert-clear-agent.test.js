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

  test('a bare yes to an offered time with no booking stays still_owed; with a booking it may close', async () => {
    const reply = { lastBody: 'Yes', prevOutbound: 'We could come Friday at 10 am. Does that work?' };
    const none = await runWith([], { outcome: 'nothing_to_answer', why: 'customer said yes', proof: null }, { reply });
    expect(none.row).toMatchObject({ outcome: 'still_owed', rule: 'yes_to_offer_no_booking' });
    const booked = await runWith([booking], { outcome: 'nothing_to_answer', why: 'yes to a booked time', proof: null }, { reply });
    expect(booked.row.outcome).toBe('nothing_to_answer');
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
    expect(facts).toMatchObject({ staffTextAfter: false, bookingOrDateChangeAfter: true, onlyDrafts: true, estimateSentAfter: false, customerOnFile: true });
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

  test('an incomplete timeline that already holds a staff text still answers', async () => {
    const deps = makeDeps({ timeline: async () => timelineOf([staffText()], { complete: false }) });
    await agent.runAlertClearAgent({ now: NOW, deps });
    expect(saved(deps)[0].outcome).toBe('answered');
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
  const reply = { lastBody: 'Yes', prevOutbound: 'We could come Friday at 10 am. Does that work?' };
  const run = async (events, extra = {}, judge) => {
    const deps = makeDeps({ timeline: async () => timelineOf(events, { reply, ...extra }), ...(judge ? { judge } : {}) });
    await agent.runAlertClearAgent({ now: NOW, deps });
    return { deps, row: saved(deps)[0] };
  };
  const booking = ev({ type: 'visit', id: 'v1', key: 'visit:v1:booked:pending', proof: 'booking', at: after(45), line: 'VISIT created' });

  test('a plain-rule staff text after a bare yes to an offer is still_owed until a booking exists', async () => {
    const none = await run([staffText()]);
    expect(none.row).toMatchObject({ outcome: 'still_owed', source: 'rule', rule: 'yes_to_offer_no_booking' });
    const booked = await run([staffText(), booking]);
    expect(booked.row.outcome).toBe('answered');
  });

  test('a model answered with a sent estimate is held the same way', async () => {
    const estimate = ev({ type: 'estimate', id: 'es-1', key: 'estimate:es-1:sent', proof: 'estimate_sent', at: after(40), line: 'ESTIMATE handed' });
    const { row } = await run([estimate], {}, jest.fn(async () => ({ outcome: 'answered', why: 'estimate sent', proof: 'E1', model: 'm' })));
    expect(row).toMatchObject({ outcome: 'still_owed', rule: 'yes_to_offer_no_booking' });
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
