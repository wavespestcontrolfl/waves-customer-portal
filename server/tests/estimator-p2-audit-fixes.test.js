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
let mockCallLogRows = [];

jest.mock('../models/db', () => {
  const toTime = (v) => new Date(v).getTime();
  const makeBuilder = (table, rows) => {
    let filtered = rows.slice();
    let projection = null;
    const project = (r) => {
      if (!r || !projection) return r;
      // Honor .select() projections — a column the query never selected
      // must come back undefined, exactly as it would from knex (this
      // fidelity caught a real bug: a guard reading an unselected column).
      return Object.fromEntries(projection.filter((c) => c in r).map((c) => [c, r[c]]));
    };
    const builder = {
      select(...cols) {
        const flat = cols.flat().filter(Boolean);
        if (flat.length) projection = flat;
        return this;
      },
      whereRaw() { return this; },
      whereNot(col, val) { filtered = filtered.filter((r) => r[col] !== val); return this; },
      whereNull(col) { filtered = filtered.filter((r) => r[col] == null); return this; },
      where(a, b, c) {
        if (typeof a === 'function') {
          // Grouped-or subclause: collect whereNull/orWhere alternatives and
          // keep rows matching ANY of them (mirrors knex semantics closely
          // enough for the sid-exclusion contract under test).
          const alts = [];
          const qb = {
            whereNull(col) { alts.push((r) => r[col] == null); return qb; },
            // Raw phone-digit matches are treated as always-true — the
            // fixtures only carry rows for the number under test.
            whereRaw() { alts.push(() => true); return qb; },
            orWhereRaw() { alts.push(() => true); return qb; },
            orWhere(col, opOrVal, val) {
              if (val === undefined) { alts.push((r) => r[col] === opOrVal); return qb; }
              if (opOrVal === '<') { alts.push((r) => toTime(r[col]) < toTime(val)); return qb; }
              if (opOrVal === '>') { alts.push((r) => toTime(r[col]) > toTime(val)); return qb; }
              alts.push((r) => r[col] === val);
              return qb;
            },
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
      async first() { return project(filtered[0]) || null; },
      then(resolve, reject) { return Promise.resolve(filtered.map(project)).then(resolve, reject); },
      catch() { return this; },
    };
    return builder;
  };
  return (table) => makeBuilder(table, table === 'leads' ? mockLeadRows : (table === 'call_log' ? mockCallLogRows : []));
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

  test('MEDIUM supplied-estimate turf does not over-flag', () => {
    const { lane } = classifyLane(lawnArgs(lawnLine({
      turfEstimated: true, turfConfidence: 'MEDIUM', turfBasis: 'estimatedTurfSf',
    })));
    expect(lane).toBe(LANES.GREEN);
  });

  test('MEDIUM plausibleMaxTurfCap turf still lands yellow — capped basis is heuristic regardless of grade', () => {
    const { lane, reasons } = classifyLane(lawnArgs(lawnLine({
      turfEstimated: true, turfConfidence: 'MEDIUM', turfBasis: 'plausibleMaxTurfCap',
    })));
    expect(lane).toBe(LANES.YELLOW);
    expect(reasons.some((r) => r.includes('plausibleMaxTurfCap'))).toBe(true);
  });

  test('a LOW-confidence lot (caller-stated, e.g. retained by the V2 apply) parks a lot-driven draft yellow', () => {
    const args = lawnArgs(lawnLine());
    args.propertyFacts.lot = { value: 9500, source: 'caller_stated', confidence: 'low', rejected: [] };
    const { lane, reasons } = classifyLane(args);
    expect(lane).toBe(LANES.YELLOW);
    expect(reasons.some((r) => r.includes('low-confidence') && r.includes('caller_stated'))).toBe(true);
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

  beforeEach(() => { mockLeadRows = []; mockCallLogRows = []; });

  test("another call's sid-stamped lead inside the window is not returned at all", async () => {
    mockLeadRows = [{
      id: 'lead-b',
      phone: '+19415550123',
      twilio_call_sid: 'CA-call-b',
      deleted_at: null,
      created_at: '2026-07-01T17:20:00.000Z',
      updated_at: '2026-07-01T17:20:00.000Z',
    }];
    const { lead, forThisCall } = await ctxPriv.loadLeadForCall(CALL, '+19415550123');
    // Neither current-call priority NOR the byPhone fallback may surface a
    // concurrent caller's lead — its address/contact would otherwise still
    // reach the composer as untrusted context.
    expect(forThisCall).toBe(false);
    expect(lead).toBeNull();
  });

  test("an OLDER call's sid-stamped lead remains legitimate prior phone history", async () => {
    mockLeadRows = [{
      id: 'lead-history',
      phone: '+19415550123',
      twilio_call_sid: 'CA-last-week',
      deleted_at: null,
      created_at: '2026-06-24T10:00:00.000Z',
      updated_at: '2026-06-24T10:00:00.000Z',
    }];
    const { lead, forThisCall } = await ctxPriv.loadLeadForCall(CALL, '+19415550123');
    expect(forThisCall).toBe(false);
    expect(lead?.id).toBe('lead-history');
  });

  test('an older sid-stamped lead REUSED by this call (updated_at refreshed in-window) keeps current-call priority', async () => {
    // The processor reuses prior leads without restamping twilio_call_sid —
    // a different sid with created_at BEFORE the call is the normal reuse
    // case, not a concurrent caller's creation.
    mockLeadRows = [{
      id: 'lead-reused-old-sid',
      phone: '+19415550123',
      twilio_call_sid: 'CA-two-weeks-ago',
      deleted_at: null,
      created_at: '2026-06-17T09:00:00.000Z',
      updated_at: '2026-07-01T17:06:00.000Z',
    }];
    const { lead, forThisCall } = await ctxPriv.loadLeadForCall(CALL, '+19415550123');
    expect(forThisCall).toBe(true);
    expect(lead.id).toBe('lead-reused-old-sid');
  });

  test('an older sid-stamped lead updated in-window is only PRIOR HISTORY when a concurrent call overlaps the window', async () => {
    // updated_at cannot say WHICH call touched the lead — with another call
    // from the same line inside the window, attribution is ambiguous and
    // must fall to the conservative byPhone path.
    mockLeadRows = [{
      id: 'lead-ambiguous',
      phone: '+19415550123',
      twilio_call_sid: 'CA-two-weeks-ago',
      deleted_at: null,
      created_at: '2026-06-17T09:00:00.000Z',
      updated_at: '2026-07-01T17:06:00.000Z',
    }];
    mockCallLogRows = [{
      id: 'call-b',
      twilio_call_sid: 'CA-call-b',
      from_phone: '+19415550123',
      to_phone: '+19415551111',
      created_at: '2026-07-01T17:04:00.000Z',
    }];
    const { lead, forThisCall } = await ctxPriv.loadLeadForCall(CALL, '+19415550123');
    expect(forThisCall).toBe(false);
    expect(lead?.id).toBe('lead-ambiguous');
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
  const v2 = (applicability, lotSize = null, serviceScope = 'entire_residential_structure') => ({
    legacyDerived: { squareFootage: 1800, lotSize, stories: 1 },
    facts: {
      confidenceLevel: 'high',
      serviceScope,
      lot: { applicability },
      structureArea: null,
    },
  });

  test('leased_land tenant of an entire structure keeps the V1 county lot (parcel exists, service treats it)', () => {
    const facts = v1Facts();
    shadow.applyV2ToPropertyFacts(facts, v2('leased_land'));
    expect(facts.lot.value).toBe(9500);
    expect(facts.lot.source).toBe('county_assessed');
  });

  test('leased_land tenant in a UNIT scope still clears — the V1 lot is the development master parcel', () => {
    const facts = v1Facts();
    shadow.applyV2ToPropertyFacts(facts, v2('leased_land', null, 'residential_unit'));
    expect(facts.lot.value).toBeNull();
    expect(facts.lot.source).toBe('no_individual_lot:leased_land');
  });

  test('leased_land with an UNKNOWN scope stays conservative and clears', () => {
    const facts = v1Facts();
    shadow.applyV2ToPropertyFacts(facts, v2('leased_land', null, 'unknown'));
    expect(facts.lot.value).toBeNull();
  });

  test('unresolved private_parcel keeps the V1 lot as DATA but downgrades it to low confidence', () => {
    const facts = v1Facts();
    shadow.applyV2ToPropertyFacts(facts, v2('private_parcel'));
    // V2 required a private-lot measurement and failed to resolve one — the
    // value survives (not a false "no lot") but must route to review, so a
    // medium-confidence profile lot cannot green-lane lot-driven pricing.
    expect(facts.lot.value).toBe(9500);
    expect(facts.lot.confidence).toBe('low');
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
