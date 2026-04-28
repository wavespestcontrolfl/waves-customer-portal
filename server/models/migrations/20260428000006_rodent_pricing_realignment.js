/**
 * Rodent pricing realignment — April 2026
 *
 * Updates the rodent service stack to match Waves' actual operating model:
 *   - Bait stations: quarterly visits (4/yr), billed monthly. Prices drop
 *     from $75/$89/$109 to $49/$59/$69 monthly.
 *   - Trapping: setup + 1 follow-up included (was 2). Drops from $350 → $295.
 *     Adds per-visit follow-up rate ($95) and 3-pack ($245).
 *   - Sanitation: three new tiers — Light $195 / Medium $295 / Heavy $395.
 *     Bleach + manual wipe scope (no enzyme/fogger).
 *   - Exclusion per-point: simple $37.50→$75, moderate $75→$125, advanced
 *     $150→$175. Floor raised $150→$195. Inspection $85→$125 and now
 *     auto-waived when any rodent service is opted in.
 *   - Bait setup fee $199 added explicitly; waived in standard recurring
 *     sign-up (so it only fires for non-recurring edge cases).
 *
 * Affects:
 *   - `services` table — base_price / range / duration / description
 *   - `pricing_config` table — rodent_*, onetime_exclusion JSONB
 *   - Inserts new sanitation + follow-up service catalog rows
 */
exports.up = async function (knex) {
  // ============================================================
  // 1. UPDATE existing services catalog rows
  // ============================================================
  await knex('services')
    .where('service_key', 'rodent_trapping')
    .update({
      base_price: 295.00,
      price_range_min: 295.00,
      price_range_max: 495.00,
      description: 'Interior snap trap and glue board placement for active rodent activity. Includes initial setup and 1 follow-up trap check. Additional follow-ups billed separately.',
      updated_at: knex.fn.now(),
    });

  await knex('services')
    .where('service_key', 'rodent_exclusion_only')
    .update({
      price_range_min: 195.00,
      price_range_max: 1500.00,
      description: 'Sealing of all identified rodent entry points — roof line, A/C chases, plumbing penetrations, gable vents. Per-point pricing: simple $75 / moderate $125 / advanced $175. Inspection fee waived with any rodent service opt-in.',
      updated_at: knex.fn.now(),
    });

  await knex('services')
    .where('service_key', 'rodent_trapping_sanitation')
    .update({
      base_price: 530.00,
      price_range_min: 395.00,
      price_range_max: 795.00,
      description: 'Trapping program plus medium-tier sanitation (bleach + wipe-down of droppings). 10% bundle discount vs. components purchased separately.',
      updated_at: knex.fn.now(),
    });

  await knex('services')
    .where('service_key', 'rodent_trapping_exclusion_sanitation')
    .update({
      base_price: 1565.00,
      price_range_min: 895.00,
      price_range_max: 2825.00,
      description: 'Complete rodent remediation: trapping, full-home exclusion sealing (per-point), and medium-tier sanitation. 10% bundle discount vs. components separately. Qualifies for $199/yr guarantee renewal.',
      updated_at: knex.fn.now(),
    });

  // ============================================================
  // 2. INSERT new services
  // ============================================================
  const newServices = [
    {
      service_key: 'rodent_trapping_followup',
      name: 'Rodent Trapping Follow-Up Visit',
      short_name: 'Trap Follow-Up',
      description: 'Additional follow-up trap check beyond the 1 included in base trapping service. Use for active infestations requiring extended monitoring.',
      category: 'rodent',
      billing_type: 'one_time',
      default_duration_minutes: 30,
      min_duration_minutes: 20,
      max_duration_minutes: 45,
      pricing_type: 'fixed',
      base_price: 95.00,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      icon: '🪤',
      color: '#78716c',
      sort_order: 47,
      internal_notes: 'Per-visit rate. 3-pack available at $245 (saves $40).',
    },
    {
      service_key: 'rodent_trapping_followup_3pack',
      name: 'Rodent Trapping Follow-Up 3-Pack',
      short_name: 'Trap 3-Pack',
      description: 'Pre-paid bundle of 3 trap follow-up visits. Saves $40 vs. individual follow-ups. Recommended for active infestations.',
      category: 'rodent',
      billing_type: 'one_time',
      default_duration_minutes: 90,
      min_duration_minutes: 60,
      max_duration_minutes: 135,
      pricing_type: 'fixed',
      base_price: 245.00,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      icon: '🪤',
      color: '#78716c',
      sort_order: 48,
    },
    {
      service_key: 'rodent_sanitation_light',
      name: 'Rodent Sanitation — Light',
      short_name: 'Sanitize Light',
      description: 'Spot dropping cleanup with bleach and manual wipe-down. Single room or small zone. ~30 minutes on-site.',
      category: 'rodent',
      billing_type: 'one_time',
      default_duration_minutes: 30,
      min_duration_minutes: 20,
      max_duration_minutes: 45,
      pricing_type: 'variable',
      base_price: 195.00,
      price_range_min: 145.00,
      price_range_max: 285.00,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      icon: '🧽',
      color: '#78716c',
      sort_order: 49,
      typical_materials_cost: 30.00,
    },
    {
      service_key: 'rodent_sanitation_medium',
      name: 'Rodent Sanitation — Medium',
      short_name: 'Sanitize Medium',
      description: 'Multi-zone dropping cleanup with bleach and manual wipe-down. Multiple rooms or attic perimeter. ~75 minutes on-site.',
      category: 'rodent',
      billing_type: 'one_time',
      default_duration_minutes: 75,
      min_duration_minutes: 60,
      max_duration_minutes: 120,
      pricing_type: 'variable',
      base_price: 295.00,
      price_range_min: 245.00,
      price_range_max: 445.00,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      icon: '🧽',
      color: '#78716c',
      sort_order: 50,
      typical_materials_cost: 30.00,
    },
    {
      service_key: 'rodent_sanitation_heavy',
      name: 'Rodent Sanitation — Heavy',
      short_name: 'Sanitize Heavy',
      description: 'Whole-attic or multi-zone dropping cleanup with bleach and manual wipe-down. Heavy infestation cleanup. ~150 minutes on-site.',
      category: 'rodent',
      billing_type: 'one_time',
      default_duration_minutes: 150,
      min_duration_minutes: 120,
      max_duration_minutes: 240,
      pricing_type: 'variable',
      base_price: 395.00,
      price_range_min: 345.00,
      price_range_max: 595.00,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      min_tech_skill_level: 2,
      icon: '🧽',
      color: '#78716c',
      sort_order: 51,
      typical_materials_cost: 35.00,
    },
    {
      service_key: 'rodent_bait_setup',
      name: 'Rodent Bait Station Setup Fee',
      short_name: 'Bait Setup',
      description: 'One-time inspection, station hardware, placement, and mapping. Waived in standard recurring sign-up flow.',
      category: 'rodent',
      billing_type: 'one_time',
      default_duration_minutes: 60,
      min_duration_minutes: 45,
      max_duration_minutes: 90,
      pricing_type: 'fixed',
      base_price: 199.00,
      is_taxable: true,
      tax_service_key: 'pest_control',
      requires_license: true,
      license_category: 'GHP',
      icon: '🎯',
      color: '#78716c',
      sort_order: 41,
      internal_notes: 'Waived when bait service is added alongside any recurring plan. Only invoices for the rare non-recurring case.',
    },
  ];

  for (const svc of newServices) {
    const exists = await knex('services').where('service_key', svc.service_key).first();
    if (!exists) {
      await knex('services').insert(svc);
    }
  }

  // ============================================================
  // 3. UPDATE pricing_config rows (engine constants editable via admin UI)
  // ============================================================
  if (await knex.schema.hasTable('pricing_config')) {
    const updates = [
      ['rodent_monthly', { small: 49, medium: 59, large: 69, visits_per_year: 4 }],
      ['rodent_trapping', {
        base: 295,
        floor: 295,
        followup_rate: 95,
        followup_3pack_rate: 245,
        includes: 'setup + 1 follow-up',
      }],
      ['onetime_exclusion', {
        simple: 75,
        moderate: 125,
        advanced: 175,
        floor: 195,
        inspection: 125,
        inspection_waived_with_service_optin: true,
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

    // Insert new pricing_config rows if not present
    const newConfigs = [
      {
        config_key: 'rodent_setup_fee',
        name: 'Rodent Bait Setup Fee',
        category: 'rodent',
        sort_order: 3,
        data: JSON.stringify({ value: 199, waived_with_recurring: true, note: 'Waived in standard recurring sign-up flow' }),
      },
      {
        config_key: 'rodent_post_exclusion',
        name: 'Rodent Bait Post-Exclusion Modifier',
        category: 'rodent',
        sort_order: 4,
        data: JSON.stringify({ multiplier: 0.72, floor_monthly: 39, note: 'Sealed structure = lighter scope' }),
      },
      {
        config_key: 'rodent_sanitation',
        name: 'Rodent Sanitation Tiers (bleach + wipe)',
        category: 'rodent',
        sort_order: 5,
        data: JSON.stringify({
          light:  { base: 195, floor: 145, duration_min: 30 },
          medium: { base: 295, floor: 245, duration_min: 75 },
          heavy:  { base: 395, floor: 345, duration_min: 150 },
        }),
      },
      {
        config_key: 'rodent_per_station_overage',
        name: 'Rodent Per-Station Overage',
        category: 'rodent',
        sort_order: 6,
        data: JSON.stringify({ value: 8, unit: '$/mo per extra station beyond tier default' }),
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
  // Restore previous prices on existing services
  await knex('services')
    .where('service_key', 'rodent_trapping')
    .update({ base_price: 175.00, price_range_min: 125.00, price_range_max: 350.00, updated_at: knex.fn.now() });

  await knex('services')
    .where('service_key', 'rodent_exclusion_only')
    .update({ price_range_min: 200.00, price_range_max: 1000.00, updated_at: knex.fn.now() });

  await knex('services')
    .where('service_key', 'rodent_trapping_sanitation')
    .update({ base_price: 450.00, price_range_min: 300.00, price_range_max: 1500.00, updated_at: knex.fn.now() });

  await knex('services')
    .where('service_key', 'rodent_trapping_exclusion_sanitation')
    .update({ base_price: 750.00, price_range_min: 500.00, price_range_max: 2500.00, updated_at: knex.fn.now() });

  // Remove new service rows
  const newKeys = [
    'rodent_trapping_followup',
    'rodent_trapping_followup_3pack',
    'rodent_sanitation_light',
    'rodent_sanitation_medium',
    'rodent_sanitation_heavy',
    'rodent_bait_setup',
  ];
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

  // Restore pricing_config
  if (await knex.schema.hasTable('pricing_config')) {
    const restorations = [
      ['rodent_monthly', { small: 75, medium: 89, large: 109 }],
      ['rodent_trapping', { base: 350, floor: 350 }],
      ['onetime_exclusion', { simple: 37.5, moderate: 75, advanced: 150, floor: 150, inspection: 85 }],
    ];
    for (const [key, data] of restorations) {
      await knex('pricing_config')
        .where({ config_key: key })
        .update({ data: JSON.stringify(data), updated_at: knex.fn.now() });
    }
    await knex('pricing_config')
      .whereIn('config_key', ['rodent_setup_fee', 'rodent_post_exclusion', 'rodent_sanitation', 'rodent_per_station_overage'])
      .del();
  }
};
