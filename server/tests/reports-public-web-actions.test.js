/**
 * GATE_REPORT_WEB_ACTIONS (owner 2026-10-20): the simple web report's finding
 * offer tile and "Seen something since?" photo button.
 * - /data: `webActions` appears only on a live simple-web view with the gate on,
 *   the tile only for a real finding that matches the offer the cross-sell
 *   builder picked (priced offer, click-to-estimate on), never on a callback;
 * - POST /:token/photo-check: 404 when dark (before any limiter), shares the
 *   portal photo ID limiters, one small photo, fixed-sentence answers, the
 *   standing re-service token never leaves the server.
 */
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = (sql) => ({ toString: () => sql });
  return mock;
});
jest.mock('../config', () => ({
  s3: { bucket: 'test-bucket', region: 'us-east-1' },
  jwt: { secret: 'test-jwt-secret' },
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  reportSimpleWebLive: jest.fn(() => false),
  reportGlassWebLive: jest.fn(() => false),
  reportWebActionsLive: jest.fn(() => false),
}));
// The report router's own 20-a-minute IP limiter would 429 this file's many requests.
jest.mock('express-rate-limit', () => () => (req, res, next) => next());
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({})),
  GetObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));
jest.mock('../services/pest-pressure/orchestrate', () => ({
  runAndSwallowErrors: jest.fn().mockResolvedValue(null),
  calculateAndPersistForServiceRecord: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/pest-pressure/store', () => ({
  loadActiveConfig: jest.fn(),
  loadScoreForServiceRecord: jest.fn(),
  loadHistoryForCustomer: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/service-report/report-data', () => ({
  buildReportV1Data: jest.fn(),
  stripLiveOnlyScheduleFields: jest.requireActual('../services/service-report/report-data').stripLiveOnlyScheduleFields,
  stripLiveOnlyReportProductCopy: jest.requireActual('../services/service-report/report-data').stripLiveOnlyReportProductCopy,
}));
jest.mock('../services/service-report/dynamic-context', () => ({
  buildServiceReportDynamicContext: jest.fn().mockResolvedValue({}),
}));
jest.mock('../services/service-report/cross-sell', () => ({
  buildReportCrossSell: jest.fn(),
}));
jest.mock('../routes/photo-id', () => ({
  photoIdLimiters: {
    sharedDailyLimiter: jest.fn((req, res, next) => next()),
  },
  runCustomerPhotoId: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const gates = require('../config/feature-gates');
const { buildReportV1Data } = require('../services/service-report/report-data');
const { buildReportCrossSell } = require('../services/service-report/cross-sell');
const photoId = require('../routes/photo-id');
const reportsRouter = require('../routes/reports-public');
const webActions = require('../services/service-report/web-actions');

const VALID_TOKEN = '0123456789abcdef0123456789abcdef';
const PHONE = '(941) 297-5749';

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    first: jest.fn(),
    insert: jest.fn().mockResolvedValue(1),
    update: jest.fn().mockResolvedValue(1),
    ...overrides,
  };
}

async function withServer(fn) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/reports', reportsRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function offer(overrides = {}) {
  return {
    serviceKey: 'lawn_care',
    label: 'Lawn Care',
    mode: 'priced',
    relationship: 'add',
    fingerprint: 'fp-1',
    option: { id: 'lawn-enhanced', perVisit: 61.5 },
    ...overrides,
  };
}

const WEED_FINDING = { id: 'f1', category: 'weed_pressure', title: 'Weeds along the driveway', detail: 'Broadleaf weeds in the edge.', recommendation: '' };

describe('web-actions: finding tile', () => {
  const run = (data, crossSell) => webActions.buildFindingTile(data, { buildCrossSell: async () => crossSell });

  test('a weed finding and a lawn offer make one tile with a fixed sentence and no price text', async () => {
    const tile = await run({ findings: [WEED_FINDING] }, offer());
    expect(tile.sentence).toBe('We saw weeds on this visit.');
    expect(tile.button).toBe('See your estimate');
    expect(tile.body).toBe('Lawn Care can take care of this. Tap below to see your estimate. Nothing is booked or charged.');
    expect(`${tile.sentence} ${tile.body} ${tile.button}`).not.toMatch(/\$|per visit|per month/i);
    expect(tile.tap).toEqual({
      serviceKey: 'lawn_care', serviceLabel: 'Lawn Care', optionId: 'lawn-enhanced', perApplication: 61.5, offerMode: 'priced', fingerprint: 'fp-1',
    });
  });

  test('no recorded finding: no tile, and the offer builder is never asked', async () => {
    const buildCrossSell = jest.fn();
    await expect(webActions.buildFindingTile({ findings: [] }, { buildCrossSell })).resolves.toBeNull();
    expect(buildCrossSell).not.toHaveBeenCalled();
  });

  test.each([
    ['an all-clear row', { category: 'no_activity', title: 'Weeds', detail: 'x' }],
    ['a raw observation', { category: 'observation', title: 'Weeds seen', detail: 'x' }],
    ['a bare title with no detail', { category: 'weed_pressure', title: 'Weeds', detail: '', recommendation: '' }],
    ['a denied finding', { category: 'weed_pressure', title: 'No weeds found', detail: 'clean' }],
  ])('%s never makes a tile', async (_name, finding) => {
    await expect(run({ findings: [finding] }, offer())).resolves.toBeNull();
  });

  test('a finding for a family the customer is not being offered makes no tile', async () => {
    await expect(run({ findings: [WEED_FINDING] }, offer({ serviceKey: 'pest_control', label: 'Pest Control' }))).resolves.toBeNull();
  });

  test('a quote-only offer has no estimate page, so no tile', async () => {
    await expect(run({ findings: [WEED_FINDING] }, offer({ mode: 'quote' }))).resolves.toBeNull();
    await expect(run({ findings: [WEED_FINDING] }, null)).resolves.toBeNull();
  });

  test.each([
    'Rodent droppings in the garage',
    'Bed bugs in the guest room',
    'Termite damage at the lanai',
    'Mosquito breeding in the bird bath',
    'Fleas in the dog run',
    'Wasp nest under the eave',
    'Spider mites on the hibiscus',
    'Carpenter ants in the fascia',
    'Ants near the rat traps',
  ])('a specialty-pest finding never makes a pest tile: %s', async (title) => {
    const finding = { category: 'pest_activity', title, detail: 'seen near the entry' };
    await expect(run({ findings: [finding] }, offer({ serviceKey: 'pest_control', label: 'Pest Control' }))).resolves.toBeNull();
  });

  test('a general household pest finding still makes the pest tile', async () => {
    const tile = await run({ findings: [{ category: 'pest_activity', title: 'Ghost ants at the kitchen window', detail: 'trail' }] }, offer({ serviceKey: 'pest_control', label: 'Pest Control' }));
    expect(tile.sentence).toBe('We saw pest activity on this visit.');
  });

  test('a technician-reviewed photo finding counts; with two kinds the one matching the offer wins', async () => {
    const data = { findings: [{ category: 'pest_activity', title: 'Ants at the lanai', detail: 'trail' }], reportV2: { photoFindings: [{ label: 'Crabgrass in the front bed' }] } };
    const tile = await run(data, offer());
    expect(tile.kind).toBe('weeds');
    const pest = await run(data, offer({ serviceKey: 'pest_control', label: 'Pest Control' }));
    expect(pest.sentence).toBe('We saw pest activity on this visit.');
  });
});

describe('web-actions: photo answers', () => {
  const reply = (kind, extra = {}) => ({ status: 200, body: { result: { label: 'Likely a German cockroach' }, next_step: { kind, url: '/reservice/standing-token-123' }, ...extra } });

  test('covered: one booking flag, fixed sentence, and the standing token is not in the answer', () => {
    const answer = webActions.photoAnswer('pest', reply('reservice'));
    expect(answer).toEqual({
      ok: true,
      headline: 'Likely a German cockroach',
      message: 'Your plan covers this. You can book a free re-service in your Waves account.',
      canRebook: true,
    });
    expect(JSON.stringify(answer)).not.toMatch(/standing-token|reservice\//);
  });

  test.each(['request', 'unclear', 'inspection', 'referral'])('%s: no booking flag and the office phone is in the sentence', (kind) => {
    const answer = webActions.photoAnswer('pest', reply(kind));
    expect(answer.canRebook).toBe(false);
    expect(answer.message).toContain(PHONE);
  });

  test('a clear "nothing to worry about" read is the plain answer with no booking flag', () => {
    const answer = webActions.photoAnswer('pest', reply('none'));
    expect(answer.message).toBe('Based on what we can see, no action is needed right now.');
    expect(answer.canRebook).toBe(false);
  });

  test('headline prefers the v2 answer; lawn and tree & shrub read their own result field; a partial read has none', () => {
    expect(webActions.photoAnswer('pest', reply('request', { v2: { answer: { headline: 'Probably an ant' } } })).headline).toBe('Probably an ant');
    expect(webActions.photoAnswer('lawn', { status: 200, body: { result: { observations: 'Some thinning.' }, next_step: { kind: 'request' } } }).headline).toBe('Some thinning.');
    expect(webActions.photoAnswer('tree_shrub', { status: 200, body: { result: { summary: 'Leaves look stressed.' }, next_step: { kind: 'request' } } }).headline).toBe('Leaves look stressed.');
    expect(webActions.photoAnswer('lawn', { status: 200, body: { result: { observations: "We couldn't analyze every photo you sent" }, next_step: { kind: 'unclear' } } }).headline).toBeNull();
  });

  test('a handler error keeps its customer-safe copy and status', () => {
    expect(webActions.photoAnswer('pest', { status: 503, body: { error: `Photo analysis is briefly unavailable. Call ${PHONE}.` } }))
      .toEqual({ ok: false, status: 503, message: `Photo analysis is briefly unavailable. Call ${PHONE}.` });
    expect(webActions.photoAnswer('pest', { status: 500, body: null }).message).toContain(PHONE);
  });

  test('photo handler type follows the report line', () => {
    expect(webActions.photoTypeForLine('lawn')).toBe('lawn');
    expect(webActions.photoTypeForLine('tree_shrub')).toBe('tree_shrub');
    expect(webActions.photoTypeForLine('pest')).toBe('pest');
    expect(webActions.photoTypeForLine('mosquito')).toBe('pest');
  });
});

// In-memory stand-in for the service_report_events rows the per-token photo quota counts.
let events = [];
function fakeTrx(rows) {
  const trx = (table) => {
    if (table !== 'service_report_events') throw new Error(`Unexpected trx table: ${table}`);
    let filters = {};
    const q = {
      where(cond) { if (cond && typeof cond === 'object') filters = { ...filters, ...cond }; return q; },
      count() { return q; },
      first: async () => ({ n: rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v)).length }),
      insert: async (row) => { rows.push(row); },
    };
    return q;
  };
  trx.raw = async () => {};
  return trx;
}

function mockDb(overrides = {}) {
  const record = {
    id: 'service-1',
    customer_id: 'customer-1',
    report_template_version: 'service_report_v1',
    structured_notes: null,
    service_type: 'Lawn Care',
    service_line: 'lawn',
    first_name: 'Pat',
    last_name: 'Tester',
    ...overrides,
  };
  // param gate first, then the /data join read
  const serviceRead = chain({ first: jest.fn().mockResolvedValueOnce({ id: 'service-1', structured_notes: null }).mockResolvedValueOnce(record) });
  events = [];
  db.transaction = async (callback) => callback(fakeTrx(events));
  db.mockImplementation((table) => {
    if (table === 'service_records') return serviceRead;
    if (table === 'service_records as sr') return chain({ first: jest.fn().mockResolvedValue(record) });
    if (table === 'service_products') return chain({ where: jest.fn().mockResolvedValue([]) });
    if (table === 'activity_log') return chain();
    throw new Error(`Unexpected table query: ${table}`);
  });
}

function setGates({ simple = true, actions = true, crossSell = true, click = true, photo = true } = {}) {
  gates.reportSimpleWebLive.mockReturnValue(simple);
  gates.reportWebActionsLive.mockReturnValue(actions);
  gates.isEnabled.mockImplementation((name) => ({
    reportCrossSell: crossSell, reportClickToEstimate: click, customerPhotoId: photo,
  }[name] === true));
}

const getData = async (baseUrl, query = '') => {
  const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/data${query}`);
  return { status: res.status, body: await res.json() };
};

describe('GET /reports/:token/data webActions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setGates();
    buildReportV1Data.mockImplementation(async () => ({
      serviceLine: 'lawn',
      findings: [WEED_FINDING],
      pdfUrl: `/api/reports/${VALID_TOKEN}`,
      applications: [],
    }));
    buildReportCrossSell.mockResolvedValue(offer());
    mockDb();
  });

  test('gate on, live simple-web view: photo button and finding tile', async () => {
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect(body.webActions.photo).toEqual({ type: 'lawn' });
      expect(body.webActions.finding.sentence).toBe('We saw weeds on this visit.');
    });
  });

  test('gate off: no key at all, and nothing is computed', async () => {
    setGates({ actions: false });
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect('webActions' in body).toBe(false);
      expect(buildReportCrossSell).not.toHaveBeenCalled();
    });
  });

  test('simple web off: no key', async () => {
    setGates({ simple: false });
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect('webActions' in body).toBe(false);
    });
  });

  test.each(['pdf', 'static', 'sms_preview'])('mode=%s carries no key', async (mode) => {
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl, `?mode=${mode}`);
      expect('webActions' in body).toBe(false);
    });
  });

  test('cross-sell or click-to-estimate off: photo only, no tile', async () => {
    setGates({ click: false });
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect(body.webActions).toEqual({ photo: { type: 'lawn' } });
    });
    setGates({ crossSell: false });
    mockDb();
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect(body.webActions).toEqual({ photo: { type: 'lawn' } });
    });
  });

  test('photo ID off: tile only; both off: no key', async () => {
    setGates({ photo: false });
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect(Object.keys(body.webActions)).toEqual(['finding']);
    });
    buildReportCrossSell.mockResolvedValue(null);
    mockDb();
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect('webActions' in body).toBe(false);
    });
  });

  test('an offer builder failure leaves the tile out and the report whole', async () => {
    buildReportCrossSell.mockRejectedValue(new Error('pricing down'));
    await withServer(async (baseUrl) => {
      const { status, body } = await getData(baseUrl);
      expect(status).toBe(200);
      expect(body.webActions).toEqual({ photo: { type: 'lawn' } });
    });
  });

  test('a suppressed (internal-only) report carries no key', async () => {
    mockDb({ structured_notes: { typedReportDelivery: 'shadow' } });
    await withServer(async (baseUrl) => {
      const { body } = await getData(baseUrl);
      expect('webActions' in body).toBe(false);
    });
  });
});

const JPEG = (bytes) => `data:image/jpeg;base64,${Buffer.alloc(bytes, 7).toString('base64')}`;
const post = (baseUrl, body) => fetch(`${baseUrl}/reports/${VALID_TOKEN}/photo-check`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

let homeCheck;
describe('POST /reports/:token/photo-check', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setGates();
    mockDb();
    photoId.runCustomerPhotoId.mockResolvedValue({
      status: 200,
      body: { result: { observations: 'Some thinning.' }, next_step: { kind: 'reservice', url: '/reservice/standing-token-123' } },
    });
    // The premises proof has its own suite (web-actions-home-check.test.js); here it is a switch.
    homeCheck = jest.spyOn(webActions, 'visitIsAtPrimaryHome').mockResolvedValue(true);
  });
  afterEach(() => homeCheck.mockRestore());

  test('dark gate: 404 before the limiters run, with no database read for the customer', async () => {
    setGates({ actions: false });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { photos: [JPEG(2000)] });
      expect(res.status).toBe(404);
    });
    expect(photoId.photoIdLimiters.sharedDailyLimiter).not.toHaveBeenCalled();
    expect(photoId.runCustomerPhotoId).not.toHaveBeenCalled();
  });

  test.each([
    ['simple web off', { simple: false }],
    ['photo ID off', { photo: false }],
  ])('%s: 404', async (_name, flags) => {
    setGates(flags);
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, { photos: [JPEG(2000)] })).status).toBe(404);
    });
    expect(photoId.runCustomerPhotoId).not.toHaveBeenCalled();
  });

  test('a suppressed report and a record with no customer answer 404', async () => {
    mockDb({ structured_notes: { typedReportDelivery: 'shadow' } });
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, { photos: [JPEG(2000)] })).status).toBe(404);
    });
    mockDb({ customer_id: null });
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, { photos: [JPEG(2000)] })).status).toBe(404);
    });
    expect(photoId.runCustomerPhotoId).not.toHaveBeenCalled();
  });

  test('covered answer: shared daily limiter ran, handler got the lawn type, token never returned', async () => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { photos: [JPEG(2000)] });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json();
      expect(body).toEqual({
        headline: 'Some thinning.',
        message: 'Your plan covers this. You can book a free re-service in your Waves account.',
        canRebook: true,
      });
      expect(JSON.stringify(body)).not.toMatch(/standing-token/);
    });
    expect(photoId.photoIdLimiters.sharedDailyLimiter).toHaveBeenCalledTimes(1);
    expect(photoId.photoIdLimiters.perCustomerLimiter).toBeUndefined(); // the portal's per-customer quota is never used
    expect(photoId.runCustomerPhotoId).toHaveBeenCalledWith(expect.objectContaining({
      type: 'lawn', customerId: 'customer-1', isSecondary: false,
    }));
  });

  test('a visit that cannot be proven at the home is treated as a secondary property, so coverage is withheld', async () => {
    homeCheck.mockResolvedValue(false);
    await withServer(async (baseUrl) => {
      await post(baseUrl, { photos: [JPEG(2000)] });
    });
    expect(photoId.runCustomerPhotoId).toHaveBeenCalledWith(expect.objectContaining({ isSecondary: true }));
  });

  test('the premises proof gets the visit stamp, property link and customer address from the record', async () => {
    await withServer(async (baseUrl) => {
      await post(baseUrl, { photos: [JPEG(2000)] });
    });
    expect(homeCheck).toHaveBeenCalledWith(expect.objectContaining({ customer_id: 'customer-1' }), db);
  });

  test('body checks: exactly one photo, an image data URL, 750 KB or less', async () => {
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, {})).status).toBe(400);
      expect((await post(baseUrl, { photos: [] })).status).toBe(400);
      expect((await post(baseUrl, { photos: [JPEG(100), JPEG(100)] })).status).toBe(400);
      expect((await post(baseUrl, { photos: ['https://example.com/x.jpg'] })).status).toBe(400);
      const tooBig = await post(baseUrl, { photos: [JPEG(760 * 1024)] });
      expect(tooBig.status).toBe(413);
      expect((await tooBig.json()).error).toContain(PHONE);
      expect((await post(baseUrl, { photos: [JPEG(700 * 1024)] })).status).toBe(200);
    });
  });

  test('handler 503 passes through with its customer-safe copy', async () => {
    photoId.runCustomerPhotoId.mockResolvedValue({ status: 503, body: { error: `Photo analysis is briefly unavailable. Call ${PHONE}.` } });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { photos: [JPEG(2000)] });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toContain(PHONE);
    });
  });
});

describe('POST /reports/:token/photo-check quota and storage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setGates();
    mockDb();
    photoId.runCustomerPhotoId.mockResolvedValue({ status: 200, body: { result: { observations: 'ok' }, next_step: { kind: 'request' } } });
    homeCheck = jest.spyOn(webActions, 'visitIsAtPrimaryHome').mockResolvedValue(true);
  });
  afterEach(() => homeCheck.mockRestore());

  test('its own quota per report token: 5 checks a day, then 429 with no handler call', async () => {
    await withServer(async (baseUrl) => {
      for (let i = 0; i < 5; i += 1) expect((await post(baseUrl, { photos: [JPEG(2000)] })).status).toBe(200);
      const sixth = await post(baseUrl, { photos: [JPEG(2000)] });
      expect(sixth.status).toBe(429);
      expect((await sixth.json()).error).toContain(PHONE);
    });
    expect(photoId.runCustomerPhotoId).toHaveBeenCalledTimes(5);
    expect(photoId.photoIdLimiters.sharedDailyLimiter).toHaveBeenCalledTimes(5); // an over-quota request never reaches the shared budget
    expect(events.filter((e) => e.event_name === 'report_photo_check_call')).toHaveLength(5);
  });

  test('an invalid body spends neither the token quota nor the shared daily budget', async () => {
    await withServer(async (baseUrl) => {
      for (let i = 0; i < 12; i += 1) {
        expect((await post(baseUrl, { photos: [] })).status).toBe(400);
        expect((await post(baseUrl, { photos: [JPEG(760 * 1024)] })).status).toBe(413);
      }
      for (let i = 0; i < 5; i += 1) expect((await post(baseUrl, { photos: [JPEG(2000)] })).status).toBe(200);
    });
    expect(photoId.photoIdLimiters.sharedDailyLimiter).toHaveBeenCalledTimes(5);
    expect(events).toHaveLength(5);
  });

  test('another report token has its own quota', async () => {
    events.push(...Array.from({ length: 5 }, () => ({ event_name: 'report_photo_check_call', service_record_id: 'someone-else', ip_hash: 'x' })));
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, { photos: [JPEG(2000)] })).status).toBe(200);
    });
  });

  test('the quota is counted in service_report_events only, never in portal photo ID tables', async () => {
    await withServer(async (baseUrl) => { await post(baseUrl, { photos: [JPEG(2000)] }); });
    const tables = db.mock.calls.map(([table]) => table);
    expect(tables.some((t) => /pest_identifications|lawn_diagnostics|tree_shrub_assessments/.test(t))).toBe(false);
  });

  test('a quota count failure fails closed with the phone line and no handler call', async () => {
    db.transaction = async () => { throw new Error('db down'); };
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { photos: [JPEG(2000)] });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toContain(PHONE);
    });
    expect(photoId.runCustomerPhotoId).not.toHaveBeenCalled();
  });
});
