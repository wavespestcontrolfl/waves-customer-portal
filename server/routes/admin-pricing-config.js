const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET / — all pricing configs
router.get('/', async (req, res, next) => {
  try {
    const { category } = req.query;
    let query = db('pricing_config').orderBy('category').orderBy('sort_order');
    if (category) query = query.where({ category });
    const configs = await query;
    res.json({ configs: configs.map(c => ({ ...c, data: typeof c.data === 'string' ? JSON.parse(c.data) : c.data })) });
  } catch (err) { next(err); }
});

// GET /:key — single config by key
router.get('/:key', async (req, res, next) => {
  try {
    const config = await db('pricing_config').where({ config_key: req.params.key }).first();
    if (!config) return res.status(404).json({ error: 'Config not found' });
    config.data = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
    res.json(config);
  } catch (err) { next(err); }
});

// PUT /:key — update config data
router.put('/:key', async (req, res, next) => {
  try {
    const { data, name, description } = req.body;
    const updates = { updated_at: new Date() };
    if (data !== undefined) updates.data = JSON.stringify(data);
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    const updated = await db('pricing_config').where({ config_key: req.params.key }).update(updates);
    if (!updated) return res.status(404).json({ error: 'Config not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
