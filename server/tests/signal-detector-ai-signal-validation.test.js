// signal-detector.js AI sentiment mining (analyzeSentimentBatch, behind
// GATE_CUSTOMER_INTEL_AI): a Codex reviewer finding on #4884 — the dispatch
// accepted any `res.json`, so an out-of-contract confidence ("500%
// confidence") or a blank evidence quote would compose a signal_value that
// either misrepresents confidence or, past 255 chars, fails the
// customer_signals.signal_value varchar(255) insert (migration
// 20260401000037) and aborts the whole nightly detectAllSignals loop with
// the row still reading success. Fixed with a dispatchWithFallback validate
// hook (rejects an out-of-contract signal) AND clipping the composed
// signal_value to 255 before insert.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const db = require('../models/db');
const { dispatchWithFallback } = require('../services/llm/call');
const signalDetector = require('../services/customer-intelligence/signal-detector');

// Minimal chainable query: every table reads as "one recent inbound SMS with
// a body", so the sentiment step always has something to send, and `insert`
// records what was written so the test can assert on the persisted row.
function query(rows, inserted) {
  const q = {
    where: () => q, whereNotNull: () => q, whereIn: () => q, whereRaw: () => q, whereNot: () => q,
    orderBy: () => q, limit: () => q, select: () => q, join: () => q,
    count: () => ({ first: async () => ({ count: String(rows.length) }) }),
    first: async () => rows[0] || null,
    insert: async (row) => { if (inserted) inserted.push(row); return []; },
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    catch: (rej) => q.then(undefined, rej),
  };
  return q;
}

const inbound = [{
  customer_id: 'c1', direction: 'inbound', message_body: 'the tech was rude and I want to cancel',
  created_at: new Date(Date.now() - 3600000), technician_notes: 'note',
}];

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_CUSTOMER_INTEL_AI = 'true';
});
afterEach(() => { delete process.env.GATE_CUSTOMER_INTEL_AI; });

describe('analyzeSentimentBatch validate hook (via detectSignals)', () => {
  test('confidence outside [0,1] rejects the whole answer', async () => {
    db.mockImplementation(() => query(inbound));
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { signals: [{ type: 'frustration', confidence: 5, evidence: 'quote' }] } });
    await signalDetector.detectSignals('c1');
    const [, , options] = dispatchWithFallback.mock.calls[0];
    expect(options.validate({ json: { signals: [{ type: 'frustration', confidence: 5, evidence: 'quote' }] } })).toBe('schema_invalid');
    expect(options.validate({ json: { signals: [{ type: 'frustration', confidence: -0.1, evidence: 'quote' }] } })).toBe('schema_invalid');
  });

  test('a blank or non-string evidence rejects the whole answer', async () => {
    db.mockImplementation(() => query(inbound));
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { signals: [] } });
    await signalDetector.detectSignals('c1');
    const [, , options] = dispatchWithFallback.mock.calls[0];
    expect(options.validate({ json: { signals: [{ type: 'frustration', confidence: 0.8, evidence: '   ' }] } })).toBe('schema_invalid');
    expect(options.validate({ json: { signals: [{ type: 'frustration', confidence: 0.8, evidence: 42 }] } })).toBe('schema_invalid');
  });

  test('a type outside the schema enum rejects the whole answer', async () => {
    db.mockImplementation(() => query(inbound));
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { signals: [] } });
    await signalDetector.detectSignals('c1');
    const [, , options] = dispatchWithFallback.mock.calls[0];
    expect(options.validate({ json: { signals: [{ type: 'made_up', confidence: 0.8, evidence: 'quote' }] } })).toBe('schema_invalid');
  });

  test('an on-contract answer validates clean', async () => {
    db.mockImplementation(() => query(inbound));
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { signals: [] } });
    await signalDetector.detectSignals('c1');
    const [, , options] = dispatchWithFallback.mock.calls[0];
    expect(options.validate({ json: { signals: [{ type: 'frustration', confidence: 0.75, evidence: 'quote' }] } })).toBeNull();
    expect(options.validate({ json: { signals: [] } })).toBeNull();
  });
});

describe('composed signal_value is clipped to 255 before insert', () => {
  test('a long but in-contract evidence quote never fails the varchar(255) insert', async () => {
    const inserted = [];
    db.mockImplementation(() => query(inbound, inserted));
    dispatchWithFallback.mockResolvedValue({
      ok: true,
      json: { signals: [{ type: 'frustration', confidence: 0.9, evidence: 'x'.repeat(400) }] },
    });
    const newSignals = await signalDetector.detectSignals('c1');
    const aiSignal = newSignals.find((s) => s.signal_type === 'COMPLAINT_FILED');
    expect(aiSignal).toBeDefined();
    expect(aiSignal.signal_value.length).toBeLessThanOrEqual(255);
    const insertedRow = inserted.find((r) => r.signal_type === 'COMPLAINT_FILED');
    expect(insertedRow).toBeDefined();
    expect(insertedRow.signal_value.length).toBeLessThanOrEqual(255);
  });
});
