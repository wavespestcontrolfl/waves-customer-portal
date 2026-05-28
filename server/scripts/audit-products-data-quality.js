require('dotenv').config();
const db = require('../models/db');

const PESTICIDE_CATEGORIES = new Set([
  'adjuvant',
  'bait',
  'fungicide',
  'herbicide',
  'igr',
  'insecticide',
  'mole bait',
  'mosquito',
  'pgr',
  'rodenticide',
  'termite bait',
  'termiticide',
]);
const PESTICIDE_CATEGORY_LIST = [...PESTICIDE_CATEGORIES];

async function main() {
  const rows = await db('products_catalog')
    .where(function missingRequiredFields() {
      this.whereRaw("NULLIF(TRIM(active_ingredient), '') IS NULL")
        .orWhereRaw("LOWER(TRIM(active_ingredient)) IN ('unknown - pending sds', 'unknown', 'pending sds')")
        .orWhere(function missingPesticideEpa() {
          this.whereIn(db.raw("LOWER(TRIM(COALESCE(category, '')))"), PESTICIDE_CATEGORY_LIST)
            .where(function missingEpaValue() {
              this.whereRaw("NULLIF(TRIM(epa_reg_number), '') IS NULL")
                .orWhereRaw("LOWER(TRIM(epa_reg_number)) IN ('n/a', 'na', 'pending', 'pending sds')");
            });
        })
        .orWhereRaw("NULLIF(TRIM(formulation), '') IS NULL")
        .orWhereRaw("LOWER(TRIM(formulation)) IN ('unspecified', 'unknown')");
    })
    .where(function activeOnly() {
      this.where('active', true).orWhereNull('active');
    })
    .select('id', 'name', 'category', 'active_ingredient', 'epa_reg_number', 'formulation')
    .orderBy('name');

  if (!rows.length) {
    console.log('All products have active_ingredient, epa_reg_number, and formulation.');
    return;
  }

  console.log(`Products missing label fields: ${rows.length}`);
  for (const row of rows) {
    console.log([
      row.id,
      row.name,
      row.category || '',
      `active=${row.active_ingredient || ''}`,
      `epa=${row.epa_reg_number || ''}`,
      `formulation=${row.formulation || ''}`,
    ].join('\t'));
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
