/**
 * GPT-Live trial bridge (GATE_VOICE_GPT_LIVE_TEST): Twilio Media Streams on
 * one side, an OpenAI GPT-Live socket on the other. Both sockets, the clock,
 * the database and executeTool are fakes: no network, no paid call.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { EventEmitter } = require('events');
const logger = require('../services/logger');
const bridgeMod = require('../services/voice-agent/live-bridge');
const { OPENAI_VOICE_LIVE, OPENAI_FAST_INTERACTIVE } = require('../config/models');

const { runLiveBridge, TOOL_REFUSAL, BACKEND_TOOL_NAMES } = bridgeMod;
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
const b64 = (bytes) => Buffer.alloc(bytes, 0x7f).toString('base64');

function setup({ executeTool, closeReply = true, deps = {} } = {}) {
  let clock = 1_000_000;
  const twilio = new FakeSocket();
  const openai = new FakeSocket({
    onSend: (msg, self) => {
      if (closeReply && msg.type === 'session.close') {
        setImmediate(() => self.receive({ type: 'session.closed', reason: 'close_requested', session: {}, usage: { seconds: 45 } }));
      }
    },
  });
  const update = jest.fn().mockResolvedValue(1);
  const where = jest.fn(() => ({ update }));
  const db = jest.fn(() => ({ where }));
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  const openaiFactory = jest.fn(() => openai);
  const exec = executeTool || jest.fn(async () => 'Open times: Tuesday at 9 AM.');
  const bridge = runLiveBridge(twilio, { callSid: CALL_SID, voice: 'marin', cell: '71' }, {
    openaiFactory,
    now: () => clock,
    executeTool: exec,
    buildInstructions: () => 'INSTRUCTIONS',
    buildTools: () => [{ type: 'function', name: 'find_slots', description: 'd', parameters: { type: 'object' } }],
    greeting: () => 'Waves, this is Sandy.',
    db: () => db,
    apiKey: () => 'sk-test',
    ...deps,
  });
  return {
    twilio, openai, bridge, update, where, db, openaiFactory, exec,
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
  test('opens the OpenAI socket on start and sends session.start with the models, voice, tools and no storage', async () => {
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
      delegation: { type: 'responses', responses: expect.objectContaining({ model: OPENAI_FAST_INTERACTIVE, tool_choice: 'auto', parallel_tool_calls: false, max_output_tokens: 1024 }) },
    });
    expect(msg.session.delegation.responses.tools).toHaveLength(1);
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
    expect(summaryOf(t).close_reason).toBe('callsid_mismatch');
  });

  test('a missing OPENAI_API_KEY closes the call instead of opening a socket', async () => {
    const t = setup({ deps: { apiKey: () => '' } });
    t.twilioStart();
    await flush();
    expect(t.openaiFactory).not.toHaveBeenCalled();
    expect(t.twilio.close).toHaveBeenCalled();
  });
});

describe('model audio, barge-in and latency', () => {
  test('each output delta goes to Twilio at once, on the stream', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) });
    expect(t.twilio.sent).toContainEqual({ event: 'media', streamSid: STREAM_SID, media: { payload: b64(160) } });
  });

  test('a caller transcript while model audio is still queued flushes Twilio and counts one interruption', async () => {
    const t = setup();
    await t.ready();
    t.twilioMedia();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(8000) }); // 1000 ms of audio
    t.advance(300);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'wait', start_ms: 0, end_ms: 200 });
    expect(t.twilio.sent).toContainEqual({ event: 'clear', streamSid: STREAM_SID });
    // playback was reset: a second delta now finds nothing queued
    t.openai.receive({ type: 'session.input_transcript.delta', delta: ' hold on', start_ms: 200, end_ms: 400 });
    expect(t.twilio.sent.filter((m) => m.event === 'clear')).toHaveLength(1);
    t.twilioStop();
    await flush();
    expect(summaryOf(t).interruptions).toBe(1);
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
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'yes', start_ms: 0, end_ms: 100 });
    expect(t.twilio.sent.some((m) => m.event === 'clear')).toBe(false);
  });

  test('reply delay is the first output delta minus the end of the caller speech; the greeting records none', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // greeting: no turn yet
    t.advance(5000);
    t.twilioMedia(); // inputStartWall = now
    t.advance(1500);
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'when can you come', start_ms: 0, end_ms: 1200 });
    t.advance(900); // speech ended at +1200, now is +1500 + 900 = +2400: 1200 ms
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) });
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // only the first counts
    t.twilioStop();
    await flush();
    const s = summaryOf(t);
    expect(s.turns).toEqual([1200]);
    expect(s.latency_p50_ms).toBe(1200);
    expect(s.latency_max_ms).toBe(1200);
  });

  test('a caller transcript that lands while the model is already talking records no reply delay', async () => {
    const t = setup();
    await t.ready();
    t.twilioMedia();
    t.advance(2000);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(8000) }); // reply starts: 1000 ms queued
    t.advance(100);
    // a late transcript of the caller's last words, 100 ms into the reply (playback still queued, so also a clear)
    t.openai.receive({ type: 'session.input_transcript.delta', delta: 'okay', start_ms: 1500, end_ms: 1900 });
    t.advance(20);
    t.openai.receive({ type: 'session.output_audio.delta', delta: b64(160) }); // mid-reply delta: no turn
    t.twilioStop();
    await flush();
    expect(summaryOf(t).turns).toEqual([]);
  });
});

describe('tools', () => {
  const call = (id, name, args, extra = {}) => ({
    type: 'response.event',
    delegation_id: 'd1',
    event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: id, name, arguments: args, status: 'completed', ...extra } },
  });

  test('an allowlisted call runs executeTool with a sandbox ctx, then answers with the output and one response.create', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive(call('c1', 'find_slots', JSON.stringify({ when: 'next Tuesday', zip: '34202' })));
    await flush();
    expect(t.exec).toHaveBeenCalledTimes(1);
    const [name, input, ctx] = t.exec.mock.calls[0];
    expect(name).toBe('find_slots');
    expect(input).toEqual({ when: 'next Tuesday', zip: '34202' });
    expect(ctx).toMatchObject({ sandbox: true, callSid: CALL_SID, customerId: null, callerVerified: false });
    const tail = t.openai.sent.slice(-2);
    expect(tail[0]).toEqual({ type: 'response.item.create', item: { type: 'function_call_output', call_id: 'c1', output: 'Open times: Tuesday at 9 AM.' } });
    expect(tail[1]).toEqual({ type: 'response.create' });
    // a replayed done event for the same call_id answers nothing twice
    t.openai.receive(call('c1', 'find_slots', '{}'));
    await flush();
    expect(t.exec).toHaveBeenCalledTimes(1);
    expect(t.openai.sent.filter((m) => m.type === 'response.create')).toHaveLength(1);
  });

  test('only a completed function_call item is acted on', async () => {
    const t = setup();
    await t.ready();
    t.openai.receive(call('c2', 'find_slots', '{}', { status: 'in_progress' }));
    t.openai.receive({ type: 'response.event', event: { type: 'response.output_item.done', item: { type: 'message', call_id: 'c3', status: 'completed' } } });
    t.openai.receive({ type: 'response.event', event: { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'c4', name: 'find_slots', arguments: '{}', status: 'completed' } } });
    await flush();
    expect(t.exec).not.toHaveBeenCalled();
    expect(t.openai.types()).not.toContain('response.create');
  });

  test.each([
    ['a name outside the allowlist', 'capture_lead', '{"call_summary":"x"}'],
    ['a write tool', 'request_booking', '{}'],
    ['bad JSON arguments', 'find_slots', '{not json'],
    ['arguments that are not an object', 'find_slots', '[1,2]'],
  ])('%s gets the refusal text and executeTool is never called', async (_label, name, args) => {
    const t = setup();
    await t.ready();
    t.openai.receive(call('cx', name, args));
    await flush();
    expect(t.exec).not.toHaveBeenCalled();
    expect(t.openai.sent.slice(-2)).toEqual([
      { type: 'response.item.create', item: { type: 'function_call_output', call_id: 'cx', output: TOOL_REFUSAL } },
      { type: 'response.create' },
    ]);
  });

  test('a throwing tool answers with the refusal and never throws out of the bridge', async () => {
    const t = setup({ executeTool: jest.fn(async () => { throw new Error('boom'); }) });
    await t.ready();
    t.openai.receive(call('c5', 'get_services_catalog', '{}'));
    await flush();
    expect(t.openai.sent.slice(-2)[0].item.output).toBe(TOOL_REFUSAL);
  });

  test('a tool that outlives its bound answers with the refusal', async () => {
    const t = setup({ executeTool: jest.fn(() => new Promise(() => {})), deps: { toolTimeoutMs: 20 } });
    await t.ready();
    t.openai.receive(call('c6', 'find_slots', '{"when":"tomorrow"}'));
    await new Promise((r) => setTimeout(r, 60));
    expect(t.openai.sent.slice(-2)[0].item.output).toBe(TOOL_REFUSAL);
    t.twilioStop();
    await flush();
    expect(summaryOf(t).errors).toContain('tool_timeout');
  });

  test('the allowlist is the three read-only tools, converted to the OpenAI function shape', () => {
    expect(BACKEND_TOOL_NAMES).toEqual(['get_availability', 'find_slots', 'get_services_catalog']);
    const tools = bridgeMod.buildBackendTools();
    expect(tools.map((x) => x.name)).toEqual(BACKEND_TOOL_NAMES);
    for (const tool of tools) {
      expect(tool).toEqual({ type: 'function', name: tool.name, description: expect.any(String), parameters: expect.objectContaining({ type: 'object' }) });
      expect(tool.input_schema).toBeUndefined();
    }
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
      close_reason: 'close_requested',
      turns: [],
      latency_p50_ms: null,
      latency_max_ms: null,
      interruptions: 0,
      tool_calls: [],
      errors: [],
      transcript: [{ role: 'caller', text: 'Hi, there' }, { role: 'sandy', text: 'Hello!' }],
    });
    expect(t.twilio.close).toHaveBeenCalled();
  });

  test('when session.closed never comes, finalize waits the bound and then writes with the running usage', async () => {
    const t = setup({ closeReply: false, deps: { closeWaitMs: 30 } });
    await t.ready();
    t.openai.receive({ type: 'session.usage.updated', usage: { seconds: 12 } });
    t.twilioStop();
    await new Promise((r) => setTimeout(r, 80));
    expect(t.update).toHaveBeenCalledTimes(1);
    const s = summaryOf(t);
    expect(s.usage_seconds).toBe(12);
    expect(s.close_reason).toBe('twilio_stop');
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
    await new Promise((r) => setTimeout(r, 40));
    const s = summaryOf(t);
    expect(s.usage_seconds).toBe(42);
    expect(s.errors).toContain('usage_missing');
  });

  test('the session cap ends the call', async () => {
    const t = setup({ deps: { sessionCapMs: 25 } });
    await t.ready();
    await new Promise((r) => setTimeout(r, 70));
    expect(t.twilio.close).toHaveBeenCalled();
    expect(summaryOf(t).close_reason).toBe('close_requested');
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
    expect(s.transcript[0].text).toHaveLength(20000);
  });

  test('a failed summary write is logged and never throws', async () => {
    const t = setup();
    t.update.mockRejectedValue(new Error('pool down'));
    await t.ready();
    t.twilioStop();
    await flush();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/summary write failed/));
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
    expect(bridgeMod.TRIAL_LIMITS).toMatch(/cannot book, take a lead, send a text, transfer/);
    expect(bridgeMod.TRIAL_LIMITS).toMatch(/office will call them back/);
  });
});
