'use strict';

/**
 * Focused call-pipeline hygiene guards and operational safety checks (PR A2):
 * - Competitor-caused complaint suppression for `keepComplaintCallAlert`
 * - Active-customer protection against false terminal `spam` classification
 * - Allowlisted `extraction_failed` error classification & 3-in-60m outage alert
 */

const logger = require('./logger');

const COMPETITOR_ENTITY = '(?:terminix|orkin|truly\\s*nolen|massey|aptive|home\\s*team|eco\\s*shield|bulwark|previous\\s+(?:pest\\s+)?company|other\\s+(?:pest\\s+)?company|former\\s+(?:pest\\s+)?company|old\\s+(?:pest\\s+)?company)';
const COMPETITOR_CAUSED_RE = new RegExp(
  `\\b(?:(?:frustrated|unhappy|upset|mad|angry|dissatisfied|disappointed|issues?|problems?|trouble|complaints?)\\s+(?:with|about|against)\\s+${COMPETITOR_ENTITY}`
  + `|${COMPETITOR_ENTITY}\\s+(?:never\\s+showed|missed|skipped|failed|didn'?t|did\\s+not|overcharged|raised|ignored|damaged|ruined|dropped|cancelled|canceled|was\\s+(?:late|rude|terrible|awful|bad)))\\b`,
  'i',
);
const SWITCHING_TO_COMPETITOR_RE = new RegExp(`\\b(?:switch(?:ing)?|mov(?:e|ing)|go(?:ing)?|call(?:ing)?)\\s+(?:to|with)\\s+${COMPETITOR_ENTITY}\\b`, 'i');
const WAVES_FAULT_RE = /\b(?:your\s+(?:tech|technician|office|billing|invoice|charge|service|driver|company|team|crew)|waves\b[^.!?\n]{0,30}\b(?:tech|technician|office|billing|invoice|missed|skipped|failed|never|didn'?t|did\s+not|overcharged|charged|billed|damaged|ruined|late|rude|bad|awful|terrible|wrong|no[- ]?show|problem|issue|complaint|upset|frustrated|unhappy)|billed\s+us|charged\s+us|you\s+guys)\b/i;

const OUTAGE_WINDOW_MS = 60 * 60 * 1000;
const OUTAGE_MIN_FAILURES = 3;
const OUTAGE_DEDUPE_KEY = 'call-extraction-outage:60m';

const ERROR_CATEGORY_RULES = [
  ['rate_limit', (status, code, _name, msg) => status === 429 || /\b(?:429|rate[_ -]?limit)\b/i.test(`${code} ${msg}`)],
  ['quota_exceeded', (_s, code, _n, msg) => /\b(?:insufficient[_ -]?quota|quota[_ -]?exceeded|billing|spending[_ -]?limit|credit)\b/i.test(`${code} ${msg}`)],
  ['auth_error', (status, code, _n, msg) => status === 401 || status === 403 || /\b(?:unauthorized|invalid[_ -]?api[_ -]?key|authentication)\b/i.test(`${code} ${msg}`)],
  ['timeout', (_s, code, name, msg) => /^(?:ETIMEDOUT|ECONNABORTED|ABORT_ERR)$/i.test(code) || /AbortError/i.test(name) || /\btimed?\s*out\b/i.test(msg)],
  ['provider_overloaded', (status, code, _n, msg) => status === 503 || status === 529 || /\boverloaded\b/i.test(`${code} ${msg}`)],
  ['provider_5xx', (status) => status != null && status >= 500],
  ['provider_4xx', (status) => status != null && status >= 400],
  ['network_error', (_s, code, _n, msg) => /^(?:ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|UND_ERR_)/i.test(code) || /\b(?:fetch failed|socket hang up|network)\b/i.test(msg)],
  ['invalid_response', (_s, code, name, msg) => /SyntaxError/i.test(name) || /\b(?:json|empty response|invalid schema|malformed)\b/i.test(`${code} ${msg}`)],
];

function isCompetitorOrNonWavesComplaint(v2Extraction = null) {
  if (!v2Extraction || typeof v2Extraction !== 'object') return false;
  const objections = Array.isArray(v2Extraction?.sentiment_and_lead?.objections_raised)
    ? v2Extraction.sentiment_and_lead.objections_raised
    : [];
  const summary = String(v2Extraction?.meta?.call_summary || '');
  const text = [...objections, summary].filter(Boolean).join('\n');
  if (!text) return false;
  if (SWITCHING_TO_COMPETITOR_RE.test(text) || WAVES_FAULT_RE.test(text)) return false;
  return COMPETITOR_CAUSED_RE.test(text);
}

function isActiveKnownCustomerCall({ knownCaller = null, knownCallerLookupFailed = false, call = null } = {}) {
  if (knownCallerLookupFailed || !knownCaller?.id || knownCaller.isExistingCustomer !== true) return false;
  return Boolean(call?.customer_id && String(call.customer_id) === String(knownCaller.id));
}

function clearSpamForActiveCustomer({ extracted, knownCaller = null, knownCallerLookupFailed = false, call = null } = {}) {
  if (extracted?.is_spam && isActiveKnownCustomerCall({ knownCaller, knownCallerLookupFailed, call })) {
    extracted.is_spam = false;
  }
}

function extractHttpStatus(err) {
  const raw = err?.status ?? err?.statusCode ?? err?.response?.status ?? null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 100 && n <= 599 ? n : null;
}

function classifyErrorCategory(status, code, name, msg) {
  const hit = ERROR_CATEGORY_RULES.find(([, matches]) => matches(status, code, name, msg));
  return hit ? hit[0] : 'unknown_error';
}

function classifyExtractionError(err) {
  const status = extractHttpStatus(err);
  const code = String(err?.code || '').trim();
  const name = String(err?.name || '').trim();
  const msg = String(err?.message || (typeof err === 'string' ? err : '')).trim();
  return { category: classifyErrorCategory(status, code, name, msg), status };
}

function buildSanitizedExtractionErrorPayload(err, now = new Date()) {
  const { category, status } = classifyExtractionError(err);
  return JSON.stringify({ category, status, at: now.toISOString() });
}

async function maybeAlertExtractionOutage({ db: conn, err, now = new Date() } = {}) {
  if (typeof conn !== 'function') return null;
  try {
    const sinceIso = new Date(now.getTime() - OUTAGE_WINDOW_MS).toISOString();
    const countQuery = conn('call_log')
      .whereRaw("(metadata->'last_extraction_error'->>'at') IS NOT NULL")
      .whereRaw("(metadata->'last_extraction_error'->>'at')::timestamptz >= ?", [sinceIso]);
    if (typeof countQuery?.count !== 'function') return null;
    const row = await countQuery.count('* as n').first().catch(() => null);
    const recentFailures = Number(row?.n || 0);
    if (recentFailures < OUTAGE_MIN_FAILURES) return null;

    const { category, status } = classifyExtractionError(err);
    const statusText = status ? `, HTTP ${status}` : '';
    const { raiseAdminAlert } = require('./admin-alert-compose');
    return await raiseAdminAlert('agents', {
      area: 'System',
      action: 'check call extraction failures',
      why: `${recentFailures} calls failed extraction in the last hour.`,
      severity: 'needs-you',
      link: '/admin/agents',
      subject: { type: 'check', id: 'call-extraction-outage-60m' },
      doneWhen: 'extraction_recovers',
      who: 'person',
    }, {
      detail: `${recentFailures} distinct calls failed extraction in the last 60 minutes (latest category: ${category}${statusText}). Check AI provider status and reprocess failed calls.`,
      bell: true,
      dedupeKey: OUTAGE_DEDUPE_KEY,
      dedupeWindowMs: OUTAGE_WINDOW_MS,
      dedupeOpenOnly: true,
      metadata: {
        source: 'call-extraction-outage',
        category,
        status,
        recentFailures,
        lastFailureAt: now.toISOString(),
      },
    });
  } catch (alertErr) {
    logger.warn(`[call-hygiene] outage alert failed: ${alertErr?.code || alertErr?.name || 'error'}`);
    return null;
  }
}

module.exports = {
  isCompetitorOrNonWavesComplaint,
  isActiveKnownCustomerCall,
  clearSpamForActiveCustomer,
  classifyExtractionError,
  buildSanitizedExtractionErrorPayload,
  maybeAlertExtractionOutage,
};
