/**
 * Google Data Manager API conversion uploads.
 *
 * This is intentionally upload-safe by default: admin-triggered calls validate
 * only unless GOOGLE_DATA_MANAGER_ALLOW_UPLOADS=true and validateOnly=false.
 *
 * Docs:
 * - https://developers.google.com/data-manager/api/devguides/events/google-ads/offline
 * - https://developers.google.com/data-manager/api/devguides/events/send-events
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { runExclusive } = require('../../utils/cron-lock');

let _googleapis;
function getGoogle() {
  if (!_googleapis) {
    try { _googleapis = require('googleapis').google; } catch { _googleapis = null; }
  }
  return _googleapis;
}

const DATA_MANAGER_SCOPE = 'https://www.googleapis.com/auth/datamanager';
const INGEST_URL = 'https://datamanager.googleapis.com/v1/events:ingest';
const REQUEST_STATUS_URL = 'https://datamanager.googleapis.com/v1/requestStatus:retrieve';
const DEFAULT_CURRENCY = 'USD';
const MAX_EVENTS_PER_REQUEST = 2000;
const MAX_LIMIT = 500;
const LIVE_UPLOAD_PENDING_STATUS = 'pending';
const LIVE_UPLOAD_SENT_STATUS = 'sent';

const CONVERSIONS = {
  qualified_lead: {
    label: 'Qualified Lead',
    sourceTable: 'leads',
    eventNameEnv: 'GOOGLE_ADS_DM_QUALIFIED_LEAD_EVENT_NAME',
    defaultEventName: 'Waves - Qualified Lead',
    destinationEnv: 'GOOGLE_ADS_DM_QUALIFIED_LEAD_CONVERSION_ACTION_ID',
    legacyDestinationEnv: 'GOOGLE_ADS_DATA_MANAGER_QUALIFIED_LEAD_CONVERSION_ACTION_ID',
  },
  completed_job_revenue: {
    label: 'Completed Job Revenue',
    sourceTable: 'estimate_actuals',
    eventNameEnv: 'GOOGLE_ADS_DM_COMPLETED_JOB_EVENT_NAME',
    defaultEventName: 'Waves - Completed Job Revenue',
    destinationEnv: 'GOOGLE_ADS_DM_COMPLETED_JOB_CONVERSION_ACTION_ID',
    legacyDestinationEnv: 'GOOGLE_ADS_DATA_MANAGER_COMPLETED_JOB_CONVERSION_ACTION_ID',
  },
};

function boolEnv(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function number(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function cleanNumericId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const conversionMatch = raw.match(/conversionActions\/(\d+)/i);
  if (conversionMatch) return conversionMatch[1];
  return raw.replace(/[^\d]/g, '');
}

function addDateStringDays(value, days) {
  const d = new Date(`${String(value || '').slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return value;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

function dateRange(periodDays = 30) {
  const days = Math.min(Math.max(parseInt(periodDays, 10) || 30, 1), 365);
  const since = etDateString(addETDays(new Date(), -days));
  const endDate = etDateString(addETDays(new Date(), -1));
  return { days, since, endDate };
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toRfc3339(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T16:00:00Z`;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeEmail(value) {
  const email = String(value || '').trim().replace(/\s+/g, '').toLowerCase();
  return email && email.includes('@') ? email : null;
}

function normalizePhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashedUserData({ email, phone }) {
  const identifiers = [];
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  if (normalizedEmail) identifiers.push({ emailAddress: sha256Hex(normalizedEmail) });
  if (normalizedPhone) identifiers.push({ phoneNumber: sha256Hex(normalizedPhone) });
  return identifiers.length ? { userIdentifiers: identifiers.slice(0, 10) } : null;
}

function eventNameFor(conversionType) {
  const config = CONVERSIONS[conversionType];
  return process.env[config.eventNameEnv] || config.defaultEventName;
}

function conversionValueForQualifiedLead() {
  const value = number(process.env.GOOGLE_ADS_DM_QUALIFIED_LEAD_VALUE);
  return value > 0 ? value : null;
}

function destinationIdFor(conversionType) {
  const config = CONVERSIONS[conversionType];
  return cleanNumericId(process.env[config.destinationEnv] || process.env[config.legacyDestinationEnv]);
}

function destinationFor(conversionType) {
  const customerId = cleanNumericId(
    process.env.GOOGLE_ADS_DATA_MANAGER_CUSTOMER_ID || process.env.GOOGLE_ADS_CUSTOMER_ID
  );
  const loginId = cleanNumericId(
    process.env.GOOGLE_ADS_DATA_MANAGER_LOGIN_CUSTOMER_ID || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
  );
  const productDestinationId = destinationIdFor(conversionType);

  if (!customerId || !productDestinationId) return null;

  const destination = {
    operatingAccount: { accountType: 'GOOGLE_ADS', accountId: customerId },
    productDestinationId,
  };
  if (loginId) {
    destination.loginAccount = { accountType: 'GOOGLE_ADS', accountId: loginId };
  }
  return destination;
}

function credentialsJson() {
  const raw = process.env.GOOGLE_ADS_DATA_MANAGER_SERVICE_ACCOUNT_JSON
    || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  let jsonStr = raw.trim();
  if (jsonStr.startsWith('{') && !jsonStr.endsWith('}')) jsonStr += '\n}';
  return JSON.parse(jsonStr);
}

function configurationFor(conversionType) {
  const destination = destinationFor(conversionType);
  const credentialsConfigured = !!(
    process.env.GOOGLE_ADS_DATA_MANAGER_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  );
  const customerId = cleanNumericId(
    process.env.GOOGLE_ADS_DATA_MANAGER_CUSTOMER_ID || process.env.GOOGLE_ADS_CUSTOMER_ID
  );
  const conversionActionId = destinationIdFor(conversionType);
  const liveUploadsAllowed = boolEnv('GOOGLE_DATA_MANAGER_ALLOW_UPLOADS', false);
  const forceValidateOnly = boolEnv('GOOGLE_DATA_MANAGER_VALIDATE_ONLY', true);

  return {
    conversionType,
    eventName: eventNameFor(conversionType),
    credentialsConfigured,
    customerIdConfigured: !!customerId,
    conversionActionIdConfigured: !!conversionActionId,
    destinationConfigured: !!destination,
    configured: credentialsConfigured && !!destination,
    liveUploadsAllowed,
    forceValidateOnly,
    destination: destination ? {
      operatingAccount: destination.operatingAccount,
      productDestinationId: destination.productDestinationId,
      hasLoginAccount: !!destination.loginAccount,
    } : null,
    missing: [
      ...(!credentialsConfigured ? ['GOOGLE_ADS_DATA_MANAGER_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_JSON'] : []),
      ...(!customerId ? ['GOOGLE_ADS_DATA_MANAGER_CUSTOMER_ID or GOOGLE_ADS_CUSTOMER_ID'] : []),
      ...(!conversionActionId ? [CONVERSIONS[conversionType].destinationEnv] : []),
    ],
  };
}

async function getAccessToken() {
  const g = getGoogle();
  if (!g) throw new Error('googleapis is not installed');
  const auth = new g.auth.GoogleAuth({
    credentials: credentialsJson(),
    scopes: [DATA_MANAGER_SCOPE],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const accessToken = typeof token === 'string' ? token : token?.token;
  if (!accessToken) throw new Error('Unable to obtain Google Data Manager access token');
  return accessToken;
}

function candidateHasClickId(candidate) {
  return !!(candidate.gclid || candidate.wbraid || candidate.gbraid);
}

function candidateHasUserData(candidate) {
  return !!(normalizeEmail(candidate.email) || normalizePhone(candidate.phone));
}

function skipReason(candidate) {
  if (!candidate.eventTimestamp) return 'missing_event_timestamp';
  if (!candidateHasClickId(candidate) && !candidateHasUserData(candidate)) return 'missing_match_keys';
  if (candidate.conversionType === 'completed_job_revenue' && !(number(candidate.conversionValue) > 0)) {
    return 'missing_conversion_value';
  }
  return null;
}

function adIdentifiers(candidate) {
  const ids = {};
  for (const key of ['gclid', 'wbraid', 'gbraid']) {
    if (candidate[key]) ids[key] = String(candidate[key]);
  }
  return Object.keys(ids).length ? ids : null;
}

function buildEvent(candidate) {
  const event = {
    eventName: candidate.eventName || eventNameFor(candidate.conversionType),
    eventTimestamp: candidate.eventTimestamp,
    eventSource: candidate.eventSource || 'WEB',
    transactionId: candidate.transactionId,
    conversionCount: 1,
    currency: candidate.currency || DEFAULT_CURRENCY,
  };
  const value = number(candidate.conversionValue);
  if (value > 0) event.conversionValue = Math.round(value * 100) / 100;
  const ads = adIdentifiers(candidate);
  if (ads) event.adIdentifiers = ads;
  const userData = hashedUserData(candidate);
  if (userData) event.userData = userData;
  return event;
}

function matchKeys(candidate, event = null) {
  const userData = event?.userData || hashedUserData(candidate);
  return {
    gclid: !!candidate.gclid,
    wbraid: !!candidate.wbraid,
    gbraid: !!candidate.gbraid,
    email: !!normalizeEmail(candidate.email),
    phone: !!normalizePhone(candidate.phone),
    userIdentifiers: userData?.userIdentifiers?.length || 0,
  };
}

function redactedEventSummary(candidate, event) {
  return {
    eventName: event.eventName,
    eventTimestamp: event.eventTimestamp,
    eventSource: event.eventSource,
    transactionId: event.transactionId,
    conversionValue: event.conversionValue || null,
    currency: event.currency,
    hasAdIdentifiers: !!event.adIdentifiers,
    matchKeys: matchKeys(candidate, event),
    source: {
      sourceTable: candidate.sourceTable,
      sourceId: candidate.sourceId,
      leadId: candidate.leadId,
      estimateId: candidate.estimateId,
      customerId: candidate.customerId,
      invoiceId: candidate.invoiceId,
      serviceRecordId: candidate.serviceRecordId,
      scheduledServiceId: candidate.scheduledServiceId,
    },
  };
}

function candidateMatchScore(candidate) {
  let score = 0;
  if (candidate.gclid) score += 8;
  if (candidate.wbraid || candidate.gbraid) score += 6;
  if (normalizeEmail(candidate.email)) score += 4;
  if (normalizePhone(candidate.phone)) score += 4;
  if (number(candidate.conversionValue) > 0) score += 2;
  if (candidate.eventTimestamp) score += 1;
  if (candidate.leadId) score += 1;
  return score;
}

function dedupeCandidatesByTransaction(candidates = []) {
  const byTransaction = new Map();
  const order = [];

  for (const candidate of candidates) {
    const transactionId = candidate?.transactionId;
    if (!transactionId) {
      order.push({ candidate });
      continue;
    }

    if (!byTransaction.has(transactionId)) {
      byTransaction.set(transactionId, candidate);
      order.push({ transactionId });
      continue;
    }

    const existing = byTransaction.get(transactionId);
    if (candidateMatchScore(candidate) > candidateMatchScore(existing)) {
      byTransaction.set(transactionId, candidate);
    }
  }

  return order.map((entry) => (
    entry.transactionId ? byTransaction.get(entry.transactionId) : entry.candidate
  ));
}

function mapLeadCandidate(row) {
  const eventTimestamp = toRfc3339(row.converted_at || row.first_contact_at || row.created_at);
  return {
    conversionType: 'qualified_lead',
    sourceTable: 'leads',
    sourceId: row.id,
    leadId: row.id,
    estimateId: row.estimate_id || null,
    customerId: row.customer_id || null,
    eventName: eventNameFor('qualified_lead'),
    eventTimestamp,
    eventSource: 'WEB',
    transactionId: `waves_qualified_lead:${row.id}`,
    conversionValue: conversionValueForQualifiedLead(),
    currency: DEFAULT_CURRENCY,
    gclid: row.gclid || null,
    wbraid: row.wbraid || null,
    gbraid: row.gbraid || null,
    // Meta match keys (ignored by the Google upload; used by meta-data-manager).
    fbclid: row.fbclid || null,
    fbc: row.fbc || null,
    fbp: row.fbp || null,
    email: row.email || null,
    phone: row.phone || null,
    metadata: {
      leadSource: row.source_name || null,
      sourceType: row.source_type || null,
      channel: row.channel || null,
      status: row.status || null,
    },
  };
}

function estimateLeadId(estimateData) {
  const parsed = parseJsonObject(estimateData);
  return parsed.lead_id ? String(parsed.lead_id) : null;
}

function mapCompletedJobCandidate(row) {
  const invoiceTotal = number(row.invoice_total);
  const eventTimestamp = toRfc3339(row.service_date || row.completed_at || row.updated_at || row.created_at);
  const leadEmail = row.lead_email || null;
  const leadPhone = row.lead_phone || null;
  const customerEmail = row.customer_email || null;
  const customerPhone = row.customer_phone || null;
  return {
    conversionType: 'completed_job_revenue',
    sourceTable: 'estimate_actuals',
    sourceId: row.id,
    leadId: row.lead_id || estimateLeadId(row.estimate_data),
    estimateId: row.estimate_id || null,
    customerId: row.customer_id || null,
    invoiceId: row.invoice_id || null,
    serviceRecordId: row.service_record_id || null,
    scheduledServiceId: row.scheduled_service_id || null,
    eventName: eventNameFor('completed_job_revenue'),
    eventTimestamp,
    eventSource: 'WEB',
    transactionId: `waves_completed_job:${row.service_record_id || row.id}`,
    conversionValue: invoiceTotal > 0 ? invoiceTotal : null,
    currency: DEFAULT_CURRENCY,
    gclid: row.gclid || null,
    wbraid: row.wbraid || null,
    gbraid: row.gbraid || null,
    // Meta match keys (from the lead; ignored by the Google upload).
    fbclid: row.fbclid || null,
    fbc: row.fbc || null,
    fbp: row.fbp || null,
    email: leadEmail || customerEmail || null,
    phone: leadPhone || customerPhone || null,
    metadata: {
      invoiceStatus: row.invoice_status || null,
      serviceLine: row.service_line || null,
      valueSource: invoiceTotal > 0 ? 'invoice_total' : 'missing_invoice_total',
    },
  };
}

async function collectQualifiedLeadCandidates({ since, endDate, limit = MAX_LIMIT } = {}) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || MAX_LIMIT, 1), MAX_LIMIT);
  const eventTimestampSql = 'COALESCE(l.converted_at, l.first_contact_at, l.created_at)';
  const rows = await db('leads as l')
    .leftJoin('lead_sources as ls', 'l.lead_source_id', 'ls.id')
    .whereNull('l.deleted_at')
    .whereRaw(`${eventTimestampSql} >= ?::timestamptz`, [since])
    .whereRaw(`${eventTimestampSql} < ?::timestamptz`, [addDateStringDays(endDate, 1)])
    .where((q) => {
      q.where('l.is_qualified', true)
        .orWhereRaw("LOWER(COALESCE(l.status, '')) IN ('qualified', 'booked', 'converted', 'won')");
    })
    .select(
      'l.id',
      'l.estimate_id',
      'l.customer_id',
      'l.first_contact_at',
      'l.converted_at',
      'l.created_at',
      'l.status',
      'l.email',
      'l.phone',
      'l.gclid',
      'l.wbraid',
      'l.gbraid',
      'l.fbclid',
      'l.fbc',
      'l.fbp',
      'ls.name as source_name',
      'ls.source_type',
      'ls.channel',
    )
    .orderByRaw(`${eventTimestampSql} DESC NULLS LAST`)
    .limit(cap);

  return rows.map(mapLeadCandidate);
}

function invoiceRollupSubquery() {
  const invoiceOrder = 'updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC';
  return db('invoices')
    .whereNotIn('status', ['void', 'refunded', 'canceled', 'cancelled'])
    .whereNotNull('service_record_id')
    .select(
      'service_record_id',
      db.raw(`(ARRAY_AGG(id ORDER BY ${invoiceOrder}))[1] as invoice_id`),
      db.raw(`(ARRAY_AGG(status ORDER BY ${invoiceOrder}))[1] as invoice_status`),
      db.raw(`(ARRAY_AGG(total ORDER BY ${invoiceOrder}))[1] as invoice_total`),
    )
    .groupBy('service_record_id')
    .as('inv');
}

async function collectCompletedJobCandidates({ since, endDate, limit = MAX_LIMIT } = {}) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || MAX_LIMIT, 1), MAX_LIMIT);
  const queryLimit = Math.min(cap * 2, MAX_EVENTS_PER_REQUEST);
  const invoiceRollup = invoiceRollupSubquery();

  const rows = await db('estimate_actuals as ea')
    .join('estimates as e', 'e.id', 'ea.estimate_id')
    .leftJoin('service_records as sr', 'sr.id', 'ea.service_record_id')
    .leftJoin(invoiceRollup, 'inv.service_record_id', 'ea.service_record_id')
    .leftJoin('customers as c', 'c.id', 'ea.customer_id')
    .leftJoin('leads as l', function joinLeads() {
      // An operator-removed (soft-deleted) lead's contact/click IDs must not
      // feed offline-conversion uploads; the LEFT join keeps the job row.
      this.on(db.raw('l.deleted_at IS NULL'))
        .andOn(function eitherLink() {
          this.on('l.estimate_id', '=', 'e.id')
            .orOn(db.raw("e.estimate_data->>'lead_id' = l.id::text"));
        });
    })
    .where('ea.service_date', '>=', since)
    .where('ea.service_date', '<', addDateStringDays(endDate, 1))
    .select(
      'ea.id',
      'ea.estimate_id',
      'ea.customer_id',
      'ea.service_record_id',
      'ea.scheduled_service_id',
      'ea.service_line',
      'ea.service_date',
      'ea.created_at',
      'ea.updated_at',
      'e.estimate_data',
      'l.id as lead_id',
      'l.email as lead_email',
      'l.phone as lead_phone',
      'l.gclid',
      'l.wbraid',
      'l.gbraid',
      'l.fbclid',
      'l.fbc',
      'l.fbp',
      'c.email as customer_email',
      'c.phone as customer_phone',
      'inv.invoice_id',
      'inv.invoice_total',
      'inv.invoice_status',
      'sr.updated_at as completed_at',
    )
    .orderBy('ea.service_date', 'desc')
    .limit(queryLimit);

  return dedupeCandidatesByTransaction(rows.map(mapCompletedJobCandidate)).slice(0, cap);
}

async function collectCandidates(conversionType, options = {}) {
  if (conversionType === 'qualified_lead') {
    return dedupeCandidatesByTransaction(await collectQualifiedLeadCandidates(options));
  }
  if (conversionType === 'completed_job_revenue') {
    return dedupeCandidatesByTransaction(await collectCompletedJobCandidates(options));
  }
  throw new Error(`Unsupported conversion type: ${conversionType}`);
}

function priorUploadSkipReason(prior) {
  if (!prior) return null;
  if (prior.status === LIVE_UPLOAD_SENT_STATUS) return 'already_sent';
  if (prior.status === LIVE_UPLOAD_PENDING_STATUS) return 'upload_pending';
  // PARTIAL_SUCCESS returns only aggregate error counts — we can't tell which
  // transactions in the batch failed, so re-uploading would duplicate the ones
  // that succeeded. Treat it as terminal (skip) and surface error_message for
  // manual review rather than blindly retrying the whole batch.
  if (prior.status === 'partial_success') return 'partial_success';
  return null;
}

function summarizeCandidates(candidates, existingByTransaction = new Map()) {
  const counts = {
    total: candidates.length,
    eligible: 0,
    alreadySent: 0,
    pending: 0,
    missingMatchKeys: 0,
    missingConversionValue: 0,
    missingEventTimestamp: 0,
    skipped: 0,
  };
  const rows = candidates.map((candidate) => {
    const reason = skipReason(candidate);
    const existing = existingByTransaction.get(candidate.transactionId);
    const priorReason = priorUploadSkipReason(existing);
    if (priorReason === 'already_sent') counts.alreadySent += 1;
    if (priorReason === 'upload_pending') counts.pending += 1;
    if (reason === 'missing_match_keys') counts.missingMatchKeys += 1;
    if (reason === 'missing_conversion_value') counts.missingConversionValue += 1;
    if (reason === 'missing_event_timestamp') counts.missingEventTimestamp += 1;
    if (!reason && !priorReason) counts.eligible += 1;
    if (reason || priorReason) counts.skipped += 1;
    return {
      transactionId: candidate.transactionId,
      conversionType: candidate.conversionType,
      eventTimestamp: candidate.eventTimestamp,
      conversionValue: candidate.conversionValue,
      skipReason: priorReason || reason,
      matchKeys: matchKeys(candidate),
      source: {
        leadId: candidate.leadId,
        estimateId: candidate.estimateId,
        customerId: candidate.customerId,
        invoiceId: candidate.invoiceId,
        serviceRecordId: candidate.serviceRecordId,
      },
    };
  });
  return { counts, rows };
}

async function existingUploads(conversionType, transactionIds) {
  if (!transactionIds.length) return new Map();
  const rows = await db('google_ads_conversion_uploads')
    .where({ conversion_type: conversionType })
    .whereIn('transaction_id', transactionIds)
    .select('transaction_id', 'status', 'request_id', 'updated_at');
  return new Map(rows.map((row) => [row.transaction_id, row]));
}

async function buildReadiness({ periodDays = 30, limit = MAX_LIMIT } = {}) {
  const range = dateRange(periodDays);
  const warnings = [];
  const conversions = {};

  for (const conversionType of Object.keys(CONVERSIONS)) {
    const config = configurationFor(conversionType);
    try {
      const candidates = await collectCandidates(conversionType, { ...range, limit });
      const existing = await existingUploads(conversionType, candidates.map((c) => c.transactionId));
      const summary = summarizeCandidates(candidates, existing);
      conversions[conversionType] = {
        ...config,
        label: CONVERSIONS[conversionType].label,
        candidates: summary.counts,
        preview: summary.rows.slice(0, 10),
      };
    } catch (err) {
      warnings.push({ source: conversionType, message: err.message });
      conversions[conversionType] = {
        ...config,
        label: CONVERSIONS[conversionType].label,
        candidates: null,
        preview: [],
        error: err.message,
      };
    }
  }

  return {
    period: range,
    endpoint: 'Data Manager API events:ingest',
    validateOnlyDefault: boolEnv('GOOGLE_DATA_MANAGER_VALIDATE_ONLY', true),
    liveUploadsAllowed: boolEnv('GOOGLE_DATA_MANAGER_ALLOW_UPLOADS', false),
    conversions,
    warnings,
  };
}

function buildIngestRequest({ conversionType, candidates, validateOnly }) {
  const destination = destinationFor(conversionType);
  if (!destination) {
    throw new Error(`Data Manager destination is not configured for ${conversionType}`);
  }
  const events = candidates.map(buildEvent);
  return {
    destinations: [destination],
    events,
    validateOnly,
    encoding: 'HEX',
  };
}

async function sendIngestRequest(payload, { fetchImpl = global.fetch, accessToken } = {}) {
  if (!fetchImpl) throw new Error('fetch is not available');
  const token = accessToken || await getAccessToken();
  const response = await fetchImpl(INGEST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || data?.error || `${response.status} ${response.statusText}`;
    const err = new Error(message);
    err.status = response.status;
    err.response = data;
    throw err;
  }
  return data;
}

async function upsertUploadLog(candidate, { status, validateOnly, requestId = null, errorMessage = null, event }) {
  const summary = redactedEventSummary(candidate, event || buildEvent(candidate));
  const row = {
    conversion_type: candidate.conversionType,
    transaction_id: candidate.transactionId,
    event_name: candidate.eventName,
    event_timestamp: candidate.eventTimestamp,
    conversion_value: candidate.conversionValue,
    currency: candidate.currency || DEFAULT_CURRENCY,
    source_table: candidate.sourceTable || CONVERSIONS[candidate.conversionType]?.sourceTable || null,
    source_id: candidate.sourceId || null,
    lead_id: candidate.leadId || null,
    estimate_id: candidate.estimateId || null,
    customer_id: candidate.customerId || null,
    invoice_id: candidate.invoiceId || null,
    service_record_id: candidate.serviceRecordId || null,
    scheduled_service_id: candidate.scheduledServiceId || null,
    status,
    validate_only: !!validateOnly,
    request_id: requestId,
    error_message: errorMessage,
    match_keys: JSON.stringify(summary.matchKeys),
    payload_summary: JSON.stringify(summary),
    sent_at: status === 'sent' || status === 'validated' ? db.fn.now() : null,
    updated_at: db.fn.now(),
  };

  await db('google_ads_conversion_uploads')
    .insert({ ...row, created_at: db.fn.now() })
    .onConflict(['conversion_type', 'transaction_id'])
    .merge(row);
}

function uploadLogStatusForIngest(effectiveValidateOnly) {
  return effectiveValidateOnly ? 'validated' : LIVE_UPLOAD_PENDING_STATUS;
}

function uploadValidateOnly(requestedValidateOnly) {
  const forceValidateOnly = boolEnv('GOOGLE_DATA_MANAGER_VALIDATE_ONLY', true);
  const liveUploadsAllowed = boolEnv('GOOGLE_DATA_MANAGER_ALLOW_UPLOADS', false);
  if (forceValidateOnly || !liveUploadsAllowed) return true;
  return requestedValidateOnly !== false;
}

// Public entry point. Wraps the upload in a Postgres advisory lock keyed by
// conversion type so the daily cron AND the admin /data-manager/upload endpoint
// (and overlapping instances) can't both read the upload log before either
// writes it and send the same transaction IDs twice. Non-blocking: a concurrent
// caller is skipped (the holder's sweep covers the same candidates).
async function uploadConversions(opts = {}) {
  const conversionType = opts.conversionType || 'completed_job_revenue';
  if (!CONVERSIONS[conversionType]) throw new Error(`Unsupported conversion type: ${conversionType}`);
  return runExclusive(`data-manager-upload:${conversionType}`, () => uploadConversionsLocked({ ...opts, conversionType }));
}

async function uploadConversionsLocked({
  conversionType = 'completed_job_revenue',
  periodDays = 30,
  limit = 100,
  validateOnly = true,
  force = false,
  fetchImpl,
  accessToken,
} = {}) {
  if (!CONVERSIONS[conversionType]) throw new Error(`Unsupported conversion type: ${conversionType}`);
  const range = dateRange(periodDays);
  const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), MAX_EVENTS_PER_REQUEST, MAX_LIMIT);
  const effectiveValidateOnly = uploadValidateOnly(validateOnly);
  const config = configurationFor(conversionType);
  const candidates = dedupeCandidatesByTransaction(
    await collectCandidates(conversionType, { ...range, limit: cappedLimit })
  );
  const existing = await existingUploads(conversionType, candidates.map((c) => c.transactionId));
  const skipped = [];
  const uploadable = [];

  for (const candidate of candidates) {
    const reason = skipReason(candidate);
    const prior = existing.get(candidate.transactionId);
    const priorReason = priorUploadSkipReason(prior);
    if (reason) {
      skipped.push({ transactionId: candidate.transactionId, reason });
      continue;
    }
    if (!force && priorReason) {
      skipped.push({ transactionId: candidate.transactionId, reason: priorReason });
      continue;
    }
    uploadable.push(candidate);
  }

  if (!config.configured) {
    return {
      synced: false,
      configured: false,
      conversionType,
      period: range,
      config,
      candidates: candidates.length,
      uploadable: uploadable.length,
      skipped,
      error: `Data Manager is missing required config: ${config.missing.join(', ')}`,
    };
  }

  if (!uploadable.length) {
    return {
      synced: true,
      configured: true,
      conversionType,
      period: range,
      validateOnly: effectiveValidateOnly,
      requestId: null,
      sent: 0,
      candidates: candidates.length,
      skipped,
    };
  }

  const request = buildIngestRequest({ conversionType, candidates: uploadable, validateOnly: effectiveValidateOnly });
  const eventPairs = uploadable.map((candidate, index) => ({ candidate, event: request.events[index] }));

  try {
    const response = await sendIngestRequest(request, { fetchImpl, accessToken });
    const status = uploadLogStatusForIngest(effectiveValidateOnly);
    await Promise.all(eventPairs.map(({ candidate, event }) => (
      upsertUploadLog(candidate, {
        status,
        validateOnly: effectiveValidateOnly,
        requestId: response.requestId || null,
        event,
      })
    )));
    return {
      synced: true,
      configured: true,
      conversionType,
      period: range,
      validateOnly: effectiveValidateOnly,
      forcedValidateOnly: effectiveValidateOnly && validateOnly === false,
      requestId: response.requestId || null,
      sent: effectiveValidateOnly ? uploadable.length : 0,
      accepted: uploadable.length,
      pending: effectiveValidateOnly ? 0 : uploadable.length,
      candidates: candidates.length,
      skipped,
      preview: eventPairs.slice(0, 5).map(({ candidate, event }) => redactedEventSummary(candidate, event)),
    };
  } catch (err) {
    logger.error('[data-manager] upload failed', { conversionType, error: err.message });
    await Promise.all(eventPairs.map(({ candidate, event }) => (
      upsertUploadLog(candidate, {
        status: 'failed',
        validateOnly: effectiveValidateOnly,
        errorMessage: err.message,
        event,
      }).catch((logErr) => logger.warn('[data-manager] failed upload log write failed', { error: logErr.message }))
    )));
    return {
      synced: false,
      configured: true,
      conversionType,
      period: range,
      validateOnly: effectiveValidateOnly,
      sent: 0,
      candidates: candidates.length,
      uploadable: uploadable.length,
      skipped,
      error: err.message,
      response: err.response || null,
    };
  }
}

function dataManagerRequestStatuses(data) {
  return (data?.requestStatusPerDestination || [])
    .map((item) => String(item?.requestStatus || '').toUpperCase())
    .filter(Boolean);
}

function uploadStatusFromRequestStatus(data) {
  const statuses = dataManagerRequestStatuses(data);
  if (!statuses.length) return LIVE_UPLOAD_PENDING_STATUS;
  if (statuses.some((status) => status === 'PROCESSING' || status === 'REQUEST_STATUS_UNKNOWN')) {
    return LIVE_UPLOAD_PENDING_STATUS;
  }
  if (statuses.some((status) => status === 'FAILED')) return 'failed';
  if (statuses.some((status) => status === 'PARTIAL_SUCCESS')) return 'partial_success';
  if (statuses.every((status) => status === 'SUCCESS')) return LIVE_UPLOAD_SENT_STATUS;
  return LIVE_UPLOAD_PENDING_STATUS;
}

function requestStatusMessage(data) {
  const details = (data?.requestStatusPerDestination || []).map((destinationStatus) => ({
    requestStatus: destinationStatus.requestStatus || null,
    errorInfo: destinationStatus.errorInfo || null,
    warningInfo: destinationStatus.warningInfo || null,
  }));
  if (!details.some((detail) => detail.errorInfo || detail.warningInfo)) return null;
  return JSON.stringify(details).slice(0, 4000);
}

async function updateUploadLogsForRequestStatus(requestId, data) {
  const status = uploadStatusFromRequestStatus(data);
  const patch = {
    status,
    error_message: ['failed', 'partial_success'].includes(status) ? requestStatusMessage(data) : null,
    updated_at: db.fn.now(),
  };
  if (status === LIVE_UPLOAD_SENT_STATUS) {
    patch.sent_at = db.fn.now();
  } else if (status === 'failed' || status === 'partial_success') {
    patch.sent_at = null;
  }

  const updated = await db('google_ads_conversion_uploads')
    .where({ request_id: requestId })
    .andWhere('validate_only', false)
    .update(patch);

  return { status, updated };
}

async function retrieveRequestStatus(requestId, { fetchImpl = global.fetch, accessToken } = {}) {
  if (!requestId) throw new Error('requestId is required');
  const token = accessToken || await getAccessToken();
  const url = `${REQUEST_STATUS_URL}?requestId=${encodeURIComponent(requestId)}`;
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || data?.error || `${response.status} ${response.statusText}`;
    const err = new Error(message);
    err.status = response.status;
    err.response = data;
    throw err;
  }
  const uploadStatus = await updateUploadLogsForRequestStatus(requestId, data);
  return { ...data, uploadStatus: uploadStatus.status, uploadsUpdated: uploadStatus.updated };
}

/**
 * Resolve still-pending live upload requests by polling Data Manager request
 * status and updating the upload log. Without this, a request that later fails or
 * partially succeeds stays 'pending' forever (and future scans skip its
 * transactions as upload_pending) — so the automated cron would never retry it.
 * Reconciling flips failed/partial rows out of 'pending', making them retryable
 * on the next upload run, and confirms successes.
 */
async function reconcilePendingRequests({ limit = 100 } = {}) {
  const rows = await db('google_ads_conversion_uploads')
    .where({ status: LIVE_UPLOAD_PENDING_STATUS, validate_only: false })
    .whereNotNull('request_id')
    .distinct('request_id')
    .limit(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500));

  const results = [];
  for (const row of rows) {
    const requestId = row.request_id;
    if (!requestId) continue;
    try {
      const r = await retrieveRequestStatus(requestId);
      results.push({ requestId, status: r.uploadStatus, updated: r.uploadsUpdated });
    } catch (err) {
      logger.warn('[data-manager] reconcile failed', { requestId, error: err.message });
      results.push({ requestId, error: err.message });
    }
  }
  return results;
}

module.exports = {
  buildReadiness,
  uploadConversions,
  retrieveRequestStatus,
  reconcilePendingRequests,
  _private: {
    adIdentifiers,
    buildEvent,
    buildIngestRequest,
    collectCandidates,
    candidateHasClickId,
    candidateHasUserData,
    cleanNumericId,
    configurationFor,
    dedupeCandidatesByTransaction,
    destinationFor,
    hashedUserData,
    mapCompletedJobCandidate,
    mapLeadCandidate,
    matchKeys,
    normalizeEmail,
    normalizePhone,
    redactedEventSummary,
    sha256Hex,
    skipReason,
    summarizeCandidates,
    toRfc3339,
    uploadLogStatusForIngest,
    uploadStatusFromRequestStatus,
    uploadValidateOnly,
  },
};
