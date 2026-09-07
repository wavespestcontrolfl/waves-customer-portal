/**
 * P2 (07-19 admin audit): there was no client-side error telemetry. This
 * receiver forwards a client error to Sentry (server-side), tagged
 * source=client. It is PUBLIC and rate-limited, so every attacker-controllable
 * field is strictly TRANSFORMED into a non-sensitive shape — no free-form text
 * (which could carry tokens, PANs, SSNs, emails, PII) is ever forwarded.
 */

const mockCapture = jest.fn();
const mockCaptureMessage = jest.fn();
jest.mock('@sentry/node', () => ({
  captureException: (...args) => mockCapture(...args),
  captureMessage: (...args) => mockCaptureMessage(...args),
}));
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
beforeEach(() => {
  mockCapture.mockClear();
  mockCaptureMessage.mockReset();
});

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
    expect(captureContext.tags).toEqual({
      source: 'client',
      // Promoted to tags (not just contexts) so alert emails name the page.
      client_context: 'PageErrorBoundary',
      client_route: 'admin/banking',
    });
    expect(ctxOf()).toEqual({ context: 'PageErrorBoundary', route: 'admin/banking' });
    // Explicit fingerprint so distinct (name, context, route) classes don't all
    // collapse into one Sentry issue via the shared synthetic stack.
    expect(captureContext.fingerprint).toEqual(['client-error', 'TypeError', 'PageErrorBoundary', 'admin/banking']);
  });

  test('admin/tech keep only an ALLOWLISTED page segment; attacker text drops to root', async () => {
    for (const [route, expected] of [
      ['/admin/banking', 'admin/banking'], // known admin page kept
      ['/admin/dashboard', 'admin/dashboard'],
      ['/tech/route', 'tech/route'], // known tech page kept
      ['/admin/4242424242424242', 'admin'], // injected digit tail dropped
      ['/admin/a4242424242', 'admin'], // mixed with digits dropped
      ['/admin/adambenetti', 'admin'], // identifier-shaped person name → not allowlisted → root
      ['/tech/main-street', 'tech'], // identifier-shaped address → not allowlisted → root
    ]) {
      mockCapture.mockClear();
      await post({ name: 'E', route });
      expect(ctxOf().route).toBe(expected);
    }
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
    // Tag values are never undefined — missing fields collapse to 'none'.
    expect(mockCapture.mock.calls[0][1].tags).toEqual({
      source: 'client', client_context: 'none', client_route: 'none',
    });
  });

  test('native replay diagnostics identify platform, source and route families without creating an error', async () => {
    const res = await post({
      context: 'native-links',
      nativeLink: { platform: 'ios', source: 'launch', outcome: 'replay-skipped', route: 'home', target: 'shortlink' },
    });
    expect(res.status).toBe(204);
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalledWith('Native link: replay-skipped', {
      level: 'info',
      fingerprint: ['native-link', 'ios', 'launch', 'replay-skipped'],
      tags: {
        source: 'client', client_context: 'native-links', native_platform: 'ios',
        link_source: 'launch', link_outcome: 'replay-skipped', link_route: 'home', link_target: 'shortlink',
      },
    });
  });

  test.each(['listener-error', 'lookup-error', 'lookup-timeout', 'storage-unavailable', 'navigation-failed'])(
    'native %s reports at error severity', async (outcome) => {
      await post({
        context: 'native-links',
        nativeLink: { platform: 'android', source: 'event', outcome, route: 'estimate', target: 'none' },
      });
      expect(mockCaptureMessage.mock.calls[0][1].level).toBe('error');
      expect(mockCaptureMessage.mock.calls[0][1].tags.native_platform).toBe('android');
    },
  );

  test('native diagnostics ignore URLs, tokens, messages and extra fields at every level', async () => {
    await post({
      context: 'native-links', name: 'private-test-name', route: '/estimate/private-test-token',
      message: 'private-test-message',
      nativeLink: {
        platform: 'ios', source: 'event', outcome: 'navigation-requested', route: 'home', target: 'estimate',
        url: 'https://example.invalid/estimate/private-test-token', stack: 'private-test-stack',
      },
    });
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCapture).not.toHaveBeenCalled();
    expect(JSON.stringify(mockCaptureMessage.mock.calls)).not.toMatch(/private-test|https?:/);
  });

  test.each(['platform', 'source', 'outcome', 'route', 'target'])(
    'native %s must be an exact allowlisted label', async (field) => {
      for (const value of ['private-test-token', '/estimate/private-test-token', {}, null, ['ios']]) {
        const res = await post({
          context: 'native-links',
          nativeLink: {
            platform: 'ios', source: 'launch', outcome: 'received', route: 'home', target: 'estimate',
            [field]: value,
          },
        });
        expect(res.status).toBe(204);
      }
      expect(mockCaptureMessage).not.toHaveBeenCalled();
      expect(mockCapture).not.toHaveBeenCalled();
    },
  );

  test('missing native fields are discarded without falling through to generic error reporting', async () => {
    for (const nativeLink of [undefined, null, {}, 'private-test-token']) {
      const res = await post({ context: 'native-links', nativeLink });
      expect(res.status).toBe(204);
    }
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  test('a failing native diagnostic sink still returns 204', async () => {
    mockCaptureMessage.mockImplementationOnce(() => { throw new Error('sink unavailable'); });
    const res = await post({
      context: 'native-links',
      nativeLink: { platform: 'ios', source: 'launch', outcome: 'empty', route: 'home', target: 'none' },
    });
    expect(res.status).toBe(204);
  });
});
