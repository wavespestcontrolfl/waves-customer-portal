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
    ['Waves Newsletter', 'nl-poll-weekend-v1', 'out-to-eat', 'Out to eat', 'Where will you be this weekend?', 'Your vote is in. See you in the next Waves Newsletter.'],
    ['Waves Pest Insider', 'pi-poll-lizards-v1', 'what-lizards', 'What lizards?', 'Lizards on the lanai: friend or foe?', "Your vote is in. We'll share the top answer in the Waves Pest Insider."],
    ['Waves Pest Insider', 'pi-poll-worst-guest-v1', 'ants', 'Ants', 'Which pest is the worst house guest?', "Your vote is in. We'll share the top answer in the Waves Pest Insider."],
  ])('a %s poll vote reads like a poll, writes nothing on the GET, and thanks the reader with no booking pitch (%s)', async (_newsletter, quizId, answer, label, question, thanks) => {
    await withServer(async (baseUrl) => {
      const url = `${baseUrl}/api/public/newsletter/quiz/${TOKEN}/${quizId}/${answer}`;
      db.mockClear();
      const confirm = await (await fetch(url)).text();
      // The page asks the poll's own question, counts the vote, and says how to change it.
      expect(confirm).toContain(`<h1>${question}</h1>`);
      expect(confirm).toContain(`<p>You picked <strong>${label}</strong>.</p>`);
      expect(confirm).toContain('>Count my vote</button>');
      expect(confirm).toContain('Changed your mind? Tap another answer in the email. Your last vote counts.');
      // Nothing follows a poll vote, so the page does not say "we'll take it from here".
      expect(confirm).not.toMatch(/take it from here|One tap to confirm|Confirm —|If you didn't tap this/);
      // A GET never writes: it does not even open the database.
      expect(db).not.toHaveBeenCalled();
      // An answer the poll does not have: today's page, the button alone, still no promise.
      const unknown = await (await fetch(`${baseUrl}/api/public/newsletter/quiz/${TOKEN}/${quizId}/nope`)).text();
      expect(unknown).toContain('>Confirm</button>');
      expect(unknown).toContain('<h1>One tap to confirm.</h1>');
      expect(unknown).toContain("If you didn't tap this, just close this tab — nothing changes until you click the button.");
      expect(unknown).not.toMatch(/You picked|take it from here|Count my vote|Your last vote counts/);
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '',
      });
      const html = await r.text();
      expect(r.status).toBe(200);
      // The page escapes the line, so the apostrophe in "We'll" is an entity in the markup.
      expect(html).toContain(thanks.replace(/'/g, '&#39;'));
      expect(html).not.toMatch(/\/book\b|Book a|free check/);
    });
  });

  test('a service quiz keeps its confirm page word for word', async () => {
    await withServer(async (baseUrl) => {
      const html = await (await fetch(`${baseUrl}/api/public/newsletter/quiz/${TOKEN}/pest-pressure-v1/ants`)).text();
      expect(html).toContain('<h1>One tap to confirm.</h1>');
      expect(html).toContain(">Confirm — Ants</button>");
      expect(html).toContain("If you didn't tap this, just close this tab — nothing changes until you click the button.");
      expect(html).not.toMatch(/Count my vote|Your last vote counts/);
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
