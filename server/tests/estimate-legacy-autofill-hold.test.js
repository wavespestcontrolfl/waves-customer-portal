/**
 * Send-time hold for a stored estimate-tool price the 2026-09-26 lookup
 * guards refuse (#4862 / #4871 / #4878). Mirrors the estimate tool's reopen
 * scrub (client/src/lib/lookupPrefill.js) — the same fixtures hold here.
 */
const { legacyAutofillPriceReasons, rowHeldForLegacyAutofillPrice } = require('../services/estimate-legacy-autofill-hold');
const { rowPassesGatedSendAuthority } = require('../services/pricing-authority-gate');

const UNIT = { residentialUnitLookup: { wholePropertyCategory: 'RESIDENTIAL' } };
const UNIT_PARCEL = { lotSqFt: 400000, fieldVerifyFlags: [{ field: 'lotSize', scope: 'unit_parcel' }] };
const pest = (extra = {}) => ({ service: 'pest_control', name: 'Pest Control', mo: 50, ...extra });
const saved = (inputs, profile = {}, lines = [pest()]) => ({
  inputs, engineRequest: { profile }, result: { recurring: { services: lines }, oneTime: { items: [] } },
});

describe('legacyAutofillPriceReasons', () => {
  test('holds a price the engine guessed at a 2,000 sq ft house, never a quote-required or overridden line', () => {
    expect(legacyAutofillPriceReasons(saved({}, {}, [pest({ footprintWasDefaulted: true })])))
      .toEqual(['a guessed 2,000 sq ft home size (enter home sq ft)']);
    expect(legacyAutofillPriceReasons(saved({}, { footprintUnknown: true }, [pest({ footprintWasDefaulted: true })])))
      .toEqual(['a guessed home footprint (enter the number of stories)']);
    expect(legacyAutofillPriceReasons(saved({}, {}, [
      pest({ footprintWasDefaulted: true, quoteRequired: true }),
      pest({ footprintWasDefaulted: true, priceOverridden: true }),
    ]))).toEqual([]);
  });

  test('holds a condo unit priced on footprint trenching or auto-derived termite boxes — not once retyped a house', () => {
    expect(legacyAutofillPriceReasons(saved({ propertyType: 'Condo', svcTrenching: true, trenchingEstimateFromFootprint: true }, UNIT)))
      .toEqual(["a trenching perimeter estimated from one unit's footprint"]);
    expect(legacyAutofillPriceReasons(saved({ propertyType: 'Condo', termiteFootprintSqFt: '725', _termiteFootprintAuto: true }, UNIT)))
      .toEqual(['termite measurements the lookup derived from one unit']);
    expect(legacyAutofillPriceReasons(saved({ propertyType: 'Condo', trenchingPerimeterLF: '140', _trenchingPerimeterAuto: false }, UNIT)))
      .toEqual([]);
    expect(legacyAutofillPriceReasons(saved({ propertyType: 'Single Family', termiteFootprintSqFt: '1200', _termiteFootprintAuto: true }, UNIT)))
      .toEqual([]);
  });

  test("holds the development's lot, bed and flea areas the lookup filled — never typed ones", () => {
    expect(legacyAutofillPriceReasons(saved({ lotSqFt: '400000', bedArea: '6000', fleaExteriorAreaSqFt: '25000', fleaExteriorAreaSource: 'AI_ESTIMATE' }, UNIT_PARCEL)))
      .toEqual(["the development's lot size", "the lookup's bed area for the development", "a flea exterior area copied from the development's lawn"]);
    expect(legacyAutofillPriceReasons(saved({
      lotSqFt: '1500', _lotSqFtEdited: true, bedArea: '200', fleaExteriorAreaSqFt: '900', fleaExteriorAreaSource: 'AI_ESTIMATE',
      _manualFields: ['lotSqFt', 'bedArea', 'fleaExteriorAreaSqFt'],
    }, { ...UNIT_PARCEL, estimatedBedAreaSf: 200, bedAreaSource: 'manual' }))).toEqual([]);
  });

  test("holds a priced profile still carrying the parcel's turf, bed or hardscape reads — a stored 0% included", () => {
    const typedLot = { lotSqFt: '1500', _lotSqFtEdited: true };
    for (const read of [{ estimatedTurfSf: 25000 }, { imperviousSurfacePercent: 0 }, { estimatedBedAreaSf: 6000, bedAreaSource: 'estimated' }]) {
      expect(legacyAutofillPriceReasons(saved(typedLot, { ...UNIT_PARCEL, ...read })))
        .toEqual(["lawn and bed areas from the development's parcel"]);
    }
    // The scoped profile a post-fix save persists carries none of them.
    expect(legacyAutofillPriceReasons(saved(typedLot, { ...UNIT_PARCEL, estimatedBedAreaSf: 0 }))).toEqual([]);
  });

  test('judges builder-saved rows only — an engine draft has no form snapshot', () => {
    expect(legacyAutofillPriceReasons({ engineRequest: { profile: {} }, result: { recurring: { services: [pest({ footprintWasDefaulted: true })] } } }))
      .toEqual([]);
    expect(legacyAutofillPriceReasons(null)).toEqual([]);
  });
});

describe('rowHeldForLegacyAutofillPrice — the shared row verdict (codex r1 P1 #4941)', () => {
  const guessed = saved({ svcPest: true, lotSqFt: '9000' }, {}, [pest({ footprintWasDefaulted: true })]);

  test('holds a legacy row, parsed from the stored string, and the shared authority verdict refuses it', () => {
    const row = { status: 'sent', pricing_authority: 'SERVER', estimate_data: JSON.stringify(guessed) };
    expect(rowHeldForLegacyAutofillPrice(row)).toBe(true);
    // Every follow-up / engagement / renewal / composer rail asks this verdict.
    expect(rowPassesGatedSendAuthority(row)).toBe(false);
    expect(rowPassesGatedSendAuthority({ ...row, estimate_data: saved({ homeSqFt: '2400' }) })).toBe(true);
  });

  test('exempts an authored proposal and a price the customer already accepted', () => {
    expect(rowHeldForLegacyAutofillPrice({ status: 'sent', estimate_data: { ...guessed, proposal: { enabled: true } } })).toBe(false);
    expect(rowHeldForLegacyAutofillPrice({ status: 'accepted', estimate_data: guessed })).toBe(false);
    expect(rowHeldForLegacyAutofillPrice({ status: 'sent', price_locked_at: new Date(), estimate_data: guessed })).toBe(false);
  });
});

describe('estimateDeliverableUnderGate with GATE_SEND_REQUIRES_SERVER_PRICING off (pre-push P1 #4941)', () => {
  const guessed = saved({ svcPest: true, lotSqFt: '9000' }, {}, [pest({ footprintWasDefaulted: true })]);
  const clean = saved({ homeSqFt: '2400' });
  const siblingsDb = (rows) => {
    const qb = { where: () => qb, whereNot: () => qb, whereNull: () => qb, whereRaw: () => qb, whereIn: () => qb,
      orWhereIn: () => qb, orWhere: () => qb, select: async () => rows };
    qb.where = (arg) => (typeof arg === 'function' ? (arg(qb), qb) : qb);
    return () => qb;
  };
  const withGateOff = async (fn) => {
    const prior = process.env.GATE_SEND_REQUIRES_SERVER_PRICING;
    delete process.env.GATE_SEND_REQUIRES_SERVER_PRICING;
    jest.resetModules();
    try { return await fn(require('../services/pricing-authority-gate')); } finally {
      if (prior === undefined) delete process.env.GATE_SEND_REQUIRES_SERVER_PRICING; else process.env.GATE_SEND_REQUIRES_SERVER_PRICING = prior;
      jest.resetModules();
    }
  };

  test('still refuses a legacy row, read-free; passes everything else', () => withGateOff(async (gate) => {
    expect(gate.gatedSendAuthorityPredicateApplies()).toBe(false);
    const database = jest.fn();
    expect(await gate.estimateDeliverableUnderGate(database, { id: 'a', status: 'sent', estimate_group_id: 'g', estimate_data: guessed })).toBe(false);
    expect(await gate.estimateDeliverableUnderGate(database, { id: 'a', status: 'sent', pricing_authority: 'CLIENT_FALLBACK', estimate_data: clean })).toBe(true);
    expect(database).not.toHaveBeenCalled();
  }));

  test('gate on, a group whose link-visible sibling is legacy is refused', async () => {
    const prior = process.env.GATE_SEND_REQUIRES_SERVER_PRICING;
    process.env.GATE_SEND_REQUIRES_SERVER_PRICING = 'true';
    jest.resetModules();
    try {
      const gate = require('../services/pricing-authority-gate');
      expect(await gate.estimateDeliverableUnderGate(siblingsDb([{ id: 'b', status: 'sent', pricing_authority: 'SERVER', estimate_data: guessed }]),
        { id: 'a', status: 'sent', pricing_authority: 'SERVER', estimate_group_id: 'g', estimate_data: clean })).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.GATE_SEND_REQUIRES_SERVER_PRICING; else process.env.GATE_SEND_REQUIRES_SERVER_PRICING = prior;
      jest.resetModules();
    }
  });
});
