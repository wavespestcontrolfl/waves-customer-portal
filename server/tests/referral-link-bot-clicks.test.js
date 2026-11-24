/**
 * /r/:code click tracking (referral Step 1, owner 2026-11-20): crawlers and
 * link-preview fetchers still get the redirect and a click row, but never
 * count as a unique click or raise the promoter's click total. Prod read
 * 2026-11-20: 21 of 62 clicks since May came from bot or preview agents.
 */
const calls = { inserts: [], increments: [] };
const PROMOTER = { id: 'promoter-1', referral_code: 'WAVES-TEST01', status: 'active' };

jest.mock('../models/db', () => {
  const builder = (table) => {
    const b = {
      where: () => b,
      first: async () => (table === 'referral_promoters' ? PROMOTER : null),
      insert: async (row) => { calls.inserts.push(row); return [1]; },
      increment: async (cols) => { calls.increments.push(cols); return 1; },
    };
    return b;
  };
  return jest.fn(builder);
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const router = require('../routes/referral-links');

// Real listen + fetch round-trips (repo has no supertest at the root).
let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use('/r', router);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

const click = async (ua) => {
  const res = await fetch(`${baseUrl}/r/WAVES-TEST01`, { redirect: 'manual', headers: { 'user-agent': ua } });
  return { status: res.status, location: res.headers.get('location') };
};

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const INSTAGRAM_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.0';
const IMESSAGE_PREVIEW = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0';

beforeEach(() => { calls.inserts.length = 0; calls.increments.length = 0; });

test('a person on a phone is a unique mobile click and raises the click total', async () => {
  const res = await click(IPHONE);
  expect(res.status).toBe(302);
  expect(res.location).toBe('https://wavespestcontrol.com/?ref=WAVES-TEST01&utm_source=referral');
  expect(calls.inserts).toHaveLength(1);
  expect(calls.inserts[0]).toMatchObject({ is_unique: true, device_type: 'mobile' });
  expect(calls.increments).toEqual([{ total_clicks: 1 }]);
});

test.each([
  ['an iMessage link preview', IMESSAGE_PREVIEW],
  ['Googlebot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
  ['a command-line fetch', 'curl/8.7.1'],
  ['an uptime monitor', 'Pingdom.com_bot_version_1.4_(http://www.pingdom.com/)'],
  ['a Node script', 'node-fetch/1.0 (+https://github.com/bitinn/node-fetch)'],
  ['an axios client', 'axios/1.7.2'],
])('%s still redirects and is recorded, but is not a unique click', async (_label, ua) => {
  const res = await click(ua);
  expect(res.status).toBe(302);
  expect(res.location).toBe('https://wavespestcontrol.com/?ref=WAVES-TEST01&utm_source=referral');
  expect(calls.inserts).toHaveLength(1);
  expect(calls.inserts[0]).toMatchObject({ is_unique: false, device_type: 'bot' });
  expect(calls.increments).toHaveLength(0);
});

test('an empty user agent is a bot', () => {
  expect(router._isBotUserAgent('')).toBe(true);
  expect(router._isBotUserAgent(undefined)).toBe(true);
});

test('an in-app browser (a person tapping the link inside Instagram) is not a bot', () => {
  expect(router._isBotUserAgent(INSTAGRAM_APP)).toBe(false);
  expect(router._isBotUserAgent(IPHONE)).toBe(false);
  expect(router._isBotUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')).toBe(false);
});
