'use strict';

/**
 * tech_estimates, step 4 (GATE_TECH_ESTIMATES, owner 2026-11-09): the send from the phone.
 *  - text_request_confirmed_at: the time the technician confirmed that a NEW person (no customer id) asked for the
 *    estimate by text. The portal hands it to the text as its consent basis. Null for a customer on his route.
 *  - sent_by_technician_at: the time the shared estimate send delivered the text for him.
 * Additive and idempotent (hasColumn guards both ways).
 */
const COLUMNS = ['text_request_confirmed_at', 'sent_by_technician_at'];

exports.up = async function up(knex) {
  for (const name of COLUMNS) {
    if (await knex.schema.hasColumn('tech_estimates', name)) continue;
    await knex.schema.alterTable('tech_estimates', (t) => { t.timestamp(name, { useTz: true }).nullable(); });
  }
};

exports.down = async function down(knex) {
  for (const name of COLUMNS) {
    if (!(await knex.schema.hasColumn('tech_estimates', name))) continue;
    await knex.schema.alterTable('tech_estimates', (t) => { t.dropColumn(name); });
  }
};
