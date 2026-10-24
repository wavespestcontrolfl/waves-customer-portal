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
 * missing, shown in the bell's "Show full text").
 *
 * State is the notification row, not process memory (docs/admin-notifications.md
 * section 4): the FAILING bell is raised through raiseAdminAlert under a stable
 * dedupe key per route with dedupeOpenOnly, so a failure that persists, or a
 * restart that re-runs the boot canary, updates the one open row and rings
 * nothing new. The SMS goes out only when that raise made a fresh row. When the
 * route answers again the canary clears its own row (closeAdminAlertKeys, "the
 * emitter owns clearing") with a "recovered" resolution and no new bell; a later
 * failure is a fresh row and rings again.
 *
 * Canary requests are provider-billed but tiny (a one-word reply, 4x/day).
 */
const logger = require('./logger');
const MODELS = require('../config/models');

const CANARY_ROUTES = [
  { key: 'smsDraftDefault', route: MODELS.ROUTES.smsDraftDefault, laneId: 'sms_canary_default' },
  { key: 'smsDraftSaveSale', route: MODELS.ROUTES.smsDraftSaveSale, laneId: 'sms_canary_save_sale' },
  // smsToneRewrite is intentionally not probed: same provider+model as
  // smsDraftSaveSale, so its canary would be a duplicate request.
];

const CANARY_PROMPT = 'Health check. Reply with exactly: ok';

// Plain words for the bell headline, per route.
const ROUTE_LABELS = {
  smsDraftDefault: 'text draft',
  smsDraftSaveSale: 'save-sale draft',
};

const alertKey = (key) => `sms-draft-canary:${key}`;

// Raise (or quietly refresh) the one open FAILING bell for this route.
// Returns true when this call made a fresh bell (a new episode).
async function raiseFailing({ key, label, reason }) {
  const { raiseAdminAlert } = require('./admin-alert-compose');
  const dedupeKey = alertKey(key);
  const result = await raiseAdminAlert('system', {
    area: 'System',
    action: `check why the ${ROUTE_LABELS[key] || 'text draft'} model failed`,
    why: 'Text drafts fall back to the flagship model and cost more until it answers again.',
    severity: 'needs-you',
    link: '/admin/communications',
    subject: { type: 'check', id: dedupeKey },
    doneWhen: 'model_answers',
    who: 'person',
  }, {
    detail: `${key} (${label}) failed the canary: ${reason}. Drafts are falling back to ${MODELS.FLAGSHIP} (flagship rates) until this clears. `
      + 'openai_404 = bad model ID, openai_401 or openai_403 = key or access, openai_429 = rate limit, no_key = env var missing.',
    dedupeKey,
    // A row a person or the recovery closed never hides a new outage.
    dedupeOpenOnly: true,
    // A changed reason rewrites the standing row without ringing again.
    refreshOnDedupe: true,
    ringOnRefresh: () => false,
    metadata: { source: 'sms-draft-canary', route: key, reason, model: label },
  });
  // null = the write failed: treat as a fresh episode so Adam still gets the text.
  return !result || (!result.suppressed && !result.deduped);
}

// The route answers: close its open bell, if any. Returns rows closed.
async function closeFailing(key, now = new Date()) {
  const db = require('../models/db');
  const episodes = require('./admin-alert-episodes');
  const dedupeKey = alertKey(key);
  if (!(await episodes.openAdminAlertKeys(db, dedupeKey)).includes(dedupeKey)) return 0;
  const at = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  return Number(await episodes.closeAdminAlertKeys(db, [dedupeKey], 'route_answering', {
    now, resolution: `Recovered at ${at}: the route answers again`,
  })) || 0;
}

async function smsAdam(title, body) {
  try {
    const TwilioService = require('./twilio');
    const phone = process.env.ADAM_PHONE;
    if (phone) {
      // allowOwnerSms: without it, internal_alert to a known owner phone is
      // redirected into the admin-notification trigger — which this canary
      // already fired above, so the redirect would just duplicate the bell
      // and Adam would never get the out-of-band text. The OWNER_SMS_DISABLED
      // kill switch still applies after the bypass.
      await TwilioService.sendSMS(phone, `${title}\n${body}`, {
        messageType: 'internal_alert',
        allowOwnerSms: true,
      });
    }
  } catch (err) {
    logger.error(`[sms-draft-canary] alert SMS failed: ${err.message}`);
  }
}

async function probeRoute({ key, route, laneId }) {
  const { dispatch } = require('./llm/call');
  const result = await dispatch(route, {
    laneId,
    text: CANARY_PROMPT,
    jsonMode: false,
    maxTokens: 16,
  });
  const label = `${route.provider}/${route.model}`;

  if (result.ok && (result.text || '').trim()) {
    let closed = 0;
    try {
      closed = await closeFailing(key);
    } catch (err) {
      logger.error(`[sms-draft-canary] ${key} recovery close failed: ${err.message}`);
    }
    if (closed) {
      logger.info(`[sms-draft-canary] ${key} (${label}) recovered`);
      await smsAdam('SMS draft route recovered', `${key} (${label}) is answering again — drafts are back on the routed model.`);
    }
    return { key, ok: true };
  }

  const reason = result.ok ? 'empty_response' : (result.reason || 'error');
  logger.error(`[sms-draft-canary] ${key} (${label}) FAILED: ${reason}`);
  let fresh = true;
  try {
    fresh = await raiseFailing({ key, label, reason });
  } catch (err) {
    logger.error(`[sms-draft-canary] admin notification failed: ${err.message}`);
  }
  if (fresh) {
    await smsAdam(
      'SMS draft route FAILING',
      `${key} (${label}) failed the canary: ${reason}. Drafts are falling back to ${MODELS.FLAGSHIP} (flagship rates) until this clears.`
    );
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
  _test: { probeRoute, alertKey },
};
