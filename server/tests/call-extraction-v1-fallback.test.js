// GATE_CALL_EXTRACTION_V1_FALLBACK: the V1 extractor (extractCallData) ran on
// Gemini alone. 2026-10-21: Gemini answered HTTP 402 "prepayment credits are
// depleted" and 19 of 19 recorded calls failed three attempts. Gate on, a
// PROVIDER failure of the Gemini leg retries the same prompt on Claude, then
// OpenAI, through the real dispatcher (llm/call.js); the answer takes the same
// normalizeCallExtraction tail. No real API call: global.fetch and the
// Anthropic SDK are mocked. Synthetic data only.

const mockAnthropicCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockAnthropicCreate } })));
jest.mock('../services/llm-dispatch-metrics', () => ({
  recordCall: jest.fn(() => null),
  failCall: jest.fn(),
  recordDispatch: jest.fn(),
  recordedPolicyLabel: jest.fn((policy) => policy?.name || null),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const logger = require('../services/logger');
const { _test } = require('../services/call-recording-processor');
const MODELS = require('../config/models');
const { EXTRACTION_INVALID_JSON_SUMMARY } = require('../utils/extraction-compat');

const { extractCallData, CALL_EXTRACTION_V1_BACKUP_ROUTE } = _test;

const TRANSCRIPT = 'Agent: Waves Pest Control, how can I help?\nCaller: This is Pat Example, I have ants at 12 Example Way, Bradenton.';
const PHONE = '+19415550123';
const GOOD = {
  first_name: 'Pat',
  last_name: 'Example',
  call_type: 'new_inquiry',
  is_lead: true,
  appointment_confirmed: false,
  call_summary: 'Caller reported ants.',
  lead_quality: 'warm',
  is_spam: false,
  is_voicemail: false,
};

const geminiOk = (obj) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }) });
const geminiText = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });
const geminiHttp = (status, body = '{"error":"x"}') => ({ ok: false, status, text: async () => body });
const openaiOk = (obj) => ({ ok: true, status: 200, json: async () => ({ id: 'resp_1', model: 'gpt-test', status: 'completed', output_text: JSON.stringify(obj) }) });
const claudeOk = (obj) => ({ id: 'msg_1', model: 'claude-test', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }], usage: { input_tokens: 1, output_tokens: 1 } });

let fetchMock;
const savedEnv = { ...process.env };

function installFetch(handlers) {
  fetchMock = jest.fn(async (url) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) return handlers.gemini();
    if (u.includes('api.openai.com')) return handlers.openai ? handlers.openai() : { ok: false, status: 500 };
    throw new Error(`unexpected fetch ${u}`);
  });
  global.fetch = fetchMock;
}
const geminiCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes('generativelanguage'));
const openaiCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes('api.openai.com'));

beforeEach(() => {
  jest.clearAllMocks();
  mockAnthropicCreate.mockReset();
  process.env.GEMINI_API_KEY = 'test-gemini';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic';
  process.env.OPENAI_API_KEY = 'test-openai';
  delete process.env.GATE_CALL_EXTRACTION_V1_FALLBACK;
});
afterAll(() => {
  process.env = savedEnv;
});

describe('backup route', () => {
  test('Claude first, then OpenAI, both pinned (the same models V2 uses)', () => {
    expect(CALL_EXTRACTION_V1_BACKUP_ROUTE.primary).toEqual({ provider: 'anthropic', model: MODELS.CALL_EXTRACTION_ANTHROPIC });
    // V2's per-provider pin, whichever provider CALL_EXTRACTION_PROVIDER makes V2's primary.
    expect(CALL_EXTRACTION_V1_BACKUP_ROUTE.fallback).toEqual({ provider: 'openai', model: _test.CALL_EXTRACTION_MODEL_FOR.openai });
    expect(Object.isFrozen(CALL_EXTRACTION_V1_BACKUP_ROUTE)).toBe(true);
  });

  test('the lane policy counts the backup legs on the call ledger (their rows carry its cost)', () => {
    const { policyFor } = require('../services/agent-control/lane-policies');
    expect(policyFor('call_extraction_v1').ledger).toBe('call');
  });

  test('the backup is attributed to the registered call_extraction_v1 lane, whose switchboard row lists the Claude fallback', async () => {
    const { LANES } = require('../services/model-switchboard');
    const lane = (LANES || []).find((l) => l.id === 'call_extraction_v1');
    expect(lane).toBeTruthy();
    expect(lane.fallback).toBeTruthy();

    process.env.GATE_CALL_EXTRACTION_V1_FALLBACK = 'true';
    installFetch({ gemini: () => geminiHttp(402) });
    mockAnthropicCreate.mockResolvedValue(claudeOk(GOOD));
    await extractCallData(TRANSCRIPT, PHONE, {});
    // The call ledger rows carry the lane the dispatcher ran under.
    const metrics = require('../services/llm-dispatch-metrics');
    expect(metrics.recordCall.mock.calls.length).toBeGreaterThan(0);
    for (const [row] of metrics.recordCall.mock.calls) expect(row.laneId).toBe('call_extraction_v1');
  });
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_CALL_EXTRACTION_V1_FALLBACK = 'true'; });

  test('Gemini 402 -> Claude serves the same normalized output; provider recorded; warn logged', async () => {
    installFetch({ gemini: () => geminiHttp(402, '{"error":"prepayment credits are depleted"}') });
    mockAnthropicCreate.mockResolvedValue(claudeOk(GOOD));
    const providerMeta = {};
    const out = await extractCallData(TRANSCRIPT, PHONE, { providerMeta });

    // Same normalized shape as the Gemini path would produce for this JSON.
    fetchMock.mockClear();
    installFetch({ gemini: () => geminiOk(GOOD) });
    const viaGemini = await extractCallData(TRANSCRIPT, PHONE, {});
    expect(out).toEqual(viaGemini);
    expect(out.first_name).toBe('Pat');

    expect(providerMeta).toEqual({
      extraction_v1_provider: 'anthropic',
      extraction_v1_model: expect.any(String),
      extraction_v1_fallback_reason: 'http_402',
    });
    expect(mockAnthropicCreate).toHaveBeenCalledTimes(1);
    const req = mockAnthropicCreate.mock.calls[0][0];
    expect(req.model).toBe(MODELS.CALL_EXTRACTION_ANTHROPIC);
    // Same prompt text the Gemini leg sends.
    const geminiPrompt = JSON.parse(geminiCalls()[0][1].body).contents[0].parts[0].text;
    expect(req.messages[0].content.find((b) => b.type === 'text').text).toBe(geminiPrompt);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('V1 extraction served by anthropic'));
  });

  test.each([[500], [429], [503]])('Gemini HTTP %i -> fallback serves', async (status) => {
    installFetch({ gemini: () => geminiHttp(status) });
    mockAnthropicCreate.mockResolvedValue(claudeOk(GOOD));
    const providerMeta = {};
    const out = await extractCallData(TRANSCRIPT, PHONE, { providerMeta });
    expect(out.first_name).toBe('Pat');
    expect(providerMeta.extraction_v1_fallback_reason).toBe(`http_${status}`);
  });

  test('Gemini network error / timeout -> fallback serves', async () => {
    installFetch({ gemini: () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); } });
    mockAnthropicCreate.mockResolvedValue(claudeOk(GOOD));
    const providerMeta = {};
    const out = await extractCallData(TRANSCRIPT, PHONE, { providerMeta });
    expect(out.first_name).toBe('Pat');
    expect(providerMeta.extraction_v1_fallback_reason).toBe('network_or_timeout');
  });

  test('missing GEMINI_API_KEY -> fallback serves without any Gemini request', async () => {
    delete process.env.GEMINI_API_KEY;
    installFetch({ gemini: () => geminiOk(GOOD) });
    mockAnthropicCreate.mockResolvedValue(claudeOk(GOOD));
    const providerMeta = {};
    const out = await extractCallData(TRANSCRIPT, PHONE, { providerMeta });
    expect(out.first_name).toBe('Pat');
    expect(geminiCalls()).toHaveLength(0);
    expect(providerMeta.extraction_v1_fallback_reason).toBe('key_missing');
  });

  test('invalid JSON on both Gemini parse attempts -> fallback serves', async () => {
    installFetch({ gemini: () => geminiText('not json at all') });
    mockAnthropicCreate.mockResolvedValue(claudeOk(GOOD));
    const providerMeta = {};
    const out = await extractCallData(TRANSCRIPT, PHONE, { providerMeta });
    expect(out.first_name).toBe('Pat');
    expect(out.call_summary).not.toBe(EXTRACTION_INVALID_JSON_SUMMARY);
    expect(geminiCalls()).toHaveLength(2); // the existing two parse attempts still run first
    expect(providerMeta.extraction_v1_fallback_reason).toBe('invalid_json');
  });

  test('Claude fails -> OpenAI serves (dispatcher chain)', async () => {
    installFetch({ gemini: () => geminiHttp(402), openai: () => openaiOk(GOOD) });
    mockAnthropicCreate.mockRejectedValue(Object.assign(new Error('overloaded'), { status: 529 }));
    const providerMeta = {};
    const out = await extractCallData(TRANSCRIPT, PHONE, { providerMeta });
    expect(out.first_name).toBe('Pat');
    expect(providerMeta.extraction_v1_provider).toBe('openai');
    expect(openaiCalls()).toHaveLength(1);
  });

  test('Claude returns a non-object answer -> OpenAI serves', async () => {
    installFetch({ gemini: () => geminiHttp(500), openai: () => openaiOk(GOOD) });
    mockAnthropicCreate.mockResolvedValue({ id: 'm', model: 'c', stop_reason: 'end_turn', content: [{ type: 'text', text: '[1,2]' }], usage: {} });
    const out = await extractCallData(TRANSCRIPT, PHONE, {});
    expect(out.first_name).toBe('Pat');
  });

  // normalizeCallExtraction fills gaps instead of failing, so without this
  // check `{}` from Claude would end the call with no lead, spam or voicemail
  // decision and OpenAI would never run.
  test.each([
    ['an empty object', {}],
    ['no call_type', { ...GOOD, call_type: undefined }],
    ['an unknown call_type', { ...GOOD, call_type: 'sales_pitch' }],
    ['no is_lead', { ...GOOD, is_lead: undefined }],
    ['is_spam as a string', { ...GOOD, is_spam: 'false' }],
    ['no is_voicemail', { ...GOOD, is_voicemail: undefined }],
    // Booking reads appointment_confirmed as truthy: "false" would confirm a visit.
    ['appointment_confirmed as a string', { ...GOOD, appointment_confirmed: 'false', preferred_date_time: '2026-10-23T15:00' }],
    ['no appointment_confirmed', { ...GOOD, appointment_confirmed: undefined }],
    ['a blank call_summary', { ...GOOD, call_summary: '  ' }],
  ])('Claude returns %s -> rejected as incomplete, OpenAI serves', async (_label, answer) => {
    installFetch({ gemini: () => geminiHttp(402), openai: () => openaiOk(GOOD) });
    mockAnthropicCreate.mockResolvedValue(claudeOk(answer));
    const providerMeta = {};
    const out = await extractCallData(TRANSCRIPT, PHONE, { providerMeta });
    expect(out).toMatchObject({ first_name: 'Pat', call_type: 'new_inquiry', is_lead: true, is_spam: false });
    expect(providerMeta.extraction_v1_provider).toBe('openai');
    expect(openaiCalls()).toHaveLength(1);
  });

  test('both backup legs incomplete -> the Gemini error rethrows', async () => {
    installFetch({ gemini: () => geminiHttp(402), openai: () => openaiOk({}) });
    mockAnthropicCreate.mockResolvedValue(claudeOk({}));
    const providerMeta = {};
    await expect(extractCallData(TRANSCRIPT, PHONE, { providerMeta })).rejects.toThrow(/Gemini HTTP 402/);
    expect(providerMeta).toEqual({});
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('extraction_incomplete'));
  });

  test('Gemini HTTP failure and every backup leg fails -> the Gemini error rethrows (extraction_failed path)', async () => {
    installFetch({ gemini: () => geminiHttp(402, '{"error":"prepayment credits are depleted"}'), openai: () => ({ ok: false, status: 500 }) });
    mockAnthropicCreate.mockRejectedValue(new Error('down'));
    const providerMeta = {};
    await expect(extractCallData(TRANSCRIPT, PHONE, { providerMeta })).rejects.toThrow(/Gemini HTTP 402/);
    expect(providerMeta).toEqual({});
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('V1 extraction backup failed after Gemini http_402'));
  });

  test('missing key and every backup leg fails -> the same GEMINI_API_KEY error', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    installFetch({ gemini: () => geminiOk(GOOD) });
    await expect(extractCallData(TRANSCRIPT, PHONE, {})).rejects.toThrow('GEMINI_API_KEY not configured');
  });

  test('invalid JSON and every backup leg fails -> today\'s invalid-JSON stub', async () => {
    installFetch({ gemini: () => geminiText('nope'), openai: () => ({ ok: false, status: 500 }) });
    mockAnthropicCreate.mockRejectedValue(new Error('down'));
    const out = await extractCallData(TRANSCRIPT, PHONE, {});
    expect(out.call_summary).toBe(EXTRACTION_INVALID_JSON_SUMMARY);
    expect(out.first_name).toBeNull();
  });

  test('Gemini OK -> no fallback call, nothing recorded', async () => {
    installFetch({ gemini: () => geminiOk(GOOD), openai: () => openaiOk(GOOD) });
    const providerMeta = {};
    const out = await extractCallData(TRANSCRIPT, PHONE, { providerMeta });
    expect(out.first_name).toBe('Pat');
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
    expect(openaiCalls()).toHaveLength(0);
    expect(providerMeta).toEqual({});
  });

  test('Gemini returns a parseable answer on the second parse attempt -> no fallback', async () => {
    let n = 0;
    installFetch({ gemini: () => (++n === 1 ? geminiText('garbled') : geminiOk(GOOD)) });
    const out = await extractCallData(TRANSCRIPT, PHONE, {});
    expect(out.first_name).toBe('Pat');
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });
});

describe('gate off (or not exactly "true"): byte-identical to before', () => {
  test.each([[undefined], ['1'], ['TRUE'], ['false']])('GATE=%s: Gemini 402 throws, no backup request', async (value) => {
    if (value !== undefined) process.env.GATE_CALL_EXTRACTION_V1_FALLBACK = value;
    installFetch({ gemini: () => geminiHttp(402, '{"error":"prepayment credits are depleted"}'), openai: () => openaiOk(GOOD) });
    mockAnthropicCreate.mockResolvedValue(claudeOk(GOOD));
    const providerMeta = {};
    await expect(extractCallData(TRANSCRIPT, PHONE, { providerMeta })).rejects.toThrow(/^Gemini HTTP 402: /);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
    expect(openaiCalls()).toHaveLength(0);
    expect(providerMeta).toEqual({});
  });

  test('missing GEMINI_API_KEY throws before any request', async () => {
    delete process.env.GEMINI_API_KEY;
    installFetch({ gemini: () => geminiOk(GOOD) });
    await expect(extractCallData(TRANSCRIPT, PHONE, {})).rejects.toThrow('GEMINI_API_KEY not configured');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  test('invalid JSON twice returns the stub with no backup', async () => {
    installFetch({ gemini: () => geminiText('nope') });
    mockAnthropicCreate.mockResolvedValue(claudeOk(GOOD));
    const out = await extractCallData(TRANSCRIPT, PHONE, {});
    expect(out.call_summary).toBe(EXTRACTION_INVALID_JSON_SUMMARY);
    expect(mockAnthropicCreate).not.toHaveBeenCalled();
  });

  test('Gemini OK is unchanged', async () => {
    installFetch({ gemini: () => geminiOk(GOOD) });
    const out = await extractCallData(TRANSCRIPT, PHONE, {});
    expect(out.first_name).toBe('Pat');
  });
});

// A backup read that classifies the call as spam, a non-workable voicemail or a
// V2 hard veto finalizes before the common write, which is where
// metadata.processing_timings is stamped; those two writes stamp it themselves.
describe('early finalization keeps the backup provider record', () => {
  const { v1BackupTimingsJson } = _test;
  const opts = { processingStartedAt: new Date(Date.now() - 5000), procGeneration: 3 };

  test('no backup served -> null, so both early writes stay unchanged with the gate off', () => {
    expect(v1BackupTimingsJson({ extraction_v1_ms: 900 }, opts)).toBeNull();
  });

  test('a backup served -> the common processing_timings shape, provider record included', () => {
    const json = JSON.parse(v1BackupTimingsJson({
      extraction_v1_ms: 900,
      extraction_v1_provider: 'anthropic',
      extraction_v1_model: 'claude-test',
      extraction_v1_fallback_reason: 'http_402',
    }, opts));
    expect(json).toMatchObject({
      extraction_v1_ms: 900,
      extraction_v1_provider: 'anthropic',
      extraction_v1_model: 'claude-test',
      extraction_v1_fallback_reason: 'http_402',
      generation: 3,
      started_at: opts.processingStartedAt.toISOString(),
    });
    expect(json.total_ms).toBeGreaterThanOrEqual(5000);
    expect(typeof json.finished_at).toBe('string');
  });

  test('the spam / voicemail write and the V2 hard-veto write both stamp it', () => {
    const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
    const between = (from, to) => {
      const start = src.indexOf(from);
      const end = src.indexOf(to, start);
      expect({ from, found: start > -1 && end > start }).toEqual({ from, found: true });
      return src.slice(start, end);
    };
    const blocks = [
      between('const terminalUpdate = {', '// Fenced like the finalization write, and BEFORE the shadow/triage'),
      between("const vetoWrote = await trx('call_log')", 'if (!vetoWrote)'),
    ];
    for (const block of blocks) {
      expect(block).toContain('v1BackupTimingsJson(stageTimings, { processingStartedAt, procGeneration })');
      expect(block).toContain("'{processing_timings}'");
    }
  });
});
