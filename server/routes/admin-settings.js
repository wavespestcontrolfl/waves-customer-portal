const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const gbp = require('../services/google-business');
const linkedin = require('../services/linkedin');
const logger = require('../services/logger');
const { recordAuditEvent } = require('../services/audit-log');
const { publicPortalUrl } = require('../utils/portal-url');
const {
  DEFAULT_SERVICE_COVERAGE_CONFIG,
  SERVICE_COVERAGE_CONFIG_KEY,
  mergeServiceCoverageConfig,
} = require('../services/service-report/service-coverage');
const {
  DEFAULT_VISIT_TIMELINE_CONFIG,
  VISIT_TIMELINE_CONFIG_KEY,
  mergeVisitTimelineConfig,
} = require('../services/service-report/visit-timeline');

// Each pending OAuth attempt is its own row keyed by `${PREFIX}${stateNonce}`,
// so connecting several locations in a row (or two admins/tabs at once) can't
// clobber each other's state. The legacy single `gbp.oauth_state` key is swept
// on create.
const GBP_OAUTH_STATE_PREFIX = 'gbp.oauth_state:';
const GBP_OAUTH_STATE_LEGACY_KEY = 'gbp.oauth_state';
const GBP_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const GOOGLE_BUSINESS_LOCATION_IDS = new Set(['bradenton', 'parrish', 'sarasota', 'venice']);

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function createGoogleOAuthState(locationId, technicianId) {
  const state = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + GBP_OAUTH_STATE_TTL_MS);

  // Sweep the deprecated single-key row and any expired pending states so
  // rows don't accumulate. The current attempt gets its own nonce-keyed row.
  const cutoff = new Date(now.getTime() - GBP_OAUTH_STATE_TTL_MS);
  await db('system_settings')
    .where('key', GBP_OAUTH_STATE_LEGACY_KEY)
    .orWhere((b) =>
      b.where('key', 'like', `${GBP_OAUTH_STATE_PREFIX}%`).andWhere('updated_at', '<', cutoff),
    )
    .del();

  await db('system_settings').insert({
    key: `${GBP_OAUTH_STATE_PREFIX}${state}`,
    value: JSON.stringify({
      state,
      locationId,
      technicianId: technicianId || null,
      expiresAt: expiresAt.toISOString(),
    }),
    category: 'integrations',
    description: 'Google Business Profile OAuth one-time state',
    created_at: now,
    updated_at: now,
  });
  return state;
}

async function consumeGoogleOAuthState(rawState) {
  const state = String(rawState || '');
  if (!state) {
    logger.warn('[admin-settings] GBP OAuth callback rejected: missing state');
    throw new Error('Invalid or expired OAuth state');
  }
  const key = `${GBP_OAUTH_STATE_PREFIX}${state}`;
  const row = await db('system_settings').where({ key }).first();
  const saved = parseJsonObject(row?.value);
  const expiresAt = saved.expiresAt ? new Date(saved.expiresAt) : null;
  if (
    !saved.state
    || saved.state !== state
    || !saved.locationId
    || !GOOGLE_BUSINESS_LOCATION_IDS.has(saved.locationId)
    || !expiresAt
    || expiresAt < new Date()
  ) {
    logger.warn('[admin-settings] GBP OAuth callback rejected: invalid or expired state');
    if (row) await db('system_settings').where({ key }).del();
    throw new Error('Invalid or expired OAuth state');
  }

  await db('system_settings').where({ key }).del(); // one-time use
  return saved.locationId;
}

// =========================================================================
// Google Business Profile OAuth — per-location authorization
// =========================================================================

// GET /api/admin/settings/google/auth-url?location=sarasota
// SPA-friendly variant: returns the Google consent URL as JSON. The admin
// SPA calls this WITH its bearer token, then navigates the browser to the
// returned url. A top-level redirect to /google/auth can't carry the
// Authorization header (admin auth is bearer-only), so the SPA must fetch
// the url here and redirect itself. Mirrors the Gmail /oauth/auth-url flow.
router.get('/google/auth-url', adminAuthenticate, requireAdmin, async (req, res) => {
  try {
    const locationId = String(req.query.location || '');
    if (!GOOGLE_BUSINESS_LOCATION_IDS.has(locationId)) {
      return res.status(400).json({ error: 'Unknown location. Use: bradenton, parrish, sarasota, or venice' });
    }
    const state = await createGoogleOAuthState(locationId, req.technicianId);
    const url = gbp.getAuthUrl(locationId, state);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/settings/google/auth?location=sarasota
// Redirects to Google OAuth consent screen. Kept for manual/non-SPA use, but
// requires a bearer header — the SPA uses /google/auth-url above instead.
router.get('/google/auth', adminAuthenticate, requireAdmin, async (req, res) => {
  try {
    const locationId = String(req.query.location || '');
    if (!locationId) return res.status(400).send('Missing ?location= parameter. Use: bradenton, parrish, sarasota, or venice');
    if (!GOOGLE_BUSINESS_LOCATION_IDS.has(locationId)) return res.status(400).send('Unknown location. Use: bradenton, parrish, sarasota, or venice');

    const state = await createGoogleOAuthState(locationId, req.technicianId);
    const authUrl = gbp.getAuthUrl(locationId, state);
    res.redirect(authUrl);
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

// GET /api/admin/settings/google/callback — OAuth callback
// Google redirects here after user authorizes.
router.get('/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing authorization code');
    const locationId = await consumeGoogleOAuthState(state);

    await gbp.handleCallback(code, locationId);
    logger.info(`[admin-settings] GBP OAuth connected for ${locationId}`);

    const clientUrl = publicPortalUrl();
    res.redirect(`${clientUrl}/admin/settings?tab=integrations&gbpOAuth=success&location=${encodeURIComponent(locationId)}`);
  } catch (err) {
    logger.error(`GBP OAuth callback failed: ${err.message}`);
    res.status(500).send(`OAuth failed: ${err.message}`);
  }
});

// =========================================================================
// LinkedIn OAuth — single owned company page (mirrors the GBP nonce pattern)
// =========================================================================
const LINKEDIN_OAUTH_STATE_PREFIX = 'linkedin.oauth_state:';
const LINKEDIN_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

async function createLinkedInOAuthState(technicianId) {
  const state = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const cutoff = new Date(now.getTime() - LINKEDIN_OAUTH_STATE_TTL_MS);
  // Sweep expired pending states so rows don't accumulate.
  await db('system_settings')
    .where('key', 'like', `${LINKEDIN_OAUTH_STATE_PREFIX}%`)
    .andWhere('updated_at', '<', cutoff)
    .del();
  await db('system_settings').insert({
    key: `${LINKEDIN_OAUTH_STATE_PREFIX}${state}`,
    value: JSON.stringify({
      state,
      technicianId: technicianId || null,
      expiresAt: new Date(now.getTime() + LINKEDIN_OAUTH_STATE_TTL_MS).toISOString(),
    }),
    category: 'integrations',
    description: 'LinkedIn OAuth one-time state',
    created_at: now,
    updated_at: now,
  });
  return state;
}

async function consumeLinkedInOAuthState(rawState) {
  const state = String(rawState || '');
  if (!state) throw new Error('Invalid or expired OAuth state');
  const key = `${LINKEDIN_OAUTH_STATE_PREFIX}${state}`;
  const row = await db('system_settings').where({ key }).first();
  const saved = parseJsonObject(row?.value);
  const expiresAt = saved.expiresAt ? new Date(saved.expiresAt) : null;
  if (!saved.state || saved.state !== state || !expiresAt || expiresAt < new Date()) {
    if (row) await db('system_settings').where({ key }).del();
    logger.warn('[admin-settings] LinkedIn OAuth callback rejected: invalid or expired state');
    throw new Error('Invalid or expired OAuth state');
  }
  await db('system_settings').where({ key }).del(); // one-time use
  return true;
}

// GET /api/admin/settings/linkedin/auth-url — SPA fetches this (bearer), then
// navigates the browser to the returned LinkedIn consent URL. Mirrors GBP.
router.get('/linkedin/auth-url', adminAuthenticate, requireAdmin, async (req, res) => {
  try {
    if (!linkedin.configured) {
      return res.status(400).json({ error: 'LinkedIn not configured — set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET.' });
    }
    const state = await createLinkedInOAuthState(req.technicianId);
    res.json({ url: linkedin.getAuthUrl(state) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/settings/linkedin/callback — LinkedIn redirects here (public).
router.get('/linkedin/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) return res.status(400).send(`LinkedIn authorization failed: ${error_description || error}`);
    if (!code) return res.status(400).send('Missing authorization code');
    await consumeLinkedInOAuthState(state);
    await linkedin.handleCallback(code);
    logger.info('[admin-settings] LinkedIn OAuth connected');
    const clientUrl = publicPortalUrl();
    res.redirect(`${clientUrl}/admin/settings?tab=integrations&linkedinOAuth=success`);
  } catch (err) {
    logger.error(`LinkedIn OAuth callback failed: ${err.message}`);
    res.status(500).send(`OAuth failed: ${err.message}`);
  }
});

// GET /api/admin/settings/linkedin/status — connection status for the UI.
router.get('/linkedin/status', adminAuthenticate, requireAdmin, async (req, res) => {
  try {
    res.json(await linkedin.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// Service Reports — Service Coverage customer report configuration
// =========================================================================

router.get('/service-coverage', adminAuthenticate, requireAdmin, async (req, res, next) => {
  try {
    const row = await db('system_settings').where({ key: SERVICE_COVERAGE_CONFIG_KEY }).first();
    res.json({
      config: mergeServiceCoverageConfig(row?.value),
      defaults: DEFAULT_SERVICE_COVERAGE_CONFIG,
    });
  } catch (err) {
    next(err);
  }
});

router.put('/service-coverage', adminAuthenticate, requireAdmin, async (req, res, next) => {
  try {
    const beforeRow = await db('system_settings').where({ key: SERVICE_COVERAGE_CONFIG_KEY }).first();
    const beforeConfig = mergeServiceCoverageConfig(beforeRow?.value);
    const afterConfig = mergeServiceCoverageConfig(req.body?.config || req.body || {});

    await db('system_settings')
      .insert({
        key: SERVICE_COVERAGE_CONFIG_KEY,
        value: JSON.stringify(afterConfig),
        category: 'service_reports',
        description: 'Customer-facing Service Coverage report card configuration',
        updated_at: new Date(),
      })
      .onConflict('key')
      .merge({
        value: JSON.stringify(afterConfig),
        category: 'service_reports',
        description: 'Customer-facing Service Coverage report card configuration',
        updated_at: new Date(),
      });

    await recordAuditEvent({
      actor_type: 'technician',
      actor_id: req.technicianId,
      action: 'service_reports.service_coverage.update',
      resource_type: 'system_setting',
      metadata: {
        key: SERVICE_COVERAGE_CONFIG_KEY,
        beforeJson: beforeConfig,
        afterJson: afterConfig,
      },
      ip_address: req.ip,
      user_agent: req.get('user-agent'),
    });

    res.json({ success: true, config: afterConfig });
  } catch (err) {
    next(err);
  }
});

router.post('/service-coverage/reset', adminAuthenticate, requireAdmin, async (req, res, next) => {
  try {
    const beforeRow = await db('system_settings').where({ key: SERVICE_COVERAGE_CONFIG_KEY }).first();
    const beforeConfig = mergeServiceCoverageConfig(beforeRow?.value);
    const afterConfig = mergeServiceCoverageConfig(DEFAULT_SERVICE_COVERAGE_CONFIG);

    await db('system_settings')
      .insert({
        key: SERVICE_COVERAGE_CONFIG_KEY,
        value: JSON.stringify(afterConfig),
        category: 'service_reports',
        description: 'Customer-facing Service Coverage report card configuration',
        updated_at: new Date(),
      })
      .onConflict('key')
      .merge({
        value: JSON.stringify(afterConfig),
        category: 'service_reports',
        description: 'Customer-facing Service Coverage report card configuration',
        updated_at: new Date(),
      });

    await recordAuditEvent({
      actor_type: 'technician',
      actor_id: req.technicianId,
      action: 'service_reports.service_coverage.reset',
      resource_type: 'system_setting',
      metadata: {
        key: SERVICE_COVERAGE_CONFIG_KEY,
        beforeJson: beforeConfig,
        afterJson: afterConfig,
      },
      ip_address: req.ip,
      user_agent: req.get('user-agent'),
    });

    res.json({ success: true, config: afterConfig });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// Service Reports — Visit Timeline customer report configuration
// =========================================================================

router.get('/visit-timeline', adminAuthenticate, requireAdmin, async (req, res, next) => {
  try {
    const row = await db('system_settings').where({ key: VISIT_TIMELINE_CONFIG_KEY }).first();
    res.json({
      config: mergeVisitTimelineConfig(row?.value),
      defaults: DEFAULT_VISIT_TIMELINE_CONFIG,
    });
  } catch (err) {
    next(err);
  }
});

router.put('/visit-timeline', adminAuthenticate, requireAdmin, async (req, res, next) => {
  try {
    const beforeRow = await db('system_settings').where({ key: VISIT_TIMELINE_CONFIG_KEY }).first();
    const beforeConfig = mergeVisitTimelineConfig(beforeRow?.value);
    const afterConfig = mergeVisitTimelineConfig(req.body?.config || req.body || {});

    await db('system_settings')
      .insert({
        key: VISIT_TIMELINE_CONFIG_KEY,
        value: JSON.stringify(afterConfig),
        category: 'service_reports',
        description: 'Customer-facing Visit Timeline report card configuration',
        updated_at: new Date(),
      })
      .onConflict('key')
      .merge({
        value: JSON.stringify(afterConfig),
        category: 'service_reports',
        description: 'Customer-facing Visit Timeline report card configuration',
        updated_at: new Date(),
      });

    await recordAuditEvent({
      actor_type: 'technician',
      actor_id: req.technicianId,
      action: 'service_reports.visit_timeline.update',
      resource_type: 'system_setting',
      metadata: {
        key: VISIT_TIMELINE_CONFIG_KEY,
        beforeJson: beforeConfig,
        afterJson: afterConfig,
      },
      ip_address: req.ip,
      user_agent: req.get('user-agent'),
    });

    res.json({ success: true, config: afterConfig });
  } catch (err) {
    next(err);
  }
});

router.post('/visit-timeline/reset', adminAuthenticate, requireAdmin, async (req, res, next) => {
  try {
    const beforeRow = await db('system_settings').where({ key: VISIT_TIMELINE_CONFIG_KEY }).first();
    const beforeConfig = mergeVisitTimelineConfig(beforeRow?.value);
    const afterConfig = mergeVisitTimelineConfig(DEFAULT_VISIT_TIMELINE_CONFIG);

    await db('system_settings')
      .insert({
        key: VISIT_TIMELINE_CONFIG_KEY,
        value: JSON.stringify(afterConfig),
        category: 'service_reports',
        description: 'Customer-facing Visit Timeline report card configuration',
        updated_at: new Date(),
      })
      .onConflict('key')
      .merge({
        value: JSON.stringify(afterConfig),
        category: 'service_reports',
        description: 'Customer-facing Visit Timeline report card configuration',
        updated_at: new Date(),
      });

    await recordAuditEvent({
      actor_type: 'technician',
      actor_id: req.technicianId,
      action: 'service_reports.visit_timeline.reset',
      resource_type: 'system_setting',
      metadata: {
        key: VISIT_TIMELINE_CONFIG_KEY,
        beforeJson: beforeConfig,
        afterJson: afterConfig,
      },
      ip_address: req.ip,
      user_agent: req.get('user-agent'),
    });

    res.json({ success: true, config: afterConfig });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
