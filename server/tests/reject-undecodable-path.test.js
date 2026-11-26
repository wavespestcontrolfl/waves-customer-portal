// rejectUndecodablePath (server/index.js, before the global /api/ limiter): a token segment that does not percent-decode
// answers the mount's generic unknown-token 404 instead of Express's param-decode error (the production handler logs the raw
// segment and answers 500). It is not counted by the limiter, not logged, and a normal path is untouched.

const express = require('express');
const { rejectUndecodablePath } = require('../middleware/reject-undecodable-path');

const BAD = '%E0%A4%A';

function build() {
  const seen = { limiter: 0, errors: [] };
  const app = express();
  app.use(['/api/estimates', '/api/pay', '/api/public/secure-card'], rejectUndecodablePath);
  app.use('/api/', (req, res, next) => { seen.limiter += 1; next(); });
  for (const mount of ['/api/estimates', '/api/pay', '/api/pay/statement', '/api/public/secure-card']) {
    const router = express.Router();
    router.get('/:token/data', (req, res) => res.json({ reached: req.params.token }));
    app.use(mount, router);
  }
  // Stands in for the production error handler: it would log the raw segment and answer 500.
   
  app.use((err, req, res, next) => { seen.errors.push(err.message); res.status(500).json({ error: 'Internal error' }); });
  return { app, seen };
}

async function get(app, path) {
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') };
  } finally { server.close(); }
}

describe('rejectUndecodablePath', () => {
  test.each([
    ['/api/estimates', 'Estimate not found'],
    ['/api/pay', 'Invoice not found'],
    ['/api/public/secure-card', 'Not found'],
  ])('%s: an undecodable token is the mount\'s generic 404, not counted, not an error', async (mount, error) => {
    const { app, seen } = build();
    const res = await get(app, `${mount}/${BAD}/data`);
    expect(res).toMatchObject({ status: 404, body: { error } });
    expect(JSON.stringify(res)).not.toContain('E0');
    expect(seen.limiter).toBe(0);
    expect(seen.errors).toEqual([]);
  });

  test.each([
    ['/API/PAY', 'Invoice not found'],
    ['/Api/Estimates', 'Estimate not found'],
    ['/api/PUBLIC/Secure-Card', 'Not found'],
    ['/api/estimates/', 'Estimate not found'],
  ])('%s: the mount matches case-insensitively and the lookup follows', async (mount, error) => {
    const { app, seen } = build();
    const res = await get(app, `${mount.replace(/\/$/, '')}/${BAD}/data`);
    expect(res).toMatchObject({ status: 404, body: { error } });
    expect(seen.limiter).toBe(0);
    expect(seen.errors).toEqual([]);
  });

  test('/API/PAY/STATEMENT keeps its own answer and an encoded slash still decodes', async () => {
    const { app, seen } = build();
    expect((await get(app, `/API/PAY/Statement/${BAD}/data`)).status).toBe(500);
    expect((await get(app, '/api/estimates/a%2Fb/data')).body).toEqual({ reached: 'a/b' });
    expect(seen.errors).toHaveLength(1);
  });

  test('estimates get the generic header pair; secure-card keeps the privacy set an earlier mount stamped', async () => {
    const est = await get(build().app, `/api/estimates/${BAD}/data`);
    expect(est.cache).toBe('no-store');
    const app = express();
    app.use('/api/public/secure-card', (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
    app.use('/api/public/secure-card', rejectUndecodablePath);
    expect((await get(app, `/api/public/secure-card/${BAD}/data`)).cache).toBe('private, no-store');
  });

  test('the pay mount keeps its noStore headers on that 404', async () => {
    expect((await get(build().app, `/api/pay/${BAD}/data`)).cache).toBe('no-store, no-cache, must-revalidate');
  });

  test('a decodable path is untouched and still counted by the limiter', async () => {
    const { app, seen } = build();
    expect((await get(app, '/api/estimates/abc%20def/data')).body).toEqual({ reached: 'abc def' });
    expect(seen.limiter).toBe(1);
  });

  test('/api/pay/statement keeps its own answer', async () => {
    const { app, seen } = build();
    expect((await get(app, `/api/pay/statement/${BAD}/data`)).status).toBe(500);
    expect(seen.errors).toHaveLength(1);
  });
});
