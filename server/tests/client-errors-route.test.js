/**
 * P2 (07-19 admin audit): there was no client-side error telemetry. This
 * receiver forwards a client error to Sentry (server-side), tagged
 * source=client. It is PUBLIC and rate-limited, so every attacker-controllable
 * field is strictly TRANSFORMED into a non-sensitive shape — no free-form text
 * (which could carry tokens, PANs, SSNs, emails, PII) is ever forwarded.
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
const ctxOf = () => mockCapture.mock.calls[0][1].contexts.client_error;

describe('POST /api/client-errors', () => {
  test('forwards a well-formed report tagged source=client and returns 204', async () => {
    const res = await post({
      name: 'TypeError', context: 'PageErrorBoundary', route: '/admin/banking',
      componentStack: '\n    in BankingPage\n    in div\n    in Router',
    });
    expect(res.status).toBe(204);
    const [error, captureContext] = mockCapture.mock.calls[0];
    expect(error.name).toBe('TypeError');
    expect(captureContext.tags).toEqual({ source: 'client' });
    expect(ctxOf()).toEqual({
      context: 'PageErrorBoundary',
      route: 'admin',
      componentStack: 'in BankingPage\nin div\nin Router',
    });
  });

  test('reduces the route to an allowlisted root — token/PII tails never persist', async () => {
    await post({ name: 'E', route: '/report/AbC123secretTOKEN' });
    expect(ctxOf().route).toBe('report');
    mockCapture.mockClear();
    await post({ name: 'E', route: '/estimate/abc' }); // legacy short slug
    expect(ctxOf().route).toBe('estimate');
    mockCapture.mockClear();
    // an attacker cannot smuggle a PAN through the admin passthrough
    await post({ name: 'E', route: '/admin/4242424242424242' });
    expect(ctxOf().route).toBe('admin');
    mockCapture.mockClear();
    await post({ name: 'E', route: '/evil/4242424242424242' });
    expect(ctxOf().route).toBe('other');
  });

  test('rejects non-conforming name and context (no attacker text echoed)', async () => {
    await post({
      name: '4242424242424242',       // a PAN in the name field
      context: '123-45-6789',          // an SSN in the context field
      route: '/admin/x',
    });
    const [error] = mockCapture.mock.calls[0];
    expect(error.name).toBe('Error');
    expect(ctxOf().context).toBeUndefined();
  });

  test('componentStack keeps only "in/at ComponentName" tokens, dropping injected PII', async () => {
    await post({
      name: 'E', route: '/admin/x',
      componentStack: 'in BankingPage\nSSN 123-45-6789 card 4242424242424242\n at PayoutModal',
    });
    const stack = ctxOf().componentStack;
    expect(stack).toBe('in BankingPage\nat PayoutModal');
    expect(stack).not.toMatch(/123-45-6789|4242/);
  });

  test('a missing/empty body still returns 204 (never 500s)', async () => {
    const res = await post({});
    expect(res.status).toBe(204);
    expect(mockCapture.mock.calls[0][0].name).toBe('Error');
  });
});
