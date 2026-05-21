/**
 * service_completion_profiles
 *
 * Routes service-library rows to the correct field completion experience.
 * Routine recurring work stays on the normal service-report path. One-time
 * and documentation-heavy services can require a Project as the customer
 * artifact while still creating a lightweight service_records audit row when
 * the visit is ultimately completed.
 */

const SPECIAL_PROJECT_TYPES = {
  wdo_inspection: {
    completionMode: 'special_project',
    projectType: 'wdo_inspection',
    portalVisibility: 'token_only',
    portalAttachPolicy: 'recurring_customer',
    notes: 'Formal WDO report. Keep out of routine service-report surfaces.',
  },
  termite_slab_pretreat: {
    completionMode: 'special_project',
    projectType: 'pre_treatment_termite_certificate',
    portalVisibility: 'token_only',
    portalAttachPolicy: 'recurring_customer',
    notes: 'Pre-slab termite certificate/compliance record.',
  },
  termite_trenching: {
    completionMode: 'special_project',
    projectType: 'termite_inspection',
    portalVisibility: 'token_only',
    portalAttachPolicy: 'recurring_customer',
    notes: 'Termite trenching needs treatment/compliance documentation.',
  },
  termite_liquid: {
    completionMode: 'special_project',
    projectType: 'termite_inspection',
    portalVisibility: 'token_only',
    portalAttachPolicy: 'recurring_customer',
    notes: 'Liquid termite treatment needs treatment/compliance documentation.',
  },
};

const PROJECT_TYPE_BY_SERVICE_KEY = [
  [/^rodent_trapping(?:_|$)|^rodent_exclusion|^rodent_sanitation|^rodent_general_one_time$|^rodent_bait_setup$/, 'rodent_exclusion'],
  [/^wildlife_trapping$/, 'rodent_exclusion'],
  [/^flea_tick$/, 'flea'],
  [/^pest_initial_|^pest_re_service$|^fire_ant$|^bee_wasp_removal$|^mud_dauber_removal$|^tick_control$/, 'pest_inspection'],
  [/^lawn_/, 'pest_inspection'],
  [/^mosquito_event$/, 'pest_inspection'],
  [/^palm_injection$/, 'pest_inspection'],
  [/^termite_inspection$/, 'termite_inspection'],
  [/^termite_(spot_treatment|pretreatment|cartridge_replacement|installation_setup)$/, 'termite_inspection'],
  [/^pest_inspection$/, 'pest_inspection'],
  [/^new_customer_inspection$/, 'pest_inspection'],
  [/^rodent_inspection$/, 'rodent_exclusion'],
];

function projectTypeForService(serviceKey) {
  const match = PROJECT_TYPE_BY_SERVICE_KEY.find(([pattern]) => pattern.test(serviceKey));
  return match ? match[1] : 'pest_inspection';
}

function profileForService(service) {
  const serviceKey = String(service.service_key || '').trim();
  const billingType = String(service.billing_type || '').trim().toLowerCase();
  const special = SPECIAL_PROJECT_TYPES[serviceKey];

  if (special) {
    return {
      service_key: serviceKey,
      service_name_snapshot: service.name || null,
      category: service.category || null,
      billing_type: service.billing_type || null,
      completion_mode: special.completionMode,
      project_type: special.projectType,
      creates_service_record: true,
      portal_visibility: special.portalVisibility,
      portal_attach_policy: special.portalAttachPolicy,
      followup_policy: service.requires_follow_up ? 'alert' : 'none',
      default_followup_days: service.follow_up_interval_days || null,
      active: true,
      notes: special.notes,
    };
  }

  if (billingType === 'one_time') {
    return {
      service_key: serviceKey,
      service_name_snapshot: service.name || null,
      category: service.category || null,
      billing_type: service.billing_type || null,
      completion_mode: 'project_required',
      project_type: projectTypeForService(serviceKey),
      creates_service_record: true,
      portal_visibility: 'token_only',
      portal_attach_policy: 'recurring_customer',
      followup_policy: service.requires_follow_up ? 'alert' : 'none',
      default_followup_days: service.follow_up_interval_days || null,
      active: true,
      notes: 'One-time service routed through Projects as the primary customer artifact.',
    };
  }

  return {
    service_key: serviceKey,
    service_name_snapshot: service.name || null,
    category: service.category || null,
    billing_type: service.billing_type || null,
    completion_mode: 'service_report',
    project_type: null,
    creates_service_record: true,
    portal_visibility: 'customer_portal',
    portal_attach_policy: 'active_portal_customer',
    followup_policy: 'none',
    default_followup_days: null,
    active: true,
    notes: 'Routine recurring service uses the standard completion/report flow.',
  };
}

exports.up = async function up(knex) {
  await knex.schema.createTable('service_completion_profiles', (t) => {
    t.string('service_key', 100).primary();
    t.string('service_name_snapshot', 200);
    t.string('category', 80);
    t.string('billing_type', 40);
    t.string('completion_mode', 40).notNullable();
    t.string('project_type', 80);
    t.boolean('creates_service_record').notNullable().defaultTo(true);
    t.string('portal_visibility', 40).notNullable().defaultTo('customer_portal');
    t.string('portal_attach_policy', 60).notNullable().defaultTo('active_portal_customer');
    t.string('followup_policy', 40).notNullable().defaultTo('none');
    t.integer('default_followup_days');
    t.boolean('active').notNullable().defaultTo(true);
    t.text('notes');
    t.timestamps(true, true);

    t.index(['completion_mode', 'active'], 'idx_service_completion_profiles_mode_active');
    t.index(['project_type'], 'idx_service_completion_profiles_project_type');
  });

  await knex.raw(`
    ALTER TABLE service_completion_profiles
    ADD CONSTRAINT service_completion_profiles_mode_check
    CHECK (completion_mode IN ('service_report', 'project_required', 'special_project', 'internal_only'))
  `);
  await knex.raw(`
    ALTER TABLE service_completion_profiles
    ADD CONSTRAINT service_completion_profiles_portal_visibility_check
    CHECK (portal_visibility IN ('customer_portal', 'token_only', 'internal_only'))
  `);
  await knex.raw(`
    ALTER TABLE service_completion_profiles
    ADD CONSTRAINT service_completion_profiles_attach_policy_check
    CHECK (portal_attach_policy IN ('always', 'active_portal_customer', 'recurring_customer', 'never'))
  `);
  await knex.raw(`
    ALTER TABLE service_completion_profiles
    ADD CONSTRAINT service_completion_profiles_followup_policy_check
    CHECK (followup_policy IN ('none', 'alert', 'auto_schedule'))
  `);

  const services = await knex('services')
    .select('service_key', 'name', 'category', 'billing_type', 'requires_follow_up', 'follow_up_interval_days')
    .orderBy('service_key');

  if (services.length) {
    await knex('service_completion_profiles').insert(services.map(profileForService));
  }

  await knex.raw(`
    ALTER TABLE service_records DROP CONSTRAINT IF EXISTS service_records_completion_source_check
  `);
  await knex.raw(`
    ALTER TABLE service_records
    ADD CONSTRAINT service_records_completion_source_check
    CHECK (
      completion_source IS NULL
      OR completion_source IN ('one_tap_completion', 'detailed_form', 'project_completion')
    )
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE service_records DROP CONSTRAINT IF EXISTS service_records_completion_source_check
  `);
  await knex.raw(`
    ALTER TABLE service_records
    ADD CONSTRAINT service_records_completion_source_check
    CHECK (
      completion_source IS NULL
      OR completion_source IN ('one_tap_completion', 'detailed_form')
    )
  `);
  await knex.schema.dropTableIfExists('service_completion_profiles');
};
