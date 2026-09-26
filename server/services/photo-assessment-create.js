/**
 * Admin photo assessments — the per-type config (TYPES: lawn assessment,
 * pest identification, tree & shrub assessment; its tables, list/detail
 * shaping, and analysis) and the create path, as a service so it runs
 * without an HTTP request. TYPES lives here, beside the one insert that
 * reads it (the lead-writer registry validates its table literals in this
 * file). One implementation, two callers of the create path — the admin
 * route (POST /api/admin/photo-assessments/:type, source 'admin'), which
 * also reads TYPES/configFor for its list/detail/report routes, and the
 * inbound photo-text triage (services/photo-text-triage.js, source
 * 'auto_triage'; lawn, pest, and tree_shrub).
 *
 * createAdminAssessment({ type, source, photos, message_photos, lead_id,
 * customer_id, contact, address, note }) resolves the photos (base64 uploads
 * and/or stored inbound MMS media), resolves the lead/customer associations,
 * runs the SAME analysis ladder the public funnel runs, inserts the
 * prospect-mode row, and stores its photos. It returns
 * { id, type, analysis } on success or { error, status } on a refusal —
 * never a partial row.
 */

const sharp = require('sharp');

const db = require('../models/db');
const logger = require('./logger');
const { parseStoredMedia, isSignableStoredMediaKey } = require('./sms-media');
const lawnAssessment = require('./lawn-assessment');
const {
  buildDiagnosticReportContract,
  classifyReleaseMode,
  applyAutoReleaseRepair,
} = require('./lawn-diagnostic-report');
const {
  runFindingsLadder,
  applyWriterSummary,
  deriveOverallScore,
} = require('./lawn-diagnostic-analyze');
const {
  identifyPest,
  buildPestReportContract,
  buildPublicPestReport,
  publicIdentificationLabel,
  PEST_LIBRARY,
} = require('./pest-identification');
const {
  analyzePhoto,
  isCompleteVisionResult,
  mergePhotoComposites,
  toCategoryScores,
  calculateOverall,
  buildTreeShrubTechFindings,
} = require('./tree-shrub-assessment');
const { buildTreeShrubVisualCategories } = require('./service-report/tree-shrub-visual-categories');
const { buildPublicLawnReport } = require('../routes/public-lawn-diagnostic');
const { overallStatusLabel } = require('../utils/public-report-egress');
const { storeFunnelPhotos } = require('../utils/funnel-photos');
const { etParts } = require('../utils/datetime-et');

let PhotoService;
try { PhotoService = require('./photos'); } catch { PhotoService = null; }

const MAX_PHOTOS = 5;
const MAX_PHOTO_CHARS = 6_000_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIBRARY_BY_SLUG = new Map(PEST_LIBRARY.map((e) => [e.slug, e]));
// Category key → customer-safe label ("Pest Activity Signals", never
// "infestation"), taken from the same five-category builder the tree & shrub
// visit report uses so the admin list and the report never name a signal
// differently.
const TREE_SHRUB_SIGNAL_LABELS = Object.fromEntries(
  buildTreeShrubVisualCategories({}).map((category) => [category.key, category.label]),
);

// Inbound MMS photos pulled into an assessment: resized to this max
// dimension and re-encoded as JPEG so every downstream consumer (vision
// ladder, funnel photo storage) sees the same shape normalizePhotos always
// produced — no separate code path for an SMS-sourced photo.
const MESSAGE_PHOTO_MAX_PX = 1600;
const MESSAGE_PHOTO_JPEG_QUALITY = 82;
const MESSAGE_PHOTO_ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function cleanString(value, max = 200) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

// Resolves one { message_id, key } request-photo entry into a
// normalizePhotos-shaped { data, mimeType } photo, or an { error, status }
// describing why it was refused. The key must belong to THIS message's own
// stored inbound media AND pass isSignableStoredMediaKey — the guard against
// an admin (or a compromised admin session) reading an arbitrary S3 object
// by key.
async function loadMessagePhoto(entry) {
  const messageId = cleanString(entry?.message_id, 64);
  const key = typeof entry?.key === 'string' ? entry.key : null;
  if (!messageId || !UUID_RE.test(messageId) || !key) {
    return { error: 'Each message_photos entry needs a valid message_id and key', status: 400 };
  }

  const message = await db('messages').where({ id: messageId }).first();
  if (!message) return { error: `Message ${messageId} not found`, status: 404 };
  if (message.direction !== 'inbound') {
    return { error: `Message ${messageId} is not an inbound message`, status: 400 };
  }

  const storedMedia = parseStoredMedia(message.media);
  const mediaItem = storedMedia.find((item) => item && item.key === key);
  if (!mediaItem || !isSignableStoredMediaKey(key)) {
    return { error: `Photo key is not available on message ${messageId}`, status: 400 };
  }

  const declaredMime = cleanString(mediaItem.contentType || mediaItem.mimeType, 80);
  if (!declaredMime || !MESSAGE_PHOTO_ALLOWED_MIME.has(declaredMime.toLowerCase())) {
    return { error: `Unsupported photo type on message ${messageId}`, status: 400 };
  }

  if (!PhotoService) {
    logger.error(`[admin-photo-assessments] photo storage service unavailable for ${key}`);
    return { error: 'Could not fetch the photo from storage — try again in a moment.', status: 502 };
  }
  let raw;
  try {
    ({ buffer: raw } = await PhotoService.getPhotoBuffer(key));
  } catch (err) {
    logger.error(`[admin-photo-assessments] S3 fetch failed for ${key}: ${err.message}`);
    return { error: 'Could not fetch the photo from storage — try again in a moment.', status: 502 };
  }

  let jpegBuffer;
  try {
    jpegBuffer = await sharp(raw)
      .rotate()
      .resize(MESSAGE_PHOTO_MAX_PX, MESSAGE_PHOTO_MAX_PX, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: MESSAGE_PHOTO_JPEG_QUALITY })
      .toBuffer();
  } catch (err) {
    logger.error(`[admin-photo-assessments] photo resize failed for ${key}: ${err.message}`);
    return { error: 'Could not process the photo — try again in a moment.', status: 502 };
  }

  let conversationCustomerId = null;
  if (message.conversation_id) {
    const conversation = await db('conversations').where({ id: message.conversation_id }).select('customer_id').first();
    conversationCustomerId = conversation?.customer_id || null;
  }

  return {
    photo: { data: jpegBuffer.toString('base64'), mimeType: 'image/jpeg' },
    customerId: conversationCustomerId,
  };
}

// Resolves every message_photos entry in order, short-circuiting on the
// first failure. Returns { photos, customerId } when every entry's own
// conversation customer agrees (including all-null), or an
// { error, status } when they don't.
async function resolveMessagePhotos(entries) {
  const photos = [];
  // Every selected message's own conversation customer, INCLUDING null for
  // an unlinked conversation — null is a distinct ownership state, not "no
  // opinion". Collecting only truthy ids would let a selection mixing a
  // customer-linked message with an unlinked one slip through as
  // "one distinct customer" and silently attribute the unlinked sender's
  // photo to that customer. A phone-keyed thread on the client can mix
  // messages from more than one customer (a shared/reassigned number) —
  // the client already refuses to submit a mixed selection, but this is
  // the authoritative check: message_photos whose messages don't all agree
  // (including agreeing on "none") is refused outright rather than
  // silently attributed to whichever entry happened to resolve first.
  const customerIds = [];
  for (const entry of entries) {
    const result = await loadMessagePhoto(entry);
    if (result.error) return { error: result.error, status: result.status };
    photos.push(result.photo);
    customerIds.push(result.customerId || null);
  }
  if (new Set(customerIds).size > 1) {
    return { error: 'Selected photos belong to different customers — pick photos from one customer.', status: 400 };
  }
  return { photos, customerId: customerIds[0] || null };
}

const TYPES = {
  lawn: {
    table: 'lawn_diagnostics',
    photoTable: 'lawn_diagnostic_photos',
    photoFk: 'diagnostic_id',
    photoKeyPrefix: 'lawnfunnel',
    reportPath: (token) => `/lawn-report/${token}`,
    label: 'Lawn Assessment',
    // Admin lane = prospect-mode rows only (see scopeProspectMode).
    scope: (qb) => scopeProspectMode(qb),
    listFields: (row) => ({ headline: overallStatusLabel(row.overall_score) }),
    techView: (row, contract) => ({ contract }),
    customerPreview: (row) => buildPublicLawnReport(row),
    analyze: (photos, prospectNote, source) => runLawnAnalysis(photos, prospectNote, source),
  },
  pest: {
    table: 'pest_identifications',
    photoTable: 'pest_identification_photos',
    photoFk: 'identification_id',
    photoKeyPrefix: 'pestid',
    reportPath: (token) => `/pest-report/${token}`,
    label: 'Pest Identification',
    // pest_identifications also gets mode='customer' rows from the
    // authenticated customer Photo ID API (server/routes/photo-id.js) —
    // those have no contact/lead to claim and none of this queue's actions
    // (relink, generate/send an expiring report) apply to them, so they're
    // excluded the same way an internal tech diagnostic already is on lawn
    // (codex GH r1 P2 on PR #4752).
    scope: (qb) => scopeProspectMode(qb),
    listFields: (row) => pestListFields(row),
    techView: (row, contract) => pestTechView(row, contract),
    customerPreview: (row) => buildPublicPestReport(row),
    analyze: (photos, prospectNote) => runPestAnalysis(photos, prospectNote),
  },
  tree_shrub: {
    table: 'tree_shrub_identifications',
    photoTable: 'tree_shrub_identification_photos',
    photoFk: 'identification_id',
    photoKeyPrefix: 'treeshrub',
    // No tokenized customer report page exists for tree & shrub yet — a null
    // reportPath makes generate-link / send-report refuse (releaseRefusal)
    // BEFORE any report/claim column would be read or written (the table has
    // none), and keeps report_url null, so no dead link is ever shown.
    reportPath: null,
    label: 'Tree & Shrub Assessment',
    // No scope needed: the customer Photo ID API's tree & shrub submissions
    // insert into their own table (tree_shrub_assessments), never this
    // admin table (tree_shrub_identifications) — unlike lawn and pest,
    // which share their table with the customer lane.
    scope: null,
    listFields: (row) => treeShrubListFields(row),
    techView: (row, contract) => treeShrubTechView(contract),
    customerPreview: () => null,
    analyze: (photos, prospectNote, source) => runTreeShrubAnalysis(photos, prospectNote, source),
  },
};

// Every assessment type, in list/funnel order. A literal list rather than
// the keys of TYPES: TYPES is the governed insert-table config
// (tests/lead-writer-registry.test.js) and may not be handed whole to an
// uninspectable callee. The allowlist also keeps a prototype key
// (?type=toString, /constructor/:id) from resolving to a config.
const TYPE_KEYS = ['lawn', 'pest', 'tree_shrub'];

// Returns TYPES[type] itself (written as a plain `return TYPES[...]` so the
// lead-writer registry test follows the governed config through this call).
function configFor(type) {
  if (!TYPE_KEYS.includes(String(type || ''))) return null;
  return TYPES[type];
}

// The admin lane = prospect-mode rows. Internal tech diagnostics (mode
// 'internal') belong to the tech portal flow, not this list — and neither
// does a customer's own Photo ID submission (mode 'customer', source
// 'portal', server/routes/photo-id.js).
function scopeProspectMode(qb) {
  return qb.where({ mode: 'prospect' });
}

// A group-only answer (the two vision models split on the species) has no
// species_slug but keeps its group in the contract; staff see the same group
// wording the customer sees ("an ant species") instead of a bare category.
function pestGroupLabel(contract) {
  const ident = (contract && contract.identification) || {};
  return !ident.slug && ident.group ? publicIdentificationLabel(contract).label : null;
}

function pestContractOf(row) {
  if (!row.report_contract) return {};
  if (typeof row.report_contract === 'object') return row.report_contract;
  try { return JSON.parse(row.report_contract) || {}; } catch { return {}; }
}

function pestListFields(row) {
  const item = row.species_slug ? LIBRARY_BY_SLUG.get(row.species_slug) : null;
  const groupLabel = item ? null : pestGroupLabel(pestContractOf(row));
  return {
    headline: item ? item.label : (groupLabel || row.category || 'Unidentified'),
    category: row.category || null,
    urgency: row.urgency || null,
    service_line: row.service_line || null,
  };
}

// Overall 0-100 health score + the worst flagged signal, e.g.
// "62/100 · Pest Activity Signals" or "91/100 · No flagged signals".
function treeShrubListFields(row) {
  const overall = row.overall_score == null ? null : Number(row.overall_score);
  const worstLabel = TREE_SHRUB_SIGNAL_LABELS[row.worst_signal] || null;
  return {
    headline: `${overall == null ? 'Unscored' : `${overall}/100`} · ${worstLabel || 'No flagged signals'}`,
    overall_score: overall,
    worst_signal: worstLabel ? row.worst_signal : null,
    worst_signal_label: worstLabel,
  };
}

function pestTechView(row, contract) {
  const ident = contract.identification || {};
  const item = ident.slug ? LIBRARY_BY_SLUG.get(ident.slug) : null;
  const alternates = (Array.isArray(contract.alternate_slugs) ? contract.alternate_slugs : [])
    .map((slug) => LIBRARY_BY_SLUG.get(slug))
    .filter(Boolean)
    .map((alt) => ({ slug: alt.slug, label: alt.label, tech_notes: alt.tech_notes }));
  return {
    identification: {
      slug: ident.slug || null,
      label: item ? item.label : pestGroupLabel(contract),
      group: ident.group || null,
      category: ident.category || null,
      confidence: ident.confidence || null,
      contested: !!ident.contested,
    },
    urgency: contract.urgency || null,
    safety: contract.safety || {},
    service: contract.service || {},
    tech_notes: item ? item.tech_notes : null,
    differentials: alternates,
    // Raw model observations — internal only; never rendered on a customer surface.
    observations: Array.isArray(contract.observations) ? contract.observations : [],
    distinguishing_features: Array.isArray(contract.distinguishing_features) ? contract.distinguishing_features : [],
  };
}

// Admin view of a tree & shrub assessment: the five 0-100 health scores and
// statuses, the flagged findings, the headline + per-photo observations, and
// the admin next step. The contract is written only by runTreeShrubAnalysis
// and holds nothing but admin-safe fields, so the view is the contract over
// empty defaults (older/partial rows still render). Admin eyes only — there
// is no customer report page for this type yet.
const TREE_SHRUB_VIEW_DEFAULTS = {
  scores: {},
  categories: [],
  worst_signal: null,
  findings: [],
  observations: '',
  photo_observations: [],
  ai_summary: null,
  suggested_customer_action: null,
  scored_count: null,
  photo_count: null,
};
function treeShrubTechView(contract) {
  return { ...TREE_SHRUB_VIEW_DEFAULTS, ...contract };
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

// Same pipeline the public funnel runs (shared ladder → contract → writer →
// release repair) — one analysis implementation, three front doors (tech,
// public funnel, admin-created).
async function runLawnAnalysis(photos, prospectNote, source) {
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
  return {
    insert: {
      ai_analysis: JSON.stringify({
        release_mode: releaseMode,
        findings_source: findingsSource,
        fallback_reason: fallbackReason,
        prospect_note: prospectNote,
        provenance: {
          source,
          perception_model: provenance.perceptionModel || null,
          challenge_model: provenance.challengeModel || null,
          writer: provenance.writerModel || 'deterministic',
        },
      }),
      report_contract: JSON.stringify(sanitizedContract),
      overall_score: deriveOverallScore(sanitizedContract, null),
      ai_summary: cleanString(sanitizedContract.customer_summary, 2000),
    },
  };
}

async function runPestAnalysis(photos, prospectNote) {
  const result = await identifyPest(photos);
  if (!result.ok) return { error: 'Photo analysis is unavailable right now — try again in a few minutes.' };
  const contract = buildPestReportContract(result);
  return {
    insert: {
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
    },
  };
}

// Tree & shrub runs the SAME dual-vision engine the tech visit closeout uses
// — its per-photo analyzePhoto (Claude + Gemini), mergePhotoComposites
// (worst signal across photos), and deterministic 0-100 health scoring — so
// there is no second analysis implementation. It composes those pieces here
// rather than calling previewTreeShrubAssessment because this lane needs what
// the preview discards: each photo's own reading. The prospect note is
// stored for the admin view only and never passed to the model (same rule as
// lawn/pest).

// Admin next step keyed by the worst flagged signal. This lane is standalone
// (a prospect, or a customer with no visit booked), so unlike the closeout
// helper's "we'll recheck on the next visit" it never promises a visit. Admin
// view only — tree & shrub has no customer report egress.
const TREE_SHRUB_NEXT_STEPS = {
  none: 'No treatment signals in these photos — offer a seasonal check.',
  foliage_fullness: 'Recommend an on-site look to confirm what is thinning the canopy and quote a plan.',
  leaf_color_vigor: 'Recommend an on-site look to confirm the discoloration pattern and quote treatment.',
  pest_activity: 'Recommend an on-site look to confirm the pest-pressure signals and quote treatment.',
  disease_leaf_spot: 'Recommend an on-site look to confirm the leaf-spot signals and quote treatment.',
  water_heat_mechanical_stress: 'Recommend an on-site look at watering and pruning before quoting treatment.',
};
// Inbound photo-text triage (source 'auto_triage') decides the next step
// itself — the opportunity gauge picks advice, a quote ask, or an on-site
// visit for the reply. The stored guidance must not contradict that reply
// with a blanket "recommend an on-site look" (codex #4810 r10), and must
// not promise a draft exists either: it is written before the draft is
// parked, and a competing pending draft or a failed insert keeps the
// assessment without one (r11).
const TREE_SHRUB_TRIAGE_NEXT_STEP = 'From a customer photo text — the reply (advice, quote ask, or on-site visit) is decided in the conversation, not by this assessment.';

// The five categories as the admin lane stores them: key/label/score/status
// only. The report builder's customerExplanation copy is written for a
// completed visit ("documented today", "confirm next visit"), which a
// standalone assessment must not carry.
function treeShrubCategories(scores) {
  return buildTreeShrubVisualCategories({ scores })
    .map(({ key, label, score, status }) => ({ key, label, score, status }));
}

// Lowest-scoring flagged (watch / needs_attention) category, or null when
// nothing is flagged.
function worstTreeShrubSignal(categories) {
  return categories
    .filter((category) => category.status === 'watch' || category.status === 'needs_attention')
    .reduce((worst, category) => (!worst || category.score < worst.score ? category : worst), null);
}

// One photo through the engine. A result that did not read every schema
// field (isCompleteVisionResult — an omitted or invalid field would
// otherwise default to a clean "none"/95) counts as unscored: null.
async function scoreTreeShrubPhoto({ photo, index }) {
  const result = await analyzePhoto(photo.data, photo.mimeType).catch(() => null);
  if (!isCompleteVisionResult(result)) return null;
  const categories = treeShrubCategories(toCategoryScores(result.composite));
  return {
    index,
    composite: result.composite,
    observations: String(result.composite.observations || '').trim(),
    worst: worstTreeShrubSignal(categories),
    categories,
  };
}

// The scored photo whose own reading drives the merged worst signal (the
// lowest score on that category), so the headline observation describes the
// trouble spot rather than whichever photo happened to come first. No
// flagged signal → the first photo.
function headlineTreeShrubPhoto(scored, worstKey) {
  const scoreOn = (entry) => entry.categories.find((category) => category.key === worstKey)?.score ?? Infinity;
  return scored.reduce((best, entry) => (scoreOn(entry) < scoreOn(best) ? entry : best), scored[0]);
}

// Every photo that carries data must score completely, or nothing is
// persisted: a dropped photo would silently leave the operator's pick
// (possibly the trouble spot) out of the worst-signal merge.
async function runTreeShrubAnalysis(photos, prospectNote, source) {
  const analyzable = photos.map((photo, index) => ({ photo, index })).filter(({ photo }) => photo.data);
  const scored = await Promise.all(analyzable.map(scoreTreeShrubPhoto));
  if (!scored.every(Boolean)) return { error: 'Could not analyze every photo — try again in a few minutes.' };

  const merged = mergePhotoComposites(scored.map((entry) => entry.composite));
  const scores = toCategoryScores(merged);
  scores.overallScore = calculateOverall(scores);
  const categories = treeShrubCategories(scores);
  const worst = worstTreeShrubSignal(categories);
  const worstKey = worst ? worst.key : null;
  const headline = headlineTreeShrubPhoto(scored, worstKey);
  const { aiSummary, findings } = buildTreeShrubTechFindings({ scores });
  const contract = {
    scores,
    categories,
    worst_signal: worst,
    // Headline paragraph: the photo driving the worst signal. Every photo's
    // own paragraph is kept, in upload order, beside its own worst signal.
    observations: headline.observations,
    photo_observations: scored.map((entry) => ({
      index: entry.index,
      observations: entry.observations,
      worst_signal: entry.worst && entry.worst.key,
    })),
    findings,
    ai_summary: aiSummary,
    suggested_customer_action: source === 'auto_triage' ? TREE_SHRUB_TRIAGE_NEXT_STEP : TREE_SHRUB_NEXT_STEPS[worstKey ?? 'none'],
    scored_count: scored.length,
    photo_count: analyzable.length,
  };
  return {
    insert: {
      ai_analysis: JSON.stringify({
        prospect_note: prospectNote,
        provenance: { source, engine: 'tree-shrub-assessment' },
      }),
      report_contract: JSON.stringify(contract),
      overall_score: scores.overallScore,
      worst_signal: worstKey,
      ai_summary: cleanString(headline.observations, 2000),
    },
  };
}

// Resolves the request's photo inputs (photos + message_photos) into the
// normalizePhotos-shaped list the analysis ladder runs on, or an
// { error, status }. Owns every count/size/shape check for BOTH sources so
// createAdminAssessment makes exactly one decision (did this fail) instead of
// re-checking the combined list at each stage.
async function resolveRequestPhotos(body) {
  const rawPhotos = Array.isArray(body.photos) ? body.photos.filter(Boolean) : [];
  const messagePhotoRequests = Array.isArray(body.message_photos) ? body.message_photos.filter(Boolean) : [];
  if (!rawPhotos.length && !messagePhotoRequests.length) {
    return { error: 'At least one photo is required', status: 400 };
  }
  if (rawPhotos.length + messagePhotoRequests.length > MAX_PHOTOS) {
    return { error: `At most ${MAX_PHOTOS} photos per assessment`, status: 400 };
  }

  // Pulled BEFORE the vision ladder runs — a bad key or an unreachable S3
  // object fails the request outright rather than silently dropping a
  // photo the operator explicitly selected.
  const messagePhotos = await resolveMessagePhotos(messagePhotoRequests);
  if (messagePhotos.error) return messagePhotos;

  const photos = normalizePhotos([...rawPhotos, ...messagePhotos.photos]);
  if (!photos.length || !photos.some((photo) => photo.data)) {
    return { error: 'At least one photo is required', status: 400 };
  }
  if (photos.length > MAX_PHOTOS) {
    return { error: `At most ${MAX_PHOTOS} photos per assessment`, status: 400 };
  }
  if (photos.some((photo) => photo.data && photo.data.length > MAX_PHOTO_CHARS)) {
    return { error: 'One of the photos is too large — resize it and retry.', status: 413 };
  }

  return { photos, messageCustomerId: messagePhotos.customerId };
}

// One id → row lookup for both lead_id and customer_id, so the two
// association fields share a single validated-UUID-then-exists shape
// instead of two parallel hand-written blocks.
const ASSOCIATION_LOOKUPS = {
  lead_id: { table: 'leads', notFoundLabel: 'Lead' },
  customer_id: { table: 'customers', notFoundLabel: 'Customer' },
};
async function lookupAssociation(field, id) {
  const spec = ASSOCIATION_LOOKUPS[field];
  if (!UUID_RE.test(String(id))) return { error: `invalid ${field}`, status: 400 };
  const row = await db(spec.table).where({ id }).first();
  if (!row) return { error: `${spec.notFoundLabel} not found`, status: 404 };
  return { id: row.id, row };
}

// The linked customer's own contact fields, shaped like a contact_snapshot,
// so an assessment created without an explicit contact (Customer 360 or an
// inbound-thread pick) still lists a name/email/phone instead of "No
// contact yet" while its Linked column says Customer.
function customerContactSnapshot(customer) {
  if (!customer) return null;
  return {
    first_name: cleanString(customer.first_name, 80),
    last_name: cleanString(customer.last_name, 80),
    email: cleanString(customer.email, 254),
    phone: cleanString(customer.phone, 20),
  };
}

// Resolves lead_id/customer_id into { leadId, customerId, customerContact }
// (customerContact = the linked customer's contact fields, or null), or an
// { error, status }. customerId prefers an explicit body value, otherwise
// defaults from the inbound message thread (messageCustomerId, from
// resolveRequestPhotos) — same existence check either way, so a
// stale/deleted id never links. An explicit customer_id that CONTRADICTS
// the selected messages' own (non-null) customer is refused rather than
// silently overriding it — the client only ever sends an explicit
// customer_id from the Customer 360-embedded composer, where it should
// always agree with the thread it pulled photos from.
async function resolveAssociations(body, messageCustomerId) {
  let leadId = null;
  let customerId = null;
  let customerContact = null;

  if (body.lead_id) {
    const lead = await lookupAssociation('lead_id', body.lead_id);
    if (lead.error) return lead;
    leadId = lead.id;
  }

  if (body.customer_id && messageCustomerId && String(body.customer_id) !== String(messageCustomerId)) {
    return { error: 'customer_id does not match the selected photos’ customer', status: 400 };
  }
  const requestedCustomerId = body.customer_id || messageCustomerId;
  if (requestedCustomerId) {
    const customer = await lookupAssociation('customer_id', requestedCustomerId);
    if (customer.error) return customer;
    customerId = customer.id;
    customerContact = customerContactSnapshot(customer.row);
  }

  return { leadId, customerId, customerContact };
}

// An explicit body.contact wins; otherwise the linked customer's own
// contact fields (customerContact, from resolveAssociations) stand in so
// the row is never "No contact yet" while linked to a customer.
function buildSnapshots(body, customerContact = null) {
  const contact = body.contact && typeof body.contact === 'object' && !Array.isArray(body.contact) ? body.contact : {};
  const explicitContact = {
    first_name: cleanString(contact.first_name, 80),
    last_name: cleanString(contact.last_name, 80),
    email: cleanString(contact.email, 254),
    phone: cleanString(contact.phone, 20),
  };
  const contactSnapshot = Object.values(explicitContact).some(Boolean) ? explicitContact : (customerContact || {});
  const address = body.address && typeof body.address === 'object' && !Array.isArray(body.address) ? body.address : {};
  const addressSnapshot = {
    line1: cleanString(address.line1),
    city: cleanString(address.city),
    state: cleanString(address.state, 20),
    zip: cleanString(address.zip, 12),
  };
  return {
    contactSnapshot: Object.values(contactSnapshot).some(Boolean) ? contactSnapshot : null,
    addressSnapshot: Object.values(addressSnapshot).some(Boolean) ? addressSnapshot : null,
    prospectNote: cleanString(body.note, 500),
  };
}

// Admin-lane assessment create: resolve photos + associations, run the
// shared analysis, insert the prospect-mode row, store its photos. `source`
// is stamped server-side by each caller ('admin' for the route,
// 'auto_triage' for inbound photo-text triage) — never read from a request
// body. No lead, attribution row, or email is ever created here.
async function createAdminAssessment({ type, source, ...body }) {
  const config = configFor(type);
  if (!config) return { error: 'Unknown assessment type', status: 404 };

  const requestPhotos = await resolveRequestPhotos(body);
  if (requestPhotos.error) return requestPhotos;
  const { photos, messageCustomerId } = requestPhotos;

  const associations = await resolveAssociations(body, messageCustomerId);
  if (associations.error) return associations;
  const { leadId, customerId, customerContact } = associations;

  const { contactSnapshot, addressSnapshot, prospectNote } = buildSnapshots(body, customerContact);

  // Everything above is free (validation, S3 fetch, lookups); from here on
  // the paid vision analysis has started. Callers that budget vision runs
  // (the photo-text triage) read analysisStarted on a refusal or a thrown
  // error to tell a free failure from a spent one.
  try {
    return await analyzeAndStore({
      type, source, config, photos, prospectNote, leadId, customerId, contactSnapshot, addressSnapshot,
    });
  } catch (err) {
    err.analysisStarted = true;
    throw err;
  }
}

async function analyzeAndStore({
  type, source, config, photos, prospectNote, leadId, customerId, contactSnapshot, addressSnapshot,
}) {
  const analysis = await config.analyze(photos, prospectNote, source);
  if (analysis.error) return { error: analysis.error, status: 503, analysisStarted: true };

  const [row] = await db(config.table).insert({
    mode: 'prospect',
    status: 'analyzed',
    source,
    lead_id: leadId,
    customer_id: customerId,
    contact_snapshot: contactSnapshot ? JSON.stringify(contactSnapshot) : null,
    address_snapshot: addressSnapshot ? JSON.stringify(addressSnapshot) : null,
    ...analysis.insert,
  }).returning(['id', 'created_at']);

  await storeFunnelPhotos({
    table: config.photoTable,
    fkColumn: config.photoFk,
    rowId: row.id,
    keyPrefix: config.photoKeyPrefix,
    photos,
  });

  logger.info(`[photo-assessment-create] ${source} ${type} assessment ${row.id}`);
  return {
    id: row.id,
    type,
    analysis: { ...analysis.insert, created_at: row.created_at || new Date() },
  };
}

module.exports = {
  TYPES,
  TYPE_KEYS,
  configFor,
  UUID_RE,
  MAX_PHOTOS,
  MESSAGE_PHOTO_ALLOWED_MIME,
  cleanString,
  createAdminAssessment,
  _test: {
    normalizePhotos,
    runTreeShrubAnalysis,
    worstTreeShrubSignal,
    headlineTreeShrubPhoto,
    TREE_SHRUB_NEXT_STEPS,
    TREE_SHRUB_TRIAGE_NEXT_STEP,
    resolveRequestPhotos,
    resolveAssociations,
    lookupAssociation,
    buildSnapshots,
  },
};
