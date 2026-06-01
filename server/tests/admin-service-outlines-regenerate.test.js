jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((...args) => mock(...args));
    trx.fn = mock.fn;
    return fn(trx);
  });
  return mock;
});

jest.mock('../services/lawn-service-outline', () => ({
  CONTENT_LIBRARY_VERSION: 'content-v1',
  PRODUCT_REGISTRY_VERSION: 'products-v1',
  PROTOCOL_VERSION: 'protocol-v1',
  TEMPLATE_VERSION: 'template-v1',
  buildOutline: jest.fn(),
  createPublicToken: jest.fn(() => 'abcdefghijklmnopqrstuvwxyzABCDEFGHI'),
  hashToken: jest.fn((token) => `hash:${token}`),
}));

jest.mock('../services/logger', () => ({
  error: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const { buildOutline } = require('../services/lawn-service-outline');
const adminServiceOutlines = require('../routes/admin-service-outlines');

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    first: jest.fn(),
    update: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    returning: jest.fn(),
    ...overrides,
  };
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/service-outlines', adminServiceOutlines);
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

function outlineForInput(input) {
  const productCards = input.includeProductCards ? [{
    id: 'product-1',
    labelVersion: 'v1',
    relevanceReason: 'Used in the existing outline',
  }] : [];
  return {
    meta: {
      turf: { turfType: input.turfType || 'st_augustine', confidence: 'high', mixed: false },
      jurisdictionRule: { jurisdiction_id: input.jurisdictionId || 'sarasota', version: 'rule-v1' },
    },
    content: {
      title: 'Your Waves Lawn Care Program Overview',
      productCards,
    },
    contentHtml: '<p>outline</p>',
    summary: {},
    validation: { status: 'passed', errors: [], warnings: [] },
    estimateSnapshot: { tier: input.serviceTier || 'standard' },
    inputSnapshot: {
      ...input,
      month: input.month || 5,
      seasonBand: 'spring',
      jurisdictionId: input.jurisdictionId || 'sarasota',
    },
  };
}

function setupRegenerate({ requestBody = {} } = {}) {
  const sourcePacket = {
    id: 'packet-1',
    estimate_id: 'estimate-1',
    customer_id: 'customer-1',
    lead_id: null,
    status: 'approved',
    turf_type: 'st_augustine',
    service_tier: 'standard',
    month: 5,
    jurisdiction_id: 'sarasota',
    content_json: {
      productCards: [{ id: 'product-1' }],
    },
    input_snapshot_json: {
      detailLevel: 'standard',
      includeProductCards: true,
      serviceTier: 'standard',
      month: 5,
      jurisdictionId: 'sarasota',
      customerNote: 'Keep this note',
    },
    content_library_version: 'old-content',
    protocol_version: 'old-protocol',
    product_registry_version: 'old-products',
    revoked_at: null,
  };
  const insertedPacket = {
    id: 'packet-2',
    estimate_id: 'estimate-1',
    customer_id: 'customer-1',
    status: 'approved',
    title: 'Your Waves Lawn Care Program Overview',
    content_json: {},
    summary_json: {},
    validation_errors_json: [],
    admin_warnings_json: [],
  };
  const packetQuery = chain({
    first: jest.fn().mockResolvedValue(sourcePacket),
    returning: jest.fn()
      .mockResolvedValueOnce([{ ...sourcePacket, status: 'revoked', revoked_at: 'NOW' }])
      .mockResolvedValueOnce([insertedPacket]),
  });
  const estimateQuery = chain({
    first: jest.fn().mockResolvedValue({
      id: 'estimate-1',
      customer_id: 'customer-1',
      lead_id: null,
    }),
  });

  db.mockImplementation((table) => {
    if (table === 'service_outline_packets') return packetQuery;
    if (table === 'estimates') return estimateQuery;
    return chain({ insert: jest.fn().mockResolvedValue(1) });
  });
  buildOutline.mockImplementation(async ({ input }) => outlineForInput(input));

  return { packetQuery, requestBody };
}

describe('admin service outline regeneration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('preserves product cards when regenerate omits includeProductCards', async () => {
    setupRegenerate();

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/service-outlines/packet-1/regenerate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
    });

    expect(buildOutline).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        includeProductCards: true,
        customerNote: 'Keep this note',
      }),
    }));
  });

  test('allows regenerate to explicitly disable product cards', async () => {
    setupRegenerate();

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/service-outlines/packet-1/regenerate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ includeProductCards: false }),
      });
      expect(res.status).toBe(201);
    });

    expect(buildOutline).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        includeProductCards: false,
      }),
    }));
  });
});
