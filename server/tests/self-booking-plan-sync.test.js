const {
  LAWN_CARE_RECURRING_PLANS,
  MOSQUITO_RECURRING_PLANS,
  PEST_CONTROL_RECURRING_PLANS,
  SELF_BOOKING_RECURRING_PLANS,
  TERMITE_BAIT_RECURRING_PLANS,
  TREE_SHRUB_RECURRING_PLANS,
  buildChildScheduledServiceRow,
  buildCustomerActivationUpdates,
  buildCustomerWaveGuardAlignmentUpdates,
  buildRecurringOccurrenceDates,
  buildScheduledServiceUpdates,
  detectWaveGuardPlanKeys,
  inferTierFromServiceCount,
  isOneTimeBookingSource,
  isSelfBookedRow,
  representativePlanKeys,
  resolveLawnCareRecurringPlan,
  resolveMosquitoRecurringPlan,
  resolvePestControlRecurringPlan,
  resolveSelfBookedRecurringPlan,
  resolveTermiteBaitRecurringPlan,
  resolveTreeShrubRecurringPlan,
  serviceFamilyKey,
  serviceRowCountsTowardWaveGuard,
  uniqueServiceFamilies,
} = require('../services/self-booking-plan-sync');

describe('self-booking plan sync helpers', () => {
  test('maps recurring Bronze-eligible public booking services', () => {
    expect(resolveSelfBookedRecurringPlan('Pest Control')).toMatchObject({
      serviceKey: 'pest_general_quarterly',
      tier: 'Bronze',
      monthlyRate: 55,
      recurringPattern: 'quarterly',
    });
    expect(resolveSelfBookedRecurringPlan('Quarterly Pest Control')).toMatchObject({
      serviceKey: 'pest_general_quarterly',
    });
    expect(resolveSelfBookedRecurringPlan('Bi-Monthly Pest Control')).toMatchObject({
      serviceKey: 'pest_general_bimonthly',
      recurringPattern: 'bimonthly',
      visitsPerYear: 6,
    });
    expect(resolveSelfBookedRecurringPlan('Monthly Pest Control')).toMatchObject({
      serviceKey: 'pest_general_monthly',
      recurringPattern: 'monthly',
      visitsPerYear: 12,
    });
    expect(resolveSelfBookedRecurringPlan('Semi-Annual Pest Control')).toMatchObject({
      serviceKey: 'pest_general_semiannual',
      recurringPattern: 'semiannual',
      visitsPerYear: 2,
    });
    expect(resolveSelfBookedRecurringPlan('Lawn Care')).toMatchObject({
      serviceKey: 'lawn_care_quarterly',
      monthlyRate: 84,
    });
    expect(resolveSelfBookedRecurringPlan('Monthly Lawn Care')).toMatchObject({
      serviceKey: 'lawn_care_monthly',
      recurringPattern: 'monthly',
      monthlyRate: 65,
    });
    expect(resolveSelfBookedRecurringPlan('Every 6 Weeks Lawn Care')).toMatchObject({
      serviceKey: 'lawn_care_6week',
      recurringPattern: 'custom',
      recurringIntervalDays: 42,
      monthlyRate: 55,
    });
    expect(resolveSelfBookedRecurringPlan('Bi-Monthly Lawn Care')).toMatchObject({
      serviceKey: 'lawn_care_recurring',
      recurringPattern: 'bimonthly',
      monthlyRate: 46,
    });
    expect(resolveSelfBookedRecurringPlan('Quarterly Lawn Care')).toMatchObject({
      serviceKey: 'lawn_care_quarterly',
      recurringPattern: 'quarterly',
      monthlyRate: 35,
    });
    expect(resolveSelfBookedRecurringPlan('Mosquito Control')).toMatchObject({
      serviceKey: 'mosquito_monthly',
      recurringPattern: 'monthly',
    });
    expect(resolveSelfBookedRecurringPlan('Seasonal Mosquito Control')).toMatchObject({
      serviceKey: 'mosquito_seasonal',
      recurringPattern: 'monthly',
      visitsPerYear: 9,
    });
    expect(resolveSelfBookedRecurringPlan('Tree & Shrub')).toMatchObject({
      serviceKey: 'tree_shrub_program',
      recurringPattern: 'bimonthly',
      monthlyRate: 50,
    });
    expect(resolveSelfBookedRecurringPlan('Tree & Shrub Every 6 Weeks')).toMatchObject({
      serviceKey: 'tree_shrub_6week',
      recurringPattern: 'custom',
      recurringIntervalDays: 42,
      visitsPerYear: 9,
    });
    expect(resolveSelfBookedRecurringPlan('Termite Bait Monitoring')).toMatchObject({
      serviceKey: 'termite_bait',
      monthlyRate: 35,
    });
    expect(resolveSelfBookedRecurringPlan('Termite Active Annual Bait Station Service')).toMatchObject({
      serviceKey: 'termite_active_annual',
      recurringPattern: 'annual',
      visitsPerYear: 1,
    });
    expect(resolveSelfBookedRecurringPlan('Termite Active Bait Station Service Quarterly')).toMatchObject({
      serviceKey: 'termite_bait',
      recurringPattern: 'quarterly',
      visitsPerYear: 4,
    });
  });

  test('does not activate one-time termite inspections or non-qualifying services', () => {
    expect(resolveSelfBookedRecurringPlan('Termite Inspection')).toBeNull();
    expect(resolveSelfBookedRecurringPlan('Rodent Control')).toBeNull();
    expect(resolveSelfBookedRecurringPlan('One-Time Cleanout')).toBeNull();
    expect(resolveSelfBookedRecurringPlan('General Appointment')).toBeNull();
  });

  test('matches lawn cadence variants before the generic lawn fallback', () => {
    expect(resolveLawnCareRecurringPlan('lawn_care_monthly')).toBe(LAWN_CARE_RECURRING_PLANS.monthly);
    expect(resolveLawnCareRecurringPlan('Lawn Care 9 Applications')).toBe(LAWN_CARE_RECURRING_PLANS.every_6_weeks);
    expect(resolveLawnCareRecurringPlan('Lawn Care 6 Apps')).toBe(LAWN_CARE_RECURRING_PLANS.bimonthly);
    expect(resolveLawnCareRecurringPlan('Lawn Care 4 Applications')).toBe(LAWN_CARE_RECURRING_PLANS.quarterly);
    expect(resolveLawnCareRecurringPlan('Bi Monthly Lawn Care')).toBe(LAWN_CARE_RECURRING_PLANS.bimonthly);
    expect(resolveLawnCareRecurringPlan('Lawn Care')).toBe(SELF_BOOKING_RECURRING_PLANS.lawn_care);
  });

  test('matches pest, tree/shrub, mosquito, and termite cadence variants', () => {
    expect(resolvePestControlRecurringPlan('pest_general_semiannual')).toBe(PEST_CONTROL_RECURRING_PLANS.semiannual);
    expect(resolvePestControlRecurringPlan('Pest Control Every Other Month')).toBe(PEST_CONTROL_RECURRING_PLANS.bimonthly);
    expect(resolvePestControlRecurringPlan('Monthly General Pest')).toBe(PEST_CONTROL_RECURRING_PLANS.monthly);
    expect(resolvePestControlRecurringPlan('General Pest')).toBe(PEST_CONTROL_RECURRING_PLANS.quarterly);

    expect(resolveTreeShrubRecurringPlan('tree_shrub_6week')).toBe(TREE_SHRUB_RECURRING_PLANS.every_6_weeks);
    expect(resolveTreeShrubRecurringPlan('Tree & Shrub')).toBe(TREE_SHRUB_RECURRING_PLANS.bimonthly);

    expect(resolveMosquitoRecurringPlan('mosquito_seasonal')).toBe(MOSQUITO_RECURRING_PLANS.seasonal);
    expect(resolveMosquitoRecurringPlan('Mosquito Control')).toBe(MOSQUITO_RECURRING_PLANS.monthly);
    expect(resolveMosquitoRecurringPlan('Mosquito Event Spray')).toBeNull();

    expect(resolveTermiteBaitRecurringPlan('termite_monitoring')).toBe(TERMITE_BAIT_RECURRING_PLANS.quarterly);
    expect(resolveTermiteBaitRecurringPlan('termite_active_annual')).toBe(TERMITE_BAIT_RECURRING_PLANS.active_annual);
    expect(resolveTermiteBaitRecurringPlan('termite_active_bait_quarterly')).toBe(TERMITE_BAIT_RECURRING_PLANS.quarterly);
    expect(resolveTermiteBaitRecurringPlan('Termite Inspection')).toBeNull();
  });

  test('builds rolling child dates on the same ordinal weekday', () => {
    expect(buildRecurringOccurrenceDates('2026-06-19', 'quarterly', 4)).toEqual([
      '2026-06-19',
      '2026-09-18',
      '2026-12-18',
      '2027-03-19',
    ]);
    expect(buildRecurringOccurrenceDates('2026-06-19', 'monthly', 4)).toEqual([
      '2026-06-19',
      '2026-07-17',
      '2026-08-21',
      '2026-09-18',
    ]);
    expect(buildRecurringOccurrenceDates('2026-06-19', 'custom', 4, { intervalDays: 42 })).toEqual([
      '2026-06-19',
      '2026-07-31',
      '2026-09-11',
      '2026-10-23',
    ]);
  });

  test('activates missing plan fields without downgrading existing members', () => {
    const customerColumns = {
      active: {},
      pipeline_stage: {},
      pipeline_stage_changed_at: {},
      waveguard_tier: {},
      monthly_rate: {},
      member_since: {},
    };

    expect(buildCustomerActivationUpdates(
      { waveguard_tier: null, monthly_rate: null, member_since: null },
      SELF_BOOKING_RECURRING_PLANS.pest_control,
      customerColumns,
      '2026-06-19',
    )).toEqual(expect.objectContaining({
      active: true,
      pipeline_stage: 'active_customer',
      pipeline_stage_changed_at: expect.any(Date),
      waveguard_tier: 'Bronze',
      monthly_rate: 55,
      member_since: '2026-06-19',
    }));

    const existingMemberUpdates = buildCustomerActivationUpdates(
      { waveguard_tier: 'Gold', monthly_rate: 149, member_since: '2025-02-01' },
      SELF_BOOKING_RECURRING_PLANS.pest_control,
      customerColumns,
      '2026-06-19',
    );

    expect(existingMemberUpdates).toEqual(expect.objectContaining({
      active: true,
      pipeline_stage: 'active_customer',
      pipeline_stage_changed_at: expect.any(Date),
    }));
    expect(existingMemberUpdates).not.toHaveProperty('waveguard_tier');
    expect(existingMemberUpdates).not.toHaveProperty('monthly_rate');
    expect(existingMemberUpdates).not.toHaveProperty('member_since');

    const lowercaseTierUpdates = buildCustomerActivationUpdates(
      { waveguard_tier: 'silver', monthly_rate: 129, member_since: '2025-02-01' },
      SELF_BOOKING_RECURRING_PLANS.pest_control,
      customerColumns,
      '2026-06-19',
    );
    expect(lowercaseTierUpdates.waveguard_tier).toBe('Silver');
  });

  test('aligns customer tier from unique recurring service families', () => {
    const customerColumns = {
      active: {},
      pipeline_stage: {},
      pipeline_stage_changed_at: {},
      waveguard_tier: {},
      monthly_rate: {},
      member_since: {},
    };
    const detected = [
      'pest_control_quarterly',
      'pest_control_monthly',
      'lawn_care_6week',
      'mosquito_seasonal',
      'tree_shrub_bimonthly',
    ];

    expect(uniqueServiceFamilies(detected)).toEqual(['pest_control', 'lawn_care', 'mosquito', 'tree_shrub']);
    expect(inferTierFromServiceCount(uniqueServiceFamilies(detected).length)).toBe('Platinum');
    expect(representativePlanKeys(detected)).toEqual([
      'pest_control_quarterly',
      'lawn_care_6week',
      'mosquito_seasonal',
      'tree_shrub_bimonthly',
    ]);

    expect(buildCustomerWaveGuardAlignmentUpdates(
      {
        waveguard_tier: 'Bronze',
        monthly_rate: 0,
        member_since: null,
        earliest_service_date: '2026-06-19',
      },
      detected,
      customerColumns,
      '2026-06-20',
    )).toEqual(expect.objectContaining({
      detectedFamilyKeys: ['pest_control', 'lawn_care', 'mosquito', 'tree_shrub'],
      inferredTier: 'Platinum',
      updates: expect.objectContaining({
        active: true,
        pipeline_stage: 'active_customer',
        waveguard_tier: 'Platinum',
        member_since: '2026-06-19',
        monthly_rate: 205,
      }),
    }));

    const existingGold = buildCustomerWaveGuardAlignmentUpdates(
      { waveguard_tier: 'Gold', monthly_rate: 149, member_since: '2025-01-01' },
      ['pest_control_quarterly', 'lawn_care_monthly'],
      customerColumns,
      '2026-06-20',
    );
    expect(existingGold.updates).not.toHaveProperty('waveguard_tier');
    expect(existingGold.updates).not.toHaveProperty('monthly_rate');
  });

  test('detects WaveGuard plan keys only from recurring service rows for sync', () => {
    expect(detectWaveGuardPlanKeys({ service_type: 'Monthly Pest Control' })).toEqual(['pest_control_monthly']);
    expect(detectWaveGuardPlanKeys({ service_type: 'Termite Active Bait Station Service Quarterly' })).toEqual(['termite_bait_quarterly']);
    expect(serviceFamilyKey('pest_control_monthly')).toBe('pest_control');
    expect(isOneTimeBookingSource('quote-wizard-onetime')).toBe(true);
    expect(isOneTimeBookingSource('estimate-accept')).toBe(true);
    expect(serviceRowCountsTowardWaveGuard({ service_type: 'Pest Control' })).toBe(false);
    expect(serviceRowCountsTowardWaveGuard({ service_type: 'Pest Control', is_recurring: true })).toBe(true);
    expect(serviceRowCountsTowardWaveGuard({ service_type: 'Pest Control', recurring_parent_id: 123 })).toBe(false);
    expect(serviceRowCountsTowardWaveGuard({ service_type: 'Pest Control', is_recurring: false, recurring_parent_id: 123 })).toBe(false);
    expect(serviceRowCountsTowardWaveGuard({ service_type: 'Pest Control', is_recurring: true, status: 'completed' })).toBe(false);
    expect(serviceRowCountsTowardWaveGuard({ service_type: 'Pest Control', is_recurring: true, is_callback: true })).toBe(false);
    expect(serviceRowCountsTowardWaveGuard({
      service_type: 'Pest Control',
      source: 'quote-wizard-onetime',
      self_booking_id: 123,
    })).toBe(false);
    expect(serviceRowCountsTowardWaveGuard({
      service_type: 'Pest Control',
      source: 'direct',
      self_booking_id: 123,
    })).toBe(false);
    expect(serviceRowCountsTowardWaveGuard({
      service_type: 'Pest Control',
      source: 'direct',
      self_booking_id: 123,
      recurring_pattern: 'quarterly',
    })).toBe(false);
    expect(serviceRowCountsTowardWaveGuard({
      service_type: 'Pest Control',
      source: 'direct',
      self_booking_id: 123,
      is_recurring: true,
      recurring_pattern: 'quarterly',
    })).toBe(true);
  });

  test('only sets create_invoice_on_complete for plan-covered visits, never for pending self-bookings', () => {
    const plan = SELF_BOOKING_RECURRING_PLANS.pest_control_quarterly || resolveSelfBookedRecurringPlan('Pest Control');
    const serviceColumns = { service_type: {}, is_recurring: {}, recurring_pattern: {}, recurring_ongoing: {}, service_id: {}, create_invoice_on_complete: {}, recurring_parent_id: {} };

    // Plan activated -> billed via the plan, not per visit.
    expect(buildScheduledServiceUpdates(plan, serviceColumns, null, true).create_invoice_on_complete).toBe(false);
    // Plan NOT activated (public self-booking) -> flag left unset so the column default
    // (operator-driven billing) applies; it carries no per-visit price to invoice.
    expect(buildScheduledServiceUpdates(plan, serviceColumns, null, false)).not.toHaveProperty('create_invoice_on_complete');

    const childArgs = { plan, serviceColumns, serviceId: null, parentService: { id: 1, customer_id: 7 }, scheduledDate: '2026-09-18' };
    expect(buildChildScheduledServiceRow({ ...childArgs, planCovered: true }).create_invoice_on_complete).toBe(false);
    expect(buildChildScheduledServiceRow({ ...childArgs, planCovered: false })).not.toHaveProperty('create_invoice_on_complete');
  });

  test('normalizes pg DATE base dates without an ET day shift', () => {
    // buildRecurringOccurrenceDates runs the base through normalizeDateString; a pg DATE
    // column arrives as a midnight Date and must not be converted as an ET instant
    // (which would move 2026-06-19 to 2026-06-18 on a UTC server).
    expect(buildRecurringOccurrenceDates(new Date('2026-06-19T00:00:00.000Z'), 'quarterly', 1)[0]).toBe('2026-06-19');
    expect(buildRecurringOccurrenceDates('2026-06-19', 'quarterly', 1)[0]).toBe('2026-06-19');
  });

  test('identifies self-booked rows so pending bookings do not bootstrap membership', () => {
    expect(isSelfBookedRow({ source: 'self_booked' })).toBe(true);
    expect(isSelfBookedRow({ source: 'SELF_BOOKED' })).toBe(true);
    expect(isSelfBookedRow({ self_booking_id: 42 })).toBe(true);
    expect(isSelfBookedRow({ source: 'admin' })).toBe(false);
    expect(isSelfBookedRow({ source: 'direct' })).toBe(false);
    expect(isSelfBookedRow({})).toBe(false);
  });
});
