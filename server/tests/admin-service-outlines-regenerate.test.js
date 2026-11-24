jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
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
  ...jest.requireActual('../services/lawn-service-outline'),
  PRODUCT_REGISTRY_VERSION: 'products-v1',
  contentLibraryVersion: () => 'content-v1',
  protocolVersion: () => 'protocol-v1',
  TEMPLATE_VERSION: 'template-v1',
  buildOutline: jest.fn(),
  createPublicToken: jest.fn(() => 'abcdefghijklmnopqrstuvwxyzABCDEFGHI'),
  hashToken: jest.fn((token) => `hash:${token}`),
  regenerationTurfType: jest.fn((packet) => packet?.turf_type || packet?.input_snapshot_json?.turfType || null),
}));

jest.mock('../services/logger', () => ({
  error: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const { buildOutline, regenerationTurfType } = require('../services/lawn-service-outline');
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

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/service-outlines', adminServiceOutlines);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  let server;
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
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

function setupRegenerate({ requestBody = {}, source = {}, estimate = {} } = {}) {
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
    ...source,
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
      ...estimate,
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

  test('an older Sarasota packet for a North Port address keeps its link until staff resolve the jurisdiction', async () => {
    const { packetQuery } = setupRegenerate({
      source: { jurisdiction_id: 'sarasota_county_fl' },
      estimate: { address: '100 Test Way, North Port FL 34286', estimate_data: { county: 'Sarasota' } },
    });
    await withServer(async (baseUrl) => {
      const post = (body) => fetch(baseUrl + '/admin/service-outlines/packet-1/regenerate', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const conflict = await post({});
      expect({ status: conflict.status, body: await conflict.json() }).toMatchObject({
        status: 409, body: { code: 'outline_jurisdiction_confirmation_required' },
      });
      expect((await post({ jurisdictionId: null })).status).toBe(409);
      expect(db.transaction).not.toHaveBeenCalled();
      const confirmed = await post({ jurisdictionId: 'north_port_fl' });
      expect(confirmed.status).toBe(201);
      expect(packetQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
        jurisdiction_id: 'north_port_fl',
        input_snapshot_json: expect.objectContaining({ jurisdictionSource: 'staff' }),
      }));
    });
  });

  test('a concurrent revocation prevents the stale request from issuing another replacement', async () => {
    const { packetQuery } = setupRegenerate();
    packetQuery.returning.mockReset().mockResolvedValue([]);
    await withServer(async (baseUrl) => {
      const response = await fetch(baseUrl + '/admin/service-outlines/packet-1/regenerate', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(response.status).toBe(409);
    });
    expect(packetQuery.where).toHaveBeenCalledWith({ id: 'packet-1', revoked_at: null });
    expect(packetQuery.insert).not.toHaveBeenCalled();
  });

  test.each([['estimate', null], ['staff', 'sarasota_county_fl']])(
    'a packet with a recorded %s source restores the original jurisdiction input',
    async (jurisdictionSource, expected) => {
      setupRegenerate({
        source: { jurisdiction_id: 'sarasota_county_fl', input_snapshot_json: { jurisdictionSource } },
        estimate: { address: '100 Test Way, North Port, FL' },
      });
      await withServer(async (baseUrl) => {
        const res = await fetch(baseUrl + '/admin/service-outlines/packet-1/regenerate', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        });
        expect(res.status).toBe(201);
      });
      expect(buildOutline).toHaveBeenCalledWith(expect.objectContaining({
        input: expect.objectContaining({ jurisdictionId: expected, jurisdictionSource }),
      }));
    },
  );

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

  test('starts from the grass regenerationTurfType gives for the source packet, not its stored turf_type', async () => {
    setupRegenerate();
    regenerationTurfType.mockReturnValueOnce(null);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/service-outlines/packet-1/regenerate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(201);
    });

    expect(regenerationTurfType).toHaveBeenCalledWith(expect.objectContaining({ id: 'packet-1', turf_type: 'st_augustine' }));
    expect(buildOutline).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ turfType: null }),
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
