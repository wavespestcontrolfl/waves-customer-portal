/**
 * Early call summary from the live text (GATE_CALL_EARLY_SUMMARY, owner 2026-11-16 "ok build all, use haiku").
 *
 * Pins: gate off = no claim and no model call; one run per call (a second stopped event loses the claim); a call the
 * recording pipeline already processed, or with under 3 utterances, gets none; the model request (Haiku pin, lane,
 * labeled transcript in spoken order); what is saved (text, at, model; card numbers masked); a refusal, a reply cut
 * by the token cap or an API error saves nothing; a long call keeps its opening and its end; a summary that finishes
 * after a card quarantine is not saved; the stopped event runs it after the settle wait, gate on only; the purge drops
 * the summary with the live text.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn(() => ({ messages: { create: (...args) => mockCreate(...args) } })));

const mockLedger = jest.fn((provider, model, fn) => fn());
jest.mock('../services/llm-dispatch-metrics', () => ({ ledgerCall: (...args) => mockLedger(...args) }));

// call_log holds one row; call_live_utterances is a list. Each UPDATE is judged by the conditions the query set.
jest.mock('../models/db', () => {
  const state = { call: null, utterances: [] };
  const live = () => state.call.metadata.live_transcription;
  function callLog() {
    const q = { raws: [], nulls: [] };
    q.where = jest.fn(() => q);
    q.whereNull = jest.fn((col) => { q.nulls.push(col); return q; });
    q.whereRaw = jest.fn((sql, bindings) => { q.raws.push({ sql, bindings }); return q; });
    q.update = jest.fn(async (patch) => {
      if (!state.call || !live()) return 0;
      const { sql, bindings = [] } = patch.metadata;
      if (sql.includes("- 'early_summary'")) {
        if (!live().early_summary) return 0;
        delete live().early_summary;
        return 1;
      }
      if (q.nulls.includes('ai_extraction') && state.call.ai_extraction != null) return 0;
      if (q.raws.some((r) => r.sql.includes('early_summary_claimed_at') && r.sql.includes('IS NULL')) && live().early_summary_claimed_at) return 0;
      if (q.raws.some((r) => r.sql.includes('EXISTS (SELECT 1 FROM call_live_utterances')) && state.utterances.length === 0) return 0;
      if (q.raws.some((r) => r.sql.includes("->> 'quarantined_at') IS NULL")) && live().quarantined_at) return 0;
      Object.assign(live(), JSON.parse(bindings[0]));
      return 1;
    });
    return q;
  }
  function utterances() {
    const q = {};
    q.where = jest.fn(() => q);
    q.orderBy = jest.fn(() => q);
    q.select = jest.fn(async () => [...state.utterances].sort((a, b) => a.spoken_at - b.spoken_at || a.id - b.id));
    q.del = jest.fn(async () => { const n = state.utterances.length; state.utterances = []; return n; });
    return q;
  }
  const db = jest.fn((table) => (table === 'call_log' ? callLog() : utterances()));
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  // The purge runs in one transaction (advisory lock, quarantine stamp, deletes); the fake runs it in place.
  db.transaction = jest.fn(async (fn) => fn(db));
  db.__state = state;
  return db;
});

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const MODELS = require('../config/models');
const early = require('../services/live-call-early-summary');
const liveText = require('../services/live-call-transcription');

const SID = 'CA' + 'c'.repeat(32);
const T0 = Date.UTC(2026, 10, 17, 15, 0, 0);
const NOW = () => new Date(T0 + 60 * 1000);

function setCall({ aiExtraction = null, liveState = {} } = {}) {
  db.__state.call = {
    id: 'log-1',
    twilio_call_sid: SID,
    ai_extraction: aiExtraction,
    metadata: { live_transcription: { live_at: new Date(T0).toISOString(), stopped_at: new Date(T0 + 50000).toISOString(), ...liveState } },
  };
}
function say(lines) {
  db.__state.utterances = lines.map(([speaker, text], i) => ({ id: i + 1, speaker, text, spoken_at: T0 + i * 1000 }));
}
function reply(text, stopReason = 'end_turn') {
  mockCreate.mockResolvedValueOnce({ stop_reason: stopReason, content: [{ type: 'text', text }] });
}
const saved = () => db.__state.call.metadata.live_transcription.early_summary;

const CALL = [
  ['caller', 'Hi, ants are back in my kitchen since the last visit.'],
  ['staff', 'Sorry about that. I can send the tech back out at no charge.'],
  ['caller', 'Thursday morning works.'],
  ['staff', 'You are set for Thursday at 9.'],
];

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation(() => true);
  process.env.ANTHROPIC_API_KEY = 'test-key';
  setCall();
  say(CALL);
});

describe('writeEarlySummary', () => {
  test('gate off: no claim and no model call', async () => {
    isEnabled.mockImplementation(() => false);
    expect(await early.writeEarlySummary(SID, { now: NOW })).toEqual({ written: false, reason: 'gate_off' });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(db.__state.call.metadata.live_transcription.early_summary_claimed_at).toBeUndefined();
  });

  test('one run per call: a second stopped event finds the claim taken', async () => {
    reply('The caller has ants again; a free return visit is set for Thursday at 9.');
    expect((await early.writeEarlySummary(SID, { now: NOW })).written).toBe(true);
    expect(await early.writeEarlySummary(SID, { now: NOW })).toEqual({ written: false, reason: 'not_claimed' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('a call the recording pipeline already processed gets none', async () => {
    setCall({ aiExtraction: JSON.stringify({ call_summary: 'Pipeline summary.' }) });
    expect(await early.writeEarlySummary(SID, { now: NOW })).toEqual({ written: false, reason: 'not_claimed' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('under 3 utterances: no model call', async () => {
    say(CALL.slice(0, 2));
    expect(await early.writeEarlySummary(SID, { now: NOW })).toEqual({ written: false, reason: 'too_short' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('the request: Haiku pin, its own lane, the labeled transcript in spoken order', async () => {
    reply('Summary.');
    await early.writeEarlySummary(SID, { now: NOW });
    const [request] = mockCreate.mock.calls[0];
    expect(request.model).toBe(MODELS.LIVE_CALL);
    expect(request.system).toMatch(/pest control/);
    expect(request.messages[0].content).toBe([
      'Caller: Hi, ants are back in my kitchen since the last visit.',
      'Agent: Sorry about that. I can send the tech back out at no charge.',
      'Caller: Thursday morning works.',
      'Agent: You are set for Thursday at 9.',
    ].join('\n'));
    expect(mockLedger).toHaveBeenCalledWith('anthropic', MODELS.LIVE_CALL, expect.any(Function), { laneId: 'live_call_early_summary' });
  });

  test('saves the text, the time and the model on the call', async () => {
    reply('  The caller has ants again.\n A free return visit is set for Thursday at 9.  ');
    expect(await early.writeEarlySummary(SID, { now: NOW })).toEqual({ written: true, reason: null });
    expect(saved()).toEqual({
      text: 'The caller has ants again. A free return visit is set for Thursday at 9.',
      at: NOW().toISOString(),
      model: MODELS.LIVE_CALL,
    });
  });

  test('a card number in the reply is masked before it is saved', async () => {
    reply('The caller paid with card 4242 4242 4242 4242 for the return visit.');
    await early.writeEarlySummary(SID, { now: NOW });
    expect(saved().text).not.toMatch(/4242 4242 4242 4242/);
    expect(saved().text).toMatch(/return visit/);
  });

  test.each([
    ['a refusal', () => reply('', 'refusal')],
    ['a reply cut by the token cap', () => reply('The caller has ants and', 'max_tokens')],
    ['an API error', () => mockCreate.mockRejectedValueOnce(Object.assign(new Error('overloaded'), { status: 529 }))],
  ])('%s saves nothing', async (_label, arrange) => {
    arrange();
    expect(await early.writeEarlySummary(SID, { now: NOW })).toEqual({ written: false, reason: 'no_summary' });
    expect(saved()).toBeUndefined();
  });

  // The race the quarantine stamp closes: a save whose EXISTS check ran on a snapshot taken before the purge
  // committed still sees the text, so the stamped row itself must refuse it.
  test('a save on a quarantined call is refused even while its text is still visible', async () => {
    setCall({ liveState: { quarantined_at: new Date(T0).toISOString() } });
    reply('The caller has ants again.');
    expect(await early.writeEarlySummary(SID, { now: NOW })).toEqual({ written: false, reason: null });
    expect(saved()).toBeUndefined();
  });

  test('a summary that finishes after a card quarantine is not saved', async () => {
    mockCreate.mockImplementationOnce(async () => {
      await liveText.purgeLiveUtterances(SID);
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Summary written from purged text.' }] };
    });
    expect(await early.writeEarlySummary(SID, { now: NOW })).toEqual({ written: false, reason: null });
    expect(saved()).toBeUndefined();
  });
});

describe('the transcript sent', () => {
  test('a long call keeps its opening and its end', async () => {
    const { HEAD_CHARS, TAIL_CHARS } = early._test;
    const filler = Array.from({ length: 120 }, (_, i) => ['staff', `Filler line ${i} ${'x'.repeat(80)}`]);
    say([['caller', 'OPENING: termites in the garage.'], ...filler, ['caller', 'ENDING: see you Friday.']]);
    const { text, utterances } = await early._test.transcriptFor(SID);
    expect(utterances).toBe(122);
    expect(text.startsWith('Caller: OPENING')).toBe(true);
    expect(text.endsWith('Caller: ENDING: see you Friday.')).toBe(true);
    expect(text).toContain('\n[…]\n');
    expect(text.length).toBeLessThanOrEqual(HEAD_CHARS + TAIL_CHARS + 5);
  });
});

describe('live-call-transcription hooks', () => {
  afterEach(() => { jest.useRealTimers(); });

  test('transcription-stopped: the summary runs after the settle wait, gate on', async () => {
    jest.useFakeTimers();
    reply('Summary after the wait.');
    await liveText.recordLiveTranscriptionEvent({ CallSid: SID, TranscriptionEvent: 'transcription-stopped', Timestamp: new Date(T0 + 50000).toISOString() });
    await jest.advanceTimersByTimeAsync(early._test.SETTLE_MS - 1);
    expect(mockCreate).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(saved().text).toBe('Summary after the wait.');
  });

  test('transcription-stopped with the gate off: stopped_at is stamped and nothing else runs', async () => {
    jest.useFakeTimers();
    isEnabled.mockImplementation((name) => name !== 'callEarlySummary');
    setCall({ liveState: { stopped_at: undefined } });
    await liveText.recordLiveTranscriptionEvent({ CallSid: SID, TranscriptionEvent: 'transcription-stopped', Timestamp: new Date(T0 + 50000).toISOString() });
    await jest.advanceTimersByTimeAsync(10 * 1000);
    expect(db.__state.call.metadata.live_transcription.stopped_at).toBe(new Date(T0 + 50000).toISOString());
    expect(mockCreate).not.toHaveBeenCalled();
    expect(db.__state.call.metadata.live_transcription.early_summary_claimed_at).toBeUndefined();
  });

  test('a card quarantine purge drops the summary with the live text, gate on or off', async () => {
    setCall({ liveState: { early_summary: { text: 'Old summary.', at: new Date(T0).toISOString(), model: MODELS.LIVE_CALL } } });
    isEnabled.mockImplementation(() => false);
    expect(await liveText.purgeLiveUtterances(SID)).toBe(CALL.length);
    expect(db.__state.utterances).toEqual([]);
    expect(saved()).toBeUndefined();
  });
});
