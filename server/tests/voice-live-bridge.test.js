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
const realScrub = (turns) => require('../services/voice-agent/relay-transcript').scrubTurnsForStorage(turns);
const b64 = (bytes) => Buffer.alloc(bytes, 0x7f).toString('base64');

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
  const ledgerUpdate = jest.fn().mockResolvedValue(1); // voice_gpt_live_spend
  const ledgerWhere = jest.fn(() => ({ update: ledgerUpdate }));
  const db = jest.fn((table) => (table === 'voice_gpt_live_spend' ? { where: ledgerWhere } : { where }));
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  const openaiFactory = jest.fn(() => openai);
  const bridge = runLiveBridge(twilio, { callSid: CALL_SID, voice: 'marin', cell: '71' }, {
    openaiFactory,
    now: () => clock,
    buildInstructions: () => 'INSTRUCTIONS',
    greeting: () => 'Waves, this is Sandy.',
    scrubTurns: (turns) => turns.map((turn) => ({ ...turn })), // the real scrubber has its own test
    db: () => db,
    apiKey: () => 'sk-test',
    ...deps,
  });
  return {
    twilio, openai, bridge, update, where, ledgerUpdate, ledgerWhere, db, openaiFactory,
    advance: (ms) => { clock += ms; },
    tick: () => clock,
    twilioStart: (callSid = CALL_SID) => twilio.emit('message', JSON.stringify({ event: 'start', start: { callSid, streamSid: STREAM_SID } })),
    twilioMedia: (payload = 'AAAA') => twilio.emit('message', JSON.stringify({ event: 'media', media: { track: 'inbound', payload } })),
    twilioStop: () => twilio.emit('message', JSON.stringify({ event: 'stop' })),
    ready: async () => {
      twilio.emit('message', JSON.stringify({ event: 'start', start: { callSid: CALL_SID, streamSid: STREAM_SID } }));
      openai.emit('open');
      openai.receive({ type: 'session.started', session: { id: 's1' } });
      await flush();
    },
  };
}

const summaryOf = (t) => JSON.parse(t.db.raw.mock.calls[0][1][0]);

beforeEach(() => jest.clearAllMocks());

describe('session setup and caller audio', () => {
  test('opens the OpenAI socket on start and sends session.start with the model, voice, client delegation and no storage', async () => {
    const t = setup();
    t.twilioStart();
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

  test('caller audio is dropped until session.started, then forwarded unchanged', async () => {
    const t = setup();
    t.twilioStart();
    t.openai.emit('open');
    t.twilioMedia('BEFORE');
    expect(t.openai.types()).toEqual(['session.start']);
    t.openai.receive({ type: 'session.started', session: { id: 's1' } });
    await flush();
    t.twilioMedia('AFTER');
    expect(t.openai.sent).toContainEqual({ type: 'session.input_audio.append', audio: 'AFTER' });
    expect(t.openai.sent.some((m) => m.audio === 'BEFORE')).toBe(false);
  });

  test('session.started sends the greeting as commentary', async () => {
    const t = setup();
    await t.ready();
    expect(t.openai.sent).toContainEqual({ type: 'session.commentary.append', delegation_id: null, content: 'Waves, this is Sandy.' });
  });

  test('a start frame for another CallSid closes the call and never opens OpenAI', async () => {
    const t = setup();
    t.twilioStart('CA-someone-else');
    await flush();
    expect(t.openaiFactory).not.toHaveBeenCalled();
    expect(t.twilio.close).toHaveBeenCalled();
    expect(t.update).toHaveBeenCalledTimes(1);
    expect(summaryOf(t)).toMatchObject({ close_reason: 'callsid_mismatch', openai_contacted: false, cost_usd: 0 });
  });

  test('a start frame with no streamSid closes the call and never opens OpenAI; a later good start changes nothing', async () => {
    const t = setup();
    t.twilio.emit('message', JSON.stringify({ event: 'start', start: { callSid: CALL_SID } }));
    t.twilioStart();
    await flush();
    expect(t.openaiFactory).not.toHaveBeenCalled();
    expect(t.twilio.close).toHaveBeenCalled();
    expect(summaryOf(t).close_reason).toBe('no_stream_sid');
  });

  test('a second start frame never opens a second paid session', async () => {
    const t = setup();
    t.twilioStart();
    t.twilioStart();
    await flush();
    expect(t.openaiFactory).toHaveBeenCalledTimes(1);
  });

  test('an error before session.started is a refused start: the call ends', async () => {
    const t = setup();
    t.twilioStart();
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
    t.twilioStart();
    t.openai.emit('open');
    await waitFor(() => t.update.mock.calls.length > 0);
    expect(t.twilio.close).toHaveBeenCalled();
    expect(summaryOf(t).errors).toContain('start_timeout');
  });

  test('a missing OPENAI_API_KEY closes the call instead of opening a socket', async () => {
    const t = setup({ deps: { apiKey: () => '' } });
    t.twilioStart();
    await flush();
    expect(t.openaiFactory).not.toHaveBeenCalled();
    expect(t.twilio.close).toHaveBeenCalled();
    // OpenAI was never contacted: the call settles at zero and frees its reservation
    const s = summaryOf(t);
    expect(s).toMatchObject({ openai_contacted: false, usage_seconds: 0, cost_usd: 0 });
    expect(s.errors).not.toContain('usage_unconfirmed');
    expect(t.ledgerUpdate).toHaveBeenCalledWith({ cost_usd: 0, settled_at: expect.any(Date) }); // frees the reservation
  });

  test('a socket that throws at construction ends the call, settled at zero, without an uncaught error', async () => {
    const t = setup({ deps: { openaiFactory: () => { throw new Error('bad url'); } } });
    t.twilioStart();
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

  test('a tail chunk of the cut-off reply right after a barge-in keeps the delay measure for the real next reply', async () => {
    const t = setup();
    await t.ready();
    t.twilioMedia();
    t.advance(1000);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(8000) }); // reply starts at +1000, 1000 ms queued
    t.advance(600);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'wait', start_ms: 1300, end_ms: 1500 }); // barge-in at +1600
    t.advance(100);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // the old reply's tail, inside the gap
    t.advance(900);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // the real next reply at +2600
    t.twilioStop();
    await flush();
    expect(summaryOf(t).turns).toEqual([1100]); // +2600 minus the speech end at +1500
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

  test('a late transcript of words the last reply already answered does not time the next reply', async () => {
    const t = setup();
    await t.ready();
    t.twilioMedia();
    t.advance(2000);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // a short reply starts at t0 + 2000
    t.advance(500);
    // the transcript of speech that ended at t0 + 1900 arrives after the reply's last chunk
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'thanks', start_ms: 1500, end_ms: 1900 });
    t.advance(3000);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // the model speaks again, unprompted
    t.twilioStop();
    await flush();
    expect(summaryOf(t).turns).toEqual([]);
  });

  test('a late first caller packet does not shift speech timing: it counts from session.started', async () => {
    const t = setup();
    await t.ready(); // session time 0 = t0
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

  test('a caller transcript that lands while the model is already talking records no reply delay', async () => {
    const t = setup();
    await t.ready();
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
    expect(summaryOf(t).turns).toEqual([]);
  });
});

describe('delegation', () => {
  const created = (id, target = 'client') => ({ type: 'session.delegation.created', delegation: { id, target }, offset_ms: 100 });

  test('a client delegation gets the fixed no-lookups answer as unspoken context, once per delegation', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive(created('d1'));
    t.openai.receive(created('d1')); // the same delegation again: no second answer
    const answers = t.openai.sent.filter((m) => m.type === 'session.thinking.append');
    expect(answers).toEqual([{ type: 'session.thinking.append', delegation_id: 'd1', content: DELEGATION_REPLY }]);
    expect(DELEGATION_REPLY).toMatch(/no lookups/);
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
    expect(t.openai.sent.some((m) => m.type === 'session.thinking.append')).toBe(false);
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
    expect(t.openai.sent.some((m) => m.type === 'session.thinking.append')).toBe(false);
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
      interruptions: 0,
      delegations: 0,
      errors: [],
      transcript: [{ role: 'caller', text: 'Hi, there' }, { role: 'sandy', text: 'Hello!' }],
    });
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

  test('error events log the code and type only, and the transcript is capped', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive({ type: 'error', error: { code: 'rate_limit', type: 'server_error', message: 'echoed caller words', param: 'x' } });
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'x'.repeat(30000), start_ms: 0, end_ms: 10 });
    t.twilioStop();
    await flush();
    const logged = JSON.stringify(logger.warn.mock.calls) + JSON.stringify(logger.info.mock.calls) + JSON.stringify(logger.error.mock.calls);
    expect(logged).toContain('rate_limit');
    expect(logged).not.toContain('echoed caller words');
    expect(logged).not.toContain('xxxxx');
    const s = summaryOf(t);
    expect(s.errors).toContain('rate_limit:server_error');
    const stored = s.transcript.reduce((n, turn) => n + turn.text.length, 0);
    expect(stored).toBeGreaterThan(0);
    expect(stored).toBeLessThanOrEqual(20000);
  });

  test('a failed summary write logs a bounded code only, never the error message (it can echo the transcript), and never throws', async () => {
    const t = setup();
    const err = Object.assign(new Error('update "call_log" set metadata = my card is 4111 1111 1111 1111'), { code: '22P02' });
    t.update.mockRejectedValue(err);
    await t.ready();
    t.twilioStop();
    await flush();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/summary write failed callSid=CA-live-1 code=22P02$/));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('4111');
  });

  test('card numbers are scrubbed from the stored transcript, also across turns (the relay scrubber)', async () => {
    const t = setup({ deps: { scrubTurns: realScrub } });
    await t.ready();
    t.twilioMedia();
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'my card is 4111 1111', start_ms: 0, end_ms: 900 });
    t.openai.receive({ type: 'session.output_transcript.delta', delta: 'Sorry, I cannot take a card here.', start_ms: 1000, end_ms: 1500 });
    t.openai.receive({ type: 'session.input_transcript.delta', delta: '1111 1111', start_ms: 1600, end_ms: 2000 });
    t.twilioStop();
    await flush();
    const stored = JSON.stringify(summaryOf(t).transcript);
    expect(stored).not.toMatch(/4111\s*1111/);
    expect(stored).toContain('my card is');
    // and the production default is that same scrubber
    const prodScrub = new bridgeMod.LiveBridge(new FakeSocket(), { callSid: CALL_SID }).deps.scrubTurns;
    expect(JSON.stringify(prodScrub([{ role: 'caller', text: 'card 4111 1111 1111 1111' }]))).not.toMatch(/4111\s*1111/);
  }, 60000); // the first load of the real scrubber's modules is slow on a busy machine

  test('a scrubber that cannot run stores no transcript text at all', async () => {
    const t = setup({ deps: { scrubTurns: () => null } });
    await t.ready();
    t.twilioMedia();
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'hello', start_ms: 0, end_ms: 400 });
    t.twilioStop();
    await flush();
    const s = summaryOf(t);
    expect(s.transcript).toEqual([]);
    expect(s.errors).toContain('transcript_scrub_unavailable');
  });
});

describe('spend cap', () => {
  test('the per-call reservation covers the session cap plus close wait, at the voice price', () => {
    expect(bridgeMod.PER_CALL_RESERVE_USD).toBe(bridgeMod.callCostUsd(630));
    expect(bridgeMod.PER_CALL_RESERVE_USD).toBeCloseTo(0.525, 4); // 10.5 min at $0.05
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
