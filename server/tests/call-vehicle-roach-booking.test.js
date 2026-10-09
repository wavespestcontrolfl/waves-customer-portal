/**
 * GATE_CALL_VEHICLE_ROACH_BOOKING (owner ruling 2026-10-06): a call about
 * German roaches inside a car books the vehicle_german_roach catalog row ($199,
 * two visits), and a unit-less apartment address does not hold it. The first
 * real case was held on address_unverified (apartment building, no unit) and
 * would have booked the home roach package. Synthetic data only.
 */
process.env.GATE_CALL_VEHICLE_ROACH_BOOKING = 'true';

const {
  resolveCallBookingCatalogService,
  resolveCallBookingPrice,
  hasVehicleRoachRequest,
} = require('../services/call-booking-catalog');
const {
  applyVehicleServiceUnitWaiver,
  reconstructWaivedAddressValidation,
  VEHICLE_SERVICE_KEYS,
  VEHICLE_SERVICE_UNIT_WAIVER_REASON,
} = require('../services/call-triage-flags');
const { vehicleServiceUnitWaiverForCall } = require('../services/call-recording-processor')._test;
const { TWO_TREATMENT_PACKAGE_KEYS } = require('../services/typed-followup-obligation');

// Google's verdict for an apartment building given without a unit.
const AV_UNIT_MISSING = {
  status: 'ambiguous',
  granularity: 'PREMISE',
  inServiceArea: true,
  county: 'Manatee County',
  hasInferred: true,
  hasReplaced: false,
  hasUnconfirmed: false,
  addressUse: { poBox: false, business: false, residential: true },
  normalized: { street_line_1: '100 Example Ave W', city: 'Bradenton', state: 'FL', postal_code: '34205' },
  missingComponents: ['subpremise'],
};

const VEHICLE_ROW = {
  service_key: 'vehicle_german_roach', name: 'Vehicle German Roach Treatment (2 Visits)', short_name: 'Vehicle Roach',
  category: 'pest_control', billing_type: 'one_time', pricing_type: 'fixed', base_price: '199.00',
  requires_follow_up: true, follow_up_interval_days: 14,
};
const CATALOG = [
  { service_key: 'cockroach_control', name: 'Cockroach Treatment Service', short_name: 'Roach', category: 'pest_control', billing_type: 'one_time', pricing_type: 'fixed', base_price: '350.00' },
  { service_key: 'one_time_pest_control', name: 'General Pest Control', short_name: 'Pest One-Time', category: 'pest_control', billing_type: 'one_time', pricing_type: 'variable', base_price: '150.00' },
  { service_key: 'pest_general_quarterly', name: 'Quarterly Pest Control Service', short_name: 'Quarterly Pest', category: 'pest_control', billing_type: 'recurring', pricing_type: 'variable', base_price: '79.00' },
  VEHICLE_ROW,
];

// The first real call's extraction shape (names and address synthetic).
const CAR_CALL = {
  requested_service: 'Pest control for German cockroaches in a car',
  pain_points: 'Severe German cockroach infestation inside her 2024 Jeep Grand Cherokee, making it unsafe to drive.',
  call_summary: 'Jane Example called about German cockroaches in her 2024 Jeep Grand Cherokee. She accepted the $199 treatment for Thursday at 1 PM at her home address.',
  matched_service: 'Cockroach Treatment Service',
  specific_service_name: 'Cockroach Treatment Service',
  quoted_price: 199,
};

describe('hasVehicleRoachRequest', () => {
  test.each([
    [{ requested_service: 'Pest control for German cockroaches in a car' }, true],
    [{ pain_points: 'German cockroach infestation inside her 2024 Jeep Grand Cherokee' }, true],
    [{ requested_service: 'roaches in my truck' }, true],
    [{ call_summary: 'She found roaches inside her minivan after a road trip.' }, true],
    [{ pain_points: 'German roaches in the kitchen, not in the car' }, false],
    [{ pain_points: 'roaches in the garage by the car' }, false],
    [{ requested_service: 'roaches in the house and in my car' }, false],
    [{ requested_service: 'ants in my car' }, false],
    [{ call_summary: 'Caller has no roaches in her car anymore' }, false],
    [{ requested_service: 'roach treatment', call_summary: 'Caller will be in her car until noon.' }, false],
    // The veto reads the summary too (codex #6077 r1 P1): a home job named only there.
    [{ requested_service: 'roaches in my car', call_summary: 'She also sees German roaches in the kitchen cabinets.' }, false],
    [{ pain_points: 'roaches inside her SUV', call_summary: 'Roaches are throughout her apartment as well.' }, false],
    // "At her home address" is where the car is parked, not an infestation.
    [{ requested_service: 'roaches in my car', call_summary: 'Appointment at her home address on Thursday.' }, true],
    [{ requested_service: 'roaches in my car', call_summary: 'The technician treats the car at her home on Thursday.' }, true],
    // The roaches themselves must be in the vehicle (pre-push audit, v3): one clause names both.
    [{ call_summary: 'Caller needs German roach treatment for her house and will wait in her car.' }, false],
    [{ call_summary: 'Caller has German roaches, and she will be in her car until noon.' }, false],
    [{ call_summary: 'German roaches at the property. Caller is calling from inside her truck.' }, false],
    [{ requested_service: 'roaches in my car', call_summary: 'She wants roach treatment for her apartment too.' }, false],
  ])('%j -> %s', (extracted, expected) => {
    expect(hasVehicleRoachRequest(extracted)).toBe(expected);
  });
});

describe('resolveCallBookingCatalogService with the gate on', () => {
  test('a car roach call replaces the home roach pick with the vehicle row', () => {
    expect(resolveCallBookingCatalogService({ extracted: CAR_CALL, services: CATALOG })).toBe(VEHICLE_ROW);
  });

  test('the quoted $199 books as the price', () => {
    const row = resolveCallBookingCatalogService({ extracted: CAR_CALL, services: CATALOG });
    expect(resolveCallBookingPrice({ quotedPrice: 199, catalogRow: row })).toEqual({ price: 199, source: 'transcript' });
    expect(resolveCallBookingPrice({ quotedPrice: null, catalogRow: row })).toEqual({ price: 199, source: 'catalog' });
  });

  test('a Waves Assessment pick for roaches in a car stays an assessment (pre-push audit, v3)', () => {
    const ASSESSMENT_ROW = { service_key: 'lawn_inspection', name: 'Waves Assessment', category: 'inspection', billing_type: 'one_time', pricing_type: 'fixed', base_price: '0.00' };
    const extracted = { ...CAR_CALL, specific_service_name: 'Waves Assessment', matched_service: 'Waves Assessment', requested_service: 'Assessment for German roaches in her car' };
    expect(resolveCallBookingCatalogService({ extracted, services: [...CATALOG, ASSESSMENT_ROW] })).toBe(ASSESSMENT_ROW);
  });

  test('a recurring plan pick is never replaced', () => {
    const extracted = { ...CAR_CALL, matched_service: 'Quarterly Pest Control Service', specific_service_name: 'Quarterly Pest Control Service' };
    expect(resolveCallBookingCatalogService({ extracted, services: CATALOG }).service_key).toBe('pest_general_quarterly');
  });

  test('a home roach call keeps the home roach row', () => {
    const extracted = { requested_service: 'German roaches in the kitchen', matched_service: 'Cockroach Treatment Service' };
    expect(resolveCallBookingCatalogService({ extracted, services: CATALOG }).service_key).toBe('cockroach_control');
  });

  // codex #6082 r1 P1: an exact extractor pick of the vehicle row used to skip the evidence check.
  const EXACT_VEHICLE_PICK = { matched_service: VEHICLE_ROW.name, specific_service_name: VEHICLE_ROW.name };

  test('an exact vehicle pick with vehicle evidence resolves to the vehicle row', () => {
    const extracted = { ...EXACT_VEHICLE_PICK, requested_service: 'Pest control for German cockroaches in a car' };
    expect(resolveCallBookingCatalogService({ extracted, services: CATALOG })).toBe(VEHICLE_ROW);
  });

  test('an exact vehicle pick on a home-only call does not book the vehicle row', () => {
    const extracted = {
      ...EXACT_VEHICLE_PICK,
      requested_service: 'German roaches throughout my kitchen',
      call_summary: 'Caller sees German roaches in the kitchen cabinets and wants them gone.',
    };
    const row = resolveCallBookingCatalogService({ extracted, services: CATALOG });
    expect(row).not.toBe(VEHICLE_ROW);
    expect(row.service_key).toBe('cockroach_control');
  });

  test('an exact vehicle pick with no vehicle words at all does not book the vehicle row', () => {
    const extracted = { ...EXACT_VEHICLE_PICK, requested_service: 'roach treatment' };
    const row = resolveCallBookingCatalogService({ extracted, services: CATALOG });
    expect(row?.service_key).not.toBe('vehicle_german_roach');
  });

  test('an exact vehicle pick with a home job named in another field is a home job', () => {
    const extracted = {
      ...EXACT_VEHICLE_PICK,
      requested_service: 'roaches in my car',
      call_summary: 'She also sees German roaches in the kitchen cabinets.',
    };
    expect(resolveCallBookingCatalogService({ extracted, services: CATALOG })?.service_key).not.toBe('vehicle_german_roach');
  });

  test('no vehicle row in the catalog keeps the old resolution', () => {
    const services = CATALOG.filter((s) => s !== VEHICLE_ROW);
    expect(resolveCallBookingCatalogService({ extracted: CAR_CALL, services }).service_key).toBe('cockroach_control');
  });
});

describe('waiverCarriesToCandidate: a vehicle-service waiver (pre-push audit, v3)', () => {
  const { waiverCarriesToCandidate } = require('../services/call-triage-flags');
  const stored = { status: 'ambiguous', wholeStructureUnitWaived: { reason: 'vehicle_service', missingComponents: ['subpremise'], originalStatus: 'ambiguous' } };
  test('carries when the candidate still names roaches in a vehicle', () => {
    expect(waiverCarriesToCandidate(stored, {}, { scalarInputsMatch: true, requestFields: { requested_service: 'roaches in my car' } })).toBe(true);
  });
  test('does not carry when the candidate adds a home job, drops the vehicle, changes its scalars or passes no request fields', () => {
    expect(waiverCarriesToCandidate(stored, {}, { scalarInputsMatch: true, requestFields: { requested_service: 'roaches in my car', call_summary: 'Roaches in the kitchen too.' } })).toBe(false);
    expect(waiverCarriesToCandidate(stored, {}, { scalarInputsMatch: true, requestFields: { requested_service: 'roach treatment' } })).toBe(false);
    expect(waiverCarriesToCandidate(stored, {}, { scalarInputsMatch: false, requestFields: { requested_service: 'roaches in my car' } })).toBe(false);
    expect(waiverCarriesToCandidate(stored, {}, { scalarInputsMatch: true })).toBe(false);
  });
});

describe('gate off', () => {
  test('the resolver keeps the model pick', () => {
    jest.isolateModules(() => {
      const saved = process.env.GATE_CALL_VEHICLE_ROACH_BOOKING;
      delete process.env.GATE_CALL_VEHICLE_ROACH_BOOKING;
      try {
        const { resolveCallBookingCatalogService: resolveOff } = require('../services/call-booking-catalog');
        expect(resolveOff({ extracted: CAR_CALL, services: CATALOG }).service_key).toBe('cockroach_control');
      } finally {
        process.env.GATE_CALL_VEHICLE_ROACH_BOOKING = saved;
      }
    });
  });
});

describe('applyVehicleServiceUnitWaiver (pure)', () => {
  const ok = { enabled: true, serviceKey: 'vehicle_german_roach' };

  test('disabled or another service returns the very same verdict object', () => {
    expect(applyVehicleServiceUnitWaiver(AV_UNIT_MISSING, { ...ok, enabled: false })).toBe(AV_UNIT_MISSING);
    expect(applyVehicleServiceUnitWaiver(AV_UNIT_MISSING, { enabled: true, serviceKey: 'cockroach_control' })).toBe(AV_UNIT_MISSING);
    expect(applyVehicleServiceUnitWaiver(AV_UNIT_MISSING, { enabled: true, serviceKey: null })).toBe(AV_UNIT_MISSING);
  });

  test('only the unit missing -> accepted verdict with the audit marker, input untouched', () => {
    const out = applyVehicleServiceUnitWaiver(AV_UNIT_MISSING, ok);
    expect(out.status).toBe('validated_accept');
    expect(out.missingComponents).toEqual([]);
    expect(out.wholeStructureUnitWaived).toEqual({
      missingComponents: ['subpremise'], originalStatus: 'ambiguous', reason: VEHICLE_SERVICE_UNIT_WAIVER_REASON,
    });
    expect(AV_UNIT_MISSING.status).toBe('ambiguous');
    // The offline audits rebuild the same verdict from the persisted marker.
    expect(reconstructWaivedAddressValidation({ ...AV_UNIT_MISSING, wholeStructureUnitWaived: out.wholeStructureUnitWaived }).status)
      .toBe('validated_accept');
  });

  test.each([
    ['out of area', { inServiceArea: false }],
    ['unknown area', { inServiceArea: undefined }],
    ['unconfirmed component', { hasUnconfirmed: true }],
    ['replaced component', { hasReplaced: true }],
    ['street missing too', { missingComponents: ['subpremise', 'route'] }],
    ['route-level match', { granularity: 'ROUTE' }],
  ])('%s keeps the hold', (_label, patch) => {
    const av = { ...AV_UNIT_MISSING, ...patch };
    expect(applyVehicleServiceUnitWaiver(av, ok)).toBe(av);
  });

  test('the allowlist is only the vehicle job', () => {
    expect([...VEHICLE_SERVICE_KEYS]).toEqual(['vehicle_german_roach']);
  });
});

describe('vehicleServiceUnitWaiverForCall', () => {
  test('the first real call shape is waived', () => {
    const out = vehicleServiceUnitWaiverForCall({ addressValidation: AV_UNIT_MISSING, extracted: CAR_CALL, services: CATALOG });
    expect(out.status).toBe('validated_accept');
    expect(out.wholeStructureUnitWaived.service).toBe('vehicle_german_roach');
  });

  test('a home roach call at the same address keeps the hold', () => {
    const extracted = { requested_service: 'German roaches in the kitchen', matched_service: 'Cockroach Treatment Service' };
    expect(vehicleServiceUnitWaiverForCall({ addressValidation: AV_UNIT_MISSING, extracted, services: CATALOG })).toBe(AV_UNIT_MISSING);
  });

  test('an exact vehicle pick on a home-only call carries no unit waiver (codex #6082 r1 P1)', () => {
    const extracted = {
      matched_service: VEHICLE_ROW.name,
      specific_service_name: VEHICLE_ROW.name,
      requested_service: 'German roaches throughout my kitchen',
      call_summary: 'Caller sees German roaches in the kitchen cabinets.',
    };
    expect(vehicleServiceUnitWaiverForCall({ addressValidation: AV_UNIT_MISSING, extracted, services: CATALOG })).toBe(AV_UNIT_MISSING);
  });

  test('an exact vehicle pick with vehicle evidence is waived', () => {
    const extracted = { matched_service: VEHICLE_ROW.name, specific_service_name: VEHICLE_ROW.name, requested_service: 'roaches inside her SUV' };
    const out = vehicleServiceUnitWaiverForCall({ addressValidation: AV_UNIT_MISSING, extracted, services: CATALOG });
    expect(out.wholeStructureUnitWaived.service).toBe('vehicle_german_roach');
  });

  test('a pre-adoption view that resolves a home service keeps the hold', () => {
    const preAdoptionExtracted = { requested_service: 'German roaches in the kitchen', matched_service: 'Cockroach Treatment Service' };
    expect(vehicleServiceUnitWaiverForCall({
      addressValidation: AV_UNIT_MISSING, extracted: CAR_CALL, preAdoptionExtracted, services: CATALOG,
    })).toBe(AV_UNIT_MISSING);
  });
});

test('the vehicle job is a two-treatment package (one included follow-up, never a chain)', () => {
  expect(TWO_TREATMENT_PACKAGE_KEYS.has('vehicle_german_roach')).toBe(true);
});

test('the processor runs the vehicle waiver after the other two, before the verdict is stamped', () => {
  const src = require('fs').readFileSync(require.resolve('../services/call-recording-processor'), 'utf8');
  expect(src).toContain("if (wsAv === v2AddressValidation && isEnabled('callVehicleRoachBooking')) {");
  expect(src.indexOf('ai_address_validation: v2AddressValidation')).toBeLessThan(src.lastIndexOf('vehicleServiceUnitWaiverForCall({'));
  expect(src.lastIndexOf('vehicleServiceUnitWaiverForCall({')).toBeLessThan(src.indexOf('wholeStructureUnitWaived: wsAv.wholeStructureUnitWaived'));
});

const path = require('path');
const describeOrSkip = process.env.DATABASE_URL ? describe : describe.skip;
describeOrSkip('vehicle row stays dark outside the call-recording pipeline (DB-backed)', () => {
  let knex;
  beforeAll(() => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
  });
  afterAll(async () => { if (knex) await knex.destroy(); });

  test('the migration seeds the vehicle row with booking off, and only the opted-in loader sees it', async () => {
    const row = await knex('services').where({ service_key: 'vehicle_german_roach' }).first('booking_enabled', 'base_price', 'is_active');
    expect(row).toBeTruthy();
    expect(row.booking_enabled).toBe(false);
    expect(Number(row.base_price)).toBe(199);
    const { loadBookableCallServices } = require('../services/call-booking-catalog');
    const keys = async (opts) => (await loadBookableCallServices(knex, opts)).map((s) => s.service_key);
    // The voice agent and SMS drafter call without the option.
    expect(await keys()).not.toContain('vehicle_german_roach');
    expect(await keys({ includeVehicleRoach: true })).toContain('vehicle_german_roach');
    expect(await keys({ includeVehicleRoach: true })).not.toContain('vehicle_roach_addon');
  });

  test('gate off: the opted-in loader does not see it either', async () => {
    let loadOff;
    jest.isolateModules(() => {
      const saved = process.env.GATE_CALL_VEHICLE_ROACH_BOOKING;
      delete process.env.GATE_CALL_VEHICLE_ROACH_BOOKING;
      try {
        ({ loadBookableCallServices: loadOff } = require('../services/call-booking-catalog'));
        // Gates are read when feature-gates loads, so load it inside the isolated registry now.
        require('../config/feature-gates');
      } finally {
        process.env.GATE_CALL_VEHICLE_ROACH_BOOKING = saved;
      }
    });
    const rows = await loadOff(knex, { includeVehicleRoach: true });
    expect(rows.map((s) => s.service_key)).not.toContain('vehicle_german_roach');
  });
});

test('only the call-recording pipeline opts in to the vehicle row', () => {
  const fs = require('fs');
  const src = (f) => fs.readFileSync(require.resolve(f), 'utf8');
  expect(src('../services/call-recording-processor')).toContain('loadBookableCallServices(db, { includeVehicleRoach: true })');
  for (const f of ['../services/voice-agent/relay-context', '../services/voice-agent/relay-booking', '../services/sms-shadow-drafter']) {
    expect(src(f)).not.toContain('includeVehicleRoach');
  }
});
