/**
 * Correct the active ingredients of Roundup QuikPro SC in the product catalog.
 *
 * The catalog row said "Glyphosate". The product on the truck is Roundup QuikPro SC Total (EPA Reg. No. 432-1532): glyphosate,
 * diquat and indaziflam (the indaziflam is why the add-on is hard surfaces and bare ground only). server/data/pricing.csv was
 * corrected in this PR, but the pricing import fills an active ingredient only when the stored one is a placeholder, so a row
 * that already says "Glyphosate" would keep it. The compliance ledger copies this column onto every application record
 * (ComplianceService.createComplianceRecords), so the FDACS record of a hard-surface weed treatment would list one active
 * ingredient of three.
 *
 * Guarded: only a row named exactly "Roundup QuikPro SC" whose active ingredient is still empty or exactly "Glyphosate" is
 * changed. A row an operator already corrected or reworded is left as it is. Idempotent. down() changes nothing: the old
 * value was wrong, and a rollback must not put a wrong ingredient list back on a state record's source.
 */
const NAME = 'roundup quikpro sc';
const CORRECT = 'Glyphosate + Diquat + Indaziflam';

const stale = (value) => value == null || String(value).trim() === '' || String(value).trim().toLowerCase() === 'glyphosate';

exports.NAME = NAME;
exports.CORRECT = CORRECT;
exports.stale = stale;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'active_ingredient'))) return;
  const rows = await knex('products_catalog').whereRaw('lower(trim(name)) = ?', [NAME]).select('id', 'active_ingredient');
  for (const row of rows) {
    if (!stale(row.active_ingredient)) continue;
    await knex('products_catalog').where({ id: row.id }).update({ active_ingredient: CORRECT });
  }
};

exports.down = async function down() {};
