/**
 * Contract tests for middleware/link-worker-auth (backlink plan §12/§3.4c):
 * canonical-target signing, raw-body hashing, replay protection, the bearer
 * transition, and the pre-handler audit row. DB is mocked (house style).
 */
const crypto = require('crypto');

const nonceInserts = [];
const auditRows = [];
let nonceInsertShouldConflict = false;

const mockDb = jest.fn((table) => {
  if (table === 'seo_link_worker_nonces') {
    return {
      insert: jest.fn(async (row) => {
        if (nonceInsertShouldConflict) {
          const err = new Error('duplicate key value violates unique constraint');
          err.code = '23505';
          throw err;
        }
        nonceInserts.push(row);
        return [1];
      }),
      where: jest.fn(() => ({ del: jest.fn(async () => 0) })),
    };
  }
  if (table === 'seo_link_worker_requests') {
    return {
      insert: jest.fn(() => ({
        returning: jest.fn(async () => {
          const row = { id: `req-${auditRows.length + 1}` };
          auditRows.push(row);
          return [row];
        }),
      })),
      where: jest.fn((match) => ({
        update: jest.fn(async (patch) => {
          auditRows.push({ finalized: match.id, ...patch });
          return 1;
        }),
      })),
    };
  }
  throw new Error(`unexpected table ${table}`);
});
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));

const { isEnabled } = require('../config/feature-gates');
const {
  linkWorkerAuth,
  finalizeWorkerRequest,
  rawBodyVerify,
  canonicalTarget,
  signCanonical,
} = require('../middleware/link-worker-auth');

const SECRET = 'test-secret';

function makeReq({ method = 'GET', url = '/api/integrations/backlink-worker/claim?type=outreach&n=5', headers = {}, rawBody } = {}) {
  const [path, qs = ''] = url.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs).entries());
  const [baseUrl, tail] = [path.split('/').slice(0, 4).join('/'), '/' + path.split('/').slice(4).join('/')];
  return { method, originalUrl: url, baseUrl, path: tail, query, headers, rawBody };
}

function makeRes() {
  const res = { statusCode: 200 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

function signedHeaders({ method = 'GET', url, body, timestamp, nonce, keyId = 'hermes', secret = SECRET }) {
  const ts = timestamp || new Date().toISOString();
  const n = nonce || crypto.randomBytes(8).toString('hex');
  const bodyHash = crypto.createHash('sha256').update(body || Buffer.alloc(0)).digest('hex');
  const signature = signCanonical(secret, {
    timestamp: ts,
    nonce: n,
    method,
    target: canonicalTarget(url),
    bodyHash,
  });
  return { 'x-waves-key-id': keyId, 'x-waves-timestamp': ts, 'x-waves-nonce': n, 'x-waves-signature': signature };
}

async function drive(req, endpoint = 'claim') {
  const res = makeRes();
  const next = jest.fn();
  await linkWorkerAuth(endpoint)(req, res, next);
  return { res, next };
}

beforeEach(() => {
  nonceInserts.length = 0;
  auditRows.length = 0;
  nonceInsertShouldConflict = false;
  process.env.LINK_WORKER_SECRET_HERMES = SECRET;
  process.env.HERMES_SERVICE_TOKEN = 'legacy-bearer';
  isEnabled.mockReturnValue(true);
});

describe('link-worker-auth HMAC', () => {
  test('a signed bodyless GET verifies and writes an authenticated audit row', async () => {
    const url = '/api/integrations/backlink-worker/claim?type=outreach&n=5';
    const req = makeReq({ url, headers: signedHeaders({ url }) });
    const { res, next } = await drive(req);
    expect(next).toHaveBeenCalledWith();
    expect(res.statusCode).toBe(200);
    expect(req.linkWorker).toEqual({ provider: 'hermes', authScheme: 'hmac', keyId: 'hermes' });
    expect(req.linkWorkerRequestId).toBe('req-1');
    expect(nonceInserts).toHaveLength(1);
  });

  test('query-param order does not matter, but a CHANGED query is rejected', async () => {
    const signedUrl = '/api/integrations/backlink-worker/claim?type=outreach&n=5';
    const reordered = '/api/integrations/backlink-worker/claim?n=5&type=outreach';
    const headers = signedHeaders({ url: signedUrl });
    const ok = await drive(makeReq({ url: reordered, headers }));
    expect(ok.next).toHaveBeenCalledWith();
    // same signature replayed with a different mode/type → 401
    const tampered = '/api/integrations/backlink-worker/claim?n=5&type=signup';
    const bad = await drive(makeReq({ url: tampered, headers: signedHeaders({ url: signedUrl }) }));
    expect(bad.res.statusCode).toBe(401);
  });

  test('the signature covers the RAW body bytes — a re-serialized body fails', async () => {
    const url = '/api/integrations/backlink-worker/report';
    const body = Buffer.from('{"prospect_id": "x",  "outcome": "placed"}'); // extra whitespace
    const headers = signedHeaders({ method: 'POST', url, body });
    const okReq = makeReq({ method: 'POST', url, headers: { ...headers, 'content-length': String(body.length) }, rawBody: body });
    const ok = await drive(okReq, 'report');
    expect(ok.next).toHaveBeenCalledWith();

    const reserialized = Buffer.from(JSON.stringify({ prospect_id: 'x', outcome: 'placed' }));
    const badReq = makeReq({ method: 'POST', url, headers: { ...signedHeaders({ method: 'POST', url, body }), 'content-length': String(reserialized.length) }, rawBody: reserialized });
    const bad = await drive(badReq, 'report');
    expect(bad.res.statusCode).toBe(401);
  });

  test('a body-bearing request without captured raw bytes is rejected', async () => {
    const url = '/api/integrations/backlink-worker/report';
    const body = Buffer.from('{"a":1}');
    const req = makeReq({ method: 'POST', url, headers: { ...signedHeaders({ method: 'POST', url, body }), 'content-length': '7' } });
    const { res } = await drive(req, 'report');
    expect(res.statusCode).toBe(401);
  });

  test('a chunked body (no content-length) without captured raw bytes is rejected', async () => {
    const url = '/api/integrations/backlink-worker/report';
    const body = Buffer.from('a=1');
    const req = makeReq({ method: 'POST', url, headers: { ...signedHeaders({ method: 'POST', url, body }), 'transfer-encoding': 'chunked', 'content-type': 'application/x-www-form-urlencoded' } });
    const { res } = await drive(req, 'report');
    expect(res.statusCode).toBe(401);
  });

  test('a replayed nonce is rejected by the insert-first consumption', async () => {
    const url = '/api/integrations/backlink-worker/claim';
    const headers = signedHeaders({ url });
    const first = await drive(makeReq({ url, headers }));
    expect(first.next).toHaveBeenCalledWith();
    nonceInsertShouldConflict = true; // the second copy hits the primary key
    const second = await drive(makeReq({ url, headers }));
    expect(second.res.statusCode).toBe(401);
    expect(second.res.body.error).toMatch(/replayed/);
  });

  test('a stale timestamp is rejected', async () => {
    const url = '/api/integrations/backlink-worker/claim';
    const stale = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const { res } = await drive(makeReq({ url, headers: signedHeaders({ url, timestamp: stale }) }));
    expect(res.statusCode).toBe(401);
  });

  test('nonce rows are persisted with the SIGNED timestamp (sweep runs on it)', async () => {
    const url = '/api/integrations/backlink-worker/claim';
    const future = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    const { next } = await drive(makeReq({ url, headers: signedHeaders({ url, timestamp: future }) }));
    expect(next).toHaveBeenCalledWith();
    expect(nonceInserts[0].signed_ts.getTime()).toBe(Date.parse(future));
  });

  test('an unknown key id is 401; a known key without its env is 503', async () => {
    const url = '/api/integrations/backlink-worker/claim';
    const unknown = await drive(makeReq({ url, headers: signedHeaders({ url, keyId: 'nope' }) }));
    expect(unknown.res.statusCode).toBe(401);
    delete process.env.LINK_WORKER_SECRET_HERMES;
    const unconfigured = await drive(makeReq({ url, headers: signedHeaders({ url }) }));
    expect(unconfigured.res.statusCode).toBe(503);
  });

  test('a key cannot reach an endpoint outside its capability set', async () => {
    const url = '/api/integrations/vendor-price-worker/report';
    const { res } = await drive(makeReq({ method: 'POST', url, headers: signedHeaders({ method: 'POST', url }) }), 'vendor_price');
    expect(res.statusCode).toBe(403); // hermes key: claim/report only
  });

  test('commitments reader is HMAC-only and cannot enter other lanes', async () => {
    process.env.LINK_WORKER_SECRET_HERMES_COMMITMENTS = 'commitments-test';
    const url = '/api/integrations/commitments-worker/open?limit=2&offset=0';
    const headers = signedHeaders({ url, keyId: 'hermes_commitments', secret: 'commitments-test' });
    expect((await drive(makeReq({ url, headers }), 'commitments_read')).next).toHaveBeenCalledWith();
    for (const endpoint of ['claim', 'report', 'watchdog', 'vendor_price', 'vendor_login']) {
      expect((await drive(makeReq({ url, headers }), endpoint)).res.statusCode).toBe(403);
    }
    expect((await drive(makeReq({ url, headers: signedHeaders({ url }) }), 'commitments_read')).res.statusCode).toBe(403);
    expect((await drive(makeReq({ url, headers: { authorization: 'Bearer legacy-bearer' } }), 'commitments_read')).res.statusCode).toBe(403);
    expect((await drive(makeReq({ url, headers: signedHeaders({ url, keyId: 'hermes_commitments' }) }), 'commitments_read')).res.statusCode).toBe(401);
    delete process.env.LINK_WORKER_SECRET_HERMES_COMMITMENTS;
    expect((await drive(makeReq({ url, headers }), 'commitments_read')).res.statusCode).toBe(503);
  });

  test('the hermes_watchdog key reaches ONLY the watchdog endpoint and has its own secret', async () => {
    process.env.LINK_WORKER_SECRET_HERMES_WATCHDOG = 'watchdog-secret';
    const url = '/api/integrations/watchdog-worker/status';
    const req = makeReq({ url, headers: signedHeaders({ url, keyId: 'hermes_watchdog', secret: 'watchdog-secret' }) });
    const ok = await drive(req, 'watchdog');
    expect(ok.next).toHaveBeenCalledWith();
    expect(req.linkWorker).toEqual({ provider: 'hermes', authScheme: 'hmac', keyId: 'hermes_watchdog' });

    // the backlink secret does not sign for the watchdog key
    const crossSigned = await drive(makeReq({ url, headers: signedHeaders({ url, keyId: 'hermes_watchdog' }) }), 'watchdog');
    expect(crossSigned.res.statusCode).toBe(401);
    // the watchdog key cannot claim prospects
    const claimUrl = '/api/integrations/backlink-worker/claim';
    const escalate = await drive(makeReq({ url: claimUrl, headers: signedHeaders({ url: claimUrl, keyId: 'hermes_watchdog', secret: 'watchdog-secret' }) }), 'claim');
    expect(escalate.res.statusCode).toBe(403);
    // the backlink key cannot read the watchdog snapshot
    const backlinkKey = await drive(makeReq({ url, headers: signedHeaders({ url }) }), 'watchdog');
    expect(backlinkKey.res.statusCode).toBe(403);
    // and the legacy bearer is not extended to the new lane
    const bearer = await drive(makeReq({ url, headers: { authorization: 'Bearer legacy-bearer' } }), 'watchdog');
    expect(bearer.res.statusCode).toBe(403);
    delete process.env.LINK_WORKER_SECRET_HERMES_WATCHDOG;
    const unconfigured = await drive(makeReq({ url, headers: signedHeaders({ url, keyId: 'hermes_watchdog', secret: 'watchdog-secret' }) }), 'watchdog');
    expect(unconfigured.res.statusCode).toBe(503);
  });
});

describe('link-worker-auth bearer transition', () => {
  test('the legacy bearer is still accepted and audited as bearer', async () => {
    const req = makeReq({ headers: { authorization: 'Bearer legacy-bearer' } });
    const { next } = await drive(req);
    expect(next).toHaveBeenCalledWith();
    expect(req.linkWorker).toEqual({ provider: 'hermes', authScheme: 'bearer', keyId: 'hermes-bearer' });
  });

  test('bearer works on the vendor endpoints too (shared hermesAuth successor)', async () => {
    const req = makeReq({ url: '/api/integrations/vendor-login-worker/claim', headers: { 'x-hermes-token': 'legacy-bearer' } });
    const { next } = await drive(req, 'vendor_login');
    expect(next).toHaveBeenCalledWith();
  });

  test('bearer mismatch is 401, unset token is 503, gate off is 403', async () => {
    const bad = await drive(makeReq({ headers: { authorization: 'Bearer wrong' } }));
    expect(bad.res.statusCode).toBe(401);
    delete process.env.HERMES_SERVICE_TOKEN;
    const unconfigured = await drive(makeReq({ headers: {} }));
    expect(unconfigured.res.statusCode).toBe(503);
    isEnabled.mockReturnValue(false);
    const gated = await drive(makeReq({ headers: { authorization: 'Bearer legacy-bearer' } }));
    expect(gated.res.statusCode).toBe(403);
  });
});

describe('audit finalization', () => {
  test('finalizeWorkerRequest updates the pre-inserted row', async () => {
    const req = makeReq({ headers: { authorization: 'Bearer legacy-bearer' } });
    await drive(req);
    await finalizeWorkerRequest(req, 'empty_claim');
    expect(auditRows.some((r) => r.finalized === req.linkWorkerRequestId && r.result === 'empty_claim')).toBe(true);
  });

  test('finalize without an audit row is a no-op (false), a persisted update resolves true, and update failures resolve false — never throw', async () => {
    await expect(finalizeWorkerRequest({}, 'leased')).resolves.toBe(false);
    const req = makeReq({ headers: { authorization: 'Bearer legacy-bearer' } });
    await drive(req);
    await expect(finalizeWorkerRequest(req, 'empty_claim')).resolves.toBe(true);
    mockDb.mockImplementationOnce(() => ({ where: () => ({ update: async () => { throw new Error('db down'); } }) }));
    await expect(finalizeWorkerRequest(req, 'empty_claim')).resolves.toBe(false);
  });
});

describe('canonicalTarget encoding', () => {
  test('escapes RFC 3986 reserved punctuation exactly like the Python signer', () => {
    // python: quote("a b!'()*x", safe="") == 'a%20b%21%27%28%29%2Ax'
    expect(canonicalTarget("/x?q=a b!'()*x")).toBe('/x?q=a%20b%21%27%28%29%2Ax');
  });
  test('sorts by encoded key then value and normalizes + as space', () => {
    expect(canonicalTarget('/x?b=2&a=1&a=0')).toBe('/x?a=0&a=1&b=2');
    expect(canonicalTarget('/x?q=a+b')).toBe('/x?q=a%20b');
  });
  test('a request signed over a reserved-punctuation query verifies', async () => {
    const url = "/api/integrations/backlink-worker/claim?note=don't(stop)*now!";
    const { next } = await drive(makeReq({ url, headers: signedHeaders({ url }) }));
    expect(next).toHaveBeenCalledWith();
  });
});

describe('rawBodyVerify scope', () => {
  test('captures bytes only for worker routes', () => {
    const buf = Buffer.from('{"a":1}');
    const workerReq = { originalUrl: '/api/integrations/backlink-worker/report' };
    rawBodyVerify(workerReq, {}, buf);
    expect(workerReq.rawBody.equals(buf)).toBe(true);
    const otherReq = { originalUrl: '/api/requests' };
    rawBodyVerify(otherReq, {}, buf);
    expect(otherReq.rawBody).toBeUndefined();
  });
});
