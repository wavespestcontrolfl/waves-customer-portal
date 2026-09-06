jest.mock('../models/db', () => jest.fn());

const { resolveEstimateSlotProfile } = require('../services/estimate-slot-availability');
const {
  capacityForServices, capacityFromReservation, windowForCapacityService, assertCapacityServices,
} = require('../services/combined-visit-capacity');

const services = ['pest_control', 'lawn_care', 'tree_shrub', 'mosquito'];
function estimateFor(keys) {
  return {
    estimate_data: { result: { recurring: { services: keys.map((service) => ({ service, name: service, visitsPerYear: ({ pest_control: 4, lawn_care: 6, tree_shrub: 6, mosquito: 12 })[service] || 4 })) } } },
  };
}

beforeEach(() => { process.env.GATE_SEPARATE_COMBO_VISITS = 'true'; });
afterEach(() => { delete process.env.GATE_VISIT_COMBINED_CAPACITY; delete process.env.GATE_SEPARATE_COMBO_VISITS; });

describe('combined visit booking capacity', () => {
  test.each(['foam_recurring', 'foam recurring', 'Recurring Termite Foam Service'])('recurring foam identity %s retains its termite capability category', (identity) => {
    expect(require('../services/auto-dispatch/service-category').classifyServiceCategory(identity)).toBe('termite');
  });
  test.each([2, 3, 4])('%i selected services reserve one hour each without the old 180-minute cap', (count) => {
    process.env.GATE_VISIT_COMBINED_CAPACITY = 'true';
    const profile = resolveEstimateSlotProfile(estimateFor(services.slice(0, count)), { durationMinutes: 30 });
    expect(profile.durationMinutes).toBe(count * 60);
    expect(profile.reservationServiceMix.services).toEqual(services.slice(0, count));
  });

  test('intentional pest-only choices do not reserve omitted companion capacity', () => {
    process.env.GATE_VISIT_COMBINED_CAPACITY = 'true';
    const estimate = estimateFor(['pest_control', 'mosquito']);
    estimate.show_one_time_option = true;
    estimate.estimate_data.result.recurring.services[0].perTreatment = 120;
    const profile = resolveEstimateSlotProfile(estimate, { selectedFrequency: 'quarterly' });
    expect(profile.services.map((row) => row.service)).toEqual(['pest_control']);
    expect(profile.durationMinutes).toBe(60);
    expect(profile.reservationServiceMix).toBeUndefined();
  });

  test('dark creation keeps the existing single-block policy', () => {
    expect(resolveEstimateSlotProfile(estimateFor(services)).durationMinutes).toBe(60);
    expect(resolveEstimateSlotProfile(estimateFor(services), { durationMinutes: 90 }).durationMinutes).toBe(90);
    expect(resolveEstimateSlotProfile(estimateFor(services)).reservationServiceMix).toBeUndefined();
  });

  test.each([
    ['termite_bait', 'termite_station_rental'],
    ['termite_bait', 'termite_bond_1yr'],
    ['termite_bait', 'termite_station_rental', 'termite_bond_1yr'],
  ].map((keys) => [keys]))('termite billing riders remain one physical program: %j', (keys) => {
    process.env.GATE_VISIT_COMBINED_CAPACITY = 'true';
    const profile = resolveEstimateSlotProfile(estimateFor(keys));
    expect(profile.services).toHaveLength(1);
    expect(profile.durationMinutes).toBe(60);
    expect(profile.reservationServiceMix).toBeUndefined();
    const mixed = resolveEstimateSlotProfile(estimateFor(['pest_control', ...keys]));
    expect(mixed.durationMinutes).toBe(120);
    expect(mixed.reservationServiceMix.services).toEqual(['pest_control', 'termite_bait']);
  });

  test.each(['scalar', 'pinned'])('legacy %s rodent supplement reserves its own hour', (shape) => {
    process.env.GATE_VISIT_COMBINED_CAPACITY = 'true';
    const estimate = estimateFor(['pest_control', 'lawn_care']);
    const recurring = estimate.estimate_data.result.recurring;
    if (shape === 'scalar') recurring.rodentBaitMo = 50;
    else recurring.services.push({ service: 'rodent_bait', name: 'Rodent Bait', mo: 50, legacyPinnedReplay: true });
    const profile = resolveEstimateSlotProfile(estimate);
    expect(profile.durationMinutes).toBe(180);
    expect(profile.reservationServiceMix.services).toEqual(['pest_control', 'lawn_care', 'rodent_bait']);
  });

  test('a service cadence the converter cannot seed is refused before offering a combined slot', () => {
    process.env.GATE_VISIT_COMBINED_CAPACITY = 'true';
    const estimate = estimateFor(['pest_control', 'lawn_care']);
    estimate.estimate_data.result.recurring.services[1].visitsPerYear = 4;
    expect(() => resolveEstimateSlotProfile(estimate))
      .toThrow(expect.objectContaining({ code: 'COMBINED_VISIT_UNAVAILABLE' }));
  });

  test.each([6, 12])('supported %i-application pest plans retain their companion capacity', (visits) => {
    process.env.GATE_VISIT_COMBINED_CAPACITY = 'true';
    const estimate = estimateFor(['pest_control', 'lawn_care']);
    estimate.estimate_data.result.recurring.services[0].visitsPerYear = visits;
    const profile = resolveEstimateSlotProfile(estimate);
    expect(profile.services.map((row) => [row.service, row.visitsPerYear]))
      .toEqual([['pest_control', visits], ['lawn_care', 6]]);
    expect(profile.durationMinutes).toBe(120);
  });

  test.each([
    ['lawn_care', 'lawn', 'standard', 6],
    ['lawn_care', 'lawn', 'enhanced', 9],
    ['lawn_care', 'lawn', 'premium', 12],
    ['tree_shrub', 'ts', 'light', 4],
    ['tree_shrub', 'ts', 'standard', 6],
  ])('the selected %s %s tier %s overrides stored cadence before capacity validation', (service, resultKey, tier, visits) => {
    process.env.GATE_VISIT_COMBINED_CAPACITY = 'true';
    const estimate = estimateFor(['pest_control', service]);
    estimate.estimate_data.result.recurring.services[1].visitsPerYear = service === 'lawn_care' ? 4 : 9;
    estimate.estimate_data.result.results = { [resultKey]: [
      { name: 'Light', v: 4, mo: 40, ann: 480, pa: 120 },
      { name: 'Standard', v: 6, mo: 60, ann: 720, pa: 120 },
      { name: 'Enhanced', v: 9, mo: 90, ann: 1080, pa: 120 },
      { name: 'Premium', v: 12, mo: 120, ann: 1440, pa: 120 },
    ] };
    const before = structuredClone(estimate);
    const profile = resolveEstimateSlotProfile(estimate, {
      selectedFrequency: 'quarterly', serviceCadences: { [service]: tier },
    });
    expect(profile.services.map((row) => [row.service, row.visitsPerYear])).toEqual([
      ['pest_control', 4], [service, visits],
    ]);
    expect(profile.durationMinutes).toBe(120);
    expect(estimate).toEqual(before);
  });

  test('a persisted combined reservation keeps the accepted mix sized after the gate is off', () => {
    const profile = resolveEstimateSlotProfile(estimateFor(services.slice(0, 2)), { preserveCombinedCapacity: true });
    expect(profile.durationMinutes).toBe(120);
    expect(profile.reservationServiceMix.services).toEqual(['pest_control', 'lawn_care']);
  });

  test('the separate-service routing prerequisite fails closed', () => {
    process.env.GATE_VISIT_COMBINED_CAPACITY = 'true';
    delete process.env.GATE_SEPARATE_COMBO_VISITS;
    expect(() => resolveEstimateSlotProfile(estimateFor(services))).toThrow(
      expect.objectContaining({ code: 'COMBINED_VISIT_UNAVAILABLE' }),
    );
  });

  test('one selected service keeps its existing booking policy', () => {
    process.env.GATE_VISIT_COMBINED_CAPACITY = 'true';
    const profile = resolveEstimateSlotProfile(estimateFor(['lawn_care']));
    expect(profile.durationMinutes).toBe(60);
    expect(profile.reservationServiceMix).toBeUndefined();
  });

  test('duplicate source rows normalize to one program; duplicate capacity members still refuse', () => {
    process.env.GATE_VISIT_COMBINED_CAPACITY = 'true';
    const profile = resolveEstimateSlotProfile(estimateFor(['pest_control', 'pest_control']));
    expect(profile.services).toHaveLength(1);
    expect(profile.durationMinutes).toBe(60);
    expect(profile.reservationServiceMix).toBeUndefined();
    expect(() => capacityForServices([{ service: 'pest_control' }, { service: 'pest_control' }]))
      .toThrow(expect.objectContaining({ code: 'COMBINED_VISIT_UNAVAILABLE' }));
  });

  test.each(['foam_recurring', 'unknown_program'])('unsupported %s is refused before offering a combined slot', (service) => {
    process.env.GATE_VISIT_COMBINED_CAPACITY = 'true';
    expect(() => resolveEstimateSlotProfile(estimateFor(['pest_control', service])))
      .toThrow(expect.objectContaining({ code: 'COMBINED_VISIT_UNAVAILABLE' }));
  });

  test('one held block becomes sequential on-the-hour service windows', () => {
    const anchor = {
      window_start: '09:00:00',
      reservation_service_mix: capacityForServices(services.map((service) => ({ service }))),
    };
    expect(services.map((_, index) => windowForCapacityService(anchor, index))).toEqual([
      { window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60 },
      { window_start: '10:00', window_end: '11:00', estimated_duration_minutes: 60 },
      { window_start: '11:00', window_end: '12:00', estimated_duration_minutes: 60 },
      { window_start: '12:00', window_end: '13:00', estimated_duration_minutes: 60 },
    ]);
    expect(() => windowForCapacityService(anchor, 4)).toThrow();
    expect(() => windowForCapacityService({ ...anchor, window_start: '09:30' }, 0)).toThrow();
  });

  test('corrupt capacity stamps fail closed', () => {
    expect(() => capacityFromReservation({ reservation_service_mix: { version: 1, services: ['lawn_care', 'pest_control'], durationMinutes: 60 } }))
      .toThrow(expect.objectContaining({ code: 'COMBINED_VISIT_UNAVAILABLE' }));
    expect(capacityFromReservation({})).toBeNull();
  });

  test('allocation requires every selected identity on the same customer and technician', () => {
    const anchor = {
      id: 'primary', customer_id: 'customer', technician_id: 'tech', service_id: 'pest-id',
      service_key_snapshot: 'pest_general_quarterly', service_type: 'Renamed service',
      reservation_service_mix: capacityForServices([{ service: 'pest_control' }, { service: 'lawn_care' }]),
    };
    const lawn = { id: 'lawn', customer_id: 'customer', technician_id: 'tech', service_id: 'lawn-id', service_key_snapshot: 'lawn_6step' };
    expect(() => assertCapacityServices(anchor, [anchor, lawn])).not.toThrow();
    for (const members of [[anchor], [anchor, anchor], [anchor, { ...lawn, technician_id: null }], [anchor, { ...lawn, service_id: null }]]) {
      expect(() => assertCapacityServices(anchor, members)).toThrow(expect.objectContaining({ code: 'COMBINED_VISIT_UNAVAILABLE' }));
    }
  });
});
