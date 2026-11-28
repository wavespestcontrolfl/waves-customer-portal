'use strict';

/**
 * Focused call-pipeline hygiene guards and operational safety checks (PR A2):
 * - Competitor-caused complaint suppression for `keepComplaintCallAlert`
 * - Active-customer protection against false terminal `spam` classification
 * - Allowlisted `extraction_failed` error classification & 3-in-60m outage alert
 */

const logger = require('./logger');
const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');

const COMPETITOR_ENTITY = '(?:terminix|orkin|truly\\s*nolen|massey|aptive|home\\s*team|eco\\s*shield|bulwark|previous\\s+(?:pest\\s+)?company|other\\s+(?:pest\\s+)?company|former\\s+(?:pest\\s+)?company|old\\s+(?:pest\\s+)?company)';
const COMPETITOR_ENTITY_RE = new RegExp(`\\b${COMPETITOR_ENTITY}\\b`, 'i');
const COMPETITOR_CAUSED_RE = new RegExp(
  `\\b(?:(?:frustrated|unhappy|upset|mad|angry|dissatisfied|disappointed|issues?|problems?|trouble|complaints?)\\s+(?:with|about|against)\\s+${COMPETITOR_ENTITY}`
  + `|${COMPETITOR_ENTITY}\\s+(?:never\\s+showed|missed|skipped|failed|didn'?t|did\\s+not|overcharged|raised|ignored|damaged|ruined|dropped|cancelled|canceled|was\\s+(?:late|rude|terrible|awful|bad)))\\b`,
  'i',
);
const SWITCHING_TO_COMPETITOR_RE = new RegExp(`\\b(?:switch(?:ing)?|mov(?:e|ing)|go(?:ing)?|call(?:ing)?)\\s+(?:to|with)\\s+${COMPETITOR_ENTITY}\\b`, 'i');
const WAVES_PROSPECT_SWITCH_RE = /\b(?:(?:wants?|wanted|wanting|looking|plans?|planning|called|calling|hopes?|hoping)\s+(?:to\s+)?(?:switch(?:ing)?|move|moving|come|coming|try|use|hire|book)\s+(?:over\s+)?(?:to\s+)?waves|wants?\s+waves\s+instead|switch(?:ing)?\s+(?:over\s+)?to\s+waves)\b/gi;
const WAVES_OR_DIRECT_FAULT_RE = /\b(?:waves|your\s+(?:tech|technician|office|billing|invoice|charge|service|driver|company|team|crew)|billed\s+us|charged\s+us|you\s+guys|refund|credit|reimburse|reimbursement)\b/i;
const GENERIC_COMPLAINT_CUE_RE = /\b(?:cancel(?:ed|led|ing|ling|ation)?|missed|skipped|never\s+showed|no[- ]?show|late|overcharged|damaged|ruined|rude|terrible|awful|unhappy|upset|frustrated|angry|complaint|complained|explanation|problem|issue|wrong|failed|ignored)\b/i;

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

function sentenceIsSafeCompetitorOnly(sentence) {
  if (SWITCHING_TO_COMPETITOR_RE.test(sentence)) return false;
  const withoutProspectSwitch = sentence.replace(WAVES_PROSPECT_SWITCH_RE, ' ');
  if (WAVES_OR_DIRECT_FAULT_RE.test(withoutProspectSwitch)) return false;
  if (GENERIC_COMPLAINT_CUE_RE.test(withoutProspectSwitch) && !COMPETITOR_ENTITY_RE.test(withoutProspectSwitch)) {
    return false;
  }
  return true;
}

function isCompetitorOrNonWavesComplaint(v2Extraction = null) {
  if (!v2Extraction || typeof v2Extraction !== 'object') return false;
  const objections = (Array.isArray(v2Extraction?.sentiment_and_lead?.objections_raised)
    ? v2Extraction.sentiment_and_lead.objections_raised
    : []).map((o) => String(o || '').trim()).filter(Boolean);
  const summary = String(v2Extraction?.meta?.call_summary || '').trim();
  const sentences = summary.split(/[.!?\n]+/).map((s) => s.trim()).filter(Boolean);
  const allParts = [...objections, ...sentences];
  if (!allParts.length) return false;
  if (!allParts.every(sentenceIsSafeCompetitorOnly)) return false;
  if (objections.length && !objections.every((o) => COMPETITOR_CAUSED_RE.test(o))) return false;
  return allParts.some((part) => COMPETITOR_CAUSED_RE.test(part));
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
  if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
  const msg = String(err?.message || (typeof err === 'string' ? err : ''));
  const m = msg.match(/\b(?:HTTP|API|status(?:\s+code)?)\s*[:=]?\s*([45]\d{2})\b/i);
  return m ? Number(m[1]) : null;
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
    const countQuery = whereNotSandboxCall(conn('call_log'))
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
