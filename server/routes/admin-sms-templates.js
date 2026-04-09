const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET / — list all templates
router.get('/', async (req, res, next) => {
  try {
    const { category } = req.query;
    let query = db('sms_templates').orderBy('category').orderBy('sort_order');
    if (category) query = query.where({ category });
    const templates = await query;
    res.json({ templates });
  } catch (err) { next(err); }
});

// GET /:id — single template
router.get('/:id', async (req, res, next) => {
  try {
    const template = await db('sms_templates').where({ id: req.params.id }).first();
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json(template);
  } catch (err) { next(err); }
});

// PUT /:id — update template body
router.put('/:id', async (req, res, next) => {
  try {
    const { body, name, is_active } = req.body;
    const updates = { updated_at: new Date() };
    if (body !== undefined) updates.body = body;
    if (name !== undefined) updates.name = name;
    if (is_active !== undefined) updates.is_active = is_active;
    await db('sms_templates').where({ id: req.params.id }).update(updates);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST / — create new template
router.post('/', async (req, res, next) => {
  try {
    const { template_key, name, category, body, description, variables, is_internal } = req.body;
    if (!template_key || !name || !body) return res.status(400).json({ error: 'template_key, name, and body required' });
    const [template] = await db('sms_templates').insert({
      template_key, name, category: category || 'custom', body,
      description, variables: variables ? JSON.stringify(variables) : null,
      is_internal: is_internal || false,
    }).returning('*');
    res.status(201).json(template);
  } catch (err) { next(err); }
});

// DELETE /:id — delete template
router.delete('/:id', async (req, res, next) => {
  try {
    await db('sms_templates').where({ id: req.params.id }).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /preview — preview a template with sample data
router.post('/preview', async (req, res) => {
  try {
    const { templateId, sampleData } = req.body;
    const template = await db('sms_templates').where({ id: templateId }).first();
    if (!template) return res.status(404).json({ error: 'Template not found' });
    let preview = template.body;
    for (const [key, val] of Object.entries(sampleData || {})) {
      preview = preview.replace(new RegExp(`\\{${key}\\}`, 'g'), val);
    }
    res.json({ preview, originalLength: template.body.length, previewLength: preview.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
