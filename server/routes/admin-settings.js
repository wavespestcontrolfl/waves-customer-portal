const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const gbp = require('../services/google-business');
const linkedin = require('../services/linkedin');
const logger = require('../services/logger');
const { recordAuditEvent } = require('../services/audit-log');
const { publicPortalUrl } = require('../utils/portal-url');
const {
  createStaffOAuthState,
  withClaimedStaffOAuthState,
} = require('../services/staff-oauth-state');
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
const {
  CALL_ROUTING_CONFIG_KEY,
  DEFAULT_CALL_ROUTING_CONFIG,
  mergeCallRoutingConfig,
} = require('../services/call-routing-config');
const { isEnabled } = require('../config/feature-gates');
const { decideVoiceRoute } = require('../services/voice-route-decision');

// Each pending OAuth attempt is its own row keyed by `${PREFIX}${stateNonce}`,
// so connecting several locations in a row (or two admins/tabs at once) can't
// clobber each other's state. The legacy single `gbp.oauth_state` key is swept
// on create.
const GBP_OAUTH_STATE_PREFIX = 'gbp.oauth_state:';
const GBP_OAUTH_STATE_LEGACY_KEY = 'gbp.oauth_state';
const GBP_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const GOOGLE_BUSINESS_LOCATION_IDS = new Set(['bradenton', 'parrish', 'sarasota', 'venice']);

async function createGoogleOAuthState(locationId, technician) {
  await db('system_settings').where({ key: GBP_OAUTH_STATE_LEGACY_KEY }).del();
  return createStaffOAuthState({
    prefix: GBP_OAUTH_STATE_PREFIX,
    technician,
    ttlMs: GBP_OAUTH_STATE_TTL_MS,
    metadata: { locationId },
    description: 'Google Business Profile OAuth one-time state',
  });
}

async function consumeGoogleOAuthState(rawState, credentialMutation) {
  return withClaimedStaffOAuthState({
    prefix: GBP_OAUTH_STATE_PREFIX,
    rawState: String(rawState || ''),
    validatePayload: (payload) => GOOGLE_BUSINESS_LOCATION_IDS.has(payload.locationId),
    callback: async (payload) => {
      await credentialMutation(payload.locationId);
      return payload.locationId;
    },
  });
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
    const state = await createGoogleOAuthState(locationId, req.technician);
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

    const state = await createGoogleOAuthState(locationId, req.technician);
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
    const locationId = await consumeGoogleOAuthState(
      state,
      (claimedLocationId) => gbp.handleCallback(code, claimedLocationId),
    );
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

async function createLinkedInOAuthState(technician) {
  return createStaffOAuthState({
    prefix: LINKEDIN_OAUTH_STATE_PREFIX,
    technician,
    ttlMs: LINKEDIN_OAUTH_STATE_TTL_MS,
    description: 'LinkedIn OAuth one-time state',
  });
}

async function consumeLinkedInOAuthState(rawState, credentialMutation) {
  return withClaimedStaffOAuthState({
    prefix: LINKEDIN_OAUTH_STATE_PREFIX,
    rawState: String(rawState || ''),
    callback: () => credentialMutation(),
  });
}

// GET /api/admin/settings/linkedin/auth-url — SPA fetches this (bearer), then
// navigates the browser to the returned LinkedIn consent URL. Mirrors GBP.
router.get('/linkedin/auth-url', adminAuthenticate, requireAdmin, async (req, res) => {
  try {
    if (!linkedin.configured) {
      return res.status(400).json({ error: 'LinkedIn not configured — set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET.' });
    }
    const state = await createLinkedInOAuthState(req.technician);
    res.json({ url: linkedin.getAuthUrl(state) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/settings/linkedin/callback — LinkedIn redirects here (public).
// Never echo query params (error/error_description) into the response body:
// reflecting attacker-controlled text on the portal origin is a reflected-XSS
// vector (admin tokens live in localStorage). Log the detail server-side and
// always bounce back to the SPA with a generic outcome flag.
router.get('/linkedin/callback', async (req, res) => {
  const settingsUrl = (outcome) =>
    `${publicPortalUrl()}/admin/settings?tab=integrations&linkedinOAuth=${outcome}`;
  try {
    const { code, state, error, error_description } = req.query;
    if (error) {
      logger.warn(`[admin-settings] LinkedIn OAuth denied: ${String(error_description || error).slice(0, 200)}`);
      return res.redirect(settingsUrl('error'));
    }
    if (!code) return res.redirect(settingsUrl('error'));
    await consumeLinkedInOAuthState(state, () => linkedin.handleCallback(code));
    logger.info('[admin-settings] LinkedIn OAuth connected');
    return res.redirect(settingsUrl('success'));
  } catch (err) {
    logger.error(`LinkedIn OAuth callback failed: ${err.message}`);
    return res.redirect(settingsUrl('error'));
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

// =========================================================================
// Communications — Inbound Call Routing (AI voice backstop) configuration
//
// The `voiceAiAgent` env gate is the hard master switch; this row only tunes
// behaviour WHEN the gate is on. With the gate off (default) none of these
// values are consulted and calls route exactly as they do today.
// =========================================================================

// Live "what would a call do right now" indicator for the admin tab.
router.get('/call-routing/status', adminAuthenticate, requireAdmin, async (req, res, next) => {
  try {
    const row = await db('system_settings').where({ key: CALL_ROUTING_CONFIG_KEY }).first();
    const config = mergeCallRoutingConfig(row?.value);
    const gateEnabled = isEnabled('voiceAiAgent');
    const agentConfigured = !!config.agentEndpoint;
    // What an inbound call would do RIGHT NOW, before staff are dialed.
    const initial = decideVoiceRoute({ phase: 'initial', gateEnabled, config, now: new Date() });

    let effectiveMode;
    if (!gateEnabled) effectiveMode = 'disabled';
    else if (!agentConfigured) effectiveMode = 'no_endpoint';
    else if (initial.action === 'agent') effectiveMode = 'answers_first';
    else if (config.noAnswerBackstopEnabled) effectiveMode = 'backstop_on_no_answer';
    else effectiveMode = 'normal_only';

    res.json({
      gateEnabled,
      agentConfigured,
      effectiveMode,
      answersFirstActiveNow: initial.action === 'agent',
      answersFirstReason: initial.reason,
      noAnswerBackstopEnabled: config.noAnswerBackstopEnabled,
      ringTimeoutSec: config.ringTimeoutSec,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/call-routing', adminAuthenticate, requireAdmin, async (req, res, next) => {
  try {
    const row = await db('system_settings').where({ key: CALL_ROUTING_CONFIG_KEY }).first();
    res.json({
      config: mergeCallRoutingConfig(row?.value),
      defaults: DEFAULT_CALL_ROUTING_CONFIG,
      gateEnabled: isEnabled('voiceAiAgent'),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/call-routing', adminAuthenticate, requireAdmin, async (req, res, next) => {
  try {
    const beforeRow = await db('system_settings').where({ key: CALL_ROUTING_CONFIG_KEY }).first();
    const beforeConfig = mergeCallRoutingConfig(beforeRow?.value);
    const afterConfig = mergeCallRoutingConfig(req.body?.config || req.body || {});

    await db('system_settings')
      .insert({
        key: CALL_ROUTING_CONFIG_KEY,
        value: JSON.stringify(afterConfig),
        category: 'communications',
        description: 'Inbound call routing — AI voice backstop configuration',
        updated_at: new Date(),
      })
      .onConflict('key')
      .merge({
        value: JSON.stringify(afterConfig),
        category: 'communications',
        description: 'Inbound call routing — AI voice backstop configuration',
        updated_at: new Date(),
      });

    await recordAuditEvent({
      actor_type: 'technician',
      actor_id: req.technicianId,
      action: 'communications.call_routing.update',
      resource_type: 'system_setting',
      metadata: {
        key: CALL_ROUTING_CONFIG_KEY,
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

router.post('/call-routing/reset', adminAuthenticate, requireAdmin, async (req, res, next) => {
  try {
    const beforeRow = await db('system_settings').where({ key: CALL_ROUTING_CONFIG_KEY }).first();
    const beforeConfig = mergeCallRoutingConfig(beforeRow?.value);
    const afterConfig = mergeCallRoutingConfig(DEFAULT_CALL_ROUTING_CONFIG);

    await db('system_settings')
      .insert({
        key: CALL_ROUTING_CONFIG_KEY,
        value: JSON.stringify(afterConfig),
        category: 'communications',
        description: 'Inbound call routing — AI voice backstop configuration',
        updated_at: new Date(),
      })
      .onConflict('key')
      .merge({
        value: JSON.stringify(afterConfig),
        category: 'communications',
        description: 'Inbound call routing — AI voice backstop configuration',
        updated_at: new Date(),
      });

    await recordAuditEvent({
      actor_type: 'technician',
      actor_id: req.technicianId,
      action: 'communications.call_routing.reset',
      resource_type: 'system_setting',
      metadata: {
        key: CALL_ROUTING_CONFIG_KEY,
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
