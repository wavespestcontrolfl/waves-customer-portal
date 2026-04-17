/**
 * Migration — Add stable integer `code` column to vendors
 *
 * Why: vendor names can change (rebrand, typo fix, full vendor swap). Seed
 * migrations that look up by name break silently when that happens. UUIDs
 * differ per environment so we can't hardcode those either.
 *
 * A stable integer code lets seed migrations reference a vendor by number.
 * The name/URL/type of that row can change freely — pricing stays linked via
 * the UUID FK, and the code→vendor mapping in .claude/vendor-codes.md stays
 * true regardless of rename.
 *
 * Codes 1–23 are assigned in the original insertion order from
 * 20260401000019_inventory.js (lines 50-73). Do not reorder.
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('vendors');
  if (!hasTable) return;

  const hasColumn = await knex.schema.hasColumn('vendors', 'code');
  if (!hasColumn) {
    await knex.schema.alterTable('vendors', (t) => {
      t.integer('code').unique().index();
    });
  }

  // Backfill in original insertion order from 20260401000019_inventory.js
  const codeMap = [
    [1,  'SiteOne'],
    [2,  'Amazon'],
    [3,  'Solutions Pest & Lawn'],
    [4,  'DoMyOwn'],
    [5,  'Forestry Distributing'],
    [6,  'Chemical Warehouse'],
    [7,  'Seed World USA'],
    [8,  'Intermountain Turf'],
    [9,  'Keystone Pest Solutions'],
    [10, 'Veseris'],
    [11, 'Ewing Outdoor Supply'],
    [12, 'GCI Turf Academy'],
    [13, 'DIY Pest Control'],
    [14, 'SprinklerJet'],
    [15, 'SeedBarn'],
    [16, 'Reinders'],
    [17, 'Sun Spot Supply'],
    [18, 'Golf Course Lawn Store'],
    [19, 'Geoponics'],
    [20, 'Target Specialty Products'],
    [21, 'BWI Companies'],
    [22, 'Helena Agri-Enterprises'],
    [23, 'TruGreen'],
  ];

  for (const [code, name] of codeMap) {
    await knex('vendors')
      .whereRaw('LOWER(name) = ?', [name.toLowerCase()])
      .update({ code });
  }
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable('vendors');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('vendors', 'code');
  if (hasColumn) {
    await knex.schema.alterTable('vendors', (t) => {
      t.dropColumn('code');
    });
  }
};
