/**
 * /og link-preview image route — the public-route contract
 * (docs/public-route-contracts.md): token cards carry the privacy headers,
 * an unknown / invalid / dark link is byte-identical to the default card
 * (no existence oracle), token-free cards are publicly cacheable, and the
 * render cache follows what the card shows, not the token.
 */
const express = require('express');

jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../services/link-preview-metadata', () => ({
  FIXED_CARDS: { pay: { eyebrow: 'INVOICE', headline: 'Your invoice', subline: 'View and pay securely online' } },
  resolveCardContent: jest.fn(),
}));
// The image bytes spell out the content, so a test can see what rendered.
jest.mock('../services/link-preview-card-renderer', () => ({
  renderLinkPreviewJpeg: jest.fn(async (c) => Buffer.from(JSON.stringify([c.eyebrow, c.headline, c.subline]))),
}));

const { resolveCardContent } = require('../services/link-preview-metadata');
const { renderLinkPreviewJpeg } = require('../services/link-preview-card-renderer');
const router = require('../routes/og-preview');

async function withServer(fn) {
  const app = express();
  app.set('trust proxy', false);
  app.use('/og', router);
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const HEX = 'a'.repeat(64);
const get = async (base, path) => {
  const res = await fetch(base + path);
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()).toString() };
};

beforeEach(() => {
  resolveCardContent.mockReset();
  router._internals.cache.clear();
});

test('a token card carries the privacy headers', async () => withServer(async (base) => {
  resolveCardContent.mockResolvedValue({ eyebrow: 'APPOINTMENT', headline: 'Pest Control', subline: 'October 2, 2026' });
  const res = await get(base, `/og/appointment/${HEX}.jpg`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/jpeg');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('x-robots-tag')).toBe('noindex');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.body).toContain('Pest Control');
}));

test('unknown, malformed and unregistered links are byte-identical to the default card', async () => withServer(async (base) => {
  resolveCardContent.mockResolvedValue(null);
  const def = await get(base, '/og/default.jpg');
  for (const path of [`/og/appointment/${HEX}.jpg`, '/og/appointment/not-a-jpg', '/og/nope/x.jpg']) {
    const res = await get(base, path);
    expect(res.status).toBe(200);
    expect(res.body).toBe(def.body);
    expect(res.headers.get('cache-control')).toBe('no-store');
  }
}));

test('a moved appointment renders its new content, never the cached old slot', async () => withServer(async (base) => {
  resolveCardContent.mockResolvedValueOnce({ eyebrow: 'APPOINTMENT', headline: 'Pest Control', subline: 'October 2, 2026' });
  expect((await get(base, `/og/appointment/${HEX}.jpg`)).body).toContain('October 2');
  resolveCardContent.mockResolvedValueOnce({ eyebrow: 'APPOINTMENT', headline: 'Pest Control', subline: 'View your visit details' });
  const after = await get(base, `/og/appointment/${HEX}.jpg`);
  expect(after.body).toContain('View your visit details');
  expect(after.body).not.toContain('October 2');
}));

test('token-free cards are public and cacheable; an unknown name gets the default', async () => withServer(async (base) => {
  const pay = await get(base, '/og/pay.jpg');
  expect(pay.body).toContain('Your invoice');
  expect(pay.headers.get('cache-control')).toBe('public, max-age=3600');
  expect(pay.headers.get('x-robots-tag')).toBeNull();
  expect((await get(base, '/og/constructor.jpg')).body).toBe((await get(base, '/og/default.jpg')).body);
  expect(resolveCardContent).not.toHaveBeenCalled();
  expect(renderLinkPreviewJpeg).toHaveBeenCalled();
}));
