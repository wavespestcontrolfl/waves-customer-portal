'use strict';

// Specialty closeout vocabulary for the customer-report egress lanes. The
// JSON beside this file is the single source: the admin completion presets
// (client/src/lib/service-completion-presets.js) build their areas, dropdown
// groups, dependent-selection rules and protocol actions from it, and this
// module derives the server-side allowlist + combination validation from
// the same data.
const SPECIALTY_SERVICE_CLOSEOUTS = require('./specialty-service-closeouts.json');

const SPECIALTY_SERVICE_OBSERVATIONS_BY_KEY = Object.freeze(Object.fromEntries(
  Object.entries(SPECIALTY_SERVICE_CLOSEOUTS).map(([key, spec]) => [
    key,
    Object.freeze(spec.findingGroups.flatMap((group) => group.options)),
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
  if (SPECIALTY_SERVICE_CLOSEOUTS[canonical]) return canonical;
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
  const spec = SPECIALTY_SERVICE_CLOSEOUTS[specialtyServiceKey({ serviceKey })];
  if (!spec) return null;
  const selected = new Set(Array.isArray(values) ? values : []);
  for (const group of spec.findingGroups) {
    if (group.options.filter((value) => selected.has(value)).length > 1) {
      return 'Select only one value in each specialty finding group.';
    }
  }
  for (const { value, excludes } of spec.exclusions || []) {
    const excluded = excludes.find((other) => selected.has(other));
    if (selected.has(value) && excluded) {
      return `“${value}” cannot be paired with “${excluded}”.`;
    }
  }
  return null;
}

// Mechanical lanes record work state twice — as a finding (scope / spacing
// group) and as protocol actions. A no-work finding cannot sit beside a
// performed action, and an exclusive no-work action cannot sit beside a
// completed-work finding. Mirrored by specialtyFindingActionConflict on the
// client for selection-time feedback.
function specialtyFindingActionConflict(spec, observations, actionLabels) {
  const workState = spec?.workState;
  if (!workState) return null;
  const byLabel = new Map((spec.protocols || []).map((action) => [action.label, action]));
  const actions = (Array.isArray(actionLabels) ? actionLabels : []).filter((label) => byLabel.has(label));
  const findings = Array.isArray(observations) ? observations : [];
  const noWork = findings.find((value) => workState.noWork.includes(value));
  const performed = actions.find((label) => byLabel.get(label).exclusive !== true);
  if (noWork && performed) return `“${noWork}” cannot be paired with completed action “${performed}”.`;
  const exclusive = actions.find((label) => byLabel.get(label).exclusive === true);
  const completed = findings.find((value) => workState.completed.includes(value));
  if (exclusive && completed) return `“${exclusive}” cannot be paired with finding “${completed}”.`;
  return null;
}

function validateSpecialtyClosureCombination(serviceKey, { observations, actions } = {}) {
  const spec = SPECIALTY_SERVICE_CLOSEOUTS[specialtyServiceKey({ serviceKey })];
  if (!spec) return null;
  return validateSpecialtyObservationCombination(serviceKey, observations)
    || specialtyFindingActionConflict(spec, observations, actions);
}

module.exports = {
  SPECIALTY_SERVICE_CLOSEOUTS,
  SPECIALTY_SERVICE_OBSERVATIONS_BY_KEY,
  observationsForSpecialtyService,
  specialtyServiceKey,
  validateSpecialtyObservationCombination,
  validateSpecialtyClosureCombination,
};
