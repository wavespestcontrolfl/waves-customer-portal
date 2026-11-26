/**
 * Seven small pricing fixes (owner 2026-11-26, "fix all seven"). One describe per fix.
 * Every fix also pins that an estimate priced BEFORE the fixes keeps its price on replay. The replay readers derive
 * input.legacyPricingRules from the estimate's own pricingMetadata stamp (estimate-floor-signal-replay.js); the tests
 * below pass it directly, and the last describe pins the stamp round trip.
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
const { getEffectiveDiscount, determineWaveGuardTier } = require('../services/pricing-engine/discount-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { estimateDataHasQuoteRequirement } = require('../services/estimate-delivery-options');
const { lineRequiresReview } = require('../services/estimator-engine/draft-builder');
const { URGENCY, RODENT, PALM } = require('../services/pricing-engine/constants');

const GOLD_PRIORS = ['pest_control', 'lawn_care', 'mosquito'];
const HOME = { homeSqFt: 2200, lotSqFt: 9000 };

function palmLine(palmCount, { gold = true, replay = false, treatmentType = 'nutrition', palmSize } = {}) {
  const estimate = generateEstimate({
    ...HOME,
    ...(gold ? { priorQualifyingServices: GOLD_PRIORS } : {}),
    ...(replay ? { legacyPricingRules: true } : {}),
    services: { palmInjection: { treatmentType, palmCount, ...(palmSize ? { palmSize } : {}) } },
  });
  return estimate.lineItems.find((line) => line.service === 'palm_injection');
}

describe('replay: the price rules an estimate was priced with ride its own stamp', () => {
  const { savedFloorReplaySignals, savedLegacyPricingRulesSignal } = require('../services/estimate-floor-signal-replay');
  const services = { oneTimeLawn: { treatmentType: 'weed', track: 'st_augustine' } };

  test('the engine stamps which rules priced the run', () => {
    expect(generateEstimate({ ...HOME, lawnSqFt: 5500, services }).pricingMetadata.legacyPricingRules).toBe(false);
    expect(generateEstimate({ ...HOME, lawnSqFt: 5500, legacyPricingRules: true, services }).pricingMetadata.legacyPricingRules).toBe(true);
  });

  test('a priced estimate with no stamp was priced before the fixes and pins the old rules', () => {
    const unstamped = { engineResult: { lineItems: [{ service: 'one_time_lawn', price: 187 }] } };
    expect(savedLegacyPricingRulesSignal(unstamped)).toEqual({ legacyPricingRules: true });
    expect(savedFloorReplaySignals(unstamped).legacyPricingRules).toBe(true);
  });

  test('a stamped estimate reads back the rules it was priced with', () => {
    const fresh = generateEstimate({ ...HOME, lawnSqFt: 5500, services });
    expect(savedFloorReplaySignals({ engineResult: fresh, result: mapV1ToLegacyShape(fresh) }).legacyPricingRules).toBe(false);
    const older = generateEstimate({ ...HOME, lawnSqFt: 5500, services, legacyPricingRules: true });
    expect(savedLegacyPricingRulesSignal({ engineResult: older }).legacyPricingRules).toBe(true);
  });

  test('a save path that drops pricingMetadata still reads the stamp from the lines the fixes touch', () => {
    const fresh = generateEstimate({ ...HOME, lawnSqFt: 5500, services });
    const lawnLine = fresh.lineItems.find((line) => line.service === 'one_time_lawn');
    expect(lawnLine.legacyPricingRules).toBe(false);
    expect(savedLegacyPricingRulesSignal({ engineResult: { lineItems: [lawnLine] } })).toEqual({ legacyPricingRules: false });
    expect(savedLegacyPricingRulesSignal({ engineResult: { lineItems: [{ ...lawnLine, legacyPricingRules: true }] } })).toEqual({ legacyPricingRules: true });
  });

  test('the public wizard keeps the stamp when it saves the engine result', () => {
    const fs = require('fs');
    const path = require('path');
    const route = fs.readFileSync(path.join(__dirname, '../routes/public-quote.js'), 'utf8');
    expect(route).toContain('legacyPricingRules: estimate.pricingMetadata.legacyPricingRules,');
    // The one-time pest rule (2026-11-26) rides the same save, with its own stamp.
    expect(route).toContain('legacyOneTimePestBuffer: estimate.pricingMetadata.legacyOneTimePestBuffer');
    expect(route).toContain('...(typeof item.legacyPricingRules === \'boolean\' ? { legacyPricingRules: item.legacyPricingRules } : {})');
    // The projected shape (a line with only the stamp and a service) still reads back as priced under the fixes.
    expect(savedLegacyPricingRulesSignal({ engineResult: { lineItems: [{ service: 'one_time_lawn', price: 192, legacyPricingRules: false }] } }))
      .toEqual({ legacyPricingRules: false });
  });

  test('an older quote whose only priced row is a specialty row pins the old rules (a $625 stinging quote never replays at $750)', () => {
    expect(savedLegacyPricingRulesSignal({ result: { oneTime: { specItems: [{ name: 'Stinging Insect', price: 625 }] }, results: {} } }))
      .toEqual({ legacyPricingRules: true });
    expect(savedLegacyPricingRulesSignal({ result: { specItems: [{ name: 'Stinging Insect', price: 625 }], results: {} } }))
      .toEqual({ legacyPricingRules: true });
  });

  test('a stale engineResult beside the current result never overrides the current result\'s stamp', () => {
    const current = { lineItems: [{ service: 'one_time_lawn', price: 192, legacyPricingRules: false }] };
    const stale = { lineItems: [{ service: 'one_time_lawn', price: 187 }], pricingMetadata: { legacyPricingRules: true } };
    expect(savedLegacyPricingRulesSignal({ result: current, engineResult: stale, pricingAuthorityAtLock: 'SERVER' }))
      .toEqual({ legacyPricingRules: false });
  });

  test('a quote-required placeholder with no prices is not evidence the quote was priced', () => {
    const placeholder = { engineResult: { lineItems: [{ service: 'commercial_pest', quoteRequired: true, price: null, annual: null, monthly: null }] } };
    expect(savedLegacyPricingRulesSignal(placeholder).legacyPricingRules).toBeUndefined();
  });

  test('prices stored only in the frozen send snapshot pin the old rules, and a new snapshot carries its stamp', () => {
    const oldSent = { engineInputs: {}, sendSnapshot: { pricingBundle: { oneTimeBreakdown: { items: [{ service: 'one_time_lawn', amount: 187 }] } } } };
    expect(savedLegacyPricingRulesSignal(oldSent)).toEqual({ legacyPricingRules: true });
    const newSent = { engineInputs: {}, sendSnapshot: { legacyPricingRules: false, pricingBundle: { oneTimeBreakdown: { items: [{ service: 'one_time_lawn', price: 192 }] } } } };
    expect(savedLegacyPricingRulesSignal(newSent)).toEqual({ legacyPricingRules: false });
    const fs = require('fs');
    const path = require('path');
    const route = fs.readFileSync(path.join(__dirname, '../routes/admin-estimates.js'), 'utf8');
    expect(route).toContain('sendSnapshot.legacyPricingRules = priorRules === true;');
    expect(route).toContain('estimateDataForBundle.sendSnapshot = { legacyPricingRules: priorRules }');
  });

  test('a frozen bundle that carries its price only as a one-time total or anchor pins the old rules', () => {
    const viaFrequencies = { sendSnapshot: { pricingBundle: { frequencies: [{ oneTimeTotal: 625 }] } } };
    const viaAnchor = { sendSnapshot: { pricingBundle: { anchorOneTimePrice: 625 } } };
    expect(savedLegacyPricingRulesSignal(viaFrequencies)).toEqual({ legacyPricingRules: true });
    expect(savedLegacyPricingRulesSignal(viaAnchor)).toEqual({ legacyPricingRules: true });
  });

  test('the automated lead quote keeps the stamp when it compacts the engine result', () => {
    const { compactLineItem } = require('../services/lead-estimate-automation');
    const fresh = generateEstimate({ ...HOME, lawnSqFt: 5500, services: { oneTimeLawn: { treatmentType: 'weed', track: 'st_augustine' } } });
    const compacted = { engineResult: { lineItems: fresh.lineItems.map(compactLineItem) } };
    expect(compacted.engineResult.lineItems[0].legacyPricingRules).toBe(false);
    expect(savedLegacyPricingRulesSignal(compacted)).toEqual({ legacyPricingRules: false });
    const route = require('fs').readFileSync(require('path').join(__dirname, '../services/lead-estimate-automation.js'), 'utf8');
    expect(route).toContain('legacyPricingRules: estimate.pricingMetadata.legacyPricingRules,');
    // The one-time pest rule (2026-11-26) rides the same save, with its own stamp.
    expect(route).toContain('legacyOneTimePestBuffer: estimate.pricingMetadata.legacyOneTimePestBuffer');
  });

  test('no evidence returns an explicit undefined, so a value in the stored inputs cannot select the old rules', () => {
    const signal = savedLegacyPricingRulesSignal({});
    expect('legacyPricingRules' in signal).toBe(true);
    expect(signal.legacyPricingRules).toBeUndefined();
  });

  test('an older browser-only quote (priced rows only in the oneTime / recurring containers) pins the old rules', () => {
    expect(savedLegacyPricingRulesSignal({ result: { oneTime: { items: [{ name: 'OT Lawn (Weed Control)', price: 187 }] }, results: {} } }))
      .toEqual({ legacyPricingRules: true });
    expect(savedLegacyPricingRulesSignal({ result: { recurring: { services: [{ service: 'lawn_care' }] } } })).toEqual({ legacyPricingRules: true });
  });

  test('an estimate with no priced lines pins nothing, so a service added later takes the new rules', () => {
    expect(savedLegacyPricingRulesSignal({ engineResult: { lineItems: [] } })).toEqual({});
    expect(savedLegacyPricingRulesSignal({ result: { oneTime: { items: [] }, recurring: { services: [] } } })).toEqual({});
    expect(savedLegacyPricingRulesSignal({})).toEqual({});
  });

  test('a posted copy is stripped as a server-only replay field', () => {
    const { CLIENT_IDENTITY_FIELDS } = require('../services/estimate-client-identity-fields');
    expect(CLIENT_IDENTITY_FIELDS).toContain('legacyPricingRules');
  });
});

describe('fix 1: the palm per-visit minimum holds after the per-palm credit', () => {
  test('one nutrition palm on Gold keeps the $75 minimum (was $65)', () => {
    const line = palmLine(1);
    expect(line.annualBeforeCredits).toBe(75);
    expect(line.flatCreditAnnual).toBe(0);
    expect(line.annualAfterCredits).toBe(75);
  });

  test('two nutrition palms on Gold are no longer cheaper than one (was $55)', () => {
    const one = palmLine(1);
    const two = palmLine(2);
    expect(two.annualAfterCredits).toBe(75);
    expect(two.annualAfterCredits).toBeGreaterThanOrEqual(one.annualAfterCredits);
  });

  test('three and more palms above the minimum keep their full credit', () => {
    const three = palmLine(3);
    expect(three.annualBeforeCredits).toBe(105);
    expect(three.flatCreditAnnual).toBe(30);
    expect(three.annualAfterCredits).toBe(75);
    const six = palmLine(6);
    expect(six.flatCreditAnnual).toBe(60);
    expect(six.annualAfterCredits).toBe(150);
  });

  test('a partial credit stops exactly at the minimum', () => {
    // 4 palms x $35 = $140 a year; the $40 credit would leave $100, still above $75: full credit.
    // 3 palms x $35 = $105; the $30 credit leaves $75: full credit, not below it.
    const gold = determineWaveGuardTier(GOLD_PRIORS);
    const capped = getEffectiveDiscount('palm_injection', gold, { palmCount: 3, annualBeforeCredits: 90, palmAppsPerYear: 1 });
    expect(capped.flatCreditAnnual).toBe(15);
    expect(capped.minAnnualAfterCredits).toBe(PALM.minPerVisit);
    expect(capped.annualAfterCredits).toBe(75);
    const none = getEffectiveDiscount('palm_injection', gold, { palmCount: 2, annualBeforeCredits: 75, palmAppsPerYear: 1 });
    expect(none.flatCreditAnnual).toBe(0);
  });

  test('the minimum scales with visits: 2 visits a year holds $150', () => {
    const gold = determineWaveGuardTier(GOLD_PRIORS);
    const result = getEffectiveDiscount('palm_injection', gold, { palmCount: 1, annualBeforeCredits: 150, palmAppsPerYear: 2 });
    expect(result.flatCreditAnnual).toBe(0);
    expect(result.annualAfterCredits).toBe(150);
  });

  test('without a visit count the old cap stays (direct callers keep their numbers)', () => {
    const gold = determineWaveGuardTier(GOLD_PRIORS);
    const result = getEffectiveDiscount('palm_injection', gold, { palmCount: 2, annualBeforeCredits: 75 });
    expect(result.flatCreditAnnual).toBe(20);
  });

  test('Bronze is unchanged', () => {
    const line = palmLine(2, { gold: false });
    expect(line.flatCreditAnnual).toBe(0);
    expect(line.annualAfterCredits).toBe(75);
  });

  test('a replay prices under the per-visit minimum the quote was sold with, not a later Settings edit', () => {
    const { savedFloorReplaySignals } = require('../services/estimate-floor-signal-replay');
    const input = { ...HOME, priorQualifyingServices: GOLD_PRIORS, services: { palmInjection: { treatmentType: 'nutrition', palmCount: 3 } } };
    const priorMinimum = PALM.minPerVisit;
    const afterCredits = (extra = {}) => generateEstimate({ ...input, ...extra }).lineItems.find((l) => l.service === 'palm_injection').annualAfterCredits;
    try {
      const fresh = generateEstimate(input);
      expect(afterCredits()).toBe(75);
      const signals = savedFloorReplaySignals({ engineResult: fresh, result: mapV1ToLegacyShape(fresh) });
      expect(signals.palmMinPerVisitReplay).toBe(75);
      PALM.minPerVisit = 90;
      expect(afterCredits(signals)).toBe(75);
      // Without the saved minimum the live one applies (a new quote).
      expect(afterCredits()).toBe(90);
    } finally {
      PALM.minPerVisit = priorMinimum;
    }
  });

  test('the saved palm minimum survives a removal and restore (read from the opt-out event)', () => {
    const { savedFloorReplaySignals } = require('../services/estimate-floor-signal-replay');
    const priced = generateEstimate({ ...HOME, priorQualifyingServices: GOLD_PRIORS, services: { palmInjection: { treatmentType: 'nutrition', palmCount: 3 } } });
    const saved = { engineResult: priced, result: mapV1ToLegacyShape(priced) };
    const atRemoval = savedFloorReplaySignals(saved);
    expect(atRemoval.palmMinPerVisitReplay).toBe(75);
    // The palm row is pruned; the removal event keeps what the row carried.
    const removed = { engineResult: { lineItems: [] }, serviceOptOut: { events: [{ serviceKey: 'palm_injection', included: false, provenance: { floorSignals: atRemoval } }] } };
    expect(savedFloorReplaySignals(removed).palmMinPerVisitReplay).toBe(75);
  });

  test('adding a service to a palm estimate keeps the sold minimum (revision builder applies the saved signals)', () => {
    const request = require('fs').readFileSync(require('path').join(__dirname, '../services/estimate-add-service-request.js'), 'utf8');
    expect(request).toContain("for (const key of ['legacyPricingRules', 'legacyTwoStoryRoof', 'legacyWdoFlat', 'legacyOneTimePestBuffer', 'oneTimePestCurrentServices', 'currentRulesServices', 'palmMinPerVisitReplay'])");
  });

  test('an estimate priced before the fix keeps the credit it was quoted with', () => {
    expect(palmLine(1, { replay: true }).annualAfterCredits).toBe(65);
    expect(palmLine(2, { replay: true }).annualAfterCredits).toBe(55);
  });
});

describe('fix 2: the one-time lawn price rises inside a flat stretch of the 6-visit column', () => {
  const price = (sq, track = 'st_augustine', treatmentType = 'weed', options = {}) => (
    sp.priceOneTimeLawn({ lawnSqFt: sq }, { treatmentType, track, ...options }).price
  );

  test('St. Augustine weed: 3,000 / 4,000 / 5,500 / 6,500 sq ft', () => {
    expect(price(3000)).toBe(187);
    expect(price(4000)).toBe(189);
    expect(price(5500)).toBe(192);
    expect(price(6500)).toBe(197);
  });

  test('the stretch start and every price outside a flat stretch are unchanged', () => {
    for (const sq of [1500, 2000, 2500, 3000, 6000, 6500, 7000, 8000, 10000, 12000, 15000, 20000]) {
      expect(price(sq, 'st_augustine', 'weed')).toBe(price(sq, 'st_augustine', 'weed', { legacyOneTimePlateau: true }));
    }
  });

  test('never lowers a price and never falls with a bigger lawn, on every track and treatment', () => {
    for (const track of ['st_augustine', 'bermuda', 'zoysia', 'bahia']) {
      for (const treatmentType of ['weed', 'fert', 'pest', 'fungicide']) {
        let previous = 0;
        for (let sq = 1500; sq <= 12000; sq += 250) {
          const next = price(sq, track, treatmentType);
          const legacy = price(sq, track, treatmentType, { legacyOneTimePlateau: true });
          expect(next).toBeGreaterThanOrEqual(legacy);
          expect(next).toBeGreaterThanOrEqual(previous);
          previous = next;
        }
      }
    }
  });

  test('the price now rises with turf area across the St. Augustine plateau', () => {
    expect(price(5500)).toBeGreaterThan(price(3000));
    expect(price(4000)).toBeGreaterThan(price(3000));
  });

  test('the recurring lawn plan prices are untouched', () => {
    for (const sq of [3000, 4000, 5500]) {
      const plan = sp.priceLawnCare({ lawnSqFt: sq }, { track: 'st_augustine', tier: 'standard', includeHiddenTiers: true, applyProgramMinimum: false });
      expect(plan.monthly).toBe(38);
    }
  });

  test('the helper returns null at the stretch start, outside a stretch and above the table', () => {
    const { liveLawnMarketSchedule } = require('../services/pricing-engine/lawn-cost-plus-knobs');
    const schedule = liveLawnMarketSchedule();
    expect(sp.oneTimeLawnPlateauMonthly(3000, 'st_augustine', schedule)).toBeNull();
    expect(sp.oneTimeLawnPlateauMonthly(2200, 'st_augustine', schedule)).toBeNull();
    expect(sp.oneTimeLawnPlateauMonthly(25000, 'st_augustine', schedule)).toBeNull();
    expect(sp.oneTimeLawnPlateauMonthly(4500, 'st_augustine', schedule)).toBeCloseTo(38 + 0.5, 5);
  });

  test('a quote priced under the fix replays under it (no drop from $192 to $187), an older one keeps $187', () => {
    const { savedFloorReplaySignals } = require('../services/estimate-floor-signal-replay');
    const lawn = { oneTimeLawn: { treatmentType: 'weed', track: 'st_augustine' } };
    const priceOf = (e) => e.lineItems.find((line) => line.service === 'one_time_lawn').price;
    const fresh = generateEstimate({ ...HOME, lawnSqFt: 5500, services: lawn });
    expect(priceOf(fresh)).toBe(192);
    const signals = savedFloorReplaySignals({ engineResult: fresh, result: mapV1ToLegacyShape(fresh) });
    expect(priceOf(generateEstimate({ ...HOME, lawnSqFt: 5500, services: lawn, ...signals, savedEstimateReplay: true }))).toBe(192);
    const unstamped = { engineResult: { lineItems: [{ service: 'one_time_lawn', price: 187 }] } };
    const older = generateEstimate({ ...HOME, lawnSqFt: 5500, services: lawn, ...savedFloorReplaySignals(unstamped) });
    expect(priceOf(older)).toBe(187);
    // The replay of an older estimate stamps the old rules, so the next replay keeps them too.
    expect(savedFloorReplaySignals({ engineResult: older }).legacyPricingRules).toBe(true);
  });

  test('an estimate priced before the fix keeps its one-time lawn price', () => {
    const quote = (legacy) => generateEstimate({
      ...HOME,
      lawnSqFt: 5500,
      ...(legacy ? { legacyPricingRules: true } : {}),
      services: { oneTimeLawn: { treatmentType: 'weed', track: 'st_augustine' } },
    }).lineItems.find((line) => line.service === 'one_time_lawn').price;
    expect(quote(true)).toBe(187);
    expect(quote(false)).toBe(192);
  });
});

describe('fix 4: commercial pest interior work scales with total interior area', () => {
  const price = (property) => sp.priceCommercialPest({ perimeter: 320, ...property }, {});

  test('a two-story building prices like a one-story building of the same total area', () => {
    const oneStory = price({ homeSqFt: 6000, stories: 1 });
    const twoStory = price({ homeSqFt: 6000, stories: 2 });
    expect(twoStory.annual).toBe(oneStory.annual);
    expect(oneStory.annual).toBe(1802.91);
    expect(twoStory.interiorAreaUsed).toBe(6000);
    expect(twoStory.footprint).toBe(3000);
  });

  test('an explicit ground-floor footprint is multiplied by its stories for the interior only', () => {
    const twoStory = price({ footprint: 3000, stories: 2 });
    const oneStory6000 = price({ footprint: 6000, perimeter: 320, stories: 1 });
    expect(twoStory.interiorAreaUsed).toBe(6000);
    expect(twoStory.annual).toBe(oneStory6000.annual);
    expect(twoStory.perimeter).toBe(320);
  });

  test('a measured total interior area beats footprint times stories', () => {
    // 3,000 sq ft footprint, two stories, 4,500 sq ft measured inside: priced for 4,500, not 6,000.
    const measured = price({ footprint: 3000, stories: 2, homeSqFt: 4500 });
    expect(measured.interiorAreaUsed).toBe(4500);
    expect(measured.annual).toBeGreaterThan(price({ footprint: 3000, stories: 1 }).annual);
    expect(measured.annual).toBeLessThan(price({ footprint: 3000, stories: 2 }).annual);
  });

  test('an association aggregate beside a measured footprint cannot price as one building (capped at footprint x stories)', () => {
    const capped = price({ footprint: 3000, stories: 2, homeSqFt: 40000 });
    expect(capped.interiorAreaUsed).toBe(6000);
  });

  test('the interior area is never below the footprint, so a one-story building keeps its price', () => {
    const oneStory = price({ footprint: 3200, stories: 1, homeSqFt: 3000 });
    expect(oneStory.interiorAreaUsed).toBe(3200);
    expect(oneStory.annual).toBe(price({ footprint: 3200 }).annual);
  });

  test('a commercial pest line added to an older estimate prices under the current rules; the rest keep theirs', () => {
    const quote = (extra) => generateEstimate({
      homeSqFt: 6000, stories: 2, lotSqFt: 20000, propertyType: 'commercial', commercialSubtype: 'restaurant',
      legacyPricingRules: true, ...extra, services: { pest: { frequency: 'quarterly' } },
    }).lineItems.find((line) => line.service === 'commercial_pest');
    expect(quote({}).annual).toBe(1452.22);
    expect(quote({ addedServiceKeys: ['pest_control'] }).annual).toBe(1779.49);
    const request = require('fs').readFileSync(require('path').join(__dirname, '../services/estimate-add-service-request.js'), 'utf8');
    expect(request).toContain('updatedInputs.addedServiceKeys = [serviceKey];');
  });

  test('a second revision keeps the service the first one added under the current rules', () => {
    const { savedFloorReplaySignals } = require('../services/estimate-floor-signal-replay');
    const base = { homeSqFt: 6000, stories: 2, lotSqFt: 20000, propertyType: 'commercial', commercialSubtype: 'restaurant', services: { pest: { frequency: 'quarterly' } } };
    const annual = (e) => e.lineItems.find((line) => line.service === 'commercial_pest').annual;
    // Revision 1: an older estimate (legacy rules) gets commercial pest added under the current rules.
    const first = generateEstimate({ ...base, legacyPricingRules: true, addedServiceKeys: ['pest_control'] });
    expect(annual(first)).toBe(1779.49);
    expect(first.pricingMetadata.currentRulesServices).toEqual(['pest_control']);
    // Revision 2 (mosquito added): the saved stamp keeps pest on the current rules.
    const signals = savedFloorReplaySignals({ engineResult: first });
    expect(signals.legacyPricingRules).toBe(true);
    expect(signals.currentRulesServices).toEqual(['pest_control']);
    const second = generateEstimate({ ...base, ...signals, addedServiceKeys: ['mosquito'] });
    expect(annual(second)).toBe(1779.49);
    expect(second.pricingMetadata.currentRulesServices).toEqual(['pest_control', 'mosquito']);
  });

  test('exterior-only pricing and one-story results do not move', () => {
    expect(price({ footprint: 3000, perimeter: 220 }).annual).toBe(1424.73);
    expect(sp.priceCommercialPest({ footprint: 6000, stories: 2, perimeter: 320 }, { interiorService: 'excluded' }).annual)
      .toBe(sp.priceCommercialPest({ footprint: 3000, stories: 1, perimeter: 320 }, { interiorService: 'excluded' }).annual);
  });

  test('an estimate priced before the fix keeps the footprint basis', () => {
    expect(sp.priceCommercialPest({ homeSqFt: 6000, stories: 2, perimeter: 320 }, { legacyInteriorFootprint: true }).annual)
      .toBe(1475.64);
    const quote = (replay) => generateEstimate({
      homeSqFt: 6000, stories: 2, lotSqFt: 20000, propertyType: 'commercial', commercialSubtype: 'restaurant',
      ...(replay ? { legacyPricingRules: true } : {}),
      services: { pest: { frequency: 'quarterly' } },
    }).lineItems.find((line) => line.service === 'commercial_pest');
    // 6,000 sq ft two-story restaurant: the older estimate keeps $1,452.22, a new quote prices the whole interior.
    expect(quote(true).annual).toBe(1452.22);
    expect(quote(false).annual).toBe(1779.49);
  });
});

describe('fix 5: wasp urgent covers the removal and wins over same-day', () => {
  test('urgent multiplies base plus removal', () => {
    // Tier 2 is $250. Large removal is $250. Urgent is x1.5 on the sum.
    expect(sp.priceWasp({}, { tier: 2, urgent: true, removalType: 'large' }).price).toBe(750);
    expect(sp.priceWasp({}, { tier: 2, urgent: true, removalType: 'small' }).price).toBe(488);
  });

  test('URGENT wins over same-day when both are set', () => {
    expect(sp.priceWasp({}, { tier: 2, urgency: 'URGENT', sameDay: true }).price).toBe(375);
    expect(sp.priceWasp({}, { tier: 2, urgent: true, sameDay: true }).price).toBe(375);
  });

  test('non-urgent prices do not change', () => {
    expect(sp.priceWasp({}, { tier: 2 }).price).toBe(250);
    expect(sp.priceWasp({}, { tier: 2, sameDay: true }).price).toBe(325);
    expect(sp.priceWasp({}, { tier: 2, urgency: 'SOON' }).price).toBe(325);
    expect(sp.priceWasp({}, { tier: 2, sameDay: true, removalType: 'large' }).price).toBe(575);
    expect(sp.priceWasp({}, { tier: 2, removalType: 'large' }).price).toBe(500);
  });

  test('the live stinging pricer (the one generateEstimate calls) covers the removal too', () => {
    const quote = (legacy) => generateEstimate({
      ...HOME,
      ...(legacy ? { legacyPricingRules: true } : {}),
      services: { stinging: { tier: 2, removal: 'LARGE', urgency: 'URGENT' } },
    }).lineItems.find((line) => line.service === 'stinging_insect').price;
    expect(quote(false)).toBe(750);
    // An estimate priced before the fix keeps the $625 it was quoted.
    expect(quote(true)).toBe(625);
    expect(sp.priceStingingInsect({ tier: 2, removal: 'NONE', urgency: 'URGENT' }).price).toBe(375);
    expect(sp.priceStingingInsect({ tier: 2, removal: 'LARGE', urgency: 'SOON' }).price).toBe(575);
  });

  test('urgent without removal is the same as before', () => {
    expect(sp.priceWasp({}, { tier: 2, urgent: true }).price).toBe(375);
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
    expect(result.pricingBreakdown.subtotal).toBe(750);
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

  describe('applyUrgency keeps the fixed rush multipliers and upper-cases its input', () => {
  test('the live stinging pricer matches urgency upper-case for a new quote; an older quote keeps the old match', () => {
    const quote = (legacy) => generateEstimate({
      ...HOME,
      ...(legacy ? { legacyPricingRules: true } : {}),
      services: { stinging: { tier: 2, removal: 'LARGE', urgency: 'urgent' } },
    }).lineItems.find((line) => line.service === 'stinging_insect').price;
    expect(quote(false)).toBe(750);
    expect(quote(true)).toBe(500);
  });

    const exclusionTotal = (urgency, afterHours = false) => sp.priceRodentExclusionV2({
      standardWireMeshPoints: 4, urgency, afterHours,
    }).total;

    test('the numbers are the fixed 1.25 / 1.50 soon and 1.50 / 2.00 urgent', () => {
      expect(exclusionTotal('ROUTINE')).toBe(375);
      expect(exclusionTotal('SOON')).toBe(375 + Math.round(300 * 1.25) - 300);
      expect(exclusionTotal('URGENT')).toBe(525);
      expect(exclusionTotal('URGENT', true)).toBe(675);
      expect(exclusionTotal('SOON', true)).toBe(525);
    });

    test('a lower-case word counts the same as the upper-case one', () => {
      expect(exclusionTotal('urgent')).toBe(exclusionTotal('URGENT'));
      expect(exclusionTotal('soon', true)).toBe(exclusionTotal('SOON', true));
    });

    test('an estimate priced before the change keeps the case-sensitive match through a replay', () => {
      const quote = (legacy) => generateEstimate({
        ...HOME,
        ...(legacy ? { legacyPricingRules: true } : {}),
        services: { exclusion: { pricingVersion: 'v2', standardWireMeshPoints: 4, urgency: 'urgent' } },
      }).lineItems.filter((line) => line.service === 'rodent_exclusion').reduce((sum, line) => sum + line.price, 0);
      expect(quote(true)).toBe(375);
      expect(quote(false)).toBe(525);
      expect(sp.pricePlugging(2000, 12, { urgency: 'urgent', legacyUrgency: true }).price)
        .toBeLessThan(sp.pricePlugging(2000, 12, { urgency: 'urgent' }).price);
    });

    test('a Settings edit to onetime_urgency does not move the exclusion, plugging or foam rush prices', () => {
      const prior = URGENCY.URGENT.standard;
      try {
        const before = [exclusionTotal('URGENT'), sp.pricePlugging(2000, 12, { urgency: 'URGENT' }).price, sp.priceFoamDrill(5, { urgency: 'URGENT' }).price];
        URGENCY.URGENT.standard = 1.8;
        expect([exclusionTotal('URGENT'), sp.pricePlugging(2000, 12, { urgency: 'URGENT' }).price, sp.priceFoamDrill(5, { urgency: 'URGENT' }).price]).toEqual(before);
      } finally {
        URGENCY.URGENT.standard = prior;
      }
    });
  });
});
