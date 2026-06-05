const SERVICE_KEY = 'cockroach_control';

const SERVICE_ROW = {
  service_key: SERVICE_KEY,
  name: 'Cockroach Control Service',
  short_name: 'Cockroach Control',
  description:
    'Two-treatment cockroach control program. Includes an initial treatment and a follow-up treatment scheduled about 14 days later.',
  internal_notes:
    'Flat $350 package for 2 treatments spaced 2 weeks apart. Schedule the follow-up for 14 days after the initial treatment.',
  category: 'pest_control',
  subcategory: 'cockroach',
  billing_type: 'one_time',
  is_waveguard: false,
  default_duration_minutes: 60,
  min_duration_minutes: 45,
  max_duration_minutes: 90,
  scheduling_buffer_minutes: 0,
  requires_follow_up: true,
  follow_up_interval_days: 14,
  frequency: null,
  visits_per_year: 2,
  pricing_type: 'fixed',
  base_price: 350.00,
  price_range_min: 350.00,
  price_range_max: 350.00,
  pricing_model_key: null,
  is_taxable: true,
  tax_service_key: 'pest_control',
  requires_license: true,
  license_category: 'GHP',
  min_tech_skill_level: 1,
  default_products: JSON.stringify(['Alpine WSG', 'Advion Gel', 'Gentrol IGR']),
  typical_materials_cost: null,
  customer_visible: true,
  booking_enabled: true,
  sort_order: 9,
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
    project_type: 'cockroach',
    creates_service_record: true,
    portal_visibility: 'token_only',
    portal_attach_policy: 'recurring_customer',
    followup_policy: 'alert',
    default_followup_days: SERVICE_ROW.follow_up_interval_days,
    active: true,
    notes: 'One-time cockroach control package routed through Projects as the primary customer artifact.',
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
