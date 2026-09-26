const { SQFT_SOURCES, FALLBACK_SQFT_SOURCES } = require('../services/estimator-engine/source-arbitration');
const { applyUnitScopeToPropertyFacts } = require('../services/estimator-engine/unit-scope-model');
const { buildEngineInput, classifyLane, LANES } = require('../services/estimator-engine/draft-builder');

describe('commercial-suite-size sources in source-arbitration', () => {
  test('the two sizing sources exist and are never in FALLBACK_SQFT_SOURCES; the web-search rung is gone', () => {
    expect(SQFT_SOURCES.LICENSE_SEATS).toBe('license_seats');
    expect(SQFT_SOURCES.SUITE_TYPE_DEFAULT).toBe('suite_type_default');
    expect(SQFT_SOURCES.COMMERCIAL_LISTING).toBeUndefined();
    // If these were fallback sources, buildEngineInput's
    // buildingSizeMeasured check would go false and priceCommercialPest
    // would fall back to manual_quote — defeating the whole feature.
    expect(FALLBACK_SQFT_SOURCES.has(SQFT_SOURCES.LICENSE_SEATS)).toBe(false);
    expect(FALLBACK_SQFT_SOURCES.has(SQFT_SOURCES.SUITE_TYPE_DEFAULT)).toBe(false);
  });
});

describe('applyUnitScopeToPropertyFacts — the sizing sources survive a commercial_suite scope', () => {
  test.each([SQFT_SOURCES.LICENSE_SEATS, SQFT_SOURCES.SUITE_TYPE_DEFAULT])(
    '%s is not cleared on a part-building commercial suite', (source) => {
      const propertyFacts = {
        home: { value: 1400, source, confidence: 'medium', rejected: [] },
        lot: { value: null, source: 'unresolved', confidence: 'none', rejected: [] },
      };
      const model = {
        serviceScope: 'commercial_suite',
        partBuildingEvidence: true,
        propertyUse: 'retail',
        aggregated: false,
        lotApplicability: 'no_individual_lot',
        subpremiseSignal: true,
      };
      applyUnitScopeToPropertyFacts(propertyFacts, model);
      expect(propertyFacts.home.value).toBe(1400);
      expect(propertyFacts.home.source).toBe(source);
    },
  );

  test('still clears a genuine building-scoped source (county_assessed) on the same scope', () => {
    const propertyFacts = {
      home: { value: 46031, source: 'county_assessed', confidence: 'high', rejected: [] },
      lot: { value: null, source: 'unresolved', confidence: 'none', rejected: [] },
    };
    const model = {
      serviceScope: 'commercial_suite',
      partBuildingEvidence: true,
      propertyUse: 'retail',
      aggregated: false,
      lotApplicability: 'no_individual_lot',
      subpremiseSignal: true,
    };
    applyUnitScopeToPropertyFacts(propertyFacts, model);
    expect(propertyFacts.home.value).toBeNull();
    expect(propertyFacts.home.source).toBe('unresolved');
  });
});

describe('buildEngineInput — buildingSizeMeasured true for the sizing sources', () => {
  test.each([SQFT_SOURCES.LICENSE_SEATS, SQFT_SOURCES.SUITE_TYPE_DEFAULT])(
    '%s auto-prices (buildingSizeMeasured: true, footprintSqFt set)', (source) => {
      const intent = {
        is_commercial: true,
        services: { pest: true },
        commercial_risk_type: 'restaurant_food',
      };
      const propertyFacts = {
        home: { value: 1400, source, confidence: 'medium', rejected: [] },
        lot: { value: null, source: 'unresolved', confidence: 'none', rejected: [] },
      };
      const input = buildEngineInput({ intent, propertyFacts, context: {} });
      expect(input.buildingSizeMeasured).toBe(true);
      expect(input.footprintSqFt).toBe(1400);
      expect(input.homeSqFt).toBe(1400);
    },
  );
});

describe('classifyLane — commercial-suite-size review reasons', () => {
  const baseIntent = () => ({
    decision: 'draft',
    is_commercial: true,
    services: { pest: true },
    address: '4400 Test Commons Pkwy E #102, Bradenton, FL 00000',
    commercial_risk_type: 'restaurant_food',
    confidence: 'high',
    evidence: [{ speaker: 'caller', quote: 'we need pest control for the restaurant', decision: 'pest' }],
    constraint_flags: [],
  });
  const commercialPestLine = (footprintUsed) => ({
    service: 'commercial_pest', name: 'Commercial Pest Control', monthly: 103, annual: 1236,
    footprintUsed, manualReviewReasons: [], pricingConfidence: 'MEDIUM',
  });
  const totals = { monthly: 103, annual: 1236, oneTime: 0 };

  beforeEach(() => { process.env.GATE_UNIT_SCOPE_GUARDRAILS = 'true'; });
  afterEach(() => { delete process.env.GATE_UNIT_SCOPE_GUARDRAILS; });

  test('license_seats parks yellow with the seats -> sqft reason', () => {
    const propertyFacts = {
      home: { value: 1400, source: SQFT_SOURCES.LICENSE_SEATS, confidence: 'medium', rejected: [] },
      commercialSuiteSize: { value: 1400, source: SQFT_SOURCES.LICENSE_SEATS, confidence: 'medium', seats: 25, businessName: 'Test Taco Shop' },
    };
    const out = classifyLane({
      intent: baseIntent(), propertyFacts, engineResult: { lineItems: [commercialPestLine(1400)] }, totals, comps: null, calibration: [],
    });
    expect(out.lane).toBe(LANES.YELLOW);
    expect(out.reasons).toEqual(expect.arrayContaining([
      expect.stringMatching(/suite size estimated from state restaurant license: 25 seats.*1,400 sq ft.*confirm on site/),
    ]));
  });

  test('suite_type_default parks yellow with a defaulted-size reason', () => {
    const propertyFacts = {
      home: { value: 1800, source: SQFT_SOURCES.SUITE_TYPE_DEFAULT, confidence: 'low', rejected: [] },
      commercialSuiteSize: { value: 1800, source: SQFT_SOURCES.SUITE_TYPE_DEFAULT, confidence: 'low', businessType: 'restaurant_food' },
    };
    const out = classifyLane({
      intent: baseIntent(), propertyFacts, engineResult: { lineItems: [commercialPestLine(1800)] }, totals, comps: null, calibration: [],
    });
    expect(out.lane).toBe(LANES.YELLOW);
    expect(out.reasons.some((r) => /suite size not found.*defaulted to 1,800 sq ft.*confirm on site/.test(r))).toBe(true);
  });

  test('the defaulted-size reason labels with commercial_risk_type/subtype, never suiteSize.businessType (primary review PR #4840 r4 P2)', () => {
    // A web-search-reported businessType of "restaurant" plays no part in
    // sizing this office/retail suite (value stays 1,500 sqft, the
    // retail/office default) — the reason must read the composed intent's
    // own commercial_risk_type, never the model's guess.
    const intent = { ...baseIntent(), commercial_risk_type: 'retail_standard' };
    const propertyFacts = {
      home: { value: 1500, source: SQFT_SOURCES.SUITE_TYPE_DEFAULT, confidence: 'low', rejected: [] },
      commercialSuiteSize: { value: 1500, source: SQFT_SOURCES.SUITE_TYPE_DEFAULT, confidence: 'low', businessType: 'restaurant' },
    };
    const out = classifyLane({
      intent, propertyFacts, engineResult: { lineItems: [commercialPestLine(1500)] }, totals, comps: null, calibration: [],
    });
    const reason = out.reasons.find((r) => /suite size not found/.test(r));
    expect(reason).toMatch(/defaulted to 1,500 sq ft for retail_standard/);
    expect(reason).not.toMatch(/restaurant/);
  });
});

describe('risk-type inference source', () => {
  const fs = require('fs');
  const path = require('path');
  test('only the state license may set commercial_risk_type — never a web-search businessType', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/estimator-engine/index.js'), 'utf8');
    const i = src.indexOf("intent.commercial_risk_type = 'restaurant_food'");
    expect(i).toBeGreaterThan(-1);
    const guard = src.slice(src.lastIndexOf('if (!intent.commercial_risk_type', i), i);
    expect(guard).toMatch(/suiteSize\.source === SQFT_SOURCES\.LICENSE_SEATS/);
    expect(guard).not.toMatch(/businessType/);
  });
});

describe('engine adoption of the lookup suite size', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../services/estimator-engine/index.js'), 'utf8');
  test('adopts only a license-sourced lookup size; a lookup type default is re-resolved with the call context', () => {
    const i = src.indexOf('const lookupSuiteSize = effectiveSignals.enriched?.suiteSize');
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, i + 1400);
    expect(block).toMatch(/lookupSuiteSize\.source === SQFT_SOURCES\.LICENSE_SEATS/);
    expect(block).toMatch(/phone: context\?\.phone/);
    expect(block).toMatch(/skipWebSearch: Boolean\(lookupSuiteSize\)/);
  });

  // Primary review of PR #4840 r4 P2: intent.customer_name is the CALLER,
  // never the business — passing it as businessNameHint would mislabel
  // every resolved suite with the caller's own name.
  test('businessNameHint is never the caller\'s name, and the lookup businessName fallback still runs', () => {
    const i = src.indexOf('const lookupSuiteSize = effectiveSignals.enriched?.suiteSize');
    const block = src.slice(i, i + 1700);
    expect(block).toMatch(/businessNameHint:\s*null,/);
    expect(block).not.toMatch(/businessNameHint:\s*intent\.customer_name/);
    expect(block).toMatch(/!suiteSize\.businessName && lookupSuiteSize\?\.businessName/);
  });
});

describe('engine suite sizing depends on unit-scope guardrails (declared)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../services/estimator-engine/index.js'), 'utf8');
  test('the suite block sits inside the guardrails apply, and guardrails-off with the suite gate on warns', () => {
    const apply = src.indexOf('applyUnitScopeToPropertyFacts(propertyFacts, unitScope);');
    const guard = src.lastIndexOf('if (unitScopeGuardrailsEnabled()) {', apply);
    const suite = src.indexOf("unitScope.serviceScope === 'commercial_suite'", apply);
    expect(guard).toBeGreaterThan(-1);
    expect(suite).toBeGreaterThan(apply);
    expect(src.slice(guard - 600, guard)).toMatch(/GATE_UNIT_SCOPE_GUARDRAILS is off/);
  });
});
