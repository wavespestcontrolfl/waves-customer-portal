const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const db = require('../models/db');
const wpManager = require('../services/wordpress-manager');

// All routes require admin auth
router.use(adminAuthenticate);
router.use(requireTechOrAdmin);

// ── GET /sites — list all WordPress sites ──────────────────────────────

router.get('/sites', async (req, res) => {
  try {
    const sites = await wpManager.getAllSites();
    // Strip passwords from response
    const sanitized = sites.map((s) => ({
      ...s,
      wp_app_password: s.wp_app_password ? '••••••••' : null,
      has_credentials: !!(s.wp_username && s.wp_app_password),
    }));
    res.json({ sites: sanitized });
  } catch (err) {
    console.error('WordPress sites list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /sites/:id/credentials — save WP username + app password ─────

router.post('/sites/:id/credentials', async (req, res) => {
  try {
    const { id } = req.params;
    const { wp_username, wp_app_password } = req.body;

    if (!wp_username || !wp_app_password) {
      return res.status(400).json({ error: 'wp_username and wp_app_password are required' });
    }

    const site = await db('wordpress_sites').where({ id }).first();
    if (!site) return res.status(404).json({ error: 'Site not found' });

    await db('wordpress_sites').where({ id }).update({
      wp_username,
      wp_app_password,
      updated_at: new Date(),
    });

    res.json({ success: true, domain: site.domain });
  } catch (err) {
    console.error('Save credentials error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /sites/:id/test — test connection to a WP site ───────────────

router.post('/sites/:id/test', async (req, res) => {
  try {
    const result = await wpManager.testConnection(req.params.id);
    res.json(result);
  } catch (err) {
    console.error('Test connection error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /sites/:id/scan — scan site for Elementor form webhooks ──────

router.post('/sites/:id/scan', async (req, res) => {
  try {
    const result = await wpManager.scanForms(req.params.id);
    res.json(result);
  } catch (err) {
    console.error('Scan forms error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /sites/:id/swap — swap webhooks on a single site ─────────────

router.post('/sites/:id/swap', async (req, res) => {
  try {
    const { old_url, new_url } = req.body;
    if (!old_url || !new_url) {
      return res.status(400).json({ error: 'old_url and new_url are required' });
    }

    const result = await wpManager.swapWebhooks(req.params.id, old_url, new_url);
    res.json(result);
  } catch (err) {
    console.error('Swap webhooks error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /swap-all — swap webhooks across ALL configured sites ────────

router.post('/swap-all', async (req, res) => {
  try {
    const { old_url, new_url } = req.body;
    if (!old_url || !new_url) {
      return res.status(400).json({ error: 'old_url and new_url are required' });
    }

    const result = await wpManager.swapAll(old_url, new_url);
    res.json(result);
  } catch (err) {
    console.error('Swap all webhooks error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /scan-results — latest scan results from DB ────────────────────

router.get('/scan-results', async (req, res) => {
  try {
    const sites = await db('wordpress_sites').orderBy('site_type').orderBy('area');
    const summary = {
      total_sites: sites.length,
      configured: sites.filter((s) => s.wp_username && s.wp_app_password).length,
      by_status: {},
      by_webhook: {},
      sites: sites.map((s) => ({
        id: s.id,
        domain: s.domain,
        name: s.name,
        area: s.area,
        site_type: s.site_type,
        status: s.status,
        forms_count: s.forms_count,
        webhook_status: s.webhook_status,
        last_synced_at: s.last_synced_at,
        last_error: s.last_error,
        has_credentials: !!(s.wp_username && s.wp_app_password),
      })),
    };

    for (const s of sites) {
      summary.by_status[s.status] = (summary.by_status[s.status] || 0) + 1;
      summary.by_webhook[s.webhook_status] = (summary.by_webhook[s.webhook_status] || 0) + 1;
    }

    res.json(summary);
  } catch (err) {
    console.error('Scan results error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
