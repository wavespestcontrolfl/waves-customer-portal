// An open staff tab compares the live client build with the one it loaded
// (client/src/lib/portalVersion.js). adminAuthenticate stamps it on each
// signed-in staff answer. These tests pin what the tab relies on: a staff
// answer names the build and the server's start time (an unchanged 304 too),
// a refused request and a public route under /api/admin carry neither, a
// server with no build tag stamps nothing, and the stamp never changes the
// outcome of a sign-in check.
jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ jwt: { secret: 'test-secret' } }));

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../models/db');
const { adminAuthenticate } = require('../middleware/admin-auth');
const { BOOT, readPortalBuild, setPortalBuildForTests } = require('../middleware/portal-build-header');

const STAFF = { id: 7, employment_status: 'active', role: 'admin', auth_token_version: 1 };
const BEARER = `Bearer ${jwt.sign({ technicianId: 7, type: 'access', tokenVersion: 1 }, 'test-secret')}`;

let server;
let origin;

beforeAll(async () => {
  const app = express();
  app.get('/api/admin/notifications/unread-count', adminAuthenticate, (_req, res) => res.json({ count: 2 }));
  // A public route under the same prefix (like the staff sign-in or the push
  // key) never runs adminAuthenticate.
  app.get('/api/admin/push/vapid-key', (_req, res) => res.json({ publicKey: 'fixture' }));
  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  setPortalBuildForTests(undefined);
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  db.mockReset();
  db.mockImplementation(() => ({ where: jest.fn(() => ({ first: jest.fn(async () => STAFF) })) }));
  setPortalBuildForTests('3fa9c01b7e24');
});

// Plain node:http, so the request carries only these headers. A browser that
// revalidates its cached copy sends If-None-Match alone; fetch() would add
// Cache-Control: no-cache, which Express answers with a full 200.
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(`${origin}${url}`, { headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    }).on('error', reject);
  });
}

describe('readPortalBuild', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-build-'));
  const write = (name, html) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, html);
    return file;
  };

  test('reads the build tag that the client build writes into index.html', () => {
    const file = write('built.html', '<head><title>Waves</title><meta name="portal-build" content="3fa9c01b7e24">\n</head>');
    expect(readPortalBuild(file)).toBe('3fa9c01b7e24');
  });

  test('a page without the tag, or no page at all, has no build', () => {
    expect(readPortalBuild(write('dev.html', '<head><title>Waves</title></head>'))).toBeNull();
    expect(readPortalBuild(path.join(dir, 'missing.html'))).toBeNull();
  });
});

describe('the stamp on staff answers', () => {
  test('a signed-in staff answer names the live build and the server start time', async () => {
    const res = await get('/api/admin/notifications/unread-count', { Authorization: BEARER });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-portal-build']).toBe('3fa9c01b7e24');
    expect(res.headers['x-portal-boot']).toBe(BOOT);
  });

  test('an unchanged staff answer (304) still names the build', async () => {
    const first = await get('/api/admin/notifications/unread-count', { Authorization: BEARER });
    const again = await get('/api/admin/notifications/unread-count', { Authorization: BEARER, 'If-None-Match': first.headers.etag });
    expect(again.statusCode).toBe(304);
    expect(again.headers['x-portal-build']).toBe('3fa9c01b7e24');
  });

  test('a refused request and a public route carry no stamp', async () => {
    const refused = await get('/api/admin/notifications/unread-count');
    expect(refused.statusCode).toBe(401);
    const publicAnswer = await get('/api/admin/push/vapid-key', { Authorization: BEARER });
    expect(publicAnswer.statusCode).toBe(200);
    for (const res of [refused, publicAnswer]) {
      expect(res.headers['x-portal-build']).toBeUndefined();
      expect(res.headers['x-portal-boot']).toBeUndefined();
    }
  });

  test('a server with no build tag stamps nothing and still answers', async () => {
    setPortalBuildForTests(null);
    const res = await get('/api/admin/notifications/unread-count', { Authorization: BEARER });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-portal-build']).toBeUndefined();
  });

  test('the stamp never changes the outcome of the sign-in check', async () => {
    const next = jest.fn();
    await adminAuthenticate({ headers: { authorization: BEARER } }, { json: jest.fn() }, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
