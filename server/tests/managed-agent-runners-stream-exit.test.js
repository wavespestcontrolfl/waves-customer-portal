// The BI, content and lead-response runners' session recorder must see how the stream
// actually ended (Codex r7 on #3846): a `session.error` event is the same
// failure as `error`, and a stream that closes before any terminal event is
// `session_stream_eof` — never a success the later session GET could
// upgrade to ok. And the reported duration is the run's own: the recorder's
// usage GET after it (up to its 15s timeout) is observability time.
// Drives the real run() paths over a fake SSE body with the recorder mocked.

const mockRecordSessionUsage = jest.fn();
const mockExecuteLeadTool = jest.fn();
const mockBreakerFailure = jest.fn();
jest.mock('../services/llm-dispatch-metrics', () => ({ recordSessionUsage: (...a) => mockRecordSessionUsage(...a) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/bi-agent-tools', () => ({ executeBITool: jest.fn() }));
jest.mock('../services/bi-agent-config', () => ({ BI_AGENT_CONFIG: { model: 'bi-model' } }));
jest.mock('../services/content/content-agent-tools', () => ({ executeContentTool: jest.fn() }));
jest.mock('../services/content/content-agent-config', () => ({ CONTENT_AGENT_CONFIG: { model: 'content-model' } }));
jest.mock('../models/db', () => () => ({ insert: async () => {}, where: () => ({ first: async () => null }) }));
jest.mock('../services/lead-response-tools', () => ({ executeLeadTool: (...args) => mockExecuteLeadTool(...args) }));
jest.mock('../services/lead-response-agent-config', () => ({ LEAD_RESPONSE_AGENT_CONFIG: { model: 'lead-model' } }));
jest.mock('../services/intelligence-bar/circuit-breaker', () => ({ getBreaker: jest.fn(() => ({ isTripped: () => false, recordSuccess() {}, recordFailure: mockBreakerFailure })) }));
jest.mock('../services/intelligence-bar/tool-events', () => ({ recordToolEvent: jest.fn() }));

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_NOW = Date.now;

let now;
function sseBody(frames, splitFrames) {
  const enc = new TextEncoder();
  const chunks = frames.flatMap(({ event, data }) => {
    const frame = enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const split = frame.indexOf(10) + 1;
    return splitFrames ? [frame.subarray(0, split), frame.subarray(split)] : [frame];
  });
  return { getReader: () => ({ read: async () => { now += 1000; return chunks.length ? { done: false, value: chunks.shift() } : { done: true }; } }) };
}
function fetchFor(frames, splitFrames = false) {
  return jest.fn(async (url, opts = {}) => {
    if (opts.method === 'POST' && String(url).endsWith('/sessions')) return { ok: true, status: 200, json: async () => ({ id: 'sess-1' }) };
    if (opts.method === 'POST') return { ok: true, status: 200, json: async () => ({}) };
    if (/stream=true|\/events\/stream$/.test(String(url))) return { ok: true, status: 200, body: sseBody(frames, splitFrames) };
    throw new Error(`unexpected fetch ${opts.method || 'GET'} ${url}`);
  });
}
function load(path) {
  let mod;
  jest.isolateModules(() => { mod = require(path); });
  return mod;
}
const text = (t) => ({ event: 'assistant', data: { text: t } });
const recorded = () => mockRecordSessionUsage.mock.calls[0][0];

const RUNNERS = [
  ['bi-agent', '../services/bi-agent', 'agent_bi', (m) => m.run({ skipSMS: true })],
  ['content-agent', '../services/content/content-agent', 'agent_content', (m) => m.run({ topic: 'termites', publishDraft: false, distributeSocial: false })],
  ['lead-response-agent', '../services/lead-response-agent', 'agent_lead', (m) => m.processLead({ leadId: 'lead-1', customerId: 'cust-1', name: 'Test Lead', phone: '+19415550100' })],
];

describe.each(RUNNERS)('%s — the session recorder sees how the stream ended', (name, path, laneId, run) => {
  beforeEach(() => {
    jest.resetModules();
    mockRecordSessionUsage.mockReset();
    mockRecordSessionUsage.mockResolvedValue(null);
    now = 1_000_000;
    Date.now = () => now;
    process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: 'k', BI_AGENT_ID: 'agent_bi_1', BI_AGENT_ENVIRONMENT_ID: 'env_1', CONTENT_AGENT_ID: 'agent_content_1', LEAD_AGENT_ID: 'agent_lead_1', LEAD_AGENT_ENVIRONMENT_ID: 'env_1' };
  });
  afterAll(() => { process.env = ORIGINAL_ENV; global.fetch = ORIGINAL_FETCH; Date.now = ORIGINAL_NOW; });

  it('a run the session ended is recorded ok', async () => {
    global.fetch = fetchFor([text('Report body. '), { event: 'done', data: {} }]);
    await expect(run(load(path))).resolves.toMatchObject({ sessionId: 'sess-1' });
    expect(mockRecordSessionUsage).toHaveBeenCalledTimes(1);
    expect(recorded()).toMatchObject({ laneId, sessionId: 'sess-1', failure: null });
  });

  it('event and data in separate network chunks preserve the terminal outcome', async () => {
    global.fetch = fetchFor([text('QA café 🌊'), { event: 'done', data: {} }], true);
    await expect(run(load(path))).resolves.toMatchObject({ sessionId: 'sess-1' });
    expect(recorded()).toMatchObject({ laneId, failure: null });
  });

  it.each(['turn_end', 'session_end'])('a %s event is a terminal, like done (Codex r10)', async (terminal) => {
    global.fetch = fetchFor([text('all done'), { event: terminal, data: {} }, text('never read')]);
    await expect(run(load(path))).resolves.toMatchObject({ sessionId: 'sess-1' });
    expect(recorded()).toMatchObject({ failure: null });
  });

  it('an idle carrying an object-valued end_turn stop reason is the terminal (Codex r9)', async () => {
    global.fetch = fetchFor([text('all done'), { event: 'session.status_idle', data: { stop_reason: { type: 'end_turn' } } }, text('never read')]);
    await expect(run(load(path))).resolves.toMatchObject({ sessionId: 'sess-1' });
    expect(recorded()).toMatchObject({ failure: null });
  });

  it('a session.error event is the same failed run as an error event (session_error_event)', async () => {
    global.fetch = fetchFor([text('partial'), { event: 'session.error', data: { type: 'overloaded_error' } }, text('never read')]);
    await run(load(path));
    expect(recorded()).toMatchObject({ sessionId: 'sess-1', failure: 'session_error_event' });
  });

  it('a stream that closes before any terminal event is a failed run (session_stream_eof), not a success', async () => {
    global.fetch = fetchFor([text('partial')]);
    await run(load(path));
    expect(recorded()).toMatchObject({ sessionId: 'sess-1', failure: 'session_stream_eof' });
  });

  it("the reported duration is the run's own — the recorder's slow usage GET after it is not agent time", async () => {
    global.fetch = fetchFor([text('Report body. '), { event: 'done', data: {} }]);
    // 2 reader ticks × 1s = the run (the loop leaves on the done frame); the recorder then sits on its usage GET for 15s
    mockRecordSessionUsage.mockImplementation(async () => { now += 15_000; return null; });
    const result = await run(load(path));
    expect(result.durationSeconds).toBe(2);
  });
});

describe('lead-response-agent — a status_idle event is not terminal on its own (Codex r8)', () => {
  const path = '../services/lead-response-agent';
  const run = (m) => m.processLead({ leadId: 'lead-1', customerId: 'cust-1', name: 'Test Lead', phone: '+19415550100' });
  const idle = (stop) => ({ event: 'session.status_idle', data: { stop_reason: { type: stop } } });
  beforeEach(() => {
    jest.resetModules();
    mockExecuteLeadTool.mockReset();
    mockBreakerFailure.mockClear();
    mockRecordSessionUsage.mockReset();
    mockRecordSessionUsage.mockResolvedValue(null);
    now = 1_000_000;
    Date.now = () => now;
    process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: 'k', LEAD_AGENT_ID: 'agent_lead_1', LEAD_AGENT_ENVIRONMENT_ID: 'env_1' };
  });
  afterAll(() => { process.env = ORIGINAL_ENV; global.fetch = ORIGINAL_FETCH; Date.now = ORIGINAL_NOW; });

  it('passes the assigned server subject separately from model-supplied targets', async () => {
    const input = { lead_id: 'foreign-lead', customer_id: 'foreign-customer' };
    mockExecuteLeadTool.mockResolvedValue({ error: 'Foreign target rejected' });
    global.fetch = fetchFor([
      { event: 'tool_use', data: { id: 'tool-1', name: 'get_lead_details', input } },
      { event: 'done', data: {} },
    ]);
    await run(load(path));
    expect(mockExecuteLeadTool).toHaveBeenCalledWith('get_lead_details', input, {
      leadId: 'lead-1', customerId: 'cust-1', sessionId: 'sess-1', toolUseId: 'tool-1',
    });
  });

  it('rejects an unlinked lead before creating a paid managed-agent session', async () => {
    global.fetch = jest.fn();
    expect(await load(path).processLead({ leadId: 'lead-1', customerId: null })).toMatchObject({ skipped: true, error: expect.any(String) });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockExecuteLeadTool).not.toHaveBeenCalled();
  });

  it.each([true, false])('counts infrastructure failures but excludes validationError=%s from the shared breaker', async validationError => {
    mockExecuteLeadTool.mockResolvedValue({ error: 'Tool rejected', validationError });
    global.fetch = fetchFor([
      ...Array.from({ length: 5 }, (_, index) => ({ event: 'tool_use', data: { id: `tool-${index}`, name: 'get_lead_details', input: {} } })),
      { event: 'done', data: {} },
    ]);
    await run(load(path));
    expect(mockBreakerFailure).toHaveBeenCalledTimes(validationError ? 0 : 5);
  });

  it('a failed fallback draft save cannot be reported as queued', async () => {
    mockExecuteLeadTool.mockImplementation(async name => name === 'get_customer_context'
      ? { error: 'Context unavailable' } : { queued: false, error: 'Draft write failed' });
    global.fetch = fetchFor([
      { event: 'tool_use', data: { id: 'context-1', name: 'get_customer_context', input: {} } },
      { event: 'tool_use', data: { id: 'send-1', name: 'send_lead_response', input: { message: 'Synthetic draft' } } },
      { event: 'done', data: {} },
    ]);
    expect(await run(load(path))).toMatchObject({ actionTaken: null });
    expect(mockExecuteLeadTool).toHaveBeenCalledWith('queue_for_adam', expect.objectContaining({
      lead_id: 'lead-1', customer_id: 'cust-1', draft_response: 'Synthetic draft',
    }), { leadId: 'lead-1', customerId: 'cust-1', sessionId: 'sess-1', toolUseId: 'send-1' });
    expect(mockExecuteLeadTool.mock.calls.map(call => call[0])).toEqual(['get_customer_context', 'queue_for_adam']);
    const events = global.fetch.mock.calls.flatMap(([, options]) => JSON.parse(options.body || '{}').events || []);
    const result = events.find(event => event.custom_tool_use_id === 'send-1');
    expect(result.is_error).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'Human-review queue failed: Draft write failed' });
  });

  it.each([
    { queued: true, activityId: 'draft-1', failed: true, retryable: true, alertStatus: 'failed', error: 'Owner alert unavailable' },
    { queued: true, activityId: 'draft-1', retryable: true, alertStatus: 'pending', nextAllowedAt: '2099-01-01T00:00:00Z' },
    { queued: true, activityId: 'draft-1', alertStatus: 'suppressed' },
  ])('fallback preserves the durable draft and $alertStatus delivery outcome', async queued => {
    mockExecuteLeadTool.mockImplementation(async name => name === 'get_customer_context' ? { error: 'Context unavailable' } : queued);
    global.fetch = fetchFor([
      { event: 'tool_use', data: { id: 'context-1', name: 'get_customer_context', input: {} } },
      { event: 'tool_use', data: { id: 'send-1', name: 'send_lead_response', input: { message: 'Synthetic draft' } } },
      { event: 'done', data: {} },
    ]);
    expect(await run(load(path))).toMatchObject({ actionTaken: queued.failed ? null : 'auto_send_suppressed_queued' });
    const events = global.fetch.mock.calls.flatMap(([, options]) => JSON.parse(options.body || '{}').events || []);
    const result = events.find(event => event.custom_tool_use_id === 'send-1');
    expect(Boolean(result.is_error)).toBe(Boolean(queued.failed));
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ...queued, sent: false, autoSendSuppressed: true });
    expect(mockBreakerFailure).toHaveBeenCalledTimes(queued.failed ? 2 : 1);
  });

  it.each([true, false])('a direct queue result with queued=%s reports only a saved draft', async queued => {
    mockExecuteLeadTool.mockResolvedValue({ queued });
    global.fetch = fetchFor([
      { event: 'tool_use', data: { id: 'queue-1', name: 'queue_for_adam', input: { reason: 'QA' } } },
      { event: 'done', data: {} },
    ]);
    expect(await run(load(path))).toMatchObject({ actionTaken: queued ? 'queued_for_adam' : null });
  });

  it('a requires_action idle mid-run keeps streaming to the terminal frame — the run is ok with everything after it', async () => {
    global.fetch = fetchFor([text('first '), idle('requires_action'), text('second'), { event: 'done', data: {} }]);
    await expect(run(load(path))).resolves.toMatchObject({ report: 'first second' });
    expect(recorded()).toMatchObject({ failure: null });
  });

  it('an idle with end_turn is the terminal', async () => {
    global.fetch = fetchFor([text('all done'), idle('end_turn'), text('never read')]);
    await expect(run(load(path))).resolves.toMatchObject({ report: 'all done' });
    expect(recorded()).toMatchObject({ failure: null });
  });

  it('a requires_action idle followed by the stream closing is session_stream_eof, not a success', async () => {
    global.fetch = fetchFor([text('first '), idle('requires_action')]);
    await run(load(path));
    expect(recorded()).toMatchObject({ failure: 'session_stream_eof' });
  });

  it('a run with more than 25 stream events still succeeds — the old 25-event max_events cap is gone', async () => {
    const chatter = Array.from({ length: 30 }, (_, i) => text(`chunk ${i} `));
    global.fetch = fetchFor([...chatter, idle('end_turn')]);
    await expect(run(load(path))).resolves.toMatchObject({ sessionId: 'sess-1' });
    expect(recorded()).toMatchObject({ failure: null });
  });

  it('a stream that never reaches a terminal event fails as session_timeout under a small LEAD_AGENT_TIMEOUT_MS', async () => {
    process.env.LEAD_AGENT_TIMEOUT_MS = '500';
    global.fetch = fetchFor([text('still going'), text('still going 2'), text('still going 3')]);
    await run(load(path));
    expect(recorded()).toMatchObject({ sessionId: 'sess-1', failure: expect.objectContaining({ code: 'session_timeout' }) });
  });

  it('an invalid LEAD_AGENT_TIMEOUT_MS override falls back to the default instead of failing fast', async () => {
    process.env.LEAD_AGENT_TIMEOUT_MS = 'not-a-number';
    global.fetch = fetchFor([text('all done'), { event: 'done', data: {} }]);
    await expect(run(load(path))).resolves.toMatchObject({ sessionId: 'sess-1' });
    expect(recorded()).toMatchObject({ failure: null });
  });

  it('opens the SSE stream before posting the kickoff user.message (Managed Agents streams do not replay earlier events)', async () => {
    global.fetch = fetchFor([{ event: 'done', data: {} }]);
    await run(load(path));
    const calls = global.fetch.mock.calls;
    const streamIndex = calls.findIndex(([url]) => /\/events\/stream$/.test(String(url)));
    const kickoffIndex = calls.findIndex(([url, opts]) => opts?.method === 'POST' && /\/events$/.test(String(url)));
    expect(streamIndex).toBeGreaterThan(-1);
    expect(kickoffIndex).toBeGreaterThan(-1);
    expect(streamIndex).toBeLessThan(kickoffIndex);
  });

  it('agent.message content blocks become the returned report, even when the SSE event line is absent', async () => {
    global.fetch = fetchFor([
      { event: 'message', data: { type: 'agent.message', content: [{ type: 'text', text: 'Lead ' }, { type: 'text', text: 'handled.' }] } },
      idle('end_turn'),
    ]);
    await expect(run(load(path))).resolves.toMatchObject({ report: 'Lead handled.' });
  });

  // Frames arrive without advancing the fake clock, then the stream stays
  // open: only the real-time deadline timers (tool wait, POST signal) can
  // end these runs — the per-frame deadline check never fires.
  function openStreamBody(frames) {
    const enc = new TextEncoder();
    const chunks = frames.map(({ event, data }) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    return {
      getReader: () => ({
        read: () => (chunks.length ? Promise.resolve({ done: false, value: chunks.shift() }) : new Promise(() => {})),
        cancel: async () => {},
        releaseLock() {},
      }),
    };
  }
  function fetchWithOpenStream({ frames = [], onEventsPost }) {
    const seen = {};
    const fetchMock = jest.fn((url, opts = {}) => {
      if (opts.method === 'POST' && String(url).endsWith('/sessions')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ id: 'sess-1' }) });
      if (opts.method === 'POST') return onEventsPost(opts);
      seen.streamSignal = opts.signal;
      return Promise.resolve({ ok: true, status: 200, body: openStreamBody(frames) });
    });
    return { fetchMock, seen };
  }

  it('a tool that never returns ends the run at the deadline — session_timeout, no tool result sent', async () => {
    process.env.LEAD_AGENT_TIMEOUT_MS = '50';
    mockExecuteLeadTool.mockImplementation(() => new Promise(() => {}));
    const { fetchMock } = fetchWithOpenStream({
      frames: [{ event: 'agent.custom_tool_use', data: { id: 'tool-1', name: 'get_lead_details', input: {} } }],
      onEventsPost: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
    });
    global.fetch = fetchMock;

    expect(await run(load(path))).toBeNull();
    expect(recorded()).toMatchObject({ failure: expect.objectContaining({ code: 'session_timeout' }) });
    const toolResultPosts = fetchMock.mock.calls
      .filter(([, opts = {}]) => opts.method === 'POST' && String(opts.body || '').includes('user.custom_tool_result'));
    expect(toolResultPosts).toHaveLength(0);
  });

  it('an events POST that hangs is cut off at the deadline, and the open stream is closed', async () => {
    process.env.LEAD_AGENT_TIMEOUT_MS = '50';
    const { fetchMock, seen } = fetchWithOpenStream({
      onEventsPost: (opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason))),
    });
    global.fetch = fetchMock;

    expect(await run(load(path))).toBeNull();
    expect(recorded()).toMatchObject({ failure: expect.objectContaining({ code: 'session_timeout' }) });
    expect(seen.streamSignal.aborted).toBe(true);
  });

  it('a non-2xx stream response whose error body stalls still ends at the deadline (session_timeout)', async () => {
    process.env.LEAD_AGENT_TIMEOUT_MS = '50';
    global.fetch = jest.fn((url, opts = {}) => {
      if (opts.method === 'POST' && String(url).endsWith('/sessions')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ id: 'sess-1' }) });
      if (opts.method === 'POST') return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      return Promise.resolve({
        ok: false,
        status: 503,
        body: {},
        text: () => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
      });
    });

    expect(await run(load(path))).toBeNull();
    expect(recorded()).toMatchObject({ failure: expect.objectContaining({ code: 'session_timeout' }) });
  });

  const leadTool = (id, name, input = {}) => ({ event: 'agent.custom_tool_use', data: { id, name, input } });

  it('a session-creation POST that stalls ends at the deadline — no paid session, nothing billed', async () => {
    process.env.LEAD_AGENT_TIMEOUT_MS = '50';
    global.fetch = jest.fn((url, opts = {}) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason))));
    expect(await run(load(path))).toBeNull();
    expect(mockRecordSessionUsage).not.toHaveBeenCalled();
  });

  it('a repeated request for a tool use id already answered is not executed again', async () => {
    mockExecuteLeadTool.mockResolvedValue({ ok: true });
    global.fetch = fetchFor([leadTool('tool-1', 'get_lead_details'), leadTool('tool-1', 'get_lead_details'), idle('end_turn')]);
    await run(load(path));
    expect(mockExecuteLeadTool).toHaveBeenCalledTimes(1);
  });

  it('a lead gets at most ONE text per run — a second send_lead_response is answered as skipped', async () => {
    mockExecuteLeadTool.mockImplementation(async (name) => (name === 'send_lead_response' ? { sent: true } : { ok: true }));
    global.fetch = fetchFor([
      leadTool('tool-1', 'send_lead_response', { message: 'First' }),
      leadTool('tool-2', 'send_lead_response', { message: 'Second' }),
      idle('end_turn'),
    ]);
    const result = await run(load(path));
    expect(mockExecuteLeadTool.mock.calls.filter(([name]) => name === 'send_lead_response')).toHaveLength(1);
    expect(result).toMatchObject({ actionTaken: 'auto_sent' });
  });

  it('once the lead is queued for the owner, the agent cannot also text it (one reply decision)', async () => {
    mockExecuteLeadTool.mockImplementation(async (name) => (name === 'queue_for_adam' ? { queued: true } : { sent: true }));
    global.fetch = fetchFor([
      leadTool('tool-1', 'queue_for_adam', { draft_response: 'Draft' }),
      leadTool('tool-2', 'send_lead_response', { message: 'Text' }),
      idle('end_turn'),
    ]);
    const result = await run(load(path));
    expect(mockExecuteLeadTool.mock.calls.map(([name]) => name)).toEqual(['queue_for_adam']);
    expect(result).toMatchObject({ actionTaken: 'queued_for_adam' });
  });

  it('a blocked text does not use up the reply — the agent may still queue it for the owner', async () => {
    mockExecuteLeadTool.mockImplementation(async (name) => (name === 'send_lead_response' ? { sent: false, blocked: true } : { queued: true }));
    global.fetch = fetchFor([
      leadTool('tool-1', 'send_lead_response', { message: 'Text' }),
      leadTool('tool-2', 'queue_for_adam', { draft_response: 'Draft' }),
      idle('end_turn'),
    ]);
    const result = await run(load(path));
    expect(mockExecuteLeadTool.mock.calls.map(([name]) => name)).toEqual(['send_lead_response', 'queue_for_adam']);
    expect(result).toMatchObject({ actionTaken: 'queued_for_adam' });
  });

  it('a draft saved for the owner counts as the reply even when the owner alert failed', async () => {
    mockExecuteLeadTool.mockImplementation(async (name) => (name === 'queue_for_adam'
      ? { queued: true, failed: true, error: 'Owner alert delivery failed' }
      : { sent: true }));
    global.fetch = fetchFor([
      leadTool('tool-1', 'queue_for_adam', { draft_response: 'Draft' }),
      leadTool('tool-2', 'queue_for_adam', { draft_response: 'Draft again' }),
      leadTool('tool-3', 'send_lead_response', { message: 'Text' }),
      idle('end_turn'),
    ]);
    await run(load(path));
    expect(mockExecuteLeadTool.mock.calls.map(([name]) => name)).toEqual(['queue_for_adam']);
  });

  it('a final agent.message carrying end_turn collects its text AND ends the run', async () => {
    global.fetch = fetchFor([
      { event: 'message', data: { type: 'agent.message', stop_reason: { type: 'end_turn' }, content: [{ type: 'text', text: 'Done.' }] } },
      text('never read'),
    ]);
    await expect(run(load(path))).resolves.toMatchObject({ report: 'Done.' });
    expect(recorded()).toMatchObject({ failure: null });
  });

  it('a session that asks for more than 20 tool calls is stopped (max_tool_calls)', async () => {
    mockExecuteLeadTool.mockResolvedValue({ ok: true });
    global.fetch = fetchFor([
      ...Array.from({ length: 21 }, (_, i) => leadTool(`tool-${i}`, 'get_lead_details')),
      idle('end_turn'),
    ]);
    expect(await run(load(path))).toBeNull();
    expect(mockExecuteLeadTool).toHaveBeenCalledTimes(20);
    expect(recorded()).toMatchObject({ failure: expect.objectContaining({ code: 'max_tool_calls' }) });
  });

  it('a kickoff POST that fails closes the already-open stream', async () => {
    const { fetchMock, seen } = fetchWithOpenStream({
      onEventsPost: () => Promise.resolve({ ok: false, status: 500, text: async () => 'boom' }),
    });
    global.fetch = fetchMock;

    expect(await run(load(path))).toBeNull();
    expect(seen.streamSignal.aborted).toBe(true);
    expect(recorded().failure).toBeTruthy();
  });
});
