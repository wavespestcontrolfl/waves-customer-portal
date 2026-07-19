process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.schema = { hasTable: jest.fn().mockResolvedValue(false) };
  return db;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const express = require('express');
const {
  generateEstimate,
  priceBedBugTreatment,
} = require('../services/pricing-engine');
const { GLOBAL } = require('../services/pricing-engine/constants');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const pricingConfigRouter = require('../routes/admin-pricing-config');
const {
  buildPricingBundle,
  normalizeOneTimeBreakdown,
  resolveEstimateQuoteRequirement,
} = require('../routes/estimate-public');

const validChemical = {
  rooms: 1,
  method: 'CHEMICAL',
  severity: 'light',
  prepStatus: 'ready',
  occupancyType: 'singleFamily',
};

const validHeat = {
  rooms: 1,
  method: 'HEAT',
  severity: 'light',
  prepStatus: 'ready',
  occupancyType: 'singleFamily',
  equipment: 'INHOUSE',
  heatScope: 'ROOMS_ONLY',
};

const validHybrid = {
  ...validHeat,
  method: 'HYBRID',
};

function estimateInput(bedBug, overrides = {}) {
  return {
    homeSqFt: 1000,
    stories: 1,
    lotSqFt: 10000,
    propertyType: 'single_family',
    zone: 'A',
    features: {},
    services: { bedBug },
    ...overrides,
  };
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/pricing-config', pricingConfigRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message, code: err.code });
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

describe('bed bug specialty pricing', () => {
  describe('validation', () => {
    test('missing options throws', () => {
      expect(() => priceBedBugTreatment({})).toThrow(/options are required/i);
    });

    test('missing method throws', () => {
      const { method, ...opts } = validChemical;
      expect(() => priceBedBugTreatment({}, opts)).toThrow(/method is required/i);
    });

    test('pricing validation errors are operational 400s', () => {
      try {
        priceBedBugTreatment({}, { ...validChemical, method: 'BOTH' });
        throw new Error('expected pricing validation to throw');
      } catch (err) {
        expect(err.name).toBe('PricingError');
        expect(err.status).toBe(400);
        expect(err.statusCode).toBe(400);
        expect(err.isOperational).toBe(true);
      }
    });

    test.each(['SPRAY', 'BOTH', 'chemical'])('invalid method %s throws', (method) => {
      expect(() => priceBedBugTreatment({}, { ...validChemical, method })).toThrow(/method|BOTH/);
    });

    test('missing rooms throws', () => {
      const { rooms, ...opts } = validChemical;
      expect(() => priceBedBugTreatment({}, opts)).toThrow(/rooms is required/i);
    });

    test.each([0, -1, 1.5, '2', 'abc'])('invalid rooms %p throws', (rooms) => {
      expect(() => priceBedBugTreatment({}, { ...validChemical, rooms })).toThrow(/rooms.*positive integer/i);
    });

    test('missing severity throws', () => {
      const { severity, ...opts } = validChemical;
      expect(() => priceBedBugTreatment({}, opts)).toThrow(/severity is required/i);
    });

    test('invalid severity throws', () => {
      expect(() => priceBedBugTreatment({}, { ...validChemical, severity: 'extreme' })).toThrow(/severity must be one of/i);
    });

    test('missing prepStatus throws', () => {
      const { prepStatus, ...opts } = validChemical;
      expect(() => priceBedBugTreatment({}, opts)).toThrow(/prepStatus is required/i);
    });

    test('invalid prepStatus throws', () => {
      expect(() => priceBedBugTreatment({}, { ...validChemical, prepStatus: 'unknown' })).toThrow(/prepStatus must be one of/i);
    });

    test('missing occupancyType throws', () => {
      const { occupancyType, ...opts } = validChemical;
      expect(() => priceBedBugTreatment({}, opts)).toThrow(/occupancyType is required/i);
    });

    test('invalid occupancyType throws', () => {
      expect(() => priceBedBugTreatment({}, { ...validChemical, occupancyType: 'warehouse' })).toThrow(/occupancyType must be one of/i);
    });

    test.each([0, -1, 1.5, '2'])('invalid stories %p throws', (stories) => {
      expect(() => priceBedBugTreatment({}, { ...validChemical, stories })).toThrow(/stories.*positive integer/i);
    });

    test.each([0, -1, 'abc'])('invalid footprint %p throws', (footprint) => {
      expect(() => priceBedBugTreatment({}, { ...validChemical, footprint })).toThrow(/footprint.*positive number/i);
    });

    test('CHEMICAL ignores irrelevant property heat area strings', () => {
      expect(() => priceBedBugTreatment({ homeSqFt: '1000' }, validChemical)).not.toThrow();
    });

    test('HEAT without equipment throws', () => {
      const { equipment, ...opts } = validHeat;
      expect(() => priceBedBugTreatment({}, opts)).toThrow(/equipment is required/i);
    });

    test('HYBRID without equipment throws', () => {
      const { equipment, ...opts } = validHybrid;
      expect(() => priceBedBugTreatment({}, opts)).toThrow(/equipment is required/i);
    });

    test.each(['RENTAL', 'inhouse'])('invalid equipment %s throws', (equipment) => {
      expect(() => priceBedBugTreatment({}, { ...validHeat, equipment })).toThrow(/equipment must be one of/i);
    });

    test('SUBCONTRACT without subcontractCost throws', () => {
      expect(() => priceBedBugTreatment({}, { ...validHeat, equipment: 'SUBCONTRACT' })).toThrow(/subcontractCost is required/i);
    });

    test.each([0, -1, 'abc'])('invalid subcontractCost %p throws', (subcontractCost) => {
      expect(() => priceBedBugTreatment({}, {
        ...validHeat,
        equipment: 'SUBCONTRACT',
        subcontractCost,
      })).toThrow(/subcontractCost.*positive number/i);
    });

    test('heatScope missing for HEAT throws', () => {
      const { heatScope, ...opts } = validHeat;
      expect(() => priceBedBugTreatment({}, opts)).toThrow(/heatScope is required/i);
    });

    test('heatScope missing for HYBRID throws', () => {
      const { heatScope, ...opts } = validHybrid;
      expect(() => priceBedBugTreatment({}, opts)).toThrow(/heatScope is required/i);
    });

    test('invalid heatScope throws', () => {
      expect(() => priceBedBugTreatment({}, { ...validHeat, heatScope: 'rooms_only' })).toThrow(/heatScope must be one of/i);
    });

    test('WHOLE_HOME heat without footprint throws', () => {
      expect(() => priceBedBugTreatment({}, { ...validHeat, heatScope: 'WHOLE_HOME' })).toThrow(/footprint is required/i);
    });

    test('severe heat returns quote before requiring subcontract vendor cost', () => {
      const result = priceBedBugTreatment({}, {
        ...validHeat,
        severity: 'severe',
        equipment: 'SUBCONTRACT',
      });
      expect(result.quoteRequired).toBe(true);
      expect(result.reason).toBe('SEVERE_INFESTATION');
    });

    test('prep refused whole-home heat returns quote before requiring footprint', () => {
      const result = priceBedBugTreatment({}, {
        ...validHeat,
        prepStatus: 'refused',
        heatScope: 'WHOLE_HOME',
      });
      expect(result.quoteRequired).toBe(true);
      expect(result.reason).toBe('PREP_REFUSED');
    });

    test('derived zero footprint is treated as missing for optional footprint paths', () => {
      const chemical = generateEstimate(estimateInput(validChemical, { homeSqFt: 0 }));
      const chemicalLine = chemical.lineItems.find(i => i.service === 'bed_bug');
      expect(chemicalLine.price).toBe(449);
      expect(chemicalLine.multipliers.footprint).toBe(1);

      const heat = generateEstimate(estimateInput(validHeat, { homeSqFt: 0 }));
      const heatLine = heat.lineItems.find(i => i.service === 'bed_bug');
      expect(heatLine.price).toBe(1150);
      expect(heatLine.multipliers.footprint).toBe(1);
    });

    test('equipment supplied for CHEMICAL is ignored with warning', () => {
      const result = priceBedBugTreatment({}, {
        ...validChemical,
        equipment: 'SUBCONTRACT',
        subcontractCost: 'abc',
      });
      expect(result.equipment).toBeUndefined();
      expect(result.warnings).toContain('Equipment was supplied for CHEMICAL bed bug pricing and was ignored.');
      expect(result.warnings).toContain('subcontractCost was supplied for non-subcontract bed bug pricing and was ignored.');
    });

    test('stale SUBCONTRACT equipment without vendor cost is ignored for CHEMICAL', () => {
      const result = priceBedBugTreatment({}, {
        ...validChemical,
        equipment: 'SUBCONTRACT',
      });
      expect(result.equipment).toBeUndefined();
      expect(result.price).toBe(449);
      expect(result.warnings).toContain('Equipment was supplied for CHEMICAL bed bug pricing and was ignored.');
    });

    test('stale subcontractCost is ignored for INHOUSE heat', () => {
      const result = priceBedBugTreatment({}, {
        ...validHeat,
        equipment: 'INHOUSE',
        subcontractCost: 'abc',
      });
      expect(result.equipment).toBe('INHOUSE');
      expect(result.price).toBe(1150);
      expect(result.warnings).toContain('subcontractCost was supplied for non-subcontract bed bug pricing and was ignored.');
    });
  });

  describe('chemical pricing', () => {
    test('CHEMICAL 1 room light/ready/single-family uses 2 visits and cost-ratio base', () => {
      const result = priceBedBugTreatment({}, validChemical);
      expect(result.treatmentLines[0].includedVisits).toBe(2);
      expect(result.protocol).toEqual(expect.objectContaining({
        programType: 'IPM',
        includedVisits: 2,
        followUpDays: 14,
        requiresPrepChecklist: true,
        requiresFollowUpMonitoring: true,
      }));
      expect(result.directCostEstimate).toBeCloseTo(157.30, 2);
      expect(result.basePrice).toBeCloseTo(449.42, 2);
      expect(result.price).toBe(449);
      expect(result.recurringDiscountApplied).toBe(0);
      expect(result.costRatio).toBe(0.35);
    });

    test('CHEMICAL direct cost follows synced global labor and drive settings', () => {
      const originalLaborRate = GLOBAL.LABOR_RATE;
      const originalDriveTime = GLOBAL.DRIVE_TIME;
      try {
        GLOBAL.LABOR_RATE = 70;
        GLOBAL.DRIVE_TIME = 30;
        const result = priceBedBugTreatment({}, validChemical);
        expect(result.directCostEstimate).toBeCloseTo(262.30, 2);
        expect(result.basePrice).toBeCloseTo(749.42, 2);
        expect(result.price).toBe(749);
      } finally {
        GLOBAL.LABOR_RATE = originalLaborRate;
        GLOBAL.DRIVE_TIME = originalDriveTime;
      }
    });

    test('CHEMICAL 2 rooms costs more than 1 room', () => {
      const one = priceBedBugTreatment({}, validChemical);
      const two = priceBedBugTreatment({}, { ...validChemical, rooms: 2 });
      expect(two.treatmentLines[0].includedVisits).toBe(2);
      expect(two.price).toBeGreaterThan(one.price);
    });

    test('moderate includes 3 visits and costs more than light', () => {
      const light = priceBedBugTreatment({}, validChemical);
      const moderate = priceBedBugTreatment({}, { ...validChemical, severity: 'moderate' });
      expect(moderate.includedVisits).toBe(3);
      expect(moderate.price).toBeGreaterThan(light.price);
    });

    test('heavy includes 3 visits and costs more than moderate', () => {
      const moderate = priceBedBugTreatment({}, { ...validChemical, severity: 'moderate' });
      const heavy = priceBedBugTreatment({}, { ...validChemical, severity: 'heavy' });
      expect(heavy.includedVisits).toBe(3);
      expect(heavy.price).toBeGreaterThan(moderate.price);
    });

    test('severe requires quote', () => {
      const result = priceBedBugTreatment({}, { ...validChemical, severity: 'severe' });
      expect(result.quoteRequired).toBe(true);
      expect(result.reason).toBe('SEVERE_INFESTATION');
    });

    test('footprint > 1800 applies 1.05 chemical multiplier', () => {
      const result = priceBedBugTreatment({ footprint: 2000 }, validChemical);
      expect(result.multipliers.footprint).toBe(1.05);
    });

    test('footprint > 2500 applies 1.10 chemical multiplier and is not cumulative', () => {
      const result = priceBedBugTreatment({ footprint: 2600 }, validChemical);
      expect(result.multipliers.footprint).toBe(1.10);
    });

    test('partial prep applies 1.15 multiplier', () => {
      const result = priceBedBugTreatment({}, { ...validChemical, prepStatus: 'partial' });
      expect(result.multipliers.prep).toBe(1.15);
    });

    test('poor prep applies 1.30 multiplier and warning', () => {
      const result = priceBedBugTreatment({}, { ...validChemical, prepStatus: 'poor' });
      expect(result.multipliers.prep).toBe(1.30);
      expect(result.warnings).toContain('Poor prep materially increases failure/callback risk.');
      expect(result.treatmentLines[0].warnings).toContain('Poor prep materially increases failure/callback risk.');
    });

    test('prep refused requires quote', () => {
      const result = priceBedBugTreatment({}, { ...validChemical, prepStatus: 'refused' });
      expect(result.quoteRequired).toBe(true);
      expect(result.reason).toBe('PREP_REFUSED');
    });

    test('apartment applies 1.15 occupancy multiplier', () => {
      const result = priceBedBugTreatment({}, { ...validChemical, occupancyType: 'apartment' });
      expect(result.multipliers.occupancy).toBe(1.15);
    });

    test('emergencyAfterHours urgency applies after other modifiers', () => {
      const result = priceBedBugTreatment({}, { ...validChemical, urgency: 'emergencyAfterHours' });
      expect(result.multipliers.urgency).toBe(2);
      expect(result.price).toBe(round(449.42 * 2));
    });
  });

  describe('heat pricing', () => {
    test('HEAT 1 room INHOUSE ROOMS_ONLY uses $1150 base and post-inspection', () => {
      const result = priceBedBugTreatment({}, validHeat);
      expect(result.roomRate).toBe(1000);
      expect(result.equipmentFee).toBe(150);
      expect(result.basePrice).toBe(1150);
      expect(result.includedTreatmentEvents).toBe(1);
      expect(result.includePostInspection).toBe(true);
    });

    test('HEAT 2 rooms INHOUSE base is $1925', () => {
      const result = priceBedBugTreatment({}, { ...validHeat, rooms: 2 });
      expect(result.roomRate).toBe(850);
      expect(result.equipmentFee).toBe(225);
      expect(result.basePrice).toBe(1925);
    });

    test('HEAT 3 rooms INHOUSE base is $2550', () => {
      const result = priceBedBugTreatment({}, { ...validHeat, rooms: 3 });
      expect(result.roomRate).toBe(750);
      expect(result.equipmentFee).toBe(300);
      expect(result.basePrice).toBe(2550);
    });

    test('HEAT SUBCONTRACT uses max of room, marked-up vendor, and minimum', () => {
      const result = priceBedBugTreatment({}, {
        ...validHeat,
        rooms: 2,
        equipment: 'SUBCONTRACT',
        subcontractCost: 2200,
      });
      expect(result.vendorBasedPrice).toBe(2750);
      expect(result.basePrice).toBe(2750);
    });

    test('HEAT WHOLE_HOME uses max room-based and sqft floor', () => {
      const result = priceBedBugTreatment({ footprint: 2500 }, {
        ...validHeat,
        heatScope: 'WHOLE_HOME',
      });
      expect(result.sqftBasedPrice).toBe(5000);
      expect(result.basePrice).toBe(5000);
    });

    test('HEAT WHOLE_HOME uses full home area instead of footprint when available', () => {
      const result = priceBedBugTreatment({ homeSqFt: 3000, footprint: 1500, stories: 2 }, {
        ...validHeat,
        heatScope: 'WHOLE_HOME',
      });
      expect(result.heatAreaSqFt).toBe(3000);
      expect(result.sqftBasedPrice).toBe(6000);
      expect(result.basePrice).toBe(6000);
      expect(result.multipliers.stories).toBe(1.05);
      expect(result.price).toBe(6300);
    });

    test('HEAT protocol fields are returned', () => {
      const result = priceBedBugTreatment({}, validHeat);
      expect(result.protocol).toEqual(expect.objectContaining({
        requiredMinimumTempF: 120,
        minimumHoldTimeMinutes: 90,
        activeMonitoringRequired: true,
        minSensors: 5,
        requiresPrepChecklist: true,
        requiresHeatSensitiveItemPlan: true,
      }));
    });

    test('HEAT has no recurring discount', () => {
      const result = priceBedBugTreatment({}, validHeat);
      expect(result.recurringDiscountEligible).toBe(false);
      expect(result.recurringDiscountApplied).toBe(0);
    });
  });

  describe('hybrid pricing', () => {
    test('HYBRID must be explicit and invalid method does not emit heat plus chemical', () => {
      expect(() => priceBedBugTreatment({}, { ...validHybrid, method: 'BOTH' })).toThrow(/BOTH is invalid/);
      expect(() => generateEstimate(estimateInput({ ...validHybrid, method: 'BOTH' }))).toThrow(/BOTH is invalid/);
    });

    test('HYBRID includes heat event and residual add-on but no full chemical line', () => {
      const result = priceBedBugTreatment({}, validHybrid);
      expect(result.heatEvent).toBe(true);
      expect(result.residualApplication).toBe(true);
      expect(result.treatmentLines).toHaveLength(1);
      expect(result.treatmentLines[0].label).toMatch(/Hybrid/);
      expect(result.treatmentLines[0].label).not.toMatch(/Chemical\/IPM/);
    });

    test('HYBRID residual add-on is 175 plus 75 per room', () => {
      const result = priceBedBugTreatment({}, { ...validHybrid, rooms: 3 });
      expect(result.residualAddOnBase).toBe(400);
      expect(result.heatBasePrice).toBe(2550);
      expect(result.basePrice).toBe(2950);
    });

    test('HYBRID applies common modifiers once', () => {
      const result = priceBedBugTreatment({}, {
        ...validHybrid,
        severity: 'moderate',
        urgency: 'soon',
      });
      expect(result.basePrice).toBe(1400);
      expect(result.price).toBe(round(1400 * 1.15 * 1.25));
    });

    test('HYBRID includes heat and hybrid warnings', () => {
      const result = priceBedBugTreatment({}, validHybrid);
      expect(result.warnings).toContain('Heat treatment has no residual effect.');
      expect(result.warnings).toContain('Hybrid must be explicitly selected.');
      expect(result.note).toMatch(/not a duplicate full chemical program/);
      expect(result.protocol).toEqual(expect.objectContaining({
        heatEvent: true,
        residualApplication: true,
        residualApplicationType: 'targeted',
        requiresHeatSensitiveItemPlan: true,
        requiresPrepChecklist: true,
      }));
    });

    test('HYBRID has no recurring discount', () => {
      const result = priceBedBugTreatment({}, validHybrid);
      expect(result.recurringDiscountEligible).toBe(false);
      expect(result.recurringDiscountApplied).toBe(0);
    });
  });

  describe('estimate and route integration', () => {
    test.each([
      ['CHEMICAL', validChemical],
      ['HEAT', validHeat],
      ['HYBRID', validHybrid],
    ])('recurring-customer add-on discount does not apply to %s', (_method, bedBug) => {
      const estimate = generateEstimate(estimateInput(bedBug, { isRecurringCustomer: true }));
      const line = estimate.lineItems.find(i => i.service === 'bed_bug');
      expect(line.priceAfterDiscount).toBe(line.price);
      expect(line.recurringDiscountApplied).toBe(0);
      expect(line.discount.appliedDiscounts).toEqual([]);
    });

    test.each([
      ['CHEMICAL', validChemical],
      ['HEAT', validHeat],
      ['HYBRID', validHybrid],
    ])('urgency applies to %s', (_method, bedBug) => {
      const standard = priceBedBugTreatment({}, bedBug);
      const urgent = priceBedBugTreatment({}, { ...bedBug, urgency: 'emergency' });
      expect(urgent.multipliers.urgency).toBe(1.5);
      expect(urgent.price).toBeGreaterThan(standard.price);
    });

    test.each([
      ['CHEMICAL', validChemical],
      ['HEAT', validHeat],
      ['HYBRID', validHybrid],
    ])('POST /admin/pricing-config/estimate emits bed bug line for %s', async (_method, bedBug) => {
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/admin/pricing-config/estimate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(estimateInput(bedBug)),
        });
        const body = await res.json();
        expect(res.status).toBe(200);
        const line = body.estimate.lineItems.find(i => i.service === 'bed_bug');
        expect(line.service).toBe('bed_bug');
        expect(line.method).toBe(bedBug.method);
        expect(line.rooms).toBe(bedBug.rooms);
        expect(line.quoteRequired).toBe(false);
        expect(typeof line.price).toBe('number');
        expect(Array.isArray(line.treatmentLines)).toBe(true);
      });
    });

    test('server estimate shape hides internal cost and margin fields unless debug requested', () => {
      const publicEstimate = generateEstimate(estimateInput(validChemical));
      const publicLine = publicEstimate.lineItems.find(i => i.service === 'bed_bug');
      expect(publicLine.directCostEstimate).toBeUndefined();
      expect(publicLine.estimatedGrossMargin).toBeUndefined();
      expect(publicLine.treatmentLines[0].directCostEstimate).toBeUndefined();

      const debugEstimate = generateEstimate(estimateInput({
        ...validChemical,
        includeInternalPricing: true,
      }));
      const debugLine = debugEstimate.lineItems.find(i => i.service === 'bed_bug');
      expect(debugLine.directCostEstimate).toBeCloseTo(157.30, 2);
      expect(debugLine.treatmentLines[0].estimatedGrossMargin).toBeDefined();
    });

    test('quote-required bed bug maps as quote required instead of a $0 line', async () => {
      const estimate = generateEstimate(estimateInput({ ...validChemical, severity: 'severe' }));
      const line = estimate.lineItems.find(i => i.service === 'bed_bug');
      expect(line.quoteRequired).toBe(true);
      expect(line.label).toMatch(/Quote Required/);

      const mapped = mapV1ToLegacyShape(estimate);
      const spec = mapped.specItems.find(i => i.service === 'bed_bug');
      expect(spec.quoteRequired).toBe(true);
      expect(spec.name).toMatch(/Quote Required/);
      expect(spec.price).toBeNull();
      const oneTimeSpec = mapped.oneTime.specItems.find(i => i.service === 'bed_bug');
      expect(oneTimeSpec.quoteRequired).toBe(true);
      expect(oneTimeSpec.price).toBeNull();
      const publicBreakdown = normalizeOneTimeBreakdown({ result: mapped });
      const publicRow = publicBreakdown.items.find(i => i.service === 'bed_bug');
      expect(publicRow.quoteRequired).toBe(true);
      expect(publicRow.kind).toBe('quote_required');
      expect(publicRow.amount).toBeNull();
      expect(publicBreakdown.quoteRequired).toBe(true);
      expect(publicBreakdown.quoteRequiredItems).toContainEqual(expect.objectContaining({
        service: 'bed_bug',
        reason: 'SEVERE_INFESTATION',
      }));
      expect(publicBreakdown.total).toBe(0);
      expect(mapped.oneTime.total).toBe(0);

      const pricingBundle = await buildPricingBundle({
        id: 'bed-bug-quote-required-bundle-test',
        estimate_data: { result: mapped },
        onetime_total: 0,
        waveguard_tier: 'Bronze',
      });
      expect(pricingBundle.quoteRequired).toBe(true);
      expect(resolveEstimateQuoteRequirement(pricingBundle).quoteRequired).toBe(true);
    });

    test('HYBRID server estimate emits one bed bug line and no duplicate heat/chemical lines', () => {
      const estimate = generateEstimate(estimateInput(validHybrid));
      expect(estimate.lineItems.filter(i => i.service === 'bed_bug')).toHaveLength(1);
      expect(estimate.lineItems.find(i => i.service === 'bed_bug_heat')).toBeUndefined();
      expect(estimate.lineItems.find(i => i.service === 'bed_bug_chemical')).toBeUndefined();
    });
  });
});

function round(value) {
  return Math.round(value);
}
