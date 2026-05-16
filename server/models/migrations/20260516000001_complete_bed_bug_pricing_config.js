const COMPLETE_BED_BUG_PRICING_CONFIG = {
  service: 'bed_bug',
  laborRate: 35,
  driveMinutes: 20,
  recurringDiscountEligible: false,
  maxRecurringDiscountPct: 0,
  allowedMethods: ['CHEMICAL', 'HEAT', 'HYBRID'],
  severity: {
    light: { label: 'Light', visits: 2, multiplier: 1.00, quoteRequired: false },
    moderate: { label: 'Moderate', visits: 3, multiplier: 1.15, quoteRequired: false },
    heavy: { label: 'Heavy', visits: 3, multiplier: 1.30, quoteRequired: false },
    severe: { label: 'Severe', visits: null, multiplier: null, quoteRequired: true },
  },
  prepStatus: {
    ready: { label: 'Ready', multiplier: 1.00, allowed: true },
    partial: { label: 'Partial Prep', multiplier: 1.15, allowed: true },
    poor: {
      label: 'Poor Prep',
      multiplier: 1.30,
      allowed: true,
      warnings: ['Poor prep materially increases failure/callback risk.'],
    },
    refused: { label: 'Prep Refused', multiplier: null, allowed: false, quoteRequired: true },
  },
  occupancyType: {
    singleFamily: { label: 'Single Family', multiplier: 1.00 },
    apartment: { label: 'Apartment / Multi-Family', multiplier: 1.15 },
    hotel: { label: 'Hotel / Hospitality', multiplier: 1.30 },
    studentHousing: { label: 'Student Housing', multiplier: 1.35 },
  },
  stories: {
    one: { maxStories: 1, multiplier: 1.00 },
    two: { maxStories: 2, multiplier: 1.05 },
    threePlus: { maxStories: null, multiplier: 1.10 },
  },
  urgencyMultipliers: {
    standard: 1.00,
    soon: 1.25,
    soonAfterHours: 1.50,
    emergency: 1.50,
    emergencyAfterHours: 2.00,
  },
  chemical: {
    label: 'Bed Bug Chemical/IPM Program',
    includedVisits: 2,
    followUpDays: 14,
    materialPerRoomVisit1: 50.42,
    materialPerRoomVisit2Factor: 0.50,
    extraFollowUpMaterialFactor: 0.25,
    pricingModel: 'costRatio',
    targetCostRatio: 0.35,
    minimumBase: 400,
    minimumAdditionalRoom: 250,
    visitMinutes: {
      visit1: { setupBase: 45, applicationBase: 30, perExtraRoom: 30, drive: 20 },
      visit2: { followUpBase: 25, perExtraRoom: 20, drive: 20 },
      extraFollowUp: { followUpBase: 25, perExtraRoom: 20, drive: 20 },
    },
    sizeModifiers: [
      { minFootprintExclusive: 2500, multiplier: 1.10 },
      { minFootprintExclusive: 1800, multiplier: 1.05 },
    ],
    additionalFollowUpPrice: { base: 175, perRoom: 75 },
    productBasis: {
      residual: {
        product: 'PT Alpine WSG',
        internalCost: { containerPrice: 220.53, containerGrams: 500 },
        labelVerificationRequired: true,
      },
      igr: {
        product: 'TBD',
        disabledUntilLabelVerified: true,
        notes: [
          'Do not assume Distance IGR is valid for indoor bed bug use unless internal label verification confirms it.',
        ],
      },
      roomMaterialAllowance: 50.42,
    },
    protocol: {
      programType: 'IPM',
      residualApplication: true,
      requiresPrepChecklist: true,
      requiresFollowUpMonitoring: true,
      requiresCustomerAcknowledgement: true,
      productLabelVerificationRequired: true,
    },
    warnings: [
      'Chemical treatment should be sold as an IPM program, not spray-only.',
      'Customer prep and follow-up monitoring are required.',
      'Additional follow-up may be needed if activity persists.',
    ],
  },
  heat: {
    label: 'Bed Bug Heat Treatment',
    includedTreatmentEvents: 1,
    includePostInspection: true,
    postInspectionDays: 14,
    allowedEquipment: ['INHOUSE', 'SUBCONTRACT'],
    roomRates: { oneRoom: 1000, twoRooms: 850, threePlusRooms: 750 },
    inHouseEquipmentFee: { base: 150, perExtraRoom: 75 },
    subcontractMarkup: 1.25,
    minimums: { inHouse: 1150, subcontract: 1000 },
    heatScope: { allowed: ['ROOMS_ONLY', 'WHOLE_HOME'] },
    sqftRates: { inHouse: 2.00, subcontract: 2.00 },
    sizeModifiers: [
      { minFootprintExclusive: 2500, multiplier: 1.10 },
      { maxFootprintExclusive: 1200, multiplier: 0.95 },
    ],
    protocol: {
      targetAmbientTempF: 135,
      requiredMinimumTempF: 120,
      minimumHoldTimeMinutes: 90,
      activeMonitoringRequired: true,
      minSensors: 5,
      requiresPrepChecklist: true,
      requiresHeatSensitiveItemPlan: true,
    },
    warnings: [
      'Heat treatment has no residual effect.',
      'Customer must complete prep checklist and heat-sensitive item plan.',
      'Post-treatment monitoring/inspection is required.',
    ],
  },
  hybrid: {
    label: 'Bed Bug Hybrid Heat + Residual Program',
    heatEvent: true,
    residualApplication: true,
    includePostInspection: true,
    postInspectionDays: 14,
    residualAddOn: { base: 175, perRoom: 75 },
    protocol: {
      heatEvent: true,
      residualApplication: true,
      residualApplicationType: 'targeted',
      requiresPrepChecklist: true,
      requiresFollowUpMonitoring: true,
      requiresCustomerAcknowledgement: true,
    },
    warnings: [
      'Hybrid must be explicitly selected.',
      'Do not trigger hybrid from invalid method input.',
      'Hybrid is heat plus targeted residual protection, not a duplicate full chemical program.',
    ],
  },
};

const LEGACY_BED_BUG_PRICING_CONFIG = {
  chemical: {
    material_per_room: 50.42,
    floor_base: 400,
    floor_per_extra_room: 250,
  },
  heat: {
    per_room_1: 1000,
    per_room_2: 850,
    per_room_3: 750,
  },
};

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  const row = {
    config_key: 'onetime_bed_bug',
    name: 'Bed Bug Specialty Pricing',
    category: 'one_time',
    sort_order: 11,
    data: JSON.stringify(COMPLETE_BED_BUG_PRICING_CONFIG),
    description: 'Complete bed bug specialty pricing protocol: chemical/IPM, heat, hybrid, risk modifiers, and heat protocol fields.',
    updated_at: knex.fn.now(),
  };

  const existing = await knex('pricing_config').where({ config_key: row.config_key }).first();
  if (existing) {
    await knex('pricing_config')
      .where({ config_key: row.config_key })
      .update(row);
    return;
  }

  await knex('pricing_config').insert({
    ...row,
    created_at: knex.fn.now(),
  });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  await knex('pricing_config')
    .where({ config_key: 'onetime_bed_bug' })
    .update({
      name: 'Bed Bug Treatment',
      category: 'one_time',
      sort_order: 11,
      data: JSON.stringify(LEGACY_BED_BUG_PRICING_CONFIG),
      description: null,
      updated_at: knex.fn.now(),
    });
};
