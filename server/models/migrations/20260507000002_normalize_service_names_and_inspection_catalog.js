/**
 * Normalize service catalog naming + flesh out the Inspection / Mosquito /
 * Pest categories ahead of the Service Library UI redesign landing.
 *
 * Concerns combined here:
 *   1. Strip trailing "WaveGuard" from names — `is_waveguard` already drives
 *      a rendered pill, so the suffix in the name is redundant.
 *   2. Standardise: every service name ends with "Service" (parentheticals
 *      preserved at the end). Examples:
 *        "Tree & Shrub Care (Every 6 Weeks)" → "Tree & Shrub Care Service"
 *        "Mosquito Control (Monthly)" → "Mosquito Control Service (Monthly)"
 *        "Lawn Fertilization & Weed Control" → "Lawn Fertilization & Weed Control Service"
 *   3. Inspection category gains: Pest Inspection Service, Termite Inspection
 *      Service, Lawn Assessment Service (rename of Lawn Health Inspection),
 *      Rodent Inspection Service (move + rename from Rodent category if
 *      present). Tree & Shrub gains: Palm Injection Service. Mosquito gains:
 *      Seasonal Mosquito Control Service. Pest gains: Pest Control Re-Service.
 *   4. All active services normalize to default_duration_minutes = 60 and
 *      pricing_type = 'variable' / base_price = NULL (per Adam: every service
 *      in the catalog is variable; final pricing comes from estimates).
 *
 * `down` is intentionally a no-op — we don't carry the pre-rename names in
 * this file and reversing would risk overwriting newer edits made through
 * the Service Library UI.
 */
exports.up = async function (knex) {
  // ── 1) Strip trailing " WaveGuard" / "WaveGuard" suffix from names ────
  await knex.raw(`
    UPDATE services
    SET name = REGEXP_REPLACE(name, '\\s*WaveGuard\\s*$', '')
    WHERE name ~ 'WaveGuard\\s*$'
  `);

  // ── 2) Targeted renames (move Service before parenthetical, drop redundant qualifiers) ──
  const exactRenames = [
    ['General Pest Control (Quarterly)', 'Quarterly Pest Control Service'],
    ['General Pest Control (Monthly)', 'Monthly Pest Control Service'],
    ['Mosquito Control (Monthly)', 'Mosquito Control Service (Monthly)'],
    ['Rodent Monitoring (Monthly)', 'Rodent Monitoring Service (Monthly)'],
    ['Tree & Shrub Care (Every 6 Weeks)', 'Tree & Shrub Care Service'],
    ['Lawn Health Inspection', 'Lawn Assessment Service'],
    ['WDO Inspection (Termite Letter)', 'WDO Inspection Service'],
    // Termite Bond term: keep term as suffix but ensure "Service" precedes
    ['Termite Bond (1-Year Term)', 'Termite Bond Service (1-Year Term)'],
    ['Termite Bond (5-Year Term)', 'Termite Bond Service (5-Year Term)'],
    ['Termite Bond (10-Year Term)', 'Termite Bond Service (10-Year Term)'],
    // Rodent Sanitation tier: same shape
    ['Rodent Sanitation — Heavy', 'Rodent Sanitation Service — Heavy'],
    ['Rodent Sanitation — Light', 'Rodent Sanitation Service — Light'],
    ['Rodent Sanitation — Standard', 'Rodent Sanitation Service — Standard'],
  ];
  for (const [from, to] of exactRenames) {
    await knex('services').where('name', from).update({ name: to });
  }

  // Move existing Rodent Inspection (if it lives in the rodent category) to
  // the inspection category, and ensure its name carries the Service suffix.
  await knex('services')
    .where('name', 'Rodent Inspection')
    .update({ name: 'Rodent Inspection Service', category: 'inspection' });

  // ── 3) Generic " Service" suffix for any name that lacks it ───────────
  // Skip rows that already contain Service/Membership as a word — covers
  //   "... Service"            (ends with Service)
  //   "... Service (Quarterly)" (ends with parenthetical qualifier)
  //   "... Service — Heavy"     (ends with em-dash tier qualifier)
  //   "... Re-Service"          (\m boundary matches across hyphen)
  // Then for the remaining rows: insert " Service " BEFORE any trailing
  // parenthetical so the qualifier stays at the end; otherwise append.
  await knex.raw(`
    UPDATE services
    SET name = CASE
      WHEN name ~ '\\([^)]*\\)\\s*$'
        THEN REGEXP_REPLACE(name, '\\s*(\\([^)]*\\))\\s*$', ' Service \\1')
      ELSE name || ' Service'
    END
    WHERE name !~* '\\m(Service|Membership)\\M'
  `);

  // ── 4) Insert new services if they don't yet exist ────────────────────
  const newRows = [
    {
      service_key: 'pest_inspection', name: 'Pest Inspection Service',
      description: 'Walkthrough of interior + exterior to identify active pest pressure, conducive conditions, and recommended treatment plan.',
      category: 'inspection', billing_type: 'one_time',
      default_duration_minutes: 60, min_duration_minutes: 45, max_duration_minutes: 90,
      pricing_type: 'variable',
      is_taxable: false,
      requires_license: true, license_category: 'GHP',
      min_tech_skill_level: 1,
      icon: '🔍', color: '#18181B', sort_order: 63,
      customer_visible: true, booking_enabled: true,
    },
    {
      service_key: 'termite_inspection', name: 'Termite Inspection Service',
      description: 'Visual inspection for active termite activity, conducive conditions, and prior damage. Distinct from WDO real-estate letter.',
      category: 'inspection', billing_type: 'one_time',
      default_duration_minutes: 60, min_duration_minutes: 45, max_duration_minutes: 90,
      pricing_type: 'variable',
      is_taxable: false,
      requires_license: true, license_category: 'GHP',
      min_tech_skill_level: 2,
      icon: '🔍', color: '#18181B', sort_order: 64,
      customer_visible: true, booking_enabled: true,
    },
    {
      service_key: 'palm_injection', name: 'Palm Injection Service',
      description: 'Trunk injection of micronutrients (Mn, Mg, K) for palms — faster uptake than soil drench.',
      category: 'tree_shrub', billing_type: 'one_time',
      default_duration_minutes: 60, min_duration_minutes: 30, max_duration_minutes: 90,
      pricing_type: 'variable',
      is_taxable: true, tax_service_key: 'lawn_care',
      requires_license: true, license_category: 'L&O',
      min_tech_skill_level: 2,
      icon: '🌴', color: '#18181B', sort_order: 53,
      customer_visible: true, booking_enabled: true,
    },
  ];

  // ── 5) Mosquito: add Seasonal (Feb–Oct) variant ────────────────────────
  newRows.push({
    service_key: 'mosquito_seasonal', name: 'Seasonal Mosquito Control Service',
    description: 'Monthly mosquito treatment February through October — 9 visits per year, skipping low-pressure winter months (Nov–Jan).',
    category: 'mosquito', billing_type: 'recurring', frequency: 'monthly', visits_per_year: 9,
    default_duration_minutes: 60,
    pricing_type: 'variable',
    is_waveguard: true,
    is_taxable: true, tax_service_key: 'pest_control',
    requires_license: true, license_category: 'GHP',
    icon: '🦟', color: '#18181B', sort_order: 22,
    customer_visible: true, booking_enabled: true,
    internal_notes: 'Active Feb–Oct; scheduler should suppress visits Nov, Dec, Jan.',
  });

  // ── 6) Pest Control: add Re-Service for callbacks on recurring plans ──
  newRows.push({
    service_key: 'pest_re_service', name: 'Pest Control Re-Service',
    description: 'Free callback visit between regular service intervals for active recurring pest customers experiencing breakthrough pressure.',
    category: 'pest_control', billing_type: 'one_time',
    default_duration_minutes: 60,
    pricing_type: 'variable',
    is_taxable: true, tax_service_key: 'pest_control',
    requires_license: true, license_category: 'GHP',
    icon: '🔁', color: '#18181B', sort_order: 8,
    customer_visible: false, booking_enabled: false,
    internal_notes: 'No charge for active WaveGuard / recurring-pest customers. Tracked separately from regular service records.',
  });

  for (const row of newRows) {
    const existing = await knex('services').where('service_key', row.service_key).first();
    if (!existing) {
      await knex('services').insert(row).catch((err) => {
        // Tolerate environments that don't have all these columns yet.
        if (err && err.code === '42703') return;
        throw err;
      });
    }
  }

  // ── 7) Backfill: ensure "Rodent Inspection Service" exists somewhere ──
  // (clean DBs that never had the rodent-category one still need it.)
  const rodentInspect = await knex('services').where('name', 'Rodent Inspection Service').first();
  if (!rodentInspect) {
    await knex('services').insert({
      service_key: 'rodent_inspection', name: 'Rodent Inspection Service',
      description: 'Walkthrough to identify rodent entry points, droppings, conducive conditions, and recommend exclusion + trapping plan.',
      category: 'inspection', billing_type: 'one_time',
      default_duration_minutes: 60,
      pricing_type: 'variable',
      is_taxable: false,
      requires_license: true, license_category: 'GHP',
      min_tech_skill_level: 1,
      icon: '🔍', color: '#18181B', sort_order: 65,
      customer_visible: true, booking_enabled: true,
    }).catch((err) => { if (err && err.code === '42703') return; throw err; });
  }

  // ── 8) Normalize duration + pricing on all active services ─────────────
  // Per Adam: every service in the catalog defaults to 60 min and variable
  // pricing. Final price/duration are determined per-job during estimate.
  await knex('services')
    .where('is_active', true)
    .update({
      default_duration_minutes: 60,
      pricing_type: 'variable',
      base_price: null,
    });
};

exports.down = async function () {
  // Intentional no-op. See header comment.
};
