// Shared daily cap for the public paid-LLM routes (GATE_PUBLIC_LLM_SHARED_CAP,
// security audit run 2 #13). The cap is consumed INSIDE each route, once per
// request, right before the paid model call, so a request rejected earlier
// (route limiter, honeypot, Turnstile, validation, dark gate) never burns it.
const mockGateState = { askWaves: true, lawnAssessmentMagnet: true, pestIdentifier: true, leadTurnstile: true };
let mockSharedCapLive = true;
let mockTurnstileResult = { ok: true, enforced: true };
const mockRaw = jest.fn();
const mockLadder = jest.fn();
const mockIdentifyPest = jest.fn();
const mockProcess = jest.fn();

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = (...args) => mockRaw(...args);
  db.fn = { now: () => 'NOW' };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: (gate) => !!mockGateState[gate],
  publicLlmSharedCapLive: () => mockSharedCapLive,
}));
jest.mock('../utils/turnstile', () => ({ verifyTurnstileToken: jest.fn(async () => mockTurnstileResult) }));
jest.mock('../utils/lead-abuse', () => {
  const actual = jest.requireActual('../utils/lead-abuse');
  return { ...actual, resolveSubmitHost: () => 'wavespestcontrol.com' };
});
jest.mock('../utils/funnel-photos', () => ({ storeFunnelPhotos: jest.fn(async () => {}) }));
jest.mock('../services/lawn-diagnostic-analyze', () => {
  const actual = jest.requireActual('../services/lawn-diagnostic-analyze');
  return { ...actual, runFindingsLadder: (...a) => mockLadder(...a) };
});
jest.mock('../services/lawn-assessment', () => ({ getSeason: () => 'peak' }));
jest.mock('../services/pest-identification', () => {
  const actual = jest.requireActual('../services/pest-identification');
  return { ...actual, identifyPest: (...a) => mockIdentifyPest(...a) };
});
jest.mock('../services/ask-waves-intake', () => {
  const actual = jest.requireActual('../services/ask-waves-intake');
  return { ...actual, processIntakeMessage: (...a) => mockProcess(...a) };
});

jest.setTimeout(60000);

const express = require('express');
const logger = require('../services/logger');
const {
  consumeSharedDailyCap, resolveMax, DAILY_LIMIT_MESSAGE, ASK_WAVES_CAP, PHOTO_ASSESSMENT_CAP, BUG_ID_EXTENSION_CAP,
} = require('../middleware/public-llm-shared-cap');

function appServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.use('/api/public/lawn-assessment', require('../routes/public-lawn-assessment'));
  app.use('/api/public/pest-identifier', require('../routes/public-pest-identifier'));
  app.use('/api/public/ai-intake', require('../routes/public-ai-intake'));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
async function withServer(fn) {
  const { server, base } = appServer();
  try { return await fn(base); } finally { await new Promise((r) => server.close(r)); }
}
function post(base, path, body) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
const photoBody = (extra = {}) => ({ photos: [{ data: 'aGVsbG8=', mimeType: 'image/jpeg' }], turnstile_token: 'tok', ...extra });
const countIs = (n) => mockRaw.mockResolvedValueOnce({ rows: [{ count: n }] });

beforeEach(() => {
  jest.clearAllMocks();
  mockRaw.mockReset();
  mockSharedCapLive = true;
  mockTurnstileResult = { ok: true, enforced: true };
  Object.assign(mockGateState, { askWaves: true, lawnAssessmentMagnet: true, pestIdentifier: true, leadTurnstile: true });
  mockLadder.mockRejectedValue(new Error('stop after cap'));
  mockIdentifyPest.mockResolvedValue({ ok: false });
  mockProcess.mockResolvedValue({ reply: 'ok' });
  delete process.env.PUBLIC_LLM_DAILY_CAP_ASK_WAVES;
  delete process.env.PUBLIC_LLM_DAILY_CAP_PHOTO;
  delete process.env.PUBLIC_LLM_DAILY_CAP_BUG_ID_EXTENSION;
});

describe('consumeSharedDailyCap', () => {
  test('gate off: allowed with no DB call', async () => {
    mockSharedCapLive = false;
    expect(await consumeSharedDailyCap(ASK_WAVES_CAP)).toEqual({ allowed: true });
    expect(mockRaw).not.toHaveBeenCalled();
  });

  test('gate on: one atomic upsert keyed by bucket and ET day; allowed up to the cap, refused over it', async () => {
    countIs(1500);
    expect(await consumeSharedDailyCap(ASK_WAVES_CAP)).toEqual({ allowed: true });
    countIs(1501);
    expect(await consumeSharedDailyCap(ASK_WAVES_CAP)).toEqual({ allowed: false });
    const [sql, bindings] = mockRaw.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO public_llm_daily_usage/);
    expect(sql).toMatch(/ON CONFLICT \(bucket, day\)\s+DO UPDATE SET count = public_llm_daily_usage\.count \+ 1, updated_at = now\(\)/);
    expect(sql).toMatch(/RETURNING count/);
    expect(bindings[0]).toBe('ask-waves');
    expect(bindings[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('defaults: ask-waves 1500, photo 300; env override and invalid fallback', async () => {
    expect(ASK_WAVES_CAP.defaultMax).toBe(1500);
    expect(PHOTO_ASSESSMENT_CAP.defaultMax).toBe(300);
    process.env.PUBLIC_LLM_DAILY_CAP_PHOTO = '10';
    countIs(11);
    expect((await consumeSharedDailyCap(PHOTO_ASSESSMENT_CAP)).allowed).toBe(false);
    countIs(10);
    expect((await consumeSharedDailyCap(PHOTO_ASSESSMENT_CAP)).allowed).toBe(true);
    process.env.PUBLIC_LLM_DAILY_CAP_PHOTO = 'lots';
    countIs(300);
    expect((await consumeSharedDailyCap(PHOTO_ASSESSMENT_CAP)).allowed).toBe(true);
    countIs(301);
    expect((await consumeSharedDailyCap(PHOTO_ASSESSMENT_CAP)).allowed).toBe(false);
    for (const v of ['0', '-3', '2.5']) {
      process.env.TEST_CAP_X = v;
      expect(resolveMax('TEST_CAP_X', 7)).toBe(7);
    }
    process.env.TEST_CAP_X = '25';
    expect(resolveMax('TEST_CAP_X', 7)).toBe(25);
    delete process.env.TEST_CAP_X;
  });

  test('day key is the America/New_York date, not UTC', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout'] }).setSystemTime(new Date('2026-10-25T02:30:00Z'));
    try {
      countIs(1);
      await consumeSharedDailyCap(ASK_WAVES_CAP);
      expect(mockRaw.mock.calls[0][1][1]).toBe('2026-10-24');
      jest.setSystemTime(new Date('2026-10-25T04:30:00Z'));
      countIs(1);
      await consumeSharedDailyCap(ASK_WAVES_CAP);
      expect(mockRaw.mock.calls[1][1][1]).toBe('2026-10-25');
    } finally { jest.useRealTimers(); }
  });

  test('fails open on a DB error and on no row; warns at most once a minute', async () => {
    mockRaw.mockRejectedValue(new Error('connection refused'));
    expect(await consumeSharedDailyCap(ASK_WAVES_CAP)).toEqual({ allowed: true });
    expect(await consumeSharedDailyCap(ASK_WAVES_CAP)).toEqual({ allowed: true });
    expect(logger.warn.mock.calls.length).toBeLessThanOrEqual(1);
    mockRaw.mockReset();
    mockRaw.mockResolvedValueOnce({ rows: [] });
    expect(await consumeSharedDailyCap(ASK_WAVES_CAP)).toEqual({ allowed: true });
  });

  test('failClosed budget (Chrome extension): counted with the gate off, 100 by default, refused on a DB error or no row', async () => {
    mockSharedCapLive = false;
    expect(BUG_ID_EXTENSION_CAP).toMatchObject({ bucket: 'bug-id-extension', defaultMax: 100, failClosed: true });
    countIs(100);
    expect(await consumeSharedDailyCap(BUG_ID_EXTENSION_CAP)).toEqual({ allowed: true });
    countIs(101);
    expect(await consumeSharedDailyCap(BUG_ID_EXTENSION_CAP)).toEqual({ allowed: false });
    expect(mockRaw.mock.calls[0][1][0]).toBe('bug-id-extension');
    process.env.PUBLIC_LLM_DAILY_CAP_BUG_ID_EXTENSION = '3';
    countIs(4);
    expect(await consumeSharedDailyCap(BUG_ID_EXTENSION_CAP)).toEqual({ allowed: false });
    mockRaw.mockRejectedValueOnce(new Error('connection refused'));
    expect(await consumeSharedDailyCap(BUG_ID_EXTENSION_CAP)).toEqual({ allowed: false });
    mockRaw.mockResolvedValueOnce({ rows: [] });
    expect(await consumeSharedDailyCap(BUG_ID_EXTENSION_CAP)).toEqual({ allowed: false });
  });
});

describe('lawn-assessment /analyze', () => {
  const URL_PATH = '/api/public/lawn-assessment/analyze';

  test('an accepted request counts exactly once, before the model call', async () => {
    countIs(1);
    await withServer(async (base) => {
      await post(base, URL_PATH, photoBody());
    });
    expect(mockRaw).toHaveBeenCalledTimes(1);
    expect(mockRaw.mock.calls[0][1][0]).toBe('photo-assessment');
    expect(mockLadder).toHaveBeenCalledTimes(1);
  });

  test('over the cap: 429 with the daily-limit message and no model call', async () => {
    countIs(301);
    await withServer(async (base) => {
      const res = await post(base, URL_PATH, photoBody());
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual(DAILY_LIMIT_MESSAGE);
    });
    expect(mockLadder).not.toHaveBeenCalled();
  });

  test('requests rejected before the paid call never count: Turnstile 403, honeypot, bad body, dark gate', async () => {
    await withServer(async (base) => {
      mockTurnstileResult = { ok: false, enforced: true };
      expect((await post(base, URL_PATH, photoBody())).status).toBe(403);
      mockTurnstileResult = { ok: true, enforced: true };
      expect((await post(base, URL_PATH, photoBody({ fax_number: '555-0100' }))).status).toBe(200);
      expect((await post(base, URL_PATH, { turnstile_token: 'tok', photos: [{ data: '' }] })).status).toBe(400);
      expect((await post(base, URL_PATH, photoBody({ photos: Array(6).fill({ data: 'x' }) }))).status).toBe(400);
      mockGateState.lawnAssessmentMagnet = false;
      expect((await post(base, URL_PATH, photoBody())).status).toBe(404);
    });
    expect(mockRaw).not.toHaveBeenCalled();
    expect(mockLadder).not.toHaveBeenCalled();
  });

  test('requests refused by the route hourly limiter never count', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      mockRaw.mockResolvedValue({ rows: [{ count: 1 }] });
      await withServer(async (base) => {
        const statuses = [];
        for (let i = 0; i < 7; i += 1) statuses.push((await post(base, URL_PATH, photoBody())).status);
        expect(statuses.slice(0, 5).every((st) => st !== 429)).toBe(true);
        expect(statuses.slice(5)).toEqual([429, 429]);
      });
      expect(mockRaw).toHaveBeenCalledTimes(5);
    } finally { process.env.NODE_ENV = prev; }
  });

  test('gate off: no DB call at all', async () => {
    mockSharedCapLive = false;
    await withServer(async (base) => { await post(base, URL_PATH, photoBody()); });
    expect(mockRaw).not.toHaveBeenCalled();
    expect(mockLadder).toHaveBeenCalledTimes(1);
  });
});

describe('pest-identifier /analyze', () => {
  const URL_PATH = '/api/public/pest-identifier/analyze';

  test('accepted request counts once in the SAME photo bucket as the lawn route', async () => {
    countIs(1);
    await withServer(async (base) => { await post(base, URL_PATH, photoBody()); });
    expect(mockRaw).toHaveBeenCalledTimes(1);
    expect(mockRaw.mock.calls[0][1][0]).toBe('photo-assessment');
    expect(mockIdentifyPest).toHaveBeenCalledTimes(1);
  });

  test('over the cap: 429 and no vision call', async () => {
    countIs(301);
    await withServer(async (base) => {
      const res = await post(base, URL_PATH, photoBody());
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual(DAILY_LIMIT_MESSAGE);
    });
    expect(mockIdentifyPest).not.toHaveBeenCalled();
  });

  test('Turnstile-rejected and invalid requests never count', async () => {
    await withServer(async (base) => {
      mockTurnstileResult = { ok: false, enforced: true };
      expect((await post(base, URL_PATH, photoBody())).status).toBe(403);
      mockTurnstileResult = { ok: true, enforced: true };
      expect((await post(base, URL_PATH, { turnstile_token: 'tok', photos: [] })).status).toBe(400);
      mockGateState.pestIdentifier = false;
      expect((await post(base, URL_PATH, photoBody())).status).toBe(404);
    });
    expect(mockRaw).not.toHaveBeenCalled();
    expect(mockIdentifyPest).not.toHaveBeenCalled();
  });
});

describe('ai-intake /message', () => {
  const URL_PATH = '/api/public/ai-intake/message';

  test('an accepted turn counts once in the ask-waves bucket', async () => {
    countIs(1);
    await withServer(async (base) => {
      const res = await post(base, URL_PATH, { message: 'Do you treat for ants?' });
      expect(res.status).toBe(200);
    });
    expect(mockRaw).toHaveBeenCalledTimes(1);
    expect(mockRaw.mock.calls[0][1][0]).toBe('ask-waves');
    expect(mockProcess).toHaveBeenCalledTimes(1);
  });

  test('over the cap: 429 with the daily-limit message and no model call', async () => {
    countIs(1501);
    await withServer(async (base) => {
      const res = await post(base, URL_PATH, { message: 'Do you treat for ants?' });
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual(DAILY_LIMIT_MESSAGE);
    });
    expect(mockProcess).not.toHaveBeenCalled();
  });

  test('dark gate and bad bodies never count', async () => {
    await withServer(async (base) => {
      expect((await post(base, URL_PATH, {})).status).toBe(400);
      expect((await post(base, URL_PATH, { message: '   ' })).status).toBe(400);
      mockGateState.askWaves = false;
      expect((await post(base, URL_PATH, { message: 'hi' })).status).toBe(503);
    });
    expect(mockRaw).not.toHaveBeenCalled();
    expect(mockProcess).not.toHaveBeenCalled();
  });

  test('turns refused by the route 30/15min limiter never count', async () => {
    mockRaw.mockResolvedValue({ rows: [{ count: 1 }] });
    let accepted = 0;
    let refused = 0;
    await withServer(async (base) => {
      // The limiter's in-memory bucket is shared across this file's earlier
      // turns, so send enough to be sure it trips, then compare the counts.
      for (let i = 0; i < 35; i += 1) {
        const res = await post(base, URL_PATH, { message: 'hi' });
        if (res.status === 429) refused += 1; else accepted += 1;
      }
    });
    expect(refused).toBeGreaterThan(0);
    expect(mockRaw).toHaveBeenCalledTimes(accepted);
    expect(mockProcess).toHaveBeenCalledTimes(accepted);
  });
});

describe('migration', () => {
  test('creates public_llm_daily_usage with a (bucket, day) primary key and drops it on down', async () => {
    const m = require('../models/migrations/20261024210000_public_llm_daily_usage');
    const t = { text: jest.fn(), date: jest.fn(), integer: jest.fn(), timestamp: jest.fn(), primary: jest.fn() };
    for (const k of ['text', 'date', 'integer', 'timestamp']) {
      const chain = { notNullable: jest.fn(() => chain), defaultTo: jest.fn(() => chain) };
      t[k].mockReturnValue(chain);
    }
    const knex = {
      fn: { now: jest.fn(() => 'now()') },
      schema: {
        hasTable: jest.fn(async () => false),
        createTable: jest.fn(async (name, cb) => cb(t)),
        dropTableIfExists: jest.fn(async () => {}),
      },
    };
    await m.up(knex);
    expect(knex.schema.createTable).toHaveBeenCalledWith('public_llm_daily_usage', expect.any(Function));
    expect(t.primary).toHaveBeenCalledWith(['bucket', 'day']);
    await m.down(knex);
    expect(knex.schema.dropTableIfExists).toHaveBeenCalledWith('public_llm_daily_usage');
  });
});

describe('feature gate reader', () => {
  test('strict opt-in', () => {
    const { publicLlmSharedCapLive } = jest.requireActual('../config/feature-gates');
    delete process.env.GATE_PUBLIC_LLM_SHARED_CAP;
    expect(publicLlmSharedCapLive()).toBe(false);
    process.env.GATE_PUBLIC_LLM_SHARED_CAP = 'TRUE';
    expect(publicLlmSharedCapLive()).toBe(false);
    process.env.GATE_PUBLIC_LLM_SHARED_CAP = 'true';
    expect(publicLlmSharedCapLive()).toBe(true);
    delete process.env.GATE_PUBLIC_LLM_SHARED_CAP;
  });
});
