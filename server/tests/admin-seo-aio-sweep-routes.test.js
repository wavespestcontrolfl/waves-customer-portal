// AI Overview gap sweep admin routes: input validation (400), conflict (409), uuid checks, wiring.
const mockSweep = {
  startSweep: jest.fn(),
  listRuns: jest.fn(),
  rankGaps: jest.fn(),
  cancelSweep: jest.fn(),
};
jest.mock('../services/seo/aio-gap-sweep', () => mockSweep);
jest.mock('../models/db', () => {
  const db = jest.fn(() => ({}));
  db.fn = { now: () => 'now' };
  db.raw = (...a) => ({ raw: a });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: (_q, _s, n) => n(), requireAdmin: (_q, _s, n) => n(), requireTechOrAdmin: (_q, _s, n) => n() }));
for (const m of ['search-console-v2', 'seo-advisor', 'rank-tracker', 'serp-analyzer', 'backlink-monitor', 'gsc-links-importer', 'ai-overview-tracker', 'content-qa', 'cannibalization', 'content-decay', 'refresh-audit', 'citation-auditor', 'conversion-funnel', 'site-rollup', 'geo-grid-tracker', 'site-auditor']) {
  jest.mock(`../services/seo/${m}`, () => ({}));
}
jest.mock('../services/csv-generators', () => ({ geoGridToCSV: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: () => false }));

const express = require('express');
const router = require('../routes/admin-seo-v2');

const RUN_ID = '3f2c8a52-1b7e-4c4f-9d11-0a6f5b3c2e10';

function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use(router);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
          method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
        });
        resolve({ status: res.status, body: await res.json() });
      } catch (err) { reject(err); } finally { server.close(); }
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSweep.startSweep.mockResolvedValue({ run: { id: RUN_ID }, planned: 3, sourceCounts: { total: 3 } });
});

describe('POST /aio-sweep', () => {
  test('starts a manual run with the defaults when the body is empty', async () => {
    const res = await call('POST', '/aio-sweep', {});
    expect(res.status).toBe(201);
    expect(mockSweep.startSweep).toHaveBeenCalledWith({ trigger: 'manual' });
    expect(res.body.run.id).toBe(RUN_ID);
  });

  test('passes valid maxCostUsd, minImpressions and max through', async () => {
    const res = await call('POST', '/aio-sweep', { maxCostUsd: 25, minImpressions: 10, max: 5000 });
    expect(res.status).toBe(201);
    expect(mockSweep.startSweep).toHaveBeenCalledWith({ trigger: 'manual', maxCostUsd: 25, minImpressions: 10, max: 5000 });
  });

  test.each([
    [{ maxCostUsd: 25.01 }],
    [{ maxCostUsd: 0 }],
    [{ maxCostUsd: -1 }],
    [{ maxCostUsd: 'lots' }],
    [{ maxCostUsd: true }],
    [{ minImpressions: -1 }],
    [{ minImpressions: 0 }],
    [{ maxCostUsd: 0.006 }],
    [{ maxCostUsd: 2.345 }],
    [{ minImpressions: 1.5 }],
    [{ minImpressions: 'x' }],
    [{ max: 5001 }],
    [{ max: 0 }],
    [{ max: 10.5 }],
    [{ max: 'all' }],
  ])('400 on %j and no sweep starts', async (body) => {
    const res = await call('POST', '/aio-sweep', body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(mockSweep.startSweep).not.toHaveBeenCalled();
  });

  test('409 when a run is already open', async () => {
    mockSweep.startSweep.mockRejectedValue(Object.assign(new Error('An AI Overview sweep is already open'), { code: 'AIO_SWEEP_OPEN' }));
    const res = await call('POST', '/aio-sweep', {});
    expect(res.status).toBe(409);
  });
});

describe('GET /aio-sweep/runs', () => {
  test('returns the last 20 runs', async () => {
    mockSweep.listRuns.mockResolvedValue([{ id: RUN_ID, counts: { shown: 2 } }]);
    const res = await call('GET', '/aio-sweep/runs');
    expect(res.status).toBe(200);
    expect(mockSweep.listRuns).toHaveBeenCalledWith({ limit: 20 });
    expect(res.body.runs[0].counts).toEqual({ shown: 2 });
  });
});

describe('GET /aio-sweep/:runId/gaps', () => {
  test('400 on a non-uuid run id', async () => {
    const res = await call('GET', '/aio-sweep/not-a-uuid/gaps');
    expect(res.status).toBe(400);
    expect(mockSweep.rankGaps).not.toHaveBeenCalled();
  });

  test('ranks gaps with a clamped limit', async () => {
    mockSweep.rankGaps.mockResolvedValue({ run: { id: RUN_ID }, summary: {}, gaps: [] });
    expect((await call('GET', `/aio-sweep/${RUN_ID}/gaps?limit=5`)).status).toBe(200);
    expect(mockSweep.rankGaps).toHaveBeenLastCalledWith(RUN_ID, { limit: 5 });
    await call('GET', `/aio-sweep/${RUN_ID}/gaps?limit=99999`);
    expect(mockSweep.rankGaps).toHaveBeenLastCalledWith(RUN_ID, { limit: 1000 });
    await call('GET', `/aio-sweep/${RUN_ID}/gaps`);
    expect(mockSweep.rankGaps).toHaveBeenLastCalledWith(RUN_ID, { limit: 200 });
  });
});

describe('POST /aio-sweep/:runId/cancel', () => {
  test('400 on a non-uuid run id', async () => {
    expect((await call('POST', '/aio-sweep/nope/cancel')).status).toBe(400);
    expect(mockSweep.cancelSweep).not.toHaveBeenCalled();
  });

  test('cancels an open run; 404 when none is open', async () => {
    mockSweep.cancelSweep.mockResolvedValueOnce({ id: RUN_ID, status: 'cancelled' });
    const ok = await call('POST', `/aio-sweep/${RUN_ID}/cancel`);
    expect(ok.status).toBe(200);
    expect(ok.body.run.status).toBe('cancelled');
    mockSweep.cancelSweep.mockResolvedValueOnce(null);
    expect((await call('POST', `/aio-sweep/${RUN_ID}/cancel`)).status).toBe(404);
  });
});
