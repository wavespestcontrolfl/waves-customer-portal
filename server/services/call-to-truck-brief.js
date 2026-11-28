'use strict';

/**
 * Call-to-Truck Brief builder (`scheduled_services.customer_request` + `customer_request_source = 'call'`).
 *
 * Populates a clean, operational, technician-safe & report-safe brief for 100% of
 * phone-booked visits (not only re-service visits) strictly from structured call fields:
 *   - Caller-stated treatment restrictions & safety notes (V2 schema 1.30.0:
 *     `no_spray_areas`, `chemical_sensitivity_note`, `household_children_or_elderly`)
 *     gated by `GATE_CALL_ENRICH_CODES_REQUIRE_ANI` (caller ANI must match the
 *     customer's primary phone when enabled — Codex security #7529), with fair-share
 *     budgeting so all populated safety restrictions appear before scope text.
 *   - V2 `service_request.pests_observed` (`pest_type` + optional `location_on_property`),
 *     non-objection `extracted.pain_points` (never V2 `sentiment_and_lead.objections_raised`),
 *     and (when final booked service is not Assessment) structured service label.
 *
 * Visibility & compliance contract (`tech-visibility-ruling-2026-11-04` + report copy rules):
 * - NEVER reads unrestricted `call_summary` or `scheduling_notes_raw`.
 * - Strips money/billing/office phrases, emails, phone numbers (including `(941) 555-0199`),
 *   access codes (`redactAccessCodes`), and PAN card numbers (`scrubPans`).
 * - Screens every emitted fragment through `customerCopyViolations`.
 */

const { scrubPans } = require('../utils/pan-scrub');
const { redactAccessCodes } = require('./context-aggregator');
const { customerCopyViolations } = require('./service-report/technician-report-copy');
const { callEnrichCodesRequireAniLive } = require('../config/feature-gates');

const MAX_BRIEF_CHARS = 400;
const JOIN_SEP = ' | ';

const MONEY_OR_BILLING_SENTENCE_RE = /(?:\$\s*\d|\b\d+(?:\.\d{1,2})?\s*(?:dollars?|bucks?|per\s+(?:visit|month|quarter|year)|a\s+(?:month|quarter|year))\b|\b(?:price|pricing|quoted?|quote|invoice|invoic(?:ed|ing)|billing|bill[- ]to|billed\s+to|payer|payment|will\s+pay|pays?\s+\$?\d|landlord|autopay|credit\s+card|debit\s+card|card\s+on\s+file|card\s+ending|charge[ds]?|fee|cost|discount|coupon|comp(?:ed|limentary)?|free\s+(?:visit|treatment|service)|monthly\s+rate|annual\s+prepay|prepay|refund|balance|past\s+due|too\s+expensive|expensive)\b)/i;
const OFFICE_INTERNAL_SENTENCE_RE = /\b(?:call\s+(?:back|the\s+office)|follow[- ]?up\s+call|send\s+(?:an?\s+)?estimate|email\s+(?:the\s+)?quote|voicemail|callback\s+requested|review\s+card|triage)\b/i;
const EMAIL_PII_RE = /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi;
const PHONE_PII_RE = /(?<!\d)(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)/g;
const ACCESS_CODE_REDACTED_RE = /\[access code redacted\]/gi;

const SAFETY_NOTE_FIELDS = Object.freeze([
  ['no_spray_areas', 'No-spray areas'],
  ['chemical_sensitivity_note', 'Sensitivity'],
  ['household_children_or_elderly', 'Household'],
]);

const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);

function callerAniMatchesPrimaryPhone(callerAni, customerPrimaryPhone) {
  const ani = last10(callerAni);
  return ani.length === 10 && ani === last10(customerPrimaryPhone);
}

function sanitizeFragment(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return redactAccessCodes(scrubPans(text))
    .replace(EMAIL_PII_RE, '')
    .replace(PHONE_PII_RE, '')
    .replace(ACCESS_CODE_REDACTED_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isReportAndTechSafe(text) {
  if (!text || text.length < 3) return false;
  if (MONEY_OR_BILLING_SENTENCE_RE.test(text) || OFFICE_INTERNAL_SENTENCE_RE.test(text)) return false;
  return customerCopyViolations(text).length === 0;
}

function keepOperationalSentences(raw) {
  const cleaned = sanitizeFragment(raw);
  if (!cleaned) return '';
  const kept = [];
  for (const part of cleaned.split(/(?<=[.!?])\s+|[\n;]+/)) {
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
  // Deduplicate labeled safety notes ONLY against entries with the same label so
  // e.g. "No-spray areas: koi pond" is never dropped when pain_points mentions "koi pond".
  const duplicate = list.some((item) => item.label === label && item.key.includes(entryKey));
  if (duplicate) return;
  const text = label ? `${label}: ${clean}` : clean;
  if (customerCopyViolations(text).length > 0) return;
  list.push({ label, key: entryKey, text });
}

function formatObservedPest(entry, { includeLocation = true } = {}) {
  if (typeof entry === 'string') return entry.replace(/[_-]+/g, ' ').trim();
  const pest = String(entry?.pest_type || '').replace(/[_-]+/g, ' ').trim();
  if (!pest || /^unspecified$/i.test(pest)) return '';
  if (!includeLocation) return pest;
  const rawLoc = entry?.location_on_property ?? entry?.location ?? '';
  const loc = String(rawLoc).replace(/[_-]+/g, ' ').trim();
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

const TRUNC_SUFFIX = '… (confirm)';

function fitSafetyEntries(entries) {
  if (!entries.length) return '';
  const raw = entries.map((e) => e.text).join(JOIN_SEP);
  if (raw.length <= MAX_BRIEF_CHARS) return raw;
  // Water-fill budget: shorter restrictions keep their full text, unused space flows to longer ones.
  const sepBudget = (entries.length - 1) * JOIN_SEP.length;
  let remainingBudget = MAX_BRIEF_CHARS - sepBudget;
  const indexed = entries.map((e, i) => ({ i, text: e.text }));
  const sorted = [...indexed].sort((a, b) => a.text.length - b.text.length);
  const fitted = new Array(entries.length);
  for (let idx = 0; idx < sorted.length; idx += 1) {
    const left = sorted.length - idx;
    const share = Math.max(20, Math.floor(remainingBudget / left));
    const { i, text } = sorted[idx];
    const kept = text.length <= share
      ? text
      : `${text.slice(0, Math.max(10, share - TRUNC_SUFFIX.length)).trim()}${TRUNC_SUFFIX}`;
    fitted[i] = kept;
    remainingBudget -= kept.length;
  }
  return fitted.filter(Boolean).join(JOIN_SEP).slice(0, MAX_BRIEF_CHARS).trim();
}

function assembleWithPriority(safetyEntries, scopeEntries) {
  const safetyText = fitSafetyEntries(safetyEntries);
  const scopeText = scopeEntries.map((e) => e.text).join(JOIN_SEP);
  if (!safetyText && !scopeText) return null;
  let finalText;
  if (!safetyText) finalText = scopeText.slice(0, MAX_BRIEF_CHARS).trim();
  else if (!scopeText) finalText = safetyText;
  else {
    const remaining = MAX_BRIEF_CHARS - safetyText.length - JOIN_SEP.length;
    const scopeFit = remaining >= 10 ? scopeText.slice(0, remaining).trim() : '';
    finalText = scopeFit ? `${safetyText}${JOIN_SEP}${scopeFit}` : safetyText;
  }
  if (!finalText) return null;
  // Screen final assembled & truncated brief through customerCopyViolations.
  return customerCopyViolations(finalText).length === 0 ? finalText : null;
}

function buildCallToTruckBrief(input) {
  const opts = Object(input);
  const extracted = Object(opts.extracted);
  const v2 = Object(opts.v2Extraction);
  const property = Object(v2.property);
  const sr = Object(v2.service_request);
  const allowFreeText = opts.allowSafetyNotes !== false;

  const safetyEntries = [];
  if (allowFreeText) {
    for (const [key, label] of SAFETY_NOTE_FIELDS) {
      pushEntry(safetyEntries, label, property[key] || extracted[key]);
    }
  }

  const scopeEntries = [];
  // On ANI-unverified calls (GATE_CALL_ENRICH_CODES_REQUIRE_ANI), allow ONLY structured
  // pest types and service names — never free-text pain_points or free-text locations.
  pushEntry(scopeEntries, 'Pests', formatObservedPests(sr, { includeLocation: allowFreeText }));
  if (allowFreeText) {
    pushEntry(scopeEntries, '', nonObjectionPainPoints(extracted, v2));
  }

  if (!opts.isAssessmentBooking && !scopeEntries.length) {
    pushEntry(scopeEntries, 'Requested', formatRequestedFallback(extracted, sr, {
      isReService: opts.isReService,
      allowFreeText,
      catalogServiceName: opts.catalogServiceName || null,
    }));
  }

  return assembleWithPriority(safetyEntries, scopeEntries);
}

// Transaction-safe wrapper that applies GATE_CALL_ENRICH_CODES_REQUIRE_ANI before
// copying caller-stated safety notes onto scheduled_services.customer_request.
// Never throws (fails closed by withholding safety notes if primary phone cannot be verified).
async function resolveCallToTruckBriefForBooking(conn, input) {
  const opts = Object(input);
  let allowSafetyNotes = true;
  if (callEnrichCodesRequireAniLive()) {
    allowSafetyNotes = false;
    try {
      if (opts.customerId && typeof conn === 'function') {
        const cust = await conn('customers').where({ id: opts.customerId }).first('phone');
        allowSafetyNotes = callerAniMatchesPrimaryPhone(opts.callerAni, cust?.phone);
      }
    } catch {
      allowSafetyNotes = false;
    }
  }
  return buildCallToTruckBrief({ ...opts, allowSafetyNotes });
}

module.exports = {
  buildCallToTruckBrief,
  resolveCallToTruckBriefForBooking,
  callerAniMatchesPrimaryPhone,
  MAX_BRIEF_CHARS,
  _test: { keepOperationalSentences, sanitizeFragment, formatObservedPests, fitSafetyEntries },
};
