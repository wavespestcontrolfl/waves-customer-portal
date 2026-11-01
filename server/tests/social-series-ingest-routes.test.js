// /api/social/series/media + /posts — the weekly series job's intake (owner
// decision 2026-11-01). Contract: 404 while the token is unset, 401 on a bad
// bearer, a body parsed only after auth, 400 { ok, reason, detail } on every
// refusal, and ONE scheduled social_media_posts row per series id.

const mockInserts = [];
const mockConflictArgs = [];
const mockExisting = { row: null };
const mockInsertResult = { skip: false, error: null };
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const b = {};
    b.insert = jest.fn((row) => {
      if (mockInsertResult.error) throw mockInsertResult.error;
      b.row = row;
      return b;
    });
    b.onConflict = jest.fn((arg) => { mockConflictArgs.push(arg); return b; });
    b.ignore = jest.fn(() => b);
    b.returning = jest.fn(async () => {
      if (mockInsertResult.skip) return [];
      mockInserts.push({ table, row: b.row });
      return [{ id: 'row-1', scheduled_for: new Date(b.row.scheduled_for) }];
    });
    b.where = jest.fn(() => b);
    b.first = jest.fn(async () => mockExisting.row);
    return b;
  });
  db.raw = (sql) => ({ sql });
  return db;
});
const mockUploadImage = jest.fn();
const mockUploadVideo = jest.fn();
const mockFlags = {};
jest.mock('../services/social-media', () => ({
  SOCIAL_FLAGS: mockFlags,
  uploadImageToS3: (...a) => mockUploadImage(...a),
  uploadVideoToS3: (...a) => mockUploadVideo(...a),
  // Stand-in for the publisher's own check: one banned phrase, one length cap.
  validateContent: (text, platform) => {
    const issues = [];
    if (/guaranteed/i.test(text)) issues.push('Contains safety overclaim');
    if (platform === 'facebook' && text.length > 500) issues.push('Content exceeds facebook limit');
    return issues.length ? { valid: false, issues } : { valid: true, issues: [] };
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const router = require('../routes/social-series-ingest');
const { noStore } = require('../middleware/no-store');

const TOKEN = 'series-test-token-0123456789';
const CDN = 'cdn.example.com';
const NOW = Date.parse('2026-11-02T12:00:00Z');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(32)]);

function appServer() {
  const app = express();
  app.use('/api/social/series', ...router.ingestPreParsers);
  app.use('/api/social/series', router);
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

let server; let baseUrl;
beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'], now: NOW });
  mockInserts.length = 0;
  mockConflictArgs.length = 0;
  mockExisting.row = null;
  mockInsertResult.skip = false;
  mockInsertResult.error = null;
  mockUploadImage.mockReset();
  mockUploadVideo.mockReset();
  Object.assign(mockFlags, { automationEnabled: true, scheduledPosts: true, facebookEnabled: true, instagramEnabled: true, gbpEnabled: true });
  process.env.NODE_ENV = 'test';
  process.env.SOCIAL_SERIES_INGEST_TOKEN = TOKEN;
  process.env.SOCIAL_MEDIA_CDN_DOMAIN = CDN;
  ({ server, baseUrl } = appServer());
});
afterEach(async () => {
  jest.useRealTimers();
  await new Promise((resolve) => server.close(resolve));
  delete process.env.SOCIAL_SERIES_INGEST_TOKEN;
  delete process.env.SOCIAL_MEDIA_CDN_DOMAIN;
});

async function call(path, { method = 'POST', body, type = 'application/json', token = TOKEN } = {}) {
  const res = await fetch(`${baseUrl}/api/social/series${path}`, {
    method,
    headers: { ...(type ? { 'content-type': type } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : (Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body)),
  });
  return { status: res.status, headers: res.headers, json: await res.json() };
}
const post = (body, opts) => call('/posts', { body, ...opts });

const good = (over = {}) => ({
  id: 'week-12-pest-myths',
  title: 'Week 12: pest myths',
  platforms: ['facebook', 'instagram', 'gmb'],
  caption: 'Week 12: three pest myths about Florida homes.',
  mediaUrl: `https://${CDN}/social-media/series-abc.jpg`,
  gbpLocation: 'Sarasota',
  scheduleDate: '2026-11-03T09:00:00-05:00',
  ...over,
});

describe('auth and the dark route', () => {
  test('every method and path is the generic 404 while the token is unset', async () => {
    delete process.env.SOCIAL_SERIES_INGEST_TOKEN;
    for (const [method, path] of [['POST', '/posts'], ['POST', '/media'], ['OPTIONS', '/posts'], ['GET', '/anything']]) {
      const res = await fetch(`${baseUrl}/api/social/series${path}`, { method });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: `Route not found: ${method} /api/social/series${path}` });
    }
    expect(mockInserts).toHaveLength(0);
  });

  test('401 on a wrong or missing bearer, before any body is parsed', async () => {
    expect((await post(good(), { token: 'nope' })).json).toEqual({ ok: false, reason: 'invalid_token' });
    expect((await post(good(), { token: null })).status).toBe(401);
    // a malformed body with a bad token is still 401, never 400
    expect((await post('{not json', { token: 'nope' })).status).toBe(401);
    expect((await call('/media', { body: JPEG, type: 'image/jpeg', token: 'nope' })).status).toBe(401);
    expect(mockInserts).toHaveLength(0);
    expect(mockUploadImage).not.toHaveBeenCalled();
  });

  test('privacy headers on the dark 404, the 401 and a 201', async () => {
    const check = (res) => {
      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(res.headers.get('x-robots-tag')).toContain('noindex');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    };
    check(await post(good(), { token: 'nope' }));
    check(await post(good()));
    delete process.env.SOCIAL_SERIES_INGEST_TOKEN;
    check(await post(good()));
  });

  test('layer order: privacy headers, dark, limiter, auth, parsers, body errors; each route starts dark then auth', () => {
    const { darkUnlessConfigured, ingestAuth, ingestBodyErrorHandler } = router._private;
    const chain = router.ingestPreParsers;
    expect(chain[0]).toBe(noStore);
    expect(chain[1]).toBe(darkUnlessConfigured);
    expect(chain[3]).toBe(ingestAuth);
    expect(chain[chain.length - 1]).toBe(ingestBodyErrorHandler);
    for (const layer of router.stack.filter((l) => l.route)) {
      expect(layer.route.stack[0].handle).toBe(darkUnlessConfigured);
      expect(layer.route.stack[1].handle).toBe(ingestAuth);
      expect(layer.route.stack.map((l) => l.handle)).not.toContain(chain[2]);
    }
  });

  test('an invalid JSON body is 400 and an oversized one 413, only after auth', async () => {
    expect((await post('{not json')).json).toEqual({ ok: false, reason: 'invalid_json' });
    const big = await post(JSON.stringify({ id: 'x', caption: 'c'.repeat(300 * 1024) }));
    expect(big.status).toBe(413);
    expect(big.json.reason).toBe('payload_too_large');
    // Express routes /POSTS to the same handler, so the cap must apply there too.
    const upper = await call('/POSTS', { body: JSON.stringify({ id: 'x', caption: 'c'.repeat(300 * 1024) }) });
    expect(upper.status).toBe(413);
  });
});

describe('POST /posts validation', () => {
  const refused = async (over, reason) => {
    const { status, json } = await post(good(over));
    expect(status).toBe(400);
    expect(json).toMatchObject({ ok: false, reason });
    expect(typeof json.detail).toBe('string');
    expect(mockInserts).toHaveLength(0);
  };

  test('a bad id', async () => {
    await refused({ id: 'has spaces' }, 'invalid_id');
    await refused({ id: '' }, 'invalid_id');
    await refused({ id: 'x'.repeat(121) }, 'invalid_id');
    await refused({ id: undefined }, 'invalid_id');
  });

  test('platforms: unknown, empty, repeated (gmb and gbp are one channel)', async () => {
    await refused({ platforms: ['tiktok'] }, 'invalid_platforms');
    await refused({ platforms: ['x'] }, 'invalid_platforms');
    await refused({ platforms: [] }, 'invalid_platforms');
    await refused({ platforms: ['facebook', 'facebook'] }, 'invalid_platforms');
    await refused({ platforms: ['gmb', 'gbp'], gbpLocation: 'all' }, 'invalid_platforms');
  });

  test('a caption is required', async () => {
    await refused({ caption: '   ' }, 'invalid_caption');
    await refused({ caption: undefined }, 'invalid_caption');
    await refused({ captionByPlatform: { tiktok: 'x' } }, 'invalid_caption');
  });

  test('instagram needs media; a video needs media and cannot go to gbp', async () => {
    await refused({ mediaUrl: undefined, platforms: ['instagram'] }, 'media_required');
    await refused({ mediaUrl: undefined, isVideo: true, platforms: ['facebook'] }, 'media_required');
    await refused({ isVideo: true, platforms: ['facebook', 'gbp'] }, 'video_not_supported_on_gbp');
  });

  test('mediaUrl must be https on the social CDN host', async () => {
    await refused({ mediaUrl: 'https://evil.example.com/a.jpg' }, 'invalid_media_url');
    await refused({ mediaUrl: `http://${CDN}/a.jpg` }, 'invalid_media_url');
    await refused({ mediaUrl: `https://${CDN}.evil.example.com/a.jpg` }, 'invalid_media_url');
    await refused({ mediaUrl: `https://user@evil.example.com@${CDN}/a.jpg` }, 'invalid_media_url');
    await refused({ mediaUrl: 'not a url' }, 'invalid_media_url');
    delete process.env.SOCIAL_MEDIA_CDN_DOMAIN;
    await refused({}, 'invalid_media_url');
  });

  test('gbp needs a known location', async () => {
    await refused({ gbpLocation: 'Atlantis' }, 'unknown_gbp_location');
    await refused({ gbpLocation: undefined }, 'unknown_gbp_location');
  });

  test('scheduleDate: needs an offset, not > 1 h past, not > 60 days ahead', async () => {
    await refused({ scheduleDate: '2026-11-03T09:00:00' }, 'invalid_schedule_date');
    await refused({ scheduleDate: 'tomorrow' }, 'invalid_schedule_date');
    await refused({ scheduleDate: '2026-11-02T10:30:00Z' }, 'schedule_date_in_past');
    await refused({ scheduleDate: '2027-02-01T12:00:00Z' }, 'schedule_date_too_far');
  });

  test('copy that the publisher would refuse, and GBP over 1500 characters', async () => {
    await refused({ caption: 'Guaranteed results!' }, 'content_rejected');
    await refused({ platforms: ['gbp'], mediaUrl: undefined, caption: 'g'.repeat(1501) }, 'caption_too_long');
    await refused({ platforms: ['facebook'], mediaUrl: undefined, caption: 'f'.repeat(501) }, 'content_rejected');
  });

  test('a body that is not an object', async () => {
    const { status, json } = await post('[1]');
    expect(status).toBe(400);
    expect(json.reason).toBe('invalid_body');
  });
});

describe('POST /posts storage', () => {
  test('201 and ONE scheduled row with the exact stored shape', async () => {
    const { status, json } = await post(good({
      captionByPlatform: { instagram: 'IG copy', gmb: 'GBP copy' },
    }));
    expect(status).toBe(201);
    expect(json).toEqual({ ok: true, id: 'row-1', deduped: false, scheduledFor: '2026-11-03T14:00:00.000Z' });
    expect(mockInserts).toHaveLength(1);
    const { table, row } = mockInserts[0];
    expect(table).toBe('social_media_posts');
    expect(row).toMatchObject({
      title: 'Week 12: pest myths',
      description: 'Week 12: three pest myths about Florida homes.',
      source_type: 'series',
      source_guid: 'series:week-12-pest-myths',
      status: 'scheduled',
      publish_status: 'pending',
      scheduled_for: '2026-11-03T14:00:00.000Z',
      image_url: `https://${CDN}/social-media/series-abc.jpg`,
      video_url: null,
    });
    // jsonb columns are sent as JSON text, requested channels only (gbp spelling)
    expect(JSON.parse(row.platforms_posted)).toEqual(['facebook', 'instagram', 'gbp']);
    expect(JSON.parse(row.custom_content)).toEqual({
      facebook: 'Week 12: three pest myths about Florida homes.',
      instagram: 'IG copy',
      gbp: 'GBP copy',
    });
    expect(JSON.parse(row.gbp_location_ids)).toEqual(['sarasota']);
    expect(row.created_at).toBeInstanceOf(Date);
    // the insert is idempotent on the partial unique index
    expect(mockConflictArgs[0].sql).toBe("(source_guid) where source_type = 'series'");
  });

  test('title defaults to the id; omitted scheduleDate is now; gbpLocation all stores null; a video row stores video_url', async () => {
    const { status } = await post({
      id: 'reel-1',
      platforms: ['facebook', 'gbp'].filter((p) => p !== 'gbp'),
      caption: 'A short reel.',
      mediaUrl: `https://${CDN}/social-media/series-1.mp4`,
      isVideo: true,
    });
    expect(status).toBe(201);
    const { row } = mockInserts[0];
    expect(row.title).toBe('reel-1');
    expect(row.scheduled_for).toBe(new Date(NOW).toISOString());
    expect(row.video_url).toBe(`https://${CDN}/social-media/series-1.mp4`);
    expect(row.image_url).toBeNull();
    expect(row.gbp_location_ids).toBeNull();
    expect(JSON.parse(row.custom_content)).toEqual({ facebook: 'A short reel.' });

    mockInserts.length = 0;
    await post(good({ id: 'all-locs', gbpLocation: 'all' }));
    expect(mockInserts[0].row.gbp_location_ids).toBeNull();
    expect(JSON.parse(mockInserts[0].row.custom_content).gbp).toBeTruthy();
  });

  test('a location id, a name and a service city all resolve; gbp spelling gmb or gbp both work', async () => {
    for (const [spelling, location, expected] of [['gbp', 'venice', ['venice']], ['gmb', 'Lakewood Ranch', ['bradenton']], ['gbp', 'siesta key', ['sarasota']]]) {
      mockInserts.length = 0;
      await post(good({ platforms: [spelling], mediaUrl: undefined, gbpLocation: location }));
      expect(JSON.parse(mockInserts[0].row.gbp_location_ids)).toEqual(expected);
    }
  });

  test('200 deduped when the id is already stored: nothing else is written', async () => {
    mockInsertResult.skip = true;
    mockExisting.row = { id: 'row-old', scheduled_for: new Date('2026-11-05T14:00:00Z') };
    const { status, json } = await post(good());
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, id: 'row-old', deduped: true, scheduledFor: '2026-11-05T14:00:00.000Z' });
    expect(mockInserts).toHaveLength(0);
  });

  test('dryRun validates and answers the row it would store, with no insert', async () => {
    const { status, json } = await post(good({ dryRun: true }));
    expect(status).toBe(200);
    expect(json.dryRun).toBe(true);
    expect(json.row).toMatchObject({ source_type: 'series', source_guid: 'series:week-12-pest-myths', status: 'scheduled', gbp_location_ids: ['sarasota'] });
    expect(mockInserts).toHaveLength(0);
    // a dry run of a bad post is still refused
    expect((await post(good({ dryRun: true, id: 'bad id' }))).status).toBe(400);
  });

  test('409 scheduled_posts_disabled when the scheduler would never post the row (dry run too); nothing stored', async () => {
    for (const flag of ['automationEnabled', 'scheduledPosts']) {
      mockFlags[flag] = false;
      for (const dryRun of [false, true]) {
        const { status, json } = await post(good({ dryRun }));
        expect(status).toBe(409);
        expect(json).toEqual({ ok: false, reason: 'scheduled_posts_disabled' });
      }
      mockFlags[flag] = true;
    }
    expect(mockInserts).toHaveLength(0);
  });

  test('409 platform_disabled names a requested channel whose own flag is off; other channels may be off', async () => {
    mockFlags.instagramEnabled = false;
    const refused = await post(good());
    expect(refused.status).toBe(409);
    expect(refused.json).toEqual({ ok: false, reason: 'platform_disabled', detail: 'instagram' });
    mockFlags.gbpEnabled = false;
    expect((await post(good({ platforms: ['gmb'], mediaUrl: undefined }))).json).toEqual({ ok: false, reason: 'platform_disabled', detail: 'gbp' });
    expect(mockInserts).toHaveLength(0);
    // a channel nobody asked for being off does not matter
    const ok = await post(good({ platforms: ['facebook'], mediaUrl: undefined }));
    expect(ok.status).toBe(201);
  });

  test('a refused payload stays 400 while a flag is off (validation first)', async () => {
    mockFlags.automationEnabled = false;
    expect((await post(good({ id: 'bad id' }))).status).toBe(400);
  });

  test('a database failure is a retryable 503, not a false success', async () => {
    mockInsertResult.error = new Error('db down');
    const { status, json } = await post(good());
    expect(status).toBe(503);
    expect(json.reason).toBe('store_failed');
  });
});

describe('POST /media', () => {
  test('an image goes through uploadImageToS3 as base64 under a series-<uuid> name', async () => {
    mockUploadImage.mockResolvedValue(`https://${CDN}/social-media/series-x.jpg`);
    const { status, json } = await call('/media', { body: PNG, type: 'image/png' });
    expect(status).toBe(201);
    expect(json).toEqual({ ok: true, url: `https://${CDN}/social-media/series-x.jpg`, kind: 'image' });
    const [base64, filename] = mockUploadImage.mock.calls[0];
    expect(Buffer.from(base64, 'base64').equals(PNG)).toBe(true);
    expect(filename).toMatch(/^series-[0-9a-f-]{36}\.png$/);
    expect(mockUploadVideo).not.toHaveBeenCalled();
  });

  test('a video goes through uploadVideoToS3 as a buffer', async () => {
    mockUploadVideo.mockResolvedValue(`https://${CDN}/social-media/series-v.mp4`);
    const { status, json } = await call('/media', { body: MP4, type: 'video/mp4' });
    expect(status).toBe(201);
    expect(json).toEqual({ ok: true, url: `https://${CDN}/social-media/series-v.mp4`, kind: 'video' });
    const [buffer, filename] = mockUploadVideo.mock.calls[0];
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.equals(MP4)).toBe(true);
    expect(filename).toMatch(/^series-[0-9a-f-]{36}\.mp4$/);
    expect(mockUploadImage).not.toHaveBeenCalled();
  });

  test('a helper that returns null (or throws) is 503 media_hosting_unavailable', async () => {
    mockUploadImage.mockResolvedValue(null);
    const a = await call('/media', { body: JPEG, type: 'image/jpeg' });
    expect(a.status).toBe(503);
    expect(a.json).toEqual({ ok: false, reason: 'media_hosting_unavailable' });
    mockUploadVideo.mockRejectedValue(new Error('s3 down'));
    expect((await call('/media', { body: MP4, type: 'video/mp4' })).status).toBe(503);
  });

  test('a wrong content type is 415; an empty body or mismatched bytes is 400', async () => {
    expect((await call('/media', { body: 'hello', type: 'text/plain' })).status).toBe(415);
    expect((await call('/media', { body: JSON.stringify({ a: 1 }), type: 'application/json' })).status).toBe(415);
    expect((await call('/media', { body: Buffer.alloc(0), type: 'image/jpeg' })).json.reason).toBe('empty_body');
    const mismatch = await call('/media', { body: Buffer.from('this is not a jpeg at all'), type: 'image/jpeg' });
    expect(mismatch.status).toBe(400);
    expect(mismatch.json.reason).toBe('content_type_mismatch');
    expect(mockUploadImage).not.toHaveBeenCalled();
  });
});
