'use strict';

/**
 * Visit day on the Lock Screen (GATE_VISIT_LIVE_ACTIVITY, owner 2026-11-11): what an iPhone reports so the
 * server can start a Lock Screen card on it.
 *
 * push_subscriptions already holds one row per app install. Three nullable columns ride on that row, so the
 * card follows the row's whole life (sign-out, notification permission off, a property switch):
 *   live_activity_start_token  the phone's ActivityKit push-to-start token; NULL = no card on this phone
 *   live_activity_os_major     its iOS major version (channel updates need 18)
 *   live_activity_token_at     when the phone last reported
 * Written only by POST /api/push/live-activity-token. Additive and idempotent.
 */
const COLUMNS = {
  live_activity_start_token: (t) => t.text('live_activity_start_token'),
  live_activity_os_major: (t) => t.integer('live_activity_os_major'),
  live_activity_token_at: (t) => t.timestamp('live_activity_token_at', { useTz: true }),
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('push_subscriptions'))) return;
  for (const [column, add] of Object.entries(COLUMNS)) {
    if (await knex.schema.hasColumn('push_subscriptions', column)) continue;
    await knex.schema.alterTable('push_subscriptions', (t) => { add(t); });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('push_subscriptions'))) return;
  for (const column of Object.keys(COLUMNS)) {
    if (!(await knex.schema.hasColumn('push_subscriptions', column))) continue;
    await knex.schema.alterTable('push_subscriptions', (t) => { t.dropColumn(column); });
  }
};
