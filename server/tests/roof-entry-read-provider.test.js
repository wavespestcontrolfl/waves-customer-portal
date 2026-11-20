// Staff roof read: the one-paid-call rule at the PROVIDER boundary. The real dispatcher runs; only fetch (county image,
// Gemini, OpenAI), the database and the price table are faked. No network, no model, no database.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.OPENAI_API_KEY = 'test-openai-key';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

let mockRows;
jest.mock('../models/db', () => {
  const table = () => {
    const b = {
      where() { return b; },
      whereNot() { return b; },
      whereRaw() { return b; },
      orderBy() { return b; },
      async first() { return undefined; },
      async select() { return []; },
      insert(record) {
        return { async returning() { const row = { id: 'read-1', created_at: 'T', ...record }; mockRows.push(row); return [row]; } };
      },
    };
    return b;
  };
  const makeDb = () => { const c = jest.fn(() => table()); c.raw = jest.fn(async () => {}); return c; };
  const db = makeDb();
  db.transaction = async (fn) => fn(makeDb());
  return db;
});

const mockPrices = new Map();
jest.mock('../services/llm-cost', () => {
  const actual = jest.requireActual('../services/llm-cost');
  return { ...actual, loadPrices: async () => ({ map: mockPrices }) };
});

const MODELS = require('../config/models');
const llmCost = require('../services/llm-cost');
const svc = require('../services/roof-entry-read');

const realFetch = global.fetch;
let providerCalls;
beforeEach(() => {
  mockRows = [];
  providerCalls = { gemini: 0, openai: 0, image: 0 };
  mockPrices.clear();
  mockPrices.set(llmCost.normalizeModelId(MODELS.TEXT_POLICIES.estimateVision.primary.model), { input: 0.3, output: 2.5, cacheRead: null, cacheWrite: null, reasoning: null, tiers: [] });
  process.env.GATE_ROOF_ENTRY_READ = 'true';
});
afterEach(() => { global.fetch = realFetch; });

const geminiBody = (text) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 50 },
  modelVersion: 'gemini-test',
});

function fakeNetwork(geminiText) {
  global.fetch = jest.fn(async (url) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      providerCalls.gemini += 1;
      return { ok: true, status: 200, json: async () => geminiBody(geminiText) };
    }
    if (u.includes('api.openai.com')) {
      providerCalls.openai += 1;
      return { ok: true, status: 200, json: async () => ({ output_text: '{}' }) };
    }
    providerCalls.image += 1;
    return { ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 1, 2]).buffer };
  });
}

it('a billed, unparseable Gemini answer makes exactly one provider call, stores tier unknown and books that call\'s cost', async () => {
  fakeNetwork('this is not json {');
  const out = await svc.runRoofEntryRead({ lat: 27.46, lng: -82.57, county: 'Manatee' });
  expect(providerCalls).toEqual({ gemini: 1, openai: 0, image: 1 });
  expect(out.status).toBe('ok');
  expect(out.read).toEqual(expect.objectContaining({ tier: 'unknown', flags: {} }));
  expect(mockRows).toHaveLength(1);
  expect(mockRows[0].ai_tier).toBe('unknown');
  // 1200 in x $0.30/M + 50 out x $2.50/M is a fraction of a cent: rounded up to the 1 cent floor, from real usage.
  expect(mockRows[0].cost_estimate_cents).toBe(1);
});

it('a billed answer that parses but breaks the schema also makes one provider call and stores tier unknown', async () => {
  fakeNetwork(JSON.stringify({ flags: {}, tier: 'low' }));
  const out = await svc.runRoofEntryRead({ lat: 27.46, lng: -82.57, county: 'Manatee' });
  expect(providerCalls).toEqual({ gemini: 1, openai: 0, image: 1 });
  expect(out.read.tier).toBe('unknown');
});
