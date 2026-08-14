jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  mock.transaction = jest.fn(async (cb) => cb(mock));
  return mock;
});
// Default OFF so the existing limiter test still sees the dark-gate 400;
// the cross-sell click tests turn it on for themselves.
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/service-report/cross-sell', () => ({ buildReportCrossSell: jest.fn() }));
jest.mock('../services/service-report/click-estimate-mint', () => ({ mintReportClickEstimate: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn().mockResolvedValue(null) }));
jest.mock('../config', () => ({
  s3: { bucket: 'test-bucket', region: 'us-east-1' },
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({})),
  GetObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));
jest.mock('../services/pest-pressure/orchestrate', () => ({
  runAndSwallowErrors: jest.fn().mockResolvedValue(null),
  calculateAndPersistForServiceRecord: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/pest-pressure/store', () => ({
  loadActiveConfig: jest.fn(),
  loadScoreForServiceRecord: jest.fn(),
  loadHistoryForCustomer: jest.fn().mockResolvedValue([]),
}));

const express = require('express');
const db = require('../models/db');
const reportsRouter = require('../routes/reports-public');

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    first: jest.fn(),
    insert: jest.fn().mockResolvedValue(1),
    ...overrides,
  };
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/reports', reportsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const VALID_TOKEN = '0123456789abcdef0123456789abcdef';

describe('POST /reports/:token/events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('allows lawn report outline linkage telemetry', async () => {
    const serviceRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'service-1',
        customer_id: 'customer-1',
        report_template_version: 'service_report_v1',
      }),
    });
    const eventInsert = chain();
    db.mockImplementation((table) => {
      if (table === 'service_records') return serviceRead;
      if (table === 'service_report_events') return eventInsert;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${VALID_TOKEN}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventName: 'service_report_linked_to_outline',
          metadata: { packetId: 'packet-1', packetStatus: 'viewed' },
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({ ok: true });
      expect(eventInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
        service_record_id: 'service-1',
        customer_id: 'customer-1',
        event_name: 'service_report_linked_to_outline',
        channel: 'public_report',
        metadata: JSON.stringify({ packetId: 'packet-1', packetStatus: 'viewed' }),
      }));
    });
  });

  test('a whitespace-padded cross_sell_requested still hits the low action limiter (PR r11 P1)', async () => {
    // The handler TRIMS the event name before matching, so the limiter's
    // skip() must trim identically — comparing the raw body value let
    // `' cross_sell_requested '` bypass the 5/min action limiter and drive
    // the full pricing recomputation + durable writes at the 120/min
    // analytics rate. The gate is off here, so every admitted request stops
    // at the handler's 400; the 6th must be the limiter's 429 instead.
    const serviceRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'service-2',
        customer_id: 'customer-2',
        report_template_version: 'service_report_v1',
      }),
    });
    db.mockImplementation((table) => {
      if (table === 'service_records') return serviceRead;
      throw new Error(`Unexpected table query: ${table}`);
    });

    // Own token: the limiter keys per token, so this cannot bleed into
    // (or inherit from) any other test's budget.
    const token = 'ffffffffffffffff0123456789abcdef';
    await withServer(async (baseUrl) => {
      const post = () => fetch(`${baseUrl}/reports/${token}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventName: '  cross_sell_requested  ' }),
      });
      const statuses = [];
      for (let i = 0; i < 6; i += 1) {
        statuses.push((await post()).status);
      }
      // Five admitted (rejected by the dark gate as an unknown event), then
      // the limiter takes over.
      expect(statuses.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
      expect(statuses[5]).toBe(429);
    });
  });
});

describe('cross-sell click: identical resubmit vs material refresh (PR r12 P2)', () => {
  const { isEnabled } = require('../config/feature-gates');
  const { buildReportCrossSell } = require('../services/service-report/cross-sell');
  const { triggerNotification } = require('../services/notification-triggers');

  const CROSS_SELL = {
    serviceKey: 'lawn_care',
    label: 'Lawn Care',
    mode: 'priced',
    relationship: 'add',
    fingerprint: 'FINGERPRINT-1',
    option: { id: 'lawn-enhanced', label: 'Lawn care — 9x applications/yr', perVisit: 57.6 },
  };
  // What the route persists for that offer.
  const snapshotFor = (serviceRecordId) => ({
    source: 'service_report', serviceRecordId, crossSell: CROSS_SELL,
  });

  // A single chainable stand-in for every table the click path touches.
  function clickDb({ openRequest }) {
    const updates = [];
    const inserts = [];
    const q = (table) => {
      const chain = {
        leftJoin: () => chain,
        where: () => chain,
        // The shared CTA writer spans sources with whereIn + picks the
        // newest open row with orderBy.
        whereIn: () => chain,
        orderBy: () => chain,
        whereNotIn: () => chain,
        forUpdate: () => chain,
        select: () => chain,
        returning: async () => [{ id: 'req-new' }],
        update: async (patch) => { updates.push({ table, patch }); return 1; },
        insert: (row) => {
          inserts.push({ table, row });
          return { returning: async () => [{ id: 'req-new', ...row }] };
        },
        first: async () => {
          if (table === 'service_records') {
            return { id: 'sr-1', customer_id: 'cust-1', report_template_version: 'service_report_v1' };
          }
          if (table === 'service_records as sr') {
            return { id: 'sr-1', customer_id: 'cust-1', first_name: 'Pat', last_name: 'Q' };
          }
          if (table === 'service_requests') return openRequest;
          if (table === 'customers') return { id: 'cust-1' };
          return null;
        },
      };
      return chain;
    };
    return { q, updates, inserts };
  }

  const clickBody = {
    eventName: 'cross_sell_requested',
    metadata: {
      serviceKey: 'lawn_care', offerMode: 'priced', perApplication: 57.6,
      optionId: 'lawn-enhanced', fingerprint: 'FINGERPRINT-1',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    isEnabled.mockReturnValue(true);
    buildReportCrossSell.mockResolvedValue(CROSS_SELL);
  });
  afterEach(() => { isEnabled.mockReturnValue(false); });

  async function click(token) {
    return withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${token}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(clickBody),
      });
      return res.status;
    });
  }

  test('an IDENTICAL resubmit stays a silent no-op — no update, no bell', async () => {
    const { q, updates } = clickDb({
      openRequest: {
        id: 'req-1',
        subject: 'Add Lawn Care — requested from service report',
        // Stored the way PostgreSQL hands JSONB back: keys reordered.
        pricing_revision: { crossSell: CROSS_SELL, serviceRecordId: 'sr-1', source: 'service_report' },
      },
    });
    db.mockImplementation(q);

    expect(await click('aaaaaaaaaaaaaaaa0123456789abcdef')).toBe(200);
    expect(updates.filter((u) => u.table === 'service_requests')).toHaveLength(0);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('a MATERIAL refresh updates the row, stamps updated_at, and rings the bell', async () => {
    // Same family and still open, but the stored snapshot is a DIFFERENT
    // offer (an older price). The customer just price-locked new terms, so
    // staff who already triaged the old request must be told.
    const stale = snapshotFor('sr-1');
    stale.crossSell = { ...CROSS_SELL, option: { ...CROSS_SELL.option, perVisit: 49.0 } };
    const { q, updates } = clickDb({
      openRequest: {
        id: 'req-1',
        subject: 'Add Lawn Care — requested from service report',
        pricing_revision: stale,
      },
    });
    db.mockImplementation(q);

    expect(await click('bbbbbbbbbbbbbbbb0123456789abcdef')).toBe(200);
    const rowUpdates = updates.filter((u) => u.table === 'service_requests');
    expect(rowUpdates).toHaveLength(1);
    expect(rowUpdates[0].patch.updated_at).toBeInstanceOf(Date);
    expect(JSON.parse(rowUpdates[0].patch.pricing_revision).crossSell.option.perVisit).toBe(57.6);
    expect(triggerNotification).toHaveBeenCalledWith('bundle_quote_requested', expect.objectContaining({
      customerId: 'cust-1',
      refreshed: true,
    }));
  });

  test('a FIRST-TIME request inserts and rings the bell unrefreshed', async () => {
    const { q, inserts } = clickDb({ openRequest: null });
    db.mockImplementation(q);

    expect(await click('cccccccccccccccc0123456789abcdef')).toBe(200);
    expect(inserts.filter((i) => i.table === 'service_requests')).toHaveLength(1);
    expect(triggerNotification).toHaveBeenCalledWith('bundle_quote_requested', expect.objectContaining({
      refreshed: false,
    }));
  });
});

describe('click-to-estimate mint (GATE_REPORT_CLICK_TO_ESTIMATE)', () => {
  const { isEnabled } = require('../config/feature-gates');
  const { buildReportCrossSell } = require('../services/service-report/cross-sell');
  const { mintReportClickEstimate } = require('../services/service-report/click-estimate-mint');

  const ENGINE_CONTEXT = {
    propertyInput: { homeSqFt: 2100 },
    targetOnlyServices: { lawn: { track: 'B' } },
    currentServiceKeys: ['pest'],
    customer: { id: 'cust-1', first_name: 'Testa', address_line1: '12 Invented Way' },
  };
  const PRICED_OFFER = {
    serviceKey: 'lawn_care',
    label: 'Lawn Care',
    mode: 'priced',
    relationship: 'add',
    fingerprint: 'FINGERPRINT-1',
    option: { id: 'lawn-enhanced', label: 'Lawn care — 9x applications/yr', perVisit: 57.6 },
    engineContext: ENGINE_CONTEXT,
  };
  const clickBody = {
    eventName: 'cross_sell_requested',
    metadata: {
      serviceKey: 'lawn_care', offerMode: 'priced', perApplication: 57.6,
      optionId: 'lawn-enhanced', fingerprint: 'FINGERPRINT-1',
    },
  };

  function clickDb({ openRequest = null } = {}) {
    const updates = [];
    const inserts = [];
    const q = (table) => {
      const chain = {
        leftJoin: () => chain,
        where: () => chain,
        whereIn: () => chain,
        orderBy: () => chain,
        whereNotIn: () => chain,
        forUpdate: () => chain,
        select: () => chain,
        returning: async () => [{ id: 'req-new' }],
        update: async (patch) => { updates.push({ table, patch }); return 1; },
        insert: (row) => {
          inserts.push({ table, row });
          return { returning: async () => [{ id: 'req-new', ...row }] };
        },
        first: async () => {
          if (table === 'service_records') {
            return { id: 'sr-1', customer_id: 'cust-1', report_template_version: 'service_report_v1' };
          }
          if (table === 'service_records as sr') {
            return { id: 'sr-1', customer_id: 'cust-1', first_name: 'Pat', last_name: 'Q' };
          }
          if (table === 'service_requests') return openRequest;
          if (table === 'customers') return { id: 'cust-1' };
          return null;
        },
      };
      return chain;
    };
    return { q, updates, inserts };
  }

  async function click(token, body = clickBody) {
    return withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/${token}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    isEnabled.mockReturnValue(true);
    buildReportCrossSell.mockResolvedValue(PRICED_OFFER);
    mintReportClickEstimate.mockResolvedValue({
      estimateId: 'est-1', token: 'tok-1',
      url: 'https://portal.wavespestcontrol.com/estimate/tok-1', reused: false,
    });
  });
  afterEach(() => { isEnabled.mockReturnValue(false); });

  test('gate ON + priced tap: mints inside the transaction and the response carries estimateUrl', async () => {
    const { q, inserts } = clickDb();
    db.mockImplementation(q);
    const res = await click('dddddddddddddddd0123456789abcdef');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, estimateUrl: 'https://portal.wavespestcontrol.com/estimate/tok-1' });
    expect(mintReportClickEstimate).toHaveBeenCalledTimes(1);
    const [, mintArgs] = mintReportClickEstimate.mock.calls[0];
    expect(mintArgs.customer).toBe(ENGINE_CONTEXT.customer);
    expect(mintArgs.crossSell).toBe(PRICED_OFFER);
    // The stored request snapshot must NOT embed the server-internal engine
    // context: the customer row's incidental fields move between taps, so
    // embedding it would turn every identical tap into a "material refresh"
    // (bell churn + a superseded estimate per tap), and its presence would
    // flip on gate state.
    const requestInsert = inserts.find((i) => i.table === 'service_requests');
    const stored = JSON.parse(requestInsert.row.pricing_revision);
    expect(stored.crossSell.engineContext).toBeUndefined();
    expect(mintArgs.revisionSnapshot.crossSell.engineContext).toBeUndefined();
  });

  test('click-to-estimate gate OFF (card gate still on): no mint, no estimateUrl, request flow unchanged', async () => {
    isEnabled.mockImplementation((gate) => gate === 'reportCrossSell');
    // Gate off ⇒ the route asks the composer for NO engine context and the
    // payload has none — mirror that in the mock.
    const { engineContext, ...bare } = PRICED_OFFER;
    buildReportCrossSell.mockResolvedValue(bare);
    const { q, inserts } = clickDb();
    db.mockImplementation(q);
    const res = await click('eeeeeeeeeeeeeeee0123456789abcdef');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mintReportClickEstimate).not.toHaveBeenCalled();
    expect(buildReportCrossSell).toHaveBeenCalledWith(expect.anything(), expect.anything(),
      { includeEngineContext: false });
    expect(inserts.filter((i) => i.table === 'service_requests')).toHaveLength(1);
  });

  test('a quote-mode tap never mints even with the gate on', async () => {
    buildReportCrossSell.mockResolvedValue({
      serviceKey: 'lawn_care', label: 'Lawn Care', mode: 'quote_cta',
      relationship: 'add', fingerprint: 'FP-QUOTE', option: null,
    });
    const { q } = clickDb();
    db.mockImplementation(q);
    // NOT the 'ffff…' token — the whitespace-limiter test above exhausts
    // that token's 5/min budget and the limiter is module-global state.
    const res = await click('efefefefefefefef0123456789abcdef', {
      eventName: 'cross_sell_requested',
      metadata: {
        serviceKey: 'lawn_care', offerMode: 'quote_cta', perApplication: null,
        optionId: null, fingerprint: 'FP-QUOTE',
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mintReportClickEstimate).not.toHaveBeenCalled();
  });

  test('an ACCEPTED-reuse mint skips the bundle-inquiry bell — the work is booked (GitHub round P1)', async () => {
    // Acceptance resolved the original request, so the writer inserts a
    // fresh row (deduped=false) — but the mint matched the ACCEPTED
    // fingerprint and resolved that fresh row too. Staff must not be paged
    // to follow up on booked work.
    const { triggerNotification } = require('../services/notification-triggers');
    mintReportClickEstimate.mockResolvedValue({
      estimateId: 'est-1', token: 'tok-1', url: '/estimate/tok-1',
      reused: true, acceptedReuse: true,
    });
    const { q, inserts } = clickDb({ openRequest: null });
    db.mockImplementation(q);
    const res = await click('adadadadadadadad0123456789abcdef');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, estimateUrl: '/estimate/tok-1' });
    expect(inserts.filter((i) => i.table === 'service_requests')).toHaveLength(1);
    expect(triggerNotification).not.toHaveBeenCalled();
  });

  test('an UNACCEPTED reuse on a fresh row still rings the bell — an open request needs eyes', async () => {
    const { triggerNotification } = require('../services/notification-triggers');
    mintReportClickEstimate.mockResolvedValue({
      estimateId: 'est-1', token: 'tok-1', url: '/estimate/tok-1', reused: true,
    });
    const { q } = clickDb({ openRequest: null });
    db.mockImplementation(q);
    const res = await click('aeaeaeaeaeaeaeae0123456789abcdef');
    expect(res.status).toBe(200);
    expect(triggerNotification).toHaveBeenCalledWith('bundle_quote_requested', expect.anything());
  });

  test('mint price drift rolls everything back and 409s like any other offer drift', async () => {
    mintReportClickEstimate.mockRejectedValue(
      Object.assign(new Error('per-application drift'), { clickEstimateDrift: true }),
    );
    const { q } = clickDb();
    db.mockImplementation(q);
    const res = await click('abababababababab0123456789abcdef');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no longer available/);
  });

  test('acceptance terminalizes the linked CTA request, scoped to click-mints only (source contract)', () => {
    // The accept transaction lives in estimate-public.js behind the full
    // acceptance harness — this pins the load-bearing structure the same
    // way the composeOffers contract tests do: scoped to the mint source,
    // matched on the pricing_revision linkage, resolved not deleted.
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/estimate-public.js'), 'utf8');
    expect(src).toMatch(/estimate\.source === 'service_report_cta' && estimate\.customer_id/);
    expect(src).toMatch(/pricing_revision->'mintedEstimate'->>'id' = \?/);
    const block = src.split("estimate.source === 'service_report_cta'")[1].slice(0, 700);
    expect(block).toMatch(/whereNotIn\('status', OPEN_REQUEST_TERMINAL_STATUSES\)/);
    expect(block).toMatch(/status: 'resolved'/);
  });

  test('DECLINE terminalizes the linked CTA request too — a rejected offer must not page staff forever (GitHub round P1, source contract)', () => {
    // Mirrors the acceptance pin: same source scoping, same linkage match,
    // resolved in the SAME decline transaction.
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/estimate-public.js'), 'utf8');
    const declineIdx = src.indexOf("status: 'declined', declined_at");
    expect(declineIdx).toBeGreaterThan(0);
    const block = src.slice(declineIdx, declineIdx + 1400);
    expect(block).toMatch(/declinedCount && estimate\.source === 'service_report_cta'/);
    expect(block).toMatch(/whereNotIn\('status', OPEN_REQUEST_TERMINAL_STATUSES\)/);
    expect(block).toMatch(/pricing_revision->'mintedEstimate'->>'id' = \?/);
    expect(block).toMatch(/status: 'resolved'/);
  });

  test('a non-drift mint failure is a retryable 503 — the card may only confirm durable state', async () => {
    mintReportClickEstimate.mockRejectedValue(new Error('snapshot did not freeze'));
    const { q } = clickDb();
    db.mockImplementation(q);
    const res = await click('cdcdcdcdcdcdcdcd0123456789abcdef');
    expect(res.status).toBe(503);
  });
});

describe('offer composition is opt-in, and only the render path opts in (PR r15 P2)', () => {
  // A CONTRACT test on the route source, not an integration test: the
  // builder is module-private and a happy-path /data render would need the
  // entire report pipeline stood up. What must not regress is narrow and
  // structural — composing the offer runs the whole ownership → property →
  // estimate → pricing pipeline plus a referral-settings read, and the Q&A
  // endpoint calls the same builder purely for report context while
  // consuming neither key. The risk this guards cuts both ways: default-off
  // means a wiring slip silently REMOVES the card from the report rather
  // than failing loudly, and nothing else asserts the payload carries it.
  const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/reports-public.js'), 'utf8');

  test('the option defaults to OFF', () => {
    expect(src).toMatch(/composeOffers = false/);
  });

  test('composition is gated on it, not on live mode alone', () => {
    expect(src).toMatch(/if \(mode === 'live' && composeOffers\)/);
  });

  test('exactly one call site opts in, and it is the /data render', () => {
    const optIns = src.match(/composeOffers: true/g) || [];
    expect(optIns).toHaveLength(1);
    expect(src).toMatch(/mode, staffViewer, pinnedLawnAssessmentId, composeOffers: true/);
  });

  test('the Q&A call site does NOT opt in', () => {
    // The ask handler's call, verbatim — it must stay offer-free.
    expect(src).toMatch(/buildServiceReportV1ResponseData\(service, req\.params\.token, \{ mode: 'live' \}\)/);
  });
});

describe('storedRevisionMatches (cross-sell resubmit no-op, PR r11 P2)', () => {
  const { storedRevisionMatches } = reportsRouter;
  const snapshot = {
    source: 'service_report',
    serviceRecordId: 'sr-1',
    crossSell: { serviceKey: 'lawn_care', mode: 'priced', option: { id: 'quarterly', perVisit: 114 } },
  };

  test('a JSONB round-trip with reordered keys is still the same snapshot', () => {
    // What node-postgres hands back for a jsonb column: an object in
    // PostgreSQL's canonical key order, not the insertion order.
    const roundTripped = {
      crossSell: { mode: 'priced', option: { perVisit: 114, id: 'quarterly' }, serviceKey: 'lawn_care' },
      serviceRecordId: 'sr-1',
      source: 'service_report',
    };
    expect(JSON.stringify(roundTripped)).not.toBe(JSON.stringify(snapshot));
    expect(storedRevisionMatches(roundTripped, snapshot)).toBe(true);
  });

  test('a string column value is parsed before comparing, in either key order', () => {
    expect(storedRevisionMatches(JSON.stringify(snapshot), snapshot)).toBe(true);
    expect(storedRevisionMatches(
      '{"serviceRecordId":"sr-1","source":"service_report","crossSell":{"option":{"perVisit":114,"id":"quarterly"},"mode":"priced","serviceKey":"lawn_care"}}',
      snapshot,
    )).toBe(true);
  });

  test('a genuinely different offer, an unparsable value, and an absent value never match', () => {
    const moved = { ...snapshot, crossSell: { ...snapshot.crossSell, option: { id: 'quarterly', perVisit: 129 } } };
    expect(storedRevisionMatches(moved, snapshot)).toBe(false);
    // Different service entirely.
    expect(storedRevisionMatches({ ...snapshot, crossSell: { ...snapshot.crossSell, serviceKey: 'tree_shrub' } }, snapshot)).toBe(false);
    // Garbage or NULL falls through to the refresh path rather than
    // falsely confirming a stale row.
    expect(storedRevisionMatches('not json', snapshot)).toBe(false);
    expect(storedRevisionMatches(null, snapshot)).toBe(false);
    expect(storedRevisionMatches(undefined, snapshot)).toBe(false);
  });
});

describe('POST /reports/:token/referral-link (owner ruling 2026-08-13: share module fetches on the TAP)', () => {
  const { isEnabled } = require('../config/feature-gates');
  // The action limiter is token-keyed and its store outlives each test —
  // every test gets its own token so one test's budget never bleeds into
  // the next.
  const tokenFor = (n) => `${n}`.repeat(32).slice(0, 32);

  // The route lazy-requires the engine, so a doMock before each request is
  // seen; the engine is NOT in the top-of-file mock set on purpose — these
  // are the only tests that touch it.
  const mockReferralEngine = {
    getLiveSettings: jest.fn(),
    enrollPromoter: jest.fn(),
    getPromoterReferralLink: jest.fn(),
  };
  jest.mock('../services/referral-engine', () => mockReferralEngine);

  const serviceRow = {
    id: 'service-1',
    customer_id: 'customer-1',
    report_template_version: 'service_report_v1',
  };

  function mockDbWithService(row = serviceRow) {
    const serviceRead = chain({ first: jest.fn().mockResolvedValue(row) });
    db.mockImplementation((table) => {
      if (table === 'service_records') return serviceRead;
      throw new Error(`Unexpected table query: ${table}`);
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockReferralEngine.getLiveSettings.mockResolvedValue({
      program_active: true,
      referee_discount_cents: 2500,
    });
    mockReferralEngine.enrollPromoter.mockResolvedValue({
      promoter: { id: 'promo-1', referral_code: 'WAVES-TEST01' },
    });
    mockReferralEngine.getPromoterReferralLink.mockReturnValue('https://wavespestcontrol.com/r/WAVES-TEST01');
  });

  test('dark gate answers the same 404 as an unknown token — not probeable', async () => {
    isEnabled.mockReturnValue(false);
    mockDbWithService();
    await withServer(async (baseUrl) => {
      const gated = await fetch(`${baseUrl}/reports/${tokenFor('a')}/referral-link`, { method: 'POST' });
      expect(gated.status).toBe(404);
      expect((await gated.json()).error).toBe('Report not found');
    });
    expect(mockReferralEngine.enrollPromoter).not.toHaveBeenCalled();
  });

  test('inactive program answers 404 and never enrolls', async () => {
    isEnabled.mockReturnValue(true);
    mockReferralEngine.getLiveSettings.mockResolvedValue({ program_active: false });
    mockDbWithService();
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/reports/${tokenFor('b')}/referral-link`, { method: 'POST' });
      expect(response.status).toBe(404);
    });
    expect(mockReferralEngine.enrollPromoter).not.toHaveBeenCalled();
  });

  test('tap enrolls through the portal mechanism and composes owner-voice share copy', async () => {
    isEnabled.mockReturnValue(true);
    mockDbWithService();
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/reports/${tokenFor('c')}/referral-link`, { method: 'POST' });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.code).toBe('WAVES-TEST01');
      expect(body.link).toBe('https://wavespestcontrol.com/r/WAVES-TEST01');
      // The friend's discount rides only because live settings grant it.
      expect(body.smsBody).toContain('$25 off');
      expect(body.smsBody).toContain('WAVES-TEST01');
      // Portal-domain links drop the scheme in SMS bodies; email keeps it.
      expect(body.smsBody).toContain('wavespestcontrol.com/r/WAVES-TEST01');
      expect(body.smsBody).not.toContain('https://');
      expect(body.emailBody).toContain('https://wavespestcontrol.com/r/WAVES-TEST01');
      // Owner voice: zero emojis.
      expect(/\p{Extended_Pictographic}/u.test(body.smsBody + body.emailBody)).toBe(false);
    });
    expect(mockReferralEngine.enrollPromoter).toHaveBeenCalledWith('customer-1');
  });

  test('fractional referee discounts format EXACTLY — never rounded up a dollar (pre-push P0)', async () => {
    isEnabled.mockReturnValue(true);
    mockReferralEngine.getLiveSettings.mockResolvedValue({ program_active: true, referee_discount_cents: 4999 });
    mockDbWithService();
    await withServer(async (baseUrl) => {
      const body = await (await fetch(`${baseUrl}/reports/${tokenFor('d')}/referral-link`, { method: 'POST' })).json();
      // $49.99 stays $49.99 — advertising "$50" promises a dollar the
      // engine never credits. Whole-dollar settings keep the clean "$25".
      expect(body.smsBody).toContain('$49.99 off');
      expect(body.smsBody).not.toContain('$50');
      expect(body.emailSubject).toBe('$49.99 off Waves Pest Control');
    });
  });

  test('the tap shares the 5/min token-keyed action limiter (pre-push P1: no eventName body must not exempt it)', async () => {
    isEnabled.mockReturnValue(true);
    const serviceRead = chain({ first: jest.fn().mockResolvedValue(serviceRow) });
    db.mockImplementation((table) => {
      if (table === 'service_records') return serviceRead;
      throw new Error(`Unexpected table query: ${table}`);
    });
    await withServer(async (baseUrl) => {
      const statuses = [];
      for (let i = 0; i < 6; i++) {
        const response = await fetch(`${baseUrl}/reports/${tokenFor('e')}/referral-link`, { method: 'POST' });
        statuses.push(response.status);
      }
      expect(statuses.slice(0, 5).every((code) => code === 200)).toBe(true);
      expect(statuses[5]).toBe(429);
      // Pre-DB bypass (round-2 P1): the over-limit 6th request must be
      // rejected BEFORE any service_records read — 5 in-route reads for the
      // 5 allowed requests, none from the param gate, none for the 429.
      expect(serviceRead.first).toHaveBeenCalledTimes(5);
    });
  });

  test('no referee discount configured → the copy asks to mention the code, never invents $ off', async () => {
    isEnabled.mockReturnValue(true);
    mockReferralEngine.getLiveSettings.mockResolvedValue({ program_active: true, referee_discount_cents: 0 });
    mockDbWithService();
    await withServer(async (baseUrl) => {
      const body = await (await fetch(`${baseUrl}/reports/${tokenFor('f')}/referral-link`, { method: 'POST' })).json();
      expect(body.smsBody).not.toContain('$');
      expect(body.smsBody).toContain('mention my code WAVES-TEST01');
    });
  });

  test('sibling profile (23505) resolves the household promoter read-only, scoped to the account (r5)', async () => {
    isEnabled.mockReturnValue(true);
    const pgError = new Error('duplicate key value violates unique constraint "referral_promoters_customer_phone_key"');
    pgError.code = '23505';
    mockReferralEngine.enrollPromoter.mockRejectedValue(pgError);
    // The endpoint then reads: customers (profile) → account-scoped join.
    const profileRead = chain({ first: jest.fn().mockResolvedValue({ id: 'customer-1', phone: '+15555550100', account_id: 'acct-1' }) });
    const joined = {
      join: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ id: 'promo-h', customer_id: 'cust-0', referral_code: 'WAVES-HOUSE01', referral_link: 'https://portal.wavespestcontrol.com/r/WAVES-HOUSE01' }),
    };
    const serviceRead = chain({ first: jest.fn().mockResolvedValue(serviceRow) });
    db.mockImplementation((table) => {
      if (table === 'service_records') return serviceRead;
      if (table === 'customers') return profileRead;
      if (table === 'referral_promoters as rp') return joined;
      throw new Error(`Unexpected table query: ${table}`);
    });
    mockReferralEngine.getPromoterReferralLink.mockReturnValue('https://portal.wavespestcontrol.com/r/WAVES-HOUSE01');
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/reports/${tokenFor('7')}/referral-link`, { method: 'POST' });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.code).toBe('WAVES-HOUSE01');
    });
    // Account boundary was applied to the join.
    expect(joined.where).toHaveBeenCalledWith('c.account_id', 'acct-1');
  });

  test('cross-account phone collision stays a 503 — never a foreign code (r5 money posture)', async () => {
    isEnabled.mockReturnValue(true);
    const pgError = new Error('duplicate key value violates unique constraint');
    pgError.code = '23505';
    mockReferralEngine.enrollPromoter.mockRejectedValue(pgError);
    const profileRead = chain({ first: jest.fn().mockResolvedValue({ id: 'customer-1', phone: '+15555550100', account_id: 'acct-1' }) });
    const joined = { join: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) };
    const serviceRead = chain({ first: jest.fn().mockResolvedValue(serviceRow) });
    db.mockImplementation((table) => {
      if (table === 'service_records') return serviceRead;
      if (table === 'customers') return profileRead;
      if (table === 'referral_promoters as rp') return joined;
      throw new Error(`Unexpected table query: ${table}`);
    });
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/reports/${tokenFor('8')}/referral-link`, { method: 'POST' });
      expect(response.status).toBe(503);
    });
  });

  test('engine failure answers 503, not a fake link — and the raw error never reaches the logs', async () => {
    isEnabled.mockReturnValue(true);
    // A PG unique-violation quotes the conflicting value — here, a phone
    // number. The log line must carry the code, never the message.
    const pgError = new Error('duplicate key value violates unique constraint "referral_promoters_customer_phone_key" Detail: Key (customer_phone)=(+19415551234) already exists.');
    pgError.code = '23505';
    mockReferralEngine.enrollPromoter.mockRejectedValue(pgError);
    // 23505 first consults the household path — a legacy profile without
    // account_id skips it and rethrows the original, which is what this
    // test is about: the raw constraint text never reaching the logs.
    const serviceRead = chain({ first: jest.fn().mockResolvedValue(serviceRow) });
    const profileRead = chain({ first: jest.fn().mockResolvedValue({ id: 'customer-1', phone: '+19415551234', account_id: null }) });
    db.mockImplementation((table) => {
      if (table === 'service_records') return serviceRead;
      if (table === 'customers') return profileRead;
      throw new Error(`Unexpected table query: ${table}`);
    });
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/reports/${tokenFor('0')}/referral-link`, { method: 'POST' });
      expect(response.status).toBe(503);
    });
    const logger = require('../services/logger');
    const logged = logger.warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('code=23505');
    expect(logged).not.toContain('9415551234');
    expect(logged).not.toContain('duplicate key');
  });

  test('unknown token and non-v1 reports answer 404 before any engine read', async () => {
    isEnabled.mockReturnValue(true);
    mockDbWithService({ ...serviceRow, report_template_version: 'legacy' });
    await withServer(async (baseUrl) => {
      const nonV1 = await fetch(`${baseUrl}/reports/${tokenFor('9')}/referral-link`, { method: 'POST' });
      expect(nonV1.status).toBe(404);
      const badToken = await fetch(`${baseUrl}/reports/not-a-token/referral-link`, { method: 'POST' });
      expect(badToken.status).toBe(404);
    });
    expect(mockReferralEngine.getLiveSettings).not.toHaveBeenCalled();
  });
});
