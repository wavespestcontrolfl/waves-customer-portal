/**
 * Public Pest Identifier funnel (wavespestcontrol.com lead magnet).
 *
 *   POST /api/public/pest-identifier/analyze    — prospect uploads photos → teaser
 *   POST /api/public/pest-identifier/:id/claim  — contact capture → full report + pricing
 *   GET  /api/public/pest-identifier/:token     — tokenized full report (post-claim)
 *
 * All on the AGENTS.md public-route allowlist. Mirrors the lawn-assessment
 * funnel exactly (same gate-404 contract, honeypot, Turnstile enforcement,
 * per-IP + daily paid caps, one-shot claim transaction, server-gated full
 * report). Customer-visible copy comes ONLY from the fixed PEST_LIBRARY
 * allowlist in services/pest-identification.js — never model output — and
 * termite/rodent/bed-bug style identifications always route to a free
 * inspection rather than reading as a confirmed finding.
 */

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const db = require('../models/db');
const logger = require('../services/logger');
const {
  identifyPest,
  buildPestReportContract,
  buildPublicPestReport,
  buildPestTeaser,
} = require('../services/pest-identification');
const { isEnabled } = require('../config/feature-gates');
const { verifyTurnstileToken } = require('../utils/turnstile');
const { isHoneypotTripped, resolveSubmitHost } = require('../utils/lead-abuse');
const { setPublicPrivacyHeaders, sanitizePricingSnapshot } = require('../utils/public-report-egress');
const { storeFunnelPhotos } = require('../utils/funnel-photos');
const { sanitizeAttribution } = require('./public-lawn-assessment');
const { etDateString } = require('../utils/datetime-et');
const { inferServiceLine, inferSpecificService, inferServiceBucket } = require('../utils/service-line-infer');

const MAX_PHOTOS = 5;
const MAX_PHOTO_CHARS = 6_000_000;
const REPORT_TTL_DAYS = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[a-f0-9]{32}$/;

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

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
  skip: () => process.env.NODE_ENV !== 'production',
});

// Dark until Adam flips GATE_PEST_IDENTIFIER — 404 so the FUNNEL surface
// (analyze + claim) is unobservable while off (payer-statement gate
// contract). The tokenized report READ below deliberately stays outside the
// gate: sent reports are owner-initiated communications (admin "Send report"
// on admin-created assessments works pre-launch), and an ungated invalid
// token reads 404 exactly like the dark surface, so nothing becomes
// observable. index.js's pre-limiter dark guard mirrors this same carve-out.
const requirePestGate = (req, res, next) => {
  if (!isEnabled('pestIdentifier')) return res.status(404).json({ error: 'Not found' });
  return next();
};

function cleanString(value, max = 200) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function normalizePhotos(rawPhotos) {
  const photos = Array.isArray(rawPhotos) ? rawPhotos.filter(Boolean) : [];
  return photos.map((photo) => ({
    data: typeof photo.data === 'string' && photo.data ? photo.data : null,
    mimeType: cleanString(photo.mimeType || photo.mime_type, 80) || 'image/jpeg',
  }));
}

// Priceable service keys → engine input + display label. Everything else
// (termite, rodent, bed bug, german roach, tree & shrub, bees) is
// inspection-first: the report shows the recommendation without a number.
const PRICEABLE_SERVICES = {
  pest: {
    label: 'General Pest Control',
    engineServices: { pest: { frequency: 'quarterly' } },
    tierLabel: 'Quarterly Pest Control',
  },
  mosquito: {
    label: 'Mosquito Control',
    engineServices: { mosquito: { tier: 'monthly12' } },
    tierLabel: 'Monthly Mosquito Program',
  },
  flea: {
    label: 'Flea & Tick Treatment',
    engineServices: { flea: {} },
    tierLabel: 'Flea & Tick Treatment',
  },
  lawnPestControl: {
    label: 'Lawn Pest Control',
    engineServices: { lawnPestControl: {} },
    tierLabel: 'Lawn Pest Control',
  },
};

async function buildPestPricingSnapshot(serviceKey) {
  const config = PRICEABLE_SERVICES[serviceKey];
  if (!config) return null;
  try {
    // Pricing is DB-authoritative — sync (60s-cached) before reading the engine.
    const { syncConstantsFromDB, generateEstimate } = require('../services/pricing-engine');
    await syncConstantsFromDB(db);
    // Typical-home basis: the funnel has no property lookup, so price the
    // reference profile and label it honestly; the quote step re-prices exactly.
    const estimate = generateEstimate({ homeSqFt: 2000, lotSqFt: 8000, services: config.engineServices });
    const line = (estimate.lineItems || [])[0];
    if (!line) return null;
    const monthly = Number.isFinite(Number(line.monthly)) ? Number(line.monthly) : null;
    const annual = Number.isFinite(Number(line.annual)) ? Number(line.annual) : null;
    if (monthly == null && annual == null) return null;
    return {
      service_label: config.label,
      basis_note: 'Pricing shown for a typical Southwest Florida home. Your exact quote takes about a minute and reflects your actual property.',
      tiers: [{
        label: config.tierLabel,
        visits: Number.isFinite(Number(line.visitsPerYear)) ? Number(line.visitsPerYear) : null,
        monthly,
        annual,
        per_visit: Number.isFinite(Number(line.perApp)) ? Number(line.perApp) : null,
        recommended: true,
      }],
    };
  } catch (err) {
    // Pricing must never block the claim — the report simply omits the block.
    logger.warn(`[public-pest-identifier] pricing snapshot failed (non-blocking): ${err.message}`);
    return null;
  }
}

// POST /api/public/pest-identifier/analyze
router.post('/analyze', requirePestGate, analyzeLimiter, async (req, res, next) => {
  try {
    setPublicPrivacyHeaders(res);
    const body = req.body || {};

    if (isHoneypotTripped(body)) {
      logger.info('[public-pest-identifier] honeypot tripped — dropping analyze');
      return res.status(200).json({ ok: true });
    }

    // Only a FAILED verification blocks — a verified token returns ok:true,
    // enforced:true (same predicate as routes/lead-webhook.js).
    const turnstileToken = body.turnstile_token || body['cf-turnstile-response'];
    const turnstile = await verifyTurnstileToken(turnstileToken, req.ip, resolveSubmitHost(req));
    if (!turnstile.ok && isEnabled('leadTurnstile') && turnstile.enforced) {
      return res.status(403).json({ error: 'Verification failed. Please try again.' });
    }

    const photos = normalizePhotos(body.photos);
    if (!photos.length || !photos.some((photo) => photo.data)) {
      return res.status(400).json({ error: 'At least one photo is required' });
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

    const result = await identifyPest(photos);
    if (!result.ok) {
      // Vision fully unavailable — honest degrade, no row, no charge to the
      // prospect's patience: the funnel UI offers the call/quote path instead.
      return res.status(503).json({ error: 'Photo analysis is briefly unavailable. Please try again in a few minutes or call (941) 297-5749.' });
    }

    const contract = buildPestReportContract(result);
    const claimToken = crypto.randomBytes(16).toString('hex');
    const [row] = await db('pest_identifications').insert({
      mode: 'prospect',
      status: 'analyzed',
      source: 'public_funnel',
      claim_token: claimToken,
      ai_analysis: JSON.stringify({
        prospect_note: prospectNote,
        per_photo: result.perPhoto.map((photo) => ({
          slug: photo.entry ? photo.entry.slug : null,
          confidence: photo.confidence,
          category: photo.category,
          agreement: photo.agreement,
          model_count: photo.model_count,
          observations: photo.observations,
        })),
      }),
      report_contract: JSON.stringify(contract),
      category: contract.identification.category,
      species_slug: contract.identification.slug,
      service_line: contract.service.line,
      urgency: contract.urgency,
      ai_summary: (result.observations || []).join(' ').slice(0, 2000) || null,
    }).returning(['id']);

    await storeFunnelPhotos({
      table: 'pest_identification_photos',
      fkColumn: 'identification_id',
      rowId: row.id,
      keyPrefix: 'pestid',
      photos,
    });

    return res.status(201).json({
      success: true,
      assessmentId: row.id,
      claimToken,
      photoCount: photos.filter((photo) => photo.data).length,
      teaser: buildPestTeaser(contract),
    });
  } catch (err) {
    return next(err);
  }
});

function validateClaim(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid_body' };
  // Accept both spellings: /analyze returns the bearer as camelCase
  // `claimToken`, so a client replaying the field it received must not 404.
  const claimToken = typeof body.claim_token === 'string' ? body.claim_token
    : (typeof body.claimToken === 'string' ? body.claimToken : '');
  if (!TOKEN_RE.test(claimToken)) return { ok: false, error: 'invalid_claim_token' };

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
    },
  };
}

// POST /api/public/pest-identifier/:id/claim
router.post('/:id/claim', requirePestGate, claimLimiter, async (req, res, next) => {
  try {
    setPublicPrivacyHeaders(res);
    if (!UUID_RE.test(String(req.params.id || ''))) return res.status(404).json({ error: 'Not found' });
    if (isHoneypotTripped(req.body)) {
      logger.info('[public-pest-identifier] honeypot tripped — dropping claim');
      return res.status(200).json({ ok: true });
    }

    const parsed = validateClaim(req.body);
    if (!parsed.ok) {
      if (parsed.error === 'invalid_claim_token') return res.status(404).json({ error: 'Not found' });
      return res.status(400).json({ error: parsed.error });
    }
    const claim = parsed.value;

    const row = await db('pest_identifications')
      .where({ id: req.params.id, claim_token: claim.claimToken, source: 'public_funnel', mode: 'prospect' })
      .first();
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.lead_id || row.status === 'sent') {
      return res.status(409).json({ error: 'This identification has already been unlocked.' });
    }
    if (row.status !== 'analyzed') return res.status(404).json({ error: 'Not found' });

    const contract = typeof row.report_contract === 'object' ? row.report_contract : {};
    const service = (contract && contract.service) || {};
    const pricing = await buildPestPricingSnapshot(service.key);
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
          lead_type: 'pest_identifier',
          service_interest: cleanString(service.label, 120) || 'pest control',
          first_contact_channel: 'pest_identifier_funnel',
          status: 'new',
          extracted_data: JSON.stringify({
            identification_id: row.id,
            source: 'pest_identifier_funnel',
            species_slug: row.species_slug,
            category: row.category,
            urgency: row.urgency,
            ...(attribution ? { attribution } : {}),
          }),
        }).returning(['id']);

        // One-shot unlock (same TOCTOU-closing transaction as the lawn claim).
        const updated = await trx('pest_identifications')
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
        return res.status(409).json({ error: 'This identification has already been unlocked.' });
      }
      throw txErr;
    }

    // Funnel-by-source attribution (same contract as the lawn claim): one
    // ad_service_attribution row per lead so the magnet reports alongside
    // every other channel and the funnel-bridge advances its stage. The
    // service-line inferers run on the identified service label so a termite
    // ID buckets under termite ROI, not generic pest. Best-effort after the
    // claim commits; idempotent via the unique lead_id index.
    if (createdLeadId) {
      const interest = cleanString(service.label, 120) || 'pest control';
      // The shared inferers key on quote-style interest strings; the library's
      // inspection-first labels ("Termite Protection", "Rodent Inspection &
      // Exclusion") fall through to quarterly_pest and would misreport these
      // leads in the service-line ROI views — map those lines explicitly.
      const INSPECTION_FIRST_SPECIFIC = {
        termite: { specific: 'termite_inspection', bucket: 'high_ticket_specialty' },
        rodent: { specific: 'rodent_inspection', bucket: 'high_ticket_specialty' },
      };
      const lineOverride = INSPECTION_FIRST_SPECIFIC[service.line];
      try {
        await db('ad_service_attribution').insert({
          lead_id: createdLeadId,
          service_line: inferServiceLine(interest),
          specific_service: lineOverride ? lineOverride.specific : inferSpecificService(interest),
          service_bucket: lineOverride ? lineOverride.bucket : inferServiceBucket(interest),
          lead_date: etDateString(),
          lead_source: 'pest_identifier',
          lead_source_detail: 'wavespestcontrol.com/pest-identifier',
          funnel_stage: 'lead',
          // First-touch evidence only — the channel stays the magnet
          // (see sanitizeAttribution in routes/public-lawn-assessment.js).
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
        logger.error(`[public-pest-identifier] attribution insert failed: ${attrErr.message}`);
      }
    }

    logger.info(`[public-pest-identifier] claim captured for identification ${row.id}`);
    return res.status(201).json({
      success: true,
      token: reportToken,
      reportUrl: `/pest-report/${reportToken}`,
      expiresAt,
      pricing: sanitizePricingSnapshot(pricing),
    });
  } catch (err) {
    return next(err);
  }
});

async function loadSentIdentification(token) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const row = await db('pest_identifications')
    .where({ report_token: token, status: 'sent' })
    .whereNotNull('report_expires_at')
    .where('report_expires_at', '>', db.fn.now())
    .first();
  if (!row) return null;
  // Fail closed (defense in depth if a row is ever loaded without the predicate).
  if (!row.report_expires_at || new Date(row.report_expires_at).getTime() <= Date.now()) return null;
  return row;
}

// GET /api/public/pest-identifier/:token
router.get('/:token', readLimiter, async (req, res, next) => {
  try {
    setPublicPrivacyHeaders(res);
    const row = await loadSentIdentification(req.params.token);
    if (!row) return res.status(404).json({ error: 'Report not found' });
    // Funnel-stage stamp: first successful report view. Intentionally
    // fire-and-forget (void, .catch attached) — a metrics write must never
    // add latency or failure to the customer's report load; the guarded
    // update makes concurrent first views idempotent.
    if (!row.report_first_viewed_at) {
      void db('pest_identifications')
        .where({ id: row.id })
        .whereNull('report_first_viewed_at')
        .update({ report_first_viewed_at: db.fn.now() })
        .catch((err) => logger.warn(`[public-pest-identifier] view stamp failed: ${err.message}`));
    }
    return res.json({ success: true, report: buildPublicPestReport(row) });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
module.exports._test = {
  validateClaim,
  normalizePhotos,
  buildPestPricingSnapshot,
  loadSentIdentification,
  PRICEABLE_SERVICES,
};
