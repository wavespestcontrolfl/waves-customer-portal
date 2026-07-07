/**
 * Public Lawn Assessment funnel (wavespestcontrol.com lead magnet).
 *
 *   POST /api/public/lawn-assessment/analyze    — prospect uploads photos → teaser
 *   POST /api/public/lawn-assessment/:id/claim  — contact capture → full report + pricing
 *
 * Both on the AGENTS.md public-route allowlist. Trust boundary:
 *  - The FULL report is server-gated. /analyze runs the shared lawn-diagnostic
 *    ladder, persists the result, and returns ONLY a teaser built from the same
 *    egress allowlist as the public report (never the raw contract). The full
 *    report exists only behind the report_token minted at claim time and is
 *    served by the existing /api/public/lawn-diagnostic/:token route.
 *  - /analyze is a paid dual-model vision call, so it carries the full abuse
 *    triad: explicit feature gate (404 when off), honeypot, Turnstile
 *    (enforced with GATE_LEAD_TURNSTILE), 5/hr per-IP limiter, and the
 *    mount-level daily cap in index.js.
 *  - Claim creates the lead and re-checks eligibility inside the transaction
 *    (one lead per assessment, 409 on replay) — same one-shot pattern as the
 *    lawn-diagnostic quote-request.
 */

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const db = require('../models/db');
const logger = require('../services/logger');
const lawnAssessment = require('../services/lawn-assessment');
const {
  buildDiagnosticReportContract,
  classifyReleaseMode,
  applyAutoReleaseRepair,
} = require('../services/lawn-diagnostic-report');
const {
  runFindingsLadder,
  applyWriterSummary,
  deriveOverallScore,
} = require('../services/lawn-diagnostic-analyze');
const { buildPublicLawnReport } = require('./public-lawn-diagnostic');
const { isEnabled } = require('../config/feature-gates');
const { verifyTurnstileToken } = require('../utils/turnstile');
const { isHoneypotTripped, resolveSubmitHost } = require('../utils/lead-abuse');
const { setPublicPrivacyHeaders, sanitizePricingSnapshot } = require('../utils/public-report-egress');
const { storeFunnelPhotos } = require('../utils/funnel-photos');
const { etParts, etDateString } = require('../utils/datetime-et');

const MAX_PHOTOS = 5;
// Client resizes to 1600px JPEG (~≤500KB); 6M base64 chars ≈ 4.5MB decoded is a
// generous ceiling that still blocks megabyte-flood abuse of the vision spend.
const MAX_PHOTO_CHARS = 6_000_000;
const REPORT_TTL_DAYS = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAIM_TOKEN_RE = /^[a-f0-9]{32}$/;

// Paid dual-model vision per analyze — same aggressive posture as the paid
// property lookup (5/hr lets a real prospect retake photos; blocks scripts).
const analyzeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many analysis requests. Please try again in an hour or call (941) 297-5749.' },
  skip: () => process.env.NODE_ENV !== 'production',
});

const claimLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
  skip: () => process.env.NODE_ENV !== 'production',
});

// The whole funnel is dark until Adam flips GATE_LAWN_ASSESSMENT — 404 (not
// 403) so the surface is unobservable while off, matching the payer-statement
// gate contract.
router.use((req, res, next) => {
  if (!isEnabled('lawnAssessmentMagnet')) return res.status(404).json({ error: 'Not found' });
  return next();
});

function cleanString(value, max = 200) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function normalizePhotos(rawPhotos) {
  const photos = Array.isArray(rawPhotos) ? rawPhotos.filter(Boolean) : [];
  return photos.map((photo, index) => ({
    photo_id: `photo-${index + 1}`,
    data: typeof photo.data === 'string' && photo.data ? photo.data : null,
    mimeType: cleanString(photo.mimeType || photo.mime_type, 80) || 'image/jpeg',
    quality: 'limited',
    limitations: [],
  }));
}

// Approximate lawn size band → sqft the pricing engine prices from. The report
// labels the price as size-band-based; the first visit confirms measurement.
const LAWN_SIZE_BANDS = {
  small: 3000,
  medium: 6000,
  large: 10000,
  xlarge: 15000,
};
const DEFAULT_LAWN_SQFT = 4500; // pricing engine reference size

async function buildLawnPricingSnapshot(sizeBand) {
  try {
    // Pricing is DB-authoritative — sync (60s-cached) before reading the engine.
    const { syncConstantsFromDB, priceLawnCare } = require('../services/pricing-engine');
    await syncConstantsFromDB(db);
    const band = LAWN_SIZE_BANDS[sizeBand] ? sizeBand : null;
    const lawnSqFt = band ? LAWN_SIZE_BANDS[band] : DEFAULT_LAWN_SQFT;
    const priced = priceLawnCare({ turfSf: lawnSqFt }, { track: 'st_augustine', tier: 'enhanced' });
    const tiers = (priced.tiers || []).map((tier) => ({
      label: tier.label || `${tier.visits} applications / year`,
      visits: tier.visits,
      monthly: tier.monthly,
      annual: tier.annual,
      per_visit: tier.perApp,
      recommended: tier.recommended === true,
    }));
    if (!tiers.length) return null;
    return {
      service_label: 'Lawn Health Program',
      basis_note: band
        ? `Pricing shown for a ${band.replace('xlarge', 'very large')} lawn (about ${lawnSqFt.toLocaleString()} sq ft of turf). We confirm the exact measurement on your first visit.`
        : 'Pricing shown for a typical Southwest Florida lawn. We confirm the exact measurement on your first visit.',
      sqft_assumed: lawnSqFt,
      size_band: band,
      tiers,
    };
  } catch (err) {
    // Pricing must never block the claim — the report simply omits the block.
    logger.warn(`[public-lawn-assessment] pricing snapshot failed (non-blocking): ${err.message}`);
    return null;
  }
}

/**
 * Teaser: derived FROM the full-report egress allowlist (buildPublicLawnReport)
 * and then reduced — so the pre-capture payload is a strict subset of what the
 * claimed report shows, and can never leak something the full report gates.
 */
function buildTeaser(rowLike) {
  const full = buildPublicLawnReport(rowLike);
  return {
    overall_status: full.overall_status,
    confidence: full.confidence,
    findings_count: Array.isArray(full.findings) ? full.findings.length : 0,
    // One visible finding to prove the analysis is real; the rest stay locked.
    first_finding: full.findings && full.findings.length ? full.findings[0] : null,
    seasonal_context: full.seasonal_context,
  };
}

// POST /api/public/lawn-assessment/analyze
router.post('/analyze', analyzeLimiter, async (req, res, next) => {
  try {
    setPublicPrivacyHeaders(res);
    const body = req.body || {};

    // Honeypot (always on): pretend success, never run the paid pipeline.
    if (isHoneypotTripped(body)) {
      logger.info('[public-lawn-assessment] honeypot tripped — dropping analyze');
      return res.status(200).json({ ok: true });
    }

    // Turnstile — verified here, enforced by the same gate as the lead webhook.
    // Only a FAILED verification blocks (a verified token returns ok:true,
    // enforced:true — same predicate as routes/lead-webhook.js).
    const turnstileToken = body.turnstile_token || body['cf-turnstile-response'];
    const turnstile = await verifyTurnstileToken(turnstileToken, req.ip, resolveSubmitHost(req));
    if (!turnstile.ok && isEnabled('leadTurnstile') && turnstile.enforced) {
      return res.status(403).json({ error: 'Verification failed. Please try again.' });
    }

    const photos = normalizePhotos(body.photos);
    if (!photos.length || !photos.some((photo) => photo.data)) {
      return res.status(400).json({ error: 'At least one lawn photo is required' });
    }
    if (photos.length > MAX_PHOTOS) {
      return res.status(400).json({ error: `At most ${MAX_PHOTOS} photos can be analyzed at once` });
    }
    if (photos.some((photo) => photo.data && photo.data.length > MAX_PHOTO_CHARS)) {
      return res.status(413).json({ error: 'One of the photos is too large — please retake or resize it.' });
    }

    // Prospect free-text goes to the ADMIN view only — never into the model
    // context (prompt-injection surface) and never into customer-facing copy.
    const prospectNote = cleanString(body.note, 500);

    const season = lawnAssessment.getSeason(etParts(new Date()).month);
    const { findings, findingsSource, fallbackReason, provenance } = await runFindingsLadder({
      photos,
      season,
      products: [],
      compliance: {},
    });

    const reportContract = buildDiagnosticReportContract({
      photos: photos.map((photo) => ({ photo_id: photo.photo_id, quality: photo.quality, limitations: photo.limitations })),
      findings,
      products: [],
      compliance: {},
      seasonal_context: '',
    });
    const releaseMode = classifyReleaseMode(reportContract);
    await applyWriterSummary(reportContract, { season, findingsSource, releaseMode, provenance });
    const sanitizedContract = applyAutoReleaseRepair(reportContract, releaseMode);

    const claimToken = crypto.randomBytes(16).toString('hex');
    const [row] = await db('lawn_diagnostics').insert({
      mode: 'prospect',
      status: 'analyzed',
      source: 'public_funnel',
      claim_token: claimToken,
      ai_analysis: JSON.stringify({
        release_mode: releaseMode,
        findings_source: findingsSource,
        fallback_reason: fallbackReason,
        prospect_note: prospectNote,
        provenance: {
          source: 'public_funnel',
          perception_model: provenance.perceptionModel || null,
          challenge_model: provenance.challengeModel || null,
          writer: provenance.writerModel || 'deterministic',
        },
      }),
      report_contract: JSON.stringify(sanitizedContract),
      overall_score: deriveOverallScore(sanitizedContract, null),
      ai_summary: cleanString(sanitizedContract.customer_summary, 2000),
    }).returning(['id', 'overall_score', 'report_contract', 'created_at']);

    // Best-effort photo storage for the admin review view — analysis already
    // ran from memory, so storage failure never fails the request.
    await storeFunnelPhotos({
      table: 'lawn_diagnostic_photos',
      fkColumn: 'diagnostic_id',
      rowId: row.id,
      keyPrefix: 'lawnfunnel',
      photos,
    });

    return res.status(201).json({
      success: true,
      assessmentId: row.id,
      claimToken,
      photoCount: photos.filter((photo) => photo.data).length,
      teaser: buildTeaser(row),
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * Strict claim-body validation. Name plus a usable email or phone; the
 * TCPA/SMS consent disclosure renders above the submit button client-side
 * (same disclosure-based model as the quote wizard).
 */
function validateClaim(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid_body' };
  // Accept both spellings: /analyze returns the bearer as camelCase
  // `claimToken`, so a client replaying the field it received must not 404.
  const claimToken = typeof body.claim_token === 'string' ? body.claim_token
    : (typeof body.claimToken === 'string' ? body.claimToken : '');
  if (!CLAIM_TOKEN_RE.test(claimToken)) return { ok: false, error: 'invalid_claim_token' };

  const firstName = cleanString(body.first_name, 80);
  const lastName = cleanString(body.last_name, 80);
  const name = firstName || cleanString(body.name, 160);
  if (!name) return { ok: false, error: 'name_required' };

  const email = cleanString(body.email) || '';
  const phoneDigits = typeof body.phone === 'string' ? body.phone.replace(/\D/g, '') : '';
  const validEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  const validPhone = phoneDigits.length >= 10;
  if (!validEmail && !validPhone) return { ok: false, error: 'contact_required' };

  const address = body.address && typeof body.address === 'object' && !Array.isArray(body.address) ? body.address : {};
  return {
    ok: true,
    value: {
      claimToken,
      firstName: firstName || name.split(/\s+/)[0],
      lastName: lastName || (firstName ? null : name.split(/\s+/).slice(1).join(' ') || null),
      email: validEmail ? email : null,
      phone: validPhone ? phoneDigits.slice(0, 20) : null,
      address: {
        line1: cleanString(address.line1),
        city: cleanString(address.city),
        state: cleanString(address.state, 20) || 'FL',
        zip: cleanString(address.zip, 12),
      },
      sizeBand: LAWN_SIZE_BANDS[body.lawn_size_band] ? body.lawn_size_band : null,
    },
  };
}

/**
 * Sanitized first-touch attribution passthrough from the marketing-site
 * island (captureAttribution()): persisted on the lead's extracted_data and
 * stamped onto the funnel row's click-id/utm columns so a tagged ad/GBP
 * visitor who converts through the magnet keeps their campaign linkage. The
 * magnet deliberately remains its OWN funnel-by-source channel
 * (lead_source lawn_assessment / pest_identifier, is_paid false) — click ids
 * are evidence, not a channel reassignment. Everything is length-capped and
 * allowlisted; unknown keys are dropped.
 */
function sanitizeAttribution(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const str = (value, max = 200) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
  const utmRaw = raw.utm && typeof raw.utm === 'object' && !Array.isArray(raw.utm) ? raw.utm : {};
  const utm = {
    source: str(utmRaw.source, 100),
    medium: str(utmRaw.medium, 100),
    campaign: str(utmRaw.campaign, 200),
    term: str(utmRaw.term, 200),
    content: str(utmRaw.content, 200),
  };
  const out = {
    referrer: str(raw.referrer, 500),
    landing_url: str(raw.landing_url, 500),
    domain: str(raw.domain, 100),
    utm,
    gclid: str(raw.gclid),
    wbraid: str(raw.wbraid),
    gbraid: str(raw.gbraid),
    fbclid: str(raw.fbclid),
    fbc: str(raw.fbc),
    fbp: str(raw.fbp),
  };
  // fbc counts as signal (it's minted from a Meta ad click); fbp alone does
  // NOT — Meta sets that browser cookie on every visit, so keeping it as a
  // qualifying signal would attach an attribution object to all traffic.
  const hasSignal = out.referrer || out.landing_url || out.gclid || out.wbraid || out.gbraid
    || out.fbclid || out.fbc || Object.values(utm).some(Boolean);
  return hasSignal ? out : null;
}

// POST /api/public/lawn-assessment/:id/claim
router.post('/:id/claim', claimLimiter, async (req, res, next) => {
  try {
    setPublicPrivacyHeaders(res);
    if (!UUID_RE.test(String(req.params.id || ''))) return res.status(404).json({ error: 'Not found' });
    if (isHoneypotTripped(req.body)) {
      logger.info('[public-lawn-assessment] honeypot tripped — dropping claim');
      return res.status(200).json({ ok: true });
    }

    const parsed = validateClaim(req.body);
    if (!parsed.ok) {
      // Token-shaped failures read as 404 so claim tokens can't be probed apart
      // from missing rows; field failures are honest 400s for the real form.
      if (parsed.error === 'invalid_claim_token') return res.status(404).json({ error: 'Not found' });
      return res.status(400).json({ error: parsed.error });
    }
    const claim = parsed.value;

    const row = await db('lawn_diagnostics')
      .where({ id: req.params.id, claim_token: claim.claimToken, source: 'public_funnel', mode: 'prospect' })
      .first();
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.lead_id || row.status === 'sent') {
      return res.status(409).json({ error: 'This assessment has already been unlocked.' });
    }
    if (row.status !== 'analyzed') return res.status(404).json({ error: 'Not found' });

    const pricing = await buildLawnPricingSnapshot(claim.sizeBand);
    const reportToken = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + REPORT_TTL_DAYS * 24 * 60 * 60 * 1000);
    const contactSnapshot = {
      first_name: claim.firstName,
      last_name: claim.lastName,
      email: claim.email,
      phone: claim.phone,
    };
    const addressSnapshot = Object.values(claim.address).some(Boolean) ? claim.address : null;

    const attribution = sanitizeAttribution(req.body.attribution);
    let createdLeadId = null;
    try {
      await db.transaction(async (trx) => {
        const [lead] = await trx('leads').insert({
          first_name: claim.firstName,
          last_name: claim.lastName,
          phone: claim.phone,
          email: claim.email,
          address: claim.address.line1,
          city: claim.address.city,
          zip: claim.address.zip,
          lead_type: 'lawn_diagnostic',
          service_interest: 'lawn care',
          first_contact_channel: 'lawn_assessment_funnel',
          status: 'new',
          extracted_data: JSON.stringify({
            diagnostic_id: row.id,
            source: 'lawn_assessment_funnel',
            lawn_size_band: claim.sizeBand,
            ...(attribution ? { attribution } : {}),
          }),
        }).returning(['id']);

        // One-shot unlock: only the first valid claim on a still-analyzed,
        // unlinked assessment mints the report token and links the lead.
        // Re-asserting status + lead_id inside the txn closes the TOCTOU
        // between the read above and this update (a concurrent claim rolls
        // back its lead insert). 0 rows → 409.
        const updated = await trx('lawn_diagnostics')
          .where({ id: row.id, claim_token: claim.claimToken, status: 'analyzed' })
          .whereNull('lead_id')
          .update({
            status: 'sent',
            lead_id: lead.id,
            contact_snapshot: JSON.stringify(contactSnapshot),
            address_snapshot: addressSnapshot ? JSON.stringify(addressSnapshot) : null,
            report_token: reportToken,
            report_expires_at: expiresAt,
            pricing_snapshot: pricing ? JSON.stringify(pricing) : null,
            claimed_at: trx.fn.now(),
            last_sent_at: trx.fn.now(),
            updated_at: trx.fn.now(),
          });
        if (updated === 0) {
          const err = new Error('already_claimed');
          err.code = 'ALREADY_CLAIMED';
          throw err;
        }
        createdLeadId = lead.id;
      });
    } catch (txErr) {
      if (txErr.code === 'ALREADY_CLAIMED') {
        return res.status(409).json({ error: 'This assessment has already been unlocked.' });
      }
      throw txErr;
    }

    // Funnel-by-source attribution: one ad_service_attribution row per lead
    // puts the magnet in the SAME reporting funnel as every other channel
    // (lead-funnel-bridge then advances the stage as the lead progresses to
    // booked/completed). Organic surface — never paid. Best-effort AFTER the
    // claim commits: an attribution failure must not cost the unlock, and
    // the unique lead_id index + ignore keeps it idempotent.
    if (createdLeadId) {
      try {
        await db('ad_service_attribution').insert({
          lead_id: createdLeadId,
          // Explicit, not inferred: inferSpecificService('lawn care') falls
          // through to quarterly_pest and would misreport the magnet in the
          // service-line ROI views. The magnet's plan IS the recurring lawn
          // health program.
          service_line: 'lawn',
          specific_service: 'lawn_program',
          service_bucket: 'recurring',
          lead_date: etDateString(),
          lead_source: 'lawn_assessment',
          lead_source_detail: 'wavespestcontrol.com/lawn-assessment',
          funnel_stage: 'lead',
          // Click ids/UTMs are stored as first-touch EVIDENCE; the channel
          // stays the magnet itself (is_paid false — see sanitizeAttribution).
          gclid: attribution?.gclid || null,
          wbraid: attribution?.wbraid || null,
          gbraid: attribution?.gbraid || null,
          fbclid: attribution?.fbclid || null,
          fbc: attribution?.fbc || null,
          fbp: attribution?.fbp || null,
          utm_campaign: attribution?.utm?.campaign || null,
          utm_term: attribution?.utm?.term || null,
          is_paid: false,
        }).onConflict('lead_id').ignore();
      } catch (attrErr) {
        logger.error(`[public-lawn-assessment] attribution insert failed: ${attrErr.message}`);
      }
    }

    logger.info(`[public-lawn-assessment] claim captured for assessment ${row.id}`);
    return res.status(201).json({
      success: true,
      token: reportToken,
      reportUrl: `/lawn-report/${reportToken}`,
      expiresAt,
      pricing: sanitizePricingSnapshot(pricing),
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * Cheap plausibility check for the mount-level paid daily limiter (index.js).
 * Only requests that could actually reach a paid vision call count against
 * the shared 40/day budget — malformed floods, empty posts, and honeypot
 * trips are rejected by the routes without a model call and must not burn
 * the budget for a shared/NAT'd IP. (A verified-failed Turnstile still
 * counts: that check is async and can't run in a limiter predicate.)
 * Shape rules mirror the analyze validators in BOTH funnel routes.
 */
function isPlausibleAnalyzeBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  // The exact predicate the routes drop on — a non-string fax_number (e.g.
  // fax_number: 1) trips it too and must not burn the budget either.
  if (isHoneypotTripped(body)) return false;
  const photos = Array.isArray(body.photos) ? body.photos.filter(Boolean) : [];
  if (!photos.length || photos.length > MAX_PHOTOS) return false;
  return photos.some((photo) => photo && typeof photo.data === 'string'
    && photo.data.length > 0 && photo.data.length <= MAX_PHOTO_CHARS);
}

module.exports = router;
module.exports.isPlausibleAnalyzeBody = isPlausibleAnalyzeBody;
// Shared with routes/public-pest-identifier.js (same claim contract).
module.exports.sanitizeAttribution = sanitizeAttribution;
module.exports._test = {
  validateClaim,
  buildTeaser,
  buildLawnPricingSnapshot,
  LAWN_SIZE_BANDS,
  normalizePhotos,
  isPlausibleAnalyzeBody,
  sanitizeAttribution,
};
