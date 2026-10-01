jest.mock('../models/db', () => {
  const query = { where: jest.fn().mockReturnThis(), first: jest.fn(async () => null), insert: jest.fn(async () => []), update: jest.fn(async () => 1), whereNotIn: jest.fn().mockReturnThis(), del: jest.fn(async () => 0) };
  const db = jest.fn(() => query); db._query = query; db.fn = { now: () => new Date() }; db.raw = jest.fn();
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const TokenHealthService = require('../services/token-health');
const MODELS = require('../config/models');
const { TYPESAFE_SYSTEMONE_API } = require('../services/llm/call');

describe('token-health: typesafe', () => {
  const env = process.env;
  beforeEach(() => { process.env = { ...env }; global.fetch = jest.fn(); });
  afterAll(() => { process.env = env; });

  test('is a known platform the dispatcher routes', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const r = await TokenHealthService.checkSingle('typesafe');
    expect(r).toMatchObject({ platform: 'typesafe', status: 'not_configured' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
  test('probes the SystemOne endpoint with the pinned model and reads 200 as healthy', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ answers: { ok: { type: 'noul', noul: 0.99 } } }) });
    const r = await TokenHealthService.checkSingle('typesafe');
    expect(r.status).toBe('healthy');
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe(TYPESAFE_SYSTEMONE_API);
    expect(init.headers.Authorization).toBe('Bearer k');
    expect(JSON.parse(init.body).model).toBe(MODELS.TYPESAFE_JEV);
  });
  test('401 reads as expired, 500 as error, 429 as healthy (key works, service busy)', async () => {
    process.env.TYPESAFE_API_KEY = 'k';
    global.fetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }) });
    expect(await TokenHealthService.checkSingle('typesafe')).toMatchObject({ status: 'expired', lastError: 'bad key' });
    global.fetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    expect(await TokenHealthService.checkSingle('typesafe')).toMatchObject({ status: 'error', lastError: 'HTTP 500' });
    global.fetch.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) });
    expect(await TokenHealthService.checkSingle('typesafe')).toMatchObject({ status: 'healthy' });
  });
});
