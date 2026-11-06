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
const { isEnabled, settingsGateFlipLive } = require('../config/feature-gates');
const { listGates, gateSetting, mentionedGates, readsOnFor } = require('../services/gate-list');
const { ibFullAccess, requireFullAccess } = require('../services/intelligence-bar/ib-access');
const { decideVoiceRoute } = require('../services/voice-route-decision');

// Each pending OAuth attempt is its own row keyed by `${PREFIX}${stateNonce}`,
// so connecting several locations in a row (or two admins/tabs at once) can't
// clobber each other's state. The legacy single `gbp.oauth_state` key is swept
// on create.
const GBP_OAUTH_STATE_PREFIX = 'gbp.oauth_state:';
const GBP_OAUTH_STATE_LEGACY_KEY = 'gbp.oauth_state';
const GBP_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const GOOGLE_BUSINESS_LOCATION_IDS = new Set(['bradenton', 'parrish', 'sarasota', 'venice']);

async function createGoogleOAuthState(locationId, technician, staffToken) {
  await db('system_settings').where({ key: GBP_OAUTH_STATE_LEGACY_KEY }).del();
  return createStaffOAuthState({
    prefix: GBP_OAUTH_STATE_PREFIX,
    technician,
    staffToken,
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
    const state = await createGoogleOAuthState(locationId, req.technician, req.staffToken);
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

    const state = await createGoogleOAuthState(locationId, req.technician, req.staffToken);
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

async function createLinkedInOAuthState(technician, staffToken) {
  return createStaffOAuthState({
    prefix: LINKEDIN_OAUTH_STATE_PREFIX,
    technician,
    staffToken,
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
    const state = await createLinkedInOAuthState(req.technician, req.staffToken);
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

// GET /api/admin/settings/gates — the live gate list for Settings → Advanced.
// Owner-only: the public /api/health reply stopped carrying gates (#2853).
router.get('/gates', adminAuthenticate, requireAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  // flipAvailable: the switches show only for the owner login while
  // GATE_SETTINGS_GATE_FLIP is on (owner 2026-11-06); everyone else, and
  // everyone while it is off, sees the read-only list as before.
  res.json({ gates: listGates(), flipAvailable: settingsGateFlipLive() && ibFullAccess(req) });
});

// ── Flip a gate from Settings → Features (owner 2026-11-06) ──────────────
// Two steps over the Intelligence Bar's own set_railway_gate write (catalogue
// check, Railway production service only, compare-and-swap on the prior
// value), approved through the bar's pending-action card
// (ib_pending_actions): /preview records exactly that change for this admin;
// /commit claims it with PendingActions.claimForConfirm — one atomic UPDATE,
// so a repeated or concurrent confirm of the same card finds nothing to claim
// (codex #7732) — and writes it, refusing if the gate changed in between.
// Owner login only; 404 while GATE_SETTINGS_GATE_FLIP is off. Turning a gate
// on asks for its name to be typed; off is one click and writes 'false' (some
// gates read a MISSING variable as on, so 'false' is the only value that
// turns every on/off gate off).
// A heuristic for the card's warning, not a block: the description mentions
// customer messages, money, prices or a public link page.
const CUSTOMER_FACING_RE = /\b(sms|texts?|texting|e-?mails?|calls?|charges?|invoices?|refunds?|prices?|pricing|payments?|customers?)\b|\/:token/i;
const gateFlipActor = (req) => String(req.technicianId || req.technician?.id || 'admin');

function gateFlipEnabled(req, res, next) {
  if (!settingsGateFlipLive()) return res.status(404).json({ error: 'Not found' });
  return next();
}

function flippableGateOr404(req, res) {
  const gate = listGates().find((g) => g.name === req.params.name);
  if (!gate) {
    res.status(404).json({ error: 'That is not a gate this portal reads.' });
    return null;
  }
  if (!gate.flippable) {
    res.status(400).json({ error: gate.notFlippableReason, code: 'not_flippable' });
    return null;
  }
  return gate;
}

router.post('/gates/:name/preview', adminAuthenticate, requireAdmin, gateFlipEnabled, requireFullAccess, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const gate = flippableGateOr404(req, res);
    if (!gate) return;
    const value = req.body?.value;
    if (value !== 'true' && value !== 'false') {
      return res.status(400).json({ error: "value must be 'true' or 'false'.", code: 'invalid_value' });
    }
    const { executeOpsTool } = require('../services/intelligence-bar/ops-tools');
    const result = await executeOpsTool('set_railway_gate', { gate_name: gate.name, value });
    if (result?.configured === false) return res.status(503).json({ error: result.message, code: 'railway_not_configured' });
    if (result?.already_set) return res.json({ alreadySet: true, message: result.message });
    if (!result?.preview) return res.status(400).json({ error: result?.error || 'The change could not be prepared.', code: result?.code || null });

    const { outsideWritePins } = require('../services/intelligence-bar/outside-write-pins');
    const pending = await require('../services/intelligence-bar/pending-actions').createPendingAction({
      toolName: 'set_railway_gate',
      params: { gate_name: gate.name, value, ...outsideWritePins('set_railway_gate', result) },
      requestedBy: gateFlipActor(req),
      summary: `Settings → Features: ${result.change}`,
      context: 'settings_gate_flip',
    });
    // Prerequisites the description names, with their current setting, so the
    // card can warn that one reads as off. A warning, never a block.
    const prerequisites = mentionedGates(gate.name, gate.description).map((name) => {
      const setting = gateSetting(name);
      return { name, set: setting.set, value: setting.value, readsOn: readsOnFor(name, require('../config/feature-gates').knownGateCatalog().get(name)) };
    });
    return res.json({
      gate: gate.name,
      description: result.controls,
      currentValue: result.current_value,
      newValue: result.new_value,
      inverted: result.inverted === true,
      meaning: result.meaning,
      redeployNotice: result.redeploy_notice,
      customerFacing: CUSTOMER_FACING_RE.test(String(gate.description || '')),
      prerequisites,
      requireTypedName: value === 'true',
      pendingActionId: pending.id,
    });
  } catch (err) { next(err); }
});

// HTTP status for each outcome recordGateFlipAudit records.
const GATE_FLIP_STATUS = { written: 200, outcome_unknown: 202, target_changed: 409, refused: 400 };

router.post('/gates/:name/commit', adminAuthenticate, requireAdmin, gateFlipEnabled, requireFullAccess, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (!flippableGateOr404(req, res)) return;
    const PendingActions = require('../services/intelligence-bar/pending-actions');
    const id = String(req.body?.pendingActionId || '').trim();
    const actor = gateFlipActor(req);
    // Read before claiming, so a wrong typed name never uses the card up. The
    // claim below returns this same card with its params hash re-checked, so
    // the gate name checked here is the one written.
    const row = id ? await PendingActions.getPendingRow(id, actor).catch(() => null) : null;
    const pins = row?.tool_name === 'set_railway_gate' ? row.params : {};
    if (pins._verified_railway_gate_name !== req.params.name) {
      return res.status(409).json({ error: 'This change card is no longer valid. Open the switch again for a fresh one.', code: 'stale_card' });
    }
    if (pins._verified_railway_gate_value === 'true' && req.body?.confirmName !== req.params.name) {
      return res.status(400).json({ error: 'Type the gate name exactly to turn it on.', code: 'confirm_name_mismatch' });
    }
    const claim = await PendingActions.claimForConfirm(id, actor);
    if (claim.error) {
      return res.status(409).json({ error: 'This change card was already used or has expired. Open the switch again for a fresh one.', code: claim.error });
    }
    const { executeOpsTool, recordGateFlipAudit } = require('../services/intelligence-bar/ops-tools');
    const verified = Object.fromEntries(Object.entries(claim.action.params).filter(([k]) => k.startsWith('_verified_')));
    const result = await executeOpsTool('set_railway_gate', { confirmed: true, ...verified });
    await PendingActions.recordResult(id, result);
    const outcome = await recordGateFlipAudit({
      via: 'settings_page',
      actorId: req.technicianId,
      gate: verified._verified_railway_gate_name,
      value: verified._verified_railway_gate_value,
      priorKind: verified._verified_railway_gate_prior_kind,
      priorValue: verified._verified_railway_gate_prior,
      result,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    return res.status(GATE_FLIP_STATUS[outcome]).json({
      outcome,
      success: outcome === 'written',
      gate: result.gate,
      value: result.value,
      redeployNotice: result.redeploy_notice,
      warning: result.warning,
      error: result.error,
      code: result.code,
    });
  } catch (err) { next(err); }
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
