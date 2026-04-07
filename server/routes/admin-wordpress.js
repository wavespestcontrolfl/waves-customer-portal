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
    await ensureTable();
    const sites = await wpManager.getAllSites();
    const sanitized = sites.map((s) => ({
      ...s,
      wp_app_password: s.wp_app_password ? '••••••••' : null,
      has_credentials: !!(s.wp_username && s.wp_app_password),
    }));
    res.json({ sites: sanitized });
  } catch (err) {
    // Table may not exist yet — return hardcoded site list
    if (err.message?.includes('does not exist') || err.message?.includes('relation')) {
      const SITES = [
        { id: '1', domain: 'wavespestcontrol.com', name: 'Waves Pest Control', area: 'Lakewood Ranch', site_type: 'pest_control', status: 'active', webhook_status: 'unknown' },
        { id: '2', domain: 'bradentonflpestcontrol.com', name: 'Bradenton Pest Control', area: 'Bradenton', site_type: 'pest_control', status: 'active', webhook_status: 'unknown' },
        { id: '3', domain: 'sarasotaflpestcontrol.com', name: 'Sarasota Pest Control', area: 'Sarasota', site_type: 'pest_control', status: 'active', webhook_status: 'unknown' },
        { id: '4', domain: 'veniceflpestcontrol.com', name: 'Venice Pest Control', area: 'Venice', site_type: 'pest_control', status: 'active', webhook_status: 'unknown' },
        { id: '5', domain: 'palmettoflpestcontrol.com', name: 'Palmetto Pest Control', area: 'Palmetto', site_type: 'pest_control', status: 'active', webhook_status: 'unknown' },
        { id: '6', domain: 'parrishpestcontrol.com', name: 'Parrish Pest Control', area: 'Parrish', site_type: 'pest_control', status: 'active', webhook_status: 'unknown' },
        { id: '7', domain: 'bradentonflexterminator.com', name: 'Bradenton Exterminators', area: 'Bradenton', site_type: 'exterminator', status: 'active', webhook_status: 'unknown' },
        { id: '8', domain: 'sarasotaflexterminator.com', name: 'Sarasota Exterminators', area: 'Sarasota', site_type: 'exterminator', status: 'active', webhook_status: 'unknown' },
        { id: '9', domain: 'palmettoexterminator.com', name: 'Palmetto Exterminators', area: 'Palmetto', site_type: 'exterminator', status: 'active', webhook_status: 'unknown' },
        { id: '10', domain: 'parrishexterminator.com', name: 'Parrish Exterminators', area: 'Parrish', site_type: 'exterminator', status: 'active', webhook_status: 'unknown' },
        { id: '11', domain: 'bradentonfllawncare.com', name: 'Bradenton Lawn Care', area: 'Bradenton', site_type: 'lawn_care', status: 'active', webhook_status: 'unknown' },
        { id: '12', domain: 'sarasotafllawncare.com', name: 'Sarasota Lawn Care', area: 'Sarasota', site_type: 'lawn_care', status: 'active', webhook_status: 'unknown' },
        { id: '13', domain: 'venicelawncare.com', name: 'Venice Lawn Care', area: 'Venice', site_type: 'lawn_care', status: 'active', webhook_status: 'unknown' },
        { id: '14', domain: 'parrishfllawncare.com', name: 'Parrish Lawn Care', area: 'Parrish', site_type: 'lawn_care', status: 'active', webhook_status: 'unknown' },
        { id: '15', domain: 'waveslawncare.com', name: 'Waves Lawn Care', area: 'Lakewood Ranch', site_type: 'lawn_care', status: 'active', webhook_status: 'unknown' },
      ];
      return res.json({ sites: SITES, migrationPending: true });
    }
    console.error('WordPress sites list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /sites/:id/credentials — save WP username + app password ─────

// Ensure table exists (auto-create if migration hasn't run)
async function ensureTable() {
  const exists = await db.schema.hasTable('wordpress_sites');
  if (!exists) {
    await db.schema.createTable('wordpress_sites', t => {
      t.uuid('id').primary().defaultTo(db.raw("gen_random_uuid()"));
      t.string('domain', 200).unique().notNullable();
      t.string('name', 100);
      t.string('wp_username', 100);
      t.string('wp_app_password', 200);
      t.string('area', 50);
      t.string('site_type', 30);
      t.string('status', 20).defaultTo('active');
      t.timestamp('last_synced_at');
      t.text('last_error');
      t.integer('forms_count').defaultTo(0);
      t.string('webhook_status', 20).defaultTo('unknown');
      t.timestamps(true, true);
    });
    // Seed sites
    const SITES = [
      { domain: 'wavespestcontrol.com', name: 'Waves Pest Control', area: 'Lakewood Ranch', site_type: 'pest_control' },
      { domain: 'bradentonflpestcontrol.com', name: 'Bradenton Pest Control', area: 'Bradenton', site_type: 'pest_control' },
      { domain: 'sarasotaflpestcontrol.com', name: 'Sarasota Pest Control', area: 'Sarasota', site_type: 'pest_control' },
      { domain: 'veniceflpestcontrol.com', name: 'Venice Pest Control', area: 'Venice', site_type: 'pest_control' },
      { domain: 'palmettoflpestcontrol.com', name: 'Palmetto Pest Control', area: 'Palmetto', site_type: 'pest_control' },
      { domain: 'parrishpestcontrol.com', name: 'Parrish Pest Control', area: 'Parrish', site_type: 'pest_control' },
      { domain: 'bradentonflexterminator.com', name: 'Bradenton Exterminators', area: 'Bradenton', site_type: 'exterminator' },
      { domain: 'sarasotaflexterminator.com', name: 'Sarasota Exterminators', area: 'Sarasota', site_type: 'exterminator' },
      { domain: 'palmettoexterminator.com', name: 'Palmetto Exterminators', area: 'Palmetto', site_type: 'exterminator' },
      { domain: 'parrishexterminator.com', name: 'Parrish Exterminators', area: 'Parrish', site_type: 'exterminator' },
      { domain: 'bradentonfllawncare.com', name: 'Bradenton Lawn Care', area: 'Bradenton', site_type: 'lawn_care' },
      { domain: 'sarasotafllawncare.com', name: 'Sarasota Lawn Care', area: 'Sarasota', site_type: 'lawn_care' },
      { domain: 'venicelawncare.com', name: 'Venice Lawn Care', area: 'Venice', site_type: 'lawn_care' },
      { domain: 'parrishfllawncare.com', name: 'Parrish Lawn Care', area: 'Parrish', site_type: 'lawn_care' },
      { domain: 'waveslawncare.com', name: 'Waves Lawn Care', area: 'Lakewood Ranch', site_type: 'lawn_care' },
    ];
    for (const s of SITES) {
      await db('wordpress_sites').insert(s).onConflict('domain').ignore();
    }
    console.log('[wordpress] Auto-created wordpress_sites table with 15 sites');
  }
}

router.post('/sites/:id/credentials', async (req, res) => {
  try {
    await ensureTable();
    const { id } = req.params;
    const { wp_username, wp_app_password } = req.body;

    if (!wp_username || !wp_app_password) {
      return res.status(400).json({ error: 'wp_username and wp_app_password are required' });
    }

    // Find by id or domain
    let site = await db('wordpress_sites').where({ id }).first();
    if (!site) site = await db('wordpress_sites').where({ domain: id }).first();
    if (!site) {
      // Try matching by index (fallback IDs are '1'-'15')
      const idx = parseInt(id) - 1;
      const domains = ['wavespestcontrol.com','bradentonflpestcontrol.com','sarasotaflpestcontrol.com','veniceflpestcontrol.com','palmettoflpestcontrol.com','parrishpestcontrol.com','bradentonflexterminator.com','sarasotaflexterminator.com','palmettoexterminator.com','parrishexterminator.com','bradentonfllawncare.com','sarasotafllawncare.com','venicelawncare.com','parrishfllawncare.com','waveslawncare.com'];
      if (idx >= 0 && idx < domains.length) {
        site = await db('wordpress_sites').where({ domain: domains[idx] }).first();
      }
    }
    if (!site) return res.status(404).json({ error: 'Site not found' });

    await db('wordpress_sites').where({ id: site.id }).update({
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
    await ensureTable();
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
    await ensureTable();
    // Return immediately, run scan in background
    res.json({ status: 'scanning', message: 'Scan started — refresh in 30 seconds to see results' });

    // Run scan async
    wpManager.scanForms(req.params.id).then(result => {
      console.log(`[wp-scan] ${result.domain}: ${result.forms?.length || 0} forms found`);
    }).catch(err => {
      console.error(`[wp-scan] Failed: ${err.message}`);
      db('wordpress_sites').where({ id: req.params.id }).update({ last_error: err.message }).catch(() => {});
    });
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

// GET /api/admin/wordpress/specs/:name — serve spec markdown files
router.get('/specs/:name', (req, res) => {
  const path = require('path');
  const fs = require('fs');
  const name = req.params.name.replace(/[^a-z0-9-]/gi, '');
  const filePath = path.join(__dirname, '..', 'data', 'wordpress-specs', `${name}.md`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Spec not found' });
  res.type('text/markdown').send(fs.readFileSync(filePath, 'utf8'));
});

module.exports = router;
