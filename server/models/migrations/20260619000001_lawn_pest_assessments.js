/**
 * Assessment services: rename + expand the assessment lineup.
 *
 * Per owner: we want a family of assessment services that mirror the
 * existing Lawn Assessment — none of which carry a catalog price (they are
 * variable / quoted per job, never a fixed .00 lock). Concretely:
 *
 *   1. Rename "Lawn Assessment Service" (service_key `lawn_inspection`) to
 *      just "Lawn Assessment" — drop the trailing "Service".
 *   2. Add "Pest Control Assessment" (service_key `pest_assessment`).
 *   3. Add "Lawn and Pest Control Assessment"
 *      (service_key `lawn_pest_assessment`).
 *
 * All three are pricing_type = 'variable' with base_price = NULL so the UI
 * leaves the price blank (no $ amount, no fixed-price lock). This matches
 * the post-normalization shape of the existing Lawn Assessment row.
 *
 * Renames are read-modify-write keyed by service_key so admin edits to other
 * columns survive. Inserts are guarded on service_key so the migration is
 * idempotent across envs.
 *
 * `down` is intentionally a no-op — reversing the rename would risk
 * clobbering newer edits made through the Service Library UI, and dropping
 * the new rows could orphan schedules/records that reference them.
 */
exports.up = async function (knex) {
  // ── 1) Rename the existing Lawn Assessment (drop trailing "Service") ──
  // Prefer the stable service_key; fall back to the known name for any env
  // where the key drifted.
  const lawn = await knex('services').where('service_key', 'lawn_inspection').first();
  if (lawn) {
    await knex('services')
      .where('service_key', 'lawn_inspection')
      .update({ name: 'Lawn Assessment', short_name: 'Lawn Assess' });
  } else {
    await knex('services')
      .where('name', 'Lawn Assessment Service')
      .update({ name: 'Lawn Assessment', short_name: 'Lawn Assess' });
  }

  // Keep the completion-profile snapshot in step with the rename. The
  // profile row's `service_name_snapshot` is what `serializeProfile` returns
  // as `serviceName`, which the typed-report builder uses as the
  // customer-facing service label — leave it stale and new lawn assessment
  // reports keep rendering the old "Lawn Assessment Service" heading.
  if (await knex.schema.hasTable('service_completion_profiles')) {
    await knex('service_completion_profiles')
      .where({ service_key: 'lawn_inspection', service_name_snapshot: 'Lawn Assessment Service' })
      .update({ service_name_snapshot: 'Lawn Assessment', updated_at: knex.fn.now() });
  }

  // ── 2) New assessment rows — no catalog price (variable, base_price NULL) ──
  // Seeded INACTIVE (is_active=false). These are meant to complete as
  // internal-only consultations (no customer-facing report), but that
  // completion path is a coupled change landing in a dedicated follow-up PR.
  // Until then they must not be schedulable/completable — a completion now
  // would fall back to DEFAULT_SERVICE_REPORT_PROFILE and send a customer
  // Service Report (the resolver/pickers filter on is_active, so inactive
  // rows are invisible to both booking and the admin appointment picker).
  // The follow-up flips is_active=true alongside the consultation profiles.
  const newRows = [
    {
      service_key: 'pest_assessment', name: 'Pest Control Assessment', short_name: 'Pest Assess',
      description: 'Interior + exterior walkthrough to evaluate active pest pressure, conducive conditions, and a recommended treatment plan. Findings drive the quote — no fixed price.',
      category: 'inspection', billing_type: 'one_time',
      default_duration_minutes: 60, min_duration_minutes: 45, max_duration_minutes: 90,
      pricing_type: 'variable', base_price: null,
      is_taxable: false,
      requires_license: true, license_category: 'GHP',
      min_tech_skill_level: 1,
      icon: '🐛', color: '#18181B', sort_order: 66,
      customer_visible: true, booking_enabled: true, is_active: false,
    },
    {
      service_key: 'lawn_pest_assessment', name: 'Lawn and Pest Control Assessment', short_name: 'Lawn+Pest Assess',
      description: 'Combined turf and pest evaluation: lawn health (turf density, thatch, irrigation, disease) plus interior/exterior pest pressure and conducive conditions, with a unified recommendation. Findings drive the quote — no fixed price.',
      category: 'inspection', billing_type: 'one_time',
      default_duration_minutes: 60, min_duration_minutes: 45, max_duration_minutes: 90,
      pricing_type: 'variable', base_price: null,
      is_taxable: false,
      requires_license: true, license_category: 'GHP',
      min_tech_skill_level: 1,
      icon: '📋', color: '#18181B', sort_order: 67,
      customer_visible: true, booking_enabled: true, is_active: false,
    },
  ];

  for (const row of newRows) {
    const existing = await knex('services').where('service_key', row.service_key).first();
    if (!existing) {
      await knex('services').insert(row).catch((err) => {
        // Tolerate environments missing some of these columns.
        if (err && err.code === '42703') return;
        throw err;
      });
    }
  }
};

exports.down = async function () {
  // Intentional no-op. See header comment.
};
