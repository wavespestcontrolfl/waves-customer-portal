'use strict';

/**
 * Intelligence Bar gap reports — a structured record of what the bar could
 * not do, written the moment it happens (report_gap tool + the per-request
 * collector in server/services/agent-gap-reports.js), instead of relying on
 * the redacted query log (redacted whenever customer data is touched, i.e.
 * most of the time) or nothing at all.
 *
 * One row per distinct gap (deduped by `fingerprint`, a hash of the source,
 * kind, closest tool and the cleaned summary's word set — so word-order
 * variants of the same ask collapse together); a recurrence bumps
 * `occurrences` and `last_seen_at` instead of inserting a new row. `status`
 * tracks the owner's triage of the gap, independent of how many times the
 * bar has hit it.
 */
const TABLE = 'agent_gap_reports';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (t) => {
    t.bigIncrements('id').primary();
    t.string('source', 32).notNullable();
    t.string('kind', 24).notNullable();
    t.string('domain', 32);
    t.string('summary', 300).notNullable();
    t.string('attempted', 300);
    t.string('closest_tool', 64);
    t.string('fingerprint', 64).notNullable().unique();
    t.integer('occurrences').notNullable().defaultTo(1);
    t.string('status', 16).notNullable().defaultTo('new');
    t.timestamp('first_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['last_seen_at'], 'agent_gap_reports_last_seen_at_idx');
  });
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT agent_gap_reports_kind_check CHECK (kind IN ('missing_capability', 'tool_failure', 'blocked'))`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT agent_gap_reports_status_check CHECK (status IN ('new', 'building', 'fixed', 'by_design', 'dismissed'))`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
};
