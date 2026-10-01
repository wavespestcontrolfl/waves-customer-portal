/**
 * GET /api/public/price-change/:token — annual rate review notices. A
 * delivered one returns `review` (the letter frozen at send); an undelivered
 * one is a generic 404 that is never counted or flipped to viewed. A legacy
 * monthly notice is unchanged (no `review`). Invented data only.
 */
const mockRows = { notice: null, updates: [] };
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const q = {
      where: () => q,
      first: async () => (table === 'price_change_notices' ? mockRows.notice : { first_name: 'Testcust' }),
      update: async (patch) => { mockRows.updates.push(patch); return 1; },
    };
    return q;
  });
  db.raw = (s) => s;
  return db;
});

const express = require('express');
const router = require('../routes/price-change-public');

async function get(token) {
  const app = express();
  app.use('/api/public/price-change', router);
  const server = app.listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/public/price-change/${token}`);
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const TOKEN = 'c'.repeat(32);
const base = { id: 'n1', customer_id: 'c1', current_amount_cents: 11700, new_amount_cents: 12100, cadence_label: 'application', effective_date: '2026-12-10' };
const letter = { first_name: 'Testcust', cost_block: 'Costs went up.', lines: [{ service: 'Pest control', unit: 'application', current_cents: 11700, new_cents: 12100, effective_date: '2026-12-10', first_label: 'First application at the new rate', first: 'December 10, 2026', why: 'Reason.' }] };

beforeEach(() => { mockRows.updates = []; });

test('a delivered rate review notice returns the frozen letter', async () => {
  mockRows.notice = { ...base, rate_review_row_id: 'r1', sent_at: new Date(), metadata: { letter } };
  const { status, body } = await get(TOKEN);
  expect(status).toBe(200);
  expect(body.review).toMatchObject({ costBlock: 'Costs went up.', lines: [{ service: 'Pest control', current: '$117', next: '$121', change: '$4' }] });
});

test('an undelivered rate review notice is a 404, never counted or flipped to viewed', async () => {
  mockRows.notice = { ...base, rate_review_row_id: 'r1', sent_at: null, status: 'draft', metadata: {} };
  const { status } = await get(TOKEN);
  expect(status).toBe(404);
  await new Promise((r) => setTimeout(r, 10));
  expect(mockRows.updates).toEqual([]);
});

test('a legacy monthly notice is unchanged: no review field', async () => {
  mockRows.notice = { ...base, rate_review_row_id: null, sent_at: new Date(), metadata: {} };
  const { status, body } = await get(TOKEN);
  expect(status).toBe(200);
  expect(body).not.toHaveProperty('review');
  expect(body).toMatchObject({ currentPrice: '$117', newPrice: '$121' });
});
