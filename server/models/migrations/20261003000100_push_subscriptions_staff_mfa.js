/**
 * push_subscriptions.staff_mfa — whether the staff session that registered
 * the device had passed the two-step code (GATE_ADMIN_MFA). While the gate is
 * on, staff push lookups skip an enrolled account's devices registered
 * without it (server/services/push-notifications.js staffMfaPushFilter).
 * Existing rows default to false: with the gate on, an enrolled account's
 * devices re-register from a two-step session (enrolling already deactivates
 * every earlier registration).
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('push_subscriptions')
    && !(await knex.schema.hasColumn('push_subscriptions', 'staff_mfa'))) {
    await knex.schema.alterTable('push_subscriptions', (t) => {
      t.boolean('staff_mfa').notNullable().defaultTo(false);
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('push_subscriptions')
    && await knex.schema.hasColumn('push_subscriptions', 'staff_mfa')) {
    await knex.schema.alterTable('push_subscriptions', (t) => {
      t.dropColumn('staff_mfa');
    });
  }
};
