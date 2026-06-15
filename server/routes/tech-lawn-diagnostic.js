const express = require('express');
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

function downgradeRequestLabelConstraints(product = {}) {
  const incomingConstraints = product.product_label_constraints || product.productLabelConstraints || product.label_constraints || product.labelConstraints || null;
  if (!incomingConstraints || typeof incomingConstraints !== 'object') return product;
  return {
    ...product,
    product_label_constraints: {
      ...incomingConstraints,
      source: incomingConstraints.source === 'product_db' ? 'request' : (incomingConstraints.source || 'request'),
      confidence: incomingConstraints.confidence === 'db_authoritative' ? 'inferred' : (incomingConstraints.confidence || 'inferred'),
      requires_label_review: true,
    },
  };
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
    if (photos.some((photo) => photo.data) && !photoAnalysis.aiAvailable && !suppliedFindings.length) {
      return res.status(502).json({
        success: false,
        error: 'AI analysis failed for all photos. Add manual findings or retry with clearer photos.',
      });
    }

    const products = await enrichAppliedProducts(appliedProducts);

    // Findings priority: manual supplied > LLM diagnosis (PASS A) > deterministic
    // vision fallback. Mechanical failure degrades to deterministic — never blocks.
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
      } else {
        findings = buildFindingsFromVision({
          composite: photoAnalysis.composite,
          adjustedScores: photoAnalysis.adjustedScores,
          divergenceFlags: photoAnalysis.divergenceFlags,
        });
        findingsSource = 'deterministic_fallback';
        fallbackReason = llm.reason || null;
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

module.exports = router;

module.exports._test = {
  buildFindingsFromVision,
  downgradeRequestLabelConstraints,
  enrichAppliedProducts,
  labelConstraintsFromCatalog,
  normalizePhoto,
};
