/**
 * Customer Photo ID API (dark) — authenticated customers submit photos for an
 * on-the-spot AI read (pest identification, lawn health, tree & shrub health)
 * without waiting for a visit.
 *
 *   POST /api/photo-id/:type   (type ∈ pest | lawn | tree_shrub) — analyze + store
 *   GET  /api/photo-id         — this customer's last 20 submissions (any type)
 *   GET  /api/photo-id/:type/:id — one stored submission, owner-checked
 *
 * COMMS-FREE: this module never sends or triggers a customer communication —
 * no sendCustomerMessage, no email, no push/in-app notification. Every
 * response is a direct, synchronous reply to the customer's own request.
 *
 * GATED + CUSTOMER-AUTHENTICATED: `authenticate` runs on every handler, and
 * while GATE_CUSTOMER_PHOTO_ID is off every handler — including GET / —
 * answers 404 {error:'Not found'} so an authenticated client can hide the
 * whole feature off a single failed probe (same unobservable-when-dark
 * contract as the public photo funnels).
 *
 * Reuses the existing vision services end to end rather than standing up a
 * parallel pipeline: identifyPest / buildPestReportContract /
 * buildPublicPestReport (services/pest-identification.js), analyzePhoto
 * (services/lawn-assessment.js), previewTreeShrubAssessment /
 * buildCustomerTreeShrubReport (services/tree-shrub-assessment.js). Photo
 * validation is the shared request-photo-validation used by /api/requests;
 * photo storage is the shared best-effort S3 helper the public funnels use.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const db = require('../models/db');
const logger = require('../services/logger');
const { authenticate } = require('../middleware/auth');
const { isEnabled } = require('../config/feature-gates');
const { validateRequestPhotos, MAX_PHOTOS } = require('../utils/request-photo-validation');
const { VALID_LOCATIONS } = require('./requests');
const {
  identifyPest,
  buildPestReportContract,
  buildPublicPestReport,
  publicIdentificationLabel,
} = require('../services/pest-identification');
const lawnAssessment = require('../services/lawn-assessment');
const { loadCustomerGrassContext, grassTypeLabel } = require('../services/lawn-grass-context');
const {
  previewTreeShrubAssessment,
  buildCustomerTreeShrubReport,
  formatAssessmentScores,
} = require('../services/tree-shrub-assessment');
const { storeFunnelPhotos, storeTreeShrubCustomerPhotos } = require('../utils/funnel-photos');
const { reserviceStreamlineAccess } = require('../services/reservice-link');
const { etDateString } = require('../utils/datetime-et');

const OFFICE_PHONE = '(941) 297-5749';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATA_URL_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/;

const TYPE_TABLE = {
  pest: 'pest_identifications',
  lawn: 'lawn_diagnostics',
  tree_shrub: 'tree_shrub_assessments',
};

const REQUEST_CATEGORY = { pest: 'pest_issue', lawn: 'lawn_concern', tree_shrub: 'lawn_concern' };

// ── Dark until Adam flips the gate — authenticate first (every handler needs
// req.customer), then the 404 gate (also every handler, GET / included). ──
router.use(authenticate);
router.use((req, res, next) => {
  if (!isEnabled('customerPhotoId')) return res.status(404).json({ error: 'Not found' });
  return next();
});

// Per-customer spam/spend guard: 10 submissions per rolling 24h, always on
// (this is an authenticated customer's own quota, not a public-funnel abuse
// gate, so unlike the shared bucket below it is NOT skipped outside prod —
// the quota-429 test needs it live).
const perCustomerLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.customer && req.customer.id) || req.ip,
  message: { error: `You've reached today's photo-check limit. Call our office at ${OFFICE_PHONE} if you need help right away.` },
});

// Shared daily vision-spend ceiling across every customer and every type —
// same rationale and skip-outside-prod posture as index.js's
// photoAssessmentDailyLimiter for the public funnels.
const sharedDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: Number(process.env.PHOTO_ID_DAILY_MAX) || 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: () => 'photo-id-daily',
  skip: () => process.env.NODE_ENV !== 'production',
  message: { error: `Daily limit reached — call ${OFFICE_PHONE} and a real person will help right away.` },
});

function parseJsonSafe(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function cleanString(value, max = 200) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function splitDataUrl(dataUrl) {
  const match = DATA_URL_RE.exec(String(dataUrl || ''));
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

// ── Shared "what happens next" copy — the server decides the kind; the
// client renders title/body/url/request_prefill verbatim. ──────────────────
const NEXT_STEP_COPY = {
  inspection: {
    title: 'We need to see this in person',
    body: `A photo can suggest what's going on, but our team confirms it with a free in-person inspection — usually within a couple of days. Call ${OFFICE_PHONE} or send us your photos and we'll reach out.`,
  },
  none: {
    title: 'Nothing to worry about',
    body: 'Based on what we can see, no action is needed right now.',
  },
  unclear: {
    title: "Let's take a closer look",
    body: "We couldn't get a clear enough read from these photos. Send them to our team and we'll follow up personally.",
  },
  reservice: {
    title: 'Book your free re-service',
    body: 'Your plan covers this — book a free re-service visit and we\'ll take care of it.',
  },
  request: {
    title: 'Send this to our team',
    body: "We'll review these photos and follow up with next steps.",
  },
};

function buildNextStep(kind, { url, prefill } = {}) {
  const copy = NEXT_STEP_COPY[kind] || NEXT_STEP_COPY.request;
  const step = { kind, title: copy.title, body: copy.body };
  if (kind === 'reservice' && url) step.url = url;
  if ((kind === 'inspection' || kind === 'unclear' || kind === 'request') && prefill) step.request_prefill = prefill;
  return step;
}

// Resolve the non-terminal ('reservice' vs 'request') branch — the only part
// that depends on the customer's current plan coverage, so it is looked up
// once per request/listing and shared across items. Takes the resolved
// re-service LANE directly (not the upload type — see pestReserviceLane and
// the tree_shrub call sites below, codex r5 P1): reservice-scheduler.js's
// only two lanes are 'pest' and 'lawn', so a null lane (mosquito, termite,
// rodent, tree & shrub — anything else) can never resolve to 'reservice'.
function laneOutcomeKind(lane, access) {
  return (lane && access && Array.isArray(access.lanes) && access.lanes.includes(lane)) ? 'reservice' : 'request';
}

function prefillFor(type, { location, note } = {}) {
  return { category: REQUEST_CATEGORY[type], location: location || null, note: note || null };
}

// ── Pest ─────────────────────────────────────────────────────────────────

function pestPublicResult(contract) {
  const publicReport = buildPublicPestReport({ report_contract: JSON.stringify(contract) });
  return {
    label: publicReport.identified.label,
    hedged: publicReport.identified.hedged,
    confidence: publicReport.identified.confidence,
    category: publicReport.identified.category,
    not_a_pest: publicReport.not_a_pest,
    urgency: publicReport.urgency,
    safety: publicReport.safety,
    about: publicReport.about,
    recommendation: publicReport.recommendation,
  };
}

// Order matters (codex r1 P1): a contested or low-confidence "not a pest"
// read (e.g. a lovebug/beneficial call that disagreed across photos, or
// never rose past low confidence) must NOT reach the reassuring "nothing to
// worry about" copy — the hedged/generic check runs BEFORE the not_a_pest
// check, so only a confident, uncontested benign call reads as 'none'.
// Inspection stays first regardless of confidence (termite/rodent/WDO-style
// entries are inspection-first at ANY confidence, by design). `partial`
// (codex r4 P1) also runs before not_a_pest/lane-default: identifyPest
// returns ok:true as soon as ONE photo merges successfully, so a benign
// photo succeeding while an actual pest photo silently fails must not read
// as "nothing to worry about" either.
//
// `lane` is the RESOLVED re-service lane for what was actually identified —
// see pestReserviceLane — never the upload type. A general ant/roach call
// checks the 'pest' lane; a lawn-targeting pest (chinch bugs, sod webworms,
// white grubs) checks 'lawn'; mosquito/termite/rodent/tree-shrub-style pest
// findings resolve to a null lane and can never read as 'reservice' (codex
// r5 P1: those families are never self-serve reservice-eligible, whatever
// lanes the customer's OWN plan happens to cover).
function pestNextStepKind(result, idLabel, lane, access, partial) {
  if (result.recommendation && result.recommendation.inspection_required) return 'inspection';
  if (partial) return 'unclear';
  if (idLabel.hedged && idLabel.specificity === 'generic') return 'unclear';
  if (result.not_a_pest) return 'none';
  return laneOutcomeKind(lane, access);
}

function pestReserviceLane(contract) {
  const line = contract?.service?.line;
  return line === 'pest' || line === 'lawn' ? line : null;
}

async function handlePest(req, res, { note, location }) {
  const photoInputs = req._photoInputs;
  const result = await identifyPest(photoInputs);
  if (!result.ok) {
    return res.status(503).json({ error: `Photo analysis is briefly unavailable. Please try again in a few minutes or call ${OFFICE_PHONE}.` });
  }
  const partial = result.perPhoto.length < photoInputs.length;

  const contract = buildPestReportContract(result);
  const [row] = await db('pest_identifications').insert({
    mode: 'customer',
    status: 'analyzed',
    source: 'portal',
    customer_id: req.customer.id,
    ai_analysis: JSON.stringify({
      customer_note: note,
      partial,
      per_photo: result.perPhoto.map((photo) => ({
        slug: photo.entry ? photo.entry.slug : null,
        confidence: photo.confidence,
        category: photo.category,
        agreement: photo.agreement,
        model_count: photo.model_count,
      })),
    }),
    report_contract: JSON.stringify(contract),
    category: contract.identification.category,
    species_slug: contract.identification.slug,
    service_line: contract.service.line,
    urgency: contract.urgency,
    ai_summary: (result.observations || []).join(' ').slice(0, 2000) || null,
    note,
    location,
  }).returning(['id', 'created_at']);

  await storeFunnelPhotos({
    table: 'pest_identification_photos',
    fkColumn: 'identification_id',
    rowId: row.id,
    keyPrefix: 'pestid/customer',
    photos: photoInputs,
  });

  const pestResult = pestPublicResult(contract);
  const idLabel = publicIdentificationLabel(contract);
  const access = await reserviceStreamlineAccess(req.customer.id);
  const kind = pestNextStepKind(pestResult, idLabel, pestReserviceLane(contract), access, partial);
  const nextStep = buildNextStep(kind, {
    url: kind === 'reservice' && access ? `/reservice/${access.token}` : undefined,
    prefill: prefillFor('pest', { location, note }),
  });

  return res.status(200).json({
    id: row.id, type: 'pest', created_at: row.created_at, result: pestResult, next_step: nextStep,
  });
}

// ── Lawn ─────────────────────────────────────────────────────────────────

const LAWN_SEVERITY_ORDER = ['none', 'minor', 'moderate', 'severe'];
const LAWN_SEVERITY_RANK = { none: 0, minor: 1, moderate: 2, severe: 3 };
const THATCH_ORDER = ['low', 'moderate', 'high'];
const THATCH_RANK = { low: 0, moderate: 1, high: 2 };
const LAWN_SIGNAL_LABELS = {
  fungal_activity: 'Fungal activity',
  insect_damage: 'Insect damage',
  drought_stress: 'Drought stress',
  mechanical_damage: 'Mechanical damage',
  thatch_visibility: 'Thatch buildup',
};

// Numeric fields average across photos; categorical severities take the
// WORST reading across photos — a trouble-spot photo can't be diluted by
// clean overview shots (same worst-case principle tree-shrub's own
// mergePhotoComposites uses for its signal fields).
function worstOf(values, rankMap, orderList) {
  const ranks = values.filter((v) => v != null && rankMap[v] != null).map((v) => rankMap[v]);
  if (!ranks.length) return null;
  return orderList[Math.max(...ranks)];
}

// Missing (null/undefined/'') is NOT a zero reading (codex r1 P1: Number(null)
// === 0 and Number('') === 0 both pass Number.isFinite, so a genuinely absent
// score would silently become a measured zero, skew the average, and hide a
// vision gap from the noUsableScores check below) — filter the raw value
// BEFORE converting to a number, exactly like lawn-assessment.js's own
// drought_stress merge treats missing provider evidence as unknown, not none.
function numericValues(list, key) {
  return list.map((c) => c[key]).filter((v) => v != null && v !== '').map(Number).filter(Number.isFinite);
}

function mergeLawnComposites(list) {
  const turf = numericValues(list, 'turf_density');
  const weed = numericValues(list, 'weed_coverage');
  const color = numericValues(list, 'color_health');
  return {
    turf_density: turf.length ? Math.round(turf.reduce((a, b) => a + b, 0) / turf.length) : null,
    weed_coverage: weed.length ? Math.round(weed.reduce((a, b) => a + b, 0) / weed.length) : null,
    color_health: color.length ? Math.round(((color.reduce((a, b) => a + b, 0) / color.length) * 10)) / 10 : null,
    fungal_activity: worstOf(list.map((c) => c.fungal_activity), LAWN_SEVERITY_RANK, LAWN_SEVERITY_ORDER),
    insect_damage: worstOf(list.map((c) => c.insect_damage), LAWN_SEVERITY_RANK, LAWN_SEVERITY_ORDER),
    mechanical_damage: worstOf(list.map((c) => c.mechanical_damage), LAWN_SEVERITY_RANK, LAWN_SEVERITY_ORDER),
    drought_stress: worstOf(list.map((c) => c.drought_stress), LAWN_SEVERITY_RANK, LAWN_SEVERITY_ORDER),
    thatch_visibility: worstOf(list.map((c) => c.thatch_visibility), THATCH_RANK, THATCH_ORDER),
    overwatering_signal: list.some((c) => !!c.overwatering_signal),
    grass_type: list.map((c) => c.grass_type).find(Boolean) || null,
    // Every photo's text, not just the first non-empty one (codex r2 P1): the
    // severity fields above take the WORST reading across photos, so a
    // healthy-looking overview shot followed by a severely damaged area must
    // not let that first photo's reassuring paragraph stand in for the whole
    // submission and silently outrun what the signals above actually say.
    observations: list.map((c) => (c.observations || '').trim()).filter(Boolean).join(' ').slice(0, 1000),
  };
}

function lawnPublicResult(merged) {
  const signals = Object.keys(LAWN_SIGNAL_LABELS)
    .filter((key) => merged[key] != null)
    .map((key) => ({ key, label: LAWN_SIGNAL_LABELS[key], level: merged[key] }));
  return {
    grass_type: merged.grass_type ? grassTypeLabel(merged.grass_type) : null,
    scores: { turf_density: merged.turf_density, weed_coverage: merged.weed_coverage, color_health: merged.color_health },
    signals,
    overwatering_signal: merged.overwatering_signal,
    observations: merged.observations || '',
  };
}

async function handleLawn(req, res, { note, location }) {
  const photoInputs = req._photoInputs;
  const grassContext = await loadCustomerGrassContext(req.customer.id).catch(() => null);
  const context = grassContext
    ? { grassType: grassContext.grassTypeLabel || undefined, irrigation: grassContext.irrigationSystem || undefined }
    : {};

  const analyses = await Promise.all(photoInputs.map((photo) => lawnAssessment
    .analyzePhoto(photo.data, photo.mimeType, context)
    .catch((err) => { logger.warn(`[photo-id] lawn analyzePhoto failed: ${err.message}`); return null; })));
  const composites = analyses.filter(Boolean).map((a) => a.composite).filter(Boolean);
  if (!composites.length) {
    return res.status(503).json({ error: `Photo analysis is briefly unavailable. Please try again in a few minutes or call ${OFFICE_PHONE}.` });
  }
  // codex r3 P1: a trouble-spot photo failing while an overview photo
  // succeeds must not silently present the successful subset as a complete,
  // possibly reassuring read — a partial batch is unclear, whatever the
  // partial scores say.
  const partial = composites.length < photoInputs.length;

  const merged = mergeLawnComposites(composites);
  const lawnResult = lawnPublicResult(merged);

  const [row] = await db('lawn_diagnostics').insert({
    mode: 'customer',
    status: 'analyzed',
    source: 'portal',
    customer_id: req.customer.id,
    ai_analysis: JSON.stringify({ customer_note: note, composite: merged, partial }),
    report_contract: JSON.stringify({ contract_version: 'lawn_photo_id_v1', result: lawnResult, partial }),
    ai_summary: lawnResult.observations ? String(lawnResult.observations).slice(0, 2000) : null,
    note,
    location,
  }).returning(['id', 'created_at']);

  await storeFunnelPhotos({
    table: 'lawn_diagnostic_photos',
    fkColumn: 'diagnostic_id',
    rowId: row.id,
    keyPrefix: 'lawnfunnel/customer',
    photos: photoInputs,
  });

  const noUsableScores = merged.turf_density == null && merged.weed_coverage == null && merged.color_health == null;
  const access = await reserviceStreamlineAccess(req.customer.id);
  const kind = (noUsableScores || partial) ? 'unclear' : laneOutcomeKind('lawn', access);
  const nextStep = buildNextStep(kind, {
    url: kind === 'reservice' && access ? `/reservice/${access.token}` : undefined,
    prefill: prefillFor('lawn', { location, note }),
  });

  return res.status(200).json({
    id: row.id, type: 'lawn', created_at: row.created_at, result: lawnResult, next_step: nextStep,
  });
}

// ── Tree & shrub ─────────────────────────────────────────────────────────

async function handleTreeShrub(req, res, { note, location }) {
  const photoInputs = req._photoInputs;
  const preview = await previewTreeShrubAssessment({
    photos: photoInputs,
    loadImage: async (photo) => ({ base64: photo.data, mimeType: photo.mimeType }),
  }).catch((err) => { logger.warn(`[photo-id] tree-shrub preview failed: ${err.message}`); return null; });

  if (!preview) {
    return res.status(503).json({ error: `Photo analysis is briefly unavailable. Please try again in a few minutes or call ${OFFICE_PHONE}.` });
  }

  const treeResult = buildCustomerTreeShrubReport(preview);
  // codex r3 P1: a photo that failed to score (scoredCount < photoCount)
  // must not let the successfully-scored subset present as a complete read.
  const partial = preview.scoredCount != null && preview.photoCount != null
    && preview.scoredCount < preview.photoCount;

  const [row] = await db('tree_shrub_assessments').insert({
    customer_id: req.customer.id,
    service_date: etDateString(),
    source: 'portal',
    mode: 'customer',
    composite_scores: JSON.stringify({
      ...(preview.scores || {}), scored_count: preview.scoredCount ?? null, photo_count: preview.photoCount ?? null,
    }),
    foliage_fullness: preview.scores?.foliageFullness ?? null,
    leaf_color_vigor: preview.scores?.leafColorVigor ?? null,
    pest_activity: preview.scores?.pestActivity ?? null,
    disease_leaf_spot: preview.scores?.diseaseLeafSpot ?? null,
    water_heat_stress: preview.scores?.waterHeatStress ?? null,
    overall_score: preview.scores?.overallScore ?? null,
    observations: preview.observations || null,
    ai_summary: treeResult.summary,
    confirmed_by_tech: false,
    note,
    location,
  }).returning(['id', 'created_at']);

  await storeTreeShrubCustomerPhotos({
    assessmentId: row.id,
    customerId: req.customer.id,
    keyPrefix: 'treeshrub/customer',
    photos: photoInputs,
  });

  const noUsableScores = treeResult.scores.overall == null;
  const access = await reserviceStreamlineAccess(req.customer.id);
  // Tree & shrub is never a self-serve reservice lane (reservice-scheduler.js
  // explicitly excludes it from both 'pest' and 'lawn' — codex r5 P1) — a
  // null lane always resolves to 'request', whatever the customer's plan
  // covers.
  const kind = (noUsableScores || partial) ? 'unclear' : laneOutcomeKind(null, access);
  const nextStep = buildNextStep(kind, {
    url: kind === 'reservice' && access ? `/reservice/${access.token}` : undefined,
    prefill: prefillFor('tree_shrub', { location, note }),
  });

  return res.status(200).json({
    id: row.id, type: 'tree_shrub', created_at: row.created_at, result: treeResult, next_step: nextStep,
  });
}

const TYPE_HANDLERS = { pest: handlePest, lawn: handleLawn, tree_shrub: handleTreeShrub };

// POST /api/photo-id/:type
router.post('/:type', perCustomerLimiter, sharedDailyLimiter, async (req, res, next) => {
  try {
    const { type } = req.params;
    const handler = TYPE_HANDLERS[type];
    if (!handler) return res.status(400).json({ error: 'Unknown assessment type' });

    const body = req.body || {};
    const validated = validateRequestPhotos(body.photos);
    if (!validated.ok) return res.status(validated.status || 400).json({ error: validated.error });
    if (!validated.photos.length) return res.status(400).json({ error: `Attach at least one photo (up to ${MAX_PHOTOS}).` });

    if (body.note != null && typeof body.note !== 'string') return res.status(400).json({ error: 'note must be a string' });
    const note = cleanString(body.note, 500);

    let location = null;
    if (body.location != null && body.location !== '') {
      if (typeof body.location !== 'string' || !VALID_LOCATIONS.includes(body.location)) {
        return res.status(400).json({ error: 'Invalid location' });
      }
      location = body.location;
    }

    const photoInputs = validated.photos.map(splitDataUrl).filter(Boolean);
    if (!photoInputs.length) return res.status(400).json({ error: 'Photos could not be read.' });
    req._photoInputs = photoInputs;

    return await handler(req, res, { note, location });
  } catch (err) {
    return next(err);
  }
});

// ── Listing / detail ─────────────────────────────────────────────────────

function pestHeadline(row) {
  try {
    const contract = parseJsonSafe(row.report_contract);
    return publicIdentificationLabel(contract).label;
  } catch {
    return 'Pest photo check';
  }
}

function lawnHeadline(row) {
  try {
    const contract = parseJsonSafe(row.report_contract);
    const grass = contract?.result?.grass_type;
    return grass ? `Lawn check — ${grass}` : 'Lawn check';
  } catch {
    return 'Lawn check';
  }
}

function pestNextStepKindFromRow(row, access) {
  const contract = parseJsonSafe(row.report_contract);
  const publicReport = buildPublicPestReport({ report_contract: JSON.stringify(contract) });
  const idLabel = publicIdentificationLabel(contract);
  const partial = !!parseJsonSafe(row.ai_analysis).partial;
  return pestNextStepKind(publicReport, idLabel, pestReserviceLane(contract), access, partial);
}

function lawnNextStepKindFromRow(row, access) {
  const contract = parseJsonSafe(row.report_contract);
  const scores = contract?.result?.scores || {};
  const noScores = scores.turf_density == null && scores.weed_coverage == null && scores.color_health == null;
  return (noScores || contract.partial) ? 'unclear' : laneOutcomeKind('lawn', access);
}

function treeShrubIsPartial(row) {
  const meta = parseJsonSafe(row.composite_scores);
  return meta.scored_count != null && meta.photo_count != null && meta.scored_count < meta.photo_count;
}

function treeNextStepKindFromRow(row, access) {
  if (row.overall_score == null || treeShrubIsPartial(row)) return 'unclear';
  return laneOutcomeKind(null, access); // tree & shrub is never reservice-eligible — see handleTreeShrub
}

// GET /api/photo-id
router.get('/', async (req, res, next) => {
  try {
    const customerId = req.customer.id;
    const [pestRows, lawnRows, treeRows] = await Promise.all([
      db('pest_identifications').where({ customer_id: customerId, mode: 'customer' })
        .orderBy('created_at', 'desc').limit(20).select('id', 'created_at', 'report_contract', 'ai_analysis'),
      db('lawn_diagnostics').where({ customer_id: customerId, mode: 'customer' })
        .orderBy('created_at', 'desc').limit(20).select('id', 'created_at', 'report_contract'),
      db('tree_shrub_assessments').where({ customer_id: customerId, mode: 'customer' })
        .orderBy('created_at', 'desc').limit(20).select('id', 'created_at', 'overall_score', 'composite_scores'),
    ]);

    const access = await reserviceStreamlineAccess(customerId);
    const items = [
      ...pestRows.map((row) => ({
        id: row.id, type: 'pest', created_at: row.created_at, headline: pestHeadline(row),
        next_step_kind: pestNextStepKindFromRow(row, access),
      })),
      ...lawnRows.map((row) => ({
        id: row.id, type: 'lawn', created_at: row.created_at, headline: lawnHeadline(row),
        next_step_kind: lawnNextStepKindFromRow(row, access),
      })),
      ...treeRows.map((row) => ({
        id: row.id, type: 'tree_shrub', created_at: row.created_at, headline: 'Tree & shrub check',
        next_step_kind: treeNextStepKindFromRow(row, access),
      })),
    ];
    items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return res.status(200).json({ items: items.slice(0, 20) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/photo-id/:type/:id
router.get('/:type/:id', async (req, res, next) => {
  try {
    const { type, id } = req.params;
    const table = TYPE_TABLE[type];
    if (!table || !UUID_RE.test(String(id || ''))) return res.status(404).json({ error: 'Not found' });

    const row = await db(table).where({ id, customer_id: req.customer.id, mode: 'customer' }).first();
    if (!row) return res.status(404).json({ error: 'Not found' });

    const access = await reserviceStreamlineAccess(req.customer.id);

    if (type === 'pest') {
      const contract = parseJsonSafe(row.report_contract);
      const pestResult = pestPublicResult(contract);
      const idLabel = publicIdentificationLabel(contract);
      const partial = !!parseJsonSafe(row.ai_analysis).partial;
      const kind = pestNextStepKind(pestResult, idLabel, pestReserviceLane(contract), access, partial);
      const nextStep = buildNextStep(kind, {
        url: kind === 'reservice' && access ? `/reservice/${access.token}` : undefined,
        prefill: prefillFor('pest', { location: row.location, note: row.note }),
      });
      return res.status(200).json({
        id: row.id, type: 'pest', created_at: row.created_at, result: pestResult, next_step: nextStep,
      });
    }

    if (type === 'lawn') {
      const contract = parseJsonSafe(row.report_contract);
      const lawnResult = contract.result || lawnPublicResult({});
      const kind = lawnNextStepKindFromRow(row, access);
      const nextStep = buildNextStep(kind, {
        url: kind === 'reservice' && access ? `/reservice/${access.token}` : undefined,
        prefill: prefillFor('lawn', { location: row.location, note: row.note }),
      });
      return res.status(200).json({
        id: row.id, type: 'lawn', created_at: row.created_at, result: lawnResult, next_step: nextStep,
      });
    }

    // tree_shrub
    const treeResult = buildCustomerTreeShrubReport({
      scores: formatAssessmentScores(row),
      observations: row.observations,
      aiSummary: row.ai_summary,
      plantGroups: [],
    });
    const kind = treeNextStepKindFromRow(row, access);
    const nextStep = buildNextStep(kind, {
      url: kind === 'reservice' && access ? `/reservice/${access.token}` : undefined,
      prefill: prefillFor('tree_shrub', { location: row.location, note: row.note }),
    });
    return res.status(200).json({
      id: row.id, type: 'tree_shrub', created_at: row.created_at, result: treeResult, next_step: nextStep,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
