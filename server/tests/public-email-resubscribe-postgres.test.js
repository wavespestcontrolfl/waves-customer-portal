/**
 * GATE_PORTAL_EMAIL_RESUBSCRIBE end to end on real PostgreSQL: the public confirm page and its
 * button through the real router. Rows are committed (SendGrid's pre-clear reads on its own
 * connection) and deleted at the end. SendGrid is a fake fetch.
 */
const SKIP = !process.env.DATABASE_URL;
jest.setTimeout(60000);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

(SKIP ? describe.skip : describe)('public email-resubscribe page on PostgreSQL', () => {
  let db;
  let service;
  let server;
  let baseUrl;
  let n = 0;
  const realFetch = global.fetch;
  const nativeFetch = (...args) => realFetch(...args);

  beforeAll((done) => {
    process.env.GATE_PORTAL_EMAIL_RESUBSCRIBE = 'true';
    const express = require('express');
    db = require('../models/db');
    service = require('../services/email-resubscribe');
    const app = express();
    app.use('/api/public/email-resubscribe', require('../routes/public-email-resubscribe'));
    server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
  });
  afterAll(async () => {
    delete process.env.GATE_PORTAL_EMAIL_RESUBSCRIBE;
    await new Promise((resolve) => server.close(resolve));
    await db.destroy();
  });
  afterEach(() => { global.fetch = realFetch; delete process.env.SENDGRID_API_KEY; delete process.env.SENDGRID_ASM_GROUP_SERVICE; });

  async function scenario(fn) {
    const email = `resub-route-${Date.now()}-${++n}@example.com`;
    const token = require('crypto').randomBytes(32).toString('base64url');
    try {
      const [sup] = await db('email_suppressions').insert({
        email, status: 'active', group_key: null, suppression_type: 'unsubscribe', source: 'sendgrid_event_webhook',
      }).returning('*');
      const [request] = await db('email_resubscribe_requests').insert({
        email, token_hash: service.hashToken(token), sent_at: new Date(), expires_at: new Date(Date.now() + 3600000),
      }).returning('*');
      await fn({ email, token, sup, request });
    } finally {
      await db('email_resubscribe_requests').whereRaw('lower(email) = ?', [email]).del();
      await db('email_suppressions').whereRaw('lower(email) = ?', [email]).del();
    }
  }
  const url = (token) => `${baseUrl}/api/public/email-resubscribe/${token}`;
  const snapshot = async (email) => JSON.stringify({
    sup: await db('email_suppressions').whereRaw('lower(email) = ?', [email]).orderBy('id'),
    req: await db('email_resubscribe_requests').whereRaw('lower(email) = ?', [email]).orderBy('id'),
  });
  const form = (token) => nativeFetch(url(token), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' });

  test('GET (twice, as a mail scanner would) changes no row', async () => {
    await scenario(async ({ email, token }) => {
      const before = await snapshot(email);
      for (let i = 0; i < 2; i += 1) {
        const res = await nativeFetch(url(token));
        expect(res.status).toBe(200);
        expect(await res.text()).toContain(email);
      }
      expect(await snapshot(email)).toBe(before);
    });
  });

  test('the button: SendGrid is cleared, the block is released, the request is used, and the page says Done', async () => {
    process.env.SENDGRID_API_KEY = 'SG.test';
    await scenario(async ({ email, token, sup, request }) => {
      const seen = [];
      global.fetch = jest.fn(async (u, init) => {
        if (String(u).startsWith('https://api.sendgrid.com')) {
          seen.push({ method: init.method, status: (await db('email_suppressions').where({ id: sup.id }).first()).status });
          return { ok: true, status: 204 };
        }
        return realFetch(u, init);
      });
      const res = await form(token);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Done.');
      // SendGrid's DELETE ran while the local row was still active (clear first, release second).
      expect(seen).toEqual([{ method: 'DELETE', status: 'active' }]);
      expect((await db('email_suppressions').where({ id: sup.id }).first())).toMatchObject({ status: 'released', consent_source: 'email_confirm_link' });
      expect((await db('email_resubscribe_requests').where({ id: request.id }).first()).used_at).toBeInstanceOf(Date);
      const again = await nativeFetch(url(token));
      expect(await again.text()).toContain("You're all set.");
    });
  });

  test('a SendGrid failure: the row stays active, the request stays unused, and the next press works', async () => {
    process.env.SENDGRID_API_KEY = 'SG.test';
    await scenario(async ({ token, sup, request }) => {
      global.fetch = jest.fn(async () => ({ ok: false, status: 500 }));
      const failed = await form(token);
      expect(failed.status).toBe(503);
      const html = await failed.text();
      expect(html).toContain("We couldn't finish that.");
      expect(html).toContain('Please try the button again in a few minutes.');
      expect((await db('email_suppressions').where({ id: sup.id }).first()).status).toBe('active');
      expect((await db('email_resubscribe_requests').where({ id: request.id }).first()).used_at).toBeNull();
      global.fetch = jest.fn(async () => ({ ok: true, status: 404 }));
      const retry = await form(token);
      expect(retry.status).toBe(200);
      expect(await retry.text()).toContain('Done.');
      expect((await db('email_suppressions').where({ id: sup.id }).first()).status).toBe('released');
    });
  });

  test('a do_not_email added after the email was sent: GET shows the expired page, POST makes no SendGrid call and releases nothing', async () => {
    process.env.SENDGRID_API_KEY = 'SG.test';
    await scenario(async ({ email, token, sup }) => {
      await db('email_suppressions').insert({
        email, status: 'active', group_key: null, suppression_type: 'do_not_email', source: 'admin_manual', metadata: JSON.stringify({ created_by: 'tech-1' }),
      });
      const before = await snapshot(email);
      const page = await nativeFetch(url(token));
      expect(page.status).toBe(404);
      const html = await page.text();
      expect(html).toContain('This link has expired or was already used.');
      expect(html).not.toContain('<form');
      expect(await snapshot(email)).toBe(before);
      const sendgrid = jest.fn(async () => ({ ok: true, status: 204 }));
      global.fetch = (u, init) => (String(u).startsWith('https://api.sendgrid.com') ? sendgrid(u, init) : realFetch(u, init));
      const press = await form(token);
      expect(press.status).toBe(404);
      expect(await press.text()).toContain('This link has expired or was already used.');
      expect(sendgrid).not.toHaveBeenCalled();
      expect((await db('email_suppressions').where({ id: sup.id }).first()).status).toBe('active');
    });
  });

  test('an expired or unknown token releases nothing', async () => {
    await scenario(async ({ email, token, request }) => {
      await db('email_resubscribe_requests').where({ id: request.id }).update({ expires_at: new Date(Date.now() - 1000) });
      const before = await snapshot(email);
      expect((await form(token)).status).toBe(404);
      expect((await form('z'.repeat(43))).status).toBe(404);
      expect((await nativeFetch(url(token))).status).toBe(404);
      expect(await snapshot(email)).toBe(before);
    });
  });
});
