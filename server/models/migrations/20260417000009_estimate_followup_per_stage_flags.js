/**
 * Per-stage follow-up tracking for estimates.
 *
 * Previously estimate-follow-up.js shared a single `follow_up_count` counter
 * across all 4 stages (24h unviewed / 48h viewed-not-accepted / 5d final /
 * expiring-in-3d). Because every stage gated on `COALESCE(follow_up_count, 0) < 1`,
 * the first stage that fired locked out the remaining three — so a customer
 * who got the 24h nudge but never opened the estimate would never receive the
 * expiry reminder.
 *
 * This migration adds one boolean flag per stage so each can fire independently.
 * `follow_up_count` / `last_follow_up_at` stay for historical data.
 */

const COLUMNS = [
  'followup_unviewed_sent',
  'followup_viewed_sent',
  'followup_final_sent',
  'followup_expiring_sent',
];

exports.up = async function (knex) {
  for (const col of COLUMNS) {
    const has = await knex.schema.hasColumn('estimates', col);
    if (!has) {
      await knex.schema.alterTable('estimates', (t) => {
        t.boolean(col).defaultTo(false);
      });
    }
  }
};

exports.down = async function (knex) {
  for (const col of COLUMNS) {
    const has = await knex.schema.hasColumn('estimates', col);
    if (has) {
      await knex.schema.alterTable('estimates', (t) => {
        t.dropColumn(col);
      });
    }
  }
};
