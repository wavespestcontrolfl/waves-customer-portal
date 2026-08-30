/**
 * Visit groups — Phase 1 data model (docs/design/visit-group-scope.md rev 5,
 * owner-approved 2026-08-29). One parent visit per physical stop; child
 * scheduled_services keep their own records, reports, and invoices.
 *
 * DARK: nothing creates rows in these tables until GATE_VISIT_GROUPS is on
 * and the stamping PR lands. Additive and inert to all existing code.
 *
 * Identity: `visit_id` is the durable identity. `stop_base_key`
 * (`<property_or_customer>:<date>`) + `stop_seq` only serialise concurrent
 * creation/join/split for one property-day; uniqueness spans ALL lifecycle
 * states so a closed visit's key is never re-minted. Reschedules recompute
 * the base key under both stop locks (ordered) — see visit-groups.js.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('service_visits'))) {
    await knex.schema.createTable('service_visits', (t) => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.uuid('property_id').references('id').inTable('customer_properties').onDelete('SET NULL');
      t.date('scheduled_date').notNullable();
      t.time('window_start');
      t.time('window_end');
      t.string('stop_base_key', 120).notNullable();
      t.integer('stop_seq').notNullable().defaultTo(1);
      t.uuid('technician_id').references('id').inTable('technicians');
      t.string('group_family', 60);
      t.string('status', 20).notNullable().defaultTo('open');
      t.integer('behavior_version').notNullable().defaultTo(1);
      t.string('communication_mode', 20).notNullable().defaultTo('grouped');
      t.string('billing_strategy', 30);
      t.boolean('billing_hold').notNullable().defaultTo(false);
      t.timestamp('billing_frozen_at');
      t.timestamp('en_route_at');
      t.timestamp('arrived_at');
      t.timestamp('completion_submitted_at');
      t.timestamp('closed_at');
      t.string('close_reason', 40);
      t.string('summary_token_hash', 64).unique();
      t.binary('summary_token_enc');
      t.timestamp('summary_token_issued_at');
      t.timestamp('summary_token_revoked_at');
      t.uuid('review_request_id');
      t.string('payment_intent_id', 64);
      t.string('created_by', 80).notNullable();
      t.timestamps(true, true);
      t.unique(['stop_base_key', 'stop_seq'], { indexName: 'service_visits_stop_identity_uniq' });
      t.index(['customer_id', 'scheduled_date']);
      t.index(['status', 'scheduled_date']);
    });
    await knex.raw(`
      ALTER TABLE service_visits
        ADD CONSTRAINT service_visits_status_chk
        CHECK (status IN ('open', 'closing', 'closed', 'dissolved'))
    `);
  }

  if (!(await knex.schema.hasTable('visit_effects'))) {
    await knex.schema.createTable('visit_effects', (t) => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.uuid('visit_id').notNullable().references('id').inTable('service_visits').onDelete('CASCADE');
      t.string('effect_type', 40).notNullable();
      t.string('dedupe_key', 160).notNullable();
      t.string('status', 20).notNullable().defaultTo('pending');
      t.string('provider_id', 120);
      t.integer('attempts').notNullable().defaultTo(0);
      t.timestamp('scheduled_at');
      t.timestamp('claimed_at');
      t.timestamp('sent_at');
      t.integer('payload_version').notNullable().defaultTo(1);
      t.text('last_error');
      t.timestamps(true, true);
      t.unique(['visit_id', 'effect_type', 'dedupe_key'], { indexName: 'visit_effects_dedupe_uniq' });
      t.index(['status', 'scheduled_at']);
    });
    await knex.raw(`
      ALTER TABLE visit_effects
        ADD CONSTRAINT visit_effects_status_chk
        CHECK (status IN ('pending', 'claimed', 'sent', 'failed', 'suppressed', 'unknown_delivery'))
    `);
    await knex.raw(`
      ALTER TABLE visit_effects
        ADD CONSTRAINT visit_effects_type_chk
        CHECK (effect_type IN (
          'reminder_72h', 'reminder_24h', 'tracker_en_route', 'tracker_arrived',
          'completion_sms', 'completion_email', 'billing_ready', 'review_ask',
          'visit_payment', 'visit_receipt', 'payment_failure'
        ))
    `);
  }

  if (!(await knex.schema.hasTable('visit_completion_packets'))) {
    await knex.schema.createTable('visit_completion_packets', (t) => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.uuid('visit_id').notNullable().references('id').inTable('service_visits').onDelete('CASCADE');
      t.string('idempotency_key', 120).notNullable().unique();
      t.string('request_hash', 64).notNullable();
      t.jsonb('payload').notNullable();
      t.string('status', 20).notNullable().defaultTo('accepted');
      t.text('error');
      t.timestamps(true, true);
      t.index(['visit_id']);
      t.index(['status']);
    });
    await knex.raw(`
      ALTER TABLE visit_completion_packets
        ADD CONSTRAINT visit_completion_packets_status_chk
        CHECK (status IN ('accepted', 'processing', 'done', 'failed'))
    `);
  }

  if (!(await knex.schema.hasTable('visit_completion_packet_items'))) {
    await knex.schema.createTable('visit_completion_packet_items', (t) => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.uuid('packet_id').notNullable().references('id').inTable('visit_completion_packets').onDelete('CASCADE');
      t.uuid('scheduled_service_id').notNullable().references('id').inTable('scheduled_services').onDelete('CASCADE');
      t.string('derived_idempotency_key', 160).notNullable();
      t.string('status', 20).notNullable().defaultTo('pending');
      t.integer('attempt_count').notNullable().defaultTo(0);
      t.timestamp('started_at');
      t.timestamp('completed_at');
      t.uuid('service_record_id');
      t.uuid('invoice_id');
      t.text('last_error');
      t.timestamps(true, true);
      t.unique(['packet_id', 'scheduled_service_id'], { indexName: 'visit_packet_items_uniq' });
    });
    await knex.raw(`
      ALTER TABLE visit_completion_packet_items
        ADD CONSTRAINT visit_packet_items_status_chk
        CHECK (status IN ('pending', 'processing', 'done', 'failed'))
    `);
  }

  if (!(await knex.schema.hasColumn('scheduled_services', 'visit_id'))) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.uuid('visit_id').references('id').inTable('service_visits').onDelete('SET NULL');
    });
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_scheduled_services_visit_id
        ON scheduled_services (visit_id) WHERE visit_id IS NOT NULL
    `);
  }

  if (await knex.schema.hasTable('services')) {
    if (!(await knex.schema.hasColumn('services', 'groupable'))) {
      await knex.schema.alterTable('services', (t) => {
        t.boolean('groupable').notNullable().defaultTo(false);
      });
    }
    if (!(await knex.schema.hasColumn('services', 'group_family'))) {
      await knex.schema.alterTable('services', (t) => {
        t.string('group_family', 60);
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('scheduled_services', 'visit_id')) {
    await knex.raw('DROP INDEX IF EXISTS idx_scheduled_services_visit_id');
    await knex.schema.alterTable('scheduled_services', (t) => t.dropColumn('visit_id'));
  }
  if (await knex.schema.hasTable('services')) {
    if (await knex.schema.hasColumn('services', 'group_family')) {
      await knex.schema.alterTable('services', (t) => t.dropColumn('group_family'));
    }
    if (await knex.schema.hasColumn('services', 'groupable')) {
      await knex.schema.alterTable('services', (t) => t.dropColumn('groupable'));
    }
  }
  await knex.schema.dropTableIfExists('visit_completion_packet_items');
  await knex.schema.dropTableIfExists('visit_completion_packets');
  await knex.schema.dropTableIfExists('visit_effects');
  await knex.schema.dropTableIfExists('service_visits');
};
