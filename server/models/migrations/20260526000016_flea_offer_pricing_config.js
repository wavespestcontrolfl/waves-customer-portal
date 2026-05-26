function parseData(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return {};
  }
}

function nextFleaConfig(data = {}) {
  return {
    ...data,
    pricingConfigKey: 'flea_2026_v1',
    offers: [
      {
        offerKey: 'flea_knockdown_single',
        displayName: 'Flea Knockdown Visit',
        billingCadence: 'one_time',
        visitCount: 1,
        warrantyType: 'none',
        baseInitial: 225,
        floorInitial: 185,
        packageFloor: 185,
        exteriorAddOnMode: 'initial_only',
      },
      {
        offerKey: 'flea_elimination_two_visit',
        displayName: 'Flea Elimination Package',
        billingCadence: 'one_time',
        visitCount: 2,
        warrantyType: 'conditional_retreat',
        baseInitial: 225,
        baseFollowUp: 125,
        floorInitial: 185,
        floorFollowUp: 95,
        packageFloor: 280,
        guaranteeWindowDaysAfterFollowUp: 30,
        maxIncludedRetreats: 1,
        exteriorAddOnMode: 'two_visit',
      },
    ],
    guarantee: {
      followUpWindowDays: { min: 10, max: 21, default: 14 },
      retreatWindowDaysAfterFollowUp: 30,
      maxIncludedRetreats: 1,
      requiresPrepChecklist: true,
      requiresPetSourceAttestation: true,
      exclusions: [
        'untreated_pets',
        'untreated_exterior_sources',
        'wildlife_or_stray_animal_activity',
        'neighboring_units',
        'missed_follow_up',
        'inaccessible_areas',
        'reintroduction_after_service',
      ],
    },
    complexityAdjustments: {
      light: { initial: 0, followUp: 0 },
      moderate: { initial: 35, followUp: 15 },
      heavy: { initial: 75, followUp: 35 },
    },
  };
}

exports.up = async function up(db) {
  const row = await db('pricing_config')
    .where({ config_key: 'onetime_flea' })
    .first();
  const data = nextFleaConfig(parseData(row?.data));
  if (row) {
    await db('pricing_config')
      .where({ config_key: 'onetime_flea' })
      .update({
        name: 'Flea Treatment Options',
        data: JSON.stringify(data),
        updated_at: db.fn.now(),
      });
    return;
  }
  await db('pricing_config').insert({
    config_key: 'onetime_flea',
    name: 'Flea Treatment Options',
    category: 'one_time',
    sort_order: 12,
    data: JSON.stringify(nextFleaConfig({
      initial: { base: 225, floor: 185 },
      followUp: { base: 125, floor: 95 },
      exterior: {
        enabled: true,
        maxSqFt: 20000,
        tiers: [
          { min: 1, max: 2500, initial: 75, followUp: 50 },
          { min: 2501, max: 5000, initial: 95, followUp: 60 },
          { min: 5001, max: 7500, initial: 120, followUp: 75 },
          { min: 7501, max: 10000, initial: 145, followUp: 95 },
          { min: 10001, max: 15000, initial: 195, followUp: 130 },
          { min: 15001, max: 20000, initial: 240, followUp: 155 },
        ],
      },
    })),
  });
};

exports.down = async function down(db) {
  const row = await db('pricing_config')
    .where({ config_key: 'onetime_flea' })
    .first();
  if (!row) return;
  const data = parseData(row.data);
  delete data.pricingConfigKey;
  delete data.offers;
  delete data.guarantee;
  delete data.complexityAdjustments;
  await db('pricing_config')
    .where({ config_key: 'onetime_flea' })
    .update({
      name: 'Flea Treatment',
      data: JSON.stringify(data),
      updated_at: db.fn.now(),
    });
};
