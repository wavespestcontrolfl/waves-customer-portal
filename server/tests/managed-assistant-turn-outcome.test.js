// The customer assistant's turn recorder (agent-control S2a) must see how the
// stream actually ended: an `error` event or the runner's own event cap still
// hands the customer a reply, but the turn failed and its session row says
// so (Codex r3 on #3846). Drives the real processMessage path over a fake SSE
// body; the ledger recorder itself is mocked and asserted on.

const mockRecordSessionUsage = jest.fn();
jest.mock('../services/llm-dispatch-metrics', () => ({ recordSessionUsage: (...a) => mockRecordSessionUsage(...a) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/context-aggregator', () => jest.fn().mockImplementation(() => ({})));
jest.mock('../services/ai-assistant/tools-expanded', () => ({ executeToolCall: jest.fn() }));
jest.mock('../services/ai-assistant/managed-agent-config', () => ({ AGENT_CONFIG: { model: 'assistant-model' } }));

// A chainable knex stand-in: every builder method returns the chain, awaiting
// it resolves, `.first()` resolves to the active conversation.
const conversation = { id: 'conv-1', managed_session_id: 'sess-1', message_count: 3, context_snapshot: null };
const mockInsert = jest.fn();
function mockChain(table) {
  const c = {};
  for (const m of ['where', 'orderBy', 'update', 'select', 'limit']) c[m] = jest.fn(() => c);
  c.insert = jest.fn((row) => { mockInsert(table, row); return c; });
  c.first = jest.fn(() => Promise.resolve(conversation));
  c.then = (resolve, reject) => Promise.resolve(undefined).then(resolve, reject);
  return c;
}
jest.mock('../models/db', () => (table) => mockChain(table));

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

function sseBody(frames) {
  const enc = new TextEncoder();
  const chunks = frames.map(({ event, data }) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  return { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) }) };
}

function fetchFor(frames) {
  return jest.fn(async (url, opts = {}) => {
    if (opts.method === 'POST') return { ok: true, status: 200, json: async () => ({}) };
    if (String(url).includes('stream=true')) return { ok: true, status: 200, body: sseBody(frames) };
    throw new Error(`unexpected fetch ${opts.method || 'GET'} ${url}`);
  });
}

function load() {
  let assistant;
  jest.isolateModules(() => { assistant = require('../services/ai-assistant/managed-assistant'); });
  return assistant;
}

const text = (t) => ({ event: 'assistant', data: { text: t } });
const turn = () => load().processMessage({ message: 'What time is my next visit?', channel: 'sms', channelIdentifier: '+19415550100', customerId: 'cust-1' });
const recorded = () => mockRecordSessionUsage.mock.calls[0][0];

describe('managed assistant — the turn recorder sees how the stream ended', () => {
  beforeEach(() => {
    jest.resetModules();
    mockRecordSessionUsage.mockReset();
    mockInsert.mockReset();
    process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: 'k', MANAGED_AGENT_ID: 'agent_assistant_1' };
  });
  afterAll(() => { process.env = ORIGINAL_ENV; global.fetch = ORIGINAL_FETCH; });

  it('a turn the agent ended is recorded ok, with the reply saved', async () => {
    global.fetch = fetchFor([text('Thursday at 9am. '), text('See you then!'), { event: 'done', data: {} }]);
    await expect(turn()).resolves.toMatchObject({ reply: 'Thursday at 9am. See you then!', escalated: false });
    expect(mockRecordSessionUsage).toHaveBeenCalledTimes(1);
    expect(recorded()).toMatchObject({ laneId: 'agent_assistant', sessionId: 'sess-1', agentId: 'agent_assistant_1', model: 'assistant-model', failure: null });
    expect(mockInsert).toHaveBeenCalledWith('agent_messages', expect.objectContaining({ role: 'assistant', content: 'Thursday at 9am. See you then!', sent_to_customer: true }));
  });

  it('an error event is a failed turn (session_error_event) even though the fallback reply still goes out', async () => {
    global.fetch = fetchFor([{ event: 'error', data: { type: 'overloaded_error' } }, text('never read')]);
    const res = await turn();
    expect(res.reply).toMatch(/having trouble right now/);
    expect(recorded()).toMatchObject({ sessionId: 'sess-1', failure: 'session_error_event' });
    expect(mockInsert).toHaveBeenCalledWith('agent_messages', expect.objectContaining({ role: 'assistant', content: res.reply }));
  });

  it('an error event after partial text keeps the partial reply and still fails the turn', async () => {
    global.fetch = fetchFor([text('Partial answer.'), { event: 'error', data: { type: 'api_error' } }]);
    await expect(turn()).resolves.toMatchObject({ reply: 'Partial answer.' });
    expect(recorded()).toMatchObject({ failure: 'session_error_event' });
  });

  it("the runner's own event cap is a failed turn (max_events), not a success", async () => {
    // 30 events never reach a terminal frame: the 30th trips the cap
    global.fetch = fetchFor(Array.from({ length: 40 }, () => text('x')));
    const res = await turn();
    expect(res.reply).toBe('x'.repeat(29));
    expect(recorded()).toMatchObject({ sessionId: 'sess-1', failure: 'max_events' });
  });

  it("a provider rejection of the turn's event POST keeps its status — the recorder sees anthropic_429, the customer gets the fallback", async () => {
    global.fetch = jest.fn(async (url, opts = {}) => {
      if (opts.method === 'POST') return { ok: false, status: 429, text: async () => 'rate limited' };
      throw new Error(`unexpected fetch ${url}`);
    });
    const res = await turn();
    expect(res.reply).toMatch(/having trouble right now/);
    const { failure } = recorded();
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ status: 429, code: 'anthropic_429' });
  });

  it('a throw after a failed stream keeps the first failure', async () => {
    global.fetch = fetchFor([{ event: 'error', data: {} }]);
    // the reply save blows up after the stream already failed
    mockInsert.mockImplementation((table, row) => { if (row.role === 'assistant') throw new Error('db down'); });
    const res = await turn();
    expect(res.reply).toMatch(/having trouble right now/);
    expect(recorded()).toMatchObject({ failure: 'session_error_event' });
  });
});
