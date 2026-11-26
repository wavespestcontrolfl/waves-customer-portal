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
    q.first = jest.fn(async () => (state.call && !blockedByQuarantine(q) ? { id: state.call.id, metadata: state.call.metadata } : undefined));
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
    q.first = jest.fn(async () => state.utterances.find((u) => u.pan_masked));
    return q;
  }
  // notifications: the purge deletes the office-call alert row by its dedupe key.
  function notifications() {
    const q = {};
    q.whereRaw = jest.fn((sql, bindings) => { q.key = bindings[0]; return q; });
    q.del = jest.fn(async () => { state.deletedAlertKeys.push(q.key); return 1; });
    return q;
  }
  state.deletedAlertKeys = [];
  const db = jest.fn((table) => {
    if (table === 'call_log') return callLog();
    if (table === 'notifications') return notifications();
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
      alert_title: null,
      alert_line: null,
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
  promises: ["I'll text you the quote in a few minutes."],
  alert_title: 'text Dana E. a roach quote',
  alert_line: 'Dana E. wants a roach quote; Virginia promised a text.',
};

describe('the JSON reply', () => {
  test('saves the summary, the next step, the promises and the alert words beside the text', async () => {
    reply(JSON.stringify(JSON_REPLY));
    expect(await early.writeEarlySummary(SID, { now: NOW })).toEqual({ written: true, reason: null });
    expect(saved()).toEqual({
      text: JSON_REPLY.summary,
      next_step: JSON_REPLY.next_step,
      promises: JSON_REPLY.promises,
      alert_title: JSON_REPLY.alert_title,
      alert_line: JSON_REPLY.alert_line,
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
    expect(saved()).toMatchObject({ text: 'The caller has ants again.', next_step: null, promises: [], alert_title: null, alert_line: null });
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
      alert_title: 'x'.repeat(100),
      alert_line: 'y '.repeat(100),
    }));
    expect(parsed.summary).not.toMatch(/4242 4242 4242 4242/);
    expect(parsed.next_step.length).toBeLessThanOrEqual(91);
    expect(parsed.promises).toEqual(['a b', 'c', 'd', 'e']);
    expect(parsed.alert_title.length).toBeLessThanOrEqual(45);
    expect(parsed.alert_line.length).toBeLessThanOrEqual(80);
    const none = early._test.parseReply(JSON.stringify({ summary: 'Short call.', next_step: null, promises: null, alert_title: 'text someone', alert_line: null }));
    expect(none).toEqual({ summary: 'Short call.', next_step: null, promises: [], alert_title: null, alert_line: null });
  });
});

describe('the alert after an office call', () => {
  const link = '/admin/communications#tab=calls&call=log-1';

  test('a staff member who is not the owner answered: ONE needs-you alert with the model words', async () => {
    setCall({ acceptance: staffAnswer });
    reply(JSON.stringify(JSON_REPLY));
    await early.writeEarlySummary(SID, { now: NOW });
    expect(mockRaise).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = mockRaise.mock.calls[0];
    expect(category).toBe('live_call_next_step');
    expect(spec).toEqual({
      area: 'Comms',
      action: 'text Dana E. a roach quote',
      why: "Virginia's call: Dana E. wants a roach quote; Virginia promised a text.",
      severity: 'needs-you',
      link,
      subject: { type: 'call', id: 'log-1' },
      doneWhen: 'office_followed_up',
      who: 'person',
    });
    expect(opts).toEqual({ bell: true, fyiRow: true, dedupeKey: `live-call-next-step:${SID}`, bannerKind: 'live_call_next_step' });
  });

  test('no next step: an fyi alert that still names the call, with the fallback action', async () => {
    setCall({ acceptance: staffAnswer });
    reply(JSON.stringify({ ...JSON_REPLY, next_step: null, alert_title: null, alert_line: null }));
    await early.writeEarlySummary(SID, { now: NOW });
    const [, spec] = mockRaise.mock.calls[0];
    expect(spec).toMatchObject({ severity: 'fyi', action: "read Virginia's call summary" });
    expect(spec.why).toBe("Virginia's call: The caller has ants again.");
  });

  test('model words that break the alert rules fall back to fixed lines that compose', async () => {
    setCall({ acceptance: { ...staffAnswer, csr_name: null } });
    reply(JSON.stringify({ ...JSON_REPLY, alert_title: 'call back on 2026-11-26!', alert_line: 'Call me! Now. Please send it.', summary: 'Wants a quote. Staff will text it.' }));
    await early.writeEarlySummary(SID, { now: NOW });
    const [, spec] = mockRaise.mock.calls[0];
    expect(spec.action).toBe("read the office's call summary");
    expect(spec.why).toBe("The office's call: Wants a quote.");
  });

  test('a why longer than 110 characters is cut at a word', async () => {
    setCall({ acceptance: { ...staffAnswer, csr_name: 'Maria-Fernanda Gonzalez-Ortiz' } });
    reply(JSON.stringify({ ...JSON_REPLY, alert_line: 'word '.repeat(40) }));
    await early.writeEarlySummary(SID, { now: NOW });
    expect(mockRaise.mock.calls[0][1].why.length).toBeLessThanOrEqual(110);
  });

  test('the owner answered: no alert, the summary is still saved', async () => {
    setCall({ acceptance: { ...staffAnswer, answered_by_number: OWNER, csr_name: 'Adam' } });
    reply(JSON.stringify(JSON_REPLY));
    expect((await early.writeEarlySummary(SID, { now: NOW })).written).toBe(true);
    expect(mockRaise).not.toHaveBeenCalled();
    expect(saved().next_step).toBe(JSON_REPLY.next_step);
  });

  test('no forward_acceptance (not a press-1 staff answer): no alert', async () => {
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

  test('a call with card words in its live text raises nothing; its summary is still saved', async () => {
    setCall({ acceptance: staffAnswer });
    say([...CALL, ['caller', 'Can I pay with my credit card now?']]);
    reply(JSON.stringify(JSON_REPLY));
    expect((await early.writeEarlySummary(SID, { now: NOW })).written).toBe(true);
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('a call with a masked card number or a card-pause stamp raises nothing', async () => {
    setCall({ acceptance: staffAnswer });
    say(CALL);
    db.__state.utterances[1].pan_masked = true;
    reply(JSON.stringify(JSON_REPLY));
    await early.writeEarlySummary(SID, { now: NOW });
    setCall({ acceptance: staffAnswer, liveState: { card_pause: { open: false } } });
    say(CALL);
    reply(JSON.stringify(JSON_REPLY));
    await early.writeEarlySummary(SID, { now: NOW });
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('a warm-transferred call raises nothing (the answerer named may not be the one who promised)', async () => {
    setCall({ acceptance: staffAnswer });
    db.__state.call.metadata.conference_path = { hold: { transfers: 1, transfer: null } }; // a later hold replaced the transfer state
    reply(JSON.stringify(JSON_REPLY));
    await early.writeEarlySummary(SID, { now: NOW });
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('an unknown answerer (no number) is not proof of a staff answer: no alert', async () => {
    setCall({ acceptance: { ...staffAnswer, answered_by_number: null } });
    reply(JSON.stringify(JSON_REPLY));
    await early.writeEarlySummary(SID, { now: NOW });
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('card words in the middle of a long call (outside the text the model read) still block the alert', async () => {
    setCall({ acceptance: staffAnswer });
    const filler = Array.from({ length: 100 }, (_, i) => ['staff', `Filler line ${i} ${'x'.repeat(80)}`]);
    say([...CALL, ...filler, ['caller', 'Here is my card number.'], ...filler, ...CALL]);
    expect((await early._test.transcriptFor(SID)).text).not.toContain('card number');
    reply(JSON.stringify(JSON_REPLY));
    await early.writeEarlySummary(SID, { now: NOW });
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('a quarantine that lands while the alert is written: the row is deleted after the insert', async () => {
    setCall({ acceptance: staffAnswer });
    mockRaise.mockImplementationOnce(async () => {
      db.__state.call.metadata.live_transcription.quarantined_at = new Date(T0 + 70000).toISOString();
      return { id: 'n1' };
    });
    reply(JSON.stringify(JSON_REPLY));
    await early.writeEarlySummary(SID, { now: NOW });
    expect(mockRaise).toHaveBeenCalledTimes(1);
    expect(db.__state.deletedAlertKeys).toContain(`live-call-next-step:${SID}`);
  });

  test('a phone number in the model title is redacted before the bell row', async () => {
    setCall({ acceptance: staffAnswer });
    reply(JSON.stringify({ ...JSON_REPLY, alert_title: 'call 941-555-0123 back' }));
    await early.writeEarlySummary(SID, { now: NOW });
    expect(mockRaise.mock.calls[0][1].action).not.toMatch(/555/);
  });

  test('a card-number quarantine deletes the office-call alert row with the summary', async () => {
    setCall({ acceptance: staffAnswer, liveState: { early_summary: { text: 'x' } } });
    say(CALL);
    await liveText.purgeLiveUtterances(SID);
    expect(db.__state.deletedAlertKeys).toContain(`live-call-next-step:${SID}`);
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
