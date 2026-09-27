// Owner-confirmed models and fertilizer SKUs. No purchase transaction,
// calibration, serial number, bag price or per-palm dose is inferred.
const MIGRATION = '20260927020000_tree_shrub_owned_equipment';
const EQUIPMENT = [
  { name: 'LESCO 50 lb broadcast spreader', make: 'LESCO', model: '092807', category: 'spreader', specs: { hopper_capacity_lb: 50 } },
  { name: 'LESCO 5 lb handheld spreader', make: 'LESCO', model: '1235445', category: 'spreader', specs: { hopper_capacity_lb: 5, handle_type: 'hand crank' } },
  { name: 'B&G 1 gal sprayer N124-S', make: 'B&G', model: 'N124-S', category: 'sprayer', specs: { tank_capacity_gal: 1, part_number: '11003500', wand_length_in: 9, valve: 'Extenda-Ban', tip: 'four-way' } },
  { name: 'FlowZone soil injector kit', make: 'FlowZone', model: 'Soil injector kit', category: 'other', specs: { attachment_for: 'FlowZone Typhoon 4 gal', delivery_units: ['qt', 'gal'] } },
];
const PRODUCTS = [
  { name: 'LESCO 8-0-12 Palm & Tropical Ornamental Fertilizer (#511542)', alias: 'LESCO 8-0-12 #511542', shorthand: '8-0-12 palm fertilizer', analysis: '8-0-12 palm fertilizer; 4% Mg, 2% Mn', key: 'f8012' },
  { name: 'LESCO 0-0-16 Palm & Tropical Ornamental Fertilizer (#510513)', alias: 'LESCO 0-0-16 #510513', shorthand: '0-0-16 palm fertilizer', analysis: '0-0-16 palm fertilizer; 6% Mg, 2% Mn', key: 'f0016' },
];

async function audit(knex, type, id, metadata = {}) {
  if (!(await knex.schema.hasTable('audit_log'))) return;
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({ actor_type: 'system', action: 'tree_shrub_catalog_seed', resource_type: type,
    resource_id: id, metadata: { migration: MIGRATION, ...metadata }, critical: true, trx: knex });
}

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('equipment')) {
    for (const spec of EQUIPMENT) {
      const existing = await knex('equipment').where(function identity() {
        this.where(function modelIdentity() {
          this.whereILike('make', spec.make).whereILike('model', spec.model);
        }).orWhereILike('name', spec.name);
      }).first('id');
      if (existing) continue; // Preserve admin edits, retirement and assignments.
      const row = { ...spec, specs: JSON.stringify(spec.specs), status: 'active', current_hours: null, depreciation_method: null,
        notes: `Ownership confirmed by Adam; ${MIGRATION}.` };
      if (await knex.schema.hasColumn('equipment', 'condition_rating')) row.condition_rating = null;
      if (await knex.schema.hasColumn('equipment', 'location')) row.location = null;
      if (await knex.schema.hasColumn('equipment', 'current_miles')) row.current_miles = null;
      const [created] = await knex('equipment').insert(row).returning('id');
      await audit(knex, 'equipment', created.id);
    }
  }
  if (await knex.schema.hasTable('products_catalog')) {
    for (const spec of PRODUCTS) {
      let product = await knex('products_catalog').where('name', spec.name).first('id');
      if (!product) {
        // A pre-existing SKU name can be linked without replacing its label,
        // prices or rates. Ambiguous matches must not pick an arbitrary row.
        const matches = await knex('products_catalog').whereILike('name', `%${spec.alias.slice(-6)}%`).select('id');
        if (matches.length > 1) continue;
        product = matches[0];
      }
      if (!product) {
        [product] = await knex('products_catalog').insert({
          name: spec.name, category: 'fertilizer', manufacturer: 'LESCO', active_ingredient: spec.analysis,
          epa_reg_number: 'N/A', formulation: 'granular', application_method: 'granular_broadcast',
          rate_unit: 'lb', inventory_unit: 'lb', default_unit: 'lb/palm', default_rate: null,
          default_rate_per_1000: null, container_size: '50 lb', unit_size_oz: 800,
          best_vendor: 'SiteOne', needs_pricing: true, best_price: null, cost_per_unit: null, cost_unit: 'lb',
          active: true, customer_visibility: 'internal_only', content_status: 'draft', label_source_note: MIGRATION,
        }).returning('id');
        await audit(knex, 'products_catalog', product.id);
      }
      if (!(await knex.schema.hasTable('product_aliases'))) continue;
      for (const alias_name of [spec.alias, spec.shorthand]) {
        if (await knex('product_aliases').where({ alias_name }).whereNull('vendor_id').first()) continue;
        const [alias] = await knex('product_aliases').insert({ product_id: product.id, alias_name, vendor_id: null }).returning('id');
        await audit(knex, 'product_aliases', alias.id);
      }
    }
  }
  if (await knex.schema.hasTable('equipment_checklists')) {
    const rows = await knex('equipment_checklists').where({ service_line: 'tree_shrub' });
    for (const row of rows) {
      const before = typeof row.checklist_items === 'string' ? JSON.parse(row.checklist_items) : row.checklist_items;
      if (!Array.isArray(before)) continue;
      let changed = false;
      const after = before.map(group => ({ ...group, items: (group.items || []).map(item => {
        if (item.item !== '8-2-12 palm fertilizer') return item;
        changed = true;
        return { ...item, item: 'LESCO 8-0-12 #511542 or 0-0-16 #510513, only when due', required: false };
      }) }));
      if (!changed) continue;
      await knex('equipment_checklists').where({ id: row.id }).update({ checklist_items: JSON.stringify(after), updated_at: knex.fn.now() });
      await audit(knex, 'equipment_checklists', row.id, { before, after });
    }
  }
};

// Seeded rows can acquire inventory, maintenance and application references.
// A rollback must not delete those records or overwrite later admin edits.
exports.down = async function down() {};
