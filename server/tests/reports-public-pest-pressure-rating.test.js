jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  // db.transaction(fn) runs fn(trx) where trx is a Knex-like callable
  // that mirrors db's mock behavior. Each table call returns a fresh
  // chain (same shape as mock()) so tests can assert against
  // chain.update / chain.where independently from non-trx calls.
  mock.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((...args) => mock(...args));
    trx.fn = mock.fn;
    return fn(trx);
  });
  return mock;
});
jest.mock('../config', () => ({
  s3: { bucket: 'test-bucket', region: 'us-east-1' },
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({})),
  GetObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));
jest.mock('../services/pest-pressure/orchestrate', () => ({
  runAndSwallowErrors: jest.fn().mockResolvedValue(null),
  calculateAndPersistForServiceRecord: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/pest-pressure/store', () => ({
  loadActiveConfig: jest.fn(),
  loadScoreForServiceRecord: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const {
  runAndSwallowErrors,
  calculateAndPersistForServiceRecord,
} = require('../services/pest-pressure/orchestrate');
const { loadActiveConfig, loadScoreForServiceRecord } = require('../services/pest-pressure/store');
const { DEFAULT_CONFIG } = require('../services/pest-pressure/config');
const reportsRouter = require('../routes/reports-public');

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    first: jest.fn(),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockResolvedValue(1),
    ...overrides,
  };
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/reports', reportsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const VALID_TOKEN = '0123456789abcdef0123456789abcdef';

describe('POST /reports/:token/pest-pressure/client-rating', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    loadActiveConfig.mockResolvedValue({ ...DEFAULT_CONFIG });
  });

  test('404 for malformed token', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/not-a-real-token/pest-pressure/client-rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: 2 }),
      });
      expect(res.status).toBe(404);
    });
  });

  test('400 for out-of-range rating', async () => {
    db.mockImplementation(() => chain({ first: jest.fn().mockResolvedValue(null) }));
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/pest-pressure/client-rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: 7 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('rating_out_of_range');
    });
  });

  test('400 for non-numeric rating', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/pest-pressure/client-rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: 'high' }),
      });
      expect(res.status).toBe(400);
    });
  });

  test('404 when the report is not v1', async () => {
    db.mockImplementation(() => chain({
      first: jest.fn().mockResolvedValue({ id: 'svc-1', report_template_version: 'legacy' }),
    }));
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/pest-pressure/client-rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: 2 }),
      });
      expect(res.status).toBe(404);
    });
  });

  test('404 when feature is disabled in config', async () => {
    loadActiveConfig.mockResolvedValueOnce({ ...DEFAULT_CONFIG, enabled: false });
    db.mockImplementation(() => chain({
      first: jest.fn().mockResolvedValue({ id: 'svc-1', report_template_version: 'service_report_v1', client_pest_rating: null }),
    }));
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/pest-pressure/client-rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: 2 }),
      });
      expect(res.status).toBe(404);
    });
  });

  test('409 when a rating has already been submitted', async () => {
    db.mockImplementation(() => chain({
      first: jest.fn().mockResolvedValue({
        id: 'svc-1', report_template_version: 'service_report_v1',
        client_pest_rating: 3,
      }),
    }));
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/pest-pressure/client-rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: 4 }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('rating_already_submitted');
      expect(calculateAndPersistForServiceRecord).not.toHaveBeenCalled();
    });
  });

  test('happy path: writes rating, runs orchestrator, returns updated pestPressure', async () => {
    const initialServiceRow = {
      id: 'svc-1',
      customer_id: 'cust-1',
      service_type: 'Quarterly Pest Control',
      service_line: 'pest',
      service_date: '2026-05-17',
      status: 'completed',
      report_template_version: 'service_report_v1',
      client_pest_rating: null,
    };
    const updatedServiceRow = {
      id: 'svc-1',
      customer_id: 'cust-1',
      service_type: 'Quarterly Pest Control',
      client_pest_rating: 2,
    };
    const initialQuery = chain({ first: jest.fn().mockResolvedValue(initialServiceRow) });
    const updateQuery = chain({ update: jest.fn().mockResolvedValue(1) });
    const reloadQuery = chain({ first: jest.fn().mockResolvedValue(updatedServiceRow) });
    let call = 0;
    db.mockImplementation(() => {
      call += 1;
      if (call === 1) return initialQuery;
      if (call === 2) return updateQuery;
      return reloadQuery;
    });

    loadScoreForServiceRecord.mockResolvedValueOnce({
      service_record_id: 'svc-1',
      service_date: '2026-05-17',
      calculated_score: 1.6,
      displayed_score: 1.6,
      label_key: 'low',
      label_name: 'Low',
      trend: 'first_marker',
      trend_delta: null,
      data_completeness: 'complete',
      explanation: 'first marker copy',
      component_scores: { clientRating: { value: 2, weight: 25, present: true } },
      is_overridden: false,
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/pest-pressure/client-rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: 2 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.submittedRating).toBe(2);
      expect(body.pestPressure.score).toBe(1.6);
      expect(body.pestPressure.label).toBe('Low');
      expect(body.pestPressure.canCaptureClientRating).toBe(false);
      expect(body.pestPressure.submittedClientRating).toBe(2);

      expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({
        client_pest_rating: 2,
        client_pest_rating_source: 'customer',
      }));
      // Non-swallowing recalc now runs inside the transaction so a recalc
      // failure rolls back the rating UPDATE rather than silently leaving
      // the score stale with the rating burned.
      expect(calculateAndPersistForServiceRecord).toHaveBeenCalledWith('svc-1', expect.anything());
      expect(db.transaction).toHaveBeenCalled();
    });
  });

  test('400 for fractional rating (no silent rounding)', async () => {
    // One-shot write — fractional inputs like 2.7 must be rejected, not
    // rounded. Customer would otherwise burn their one rating on a value
    // they didn't intend to submit.
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/pest-pressure/client-rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: 2.7 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('rating_out_of_range');
    });
  });

  test('400 for malformed non-number bodies (null/empty/false)', async () => {
    // `Number(null)`, `Number('')`, `Number(false)` all coerce to 0
    // pre-validation — strict typeof + isInteger check rejects them.
    for (const bad of [null, '', false, '3', []]) {
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/pest-pressure/client-rating`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rating: bad }),
        });
        expect(res.status).toBe(400);
      });
    }
  });
});
