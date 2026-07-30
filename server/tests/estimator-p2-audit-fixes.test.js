/**
 * Estimator Engine — regression tests for the five confirmed P2 findings of
 * the 2026-07-30 engine audit. All fixtures are fully synthetic (public
 * repo — no real customer names, addresses, or call content).
 *
 * 1. classifyLane reads lawn turf provenance (turfConfidence/turfBasis) —
 *    heuristic lotFallback turf must land YELLOW, never green.
 * 2. classifyLane flags a grass track the pricer silently coerced
 *    (paspalum → St. Augustine table) — wrong-program risk parks yellow.
 * 3. loadLeadForCall's reused-lead window excludes leads sid-stamped for a
 *    DIFFERENT call — a shared line's second call must not supply this
 *    call's address/email/lead linkage.
 * 4. sameStreetAddress does not mistake a leading 5-digit HOUSE NUMBER for
 *    a ZIP — a bare street form must compare equal to its ZIP-carrying form
 *    (missing ZIP compares conservatively equal).
 * 5. applyV2ToPropertyFacts only clears a V1-resolved lot for
 *    applicabilities that mean the lot genuinely does not exist — a
 *    leased_land tenant's parcel and an unresolved private_parcel keep the
 *    V1 lot instead of a false high-confidence "no lot".
 */

let mockLeadRows = [];

jest.mock('../models/db', () => {
  const toTime = (v) => new Date(v).getTime();
  const makeBuilder = (table, rows) => {
    let filtered = rows.slice();
    const builder = {
      select() { return this; },
      whereRaw() { return this; },
      whereNull(col) { filtered = filtered.filter((r) => r[col] == null); return this; },
      where(a, b, c) {
        if (typeof a === 'function') {
          // Grouped-or subclause: collect whereNull/orWhere alternatives and
          // keep rows matching ANY of them (mirrors knex semantics closely
          // enough for the sid-exclusion contract under test).
          const alts = [];
          const qb = {
            whereNull(col) { alts.push((r) => r[col] == null); return qb; },
            orWhere(col, val) { alts.push((r) => r[col] === val); return qb; },
          };
          a(qb);
          filtered = filtered.filter((r) => alts.some((fn) => fn(r)));
        } else if (typeof a === 'object') {
          filtered = filtered.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        } else if (b === '>=') {
          filtered = filtered.filter((r) => toTime(r[a]) >= toTime(c));
        } else if (b === '<=') {
          filtered = filtered.filter((r) => toTime(r[a]) <= toTime(c));
        } else {
          filtered = filtered.filter((r) => r[a] === b);
        }
        return this;
      },
      orderBy(col, dir) {
        filtered.sort((x, y) => (dir === 'desc' ? toTime(y[col]) - toTime(x[col]) : toTime(x[col]) - toTime(y[col])));
        return this;
      },
      limit() { return this; },
      async first() { return filtered[0] || null; },
      then(resolve, reject) { return Promise.resolve(filtered).then(resolve, reject); },
      catch() { return this; },
    };
    return builder;
  };
  return (table) => makeBuilder(table, table === 'leads' ? mockLeadRows : []);
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { LANES, classifyLane } = require('../services/estimator-engine/draft-builder');
const { sameStreetAddress } = require('../services/estimator-engine/address-compare');
const shadow = require('../services/estimator-engine/property-facts-shadow');
const { _private: ctxPriv } = require('../services/estimator-engine/context-builder');

// ── Fixtures (synthetic) ──────────────────────────────────────
const lawnIntent = (track = 'st_augustine') => ({
  decision: 'draft',
  skip_reason: null,
  customer_name: 'Test Caller',
  customer_phone: '+19410000000',
  customer_email: 'test@example.com',
  address: '123 Example St, Testville, FL 34200',
  category: 'RESIDENTIAL',
  is_commercial: false,
  commercial_risk_type: null,
  services: { lawn: { track, tier: 'enhanced' } },
  service_interest_label: 'Lawn Care',
  evidence: [{ decision: 'lawn enhanced', quote: 'looking for lawn care at my house', speaker: 'caller' }],
  constraint_flags: [],
  uncertainties: [],
  confidence: 'high',
});

const lawnLine = (overrides = {}) => ({
  service: 'lawn_care',
  track: 'st_augustine',
  grassType: 'St. Augustine',
  monthly: 60,
  annual: 720,
  turfSf: 6000,
  turfEstimated: false,
  turfConfidence: 'HIGH',
  turfBasis: 'measuredTurfSf',
  ...overrides,
});

const lawnArgs = (line, intent = lawnIntent()) => ({
  intent,
  propertyFacts: {
    home: { value: 2100, source: 'county_assessed', confidence: 'high', rejected: [] },
    lot: { value: 9000, source: 'county_assessed', confidence: 'high', rejected: [] },
    newConstruction: false,
    tenant: false,
  },
  engineResult: { summary: {}, lineItems: [line] },
  totals: { monthly: 60, annual: 720, oneTime: 0 },
  comps: { samples: 10, median: 62, outlier: false, insufficient: false },
  calibration: [],
  context: {
    isExistingCustomer: false,
    extractionSource: 'enriched',
    transcript: 'Caller: hi, I am looking for lawn care at my house please.',
    smsThread: [],
  },
});

// ── 1. Turf provenance drives the lane ────────────────────────
describe('audit P2: lawn turf provenance', () => {
  test('measured turf with a clean call stays green', () => {
    const { lane, reasons } = classifyLane(lawnArgs(lawnLine()));
    expect(lane).toBe(LANES.GREEN);
    expect(reasons).toEqual([]);
  });

  test('LOW-confidence lotFallback turf lands yellow with the basis surfaced', () => {
    const { lane, reasons } = classifyLane(lawnArgs(lawnLine({
      turfEstimated: true, turfConfidence: 'LOW', turfBasis: 'lotFallback',
    })));
    expect(lane).toBe(LANES.YELLOW);
    expect(reasons.some((r) => r.includes('turf area is a heuristic estimate') && r.includes('lotFallback'))).toBe(true);
  });

  test('MEDIUM estimated turf does not over-flag', () => {
    const { lane } = classifyLane(lawnArgs(lawnLine({
      turfEstimated: true, turfConfidence: 'MEDIUM', turfBasis: 'estimatedTurfSf',
    })));
    expect(lane).toBe(LANES.GREEN);
  });
});

// ── 2. Silent grass-track coercion parks yellow ───────────────
describe('audit P2: grass track coerced by the pricer', () => {
  test('paspalum intent priced on the St. Augustine table is yellow', () => {
    const { lane, reasons } = classifyLane(lawnArgs(lawnLine(), lawnIntent('paspalum')));
    expect(lane).toBe(LANES.YELLOW);
    expect(reasons.some((r) => r.includes("'paspalum'") && r.includes('St. Augustine'))).toBe(true);
  });

  test('a track the pricer honors adds no reason', () => {
    const { lane, reasons } = classifyLane(lawnArgs(lawnLine({ track: 'bahia', grassType: 'Bahia' }), lawnIntent('bahia')));
    expect(lane).toBe(LANES.GREEN);
    expect(reasons).toEqual([]);
  });
});

// ── 3. Reused-lead window excludes foreign-sid leads ──────────
describe('audit P2: reused-lead window vs foreign-sid leads', () => {
  const CALL = {
    id: 'call-a',
    twilio_call_sid: 'CA-call-a',
    created_at: '2026-07-01T17:00:00.000Z',
  };

  beforeEach(() => { mockLeadRows = []; });

  test("another call's sid-stamped lead inside the window is NOT claimed as this call's lead", async () => {
    mockLeadRows = [{
      id: 'lead-b',
      phone: '+19415550123',
      twilio_call_sid: 'CA-call-b',
      deleted_at: null,
      created_at: '2026-07-01T17:20:00.000Z',
      updated_at: '2026-07-01T17:20:00.000Z',
    }];
    const { lead, forThisCall } = await ctxPriv.loadLeadForCall(CALL, '+19415550123');
    // The foreign lead may still surface via the generic byPhone fallback,
    // but never with current-call priority (address/email/linkage trust).
    expect(forThisCall).toBe(false);
    expect(lead?.id).toBe('lead-b');
  });

  test('an unstamped reused lead touched inside the window keeps current-call priority', async () => {
    mockLeadRows = [{
      id: 'lead-reused',
      phone: '+19415550123',
      twilio_call_sid: null,
      deleted_at: null,
      created_at: '2026-06-20T09:00:00.000Z',
      updated_at: '2026-07-01T17:05:00.000Z',
    }];
    const { lead, forThisCall } = await ctxPriv.loadLeadForCall(CALL, '+19415550123');
    expect(forThisCall).toBe(true);
    expect(lead.id).toBe('lead-reused');
  });

  test("this call's OWN sid-stamped lead is still claimed", async () => {
    mockLeadRows = [{
      id: 'lead-own',
      phone: '+19415550123',
      twilio_call_sid: 'CA-call-a',
      deleted_at: null,
      created_at: '2026-07-01T17:01:00.000Z',
      updated_at: '2026-07-01T17:01:00.000Z',
    }];
    const { lead, forThisCall } = await ctxPriv.loadLeadForCall(CALL, '+19415550123');
    expect(forThisCall).toBe(true);
    expect(lead.id).toBe('lead-own');
  });
});

// ── 4. House number is not a ZIP ──────────────────────────────
describe('audit P2: 5-digit house numbers vs ZIP comparison', () => {
  test('bare street form equals its ZIP-carrying form (missing ZIP is conservative-equal)', () => {
    expect(sameStreetAddress('12345 Example Trl', '12345 Example Trl, Testville, FL 34287')).toBe(true);
  });

  test('two real differing ZIPs still compare unequal', () => {
    expect(sameStreetAddress('123 Palm Ave, Bradenton FL 34209', '123 Palm Ave, Bradenton FL 34211')).toBe(false);
  });

  test('matching real ZIPs on a 5-digit house number compare equal', () => {
    expect(sameStreetAddress('12345 Example Trl, Testville FL 34287', '12345 Example Trl, Testville, FL 34287')).toBe(true);
  });

  test('different streets stay unequal regardless of ZIP handling', () => {
    expect(sameStreetAddress('12345 Example Trl', '54321 Other Rd, Testville, FL 34287')).toBe(false);
  });
});

// ── 5. V2 lot clearing is applicability-scoped ────────────────
describe('audit P2: V2 apply keeps real lots for tenants and unresolved parcels', () => {
  const v1Facts = () => ({
    home: { value: 1800, source: 'county_assessed', rejected: [] },
    lot: { value: 9500, source: 'county_assessed', confidence: 'high', rejected: [] },
    stories: 1,
  });
  const v2 = (applicability, lotSize = null) => ({
    legacyDerived: { squareFootage: 1800, lotSize, stories: 1 },
    facts: {
      confidenceLevel: 'high',
      lot: { applicability },
      structureArea: null,
    },
  });

  test('leased_land tenant keeps the V1 county lot (parcel exists, service treats it)', () => {
    const facts = v1Facts();
    shadow.applyV2ToPropertyFacts(facts, v2('leased_land'));
    expect(facts.lot.value).toBe(9500);
    expect(facts.lot.source).toBe('county_assessed');
  });

  test('unresolved private_parcel keeps the V1 lot instead of a false "no lot"', () => {
    const facts = v1Facts();
    shadow.applyV2ToPropertyFacts(facts, v2('private_parcel'));
    expect(facts.lot.value).toBe(9500);
  });

  test('common_master_parcel condo still clears a leaked development lot', () => {
    const facts = v1Facts();
    shadow.applyV2ToPropertyFacts(facts, v2('common_master_parcel'));
    expect(facts.lot.value).toBeNull();
    expect(facts.lot.source).toBe('no_individual_lot:common_master_parcel');
    expect(facts.lot.confidence).toBe('high');
  });

  test('leased_suite (no_individual_lot) still clears the lot', () => {
    const facts = v1Facts();
    shadow.applyV2ToPropertyFacts(facts, v2('no_individual_lot'));
    expect(facts.lot.value).toBeNull();
  });

  test('a V2-resolved lot value still replaces V1 as before', () => {
    const facts = v1Facts();
    shadow.applyV2ToPropertyFacts(facts, v2('private_parcel', 11000));
    expect(facts.lot.value).toBe(11000);
  });
});
