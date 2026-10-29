// The outline routes with a Pest Control outline, behind GATE_PEST_OUTLINE (owner 2026-10-26, decision D4-A). Synthetic
// rows: no database, no send.
//
// Pins: off = every Pest Control preview, save, regenerate and send answers 409 and nothing is built or sent; on = the
// Pest Control builder runs, the packet is stored as pest_control with the outline's own stamps, a regenerate keeps the
// program, and the text and email name the Pest Control program; the Tree & Shrub gate does not open it.

jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  mock.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((...args) => mock(...args));
    trx.fn = mock.fn;
    trx.raw = mock.raw;
    return fn(trx);
  });
  return mock;
});

jest.mock('../services/lawn-service-outline', () => ({
  PRODUCT_REGISTRY_VERSION: 'products-v1',
  contentLibraryVersion: () => 'content-v1',
  protocolVersion: () => 'protocol-v1',
  TEMPLATE_VERSION: 'template-v1',
  buildOutline: jest.fn(),
  createPublicToken: jest.fn(() => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'),
  hashToken: jest.fn((token) => `hash:${token}`),
  regenerationTurfType: jest.fn(() => null),
}));

jest.mock('../services/pest-service-outline', () => ({
  SERVICE_LINE: 'pest_control',
  buildPestOutline: jest.fn(),
  pestOutlineLive: jest.fn(() => true),
}));

jest.mock('../services/tree-shrub-service-outline', () => ({
  SERVICE_LINE: 'tree_shrub',
  buildTreeShrubOutline: jest.fn(),
  treeShrubOutlineLive: jest.fn(() => true),
}));

jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
}));

jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));

jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(async () => ({ messageId: 'sg-1' })),
}));

jest.mock('../services/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const { buildOutline } = require('../services/lawn-service-outline');
const { buildPestOutline, pestOutlineLive } = require('../services/pest-service-outline');
const { treeShrubOutlineLive } = require('../services/tree-shrub-service-outline');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const sendgrid = require('../services/sendgrid-mail');
const adminServiceOutlines = require('../routes/admin-service-outlines');

function chain(overrides = {}) {
  const c = {
    where: jest.fn().mockReturnThis(),
    whereIn: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    first: jest.fn(),
    update: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    returning: jest.fn(),
    then: (resolve) => resolve([]),
    ...overrides,
  };
  return c;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/service-outlines', adminServiceOutlines);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (baseUrl, path, body) => fetch(`${baseUrl}/admin/service-outlines${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const ESTIMATE = {
  id: 'estimate-1',
  customer_id: 'customer-1',
  lead_id: null,
  customer_phone: '+19415550123',
  customer_email: 'customer@example.com',
  customer_name: 'Ava',
};

function pestOutline(input) {
  return {
    meta: {
      serviceLine: 'pest_control',
      turf: { turfType: null, label: null, confidence: null, mixed: false },
      jurisdictionRule: { jurisdiction_id: 'sarasota_county_fl', version: 'rule-v1' },
      templateVersion: 'template-v1',
      contentLibraryVersion: 'pest-v1-copy-1',
      protocolVersion: null,
      productRegistryVersion: 'products-v1',
    },
    content: { title: 'Your Waves Pest Control Program Overview', productCards: [] },
    contentHtml: '<p>outline</p>',
    summary: { serviceLine: 'pest_control' },
    validation: { status: 'passed', errors: [], warnings: [] },
    estimateSnapshot: { tier: null },
    inputSnapshot: { ...input, month: 10, seasonBand: 'oct_dec', jurisdictionId: 'sarasota_county_fl' },
  };
}

function lawnOutline(input) {
  return {
    meta: {
      turf: { turfType: 'st_augustine', confidence: 'high', mixed: false },
      jurisdictionRule: { jurisdiction_id: 'sarasota_county_fl', version: 'rule-v1' },
    },
    content: { title: 'Your Waves Lawn Care Program Overview', productCards: [] },
    contentHtml: '<p>outline</p>',
    summary: {},
    validation: { status: 'passed', errors: [], warnings: [] },
    estimateSnapshot: { tier: null },
    inputSnapshot: { ...input, month: 10, seasonBand: 'oct_dec', jurisdictionId: 'sarasota_county_fl' },
  };
}

// The packet table answers the reads with `packet` and records each insert.
function setupDb({ packet = null, inserted = { id: 'packet-2', status: 'draft' } } = {}) {
  const inserts = [];
  const packetQuery = chain({
    first: jest.fn().mockResolvedValue(packet),
    insert: jest.fn((row) => {
      inserts.push(row);
      return packetQuery;
    }),
    returning: jest.fn(async () => [inserted]),
  });
  const estimateQuery = chain({ first: jest.fn().mockResolvedValue(ESTIMATE) });
  db.mockImplementation((table) => {
    if (table === 'service_outline_packets') return packetQuery;
    if (table === 'estimates') return estimateQuery;
    return chain({ insert: jest.fn().mockResolvedValue(1) });
  });
  return { inserts };
}

const PEST_PACKET = {
  id: 'packet-1',
  estimate_id: 'estimate-1',
  customer_id: 'customer-1',
  service_line: 'pest_control',
  status: 'approved',
  validation_status: 'passed',
  title: 'Your Waves Pest Control Program Overview',
  token_hash: 'old-token-hash',
  expires_at: null,
  revoked_at: null,
  input_snapshot_json: { serviceLine: 'pest_control', month: 10 },
  content_json: { productCards: [] },
};

describe('Pest Control outline routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pestOutlineLive.mockReturnValue(true);
    buildPestOutline.mockImplementation(async ({ input }) => pestOutline(input));
    buildOutline.mockImplementation(async ({ input }) => lawnOutline(input));
  });

  test('off: a Pest Control preview, save, regenerate and send are refused and nothing is built or sent (the Tree & Shrub gate does not open it)', async () => {
    pestOutlineLive.mockReturnValue(false);
    treeShrubOutlineLive.mockReturnValue(true);
    setupDb({ packet: PEST_PACKET });
    await withServer(async (baseUrl) => {
      for (const [path, body] of [
        ['/preview', { estimateId: 'estimate-1', serviceLine: 'pest_control' }],
        ['', { estimateId: 'estimate-1', serviceLine: 'pest_control' }],
        ['/packet-1/regenerate', {}],
        ['/packet-1/send', { method: 'both' }],
      ]) {
        const res = await post(baseUrl, path, body);
        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe('Pest Control outlines are not turned on.');
      }
    });
    expect(buildPestOutline).not.toHaveBeenCalled();
    expect(buildOutline).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('on: the preview builds the Pest Control outline and answers its stamps', async () => {
    setupDb();
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/preview', { estimateId: 'estimate-1', serviceLine: 'pest_control', turfType: 'bermuda' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.meta).toEqual({
        templateVersion: 'template-v1',
        contentLibraryVersion: 'pest-v1-copy-1',
        protocolVersion: null,
        productRegistryVersion: 'products-v1',
      });
    });
    expect(buildOutline).not.toHaveBeenCalled();
    expect(buildPestOutline).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ serviceLine: 'pest_control' }) }));
  });

  test('on: a saved Pest Control packet is stored as pest_control with the outline’s own stamps', async () => {
    const { inserts } = setupDb();
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '', { estimateId: 'estimate-1', serviceLine: 'pest_control' });
      expect(res.status).toBe(201);
    });
    const row = inserts.find((r) => r.token_hash);
    expect(row).toEqual(expect.objectContaining({
      service_line: 'pest_control',
      protocol_track: 'pest_control',
      turf_type: null,
      mixed_turf_flag: false,
      content_library_version: 'pest-v1-copy-1',
      protocol_version: null,
      product_registry_version: 'products-v1',
      template_version: 'template-v1',
    }));
  });

  test('a regenerated Pest Control outline stays Pest Control', async () => {
    const { inserts } = setupDb({ packet: PEST_PACKET, inserted: { id: 'packet-2', status: 'approved' } });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/packet-1/regenerate', { serviceLine: 'lawn_care' });
      expect(res.status).toBe(201);
    });
    expect(buildOutline).not.toHaveBeenCalled();
    expect(buildPestOutline).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ serviceLine: 'pest_control' }) }));
    expect(inserts.find((r) => r.token_hash)).toEqual(expect.objectContaining({ service_line: 'pest_control' }));
  });

  test('the text and the email name the Pest Control program', async () => {
    setupDb({ packet: PEST_PACKET, inserted: { ...PEST_PACKET, status: 'sent' } });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/packet-1/send', { method: 'both' });
      expect(res.status).toBe(200);
    });
    const sms = sendCustomerMessage.mock.calls[0][0];
    expect(sms.body).toMatch(/^Waves: Your pest control program overview is ready: \S+ Reply STOP to opt out\.$/);
    expect(sms.entryPoint).toBe('admin_lawn_service_outline_send');
    expect(sms.metadata.original_message_type).toBe('pest_service_outline');
    const email = sendgrid.sendOne.mock.calls[0][0];
    expect(email.subject).toBe('Your Waves Pest Control Program Overview');
    expect(email.html).toContain('Your pest control program overview is ready.');
    expect(email.html).toContain('Your Waves pest control program overview is ready.');
    expect(email.html).not.toMatch(/lawn care program|tree and shrub/i);
    expect(email.text).toMatch(/^Your Waves pest control program overview is ready: /);
    expect(email.categories).toEqual(['pest_service_outline']);
  });
});
