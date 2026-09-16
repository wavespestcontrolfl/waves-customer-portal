/**
 * Waves Subterranean Termite Protection — the annual plan (plan §A2/§A3;
 * RULING A-1 = shape P1, owner 2026-09-11). Dark behind
 * GATE_TERMITE_ANNUAL_PLAN: the engine emits a station SETUP fee (one-time,
 * stations × $30, never tier-discounted) + an ANNUAL protection fee ($249
 * base + $50 per 5-station bracket above 10, tier-discounted, 1 visit/yr)
 * instead of today's install + quarterly monitoring; rental and the bond
 * rider are retired on the plan; the plan's own constants replay.
 */
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/pricing-engine', () => {
  const actual = jest.requireActual('../services/pricing-engine');
  return { ...actual, needsSync: () => false };
});
const constants = require('../services/pricing-engine/constants');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const adminPricingConfigRouter = require('../routes/admin-pricing-config');
const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
const replay = require('../services/estimate-tree-shrub-knob-replay');

const HOME = (homeSqFt, extra = {}) => ({ homeSqFt, lotSqFt: 8000, propertyType: 'single_family', ...extra });
const termiteLine = (r) => r.lineItems.find((l) => l.service === 'termite_bait');
const snapshot = JSON.parse(JSON.stringify(constants.TERMITE.annualPlan));
const priorCancellationGate = process.env.GATE_CANCEL_FLOW_V2;
beforeAll(() => { process.env.GATE_CANCEL_FLOW_V2 = 'true'; });
afterAll(() => {
  if (priorCancellationGate === undefined) delete process.env.GATE_CANCEL_FLOW_V2;
  else process.env.GATE_CANCEL_FLOW_V2 = priorCancellationGate;
});
afterEach(() => { Object.assign(constants.TERMITE.annualPlan, JSON.parse(JSON.stringify(snapshot))); });

describe('annual plan — gate', () => {
  test('gate OFF: a plan request prices as today\'s quarterly program (install + 4 station checks)', () => {
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    const li = termiteLine(generateEstimate(HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection' } } })));
    expect(li.plan).toBe('quarterly');
    expect(li.installation).toMatchObject({ kind: 'install', price: 653 });
    expect(li.visitsPerYear).toBe(4);
    expect(li.annual).toBe(288);
    expect(li.setup).toBeUndefined();
  });

  test('annual gate alone cannot price a fresh plan while term-aware cancellation is disabled', () => {
    process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
    delete process.env.GATE_CANCEL_FLOW_V2;
    try {
      const line = termiteLine(generateEstimate(HOME(2000, { services: { termite: { plan: 'annual_protection' } } })));
      expect(line).toMatchObject({ plan: 'quarterly', visitsPerYear: 4 });
    } finally {
      delete process.env.GATE_TERMITE_ANNUAL_PLAN;
      process.env.GATE_CANCEL_FLOW_V2 = 'true';
    }
  });
});

describe('annual plan — pricing (ruling A-1 = P1)', () => {
  beforeAll(() => { process.env.GATE_TERMITE_ANNUAL_PLAN = 'true'; });
  afterAll(() => { delete process.env.GATE_TERMITE_ANNUAL_PLAN; });

  test('rental and the bond rider are retired on the plan even when requested', () => {
    process.env.GATE_TERMITE_STATION_RENTAL = 'true';
    process.env.GATE_TERMITE_BOND_OPTION = 'true';
    try {
      const r = generateEstimate(HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection', ownership: 'rent', bondTerm: '5yr' } } }));
      expect(r.lineItems.map((l) => l.service)).toEqual(['termite_bait']);
      const li = termiteLine(r);
      expect(li.installation.price).toBe(450);
      expect(li.stationRental).toBeUndefined();
      expect(li.bondOptions).toBeUndefined();
    } finally {
      delete process.env.GATE_TERMITE_STATION_RENTAL;
      delete process.env.GATE_TERMITE_BOND_OPTION;
    }
  });

  test('the plan is Trelona-only: a legacy Advance request is priced as Trelona at 15-ft spacing', () => {
    const li = termiteLine(generateEstimate(HOME(2000, { services: { termite: { system: 'advance', plan: 'annual_protection' } } })));
    expect(li.system).toBe('trelona');
    expect(li.stations).toBe(15); // 224 LF / 15 ft, not 23 at Advance's 10 ft
    expect(li.installation.price).toBe(450);
    expect(li.annual).toBe(299);
  });

  test('the cost model runs on one service visit a year', () => {
    const li = termiteLine(generateEstimate(HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection' } } })));
    expect(li.costs.serviceVisitsPerYear).toBe(1);
    expect(li.costs.serviceLaborAnnual).toBe(li.costs.serviceLaborPerVisit);
    expect(li.costs.cartridgeReplacementAnnual).toBe(67.62);
  });

  test('the WaveGuard tier discounts the annual fee, never the setup fee', () => {
    const r = generateEstimate(HOME(2000, {
      services: { pest: { frequency: 'quarterly' }, termite: { system: 'trelona', plan: 'annual_protection' } },
    }));
    const li = termiteLine(r);
    expect(r.waveGuard.tier).toBe('silver'); // pest + termite = two qualifying services
    expect(li.installation.price).toBe(450); // setup untouched by the tier
    expect(li.annual).toBe(299);
    expect(li.annualAfterDiscount).toBeCloseTo(299 * 0.9, 2);
    const m = mapV1ToLegacyShape(r);
    expect(m.oneTime.items.find((i) => i.service === 'termite_bait_installation').price).toBe(450);
  });

  test('the mapped admin envelope carries the plan; the one-time item is the Station Setup', () => {
    const m = mapV1ToLegacyShape(generateEstimate(HOME(2117, { services: { termite: { system: 'trelona', plan: 'annual_protection' } } })));
    expect(m.results.tmBait).toMatchObject({ plan: 'annual_protection', setupFee: 480, setupPerStation: 30, annualFee: 349, visitsPerYear: 1 });
    expect(m.oneTime.items).toEqual([expect.objectContaining({ service: 'termite_bait_installation', name: 'Station Setup', price: 480, kind: 'setup', tierDiscountable: false })]);
    expect(m.recurring.services.find((s) => s.service === 'termite_bait')).toMatchObject({ perTreatment: 349, visitsPerYear: 1 });
    expect(m.oneTime.tmInstall).toBe(480);
  });

  test('the V2 translator carries termitePlan; anything else is ignored', () => {
    const on = translateV2CallToV1Input({ homeSqFt: 2000, lotSqFt: 8000 }, ['TERMITE_BAIT'], { termitePlan: 'annual_protection' });
    expect(on.services.termite.plan).toBe('annual_protection');
    const off = translateV2CallToV1Input({ homeSqFt: 2000, lotSqFt: 8000 }, ['TERMITE_BAIT'], { termitePlan: 'quarterly' });
    expect(off.services.termite.plan).toBeUndefined();
  });

  test('the plan constants replay: a config move after send does not change a sent quote', () => {
    const sent = termiteLine(generateEstimate(HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection' } } })));
    expect(sent.pricingKnobs).toMatchObject({ plan: 'annual_protection', setupPerStation: 30, annualBase: 249, annualStep: 50, bracketStations: 5, bracketFloor: 10 });
    constants.TERMITE.annualPlan.setupPerStation = 35;
    constants.TERMITE.annualPlan.annualBase = 279;
    const live = termiteLine(generateEstimate(HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection' } } })));
    expect(live.installation.price).toBe(525);
    expect(live.annual).toBe(329);
    const signal = replay.termiteKnobSignalForReplay({ result: { lineItems: [sent] } });
    expect(signal).toMatchObject({ plan: 'annual_protection', setupPerStation: 30, annualBase: 249 });
    const replayed = termiteLine(generateEstimate(HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection' } }, termitePricingKnobs: signal })));
    expect(replayed.installation.price).toBe(450);
    expect(replayed.annual).toBe(299);
  });
});

describe('annual plan — an issued plan survives the gate being unset (codex r2 P0)', () => {
  test('gate OFF + a stamped plan snapshot on the replay input keeps pricing the plan with its stamped constants', () => {
    process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
    const sent = termiteLine(generateEstimate(HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection' } } })));
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    const signal = replay.termiteKnobSignalForReplay({ result: { lineItems: [sent] } });
    const replayed = termiteLine(generateEstimate(HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection' } }, termitePricingKnobs: signal })));
    expect(replayed.plan).toBe('annual_protection');
    expect(replayed.installation).toMatchObject({ kind: 'setup', price: 450 });
    expect(replayed).toMatchObject({ visitsPerYear: 1, annual: 299 });
    // …while a FRESH selection with the gate off is still ignored.
    const fresh = termiteLine(generateEstimate(HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection' } } })));
    expect(fresh.plan).toBe('quarterly');
  });

  test('a stamp outside the admin validator bands cannot underprice or overprice the plan — the live constants price instead', () => {
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    const forged = { plan: 'annual_protection', setupPerStation: 0.01, annualBase: 0.5, annualStep: 99999, bracketStations: 0, bracketFloor: 5000 };
    const replayed = termiteLine(generateEstimate(HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection' } }, termitePricingKnobs: forged })));
    // 15 stations: setup 15 × $30 (0.01 refused), annual $249 + $50 (0.5 refused, 99999 refused, 0/5000 refused).
    expect(replayed.installation).toMatchObject({ kind: 'setup', price: 450 });
    expect(replayed.annual).toBe(299);
    expect(replayed.pricingKnobs).toMatchObject({ setupPerStation: 30, annualBase: 249, annualStep: 50, bracketStations: 5, bracketFloor: 10 });
  });
});

describe('replay-stamp provenance (pre-push audit #4424)', () => {
  test.each([1, 2])('a stored %i-visit contract retains its cadence, coverage and label after live terms change', (visits) => {
    constants.TERMITE.annualPlan.visitsPerYear = visits;
    process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
    const inputs = HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection' } } });
    const sold = termiteLine(generateEstimate(inputs));
    expect(sold.planTerms).toMatchObject({ coverageMonths: 12, visitsPerYear: visits });
    const stored = { engineInputs: inputs, result: { lineItems: [sold] } };
    const knobs = replay.termiteKnobSignalForReplay(stored);
    expect(knobs).toMatchObject({ coverageMonths: 12, visitsPerYear: visits, label: sold.planLabel });
    const mapped = mapV1ToLegacyShape(generateEstimate(inputs));
    expect(mapped.results.tmBait.visitsPerYear).toBe(visits);
    expect(replay.termiteKnobSignalForReplay({ result: mapped })).toEqual(knobs);
    Object.assign(constants.TERMITE.annualPlan, { coverageMonths: 24, visitsPerYear: 3, label: 'Changed plan' });
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    const replayed = termiteLine(generateEstimate({ ...inputs, termitePricingKnobs: knobs }));
    expect(replayed.plan).toBe('annual_protection');
    expect(replayed.planTerms).toEqual(sold.planTerms);
    expect(replayed.planLabel).toBe(sold.planLabel);
    expect(replayed.annual).toBe(sold.annual);
  });
  test('the public v2 translator never forwards a caller-supplied replay stamp — gate off prices the quarterly program', () => {
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    const v1Input = translateV2CallToV1Input(
      { homeSqFt: 2000, lotSqFt: 8000, termitePricingKnobs: { plan: 'annual_protection' } },
      ['TERMITE_BAIT'],
      { termitePlan: 'annual_protection', termitePricingKnobs: { plan: 'annual_protection', setupPerStation: 1 } },
    );
    expect(v1Input).not.toHaveProperty('termitePricingKnobs');
    expect(v1Input).not.toHaveProperty('treeShrubPricingKnobs');
    expect(v1Input.services.termite.plan).toBe('annual_protection');
    const line = termiteLine(generateEstimate(v1Input));
    expect(line.plan).toBe('quarterly');
    expect(line.setupFee).toBeUndefined();
  });

  test('the admin pricing sandbox strips a posted termitePricingKnobs stamp — gate off prices the quarterly program', async () => {
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    const handler = adminPricingConfigRouter.stack
      .find((layer) => layer.route?.path === '/estimate' && layer.route.methods.post).route.stack[0].handle;
    const body = {
      homeSqFt: 2400, lotSqFt: 9000,
      termitePricingKnobs: { plan: 'annual_protection', stationCost: 24 },
      services: { termite: { plan: 'annual_protection' } },
    };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    const next = jest.fn();
    await handler({ body }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledTimes(1);
    const { estimate } = res.json.mock.calls[0][0];
    // The posted body itself is left alone (a copy is sanitized).
    expect(body.termitePricingKnobs).toEqual({ plan: 'annual_protection', stationCost: 24 });
    const termite = (estimate.lineItems || []).find((l) => l.service === 'termite_bait');
    expect(termite).toBeTruthy();
    expect(termite.plan).toBe('quarterly');
    expect(termite.setupFee).toBeUndefined();
    expect(termite.pricingKnobs.plan).not.toBe('annual_protection');
  });

  test('the customer-facing replay builds its stamp from the stored RESULT, never from stored/posted input fields', () => {
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    const { extractEngineInputs } = require('../routes/estimate-public');
    // The stored inputs REQUEST the plan (a service option, legitimately
    // stored and not an identity field) — so the only thing standing between
    // this replay and annual-plan pricing with the gate off is where the
    // stamp comes from.
    const inputs = { homeSqFt: 2400, lotSqFt: 9000, services: { termite: { system: 'trelona', plan: 'annual_protection' } } };
    const forged = { plan: 'annual_protection', setupPerStation: 30, annualBase: 249, annualStep: 50, bracketStations: 5, bracketFloor: 10 };
    // A QUARTERLY estimate whose every stored input slot has been polluted
    // with an annual-plan stamp (the save path scrubs these, so this is the
    // shape a pre-scrub row or a forged write would have).
    const quarterlySold = {
      engineInputs: { ...inputs, termitePricingKnobs: forged },
      inputs: { ...inputs, termitePricingKnobs: forged },
      engineRequest: { profile: {}, selectedServices: [], options: { termitePricingKnobs: forged } },
      result: { lineItems: [{ service: 'termite_bait', plan: 'quarterly', system: 'trelona', stations: 15, pricingKnobs: { system: 'trelona', stationCost: 24 } }] },
    };
    const replayed = extractEngineInputs(quarterlySold);
    expect(replayed.termitePricingKnobs.plan).toBe('quarterly');
    expect(termiteLine(generateEstimate(replayed)).plan).toBe('quarterly');

    // Positive control: the SAME reader returns the plan stamp when the
    // stored RESULT says the job was sold as a plan — that is the evidence
    // the gate-off replay runs on, and it lives in the priced line.
    const planSold = {
      ...quarterlySold,
      result: { lineItems: [{ service: 'termite_bait', plan: 'annual_protection', system: 'trelona', stations: 15, pricingKnobs: { system: 'trelona', stationCost: 24, ...forged } }] },
    };
    expect(extractEngineInputs(planSold).termitePricingKnobs.plan).toBe('annual_protection');
    expect(termiteLine(generateEstimate(extractEngineInputs(planSold))).plan).toBe('annual_protection');
  });

  test('a quarterly quote issued with the gate off stays quarterly after the gate turns on', () => {
    const { extractEngineInputs } = require('../routes/estimate-public');
    const inputs = HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection' } } });
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    const issued = termiteLine(generateEstimate(inputs));
    expect(issued).toMatchObject({ plan: 'quarterly', visitsPerYear: 4, annual: 288 });
    expect(issued.installation).toMatchObject({ kind: 'install', price: 653 });
    expect(issued.pricingKnobs.plan).toBe('quarterly');

    // Admin V2 persists the mapped envelope, so exercise the production
    // representation rather than relying only on the raw-line reader. A
    // revision can retain the draft's older raw engineResult; the mapped
    // quarterly result must remain exclusive for program identity.
    const mapped = mapV1ToLegacyShape(generateEstimate(inputs));
    expect(mapped.results.tmBait.pricingKnobs.plan).toBe('quarterly');
    process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
    const staleAnnual = termiteLine(generateEstimate(inputs));
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    expect(staleAnnual.plan).toBe('annual_protection');
    const stored = { engineInputs: inputs, result: mapped, engineResult: { lineItems: [staleAnnual] } };
    process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
    try {
      const replayInput = extractEngineInputs(stored);
      expect(replayInput.termitePricingKnobs.plan).toBe('quarterly');
      const replayed = termiteLine(generateEstimate(replayInput));
      expect(replayed).toMatchObject({ plan: 'quarterly', visitsPerYear: 4, annual: 288 });
      expect(replayed.installation).toMatchObject({ kind: 'install', price: 653 });
    } finally {
      delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    }
  });

  test('a mapped termite result without a plan stamp cannot inherit stale raw annual provenance', () => {
    process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
    const inputs = HOME(2000, { services: { termite: { system: 'trelona', plan: 'annual_protection' } } });
    const staleAnnual = termiteLine(generateEstimate(inputs));
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    const stored = {
      engineInputs: inputs,
      result: { results: { tmBait: { sta: 15, ti: 653, system: 'trelona' } } },
      engineResult: { lineItems: [staleAnnual] },
    };
    const knobs = replay.termiteKnobSignalForReplay(stored);
    expect(knobs?.plan).not.toBe('annual_protection');
    expect(termiteLine(generateEstimate({ ...inputs, termitePricingKnobs: knobs })).plan).toBe('quarterly');
  });

  test('the admin quick-quote sandbox strips the same stamp — gate off, no annual-plan pricing', async () => {
    delete process.env.GATE_TERMITE_ANNUAL_PLAN;
    const handler = adminPricingConfigRouter.stack
      .find((layer) => layer.route?.path === '/quick-quote' && layer.route.methods.post).route.stack[0].handle;
    const body = {
      homeSqFt: 2400, lotSqFt: 9000,
      termitePricingKnobs: { plan: 'annual_protection', setupPerStation: 30 },
      services: { termite: { plan: 'annual_protection' } },
    };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    const next = jest.fn();
    await handler({ body }, res, next);
    expect(next).not.toHaveBeenCalled();
    const { quote } = res.json.mock.calls[0][0];
    const termite = quote.services.find((sv) => sv.name === 'termite_bait');
    expect(termite).toBeTruthy();
    // Quarterly program: monitoring is billed per application (monthly figure present),
    // and the quote's annual is the 4-visit program, not the $249+ plan ladder.
    const quarterly = generateEstimate({ homeSqFt: 2400, lotSqFt: 9000, services: { termite: {} } });
    expect(quote.annual).toBe(quarterly.summary.recurringAnnualAfterDiscount);
    expect(termiteLine(quarterly).plan).toBe('quarterly');
  });
});
