/**
 * Early call summary from the live text (GATE_CALL_EARLY_SUMMARY, owner 2026-11-16 "ok build all, use haiku").
 *
 * Pins: gate off = no claim and no model call; one run per call (a second stopped event loses the claim); a call the
 * recording pipeline already processed, or with under 3 utterances, gets none; the model request (Haiku pin, lane,
 * labeled transcript in spoken order); what is saved (text, at, model; card numbers masked); a refusal, a reply cut
 * by the token cap or an API error saves nothing; a long call keeps its opening and its end; a summary that finishes
 * after a card quarantine is not saved; the stopped event runs it after the settle wait, gate on only; the purge drops
 * the summary with the live text.
 *
 * Next step + staff promises + phone alert (owner 2026-11-26 "build both"): the one reply is JSON (fenced JSON, a
 * bare-text reply and a broken JSON reply are handled), every string is scrubbed and capped; ONE admin alert is raised
 * for a call a non-owner staff member answered, none for an owner answer or a call with no forward_acceptance, and a
 * failed alert keeps the saved summary.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn(() => ({ messages: { create: (...args) => mockCreate(...args) } })));

const mockRaise = jest.fn(async () => ({ id: 'n-1' }));
// The real composer checks every spec the module raises (title and why budgets, forbidden tokens), as the alert's own rules do.
jest.mock('../services/admin-alert-compose', () => {
  const actual = jest.requireActual('../services/admin-alert-compose');
  return { ...actual, raiseAdminAlert: (category, spec, opts) => { actual.composeAdminAlert(spec); return mockRaise(category, spec, opts); } };
});

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
      if (blockedByQuarantine(q)) return 0;
      Object.assign(live(), JSON.parse(bindings[0]));
      return 1;
    });
    q.first = jest.fn(async () => (state.call && !blockedByQuarantine(q) ? { id: state.call.id, metadata: state.call.metadata, customer_id: state.call.customer_id } : undefined));
    return q;
  }
  // The shared predicate (live-call-transcription QUARANTINE_WHERE_SQL): quarantined_at, or the recording scrub's
  // transcription_metadata.pan_detected.
  const quarantined = () => Boolean(live().quarantined_at) || String(state.call.transcription_metadata?.pan_detected) === 'true';
  const blockedByQuarantine = (q) => q.raws.some((r) => r.sql.startsWith('NOT ') && r.sql.includes('pan_detected')) && quarantined();
  function utterances() {
    const q = {};
    q.where = jest.fn(() => q);
    q.orderBy = jest.fn(() => q);
    q.select = jest.fn(async () => {
      if (state.onTranscriptRead) state.onTranscriptRead();
      return [...state.utterances].sort((a, b) => a.spoken_at - b.spoken_at || a.id - b.id);
    });
    q.del = jest.fn(async () => { const n = state.utterances.length; state.utterances = []; return n; });
    return q;
  }
  // The Bell switch read (technicians + notification_preferences): one active admin, no preference row = on.
  function listOf(rows) {
    const q = {};
    q.where = jest.fn(() => q);
    q.whereIn = jest.fn(() => q);
    q.select = jest.fn(async () => rows());
    return q;
  }
  const db = jest.fn((table) => {
    if (table === 'call_log') return callLog();
    if (table === 'technicians') return listOf(() => [{ id: 'a-1' }]);
    if (table === 'notification_preferences') return listOf(() => state.bellPrefs || []);
    return utterances();
  });
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

const OWNER = '+19415550100';
const staffAnswer = { accepted: true, answered_by_number: '+19415550111', csr_name: 'Virginia', accepted_at: new Date(T0).toISOString() };

function setCall({ aiExtraction = null, liveState = {}, transcriptionMetadata = null, acceptance } = {}) {
  db.__state.onTranscriptRead = null;
  db.__state.bellPrefs = null;
  db.__state.call = {
    id: 'log-1',
    twilio_call_sid: SID,
    ai_extraction: aiExtraction,
    transcription_metadata: transcriptionMetadata,
    metadata: {
      live_transcription: { live_at: new Date(T0).toISOString(), stopped_at: new Date(T0 + 50000).toISOString(), ...liveState },
      ...(acceptance ? { forward_acceptance: acceptance } : {}),
    },
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
  process.env.ADAM_PHONE = OWNER;
  mockRaise.mockImplementation(async () => ({ id: 'n-1' }));
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
      next_step: null,
      promises: [],
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
    mockCreate.mockImplementationOnce(async () => {
      db.__state.call.metadata.live_transcription.quarantined_at = new Date(T0 + 55000).toISOString();
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The caller has ants again.' }] };
    });
    expect(await early.writeEarlySummary(SID, { now: NOW })).toEqual({ written: false, reason: null });
    expect(db.__state.utterances.length).toBeGreaterThan(0);
    expect(saved()).toBeUndefined();
  });

  test('a call quarantined before its run is never claimed and never sent to the model', async () => {
    setCall({ liveState: { quarantined_at: new Date(T0).toISOString() } });
    expect(await early.writeEarlySummary(SID, { now: NOW })).toEqual({ written: false, reason: 'not_claimed' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // The recording pipeline stamps transcription_metadata.pan_detected before it tries the purge, and a failed
  // purge waits for the 5-minute retry: in that gap quarantined_at is absent and the live text is still there.
  test('a call the recording scrub flagged, before its purge ran, is never claimed and never sent to the model', async () => {
    setCall({ transcriptionMetadata: { pan_detected: true } });
    expect(await early.writeEarlySummary(SID, { now: NOW })).toEqual({ written: false, reason: 'not_claimed' });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(saved()).toBeUndefined();
  });

  test('a pan_detected flag that lands after the claim keeps the text from the model', async () => {
    db.__state.onTranscriptRead = () => { db.__state.call.transcription_metadata = { pan_detected: 'true' }; };
    expect(await early.writeEarlySummary(SID, { now: NOW })).toEqual({ written: false, reason: 'quarantined' });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(saved()).toBeUndefined();
  });

  test('a pan_detected flag that lands during the model call blocks the save', async () => {
    mockCreate.mockImplementationOnce(async () => {
      db.__state.call.transcription_metadata = { pan_detected: true };
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The caller read a card number.' }] };
    });
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

const JSON_REPLY = {
  summary: 'The caller has ants again. A free return visit is set for Thursday at 9.',
  next_step: 'Text Dana E. the roach quote today.',
  promises: ['You are set for Thursday at 9.'],
};

describe('the JSON reply', () => {
  test('saves the summary, the next step and the promises beside the text', async () => {
    reply(JSON.stringify(JSON_REPLY));
    expect(await early.writeEarlySummary(SID, { now: NOW })).toEqual({ written: true, reason: null });
    expect(saved()).toEqual({
      text: JSON_REPLY.summary,
      next_step: JSON_REPLY.next_step,
      promises: JSON_REPLY.promises,
      at: NOW().toISOString(),
      model: MODELS.LIVE_CALL,
    });
  });

  test('a reply wrapped in a code fence still parses', async () => {
    reply('```json\n' + JSON.stringify(JSON_REPLY) + '\n```');
    await early.writeEarlySummary(SID, { now: NOW });
    expect(saved().next_step).toBe(JSON_REPLY.next_step);
  });

  test('a bare-text reply is the summary alone', async () => {
    reply('The caller has ants again.');
    await early.writeEarlySummary(SID, { now: NOW });
    expect(saved()).toMatchObject({ text: 'The caller has ants again.', next_step: null, promises: [] });
  });

  test('a broken JSON reply saves nothing (raw braces never reach the office)', async () => {
    reply('{"summary": "The caller has ants", "next_step": ');
    expect(await early.writeEarlySummary(SID, { now: NOW })).toEqual({ written: false, reason: 'no_summary' });
    expect(saved()).toBeUndefined();
  });

  test('every string is scrubbed and capped; nulls and empty promises read as none', () => {
    const long = 'Call back about the termite inspection and send the written quote ' + 'to the customer '.repeat(10);
    const parsed = early._test.parseReply(JSON.stringify({
      summary: 'Card 4242 4242 4242 4242 was read.',
      next_step: long,
      promises: ['  a\u0000b  ', '', 7, 'c', 'd', 'e', 'f'],
    }));
    expect(parsed.summary).not.toMatch(/4242 4242 4242 4242/);
    expect(parsed.next_step.length).toBeLessThanOrEqual(91);
    expect(parsed.promises).toEqual(['a b', 'c', 'd', 'e']);
    const none = early._test.parseReply(JSON.stringify({ summary: 'Short call.', next_step: null, promises: null }));
    expect(none).toEqual({ summary: 'Short call.', next_step: null, promises: [] });
  });
});

describe('the alert after an office call', () => {
  const link = '/admin/communications#tab=calls&call=log-1';

  test('a known staff number that is not the owner answered: ONE needs-you alert in fixed words, no call text', async () => {
    setCall({ acceptance: staffAnswer });
    reply(JSON.stringify(JSON_REPLY));
    expect(await early.writeEarlySummary(SID, { now: NOW })).toEqual({ written: true, reason: null });
    expect(mockRaise).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = mockRaise.mock.calls[0];
    expect(category).toBe('live_call_next_step');
    expect(spec).toEqual({
      area: 'Comms',
      action: "next step on Virginia's call",
      why: 'Open the call to see the next step and what was promised.',
      severity: 'needs-you',
      link,
      subject: { type: 'call', id: 'log-1' },
      doneWhen: 'office_followed_up',
      who: 'person',
    });
    expect(opts).toEqual({ bell: true, fyiRow: true, dedupeKey: `live-call-next-step:${SID}`, bannerKind: 'live_call_next_step' });
  });

  test('no word the model wrote ever reaches the alert (a spoken gate code, an address, a card)', async () => {
    setCall({ acceptance: staffAnswer });
    reply(JSON.stringify({ ...JSON_REPLY, summary: 'Gate is four two one nine. Lives at 12 Example Way.', next_step: 'Use gate four two one nine at 12 Example Way.' }));
    await early.writeEarlySummary(SID, { now: NOW });
    const [, spec] = mockRaise.mock.calls[0];
    expect(`${spec.action} ${spec.why}`).not.toMatch(/four|Example|12/);
  });

  test('no next step: an fyi alert in fixed words', async () => {
    setCall({ acceptance: { ...staffAnswer, csr_name: null } });
    reply(JSON.stringify({ ...JSON_REPLY, next_step: null }));
    await early.writeEarlySummary(SID, { now: NOW });
    const [, spec] = mockRaise.mock.calls[0];
    expect(spec).toMatchObject({ severity: 'fyi', action: "read the office's call summary", why: 'Open the call to see its summary.' });
  });

  test('the owner answered: no alert, the summary is still saved', async () => {
    setCall({ acceptance: { ...staffAnswer, answered_by_number: OWNER, csr_name: 'Adam' } });
    reply(JSON.stringify(JSON_REPLY));
    expect((await early.writeEarlySummary(SID, { now: NOW })).written).toBe(true);
    expect(mockRaise).not.toHaveBeenCalled();
    expect(saved().next_step).toBe(JSON_REPLY.next_step);
  });

  test('no forward_acceptance, or an unknown answerer (no number): no alert', async () => {
    reply(JSON.stringify(JSON_REPLY));
    await early.writeEarlySummary(SID, { now: NOW });
    setCall({ acceptance: { ...staffAnswer, answered_by_number: null } });
    reply(JSON.stringify(JSON_REPLY));
    await early.writeEarlySummary(SID, { now: NOW });
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('no summary saved (a quarantined call): no alert', async () => {
    setCall({ acceptance: staffAnswer });
    mockCreate.mockImplementationOnce(async () => {
      db.__state.call.metadata.live_transcription.quarantined_at = new Date(T0 + 55000).toISOString();
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(JSON_REPLY) }] };
    });
    await early.writeEarlySummary(SID, { now: NOW });
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('every admin turned the Bell switch off: no row', async () => {
    setCall({ acceptance: staffAnswer });
    db.__state.bellPrefs = [{ admin_user_id: 'a-1', bell_enabled: false }];
    reply(JSON.stringify(JSON_REPLY));
    await early.writeEarlySummary(SID, { now: NOW });
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test("the call's customer id rides in the alert metadata (an internal test customer rings nobody)", async () => {
    setCall({ acceptance: staffAnswer });
    db.__state.call.customer_id = 'cust-9';
    reply(JSON.stringify(JSON_REPLY));
    await early.writeEarlySummary(SID, { now: NOW });
    expect(mockRaise.mock.calls[0][2].metadata).toEqual({ customerId: 'cust-9' });
  });

  test('an alert that fails keeps the saved summary and logs a warning', async () => {
    setCall({ acceptance: staffAnswer });
    mockRaise.mockRejectedValueOnce(Object.assign(new Error('db down'), { code: 'ECONNRESET' }));
    reply(JSON.stringify(JSON_REPLY));
    expect(await early.writeEarlySummary(SID, { now: NOW })).toEqual({ written: true, reason: null });
    expect(saved().text).toBe(JSON_REPLY.summary);
    expect(require('../services/logger').warn).toHaveBeenCalledWith(expect.stringContaining('next-step alert failed'));
  });
});

describe('the promises saved', () => {
  test('a promise no staff line says (a caller line or a model guess) is dropped', async () => {
    reply(JSON.stringify({ ...JSON_REPLY, promises: ['You are set for Thursday at 9.', 'Thursday morning works.', 'We will waive the fee forever.'] }));
    await early.writeEarlySummary(SID, { now: NOW });
    expect(saved().promises).toEqual(['You are set for Thursday at 9.']);
  });

  test('a refusal is never turned into a promise ("cannot" read as "can")', async () => {
    say([...CALL, ['staff', 'I cannot waive the fee, sorry.']]);
    reply(JSON.stringify({ ...JSON_REPLY, promises: ['I can waive the fee', 'I cannot waive the fee'] }));
    await early.writeEarlySummary(SID, { now: NOW });
    expect(saved().promises).toEqual(['I cannot waive the fee, sorry.']);
  });

  test('a quote that drops a condition is saved as the whole staff line, condition kept', async () => {
    say([...CALL, ['staff', "I'll waive the fee only if the manager approves."]]);
    reply(JSON.stringify({ ...JSON_REPLY, promises: ["I'll waive the fee"] }));
    await early.writeEarlySummary(SID, { now: NOW });
    expect(saved().promises).toEqual(["I'll waive the fee only if the manager approves."]);
  });

  test('a staff line too long to show whole is left out, never cut', async () => {
    say([...CALL, ['staff', `${'Let me explain how this works. '.repeat(5)}I'll waive the fee only if the manager approves.`]]);
    reply(JSON.stringify({ ...JSON_REPLY, promises: ["I'll waive the fee"] }));
    await early.writeEarlySummary(SID, { now: NOW });
    expect(saved().promises).toEqual([]);
  });

  test('a long call: a promise is matched against the whole staff line, not the text the model was cut to', async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ['caller', `Filler line ${i} ${'x'.repeat(80)}`]);
    say([['caller', 'Hi.'], ['staff', `${'y'.repeat(1990)} I'll waive the fee only if the manager approves.`], ...filler, ...CALL]);
    reply(JSON.stringify({ ...JSON_REPLY, promises: ["I'll waive the fee"] }));
    await early.writeEarlySummary(SID, { now: NOW });
    expect(saved().promises).toEqual([]);
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
