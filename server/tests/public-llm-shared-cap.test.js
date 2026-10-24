// Shared daily cap for the public paid-LLM routes (GATE_PUBLIC_LLM_SHARED_CAP,
// security audit run 2 #13). Pins: gate off makes no DB call; gate on counts
// with one atomic upsert keyed by the Eastern calendar day, 429s with the
// per-IP limiter's message once over the cap, honors the same skip predicate,
// fails open on a DB error, and reads the cap from the env var.
jest.mock('../models/db', () => ({ raw: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const { sharedDailyCap, resolveMax } = require('../middleware/public-llm-shared-cap');
const { publicLlmSharedCapLive } = require('../config/feature-gates');
const { isPlausibleMessageBody } = require('../routes/public-ai-intake');

const MESSAGE = { error: 'Daily limit reached — call (941) 297-5749 and a real person will help right away.' };

// Same shape as the index.js skip predicate for Ask Waves (NODE_ENV leg
// omitted: jest runs as 'test').
const askSkip = (req) => req.method !== 'POST'
  || !/^\/message\/?$/.test(req.path)
  || !isPlausibleMessageBody(req.body);

function makeMw(overrides = {}) {
  return sharedDailyCap({
    bucket: 'ask-waves',
    envVar: 'PUBLIC_LLM_DAILY_CAP_ASK_WAVES',
    defaultMax: 3,
    message: MESSAGE,
    skip: askSkip,
    ...overrides,
  });
}

function goodReq(extra = {}) {
  return { method: 'POST', path: '/message', body: { message: 'Do you treat for ants?' }, ...extra };
}

function run(mw, req) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const next = jest.fn();
  return mw(req, res, next).then(() => ({ res, next }));
}

function countIs(n) {
  db.raw.mockResolvedValueOnce({ rows: [{ count: n }] });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.raw.mockReset();
  delete process.env.GATE_PUBLIC_LLM_SHARED_CAP;
  delete process.env.PUBLIC_LLM_DAILY_CAP_ASK_WAVES;
  jest.useRealTimers();
});

afterAll(() => {
  delete process.env.GATE_PUBLIC_LLM_SHARED_CAP;
  delete process.env.PUBLIC_LLM_DAILY_CAP_ASK_WAVES;
});

describe('publicLlmSharedCapLive', () => {
  test('strict opt-in', () => {
    expect(publicLlmSharedCapLive()).toBe(false);
    process.env.GATE_PUBLIC_LLM_SHARED_CAP = 'TRUE';
    expect(publicLlmSharedCapLive()).toBe(false);
    process.env.GATE_PUBLIC_LLM_SHARED_CAP = '1';
    expect(publicLlmSharedCapLive()).toBe(false);
    process.env.GATE_PUBLIC_LLM_SHARED_CAP = 'true';
    expect(publicLlmSharedCapLive()).toBe(true);
  });
});

describe('gate off', () => {
  test('calls next() with no DB call and does not even evaluate skip', async () => {
    const skip = jest.fn(() => false);
    const { res, next } = await run(makeMw({ skip }), goodReq());
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(db.raw).not.toHaveBeenCalled();
    expect(skip).not.toHaveBeenCalled();
  });
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_PUBLIC_LLM_SHARED_CAP = 'true'; });

  test('counts a request with one upsert and passes while at or under the cap', async () => {
    countIs(1);
    const first = await run(makeMw(), goodReq());
    expect(first.next).toHaveBeenCalledTimes(1);
    countIs(3);
    const atCap = await run(makeMw(), goodReq());
    expect(atCap.next).toHaveBeenCalledTimes(1);
    expect(atCap.res.status).not.toHaveBeenCalled();

    expect(db.raw).toHaveBeenCalledTimes(2);
    const [sql, bindings] = db.raw.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO public_llm_daily_usage/);
    expect(sql).toMatch(/ON CONFLICT \(bucket, day\)\s+DO UPDATE SET count = public_llm_daily_usage\.count \+ 1, updated_at = now\(\)/);
    expect(sql).toMatch(/RETURNING count/);
    expect(bindings[0]).toBe('ask-waves');
    expect(bindings[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('429s with the per-IP limiter message once over the cap, and does not call next', async () => {
    countIs(4);
    const { res, next } = await run(makeMw(), goodReq());
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(MESSAGE);
    expect(next).not.toHaveBeenCalled();
  });

  test('skips what the per-IP limiter skips: GET, wrong path, implausible body (no DB call)', async () => {
    const cases = [
      goodReq({ method: 'GET' }),
      goodReq({ path: '/status' }),
      goodReq({ body: {} }),
      goodReq({ body: { message: '' } }),
      goodReq({ body: undefined }),
    ];
    for (const req of cases) {
      const { res, next } = await run(makeMw(), req);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }
    expect(db.raw).not.toHaveBeenCalled();
  });

  test('fails open on a DB error and warns at most once a minute', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-24T15:00:00Z'));
    db.raw.mockRejectedValue(new Error('connection refused'));
    // The module-level throttle may hold a stamp from an earlier test; move past it.
    const a = await run(makeMw(), goodReq());
    expect(a.next).toHaveBeenCalledTimes(1);
    expect(a.res.status).not.toHaveBeenCalled();
    const warnsAfterFirst = logger.warn.mock.calls.length;
    expect(warnsAfterFirst).toBeLessThanOrEqual(1);

    const b = await run(makeMw(), goodReq());
    expect(b.next).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls.length).toBe(warnsAfterFirst);

    jest.setSystemTime(new Date('2026-10-24T15:02:00Z'));
    const c = await run(makeMw(), goodReq());
    expect(c.next).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls.length).toBe(warnsAfterFirst + 1);
    expect(logger.warn.mock.calls[logger.warn.mock.calls.length - 1][0]).toMatch(/failing open/);
  });

  test('fails open when the counter returns no row', async () => {
    db.raw.mockResolvedValueOnce({ rows: [] });
    const { res, next } = await run(makeMw(), goodReq());
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('env var overrides the default cap (read per request)', async () => {
    process.env.PUBLIC_LLM_DAILY_CAP_ASK_WAVES = '10';
    countIs(10);
    const ok = await run(makeMw(), goodReq());
    expect(ok.next).toHaveBeenCalledTimes(1);
    countIs(11);
    const over = await run(makeMw(), goodReq());
    expect(over.res.status).toHaveBeenCalledWith(429);
  });

  test('an invalid env value falls back to the default', async () => {
    process.env.PUBLIC_LLM_DAILY_CAP_ASK_WAVES = 'lots';
    countIs(4);
    const over = await run(makeMw(), goodReq());
    expect(over.res.status).toHaveBeenCalledWith(429);
  });

  test('day key is the America/New_York calendar date, not UTC', async () => {
    // 2026-10-25 02:30Z is still 2026-10-24 22:30 in New York (EDT).
    jest.useFakeTimers().setSystemTime(new Date('2026-10-25T02:30:00Z'));
    countIs(1);
    await run(makeMw(), goodReq());
    expect(db.raw.mock.calls[0][1][1]).toBe('2026-10-24');

    // 2026-10-25 04:30Z is 00:30 on the 25th in New York.
    jest.setSystemTime(new Date('2026-10-25T04:30:00Z'));
    countIs(1);
    await run(makeMw(), goodReq());
    expect(db.raw.mock.calls[1][1][1]).toBe('2026-10-25');
  });

  test('buckets are separate: the bucket name goes to the upsert', async () => {
    countIs(1);
    await run(makeMw({ bucket: 'photo-assessment' }), goodReq());
    expect(db.raw.mock.calls[0][1][0]).toBe('photo-assessment');
  });
});

describe('resolveMax', () => {
  test('positive integer from env, else default', () => {
    process.env.TEST_CAP_X = '25';
    expect(resolveMax('TEST_CAP_X', 7)).toBe(25);
    process.env.TEST_CAP_X = '0';
    expect(resolveMax('TEST_CAP_X', 7)).toBe(7);
    process.env.TEST_CAP_X = '-3';
    expect(resolveMax('TEST_CAP_X', 7)).toBe(7);
    process.env.TEST_CAP_X = '2.5';
    expect(resolveMax('TEST_CAP_X', 7)).toBe(7);
    delete process.env.TEST_CAP_X;
    expect(resolveMax('TEST_CAP_X', 7)).toBe(7);
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

describe('index.js wiring (source pin)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');

  test('each shared cap reuses the per-IP limiter skip predicate', () => {
    expect(src).toMatch(/skip: askWavesDailySkip,\n\}\);\n[\s\S]*?bucket: 'ask-waves'[\s\S]*?skip: askWavesDailySkip/);
    expect(src).toMatch(/skip: photoAssessmentDailySkip,\n\}\);\n[\s\S]*?bucket: 'photo-assessment'[\s\S]*?skip: photoAssessmentDailySkip/);
  });

  test('per-IP limiter is mounted before the shared cap on all three routes', () => {
    expect(src).toContain("'/api/public/ai-intake', askWavesDailyLimiter, askWavesSharedCap,");
    expect(src).toContain("'/api/public/lawn-assessment', photoAssessmentDailyLimiter, photoAssessmentSharedCap,");
    expect(src).toContain("'/api/public/pest-identifier', photoAssessmentDailyLimiter, photoAssessmentSharedCap,");
  });
});
