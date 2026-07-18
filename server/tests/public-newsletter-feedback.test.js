process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// recordFeedbackReaction looks up the delivery by engagement_token; mock the
// DB to "not found" so the public route still renders its confirm/thank-you
// HTML without a real database. The route renders regardless of the write
// result (always-200, no token oracle).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const publicNewsletterRouter = require('../routes/public-newsletter');

function appServer() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
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

describe('public newsletter feedback routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockImplementation(() => {
      const q = {};
      ['where', 'whereNotNull', 'select', 'update'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.first = jest.fn(async () => null); // no delivery row → record no-ops
      return q;
    });
  });

  test('GET 👍 renders a read-only confirm page — no mutation on GET', async () => {
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/public/newsletter/feedback/${TOKEN}/great`);
      const html = await r.text();
      expect(r.status).toBe(200);
      expect(html).toContain('You picked');
      expect(html).toContain('👍 Great');
      expect(html).toContain('method="POST"');
      // The GET handler never touches the deliveries table.
      expect(db).not.toHaveBeenCalled();
    });
  });

  test('GET 👎 asks what was missing with the five owner-specified options', async () => {
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/public/newsletter/feedback/${TOKEN}/needs-work`);
      const html = await r.text();
      expect(r.status).toBe(200);
      expect(html).toContain('What was missing?');
      for (const label of ['Closer events', 'More local news', 'Restaurant openings', 'Family activities', 'Home tips']) {
        expect(html).toContain(label);
      }
      expect((html.match(/type="checkbox"/g) || []).length).toBe(5);
      expect(db).not.toHaveBeenCalled();
    });
  });

  test('GET with an unknown reaction degrades gracefully', async () => {
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/public/newsletter/feedback/${TOKEN}/amazing`);
      const html = await r.text();
      expect(r.status).toBe(200);
      expect(html).toContain('your feedback is counted');
    });
  });

  test('POST form 👍 returns the thank-you page', async () => {
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/public/newsletter/feedback/${TOKEN}/great`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '',
      });
      const html = await r.text();
      expect(r.status).toBe(200);
      expect(html).toContain('Thanks — that helps!');
    });
  });

  test('POST form 👎 echoes the selected missing options', async () => {
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/public/newsletter/feedback/${TOKEN}/needs-work`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'missing=local-news&missing=home-tips',
      });
      const html = await r.text();
      expect(r.status).toBe(200);
      expect(html).toContain('More local news');
      expect(html).toContain('Home tips');
    });
  });

  test('non-form POST gets uniform JSON and stays 200 even for junk input', async () => {
    await withServer(async (baseUrl) => {
      const good = await fetch(`${baseUrl}/api/public/newsletter/feedback/${TOKEN}/okay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ missing: [] }),
      });
      expect(good.status).toBe(200);
      expect(await good.json()).toEqual({ ok: true });

      const junk = await fetch(`${baseUrl}/api/public/newsletter/feedback/not-a-uuid/whatever`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(junk.status).toBe(200);
      expect(await junk.json()).toEqual({ ok: true });
    });
  });
});
