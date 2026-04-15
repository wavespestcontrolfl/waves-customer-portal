/**
 * Admin — Job Form Templates & Submissions
 *
 * Templates: CRUD for per-service-type checklists.
 * Submissions: list + view per-job form responses.
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('./../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');

router.use(adminAuthenticate, requireTechOrAdmin);

// ── Templates ────────────────────────────────────────────────────

// GET /api/admin/job-forms/templates
router.get('/templates', async (_req, res, next) => {
  try {
    const rows = await db('job_form_templates').orderBy('service_type', 'asc');
    res.json({ templates: rows });
  } catch (err) { next(err); }
});

// GET /api/admin/job-forms/templates/:serviceType
router.get('/templates/by-service/:serviceType', async (req, res, next) => {
  try {
    const tpl = await db('job_form_templates')
      .where({ service_type: req.params.serviceType, is_active: true })
      .first();
    if (!tpl) return res.status(404).json({ error: 'No active template' });
    res.json({ template: tpl });
  } catch (err) { next(err); }
});

// POST /api/admin/job-forms/templates
router.post('/templates', async (req, res, next) => {
  try {
    const { service_type, name, description, sections } = req.body;
    if (!service_type || !name || !Array.isArray(sections)) {
      return res.status(400).json({ error: 'service_type, name, sections required' });
    }
    const existing = await db('job_form_templates').where({ service_type }).first();
    if (existing) {
      await db('job_form_templates').where({ id: existing.id }).update({
        name, description: description || null,
        sections: JSON.stringify(sections),
        version: (existing.version || 1) + 1,
        updated_at: db.fn.now(),
      });
      return res.json({ id: existing.id, updated: true });
    }
    const [row] = await db('job_form_templates').insert({
      service_type, name, description: description || null,
      sections: JSON.stringify(sections), is_active: true, version: 1,
    }).returning('*');
    res.json({ template: row, created: true });
  } catch (err) { next(err); }
});

// PUT /api/admin/job-forms/templates/:id
router.put('/templates/:id', async (req, res, next) => {
  try {
    const { name, description, sections, is_active } = req.body;
    const existing = await db('job_form_templates').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const updates = { updated_at: db.fn.now() };
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (sections !== undefined) {
      updates.sections = JSON.stringify(sections);
      updates.version = (existing.version || 1) + 1;
    }
    if (is_active !== undefined) updates.is_active = is_active;

    await db('job_form_templates').where({ id: req.params.id }).update(updates);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Submissions ───────────────────────────────────────────────────

// GET /api/admin/job-forms/submissions?customer_id=&scheduled_service_id=
router.get('/submissions', async (req, res, next) => {
  try {
    const { customer_id, scheduled_service_id, service_record_id, limit = 50 } = req.query;
    let q = db('job_form_submissions as s')
      .leftJoin('job_form_templates as t', 's.template_id', 't.id')
      .leftJoin('customers as c', 's.customer_id', 'c.id')
      .leftJoin('technicians as tech', 's.technician_id', 'tech.id')
      .select(
        's.*',
        't.name as template_name',
        't.service_type',
        'c.first_name', 'c.last_name',
        'tech.name as technician_name',
      )
      .orderBy('s.created_at', 'desc')
      .limit(Number(limit) || 50);

    if (customer_id) q = q.where('s.customer_id', customer_id);
    if (scheduled_service_id) q = q.where('s.scheduled_service_id', scheduled_service_id);
    if (service_record_id) q = q.where('s.service_record_id', service_record_id);

    const rows = await q;
    res.json({ submissions: rows });
  } catch (err) { next(err); }
});

// GET /api/admin/job-forms/submissions/:id
router.get('/submissions/:id', async (req, res, next) => {
  try {
    const sub = await db('job_form_submissions').where({ id: req.params.id }).first();
    if (!sub) return res.status(404).json({ error: 'Not found' });
    const template = await db('job_form_templates').where({ id: sub.template_id }).first();
    res.json({ submission: sub, template });
  } catch (err) { next(err); }
});

module.exports = router;
