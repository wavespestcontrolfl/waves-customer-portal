'use strict';

/**
 * technicians.supply_store — the supplier branch this technician buys from
 * (owner 2026-11-27: "this tech's SiteOne location is the Sarasota branch, so
 * ideally all purchases for him would be based on this branch").
 *
 * Free text, for example "SiteOne Lakewood Ranch". NULL = not set. Nothing is
 * seeded: the Team tab fills it in. The weekly buy list
 * (procurement/weekly-buy-list.js) prints it as the store on each technician's
 * list; nothing else reads it yet. Additive and idempotent (hasColumn guard).
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('technicians', 'supply_store')) return;
  await knex.schema.alterTable('technicians', (t) => {
    t.string('supply_store', 120).nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('technicians', 'supply_store'))) return;
  await knex.schema.alterTable('technicians', (t) => {
    t.dropColumn('supply_store');
  });
};
