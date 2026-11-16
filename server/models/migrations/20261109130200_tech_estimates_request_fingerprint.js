'use strict';

/**
 * tech_estimates.request_fingerprint: the SHA-256 of the request that made the estimate (the keys the technician
 * estimate tool reads from the phone, plus the price digest). services/tech-estimate-save.js writes it with the row.
 * A retry with the same draft id is answered from the stored rows when the fingerprint matches, before anything is
 * priced again, and is refused when it does not (one draft id is one quote). Nullable: a row without one matches no
 * request. Additive and idempotent (guards both ways). 20261109130000_tech_estimates.js is not edited.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('tech_estimates'))) return;
  if (await knex.schema.hasColumn('tech_estimates', 'request_fingerprint')) return;
  await knex.schema.alterTable('tech_estimates', (t) => { t.string('request_fingerprint', 64).nullable(); });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('tech_estimates'))) return;
  if (!(await knex.schema.hasColumn('tech_estimates', 'request_fingerprint'))) return;
  await knex.schema.alterTable('tech_estimates', (t) => { t.dropColumn('request_fingerprint'); });
};
