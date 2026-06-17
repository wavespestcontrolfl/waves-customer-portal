/**
 * Public, tokenized Lawn Diagnostic report routes (no auth, by design).
 *
 *   GET  /api/public/lawn-diagnostic/:token                 — read-only report
 *   POST /api/public/lawn-diagnostic/:token/quote-request   — request-a-quote CTA
 *
 * Both are on the AGENTS.md public-by-token allowlist. The read route returns a
 * strictly whitelisted, customer-safe payload — never internal scores, raw AI,
 * product names, label constraints, reconciliation/QA internals, or tech notes.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const db = require('../models/db');
const logger = require('../services/logger');
const { scrubCustomerText, safeConditionLabel, safeCustomerSummary, lowerConfidence } = require('../services/lawn-diagnostic-report');
const { etParts } = require('../utils/datetime-et');

const FULL_TOKEN_RE = /^[a-f0-9]{32}$/;

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
});

const quoteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
});

function parseJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function overallStatusLabel(score) {
  if (score == null || score === '') return 'Reviewed';
  const n = Number(score);
  if (!Number.isFinite(n)) return 'Reviewed';
  if (n >= 70) return 'Healthy';
  if (n >= 40) return 'Keep an eye on it';
  return 'Needs attention';
}

const CONFIDENCE_VALUES = new Set(['low', 'moderate', 'high', 'unknown']);
const SEVERITY_VALUES = new Set(['mild', 'moderate', 'severe']);

function clampEnum(value, allowed) {
  const key = String(value || '').toLowerCase();
  return allowed.has(key) ? key : null;
}

// Generate the customer-facing finding note SERVER-SIDE from safe fields. The raw
// finding customer_wording is client/LLM free-text and is never published — only a
// confidence-matched template over the scrubbed condition name reaches a prospect.
function safeFindingNote(name, confidence) {
  if (!name) return null;
  const lower = name.toLowerCase();
  return confidence === 'high'
    ? `We saw ${lower}.`
    : `We saw signs consistent with ${lower}.`;
}

// First name shown on the unauthenticated report. normalizeContact accepts arbitrary
// strings, so a stale/malformed snapshot could stash a street line or "Dana Prospect
// notes" here. Derive a single name token (letters + hyphen/apostrophe) rather than
// trusting the regex scrub — anything else (digits, appended notes, extra words) is
// dropped, not published.
function safePublicFirstName(value) {
  if (typeof value !== 'string') return null;
  const token = value.trim().split(/\s+/)[0] || '';
  const cleaned = token.replace(/[^\p{L}'-]/gu, '').slice(0, 40);
  return cleaned && /\p{L}/u.test(cleaned) ? cleaned : null;
}

// SWFL service-area cities/communities (Manatee / Sarasota / Charlotte). The public
// report greets a prospect with their city, so the field is allowlisted at egress: a
// stored value like "Venice gate code BLUE" is not in the set and is omitted entirely,
// rather than relying on the scrubber to catch an appended note. Cosmetic-only — an
// unrecognized city simply doesn't render.
const PUBLIC_CITY_ALLOWLIST = new Set([
  // Manatee
  'bradenton', 'bradenton beach', 'west bradenton', 'anna maria', 'holmes beach',
  'palmetto', 'ellenton', 'parrish', 'lakewood ranch', 'myakka city', 'cortez',
  'longboat key', 'memphis', 'whitfield', 'bayshore gardens', 'samoset', 'oneco',
  'rubonia', 'terra ceia', 'duette',
  // Sarasota
  'sarasota', 'south sarasota', 'sarasota springs', 'gulf gate estates', 'gulf gate',
  'fruitville', 'bee ridge', 'vamo', 'southgate', 'kensington park', 'the meadows',
  'lake sarasota', 'venice', 'north venice', 'south venice', 'venice gardens',
  'nokomis', 'osprey', 'siesta key', 'laurel', 'englewood', 'north port', 'plantation',
  'warm mineral springs',
  // Charlotte
  'punta gorda', 'port charlotte', 'charlotte harbor', 'rotonda', 'rotonda west',
  'cleveland', 'harbour heights', 'solana', 'grove city', 'placida', 'cape haze',
  'manasota key',
]);

function safePublicCity(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!PUBLIC_CITY_ALLOWLIST.has(normalized)) return null;
  // Title-case the allowlisted value for display (the set is the only source of truth).
  return normalized.replace(/\b\p{L}/gu, (ch) => ch.toUpperCase());
}

// safeConditionLabel (the allowlist that maps any stored finding name → a fixed
// customer-facing condition label) is imported from lawn-diagnostic-report so the
// public egress and the customer-summary builders share ONE source of truth.

// SWFL seasonal note is SERVER-GENERATED from a fixed source keyed on the report's
// creation month — never the client-supplied contract.seasonal_context free text,
// which could carry product names, tech notes, or PII past the scrubber.
const SWFL_SEASONAL_NOTES = {
  winter: 'Winter in Southwest Florida means slower turf growth and cooler, drier weather, so lighter watering and a little patience go a long way right now.',
  spring: 'Spring is green-up season in Southwest Florida — warming soil wakes the lawn up, and weeds and early fungus can move in quickly.',
  summer: 'Summer brings heat, humidity, and afternoon storms to Southwest Florida, so fungus and insect pressure peak and steady monitoring matters most.',
  fall: 'Fall stays warm in Southwest Florida with tapering rain — a good window to help the turf recover before the cooler, drier months.',
};

function swflSeasonForMonth(month) {
  // SWFL bands: winter Dec–Feb, spring Mar–May, summer Jun–Sep, fall Oct–Nov.
  if (month === 12 || month <= 2) return 'winter';
  if (month <= 5) return 'spring';
  if (month <= 9) return 'summer';
  return 'fall';
}

function serverSeasonalNote(createdAt) {
  if (!createdAt) return null;
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return null;
  // ET month — the portal is America/New_York; getMonth() (UTC on Railway) would
  // pick the wrong SWFL season for reports created near a month boundary.
  return SWFL_SEASONAL_NOTES[swflSeasonForMonth(etParts(d).month)] || null;
}

/**
 * Whitelist a stored diagnostic into the customer-facing report payload.
 * Pure + exhaustive allowlist: only the fields named here ever leave the server.
 */
function buildPublicLawnReport(diagnostic = {}) {
  const contract = parseJson(diagnostic.report_contract, {});
  const address = parseJson(diagnostic.address_snapshot, {});
  const contact = parseJson(diagnostic.contact_snapshot, {});
  const diagnosis = contract.diagnosis || {};
  const watering = contract.watering || {};
  const ongoing = watering.ongoing_irrigation || {};
  const expectations = contract.expectations || {};

  // Fixed response shape: only the keys named here ever leave the server, every
  // customer-visible string is scrubbed at egress, and enums are clamped to known
  // values. Even if a stale/buggy client stored unsanitized or extra nested data,
  // no raw AI text, brand/active-ingredient name, or confirmed-pest claim escapes.
  const findings = Array.isArray(diagnosis.findings)
    ? diagnosis.findings.slice(0, 12).map((finding) => {
      // Allowlisted, confidence-gated label — never the raw stored name, and never a
      // named cause for a low/unknown finding.
      const name = safeConditionLabel(finding.name, finding.confidence);
      const confidence = clampEnum(finding.confidence, CONFIDENCE_VALUES);
      return {
        name,
        confidence,
        severity: clampEnum(finding.severity, SEVERITY_VALUES),
        // Server-generated from the allowlisted label — never the raw client wording.
        customer_note: safeFindingNote(name, confidence),
      };
    }).filter((f) => f.name)
    : [];

  const firstName = contact.first_name
    || (typeof contact.name === 'string' ? contact.name.trim().split(/\s+/)[0] : null)
    || null;

  // Gate the hero summary + primary label by the MORE CONSERVATIVE of the top-level
  // diagnosis confidence and the matching primary finding's own confidence. A stale or
  // inconsistent contract (diagnosis.confidence 'high' but the primary finding 'low')
  // must not publish a named pest in the hero just because the top-level value is high.
  const primaryRow = Array.isArray(diagnosis.findings)
    ? diagnosis.findings.find((f) => f && f.name === diagnosis.primary_finding)
    : null;
  const heroConfidence = lowerConfidence(diagnosis.confidence, primaryRow && primaryRow.confidence);

  // Cause-specific expectations are published only when a confidence-gated public
  // finding still names that cause. `findings[].name` is already downgraded to a generic
  // symptom below moderate, so a stale/low stored expectation bucket can't leak
  // disease/insect/weed copy past the naming gate. turf_recovery is generic.
  const gatedNames = findings.map((f) => (f.name || '').toLowerCase()).join(' ');
  const hasWeedCause = /weed/.test(gatedNames);
  const hasFungusCause = /fung/.test(gatedNames);
  const hasInsectCause = /chinch|caterpillar|grub|insect/.test(gatedNames);

  return {
    // Snapshots accept arbitrary strings at capture, so derive/allowlist at egress — a
    // malformed client could stash a street line, note, or gate code in first_name/city.
    first_name: safePublicFirstName(firstName),
    city: safePublicCity(address.city),
    overall_status: overallStatusLabel(diagnostic.overall_score),
    // Confidence-gated (finding-level): a low/unknown report never names a cause here.
    summary: safeCustomerSummary(contract.customer_summary, heroConfidence),
    // Allowlisted, confidence-gated label, never the raw stored primary_finding.
    primary_finding: diagnosis.primary_finding ? safeConditionLabel(diagnosis.primary_finding, heroConfidence) : null,
    // The conservative hero confidence, so the badge can't contradict a downgraded label.
    confidence: clampEnum(heroConfidence, CONFIDENCE_VALUES),
    findings,
    watering: {
      customer_sequence: scrubCustomerText(watering.customer_sequence) || null,
      restriction_summary: scrubCustomerText(ongoing.restriction_summary_customer) || null,
    },
    expectations: {
      weeds: hasWeedCause ? (scrubCustomerText(expectations.weeds) || null) : null,
      fungus: hasFungusCause ? (scrubCustomerText(expectations.fungus) || null) : null,
      insects: hasInsectCause ? (scrubCustomerText(expectations.insects) || null) : null,
      turf_recovery: scrubCustomerText(expectations.turf_recovery) || null,
    },
    // Server-generated from scrubbed finding names — NOT contract.watch_items,
    // which is built from finding.confirmation_step (internal tech/QA text).
    watch_items: [...new Set(findings.map((f) => f.name).filter(Boolean))].slice(0, 6)
      .map((name) => `We'll keep an eye on ${name.toLowerCase()} and how it responds.`),
    // Server-generated from the report's creation month — never client free text.
    seasonal_context: serverSeasonalNote(diagnostic.created_at),
  };
}

/**
 * Strict quote-request body validation BEFORE any coercion. Rejects
 * null/''/false/[] for name and requires a usable email or phone.
 */
function validateQuoteRequest(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid_body' };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return { ok: false, error: 'name_required' };

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const phoneDigits = typeof body.phone === 'string' ? body.phone.replace(/\D/g, '') : '';
  const validEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  const validPhone = phoneDigits.length >= 10;
  if (!validEmail && !validPhone) return { ok: false, error: 'contact_required' };

  return {
    ok: true,
    value: {
      name: name.slice(0, 200),
      email: validEmail ? email.slice(0, 200) : null,
      phone: validPhone ? phoneDigits.slice(0, 20) : null,
      best_time: typeof body.best_time === 'string' ? body.best_time.trim().slice(0, 120) : null,
      message: typeof body.message === 'string' ? body.message.trim().slice(0, 1000) : null,
    },
  };
}

async function loadSentDiagnostic(token) {
  if (!FULL_TOKEN_RE.test(String(token || ''))) return null;
  const row = await db('lawn_diagnostics')
    .where({ report_token: token, status: 'sent' })
    .whereNotNull('report_expires_at')
    .where('report_expires_at', '>', db.fn.now())
    .first();
  if (!row) return null;
  // Fail closed: a missing or past expiry is never public (defense in depth if a
  // row is ever loaded without the DB predicate).
  if (!row.report_expires_at || new Date(row.report_expires_at).getTime() <= Date.now()) return null;
  return row;
}

function setPrivacyHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

// GET /api/public/lawn-diagnostic/:token
router.get('/:token', readLimiter, async (req, res, next) => {
  try {
    setPrivacyHeaders(res);
    const row = await loadSentDiagnostic(req.params.token);
    if (!row) return res.status(404).json({ error: 'Report not found' });
    return res.json({ success: true, report: buildPublicLawnReport(row) });
  } catch (err) {
    return next(err);
  }
});

// POST /api/public/lawn-diagnostic/:token/quote-request
router.post('/:token/quote-request', quoteLimiter, async (req, res, next) => {
  try {
    setPrivacyHeaders(res);
    const row = await loadSentDiagnostic(req.params.token);
    if (!row) return res.status(404).json({ error: 'Report not found' });

    const parsed = validateQuoteRequest(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    const address = parseJson(row.address_snapshot, {});
    const [firstName, ...restName] = parsed.value.name.split(/\s+/);

    try {
      await db.transaction(async (trx) => {
        const [lead] = await trx('leads').insert({
          first_name: firstName || parsed.value.name,
          last_name: restName.join(' ') || null,
          phone: parsed.value.phone,
          email: parsed.value.email,
          address: address.line1 || null,
          city: address.city || null,
          zip: address.zip || null,
          lead_type: 'lawn_diagnostic',
          service_interest: 'lawn care',
          first_contact_channel: 'lawn_diagnostic_report',
          status: 'new',
          extracted_data: JSON.stringify({
            diagnostic_id: row.id,
            source: 'quote_request',
            best_time: parsed.value.best_time,
            message: parsed.value.message,
          }),
        }).returning(['id']);

        // One-shot guard + eligibility re-check inside the txn: only the first
        // quote-request on a still-sent, unexpired report links a lead. Re-asserting
        // status/expiry closes the TOCTOU between loadSentDiagnostic and this update
        // (archive/expiry mid-flight rolls back the lead insert). 0 rows → 409.
        const updated = await trx('lawn_diagnostics')
          .where({ id: row.id, report_token: req.params.token, status: 'sent' })
          .whereNull('lead_id')
          .whereNotNull('report_expires_at')
          .where('report_expires_at', '>', trx.fn.now())
          .update({ lead_id: lead.id, updated_at: trx.fn.now() });
        if (updated === 0) {
          const err = new Error('already_submitted');
          err.code = 'ALREADY_SUBMITTED';
          throw err;
        }
      });
    } catch (txErr) {
      if (txErr.code === 'ALREADY_SUBMITTED') {
        return res.status(409).json({ error: 'A request has already been submitted for this report.' });
      }
      throw txErr;
    }

    logger.info(`[public-lawn-diagnostic] quote-request captured for diagnostic ${row.id}`);
    return res.status(201).json({ success: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
module.exports._test = {
  FULL_TOKEN_RE,
  buildPublicLawnReport,
  validateQuoteRequest,
  overallStatusLabel,
};
