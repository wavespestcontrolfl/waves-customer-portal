'use strict';

/**
 * CURRENT lawn-watering restriction policy — the legal ceiling the weekly
 * watering plan sits under (owner ruling 2026-08-28: restrictions are a hard
 * constraint ABOVE the irrigation model, never a clamp applied after it).
 *
 * Source of truth: IRRIGATION_RESTRICTION_POLICY (JSON) in the environment;
 * the checked-in DEFAULT is the SWFWMD Modified Phase III water-shortage
 * order as extended 2026-08-27 — one day per week through 2026-10-01 across
 * Manatee, Sarasota and covered portions of Charlotte.
 *
 * FAIL CLOSED: past `expiresOn` with no newer policy configured there is NO
 * policy — never a silent fallback to "2 days/week". Callers get null and
 * the plan reports itself unavailable (the email keeps its pre-plan copy).
 *
 * Shape: { maxDaysPerWeek, effectiveFrom (YYYY-MM-DD), expiresOn (YYYY-MM-DD,
 * inclusive), label, source, hoursNote }.
 */
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');

const DEFAULT_POLICY = Object.freeze({
  maxDaysPerWeek: 1,
  effectiveFrom: '2026-08-27',
  expiresOn: '2026-10-01',
  label: 'SWFWMD Modified Phase III water shortage order',
  source: 'https://www.swfwmd.state.fl.us/the-newsroom/2026/district-extends-modified-phase-iii-water-shortage',
  hoursNote: 'on your assigned day, during your area\'s allowed hours',
});

// { configured: false } when the variable is unset (default applies);
// { configured: true, policy: null } when it is set but unusable (FAIL
// CLOSED — an operator meant to override, so the default must not apply).
function parseEnvPolicy(raw) {
  if (!raw || !String(raw).trim()) return { configured: false, policy: null };
  try {
    const parsed = JSON.parse(raw);
    return { configured: true, policy: parsed && typeof parsed === 'object' ? parsed : null };
  } catch (err) {
    logger.error(`[irrigation-restrictions] IRRIGATION_RESTRICTION_POLICY is not valid JSON: ${err.message}`);
    return { configured: true, policy: null };
  }
}

function validPolicy(p) {
  if (!p) return false;
  const days = Number(p.maxDaysPerWeek);
  if (!Number.isInteger(days) || days < 0 || days > 7) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.expiresOn || ''))) return false;
  if (p.effectiveFrom && !/^\d{4}-\d{2}-\d{2}$/.test(String(p.effectiveFrom))) return false;
  return true;
}

/**
 * The policy in force on `now` (ET calendar date), or null when none is
 * configured for that date.
 */
function currentRestrictionPolicy(now = new Date(), { env = process.env } = {}) {
  const today = etDateString(now);
  const envPolicy = parseEnvPolicy(env.IRRIGATION_RESTRICTION_POLICY);
  const candidate = envPolicy.configured ? envPolicy.policy : DEFAULT_POLICY;
  if (!validPolicy(candidate)) {
    logger.error('[irrigation-restrictions] restriction policy is malformed — weekly watering plan unavailable');
    return null;
  }
  if (candidate.effectiveFrom && today < candidate.effectiveFrom) return null;
  if (today > candidate.expiresOn) {
    logger.error(`[irrigation-restrictions] restriction policy "${candidate.label}" expired ${candidate.expiresOn} — set IRRIGATION_RESTRICTION_POLICY; weekly watering plan unavailable until then`);
    return null;
  }
  return {
    maxDaysPerWeek: Number(candidate.maxDaysPerWeek),
    effectiveFrom: candidate.effectiveFrom || null,
    expiresOn: candidate.expiresOn,
    label: String(candidate.label || 'local watering restrictions'),
    source: candidate.source || null,
    hoursNote: candidate.hoursNote || null,
  };
}

module.exports = { currentRestrictionPolicy, DEFAULT_POLICY, _private: { validPolicy, parseEnvPolicy } };
