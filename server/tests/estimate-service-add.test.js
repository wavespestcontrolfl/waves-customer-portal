/**
 * Priced add-a-service (GATE_ESTIMATE_SERVICE_ADD) — the blob half.
 *
 * Pins which never-quoted lines the page may offer to price in place, that
 * the synthetic "removed inputs" an add re-plants match what a fresh quote
 * would carry, and that a staff-parked line reads as an offer.
 */
const {
  SERVICE_ADD_KEYS,
  serviceOptOutAddableKeys,
  buildServiceAddInputs,
  applyServiceOptOutToEstimateData,
  serviceIsPresentInInputs,
  recordServiceOptOutEvent,
  staffOfferedKeys,
  staffOfferedEvents,
  latestOptOutEventIsStaff,
  memberEvidenceInEstimateData,
  currentlyOptedOutKeys,
} = require('../services/estimate-service-opt-out');
const { optOutImpact, recurringServiceKeysOf, addedLineReviewOnly } = require('../routes/estimate-public');

const requestOnly = () => ({
  engineRequest: {
    profile: { homeSqFt: 2000, lotSqFt: 8000, lawnSqFt: 4000 },
    selectedServices: ['PEST'],
    options: { pestFreq: 4 },
  },
});
const inputsOnly = () => ({
  engineInputs: { lotSqFt: 8000, lawnSqFt: 4000, services: { pest: { frequency: 'quarterly' } } },
  inputs: { lotSqFt: 8000, lawnSqFt: 4000, services: { pest: { frequency: 'quarterly' } } },
  result: { property: { lotSqFt: 8000 } },
});
const pestSection = [{ key: 'pest_control', isRecurring: true }];
const RES = { category: 'RESIDENTIAL' };

describe('serviceOptOutAddableKeys', () => {
  it('offers the residential lines not already on the quote', () => {
    expect([...serviceOptOutAddableKeys(requestOnly(), pestSection, null, RES)].sort()).toEqual(['lawn_care', 'mosquito']);
    expect(SERVICE_ADD_KEYS).toEqual(['pest_control', 'lawn_care', 'mosquito']);
  });

  it('never re-offers a line that is present, or one the customer removed (that is a restore)', () => {
    const data = requestOnly();
    data.engineRequest.selectedServices = ['PEST', 'MOSQUITO'];
    expect(serviceOptOutAddableKeys(data, [...pestSection, { key: 'mosquito', isRecurring: true }], null, RES).has('mosquito')).toBe(false);
    const removed = requestOnly();
    recordServiceOptOutEvent(removed, { serviceKey: 'lawn_care', included: false, at: 'now' }, {});
    expect(currentlyOptedOutKeys(removed)).toEqual(['lawn_care']);
    expect(serviceOptOutAddableKeys(removed, pestSection, null, RES).has('lawn_care')).toBe(false);
  });

  it('requires a SUPPLIED turf basis before offering lawn — a lot-only profile prices review-only and keeps the inquiry card (GH codex r10 P2)', () => {
    const noLot = requestOnly();
    noLot.engineRequest.profile = { homeSqFt: 2000 };
    expect(serviceOptOutAddableKeys(noLot, pestSection, null, RES).has('lawn_care')).toBe(false);
    expect(serviceOptOutAddableKeys(noLot, pestSection, null, RES).has('mosquito')).toBe(true);
    const lotOnly = requestOnly();
    lotOnly.engineRequest.profile = { homeSqFt: 2000, lotSqFt: 8000 };
    expect(serviceOptOutAddableKeys(lotOnly, pestSection, null, RES).has('lawn_care')).toBe(false);
    for (const basis of [{ measuredTurfSf: 3000 }, { lawnSqFt: 3000 }, { estimatedTurfSf: 3000 }]) {
      const supplied = requestOnly();
      supplied.engineRequest.profile = { homeSqFt: 2000, lotSqFt: 8000, ...basis };
      expect(serviceOptOutAddableKeys(supplied, pestSection, null, RES).has('lawn_care')).toBe(true);
    }
    const v1LotOnly = inputsOnly();
    delete v1LotOnly.engineInputs.lawnSqFt;
    expect(serviceOptOutAddableKeys(v1LotOnly, pestSection, null, RES).has('lawn_care')).toBe(false);
  });

  it('fails closed on a non-residential or missing category, and never offers a member a priced add', () => {
    expect(serviceOptOutAddableKeys(requestOnly(), pestSection, null, { category: 'COMMERCIAL' }).size).toBe(0);
    expect(serviceOptOutAddableKeys(requestOnly(), pestSection, null, {}).size).toBe(0);
    expect(serviceOptOutAddableKeys(requestOnly(), pestSection, null, { category: 'residential' }).size).toBe(2);
    const member = { ...requestOnly(), membershipSnapshot: { isExistingCustomer: true } };
    expect(serviceOptOutAddableKeys(member, pestSection, null, RES).size).toBe(0);
    const priors = requestOnly();
    priors.engineRequest.options.priorQualifyingServices = ['lawn_care'];
    expect(serviceOptOutAddableKeys(priors, pestSection, null, RES).size).toBe(0);
    const linkedNew = { ...requestOnly(), membershipSnapshot: { isExistingCustomer: false } };
    expect(serviceOptOutAddableKeys(linkedNew, pestSection, null, RES).size).toBe(2);
    // The recurring-customer flag in any replay shape is member evidence too.
    const flagged = requestOnly();
    flagged.engineRequest.options.recurringCustomer = 'yes';
    expect(serviceOptOutAddableKeys(flagged, pestSection, null, RES).size).toBe(0);
    const flaggedInputs = { ...inputsOnly(), engineInputs: { ...inputsOnly().engineInputs, isRecurringCustomer: true } };
    expect(serviceOptOutAddableKeys(flaggedInputs, pestSection, null, RES).size).toBe(0);
    expect(memberEvidenceInEstimateData({ inputs: { recurringCustomer: 'no' } })).toBe(false);
    expect(memberEvidenceInEstimateData({ inputs: { recurringCustomer: 'false' } })).toBe(false);
    expect(memberEvidenceInEstimateData({ inputs: { recurringCustomer: 1 } })).toBe(true);
    // The singular public-wizard replay carrier counts too.
    expect(memberEvidenceInEstimateData({ engineInput: { isRecurringCustomer: true } })).toBe(true);
    expect(memberEvidenceInEstimateData({ engineInput: { priorQualifyingServices: ['pest_control'] } })).toBe(true);
    expect(memberEvidenceInEstimateData(null)).toBe(false);
  });

  it('offers nothing on commercial, quote-required, proposal, tier-selected or non-replayable estimates', () => {
    expect(serviceOptOutAddableKeys(requestOnly(), [{ key: 'commercial_pest', isRecurring: true }], null, RES).size).toBe(0);
    expect(serviceOptOutAddableKeys(requestOnly(), [{ key: 'pest_control', isRecurring: true, quoteRequired: true }], null, RES).size).toBe(0);
    expect(serviceOptOutAddableKeys({ ...requestOnly(), proposal: { programs: [] } }, pestSection, null, RES).size).toBe(0);
    const tierPicked = { ...requestOnly(), result: { recurring: { waveGuardTier: 'Bronze' } } };
    expect(serviceOptOutAddableKeys(tierPicked, pestSection, 'Gold', RES).size).toBe(0);
    expect(serviceOptOutAddableKeys({ inputs: { services: { pest: {} } } }, pestSection, null, RES).size).toBe(0);
    expect(serviceOptOutAddableKeys(requestOnly(), [], null, RES).size).toBe(0);
  });
});

describe('buildServiceAddInputs + the restore surgery', () => {
  it('engineRequest carrier: the add is the selectedServices token, exactly as a fresh quote', () => {
    const data = requestOnly();
    const built = buildServiceAddInputs(data, 'mosquito');
    expect(built).toEqual({ ok: true, removedInputs: { engineInputs: null, inputs: null, selected: ['MOSQUITO'] } });
    const applied = applyServiceOptOutToEstimateData(data, { serviceKey: 'mosquito', included: true, removedInputs: built.removedInputs });
    expect(applied.ok).toBe(true);
    expect(data.engineRequest.selectedServices).toEqual(['PEST', 'MOSQUITO']);
    expect(serviceIsPresentInInputs(data, 'mosquito')).toBe(true);
  });

  it('engineInputs carrier: the add is the add-service flow\'s default block, planted in BOTH carriers', () => {
    const data = inputsOnly();
    const built = buildServiceAddInputs(data, 'lawn_care');
    expect(built.ok).toBe(true);
    expect(built.removedInputs.selected).toEqual([]);
    expect(built.removedInputs.engineInputs.lawn).toMatchObject({ track: 'st_augustine', tier: 'enhanced' });
    expect(built.removedInputs.inputs.lawn).toEqual(built.removedInputs.engineInputs.lawn);
    applyServiceOptOutToEstimateData(data, { serviceKey: 'lawn_care', included: true, removedInputs: built.removedInputs });
    expect(data.engineInputs.services.lawn).toMatchObject({ track: 'st_augustine' });
    expect(data.inputs.services.lawn).toMatchObject({ track: 'st_augustine' });
    expect(serviceIsPresentInInputs(data, 'lawn_care')).toBe(true);
  });

  it('refuses keys outside the add set and estimates with no replayable carrier', () => {
    expect(buildServiceAddInputs(requestOnly(), 'termite_bait').ok).toBe(false);
    expect(buildServiceAddInputs(requestOnly(), 'tree_shrub').ok).toBe(false);
    expect(buildServiceAddInputs({ inputs: { services: {} } }, 'mosquito').ok).toBe(false);
  });

  it('a later removal of an added line captures the real subtree, so the customer can restore it', () => {
    const data = requestOnly();
    const built = buildServiceAddInputs(data, 'mosquito');
    applyServiceOptOutToEstimateData(data, { serviceKey: 'mosquito', included: true, removedInputs: built.removedInputs });
    const removal = applyServiceOptOutToEstimateData(data, { serviceKey: 'mosquito', included: false });
    expect(removal.ok).toBe(true);
    expect(removal.removedInputs.selected).toEqual(['MOSQUITO']);
    expect(data.engineRequest.selectedServices).toEqual(['PEST']);
  });
});

describe('staffOfferedKeys', () => {
  it('names only lines whose CURRENT state is a staff removal', () => {
    const data = {};
    recordServiceOptOutEvent(data, { serviceKey: 'lawn_care', included: false, actor: 'staff', at: 't1' }, {});
    recordServiceOptOutEvent(data, { serviceKey: 'mosquito', included: false, actor: 'customer', at: 't2' }, {});
    expect(staffOfferedKeys(data)).toEqual(['lawn_care']);
    expect(staffOfferedEvents(data).map((e) => e.serviceKey)).toEqual(['lawn_care']);
    expect(latestOptOutEventIsStaff(data, 'lawn_care')).toBe(true);
    expect(latestOptOutEventIsStaff(data, 'mosquito')).toBe(false);
    recordServiceOptOutEvent(data, { serviceKey: 'lawn_care', included: true, actor: 'customer', at: 't3' }, {});
    expect(staffOfferedKeys(data)).toEqual([]);
    expect(latestOptOutEventIsStaff(data, 'lawn_care')).toBe(false);
    expect(staffOfferedKeys({})).toEqual([]);
  });
});

describe('lineReviewOnly', () => {
  it('is the draft builder\'s review predicate plus the low pricing-confidence grade, fail-closed on a non-line', () => {
    const { lineReviewOnly } = require('../services/estimate-service-opt-out');
    expect(lineReviewOnly({ service: 'pest_control', pricingConfidence: 'low' })).toBe(true);
    expect(lineReviewOnly({ service: 'lawn_care', manualReviewReasons: ['turf area is a heuristic estimate'] })).toBe(true);
    expect(lineReviewOnly({ service: 'pest_control', pricingConfidence: 'high' })).toBe(false);
    expect(lineReviewOnly(null)).toBe(true);
  });
});

describe('optOutImpact in add mode', () => {
  const mk = (tier, services) => ({ recurring: { waveGuardTier: tier, services } });
  const pest = (pa) => ({ service: 'pest_control', name: 'Pest Control', annualAfterDiscount: pa * 4, visitsPerYear: 4 });
  const mosquito = (pa) => ({ service: 'mosquito', name: 'Mosquito', annualAfterDiscount: pa * 12, visitsPerYear: 12 });
  const lawn = (pa) => ({ service: 'lawn_care', name: 'Lawn Care', frequency: 'bimonthly', annualAfterDiscount: pa * 6, visitsPerYear: 6 });

  it('never promises the pay-in-full discount on a mix that cannot prepay: solo → two recurring lines discloses the option leaving, not a 0% → 5% rate (GH codex r9 P1)', () => {
    const impact = optOutImpact({
      beforeResult: mk('Bronze', [pest(100)]),
      afterResult: mk('Silver', [pest(95), lawn(60)]),
      beforeData: {}, afterData: {}, label: 'Lawn Care', mode: 'add',
    });
    const codes = impact.disclosures.map((d) => d.code);
    expect(codes).toContain('annual_prepay_unavailable');
    expect(codes).not.toContain('annual_prepay_rate');
    // The reverse move (two lines → solo) has no prepay to lose: the option was
    // never offered on the two-unit mix, so nothing is disclosed either way.
    const back = optOutImpact({
      beforeResult: mk('Silver', [pest(95), lawn(60)]),
      afterResult: mk('Bronze', [pest(100)]),
      beforeData: {}, afterData: {}, label: 'Lawn Care', mode: 'remove',
    });
    expect(back.disclosures.map((d) => d.code)).toEqual(expect.not.arrayContaining(['annual_prepay_unavailable', 'annual_prepay_rate']));
  });

  it('words a tier move as "Adding X" (not "back") and prices the new line', () => {
    const impact = optOutImpact({
      beforeResult: mk('Bronze', [pest(100)]),
      afterResult: mk('Silver', [pest(95), mosquito(60)]),
      beforeData: {}, afterData: {}, label: 'Mosquito', mode: 'add',
    });
    const codes = impact.disclosures.map((d) => d.code);
    expect(codes).toContain('waveguard_tier_change');
    expect(impact.disclosures.find((d) => d.code === 'waveguard_tier_change').message).toMatch(/^Adding Mosquito moves/);
    expect(impact.disclosures.find((d) => d.code === 'added_per_application').message).toBe('Mosquito is $60.00 per application.');
    expect(impact.disclosures.find((d) => d.code === 'recurring_per_application').message).toBe('Pest Control changes from $100.00 to $95.00 per application.');
    expect(codes).not.toContain('restored_per_application');
    expect(impact.wouldChargeBundled).toEqual([]);
  });

  it('restore mode keeps its "back" wording', () => {
    const impact = optOutImpact({
      beforeResult: mk('Bronze', [pest(100)]),
      afterResult: mk('Silver', [pest(95), mosquito(60)]),
      beforeData: {}, afterData: {}, label: 'Mosquito', mode: 'restore',
    });
    expect(impact.disclosures.find((d) => d.code === 'waveguard_tier_change').message).toMatch(/^Adding Mosquito back moves/);
    expect(impact.disclosures.find((d) => d.code === 'restored_per_application').message).toBe('Mosquito comes back at $60.00 per application.');
  });
});

describe('recurringServiceKeysOf — the "did the requested line join" check', () => {
  it('keys rows the way every renderer does, so an incidental extra row never passes as the add', () => {
    const before = { recurring: { services: [{ service: 'pest_control', name: 'Pest Control' }] } };
    const after = { recurring: { services: [{ service: 'pest_control' }, { name: 'Mosquito Program' }] } };
    expect(recurringServiceKeysOf(before)).toEqual(new Set(['pest_control']));
    expect(recurringServiceKeysOf(after)).toEqual(new Set(['pest_control', 'mosquito']));
    const supplementalOnly = { recurring: { services: [{ service: 'pest_control' }, { name: 'Palm Injection' }] } };
    expect(recurringServiceKeysOf(supplementalOnly).has('mosquito')).toBe(false);
    expect(recurringServiceKeysOf(null).size).toBe(0);
  });
});

describe('addedLineReviewOnly — an add the engine could only price for review is refused (GH codex r4 P1)', () => {
  it('flags the requested line when it carries any review-only marker', () => {
    const raw = { lineItems: [{ service: 'pest_control', name: 'Pest Control' }, { service: 'lawn_care', name: 'Lawn Care', requiresCustomQuote: true }] };
    expect(addedLineReviewOnly(raw, 'lawn_care')).toBe(true);
    expect(addedLineReviewOnly(raw, 'pest_control')).toBe(false);
    expect(addedLineReviewOnly({ lineItems: [{ service: 'mosquito', quoteRequired: true }] }, 'mosquito')).toBe(true);
    expect(addedLineReviewOnly({ lineItems: [{ service: 'mosquito', requiresMeasurement: true }] }, 'mosquito')).toBe(true);
    // Pest low-confidence review state lives on its own markers (GH codex r6 P1).
    expect(addedLineReviewOnly({ lineItems: [{ service: 'pest_control', requiresManualReview: true }] }, 'pest_control')).toBe(true);
    expect(addedLineReviewOnly({ lineItems: [{ service: 'pest_control', pricingConfidence: 'low' }] }, 'pest_control')).toBe(true);
    expect(addedLineReviewOnly({ lineItems: [{ service: 'pest_control', confidence: 'high' }] }, 'pest_control')).toBe(false);
    // Oversize measured lawn: priced-but-custom (GH codex r7 P1) via the shared draft-builder predicate.
    expect(addedLineReviewOnly({ lineItems: [{ service: 'lawn_care', customQuoteFlag: true }] }, 'lawn_care')).toBe(true);
    expect(addedLineReviewOnly({ lineItems: [{ service: 'lawn_care', manualReviewReasons: ['x'] }] }, 'lawn_care')).toBe(true);
    expect(addedLineReviewOnly({ lineItems: [{ service: 'mosquito' }] }, 'mosquito')).toBe(false);
  });
  it('fails closed without a raw result or without the line', () => {
    expect(addedLineReviewOnly(null, 'mosquito')).toBe(true);
    expect(addedLineReviewOnly({ lineItems: [{ service: 'pest_control' }] }, 'mosquito')).toBe(true);
  });
});
