const db = require('../models/db');
const logger = require('./logger');
const {
  ESIGN_DISCLOSURE,
  signerName,
} = require('./contracts');
const {
  buildCustomerDocumentContext,
  jsonb,
  renderDocumentTemplate,
  serializeTemplate,
} = require('./document-template-library');
const { deliverDocumentRequestChannels } = require('./document-contract-delivery');
const { addETDays, etDateString } = require('../utils/datetime-et');

const MAX_BULK_LIMIT = 250;
const DEFAULT_BULK_LIMIT = 100;
const DEFAULT_SKIP_RECENT_DAYS = 14;
const BULK_IN_FLIGHT_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const BULK_TEMPLATE_CATEGORY = 'marketing';
const BULK_TEMPLATE_DOCUMENT_TYPE = 'customer_guide';
const LIVE_SCHEDULED_SERVICE_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site'];
const GUIDE_TYPES = new Set(['all', 'pest', 'lawn']);
const CHANNELS = new Set(['sms']);
const AUDIENCES = new Set([
  'active_customers',
  'active_pest',
  'active_lawn',
  'upcoming_service',
  'recent_service',
  'all',
]);

const PEST_PATTERNS = [
  '%pest%',
  '%roach%',
  '%cockroach%',
  '%ant%',
  '%spider%',
  '%mosquito%',
  '%termite%',
  '%rodent%',
  '%rat%',
  '%mouse%',
  '%mice%',
  '%flea%',
  '%tick%',
  '%wasp%',
  '%bee%',
];

const LAWN_PATTERNS = [
  '%lawn%',
  '%turf%',
  '%weed%',
  '%fertil%',
  '%fungus%',
  '%chinch%',
  '%sedge%',
];

function clean(value) {
  return String(value || '').trim();
}

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeGuideType(value, fallback = 'all') {
  const guideType = clean(value || fallback).toLowerCase();
  return GUIDE_TYPES.has(guideType) ? guideType : fallback;
}

function normalizeChannel(value, fallback = 'sms') {
  const channel = clean(value || fallback).toLowerCase();
  const fallbackChannel = CHANNELS.has(fallback) ? fallback : 'sms';
  return CHANNELS.has(channel) ? channel : fallbackChannel;
}

function normalizeAudience(value, fallback = 'active_customers') {
  const audience = clean(value || fallback).toLowerCase();
  return AUDIENCES.has(audience) ? audience : fallback;
}

function bulkSelectorError(message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'INVALID_BULK_SEND_SELECTOR';
  return err;
}

function requireBulkSelector(input = {}, keys, allowed, label) {
  const body = input && typeof input === 'object' ? input : {};
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const rawValue = clean(body[key]);
    if (!rawValue) continue;
    const value = rawValue.toLowerCase();
    if (!allowed.has(value)) {
      throw bulkSelectorError(`Invalid bulk product guide ${label}: ${rawValue}`);
    }
    return value;
  }
  throw bulkSelectorError(`Bulk product guide sends require a valid ${label}.`);
}

function validateBulkSendSelectors(input = {}) {
  requireBulkSelector(input, ['audience'], AUDIENCES, 'audience');
  requireBulkSelector(input, ['guideType', 'guide_type'], GUIDE_TYPES, 'guide type');
  requireBulkSelector(input, ['channel', 'deliveryChannel', 'delivery_channel'], CHANNELS, 'delivery channel');
}

function channelsFor(channel) {
  const normalized = normalizeChannel(channel);
  if (normalized === 'both') return ['email', 'sms'];
  return [normalized];
}

function guideTypeForAudience(audience, guideType) {
  if (guideType && guideType !== 'all') return guideType;
  if (audience === 'active_pest') return 'pest';
  if (audience === 'active_lawn') return 'lawn';
  return normalizeGuideType(guideType, 'all');
}

function normalizeBulkOptions(input = {}) {
  const audience = normalizeAudience(input.audience);
  const guideType = guideTypeForAudience(audience, normalizeGuideType(input.guideType || input.guide_type || 'all'));
  return {
    audience,
    guideType,
    channel: normalizeChannel(input.channel || input.deliveryChannel || input.delivery_channel || 'sms'),
    search: clean(input.search),
    city: clean(input.city),
    days: clampInteger(input.days, 30, 1, 365),
    limit: clampInteger(input.limit, DEFAULT_BULK_LIMIT, 1, MAX_BULK_LIMIT),
    skipRecentDays: clampInteger(input.skipRecentDays ?? input.skip_recent_days, DEFAULT_SKIP_RECENT_DAYS, 0, 365),
    values: input.values && typeof input.values === 'object' ? input.values : {},
    allowUnresolved: input.allowUnresolved === true,
  };
}

function displayCustomerName(row = {}) {
  return clean(`${row.first_name || ''} ${row.last_name || ''}`)
    || clean(row.company_name)
    || clean(row.email)
    || clean(row.phone)
    || 'Customer';
}

function displayCustomerAddress(row = {}) {
  return [
    row.address_line1,
    row.address_line2,
    [row.city, row.state, row.zip].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ');
}

function serializeCustomer(row = {}) {
  return {
    id: row.id,
    name: displayCustomerName(row),
    email: row.email || null,
    phone: row.phone || null,
    address: displayCustomerAddress(row),
    city: row.city || null,
    tier: row.waveguard_tier || null,
    active: row.active !== false,
    pipelineStage: row.pipeline_stage || null,
    serviceTypes: row.service_types || '',
    lastServiceDate: row.last_service_date || null,
    nextServiceDate: row.next_service_date || null,
    duplicateContractId: row.duplicate_contract_id || null,
    duplicateCreatedAt: row.duplicate_created_at || null,
  };
}

function applyPatternMatch(builder, sqlExpression, patterns) {
  builder.where((inner) => {
    patterns.forEach((pattern, index) => {
      const method = index === 0 ? 'whereRaw' : 'orWhereRaw';
      inner[method](`LOWER(${sqlExpression}) LIKE ?`, [pattern]);
    });
  });
}

function applyServiceLineFilter(builder, sqlExpression, guideType) {
  if (guideType === 'lawn') {
    applyPatternMatch(builder, sqlExpression, LAWN_PATTERNS);
  } else if (guideType === 'pest') {
    applyPatternMatch(builder, sqlExpression, PEST_PATTERNS);
  }
}

function hasServiceLineFilter(guideType) {
  return guideType === 'pest' || guideType === 'lawn';
}

function recentDuplicateCutoff(skipRecentDays) {
  const days = clampInteger(skipRecentDays, DEFAULT_SKIP_RECENT_DAYS, 0, 365);
  if (days <= 0) return null;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function applyRecentDuplicateCondition(builder, templateKey, cutoff) {
  builder
    .from('customer_contracts as recent_cc')
    .whereRaw('recent_cc.customer_id = c.id')
    .where({
      'recent_cc.contract_type': 'document_template',
      'recent_cc.document_template_key': templateKey,
    })
    .whereNotNull('recent_cc.shared_at')
    .whereNotIn('recent_cc.status', ['cancelled', 'voided'])
    .where('recent_cc.created_at', '>=', cutoff);
}

function applyRecentDuplicateExclusion(query, templateKey, cutoff) {
  return query.whereNotExists(function recentDuplicateExists() {
    this.select(db.raw('1'));
    applyRecentDuplicateCondition(this, templateKey, cutoff);
  });
}

function applyServiceExistsFilter(query, guideType) {
  if (!hasServiceLineFilter(guideType)) return query;
  return query.where((outer) => {
    outer.whereExists(function serviceRecordExists() {
      this.select(db.raw('1'))
        .from('service_records as sr')
        .whereRaw('sr.customer_id = c.id');
      applyServiceLineFilter(this, "COALESCE(sr.service_line, sr.service_type, '')", guideType);
    }).orWhereExists(function scheduledServiceExists() {
      this.select(db.raw('1'))
        .from('scheduled_services as ss')
        .whereRaw('ss.customer_id = c.id')
        .whereIn('ss.status', LIVE_SCHEDULED_SERVICE_STATUSES);
      applyServiceLineFilter(this, "COALESCE(ss.service_type, '')", guideType);
    });
  });
}

function applyActiveCustomerFilter(query) {
  return query.where((builder) => {
    builder.where('c.active', true)
      .orWhereIn('c.pipeline_stage', ['active_customer', 'won']);
  });
}

function applyAudienceFilters(query, options) {
  const guideType = options.audience === 'active_pest'
    ? 'pest'
    : options.audience === 'active_lawn'
      ? 'lawn'
      : options.guideType;

  if (options.audience !== 'all') {
    applyActiveCustomerFilter(query);
  }

  if (options.search) {
    const needle = `%${options.search}%`;
    query.where((builder) => {
      builder.whereILike('c.first_name', needle)
        .orWhereILike('c.last_name', needle)
        .orWhereILike('c.company_name', needle)
        .orWhereILike('c.email', needle)
        .orWhereILike('c.phone', needle)
        .orWhereILike('c.address_line1', needle)
        .orWhereILike('c.city', needle)
        .orWhereRaw("CONCAT_WS(' ', c.first_name, c.last_name, c.company_name, c.address_line1, c.city, c.state, c.zip) ILIKE ?", [needle]);
    });
  }

  if (options.city) query.whereILike('c.city', `%${options.city}%`);

  if (options.audience === 'active_pest' || options.audience === 'active_lawn') {
    applyServiceExistsFilter(query, guideType);
  } else if (options.audience === 'upcoming_service') {
    const now = new Date();
    const todayEt = etDateString(now);
    const windowEndEt = etDateString(addETDays(now, options.days));
    query.whereExists(function upcomingExists() {
      this.select(db.raw('1'))
        .from('scheduled_services as ss')
        .whereRaw('ss.customer_id = c.id')
        .whereIn('ss.status', LIVE_SCHEDULED_SERVICE_STATUSES)
        .where('ss.scheduled_date', '>=', todayEt)
        .where('ss.scheduled_date', '<=', windowEndEt);
      applyServiceLineFilter(this, "COALESCE(ss.service_type, '')", guideType);
    });
  } else if (options.audience === 'recent_service') {
    const now = new Date();
    const windowStartEt = etDateString(addETDays(now, -options.days));
    query.whereExists(function recentExists() {
      this.select(db.raw('1'))
        .from('service_records as sr')
        .whereRaw('sr.customer_id = c.id')
        .where('sr.status', 'completed')
        .where('sr.service_date', '>=', windowStartEt);
      applyServiceLineFilter(this, "COALESCE(sr.service_line, sr.service_type, '')", guideType);
    });
  }

  return query;
}

function audienceBaseQuery(options) {
  return applyAudienceFilters(
    db('customers as c')
      .leftJoin('notification_prefs as np', 'c.id', 'np.customer_id')
      .whereNull('c.deleted_at'),
    options,
  );
}

function audienceSelect(query, todayEt = etDateString()) {
  return query.select(
    'c.id',
    'c.first_name',
    'c.last_name',
    'c.company_name',
    'c.email',
    'c.phone',
    'c.address_line1',
    'c.address_line2',
    'c.city',
    'c.state',
    'c.zip',
    'c.waveguard_tier',
    'c.active',
    'c.pipeline_stage',
    'np.email_enabled',
    'np.sms_enabled',
    'np.seasonal_tips',
    'np.created_at as notification_prefs_created_at',
    'np.updated_at as notification_prefs_updated_at',
    db.raw("(SELECT string_agg(DISTINCT service_type, ', ') FROM service_records WHERE service_records.customer_id = c.id) as service_types"),
    db.raw('(SELECT MAX(service_date) FROM service_records WHERE service_records.customer_id = c.id) as last_service_date'),
    db.raw(
      "(SELECT MIN(scheduled_date) FROM scheduled_services WHERE scheduled_services.customer_id = c.id AND scheduled_date >= ? AND status IN (?, ?, ?, ?)) as next_service_date",
      [todayEt, ...LIVE_SCHEDULED_SERVICE_STATUSES],
    ),
  );
}

async function loadAudience(options, templateKey = null) {
  const base = audienceBaseQuery(options);
  const countRow = await base.clone().countDistinct('c.id as count').first();
  const cutoff = templateKey ? recentDuplicateCutoff(options.skipRecentDays) : null;
  let duplicateSkipped = 0;
  let candidateQuery = base.clone();

  if (cutoff) {
    const duplicateRow = await base.clone()
      .whereExists(function recentDuplicateExists() {
        this.select(db.raw('1'));
        applyRecentDuplicateCondition(this, templateKey, cutoff);
      })
      .countDistinct('c.id as count')
      .first();
    duplicateSkipped = Number(duplicateRow?.count || 0);
    candidateQuery = applyRecentDuplicateExclusion(candidateQuery, templateKey, cutoff);
  }

  const rows = await audienceSelect(candidateQuery, etDateString())
    .groupBy(
      'c.id',
      'np.email_enabled',
      'np.sms_enabled',
      'np.seasonal_tips',
      'np.created_at',
      'np.updated_at',
    )
    .orderByRaw('LOWER(c.first_name) ASC NULLS LAST')
    .orderByRaw('LOWER(c.last_name) ASC NULLS LAST')
    .limit(options.limit);

  const total = Number(countRow?.count || 0);
  const candidateTotal = Math.max(0, total - duplicateSkipped);
  return {
    total,
    capped: candidateTotal > rows.length,
    duplicateSkipped,
    rows,
  };
}

function hasMarketingSmsConsent(row = {}) {
  return Boolean(clean(row.phone))
    && row.sms_enabled !== false
    && row.seasonal_tips === true;
}

function marketingSmsConsentBasis(row = {}) {
  if (!hasMarketingSmsConsent(row)) return null;
  return {
    status: 'opted_in',
    source: 'notification_prefs.seasonal_tips',
    capturedAt: row.notification_prefs_updated_at || row.notification_prefs_created_at || undefined,
  };
}

function channelsForCustomer(row, requestedChannels, { smsPurpose = 'document_request' } = {}) {
  const marketing = smsPurpose === 'marketing';
  return requestedChannels.filter((channel) => {
    if (channel === 'email') return Boolean(clean(row.email)) && row.email_enabled !== false;
    if (channel === 'sms' && marketing) return hasMarketingSmsConsent(row);
    if (channel === 'sms') return Boolean(clean(row.phone)) && row.sms_enabled !== false;
    return false;
  });
}

function customerEligibility(row, requestedChannels, options = {}) {
  const availableChannels = channelsForCustomer(row, requestedChannels, options);
  const marketing = options.smsPurpose === 'marketing';
  return {
    channels: availableChannels,
    sendable: availableChannels.length > 0 && !row.duplicate_contract_id,
    duplicate: Boolean(row.duplicate_contract_id),
    hasEmail: Boolean(clean(row.email)) && row.email_enabled !== false,
    hasSms: marketing ? hasMarketingSmsConsent(row) : Boolean(clean(row.phone)) && row.sms_enabled !== false,
  };
}

function productTitle(row = {}) {
  if (row.common_name && row.common_name !== row.name) return `${row.name} (${row.common_name})`;
  return row.name || row.common_name || 'Product';
}

function productSafetyLine(row = {}) {
  const parts = [];
  if (row.customer_safety_summary) parts.push(row.customer_safety_summary);
  if (row.pet_kid_guidance_text) parts.push(`People/pet guidance: ${row.pet_kid_guidance_text}`);
  if (row.reentry_text) parts.push(`Re-entry: ${row.reentry_text}`);
  if (row.rainfast_minutes) parts.push(`Rainfast: about ${row.rainfast_minutes} minutes.`);
  return parts.join(' ');
}

function formatProductGuideAppendix({ guideType = 'all', products = [] } = {}) {
  const title = guideType === 'lawn'
    ? 'Customer-facing lawn care product notes'
    : guideType === 'pest'
      ? 'Customer-facing pest control product notes'
      : 'Customer-facing product notes';

  const intro = [
    title,
    '',
    'This section only includes products that Waves has marked active, public, and approved for customer-facing publication. Product selection can change by pest, property condition, treatment zone, weather, label requirements, and technician findings. The service report shows what was actually applied at the property.',
  ];

  if (!products.length) {
    return [
      ...intro,
      '',
      'No product-specific rows are currently approved for this guide. Waves will still document products used on the service report and can answer safety or effectiveness questions before or after service.',
    ].join('\n');
  }

  const groups = new Map();
  for (const product of products) {
    const group = product.service_type || 'General';
    if (!groups.has(group)) groups.set(group, []);
    const list = groups.get(group);
    if (!list.some((item) => item.id === product.id)) list.push(product);
  }

  const lines = [...intro];
  for (const [serviceType, groupProducts] of groups.entries()) {
    lines.push('', serviceType);
    groupProducts.forEach((product) => {
      const details = [
        product.public_summary || product.portal_summary || null,
        product.active_ingredient ? `Active ingredient: ${product.active_ingredient}.` : null,
        product.epa_reg_number ? `EPA Reg. #${product.epa_reg_number}.` : null,
        productSafetyLine(product) || null,
      ].filter(Boolean).join(' ');
      lines.push(`- ${productTitle(product)}${details ? `: ${details}` : ''}`);
    });
  }
  return lines.join('\n');
}

async function loadProductGuide(guideType) {
  const hasUsage = await db.schema.hasTable('service_product_usage').catch(() => false);
  let query = db('products_catalog as p')
    .where({
      'p.active': true,
      'p.customer_visibility': 'public',
      'p.content_status': 'approved_for_public',
    });

  if (hasUsage) {
    query = query.leftJoin('service_product_usage as spu', 'p.id', 'spu.product_id');
    if (guideType === 'pest' || guideType === 'lawn') {
      applyServiceLineFilter(query, "COALESCE(spu.service_type, p.category, '')", guideType);
    }
  } else if (guideType === 'pest' || guideType === 'lawn') {
    query = query.whereRaw('1 = 0');
  }

  const rows = await query
    .select(
      'p.id',
      'p.name',
      'p.common_name',
      'p.category',
      'p.active_ingredient',
      'p.formulation',
      'p.epa_reg_number',
      'p.signal_word',
      'p.public_summary',
      'p.portal_summary',
      'p.customer_safety_summary',
      'p.pet_kid_guidance_text',
      'p.target_pests',
      'p.application_zones',
      'p.reentry_text',
      'p.rainfast_minutes',
      hasUsage ? db.raw("COALESCE(spu.service_type, 'General') as service_type") : db.raw("'General' as service_type"),
    )
    .orderBy('service_type', 'asc')
    .orderBy('p.name', 'asc');

  const uniqueProductIds = new Set(rows.map((row) => row.id));
  const serviceGroups = {};
  rows.forEach((row) => {
    const key = row.service_type || 'General';
    if (!serviceGroups[key]) serviceGroups[key] = new Set();
    serviceGroups[key].add(row.id);
  });

  return {
    guideType,
    productCount: uniqueProductIds.size,
    serviceGroups: Object.entries(serviceGroups).map(([serviceType, ids]) => ({
      serviceType,
      productCount: ids.size,
    })),
    appendix: formatProductGuideAppendix({ guideType, products: rows }),
  };
}

function splitTemplateRow(row = {}) {
  const activeVersion = row.active_version__id ? {
    id: row.active_version__id,
    template_id: row.active_version__template_id,
    version_number: row.active_version__version_number,
    title: row.active_version__title,
    body: row.active_version__body,
    signer_disclosure: row.active_version__signer_disclosure,
    variables: row.active_version__variables,
    required_fields: row.active_version__required_fields,
    created_by: row.active_version__created_by,
    published_at: row.active_version__published_at,
    created_at: row.active_version__created_at,
  } : null;
  return { template: row, activeVersion };
}

function isBulkGuideTemplate(template = {}) {
  return template.category === BULK_TEMPLATE_CATEGORY
    && template.document_type === BULK_TEMPLATE_DOCUMENT_TYPE
    && template.requires_signature === false;
}

function assertBulkGuideTemplate(template = {}) {
  if (isBulkGuideTemplate(template)) return;
  const err = new Error('Bulk product guide sends are only available for marketing customer guides that do not require e-signature.');
  err.status = 409;
  throw err;
}

async function loadTemplateByKey(key) {
  const row = await db('document_templates as dt')
    .leftJoin('document_template_versions as active_version', 'dt.active_version_id', 'active_version.id')
    .where('dt.template_key', key)
    .select(
      'dt.*',
      'active_version.id as active_version__id',
      'active_version.template_id as active_version__template_id',
      'active_version.version_number as active_version__version_number',
      'active_version.title as active_version__title',
      'active_version.body as active_version__body',
      'active_version.signer_disclosure as active_version__signer_disclosure',
      'active_version.variables as active_version__variables',
      'active_version.required_fields as active_version__required_fields',
      'active_version.created_by as active_version__created_by',
      'active_version.published_at as active_version__published_at',
      'active_version.created_at as active_version__created_at',
    )
    .first();
  return row ? splitTemplateRow(row) : null;
}

function buildCounts(rows, requestedChannels) {
  const counts = {
    loaded: rows.length,
    sendable: 0,
    duplicateSkipped: 0,
    emailEligible: 0,
    smsEligible: 0,
    missingEmail: 0,
    missingSms: 0,
    missingAnyRequestedChannel: 0,
  };
  rows.forEach((row) => {
    const eligibility = customerEligibility(row, requestedChannels, { smsPurpose: 'marketing' });
    if (eligibility.sendable) counts.sendable += 1;
    if (eligibility.duplicate) counts.duplicateSkipped += 1;
    if (eligibility.hasEmail) counts.emailEligible += 1;
    if (eligibility.hasSms) counts.smsEligible += 1;
    if (requestedChannels.includes('email') && !eligibility.hasEmail) counts.missingEmail += 1;
    if (requestedChannels.includes('sms') && !eligibility.hasSms) counts.missingSms += 1;
    if (!eligibility.channels.length) counts.missingAnyRequestedChannel += 1;
  });
  return counts;
}

function previewCopy(template, channel) {
  const title = template?.name || 'Waves document';
  if (channel === 'email') {
    return {
      subject: `${title} from Waves`,
      body: `Hi {first name}, Waves has a document ready for your review: ${title}.`,
    };
  }
  return {
    body: `Hi {first name}, Waves has a document ready for your review: ${title}. {link} Reply with any questions.`,
  };
}

async function previewBulkDocumentSend(templateKey, input = {}) {
  const options = normalizeBulkOptions(input);
  const loaded = await loadTemplateByKey(templateKey);
  if (!loaded) {
    const err = new Error('Document template not found');
    err.status = 404;
    throw err;
  }
  if (loaded.template.status !== 'active') {
    const err = new Error('Document template is not active');
    err.status = 409;
    throw err;
  }
  if (!loaded.activeVersion) {
    const err = new Error('Document template has no active version');
    err.status = 409;
    throw err;
  }
  assertBulkGuideTemplate(loaded.template);

  const requestedChannels = channelsFor(options.channel);
  const [audience, productGuide] = await Promise.all([
    loadAudience(options, loaded.template.template_key),
    loadProductGuide(options.guideType),
  ]);
  const counts = buildCounts(audience.rows, requestedChannels);
  const duplicateSkipped = audience.duplicateSkipped + counts.duplicateSkipped;

  return {
    template: serializeTemplate(loaded.template, loaded.activeVersion),
    options,
    counts: {
      matched: audience.total,
      capped: audience.capped,
      ...counts,
      duplicateSkipped,
    },
    productGuide: {
      guideType: productGuide.guideType,
      productCount: productGuide.productCount,
      serviceGroups: productGuide.serviceGroups,
    },
    sampleCustomers: audience.rows.slice(0, 10).map(serializeCustomer),
    copyPreview: {
      email: requestedChannels.includes('email') ? previewCopy(loaded.template, 'email') : null,
      sms: requestedChannels.includes('sms') ? previewCopy(loaded.template, 'sms') : null,
    },
  };
}

function insertContractEventPayload(req, metadata = {}) {
  return {
    actor_type: 'admin',
    actor_id: req.technicianId || null,
    ip: req.ip || null,
    user_agent: typeof req.get === 'function' ? req.get('user-agent') || null : null,
    metadata: jsonb(metadata, {}),
  };
}

function duplicateContractError(row = {}) {
  const err = new Error('A recent bulk product guide is already queued or sent for this customer.');
  err.status = 409;
  err.duplicateContract = true;
  err.existingContractId = row.id;
  err.existingContractCreatedAt = row.created_at;
  return err;
}

async function assertNoRecentBulkContract(trx, { customerId, templateKey, skipRecentDays }) {
  const lockedCustomer = await trx('customers')
    .where({ id: customerId })
    .forUpdate()
    .first('id');
  if (!lockedCustomer) {
    const err = new Error('Customer is no longer available for bulk document send.');
    err.status = 404;
    throw err;
  }

  const recentCutoff = recentDuplicateCutoff(skipRecentDays);
  const inFlightCutoff = new Date(Date.now() - BULK_IN_FLIGHT_DUPLICATE_WINDOW_MS);
  const existing = await trx('customer_contracts')
    .where({
      customer_id: customerId,
      contract_type: 'document_template',
      document_template_key: templateKey,
    })
    .whereNotIn('status', ['cancelled', 'voided'])
    .where((builder) => {
      builder.where((shared) => {
        shared.whereNotNull('shared_at');
        if (recentCutoff) shared.where('created_at', '>=', recentCutoff);
        else shared.whereRaw('1 = 0');
      }).orWhere((draft) => {
        draft.whereNull('shared_at').where('created_at', '>=', inFlightCutoff);
      });
    })
    .first('id', 'created_at');
  if (existing) throw duplicateContractError(existing);
}

async function createDocumentRequestForCustomer({ loaded, customer, productGuide, options, req, campaignId }) {
  const context = buildCustomerDocumentContext(customer, options.values);
  const rendered = renderDocumentTemplate({
    template: loaded.template,
    version: loaded.activeVersion,
    context,
  });
  if (rendered.unresolvedVariables.length && options.allowUnresolved !== true) {
    const err = new Error('Document has unresolved merge fields.');
    err.status = 400;
    err.unresolvedVariables = rendered.unresolvedVariables;
    throw err;
  }

  const body = [rendered.body, productGuide.appendix].filter(Boolean).join('\n\n');
  const recipientName = signerName(customer);
  const renderSummary = {
    ...rendered.renderSummary,
    bulkSend: true,
    campaignId,
    guideType: options.guideType,
    productCount: productGuide.productCount,
    serviceGroups: productGuide.serviceGroups,
  };

  return db.transaction(async (trx) => {
    await assertNoRecentBulkContract(trx, {
      customerId: customer.id,
      templateKey: loaded.template.template_key,
      skipRecentDays: options.skipRecentDays,
    });

    const [row] = await trx('customer_contracts').insert({
      customer_id: customer.id,
      created_by: req.technicianId || null,
      contract_type: 'document_template',
      title: rendered.title || loaded.activeVersion.title || loaded.template.name,
      status: 'draft',
      recipient_name: recipientName,
      recipient_email: customer.email || null,
      recipient_phone: customer.phone || null,
      service_name: context.service?.name || null,
      esign_disclosure_snapshot: loaded.activeVersion.signer_disclosure || ESIGN_DISCLOSURE,
      contract_text_snapshot: body,
      share_token_hash: null,
      share_token_expires_at: null,
      shared_at: null,
      document_template_id: loaded.template.id,
      document_template_version_id: loaded.activeVersion.id,
      document_template_key: loaded.template.template_key,
      requires_signature_snapshot: loaded.template.requires_signature !== false,
      document_variables_snapshot: jsonb(context, {}),
      document_render_summary: jsonb(renderSummary, {}),
    }).returning('*');

    await trx('customer_contract_events').insert({
      contract_id: row.id,
      customer_id: customer.id,
      event_type: 'created_from_document_template',
      ...insertContractEventPayload(req, {
        templateKey: loaded.template.template_key,
        templateVersionId: loaded.activeVersion.id,
        unresolvedVariables: rendered.unresolvedVariables,
        bulkSend: true,
        campaignId,
        guideType: options.guideType,
      }),
    });
    await trx('customer_contract_events').insert({
      contract_id: row.id,
      customer_id: customer.id,
      event_type: 'bulk_send_queued',
      ...insertContractEventPayload(req, {
        campaignId,
        channel: options.channel,
        guideType: options.guideType,
      }),
    });
    return row;
  });
}

async function cancelBulkContractAfterDeliveryFailure(contract, req, metadata = {}) {
  if (!contract?.id) return;
  await db.transaction(async (trx) => {
    const locked = await trx('customer_contracts')
      .where({ id: contract.id })
      .forUpdate()
      .first();
    if (!locked || ['cancelled', 'voided', 'signed'].includes(String(locked.status || '').toLowerCase())) return;
    const cancelledAt = new Date();
    await trx('customer_contracts').where({ id: locked.id }).update({
      status: 'cancelled',
      cancelled_at: cancelledAt,
      cancelled_reason: 'Bulk product guide delivery failed before any channel sent.',
      share_token_hash: null,
      share_token_expires_at: null,
      shared_at: null,
      updated_at: cancelledAt,
    });
    await trx('customer_contract_events').insert({
      contract_id: locked.id,
      customer_id: locked.customer_id,
      event_type: 'bulk_send_cancelled',
      ...insertContractEventPayload(req, metadata),
    });
  });
}

async function sendBulkDocument(templateKey, input = {}, req = {}) {
  validateBulkSendSelectors(input);
  const options = normalizeBulkOptions(input);
  const loaded = await loadTemplateByKey(templateKey);
  if (!loaded) {
    const err = new Error('Document template not found');
    err.status = 404;
    throw err;
  }
  if (loaded.template.status !== 'active') {
    const err = new Error('Document template is not active');
    err.status = 409;
    throw err;
  }
  if (!loaded.activeVersion) {
    const err = new Error('Document template has no active version');
    err.status = 409;
    throw err;
  }
  assertBulkGuideTemplate(loaded.template);

  const requestedChannels = channelsFor(options.channel);
  const [audience, productGuide] = await Promise.all([
    loadAudience(options, loaded.template.template_key),
    loadProductGuide(options.guideType),
  ]);
  const campaignId = `bulk-doc-${Date.now().toString(36)}`;
  const results = [];
  const summary = {
    campaignId,
    matched: audience.total,
    loaded: audience.rows.length,
    capped: audience.capped,
    attempted: 0,
    created: 0,
    sentEmail: 0,
    sentSms: 0,
    failed: 0,
    skippedDuplicate: 0,
    skippedMissingContact: 0,
    skippedUnresolved: 0,
  };

  for (const customer of audience.rows) {
    const serializedCustomer = serializeCustomer(customer);
    if (customer.duplicate_contract_id) {
      summary.skippedDuplicate += 1;
      results.push({ customer: serializedCustomer, status: 'skipped_duplicate' });
      continue;
    }

    const sendChannels = channelsForCustomer(customer, requestedChannels, { smsPurpose: 'marketing' });
    if (!sendChannels.length) {
      summary.skippedMissingContact += 1;
      results.push({ customer: serializedCustomer, status: 'skipped_missing_contact' });
      continue;
    }

    summary.attempted += 1;
    let contract;
    try {
      contract = await createDocumentRequestForCustomer({
        loaded,
        customer,
        productGuide,
        options,
        req,
        campaignId,
      });
      summary.created += 1;
      const delivery = await deliverDocumentRequestChannels(contract.id, req, {
        channels: sendChannels,
        action: 'send',
        smsPurpose: 'marketing',
        smsConsentBasis: marketingSmsConsentBasis(customer),
        smsEntryPoint: 'bulk_product_safety_guide_send',
        smsMetadata: {
          original_message_type: 'bulk_product_safety_guide',
          bulkCampaignId: campaignId,
          guideType: options.guideType,
        },
      });
      delivery.deliveries.forEach((item) => {
        if (item.ok && item.channel === 'email') summary.sentEmail += 1;
        if (item.ok && item.channel === 'sms') summary.sentSms += 1;
      });
      if (!delivery.ok) {
        summary.failed += 1;
        await cancelBulkContractAfterDeliveryFailure(contract, req, {
          campaignId,
          guideType: options.guideType,
          delivery,
        });
      }
      results.push({
        customer: serializedCustomer,
        status: delivery.ok ? 'sent' : 'failed',
        contractId: contract.id,
        deliveries: delivery.deliveries,
      });
    } catch (err) {
      if (err.duplicateContract) {
        summary.skippedDuplicate += 1;
        results.push({
          customer: serializedCustomer,
          status: 'skipped_duplicate',
          contractId: err.existingContractId,
        });
        continue;
      }
      if (err.unresolvedVariables) summary.skippedUnresolved += 1;
      else summary.failed += 1;
      if (contract) {
        await cancelBulkContractAfterDeliveryFailure(contract, req, {
          campaignId,
          guideType: options.guideType,
          error: err.message,
        }).catch((cancelErr) => {
          logger.warn(`[bulk-doc-send] failed to cancel unsent contract ${contract.id}: ${cancelErr.message}`);
        });
      }
      logger.warn(`[bulk-doc-send] failed for customer ${customer.id}: ${err.message}`);
      results.push({
        customer: serializedCustomer,
        status: err.unresolvedVariables ? 'skipped_unresolved' : 'failed',
        error: err.message,
        unresolvedVariables: err.unresolvedVariables || undefined,
      });
    }
  }

  return {
    template: serializeTemplate(loaded.template, loaded.activeVersion),
    options,
    productGuide: {
      guideType: productGuide.guideType,
      productCount: productGuide.productCount,
      serviceGroups: productGuide.serviceGroups,
    },
    summary: {
      ...summary,
      skippedDuplicate: audience.duplicateSkipped + summary.skippedDuplicate,
    },
    results: results.slice(0, 100),
  };
}

module.exports = {
  MAX_BULK_LIMIT,
  previewBulkDocumentSend,
  sendBulkDocument,
  _internals: {
    channelsFor,
    channelsForCustomer,
    formatProductGuideAppendix,
    hasMarketingSmsConsent,
    duplicateContractError,
    isBulkGuideTemplate,
    marketingSmsConsentBasis,
    normalizeBulkOptions,
    normalizeGuideType,
    normalizeAudience,
    normalizeChannel,
    validateBulkSendSelectors,
    recentDuplicateCutoff,
  },
};
