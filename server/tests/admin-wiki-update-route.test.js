/**
 * POST /api/admin/wiki/update/:slug — Regenerate on a track page must pass the
 * stored grass_track id (from the title), not the slugified slug: outcomes are
 * keyed 'st_augustine', so 'st-augustine' matched nothing and the page could
 * never be regenerated (2026-09-28).
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technician = { role: 'admin' }; next(); },
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/agronomic-wiki', () => ({
  getPage: jest.fn(),
  updateTrackPage: jest.fn(),
  trackIdFromPage: jest.requireActual('../services/agronomic-wiki').trackIdFromPage,
}));

const express = require('express');
const wiki = require('../services/agronomic-wiki');
const router = require('../routes/admin-wiki');

// Real listen + fetch round-trip (repo has no supertest).
let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/wiki', router);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

test('track page regenerates with the grass_track id from its title', async () => {
  wiki.getPage.mockResolvedValue({ slug: 'track/st-augustine', category: 'track', title: 'Track st_augustine Performance' });
  wiki.updateTrackPage.mockResolvedValue({ slug: 'track/st-augustine' });

  const res = await fetch(`${baseUrl}/api/admin/wiki/update/track/st-augustine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });

  expect(res.status).toBe(200);
  expect(wiki.updateTrackPage).toHaveBeenCalledWith('st_augustine');
});
