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
const timelineOf = (events = [], over = {}) => ({ alertAt: ALERT_AT, complete: true, customerKnown: true, ctx: ['CUSTOMER TEXT: Can you come Friday?'], events, call: null, reply: null, ...over });

const makeDeps = (over = {}) => ({
  candidates: jest.fn(async () => [alertRow()]),
  lastVerdicts: jest.fn(async () => new Map()),
  aiCountToday: jest.fn(async () => 0),
  timeline: jest.fn(async () => timelineOf()),
  judge: jest.fn(async () => ({ outcome: 'still_owed', why: 'no reply yet', proof: null, model: 'm' })),
  save: jest.fn(async () => {}),
  ...over,
});
const saved = (deps) => deps.save.mock.calls.map(([row]) => row);

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
});

describe('what counts as a person on a call', () => {
  const call = (over) => ({ answered_by: null, duration_seconds: 90, direction: 'outbound', transcription: '', call_summary: '', ...over });

  test.each([
    ['human', true], ['Human', true], ['voicemail', false], ['voice_agent', false], ['missed', false], ['machine_start', false],
  ])('answered_by %s -> %s (seconds never decide)', (by, expected) => {
    expect(agent.isHumanCall(call({ answered_by: by, duration_seconds: 300 }))).toBe(expected);
  });

  test('no answered_by: 18 seconds is not enough, and 30 seconds with no two-sided record is not enough', () => {
    expect(agent.isHumanCall(call({ duration_seconds: 18, transcription: 'Agent: hi\nCaller: hello' }))).toBe(false);
    expect(agent.isHumanCall(call({ duration_seconds: 30 }))).toBe(false);
    expect(agent.isHumanCall(call({ duration_seconds: 30, call_summary: 'Left a voicemail for the customer.' }))).toBe(false);
  });

  test('no answered_by: over 20 seconds and a two-speaker transcript counts', () => {
    expect(agent.isHumanCall(call({ duration_seconds: 45, transcription: 'Agent: Waves.\nCaller: Hi, about Friday.' }))).toBe(true);
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
  const booking = ev({ type: 'visit', id: 'v1', key: 'visit:v1:booked', proof: 'booking', line: 'VISIT created after the alert' });

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

  test('a missing API key writes no row', async () => {
    const { rows } = await run(async () => { throw new agent.NoKeyError('no key'); });
    expect(rows).toHaveLength(0);
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
    const deps = makeDeps({
      timeline: async () => timelineOf(events),
      lastVerdicts: async () => new Map(rows),
      save: jest.fn(async (row) => { rows.set(row.notification_id, { ...row, created_at: NOW }); }),
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
