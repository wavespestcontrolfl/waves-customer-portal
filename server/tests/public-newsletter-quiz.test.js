process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// recordQuizResponse looks up the delivery by engagement_token; mock it to
// "not found" so the public route still renders its confirm/thank-you HTML
// without a real DB. The route renders regardless of the tag-write result.
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

describe('public newsletter quiz landing copy (per-quiz)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockImplementation(() => {
      const q = {};
      ['where', 'whereNotNull', 'select', 'update'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.first = jest.fn(async () => null); // no delivery row → recordQuizResponse no-ops
      return q;
    });
  });

  test('GET confirm page is service-neutral and shows the chosen answer', async () => {
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/public/newsletter/quiz/${TOKEN}/pest-pressure-v1/ants`);
      const html = await r.text();
      expect(r.status).toBe(200);
      expect(html).toContain('You picked');
      expect(html).toContain('Ants');
      expect(html).not.toMatch(/lawn check/i);
    });
  });

  test('POST thank-you uses pest copy for a pest quiz', async () => {
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/public/newsletter/quiz/${TOKEN}/pest-pressure-v1/ants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '',
      });
      const html = await r.text();
      expect(r.status).toBe(200);
      expect(html).toContain('Book a pest visit');
      expect(html).toContain('free pest check'); // landingLine
      expect(html).not.toMatch(/lawn check/i);
    });
  });

  test('POST thank-you CTA deep-links to /book with the quiz service + attribution', async () => {
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/public/newsletter/quiz/${TOKEN}/pest-pressure-v1/ants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '',
      });
      const html = await r.text();
      // The booking href is HTML-escaped (& → &amp;), so assert the parts.
      expect(html).toContain('/book?service=pest_control');
      expect(html).toContain('source=newsletter-quiz');
    });
  });

  test('POST thank-you uses mosquito copy for the mosquito quiz', async () => {
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/public/newsletter/quiz/${TOKEN}/mosquito-v1/every-night`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '',
      });
      const html = await r.text();
      expect(html).toContain('Book a mosquito visit');
      expect(html).not.toMatch(/lawn check/i);
    });
  });

  test('POST thank-you keeps lawn copy for the lawn quiz', async () => {
    await withServer(async (baseUrl) => {
      const r = await fetch(`${baseUrl}/api/public/newsletter/quiz/${TOKEN}/lawn-headache-v1/weeds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '',
      });
      const html = await r.text();
      expect(html).toContain('Book a lawn check');
    });
  });
});
