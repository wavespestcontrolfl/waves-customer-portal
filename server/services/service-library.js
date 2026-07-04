/**
 * Service Library Service — single source of truth for all Waves services
 */
const db = require('../models/db');
const { auditServiceCatalogChange } = require('./audit-log');
const { inferCloseoutDefaults } = require('./service-closeout-requirements');

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
  'requires_service_report', 'requires_application_log', 'required_photo_count',
  'requires_customer_signature', 'requires_customer_notice', 'closeout_requirements_source',
  'customer_visible', 'booking_enabled', 'sort_order', 'icon', 'color',
  'is_active', 'is_archived',
  'created_at', 'updated_at',
];

const CLOSEOUT_REQUIREMENT_COLS = [
  'requires_service_report',
  'requires_application_log',
  'required_photo_count',
  'requires_customer_signature',
  'requires_customer_notice',
  'closeout_requirements_source',
];

const VALID_CATEGORIES = new Set([
  'pest_control', 'lawn_care', 'mosquito', 'termite', 'rodent',
  'tree_shrub', 'inspection', 'specialty', 'other',
]);
const VALID_BILLING_TYPES = new Set(['recurring', 'one_time', 'free']);
const VALID_PRICING_TYPES = new Set(['variable', 'fixed', 'quoted']);
const VALID_FREQUENCIES = new Set(['', 'monthly', 'every_6_weeks', 'bimonthly', 'quarterly', 'semiannual', 'annual']);
const NON_LIVE_SCHEDULE_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show'];
const BOOLEAN_COLS = new Set([
  'is_waveguard', 'requires_follow_up', 'is_taxable', 'requires_license',
  'requires_service_report', 'requires_application_log',
  'requires_customer_signature', 'requires_customer_notice',
  'customer_visible', 'booking_enabled', 'is_active', 'is_archived',
]);

function validationError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function conflictError(message, details = {}) {
  const err = new Error(message);
  err.status = 409;
  Object.assign(err, details);
  return err;
}

function normalizeServiceKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 80);
}

function normalizeBoolean(value, field) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  if (typeof value === 'number' && (value === 0 || value === 1)) return Boolean(value);
  throw validationError(`${field} must be a boolean`);
}

function serviceTextPatterns(service) {
  const candidates = [
    service.name,
    service.short_name,
    service.service_key ? service.service_key.replace(/_/g, ' ') : null,
  ];
  return [...new Set(candidates
    .map(v => String(v || '').trim())
    .filter(v => v.length >= 3))];
}

function whereTextMatches(query, column, patterns) {
  if (!patterns.length) return query.whereRaw('1 = 0');
  return query.where(function () {
    patterns.forEach((pattern, idx) => {
      const like = `%${pattern}%`;
      if (idx === 0) this.where(column, 'ilike', like);
      else this.orWhere(column, 'ilike', like);
    });
  });
}

function auditSnapshot(row) {
  if (!row) return null;
  return SERVICE_COLS.reduce((out, key) => {
    if (row[key] !== undefined) out[key] = row[key];
    return out;
  }, {});
}

function changedFields(before, after) {
  if (!before || !after) return [];
  return SERVICE_COLS.filter((key) => {
    if (key === 'updated_at') return false;
    return JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null);
  });
}

async function countRef(table, buildQuery, knexDb = db) {
  const row = await buildQuery(knexDb(table)).count('* as count').first();
  return Number(row?.count || 0);
}

async function getServiceReferences(serviceOrId, knexDb = db) {
  const service = typeof serviceOrId === 'object'
    ? serviceOrId
    : await knexDb('services').where({ id: serviceOrId }).first();
  if (!service) return null;

  const id = service.id;
  const serviceKey = service.service_key;
  const textPatterns = serviceTextPatterns(service);
  const refs = {
    scheduled_services: await countRef('scheduled_services', (q) => q
      .where({ service_id: id })
      .whereNotIn('status', NON_LIVE_SCHEDULE_STATUSES), knexDb),
    scheduled_services_by_type: await countRef('scheduled_services', (q) => whereTextMatches(q
      .whereNotIn('status', NON_LIVE_SCHEDULE_STATUSES)
      .where(function () {
        this.whereNull('service_id').orWhereNot('service_id', id);
      }), 'service_type', textPatterns), knexDb),
    scheduled_service_addons: await countRef('scheduled_service_addons as ssa', (q) => q
      .join('scheduled_services as ss', 'ss.id', 'ssa.scheduled_service_id')
      .where('ssa.service_id', id)
      .whereNotIn('ss.status', NON_LIVE_SCHEDULE_STATUSES), knexDb),
    scheduled_service_addons_by_name: await countRef('scheduled_service_addons as ssa', (q) => whereTextMatches(q
      .join('scheduled_services as ss', 'ss.id', 'ssa.scheduled_service_id')
      .whereNotIn('ss.status', NON_LIVE_SCHEDULE_STATUSES)
      .where(function () {
        this.whereNull('ssa.service_id').orWhereNot('ssa.service_id', id);
      }), 'ssa.service_name', textPatterns), knexDb),
    service_addons_as_parent: await countRef('service_addons', (q) => q.where({ parent_service_id: id }), knexDb),
    service_addons_as_addon: await countRef('service_addons', (q) => q.where({ addon_service_id: id }), knexDb),
    service_package_items: await countRef('service_package_items', (q) => q.where({ service_id: id }), knexDb),
    service_discount_rules: serviceKey
      ? await countRef('service_discount_rules', (q) => q.where({ service_key: serviceKey }), knexDb)
      : 0,
    discounts_by_service_key: serviceKey
      ? await countRef('discounts', (q) => q.where({ service_key_filter: serviceKey }), knexDb)
      : 0,
    historical_service_records: await countRef('service_records', (q) => q.where({ service_id: id }), knexDb),
  };
  refs.blocking_total = refs.scheduled_services
    + refs.scheduled_services_by_type
    + refs.scheduled_service_addons
    + refs.scheduled_service_addons_by_name
    + refs.service_addons_as_parent
    + refs.service_addons_as_addon
    + refs.service_package_items
    + refs.service_discount_rules
    + refs.discounts_by_service_key;
  return refs;
}

async function writeCatalogAudit(changeType, { before = null, after = null, references = null, audit = {}, trx = null } = {}) {
  const serviceId = after?.id || before?.id || null;
  await auditServiceCatalogChange({
    tech_user_id: audit.actorId || null,
    service_id: serviceId,
    change_type: changeType,
    changed_fields: changedFields(before || {}, after || {}),
    before: auditSnapshot(before),
    after: auditSnapshot(after),
    references,
    ip_address: audit.ipAddress || null,
    user_agent: audit.userAgent || null,
    trx,
  });
}

function validateServicePayload(data, { partial = false } = {}) {
  if (!partial || data.name !== undefined) {
    if (typeof data.name !== 'string' || !data.name.trim()) {
      throw validationError('Service name is required');
    }
    data.name = data.name.trim();
  }

  if (data.service_key !== undefined) {
    data.service_key = normalizeServiceKey(data.service_key);
    if (!data.service_key) {
      if (partial) throw validationError('Service key is required');
      delete data.service_key;
    }
  }

  if (data.category !== undefined && !VALID_CATEGORIES.has(data.category)) {
    throw validationError('Invalid service category');
  }
  if (data.billing_type !== undefined && !VALID_BILLING_TYPES.has(data.billing_type)) {
    throw validationError('Invalid billing type');
  }
  if (data.pricing_type !== undefined && !VALID_PRICING_TYPES.has(data.pricing_type)) {
    throw validationError('Invalid pricing type');
  }
  if (data.frequency !== undefined && data.frequency !== null && !VALID_FREQUENCIES.has(String(data.frequency))) {
    throw validationError('Invalid service frequency');
  }

  for (const key of [
    'default_duration_minutes', 'min_duration_minutes', 'max_duration_minutes',
    'scheduling_buffer_minutes', 'follow_up_interval_days', 'visits_per_year',
    'base_price', 'price_range_min', 'price_range_max',
    'min_tech_skill_level', 'typical_materials_cost', 'required_photo_count', 'sort_order',
  ]) {
    if (data[key] === undefined || data[key] === '' || data[key] === null) continue;
    const parsed = Number(data[key]);
    if (!Number.isFinite(parsed)) throw validationError(`Invalid numeric value for ${key}`);
    if (parsed < 0) throw validationError(`${key} cannot be negative`);
  }
}

// Cross-field pricing rules, checked on the merged row (create insert, or
// before+update) after numeric coercion. A 'fixed' service with no positive
// base_price silently books unpriced (call-booking-catalog requires
// fixed && base > 0), and a literal $0 would become a real $0 charge via the
// admin-schedule base_price fallback — so fixed requires base_price > 0.
function assertPricingConsistency(merged) {
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const min = num(merged.price_range_min);
  const max = num(merged.price_range_max);
  if (min != null && max != null && min > max) {
    throw validationError('price_range_min cannot exceed price_range_max');
  }
  if (merged.pricing_type === 'fixed' && !(num(merged.base_price) > 0)) {
    throw validationError('Fixed pricing requires a base price greater than zero');
  }
}

/**
 * Paginated list of services with filters
 */
async function getServices({ category, billingType, isActive, isArchived, includeArchived = false, search, limit = 50, offset = 0 } = {}) {
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

  if (typeof isArchived === 'boolean') query = query.where('is_archived', isArchived);
  else if (isArchived === 'true') query = query.where('is_archived', true);
  else if (isArchived === 'false') query = query.where('is_archived', false);
  else if (includeArchived !== true && includeArchived !== 'true') query = query.where('is_archived', false);

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
async function createService(data, { audit } = {}) {
  validateServicePayload(data);
  // Generate service_key if not provided
  if (!data.service_key && data.name) {
    data.service_key = normalizeServiceKey(data.name);
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
    ...CLOSEOUT_REQUIREMENT_COLS,
    'customer_visible', 'booking_enabled', 'sort_order', 'icon', 'color',
    'is_active', 'is_archived',
  ];
  const numericKeys = new Set([
    'default_duration_minutes', 'min_duration_minutes', 'max_duration_minutes',
    'scheduling_buffer_minutes', 'follow_up_interval_days', 'visits_per_year',
    'base_price', 'price_range_min', 'price_range_max',
    'min_tech_skill_level', 'typical_materials_cost', 'required_photo_count', 'sort_order',
  ]);
  const jsonbKeys = new Set(['requires_certification', 'default_equipment', 'default_products']);

  const insert = {};
  for (const key of allowed) {
    if (data[key] !== undefined) {
      let val = data[key];
      if (BOOLEAN_COLS.has(key)) {
        val = normalizeBoolean(val, key);
      }
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
  const hasExplicitCloseout = CLOSEOUT_REQUIREMENT_COLS.some((key) => data[key] !== undefined);
  if (!hasExplicitCloseout) {
    Object.assign(insert, inferCloseoutDefaults(insert, insert.name));
  } else if (!insert.closeout_requirements_source) {
    insert.closeout_requirements_source = 'manual';
  }
  assertPricingConsistency(insert);

  return db.transaction(async (trx) => {
    const [row] = await trx('services').insert(insert).returning('*');
    await writeCatalogAudit('create', { after: row, audit, trx });
    return row;
  });
}

/**
 * Update an existing service
 */
async function updateService(id, data, { audit } = {}) {
  validateServicePayload(data, { partial: true });
  const before = await db('services').where({ id }).first();
  if (!before) return null;
  if (data.service_key !== undefined && data.service_key !== before.service_key) {
    throw validationError('Service key cannot be changed after creation');
  }
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
    ...CLOSEOUT_REQUIREMENT_COLS,
    'customer_visible', 'booking_enabled', 'sort_order', 'icon', 'color',
    'is_active', 'is_archived',
  ];
  // Numeric columns — empty strings and NaN must become null or PostgreSQL rejects them
  const numericKeys = new Set([
    'default_duration_minutes', 'min_duration_minutes', 'max_duration_minutes',
    'scheduling_buffer_minutes', 'follow_up_interval_days', 'visits_per_year',
    'base_price', 'price_range_min', 'price_range_max',
    'min_tech_skill_level', 'typical_materials_cost', 'required_photo_count', 'sort_order',
  ]);
  // JSONB columns — must be objects/arrays/null, not strings
  const jsonbKeys = new Set(['requires_certification', 'default_equipment', 'default_products']);

  const update = { updated_at: new Date() };
  for (const key of allowed) {
    if (data[key] !== undefined) {
      let val = data[key];
      if (BOOLEAN_COLS.has(key)) {
        val = normalizeBoolean(val, key);
      }
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
  const hasExplicitCloseout = CLOSEOUT_REQUIREMENT_COLS.some((key) => data[key] !== undefined);
  if (hasExplicitCloseout && !update.closeout_requirements_source) {
    update.closeout_requirements_source = 'manual';
  } else if (!hasExplicitCloseout && (data.name !== undefined || data.category !== undefined)) {
    const source = String(before.closeout_requirements_source || '').trim();
    if (!source || source === 'default' || source === 'inferred_v1') {
      Object.assign(update, inferCloseoutDefaults({ ...before, ...update }, update.name || before.name));
    }
  }

  // Only enforce when the update touches pricing — a pre-existing
  // inconsistency must not block unrelated edits to a legacy row.
  const touchesPricing = ['pricing_type', 'base_price', 'price_range_min', 'price_range_max']
    .some((key) => data[key] !== undefined);
  if (touchesPricing) assertPricingConsistency({ ...before, ...update });

  let archiveReferences = null;
  if (update.is_archived === true && before.is_archived !== true) {
    archiveReferences = await getServiceReferences(before);
    if (archiveReferences?.blocking_total > 0) {
      throw conflictError('Service is still referenced and cannot be archived', { references: archiveReferences });
    }
    update.is_active = false;
  }

  return db.transaction(async (trx) => {
    const [row] = await trx('services').where({ id }).update(update).returning('*');
    if (row) {
      const changeType = before.is_archived && row.is_archived === false
        ? 'reactivate'
        : !before.is_archived && row.is_archived === true
          ? 'archive'
          : 'update';
      await writeCatalogAudit(changeType, { before, after: row, references: archiveReferences, audit, trx });
    }
    return row;
  });
}

/**
 * Soft-delete (deactivate)
 */
async function deactivateService(id, { audit } = {}) {
  const before = await db('services').where({ id }).first();
  if (!before) return null;
  const references = await getServiceReferences(before);
  if (references?.blocking_total > 0) {
    throw conflictError('Service is still referenced and cannot be archived', { references });
  }
  return db.transaction(async (trx) => {
    const [row] = await trx('services').where({ id }).update({ is_active: false, is_archived: true, updated_at: new Date() }).returning('*');
    if (row) await writeCatalogAudit('archive', { before, after: row, references, audit, trx });
    return row;
  });
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
  getServiceReferences,
  __private: {
    normalizeServiceKey,
    validateServicePayload,
    changedFields,
  },
};
