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
      expect(html).toContain("<p>You picked <strong>Ants</strong>. Tap confirm and we'll take it from here.</p>");
      expect(html).not.toMatch(/lawn check/i);
      // An answer the quiz does not have: no label, the same next-step line.
      const unknown = await (await fetch(`${baseUrl}/api/public/newsletter/quiz/${TOKEN}/pest-pressure-v1/nope`)).text();
      expect(unknown).toContain("<p>Tap confirm and we'll take it from here.</p>");
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

  test.each([
    ['Waves Newsletter', 'nl-poll-weekend-v1', 'out-to-eat', 'Out to eat'],
    ['Waves Pest Insider', 'pi-poll-lizards-v1', 'what-lizards', 'What lizards?'],
  ])('a %s poll vote confirms the answer, promises no next step and thanks the reader with no booking pitch', async (newsletter, quizId, answer, label) => {
    await withServer(async (baseUrl) => {
      const url = `${baseUrl}/api/public/newsletter/quiz/${TOKEN}/${quizId}/${answer}`;
      const confirm = await (await fetch(url)).text();
      // Nothing follows a poll vote, so the page does not say "we'll take it from here".
      expect(confirm).toContain(`<p>You picked <strong>${label}</strong>.</p>`);
      expect(confirm).toContain(`>Confirm — ${label}</button>`);
      expect(confirm).not.toMatch(/take it from here/);
      // An answer the poll does not have: the button alone, still no promise.
      const unknown = await (await fetch(`${baseUrl}/api/public/newsletter/quiz/${TOKEN}/${quizId}/nope`)).text();
      expect(unknown).toContain('>Confirm</button>');
      expect(unknown).not.toMatch(/You picked|take it from here/);
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '',
      });
      const html = await r.text();
      expect(r.status).toBe(200);
      expect(html).toContain(`Your vote is in. See you in the next ${newsletter}.`);
      expect(html).not.toMatch(/\/book\b|Book a|free check/);
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
