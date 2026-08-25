/**
 * Termite bait station RENTAL option (owner 2026-07-26).
 *
 * The Massey/Sentricon-shaped alternative to outright purchase: $0 install,
 * Waves retains ownership of the in-ground stations, and the install price
 * the customer did not pay is recovered as a fixed per-application uplift on
 * the same quarterly station check.
 *
 * The uplift rides its OWN line item rather than bumping the monitoring rate,
 * because termite_bait is WaveGuard-tier-counting and bundle-discountable —
 * folding hardware recovery into it would let a bundle percentage discount
 * the stations themselves. Same posture as the bond rider.
 *
 * recoveryQuarters sizes the uplift; it is NOT a term after which the charge
 * stops (owner ruling: rental fee, not a payment plan).
 */

const {
  priceTermiteBait,
  priceTermiteStationRental,
} = require('../services/pricing-engine/service-pricing');
const { termiteStationsRentedUpdate } = require('../services/estimate-converter');
const { generateEstimate } = require('../services/pricing-engine/estimate-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
const { TERMITE, WAVEGUARD } = require('../services/pricing-engine/constants');

const PROFILE = { homeSqFt: 2000, stories: 1, lotSqFt: 8000 };

// Rental ships dark (GATE_TERMITE_STATION_RENTAL, default OFF). The engine
// emission is the single choke point, so the suite runs gate-on and one case
// pins the dark default.
beforeAll(() => { process.env.GATE_TERMITE_STATION_RENTAL = 'true'; });
afterAll(() => { delete process.env.GATE_TERMITE_STATION_RENTAL; });

function termiteInput(options = {}) {
  return translateV2CallToV1Input(PROFILE, ['TERMITE_BAIT'], {
    termiteBaitSystem: 'advance',
    ...options,
  });
}

describe('priceTermiteStationRental', () => {
  test('uplift = install price / recovery quarters, whole dollars, x4 = annual', () => {
    // 20 seeded quarters: $500 of stations -> $25/application.
    expect(priceTermiteStationRental(500)).toMatchObject({
      service: 'termite_station_rental',
      name: 'Termite Station Rental',
      perApp: 25,
      visitsPerYear: 4,
      annual: 100,
      monthly: 8.33,
      retailValue: 500,
      recoveryQuarters: 20,
      retainedOwnership: true,
      discountable: false,
    });
  });

  test('refuses to price without a real install amount to amortize', () => {
    expect(priceTermiteStationRental(0)).toBeNull();
    expect(priceTermiteStationRental(-100)).toBeNull();
    expect(priceTermiteStationRental(null)).toBeNull();
    expect(priceTermiteStationRental(undefined)).toBeNull();
    expect(priceTermiteStationRental(NaN)).toBeNull();
    // Below one dollar per quarter there is no line worth billing.
    expect(priceTermiteStationRental(5)).toBeNull();
  });
});

describe('priceTermiteBait ownership', () => {
  test('own (default) is unchanged: install billed, stations belong to the customer', () => {
    const own = priceTermiteBait(PROFILE, { system: 'advance' });
    expect(own.ownership).toBe('own');
    expect(own.stationsOwnedBy).toBe('customer');
    expect(own.installation.price).toBeGreaterThan(0);
    // retailValue mirrors price when the customer is buying.
    expect(own.installation.retailValue).toBe(own.installation.price);
  });

  test('rent zeroes the billed install but keeps the hardware value on the line', () => {
    const own = priceTermiteBait(PROFILE, { system: 'advance', ownership: 'own' });
    const rent = priceTermiteBait(PROFILE, { system: 'advance', ownership: 'rent' });
    expect(rent.ownership).toBe('rent');
    expect(rent.stationsOwnedBy).toBe('waves');
    expect(rent.installation.price).toBe(0);
    expect(rent.installation.retailValue).toBe(own.installation.price);
    // Monitoring is untouched by ownership — only the hardware moves.
    expect(rent.perApp).toBe(own.perApp);
    expect(rent.stations).toBe(own.stations);
  });

  test('unrecognized ownership falls back to purchase rather than giving stations away', () => {
    for (const bad of ['lease', '', null, undefined, 'RENTAL', 42]) {
      const r = priceTermiteBait(PROFILE, { system: 'advance', ownership: bad });
      expect(r.ownership).toBe('own');
      expect(r.installation.price).toBeGreaterThan(0);
    }
    // Only the exact token opts in — but it is case-insensitive.
    expect(priceTermiteBait(PROFILE, { system: 'advance', ownership: 'RENT' }).ownership).toBe('rent');
  });
});

describe('engine + mapper emission', () => {
  test('rental replaces the one-time install with a recurring recovery line', () => {
    const ownEst = generateEstimate(termiteInput());
    const rentEst = generateEstimate(termiteInput({ termiteOwnership: 'rent' }));

    const ownBait = ownEst.lineItems.find((l) => l.service === 'termite_bait');
    const rentBait = rentEst.lineItems.find((l) => l.service === 'termite_bait');
    const rental = rentEst.lineItems.find((l) => l.service === 'termite_station_rental');

    expect(rental).toBeTruthy();
    expect(ownEst.lineItems.some((l) => l.service === 'termite_station_rental')).toBe(false);

    // The one-time install line exists when buying and is gone when renting.
    const ownMapped = mapV1ToLegacyShape(ownEst);
    const rentMapped = mapV1ToLegacyShape(rentEst);
    expect(ownMapped.oneTime.items.some((i) => i.service === 'termite_bait_installation')).toBe(true);
    expect(rentMapped.oneTime.items.some((i) => i.service === 'termite_bait_installation')).toBe(false);

    // ...and the recovery shows up as its own recurring row instead.
    const row = rentMapped.recurring.services.find((s) => s.service === 'termite_station_rental');
    expect(row).toMatchObject({
      name: 'Termite Station Rental',
      perTreatment: rental.perApp,
      visitsPerYear: 4,
      countsTowardWaveGuardTier: false,
      waveGuardDiscountEligible: false,
      discountable: false,
    });
    // Bait row itself is untouched beside it.
    expect(rentMapped.recurring.services.find((s) => s.service === 'termite_bait'))
      .toMatchObject({ mo: 34, perTreatment: 102, visitsPerYear: 4 });
    expect(rentBait.installation.retailValue).toBe(ownBait.installation.price);

    // EXACT annual survives the mapped totals (codex P2 round 3): the
    // persistence path prefers recurring.annualTotal, and without it the
    // $100 rider riding as a rounded $8.33/mo reconstructs to $519.96 —
    // converting to $129.99/application against line items promising $130.
    const exactAnnual = rentBait.annual + rental.annual;
    expect(rentMapped.recurring.annualTotal).toBe(exactAnnual);
    expect(rentMapped.recurring.annualTotal)
      .not.toBe(Math.round((rentMapped.recurring.grandTotal * 12) * 100) / 100);
  });

  test('rental reaches parity with buying at the amortization horizon', () => {
    const ownEst = generateEstimate(termiteInput());
    const rentEst = generateEstimate(termiteInput({ termiteOwnership: 'rent' }));
    const quarters = TERMITE.rental.recoveryQuarters;

    const ownBait = ownEst.lineItems.find((l) => l.service === 'termite_bait');
    const rentBait = rentEst.lineItems.find((l) => l.service === 'termite_bait');
    const rental = rentEst.lineItems.find((l) => l.service === 'termite_station_rental');

    const ownTotal = ownBait.installation.price + ownBait.perApp * quarters;
    const rentTotal = (rentBait.perApp + rental.perApp) * quarters;
    // Within one rounding step of the whole-dollar uplift, across the horizon.
    expect(Math.abs(ownTotal - rentTotal)).toBeLessThanOrEqual(quarters);
    // After the horizon renting costs more — that is the trade for $0 up front.
    const beyond = quarters + 4;
    expect((rentBait.perApp + rental.perApp) * beyond)
      .toBeGreaterThan(ownBait.installation.price + ownBait.perApp * beyond);
  });

  test('the uplift is exempt from the WaveGuard bundle percentage', () => {
    // Registered exemption is what keeps a bundle discount off the hardware.
    expect(WAVEGUARD.excludedFromPercentDiscount.termite_station_rental).toBe(true);

    const bundled = generateEstimate(translateV2CallToV1Input(
      PROFILE,
      ['PEST', 'MOSQUITO', 'TERMITE_BAIT'],
      { pestFrequency: 'quarterly', termiteBaitSystem: 'advance', termiteOwnership: 'rent' },
    ));
    const rental = bundled.lineItems.find((l) => l.service === 'termite_station_rental');
    const solo = generateEstimate(termiteInput({ termiteOwnership: 'rent' }))
      .lineItems.find((l) => l.service === 'termite_station_rental');
    // Same uplift bundled as solo: no percentage reached it.
    expect(rental.perApp).toBe(solo.perApp);
    expect(rental.annual).toBe(solo.annual);

    const row = mapV1ToLegacyShape(bundled).recurring.services
      .find((s) => s.service === 'termite_station_rental');
    expect(row.countsTowardWaveGuardTier).toBe(false);
  });

  test('gate off: a rent request prices as outright purchase', () => {
    delete process.env.GATE_TERMITE_STATION_RENTAL;
    try {
      const est = generateEstimate(termiteInput({ termiteOwnership: 'rent' }));
      const bait = est.lineItems.find((l) => l.service === 'termite_bait');
      expect(est.lineItems.some((l) => l.service === 'termite_station_rental')).toBe(false);
      expect(bait.ownership).toBe('own');
      expect(bait.installation.price).toBeGreaterThan(0);
      expect(mapV1ToLegacyShape(est).oneTime.items.some((i) => i.service === 'termite_bait_installation'))
        .toBe(true);
    } finally {
      process.env.GATE_TERMITE_STATION_RENTAL = 'true';
    }
  });
});

// ── conversion / billing (codex P0 on this PR) ────────────────────────────────
//
// The rental is a pure BILLING rider: no visit of its own, no lifecycle name
// contract. If conversion treats it as an ordinary recurring line it becomes a
// second scheduling unit — a phantom "Termite Station Rental" appointment, and
// riderAwareSingleUnitVisits returns null so per_application_fee and both rows'
// estimated_price go null. Completion then invoices NOTHING, monitoring
// included. These pin the rider semantics that prevent that.

describe('conversion treats the rental as a billing rider, not a unit', () => {
  const EstimateConverter = require('../services/estimate-converter');
  const { riderAwareSingleUnitVisits, recurringServiceKey } = EstimateConverter;

  const baitRow = { name: 'Termite Bait', service: 'termite_bait', mo: 35, monthly: 35, perTreatment: 105, visitsPerYear: 4 };
  const bondRow = { name: 'Termite Bond (10-Year Term)', service: 'termite_bond_10yr', bondTerm: '10yr', mo: 15, perTreatment: 45, visitsPerYear: 4 };
  const rentRow = { name: 'Termite Station Rental', service: 'termite_station_rental', mo: 8.33, perTreatment: 25, visitsPerYear: 4 };

  test('the dropped rental rider folds its money into the bait line first (codex P1 round 4)', () => {
    const { foldTermiteRentalIntoBait } = EstimateConverter;
    const pestRow = { name: 'General Pest Control', service: 'pest_control', mo: 45, perTreatment: 135, annual: 540 };
    const baitFull = { ...baitRow, annual: 420 };
    const rentFull = { ...rentRow, annual: 100, retailValue: 500 };

    // Multi-service plan: the rider row goes, its amounts land on the bait
    // line — per-application, monthly, and EXACT annual — so per-row billing
    // and manual allocation see the true bait+rental amount.
    const folded = foldTermiteRentalIntoBait([pestRow, baitFull, rentFull]);
    expect(folded.some((svc) => svc.service === 'termite_station_rental')).toBe(false);
    expect(folded.find((svc) => svc.service === 'pest_control')).toEqual(pestRow);
    expect(folded.find((svc) => svc.service === 'termite_bait')).toMatchObject({
      perTreatment: 130, // 105 + 25
      annual: 520,       // 420 + 100 EXACT (not 12 × rounded monthly)
      termiteStationRentalFoldedPerApp: 25,
    });

    // No rider → untouched rows, nothing invented.
    expect(foldTermiteRentalIntoBait([pestRow, baitFull]))
      .toEqual([pestRow, baitFull]);
  });

  test('termite_stations_rented stamp is three-way: rent → true, purchased bait → false, unrelated → untouched', () => {
    const { termiteStationsRentedUpdate } = EstimateConverter;
    const pestRow = { name: 'General Pest Control', service: 'pest_control', mo: 45 };
    // Rental accept stamps the renter flag.
    expect(termiteStationsRentedUpdate([baitRow, rentRow])).toEqual({ termite_stations_rented: true });
    // Purchased-bait accept positively CLEARS it (codex P1 round 2): a former
    // renter who buys outright must not have new pins stamped Waves-owned.
    expect(termiteStationsRentedUpdate([baitRow])).toEqual({ termite_stations_rented: false });
    expect(termiteStationsRentedUpdate([baitRow, bondRow])).toEqual({ termite_stations_rented: false });
    // An accept with no termite line is not an owner action on station title.
    expect(termiteStationsRentedUpdate([pestRow])).toEqual({});
    expect(termiteStationsRentedUpdate([])).toEqual({});
    // Suppressed conversions never touch the flag.
    expect(termiteStationsRentedUpdate([baitRow, rentRow], { suppressRecurringConversion: true })).toEqual({});
  });

  test('the rental line keys distinctly and never collides with the bait line', () => {
    expect(recurringServiceKey(rentRow)).toBe('termite_station_rental');
    // Name-only shapes (raw engine / legacy payloads) resolve the same way —
    // "Termite ... Station ..." must not fall through to termite_bait.
    expect(recurringServiceKey({ name: 'Termite Station Rental' })).toBe('termite_station_rental');
    expect(recurringServiceKey(baitRow)).toBe('termite_bait');
  });

  test('bait+rental still derives 4 visits — the whole-plan per-application charge survives', () => {
    expect(riderAwareSingleUnitVisits([baitRow, rentRow], 0)).toBe(4);
    // ...and composes with the bond rider: bait + bond + rental is ONE unit.
    expect(riderAwareSingleUnitVisits([baitRow, bondRow, rentRow], 0)).toBe(4);
    // A genuinely multi-unit plan still returns null (rows priced per row).
    const pestRow = { name: 'Pest Control', service: 'pest_control', visitsPerYear: 4 };
    expect(riderAwareSingleUnitVisits([pestRow, baitRow, rentRow], 0)).toBeNull();
    // A standalone-scheduling supplement still makes it multi-row.
    expect(riderAwareSingleUnitVisits([baitRow, rentRow], 1)).toBeNull();
  });

  test('a rental-only line set is not a priceable unit on its own', () => {
    // Nothing to schedule and nothing to divide — must not report 4.
    expect(riderAwareSingleUnitVisits([rentRow], 0)).toBeNull();
  });
});

// ── customer-facing guide copy (codex P1) ─────────────────────────────────────
//
// The termite service-details guide ships to BOTH purchase and rental
// customers. Its purchase copy makes hard promises — "they stay your
// property", "nobody digs them up if you ever stop service", and an FAQ that
// says outright "You own them" while disparaging leased systems. Sending that
// to a renter misrepresents the sale and undercuts Waves' right to recover
// its own hardware after cancellation.

describe('service-details guide reflects who owns the stations', () => {
  const { buildServiceDetailsContent } = require('../services/estimate-service-details');

  const rentalEstimate = {
    estimate_data: JSON.stringify({
      recurring: { services: [
        { service: 'termite_bait', name: 'Termite Bait' },
        { service: 'termite_station_rental', name: 'Termite Station Rental' },
      ] },
    }),
  };
  const purchaseEstimate = {
    estimate_data: JSON.stringify({
      recurring: { services: [{ service: 'termite_bait', name: 'Termite Bait' }] },
    }),
  };

  const textOf = (content) => [
    ...(content.process || []),
    ...(content.faq || []).map((f) => `${f.q} ${f.a}`),
    ...((content.systemBox?.rows) || []).map((r) => (Array.isArray(r) ? r.join(' ') : String(r))),
  ].join('\n');

  test('purchase guide keeps the ownership promises', async () => {
    const text = textOf(await buildServiceDetailsContent('termite_bait', purchaseEstimate));
    expect(text).toContain('The stations are YOURS');
    expect(text).toContain('nobody digs them up');
    expect(text).toContain('Yours — purchased once with installation');
    expect(text).not.toContain('stay Waves property');
  });

  test('rental guide never claims the customer owns the stations', async () => {
    const content = await buildServiceDetailsContent('termite_bait', rentalEstimate);
    const text = textOf(content);
    // None of the purchase-only promises survive.
    expect(text).not.toContain('The stations are YOURS');
    expect(text).not.toContain('nobody digs them up');
    expect(text).not.toContain('You own them.');
    expect(text).not.toContain('Yours — purchased once with installation');
    // ...and the rental reality is stated instead, including removal.
    expect(text).toContain('stay Waves property');
    expect(text).toMatch(/Waves-owned/);
    expect(text).toMatch(/remove them|pull them back out/);
    // Exactly one ownership FAQ either way — no duplicate question.
    const ownershipFaqs = (content.faq || []).filter((f) => /Do I own the bait stations/.test(f.q));
    expect(ownershipFaqs).toHaveLength(1);
    // The marker never reaches renderers.
    expect(content.faq.every((f) => f.ownership === undefined)).toBe(true);
    expect(content.process.every((step) => typeof step === 'string')).toBe(true);
    expect((content.systemBox.rows || []).every((r) => !Array.isArray(r) || r.length === 2)).toBe(true);
  });

  test('the raw engine shape (bait line stamped ownership) is recognized too', async () => {
    const raw = { estimate_data: JSON.stringify({ engineResult: { lineItems: [
      { service: 'termite_bait', ownership: 'rent' },
    ] } }) };
    expect(textOf(await buildServiceDetailsContent('termite_bait', raw))).toContain('stay Waves property');
  });

  test('unreadable or absent estimate data falls back to the purchase copy', async () => {
    // Safe direction: telling a RENTER they own the stations is the failure
    // that costs Waves its hardware, so rental copy needs a signal we can see.
    for (const est of [{}, { estimate_data: 'not json' }, { estimate_data: null }]) {
      expect(textOf(await buildServiceDetailsContent('termite_bait', est)))
        .toContain('The stations are YOURS');
    }
  });
});

// ── fail-closed pricing (codex P1) ────────────────────────────────────────────

describe('dark-gate save guard (client-priced payloads)', () => {
  test('a rental row cannot be persisted while GATE_TERMITE_STATION_RENTAL is off', () => {
    const { assertNoDarkTermiteRentalPayload } = require('../services/admin-estimate-persistence');
    const rentData = {
      inputs: { svcTermiteBait: true },
      result: mapV1ToLegacyShape(generateEstimate(termiteInput({ termiteOwnership: 'rent' }))),
    };
    const ownData = {
      inputs: { svcTermiteBait: true },
      result: mapV1ToLegacyShape(generateEstimate(termiteInput())),
    };
    const prev = process.env.GATE_TERMITE_STATION_RENTAL;
    delete process.env.GATE_TERMITE_STATION_RENTAL;
    try {
      // The engine enforces the gate only when IT prices; a client-priced
      // fallback payload skips the engine, so the save must fail closed —
      // same posture as assertNoDarkTermiteBondPayload.
      expect(() => assertNoDarkTermiteRentalPayload(rentData)).toThrow(/GATE_TERMITE_STATION_RENTAL/);
      let status;
      try { assertNoDarkTermiteRentalPayload(rentData); } catch (err) { status = err.statusCode || err.status; }
      expect(status).toBe(422);
      expect(() => assertNoDarkTermiteRentalPayload(ownData)).not.toThrow();
    } finally {
      process.env.GATE_TERMITE_STATION_RENTAL = prev;
    }
  });
});

describe('stale fallback rental rates are rejected at save', () => {
  test('a client-priced rental row must match the LIVE horizon (codex P1 round 4)', () => {
    const { assertLiveTermiteRentalRates } = require('../services/admin-estimate-persistence');
    const fresh = {
      inputs: { svcTermiteBait: true },
      result: mapV1ToLegacyShape(generateEstimate(termiteInput({ termiteOwnership: 'rent' }))),
    };
    // Rows priced at the live 20-quarter horizon pass...
    expect(() => assertLiveTermiteRentalRates(fresh, { liveConfigVerified: true })).not.toThrow();
    // ...a payload priced under a DIFFERENT horizon (admin tuned
    // recovery_quarters after the client bundle loaded) fails closed.
    const stale = JSON.parse(JSON.stringify(fresh));
    const staleRow = stale.result.recurring.services.find((s) => s.service === 'termite_station_rental');
    staleRow.perTreatment = Math.round(staleRow.retailValue / 16); // old 16-quarter uplift
    let status;
    try { assertLiveTermiteRentalRates(stale, { liveConfigVerified: true }); } catch (err) { status = err.statusCode || err.status; }
    expect(status).toBe(422);
    // Unverifiable live config fails closed too (codex P1 round 5): with the
    // sync down, "matches the cache" proves nothing — another pod may have
    // already replaced the horizon.
    let unverifiedStatus;
    try { assertLiveTermiteRentalRates(fresh, { liveConfigVerified: false }); } catch (err) { unverifiedStatus = err.statusCode || err.status; }
    expect(unverifiedStatus).toBe(422);
    // Purchase payloads carry no rental rows — never blocked, verified or not.
    expect(() => assertLiveTermiteRentalRates({
      inputs: { svcTermiteBait: true },
      result: mapV1ToLegacyShape(generateEstimate(termiteInput())),
    }, { liveConfigVerified: false })).not.toThrow();
  });
});

describe('prepay unit mirror matches conversion (codex P1 round 5)', () => {
  test('a rental-only bait estimate counts ONE unit — the rider never blocks annual prepay', () => {
    const { annualPrepayRecurringUnitCount } = require('../services/estimate-converter');
    const rentData = {
      inputs: { svcTermiteBait: true },
      result: mapV1ToLegacyShape(generateEstimate(termiteInput({ termiteOwnership: 'rent' }))),
    };
    // Two raw recurring rows (bait + rider) must still read as one unit,
    // exactly as convertEstimate's folded count does.
    expect(rentData.result.recurring.services.filter((s) => s.mo || s.monthly).length).toBeGreaterThanOrEqual(2);
    expect(annualPrepayRecurringUnitCount(rentData)).toBe(1);
    // Purchase bait stays one unit too (no behavior change).
    expect(annualPrepayRecurringUnitCount({
      inputs: { svcTermiteBait: true },
      result: mapV1ToLegacyShape(generateEstimate(termiteInput())),
    })).toBe(1);
  });
});

describe('an unpriceable uplift reverts the quote to purchase', () => {
  const { TERMITE } = require('../services/pricing-engine/constants');

  test('a horizon that rounds the uplift to zero must not give the stations away', () => {
    const original = TERMITE.rental.recoveryQuarters;
    try {
      // Reachable from a legal admin config before the route's upper bound
      // existed; the engine must still refuse to sell free hardware.
      TERMITE.rental.recoveryQuarters = 100000;
      const est = generateEstimate(termiteInput({ termiteOwnership: 'rent' }));
      const bait = est.lineItems.find((l) => l.service === 'termite_bait');
      expect(est.lineItems.some((l) => l.service === 'termite_station_rental')).toBe(false);
      // The install charge comes BACK — the whole point.
      expect(bait.installation.price).toBe(bait.installation.retailValue);
      expect(bait.installation.price).toBeGreaterThan(0);
      expect(bait.ownership).toBe('own');
      expect(bait.stationsOwnedBy).toBe('customer');
      expect(bait.requiresManualReview).toBe(true);
      expect(bait.manualReviewReasons).toContain('termite_rental_uplift_unpriceable');
    } finally {
      TERMITE.rental.recoveryQuarters = original;
    }
  });
});

// ── admin config validation ───────────────────────────────────────────────────

describe('recovery_quarters validation', () => {
  const { validatePricingConfigData } = require('../routes/admin-pricing-config');
  const check = (v) => validatePricingConfigData('termite_rental', { recovery_quarters: v }).ok;

  test('accepts whole quarters inside the sane band', () => {
    expect(check(20)).toBe(true);
    expect(check(1)).toBe(true);
    expect(check(120)).toBe(true);
  });

  test('rejects values that would zero or invert the uplift', () => {
    // 0 divides by nothing; negatives would pay the customer to rent.
    expect(check(0)).toBe(false);
    expect(check(-4)).toBe(false);
    // The upper bound is the real hazard: round(installPrice / quarters)
    // hits zero and the stations go out free with no recovery at all.
    expect(check(121)).toBe(false);
    expect(check(10000)).toBe(false);
    // Fractions would disagree with the rounded value that actually prices.
    expect(check(20.5)).toBe(false);
    expect(check('twenty')).toBe(false);
    expect(validatePricingConfigData('termite_rental', {}).ok).toBe(false);
  });

  test('the seeded default sits inside the accepted band', () => {
    const { TERMITE } = require('../services/pricing-engine/constants');
    expect(check(TERMITE.rental.recoveryQuarters)).toBe(true);
  });
});

// Estimate-page sections (2026-08-25): the rental row minted its own split
// section — a generic "Service" card that glassServiceSlug dressed in the
// full termite headline, rendering as a broken duplicate termite card at the
// bare uplift price (live case: draft EST-2026-0839). It is a RIDER like the
// bond: section-suppressed, stamped onto the termite card, and — solo —
// folded into the section frequencies the accept path freezes.
describe('estimate sections treat the rental as a rider, never its own card', () => {
  const {
    buildPricingServices,
    attachTermiteStationRental,
  } = require('../routes/estimate-public');

  const baitRow = {
    service: 'termite_bait', name: 'Termite Bait', visitsPerYear: 4,
    mo: 26.1, monthly: 26.1, annual: 313.2, perTreatment: 78.3,
  };
  const rentalRow = {
    service: 'termite_station_rental', name: 'Termite Station Rental',
    visitsPerYear: 4, mo: 11, monthly: 11, annual: 132, perTreatment: 33,
    detail: '16 rented stations · Waves-owned', retailValue: 660,
    discountable: false,
  };
  const soloEstData = { result: { recurring: { services: [baitRow, rentalRow] } } };

  test('solo termite + rental builds ONE termite section, no "Service" card', () => {
    const sections = buildPricingServices({ frequencies: [] }, {}, soloEstData);
    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe('termite_bait');
    expect(sections.some((s) => s.key === 'termite_station_rental')).toBe(false);
  });

  test('attach stamps the rental onto the termite section and folds solo frequencies', () => {
    const sections = buildPricingServices({ frequencies: [] }, {}, soloEstData);
    attachTermiteStationRental(sections, soloEstData);
    const section = sections[0];
    expect(section.stationRental).toMatchObject({
      label: 'Termite Station Rental',
      detail: '16 rented stations · Waves-owned',
      perApplicationAdd: 33,
      monthlyAdd: 11,
      annualAdd: 132,
    });
    // Solo accept freezes effectiveMonthly/AnnualTotal from the selected
    // frequency (same reason the bond folds) — the card price must be the
    // true combined charge, matching combinedRecurring's 37.10/mo.
    const frequency = section.frequencies[0];
    expect(frequency.monthly).toBeCloseTo(37.1, 2);
    expect(frequency.annual).toBeCloseTo(445.2, 2);
    expect(frequency.perTreatment).toBeCloseTo(111.3, 2);
  });

  const pestRow = {
    service: 'pest_control', name: 'Pest Control', visitsPerYear: 4,
    mo: 33.34, monthly: 33.34, annual: 400.08, perTreatment: 100.02,
  };
  const multiEstData = { result: { recurring: { services: [pestRow, baitRow, rentalRow] } } };
  // A reconciling ladder (row monthlies sum to the frequency monthly,
  // rental's rider monthly INCLUDED — same convention as the bond) so
  // canSplitRecurringSelectableLadder takes the split path.
  const splitPayload = {
    frequencies: [{
      key: 'quarterly',
      label: 'Quarterly',
      monthly: 70.44,
      annual: 845.28,
      perServiceTreatments: [
        { service: 'pest_control', label: 'Pest Control', perTreatment: 100.02, displayPrice: 100.02, visitsPerYear: 4, monthly: 33.34 },
        { service: 'termite_bait', label: 'Termite Bait', perTreatment: 78.3, displayPrice: 78.3, visitsPerYear: 4, monthly: 26.1 },
        { service: 'termite_station_rental', label: 'Termite Station Rental', perTreatment: 33, displayPrice: 33, visitsPerYear: 4, monthly: 11 },
      ],
    }],
  };

  test('split bundle: rental minted no section, termite section hosts the stamp un-folded', () => {
    const sections = buildPricingServices(splitPayload, {}, multiEstData);
    expect(sections.map((s) => s.key).sort()).toEqual(['pest_control', 'termite_bait']);
    attachTermiteStationRental(sections, multiEstData);
    const termite = sections.find((s) => s.key === 'termite_bait');
    expect(termite.stationRental).toMatchObject({ perApplicationAdd: 33 });
    // Split totals come from the summed recurring rows — the itemized
    // section keeps the bare monitoring price.
    expect(termite.frequencies[0].perTreatment).toBeCloseTo(78.3, 2);
  });

  test('unsplittable bundle fallback: the bundle card hosts the stamp, no fold (codex r1 P1)', () => {
    // No reconcilable ladder → single 'bundle' section.
    const sections = buildPricingServices({ frequencies: [] }, {}, multiEstData);
    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe('bundle');
    expect(sections[0].memberKeys).toEqual(['pest_control', 'termite_bait']);
    attachTermiteStationRental(sections, multiEstData);
    expect(sections[0].stationRental).toMatchObject({ perApplicationAdd: 33 });
    // The bundle's ladder already sums every recurring row (rental
    // included) — folding here would double-count.
    expect(sections[0].frequencies).toEqual([]);
  });

  test('a rental row with no monitoring plan keeps its own section (fail-safe, never vanishes)', () => {
    const estData = { result: { recurring: { services: [rentalRow] } } };
    const sections = buildPricingServices({ frequencies: [] }, {}, estData);
    expect(sections.some((s) => s.key === 'termite_station_rental')).toBe(true);
  });
});
