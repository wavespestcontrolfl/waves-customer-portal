const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const lawnAssessment = require('../services/lawn-assessment');
const {
  buildDiagnosticReportContract,
  classifyReleaseMode,
  applyAutoReleaseRepair,
} = require('../services/lawn-diagnostic-report');
const {
  buildNarrativeContext,
  PROMPT_VERSION,
} = require('../services/lawn-diagnostic-prompt');
// Shared analysis ladder — one implementation for the tech flow and the public
// lawn-assessment funnel (see services/lawn-diagnostic-analyze.js).
const {
  buildFindingsFromVision,
  runFindingsLadder,
  applyWriterSummary,
  deriveOverallScore,
} = require('../services/lawn-diagnostic-analyze');
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

// Stable, key-order-independent string for comparing two recipient snapshots (ignores
// null/'' fields). Used to decide whether a resend changed the recipient — if it did,
// the token must rotate so the original link doesn't start showing the new name/city.
function canonicalSnapshot(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const sorted = {};
  Object.keys(obj).sort().forEach((key) => {
    const val = obj[key];
    if (val != null && val !== '') sorted[key] = val;
  });
  return JSON.stringify(sorted);
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

// Resolve the recipient for a send/lead action. If the request ASSERTS a recipient (a
// `contact` or `address` key is present in the body — the tech UI always sends both
// from the current form, null when cleared), use ONLY the request: a cleared field is
// absent (the gate then fails closed), and a new contact is never mixed field-by-field
// with the prior prospect's stored address. Only a request that omits recipient keys
// entirely (a bare API resend) inherits the stored snapshot verbatim.
function resolveRecipient(req, row) {
  const body = req.body || {};
  if ('contact' in body || 'address' in body) {
    return { contact: normalizeContact(body.contact), address: normalizeAddress(body.address) };
  }
  return {
    contact: parseJsonObject(row.contact_snapshot, null),
    address: parseJsonObject(row.address_snapshot, null),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Hash of the writer's FULL narrative context (findings + treatment + watering + seasonal
// — everything buildNarrativeContext feeds the writer). Binds a diagnosis_run to exactly
// what the summary was written from, so a stored challenge-reviewed summary can't be
// reused on a persist whose findings OR product/compliance/seasonal context differ.
function hashSummaryInputs(contract) {
  return crypto.createHash('sha256').update(buildNarrativeContext(contract || {})).digest('hex');
}

// Server-side gate: persist may restore a diagnosis_run's writer summary ONLY when the run
// proves a genuinely challenge-reviewed report whose summary inputs still match. Everything
// here is from the DB-loaded run (server-authored), never the client.
function shouldUseRunSummary(run, computedHash, technicianId) {
  if (!run) return false;
  if (run.challenge_status !== 'passed') return false;
  if (run.perception_mode !== 'multimodal_challenged') return false;
  if (!run.customer_summary) return false;
  if (run.summary_inputs_hash !== computedHash) return false;
  // Bind to the run's creator so one tech can't reuse another's run id.
  if (run.created_by_technician_id && technicianId && run.created_by_technician_id !== technicianId) return false;
  return true;
}

// Map the analyze findingsSource → durable perception_mode + challenge_status, derived
// from the SERVER's own provenance (not client input).
function runProvenanceFields(findingsSource, provenance) {
  const challenge = provenance && provenance.challenge;
  let perceptionMode = 'minimal';
  if (findingsSource === 'manual') perceptionMode = 'manual';
  else if (findingsSource === 'multimodel') perceptionMode = 'multimodal_challenged';
  else if (findingsSource === 'challenge_degraded') perceptionMode = 'challenge_degraded';
  else if (findingsSource === 'deterministic_fallback') perceptionMode = 'deterministic_fallback';
  let challengeStatus = 'not_run';
  if (challenge && challenge.passed) challengeStatus = 'passed';
  else if (challenge && challenge.attempted) challengeStatus = 'failed';
  return { perceptionMode, challengeStatus };
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
        // Catalog is authoritative: drop request-supplied top-level label timing/source
        // so normalizeProductLabelConstraints can't read them as db_authoritative when
        // the catalog row carries label_verified_at but no directive of its own.
        label_source: row.label_verified_at ? 'product_db' : null,
        labelSource: null,
        post_app_irrigation: null,
        postAppIrrigation: null,
        product_label_constraints: labelConstraintsFromCatalog(row, incomingConstraints),
      };
    });
  } catch (err) {
    logger.warn(`[tech-lawn-diagnostic] product enrichment skipped: ${err.message}`);
    return products.map(downgradeRequestLabelConstraints);
  }
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

    const products = await enrichAppliedProducts(appliedProducts);
    const season = lawnAssessment.getSeason(etParts(new Date()).month);

    // Findings ladder (manual short-circuits; everything else runs the shared
    // ladder in services/lawn-diagnostic-analyze.js — the same pipeline the
    // public lawn-assessment funnel uses).
    let findings;
    let findingsSource;
    let fallbackReason = null;
    let photoAnalysis = null;
    let provenance = { challenge: null, perceptionModel: null, challengeModel: null, writerModel: null };

    if (suppliedFindings.length) {
      findings = suppliedFindings;
      findingsSource = 'manual';
    } else {
      ({ findings, findingsSource, fallbackReason, photoAnalysis, provenance } = await runFindingsLadder({
        photos, season, products, compliance,
      }));
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

    // Auto-release: classify, then write the summary (shared writer step — LLM
    // writer only for the fully-challenged multimodel path). Then repair/degrade
    // unsafe copy.
    const releaseMode = classifyReleaseMode(reportContract);
    await applyWriterSummary(reportContract, { season, findingsSource, releaseMode, provenance });
    const finalContract = applyAutoReleaseRepair(reportContract, releaseMode);

    // Durable, server-authored provenance: one run record per analysis. Persist later
    // loads it by id to verify (server-trusted) that a report was genuinely
    // challenge-reviewed before restoring the GPT-5.5 summary onto the published report.
    // Best-effort — analyze never fails on the bookkeeping insert.
    let diagnosisRunId = null;
    if (findingsSource !== 'manual') {
      try {
        const { perceptionMode, challengeStatus } = runProvenanceFields(findingsSource, provenance);
        const [runRow] = await db('lawn_diagnostic_runs').insert({
          created_by_technician_id: req.technicianId || req.technician?.id || null,
          perception_mode: perceptionMode,
          challenge_status: challengeStatus,
          findings_source: findingsSource,
          perception_model: provenance.perceptionModel || null,
          challenge_model: provenance.challengeModel || null,
          writer_model: provenance.writerModel || null,
          prompt_version: PROMPT_VERSION,
          // Hash the pre-repair contract the writer actually saw (buildNarrativeContext).
          summary_inputs_hash: hashSummaryInputs(reportContract),
          // Store the summary for restore ONLY when the multimodel path AND a writer model
          // actually produced it — a writer outage leaves the deterministic summary, which
          // must not be restored later as if a model wrote it.
          customer_summary: (findingsSource === 'multimodel' && provenance.writerModel) ? (finalContract.customer_summary || null) : null,
        }).returning(['id']);
        diagnosisRunId = runRow?.id || null;
      } catch (err) {
        logger.warn(`[lawn-diagnostic] run-record insert failed (non-blocking): ${err.message}`);
      }
    }

    return res.json({
      success: true,
      persisted: false,
      diagnosisRunId,
      // Vision actually ran when Gemini perceived (happy path) or the composite fallback
      // produced scores; manual findings and total outage report it unavailable.
      aiAvailable: findingsSource !== 'manual' && (!!provenance.perceptionModel || (photoAnalysis ? photoAnalysis.aiAvailable : false)),
      promptVersion: PROMPT_VERSION,
      findingsSource,
      fallbackReason,
      releaseMode,
      provenance,
      photoCount: photos.length,
      analyzedPhotoCount: photoAnalysis ? photoAnalysis.validResults.length : photos.filter((photo) => photo.data).length,
      composite: photoAnalysis ? photoAnalysis.adjustedScores : null,
      rawComposite: photoAnalysis ? photoAnalysis.composite : null,
      divergenceFlags: photoAnalysis ? photoAnalysis.divergenceFlags : [],
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
    // TRUST BOUNDARY: persist rebuilds the contract server-side and never trusts client
    // provenance. The challenge-reviewed GPT-5.5 summary may be restored ONLY when a
    // server-authored diagnosis_run record (loaded by id from the DB) proves the report
    // was multimodal_challenged + challenge passed AND its summary_inputs_hash still matches the
    // rebuilt findings. Otherwise the deterministic, confidence-gated summary stands — an
    // un-challenged report never gains a confident customer voice at save time.
    let restoredFromRun = false;
    let restoredWriterModel = null;
    const diagnosisRunId = typeof body.diagnosisRunId === 'string' && UUID_RE.test(body.diagnosisRunId) ? body.diagnosisRunId : null;
    if (diagnosisRunId) {
      try {
        const run = await db('lawn_diagnostic_runs').where({ id: diagnosisRunId }).first();
        if (shouldUseRunSummary(run, hashSummaryInputs(contract), req.technicianId || req.technician?.id || null)) {
          contract.customer_summary = run.customer_summary;
          restoredFromRun = true;
          restoredWriterModel = run.writer_model || 'model';
        }
      } catch (err) {
        logger.warn(`[lawn-diagnostic] run-record lookup failed (non-blocking): ${err.message}`);
      }
    }
    const sanitizedContract = applyAutoReleaseRepair(contract, releaseMode);
    const aiSummary = cleanString(body.aiSummary, 2000) || cleanString(sanitizedContract.customer_summary, 2000);

    const [row] = await db('lawn_diagnostics').insert({
      mode,
      status: 'analyzed',
      created_by_technician_id: req.technicianId || req.technician?.id || null,
      contact_snapshot: contact ? JSON.stringify(contact) : null,
      address_snapshot: address ? JSON.stringify(address) : null,
      // Server-STAMPED provenance only — challenge_reverified + the ACTUAL writer model
      // reflect whether a verified diagnosis_run restored the summary; a client cannot forge it.
      ai_analysis: JSON.stringify({ ...aiAnalysis, release_mode: releaseMode, provenance: { source: 'persist', writer: restoredFromRun ? restoredWriterModel : 'deterministic', challenge_reverified: restoredFromRun, diagnosis_run_id: restoredFromRun ? diagnosisRunId : null } }),
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

    const { contact, address } = resolveRecipient(req, row);

    // Hard gate: no token is minted without sendable contact info.
    if (!hasSendableContact(contact, address)) {
      return res.status(422).json({ error: 'A contact name and an email or address are required to send a report.' });
    }

    const mintedToken = crypto.randomBytes(16).toString('hex');
    const freshExpiry = new Date(Date.now() + REPORT_TTL_DAYS * 24 * 60 * 60 * 1000);

    // Rotate the token whenever the resend changes the recipient snapshot. Keeping the
    // existing token under an edited contact/address would let the original link
    // recipient see the newly-entered name/city (and tie a quote to the changed
    // snapshot). A changed recipient forces a fresh token + expiry; the old link 404s.
    const recipientChanged =
      canonicalSnapshot(contact) !== canonicalSnapshot(parseJsonObject(row.contact_snapshot, null))
      || canonicalSnapshot(address) !== canonicalSnapshot(parseJsonObject(row.address_snapshot, null));

    // Atomic mint/rotate. Keep the existing token + expiry ONLY for a true idempotent
    // resend: still-active token AND unchanged recipient. Otherwise rotate to a fresh
    // token + expiry, so neither an old expired link is reactivated nor a changed
    // recipient inherits the prior link. The row lock serializes concurrent sends (the
    // second re-evaluates against the first's committed active token and keeps it).
    const ACTIVE_TOKEN = 'report_token IS NOT NULL AND report_expires_at IS NOT NULL AND report_expires_at > now()';
    const KEEP_EXISTING = recipientChanged ? 'false' : ACTIVE_TOKEN;
    const [saved] = await db('lawn_diagnostics')
      .where({ id: row.id })
      .update({
        mode: 'prospect',
        status: 'sent',
        contact_snapshot: JSON.stringify(contact),
        // Write the RESOLVED address (null clears it) — never inherit the prior
        // prospect's stored address when this send asserts a different recipient.
        address_snapshot: address ? JSON.stringify(address) : null,
        report_token: db.raw(`CASE WHEN ${KEEP_EXISTING} THEN report_token ELSE ? END`, [mintedToken]),
        report_expires_at: db.raw(`CASE WHEN ${KEEP_EXISTING} THEN report_expires_at ELSE ? END`, [freshExpiry]),
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

    // Same recipient resolution as /send — a cleared/partial recipient on the request
    // never inherits the prior prospect's stored contact/address into a new lead.
    const { contact, address } = resolveRecipient(req, row);
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
  deriveOverallScore,
  enrichAppliedProducts,
  labelConstraintsFromCatalog,
  normalizePhoto,
  normalizeContact,
  normalizeAddress,
  contactName,
  hasSendableContact,
  canonicalSnapshot,
  resolveRecipient,
  hashSummaryInputs,
  shouldUseRunSummary,
  runProvenanceFields,
};
