/**
 * Mosquito misting system pricer (DRAFT constants, scope
 * ~/mosquito-misting-scope-20260924.md 4.3). Pure: no DB, no gate involved
 * (the gate sits in the estimate engine, see mosquito-misting-engine-gate.test.js).
 */
const { priceMosquitoMisting } = require('../services/pricing-engine/service-pricing');
const { MOSQUITO_MISTING, GLOBAL, WAVEGUARD } = require('../services/pricing-engine/constants');
const {
  isMistingSystemService,
  isMistingDesignConsultation,
} = require('../utils/mosquito-misting-system');

const PROPERTY = { homeSqFt: 2000, stories: 1, lotSqFt: 8000 };

describe('priceMosquitoMisting install price', () => {
  test('defaults to the smart tier at its included nozzle count', () => {
    const r = priceMosquitoMisting(PROPERTY);
    expect(r).toMatchObject({
      service: 'mosquito_misting',
      tier: 'smart',
      solution: 'standard',
      nozzles: 30,
      risers: 0,
      extraNozzles: 0,
      extraRisers: 0,
      quoteRequired: false,
      requiresManualReview: false,
      requiresMeasurement: false,
      manualReviewReasons: [],
      refillsBilledPerApplication: true,
      visitsPerYear: 12,
    });
    expect(r.installation.price).toBe(4195);
    expect(r.installation.retailValue).toBe(4195);
  });

  test('essential tier price', () => {
    const r = priceMosquitoMisting(PROPERTY, { tier: 'essential' });
    expect(r.tier).toBe('essential');
    expect(r.installation.price).toBe(2795);
  });

  test('extra nozzles add $75 each, whole dollars', () => {
    const r = priceMosquitoMisting(PROPERTY, { tier: 'essential', nozzles: 25 });
    expect(r.extraNozzles).toBe(15);
    expect(r.installation.price).toBe(2795 + 15 * 75);
    expect(Number.isInteger(r.installation.price)).toBe(true);
  });

  test('risers: none are included, each one adds $75', () => {
    expect(priceMosquitoMisting(PROPERTY, { risers: 0 }).installation.price).toBe(4195);
    const r = priceMosquitoMisting(PROPERTY, { risers: 14 });
    expect(r.extraRisers).toBe(14);
    expect(r.installation.price).toBe(4195 + 14 * 75);
  });

  test('install cost basis: hardware + overage + 2 techs x 6 hours of labor', () => {
    const r = priceMosquitoMisting(PROPERTY, { tier: 'smart', nozzles: 35, risers: 12 });
    const material = 2560 + 5 * 22 + 12 * 30;
    const labor = 2 * 6 * GLOBAL.LABOR_RATE;
    expect(r.installation.materialCost).toBe(material);
    expect(r.installation.laborCost).toBe(labor);
    expect(r.installation.totalCost).toBe(material + labor);
    const price = 4195 + 5 * 75 + 12 * 75;
    expect(r.installation.margin).toBe(Math.round(((price - material - labor) / price) * 1000) / 1000);
  });
});

describe('priceMosquitoMisting plan and refills', () => {
  test('plan is $59 a month, 12 visits, annual = monthly x 12', () => {
    const r = priceMosquitoMisting(PROPERTY);
    expect(r.monthly).toBe(59);
    // The customer reads the plan per application (12 monthly applications), never as a monthly total.
    expect(r.perApp).toBe(59);
    expect(r.perVisit).toBe(59);
    expect(r).not.toHaveProperty('refillsBilledPerVisit');
    expect(r.annual).toBe(708);
    expect(r.visitsPerYear).toBe(12);
  });

  test.each([
    ['standard', 129, 70],
    ['natural', 219, 95],
    ['premium', 319, 203],
  ])('%s refill: $%i per fill, product cost $%i', (solution, perFill, productCost) => {
    const r = priceMosquitoMisting(PROPERTY, { solution });
    expect(r.solution).toBe(solution);
    expect(r.refill).toMatchObject({
      solution,
      perFill,
      productCost,
      refillsPerYear: 4,
      annualEstimate: perFill * 4,
    });
    expect(r.refill.label).toBe(MOSQUITO_MISTING.refills[solution].label);
  });

  test('refills are NOT part of the plan annual, however many fills', () => {
    const few = priceMosquitoMisting(PROPERTY, { solution: 'premium', refillsPerYear: 1 });
    const many = priceMosquitoMisting(PROPERTY, { solution: 'premium', refillsPerYear: 8 });
    expect(few.annual).toBe(708);
    expect(many.annual).toBe(708);
    expect(many.refill.annualEstimate).toBe(319 * 8);
  });
});

describe('priceMosquitoMisting guards', () => {
  test('above the maximum nozzle count is a manual quote with no install price', () => {
    const r = priceMosquitoMisting(PROPERTY, { nozzles: 81 });
    expect(r.quoteRequired).toBe(true);
    expect(r.installation.price).toBeNull();
    expect(r.manualReviewReasons).toContain('mosquito_misting_oversize');
    expect(r.annual).toBeNull();
  });

  test('more risers than the maximum is a manual quote; a huge number never yields a non-finite figure', () => {
    for (const risers of [81, 1e308]) {
      const r = priceMosquitoMisting(PROPERTY, { risers });
      expect(r.quoteRequired).toBe(true);
      expect(r.installation.price).toBeNull();
      expect(r.manualReviewReasons).toContain('mosquito_misting_oversize_risers');
      expect(r.annual).toBeNull();
      expect(JSON.parse(JSON.stringify(r))).toEqual(expect.objectContaining({ risers: r.risers }));
      const numbers = JSON.stringify(r, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? '__NONFINITE__' : v));
      expect(numbers).not.toContain('__NONFINITE__');
    }
    expect(priceMosquitoMisting(PROPERTY, { risers: 80 }).quoteRequired).toBe(false);
    expect(priceMosquitoMisting(PROPERTY, { nozzles: 1e308 }).quoteRequired).toBe(true);
  });

  test('refills per year above the maximum fall back to the default with a reason', () => {
    for (const refillsPerYear of [25, 1e308, Infinity]) {
      const r = priceMosquitoMisting(PROPERTY, { refillsPerYear });
      expect(r.refill.refillsPerYear).toBe(4);
      expect(r.refill.annualEstimate).toBe(129 * 4);
      expect(r.manualReviewReasons).toContain('mosquito_misting_invalid_refills');
    }
    expect(priceMosquitoMisting(PROPERTY, { refillsPerYear: 24 }).manualReviewReasons).toEqual([]);
  });

  test('the maximum itself still prices', () => {
    const r = priceMosquitoMisting(PROPERTY, { nozzles: 80 });
    expect(r.quoteRequired).toBe(false);
    expect(r.installation.price).toBe(4195 + 50 * 75);
  });

  test('unknown tier falls back to smart and records a reason', () => {
    const r = priceMosquitoMisting(PROPERTY, { tier: 'deluxe' });
    expect(r.tier).toBe('smart');
    expect(r.installation.price).toBe(4195);
    expect(r.manualReviewReasons).toContain('mosquito_misting_unknown_tier');
    expect(r.requiresManualReview).toBe(true);
  });

  test('unknown solution falls back to standard and records a reason', () => {
    const r = priceMosquitoMisting(PROPERTY, { solution: 'bleach' });
    expect(r.solution).toBe('standard');
    expect(r.refill.perFill).toBe(129);
    expect(r.manualReviewReasons).toContain('mosquito_misting_unknown_solution');
  });

  test.each([[NaN], ['abc'], [5], [9]])('invalid or too-small nozzle count %p falls back with a reason', (nozzles) => {
    const r = priceMosquitoMisting(PROPERTY, { nozzles });
    expect(r.nozzles).toBe(30);
    expect(r.manualReviewReasons).toContain('mosquito_misting_invalid_nozzles');
    expect(r.quoteRequired).toBe(false);
  });
});

describe('priceMosquitoMisting pricingKnobs and policy', () => {
  test('stamps every constant the line was priced under', () => {
    const k = priceMosquitoMisting(PROPERTY, { tier: 'essential', solution: 'natural' }).pricingKnobs;
    expect(k).toMatchObject({
      tier: 'essential',
      tierPrice: 2795,
      hardwareCost: 1620,
      includedNozzles: 10,
      extraNozzlePrice: 75,
      extraNozzleCost: 22,
      includedRisers: 0,
      extraRiserPrice: 75,
      extraRiserCost: 30,
      installTechs: 2,
      installHours: 6,
      laborRate: GLOBAL.LABOR_RATE,
      minNozzles: 10,
      maxNozzles: 80,
      maxRisers: 80,
      maxRefillsPerYear: 24,
      planMonthly: 59,
      planVisitsPerYear: 12,
      laborMinutesPerVisit: 25,
      partsReservePerMonth: 10,
      refillSolution: 'natural',
      refillPrice: 219,
      refillProductCost: 95,
      defaultRefillsPerYear: 4,
      serviceCallNoPlan: 149,
    });
  });

  test('the line is not a WaveGuard tier service and takes no percent discount', () => {
    expect(WAVEGUARD.qualifyingServices).not.toContain('mosquito_misting');
    expect(WAVEGUARD.excludedFromPercentDiscount.mosquito_misting).toBe(true);
  });
});

describe('misting predicates', () => {
  test('the engine key counts as the misting system but is NOT the design consultation', () => {
    expect(isMistingSystemService({ serviceKey: 'mosquito_misting' })).toBe(true);
    expect(isMistingDesignConsultation({ serviceKey: 'mosquito_misting' })).toBe(false);
    expect(isMistingDesignConsultation({ serviceKey: 'mosquito_misting_system' })).toBe(true);
    expect(isMistingSystemService({ serviceKey: 'mosquito' })).toBe(false);
  });
});
