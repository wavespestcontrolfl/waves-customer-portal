/**
 * Lawn Diagnostic — shared analysis ladder.
 *
 * Extracted from routes/tech-lawn-diagnostic.js so the tech flow and the
 * public lawn-assessment funnel run the exact same pipeline (perception →
 * adversarial challenge → symptom downgrade → deterministic composite →
 * minimal). One implementation, two front doors — the ladder's safety
 * semantics (never publish an un-challenged diagnosis) must not fork.
 */

const logger = require('./logger');
const lawnAssessment = require('./lawn-assessment');
const { withConcurrency, mergePhotoComposites } = require('./lawn-photo-merge');
const {
  runPerception,
  runChallenge,
  runWriter,
  runNarrative,
  symptomFindingsFromObservations,
} = require('./lawn-diagnostic-prompt');
const { etParts } = require('../utils/datetime-et');

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
      // Photo-only disease never clears the v0.4 naming gate (needs a blade/margin
      // close-up), so cap this deterministic-fallback finding at low confidence —
      // the egress label then downgrades it to a generic symptom.
      confidence: 'low',
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

/**
 * Findings ladder — NEVER BLOCKS, but never publishes an UN-CHALLENGED diagnosis.
 *   multimodel (L1) ...... Gemini perceive + Opus challenge → diagnosis-level.
 *   challenge_degraded (L2) perception ok but challenge unavailable → SYMPTOM-only
 *                          (deterministic downgrade; names no cause, field-check copy).
 *   deterministic (L4) ... perception unusable → Claude+Gemini composite findings.
 *   minimal .............. nothing usable → no-diagnosis report.
 * The Claude+Gemini composite is the fallback only (analyzePhotos runs lazily), so
 * the happy path uses Gemini for vision and never touches Claude vision.
 *
 * Returns { findings, findingsSource, fallbackReason, photoAnalysis, provenance }.
 * The caller supplies (and may pre-populate) nothing — provenance is built here.
 */
async function runFindingsLadder({ photos = [], season, products = [], compliance = {} } = {}) {
  let findings = null;
  let findingsSource = null;
  let fallbackReason = null;
  let photoAnalysis = null;
  const provenance = { challenge: null, perceptionModel: null, challengeModel: null, writerModel: null };

  const perception = await runPerception({ photos, season, products, compliance });
  if (perception.ok) provenance.perceptionModel = perception.model;
  const challenge = perception.ok
    ? await runChallenge(perception, { products, compliance, season })
    : { ok: false, reason: `no_perception:${perception.reason || 'unknown'}`, findings: [], challenge: null };
  provenance.challenge = challenge.challenge || null;

  if (challenge.ok && challenge.findings.length) {
    findings = challenge.findings;
    findingsSource = 'multimodel';
    provenance.challengeModel = challenge.challenge?.model || null;
  } else if (perception.ok) {
    // Observations exist but the adversarial layer didn't pass — downgrade to
    // symptom-only deterministically (no model, no cause names).
    const symptom = symptomFindingsFromObservations(perception.observations);
    if (symptom.length) {
      findings = symptom;
      findingsSource = 'challenge_degraded';
      fallbackReason = challenge.challenge?.failureType || challenge.reason || null;
    }
  }

  if (!findings) {
    // Perception/observations unusable: deterministic composite, then minimal-safe.
    photoAnalysis = await analyzePhotos(photos);
    if (photoAnalysis.composite) {
      findings = buildFindingsFromVision({
        composite: photoAnalysis.composite,
        adjustedScores: photoAnalysis.adjustedScores,
        divergenceFlags: photoAnalysis.divergenceFlags,
      });
      findingsSource = 'deterministic_fallback';
      fallbackReason = fallbackReason || (perception.ok ? 'observations_unusable' : perception.reason);
    } else {
      findings = [];
      findingsSource = 'minimal_fallback';
      fallbackReason = fallbackReason || perception.reason || 'vision_unavailable';
    }
  }

  return { findings, findingsSource, fallbackReason, photoAnalysis, provenance };
}

/**
 * Auto-release writer step. The polished LLM writer runs ONLY for the
 * fully-challenged multimodel path; every degraded/fallback path keeps the
 * deterministic, symptom-only summary so an un-challenged report never gets a
 * confident customer voice. Mutates reportContract.customer_summary and
 * provenance.writerModel on success.
 */
async function applyWriterSummary(reportContract, { season, findingsSource, releaseMode, provenance }) {
  if (findingsSource !== 'multimodel' || releaseMode === 'minimal') return;
  const writer = await runWriter(reportContract, { season });
  if (writer.ok) {
    reportContract.customer_summary = writer.customer_summary;
    provenance.writerModel = writer.model;
    return;
  }
  const narrative = await runNarrative(reportContract, { season });
  if (narrative.ok) {
    reportContract.customer_summary = narrative.customer_summary;
    provenance.writerModel = narrative.model || 'anthropic-fallback';
  } else {
    logger.warn('[lawn-diagnostic-analyze] writer and narrative both unavailable — deterministic summary stands');
  }
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
  const diagnosis = contract.diagnosis || {};
  // Minimal / no-defensible-finding reports stay UNSCORED so the public label reads
  // "Reviewed", not a default-severity "Keep an eye on it".
  if (!Array.isArray(diagnosis.findings) || !diagnosis.findings.length) return null;
  const { ceiling, fallback } = severityCeiling(diagnosis);
  const base = Number.isFinite(Number(clientScore)) ? Math.round(Number(clientScore)) : fallback;
  return Math.max(0, Math.min(ceiling, base));
}

module.exports = {
  analyzePhotos,
  buildFindingsFromVision,
  runFindingsLadder,
  applyWriterSummary,
  scoreSeverity,
  confidenceFromDivergence,
  severityCeiling,
  deriveOverallScore,
};
