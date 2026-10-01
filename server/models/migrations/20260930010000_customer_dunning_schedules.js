'use strict';

/**
 * customer_dunning_schedules — one overdue-reminder schedule per customer
 * episode (dunning consolidation PR 1, inert foundations).
 *
 * A customer with 2+ actively-dunned open invoices gets ONE row here that
 * owns the reminder cadence; the per-invoice invoice_followup_sequences
 * rows stay untouched as control flags and membership state. Ownership is
 * dynamic: "an open schedule row exists for invoice.customer_id", which the
 * partial unique index below enforces (at most one open episode per
 * customer). Nothing reads or writes this table in PR 1; the engine that
 * does ships dark in later PRs (GATE_DUNNING_CUSTOMER_SCHEDULE*).
 *
 * The invoice set is never part of a schedule's identity (it is re-derived
 * from the pay page's authority at send time); seeded_from is only the
 * promotion snapshot, and the collections_contact_ledger reservation is the
 * persisted per-touch send snapshot.
 *
 * updated_at has a default but is stamped BY HAND on every update
 * (invoice-followups.js convention), so it is a plain timestamps() pair.
 */
const TABLE = 'customer_dunning_schedules';
const OPEN_INDEX = 'customer_dunning_schedules_open_uniq';
const DUE_INDEX = 'customer_dunning_schedules_status_next_touch_idx';
const EPISODE_UNIQUE = 'customer_dunning_schedules_customer_episode_uniq';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable(TABLE)) return;

  await knex.schema.createTable(TABLE, (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.integer('episode').notNullable(); // 1..n per customer
    // active | held | paused | autopay_hold | completed | released
    t.string('status', 20).notNullable();
    t.integer('step_index').notNullable().defaultTo(0); // next step to fire (config.stepsThrough90)
    t.timestamp('next_touch_at');
    t.timestamp('last_touch_at');
    t.integer('touches_sent').notNullable().defaultTo(0);
    t.timestamp('touch_claimed_at'); // 10 min TTL, same contract as the sequence row
    t.string('held_reason', 80);
    t.timestamp('held_since');
    t.timestamp('hold_alerted_at');
    t.text('paused_reason');
    t.uuid('paused_by_admin_id');
    // balance_cleared | final_notice_delivered | released_gate_off |
    // released_prereq_off | released_admin | customer_missing
    t.string('closed_reason', 40);
    t.timestamp('closed_at');
    t.timestamp('final_notice_at');
    t.specificType('link_digest', 'char(64)'); // mint-once cache for the current step
    t.text('link_url');
    // promotion snapshot: [{seq_id, invoice_id, step_index, next_touch_at, last_touch_at}]
    t.jsonb('seeded_from').notNullable().defaultTo('[]');
    t.timestamps(true, true);

    t.unique(['customer_id', 'episode'], EPISODE_UNIQUE);
    t.index(['status', 'next_touch_at'], DUE_INDEX);
  });

  // The ownership predicate: at most one open episode per customer.
  await knex.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${OPEN_INDEX} ON ${TABLE} (customer_id)
       WHERE status IN ('active','held','paused','autopay_hold')`,
  );
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${OPEN_INDEX}`);
  await knex.schema.dropTableIfExists(TABLE);
};
