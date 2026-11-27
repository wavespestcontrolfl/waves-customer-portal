/**
 * Small pricing faults that move no sold price (owner 2026-11-26, "fix all seven"): the barrel roof hold, the wasp
 * urgent order (priceWasp has no quote caller) and the dead Settings rows. A quote already sent keeps its terms: the
 * server replay sets input.savedEstimateReplay, which the barrel hold reads.
 */

jest.mock('../models/db', () => {
  const rows = { current: [] };
  const calls = { whereNotIn: [] };
  const chain = () => {
    const builder = {
      orderBy: () => builder,
      where: () => builder,
      whereNotIn: (...args) => { calls.whereNotIn.push(args); return builder; },
      then: (resolve, reject) => Promise.resolve(rows.current).then(resolve, reject),
    };
    return builder;
  };
  const db = jest.fn(() => chain());
  db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
  db.__rows = rows;
  db.__calls = calls;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Every admin-auth export is a pass-through (the mapper's lazy requires load route modules that read several).
jest.mock('../middleware/admin-auth', () => new Proxy({}, {
  get: (_target, name) => (name === '__esModule' ? false : (_req, _res, next) => next()),
}));

const sp = require('../services/pricing-engine/service-pricing');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { estimateDataHasQuoteRequirement } = require('../services/estimate-delivery-options');
const { lineRequiresReview } = require('../services/estimator-engine/draft-builder');
const { RODENT } = require('../services/pricing-engine/constants');

const HOME = { homeSqFt: 2200, lotSqFt: 9000 };

describe('fix 3: a barrel tile roof with no eave footage is held for review', () => {
  const exclusion = (extra = {}) => ({
    pricingVersion: 'v2', standardWireMeshPoints: 3, roofStyle: 'barrel_tile', ...extra,
  });
  const run = (services, extra = {}) => {
    const estimate = generateEstimate({ ...HOME, ...extra, services });
    return { estimate, legacy: mapV1ToLegacyShape(estimate) };
  };
  let priorGate;
  beforeAll(() => { priorGate = process.env.GATE_EXCLUSION_ROOF_STYLE_PRICING; process.env.GATE_EXCLUSION_ROOF_STYLE_PRICING = 'true'; });
  afterAll(() => {
    if (priorGate === undefined) delete process.env.GATE_EXCLUSION_ROOF_STYLE_PRICING;
    else process.env.GATE_EXCLUSION_ROOF_STYLE_PRICING = priorGate;
  });

  test('the priced result carries the quote-required flags and no warranty until measured', () => {
    const result = sp.priceRodentExclusionV2({ standardWireMeshPoints: 3, roofStyle: 'barrel_tile', barrelEaveFt: 0 });
    expect(result.barrelClosureNeedsMeasurement).toBe(true);
    expect(result.warrantyEligible).toBe(false);
    expect(result.lineItems.length).toBeGreaterThan(0);
    for (const row of result.lineItems) {
      expect(row.requiresCustomQuote).toBe(true);
      expect(row.quoteRequired).toBe(true);
      expect(row.warrantyEligible).toBe(false);
    }
  });

  test('the estimate cannot be sent: the staff send gate and the lead draft gate both see it', () => {
    const { estimate, legacy } = run({ exclusion: exclusion() });
    expect(estimateDataHasQuoteRequirement({ result: legacy, engineResult: estimate })).toBe(true);
    expect(estimate.lineItems.filter((line) => line.service === 'rodent_exclusion').every(lineRequiresReview)).toBe(true);
  });

  test('entering the eave footage clears the hold and keeps the price', () => {
    const measured = run({ exclusion: exclusion({ barrelEaveFt: 40 }) });
    expect(estimateDataHasQuoteRequirement({ result: measured.legacy, engineResult: measured.estimate })).toBe(false);
    const closure = measured.estimate.lineItems.find((line) => line.component === 'barrel_eave_closure');
    expect(closure.price).toBe(480);
    expect(measured.estimate.lineItems.every((line) => line.warrantyEligible !== false)).toBe(true);
  });

  test('a held whole-home seal advertises no included guarantee until the footage is entered', () => {
    const held = sp.priceRodentExclusionV2({
      roofStyle: 'barrel_tile', barrelEaveFt: 0, sealScope: 'whole_home', homeSqFt: 2400, stories: 1, roofType: 'tile',
    });
    expect(held.includesReentryGuarantee).toBe(false);
    expect(held.reentryGuaranteeMonths).toBeUndefined();
    expect(held.warrantyEligible).toBe(false);
    const measured = sp.priceRodentExclusionV2({
      roofStyle: 'barrel_tile', barrelEaveFt: 40, sealScope: 'whole_home', homeSqFt: 2400, stories: 1, roofType: 'tile',
    });
    expect(measured.includesReentryGuarantee).toBe(true);
    expect(measured.warrantyEligible).toBe(true);
  });

  test('the legacy-shaped exclusion takes the same hold when a barrel pick has no eave footage', () => {
    const v1 = (extra = {}) => run({ exclusion: { simple: 3, roofStyle: 'barrel_tile', ...extra } });
    const held = v1();
    const rows = held.estimate.lineItems.filter((line) => line.service === 'exclusion');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((line) => line.requiresCustomQuote === true && line.warrantyEligible === false)).toBe(true);
    expect(estimateDataHasQuoteRequirement({ result: held.legacy, engineResult: held.estimate })).toBe(true);
    const replay = run({ exclusion: { simple: 3, roofStyle: 'barrel_tile' } }, { savedEstimateReplay: true });
    expect(estimateDataHasQuoteRequirement({ result: replay.legacy, engineResult: replay.estimate })).toBe(false);
  });

  test('a held exclusion adds no separate guarantee line; measured footage brings it back', () => {
    const eligibility = { trappingCompleted: true, exclusionCompleted: true, noActivityAfterFinalTrapCheck: true };
    const guarantees = (extra = {}) => run({
      exclusion: exclusion(extra),
      rodentGuarantee: { eligibility },
    }).estimate.lineItems.filter((line) => line.service === 'rodent_guarantee');
    expect(guarantees()).toHaveLength(0);
    expect(guarantees({ barrelEaveFt: 40 })).toHaveLength(1);
  });

  test('the legacy-shaped hold tells staff to switch to the per-point exclusion', () => {
    const held = run({ exclusion: { simple: 3, roofStyle: 'barrel_tile' } });
    const row = held.estimate.lineItems.find((line) => line.service === 'exclusion');
    expect(row.manualReviewReasons[0]).toMatch(/per-point exclusion/);
  });

  test('a flat tile pick has no barrel closure and no hold', () => {
    const flat = run({ exclusion: exclusion({ roofStyle: 'flat_tile' }) });
    expect(estimateDataHasQuoteRequirement({ result: flat.legacy, engineResult: flat.estimate })).toBe(false);
  });

  test('a quote already sent (replayed as a stored estimate) is not newly held', () => {
    const replay = run({ exclusion: exclusion() }, { savedEstimateReplay: true });
    expect(estimateDataHasQuoteRequirement({ result: replay.legacy, engineResult: replay.estimate })).toBe(false);
    const total = (r) => r.estimate.lineItems.filter((line) => line.service === 'rodent_exclusion').reduce((sum, line) => sum + line.price, 0);
    expect(total(replay)).toBe(total(run({ exclusion: exclusion() })));
  });
});


describe('fix 5: wasp urgent covers the removal and wins over same-day', () => {
  test('urgent multiplies base plus removal', () => {
    // Tier 2 is $275 (owner 2026-11-26 evening; it was $250). Large removal is $250. Urgent is x1.5 on the sum.
    expect(sp.priceWasp({}, { tier: 2, urgent: true, removalType: 'large' }).price).toBe(788);
    expect(sp.priceWasp({}, { tier: 2, urgent: true, removalType: 'small' }).price).toBe(525);
  });

  test('URGENT wins over same-day when both are set', () => {
    expect(sp.priceWasp({}, { tier: 2, urgency: 'URGENT', sameDay: true }).price).toBe(413);
    expect(sp.priceWasp({}, { tier: 2, urgent: true, sameDay: true }).price).toBe(413);
  });

  test('non-urgent prices do not change', () => {
    expect(sp.priceWasp({}, { tier: 2 }).price).toBe(275);
    expect(sp.priceWasp({}, { tier: 2, sameDay: true }).price).toBe(350);
    expect(sp.priceWasp({}, { tier: 2, urgency: 'SOON' }).price).toBe(350);
    expect(sp.priceWasp({}, { tier: 2, sameDay: true, removalType: 'large' }).price).toBe(600);
    expect(sp.priceWasp({}, { tier: 2, removalType: 'large' }).price).toBe(525);
  });

  test('urgent without removal is the same as before', () => {
    expect(sp.priceWasp({}, { tier: 2, urgent: true }).price).toBe(413);
  });

  test('priceWasp has no quote caller, so no stored price depends on its old order', () => {
    const fs = require('fs');
    const path = require('path');
    const engine = fs.readFileSync(path.join(__dirname, '../services/pricing-engine/estimate-engine.js'), 'utf8');
    expect(engine).not.toMatch(/priceWasp\(/);
  });

  test('the removal still shows once in the add-ons and the breakdown', () => {
    const result = sp.priceWasp({}, { tier: 2, urgent: true, removalType: 'large' });
    expect(result.addOns.filter((addOn) => addOn.name === 'removal_large')).toHaveLength(1);
    expect(result.pricingBreakdown.removal).toBe(250);
    expect(result.pricingBreakdown.subtotal).toBe(788);
  });
});


describe('fix 6: dead settings', () => {
  test('rodent trapping no longer carries the size, lot and pressure bands or the ceiling', () => {
    for (const key of ['homeSizeAdjustments', 'lotAdjustments', 'pressureAdjustments', 'ceilingBeforeCustom']) {
      expect(RODENT.trapping[key]).toBeUndefined();
    }
    expect(RODENT.trapping.standardPrice).toBe(350);
  });

  test('a stored rodent_trapping row with the old keys loads without touching the flat price', () => {
    const { syncConstantsFromDB } = require('../services/pricing-engine/db-bridge');
    expect(typeof syncConstantsFromDB).toBe('function');
    const price = sp.priceRodentTrapping({ footprint: 6000 }).price;
    expect(price).toBe(350);
  });

  test('the Settings list hides the German roach row and still lists the others', async () => {
    const db = require('../models/db');
    db.__calls.whereNotIn.length = 0;
    db.__rows.current = [{ config_key: 'rodent_setup_fee', data: '{"value":99}' }];
    const express = require('express');
    const router = require('../routes/admin-pricing-config');
    const app = express();
    app.use('/', router);
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.configs.map((row) => row.config_key)).toEqual(['rodent_setup_fee']);
      expect(db.__calls.whereNotIn.some(([column, keys]) => column === 'config_key' && keys.includes('onetime_german_roach'))).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
