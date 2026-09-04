// The brief-driven dispatcher's stream exits carry the code the session
// ledger files them under (Codex r6 on #3846): a session error event is a
// provider failure, the dispatcher's own deadline is a timeout — never the
// generic `streaming_failed`. Drives `_streamAndExecute` over a fake SSE body.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({ getFile: jest.fn() }));

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

function sseBody(frames) {
  const enc = new TextEncoder();
  const chunks = frames.map(({ event, data }) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  return { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) }) };
}

function load() {
  let dispatcher;
  jest.isolateModules(() => { dispatcher = require('../services/content/agents/agent-dispatcher'); });
  return dispatcher;
}

describe('agent dispatcher — stream exits carry their ledger code', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: 'k' };
  });
  afterAll(() => { process.env = ORIGINAL_ENV; global.fetch = ORIGINAL_FETCH; });

  it('a session error event throws session_error_event (→ provider)', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, body: sseBody([{ event: 'session.error', data: { type: 'overloaded_error', message: 'busy' } }]) }));
    const err = await load()._streamAndExecute('sess-err', 5_000).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^session_error: /);
    expect(err.code).toBe('session_error_event');
  });

  it('a stream that closes before any terminal event, with time remaining, throws session_stream_eof (→ provider) — not the deadline', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, body: sseBody([{ event: 'assistant', data: { text: 'still going' } }]) }));
    const err = await load()._streamAndExecute('sess-eof', 5_000).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/stream ended without a terminal event/);
    expect(err.code).toBe('session_stream_eof');
  });

  it("the loop ending past the deadline throws the dispatcher's own session_timeout (→ timeout)", async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, body: sseBody([{ event: 'assistant', data: { text: 'still going' } }]) }));
    const err = await load()._streamAndExecute('sess-slow', 0).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/timed out at its .* deadline/);
    expect(err.code).toBe('session_timeout');
  });

  it('a terminal event resolves — no code, nothing thrown', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, body: sseBody([{ event: 'assistant', data: { text: 'done' } }, { event: 'done', data: {} }]) }));
    await expect(load()._streamAndExecute('sess-ok', 5_000)).resolves.toBeUndefined();
  });
});
