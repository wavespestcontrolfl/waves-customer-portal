// Chrome extension bug identifier (POST /api/public/bug-id-extension/identify,
// GATE_BUG_ID_EXTENSION). Anonymous, worldwide, Turnstile-less paid vision, so
// the behaviors that matter are the spend guards and the egress: dark = 404
// before anything else, junk never reaches a limiter count / the daily counter
// / the model, the worldwide cap is its own fail-closed bucket, and only the
// engine's customer-facing v2 object ever leaves the server.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'bug-id-test-secret';

const mockGates = { bugIdExtension: true, sharedCap: false };
const mockRaw = jest.fn();
const mockIdentifyPestV2 = jest.fn();

jest.mock('../models/db', () => {
  const db = jest.fn(() => { throw new Error('the bug-id route must not query tables'); });
  db.raw = (...args) => mockRaw(...args);
  db.fn = { now: () => 'NOW' };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  bugIdExtensionLive: () => mockGates.bugIdExtension,
  publicLlmSharedCapLive: () => mockGates.sharedCap,
}));
jest.mock('../services/photo-id-v2/pest-engine', () => ({
  identifyPestV2: (...args) => mockIdentifyPestV2(...args),
}));

jest.setTimeout(30000);

const express = require('express');
const { _test: { MAX_PHOTO_CHARS } } = require('../routes/public-bug-id-extension');

const PATH = '/api/public/bug-id-extension/identify';
const V2 = {
  version: 2,
  catalog_version: 'test-catalog',
  tier: 'ai_suggestion',
  answer: { level: 'entry', node_id: 'german-cockroach', wording: 'pretty_sure', headline: "We're pretty sure: German cockroach", subhead: 'Blattella germanica' },
  group: { id: 'roaches', label: 'Cockroaches' },
  entry: { slug: 'german-cockroach', common_name: 'German cockroach', verdict: 'call', site_url: 'https://www.wavespestcontrol.com/pest-identifier/german-cockroach/' },
  evidence: [],
  candidates: [],
  next_photo: null,
  referral: null,
  generic_safety_line: null,
};

function appServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.use('/api/public/bug-id-extension', require('../routes/public-bug-id-extension'));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
async function withServer(fn) {
  const { server, base } = appServer();
  try { return await fn(base); } finally { await new Promise((r) => server.close(r)); }
}
function post(base, body) {
  return fetch(`${base}${PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
const photo = (extra = {}) => ({ data: 'aGVsbG8=', mimeType: 'image/jpeg', ...extra });
const countIs = (n) => mockRaw.mockResolvedValueOnce({ rows: [{ count: n }] });

beforeEach(() => {
  jest.clearAllMocks();
  mockRaw.mockReset();
  Object.assign(mockGates, { bugIdExtension: true, sharedCap: false });
  mockIdentifyPestV2.mockResolvedValue({
    ok: true,
    v2: V2,
    v1: { species_slug: 'german-cockroach', report_contract: { identification: {} } },
    internal: { models: { candidates: { ok: true, provider: 'gemini', model: 'x' } }, ladder: 'gemini_only' },
  });
  delete process.env.PUBLIC_LLM_DAILY_CAP_BUG_ID_EXTENSION;
});

describe('gate', () => {
  test('dark: 404 with no counter bump and no model call', async () => {
    mockGates.bugIdExtension = false;
    await withServer(async (base) => {
      const res = await post(base, { photos: [photo()] });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    });
    expect(mockRaw).not.toHaveBeenCalled();
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
  });
});

describe('POST /identify', () => {
  test('answers with ONLY the v2 customer object — never internal or v1 — after one count in its own bucket', async () => {
    countIs(1);
    await withServer(async (base) => {
      const res = await post(base, { photos: [photo(), photo({ mimeType: 'image/png' })] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, result: V2 });
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
    expect(mockIdentifyPestV2).toHaveBeenCalledWith(
      [{ data: 'aGVsbG8=', mimeType: 'image/jpeg' }, { data: 'aGVsbG8=', mimeType: 'image/png' }],
      { ladder: 'gemini_only' },
    );
    expect(mockRaw).toHaveBeenCalledTimes(1);
    expect(mockRaw.mock.calls[0][1][0]).toBe('bug-id-extension');
  });

  test('bad bodies 400/413 before the daily counter or the model', async () => {
    const cases = [
      [{}, 400],
      [{ photos: [] }, 400],
      [{ photos: [photo(), photo(), photo(), photo()] }, 400],
      [{ photos: [photo({ mimeType: 'image/gif' })] }, 400],
      [{ photos: [photo({ data: 'data:image/jpeg;base64,aGVsbG8=' })] }, 400],
      [{ photos: [photo({ data: '' })] }, 400],
      [{ photos: ['aGVsbG8='] }, 400],
      [{ photos: [photo({ data: 'A'.repeat(MAX_PHOTO_CHARS + 4) })] }, 413],
    ];
    await withServer(async (base) => {
      for (const [body, status] of cases) {
        const res = await post(base, body);
        expect([JSON.stringify(body).slice(0, 80), res.status]).toEqual([JSON.stringify(body).slice(0, 80), status]);
      }
    });
    expect(mockRaw).not.toHaveBeenCalled();
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
  });

  test('over the worldwide cap (100 by default, env override): 429 and no model call', async () => {
    await withServer(async (base) => {
      countIs(101);
      expect((await post(base, { photos: [photo()] })).status).toBe(429);
      process.env.PUBLIC_LLM_DAILY_CAP_BUG_ID_EXTENSION = '2';
      countIs(3);
      const res = await post(base, { photos: [photo()] });
      expect(res.status).toBe(429);
      expect((await res.json()).error).toMatch(/free identifications are used up/);
    });
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
  });

  test('the cap holds with GATE_PUBLIC_LLM_SHARED_CAP off and fails closed on a counter error', async () => {
    mockGates.sharedCap = false;
    mockRaw.mockRejectedValueOnce(new Error('connection refused'));
    await withServer(async (base) => {
      expect((await post(base, { photos: [photo()] })).status).toBe(429);
    });
    expect(mockRaw).toHaveBeenCalledTimes(1);
    expect(mockIdentifyPestV2).not.toHaveBeenCalled();
  });

  test('vision unavailable: honest 503', async () => {
    countIs(1);
    mockIdentifyPestV2.mockResolvedValueOnce({ ok: false, reason: 'vision_unavailable' });
    await withServer(async (base) => {
      const res = await post(base, { photos: [photo()] });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: expect.stringMatching(/briefly unavailable/) });
    });
  });
});

describe('per-IP limiter (production)', () => {
  const realEnv = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = realEnv; });

  test('6 an hour; junk bodies never count; a dark gate still answers 404, not 429', async () => {
    process.env.NODE_ENV = 'production';
    mockRaw.mockResolvedValue({ rows: [{ count: 1 }] });
    await withServer(async (base) => {
      for (let i = 0; i < 3; i += 1) expect((await post(base, { photos: [] })).status).toBe(400);
      for (let i = 0; i < 6; i += 1) expect((await post(base, { photos: [photo()] })).status).toBe(200);
      const limited = await post(base, { photos: [photo()] });
      expect(limited.status).toBe(429);
      expect((await limited.json()).error).toMatch(/in an hour/);
      mockGates.bugIdExtension = false;
      expect((await post(base, { photos: [photo()] })).status).toBe(404);
    });
    expect(mockIdentifyPestV2).toHaveBeenCalledTimes(6);
  });
});
