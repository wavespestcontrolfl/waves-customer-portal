jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((...args) => mock(...args));
    trx.fn = mock.fn;
    trx.raw = jest.fn((value) => value);
    return fn(trx);
  });
  return mock;
});

const express = require('express');
const db = require('../models/db');
const serviceOutlinesPublic = require('../routes/service-outlines-public');
const VALID_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    first: jest.fn(),
    update: jest.fn().mockReturnThis(),
    returning: jest.fn(),
    insert: jest.fn().mockResolvedValue(1),
    ...overrides,
  };
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/service-outlines', serviceOutlinesPublic);
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

describe('public service outline packets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('does not serve draft outline packets', async () => {
    db.mockImplementation(() => chain({
      first: jest.fn().mockResolvedValue({
        id: 'packet-1',
        status: 'draft',
        revoked_at: null,
      }),
    }));

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/service-outlines/${VALID_TOKEN}`);
      expect(res.status).toBe(404);
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('404s malformed tokens before querying packet data', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/service-outlines/not-a-real-token`);
      expect(res.status).toBe(404);
    });
    expect(db).not.toHaveBeenCalledWith('service_outline_packets');
  });

  test('serves approved outline packets and marks them viewed', async () => {
    const packet = {
      id: 'packet-1',
      status: 'approved',
      title: 'Your Waves Lawn Care Program Overview',
      content_json: { title: 'Overview' },
      summary_json: { turfType: 'st_augustine' },
      revoked_at: null,
      expires_at: null,
      first_viewed_at: null,
      view_count: 0,
    };
    const readChain = chain({ first: jest.fn().mockResolvedValue(packet) });
    const updateChain = chain({
      update: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ ...packet, status: 'viewed', view_count: 1 }]),
    });
    const insertChain = chain();
    db.mockImplementation((table) => {
      if (table === 'service_outline_events') return insertChain;
      if (db.mock.calls.length > 1) return updateChain;
      return readChain;
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/service-outlines/${VALID_TOKEN}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.packet).toMatchObject({ id: 'packet-1', status: 'viewed' });
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'viewed' }));
  });

  test('serves approved outline packets through secondary resend tokens', async () => {
    const packet = {
      id: 'packet-1',
      status: 'sent',
      title: 'Your Waves Lawn Care Program Overview',
      content_json: { title: 'Overview' },
      summary_json: { turfType: 'st_augustine' },
      revoked_at: null,
      expires_at: null,
      first_viewed_at: null,
      view_count: 0,
    };
    const primaryMissChain = chain({ first: jest.fn().mockResolvedValue(null) });
    const secondaryTokenChain = chain({
      first: jest.fn().mockResolvedValue({
        id: 'token-1',
        packet_id: 'packet-1',
        expires_at: null,
        revoked_at: null,
      }),
    });
    const packetByIdChain = chain({ first: jest.fn().mockResolvedValue(packet) });
    const updateChain = chain({
      update: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ ...packet, status: 'viewed', view_count: 1 }]),
    });
    const insertChain = chain();
    let packetReads = 0;

    db.mockImplementation((table) => {
      if (table === 'service_outline_public_tokens') return secondaryTokenChain;
      if (table === 'service_outline_events') return insertChain;
      if (table === 'service_outline_packets') {
        packetReads += 1;
        if (packetReads === 1) return primaryMissChain;
        if (packetReads === 2) return packetByIdChain;
        return updateChain;
      }
      return chain();
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/service-outlines/${VALID_TOKEN}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.packet).toMatchObject({ id: 'packet-1', status: 'viewed' });
    });

    expect(secondaryTokenChain.first).toHaveBeenCalledTimes(1);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'viewed' }));
  });
});
