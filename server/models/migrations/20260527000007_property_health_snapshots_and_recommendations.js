/**
 * Property Health Snapshots + Smart Recommendation Cards.
 *
 * These tables sit between raw assessment/service data and customer-facing
 * portal/report copy. They make each customer-visible sentence approvable,
 * source-backed, and reusable across lawn, pest, mosquito, rodent, termite,
 * and tree/shrub domains.
 */

const DOMAINS = ['lawn', 'pest', 'mosquito', 'rodent', 'termite', 'tree_shrub'];
const SOURCE_TYPES = ['lawn_assessment', 'service_record', 'portal_upload', 'callback_review'];
const SNAPSHOT_STATUSES = ['draft', 'tech_confirmed', 'admin_approved', 'customer_visible', 'archived'];
const GENERATED_BY = ['system', 'admin', 'tech'];
const CARD_TYPES = [
  'tier_upgrade',
  'addon',
  'follow_up',
  'customer_education',
  'office_review',
  'tech_review',
  'retention_review',
];
const PRIORITIES = ['low', 'medium', 'high'];
const CARD_STATUSES = [
  'draft',
  'needs_admin_review',
  'approved',
  'customer_visible',
  'dismissed',
  'accepted',
  'expired',
];
const ACTOR_TYPES = ['system', 'admin', 'tech', 'customer'];

function quoted(values) {
  return values.map((value) => `'${value}'`).join(', ');
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('property_health_snapshots'))) {
    await knex.schema.createTable('property_health_snapshots', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.string('domain', 30).notNullable().defaultTo('lawn');
      t.string('source_type', 40).notNullable().defaultTo('lawn_assessment');
      t.uuid('source_id');
      t.uuid('assessment_id').references('id').inTable('lawn_assessments').onDelete('SET NULL');
      t.uuid('service_id').references('id').inTable('scheduled_services').onDelete('SET NULL');
      t.uuid('service_record_id').references('id').inTable('service_records').onDelete('SET NULL');

      t.string('status', 30).notNullable().defaultTo('draft');
      t.boolean('customer_visible').notNullable().defaultTo(false);
      t.string('snapshot_version', 60).notNullable().defaultTo('lawn_snapshot_v1');
      t.timestamp('generated_at').notNullable().defaultTo(knex.fn.now());
      t.string('generated_by', 30).notNullable().defaultTo('system');
      t.uuid('generated_by_technician_id').references('id').inTable('technicians').onDelete('SET NULL');

      t.string('headline', 180);
      t.text('summary_customer');
      t.text('summary_internal');
      t.jsonb('property_context').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb('findings').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
      t.jsonb('treatment_context').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb('weather_context').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb('expected_window').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb('next_watch_items').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
      t.jsonb('disclaimers').notNullable().defaultTo(knex.raw("'[]'::jsonb"));

      t.uuid('approved_by').references('id').inTable('technicians').onDelete('SET NULL');
      t.timestamp('approved_at');
      t.timestamps(true, true);
    });
  }

  if (!(await knex.schema.hasTable('property_snapshot_evidence'))) {
    await knex.schema.createTable('property_snapshot_evidence', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('snapshot_id')
        .notNullable()
        .references('id')
        .inTable('property_health_snapshots')
        .onDelete('CASCADE');
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.string('source_table', 80).notNullable();
      t.uuid('source_id');
      t.string('evidence_key', 100).notNullable();
      t.string('metric', 100);
      t.jsonb('value').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.string('comparison', 120);
      t.decimal('confidence', 4, 3);
      t.string('customer_label', 180);
      t.timestamps(true, true);
    });
  }

  if (!(await knex.schema.hasTable('property_recommendation_cards'))) {
    await knex.schema.createTable('property_recommendation_cards', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('snapshot_id')
        .references('id')
        .inTable('property_health_snapshots')
        .onDelete('CASCADE');
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.string('domain', 30).notNullable().defaultTo('lawn');
      t.string('type', 40).notNullable();
      t.string('title', 180).notNullable();
      t.string('priority', 20).notNullable().defaultTo('low');
      t.decimal('confidence', 4, 3).notNullable().defaultTo(0);
      t.string('status', 30).notNullable().defaultTo('draft');
      t.boolean('customer_visible').notNullable().defaultTo(false);
      t.boolean('requires_human_approval').notNullable().defaultTo(true);
      t.text('customer_copy');
      t.text('internal_reason');
      t.jsonb('trigger_signals').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
      t.jsonb('recommended_action').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb('guardrails').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb('outcome').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.timestamp('expires_at');
      t.uuid('approved_by').references('id').inTable('technicians').onDelete('SET NULL');
      t.timestamp('approved_at');
      t.timestamps(true, true);
    });
  }

  if (!(await knex.schema.hasTable('property_recommendation_events'))) {
    await knex.schema.createTable('property_recommendation_events', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('recommendation_id')
        .references('id')
        .inTable('property_recommendation_cards')
        .onDelete('CASCADE');
      t.uuid('snapshot_id')
        .references('id')
        .inTable('property_health_snapshots')
        .onDelete('CASCADE');
      t.uuid('customer_id').references('id').inTable('customers').onDelete('CASCADE');
      t.string('event_type', 50).notNullable();
      t.string('actor_type', 30).notNullable().defaultTo('system');
      t.uuid('actor_id');
      t.jsonb('metadata').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    });
  }

  await knex.raw(`
    ALTER TABLE property_health_snapshots
    DROP CONSTRAINT IF EXISTS property_health_snapshots_domain_check,
    DROP CONSTRAINT IF EXISTS property_health_snapshots_source_type_check,
    DROP CONSTRAINT IF EXISTS property_health_snapshots_status_check,
    DROP CONSTRAINT IF EXISTS property_health_snapshots_generated_by_check,
    DROP CONSTRAINT IF EXISTS property_health_snapshots_visible_requires_approval_check
  `);
  await knex.raw(`
    ALTER TABLE property_health_snapshots
    ADD CONSTRAINT property_health_snapshots_domain_check CHECK (domain IN (${quoted(DOMAINS)})),
    ADD CONSTRAINT property_health_snapshots_source_type_check CHECK (source_type IN (${quoted(SOURCE_TYPES)})),
    ADD CONSTRAINT property_health_snapshots_status_check CHECK (status IN (${quoted(SNAPSHOT_STATUSES)})),
    ADD CONSTRAINT property_health_snapshots_generated_by_check CHECK (generated_by IN (${quoted(GENERATED_BY)})),
    ADD CONSTRAINT property_health_snapshots_visible_requires_approval_check
      CHECK (customer_visible IS NOT TRUE OR approved_at IS NOT NULL)
  `);

  await knex.raw(`
    ALTER TABLE property_recommendation_cards
    DROP CONSTRAINT IF EXISTS property_recommendation_cards_domain_check,
    DROP CONSTRAINT IF EXISTS property_recommendation_cards_type_check,
    DROP CONSTRAINT IF EXISTS property_recommendation_cards_priority_check,
    DROP CONSTRAINT IF EXISTS property_recommendation_cards_status_check,
    DROP CONSTRAINT IF EXISTS property_recommendation_cards_confidence_check,
    DROP CONSTRAINT IF EXISTS property_recommendation_cards_visible_requires_approval_check
  `);
  await knex.raw(`
    ALTER TABLE property_recommendation_cards
    ADD CONSTRAINT property_recommendation_cards_domain_check CHECK (domain IN (${quoted(DOMAINS)})),
    ADD CONSTRAINT property_recommendation_cards_type_check CHECK (type IN (${quoted(CARD_TYPES)})),
    ADD CONSTRAINT property_recommendation_cards_priority_check CHECK (priority IN (${quoted(PRIORITIES)})),
    ADD CONSTRAINT property_recommendation_cards_status_check CHECK (status IN (${quoted(CARD_STATUSES)})),
    ADD CONSTRAINT property_recommendation_cards_confidence_check CHECK (confidence >= 0 AND confidence <= 1),
    ADD CONSTRAINT property_recommendation_cards_visible_requires_approval_check
      CHECK (
        customer_visible IS NOT TRUE
        OR approved_at IS NOT NULL
        OR (type = 'customer_education' AND requires_human_approval IS FALSE)
      )
  `);

  await knex.raw(`
    ALTER TABLE property_recommendation_events
    DROP CONSTRAINT IF EXISTS property_recommendation_events_actor_type_check
  `);
  await knex.raw(`
    ALTER TABLE property_recommendation_events
    ADD CONSTRAINT property_recommendation_events_actor_type_check CHECK (actor_type IN (${quoted(ACTOR_TYPES)}))
  `);

  await knex.raw('CREATE INDEX IF NOT EXISTS idx_property_snapshots_customer_id ON property_health_snapshots(customer_id)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_property_snapshots_assessment_id ON property_health_snapshots(assessment_id)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_property_snapshots_service_record_id ON property_health_snapshots(service_record_id)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_property_snapshots_customer_visible ON property_health_snapshots(customer_id, customer_visible)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_property_snapshots_status ON property_health_snapshots(status)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_property_snapshots_domain_status ON property_health_snapshots(domain, status)');

  await knex.raw('CREATE INDEX IF NOT EXISTS idx_property_snapshot_evidence_snapshot_id ON property_snapshot_evidence(snapshot_id)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_property_snapshot_evidence_customer_id ON property_snapshot_evidence(customer_id)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_property_snapshot_evidence_source ON property_snapshot_evidence(source_table, source_id)');

  await knex.raw('CREATE INDEX IF NOT EXISTS idx_property_recommendations_snapshot_id ON property_recommendation_cards(snapshot_id)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_property_recommendations_customer_id ON property_recommendation_cards(customer_id)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_property_recommendations_customer_visible ON property_recommendation_cards(customer_id, customer_visible)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_property_recommendations_status ON property_recommendation_cards(status)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_property_recommendations_type ON property_recommendation_cards(type)');

  await knex.raw('CREATE INDEX IF NOT EXISTS idx_property_recommendation_events_recommendation_id ON property_recommendation_events(recommendation_id)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_property_recommendation_events_snapshot_id ON property_recommendation_events(snapshot_id)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_property_recommendation_events_customer_id ON property_recommendation_events(customer_id)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_property_recommendation_events_event_type ON property_recommendation_events(event_type)');
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_property_recommendation_events_event_type');
  await knex.raw('DROP INDEX IF EXISTS idx_property_recommendation_events_customer_id');
  await knex.raw('DROP INDEX IF EXISTS idx_property_recommendation_events_snapshot_id');
  await knex.raw('DROP INDEX IF EXISTS idx_property_recommendation_events_recommendation_id');
  await knex.raw('DROP INDEX IF EXISTS idx_property_recommendations_type');
  await knex.raw('DROP INDEX IF EXISTS idx_property_recommendations_status');
  await knex.raw('DROP INDEX IF EXISTS idx_property_recommendations_customer_visible');
  await knex.raw('DROP INDEX IF EXISTS idx_property_recommendations_customer_id');
  await knex.raw('DROP INDEX IF EXISTS idx_property_recommendations_snapshot_id');
  await knex.raw('DROP INDEX IF EXISTS idx_property_snapshot_evidence_source');
  await knex.raw('DROP INDEX IF EXISTS idx_property_snapshot_evidence_customer_id');
  await knex.raw('DROP INDEX IF EXISTS idx_property_snapshot_evidence_snapshot_id');
  await knex.raw('DROP INDEX IF EXISTS idx_property_snapshots_domain_status');
  await knex.raw('DROP INDEX IF EXISTS idx_property_snapshots_status');
  await knex.raw('DROP INDEX IF EXISTS idx_property_snapshots_customer_visible');
  await knex.raw('DROP INDEX IF EXISTS idx_property_snapshots_service_record_id');
  await knex.raw('DROP INDEX IF EXISTS idx_property_snapshots_assessment_id');
  await knex.raw('DROP INDEX IF EXISTS idx_property_snapshots_customer_id');

  await knex.schema.dropTableIfExists('property_recommendation_events');
  await knex.schema.dropTableIfExists('property_recommendation_cards');
  await knex.schema.dropTableIfExists('property_snapshot_evidence');
  await knex.schema.dropTableIfExists('property_health_snapshots');
};
