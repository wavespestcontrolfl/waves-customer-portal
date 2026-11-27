// A visit text recipient's tracker GET (GATE_CALL_GIVEN_VISIT_TEXTS) answers exactly as an unknown token on ANY failure after the
// token lookup. The technician photo is presigned by the REAL helper (services/tech-photo.js) here; only the signer itself, the
// database and the heavy collaborators are faked. A signing failure must be the unknown-token 404 for the recipient (strict), while
// every other caller keeps its fallback photo; the helper's log carries the error code only, never the S3 key or the raw message.
const mockTables = {};
jest.mock('../models/db', () => {
  const mockDb = jest.fn((table) => {
    const state = mockTables[table] || {};
    let byToken = false;
    const q = {};
    q.where = jest.fn((arg, val) => { if ((arg && arg['s.track_view_token']) || (arg === 's.track_view_token' && val)) byToken = true; return q; });
    for (const m of ['leftJoin', 'join', 'whereNotNull', 'orderBy', 'whereRaw', 'whereNotExists', 'select', 'limit', 'whereNull']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => (byToken && 'byToken' in state ? state.byToken : state.first) ?? null);
    q.then = (resolve, reject) => Promise.resolve(state.list ?? []).then(resolve, reject);
    return q;
  });
  mockDb.raw = jest.fn((sql) => sql);
  return mockDb;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/geocoder', () => ({ ensureCustomerGeocoded: jest.fn() }));
jest.mock('../services/photos', () => ({ getViewUrl: jest.fn(), CUSTOMER_DWELL_TTL_SECONDS: 60 }));
jest.mock('../services/customer-page-views', () => ({ recordPageView: jest.fn(), logViewFailure: jest.fn() }));
jest.mock('../services/tracking-vehicle-location', () => ({ resolveFreshTechPosition: jest.fn(async () => null) }));
jest.mock('../services/disclaimed-number-holds', () => ({ disclaimedNumberHeldForVisit: jest.fn(async () => false), disclaimedNumberHeld: jest.fn(async () => false) }));
jest.mock('../services/contact-notification-prefs', () => ({ contactPrefsLive: jest.fn(() => true), getContactPrefRow: jest.fn(async () => null), contactAllows: jest.fn(() => true) }));
jest.mock('../services/messaging/auto-text-holds', () => ({ callVetoesForNumber: jest.fn(async () => ({ doNotContact: false, smsDeclined: false })) }));
// The signer is the one S3 piece faked: the real helper calls it and handles its failure.
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const logger = require('../services/logger');
const config = require('../config');
const { resolveTechPhotoUrl } = require('../services/tech-photo');
const trackPublicRouter = require('../routes/track-public');

const TOKEN = `vr_${'c'.repeat(48)}`;
const S3_KEY = 'technicians/zz-tech-secret-key.jpg';
const RAW_MESSAGE = 'SignatureDoesNotMatch for zz-raw-detail';
const LIVE = new Date(Date.now() + 86400000).toISOString();
const RECIP = { id: 'r-1', scheduled_service_id: 'visit-1', customer_id: 'cust-1', phone_key: '9415550002', phone_e164: '+19415550002', first_name: 'Bob' };
const VISIT = {
  id: 'visit-1', customer_id: 'cust-1', technician_id: 'tech-1', status: 'en_route', track_state: 'en_route', completed_at: null,
  track_token_expires_at: LIVE, customer_pick_by: null, window_start: '09:00:00', window_end: '11:00:00', scheduled_date: '2026-12-01',
  service_type: 'Pest Control', en_route_at: new Date().toISOString(), tech_name: 'Pat Tech', tech_photo_s3_key: S3_KEY,
  tech_photo_url: 'https://img.test/fallback.jpg', latitude: '27.2', longitude: '-82.2', city: 'Parrish',
};
const find = (path, method) => trackPublicRouter.stack.find((l) => l.route?.path === path && l.route.methods[method]).route.stack[0].handle;

async function get(token = TOKEN) {
  const res = { statusCode: 200, body: undefined, headers: {}, set: jest.fn((h) => { Object.assign(res.headers, h); return res; }), status: jest.fn((c) => { res.statusCode = c; return res; }), json: jest.fn((b) => { res.body = b; return res; }) };
  const next = jest.fn();
  await find('/:token', 'get')({ params: { token } }, res, next);
  return { statusCode: res.statusCode, body: res.body, headers: res.headers, nextCalled: next.mock.calls.length };
}
function world({ recipient = RECIP } = {}) {
  for (const k of Object.keys(mockTables)) delete mockTables[k];
  mockTables.visit_text_recipients = { first: recipient, list: recipient ? [recipient] : [] };
  mockTables.scheduled_services = { first: VISIT };
  mockTables['scheduled_services as s'] = { byToken: null, first: VISIT };
  mockTables.customers = { first: { phone: '+19415550001' } };
}
const signingFails = () => getSignedUrl.mockRejectedValue(Object.assign(new Error(RAW_MESSAGE), { name: 'SignatureDoesNotMatch', code: 'SignatureDoesNotMatch' }));

const GATE = 'GATE_CALL_GIVEN_VISIT_TEXTS';
const gateBefore = process.env[GATE];
const s3Before = config.s3;
beforeEach(() => {
  jest.clearAllMocks();
  process.env[GATE] = 'true';
  config.s3 = { ...(s3Before || {}), bucket: 'test-bucket', region: 'us-east-1' };
  getSignedUrl.mockResolvedValue('https://s3.test/signed.jpg');
});
afterAll(() => {
  config.s3 = s3Before;
  if (gateBefore === undefined) delete process.env[GATE]; else process.env[GATE] = gateBefore;
});

describe('the recipient GET with a technician photo presigned by the real helper', () => {
  test('control: a healthy signature is served (200, the signed photo)', async () => {
    world();
    const answer = await get();
    expect(answer.statusCode).toBe(200);
    expect(answer.body.tech.photoUrl).toBe('https://s3.test/signed.jpg');
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
  });

  test('a SIGNING failure answers exactly as an unknown token (no fallback photo), with code-only logs', async () => {
    world({ recipient: null });
    const unknown = await get();
    expect(unknown.statusCode).toBe(404);
    world();
    signingFails();
    const answer = await get();
    expect(answer).toEqual(unknown);
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('SignatureDoesNotMatch');
    expect(logged).not.toContain(S3_KEY);
    expect(logged).not.toContain('zz-raw-detail');
    expect(logged).not.toContain(TOKEN);
  });
});

describe('resolveTechPhotoUrl', () => {
  test('default (every other caller): a signing failure answers the fallback, and the log has the code only', async () => {
    signingFails();
    expect(await resolveTechPhotoUrl(S3_KEY, 'https://img.test/fallback.jpg')).toBe('https://img.test/fallback.jpg');
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('code=SignatureDoesNotMatch');
    expect(logged).not.toContain(S3_KEY);
    expect(logged).not.toContain('zz-raw-detail');
  });

  test('strict: a signing failure throws a fresh error carrying the code only', async () => {
    signingFails();
    const thrown = await resolveTechPhotoUrl(S3_KEY, 'https://img.test/fallback.jpg', 60, { strict: true }).catch((e) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.code).toBe('SignatureDoesNotMatch');
    expect(`${thrown.message} ${thrown.stack}`).not.toContain(S3_KEY);
    expect(`${thrown.message} ${thrown.stack}`).not.toContain('zz-raw-detail');
  });

  test('strict: no key, or no bucket configured, is not a failure (the stored URL or null, as before)', async () => {
    expect(await resolveTechPhotoUrl(null, 'https://img.test/fallback.jpg', 60, { strict: true })).toBe('https://img.test/fallback.jpg');
    config.s3 = { ...config.s3, bucket: undefined };
    expect(await resolveTechPhotoUrl(S3_KEY, null, 60, { strict: true })).toBeNull();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });
});
