// Live words under the staff mic (GATE_DICTATION_LIVE_WORDS, services/dictation-live.js): a fake staff socket and a
// fake OpenAI socket. No network, no database.
const { EventEmitter } = require('events');

const mockFence = jest.fn();
const mockHints = jest.fn();
const mockBudget = jest.fn();
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/dictation-context', () => ({ fenceDictationContext: (...a) => mockFence(...a) }));
jest.mock('../services/dictation-word-list', () => ({ buildDictationHints: (...a) => mockHints(...a) }));
jest.mock('../services/dictation-upload', () => ({ takeLiveSessionBudget: (...a) => mockBudget(...a) }));
jest.mock('../services/call-recording-processor', () => ({
  transcriptionKeywords: () => ['BaseWord', 'Bad<Word>'],
  mergeTranscriptionKeywords: (base, extra) => [...base, ...(extra || [])],
}));

const logger = require('../services/logger');
const live = require('../services/dictation-live');

class FakeUpstream extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closed = false;
    FakeUpstream.last = this;
  }
  open() { this.readyState = 1; this.emit('open'); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.closed = true; this.readyState = 3; this.emit('close'); }
  say(event) { this.emit('message', Buffer.from(JSON.stringify(event))); }
  types() { return this.sent.map((m) => m.type); }
}

function fakeSocket(over = {}) {
  const socket = new EventEmitter();
  socket.userType = 'technician';
  socket.userId = 'tech-1';
  socket.staffTokenVersion = 3;
  socket.disconnected = false;
  socket.out = [];
  const realEmit = socket.emit.bind(socket);
  // Client-bound events are recorded; the handlers registered with socket.on still run for inbound ones.
  socket.emit = (name, ...args) => {
    if (name.startsWith('dictation:live:') && ['text', 'ended'].includes(name.split(':')[2])) { socket.out.push([name, args[0]]); return true; }
    return realEmit(name, ...args);
  };
  Object.assign(socket, over);
  return socket;
}

const flush = () => new Promise((r) => setImmediate(r));
const frame = (bytes = 4800) => Buffer.alloc(bytes);
const SECRET_WORDS = 'Sara Testwell has ghost ants';

async function started(over = {}) {
  const socket = fakeSocket(over);
  live.registerDictationLive(socket, { WebSocket: FakeUpstream });
  const ack = jest.fn();
  socket.emit('dictation:live:start', { customerId: 'c1', serviceId: 's1' }, ack);
  await flush();
  const upstream = FakeUpstream.last;
  upstream.open();
  await flush();
  return { socket, upstream, ack };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  live._sessions.clear();
  FakeUpstream.last = null;
  process.env.GATE_DICTATION_LIVE_WORDS = 'true';
  process.env.GATE_SERVER_DICTATION = 'true';
  process.env.OPENAI_API_KEY = 'test-key';
  delete process.env.OPENAI_LIVE_TRANSCRIBE_MODEL;
  mockFence.mockImplementation(async (_actor, ids) => ({ customerId: ids.customerId, serviceId: ids.serviceId }));
  mockHints.mockResolvedValue({ prompt: 'WORD LIST', keywords: ['Testwell'], recordName: null });
  mockBudget.mockResolvedValue(true);
});
afterAll(() => {
  delete process.env.GATE_DICTATION_LIVE_WORDS;
  delete process.env.GATE_SERVER_DICTATION;
});

describe('refusals', () => {
  test.each([
    ['live words gate off', () => { delete process.env.GATE_DICTATION_LIVE_WORDS; }],
    ['live words gate not exactly true', () => { process.env.GATE_DICTATION_LIVE_WORDS = '1'; }],
    ['server dictation gate off', () => { delete process.env.GATE_SERVER_DICTATION; }],
    ['no OpenAI key', () => { delete process.env.OPENAI_API_KEY; }],
  ])('%s: no session, no OpenAI socket', async (_name, setup) => {
    setup();
    const socket = fakeSocket();
    live.registerDictationLive(socket, { WebSocket: FakeUpstream });
    const ack = jest.fn();
    socket.emit('dictation:live:start', {}, ack);
    await flush();
    expect(ack).toHaveBeenCalledWith({ ok: false, reason: 'unavailable' });
    expect(FakeUpstream.last).toBeNull();
    expect(mockBudget).not.toHaveBeenCalled();
  });

  test('a full shared budget refuses before any word list or OpenAI socket', async () => {
    mockBudget.mockResolvedValue(false);
    const socket = fakeSocket();
    live.registerDictationLive(socket, { WebSocket: FakeUpstream });
    const ack = jest.fn();
    socket.emit('dictation:live:start', {}, ack);
    await flush();
    expect(ack).toHaveBeenCalledWith({ ok: false, reason: 'budget' });
    expect(mockHints).not.toHaveBeenCalled();
    expect(FakeUpstream.last).toBeNull();
  });

  test('a second start on the same socket is refused while the first runs', async () => {
    const { socket } = await started();
    const ack = jest.fn();
    socket.emit('dictation:live:start', {}, ack);
    await flush();
    expect(ack).toHaveBeenCalledWith({ ok: false, reason: 'busy' });
  });

  test('the budget key is the staff bucket key the clip limiter uses', async () => {
    await started();
    expect(mockBudget).toHaveBeenCalledWith('tech:tech-1:v3');
  });
});

describe('context and session setup', () => {
  test('a technician is fenced as a technician; the word list is that technician only; foreign ids never reach it', async () => {
    mockFence.mockResolvedValue({ customerId: null, serviceId: null });
    await started();
    expect(mockFence).toHaveBeenCalledWith({ techRole: 'technician', technicianId: 'tech-1' }, { customerId: 'c1', serviceId: 's1' });
    expect(mockHints).toHaveBeenCalledWith({ customerId: null, serviceId: null, scope: { technicianId: 'tech-1' } });
  });

  test('an admin gets an unscoped word list', async () => {
    await started({ userType: 'admin', userId: 'admin-1' });
    expect(mockHints).toHaveBeenCalledWith({ customerId: 'c1', serviceId: 's1', scope: {} });
  });

  test('session.update: transcription session, 24 kHz PCM, no turn detection, merged and cleaned keywords, default model', async () => {
    const { upstream, ack } = await started();
    expect(upstream.url).toBe('wss://api.openai.com/v1/realtime?intent=transcription');
    expect(upstream.opts.headers.Authorization).toBe('Bearer test-key');
    const update = upstream.sent[0];
    expect(update.type).toBe('session.update');
    expect(update.session.type).toBe('transcription');
    const input = update.session.audio.input;
    expect(input.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    expect(input.turn_detection).toBeNull();
    expect(input.transcription.model).toBe('gpt-live-transcribe');
    expect(input.transcription.prompt).toBe('WORD LIST');
    expect(input.transcription.languages).toEqual(['en']);
    expect(input.transcription.keywords).toEqual(['BaseWord', 'Bad Word', 'Testwell']);
    expect(ack).toHaveBeenCalledWith({ ok: true });
  });

  test('OPENAI_LIVE_TRANSCRIBE_MODEL overrides the model', async () => {
    process.env.OPENAI_LIVE_TRANSCRIBE_MODEL = 'gpt-live-transcribe-2';
    const { upstream } = await started();
    expect(upstream.sent[0].session.audio.input.transcription.model).toBe('gpt-live-transcribe-2');
  });

  test('an OpenAI socket that fails to open answers not ok and leaves no session', async () => {
    const socket = fakeSocket();
    live.registerDictationLive(socket, { WebSocket: FakeUpstream });
    const ack = jest.fn();
    socket.emit('dictation:live:start', {}, ack);
    await flush();
    FakeUpstream.last.emit('error', new Error('connect failed'));
    expect(ack).toHaveBeenCalledWith({ ok: false, reason: 'open_failed' });
    expect(live._sessions.size).toBe(0);
  });
});

describe('audio and text', () => {
  test('audio frames are relayed as base64 appends; text joins finished segments then the live one, by item id', async () => {
    const { socket, upstream } = await started();
    socket.emit('dictation:live:audio', frame(4800));
    expect(upstream.sent[1]).toEqual({ type: 'input_audio_buffer.append', audio: frame(4800).toString('base64') });
    upstream.say({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: 'Treated the ' });
    upstream.say({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: 'lanai' });
    upstream.say({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'b', delta: 'ghost' });
    // 'b' completes first (out of order): order stays a, b
    upstream.say({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'b', transcript: 'Ghost ants.' });
    expect(socket.out.at(-1)).toEqual(['dictation:live:text', { text: 'Treated the lanai Ghost ants.' }]);
    upstream.say({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'Treated the lanai.' });
    expect(socket.out.at(-1)).toEqual(['dictation:live:text', { text: 'Treated the lanai. Ghost ants.' }]);
  });

  test('a card number in the preview is masked like every other transcript', async () => {
    const { socket, upstream } = await started();
    upstream.say({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'card 4111 1111 1111 1111 thanks' });
    expect(socket.out.at(-1)[1].text).not.toMatch(/4111 1111 1111 1111/);
  });

  test('a long dictation keeps its newest words', async () => {
    const { socket, upstream } = await started();
    upstream.say({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: `${'old '.repeat(300)}newest words` });
    const { text } = socket.out.at(-1)[1];
    expect(text.length).toBeLessThanOrEqual(400);
    expect(text.endsWith('newest words')).toBe(true);
  });

  test.each([
    ['an odd byte count', frame(4801)],
    ['an oversize frame', frame(live.MAX_FRAME_BYTES + 2)],
    ['an empty frame', frame(0)],
    ['not binary', 'text'],
  ])('%s ends the session without relaying it', async (_name, bad) => {
    const { socket, upstream } = await started();
    socket.emit('dictation:live:audio', bad);
    expect(upstream.types()).toEqual(['session.update']);
    expect(upstream.closed).toBe(true);
    expect(socket.out.at(-1)).toEqual(['dictation:live:ended', { reason: 'bad_frame' }]);
  });

  test('audio before the session is ready, or after it ended, goes nowhere', async () => {
    const socket = fakeSocket();
    live.registerDictationLive(socket, { WebSocket: FakeUpstream });
    socket.emit('dictation:live:start', {}, jest.fn());
    await flush();
    socket.emit('dictation:live:audio', frame());
    expect(FakeUpstream.last.sent).toEqual([]);
  });
});

describe('hard caps', () => {
  test('the total byte limit holds', async () => {
    const { socket, upstream } = await started();
    const perFrame = live.MAX_FRAME_BYTES;
    const frames = Math.floor(live.MAX_SESSION_BYTES / perFrame);
    for (let i = 0; i < frames; i += 1) socket.emit('dictation:live:audio', frame(perFrame));
    expect(upstream.closed).toBe(false);
    socket.emit('dictation:live:audio', frame(perFrame));
    expect(upstream.closed).toBe(true);
    expect(socket.out.at(-1)).toEqual(['dictation:live:ended', { reason: 'max_bytes' }]);
    expect(upstream.sent.filter((m) => m.type === 'input_audio_buffer.append')).toHaveLength(frames);
  });

  test('15 seconds with no audio closes the session', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const { socket, upstream } = await started();
    jest.advanceTimersByTime(live.IDLE_MS - 1);
    expect(upstream.closed).toBe(false);
    socket.emit('dictation:live:audio', frame());
    jest.advanceTimersByTime(live.IDLE_MS - 1);
    expect(upstream.closed).toBe(false);
    jest.advanceTimersByTime(2);
    expect(upstream.closed).toBe(true);
    expect(socket.out.at(-1)).toEqual(['dictation:live:ended', { reason: 'idle' }]);
  });

  test('three minutes closes the session even while audio keeps coming', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const { socket, upstream } = await started();
    for (let t = 0; t < live.MAX_SESSION_MS; t += 5000) {
      socket.emit('dictation:live:audio', frame(480));
      jest.advanceTimersByTime(5000);
    }
    expect(upstream.closed).toBe(true);
    expect(socket.out.at(-1)).toEqual(['dictation:live:ended', { reason: 'max_time' }]);
  });

  test('a stalled upstream link ends the session instead of queueing audio', async () => {
    const { socket, upstream } = await started();
    upstream.bufferedAmount = 5 * 1024 * 1024;
    socket.emit('dictation:live:audio', frame());
    expect(upstream.closed).toBe(true);
  });

  test('an OpenAI error event ends the session and logs the code, never its message', async () => {
    const { socket, upstream } = await started();
    upstream.say({ type: 'error', error: { code: 'invalid_keyword', message: `bad keyword ${SECRET_WORDS}` } });
    expect(upstream.closed).toBe(true);
    expect(socket.out.at(-1)).toEqual(['dictation:live:ended', { reason: 'upstream_error' }]);
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]);
    expect(logged).toContain('invalid_keyword');
    expect(logged).not.toContain('Testwell');
  });
});

describe('stop and disconnect', () => {
  test('stop commits, waits for the last completed event, delivers the final text, then closes and acks', async () => {
    const { socket, upstream } = await started();
    socket.emit('dictation:live:audio', frame(4800));
    upstream.say({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: 'Treated' });
    const ack = jest.fn();
    socket.emit('dictation:live:stop', ack);
    expect(upstream.types().at(-1)).toBe('input_audio_buffer.commit');
    expect(upstream.closed).toBe(false);
    // audio after stop is ignored
    socket.emit('dictation:live:audio', frame(4800));
    expect(upstream.types().filter((t) => t === 'input_audio_buffer.append')).toHaveLength(1);
    upstream.say({ type: 'input_audio_buffer.committed', item_id: 'a' });
    expect(upstream.closed).toBe(false);
    upstream.say({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'Treated the lanai.' });
    await flush();
    expect(socket.out.filter(([n]) => n === 'dictation:live:text').at(-1)[1]).toEqual({ text: 'Treated the lanai.' });
    expect(upstream.closed).toBe(true);
    expect(ack).toHaveBeenCalledWith({ ok: true });
    expect(live._sessions.size).toBe(0);
  });

  test('stop closes after the wait when the last words never come', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const { socket, upstream } = await started();
    socket.emit('dictation:live:audio', frame(4800));
    const ack = jest.fn();
    socket.emit('dictation:live:stop', ack);
    jest.advanceTimersByTime(live.STOP_WAIT_MS - 1);
    expect(upstream.closed).toBe(false);
    jest.advanceTimersByTime(2);
    expect(upstream.closed).toBe(true);
    await Promise.resolve();
    expect(ack).toHaveBeenCalledWith({ ok: true });
  });

  test('stop with almost no audio sends no commit', async () => {
    const { socket, upstream } = await started();
    socket.emit('dictation:live:audio', frame(200));
    const ack = jest.fn();
    socket.emit('dictation:live:stop', ack);
    expect(upstream.types()).not.toContain('input_audio_buffer.commit');
    expect(upstream.closed).toBe(true);
    expect(ack).toHaveBeenCalledWith({ ok: true });
  });

  test('stop with no session acks ok', async () => {
    const socket = fakeSocket();
    live.registerDictationLive(socket, { WebSocket: FakeUpstream });
    const ack = jest.fn();
    socket.emit('dictation:live:stop', ack);
    expect(ack).toHaveBeenCalledWith({ ok: true });
  });

  test('a disconnect closes the OpenAI session', async () => {
    const { socket, upstream } = await started();
    socket.emit('disconnect');
    expect(upstream.closed).toBe(true);
    expect(live._sessions.size).toBe(0);
  });
});

describe('logging', () => {
  test('a whole session logs counts and sizes only, never the words', async () => {
    const { socket, upstream } = await started();
    socket.emit('dictation:live:audio', frame(4800));
    upstream.say({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: SECRET_WORDS });
    socket.emit('dictation:live:stop', jest.fn());
    upstream.say({ type: 'input_audio_buffer.committed', item_id: 'a' });
    upstream.say({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: SECRET_WORDS });
    await flush();
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]);
    expect(logged).toMatch(/\[dictation-live\] end reason=stopped .*frames=1 bytes=4800/);
    for (const word of ['Sara', 'Testwell', 'ghost', 'WORD LIST', 'test-key']) expect(logged).not.toContain(word);
  });
});
