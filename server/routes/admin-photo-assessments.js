/**
 * Admin API for photo assessments (lawn assessment + pest identification).
 *
 * One surface over both funnel tables — lawn_diagnostics (mode='prospect')
 * and pest_identifications — backing /admin/lawn-assessments:
 *
 *   GET  /                      unified list (type/status filters, newest first)
 *   GET  /funnel                per-type funnel counts (analyzed → claimed → viewed → booked)
 *   GET  /:type/:id             detail: photos (signed URLs), tech view, customer preview
 *   POST /:type                 admin-created assessment (phone prospect / existing customer)
 *   POST /:type/:id/link        link/unlink a lead or customer
 *   POST /:type/:id/send-report MANUAL report email — the only sender of
 *                               assessment.report_link, fired exclusively by
 *                               the admin's click (owner sends all comms).
 *
 * Assessments are standalone-but-linkable: unlock auto-links the lead the
 * public claim created; this API adds the manual link path and admin-created
 * rows (source='admin') that never touched the public funnel.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
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
const {
  identifyPest,
  buildPestReportContract,
  buildPublicPestReport,
  PEST_LIBRARY,
} = require('../services/pest-identification');
const { sendAssessmentReportEmail } = require('../services/assessment-report-email');
const { storeFunnelPhotos } = require('../utils/funnel-photos');
const { overallStatusLabel } = require('../utils/public-report-egress');
const { etParts } = require('../utils/datetime-et');

let PhotoService;
try { PhotoService = require('../services/photos'); } catch { PhotoService = null; }

router.use(adminAuthenticate, requireAdmin);

const PORTAL_BASE = 'https://portal.wavespestcontrol.com';
const REPORT_TTL_DAYS = 30;
const MAX_PHOTOS = 5;
const MAX_PHOTO_CHARS = 6_000_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIBRARY_BY_SLUG = new Map(PEST_LIBRARY.map((e) => [e.slug, e]));

const TYPES = {
  lawn: {
    table: 'lawn_diagnostics',
    photoTable: 'lawn_diagnostic_photos',
    photoFk: 'diagnostic_id',
    photoKeyPrefix: 'lawnfunnel',
    reportPath: (token) => `/lawn-report/${token}`,
    label: 'Lawn Assessment',
  },
  pest: {
    table: 'pest_identifications',
    photoTable: 'pest_identification_photos',
    photoFk: 'identification_id',
    photoKeyPrefix: 'pestid',
    reportPath: (token) => `/pest-report/${token}`,
    label: 'Pest Identification',
  },
};

function typeConfig(req, res) {
  const config = TYPES[String(req.params.type || '')];
  if (!config) {
    res.status(404).json({ error: 'Unknown assessment type' });
    return null;
  }
  return config;
}

function parseJson(value, fallback = {}) {
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

// The admin lane = prospect-mode rows. Internal tech diagnostics (mode
// 'internal') belong to the tech portal flow, not this list.
function scopeLawn(qb) {
  return qb.where({ mode: 'prospect' });
}

function listRowShape(type, row) {
  const contact = parseJson(row.contact_snapshot, {});
  const shared = {
    id: row.id,
    type,
    status: row.status,
    source: row.source,
    created_at: row.created_at,
    claimed_at: row.claimed_at || null,
    report_first_viewed_at: row.report_first_viewed_at || null,
    last_sent_at: row.last_sent_at || null,
    report_expires_at: row.report_expires_at || null,
    lead_id: row.lead_id || null,
    customer_id: row.customer_id || null,
    has_report_token: !!row.report_token,
    photo_count: Number(row.photo_count || 0),
    contact: {
      first_name: contact.first_name || null,
      last_name: contact.last_name || null,
      email: contact.email || null,
      phone: contact.phone || null,
    },
  };
  if (type === 'lawn') {
    return { ...shared, headline: overallStatusLabel(row.overall_score) };
  }
  const item = row.species_slug ? LIBRARY_BY_SLUG.get(row.species_slug) : null;
  return {
    ...shared,
    headline: item ? item.label : (row.category || 'Unidentified'),
    category: row.category || null,
    urgency: row.urgency || null,
    service_line: row.service_line || null,
  };
}

async function fetchListRows(type, { status, limit, offset }) {
  const config = TYPES[type];
  let qb = db(config.table)
    .select(
      `${config.table}.*`,
      db.raw(`(SELECT COUNT(*) FROM ${config.photoTable} p WHERE p.${config.photoFk} = ${config.table}.id) AS photo_count`),
    )
    .orderBy('created_at', 'desc')
    // Over-fetch offset+limit so the merged two-table sort can slice
    // correctly — the merged top (offset+limit) is always contained in the
    // union of each table's top (offset+limit).
    .limit(offset + limit);
  if (type === 'lawn') qb = scopeLawn(qb);
  if (status && status !== 'all') qb = qb.where(`${config.table}.status`, status);
  const rows = await qb;
  return rows.map((row) => listRowShape(type, row));
}

// GET /api/admin/photo-assessments?type=lawn|pest|all&status=analyzed|sent|archived|all
router.get('/', async (req, res, next) => {
  try {
    const type = ['lawn', 'pest'].includes(req.query.type) ? req.query.type : 'all';
    const status = cleanString(req.query.status, 20) || 'all';
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const typesToFetch = type === 'all' ? ['lawn', 'pest'] : [type];
    const lists = await Promise.all(typesToFetch.map((t) => fetchListRows(t, { status, limit, offset })));
    const merged = lists.flat().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({
      assessments: merged.slice(offset, offset + limit),
      gates: {
        lawn: require('../config/feature-gates').isEnabled('lawnAssessmentMagnet'),
        pest: require('../config/feature-gates').isEnabled('pestIdentifier'),
      },
    });
  } catch (err) {
    next(err);
  }
});

async function funnelCounts(type, sinceDate) {
  const config = TYPES[type];
  // Funnel rates are LEAD-MAGNET metrics: only public-funnel rows count —
  // admin-created phone-prospect assessments never saw the teaser → unlock
  // funnel and would skew unlock/booking rates. They're reported separately.
  let qb = db(config.table).where({ source: 'public_funnel' });
  if (type === 'lawn') qb = scopeLawn(qb);
  if (sinceDate) qb = qb.where('created_at', '>=', sinceDate);
  const [counts] = await qb
    .select(
      db.raw('COUNT(*)::int AS analyzed'),
      db.raw('COUNT(claimed_at)::int AS claimed'),
      db.raw('COUNT(report_first_viewed_at)::int AS viewed'),
      db.raw('COUNT(lead_id)::int AS leads'),
    );

  let adminCreated = 0;
  try {
    let adminQb = db(config.table).where({ source: 'admin' });
    if (type === 'lawn') adminQb = scopeLawn(adminQb);
    if (sinceDate) adminQb = adminQb.where('created_at', '>=', sinceDate);
    const [row] = await adminQb.count('* as n');
    adminCreated = Number(row?.n || 0);
  } catch (err) {
    logger.warn(`[admin-photo-assessments] admin-created count failed (${type}): ${err.message}`);
  }

  // Booked/completed comes from the SAME funnel machinery every channel uses:
  // the lead's ad_service_attribution row, advanced by lead-funnel-bridge.
  let booked = 0;
  try {
    let bookedQb = db(`${config.table} as a`)
      .join('ad_service_attribution as asa', 'asa.lead_id', 'a.lead_id')
      .where('a.source', 'public_funnel')
      .whereIn('asa.funnel_stage', ['booked', 'completed']);
    if (type === 'lawn') bookedQb = bookedQb.where('a.mode', 'prospect');
    if (sinceDate) bookedQb = bookedQb.where('a.created_at', '>=', sinceDate);
    const [row] = await bookedQb.count('* as n');
    booked = Number(row?.n || 0);
  } catch (err) {
    logger.warn(`[admin-photo-assessments] booked count failed (${type}): ${err.message}`);
  }

  return { ...counts, booked, admin_created: adminCreated };
}

// GET /api/admin/photo-assessments/funnel?days=30 (days=0 → all time)
router.get('/funnel', async (req, res, next) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days ?? 30), 0), 365);
    const sinceDate = days > 0 ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;
    const [lawn, pest] = await Promise.all([
      funnelCounts('lawn', sinceDate),
      funnelCounts('pest', sinceDate),
    ]);
    res.json({ days, lawn, pest });
  } catch (err) {
    next(err);
  }
});

async function loadRow(config, id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  let qb = db(config.table).where({ id });
  if (config.table === 'lawn_diagnostics') qb = scopeLawn(qb);
  return qb.first();
}

async function loadPhotos(config, rowId) {
  const rows = await db(config.photoTable)
    .where({ [config.photoFk]: rowId })
    .orderBy('photo_index', 'asc');
  return Promise.all(rows.map(async (photo) => {
    let url = null;
    if (photo.s3_key && PhotoService) {
      try {
        url = await PhotoService.getViewUrl(photo.s3_key, 900);
      } catch (err) {
        logger.warn(`[admin-photo-assessments] signed URL failed for ${photo.s3_key}: ${err.message}`);
      }
    }
    return { id: photo.id, photo_index: photo.photo_index, mime_type: photo.mime_type, url };
  }));
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
      label: item ? item.label : null,
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

// GET /api/admin/photo-assessments/:type/:id
router.get('/:type/:id', async (req, res, next) => {
  try {
    const config = typeConfig(req, res);
    if (!config) return undefined;
    const row = await loadRow(config, req.params.id);
    if (!row) return res.status(404).json({ error: 'Assessment not found' });

    const analysisMeta = parseJson(row.ai_analysis, {});
    const contract = parseJson(row.report_contract, {});
    const type = req.params.type;

    const [photos, lead, customer] = await Promise.all([
      loadPhotos(config, row.id),
      row.lead_id
        ? db('leads').where({ id: row.lead_id }).select('id', 'first_name', 'last_name', 'status', 'phone', 'email').first()
        : null,
      row.customer_id
        ? db('customers').where({ id: row.customer_id }).select('id', 'first_name', 'last_name', 'pipeline_stage', 'phone', 'email').first()
        : null,
    ]);

    res.json({
      assessment: {
        ...listRowShape(type, { ...row, photo_count: photos.length }),
        address: parseJson(row.address_snapshot, null),
        prospect_note: analysisMeta.prospect_note || null,
        provenance: analysisMeta.provenance || null,
        ai_summary: row.ai_summary || null,
        report_url: row.report_token ? `${PORTAL_BASE}${config.reportPath(row.report_token)}` : null,
        pricing_snapshot: parseJson(row.pricing_snapshot, null),
      },
      photos,
      lead: lead || null,
      customer: customer || null,
      // Internal treatment-oriented view (confirmation steps, tech notes,
      // raw observations) — admin/tech eyes only.
      tech_view: type === 'lawn' ? { contract } : pestTechView(row, contract),
      // Exactly what the customer sees at the tokenized report URL.
      customer_preview: type === 'lawn' ? buildPublicLawnReport(row) : buildPublicPestReport(row),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/photo-assessments/:type/:id/link  { lead_id?, customer_id? }
// Explicit null unlinks; omitted keys are untouched.
router.post('/:type/:id/link', async (req, res, next) => {
  try {
    const config = typeConfig(req, res);
    if (!config) return undefined;
    const row = await loadRow(config, req.params.id);
    if (!row) return res.status(404).json({ error: 'Assessment not found' });

    const body = req.body || {};
    const updates = {};
    if ('lead_id' in body) {
      if (body.lead_id === null) {
        updates.lead_id = null;
      } else {
        if (!UUID_RE.test(String(body.lead_id))) return res.status(400).json({ error: 'invalid lead_id' });
        const lead = await db('leads').where({ id: body.lead_id }).first();
        if (!lead) return res.status(404).json({ error: 'Lead not found' });
        updates.lead_id = lead.id;
      }
    }
    if ('customer_id' in body) {
      if (body.customer_id === null) {
        updates.customer_id = null;
      } else {
        if (!UUID_RE.test(String(body.customer_id))) return res.status(400).json({ error: 'invalid customer_id' });
        const customer = await db('customers').where({ id: body.customer_id }).first();
        if (!customer) return res.status(404).json({ error: 'Customer not found' });
        updates.customer_id = customer.id;
      }
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to link — pass lead_id and/or customer_id' });

    await db(config.table).where({ id: row.id }).update({ ...updates, updated_at: db.fn.now() });
    logger.info(`[admin-photo-assessments] ${req.params.type} ${row.id} linked ${JSON.stringify(updates)}`);
    return res.json({ success: true, ...updates });
  } catch (err) {
    return next(err);
  }
});

// POST /api/admin/photo-assessments/:type/:id/send-report  { email? }
//
// The ONLY dispatcher of the assessment report email, and it only ever runs
// on this authenticated admin click — never from unlock, link, cron, or any
// automated path (owner-sends-all-comms rule).
router.post('/:type/:id/send-report', async (req, res, next) => {
  try {
    const config = typeConfig(req, res);
    if (!config) return undefined;
    const row = await loadRow(config, req.params.id);
    if (!row) return res.status(404).json({ error: 'Assessment not found' });
    if (!['analyzed', 'sent'].includes(row.status)) {
      return res.status(409).json({ error: `Cannot send a report for a ${row.status} assessment` });
    }

    const contact = parseJson(row.contact_snapshot, {});
    // Recipient resolution: explicit override → snapshot → linked lead →
    // linked customer (so "link a contact first" actually satisfies the send).
    let email = cleanString(req.body?.email, 254) || contact.email || null;
    let firstName = contact.first_name || null;
    if (!email && (row.lead_id || row.customer_id)) {
      const linked = row.lead_id
        ? await db('leads').where({ id: row.lead_id }).select('email', 'first_name').first()
        : await db('customers').where({ id: row.customer_id }).select('email', 'first_name').first();
      if (linked?.email) {
        email = linked.email;
        firstName = firstName || linked.first_name || null;
      }
    }
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'No valid recipient email — add one to the request or link a contact first' });
    }

    // Atomic mint: COALESCE keeps the FIRST token under concurrent sends /
    // double-submits (both requests read back the same persisted token, so
    // neither email carries a link the other invalidated). Every send
    // refreshes the 30-day expiry; resends keep the token stable.
    const candidateToken = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + REPORT_TTL_DAYS * 24 * 60 * 60 * 1000);
    const [updated] = await db(config.table).where({ id: row.id }).update({
      report_token: db.raw('COALESCE(report_token, ?)', [candidateToken]),
      report_expires_at: expiresAt,
      status: 'sent',
      last_sent_at: db.fn.now(),
      updated_at: db.fn.now(),
    }).returning(['report_token']);
    const reportToken = updated?.report_token || candidateToken;

    const reportUrl = `${PORTAL_BASE}${config.reportPath(reportToken)}`;
    // sendAssessmentReportEmail contains its own failures (sent:false), but a
    // truly unexpected throw must not swallow the minted link either.
    let emailResult;
    try {
      emailResult = await sendAssessmentReportEmail({
        type: req.params.type,
        assessmentId: row.id,
        to: email,
        firstName,
        reportUrl,
        expiresAt,
        recipientType: row.customer_id ? 'customer' : (row.lead_id ? 'lead' : null),
        recipientId: row.customer_id || row.lead_id || null,
      });
    } catch (emailErr) {
      logger.error(`[admin-photo-assessments] unexpected send error for ${row.id}: ${emailErr.message}`);
      emailResult = { ok: false, error: 'Email send failed — copy the link instead.' };
    }

    logger.info(`[admin-photo-assessments] ${req.params.type} ${row.id} report send → ${emailResult.ok ? 'sent' : `FAILED (${emailResult.error})`}`);
    // Email failure is a 200 with sent:false — the token is minted either
    // way, so the admin can copy reportUrl and share it manually.
    return res.json({
      success: true,
      sent: emailResult.ok,
      blocked: emailResult.blocked || false,
      error: emailResult.ok ? null : emailResult.error || 'Email send failed',
      reportUrl,
      expiresAt,
    });
  } catch (err) {
    return next(err);
  }
});

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
async function runLawnAnalysis(photos, prospectNote) {
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
          source: 'admin',
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

// POST /api/admin/photo-assessments/:type
// Admin-created assessment (prospect on the phone, or an existing customer)
// — no public funnel involved: no lead is created, no attribution row, no
// email. Paid vision behind admin auth, so no gate/Turnstile applies.
router.post('/:type', async (req, res, next) => {
  try {
    const config = typeConfig(req, res);
    if (!config) return undefined;
    const body = req.body || {};

    const photos = normalizePhotos(body.photos);
    if (!photos.length || !photos.some((photo) => photo.data)) {
      return res.status(400).json({ error: 'At least one photo is required' });
    }
    if (photos.length > MAX_PHOTOS) {
      return res.status(400).json({ error: `At most ${MAX_PHOTOS} photos per assessment` });
    }
    if (photos.some((photo) => photo.data && photo.data.length > MAX_PHOTO_CHARS)) {
      return res.status(413).json({ error: 'One of the photos is too large — resize it and retry.' });
    }

    let leadId = null;
    let customerId = null;
    if (body.lead_id) {
      if (!UUID_RE.test(String(body.lead_id))) return res.status(400).json({ error: 'invalid lead_id' });
      const lead = await db('leads').where({ id: body.lead_id }).first();
      if (!lead) return res.status(404).json({ error: 'Lead not found' });
      leadId = lead.id;
    }
    if (body.customer_id) {
      if (!UUID_RE.test(String(body.customer_id))) return res.status(400).json({ error: 'invalid customer_id' });
      const customer = await db('customers').where({ id: body.customer_id }).first();
      if (!customer) return res.status(404).json({ error: 'Customer not found' });
      customerId = customer.id;
    }

    const contact = body.contact && typeof body.contact === 'object' && !Array.isArray(body.contact) ? body.contact : {};
    const contactSnapshot = {
      first_name: cleanString(contact.first_name, 80),
      last_name: cleanString(contact.last_name, 80),
      email: cleanString(contact.email, 254),
      phone: cleanString(contact.phone, 20),
    };
    const hasContact = Object.values(contactSnapshot).some(Boolean);
    const address = body.address && typeof body.address === 'object' && !Array.isArray(body.address) ? body.address : {};
    const addressSnapshot = {
      line1: cleanString(address.line1),
      city: cleanString(address.city),
      state: cleanString(address.state, 20),
      zip: cleanString(address.zip, 12),
    };
    const hasAddress = Object.values(addressSnapshot).some(Boolean);
    const prospectNote = cleanString(body.note, 500);

    const analysis = req.params.type === 'lawn'
      ? await runLawnAnalysis(photos, prospectNote)
      : await runPestAnalysis(photos, prospectNote);
    if (analysis.error) return res.status(503).json({ error: analysis.error });

    const [row] = await db(config.table).insert({
      mode: 'prospect',
      status: 'analyzed',
      source: 'admin',
      lead_id: leadId,
      customer_id: customerId,
      contact_snapshot: hasContact ? JSON.stringify(contactSnapshot) : null,
      address_snapshot: hasAddress ? JSON.stringify(addressSnapshot) : null,
      ...analysis.insert,
    }).returning(['id']);

    await storeFunnelPhotos({
      table: config.photoTable,
      fkColumn: config.photoFk,
      rowId: row.id,
      keyPrefix: config.photoKeyPrefix,
      photos,
    });

    logger.info(`[admin-photo-assessments] admin-created ${req.params.type} assessment ${row.id}`);
    return res.status(201).json({ success: true, id: row.id, type: req.params.type });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
module.exports._test = {
  listRowShape,
  normalizePhotos,
  TYPES,
};
