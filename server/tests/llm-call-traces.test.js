// Locks the LLM call-trace contract (agent-control S2a): redacted bodies are
// kept ONLY when GATE_LLM_CALL_TRACES is on AND the lane's runtime policy
// opts in, every body passes through the PII redactor and is capped, an
// inbound lane skips a low-confidence redaction entirely, and nothing is
// written when the call row itself was not (null id). Fire-and-forget:
// never throws into the adapter.

const mockInsert = jest.fn();
const mockDb = jest.fn((table) => ({ insert: (row) => mockInsert(table, row) }));
jest.mock('../models/db', () => {
  const db = (...args) => mockDb(...args);
  db.raw = (sql) => sql;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// Lane fixtures: which lanes trace, and which carry inbound content.
jest.mock('../services/agent-control/lane-policies', () => ({
  policyFor: (id) => ({ trace: id === 'traced_inbound' || id === 'traced_plain' }),
}));
jest.mock('../services/model-switchboard', () => ({
  LANES: [{ id: 'traced_inbound', inbound: true }, { id: 'traced_plain' }, { id: 'untraced' }],
}));
let mockConfidence = 'high';
const mockRedact = jest.fn((text) => ({ text: text.replace(/\d{3}-\d{3}-\d{4}/g, '[phone]'), confidence: mockConfidence, findings: [] }));
jest.mock('../services/content/pii-redactor', () => ({ redact: (...a) => mockRedact(...a) }));

const ORIGINAL_ENV = { ...process.env };

function load() {
  let mod;
  jest.isolateModules(() => {
    mod = require('../services/llm-dispatch-metrics');
    // Same isolated registry as the service, or the context instances differ.
    mod.context = require('../services/agent-control/context');
  });
  return mod;
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const traceRows = () => mockInsert.mock.calls.filter(([t]) => t === 'llm_call_traces').map(([, row]) => row);

describe('recordTrace', () => {
  beforeEach(() => {
    jest.resetModules();
    mockInsert.mockReset();
    mockInsert.mockImplementation(() => { const p = Promise.resolve([{ id: 7 }]); p.returning = () => Promise.resolve([{ id: 7 }]); return p; });
    mockDb.mockClear();
    mockRedact.mockClear();
    mockConfidence = 'high';
    process.env = { ...ORIGINAL_ENV, GATE_LLM_CALL_TRACES: 'true' };
    delete process.env.GATE_LLM_CALL_LEDGER;
  });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  it('writes the redacted bodies keyed to the call id for an opted-in lane', async () => {
    const { recordTrace } = load();
    recordTrace(Promise.resolve(42), { system: 'sys', prompt: 'call me at 941-555-1234', response: 'ok 941-555-9999', laneId: 'traced_plain' });
    await flush();
    expect(traceRows()).toEqual([{
      call_id: 42,
      lane_id: 'traced_plain',
      run_id: null,
      system_redacted: 'sys',
      prompt_redacted: 'call me at [phone]',
      response_redacted: 'ok [phone]',
      redaction_confidence: 'high',
    }]);
    expect(mockRedact).toHaveBeenCalledTimes(3);
  });

  it('is dark when the gate is off, even for an opted-in lane', async () => {
    delete process.env.GATE_LLM_CALL_TRACES;
    const { recordTrace } = load();
    recordTrace(Promise.resolve(1), { prompt: 'p', laneId: 'traced_plain' });
    await flush();
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockRedact).not.toHaveBeenCalled();
  });

  it('skips lanes whose policy does not opt in, and calls with no lane at all', async () => {
    const { recordTrace } = load();
    recordTrace(Promise.resolve(1), { prompt: 'p', laneId: 'untraced' });
    recordTrace(Promise.resolve(2), { prompt: 'p' });
    await flush();
    expect(mockDb).not.toHaveBeenCalled();
  });

  it('skips when the call row was not written (null id) — no orphan traces, no redaction work', async () => {
    const { recordTrace } = load();
    recordTrace(Promise.resolve(null), { prompt: 'p', laneId: 'traced_plain' });
    await flush();
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockRedact).not.toHaveBeenCalled();
  });

  it('drops an INBOUND lane trace when redaction confidence is low, keeps a plain lane with the confidence stamped', async () => {
    mockConfidence = 'low';
    const { recordTrace } = load();
    recordTrace(Promise.resolve(1), { prompt: 'customer text', laneId: 'traced_inbound' });
    recordTrace(Promise.resolve(2), { prompt: 'internal text', laneId: 'traced_plain' });
    await flush();
    expect(traceRows()).toHaveLength(1);
    expect(traceRows()[0]).toMatchObject({ call_id: 2, lane_id: 'traced_plain', redaction_confidence: 'low' });
  });

  it('records the WORST confidence across the three bodies', async () => {
    const { recordTrace } = load();
    mockRedact
      .mockImplementationOnce((t) => ({ text: t, confidence: 'high', findings: [] }))
      .mockImplementationOnce((t) => ({ text: t, confidence: 'medium', findings: [] }))
      .mockImplementationOnce((t) => ({ text: t, confidence: 'high', findings: [] }));
    recordTrace(Promise.resolve(3), { system: 's', prompt: 'p', response: 'r', laneId: 'traced_plain' });
    await flush();
    expect(traceRows()[0].redaction_confidence).toBe('medium');
  });

  it('caps each body at 8 KB AFTER redaction', async () => {
    const { recordTrace, TRACE_BODY_CAP } = load();
    const long = `${'x'.repeat(TRACE_BODY_CAP + 500)} 941-555-1234`;
    recordTrace(Promise.resolve(4), { prompt: long, laneId: 'traced_plain' });
    await flush();
    const [row] = traceRows();
    expect(row.prompt_redacted).toHaveLength(TRACE_BODY_CAP);
    // the redactor saw the FULL body (the phone number past the cap was still redacted, not truncated in half)
    expect(mockRedact.mock.calls[0][0]).toBe(long);
    expect(row.system_redacted).toBeNull();
  });

  it('ledgerCall traces a direct-SDK call: request bodies from the caller, the response from the Message text blocks', async () => {
    process.env.GATE_LLM_CALL_LEDGER = 'true';
    const { ledgerCall } = load();
    const message = { id: 'msg_9', model: 'm', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'answer for 941-555-1234' }], usage: { input_tokens: 1, output_tokens: 1 } };
    await ledgerCall('anthropic', 'm', () => Promise.resolve(message), { laneId: 'traced_plain', trace: { system: 'sys', prompt: 'ask' } });
    await flush();
    expect(traceRows()).toEqual([expect.objectContaining({ lane_id: 'traced_plain', system_redacted: 'sys', prompt_redacted: 'ask', response_redacted: 'answer for [phone]' })]);
    expect(typeof traceRows()[0].call_id).toBe('number');
  });

  it('ledgerCall without a trace option records the call only', async () => {
    process.env.GATE_LLM_CALL_LEDGER = 'true';
    const { ledgerCall } = load();
    await ledgerCall('anthropic', 'm', () => Promise.resolve({ id: 'msg_1', content: [{ type: 'text', text: 'x' }] }), { laneId: 'traced_plain' });
    await flush();
    expect(traceRows()).toEqual([]);
  });

  it('uses the ambient lane and run id when no laneId is passed, and never throws on a DB error', async () => {
    const { recordTrace, context } = load();
    mockInsert.mockImplementation(() => Promise.reject(new Error('db down')));
    const runId = '44444444-4444-4444-8444-444444444444';
    expect(() => context.runInRun({ runId }, () => context.runInLane('traced_plain', () => {
      recordTrace(Promise.resolve(5), { prompt: 'p' });
    }))).not.toThrow();
    await flush();
    expect(mockInsert.mock.calls[0][1]).toMatchObject({ call_id: 5, lane_id: 'traced_plain', run_id: runId });
  });
});
