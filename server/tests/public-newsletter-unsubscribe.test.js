process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// The unsubscribe pair's trust boundary: GET renders only (mail-gateway
// link prefetch must never flip a subscriber), POST is the single mutation
// point and answers two callers — RFC 8058 one-click mail clients (JSON)
// and the GET page's confirm <form> (HTML, body confirm=1).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const publicNewsletterRouter = require('../routes/public-newsletter');

function appServer() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use('/api/public/newsletter', publicNewsletterRouter);
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const TOKEN = '11111111-2222-3333-4444-555555555555';

let subRow;
let updates;

beforeEach(() => {
  jest.clearAllMocks();
  subRow = null;
  updates = [];
  db.mockImplementation(() => {
    const q = {};
    ['where', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => subRow);
    q.update = jest.fn(async (patch) => { updates.push(patch); return 1; });
    return q;
  });
});

describe('GET /unsubscribe/:token (read-only render)', () => {
  test('active subscriber gets a confirm form and NO status write', async () => {
    subRow = { id: 7, email: 'jane@example.com', status: 'active' };
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/public/newsletter/unsubscribe/${TOKEN}`);
      const html = await r.text();
      expect(r.status).toBe(200);
      expect(html).toContain(`action="/api/public/newsletter/unsubscribe/${TOKEN}"`);
      expect(html).toContain('name="confirm" value="1"');
      expect(html).toContain('jane@example.com');
      expect(updates).toHaveLength(0); // the whole point of the fix
    });
  });

  test('already-unsubscribed subscriber gets the done page, no form, no write', async () => {
    subRow = { id: 7, email: 'jane@example.com', status: 'unsubscribed' };
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/public/newsletter/unsubscribe/${TOKEN}`);
      const html = await r.text();
      expect(html).toContain("You're unsubscribed.");
      expect(html).not.toContain('<form');
      expect(updates).toHaveLength(0);
    });
  });

  test('unknown token gets the same done page (no token-validity oracle)', async () => {
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/public/newsletter/unsubscribe/${TOKEN}`);
      const html = await r.text();
      expect(r.status).toBe(200);
      expect(html).toContain('to this address');
      expect(html).not.toContain('<form');
      expect(updates).toHaveLength(0);
    });
  });

  test('malformed token never reaches the DB', async () => {
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/public/newsletter/unsubscribe/not-a-uuid`);
      expect(r.status).toBe(200);
      expect(db).not.toHaveBeenCalled();
    });
  });
});

describe('POST /unsubscribe/:token (the single mutation point)', () => {
  test('RFC 8058 one-click (urlencoded, no confirm field) flips status and returns JSON 200', async () => {
    subRow = { id: 7, email: 'jane@example.com', status: 'active' };
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/public/newsletter/unsubscribe/${TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
      });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ success: true });
      expect(updates).toHaveLength(1);
      expect(updates[0].status).toBe('unsubscribed');
    });
  });

  test('browser form (confirm=1) flips status and renders the HTML done page', async () => {
    subRow = { id: 7, email: 'jane@example.com', status: 'active' };
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/public/newsletter/unsubscribe/${TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'confirm=1',
      });
      const html = await r.text();
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/html');
      expect(html).toContain("You're unsubscribed.");
      expect(html).toContain('jane@example.com');
      expect(updates).toHaveLength(1);
      expect(updates[0].status).toBe('unsubscribed');
    });
  });

  test('form submit with an unknown token still gets the done page, no write', async () => {
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/public/newsletter/unsubscribe/${TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'confirm=1',
      });
      const html = await r.text();
      expect(r.status).toBe(200);
      expect(html).toContain('to this address');
      expect(updates).toHaveLength(0);
    });
  });

  test('already-unsubscribed row is not re-written (idempotent)', async () => {
    subRow = { id: 7, email: 'jane@example.com', status: 'unsubscribed' };
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/public/newsletter/unsubscribe/${TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
      });
      expect(r.status).toBe(200);
      expect(updates).toHaveLength(0);
    });
  });

  test('JSON caller gets the JSON shape even when a row was flipped', async () => {
    subRow = { id: 7, email: 'jane@example.com', status: 'active' };
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/public/newsletter/unsubscribe/${TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(r.headers.get('content-type')).toContain('application/json');
      expect(await r.json()).toEqual({ success: true });
      expect(updates).toHaveLength(1);
    });
  });

  test('DB failure: one-click still gets 200 JSON, form submit gets an honest 500', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    await withServer(async (baseUrl) => {
      const oneClick = await fetch(`${baseUrl}/api/public/newsletter/unsubscribe/${TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
      });
      expect(oneClick.status).toBe(200);
      expect(await oneClick.json()).toEqual({ success: true });

      const form = await fetch(`${baseUrl}/api/public/newsletter/unsubscribe/${TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'confirm=1',
      });
      expect(form.status).toBe(500);
      expect(await form.text()).toContain('contact@wavespestcontrol.com');
    });
  });
});
