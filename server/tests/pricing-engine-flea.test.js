const {
  generateEstimate,
  priceFlea,
  priceFleaExterior,
} = require('../services/pricing-engine');

describe('flea treatment pricing', () => {
  test('default base package stays at two visits and $350', () => {
    const result = priceFlea({
      services: { flea: true },
      footprintSqFt: 2000,
      lotSqFt: 7500,
    });

    expect(result).toMatchObject({
      service: 'flea_package',
      // Top-level name like every sibling one-time pricer — the public
      // breakdown labels a raw engine line from it (display.name alone
      // rendered the row as "One-Time Pest Control").
      name: 'Flea Elimination Package — 2 visits',
      offerKey: 'flea_elimination_two_visit',
      billingCadence: 'one_time',
      warrantyType: 'conditional_retreat',
      initial: 225,
      followUp: 125,
      total: 350,
      visits: 2,
      requiresCustomQuote: false,
    });
  });

  test('an explicit single-visit request prices the package but fails closed to review (owner ruling 2026-09-03: flea is two visits)', () => {
    const result = priceFlea({
      services: { flea: { offerKey: 'flea_knockdown_single' } },
      footprintSqFt: 2000,
      lotSqFt: 7500,
    });

    expect(result).toMatchObject({
      service: 'flea_package',
      offerKey: 'flea_elimination_two_visit',
      visits: 2,
      total: 350,
      warrantyType: 'conditional_retreat',
      guaranteeWindowDaysAfterFollowUp: 30,
      maxIncludedRetreats: 1,
      requiresManualReview: true,
    });
    expect(result.manualReviewReasons).toContain('flea_single_visit_offer_retired');
    expect(result.warnings.join(' ')).toMatch(/single-visit flea knockdown was requested/);
    // …and the review flag survives the engine's flea block.
    const viaEngine = generateEstimate({ homeSqFt: 2000, lotSqFt: 7500, services: { flea: { offerKey: 'flea_knockdown_single' } } });
    const line = viaEngine.lineItems.find((l) => l.service === 'flea_package');
    expect(line.requiresManualReview).toBe(true);
    // The default product carries no review flag.
    expect(priceFlea({ services: { flea: true }, footprintSqFt: 2000, lotSqFt: 7500 }).requiresManualReview).toBe(false);
  });

  test('an admin edit of the surviving offer can move prices but never the package contract', () => {
    const constants = require('../services/pricing-engine/constants');
    const saved = constants.SPECIALTY.flea.offers;
    constants.SPECIALTY.flea.offers = [{
      offerKey: 'flea_elimination_two_visit', service: 'flea_custom', visitCount: 1, warrantyType: 'none', guaranteeWindowDaysAfterFollowUp: 0,
      maxIncludedRetreats: 0, exteriorAddOnMode: 'initial_only', baseInitial: 240, baseFollowUp: 130,
    }];
    try {
      const result = priceFlea({ services: { flea: true }, footprintSqFt: 2000, lotSqFt: 7500 });
      expect(result).toMatchObject({
        service: 'flea_package', visits: 2, warrantyType: 'conditional_retreat', guaranteeWindowDaysAfterFollowUp: 30, maxIncludedRetreats: 1,
        initial: 240, followUp: 130, total: 370,
      });
      expect(result.display.name).toBe('Flea Elimination Package — 2 visits');
      expect(result.name).toBe(result.display.name);
      // Exterior add-on mode is part of the contract too: priced on BOTH visits.
      const exterior = priceFlea({ services: { flea: { fleaExterior: true } }, footprintSqFt: 2000, lotSqFt: 7500, fleaExteriorAreaSqFt: 4000, fleaExteriorAreaSource: 'CONFIRMED_SQ_FT' });
      expect(exterior.adjustments.exteriorArea.followUp).toBeGreaterThan(0);
    } finally {
      constants.SPECIALTY.flea.offers = saved;
    }
  });

  test.each([
    [0, 0],
    [2500, 125],
    [5000, 155],
    [7500, 195],
    [10000, 240],
    [15000, 325],
    [20000, 395],
  ])('prices exterior tier helper for %s sq ft', (area, total) => {
    expect(priceFleaExterior(area, { source: 'CONFIRMED_SQ_FT' }).total).toBe(total);
  });

  test('default package plus 5,000 sf exterior totals $505', () => {
    const result = priceFlea({
      services: { flea: true, fleaExterior: true },
      footprintSqFt: 2000,
      lotSqFt: 7500,
      fleaExteriorAreaSqFt: 5000,
      fleaExteriorAreaSource: 'CONFIRMED_SQ_FT',
    });

    expect(result.initial).toBe(320);
    expect(result.followUp).toBe(185);
    expect(result.total).toBe(505);
    expect(result.adjustments.exteriorArea.total).toBe(155);
    expect(result.display.exteriorDetail).toBe('Exterior flea spray — 5,000 sf');
  });

  test('suppresses lot-size adjustment when exterior spray has a valid priced area', () => {
    const largeLot = priceFlea({
      services: { flea: true, fleaExterior: true },
      footprintSqFt: 2000,
      lotSqFt: 25000,
      fleaExteriorAreaSqFt: 5000,
      fleaExteriorAreaSource: 'CONFIRMED_SQ_FT',
    });
    const defaultLot = priceFlea({
      services: { flea: true, fleaExterior: true },
      footprintSqFt: 2000,
      lotSqFt: 7500,
      fleaExteriorAreaSqFt: 5000,
      fleaExteriorAreaSource: 'CONFIRMED_SQ_FT',
    });

    expect(largeLot.total).toBe(defaultLot.total);
    expect(largeLot.adjustments.lot).toEqual({ initial: 0, followUp: 0 });
  });

  test('requires custom quote over 20,000 sq ft exterior spray area', () => {
    const result = priceFlea({
      services: { flea: true, fleaExterior: true },
      fleaExteriorAreaSqFt: 25000,
      fleaExteriorAreaSource: 'CONFIRMED_SQ_FT',
    });

    expect(result.requiresCustomQuote).toBe(true);
    expect(result.customQuoteReason).toContain('20,000');
    expect(result.customQuoteReason).toContain('custom quote');
  });

  test('unknown source does not auto-price exterior spray and returns confirmation warning', () => {
    const result = priceFlea({
      services: { flea: true, fleaExterior: true },
      footprintSqFt: 2000,
      lotSqFt: 7500,
      fleaExteriorAreaSqFt: 5000,
      fleaExteriorAreaSource: 'UNKNOWN',
    });

    expect(result.adjustments.exteriorArea.total).toBe(0);
    expect(result.total).toBe(350);
    expect(result.warning).toContain('confirmed treatable lawn area');
  });

  test('urgency premium is not reduced by recurring-customer discount', () => {
    const result = priceFlea({
      services: { flea: true, fleaExterior: true },
      footprintSqFt: 2000,
      lotSqFt: 7500,
      fleaExteriorAreaSqFt: 5000,
      fleaExteriorAreaSource: 'CONFIRMED_SQ_FT',
      urgency: 'SOON',
      isRecurringCustomer: true,
    });

    expect(result.raw.total).toBe(505);
    expect(result.modifiers).toEqual({
      urgencyMultiplier: 1.25,
      recurringCustomerMultiplier: 0.85,
      rushPremium: 126,
    });
    expect(result.total).toBe(555);
  });

  test('package floor applies after recurring-customer discount', () => {
    const result = priceFlea({
      services: { flea: true },
      footprintSqFt: 800,
      lotSqFt: 7500,
      isRecurringCustomer: true,
    });

    expect(result.raw.total).toBe(310);
    expect(result.total).toBe(280);
  });

  test('generateEstimate keeps server flea total authoritative without a second discount pass', () => {
    const estimate = generateEstimate({
      homeSqFt: 2000,
      stories: 1,
      lotSqFt: 7500,
      propertyType: 'single_family',
      services: {
        flea: {
          fleaExterior: true,
          fleaExteriorAreaSqFt: 5000,
          fleaExteriorAreaSource: 'CONFIRMED_SQ_FT',
        },
      },
    });
    const item = estimate.lineItems.find((line) => line.service === 'flea_package');

    expect(item.total).toBe(505);
    expect(item.totalAfterDiscount).toBe(505);
    expect(estimate.summary.oneTimeTotal).toBe(0);
    expect(estimate.summary.specialtyTotal).toBe(505);
  });

  describe('interior size is the home\'s total living area (owner ruling 2026-11-26 "whole home")', () => {
    const packageFor = (homeSqFt, stories, extra = {}) => generateEstimate({
      homeSqFt,
      stories,
      lotSqFt: 7500,
      propertyType: 'single_family',
      services: { flea: {} },
      ...extra,
    }).lineItems.find((line) => line.service === 'flea_package');

    test('a one-story home keeps its price at 1,200 / 2,000 / 3,000 / 4,000 sq ft', () => {
      expect([1200, 2000, 3000, 4000].map((sqft) => packageFor(sqft, 1).total)).toEqual([325, 350, 390, 415]);
    });

    test('a two-story 3,000 sq ft home prices like a one-story 3,000 sq ft home', () => {
      const twoStory = packageFor(3000, 2);
      const oneStory = packageFor(3000, 1);
      expect(twoStory).toMatchObject({ initial: 250, followUp: 140, total: 390, interiorSizeSqFt: 3000, fleaSizeBasis: 'total_living_area' });
      expect(twoStory.total).toBe(oneStory.total);
      expect(twoStory.footprintUsed).toBe(3000);
    });

    test('story count no longer moves the interior package', () => {
      const totals = [1, 2, 3].map((stories) => packageFor(2400, stories).total);
      expect(new Set(totals).size).toBe(1);
      expect(packageFor(4500, 2).total).toBe(415);
    });

    test('a living-area input beats a ground-floor footprint; a footprint alone scales by stories', () => {
      expect(priceFlea({ homeSqFt: 3000, stories: 2, footprint: 1500 }).footprintUsed).toBe(3000);
      expect(priceFlea({ footprintSqFt: 1500, stories: 2 })).toMatchObject({ footprintUsed: 3000, footprintSource: 'footprintSqFt', total: 390 });
      expect(priceFlea({ footprintSqFt: 2000 })).toMatchObject({ footprintUsed: 2000, total: 350 });
    });

    test('no usable size keeps the 2,000 fallback with manual review', () => {
      expect(priceFlea({ lotSqFt: 7500 })).toMatchObject({
        footprintUsed: 2000,
        footprintWasDefaulted: true,
        requiresManualReview: true,
        total: 350,
      });
    });

    test('an unknown-story association aggregate keeps the footprint-only rule', () => {
      const result = priceFlea({ homeSqFt: 90000, stories: 1, footprintUnknown: true });
      expect(result).toMatchObject({ footprintUsed: 2000, footprintWasDefaulted: true, requiresManualReview: true });
    });

    test('the exterior add-on is unchanged by home size or story count', () => {
      const exterior = { fleaExterior: true, fleaExteriorAreaSqFt: 5000, fleaExteriorAreaSource: 'CONFIRMED_SQ_FT' };
      const oneStory = packageFor(3000, 1, { services: { flea: exterior } });
      const twoStory = packageFor(3000, 2, { services: { flea: exterior } });
      expect(oneStory.adjustments.exteriorArea).toMatchObject({ initial: 95, followUp: 60, total: 155 });
      expect(twoStory.adjustments.exteriorArea).toEqual(oneStory.adjustments.exteriorArea);
      expect(twoStory.total).toBe(oneStory.total);
    });

    test('the legacy ground-floor basis (replay of a sent estimate) keeps the old price', () => {
      const legacy = (homeSqFt, stories) => generateEstimate({
        homeSqFt, stories, lotSqFt: 7500, propertyType: 'single_family',
        services: { flea: {} },
        fleaSizeBasisReplay: 'ground_floor',
      }).lineItems.find((line) => line.service === 'flea_package');
      expect(legacy(3000, 2)).toMatchObject({ total: 342, footprintUsed: 1500, fleaSizeBasis: 'ground_floor' });
      expect(legacy(4500, 2).total).toBe(362);
      expect(legacy(3000, 1).total).toBe(390);
    });

    describe('size provenance: what each input means (pre-push audit)', () => {
      const flea = (extra, replay) => generateEstimate({
        lotSqFt: 7500, propertyType: 'single_family', services: { flea: {} }, ...extra,
        ...(replay ? { fleaSizeBasisReplay: 'ground_floor' } : {}),
      }).lineItems.find((line) => line.service === 'flea_package');
      const flags = (line) => ({ review: line.requiresManualReview, defaulted: line.footprintWasDefaulted, reasons: line.manualReviewReasons });

      test('a public quote with no measured sq ft keeps exactly the review flags it had before the change', () => {
        for (const stories of [1, 2]) {
          const extra = { homeSqFt: 2000, stories, buildingSizeMeasured: false };
          expect(flags(flea(extra))).toEqual(flags(flea(extra, true)));
        }
        // The 2,000 default is the whole home: a second story no longer halves it.
        expect(flea({ homeSqFt: 2000, stories: 2, buildingSizeMeasured: false }).total).toBe(350);
      });

      test('a supplied footprint (the Intelligence Bar termite override) never beats a real living area', () => {
        // buildingSizeMeasured is false when the tool omits it, even beside a real homeSqFt.
        const extra = { homeSqFt: 3000, stories: 2, footprintSqFt: 1000, buildingSizeMeasured: false };
        expect(flea(extra)).toMatchObject({ footprintUsed: 3000, total: 390 });
        expect(flea({ homeSqFt: 3000, livingAreaSqFt: 2100, stories: 2, footprintSqFt: 1000 })).toMatchObject({ footprintUsed: 3000 });
      });

      test('livingAreaSqFt is read as a living area when homeSqFt is absent', () => {
        expect(flea({ livingAreaSqFt: 2100, stories: 2, footprintSqFt: 1000 })).toMatchObject({ footprintUsed: 2100, footprintSource: 'livingAreaSqFt' });
      });

      test('an Intelligence Bar buildingSqFt-only quote (aliased into homeSqFt) is read as a living area, never multiplied by stories', () => {
        // The lookup credential certifies buildingSqFt from the property home_sqft (a living area), so the alias is
        // ambiguous and is read the way that never inflates a quote.
        const ib = { homeSqFt: 1500, buildingSqFt: 1500, stories: 2 };
        expect(flea(ib)).toMatchObject({ footprintUsed: 1500, total: 342 });
        // ...but a person confirms the total living area: the line routes to review with the same price.
        expect(flea(ib)).toMatchObject({ requiresManualReview: true, manualReviewReasons: expect.arrayContaining(['flea_home_size_source_unclear']) });
        expect(flea(ib).warnings.join(' ')).toMatch(/ground floor only/);
        // One story: the footprint IS the living area, no flag. A real living area on two stories: no flag.
        expect(flea({ ...ib, stories: 1 })).toMatchObject({ requiresManualReview: false });
        expect(flea({ ...ib, stories: 1 }).manualReviewReasons).not.toContain('flea_home_size_source_unclear');
        expect(flea({ homeSqFt: 3000, stories: 2 }).manualReviewReasons).not.toContain('flea_home_size_source_unclear');
        expect(flea({ homeSqFt: 3000, buildingSqFt: 1500, stories: 2 }).manualReviewReasons).not.toContain('flea_home_size_source_unclear');
        expect(flea({ ...ib, livingAreaSqFt: 1500 }).manualReviewReasons).not.toContain('flea_home_size_source_unclear');
        // A conflicting explicit living area wins over the alias and clears the review (the verified area is used).
        expect(flea({ ...ib, livingAreaSqFt: 3000 })).toMatchObject({ footprintUsed: 3000, footprintSource: 'livingAreaSqFt', total: 390 });
        expect(flea({ ...ib, livingAreaSqFt: 3000 }).manualReviewReasons).not.toContain('flea_home_size_source_unclear');
        // compute_estimate (alias in homeSqFt) and the draft path (buildingSqFt alone) price the same measurements the same way,
        // flags included, with and without a supplied footprint.
        for (const extra of [{}, { footprintSqFt: 1500 }, { livingAreaSqFt: 3000 }]) {
          const compute = flea({ homeSqFt: 1500, buildingSqFt: 1500, stories: 2, ...extra });
          const draft = flea({ buildingSqFt: 1500, stories: 2, ...extra });
          expect({ total: compute.total, used: compute.footprintUsed, review: compute.requiresManualReview, reasons: compute.manualReviewReasons })
            .toEqual({ total: draft.total, used: draft.footprintUsed, review: draft.requiresManualReview, reasons: draft.manualReviewReasons });
        }
        // A building value beats a supplied footprint: footprint x stories is only for a true footprint-only input.
        expect(flea({ buildingSqFt: 1500, footprintSqFt: 1500, stories: 2 })).toMatchObject({ total: 342, footprintUsed: 1500, requiresManualReview: true });
        // homeSqFt equal to buildingSqFt never falls through to footprint x stories (2,200 priced as 3,200 before).
        const audit = flea({ homeSqFt: 2200, footprintSqFt: 1600, buildingSqFt: 2200, stories: 2 });
        expect(audit).toMatchObject({ footprintUsed: 2200, total: 359, requiresManualReview: true });
        expect(audit.manualReviewReasons).toContain('flea_home_size_source_unclear');
        expect(flea({ homeSqFt: 2200, footprintSqFt: 1600, stories: 2 })).toMatchObject({ footprintUsed: 2200, total: 359, requiresManualReview: false });
        // A partial upper story (the tool accepts fractional stories) is still ambiguous.
        expect(flea({ buildingSqFt: 1500, stories: 1.5 }).manualReviewReasons).toContain('flea_home_size_source_unclear');
        // The ground-floor replay of a sent estimate never gains the flag (its price and flags stay as sent).
        expect(flea(ib, true).manualReviewReasons).not.toContain('flea_home_size_source_unclear');
        // An explicitly supplied footprint with no living area is a ground floor: scaled by stories.
        expect(flea({ footprintSqFt: 1500, stories: 2 })).toMatchObject({ footprintUsed: 3000, total: 390 });
      });

      test('an Intelligence Bar quote with living area and two stories prices the whole home', () => {
        expect(flea({ homeSqFt: 3000, stories: 2 })).toMatchObject({ footprintUsed: 3000, total: 390 });
        expect(flea({ homeSqFt: 3000, stories: 2 }, true).total).toBe(342);
      });

      test('an aggregate or condo with footprintUnknown keeps the old flags and sizes', () => {
        for (const extra of [{ homeSqFt: 90000, stories: 1 }, { homeSqFt: 90000, stories: 1, footprintSqFt: 1200 }]) {
          const inputs = { ...extra, footprintUnknown: true };
          expect(flags(flea(inputs))).toEqual(flags(flea(inputs, true)));
          expect(flea(inputs).footprintUsed).toBe(flea(inputs, true).footprintUsed);
          expect(flea(inputs).total).toBe(flea(inputs, true).total);
        }
      });
    });
  });
});
