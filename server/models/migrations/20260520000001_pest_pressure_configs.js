/**
 * Pest Pressure configs.
 *
 * Singleton-style config table scoped by `scope` text key (default 'global').
 * Waves is single-tenant today; scope leaves room for per-service-line or
 * per-org variants without a schema change later.
 *
 * Also adds two columns to service_records for client-reported pest activity,
 * which feeds the engine's client-rating component. This is the only place a
 * 0-5 number from the customer (or from a tech entering on their behalf) lands.
 */

async function addColumnIfMissing(knex, table, name, add) {
  if (!(await knex.schema.hasColumn(table, name))) {
    await knex.schema.alterTable(table, (t) => add(t));
  }
}

async function dropColumnIfPresent(knex, table, name) {
  if (await knex.schema.hasColumn(table, name)) {
    await knex.schema.alterTable(table, (t) => t.dropColumn(name));
  }
}

const DEFAULT_CONFIG_ROW = {
  scope: 'global',
  enabled: true,
  show_on_customer_report: true,
  show_how_calculated: true,
  show_component_breakdown_to_customer: false,
  missing_data_behavior: 'recalculate_available_components',
  minimum_data_required: JSON.stringify({
    requireOneOf: ['technicianRating', 'clientRating', 'history'],
  }),
  allow_manual_override: true,
  allow_technician_client_rating_entry: true,
  weights: JSON.stringify({
    client: 25,
    technician: 30,
    reService: 20,
    recurring: 15,
    risk: 10,
  }),
  labels: JSON.stringify([
    { key: 'very_low', name: 'Very Low', min: 0.0, max: 0.9, description: 'Little to no pest activity.' },
    { key: 'low', name: 'Low', min: 1.0, max: 1.9, description: 'Minor or occasional activity.' },
    { key: 'moderate', name: 'Moderate', min: 2.0, max: 2.9, description: 'Noticeable activity that should be watched.' },
    { key: 'elevated', name: 'Elevated', min: 3.0, max: 3.9, description: 'Recurring or spreading activity.' },
    { key: 'high', name: 'High', min: 4.0, max: 5.0, description: 'Heavy activity, repeated issues, or urgent concern.' },
  ]),
  trend_thresholds: JSON.stringify({
    improvingAtOrBelow: -0.5,
    stableBand: 0.4,
    increasingFrom: 0.5,
    significantIncreaseFrom: 1.0,
  }),
  service_frequency_windows: JSON.stringify({
    monthly: 30,
    bimonthly: 60,
    quarterly: 90,
    fallbackDays: 90,
  }),
  client_question_text: JSON.stringify({
    monthly: 'Since your last service, how much pest activity have you noticed?',
    bimonthly: 'Over the past 2 months, how much pest activity have you noticed?',
    quarterly: 'Over the past 3 months, how much pest activity have you noticed?',
    custom: 'Since your last service, how much pest activity have you noticed?',
  }),
  customer_explanation_text:
    'Pest Pressure is a 0–5 score that estimates the current level of pest activity at your property. The score combines reported activity, technician observations, re-service history, recurring issue areas, and property risk factors such as entry points, moisture, sanitation, or harborage conditions.\n\nFor monthly services, we review activity since the last visit. For bi-monthly services, we review the past two months. For quarterly services, we review the past three months. Future reports compare scores over time to show whether pest pressure is improving, stable, or increasing.',
  calculation_version: '1.0',
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pest_pressure_configs'))) {
    await knex.schema.createTable('pest_pressure_configs', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('scope', 60).notNullable().defaultTo('global');
      t.boolean('enabled').notNullable().defaultTo(true);
      t.boolean('show_on_customer_report').notNullable().defaultTo(true);
      t.boolean('show_how_calculated').notNullable().defaultTo(true);
      t.boolean('show_component_breakdown_to_customer').notNullable().defaultTo(false);
      t.string('missing_data_behavior', 60).notNullable().defaultTo('recalculate_available_components');
      t.jsonb('minimum_data_required').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.boolean('allow_manual_override').notNullable().defaultTo(true);
      t.boolean('allow_technician_client_rating_entry').notNullable().defaultTo(true);
      t.jsonb('weights').notNullable();
      t.jsonb('labels').notNullable();
      t.jsonb('trend_thresholds').notNullable();
      t.jsonb('service_frequency_windows').notNullable();
      t.jsonb('client_question_text').notNullable();
      t.text('customer_explanation_text').notNullable();
      t.string('calculation_version', 20).notNullable().defaultTo('1.0');
      t.uuid('created_by').references('id').inTable('technicians').onDelete('SET NULL');
      t.uuid('updated_by').references('id').inTable('technicians').onDelete('SET NULL');
      t.timestamps(true, true);
      t.unique(['scope']);
    });
  }

  const existing = await knex('pest_pressure_configs').where({ scope: 'global' }).first('id');
  if (!existing) {
    await knex('pest_pressure_configs').insert(DEFAULT_CONFIG_ROW);
  }

  // Client-reported pest activity feeds the engine's client-rating component.
  // 0-5 smallint with a CHECK; source distinguishes self-reported from
  // tech-entered-on-behalf-of for audit and UI labelling.
  await addColumnIfMissing(knex, 'service_records', 'client_pest_rating', (t) => t.smallint('client_pest_rating'));
  await addColumnIfMissing(knex, 'service_records', 'client_pest_rating_source', (t) => t.string('client_pest_rating_source', 20));
  await addColumnIfMissing(knex, 'service_records', 'client_pest_rating_at', (t) => t.timestamp('client_pest_rating_at'));
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'service_records_client_pest_rating_range'
      ) THEN
        ALTER TABLE service_records
          ADD CONSTRAINT service_records_client_pest_rating_range
          CHECK (client_pest_rating IS NULL OR (client_pest_rating BETWEEN 0 AND 5));
      END IF;
    END$$;
  `);
};

exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE service_records DROP CONSTRAINT IF EXISTS service_records_client_pest_rating_range');
  for (const column of ['client_pest_rating_at', 'client_pest_rating_source', 'client_pest_rating']) {
    await dropColumnIfPresent(knex, 'service_records', column);
  }
  await knex.schema.dropTableIfExists('pest_pressure_configs');
};
