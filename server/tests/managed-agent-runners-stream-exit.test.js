// The BI, content and lead-response runners' session recorder must see how the stream
// actually ended (Codex r7 on #3846): a `session.error` event is the same
// failure as `error`, and a stream that closes before any terminal event is
// `session_stream_eof` — never a success the later session GET could
// upgrade to ok. And the reported duration is the run's own: the recorder's
// usage GET after it (up to its 15s timeout) is observability time.
// Drives the real run() paths over a fake SSE body with the recorder mocked.

const mockRecordSessionUsage = jest.fn();
const mockExecuteLeadTool = jest.fn();
const mockExecuteBITool = jest.fn();
const mockBreakerFailure = jest.fn();
jest.mock('../services/llm-dispatch-metrics', () => ({ recordSessionUsage: (...a) => mockRecordSessionUsage(...a) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/bi-agent-tools', () => ({ executeBITool: (...a) => mockExecuteBITool(...a) }));
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
});

// bi-agent-only: the requires_action batching (agent.custom_tool_use events
// collected, then executed and replied to in ONE POST when the idle names
// their event_ids), the stream-before-kickoff ordering, the wall-clock
// deadline replacing the old 25-event cap, and the idle stop reasons that
// are neither requires_action nor end_turn (Codex r7-era rewrite — see
// bi-agent.js header comment for the protocol this pins).
describe('bi-agent — current managed agents protocol', () => {
  const path = '../services/bi-agent';
  const idle = (stop, eventIds) => ({ event: 'session.status_idle', data: { stop_reason: { type: stop, ...(eventIds ? { event_ids: eventIds } : {}) } } });
  const customToolUse = (id, name, input = {}) => ({ event: 'agent.custom_tool_use', data: { id, name, input } });

  beforeEach(() => {
    jest.resetModules();
    mockExecuteBITool.mockReset();
    mockRecordSessionUsage.mockReset();
    mockRecordSessionUsage.mockResolvedValue(null);
    now = 1_000_000;
    Date.now = () => now;
    process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: 'k', BI_AGENT_ID: 'agent_bi_1', BI_AGENT_ENVIRONMENT_ID: 'env_1' };
    delete process.env.BI_AGENT_TIMEOUT_MS;
  });
  afterAll(() => { process.env = ORIGINAL_ENV; global.fetch = ORIGINAL_FETCH; Date.now = ORIGINAL_NOW; });

  // Every POST body, in call order, alongside the URL it was sent to — lets
  // a test assert both ordering (stream opened before the kickoff POST) and
  // exact event batching (one POST per requires_action idle).
  function postsSent() {
    return global.fetch.mock.calls
      .filter(([, opts = {}]) => opts.method === 'POST')
      .map(([url, opts]) => ({ url: String(url), body: JSON.parse(opts.body || '{}') }));
  }

  it('opens the stream before sending the kickoff, and the kickoff is {events:[{type:"user.message",...}]}', async () => {
    global.fetch = fetchFor([text('done'), { event: 'done', data: {} }]);
    await load(path).run({ skipSMS: true });

    const calls = global.fetch.mock.calls.map(([url, opts = {}]) => ({ url: String(url), method: opts.method }));
    const streamIndex = calls.findIndex(c => c.url.endsWith('/events/stream'));
    const kickoffIndex = calls.findIndex(c => c.method === 'POST' && c.url.endsWith('/sessions/sess-1/events'));
    expect(streamIndex).toBeGreaterThanOrEqual(0);
    expect(kickoffIndex).toBeGreaterThan(streamIndex);

    const kickoffBody = JSON.parse(global.fetch.mock.calls[kickoffIndex][1].body);
    expect(kickoffBody).toEqual({ events: [{ type: 'user.message', content: [{ type: 'text', text: expect.any(String) }] }] });
  });

  it('agent.message content blocks become the returned report, even when the SSE event line is absent', async () => {
    global.fetch = fetchFor([
      { event: 'message', data: { type: 'agent.message', content: [{ type: 'text', text: 'Briefing ' }, { type: 'text', text: 'saved.' }] } },
      idle('end_turn'),
    ]);
    const result = await load(path).run({ skipSMS: true });
    expect(result.report).toBe('Briefing saved.');
    expect(recorded()).toMatchObject({ failure: null });
  });

  it('two agent.custom_tool_use events + one requires_action idle naming both → exactly ONE POST with both results', async () => {
    mockExecuteBITool.mockImplementation(async (name) => ({ ok: true, tool: name }));
    global.fetch = fetchFor([
      customToolUse('tool-1', 'get_revenue_snapshot'),
      customToolUse('tool-2', 'get_customer_snapshot'),
      idle('requires_action', ['tool-1', 'tool-2']),
      { event: 'done', data: {} },
    ]);

    const result = await load(path).run({ skipSMS: true });
    expect(result.toolsExecuted).toEqual(['get_revenue_snapshot', 'get_customer_snapshot']);
    expect(mockExecuteBITool).toHaveBeenCalledTimes(2);

    const toolResultPosts = postsSent().filter(p => (p.body.events || []).some(e => e.type === 'user.custom_tool_result'));
    expect(toolResultPosts).toHaveLength(1);
    const events = toolResultPosts[0].body.events;
    expect(events).toHaveLength(2);
    expect(events.find(e => e.custom_tool_use_id === 'tool-1').content[0].text).toBe(JSON.stringify({ ok: true, tool: 'get_revenue_snapshot' }));
    expect(events.find(e => e.custom_tool_use_id === 'tool-2').content[0].text).toBe(JSON.stringify({ ok: true, tool: 'get_customer_snapshot' }));
    expect(events.every(e => !e.is_error)).toBe(true);
    expect(recorded()).toMatchObject({ failure: null });
  });

  it('is_error is set only when the tool threw', async () => {
    mockExecuteBITool.mockRejectedValue(new Error('boom'));
    global.fetch = fetchFor([
      customToolUse('tool-1', 'get_revenue_snapshot'),
      idle('requires_action', ['tool-1']),
      { event: 'done', data: {} },
    ]);
    await load(path).run({ skipSMS: true });
    const toolResultPosts = postsSent().filter(p => (p.body.events || []).some(e => e.type === 'user.custom_tool_result'));
    expect(toolResultPosts[0].body.events[0].is_error).toBe(true);
  });

  it('a requires_action idle naming an id with no pending tool use still sends the results it does have', async () => {
    mockExecuteBITool.mockImplementation(async (name) => ({ ok: true, tool: name }));
    global.fetch = fetchFor([
      customToolUse('tool-1', 'get_revenue_snapshot'),
      idle('requires_action', ['tool-1', 'tool-unknown']),
      { event: 'done', data: {} },
    ]);
    const result = await load(path).run({ skipSMS: true });
    expect(result.toolsExecuted).toEqual(['get_revenue_snapshot']);
    const toolResultPosts = postsSent().filter(p => (p.body.events || []).some(e => e.type === 'user.custom_tool_result'));
    expect(toolResultPosts[0].body.events).toHaveLength(1);
    expect(recorded()).toMatchObject({ failure: null });
  });

  it('an idle with retries_exhausted is a failed run (session_idle_retries_exhausted)', async () => {
    global.fetch = fetchFor([text('partial'), idle('retries_exhausted'), text('never read')]);
    await load(path).run({ skipSMS: true });
    expect(recorded()).toMatchObject({ failure: 'session_idle_retries_exhausted' });
  });

  it('an idle with budget_reached is a failed run (session_idle_budget_reached)', async () => {
    global.fetch = fetchFor([idle('budget_reached'), text('never read')]);
    await load(path).run({ skipSMS: true });
    expect(recorded()).toMatchObject({ failure: 'session_idle_budget_reached' });
  });

  it('more than 25 stream events in one run no longer fails (the old max-events cap is gone)', async () => {
    const manyFrames = [...Array.from({ length: 30 }, (_, i) => text(`chunk ${i} `)), { event: 'done', data: {} }];
    global.fetch = fetchFor(manyFrames);
    const result = await load(path).run({ skipSMS: true });
    expect(result.sessionId).toBe('sess-1');
    expect(recorded()).toMatchObject({ failure: null });
  });

  it('a stream that never terminates is failed as session_timeout by the deadline (BI_AGENT_TIMEOUT_MS)', async () => {
    process.env.BI_AGENT_TIMEOUT_MS = '500';
    // No terminal frame at all — without the deadline this would hang until
    // the mock stream's own (irrelevant) EOF.
    global.fetch = fetchFor([text('one'), text('two'), text('three')]);
    await load(path).run({ skipSMS: true });
    expect(recorded()).toMatchObject({ failure: 'session_timeout' });
  });

  it('an invalid BI_AGENT_TIMEOUT_MS falls back to the default instead of a NaN/zero deadline', () => {
    process.env.BI_AGENT_TIMEOUT_MS = 'not-a-number';
    const { resolveTimeoutMs } = load(path)._test;
    expect(resolveTimeoutMs()).toBe(10 * 60 * 1000);

    process.env.BI_AGENT_TIMEOUT_MS = '0';
    expect(load(path)._test.resolveTimeoutMs()).toBe(10 * 60 * 1000);

    process.env.BI_AGENT_TIMEOUT_MS = '90000';
    expect(load(path)._test.resolveTimeoutMs()).toBe(90000);
  });
});
