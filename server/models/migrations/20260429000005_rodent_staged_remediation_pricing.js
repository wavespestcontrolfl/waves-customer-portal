/**
 * Rodent staged-remediation pricing — April 2026 v2
 *
 * Builds on the prior realignment (PR #431) by restructuring trapping,
 * exclusion, sanitation, bundles, and guarantee into a proper staged-
 * remediation model. Bait stations (recurring) are unchanged from the
 * prior PR — they stay at $49/$59/$69 monthly with quarterly cadence.
 *
 * Major changes:
 *   - Trapping: $295 → $395 base, $350 floor, includes 2 follow-ups (was 1).
 *     New home/lot/pressure adjustments and emergency surcharge.
 *   - Trap follow-up rate stays $95/visit; 3-pack SKU retired.
 *   - Inspection: standalone SKU at $125, creditable, waivable above $995.
 *   - Exclusion: simple $50, moderate $95, advanced $195, specialty $275+.
 *     Home-size minimums ($395/$595/$895/$1,295) replace flat $195 floor.
 *     Adds story/roof/construction multipliers.
 *   - Sanitation: light $395 / standard $695 / heavy $995 (renamed from
 *     'medium' → 'standard'). Per-sqft + debris cu-ft scaling. Heavy
 *     adds crawlspace/tight-access multipliers.
 *   - Bundles: 7% trap+exclusion / 5% trap+sanitation / 10% full
 *     (with $895 / $1,195 / $1,495 / $1,995 floors).
 *   - Guarantee: tiered $199 / $249 / $299 by home complexity; eligibility
 *     gated on completed remediation (no more auto-fire on trap+excl).
 *
 * Affects:
 *   - `services` table — base/range/duration/description for rodent rows
 *   - Inserts new SKUs: rodent_inspection, rodent_trapping_exclusion,
 *     rodent_sanitation_standard (renamed from medium)
 *   - Renames rodent_trapping_followup_3pack data is removed (SKU dropped)
 *   - `pricing_config` rows — restructured rodent_trapping, rodent_sanitation,
 *     onetime_exclusion. Inserts rodent_inspection, rodent_bundles,
 *     rodent_guarantee.
 */

exports.up = async function (knex) {
  // ============================================================
  // 1. UPDATE existing service catalog rows
  // ============================================================
  await knex('services')
    .where('service_key', 'rodent_trapping')
    .update({
      base_price: 395.00,
      price_range_min: 350.00,
      price_range_max: 795.00,
      default_duration_minutes: 60,
      description: 'Interior snap trap and glue board placement for active rodent activity. Includes initial setup and 2 follow-up trap checks. Additional follow-ups billed separately.',
      updated_at: knex.fn.now(),
    });

  await knex('services')
    .where('service_key', 'rodent_exclusion_only')
    .update({
      base_price: 595.00,
      price_range_min: 395.00,
      price_range_max: 2500.00,
      description: 'Sealing of all identified rodent entry points. Per-point: simple $50 / moderate $95 / advanced $195 / specialty $275+. Home-size minimum applies. Inspection fee waived when bundled with any other rodent service.',
      updated_at: knex.fn.now(),
    });

  await knex('services')
    .where('service_key', 'rodent_trapping_sanitation')
    .update({
      base_price: 995.00,
      price_range_min: 895.00,
      price_range_max: 2250.00,
      description: 'Trapping program plus standard-tier sanitation (bleach + wipe-down). 5% bundle discount vs. components separately. Note: exclusion still recommended for re-entry warranty.',
      updated_at: knex.fn.now(),
    });

  await knex('services')
    .where('service_key', 'rodent_trapping_exclusion_sanitation')
    .update({
      base_price: 1495.00,
      price_range_min: 1195.00,
      price_range_max: 3995.00,
      description: 'Complete rodent remediation: trapping (setup + 2 follow-ups), full exclusion sealing (per-point), and sanitation. 10% bundle discount. Eligible for $199–$299/yr guarantee renewal.',
      updated_at: knex.fn.now(),
    });

  // Drop deprecated 3-pack follow-up SKU (logic dropped from engine)
  const followupPackId = await knex('services')
    .where('service_key', 'rodent_trapping_followup_3pack')
    .first('id');
  if (followupPackId) {
    if (await knex.schema.hasColumn('service_records', 'service_id')) {
      await knex('service_records').where({ service_id: followupPackId.id }).update({ service_id: null });
    }
    if (await knex.schema.hasColumn('scheduled_services', 'service_id')) {
      await knex('scheduled_services').where({ service_id: followupPackId.id }).update({ service_id: null });
    }
    await knex('services').where('service_key', 'rodent_trapping_followup_3pack').del();
  }

  // Rename medium → standard sanitation tier
  // (Service-key change is migration-safe because we don't constrain on the legacy key.)
  const mediumSanRow = await knex('services').where('service_key', 'rodent_sanitation_medium').first();
  if (mediumSanRow) {
    const standardExists = await knex('services').where('service_key', 'rodent_sanitation_standard').first();
    if (!standardExists) {
      await knex('services')
        .where('service_key', 'rodent_sanitation_medium')
        .update({
          service_key: 'rodent_sanitation_standard',
          name: 'Rodent Sanitation — Standard',
          short_name: 'Sanitize Std',
          description: 'Standard-tier dropping cleanup with bleach and manual wipe-down. Multiple rooms or full attic perimeter. Includes 750 sf affected area + 10 cu ft debris removal; additional charged at $0.30/sf and $12/cu ft. ~240 minutes on-site.',
          base_price: 695.00,
          price_range_min: 695.00,
          price_range_max: 1495.00,
          default_duration_minutes: 240,
          updated_at: knex.fn.now(),
        });
    }
  }

  // Update light + heavy sanitation rows in place
  await knex('services')
    .where('service_key', 'rodent_sanitation_light')
    .update({
      base_price: 395.00,
      price_range_min: 395.00,
      price_range_max: 695.00,
      default_duration_minutes: 120,
      description: 'Light dropping cleanup with bleach and manual wipe-down. Single room or small accessible zone. Includes 300 sf; additional charged at $0.20/sf. ~120 minutes on-site.',
      updated_at: knex.fn.now(),
    });

  await knex('services')
    .where('service_key', 'rodent_sanitation_heavy')
    .update({
      base_price: 995.00,
      price_range_min: 995.00,
      price_range_max: 2500.00,
      default_duration_minutes: 420,
      description: 'Heavy dropping cleanup. Full attic, multi-zone activity, or significant nesting/odor. Includes 750 sf affected area + 25 cu ft debris removal. Crawlspace 1.15× / tight access 1.25×. Additional debris $12/cu ft.',
      updated_at: knex.fn.now(),
    });

  // ============================================================
  // 2. INSERT new services
  // ============================================================
  const newServices = [
    {
      service_key: 'rodent_inspection',
      name: 'Rodent Inspection',
      short_name: 'Rodent Insp',
      description: 'Paid diagnostic visit. Identifies entry points, activity zones, and remediation scope. $125 fee creditable toward exclusion or full remediation if approved within 14 days.',
      category: 'rodent',
      billing_type: 'one_time',
      default_duration_minutes: 60,
      min_duration_minutes: 45,
      max_duration_minutes: 90,
      pricing_type: 'fixed',
      base_price: 125.00,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      icon: '🔍',
      color: '#78716c',
      sort_order: 40,
      internal_notes: 'Creditable for 14 days. Auto-waived when approved remediation total exceeds $995.',
    },
    {
      service_key: 'rodent_trapping_exclusion',
      name: 'Rodent Trapping + Exclusion',
      short_name: 'Trap + Excl',
      description: 'Trapping program plus full exclusion sealing of identified entry points. 7% bundle discount vs. components separately. Note: sanitation recommended; required for full re-entry warranty.',
      category: 'rodent',
      billing_type: 'one_time',
      default_duration_minutes: 240,
      min_duration_minutes: 180,
      max_duration_minutes: 360,
      pricing_type: 'variable',
      base_price: 995.00,
      price_range_min: 895.00,
      price_range_max: 2500.00,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      min_tech_skill_level: 2,
      icon: '🛡️',
      color: '#78716c',
      sort_order: 44,
    },
  ];

  for (const svc of newServices) {
    const exists = await knex('services').where('service_key', svc.service_key).first();
    if (!exists) {
      await knex('services').insert(svc);
    }
  }

  // Ensure standard sanitation row exists if there was no legacy medium row to rename
  const standardSanExists = await knex('services').where('service_key', 'rodent_sanitation_standard').first();
  if (!standardSanExists) {
    await knex('services').insert({
      service_key: 'rodent_sanitation_standard',
      name: 'Rodent Sanitation — Standard',
      short_name: 'Sanitize Std',
      description: 'Standard-tier dropping cleanup with bleach and manual wipe-down. Multiple rooms or full attic perimeter. Includes 750 sf affected area + 10 cu ft debris removal; additional charged at $0.30/sf and $12/cu ft. ~240 minutes on-site.',
      category: 'rodent',
      billing_type: 'one_time',
      default_duration_minutes: 240,
      min_duration_minutes: 180,
      max_duration_minutes: 360,
      pricing_type: 'variable',
      base_price: 695.00,
      price_range_min: 695.00,
      price_range_max: 1495.00,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      min_tech_skill_level: 2,
      icon: '🧽',
      color: '#78716c',
      sort_order: 50,
      typical_materials_cost: 30.00,
    });
  }

  // ============================================================
  // 3. UPDATE pricing_config rows
  // ============================================================
  if (await knex.schema.hasTable('pricing_config')) {
    const updates = [
      ['rodent_trapping', {
        base: 395,
        floor: 350,
        ceiling_before_custom: 795,
        included_followups: 2,
        additional_followup_rate: 95,
        emergency_multiplier: 1.20,
        emergency_minimum_surcharge: 75,
        home_size_adjustments: [
          { max_sqft: 1200, adjustment: -25 },
          { max_sqft: 2500, adjustment: 0 },
          { max_sqft: 4000, adjustment: 50 },
          { max_sqft: 6000, adjustment: 95 },
          { max_sqft: 'Infinity', adjustment: 150, custom_recommended: true },
        ],
        lot_adjustments: [
          { max_lot_sqft: 10000, adjustment: 0 },
          { max_lot_sqft: 20000, adjustment: 35 },
          { max_lot_sqft: 43560, adjustment: 75 },
          { max_lot_sqft: 'Infinity', adjustment: 125, custom_recommended: true },
        ],
        pressure_adjustments: { light: -25, normal: 0, moderate: 35, heavy: 75, severe: 150 },
      }],
      ['rodent_sanitation', {
        light:    { base: 395, floor: 395, included_sqft: 300, additional_per_sqft: 0.20, included_debris_cuft: 0,  additional_debris_per_cuft: 12 },
        standard: { base: 695, floor: 695, included_sqft: 750, additional_per_sqft: 0.30, included_debris_cuft: 10, additional_debris_per_cuft: 12 },
        heavy:    { base: 995, floor: 995, included_sqft: 750, additional_per_sqft: 0.55, included_debris_cuft: 25, additional_debris_per_cuft: 12, crawlspace_multiplier: 1.15, tight_access_multiplier: 1.25 },
      }],
      ['onetime_exclusion', {
        simple: 50,
        moderate: 95,
        advanced: 195,
        specialty_minimum: 275,
        inspection: 125,
        inspection_waived_with_service_optin: true,
        minimums_by_home_sqft: [
          { max_sqft: 1500, minimum: 395 },
          { max_sqft: 2500, minimum: 595 },
          { max_sqft: 4000, minimum: 895 },
          { max_sqft: 'Infinity', minimum: 1295, custom_recommended: true },
        ],
        story_multipliers:        { one: 1.00, two: 1.15, three: 1.30 },
        roof_multipliers:         { shingle: 1.00, flat: 1.00, metal: 1.15, tile: 1.25, steep_or_fragile: 1.35 },
        construction_multipliers: { block: 1.00, stucco: 1.05, frame: 1.10, mixed: 1.10 },
      }],
    ];

    for (const [key, data] of updates) {
      const existing = await knex('pricing_config').where({ config_key: key }).first();
      if (existing) {
        await knex('pricing_config')
          .where({ config_key: key })
          .update({ data: JSON.stringify(data), updated_at: knex.fn.now() });
      }
    }

    const newConfigs = [
      {
        config_key: 'rodent_inspection',
        name: 'Rodent Inspection Fee',
        category: 'rodent',
        sort_order: 5,
        data: JSON.stringify({ fee: 125, creditable_within_days: 14, waive_if_approved_total_over: 995 }),
      },
      {
        config_key: 'rodent_bundles',
        name: 'Rodent Bundle Discounts',
        category: 'rodent',
        sort_order: 8,
        data: JSON.stringify({
          trap_exclusion:   { discount: 0.07, floor: 895 },
          trap_sanitation:  { discount: 0.05, floor: 895 },
          full_remediation: { discount: 0.10, floors: { light: 1195, standard: 1495, heavy: 1995 } },
        }),
      },
      {
        config_key: 'rodent_guarantee',
        name: 'Rodent Annual Guarantee Tiers',
        category: 'rodent',
        sort_order: 9,
        data: JSON.stringify({
          standard: 199,
          complex: 249,
          estate: 299,
          eligibility_requires: [
            'trappingCompleted',
            'exclusionCompleted',
            'sanitationCompletedOrPhotoBaseline',
            'noActivityAfterFinalTrapCheck',
          ],
        }),
      },
    ];

    for (const cfg of newConfigs) {
      const exists = await knex('pricing_config').where({ config_key: cfg.config_key }).first();
      if (!exists) {
        await knex('pricing_config').insert(cfg);
      }
    }
  }
};

exports.down = async function (knex) {
  // Restore prior service catalog values (from PR #431 state)
  await knex('services')
    .where('service_key', 'rodent_trapping')
    .update({ base_price: 295.00, price_range_min: 295.00, price_range_max: 495.00, updated_at: knex.fn.now() });

  await knex('services')
    .where('service_key', 'rodent_exclusion_only')
    .update({ base_price: 300.00, price_range_min: 195.00, price_range_max: 1500.00, updated_at: knex.fn.now() });

  await knex('services')
    .where('service_key', 'rodent_trapping_sanitation')
    .update({ base_price: 530.00, price_range_min: 395.00, price_range_max: 795.00, updated_at: knex.fn.now() });

  await knex('services')
    .where('service_key', 'rodent_trapping_exclusion_sanitation')
    .update({ base_price: 1565.00, price_range_min: 895.00, price_range_max: 2825.00, updated_at: knex.fn.now() });

  await knex('services')
    .where('service_key', 'rodent_sanitation_light')
    .update({ base_price: 195.00, price_range_min: 145.00, price_range_max: 285.00, default_duration_minutes: 30, updated_at: knex.fn.now() });

  await knex('services')
    .where('service_key', 'rodent_sanitation_heavy')
    .update({ base_price: 395.00, price_range_min: 345.00, price_range_max: 595.00, default_duration_minutes: 150, updated_at: knex.fn.now() });

  // Restore standard → medium rename
  const standardRow = await knex('services').where('service_key', 'rodent_sanitation_standard').first();
  if (standardRow) {
    await knex('services')
      .where('service_key', 'rodent_sanitation_standard')
      .update({
        service_key: 'rodent_sanitation_medium',
        name: 'Rodent Sanitation — Medium',
        short_name: 'Sanitize Medium',
        description: 'Multi-zone dropping cleanup with bleach and manual wipe-down. Multiple rooms or attic perimeter. ~75 minutes on-site.',
        base_price: 295.00,
        price_range_min: 245.00,
        price_range_max: 445.00,
        default_duration_minutes: 75,
        updated_at: knex.fn.now(),
      });
  }

  // Drop new services
  const newKeys = ['rodent_inspection', 'rodent_trapping_exclusion'];
  const ids = await knex('services').whereIn('service_key', newKeys).pluck('id');
  if (ids.length > 0) {
    if (await knex.schema.hasColumn('service_records', 'service_id')) {
      await knex('service_records').whereIn('service_id', ids).update({ service_id: null });
    }
    if (await knex.schema.hasColumn('scheduled_services', 'service_id')) {
      await knex('scheduled_services').whereIn('service_id', ids).update({ service_id: null });
    }
  }
  await knex('services').whereIn('service_key', newKeys).del();

  // Re-insert dropped 3-pack SKU
  const followupPackExists = await knex('services').where('service_key', 'rodent_trapping_followup_3pack').first();
  if (!followupPackExists) {
    await knex('services').insert({
      service_key: 'rodent_trapping_followup_3pack',
      name: 'Rodent Trapping Follow-Up 3-Pack',
      short_name: 'Trap 3-Pack',
      description: 'Pre-paid bundle of 3 trap follow-up visits. Saves $40 vs. individual follow-ups.',
      category: 'rodent',
      billing_type: 'one_time',
      default_duration_minutes: 90,
      pricing_type: 'fixed',
      base_price: 245.00,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      icon: '🪤',
      color: '#78716c',
      sort_order: 48,
    });
  }

  // Restore pricing_config rows to PR #431 shape
  if (await knex.schema.hasTable('pricing_config')) {
    const restorations = [
      ['rodent_trapping', { base: 295, floor: 295, followup_rate: 95, followup_3pack_rate: 245, includes: 'setup + 1 follow-up' }],
      ['rodent_sanitation', {
        light:  { base: 195, floor: 145, duration_min: 30 },
        medium: { base: 295, floor: 245, duration_min: 75 },
        heavy:  { base: 395, floor: 345, duration_min: 150 },
      }],
      ['onetime_exclusion', { simple: 75, moderate: 125, advanced: 175, floor: 195, inspection: 125, inspection_waived_with_service_optin: true }],
    ];
    for (const [key, data] of restorations) {
      await knex('pricing_config')
        .where({ config_key: key })
        .update({ data: JSON.stringify(data), updated_at: knex.fn.now() });
    }
    await knex('pricing_config')
      .whereIn('config_key', ['rodent_inspection', 'rodent_bundles', 'rodent_guarantee'])
      .del();
  }
};
