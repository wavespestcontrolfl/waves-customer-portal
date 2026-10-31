/**
 * The manual newsletter tools are gone (owner 2026-10-30: "this should be
 * fully autonomous"): Compose, the AI draft, the digest planner, test email,
 * preview, schedule, Send now, the editorial calendar and the audience picker.
 * The weekly issue is drafted by the Monday autopilot and sent through the
 * proof flow. A removed route that comes back would let a person start a
 * campaign the autopilot does not know about, so every one is pinned absent,
 * and the routes History and the autopilot still need are pinned present.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technician = { id: 'admin-1', role: 'admin' }; req.techRole = 'admin'; return next(); },
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const express = require('express');
const router = require('../routes/admin-newsletter');

const SEND_UUID = '11111111-2222-4333-8444-555555555555';

const mounted = new Set(
  router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) => Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${layer.route.path}`)),
);

const REMOVED = [
  'GET /sends/latest-autopilot',
  'POST /sends',
  'PATCH /sends/:id',
  'POST /sends/:id/test',
  'POST /sends/:id/send',
  'POST /sends/:id/schedule',
  'POST /sends/:id/validate',
  'POST /preview',
  'GET /tags',
  'GET /quizzes',
  'POST /segment-preview',
  'POST /draft-ai',
  'POST /events/digest-plan',
  'GET /events/approved-ids',
  'GET /calendar',
  'POST /calendar',
  'PATCH /calendar/:id',
  'POST /calendar/:id/draft-from-plan',
];

const KEPT = [
  'GET /sends',
  'GET /sends/:id',
  'DELETE /sends/:id',
  'POST /sends/:id/resume',
  'POST /sends/:id/cancel-schedule',
  'GET /sends/:id/quiz-results',
  'GET /subscribers',
  'POST /subscribers',
  'POST /subscribers/import',
  'DELETE /subscribers/:subscriberId',
  'GET /events',
  'GET /events/inbox',
  'PATCH /events/:id',
  'POST /events/bulk-action',
  'POST /events/merge',
];

test.each(REMOVED)('%s is not mounted', (route) => {
  expect(mounted.has(route)).toBe(false);
});

test.each(KEPT)('%s stays mounted for History, Subscribers and the Events inbox', (route) => {
  expect(mounted.has(route)).toBe(true);
});

test('a request to a removed route finds no handler', async () => {
  const app = express();
  app.use(express.json());
  app.use('/admin/newsletter', router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/admin/newsletter`;
  try {
    const attempts = [
      ['POST', '/sends', { subject: 'Hand-written campaign' }],
      ['PATCH', `/sends/${SEND_UUID}`, { subject: 'Edited' }],
      ['POST', `/sends/${SEND_UUID}/send`, {}],
      ['POST', `/sends/${SEND_UUID}/schedule`, {}],
      ['POST', '/draft-ai', { prompt: 'write it' }],
      ['POST', '/calendar', { weekOf: '2035-01-02' }],
      ['GET', '/calendar', undefined],
    ];
    for (const [method, path, body] of attempts) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      expect([method, path, res.status]).toEqual([method, path, 404]);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
