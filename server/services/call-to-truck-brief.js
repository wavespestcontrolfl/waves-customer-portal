'use strict';

/**
 * Call-to-Truck Brief builder (`scheduled_services.customer_request` + `customer_request_source = 'call'`).
 *
 * Populates a clean, operational, technician-safe brief for 100% of phone-booked visits
 * (not only re-service visits) so technicians see pest/scope and safety/prep notes on
 * the Job Card without ever seeing prices, quotes, billing-party details, access codes,
 * card numbers, emails, phone numbers, or raw call transcripts.
 *
 * Visibility contract (tech-visibility-ruling-2026-11-04 & tech-screen-gaps-all-rec-ruling):
 * - Price-free, quote-free, billing-free, office-internal-free.
 * - Redacts access codes (`redactAccessCodes`) and card numbers (`scrubPans`).
 * - Respects forced-Assessment summary suppression (`isForcedAssessment: true` never reads `call_summary`).
 * - Pure & deterministic: no DB, no LLM, max 400 chars.
 */

const { scrubPans } = require('../utils/pan-scrub');
const { redactAccessCodes } = require('./context-aggregator');

const MAX_BRIEF_CHARS = 400;

const MONEY_OR_BILLING_SENTENCE_RE = /(?:\$\s*\d|\b\d+(?:\.\d{1,2})?\s*(?:dollars?|bucks?)\b|\b(?:price|pricing|quoted?|quote|invoice|invoic(?:ed|ing)|billing|bill[- ]to|payer|payment|autopay|credit\s+card|debit\s+card|card\s+on\s+file|charge[ds]?|fee|cost|discount|coupon|comp(?:ed|limentary)?|free\s+(?:visit|treatment|service)|monthly\s+rate|annual\s+prepay|prepay|refund|balance|past\s+due)\b)/i;
const OFFICE_INTERNAL_SENTENCE_RE = /\b(?:call\s+(?:back|the\s+office)|follow[- ]?up\s+call|send\s+(?:an?\s+)?estimate|email\s+(?:the\s+)?quote|voicemail|callback\s+requested|review\s+card|triage)\b/i;
const CONTACT_PII_RE = /(?:\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}\b)/gi;
const ACCESS_CODE_REDACTED_RE = /\[access code redacted\]/gi;

function sanitizeFragment(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const scrubbed = redactAccessCodes(scrubPans(text))
    .replace(CONTACT_PII_RE, '')
    .replace(ACCESS_CODE_REDACTED_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return scrubbed;
}

function keepOperationalSentences(raw) {
  const cleaned = sanitizeFragment(raw);
  if (!cleaned) return '';
  const kept = [];
  for (const part of cleaned.split(/(?<=[.!?])\s+|[\n;]+/)) {
    const sentence = part.trim().replace(/^[-•*]\s*/, '');
    if (!sentence || sentence.length < 3) continue;
    if (MONEY_OR_BILLING_SENTENCE_RE.test(sentence)) continue;
    if (OFFICE_INTERNAL_SENTENCE_RE.test(sentence)) continue;
    kept.push(sentence);
  }
  return kept.join(' ').trim();
}

function normalizedKey(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function pushUnique(parts, label, value) {
  const clean = keepOperationalSentences(value);
  if (!clean) return;
  const entry = label ? `${label}: ${clean}` : clean;
  const entryKey = normalizedKey(clean);
  if (!entryKey) return;
  if (parts.some((existing) => normalizedKey(existing).includes(entryKey))) return;
  parts.push(entry);
}

const SAFETY_NOTE_FIELDS = Object.freeze([
  ['household_children_or_elderly', 'Household'],
  ['no_spray_areas', 'No-spray areas'],
  ['chemical_sensitivity_note', 'Sensitivity'],
]);

function formatMentionedPests(sr) {
  const list = Array.isArray(sr.pests_mentioned) ? sr.pests_mentioned : [];
  return list.map((p) => String(p || '').replace(/[_-]+/g, ' ').trim()).filter(Boolean).join(', ');
}

function formatRequestedFallback(extracted, isReService) {
  if (isReService) return '';
  const reqLabel = String(extracted.requested_service || '').replace(/[_-]+/g, ' ').trim();
  return reqLabel && !/^(?:other|unknown|general)$/i.test(reqLabel) ? reqLabel : '';
}

function buildCallToTruckBrief(input) {
  const opts = Object(input);
  const extracted = Object(opts.extracted);
  const v2 = Object(opts.v2Extraction);
  const property = Object(v2.property);
  const sr = Object(v2.service_request);
  const sched = Object(v2.scheduling);
  const parts = [];

  // 1. Primary problem / pest concerns
  pushUnique(parts, '', extracted.pain_points);
  pushUnique(parts, 'Pests', formatMentionedPests(sr));

  // 2. Caller-stated structured household safety & no-spray prep notes (V2 schema 1.30.0)
  for (const [key, label] of SAFETY_NOTE_FIELDS) {
    pushUnique(parts, label, property[key] || extracted[key]);
  }

  // 3. Operational summary / scheduling prep (never on forced Assessment, where summary may name an unagreed treatment)
  if (!opts.isForcedAssessment) {
    pushUnique(parts, '', sched.scheduling_notes_raw);
    if (!parts.length) pushUnique(parts, '', extracted.call_summary);
    if (!parts.length) pushUnique(parts, 'Requested', formatRequestedFallback(extracted, opts.isReService));
  }

  const joined = parts.join(' | ').replace(/\s+/g, ' ').trim();
  return joined ? (joined.slice(0, MAX_BRIEF_CHARS).trim() || null) : null;
}

module.exports = {
  buildCallToTruckBrief,
  MAX_BRIEF_CHARS,
  _test: { keepOperationalSentences, sanitizeFragment },
};
