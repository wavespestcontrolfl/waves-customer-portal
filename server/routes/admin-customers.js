const express = require('express');
const router = express.Router();
const db = require('../models/db');
const LeadScorer = require('../services/lead-scorer');
const PipelineManager = require('../services/pipeline-manager');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');
const { recordAuditEvent } = require('../services/audit-log');
const PhotoService = require('../services/photos');
const { acceptanceServiceLists } = require('./estimate-public');
const AccountMembershipEmail = require('../services/account-membership-email');
const { listCustomerPrepaidPlans } = require('../services/prepaid-series');
const { shortenOrPassthrough, invoiceShortCodePrefix } = require('../services/short-url');
const { publicPortalUrl } = require('../utils/portal-url');
const { documentRequiresSignature } = require('../services/contracts');
const CustomerCredit = require('../services/customer-credit');

router.use(adminAuthenticate, requireTechOrAdmin);

function dateOnlyForApi(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).split('T')[0].slice(0, 10);
}

const NON_MEMBERSHIP_TIER_KEYS = new Set(['none', 'onetime', 'na', 'no', 'notset']);

function membershipTierKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function comparableMembershipTier(value) {
  const tierKey = membershipTierKey(value);
  return NON_MEMBERSHIP_TIER_KEYS.has(tierKey) ? '' : tierKey;
}

function comparableMonthlyRate(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function hasMembership(customer = {}) {
  const rawTier = customer.waveguard_tier ?? customer.tier;
  const tierKey = membershipTierKey(rawTier);
  if (tierKey && NON_MEMBERSHIP_TIER_KEYS.has(tierKey)) return false;
  if (tierKey) return true;
  return Number(customer.monthly_rate ?? customer.monthlyRate ?? 0) > 0;
}

function membershipDetailsChanged(before = {}, after = {}) {
  return comparableMembershipTier(before.waveguard_tier ?? before.tier) !== comparableMembershipTier(after.waveguard_tier ?? after.tier)
    || comparableMonthlyRate(before.monthly_rate ?? before.monthlyRate) !== comparableMonthlyRate(after.monthly_rate ?? after.monthlyRate);
}

function membershipChangeFingerprint(before = {}, after = {}) {
  return [
    comparableMembershipTier(before.waveguard_tier ?? before.tier) || 'none',
    comparableMonthlyRate(before.monthly_rate ?? before.monthlyRate),
    comparableMembershipTier(after.waveguard_tier ?? after.tier) || 'none',
    comparableMonthlyRate(after.monthly_rate ?? after.monthlyRate),
  ].join(':');
}

function adminMembershipDailyIdempotencyKey(eventType, customerId, source, eventAt = new Date()) {
  return `${eventType}:${customerId}:${source}:${etDateString(eventAt)}`;
}

function adminMembershipStartIdempotencyKey(customerId, before = {}, after = {}, eventAt = new Date()) {
  const eventStamp = eventAt instanceof Date && !Number.isNaN(eventAt.getTime())
    ? eventAt.toISOString()
    : new Date().toISOString();
  return `membership.started:${customerId}:admin:${etDateString(eventAt)}:${eventStamp}:${membershipChangeFingerprint(before, after)}`;
}

const CUSTOMER_STAGES = [
  'new_lead', 'contacted', 'estimate_sent', 'estimate_viewed', 'follow_up',
  'negotiating', 'won', 'active_customer', 'at_risk', 'churned', 'lost', 'dormant',
];
const CUSTOMER_STAGE_SET = new Set(CUSTOMER_STAGES);

const SERVICE_KEY_ALIASES = {
  pest_control: ['pest_general_quarterly'],
  pest_initial_roach: ['pest_initial_cleanout'],
  german_roach: ['pest_initial_cleanout'],
  german_roach_initial: ['pest_initial_cleanout'],
  lawn_care: ['lawn_care_recurring'],
  tree_shrub: ['tree_shrub_program'],
  mosquito: ['mosquito_monthly'],
  termite_bait: ['termite_bait'],
  termite_bait_installation: ['termite_bait'],
  rodent_bait: ['rodent_bait_quarterly', 'rodent_monitoring'],
  rodent_bait_station: ['rodent_bait_quarterly', 'rodent_monitoring'],
  rodent_bait_stations: ['rodent_bait_quarterly', 'rodent_monitoring'],
  rodent_monitoring: ['rodent_monitoring'],
  rodent_trapping: ['rodent_exclusion'],
  rodent_exclusion: ['rodent_exclusion'],
  trenching: ['termite_liquid'],
  termite_liquid: ['termite_liquid'],
  wdo: ['wdo_inspection'],
  wdo_inspection: ['wdo_inspection'],
  flea: ['flea_tick'],
  flea_exterior: ['flea_tick'],
  fire_ant: ['fire_ant'],
  bee_wasp: ['bee_wasp_removal'],
  bee_wasp_removal: ['bee_wasp_removal'],
  palm_injection: ['palm_treatment'],
  palm_treatment: ['palm_treatment'],
};

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function moneyOrNull(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return Math.round(n * 100) / 100;
  }
  return null;
}

function normalizeServiceKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function cadenceFromEstimateLine(line, fallback = 'one_time') {
  const frequency = String(line?.frequency || line?.freq || line?.cadence || '').toLowerCase();
  const frequencyKey = frequency.replace(/[-_\s]+/g, '');
  const visits = Number(line?.visitsPerYear ?? line?.visits_per_year ?? line?.visits ?? line?.apps);
  if (frequencyKey.includes('bimonthly') || frequencyKey.includes('every2month') || frequencyKey.includes('everyothermonth')) return 'bimonthly';
  if (frequencyKey.includes('triannual') || frequencyKey.includes('every4month')) return 'triannual';
  if (frequencyKey.includes('semiannual') || frequencyKey.includes('biannual') || frequencyKey.includes('every6month')) return 'semiannual';
  if (frequencyKey.includes('quarter') || frequencyKey.includes('every3month')) return 'quarterly';
  if (frequencyKey.includes('monthly') || frequencyKey === 'month') return 'monthly';
  if (frequencyKey.includes('annual') || frequencyKey.includes('year')) return 'annual';
  if (visits === 12) return 'monthly';
  if (visits === 6) return 'bimonthly';
  if (visits === 4) return 'quarterly';
  if (visits === 3) return 'triannual';
  if (visits === 2) return 'semiannual';
  if (visits === 1 && fallback !== 'one_time') return 'annual';
  return fallback;
}

function indexServicesForSchedule(rows = []) {
  const byKey = new Map();
  const byName = new Map();
  for (const row of rows) {
    if (row.service_key) byKey.set(normalizeServiceKey(row.service_key), row);
    if (row.name) byName.set(normalizeServiceKey(row.name), row);
    if (row.short_name) byName.set(normalizeServiceKey(row.short_name), row);
  }
  return { byKey, byName, rows };
}

function serviceCatalogMatch(line, serviceIndex) {
  const rawKey = normalizeServiceKey(line?.service || line?.serviceKey || line?.key || '');
  const labelKey = normalizeServiceKey(line?.name || line?.label || line?.displayName || '');
  const candidates = [
    rawKey,
    labelKey,
    ...(SERVICE_KEY_ALIASES[rawKey] || []),
    ...(SERVICE_KEY_ALIASES[labelKey] || []),
  ].filter(Boolean);

  for (const key of candidates) {
    const exact = serviceIndex.byKey.get(normalizeServiceKey(key)) || serviceIndex.byName.get(normalizeServiceKey(key));
    if (exact) return exact;
  }

  const text = `${rawKey} ${labelKey}`.replace(/_/g, ' ');
  const pick = (key) => serviceIndex.byKey.get(key);
  if (/rodent|rat|mouse/.test(text) && /monitor|monthly/.test(text)) return pick('rodent_monitoring');
  if (/rodent|rat|mouse/.test(text) && /bait|station/.test(text)) return pick('rodent_bait_quarterly') || pick('rodent_monitoring');
  if (/rodent|rat|mouse|exclusion|trapping/.test(text)) return pick('rodent_exclusion');
  if (/termite|wdo|subterranean|sentricon/.test(text) && /install|station|bait/.test(text)) return pick('termite_bait');
  if (/termite|wdo/.test(text) && /inspect|letter/.test(text)) return pick('wdo_inspection');
  if (/termite|trench|liquid/.test(text)) return pick('termite_liquid');
  if (/tree|shrub|ornamental/.test(text)) return pick('tree_shrub_program');
  if (/mosquito/.test(text)) return pick('mosquito_monthly');
  if (/lawn|turf|weed|fertil/.test(text)) return pick('lawn_care_recurring');
  if (/flea|tick/.test(text)) return pick('flea_tick');
  if (/fire\s*ant/.test(text)) return pick('fire_ant');
  if (/bee|wasp|hornet|yellow/.test(text)) return pick('bee_wasp_removal');
  if (/pest|roach|ant|spider/.test(text)) {
    if (/monthly/.test(text)) return pick('pest_general_monthly');
    return pick('pest_general_quarterly') || pick('pest_initial_cleanout');
  }
  return null;
}

function isSchedulableOneTimeEstimateLine(line) {
  const kind = String(line?.kind || '').toLowerCase();
  const status = String(line?.status || '').toLowerCase();
  if (kind === 'discount' || kind === 'quote_required' || line?.quoteRequired === true || status === 'quote_required') return false;

  const rawAmount = [
    line?.priceAfterDiscount,
    line?.amountAfterDiscount,
    line?.totalAfterDiscount,
    line?.price,
    line?.amount,
    line?.total,
  ].find((value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)));
  if (rawAmount != null && Number(rawAmount) < 0) return false;

  const service = normalizeServiceKey(line?.service || line?.serviceKey || line?.key || '');
  const label = normalizeServiceKey(line?.displayName || line?.label || line?.name || line?.serviceName || '');
  const detail = normalizeServiceKey(line?.detail || line?.description || '');
  const text = `${service} ${label} ${detail}`;

  if (service === 'waveguard_setup') return false;
  if (text.includes('membership_setup_fee')) return false;
  return !(text.includes('waveguard') && (text.includes('setup') || text.includes('membership')));
}

function formatEstimateLine(line, { kind, estimate, serviceIndex }) {
  const name = String(line?.displayName || line?.label || line?.name || line?.serviceName || line?.service || '').trim();
  if (!name) return null;
  const price = kind === 'recurring'
    ? moneyOrNull(
        line?.perTreatment,
        line?.perApp,
        line?.perVisit,
        line?.pricePerVisit,
        line?.priceAfterDiscount,
        line?.amountAfterDiscount,
        line?.totalAfterDiscount,
        line?.price,
        line?.amount,
        line?.total,
        line?.mo,
        line?.monthly,
      )
    : moneyOrNull(line?.priceAfterDiscount, line?.amountAfterDiscount, line?.totalAfterDiscount, line?.price, line?.amount, line?.total);
  if (kind !== 'recurring' && price == null) return null;

  const matched = serviceCatalogMatch({ ...line, name }, serviceIndex);
  const cadence = kind === 'recurring' ? cadenceFromEstimateLine(line, 'quarterly') : 'one_time';
  return {
    serviceId: matched?.id || null,
    serviceKey: matched?.service_key || line?.service || null,
    name: matched?.name || name,
    estimateLabel: name,
    category: matched?.category || null,
    billingType: matched?.billing_type || (kind === 'recurring' ? 'recurring' : 'one_time'),
    frequency: matched?.frequency || line?.frequency || null,
    visitsPerYear: matched?.visits_per_year || line?.visitsPerYear || null,
    duration: matched?.default_duration_minutes || null,
    price,
    cadence,
    source: kind,
    estimateId: estimate.id,
  };
}

function scheduleLinesFromEstimate(estimate, serviceIndex) {
  const estData = parseJsonObject(estimate.estimate_data);
  let recurringSvcList = [];
  let oneTimeList = [];
  try {
    const lists = acceptanceServiceLists(estData);
    recurringSvcList = lists.recurringSvcList || [];
    oneTimeList = lists.oneTimeList || [];
  } catch {
    recurringSvcList = [];
    oneTimeList = [];
  }
  const schedulableOneTimeList = oneTimeList.filter(isSchedulableOneTimeEstimateLine);
  const monthlyTotal = Number(estimate.monthly_total || 0);
  const annualTotal = Number(estimate.annual_total || 0);
  const hasRecurringEstimateTotal = monthlyTotal > 0 || annualTotal > 0;
  const onlyFilteredBillingRows = recurringSvcList.length === 0
    && oneTimeList.length > 0
    && schedulableOneTimeList.length === 0;
  const suppressFallback = onlyFilteredBillingRows && !hasRecurringEstimateTotal;

  const lines = [
    ...recurringSvcList.map((line) => formatEstimateLine(line, { kind: 'recurring', estimate, serviceIndex })),
    ...schedulableOneTimeList.map((line) => formatEstimateLine(line, { kind: 'one_time', estimate, serviceIndex })),
  ].filter(Boolean);

  if (lines.length === 1 && lines[0].price == null) {
    lines[0].price = moneyOrNull(estimate.onetime_total, estimate.monthly_total);
  }

  if (lines.length === 0 && !suppressFallback) {
    const annualMonthlyEquivalent = annualTotal > 0
      ? annualTotal / 12
      : null;
    const fallbackPrice = hasRecurringEstimateTotal
      ? moneyOrNull(monthlyTotal > 0 ? monthlyTotal : null, annualMonthlyEquivalent)
      : moneyOrNull(estimate.onetime_total, estimate.monthly_total);
    const fallbackName = estimate.service_interest || estimate.waveguard_tier || 'Accepted estimate';
    const matched = serviceCatalogMatch({ name: fallbackName }, serviceIndex);
    const fallbackIsRecurring = hasRecurringEstimateTotal;
    lines.push({
      serviceId: matched?.id || null,
      serviceKey: matched?.service_key || null,
      name: matched?.name || fallbackName,
      estimateLabel: fallbackName,
      category: matched?.category || null,
      billingType: matched?.billing_type || (fallbackIsRecurring ? 'recurring' : 'one_time'),
      frequency: matched?.frequency || null,
      visitsPerYear: matched?.visits_per_year || null,
      duration: matched?.default_duration_minutes || null,
      price: fallbackPrice,
      cadence: fallbackIsRecurring ? 'quarterly' : 'one_time',
      source: fallbackIsRecurring ? 'recurring' : 'one_time',
      estimateId: estimate.id,
    });
  }

  const seen = new Set();
  return lines.filter((line) => {
    const key = `${line.serviceId || line.name}|${line.price ?? ''}|${line.cadence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

let healthScoreColumnsCache = null;

async function getHealthScoreColumns() {
  if (healthScoreColumnsCache) return healthScoreColumnsCache;
  try {
    const exists = await db.schema.hasTable('customer_health_scores');
    if (!exists) {
      healthScoreColumnsCache = new Set();
      return healthScoreColumnsCache;
    }
    const result = await db.raw(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'customer_health_scores'"
    );
    healthScoreColumnsCache = new Set((result.rows || []).map(r => r.column_name));
    return healthScoreColumnsCache;
  } catch (err) {
    logger.warn(`[customers] health score column detection failed: ${err.message}`);
    healthScoreColumnsCache = new Set();
    return healthScoreColumnsCache;
  }
}

function latestHealthScoreRaw(columns) {
  const scoreCol = columns.has('overall_score')
    ? 'overall_score'
    : columns.has('health_score')
      ? 'health_score'
      : null;
  if (!scoreCol) return db.raw('NULL as health_score');
  const orderCol = columns.has('scored_at')
    ? 'scored_at'
    : columns.has('score_date')
      ? 'score_date'
      : columns.has('created_at')
        ? 'created_at'
        : 'id';
  return db.raw(`(
    SELECT ${scoreCol}
    FROM customer_health_scores
    WHERE customer_health_scores.customer_id = customers.id
    ORDER BY ${orderCol} DESC
    LIMIT 1
  ) as health_score`);
}

async function latestHealthScoreForCustomer(customerId) {
  const columns = await getHealthScoreColumns();
  if (!columns.size) return null;
  const orderCol = columns.has('scored_at')
    ? 'scored_at'
    : columns.has('score_date')
      ? 'score_date'
      : columns.has('created_at')
        ? 'created_at'
        : 'id';
  return db('customer_health_scores')
    .where({ customer_id: customerId })
    .orderBy(orderCol, 'desc')
    .first()
    .catch(e => {
      logger.warn(`[customers:${customerId}] health_scores: ${e.message}`);
      return null;
    });
}

function isValidStage(stage) {
  return !stage || CUSTOMER_STAGE_SET.has(stage);
}

function mapPipelineCustomer(c, stage = c.pipeline_stage) {
  return {
    id: c.id,
    firstName: c.first_name || '',
    lastName: c.last_name || '',
    name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
    accountId: c.account_id,
    profileLabel: c.profile_label,
    address: `${c.address_line1 || ''}, ${c.city || ''}`.replace(/^,\s*|\s*,\s*$/g, ''),
    phone: c.phone,
    tier: c.waveguard_tier,
    monthlyRate: parseFloat(c.monthly_rate || 0),
    leadScore: c.lead_score,
    leadSource: c.lead_source,
    pipelineStage: stage,
    stageEnteredAt: c.pipeline_stage_changed_at,
    pipelineStageChangedAt: c.pipeline_stage_changed_at,
    nextFollowUp: c.next_follow_up_date,
  };
}

function mapCustomerListRow(c) {
  return {
    id: c.id, firstName: c.first_name, lastName: c.last_name,
    accountId: c.account_id, profileLabel: c.profile_label,
    isPrimaryProfile: !!c.is_primary_profile,
    email: c.email, phone: c.phone, city: c.city,
    serviceContactName: c.service_contact_name,
    serviceContactPhone: c.service_contact_phone,
    serviceContactEmail: c.service_contact_email,
    serviceContact2Name: c.service_contact2_name,
    serviceContact2Phone: c.service_contact2_phone,
    serviceContact2Email: c.service_contact2_email,
    serviceContact3Name: c.service_contact3_name,
    serviceContact3Phone: c.service_contact3_phone,
    serviceContact3Email: c.service_contact3_email,
    address: `${c.address_line1 || ''}, ${c.city || ''}, ${c.state || ''} ${c.zip || ''}`.trim(),
    tier: c.waveguard_tier, monthlyRate: parseFloat(c.monthly_rate || 0),
    memberSince: c.member_since, active: c.active,
    pipelineStage: c.pipeline_stage, leadScore: c.lead_score,
    leadSource: c.lead_source, leadSourceDetail: c.lead_source_detail,
    landingPageUrl: c.landing_page_url, companyName: c.company_name,
    propertyType: c.property_type,
    lastContactDate: c.last_contact_date, lastContactType: c.last_contact_type,
    nextFollowUp: c.next_follow_up_date,
    lifetimeRevenue: parseFloat(c.lifetime_revenue || 0),
    totalServices: parseInt(c.total_services || c.services_count || 0),
    lastServiceDate: c.last_service_date, nextServiceDate: c.next_service_date,
    serviceTypes: c.service_types || '',
    serviceCount: parseInt(c.service_type_count || 0),
    lastRating: c.last_rating != null ? parseInt(c.last_rating) : null,
    tags: (c.tags_str || '').split(',').filter(Boolean),
    balanceOwed: parseFloat(c.balance_owed || 0),
    healthScore: c.health_score != null ? parseInt(c.health_score) : null,
    cardsOnFile: parseInt(c.cards_on_file || 0),
  };
}

const SERVICE_CONTACT_SLOT_FIELDS = [
  ['service_contact_name', 'service_contact_phone', 'service_contact_email'],
  ['service_contact2_name', 'service_contact2_phone', 'service_contact2_email'],
  ['service_contact3_name', 'service_contact3_phone', 'service_contact3_email'],
];

function compactServiceContactSlots(updates, before = {}) {
  const hasServiceContactUpdate = SERVICE_CONTACT_SLOT_FIELDS
    .flat()
    .some((field) => Object.prototype.hasOwnProperty.call(updates, field));
  if (!hasServiceContactUpdate) return updates;

  const normalizedValue = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    return value;
  };

  const compacted = SERVICE_CONTACT_SLOT_FIELDS
    .map((fields) => fields.map((field) => (
      Object.prototype.hasOwnProperty.call(updates, field)
        ? normalizedValue(updates[field])
        : normalizedValue(before[field])
    )))
    .filter((slot) => slot.some((value) => value !== null));

  SERVICE_CONTACT_SLOT_FIELDS.forEach((fields, index) => {
    const slot = compacted[index] || [null, null, null];
    fields.forEach((field, fieldIndex) => {
      updates[field] = slot[fieldIndex];
    });
  });

  return updates;
}

function customerSearchTerms(value) {
  return String(value || '')
    .trim()
    .match(/[a-z0-9]+/gi) || [];
}

function applyCustomerListFilters(query, filters) {
  const { search, stage, tier, tag, source, area, city, cards, hasBalance, lastVisited } = filters;
  if (search) {
    const s = `%${search}%`;
    const isPhoneLike = /^[\d\s().+\-]+$/.test(search);
    const phoneDigits = isPhoneLike ? String(search).replace(/\D/g, '') : '';
    const terms = customerSearchTerms(search);
    const searchableTextSql = `
      CONCAT_WS(' ',
        first_name,
        last_name,
        company_name,
        phone,
        email,
        address_line1,
        address_line2,
        city,
        state,
        zip,
        account_id,
        profile_label
      )
    `;
    query = query.where(function () {
      this.whereILike('first_name', s).orWhereILike('last_name', s)
        .orWhereILike('phone', s).orWhereILike('email', s)
        .orWhereILike('address_line1', s).orWhereILike('city', s)
        .orWhereILike('company_name', s)
        .orWhereILike('state', s).orWhereILike('zip', s)
        .orWhereILike('profile_label', s)
        .orWhereRaw('account_id::text ILIKE ?', [s])
        .orWhereRaw("(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) ILIKE ?", [s])
        .orWhereRaw(`${searchableTextSql} ILIKE ?`, [s]);
      if (terms.length > 1) {
        this.orWhere(function () {
          terms.forEach((term) => {
            this.whereRaw(`${searchableTextSql} ILIKE ?`, [`%${term}%`]);
          });
        });
      }
      if (phoneDigits.length >= 3) {
        this.orWhereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${phoneDigits}%`]);
      }
    });
  }
  if (stage) query = query.where('pipeline_stage', stage);
  if (tier === 'none') query = query.whereNull('waveguard_tier');
  else if (tier) query = query.where('waveguard_tier', tier);
  if (city) query = query.whereILike('city', `%${city}%`);
  if (source) query = query.where('lead_source', source);
  if (area) query = query.whereILike('city', `%${area}%`);
  if (tag) query = query.whereExists(function () {
    this.select('*').from('customer_tags').whereRaw('customer_tags.customer_id = customers.id').where('tag', tag);
  });
  if (cards === 'has') {
    query = query.whereExists(function () {
      this.select(db.raw('1')).from('payment_methods').whereRaw('payment_methods.customer_id = customers.id');
    });
  } else if (cards === 'none') {
    query = query.whereNotExists(function () {
      this.select(db.raw('1')).from('payment_methods').whereRaw('payment_methods.customer_id = customers.id');
    });
  }
  if (hasBalance === 'true' || hasBalance === true) {
    query = query.whereExists(function () {
      this.select('customer_id').from('invoices')
        .whereRaw('invoices.customer_id = customers.id')
        .whereIn('status', ['sent', 'viewed', 'overdue'])
        .groupBy('customer_id')
        .havingRaw('COALESCE(SUM(total), 0) > 0');
    });
  }
  if (lastVisited && lastVisited !== 'all') {
    if (lastVisited === 'never') {
      query = query.whereNotExists(function () {
        this.select(db.raw('1')).from('service_records').whereRaw('service_records.customer_id = customers.id');
      });
    } else {
      const days = parseInt(lastVisited, 10);
      if (Number.isFinite(days) && days >= 0) {
        query = query.whereExists(function () {
          this.select('customer_id').from('service_records')
            .whereRaw('service_records.customer_id = customers.id')
            .groupBy('customer_id')
            .havingRaw('MAX(service_date) >= ?::date - (? * INTERVAL \'1 day\')', [etDateString(), days]);
        });
      }
    }
  }
  return query;
}

async function auditCustomerMutation(req, action, customerId, metadata = {}, critical = false, trx = null) {
  await recordAuditEvent({
    actor_type: 'technician',
    actor_id: req.technicianId || null,
    action,
    resource_type: 'customer',
    resource_id: customerId,
    metadata,
    ip_address: req.ip,
    user_agent: req.get('user-agent') || null,
    critical,
    trx,
  });
}

function phoneLast10(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function cleanText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function cleanOptionalText(value) {
  const cleaned = cleanText(value);
  return cleaned || null;
}

function cleanEmail(value) {
  const cleaned = cleanText(value).toLowerCase();
  return cleaned || null;
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(value) || '');
}

function comparableEmail(value) {
  return String(value || '').trim().toLowerCase();
}

const ADMIN_NOTIFICATION_PREF_BOOLEAN_FIELDS = [
  ['autoFlipEnRoute', 'auto_flip_en_route'],
  ['paymentConfirmationSms', 'payment_confirmation_sms'],
  ['appointmentNotifyPrimary', 'appointment_notify_primary'],
  ['serviceReportNotifyPrimary', 'service_report_notify_primary'],
];

const ANNUAL_PREPAY_PAYMENT_METHODS = new Set(['cash', 'check', 'zelle', 'card_present', 'other']);

// Advisory-lock namespace for serializing per-customer annual-prepay creation,
// so hashtext(customerId) can't collide with locks taken elsewhere.
const ANNUAL_PREPAY_LOCK_NS = 0x4150;

// Statuses that still represent a binding annual-prepay commitment for overlap
// checks: payment_pending / active / renewal_pending / renewed / switch_plan,
// PLUS a renewal-LAPSED term (status='cancelled' with renewal_decision='cancel')
// whose already-paid coverage runs through term_end — matching
// AnnualPrepayRenewals.getActivelyCoveredCustomerIds. A refund sets
// status='cancelled' with a NULL renewal_decision and is intentionally NOT
// treated as overlapping (it re-enables a fresh prepay).
function annualPrepayOverlapStatusClause() {
  return function overlapStatus() {
    this.whereIn('status', ['payment_pending', 'active', 'renewal_pending', 'renewed', 'switch_plan'])
      .orWhere(function lapsedRenewalStillInTerm() {
        this.where('status', 'cancelled').andWhere('renewal_decision', 'cancel');
      });
  };
}

// Acquire a per-customer advisory lock (released at txn commit/rollback) and
// re-check for an overlapping annual-prepay term INSIDE the transaction. The
// pre-flight check before the txn is a fast UX path only; without this guard two
// concurrent submissions (double-click, or two admins) can both pass that check
// and create duplicate invoices/terms/payments. Throws a tagged error the route
// translates to a 409. Statuses mirror the pre-flight overlap query.
async function lockAndAssertNoAnnualPrepayOverlap(trx, customerId, termStart, allowOverlap, errorPrefix) {
  await trx.raw('SELECT pg_advisory_xact_lock(?, hashtext(?))', [ANNUAL_PREPAY_LOCK_NS, String(customerId)]);
  if (allowOverlap === true) return;
  const activeTerm = await trx('annual_prepay_terms')
    .where({ customer_id: customerId })
    .where(annualPrepayOverlapStatusClause())
    .orderBy('term_end', 'desc')
    .first();
  const activeTermEnd = dateOnlyForApi(activeTerm?.term_end);
  if (activeTermEnd && termStart <= activeTermEnd) {
    const message = `${errorPrefix} ${activeTermEnd}. Use a start date after ${activeTermEnd}.`;
    const err = new Error(message);
    err.annualPrepayOverlap = { error: message, activeTermId: activeTerm.id, activeTermEnd };
    throw err;
  }
}

function parseAnnualPrepayAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: 'amount must be greater than 0' };
  }
  return { amount: Math.round((amount + 1e-9) * 100) / 100 };
}

function parseAnnualPrepayVisitCount(value) {
  const count = Number.parseInt(value, 10);
  if (!Number.isInteger(count) || count <= 0) {
    return { error: 'visitCount must be greater than 0' };
  }
  return { visitCount: Math.min(count, 24) };
}

function parseDateOnlyInput(value, field) {
  if (value === undefined || value === null || value === '') return { date: null };
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return { error: `${field} must be YYYY-MM-DD` };
  }
  const d = new Date(`${text}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text) {
    return { error: `${field} must be a valid date` };
  }
  return { date: text };
}

function addDaysDateOnly(value, days) {
  const text = dateOnlyForApi(value) || etDateString();
  const d = new Date(`${text}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function addMonthsDateOnly(value, months) {
  const text = dateOnlyForApi(value) || etDateString();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const monthIndex = month - 1 + Number(months || 0);
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonthIndex = ((monthIndex % 12) + 12) % 12;
  const targetMonth = targetMonthIndex + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0, 12)).getUTCDate();
  return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

function defaultAnnualPrepayTermStart(activeTerm, today = etDateString()) {
  const termEnd = dateOnlyForApi(activeTerm?.term_end || activeTerm?.termEnd);
  // Mirror the client default (Customer360ProfileV2 defaultAnnualPrepayStart) on
  // the server so a direct/API call without termStart can't bypass it: a
  // payment_pending term that STILL covers today is sent-but-unpaid, so a new
  // term must cover that same window (its term_start) rather than advancing to
  // term_end + 1 — advancing past an unpaid term would slip past
  // lockAndAssertNoAnnualPrepayOverlap (which counts payment_pending) and stack a
  // second paid term beyond the open invoice. An EXPIRED pending window (term_end
  // before today) is moot, so fall through to the term_end+1/today default and
  // don't block a fresh prepay on a stale unpaid row.
  if (activeTerm && activeTerm.status === 'payment_pending' && termEnd && termEnd >= today) {
    return dateOnlyForApi(activeTerm.term_start || activeTerm.termStart) || today;
  }
  if (termEnd && termEnd >= today) return addDaysDateOnly(termEnd, 1);
  return today;
}

function mapAnnualPrepayTerm(term) {
  if (!term) return null;
  return {
    id: term.id,
    customerId: term.customer_id,
    sourceEstimateId: term.source_estimate_id,
    prepayInvoiceId: term.prepay_invoice_id,
    prepayInvoiceNumber: term.prepay_invoice_number,
    prepayInvoiceStatus: term.prepay_invoice_status,
    prepayInvoiceTotal: term.prepay_invoice_total != null ? Number(term.prepay_invoice_total) : null,
    prepayInvoiceSubtotal: term.prepay_invoice_subtotal != null ? Number(term.prepay_invoice_subtotal) : null,
    planLabel: term.plan_label,
    monthlyRate: term.monthly_rate != null ? Number(term.monthly_rate) : null,
    prepayAmount: term.prepay_amount != null ? Number(term.prepay_amount) : null,
    coverageServiceType: term.coverage_service_type || null,
    coverageVisitCount: term.coverage_visit_count != null ? Number(term.coverage_visit_count) : null,
    coverageCadence: term.coverage_cadence || null,
    termStart: dateOnlyForApi(term.term_start),
    termEnd: dateOnlyForApi(term.term_end),
    status: term.status,
    lastScheduledServiceId: term.last_scheduled_service_id,
    lastScheduledServiceDate: dateOnlyForApi(term.last_scheduled_service_date),
    lastScheduledServiceType: term.last_scheduled_service_type,
    notice30SentAt: term.notice_30_sent_at,
    notice15SentAt: term.notice_15_sent_at,
    notice7SentAt: term.notice_7_sent_at,
    renewalContactedAt: term.renewal_contacted_at,
    renewalContactedBy: term.renewal_contacted_by,
    renewalDecision: term.renewal_decision,
    renewalDecisionAt: term.renewal_decision_at,
    renewalNotes: term.renewal_notes,
    createdAt: term.created_at,
    updatedAt: term.updated_at,
  };
}

function adminNotificationPrefsDbUpdates(body = {}, existing = {}) {
  const dbUpdates = {};

  for (const [bodyField, dbField] of ADMIN_NOTIFICATION_PREF_BOOLEAN_FIELDS) {
    if (body[bodyField] === undefined) continue;
    if (typeof body[bodyField] !== 'boolean') {
      return { error: `${bodyField} must be true or false.` };
    }
    dbUpdates[dbField] = body[bodyField];
  }

  if (body.billingEmail !== undefined) {
    const billingEmail = cleanEmail(body.billingEmail);
    if (billingEmail && !isEmailLike(billingEmail)) {
      return { error: 'Enter a valid billing recipient email.' };
    }
    if (billingEmail && billingEmail.length > 200) {
      return { error: 'Billing recipient email must be 200 characters or fewer.' };
    }
    dbUpdates.billing_email = billingEmail || null;
    const emailChanged = comparableEmail(billingEmail) !== comparableEmail(existing.billing_email);
    if (!billingEmail || (emailChanged && body.billingContactName === undefined)) {
      dbUpdates.billing_contact_name = null;
    }
  }
  if (body.billingContactName !== undefined) {
    const billingContactName = cleanOptionalText(body.billingContactName);
    const effectiveBillingEmail = dbUpdates.billing_email !== undefined
      ? dbUpdates.billing_email
      : cleanEmail(existing.billing_email);
    if (effectiveBillingEmail) {
      dbUpdates.billing_contact_name = billingContactName
        ? billingContactName.slice(0, 120)
        : null;
    }
  }

  return { dbUpdates };
}

function cleanState(value) {
  const cleaned = cleanText(value).toUpperCase();
  return cleaned ? cleaned.slice(0, 2) : 'FL';
}

function cleanOptionalState(value) {
  const cleaned = cleanText(value).toUpperCase();
  return cleaned ? cleaned.slice(0, 2) : null;
}

async function createDefaultCustomerRows(trx, customerId) {
  await trx('property_preferences')
    .insert({ customer_id: customerId })
    .onConflict('customer_id')
    .ignore();
  await trx('notification_prefs')
    .insert({ customer_id: customerId })
    .onConflict('customer_id')
    .ignore();
}

async function attachMatchedCustomerToAccount(trx, customer) {
  if (!customer) return null;
  if (customer.account_id) return customer.account_id;

  const accountId = customer.id;
  await trx('customer_accounts')
    .insert({
      id: accountId,
      first_name: customer.first_name,
      last_name: customer.last_name,
      phone: customer.phone || null,
      email: customer.email ? String(customer.email).trim().toLowerCase() : null,
      company_name: customer.company_name || null,
      created_at: customer.created_at || new Date(),
      updated_at: new Date(),
    })
    .onConflict('id')
    .ignore();

  await trx('customers')
    .where({ id: customer.id })
    .update({
      account_id: accountId,
      is_primary_profile: customer.is_primary_profile === false ? false : true,
      profile_label: customer.profile_label || 'Primary',
      updated_at: new Date(),
    });

  return accountId;
}

async function findAccountByContact(trx, { phone }) {
  const digits = phoneLast10(phone);
  if (digits) {
    const byCustomerPhone = await trx('customers')
      .whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${digits}`])
      .whereNull('deleted_at')
      .orderBy('is_primary_profile', 'desc')
      .orderBy('created_at', 'asc')
      .first();
    if (byCustomerPhone) {
      const accountId = await attachMatchedCustomerToAccount(trx, byCustomerPhone);
      return { accountId, existingCustomer: { ...byCustomerPhone, account_id: accountId }, matchType: 'phone' };
    }
  }

  return null;
}

async function ensureCustomerAccount(trx, input) {
  const existing = await findAccountByContact(trx, input);
  if (existing?.accountId) return existing;

  const [account] = await trx('customer_accounts').insert({
    first_name: input.firstName,
    last_name: input.lastName,
    phone: input.phone || null,
    email: input.email ? String(input.email).trim().toLowerCase() : null,
    company_name: input.companyName || null,
  }).returning('*');

  return { accountId: account.id, existingCustomer: null, matchType: null };
}

async function accountPropertySummary(accountId, excludeCustomerId = null) {
  if (!accountId) return [];
  let query = db('customers')
    .where({ account_id: accountId })
    .whereNull('deleted_at')
    .select('id', 'profile_label', 'address_line1', 'city', 'state', 'zip', 'pipeline_stage', 'monthly_rate', 'is_primary_profile')
    .orderBy('is_primary_profile', 'desc')
    .orderBy('created_at', 'asc');
  if (excludeCustomerId) query = query.whereNot({ id: excludeCustomerId });
  return query;
}

async function findCrossAccountContactConflict(customerId, accountId, updates) {
  const normalizedAccountId = accountId ? String(accountId) : null;
  const conflicts = [];

  if (updates.phone !== undefined) {
    const digits = phoneLast10(updates.phone);
    if (digits) {
      const rows = await db('customers')
        .whereNull('deleted_at')
        .whereNot({ id: customerId })
        .whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${digits}`])
        .select('id', 'account_id', 'first_name', 'last_name', 'phone');
      const conflict = rows.find((row) => String(row.account_id || row.id) !== normalizedAccountId);
      if (conflict) conflicts.push({ field: 'phone', customer: conflict });
    }
  }

  if (updates.email !== undefined) {
    const email = cleanEmail(updates.email);
    if (email) {
      const rows = await db('customers')
        .whereNull('deleted_at')
        .whereNot({ id: customerId })
        .whereRaw('LOWER(email) = ?', [email])
        .select('id', 'account_id', 'first_name', 'last_name', 'email');
      const conflict = rows.find((row) => String(row.account_id || row.id) !== normalizedAccountId);
      if (conflict) conflicts.push({ field: 'email', customer: conflict });
    }
  }

  return conflicts[0] || null;
}

// --- Static POST routes (must be registered before /:id handlers to avoid route shadowing) ---

// POST /api/admin/customers/fix-tiers — Recalculate tiers from service count
router.post('/fix-tiers', requireAdmin, async (req, res, next) => {
  try {
    const customers = await db('customers')
      .select('customers.id', 'customers.waveguard_tier')
      .whereIn('customers.pipeline_stage', ['active_customer', 'won'])
      .whereNull('deleted_at');

    let updated = 0;
    for (const c of customers) {
      const services = await db('scheduled_services')
        .where({ customer_id: c.id })
        .whereIn('status', ['scheduled', 'confirmed', 'completed'])
        .countDistinct('service_type as count')
        .first();

      const count = parseInt(services?.count || 0);
      let newTier = null;
      if (count === 0) newTier = null;
      else if (count === 1) newTier = 'Bronze';
      else if (count === 2) newTier = 'Silver';
      else if (count === 3) newTier = 'Gold';
      else newTier = 'Platinum';

      if (newTier !== c.waveguard_tier) {
        await db('customers').where({ id: c.id }).update({ waveguard_tier: newTier });
        updated++;
      }
    }

    logger.info(`[customers] Fix tiers: ${updated} of ${customers.length} customers updated`);
    res.json({ success: true, updated, total: customers.length });
  } catch (err) { next(err); }
});

// POST /api/admin/customers/backfill-review-status — flip has_left_google_review = true
// for any customer who already has a matched (non-_stats) row in google_reviews.
// One-shot helper for the ~170 historical reviewers; safe to re-run (idempotent —
// preserves the original review_marked_at on rows that are already true).
router.post('/backfill-review-status', requireAdmin, async (req, res, next) => {
  try {
    const dryRun = req.body?.dryRun === true;
    const matchedIds = await db('google_reviews')
      .whereNotNull('customer_id')
      .where('reviewer_name', '!=', '_stats')
      .distinct('customer_id')
      .pluck('customer_id');

    if (matchedIds.length === 0) {
      return res.json({ success: true, matched: 0, updated: 0, alreadyFlagged: 0, dryRun });
    }

    const candidates = await db('customers')
      .whereIn('id', matchedIds)
      .whereNull('deleted_at')
      .select('id', 'has_left_google_review');

    const toFlip = candidates.filter(c => !c.has_left_google_review).map(c => c.id);
    const alreadyFlagged = candidates.length - toFlip.length;

    if (!dryRun && toFlip.length > 0) {
      await db('customers')
        .whereIn('id', toFlip)
        .update({ has_left_google_review: true, review_marked_at: new Date() });
    }

    logger.info(`[customers] Review-status backfill: ${toFlip.length} flipped, ${alreadyFlagged} already flagged${dryRun ? ' (dry run)' : ''}`);
    res.json({ success: true, matched: candidates.length, updated: dryRun ? 0 : toFlip.length, alreadyFlagged, dryRun });
  } catch (err) { next(err); }
});

// POST /api/admin/customers/quick-add — minimal customer creation from appointment modal
router.post('/quick-add', requireAdmin, async (req, res, next) => {
  try {
    const { firstName, lastName, phone, email, address, addressLine1, city, state, zip, profileLabel, leadSource, pipelineStage, tags, notes } = req.body;
    if (!firstName || !phone) {
      return res.status(400).json({ error: 'firstName and phone required' });
    }
    const normalized = {
      firstName: cleanText(firstName),
      lastName: cleanText(lastName),
      phone: cleanText(phone),
      email: cleanEmail(email),
      address: cleanText(addressLine1 || address),
      city: cleanText(city),
      state: cleanState(state),
      zip: cleanText(zip),
      profileLabel: cleanOptionalText(profileLabel),
      leadSource: cleanOptionalText(leadSource) || 'admin_manual',
      pipelineStage: cleanText(pipelineStage) || 'new_lead',
      notes: cleanOptionalText(notes),
    };
    if (!normalized.firstName || !normalized.phone) {
      return res.status(400).json({ error: 'firstName and phone required' });
    }
    if (!isValidStage(normalized.pipelineStage)) return res.status(400).json({ error: 'Invalid pipeline stage' });

    const customer = await db.transaction(async (trx) => {
      const account = await ensureCustomerAccount(trx, normalized);
      const siblingCount = await trx('customers').where({ account_id: account.accountId }).whereNull('deleted_at').count('* as count').first();
      const [created] = await trx('customers').insert({
        account_id: account.accountId,
        is_primary_profile: !account.existingCustomer,
        profile_label: normalized.profileLabel || (account.existingCustomer ? 'Rental property' : 'Primary'),
        first_name: normalized.firstName,
        last_name: normalized.lastName || null,
        phone: normalized.phone,
        email: normalized.email,
        address_line1: normalized.address,
        city: normalized.city,
        state: normalized.state,
        zip: normalized.zip,
        pipeline_stage: normalized.pipelineStage,
        pipeline_stage_changed_at: new Date(),
        lead_source: normalized.leadSource,
        crm_notes: normalized.notes,
        active: true,
      }).returning('*');
      await createDefaultCustomerRows(trx, created.id);
      if (Array.isArray(tags) && tags.length) {
        for (const tag of tags) {
          const cleanTag = cleanText(tag);
          if (cleanTag) {
            await trx('customer_tags').insert({ customer_id: created.id, tag: cleanTag }).onConflict(['customer_id', 'tag']).ignore();
          }
        }
      }
      return { ...created, _attachedToExistingAccount: !!account.existingCustomer, _propertyCount: Number(siblingCount?.count || 0) + 1 };
    });

    logger.info(`[customers] Quick-add created customer_id=${customer.id} account_id=${customer.account_id || customer.id}`);

    res.status(201).json({
      customer: {
        id: customer.id,
        firstName: customer.first_name,
        lastName: customer.last_name,
        phone: customer.phone,
        accountId: customer.account_id,
        profileLabel: customer.profile_label,
        attachedToExistingAccount: customer._attachedToExistingAccount,
        propertyCount: customer._propertyCount,
        address: `${customer.address_line1 || ''}, ${customer.city || ''}, ${customer.state || ''} ${customer.zip || ''}`.trim(),
        city: customer.city,
        state: customer.state,
        zip: customer.zip,
        tier: customer.waveguard_tier,
      },
    });
  } catch (err) { next(err); }
});

// GET /api/admin/customers — directory + pipeline
router.get('/', async (req, res, next) => {
  try {
    // Default sort: last name, then first name, ascending (phonebook
    // alphabetical). The old default was lead_score desc + limit 100,
    // which meant the client's local alphabetical re-sort only covered
    // the top-100-by-lead-score slice. Anything beyond that fell off
    // the end of the list — looked like "not alphabetical" to operators
    // working large customer bases.
    const {
      search, stage, tier, tag, source, area, city,
      cards, hasBalance, lastVisited,
      sort = 'name', order = 'asc',
    } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));

    if (stage && !isValidStage(stage)) return res.status(400).json({ error: 'Invalid pipeline stage' });

    const filters = { search, stage, tier, tag, source, area, city, cards, hasBalance, lastVisited };
    const healthScoreSelect = latestHealthScoreRaw(await getHealthScoreColumns());
    let query = applyCustomerListFilters(db('customers').whereNull('customers.deleted_at'), filters).select(
      'customers.*',
      db.raw('(SELECT COUNT(*) FROM service_records WHERE service_records.customer_id = customers.id) as services_count'),
      db.raw("(SELECT MAX(service_date) FROM service_records WHERE service_records.customer_id = customers.id) as last_service_date"),
      db.raw("(SELECT MIN(scheduled_date) FROM scheduled_services WHERE scheduled_services.customer_id = customers.id AND scheduled_date >= CURRENT_DATE AND status NOT IN ('cancelled','canceled','completed','rescheduled','skipped','no_show')) as next_service_date"),
      db.raw("(SELECT string_agg(tag, ',') FROM customer_tags WHERE customer_tags.customer_id = customers.id) as tags_str"),
      db.raw("(SELECT string_agg(DISTINCT service_type, ',') FROM service_records WHERE service_records.customer_id = customers.id) as service_types"),
      db.raw("(SELECT COUNT(DISTINCT service_type) FROM scheduled_services WHERE scheduled_services.customer_id = customers.id AND status NOT IN ('cancelled')) as service_type_count"),
      // rating column may not exist — use satisfaction_rating from treatment_outcomes or skip
      db.raw("(SELECT NULL) as last_rating"),
      db.raw("(SELECT COALESCE(SUM(total), 0) FROM invoices WHERE invoices.customer_id = customers.id AND status IN ('sent', 'viewed', 'overdue')) as balance_owed"),
      healthScoreSelect,
      db.raw("(SELECT COUNT(*) FROM payment_methods WHERE payment_methods.customer_id = customers.id) as cards_on_file"),
    );

    // Alphabetical by first name only — operator preference. No tie-break
    // on last name or other columns. NULLS LAST keeps blank-first-name
    // rows pinned to the end of the list instead of the top.
    const dir = order === 'desc' ? 'desc' : 'asc';
    if (sort === 'name') {
      query = query.orderByRaw(`LOWER(first_name) ${dir} NULLS LAST`);
    } else {
      const sortCol = { lead_score: 'lead_score', rate: 'monthly_rate', last_contact: 'last_contact_date', revenue: 'lifetime_revenue' }[sort] || 'first_name';
      query = query.orderBy(sortCol, dir);
    }

    const total = await applyCustomerListFilters(
      db('customers').whereNull('customers.deleted_at'),
      filters
    ).count('* as count').first();
    const totalCount = parseInt(total?.count || 0);
    const offset = (page - 1) * limit;
    const customers = await query.limit(limit).offset(offset);

    // Pipeline counts
    const pipelineCounts = await db('customers').whereNull('deleted_at').select('pipeline_stage').count('* as count').groupBy('pipeline_stage');
    const pipelineMap = {};
    pipelineCounts.forEach(p => { pipelineMap[p.pipeline_stage || 'unknown'] = parseInt(p.count); });

    // Available filters
    const allTags = await db('customer_tags').select('tag').groupBy('tag').orderBy('tag');
    const allSources = await db('customers').whereNull('deleted_at').select('lead_source').whereNotNull('lead_source').groupBy('lead_source');
    const allAreas = await db('customers').whereNull('deleted_at').select('city').whereNotNull('city').where('city', '!=', '').groupBy('city').orderBy('city');

    res.json({
      customers: customers.map(mapCustomerListRow),
      total: totalCount, page, limit,
      totalPages: Math.max(1, Math.ceil(totalCount / limit)),
      pipelineCounts: pipelineMap,
      filters: {
        tags: allTags.map(t => t.tag),
        sources: allSources.map(s => s.lead_source).filter(Boolean),
        areas: allAreas.map(a => a.city).filter(Boolean),
      },
    });
  } catch (err) { next(err); }
});

// GET /api/admin/customers/pipeline — kanban view
router.get('/pipeline/view', async (req, res, next) => {
  try {
    const limitPerStage = Math.min(500, Math.max(1, parseInt(req.query.limitPerStage) || 100));
    const result = {};
    const flatCustomers = [];

    for (const stage of CUSTOMER_STAGES) {
      const stageQuery = db('customers')
        .where({ pipeline_stage: stage })
        .whereNull('deleted_at');
      const [countRow, revenueRow] = await Promise.all([
        stageQuery.clone().count('* as count').first(),
        stageQuery.clone().sum('monthly_rate as total').first(),
      ]);
      const customers = await db('customers')
        .where({ pipeline_stage: stage })
        .whereNull('deleted_at')
        .select('*')
        .orderBy('lead_score', 'desc')
        .limit(limitPerStage);

      const mappedCustomers = customers.map(c => mapPipelineCustomer(c, stage));
      flatCustomers.push(...mappedCustomers);

      result[stage] = {
        count: parseInt(countRow?.count || 0),
        monthlyRevenue: parseFloat(revenueRow?.total || 0),
        customers: mappedCustomers,
      };
    }

    res.json({ pipeline: result, customers: flatCustomers });
  } catch (err) { next(err); }
});

// GET /api/admin/customers/:id/cards — just the saved payment methods.
// Lightweight endpoint so the MobilePaymentSheet's Card on File picker
// doesn't have to load the full customer profile (tags, interactions,
// services, etc.) every time the tech opens the payment sheet.
router.get('/:id/cards', async (req, res, next) => {
  try {
    const cards = await db('payment_methods')
      .where({ customer_id: req.params.id })
      .orderBy('is_default', 'desc')
      .orderBy('created_at', 'desc');
    res.json({
      cards: cards.map((c) => ({
        id: c.id,
        method_type: c.method_type,
        brand: c.card_brand,
        last_four: c.last_four,
        exp_month: c.exp_month,
        exp_year: c.exp_year,
        bank_name: c.bank_name,
        is_default: !!c.is_default,
      })),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/customers/:id/timeline — unified customer timeline
router.get('/:id/timeline', async (req, res, next) => {
  try {
    const customerId = req.params.id;
    const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const timeline = [];

    // customer_interactions
    const interactions = await db('customer_interactions').where({ customer_id: customerId }).select('interaction_type', 'subject', 'body', 'created_at');
    for (const i of interactions) {
      timeline.push({
        type: 'interaction', title: i.subject || `${i.interaction_type} interaction`,
        description: i.body || '', date: i.created_at,
        metadata: { interactionType: i.interaction_type },
      });
    }

    // sms + voice via unified messages (since PR 2). Joined to conversations
    // so we can attribute to this customer regardless of whether the
    // historical row had customer_id set on sms_log/call_log directly.
    try {
      const comms = await db('messages')
        .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
        .where('conversations.customer_id', customerId)
        .whereIn('messages.channel', ['sms', 'voice'])
        .select(
          'messages.channel', 'messages.direction', 'messages.body',
          'messages.ai_summary', 'messages.duration_seconds',
          'messages.created_at',
          'conversations.contact_phone', 'conversations.our_endpoint_id'
        );
      for (const m of comms) {
        if (m.channel === 'sms') {
          timeline.push({
            type: 'sms',
            title: `SMS ${m.direction === 'inbound' ? 'received' : 'sent'}`,
            description: (m.body || '').slice(0, 200),
            date: m.created_at,
            metadata: { direction: m.direction },
          });
        } else {
          const fromPhone = m.direction === 'inbound' ? m.contact_phone : m.our_endpoint_id;
          timeline.push({
            type: 'call',
            title: 'Phone call',
            description: m.ai_summary || (m.body ? m.body.slice(0, 200) : `Call from ${fromPhone || 'unknown'}`),
            date: m.created_at,
            metadata: { fromPhone, durationSeconds: m.duration_seconds },
          });
        }
      }
    } catch { /* unified comms tables may not exist in older snapshots */ }

    // service_records
    const services = await db('service_records')
      .where({ 'service_records.customer_id': customerId })
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select('service_records.service_type', 'service_records.service_date', 'technicians.name as tech_name');
    for (const s of services) {
      timeline.push({
        type: 'service', title: `Service: ${s.service_type}`,
        description: s.tech_name ? `Performed by ${s.tech_name}` : 'Service completed',
        date: s.service_date, metadata: { serviceType: s.service_type, techName: s.tech_name },
      });
    }

    // payments
    const payments = await db('payments').where({ customer_id: customerId }).select('amount', 'payment_date', 'description');
    for (const p of payments) {
      timeline.push({
        type: 'payment', title: `Payment: $${parseFloat(p.amount || 0).toFixed(2)}`,
        description: p.description || 'Payment received', date: p.payment_date,
        metadata: { amount: parseFloat(p.amount || 0) },
      });
    }

    // scheduled_services
    const scheduled = await db('scheduled_services').where({ customer_id: customerId }).select('service_type', 'scheduled_date', 'status');
    for (const s of scheduled) {
      timeline.push({
        type: 'scheduled_service', title: `Scheduled: ${s.service_type}`,
        description: `Status: ${s.status}`, date: s.scheduled_date,
        metadata: { serviceType: s.service_type, status: s.status },
      });
    }

    // google_reviews
    try {
      const reviews = await db('google_reviews').where({ customer_id: customerId }).select('star_rating', 'review_text', 'review_created_at');
      for (const r of reviews) {
        timeline.push({
          type: 'review', title: `Google Review: ${'★'.repeat(r.star_rating)}${'☆'.repeat(5 - r.star_rating)}`,
          description: (r.review_text || '').slice(0, 200), date: r.review_created_at,
          metadata: { starRating: r.star_rating },
        });
      }
    } catch { /* google_reviews may not have customer_id */ }

    // activity_log
    try {
      const activities = await db('activity_log').where({ customer_id: customerId }).select('action', 'description', 'created_at');
      for (const a of activities) {
        timeline.push({
          type: 'activity', title: a.action, description: a.description || '',
          date: a.created_at, metadata: { action: a.action },
        });
      }
    } catch { /* ignore */ }

    // Sort by date descending
    timeline.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

    res.json({ timeline });
  } catch (err) { next(err); }
});

// GET /api/admin/customers/:id/comms — unified per-customer SMS + voice
// thread (PR 3 of comms unification). Replaces the SMS-only feed that
// fed the Comms tab from `data.smsLog`. Email lands in PR 5.
router.get('/:id/comms', async (req, res, next) => {
  try {
    const customerId = req.params.id;
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);

    const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const rows = await db('messages')
      .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
      .where('conversations.customer_id', customerId)
      .whereIn('messages.channel', ['sms', 'voice'])
      .select(
        'messages.id', 'messages.channel', 'messages.direction', 'messages.body',
        'messages.ai_summary', 'messages.message_type', 'messages.duration_seconds',
        'messages.media', 'messages.answered_by', 'messages.is_read',
        'messages.delivery_status', 'messages.recording_sid', 'messages.created_at',
        'conversations.our_endpoint_id', 'conversations.contact_phone'
      )
      .orderBy('messages.created_at', 'desc')
      .limit(limit);

    // Resolve the friendly label (location / domain) for each Waves number
    // hit by this customer, so the UI can show e.g. "Lakewood Ranch — HQ"
    // instead of a raw E.164.
    let TWILIO_NUMBERS;
    try { TWILIO_NUMBERS = require('../config/twilio-numbers'); } catch { TWILIO_NUMBERS = null; }

    const comms = rows.map(m => {
      const numberCfg = TWILIO_NUMBERS?.findByNumber?.(m.our_endpoint_id) || null;
      let media = [];
      try { media = typeof m.media === 'string' ? JSON.parse(m.media) : (m.media || []); } catch { media = []; }
      return {
        id: m.id,
        channel: m.channel,
        direction: m.direction,
        body: m.body,
        aiSummary: m.ai_summary,
        messageType: m.message_type,
        durationSeconds: m.duration_seconds,
        media,
        answeredBy: m.answered_by,
        isRead: !!m.is_read,
        deliveryStatus: m.delivery_status,
        recordingSid: m.recording_sid,
        createdAt: m.created_at,
        ourEndpointId: m.our_endpoint_id,
        ourEndpointLabel: numberCfg?.label || null,
        contactPhone: m.contact_phone || customer.phone || null,
      };
    });

    res.json({ comms, total: comms.length });
  } catch (err) { next(err); }
});

// GET /api/admin/customers/:id/schedule-estimates — accepted estimates
// formatted for the New Appointment modal. This keeps the UI from guessing
// at estimate_data shapes and returns service-library ids when we can match
// the quoted line to a schedulable service.
router.get('/:id/schedule-estimates', async (req, res, next) => {
  try {
    const customer = await db('customers')
      .where({ id: req.params.id })
      .whereNull('deleted_at')
      .first('id');
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const [estimates, serviceRows] = await Promise.all([
      db('estimates')
        .where({ customer_id: customer.id, status: 'accepted' })
        .whereNull('archived_at')
        .orderBy('accepted_at', 'desc')
        .orderBy('created_at', 'desc')
        .select(
          'id', 'status', 'token', 'service_interest', 'estimate_data',
          'monthly_total', 'annual_total', 'onetime_total', 'waveguard_tier',
          'created_at', 'accepted_at',
        ),
      db('services')
        .where({ is_active: true })
        .select(
          'id', 'service_key', 'name', 'short_name', 'category', 'billing_type',
          'frequency', 'visits_per_year', 'default_duration_minutes',
          'base_price', 'price_range_min', 'price_range_max',
        )
        .catch(() => []),
    ]);

    const estimateIds = estimates.map((e) => e.id);
    const linkedByEstimate = new Map();
    if (estimateIds.length) {
      const linkedRows = await db('scheduled_services')
        .whereIn('source_estimate_id', estimateIds)
        .whereNotIn('status', ['cancelled', 'rescheduled'])
        .orderBy('scheduled_date', 'asc')
        .orderBy('window_start', 'asc')
        .select('id', 'source_estimate_id', 'scheduled_date', 'window_start', 'service_type', 'status');
      for (const row of linkedRows) {
        if (!linkedByEstimate.has(row.source_estimate_id)) linkedByEstimate.set(row.source_estimate_id, row);
      }
    }

    const serviceIndex = indexServicesForSchedule(serviceRows);
    res.json({
      estimates: estimates.map((estimate) => {
        const lines = scheduleLinesFromEstimate(estimate, serviceIndex);
        const linked = linkedByEstimate.get(estimate.id) || null;
        return {
          id: estimate.id,
          token: estimate.token,
          status: estimate.status,
          serviceInterest: estimate.service_interest,
          acceptedAt: estimate.accepted_at,
          createdAt: estimate.created_at,
          monthlyTotal: estimate.monthly_total != null ? Number(estimate.monthly_total) : null,
          annualTotal: estimate.annual_total != null ? Number(estimate.annual_total) : null,
          onetimeTotal: estimate.onetime_total != null ? Number(estimate.onetime_total) : null,
          waveguardTier: estimate.waveguard_tier,
          lines,
          linkedAppointment: linked ? {
            id: linked.id,
            scheduledDate: linked.scheduled_date,
            windowStart: linked.window_start,
            serviceType: linked.service_type,
            status: linked.status,
          } : null,
        };
      }),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/customers/:id/estimates-summary — compact payload for the
// Estimates page's customer slide-over. Returns customer basics, the full
// estimate history for that customer, aggregate conversion stats, and the
// most recent comms touchpoint. Much cheaper than /api/admin/customers/:id
// which pulls 16 parallel tables; this endpoint is the 4 we actually need.
router.get('/:id/estimates-summary', async (req, res, next) => {
  try {
    const customer = await db('customers')
      .where({ id: req.params.id })
      .whereNull('deleted_at')
      .select(
        'id', 'first_name', 'last_name', 'phone', 'email',
        'address_line1', 'city', 'state', 'zip',
        'waveguard_tier', 'active', 'created_at',
        'property_type', 'company_name',
        'lead_source', 'lead_source_detail',
      )
      .first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const [estimates, lastMessage] = await Promise.all([
      db('estimates')
        .where({ customer_id: customer.id })
        .orderBy('created_at', 'desc')
        .select(
          'id', 'status', 'token', 'service_interest', 'decline_reason',
          'monthly_total', 'annual_total', 'onetime_total', 'waveguard_tier',
          'created_at', 'sent_at', 'viewed_at', 'accepted_at', 'declined_at', 'expires_at',
        ),
      db('messages')
        .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
        .where('conversations.customer_id', customer.id)
        .whereIn('messages.channel', ['sms', 'voice'])
        .orderBy('messages.created_at', 'desc')
        .select('messages.channel', 'messages.direction', 'messages.created_at', 'messages.body')
        .first()
        .catch(() => null),
    ]);

    // Conversion math. "Decided" = accepted + declined. Pipeline count
    // includes draft/sent/viewed/expired so the rate isn't inflated by
    // still-open quotes. Accepted lifetime monthly is the sum of monthly
    // totals at acceptance time — useful proxy for recurring CLV.
    const accepted = estimates.filter((e) => e.status === 'accepted');
    const declined = estimates.filter((e) => e.status === 'declined');
    const acceptedLifetimeMonthly = accepted.reduce((s, e) => s + Number(e.monthly_total || 0), 0);
    const decided = accepted.length + declined.length;
    const stats = {
      total: estimates.length,
      accepted: accepted.length,
      declined: declined.length,
      open: estimates.filter((e) => ['draft', 'sent', 'viewed'].includes(e.status)).length,
      conversionRate: decided > 0 ? Math.round((accepted.length / decided) * 100) / 100 : null,
      acceptedLifetimeMonthly: Math.round(acceptedLifetimeMonthly * 100) / 100,
    };

    res.json({
      customer,
      estimates,
      stats,
      lastContact: lastMessage ? {
        channel: lastMessage.channel,
        direction: lastMessage.direction,
        at: lastMessage.created_at,
        preview: lastMessage.body ? String(lastMessage.body).slice(0, 140) : null,
      } : null,
    });
  } catch (err) { next(err); }
});

router.get('/:id/latest-scheduled-service', async (req, res, next) => {
  try {
    const service = await db('scheduled_services')
      .where({ customer_id: req.params.id })
      .whereNotIn('status', ['cancelled', 'canceled', 'rescheduled', 'skipped', 'no_show'])
      .orderBy('scheduled_date', 'desc')
      .orderBy('created_at', 'desc')
      .first('id', 'service_type', 'scheduled_date', 'status');

    res.json({
      service: service ? {
        id: service.id,
        serviceType: service.service_type,
        scheduledDate: dateOnlyForApi(service.scheduled_date),
        status: service.status,
      } : null,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/customers/:id — full detail
router.get('/:id', async (req, res, next) => {
  try {
    const c = await db('customers').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!c) return res.status(404).json({ error: 'Customer not found' });

    const currentYear = Number(etDateString().slice(0, 4));
    const annualPrepayTermsPromise = db.schema.hasTable('annual_prepay_terms')
      .then((exists) => exists
        ? db('annual_prepay_terms as apt')
          .leftJoin('invoices as inv', 'apt.prepay_invoice_id', 'inv.id')
          .leftJoin('scheduled_services as ss', 'apt.last_scheduled_service_id', 'ss.id')
          .where('apt.customer_id', c.id)
          .select(
            'apt.*',
            'inv.invoice_number as prepay_invoice_number',
            'inv.status as prepay_invoice_status',
            'inv.total as prepay_invoice_total',
            'inv.subtotal as prepay_invoice_subtotal',
            'ss.service_type as last_scheduled_service_type',
          )
          .orderBy('apt.term_end', 'desc')
          .limit(5)
        : [])
      .catch(e => { logger.warn(`[customers:${c.id}] annual_prepay_terms: ${e.message}`); return []; });

    const [tags, interactions, prefs, services, estimates, payments, paymentsTotal, scheduled, upcomingScheduled, smsLog, healthScore, invoices, cards, paymentMethodConsents, contracts, photos, notificationPrefs, referralInfo, complianceRecords, customerDiscounts, nutrientLedgerRows, nutrientLedgerSummary, accountProperties, annualPrepayTerms, prepaidPlans] = await Promise.all([
      db('customer_tags').where({ customer_id: c.id }).select('tag'),
      db('customer_interactions').where({ customer_id: c.id }).orderBy('created_at', 'desc').limit(30),
      db('property_preferences').where({ customer_id: c.id }).first(),
      db('service_records')
        .where({ 'service_records.customer_id': c.id })
        .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
        .select('service_records.*', 'technicians.name as technician_name')
        .orderBy('service_records.service_date', 'desc')
        .limit(20),
      db('estimates').where({ customer_id: c.id }).orderBy('created_at', 'desc'),
      db('payments').where({ 'payments.customer_id': c.id }).leftJoin('payment_methods', 'payments.payment_method_id', 'payment_methods.id').select('payments.*', 'payment_methods.card_brand', 'payment_methods.last_four').orderBy('payment_date', 'desc').limit(20),
      db('payments').where({ customer_id: c.id, status: 'paid' }).first(db.raw('COALESCE(SUM(amount - COALESCE(refund_amount, 0)), 0)::float as net')).catch(e => { logger.warn(`[customers:${c.id}] payments_sum: ${e.message}`); return { net: 0 }; }),
      // Full appointment history (past + future, all statuses). Schedule-side
      // customer drawers (ScheduleCustomerSidebar / MobileCustomerDetailSheet)
      // consume data.scheduled and split it into upcoming vs previous, so this
      // must stay unfiltered.
      db('scheduled_services').where({ customer_id: c.id }).orderBy('scheduled_date').limit(10),
      // Upcoming, active-only — drives Customer 360's "next service" selection.
      db('scheduled_services')
        .where({ customer_id: c.id })
        .where('scheduled_date', '>=', etDateString())
        .whereNotIn('status', ['cancelled', 'canceled', 'completed', 'rescheduled', 'skipped', 'no_show'])
        .orderBy('scheduled_date')
        .orderBy('window_start')
        .limit(20),
      db('sms_log').where({ customer_id: c.id }).orderBy('created_at', 'desc').limit(20),
      latestHealthScoreForCustomer(c.id),
      db('invoices').where({ customer_id: c.id }).orderBy('created_at', 'desc').limit(10).catch(e => { logger.warn(`[customers:${c.id}] invoices: ${e.message}`); return []; }),
      db('payment_methods').where({ customer_id: c.id }).catch(e => { logger.warn(`[customers:${c.id}] payment_methods: ${e.message}`); return []; }),
      db('payment_method_consents as pmc')
        .leftJoin('payment_methods as pm', 'pmc.payment_method_id', 'pm.id')
        .where('pmc.customer_id', c.id)
        .select(
          'pmc.id',
          'pmc.payment_method_id',
          'pmc.stripe_payment_method_id',
          'pmc.source',
          'pmc.consent_text_version',
          'pmc.consent_text_snapshot',
          'pmc.ip',
          'pmc.user_agent',
          'pmc.created_at',
          'pm.method_type',
          'pm.card_brand',
          'pm.last_four',
          'pm.exp_month',
          'pm.exp_year',
          'pm.bank_name',
          'pm.bank_last_four',
          'pm.is_default',
          'pm.autopay_enabled'
        )
        .orderBy('pmc.created_at', 'desc')
        .limit(20)
        .catch(e => { logger.warn(`[customers:${c.id}] payment_method_consents: ${e.message}`); return []; }),
      db('customer_contracts as cc')
        .leftJoin('payment_methods as pm', 'cc.payment_method_id', 'pm.id')
        .leftJoin('document_templates as dt', 'cc.document_template_id', 'dt.id')
        .where('cc.customer_id', c.id)
        .select(
          'cc.*',
          'pm.method_type',
          'pm.card_brand',
          'pm.last_four',
          'pm.bank_name',
          'pm.bank_last_four',
          'dt.requires_signature as document_template_requires_signature',
          'dt.category as document_template_category',
          'dt.document_type as document_template_document_type'
        )
        .orderBy('cc.created_at', 'desc')
        .limit(20)
        .catch(e => { logger.warn(`[customers:${c.id}] customer_contracts: ${e.message}`); return []; }),
      db('service_photos')
        .join('service_records', 'service_photos.service_record_id', 'service_records.id')
        .where('service_records.customer_id', c.id)
        .select(
          'service_photos.id',
          'service_photos.s3_key',
          'service_photos.s3_url',
          'service_photos.caption',
          'service_photos.service_record_id',
          'service_photos.created_at'
        )
        .orderBy('service_photos.created_at', 'desc')
        .limit(12)
        .catch(e => { logger.warn(`[customers:${c.id}] service_photos: ${e.message}`); return []; }),
      db('notification_prefs').where({ customer_id: c.id }).first().catch(e => { logger.warn(`[customers:${c.id}] notification_prefs: ${e.message}`); return null; }),
      db('referral_promoters').where({ customer_id: c.id }).first().catch(e => { logger.warn(`[customers:${c.id}] referral_promoters: ${e.message}`); return null; }),
      db('property_application_history').where({ customer_id: c.id }).orderBy('application_date', 'desc').limit(10).catch(e => { logger.warn(`[customers:${c.id}] property_application_history: ${e.message}`); return []; }),
      db('customer_discounts').where({ 'customer_discounts.customer_id': c.id }).leftJoin('discounts', 'customer_discounts.discount_id', 'discounts.id').select('customer_discounts.*', 'discounts.name as discount_name', 'discounts.discount_type', 'discounts.amount as discount_value').catch(e => { logger.warn(`[customers:${c.id}] customer_discounts: ${e.message}`); return []; }),
      db('property_nutrient_ledger')
        .where({ customer_id: c.id, application_year: currentYear })
        .orderBy('application_date', 'desc')
        .orderBy('created_at', 'desc')
        .limit(25)
        .catch(e => { logger.warn(`[customers:${c.id}] property_nutrient_ledger: ${e.message}`); return []; }),
      db('property_nutrient_ledger')
        .where({ customer_id: c.id, application_year: currentYear })
        .first(
          db.raw('COALESCE(SUM(n_applied_per_1000), 0)::float as "nApplied"'),
          db.raw('COALESCE(SUM(p_applied_per_1000), 0)::float as "pApplied"'),
          db.raw('COALESCE(SUM(k_applied_per_1000), 0)::float as "kApplied"'),
          db.raw('COUNT(*)::int as entries')
        )
        .catch(e => { logger.warn(`[customers:${c.id}] property_nutrient_ledger_summary: ${e.message}`); return null; }),
      accountPropertySummary(c.account_id, c.id).catch(e => { logger.warn(`[customers:${c.id}] account_properties: ${e.message}`); return []; }),
      annualPrepayTermsPromise,
      listCustomerPrepaidPlans(db, c.id).catch(e => { logger.warn(`[customers:${c.id}] prepaid_plans: ${e.message}`); return []; }),
    ]);

    // The invoices table stores the billed amount as `total`; the frontend reads
    // `amount_due`/`amount_paid`. Only collectible statuses contribute to
    // amount_due — draft/void must not inflate Balance Owed (frontend filters
    // by `status !== 'paid'`).
    const COLLECTIBLE_STATUSES = new Set(['sent', 'viewed', 'overdue', 'paid']);
    const mappedInvoices = (invoices || []).map(inv => {
      const total = parseFloat(inv.total || 0);
      const isPaid = inv.status === 'paid' || inv.status === 'prepaid';
      const isCollectible = COLLECTIBLE_STATUSES.has(inv.status);
      return {
        ...inv,
        amount_due: isCollectible ? total : 0,
        amount_paid: isPaid ? total : 0,
      };
    });
    // Lifetime revenue is the net of all paid payments (Stripe + Zelle/manual),
    // minus refunds. customers.lifetime_revenue isn't kept in sync, and summing
    // paid-invoice totals from the limit(10) query above would underreport for
    // long-tenured customers and miss off-gateway payments without invoices.
    const lifetimeRevenue = parseFloat(paymentsTotal?.net || 0);

    const signedPhotos = await Promise.all((photos || []).map(async (p) => {
      if (!p.s3_key) return { ...p, url: null, s3_url: null };
      try {
        return { ...p, url: await PhotoService.getViewUrl(p.s3_key, 300), s3_url: null };
      } catch (err) {
        logger.warn(`[customers:${c.id}] service photo presign failed: ${err.message}`);
        return { ...p, url: null, s3_url: null };
      }
    }));

    res.json({
      customer: {
        id: c.id, firstName: c.first_name, lastName: c.last_name,
        accountId: c.account_id,
        profileLabel: c.profile_label,
        isPrimaryProfile: !!c.is_primary_profile,
        email: c.email, phone: c.phone, secondaryPhone: c.secondary_phone,
        secondaryContact: c.secondary_contact_name, companyName: c.company_name,
        serviceContactName: c.service_contact_name,
        serviceContactPhone: c.service_contact_phone,
        serviceContactEmail: c.service_contact_email,
        serviceContact2Name: c.service_contact2_name,
        serviceContact2Phone: c.service_contact2_phone,
        serviceContact2Email: c.service_contact2_email,
        serviceContact3Name: c.service_contact3_name,
        serviceContact3Phone: c.service_contact3_phone,
        serviceContact3Email: c.service_contact3_email,
        address: { line1: c.address_line1, city: c.city, state: c.state, zip: c.zip },
        property: { type: c.property_type, lawnType: c.lawn_type, sqft: c.property_sqft, lotSqft: c.lot_sqft, palmCount: c.palm_count },
        tier: c.waveguard_tier, monthlyRate: parseFloat(c.monthly_rate || 0),
        memberSince: c.member_since, active: c.active,
        pipelineStage: c.pipeline_stage, leadScore: c.lead_score,
        leadSource: c.lead_source, leadSourceDetail: c.lead_source_detail,
        landingPageUrl: c.landing_page_url,
        assignedTo: c.assigned_to, lastContactDate: c.last_contact_date,
        nextFollowUp: c.next_follow_up_date, followUpNotes: c.follow_up_notes,
        lifetimeRevenue,
        annualValue: parseFloat(c.monthly_rate || 0) * 12,
        totalServices: c.total_services,
        referralCode: c.referral_code, crmNotes: c.crm_notes,
        satelliteUrl: c.satellite_url,
        hasLeftGoogleReview: !!c.has_left_google_review,
        reviewMarkedAt: c.review_marked_at,
      },
      accountProperties: accountProperties.map(p => ({
        id: p.id,
        profileLabel: p.profile_label,
        address: { line1: p.address_line1, city: p.city, state: p.state, zip: p.zip },
        pipelineStage: p.pipeline_stage,
        monthlyRate: parseFloat(p.monthly_rate || 0),
        isPrimaryProfile: !!p.is_primary_profile,
      })),
      tags: tags.map(t => t.tag),
      interactions, preferences: prefs, services, estimates, payments, scheduled, upcomingScheduled, smsLog,
      healthScore: healthScore || null,
      invoices: mappedInvoices,
      cards: cards || [],
      paymentMethodConsents: (paymentMethodConsents || []).map((consent) => ({
        id: consent.id,
        paymentMethodId: consent.payment_method_id,
        stripePaymentMethodId: consent.stripe_payment_method_id,
        source: consent.source,
        consentTextVersion: consent.consent_text_version,
        consentTextSnapshot: consent.consent_text_snapshot,
        ip: consent.ip,
        userAgent: consent.user_agent,
        createdAt: consent.created_at,
        methodType: consent.method_type,
        cardBrand: consent.card_brand,
        lastFour: consent.last_four || consent.bank_last_four,
        expMonth: consent.exp_month,
        expYear: consent.exp_year,
        bankName: consent.bank_name,
        isDefault: !!consent.is_default,
        autopayEnabled: !!consent.autopay_enabled,
      })),
      contracts: (contracts || []).map((contract) => ({
        id: contract.id,
        customerId: contract.customer_id,
        paymentMethodId: contract.payment_method_id,
        createdBy: contract.created_by,
        contractType: contract.contract_type,
        title: contract.title,
        status: contract.status,
        recipientName: contract.recipient_name,
        recipientEmail: contract.recipient_email,
        recipientPhone: contract.recipient_phone,
        serviceName: contract.service_name,
        renewalDate: contract.renewal_date,
        cancellationDeadline: contract.cancellation_deadline,
        autoRenewalNoticeRequired: !!contract.auto_renewal_notice_required,
        autoRenewalNoticeSentAt: contract.auto_renewal_notice_sent_at,
        consentTextVersion: contract.consent_text_version,
        consentTextSnapshot: contract.consent_text_snapshot,
        contractTextSnapshot: contract.contract_text_snapshot,
        esignDisclosureSnapshot: contract.esign_disclosure_snapshot,
        documentTemplateId: contract.document_template_id,
        documentTemplateVersionId: contract.document_template_version_id,
        documentTemplateKey: contract.document_template_key,
        documentTemplateCategory: contract.document_template_category,
        documentTemplateDocumentType: contract.document_template_document_type,
        // Prefer the per-contract requires_signature_snapshot (frozen when the
        // document was sent) over the live template flag, matching
        // contracts.js serialization so historical contracts don't flip if the
        // template's signature requirement later changes.
        requiresSignature: contract.contract_type === 'document_template'
          ? documentRequiresSignature(contract)
          : true,
        documentVariablesSnapshot: contract.document_variables_snapshot || {},
        documentRenderSummary: contract.document_render_summary || {},
        shareTokenExpiresAt: contract.share_token_expires_at,
        sharedAt: contract.shared_at,
        viewedAt: contract.viewed_at,
        signedAt: contract.signed_at,
        signedName: contract.signed_name,
        recipientInitials: contract.recipient_initials,
        signerIp: contract.signer_ip,
        signerUserAgent: contract.signer_user_agent,
        cancelledAt: contract.cancelled_at,
        cancelledReason: contract.cancelled_reason,
        createdAt: contract.created_at,
        updatedAt: contract.updated_at,
        methodType: contract.method_type,
        cardBrand: contract.card_brand,
        lastFour: contract.last_four || contract.bank_last_four,
        bankName: contract.bank_name,
      })),
      annualPrepayTerms: (annualPrepayTerms || []).map(mapAnnualPrepayTerm),
      prepaidPlans: (prepaidPlans || []).map((plan) => ({
        ...plan,
        paidAt: plan.paidAt instanceof Date ? plan.paidAt.toISOString() : plan.paidAt,
        nextVisitDate: dateOnlyForApi(plan.nextVisitDate),
      })),
      photos: signedPhotos,
      notificationPrefs: notificationPrefs || null,
      referralInfo: referralInfo || null,
      complianceRecords: complianceRecords || [],
      nutrientLedger: {
        year: currentYear,
        summary: {
          year: currentYear,
          nApplied: Number(Number(nutrientLedgerSummary?.nApplied || 0).toFixed(3)),
          pApplied: Number(Number(nutrientLedgerSummary?.pApplied || 0).toFixed(3)),
          kApplied: Number(Number(nutrientLedgerSummary?.kApplied || 0).toFixed(3)),
          totalN: Number(Number(nutrientLedgerSummary?.nApplied || 0).toFixed(3)),
          totalP: Number(Number(nutrientLedgerSummary?.pApplied || 0).toFixed(3)),
          totalK: Number(Number(nutrientLedgerSummary?.kApplied || 0).toFixed(3)),
          entries: Number(nutrientLedgerSummary?.entries || 0),
          source: 'property_nutrient_ledger',
        },
        rows: nutrientLedgerRows || [],
      },
      customerDiscounts: customerDiscounts || [],
    });
  } catch (err) { next(err); }
});

// POST /api/admin/customers — create
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { firstName, lastName, phone, email, address, addressLine1, city, state, zip, tier, monthlyRate, leadSource, pipelineStage, tags, notes, companyName, propertyType, profileLabel } = req.body;
    if (!firstName || !phone) return res.status(400).json({ error: 'First name and phone required' });
    const normalized = {
      firstName: cleanText(firstName),
      lastName: cleanText(lastName),
      phone: cleanText(phone),
      email: cleanEmail(email),
      addressLine1: cleanText(addressLine1 || address),
      city: cleanText(city),
      state: cleanState(state),
      zip: cleanText(zip),
      tier: cleanOptionalText(tier),
      monthlyRate: monthlyRate === '' || monthlyRate === undefined || monthlyRate === null ? 0 : parseFloat(monthlyRate) || 0,
      leadSource: cleanOptionalText(leadSource),
      pipelineStage: cleanText(pipelineStage) || 'new_lead',
      notes: cleanOptionalText(notes),
      companyName: cleanOptionalText(companyName),
      propertyType: cleanOptionalText(propertyType),
      profileLabel: cleanOptionalText(profileLabel),
    };
    if (!normalized.firstName || !normalized.phone) {
      return res.status(400).json({ error: 'First name and phone required' });
    }
    if (!isValidStage(normalized.pipelineStage)) return res.status(400).json({ error: 'Invalid pipeline stage' });

    const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

    const customer = await db.transaction(async (trx) => {
      const account = await ensureCustomerAccount(trx, normalized);
      const siblingCount = await trx('customers').where({ account_id: account.accountId }).whereNull('deleted_at').count('* as count').first();
      const [created] = await trx('customers').insert({
        account_id: account.accountId,
        is_primary_profile: !account.existingCustomer,
        profile_label: normalized.profileLabel || (account.existingCustomer ? 'Rental property' : 'Primary'),
        first_name: normalized.firstName, last_name: normalized.lastName || null, phone: normalized.phone, email: normalized.email,
        address_line1: normalized.addressLine1 || null, city: normalized.city || null, state: normalized.state, zip: normalized.zip || null,
        waveguard_tier: normalized.tier, monthly_rate: normalized.monthlyRate,
        member_since: etDateString(),
        referral_code: code, lead_source: normalized.leadSource,
        pipeline_stage: normalized.pipelineStage,
        pipeline_stage_changed_at: new Date(),
        assigned_to: req.technicianId,
        company_name: normalized.companyName, property_type: normalized.propertyType, crm_notes: normalized.notes,
      }).returning('*');

      await createDefaultCustomerRows(trx, created.id);

      if (tags?.length) {
        for (const tag of tags) {
          const cleanTag = cleanText(tag);
          if (cleanTag) {
            await trx('customer_tags').insert({ customer_id: created.id, tag: cleanTag }).onConflict(['customer_id', 'tag']).ignore();
          }
        }
      }
      return { ...created, _attachedToExistingAccount: !!account.existingCustomer, _existingCustomer: account.existingCustomer, _propertyCount: Number(siblingCount?.count || 0) + 1 };
    });

    // Intentional fire-and-forget: derived pipeline/score state can lag the
    // create response, and failures should not roll back the durable customer.
    void PipelineManager.onEvent(customer.id, 'lead_created')
      .catch(err => logger.warn(`[customers:${customer.id}] pipeline lead_created failed: ${err.message}`));
    void LeadScorer.calculateScore(customer.id)
      .catch(err => logger.warn(`[customers:${customer.id}] lead score failed: ${err.message}`));
    await auditCustomerMutation(req, 'customer.create', customer.id, {
      fields: ['first_name', 'last_name', 'phone', 'email', 'address', 'tier', 'monthly_rate', 'lead_source', 'pipeline_stage', 'tags'],
    });

    // Fire-and-forget geocoding (don't block the create response)
    if (normalized.addressLine1) {
      require('../services/geocoder').ensureCustomerGeocoded(customer.id).catch(() => {});
    }

    if (hasMembership(normalized)) {
      void AccountMembershipEmail.sendMembershipStarted({
        customerId: customer.id,
        effectiveDate: customer.member_since || new Date(),
        membershipTier: normalized.tier,
        monthlyRate: normalized.monthlyRate,
        sourceId: `admin_customer_create:${customer.id}`,
      }).catch(err => logger.warn(`[customers] membership.started email failed for ${customer.id}: ${err.message}`));
    }

    res.status(201).json({
      id: customer.id,
      referralCode: code,
      accountId: customer.account_id,
      profileLabel: customer.profile_label,
      attachedToExistingAccount: customer._attachedToExistingAccount,
      propertyCount: customer._propertyCount,
      existingCustomerId: customer._existingCustomer?.id || null,
      existingCustomerName: customer._existingCustomer ? `${customer._existingCustomer.first_name} ${customer._existingCustomer.last_name}` : null,
    });
  } catch (err) { next(err); }
});

// PUT /api/admin/customers/:id
router.put('/:id', requireAdmin, async (req, res, next) => {
  try {
    const fields = { firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone', profileLabel: 'profile_label', addressLine1: 'address_line1', city: 'city', state: 'state', zip: 'zip', tier: 'waveguard_tier', monthlyRate: 'monthly_rate', active: 'active', leadSource: 'lead_source', companyName: 'company_name', propertyType: 'property_type', crmNotes: 'crm_notes', nextFollowUpDate: 'next_follow_up_date', followUpNotes: 'follow_up_notes', secondaryPhone: 'secondary_phone', secondaryContactName: 'secondary_contact_name', pipelineStage: 'pipeline_stage', serviceContactName: 'service_contact_name', serviceContactPhone: 'service_contact_phone', serviceContactEmail: 'service_contact_email', serviceContact2Name: 'service_contact2_name', serviceContact2Phone: 'service_contact2_phone', serviceContact2Email: 'service_contact2_email', serviceContact3Name: 'service_contact3_name', serviceContact3Phone: 'service_contact3_phone', serviceContact3Email: 'service_contact3_email', hasLeftGoogleReview: 'has_left_google_review' };
    const before = await db('customers').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!before) return res.status(404).json({ error: 'Customer not found' });
    if (req.body.pipelineStage !== undefined && !isValidStage(req.body.pipelineStage)) {
      return res.status(400).json({ error: 'Invalid pipeline stage' });
    }
    const updates = {};
    for (const [k, v] of Object.entries(fields)) {
      if (req.body[k] !== undefined) {
        // Handle empty strings for numeric/date fields
        if (v === 'monthly_rate') { updates[v] = req.body[k] === '' ? 0 : parseFloat(req.body[k]) || 0; }
        else if (v === 'next_follow_up_date') { updates[v] = req.body[k] || null; }
        else if (v === 'has_left_google_review') { updates[v] = !!req.body[k]; }
        else if (v === 'email') { updates[v] = cleanEmail(req.body[k]); }
        else if (v === 'phone') { updates[v] = cleanText(req.body[k]); }
        else if (v === 'last_name') { updates[v] = cleanOptionalText(req.body[k]); }
        else if (v === 'state') { updates[v] = cleanOptionalState(req.body[k]); }
        else { updates[v] = req.body[k]; }
      }
    }
    // Stamp when the review flag flips so admins can see who/when later.
    if (updates.has_left_google_review !== undefined) {
      updates.review_marked_at = updates.has_left_google_review ? new Date() : null;
    }
    if (updates.pipeline_stage !== undefined && updates.pipeline_stage !== before.pipeline_stage) {
      updates.pipeline_stage_changed_at = new Date();
    }
    compactServiceContactSlots(updates, before);
    if (Object.keys(updates).length) {
      const contactConflict = await findCrossAccountContactConflict(
        req.params.id,
        before.account_id || before.id,
        updates
      );
      if (contactConflict) {
        const c = contactConflict.customer;
        return res.status(409).json({
          error: 'contact_exists_on_another_account',
          field: contactConflict.field,
          message: `That ${contactConflict.field} is already used by ${c.first_name || ''} ${c.last_name || ''}`.trim(),
          existingCustomerId: c.id,
        });
      }

      await db('customers').where({ id: req.params.id }).update(updates);
      const sensitiveFields = ['email', 'phone', 'secondary_phone', 'address_line1', 'city', 'state', 'zip', 'monthly_rate', 'active', 'pipeline_stage', 'service_contact_name', 'service_contact_phone', 'service_contact_email', 'service_contact2_name', 'service_contact2_phone', 'service_contact2_email', 'service_contact3_name', 'service_contact3_phone', 'service_contact3_email'];
      const changed = Object.keys(updates).filter(field => before && before[field] !== updates[field]);
      if (changed.some(field => sensitiveFields.includes(field))) {
        await auditCustomerMutation(req, 'customer.update_sensitive', req.params.id, {
          fields: changed,
          sensitiveFieldsChanged: changed.filter(field => sensitiveFields.includes(field)),
        }, true);
      }
      const after = { ...before, ...updates };
      const beforeHasMembership = hasMembership(before);
      const afterHasMembership = hasMembership(after);
      const membershipFieldChanged = membershipDetailsChanged(before, after);
      const membershipEventAt = new Date();
      if (updates.active === false && before.active !== false && hasMembership(before)) {
        void AccountMembershipEmail.sendMembershipCanceled({
          customerId: req.params.id,
          effectiveDate: membershipEventAt,
          reason: req.body.churnReason || 'Account deactivated',
          membershipTier: before.waveguard_tier,
          monthlyRate: before.monthly_rate,
          idempotencyKey: adminMembershipDailyIdempotencyKey('membership.canceled', req.params.id, 'admin', membershipEventAt),
        }).catch(err => logger.warn(`[customers] membership.canceled email failed for ${req.params.id}: ${err.message}`));
      } else if (updates.active === true && before.active === false && hasMembership(after)) {
        void AccountMembershipEmail.sendMembershipReactivated({
          customerId: req.params.id,
          effectiveDate: membershipEventAt,
          idempotencyKey: adminMembershipDailyIdempotencyKey('membership.reactivated', req.params.id, 'admin', membershipEventAt),
        }).catch(err => logger.warn(`[customers] membership.reactivated email failed for ${req.params.id}: ${err.message}`));
      } else if (membershipFieldChanged && !beforeHasMembership && afterHasMembership) {
        void AccountMembershipEmail.sendMembershipStarted({
          customerId: req.params.id,
          effectiveDate: membershipEventAt,
          membershipTier: after.waveguard_tier,
          monthlyRate: after.monthly_rate,
          sourceId: `admin_membership_start:${req.params.id}:${etDateString(membershipEventAt)}`,
          idempotencyKey: adminMembershipStartIdempotencyKey(req.params.id, before, after, membershipEventAt),
        }).catch(err => logger.warn(`[customers] membership.started email failed for ${req.params.id}: ${err.message}`));
      } else if (membershipFieldChanged && beforeHasMembership && !afterHasMembership) {
        void AccountMembershipEmail.sendMembershipCanceled({
          customerId: req.params.id,
          effectiveDate: membershipEventAt,
          reason: 'Membership removed',
          membershipTier: before.waveguard_tier,
          monthlyRate: before.monthly_rate,
          idempotencyKey: adminMembershipDailyIdempotencyKey('membership.canceled', req.params.id, 'admin_membership_removed', membershipEventAt),
        }).catch(err => logger.warn(`[customers] membership.canceled email failed for ${req.params.id}: ${err.message}`));
      } else if (membershipFieldChanged && afterHasMembership) {
        void AccountMembershipEmail.sendMembershipUpdated({
          customerId: req.params.id,
          before,
          after,
          effectiveDate: membershipEventAt,
        }).catch(err => logger.warn(`[customers] membership.updated email failed for ${req.params.id}: ${err.message}`));
      }
    }

    // If address changed, re-geocode (clear lat/lng first so ensureCustomerGeocoded refreshes)
    const addressChanged = ['address_line1', 'city', 'state', 'zip'].some(f => updates[f] !== undefined);
    if (addressChanged) {
      await db('customers').where({ id: req.params.id }).update({ latitude: null, longitude: null });
      require('../services/geocoder').ensureCustomerGeocoded(req.params.id).catch(() => {});
    }

    // Fire-and-forget: trigger cancellation save when deactivating a customer
    if (updates.active === false) {
      try {
        const cancellationSave = require('../services/workflows/cancellation-save');
        if (cancellationSave.initiate) {
          cancellationSave.initiate(req.params.id, 'default').catch(err =>
            logger.error(`[customers] Cancellation save on deactivation failed: ${err.message}`)
          );
        }
      } catch (err) {
        logger.error(`[customers] Cancellation save require failed: ${err.message}`);
      }
    }

    res.json({ success: true });
  } catch (err) {
    if (err.message?.includes('customers_email_unique') || err.message?.includes('duplicate key')) {
      return res.status(400).json({ error: 'That email is already in use by another customer.' });
    }
    next(err);
  }
});

// PUT /api/admin/customers/:id/notification-prefs
//
// Admin override for a customer's notification_prefs row. Keep this narrow:
// ops needs auto-flip control and recipient-routing fields for landlord /
// tenant / AP-contact workflows.
//
// Creates the prefs row if it doesn't exist (defaults to all TRUE).
router.put('/:id/notification-prefs', requireAdmin, async (req, res, next) => {
  try {
    const existing = await db('notification_prefs')
      .where({ customer_id: req.params.id })
      .first();
    const { dbUpdates, error } = adminNotificationPrefsDbUpdates(req.body, existing || {});
    if (error) {
      return res.status(400).json({ error });
    }
    if (Object.keys(dbUpdates).length === 0) {
      return res.status(400).json({ error: 'No supported fields provided.' });
    }
    dbUpdates.updated_at = new Date();

    if (existing) {
      await db('notification_prefs')
        .where({ customer_id: req.params.id })
        .update(dbUpdates);
    } else {
      await db('notification_prefs').insert({
        customer_id: req.params.id,
        ...dbUpdates,
      });
    }

    const prefs = await db('notification_prefs')
      .where({ customer_id: req.params.id })
      .first();
    const loggedFields = Object.keys(dbUpdates)
      .filter((field) => field !== 'updated_at')
      .sort();
    logger.info(`[customers] notification_prefs updated for ${req.params.id}: ${JSON.stringify({ fields: loggedFields })}`);
    res.json({ success: true, notificationPrefs: prefs });
  } catch (err) { next(err); }
});

// PUT /api/admin/customers/:id/stage
router.put('/:id/stage', async (req, res, next) => {
  try {
    const { stage, notes } = req.body;
    if (!isValidStage(stage)) return res.status(400).json({ error: 'Invalid pipeline stage' });
    const customer = await db('customers').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    const oldStage = customer.pipeline_stage;
    await db('customers').where({ id: req.params.id }).update({ pipeline_stage: stage, pipeline_stage_changed_at: new Date() });
    if (stage === 'churned' && req.body.churnReason) {
      await db('customers').where({ id: req.params.id }).update({ churned_at: new Date(), churn_reason: req.body.churnReason });
    }
    await db('customer_interactions').insert({
      customer_id: req.params.id, interaction_type: 'note',
      subject: `Stage changed: ${oldStage} → ${stage}`,
      body: notes || '', admin_user_id: req.technicianId,
    });

    // Fire-and-forget: trigger cancellation save workflow when moving to churned or at_risk
    if (stage === 'churned' || (stage === 'at_risk' && oldStage !== 'at_risk')) {
      try {
        const cancellationSave = require('../services/workflows/cancellation-save');
        if (cancellationSave.initiate) {
          const cancelReason = req.body.churnReason || 'default';
          cancellationSave.initiate(req.params.id, cancelReason).catch(err =>
            logger.error(`[customers] Cancellation save failed: ${err.message}`)
          );
        }
      } catch (err) {
        logger.error(`[customers] Cancellation save require failed: ${err.message}`);
      }
    }

    // Fire-and-forget: update health score on stage change
    try {
      const customerHealth = require('../services/customer-health');
      if (customerHealth.scoreCustomer) {
        customerHealth.scoreCustomer(req.params.id).catch(err =>
          logger.error(`[customers] Health score update on stage change failed: ${err.message}`)
        );
      }
    } catch (err) {
      logger.error(`[customers] Customer health require failed: ${err.message}`);
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/customers/:id/tags
router.post('/:id/tags', async (req, res, next) => {
  try {
    await db('customer_tags').insert({ customer_id: req.params.id, tag: req.body.tag }).onConflict(['customer_id', 'tag']).ignore();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /api/admin/customers/:id/tags/:tag
router.delete('/:id/tags/:tag', async (req, res, next) => {
  try {
    await db('customer_tags').where({ customer_id: req.params.id, tag: req.params.tag }).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/customers/:id/interactions
router.post('/:id/interactions', async (req, res, next) => {
  try {
    const { type, subject, body } = req.body;
    await db('customer_interactions').insert({
      customer_id: req.params.id, interaction_type: type || 'note',
      subject, body, admin_user_id: req.technicianId,
    });
    await db('customers').where({ id: req.params.id }).update({ last_contact_date: new Date(), last_contact_type: type || 'note' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/customers/:id/follow-up
router.post('/:id/follow-up', async (req, res, next) => {
  try {
    await db('customers').where({ id: req.params.id }).update({
      next_follow_up_date: req.body.date, follow_up_notes: req.body.notes,
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /api/admin/customers/:id — soft-delete a customer
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const customer = await db('customers').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    await db('customers').where({ id: req.params.id }).update({ deleted_at: new Date() });
    await auditCustomerMutation(req, 'customer.archive', req.params.id, { previousDeletedAt: customer.deleted_at || null }, true);
    logger.info(`[customers] Soft-deleted customer id=${req.params.id}`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// PATCH /api/admin/customers/:id/restore — restore a soft-deleted customer (admin only)
router.patch('/:id/restore', requireAdmin, async (req, res, next) => {
  try {
    const customer = await db('customers').where({ id: req.params.id }).whereNotNull('deleted_at').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found or not deleted' });

    await db('customers').where({ id: req.params.id }).update({ deleted_at: null });
    await auditCustomerMutation(req, 'customer.restore', req.params.id, { previousDeletedAt: customer.deleted_at || null }, true);
    logger.info(`[customers] Restored customer id=${req.params.id}`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/customers/:id/annual-prepay-invoice - create and send an
// unpaid annual prepay invoice. The linked annual_prepay_terms row stays
// payment_pending until Stripe/manual payment marks the invoice paid; the
// payment lifecycle then activates the term and stamps covered visits prepaid.
router.post('/:id/annual-prepay-invoice', requireAdmin, async (req, res, next) => {
  try {
    const customer = await db('customers').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const hasAnnualTerms = await db.schema.hasTable('annual_prepay_terms');
    if (!hasAnnualTerms) {
      return res.status(500).json({ error: 'Annual prepay terms table is not available' });
    }

    const parsedAmount = parseAnnualPrepayAmount(req.body?.amount);
    if (parsedAmount.error) return res.status(400).json({ error: parsedAmount.error });
    const amount = parsedAmount.amount;

    const parsedVisitCount = parseAnnualPrepayVisitCount(req.body?.visitCount ?? 4);
    if (parsedVisitCount.error) return res.status(400).json({ error: parsedVisitCount.error });
    const visitCount = parsedVisitCount.visitCount;

    const coverageCadence = cleanOptionalText(req.body?.coverageCadence || req.body?.cadence) || null;
    const coverageServiceType = cleanOptionalText(req.body?.serviceType) || 'Quarterly Pest Control';
    const planLabel = cleanOptionalText(req.body?.planLabel) || `${coverageServiceType} Annual Prepay`;

    const activeTerm = await db('annual_prepay_terms')
      .where({ customer_id: customer.id })
      .where(annualPrepayOverlapStatusClause())
      .orderBy('term_end', 'desc')
      .first();

    const termStartInput = parseDateOnlyInput(req.body?.termStart, 'termStart');
    if (termStartInput.error) return res.status(400).json({ error: termStartInput.error });
    const termStart = termStartInput.date || defaultAnnualPrepayTermStart(activeTerm);

    const termEndInput = parseDateOnlyInput(req.body?.termEnd, 'termEnd');
    if (termEndInput.error) return res.status(400).json({ error: termEndInput.error });
    const termEnd = termEndInput.date || addMonthsDateOnly(termStart, 12);
    if (!termEnd || termEnd <= termStart) {
      return res.status(400).json({ error: 'termEnd must be after termStart' });
    }

    const activeTermEnd = dateOnlyForApi(activeTerm?.term_end);
    if (activeTermEnd && termStart <= activeTermEnd && req.body?.allowOverlap !== true) {
      return res.status(409).json({
        error: `Customer already has an annual prepay term through ${activeTermEnd}. Use a start date after ${activeTermEnd}.`,
        activeTermId: activeTerm.id,
        activeTermEnd,
      });
    }

    const note = cleanOptionalText(req.body?.note);
    const dueDateInput = parseDateOnlyInput(req.body?.dueDate, 'dueDate');
    if (dueDateInput.error) return res.status(400).json({ error: dueDateInput.error });
    const dueDate = dueDateInput.date || etDateString();
    const perVisit = Math.round((amount / visitCount) * 100) / 100;
    const invoiceNotes = [
      `Annual prepaid ${coverageServiceType}.`,
      `Covers ${visitCount} service application${visitCount === 1 ? '' : 's'} from ${termStart} through ${termEnd}.`,
      `Payment of this invoice will automatically mark those scheduled visits prepaid.`,
      note,
    ].filter(Boolean).join('\n');

    const InvoiceService = require('../services/invoice');
    const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
    let invoice;
    let term;
    await db.transaction(async (trx) => {
      await lockAndAssertNoAnnualPrepayOverlap(
        trx, customer.id, termStart, req.body?.allowOverlap === true,
        'Customer already has an annual prepay term through',
      );
      invoice = await InvoiceService.create({
        database: trx,
        customerId: customer.id,
        title: `${coverageServiceType} - Annual Prepay`,
        lineItems: [{
          description: `${coverageServiceType} - ${visitCount} prepaid application${visitCount === 1 ? '' : 's'}`,
          quantity: 1,
          unit_price: amount,
          category: 'Annual prepay',
        }],
        notes: invoiceNotes,
        dueDate,
      });

      term = await AnnualPrepayRenewals.createTermForAnnualPrepay({
        customerId: customer.id,
        prepayInvoiceId: invoice.id,
        planLabel,
        monthlyRate: Math.round((amount / 12) * 100) / 100,
        // Store what the customer is actually billed (commercial invoices add
        // county tax via InvoiceService.create), not the pretax request amount —
        // applyPrepaidCoverageForTerm splits prepay_amount across the covered
        // visits, so a pretax value would leave the tax portion uncredited and
        // make the coverage ledger disagree with the invoice/payment total.
        prepayAmount: Number(invoice.total),
        termStart,
        termEnd,
        coverageServiceType,
        coverageVisitCount: visitCount,
        coverageCadence,
        conn: trx,
      });
      if (!term) throw new Error('Annual prepay term could not be created');

      await trx('activity_log').insert({
        customer_id: customer.id,
        action: 'annual_prepay_invoice_created',
        description: `Annual prepay invoice ${invoice.invoice_number} created for ${coverageServiceType}: $${amount.toFixed(2)} covering ${visitCount} visit(s)`,
        metadata: JSON.stringify({
          invoice_id: invoice.id,
          invoice_number: invoice.invoice_number,
          annual_prepay_term_id: term.id,
          coverage_service_type: coverageServiceType,
          coverage_visit_count: visitCount,
          coverage_cadence: coverageCadence,
          per_visit_amount: perVisit,
          term_start: termStart,
          term_end: termEnd,
        }),
      }).catch((err) => logger.warn(`[customers:annual-prepay-invoice] activity_log insert failed: ${err.message}`));
    });

    let delivery = null;
    try {
      delivery = await InvoiceService.sendViaSMSAndEmail(invoice.id);
    } catch (err) {
      delivery = { ok: false, error: err.message };
      logger.warn(`[customers:annual-prepay-invoice] send failed for ${invoice.id}: ${err.message}`);
    }

    const payUrl = delivery?.payUrl || await shortenOrPassthrough(`${publicPortalUrl()}/pay/${invoice.token}`, {
      kind: 'invoice',
      entityType: 'invoices',
      entityId: invoice.id,
      customerId: customer.id,
      codePrefix: invoiceShortCodePrefix(invoice),
    });

    await auditCustomerMutation(req, 'customer.annual_prepay.invoice_send', customer.id, {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      annualPrepayTermId: term.id,
      amount,
      serviceType: coverageServiceType,
      visitCount,
      coverageCadence,
      termStart,
      termEnd,
      deliveryOk: !!delivery?.ok,
    }, true);

    res.status(201).json({
      success: true,
      invoice: {
        ...invoice,
        payUrl,
      },
      annualPrepayTerm: mapAnnualPrepayTerm(term),
      delivery,
    });
  } catch (err) {
    if (err && err.annualPrepayOverlap) return res.status(409).json(err.annualPrepayOverlap);
    next(err);
  }
});

// POST /api/admin/customers/:id/annual-prepay - record a 12-month prepay that
// has already been collected, create the paid invoice, and activate/extend the
// annual prepay term used by renewal alerts and Customer 360.
router.post('/:id/annual-prepay', requireAdmin, async (req, res, next) => {
  try {
    const customer = await db('customers').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const hasAnnualTerms = await db.schema.hasTable('annual_prepay_terms');
    if (!hasAnnualTerms) {
      return res.status(500).json({ error: 'Annual prepay terms table is not available' });
    }

    const parsedAmount = parseAnnualPrepayAmount(req.body?.amount);
    if (parsedAmount.error) return res.status(400).json({ error: parsedAmount.error });
    const amount = parsedAmount.amount;

    const parsedVisitCount = parseAnnualPrepayVisitCount(req.body?.visitCount ?? 4);
    if (parsedVisitCount.error) return res.status(400).json({ error: parsedVisitCount.error });
    const visitCount = parsedVisitCount.visitCount;

    const coverageCadence = cleanOptionalText(req.body?.coverageCadence || req.body?.cadence) || null;
    const coverageServiceType = cleanOptionalText(req.body?.serviceType) || 'Quarterly Pest Control';
    const planLabel = cleanOptionalText(req.body?.planLabel) || `${coverageServiceType} Annual Prepay`;

    const method = cleanText(req.body?.method || 'card_present').toLowerCase();
    if (!ANNUAL_PREPAY_PAYMENT_METHODS.has(method)) {
      return res.status(400).json({
        error: `method must be one of: ${Array.from(ANNUAL_PREPAY_PAYMENT_METHODS).join(', ')}`,
      });
    }

    const activeTerm = await db('annual_prepay_terms')
      .where({ customer_id: customer.id })
      .where(annualPrepayOverlapStatusClause())
      .orderBy('term_end', 'desc')
      .first();

    const termStartInput = parseDateOnlyInput(req.body?.termStart, 'termStart');
    if (termStartInput.error) return res.status(400).json({ error: termStartInput.error });
    const termStart = termStartInput.date || defaultAnnualPrepayTermStart(activeTerm);

    const termEndInput = parseDateOnlyInput(req.body?.termEnd, 'termEnd');
    if (termEndInput.error) return res.status(400).json({ error: termEndInput.error });
    const termEnd = termEndInput.date || addMonthsDateOnly(termStart, 12);
    if (!termEnd || termEnd <= termStart) {
      return res.status(400).json({ error: 'termEnd must be after termStart' });
    }

    const activeTermEnd = dateOnlyForApi(activeTerm?.term_end);
    if (activeTermEnd && termStart <= activeTermEnd && req.body?.allowOverlap !== true) {
      return res.status(409).json({
        error: `Customer already has an active annual prepay term through ${activeTermEnd}. Use a start date after ${activeTermEnd}.`,
        activeTermId: activeTerm.id,
        activeTermEnd,
      });
    }

    const reference = cleanOptionalText(req.body?.reference);
    const note = cleanOptionalText(req.body?.note);
    const recordedBy = req.technician?.name || req.technician?.email || req.technicianId || 'admin';
    const invoiceNotes = [
      'Created from Customer 360 annual prepay.',
      `Annual prepaid ${coverageServiceType}.`,
      `Covers ${visitCount} service application${visitCount === 1 ? '' : 's'} from ${termStart} through ${termEnd}.`,
      `Payment already collected via ${method.replace(/_/g, ' ')}.`,
      reference ? `Reference: ${reference}.` : null,
      note ? `Note: ${note}` : null,
    ].filter(Boolean).join('\n');

    const InvoiceService = require('../services/invoice');
    let result;
    await db.transaction(async (trx) => {
      await lockAndAssertNoAnnualPrepayOverlap(
        trx, customer.id, termStart, req.body?.allowOverlap === true,
        'Customer already has an active annual prepay term through',
      );
      const invoice = await InvoiceService.create({
        database: trx,
        customerId: customer.id,
        title: `${coverageServiceType} - Annual Prepay`,
        lineItems: [{
          description: `${coverageServiceType} - ${visitCount} prepaid application${visitCount === 1 ? '' : 's'}`,
          quantity: 1,
          unit_price: amount,
          category: 'Annual prepay',
        }],
        notes: invoiceNotes,
        dueDate: termStart,
      });

      const [updatedInvoice] = await trx('invoices')
        .where({ id: invoice.id })
        .update({
          status: 'paid',
          paid_at: trx.fn.now(),
          payment_method: method,
          payment_reference: reference || null,
          payment_recorded_by: recordedBy,
          payment_recorded_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        })
        .returning('*');
      if (!updatedInvoice) throw new Error('Annual prepay invoice could not be marked paid');

      const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
      const term = await AnnualPrepayRenewals.createTermForAnnualPrepay({
        customerId: customer.id,
        prepayInvoiceId: updatedInvoice.id,
        planLabel,
        monthlyRate: Number(customer.monthly_rate || 0) || Math.round((amount / 12) * 100) / 100,
        // Match the recorded payment (inserted below as updatedInvoice.total) and
        // the coverage ledger: commercial invoices add county tax, so the pretax
        // request amount would under-credit the prepaid visits.
        prepayAmount: Number(updatedInvoice.total),
        termStart,
        termEnd,
        coverageServiceType,
        coverageVisitCount: visitCount,
        coverageCadence,
        conn: trx,
      });
      if (!term) throw new Error('Annual prepay term could not be activated');

      const [payment] = await trx('payments').insert({
        customer_id: customer.id,
        amount: Number(updatedInvoice.total),
        status: 'paid',
        description: `Invoice ${updatedInvoice.invoice_number} - annual prepay (${method.replace(/_/g, ' ')})`,
        payment_date: etDateString(),
        metadata: JSON.stringify({
          invoice_id: updatedInvoice.id,
          annual_prepay_term_id: term.id,
          source: 'customer360_annual_prepay',
          method,
          reference: reference || null,
          term_start: termStart,
          term_end: termEnd,
          coverage_service_type: coverageServiceType,
          coverage_visit_count: visitCount,
          coverage_cadence: coverageCadence,
        }),
      }).returning('*');

      await trx('activity_log').insert({
        customer_id: customer.id,
        action: 'annual_prepay_recorded',
        description: `Annual prepay recorded for ${coverageServiceType}: $${Number(updatedInvoice.total).toFixed(2)} covering ${visitCount} visit(s) via ${method.replace(/_/g, ' ')}`,
        metadata: JSON.stringify({
          invoice_id: updatedInvoice.id,
          invoice_number: updatedInvoice.invoice_number,
          annual_prepay_term_id: term.id,
          payment_id: payment?.id || null,
          coverage_service_type: coverageServiceType,
          coverage_visit_count: visitCount,
          coverage_cadence: coverageCadence,
          term_start: termStart,
          term_end: termEnd,
        }),
      }).catch((err) => logger.warn(`[customers:annual-prepay] activity_log insert failed: ${err.message}`));

      result = { invoice: updatedInvoice, term, payment };
    });

    await auditCustomerMutation(req, 'customer.annual_prepay.record', customer.id, {
      invoiceId: result.invoice.id,
      invoiceNumber: result.invoice.invoice_number,
      annualPrepayTermId: result.term.id,
      amount: Number(result.invoice.total),
      baseAmount: amount,
      method,
      serviceType: coverageServiceType,
      visitCount,
      coverageCadence,
      termStart,
      termEnd,
    }, true);

    res.status(201).json({
      success: true,
      invoice: result.invoice,
      annualPrepayTerm: {
        id: result.term.id,
        customerId: result.term.customer_id,
        prepayInvoiceId: result.term.prepay_invoice_id,
        planLabel: result.term.plan_label,
        monthlyRate: result.term.monthly_rate != null ? Number(result.term.monthly_rate) : null,
        prepayAmount: result.term.prepay_amount != null ? Number(result.term.prepay_amount) : null,
        termStart: dateOnlyForApi(result.term.term_start),
        termEnd: dateOnlyForApi(result.term.term_end),
        status: result.term.status,
        coverageServiceType: result.term.coverage_service_type || null,
        coverageVisitCount: result.term.coverage_visit_count != null ? Number(result.term.coverage_visit_count) : null,
        coverageCadence: result.term.coverage_cadence || null,
      },
    });
  } catch (err) {
    if (err && err.annualPrepayOverlap) return res.status(409).json(err.annualPrepayOverlap);
    next(err);
  }
});

// =========================================================================
// POST /api/admin/customers/:id/refund — Refund a Stripe payment
// =========================================================================
router.post('/:id/refund', requireAdmin, async (req, res, next) => {
  try {
    const { paymentId, amount, reason } = req.body;
    if (!paymentId) return res.status(400).json({ error: 'paymentId required' });

    const payment = await db('payments').where({ id: paymentId, customer_id: req.params.id }).first();
    if (!payment) return res.status(404).json({ error: 'Payment not found for this customer' });
    if (amount !== undefined && amount !== null && amount !== '') {
      const refundAmount = parseFloat(amount);
      if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
        return res.status(400).json({ error: 'Refund amount must be greater than 0' });
      }
      if (refundAmount > parseFloat(payment.amount || 0)) {
        return res.status(400).json({ error: 'Refund amount cannot exceed payment amount' });
      }
    }

    await auditCustomerMutation(req, 'customer.payment.refund', req.params.id, {
      paymentId,
      amount: amount || null,
      reason: reason || 'requested_by_customer',
    }, true);
    const StripeService = require('../services/stripe');
    const result = await StripeService.refund(paymentId, { amount, reason: reason || 'requested_by_customer' });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /:id/credits — account credit balance + ledger history for Customer 360.
router.get('/:id/credits', async (req, res, next) => {
  try {
    const customer = await db('customers').where({ id: req.params.id }).first('id');
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    const [balance, ledger] = await Promise.all([
      CustomerCredit.getBalance(req.params.id),
      CustomerCredit.getLedger(req.params.id, { limit: 100 }),
    ]);
    res.json({ balance: balance || 0, ledger });
  } catch (err) { next(err); }
});

// POST /:id/credits — issue or adjust account credit (Customer 360).
// Body: {
//   amount: number    — non-zero; negative deducts
//   kind:   string     — 'prepayment' | 'goodwill' | 'adjustment'
//   method?: string    — cash/check/zelle/card/other (prepayment only)
//   note?:  string
// }
//
// Revenue recognition (owner decision 2026-06-17): cash arrives as a
// `prepayment` — that books a paid `payments` row HERE, at receipt, so it
// counts as collected/taxable once. `goodwill`/`adjustment` are non-cash and
// book NO payments row (they must never inflate revenue/tax). Applying credit
// to an invoice later does NOT re-book revenue (see apply-credit). Referral /
// invoice-application ledger sources are system-driven and not settable here.
const CREDIT_PAYMENT_METHODS = ['cash', 'check', 'zelle', 'card', 'other'];

router.post('/:id/credits', requireAdmin, async (req, res, next) => {
  try {
    const { amount, kind = 'goodwill', method = 'other', note } = req.body || {};
    const delta = Number(amount);
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ error: 'amount must be a non-zero number' });
    }
    if (!['prepayment', 'goodwill', 'adjustment'].includes(kind)) {
      return res.status(400).json({ error: "kind must be 'prepayment', 'goodwill', or 'adjustment'" });
    }
    // A prepayment is money received — it only makes sense as an addition.
    if (kind === 'prepayment' && delta < 0) {
      return res.status(400).json({ error: 'A prepayment must be a positive amount (money received)' });
    }
    if (kind === 'prepayment' && !CREDIT_PAYMENT_METHODS.includes(method)) {
      return res.status(400).json({ error: `method must be one of: ${CREDIT_PAYMENT_METHODS.join(', ')}` });
    }
    const createdBy = req.technician?.name || req.technician?.email || req.technicianId || 'admin';
    // Ledger provenance: adjustments are corrections; prepayment + goodwill
    // are both operator-issued credit ('manual').
    const ledgerSource = kind === 'adjustment' ? 'adjustment' : 'manual';
    const trimmedNote = note ? String(note).slice(0, 1000) : null;
    const ledgerNote = [kind, kind === 'prepayment' ? method : null, trimmedNote]
      .filter(Boolean).join(' · ').slice(0, 1000);

    let result;
    try {
      result = await db.transaction(async (trx) => {
        const movement = await CustomerCredit.postCreditMovement({
          customerId: req.params.id,
          delta,
          source: ledgerSource,
          note: ledgerNote || null,
          createdBy,
        }, trx);

        // Cash-backed prepayment → recognize the money at receipt. No
        // invoice link yet (the credit is held until applied). Matches the
        // off-gateway payments-ledger convention (null processor).
        if (kind === 'prepayment') {
          await trx('payments').insert({
            customer_id: req.params.id,
            amount: CustomerCredit.round2(delta),
            status: 'paid',
            description: `Account credit prepayment — ${method}`
              + (trimmedNote ? ` (${trimmedNote.slice(0, 120)})` : ''),
            payment_date: etDateString(),
            metadata: JSON.stringify({ source: 'account_credit_prepayment', method }),
          });
        }

        // Critical audit inside the same transaction as the money movement —
        // if it fails, the whole thing rolls back, so a retry can't duplicate
        // the credit/revenue (the operator never sees a committed-but-errored
        // state).
        await auditCustomerMutation(req, 'customer.credit.adjust', req.params.id, {
          amount: CustomerCredit.round2(delta),
          kind,
          method: kind === 'prepayment' ? method : null,
          balance_after: movement.balanceAfter,
          note: trimmedNote,
        }, true, trx);

        return movement;
      });
    } catch (err) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      throw err;
    }

    await db('activity_log').insert({
      customer_id: req.params.id,
      action: 'account_credit_adjusted',
      description: `Account credit ${delta >= 0 ? 'added' : 'deducted'} `
        + `$${Math.abs(CustomerCredit.round2(delta)).toFixed(2)} (${kind}`
        + `${kind === 'prepayment' ? ` · ${method}` : ''})`
        + ` — balance $${result.balanceAfter.toFixed(2)} · ${createdBy}`
        + (trimmedNote ? ` — ${trimmedNote.slice(0, 120)}` : ''),
    }).catch((e) => logger.warn(`[admin-customers] credit activity_log insert failed: ${e.message}`));

    res.json({ ok: true, balance: result.balanceAfter, entry: result.entry });
  } catch (err) { next(err); }
});

router._private = {
  CUSTOMER_STAGES,
  adminMembershipDailyIdempotencyKey,
  adminMembershipStartIdempotencyKey,
  adminNotificationPrefsDbUpdates,
  addMonthsDateOnly,
  cadenceFromEstimateLine,
  compactServiceContactSlots,
  customerSearchTerms,
  defaultAnnualPrepayTermStart,
  hasMembership,
  indexServicesForSchedule,
  isSchedulableOneTimeEstimateLine,
  isValidStage,
  mapCustomerListRow,
  mapPipelineCustomer,
  membershipDetailsChanged,
  parseAnnualPrepayAmount,
  parseAnnualPrepayVisitCount,
  scheduleLinesFromEstimate,
  serviceCatalogMatch,
};

router.ensureCustomerAccount = ensureCustomerAccount;
router.createDefaultCustomerRows = createDefaultCustomerRows;

module.exports = router;
