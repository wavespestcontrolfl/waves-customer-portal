const express = require('express');
const multer = require('multer');
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const {
  VISIBILITY_STATUSES,
  TAG_CATALOG,
  LOCATION_AREAS,
  isVisualServiceNotesEnabled,
  isVisualServiceNotesRequired,
  canCreateVisualServiceMoment,
  normalizeMomentInsert,
  uploadVisualMomentMedia,
  signedVisualMomentMediaUrl,
  formatVisualMoment,
  tagForCode,
  truncateText,
  invalidateVisualMomentReportPdfCache,
} = require('../services/visual-service-notes');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const authStack = [adminAuthenticate, requireTechOrAdmin];

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function loadJob(jobId) {
  return db('scheduled_services')
    .where({ id: jobId })
    .first();
}

async function loadMoment(momentId) {
  return db('visual_service_moments')
    .where({ id: momentId })
    .whereNull('deleted_at')
    .first();
}

function canReadJob(req, job) {
  if (!job) return { ok: false, status: 404, error: 'Service not found' };
  if (req.techRole !== 'admin' && String(job.technician_id || '') !== String(req.technicianId || '')) {
    return { ok: false, status: 403, error: 'Not assigned to this service' };
  }
  return { ok: true };
}

function canMutateMoment(req, moment) {
  if (!moment) return { ok: false, status: 404, error: 'Visual note not found' };
  if (req.techRole === 'admin') return { ok: true };
  if (String(moment.technician_id || '') !== String(req.technicianId || '')) {
    return { ok: false, status: 403, error: 'Not allowed to update this visual note' };
  }
  if (!['internal_only', 'draft_customer'].includes(moment.visibility_status)) {
    return { ok: false, status: 409, error: 'Visual note has already been reviewed' };
  }
  return { ok: true };
}

async function formatRows(rows, includeInternal) {
  return Promise.all((rows || []).map(async (row) => {
    const mediaUrl = await signedVisualMomentMediaUrl(row).catch(() => null);
    return formatVisualMoment(row, { mediaUrl, includeInternal });
  }));
}

// GET /api/jobs/:jobId/visual-moments
router.get('/jobs/:jobId/visual-moments', authStack, async (req, res, next) => {
  try {
    const enabled = await isVisualServiceNotesEnabled(req.technicianId);
    const required = await isVisualServiceNotesRequired();
    const job = await loadJob(req.params.jobId);
    const access = canReadJob(req, job);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    if (!enabled && req.techRole !== 'admin') {
      return res.json({
        enabled: false,
        required: false,
        tags: TAG_CATALOG,
        locationAreas: LOCATION_AREAS,
        moments: [],
      });
    }

    let query = db('visual_service_moments')
      .where({ job_id: job.id })
      .whereNull('deleted_at')
      .orderBy('captured_at', 'asc')
      .orderBy('created_at', 'asc');
    if (req.techRole !== 'admin') {
      query = query.where({ technician_id: req.technicianId });
    }
    const rows = await query;
    const moments = await formatRows(rows, req.techRole === 'admin');
    return res.json({
      enabled,
      required,
      tags: TAG_CATALOG,
      locationAreas: LOCATION_AREAS,
      moments,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:jobId/visual-moments
router.post('/jobs/:jobId/visual-moments', authStack, upload.single('media'), async (req, res, next) => {
  try {
    const enabled = await isVisualServiceNotesEnabled(req.technicianId);
    const job = await loadJob(req.params.jobId);
    const createGate = canCreateVisualServiceMoment({
      job,
      technicianId: req.technicianId,
      techRole: req.techRole,
      enabled,
    });
    if (!createGate.ok) {
      return res.status(createGate.status).json({ error: createGate.error });
    }

    const body = {
      ...(req.body || {}),
      metadata: parseMetadata(req.body?.metadata),
    };
    let media;
    try {
      media = await uploadVisualMomentMedia(req.file, { jobId: job.id });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ error: err.message || 'Media upload failed' });
    }

    let insert;
    try {
      insert = normalizeMomentInsert({
        body,
        job,
        technicianId: req.technicianId,
        media,
      });
    } catch (err) {
      return res.status(err.statusCode || 400).json({ error: err.message });
    }

    const [row] = await db('visual_service_moments').insert(insert).returning('*');
    const [moment] = await formatRows([row], true);
    logger.info(`[visual-service-notes] saved moment=${row.id} job=${job.id} tech=${req.technicianId} tag=${row.tag_code}`);
    return res.status(201).json({
      message: 'Visual note saved.',
      moment,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/visual-moments/:momentId
router.patch('/visual-moments/:momentId', authStack, async (req, res, next) => {
  try {
    const moment = await loadMoment(req.params.momentId);
    const access = canMutateMoment(req, moment);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const updates = {};
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'note')) updates.note = truncateText(req.body.note, 1500);
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'locationArea')) {
      const locationArea = req.body.locationArea || null;
      if (locationArea && !LOCATION_AREAS.includes(locationArea)) {
        return res.status(400).json({ error: 'locationArea is invalid' });
      }
      updates.location_area = locationArea;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'tagCode')) {
      const tag = tagForCode(req.body.tagCode);
      if (!tag) return res.status(400).json({ error: 'tagCode is invalid' });
      updates.tag_code = tag.tagCode;
      updates.tag_label = tag.label;
      updates.tag_group = tag.group;
    }
    if (req.techRole === 'admin' && Object.prototype.hasOwnProperty.call(req.body || {}, 'customerCaption')) {
      updates.customer_caption = truncateText(req.body.customerCaption, 1500);
    }
    if (Object.keys(updates).length === 0) {
      const [formatted] = await formatRows([moment], req.techRole === 'admin');
      return res.json({ moment: formatted });
    }
    updates.updated_at = db.fn.now();
    const [row] = await db('visual_service_moments')
      .where({ id: moment.id })
      .update(updates)
      .returning('*');
    if (moment.visibility_status === 'approved_customer') {
      await invalidateVisualMomentReportPdfCache(moment.job_id);
    }
    const [formatted] = await formatRows([row], req.techRole === 'admin');
    return res.json({ moment: formatted });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/visual-moments/:momentId
router.delete('/visual-moments/:momentId', authStack, async (req, res, next) => {
  try {
    const moment = await loadMoment(req.params.momentId);
    const access = canMutateMoment(req, moment);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    await db('visual_service_moments')
      .where({ id: moment.id })
      .update({ deleted_at: db.fn.now(), updated_at: db.fn.now() });
    if (moment.visibility_status === 'approved_customer') {
      await invalidateVisualMomentReportPdfCache(moment.job_id);
    }
    return res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// PATCH /api/visual-moments/:momentId/visibility
router.patch('/visual-moments/:momentId/visibility', authStack, requireAdmin, async (req, res, next) => {
  try {
    const status = req.body?.visibilityStatus || req.body?.visibility_status;
    if (!VISIBILITY_STATUSES.has(status)) {
      return res.status(400).json({ error: 'visibilityStatus is invalid' });
    }
    const moment = await loadMoment(req.params.momentId);
    if (!moment) return res.status(404).json({ error: 'Visual note not found' });
    const updates = {
      visibility_status: status,
      updated_at: db.fn.now(),
    };
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'customerCaption')) {
      updates.customer_caption = truncateText(req.body.customerCaption, 1500);
    } else if (Object.prototype.hasOwnProperty.call(req.body || {}, 'customer_caption')) {
      updates.customer_caption = truncateText(req.body.customer_caption, 1500);
    }
    const [row] = await db('visual_service_moments')
      .where({ id: moment.id })
      .update(updates)
      .returning('*');
    if (moment.visibility_status === 'approved_customer' || status === 'approved_customer') {
      await invalidateVisualMomentReportPdfCache(moment.job_id);
    }
    const [formatted] = await formatRows([row], true);
    return res.json({ moment: formatted });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/visual-moments/:momentId/customer-caption
router.patch('/visual-moments/:momentId/customer-caption', authStack, requireAdmin, async (req, res, next) => {
  try {
    const moment = await loadMoment(req.params.momentId);
    if (!moment) return res.status(404).json({ error: 'Visual note not found' });
    const [row] = await db('visual_service_moments')
      .where({ id: moment.id })
      .update({
        customer_caption: truncateText(req.body?.customerCaption || req.body?.customer_caption || '', 1500),
        updated_at: db.fn.now(),
      })
      .returning('*');
    if (moment.visibility_status === 'approved_customer') {
      await invalidateVisualMomentReportPdfCache(moment.job_id);
    }
    const [formatted] = await formatRows([row], true);
    return res.json({ moment: formatted });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
