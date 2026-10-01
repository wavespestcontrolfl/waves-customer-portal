/**
 * Email division rails (PR 1 of the marketing/lifecycle email lane): the ONE
 * ledger and outcomes table every future sender (lifecycle, nurture,
 * broadcast, alert) will write through. NOTHING calls these tables yet —
 * server/services/email-division/{eligibility,ledger}.js land in this same
 * PR but have no caller.
 *
 * marketing_email_ledger: one row per email attempt, RESERVED before send
 * (mirrors collections_contact_ledger's record-then-send doctrine).
 * idempotency_key is the retry-safety net (unique; a retry reuses the row).
 * marketing_email_outcomes: a later-computed read of what happened after a
 * SENT email, one row per ledger row.
 */
exports.up = async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  if (!(await knex.schema.hasTable('marketing_email_ledger'))) {
    await knex.schema.createTable('marketing_email_ledger', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable();
      t.string('stream', 20).notNullable()
        .checkIn(['lifecycle', 'nurture', 'broadcast', 'alert']);
      t.string('marketing_class', 20).notNullable()
        .checkIn(['relationship', 'marketing']);
      t.text('email_key').notNullable();
      t.text('idempotency_key').notNullable();
      t.text('recipient_email').notNullable();
      t.text('pest_key').nullable();
      t.string('status', 20).notNullable().defaultTo('reserved')
        .checkIn(['reserved', 'sent', 'skipped', 'failed']);
      t.text('reason').nullable();
      t.uuid('email_message_id').nullable();
      t.timestamp('reserved_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('sent_at', { useTz: true }).nullable();
      t.timestamps(true, true);

      t.unique(['idempotency_key']);
      t.index(['customer_id', 'created_at'], 'marketing_email_ledger_customer_created_idx');
      t.index(['customer_id', 'stream', 'sent_at'], 'marketing_email_ledger_customer_stream_sent_idx');
    });
    // Partial index (pest_key not null) — no knex builder shorthand for a
    // partial index, so it's raw, same convention as the rest of the schema.
    await knex.raw(`
      CREATE INDEX marketing_email_ledger_customer_pest_sent_idx
        ON marketing_email_ledger (customer_id, pest_key, sent_at)
        WHERE pest_key IS NOT NULL
    `);
  }

  if (!(await knex.schema.hasTable('marketing_email_outcomes'))) {
    await knex.schema.createTable('marketing_email_outcomes', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('ledger_id').notNullable().unique()
        .references('id').inTable('marketing_email_ledger').onDelete('CASCADE');
      t.uuid('customer_id').notNullable();
      t.string('outcome', 24).notNullable()
        .checkIn(['estimate_accepted', 'visit_booked', 'payment', 'renewal', 'referral', 'none']);
      t.timestamp('outcome_at', { useTz: true }).nullable();
      t.jsonb('evidence').notNullable().defaultTo('{}');
      t.timestamp('computed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());

      t.index(['customer_id'], 'marketing_email_outcomes_customer_id_idx');
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('marketing_email_outcomes');
  await knex.schema.dropTableIfExists('marketing_email_ledger');
};
