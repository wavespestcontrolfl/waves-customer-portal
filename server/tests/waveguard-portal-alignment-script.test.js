const {
  buildCustomerUpdates,
  dateKey,
  detectServiceKeys,
  inferTierFromServiceCount,
  normalizeTierName,
  parseBooleanFlag,
  representativePlanKeys,
  serviceFamilyKey,
  uniqueServiceFamilies,
} = require('../scripts/align-waveguard-portal-records');

describe('WaveGuard portal alignment script helpers', () => {
  const customerColumns = {
    active: {},
    pipeline_stage: {},
    pipeline_stage_changed_at: {},
    waveguard_tier: {},
    monthly_rate: {},
    member_since: {},
  };

  test('detects all portal-qualifying recurring service families', () => {
    expect(detectServiceKeys({ service_type: 'General Pest Control' })).toEqual(['pest_control_quarterly']);
    expect(detectServiceKeys({ service_type: 'Lawn Fertilization & Weed Control' })).toEqual(['lawn_care']);
    expect(detectServiceKeys({ service_type: 'Mosquito Control (Monthly)' })).toEqual(['mosquito_monthly']);
    expect(detectServiceKeys({ service_type: 'Tree & Shrub Care Program' })).toEqual(['tree_shrub_bimonthly']);
    expect(detectServiceKeys({ service_type: 'Termite Bait Station Monitoring' })).toEqual(['termite_bait_quarterly']);
    expect(detectServiceKeys({ service_type: 'Pest + Lawn + Mosquito Bundle' })).toEqual(['pest_control_quarterly', 'lawn_care', 'mosquito_monthly']);
  });

  test('detects pest, tree/shrub, mosquito, and termite cadence variants without overcounting families', () => {
    expect(detectServiceKeys({ service_key: 'pest_general_bimonthly', service_type: 'Bi-Monthly Pest Control' })).toEqual(['pest_control_bimonthly']);
    expect(detectServiceKeys({ service_key: 'pest_general_monthly', service_type: 'Monthly Pest Control' })).toEqual(['pest_control_monthly']);
    expect(detectServiceKeys({ service_key: 'pest_general_semiannual', service_type: 'Semiannual Pest Control' })).toEqual(['pest_control_semiannual']);
    expect(detectServiceKeys({ service_key: 'tree_shrub_6week', service_type: 'Tree & Shrub Every 6 Weeks' })).toEqual(['tree_shrub_6week']);
    expect(detectServiceKeys({ service_key: 'mosquito_seasonal', service_type: 'Seasonal Mosquito Control' })).toEqual(['mosquito_seasonal']);
    expect(detectServiceKeys({ service_key: 'termite_active_annual', service_type: 'Termite Active Annual Bait Station Service' })).toEqual(['termite_bait_active_annual']);
    expect(detectServiceKeys({ service_key: 'termite_monitoring', service_type: 'Termite Monitoring Service' })).toEqual(['termite_bait_quarterly']);
    expect(detectServiceKeys({ service_key: 'termite_active_bait_quarterly', service_type: 'Termite Active Bait Station Service Quarterly' })).toEqual(['termite_bait_quarterly']);

    const variants = [
      'pest_control_quarterly',
      'pest_control_bimonthly',
      'pest_control_monthly',
      'pest_control_semiannual',
      'tree_shrub_bimonthly',
      'tree_shrub_6week',
      'mosquito_monthly',
      'mosquito_seasonal',
      'termite_bait_quarterly',
      'termite_bait_active_annual',
    ];
    expect(uniqueServiceFamilies(variants)).toEqual(['pest_control', 'tree_shrub', 'mosquito', 'termite_bait']);
  });

  test('detects lawn cadence variants without overcounting the family', () => {
    expect(detectServiceKeys({ service_key: 'lawn_care_monthly', service_type: 'Monthly Lawn Care' })).toEqual(['lawn_care_monthly']);
    expect(detectServiceKeys({ service_key: 'lawn_care_6week', service_type: 'Every 6 Weeks Lawn Care' })).toEqual(['lawn_care_6week']);
    expect(detectServiceKeys({ service_key: 'lawn_care_recurring', service_type: 'Bi-Monthly Lawn Care' })).toEqual(['lawn_care_bimonthly']);
    expect(detectServiceKeys({ service_key: 'lawn_care_quarterly', service_type: 'Quarterly Lawn Care' })).toEqual(['lawn_care_quarterly']);

    const variants = ['lawn_care_monthly', 'lawn_care_6week', 'lawn_care_bimonthly', 'lawn_care_quarterly'];
    expect(variants.map(serviceFamilyKey)).toEqual(['lawn_care', 'lawn_care', 'lawn_care', 'lawn_care']);
    expect(uniqueServiceFamilies(variants)).toEqual(['lawn_care']);
    expect(representativePlanKeys(['pest_control_quarterly', ...variants, 'mosquito_monthly'])).toEqual(['pest_control_quarterly', 'lawn_care_monthly', 'mosquito_monthly']);
  });

  test('prefers the catalog service_key cadence over a generic service_type', () => {
    // Rows whose cadence lives in service_id surface svc.service_key via the join;
    // detection must read it instead of falling back to the generic family plan.
    expect(detectServiceKeys({ service_type: 'Lawn Care', service_key: 'lawn_care_monthly' })).toEqual(['lawn_care_monthly']);
    expect(detectServiceKeys({ service_type: 'Pest Control', service_key: 'pest_general_bimonthly' })).toEqual(['pest_control_bimonthly']);
    expect(detectServiceKeys({ service_type: 'Tree & Shrub', service_name: 'Tree & Shrub Every 6 Weeks' })).toEqual(['tree_shrub_6week']);
  });

  test('catalog service_key cadence wins over a STALE conflicting service_type label', () => {
    // service_key is authoritative: a lawn_care_monthly row still labeled "Quarterly
    // Lawn Care" must resolve as monthly, not quarterly.
    expect(detectServiceKeys({ service_type: 'Quarterly Lawn Care', service_key: 'lawn_care_monthly' })).toEqual(['lawn_care_monthly']);
    expect(detectServiceKeys({ service_type: 'Monthly Pest Control', service_key: 'pest_general_quarterly' })).toEqual(['pest_control_quarterly']);
    // No catalog key -> fall back to service_type cadence.
    expect(detectServiceKeys({ service_type: 'Quarterly Lawn Care' })).toEqual(['lawn_care_quarterly']);
    // Generic (non-cadence) catalog key -> the cadence in service_type still wins.
    expect(detectServiceKeys({
      service_type: 'Every 6 Weeks Lawn Care',
      service_key: 'lawn_fertilization',
      service_name: 'Lawn Fertilization & Weed Control',
    })).toEqual(['lawn_care_6week']);
  });

  test('does not treat one-time termite or rodent work as WaveGuard portal services', () => {
    expect(detectServiceKeys({ service_type: 'Termite Inspection' })).toEqual([]);
    expect(detectServiceKeys({ service_type: 'Rodent Exclusion' })).toEqual([]);
  });

  test('does not treat re-service callbacks as plan coverage for any family', () => {
    // A free re-treatment whose catalog service_key encodes the callback must not
    // be read as recurring plan coverage even though it carries a family token.
    expect(detectServiceKeys({ service_type: 'Lawn Care', service_key: 'lawn_re_service' })).toEqual([]);
    expect(detectServiceKeys({ service_type: 'Mosquito Control', service_key: 'mosquito_re_service' })).toEqual([]);
    expect(detectServiceKeys({ service_type: 'Tree & Shrub', service_name: 'Tree & Shrub Re-Service' })).toEqual([]);
    expect(detectServiceKeys({ service_type: 'Termite Bait Station Re-Service' })).toEqual([]);
    expect(detectServiceKeys({ service_type: 'Lawn Care Callback Visit' })).toEqual([]);
  });

  test('re-aligns enrolled members and fills missing fields without overwriting positive rates', () => {
    // Enrolled member (has a tier) missing portal fields -> filled.
    expect(buildCustomerUpdates(
      {
        active: false,
        pipeline_stage: 'new_lead',
        waveguard_tier: 'Bronze',
        monthly_rate: 0,
        member_since: null,
        earliest_service_date: '2026-06-19',
      },
      ['mosquito'],
      customerColumns,
      '2026-06-20',
    )).toEqual(expect.objectContaining({
      active: true,
      pipeline_stage: 'active_customer',
      pipeline_stage_changed_at: expect.any(Date),
      monthly_rate: 45,
      member_since: '2026-06-19',
    }));

    const existingRateUpdates = buildCustomerUpdates(
      {
        active: true,
        pipeline_stage: 'active_customer',
        waveguard_tier: 'Silver',
        monthly_rate: 129,
        member_since: '2025-01-01',
      },
      ['pest_control', 'lawn_care'],
      customerColumns,
      '2026-06-20',
    );

    expect(existingRateUpdates).not.toHaveProperty('monthly_rate');
    expect(existingRateUpdates).not.toHaveProperty('member_since');
  });

  test('re-aligns enrolled members only; never enrolls a non-member from recurring services', () => {
    // No tier and no monthly_rate -> not WaveGuard-enrolled -> no mutations even with
    // detected recurring services (per-visit recurring customers must not be enrolled).
    expect(buildCustomerUpdates(
      {
        active: false,
        pipeline_stage: 'new_lead',
        monthly_rate: null,
        member_since: null,
        earliest_service_date: '2026-06-19',
      },
      ['mosquito', 'pest_control', 'lawn_care'],
      customerColumns,
      '2026-06-20',
    )).toEqual({});

    // A legacy member with a positive monthly_rate but no tier IS enrolled -> re-aligned.
    expect(buildCustomerUpdates(
      {
        active: true,
        pipeline_stage: 'active_customer',
        waveguard_tier: null,
        monthly_rate: 89,
        member_since: '2025-01-01',
      },
      ['pest_control', 'lawn_care'],
      customerColumns,
      '2026-06-20',
    )).toEqual(expect.objectContaining({ waveguard_tier: 'Silver' }));

    // An explicit non-member sentinel tier ('none') is NOT a member even with a
    // positive monthly_rate -> no mutations.
    expect(buildCustomerUpdates(
      {
        active: false,
        pipeline_stage: 'new_lead',
        waveguard_tier: 'none',
        monthly_rate: 89,
        member_since: null,
      },
      ['pest_control', 'lawn_care'],
      customerColumns,
      '2026-06-20',
    )).toEqual({});
  });

  test('makes no customer-state mutations without recurring-service evidence', () => {
    expect(buildCustomerUpdates(
      {
        active: false,
        pipeline_stage: 'new_lead',
        waveguard_tier: 'Bronze',
        monthly_rate: null,
        member_since: null,
        earliest_service_date: '2026-06-19',
      },
      [],
      customerColumns,
      '2026-06-20',
    )).toEqual({});
  });

  test('parses --apply/--include-inactive so dry-run stays the default', () => {
    expect(parseBooleanFlag(true)).toBe(true);
    expect(parseBooleanFlag('true')).toBe(true);
    expect(parseBooleanFlag('1')).toBe(true);
    expect(parseBooleanFlag(' YES ')).toBe(true);
    expect(parseBooleanFlag('false')).toBe(false);
    expect(parseBooleanFlag('0')).toBe(false);
    expect(parseBooleanFlag('no')).toBe(false);
    expect(parseBooleanFlag(undefined)).toBe(false);
    expect(parseBooleanFlag(null)).toBe(false);
    expect(parseBooleanFlag(false)).toBe(false);
  });

  test('normalizes recognized tier casing for portal lookups', () => {
    expect(normalizeTierName('bronze')).toBe('Bronze');
    expect(normalizeTierName(' GOLD ')).toBe('Gold');
    expect(normalizeTierName('starter')).toBeNull();

    const updates = buildCustomerUpdates(
      {
        active: true,
        pipeline_stage: 'active_customer',
        waveguard_tier: 'silver',
        monthly_rate: 129,
        member_since: '2025-01-01',
      },
      ['pest_control', 'lawn_care'],
      customerColumns,
      '2026-06-20',
    );

    expect(updates).toEqual({ waveguard_tier: 'Silver' });
  });

  test('upgrades existing tiers when recurring service family count is higher', () => {
    const updates = buildCustomerUpdates(
      {
        active: true,
        pipeline_stage: 'active_customer',
        waveguard_tier: 'Bronze',
        monthly_rate: 110,
        member_since: '2025-01-01',
      },
      ['pest_control_quarterly', 'lawn_care_6week', 'mosquito_monthly'],
      customerColumns,
      '2026-06-20',
    );

    expect(updates).toEqual({ waveguard_tier: 'Gold' });
  });

  test('reads pg DATE columns as the stored calendar day without an ET shift', () => {
    // pg returns a DATE column as a midnight Date; on a UTC server converting it as an
    // instant through ET would shift it back a day. etDateString always uses ET, so an
    // explicit UTC-midnight Date reproduces the Railway off-by-one regardless of host TZ.
    expect(dateKey(new Date('2026-06-19T00:00:00.000Z'))).toBe('2026-06-19');
    expect(dateKey('2026-06-19')).toBe('2026-06-19');
    expect(dateKey('2026-06-19T00:00:00.000Z')).toBe('2026-06-19');
    expect(dateKey(null)).toBeNull();
  });

  test('infers tier from unique qualifying service count for reporting only', () => {
    expect(inferTierFromServiceCount(0)).toBeNull();
    expect(inferTierFromServiceCount(1)).toBe('Bronze');
    expect(inferTierFromServiceCount(2)).toBe('Silver');
    expect(inferTierFromServiceCount(3)).toBe('Gold');
    expect(inferTierFromServiceCount(4)).toBe('Platinum');
  });
});
