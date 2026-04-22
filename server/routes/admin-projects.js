/**
 * Admin / Tech — Projects
 *
 * Post-service inspection-and-documentation records: WDO, termite, pest,
 * rodent exclusion, bed bug. Techs create them in the field, admin reviews
 * and sends the customer-facing report at /report/project/:token.
 *
 * Mounted at /api/admin/projects. Both admins and techs can create and
 * edit; only admins can delete or transition status to 'sent' / 'closed'.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const multer = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const db = require('../models/db');
const config = require('../config');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const { PROJECT_TYPES, PROJECT_TYPE_KEYS, isValidProjectType } = require('../services/project-types');

router.use(adminAuthenticate, requireTechOrAdmin);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});
const PHOTO_PREFIX = 'project-photos/';

// ---------------------------------------------------------------------------
// GET /api/admin/projects/types — registry for form rendering
// ---------------------------------------------------------------------------
router.get('/types', (_req, res) => {
  res.json({ types: PROJECT_TYPES, keys: PROJECT_TYPE_KEYS });
});

// ---------------------------------------------------------------------------
// GET /api/admin/projects — list (admin dashboard)
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const { status, project_type, customer_id, tech_id, limit = 100 } = req.query;

    let q = db('projects as p')
      .leftJoin('customers as c', 'p.customer_id', 'c.id')
      .leftJoin('technicians as t', 'p.created_by_tech_id', 't.id')
      .select(
        'p.*',
        'c.first_name', 'c.last_name', 'c.city', 'c.state',
        't.name as tech_name',
      )
      .orderBy('p.created_at', 'desc')
      .limit(Math.min(Number(limit) || 100, 500));

    if (status) q = q.where('p.status', status);
    if (project_type) q = q.where('p.project_type', project_type);
    if (customer_id) q = q.where('p.customer_id', customer_id);
    if (tech_id) q = q.where('p.created_by_tech_id', tech_id);

    const rows = await q;
    const photoCounts = await db('project_photos')
      .whereIn('project_id', rows.map(r => r.id))
      .select('project_id')
      .count('* as n')
      .groupBy('project_id');
    const photoMap = Object.fromEntries(photoCounts.map(x => [x.project_id, Number(x.n)]));

    res.json({
      projects: rows.map(r => ({
        ...r,
        customer_name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
        photo_count: photoMap[r.id] || 0,
      })),
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/admin/projects/:id — single project with photos
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res, next) => {
  try {
    const project = await db('projects as p')
      .where('p.id', req.params.id)
      .leftJoin('customers as c', 'p.customer_id', 'c.id')
      .leftJoin('technicians as t', 'p.created_by_tech_id', 't.id')
      .select(
        'p.*',
        'c.first_name', 'c.last_name', 'c.phone', 'c.email',
        'c.address_line1', 'c.city', 'c.state', 'c.zip',
        't.name as tech_name',
      )
      .first();
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const photos = await db('project_photos')
      .where({ project_id: project.id })
      .orderBy(['visit', 'sort_order', 'created_at']);

    res.json({
      project: {
        ...project,
        customer_name: `${project.first_name || ''} ${project.last_name || ''}`.trim(),
      },
      photos,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/admin/projects — create (tech-facing)
// ---------------------------------------------------------------------------
router.post('/', async (req, res, next) => {
  try {
    const {
      customer_id, project_type, title, findings, recommendations,
      service_record_id, scheduled_service_id,
    } = req.body;

    if (!customer_id) return res.status(400).json({ error: 'customer_id required' });
    if (!isValidProjectType(project_type)) return res.status(400).json({ error: 'Invalid project_type' });

    const [row] = await db('projects').insert({
      customer_id,
      project_type,
      title: title || null,
      findings: findings || null,
      recommendations: recommendations || null,
      service_record_id: service_record_id || null,
      scheduled_service_id: scheduled_service_id || null,
      status: 'draft',
      created_by_tech_id: req.technicianId,
    }).returning('*');

    logger.info(`[projects] created ${row.id} (${project_type}) by tech ${req.technicianId}`);
    res.json({ project: row });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PUT /api/admin/projects/:id — update findings / recommendations / title
// ---------------------------------------------------------------------------
router.put('/:id', async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const updates = {};
    const allowed = ['title', 'findings', 'recommendations', 'followup_date', 'followup_findings'];
    for (const f of allowed) if (req.body[f] !== undefined) updates[f] = req.body[f];
    if (Object.keys(updates).length === 0) return res.json({ project });

    await db('projects').where({ id: req.params.id }).update({ ...updates, updated_at: db.fn.now() });
    const updated = await db('projects').where({ id: req.params.id }).first();
    res.json({ project: updated });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/admin/projects/:id/send — generate token + mark sent
// Admin-only (prevents accidental send by tech before review).
// ---------------------------------------------------------------------------
router.post('/:id/send', requireAdmin, async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const token = project.report_token || crypto.randomBytes(16).toString('hex');
    await db('projects').where({ id: req.params.id }).update({
      status: 'sent',
      report_token: token,
      sent_at: project.sent_at || db.fn.now(),
      updated_at: db.fn.now(),
    });

    logger.info(`[projects] sent ${project.id} token=${token}`);
    res.json({ project_id: project.id, report_token: token, report_url: `/report/project/${token}` });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/admin/projects/:id/close — admin only
// ---------------------------------------------------------------------------
router.post('/:id/close', requireAdmin, async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    await db('projects').where({ id: req.params.id }).update({ status: 'closed', updated_at: db.fn.now() });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/admin/projects/:id/followup — record bed-bug follow-up visit
// ---------------------------------------------------------------------------
router.post('/:id/followup', async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.project_type !== 'bed_bug') {
      return res.status(400).json({ error: 'Follow-up only applies to bed bug projects' });
    }
    const { followup_findings } = req.body;
    await db('projects').where({ id: req.params.id }).update({
      followup_findings: followup_findings || project.followup_findings,
      followup_completed_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
    const updated = await db('projects').where({ id: req.params.id }).first();
    res.json({ project: updated });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Photo endpoints
// ---------------------------------------------------------------------------

// POST /api/admin/projects/:id/photos — multipart upload
router.post('/:id/photos', upload.single('photo'), async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (!config.s3?.bucket) return res.status(500).json({ error: 'S3 not configured' });

    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `${PHOTO_PREFIX}${project.id}/${Date.now()}-${safeName}`;
    await s3.send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));

    const [row] = await db('project_photos').insert({
      project_id: project.id,
      s3_key: key,
      category: req.body.category || null,
      caption: req.body.caption || null,
      visit: req.body.visit === 'followup' ? 'followup' : 'primary',
      uploaded_by_tech_id: req.technicianId,
    }).returning('*');

    res.json({ photo: row });
  } catch (err) { next(err); }
});

// GET /api/admin/projects/:id/photos/:photoId/url — presigned view URL
router.get('/:id/photos/:photoId/url', async (req, res, next) => {
  try {
    const photo = await db('project_photos').where({ id: req.params.photoId, project_id: req.params.id }).first();
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    const url = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: config.s3.bucket, Key: photo.s3_key,
    }), { expiresIn: 3600 });
    res.json({ url });
  } catch (err) { next(err); }
});

// DELETE /api/admin/projects/:id/photos/:photoId — remove a photo
router.delete('/:id/photos/:photoId', async (req, res, next) => {
  try {
    const deleted = await db('project_photos')
      .where({ id: req.params.photoId, project_id: req.params.id })
      .del();
    if (!deleted) return res.status(404).json({ error: 'Photo not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PUT /api/admin/projects/:id/photos/:photoId — update caption / category
router.put('/:id/photos/:photoId', async (req, res, next) => {
  try {
    const updates = {};
    for (const f of ['caption', 'category', 'sort_order']) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }
    if (Object.keys(updates).length === 0) return res.json({ ok: true });
    await db('project_photos')
      .where({ id: req.params.photoId, project_id: req.params.id })
      .update({ ...updates, updated_at: db.fn.now() });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
