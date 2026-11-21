/**
 * GPT-Live trial bridge (GATE_VOICE_GPT_LIVE_TEST): Twilio Media Streams on
 * one side, an OpenAI GPT-Live socket on the other. Both sockets, the clock,
 * and the database are fakes: no network, no paid call.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { EventEmitter } = require('events');
const logger = require('../services/logger');
const bridgeMod = require('../services/voice-agent/live-bridge');
const { OPENAI_VOICE_LIVE } = require('../config/models');

const { runLiveBridge, DELEGATION_REPLY } = bridgeMod;
const CALL_SID = 'CA-live-1';
const STREAM_SID = 'MZ-live-1';

class FakeSocket extends EventEmitter {
  constructor({ onSend } = {}) {
    super();
    this.readyState = 1;
    this.sent = [];
    this.onSend = onSend;
    this.close = jest.fn(() => { this.readyState = 3; });
    this.terminate = jest.fn(() => { this.readyState = 3; });
  }

  send(raw) {
    const msg = JSON.parse(raw);
    this.sent.push(msg);
    if (this.onSend) this.onSend(msg, this);
  }

  receive(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }

  types() { return this.sent.map((m) => m.type || m.event); }
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
// Wait for an event, not a fixed wall-clock gap: a loaded machine can run a
// 25 ms timer far later than 70 ms.
const waitFor = async (cond, ms = 10000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  await flush();
};
// mu-law 0x00 decodes to about -32124: voiced. 0xFF is digital silence.
const b64 = (bytes) => Buffer.alloc(bytes, 0x00).toString('base64');
const silence = (bytes) => Buffer.alloc(bytes, 0xff).toString('base64');

function setup({ closeReply = true, deps = {} } = {}) {
  let clock = 1_000_000;
  const twilio = new FakeSocket();
  const openai = new FakeSocket({
    onSend: (msg, self) => {
      if (closeReply && msg.type === 'session.close') {
        setImmediate(() => self.receive({ type: 'session.closed', reason: 'close_requested', session: {}, usage: { seconds: 45 } }));
      }
    },
  });
  const update = jest.fn().mockResolvedValue(1); // call_log
  const where = jest.fn(() => ({ update }));
  const ledgerUpdate = jest.fn().mockResolvedValue(1); // voice_gpt_live_ledger
  const ledgerWhere = jest.fn(() => ({ update: ledgerUpdate }));
  const db = jest.fn((table) => (table === 'voice_gpt_live_ledger' ? { where: ledgerWhere } : { where }));
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  const openaiFactory = jest.fn(() => openai);
  const admit = jest.fn(async () => true);
  const bridge = runLiveBridge(twilio, { callSid: CALL_SID, voice: 'marin', cell: '71' }, {
    openaiFactory,
    now: () => clock,
    admit,
    buildInstructions: () => 'INSTRUCTIONS',
    greeting: () => 'Waves, this is Sandy.',
    db: () => db,
    apiKey: () => 'sk-test',
    ...deps,
  });
  return {
    twilio, openai, bridge, update, where, ledgerUpdate, ledgerWhere, db, openaiFactory, admit,
    advance: (ms) => { clock += ms; },
    tick: () => clock,
    // OpenAI opens after the reservation is admitted (async), so wait it out.
    twilioStart: async (callSid = CALL_SID) => {
      twilio.emit('message', JSON.stringify({ event: 'start', start: { callSid, streamSid: STREAM_SID } }));
      await flush();
    },
    twilioMedia: (payload = 'AAAA') => twilio.emit('message', JSON.stringify({ event: 'media', media: { track: 'inbound', payload } })),
    twilioStop: () => twilio.emit('message', JSON.stringify({ event: 'stop' })),
    ready: async () => {
      twilio.emit('message', JSON.stringify({ event: 'start', start: { callSid: CALL_SID, streamSid: STREAM_SID } }));
      await flush();
      openai.emit('open');
      openai.receive({ type: 'session.started', session: { id: 's1' } });
      await flush();
    },
  };
}

const summaryOf = (t) => JSON.parse(t.db.raw.mock.calls[0][1][0]);
// Wait until the bridge has fully finalized (summary written or skipped).
const finalized = async (t) => {
  await waitFor(() => Boolean(t.bridge._finalizing));
  await t.bridge._finalizing;
};

beforeEach(() => jest.clearAllMocks());

describe('session setup and caller audio', () => {
  test('opens the OpenAI socket on start and sends session.start with the model, voice, client delegation and no storage', async () => {
    const t = setup();
    await t.twilioStart();
    expect(t.openaiFactory).toHaveBeenCalledWith({ url: 'wss://api.openai.com/v1/live/sessions', headers: { Authorization: 'Bearer sk-test' } });
    t.openai.emit('open');
    const msg = t.openai.sent[0];
    expect(msg.type).toBe('session.start');
    expect(msg.session).toMatchObject({
      model: OPENAI_VOICE_LIVE,
      instructions: 'INSTRUCTIONS',
      audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: 'marin' } },
      store: false,
    });
    // client: delegations come to the bridge, never to OpenAI's paid Responses backend
    expect(msg.session.delegation).toEqual({ type: 'client' });
  });

  test('caller audio before session.started is held and forwarded in order after the greeting; later audio goes straight through', async () => {
    const t = setup();
    t.twilioMedia('EARLY'); // before even the start frame
    await t.twilioStart();
    t.openai.emit('open');
    t.twilioMedia('BEFORE');
    expect(t.openai.types()).toEqual(['session.start']); // nothing sent before the session is up
    t.openai.receive({ type: 'session.started', session: { id: 's1' } });
    await flush();
    t.twilioMedia('AFTER');
    expect(t.openai.types()).toEqual(['session.start', 'session.commentary.append', 'session.input_audio.append', 'session.input_audio.append', 'session.input_audio.append']);
    expect(t.openai.sent.filter((m) => m.audio).map((m) => m.audio)).toEqual(['EARLY', 'BEFORE', 'AFTER']);
  });

  test('the held opening audio keeps only the latest 150 frames (3 s)', async () => {
    const t = setup();
    await t.twilioStart();
    t.openai.emit('open');
    for (let i = 0; i < 160; i++) t.twilioMedia(`F${i}`);
    t.openai.receive({ type: 'session.started', session: { id: 's1' } });
    await flush();
    const held = t.openai.sent.filter((m) => m.audio).map((m) => m.audio);
    expect(held).toHaveLength(150);
    expect(held[0]).toBe('F10');
    expect(held[149]).toBe('F159');
  });

  test('session.started sends the greeting as commentary', async () => {
    const t = setup();
    await t.ready();
    expect(t.openai.sent).toContainEqual({ type: 'session.commentary.append', delegation_id: null, content: 'Waves, this is Sandy.' });
  });

  test('a start frame for another CallSid closes the call and never opens OpenAI', async () => {
    const t = setup();
    await t.twilioStart('CA-someone-else');
    await flush();
    expect(t.openaiFactory).not.toHaveBeenCalled();
    expect(t.twilio.close).toHaveBeenCalled();
    expect(t.update).toHaveBeenCalledTimes(1);
    expect(summaryOf(t)).toMatchObject({ close_reason: 'callsid_mismatch', openai_contacted: false, cost_usd: 0 });
  });

  test('a start frame with no streamSid closes the call and never opens OpenAI; a later good start changes nothing', async () => {
    const t = setup();
    t.twilio.emit('message', JSON.stringify({ event: 'start', start: { callSid: CALL_SID } }));
    await t.twilioStart();
    await flush();
    expect(t.openaiFactory).not.toHaveBeenCalled();
    expect(t.twilio.close).toHaveBeenCalled();
    expect(summaryOf(t).close_reason).toBe('no_stream_sid');
  });

  test('a second start frame never opens a second paid session', async () => {
    const t = setup();
    await t.twilioStart();
    await t.twilioStart();
    await flush();
    expect(t.openaiFactory).toHaveBeenCalledTimes(1);
  });

  test('an error before session.started is a refused start: the call ends', async () => {
    const t = setup();
    await t.twilioStart();
    t.openai.emit('open');
    t.openai.receive({ type: 'error', error: { code: 'unknown_parameter', type: 'invalid_request_error' } });
    await flush();
    expect(t.twilio.close).toHaveBeenCalled();
    const s = summaryOf(t);
    expect(s.errors).toContain('unknown_parameter:invalid_request_error');
  });

  test('an error after session.started (a rejected command) is nonfatal', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive({ type: 'error', error: { code: 'unknown_parameter', type: 'invalid_request_error' } });
    await flush();
    expect(t.twilio.close).not.toHaveBeenCalled();
    expect(t.update).not.toHaveBeenCalled();
  });

  test('no session.started within the deadline ends the call instead of leaving a silent line', async () => {
    const t = setup({ deps: { startDeadlineMs: 20 } });
    await t.twilioStart();
    t.openai.emit('open');
    await waitFor(() => t.update.mock.calls.length > 0);
    expect(t.twilio.close).toHaveBeenCalled();
    expect(summaryOf(t).errors).toContain('start_timeout');
  });

  test('a missing OPENAI_API_KEY closes the call instead of opening a socket', async () => {
    const t = setup({ deps: { apiKey: () => '' } });
    await t.twilioStart();
    await flush();
    expect(t.openaiFactory).not.toHaveBeenCalled();
    expect(t.twilio.close).toHaveBeenCalled();
    // OpenAI was never contacted: the call settles at zero and frees its reservation
    const s = summaryOf(t);
    expect(s).toMatchObject({ openai_contacted: false, usage_seconds: 0, cost_usd: 0 });
    expect(s.errors).not.toContain('usage_unconfirmed');
    expect(t.ledgerUpdate).toHaveBeenCalledWith({ cost_usd: 0, settled_at: expect.any(Date) }); // frees the reservation
  });

  test('an OpenAI connection that fails before session.start left (DNS, TLS, HTTP) settles at zero', async () => {
    const t = setup();
    await t.twilioStart();
    t.openai.emit('error', Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }));
    await waitFor(() => t.update.mock.calls.length > 0);
    expect(t.openai.sent).toEqual([]); // session.start never left
    expect(summaryOf(t)).toMatchObject({ openai_contacted: false, usage_seconds: 0, cost_usd: 0 });
    expect(t.ledgerUpdate).toHaveBeenCalledWith({ cost_usd: 0, settled_at: expect.any(Date) });
  });

  test('a socket that throws at construction ends the call, settled at zero, without an uncaught error', async () => {
    const t = setup({ deps: { openaiFactory: () => { throw new Error('bad url'); } } });
    await t.twilioStart();
    await flush();
    expect(t.twilio.close).toHaveBeenCalled();
    const s = summaryOf(t);
    expect(s).toMatchObject({ openai_contacted: false, cost_usd: 0, close_reason: 'socket_open_failed' });
  });
});

describe('model audio, barge-in and latency', () => {
  test('each output delta goes to Twilio at once, on the stream', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) });
    expect(t.twilio.sent).toContainEqual({ event: 'media', streamSid: STREAM_SID, media: { payload: b64(160) } });
  });

  test('caller speech that runs into a reply still queued flushes Twilio and counts one interruption', async () => {
    const t = setup();
    await t.ready();
    t.twilioMedia(); // session audio time 0 = now
    t.advance(1000);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(8000) }); // reply starts at +1000, 1000 ms queued
    t.advance(600);
    // the caller talks from +1300 to +1500, well inside the reply
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'wait', start_ms: 1300, end_ms: 1500 });
    expect(t.twilio.sent).toContainEqual({ event: 'clear', streamSid: STREAM_SID });
    // playback was reset: a second delta now finds nothing queued
    t.openai.receive({ type: 'session.input_transcript.delta', delta: ' hold on', start_ms: 1500, end_ms: 1600 });
    expect(t.twilio.sent.filter((m) => m.event === 'clear')).toHaveLength(1);
    t.twilioStop();
    await flush();
    expect(summaryOf(t).interruptions).toBe(1);
  });

  // A reply as OpenAI streams it: `count` 200 ms audio chunks, 100 ms apart.
  const streamReply = (t, count) => {
    for (let i = 0; i < count; i++) {
      if (i > 0) t.advance(100);
      t.openai.receive({ type: 'session.output_audio.delta', delta: b64(1600) });
    }
  };

  test('after a barge-in, the cut-off reply\'s tail never reaches Twilio; the next reply inside the tail window plays and is timed apart', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0
    t.twilioMedia();
    t.advance(1000);
    streamReply(t, 6); // a reply streams +1000..+1500, plays to +2200
    t.advance(100);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'wait', start_ms: 1300, end_ms: 1500 }); // barge-in at +1600
    t.advance(50);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(320) }); // the old reply's tail, no gap
    t.advance(50);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(320) }); // more tail
    t.advance(900);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // the real next reply at +2600
    t.twilioStop();
    await flush();
    const payloads = t.twilio.sent.filter((m) => m.event === 'media').map((m) => m.media.payload);
    expect(payloads).not.toContain(b64(320)); // no restart mid-sentence
    expect(payloads.filter((p) => p === b64(160))).toHaveLength(2); // the greeting and the next reply
    // +2600 is 1000 ms after the barge-in, inside the 1.5 s tail window: a gap
    // there may be a stalled tail, so the delay is kept apart from turns
    expect(summaryOf(t)).toMatchObject({ turns: [], after_barge_in_ambiguous_ms: [1100] });
  });

  test('a reply right after a barge-in (the old one already streamed) is played, not dropped as tail, and timed apart', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0
    t.twilioMedia();
    t.advance(1000);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(8000) }); // whole reply at +1000, plays to +2000
    t.advance(600);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'wait', start_ms: 1300, end_ms: 1500 }); // clear at +1600
    t.advance(200);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(240) }); // a new reply 200 ms after the clear
    t.twilioStop();
    await flush();
    expect(t.twilio.sent.some((m) => m.event === 'media' && m.media.payload === b64(240))).toBe(true);
    expect(summaryOf(t)).toMatchObject({ turns: [], after_barge_in_ambiguous_ms: [300] }); // +1800 minus +1500
  });

  test('a final transcript fragment that lands after an ambiguous reply began refines that sample, never turns', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0
    t.twilioMedia();
    t.advance(1000);
    streamReply(t, 6); // a reply streams +1000..+1500
    t.advance(100);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'wait', start_ms: 1300, end_ms: 1500 }); // barge-in at +1600
    t.advance(600);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // ambiguous reply at +2200: 700 provisional
    t.advance(100);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'hold on', start_ms: 1500, end_ms: 1900 }); // the final fragment
    t.twilioStop();
    await flush();
    const s = summaryOf(t);
    expect(s.after_barge_in_ambiguous_ms).toEqual([300]); // +2200 minus the real speech end +1900
    expect(s.turns).toEqual([]);
  });

  test('two gaps inside one barge-in window, with a transcript fragment between them, are both kept apart from turns', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0
    t.twilioMedia();
    t.advance(1000);
    streamReply(t, 6); // a reply streams +1000..+1500
    t.advance(100);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'wait', start_ms: 1300, end_ms: 1500 }); // barge-in at +1600
    t.advance(400);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // first gap at +2000
    t.advance(200);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'no', start_ms: 2050, end_ms: 2150 });
    t.advance(400);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // second gap at +2600, still inside +3100
    t.twilioStop();
    await flush();
    const s = summaryOf(t);
    expect(s.turns).toEqual([]);
    expect(s.after_barge_in_ambiguous_ms).toEqual([500, 450]);
  });

  test('a tail chunk delayed past the gap by a network stall is never timed into turns; a later reply outside the window is', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0
    t.twilioMedia();
    t.advance(1000);
    streamReply(t, 6); // a reply streams +1000..+1500
    t.advance(100);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'wait', start_ms: 1300, end_ms: 1500 }); // barge-in at +1600
    t.advance(400);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(320) }); // stalled tail at +2000: ambiguous
    t.advance(1000);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'what about ants', start_ms: 2600, end_ms: 2800 });
    t.advance(500);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // a real reply at +3500
    t.twilioStop();
    await flush();
    const s = summaryOf(t);
    expect(s.after_barge_in_ambiguous_ms).toEqual([500]); // +2000 minus +1500, labelled ambiguous
    expect(s.turns).toEqual([700]); // +3500 minus +2800
  });

  test('a fast reply that starts right as the last one finishes playing is timed', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0
    t.twilioMedia();
    t.advance(1000);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(8000) }); // reply at +1000, plays to +2000
    t.advance(960);
    // the caller's short answer over the end of it: ends at +1950, too late to cut anything
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'yes', start_ms: 1700, end_ms: 1950 });
    t.advance(140);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // next reply at +2100
    t.twilioStop();
    await flush();
    expect(t.twilio.sent.filter((m) => m.event === 'clear')).toHaveLength(0);
    expect(summaryOf(t).turns).toEqual([150]);
  });

  test('a cut-off reply that keeps streaming is dropped for TAIL_DROP_MAX_MS at the most', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0
    t.twilioMedia();
    t.advance(1000);
    streamReply(t, 6); // +1000..+1500
    t.advance(100);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'wait', start_ms: 1300, end_ms: 1500 }); // clear at +1600
    for (let i = 0; i < 20; i++) {
      t.advance(100);
      t.openai.receive({ type: 'session.output_audio.delta', delta: b64(80) }); // the stream goes on with no gap
    }
    const sent = t.twilio.sent.filter((m) => m.event === 'media' && m.media.payload === b64(80));
    expect(sent.length).toBe(6); // dropped through +3000 (1500 ms), sent from +3100 on
  });

  test('a caller transcript with no playback queued sends no clear', async () => {
    const t = setup();
    await t.ready();
    t.twilioMedia();
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'hello', start_ms: 0, end_ms: 400 });
    expect(t.twilio.sent.some((m) => m.event === 'clear')).toBe(false);
  });

  test('a delta with only the last 200 ms of playback left is not a barge-in', async () => {
    const t = setup();
    await t.ready();
    t.twilioMedia();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(8000) });
    t.advance(900); // 100 ms left
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'yes', start_ms: 700, end_ms: 850 });
    expect(t.twilio.sent.some((m) => m.event === 'clear')).toBe(false);
  });

  test('a late transcript of words the caller finished before the reply began is not a barge-in: the answer keeps playing', async () => {
    const t = setup();
    await t.ready();
    t.twilioMedia();
    t.advance(2000);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(8000) }); // reply starts at +2000, 1000 ms queued
    t.advance(300);
    // transcription lag: the caller's last words ended at +1900, before the reply
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'next week', start_ms: 1500, end_ms: 1900 });
    expect(t.twilio.sent.some((m) => m.event === 'clear')).toBe(false);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) });
    expect(t.twilio.sent.filter((m) => m.event === 'media')).toHaveLength(2);
    t.twilioStop();
    await flush();
    expect(summaryOf(t).interruptions).toBe(0);
  });

  test('a caller transcript without timing never flushes', async () => {
    const t = setup();
    await t.ready();
    t.twilioMedia();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(8000) });
    t.advance(300);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'stop' });
    expect(t.twilio.sent.some((m) => m.event === 'clear')).toBe(false);
  });

  test('reply delay is the first output delta minus the end of the caller speech; the greeting records none', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting: no turn yet
    t.advance(5000);
    t.twilioMedia();
    t.advance(1500);
    // session time counts from session.started (t0): speech ended at t0 + 6200
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'when can you come', start_ms: 5000, end_ms: 6200 });
    t.advance(900); // now t0 + 7400: 1200 ms
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) });
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // only the first counts
    t.twilioStop();
    await flush();
    const s = summaryOf(t);
    expect(s.turns).toEqual([1200]);
    expect(s.latency_p50_ms).toBe(1200);
    expect(s.latency_max_ms).toBe(1200);
  });

  test('a transcript that arrives after the reply began times that reply, and never the next one', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0
    t.twilioMedia();
    t.advance(2000);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // a short reply starts at t0 + 2000
    t.advance(500);
    // speech that ended at t0 + 1900: its transcript arrives after the reply began
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'thanks', start_ms: 1500, end_ms: 1900 });
    t.advance(3000);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // the model speaks again, unprompted
    t.twilioStop();
    await flush();
    expect(summaryOf(t).turns).toEqual([100]);
  });

  test('a later fragment of the same speech moves the sample to the true end of speech', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0
    t.twilioMedia();
    t.advance(1600);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'I need', start_ms: 1000, end_ms: 1500 }); // before the reply
    t.advance(400);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // reply at t0 + 2000: 500 so far
    t.advance(100);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: ' pest control', start_ms: 1500, end_ms: 1900 }); // late
    t.twilioStop();
    await flush();
    expect(summaryOf(t).turns).toEqual([100]);
  });

  test('caller speaks first: the first reply (greeting or answer) is kept apart as first_reply_ambiguous_ms, never in turns', async () => {
    const t = setup();
    await t.ready();
    t.advance(2000);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'hi, do you do termites', start_ms: 300, end_ms: 1500 });
    t.advance(400); // first output audio at t0 + 2400: 900 ms after the speech ended
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) });
    t.twilioStop();
    await flush();
    const s = summaryOf(t);
    expect(s.turns).toEqual([]);
    expect(s.first_reply_ambiguous_ms).toBe(900);
  });

  test('caller speaks first but the transcript lands after the first reply began: first_reply_ambiguous_ms still records it', async () => {
    const t = setup();
    await t.ready();
    t.advance(2400);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // first reply at t0 + 2400
    t.advance(300);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'hi, do you do termites', start_ms: 300, end_ms: 1500 });
    t.twilioStop();
    await flush();
    const s = summaryOf(t);
    expect(s.turns).toEqual([]);
    expect(s.first_reply_ambiguous_ms).toBe(900);
  });

  test('a transcript that arrives before the greeting\'s first audio never times the greeting', async () => {
    const t = setup();
    await t.ready();
    t.advance(300);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'hello?', start_ms: 100, end_ms: 250 });
    t.advance(500);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0 + 800
    t.twilioStop();
    await flush();
    expect(summaryOf(t).turns).toEqual([]);
  });

  test('speech before the greeting never times the greeting', async () => {
    const t = setup();
    await t.ready();
    t.advance(800);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0 + 800
    t.advance(200);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'hello?', start_ms: 100, end_ms: 500 });
    t.twilioStop();
    await flush();
    expect(summaryOf(t).turns).toEqual([]);
  });

  test('a late first caller packet does not shift speech timing: it counts from session.started', async () => {
    const t = setup();
    await t.ready(); // session time 0 = t0
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting
    t.advance(3000);
    t.twilioMedia(); // the first packet arrives 3 s late
    t.advance(1000);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'hi', start_ms: 3500, end_ms: 3900 });
    t.advance(500); // now t0 + 4500; speech ended at t0 + 3900
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) });
    t.twilioStop();
    await flush();
    expect(summaryOf(t).turns).toEqual([600]);
  });

  test('a caller transcript that lands while the model is already talking times the reply from the speech end, never near zero', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0
    t.twilioMedia();
    t.advance(2000);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(8000) }); // reply starts: 1000 ms queued
    t.advance(100);
    // a late transcript of the caller's last words, 100 ms into the reply
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'okay', start_ms: 1500, end_ms: 1900 });
    t.advance(20);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // mid-reply delta: no turn
    t.twilioStop();
    await flush();
    expect(summaryOf(t).turns).toEqual([100]); // t0 + 2000 minus t0 + 1900, not the 20 ms to the mid-reply delta
  });
});

describe('reply start on the continuous GPT-Live stream', () => {
  const delta = (t, payload) => t.openai.receive({ type: 'session.output_audio.delta', delta: payload });
  // The live API's pacing: one 100 ms chunk (800 bytes) every 100 ms.
  const run = (t, chunks, payload) => {
    for (let i = 0; i < chunks; i++) {
      delta(t, payload);
      t.advance(100);
    }
  };
  const said = (t, text, startMs, endMs) => t.openai.receive({ type: 'session.input_transcript.delta', delta: text, start_ms: startMs, end_ms: endMs });
  const mediaPayloads = (t) => t.twilio.sent.filter((m) => m.event === 'media').map((m) => m.media.payload);
  const silenceThenVoice = (silentMs, voiceBytes = 800) => Buffer.concat([Buffer.alloc(silentMs * 8, 0xff), Buffer.alloc(voiceBytes, 0x00)]).toString('base64');
  const voiceThenSilence = (silentMs) => Buffer.concat([Buffer.alloc(800, 0x00), Buffer.alloc(silentMs * 8, 0xff)]).toString('base64');
  const start = async () => {
    const t = setup();
    await t.ready();
    t.twilioMedia();
    return t;
  };
  const end = async (t) => {
    t.twilioStop();
    await flush();
    return summaryOf(t);
  };

  test('a continuous stream of silent chunks with voice in it: the greeting is no turn, the reply after the caller is timed from its first voiced chunk', async () => {
    const t = await start();
    run(t, 7, silence(800)); // +0..+700 silence from session.started
    run(t, 15, b64(800)); // greeting voice +700..+2200
    run(t, 8, silence(800)); // +2200..+3000
    said(t, 'when can you come', 2300, 2900); // the caller spoke +2300..+2900 (end_ms counts from session.started)
    run(t, 12, silence(800)); // +3000..+4200
    delta(t, b64(800)); // the reply's voice begins at +4200
    const s = await end(t);
    expect(s.turns).toEqual([1300]);
    expect(s.interruptions).toBe(0);
    expect(s.first_reply_ambiguous_ms == null).toBe(true);
    expect(mediaPayloads(t)).toHaveLength(43); // every chunk, silent or voiced, reached Twilio
  });

  test('a pause under 600 ms of silent audio inside an utterance is no new reply; 600 ms or more is', async () => {
    const t = await start();
    delta(t, b64(160)); // greeting
    run(t, 10, silence(800));
    said(t, 'first question', 100, 400);
    run(t, 5, silence(800)); // +1000..+1500
    delta(t, b64(800)); // reply 1 begins at +1500
    t.advance(100);
    said(t, 'and', 1700, 1900); // arms the next measure
    run(t, 5, silence(800)); // 500 ms pause inside the reply
    delta(t, b64(800)); // voice resumes: the same reply
    t.advance(100);
    expect(t.bridge.latencies).toHaveLength(1); // the pause did not start a reply
    run(t, 6, silence(800)); // 600 ms of silent audio
    delta(t, b64(800)); // a new reply
    expect((await end(t)).turns).toHaveLength(2);
  });

  test('silence at the end of one voiced chunk and at the start of the next counts toward the 600 ms', async () => {
    const t = await start();
    delta(t, b64(160)); // greeting
    t.advance(100);
    said(t, 'first question', 20, 60);
    // Four chunks of about 400 ms, 100 ms apart (no arrival gap): Twilio plays them back to back from +100.
    delta(t, voiceThenSilence(290)); // the same reply, then 290 ms silent: queued until +490
    t.advance(100);
    delta(t, silenceThenVoice(300)); // 590 ms of silence in all: still the same reply; queued until +890
    expect(t.bridge.latencies).toHaveLength(0);
    t.advance(100);
    delta(t, voiceThenSilence(300)); // queued until +1290
    t.advance(100);
    delta(t, silenceThenVoice(300)); // 600 ms of silence in all: a new reply, voiced 300 ms into its chunk
    expect((await end(t)).turns).toEqual([1530]); // the caller hears it at +1590; speech ended +60
  });

  test('one chunk that holds the end of a reply, 600 ms of silence and the next reply: the next reply is timed from its own first voiced sample', async () => {
    const mixed = Buffer.concat([Buffer.alloc(800, 0x00), Buffer.alloc(4800, 0xff), Buffer.alloc(800, 0x00)]).toString('base64');
    const t = await start();
    delta(t, b64(160)); // greeting
    said(t, 'hello', 10, 60);
    t.advance(100);
    delta(t, mixed); // at +100: 100 ms more greeting, 600 ms silent, the reply's voice at +800
    expect((await end(t)).turns).toEqual([740]);
    expect(mediaPayloads(t)).toContain(mixed);
  });

  test('an arrival gap still starts a new reply when no silent audio came between', async () => {
    const t = await start();
    delta(t, b64(160)); // greeting
    t.advance(500);
    said(t, 'hello', 100, 500);
    t.advance(500);
    delta(t, b64(160)); // 1000 ms after the greeting chunk: a gap, so a new reply
    expect((await end(t)).turns).toEqual([500]);
  });

  describe('the delay runs to when the caller hears the reply', () => {
    test('a voiced chunk with leading silence: the delay includes the offset of the voice inside the chunk', async () => {
      const t = await start();
      delta(t, b64(160)); // greeting
      t.advance(500);
      said(t, 'hello there', 100, 500);
      t.advance(1500); // +2000
      delta(t, silenceThenVoice(200)); // 200 ms silent, then voice
      expect((await end(t)).turns).toEqual([1700]); // voice at +2200, speech ended +500
    });

    test('a reply that arrives in a burst behind queued silence is timed to when the caller hears it', async () => {
      const t = await start();
      delta(t, b64(160)); // greeting
      run(t, 10, silence(800)); // paced silence, +0..+1000
      said(t, 'hello', 300, 700);
      t.advance(400); // a 400 ms network stall, then three chunks at once at +1400
      delta(t, silence(800));
      delta(t, silence(800));
      delta(t, b64(800)); // the reply: it arrives at +1400 and plays after the 200 ms of silence ahead of it
      expect((await end(t)).turns).toEqual([900]); // heard at +1600, speech ended +700
    });

    test('a late transcript times a reply queued behind silence to when the caller heard it', async () => {
      const t = await start();
      delta(t, b64(160)); // greeting
      t.advance(1000);
      delta(t, silence(1600)); // one burst at +1000: 200 ms of silence...
      delta(t, b64(800)); // ...then a reply, heard from +1200
      t.advance(300);
      said(t, 'hello', 500, 900); // the speech ended before the reply arrived
      expect((await end(t)).turns).toEqual([300]);
    });

    test('a reply right after a barge-in is timed apart, to when the caller hears it', async () => {
      const t = await start();
      delta(t, b64(160)); // greeting
      t.advance(1000);
      delta(t, b64(8000)); // a reply: 1000 ms queued
      t.advance(100);
      said(t, 'wait', 1100, 1300); // barge-in at +1100
      t.advance(500);
      delta(t, silenceThenVoice(200)); // at +1600, after a gap: the next reply's voice is heard from +1800
      expect((await end(t)).after_barge_in_ambiguous_ms).toEqual([500]);
    });

    test('the caller speaks first and the first reply is queued behind silence: first_reply_ambiguous_ms runs to when the caller hears it', async () => {
      const t = await start();
      t.advance(100);
      said(t, 'hello', 10, 50);
      t.advance(200);
      delta(t, silence(1600)); // one burst at +300: 200 ms of silence...
      delta(t, b64(160)); // ...then the first voice, heard from +500
      const s = await end(t);
      expect(s.first_reply_ambiguous_ms).toBe(450);
      expect(s.turns).toEqual([]);
    });
  });

  test('speech that ended after a chunk arrived is not answered by the voice inside that chunk: it times the next reply', async () => {
    const t = await start();
    delta(t, b64(160)); // greeting
    t.advance(1000);
    delta(t, silenceThenVoice(200)); // at +1000: a reply whose voice plays from +1200
    t.advance(300);
    said(t, 'hello', 800, 1100); // ended after that chunk had arrived
    run(t, 7, silence(800)); // +1300..+2000
    delta(t, b64(800)); // the next reply at +2000
    expect((await end(t)).turns).toEqual([900]);
  });

  test('a reply queued behind silence is heard later than it arrives: speech that ended before the caller heard it is no barge-in', async () => {
    const t = await start();
    delta(t, b64(160)); // greeting
    t.advance(1000);
    delta(t, silence(8000)); // one burst at +1000: 1000 ms of silence, queued until +2000...
    delta(t, b64(8000)); // ...then a reply the caller hears from +2000
    t.advance(300);
    said(t, 'hello', 1100, 1300);
    expect(t.twilio.sent.some((m) => m.event === 'clear')).toBe(false); // the answer is not cut before it is heard
    t.advance(1000);
    said(t, ' are you there', 1300, 2300);
    expect(t.twilio.sent.filter((m) => m.event === 'clear')).toHaveLength(1); // speech over the reply as heard
  });

  test('caller speech over evenly paced voice: under 200 ms is queued, so nothing is flushed or dropped', async () => {
    const t = await start();
    delta(t, b64(160)); // greeting
    t.advance(1000);
    run(t, 10, b64(800)); // a reply at the live pacing, +1000..+2000: 100 ms queued at the most
    said(t, 'wait', 1500, 1900); // at +2000, over the reply
    run(t, 3, b64(800)); // the model is still speaking
    expect(t.twilio.sent.some((m) => m.event === 'clear')).toBe(false);
    expect(mediaPayloads(t).filter((p) => p === b64(800))).toHaveLength(13);
    expect((await end(t)).interruptions).toBe(0);
  });
});

describe('delegation', () => {
  const created = (id, target = 'client') => ({ type: 'session.delegation.created', delegation: { id, target }, offset_ms: 100 });

  test('a client delegation gets the fixed no-lookups answer, spoken, once per delegation', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive(created('d1'));
    t.openai.receive(created('d1')); // the same delegation again: no second answer
    const answers = t.openai.sent.filter((m) => m.type === 'session.commentary.append' && m.delegation_id);
    // spoken to the caller (commentary), never silent context
    expect(answers).toEqual([{ type: 'session.commentary.append', delegation_id: 'd1', content: DELEGATION_REPLY }]);
    expect(DELEGATION_REPLY).toMatch(/can't look that up on this test line/);
    expect(DELEGATION_REPLY).toMatch(/call or text the Waves office/);
    t.twilioStop();
    await flush();
    expect(summaryOf(t).delegations).toBe(1);
  });

  test('a delegation to any other target (paid backend work) ends the call', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive(created('d2', 'responses'));
    await flush();
    expect(t.openai.sent.some((m) => m.delegation_id)).toBe(false);
    expect(t.openai.sent.some((m) => m.type === 'session.close')).toBe(true);
    expect(t.twilio.close).toHaveBeenCalled();
    expect(summaryOf(t)).toMatchObject({ close_reason: 'unexpected_delegation', errors: ['unexpected_delegation'] });
  });

  test('a delegation with no id, or one that arrives while the call is closing, gets no answer', async () => {
    const t = setup({ closeReply: false, deps: { closeWaitMs: 5000 } });
    await t.ready();
    t.openai.receive({ type: 'session.delegation.created', delegation: { target: 'client' } });
    t.twilioStop();
    await waitFor(() => t.openai.sent.some((m) => m.type === 'session.close'));
    t.openai.receive(created('d-late'));
    t.openai.receive({ type: 'session.closed', reason: 'close_requested', session: {}, usage: { seconds: 45 } });
    await waitFor(() => t.update.mock.calls.length > 0);
    expect(t.openai.sent.some((m) => m.delegation_id)).toBe(false);
  });
});

describe('finish', () => {
  test('stop AND both socket closes write the summary exactly once, after session.close and the final usage', async () => {
    const t = setup();
    await t.ready();
    t.twilioMedia();
    t.openai.receive({ type: 'session.usage.updated', usage: { seconds: 12 } });
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'Hi, ', start_ms: 0, end_ms: 300 });
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'there', start_ms: 300, end_ms: 600 });
    t.openai.receive({ type: 'session.output_transcript.delta', delta: 'Hello!', start_ms: 700, end_ms: 900 });
    t.twilioStop();
    t.twilio.emit('close');
    await flush(); // OpenAI answers session.close with session.closed, then its socket closes
    t.openai.emit('close');
    await flush();
    expect(t.openai.sent.filter((m) => m.type === 'session.close')).toHaveLength(1);
    expect(t.update).toHaveBeenCalledTimes(1);
    expect(t.where).toHaveBeenCalledWith({ twilio_call_sid: CALL_SID });
    const raw = t.db.raw.mock.calls[0];
    expect(raw[0]).toContain("jsonb_set(COALESCE(metadata, '{}'::jsonb), '{gpt_live}'");
    expect(JSON.parse(raw[1][0])).toEqual({
      usage_seconds: 45, // session.closed wins over the running 12
      usage_confirmed: true,
      cost_usd: 0.0375, // 45 s at $0.05 a minute
      openai_contacted: true,
      close_reason: 'twilio_stop', // why the bridge ended it
      provider_close_reason: 'close_requested', // OpenAI's acknowledgment, kept apart
      turns: [],
      latency_p50_ms: null,
      latency_max_ms: null,
      first_reply_ambiguous_ms: null,
      after_barge_in_ambiguous_ms: [],
      interruptions: 0,
      delegations: 0,
      errors: [],
    }); // no call words: the owner hears the calls himself
    expect(t.twilio.close).toHaveBeenCalled();
  });

  test('a confirmed close settles the cost in the spend ledger, apart from call_log', async () => {
    const t = setup();
    await t.ready();
    t.twilioStop();
    await waitFor(() => t.update.mock.calls.length > 0);
    expect(t.ledgerWhere).toHaveBeenCalledWith({ call_sid: CALL_SID });
    expect(t.ledgerUpdate).toHaveBeenCalledTimes(1);
    expect(t.ledgerUpdate).toHaveBeenCalledWith({ cost_usd: 0.0375, settled_at: expect.any(Date) });
  });

  test('a failed ledger write logs a code only, keeps the reservation, and the call record is still written', async () => {
    const t = setup();
    t.ledgerUpdate.mockRejectedValue(Object.assign(new Error('caller words 4111'), { code: '40001' }));
    await t.ready();
    t.twilioStop();
    await waitFor(() => t.update.mock.calls.length > 0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/ledger settle failed callSid=CA-live-1 code=40001$/));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('4111');
    expect(t.update).toHaveBeenCalledTimes(1);
  });

  test('when session.closed never comes, finalize waits the bound and then writes with the running usage', async () => {
    const t = setup({ closeReply: false, deps: { closeWaitMs: 30 } });
    await t.ready();
    t.openai.receive({ type: 'session.usage.updated', usage: { seconds: 12 } });
    t.twilioStop();
    await waitFor(() => t.update.mock.calls.length > 0);
    expect(t.update).toHaveBeenCalledTimes(1);
    const s = summaryOf(t);
    expect(s.usage_seconds).toBe(12);
    expect(s.close_reason).toBe('twilio_stop');
    // unconfirmed final usage: no settled cost, so the call keeps its full reservation
    expect(s.usage_confirmed).toBe(false);
    expect(s).not.toHaveProperty('cost_usd');
    expect(s.errors).toContain('usage_unconfirmed');
    expect(t.ledgerUpdate).not.toHaveBeenCalled(); // the reservation stands
    // no acknowledgment by the deadline: terminated at once, never a 30 s graceful close
    expect(t.openai.terminate).toHaveBeenCalled();
    expect(t.openai.close).not.toHaveBeenCalled();
  });

  test('a final usage below a running total, or negative, keeps the whole reservation (unsettled)', async () => {
    for (const final of [10, -5]) {
      const t = setup({ closeReply: false, deps: { closeWaitMs: 50 } });
      await t.ready();
      t.openai.receive({ type: 'session.usage.updated', usage: { seconds: 30 } });
      t.openai.receive({ type: 'session.closed', reason: 'expired', session: {}, usage: { seconds: final } });
      await finalized(t);
      const s = summaryOf(t);
      expect(s.usage_confirmed).toBe(false);
      expect(s.usage_seconds).toBe(30); // the highest valid running total
      expect(s).not.toHaveProperty('cost_usd');
      expect(s.errors).toEqual(expect.arrayContaining(['usage_contradicts', 'usage_unconfirmed']));
      expect(t.ledgerUpdate).not.toHaveBeenCalled();
    }
  });

  test('a session OpenAI ends itself (expired) ends the call even while its socket stays open', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive({ type: 'session.closed', reason: 'expired', session: {}, usage: { seconds: 300 } });
    await waitFor(() => t.update.mock.calls.length > 0);
    expect(t.twilio.close).toHaveBeenCalled();
    expect(t.openai.sent.some((m) => m.type === 'session.close')).toBe(false); // already closed: nothing to ask
    const s = summaryOf(t);
    expect(s).toMatchObject({ close_reason: 'provider_closed', provider_close_reason: 'expired', usage_seconds: 300, usage_confirmed: true });
    expect(s.cost_usd).toBe(bridgeMod.callCostUsd(300, 0));
  });

  test('an OpenAI socket close or error closes the Twilio socket', async () => {
    const t = setup();
    await t.ready();
    t.openai.readyState = 3;
    t.openai.emit('close');
    await flush();
    expect(t.twilio.close).toHaveBeenCalled();
    expect(t.update).toHaveBeenCalledTimes(1);
    expect(summaryOf(t).close_reason).toBe('openai_closed');

    const e = setup();
    await e.ready();
    e.openai.readyState = 3;
    e.openai.emit('error', Object.assign(new Error('boom'), { code: 'ECONNRESET' }));
    await flush();
    expect(e.twilio.close).toHaveBeenCalled();
    expect(summaryOf(e).errors).toContain('socket_ECONNRESET');
  });

  test('usage the model never reported falls back to the wall clock, flagged', async () => {
    const t = setup({ closeReply: false, deps: { closeWaitMs: 10 } });
    await t.ready();
    t.advance(42_000);
    t.twilioStop();
    await waitFor(() => t.update.mock.calls.length > 0);
    const s = summaryOf(t);
    expect(s.usage_seconds).toBe(42);
    expect(s.errors).toContain('usage_missing');
  });

  test('the session cap ends the call', async () => {
    const t = setup({ deps: { sessionCapMs: 25 } });
    await t.ready();
    await waitFor(() => t.update.mock.calls.length > 0);
    expect(t.twilio.close).toHaveBeenCalled();
    // the cap stays visible even though OpenAI acknowledged the close
    expect(summaryOf(t)).toMatchObject({ close_reason: 'cap', provider_close_reason: 'close_requested' });
    expect(t.openai.sent.some((m) => m.type === 'session.close')).toBe(true);
  });

  test('error events log the code and type only', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive({ type: 'error', error: { code: 'rate_limit', type: 'server_error', message: 'echoed caller words', param: 'x' } });
    t.twilioStop();
    await flush();
    const logged = JSON.stringify(logger.warn.mock.calls) + JSON.stringify(logger.info.mock.calls) + JSON.stringify(logger.error.mock.calls);
    expect(logged).toContain('rate_limit');
    expect(logged).not.toContain('echoed caller words');
    expect(summaryOf(t).errors).toContain('rate_limit:server_error');
  });

  test('a failed summary write logs a bounded code only, never the error message (it can echo bindings), and never throws', async () => {
    const t = setup();
    const err = Object.assign(new Error('update "call_log" set metadata = my card is 4111 1111 1111 1111'), { code: '22P02' });
    t.update.mockRejectedValue(err);
    await t.ready();
    t.twilioStop();
    await flush();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/summary write failed callSid=CA-live-1 code=22P02$/));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('4111');
  });

  test('the caller\'s words (a card number, a gate code across turns) are never stored or logged', async () => {
    const t = setup();
    await t.ready();
    t.twilioMedia();
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'the gate code is', start_ms: 0, end_ms: 900 });
    t.openai.receive({ type: 'session.output_transcript.delta', delta: 'Okay.', start_ms: 1000, end_ms: 1200 });
    t.openai.receive({ type: 'session.input_transcript.delta', delta: '4 7 1 9, card 4111 1111 1111 1111', start_ms: 1300, end_ms: 2000 });
    t.twilioStop();
    await flush();
    const stored = t.db.raw.mock.calls.map((c) => JSON.stringify(c[1])).join('');
    const logged = JSON.stringify([logger.warn.mock.calls, logger.info.mock.calls, logger.error.mock.calls]);
    for (const text of [stored, logged]) {
      expect(text).not.toMatch(/gate code|4 7 1 9|4111/);
    }
    expect(summaryOf(t)).not.toHaveProperty('transcript');
  });
});

describe('reservation admission', () => {
  test('the bridge claims the ledger row after the handshake, then opens OpenAI', async () => {
    const t = setup();
    await t.ready();
    expect(t.admit).toHaveBeenCalledWith(CALL_SID);
    expect(t.admit.mock.invocationCallOrder[0]).toBeLessThan(t.openaiFactory.mock.invocationCallOrder[0]);
  });

  test('a connected socket that never sends a start frame ends at the start deadline and settles at $0', async () => {
    const t = setup({ deps: { startDeadlineMs: 20, closeWaitMs: 20 } });
    await waitFor(() => t.update.mock.calls.length > 0);
    expect(t.openaiFactory).not.toHaveBeenCalled();
    expect(t.twilio.close).toHaveBeenCalled();
    expect(t.ledgerUpdate).toHaveBeenCalledWith({ cost_usd: 0, settled_at: expect.any(Date) });
    expect(summaryOf(t)).toMatchObject({ close_reason: 'start_timeout', openai_contacted: false });
  });

  test('once shutdown begins (session.close sent), caller audio and a late greeting are no longer sent', async () => {
    const t = setup({ closeReply: false, deps: { closeWaitMs: 50 } });
    await t.ready();
    const done = t.bridge.finalize('cap');
    const closeAt = t.openai.sent.findIndex((m) => m.type === 'session.close');
    expect(closeAt).toBeGreaterThanOrEqual(0);
    t.twilioMedia('BBBB');
    t.openai.receive({ type: 'session.started', session: { id: 's1' } });
    const after = t.openai.sent.slice(closeAt + 1).map((m) => m.type);
    expect(after).not.toContain('session.input_audio.append');
    expect(after).not.toContain('session.commentary.append');
    await done;
  });

  test('a stalled admission ends the call at the start deadline; OpenAI never opens and the ledger is left alone', async () => {
    const t = setup({ deps: { admit: () => new Promise(() => {}), startDeadlineMs: 20, closeWaitMs: 20 } });
    await t.twilioStart();
    await finalized(t);
    expect(t.openaiFactory).not.toHaveBeenCalled();
    expect(t.twilio.close).toHaveBeenCalled();
    expect(t.ledgerUpdate).not.toHaveBeenCalled();
    expect(t.update).not.toHaveBeenCalled(); // not admitted: no summary
  });

  test('an admission that lands after the call ended settles that row at $0 (OpenAI never opened)', async () => {
    let admitNow;
    const admit = () => new Promise((resolve) => { admitNow = resolve; });
    const t = setup({ deps: { admit, startDeadlineMs: 20, closeWaitMs: 20 } });
    await t.twilioStart();
    await finalized(t);
    expect(t.ledgerUpdate).not.toHaveBeenCalled();
    admitNow(true); // the stalled claim finally commits
    await flush();
    expect(t.openaiFactory).not.toHaveBeenCalled();
    expect(t.ledgerUpdate).toHaveBeenCalledWith({ cost_usd: 0, settled_at: expect.any(Date) });
  });

  test('a reservation not admitted (released, settled, or a database error) opens no OpenAI session, leaves the ledger alone and never writes over the call summary', async () => {
    for (const admit of [jest.fn(async () => false), jest.fn(async () => { throw new Error('db down'); })]) {
      const t = setup({ deps: { admit } });
      await t.twilioStart();
      await finalized(t);
      expect(t.openaiFactory).not.toHaveBeenCalled();
      expect(t.twilio.close).toHaveBeenCalled();
      expect(t.ledgerUpdate).not.toHaveBeenCalled();
      expect(t.update).not.toHaveBeenCalled();
    }
  });

  test('admitReservation claims only an unreleased, unsettled, never-admitted row, once', async () => {
    const db = require('../models/db');
    const update = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const chain = { where: jest.fn(() => chain), whereNull: jest.fn(() => chain), update };
    db.mockImplementation(() => chain);
    db.fn = { now: () => 'NOW()' };
    await expect(bridgeMod.admitReservation(CALL_SID)).resolves.toBe(true);
    await expect(bridgeMod.admitReservation(CALL_SID)).resolves.toBe(false);
    expect(db).toHaveBeenCalledWith('voice_gpt_live_ledger');
    expect(chain.where).toHaveBeenCalledWith({ call_sid: CALL_SID });
    expect(chain.whereNull).toHaveBeenCalledWith('admitted_at');
    expect(chain.whereNull).toHaveBeenCalledWith('cost_usd');
    expect(update).toHaveBeenCalledWith({ admitted_at: 'NOW()' });
  });
});

describe('spend cap', () => {
  test('the per-call reservation covers the session cap plus close wait, at the voice price', () => {
    expect(bridgeMod.PER_CALL_RESERVE_USD).toBe(bridgeMod.callCostUsd(630));
    expect(bridgeMod.PER_CALL_RESERVE_USD).toBe(0.525); // 10.5 min at $0.05
  });

  test('a settled cost rounds UP to the ledger\'s $0.0001, so short calls never understate spend', () => {
    expect(bridgeMod.callCostUsd(4)).toBe(0.0034); // $0.00333...
    expect(bridgeMod.callCostUsd(45)).toBe(0.0375); // exact stays exact
    expect(bridgeMod.callCostUsd(0)).toBe(0);
    expect(bridgeMod.callCostUsd(4.2)).toBe(0.0035);
    let ledger = 0;
    for (let i = 0; i < 1000; i++) ledger += bridgeMod.callCostUsd(4);
    expect(ledger).toBeGreaterThanOrEqual((1000 * 4 * 0.05) / 60);
  });

  test('the settled cost is voice time only, however many delegations ran (the bridge answers them)', async () => {
    const t = setup();
    await t.ready();
    for (let i = 1; i <= 30; i++) t.openai.receive({ type: 'session.delegation.created', delegation: { id: `d${i}`, target: 'client' } });
    t.twilioStop();
    await waitFor(() => t.update.mock.calls.length > 0);
    const s = summaryOf(t);
    expect(s.delegations).toBe(30);
    expect(s.cost_usd).toBe(bridgeMod.callCostUsd(45));
    expect(t.openai.sent.some((m) => m.type === 'response.create')).toBe(false);
  });
});

describe('instructions', () => {
  test('are Sandy\'s production prompt plus the trial limits, under 60,000 characters', () => {
    const { buildBasePrompt } = require('../services/voice-agent/relay-conversation');
    const { isContextEnabled } = require('../services/voice-agent/relay-context');
    const text = bridgeMod.buildLiveInstructions();
    expect(text.length).toBeLessThan(bridgeMod.INSTRUCTIONS_MAX_CHARS);
    // Sandy's own prompt builder output is the unchanged prefix.
    expect(text.startsWith(buildBasePrompt(isContextEnabled(), null, { officeOpen: null }))).toBe(true);
    expect(text.endsWith(bridgeMod.TRIAL_LIMITS)).toBe(true);
    expect(bridgeMod.TRIAL_LIMITS.replace(/\s+/g, ' ')).toMatch(/cannot look anything up: no open appointment times, prices, accounts or records\. You cannot book, take a lead, send a text or transfer the call/);
    expect(bridgeMod.TRIAL_LIMITS).toMatch(/call or text the Waves office/);
    expect(bridgeMod.TRIAL_LIMITS).not.toMatch(/will call (them|you) back/);
  });
});
