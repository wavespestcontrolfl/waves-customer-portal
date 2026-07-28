const {
  LAWN_CARE_RECURRING_PLANS,
  MOSQUITO_RECURRING_PLANS,
  PEST_CONTROL_RECURRING_PLANS,
  SELF_BOOKING_RECURRING_PLANS,
  TERMITE_BAIT_RECURRING_PLANS,
  TREE_SHRUB_RECURRING_PLANS,
  buildCustomerWaveGuardAlignmentUpdates,
  buildLabelOnlyTierRealignmentUpdates,
  buildNoPlanTierEnrollmentUpdates,
  isAutoDerivedTierLabelRow,
  isCommercialServiceRow,
  isRodentLedServiceRow,
  buildRecurringOccurrenceDates,
  detectWaveGuardPlanKeys,
  inferTierFromServiceCount,
  isOneTimeBookingSource,
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
    // Light (4x) tier (audit 2026-07-18 P2): a quarterly T&S row used to
    // resolve to the bimonthly plan, so WaveGuard alignment assumed 6 visits.
    expect(resolveTreeShrubRecurringPlan('tree_shrub_quarterly')).toBe(TREE_SHRUB_RECURRING_PLANS.quarterly);
    expect(resolveTreeShrubRecurringPlan('Quarterly Tree & Shrub Care Service')).toBe(TREE_SHRUB_RECURRING_PLANS.quarterly);
    expect(resolveTreeShrubRecurringPlan('Tree & Shrub Light (4 visits)')).toBe(TREE_SHRUB_RECURRING_PLANS.quarterly);

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
        billing_mode: 'monthly_membership',
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

    // Rate repair lanes: the legacy NULL lane keeps its pre-existing repair
    // (a recognized member with a zeroed rate is outside billing-cron's
    // positive-rate selection until repaired) — but an 'auto'-provenance
    // label must never have a rate invented, and explicit non-monthly lanes
    // never backfill (Codex #3011 r10).
    const nullLaneLegacy = buildCustomerWaveGuardAlignmentUpdates(
      {
        waveguard_tier: 'Bronze',
        monthly_rate: 0,
        billing_mode: null,
        member_since: '2025-01-01',
      },
      detected,
      customerColumns,
      '2026-06-20',
    );
    expect(nullLaneLegacy.updates).toHaveProperty('monthly_rate', 205);
    const nullLaneAutoLabel = buildCustomerWaveGuardAlignmentUpdates(
      {
        waveguard_tier: 'Bronze',
        waveguard_tier_source: 'auto',
        monthly_rate: 0,
        billing_mode: null,
        member_since: '2025-01-01',
      },
      detected,
      customerColumns,
      '2026-06-20',
    );
    expect(nullLaneAutoLabel.updates).not.toHaveProperty('monthly_rate');
    const perVisitLane = buildCustomerWaveGuardAlignmentUpdates(
      {
        waveguard_tier: 'Bronze',
        monthly_rate: 0,
        billing_mode: 'per_visit',
        member_since: '2025-01-01',
      },
      detected,
      customerColumns,
      '2026-06-20',
    );
    expect(perVisitLane.updates).not.toHaveProperty('monthly_rate');

    const existingGold = buildCustomerWaveGuardAlignmentUpdates(
      { waveguard_tier: 'Gold', monthly_rate: 149, member_since: '2025-01-01' },
      ['pest_control_quarterly', 'lawn_care_monthly'],
      customerColumns,
      '2026-06-20',
    );
    expect(existingGold.updates).not.toHaveProperty('waveguard_tier');
    expect(existingGold.updates).not.toHaveProperty('monthly_rate');
  });

  test('auto-enrolls a No-Plan customer as tier ONLY, scaled by family count', () => {
    const customerColumns = {
      active: {},
      pipeline_stage: {},
      waveguard_tier: {},
      waveguard_tier_source: {},
      monthly_rate: {},
      member_since: {},
    };
    const noPlan = { waveguard_tier: null, monthly_rate: null, active: true, pipeline_stage: 'won' };

    // Exactly { waveguard_tier, waveguard_tier_source: 'auto' } — never
    // monthly_rate / member_since / pipeline_stage / active: the label must
    // not create billing state, and every stamp records 'auto' provenance so
    // only these tiers are ever auto-realigned.
    expect(buildNoPlanTierEnrollmentUpdates(noPlan, ['pest_control_quarterly'], customerColumns))
      .toEqual(expect.objectContaining({
        updates: { waveguard_tier: 'Bronze', waveguard_tier_source: 'auto' },
        inferredTier: 'Bronze',
      }));
    expect(buildNoPlanTierEnrollmentUpdates(noPlan, ['pest_control_quarterly', 'lawn_care_monthly'], customerColumns).updates)
      .toEqual({ waveguard_tier: 'Silver', waveguard_tier_source: 'auto' });
    expect(buildNoPlanTierEnrollmentUpdates(noPlan, ['pest_control_quarterly', 'lawn_care_monthly', 'mosquito_monthly'], customerColumns).updates)
      .toEqual({ waveguard_tier: 'Gold', waveguard_tier_source: 'auto' });
    expect(buildNoPlanTierEnrollmentUpdates(
      noPlan,
      ['pest_control_quarterly', 'lawn_care_monthly', 'mosquito_monthly', 'termite_bait_quarterly'],
      customerColumns,
    ).updates).toEqual({ waveguard_tier: 'Platinum', waveguard_tier_source: 'auto' });

    // Cadence variants of one family never overcount the tier.
    expect(buildNoPlanTierEnrollmentUpdates(noPlan, ['lawn_care_monthly', 'lawn_care_6week'], customerColumns).updates)
      .toEqual({ waveguard_tier: 'Bronze', waveguard_tier_source: 'auto' });

    // Explicit non-member sentinels still enroll — the directive keys on
    // upcoming recurring coverage, not the old label.
    expect(buildNoPlanTierEnrollmentUpdates({ ...noPlan, waveguard_tier: 'none' }, ['pest_control_quarterly'], customerColumns).updates)
      .toEqual({ waveguard_tier: 'Bronze', waveguard_tier_source: 'auto' });

    // Pre-migration environment (no provenance column): enrollment REFUSES
    // to stamp — a tier without recorded provenance would surface as a
    // NULL-provenance "member" once the migration lands (Codex #3011 r11).
    expect(buildNoPlanTierEnrollmentUpdates(noPlan, ['pest_control_quarterly'], { waveguard_tier: {}, monthly_rate: {} }).updates)
      .toEqual({});
  });

  test('tier auto-enrollment fail-closes on members, commercial, and no evidence', () => {
    const customerColumns = { waveguard_tier: {}, monthly_rate: {} };

    // Existing members belong to the alignment path, never enrollment.
    expect(buildNoPlanTierEnrollmentUpdates({ waveguard_tier: 'Bronze' }, ['pest_control_quarterly', 'lawn_care_monthly'], customerColumns).updates)
      .toEqual({});
    expect(buildNoPlanTierEnrollmentUpdates({ waveguard_tier: null, monthly_rate: 89 }, ['pest_control_quarterly'], customerColumns).updates)
      .toEqual({});

    // Commercial sentinel never converts to a WaveGuard tier.
    expect(buildNoPlanTierEnrollmentUpdates({ waveguard_tier: 'Commercial', monthly_rate: null }, ['pest_control_quarterly'], customerColumns).updates)
      .toEqual({});

    // No detected qualifying plan keys, or no tier column -> no mutation.
    expect(buildNoPlanTierEnrollmentUpdates({ waveguard_tier: null, monthly_rate: null }, [], customerColumns).updates)
      .toEqual({});
    expect(buildNoPlanTierEnrollmentUpdates({ waveguard_tier: null, monthly_rate: null }, ['pest_control_quarterly'], { monthly_rate: {} }).updates)
      .toEqual({});
  });

  test('commercial service rows are never auto-tier evidence, whatever the sentinel', () => {
    // An imported commercial customer whose tier is still NULL must not be
    // stamped a residential tier off commercial rows — commercial plans are
    // flat and outside WaveGuard tiers.
    expect(isCommercialServiceRow({ service_type: 'Commercial Pest Control' })).toBe(true);
    expect(isCommercialServiceRow({ service_type: 'Commercial Turf Treatment Program' })).toBe(true);
    expect(isCommercialServiceRow({ service_type: 'Lawn Care', service_name: 'Commercial Turf Program' })).toBe(true);
    expect(isCommercialServiceRow({ service_type: 'Quarterly Pest Control Service' })).toBe(false);
    expect(isCommercialServiceRow({ service_type: 'Monthly Lawn Care' })).toBe(false);
    expect(isCommercialServiceRow({})).toBe(false);
  });

  test('rodent-led rows are never auto-tier evidence; pest-primary combined names still count', () => {
    // Mirrors toQualifyingKeys in waveguard-existing-services: "Rodent Pest
    // Control" is a rodent service row (no keys), not pest coverage, but the
    // pest resolver would map it to the quarterly pest plan if unguarded.
    expect(isRodentLedServiceRow({ service_type: 'Rodent Pest Control' })).toBe(true);
    expect(isRodentLedServiceRow({ service_type: 'Rodent Bait Station Service' })).toBe(true);
    expect(isRodentLedServiceRow({ service_type: 'Rat Control Quarterly' })).toBe(true);
    expect(isRodentLedServiceRow({ service_type: 'Pest & Rodent Control' })).toBe(false);
    expect(isRodentLedServiceRow({ service_type: 'Quarterly Pest Control Service' })).toBe(false);
    expect(isRodentLedServiceRow({})).toBe(false);

    // Per-field classification (Codex #3011 r7): a stale/generic
    // service_type in FRONT of a rodent catalog name must not read as
    // pest-primary from token order across concatenated fields, and
    // underscored catalog keys must still match word boundaries.
    expect(isRodentLedServiceRow({
      service_type: 'Pest Control',
      service_key: 'rodent_general_one_time',
      service_name: 'Rodent Pest Control',
    })).toBe(true);
    expect(isRodentLedServiceRow({ service_key: 'rodent_bait_program' })).toBe(true);
    // A pest-primary combined name in each populated field stays pest.
    expect(isRodentLedServiceRow({
      service_type: 'Pest & Rodent Control',
      service_name: 'Pest & Rodent Control',
    })).toBe(false);
  });

  test('auto-derived label detection: only auto-provenance zero-rate label-lane tiers', () => {
    // Labels: excluded from member messaging, lifecycle emails, and the
    // deposit / card-on-file paid-member exemptions.
    expect(isAutoDerivedTierLabelRow({ waveguard_tier: 'Bronze', waveguard_tier_source: 'auto', monthly_rate: 0, billing_mode: null })).toBe(true);
    expect(isAutoDerivedTierLabelRow({ waveguard_tier: 'Silver', waveguard_tier_source: 'auto', monthly_rate: null, billing_mode: 'per_visit' })).toBe(true);

    // Real members in every other shape — manual/NULL provenance, positive
    // rate, or a paying lane — keep full member behavior.
    expect(isAutoDerivedTierLabelRow({ waveguard_tier: 'Bronze', waveguard_tier_source: 'manual', monthly_rate: 0, billing_mode: null })).toBe(false);
    expect(isAutoDerivedTierLabelRow({ waveguard_tier: 'Bronze', monthly_rate: 0, billing_mode: null })).toBe(false);
    expect(isAutoDerivedTierLabelRow({ waveguard_tier: 'Bronze', waveguard_tier_source: 'auto', monthly_rate: 55, billing_mode: null })).toBe(false);
    expect(isAutoDerivedTierLabelRow({ waveguard_tier: 'Bronze', waveguard_tier_source: 'auto', monthly_rate: 0, billing_mode: 'monthly_membership' })).toBe(false);
    expect(isAutoDerivedTierLabelRow({ waveguard_tier: null, waveguard_tier_source: 'auto', monthly_rate: 0 })).toBe(false);
    expect(isAutoDerivedTierLabelRow({})).toBe(false);
  });

  test('realigns an auto-stamped label-only customer to exactly what upcoming coverage supports', () => {
    const customerColumns = { waveguard_tier: {}, waveguard_tier_source: {}, monthly_rate: {} };
    const labelOnly = { monthly_rate: null, billing_mode: null, waveguard_tier_source: 'auto' };

    // Silver with only one remaining family -> Bronze (provenance kept).
    expect(buildLabelOnlyTierRealignmentUpdates({ ...labelOnly, waveguard_tier: 'Silver' }, ['pest_control_quarterly'], customerColumns).updates)
      .toEqual({ waveguard_tier: 'Bronze' });
    // Platinum down to two families -> Silver.
    expect(buildLabelOnlyTierRealignmentUpdates({ ...labelOnly, waveguard_tier: 'Platinum' }, ['pest_control_quarterly', 'lawn_care_monthly'], customerColumns).updates)
      .toEqual({ waveguard_tier: 'Silver' });
    // No upcoming recurring coverage at all -> tier AND provenance cleared,
    // so a later re-enrollment starts clean.
    expect(buildLabelOnlyTierRealignmentUpdates({ ...labelOnly, waveguard_tier: 'Bronze' }, [], customerColumns).updates)
      .toEqual({ waveguard_tier: null, waveguard_tier_source: null });

    // Coverage ABOVE the current label is raised too (a second family added
    // by import/direct edit outside the booking-time hook) — Codex #3011 P2.
    expect(buildLabelOnlyTierRealignmentUpdates({ ...labelOnly, waveguard_tier: 'Bronze' }, ['pest_control_quarterly', 'lawn_care_monthly'], customerColumns).updates)
      .toEqual({ waveguard_tier: 'Silver' });
    // Coverage equal to the current tier -> untouched.
    expect(buildLabelOnlyTierRealignmentUpdates({ ...labelOnly, waveguard_tier: 'Bronze' }, ['pest_control_quarterly'], customerColumns).updates)
      .toEqual({});
  });

  test('never auto-realigns paying members, paid lanes, unprovenanced tiers, or unrecognized tiers', () => {
    const customerColumns = { waveguard_tier: {}, waveguard_tier_source: {}, monthly_rate: {} };

    // NO provenance ('auto' absent): a pre-existing tier — possibly a
    // legitimate legacy member whose billing lane is intentionally NULL
    // (unclassified, migration 20260717000001) — must NEVER be treated as a
    // derived label, whatever its rate/lane (Codex #3011 r7 P1).
    expect(buildLabelOnlyTierRealignmentUpdates({ waveguard_tier: 'Silver', monthly_rate: 0, billing_mode: null }, [], customerColumns).updates)
      .toEqual({});
    expect(buildLabelOnlyTierRealignmentUpdates({ waveguard_tier: 'Silver', monthly_rate: 0, billing_mode: null, waveguard_tier_source: 'manual' }, [], customerColumns).updates)
      .toEqual({});
    // Missing provenance COLUMN (pre-migration environment) fail-closes even
    // for an 'auto'-marked row object.
    expect(buildLabelOnlyTierRealignmentUpdates(
      { waveguard_tier: 'Silver', monthly_rate: 0, waveguard_tier_source: 'auto' },
      [],
      { waveguard_tier: {}, monthly_rate: {} },
    ).updates).toEqual({});

    // Positive monthly_rate = paying member — the cancellation/offboarding
    // flow owns their tier, a schedule gap must not strip it.
    expect(buildLabelOnlyTierRealignmentUpdates({ waveguard_tier: 'Silver', monthly_rate: 129, waveguard_tier_source: 'auto' }, [], customerColumns).updates)
      .toEqual({});
    // Explicit paying lanes are preserved even at rate 0 — allowlist, so
    // monthly_membership, annual_prepay (prepaid-term lifecycle owns that
    // state — Codex #3011 P1), per_application, and unknown future lanes all
    // stay untouched.
    for (const lane of ['monthly_membership', 'annual_prepay', 'per_application', 'some_future_lane']) {
      expect(buildLabelOnlyTierRealignmentUpdates({ waveguard_tier: 'Bronze', monthly_rate: 0, billing_mode: lane, waveguard_tier_source: 'auto' }, [], customerColumns).updates)
        .toEqual({});
    }
    // The label-only lanes remain realignable for 'auto' tiers.
    for (const lane of ['per_visit', 'one_time']) {
      expect(buildLabelOnlyTierRealignmentUpdates({ waveguard_tier: 'Bronze', monthly_rate: 0, billing_mode: lane, waveguard_tier_source: 'auto' }, [], customerColumns).updates)
        .toEqual({ waveguard_tier: null, waveguard_tier_source: null });
    }
    // No recognized tier (No Plan / sentinels) -> nothing to realign.
    expect(buildLabelOnlyTierRealignmentUpdates({ waveguard_tier: null, monthly_rate: null }, [], customerColumns).updates)
      .toEqual({});
    expect(buildLabelOnlyTierRealignmentUpdates({ waveguard_tier: 'none', monthly_rate: null }, [], customerColumns).updates)
      .toEqual({});
    // Missing waveguard_tier column (older environment) -> no mutation.
    expect(buildLabelOnlyTierRealignmentUpdates({ waveguard_tier: 'Silver', monthly_rate: 0, waveguard_tier_source: 'auto' }, [], { waveguard_tier_source: {}, monthly_rate: {} }).updates)
      .toEqual({});
  });

  test('detects WaveGuard plan keys only from recurring service rows for sync', () => {
    expect(detectWaveGuardPlanKeys({ service_type: 'Monthly Pest Control' })).toEqual(['pest_control_monthly']);
    expect(detectWaveGuardPlanKeys({ service_type: 'Termite Active Bait Station Service Quarterly' })).toEqual(['termite_bait_quarterly']);
    // Cadence-specific catalog key wins over a stale service_type label...
    expect(detectWaveGuardPlanKeys({ service_type: 'Quarterly Lawn Care', service_key: 'lawn_care_monthly' })).toEqual(['lawn_care_monthly']);
    // ...but a GENERIC catalog key must not suppress the cadence in service_type.
    expect(detectWaveGuardPlanKeys({ service_type: 'Every 6 Weeks Lawn Care', service_key: 'lawn_fertilization', service_name: 'Lawn Fertilization & Weed Control' })).toEqual(['lawn_care_6week']);
    expect(serviceFamilyKey('pest_control_monthly')).toBe('pest_control');
    expect(isOneTimeBookingSource('quote-wizard-onetime')).toBe(true);
    expect(isOneTimeBookingSource('estimate-accept')).toBe(true);
    // Admin one-time booking resends (estimate_accepted_onetime SMS) must not
    // seed a recurring series (Codex round-6 P2 on #2944).
    expect(isOneTimeBookingSource('admin-manual-booking-resend')).toBe(true);
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

  test('normalizes pg DATE base dates without an ET day shift', () => {
    // buildRecurringOccurrenceDates runs the base through normalizeDateString; a pg DATE
    // column arrives as a midnight Date and must not be converted as an ET instant
    // (which would move 2026-06-19 to 2026-06-18 on a UTC server).
    expect(buildRecurringOccurrenceDates(new Date('2026-06-19T00:00:00.000Z'), 'quarterly', 1)[0]).toBe('2026-06-19');
    expect(buildRecurringOccurrenceDates('2026-06-19', 'quarterly', 1)[0]).toBe('2026-06-19');
  });

});
