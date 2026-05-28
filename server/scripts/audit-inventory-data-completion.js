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

const normalize = (value) => String(value || '').trim().toLowerCase();
const blank = (value) => normalize(value) === '';
const placeholder = (value, values) => values.has(normalize(value));

function isPesticide(row) {
  return PESTICIDE_CATEGORIES.has(normalize(row.category));
}

function missingLabelFields(row) {
  const missing = [];
  if (blank(row.active_ingredient) || placeholder(row.active_ingredient, new Set(['unknown - pending sds', 'unknown', 'pending sds']))) {
    missing.push('active_ingredient');
  }
  if (isPesticide(row) && (blank(row.epa_reg_number) || placeholder(row.epa_reg_number, new Set(['n/a', 'na', 'pending', 'pending sds'])))) {
    missing.push('epa_reg_number');
  }
  if (blank(row.formulation) || placeholder(row.formulation, new Set(['unspecified', 'unknown']))) {
    missing.push('formulation');
  }
  return missing;
}

function missingRegistryFields(row) {
  const missing = [];
  if (blank(row.customer_visibility)) missing.push('customer_visibility');
  if (blank(row.content_status)) missing.push('content_status');
  if (['portal_only', 'public'].includes(normalize(row.customer_visibility)) && blank(row.portal_summary)) {
    missing.push('portal_summary');
  }
  if (normalize(row.customer_visibility) === 'public' && blank(row.public_summary)) {
    missing.push('public_summary');
  }
  return missing;
}

async function main() {
  const rows = await db('products_catalog')
    .select(
      'id',
      'name',
      'category',
      'active',
      'active_ingredient',
      'epa_reg_number',
      'formulation',
      'needs_pricing',
      'best_price',
      'inventory_on_hand',
      'inventory_unit',
      'low_stock_threshold',
      'customer_visibility',
      'content_status',
      'portal_summary',
      'public_summary',
    )
    .orderBy('name');

  const activeRows = rows.filter((row) => row.active !== false);
  const labelGaps = activeRows
    .map((row) => ({ row, missing: missingLabelFields(row) }))
    .filter((entry) => entry.missing.length);
  const registryGaps = activeRows
    .map((row) => ({ row, missing: missingRegistryFields(row) }))
    .filter((entry) => entry.missing.length);
  const pricingGaps = activeRows.filter((row) => row.needs_pricing === true || row.best_price == null);
  const stockGaps = activeRows.filter((row) => row.inventory_on_hand == null);
  const stockUnitGaps = activeRows.filter((row) => row.inventory_on_hand != null && blank(row.inventory_unit));
  const lowStockThresholdGaps = activeRows.filter((row) => row.inventory_on_hand != null && row.low_stock_threshold == null);

  console.log('Inventory data completion audit');
  console.log(`Products: ${rows.length} total, ${activeRows.length} active`);
  console.log(`Label gaps: ${labelGaps.length}`);
  console.log(`Registry/content gaps: ${registryGaps.length}`);
  console.log(`Pricing gaps: ${pricingGaps.length}`);
  console.log(`Stock count gaps: ${stockGaps.length}`);
  console.log(`Stock unit gaps: ${stockUnitGaps.length}`);
  console.log(`Low-stock threshold gaps: ${lowStockThresholdGaps.length}`);

  function printSection(title, entries, format) {
    if (!entries.length) return;
    console.log(`\n${title}`);
    for (const entry of entries) console.log(format(entry));
  }

  printSection('Label gaps', labelGaps, ({ row, missing }) => (
    `${row.name}\t${row.category || ''}\tmissing=${missing.join(',')}\tactive=${row.active_ingredient || ''}\tepa=${row.epa_reg_number || ''}\tformulation=${row.formulation || ''}`
  ));

  printSection('Registry/content gaps', registryGaps, ({ row, missing }) => (
    `${row.name}\t${row.category || ''}\tmissing=${missing.join(',')}\tvisibility=${row.customer_visibility || ''}\tstatus=${row.content_status || ''}`
  ));

  printSection('Pricing gaps', pricingGaps, (row) => (
    `${row.name}\t${row.category || ''}\tneeds_pricing=${row.needs_pricing}\tbest_price=${row.best_price || ''}`
  ));

  if (stockGaps.length) {
    console.log('\nStock count gaps');
    console.log(`${stockGaps.length} active products have no inventory_on_hand value. These require a physical count or vendor import.`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
