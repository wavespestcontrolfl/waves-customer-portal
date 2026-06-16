const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const lawnAssessment = require('../services/lawn-assessment');
const { withConcurrency, mergePhotoComposites } = require('../services/lawn-photo-merge');
const {
  buildDiagnosticReportContract,
  classifyReleaseMode,
  applyAutoReleaseRepair,
} = require('../services/lawn-diagnostic-report');
const { runDiagnosis, runNarrative, PROMPT_VERSION } = require('../services/lawn-diagnostic-prompt');
const { etParts } = require('../utils/datetime-et');

const MAX_ANALYZE_PHOTOS = 5;
const DIAGNOSTIC_MODES = ['internal', 'prospect'];
const REPORT_TTL_DAYS = 30;

function cleanString(value, max = 200) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function parseJsonObject(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeContact(contact) {
  if (!contact || typeof contact !== 'object' || Array.isArray(contact)) return null;
  const out = {
    first_name: cleanString(contact.first_name ?? contact.firstName),
    last_name: cleanString(contact.last_name ?? contact.lastName),
    name: cleanString(contact.name),
    email: cleanString(contact.email),
    phone: cleanString(contact.phone),
  };
  return Object.values(out).some(Boolean) ? out : null;
}

function normalizeAddress(address) {
  if (!address || typeof address !== 'object' || Array.isArray(address)) return null;
  const lat = Number(address.lat);
  const lng = Number(address.lng);
  const out = {
    line1: cleanString(address.line1 ?? address.address ?? address.street),
    city: cleanString(address.city),
    state: cleanString(address.state, 20),
    zip: cleanString(address.zip ?? address.postal_code, 12),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  };
  return Object.values(out).some((v) => v != null && v !== '') ? out : null;
}

function contactName(contact) {
  if (!contact) return null;
  return contact.name
    || [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim()
    || null;
}

// Send gate: a contact name plus either an email or a usable address.
function hasSendableContact(contact, address) {
  const name = contactName(contact);
  const hasEmail = Boolean(contact && contact.email);
  const hasAddress = Boolean(address && (address.line1 || (address.city && address.state)));
  return Boolean(name && (hasEmail || hasAddress));
}

router.use(adminAuthenticate, requireTechOrAdmin);

function asArray(value) {
  return Array.isArray(value) ? value.filter((item) => item != null) : [];
}

function normalizePhoto(photo = {}, index = 0) {
  return {
    photo_id: photo.photo_id || photo.photoId || photo.id || `photo-${index + 1}`,
    data: photo.data || photo.base64 || null,
    mimeType: photo.mimeType || photo.mime_type || 'image/jpeg',
    quality: photo.quality || photo.photo_quality || null,
    limitations: asArray(photo.limitations || photo.photo_limitations || photo.missing_views),
  };
}

function scoreSeverity(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return 'moderate';
  if (n < 45) return 'severe';
  if (n < 70) return 'moderate';
  return 'mild';
}

// The public report turns overall_score into Healthy / Keep an eye on it / Needs
// attention. Derive that score SERVER-SIDE from the rebuilt contract's worst finding
// severity and never let a client-supplied score exceed the severity-implied ceiling,
// so a stale/buggy client can't publish a "Healthy" banner over severe findings.
function severityCeiling(diagnosis = {}) {
  const severities = (Array.isArray(diagnosis.findings) ? diagnosis.findings : [])
    .map((f) => String((f && f.severity) || '').toLowerCase());
  if (!severities.length) severities.push(String(diagnosis.severity || '').toLowerCase());
  if (severities.includes('severe')) return { ceiling: 39, fallback: 25 };
  if (severities.includes('moderate')) return { ceiling: 69, fallback: 55 };
  return { ceiling: 100, fallback: 85 };
}

function deriveOverallScore(contract = {}, clientScore = null) {
  const { ceiling, fallback } = severityCeiling(contract.diagnosis || {});
  const base = Number.isFinite(Number(clientScore)) ? Math.round(Number(clientScore)) : fallback;
  return Math.max(0, Math.min(ceiling, base));
}

function confidenceFromDivergence(validResults = [], divergenceFlags = []) {
  if (!validResults.length) return 'low';
  if (divergenceFlags.length > 1) return 'low';
  if (validResults.length > 1 && divergenceFlags.length === 0) return 'moderate';
  return 'moderate';
}

function buildFindingsFromVision({ composite = {}, adjustedScores = {}, divergenceFlags = [] } = {}) {
  const findings = [];
  const evidence = [composite.observations].filter(Boolean);
  const confidence = confidenceFromDivergence([composite].filter(Boolean), divergenceFlags);

  if (Number(adjustedScores.weed_suppression) < 75) {
    findings.push({
      finding_id: 'F1',
      name: 'Visible weed pressure',
      confidence,
      severity: scoreSeverity(adjustedScores.weed_suppression),
      urgency: Number(adjustedScores.weed_suppression) < 45 ? 'follow_up' : 'monitor',
      observed_evidence: evidence,
      negative_evidence: [],
      confirmation_step: 'Confirm weed type at the plant level before naming specific weeds in customer copy.',
    });
  }

  if (composite.fungal_activity && composite.fungal_activity !== 'none') {
    findings.push({
      finding_id: `F${findings.length + 1}`,
      name: 'Possible fungal activity',
      confidence,
      severity: composite.fungal_activity === 'severe' ? 'severe' : composite.fungal_activity === 'moderate' ? 'moderate' : 'mild',
      urgency: composite.fungal_activity === 'severe' ? 'follow_up' : 'monitor',
      observed_evidence: evidence,
      negative_evidence: ['Photo review does not replace blade-level disease confirmation.'],
      confirmation_step: 'Confirm with close-up blade and patch-margin inspection before calling disease active.',
    });
  }

  if (Number(adjustedScores.turf_density) < 75) {
    findings.push({
      finding_id: `F${findings.length + 1}`,
      name: 'Thin turf density',
      confidence,
      severity: scoreSeverity(adjustedScores.turf_density),
      urgency: Number(adjustedScores.turf_density) < 45 ? 'follow_up' : 'monitor',
      observed_evidence: evidence,
      negative_evidence: [],
      confirmation_step: 'Confirm whether thinning is from shade, mowing height, irrigation coverage, pest pressure, or prior damage.',
    });
  }

  if (Number(adjustedScores.color_health) < 75) {
    findings.push({
      finding_id: `F${findings.length + 1}`,
      name: 'Turf color stress',
      confidence,
      severity: scoreSeverity(adjustedScores.color_health),
      urgency: 'monitor',
      observed_evidence: evidence,
      negative_evidence: [],
      confirmation_step: 'Confirm likely cause with irrigation, nutrient, soil, and recent weather context.',
    });
  }

  if (composite.overwatering_signal === true) {
    findings.push({
      finding_id: `F${findings.length + 1}`,
      name: 'Overwatering signal',
      confidence,
      severity: 'moderate',
      urgency: 'monitor',
      observed_evidence: evidence,
      negative_evidence: [],
      confirmation_step: 'Confirm irrigation schedule, rainfall, and soil moisture before recommending more water.',
    });
  }

  if (!findings.length) {
    findings.push({
      finding_id: 'F1',
      name: 'No major visible lawn stress signal',
      confidence,
      severity: 'mild',
      urgency: 'monitor',
      observed_evidence: evidence,
      negative_evidence: [
        'No strong weed, disease, thinning, or color-stress signal was derived from the submitted photos.',
      ],
      confirmation_step: 'Continue routine monitoring and field verification.',
    });
  }

  return findings;
}

async function productCatalogColumns() {
  return db('products_catalog').columnInfo().catch(() => ({}));
}

function normalizeProductId(product = {}) {
  return product.product_id || product.productId || product.id || null;
}

// On a catalog MISS the applied product is unverified, so no request-supplied label
// authority may survive to the customer report. normalizeProductLabelConstraints()
// reads top-level label_verified_at/label_source/post_app_irrigation as
// product_db / db_authoritative, so a stale or hostile client could publish exact
// watering instructions (e.g. post_app_irrigation: 'hold 48h') from an unverified
// product. Strip those top-level fields AND downgrade any nested constraints to
// request/inferred so watering falls back to label-limited copy.
function downgradeRequestLabelConstraints(product = {}) {
  if (!product || typeof product !== 'object') return product;
  const incoming = product.product_label_constraints || product.productLabelConstraints || product.label_constraints || product.labelConstraints || null;
  const incomingObj = incoming && typeof incoming === 'object' ? incoming : {};
  // Preserve any caller-supplied watering hint ONLY as inferred guidance; the
  // downstream label-limited release then strips exact timing.
  const postAppIrrigation = incomingObj.post_app_irrigation || incomingObj.postAppIrrigation
    || product.post_app_irrigation || product.postAppIrrigation || null;

  const downgraded = { ...product };
  // Remove top-level authority signals normalizeProductLabelConstraints() would
  // otherwise read as label-verified, even when no nested constraints were sent.
  delete downgraded.label_verified_at;
  delete downgraded.labelVerifiedAt;
  delete downgraded.label_source;
  delete downgraded.labelSource;
  delete downgraded.post_app_irrigation;
  delete downgraded.postAppIrrigation;

  downgraded.product_label_constraints = {
    ...incomingObj,
    ...(postAppIrrigation ? { post_app_irrigation: postAppIrrigation } : {}),
    source: incomingObj.source === 'product_db' ? 'request' : (incomingObj.source || 'request'),
    confidence: incomingObj.confidence === 'db_authoritative'
      ? 'inferred'
      : (incomingObj.confidence || (postAppIrrigation ? 'inferred' : 'missing')),
    requires_label_review: true,
  };
  return downgraded;
}

function labelConstraintsFromCatalog(row = {}, incomingConstraints = null) {
  const constraints = {};
  if (row.label_verified_at) constraints.source = 'product_db';
  if (row.label_verified_at) constraints.source_version = row.label_verified_at;
  if (row.rainfast_minutes) constraints.rainfast_hours = Number(row.rainfast_minutes) / 60;
  if (row.reentry_text) constraints.reentry_note = row.reentry_text;

  if (row.label_verified_at) {
    if (row.irrigation_required === true) {
      constraints.post_app_irrigation = 'water in according to reviewed product label';
    } else if (row.rainfast_minutes) {
      const hours = Math.max(1, Math.ceil(Number(row.rainfast_minutes) / 60));
      constraints.post_app_irrigation = `hold ${hours}h`;
    }
  }

  if (!constraints.confidence && constraints.source === 'product_db' && constraints.post_app_irrigation) {
    constraints.confidence = 'db_authoritative';
    constraints.requires_label_review = false;
  }

  if (!constraints.post_app_irrigation && incomingConstraints && typeof incomingConstraints === 'object') {
    return {
      ...incomingConstraints,
      confidence: incomingConstraints.confidence === 'db_authoritative' ? 'inferred' : (incomingConstraints.confidence || 'inferred'),
      requires_label_review: true,
    };
  }
  return constraints;
}

async function enrichAppliedProducts(inputProducts = []) {
  const products = asArray(inputProducts);
  const ids = products.map(normalizeProductId).filter(Boolean);
  if (!ids.length) return products.map(downgradeRequestLabelConstraints);

  try {
    const columns = await productCatalogColumns();
    const wanted = [
      'id',
      'name',
      'category',
      'subcategory',
      'active_ingredient',
      'analysis_n',
      'analysis_p',
      'analysis_k',
      'label_verified_at',
      'reentry_text',
      'rainfast_minutes',
      'irrigation_required',
    ].filter((column) => columns[column]);
    if (!wanted.length) return products.map(downgradeRequestLabelConstraints);

    const catalogRows = await db('products_catalog').whereIn('id', ids).select(wanted);
    const byId = new Map(catalogRows.map((row) => [String(row.id), row]));
    return products.map((product, index) => {
      const id = normalizeProductId(product);
      const row = id ? byId.get(String(id)) : null;
      if (!row) return downgradeRequestLabelConstraints(product);
      const productId = id || `P${index + 1}`;
      const incomingConstraints = product.product_label_constraints || product.productLabelConstraints || product.label_constraints || product.labelConstraints || null;
      return {
        ...product,
        product_id: productId,
        product_name: product.product_name || product.productName || product.name || row.name,
        catalog_product_id: row.id,
        category: row.category || row.subcategory || product.category,
        subcategory: row.subcategory || product.subcategory,
        active_ingredient: row.active_ingredient || product.active_ingredient || product.activeIngredient,
        analysis_n: row.analysis_n ?? null,
        analysis_p: row.analysis_p ?? null,
        analysis_k: row.analysis_k ?? null,
        label_verified_at: row.label_verified_at || null,
        reentry_text: row.reentry_text || null,
        rainfast_minutes: row.rainfast_minutes ?? null,
        irrigation_required: row.irrigation_required ?? null,
        product_label_constraints: labelConstraintsFromCatalog(row, incomingConstraints),
      };
    });
  } catch (err) {
    logger.warn(`[tech-lawn-diagnostic] product enrichment skipped: ${err.message}`);
    return products.map(downgradeRequestLabelConstraints);
  }
}

async function analyzePhotos(photos = []) {
  const analyzablePhotos = photos.filter((photo) => photo.data);
  if (!analyzablePhotos.length) {
    return {
      validResults: [],
      composite: null,
      adjustedScores: null,
      divergenceFlags: [],
      aiAvailable: false,
    };
  }

  const photoResults = await withConcurrency(analyzablePhotos, 3, (photo) =>
    lawnAssessment.analyzePhoto(photo.data, photo.mimeType || 'image/jpeg'),
  );
  const validResults = photoResults.filter(Boolean);
  if (!validResults.length) {
    return {
      validResults,
      composite: null,
      adjustedScores: null,
      divergenceFlags: [],
      aiAvailable: false,
    };
  }

  const composite = mergePhotoComposites(validResults);
  const displayScores = lawnAssessment.mapToDisplayScores(composite);
  const month = etParts(new Date()).month;
  const season = lawnAssessment.getSeason(month);
  const adjustedScores = lawnAssessment.applySeasonalAdjustment(displayScores, month);
  const divergenceFlags = validResults.flatMap((result) => result.divergenceFlags || []);

  return {
    validResults,
    composite,
    displayScores,
    adjustedScores,
    divergenceFlags,
    season,
    aiAvailable: true,
  };
}

router.post('/analyze', async (req, res, next) => {
  try {
    const photos = asArray(req.body.photos).map(normalizePhoto);
    const suppliedFindings = asArray(req.body.findings || req.body.diagnosis?.findings);
    const appliedProducts = asArray(req.body.appliedProducts || req.body.applied_products || req.body.products);
    const compliance = req.body.compliance && typeof req.body.compliance === 'object' ? req.body.compliance : {};

    if (!photos.length && !suppliedFindings.length) {
      return res.status(400).json({ error: 'At least one photo or diagnostic finding is required' });
    }
    if (photos.length > MAX_ANALYZE_PHOTOS) {
      return res.status(400).json({ error: `At most ${MAX_ANALYZE_PHOTOS} photos can be analyzed at once` });
    }
    if (photos.length && !photos.some((photo) => photo.data) && !suppliedFindings.length) {
      return res.status(400).json({ error: 'At least one photo with image data is required when diagnostic findings are not supplied' });
    }

    const photoAnalysis = await analyzePhotos(photos);

    const products = await enrichAppliedProducts(appliedProducts);

    // Findings priority: manual supplied > LLM diagnosis (PASS A) > deterministic
    // vision fallback > minimal-safe (total vision/LLM outage). Never blocks — a
    // provider/key failure degrades to a minimal report, it does not 502.
    let findings;
    let findingsSource;
    let fallbackReason = null;
    if (suppliedFindings.length) {
      findings = suppliedFindings;
      findingsSource = 'manual';
    } else {
      const llm = await runDiagnosis({
        photos,
        visionScores: photoAnalysis.adjustedScores,
        divergenceFlags: photoAnalysis.divergenceFlags,
        products,
        compliance,
        season: photoAnalysis.season,
        grassType: photoAnalysis.composite?.grass_type,
      });
      if (llm.ok && llm.findings.length) {
        findings = llm.findings;
        findingsSource = 'llm';
      } else if (photoAnalysis.composite) {
        findings = buildFindingsFromVision({
          composite: photoAnalysis.composite,
          adjustedScores: photoAnalysis.adjustedScores,
          divergenceFlags: photoAnalysis.divergenceFlags,
        });
        findingsSource = 'deterministic_fallback';
        fallbackReason = llm.reason || null;
      } else {
        // Total outage: no LLM and no vision scores to derive findings from.
        // Degrade to a minimal-safe report (no diagnosis) rather than failing.
        findings = [];
        findingsSource = 'minimal_fallback';
        fallbackReason = llm.reason || 'vision_unavailable';
      }
    }

    const inputPhotos = photos.map((photo) => ({
      photo_id: photo.photo_id,
      quality: photo.quality || 'limited',
      limitations: photo.limitations,
    }));
    const reportContract = buildDiagnosticReportContract({
      photos: inputPhotos,
      findings,
      products,
      compliance,
      seasonal_context: req.body.seasonalContext || req.body.seasonal_context || '',
    });

    // Auto-release: classify, write the summary in one LLM voice (PASS B) when the
    // diagnosis came from the model and is defensible, then repair/degrade unsafe
    // copy. The report always releases in one of four modes.
    const releaseMode = classifyReleaseMode(reportContract);
    if (findingsSource === 'llm' && releaseMode !== 'minimal') {
      const narrative = await runNarrative(reportContract, { season: photoAnalysis.season });
      if (narrative.ok) reportContract.customer_summary = narrative.customer_summary;
    }
    const finalContract = applyAutoReleaseRepair(reportContract, releaseMode);

    return res.json({
      success: true,
      persisted: false,
      aiAvailable: photoAnalysis.aiAvailable,
      promptVersion: PROMPT_VERSION,
      findingsSource,
      fallbackReason,
      releaseMode,
      photoCount: photos.length,
      analyzedPhotoCount: photoAnalysis.validResults.length,
      composite: photoAnalysis.adjustedScores,
      rawComposite: photoAnalysis.composite,
      divergenceFlags: photoAnalysis.divergenceFlags,
      reportContract: finalContract,
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/tech/lawn-diagnostic — persist an analyzed diagnostic as a draft.
// The contract is rebuilt SERVER-SIDE from the analyze inputs (findings + re-enriched
// products + compliance), never accepted verbatim from the client — so the stored,
// later-published copy has authoritative watering/label gating and a server-computed,
// reconciliation-aware summary, not client free-text.
router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const findings = asArray(body.findings || body.diagnosis?.findings || body.reportContract?.diagnosis?.findings);
    // Empty findings are allowed — the contract rebuild yields a minimal, no-diagnosis
    // report (the no-block path). Require at least photos or findings so we don't
    // persist an empty row.
    if (!findings.length && !asArray(body.photos).length) {
      return res.status(400).json({ error: 'photos or diagnostic findings are required' });
    }

    const mode = DIAGNOSTIC_MODES.includes(body.mode) ? body.mode : 'internal';
    const contact = normalizeContact(body.contact);
    const address = normalizeAddress(body.address);
    const compliance = body.compliance && typeof body.compliance === 'object' ? body.compliance : {};
    const aiAnalysis = body.aiAnalysis && typeof body.aiAnalysis === 'object' ? body.aiAnalysis : {};
    const overallScore = Number.isFinite(Number(body.overallScore)) ? Math.round(Number(body.overallScore)) : null;
    const aiConfidence = Number.isFinite(Number(body.aiConfidence)) ? Number(body.aiConfidence) : null;
    const inputPhotos = asArray(body.photos).map((photo, index) => ({
      photo_id: photo.photo_id || photo.photoId || `photo-${index + 1}`,
      quality: photo.quality || photo.photo_quality || 'limited',
      limitations: asArray(photo.limitations || photo.photo_limitations || photo.missing_views),
    }));

    const products = await enrichAppliedProducts(asArray(body.appliedProducts || body.applied_products || body.products));
    const contract = buildDiagnosticReportContract({
      photos: inputPhotos,
      findings,
      products,
      compliance,
      seasonal_context: body.seasonalContext || body.seasonal_context || '',
    });
    const releaseMode = classifyReleaseMode(contract);
    // Mirror /analyze: re-run the narrative pass server-side on the authoritative
    // rebuilt contract so the published summary matches what the tech reviewed
    // (and stays server-generated, not client-trusted). Best-effort; the
    // deterministic summary stands if the model is unavailable.
    if (releaseMode !== 'minimal') {
      try {
        const narrative = await runNarrative(contract, { season: body.seasonalContext || body.seasonal_context || '' });
        if (narrative.ok) contract.customer_summary = narrative.customer_summary;
      } catch { /* keep deterministic summary */ }
    }
    const sanitizedContract = applyAutoReleaseRepair(contract, releaseMode);
    const aiSummary = cleanString(body.aiSummary, 2000) || cleanString(sanitizedContract.customer_summary, 2000);

    const [row] = await db('lawn_diagnostics').insert({
      mode,
      status: 'analyzed',
      created_by_technician_id: req.technicianId || req.technician?.id || null,
      contact_snapshot: contact ? JSON.stringify(contact) : null,
      address_snapshot: address ? JSON.stringify(address) : null,
      ai_analysis: JSON.stringify({ ...aiAnalysis, release_mode: releaseMode }),
      report_contract: JSON.stringify(sanitizedContract),
      ai_confidence: aiConfidence,
      // Server-derived from the rebuilt contract severity; a client-supplied
      // overallScore can only lower it, never inflate past the findings.
      overall_score: deriveOverallScore(sanitizedContract, overallScore),
      ai_summary: aiSummary,
    }).returning(['id', 'mode', 'status']);

    return res.status(201).json({ success: true, id: row.id, mode: row.mode, status: row.status });
  } catch (err) {
    return next(err);
  }
});

// POST /api/tech/lawn-diagnostic/:id/send — capture contact, mint token, mark sent.
router.post('/:id/send', async (req, res, next) => {
  try {
    const row = await db('lawn_diagnostics').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'Diagnostic not found' });

    const contact = normalizeContact(req.body?.contact) || parseJsonObject(row.contact_snapshot, null);
    const address = normalizeAddress(req.body?.address) || parseJsonObject(row.address_snapshot, null);

    // Hard gate: no token is minted without sendable contact info.
    if (!hasSendableContact(contact, address)) {
      return res.status(422).json({ error: 'A contact name and an email or address are required to send a report.' });
    }

    const mintedToken = crypto.randomBytes(16).toString('hex');
    const freshExpiry = new Date(Date.now() + REPORT_TTL_DAYS * 24 * 60 * 60 * 1000);

    // Atomic mint/rotate. Keep the existing token + expiry ONLY when it is still
    // active (true idempotent resend); otherwise rotate to a fresh token + expiry
    // so an old expired /lawn-report link is never reactivated. The row lock
    // serializes concurrent sends (the second re-evaluates against the first's
    // committed active token and keeps it), and we return the stored values.
    const ACTIVE_TOKEN = 'report_token IS NOT NULL AND report_expires_at IS NOT NULL AND report_expires_at > now()';
    const [saved] = await db('lawn_diagnostics')
      .where({ id: row.id })
      .update({
        mode: 'prospect',
        status: 'sent',
        contact_snapshot: JSON.stringify(contact),
        address_snapshot: address ? JSON.stringify(address) : row.address_snapshot,
        report_token: db.raw(`CASE WHEN ${ACTIVE_TOKEN} THEN report_token ELSE ? END`, [mintedToken]),
        report_expires_at: db.raw(`CASE WHEN ${ACTIVE_TOKEN} THEN report_expires_at ELSE ? END`, [freshExpiry]),
        last_sent_at: db.fn.now(),
        updated_at: db.fn.now(),
      })
      .returning(['report_token', 'report_expires_at']);

    return res.json({
      success: true,
      token: saved.report_token,
      url: `/lawn-report/${saved.report_token}`,
      expiresAt: saved.report_expires_at,
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/tech/lawn-diagnostic/:id/lead — optionally save the diagnostic as a lead.
router.post('/:id/lead', async (req, res, next) => {
  try {
    const row = await db('lawn_diagnostics').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'Diagnostic not found' });
    if (row.lead_id) return res.json({ success: true, leadId: row.lead_id, alreadyLinked: true });

    const contact = normalizeContact(req.body?.contact) || parseJsonObject(row.contact_snapshot, null);
    const address = normalizeAddress(req.body?.address) || parseJsonObject(row.address_snapshot, null);
    const name = contactName(contact);
    if (!name && !(contact && (contact.phone || contact.email))) {
      return res.status(422).json({ error: 'A contact name, phone, or email is required to save a lead.' });
    }
    const [firstName, ...restName] = String(name || '').split(/\s+/);

    let leadId = null;
    await db.transaction(async (trx) => {
      const [lead] = await trx('leads').insert({
        first_name: firstName || name || null,
        last_name: restName.join(' ') || (contact && contact.last_name) || null,
        phone: (contact && contact.phone) || null,
        email: (contact && contact.email) || null,
        address: (address && address.line1) || null,
        city: (address && address.city) || null,
        zip: (address && address.zip) || null,
        lead_type: 'lawn_diagnostic',
        service_interest: 'lawn care',
        first_contact_channel: 'lawn_diagnostic',
        status: 'new',
        extracted_data: JSON.stringify({ diagnostic_id: row.id, source: 'tech_save_as_lead' }),
      }).returning(['id']);
      leadId = lead.id;
      const updated = await trx('lawn_diagnostics')
        .where({ id: row.id })
        .whereNull('lead_id')
        .update({ lead_id: lead.id, updated_at: trx.fn.now() });
      if (updated === 0) {
        const err = new Error('already_linked');
        err.code = 'ALREADY_LINKED';
        throw err;
      }
    }).catch(async (txErr) => {
      if (txErr.code !== 'ALREADY_LINKED') throw txErr;
      const fresh = await db('lawn_diagnostics').where({ id: row.id }).first('lead_id');
      leadId = (fresh && fresh.lead_id) || null;
    });

    return res.status(201).json({ success: true, leadId });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

module.exports._test = {
  buildFindingsFromVision,
  downgradeRequestLabelConstraints,
  enrichAppliedProducts,
  labelConstraintsFromCatalog,
  normalizePhoto,
  normalizeContact,
  normalizeAddress,
  contactName,
  hasSendableContact,
};
