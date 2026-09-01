'use strict';

// Customer-report egress vocabulary for the specialty closeout lanes. The
// JSON beside this file is the single source: the admin completion presets
// (client/src/lib/service-completion-presets.js) build their dropdown groups
// and dependent-selection rules from it, and this module derives the
// server-side allowlist + combination validation from the same data.
const {
  groups: SPECIALTY_SERVICE_OBSERVATION_GROUPS_BY_KEY,
  exclusions: SPECIALTY_OBSERVATION_EXCLUSIONS_BY_KEY,
} = require('./specialty-service-observations.json');

const SPECIALTY_SERVICE_OBSERVATIONS_BY_KEY = Object.freeze(Object.fromEntries(
  Object.entries(SPECIALTY_SERVICE_OBSERVATION_GROUPS_BY_KEY).map(([key, groups]) => [
    key,
    Object.freeze(groups.flatMap((group) => group.options)),
  ]),
));

const SPECIALTY_SERVICE_KEY_ALIASES = Object.freeze({
  mosquito_monthly: 'mosquito', mosquito_seasonal: 'mosquito', mosquito_one_time: 'mosquito',
  bed_bug: 'bed_bug_treatment',
});

function observationsForSpecialtyService(serviceKey) {
  const key = String(serviceKey || '').trim();
  return SPECIALTY_SERVICE_OBSERVATIONS_BY_KEY[SPECIALTY_SERVICE_KEY_ALIASES[key] || key] || [];
}

function specialtyServiceKey({ serviceKey, serviceType } = {}) {
  const key = String(serviceKey || '').trim();
  const canonical = SPECIALTY_SERVICE_KEY_ALIASES[key] || key;
  if (SPECIALTY_SERVICE_OBSERVATIONS_BY_KEY[canonical]) return canonical;
  const text = String(serviceType || '').toLowerCase();
  if (/mosquito/.test(text)) return 'mosquito';
  if (/dethatch/.test(text)) return 'dethatching';
  if (/lawn\s*plugg|sod\s*plugg/.test(text)) return 'plugging';
  if (/bed\s*bug/.test(text)) return 'bed_bug_treatment';
  if (/fire\s*ant/.test(text)) return 'fire_ant';
  if (/\btick/.test(text)) return 'tick_control';
  if (/mud\s*dauber/.test(text)) return 'mud_dauber_removal';
  if (/\bbee\b|\bwasp\b|yellow\s*jacket|yellowjacket|hornet/.test(text)) return 'bee_wasp_removal';
  return null;
}

// A restored or stale-client payload can carry label combinations the
// dropdown UI never offers (two values from one single-select group, or a
// dependent pair the client reconciles away on selection). The immutable
// customer report must not publish them, so the same rules run server-side.
function validateSpecialtyObservationCombination(serviceKey, values) {
  const canonical = specialtyServiceKey({ serviceKey });
  const selected = new Set(Array.isArray(values) ? values : []);
  for (const group of SPECIALTY_SERVICE_OBSERVATION_GROUPS_BY_KEY[canonical] || []) {
    if (group.options.filter((value) => selected.has(value)).length > 1) {
      return 'Select only one value in each specialty finding group.';
    }
  }
  for (const { value, excludes } of SPECIALTY_OBSERVATION_EXCLUSIONS_BY_KEY[canonical] || []) {
    const excluded = excludes.find((other) => selected.has(other));
    if (selected.has(value) && excluded) {
      return `“${value}” cannot be paired with “${excluded}”.`;
    }
  }
  return null;
}

module.exports = {
  SPECIALTY_SERVICE_OBSERVATION_GROUPS_BY_KEY,
  SPECIALTY_OBSERVATION_EXCLUSIONS_BY_KEY,
  SPECIALTY_SERVICE_OBSERVATIONS_BY_KEY,
  observationsForSpecialtyService,
  specialtyServiceKey,
  validateSpecialtyObservationCombination,
};
