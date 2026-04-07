/**
 * Seed service-product mappings (COGS) based on Waves protocols.
 * Maps products to service types with usage rates for margin tracking.
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('service_product_usage');
  if (!hasTable) return;

  // Check if already seeded
  const existing = await knex('service_product_usage').count('* as count').first();
  if (parseInt(existing.count) > 0) return;

  // Get product IDs by name
  const products = await knex('products_catalog').select('id', 'name');
  const byName = {};
  products.forEach(p => { byName[p.name.toLowerCase()] = p.id; });

  const find = (name) => {
    const lower = name.toLowerCase();
    // Exact match first
    if (byName[lower]) return byName[lower];
    // Partial match
    for (const [key, id] of Object.entries(byName)) {
      if (key.includes(lower) || lower.includes(key)) return id;
    }
    return null;
  };

  const mappings = [
    // ── QUARTERLY PEST CONTROL ──
    { service_type: 'Quarterly Pest Control', product: 'Demand CS', usage_amount: 1.6, usage_unit: 'oz', usage_per_1000sf: 0.4, is_primary: true, notes: 'Exterior perimeter band' },
    { service_type: 'Quarterly Pest Control', product: 'Advion WDG', usage_amount: 0.5, usage_unit: 'oz', usage_per_1000sf: null, is_primary: false, notes: 'Granular in beds + bait stations' },
    { service_type: 'Quarterly Pest Control', product: 'Alpine WSG', usage_amount: 0.5, usage_unit: 'packets', usage_per_1000sf: null, is_primary: true, notes: 'Interior baseboards + entry points' },

    // ── BI-MONTHLY PEST CONTROL ──
    { service_type: 'Bi-Monthly Pest Control', product: 'Demand CS', usage_amount: 1.6, usage_unit: 'oz', usage_per_1000sf: 0.4, is_primary: true, notes: 'Exterior perimeter band' },
    { service_type: 'Bi-Monthly Pest Control', product: 'Alpine WSG', usage_amount: 0.5, usage_unit: 'packets', usage_per_1000sf: null, is_primary: true, notes: 'Interior treatment' },

    // ── MOSQUITO BARRIER TREATMENT ──
    { service_type: 'Mosquito Treatment', product: 'Cyzmic CS', usage_amount: 3.0, usage_unit: 'oz', usage_per_1000sf: 0.5, is_primary: true, notes: 'Barrier spray — foliage, fence, lanai perimeter' },
    { service_type: 'Mosquito Treatment', product: 'Tekko Pro', usage_amount: 1.0, usage_unit: 'oz', usage_per_1000sf: null, is_primary: true, notes: 'IGR — standing water, planters, drains' },

    // ── LAWN CARE — Track A: St. Augustine Full Sun (core products across year) ──
    { service_type: 'Lawn Care', product: 'Celsius WG', usage_amount: 0.057, usage_unit: 'oz', usage_per_1000sf: 0.057, is_primary: true, notes: 'Post-emergent herbicide (max 3x/year) — Tracks A/B' },
    { service_type: 'Lawn Care', product: 'Prodiamine', usage_amount: 3.0, usage_unit: 'oz', usage_per_1000sf: 0.75, is_primary: true, notes: 'Pre-emergent — fall/winter application' },
    { service_type: 'Lawn Care', product: 'Acelepryn', usage_amount: 0.46, usage_unit: 'oz', usage_per_1000sf: 0.046, is_primary: true, notes: 'Preventive insecticide — chinch, grubs — V4 (Apr)' },
    { service_type: 'Lawn Care', product: 'SpeedZone Southern', usage_amount: 1.5, usage_unit: 'oz', usage_per_1000sf: 0.375, is_primary: false, notes: 'Broadleaf weed killer — weather gate >90°F' },
    { service_type: 'Lawn Care', product: 'Headway', usage_amount: 3.0, usage_unit: 'oz', usage_per_1000sf: 0.75, is_primary: false, notes: 'Fungicide FRAC 11+3 — V1 (Jan)' },
    { service_type: 'Lawn Care', product: 'Medallion', usage_amount: 0.5, usage_unit: 'oz', usage_per_1000sf: 0.25, is_primary: false, notes: 'Fungicide FRAC 7 — V2 (Feb) rotation' },
    { service_type: 'Lawn Care', product: 'K-Flow', usage_amount: 4.0, usage_unit: 'oz', usage_per_1000sf: 1.0, is_primary: false, notes: '0-0-25 potassium — root strength' },
    { service_type: 'Lawn Care', product: 'Dismiss', usage_amount: 0.5, usage_unit: 'oz', usage_per_1000sf: 0.125, is_primary: false, notes: 'Sedge control — conditional' },

    // ── TREE & SHRUB v3 (6-8 applications/year) ──
    { service_type: 'Tree & Shrub', product: 'Dominion 2L', usage_amount: 1.0, usage_unit: 'oz', usage_per_1000sf: null, is_primary: true, notes: 'Systemic insecticide — root drench for scale/whitefly' },
    { service_type: 'Tree & Shrub', product: 'Headway G', usage_amount: 3.0, usage_unit: 'lb', usage_per_1000sf: 3.0, is_primary: false, notes: 'Granular fungicide for ornamental beds' },
    { service_type: 'Tree & Shrub', product: 'Fertilome Systemic', usage_amount: 2.0, usage_unit: 'oz', usage_per_1000sf: null, is_primary: false, notes: 'Systemic drench — palms and ornamentals' },
    { service_type: 'Tree & Shrub', product: 'Talstar', usage_amount: 1.0, usage_unit: 'oz', usage_per_1000sf: null, is_primary: false, notes: 'Contact insecticide — mites, caterpillars' },

    // ── TERMITE BAIT ──
    { service_type: 'Termite Bait', product: 'Trelona ATBS', usage_amount: 1, usage_unit: 'station', usage_per_1000sf: null, is_primary: true, notes: 'Bait station — 1 per 10 linear ft perimeter' },

    // ── RODENT ──
    { service_type: 'Rodent Bait', product: 'Contrac Blox', usage_amount: 4, usage_unit: 'blocks', usage_per_1000sf: null, is_primary: true, notes: '2-4 blocks per tamper-resistant station' },
    { service_type: 'Rodent Trapping', product: 'Trapper T-Rex', usage_amount: 6, usage_unit: 'traps', usage_per_1000sf: null, is_primary: true, notes: '6 snap traps per attic/garage placement' },

    // ── FLEA TREATMENT ──
    { service_type: 'Flea Treatment', product: 'Demand CS', usage_amount: 2.0, usage_unit: 'oz', usage_per_1000sf: 0.5, is_primary: true, notes: 'Interior + exterior broadcast' },

    // ── COCKROACH TREATMENT ──
    { service_type: 'Cockroach Treatment', product: 'Advion Gel', usage_amount: 1, usage_unit: 'tube', usage_per_1000sf: null, is_primary: true, notes: 'Gel bait — kitchen, bath, utility areas' },
    { service_type: 'Cockroach Treatment', product: 'Alpine WSG', usage_amount: 1.0, usage_unit: 'packets', usage_per_1000sf: null, is_primary: true, notes: 'Crack & crevice treatment' },
  ];

  for (const m of mappings) {
    const productId = find(m.product);
    if (!productId) continue; // Skip if product not in catalog

    await knex('service_product_usage').insert({
      service_type: m.service_type,
      product_id: productId,
      usage_amount: m.usage_amount,
      usage_unit: m.usage_unit,
      usage_per_1000sf: m.usage_per_1000sf,
      is_primary: m.is_primary,
      notes: m.notes,
    }).catch(() => {}); // Ignore duplicates
  }
};

exports.down = async function (knex) {
  await knex('service_product_usage').del();
};
