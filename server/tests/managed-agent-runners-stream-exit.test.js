// The BI, content and lead-response runners' session recorder must see how the stream
// actually ended (Codex r7 on #3846): a `session.error` event is the same
// failure as `error`, and a stream that closes before any terminal event is
// `session_stream_eof` — never a success the later session GET could
// upgrade to ok. And the reported duration is the run's own: the recorder's
// usage GET after it (up to its 15s timeout) is observability time.
// Drives the real run() paths over a fake SSE body with the recorder mocked.

const mockRecordSessionUsage = jest.fn();
jest.mock('../services/llm-dispatch-metrics', () => ({ recordSessionUsage: (...a) => mockRecordSessionUsage(...a) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/bi-agent-tools', () => ({ executeBITool: jest.fn() }));
jest.mock('../services/bi-agent-config', () => ({ BI_AGENT_CONFIG: { model: 'bi-model' } }));
jest.mock('../services/content/content-agent-tools', () => ({ executeContentTool: jest.fn() }));
jest.mock('../services/content/content-agent-config', () => ({ CONTENT_AGENT_CONFIG: { model: 'content-model' } }));
jest.mock('../models/db', () => () => ({ insert: async () => {}, where: () => ({ first: async () => null }) }));
jest.mock('../services/lead-response-tools', () => ({ executeLeadTool: jest.fn() }));
jest.mock('../services/lead-response-agent-config', () => ({ LEAD_RESPONSE_AGENT_CONFIG: { model: 'lead-model' } }));
jest.mock('../services/intelligence-bar/circuit-breaker', () => ({ getBreaker: jest.fn(() => ({ isOpen: () => false, recordSuccess() {}, recordFailure() {} })) }));
jest.mock('../services/intelligence-bar/tool-events', () => ({ recordToolEvent: jest.fn() }));

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_NOW = Date.now;

let now;
function sseBody(frames) {
  const enc = new TextEncoder();
  const chunks = frames.map(({ event, data }) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  return { getReader: () => ({ read: async () => { now += 1000; return chunks.length ? { done: false, value: chunks.shift() } : { done: true }; } }) };
}
function fetchFor(frames) {
  return jest.fn(async (url, opts = {}) => {
    if (opts.method === 'POST' && String(url).endsWith('/sessions')) return { ok: true, status: 200, json: async () => ({ id: 'sess-1' }) };
    if (opts.method === 'POST') return { ok: true, status: 200, json: async () => ({}) };
    if (/stream=true|\/events\/stream$/.test(String(url))) return { ok: true, status: 200, body: sseBody(frames) };
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
    mockRecordSessionUsage.mockReset();
    mockRecordSessionUsage.mockResolvedValue(null);
    now = 1_000_000;
    Date.now = () => now;
    process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: 'k', LEAD_AGENT_ID: 'agent_lead_1', LEAD_AGENT_ENVIRONMENT_ID: 'env_1' };
  });
  afterAll(() => { process.env = ORIGINAL_ENV; global.fetch = ORIGINAL_FETCH; Date.now = ORIGINAL_NOW; });

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
