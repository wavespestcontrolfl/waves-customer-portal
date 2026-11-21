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

// Time passes with the model silent, as the live stream is between utterances:
// digital silence in 100 ms chunks at real-time pacing. An arrival gap alone
// (t.advance) carries no silent audio, so it marks no reply.
const quiet = (t, ms) => {
  for (let left = ms; left > 0; left -= 100) {
    const chunk = Math.min(100, left);
    t.openai.receive({ type: 'session.output_audio.delta', delta: silence(chunk * 8) });
    t.advance(chunk);
  }
};

// callerAudio: every clock advance after session.started also delivers that
// much caller audio, as Twilio does on a call. `speech` lists when the caller
// speaks, as [from, to] in ms after session.started: audio inside it is voiced,
// the rest is silent. The bridge takes the caller's speech end from this
// audio, never from a transcript's start_ms or end_ms.
function setup({ closeReply = true, deps = {}, callerAudio = true, speech = [] } = {}) {
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
  const callerFrame = (payload) => twilio.emit('message', JSON.stringify({ event: 'media', media: { track: 'inbound', payload } }));
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
      if (!(callerAudio && ms > 0 && bridge.ready && !bridge._finalizing)) {
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
        callerFrame(voiced ? b64((cut - from) * 8) : silence((cut - from) * 8));
        from = cut;
      }
    },
    // The caller speaks for `ms`: one voiced 20 ms frame every 20 ms.
    speak: (ms) => {
      for (let i = 0; i < ms; i += 20) {
        clock += 20;
        callerFrame(b64(160));
      }
    },
    tick: () => clock,
    // OpenAI opens after the reservation is admitted (async), so wait it out.
    twilioStart: async (callSid = CALL_SID) => {
      twilio.emit('message', JSON.stringify({ event: 'start', start: { callSid, streamSid: STREAM_SID } }));
      await flush();
    },
    // The default frame is silent ('////' is three 0xFF bytes): a caller frame with voice is a speech end.
    twilioMedia: (payload = '////') => callerFrame(payload),
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
    expect(sent).toHaveLength(16); // 5 frames of lead, the voiced frame, the 10 after it
    expect(sent[5]).toBe(frameOf(0x00));
  });

  test('one stray sample at speech level in a silent frame is not voice for timing', async () => {
    const t = setup();
    await t.twilioStart();
    t.openai.emit('open');
    const click = Buffer.alloc(160, 0xff);
    click[80] = 0xbf; // one sample of 1980: the frame's RMS is 157, under the voice level of 300
    t.twilioMedia(click.toString('base64'));
    t.openai.receive({ type: 'session.started', session: { id: 's1' } });
    await flush();
    expect(t.bridge.callerVoiceAt).toBe(null);
    expect(t.bridge.callerVoicedMs).toBe(0);
  });

  test('a caller frame is voice for timing from RMS 300: 292 is not, 308 is', async () => {
    const t = setup();
    await t.ready();
    t.twilioMedia(frameOf(0xe5)); // every sample 292
    expect(t.bridge.callerVoiceAt).toBe(null);
    t.twilioMedia(frameOf(0xe4)); // every sample 308
    expect(t.bridge.callerVoiceAt).toBe(t.tick());
    expect(t.bridge.callerVoicedMs).toBe(20);
  });

  test('quiet speech in the held opening audio, under the voice level, is still sent: the opening audio is cut at a lower level than timing uses', async () => {
    const t = setup();
    await t.twilioStart();
    t.openai.emit('open');
    for (let i = 0; i < 20; i++) t.twilioMedia(silence(160));
    for (let i = 0; i < 10; i++) t.twilioMedia(frameOf(0xee)); // a soft "hello": every sample 148, under the voice level of 300
    for (let i = 0; i < 5; i++) t.twilioMedia(silence(160));
    t.openai.receive({ type: 'session.started', session: { id: 's1' } });
    await flush();
    const sent = t.openai.sent.filter((m) => m.audio).map((m) => m.audio);
    expect(sent).toHaveLength(20); // 5 frames of lead, the 10 quiet frames, the 5 after them
    expect(sent[5]).toBe(frameOf(0xee));
    expect(sent[14]).toBe(frameOf(0xee));
    expect(t.bridge.callerVoiceAt).toBe(null); // and it is not voice for timing
  });

  test('held line noise under the sound level (RMS 100) is dropped like silence; at that level the held audio is sent', async () => {
    const hold = async (byte) => {
      const t = setup();
      await t.twilioStart();
      t.openai.emit('open');
      for (let i = 0; i < 80; i++) t.twilioMedia(frameOf(byte));
      t.openai.receive({ type: 'session.started', session: { id: 's1' } });
      await flush();
      return t.openai.sent.filter((m) => m.audio).length;
    };
    expect(await hold(0xfa)).toBe(0); // every sample 40
    expect(await hold(0xf3)).toBe(0); // every sample 96
    expect(await hold(0xf2)).toBe(80); // every sample 104
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
    const t = setup({ speech: [[1300, 1600]] });
    await t.ready();
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
    quiet(t, 1000);
    streamReply(t, 6); // a reply streams +1000..+1500, plays to +2200
    t.advance(100);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'wait', start_ms: 1300, end_ms: 1500 }); // barge-in at +1600
    t.advance(50);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(320) }); // the old reply's tail
    t.advance(50);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(320) }); // more tail
    quiet(t, 900); // the model stops: 900 ms of silent audio
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // the real next reply at +2600
    t.twilioStop();
    await flush();
    const payloads = t.twilio.sent.filter((m) => m.event === 'media').map((m) => m.media.payload);
    expect(payloads).not.toContain(b64(320)); // no restart mid-sentence
    expect(payloads.filter((p) => p === b64(160))).toHaveLength(2); // the greeting and the next reply
    // +2600 is 1000 ms after the barge-in, inside the 1.5 s tail window: the
    // delay is kept apart from turns
    expect(summaryOf(t)).toMatchObject({ turns: [], after_barge_in_ambiguous_ms: [1100] });
  });

  test('a reply right after a barge-in, 800 ms of silent audio after the old one, is played, not dropped as tail, and timed apart', async () => {
    const t = setup({ speech: [[1300, 1500]] });
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0
    quiet(t, 1000);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(8000) }); // whole reply at +1000, plays to +2000
    quiet(t, 600);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'wait', start_ms: 1300, end_ms: 1500 }); // clear at +1600
    quiet(t, 200);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(240) }); // a new reply 200 ms after the clear
    t.twilioStop();
    await flush();
    expect(t.twilio.sent.some((m) => m.event === 'media' && m.media.payload === b64(240))).toBe(true);
    expect(summaryOf(t)).toMatchObject({ turns: [], after_barge_in_ambiguous_ms: [300] }); // +1800 minus +1500
  });

  test('a final transcript fragment that lands after an ambiguous reply began refines that sample, never turns', async () => {
    const t = setup({ speech: [[1300, 2100]] });
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0
    quiet(t, 1000);
    streamReply(t, 6); // a reply streams +1000..+1500
    t.advance(100);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'wait', start_ms: 1300, end_ms: 1500 }); // barge-in at +1600
    quiet(t, 800);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // ambiguous reply at +2400: 900 provisional
    t.advance(100);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'hold on', start_ms: 1500, end_ms: 2100 }); // the final fragment
    t.twilioStop();
    await flush();
    const s = summaryOf(t);
    expect(s.after_barge_in_ambiguous_ms).toEqual([300]); // +2400 minus the real speech end +2100
    expect(s.turns).toEqual([]);
  });

  test('two replies inside one barge-in window, with a transcript fragment between them, are both kept apart from turns', async () => {
    const t = setup({ speech: [[1300, 1500], [1900, 2050]] });
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0
    quiet(t, 1000);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(8000) }); // whole reply at +1000, plays to +2000
    quiet(t, 600);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'wait', start_ms: 1300, end_ms: 1500 }); // barge-in at +1600: the window runs to +3100
    quiet(t, 200);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // a reply at +1800, after 800 ms of silent audio
    quiet(t, 300);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'no', start_ms: 1900, end_ms: 2050 }); // at +2100
    quiet(t, 500);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // another at +2600, still inside the window
    t.twilioStop();
    await flush();
    const s = summaryOf(t);
    expect(s.turns).toEqual([]);
    expect(s.after_barge_in_ambiguous_ms).toEqual([300, 550]);
  });

  test('a tail chunk delayed by a network stall is no reply: it is dropped and never timed; a later reply outside the window is a turn', async () => {
    const t = setup({ speech: [[1300, 1500], [2600, 2800]] });
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0
    quiet(t, 1000);
    streamReply(t, 6); // a reply streams +1000..+1500
    t.advance(100);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'wait', start_ms: 1300, end_ms: 1500 }); // barge-in at +1600
    t.advance(400);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(320) }); // the tail, stalled 400 ms: no silent audio came before it
    quiet(t, 1000);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'what about ants', start_ms: 2600, end_ms: 2800 }); // at +3000
    quiet(t, 500);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // a real reply at +3500
    t.twilioStop();
    await flush();
    expect(t.twilio.sent.some((m) => m.event === 'media' && m.media.payload === b64(320))).toBe(false);
    const s = summaryOf(t);
    expect(s.after_barge_in_ambiguous_ms).toEqual([]);
    expect(s.turns).toEqual([700]); // +3500 minus +2800
  });

  test('a fast reply that starts right as the last one finishes playing is timed', async () => {
    const t = setup({ speech: [[1700, 1900]] });
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0
    quiet(t, 1000);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(8000) }); // reply at +1000, plays to +2000
    quiet(t, 960);
    // the caller's short answer over the end of it: ends at +1900; its transcript at +1960 is too late to cut anything
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'yes', start_ms: 1700, end_ms: 1900 });
    quiet(t, 140);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // next reply at +2100
    t.twilioStop();
    await flush();
    expect(t.twilio.sent.filter((m) => m.event === 'clear')).toHaveLength(0);
    expect(summaryOf(t).turns).toEqual([200]);
  });

  test('a cut-off reply that keeps streaming is dropped for TAIL_DROP_MAX_MS at the most', async () => {
    const t = setup({ speech: [[1300, 1500]] });
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0
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
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'hello', start_ms: 0, end_ms: 400 });
    expect(t.twilio.sent.some((m) => m.event === 'clear')).toBe(false);
  });

  test('a delta with only the last 200 ms of playback left is not a barge-in', async () => {
    const t = setup({ speech: [[700, 850]] });
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(8000) });
    t.advance(900); // 100 ms left
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'yes', start_ms: 700, end_ms: 850 });
    expect(t.twilio.sent.some((m) => m.event === 'clear')).toBe(false);
  });

  test('a late transcript of words the caller finished before the reply began is not a barge-in: the answer keeps playing', async () => {
    const t = setup({ speech: [[1500, 1900]] });
    await t.ready();
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
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(8000) });
    t.advance(300);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'stop' });
    expect(t.twilio.sent.some((m) => m.event === 'clear')).toBe(false);
  });

  test('reply delay is the reply\'s first voiced audio minus the end of the caller speech; the greeting records none', async () => {
    const t = setup({ speech: [[5000, 6200]] });
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting: no turn yet
    quiet(t, 6500);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'when can you come', start_ms: 5000, end_ms: 6200 }); // the speech ended at +6200
    quiet(t, 900); // now +7400: 1200 ms
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
    const t = setup({ speech: [[1500, 1700]] });
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0
    quiet(t, 2000);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // a short reply starts at +2000
    quiet(t, 500);
    // speech that ended at +1700: its transcript arrives after the reply began
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'thanks', start_ms: 1500, end_ms: 1700 });
    quiet(t, 3000);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // the model speaks again, unprompted
    t.twilioStop();
    await flush();
    expect(summaryOf(t).turns).toEqual([300]);
  });

  test('the caller speaks on after the last fragment before the reply: the delay runs from the true end of speech, and the late fragment of it adds nothing', async () => {
    const t = setup({ speech: [[1000, 1700]] });
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0
    quiet(t, 1600);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'I need', start_ms: 1000, end_ms: 1500 }); // at +1600, the caller still speaking
    quiet(t, 400);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // reply at +2000: the caller's last sound was +1700
    t.advance(100);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: ' pest control', start_ms: 1500, end_ms: 1700 }); // late
    t.twilioStop();
    await flush();
    expect(summaryOf(t).turns).toEqual([300]);
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
    const t = setup({ speech: [[100, 250]] });
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
    const t = setup({ speech: [[100, 500]] });
    await t.ready();
    t.advance(800);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0 + 800
    t.advance(200);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'hello?', start_ms: 100, end_ms: 500 });
    t.twilioStop();
    await flush();
    expect(summaryOf(t).turns).toEqual([]);
  });

  test('a caller transcript that lands while the model is already talking times the reply from the speech end, never near zero', async () => {
    const t = setup({ speech: [[1500, 1700]] });
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting at t0
    quiet(t, 2000);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(8000) }); // reply starts: 1000 ms queued
    t.advance(100);
    // a late transcript of the caller's last words, 100 ms into the reply
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'okay', start_ms: 1500, end_ms: 1700 });
    t.advance(20);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // mid-reply delta: no turn
    t.twilioStop();
    await flush();
    expect(summaryOf(t).turns).toEqual([300]); // +2000 minus +1700, not the 20 ms to the mid-reply delta
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
  const start = async (options) => {
    const t = setup(options);
    await t.ready();
    return t;
  };
  const end = async (t) => {
    t.twilioStop();
    await flush();
    return summaryOf(t);
  };

  test('a continuous stream of silent chunks with voice in it: the greeting is no turn, the reply after the caller is timed from its first voiced chunk', async () => {
    const t = await start({ speech: [[2300, 2900]] });
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

  test('a pause under 800 ms of silent audio inside an utterance is no new reply (593 ms came on the live API); 800 ms or more is', async () => {
    const t = await start({ speech: [[100, 400], [1520, 1580]] });
    delta(t, b64(160)); // greeting
    run(t, 10, silence(800));
    said(t, 'first question', 100, 400);
    run(t, 5, silence(800)); // +1000..+1500
    delta(t, b64(800)); // reply 1 begins at +1500
    t.advance(100);
    said(t, 'and', 1520, 1580); // at +1600: arms the next measure
    run(t, 7, silence(800)); // 700 ms pause inside the reply
    delta(t, b64(800)); // voice resumes: the same reply
    t.advance(100);
    expect(t.bridge.latencies).toHaveLength(1); // the pause did not start a reply
    run(t, 8, silence(800)); // 800 ms of silent audio
    delta(t, b64(800)); // a new reply
    expect((await end(t)).turns).toHaveLength(2);
  });

  test('silence at the end of one voiced chunk and at the start of the next counts toward the 800 ms', async () => {
    const t = await start({ speech: [[20, 60]] });
    delta(t, b64(160)); // greeting
    t.advance(100);
    said(t, 'first question', 20, 60);
    // Four chunks of about 500 ms, 100 ms apart.
    delta(t, voiceThenSilence(390)); // the same reply, then 390 ms silent
    t.advance(100);
    delta(t, silenceThenVoice(400)); // 790 ms of silence in all: still the same reply
    expect(t.bridge.latencies).toHaveLength(0);
    t.advance(100);
    delta(t, voiceThenSilence(400));
    t.advance(100);
    delta(t, silenceThenVoice(400)); // at +400, 800 ms of silence in all: a new reply, voiced 400 ms into its chunk
    expect((await end(t)).turns).toEqual([740]); // its voice at +800; speech ended +60
  });

  test('one chunk that holds the end of a reply, 800 ms of silence and the next reply: the next reply is timed from its own first voiced sample', async () => {
    const mixed = Buffer.concat([Buffer.alloc(800, 0x00), Buffer.alloc(6400, 0xff), Buffer.alloc(800, 0x00)]).toString('base64');
    const t = await start({ speech: [[10, 60]] });
    delta(t, b64(160)); // greeting
    t.advance(100);
    said(t, 'hello', 10, 60);
    delta(t, mixed); // at +100: 100 ms more greeting, 800 ms silent, the reply's voice at +1000
    expect((await end(t)).turns).toEqual([940]);
    expect(mediaPayloads(t)).toContain(mixed);
  });

  describe('a chunk that holds the cut-off tail, 800 ms of silence and then the next reply, after a barge-in', () => {
    const mixed = Buffer.concat([Buffer.alloc(800, 0x00), Buffer.alloc(6400, 0xff), Buffer.alloc(800, 0x00)]).toString('base64');
    const bargeIn = async () => {
      const t = await start({ speech: [[1100, 1300]] });
      delta(t, b64(160)); // greeting
      t.advance(1000);
      delta(t, b64(8000)); // a reply...
      t.advance(240);
      delta(t, b64(8000)); // ...still streaming: 2000 ms queued in all
      t.advance(160);
      said(t, 'wait', 1100, 1300); // barge-in at +1400
      return t;
    };

    test('inside the 1.5 s it plays from the reply on: the tail before it never reaches Twilio', async () => {
      const t = await bargeIn();
      t.advance(100);
      delta(t, mixed); // at +1500
      expect(mediaPayloads(t)).not.toContain(mixed);
      expect(mediaPayloads(t)).toContain(b64(800)); // the reply alone: it plays at once, until +1600
      expect(t.bridge.playbackEndsAt - t.bridge.sessionStartWall).toBe(1600);
      expect(t.bridge.voiceEndsAt - t.bridge.sessionStartWall).toBe(1600);
      expect((await end(t)).after_barge_in_ambiguous_ms).toEqual([200]); // its voice at +1500, speech ended +1300
    });

    test('past the 1.5 s nothing is trimmed: the chunk plays whole', async () => {
      const t = await bargeIn();
      t.advance(50);
      run(t, 15, b64(800)); // the cut-off reply keeps streaming, +1450..+2850: dropped
      expect(mediaPayloads(t)).not.toContain(b64(800));
      delta(t, mixed); // at +2950: the 1.5 s from the barge-in at +1400 has passed
      expect(mediaPayloads(t)).toContain(mixed);
    });
  });

  test('one chunk with two reply starts marks one reply, at the first of them', async () => {
    const two = Buffer.concat([Buffer.alloc(800, 0xff), Buffer.alloc(800, 0x00), Buffer.alloc(6400, 0xff), Buffer.alloc(800, 0x00)]).toString('base64');
    const t = await start({ speech: [[10, 50]] });
    t.advance(100);
    said(t, 'hello', 10, 50);
    t.advance(200);
    delta(t, two); // at +300: the first voice of the call 100 ms in, 800 ms of silence, voice again
    const s = await end(t);
    expect(s.first_reply_ambiguous_ms).toBe(350); // its voice at +400, speech ended +50
    expect(s.turns).toEqual([]);
  });

  test('a gap in arrival is delay on the way, not a reply boundary (358 ms came in the live run): the audio after it is the same reply', async () => {
    const t = await start({ speech: [[500, 900], [1560, 1620]] });
    delta(t, b64(160)); // greeting
    run(t, 10, silence(800)); // +0..+1000
    said(t, 'hello', 500, 900);
    run(t, 5, silence(800)); // +1000..+1500
    run(t, 2, b64(800)); // the reply begins at +1500
    said(t, 'mm', 1560, 1620); // at +1700: arms the next measure
    t.advance(358); // the stream stalls...
    delta(t, b64(800)); // ...and the audio it held back arrives together
    delta(t, b64(800));
    delta(t, b64(800));
    expect((await end(t)).turns).toEqual([600]); // one reply, timed once
  });

  describe('the delay runs to the first voiced sample of the reply: its chunk arrival plus its offset in the chunk', () => {
    test('a voiced chunk with leading silence: the delay includes the offset of the voice inside the chunk', async () => {
      const t = await start({ speech: [[100, 500]] });
      delta(t, b64(160)); // greeting
      run(t, 5, silence(800));
      said(t, 'hello there', 100, 500);
      run(t, 15, silence(800)); // +2000
      delta(t, silenceThenVoice(200)); // 200 ms silent, then voice
      expect((await end(t)).turns).toEqual([1700]); // voice at +2200, speech ended +500
    });

    test('audio still queued at Twilio ahead of the reply is not added to the delay', async () => {
      const t = await start({ speech: [[300, 700]] });
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
      const t = await start({ speech: [[500, 900]] });
      delta(t, b64(160)); // greeting
      run(t, 10, silence(800));
      delta(t, silenceThenVoice(200)); // at +1000: a reply whose voice is 200 ms into its chunk
      t.advance(300);
      said(t, 'hello', 500, 900); // the speech ended before the reply arrived
      expect((await end(t)).turns).toEqual([300]);
    });

    test('a reply right after a barge-in plays from its first voiced sample and is timed apart from there', async () => {
      const t = await start({ speech: [[1100, 1300]] });
      delta(t, b64(160)); // greeting
      run(t, 10, silence(800));
      delta(t, b64(8000)); // a reply: 1000 ms queued
      run(t, 3, silence(800));
      said(t, 'wait', 1100, 1300); // barge-in at +1300
      run(t, 3, silence(800)); // dropped as tail, and still 600 ms of silent audio in all
      delta(t, silenceThenVoice(200)); // at +1600: 800 ms of silence, then the reply: forwarded from its voice on
      expect(mediaPayloads(t)).toContain(b64(800));
      expect((await end(t)).after_barge_in_ambiguous_ms).toEqual([300]);
    });

    test('a second reply inside the 1.5 s after a barge-in is timed apart to its first voiced sample', async () => {
      const t = await start({ speech: [[1100, 1300], [1830, 1880]] });
      delta(t, b64(160)); // greeting
      run(t, 10, silence(800));
      delta(t, b64(8000)); // a reply: 1000 ms queued
      run(t, 3, silence(800));
      said(t, 'wait', 1100, 1300); // barge-in at +1300: the window runs to +2800
      run(t, 5, silence(800));
      delta(t, b64(160)); // at +1800, after 800 ms of silent audio: a short reply
      run(t, 1, silence(800));
      said(t, ' so', 1830, 1880); // at +1900, more speech, after that reply's audio has played: no barge-in
      run(t, 5, silence(800));
      delta(t, silenceThenVoice(200)); // at +2400: a reply whose voice is 200 ms into its chunk
      const s = await end(t);
      expect(s.after_barge_in_ambiguous_ms).toEqual([500, 720]);
      expect(s.interruptions).toBe(1);
      expect(s.turns).toEqual([]);
    });

    test('the caller speaks first: first_reply_ambiguous_ms runs to the first voiced sample', async () => {
      const t = await start({ speech: [[10, 50]] });
      t.advance(100);
      said(t, 'hello', 10, 50);
      t.advance(200);
      delta(t, silenceThenVoice(200, 160)); // at +300: the first voice of the call, 200 ms into its chunk
      const s = await end(t);
      expect(s.first_reply_ambiguous_ms).toBe(450);
      expect(s.turns).toEqual([]);
    });
  });

  test('speech that ended after a chunk arrived is not answered by the voice inside that chunk: it times the next reply', async () => {
    const t = await start({ speech: [[800, 1100]] });
    delta(t, b64(160)); // greeting
    run(t, 10, silence(800));
    delta(t, silenceThenVoice(200)); // at +1000: a reply whose voice plays from +1200
    t.advance(300);
    said(t, 'hello', 800, 1100); // ended after that chunk had arrived
    run(t, 8, silence(800)); // +1300..+2100
    delta(t, b64(800)); // the next reply at +2100
    expect((await end(t)).turns).toEqual([1000]);
  });

  describe('the barge-in flush cuts queued voice only', () => {
    const clears = (t) => t.twilio.sent.filter((m) => m.event === 'clear').length;

    test('a caller question over queued silence flushes nothing: the answer is a turn', async () => {
      const t = await start({ speech: [[600, 1000]] });
      delta(t, b64(160)); // greeting
      run(t, 10, silence(800));
      delta(t, silence(4000)); // one burst: 500 ms of silence queued until +1500
      t.advance(100);
      said(t, 'hello', 600, 1000); // at +1100, with 400 ms of silence still queued
      expect(clears(t)).toBe(0);
      t.advance(800);
      delta(t, b64(800)); // the answer at +1900
      const s = await end(t);
      expect(s.turns).toEqual([900]);
      expect(s.interruptions).toBe(0);
      expect(s.after_barge_in_ambiguous_ms).toEqual([]);
    });

    test('voice queued behind silence is still flushed', async () => {
      const t = await start({ speech: [[1250, 1350]] });
      delta(t, b64(160)); // greeting
      t.advance(1000);
      delta(t, silence(8000)); // one burst at +1000: 1000 ms of silence...
      delta(t, b64(2400)); // ...then a reply: its voice plays +2000..+2300
      t.advance(400);
      said(t, 'wait', 1250, 1350); // at +1400: the caller spoke after the reply began to arrive
      expect(clears(t)).toBe(1);
    });

    test('a late fragment from a caller the bridge did not hear flushes nothing: it must not cut the answer to a finished question', async () => {
      const t = await start(); // the same timeline as the test above, but no caller frame reaches the voice level
      delta(t, b64(160)); // greeting
      t.advance(1000);
      delta(t, silence(8000)); // one burst at +1000: 1000 ms of silence...
      delta(t, b64(2400)); // ...then the answer: its voice plays +2000..+2300
      t.advance(400);
      said(t, 'do you treat ants', 1250, 1350); // at +1400, 400 ms after the answer began to arrive, all its voice still queued
      expect(clears(t)).toBe(0);
      const s = await end(t);
      expect(s.interruptions).toBe(0);
      expect(s.turns).toEqual([]);
      expect(s.after_barge_in_ambiguous_ms).toEqual([]);
    });

    test('silence queued after the last voice of a reply is nothing to cut', async () => {
      const t = await start({ speech: [[1250, 1350]] });
      delta(t, b64(160)); // greeting
      t.advance(1000);
      delta(t, Buffer.concat([Buffer.alloc(2400, 0x00), Buffer.alloc(5600, 0xff)]).toString('base64')); // voice +1000..+1300, then silence until +2000
      t.advance(400);
      said(t, 'ok', 1250, 1350); // at +1400: the voice has played, 600 ms of silence is queued
      expect(clears(t)).toBe(0);
    });

    test('a flush leaves no voice queued: more caller speech sends no second clear', async () => {
      const t = await start({ speech: [[1100, 1500]] });
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
    const t = await start({ speech: [[1500, 1900]] });
    delta(t, b64(160)); // greeting
    t.advance(1000);
    run(t, 10, b64(800)); // a reply at the live pacing, +1000..+2000: 100 ms queued at the most
    said(t, 'wait', 1500, 1900); // at +2000, over the reply
    run(t, 3, b64(800)); // the model is still speaking
    expect(t.twilio.sent.some((m) => m.event === 'clear')).toBe(false);
    expect(mediaPayloads(t).filter((p) => p === b64(800))).toHaveLength(13);
    expect((await end(t)).interruptions).toBe(0);
  });

  describe("the caller's speech end is the caller's last sound, never a transcript's end_ms", () => {
    // The caller speaks +2000..+3000, the fragment arrives at +3600, the reply at +4100.
    const call = async (options, startMs, endMs) => {
      const t = await start(options);
      delta(t, b64(160)); // greeting
      quiet(t, 3600);
      said(t, 'when can you come', startMs, endMs);
      quiet(t, 500);
      delta(t, b64(800)); // the reply at +4100
      return end(t);
    };

    test("the delay runs from the caller's last voiced frame, whatever end_ms says: early, exact, late as measured, absurd", async () => {
      for (const endMs of [200, 3000, 4300, 5500, 600000]) {
        const s = await call({ speech: [[2000, 3000]] }, endMs - 200, endMs);
        expect(s.turns).toEqual([1100]);
      }
    });

    test('no caller frame holds voice (speech under the voice level): the bridge did not hear the caller and records no delay; caller_voiced_pct is 0', async () => {
      const s = await call({}, 2000, 3000);
      expect(s.turns).toEqual([]); // never a delay from the fragment's arrival: it would read about 600 ms low here
      expect(s.first_reply_ambiguous_ms).toBe(null);
      expect(s.caller_voiced_pct).toBe(0);
    });

    test('a noisy line, every caller frame voiced: the bridge cannot hear the caller stop and records no delay; caller_voiced_pct is 100', async () => {
      const s = await call({ speech: [[0, 60000]] }, 2000, 3000);
      expect(s.turns).toEqual([]); // never a delay from the fragment's arrival: it would read 500 here, 600 ms low
      expect(s.replies_over_caller).toBe(1);
      expect(s.caller_voiced_pct).toBe(100);
    });

    test('a late fragment of speech that ended before the reply before the current one times nothing', async () => {
      const t = await start({ speech: [[500, 1000]] });
      delta(t, b64(160)); // greeting
      quiet(t, 1300);
      delta(t, b64(800)); // reply A at +1300: no fragment has come yet
      quiet(t, 900);
      delta(t, b64(800)); // reply B at +2200, 900 ms of silent audio after A
      quiet(t, 300);
      said(t, 'hello there', 500, 1000); // at +2500: the caller's last sound was +1000, before reply A began
      const s = await end(t);
      expect(s.turns).toEqual([]); // A answered it; B must not get 1200 ms
      expect(s.replies_over_caller).toBe(0);
    });

    test('each reply over the caller is counted', async () => {
      const t = await start({ speech: [[0, 60000]] }); // a noisy line
      delta(t, b64(160)); // greeting
      quiet(t, 2000);
      said(t, 'one', 1000, 1500);
      quiet(t, 1000);
      delta(t, b64(800)); // a reply at +3000
      quiet(t, 2000);
      said(t, 'two', 4000, 4500);
      quiet(t, 1000);
      delta(t, b64(800)); // a reply at +6000
      const s = await end(t);
      expect(s.turns).toEqual([]);
      expect(s.replies_over_caller).toBe(2);
    });

    test('the caller says more after the last fragment and stops before the reply: the delay runs from their last sound', async () => {
      const t = await start({ speech: [[2000, 3000], [3300, 3500]] });
      delta(t, b64(160)); // greeting
      quiet(t, 3100);
      said(t, 'do you treat ants', 2000, 3000); // at +3100: the caller's last sound so far is +3000
      quiet(t, 1000);
      delta(t, b64(800)); // the reply at +4100; no fragment came for the words at +3300..+3500
      const s = await end(t);
      expect(s.turns).toEqual([600]); // from +3500, not 1100 from +3000
      expect(s.replies_over_caller).toBe(0);
    });

    // Seen in a local rehearsal: the model took a pause inside a question for
    // its end, and began to answer while the caller went on. The bridge of the
    // first push recorded 604 ms for that reply, from the last fragment.
    test('a reply that begins while the caller is still speaking gets no delay and is counted; the reply after it is timed', async () => {
      const t = await start({ speech: [[2000, 2400], [2700, 4500]] });
      delta(t, b64(160)); // greeting
      quiet(t, 2710);
      said(t, 'I have a problem with', 2000, 2400); // at +2710: the caller has just started again
      quiet(t, 590);
      run(t, 5, b64(800)); // the model answers +3300..+3800, over the caller
      quiet(t, 1100);
      said(t, ' ants in my kitchen', 2700, 4500); // at +4900: the caller stopped at +4500
      quiet(t, 700);
      delta(t, b64(800)); // the answer at +5600
      const s = await end(t);
      expect(s.turns).toEqual([1100]);
      expect(s.replies_over_caller).toBe(1);
    });

    test("a reply under 200 ms after the caller's last sound did not wait for the caller: no delay; at 200 ms it is a delay", async () => {
      const at = async (replyMs) => {
        const t = await start({ speech: [[2000, 3000]] });
        delta(t, b64(160)); // greeting
        quiet(t, 3010);
        said(t, 'yes', 2000, 3000); // at +3010
        quiet(t, replyMs - 3010);
        delta(t, b64(800)); // the reply
        return end(t);
      };
      const early = await at(3190);
      expect(early.turns).toEqual([]);
      expect(early.replies_over_caller).toBe(1);
      const waited = await at(3200);
      expect(waited.turns).toEqual([200]);
      expect(waited.replies_over_caller).toBe(0);
    });

    test('late fragments show the caller spoke until just before the reply: no delay, and the reply is counted once', async () => {
      const t = await start({ speech: [[2000, 4000]] });
      delta(t, b64(160)); // greeting
      quiet(t, 1000);
      delta(t, b64(800)); // an earlier reply, at +1000
      quiet(t, 3100);
      delta(t, b64(800)); // the reply at +4100: no fragment has come yet
      quiet(t, 400);
      said(t, 'so what I', 2000, 3200); // at +4500
      said(t, ' wanted to ask', 3200, 4000);
      const s = await end(t);
      expect(s.turns).toEqual([]);
      expect(s.replies_over_caller).toBe(1);
    });

    test('caller_voiced_pct is the voiced share of the caller audio, by time', async () => {
      const s = await call({ speech: [[2000, 3000]] }, 2000, 3000);
      expect(s.caller_voiced_pct).toBe(24); // 1000 ms of 4100
    });

    test('a caller sound more than 2 s before the fragment arrived is not its speech end: no delay is recorded', async () => {
      const s = await call({ speech: [[1000, 1590]] }, 1000, 1590); // 2010 ms before +3600
      expect(s.turns).toEqual([]);
    });

    test('a caller sound 2 s before the fragment arrived is its speech end', async () => {
      const s = await call({ speech: [[1000, 1600]] }, 1000, 1600);
      expect(s.turns).toEqual([2500]);
    });

    test('the caller starts again before the fragment arrives: the end is the latest sound, and the next fragment moves it', async () => {
      const t = await start({ speech: [[2000, 3000], [3500, 3700]] });
      delta(t, b64(160)); // greeting
      quiet(t, 3600);
      said(t, 'when can you come', 2000, 3000); // at +3600 the caller is speaking again
      expect(t.bridge.speechEndWall - t.bridge.sessionStartWall).toBe(3600);
      quiet(t, 400);
      said(t, ' today', 3500, 3700); // at +4000
      expect(t.bridge.speechEndWall - t.bridge.sessionStartWall).toBe(3700);
      quiet(t, 800);
      delta(t, b64(800)); // the reply at +4800
      expect((await end(t)).turns).toEqual([1100]);
    });

    // Two end-to-end runs on the live API: the real bridge, a synthetic caller,
    // 24 s each. A replay drives the bridge with what was measured, on a 20 ms
    // grid: when the caller spoke, when each transcript fragment arrived and the
    // end_ms it carried, and where the model's voice sits in its audio.
    const voicedAt = (ranges, ms) => ranges.some(([from, to]) => ms >= from && ms < to);
    const replay = async ({ speech, fragments, voice, arrives }) => {
      const t = setup({ callerAudio: false });
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
      expect(s.replies_over_caller).toBe(0);
      return s;
    };

    // 2026-11-20. The caller's questions ended 8083 and 17097 ms after
    // session.started; the model's voice began 1097 and 1107 ms later. The
    // bridge of that day recorded 0 ms for both: every end_ms lay after the
    // reply. The greeting was never spoken, so the first answer is the first
    // reply of the call. One reply held a 593 ms pause, and its audio stalled
    // once for 358 ms.
    test('the live session of 2026-11-20, replayed: both delays read as measured', async () => {
      const s = await replay({
        speech: [[6047, 8083], [15045, 17097]],
        fragments: [ // [arrival, end_ms]
          [7510, 8600], [7690, 8800], [7872, 9000], [8066, 9200], [8330, 9400], [8496, 9600], [8786, 9800], [9169, 10200],
          [16456, 17800], [16909, 18200], [17098, 18400], [17313, 18600], [17502, 18800], [17875, 19000], [18276, 19400],
        ],
        voice: [[9080, 11000], [11593, 14500], [18107, 20820]],
        // audio position p arrived about p + 100; the chunks for 11900..12100 came together at +12260
        arrives: (position) => (position >= 11900 && position < 12200 ? 12260 : position + 100),
      });
      expect(s.first_reply_ambiguous_ms).toBe(1100); // measured 1097
      expect(s.turns).toEqual([1107]); // measured 1107
    });

    // 2026-11-21: the greeting was spoken 2.0 s after session.started, the
    // questions ended at 8089 and 17101 ms, and the model's voice began 1670
    // and 1690 ms later (Sandy's full prompt). Every end_ms was later than the
    // moment its fragment arrived. The bridge of that run recorded 1706 and
    // 1734 ms. It still read end_ms, limited to the fragment's arrival and
    // then moved back to the caller's last voiced frame: the same frame the
    // rule here picks.
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
      replies_over_caller: 0,
      caller_voiced_pct: 0, // one caller frame, silent
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
