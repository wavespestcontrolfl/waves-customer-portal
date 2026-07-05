/**
 * SMS draft-route canary.
 *
 * The reply-drafting lanes route to external providers (ROUTES.smsDraftDefault
 * → OpenAI mini, ROUTES.smsDraftSaveSale / smsToneRewrite → Claude Sonnet) with
 * a silent fail-closed fallback to FLAGSHIP. That fallback means a bad model
 * ID, revoked key, or provider access/rate-limit denial never breaks drafting —
 * but it also means the failure would only surface as `[sms-shadow] routed
 * draft unavailable` warnings buried under live traffic, while every draft
 * quietly bills at flagship rates.
 *
 * This canary sends one tiny request per distinct route at boot and on a
 * schedule, and alerts (admin bell + internal_alert SMS to Adam) the moment a
 * route stops answering — including the failure reason (openai_404 = bad model
 * ID, openai_401/403 = key/access, openai_429 = rate limit, no_key = env var
 * missing). Alerts are edge-triggered: one alert per distinct failure reason,
 * a re-alert if the same failure persists past REALERT_MS, and a recovery
 * notice when the route answers again. State is in-memory — a restart re-runs
 * the boot canary, which re-alerts if the route is still down.
 *
 * Canary requests are provider-billed but tiny (a one-word reply, 4x/day).
 */
const logger = require('./logger');
const MODELS = require('../config/models');

const CANARY_ROUTES = [
  { key: 'smsDraftDefault', route: MODELS.ROUTES.smsDraftDefault },
  { key: 'smsDraftSaveSale', route: MODELS.ROUTES.smsDraftSaveSale },
  // smsToneRewrite is intentionally not probed: same provider+model as
  // smsDraftSaveSale, so its canary would be a duplicate request.
];

const CANARY_PROMPT = 'Health check. Reply with exactly: ok';
const REALERT_MS = 24 * 60 * 60 * 1000;

// key -> { failingReason: string|null, lastAlertAt: number }
const state = new Map();

async function alertAdmin(title, body) {
  try {
    const NotificationService = require('./notification-service');
    await NotificationService.notifyAdmin('system', title, body, { link: '/admin/communications' });
  } catch (err) {
    logger.error(`[sms-draft-canary] admin notification failed: ${err.message}`);
  }
  try {
    const TwilioService = require('./twilio');
    const phone = process.env.ADAM_PHONE;
    if (phone) {
      await TwilioService.sendSMS(phone, `${title}\n${body}`, { messageType: 'internal_alert' });
    }
  } catch (err) {
    logger.error(`[sms-draft-canary] alert SMS failed: ${err.message}`);
  }
}

async function probeRoute({ key, route }) {
  const { dispatch } = require('./llm/call');
  const result = await dispatch(route, {
    text: CANARY_PROMPT,
    jsonMode: false,
    maxTokens: 16,
  });
  const prev = state.get(key) || { failingReason: null, lastAlertAt: 0 };
  const label = `${route.provider}/${route.model}`;

  if (result.ok && (result.text || '').trim()) {
    if (prev.failingReason) {
      logger.info(`[sms-draft-canary] ${key} (${label}) recovered`);
      await alertAdmin(
        'SMS draft route recovered',
        `${key} (${label}) is answering again — drafts are back on the routed model.`
      );
    }
    state.set(key, { failingReason: null, lastAlertAt: 0 });
    return { key, ok: true };
  }

  const reason = result.ok ? 'empty_response' : (result.reason || 'error');
  const changed = prev.failingReason !== reason;
  const stale = Date.now() - prev.lastAlertAt >= REALERT_MS;
  logger.error(`[sms-draft-canary] ${key} (${label}) FAILED: ${reason}`);
  if (changed || stale) {
    await alertAdmin(
      'SMS draft route FAILING',
      `${key} (${label}) failed the canary: ${reason}. Drafts are falling back to ${MODELS.FLAGSHIP} (flagship rates) until this clears.`
    );
    state.set(key, { failingReason: reason, lastAlertAt: Date.now() });
  } else {
    state.set(key, { failingReason: reason, lastAlertAt: prev.lastAlertAt });
  }
  return { key, ok: false, reason };
}

/**
 * Probe every routed drafting lane. Never throws — a canary crash must not
 * take down the scheduler tick or boot path that runs it.
 */
async function runSmsDraftCanary() {
  const results = [];
  for (const entry of CANARY_ROUTES) {
    try {
      results.push(await probeRoute(entry));
    } catch (err) {
      logger.error(`[sms-draft-canary] probe crashed for ${entry.key}: ${err.message}`);
      results.push({ key: entry.key, ok: false, reason: 'probe_crash' });
    }
  }
  return results;
}

module.exports = {
  runSmsDraftCanary,
  CANARY_ROUTES,
  _test: { probeRoute, state },
};
