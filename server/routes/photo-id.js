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
const sharp = require('sharp');
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
const { customerPhotoViews } = require('../services/customer-photo-id-evidence');

const OFFICE_PHONE = '(941) 297-5749';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Case-insensitive (codex GH P2): request-photo-validation.js's
// DATA_URL_PREFIX_RE validates the "data:", "image/", and ";base64," literal
// segments case-insensitively too — this parser must accept exactly what
// validation already accepted, never a stricter subset of it, or a
// validator-approved photo (e.g. `data:IMAGE/jpeg;BASE64,...`) silently fails
// to parse here and is quietly dropped before `partial` is ever computed.
const DATA_URL_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/i;

const TYPE_TABLE = {
  pest: 'pest_identifications',
  lawn: 'lawn_diagnostics',
  tree_shrub: 'tree_shrub_assessments',
};

// codex GH r2 (cloud) P1: the prefill category must come from the RESOLVED
// re-service lane — the SAME value laneOutcomeKind/pestReserviceLane use for
// the coverage check — never the upload type. requests.js derives its own
// lane SOLELY from this category (`category === 'pest_issue' ? 'pest' :
// 'lawn'`, requests.js:499-509) to decide whether to intercept the ticket
// with "good news, covered by your plan" and point at the reservice picker.
// A static per-type category was wrong in two ways: a lawn-targeting pest
// (chinch bugs — resolved lane 'lawn') filed as 'pest_issue' would be
// checked against the WRONG lane's coverage, and every tree_shrub concern
// (never reservice-eligible — reservice-scheduler.js excludes it from both
// lanes) filed as 'lawn_concern' could get misrouted into "book your free
// lawn re-service" for a concern that was never a lawn issue at all.
//
// codex GH r3 (cloud) P1: that fix alone reopened a narrower version of the
// SAME class of bug — `kind` matters as much as `lane`. `request_prefill`
// only ever ships on 'inspection' | 'unclear' | 'request' (buildNextStep;
// 'reservice' carries a booking link instead, never a prefill). An
// 'unclear' or 'inspection' outcome explicitly promises "we'll take a
// personal look" / "we need to see this in person" — NOT the streamlined
// reservice flow — even when the identified pest/lawn issue's lane happens
// to be one the customer IS covered for (a hedged/low-confidence read, or a
// partial photo batch, can still resolve a real lane). Only a 'request' kind
// is safe to prefill with the lane-matched category: requests.js's own
// interception only fires when coverage EXISTS for that lane, and 'request'
// is reached specifically because either the lane is null/uncovered or the
// submission is scoped to a secondary property (which requests.js's own
// `!secondarySelection` guard already exempts from interception either way)
// — so a 'request'-kind prefill can never actually trigger it. 'unclear' and
// 'inspection' always resolve to 'other' instead, whatever the lane is,
// so a customer who follows through never hits a 409 that contradicts the
// promise we just made them.
function resolvePrefillCategory(lane, kind) {
  if (kind !== 'request') return 'other';
  if (lane === 'pest') return 'pest_issue';
  if (lane === 'lawn') return 'lawn_concern';
  return 'other';
}

// codex GH r2 (cloud) P1: validateRequestPhotos accepts HEIC/HEIF (real
// iPhone camera-roll formats) and the nonstandard "image/jpg", but every
// vision provider this route calls (Claude, Gemini) only accepts genuine
// JPEG/PNG/WebP — passing HEIC bytes through doesn't just mis-tag the photo,
// it makes the model call itself fail, AFTER the customer has already spent
// both rate-limit buckets on a photo that was perfectly valid on their end.
// Transcode to real JPEG with sharp — the same HEIC decoder the repo
// already relies on (admin-photo-assessments.js's message-photo path:
// `sharp(raw).rotate()....jpeg({quality}).toBuffer()`) — BEFORE any vision
// call or S3 storage. Every handler shares the same photoInputs array, so
// this runs once in the POST dispatcher rather than being duplicated per
// type.
const PHOTO_ID_JPEG_QUALITY = 88;
const NEEDS_TRANSCODE_MIME = new Set(['image/heic', 'image/heif', 'image/jpg']);

async function normalizePhotoInput(photo) {
  if (!NEEDS_TRANSCODE_MIME.has(String(photo.mimeType || '').toLowerCase())) return photo;
  const raw = Buffer.from(photo.data, 'base64');
  const jpegBuffer = await sharp(raw).rotate().jpeg({ quality: PHOTO_ID_JPEG_QUALITY }).toBuffer();
  return { mimeType: 'image/jpeg', data: jpegBuffer.toString('base64') };
}

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
  // Lowercase the captured MIME type (codex GH P2): every downstream
  // consumer — NEEDS_TRANSCODE_MIME's own Set lookup, the vision providers'
  // mimeType field, S3 content-type — expects the canonical lowercase form;
  // a validator-accepted `IMAGE/JPEG` must resolve to the SAME real-JPEG
  // path a lowercase `image/jpeg` does, not silently skip transcoding (or
  // reach a provider) under a casing that formally means the same thing.
  return { mimeType: match[1].toLowerCase(), data: match[2] };
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

// `lane` is the RESOLVED re-service lane ('pest' | 'lawn' | null); `kind` is
// the next_step kind this prefill ships under — see resolvePrefillCategory's
// comment above for why both matter, not just the lane.
function prefillFor(lane, kind, { location, note } = {}) {
  return { category: resolvePrefillCategory(lane, kind), location: location || null, note: note || null };
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
  const lane = pestReserviceLane(contract);
  const access = await reserviceStreamlineAccess(req.customer.id);
  const kind = pestNextStepKind(pestResult, idLabel, lane, access, partial, isSecondary);
  const nextStep = buildNextStep(kind, {
    url: kind === 'reservice' && access ? `/reservice/${access.token}` : undefined,
    prefill: prefillFor(lane, kind, { location, note }),
  });
  const { result: finalPestResult } = finalizeCustomerResult('pest', { complete: !partial, build: () => pestResult });

  return res.status(200).json({
    id: row.id, type: 'pest', created_at: row.created_at, result: finalPestResult, next_step: nextStep,
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

// codex GH P2: `overwatering_signal` is a top-level boolean the client's
// LawnResult never renders (it only maps `signals`) and
// lawnDeterministicObservations never read — a photo with a real, direct
// overwatering sign (standing water, algae, mushrooms) could still produce
// "No urgent lawn issues spotted in these photos." A dedicated label lets
// lawnPublicResult fold it into the SAME allowlisted `signals` vocabulary
// (never raw model text) the other five fields use, only when flagged —
// mirroring their own "baseline never appears, only a departure does" rule.
const LAWN_OVERWATERING_LABEL = 'Overwatering signs';

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

// codex GH r2 (cloud) P2: the vision prompt's contract advertises
// turf_density/weed_coverage as 0-100 and color_health as 1-10, but nothing
// downstream of the raw model output enforced those ranges before this fix
// — a JSON-valid but out-of-contract reply (140, -20, 30) passed the
// evidence check and was persisted + served to the customer verbatim.
// Clamp every recomputed value to its declared range as the LAST step,
// after rounding, so a single stray value can't read as a real measurement
// outside the scale the client renders it against.
const LAWN_SCORE_RANGE = { turf_density: [0, 100], weed_coverage: [0, 100], color_health: [1, 10] };

function clampToRange(value, [min, max]) {
  return value == null ? null : Math.min(max, Math.max(min, value));
}

function lawnRawNumericValue(raw, key) {
  if (!raw || raw[key] == null || raw[key] === '') return null;
  const n = Number(raw[key]);
  return Number.isFinite(n) ? n : null;
}

function lawnRecomputeScoreField(claude, gemini, key) {
  const c = lawnRawNumericValue(claude, key);
  const g = lawnRawNumericValue(gemini, key);
  const range = LAWN_SCORE_RANGE[key];
  if (c != null && g != null) return clampToRange(LAWN_SCORE_FIELD_ROUNDING[key]((c + g) / 2), range);
  if (c != null) return clampToRange(LAWN_SCORE_FIELD_ROUNDING[key](c), range);
  if (g != null) return clampToRange(LAWN_SCORE_FIELD_ROUNDING[key](g), range);
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
  // codex GH P2: only ADD a signal when the flag is actually set — a false
  // reading stays silent, exactly like the other five fields' baseline
  // values never appear either (LAWN_SIGNAL_BASELINE). Pushed after the
  // severity fields so lawnDeterministicObservations sees it as one more
  // flagged item, never a substitute for them.
  if (merged.overwatering_signal) {
    signals.push({ key: 'overwatering_signal', label: LAWN_OVERWATERING_LABEL, level: 'flagged' });
  }
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
  // codex GH P2: a truthy `scores` object of nulls still renders — the
  // client's `{result.scores && (...)}` gate only checks truthiness, so
  // {turf_density: null, ...} rendered as "null%". A partial/unassessed
  // result never had usable scores to show; omit the group entirely.
  scores: null,
  signals: [],
  overwatering_signal: false,
  observations: "We couldn't analyze every photo you sent — send these to our team and we'll take a personal look.",
};

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
  // codex GH r2 (cloud) P1: usable turf/color scores existing is not the
  // same as the lawn having been ASSESSED for disease/pest/damage —
  // lawnPublicResult only ever puts a key in `signals` when the merged
  // composite actually carries it, so zero signals means every severity
  // dimension was unassessed, not that all five came back clean. Feeding
  // that straight to lawnDeterministicObservations produced a confident
  // "No urgent lawn issues" for a submission that never checked for any.
  const signalsUnassessed = lawnResult.signals.length === 0;
  const { result: finalLawnResult, unclear: lawnUnclear } = finalizeCustomerResult('lawn', {
    complete: !partial && !noUsableScores && !signalsUnassessed,
    build: () => lawnResult,
  });
  const access = await reserviceStreamlineAccess(req.customer.id);
  const kind = lawnUnclear ? 'unclear' : laneOutcomeKind('lawn', access, isSecondary);
  const nextStep = buildNextStep(kind, {
    url: kind === 'reservice' && access ? `/reservice/${access.token}` : undefined,
    prefill: prefillFor('lawn', kind, { location, note }),
  });

  return res.status(200).json({
    id: row.id, type: 'lawn', created_at: row.created_at, result: finalLawnResult, next_step: nextStep,
  });
}

// codex GH r1 P1 — same partial/unreliable suppression as pest and lawn.
const TREE_PARTIAL_RESULT = {
  plant_groups: [],
  // codex GH P2: same truthy-object-of-nulls bug as LAWN_PARTIAL_RESULT —
  // the client's `{result.scores && (...)}` gate only checks truthiness.
  scores: null,
  signals: [],
  summary: "We couldn't get a reliable read from these photos — send them to our team and we'll take a personal look.",
};

// ── Structural egress guard ──────────────────────────────────────────────
// Rounds 1-12 local + 2 cloud reviews all found the SAME class of bug: an
// incomplete, synthesized, or unassessed analysis leaking reassuring
// customer-facing copy (a hedged ID read as confirmed, a healthy score off
// a partial photo batch, "no issues" when a whole category was never
// checked). Scattered per-field suppression kept missing the next case
// because each fix only closed the ONE symptom Codex had just found. ONE
// function per type now decides completeness ONCE — from the SAME
// evidence each handler already computes to decide `partial`/`unreliable`
// — and gates the WHOLE result through it: an incomplete verdict always
// returns the type's neutral placeholder (no signals, no scores, no
// summary text that could read as healthy) and the caller always forces
// `next_step` to 'unclear'; only a complete verdict runs the real report
// builder. Every caller — POST and every GET reconstruction, for all three
// types — goes through this one path, never a bespoke per-type helper.
const PARTIAL_RESULT = { pest: PEST_PARTIAL_RESULT, lawn: LAWN_PARTIAL_RESULT, tree_shrub: TREE_PARTIAL_RESULT };

function finalizeCustomerResult(type, { complete, build }) {
  if (!complete) return { result: PARTIAL_RESULT[type], unclear: true };
  return { result: build(), unclear: false };
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
  // codex GH r1 P1 (narrower predecessor of the r2-cloud fix below):
  // toCategoryScores normalizes a MISSING severity field to 'none' (the
  // healthiest reading) rather than null, so a vision response that's valid
  // JSON but omits pest/disease/water-heat entirely still produced three
  // scores of 95 and a healthy-looking overallScore.
  //
  // codex GH r2 (cloud) P1: nulling those three scores (previewTreeShrubWithEvidence,
  // above) stopped the false-healthy NUMBER, but buildTreeShrubTechFindings'
  // own aiSummary still said "No urgent visible plant issues found" for a
  // 'tracking' (never-assessed) category, because tracking isn't a
  // "finding" either — fixed at the source in tree-shrub-assessment.js, but
  // the ROUTE also needs to know a tracking category happened at all, to
  // suppress the whole result and force `unclear`, the same way `partial`
  // does. `preview.trackingCount` (buildTreeShrubTechFindings' own tally of
  // buildTreeShrubVisualCategories' 5 categories) already answers this for
  // ALL five dimensions in one place — the two numeric fields (the r1 fix's
  // narrower case) AND any of the three severity fields nulled above.
  const anyTracking = (preview.trackingCount || 0) > 0;
  const unreliable = partial || anyTracking;

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
    prefill: prefillFor(null, kind, { location, note }),
  });
  const { result: finalTreeResult } = finalizeCustomerResult('tree_shrub', {
    complete: !noUsableScores && !unreliable,
    build: () => treeResult,
  });

  return res.status(200).json({
    id: row.id, type: 'tree_shrub', created_at: row.created_at, result: finalTreeResult, next_step: nextStep,
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

    const rawPhotoInputs = validated.photos.map(splitDataUrl).filter(Boolean);
    if (!rawPhotoInputs.length) return res.status(400).json({ error: 'Photos could not be read.' });
    // codex GH P2: DATA_URL_RE must accept exactly what validateRequestPhotos
    // already accepted (same casing rules), so this filter should never
    // actually drop anything — but if it ever silently parses fewer photos
    // than were validated, fail the WHOLE request rather than quietly
    // analyzing a smaller batch: `partial` is computed from `photoInputs`
    // alone, so a dropped-here photo would never be counted as missing, and
    // a confident result could be built off strictly fewer photos than the
    // customer actually sent.
    if (rawPhotoInputs.length !== validated.photos.length) {
      logger.error(`[photo-id] parsed ${rawPhotoInputs.length} of ${validated.photos.length} validated photos — DATA_URL_RE/validator casing mismatch`);
      return res.status(400).json({ error: 'One of your photos could not be read. Try again.' });
    }

    // codex GH r2 (cloud) P1: transcode HEIC/HEIF/nonstandard-jpg to real
    // JPEG BEFORE any vision call or S3 storage — see normalizePhotoInput's
    // comment. Every handler shares req._photoInputs, so this runs once here
    // rather than being duplicated per type.
    let photoInputs;
    try {
      photoInputs = await Promise.all(rawPhotoInputs.map(normalizePhotoInput));
    } catch (err) {
      logger.warn(`[photo-id] photo transcode failed: ${err.message}`);
      return res.status(400).json({ error: 'One of your photos could not be processed. Try a different photo.' });
    }
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
  const signals = contract?.result?.signals || [];
  const noScores = scores.turf_density == null && scores.weed_coverage == null && scores.color_health == null;
  // codex GH r2 (cloud) P1 — same "zero signals means unassessed, not
  // clean" rule as handleLawn's own POST-time check, read back from the
  // persisted result so a GET reconstructs the identical verdict.
  const signalsUnassessed = signals.length === 0;
  return noScores || signalsUnassessed || !!contract.partial;
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

    const scope = await resolvePropertyScope(req, { strict: true });
    const rowQuery = db(table).where({ id, customer_id: req.customer.id, mode: 'customer' });
    applyPropertyPredicate(rowQuery, scope, table);
    const row = await rowQuery.first();
    if (!row) return res.status(404).json({ error: 'Not found' });

    res.set('Cache-Control', 'private, no-store');
    const photos = await customerPhotoViews(type, row.id);
    const access = await reserviceStreamlineAccess(req.customer.id);

    if (type === 'pest') {
      const contract = parseJsonSafe(row.report_contract);
      const pestResult = pestPublicResult(contract);
      const idLabel = publicIdentificationLabel(contract);
      const partial = !!parseJsonSafe(row.ai_analysis).partial;
      const lane = pestReserviceLane(contract);
      const kind = pestNextStepKind(pestResult, idLabel, lane, access, partial, scope.isSecondary);
      const nextStep = buildNextStep(kind, {
        url: kind === 'reservice' && access ? `/reservice/${access.token}` : undefined,
        prefill: prefillFor(lane, kind, { location: row.location, note: row.note }),
      });
      const { result: finalPestResult } = finalizeCustomerResult('pest', { complete: !partial, build: () => pestResult });
      return res.status(200).json({
        id: row.id, type: 'pest', created_at: row.created_at, result: finalPestResult, next_step: nextStep, photos,
      });
    }

    if (type === 'lawn') {
      const contract = parseJsonSafe(row.report_contract);
      const lawnResult = contract.result || lawnPublicResult({});
      const lawnUnreliable = lawnRowIsUnreliable(row);
      const kind = lawnNextStepKindFromRow(row, access, scope.isSecondary);
      const nextStep = buildNextStep(kind, {
        url: kind === 'reservice' && access ? `/reservice/${access.token}` : undefined,
        prefill: prefillFor('lawn', kind, { location: row.location, note: row.note }),
      });
      const { result: finalLawnResult } = finalizeCustomerResult('lawn', { complete: !lawnUnreliable, build: () => lawnResult });
      return res.status(200).json({
        id: row.id, type: 'lawn', created_at: row.created_at, result: finalLawnResult, next_step: nextStep, photos,
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
      prefill: prefillFor(null, kind, { location: row.location, note: row.note }),
    });
    const { result: finalTreeResult } = finalizeCustomerResult('tree_shrub', {
      complete: !treeShrubIsUnreliable(row),
      build: () => treeResult,
    });
    return res.status(200).json({
      id: row.id, type: 'tree_shrub', created_at: row.created_at, result: finalTreeResult, next_step: nextStep, photos,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
