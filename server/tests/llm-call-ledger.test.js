// Locks the LLM call-ledger contract (agent-control S2a): every provider
// adapter in services/llm/call.js records one row_kind='call' row with the
// provider's usage block normalised, the served model, latency and an
// error_code / error_class on failure — WITHOUT changing what any caller
// gets back (the adapters' own timeouts are the one new reason,
// `<provider>_timeout`). Dark behind GATE_LLM_CALL_LEDGER (no DB touch when
// off), never throws into the call it observes, and shares one chain id
// with the chain row dispatchWithFallback writes.

const mockInsert = jest.fn();
// The session recorder writes insert(...).onConflict(target).merge(updates).returning('id').
const mockMerge = jest.fn();
// failCall writes where({ id }).update(patch) against a call row the adapter filed as ok.
const mockUpdate = jest.fn(() => Promise.resolve(1));
// The session row already in the table when a turn is recorded (null = first turn).
let sessionPrev = null;
const mockDb = jest.fn((table) => ({
  insert: (row) => {
    const p = mockInsert(table, row);
    p.onConflict = (target) => ({ merge: (updates) => { mockMerge(table, target, updates); return { returning: p.returning }; } });
    return p;
  },
  where: (cond) => ({ update: (patch) => mockUpdate(table, cond, patch), first: () => Promise.resolve(sessionPrev) }),
}));
jest.mock('../models/db', () => {
  const db = (...args) => mockDb(...args);
  db.raw = (sql) => sql;
  // the session recorder reads-then-writes inside one transaction
  db.transaction = async (fn) => { const trx = (...args) => mockDb(...args); trx.raw = () => Promise.resolve(); return fn(trx); };
  return db;
});
// warn lines are captured globally: each isolateModules load gets its own mock instance.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn((...a) => { (global.__llmWarns = global.__llmWarns || []).push(a.join(' ')); }), error: jest.fn(), debug: jest.fn() }));
const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockAnthropicCreate(...args) },
})));

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

let nextId = 100;
function insertResolving() {
  const id = nextId += 1;
  const p = Promise.resolve([{ id }]);
  p.returning = () => Promise.resolve([{ id }]);
  return p;
}

function load() {
  let mods;
  jest.isolateModules(() => {
    mods = {
      metrics: require('../services/llm-dispatch-metrics'),
      call: require('../services/llm/call'),
      deep: require('../services/llm/deep'),
      context: require('../services/agent-control/context'),
    };
  });
  return mods;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const ledgerRows = () => mockInsert.mock.calls.filter(([t, row]) => t === 'llm_dispatch_log' && row.row_kind !== 'session_turn').map(([, row]) => row);
const turnRows = () => mockInsert.mock.calls.filter(([t, row]) => t === 'llm_dispatch_log' && row.row_kind === 'session_turn').map(([, row]) => row);
// merges by target: the session row (provider_ref) vs the turn row (step_id)
const mergesFor = (kind) => mockMerge.mock.calls.filter(([, target]) => String(target).includes(`'${kind}'`));
const callRows = () => ledgerRows().filter((r) => r.row_kind === 'call');

function fetchJson(data, { ok = true, status = 200 } = {}) {
  return jest.fn(() => Promise.resolve({ ok, status, json: () => Promise.resolve(data) }));
}

const OPENAI_BODY = {
  id: 'resp_1',
  model: 'openai-served',
  status: 'completed',
  output_text: '{"a":1}',
  usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 80 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 12 } },
};
const GEMINI_BODY = {
  modelVersion: 'gemini-served',
  candidates: [{ content: { parts: [{ text: '{"g":true}' }] } }],
  usageMetadata: { promptTokenCount: 50, cachedContentTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5 },
};
const ANTHROPIC_MESSAGE = {
  id: 'msg_1',
  model: 'anthropic-served',
  content: [{ type: 'text', text: '{"c":2}' }],
  usage: { input_tokens: 200, cache_read_input_tokens: 150, cache_creation_input_tokens: 25, output_tokens: 40 },
};

describe('llm call ledger', () => {
  beforeEach(() => {
    jest.resetModules();
    mockInsert.mockReset();
    mockInsert.mockImplementation(() => insertResolving());
    mockMerge.mockClear();
    mockDb.mockClear();
    mockAnthropicCreate.mockReset();
    process.env = { ...ORIGINAL_ENV, GATE_LLM_CALL_LEDGER: 'true', OPENAI_API_KEY: 'k', GEMINI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' };
    delete process.env.GATE_LLM_DISPATCH_METRICS;
    delete process.env.GATE_LLM_CALL_TRACES;
  });
  afterAll(() => { process.env = ORIGINAL_ENV; global.fetch = ORIGINAL_FETCH; });

  describe('extractUsage', () => {
    it('normalises each provider shape and nulls absent fields', () => {
      const { metrics } = load();
      expect(metrics.extractUsage('anthropic', ANTHROPIC_MESSAGE)).toEqual({
        input_tokens: 200, cached_input_tokens: 150, cache_write_tokens: 25, output_tokens: 40, reasoning_tokens: null,
      });
      expect(metrics.extractUsage('openai', OPENAI_BODY)).toEqual({
        input_tokens: 120, cached_input_tokens: 80, cache_write_tokens: null, output_tokens: 30, reasoning_tokens: 12,
      });
      expect(metrics.extractUsage('gemini', GEMINI_BODY)).toEqual({
        input_tokens: 50, cached_input_tokens: 10, cache_write_tokens: null, output_tokens: 20, reasoning_tokens: 5,
      });
    });

    it('never throws on garbage and returns all-null', () => {
      const { metrics } = load();
      const empty = { input_tokens: null, cached_input_tokens: null, cache_write_tokens: null, output_tokens: null, reasoning_tokens: null };
      expect(metrics.extractUsage('openai', null)).toEqual(empty);
      expect(metrics.extractUsage('anthropic', { usage: 'nope' })).toEqual(empty);
      expect(metrics.extractUsage('gemini', { usageMetadata: { promptTokenCount: 'x' } })).toEqual(empty);
      expect(metrics.extractUsage('unknown', { usage: { input_tokens: 1 } })).toEqual(empty);
    });
  });

  describe('callOpenAI', () => {
    it('records a call row with usage, served model, provider ref and latency; return gains usage only', async () => {
      global.fetch = fetchJson(OPENAI_BODY);
      const { call } = load();
      const result = await call.callOpenAI({ model: 'openai-requested', system: 's', text: 't' });
      expect(result).toEqual({ ok: true, text: '{"a":1}', json: { a: 1 }, model: 'openai-requested', usage: expect.objectContaining({ input_tokens: 120, output_tokens: 30 }) });
      await flush();
      const [row] = callRows();
      expect(row).toMatchObject({
        row_kind: 'call', ok: true, provider: 'openai', requested_model: 'openai-requested', served_model: 'openai-served',
        provider_ref: 'resp_1', input_tokens: 120, cached_input_tokens: 80, output_tokens: 30, reasoning_tokens: 12,
        error_code: null, error_class: null, policy: 'openai/openai-requested',
      });
      expect(row.latency_ms).toBeGreaterThanOrEqual(0);
      expect(typeof row.latency_ms).toBe('number');
    });

    it('records openai_incomplete as a failed call WITH usage (tokens were billed)', async () => {
      global.fetch = fetchJson({ ...OPENAI_BODY, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
      const { call } = load();
      expect(await call.callOpenAI({ model: 'm', text: 't' })).toEqual({ ok: false, reason: 'openai_incomplete' });
      await flush();
      const [row] = callRows();
      expect(row).toMatchObject({ ok: false, error_code: 'openai_incomplete', error_class: 'incomplete', input_tokens: 120, output_tokens: 30 });
    });

    it('a failed / cancelled Responses body is the provider\'s failure (openai_<status> → provider), never openai_incomplete', async () => {
      const { call } = load();
      global.__llmWarns = [];
      global.fetch = fetchJson({ ...OPENAI_BODY, status: 'failed', error: { code: 'server_error', message: 'rejected input: Jane Doe 941-555-0100' } });
      expect(await call.callOpenAI({ model: 'm', text: 't' })).toEqual({ ok: false, reason: 'openai_failed' });
      // the provider's error MESSAGE can quote the input — only its code and the response id are logged
      expect(global.__llmWarns.join("\n")).toMatch(/OpenAI response failed \(server_error\) \(resp_1\)/);
      expect(global.__llmWarns.join("\n")).not.toMatch(/Jane Doe|941-555/);
      global.fetch = fetchJson({ ...OPENAI_BODY, status: 'cancelled' });
      expect(await call.callOpenAI({ model: 'm', text: 't', jsonMode: false })).toEqual({ ok: false, reason: 'openai_cancelled' });
      await flush();
      expect(callRows().map((r) => [r.ok, r.error_code, r.error_class, r.input_tokens])).toEqual([[false, 'openai_failed', 'provider', 120], [false, 'openai_cancelled', 'provider', 120]]);
    });

    it('the refusal warning never carries the refusal body (it can echo customer detail)', async () => {
      const { call } = load();
      global.__llmWarns = [];
      global.fetch = fetchJson({ ...OPENAI_BODY, output_text: undefined, output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'I cannot discuss Jane Doe at 12 Palm St.' }] }] });
      await call.callOpenAI({ model: 'o', text: 't', jsonMode: false });
      const logged = global.__llmWarns.join('\n');
      expect(logged).toMatch(/OpenAI refusal \(resp_1\)/);
      expect(logged).not.toMatch(/Jane Doe|Palm St/);
    });

    it('a completed refusal block is a FAILED leg in both modes — openai_refusal recorded (with usage) AND returned, like anthropic_refusal', async () => {
      const { call } = load();
      const refused = { ...OPENAI_BODY, output_text: undefined, output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] }] };
      global.fetch = fetchJson(refused);
      expect(await call.callOpenAI({ model: 'o', text: 't' })).toEqual({ ok: false, reason: 'openai_refusal' });
      global.fetch = fetchJson(refused);
      expect(await call.callOpenAI({ model: 'o', text: 't', jsonMode: false })).toEqual({ ok: false, reason: 'openai_refusal' });
      await flush();
      expect(callRows().map((r) => [r.ok, r.error_code, r.error_class, r.input_tokens])).toEqual([[false, 'openai_refusal', 'instruction', 120], [false, 'openai_refusal', 'instruction', 120]]);
    });

    it('records HTTP failures with the status code and a provider class, no usage', async () => {
      global.fetch = fetchJson({}, { ok: false, status: 429 });
      const { call } = load();
      expect(await call.callOpenAI({ model: 'm', text: 't' })).toEqual({ ok: false, reason: 'openai_429' });
      await flush();
      expect(callRows()[0]).toMatchObject({ ok: false, error_code: 'openai_429', error_class: 'provider', input_tokens: null, served_model: null });
    });

    it('records a thrown fetch as error/infrastructure and still returns the legacy shape', async () => {
      global.fetch = jest.fn(() => Promise.reject(new Error('socket hang up')));
      const { call } = load();
      expect(await call.callOpenAI({ model: 'm', text: 't' })).toEqual({ ok: false, reason: 'error' });
      await flush();
      expect(callRows()[0]).toMatchObject({ ok: false, error_code: 'error', error_class: 'infrastructure' });
    });

    it("files the adapter's own AbortSignal timeout as openai_timeout / timeout, not infrastructure", async () => {
      global.fetch = jest.fn(() => Promise.reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })));
      const { call } = load();
      expect(await call.callOpenAI({ model: 'm', text: 't' })).toEqual({ ok: false, reason: 'openai_timeout' });
      await flush();
      expect(callRows()[0]).toMatchObject({ ok: false, error_code: 'openai_timeout', error_class: 'timeout' });
    });

    it('does not record (or touch the DB) when no key is configured — nothing was called', async () => {
      delete process.env.OPENAI_API_KEY;
      global.fetch = jest.fn();
      const { call } = load();
      expect(await call.callOpenAI({ model: 'm', text: 't' })).toEqual({ ok: false, reason: 'no_key' });
      await flush();
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });

  describe('callGemini', () => {
    it('records usageMetadata, modelVersion and empty_json with usage', async () => {
      global.fetch = fetchJson(GEMINI_BODY);
      const { call } = load();
      expect(await call.callGemini({ model: 'g', text: 't' })).toEqual({ ok: true, text: '{"g":true}', json: { g: true }, model: 'g' });
      global.fetch = fetchJson({ ...GEMINI_BODY, candidates: [{ content: { parts: [{ text: 'not json' }] } }] });
      expect(await call.callGemini({ model: 'g', text: 't' })).toEqual({ ok: false, reason: 'empty_json' });
      await flush();
      const rows = callRows();
      expect(rows[0]).toMatchObject({ ok: true, provider: 'gemini', served_model: 'gemini-served', input_tokens: 50, cached_input_tokens: 10, output_tokens: 20, reasoning_tokens: 5 });
      expect(rows[1]).toMatchObject({ ok: false, error_code: 'empty_json', error_class: 'incomplete', input_tokens: 50 });
    });
  });

  describe('callGemini', () => {
    it('a MAX_TOKENS finish is a FAILED leg in both modes — gemini_incomplete recorded (with usage) AND returned, like the other providers', async () => {
      const { call } = load();
      global.fetch = fetchJson({ ...GEMINI_BODY, candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"g":' }] } }] });
      expect(await call.callGemini({ model: 'g', text: 't' })).toEqual({ ok: false, reason: 'gemini_incomplete' });
      global.fetch = fetchJson({ ...GEMINI_BODY, candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'The first half of' }] } }] });
      expect(await call.callGemini({ model: 'g', text: 't', jsonMode: false })).toEqual({ ok: false, reason: 'gemini_incomplete' });
      await flush();
      expect(callRows().map((r) => [r.ok, r.error_code, r.error_class, r.input_tokens])).toEqual([[false, 'gemini_incomplete', 'incomplete', 50], [false, 'gemini_incomplete', 'incomplete', 50]]);
    });
  });

  describe('empty text-mode answers', () => {
    it('every adapter fails an empty text-mode answer as empty_text (→ incomplete) — recorded AND returned, bare dispatch included', async () => {
      const { call } = load();
      global.fetch = fetchJson({ ...OPENAI_BODY, output_text: '   ' });
      expect(await call.callOpenAI({ model: 'o', text: 't', jsonMode: false })).toEqual({ ok: false, reason: 'empty_text' });
      global.fetch = fetchJson({ ...GEMINI_BODY, candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '' }] } }] });
      expect(await call.callGemini({ model: 'g', text: 't', jsonMode: false })).toEqual({ ok: false, reason: 'empty_text' });
      mockAnthropicCreate.mockResolvedValue({ ...ANTHROPIC_MESSAGE, content: [{ type: 'text', text: ' ' }] });
      expect(await call.callAnthropic({ model: 'a', text: 't', jsonMode: false })).toEqual({ ok: false, reason: 'empty_text' });
      await flush();
      expect(callRows().map((r) => [r.provider, r.ok, r.error_code, r.error_class])).toEqual([
        ['openai', false, 'empty_text', 'incomplete'], ['gemini', false, 'empty_text', 'incomplete'], ['anthropic', false, 'empty_text', 'incomplete'],
      ]);
      expect(mockUpdate).not.toHaveBeenCalled();
      // JSON mode is untouched: an empty body there is still empty_json.
      global.fetch = fetchJson({ ...OPENAI_BODY, output_text: '   ' });
      expect(await call.callOpenAI({ model: 'o', text: 't' })).toEqual({ ok: false, reason: 'empty_json' });
    });
  });

  describe('callGemini — blocked answers', () => {
    it('a SAFETY finish and a prompt-level block are gemini_refusal (→ instruction) in both modes; another non-STOP finish is its own code', async () => {
      const { call } = load();
      global.fetch = fetchJson({ ...GEMINI_BODY, candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] });
      expect(await call.callGemini({ model: 'g', text: 't', jsonMode: false })).toEqual({ ok: false, reason: 'gemini_refusal' });
      global.fetch = fetchJson({ modelVersion: 'gemini-served', candidates: [], promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: GEMINI_BODY.usageMetadata });
      expect(await call.callGemini({ model: 'g', text: 't' })).toEqual({ ok: false, reason: 'gemini_refusal' });
      global.fetch = fetchJson({ ...GEMINI_BODY, candidates: [{ finishReason: 'OTHER', content: { parts: [{ text: 'x' }] } }] });
      expect(await call.callGemini({ model: 'g', text: 't', jsonMode: false })).toEqual({ ok: false, reason: 'gemini_finish_other' });
      await flush();
      expect(callRows().map((r) => [r.ok, r.error_code, r.error_class])).toEqual([[false, 'gemini_refusal', 'instruction'], [false, 'gemini_refusal', 'instruction'], [false, 'gemini_finish_other', 'infrastructure']]);
    });
  });

  describe('callAnthropic', () => {
    it('records the SDK usage block incl. cache read/write and the message id', async () => {
      mockAnthropicCreate.mockResolvedValue(ANTHROPIC_MESSAGE);
      const { call } = load();
      const result = await call.callAnthropic({ model: 'a', system: 's', text: 't' });
      expect(result).toMatchObject({ ok: true, json: { c: 2 }, model: 'a', response: ANTHROPIC_MESSAGE });
      await flush();
      expect(callRows()[0]).toMatchObject({
        ok: true, provider: 'anthropic', requested_model: 'a', served_model: 'anthropic-served', provider_ref: 'msg_1',
        input_tokens: 200, cached_input_tokens: 150, cache_write_tokens: 25, output_tokens: 40,
      });
    });

    it('records SDK errors with the provider status code', async () => {
      mockAnthropicCreate.mockRejectedValue(Object.assign(new Error('overloaded'), { status: 529 }));
      const { call } = load();
      expect(await call.callAnthropic({ model: 'a', text: 't' })).toEqual({ ok: false, reason: 'anthropic_529' });
      await flush();
      expect(callRows()[0]).toMatchObject({ ok: false, error_code: 'anthropic_529', error_class: 'provider' });
    });

    it('a refusal is a FAILED leg in both modes — anthropic_refusal recorded AND returned, partial text never handed back as ok', async () => {
      mockAnthropicCreate.mockResolvedValue({ ...ANTHROPIC_MESSAGE, stop_reason: 'refusal', content: [] });
      const { call } = load();
      expect(await call.callAnthropic({ model: 'a', text: 't' })).toEqual({ ok: false, reason: 'anthropic_refusal' });
      mockAnthropicCreate.mockResolvedValue({ ...ANTHROPIC_MESSAGE, stop_reason: 'refusal', content: [{ type: 'text', text: 'I can start by' }] });
      expect(await call.callAnthropic({ model: 'a', text: 't', jsonMode: false })).toEqual({ ok: false, reason: 'anthropic_refusal' });
      await flush();
      expect(callRows().map((r) => [r.ok, r.error_code, r.error_class, r.input_tokens])).toEqual([[false, 'anthropic_refusal', 'instruction', 200], [false, 'anthropic_refusal', 'instruction', 200]]);
    });

    it('a max_tokens stop is a FAILED leg in both modes — anthropic_incomplete recorded AND returned, like openai_incomplete', async () => {
      const { call } = load();
      mockAnthropicCreate.mockResolvedValue({ ...ANTHROPIC_MESSAGE, stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"c":' }] });
      expect(await call.callAnthropic({ model: 'a', text: 't' })).toEqual({ ok: false, reason: 'anthropic_incomplete' });
      mockAnthropicCreate.mockResolvedValue({ ...ANTHROPIC_MESSAGE, stop_reason: 'max_tokens', content: [{ type: 'text', text: 'The first half of' }] });
      expect(await call.callAnthropic({ model: 'a', text: 't', jsonMode: false })).toEqual({ ok: false, reason: 'anthropic_incomplete' });
      await flush();
      expect(callRows().map((r) => [r.ok, r.error_code, r.error_class, r.input_tokens])).toEqual([[false, 'anthropic_incomplete', 'incomplete', 200], [false, 'anthropic_incomplete', 'incomplete', 200]]);
    });

    it('files a statusless SDK timeout as anthropic_timeout / timeout', async () => {
      mockAnthropicCreate.mockRejectedValue(Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }));
      const { call } = load();
      expect(await call.callAnthropic({ model: 'a', text: 't', timeoutMs: 50 })).toEqual({ ok: false, reason: 'anthropic_timeout' });
      await flush();
      expect(callRows()[0]).toMatchObject({ ok: false, error_code: 'anthropic_timeout', error_class: 'timeout' });
    });
  });

  describe('ledgerCall', () => {
    it('returns the resolved value unchanged and records from it', async () => {
      const { metrics } = load();
      const value = await metrics.ledgerCall('anthropic', 'req-model', () => Promise.resolve(ANTHROPIC_MESSAGE));
      expect(value).toBe(ANTHROPIC_MESSAGE);
      await flush();
      expect(callRows()[0]).toMatchObject({ ok: true, requested_model: 'req-model', served_model: 'anthropic-served', provider_ref: 'msg_1', input_tokens: 200, policy: 'anthropic/req-model' });
    });

    it('rethrows the original error unchanged and records the failure with the provider status', async () => {
      const { metrics } = load();
      const boom = Object.assign(new Error('rate limited 429'), { status: 429 });
      await expect(metrics.ledgerCall('anthropic', 'm', () => Promise.reject(boom))).rejects.toBe(boom);
      await flush();
      expect(callRows()[0]).toMatchObject({ ok: false, error_code: 'anthropic_429', error_class: 'provider' });
    });

    it('files an SDK timeout as anthropic_timeout / timeout', async () => {
      const { metrics } = load();
      const timedOut = Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });
      await expect(metrics.ledgerCall('anthropic', 'm', () => Promise.reject(timedOut))).rejects.toBe(timedOut);
      await flush();
      expect(callRows()[0]).toMatchObject({ ok: false, error_code: 'anthropic_timeout', error_class: 'timeout' });
    });

    it('records an Anthropic refusal as a FAILED call (anthropic_refusal / instruction) with its usage, value unchanged', async () => {
      const { metrics } = load();
      const refusal = { ...ANTHROPIC_MESSAGE, stop_reason: 'refusal', content: [] };
      expect(await metrics.ledgerCall('anthropic', 'm', () => Promise.resolve(refusal))).toBe(refusal);
      await flush();
      expect(callRows()[0]).toMatchObject({ ok: false, error_code: 'anthropic_refusal', error_class: 'instruction', input_tokens: 200, output_tokens: 40 });
    });

    it('records an Anthropic max_tokens stop as an incomplete call (anthropic_incomplete / incomplete) with its usage, value unchanged', async () => {
      const { metrics } = load();
      const cut = { ...ANTHROPIC_MESSAGE, stop_reason: 'max_tokens' };
      expect(await metrics.ledgerCall('anthropic', 'm', () => Promise.resolve(cut))).toBe(cut);
      await flush();
      expect(callRows()[0]).toMatchObject({ ok: false, error_code: 'anthropic_incomplete', error_class: 'incomplete', input_tokens: 200, output_tokens: 40 });
    });

    it('DEEP helper: a refusal is a failed Anthropic leg and the OpenAI backup a successful one, same chain', async () => {
      const { deep } = load();
      const client = { messages: { create: jest.fn().mockResolvedValue({ ...ANTHROPIC_MESSAGE, stop_reason: 'refusal', stop_details: { category: 'x' }, content: [] }) } };
      global.fetch = fetchJson({ ...OPENAI_BODY, output_text: 'backup answer' });
      const message = await deep.createDeepMessage(client, { model: 'deep-model', max_tokens: 4096, messages: [{ role: 'user', content: 'q' }] });
      expect(message.content[0].text).toBe('backup answer');
      await flush();
      const rows = callRows();
      expect(rows.map((r) => [r.provider, r.ok, r.error_code])).toEqual([['anthropic', false, 'anthropic_refusal'], ['openai', true, null]]);
      expect(rows[1].chain_id).toBe(rows[0].chain_id);
    });

    it('DEEP helper: the Anthropic leg and the OpenAI backup share one chain id, each recorded as its own call', async () => {
      const { deep } = load();
      const client = { messages: { create: jest.fn().mockRejectedValue(Object.assign(new Error('overloaded'), { status: 529 })) } };
      global.fetch = fetchJson({ ...OPENAI_BODY, output_text: 'plain prose answer' });
      const message = await deep.createDeepMessage(client, { model: 'deep-model', max_tokens: 4096, messages: [{ role: 'user', content: 'q' }] });
      expect(message).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'plain prose answer' }], usage: expect.objectContaining({ input_tokens: 120, output_tokens: 30 }) });
      await flush();
      const rows = callRows();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ provider: 'anthropic', requested_model: 'deep-model', ok: false, error_code: 'anthropic_529' });
      expect(rows[1]).toMatchObject({ provider: 'openai', ok: true, input_tokens: 120 });
      expect(rows[0].chain_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(rows[1].chain_id).toBe(rows[0].chain_id);
    });
  });

  describe('recordCall', () => {
    it('is a no-op with no DB touch while the gate is off', async () => {
      delete process.env.GATE_LLM_CALL_LEDGER;
      const { metrics } = load();
      await expect(metrics.recordCall({ provider: 'openai', requestedModel: 'm', ok: true })).resolves.toBeNull();
      expect(mockDb).not.toHaveBeenCalled();
    });

    it('never throws on a DB error and resolves null', async () => {
      // the service awaits .returning(), so only that leg rejects (a bare
      // rejected builder would be an unhandled rejection attributed to a later test)
      mockInsert.mockImplementation(() => { const p = Promise.resolve([]); p.returning = () => Promise.reject(new Error('db down')); return p; });
      const { metrics } = load();
      await expect(metrics.recordCall({ provider: 'openai', requestedModel: 'm', ok: true })).resolves.toBeNull();
    });

    it('resolves the inserted id and prefers an explicit laneId over the ambient lane', async () => {
      const { metrics, context } = load();
      const id = await context.runInLane('report_copy', () => metrics.recordCall({ provider: 'openai', requestedModel: 'm', ok: true, laneId: 'sms_draft' }));
      expect(typeof id).toBe('number');
      expect(callRows()[0]).toMatchObject({ lane_id: 'sms_draft', policy: 'sms_draft' });
      await context.runInLane('report_copy', () => metrics.recordCall({ provider: 'openai', requestedModel: 'm', ok: true }));
      expect(callRows()[1]).toMatchObject({ lane_id: 'report_copy', policy: 'report_copy' });
    });

    it('stamps run / step correlation ids and the prompt version from context', async () => {
      const { metrics, context } = load();
      const runId = '11111111-1111-4111-8111-111111111111';
      await context.runInRun({ runId, workItemId: '22222222-2222-4222-8222-222222222222' }, () => context.withStep('33333333-3333-4333-8333-333333333333', () => (
        context.withPromptVersion('v7', () => metrics.recordCall({ provider: 'openai', requestedModel: 'm', ok: true }))
      )));
      const [row] = callRows();
      expect(row).toMatchObject({ run_id: runId, work_item_id: '22222222-2222-4222-8222-222222222222', step_id: '33333333-3333-4333-8333-333333333333', prompt_version: 'v7' });
      expect(row.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(row.span_id).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  describe('dispatchWithFallback', () => {
    it('shares one chain id between the chain row and its call rows, labelled by the policy name', async () => {
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      global.fetch = fetchJson({ ...OPENAI_BODY, status: 'incomplete' }); // primary leg fails, billed
      mockAnthropicCreate.mockResolvedValue(ANTHROPIC_MESSAGE);
      const { call } = load();
      const policy = { name: 'ledgerTest', primary: { provider: 'openai', model: 'o' }, fallback: { provider: 'anthropic', model: 'a' } };
      const out = await call.dispatchWithFallback(policy, { text: 't', laneId: 'report_copy', promptVersion: 'p1' });
      expect(out).toMatchObject({ ok: true, provider: 'anthropic', fallbackUsed: true });
      await flush();
      const rows = ledgerRows();
      const chain = rows.find((r) => r.row_kind === 'chain');
      const calls = rows.filter((r) => r.row_kind === 'call');
      expect(calls).toHaveLength(2);
      expect(chain).toMatchObject({ policy: 'ledgerTest', ok: true, fallback_used: true, lane_id: 'report_copy', error_class: null });
      expect(chain.chain_id).toMatch(/^[0-9a-f-]{36}$/);
      for (const c of calls) {
        expect(c.chain_id).toBe(chain.chain_id);
        expect(c).toMatchObject({ policy: 'ledgerTest', lane_id: 'report_copy', prompt_version: 'p1' });
      }
      expect(calls.map((c) => c.ok)).toEqual([false, true]);
    });

    it('keeps validator provenance: a validate-hook rejection classifies as instruction / incomplete, and the failure entry says so', async () => {
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      global.fetch = fetchJson(OPENAI_BODY);
      mockAnthropicCreate.mockResolvedValue(ANTHROPIC_MESSAGE);
      const { call } = load();
      const policy = { name: 'ledgerValidate', primary: { provider: 'openai', model: 'o' }, fallback: { provider: 'anthropic', model: 'a' } };
      const out = await call.dispatchWithFallback(policy, { text: 't' }, { validate: () => 'trade_name' });
      expect(out).toMatchObject({ ok: false, reason: 'all_providers_failed' });
      expect(out.failures).toEqual([expect.objectContaining({ reason: 'trade_name', validator: true }), expect.objectContaining({ reason: 'trade_name', validator: true })]);
      await flush();
      const chain = ledgerRows().find((r) => r.row_kind === 'chain');
      expect(chain).toMatchObject({ ok: false, error_class: 'instruction' });
      expect(JSON.parse(chain.failure_reasons)[0]).toMatchObject({ reason: 'trade_name', validator: true });
      mockInsert.mockClear();
      await call.dispatchWithFallback(policy, { text: 't' }, { validate: () => 'missing_summary' });
      await flush();
      expect(ledgerRows().find((r) => r.row_kind === 'chain')).toMatchObject({ ok: false, error_class: 'incomplete' });
    });

    it('a chain rejection (validate hook) flips the adapter\'s ok call row to that code, so both ledgers agree the leg failed', async () => {
      mockUpdate.mockClear();
      global.fetch = fetchJson(OPENAI_BODY);
      mockAnthropicCreate.mockResolvedValue(ANTHROPIC_MESSAGE);
      const { call } = load();
      const policy = { name: 'ledgerReject', primary: { provider: 'openai', model: 'o' }, fallback: { provider: 'anthropic', model: 'a' } };
      await call.dispatchWithFallback(policy, { text: 't' }, { validate: () => 'trade_name' });
      await flush();
      // the adapters' own rows still say ok (the answer arrived whole) …
      expect(callRows().map((r) => r.ok)).toEqual([true, true]);
      // … and the chain's rejection flipped each of them by id.
      expect(mockUpdate.mock.calls.map(([t, cond, patch]) => [t, cond.id > 0, patch])).toEqual([
        ['llm_dispatch_log', true, { ok: false, error_code: 'trade_name', error_class: 'instruction' }],
        ['llm_dispatch_log', true, { ok: false, error_code: 'trade_name', error_class: 'instruction' }],
      ]);
      // off-gate: the adapter never recorded a row, so there is nothing to flip.
      mockUpdate.mockClear();
      delete process.env.GATE_LLM_CALL_LEDGER;
      const { call: dark } = load();
      global.fetch = fetchJson(OPENAI_BODY);
      await dark.dispatchWithFallback(policy, { text: 't' }, { validate: () => 'trade_name' });
      await flush();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('classifies a failed chain by its first failure reason', async () => {
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      global.fetch = fetchJson({}, { ok: false, status: 503 });
      mockAnthropicCreate.mockRejectedValue(Object.assign(new Error('down'), { status: 500 }));
      const { call } = load();
      const policy = { name: 'ledgerFail', primary: { provider: 'openai', model: 'o' }, fallback: { provider: 'anthropic', model: 'a' } };
      expect(await call.dispatchWithFallback(policy, { text: 't' })).toMatchObject({ ok: false, reason: 'all_providers_failed' });
      await flush();
      const chain = ledgerRows().find((r) => r.row_kind === 'chain');
      expect(chain).toMatchObject({ ok: false, error_class: 'provider', lane_id: null });
    });

    it('inside runAsReplay every row of the chain carries the `:replay` policy — the call rows agree with the chain row', async () => {
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      global.fetch = fetchJson(OPENAI_BODY);
      const { call, metrics } = load();
      const policy = { name: 'ledgerReplay', primary: { provider: 'openai', model: 'o' }, fallback: { provider: 'anthropic', model: 'a' } };
      expect(await metrics.runAsReplay(() => call.dispatchWithFallback(policy, { text: 't' }))).toMatchObject({ ok: true, provider: 'openai' });
      await flush();
      const rows = ledgerRows();
      expect(rows.find((r) => r.row_kind === 'chain')).toMatchObject({ policy: 'ledgerReplay:replay', workload: 'replay' });
      expect(rows.filter((r) => r.row_kind === 'call').map((r) => [r.policy, r.workload])).toEqual([['ledgerReplay:replay', 'replay']]);
    });

    it('a refused primary fails its leg over — the call row, the chain row and the caller all say anthropic_refusal', async () => {
      process.env.GATE_LLM_DISPATCH_METRICS = 'true';
      global.fetch = fetchJson(OPENAI_BODY);
      // text mode, partial text before the refusal: the case that used to come back ok
      mockAnthropicCreate.mockResolvedValue({ ...ANTHROPIC_MESSAGE, stop_reason: 'refusal', content: [{ type: 'text', text: 'I can start by' }] });
      const { call } = load();
      const policy = { name: 'ledgerRefusal', primary: { provider: 'anthropic', model: 'a' }, fallback: { provider: 'openai', model: 'o' } };
      expect(await call.dispatchWithFallback(policy, { text: 't', jsonMode: false })).toMatchObject({ ok: true, provider: 'openai', fallbackUsed: true });
      await flush();
      let rows = ledgerRows();
      expect(rows.filter((r) => r.row_kind === 'call').map((r) => [r.provider, r.ok, r.error_code, r.error_class])).toEqual([['anthropic', false, 'anthropic_refusal', 'instruction'], ['openai', true, null, null]]);
      expect(rows.find((r) => r.row_kind === 'chain')).toMatchObject({ ok: true, fallback_used: true, error_class: null });
      // and when the backup misses too, the chain is classified by the refusal
      mockInsert.mockClear();
      global.fetch = fetchJson({ ...OPENAI_BODY, status: 'incomplete' });
      expect(await call.dispatchWithFallback(policy, { text: 't' })).toMatchObject({ ok: false, reason: 'all_providers_failed' });
      await flush();
      rows = ledgerRows();
      expect(rows.filter((r) => r.row_kind === 'call').map((r) => r.error_code)).toEqual(['anthropic_refusal', 'openai_incomplete']);
      expect(rows.find((r) => r.row_kind === 'chain')).toMatchObject({ ok: false, error_class: 'instruction' });
    });
  });

  describe('recordSessionUsage', () => {
    it('writes one session row from the session usage block and never throws', async () => {
      global.fetch = fetchJson({ id: 'sess_1', status: 'idle', model: 'served-agent-model', usage: { input_tokens: 5000, output_tokens: 700, cache_read_input_tokens: 4000 } });
      const { metrics } = load();
      const id = await metrics.recordSessionUsage({ laneId: 'agent_bi', sessionId: 'sess_1', agentId: 'agent_x', model: 'req-model', startedAt: Date.now() - 1500 });
      expect(typeof id).toBe('number');
      expect(global.fetch.mock.calls[0][0]).toMatch(/\/v1\/sessions\/sess_1$/);
      const [row] = ledgerRows();
      expect(row).toMatchObject({
        row_kind: 'session', ok: true, provider: 'anthropic', lane_id: 'agent_bi', policy: 'agent_bi', provider_ref: 'sess_1',
        requested_model: 'req-model', served_model: 'served-agent-model', input_tokens: 5000, output_tokens: 700, cached_input_tokens: 4000,
      });
      expect(row.latency_ms).toBeGreaterThanOrEqual(1500);
    });

    it("latency_ms is the runner's own elapsed time — a slow usage GET is never billed as agent latency", async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_800);
      // the usage GET "takes" 15 s: the clock jumps while it is in flight
      global.fetch = jest.fn(async () => {
        now.mockReturnValue(1_015_800);
        return { ok: true, status: 200, json: () => Promise.resolve({ id: 's', status: 'idle', usage: { input_tokens: 1, output_tokens: 1 } }) };
      });
      const { metrics } = load();
      try {
        await metrics.recordSessionUsage({ laneId: 'agent_assistant', sessionId: 's', startedAt: 1_000_000 });
      } finally {
        now.mockRestore();
      }
      expect(ledgerRows()[0]).toMatchObject({ provider_ref: 's', latency_ms: 800 });
    });

    it('marks a terminated session as failed', async () => {
      global.fetch = fetchJson({ id: 's', status: 'terminated', usage: { input_tokens: 1, output_tokens: 1 } });
      const { metrics } = load();
      await metrics.recordSessionUsage({ laneId: 'agent_lead', sessionId: 's' });
      expect(ledgerRows()[0]).toMatchObject({ ok: false, error_code: 'session_terminated', error_class: 'infrastructure' });
    });

    it("a terminated session behind a runner failure keeps the runner's own code (its class), not session_terminated", async () => {
      global.fetch = fetchJson({ id: 's', status: 'terminated', usage: { input_tokens: 1, output_tokens: 1 } });
      const { metrics } = load();
      await metrics.recordSessionUsage({ laneId: 'agent_lead', sessionId: 's', failure: 'session_error_event' });
      expect(ledgerRows()[0]).toMatchObject({ ok: false, error_code: 'session_error_event', error_class: 'provider' });
    });

    it("combines the runner's own outcome with the remote status — an idle session behind a failed run is a failed row", async () => {
      global.fetch = fetchJson({ id: 's', status: 'idle', usage: { input_tokens: 10, output_tokens: 2 } });
      const { metrics } = load();
      await metrics.recordSessionUsage({ laneId: 'agent_bi', sessionId: 's', failure: new Error('socket hang up') });
      await metrics.recordSessionUsage({ laneId: 'agent_content', sessionId: 's', failure: 'missing_draft' });
      await metrics.recordSessionUsage({ laneId: 'agent_backlink', sessionId: 's', failure: 'session_error_event' });
      // a provider response the runner's helper threw keeps its status (the helpers attach `code`)
      await metrics.recordSessionUsage({ laneId: 'agent_content', sessionId: 's', failure: Object.assign(new Error('Anthropic API 429: slow down'), { status: 429, code: 'anthropic_429' }) });
      await metrics.recordSessionUsage({ laneId: 'agent_lead', sessionId: 's', failure: null });
      expect(ledgerRows().map((r) => [r.ok, r.error_code, r.error_class, r.input_tokens])).toEqual([
        [false, 'runner_error', 'infrastructure', 10],
        [false, 'missing_draft', 'incomplete', 10],
        [false, 'session_error_event', 'provider', 10],
        [false, 'anthropic_429', 'provider', 10],
        [true, null, null, 10],
      ]);
    });

    it('still writes the session (null token counts) when the usage GET fails, so a billed session never vanishes', async () => {
      global.fetch = jest.fn(() => Promise.reject(new Error('network')));
      const { metrics } = load();
      await expect(metrics.recordSessionUsage({ laneId: 'agent_lead', sessionId: 's2', model: 'req-m', startedAt: Date.now() - 10 })).resolves.toEqual(expect.any(Number));
      expect(ledgerRows()[0]).toMatchObject({ row_kind: 'session', provider_ref: 's2', ok: true, error_code: null, input_tokens: null, output_tokens: null, requested_model: 'req-m', served_model: null });
      global.fetch = jest.fn(() => Promise.reject(new Error('network')));
      await metrics.recordSessionUsage({ laneId: 'agent_lead', sessionId: 's3', failure: 'streaming_failed' });
      expect(ledgerRows()[1]).toMatchObject({ provider_ref: 's3', ok: false, error_code: 'streaming_failed', input_tokens: null });
    });

    it('writes ONE atomic upsert keyed by session id whose every merged column is monotone (no writer ordering assumed)', async () => {
      global.fetch = fetchJson({ id: 'sess_2', status: 'idle', usage: { input_tokens: 250, output_tokens: 40 } });
      const { metrics } = load();
      await expect(metrics.recordSessionUsage({ laneId: 'agent_assistant', sessionId: 'sess_2' })).resolves.toEqual(expect.any(Number));
      expect(mergesFor('session')).toHaveLength(1);
      const [table, target, updates] = mergesFor('session')[0];
      expect(table).toBe('llm_dispatch_log');
      expect(String(target)).toBe("(provider_ref) WHERE row_kind = 'session'");
      // counters and latency only grow
      for (const col of ['input_tokens', 'cached_input_tokens', 'cache_write_tokens', 'output_tokens', 'reasoning_tokens', 'latency_ms']) {
        expect(String(updates[col])).toBe(`GREATEST(EXCLUDED.${col}, llm_dispatch_log.${col})`);
      }
      // a terminal status is sticky: ok only ever goes false, the first error and served model stay
      expect(String(updates.ok)).toBe('(llm_dispatch_log.ok AND EXCLUDED.ok)');
      for (const col of ['error_code', 'error_class', 'served_model']) expect(String(updates[col])).toBe(`COALESCE(llm_dispatch_log.${col}, EXCLUDED.${col})`);
      // the session's start is its earliest recorded turn start (LEAST skips a null side)
      expect(String(updates.started_at)).toBe('LEAST(llm_dispatch_log.started_at, EXCLUDED.started_at)');
      // the first write's identity and context stay: nothing else is merged
      expect(Object.keys(updates).sort()).toEqual(['cache_write_tokens', 'cached_input_tokens', 'error_class', 'error_code', 'input_tokens', 'latency_ms', 'ok', 'output_tokens', 'reasoning_tokens', 'served_model', 'started_at']);
    });

    it('writes one session_turn row per turn, keyed by (session, turn start), with that turn\'s delta of the counters — every re-record of the same turn upserts the SAME row monotonically', async () => {
      const { metrics } = load();
      const turnA = Date.now() - 500;
      // first record of the session: no session row yet → the delta is the whole snapshot
      sessionPrev = null;
      global.fetch = fetchJson({ id: 'sess_9', status: 'idle', usage: { input_tokens: 250, output_tokens: 40 } });
      await metrics.recordSessionUsage({ laneId: 'agent_assistant', sessionId: 'sess_9', startedAt: turnA });
      expect(turnRows()).toHaveLength(1);
      expect(turnRows()[0]).toMatchObject({ row_kind: 'session_turn', lane_id: 'agent_assistant', provider_ref: 'sess_9', ok: true, input_tokens: 250, output_tokens: 40, cached_input_tokens: null });
      expect(turnRows()[0].step_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(turnRows()[0].latency_ms).toBeGreaterThanOrEqual(500);
      // the runner's captured start is persisted on both rows: created_at is the recording time,
      // after the usage GET, so a start derived from it would drift by the fetch (Codex r12 on #3891)
      expect(turnRows()[0].started_at).toEqual(new Date(turnA));
      expect(ledgerRows().at(-1)).toMatchObject({ row_kind: 'session', started_at: new Date(turnA) });
      // the same turn re-recorded (a runner's finally, a retry) carries the SAME key → the unique
      // partial index on step_id makes it an upsert, merged like the session row (monotone)
      await metrics.recordSessionUsage({ laneId: 'agent_assistant', sessionId: 'sess_9', startedAt: turnA, failure: 'streaming_failed' });
      expect(turnRows()[1].step_id).toBe(turnRows()[0].step_id);
      expect(turnRows()[1]).toMatchObject({ ok: false, error_code: 'streaming_failed' });
      expect(mergesFor('session_turn')).toHaveLength(2);
      const [, target, updates] = mergesFor('session_turn')[1];
      expect(String(target)).toBe("(step_id) WHERE row_kind = 'session_turn'");
      // turn counters are deltas since the last record → they ADD (null only while all unknown); latency still GREATEST
      expect(String(updates.input_tokens)).toBe('CASE WHEN llm_dispatch_log.input_tokens IS NULL AND EXCLUDED.input_tokens IS NULL THEN NULL ELSE COALESCE(llm_dispatch_log.input_tokens, 0) + COALESCE(EXCLUDED.input_tokens, 0) END');
      expect(String(updates.latency_ms)).toBe('GREATEST(EXCLUDED.latency_ms, llm_dispatch_log.latency_ms)');
      expect(String(updates.ok)).toBe('(llm_dispatch_log.ok AND EXCLUDED.ok)');
      expect(String(updates.error_code)).toBe('COALESCE(llm_dispatch_log.error_code, EXCLUDED.error_code)');
      // the next turn: the cumulative snapshot grew by 100 / 5 → only that lands on its own row
      sessionPrev = { input_tokens: 250, cached_input_tokens: null, cache_write_tokens: null, output_tokens: 40, reasoning_tokens: null };
      global.fetch = fetchJson({ id: 'sess_9', status: 'idle', usage: { input_tokens: 350, output_tokens: 45 } });
      await metrics.recordSessionUsage({ laneId: 'agent_assistant', sessionId: 'sess_9', startedAt: turnA + 1000 });
      expect(turnRows()[2].step_id).not.toBe(turnRows()[0].step_id);
      expect(turnRows()[2]).toMatchObject({ input_tokens: 100, output_tokens: 5, ok: true });
      // a delayed lower snapshot never goes negative; a failed usage GET keeps null counters (the
      // row still exists under its key; the recovered snapshot fills it through GREATEST)
      sessionPrev = { input_tokens: 400, cached_input_tokens: null, cache_write_tokens: null, output_tokens: 50, reasoning_tokens: null };
      await metrics.recordSessionUsage({ laneId: 'agent_assistant', sessionId: 'sess_9', startedAt: turnA + 2000 });
      expect(turnRows()[3]).toMatchObject({ input_tokens: 0, output_tokens: 0 });
      global.fetch = jest.fn(() => Promise.reject(new Error('network')));
      await metrics.recordSessionUsage({ laneId: 'agent_assistant', sessionId: 'sess_9', startedAt: turnA + 3000 });
      expect(turnRows()[4]).toMatchObject({ input_tokens: null, output_tokens: null });
      // an explicit turnId wins over the start time (two turns in one millisecond stay two rows)
      await metrics.recordSessionUsage({ laneId: 'agent_assistant', sessionId: 'sess_9', startedAt: turnA, turnId: 't-1' });
      await metrics.recordSessionUsage({ laneId: 'agent_assistant', sessionId: 'sess_9', startedAt: turnA, turnId: 't-2' });
      expect(turnRows()).toHaveLength(7);
      expect(new Set([turnRows()[0].step_id, turnRows()[5].step_id, turnRows()[6].step_id]).size).toBe(3);
      // no turn start and no turn id → no turn row, the session row alone, with no start to persist
      await metrics.recordSessionUsage({ laneId: 'agent_assistant', sessionId: 'sess_9' });
      expect(turnRows()).toHaveLength(7);
      expect(ledgerRows().at(-1)).toMatchObject({ row_kind: 'session', started_at: null });
      expect(mergesFor('session')).toHaveLength(8);
      sessionPrev = null;
    });

    it('is a no-op while the gate is off', async () => {
      delete process.env.GATE_LLM_CALL_LEDGER;
      global.fetch = jest.fn();
      const { metrics } = load();
      await expect(metrics.recordSessionUsage({ laneId: 'agent_bi', sessionId: 's' })).resolves.toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockDb).not.toHaveBeenCalled();
    });
  });
});
