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

// The draft sink firing is the agent's work done, not the session's end
// (Codex r14 on #3846): the session still processes that tool result and
// ends its turn, and the session ledger snapshots usage after the stream —
// so the stream is read through the terminal event, and a wind-down that
// is cut off (deadline / early EOF) after a captured draft stays a success.
describe('agent dispatcher — a captured draft leaves on the terminal event', () => {
  const TOOL_USE = { event: 'agent.custom_tool_use', data: { id: 'tu-1', name: 'emit_draft', input: { frontmatter: {}, body: 'x' } } };
  let drafts;
  function loadWithSink() {
    drafts = new Map();
    let dispatcher;
    jest.isolateModules(() => {
      jest.doMock('../services/content/agents/brief-driven-tools', () => ({
        executeBriefTool: jest.fn(async (name, input, { sessionId }) => { drafts.set(sessionId, { body: input.body }); return { ok: true }; }),
        getDraft: (sessionId) => drafts.get(sessionId) || null,
        getCheckedRoutes: () => [],
        clearDraft: (sessionId) => drafts.delete(sessionId),
        registerSessionLint: () => {},
      }));
      dispatcher = require('../services/content/agents/agent-dispatcher');
    });
    return dispatcher;
  }
  // GET = the SSE stream; POST = the tool_result reply.
  let reads;
  function fetchFor(frames) {
    const inner = sseBody(frames).getReader();
    reads = 0;
    const body = { getReader: () => ({ read: async () => { reads += 1; return inner.read(); } }) };
    return jest.fn(async (url, opts) => (opts?.method === 'POST'
      ? { ok: true, status: 200, json: async () => ({}), text: async () => '' }
      : { ok: true, status: 200, body }));
  }

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: 'k' };
  });
  afterAll(() => { process.env = ORIGINAL_ENV; global.fetch = ORIGINAL_FETCH; });

  it('keeps reading after the sink fires and resolves on the terminal event (every frame consumed)', async () => {
    const frames = [TOOL_USE, { event: 'assistant', data: { text: 'wind-down' } }, { event: 'done', data: {} }];
    global.fetch = fetchFor(frames);
    const dispatcher = loadWithSink();
    await expect(dispatcher._streamAndExecute('sess-draft', 5_000)).resolves.toBeUndefined();
    expect(drafts.get('sess-draft')).toEqual({ body: 'x' });
    // the tool_result went back AND the stream was read past it to the terminal frame
    expect(global.fetch.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(1);
    expect(reads).toBe(3); // tool use, wind-down, terminal — the reader went past the sink
  });

  it('an early EOF after the draft is the wind-down cut off — resolves, not session_stream_eof', async () => {
    global.fetch = fetchFor([TOOL_USE]);
    const dispatcher = loadWithSink();
    await expect(dispatcher._streamAndExecute('sess-draft-eof', 5_000)).resolves.toBeUndefined();
    expect(drafts.get('sess-draft-eof')).toEqual({ body: 'x' });
  });

  it('the deadline after the draft is the wind-down running long — resolves, not session_timeout', async () => {
    // one frame (the tool use) lands before the reader checks the clock again
    global.fetch = fetchFor([TOOL_USE, { event: 'assistant', data: { text: 'still winding down' } }]);
    const dispatcher = loadWithSink();
    const realNow = Date.now;
    let calls = 0;
    // deadline math, the abort timer, and the first clock check before the tool use
    // all see t=1s; the check before the next read sees the deadline passed
    Date.now = () => (calls++ < 3 ? 1_000 : 1_000 + 10_000);
    try {
      await expect(dispatcher._streamAndExecute('sess-draft-slow', 5_000)).resolves.toBeUndefined();
    } finally { Date.now = realNow; }
    expect(drafts.get('sess-draft-slow')).toEqual({ body: 'x' });
  });

  it('without a draft the same EOF / deadline still fail (the r7 / r11 contracts hold)', async () => {
    global.fetch = fetchFor([{ event: 'assistant', data: { text: 'no sink' } }]);
    const err = await loadWithSink()._streamAndExecute('sess-nodraft', 5_000).catch((e) => e);
    expect(err.code).toBe('session_stream_eof');
  });
});
