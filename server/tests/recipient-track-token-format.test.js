// The visit text recipient's tracker token has its own recognizable shape (vr_ + 48 hex): every layer tells it from the holder's
// token (64 hex) by looking at it. Pinned here: the two shapes never overlap, the recipient shape fits the frozen varchar(64)
// column, the page and the socket refuse it as a socket credential, the track routes and the /view pre-parser accept both, and a
// log line redacts it like any other bearer token.
const fs = require('fs');
const path = require('path');
const { RECIPIENT_TRACK_TOKEN_RE, HOLDER_TRACK_TOKEN_RE, isRecipientTrackToken } = require('../utils/recipient-track-token');
const { trackPublicPreparser, TRACK_TOKEN_RE: PREPARSER_RE } = require('../middleware/track-public-preparser');

const HOLDER = 'a'.repeat(64);
const RECIPIENT = `vr_${'0123456789abcdef'.repeat(3)}`;

test('the two shapes never overlap, and the recipient token fits the frozen varchar(64) column', () => {
  expect(RECIPIENT).toHaveLength(51);
  expect(RECIPIENT.length).toBeLessThanOrEqual(64);
  expect(isRecipientTrackToken(RECIPIENT)).toBe(true);
  expect(isRecipientTrackToken(HOLDER)).toBe(false);
  expect(HOLDER_TRACK_TOKEN_RE.test(RECIPIENT)).toBe(false);
  expect(RECIPIENT_TRACK_TOKEN_RE.test(HOLDER)).toBe(false);
  for (const bad of [null, undefined, '', 'vr_', `vr_${'a'.repeat(47)}`, `vr_${'a'.repeat(49)}`, `VR_${'a'.repeat(48)}`, `vr_${'g'.repeat(48)}`, ` ${RECIPIENT}`]) {
    expect(isRecipientTrackToken(bad)).toBe(false);
  }
});

test('the column behind it is varchar(64) (migration 20261124190000, frozen)', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../models/migrations/20261124190000_visit_text_recipients_track_token.js'), 'utf8');
  expect(sql).toContain('track_token varchar(64)');
});

const GATE = 'GATE_CALL_GIVEN_VISIT_TEXTS';
const gateBefore = process.env[GATE];
afterEach(() => { if (gateBefore === undefined) delete process.env[GATE]; else process.env[GATE] = gateBefore; });

test('the /view pre-parser accepts both shapes and still answers 404 for anything else', () => {
  process.env[GATE] = 'true';
  const run = (token) => {
    const res = { statusCode: 200, set: jest.fn(), status: jest.fn((c) => { res.statusCode = c; return res; }), json: jest.fn(() => res) };
    const next = jest.fn();
    trackPublicPreparser({ method: 'POST', path: `/${token}/view`, headers: { 'content-type': 'application/json' } }, res, next);
    return { statusCode: res.statusCode, nextCalled: next.mock.calls.length };
  };
  expect(run(HOLDER)).toEqual({ statusCode: 200, nextCalled: 1 });
  expect(run(RECIPIENT)).toEqual({ statusCode: 200, nextCalled: 1 });
  expect(run('vr_short')).toEqual({ statusCode: 404, nextCalled: 0 });
  expect(PREPARSER_RE.test(RECIPIENT)).toBe(true);
});

test('a request log redacts a recipient token like any other bearer token', () => {
  const { redactRequestUrl } = require('../utils/redact-request-url');
  const out = redactRequestUrl(`/api/public/track/${RECIPIENT}`);
  expect(out).not.toContain(RECIPIENT);
  expect(out).not.toContain('0123456789abcdef');
});

describe('a recipient-shape token with GATE_CALL_GIVEN_VISIT_TEXTS off: the generic 404 before any limiter, body parser or database read', () => {
  // the real mount order: pre-parser, global limiter, body parser, then the route (which reads the database)
  const drive = (method, requestPath) => {
    const limiter = jest.fn();
    const bodyParser = jest.fn();
    const database = jest.fn();
    const res = { statusCode: 200, body: undefined, headers: {}, set: jest.fn((k, v) => { res.headers[k] = v; return res; }), status: jest.fn((c) => { res.statusCode = c; return res; }), json: jest.fn((b) => { res.body = b; return res; }) };
    const req = { method, path: requestPath, headers: {} };
    const route = () => { database(); };
    const chain = [trackPublicPreparser, (r, rs, n) => { limiter(); n(); }, (r, rs, n) => { bodyParser(); n(); }, route];
    let i = 0;
    const next = () => { i += 1; if (chain[i]) chain[i](req, res, next); };
    chain[0](req, res, next);
    return { res, limiter, bodyParser, database };
  };
  const ROUTES = [['GET', `/${RECIPIENT}`], ['POST', `/${RECIPIENT}/stops-ahead`], ['POST', `/${RECIPIENT}/view`]];

  test.each(ROUTES)('%s %s: gate off answers 404 and nothing downstream runs', (method, requestPath) => {
    delete process.env[GATE];
    const { res, limiter, bodyParser, database } = drive(method, requestPath);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    // the privacy headers still go out on this answer
    expect(res.headers).toMatchObject({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
    expect(limiter).not.toHaveBeenCalled();
    expect(bodyParser).not.toHaveBeenCalled();
    expect(database).not.toHaveBeenCalled();
  });

  test.each(ROUTES)('%s %s: gate on lets the request through to the route', (method, requestPath) => {
    process.env[GATE] = 'true';
    const { res, limiter, database } = drive(method, requestPath);
    expect(res.statusCode).toBe(200);
    expect(limiter).toHaveBeenCalledTimes(1);
    expect(database).toHaveBeenCalledTimes(1);
  });

  // Express decodes the :token param once, so these all reach the route as the plain recipient token
  const encodeSome = (token) => `%76${token.slice(1)}`; // 'v' as %76
  const encodeAll = (token) => [...token].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
  const ENCODED = [encodeSome(RECIPIENT), encodeAll(RECIPIENT), encodeSome(RECIPIENT).replace('_', '%5F')];
  test.each(ENCODED.flatMap((enc) => [['GET', `/${enc}`], ['POST', `/${enc}/stops-ahead`], ['POST', `/${enc}/view`]]))('%s %s (percent-encoded): gate off is the same 404 before any limiter, parser or database read', (method, requestPath) => {
    delete process.env[GATE];
    expect(decodeURIComponent(requestPath.split('/')[1])).toBe(RECIPIENT);
    const { res, limiter, bodyParser, database } = drive(method, requestPath);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(limiter).not.toHaveBeenCalled();
    expect(bodyParser).not.toHaveBeenCalled();
    expect(database).not.toHaveBeenCalled();
  });

  test.each([['GET', '/%E0%A4%A'], ['POST', '/%zz/stops-ahead'], ['POST', '/%E0%A4%A/view']])('%s %s: a malformed percent-encoding is the generic 404, nothing downstream runs', (method, requestPath) => {
    process.env[GATE] = 'true';
    const { res, limiter, bodyParser, database } = drive(method, requestPath);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(limiter).not.toHaveBeenCalled();
    expect(bodyParser).not.toHaveBeenCalled();
    expect(database).not.toHaveBeenCalled();
  });

  test('with the gate on, an encoded recipient token passes (and an encoded holder token is judged on its decoded value)', () => {
    process.env[GATE] = 'true';
    expect(drive('GET', `/${encodeAll(RECIPIENT)}`).database).toHaveBeenCalledTimes(1);
    expect(drive('POST', `/${encodeAll(HOLDER)}/view`).database).toHaveBeenCalledTimes(1);
    expect(drive('POST', `/${encodeAll(HOLDER)}x/view`).database).not.toHaveBeenCalled();
  });

  test('a holder-shape token is never affected by the gate', () => {
    delete process.env[GATE];
    for (const [method, requestPath] of [['GET', `/${HOLDER}`], ['POST', `/${HOLDER}/stops-ahead`], ['POST', `/${HOLDER}/view`]]) {
      const { res, database } = drive(method, requestPath);
      expect(res.statusCode).toBe(200);
      expect(database).toHaveBeenCalledTimes(1);
    }
  });
});

// Express routes case-insensitively, so `/:token/VIEW` and `/:token/View` reach the view route. The pre-parser's suffix match must
// see them too: a malformed token is the route's generic 404 and the body is never parsed (no 400 from a malformed body).
describe('the /view pre-parser on a mounted app: the suffix matches whatever its case', () => {
  const express = require('express');
  let server;
  let base;
  const viewed = [];
  beforeAll(async () => {
    const app = express();
    app.use('/api/public/track', trackPublicPreparser);
    app.use(express.json());
    const router = express.Router();
    router.post('/:token/view', (req, res) => { viewed.push(req.params.token); res.status(204).end(); });
    app.use('/api/public/track', router);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/public/track`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));
  beforeEach(() => { viewed.length = 0; process.env[GATE] = 'true'; });

  const post = (path) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });

  test.each(['view', 'VIEW', 'View', 'vIeW'])('/%s: a valid token reaches the route and the malformed body is never parsed', async (suffix) => {
    for (const token of [HOLDER, RECIPIENT]) {
      const res = await post(`/${token}/${suffix}`);
      expect(res.status).toBe(204);
    }
    expect(viewed).toEqual([HOLDER, RECIPIENT]);
  });

  test.each(['view', 'VIEW', 'View'])('/%s: a malformed token is the generic 404, decided before any body parsing', async (suffix) => {
    const res = await post(`/not-a-token/${suffix}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(viewed).toEqual([]);
  });

  test('control: Express itself routes the upper-case suffix to the view route', async () => {
    const res = await fetch(`${base}/${HOLDER}/VIEW`, { method: 'POST' });
    expect(res.status).toBe(204);
    expect(viewed).toEqual([HOLDER]);
  });
});
