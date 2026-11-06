/**
 * Intelligence Bar speed + effort for the Anthropic /query call.
 *
 * GATE_IB_FAST_MODE (spend gate, dark, read at call time): on a model that
 * supports Claude API fast mode (config/models anthropicSupportsFastMode) the
 * call goes to the beta endpoint with `speed: "fast"` and the
 * fast-mode-2026-02-01 beta. A 429 (fast mode has its own rate limit) or a 400
 * that says fast mode / speed is not supported retries ONCE at standard speed
 * with the exact request the bar sent before this module existed. Any other
 * error propagates unchanged. Gate off, or a model without fast mode: the
 * plain `anthropic.messages.create(params, options)`, byte for byte.
 *
 * INTELLIGENCE_BAR_EFFORT (low|medium|high|xhigh|max): the effort for this
 * call only. Unset or invalid = the global MODEL_ANTHROPIC_EFFORT pin applies.
 *
 * A speed switch invalidates the prompt cache; the trial accepts that.
 */
const MODELS = require('../../config/models');
const logger = require('../logger');
const { ibFastModeLive } = require('../../config/feature-gates');

const FAST_MODE_BETA = 'fast-mode-2026-02-01';
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// The IB-only effort override, or undefined (today's behavior).
function ibRequestedEffort(env = process.env) {
  const level = String(env.INTELLIGENCE_BAR_EFFORT || '').trim().toLowerCase();
  return EFFORT_LEVELS.has(level) ? level : undefined;
}

function fastModeWanted(model) {
  return ibFastModeLive() && MODELS.anthropicSupportsFastMode(model);
}

function errorStatus(err) {
  const status = Number(err && (err.status ?? err.statusCode));
  return Number.isFinite(status) ? status : 0;
}

// A 400 from the API that rejects the fast speed itself (the account or model
// cannot use it), as opposed to a request this server built wrongly.
function fastModeRejected(err) {
  if (errorStatus(err) !== 400) return false;
  const message = String((err && err.message) || '');
  return /fast[\s_-]?mode|\bspeed\b/i.test(message);
}

function fallsBack(err) {
  return errorStatus(err) === 429 || fastModeRejected(err);
}

// The beta call's headers: the SDK sets `anthropic-beta` from `betas`, and a
// header in the request options would replace it, so a caller's beta header
// (tool additions) joins the list instead.
function betaCallShape(params, options) {
  const headers = { ...((options && options.headers) || {}) };
  const betas = [FAST_MODE_BETA];
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== 'anthropic-beta') continue;
    for (const beta of String(headers[key]).split(',')) {
      const name = beta.trim();
      if (name && !betas.includes(name)) betas.push(name);
    }
    delete headers[key];
  }
  const rest = { ...(options || {}) };
  if (Object.keys(headers).length) rest.headers = headers; else delete rest.headers;
  return { body: { ...params, speed: 'fast', betas }, options: Object.keys(rest).length ? rest : undefined };
}

// `anthropic.messages.create(params, options)` for the Intelligence Bar, at
// fast speed when the gate and the model allow it.
async function createIbMessage(anthropic, params, options) {
  if (!fastModeWanted(params && params.model)) return anthropic.messages.create(params, options);
  const beta = betaCallShape(params, options);
  try {
    return await anthropic.beta.messages.create(beta.body, beta.options);
  } catch (err) {
    if (!fallsBack(err)) throw err;
    logger.warn(`[intelligence-bar] fast mode fell back to standard (${errorStatus(err)})`);
    return anthropic.messages.create(params, options);
  }
}

module.exports = { createIbMessage, ibRequestedEffort, fastModeWanted, FAST_MODE_BETA, EFFORT_LEVELS };
