jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
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
  loadHistoryForCustomer: jest.fn().mockResolvedValue([]),
}));

const express = require('express');
const db = require('../models/db');
const reportsRouter = require('../routes/reports-public');

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    first: jest.fn(),
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

describe('POST /reports/:token/events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('allows lawn report outline linkage telemetry', async () => {
    const serviceRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'service-1',
        customer_id: 'customer-1',
        report_template_version: 'service_report_v1',
      }),
    });
    const eventInsert = chain();
    db.mockImplementation((table) => {
      if (table === 'service_records') return serviceRead;
      if (table === 'service_report_events') return eventInsert;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventName: 'service_report_linked_to_outline',
          metadata: { packetId: 'packet-1', packetStatus: 'viewed' },
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ ok: true });
      expect(eventInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
        service_record_id: 'service-1',
        customer_id: 'customer-1',
        event_name: 'service_report_linked_to_outline',
        channel: 'public_report',
        metadata: JSON.stringify({ packetId: 'packet-1', packetStatus: 'viewed' }),
      }));
    });
  });

  test('a whitespace-padded cross_sell_requested still hits the low action limiter (PR r11 P1)', async () => {
    // The handler TRIMS the event name before matching, so the limiter's
    // skip() must trim identically — comparing the raw body value let
    // `' cross_sell_requested '` bypass the 5/min action limiter and drive
    // the full pricing recomputation + durable writes at the 120/min
    // analytics rate. The gate is off here, so every admitted request stops
    // at the handler's 400; the 6th must be the limiter's 429 instead.
    const serviceRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'service-2',
        customer_id: 'customer-2',
        report_template_version: 'service_report_v1',
      }),
    });
    db.mockImplementation((table) => {
      if (table === 'service_records') return serviceRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    // Own token: the limiter keys per token, so this cannot bleed into
    // (or inherit from) any other test's budget.
    const token = 'ffffffffffffffff0123456789abcdef';
    await withServer(async (baseUrl) => {
      const post = () => fetch(`${baseUrl}/reports/${token}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventName: '  cross_sell_requested  ' }),
      });
      const statuses = [];
      for (let i = 0; i < 6; i += 1) {
        statuses.push((await post()).status);
      }
      // Five admitted (rejected by the dark gate as an unknown event), then
      // the limiter takes over.
      expect(statuses.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
      expect(statuses[5]).toBe(429);
    });
  });
});

describe('storedRevisionMatches (cross-sell resubmit no-op, PR r11 P2)', () => {
  const { storedRevisionMatches } = reportsRouter;
  const snapshot = {
    source: 'service_report',
    serviceRecordId: 'sr-1',
    crossSell: { serviceKey: 'lawn_care', mode: 'priced', option: { id: 'quarterly', perVisit: 114 } },
  };

  test('a JSONB round-trip with reordered keys is still the same snapshot', () => {
    // What node-postgres hands back for a jsonb column: an object in
    // PostgreSQL's canonical key order, not the insertion order.
    const roundTripped = {
      crossSell: { mode: 'priced', option: { perVisit: 114, id: 'quarterly' }, serviceKey: 'lawn_care' },
      serviceRecordId: 'sr-1',
      source: 'service_report',
    };
    expect(JSON.stringify(roundTripped)).not.toBe(JSON.stringify(snapshot));
    expect(storedRevisionMatches(roundTripped, snapshot)).toBe(true);
  });

  test('a string column value is parsed before comparing, in either key order', () => {
    expect(storedRevisionMatches(JSON.stringify(snapshot), snapshot)).toBe(true);
    expect(storedRevisionMatches(
      '{"serviceRecordId":"sr-1","source":"service_report","crossSell":{"option":{"perVisit":114,"id":"quarterly"},"mode":"priced","serviceKey":"lawn_care"}}',
      snapshot,
    )).toBe(true);
  });

  test('a genuinely different offer, an unparsable value, and an absent value never match', () => {
    const moved = { ...snapshot, crossSell: { ...snapshot.crossSell, option: { id: 'quarterly', perVisit: 129 } } };
    expect(storedRevisionMatches(moved, snapshot)).toBe(false);
    // Different service entirely.
    expect(storedRevisionMatches({ ...snapshot, crossSell: { ...snapshot.crossSell, serviceKey: 'tree_shrub' } }, snapshot)).toBe(false);
    // Garbage or NULL falls through to the refresh path rather than
    // falsely confirming a stale row.
    expect(storedRevisionMatches('not json', snapshot)).toBe(false);
    expect(storedRevisionMatches(null, snapshot)).toBe(false);
    expect(storedRevisionMatches(undefined, snapshot)).toBe(false);
  });
});
