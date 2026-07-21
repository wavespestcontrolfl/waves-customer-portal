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
    const res = await post({ name: 'TypeError', context: 'PageErrorBoundary', route: '/admin/banking' });
    expect(res.status).toBe(204);
    const [error, captureContext] = mockCapture.mock.calls[0];
    expect(error.name).toBe('TypeError');
    expect(captureContext.tags).toEqual({ source: 'client' });
    expect(ctxOf()).toEqual({ context: 'PageErrorBoundary', route: 'admin' });
    // Explicit fingerprint so distinct (name, context, route) classes don't all
    // collapse into one Sentry issue via the shared synthetic stack.
    expect(captureContext.fingerprint).toEqual(['client-error', 'TypeError', 'PageErrorBoundary', 'admin']);
  });

  test('distinct failure classes get distinct fingerprints', async () => {
    await post({ name: 'TypeError', context: 'banking:payout', route: '/admin/x' });
    const fpA = mockCapture.mock.calls[0][1].fingerprint;
    mockCapture.mockClear();
    await post({ name: 'RangeError', context: 'PageErrorBoundary', route: '/report/t' });
    const fpB = mockCapture.mock.calls[0][1].fingerprint;
    expect(fpA).toEqual(['client-error', 'TypeError', 'banking:payout', 'admin']);
    expect(fpB).toEqual(['client-error', 'RangeError', 'PageErrorBoundary', 'report']);
  });

  test('componentStack is never accepted (unbounded → could carry PII)', async () => {
    await post({ name: 'TypeError', route: '/admin/x', componentStack: 'in AdamBenetti' });
    expect(ctxOf()).not.toHaveProperty('componentStack');
    expect(JSON.stringify(mockCapture.mock.calls[0])).not.toMatch(/AdamBenetti/);
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

  test('context is an allowlist — shape-valid attacker text (PAN) is dropped', async () => {
    await post({ name: 'E', context: 'banking:payout', route: '/admin/x' });
    expect(ctxOf().context).toBe('banking:payout'); // known label passes
    mockCapture.mockClear();
    await post({ name: 'E', context: 'a4242424242424242', route: '/admin/x' });
    expect(ctxOf().context).toBeUndefined(); // shape-valid but not allowlisted
  });

  test('name is a strict allowlist — PANs and person-names collapse to Error', async () => {
    for (const bad of ['4242424242424242', 'a4242424242424242', 'AdamBenetti', 'DropTable']) {
      mockCapture.mockClear();
      await post({ name: bad, route: '/admin/x' });
      expect(mockCapture.mock.calls[0][0].name).toBe('Error');
    }
    for (const ok of ['TypeError', 'ChunkLoadError', 'RangeError']) {
      mockCapture.mockClear();
      await post({ name: ok, route: '/admin/x' });
      expect(mockCapture.mock.calls[0][0].name).toBe(ok);
    }
  });

  test('a missing/empty body still returns 204 (never 500s)', async () => {
    const res = await post({});
    expect(res.status).toBe(204);
    expect(mockCapture.mock.calls[0][0].name).toBe('Error');
  });
});
