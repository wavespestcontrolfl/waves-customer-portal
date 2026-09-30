/**
 * /l/:code click rows: a customer's human click writes a short_code_clicks
 * row (what the click-followup queue and the activity timeline read as
 * engagement); a staff preview (signed waves_admin marker cookie, or an IP on
 * WAVES_ADMIN_IPS) still redirects but writes NO row; bots write none either.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ jwt: { secret: 'shortlink-staff-test-secret' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../models/db');

const HUMAN_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1';
const ROW = { id: 'sc-1', code: 'abcdefghjk', target_url: 'https://portal.example.test/estimate/tok', expires_at: null };
const inserts = [];
const updates = [];

function makeBuilder(table) {
  const b = {};
  b.where = jest.fn(() => b);
  b.first = jest.fn(() => Promise.resolve(table === 'short_codes' ? ROW : undefined));
  b.insert = jest.fn((payload) => { inserts.push({ table, payload }); return Promise.resolve([1]); });
  b.update = jest.fn((payload) => { updates.push({ table, payload }); return Promise.resolve(1); });
  return b;
}

let server;
let base;
const savedIps = process.env.WAVES_ADMIN_IPS;

beforeAll((done) => {
  db.mockImplementation((table) => makeBuilder(table));
  db.raw = jest.fn((expr) => expr);
  const app = express();
  app.use('/l', require('../routes/public-shortlinks'));
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  if (savedIps === undefined) delete process.env.WAVES_ADMIN_IPS; else process.env.WAVES_ADMIN_IPS = savedIps;
  server.close(done);
});
beforeEach(() => { inserts.length = 0; updates.length = 0; delete process.env.WAVES_ADMIN_IPS; });

const hit = async (headers = {}) => {
  const res = await fetch(`${base}/l/${ROW.code}`, { redirect: 'manual', headers: { 'user-agent': HUMAN_UA, ...headers } });
  await new Promise((r) => setImmediate(r)); // the telemetry is fire-and-forget
  return res;
};
const clickRows = () => inserts.filter((i) => i.table === 'short_code_clicks');

describe('GET /l/:code click rows', () => {
  test('a customer click redirects and writes a click row', async () => {
    const res = await hit();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(ROW.target_url);
    expect(clickRows()).toHaveLength(1);
    expect(clickRows()[0].payload).toMatchObject({ short_code_id: 'sc-1', is_bot: false });
  });

  test('a staff browser (signed waves_admin marker) redirects but writes no click row', async () => {
    const marker = jwt.sign({ kind: 'admin_marker', sub: 't1' }, 'shortlink-staff-test-secret');
    const res = await hit({ cookie: `waves_admin=${encodeURIComponent(marker)}` });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(ROW.target_url);
    expect(clickRows()).toHaveLength(0);
    // the cheap aggregate counter is unchanged behavior: still bumped
    expect(updates.some((u) => u.table === 'short_codes' && u.payload.click_count)).toBe(true);
  });

  test('a forged waves_admin cookie does not exempt the click', async () => {
    const forged = jwt.sign({ kind: 'admin_marker', sub: 't1' }, 'some-other-secret');
    await hit({ cookie: `waves_admin=${encodeURIComponent(forged)}` });
    expect(clickRows()).toHaveLength(1);
  });

  test('a click from an IP on WAVES_ADMIN_IPS writes no click row', async () => {
    process.env.WAVES_ADMIN_IPS = '198.51.100.7';
    const res = await hit({ 'x-forwarded-for': '198.51.100.7' });
    expect(res.status).toBe(302);
    expect(clickRows()).toHaveLength(0);
    await hit({ 'x-forwarded-for': '203.0.113.50' });
    expect(clickRows()).toHaveLength(1);
  });
});
