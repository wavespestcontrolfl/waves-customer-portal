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
 * SUPERSEDED FOR NEW QUOTES (owner 2026-11-26 evening): a lot above 2 acres is now priced ($85 per visit per added acre;
 * specialty-prices-20261126.test.js). This suite pins the hand-price hold for a quote priced BEFORE that: every legacy case
 * passes legacySpecialty1126: true, the estimate-level stamp an older estimate replays under. The route block at the bottom
 * pins that a new website quote now shows a price.
 *
 * Owner 2026-11-26 ("fix this"): a recurring mosquito lot above 2 acres (87,120 sq ft) waited for the owner's
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
const LEGACY = { legacySpecialty1126: true };
const mosquitoLine = (acres, extra = {}) => generateEstimate({
  homeSqFt: 2000, lotSqFt: Math.round(acres * ACRE), stories: 1, yearBuilt: 2005,
  services: { mosquito: { tier: 'seasonal9' } }, ...LEGACY, ...extra,
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
    const at = generateEstimate({ homeSqFt: 2000, lotSqFt: 87120, ...LEGACY, services: { mosquito: { tier: 'seasonal9' } } }).lineItems.find((l) => l.service === 'mosquito');
    const over = generateEstimate({ homeSqFt: 2000, lotSqFt: 87121, ...LEGACY, services: { mosquito: { tier: 'seasonal9' } } }).lineItems.find((l) => l.service === 'mosquito');
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
    const line = generateEstimate({ homeSqFt: 2000, lotSqFt: 100000, mosquitoTreatableSqFt: 90000, ...LEGACY, services: { mosquito: { tier: 'monthly12' } } })
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

  test('lead automation: a NEW draft carries no 2-acre hand-price reason (the 1-acre-and-up review still parks it), and auto-send refuses it', async () => {
    const draft = await buildAutomatedLeadDraftEstimate({
      readiness: {
        status: 'ready', ready: true, confidence: 'medium', minimumConfidence: 'medium', missing: [], review: [],
        serviceInterest: 'Recurring Mosquito Control',
      },
      intake: { serviceInterest: 'Recurring Mosquito Control', fullAddress: '123 Main St, Venice, FL 34285' },
      body: { homeSqFt: 2200, lotSqFt: 3 * ACRE },
    });
    // The lot is priced now (specialty-prices-20261126.test.js); the review a lot of an acre or more already had (the existing
    // acre_or_larger_property hold, the same one a 1.5-acre lot gets) still parks the draft, so nothing is sent unreviewed.
    expect(draft.automation.status).toBe('manual_review_required');
    expect(draft.automation.generated).toBe(false);
    expect(draft.automation.quoteRequiredReason).toBe('acre_or_larger_property');
    expect(draft.automation.quoteRequiredReason).not.toBe(REASON);
    const eligibility = leadEstimateAutoSendEligibility({
      source: 'lead_webhook', status: 'draft', pricing_authority: 'SERVER', customer_phone: '+19415550199',
      created_at: new Date(Date.now() - 3600000).toISOString(), estimate_data: draft.estimateData,
    }, { createdAfter: new Date(0) });
    expect(eligibility.eligible).toBe(false);
  });
});

// Property records stop a home lot at 200,000 sq ft (4.59 acres): the lookups, the website and the saved customer lot all store a
// larger parcel as exactly that number. A NEW quote at that number is "4.59 acres or more", so it is not priced by the per-acre
// rule: it keeps the hand price above (the same flat price and reason), and staff are told to enter the real size.
describe('recurring mosquito at the 200,000 sq ft record cap: hand price for a new quote too', () => {
  const { MOSQUITO_RECORD_LOT_CAP_SQFT, MOSQUITO_LOT_AT_RECORD_CAP_TEXT } = require('../services/pricing-engine/service-pricing');
  const fresh = (lotSqFt, extra = {}) => generateEstimate({
    homeSqFt: 2000, lotSqFt, stories: 1, yearBuilt: 2005, services: { mosquito: { tier: 'seasonal9' } }, ...extra,
  }).lineItems.find((l) => l.service === 'mosquito');

  test('the cap is the number the lookups and the website stop a home lot at', () => {
    const read = (file) => require('fs').readFileSync(require.resolve(file), 'utf8');
    expect(MOSQUITO_RECORD_LOT_CAP_SQFT).toBe(200000);
    expect(read('../services/property-lookup/ai-property-lookup')).toContain('const LOT_SQFT_MAX = 200_000;');
    expect(read('../routes/public-quote')).toContain('const LOT_CAP = commercialDetected ? 50_000_000 : 200000;');
  });

  test('a new quote at exactly the cap is never priced as 4.59 acres: the flat price and the hand-price reason, as before the rule', () => {
    const capped = fresh(200000);
    const before = fresh(200000, LEGACY);
    expect(capped.perVisit).toBe(before.perVisit);
    expect(capped.annual).toBe(1053);
    expect(capped.tiers.map((t) => t.perVisit)).toEqual(before.tiers.map((t) => t.perVisit));
    expect(capped.requiresManualReview).toBe(true);
    expect(capped.manualReviewReasons[0]).toBe(REASON);
    expect(capped.mosquitoLotAtRecordCap).toBe(true);
    expect(capped.mosquitoAddedAcres).toBeUndefined();
    // Staff wording never rides the line a customer page reads.
    expect(JSON.stringify(capped)).not.toContain(MOSQUITO_LOT_AT_RECORD_CAP_TEXT);
    // An explicit treatable area at the cap is the same truncated size.
    const treatable = fresh(100000, { mosquitoTreatableSqFt: 200000 });
    expect(treatable.manualReviewReasons[0]).toBe(REASON);
    expect(treatable.mosquitoLotAtRecordCap).toBe(true);
  });

  test('a parcel at the cap beside a larger treatable area is still an unknown size: the hold stays, no added acre is charged', () => {
    // The parcel is checked on its own. 210,000 sq ft of treatable area does not say how large a 200,000-capped parcel really is.
    for (const mosquitoTreatableSqFt of [210000, 250000, 150000]) {
      const mixed = fresh(200000, { mosquitoTreatableSqFt });
      expect(mixed.manualReviewReasons[0]).toBe(REASON);
      expect(mixed.requiresManualReview).toBe(true);
      expect(mixed.mosquitoLotAtRecordCap).toBe(true);
      expect(mixed.mosquitoAddedAcres).toBeUndefined();
      // The price is the flat one a quote made before the rule has for the same inputs.
      expect(mixed.perVisit).toBe(fresh(200000, { mosquitoTreatableSqFt, ...LEGACY }).perVisit);
    }
    // The same treatable area beside a real parcel size is priced by the rule.
    const real = fresh(250000, { mosquitoTreatableSqFt: 210000 });
    expect(real.mosquitoLotAtRecordCap).toBeUndefined();
    expect(real.manualReviewReasons).not.toContain(REASON);
    expect(real.mosquitoAddedAcres).toBeCloseTo((250000 - 87120) / ACRE, 3);
  });

  test('one square foot either side of the cap, and a typed 10 acres, are real sizes: priced at $85 per added acre', () => {
    const twoAcres = fresh(87120).perVisit;
    expect(twoAcres).toBe(117);
    for (const lot of [199999, 200001, 10 * ACRE]) {
      const line = fresh(lot);
      expect(line.mosquitoLotAtRecordCap).toBeUndefined();
      expect(line.manualReviewReasons).not.toContain(REASON);
      expect(line.perVisit).toBe(Math.round(twoAcres + 85 * (lot - 87120) / ACRE));
    }
    expect(fresh(10 * ACRE).perVisit).toBe(797);
  });

  test('an unmeasured lot at the cap keeps the unverified-area hold, not the size instruction', () => {
    const line = fresh(200000, { lotSizeMeasured: false });
    expect(line.manualReviewReasons).toContain('mosquito_treatable_area_unverified');
    expect(line.manualReviewReasons).not.toContain(REASON);
    expect(line.mosquitoLotAtRecordCap).toBeUndefined();
  });

  test('call quote: the draft lane parks it and tells the operator to enter the real lot size', () => {
    const intent = {
      decision: 'draft', services: { mosquito: { tier: 'seasonal9' } }, is_commercial: false, category: 'RESIDENTIAL',
      address: '123 Sample St, Parrish, FL 34219', confidence: 'high', constraint_flags: [], customer_phone: '+19415550100',
      evidence: [{ speaker: 'caller', quote: 'mosquito control please', decision: 'mosquito' }],
    };
    const out = classifyLane({
      intent, propertyFacts: { home: { value: 2000, source: 'county_roll' } },
      engineResult: { lineItems: [fresh(200000)] }, totals: { monthly: 87.75, annual: 1053, oneTime: 0 }, comps: null, calibration: [],
    });
    expect(out.lane).toBe(LANES.YELLOW);
    expect(out.reasons).toContain(MOSQUITO_LOT_AT_RECORD_CAP_TEXT);
    expect(out.reasons).not.toContain(STAFF_TEXT);
    expect(lineRequiresReview(fresh(200000))).toBe(true);
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

  test('3 acres (a new quote): the hand-price reason is gone; the 1-acre-and-up review holds it like a 1.5-acre lot', async () => {
    const { status, body } = await quote(3);
    const mid = await quote(1.5);
    expect(status).toBe(mid.status);
    expect(body.reason).toBe(mid.body.reason);
    expect(body.reason).toBe('acre_or_larger_property');
    expect(body.reason).not.toBe(REASON);
    expect(JSON.stringify(body)).not.toContain(STAFF_TEXT);
  });

  test('a confirmed 10-acre lot is stored as the 200,000 sq ft cap, so it is never priced as 4.59 acres: the hand-price hold, and the bell says to enter the real size', async () => {
    const { MOSQUITO_LOT_AT_RECORD_CAP_TEXT } = require('../services/pricing-engine/service-pricing');
    const { notifyAdmin } = require('../services/notification-service');
    const db = require('../models/db');
    notifyAdmin.mockClear();
    db.__recorded.length = 0;
    const { status, body } = await quote(10);
    expect(status).toBe(202);
    expect(body.quote_required).toBe(true);
    expect(body.reason).toBe(REASON);
    expect(body.monthly_total).toBeUndefined();
    expect(body.annual_total).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(MOSQUITO_LOT_AT_RECORD_CAP_TEXT);
    const bell = notifyAdmin.mock.calls.find((c) => /Manual quote needed/.test(c[1]));
    expect(bell[2]).toContain(MOSQUITO_LOT_AT_RECORD_CAP_TEXT);
    // The stored draft holds the capped lot with the hold on its mosquito line, not a per-acre price for 4.59 acres.
    const row = db.__recorded.find((w) => w.table === 'estimates' && w.op === 'insert');
    const data = typeof row.row.estimate_data === 'string' ? JSON.parse(row.row.estimate_data) : row.row.estimate_data;
    expect(data.engineInput.lotSqFt).toBe(200000);
    const line = data.manualQuoteLines.find((l) => l.service === 'mosquito');
    expect(line.manualReviewReasons[0]).toBe(REASON);
    expect(line.mosquitoLotAtRecordCap).toBe(true);
    expect(line.mosquitoAddedAcres).toBeUndefined();
    expect(line.perVisit).toBe(117);
    expect(data.quoteRequiredReason).toBe(REASON);
    // Just under the cap is a real size: the 1-acre-and-up review, as a 3-acre lot.
    const under = await quote(4.5);
    expect(under.body.reason).toBe('acre_or_larger_property');
  });

  test('half an acre still shows a price', async () => {
    const { body } = await quote(0.5);
    expect(body.quote_required).toBeUndefined();
    expect(body.monthly_total).toBeGreaterThan(0);
  });

  test('the office bell no longer says to set the price by hand for a new quote', async () => {
    const { notifyAdmin } = require('../services/notification-service');
    notifyAdmin.mockClear();
    await quote(3);
    const bell = notifyAdmin.mock.calls.find((c) => /Manual quote needed/.test(c[1]));
    expect(bell[2]).not.toContain(STAFF_TEXT);
  });
});
