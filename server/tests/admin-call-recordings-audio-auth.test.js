process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

let recordingUrl;

jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({
  jwt: { secret: 'test-jwt-secret' },
  twilio: { accountSid: 'AC-test', authToken: 'twilio-secret' },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/call-recording-processor', () => ({}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    if (req.headers.authorization !== 'Bearer staff-jwt') {
      return res.status(401).json({ error: 'Admin authentication required' });
    }
    req.techRole = 'admin';
    req.technicianId = 'staff-1';
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (
    req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Staff access required' })
  ),
}));

const http = require('http');
const express = require('express');
const db = require('../models/db');
const logger = require('../services/logger');
const audioRouter = require('../routes/admin-call-recordings');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(server, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withProxy(fn) {
  const app = express();
  app.use('/admin/call-recordings', audioRouter);
  const proxy = http.createServer(app);
  await listen(proxy);
  try {
    return await fn(proxy);
  } finally {
    await close(proxy);
  }
}

function recordingQuery() {
  const query = {
    where: jest.fn(() => query),
    first: jest.fn(async () => ({ recording_url: recordingUrl })),
  };
  return query;
}

describe('admin call-recording audio authentication', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    recordingUrl = 'https://api.twilio.com/2010-04-01/Accounts/AC-test/Recordings/RE123';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: jest.fn().mockResolvedValue(Buffer.from('mp3-data')),
    });
    db.mockImplementation((table) => {
      if (table !== 'call_log') throw new Error(`Unexpected table ${table}`);
      return recordingQuery();
    });
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  test.each(['token=staff-jwt', 'page=1', 'download=true']) (
    'rejects every query string before auth or database work: %s',
    async (query) => {
      await withProxy(async (proxy) => {
        const res = await request(
          proxy,
          `/admin/call-recordings/audio/RE123?${query}`,
          { Authorization: 'Bearer staff-jwt' },
        );

        expect(res.status).toBe(400);
        expect(JSON.parse(res.body).error).toMatch(/query strings are not supported/i);
        expect(db).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
      });
    },
  );

  test('requires a Bearer header when no query string is supplied', async () => {
    await withProxy(async (proxy) => {
      const res = await request(proxy, '/admin/call-recordings/audio/RE123');
      expect(res.status).toBe(401);
      expect(db).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  test.each([
    [
      'absolute Twilio URL',
      'https://api.twilio.com/2010-04-01/Accounts/AC-test/Recordings/RE123',
      'https://api.twilio.com/2010-04-01/Accounts/AC-test/Recordings/RE123.mp3',
    ],
    [
      'relative Twilio path',
      '/2010-04-01/Accounts/AC-test/Recordings/RE456.mp3',
      'https://api.twilio.com/2010-04-01/Accounts/AC-test/Recordings/RE456.mp3',
    ],
    [
      'historical HTTP Twilio URL upgraded locally',
      'http://api.twilio.com/2010-04-01/Accounts/AC-test/Recordings/RE789',
      'https://api.twilio.com/2010-04-01/Accounts/AC-test/Recordings/RE789.mp3',
    ],
  ])('proxies a canonical %s without forwarding the staff JWT', async (_label, stored, expected) => {
    recordingUrl = stored;
    await withProxy(async (proxy) => {
      const res = await request(
        proxy,
        '/admin/call-recordings/audio/RE123',
        { Authorization: 'Bearer staff-jwt' },
      );

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^audio\/mpeg/);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.body.toString()).toBe('mp3-data');
      expect(global.fetch).toHaveBeenCalledWith(expected, {
        headers: {
          Authorization: `Basic ${Buffer.from('AC-test:twilio-secret').toString('base64')}`,
        },
        redirect: 'manual',
      });
    });
  });

  test.each([
    'https://api.twilio.com.evil.example/recording.mp3',
    'http://api.twilio.com.evil.example/recording.mp3',
    'https://api.twilio.com@evil.example/recording.mp3',
    'https://api.twilio.com/recording.mp3?token=secret',
    'https://api.twilio.com/recording.mp3#fragment',
  ])('rejects a non-canonical stored recording URL: %s', async (stored) => {
    recordingUrl = stored;
    await withProxy(async (proxy) => {
      const res = await request(
        proxy,
        '/admin/call-recordings/audio/RE123',
        { Authorization: 'Bearer staff-jwt' },
      );

      expect(res.status).toBe(502);
      expect(JSON.parse(res.body)).toEqual({ error: 'Unable to load recording' });
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  test('does not follow an upstream redirect with Twilio credentials', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 302 });
    await withProxy(async (proxy) => {
      const res = await request(
        proxy,
        '/admin/call-recordings/audio/RE123',
        { Authorization: 'Bearer staff-jwt' },
      );

      expect(res.status).toBe(502);
      expect(JSON.parse(res.body)).toEqual({ error: 'Unable to load recording' });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch.mock.calls[0][1].redirect).toBe('manual');
    });
  });

  test('returns a generic error when internal work fails', async () => {
    db.mockImplementation(() => { throw new Error('database host and password'); });
    await withProxy(async (proxy) => {
      const res = await request(
        proxy,
        '/admin/call-recordings/audio/RE123',
        { Authorization: 'Bearer staff-jwt' },
      );

      expect(res.status).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'Unable to load recording' });
      expect(res.body.toString()).not.toContain('database host and password');
      expect(logger.error).toHaveBeenCalled();
    });
  });
});
