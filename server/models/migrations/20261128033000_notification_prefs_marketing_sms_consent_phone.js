'use strict';

/**
 * Binds promotional SMS opt-in on `notification_prefs` to the exact canonical E.164 phone
 * number on file when the customer opted into SMS marketing (GATE_NEW_LEAD_DRIP_EXTENDED,
 * owner 2026-11-27). Ensures a later Customer 360 phone replacement can never inherit the
 * previous number's SMS promotional consent.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('notification_prefs');
  if (!hasTable) return;
  const hasCol = await knex.schema.hasColumn('notification_prefs', 'marketing_sms_consent_phone');
  if (!hasCol) {
    await knex.schema.alterTable('notification_prefs', (t) => {
      t.string('marketing_sms_consent_phone', 32).nullable();
    });
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('notification_prefs');
  if (!hasTable) return;
  const hasCol = await knex.schema.hasColumn('notification_prefs', 'marketing_sms_consent_phone');
  if (hasCol) {
    await knex.schema.alterTable('notification_prefs', (t) => {
      t.dropColumn('marketing_sms_consent_phone');
    });
  }
};
