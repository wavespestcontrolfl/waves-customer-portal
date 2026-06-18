/**
 * lawn_re_service service row + completion profile.
 *
 * Mirrors `pest_re_service` (added in 20260507000002, cut over to Service
 * Report V1 in 20260611000012) for the lawn-care line: a free callback visit
 * between regular service intervals for active recurring lawn-care customers
 * experiencing breakthrough weed / disease / insect pressure.
 *
 * Same concept as the pest re-service — there is no new mechanism here:
 *   - Scheduling: admins pick it from the Service Library in the new-
 *     appointment modal exactly like pest_re_service. It ships
 *     `customer_visible: false` / `booking_enabled: false` (internal, not
 *     self-bookable), but `is_active: true` so it surfaces in the admin
 *     service lookup (GET /admin/services filters on active only).
 *   - Callback tracking: the generic `is_callback` flag and the dispatch /
 *     service-record / document callback paths already key off the
 *     "Re-Service" name, so no runtime code change is needed.
 *   - Completion routing: PROJECT_TYPE_BY_SERVICE_KEY already maps `/^lawn_/`
 *     to `one_time_lawn_treatment`, so this row routes through the typed
 *     lawn CompletionPanel + Service Report V1, the same end state the rest
 *     of the lawn family reached at the Phase-1 cutover. We seed the profile
 *     directly in that cut-over shape (completion_mode='service_report',
 *     project_type='one_time_lawn_treatment') so it matches its siblings on
 *     day one — no separate cutover migration required.
 *
 * Pricing is variable / base_price null — no charge for active WaveGuard /
 * recurring lawn-care customers; final price (if any) is set per job.
 */

const SERVICE_KEY = 'lawn_re_service';

const SERVICE_ROW = {
  service_key: SERVICE_KEY,
  name: 'Lawn Care Re-Service',
  short_name: 'Lawn Re-Service',
  description:
    'Free callback visit between regular service intervals for active recurring lawn-care customers experiencing breakthrough weed, disease, or insect pressure.',
  internal_notes:
    'No charge for active WaveGuard / recurring lawn-care customers. Tracked separately from regular service records. Internal-only: not customer-visible or self-bookable.',
  category: 'lawn_care',
  billing_type: 'one_time',
  is_waveguard: false,
  default_duration_minutes: 60,
  pricing_type: 'variable',
  base_price: null,
  is_taxable: true,
  tax_service_key: 'lawn_care',
  requires_license: true,
  license_category: 'L&O',
  customer_visible: false,
  booking_enabled: false,
  sort_order: 14,
  icon: '🔁',
  color: '#18181B',
  is_active: true,
  is_archived: false,
};

const COMPLETION_PROFILE = {
  service_key: SERVICE_KEY,
  service_name_snapshot: SERVICE_ROW.name,
  category: SERVICE_ROW.category,
  billing_type: SERVICE_ROW.billing_type,
  // Ships directly in the post-cutover shape, matching the rest of the lawn
  // family (lawn_aeration / lawn_fungicide / lawn_insect_control / ...).
  completion_mode: 'service_report',
  project_type: 'one_time_lawn_treatment',
  creates_service_record: true,
  portal_visibility: 'token_only',
  portal_attach_policy: 'recurring_customer',
  followup_policy: 'none',
  default_followup_days: null,
  active: true,
  notes: 'Lawn-care re-service (callback). Same concept as pest_re_service; routed through the typed lawn completion + Service Report V1.',
};

exports.up = async function up(knex) {
  const hasServices = await knex.schema.hasTable('services');
  if (!hasServices) return;

  const existing = await knex('services').where({ service_key: SERVICE_KEY }).first();
  if (existing) {
    await knex('services')
      .where({ service_key: SERVICE_KEY })
      .update({ ...SERVICE_ROW, updated_at: knex.fn.now() });
  } else {
    await knex('services').insert(SERVICE_ROW);
  }

  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) return;

  const existingProfile = await knex('service_completion_profiles')
    .where({ service_key: SERVICE_KEY })
    .first();
  if (existingProfile) {
    await knex('service_completion_profiles')
      .where({ service_key: SERVICE_KEY })
      .update({ ...COMPLETION_PROFILE, updated_at: knex.fn.now() });
  } else {
    await knex('service_completion_profiles').insert(COMPLETION_PROFILE);
  }
};

exports.down = async function down(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (hasProfiles) {
    await knex('service_completion_profiles').where({ service_key: SERVICE_KEY }).del();
  }

  const hasServices = await knex.schema.hasTable('services');
  if (!hasServices) return;

  const ids = await knex('services').where({ service_key: SERVICE_KEY }).pluck('id');
  if (ids.length > 0) {
    if (await knex.schema.hasColumn('service_records', 'service_id')) {
      await knex('service_records').whereIn('service_id', ids).update({ service_id: null });
    }
    if (await knex.schema.hasColumn('scheduled_services', 'service_id')) {
      await knex('scheduled_services').whereIn('service_id', ids).update({ service_id: null });
    }
  }

  await knex('services').where({ service_key: SERVICE_KEY }).del();
};
