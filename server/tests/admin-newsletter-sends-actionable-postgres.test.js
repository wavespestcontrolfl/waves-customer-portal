/**
 * GET /api/admin/newsletter/sends lists the newest 500 campaigns plus every
 * older campaign that still needs an action (audit 2026-10-30, NEWS-11):
 * past the 500-row window a draft, scheduled send, failed send or a sent
 * campaign with recipients left to resume used to lose its only entry
 * point in History. Real Postgres, because the "left to resume" test is
 * the correlated EXISTS the route also selects as has_outstanding.
 * Self-skips unless DATABASE_URL is set (CI's DB-gated suites step).
 * Safe on a shared database: synthetic rows, asserted by id, removed after.
 */
jest.setTimeout(60000);

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => require('knex')({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: { min: 0, max: 4 },
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technician = { id: 'admin-1', role: 'admin', email: 'owner@example.invalid' };
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const { randomUUID } = require('crypto');

postgres('GET /sends keeps older actionable campaigns reachable (real Postgres)', () => {
  const express = require('express');
  const db = require('../models/db');
  const router = require('../routes/admin-newsletter');
  const created = { sends: [], subscribers: [] };
  const DAY = 24 * 60 * 60 * 1000;
  const longAgo = (days) => new Date(Date.now() - days * DAY);

  async function insertSends(rows) {
    const inserted = await db('newsletter_sends').insert(rows.map((row) => ({
      html_body: '<p>Synthetic</p>',
      text_body: 'Synthetic',
      auto_share_social: false,
      ...row,
    }))).returning(['id']);
    created.sends.push(...inserted.map((r) => r.id));
    return inserted.map((r) => r.id);
  }

  async function listedIds() {
    const app = express();
    app.use(express.json());
    app.use('/admin/newsletter', router);
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/newsletter/sends`);
      expect(res.status).toBe(200);
      return new Set((await res.json()).sends.map((s) => s.id));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  afterAll(async () => {
    if (created.sends.length) {
      await db('newsletter_send_deliveries').whereIn('send_id', created.sends).del();
      await db('newsletter_sends').whereIn('id', created.sends).del();
    }
    if (created.subscribers.length) await db('newsletter_subscribers').whereIn('id', created.subscribers).del();
    await db.destroy();
  });

  test('older drafts, schedules, failures and resumable sends stay listed; an older finished send does not', async () => {
    // 500 newer finished campaigns fill the window ahead of every row below.
    await insertSends(Array.from({ length: 500 }, (_, i) => ({
      subject: `Synthetic recent ${i}`,
      status: 'sent',
      sent_at: new Date(Date.now() - i * 1000),
      created_at: new Date(Date.now() - i * 1000),
    })));
    const [draft, scheduled, failed, finished, resumable] = await insertSends([
      { subject: 'Synthetic old draft', status: 'draft', created_at: longAgo(4000) },
      { subject: 'Synthetic old schedule', status: 'scheduled', scheduled_for: new Date(Date.now() + DAY), created_at: longAgo(4000) },
      { subject: 'Synthetic old failure', status: 'failed', created_at: longAgo(4000) },
      { subject: 'Synthetic old finished', status: 'sent', sent_at: longAgo(4000), created_at: longAgo(4000) },
      { subject: 'Synthetic old resumable', status: 'sent', sent_at: longAgo(4000), created_at: longAgo(4000) },
    ]);
    const [sub] = await db('newsletter_subscribers')
      .insert({ email: `actionable-${randomUUID().slice(0, 8)}@example.invalid`, status: 'active', source: 'public_form' })
      .returning(['id', 'email']);
    created.subscribers.push(sub.id);
    await db('newsletter_send_deliveries').insert({ send_id: resumable, subscriber_id: sub.id, email: sub.email, status: 'failed' });

    const ids = await listedIds();
    expect(ids.has(draft)).toBe(true);
    expect(ids.has(scheduled)).toBe(true);
    expect(ids.has(failed)).toBe(true);
    expect(ids.has(resumable)).toBe(true);
    expect(ids.has(finished)).toBe(false);
  });
});
