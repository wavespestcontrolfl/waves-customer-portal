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

// The tile maps only from structured identity: an insight card's category on a report of a specific service line.
const insight = (category, status = 'watch') => ({ category, status, confidence: 'ai_supported', headline: 'x' });
const LAWN_WEEDS = { serviceLine: 'lawn', reportV2: { insights: [insight('weeds')] } };
const SHRUB_PESTS = { serviceLine: 'tree_shrub', reportV2: { insights: [insight('pest_pressure', 'needs_attention')] } };
const WEED_FINDING = { id: 'f1', category: 'weed_pressure', title: 'Weeds along the driveway', detail: 'Broadleaf weeds in the edge.', recommendation: '' };

describe('web-actions: finding tile (structured identity only)', () => {
  const run = (data, crossSell) => webActions.buildFindingTile(data, { buildCrossSell: async () => crossSell });

  test('a lawn-line weeds insight and a lawn offer make one tile with a fixed sentence and no price text', async () => {
    const tile = await run(LAWN_WEEDS, offer());
    expect(tile.sentence).toBe('We saw weeds on this visit.');
    expect(tile.button).toBe('See your estimate');
    expect(tile.body).toBe('Lawn Care can take care of this. Tap below to see your estimate. Nothing is booked or charged.');
    expect(`${tile.sentence} ${tile.body} ${tile.button}`).not.toMatch(/\$|per visit|per month/i);
    expect(tile.tap).toEqual({
      source: 'web_actions_finding_tile',
      kind: 'weeds',
      serviceKey: 'lawn_care', serviceLabel: 'Lawn Care', optionId: 'lawn-enhanced', perApplication: 61.5, offerMode: 'priced', fingerprint: 'fp-1',
    });
  });

  test('a tree & shrub pest-pressure insight and a tree & shrub offer make the shrub tile', async () => {
    const tile = await run(SHRUB_PESTS, offer({ serviceKey: 'tree_shrub', label: 'Tree & Shrub Care' }));
    expect(tile.sentence).toBe('We noted signs of plant pests on this visit.');
    expect(tile.kind).toBe('shrub_pests');
  });

  test('the table is explicit: two rows, each tied to a service line and an insight category', () => {
    expect(webActions.STRUCTURED_FINDING_TABLE.map((row) => `${row.line}:${row.category}:${row.family}`)).toEqual([
      'lawn:weeds:lawn_care', 'tree_shrub:pest_pressure:tree_shrub',
    ]);
  });

  test('no insight: no tile, and the offer builder is never asked', async () => {
    const buildCrossSell = jest.fn();
    await expect(webActions.buildFindingTile({ serviceLine: 'lawn', reportV2: { insights: [] } }, { buildCrossSell })).resolves.toBeNull();
    await expect(webActions.buildFindingTile({ serviceLine: 'lawn' }, { buildCrossSell })).resolves.toBeNull();
    expect(buildCrossSell).not.toHaveBeenCalled();
  });

  test('free text never decides a kind: finding titles, details and photo labels are ignored', async () => {
    const buildCrossSell = jest.fn();
    const texty = {
      serviceLine: 'lawn',
      findings: [WEED_FINDING, { category: 'pest_activity', title: 'Ghost ants at the kitchen window', detail: 'trail' }],
      reportV2: { photoFindings: [{ label: 'Crabgrass in the front bed' }], insights: [] },
    };
    await expect(webActions.buildFindingTile(texty, { buildCrossSell })).resolves.toBeNull();
    expect(buildCrossSell).not.toHaveBeenCalled();
  });

  test('a fungal leaf spot finding on a shrub never makes a lawn tile (the old keyword bug)', async () => {
    const data = {
      serviceLine: 'tree_shrub',
      findings: [{ category: 'observation', title: 'Fungal leaf spots on hibiscus', detail: 'fungal spotting on the leaves' }],
      reportV2: { insights: [insight('disease_leaf_spot', 'needs_attention')] },
    };
    await expect(run(data, offer())).resolves.toBeNull(); // lawn offer
    await expect(run(data, offer({ serviceKey: 'tree_shrub', label: 'Tree & Shrub Care' }))).resolves.toBeNull();
  });

  test('lawn weeds only count on a LAWN-line report, and shrub pests only on a tree & shrub one', async () => {
    await expect(run({ serviceLine: 'pest', reportV2: { insights: [insight('weeds')] } }, offer())).resolves.toBeNull();
    await expect(run({ serviceLine: 'tree_shrub', reportV2: { insights: [insight('weeds')] } }, offer())).resolves.toBeNull();
    await expect(run({ serviceLine: 'lawn', reportV2: { insights: [insight('pest_pressure')] } }, offer({ serviceKey: 'tree_shrub', label: 'Tree & Shrub Care' }))).resolves.toBeNull();
  });

  test.each(['healthy', 'strong', 'stable', 'good', 'tracking', 'unknown', ''])('a clear insight (%s) is not a finding', async (status) => {
    await expect(run({ serviceLine: 'lawn', reportV2: { insights: [insight('weeds', status)] } }, offer())).resolves.toBeNull();
  });

  test.each([
    'rodent', 'bed_bug', 'termite', 'mosquito', 'flea', 'tick', 'wasp', 'carpenter_ant', 'spider_mites', 'pest_activity', 'household_pests',
  ])('a specialty or unmapped pest category (%s) never makes a pest tile', async (category) => {
    const pest = offer({ serviceKey: 'pest_control', label: 'Pest Control' });
    for (const serviceLine of ['pest', 'lawn', 'tree_shrub', 'rodent', 'termite', 'mosquito']) {
      await expect(run({ serviceLine, reportV2: { insights: [insight(category, 'needs_attention')] } }, pest)).resolves.toBeNull();
    }
  });

  test('the offered family must match the finding: a weeds finding with a pest offer makes no tile', async () => {
    await expect(run(LAWN_WEEDS, offer({ serviceKey: 'pest_control', label: 'Pest Control' }))).resolves.toBeNull();
  });

  test('a quote-only offer has no estimate page, so no tile', async () => {
    await expect(run(LAWN_WEEDS, offer({ mode: 'quote' }))).resolves.toBeNull();
    await expect(run(LAWN_WEEDS, null)).resolves.toBeNull();
  });
});

describe('web-actions: callbacks never get a tile', () => {
  test('a callback gets no finding tile even with GATE_RESERVICE_REPORT_COPY off', async () => {
    const prev = process.env.GATE_RESERVICE_REPORT_COPY;
    delete process.env.GATE_RESERVICE_REPORT_COPY;
    try {
      const gates = {
        reportWebActionsLive: () => true, reportSimpleWebLive: () => true,
        isEnabled: (name) => ['reportCrossSell', 'reportClickToEstimate'].includes(name),
      };
      const data = { ...structuredClone(LAWN_WEEDS), isCallback: true };
      const db = jest.fn(() => { throw new Error('no cross-sell read on a callback'); });
      await webActions.attachWebActions({ id: 's1' }, data, { db, gates, simpleWeb: true });
      expect(data.webActions?.finding).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.GATE_RESERVICE_REPORT_COPY; else process.env.GATE_RESERVICE_REPORT_COPY = prev;
    }
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

  test('a fix_conditions plant hint never reads as "no action is needed", even though its next_step kind is none', () => {
    const answer = webActions.photoAnswer('lawn', {
      status: 200,
      body: { result: { observations: 'Some thinning.' }, next_step: { kind: 'none' }, v2: { next_step_hint: { kind: 'fix_conditions', text: 'Water less.' } } },
    });
    expect(answer.message).toBe(`This looks like a growing-conditions problem, not a pest. Call us at ${PHONE} and we will tell you what to change.`);
    expect(answer.message).not.toMatch(/no action/i);
    expect(answer.canRebook).toBe(false);
    // a covered plan does not turn it into a booking either
    expect(webActions.photoAnswer('lawn', { status: 200, body: { next_step: { kind: 'reservice', url: '/reservice/x' }, v2: { next_step_hint: { kind: 'fix_conditions' } } } }).canRebook).toBe(false);
    // other hints keep the next_step outcome
    expect(webActions.photoAnswer('lawn', { status: 200, body: { next_step: { kind: 'none' }, v2: { next_step_hint: { kind: 'none' } } } }).message).toBe('Based on what we can see, no action is needed right now.');
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
    expect(webActions.photoTypeForLine('palm')).toBe('tree_shrub'); // palm reads with the plant handler
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
      reportV2: { insights: [insight('weeds')] },
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

describe('the finding tile tap rechecks its gates', () => {
  const TILE_META = { source: 'web_actions_finding_tile', kind: 'weeds', serviceKey: 'lawn_care', serviceLabel: 'Lawn Care', optionId: 'x', perApplication: 61.5, offerMode: 'priced', fingerprint: 'fp' };
  const tap = (baseUrl, metadata) => fetch(`${baseUrl}/reports/${VALID_TOKEN}/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventName: 'cross_sell_requested', channel: 'public_report', metadata }),
  });

  // Every service_records read answers the same record, and the tables the report build touches are stubbed;
  // `touched` lists every table a request reads or writes, `writes` every insert/update.
  let touched;
  let writes;
  const tileDb = (record = {}) => {
    const row = { id: 'service-1', customer_id: 'customer-1', report_template_version: 'service_report_v1', structured_notes: null, is_callback: false, first_name: 'Pat', last_name: 'Tester', ...record };
    touched = [];
    writes = [];
    db.mockImplementation((table) => {
      touched.push(table);
      const base = chain({
        first: jest.fn().mockResolvedValue(row),
        insert: jest.fn(async () => { writes.push(table); return 1; }),
        update: jest.fn(async () => { writes.push(table); return 1; }),
      });
      if (table === 'service_products') return chain({ where: jest.fn().mockResolvedValue([]) });
      if (table === 'service_records' || table === 'service_records as sr' || table === 'activity_log') return base;
      throw new Error(`Unexpected table query: ${table}`);
    });
  };
  const liveReport = (insights = [insight('weeds')], extra = {}) => buildReportV1Data.mockImplementation(async () => ({
    serviceLine: 'lawn', reportV2: { insights }, pdfUrl: `/api/reports/${VALID_TOKEN}`, applications: [], ...extra,
  }));

  beforeEach(() => {
    jest.clearAllMocks();
    setGates();
    mockDb();
    tileDb();
    liveReport();
    buildReportCrossSell.mockResolvedValue(offer());
  });

  test('the offer made for the tile carries the tile source in its tap metadata', async () => {
    const tile = await webActions.buildFindingTile(LAWN_WEEDS, { buildCrossSell: async () => offer() });
    expect(tile.tap.source).toBe(webActions.WEB_TILE_SOURCE);
  });

  test.each([
    ['web actions off', { actions: false }],
    ['click-to-estimate off', { click: false }],
    ['simple web off', { simple: false }],
  ])('%s: a tile tap answers 409 before any lookup or write', async (_name, flags) => {
    setGates({ crossSell: true, ...flags });
    await withServer(async (baseUrl) => {
      const res = await tap(baseUrl, TILE_META);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/no longer available/);
    });
    expect(db).not.toHaveBeenCalled();
    expect(buildReportCrossSell).not.toHaveBeenCalled();
  });

  test('a callback visit refuses the tile tap (409) unconditionally, whatever GATE_RESERVICE_REPORT_COPY says', async () => {
    const prev = process.env.GATE_RESERVICE_REPORT_COPY;
    delete process.env.GATE_RESERVICE_REPORT_COPY;
    try {
      const callbackRecord = { id: 'service-1', customer_id: 'customer-1', report_template_version: 'service_report_v1', structured_notes: null, is_callback: true };
      db.mockImplementation((table) => {
        if (table === 'service_records') return chain({ first: jest.fn().mockResolvedValue(callbackRecord) });
        throw new Error(`Unexpected table query: ${table}`);
      });
      await withServer(async (baseUrl) => {
        const res = await tap(baseUrl, TILE_META);
        expect(res.status).toBe(409);
        expect((await res.json()).error).toMatch(/no longer available/);
      });
      expect(buildReportCrossSell).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.GATE_RESERVICE_REPORT_COPY; else process.env.GATE_RESERVICE_REPORT_COPY = prev;
    }
  });

  test('both gates live and the report still shows the same finding: the tap goes on to the normal path (offer recomputed)', async () => {
    await withServer(async (baseUrl) => {
      await tap(baseUrl, TILE_META); // its own fingerprint check may still answer 409 downstream; what matters is it got past the tile gate
    });
    expect(buildReportCrossSell).toHaveBeenCalled();
  });

  test('a stale tab: the report\'s insight changed, so the tap answers 409 and creates no request or estimate', async () => {
    liveReport([insight('weeds', 'healthy')]);
    await withServer(async (baseUrl) => {
      const res = await tap(baseUrl, TILE_META);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/no longer available/);
    });
    expect(buildReportCrossSell).not.toHaveBeenCalled(); // never reached the offer recompute
    expect(writes).toEqual([]); // nothing inserted or updated anywhere
    expect(touched.every((t) => /service_records|service_products|activity_log/.test(t))).toBe(true);
    expect(touched).not.toContain('service_requests');
    expect(touched).not.toContain('estimates');
  });

  test.each([
    ['the finding is gone from the report', () => liveReport([])],
    ['it is a different kind of finding now', () => liveReport([insight('pest_pressure', 'needs_attention')], { serviceLine: 'tree_shrub' })],
    ['the report became a callback', () => liveReport([insight('weeds')], { isCallback: true })],
    ['the report went internal-only', () => liveReport([insight('weeds')], { internalOnly: true })],
  ])('%s: the tap answers 409 and nothing is written', async (_name, change) => {
    change();
    await withServer(async (baseUrl) => {
      expect((await tap(baseUrl, TILE_META)).status).toBe(409);
    });
    expect(buildReportCrossSell).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  test('the finding changes between the preflight and the write: the in-transaction recheck refuses with 409 and no request or estimate', async () => {
    jest.doMock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => {}) }));
    const txWrites = [];
    const txTouched = [];
    const makeTrx = () => {
      const trx = (table) => {
        txTouched.push(table);
        const q = {
          where() { return q; }, whereIn() { return q; }, whereNotIn() { return q; }, orderBy() { return q; }, forUpdate() { return q; },
          first: async () => (table === 'customers' || table === 'service_records' ? { id: 'x' } : undefined),
          update: async () => { txWrites.push(`update:${table}`); return 1; },
          insert: (row) => { txWrites.push(`insert:${table}`); return { returning: async () => [{ id: 'req-1', ...row }] }; },
        };
        return q;
      };
      trx.raw = async () => {};
      return trx;
    };
    db.transaction = async (callback) => callback(makeTrx());
    // first build (the preflight) shows the weeds insight; the next (inside the transaction) no longer does
    let builds = 0;
    buildReportV1Data.mockImplementation(async () => {
      builds += 1;
      return { serviceLine: 'lawn', reportV2: { insights: builds === 1 ? [insight('weeds')] : [insight('weeds', 'healthy')] }, pdfUrl: '/x', applications: [] };
    });
    const matching = { ...TILE_META, optionId: 'lawn-enhanced', perApplication: 61.5, fingerprint: 'fp-1' };
    await withServer(async (baseUrl) => {
      const res = await tap(baseUrl, matching);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/no longer available/);
    });
    expect(builds).toBe(2); // preflight + the recheck under the lock
    expect(txTouched).toContain('customers'); // it did reach the write transaction
    expect(txTouched).toContain('service_records'); // ...and locked the service row
    expect(txWrites).toEqual([]); // no service request, no event, no estimate
    expect(txTouched).not.toContain('service_requests');
    expect(txTouched).not.toContain('estimates');
  });

  test('the finding still stands at the recheck: the write goes ahead (control for the refusal above)', async () => {
    jest.doMock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => {}) }));
    const txWrites = [];
    const trx = (table) => {
      const q = {
        where() { return q; }, whereIn() { return q; }, whereNotIn() { return q; }, orderBy() { return q; }, forUpdate() { return q; },
        first: async () => (table === 'customers' || table === 'service_records' ? { id: 'x' } : undefined),
        update: async () => 1,
        insert: (row) => { txWrites.push(table); return { returning: async () => [{ id: 'req-1', ...row }] }; },
      };
      return q;
    };
    trx.raw = async () => {};
    db.transaction = async (callback) => callback(trx);
    const matching = { ...TILE_META, optionId: 'lawn-enhanced', perApplication: 61.5, fingerprint: 'fp-1' };
    await withServer(async (baseUrl) => { await tap(baseUrl, matching); });
    expect(txWrites).toContain('service_requests');
  });

  test('a tap whose kind or service the table does not pair is refused even while the finding stands', async () => {
    await withServer(async (baseUrl) => {
      expect((await tap(baseUrl, { ...TILE_META, kind: 'shrub_pests' })).status).toBe(409);
      expect((await tap(baseUrl, { ...TILE_META, serviceKey: 'pest_control' })).status).toBe(409);
      expect((await tap(baseUrl, { ...TILE_META, kind: undefined })).status).toBe(409);
    });
    expect(buildReportCrossSell).not.toHaveBeenCalled();
  });

  test('a failed re-derive fails closed with a retry message and no write', async () => {
    buildReportV1Data.mockImplementation(async () => { throw new Error('db down'); });
    await withServer(async (baseUrl) => {
      const res = await tap(baseUrl, TILE_META);
      expect(res.status).toBe(503);
    });
    expect(writes).toEqual([]);
  });

  test('the old report card\'s tap (no tile source) is not affected by the tile gates', async () => {
    setGates({ actions: false, click: false });
    await withServer(async (baseUrl) => {
      const { source: _tile, ...oldCard } = TILE_META;
      await tap(baseUrl, oldCard); // may still 409 on its own fingerprint check; what matters is the tile gate did not stop it
    });
    expect(buildReportCrossSell).toHaveBeenCalled();
  });

  test('webTileTapAllowed reads the gates strictly', () => {
    const gatesOn = { reportSimpleWebLive: () => true, reportWebActionsLive: () => true, isEnabled: () => true };
    expect(webActions.webTileTapAllowed({ source: webActions.WEB_TILE_SOURCE }, gatesOn)).toBe(true);
    expect(webActions.webTileTapAllowed({ source: webActions.WEB_TILE_SOURCE }, { ...gatesOn, isEnabled: () => false })).toBe(false);
    expect(webActions.webTileTapAllowed({ source: webActions.WEB_TILE_SOURCE }, { ...gatesOn, reportWebActionsLive: () => false })).toBe(false);
    expect(webActions.webTileTapAllowed({ source: webActions.WEB_TILE_SOURCE }, {})).toBe(false);
    expect(webActions.webTileTapAllowed({}, {})).toBe(true);
    expect(webActions.webTileTapAllowed(null, {})).toBe(true);
  });
});

describe('POST /reports/:token/photo-check palm subject', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setGates();
    photoId.runCustomerPhotoId.mockResolvedValue({ status: 200, body: { result: { summary: 'ok' }, next_step: { kind: 'request' } } });
    homeCheck = jest.spyOn(webActions, 'visitIsAtPrimaryHome').mockResolvedValue(true);
  });
  afterEach(() => homeCheck.mockRestore());

  test('a palm report runs the plant handler with the palm subject; other lines pass none', async () => {
    mockDb({ service_line: 'palm', service_type: 'Palm Tree Injections' });
    await withServer(async (baseUrl) => { await post(baseUrl, { photos: [JPEG(2000)] }); });
    expect(photoId.runCustomerPhotoId).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'tree_shrub', subject: 'palm' }));
    mockDb({ service_line: 'tree_shrub' });
    await withServer(async (baseUrl) => { await post(baseUrl, { photos: [JPEG(2000)] }); });
    expect(photoId.runCustomerPhotoId).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'tree_shrub', subject: null }));
    mockDb({ service_line: 'lawn' });
    await withServer(async (baseUrl) => { await post(baseUrl, { photos: [JPEG(2000)] }); });
    expect(photoId.runCustomerPhotoId).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'lawn', subject: null }));
  });

  test('photoSubjectForLine', () => {
    expect(webActions.photoSubjectForLine('palm')).toBe('palm');
    expect(webActions.photoSubjectForLine('tree_shrub')).toBeNull();
    expect(webActions.photoSubjectForLine(undefined)).toBeNull();
  });
});

describe('POST /reports/:token/photo-check pixel bomb is refused before any counter', () => {
  const sharp = require('sharp');
  async function bombJpeg(width, height) {
    const jpeg = Buffer.from(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).jpeg().toBuffer());
    for (let i = 0; i < jpeg.length - 9; i += 1) {
      if (jpeg[i] === 0xff && (jpeg[i + 1] === 0xc0 || jpeg[i + 1] === 0xc2)) { jpeg.writeUInt16BE(height, i + 5); jpeg.writeUInt16BE(width, i + 7); return jpeg; }
    }
    throw new Error('no SOF');
  }

  beforeEach(() => {
    jest.clearAllMocks();
    setGates();
    mockDb();
    photoId.runCustomerPhotoId.mockResolvedValue({ status: 200, body: { result: { summary: 'ok' }, next_step: { kind: 'request' } } });
    homeCheck = jest.spyOn(webActions, 'visitIsAtPrimaryHome').mockResolvedValue(true);
  });
  afterEach(() => homeCheck.mockRestore());

  test('a tiny file claiming 60000 x 60000 pixels answers 413 with the phone and spends neither the token quota nor the shared limiter', async () => {
    const bomb = `data:image/jpeg;base64,${(await bombJpeg(60000, 60000)).toString('base64')}`;
    await withServer(async (baseUrl) => {
      for (let i = 0; i < 8; i += 1) {
        const res = await post(baseUrl, { photos: [bomb] });
        expect(res.status).toBe(413);
        expect((await res.json()).error).toContain(PHONE);
      }
      // the quota is untouched: all 5 real attempts still succeed afterwards
      for (let i = 0; i < 5; i += 1) expect((await post(baseUrl, { photos: [JPEG(2000)] })).status).toBe(200);
    });
    expect(events.filter((e) => e.event_name === 'report_photo_check_call')).toHaveLength(5);
    expect(photoId.photoIdLimiters.sharedDailyLimiter).toHaveBeenCalledTimes(5);
    expect(photoId.runCustomerPhotoId).toHaveBeenCalledTimes(5);
  });
});
