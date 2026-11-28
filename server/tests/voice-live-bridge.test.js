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

// speech: when the caller speaks, as [from, to] in ms after session.started.
// With it, every clock advance after session.started also delivers the
// caller's audio for that time, as Twilio does: voiced inside a span, silent
// outside it. The bridge reads the reply delay from that audio.
function setup({ closeReply = true, deps = {}, speech = [] } = {}) {
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
    advance: (ms) => {
      if (!(speech.length && ms > 0 && bridge.ready && !bridge._finalizing)) {
        clock += ms;
        return;
      }
      // One frame for each span of the same kind: a voiced span ends exactly when the caller stops.
      let from = clock - bridge.sessionStartWall;
      const to = from + ms;
      const cuts = [...new Set(speech.flat())].filter((cut) => cut > from && cut < to).sort((a, b) => a - b);
      for (const cut of [...cuts, to]) {
        clock += cut - from;
        const middle = (from + cut) / 2;
        const voiced = speech.some(([a, b]) => middle >= a && middle < b);
        twilio.emit('message', JSON.stringify({ event: 'media', media: { track: 'inbound', payload: (voiced ? b64 : silence)((cut - from) * 8) } }));
        from = cut;
      }
    },
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

  // One 20 ms caller frame of one mu-law byte: 0x00, 0x01 and 0x02 are all loud.
  const frameOf = (byte) => Buffer.alloc(160, byte).toString('base64');

  test('caller audio with voice in it before session.started is held and forwarded in order once the session is up; later audio goes straight through', async () => {
    const t = setup();
    t.twilioMedia(frameOf(0x00)); // before even the start frame
    await t.twilioStart();
    t.openai.emit('open');
    t.twilioMedia(frameOf(0x01));
    expect(t.openai.types()).toEqual(['session.start']); // nothing sent before the session is up
    t.openai.receive({ type: 'session.started', session: { id: 's1' } });
    await flush();
    t.twilioMedia(frameOf(0x02));
    expect(t.openai.types()).toEqual(['session.start', 'session.input_audio.append', 'session.input_audio.append', 'session.input_audio.append']);
    expect(t.openai.sent.filter((m) => m.audio).map((m) => m.audio)).toEqual([frameOf(0x00), frameOf(0x01), frameOf(0x02)]);
  });

  test('held opening audio that is silent is not sent; from session.started on every frame is, silence included', async () => {
    const t = setup();
    await t.twilioStart();
    t.openai.emit('open');
    for (let i = 0; i < 80; i++) t.twilioMedia(silence(160)); // 1.6 s of line silence while OpenAI starts
    t.openai.receive({ type: 'session.started', session: { id: 's1' } });
    await flush();
    expect(t.openai.types()).toEqual(['session.start']);
    t.twilioMedia(silence(160));
    expect(t.openai.sent.filter((m) => m.audio).map((m) => m.audio)).toEqual([silence(160)]);
  });

  test('held opening audio is sent from 100 ms before the caller\'s first sound', async () => {
    const t = setup();
    await t.twilioStart();
    t.openai.emit('open');
    for (let i = 0; i < 50; i++) t.twilioMedia(silence(160));
    t.twilioMedia(frameOf(0x00)); // the caller says something
    for (let i = 0; i < 10; i++) t.twilioMedia(silence(160));
    t.openai.receive({ type: 'session.started', session: { id: 's1' } });
    await flush();
    const sent = t.openai.sent.filter((m) => m.audio).map((m) => m.audio);
    expect(sent).toHaveLength(16); // 5 frames of lead, the frame with sound, the 10 after it
    expect(sent[5]).toBe(frameOf(0x00));
  });

  test('quiet speech in the held opening audio is sent', async () => {
    const t = setup();
    await t.twilioStart();
    t.openai.emit('open');
    for (let i = 0; i < 20; i++) t.twilioMedia(silence(160));
    for (let i = 0; i < 10; i++) t.twilioMedia(frameOf(0xee)); // a soft "hello": every sample 148 on the 16-bit scale
    for (let i = 0; i < 5; i++) t.twilioMedia(silence(160));
    t.openai.receive({ type: 'session.started', session: { id: 's1' } });
    await flush();
    const sent = t.openai.sent.filter((m) => m.audio).map((m) => m.audio);
    expect(sent).toHaveLength(20); // 5 frames of lead, the 10 quiet frames, the 5 after them
    expect(sent[5]).toBe(frameOf(0xee));
    expect(sent[14]).toBe(frameOf(0xee));
  });

  test('held line noise under the sound level (RMS 100) is dropped like silence; at that level the held audio is sent', async () => {
    const hold = async (payload) => {
      const t = setup();
      await t.twilioStart();
      t.openai.emit('open');
      for (let i = 0; i < 80; i++) t.twilioMedia(payload);
      t.openai.receive({ type: 'session.started', session: { id: 's1' } });
      await flush();
      return t.openai.sent.filter((m) => m.audio).length;
    };
    expect(await hold(frameOf(0xfa))).toBe(0); // every sample 40
    expect(await hold(frameOf(0xf3))).toBe(0); // every sample 96
    expect(await hold(frameOf(0xf2))).toBe(80); // every sample 104
    const click = Buffer.alloc(160, 0xff);
    click[80] = 0x9f; // one sample of 8316 in a silent frame: an RMS of 657, sound
    expect(await hold(click.toString('base64'))).toBe(80);
    click[80] = 0xcf; // one sample of 924: an RMS of 73, no sound
    expect(await hold(click.toString('base64'))).toBe(0);
  });

  test('the held opening audio keeps only the latest 150 frames (3 s)', async () => {
    const t = setup();
    await t.twilioStart();
    t.openai.emit('open');
    for (let i = 0; i < 160; i++) t.twilioMedia(`F${i}`); // every one decodes to loud bytes: the caller is speaking
    t.openai.receive({ type: 'session.started', session: { id: 's1' } });
    await flush();
    const held = t.openai.sent.filter((m) => m.audio).map((m) => m.audio);
    expect(held).toHaveLength(150);
    expect(held[0]).toBe('F10');
    expect(held[149]).toBe('F159');
  });

  test('session.start carries the greeting as a developer message; nothing more is sent at session.started', async () => {
    const t = setup();
    await t.ready();
    expect(t.openai.sent[0].session.input).toEqual([{
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'Greet the caller now in English. Say exactly: "Waves, this is Sandy." Then pause and listen.' }],
    }]);
    expect(t.openai.types()).toEqual(['session.start']); // no commentary greeting
  });

  test('a greeting with quotation marks cannot close the quoted sentence; no greeting, no developer message', () => {
    const { buildSessionStart } = bridgeMod;
    const quoted = buildSessionStart({ instructions: 'I', voice: 'marin', greeting: 'Hi. Say "pest"' });
    expect(quoted.session.input[0].content[0].text).toBe('Greet the caller now in English. Say exactly: "Hi. Say \'pest\'" Then pause and listen.');
    expect('input' in buildSessionStart({ instructions: 'I', voice: 'marin', greeting: '  ' }).session).toBe(false);
    expect('input' in buildSessionStart({ instructions: 'I', voice: 'marin' }).session).toBe(false);
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
    const t = setup({ speech: [[1300, 1500]] });
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
    const t = setup({ speech: [[1300, 1500]] });
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

  test('the caller speaks on after the barge-in fragment: an ambiguous reply is timed from their last speech, never into turns', async () => {
    const t = setup({ speech: [[1300, 1900]] });
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0
    t.twilioMedia();
    t.advance(1000);
    streamReply(t, 6); // a reply streams +1000..+1500
    t.advance(100);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'wait', start_ms: 1300, end_ms: 1500 }); // barge-in at +1600
    t.advance(600);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // ambiguous reply at +2200
    t.advance(100);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'hold on', start_ms: 1500, end_ms: 1900 }); // the final fragment, late: it changes nothing
    t.twilioStop();
    await flush();
    const s = summaryOf(t);
    expect(s.after_barge_in_ambiguous_ms).toEqual([300]); // +2200 minus +1900, where the caller stopped
    expect(s.turns).toEqual([]);
  });

  test('two gaps inside one barge-in window, with a transcript fragment between them, are both kept apart from turns', async () => {
    const t = setup({ speech: [[1300, 1500], [2050, 2150]] });
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
    const t = setup({ speech: [[1300, 1500], [2600, 2800]] });
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
    const t = setup({ speech: [[1700, 1950]] });
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0
    t.twilioMedia();
    t.advance(1000);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(8000) }); // reply at +1000, plays to +2000
    t.advance(960);
    // the caller's short answer over the end of it: ends at +1950, too late to cut anything
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'yes', start_ms: 1700, end_ms: 1950 });
    t.advance(140);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // next reply at +2100, 150 ms after the caller stopped
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
    const t = setup({ speech: [[5000, 6200]] });
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting: no turn yet
    t.advance(5000);
    t.twilioMedia();
    t.advance(1500);
    // the caller spoke t0 + 5000..6200; the delay is read from that audio, not from end_ms
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

  test('a reply is timed when it begins, whenever the transcript arrives; the model\'s next reply, by itself, is not timed', async () => {
    const t = setup({ speech: [[1500, 1900]] });
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

  test('the delay runs from the caller\'s last speech, not from the last fragment that came before the reply', async () => {
    const t = setup({ speech: [[1000, 1900]] });
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0
    t.twilioMedia();
    t.advance(1600);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'I need', start_ms: 1000, end_ms: 1500 }); // before the reply
    t.advance(400);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // reply at t0 + 2000; the caller spoke on to t0 + 1900
    t.advance(100);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: ' pest control', start_ms: 1500, end_ms: 1900 }); // late
    t.twilioStop();
    await flush();
    expect(summaryOf(t).turns).toEqual([100]);
  });

  test('caller speaks first: the first reply (greeting or answer) is kept apart as first_reply_ambiguous_ms, never in turns', async () => {
    const t = setup({ speech: [[300, 1500]] });
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
    const t = setup({ speech: [[300, 1500]] });
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

  test("the delay is read from the caller's own audio: it does not move with a transcript's end_ms, and needs no transcript", async () => {
    // Measured on the live API: end_ms ran 1.3 to 2.5 s after the caller's last sound.
    for (const endMs of [200, 3900, 5500, 600000, null]) {
      const t = setup({ speech: [[3500, 3900]] });
      await t.ready();
      t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting
      t.advance(4000);
      if (endMs !== null) t.openai.receive({ type: 'session.input_transcript.delta', delta: 'hi', start_ms: endMs - 200, end_ms: endMs });
      t.advance(500); // now t0 + 4500; the caller stopped at t0 + 3900
      t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) });
      t.twilioStop();
      await flush();
      expect(summaryOf(t).turns).toEqual([600]);
    }
  });

  test('a caller transcript that lands while the model is already talking times the reply from the speech end, never near zero', async () => {
    const t = setup({ speech: [[1500, 1900]] });
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
  const start = async (speech) => {
    const t = setup({ speech });
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
    const t = await start([[2300, 2900]]);
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
    const t = await start([[100, 400], [1500, 1600]]);
    delta(t, b64(160)); // greeting
    run(t, 10, silence(800));
    said(t, 'first question', 100, 400);
    run(t, 5, silence(800)); // +1000..+1500
    delta(t, b64(800)); // reply 1 begins at +1500
    t.advance(100);
    said(t, 'and', 1520, 1580); // the caller spoke again +1500..+1600, after reply 1 began
    run(t, 5, silence(800)); // 500 ms pause inside the reply
    delta(t, b64(800)); // voice resumes: the same reply
    t.advance(100);
    expect(t.bridge.latencies).toHaveLength(1); // the pause did not start a reply
    run(t, 6, silence(800)); // 600 ms of silent audio
    delta(t, b64(800)); // a new reply
    expect((await end(t)).turns).toHaveLength(2);
  });

  test('silence at the end of one voiced chunk and at the start of the next counts toward the 600 ms', async () => {
    const t = await start([[0, 100]]);
    delta(t, b64(160)); // greeting
    t.advance(100);
    said(t, 'first question', 20, 60);
    // Four chunks of about 400 ms, 100 ms apart (no arrival gap).
    delta(t, voiceThenSilence(290)); // the same reply, then 290 ms silent
    t.advance(100);
    delta(t, silenceThenVoice(300)); // 590 ms of silence in all: still the same reply
    expect(t.bridge.latencies).toHaveLength(0);
    t.advance(100);
    delta(t, voiceThenSilence(300));
    t.advance(100);
    delta(t, silenceThenVoice(300)); // at +400, 600 ms of silence in all: a new reply, voiced 300 ms into its chunk
    expect((await end(t)).turns).toEqual([600]); // its voice at +700; the caller stopped at +100
  });

  test('one chunk that holds the end of a reply, 600 ms of silence and the next reply: the next reply is timed from its own first voiced sample', async () => {
    const mixed = Buffer.concat([Buffer.alloc(800, 0x00), Buffer.alloc(4800, 0xff), Buffer.alloc(800, 0x00)]).toString('base64');
    const t = await start([[0, 100]]);
    delta(t, b64(160)); // greeting
    t.advance(100);
    said(t, 'hello', 10, 60);
    delta(t, mixed); // at +100: 100 ms more greeting, 600 ms silent, the reply's voice at +800
    expect((await end(t)).turns).toEqual([700]);
    expect(mediaPayloads(t)).toContain(mixed);
  });

  describe('a chunk that holds the cut-off tail, 600 ms of silence and then the next reply, after a barge-in', () => {
    const mixed = Buffer.concat([Buffer.alloc(800, 0x00), Buffer.alloc(4800, 0xff), Buffer.alloc(800, 0x00)]).toString('base64');
    const bargeIn = async () => {
      const t = await start([[1100, 1300]]);
      delta(t, b64(160)); // greeting
      t.advance(1000);
      delta(t, b64(8000)); // a reply...
      t.advance(240);
      delta(t, b64(8000)); // ...still streaming, no gap: 2000 ms queued in all
      t.advance(160);
      said(t, 'wait', 1100, 1300); // barge-in at +1400
      return t;
    };

    test('inside the 1.5 s it plays from the reply on: the tail before it never reaches Twilio', async () => {
      const t = await bargeIn();
      t.advance(50);
      delta(t, mixed); // at +1450, no gap
      expect(mediaPayloads(t)).not.toContain(mixed);
      expect(mediaPayloads(t)).toContain(b64(800)); // the reply alone: it plays at once, until +1550
      expect(t.bridge.playbackEndsAt - t.bridge.sessionStartWall).toBe(1550);
      expect(t.bridge.voiceEndsAt - t.bridge.sessionStartWall).toBe(1550);
      expect((await end(t)).after_barge_in_ambiguous_ms).toEqual([150]); // its voice at +1450, the caller stopped at +1300
    });

    test('past the 1.5 s nothing is trimmed: the chunk plays whole', async () => {
      const t = await bargeIn();
      t.advance(50);
      run(t, 15, b64(800)); // the cut-off reply keeps streaming with no gap, +1450..+2850: dropped
      expect(mediaPayloads(t)).not.toContain(b64(800));
      delta(t, mixed); // at +2950: the 1.5 s from the barge-in at +1400 has passed
      expect(mediaPayloads(t)).toContain(mixed);
    });
  });

  test('one chunk with two reply starts marks one reply, at the first of them', async () => {
    const two = Buffer.concat([Buffer.alloc(800, 0xff), Buffer.alloc(800, 0x00), Buffer.alloc(4800, 0xff), Buffer.alloc(800, 0x00)]).toString('base64');
    const t = await start([[0, 100]]);
    t.advance(100);
    said(t, 'hello', 10, 50);
    t.advance(200);
    delta(t, two); // at +300: the first voice of the call 100 ms in, 600 ms of silence, voice again
    const s = await end(t);
    expect(s.first_reply_ambiguous_ms).toBe(300); // its voice at +400, the caller stopped at +100
    expect(s.turns).toEqual([]);
  });

  test('an arrival gap still starts a new reply when no silent audio came between', async () => {
    const t = await start([[100, 500]]);
    delta(t, b64(160)); // greeting
    t.advance(500);
    said(t, 'hello', 100, 500);
    t.advance(500);
    delta(t, b64(160)); // 1000 ms after the greeting chunk: a gap, so a new reply
    expect((await end(t)).turns).toEqual([500]);
  });

  describe('the delay runs to the first voiced sample of the reply: its chunk arrival plus its offset in the chunk', () => {
    test('a voiced chunk with leading silence: the delay includes the offset of the voice inside the chunk', async () => {
      const t = await start([[100, 500]]);
      delta(t, b64(160)); // greeting
      t.advance(500);
      said(t, 'hello there', 100, 500);
      t.advance(1500); // +2000
      delta(t, silenceThenVoice(200)); // 200 ms silent, then voice
      expect((await end(t)).turns).toEqual([1700]); // voice at +2200, speech ended +500
    });

    test('audio still queued at Twilio ahead of the reply is not added to the delay', async () => {
      const t = await start([[300, 700]]);
      delta(t, b64(160)); // greeting
      run(t, 10, silence(800)); // paced silence, +0..+1000
      said(t, 'hello', 300, 700);
      t.advance(400); // a 400 ms network stall, then three chunks at once at +1400
      delta(t, silence(800));
      delta(t, silence(800));
      delta(t, b64(800)); // the reply reaches the bridge at +1400, behind 200 ms of queued silence
      expect((await end(t)).turns).toEqual([700]); // speech ended +700
    });

    test('a late transcript times the reply to its first voiced sample', async () => {
      const t = await start([[500, 900]]);
      delta(t, b64(160)); // greeting
      t.advance(1000);
      delta(t, silenceThenVoice(200)); // at +1000: a reply whose voice is 200 ms into its chunk
      t.advance(300);
      said(t, 'hello', 500, 900); // the speech ended before the reply arrived
      expect((await end(t)).turns).toEqual([300]);
    });

    test('a reply right after a barge-in plays from its first voiced sample and is timed apart from there', async () => {
      const t = await start([[1100, 1300]]);
      delta(t, b64(160)); // greeting
      t.advance(1000);
      delta(t, b64(8000)); // a reply: 1000 ms queued
      t.advance(300);
      said(t, 'wait', 1100, 1300); // barge-in at +1300
      t.advance(300);
      delta(t, silenceThenVoice(200)); // at +1600, after a gap: forwarded from its voice on
      expect(mediaPayloads(t)).toContain(b64(800));
      expect((await end(t)).after_barge_in_ambiguous_ms).toEqual([300]);
    });

    test('a second reply inside the 1.5 s after a barge-in is timed apart to its first voiced sample', async () => {
      const t = await start([[1100, 1300], [1400, 1500]]);
      delta(t, b64(160)); // greeting
      t.advance(1000);
      delta(t, b64(8000)); // a reply: 1000 ms queued
      t.advance(300);
      said(t, 'wait', 1100, 1300); // barge-in at +1300
      t.advance(100);
      delta(t, b64(160)); // at +1400, after a gap: a short reply
      t.advance(100);
      said(t, ' so', 1450, 1500); // more speech (+1400..+1500), after that reply's audio has played: no barge-in
      t.advance(200);
      delta(t, silenceThenVoice(200)); // at +1700, after a gap: a reply whose voice is 200 ms into its chunk
      const s = await end(t);
      expect(s.after_barge_in_ambiguous_ms).toEqual([100, 400]);
      expect(s.interruptions).toBe(1);
      expect(s.turns).toEqual([]);
    });

    test('the caller speaks first: first_reply_ambiguous_ms runs to the first voiced sample', async () => {
      const t = await start([[0, 100]]);
      t.advance(100);
      said(t, 'hello', 10, 50);
      t.advance(200);
      delta(t, silenceThenVoice(200, 160)); // at +300: the first voice of the call, 200 ms into its chunk
      const s = await end(t);
      expect(s.first_reply_ambiguous_ms).toBe(400);
      expect(s.turns).toEqual([]);
    });
  });

  test('speech that ended after a chunk arrived is not answered by the voice inside that chunk: it times the next reply', async () => {
    const t = await start([[800, 1100]]);
    delta(t, b64(160)); // greeting
    t.advance(1000);
    delta(t, silenceThenVoice(200)); // at +1000: a reply whose voice plays from +1200
    t.advance(300);
    said(t, 'hello', 800, 1100); // ended after that chunk had arrived
    run(t, 7, silence(800)); // +1300..+2000
    delta(t, b64(800)); // the next reply at +2000
    expect((await end(t)).turns).toEqual([900]);
  });

  describe('the barge-in flush cuts queued voice only', () => {
    const clears = (t) => t.twilio.sent.filter((m) => m.event === 'clear').length;

    test('a caller question over queued silence flushes nothing: the answer is a turn', async () => {
      const t = await start([[600, 1000]]);
      delta(t, b64(160)); // greeting
      t.advance(1000);
      delta(t, silence(4000)); // one burst after a stall: 500 ms of silence queued until +1500
      t.advance(100);
      said(t, 'hello', 600, 1000); // at +1100, with 400 ms of silence still queued
      expect(clears(t)).toBe(0);
      t.advance(800);
      delta(t, b64(800)); // the answer at +1900, after a gap
      const s = await end(t);
      expect(s.turns).toEqual([900]);
      expect(s.interruptions).toBe(0);
      expect(s.after_barge_in_ambiguous_ms).toEqual([]);
    });

    test('voice queued behind silence is still flushed', async () => {
      const t = await start();
      delta(t, b64(160)); // greeting
      t.advance(1000);
      delta(t, silence(8000)); // one burst at +1000: 1000 ms of silence...
      delta(t, b64(2400)); // ...then a reply: its voice plays +2000..+2300
      t.advance(400);
      said(t, 'wait', 1250, 1350); // at +1400: the caller spoke after the reply began to arrive
      expect(clears(t)).toBe(1);
    });

    test('silence queued after the last voice of a reply is nothing to cut', async () => {
      const t = await start();
      delta(t, b64(160)); // greeting
      t.advance(1000);
      delta(t, Buffer.concat([Buffer.alloc(2400, 0x00), Buffer.alloc(5600, 0xff)]).toString('base64')); // voice +1000..+1300, then silence until +2000
      t.advance(400);
      said(t, 'ok', 1250, 1350); // at +1400: the voice has played, 600 ms of silence is queued
      expect(clears(t)).toBe(0);
    });

    test('a flush leaves no voice queued: more caller speech sends no second clear', async () => {
      const t = await start();
      delta(t, b64(160)); // greeting
      t.advance(1000);
      delta(t, b64(8000)); // a reply...
      t.advance(240);
      delta(t, b64(8000)); // ...2000 ms of voice queued in all
      t.advance(160);
      said(t, 'wait', 1100, 1300); // barge-in at +1400
      t.advance(100);
      said(t, ' a moment', 1300, 1500); // at +1500
      expect(clears(t)).toBe(1);
      expect((await end(t)).interruptions).toBe(1);
    });
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

describe("the reply delay is read from the caller's own audio", () => {
  const delta = (t, payload) => t.openai.receive({ type: 'session.output_audio.delta', delta: payload });
  const said = (t, text, startMs, endMs) => t.openai.receive({ type: 'session.input_transcript.delta', delta: text, start_ms: startMs, end_ms: endMs });
  const frameOf = (byte) => Buffer.alloc(160, byte).toString('base64');
  const end = async (t) => {
    t.twilioStop();
    await flush();
    return summaryOf(t);
  };
  // The greeting comes at once, the caller speaks as `speech` says, and the
  // model's next voice arrives at +4100.
  const call = async (speech) => {
    const t = setup({ speech });
    await t.ready();
    delta(t, b64(160)); // greeting
    t.advance(4100);
    delta(t, b64(800)); // the reply at +4100
    t.advance(100); // the caller's audio goes on after the reply began
    return end(t);
  };

  test('a caller frame holds voice from RMS 300 (292 does not, 308 does), and voice is speech once it runs 100 ms', async () => {
    const t = setup();
    await t.ready();
    for (let i = 0; i < 5; i++) t.twilioMedia(frameOf(0xe5)); // every sample 292
    expect(t.bridge.callerVoicedMs).toBe(0);
    expect(t.bridge.callerSpokeAt).toBe(null);
    for (let i = 0; i < 4; i++) t.twilioMedia(frameOf(0xe4)); // every sample 308
    expect(t.bridge.callerVoicedMs).toBe(80);
    expect(t.bridge.callerSpokeAt).toBe(null); // 80 ms in a row: not yet speech
    t.twilioMedia(frameOf(0xe4));
    expect(t.bridge.callerVoicedMs).toBe(100);
    expect(t.bridge.callerSpokeAt).toBe(t.tick());
    t.twilioMedia(silence(160)); // a silent frame ends the run
    for (let i = 0; i < 4; i++) {
      t.advance(20);
      t.twilioMedia(frameOf(0xe4));
    }
    expect(t.bridge.callerSpokeAt).toBe(t.tick() - 80); // 80 ms again: no new speech
    t.twilioMedia(''); // a frame with no audio holds no voice: it ends the run as well
    t.advance(20);
    t.twilioMedia(frameOf(0xe4));
    expect(t.bridge.callerSpokeAt).toBe(t.tick() - 100);
  });

  test('one stray sample at speech level in a silent frame is not voice', async () => {
    const t = setup();
    await t.ready();
    const click = Buffer.alloc(160, 0xff);
    click[80] = 0xbf; // one sample of 1980: the frame's RMS is 157, under the voice level of 300
    t.twilioMedia(click.toString('base64'));
    expect(t.bridge.callerVoicedMs).toBe(0);
    t.twilio.emit('message', JSON.stringify({ event: 'media', media: { track: 'outbound', payload: b64(800) } })); // not the caller's track
    expect(t.bridge.callerMs).toBe(20); // the click frame only
  });

  test('a sound under 100 ms (a click, a knock) is not caller speech and moves no delay; 100 ms of voice is speech', async () => {
    expect((await call([[2000, 3000], [3600, 3620]])).turns).toEqual([1100]);
    expect((await call([[2000, 3000], [3600, 3680]])).turns).toEqual([1100]);
    expect((await call([[2000, 3000], [3600, 3700]])).turns).toEqual([400]); // +4100 minus +3700
  });

  test('a fast reply is a delay too: its voice comes 150 ms after the caller stopped, and the caller stays silent', async () => {
    expect((await call([[2000, 3950]])).turns).toEqual([150]);
  });

  test('a delay is a whole number of ms, though a voiced sample can sit between two ms', async () => {
    const t = setup({ speech: [[2000, 3000]] });
    await t.ready();
    delta(t, b64(160)); // greeting
    t.advance(4100);
    delta(t, Buffer.concat([Buffer.alloc(12, 0xff), Buffer.alloc(800, 0x00)]).toString('base64')); // its voice 1.5 ms into the chunk
    expect((await end(t)).turns).toEqual([1102]); // 1101.5, rounded
  });

  test("the server's clock steps back between the caller's last speech and the reply: the delay is 0, never negative", async () => {
    const t = setup();
    await t.ready();
    for (let i = 0; i < 10; i++) {
      t.advance(20);
      t.twilioMedia(b64(160)); // the caller speaks
    }
    t.advance(-500); // the clock is set back
    delta(t, b64(800)); // the first reply of the call, 500 ms "before" the caller's last frame by that clock
    expect((await end(t)).first_reply_ambiguous_ms).toBe(0);
  });

  test("the caller starts again 60 ms before a reply's first voice and speaks on: that reply has no delay, though the sound is known as speech only after the voice began", async () => {
    const reply = async (again) => {
      const t = setup({ speech: [[2000, 3000], [again, again + 200]] });
      await t.ready();
      delta(t, b64(160)); // greeting
      t.advance(4000);
      for (let i = 0; i < 5; i++) t.advance(20); // caller frames of 20 ms, as Twilio sends them
      delta(t, b64(800)); // the reply's voice at +4100
      for (let i = 0; i < 12; i++) t.advance(20);
      return (await end(t)).turns;
    };
    expect(await reply(4040)).toEqual([]); // not 1100: 60 ms of voice before the reply's voice, 100 ms in a row at +4140
    expect(await reply(4080)).toEqual([]); // one frame before the reply's voice: the run began at +4080, not when that frame arrived
    expect(await reply(4100)).toEqual([1100]); // the caller starts with the reply's voice: the reply had waited
  });

  test('the reply after one that did not wait is timed from where the caller stopped', async () => {
    const t = setup({ speech: [[2000, 4300]] });
    await t.ready();
    delta(t, b64(160)); // greeting
    t.advance(4100);
    delta(t, b64(800)); // a reply at +4100, while the caller speaks
    t.advance(1300);
    delta(t, b64(800)); // the answer at +5400
    expect((await end(t)).turns).toEqual([1100]); // +5400 minus +4300
  });

  test("the caller starts between the arrival of a reply's chunk and its first voiced sample, and speaks on: that reply has no delay", async () => {
    const reply = async (again) => {
      const t = setup({ speech: [[2000, 3000], [again, again + 200]] });
      await t.ready();
      delta(t, b64(160)); // greeting
      t.advance(4100);
      delta(t, Buffer.concat([Buffer.alloc(1600, 0xff), Buffer.alloc(800, 0x00)]).toString('base64')); // arrives at +4100, its voice at +4300
      t.advance(600);
      return (await end(t)).turns;
    };
    expect(await reply(4200)).toEqual([]);
    expect(await reply(4300)).toEqual([1300]); // +4300 minus +3000
  });

  test('speech that arrived with the chunk of the reply before, or earlier, is not answered by the next reply; 20 ms later it is', async () => {
    const next = async (stops) => {
      const t = setup({ speech: [[2000, stops]] });
      await t.ready();
      t.advance(4100);
      delta(t, b64(800)); // the first reply of the call, at +4100 (its delay is kept apart, never in turns)
      t.advance(1300);
      delta(t, b64(800)); // the model's next reply at +5400
      return (await end(t)).turns;
    };
    expect(await next(4100)).toEqual([]); // the caller's last frame arrived with the chunk at +4100
    expect(await next(4120)).toEqual([1280]); // +5400 minus +4120
  });

  test("the caller's last voiced frame and a reply's chunk in the same millisecond: the order the bridge handles them in decides which reply answers that speech", async () => {
    const order = async (frameFirst) => {
      const t = setup();
      await t.ready();
      for (let i = 0; i < 10; i++) {
        t.advance(20);
        t.twilioMedia(b64(160)); // the caller speaks, +0..+200
      }
      t.advance(20); // +220: one more voiced frame and the first reply's chunk
      if (frameFirst) t.twilioMedia(b64(160));
      delta(t, b64(800)); // the first reply of the call (its delay is kept apart)
      if (!frameFirst) t.twilioMedia(b64(160));
      t.advance(20);
      t.twilioMedia(silence(160)); // the caller is silent from here
      t.advance(1280);
      delta(t, b64(800)); // the model's next reply, at +1520
      const s = await end(t);
      return [s.first_reply_ambiguous_ms, s.turns];
    };
    expect(await order(true)).toEqual([0, []]); // the frame came first: the first reply answers it, the next reply answers nothing
    expect(await order(false)).toEqual([null, [1300]]); // the chunk came first: the caller spoke on into that reply, and the next reply answers them
  });

  test('taking a delay back removes that reply\'s delay only: an earlier turn stays, and a kept-apart first delay is taken back as well', async () => {
    const t = setup({ speech: [[2000, 3000], [6000, 7000], [8250, 8550]] });
    await t.ready();
    delta(t, b64(160)); // greeting
    t.advance(4100);
    delta(t, b64(800)); // answer 1 at +4100: 1100
    t.advance(4200);
    delta(t, Buffer.concat([Buffer.alloc(800, 0xff), Buffer.alloc(800, 0x00)]).toString('base64')); // answer 2 arrives at +8300, its voice at +8400: 1400...
    expect(t.bridge.latencies).toEqual([1100, 1400]);
    for (let i = 0; i < 6; i++) t.advance(50); // ...but the caller, who began again at +8250, speaks on, frame after frame
    expect((await end(t)).turns).toEqual([1100]);

    // A reply with no delay of its own has none to take back: the turn before it stays.
    const next = setup({ speech: [[2000, 3000], [5350, 5650]] });
    await next.ready();
    delta(next, b64(160)); // greeting
    next.advance(4100);
    delta(next, b64(800)); // the answer at +4100: 1100
    next.advance(1300);
    delta(next, b64(800)); // the model's next reply by itself, at +5400: no delay
    next.advance(300); // the caller, who began at +5350, speaks on
    expect((await end(next)).turns).toEqual([1100]);

    const first = setup({ speech: [[300, 1500], [1950, 2250]] });
    await first.ready();
    first.advance(2000);
    delta(first, b64(800)); // the first reply of the call at +2000, 500 ms after the caller stopped...
    expect(first.bridge.firstReplyAmbiguousMs).toBe(500);
    first.advance(300); // ...but the caller began again at +1950 and speaks on
    const s = await end(first);
    expect(s.first_reply_ambiguous_ms).toBe(null);
    expect(s.turns).toEqual([]);
  });

  test('a noisy line, every caller frame voiced: the bridge cannot hear the caller stop and records no delay; caller_voiced_pct tells', async () => {
    const noisy = await call([[0, 60000]]);
    expect(noisy.turns).toEqual([]);
    expect(noisy.caller_voiced_pct).toBe(100);
    const silent = await call([[60000, 60001]]); // a span this call never reaches: every caller frame is silent
    expect(silent.turns).toEqual([]);
    expect(silent.caller_voiced_pct).toBe(0);
  });

  test('caller_voiced_pct is the voiced share of the caller audio by time; with no caller audio it is null', async () => {
    expect((await call([[2000, 3000]])).caller_voiced_pct).toBe(24); // 1000 ms of 4100
    const t = setup();
    await t.ready();
    expect((await end(t)).caller_voiced_pct).toBe(null);
  });

  test('speech from before session.started starts no delay; a run of voice that goes on after session.started is speech from then on', async () => {
    const t = setup();
    await t.twilioStart();
    t.openai.emit('open');
    for (let i = 0; i < 10; i++) {
      t.advance(20);
      t.twilioMedia(b64(160)); // 200 ms of speech, held until the session is up
    }
    t.advance(800);
    t.openai.receive({ type: 'session.started', session: { id: 's1' } });
    await flush();
    expect(t.bridge.callerVoicedMs).toBe(200); // its voiced time counts all the same
    t.advance(1500);
    delta(t, b64(160)); // the first reply
    const s = await end(t);
    expect(s.first_reply_ambiguous_ms).toBe(null); // the model heard that speech only at session.started
    expect(s.turns).toEqual([]);

    const on = setup();
    await on.twilioStart();
    on.openai.emit('open');
    for (let i = 0; i < 3; i++) {
      on.advance(20);
      on.twilioMedia(b64(160)); // 60 ms of voice before the session is up...
    }
    on.openai.receive({ type: 'session.started', session: { id: 's1' } });
    await flush();
    for (let i = 0; i < 2; i++) {
      on.advance(20);
      on.twilioMedia(b64(160)); // ...and 40 ms after: 100 ms in a row
    }
    on.advance(1500);
    delta(on, b64(160)); // the first reply, 1500 ms after the caller stopped
    expect((await end(on)).first_reply_ambiguous_ms).toBe(1500);
  });

  test("audio missing between two frames (a jump in Twilio's media timestamps) ends a run of voice; a stamp under one frame late does not", async () => {
    // Each frame: its timestamp, or [timestamp, length in ms]; 20 ms when not given.
    const speechAfter = async (frames) => {
      const t = setup();
      await t.ready();
      for (const [stamp, ms = 20] of frames.map((frame) => [].concat(frame))) {
        t.advance(ms);
        t.twilio.emit('message', JSON.stringify({ event: 'media', media: { track: 'inbound', timestamp: String(stamp), payload: b64(ms * 8) } }));
      }
      return t.bridge.callerSpokeAt !== null;
    };
    expect(await speechAfter([20, 40, 60, 80, 100])).toBe(true); // 100 ms in a row
    expect(await speechAfter([20, 40, 60, 80, 120])).toBe(false); // one frame is missing before the fifth: 80 ms, then 20 ms
    expect(await speechAfter([20, 40, 60, 80, 119])).toBe(true);
    expect(await speechAfter([20, 40, 60, 80, 2000])).toBe(false); // 80 ms of voice, 1.9 s missing, a click
    expect(await speechAfter([20, 40, 60, 80, 2000, 2020, 2040, 2060, 2080])).toBe(true); // a new run of 100 ms after the gap
    expect(await speechAfter([20, 40, 60, [80, 40]])).toBe(true); // 60 ms, then a 40 ms frame right after it
    expect(await speechAfter([20, 40, 60, [100, 40]])).toBe(false); // 20 ms is missing before a longer frame: its length does not hide the gap
  });

  // Two end-to-end runs on the live API: the real bridge, a synthetic caller,
  // 24 s each. A replay drives the bridge with what was measured, on a 20 ms
  // grid: when the caller spoke, when each transcript fragment arrived and the
  // end_ms it carried, and where the model's voice sits in its audio.
  const voicedAt = (ranges, ms) => ranges.some(([from, to]) => ms >= from && ms < to);
  const replay = async ({ speech, fragments, voice, arrives }) => {
    const t = setup();
    await t.ready();
    const chunk = (position) => {
      const audio = Buffer.alloc(800, 0xff);
      for (let i = 0; i < 800; i++) if (voicedAt(voice, position + i / 8)) audio[i] = 0x00;
      return audio.toString('base64');
    };
    for (let ms = 20; ms <= 21000; ms += 20) {
      t.advance(20);
      t.twilioMedia(voicedAt(speech, ms - 10) ? b64(160) : silence(160)); // the caller's frame for (ms - 20, ms]
      for (let position = 0; position < ms; position += 100) if (arrives(position) === ms) delta(t, chunk(position));
      for (const [arrival, endMs] of fragments) if (arrival > ms - 20 && arrival <= ms) said(t, 'words', endMs - 200, endMs);
    }
    const s = await end(t);
    expect(s.interruptions).toBe(0);
    expect(s.after_barge_in_ambiguous_ms).toEqual([]);
    return s;
  };

  // 2026-11-20. The caller's questions ended 8083 and 17097 ms after
  // session.started; the model's voice began 1097 and 1107 ms later. The
  // bridge of that day recorded 0 ms for both: every end_ms lay after the
  // reply. The greeting was never spoken, so the first answer is the first
  // reply of the call. One reply held a 593 ms pause.
  test('the live session of 2026-11-20, replayed: both delays read as measured', async () => {
    const s = await replay({
      speech: [[6047, 8083], [15045, 17097]],
      fragments: [ // [arrival, end_ms]
        [7510, 8600], [7690, 8800], [7872, 9000], [8066, 9200], [8330, 9400], [8496, 9600], [8786, 9800], [9169, 10200],
        [16456, 17800], [16909, 18200], [17098, 18400], [17313, 18600], [17502, 18800], [17875, 19000], [18276, 19400],
      ],
      voice: [[9080, 11000], [11593, 14500], [18107, 20820]],
      arrives: (position) => position + 100, // audio position p arrived about p + 100
    });
    expect(s.first_reply_ambiguous_ms).toBe(1100); // measured 1097
    expect(s.turns).toEqual([1107]); // measured 1107
  });

  // 2026-11-21, Sandy's full prompt: the greeting was spoken 2.0 s after
  // session.started, the questions ended at 8089 and 17101 ms, and the
  // model's voice began 1670 and 1690 ms later. Every end_ms was later than
  // the moment its fragment arrived.
  test('the live session of 2026-11-21, replayed: the greeting is no turn and both delays read as measured', async () => {
    const s = await replay({
      speech: [[6053, 8089], [15049, 17101]],
      fragments: [
        [7262, 7400], [8107, 8200], [8107, 8400], [8478, 8800], [8631, 9000], [8940, 9400],
        [16268, 17800], [16875, 18400], [17021, 18600], [17265, 18800], [17365, 19000], [17555, 19200], [17853, 19600],
      ],
      voice: [[1980, 4140], [9700, 14320], [18720, 20860]],
      arrives: (position) => position + 60, // audio position p arrived about p + 60
    });
    expect(s.first_reply_ambiguous_ms).toBe(null);
    expect(s.turns).toEqual([1680, 1680]); // measured 1670 and 1690
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

describe('delegation: tools mode (GATE_VOICE_GPT_LIVE_TOOLS)', () => {
  const created = (id, target = 'client') => ({ type: 'session.delegation.created', delegation: { id, target }, offset_ms: 100 });
  const said = (words, start, end) => ({ type: 'session.input_transcript.delta', delta: words, start_ms: start, end_ms: end });
  const answers = (t) => t.openai.sent.filter((m) => m.type === 'session.commentary.append' && m.delegation_id);

  // A fake brain: ask() resolves what `reply` returns, and records every ask.
  function toolsSetup({ reply = async () => 'Your next visit is Tuesday.', brainOpen, deps = {} } = {}) {
    const brain = { ask: jest.fn((text, opts) => reply(text, opts)), end: jest.fn(async () => {}), softTimeouts: 0, hardTimeouts: 0 };
    const brainFactory = jest.fn(brainOpen || (async () => brain));
    const t = setup({ deps: { toolsOn: () => true, brainFactory, transcriptQuietMs: 0, ...deps } });
    return { t, brain, brainFactory };
  }

  test('gate off: the brain never opens, the fixed sentence is the answer, and the summary has no brain counts', async () => {
    const brainFactory = jest.fn();
    const t = setup({ deps: { toolsOn: () => false, brainFactory } });
    await t.ready();
    t.openai.receive(said('When is my next visit', 0, 900));
    t.openai.receive(created('d1'));
    expect(answers(t)).toEqual([{ type: 'session.commentary.append', delegation_id: 'd1', content: DELEGATION_REPLY }]);
    t.twilioStop();
    await finalized(t);
    expect(brainFactory).not.toHaveBeenCalled();
    expect(summaryOf(t)).not.toHaveProperty('brain_asks');
  });

  test('a gate read that throws counts as off', async () => {
    const t = setup({ deps: { toolsOn: () => { throw new Error('boom'); } } });
    await t.ready();
    t.openai.receive(created('d1'));
    expect(answers(t)[0].content).toBe(DELEGATION_REPLY);
  });

  test('the session instructions are built for tools mode only when the gate is on', async () => {
    const buildInstructions = jest.fn(() => 'INSTRUCTIONS');
    const on = toolsSetup({ deps: { buildInstructions } });
    await on.t.ready();
    expect(buildInstructions).toHaveBeenLastCalledWith({ tools: true });
    const off = setup({ deps: { buildInstructions } });
    await off.ready();
    expect(buildInstructions).toHaveBeenLastCalledWith({ tools: false });
    const tools = bridgeMod.buildLiveInstructions({ tools: true });
    expect(tools.endsWith(bridgeMod.TOOLS_LIMITS)).toBe(true);
    expect(tools).not.toContain(bridgeMod.TRIAL_LIMITS);
    expect(bridgeMod.TOOLS_LIMITS).toMatch(/Delegate only these: prices, services offered, open appointment times by city,\s+and a new-customer request/);
    expect(bridgeMod.TOOLS_LIMITS).toMatch(/Open times are practice-only and nothing is booked or held/);
    expect(bridgeMod.TOOLS_LIMITS).toMatch(/cannot check accounts, visits, invoices, estimates, messages or call history/);
    expect(bridgeMod.TOOLS_LIMITS).toMatch(/never guess or invent\s+a price, service or time/);
    expect(bridgeMod.TOOLS_LIMITS).toMatch(/estimates, messages or call history: if asked,\s+say this practice line cannot check that/);
    expect(bridgeMod.TOOLS_LIMITS.length).toBeLessThan(700);
    expect(bridgeMod.buildLiveInstructions().endsWith(bridgeMod.TRIAL_LIMITS)).toBe(true);
  });

  test('the brain opens at session.started for this call, from the bridge\'s own db', async () => {
    const { t, brainFactory } = toolsSetup();
    await t.ready();
    expect(brainFactory).toHaveBeenCalledTimes(1);
    expect(brainFactory).toHaveBeenCalledWith({ callSid: CALL_SID, db: t.db });
  });

  test('a delegation asks the brain with the caller words since the last delegation and speaks ONE commentary append', async () => {
    const { t, brain } = toolsSetup();
    await t.ready();
    t.openai.receive(said('When is ', 0, 400));
    t.openai.receive(said('my next visit?', 400, 900));
    t.openai.receive(created('d1'));
    await waitFor(() => answers(t).length > 0);
    expect(brain.ask).toHaveBeenCalledTimes(1);
    expect(brain.ask).toHaveBeenCalledWith('When is my next visit?', expect.objectContaining({ onSoft: expect.any(Function), softMs: 6000, deadlineMs: 20000 }));
    expect(answers(t)).toEqual([{ type: 'session.commentary.append', delegation_id: 'd1', content: 'Your next visit is Tuesday.' }]);
    // a second delegation gets only the words after the first
    t.openai.receive(said('And how much is it?', 6000, 7000));
    t.openai.receive(created('d2'));
    await waitFor(() => answers(t).length > 1);
    expect(brain.ask).toHaveBeenLastCalledWith('And how much is it?', expect.objectContaining({ onSoft: expect.any(Function) }));
    expect(answers(t).map((m) => m.delegation_id)).toEqual(['d1', 'd2']);
  });

  test('a delegation with no new words uses the last two caller utterances', async () => {
    const { t, brain } = toolsSetup();
    await t.ready();
    t.openai.receive(said('First thing.', 0, 800));
    t.openai.receive(said('Second thing.', 3000, 3800)); // 2.2 s later: a new utterance
    t.openai.receive(said('Third thing.', 7000, 7800));
    t.openai.receive(created('d1'));
    await waitFor(() => answers(t).length > 0);
    t.openai.receive(created('d2')); // nothing said since
    await waitFor(() => answers(t).length > 1);
    expect(brain.ask.mock.calls.map((c) => c[0])).toEqual(['First thing. Second thing. Third thing.', 'Second thing. Third thing.']);
  });

  test('the fallback prompt is bounded: a long uninterrupted utterance is never resent whole', async () => {
    const { t, brain } = toolsSetup();
    await t.ready();
    const long = 'word '.repeat(2000); // 10,000 characters of one utterance
    t.openai.receive(said(long, 0, 30000));
    t.openai.receive(created('d1'));
    await waitFor(() => answers(t).length === 1);
    t.openai.receive(created('d2')); // nothing new: the fallback is the latest utterances
    await waitFor(() => answers(t).length === 2);
    for (const call of brain.ask.mock.calls) expect(call[0].length).toBeLessThanOrEqual(1000 + 'Agent just said: '.length + 300 + '\nCaller said: '.length);
    expect(brain.ask.mock.calls[1][0].length).toBeLessThanOrEqual(1000);
  });

  test('no caller words at all: a "say it again" sentence, and the brain is not asked', async () => {
    const { t, brain } = toolsSetup();
    await t.ready();
    t.openai.receive(created('d1'));
    await waitFor(() => answers(t).length > 0);
    expect(brain.ask).not.toHaveBeenCalled();
    expect(answers(t)[0].content).toMatch(/didn't catch that/);
  });

  test('the delegation waits for the caller transcript to go quiet before it asks', async () => {
    const { t, brain } = toolsSetup({ deps: { transcriptQuietMs: 30, transcriptMaxWaitMs: 1000 } });
    await t.ready();
    t.openai.receive(created('d1'));
    setTimeout(() => t.openai.receive(said('late words', 0, 500)), 10);
    await waitFor(() => answers(t).length > 0);
    expect(brain.ask.mock.calls[0][0]).toBe('late words');
  });

  test('a long reply is cut to the 450-byte bound (tokens never exceed bytes) at a sentence end', async () => {
    const sentence = 'Your technician arrives between nine and eleven in the morning on Tuesday. ';
    const { t } = toolsSetup({ reply: async () => sentence.repeat(60) });
    await t.ready();
    t.openai.receive(said('When?', 0, 300));
    t.openai.receive(created('d1'));
    await waitFor(() => answers(t).length > 0);
    const content = answers(t)[0].content;
    expect(content.length).toBeLessThanOrEqual(bridgeMod.BRAIN_REPLY_MAX_CHARS);
    expect(content.length).toBeGreaterThan(300);
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(bridgeMod.BRAIN_REPLY_MAX_TOKENS);
    expect(content.endsWith('Tuesday.')).toBe(true);
    expect(answers(t)).toHaveLength(1);
  });

  test('capReply keeps a short reply, cuts at a word when no sentence end is near, and handles one long word', () => {
    expect(bridgeMod.capReply('  Short.  ')).toBe('Short.');
    expect(bridgeMod.capReply(`${'word '.repeat(600)}`, 100)).toBe('word '.repeat(20).trim());
    expect(bridgeMod.capReply('x'.repeat(50), 10)).toBe('x'.repeat(10));
  });

  test('each delegation keeps ITS OWN words, bound when it arrives, however long it waits in the queue', async () => {
    let releaseFirst;
    const { t, brain } = toolsSetup({
      reply: (text) => (text === 'one' ? new Promise((resolve) => { releaseFirst = () => resolve('reply one'); }) : Promise.resolve(`reply to ${text}`)),
    });
    await t.ready();
    t.openai.receive(said('one', 0, 300));
    t.openai.receive(created('d1'));
    await waitFor(() => brain.ask.mock.calls.length === 1);
    // two more questions arrive while the first answer runs
    t.openai.receive(said('second question', 5000, 5600));
    t.openai.receive(created('d2'));
    t.openai.receive(said('third question', 9000, 9600));
    t.openai.receive(created('d3'));
    releaseFirst();
    await waitFor(() => answers(t).length === 3);
    expect(brain.ask.mock.calls.map((c) => c[0])).toEqual(['one', 'second question', 'third question']);
    expect(answers(t).map((m) => m.content)).toEqual(['reply one', 'reply to second question', 'reply to third question']);
  });

  test('late fragments of a question join the delegation that is waiting for them, not the next one', async () => {
    const { t, brain } = toolsSetup({ deps: { transcriptQuietMs: 30, transcriptMaxWaitMs: 1000 } });
    await t.ready();
    t.openai.receive(said('When is ', 0, 300));
    t.openai.receive(created('d1'));
    setTimeout(() => t.openai.receive(said('my visit?', 300, 700)), 10); // the rest of the same question, late
    await waitFor(() => answers(t).length === 1);
    expect(brain.ask.mock.calls[0][0]).toBe('When is my visit?');
    // after d1's transcript settled, new words belong to the next delegation
    t.openai.receive(said('And the price?', 4000, 4600));
    t.openai.receive(created('d2'));
    await waitFor(() => answers(t).length === 2);
    expect(brain.ask.mock.calls[1][0]).toBe('And the price?');
  });

  test('a reply that is digit-heavy is cut to fit 500 tokens although it is under 1,800 characters', async () => {
    const invoice = 'Invoice 20260412345 for 1234.56 dollars was paid on 2026-03-04 by card 1111. ';
    const reply = invoice.repeat(22); // 1,700 characters
    expect(reply.length).toBeLessThan(bridgeMod.BRAIN_REPLY_MAX_CHARS);
    expect(bridgeMod.estimateTokens(reply)).toBeGreaterThan(500);
    const { t } = toolsSetup({ reply: async () => reply });
    await t.ready();
    t.openai.receive(said('invoices?', 0, 300));
    t.openai.receive(created('d1'));
    await waitFor(() => answers(t).length === 1);
    const content = answers(t)[0].content;
    expect(bridgeMod.estimateTokens(content)).toBeLessThanOrEqual(bridgeMod.BRAIN_REPLY_MAX_TOKENS);
    expect(content.length).toBeLessThan(reply.length);
    expect(content.endsWith('1111.')).toBe(true); // at a sentence end
  });

  test('the token bound is the UTF-8 byte count: a token is at least a byte, so tokens never exceed it', () => {
    expect(bridgeMod.estimateTokens('1234')).toBe(4);
    expect(bridgeMod.estimateTokens('héllo')).toBe(6); // é is two bytes
    expect(bridgeMod.estimateTokens('日本語')).toBe(9);
    expect(bridgeMod.estimateTokens('')).toBe(0);
  });

  test('capReply fits the byte bound whatever the text: punctuation, identifiers, digits and other scripts', () => {
    const samples = [
      'Su próxima visita está programada para mañana por la tarde. '.repeat(30),
      'ID: a1-b2_c3/d4#e5@f6 | '.repeat(80),
      '日本語のテキストです。'.repeat(80),
      '1234567890 '.repeat(120),
    ];
    for (const sample of samples) {
      const cut = bridgeMod.capReply(sample);
      expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(bridgeMod.BRAIN_REPLY_MAX_TOKENS);
      expect(cut.length).toBeLessThanOrEqual(bridgeMod.BRAIN_REPLY_MAX_CHARS);
      expect(cut.length).toBeGreaterThan(0);
    }
    expect(bridgeMod.capReply('A short one. ')).toBe('A short one.');
  });

  test('a brain that is slow to open: the first delegation gets the fixed sentence within the bound, then the late brain serves the next', async () => {
    let open;
    const brain = { ask: jest.fn(async () => 'late brain answer'), end: jest.fn(async () => {}), softTimeouts: 0, hardTimeouts: 0 };
    const { t } = toolsSetup({ brainOpen: () => new Promise((resolve) => { open = () => resolve(brain); }), deps: { brainOpenMs: 30 } });
    await t.ready();
    t.openai.receive(said('first', 0, 300));
    t.openai.receive(created('d1'));
    t.openai.receive(said('second', 6000, 6300));
    t.openai.receive(created('d2'));
    await waitFor(() => answers(t).length === 1);
    expect(answers(t)[0]).toEqual({ type: 'session.commentary.append', delegation_id: 'd1', content: DELEGATION_REPLY });
    open(); // the brain finishes opening after the bound
    await waitFor(() => answers(t).length === 2);
    t.twilioStop();
    await finalized(t);
    expect(summaryOf(t).errors).toContain('brain_open_timeout');
  });

  test('overlapping delegations with a settle wait: the first one\'s prompt is frozen when the next arrives, and its timer never replaces it', async () => {
    const { t, brain } = toolsSetup({ deps: { transcriptQuietMs: 40, transcriptMaxWaitMs: 1000 } });
    await t.ready();
    t.openai.receive(said('Old words', 0, 600));
    t.openai.receive(created('d0'));
    await waitFor(() => answers(t).length === 1);
    // d1 arrives with nothing new, then d2 arrives before d1's settle wait is over
    t.openai.receive(created('d1'));
    t.openai.receive(created('d2'));
    // the late tail of d2's own question (its audio runs on from the delegation): it joins d2's open range
    t.openai.receive(said('Late question', 700, 1100));
    await waitFor(() => answers(t).length === 3);
    expect(brain.ask.mock.calls.map((c) => c[0])).toEqual(['Old words', 'Old words', 'Late question']);
  });

  test('a new question that starts after the delegation (a delayed transcript batch) is kept out of the preceding delegation', async () => {
    const { t, brain } = toolsSetup({ deps: { transcriptQuietMs: 60, transcriptMaxWaitMs: 1000 } });
    await t.ready();
    t.openai.receive(said('Old words', 0, 600));
    t.openai.receive(created('d0'));
    await waitFor(() => answers(t).length === 1);
    // d1 arrives (GPT-Live's clock at 5,000 ms) with nothing new, and its settle window is open...
    t.openai.receive({ ...created('d1'), offset_ms: 5000 });
    // ...a late tail of d1's own question (audio before the delegation) joins it
    t.openai.receive(said('tail', 4800, 5000));
    // ...and the caller's NEXT question, whose audio starts well after the delegation, does not
    t.openai.receive(said('A brand new question', 9000, 10000));
    await waitFor(() => answers(t).length === 2);
    t.openai.receive({ ...created('d2'), offset_ms: 10500 });
    await waitFor(() => answers(t).length === 3);
    expect(brain.ask.mock.calls.map((c) => c[0])).toEqual(['Old words', 'tail', 'A brand new question']);
  });

  test('a delegation with no words keeps the fallback it had on arrival: the next question, arriving while it settles, never becomes its fallback', async () => {
    const { t, brain } = toolsSetup({ deps: { transcriptQuietMs: 60, transcriptMaxWaitMs: 1000 } });
    await t.ready();
    t.openai.receive(said('Old words', 0, 600));
    t.openai.receive(created('d0'));
    await waitFor(() => answers(t).length === 1);
    // d1 arrives with nothing new; its settle window opens
    t.openai.receive({ ...created('d1'), offset_ms: 5000 });
    // the caller's next question arrives during that window, well after the delegation: it is NOT d1's tail
    t.openai.receive(said('The next question', 9000, 9800));
    await waitFor(() => answers(t).length === 2);
    t.openai.receive({ ...created('d2'), offset_ms: 10000 });
    await waitFor(() => answers(t).length === 3);
    expect(brain.ask.mock.calls.map((c) => c[0])).toEqual(['Old words', 'Old words', 'The next question']);
  });

  test('the agent line is the one right before the caller\'s NEWEST utterance: "the second one" names the offer, not the greeting', async () => {
    const { t, brain } = toolsSetup();
    await t.ready();
    const agent = (words, start, end) => ({ type: 'session.output_transcript.delta', delta: words, start_ms: start, end_ms: end });
    t.openai.receive(agent('Thanks for calling Waves, how can I help?', 0, 2500));
    t.openai.receive(said('Hello.', 3000, 3600));
    t.openai.receive(agent('I can help with pest control or lawn care. Which one?', 4500, 8000));
    t.openai.receive(said(' What is the price of the second one?', 9500, 11000));
    t.openai.receive(created('d1'));
    await waitFor(() => answers(t).length === 1);
    expect(brain.ask.mock.calls[0][0]).toBe('Agent just said: I can help with pest control or lawn care. Which one?\nCaller said: Hello. What is the price of the second one?');
  });

  test('deadlines count from the delegation\'s arrival: a queued delegation gets what is left, and one past its hard deadline gets the timeout line with no model call', async () => {
    const { TIMEOUT_REPLY } = require('../services/voice-agent/live-brain');
    let releaseFirst;
    let n = 0;
    const { t, brain } = toolsSetup({
      reply: (text) => {
        n += 1;
        if (n === 1) return new Promise((resolve) => { releaseFirst = () => resolve('reply one'); });
        t.advance(3000); // the second answer itself takes 3 s
        return Promise.resolve('reply two');
      },
    });
    await t.ready();
    t.openai.receive(said('one', 0, 300));
    t.openai.receive(created('d1'));
    await waitFor(() => brain.ask.mock.calls.length === 1);
    t.openai.receive(said('two', 6000, 6300));
    t.openai.receive(created('d2'));
    t.openai.receive(said('three', 12000, 12300));
    t.openai.receive(created('d3'));
    t.advance(18000); // the first lookup runs 18 s; d2 and d3 wait behind it
    releaseFirst();
    await waitFor(() => answers(t).length === 3);
    // d2 waited 18 s: its holding line is already due and it has 2 s left
    expect(brain.ask.mock.calls[1][1]).toMatchObject({ softMs: 0, deadlineMs: 2000 });
    // d3 waited 18 s + 3 s = 21 s: past 20 s, so no model call, the timeout line
    expect(brain.ask).toHaveBeenCalledTimes(2);
    expect(answers(t)[2]).toEqual({ type: 'session.commentary.append', delegation_id: 'd3', content: TIMEOUT_REPLY });
    t.twilioStop();
    await finalized(t);
    const summary = summaryOf(t);
    expect(summary.brain_asks).toBe(2); // the expired one is not an ask
    expect(summary.errors).toContain('brain_expired_in_queue');
  });

  test('an arrival timer answers a delegation still queued at its hard deadline, while the ask ahead of it runs, and its turn then skips it', async () => {
    const { TIMEOUT_REPLY } = require('../services/voice-agent/live-brain');
    let releaseFirst;
    const { t, brain } = toolsSetup({
      reply: () => new Promise((resolve) => { releaseFirst = () => resolve('reply one'); }),
      deps: { brainHardMs: 60, brainSoftMs: 30 },
    });
    await t.ready();
    t.openai.receive(said('one', 0, 300));
    t.openai.receive(created('d1'));
    await waitFor(() => brain.ask.mock.calls.length === 1);
    t.openai.receive(said('two', 6000, 6300));
    t.openai.receive(created('d2'));
    // d1's ask runs on; d2 waits behind it and its own 60 ms run out
    await waitFor(() => answers(t).filter((m) => m.delegation_id === 'd2').length === 2);
    // its holding line at its own 30 ms (armed at arrival), then the timeout line at 60 ms
    expect(answers(t).filter((m) => m.delegation_id === 'd2').map((m) => m.content)).toEqual(['Still pulling that up.', TIMEOUT_REPLY]);
    expect(brain.ask).toHaveBeenCalledTimes(1);
    releaseFirst();
    await waitFor(() => answers(t).some((m) => m.delegation_id === 'd1'));
    await flush();
    expect(answers(t).filter((m) => m.delegation_id === 'd2')).toHaveLength(2); // its turn came and skipped it: no further line, no ask
    expect(brain.ask).toHaveBeenCalledTimes(1);
    t.twilioStop();
    await finalized(t);
    expect(summaryOf(t)).toMatchObject({ brain_asks: 1 });
    expect(summaryOf(t).errors).toContain('brain_expired_in_queue');
  });

  test('the holding line is armed at ARRIVAL: a queued delegation hears it at its own soft deadline, once, never again when its ask runs', async () => {
    let releaseFirst;
    const { t, brain } = toolsSetup({
      reply: (text, opts) => new Promise((resolve) => {
        if (text.includes('two') && opts.onSoft) opts.onSoft(); // the brain's own timer also fires for the second ask
        resolve(text.includes('one') ? undefined : 'reply two');
      }).then((r) => r || new Promise((resolve) => { releaseFirst = () => resolve('reply one'); })),
      deps: { brainHardMs: 2000, brainSoftMs: 40 },
    });
    await t.ready();
    t.openai.receive(said('one', 0, 300));
    t.openai.receive(created('d1'));
    await waitFor(() => brain.ask.mock.calls.length === 1);
    t.openai.receive(said('two', 6000, 6300));
    t.openai.receive(created('d2'));
    // d2 is still queued behind d1's running ask, yet it hears its own holding line at ~40 ms after ITS arrival
    await waitFor(() => answers(t).some((m) => m.delegation_id === 'd2'));
    expect(brain.ask).toHaveBeenCalledTimes(1);
    expect(answers(t).filter((m) => m.delegation_id === 'd2')).toEqual([{ type: 'session.commentary.append', delegation_id: 'd2', content: 'Still pulling that up.' }]);
    releaseFirst();
    await waitFor(() => answers(t).some((m) => m.delegation_id === 'd2' && m.content === 'reply two'));
    // d2's ask ran later and its brain timer called onSoft too: still one holding line for d2, one for d1 at most
    const d2 = answers(t).filter((m) => m.delegation_id === 'd2').map((m) => m.content);
    expect(d2).toEqual(['Still pulling that up.', 'reply two']);
    t.twilioStop();
    await finalized(t);
  });

  test('a delegation that expires in the queue hears the holding line first, then the timeout line, and nothing else', async () => {
    const { TIMEOUT_REPLY } = require('../services/voice-agent/live-brain');
    const { t, brain } = toolsSetup({ reply: () => new Promise(() => {}), deps: { brainHardMs: 200, brainSoftMs: 40 } });
    await t.ready();
    t.openai.receive(said('one', 0, 300));
    t.openai.receive(created('d1'));
    await waitFor(() => brain.ask.mock.calls.length === 1);
    t.openai.receive(said('two', 6000, 6300));
    t.openai.receive(created('d2'));
    await waitFor(() => answers(t).filter((m) => m.delegation_id === 'd2').length === 2, 3000);
    expect(answers(t).filter((m) => m.delegation_id === 'd2').map((m) => m.content)).toEqual(['Still pulling that up.', TIMEOUT_REPLY]);
    await new Promise((r) => setTimeout(r, 120));
    expect(answers(t).filter((m) => m.delegation_id === 'd2')).toHaveLength(2);
    expect(brain.ask).toHaveBeenCalledTimes(1);
    t.twilioStop();
    await finalized(t);
  });

  test('a delegation answered before its soft deadline never hears the holding line', async () => {
    const { t } = toolsSetup({ deps: { brainHardMs: 2000, brainSoftMs: 80 } });
    await t.ready();
    t.openai.receive(said('quick one', 0, 300));
    t.openai.receive(created('d1'));
    await waitFor(() => answers(t).length === 1);
    await new Promise((r) => setTimeout(r, 160));
    expect(answers(t).map((m) => m.content)).toEqual(['Your next visit is Tuesday.']);
    t.twilioStop();
    await finalized(t);
  });

  describe('caller words keep their boundaries across fragments', () => {
    const asked = async (frags) => {
      const { t, brain } = toolsSetup();
      await t.ready();
      for (const [text, start, end] of frags) t.openai.receive(said(text, start, end));
      t.openai.receive(created('d1'));
      await waitFor(() => brain.ask.mock.calls.length === 1);
      const text = brain.ask.mock.calls[0][0];
      t.twilioStop();
      await finalized(t);
      return text;
    };

    test('deltas of one utterance join raw: a number or a word split across deltas stays whole', async () => {
      expect(await asked([['how much for a 2', 0, 300], [',500', 300, 600], [' square foot home, pest', 600, 900], ['icide', 900, 1100]])).toBe('how much for a 2,500 square foot home, pesticide');
    });

    test('fragments that carry their own spaces are not double-spaced', async () => {
      expect(await asked([['how much for ', 0, 300], ['a 2400', 300, 600], [' square foot ', 600, 900], ['home', 900, 1100]])).toBe('how much for a 2400 square foot home');
    });

    test('two utterances get one space between them, whether or not a side carries whitespace', async () => {
      expect(await asked([['First thing.', 0, 800], ['Second thing.', 3000, 3800]])).toBe('First thing. Second thing.');
      expect(await asked([['First thing. ', 0, 800], [' Second thing.', 3000, 3800]])).toBe('First thing. Second thing.');
    });

    test('two spoken measurements in separate utterances reach the brain as two numbers', async () => {
      expect(await asked([['forty', 0, 400], ['five hundred square feet', 2500, 3000]])).toBe('forty five hundred square feet');
      expect(await asked([['1800', 0, 400], ['2200', 2500, 3000]])).toBe('1800 2200');
    });

    test('a whitespace-only fragment and closing punctuation keep the words apart without stray spaces', async () => {
      expect(await asked([['two', 0, 200], [' ', 200, 250], ['bedrooms', 250, 600], ['?', 600, 650]])).toBe('two bedrooms?');
    });
  });

  test('a stalled brain open never holds a delegation past its own hard deadline: the open wait is capped to what is left', async () => {
    const { TIMEOUT_REPLY } = require('../services/voice-agent/live-brain');
    const { t, brain } = toolsSetup({ brainOpen: () => new Promise(() => {}), deps: { brainHardMs: 50, brainOpenMs: 4000, brainSoftMs: 20, closeWaitMs: 20 } });
    await t.ready();
    t.openai.receive(said('first', 0, 300));
    t.openai.receive(created('d1'));
    t.openai.receive(said('second', 6000, 6300));
    t.openai.receive(created('d2'));
    await waitFor(() => answers(t).filter((m) => m.content === TIMEOUT_REPLY).length === 2, 3000); // both well before the 4 s open wait would have ended
    // each hears its holding line at its own 20 ms (armed at arrival) before the timeout line
    expect(answers(t).filter((m) => m.delegation_id === 'd1').map((m) => m.content)).toEqual(['Still pulling that up.', TIMEOUT_REPLY]);
    expect(answers(t).filter((m) => m.delegation_id === 'd2').map((m) => m.content)).toEqual(['Still pulling that up.', TIMEOUT_REPLY]);
    expect(brain.ask).not.toHaveBeenCalled();
    t.twilioStop();
    await finalized(t);
    expect(summaryOf(t).errors).toContain('brain_expired_in_queue');
  });

  test('a retired brain\'s reply is neither counted as an ask nor timed', async () => {
    const { t, brain } = toolsSetup({ reply: async () => 'real answer' });
    await t.ready();
    t.openai.receive(said('first', 0, 300));
    t.openai.receive(created('d1'));
    await waitFor(() => answers(t).length === 1);
    brain.ask.mockImplementation(async () => { brain.lastRan = false; return "I can't pull that up right now. You can call or text the office for that."; });
    t.openai.receive(said('second', 6000, 6300));
    t.openai.receive(created('d2'));
    await waitFor(() => answers(t).length === 2);
    expect(answers(t)[1].content).toMatch(/can't pull that up/);
    t.twilioStop();
    await finalized(t);
    const summary = summaryOf(t);
    expect(summary.brain_asks).toBe(1);
    expect(summary.brain_ms).toHaveLength(1);
    expect(summary.brain_wait_ms).toHaveLength(1);
    expect(summary.brain_total_ms).toHaveLength(1);
  });

  test('a delegation\'s context is frozen when its range closes: later speech changes neither its words nor its fallback', async () => {
    let releaseFirst;
    let calls = 0;
    const { t, brain } = toolsSetup({
      reply: () => { calls += 1; return calls === 1 ? new Promise((resolve) => { releaseFirst = () => resolve('r1'); }) : Promise.resolve('r2'); },
    });
    await t.ready();
    t.openai.receive(said('question one', 0, 600));
    t.openai.receive(created('d1'));
    await waitFor(() => brain.ask.mock.calls.length === 1);
    // d2 arrives with no new words (its fallback is the latest two utterances AS OF NOW)...
    t.openai.receive(created('d2'));
    // ...and the caller then asks something else, and GPT-Live speaks, before d2 reaches the front
    t.openai.receive(said('a different question', 9000, 9600));
    t.openai.receive({ type: 'session.output_transcript.delta', delta: 'Sure thing.', start_ms: 9700, end_ms: 10000 });
    releaseFirst();
    await waitFor(() => answers(t).length === 2);
    expect(brain.ask.mock.calls[1][0]).toBe('question one'); // frozen: not 'a different question'
  });

  test('two delegations are served one at a time, in order: the second brain ask starts after the first reply is sent', async () => {
    let releaseFirst;
    const events = [];
    const { t, brain } = toolsSetup({
      reply: (text) => {
        events.push(`ask:${text}`);
        if (text === 'one') return new Promise((resolve) => { releaseFirst = () => resolve('reply one'); });
        return Promise.resolve('reply two');
      },
    });
    await t.ready();
    t.openai.receive(said('one', 0, 300));
    t.openai.receive(created('d1'));
    await waitFor(() => brain.ask.mock.calls.length === 1);
    t.openai.receive(said('two', 5000, 5300));
    t.openai.receive(created('d2'));
    await flush();
    expect(brain.ask).toHaveBeenCalledTimes(1); // d2 waits behind d1
    expect(answers(t)).toHaveLength(0);
    releaseFirst();
    await waitFor(() => answers(t).length === 2);
    expect(events).toEqual(['ask:one', 'ask:two']);
    expect(answers(t)).toEqual([
      { type: 'session.commentary.append', delegation_id: 'd1', content: 'reply one' },
      { type: 'session.commentary.append', delegation_id: 'd2', content: 'reply two' },
    ]);
  });

  test(`after ${bridgeMod.BRAIN_ASK_CAP} asks the call goes back to the fixed sentence`, async () => {
    const { t, brain } = toolsSetup();
    await t.ready();
    for (let i = 1; i <= bridgeMod.BRAIN_ASK_CAP + 2; i++) {
      t.openai.receive(said(`question ${i}`, i * 5000, i * 5000 + 400));
      t.openai.receive(created(`d${i}`));
    }
    await waitFor(() => answers(t).length === bridgeMod.BRAIN_ASK_CAP + 2);
    expect(brain.ask).toHaveBeenCalledTimes(bridgeMod.BRAIN_ASK_CAP);
    expect(answers(t).slice(-2).map((m) => m.content)).toEqual([DELEGATION_REPLY, DELEGATION_REPLY]);
    t.twilioStop();
    await finalized(t);
    expect(summaryOf(t)).toMatchObject({ brain_asks: bridgeMod.BRAIN_ASK_CAP, delegations: bridgeMod.BRAIN_ASK_CAP + 2 });
  });

  test('a brain error answers the fixed sentence, notes a code, and the next delegation still asks', async () => {
    let n = 0;
    const { t, brain } = toolsSetup({ reply: async () => { n += 1; if (n === 1) throw new Error('model down'); return 'ok now'; } });
    await t.ready();
    t.openai.receive(said('first', 0, 300));
    t.openai.receive(created('d1'));
    await waitFor(() => answers(t).length === 1);
    t.openai.receive(said('second', 6000, 6300));
    t.openai.receive(created('d2'));
    await waitFor(() => answers(t).length === 2);
    expect(brain.ask).toHaveBeenCalledTimes(2);
    expect(answers(t).map((m) => m.content)).toEqual([DELEGATION_REPLY, 'ok now']);
    t.twilioStop();
    await finalized(t);
    expect(summaryOf(t).errors).toEqual(['brain_error']);
  });

  test('a brain that cannot open (not a sandbox row, or any failure) answers the fixed sentence', async () => {
    const { t } = toolsSetup({ brainOpen: async () => { throw new Error('live_brain_not_sandbox'); } });
    await t.ready();
    t.openai.receive(said('hello there', 0, 300));
    t.openai.receive(created('d1'));
    await waitFor(() => answers(t).length === 1);
    expect(answers(t)[0].content).toBe(DELEGATION_REPLY);
    t.twilioStop();
    await finalized(t);
    expect(summaryOf(t).errors).toEqual(['brain_open_failed']);
    expect(summaryOf(t)).toMatchObject({ brain_asks: 0 });
  });

  test('an empty reply is never sent as silence', async () => {
    const { t } = toolsSetup({ reply: async () => '  ' });
    await t.ready();
    t.openai.receive(said('anything', 0, 300));
    t.openai.receive(created('d1'));
    await waitFor(() => answers(t).length === 1);
    expect(answers(t)[0].content).toMatch(/wasn't able to get that/);
  });

  test('finalize ends the brain, and a reply that lands after the call ended is not sent', async () => {
    let release;
    const { t, brain } = toolsSetup({ reply: () => new Promise((resolve) => { release = () => resolve('too late'); }) });
    await t.ready();
    t.openai.receive(said('slow one', 0, 300));
    t.openai.receive(created('d1'));
    await waitFor(() => brain.ask.mock.calls.length === 1);
    t.twilioStop();
    await finalized(t);
    expect(brain.end).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(answers(t)).toHaveLength(0);
  });

  test('a brain that finishes opening after the call ended is ended at once', async () => {
    let open;
    const brain = { ask: jest.fn(), end: jest.fn(async () => {}), softTimeouts: 0, hardTimeouts: 0 };
    const { t } = toolsSetup({ brainOpen: () => new Promise((resolve) => { open = () => resolve(brain); }), deps: { closeWaitMs: 20 } });
    await t.ready();
    t.twilioStop();
    await finalized(t);
    open();
    await flush();
    expect(brain.end).toHaveBeenCalledWith('bridge_closed');
  });

  test('a slow ask speaks a holding line on the same delegation id, then the real answer as a second append', async () => {
    let finish;
    const { t, brain } = toolsSetup({
      reply: (text, opts) => new Promise((resolve) => { opts.onSoft(); finish = () => resolve('Tuesday at nine.'); }),
    });
    await t.ready();
    t.openai.receive(said('When is my visit?', 0, 800));
    t.openai.receive(created('d1'));
    await waitFor(() => answers(t).length === 1);
    expect(answers(t)).toEqual([{ type: 'session.commentary.append', delegation_id: 'd1', content: 'Still pulling that up.' }]);
    finish();
    await waitFor(() => answers(t).length === 2);
    expect(answers(t).map((m) => [m.delegation_id, m.content])).toEqual([['d1', 'Still pulling that up.'], ['d1', 'Tuesday at nine.']]);
    expect(brain.ask).toHaveBeenCalledTimes(1);
  });

  test('a holding line is not sent once the call is closing', async () => {
    let soft;
    const { t, brain } = toolsSetup({ reply: (text, opts) => new Promise(() => { soft = opts.onSoft; }) });
    await t.ready();
    t.openai.receive(said('hello there', 0, 800));
    t.openai.receive(created('d1'));
    await waitFor(() => brain.ask.mock.calls.length === 1);
    t.twilioStop();
    await finalized(t);
    soft();
    expect(answers(t)).toHaveLength(0);
  });

  test('the brain gets what GPT-Live said just before the caller\'s words, labelled', async () => {
    const { t, brain } = toolsSetup();
    await t.ready();
    const agent = (words, start, end) => ({ type: 'session.output_transcript.delta', delta: words, start_ms: start, end_ms: end });
    t.openai.receive(agent('I have Tuesday at nine or Wednesday at ten. ', 1000, 4000));
    t.openai.receive(agent('Which works?', 4000, 5000));
    t.openai.receive(said('Yes, the second one.', 6500, 7500));
    t.openai.receive(agent('One sec, checking that.', 8000, 9000)); // after the caller: not context
    t.openai.receive(created('d1'));
    await waitFor(() => answers(t).length === 1);
    expect(brain.ask.mock.calls[0][0]).toBe('Agent just said: I have Tuesday at nine or Wednesday at ten. Which works?\nCaller said: Yes, the second one.');
  });

  test('the agent context is the latest 300 characters, and absent when GPT-Live said nothing before', async () => {
    const { t, brain } = toolsSetup();
    await t.ready();
    t.openai.receive(said('Hello, who is this?', 100, 900));
    t.openai.receive(created('d1'));
    await waitFor(() => answers(t).length === 1);
    expect(brain.ask.mock.calls[0][0]).toBe('Hello, who is this?');
    t.openai.receive({ type: 'session.output_transcript.delta', delta: `${'a'.repeat(400)}END`, start_ms: 2000, end_ms: 3000 });
    t.openai.receive(said('Okay.', 5000, 5500));
    t.openai.receive(created('d2'));
    await waitFor(() => answers(t).length === 2);
    const prompt = brain.ask.mock.calls[1][0];
    expect(prompt.startsWith('Agent just said: ')).toBe(true);
    expect(prompt.endsWith('END\nCaller said: Okay.')).toBe(true);
    expect(prompt.split('\n')[0].length).toBe('Agent just said: '.length + 300);
  });

  test('gate off: GPT-Live\'s transcript is not kept and nothing is asked', async () => {
    const t = setup({ deps: { toolsOn: () => false } });
    await t.ready();
    t.openai.receive({ type: 'session.output_transcript.delta', delta: 'hi', start_ms: 0, end_ms: 100 });
    expect(t.bridge.agentRecent).toEqual([]);
  });

  test('the summary counts asks, soft and hard timeouts and each ask\'s timing parts, and holds no words', async () => {
    const { t, brain } = toolsSetup({
      reply: async () => { t.advance(700); return 'Your next visit is Tuesday, the secret-gate-code reply.'; },
    });
    await t.ready();
    brain.softTimeouts = 2; // what the real brain counts
    brain.hardTimeouts = 1;
    t.advance(300);
    t.openai.receive(said('my card is 4111 1111 1111 1111', 0, 900));
    t.openai.receive(created('d1'));
    await waitFor(() => answers(t).length === 1);
    t.twilioStop();
    await finalized(t);
    const summary = summaryOf(t);
    expect(summary).toMatchObject({
      delegations: 1, brain_asks: 1, brain_soft_timeouts: 2, brain_hard_timeouts: 1, brain_wait_ms: [0], brain_ms: [700], brain_total_ms: [700],
    });
    const stored = JSON.stringify(summary);
    expect(stored).not.toMatch(/4111|secret-gate-code|visit is Tuesday/);
    // nothing the caller or the brain said reaches a log line either
    const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
    expect(logged).not.toMatch(/4111|secret-gate-code|visit is Tuesday/);
  });

  test('the summary records, per ask, the model rounds (counts only; the practice line has no paid tool)', async () => {
    let n = 0;
    const { t, brain } = toolsSetup({ reply: async () => { n += 1; brain.lastUsage = { rounds: n + 1 }; return `reply ${n}`; } });
    await t.ready();
    t.openai.receive(said('first', 0, 300));
    t.openai.receive(created('d1'));
    t.openai.receive(said('second', 6000, 6300));
    t.openai.receive(created('d2'));
    await waitFor(() => answers(t).length === 2);
    t.twilioStop();
    await finalized(t);
    const summary = summaryOf(t);
    expect(summary).toMatchObject({ brain_asks: 2, brain_rounds: [2, 3] });
    expect(summary).not.toHaveProperty('brain_paid_tool_calls');
  });

  test('a queued delegation\'s wait before the brain starts includes the ask ahead of it', async () => {
    const { t } = toolsSetup({ reply: async () => { t.advance(1000); return 'ok'; } });
    await t.ready();
    t.openai.receive(said('one', 0, 300));
    t.openai.receive(created('d1'));
    t.openai.receive(said('two', 5000, 5300));
    t.openai.receive(created('d2'));
    await waitFor(() => answers(t).length === 2);
    t.twilioStop();
    await finalized(t);
    expect(summaryOf(t)).toMatchObject({ brain_wait_ms: [0, 1000], brain_ms: [1000, 1000], brain_total_ms: [1000, 2000] });
  });

  test('a delegation to another target still ends the call in tools mode, and asks nothing', async () => {
    const { t, brain } = toolsSetup();
    await t.ready();
    t.openai.receive(created('d2', 'responses'));
    await flush();
    expect(brain.ask).not.toHaveBeenCalled();
    expect(summaryOf(t)).toMatchObject({ close_reason: 'unexpected_delegation' });
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
      caller_voiced_pct: 100, // the one caller frame of this call holds voice
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

  test('once shutdown begins (session.close sent), nothing more is sent to OpenAI: not caller audio, not on a late session.started', async () => {
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

  test('shutdown that begins before session.started: a late session.started does not send the held opening audio', async () => {
    const t = setup({ closeReply: false, deps: { closeWaitMs: 50 } });
    await t.twilioStart();
    t.openai.emit('open');
    for (let i = 0; i < 10; i++) t.twilioMedia(); // the caller is speaking while OpenAI starts
    const done = t.bridge.finalize('cap');
    t.openai.receive({ type: 'session.started', session: { id: 's1' } });
    expect(t.openai.types()).not.toContain('session.input_audio.append');
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
