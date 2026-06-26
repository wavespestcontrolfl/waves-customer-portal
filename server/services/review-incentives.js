const db = require('../models/db');
const logger = require('./logger');
const { etParts, etDateString, addETDays } = require('../utils/datetime-et');

const POLICY_KEY = 'review_incentives.policy';
const DEFAULT_POLICY = {
  enabled: true,
  amountCents: 500,
  currency: 'USD',
  eligibleSources: ['google_review'],
  minRating: 1,
  requireCustomerMatchForGoogle: true,
  programStartsAt: null,
};

const PAYOUT_ELIGIBLE_SOURCES = ['google_review'];

const DAY_MS = 24 * 60 * 60 * 1000;

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asDate(value, fallback = new Date()) {
  const d = value ? new Date(value) : new Date(fallback);
  return Number.isNaN(d.getTime()) ? new Date(fallback) : d;
}

function validDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizedIsoDate(value) {
  const d = validDate(value);
  return d ? d.toISOString() : null;
}

function dateOnly(date) {
  return asDate(date).toISOString().slice(0, 10);
}

function isDateOnlyString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function etBusinessDateAnchor(date) {
  if (isDateOnlyString(date)) {
    const [year, month, day] = date.trim().split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  }
  return asDate(date);
}

function etBusinessDate(date) {
  return etDateString(etBusinessDateAnchor(date));
}

function etBusinessDateOffset(date, days) {
  return etDateString(addETDays(etBusinessDateAnchor(date), days));
}

function weekPeriodFor(date) {
  const d = etBusinessDateAnchor(date);
  const { dayOfWeek } = etParts(d);
  const start = addETDays(d, dayOfWeek === 0 ? -6 : 1 - dayOfWeek);
  const end = addETDays(start, 6);
  return {
    start: etDateString(start),
    end: etDateString(end),
  };
}

function parsePolicy(value) {
  if (!value) return { ...DEFAULT_POLICY };
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_POLICY };
    }
    return {
      ...DEFAULT_POLICY,
      ...parsed,
      amountCents: Math.max(0, toInt(parsed.amountCents, DEFAULT_POLICY.amountCents)),
      minRating: Math.max(1, Math.min(5, toInt(parsed.minRating, DEFAULT_POLICY.minRating))),
      eligibleSources: PAYOUT_ELIGIBLE_SOURCES,
      programStartsAt: normalizedIsoDate(parsed.programStartsAt) || null,
    };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

function reviewEarnedAt(review) {
  return validDate(review?.review_created_at || review?.created_at) || new Date();
}

function programStart(policy) {
  return validDate(policy?.programStartsAt);
}

function reviewWithinProgramWindow(review, policy) {
  const startsAt = programStart(policy);
  if (!startsAt) return true;
  return reviewEarnedAt(review).getTime() >= startsAt.getTime();
}

function operationalError(message, statusCode = 400, code = 'review_incentive_error') {
  const err = new Error(message);
  err.isOperational = true;
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

async function getPolicy(conn = db) {
  try {
    const row = await conn('system_settings').where({ key: POLICY_KEY }).first();
    return parsePolicy(row?.value);
  } catch (err) {
    logger.warn(`[review-incentives] policy lookup failed; using defaults (${err?.code || err?.name || 'Error'})`);
    return { ...DEFAULT_POLICY };
  }
}

async function savePolicy(policyPatch = {}, conn = db) {
  const current = await getPolicy(conn);
  const policy = parsePolicy({ ...current, ...policyPatch });
  const now = new Date();
  await conn('system_settings')
    .insert({
      key: POLICY_KEY,
      value: JSON.stringify(policy),
      category: 'reviews',
      description: 'Technician review incentive automation policy',
      created_at: now,
      updated_at: now,
    })
    .onConflict('key')
    .merge({
      value: JSON.stringify(policy),
      category: 'reviews',
      description: 'Technician review incentive automation policy',
      updated_at: now,
    });
  return policy;
}

function qualifiesReviewRequest(request, policy) {
  return false;
}

function qualifiesGoogleReview(review, policy) {
  if (!policy.enabled) return false;
  if (!policy.eligibleSources.includes('google_review')) return false;
  if (!review || review.reviewer_name === '_stats') return false;
  if (!reviewWithinProgramWindow(review, policy)) return false;
  if (policy.requireCustomerMatchForGoogle && !review.customer_id) return false;
  const rating = toInt(review.star_rating, 0);
  return rating >= Math.max(1, toInt(policy.minRating, 1));
}

async function resolveTechnicianForReviewRequest(request, conn = db) {
  if (!request) return null;
  if (request.technician_id) {
    return {
      technicianId: request.technician_id,
      serviceRecordId: request.service_record_id || null,
      method: 'review_request.technician_id',
    };
  }

  if (request.service_record_id) {
    const record = await conn('service_records')
      .where({ 'service_records.id': request.service_record_id })
      .leftJoin('scheduled_services', 'service_records.scheduled_service_id', 'scheduled_services.id')
      .select(
        'service_records.id',
        'service_records.technician_id as record_technician_id',
        'scheduled_services.technician_id as scheduled_technician_id',
      )
      .first();
    const technicianId = record?.record_technician_id || record?.scheduled_technician_id || null;
    if (technicianId) {
      return {
        technicianId,
        serviceRecordId: request.service_record_id,
        method: record.record_technician_id ? 'service_records.technician_id' : 'scheduled_services.technician_id',
      };
    }
  }

  if (request.customer_id) {
    const serviceDate = request.service_date || request.rated_at || request.submitted_at || request.created_at || new Date();
    const record = await conn('service_records')
      .where({ customer_id: request.customer_id })
      .whereNotNull('technician_id')
      .where('service_date', '<=', dateOnly(serviceDate))
      .orderBy('service_date', 'desc')
      .first();
    if (record?.technician_id) {
      return {
        technicianId: record.technician_id,
        serviceRecordId: record.id,
        method: 'nearest_prior_service_record',
      };
    }
  }

  return null;
}

async function resolveTechnicianForGoogleReview(review, conn = db) {
  if (!review?.customer_id) return null;
  const reviewDate = review.review_created_at || review.created_at || new Date();
  const reviewDateOnly = etBusinessDate(reviewDate);
  const cutoff = etBusinessDateOffset(reviewDate, -45);

  const serviceRecord = await conn('service_records')
    .where({ customer_id: review.customer_id })
    .whereNotNull('technician_id')
    .where('service_date', '<=', reviewDateOnly)
    .where('service_date', '>=', cutoff)
    .orderBy('service_date', 'desc')
    .first();
  if (serviceRecord?.technician_id) {
    return {
      technicianId: serviceRecord.technician_id,
      serviceRecordId: serviceRecord.id,
      method: 'nearest_prior_service_record',
    };
  }

  const scheduled = await conn('scheduled_services')
    .where({ customer_id: review.customer_id, status: 'completed' })
    .whereNotNull('technician_id')
    .where('scheduled_date', '<=', reviewDateOnly)
    .where('scheduled_date', '>=', cutoff)
    .orderBy('scheduled_date', 'desc')
    .first();
  if (scheduled?.technician_id) {
    return {
      technicianId: scheduled.technician_id,
      serviceRecordId: null,
      method: 'nearest_prior_scheduled_service',
    };
  }

  const request = await conn('review_requests')
    .where({ customer_id: review.customer_id })
    .whereNotNull('technician_id')
    .where('created_at', '>=', new Date(asDate(reviewDate).getTime() - 45 * DAY_MS))
    .orderBy('created_at', 'desc')
    .first();
  if (request?.technician_id) {
    return {
      technicianId: request.technician_id,
      serviceRecordId: request.service_record_id || null,
      reviewRequestId: request.id,
      method: 'recent_review_request',
    };
  }

  return null;
}

async function existingPayoutForSource({ reviewRequestId, googleReviewId, serviceRecordId, technicianId }, conn = db) {
  if (googleReviewId) {
    const row = await conn('review_incentive_payouts').where({ google_review_id: googleReviewId }).first();
    if (row) return row;
  }
  if (!googleReviewId && reviewRequestId) {
    const row = await conn('review_incentive_payouts').where({ review_request_id: reviewRequestId }).first();
    if (row) return row;
  }
  if (!googleReviewId && serviceRecordId && technicianId) {
    const row = await conn('review_incentive_payouts')
      .where({ service_record_id: serviceRecordId, technician_id: technicianId })
      .first();
    if (row) return row;
  }
  return null;
}

async function insertPayout(attrs, conn = db) {
  const existing = await existingPayoutForSource(attrs, conn);
  if (existing) return { payout: existing, created: false, reason: 'duplicate' };

  const earnedAt = asDate(attrs.earnedAt || new Date());
  const period = weekPeriodFor(earnedAt);
  const row = {
    technician_id: attrs.technicianId,
    customer_id: attrs.customerId || null,
    service_record_id: attrs.serviceRecordId || null,
    review_request_id: attrs.reviewRequestId || null,
    google_review_id: attrs.googleReviewId || null,
    source: attrs.source,
    amount_cents: attrs.amountCents,
    currency: attrs.currency || DEFAULT_POLICY.currency,
    status: 'earned',
    earned_at: earnedAt,
    pay_period_start: period.start,
    pay_period_end: period.end,
    notes: attrs.notes || null,
    attribution_snapshot: JSON.stringify(attrs.attributionSnapshot || {}),
  };

  try {
    const [payout] = await conn('review_incentive_payouts').insert(row).returning('*');
    return { payout: payout || row, created: true };
  } catch (err) {
    if (err?.code === '23505') {
      const duplicate = await existingPayoutForSource(attrs, conn);
      if (duplicate) return { payout: duplicate, created: false, reason: 'duplicate' };
    }
    throw err;
  }
}

async function createPayoutForReviewRequest(requestId, options = {}) {
  return { created: false, skipped: true, reason: 'confirmed_google_review_required' };
}

async function createPayoutForGoogleReview(reviewId, options = {}) {
  const conn = options.conn || db;
  const policy = options.policy || await getPolicy(conn);
  const review = typeof reviewId === 'object'
    ? reviewId
    : await conn('google_reviews').where({ id: reviewId }).first();
  if (review && !reviewWithinProgramWindow(review, policy)) {
    return { created: false, skipped: true, reason: 'before_program_start' };
  }
  if (!qualifiesGoogleReview(review, policy)) {
    return { created: false, skipped: true, reason: 'not_eligible' };
  }

  const attribution = await resolveTechnicianForGoogleReview(review, conn);
  if (!attribution?.technicianId) {
    return { created: false, skipped: true, reason: 'unattributed' };
  }

  return insertPayout({
    technicianId: attribution.technicianId,
    customerId: review.customer_id,
    serviceRecordId: attribution.serviceRecordId || null,
    reviewRequestId: attribution.reviewRequestId || null,
    googleReviewId: review.id,
    source: 'google_review',
    amountCents: policy.amountCents,
    currency: policy.currency,
    earnedAt: review.review_created_at || review.created_at || new Date(),
    attributionSnapshot: {
      method: attribution.method,
      locationId: review.location_id || null,
      starRating: review.star_rating || null,
      googleReviewId: review.google_review_id || null,
    },
  }, conn);
}

async function syncReviewIncentives(options = {}) {
  const conn = options.conn || db;
  const policy = options.policy || await getPolicy(conn);
  const sinceDays = Math.max(1, Math.min(365, toInt(options.sinceDays, 90)));
  const since = new Date(Date.now() - sinceDays * DAY_MS);
  const startsAt = programStart(policy);
  const effectiveSince = startsAt && startsAt > since ? startsAt : since;
  const summary = {
    scannedGoogleReviews: 0,
    created: 0,
    duplicates: 0,
    skipped: 0,
    unattributed: 0,
  };

  if (!policy.enabled) return { ...summary, policyEnabled: false };

  const googleReviews = await conn('google_reviews')
    .where('reviewer_name', '!=', '_stats')
    .where('review_created_at', '>=', effectiveSince.toISOString())
    .limit(500);

  for (const review of googleReviews) {
    summary.scannedGoogleReviews++;
    const result = await createPayoutForGoogleReview(review, { conn, policy });
    if (result.created) summary.created++;
    else if (result.reason === 'duplicate') summary.duplicates++;
    else if (result.reason === 'unattributed') summary.unattributed++;
    else summary.skipped++;
  }

  if (summary.created > 0) {
    logger.info(`[review-incentives] created=${summary.created} duplicates=${summary.duplicates} unattributed=${summary.unattributed}`);
  }

  return { ...summary, policyEnabled: true };
}

function dollars(cents) {
  return Math.round(toInt(cents, 0)) / 100;
}

function customerName(row) {
  return [row?.first_name, row?.last_name].filter(Boolean).join(' ').trim() || null;
}

function serializePayout(row) {
  return {
    id: row.id,
    technicianId: row.technician_id,
    technicianName: row.technician_name || 'Unassigned',
    customerId: row.customer_id,
    customerName: [row.customer_first_name, row.customer_last_name].filter(Boolean).join(' ') || null,
    source: row.source,
    amountCents: toInt(row.amount_cents, 0),
    amount: dollars(row.amount_cents),
    currency: row.currency || 'USD',
    status: row.status,
    earnedAt: row.earned_at,
    payPeriodStart: row.pay_period_start,
    payPeriodEnd: row.pay_period_end,
    paidAt: row.paid_at,
    exportedAt: row.exported_at,
    rating: row.request_rating || row.review_star_rating || null,
    serviceType: row.request_service_type || null,
    reviewText: row.review_text || null,
  };
}

function serializeCustomer(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: customerName(row) || 'Customer',
    phone: row.phone || null,
    email: row.email || null,
    address: [row.address_line1, row.address_line2].filter(Boolean).join(' ') || null,
    city: row.city || null,
    state: row.state || null,
    zip: row.zip || null,
  };
}

function serializeServiceCandidate(row, type = 'service_record') {
  if (!row) return null;
  const isServiceRecord = type === 'service_record';
  return {
    id: row.id,
    type,
    serviceRecordId: isServiceRecord ? row.id : null,
    scheduledServiceId: isServiceRecord ? (row.scheduled_service_id || null) : row.id,
    serviceDate: row.service_date || row.scheduled_date || null,
    serviceType: row.service_type || null,
    technicianId: row.technician_id || null,
    technicianName: row.technician_name || row.tech_name || 'Technician',
  };
}

async function recentServiceCandidatesForCustomer(customerId, review, conn = db, limit = 8) {
  if (!customerId) return [];
  const reviewDate = review?.review_created_at || review?.created_at || new Date();
  const reviewDateOnly = etBusinessDate(reviewDate);
  const cutoff = etBusinessDateOffset(reviewDate, -90);

  const records = await conn('service_records as sr')
    .leftJoin('technicians as t', 'sr.technician_id', 't.id')
    .where({ 'sr.customer_id': customerId })
    .whereNotNull('sr.technician_id')
    .where('sr.service_date', '<=', reviewDateOnly)
    .where('sr.service_date', '>=', cutoff)
    .orderBy('sr.service_date', 'desc')
    .limit(limit)
    .select(
      'sr.id',
      'sr.scheduled_service_id',
      'sr.service_date',
      'sr.service_type',
      'sr.technician_id',
      't.name as technician_name',
    );

  const services = records.map(row => serializeServiceCandidate(row, 'service_record')).filter(Boolean);
  if (services.length >= limit) return services.slice(0, limit);

  const scheduled = await conn('scheduled_services as ss')
    .leftJoin('technicians as t', 'ss.technician_id', 't.id')
    .where({ 'ss.customer_id': customerId, 'ss.status': 'completed' })
    .whereNotNull('ss.technician_id')
    .where('ss.scheduled_date', '<=', reviewDateOnly)
    .where('ss.scheduled_date', '>=', cutoff)
    .orderBy('ss.scheduled_date', 'desc')
    .limit(limit - services.length)
    .select(
      'ss.id',
      'ss.scheduled_date',
      'ss.service_type',
      'ss.technician_id',
      't.name as technician_name',
    );

  return [
    ...services,
    ...scheduled.map(row => serializeServiceCandidate(row, 'scheduled_service')).filter(Boolean),
  ];
}

function serializeAttributionQueueItem(review, customer, reason) {
  return {
    id: review.id,
    googleReviewId: review.google_review_id || null,
    locationId: review.location_id || null,
    reviewerName: review.reviewer_name || 'Google reviewer',
    starRating: review.star_rating || null,
    reviewText: review.review_text || null,
    reviewCreatedAt: review.review_created_at || review.created_at || null,
    customerId: review.customer_id || null,
    customerName: customerName(customer),
    reason,
  };
}

async function getAttributionQueue(options = {}) {
  const conn = options.conn || db;
  const policy = options.policy || await getPolicy(conn);
  const days = Math.max(1, Math.min(365, toInt(options.days, 30)));
  const limit = Math.max(1, Math.min(250, toInt(options.limit, 100)));
  const since = new Date(Date.now() - days * DAY_MS);
  const startsAt = programStart(policy);
  const effectiveSince = startsAt && startsAt > since ? startsAt : since;

  if (!policy.enabled) return { items: [], policyEnabled: false };

  const reviews = await conn('google_reviews')
    .where('reviewer_name', '!=', '_stats')
    .where('review_created_at', '>=', effectiveSince.toISOString())
    .orderBy('review_created_at', 'desc')
    .limit(limit);

  const reviewIds = reviews.map(row => row.id).filter(Boolean);
  const paidRows = reviewIds.length
    ? await conn('review_incentive_payouts').whereIn('google_review_id', reviewIds).select('google_review_id')
    : [];
  const paidReviewIds = new Set(paidRows.map(row => row.google_review_id).filter(Boolean));

  const items = [];
  for (const review of reviews) {
    if (paidReviewIds.has(review.id)) continue;
    const rating = toInt(review.star_rating, 0);
    if (rating < Math.max(1, toInt(policy.minRating, 1))) continue;

    if (!review.customer_id) {
      items.push(serializeAttributionQueueItem(review, null, 'missing_customer'));
      continue;
    }

    const customer = await conn('customers').where({ id: review.customer_id }).first();
    const attribution = await resolveTechnicianForGoogleReview(review, conn);
    if (!attribution?.technicianId) {
      items.push(serializeAttributionQueueItem(review, customer, 'missing_technician'));
    }
  }

  return {
    items,
    count: items.length,
    policyEnabled: true,
    period: {
      days,
      since: effectiveSince.toISOString(),
      programStartsAt: policy.programStartsAt || null,
    },
  };
}

async function searchAttributionCandidates(options = {}) {
  const conn = options.conn || db;
  const reviewId = options.reviewId;
  const limit = Math.max(1, Math.min(25, toInt(options.limit, 10)));
  if (!reviewId) throw operationalError('reviewId required', 400, 'review_id_required');

  const review = await conn('google_reviews').where({ id: reviewId }).first();
  if (!review || review.reviewer_name === '_stats') {
    throw operationalError('Google review not found', 404, 'review_not_found');
  }

  const search = String(options.q || '').trim();
  const fallbackName = String(review.reviewer_name || '').trim();
  const terms = search || fallbackName;
  let query = conn('customers')
    .where({ active: true })
    .orderBy('last_name', 'asc')
    .limit(limit)
    .select(
      'id',
      'first_name',
      'last_name',
      'phone',
      'email',
      'address_line1',
      'address_line2',
      'city',
      'state',
      'zip',
    );

  if (terms) {
    const like = `%${terms}%`;
    const likeLower = `%${terms.toLowerCase()}%`;
    query = query.where(function searchCustomers() {
      this.whereILike('first_name', like)
        .orWhereILike('last_name', like)
        .orWhereRaw("LOWER(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) LIKE ?", [likeLower])
        .orWhereILike('phone', like)
        .orWhereILike('email', like)
        .orWhereILike('address_line1', like)
        .orWhereILike('city', like);
    });
  }

  const customers = await query;
  const candidates = [];
  for (const customer of customers) {
    const services = await recentServiceCandidatesForCustomer(customer.id, review, conn);
    candidates.push({
      ...serializeCustomer(customer),
      services,
    });
  }

  return {
    review: serializeAttributionQueueItem(review, null, review.customer_id ? 'missing_technician' : 'missing_customer'),
    candidates,
  };
}

async function manualAttributeGoogleReview(attrs = {}, options = {}) {
  const conn = options.conn || db;
  const policy = options.policy || await getPolicy(conn);
  const reviewId = attrs.reviewId;
  const customerId = attrs.customerId;
  let technicianId = attrs.technicianId || null;
  let serviceRecordId = attrs.serviceRecordId || null;

  if (!reviewId) throw operationalError('reviewId required', 400, 'review_id_required');
  if (!customerId) throw operationalError('customerId required', 400, 'customer_id_required');
  if (!policy.enabled) throw operationalError('Review incentive policy is disabled', 422, 'policy_disabled');

  const review = await conn('google_reviews').where({ id: reviewId }).first();
  if (!review || review.reviewer_name === '_stats') {
    throw operationalError('Google review not found', 404, 'review_not_found');
  }
  if (!reviewWithinProgramWindow(review, policy)) {
    throw operationalError('Google review predates the review incentive program start', 422, 'review_before_program_start');
  }
  if (toInt(review.star_rating, 0) < Math.max(1, toInt(policy.minRating, 1))) {
    throw operationalError('Google review does not meet the minimum rating policy', 422, 'review_below_min_rating');
  }

  const customer = await conn('customers').where({ id: customerId }).first();
  if (!customer) throw operationalError('Customer not found', 404, 'customer_not_found');

  let serviceRecord = null;
  if (serviceRecordId) {
    serviceRecord = await conn('service_records')
      .where({ id: serviceRecordId, customer_id: customerId })
      .first();
    if (!serviceRecord) {
      throw operationalError('Service record not found for selected customer', 404, 'service_record_not_found');
    }
    technicianId = technicianId || serviceRecord.technician_id || null;
  }

  if (!technicianId) {
    const attribution = await resolveTechnicianForGoogleReview({ ...review, customer_id: customerId }, conn);
    technicianId = attribution?.technicianId || null;
    serviceRecordId = serviceRecordId || attribution?.serviceRecordId || null;
  }

  if (!technicianId) {
    throw operationalError('technicianId required for manual attribution', 422, 'technician_id_required');
  }

  const technician = await conn('technicians').where({ id: technicianId }).first();
  if (!technician) throw operationalError('Technician not found', 404, 'technician_not_found');

  await conn('google_reviews')
    .where({ id: review.id })
    .update({
      customer_id: customerId,
      updated_at: new Date(),
    });

  const attributionSnapshot = {
    method: 'manual_admin_match',
    adminId: attrs.adminId || null,
    customerId,
    technicianId,
    serviceRecordId,
    locationId: review.location_id || null,
    starRating: review.star_rating || null,
    googleReviewId: review.google_review_id || null,
  };

  let result = await insertPayout({
    technicianId,
    customerId,
    serviceRecordId,
    reviewRequestId: null,
    googleReviewId: review.id,
    source: 'google_review',
    amountCents: policy.amountCents,
    currency: policy.currency,
    earnedAt: review.review_created_at || review.created_at || new Date(),
    attributionSnapshot,
  }, conn);

  // Re-attribution: a payout already existed for this review (the partial
  // unique index on google_review_id dedups it), so insertPayout no-ops with
  // reason:'duplicate'. Previously the endpoint reported success while leaving
  // the WRONG technician on the bonus — there was no way to correct a
  // mis-attributed payout from the UI. If the existing row is still unpaid and
  // any of the attribution fields changed, update it in place and flag the
  // response so the caller can tell a correction from a no-op. Paid rows are
  // immutable (payroll already closed) — surface that explicitly.
  if (result && result.created === false && result.payout) {
    const existing = result.payout;
    if (existing.status === 'paid') {
      result = { ...result, reattributed: false, alreadyPaid: true };
    } else {
      const changed =
        existing.technician_id !== technicianId ||
        existing.customer_id !== customerId ||
        (existing.service_record_id || null) !== (serviceRecordId || null);
      if (changed) {
        const [updated] = await conn('review_incentive_payouts')
          .where({ id: existing.id })
          .whereNot('status', 'paid')
          .update({
            technician_id: technicianId,
            customer_id: customerId,
            service_record_id: serviceRecordId || null,
            attribution_snapshot: JSON.stringify({ ...attributionSnapshot, reattributedFrom: existing.technician_id || null }),
            updated_at: new Date(),
          })
          .returning('*');
        result = { payout: updated || existing, created: false, reattributed: !!updated, reason: 'reattributed' };
      } else {
        result = { ...result, reattributed: false };
      }
    }
  }

  try {
    await conn('activity_log').insert({
      admin_user_id: attrs.adminId || null,
      customer_id: customerId,
      action: 'review_incentive_attributed',
      description: 'Manually attributed Google review incentive',
      metadata: JSON.stringify({
        googleReviewId: review.id,
        technicianId,
        serviceRecordId,
        payoutId: result.payout?.id || null,
      }),
    });
  } catch (err) {
    logger.warn(`[review-incentives] manual attribution activity log failed (${err?.code || err?.name || 'Error'})`);
  }

  return {
    ...result,
    reviewId: review.id,
    customer: serializeCustomer(customer),
    technician: {
      id: technician.id,
      name: technician.name || 'Technician',
    },
  };
}

async function getDashboard(options = {}) {
  const conn = options.conn || db;
  const days = Math.max(1, Math.min(365, toInt(options.days, 30)));
  const periodStart = options.periodStart
    ? asDate(options.periodStart)
    : new Date(Date.now() - days * DAY_MS);
  const periodEnd = options.periodEnd ? asDate(options.periodEnd) : new Date();
  const policy = options.policy || await getPolicy(conn);
  const startsAt = programStart(policy);
  const effectivePeriodStart = startsAt && startsAt > periodStart ? startsAt : periodStart;

  const rows = await conn('review_incentive_payouts as p')
    .leftJoin('technicians as t', 'p.technician_id', 't.id')
    .leftJoin('customers as c', 'p.customer_id', 'c.id')
    .leftJoin('review_requests as rr', 'p.review_request_id', 'rr.id')
    .leftJoin('google_reviews as gr', 'p.google_review_id', 'gr.id')
    .where('p.source', 'google_review')
    .where('p.earned_at', '>=', effectivePeriodStart)
    .where('p.earned_at', '<=', periodEnd)
    .orderBy('p.earned_at', 'desc')
    .select(
      'p.*',
      't.name as technician_name',
      'c.first_name as customer_first_name',
      'c.last_name as customer_last_name',
      'rr.rating as request_rating',
      'rr.service_type as request_service_type',
      'gr.star_rating as review_star_rating',
      'gr.review_text as review_text',
    );

  const payouts = rows.map(serializePayout);
  const leaderboardByTech = new Map();
  for (const payout of payouts) {
    const key = payout.technicianId;
    if (!leaderboardByTech.has(key)) {
      leaderboardByTech.set(key, {
        technicianId: key,
        technicianName: payout.technicianName,
        reviewCount: 0,
        earnedCents: 0,
        paidCents: 0,
        pendingCents: 0,
      });
    }
    const row = leaderboardByTech.get(key);
    row.reviewCount += 1;
    row.earnedCents += payout.amountCents;
    if (payout.status === 'paid') row.paidCents += payout.amountCents;
    else row.pendingCents += payout.amountCents;
  }

  const leaderboard = Array.from(leaderboardByTech.values())
    .map(row => ({
      ...row,
      earned: dollars(row.earnedCents),
      paid: dollars(row.paidCents),
      pending: dollars(row.pendingCents),
    }))
    .sort((a, b) => b.earnedCents - a.earnedCents || b.reviewCount - a.reviewCount);

  let confirmedGoogleReviews = 0;
  let unattributedGoogleReviews = 0;
  try {
    const minRating = Math.max(1, toInt(policy.minRating, 1));
    const confirmedRow = await conn('google_reviews')
      .where('reviewer_name', '!=', '_stats')
      .where('review_created_at', '>=', effectivePeriodStart.toISOString())
      .where('review_created_at', '<=', periodEnd.toISOString())
      .where('star_rating', '>=', minRating)
      .count('* as count')
      .first();
    confirmedGoogleReviews = toInt(confirmedRow?.count, 0);
    // "Needs attribution" must match the attribution QUEUE, which surfaces any
    // in-window confirmed review WITHOUT a payout — whether it's missing a
    // customer or has a customer but no resolvable technician. The old query
    // counted only missing-customer, under-reporting the queue. Every confirmed
    // review that isn't yet a payout still needs attention, so subtract the
    // attributed reviews (each payout = one google review) from the confirmed
    // total. Derived from `payouts` (already in window) — no extra query, and
    // it tracks the queue rather than just the null-customer subset.
    unattributedGoogleReviews = Math.max(0, confirmedGoogleReviews - payouts.length);
  } catch {
    confirmedGoogleReviews = 0;
    unattributedGoogleReviews = 0;
  }

  const earnedCents = payouts.reduce((sum, p) => sum + p.amountCents, 0);
  const paidCents = payouts.filter(p => p.status === 'paid').reduce((sum, p) => sum + p.amountCents, 0);
  const pendingCents = earnedCents - paidCents;

  return {
    policy,
    period: {
      start: periodStart.toISOString(),
      effectiveStart: effectivePeriodStart.toISOString(),
      end: periodEnd.toISOString(),
      days,
      programStartsAt: policy.programStartsAt || null,
    },
    summary: {
      confirmedGoogleReviews,
      payoutCount: payouts.length,
      attributedReviews: payouts.length,
      earnedCents,
      earned: dollars(earnedCents),
      paidCents,
      paid: dollars(paidCents),
      pendingCents,
      pending: dollars(pendingCents),
      pendingCount: payouts.filter(p => p.status !== 'paid').length,
      paidCount: payouts.filter(p => p.status === 'paid').length,
      unattributedGoogleReviews,
      unattributedReviewRequests: 0,
    },
    leaderboard,
    payouts,
  };
}

async function markPaid(ids = [], options = {}) {
  const conn = options.conn || db;
  const cleanIds = ids.filter(Boolean);
  if (!cleanIds.length) return { updated: 0 };
  const patch = {
    status: 'paid',
    paid_at: new Date(),
    paid_by: options.paidBy || null,
    updated_at: new Date(),
  };
  const updated = await conn('review_incentive_payouts')
    .whereIn('id', cleanIds)
    .where('source', 'google_review')
    .whereNot('status', 'paid')
    .update(patch);
  return { updated: toInt(updated, 0) };
}

function toCsv(rows = []) {
  const header = [
    'Technician',
    'Customer',
    'Source',
    'Amount',
    'Status',
    'Earned At',
    'Pay Period Start',
    'Pay Period End',
  ];
  // Neutralize spreadsheet formula injection: a cell beginning with = + - @
  // (or a leading tab/CR that Excel trims back to one of those) executes as a
  // formula when the payroll CSV is opened in Excel/Sheets. Customer and
  // technician names are user-influenced, so prefix risky cells with a single
  // quote. Wrapped in the quoted CSV field, the leading ' is inert on re-parse.
  const neutralizeFormula = (str) =>
    /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  const escape = (value) => {
    const str = neutralizeFormula(String(value ?? ''));
    return `"${str.replace(/"/g, '""')}"`;
  };
  const body = rows.map(row => [
    row.technicianName,
    row.customerName,
    row.source,
    row.amount.toFixed(2),
    row.status,
    row.earnedAt,
    row.payPeriodStart,
    row.payPeriodEnd,
  ].map(escape).join(','));
  return [header.join(','), ...body].join('\n');
}

module.exports = {
  POLICY_KEY,
  DEFAULT_POLICY,
  getPolicy,
  savePolicy,
  createPayoutForReviewRequest,
  createPayoutForGoogleReview,
  syncReviewIncentives,
  getAttributionQueue,
  searchAttributionCandidates,
  manualAttributeGoogleReview,
  getDashboard,
  markPaid,
  toCsv,
  __private: {
    parsePolicy,
    qualifiesReviewRequest,
    qualifiesGoogleReview,
    weekPeriodFor,
    resolveTechnicianForReviewRequest,
    resolveTechnicianForGoogleReview,
    recentServiceCandidatesForCustomer,
    insertPayout,
  },
};
