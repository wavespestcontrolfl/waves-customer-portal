/**
 * Service Library Service — single source of truth for all Waves services
 */
const db = require('../models/db');

const SERVICE_COLS = [
  'id', 'service_key', 'name', 'short_name', 'description', 'internal_notes',
  'category', 'subcategory', 'billing_type', 'is_waveguard',
  'default_duration_minutes', 'min_duration_minutes', 'max_duration_minutes',
  'scheduling_buffer_minutes', 'requires_follow_up', 'follow_up_interval_days',
  'frequency', 'visits_per_year',
  'pricing_type', 'base_price', 'price_range_min', 'price_range_max', 'pricing_model_key',
  'is_taxable', 'tax_category', 'tax_service_key',
  'requires_license', 'license_category', 'requires_certification', 'min_tech_skill_level',
  'default_equipment', 'default_products', 'typical_materials_cost',
  'customer_visible', 'booking_enabled', 'sort_order', 'icon', 'color',
  'is_active', 'is_archived',
  'created_at', 'updated_at',
];

/**
 * Paginated list of services with filters
 */
async function getServices({ category, billingType, isActive, search, limit = 50, offset = 0 } = {}) {
  let query = db('services').select(SERVICE_COLS).orderBy('sort_order', 'asc').orderBy('name', 'asc');

  if (category) query = query.where('category', category);
  if (billingType) query = query.where('billing_type', billingType);
  if (typeof isActive === 'boolean') query = query.where('is_active', isActive);
  else if (isActive === 'true') query = query.where('is_active', true);
  else if (isActive === 'false') query = query.where('is_active', false);
  if (search) {
    // Token-AND across the searchable text columns. Splitting on
    // whitespace and requiring each token to match somewhere lets the
    // operator type words in any order — "quarterly pest" still finds
    // "General Pest Control (Quarterly)", "lawn fert" finds "Lawn
    // Fertilization & Weed Control". Single-token queries collapse to
    // the same predicate as the old code. `category` is included so
    // category words like "lawn" / "termite" surface services whose
    // display name doesn't repeat the category.
    const tokens = String(search).trim().split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
      const t = `%${tok}%`;
      query = query.where(function () {
        this.where('name', 'ilike', t)
          .orWhere('short_name', 'ilike', t)
          .orWhere('service_key', 'ilike', t)
          .orWhere('description', 'ilike', t)
          .orWhere('category', 'ilike', t);
      });
    }
  }

  // Don't show archived by default
  query = query.where('is_archived', false);

  const countQuery = query.clone().clearSelect().clearOrder().count('* as total').first();
  const [rows, countResult] = await Promise.all([
    query.limit(limit).offset(offset),
    countQuery,
  ]);

  return { services: rows, total: parseInt(countResult.total, 10), limit, offset };
}

/**
 * Single service by id, with add-ons
 */
async function getServiceById(id) {
  const service = await db('services').where({ id }).first();
  if (!service) return null;

  const addons = await db('service_addons as sa')
    .join('services as s', 's.id', 'sa.addon_service_id')
    .where('sa.parent_service_id', id)
    .select('sa.id as addon_link_id', 'sa.is_default', 'sa.addon_price', 'sa.sort_order',
      's.id', 's.service_key', 's.name', 's.short_name', 's.icon', 's.base_price')
    .orderBy('sa.sort_order');

  return { ...service, addons };
}

/**
 * Lookup by service_key
 */
async function getServiceByKey(serviceKey) {
  return db('services').where({ service_key: serviceKey }).first();
}

/**
 * Create a new service
 */
async function createService(data) {
  // Generate service_key if not provided
  if (!data.service_key && data.name) {
    data.service_key = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').substring(0, 80);
  }
  // Only insert known columns; convert empty-string numerics to null
  const allowed = [
    'service_key', 'name', 'short_name', 'description', 'internal_notes',
    'category', 'subcategory', 'billing_type', 'is_waveguard',
    'default_duration_minutes', 'min_duration_minutes', 'max_duration_minutes',
    'scheduling_buffer_minutes', 'requires_follow_up', 'follow_up_interval_days',
    'frequency', 'visits_per_year',
    'pricing_type', 'base_price', 'price_range_min', 'price_range_max', 'pricing_model_key',
    'is_taxable', 'tax_category', 'tax_service_key',
    'requires_license', 'license_category', 'requires_certification', 'min_tech_skill_level',
    'default_equipment', 'default_products', 'typical_materials_cost',
    'customer_visible', 'booking_enabled', 'sort_order', 'icon', 'color',
    'is_active', 'is_archived',
  ];
  const numericKeys = new Set([
    'default_duration_minutes', 'min_duration_minutes', 'max_duration_minutes',
    'scheduling_buffer_minutes', 'follow_up_interval_days', 'visits_per_year',
    'base_price', 'price_range_min', 'price_range_max',
    'min_tech_skill_level', 'typical_materials_cost', 'sort_order',
  ]);
  const jsonbKeys = new Set(['requires_certification', 'default_equipment', 'default_products']);

  const insert = {};
  for (const key of allowed) {
    if (data[key] !== undefined) {
      let val = data[key];
      if (numericKeys.has(key)) {
        if (val === '' || val === null || (typeof val === 'number' && isNaN(val))) {
          val = null;
        } else if (typeof val === 'string') {
          const parsed = Number(val);
          val = isNaN(parsed) ? null : parsed;
        }
      }
      if (jsonbKeys.has(key)) {
        if (typeof val === 'string') {
          try { val = JSON.parse(val); } catch { val = null; }
        }
        if (val !== null && val !== undefined) {
          val = JSON.stringify(val);
        }
      }
      insert[key] = val;
    }
  }

  // Retry loop: strip missing columns until the insert succeeds
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [row] = await db('services').insert(insert).returning('*');
      return row;
    } catch (err) {
      if (err.code === '42703') {
        const colMatch = err.message.match(/column "(\w+)"/);
        if (colMatch && insert[colMatch[1]] !== undefined) {
          delete insert[colMatch[1]];
          continue;
        }
      }
      throw err;
    }
  }
  // Exhausted retries — try with minimum fields
  const [row] = await db('services').insert({ service_key: insert.service_key, name: insert.name }).returning('*');
  return row;
}

/**
 * Update an existing service
 */
async function updateService(id, data) {
  // Only update columns that exist on the services table
  const allowed = [
    'service_key', 'name', 'short_name', 'description', 'internal_notes',
    'category', 'subcategory', 'billing_type', 'is_waveguard',
    'default_duration_minutes', 'min_duration_minutes', 'max_duration_minutes',
    'scheduling_buffer_minutes', 'requires_follow_up', 'follow_up_interval_days',
    'frequency', 'visits_per_year',
    'pricing_type', 'base_price', 'price_range_min', 'price_range_max', 'pricing_model_key',
    'is_taxable', 'tax_category', 'tax_service_key',
    'requires_license', 'license_category', 'requires_certification', 'min_tech_skill_level',
    'default_equipment', 'default_products', 'typical_materials_cost',
    'customer_visible', 'booking_enabled', 'sort_order', 'icon', 'color',
    'is_active', 'is_archived',
  ];
  // Numeric columns — empty strings and NaN must become null or PostgreSQL rejects them
  const numericKeys = new Set([
    'default_duration_minutes', 'min_duration_minutes', 'max_duration_minutes',
    'scheduling_buffer_minutes', 'follow_up_interval_days', 'visits_per_year',
    'base_price', 'price_range_min', 'price_range_max',
    'min_tech_skill_level', 'typical_materials_cost', 'sort_order',
  ]);
  // JSONB columns — must be objects/arrays/null, not strings
  const jsonbKeys = new Set(['requires_certification', 'default_equipment', 'default_products']);

  const update = { updated_at: new Date() };
  for (const key of allowed) {
    if (data[key] !== undefined) {
      let val = data[key];
      if (numericKeys.has(key)) {
        // Coerce empty strings, NaN, and non-numeric values to null
        if (val === '' || val === null || (typeof val === 'number' && isNaN(val))) {
          val = null;
        } else if (typeof val === 'string') {
          const parsed = Number(val);
          val = isNaN(parsed) ? null : parsed;
        }
      }
      if (jsonbKeys.has(key)) {
        if (typeof val === 'string') {
          try { val = JSON.parse(val); } catch { val = null; }
        }
        // Stringify for jsonb — pg otherwise serializes JS arrays as Postgres array literals
        if (val !== null && val !== undefined) {
          val = JSON.stringify(val);
        }
      }
      update[key] = val;
    }
  }

  // Retry loop: strip missing columns until the update succeeds
  const strippedCols = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [row] = await db('services').where({ id }).update(update).returning('*');
      return row;
    } catch (err) {
      if (err.code === '42703') {
        // Column doesn't exist — strip it and retry
        const colMatch = err.message.match(/column "(\w+)"/);
        if (colMatch && update[colMatch[1]] !== undefined) {
          strippedCols.push(colMatch[1]);
          delete update[colMatch[1]];
          continue;
        }
      }
      throw err;
    }
  }
  // If we exhausted retries, try with just the basics
  const [row] = await db('services').where({ id }).update({ updated_at: new Date() }).returning('*');
  return row;
}

/**
 * Soft-delete (deactivate)
 */
async function deactivateService(id) {
  const [row] = await db('services').where({ id }).update({ is_active: false, is_archived: true, updated_at: new Date() }).returning('*');
  return row;
}

/**
 * Lightweight dropdown list
 */
async function getDropdown() {
  return db('services')
    .select('id', 'service_key', 'name', 'short_name', 'icon', 'category', 'color', 'default_duration_minutes', 'base_price')
    .where({ is_active: true, is_archived: false })
    .orderBy('sort_order', 'asc')
    .orderBy('name', 'asc');
}

/**
 * List packages with their included service items
 */
async function getPackages() {
  const packages = await db('service_packages').where({ is_active: true }).orderBy('sort_order', 'asc');

  const items = await db('service_package_items as spi')
    .join('services as s', 's.id', 'spi.service_id')
    .whereIn('spi.package_id', packages.map(p => p.id))
    .select('spi.*', 's.name as service_name', 's.short_name', 's.icon', 's.service_key')
    .orderBy('spi.sort_order', 'asc');

  const itemsByPkg = {};
  items.forEach(i => {
    if (!itemsByPkg[i.package_id]) itemsByPkg[i.package_id] = [];
    itemsByPkg[i.package_id].push(i);
  });

  return packages.map(p => ({ ...p, items: itemsByPkg[p.id] || [] }));
}

/**
 * Update a package
 */
async function updatePackage(id, data) {
  const { items, ...pkgData } = data;
  pkgData.updated_at = new Date();

  const [pkg] = await db('service_packages').where({ id }).update(pkgData).returning('*');

  // If items were provided, replace them
  if (Array.isArray(items)) {
    await db('service_package_items').where({ package_id: id }).del();
    if (items.length > 0) {
      await db('service_package_items').insert(
        items.map((item, idx) => ({
          package_id: id,
          service_id: item.service_id,
          is_included: item.is_included !== false,
          included_visits: item.included_visits || null,
          addon_discount_pct: item.addon_discount_pct || null,
          sort_order: item.sort_order ?? idx,
        }))
      );
    }
  }

  return pkg;
}

/**
 * Resolve free-text service type to a service record (backwards compat)
 */
async function resolveServiceType(freeTextServiceType) {
  if (!freeTextServiceType) return null;
  const text = freeTextServiceType.trim();

  // Try exact match on service_key or name first
  let svc = await db('services')
    .where('service_key', text.toLowerCase().replace(/\s+/g, '_'))
    .orWhere('name', 'ilike', text)
    .orWhere('short_name', 'ilike', text)
    .first();
  if (svc) return svc;

  // Try partial match
  svc = await db('services')
    .where('name', 'ilike', `%${text}%`)
    .orWhere('short_name', 'ilike', `%${text}%`)
    .orWhere('service_key', 'ilike', `%${text.replace(/\s+/g, '_')}%`)
    .orderBy('sort_order', 'asc')
    .first();

  return svc || null;
}

module.exports = {
  getServices,
  getServiceById,
  getServiceByKey,
  createService,
  updateService,
  deactivateService,
  getDropdown,
  getPackages,
  updatePackage,
  resolveServiceType,
};
