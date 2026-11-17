/**
 * Live call transcription (GATE_LIVE_CALL_TRANSCRIPTION, owner 2026-11-16 "ok build all").
 *
 * Pins: one start per call (both cells can press 1), the Twilio REST shape (caller's call, both
 * tracks, final results only, the signed webhook URL), a Twilio refusal stamped and swallowed,
 * and the utterance store — final only, idempotent per (session, sequence), only for a call this
 * module claimed, and card-number scrubbed across utterances (a number read in pieces, with staff
 * lines between them, or a piece that arrives late; a code read after a masked number, a staff
 * question in between included) while each mask stays on its own line; a quarantined call stores
 * no more live text, and a failed purge is retried.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));

const mockUpset = jest.fn();
jest.mock('../services/live-call-upset-alert', () => ({ afterCallerUtterance: (...args) => mockUpset(...args) }));

const mockRequest = jest.fn();
jest.mock('twilio', () => jest.fn(() => ({ request: mockRequest })));

// A small knex fake: call_log claims + stamps, and an in-memory call_live_utterances table.
jest.mock('../models/db', () => {
  const state = { claimed: new Set(), quarantined: new Set(), panDetected: new Set(), rowExists: true, stamps: [], utterances: [], nextId: 1, rawCalls: [] };
  function callLog() {
    const q = { filters: [], raws: [] };
    q.where = jest.fn((col, val) => { q.filters.push([col, val]); return q; });
    q.whereRaw = jest.fn((sql) => { q.raws.push(sql); return q; });
    q.first = jest.fn(async () => {
      const sid = q.filters.find(([c]) => c === 'twilio_call_sid')?.[1];
      if (!state.claimed.has(sid)) return undefined;
      return { id: `log-${sid}`, quarantined: state.quarantined.has(sid) || state.panDetected.has(sid) };
    });
    q.update = jest.fn(async (patch) => {
      const sid = q.filters.find(([c]) => c === 'twilio_call_sid')?.[1];
      if (!state.rowExists) return 0;
      if (q.raws.some((r) => r.includes('IS NULL'))) {
        if (state.claimed.has(sid)) return 0;
        state.claimed.add(sid);
        state.stamps.push({ sid, claim: true, bindings: patch.metadata.bindings });
        return 1;
      }
      if (!state.claimed.has(sid)) return 0;
      state.stamps.push({ sid, claim: false, bindings: patch.metadata.bindings });
      if ('quarantined_at' in JSON.parse(patch.metadata.bindings[0])) state.quarantined.add(sid);
      return 1;
    });
    return q;
  }
  function utterances() {
    const q = { filters: [], times: [], dir: 'desc' };
    q.where = jest.fn((col, op, val) => {
      if (val === undefined) q.filters.push([col, op]);
      else q.times.push([op, new Date(val).getTime()]);
      return q;
    });
    q.orderBy = jest.fn((cols) => { q.dir = cols[0].order; return q; });
    q.limit = jest.fn((n) => { q.lim = n; return q; });
    q.select = jest.fn(async () => {
      const sid = q.filters.find(([c]) => c === 'call_sid')?.[1];
      const sign = q.dir === 'asc' ? 1 : -1;
      return state.utterances
        .filter((u) => u.call_sid === sid)
        .filter((u) => q.times.every(([op, at]) => {
        const ms = u.spoken_at.getTime();
        return op === '<=' ? ms <= at : op === '>=' ? ms >= at : ms > at;
      }))
        .sort((a, b) => sign * ((a.spoken_at - b.spoken_at) || (a.id - b.id)))
        .slice(0, q.lim)
        .map((u) => ({ ...u }));
    });
    q.insert = jest.fn((row) => {
      q.row = row;
      return q;
    });
    q.onConflict = jest.fn(() => q);
    q.ignore = jest.fn(() => q);
    q.returning = jest.fn(async () => {
      const dup = state.utterances.some((u) => u.transcription_sid === q.row.transcription_sid && u.sequence_id === q.row.sequence_id);
      if (dup) return [];
      const id = state.nextId++;
      state.utterances.push({ ...q.row, id, spoken_at: q.row.spoken_at });
      return [{ id }];
    });
    q.update = jest.fn(async (patch) => {
      const id = q.filters.find(([c]) => c === 'id')?.[1];
      const row = state.utterances.find((u) => u.id === id);
      if (row) Object.assign(row, patch);
      return row ? 1 : 0;
    });
    q.del = jest.fn(async () => {
      const sid = q.filters.find(([c]) => c === 'call_sid')?.[1];
      const before = state.utterances.length;
      state.utterances = state.utterances.filter((u) => u.call_sid !== sid);
      return before - state.utterances.length;
    });
    return q;
  }
  const db = jest.fn((table) => (table === 'call_log' ? callLog() : utterances()));
  db.raw = jest.fn((sql, bindings) => {
    state.rawCalls.push(sql);
    if (/EXISTS/.test(sql) && /pan_detected/.test(sql)) { // purgeQuarantinedLiveText's lookup
      const sids = [...new Set(state.utterances.map((u) => u.call_sid))].filter((sid) => state.panDetected.has(sid));
      state.sweepBindings = bindings;
      return Promise.resolve({ rows: sids.slice(0, bindings.at(-1)).map((callSid) => ({ call_sid: callSid })) });
    }
    return { sql, bindings };
  });
  db.transaction = jest.fn(async (fn) => fn(db));
  db.__state = state;
  return db;
});

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const live = require('../services/live-call-transcription');

const CALL = 'CA' + 'a'.repeat(32);
const OTHER = 'CA' + 'b'.repeat(32);

function content(seq, track, transcript, at, extra = {}) {
  return {
    CallSid: CALL,
    TranscriptionSid: 'GT' + '1'.repeat(32),
    TranscriptionEvent: 'transcription-content',
    SequenceId: String(seq),
    Track: track,
    Final: 'true',
    LanguageCode: 'en-US',
    Timestamp: new Date(Date.UTC(2026, 10, 16, 15, 0, at)).toISOString(),
    TranscriptionData: JSON.stringify({ transcript, confidence: 0.93 }),
    ...extra,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  const s = db.__state;
  s.claimed = new Set();
  s.quarantined = new Set();
  s.panDetected = new Set();
  s.rowExists = true;
  s.stamps = [];
  s.utterances = [];
  s.nextId = 1;
  s.rawCalls = [];
  isEnabled.mockReturnValue(true);
  process.env.TWILIO_ACCOUNT_SID = 'AC' + 'c'.repeat(32);
  process.env.TWILIO_AUTH_TOKEN = 'token';
  delete process.env.SERVER_DOMAIN;
  mockRequest.mockResolvedValue({ statusCode: 201, body: { sid: 'GT' + '9'.repeat(32), status: 'in-progress' } });
});

describe('startLiveTranscription', () => {
  test('gate off: no claim and no Twilio call', async () => {
    isEnabled.mockReturnValue(false);
    await expect(live.startLiveTranscription({ parentCallSid: CALL })).resolves.toMatchObject({ started: false, reason: 'gate_off' });
    expect(db).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  test('starts on the caller\'s call, both tracks, final results, the signed webhook URL', async () => {
    await expect(live.startLiveTranscription({ parentCallSid: CALL })).resolves.toMatchObject({ started: true });
    expect(mockRequest).toHaveBeenCalledTimes(1);
    const req = mockRequest.mock.calls[0][0];
    expect(req.method).toBe('post');
    expect(req.uri).toBe(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Calls/${CALL}/Transcriptions.json`);
    expect(req.data).toMatchObject({
      StatusCallbackUrl: 'https://portal.wavespestcontrol.com/api/webhooks/twilio/live-transcription',
      Track: 'both_tracks',
      PartialResults: 'false',
      LanguageCode: 'en-US',
    });
    // The claim, then the outcome stamp with the session id.
    expect(db.__state.stamps.map((s) => s.claim)).toEqual([true, false]);
    expect(JSON.parse(db.__state.stamps[1].bindings[0])).toMatchObject({ status: 'started', transcription_sid: 'GT' + '9'.repeat(32) });
  });

  test('a Spanish caller is transcribed in es-US', async () => {
    await live.startLiveTranscription({ parentCallSid: CALL, language: 'es' });
    expect(mockRequest.mock.calls[0][0].data.LanguageCode).toBe('es-US');
  });

  test('a second press 1 on the same call starts nothing (one start per call)', async () => {
    await live.startLiveTranscription({ parentCallSid: CALL });
    await expect(live.startLiveTranscription({ parentCallSid: CALL })).resolves.toMatchObject({ started: false, reason: 'already_claimed_or_no_row' });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  test('no call_log row: nothing starts (no spend without a row to keep the text on)', async () => {
    db.__state.rowExists = false;
    await expect(live.startLiveTranscription({ parentCallSid: CALL })).resolves.toMatchObject({ started: false });
    expect(mockRequest).not.toHaveBeenCalled();
  });

  test('a Twilio refusal is stamped on the call and never thrown', async () => {
    mockRequest.mockResolvedValue({ statusCode: 400, body: { code: 21220, message: 'Call is not in-progress' } });
    await expect(live.startLiveTranscription({ parentCallSid: CALL })).resolves.toMatchObject({ started: false, reason: 'twilio_refused' });
    expect(JSON.parse(db.__state.stamps[1].bindings[0])).toMatchObject({ status: 'start_failed', error_code: 21220 });
    mockRequest.mockRejectedValue(new Error('socket hang up'));
    await expect(live.startLiveTranscription({ parentCallSid: OTHER })).resolves.toMatchObject({ started: false });
  });

  test('a malformed CallSid or missing credentials start nothing', async () => {
    await expect(live.startLiveTranscription({ parentCallSid: 'CA-1' })).resolves.toMatchObject({ reason: 'no_call_sid' });
    delete process.env.TWILIO_AUTH_TOKEN;
    await expect(live.startLiveTranscription({ parentCallSid: CALL })).resolves.toMatchObject({ reason: 'no_twilio_credentials' });
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe('recordLiveTranscriptionEvent', () => {
  beforeEach(() => { db.__state.claimed.add(CALL); });

  test('stores a final utterance with its speaker; ignores partials', async () => {
    await expect(live.recordLiveTranscriptionEvent(content(2, 'inbound_track', 'I have ants in the kitchen', 1))).resolves.toMatchObject({ stored: true });
    await expect(live.recordLiveTranscriptionEvent(content(3, 'outbound_track', 'We can help with that', 3))).resolves.toMatchObject({ stored: true });
    await expect(live.recordLiveTranscriptionEvent(content(4, 'inbound_track', 'I have', 4, { Final: 'false' }))).resolves.toMatchObject({ stored: false, reason: 'partial' });
    expect(db.__state.utterances.map((u) => [u.speaker, u.text])).toEqual([
      ['caller', 'I have ants in the kitchen'],
      ['staff', 'We can help with that'],
    ]);
  });

  test('a stored caller utterance hands the call to the upset check; staff, duplicates and gate off do not', async () => {
    await live.recordLiveTranscriptionEvent(content(1, 'outbound_track', 'Thanks for calling', 1));
    expect(mockUpset).not.toHaveBeenCalled();
    await live.recordLiveTranscriptionEvent(content(2, 'inbound_track', 'I am very unhappy', 2));
    expect(mockUpset).toHaveBeenCalledWith(CALL);
    mockUpset.mockClear();
    await live.recordLiveTranscriptionEvent(content(2, 'inbound_track', 'I am very unhappy', 2));
    expect(mockUpset).not.toHaveBeenCalled();
    isEnabled.mockImplementation((gate) => gate !== 'liveCallUpsetAlert');
    await live.recordLiveTranscriptionEvent(content(3, 'inbound_track', 'Hello?', 3));
    expect(mockUpset).not.toHaveBeenCalled();
  });

  test('a redelivered event inserts nothing', async () => {
    await live.recordLiveTranscriptionEvent(content(2, 'inbound_track', 'hello', 1));
    await expect(live.recordLiveTranscriptionEvent(content(2, 'inbound_track', 'hello', 1))).resolves.toMatchObject({ stored: false, reason: 'duplicate' });
    expect(db.__state.utterances).toHaveLength(1);
  });

  test('a call this module never started is not written to', async () => {
    await expect(live.recordLiveTranscriptionEvent({ ...content(2, 'inbound_track', 'hello', 1), CallSid: OTHER })).resolves.toMatchObject({ stored: false, reason: 'not_started_here' });
    expect(db.__state.utterances).toHaveLength(0);
  });

  test('a card number in one utterance is masked before it is stored', async () => {
    await live.recordLiveTranscriptionEvent(content(2, 'inbound_track', 'my card is 4242 4242 4242 4242', 1));
    const [row] = db.__state.utterances;
    expect(row.text).not.toMatch(/4242 4242/);
    expect(row.text).toContain('[card ending 4242]');
    expect(row.pan_masked).toBe(true);
    expect(JSON.parse(db.__state.stamps.at(-1).bindings[0])).toEqual({ pan_detected: true });
  });

  test('a card number read across two utterances is masked in the stored rows', async () => {
    await live.recordLiveTranscriptionEvent(content(2, 'inbound_track', '4242 4242', 1));
    expect(db.__state.utterances[0].text).toBe('4242 4242');
    await live.recordLiveTranscriptionEvent(content(3, 'inbound_track', '4242 4242', 3));
    const all = db.__state.utterances.map((u) => u.text).join(' ');
    expect(all).not.toMatch(/4242 4242/);
    expect(all).toContain('[card ending 4242]');
    expect(db.__state.utterances.every((u) => u.pan_masked)).toBe(true);
  });

  test('a code read right after a masked card number is masked too', async () => {
    await live.recordLiveTranscriptionEvent(content(2, 'inbound_track', '4242 4242 4242 4242', 1));
    await live.recordLiveTranscriptionEvent(content(3, 'inbound_track', '1 2 3', 4));
    expect(db.__state.utterances[1].text).toBe('[code removed]');
    // Later, ordinary numbers stay: an address 2 minutes on is not a card code.
    await live.recordLiveTranscriptionEvent(content(4, 'inbound_track', '4 5 6', 130));
    expect(db.__state.utterances[2].text).toBe('4 5 6');
  });

  test('a mask stays on the line it came from: other lines keep their own text, speaker and time', async () => {
    await live.recordLiveTranscriptionEvent(content(2, 'inbound_track', 'I need service at 10 tomorrow', 1));
    await live.recordLiveTranscriptionEvent(content(3, 'outbound_track', 'Sure, what card?', 3));
    await live.recordLiveTranscriptionEvent(content(4, 'inbound_track', '4242 4242 4242 4242', 5));
    expect(db.__state.utterances.map((u) => [u.speaker, u.text, u.pan_masked])).toEqual([
      ['caller', 'I need service at 10 tomorrow', false],
      ['staff', 'Sure, what card?', false],
      ['caller', '[card ending 4242]', true],
    ]);
  });

  test('a staff line between two halves of the caller\'s card number does not hide it', async () => {
    await live.recordLiveTranscriptionEvent(content(2, 'inbound_track', '4242 4242', 1));
    await live.recordLiveTranscriptionEvent(content(3, 'outbound_track', 'Okay, go ahead.', 2));
    await live.recordLiveTranscriptionEvent(content(4, 'inbound_track', '4242 4242', 3));
    const rows = db.__state.utterances.map((u) => [u.speaker, u.text, u.pan_masked]);
    expect(rows).toEqual([['caller', '[card ending 4242]', true], ['staff', 'Okay, go ahead.', false], ['caller', '', true]]);
  });

  test('a card read in four pieces with staff acknowledgements between them is masked', async () => {
    const lines = [['inbound_track', '4242'], ['outbound_track', 'Okay.'], ['inbound_track', '4242'], ['outbound_track', 'Uh huh.'],
      ['inbound_track', '4242'], ['outbound_track', 'Got it.'], ['inbound_track', '4242']];
    for (const [i, [track, text]] of lines.entries()) await live.recordLiveTranscriptionEvent(content(2 + i, track, text, 1 + 2 * i));
    const caller = db.__state.utterances.filter((u) => u.speaker === 'caller');
    expect(caller.map((u) => u.text)).toEqual(['[card ending 4242]', '', '', '']);
    expect(caller.every((u) => u.pan_masked)).toBe(true);
    expect(db.__state.utterances.filter((u) => u.speaker === 'staff').map((u) => u.text)).toEqual(['Okay.', 'Uh huh.', 'Got it.']);
  });

  test('a card number half that arrives late is scrubbed with its own neighbors, not the newest rows', async () => {
    await live.recordLiveTranscriptionEvent(content(2, 'inbound_track', '4242 4242', 1));
    for (let i = 0; i < 6; i += 1) {
      await live.recordLiveTranscriptionEvent(content(10 + i, 'outbound_track', `Line ${i}`, 10 + i));
    }
    // The second half was spoken at 2 s but its callback lands after six later lines.
    await live.recordLiveTranscriptionEvent(content(3, 'inbound_track', '4242 4242', 2));
    const caller = db.__state.utterances.filter((u) => u.speaker === 'caller');
    expect(caller.map((u) => u.text).join(' ')).not.toMatch(/4242 4242/);
    expect(caller.every((u) => u.pan_masked)).toBe(true);
  });

  test('a code read after a staff question is still masked (the same speaker\'s masked line is the link)', async () => {
    await live.recordLiveTranscriptionEvent(content(2, 'inbound_track', '4242 4242 4242 4242', 1));
    await live.recordLiveTranscriptionEvent(content(3, 'outbound_track', 'And the security code?', 4));
    await live.recordLiveTranscriptionEvent(content(4, 'inbound_track', '123', 7));
    expect(db.__state.utterances.map((u) => u.text)).toEqual(['[card ending 4242]', 'And the security code?', '[code removed]']);
    // The staff line itself is not a code tail: its speaker never said the card.
    expect(db.__state.utterances[1].pan_masked).toBe(false);
  });

  test('started / stopped / error events stamp the call; unknown events are ignored', async () => {
    await live.recordLiveTranscriptionEvent({ CallSid: CALL, TranscriptionEvent: 'transcription-started', Timestamp: '2026-11-16T15:00:00Z' });
    await live.recordLiveTranscriptionEvent({ CallSid: CALL, TranscriptionEvent: 'transcription-error', TranscriptionErrorCode: '32655', TranscriptionError: 'Provider Unavailable' });
    await live.recordLiveTranscriptionEvent({ CallSid: CALL, TranscriptionEvent: 'transcription-stopped', Timestamp: '2026-11-16T15:05:00Z' });
    const patches = db.__state.stamps.map((s) => JSON.parse(s.bindings[0]));
    expect(patches[0]).toEqual({ live_at: '2026-11-16T15:00:00.000Z' });
    expect(patches[1]).toMatchObject({ event_error_code: '32655', event_error: 'Provider Unavailable' });
    expect(patches[2]).toEqual({ stopped_at: '2026-11-16T15:05:00.000Z' });
    await expect(live.recordLiveTranscriptionEvent({ CallSid: CALL, TranscriptionEvent: 'other' })).resolves.toMatchObject({ reason: 'ignored_event' });
  });
});

describe('purgeLiveUtterances', () => {
  test('drops every live utterance of the call', async () => {
    db.__state.claimed.add(CALL);
    await live.recordLiveTranscriptionEvent(content(2, 'inbound_track', 'hello', 1));
    await expect(live.purgeLiveUtterances(CALL)).resolves.toBe(1);
    expect(db.__state.utterances).toHaveLength(0);
    await expect(live.purgeLiveUtterances('not-a-sid')).resolves.toBe(0);
  });

  test('takes the writer lock and stamps the call, so a late callback or a redelivery stores nothing', async () => {
    db.__state.claimed.add(CALL);
    await live.recordLiveTranscriptionEvent(content(2, 'inbound_track', 'hello', 1));
    db.__state.rawCalls = [];
    await live.purgeLiveUtterances(CALL);
    expect(db.__state.rawCalls[0]).toMatch(/pg_advisory_xact_lock/);
    expect(JSON.parse(db.__state.stamps.at(-1).bindings[0])).toHaveProperty('quarantined_at');
    await expect(live.recordLiveTranscriptionEvent(content(3, 'inbound_track', 'one more line', 5))).resolves.toEqual({ stored: false, reason: 'quarantined' });
    await expect(live.recordLiveTranscriptionEvent(content(2, 'inbound_track', 'hello', 1))).resolves.toEqual({ stored: false, reason: 'quarantined' });
    expect(db.__state.utterances).toHaveLength(0);
  });

  test('a purge that failed is retried by the 5-minute sweep; a call without a flagged scrub keeps its text', async () => {
    db.__state.claimed.add(CALL);
    db.__state.claimed.add(OTHER);
    await live.recordLiveTranscriptionEvent(content(2, 'inbound_track', 'hello', 1));
    await live.recordLiveTranscriptionEvent({ ...content(3, 'inbound_track', 'other call', 2), CallSid: OTHER });
    db.__state.panDetected.add(CALL); // the recording scrub flagged CALL, and its purge failed
    await expect(live.purgeQuarantinedLiveText()).resolves.toEqual({ purged: 1 });
    expect(db.__state.sweepBindings).toEqual(['voice_relay_sandbox', 25]); // sandbox calls stay out
    expect(db.__state.utterances.map((u) => u.call_sid)).toEqual([OTHER]);
    db.raw.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('db down'), { code: '57P01' })));
    await expect(live.purgeQuarantinedLiveText()).resolves.toEqual({ purged: 0 });
  });

  test('a call the recording scrub flagged (pan_detected) stores no live text', async () => {
    db.__state.claimed.add(CALL);
    db.__state.panDetected.add(CALL);
    await expect(live.recordLiveTranscriptionEvent(content(2, 'inbound_track', 'hello', 1))).resolves.toEqual({ stored: false, reason: 'quarantined' });
    expect(db.__state.utterances).toHaveLength(0);
  });
});
