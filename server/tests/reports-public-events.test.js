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
    mockDbWithService();
    await withServer(async (baseUrl) => {
      const statuses = [];
      for (let i = 0; i < 6; i++) {
        const response = await fetch(`${baseUrl}/reports/${tokenFor('e')}/referral-link`, { method: 'POST' });
        statuses.push(response.status);
      }
      expect(statuses.slice(0, 5).every((code) => code === 200)).toBe(true);
      expect(statuses[5]).toBe(429);
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

  test('engine failure answers 503, not a fake link — and the raw error never reaches the logs', async () => {
    isEnabled.mockReturnValue(true);
    // A PG unique-violation quotes the conflicting value — here, a phone
    // number. The log line must carry the code, never the message.
    const pgError = new Error('duplicate key value violates unique constraint "referral_promoters_customer_phone_key" Detail: Key (customer_phone)=(+19415551234) already exists.');
    pgError.code = '23505';
    mockReferralEngine.enrollPromoter.mockRejectedValue(pgError);
    mockDbWithService();
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
