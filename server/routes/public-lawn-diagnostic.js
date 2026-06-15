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
const { scrubCustomerText } = require('../services/lawn-diagnostic-report');

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
  const n = Number(score);
  if (!Number.isFinite(n)) return 'Reviewed';
  if (n >= 70) return 'Healthy';
  if (n >= 40) return 'Keep an eye on it';
  return 'Needs attention';
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

  // Every published free-text field is scrubbed at egress (defense in depth):
  // even if a stale/buggy client stored unsanitized copy, no confirmed-pest claim
  // or brand/active-ingredient name leaves the server.
  const findings = Array.isArray(diagnosis.findings)
    ? diagnosis.findings.map((finding) => ({
      name: finding.name || null,
      confidence: finding.confidence || null,
      severity: finding.severity || null,
      customer_note: scrubCustomerText(finding.customer_wording) || null,
    }))
    : [];

  const firstName = contact.first_name
    || (typeof contact.name === 'string' ? contact.name.trim().split(/\s+/)[0] : null)
    || null;

  return {
    first_name: firstName,
    city: address.city || null,
    overall_status: overallStatusLabel(diagnostic.overall_score),
    summary: scrubCustomerText(contract.customer_summary) || null,
    primary_finding: diagnosis.primary_finding || null,
    confidence: diagnosis.confidence || null,
    findings,
    watering: {
      customer_sequence: watering.customer_sequence || null,
      restriction_summary: ongoing.restriction_summary_customer || null,
    },
    expectations: contract.expectations || {},
    watch_items: (Array.isArray(contract.watch_items) ? contract.watch_items : []).map(scrubCustomerText),
    seasonal_context: scrubCustomerText(contract.seasonal_context || ''),
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
  const row = await db('lawn_diagnostics').where({ report_token: token, status: 'sent' }).first();
  if (!row) return null;
  if (row.report_expires_at && new Date(row.report_expires_at).getTime() < Date.now()) return null;
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

        // One-shot guard: only the first quote-request links a lead; repeats 409.
        const updated = await trx('lawn_diagnostics')
          .where({ id: row.id })
          .whereNull('lead_id')
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
