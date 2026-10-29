/**
 * customers.building_use — what the account's site is used for, which decides Florida sales tax on its pest work
 * (Rule 12A-1.009): 'residential' (homes, apartments, condos and their common areas: not taxed, whoever pays) or
 * 'nonresidential' (a business building: taxed). NULL = not recorded, which is every account before 2026-10-28.
 * Written when a commercial proposal with a picked building use is won (proposal-win recordProposalBuildingUse);
 * TaxCalculator reads it behind GATE_BUILDING_USE_TAX. Additive and nullable: no backfill.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('customers', 'building_use')) return;
  await knex.schema.alterTable('customers', (t) => {
    t.string('building_use', 20);
  });
  await knex.raw(
    "ALTER TABLE customers ADD CONSTRAINT customers_building_use_check CHECK (building_use IS NULL OR building_use IN ('residential', 'nonresidential'))",
  );
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('customers', 'building_use'))) return;
  await knex.raw('ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_building_use_check');
  await knex.schema.alterTable('customers', (t) => {
    t.dropColumn('building_use');
  });
};
