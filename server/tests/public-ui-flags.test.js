/**
 * GET /api/public/ui-flags — legacy portal release-switch payload. The
 * GATE_PORTAL_GLASS gate was retired (glass is the unconditional portal theme
 * now), so this endpoint always affirms `portalGlass: true`. It is kept only so
 * any still-cached Capacitor app bundle that polls it stays on glass rather
 * than reverting. Must never cache — a response must reach clients on next load.
 */
const express = require('express');

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

describe('GET /api/public/ui-flags', () => {
  it('always affirms portalGlass with no-store caching', async () => {
    const res = await fetch(`${base}/api/public/ui-flags`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ portalGlass: true });
  });
});
