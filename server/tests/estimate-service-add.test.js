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
  currentlyOptedOutKeys,
} = require('../services/estimate-service-opt-out');
const { optOutImpact } = require('../routes/estimate-public');

const requestOnly = () => ({
  engineRequest: {
    profile: { homeSqFt: 2000, lotSqFt: 8000 },
    selectedServices: ['PEST'],
    options: { pestFreq: 4 },
  },
});
const inputsOnly = () => ({
  engineInputs: { lotSqFt: 8000, services: { pest: { frequency: 'quarterly' } } },
  inputs: { lotSqFt: 8000, services: { pest: { frequency: 'quarterly' } } },
  result: { property: { lotSqFt: 8000 } },
});
const pestSection = [{ key: 'pest_control', isRecurring: true }];

describe('serviceOptOutAddableKeys', () => {
  it('offers the residential lines not already on the quote', () => {
    expect([...serviceOptOutAddableKeys(requestOnly(), pestSection)].sort()).toEqual(['lawn_care', 'mosquito']);
    expect(SERVICE_ADD_KEYS).toEqual(['pest_control', 'lawn_care', 'mosquito']);
  });

  it('never re-offers a line that is present, or one the customer removed (that is a restore)', () => {
    const data = requestOnly();
    data.engineRequest.selectedServices = ['PEST', 'MOSQUITO'];
    expect(serviceOptOutAddableKeys(data, [...pestSection, { key: 'mosquito', isRecurring: true }]).has('mosquito')).toBe(false);
    const removed = requestOnly();
    recordServiceOptOutEvent(removed, { serviceKey: 'lawn_care', included: false, at: 'now' }, {});
    expect(currentlyOptedOutKeys(removed)).toEqual(['lawn_care']);
    expect(serviceOptOutAddableKeys(removed, pestSection).has('lawn_care')).toBe(false);
  });

  it('requires a turf basis before offering lawn', () => {
    const noLot = requestOnly();
    noLot.engineRequest.profile = { homeSqFt: 2000 };
    expect(serviceOptOutAddableKeys(noLot, pestSection).has('lawn_care')).toBe(false);
    expect(serviceOptOutAddableKeys(noLot, pestSection).has('mosquito')).toBe(true);
    const measured = requestOnly();
    measured.engineRequest.profile = { homeSqFt: 2000, measuredTurfSf: 3000 };
    expect(serviceOptOutAddableKeys(measured, pestSection).has('lawn_care')).toBe(true);
    const v1NoLot = inputsOnly();
    delete v1NoLot.engineInputs.lotSqFt;
    expect(serviceOptOutAddableKeys(v1NoLot, pestSection).has('lawn_care')).toBe(false);
  });

  it('offers nothing on commercial, quote-required, proposal, tier-selected or non-replayable estimates', () => {
    expect(serviceOptOutAddableKeys(requestOnly(), [{ key: 'commercial_pest', isRecurring: true }]).size).toBe(0);
    expect(serviceOptOutAddableKeys(requestOnly(), [{ key: 'pest_control', isRecurring: true, quoteRequired: true }]).size).toBe(0);
    expect(serviceOptOutAddableKeys({ ...requestOnly(), proposal: { programs: [] } }, pestSection).size).toBe(0);
    const tierPicked = { ...requestOnly(), result: { recurring: { waveGuardTier: 'Bronze' } } };
    expect(serviceOptOutAddableKeys(tierPicked, pestSection, 'Gold').size).toBe(0);
    expect(serviceOptOutAddableKeys({ inputs: { services: { pest: {} } } }, pestSection).size).toBe(0);
    expect(serviceOptOutAddableKeys(requestOnly(), []).size).toBe(0);
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
    recordServiceOptOutEvent(data, { serviceKey: 'lawn_care', included: true, actor: 'customer', at: 't3' }, {});
    expect(staffOfferedKeys(data)).toEqual([]);
    expect(staffOfferedKeys({})).toEqual([]);
  });
});

describe('optOutImpact in add mode', () => {
  const mk = (tier, services) => ({ recurring: { waveGuardTier: tier, services } });
  const pest = (pa) => ({ service: 'pest_control', name: 'Pest Control', annualAfterDiscount: pa * 4, visitsPerYear: 4 });
  const mosquito = (pa) => ({ service: 'mosquito', name: 'Mosquito', annualAfterDiscount: pa * 12, visitsPerYear: 12 });

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
