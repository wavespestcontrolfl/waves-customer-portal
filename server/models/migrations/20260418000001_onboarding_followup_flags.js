/**
 * Per-stage follow-up tracking for onboarding abandonment.
 *
 * When a customer accepts their estimate they get an onboarding link, but if
 * they don't finish the 4-step flow (payment → service confirmation →
 * property details → complete) there was no nudge. Link silently expires at
 * 7 days.
 *
 * This migration adds 3 flags — one per nudge stage — so each can fire at
 * most once per onboarding session:
 *   - followup_24h_sent       — started, not complete, 24-36h in
 *   - followup_72h_sent       — still not complete, 72-96h in
 *   - followup_expiring_sent  — expires_at is 1-2 days away
 */

const COLUMNS = [
  'followup_24h_sent',
  'followup_72h_sent',
  'followup_expiring_sent',
];

exports.up = async function (knex) {
  for (const col of COLUMNS) {
    const has = await knex.schema.hasColumn('onboarding_sessions', col);
    if (!has) {
      await knex.schema.alterTable('onboarding_sessions', (t) => {
        t.boolean(col).defaultTo(false);
      });
    }
  }
};

exports.down = async function (knex) {
  for (const col of COLUMNS) {
    const has = await knex.schema.hasColumn('onboarding_sessions', col);
    if (has) {
      await knex.schema.alterTable('onboarding_sessions', (t) => {
        t.dropColumn(col);
      });
    }
  }
};
