jest.mock('../models/db', () => {
  const recorded = [];
  let seq = 0;
  const makeBuilder = (table) => {
    const state = { table };
    const builder = new Proxy(function builderTarget() {}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve, reject) => Promise.resolve(state.result !== undefined ? state.result : []).then(resolve, reject);
        }
        if (prop === 'catch') return (reject) => Promise.resolve(state.result !== undefined ? state.result : []).catch(reject);
        if (prop === 'first') return async () => null;
        if (prop === 'insert') {
          return (data) => {
            const rows = Array.isArray(data) ? data : [data];
            rows.forEach((row) => recorded.push({ op: 'insert', table, row }));
            state.result = rows.map(() => ({ id: `id-${seq += 1}` }));
            return builder;
          };
        }
        if (prop === 'update') {
          return (data) => { recorded.push({ op: 'update', table, row: data }); state.result = 1; return builder; };
        }
        if (prop === 'del' || prop === 'delete') return async () => 0;
        if (prop === 'count') return () => { state.result = [{ count: '0' }]; return builder; };
        if (prop === 'returning') return () => builder;
        return () => builder;
      },
      apply() { return builder; },
    });
    return builder;
  };
  const db = jest.fn((table) => makeBuilder(table));
  db.raw = jest.fn((sql) => ({ toSQL: () => sql, sql }));
  db.fn = { now: () => new Date(), uuid: () => 'uuid' };
  db.transaction = jest.fn(async (cb) => cb(db));
  db.schema = { hasTable: async () => true, hasColumn: async () => true };
  db.__recorded = recorded;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: false })) }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => false), sendOne: jest.fn(async () => ({})), newsletterGroupId: () => null, serviceGroupId: () => null,
}));
jest.mock('../services/newsletter-subscribers', () => ({ subscribeOrResubscribe: jest.fn(async () => ({ action: 'noop' })) }));
jest.mock('../services/automation-runner', () => ({ enrollCustomer: jest.fn(async () => ({ enrolled: false })) }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (u) => u) }));

// The route allows 10 quotes an hour per address; this suite sends more.
jest.mock('express-rate-limit', () => () => (req, res, next) => next());

// The route's own cache-only server re-read. A test sets what it answers.
let mockServerLookup = null;
jest.mock('../routes/property-lookup-v2', () => ({
  ...jest.requireActual('../routes/property-lookup-v2'),
  performPropertyLookup: jest.fn(async () => mockServerLookup),
}));

const express = require('express');

// The first request cold-loads the whole route graph, which can pass 5 s on a busy machine.
jest.setTimeout(30000);

/**
 * Owner 2026-11-26 ("fix this"): a recurring mosquito lot above 2 acres (87,120 sq ft) waits for the owner's
 * hand price. The curve is flat past ~64,500 sq ft, so 2, 3 and 5 acres all priced $1,053/yr. The line's own
 * review mark (requiresManualReview / manualReviewReasons) is the one mechanism every system send path reads,
 * so this suite pins each path for a 3-acre lot and pins that nothing at or below 2 acres changed price.
 */
const { generateEstimate } = require('../services/pricing-engine');
const { classifyLane, lineRequiresReview, LANES } = require('../services/estimator-engine/draft-builder');
const { callAutoSendShadowVerdict } = require('../services/estimator-engine/call-auto-send-shadow');
const { buildAutomatedLeadDraftEstimate } = require('../services/lead-estimate-automation');
const { leadEstimateAutoSendEligibility } = require('../services/lead-estimate-auto-send');

const ACRE = 43560;
const REASON = 'mosquito_lot_above_2_acres';
const STAFF_TEXT = 'Lot above 2 acres: set the mosquito price by hand';
const mosquitoLine = (acres, extra = {}) => generateEstimate({
  homeSqFt: 2000, lotSqFt: Math.round(acres * ACRE), stories: 1, yearBuilt: 2005,
  services: { mosquito: { tier: 'seasonal9' } }, ...extra,
}).lineItems.find((l) => l.service === 'mosquito');

describe('recurring mosquito above 2 acres: the line', () => {
  test.each([
    [1, 954], [2, 1053],
  ])('%s acre(s) prices $%s a year and is not marked above 2 acres', (acres, annual) => {
    const line = mosquitoLine(acres);
    expect(line.annual).toBe(annual);
    expect(line.manualReviewReasons).not.toContain(REASON);
  });

  test('exactly 87,120 sq ft (2 acres) is not above 2 acres; one more square foot is', () => {
    const at = generateEstimate({ homeSqFt: 2000, lotSqFt: 87120, services: { mosquito: { tier: 'seasonal9' } } }).lineItems.find((l) => l.service === 'mosquito');
    const over = generateEstimate({ homeSqFt: 2000, lotSqFt: 87121, services: { mosquito: { tier: 'seasonal9' } } }).lineItems.find((l) => l.service === 'mosquito');
    expect(at.manualReviewReasons).not.toContain(REASON);
    expect(over.manualReviewReasons[0]).toBe(REASON);
  });

  test.each([2.5, 3, 5])('%s acres keeps the 2-acre price and carries the hand-price reason first', (acres) => {
    const line = mosquitoLine(acres);
    expect(line.annual).toBe(1053);
    expect(line.requiresManualReview).toBe(true);
    expect(line.manualReviewReasons[0]).toBe(REASON);
    expect(JSON.stringify(line)).not.toContain(STAFF_TEXT); // staff wording never rides the line a customer page reads
  });

  test('an unmeasured lot keeps the unverified-area hold, not the 2-acre instruction', () => {
    const line = mosquitoLine(3, { lotSizeMeasured: false });
    expect(line.manualReviewReasons).toContain('mosquito_treatable_area_unverified');
    expect(line.manualReviewReasons).not.toContain(REASON);
  });

  test('an explicit treatable area above 2 acres also holds', () => {
    const line = generateEstimate({ homeSqFt: 2000, lotSqFt: 100000, mosquitoTreatableSqFt: 90000, services: { mosquito: { tier: 'monthly12' } } })
      .lineItems.find((l) => l.service === 'mosquito');
    expect(line.manualReviewReasons[0]).toBe(REASON);
  });
});

describe('recurring mosquito above 2 acres: no system send path sends it', () => {
  test('the shared review predicate (call draft, lead draft, voice agent, add-service offers) reads it as manual', () => {
    expect(lineRequiresReview(mosquitoLine(3))).toBe(true);
    expect(lineRequiresReview(mosquitoLine(1.5, {}))).toBe(true); // existing 35k+ hold, unchanged
    expect(lineRequiresReview(mosquitoLine(0.5))).toBe(false);
  });

  test('call quote: the draft lane parks with the owner wording and auto-send would hold', () => {
    const line = mosquitoLine(3);
    const intent = {
      decision: 'draft', services: { mosquito: { tier: 'seasonal9' } }, is_commercial: false, category: 'RESIDENTIAL',
      address: '123 Sample St, Parrish, FL 34219', confidence: 'high', constraint_flags: [], customer_phone: '+19415550100',
      evidence: [{ speaker: 'caller', quote: 'mosquito control please', decision: 'mosquito' }],
    };
    const out = classifyLane({
      intent, propertyFacts: { home: { value: 2000, source: 'county_roll' } },
      engineResult: { lineItems: [line] }, totals: { monthly: 87.75, annual: 1053, oneTime: 0 }, comps: null, calibration: [],
    });
    expect(out.lane).toBe(LANES.YELLOW);
    expect(out.reasons).toContain(STAFF_TEXT);
    const verdict = callAutoSendShadowVerdict({
      origin: { channel: 'call' }, intent,
      propertyFacts: { home: { value: 2000, source: 'county_roll' } },
      context: { phone: '+19415550100', extraction: { quote_promised: true } },
      draftPhone: '+19415550100', laneReasons: out.reasons,
    });
    expect(verdict.verdict).toBe('would_hold');
    expect(verdict.reasons).toContain('lane_review_reason');
  });

  test('lead automation: the draft parks as manual review with no price shown, and auto-send refuses it', async () => {
    const draft = await buildAutomatedLeadDraftEstimate({
      readiness: {
        status: 'ready', ready: true, confidence: 'medium', minimumConfidence: 'medium', missing: [], review: [],
        serviceInterest: 'Recurring Mosquito Control',
      },
      intake: { serviceInterest: 'Recurring Mosquito Control', fullAddress: '123 Main St, Venice, FL 34285' },
      body: { homeSqFt: 2200, lotSqFt: 3 * ACRE },
    });
    expect(draft.automation.status).toBe('manual_review_required');
    expect(draft.automation.generated).toBe(false);
    expect(draft.quoteRequired).toBe(true);
    expect(draft.annual).toBe(0);
    expect(draft.automation.quoteRequiredReason).toBe(REASON);
    const eligibility = leadEstimateAutoSendEligibility({
      source: 'lead_webhook', status: 'draft', pricing_authority: 'SERVER', customer_phone: '+19415550199',
      created_at: new Date(Date.now() - 3600000).toISOString(), estimate_data: draft.estimateData,
    }, { createdAfter: new Date(0) });
    expect(eligibility.eligible).toBe(false);
  });
});

describe('POST /api/public/quote/calculate: recurring mosquito above 2 acres', () => {
  let server;
  let base;
  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use('/api/public/quote', require('../routes/public-quote'));
    app.use((err, req, res, next) => res.status(500).json({ error: 'boom' }));
    server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api/public/quote`; done(); });
  });
  afterAll((done) => { server.closeAllConnections(); server.close(done); });
  beforeEach(() => { mockServerLookup = null; });

  const quote = async (acres) => {
    const res = await fetch(`${base}/calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Test', lastName: 'Quoter', email: 'acre.hold@example.com', phone: '9415550143',
        address: '123 Sample St, Parrish, FL 34219', city: 'Parrish', zip: '34219',
        homeSqFt: 2000, lotSqFt: Math.round(acres * ACRE), lotSizeConfirmed: true, stories: 1,
        services: { mosquito: { tier: 'seasonal9' } },
      }),
    });
    return { status: res.status, body: await res.json() };
  };

  test('3 acres: no price is shown, the reason is named, the customer is told the team prices it', async () => {
    const { status, body } = await quote(3);
    expect(status).toBe(202);
    expect(body.quote_required).toBe(true);
    expect(body.reason).toBe(REASON);
    expect(body.monthly_total).toBeUndefined();
    expect(body.message).toMatch(/priced by our team/);
    expect(body.message).not.toMatch(/Commercial/);
  });

  test('half an acre still shows a price', async () => {
    const { body } = await quote(0.5);
    expect(body.quote_required).toBeUndefined();
    expect(body.monthly_total).toBeGreaterThan(0);
  });

  test('the office bell says to set the price by hand', async () => {
    const { notifyAdmin } = require('../services/notification-service');
    notifyAdmin.mockClear();
    await quote(3);
    const bell = notifyAdmin.mock.calls.find((c) => /Manual quote needed/.test(c[1]));
    expect(bell[2]).toContain(STAFF_TEXT);
  });
});
