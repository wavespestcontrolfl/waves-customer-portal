/**
 * Service Library Service — single source of truth for all Waves services
 */
const db = require('../models/db');
const { auditServiceCatalogChange, auditServicePackageChange } = require('./audit-log');
const { inferCloseoutDefaults } = require('./service-closeout-requirements');
const { refreshCatalogNames } = require('./service-catalog-names');
const logger = require('./logger');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const { capacityEnabled } = require('./scheduling/policy');

const SERVICE_COLS = [
  'id', 'service_key', 'name', 'short_name', 'description', 'internal_notes',
  'category', 'subcategory', 'billing_type', 'is_waveguard',
  'default_duration_minutes', 'min_duration_minutes', 'max_duration_minutes',
  'scheduling_duration_policy',
  'scheduling_buffer_minutes', 'requires_follow_up', 'follow_up_interval_days',
  'frequency', 'visits_per_year',
  'pricing_type', 'base_price', 'price_range_min', 'price_range_max', 'pricing_model_key',
  'is_taxable', 'tax_category', 'tax_service_key',
  'requires_license', 'license_category', 'requires_certification', 'min_tech_skill_level',
  'default_equipment', 'default_products', 'typical_materials_cost',
  'requires_service_report', 'requires_application_log', 'required_photo_count',
  'requires_customer_signature', 'requires_customer_notice', 'closeout_requirements_source',
  'customer_visible', 'booking_enabled', 'public_quote_selectable', 'sort_order', 'icon', 'color',
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
const VALID_FREQUENCIES = new Set(['', 'monthly', 'every_6_weeks', 'seasonal_feb_oct', 'bimonthly', 'quarterly', 'semiannual', 'annual']);
const NON_LIVE_SCHEDULE_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show'];
const BOOLEAN_COLS = new Set([
  'is_waveguard', 'requires_follow_up', 'is_taxable', 'requires_license',
  'requires_service_report', 'requires_application_log',
  'requires_customer_signature', 'requires_customer_notice',
  'customer_visible', 'booking_enabled', 'public_quote_selectable', 'is_active', 'is_archived',
]);

function withSchedulingDuration(service) {
  const policy = service?.scheduling_duration_policy;
  if (!service || !capacityEnabled() || policy?.version !== 1) return service;
  return { ...service, default_duration_minutes: policy.default_duration_minutes,
    min_duration_minutes: policy.min_duration_minutes, max_duration_minutes: policy.max_duration_minutes };
}

// All booking callers use the catalog allowance. Appointment overrides are
// supplied separately by staff paths and must never be truncated to this range.
function serviceDurationMinutes(service, fallback = 60, { preserveCapacity = false } = {}) {
  const policy = service?.scheduling_duration_policy;
  const duration = Number(preserveCapacity && policy?.version === 1
    ? policy.default_duration_minutes : withSchedulingDuration(service)?.default_duration_minutes);
  return Number.isInteger(duration) && duration > 0 ? duration : fallback;
}

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

  const integerKeys = new Set([
    'default_duration_minutes', 'min_duration_minutes', 'max_duration_minutes',
    'scheduling_buffer_minutes', 'follow_up_interval_days', 'visits_per_year',
    'min_tech_skill_level', 'required_photo_count', 'sort_order',
  ]);
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
    if (integerKeys.has(key) && !Number.isInteger(parsed)) {
      throw validationError(`${key} must be a whole number`);
    }
  }
}

const numOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// Cross-field pricing rules, checked on the merged row (create insert, or
// before+update) after numeric coercion. A 'fixed' service with no positive
// base_price silently books unpriced (call-booking-catalog requires
// fixed && base > 0), and a literal $0 would become a real $0 charge via the
// admin-schedule base_price fallback — so fixed requires base_price > 0.
function assertPricingConsistency(merged) {
  const num = numOrNull;
  const min = num(merged.price_range_min);
  const max = num(merged.price_range_max);
  if (min != null && max != null && min > max) {
    throw validationError('price_range_min cannot exceed price_range_max');
  }
  if (merged.pricing_type === 'fixed' && !(num(merged.base_price) > 0)) {
    throw validationError('Fixed pricing requires a base price greater than zero');
  }
}

function assertOperationalConsistency(merged) {
  const min = numOrNull(merged.min_duration_minutes);
  const normal = numOrNull(merged.default_duration_minutes);
  const max = numOrNull(merged.max_duration_minutes);
  if (min != null && normal != null && min > normal) {
    throw validationError('min_duration_minutes cannot exceed default_duration_minutes');
  }
  if (normal != null && max != null && normal > max) {
    throw validationError('default_duration_minutes cannot exceed max_duration_minutes');
  }
  if (min != null && max != null && min > max) {
    throw validationError('min_duration_minutes cannot exceed max_duration_minutes');
  }
  if (merged.requires_follow_up === true && !(numOrNull(merged.follow_up_interval_days) > 0)) {
    throw validationError('Follow-up services require a positive follow_up_interval_days');
  }
}

/**
 * Paginated list of services with filters
 */
// The new-sale catalog filter shared by every booking picker and the
// annual-prepay plan selector (codex r29 on #4786): retired-for-sale rows are
// dropped unless the customer already holds the plan.
function applySellableFilter(query, sellableCustomerId = null) {
  const { RETIRED_SALE_SERVICE_KEYS } = require('./pricing-engine/retired-sale-catalog');
  const retiredKeys = [...RETIRED_SALE_SERVICE_KEYS];
  const customerId = UUID_RE.test(String(sellableCustomerId || '')) ? String(sellableCustomerId) : null;
  return query.where(function () {
    // NULL-key rows are not retired; NOT IN alone would drop them.
    this.whereNull('service_key').orWhereNotIn('service_key', retiredKeys);
    if (customerId) {
      this.orWhereExists(function () {
        whereCustomerHoldsService(
          this.select(db.raw('1')).from('scheduled_services').whereRaw(HOLDER_VISIT_IS_SERVICE_SQL),
          customerId,
        );
      }).orWhereExists(function () {
        // Held as an add-on line of a combined recurring visit (a one_time
        // add-on line is not a plan — the same predicate the write gate
        // applies, so the picker never offers what the save refuses).
        whereCustomerHoldsService(
          this.select(db.raw('1')).from('scheduled_service_addons')
            .join('scheduled_services', 'scheduled_services.id', 'scheduled_service_addons.scheduled_service_id')
            .whereRaw(HOLDER_ADDON_IS_SERVICE_SQL)
            .whereRaw(ADDON_LINE_IS_PLAN_SQL),
          customerId,
        );
      });
    }
  });
}

async function getServices({ category, billingType, isActive, isArchived, includeArchived = false, sellable = false, sellableCustomerId = null, search, limit = 50, offset = 0 } = {}) {
  const parsedLimit = Number(limit);
  const parsedOffset = Number(offset);
  const safeLimit = Number.isInteger(parsedLimit) ? Math.min(500, Math.max(1, parsedLimit)) : 50;
  const safeOffset = Number.isInteger(parsedOffset) ? Math.max(0, parsedOffset) : 0;
  let query = db('services').select(SERVICE_COLS).orderBy('sort_order', 'asc').orderBy('name', 'asc');

  if (category) query = query.where('category', category);
  if (billingType) query = query.where('billing_type', billingType);
  if (typeof isActive === 'boolean') query = query.where('is_active', isActive);
  else if (isActive === 'true') query = query.where('is_active', true);
  else if (isActive === 'false') query = query.where('is_active', false);
  // New-sale pickers only: retired-for-sale rows stay active for their
  // grandfathered plans but must not be offered for a new appointment —
  // except to a customer who already has visits on that service (the
  // grandfathered plan's catch-up / one-off visits).
  if (sellable === true || sellable === 'true') query = applySellableFilter(query, sellableCustomerId);
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
    query.limit(safeLimit).offset(safeOffset),
    countQuery,
  ]);

  let services = rows.map(withSchedulingDuration);
  if (sellable === true || sellable === 'true') {
    // Flag the grandfathered exception rows so the picker can drop them when
    // the operator switches to a customer who is not on the plan.
    const { RETIRED_SALE_SERVICE_KEYS } = require('./pricing-engine/retired-sale-catalog');
    services = services.map((s) => (RETIRED_SALE_SERVICE_KEYS.has(s.service_key) ? { ...s, retired_for_sale: true } : s));
  }
  return { services, total: parseInt(countResult.total, 10), limit: safeLimit, offset: safeOffset };
}

// An add-on line is part of a PLAN only when it is not its own one_time line
// (admin-schedule lineDueOnRecurringDate: a NULL pattern rides the parent
// visit's cadence). The write gate, the sellable picker and the Intelligence
// Bar overdue scan all read this one predicate (codex r17/r18 on #4786).
const ADDON_LINE_IS_PLAN_SQL = "(scheduled_service_addons.recurring_pattern IS NULL OR scheduled_service_addons.recurring_pattern <> 'one_time')";

// The one "customer is still on this (retired) plan" test: a live recurring
// visit on the service, as its primary line or an add-on line (callers join
// scheduled_service_addons for the latter and add ADDON_LINE_IS_PLAN_SQL) —
// waveguard-existing-services' active-recurring predicate (TERMINAL_STATUSES
// + is_recurring). A completed, skipped or one-off history row does not
// grandfather anyone (codex r13 on #4786).
// A holder row is identified by the catalog id OR — for a plan booked
// through a legacy / free-text path with no catalog link — its stable key
// snapshot or its label (codex r24 on #4786). The picker joins these to the
// catalog row; the write gate matches them to the retired rows in JS.
const HOLDER_VISIT_IS_SERVICE_SQL = '(scheduled_services.service_id = services.id'
  + ' OR scheduled_services.service_key_snapshot = services.service_key'
  + ' OR lower(scheduled_services.service_type) IN (lower(services.name), lower(services.short_name)))';
const HOLDER_ADDON_IS_SERVICE_SQL = '(scheduled_service_addons.service_id = services.id'
  + ' OR scheduled_service_addons.service_key_snapshot = services.service_key'
  + ' OR lower(scheduled_service_addons.service_name) IN (lower(services.name), lower(services.short_name)))';

// TERMINAL_STATUSES is a COVERAGE view: 'rescheduled' is a phantom row until
// SmartRebooker actions it. For OWNERSHIP it is an open obligation
// (cancellation-resolution/restart.js), so it stays plan evidence — for the
// holder gate, the picker and the Intelligence Bar overdue scan alike (codex
// r24/r26 on #4786).
function terminalHistoryStatuses() {
  const { TERMINAL_STATUSES } = require('./waveguard-existing-services');
  return TERMINAL_STATUSES.filter((status) => status !== 'rescheduled');
}

function whereCustomerHoldsService(qb, customerId) {
  return qb
    .where('scheduled_services.customer_id', customerId)
    .whereNotIn('scheduled_services.status', terminalHistoryStatuses())
    .where('scheduled_services.is_recurring', true);
}

// The words a booking's structured recurrence adds to its free-text labels
// (codex r20 on #4786): "Tree & Shrub Care" + { pattern: 'quarterly' } or
// { intervalDays: 90 } names the retired quarterly plan just as the label
// "Quarterly Tree & Shrub Care" does. Null when nothing structured was posted.
function recurrenceWords(recurrence) {
  if (!recurrence || typeof recurrence !== 'object') return '';
  const rawPattern = typeof recurrence.pattern === 'string' ? recurrence.pattern.trim() : '';
  const days = Number.parseInt(recurrence.intervalDays, 10);
  const hasDays = Number.isInteger(days) && days > 0;
  // A pattern the scheduler cannot place — an unknown value, or 'custom'
  // with no interval — runs at nextRecurringDate's fallback gap (~quarterly),
  // so it reads as that gap here: a generic Tree & Shrub label under pattern
  // 'foo' is the retired four-visit plan by another name (codex r30 on
  // #4786). one_time is not a series and carries no cadence.
  // A one_time line is anchor-only whatever its interval column says
  // (scheduling ignores the interval), so a stale 90 does not read as the
  // quarterly plan (codex r32 on #4786).
  if (rawPattern === 'one_time') return 'one time';
  const { schedulerPlacesPattern, FALLBACK_RECURRENCE_GAP_DAYS } = require('./recurring-appointment-seeder');
  const fallsBack = rawPattern
    && (!schedulerPlacesPattern(rawPattern) || (rawPattern === 'custom' && !hasDays));
  return [
    rawPattern.replace(/_/g, ' '),
    hasDays ? `every ${days} days` : (fallsBack ? `every ${FALLBACK_RECURRENCE_GAP_DAYS} days` : ''),
  ].filter(Boolean).join(' ');
}

/**
 * Write-boundary twin of getServices' sellable exception, shared by every
 * booking write (create, edit): of the given service ids, the
 * retired-for-sale rows this customer does not hold (i.e. would be a new
 * sale). Empty array = booking allowed. `recurrence` ({ pattern,
 * intervalDays }) is the booking's structured cadence: each label is also
 * read with those words appended, so an ID-less "Tree & Shrub Care" booked
 * quarterly cannot bypass the label matcher. A `serviceTypes` entry may be
 * `{ label, recurrence }` for a line with its OWN cadence (an add-on
 * pattern — codex r22): that recurrence replaces the booking's for that
 * label; a plain string rides the booking's.
 */
async function retiredServicesNotHeldBy({ customerId, serviceIds, serviceTypes, recurrence = null } = {}) {
  const ids = new Set((serviceIds || []).filter((id) => UUID_RE.test(String(id || ''))).map(String));
  // Free-text bookings (Intelligence Bar, lead booking without a catalog
  // pick): exact key / name / short_name only, the first tier of
  // resolveServiceType — a partial match would refuse unrelated services.
  const { RETIRED_SALE_SERVICE_KEYS, retiredSaleKeyForLabel, labelMayNameRetiredSale } = require('./pricing-engine/retired-sale-catalog');
  const bookingCadence = recurrenceWords(recurrence);
  const labelled = (serviceTypes || [])
    .map((t) => (t && typeof t === 'object' ? { label: t.label, cadence: t.recurrence ? recurrenceWords(t.recurrence) : bookingCadence } : { label: t, cadence: bookingCadence }))
    .filter((t) => typeof t.label === 'string' && t.label.trim());
  // Only names that could be a retired row cost a catalog read.
  const names = new Set(labelled
    .flatMap((t) => [t.label, ...(t.cadence ? [`${t.label} ${t.cadence}`] : [])])
    .filter(labelMayNameRetiredSale).map((t) => t.trim().toLowerCase()));
  if (!ids.size && !names.size) return [];
  // Loose variants ("Quarterly Tree & Shrub", "T&S 4x") name the row too.
  const labelKeys = new Set([...names].map(retiredSaleKeyForLabel).filter(Boolean));
  const retiredRows = await db('services')
    .whereIn('service_key', [...RETIRED_SALE_SERVICE_KEYS])
    .select('id', 'service_key', 'name', 'short_name');
  const lower = (v) => String(v || '').trim().toLowerCase();
  const retired = (Array.isArray(retiredRows) ? retiredRows : []).filter((r) => ids.has(String(r.id))
    || names.has(lower(r.name)) || (r.short_name && names.has(lower(r.short_name)))
    || [...names].some((n) => n.replace(/\s+/g, '_') === r.service_key)
    || labelKeys.has(r.service_key));
  if (!retired.length) return [];
  const retiredIds = retired.map((r) => r.id);
  const retiredKeys = retired.map((r) => r.service_key);
  const retiredLabels = retired.flatMap((r) => [lower(r.name), lower(r.short_name)]).filter(Boolean);
  // A live row identified by catalog id, key snapshot or label (codex r24).
  const holderIdentity = (table, labelCol) => (row) => row
    .whereIn(`${table}.service_id`, retiredIds)
    .orWhereIn(`${table}.service_key_snapshot`, retiredKeys)
    .orWhereRaw(`lower(${table}.${labelCol}) = ANY(?)`, [retiredLabels]);
  const held = customerId && UUID_RE.test(String(customerId))
    ? [
      ...await whereCustomerHoldsService(
        db('scheduled_services').where(holderIdentity('scheduled_services', 'service_type')),
        String(customerId),
      ).select('scheduled_services.service_id as service_id', 'scheduled_services.service_key_snapshot as service_key_snapshot', 'scheduled_services.service_type as label'),
      // Held as an add-on line of a combined recurring visit (a one_time
      // add-on line is not a plan — codex r17 on #4786).
      ...await whereCustomerHoldsService(
        db('scheduled_service_addons')
          .join('scheduled_services', 'scheduled_services.id', 'scheduled_service_addons.scheduled_service_id')
          .where(holderIdentity('scheduled_service_addons', 'service_name'))
          .whereRaw(ADDON_LINE_IS_PLAN_SQL),
        String(customerId),
      ).select('scheduled_service_addons.service_id as service_id', 'scheduled_service_addons.service_key_snapshot as service_key_snapshot', 'scheduled_service_addons.service_name as label'),
    ]
    : [];
  const holds = (r) => held.some((row) => (row.service_id && String(row.service_id) === String(r.id))
    || (row.service_key_snapshot && row.service_key_snapshot === r.service_key)
    || [lower(r.name), lower(r.short_name)].filter(Boolean).includes(lower(row.label)));
  return retired.filter((r) => !holds(r));
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

  return { ...withSchedulingDuration(service), addons };
}

/**
 * Lookup by service_key
 */
async function getServiceByKey(serviceKey) {
  return withSchedulingDuration(await db('services').where({ service_key: serviceKey }).first());
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
    'customer_visible', 'booking_enabled', 'public_quote_selectable', 'sort_order', 'icon', 'color',
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
          if (!val.trim()) val = null;
          else {
            try { val = JSON.parse(val); } catch { throw validationError(`${key} must be valid JSON`); }
          }
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
  assertOperationalConsistency(insert);

  return db.transaction(async (trx) => {
    const [row] = await trx('services').insert(insert).returning('*');
    await writeCatalogAudit('create', { after: row, audit, trx });
    return row;
  }).then(refreshAfterCatalogWrite);
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
    'customer_visible', 'booking_enabled', 'public_quote_selectable', 'sort_order', 'icon', 'color',
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
          if (!val.trim()) val = null;
          else {
            try { val = JSON.parse(val); } catch { throw validationError(`${key} must be valid JSON`); }
          }
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

  // Only enforce when the update actually changes a pricing value — the
  // admin forms submit the full form on every save, so unchanged pricing
  // fields are always present; a pre-existing inconsistency on a legacy row
  // must not block unrelated edits (e.g. a rename). Compare after coercion
  // (pg returns numerics as strings, the form as numbers/'' ).
  const pricingChanged =
    (data.pricing_type !== undefined && update.pricing_type !== before.pricing_type)
    || ['base_price', 'price_range_min', 'price_range_max']
      .some((key) => data[key] !== undefined && numOrNull(update[key]) !== numOrNull(before[key]));
  if (pricingChanged) assertPricingConsistency({ ...before, ...update });
  const durationKeys = ['min_duration_minutes', 'default_duration_minutes', 'max_duration_minutes'];
  const displayed = withSchedulingDuration(before);
  const durationChanged = durationKeys.some(key => update[key] !== undefined
    && numOrNull(update[key]) !== numOrNull(displayed[key]));
  // Full-form clients echo the displayed policy. Preserve the raw defaults
  // unless a duration actually changed; partial edits retain effective bounds.
  if (displayed !== before) {
    for (const key of durationKeys) {
      if (!durationChanged) delete update[key];
      else if (update[key] === undefined) update[key] = displayed[key];
    }
  }
  if (durationChanged) update.scheduling_duration_policy = null;
  const operationalChanged = [
    'min_duration_minutes', 'default_duration_minutes', 'max_duration_minutes',
    'requires_follow_up', 'follow_up_interval_days',
  ].some((key) => update[key] !== undefined
    && JSON.stringify(update[key] ?? null) !== JSON.stringify(before[key] ?? null));
  if (operationalChanged) assertOperationalConsistency({ ...before, ...update });

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
  }).then(refreshAfterCatalogWrite);
}

// A renamed/created catalog service should display under its new name
// without waiting for the 10-minute refresh. Fire-and-forget: the write is
// already committed, so the admin response never waits on (or fails from)
// a display-cache query (codex P1).
function refreshAfterCatalogWrite(row) {
  refreshCatalogNames().catch((err) => {
    logger.error(`[service-library] catalog-name cache refresh failed: ${err.message}`);
  });
  return row;
}

/**
 * Soft-delete (deactivate)
 */
async function deactivateService(id, { audit } = {}) {
  // Reference guard and archive write share ONE transaction with the catalog
  // row locked (codex #3581). What the lock guarantees: concurrent archives
  // of the same row serialize, and the check + write see one consistent
  // snapshot instead of a pre-check that could go stale before the UPDATE.
  // What it does NOT guarantee: a writer that inserts a reference WITHOUT
  // reading this row under the same lock (name-based bookings, add-ons) can
  // still land after the check — full atomicity would need an advisory lock
  // taken by every reference writer, which is out of this change's scope.
  // Residual exposure is bounded: catalog resolution only links rows with
  // is_active = true (slot-reservation, estimate-converter), so an archived
  // row cannot be newly LINKED; a text-only late reference is a display
  // label, not a lane.
  return db.transaction(async (trx) => {
    // Table lock BEFORE the row lock: a capacity certification holding the
    // catalog SHARE lock later takes FOR KEY SHARE on this row through its
    // scheduled_services.service_id FK, and this UPDATE needs ROW EXCLUSIVE
    // behind that SHARE — row-first here deadlocks through the FK (codex
    // #4369 r4 P1). See scheduling/catalog-lock.js.
    await require('./scheduling/catalog-lock').lockCatalogForWrite(trx);
    const before = await trx('services').where({ id }).forUpdate().first();
    if (!before) return null;
    const references = await getServiceReferences(before, trx);
    if (references?.blocking_total > 0) {
      throw conflictError('Service is still referenced and cannot be archived', { references });
    }
    const [row] = await trx('services').where({ id }).update({ is_active: false, is_archived: true, updated_at: new Date() }).returning('*');
    if (row) await writeCatalogAudit('archive', { before, after: row, references, audit, trx });
    return row;
  });
}

/**
 * Lightweight dropdown list
 */
async function getDropdown({ sellable = false, sellableCustomerId = null } = {}) {
  let query = db('services')
    .select('id', 'service_key', 'name', 'short_name', 'icon', 'category', 'color', 'default_duration_minutes', 'base_price')
    .where({ is_active: true, is_archived: false });
  // A plan selector (annual prepay) offers only what its save accepts: the
  // same sellable, customer-scoped filter the booking pickers read.
  const filtered = sellable === true || sellable === 'true';
  if (filtered) query = applySellableFilter(query, sellableCustomerId);
  const rows = await query
    .orderBy('sort_order', 'asc')
    .orderBy('name', 'asc');
  if (!filtered) return rows;
  // Flag the grandfathered exception rows, as getServices does, so a selector
  // can tell "this customer holds the retired plan" from "it is not offered".
  const { RETIRED_SALE_SERVICE_KEYS } = require('./pricing-engine/retired-sale-catalog');
  return rows.map((s) => (RETIRED_SALE_SERVICE_KEYS.has(s.service_key) ? { ...s, retired_for_sale: true } : s));
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
async function updatePackage(id, data, { audit = {} } = {}) {
  const { packageData, items } = validatePackagePayload(data);
  return db.transaction(async (trx) => {
    const before = await trx('service_packages').where({ id }).forUpdate().first();
    if (!before) return null;
    const beforeItems = await trx('service_package_items').where({ package_id: id }).orderBy('sort_order');
    assertPackagePriceRange({ ...before, ...packageData });
    const update = { ...packageData, updated_at: new Date() };
    const [pkg] = await trx('service_packages').where({ id }).update(update).returning('*');

    if (items) {
      await trx('service_package_items').where({ package_id: id }).del();
      if (items.length > 0) {
        await trx('service_package_items').insert(items.map((item) => ({ ...item, package_id: id })));
      }
    }
    const afterItems = items || beforeItems;
    await auditServicePackageChange({
      tech_user_id: audit.actorId || null,
      package_id: id,
      change_type: 'update',
      changed_fields: [
        ...Object.keys(packageData),
        ...(items ? ['items'] : []),
      ],
      before: { ...before, items: beforeItems },
      after: { ...pkg, items: afterItems },
      ip_address: audit.ipAddress || null,
      user_agent: audit.userAgent || null,
      trx,
    });
    return pkg;
  });
}

function validatePackagePayload(data = {}) {
  const allowed = new Set([
    'name', 'tier', 'description', 'discount_pct', 'monthly_price_min',
    'monthly_price_max', 'is_active', 'features', 'sort_order',
  ]);
  const packageData = {};
  for (const [key, value] of Object.entries(data)) {
    if (allowed.has(key)) packageData[key] = value;
  }
  if (packageData.name !== undefined) {
    packageData.name = String(packageData.name || '').trim();
    if (!packageData.name) throw validationError('Package name is required');
  }
  for (const key of ['discount_pct', 'monthly_price_min', 'monthly_price_max', 'sort_order']) {
    if (packageData[key] === undefined || packageData[key] === null || packageData[key] === '') continue;
    const parsed = Number(packageData[key]);
    if (!Number.isFinite(parsed) || parsed < 0) throw validationError(`Invalid numeric value for ${key}`);
    if (key === 'discount_pct' && parsed > 100) throw validationError('Package discount cannot exceed 100');
    if (key === 'sort_order' && !Number.isInteger(parsed)) throw validationError('sort_order must be a whole number');
    packageData[key] = parsed;
  }
  if (packageData.is_active !== undefined) packageData.is_active = normalizeBoolean(packageData.is_active, 'is_active');
  assertPackagePriceRange(packageData);

  let items;
  if (data.items !== undefined) {
    if (!Array.isArray(data.items)) throw validationError('Package items must be an array');
    const seen = new Set();
    items = data.items.map((item, idx) => {
      const serviceId = String(item?.service_id || '');
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(serviceId)) throw validationError('Each package item requires a valid service_id');
      if (seen.has(serviceId)) throw validationError('A service can only appear once in a package');
      seen.add(serviceId);
      const includedVisits = item.included_visits === '' || item.included_visits == null ? null : Number(item.included_visits);
      const discount = item.addon_discount_pct === '' || item.addon_discount_pct == null ? null : Number(item.addon_discount_pct);
      const sortOrder = item.sort_order == null ? idx : Number(item.sort_order);
      if (includedVisits != null && (!Number.isInteger(includedVisits) || includedVisits < 0)) throw validationError('included_visits must be a non-negative whole number');
      if (discount != null && (!Number.isFinite(discount) || discount < 0 || discount > 100)) throw validationError('addon_discount_pct must be between 0 and 100');
      if (!Number.isInteger(sortOrder) || sortOrder < 0) throw validationError('Package item sort_order must be a non-negative whole number');
      return {
        service_id: serviceId,
        is_included: item.is_included === undefined ? true : normalizeBoolean(item.is_included, 'is_included'),
        included_visits: includedVisits,
        addon_discount_pct: discount,
        sort_order: sortOrder,
      };
    });
  }
  return { packageData, items };
}

function assertPackagePriceRange(data = {}) {
  if (data.monthly_price_min != null && data.monthly_price_max != null
    && Number(data.monthly_price_min) > Number(data.monthly_price_max)) {
    throw validationError('monthly_price_min cannot exceed monthly_price_max');
  }
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
  withSchedulingDuration,
  serviceDurationMinutes,
  getServices,
  retiredServicesNotHeldBy,
  ADDON_LINE_IS_PLAN_SQL,
  HOLDER_VISIT_IS_SERVICE_SQL,
  HOLDER_ADDON_IS_SERVICE_SQL,
  terminalHistoryStatuses,
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
    validatePackagePayload,
    assertPackagePriceRange,
  },
};
