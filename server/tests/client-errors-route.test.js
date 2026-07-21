/**
 * P2 (07-19 admin audit): there was no client-side error telemetry — React
 * boundary crashes and admin handler failures only hit console/alert. This
 * receiver forwards a client error to Sentry (server-side), tagged source=client,
 * with every field truncated. Unauthenticated by design (an anonymous page can
 * crash too) but rate-limited.
 */

const mockCapture = jest.fn();
jest.mock('@sentry/node', () => ({ captureException: (...args) => mockCapture(...args) }));
jest.mock('express-rate-limit', () => () => (_req, _res, next) => next());

const express = require('express');
const router = require('../routes/client-errors');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/client-errors', router);
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });
beforeEach(() => mockCapture.mockClear());

const post = (body) => fetch(`${baseUrl}/api/client-errors`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('POST /api/client-errors', () => {
  test('forwards to Sentry tagged source=client (CaptureContext object) and returns 204', async () => {
    const res = await post({ message: 'Boom', stack: 'at x', componentStack: 'in <App>', context: 'PageErrorBoundary', url: '/admin/banking' });
    expect(res.status).toBe(204);
    expect(mockCapture).toHaveBeenCalledTimes(1);

    const [error, captureContext] = mockCapture.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Boom');
    // @sentry/node 10.x: object form, not a scope callback.
    expect(typeof captureContext).toBe('object');
    expect(captureContext.tags).toEqual({ source: 'client' });
    expect(captureContext.contexts.client_error).toMatchObject({
      context: 'PageErrorBoundary', url: '/admin/banking',
    });
  });

  test('truncates oversized fields before forwarding', async () => {
    // Spaced words (not one long token) so truncation, not redaction, is under test.
    const res = await post({ message: 'word '.repeat(500), stack: 'at frame '.repeat(2000) });
    expect(res.status).toBe(204);
    const [error, captureContext] = mockCapture.mock.calls[0];
    expect(error.message.length).toBe(500);
    expect(captureContext.contexts.client_error.stack.length).toBe(4000);
  });

  test('scrubs a token-route url server-side (defense in depth)', async () => {
    await post({ message: 'x', url: '/estimate/short3' });
    const [, captureContext] = mockCapture.mock.calls[0];
    expect(captureContext.contexts.client_error.url).toBe('/estimate/:token');
  });

  test('redacts tokens (browser+api+nested), JWTs, emails, phones in free-form fields', async () => {
    await post({
      message: 'Failed to load /report/AbC123secretTOKEN for jane@example.com call 941-555-1234',
      stack: [
        'GET /api/estimates/abc/data 401', // api form, short token, nested
        '/pay/statement/xyztok401', // nested — whole tail must go
        'Bearer eyJhbGciOi.J9payload.sigsigsig',
      ].join('\n'),
    });
    const [error, captureContext] = mockCapture.mock.calls[0];
    expect(error.message).toBe('Failed to load /report/:token for :email call :phone');
    const stack = captureContext.contexts.client_error.stack;
    expect(stack).toContain('/api/estimates/:token');
    expect(stack).toContain('/pay/:token');
    expect(stack).not.toMatch(/statement|xyztok|abc\/data|eyJhbGciOi/);
    expect(captureContext.contexts.client_error.userAgent).toBeUndefined();
  });

  test('a missing message still reports (never 500s)', async () => {
    const res = await post({});
    expect(res.status).toBe(204);
    expect(mockCapture.mock.calls[0][0].message).toBe('Client error (no message)');
  });
});
