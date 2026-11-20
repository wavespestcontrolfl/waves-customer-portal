// Staff roof read: the one-paid-call rule at the PROVIDER boundary. The real dispatcher runs; only fetch (county image,
// Gemini, OpenAI), the database and the price table are faked. No network, no model, no database.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.OPENAI_API_KEY = 'test-openai-key';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

let mockRows;
jest.mock('../models/db', () => {
  const table = () => {
    const run = (fn) => { const p = async () => fn(); return { returning: p, then: (ok, bad) => p().then(ok, bad), catch: (bad) => p().catch(bad) }; };
    const b = {
      where() { return b; },
      whereNot() { return b; },
      whereRaw() { return b; },
      async first() { return undefined; },
      async select() { return []; },
      insert(record) {
        const make = async () => { const row = { id: 'read-1', created_at: 'T', ...record }; mockRows.push(row); return [row]; };
        return { returning: make, onConflict: () => ({ ignore: () => ({ returning: make }) }) };
      },
      update(patch) {
        const next = patch.claimed_at && patch.claimed_at.raw ? { claimed_at: 'T2' } : patch;
        return run(() => { Object.assign(mockRows[0], next); return [mockRows[0]]; });
      },
      del() { return run(() => { mockRows.length = 0; return 1; }); },
    };
    return b;
  };
  const db = jest.fn(() => table());
  db.fn = { now: () => 'NOW' };
  db.raw = (sql) => ({ raw: sql });
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
let geminiBodies;
beforeEach(() => {
  mockRows = [];
  providerCalls = { gemini: 0, openai: 0, image: 0 };
  geminiBodies = [];
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

function fakeNetwork(geminiText, geminiStatus = 200) {
  global.fetch = jest.fn(async (url, opts) => {
    const u = String(url);
    if (u.includes('generativelanguage.googleapis.com')) {
      providerCalls.gemini += 1;
      geminiBodies.push(JSON.parse(opts.body));
      if (geminiStatus !== 200) return { ok: false, status: geminiStatus, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => geminiBody(geminiText) };
    }
    if (u.includes('api.openai.com')) {
      providerCalls.openai += 1;
      return { ok: true, status: 200, json: async () => ({ output_text: '{}' }) };
    }
    providerCalls.image += 1;
    return { ok: true, headers: { get: (n) => (n === 'content-type' ? 'image/jpeg' : null) }, body: (async function* () { yield Uint8Array.from([0xff, 0xd8, 1, 2]); }()) };
  });
}

it('a billed, unparseable Gemini answer makes exactly one provider call, stores a failed unknown row and books that call\'s cost', async () => {
  fakeNetwork('this is not json {');
  const out = await svc.runRoofEntryRead({ lat: 27.46, lng: -82.57, county: 'Manatee' });
  expect(providerCalls).toEqual({ gemini: 1, openai: 0, image: 1 });
  // The Gemini adapter reads thinkingLevel; the outgoing request must carry it.
  expect(geminiBodies[0].generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
  expect(out.status).toBe('ok');
  expect(out.read).toEqual(expect.objectContaining({ tier: 'unknown', flags: {} }));
  expect(mockRows).toHaveLength(1);
  expect(mockRows[0].ai_tier).toBe('unknown');
  expect(mockRows[0].status).toBe('failed');
  // 1200 in x $0.30/M + 50 out x $2.50/M is a fraction of a cent: rounded up to the 1 cent floor, from real usage.
  expect(mockRows[0].cost_estimate_cents).toBe(1);
});

it('a billed answer that parses but breaks the schema also makes one provider call and stores tier unknown', async () => {
  fakeNetwork(JSON.stringify({ flags: {}, tier: 'low' }));
  const out = await svc.runRoofEntryRead({ lat: 27.46, lng: -82.57, county: 'Manatee' });
  expect(providerCalls).toEqual({ gemini: 1, openai: 0, image: 1 });
  expect(out.read.tier).toBe('unknown');
  expect(mockRows[0].status).toBe('failed');
  // The dispatcher's validate hook rejected it (a quality failure with its billed usage), yet no second provider call.
  expect(mockRows[0].cost_estimate_cents).toBe(1);
});

it('a Gemini 503 may have been billed: one provider call, a failed row at the 5-cent ceiling, no OpenAI call', async () => {
  fakeNetwork('', 503);
  const out = await svc.runRoofEntryRead({ lat: 27.46, lng: -82.57, county: 'Manatee' });
  expect(providerCalls).toEqual({ gemini: 1, openai: 0, image: 1 });
  expect(out).toEqual({ status: 'model_failed', cached: false, read: null });
  expect(mockRows).toHaveLength(1);
  expect(mockRows[0]).toEqual(expect.objectContaining({ status: 'failed', ai_tier: 'unknown', cost_estimate_cents: svc.FALLBACK_COST_CENTS }));
});

it('a Gemini 401 never reached billing: one provider call and the claim is released', async () => {
  fakeNetwork('', 401);
  const out = await svc.runRoofEntryRead({ lat: 27.46, lng: -82.57, county: 'Manatee' });
  expect(providerCalls).toEqual({ gemini: 1, openai: 0, image: 1 });
  expect(out.status).toBe('model_failed');
  expect(mockRows).toHaveLength(0);
});

it('a Gemini network error after the request was sent is spend unknown: kept as a failed row', async () => {
  global.fetch = jest.fn(async (url) => {
    if (String(url).includes('generativelanguage.googleapis.com')) throw new Error('socket hang up');
    return { ok: true, headers: { get: (n) => (n === 'content-type' ? 'image/jpeg' : null) }, body: (async function* () { yield Uint8Array.from([0xff, 0xd8, 1]); }()) };
  });
  const out = await svc.runRoofEntryRead({ lat: 27.46, lng: -82.57, county: 'Manatee' });
  expect(out.status).toBe('model_failed');
  expect(mockRows).toHaveLength(1);
  expect(mockRows[0]).toEqual(expect.objectContaining({ status: 'failed', cost_estimate_cents: svc.FALLBACK_COST_CENTS }));
});

it('a Gemini answer with no usageMetadata (null counters) books the 5-cent ceiling, not 1 cent', async () => {
  global.fetch = jest.fn(async (url) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      providerCalls.gemini += 1;
      const body = geminiBody('not json');
      delete body.usageMetadata;
      return { ok: true, status: 200, json: async () => body };
    }
    providerCalls.image += 1;
    return { ok: true, headers: { get: (n) => (n === 'content-type' ? 'image/jpeg' : null) }, body: (async function* () { yield Uint8Array.from([0xff, 0xd8, 1]); }()) };
  });
  const out = await svc.runRoofEntryRead({ lat: 27.46, lng: -82.57, county: 'Manatee' });
  expect(providerCalls.gemini).toBe(1);
  expect(out.status).toBe('model_failed');
  // No usage means the call is spend-unknown: a failed row at the ceiling, from one provider call.
  expect(mockRows[0]).toEqual(expect.objectContaining({ status: 'failed', cost_estimate_cents: svc.FALLBACK_COST_CENTS }));
});
