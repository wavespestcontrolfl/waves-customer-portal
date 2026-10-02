jest.mock('../models/db', () => {
  const query = { where: jest.fn().mockReturnThis(), first: jest.fn(async () => null), insert: jest.fn(async () => []), update: jest.fn(async () => 1), whereNotIn: jest.fn().mockReturnThis(), del: jest.fn(async () => 0) };
  const db = jest.fn(() => query); db._query = query; db.fn = { now: () => new Date() }; db.raw = jest.fn();
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const TokenHealthService = require('../services/token-health');
const MODELS = require('../config/models');
const { WORKERS_AI_ACCOUNTS_API } = require('../services/llm/call');

describe('token-health: cloudflare_workers_ai', () => {
  const env = process.env;
  beforeEach(() => {
    process.env = { ...env };
    delete process.env.CF_WORKERS_AI_TOKEN; delete process.env.CF_API_TOKEN; delete process.env.CF_ACCOUNT_ID;
    global.fetch = jest.fn();
  });
  afterAll(() => { process.env = env; });

  test('is a known platform; no token or no account reads not_configured without a request', async () => {
    expect(await TokenHealthService.checkSingle('cloudflare_workers_ai')).toMatchObject({ platform: 'cloudflare_workers_ai', status: 'not_configured' });
    process.env.CF_API_TOKEN = 'zone';
    expect(await TokenHealthService.checkSingle('cloudflare_workers_ai')).toMatchObject({ status: 'not_configured', lastError: 'CF_ACCOUNT_ID not set' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('probes the run endpoint for the configured model and reads a successful envelope as healthy', async () => {
    process.env.CF_WORKERS_AI_TOKEN = 'wai'; process.env.CF_ACCOUNT_ID = 'acct123';
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, result: { model: 'clef-flash', answers: { ok: { type: 'noul', noul: 0.99 } } } }) });
    const r = await TokenHealthService.checkSingle('cloudflare_workers_ai');
    expect(r.status).toBe('healthy');
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe(`${WORKERS_AI_ACCOUNTS_API}/acct123/ai/run/@cf/cloudflare/${MODELS.CLOUDFLARE_CLEF}`);
    expect(init.headers.Authorization).toBe('Bearer wai');
    expect(Object.keys(JSON.parse(init.body)).sort()).toEqual(['questions', 'state']);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test('the dedicated token wins; CF_API_TOKEN is the fallback', async () => {
    process.env.CF_API_TOKEN = 'zone'; process.env.CF_ACCOUNT_ID = 'acct123';
    global.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, result: {} }) });
    await TokenHealthService.checkSingle('cloudflare_workers_ai');
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer zone');
    process.env.CF_WORKERS_AI_TOKEN = 'wai';
    await TokenHealthService.checkSingle('cloudflare_workers_ai');
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer wai');
  });

  test('401/403 read as expired with the provider message, 500 and an unsuccessful 200 as error, 429 as healthy', async () => {
    process.env.CF_WORKERS_AI_TOKEN = 'wai'; process.env.CF_ACCOUNT_ID = 'acct123';
    global.fetch.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ success: false, errors: [{ message: 'Authentication error' }] }) });
    expect(await TokenHealthService.checkSingle('cloudflare_workers_ai')).toMatchObject({ status: 'expired', lastError: 'Authentication error' });
    global.fetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    expect(await TokenHealthService.checkSingle('cloudflare_workers_ai')).toMatchObject({ status: 'error', lastError: 'HTTP 500' });
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: false, errors: [{ message: 'model unavailable' }] }) });
    expect(await TokenHealthService.checkSingle('cloudflare_workers_ai')).toMatchObject({ status: 'error', lastError: 'model unavailable' });
    global.fetch.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) });
    expect(await TokenHealthService.checkSingle('cloudflare_workers_ai')).toMatchObject({ status: 'healthy' });
  });

  test('a MODEL_CLOUDFLARE_CLEF the catalog does not register is an error before any request', async () => {
    jest.resetModules();
    process.env.CF_WORKERS_AI_TOKEN = 'wai'; process.env.CF_ACCOUNT_ID = 'acct123';
    process.env.MODEL_CLOUDFLARE_CLEF = 'clef-latest';
    const svc = require('../services/token-health');
    const r = await svc.checkSingle('cloudflare_workers_ai');
    expect(r).toMatchObject({ platform: 'cloudflare_workers_ai', status: 'error' });
    expect(r.lastError).toMatch(/registered Cloudflare decision model/);
    expect(global.fetch).not.toHaveBeenCalled();
    delete process.env.MODEL_CLOUDFLARE_CLEF;
    jest.resetModules();
  });
});
