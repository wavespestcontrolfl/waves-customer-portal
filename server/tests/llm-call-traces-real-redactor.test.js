// The LLM call-trace path with the REAL pii-redactor (llm-call-traces.test.js
// mocks it): a serialised customer profile whose first name sits in a JSON
// scalar — `"name":"Jennifer"`, last_name null — must never reach
// llm_call_traces (codex r1 P1 on #4788). The structured-field scrub runs
// before the prose redactor, and the stored body carries the token.

const mockInsert = jest.fn();
const mockDb = jest.fn((table) => ({ insert: (row) => mockInsert(table, row) }));
jest.mock('../models/db', () => {
  const db = (...args) => mockDb(...args);
  db.raw = (sql) => sql;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/agent-control/lane-policies', () => ({ policyFor: (id) => ({ trace: id === 'traced' }) }));
jest.mock('../services/model-switchboard', () => ({ LANES: [{ id: 'traced' }] }));

const ORIGINAL_ENV = { ...process.env };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const traceRows = () => mockInsert.mock.calls.filter(([t]) => t === 'llm_call_traces').map(([, row]) => row);

describe('LLM call traces with the real redactor', () => {
  let recordTrace;
  beforeEach(() => {
    jest.resetModules();
    mockInsert.mockReset();
    mockInsert.mockImplementation(() => Promise.resolve([{ id: 7 }]));
    process.env = { ...ORIGINAL_ENV, GATE_LLM_CALL_TRACES: 'true' };
    ({ recordTrace } = require('../services/llm-dispatch-metrics'));
  });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  it('scrubs a scalar first name and phone out of a serialised profile before storing the prompt', async () => {
    const prompt = 'CUSTOMER PROFILE\n{"name":"Jennifer","last_name":null,"phone":"9415551234","plan":"Quarterly Pest"}\nREQUEST\nCompose the intent.';
    recordTrace(Promise.resolve(1), { system: 'You compose estimate intents.', prompt, response: '{"service":"quarterly"}', laneId: 'traced' });
    await flush();
    const rows = traceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt_redacted).not.toMatch(/Jennifer|9415551234/);
    expect(rows[0].prompt_redacted).toContain('"name":"[name]"');
    expect(rows[0].prompt_redacted).toContain('"phone":"[phone]"');
    expect(rows[0].prompt_redacted).toContain('"plan":"Quarterly Pest"');
  });

  it('scrubs label-shaped contact lines the same way', async () => {
    recordTrace(Promise.resolve(2), { prompt: 'VISIT\nCustomer: Jennifer\nAddress: 12 Palm Ct\nService: lawn', laneId: 'traced' });
    await flush();
    const [row] = traceRows();
    expect(row.prompt_redacted).toBe('VISIT\nCustomer: [name]\nAddress: [address]\nService: lawn');
  });
});
