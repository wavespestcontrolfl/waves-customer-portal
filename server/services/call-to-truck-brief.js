'use strict';

/**
 * Call-to-Truck Brief builder (`scheduled_services.customer_request` + `customer_request_source = 'call'`).
 *
 * Populates a clean, operational, technician-safe & customer-report-safe booking reason
 * for 100% of phone-booked visits (not only re-service visits) strictly from structured
 * service/pest fields:
 *   - V2 `service_request.pests_observed` (`pest_type` + optional `location_on_property` on
 *     ANI-verified calls).
 *   - Non-objection `extracted.pain_points` on ANI-verified calls (never V2
 *     `sentiment_and_lead.objections_raised`).
 *   - When final booked service is not Assessment and no pests/description exist: the
 *     server-resolved `catalogServiceName` (never unrestricted extraction text on unverified calls).
 *
 * Privacy & compliance contract (`tech-visibility-ruling-2026-11-04` + report copy rules):
 * - Household medical/sensitivity notes (`chemical_sensitivity_note`, `household_children_or_elderly`,
 *   `no_spray_areas`) stay strictly in technician-only `property_preferences` via
 *   `call-profile-enrichment.js` — NEVER written to `customer_request`, which feeds forwardable
 *   customer service reports (`bookedReasonBlock`).
 * - Enforces `GATE_CALL_ENRICH_CODES_REQUIRE_ANI`: unverified callers emit ONLY structured
 *   pest types and the resolved catalog service name (zero free text).
 * - Strips money/billing/office phrases, emails, phone numbers (including `(941) 555-0199`),
 *   access codes (`redactAccessCodes`), and PAN card numbers (`scrubPans`).
 * - Screens every emitted fragment and the final brief through `customerCopyViolations`.
 */

const { scrubPans } = require('../utils/pan-scrub');
const { redactAccessCodes } = require('./context-aggregator');
const { customerCopyViolations } = require('./service-report/technician-report-copy');
const { callEnrichCodesRequireAniLive } = require('../config/feature-gates');

const MAX_BRIEF_CHARS = 400;
const JOIN_SEP = ' | ';

const MONEY_OR_BILLING_SENTENCE_RE = /(?:\$\s*\d|\b\d+(?:\.\d{1,2})?\s*(?:dollars?|bucks?|per\s+(?:visit|month|quarter|year)|a\s+(?:month|quarter|year))\b|\b(?:price|pricing|quoted?|quote|invoice|invoic(?:ed|ing)|billing|bill[- ]to|billed\s+to|payer|payment|will\s+pay|pays?\s+\$?\d|landlord|autopay|credit\s+card|debit\s+card|card\s+on\s+file|card\s+ending|charge[ds]?|fee|cost|discount|coupon|comp(?:ed|limentary)?|free\s+(?:visit|treatment|service)|monthly\s+rate|annual\s+prepay|prepay|refund|balance|past\s+due|too\s+expensive|expensive)\b)/i;
const OFFICE_INTERNAL_SENTENCE_RE = /\b(?:call\s+(?:back|the\s+office)|follow[- ]?up\s+call|send\s+(?:an?\s+)?estimate|email\s+(?:the\s+)?quote|voicemail|callback\s+requested|review\s+card|triage)\b/i;
const EMAIL_PII_RE = /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i;
const PHONE_PII_RE = /(?<!\d)(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)/;
const ACCESS_CODE_SENTENCE_RE = /\b(?:gate|garage|lockbox|door|pin|entry|access)\s*(?:code|#)|\[(?:access\s+code\s+)?redacted\]/i;

const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);

function callerAniMatchesPrimaryPhone(callerAni, customerPrimaryPhone) {
  const ani = last10(callerAni);
  return ani.length === 10 && ani === last10(customerPrimaryPhone);
}

function hasSensitivePiiOrCode(sentence) {
  if (EMAIL_PII_RE.test(sentence) || PHONE_PII_RE.test(sentence) || ACCESS_CODE_SENTENCE_RE.test(sentence)) {
    return true;
  }
  return scrubPans(sentence) !== sentence || redactAccessCodes(sentence) !== sentence;
}

function isReportAndTechSafe(text) {
  if (!text || text.length < 3) return false;
  if (hasSensitivePiiOrCode(text)) return false;
  if (MONEY_OR_BILLING_SENTENCE_RE.test(text) || OFFICE_INTERNAL_SENTENCE_RE.test(text)) return false;
  return customerCopyViolations(text).length === 0;
}

function keepOperationalSentences(raw) {
  const normalized = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const kept = [];
  for (const part of normalized.split(/(?<=[.!?])\s+|[\n;]+/)) {
    const sentence = part.trim().replace(/^[-•*]\s*/, '');
    if (isReportAndTechSafe(sentence)) kept.push(sentence);
  }
  return kept.join(' ').trim();
}

function normalizedKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function pushEntry(list, label, rawValue) {
  const clean = keepOperationalSentences(rawValue);
  if (!clean) return;
  const entryKey = normalizedKey(clean);
  if (!entryKey) return;
  const duplicate = list.some((item) => item.label === label && item.key.includes(entryKey));
  if (duplicate) return;
  const text = label ? `${label}: ${clean}` : clean;
  if (customerCopyViolations(text).length > 0) return;
  list.push({ label, key: entryKey, text });
}

function formatObservedPest(entry, { includeLocation = true } = {}) {
  if (typeof entry === 'string') return entry.replace(/_+/g, ' ').trim();
  const pest = String(entry?.pest_type || '').replace(/_+/g, ' ').trim();
  if (!pest || /^unspecified$/i.test(pest)) return '';
  if (!includeLocation) return pest;
  const rawLoc = entry?.location_on_property ?? entry?.location ?? '';
  const loc = String(rawLoc).replace(/_+/g, ' ').trim();
  return loc && !/^unspecified$/i.test(loc) ? `${pest} (${loc})` : pest;
}

function formatObservedPests(sr, opts = {}) {
  const list = Array.isArray(sr.pests_observed) ? sr.pests_observed : [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const label = formatObservedPest(entry, opts);
    const key = normalizedKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out.join(', ');
}

// flatView() copies V2 sentiment_and_lead.objections_raised into pain_points;
// keep sales objections out of technician briefs while preserving V1 pest pain_points.
function nonObjectionPainPoints(extracted, v2) {
  const raw = String(extracted.pain_points || '').trim();
  if (!raw) return '';
  const v2Objections = Array.isArray(v2?.sentiment_and_lead?.objections_raised)
    ? v2.sentiment_and_lead.objections_raised.map(normalizedKey).filter(Boolean)
    : [];
  if (!v2Objections.length) return raw;
  const objectionSet = new Set(v2Objections);
  return raw
    .split(/[;\n]+/)
    .map((part) => part.trim())
    .filter((part) => part && !objectionSet.has(normalizedKey(part)))
    .join('; ');
}

function formatRequestedFallback(extracted, sr, { isReService = false, allowFreeText = true, catalogServiceName = null } = {}) {
  if (isReService) return '';
  // On ANI-unverified calls, use ONLY the server-resolved catalog row name (never extraction free text).
  const raw = allowFreeText
    ? (catalogServiceName || sr.specific_service_name || extracted.specific_service_name || extracted.requested_service || '')
    : (catalogServiceName || '');
  const label = String(raw).replace(/_+/g, ' ').trim();
  return label && !/^(?:other|unknown|general|unspecified)$/i.test(label) ? label : '';
}

function truncateBrief(text, maxChars) {
  const s = String(text || '').trim();
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const boundary = cut.lastIndexOf(' ');
  const trimmed = (boundary > maxChars * 0.6 ? cut.slice(0, boundary) : cut).replace(/[\s|,;:-]+$/, '').trim();
  return trimmed;
}

function buildCallToTruckBrief(input) {
  const opts = Object(input);
  const extracted = Object(opts.extracted);
  const v2 = Object(opts.v2Extraction);
  const sr = Object(v2.service_request);
  const allowFreeText = opts.allowSafetyNotes !== false;

  const entries = [];
  pushEntry(entries, 'Pests', formatObservedPests(sr, { includeLocation: allowFreeText }));
  if (allowFreeText) {
    pushEntry(entries, '', nonObjectionPainPoints(extracted, v2));
  }
  if (!opts.isAssessmentBooking && !entries.length) {
    pushEntry(entries, 'Requested', formatRequestedFallback(extracted, sr, {
      isReService: opts.isReService,
      allowFreeText,
      catalogServiceName: opts.catalogServiceName || null,
    }));
  }

  const finalText = truncateBrief(entries.map((e) => e.text).join(JOIN_SEP), MAX_BRIEF_CHARS);
  if (!finalText) return null;
  return customerCopyViolations(finalText).length === 0 ? finalText : null;
}

// Transaction-safe wrapper that applies GATE_CALL_ENRICH_CODES_REQUIRE_ANI before
// copying free-text booking descriptions onto scheduled_services.customer_request.
// Never throws (fails closed to structured pest types / catalog name on DB error).
async function resolveCallToTruckBriefForBooking(conn, input) {
  const opts = Object(input);
  let allowFreeText = true;
  if (callEnrichCodesRequireAniLive()) {
    allowFreeText = false;
    try {
      if (opts.customerId && typeof conn === 'function') {
        const cust = await conn('customers').where({ id: opts.customerId }).first('phone');
        allowFreeText = callerAniMatchesPrimaryPhone(opts.callerAni, cust?.phone);
      }
    } catch {
      allowFreeText = false;
    }
  }
  return buildCallToTruckBrief({ ...opts, allowSafetyNotes: allowFreeText });
}

module.exports = {
  buildCallToTruckBrief,
  resolveCallToTruckBriefForBooking,
  callerAniMatchesPrimaryPhone,
  MAX_BRIEF_CHARS,
  _test: { keepOperationalSentences, hasSensitivePiiOrCode, formatObservedPests },
};
