/**
 * Migration — Seed missing specialty & COGS products into products_catalog
 *
 * These products are referenced by:
 *   - pricing engine constants.js (hardcoded costs for Bora-Care, Termidor SC,
 *     Termidor Foam, Advance/Trelona bait stations)
 *   - service_product_usage COGS seed (Cyzmic CS, Contrac Blox, Trapper T-Rex,
 *     Trelona ATBS, Advion WDG)
 *
 * Without catalog rows the cost-input approval queue has nothing to propagate
 * from, and job-costing calculates $0 material cost for these services.
 *
 * Also prices "present but unpriced" products (Demand CS, Tekko Pro) and
 * patches the service_product_usage fuzzy-match misses.
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('products_catalog');
  if (!hasTable) return;

  // Helper: insert if not exists (by name)
  async function ensureProduct(product) {
    const existing = await knex('products_catalog')
      .whereRaw('LOWER(name) = ?', [product.name.toLowerCase()])
      .first();
    if (existing) return existing.id;
    const [row] = await knex('products_catalog').insert(product).returning('id');
    return row.id || row;
  }

  // Helper: upsert vendor pricing by stable vendor code
  // Vendor codes are defined in migration 20260417000000_add_vendor_code.js
  // Reference table: .claude/vendor-codes.md
  async function ensureVendorPrice(productId, vendorCode, price, quantity, unit, url) {
    const vendor = await knex('vendors').where({ code: vendorCode }).first();
    if (!vendor) return;
    const existing = await knex('vendor_pricing').where({ product_id: productId, vendor_id: vendor.id }).first();
    const data = {
      product_id: productId,
      vendor_id: vendor.id,
      price,
      quantity,
      unit,
      vendor_product_url: url || null,
      is_best_price: true,
      last_checked_at: new Date(),
    };
    if (existing) {
      await knex('vendor_pricing').where({ id: existing.id }).update(data);
    } else {
      await knex('vendor_pricing').insert(data);
    }
    // Update products_catalog best_price (resolve current display name from vendor row)
    await knex('products_catalog').where({ id: productId }).update({
      best_price: price,
      best_vendor: vendor.name,
      needs_pricing: false,
    });
  }

  // ── 1. SPECIALTY PRODUCTS (missing from catalog entirely) ──

  const boracareId = await ensureProduct({
    name: 'Bora-Care',
    category: 'termiticide',
    subcategory: 'Borate wood treatment',
    active_ingredient: 'Disodium Octaborate Tetrahydrate',
    formulation: 'liquid',
    container_size: '1 gal',
    needs_pricing: false,
    best_price: 91.98,
    best_vendor: 'Solutions Pest & Lawn',
  });
  await ensureVendorPrice(boracareId, 3, 91.98, '1 gal', 'gal',
    'https://www.solutionsstores.com/bora-care'); // code 3 = Solutions Pest & Lawn

  const termidorScId = await ensureProduct({
    name: 'Termidor SC',
    category: 'termiticide',
    subcategory: 'Non-repellent termiticide',
    active_ingredient: 'Fipronil 9.1%',
    moa_group: 'Group 2B',
    formulation: 'SC',
    container_size: '78 oz',
    needs_pricing: false,
    best_price: 152.10,
    best_vendor: 'SiteOne',
  });
  await ensureVendorPrice(termidorScId, 1, 152.10, '78 oz', 'oz', null); // code 1 = SiteOne

  const termidorFoamId = await ensureProduct({
    name: 'Termidor Foam',
    category: 'termiticide',
    subcategory: 'Foam termiticide',
    active_ingredient: 'Fipronil 0.005%',
    moa_group: 'Group 2B',
    formulation: 'foam',
    container_size: '21 oz can',
    needs_pricing: false,
    best_price: 39.08,
    best_vendor: 'Solutions Pest & Lawn',
  });
  await ensureVendorPrice(termidorFoamId, 3, 39.08, '21 oz', 'oz', null); // code 3 = Solutions Pest & Lawn

  const advanceBaitId = await ensureProduct({
    name: 'Advance Termite Bait Station',
    category: 'termiticide',
    subcategory: 'In-ground bait station',
    active_ingredient: 'Diflubenzuron',
    formulation: 'bait',
    container_size: '1 station',
    needs_pricing: false,
    best_price: 14.00,
    best_vendor: 'Solutions Pest & Lawn',
  });
  await ensureVendorPrice(advanceBaitId, 3, 14.00, '1 station', 'each', null); // code 3 = Solutions Pest & Lawn

  const trelonaId = await ensureProduct({
    name: 'Trelona ATBS Bait Station',
    category: 'termiticide',
    subcategory: 'In-ground bait station',
    active_ingredient: 'Novaluron',
    formulation: 'bait',
    container_size: '1 station',
    needs_pricing: false,
    best_price: 24.00,
    best_vendor: 'Solutions Pest & Lawn',
  });
  await ensureVendorPrice(trelonaId, 3, 24.00, '1 station', 'each', null); // code 3 = Solutions Pest & Lawn

  const cyzmicId = await ensureProduct({
    name: 'Cyzmic CS',
    category: 'insecticide',
    subcategory: 'Residual pyrethroid (microencapsulated)',
    active_ingredient: 'Lambda-cyhalothrin 9.7%',
    moa_group: 'Group 3A',
    formulation: 'CS',
    container_size: '32 oz',
    default_rate: '0.5',
    default_unit: 'oz/1000sf',
    needs_pricing: true,
  });

  const contracId = await ensureProduct({
    name: 'Contrac Blox',
    category: 'rodenticide',
    subcategory: 'Anticoagulant bait block',
    active_ingredient: 'Bromadiolone 0.005%',
    formulation: 'bait',
    container_size: '18 lb pail',
    needs_pricing: true,
  });

  const trapperTrexId = await ensureProduct({
    name: 'Trapper T-Rex Rat Snap Trap',
    category: 'rodent_trap',
    subcategory: 'Mechanical snap trap',
    formulation: 'trap',
    container_size: '1 trap',
    needs_pricing: true,
  });

  const advionGelId = await ensureProduct({
    name: 'Advion Cockroach Gel Bait',
    category: 'bait',
    subcategory: 'Cockroach gel bait',
    active_ingredient: 'Indoxacarb 0.6%',
    moa_group: 'Group 22A',
    formulation: 'gel',
    container_size: '4 x 30g tubes',
    needs_pricing: true,
  });

  // ── 2. PRICE "PRESENT BUT UNPRICED" PRODUCTS ──

  // Demand CS — in catalog from dispatch seed, but $0 in CSV
  const demandCs = await knex('products_catalog')
    .whereRaw("LOWER(name) LIKE '%demand cs%'")
    .first();
  if (demandCs && (!demandCs.best_price || parseFloat(demandCs.best_price) === 0)) {
    await knex('products_catalog').where({ id: demandCs.id }).update({
      needs_pricing: true,
    });
  }

  // Tekko Pro IGR — in catalog from dispatch seed, $0 in CSV
  const tekkoPro = await knex('products_catalog')
    .whereRaw("LOWER(name) LIKE '%tekko pro%'")
    .first();
  if (tekkoPro && (!tekkoPro.best_price || parseFloat(tekkoPro.best_price) === 0)) {
    await knex('products_catalog').where({ id: tekkoPro.id }).update({
      needs_pricing: true,
    });
  }

  // ── Helper for COGS mappings (used in sections 3 & 4) ──
  const hasUsageTable = await knex.schema.hasTable('service_product_usage');

  async function ensureUsage(serviceType, productId, data) {
    if (!productId || !hasUsageTable) return;
    const existing = await knex('service_product_usage')
      .where({ service_type: serviceType, product_id: productId })
      .first();
    if (existing) return;
    await knex('service_product_usage').insert({
      service_type: serviceType,
      product_id: productId,
      ...data,
    }).catch(() => {}); // ignore dupes
  }

  // ── 3. PRICE HexPro (was in catalog unpriced) ──
  // HexPro is a wood-monitor baiting system — third termite option alongside Advance/Trelona
  const hexPro = await knex('products_catalog')
    .whereRaw("LOWER(name) LIKE '%hexpro%'")
    .first();
  if (hexPro) {
    await knex('products_catalog').where({ id: hexPro.id }).update({
      best_price: 86.94,
      best_vendor: 'Veseris',
      needs_pricing: false,
      active: true,
    });
    await ensureVendorPrice(hexPro.id, 10, 86.94, '1 station', 'each', null); // code 10 = Veseris

    // Add COGS mapping for HexPro termite monitoring
    await ensureUsage('Termite Monitoring', hexPro.id, {
      usage_amount: 1,
      usage_unit: 'station',
      is_primary: true,
      notes: 'HexPro wood-monitor station — $86.94/10-pack ($8.69/station), detection system',
    });
  }

  // ── 4. FIX service_product_usage GAPS ──
  // The original seed (migration 000091) used fuzzy matching that silently
  // skipped products it couldn't find. Re-seed the missing mappings.
  if (!hasUsageTable) return;

  // Mosquito — Cyzmic CS (barrier spray)
  await ensureUsage('Mosquito Treatment', cyzmicId, {
    usage_amount: 3.0,
    usage_unit: 'oz',
    usage_per_1000sf: 0.5,
    is_primary: true,
    notes: 'Barrier spray — foliage, fence, lanai perimeter',
  });

  // Rodent — Contrac Blox
  await ensureUsage('Rodent Bait', contracId, {
    usage_amount: 4,
    usage_unit: 'blocks',
    is_primary: true,
    notes: '2-4 blocks per tamper-resistant station',
  });

  // Rodent — Trapper T-Rex
  await ensureUsage('Rodent Trapping', trapperTrexId, {
    usage_amount: 6,
    usage_unit: 'traps',
    is_primary: true,
    notes: '6 snap traps per attic/garage placement',
  });

  // Termite — Trelona ATBS
  await ensureUsage('Termite Bait', trelonaId, {
    usage_amount: 1,
    usage_unit: 'station',
    is_primary: true,
    notes: 'Bait station — 1 per 10 linear ft perimeter',
  });

  // Cockroach — Advion Gel
  await ensureUsage('Cockroach Treatment', advionGelId, {
    usage_amount: 1,
    usage_unit: 'tube',
    is_primary: true,
    notes: 'Gel bait — kitchen, bath, utility areas',
  });

  // Specialty — Bora-Care
  await ensureUsage('Bora-Care Treatment', boracareId, {
    usage_amount: 1,
    usage_unit: 'gal',
    usage_per_1000sf: 3.64, // 1 gal covers 275 sqft → 3.64 gal/1000sf
    is_primary: true,
    notes: 'Wood treatment — $91.98/gal, 275 sqft coverage per gal',
  });

  // Specialty — Termidor SC (pre-slab)
  await ensureUsage('Pre-Slab Termidor', termidorScId, {
    usage_amount: 1,
    usage_unit: 'bottle',
    usage_per_1000sf: 0.8, // 78oz bottle covers 1250 sqft
    is_primary: true,
    notes: 'Pre-construction soil treatment — $152.10/78oz bottle, 1250 sqft coverage',
  });

  // Specialty — Termidor Foam (foam drill)
  await ensureUsage('Foam Drill Treatment', termidorFoamId, {
    usage_amount: 1,
    usage_unit: 'can',
    is_primary: true,
    notes: 'Drill & foam injection — $39.08/can, 1-4 cans per job',
  });
};

exports.down = async function (knex) {
  // Remove the COGS mappings we added
  const serviceTypes = [
    'Bora-Care Treatment', 'Pre-Slab Termidor', 'Foam Drill Treatment',
  ];
  for (const st of serviceTypes) {
    await knex('service_product_usage').where({ service_type: st }).del().catch(() => {});
  }

  // Remove the products we added (by name)
  const names = [
    'Bora-Care', 'Termidor SC', 'Termidor Foam',
    'Advance Termite Bait Station', 'Trelona ATBS Bait Station',
    'Cyzmic CS', 'Contrac Blox', 'Trapper T-Rex Rat Snap Trap',
    'Advion Cockroach Gel Bait',
  ];
  for (const name of names) {
    const product = await knex('products_catalog').whereRaw('LOWER(name) = ?', [name.toLowerCase()]).first();
    if (product) {
      await knex('service_product_usage').where({ product_id: product.id }).del().catch(() => {});
      await knex('vendor_pricing').where({ product_id: product.id }).del().catch(() => {});
      await knex('products_catalog').where({ id: product.id }).del().catch(() => {});
    }
  }

  // Revert HexPro to unpriced state
  await knex('products_catalog')
    .whereRaw("LOWER(name) LIKE '%hexpro%'")
    .update({ best_price: null, best_vendor: null, needs_pricing: true });
  // Remove HexPro vendor pricing
  const hexPro = await knex('products_catalog').whereRaw("LOWER(name) LIKE '%hexpro%'").first();
  if (hexPro) {
    await knex('vendor_pricing').where({ product_id: hexPro.id }).del().catch(() => {});
    await knex('service_product_usage').where({ product_id: hexPro.id }).del().catch(() => {});
  }
};
