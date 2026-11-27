/**
 * One lawn price lane (owner 2026-11-26: "make these one type of grass ... for lawn quotes in general I think we move to one
 * grass type"; his yes on the price audit pick: every grass prices from the St. Augustine table, one-time lawn = 1.8x at one
 * price, +20% for insect or fungus work, the Bermuda removal concept kept). New quotes only.
 *
 * Recurring lawn care: a new bermuda or zoysia plan reads the St. Augustine rows of the market table. The grass stays a real input
 * everywhere else (the program and its products, the cost floor and cost-plus list, the Bermuda add-ons, the bahia review, the
 * track a line reports). Bahia keeps its own rows (it parks for review under GATE_LAWN_V13).
 * One-time lawn and the lawn pest knockdown: 1.8 x the St. Augustine 6-visit per-application price for every grass, fertilizer
 * and weed work at one price, +20% for insect or fungus work (ONE_TIME.lawn.newRule, code constants).
 *
 * Replay contract (the #8654 / #8666 pattern, plan-wide): the engine stamps pricingMetadata.legacyLawnOneLane on every run,
 * false on a fresh quote. A priced estimate with no stamp, or one that kept only inputs asking for lawn, was quoted before the
 * rule and keeps it; a legacy quote runs main's code path unchanged (its own grass's rows, the Settings multiple and factors).
 */

jest.mock('../models/db', () => {
  const chain = () => {
    const builder = {
      orderBy: () => builder,
      where: () => builder,
      whereNotIn: () => builder,
      then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
    };
    return builder;
  };
  const db = jest.fn(() => chain());
  db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => new Proxy({}, {
  get: (_target, name) => (name === '__esModule' ? false : (_req, _res, next) => next()),
}));

const fs = require('fs');
const path = require('path');

const sp = require('../services/pricing-engine/service-pricing');
const constants = require('../services/pricing-engine/constants');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const replay = require('../services/estimate-floor-signal-replay');
const { extractEngineInputs } = require('../routes/estimate-public');
const { CLIENT_IDENTITY_FIELDS, sanitizeClientIdentityFields } = require('../services/estimate-client-identity-fields');
const { guardLawnOneLaneOnClientFallbackSave } = require('../services/admin-estimate-persistence');

const LEGACY = { legacyLawnOneLane: true };
const plan = (lawnSqFt, track, tier = 'enhanced', extra = {}) => sp.priceLawnCare({ lawnSqFt }, { track, tier, includeHiddenTiers: true, ...extra });
const oneTime = (lawnSqFt, track, treatmentType = 'weed', extra = {}) => sp.priceOneTimeLawn({ lawnSqFt }, { track, treatmentType, ...extra });
const lineOf = (estimate, service) => estimate.lineItems.find((line) => line.service === service);
const HOME = { homeSqFt: 2000, stories: 1, lotSqFt: 10000 };
const lawnQuote = (lawnSqFt, track, extra = {}) => generateEstimate({ ...HOME, lawnSqFt, services: { lawn: { track, tier: 'enhanced' } }, ...extra });
const oneTimeQuote = (lawnSqFt, track, extra = {}) => generateEstimate({ ...HOME, lawnSqFt, services: { oneTimeLawn: { treatmentType: 'weed', track } }, ...extra });

describe('recurring lawn care: a new bermuda or zoysia plan prices from the St. Augustine rows', () => {
  const SIZES = [1500, 3000, 4250, 5500, 8000, 12000, 15000, 20000, 25000];

  test.each(['bermuda', 'zoysia'])('%s: every size and sold cadence collects the St. Augustine price', (track) => {
    for (const lawnSqFt of SIZES) {
      for (const tier of ['enhanced', 'premium']) {
        const mine = plan(lawnSqFt, track, tier);
        const stAugustine = plan(lawnSqFt, 'st_augustine', tier);
        expect({ lawnSqFt, tier, perApp: mine.perApp, annual: mine.annual, monthly: mine.monthly })
          .toEqual({ lawnSqFt, tier, perApp: stAugustine.perApp, annual: stAugustine.annual, monthly: stAugustine.monthly });
        // The line still names its own grass: the program, the products and the staff see bermuda or zoysia.
        expect(mine.track).toBe(track);
      }
    }
  });

  test('3,000 sq ft, 9 visits: bermuda and zoysia $61.33 -> $58.67 an application (the St. Augustine price)', () => {
    for (const track of ['bermuda', 'zoysia']) {
      expect(plan(3000, track, 'enhanced', LEGACY).perApp).toBe(61.33);
      expect(plan(3000, track, 'enhanced').perApp).toBe(58.67);
    }
    expect(plan(3000, 'st_augustine', 'enhanced').perApp).toBe(58.67);
  });

  test('st_augustine and bahia read their own rows, exactly as before the rule', () => {
    for (const lawnSqFt of SIZES) {
      for (const track of ['st_augustine', 'bahia']) {
        for (const tier of ['standard', 'enhanced', 'premium']) {
          const now = plan(lawnSqFt, track, tier);
          const before = plan(lawnSqFt, track, tier, LEGACY);
          expect({ track, lawnSqFt, tier, annual: now.annual, perApp: now.perApp }).toEqual({ track, lawnSqFt, tier, annual: before.annual, perApp: before.perApp });
        }
      }
    }
  });

  test('a quote saved before the rule reads its own grass rows (bermuda 25,000 sq ft, 9 visits: $228, not $218.67)', () => {
    expect(plan(25000, 'bermuda', 'enhanced', LEGACY).perApp).toBe(228);
    expect(plan(25000, 'bermuda', 'enhanced').perApp).toBe(218.67);
  });

  test('only the market lookup moves: the cost floor still uses each grass\'s own material budget', () => {
    const floor = (track, extra) => plan(8000, track, 'enhanced', { useLawnCostFloor: true, ...extra }).costFloorAnnual;
    expect(floor('zoysia')).toBe(floor('zoysia', LEGACY));
    expect(floor('bermuda')).toBe(floor('bermuda', LEGACY));
    expect(floor('zoysia')).not.toBe(floor('st_augustine'));
  });

  test('the bahia review is untouched: with GATE_LAWN_V13 on a new bahia plan still parks, a bermuda plan does not', () => {
    const saved = process.env.GATE_LAWN_V13;
    process.env.GATE_LAWN_V13 = 'true';
    try {
      expect(plan(5000, 'bahia').manualReviewReasons).toContain('lawn_v13_bahia_no_program');
      expect(plan(5000, 'bermuda').manualReviewReasons || []).not.toContain('lawn_v13_bahia_no_program');
    } finally {
      if (saved === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = saved;
    }
  });
});

describe('one-time lawn: 1.8 x the St. Augustine anchor for every grass, +20% for insect or fungus work', () => {
  test('St. Augustine 3,000 / 4,500 / 8,000 sq ft, new quote and a quote saved before the rule', () => {
    const prices = (extra) => [3000, 4500, 8000].map((sq) => ['fert', 'weed', 'pest', 'fungicide'].map((t) => oneTime(sq, 'st_augustine', t, extra).price));
    expect(prices()).toEqual([[137, 137, 164, 164], [139, 139, 167, 167], [169, 169, 203, 203]]);
    expect(prices(LEGACY)).toEqual([[167, 187, 217, 230], [169, 189, 220, 233], [207, 232, 269, 286]]);
  });

  test('one price for every grass on a new quote; a quote saved before the rule keeps its grass anchor', () => {
    for (const sq of [2000, 3000, 4500, 8000, 12000]) {
      for (const treatmentType of ['fert', 'weed', 'pest', 'fungicide']) {
        const stAugustine = oneTime(sq, 'st_augustine', treatmentType).price;
        for (const track of ['bermuda', 'zoysia', 'bahia']) expect(oneTime(sq, track, treatmentType).price).toBe(stAugustine);
      }
    }
    // Bermuda 4,500 sq ft weed, saved before the rule: its own rows, 2.2 and the 1.12 weed factor.
    expect(oneTime(4500, 'bermuda', 'weed', LEGACY).price).toBe(208);
  });

  test('the line reports the rule\'s multiple and factor, and still names its own grass', () => {
    // 8,000 sq ft sits outside a flat stretch of the 6-visit column, so the anchor is the table price itself.
    const line = oneTime(8000, 'zoysia', 'pest');
    expect(line.treatmentMultiplier).toBe(1.2);
    expect(line.basePrice).toBe(Math.max(constants.ONE_TIME.lawn.floor, Math.round(line.baselinePerApp * 1.8)));
    expect(line.track).toBe('zoysia');
    expect(oneTime(4500, 'zoysia', 'weed').treatmentMultiplier).toBe(1);
    expect(oneTime(4500, 'zoysia', 'weed', LEGACY).treatmentMultiplier).toBe(1.12);
  });

  test('the $115 floor, urgency and the member perk apply as before', () => {
    expect(oneTime(500, 'st_augustine', 'fert').price).toBe(constants.ONE_TIME.lawn.floor);
    const plain = oneTime(4500, 'st_augustine', 'weed');
    const urgent = oneTime(4500, 'st_augustine', 'weed', { urgency: 'URGENT' });
    expect(urgent.urgencyMultiplier).toBe(1.5);
    expect(urgent.price).toBe(Math.round(plain.preUrgencyPrice * 1.5));
    const member = oneTime(4500, 'st_augustine', 'weed', { isRecurringCustomer: true });
    expect(member.recurringCustomerDiscountRate).toBe(0.15);
  });

  test('the new rule is code, not a Setting: a Settings edit to the old multiple or factors moves only quotes saved before the rule', () => {
    const lawn = constants.ONE_TIME.lawn;
    const savedMultiplier = lawn.oneTimeMultiplier;
    const savedWeed = lawn.treatmentMultipliers.weed;
    const newPrice = oneTime(4500, 'st_augustine', 'weed').price;
    const legacyPrice = oneTime(4500, 'st_augustine', 'weed', LEGACY).price;
    try {
      lawn.oneTimeMultiplier = 3;
      lawn.treatmentMultipliers.weed = 1.5;
      expect(oneTime(4500, 'st_augustine', 'weed').price).toBe(newPrice);
      expect(oneTime(4500, 'st_augustine', 'weed', LEGACY).price).not.toBe(legacyPrice);
    } finally {
      lawn.oneTimeMultiplier = savedMultiplier;
      lawn.treatmentMultipliers.weed = savedWeed;
    }
    expect(Object.isFrozen(lawn.newRule)).toBe(true);
    expect(Object.isFrozen(lawn.newRule.treatmentMultipliers)).toBe(true);
  });

  test('the lawn pest knockdown is the one-time lawn insect price', () => {
    const knockdown = (extra = {}) => lineOf(generateEstimate({ ...HOME, lawnSqFt: 4500, services: { lawnPestControl: { track: 'bermuda' } }, ...extra }), 'one_time_lawn');
    expect(knockdown().price).toBe(oneTime(4500, 'st_augustine', 'pest').price);
    expect(knockdown(LEGACY).price).toBe(oneTime(4500, 'bermuda', 'pest', LEGACY).price);
  });
});

describe('replay: a quote priced before this change keeps its grass rows and the old one-time rule', () => {
  test('the engine stamps the rule on every run, on the metadata and on the lawn lines', () => {
    expect(lawnQuote(3000, 'bermuda').pricingMetadata.legacyLawnOneLane).toBe(false);
    expect(lawnQuote(3000, 'bermuda', LEGACY).pricingMetadata.legacyLawnOneLane).toBe(true);
    expect(lineOf(lawnQuote(3000, 'bermuda'), 'lawn_care').legacyLawnOneLane).toBe(false);
    expect(lineOf(oneTimeQuote(3000, 'bermuda'), 'one_time_lawn').legacyLawnOneLane).toBe(false);
    expect(lineOf(oneTimeQuote(3000, 'bermuda', LEGACY), 'one_time_lawn').legacyLawnOneLane).toBe(true);
    // Only a literal true selects the old rule.
    expect(lineOf(oneTimeQuote(4500, 'bermuda', { legacyLawnOneLane: 'true' }), 'one_time_lawn').price).toBe(139);
  });

  test('a priced estimate with no stamp was quoted before the rule: it replays its old price through the real signal reader', () => {
    // Unstamped, so it predates the 11-26 flat-stretch rise too (legacyPricingRules): bermuda 4,500 sq ft weed on main = $207.
    const sold = { engineResult: { lineItems: [{ service: 'one_time_lawn', price: 207 }] }, engineInputs: { ...HOME, lawnSqFt: 4500, services: { oneTimeLawn: { treatmentType: 'weed', track: 'bermuda' } } } };
    expect(replay.savedLegacyLawnOneLaneSignal(sold)).toEqual({ legacyLawnOneLane: true });
    expect(replay.savedFloorReplaySignals(sold).legacyLawnOneLane).toBe(true);
    const replayed = generateEstimate(extractEngineInputs(sold));
    expect(lineOf(replayed, 'one_time_lawn').price).toBe(207);
    expect(lineOf(replayed, 'one_time_lawn').price).toBe(oneTime(4500, 'bermuda', 'weed', { ...LEGACY, legacyOneTimePlateau: true }).price);
    expect(replayed.pricingMetadata.legacyLawnOneLane).toBe(true);
  });

  test('the stamp is its own key: a quote stamped false by the other 11-26 rules is still legacy here', () => {
    const afterOtherRules = {
      engineResult: {
        pricingMetadata: { legacyPricingRules: false, legacyWholeHomeSizing: false, legacySpecialty1126: false, legacyPestAboveTable: false },
        lineItems: [{ service: 'lawn_care', annual: 552 }],
      },
      engineInputs: { ...HOME, lawnSqFt: 3000, services: { lawn: { track: 'bermuda', tier: 'enhanced' } } },
    };
    const signals = replay.savedFloorReplaySignals(afterOtherRules);
    expect(signals.legacyLawnOneLane).toBe(true);
    expect(signals.legacyWholeHomeSizing).toBe(false);
    expect(lineOf(generateEstimate(extractEngineInputs(afterOtherRules)), 'lawn_care').perApp).toBe(lineOf(lawnQuote(3000, 'bermuda', LEGACY), 'lawn_care').perApp);
  });

  test('a stamped estimate reads back the rule it was priced with, through the lines, the mapped result and the replay', () => {
    const fresh = oneTimeQuote(4500, 'bermuda');
    const saved = { engineInputs: { ...HOME, lawnSqFt: 4500, services: { oneTimeLawn: { treatmentType: 'weed', track: 'bermuda' } } }, engineResult: fresh, result: mapV1ToLegacyShape(fresh) };
    expect(replay.savedFloorReplaySignals(saved).legacyLawnOneLane).toBe(false);
    expect(lineOf(generateEstimate(extractEngineInputs(saved)), 'one_time_lawn').price).toBe(139);
    expect(mapV1ToLegacyShape(fresh).pricingMetadata.legacyLawnOneLane).toBe(false);
    expect(replay.savedLegacyLawnOneLaneSignal({ engineResult: { lineItems: [lineOf(fresh, 'one_time_lawn')] } })).toEqual({ legacyLawnOneLane: false });
    const older = oneTimeQuote(4500, 'bermuda', LEGACY);
    expect(replay.savedLegacyLawnOneLaneSignal({ engineResult: older }).legacyLawnOneLane).toBe(true);
  });

  test('an inputs-only estimate asking for lawn reads legacy; one asking for none pins nothing; a stamped draft stays new', () => {
    const inputsOnly = (services) => ({ engineInputs: { ...HOME, lawnSqFt: 4500, services } });
    for (const services of [{ lawn: { track: 'zoysia' } }, { oneTimeLawn: { treatmentType: 'weed' } }, { lawnPestControl: {} }]) {
      expect(replay.savedLegacyLawnOneLaneSignal(inputsOnly(services))).toEqual({ legacyLawnOneLane: true });
      expect(replay.savedLegacyLawnOneLaneSignal(JSON.stringify(inputsOnly(services)))).toEqual({ legacyLawnOneLane: true });
    }
    for (const services of [{ pest: { frequency: 'quarterly' } }, { mosquito: {} }, { plugging: { area: 500, spacing: 12 } }]) {
      expect(replay.savedLegacyLawnOneLaneSignal(inputsOnly(services))).toEqual({ legacyLawnOneLane: undefined });
    }
    expect(replay.savedLegacyLawnOneLaneSignal({ ...inputsOnly({ lawn: {} }), pricingMetadata: { legacyLawnOneLane: false } }))
      .toEqual({ legacyLawnOneLane: false });
    // The builder request names its services as tokens.
    for (const selectedServices of [['LAWN'], ['OT_LAWN'], ['PEST', 'lawn']]) {
      expect(replay.savedLegacyLawnOneLaneSignal({ engineRequest: { selectedServices } })).toEqual({ legacyLawnOneLane: true });
    }
    for (const selectedServices of [['PEST'], ['PLUGGING', 'TOPDRESS', 'DETHATCH']]) {
      expect(replay.savedLegacyLawnOneLaneSignal({ engineRequest: { selectedServices } })).toEqual({ legacyLawnOneLane: undefined });
    }
  });

  test('an estimate with no priced lines and no request pins nothing, so a quote started now takes the new rule', () => {
    expect(replay.savedLegacyLawnOneLaneSignal({ engineResult: { lineItems: [] } })).toEqual({ legacyLawnOneLane: undefined });
    expect(replay.savedLegacyLawnOneLaneSignal({})).toEqual({ legacyLawnOneLane: undefined });
    expect('legacyLawnOneLane' in replay.savedFloorReplaySignals({})).toBe(true);
    expect({ legacyLawnOneLane: true, ...replay.savedFloorReplaySignals({}) }.legacyLawnOneLane).toBeUndefined();
  });

  test('plan-wide: a lawn service added to a legacy estimate stays on the old rule, on the revision and on every later replay', () => {
    const base = { ...HOME, lawnSqFt: 4500, legacyLawnOneLane: true, services: { lawn: { track: 'bermuda', tier: 'enhanced' }, oneTimeLawn: { treatmentType: 'weed', track: 'bermuda' } } };
    // With a lawn plan on the same estimate the one-time line takes the 15% member perk: $208 x 0.85 = $177 on the old rule,
    // $139 x 0.85 = $118 on the new one.
    expect(lineOf(generateEstimate({ ...base, legacyLawnOneLane: undefined }), 'one_time_lawn').price).toBe(118);
    const revised = generateEstimate({ ...base, addedServiceKeys: ['one_time_lawn'], currentRulesServices: ['one_time_lawn'] });
    expect(lineOf(revised, 'one_time_lawn').price).toBe(177);
    expect(revised.pricingMetadata.legacyLawnOneLane).toBe(true);
    const signals = replay.savedFloorReplaySignals({ engineResult: revised });
    expect(signals.legacyLawnOneLane).toBe(true);
    expect(lineOf(generateEstimate({ ...base, ...signals }), 'one_time_lawn').price).toBe(177);
  });

  test('snapshot-only: a priced send bundle with no stamp is legacy, a frozen stamp wins, and freezing keeps it through a bundle drop', () => {
    const bundle = { oneTimeBreakdown: { items: [{ service: 'one_time_lawn', amount: 208 }] } };
    const snapshotOnly = { sendSnapshot: { pricingBundle: bundle } };
    expect(replay.savedLegacyLawnOneLaneSignal(snapshotOnly)).toEqual({ legacyLawnOneLane: true });
    const copy = JSON.parse(JSON.stringify(snapshotOnly));
    replay.freezeSnapshotRuleStamps(copy);
    expect(copy.sendSnapshot.legacyLawnOneLane).toBe(true);
    delete copy.sendSnapshot.pricingBundle;
    expect(replay.savedLegacyLawnOneLaneSignal(copy)).toEqual({ legacyLawnOneLane: true });
    expect(replay.savedLegacyLawnOneLaneSignal({ sendSnapshot: { legacyLawnOneLane: false } })).toEqual({ legacyLawnOneLane: false });
    const inputsOnly = { engineInputs: { ...HOME, lawnSqFt: 4500, services: { lawn: {} } }, sendSnapshot: { renderedAt: '2026-11-20T15:00:00.000Z' } };
    replay.freezeSnapshotRuleStamps(inputsOnly);
    expect(inputsOnly.sendSnapshot.legacyLawnOneLane).toBe(true);
    const empty = { sendSnapshot: { renderedAt: '2026-11-20T15:00:00.000Z' } };
    replay.freezeSnapshotRuleStamps(empty);
    expect(empty.sendSnapshot).not.toHaveProperty('legacyLawnOneLane');
  });

  test('the send snapshot, the public wizard, the lead quote, the add-service revision and the list-price replay carry the stamp', () => {
    const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
    const route = read('../routes/admin-estimates.js');
    expect(route).toContain('savedLegacyLawnOneLaneSignal(estimateData).legacyLawnOneLane');
    expect(route).toContain('legacyLawnOneLane: priorLawnOneLane }');
    expect(route).toContain('sendSnapshot.legacyLawnOneLane = priorLawnOneLane === true;');
    const pq = read('../routes/public-quote.js');
    expect(pq).toContain('legacyLawnOneLane: estimate.pricingMetadata.legacyLawnOneLane');
    expect(pq).toContain('legacyLawnOneLane: item.legacyLawnOneLane');
    expect(read('../services/lead-estimate-automation.js')).toContain('legacyLawnOneLane: estimate.pricingMetadata.legacyLawnOneLane');
    const { compactLineItem } = require('../services/lead-estimate-automation');
    expect(compactLineItem(lineOf(oneTimeQuote(4500, 'bermuda'), 'one_time_lawn')).legacyLawnOneLane).toBe(false);
    expect(compactLineItem(lineOf(oneTimeQuote(4500, 'bermuda', LEGACY), 'one_time_lawn')).legacyLawnOneLane).toBe(true);
    const request = read('../services/estimate-add-service-request.js');
    expect(request).toContain("'legacyLawnOneLane'");
    expect(request).toContain('legacyLawnOneLane: _ll');
    expect(read('../services/rate-review.js')).toContain("'legacyLawnOneLane'");
    // A posted value never switches the rule.
    expect(CLIENT_IDENTITY_FIELDS).toContain('legacyLawnOneLane');
    expect(sanitizeClientIdentityFields({ legacyLawnOneLane: true })).toEqual({});
  });
});

describe('a browser-priced save (the server could not price it)', () => {
  const guard = (save, storedEstimateData = null) => guardLawnOneLaneOnClientFallbackSave(save, { storedEstimateData });
  const refused = expect.objectContaining({ statusCode: 409 });

  test('a one-time lawn or lawn pest row is refused for every grass, whatever stamp it posts', () => {
    expect(() => guard({ result: { oneTime: { items: [{ name: 'One-Time Lawn Weed Control', price: 187 }] } } })).toThrow(refused);
    expect(() => guard({ result: { oneTime: { items: [{ service: 'one_time_lawn', price: 187 }] } }, inputs: { grassType: 'st_augustine' } })).toThrow(refused);
    expect(() => guard({ result: { oneTime: { items: [{ name: 'Lawn Pest Knockdown', price: 220 }] } } })).toThrow(refused);
    const forged = { result: { oneTime: { items: [{ service: 'one_time_lawn', price: 137 }] }, pricingMetadata: { legacyLawnOneLane: false } } };
    expect(() => guard(forged)).toThrow(refused);
    expect(() => guard([{ service: 'one_time_lawn', price: 187 }], [{ service: 'one_time_lawn', price: 187 }])).toThrow(refused);
  });

  test('a lawn plan row is refused for every grass, whatever stamp it posts: only the server follows the live lawn tables', () => {
    const planRow = (extra) => ({ ...extra, result: { recurring: { services: [{ service: 'lawn_care', name: 'Lawn Care', mo: 46 }] } } });
    for (const inputs of [{ grassType: 'st_augustine' }, { grassType: 'bahia' }, { grassType: 'bermuda' }, { grassType: 'zoysia' }, {}]) {
      expect(() => guard(planRow({ inputs }))).toThrow(refused);
    }
    // Named only by the result key it sits under, or only in a note outside the inputs.
    expect(() => guard({ result: { lawn: [{ tier: 'enhanced', monthly: 46 }] } })).toThrow(refused);
    expect(() => guard({ result: { lawnMeta: { track: 'st_augustine' } } })).toThrow(refused);
    expect(() => guard({ notes: 'Added lawn care per customer request', result: { lineItems: [{ service: 'pest_control', price: 39 }] } })).toThrow(refused);
    const forged = planRow({ inputs: { grassType: 'st_augustine' } });
    forged.result.pricingMetadata = { legacyLawnOneLane: true };
    expect(() => guard(forged, forged)).toThrow(refused);
  });

  test('other turf services and the turf basis name no lawn price row', () => {
    for (const save of [
      { result: { oneTime: { specItems: [{ name: 'Lawn Plugging Service', price: 900 }] } } },
      { result: { property: { turfBasis: 'lawnSqFt' }, lineItems: [{ service: 'pest_control', price: 39 }] } },
      { result: { oneTime: { specItems: [{ service: 'dethatching', price: 300 }, { service: 'top_dressing', price: 400 }] } } },
    ]) expect(() => guard(save)).not.toThrow();
  });

  test('a save with no lawn row is not refused; its stamp is the server\'s reading: new on a first save, the stored estimate\'s on a revision', () => {
    const pestOnly = () => ({ result: { lineItems: [{ service: 'pest_control', price: 39 }], pricingMetadata: { legacyLawnOneLane: true } } });
    const first = pestOnly();
    guard(first);
    expect(first.result.pricingMetadata.legacyLawnOneLane).toBe(false);
    const revision = pestOnly();
    guard(revision, { engineResult: { lineItems: [{ service: 'lawn_care', annual: 552 }] } });
    expect(revision.result.pricingMetadata.legacyLawnOneLane).toBe(true);
  });
});

describe('the public price list', () => {
  const { computePublicPricingRanges } = require('../services/pricing-engine/public-ranges');
  const lawnRow = (ranges) => ranges.services.find((row) => row.key === 'lawn_care_program');

  test('the one-time lawn and lawn pest rows sweep no grass; the plan range still sweeps every plan grass', () => {
    const oneTimeSpy = jest.spyOn(sp, 'priceOneTimeLawn');
    const planSpy = jest.spyOn(sp, 'priceLawnCare');
    try {
      const ranges = computePublicPricingRanges({ refresh: true });
      expect(oneTimeSpy).toHaveBeenCalled();
      expect(oneTimeSpy.mock.calls.every(([, options]) => options.track === undefined)).toBe(true);
      const tracks = new Set(planSpy.mock.calls.map(([, options]) => options.track));
      for (const track of ['st_augustine', 'bermuda', 'zoysia']) expect(tracks.has(track)).toBe(true);
      expect(JSON.stringify(ranges)).not.toMatch(/grass type/i);
    } finally {
      oneTimeSpy.mockRestore();
      planSpy.mockRestore();
    }
  });

  test('an armed cost floor lifts a new zoysia plan above the St. Augustine rows: the published range still covers it', () => {
    const V = constants.LAWN_PRICING_V2;
    const saved = V.useLawnCostFloor;
    V.useLawnCostFloor = true;
    try {
      const zoysia = sp.priceLawnCare({ lawnSqFt: 11500 }, { track: 'zoysia', tier: 'enhanced' });
      const stAugustine = sp.priceLawnCare({ lawnSqFt: 11500 }, { track: 'st_augustine', tier: 'enhanced' });
      // The case the range has to cover: zoysia's own cost floor prices it above the shared market rows.
      expect(zoysia.selected.costFloorApplied).toBe(true);
      expect(zoysia.perApp).toBeGreaterThan(stAugustine.perApp);
      expect(lawnRow(computePublicPricingRanges({ refresh: true })).high).toBeGreaterThanOrEqual(zoysia.perApp);
    } finally {
      V.useLawnCostFloor = saved;
      computePublicPricingRanges({ refresh: true });
    }
  });
});
