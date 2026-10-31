// The outline routes with a Tree & Shrub outline, behind GATE_TS_OUTLINE (owner 2026-10-26, decision D4-A). Synthetic
// rows: no database, no send.
//
// Pins: off = every Tree & Shrub preview, save, regenerate and send answers 409 and nothing is built or sent; on = the
// Tree & Shrub builder runs, the packet is stored as tree_shrub with the outline's own stamps, a regenerate keeps the
// program, and the text and email name the Tree & Shrub program; a lawn request is the lawn outline exactly as before.

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
const { buildTreeShrubOutline, treeShrubOutlineLive } = require('../services/tree-shrub-service-outline');
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

function treeShrubOutline(input) {
  return {
    meta: {
      serviceLine: 'tree_shrub',
      turf: { turfType: null, label: null, confidence: null, mixed: false },
      jurisdictionRule: { jurisdiction_id: 'sarasota_county_fl', version: 'rule-v1' },
      templateVersion: 'template-v1',
      contentLibraryVersion: 'ts-v1-copy-1',
      protocolVersion: '2026.09-tree-shrub-field-guide',
      productRegistryVersion: 'products-v1',
    },
    content: { title: 'Your Waves Tree & Shrub Program Overview', productCards: [] },
    contentHtml: '<p>outline</p>',
    summary: { serviceLine: 'tree_shrub' },
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

const TS_PACKET = {
  id: 'packet-1',
  estimate_id: 'estimate-1',
  customer_id: 'customer-1',
  service_line: 'tree_shrub',
  status: 'approved',
  validation_status: 'passed',
  title: 'Your Waves Tree & Shrub Program Overview',
  token_hash: 'old-token-hash',
  expires_at: null,
  revoked_at: null,
  input_snapshot_json: { serviceLine: 'tree_shrub', month: 10 },
  content_json: { productCards: [] },
};

describe('Tree & Shrub outline routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    treeShrubOutlineLive.mockReturnValue(true);
    buildTreeShrubOutline.mockImplementation(async ({ input }) => treeShrubOutline(input));
    buildOutline.mockImplementation(async ({ input }) => lawnOutline(input));
  });

  test('off: a Tree & Shrub preview, save, regenerate and send are refused and nothing is built or sent', async () => {
    treeShrubOutlineLive.mockReturnValue(false);
    setupDb({ packet: TS_PACKET });
    await withServer(async (baseUrl) => {
      for (const [path, body] of [
        ['/preview', { estimateId: 'estimate-1', serviceLine: 'tree_shrub' }],
        ['', { estimateId: 'estimate-1', serviceLine: 'tree_shrub' }],
        ['/packet-1/regenerate', {}],
        ['/packet-1/send', { method: 'both' }],
      ]) {
        const res = await post(baseUrl, path, body);
        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe('Tree & Shrub outlines are not turned on.');
      }
    });
    expect(buildTreeShrubOutline).not.toHaveBeenCalled();
    expect(buildOutline).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('on: the preview builds the Tree & Shrub outline and answers its stamps', async () => {
    setupDb();
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/preview', { estimateId: 'estimate-1', serviceLine: 'tree_shrub', turfType: 'bermuda' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.meta).toEqual({
        templateVersion: 'template-v1',
        contentLibraryVersion: 'ts-v1-copy-1',
        protocolVersion: '2026.09-tree-shrub-field-guide',
        productRegistryVersion: 'products-v1',
      });
    });
    expect(buildOutline).not.toHaveBeenCalled();
    expect(buildTreeShrubOutline).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ serviceLine: 'tree_shrub' }) }));
  });

  test('on: a saved Tree & Shrub packet is stored as tree_shrub with the outline’s own stamps', async () => {
    const { inserts } = setupDb();
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '', { estimateId: 'estimate-1', serviceLine: 'tree_shrub' });
      expect(res.status).toBe(201);
    });
    const row = inserts.find((r) => r.token_hash);
    expect(row).toEqual(expect.objectContaining({
      service_line: 'tree_shrub',
      protocol_track: 'tree_shrub',
      turf_type: null,
      mixed_turf_flag: false,
      content_library_version: 'ts-v1-copy-1',
      protocol_version: '2026.09-tree-shrub-field-guide',
      product_registry_version: 'products-v1',
      template_version: 'template-v1',
    }));
  });

  test('a lawn request is the lawn outline exactly as before: no service line in its input, lawn stamps on its row', async () => {
    const { inserts } = setupDb();
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '', { estimateId: 'estimate-1', turfType: 'st_augustine' });
      expect(res.status).toBe(201);
    });
    expect(buildTreeShrubOutline).not.toHaveBeenCalled();
    expect(buildOutline.mock.calls[0][0].input).not.toHaveProperty('serviceLine');
    const row = inserts.find((r) => r.token_hash);
    expect(row).toEqual(expect.objectContaining({
      service_line: 'lawn_care',
      protocol_track: 'st_augustine',
      content_library_version: 'content-v1',
      protocol_version: 'protocol-v1',
    }));
  });

  test('a regenerated Tree & Shrub outline stays Tree & Shrub', async () => {
    const { inserts } = setupDb({ packet: TS_PACKET, inserted: { id: 'packet-2', status: 'approved' } });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/packet-1/regenerate', { serviceLine: 'lawn_care' });
      expect(res.status).toBe(201);
    });
    expect(buildOutline).not.toHaveBeenCalled();
    expect(buildTreeShrubOutline).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ serviceLine: 'tree_shrub' }) }));
    expect(inserts.find((r) => r.token_hash)).toEqual(expect.objectContaining({ service_line: 'tree_shrub' }));
  });

  test('the text and the email name the Tree & Shrub program', async () => {
    setupDb({ packet: TS_PACKET, inserted: { ...TS_PACKET, status: 'sent' } });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/packet-1/send', { method: 'both' });
      expect(res.status).toBe(200);
    });
    const sms = sendCustomerMessage.mock.calls[0][0];
    expect(sms.body).toMatch(/^Waves: Your tree and shrub program overview is ready: \S+ Reply STOP to opt out\.$/);
    expect(sms.entryPoint).toBe('admin_lawn_service_outline_send');
    expect(sms.metadata.original_message_type).toBe('tree_shrub_service_outline');
    const email = sendgrid.sendOne.mock.calls[0][0];
    expect(email.subject).toBe('Your Waves Tree & Shrub Program Overview');
    expect(email.html).toContain('Your tree and shrub program overview is ready.');
    expect(email.html).toContain('Your Waves tree and shrub program overview is ready.');
    expect(email.html).not.toMatch(/lawn care program/i);
    expect(email.text).toMatch(/^Your Waves tree and shrub program overview is ready: /);
    expect(email.categories).toEqual(['tree_shrub_service_outline']);
  });

  test('a lawn packet keeps the lawn text and email', async () => {
    const lawnPacket = { ...TS_PACKET, service_line: 'lawn_care', title: 'Your Waves Lawn Care Program Overview' };
    setupDb({ packet: lawnPacket, inserted: { ...lawnPacket, status: 'sent' } });
    treeShrubOutlineLive.mockReturnValue(false);
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/packet-1/send', { method: 'both' });
      expect(res.status).toBe(200);
    });
    expect(sendCustomerMessage.mock.calls[0][0].body).toMatch(/^Waves: Your lawn care program overview is ready: \S+ Reply STOP to opt out\.$/);
    expect(sendCustomerMessage.mock.calls[0][0].metadata.original_message_type).toBe('lawn_service_outline');
    const email = sendgrid.sendOne.mock.calls[0][0];
    expect(email.html).toContain('Your lawn care program overview is ready.');
    expect(email.html).toContain('Your Waves lawn care program overview is ready. It explains what a typical visit includes');
    expect(email.categories).toEqual(['lawn_service_outline']);
  });
});
