/**
 * bed_bug_treatment service row + completion profile.
 *
 * Bed bug treatments have pricing config (`pricing_configs.onetime_bed_bug`)
 * but never had a `services` row, so bed-bug appointments can't resolve a
 * completion profile at all. This adds the row so the specialty-completion
 * cutover (separate, later migration) can route it.
 *
 * Ships HIDDEN AND NON-BOOKABLE (`customer_visible: false`,
 * `booking_enabled: false`): bed bug is a high-emotion service and its
 * customer-facing report copy, follow-up flow, and SMS/email templates
 * require explicit owner approval before exposure (see
 * docs/design/specialty-service-completion-contract.md). The profile is
 * created as `project_required` — identical routing to today's other
 * one-time specialty services — so this migration changes no completion
 * behavior. The cutover migration flips it later.
 *
 * Pricing is intentionally variable (room/method-based via
 * `onetime_bed_bug`); base_price stays null per the shop convention that
 * manually-priced services don't get a catalog price.
 */

const SERVICE_KEY = 'bed_bug_treatment';

const SERVICE_ROW = {
  service_key: SERVICE_KEY,
  name: 'Bed Bug Treatment',
  short_name: 'Bed Bug',
  description:
    'Bed bug inspection and treatment (chemical, heat, or combined), with a follow-up visit about 14 days after the initial treatment.',
  internal_notes:
    'Priced per room/method from pricing config onetime_bed_bug — quote manually. Hidden + non-bookable until the specialty report rollout approves bed bug copy (owner sign-off required).',
  category: 'pest_control',
  subcategory: 'bed_bug',
  billing_type: 'one_time',
  is_waveguard: false,
  default_duration_minutes: 120,
  min_duration_minutes: 60,
  max_duration_minutes: 240,
  scheduling_buffer_minutes: 0,
  requires_follow_up: true,
  follow_up_interval_days: 14,
  frequency: null,
  visits_per_year: 2,
  pricing_type: 'custom',
  base_price: null,
  price_range_min: null,
  price_range_max: null,
  pricing_model_key: null,
  is_taxable: true,
  tax_service_key: 'pest_control',
  requires_license: true,
  license_category: 'GHP',
  min_tech_skill_level: 2,
  default_products: JSON.stringify(['Temprid FX', 'CrossFire', 'Gentrol IGR']),
  typical_materials_cost: null,
  customer_visible: false,
  booking_enabled: false,
  sort_order: 10,
  icon: 'bug',
  color: '#18181B',
  is_active: true,
  is_archived: false,
};

function completionProfileForService() {
  return {
    service_key: SERVICE_KEY,
    service_name_snapshot: SERVICE_ROW.name,
    category: SERVICE_ROW.category,
    billing_type: SERVICE_ROW.billing_type,
    completion_mode: 'project_required',
    project_type: 'bed_bug',
    creates_service_record: true,
    portal_visibility: 'token_only',
    portal_attach_policy: 'recurring_customer',
    followup_policy: 'alert',
    default_followup_days: SERVICE_ROW.follow_up_interval_days,
    active: true,
    notes: 'Bed bug treatment — project-backed until the specialty service-report cutover; hidden/non-bookable pending owner copy approval.',
  };
}

exports.up = async function up(knex) {
  const hasServices = await knex.schema.hasTable('services');
  if (!hasServices) return;

  const existing = await knex('services').where({ service_key: SERVICE_KEY }).first();
  if (existing) {
    await knex('services')
      .where({ service_key: SERVICE_KEY })
      .update({
        ...SERVICE_ROW,
        updated_at: knex.fn.now(),
      });
  } else {
    await knex('services').insert(SERVICE_ROW);
  }

  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) return;

  const profile = completionProfileForService();
  const existingProfile = await knex('service_completion_profiles')
    .where({ service_key: SERVICE_KEY })
    .first();

  if (existingProfile) {
    await knex('service_completion_profiles')
      .where({ service_key: SERVICE_KEY })
      .update({
        ...profile,
        updated_at: knex.fn.now(),
      });
  } else {
    await knex('service_completion_profiles').insert(profile);
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
