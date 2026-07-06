/**
 * GET /api/public/ui-flags — the portal/login release-switch payload
 * (GATE_PORTAL_GLASS). The shell has no per-page token payload, so this tiny
 * public endpoint is how the client learns glass is released; it must never
 * cache (gate flips propagate on next load) and must mirror the gate.
 */
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));

const express = require('express');
const { isEnabled } = require('../config/feature-gates');

// No supertest in this repo — run the real router on an ephemeral port and
// hit it with the built-in fetch.
let server;
let base;

beforeAll((done) => {
  const app = express();
  app.use('/api/public/ui-flags', require('../routes/public-ui-flags'));
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  isEnabled.mockReset();
  isEnabled.mockReturnValue(false);
});

describe('GET /api/public/ui-flags', () => {
  it('serves the flag payload with no-store caching', async () => {
    const res = await fetch(`${base}/api/public/ui-flags`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ portalGlass: false });
    expect(isEnabled).toHaveBeenCalledWith('portalGlassTheme');
  });

  it('mirrors the portalGlassTheme gate when released', async () => {
    isEnabled.mockImplementation((key) => key === 'portalGlassTheme');
    const res = await fetch(`${base}/api/public/ui-flags`);
    expect(await res.json()).toEqual({ portalGlass: true });
  });
});
