const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/admin/feature-flags
// Returns every flag_key → enabled mapping for the logged-in user.
// Only flags with a row in user_feature_flags are returned; absence = false.
router.get('/', async (req, res, next) => {
  try {
    const rows = await db('user_feature_flags')
      .where({ user_id: req.technicianId })
      .select('flag_key', 'enabled');
    const flags = {};
    for (const row of rows) flags[row.flag_key] = !!row.enabled;
    res.json({ flags });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/feature-flags/all
// Admin-only matrix for the toggle UI: every user × every flag_key ever seen.
router.get('/all', requireAdmin, async (req, res, next) => {
  try {
    const users = await db('technicians')
      .where({ active: true })
      .whereIn('role', ['admin', 'technician'])
      .orderBy('name')
      .select('id', 'name', 'role');
    const rows = await db('user_feature_flags').select('user_id', 'flag_key', 'enabled');
    const states = {};
    for (const row of rows) {
      if (!states[row.user_id]) states[row.user_id] = {};
      states[row.user_id][row.flag_key] = !!row.enabled;
    }
    const flagKeys = [...new Set(rows.map((r) => r.flag_key))].sort();
    res.json({ users, flag_keys: flagKeys, states });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/feature-flags/toggle
// Admin-only. Body: { user_id, flag_key, enabled }
// Upserts a row; absence of a row = disabled, so "disable" = enabled:false row.
router.post('/toggle', requireAdmin, async (req, res, next) => {
  try {
    const { user_id, flag_key, enabled } = req.body || {};
    if (!user_id || !flag_key || typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'user_id, flag_key, enabled required' });
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(flag_key)) {
      return res.status(400).json({ error: 'flag_key must be kebab-case, 1–64 chars' });
    }
    const user = await db('technicians').where({ id: user_id }).first();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const existing = await db('user_feature_flags')
      .where({ user_id, flag_key })
      .first();

    if (existing) {
      await db('user_feature_flags')
        .where({ id: existing.id })
        .update({ enabled, updated_at: db.fn.now() });
    } else {
      await db('user_feature_flags').insert({
        user_id,
        flag_key,
        enabled,
      });
    }
    res.json({ ok: true, user_id, flag_key, enabled });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
