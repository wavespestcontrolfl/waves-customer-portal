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
  analyzePhoto: analyzeTreeShrubPhoto,
  mergePhotoComposites: mergeTreeShrubComposites,
  toCategoryScores,
  calculateOverall,
  buildTreeShrubTechFindings,
  buildCustomerTreeShrubReport,
  formatAssessmentScores,
} = require('../services/tree-shrub-assessment');
const { storeFunnelPhotos, storeTreeShrubCustomerPhotos } = require('../utils/funnel-photos');
const { reserviceStreamlineAccess } = require('../services/reservice-link');
const { resolveSessionScope, applyPropertyPredicate, isSecondarySelection } = require('../services/account-properties');
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
// same MECHANISM (express-rate-limit, skip-outside-prod, a shared-bucket
// keyGenerator) as index.js's photoAssessmentDailyLimiter for the public
// funnels, but deliberately a SEPARATE budget/store (AGENTS.md "extend the
// existing mechanism" — documented here per that rule's own escape hatch,
// codex GH r1 P1): photoAssessmentDailyLimiter's cap is sized for
// anonymous, unauthenticated MARKETING lead-magnet spend (public/
// lawn-assessment, public/pest-identifier) — a spend class the business
// treats as ad budget. This route is a value-add for EXISTING signed-in
// customers; folding it into the same 40/day marketing bucket would let a
// slow lead-magnet day 429 real customers using their own feature, and a
// busy customer day would silently starve the public funnels' ad spend.
// Same mechanism, same posture, independently sized/tuned budget.
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
// `isSecondary` (codex GH r2 P1) forces 'request' even for a covered lane —
// see resolvePropertyScope's comment for why.
function laneOutcomeKind(lane, access, isSecondary) {
  if (isSecondary) return 'request';
  return (lane && access && Array.isArray(access.lanes) && access.lanes.includes(lane)) ? 'reservice' : 'request';
}

function prefillFor(type, { location, note } = {}) {
  return { category: REQUEST_CATEGORY[type], location: location || null, note: note || null };
}

// codex GH r1 P1: honor the customer's selected saved property (portal
// multi-property model, GATE_APP_PROPERTY_SCOPE) the same way every other
// property-aware read does — resolveSessionScope / applyPropertyPredicate
// are the ONE rule (services/account-properties.js). Gate off, or a
// single-home customer: resolves to the unscoped default (today's
// customer-wide behavior).
//
// A lookup FAILURE is different from those two cases (codex GH r11 P1): the
// non-strict default below still degrades to unscoped for a READ (GET /,
// GET /:type/:id) — those only widen or narrow which rows a query matches,
// and the ownership check (customer_id) is a separate, unaffected guard, so
// the worst case is a temporarily broader read, never a cross-customer leak.
// A WRITE is not safe to degrade the same way: silently treating a failed
// lookup as "unscoped" on POST would persist property_id=null, load the
// PRIMARY property's grass context, and offer its re-service link — for a
// submission that may actually be for a secondary property. That
// misattribution is stored and outlives the transient lookup failure. The
// POST dispatcher below passes `{ strict: true }` so a lookup failure there
// propagates instead of resolving to a silent (and wrong) default.
// `isSecondary` (codex GH r2 P1): reserviceStreamlineAccess checks ACCOUNT-
// WIDE coverage, not the selected property's — it has no property parameter
// anywhere in the codebase today (same repo-wide gap as loadCustomerGrassContext,
// out of this PR's blast radius to extend). A submission scoped to a
// SECONDARY property must not still resolve to 'reservice': the token-only
// link (`/reservice/:token`) always opens the account's on-file (primary)
// address, so "Your plan covers this" pointing a secondary-property
// customer at the wrong address is actively misleading. `isSecondarySelection`
// (the same helper the self-serve re-service picker itself already guards
// with) is the one existing signal that's safe to act on without extending
// either shared service — it costs nothing extra since scope is already
// resolved.
async function resolvePropertyScope(req, { strict = false } = {}) {
  try {
    const scope = await resolveSessionScope(req);
    return { ...scope, isSecondary: isSecondarySelection(scope) };
  } catch (err) {
    logger.warn(`[photo-id] property scope resolution failed: ${err.message}`);
    if (strict) throw err;
    return {
      customerId: req.customerId, enabled: false, multi: false, scoped: false, closed: false, property: null, isSecondary: false,
    };
  }
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

// codex GH r1 P1: when any submitted photo failed to contribute (`partial`),
// the response must not still carry the successfully-scored subset's
// confident/reassuring content (a benign label, `not_a_pest: true`, a
// recommendation) alongside the `unclear` next_step — the two would
// contradict each other. This neutral, allowlisted placeholder replaces the
// whole result whenever partial is true, in the POST response AND on every
// later GET read of the same row (partial is persisted).
const PEST_PARTIAL_RESULT = {
  label: null,
  hedged: true,
  confidence: 'low',
  category: 'other',
  not_a_pest: false,
  urgency: 'low',
  safety: {
    stinging: false, venomous: false, disease_vector: false, structural_threat: false,
  },
  about: "We couldn't get a clear enough read from all of your photos to say anything for certain.",
  recommendation: null,
};

function pestResultForResponse(pestResult, partial) {
  return partial ? PEST_PARTIAL_RESULT : pestResult;
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
function pestNextStepKind(result, idLabel, lane, access, partial, isSecondary) {
  if (result.recommendation && result.recommendation.inspection_required) return 'inspection';
  if (partial) return 'unclear';
  if (idLabel.hedged && idLabel.specificity === 'generic') return 'unclear';
  // codex GH r1 P1: a MODERATE-confidence not_a_pest call is hedged ("Likely
  // a Lovebug") but still NAMED (specificity 'named'), so the generic-only
  // guard above never catches it — only an unhedged, high-confidence call
  // may read as the reassuring 'none'.
  if (result.not_a_pest) return idLabel.hedged ? 'unclear' : 'none';
  return laneOutcomeKind(lane, access, isSecondary);
}

function pestReserviceLane(contract) {
  const line = contract?.service?.line;
  return line === 'pest' || line === 'lawn' ? line : null;
}

async function handlePest(req, res, { note, location, propertyId, isSecondary }) {
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
    property_id: propertyId,
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
  const kind = pestNextStepKind(pestResult, idLabel, pestReserviceLane(contract), access, partial, isSecondary);
  const nextStep = buildNextStep(kind, {
    url: kind === 'reservice' && access ? `/reservice/${access.token}` : undefined,
    prefill: prefillFor('pest', { location, note }),
  });

  return res.status(200).json({
    id: row.id, type: 'pest', created_at: row.created_at, result: pestResultForResponse(pestResult, partial), next_step: nextStep,
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

// codex GH r4 P1: a composite object existing (analyzePhoto resolved
// non-null) is not the same as it carrying any usable evidence — an empty
// {} still passes a truthy check. Counts as evidence when at least one
// score or signal field the merge actually reads is present.
const LAWN_EVIDENCE_FIELDS = [
  'turf_density', 'weed_coverage', 'color_health',
  'fungal_activity', 'insect_damage', 'mechanical_damage', 'drought_stress', 'thatch_visibility',
];

// codex GH r6 P1: lawn-assessment.js's OWN averageScores (the dual-model
// merge lawnAssessment.analyzePhoto already ran before this route ever sees
// a composite) fills a MISSING numeric field with `Number(undefined) || 0`
// — a real, non-null zero — and leaves the categorical fields at their
// FUNGAL_MAP default. So a composite from two vacuous (but non-throwing)
// model responses is NEVER actually empty by the time it reaches this
// route; checking the merged composite for evidence can't tell "genuinely
// measured" from "defaulted from nothing" — it has to check the RAW
// per-model output (analyzePhoto's own `claude/gemini`, before ITS merge
// applies those defaults) instead.
function lawnRawResultHasEvidence(raw) {
  if (!raw) return false;
  return LAWN_EVIDENCE_FIELDS.some((key) => raw[key] != null && raw[key] !== '');
}

// codex GH r7+r8 P1: the "any evidence" check above is right for the
// TOTAL-FAILURE 503 decision, but the 3 numeric SCORE fields customers see
// (turf_density/weed_coverage/color_health) have their OWN independent
// defaults inside averageScores — a MISSING field from EITHER model
// defaults to a real 0 (turf/weed) or 5 (color) before the two sides are
// averaged. That corrupts more than the "neither model reported it" case
// (r7): if only ONE model reports a real value (say Claude: turf_density 80)
// and the other omits the field, averageScores still averages 80 against a
// synthetic 0 and publishes 40 — a genuinely measured 80 diluted by nothing,
// not caught by nulling only the "neither has it" case. The fix recomputes
// each of the 3 fields directly from RAW claude/gemini instead of trusting
// the composite's own value at all: both models reported it → average
// (matching averageScores' own rounding); only one did → use that value
// as-is (no synthetic partner); neither did → null (mergeLawnComposites'
// numericValues() already correctly drops nulls before its own average).
const LAWN_SCORE_FIELD_ROUNDING = {
  turf_density: (v) => Math.round(v),
  weed_coverage: (v) => Math.round(v),
  color_health: (v) => Math.round(v * 10) / 10, // 1-10 scale, 1 decimal — matches averageScores' own color_health rounding
};

function lawnRawNumericValue(raw, key) {
  if (!raw || raw[key] == null || raw[key] === '') return null;
  const n = Number(raw[key]);
  return Number.isFinite(n) ? n : null;
}

function lawnRecomputeScoreField(claude, gemini, key) {
  const c = lawnRawNumericValue(claude, key);
  const g = lawnRawNumericValue(gemini, key);
  if (c != null && g != null) return LAWN_SCORE_FIELD_ROUNDING[key]((c + g) / 2);
  if (c != null) return c;
  if (g != null) return g;
  return null;
}

// codex GH r9 P1: the SAME dilution/false-baseline bug the numeric fields
// had also applies to the 4 categorical severity fields — fungal_activity /
// insect_damage / mechanical_damage default a MISSING side to rank 0
// ('none') before averaging (`FUNGAL_MAP[claudeResult[f]] ?? 0`), and
// thatch_visibility does the same via THATCH_MAP. A genuinely unassessed
// signal was therefore always published as a confident "none"/"low" reading
// instead of being omitted. (drought_stress already filters missing values
// correctly inside lawn-assessment.js itself — no fix needed there.)
function lawnRawCategoricalValue(raw, key, rankMap) {
  if (!raw || raw[key] == null || raw[key] === '') return null;
  return rankMap[raw[key]] != null ? raw[key] : null;
}

function lawnRecomputeCategoricalField(claude, gemini, key, rankMap, orderList) {
  const c = lawnRawCategoricalValue(claude, key, rankMap);
  const g = lawnRawCategoricalValue(gemini, key, rankMap);
  if (c != null && g != null) return orderList[Math.round((rankMap[c] + rankMap[g]) / 2)];
  if (c != null) return c;
  if (g != null) return g;
  return null;
}

function lawnSanitizeScoreFields(analysis) {
  const { claude, gemini, composite } = analysis;
  if (!composite) return null;
  const sanitized = { ...composite };
  for (const key of ['turf_density', 'weed_coverage', 'color_health']) {
    sanitized[key] = lawnRecomputeScoreField(claude, gemini, key);
  }
  sanitized.fungal_activity = lawnRecomputeCategoricalField(claude, gemini, 'fungal_activity', LAWN_SEVERITY_RANK, LAWN_SEVERITY_ORDER);
  sanitized.insect_damage = lawnRecomputeCategoricalField(claude, gemini, 'insect_damage', LAWN_SEVERITY_RANK, LAWN_SEVERITY_ORDER);
  sanitized.mechanical_damage = lawnRecomputeCategoricalField(claude, gemini, 'mechanical_damage', LAWN_SEVERITY_RANK, LAWN_SEVERITY_ORDER);
  sanitized.thatch_visibility = lawnRecomputeCategoricalField(claude, gemini, 'thatch_visibility', THATCH_RANK, THATCH_ORDER);
  return sanitized;
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

// Baseline (unflagged) reading per signal key — everything else is worth
// mentioning to the customer.
const LAWN_SIGNAL_BASELINE = {
  fungal_activity: 'none', insect_damage: 'none', mechanical_damage: 'none', drought_stress: 'none', thatch_visibility: 'low',
};

// Deterministic, allowlisted customer copy built ONLY from the closed
// none/minor/moderate/severe (low/moderate/high for thatch) vocabulary —
// NEVER the raw model `observations` prose (codex r6 P1: analyzePhoto's
// observations field is free-text vision output that can name a specific
// disease/insect or overclaim, the same "never raw model text" rule
// pest-identification.js's PEST_LIBRARY exists to enforce). This mirrors
// tree-shrub-assessment.js's buildTreeShrubTechFindings aiSummary — a
// template sentence, never a paraphrase of what the model said.
function lawnDeterministicObservations(signals) {
  const flagged = signals.filter((s) => s.level !== LAWN_SIGNAL_BASELINE[s.key]);
  if (!flagged.length) return 'No urgent lawn issues spotted in these photos.';
  return `These photos show ${flagged.map((s) => s.label.toLowerCase()).join(', ')} worth a closer look.`;
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
    observations: lawnDeterministicObservations(signals),
  };
}

// codex GH r1 P1 — same partial-suppression rule as pest: a failed photo
// must not leave the successful subset's (possibly all-healthy) scores and
// "No urgent lawn issues" copy standing next to the `unclear` next_step.
const LAWN_PARTIAL_RESULT = {
  grass_type: null,
  scores: { turf_density: null, weed_coverage: null, color_health: null },
  signals: [],
  overwatering_signal: false,
  observations: "We couldn't analyze every photo you sent — send these to our team and we'll take a personal look.",
};

function lawnResultForResponse(lawnResult, partial) {
  return partial ? LAWN_PARTIAL_RESULT : lawnResult;
}

async function handleLawn(req, res, { note, location, propertyId, isSecondary }) {
  const photoInputs = req._photoInputs;
  // codex GH r10 P1: loadCustomerGrassContext is account-wide by design —
  // customer_turf_profiles is a 1:1-with-customer table with no property_id
  // column anywhere in the schema (checked: 20260430000007_customer_turf_profiles.js
  // and every later alter of that table), so there is no per-property grass
  // context to load even in principle; adding one would be new schema/plan-
  // engine machinery far outside this route's scope (rule 16). For a
  // secondary-property submission, buildVisionPrompt's "confirm against the
  // blades; only override if the morphology clearly differs" instruction
  // means the model defers to whatever's on file — which is the CUSTOMER's
  // primary-property turf profile, not this property's. Passing empty
  // context for a secondary property (the finding's own suggested fix)
  // makes the model call the grass type from the photo alone instead of
  // anchoring on another property's data.
  const grassContext = isSecondary ? null : await loadCustomerGrassContext(req.customer.id).catch(() => null);
  const context = grassContext
    ? { grassType: grassContext.grassTypeLabel || undefined, irrigation: grassContext.irrigationSystem || undefined }
    : {};

  const analyses = await Promise.all(photoInputs.map((photo) => lawnAssessment
    .analyzePhoto(photo.data, photo.mimeType, context)
    .catch((err) => { logger.warn(`[photo-id] lawn analyzePhoto failed: ${err.message}`); return null; })));
  // codex GH r4+r6 P1: a composite object existing is not the same as it
  // carrying any usable evidence — analyzePhoto's OWN merge defaults a
  // missing numeric field to a real 0 and a missing categorical field to
  // its baseline, so even the POST-merge composite is never actually empty.
  // Check the RAW per-model output (before that merge's defaults apply)
  // instead — see lawnRawResultHasEvidence.
  const withEvidence = analyses.filter((a) => a && (lawnRawResultHasEvidence(a.claude) || lawnRawResultHasEvidence(a.gemini)));
  const composites = withEvidence.map(lawnSanitizeScoreFields).filter(Boolean);
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
    property_id: propertyId,
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
  const lawnUnreliable = noUsableScores || partial;
  const access = await reserviceStreamlineAccess(req.customer.id);
  const kind = lawnUnreliable ? 'unclear' : laneOutcomeKind('lawn', access, isSecondary);
  const nextStep = buildNextStep(kind, {
    url: kind === 'reservice' && access ? `/reservice/${access.token}` : undefined,
    prefill: prefillFor('lawn', { location, note }),
  });

  return res.status(200).json({
    id: row.id, type: 'lawn', created_at: row.created_at, result: lawnResultForResponse(lawnResult, lawnUnreliable), next_step: nextStep,
  });
}

// codex GH r1 P1 — same partial/unreliable suppression as pest and lawn.
const TREE_PARTIAL_RESULT = {
  plant_groups: [],
  scores: { foliage_fullness: null, leaf_color_vigor: null, overall: null },
  signals: [],
  summary: "We couldn't get a reliable read from these photos — send them to our team and we'll take a personal look.",
};

function treeResultForResponse(treeResult, unreliable) {
  return unreliable ? TREE_PARTIAL_RESULT : treeResult;
}

// ── Tree & shrub ─────────────────────────────────────────────────────────

// codex GH r5 P1: previewTreeShrubAssessment's OWN scoredCount counts any
// non-null composite — an empty {} composite is truthy, so a mixed batch
// (one real photo + one that returned nothing) merged a confident result
// off the single working photo alone with scoredCount == photoCount
// (nothing flagged as partial). Same evidence-first fix as lawn's
// lawnCompositeHasEvidence: a composite counts only when it carries at
// least one field mergePhotoComposites actually reads.
const TREE_SHRUB_EVIDENCE_FIELDS = ['foliage_fullness', 'leaf_color_vigor', 'pest_signals', 'disease_signals', 'water_heat_stress', 'pruning_mechanical'];

// codex GH r6 P1: tree-shrub-assessment.js's OWN averageScores (analyzePhoto's
// dual-model merge, already run before this route ever sees a composite)
// defaults EVERY missing severity field to 'none' — even when BOTH claude
// and gemini came back empty — via `SEVERITY_REVERSE[cHas ? ci : (gHas ? gi
// : 0)]`, where the final `: 0` fires with no real evidence at all. The
// merged composite is therefore never actually empty; the RAW per-model
// output (before that merge's defaults apply) is the only place a genuinely
// vacuous response is still detectable.
function treeShrubRawHasEvidence(raw) {
  if (!raw) return false;
  return TREE_SHRUB_EVIDENCE_FIELDS.some((key) => raw[key] != null && raw[key] !== '');
}

// Reimplements previewTreeShrubAssessment's own orchestration (analyze each
// photo, merge, score) using the SAME exported building blocks
// (analyzePhoto / mergePhotoComposites / toCategoryScores / calculateOverall
// / buildTreeShrubTechFindings) rather than calling that helper directly —
// it has no hook to filter a composite for evidence before merging, and
// evidence-filtering is exactly the fix this needs.
// codex GH r9 P1: tree-shrub-assessment.js's averageScores already uses the
// SOLE reported value when only one model has a severity field (no dilution
// bug there, unlike lawn) — but when NEITHER model reports it, it still
// defaults to 'none' (`SEVERITY_REVERSE[cHas ? ci : (gHas ? gi : 0)]`, the
// `: 0` firing with zero evidence), and toCategoryScores/mergePhotoComposites
// (shared, not touched) always coerce a missing field the same way, so
// there is no way to represent "never assessed" through those functions'
// own vocabulary. This checks the RAW evidence directly, across every
// evidence-bearing photo, and nulls the SCORE (not the raw field) for a
// dimension neither model ever reported on any photo — buildCustomerTreeShrubReport
// already renders a null score as the neutral 'tracking' status via
// buildTreeShrubVisualCategories' own existing null-handling.
function treeShrubFieldEverReported(analyses, key) {
  return analyses.some((a) => a && (
    (a.claude && a.claude[key] != null && a.claude[key] !== '')
    || (a.gemini && a.gemini[key] != null && a.gemini[key] !== '')
  ));
}

async function previewTreeShrubWithEvidence(photoInputs) {
  const analyses = await Promise.all(photoInputs.map((photo) => analyzeTreeShrubPhoto(photo.data, photo.mimeType)
    .catch((err) => { logger.warn(`[photo-id] tree-shrub analyzePhoto failed: ${err.message}`); return null; })));
  const withEvidence = analyses.filter((a) => a && (treeShrubRawHasEvidence(a.claude) || treeShrubRawHasEvidence(a.gemini)));
  const composites = withEvidence.map((a) => a.composite).filter(Boolean);
  if (!composites.length) return null;
  const mergedRaw = mergeTreeShrubComposites(composites);
  const scores = toCategoryScores(mergedRaw);
  if (!treeShrubFieldEverReported(withEvidence, 'pest_signals')) scores.pestActivity = null;
  if (!treeShrubFieldEverReported(withEvidence, 'disease_signals')) scores.diseaseLeafSpot = null;
  if (!treeShrubFieldEverReported(withEvidence, 'water_heat_stress') && !treeShrubFieldEverReported(withEvidence, 'pruning_mechanical')) {
    scores.waterHeatStress = null;
  }
  scores.overallScore = calculateOverall(scores);
  return {
    scores,
    observations: mergedRaw.observations || '',
    scoredCount: composites.length,
    photoCount: photoInputs.length,
    ...buildTreeShrubTechFindings({ scores, observations: mergedRaw.observations }),
  };
}

async function handleTreeShrub(req, res, { note, location, propertyId, isSecondary }) {
  const photoInputs = req._photoInputs;
  const preview = await previewTreeShrubWithEvidence(photoInputs)
    .catch((err) => { logger.warn(`[photo-id] tree-shrub preview failed: ${err.message}`); return null; });

  if (!preview) {
    return res.status(503).json({ error: `Photo analysis is briefly unavailable. Please try again in a few minutes or call ${OFFICE_PHONE}.` });
  }

  const treeResult = buildCustomerTreeShrubReport(preview);
  // codex r3 P1: a photo that failed to score (scoredCount < photoCount)
  // must not let the successfully-scored subset present as a complete read.
  const partial = preview.scoredCount != null && preview.photoCount != null
    && preview.scoredCount < preview.photoCount;
  // codex GH r1 P1: toCategoryScores normalizes a MISSING severity field to
  // 'none' (the healthiest reading) rather than null, so a vision response
  // that's valid JSON but omits pest/disease/water-heat entirely still
  // produces three scores of 95 and a healthy-looking overallScore — the
  // `overall == null` check below can never catch this (those three fields
  // are never actually null). foliageFullness/leafColorVigor are the only
  // two fields toCategoryScores leaves genuinely null when absent (no
  // synthetic default exists for them), so both being null is the signal
  // that this response carried little to no real evidence.
  const synthesized = preview.scores?.foliageFullness == null && preview.scores?.leafColorVigor == null;
  const unreliable = partial || synthesized;

  const [row] = await db('tree_shrub_assessments').insert({
    customer_id: req.customer.id,
    property_id: propertyId,
    service_date: etDateString(),
    source: 'portal',
    mode: 'customer',
    composite_scores: JSON.stringify({
      ...(preview.scores || {}),
      scored_count: preview.scoredCount ?? null,
      photo_count: preview.photoCount ?? null,
      unreliable,
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
  const kind = (noUsableScores || unreliable) ? 'unclear' : laneOutcomeKind(null, access, isSecondary);
  const nextStep = buildNextStep(kind, {
    url: kind === 'reservice' && access ? `/reservice/${access.token}` : undefined,
    prefill: prefillFor('tree_shrub', { location, note }),
  });

  return res.status(200).json({
    id: row.id, type: 'tree_shrub', created_at: row.created_at, result: treeResultForResponse(treeResult, unreliable), next_step: nextStep,
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

    // codex GH r11 P1: strict — a resolution failure here must not silently
    // fall back to "unscoped" (see resolvePropertyScope's comment above for
    // why a write can't degrade the way a read safely can). Caught locally
    // for the same customer-safe copy + office phone pattern as the
    // closed-scope 409 just below, rather than falling through to a bare
    // next(err) 500.
    let scope;
    try {
      scope = await resolvePropertyScope(req, { strict: true });
    } catch (err) {
      logger.warn(`[photo-id] property scope resolution failed on submit: ${err.message}`);
      return res.status(503).json({ error: `We couldn't confirm which property this is for right now. Please try again in a few minutes or call our office at ${OFFICE_PHONE}.` });
    }
    // codex GH r4 P1: a closed scope (every saved property retired) has no
    // property to stamp — applyPropertyPredicate then matches NOTHING for
    // this customer (its own "closed" branch is whereNull('id'), never
    // true), so a row written here would be immediately, permanently
    // invisible to both history reads. Reject before spending the paid
    // vision call rather than silently burning it on a submission the
    // customer could never see again.
    if (scope.closed) {
      return res.status(409).json({ error: `We couldn't find an active property on your account. Please call our office at ${OFFICE_PHONE} and we'll get that fixed.` });
    }
    const propertyId = scope.scoped && scope.property ? scope.property.id : null;

    return await handler(req, res, {
      note, location, propertyId, isSecondary: scope.isSecondary,
    });
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

function pestNextStepKindFromRow(row, access, isSecondary) {
  const contract = parseJsonSafe(row.report_contract);
  const publicReport = buildPublicPestReport({ report_contract: JSON.stringify(contract) });
  const idLabel = publicIdentificationLabel(contract);
  const partial = !!parseJsonSafe(row.ai_analysis).partial;
  return pestNextStepKind(publicReport, idLabel, pestReserviceLane(contract), access, partial, isSecondary);
}

// codex GH r3 P1: an empty composite (analyzePhoto succeeded but returned no
// usable fields) counts as a SUCCESSFUL photo, so `partial` alone never
// catches it — noUsableScores must ALSO force the neutral result, not just
// the unclear next_step, on both POST and every later GET read.
function lawnRowIsUnreliable(row) {
  const contract = parseJsonSafe(row.report_contract);
  const scores = contract?.result?.scores || {};
  const noScores = scores.turf_density == null && scores.weed_coverage == null && scores.color_health == null;
  return noScores || !!contract.partial;
}

function lawnNextStepKindFromRow(row, access, isSecondary) {
  if (lawnRowIsUnreliable(row)) return 'unclear';
  return laneOutcomeKind('lawn', access, isSecondary);
}

// True for a partial photo batch OR a "synthesized" (little-to-no real
// evidence) read — see handleTreeShrub's `unreliable` computation, persisted
// here so a later GET reconstructs the exact same classification.
function treeShrubIsUnreliable(row) {
  const meta = parseJsonSafe(row.composite_scores);
  if (meta.unreliable === true) return true;
  return meta.scored_count != null && meta.photo_count != null && meta.scored_count < meta.photo_count;
}

function treeNextStepKindFromRow(row, access, isSecondary) {
  if (row.overall_score == null || treeShrubIsUnreliable(row)) return 'unclear';
  return laneOutcomeKind(null, access, isSecondary); // tree & shrub is never reservice-eligible — see handleTreeShrub
}

// GET /api/photo-id
router.get('/', async (req, res, next) => {
  try {
    const customerId = req.customer.id;
    const scope = await resolvePropertyScope(req);
    const pestQuery = db('pest_identifications').where({ customer_id: customerId, mode: 'customer' });
    const lawnQuery = db('lawn_diagnostics').where({ customer_id: customerId, mode: 'customer' });
    const treeQuery = db('tree_shrub_assessments').where({ customer_id: customerId, mode: 'customer' });
    applyPropertyPredicate(pestQuery, scope, 'pest_identifications');
    applyPropertyPredicate(lawnQuery, scope, 'lawn_diagnostics');
    applyPropertyPredicate(treeQuery, scope, 'tree_shrub_assessments');
    const [pestRows, lawnRows, treeRows] = await Promise.all([
      pestQuery.orderBy('created_at', 'desc').limit(20).select('id', 'created_at', 'report_contract', 'ai_analysis'),
      lawnQuery.orderBy('created_at', 'desc').limit(20).select('id', 'created_at', 'report_contract'),
      treeQuery.orderBy('created_at', 'desc').limit(20).select('id', 'created_at', 'overall_score', 'composite_scores'),
    ]);

    const access = await reserviceStreamlineAccess(customerId);
    const items = [
      ...pestRows.map((row) => ({
        id: row.id, type: 'pest', created_at: row.created_at, headline: pestHeadline(row),
        next_step_kind: pestNextStepKindFromRow(row, access, scope.isSecondary),
      })),
      ...lawnRows.map((row) => ({
        id: row.id, type: 'lawn', created_at: row.created_at, headline: lawnHeadline(row),
        next_step_kind: lawnNextStepKindFromRow(row, access, scope.isSecondary),
      })),
      ...treeRows.map((row) => ({
        id: row.id, type: 'tree_shrub', created_at: row.created_at, headline: 'Tree & shrub check',
        next_step_kind: treeNextStepKindFromRow(row, access, scope.isSecondary),
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

    const scope = await resolvePropertyScope(req);
    const rowQuery = db(table).where({ id, customer_id: req.customer.id, mode: 'customer' });
    applyPropertyPredicate(rowQuery, scope, table);
    const row = await rowQuery.first();
    if (!row) return res.status(404).json({ error: 'Not found' });

    const access = await reserviceStreamlineAccess(req.customer.id);

    if (type === 'pest') {
      const contract = parseJsonSafe(row.report_contract);
      const pestResult = pestPublicResult(contract);
      const idLabel = publicIdentificationLabel(contract);
      const partial = !!parseJsonSafe(row.ai_analysis).partial;
      const kind = pestNextStepKind(pestResult, idLabel, pestReserviceLane(contract), access, partial, scope.isSecondary);
      const nextStep = buildNextStep(kind, {
        url: kind === 'reservice' && access ? `/reservice/${access.token}` : undefined,
        prefill: prefillFor('pest', { location: row.location, note: row.note }),
      });
      return res.status(200).json({
        id: row.id, type: 'pest', created_at: row.created_at, result: pestResultForResponse(pestResult, partial), next_step: nextStep,
      });
    }

    if (type === 'lawn') {
      const contract = parseJsonSafe(row.report_contract);
      const lawnResult = contract.result || lawnPublicResult({});
      const lawnUnreliable = lawnRowIsUnreliable(row);
      const kind = lawnNextStepKindFromRow(row, access, scope.isSecondary);
      const nextStep = buildNextStep(kind, {
        url: kind === 'reservice' && access ? `/reservice/${access.token}` : undefined,
        prefill: prefillFor('lawn', { location: row.location, note: row.note }),
      });
      return res.status(200).json({
        id: row.id, type: 'lawn', created_at: row.created_at, result: lawnResultForResponse(lawnResult, lawnUnreliable), next_step: nextStep,
      });
    }

    // tree_shrub
    const treeResult = buildCustomerTreeShrubReport({
      scores: formatAssessmentScores(row),
      observations: row.observations,
      aiSummary: row.ai_summary,
      plantGroups: [],
    });
    const kind = treeNextStepKindFromRow(row, access, scope.isSecondary);
    const nextStep = buildNextStep(kind, {
      url: kind === 'reservice' && access ? `/reservice/${access.token}` : undefined,
      prefill: prefillFor('tree_shrub', { location: row.location, note: row.note }),
    });
    return res.status(200).json({
      id: row.id, type: 'tree_shrub', created_at: row.created_at, result: treeResultForResponse(treeResult, treeShrubIsUnreliable(row)), next_step: nextStep,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
