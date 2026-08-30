const {
  generateEstimate,
  priceRodentTrapping,
  priceRodentTrappingFollowups,
  priceTrapOnlyRetainer,
  priceRodentWireMesh,
  priceRodentBirdBoxes,
  priceRodentExclusionV2,
  applyRodentBundle,
  calculateRodentGuaranteeCombo,
} = require('../services/pricing-engine');

function baseInput(overrides = {}) {
  return {
    homeSqFt: 2000,
    stories: 1,
    lotSqFt: 10000,
    propertyType: 'single_family',
    zone: 'A',
    features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
    ...overrides,
  };
}

describe('revised rodent pricing rules', () => {
  test('trapping is Standard-only: flat $350, emergency surcharge on top', () => {
    expect(priceRodentTrapping(baseInput(), { plan: 'standard' }).price).toBe(350);
    expect(priceRodentTrapping(baseInput(), { plan: 'standard', emergency: true }).price).toBe(425);
    // Large home / large lot: still flat — no footprint or lot adjustments.
    expect(priceRodentTrapping(
      baseInput({ homeSqFt: 5200, lotSqFt: 30000 }),
      { plan: 'standard' }
    ).price).toBe(350);
  });

  test('legacy plan/upgrade/callback-count inputs still price the flat Standard plan', () => {
    const fromUnlimited = priceRodentTrapping(baseInput(), { plan: 'unlimited' });
    expect(fromUnlimited.price).toBe(350);
    expect(fromUnlimited.name).toBe('Rodent Trapping - Standard');
    expect(fromUnlimited.rodentTrappingPlan).toBe('standard');
    expect(fromUnlimited.unlimitedCallbacks).toBe(true);

    expect(priceRodentTrapping(baseInput(), { upgradeToUnlimited: true }).price).toBe(350);
  });

  test('callbacks are unlimited — callback counts never bill', () => {
    expect(priceRodentTrapping(baseInput(), { extraCallbackCount: 0 }).price).toBe(350);
    expect(priceRodentTrapping(baseInput(), { callbacksUsed: 2, extraCallbackCount: 2 })).toMatchObject({
      price: 350,
      extraCallbackAllowed: false,
      extraCallbackPrice: 0,
      unlimitedCallbacks: true,
      includedCallbacks: 'unlimited',
    });
    const withRequestedExtras = priceRodentTrapping(baseInput(), { callbacksUsed: 2, extraCallbackCount: 1 });
    expect(withRequestedExtras.warnings.join(' ')).toMatch(/no longer apply/i);
    expect(priceRodentTrappingFollowups(1, { callbacksUsed: 2 })).toMatchObject({
      price: 0,
      included: true,
      unlimitedCallbacks: true,
    });
  });

  test('invoice descriptions use revised trapping copy', () => {
    const standard = priceRodentTrapping(baseInput(), { plan: 'standard' });

    expect(standard.invoiceDescription).toMatch(/unlimited callbacks\/checks/i);
    expect(standard.invoiceDescription).toContain('same active trapping job');
    expect(standard.invoiceDescription).not.toContain('$125');
    // Owner 2026-08-27: the line reads as the plan's promise, not a recap of
    // "Standard: initial setup plus …".
    expect(standard.invoiceDescription).not.toMatch(/initial setup plus/i);
    expect(standard.invoiceDescription).not.toMatch(/Standard:/);
  });

  test('trap-only retainer plans, setup waiver, warranty, and callbacks', () => {
    const annualRetainer = priceTrapOnlyRetainer({ plan: 'standard', billing: 'annual' });
    expect(annualRetainer).toMatchObject({
      price: 495,
      trapOnlyRetainerAnnualPrice: 495,
      trapOnlySetupFee: 0,
      warrantyEligible: false,
      // The discount-exclusion contract: coupon/bundle exclusion flags are
      // read by isManualOneTimeDiscountEligible; WaveGuard exclusion rides
      // discountEligible:false (the estimate-public line predicates) — the
      // old excludedFromWaveGuardDiscounts field was write-only and was
      // removed in the 2026-08-10 eligibility consolidation.
      discountEligible: false,
      excludedFromCoupons: true,
      excludedFromBundleDiscounts: true,
    });
    expect(annualRetainer).not.toHaveProperty('excludedFromWaveGuardDiscounts');
    expect(priceTrapOnlyRetainer({ plan: 'standard', billing: 'monthly' })).toMatchObject({
      price: 248,
      trapOnlyRetainerMonthlyPrice: 49,
      trapOnlySetupFee: 199,
    });
    expect(priceTrapOnlyRetainer({ plan: 'plus', billing: 'annual' }).price).toBe(695);
    expect(priceTrapOnlyRetainer({ plan: 'monthly', billing: 'annual' }).price).toBe(995);
    expect(priceTrapOnlyRetainer({ plan: 'standard', billing: 'monthly', attachedToCompletedTrappingJob: true }).trapOnlySetupFee).toBe(0);
    expect(priceTrapOnlyRetainer({
      plan: 'standard',
      billing: 'annual',
      responseCallbacksUsed: 2,
      extraCallbackCount: 1,
    }).price).toBe(620);
  });

  test('wire mesh linear-foot pricing uses substrate minimums', () => {
    expect(priceRodentWireMesh({ meshLinearFeet: 10, meshSubstrate: 'wood_soft' }).price).toBe(195);
    expect(priceRodentWireMesh({ meshLinearFeet: 20, meshSubstrate: 'wood_soft' }).price).toBe(280);
    expect(priceRodentWireMesh({ meshLinearFeet: 10, meshSubstrate: 'concrete_masonry' }).price).toBe(250);
    expect(priceRodentWireMesh({ meshLinearFeet: 20, meshSubstrate: 'concrete_masonry' }).price).toBe(400);
    expect(priceRodentWireMesh({ meshLinearFeet: 10, meshSubstrate: 'roofline_soffit_eave' }).price).toBe(275);
    expect(priceRodentWireMesh({ meshLinearFeet: 20, meshSubstrate: 'roofline_soffit_eave' }).price).toBe(480);
    expect(priceRodentWireMesh({ meshLinearFeet: 10, meshSubstrate: 'tile_steep_fragile_roofline' })).toMatchObject({
      price: 395,
      customQuoteRecommended: true,
    });
  });

  test('bird box unit pricing handles same-visit standard discounts', () => {
    expect(priceRodentBirdBoxes({ birdBoxType: 'standard_bird_box', birdBoxQuantity: 1 }).price).toBe(225);
    expect(priceRodentBirdBoxes({ birdBoxType: 'standard_bird_box', birdBoxQuantity: 3 }).price).toBe(575);
    expect(priceRodentBirdBoxes({ birdBoxType: 'small_bird_box', birdBoxQuantity: 1 }).price).toBe(195);
    expect(priceRodentBirdBoxes({ birdBoxType: 'large_bird_box', birdBoxQuantity: 1 }).price).toBe(295);
    expect(priceRodentBirdBoxes({ birdBoxType: 'oversized_complex_custom', birdBoxQuantity: 1 }).price).toBe(395);
  });

  test('bundle floors do not reduce fixed trapping floors or trap-only retainers', () => {
    expect(applyRodentBundle(350, { kind: 'trapExclusion', discount: 0.07, floor: 350 })).toMatchObject({
      discounted: 350,
      savings: 0,
    });
    expect(applyRodentBundle(450, { kind: 'trapExclusion', discount: 0.07, floor: 450 })).toMatchObject({
      discounted: 450,
      savings: 0,
    });

    const estimate = generateEstimate(baseInput({
      services: {
        rodentTrapping: { plan: 'standard' },
        trapOnlyRetainer: { plan: 'standard', billing: 'annual' },
      },
    }));
    expect(estimate.lineItems.find(i => i.service === 'rodent_bundle_discount')).toBeUndefined();
    expect(estimate.lineItems.find(i => i.service === 'trap_only_retainer').price).toBe(495);
  });

  test('rodent bait brackets: footprint resolves the station allowance and per-visit price', () => {
    // 2,000 sf footprint → 1,751–2,750 bracket: 5 stations, $89/quarterly visit.
    const estimate = generateEstimate(baseInput({ services: { rodentBait: {} } }));
    const bait = estimate.lineItems.find(i => i.service === 'rodent_bait');
    expect(bait.perApp).toBe(89);
    expect(bait.stations).toBe(5);
    expect(bait.visitsPerYear).toBe(4);
    expect(bait.annual).toBe(356);
    expect(bait.excludeFromPctDiscount).toBe(false);

    // ≤1,750 bracket.
    const small = generateEstimate(baseInput({ homeSqFt: 1500, services: { rodentBait: {} } }))
      .lineItems.find(i => i.service === 'rodent_bait');
    expect(small.perApp).toBe(79);
    expect(small.stations).toBe(4);

    // Above 6,750 sf the ladder EXTENDS: +1 station / +$10 per 1,000 sf
    // (owner ruling 2026-08-29) — never a manual quote on size alone.
    const oversized = generateEstimate(baseInput({ homeSqFt: 8000, services: { rodentBait: {} } }))
      .lineItems.find(i => i.service === 'rodent_bait');
    expect(oversized.perApp).toBe(149); // 129 + 2 steps × $10
    expect(oversized.stations).toBe(11);
    expect(oversized.quoteRequired).toBeFalsy();
  });

  test('rodent bait is a full WaveGuard member: tier-counted, tier-discounted; manual coupon still excluded', () => {
    // Rodent-only = 1 qualifying service = Bronze 0%, and the $99
    // non-member setup fee fires.
    const solo = generateEstimate(baseInput({
      services: { rodentBait: {} },
      manualDiscount: { type: 'PERCENT', value: 50, label: 'Half off' },
    }));
    const soloBait = solo.lineItems.find(i => i.service === 'rodent_bait');
    expect(solo.waveGuard.qualifyingCount).toBe(1);
    expect(solo.waveGuard.activeServices).toEqual(['rodent_bait']);
    expect(soloBait.discount.effectiveDiscount).toBe(0);
    // Manual recurring discounts stay scoped to the four core programs.
    expect(solo.summary.manualDiscount.amount).toBe(0);
    const soloSetup = solo.lineItems.find(i => i.service === 'rodent_bait_setup');
    expect(soloSetup.price).toBe(99);
    // The recurring rodent line makes this customer a recurring customer,
    // but the flat setup fee is excluded from the one-time 15% perk (codex
    // #3591 r2 P1: it was billing $84.15).
    expect(soloSetup.priceAfterDiscount ?? soloSetup.price).toBe(99);

    // Rodent + pest = Silver: BOTH lines take the 10% tier discount and the
    // setup fee is waived (WaveGuard member).
    const member = generateEstimate(baseInput({
      services: { pest: { frequency: 'quarterly' }, rodentBait: {} },
    }));
    const memberBait = member.lineItems.find(i => i.service === 'rodent_bait');
    expect(member.waveGuard.tier).toBe('silver');
    expect(memberBait.discount.effectiveDiscount).toBe(0.10);
    expect(memberBait.annualAfterDiscount).toBeCloseTo(320.4, 2);
    expect(member.lineItems.find(i => i.service === 'rodent_bait_setup')).toBeUndefined();

    // An EXISTING member (prior qualifying service) adding rodent bait alone
    // reaches Silver and skips the setup fee too.
    const existing = generateEstimate(baseInput({
      services: { rodentBait: {} },
      priorQualifyingServices: ['lawn_care'],
    }));
    const existingBait = existing.lineItems.find(i => i.service === 'rodent_bait');
    expect(existing.waveGuard.tier).toBe('silver');
    expect(existingBait.discount.effectiveDiscount).toBe(0.10);
    expect(existing.lineItems.find(i => i.service === 'rodent_bait_setup')).toBeUndefined();
  });

  test('legacy replay pin reproduces the stored price with the full legacy posture', () => {
    // Residential: a pre-realignment estimate pinned at $49/mo must replay
    // at exactly that figure — monthly-billed, no tier count, no discount,
    // and NO new $99 setup line appended to the old quote.
    const replay = generateEstimate(baseInput({
      services: { pest: { frequency: 'quarterly' }, rodentBait: {} },
      rodentBaitLegacyReplay: { monthly: 49 },
    }));
    const bait = replay.lineItems.find(i => i.service === 'rodent_bait');
    expect(bait.monthly).toBe(49);
    expect(bait.annual).toBe(588);
    expect(bait.legacyPinnedReplay).toBe(true);
    // Legacy posture: rodent does NOT join the tier on a pinned replay, so
    // the pest line keeps its originally disclosed Bronze pricing.
    expect(replay.waveGuard.activeServices).toEqual(['pest_control']);
    expect(replay.lineItems.find(i => i.service === 'rodent_bait_setup')).toBeUndefined();

    // The MAPPED result keeps the legacy shape (codex #3591 r3 P0): no
    // perApplicationBilled/stations marker on the pinned row, so a
    // persisted recompute still reads as legacy and the pin survives the
    // next view/accept.
    const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
    const { rodentBaitLegacyReplaySignal } = require('../services/rodent-bait-legacy-replay');
    const mapped = mapV1ToLegacyShape(replay);
    const mappedRodentRow = mapped.recurring.services.find(s => s.service === 'rodent_bait');
    expect(mappedRodentRow.perApplicationBilled).toBeUndefined();
    expect(mappedRodentRow.legacyPinnedReplay).toBe(true);
    expect(mappedRodentRow.waveGuardDiscountEligible).toBe(false);
    expect(rodentBaitLegacyReplaySignal({ result: mapped })).toEqual({ monthly: 49 });

    // Silver+ replay (codex #3591 r9 P0): a pinned $49/mo row with pest on
    // the estimate and a prior lawn plan reaches Silver — the pinned line
    // must keep its disclosed $588/yr (no tier %), while pest takes Silver.
    const silverReplay = generateEstimate(baseInput({
      services: { pest: { frequency: 'quarterly' }, rodentBait: {} },
      priorQualifyingServices: ['lawn_care'],
      rodentBaitLegacyReplay: { monthly: 49 },
    }));
    expect(silverReplay.waveGuard.tier).toBe('silver');
    const silverBait = silverReplay.lineItems.find(i => i.service === 'rodent_bait');
    expect(silverBait.annualAfterDiscount).toBe(588);
    expect(silverBait.monthlyAfterDiscount).toBe(49);
    expect(silverBait.discount.effectiveDiscount).toBe(0);
    const silverPest = silverReplay.lineItems.find(i => i.service === 'pest_control');
    expect(silverPest.discount.effectiveDiscount).toBeGreaterThan(0);
    expect(silverReplay.summary.recurringAnnualAfterDiscount).toBe(
      Math.round((silverPest.annualAfterDiscount + 588) * 100) / 100,
    );

    // Commercial: pin the stored cost-buildup annual exactly.
    const commercialReplay = generateEstimate(baseInput({
      propertyType: 'commercial',
      isCommercial: true,
      commercialSubtype: 'office',
      buildingSizeMeasured: true,
      homeSqFt: 20000,
      services: { rodentBait: {} },
      rodentBaitLegacyReplay: { commercialAnnual: 1080.61, commercialVisits: 4 },
    }));
    const commLine = commercialReplay.lineItems.find(i => i.service === 'commercial_rodent_bait');
    expect(commLine.annual).toBe(1080.61);
    expect(commLine.pricingBasis).toBe('LEGACY_PINNED_REPLAY');
  });

  test('the mapped new-model rodent row carries the LIVE eligibility flags the pricer stamped (codex #3591 r22 P1)', () => {
    const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
    const constants = require('../services/pricing-engine/constants');
    const original = { tq: constants.RODENT.tierQualifier, ex: constants.RODENT.excludeFromPctDiscount };
    try {
      constants.RODENT.tierQualifier = false;
      constants.RODENT.excludeFromPctDiscount = true;
      const mapped = mapV1ToLegacyShape(generateEstimate(baseInput({ services: { pest: { frequency: 'quarterly' }, rodentBait: {} } })));
      const row = mapped.recurring.services.find(s => s.service === 'rodent_bait');
      expect(row).toMatchObject({ perApplicationBilled: true, tierQualifier: false, countsTowardWaveGuardTier: false, excludeFromPctDiscount: true, discountable: false, waveGuardDiscountEligible: false });
    } finally {
      constants.RODENT.tierQualifier = original.tq;
      constants.RODENT.excludeFromPctDiscount = original.ex;
    }
    // Defaults: a plain new-model row carries no opt-out flags.
    const plain = mapV1ToLegacyShape(generateEstimate(baseInput({ services: { rodentBait: {} } })))
      .recurring.services.find(s => s.service === 'rodent_bait');
    expect(plain.perApplicationBilled).toBe(true);
    // Default posture is persisted EXPLICITLY (codex #3591 r46 P1) so the
    // replay signal can freeze it — a later flag flip never re-prices the
    // saved estimate.
    expect(plain).toEqual(expect.objectContaining({
      tierQualifier: true, countsTowardWaveGuardTier: true,
      excludeFromPctDiscount: false, waveGuardDiscountEligible: true,
    }));
    const { rodentWaveguardPostureReplaySignal } = require('../services/rodent-bait-legacy-replay');
    expect(rodentWaveguardPostureReplaySignal({ result: { recurring: { services: [plain] } } }))
      .toEqual({ tierQualifier: true, excludeFromPctDiscount: false });
  });

  test('commercial rodent detail states the MONTHLY figure (commercial bills monthly) — never a per-application price (codex #3591 r10 P2)', () => {
    const commercial = generateEstimate(baseInput({
      propertyType: 'commercial',
      isCommercial: true,
      commercialSubtype: 'office',
      buildingSizeMeasured: true,
      homeSqFt: 3000,
      services: { rodentBait: {} },
    }));
    const line = commercial.lineItems.find(i => i.service === 'commercial_rodent_bait');
    expect(line.quoteRequired).toBeFalsy();
    expect(line.detail).toContain(`$${line.monthly}/mo, billed monthly (4 applications per year)`);
    expect(line.detail).not.toMatch(/per application\./);
  });

  test('rodentBaitLegacyReplaySignal pins legacy stored shapes and never new-model rows', () => {
    const { rodentBaitLegacyReplaySignal } = require('../services/rodent-bait-legacy-replay');
    // Legacy scalar-only estimate → pin.
    expect(rodentBaitLegacyReplaySignal({
      result: { recurring: { rodentBaitMo: 49, services: [{ service: 'pest_control', mo: 50 }] } },
    })).toEqual({ monthly: 49 });
    // New-model row (marker/stations) → replay live.
    expect(rodentBaitLegacyReplaySignal({
      result: { recurring: { rodentBaitMo: 29.67, services: [{ service: 'rodent_bait', mo: 29.67, stations: 5, perApplicationBilled: true }] } },
    })).toBe(null);
    // Legacy commercial line → pin its stored annual.
    expect(rodentBaitLegacyReplaySignal({
      result: { lineItems: [{ service: 'commercial_rodent_bait', annual: 1080.61, visitsPerYear: 4 }], recurring: {} },
    })).toEqual({ commercialAnnual: 1080.61, commercialVisits: 4 });
    // No rodent at all → nothing.
    expect(rodentBaitLegacyReplaySignal({
      result: { recurring: { services: [{ service: 'pest_control', mo: 50 }] } },
    })).toBe(null);
  });

  test('commercial rodent bait uses the same brackets off the building footprint', () => {
    const estimate = generateEstimate(baseInput({
      propertyType: 'commercial',
      isCommercial: true,
      commercialSubtype: 'office',
      buildingSizeMeasured: true,
      homeSqFt: 3000,
      services: { rodentBait: {} },
    }));
    const line = estimate.lineItems.find(i => i.service === 'commercial_rodent_bait');
    expect(line).toBeDefined();
    expect(line.quoteRequired).toBeFalsy();
    // 3,000 sf building → 2,751–3,750 bracket: 6 stations, $99/visit.
    expect(line.perVisit).toBe(99);
    expect(line.stations).toBe(6);
    // Commercial stays flat — never WaveGuard-discountable — but pays the
    // $99 non-member setup like any non-member.
    expect(line.excludeFromPctDiscount).toBe(true);
    const setup = estimate.lineItems.find(i => i.service === 'rodent_bait_setup');
    expect(setup?.price).toBe(99);
  });

  test('exclusion V2 quotes each section as its own line item, summing to the total', () => {
    const result = priceRodentExclusionV2({
      standardWireMeshPoints: 2,
      standardBirdBoxes: 1,
      meshSoftLF: 20,
    });

    expect(result.price).toBe(655); // 150 wire + 150 boxes + 280 mesh + 75 inspect
    const components = result.lineItems.map(li => li.component);
    expect(components).toEqual(['wire_mesh_points', 'bird_boxes', 'linear_mesh', 'inspect_fee']);
    expect(result.lineItems.map(li => li.price)).toEqual([150, 150, 280, 75]);
    expect(result.lineItems.reduce((s, li) => s + li.price, 0)).toBe(result.price);
    // Every row keeps the exclusion identity for catalog/adoption/completion.
    expect(result.lineItems.every(li => li.service === 'rodent_exclusion')).toBe(true);
    // Names must never contain "inspection" — estimate-public's
    // isInspectionReviewOneTimeItem would classify such a row non-billable.
    expect(result.lineItems.every(li => !/inspection/i.test(li.label))).toBe(true);
  });

  test('exclusion V2 job minimum and inspect waiver surface as explicit rows', () => {
    const floored = priceRodentExclusionV2({
      advancedWireMeshPoints: 1,
      waiveInspection: true,
    });
    expect(floored.price).toBe(195); // $195 point-only job minimum
    expect(floored.lineItems.map(li => [li.component, li.price])).toEqual([
      ['wire_mesh_points', 150],
      ['job_minimum', 45],
    ]);
    expect(floored.lineItems[0].detail).toContain('(inspect waived)');
  });

  test('generateEstimate carries V2 exclusion as per-section rows and still tiers the guarantee', () => {
    const estimate = generateEstimate(baseInput({
      services: {
        exclusion: {
          pricingVersion: 'v2',
          advancedWireMeshPoints: 10, // 20 equivalent points → estate guarantee tier
          waiveInspection: true,
        },
        rodentGuarantee: {
          eligibility: {
            trappingCompleted: true,
            exclusionCompleted: true,
            sanitationCompletedOrPhotoBaseline: true,
            noActivityAfterFinalTrapCheck: true,
          },
        },
      },
    }));

    const exclusionRows = estimate.lineItems.filter(li => li.service === 'rodent_exclusion');
    expect(exclusionRows.map(li => li.component)).toEqual(['wire_mesh_points']);
    expect(exclusionRows[0].price).toBe(1500);
    // No combined summary row rides alongside the section rows.
    expect(exclusionRows.filter(li => li.name === 'Rodent Exclusion')).toHaveLength(0);

    const guarantee = estimate.lineItems.find(li => li.service === 'rodent_guarantee');
    expect(guarantee).toMatchObject({ eligible: true, tier: 'estate', effectivePoints: 20 });
  });

  test('rodent guarantee combo does not discount bait-station components', () => {
    const combo = calculateRodentGuaranteeCombo({
      sqft: 2400,
      stories: 1,
      guaranteeTerm: 12,
    });

    expect(combo.breakdown.bundleDiscount).toBe(0);
    expect(combo.breakdown.baitExcludedFromBundleDiscount).toBe(true);
    // Bait component = the standard bracket per application (post-exclusion
    // modifier retired — codex #3591 r14 P2): 2,400 sf → 5 stations, $89.
    const standalone = generateEstimate(baseInput({ homeSqFt: 2400, services: { rodentBait: {} } }))
      .lineItems.find(i => i.service === 'rodent_bait');
    expect(combo.breakdown.baitStationQuarterly).toBe(standalone.perVisit);
    expect(combo.detail).toContain(`${standalone.stations} bait stations`);
  });

  test('wizard-supplied prior qualifying services waive the setup WITHOUT moving the estimate tier (codex #3591 r14 P1)', () => {
    const solo = generateEstimate(baseInput({ services: { rodentBait: {} } }));
    expect(solo.lineItems.find(i => i.service === 'rodent_bait_setup')).toBeDefined();
    const member = generateEstimate(baseInput({
      services: { rodentBait: {} },
      setupWaiverPriorQualifyingServices: ['lawn_care'],
    }));
    expect(member.lineItems.find(i => i.service === 'rodent_bait_setup')).toBeUndefined();
    expect(member.waveGuard.qualifyingCount).toBe(solo.waveGuard.qualifyingCount);
    // Rodent itself never self-waives through this channel either.
    const rodentOnlyPrior = generateEstimate(baseInput({
      services: { rodentBait: {} },
      setupWaiverPriorQualifyingServices: ['rodent_bait'],
    }));
    expect(rodentOnlyPrior.lineItems.find(i => i.service === 'rodent_bait_setup')).toBeDefined();
  });
});

describe('service credits span every itemized exclusion section (codex #3521 r1 P1)', () => {
  test('a free rodent_exclusion credit zeroes ALL section rows, not just the first', () => {
    const estimate = generateEstimate(baseInput({
      services: {
        exclusion: {
          pricingVersion: 'v2',
          standardWireMeshPoints: 2,
          standardBirdBoxes: 1,
          meshSoftLF: 20,
          waiveInspection: true,
        },
      },
      serviceSpecificDiscounts: [{
        source: 'catalog_preset',
        presetKey: 'free_rodent_exclusion',
        catalogName: 'Free Rodent Exclusion',
        catalogCategory: 'service_specific_credit',
        discountType: 'free_service',
        service: 'rodent_exclusion',
        label: 'Free Rodent Exclusion',
      }],
    }));
    const [credit] = estimate.summary.serviceSpecificDiscounts;
    // 150 wire + 150 boxes + 280 mesh — the whole service, across three rows.
    expect(credit.amount).toBe(580);
    expect(estimate.summary.oneTimeTotal).toBe(0);
  });

  test('a fixed credit larger than the first section carries into the next rows', () => {
    const estimate = generateEstimate(baseInput({
      services: {
        exclusion: {
          pricingVersion: 'v2',
          standardWireMeshPoints: 2,
          standardBirdBoxes: 1,
          meshSoftLF: 20,
          waiveInspection: true,
        },
      },
      serviceSpecificDiscounts: [{
        source: 'catalog_preset',
        presetKey: 'rodent_exclusion_credit',
        catalogName: 'Rodent Exclusion Credit',
        catalogCategory: 'service_specific_credit',
        discountType: 'fixed',
        requestedAmount: 200,
        service: 'rodent_exclusion',
        label: 'Rodent Exclusion Credit',
      }],
    }));
    const [credit] = estimate.summary.serviceSpecificDiscounts;
    expect(credit.amount).toBe(200);
    expect(estimate.summary.oneTimeTotal).toBe(380);
    // Only the row the credit actually zeroed reads as "Included"; a
    // partially credited row keeps its NET price and an untouched row its
    // full price (uncapped audit r2 P0 — the flag renders as Included).
    const rows = estimate.lineItems.filter((li) => li.service === 'rodent_exclusion');
    expect(rows.map((li) => [li.component, li.priceAfterDiscount ?? li.price, li.serviceSpecificDiscountApplied === true])).toEqual([
      ['wire_mesh_points', 0, true],
      ['bird_boxes', 100, false],
      ['linear_mesh', 280, false],
    ]);
  });
});

describe('exclusion V2 rows reconcile to the price for fractional measurements (codex #3521 r2 P2)', () => {
  test('20.1 LF of soft mesh: rows sum to result.price to the cent', () => {
    const result = priceRodentExclusionV2({ meshSoftLF: 20.1, waiveInspection: true });
    const rowsTotal = Math.round(result.lineItems.reduce((s, li) => s + li.price, 0) * 100) / 100;
    expect(rowsTotal).toBe(result.price);
    expect(Number.isInteger(result.price)).toBe(true);
    const minimum = result.lineItems.find((li) => li.component === 'job_minimum');
    // 20.1 × $14 = $281.40 of mesh; the job minimum row carries exactly the
    // remainder up to the (whole-dollar) install price.
    expect(result.lineItems.find((li) => li.component === 'linear_mesh').price).toBe(281.4);
    expect(minimum.price).toBe(Math.round((result.price - 281.4) * 100) / 100);
  });

  test('whole quantities are unchanged', () => {
    const result = priceRodentExclusionV2({ standardWireMeshPoints: 2, standardBirdBoxes: 1, meshSoftLF: 20 });
    expect(result.price).toBe(655);
    expect(result.lineItems.map((li) => li.price)).toEqual([150, 150, 280, 75]);
  });
});

describe('exclusion V2 rows never exceed the price above the job minimum (pre-push P0 on #3521)', () => {
  test('fractional work above the minimum: rows sum to the whole-dollar price', () => {
    // 4 standard points ($300) + 20.1 LF soft ($281.40) = $581.40 raw → $581 price.
    const result = priceRodentExclusionV2({ standardWireMeshPoints: 4, meshSoftLF: 20.1, waiveInspection: true });
    expect(result.price).toBe(581);
    const rowsTotal = Math.round(result.lineItems.reduce((s, li) => s + li.price, 0) * 100) / 100;
    expect(rowsTotal).toBe(581);
    expect(result.lineItems.some((li) => li.component === 'job_minimum')).toBe(false);
    // The $0.40 remainder folds into the last component row.
    expect(result.lineItems.find((li) => li.component === 'linear_mesh').price).toBe(281);
  });

  test('fractional work that rounds UP: rows still sum to the price', () => {
    // 4 points ($300) + 20.05 LF ($280.70) = $580.70 → $581; last row absorbs +$0.30.
    const result = priceRodentExclusionV2({ standardWireMeshPoints: 4, meshSoftLF: 20.05, waiveInspection: true });
    expect(result.price).toBe(581);
    const rowsTotal = Math.round(result.lineItems.reduce((s, li) => s + li.price, 0) * 100) / 100;
    expect(rowsTotal).toBe(581);
  });
});

describe('service credits never zero distinct products that share a key (uncapped audit P0 on #3521)', () => {
  test('a free one_time_lawn credit leaves the second lawn product paid', () => {
    const estimate = generateEstimate(baseInput({
      services: { oneTimeLawn: {}, lawnPestControl: {} },
      serviceSpecificDiscounts: [{
        source: 'catalog_preset',
        presetKey: 'free_one_time_lawn',
        catalogName: 'Free One-Time Lawn',
        catalogCategory: 'service_specific_credit',
        discountType: 'free_service',
        service: 'one_time_lawn',
        label: 'Free One-Time Lawn',
      }],
    }));
    const lawnRows = estimate.lineItems.filter((li) => li.service === 'one_time_lawn');
    expect(lawnRows.length).toBeGreaterThanOrEqual(2);
    const zeroed = lawnRows.filter((li) => li.serviceSpecificDiscountApplied === true);
    expect(zeroed).toHaveLength(1);
    const stillPaid = lawnRows.filter((li) => li.serviceSpecificDiscountApplied !== true);
    expect(stillPaid.every((li) => (li.priceAfterDiscount ?? li.price) > 0)).toBe(true);
    expect(estimate.summary.oneTimeTotal).toBeGreaterThan(0);
  });
});

describe('included-section markers survive the legacy mapper (codex #3521 r15 P1)', () => {
  const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');

  test('a fully credited V2 exclusion keeps its sections as marked $0 rows in the mapped estimate', () => {
    const mapped = mapV1ToLegacyShape(generateEstimate(baseInput({
      services: {
        exclusion: { pricingVersion: 'v2', standardWireMeshPoints: 2, standardBirdBoxes: 1, meshSoftLF: 20, waiveInspection: true },
      },
      serviceSpecificDiscounts: [{
        source: 'catalog_preset', presetKey: 'free_rodent_exclusion', catalogName: 'Free Rodent Exclusion',
        catalogCategory: 'service_specific_credit', discountType: 'free_service', service: 'rodent_exclusion', label: 'Free Rodent Exclusion',
      }],
    })));
    const rows = [...(mapped.oneTime.items || []), ...(mapped.oneTime.specItems || [])]
      .filter((r) => r.service === 'rodent_exclusion');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.serviceSpecificDiscountApplied === true)).toBe(true);
    expect(rows.every((r) => Number(r.priceAfterDiscount ?? r.price) === 0)).toBe(true);
    // And the page's normalizer keeps them as Included rows rather than dropping $0 rows.
    const { normalizeOneTimeBreakdown } = require('../routes/estimate-public');
    const normalized = normalizeOneTimeBreakdown({ result: mapped }).items.filter((r) => r.service === 'rodent_exclusion');
    expect(normalized.length).toBe(rows.length);
    expect(normalized.every((r) => r.kind === 'included')).toBe(true);
  });
});

describe('gross inspection fields reach the FINAL mapper projection (codex #3521 r16 P1)', () => {
  const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');

  test('a member inspection persists its face and perk rate on oneTime.specItems', () => {
    const mapped = mapV1ToLegacyShape(generateEstimate(baseInput({
      recurringCustomer: true,
      services: { rodentInspection: {} },
    })));
    const row = [...(mapped.oneTime.items || []), ...(mapped.oneTime.specItems || [])]
      .find((r) => r.service === 'rodent_inspection');
    expect(row).toBeTruthy();
    // $75 face, 15% member perk → $63.75 stored net; the face and the rate
    // both ride the persisted row so closeout never needs reconstruction.
    expect(row.price).toBe(63.75);
    expect(row.priceBeforeDiscount).toBe(75);
    expect(row.recurringCustomerDiscountRate).toBe(0.15);
  });
});

describe('admin pricing-config validation for the rodent rows (codex #3591 r9)', () => {
  const { validatePricingConfigData } = require('../routes/admin-pricing-config');
  const brackets = (overrides = {}) => ({
    brackets: [
      { max_sq_ft: 1750, stations: 4, per_visit: 79 },
      { max_sq_ft: 2750, stations: 5, per_visit: 89 },
    ],
    extension: { per_sq_ft: 1000, stations_per_step: 1, per_visit_per_step: 10 },
    visits_per_year: 4,
    ...overrides,
  });

  test('visits_per_year is pinned to 4 — the program is quarterly end to end (P1)', () => {
    expect(validatePricingConfigData('rodent_bait_brackets', brackets()).ok).toBe(true);
    expect(validatePricingConfigData('rodent_bait_brackets', brackets({ visits_per_year: 6 })).ok).toBe(false);
    expect(validatePricingConfigData('rodent_bait_brackets', brackets({ visits_per_year: 1 })).ok).toBe(false);
  });

  test('bracket prices accept cents but never sub-cent precision (P2)', () => {
    const halfDollar = brackets();
    halfDollar.brackets[1].per_visit = 89.5;
    expect(validatePricingConfigData('rodent_bait_brackets', halfDollar).ok).toBe(true);
    const subCent = brackets();
    subCent.brackets[1].per_visit = 89.501;
    expect(validatePricingConfigData('rodent_bait_brackets', subCent).ok).toBe(false);
    expect(validatePricingConfigData('rodent_bait_brackets', brackets({
      extension: { per_sq_ft: 1000, stations_per_step: 1, per_visit_per_step: 10.001 },
    })).ok).toBe(false);
  });

  test('rodent_setup_fee: non-negative whole cents; zero disables; negative rejected (P2)', () => {
    expect(validatePricingConfigData('rodent_setup_fee', { value: 99 }).ok).toBe(true);
    expect(validatePricingConfigData('rodent_setup_fee', { value: 0 }).ok).toBe(true);
    expect(validatePricingConfigData('rodent_setup_fee', { value: -1 }).ok).toBe(false);
    expect(validatePricingConfigData('rodent_setup_fee', { value: 99.001 }).ok).toBe(false);
    expect(validatePricingConfigData('rodent_setup_fee', { value: 'abc' }).ok).toBe(false);
  });
});

describe('saved-replay rodent WaveGuard posture freeze (codex #3591 r43 P1)', () => {
  const { WAVEGUARD } = require('../services/pricing-engine/constants');
  const { rodentWaveguardPostureReplaySignal } = require('../services/rodent-bait-legacy-replay');
  const rodentPest = () => baseInput({ services: { rodentBait: {}, pest: { frequency: 'quarterly' } } });

  test('a frozen NON-qualifying posture keeps the sent quote out of the tier and off the % even after the live flag turns on', () => {
    const frozen = generateEstimate({
      ...rodentPest(),
      rodentWaveguardPostureReplay: { tierQualifier: false, excludeFromPctDiscount: true },
    });
    const live = generateEstimate(rodentPest());
    expect(live.waveGuard.qualifyingCount).toBe(2); // pest + rodent = Silver live
    expect(frozen.waveGuard.qualifyingCount).toBe(1); // rodent frozen out
    const row = frozen.lineItems.find((i) => i.service === 'rodent_bait');
    expect(row).toMatchObject({ tierQualifier: false, countsTowardWaveGuardTier: false, excludeFromPctDiscount: true, waveGuardDiscountEligible: false });
  });

  test('a frozen QUALIFYING posture holds the tier after the live flag turns off (assumeQualifying, replay-only)', () => {
    const idx = WAVEGUARD.qualifyingServices.indexOf('rodent_bait');
    WAVEGUARD.qualifyingServices.splice(idx, 1);
    try {
      const fresh = generateEstimate(rodentPest());
      expect(fresh.waveGuard.qualifyingCount).toBe(1); // live: rodent no longer counts
      const frozen = generateEstimate({
        ...rodentPest(),
        rodentWaveguardPostureReplay: { tierQualifier: true, excludeFromPctDiscount: false },
      });
      expect(frozen.waveGuard.qualifyingCount).toBe(2); // sent quote holds Silver
    } finally {
      WAVEGUARD.qualifyingServices.push('rodent_bait');
    }
  });

  test('the posture signal reads the stored new-model row; legacy rows and estimates without posture stamps inject nothing', () => {
    const stored = { engineResult: { lineItems: [
      { service: 'rodent_bait', perApplicationBilled: true, stations: 5, tierQualifier: false, countsTowardWaveGuardTier: false, excludeFromPctDiscount: true, waveGuardDiscountEligible: false },
    ] } };
    expect(rodentWaveguardPostureReplaySignal(stored)).toEqual({ tierQualifier: false, excludeFromPctDiscount: true });
    const storedOn = { result: { recurring: { services: [
      { service: 'rodent_bait', perApplicationBilled: true, stations: 5, tierQualifier: true, excludeFromPctDiscount: false },
    ] } } };
    expect(rodentWaveguardPostureReplaySignal(storedOn)).toEqual({ tierQualifier: true, excludeFromPctDiscount: false });
    // Legacy monthly row (no new-model marker) → nothing.
    expect(rodentWaveguardPostureReplaySignal({ result: { recurring: { services: [{ service: 'rodent_bait', mo: 49 }] } } })).toBeNull();
    // New-model row that predates the posture stamps → nothing.
    expect(rodentWaveguardPostureReplaySignal({ engineResult: { lineItems: [{ service: 'rodent_bait', perApplicationBilled: true, stations: 5 }] } })).toBeNull();
    expect(rodentWaveguardPostureReplaySignal({})).toBeNull();
  });
});

describe('saved-replay rodent % treatment freeze (codex #3591 r44 P1)', () => {
  const { WAVEGUARD } = require('../services/pricing-engine/constants');
  const rodentPest = () => baseInput({ services: { rodentBait: {}, pest: { frequency: 'quarterly' } } });

  test('frozen EXCLUDED posture keeps the % off the rodent line even while the live policy grants it', () => {
    const frozen = generateEstimate({
      ...rodentPest(),
      rodentWaveguardPostureReplay: { tierQualifier: true, excludeFromPctDiscount: true },
    });
    const row = frozen.lineItems.find((i) => i.service === 'rodent_bait');
    expect(frozen.waveGuard.qualifyingCount).toBe(2); // still tier-counted
    expect(row.discount.effectiveDiscount).toBe(0);
    expect(row.annualAfterDiscount).toBe(row.annual);
    // Live pricing keeps the Silver % on the same cart.
    const live = generateEstimate(rodentPest()).lineItems.find((i) => i.service === 'rodent_bait');
    expect(live.discount.effectiveDiscount).toBeGreaterThan(0);
  });

  test('frozen ELIGIBLE posture keeps the % on after the live map flips to excluded (replay-only override)', () => {
    WAVEGUARD.excludedFromPercentDiscount.rodent_bait = true;
    try {
      const fresh = generateEstimate(rodentPest()).lineItems.find((i) => i.service === 'rodent_bait');
      expect(fresh.discount.effectiveDiscount).toBe(0); // live: excluded
      const frozen = generateEstimate({
        ...rodentPest(),
        rodentWaveguardPostureReplay: { tierQualifier: true, excludeFromPctDiscount: false },
      }).lineItems.find((i) => i.service === 'rodent_bait');
      expect(frozen.discount.effectiveDiscount).toBeGreaterThan(0); // sent quote holds its %
    } finally {
      delete WAVEGUARD.excludedFromPercentDiscount.rodent_bait;
    }
  });
});
