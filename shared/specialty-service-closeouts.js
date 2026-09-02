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

// Lane resolution is data-driven from specialty-service-keys.json so the
// client presets (service-completion-presets.js) resolve identically. A
// completion profile key is authoritative: when the schedule row carries one
// that is not a specialty lane (e.g. the typed flea_tick profile whose frozen
// display name still reads "Flea & Tick"), the display-name fallback must NOT
// run — it is only for legacy rows with no profile key (codex P1 r9 #3701).
const { aliases: SERVICE_KEY_ALIASES, serviceTypePatterns: SERVICE_TYPE_PATTERNS } = require('./specialty-service-keys.json');

function observationsForSpecialtyService(serviceKey) {
  const key = String(serviceKey || '').trim();
  return SPECIALTY_SERVICE_OBSERVATIONS_BY_KEY[SERVICE_KEY_ALIASES[key] || key] || [];
}

function specialtyServiceKey({ serviceKey, serviceType } = {}) {
  const key = String(serviceKey || '').trim();
  if (key) {
    const canonical = SERVICE_KEY_ALIASES[key] || key;
    return SPECIALTY_SERVICE_CLOSEOUTS[canonical] ? canonical : null;
  }
  const text = String(serviceType || '').toLowerCase();
  const match = SERVICE_TYPE_PATTERNS.find(({ pattern }) => new RegExp(pattern).test(text));
  return match ? match.key : null;
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
// group) and as protocol actions. workState.noWork maps each no-work finding
// to the exclusive actions that explain it; a no-work finding cannot sit
// beside a performed action or a different no-work explanation, and an
// exclusive action cannot sit beside a completed-work finding. Mirrored by
// specialtyFindingActionConflict on the client for selection-time feedback.
function specialtyFindingActionConflict(spec, observations, actionLabels) {
  if (!spec) return null;
  const byLabel = new Map((spec.protocols || []).map((action) => [action.label, action]));
  const actions = (Array.isArray(actionLabels) ? actionLabels : []).filter((label) => byLabel.has(label));
  const findings = Array.isArray(observations) ? observations : [];
  // Pest lanes: a no-evidence / inactive finding cannot sit beside a treatment
  // of active pests (codex P2 r11 #3701).
  for (const { value, excludesActions } of spec.findingActionExclusions || []) {
    const clash = findings.includes(value) && actions.find((label) => excludesActions.includes(label));
    if (clash) return `“${value}” cannot be paired with action “${clash}”.`;
  }
  const workState = spec.workState;
  if (!workState) return null;
  const noWorkFindings = findings.filter((value) => Object.prototype.hasOwnProperty.call(workState.noWork, value));
  const performed = actions.find((label) => byLabel.get(label).exclusive !== true);
  if (noWorkFindings.length && performed) {
    return `“${noWorkFindings[0]}” cannot be paired with completed action “${performed}”.`;
  }
  const exclusive = actions.find((label) => byLabel.get(label).exclusive === true);
  const completed = findings.find((value) => workState.completed.includes(value));
  if (exclusive && completed) return `“${exclusive}” cannot be paired with finding “${completed}”.`;
  const mismatched = exclusive && noWorkFindings.find((value) => !workState.noWork[value].includes(exclusive));
  if (mismatched) return `“${mismatched}” cannot be paired with action “${exclusive}”.`;
  return null;
}

// An exclusive action (inspection-only, deferred, no treatment recommended)
// stands alone: no other preset action and no applied product may accompany
// it. The client reconciles this on selection (reconcileExclusiveProtocolSelections,
// exclusiveProtocolSelectionConflict, exclusiveProtocolProductConflict); the
// server enforces it independently for stale or direct API clients.
function exclusiveSpecialtyActionConflict(spec, actionLabels, productCount) {
  const byLabel = new Map((spec.protocols || []).map((action) => [action.label, action]));
  const actions = (Array.isArray(actionLabels) ? actionLabels : []).filter((label) => byLabel.has(label));
  const exclusive = actions.find((label) => byLabel.get(label).exclusive === true);
  if (!exclusive) return null;
  if (actions.length > 1) {
    return `Clear “${exclusive}” or remove the other completed actions before submitting.`;
  }
  if (Number(productCount) > 0) {
    return `Remove applied products or clear “${exclusive}” before completing this visit.`;
  }
  return null;
}

// Specialty lanes complete with their preset actions only. A stale tab or
// direct API client can still submit an obsolete dynamic-protocol label; it
// must be refused rather than silently persisted into the immutable report
// inputs (codex P2 r10 #3701).
function offPresetSpecialtyAction(spec, actionLabels) {
  const known = new Set((spec.protocols || []).map((action) => action.label));
  const unknown = (Array.isArray(actionLabels) ? actionLabels : []).find((label) => !known.has(label));
  return unknown ? `“${unknown}” is not a protocol action for this service.` : null;
}

// `enforcePresetActions` is true only when the completion profile explicitly
// names the specialty lane. A keyless legacy row matched by display name may
// still carry the dynamic-protocol actions its older client offered; those
// stay accepted (and are simply not part of the preset checks) so an open
// draft can complete (local audit P1 on #3701).
function validateSpecialtyClosureCombination(serviceKey, { observations, actions, productCount = 0, enforcePresetActions = true } = {}) {
  const spec = SPECIALTY_SERVICE_CLOSEOUTS[specialtyServiceKey({ serviceKey })];
  if (!spec) return null;
  return validateSpecialtyObservationCombination(serviceKey, observations)
    || (enforcePresetActions ? offPresetSpecialtyAction(spec, actions) : null)
    || exclusiveSpecialtyActionConflict(spec, actions, productCount)
    || specialtyFindingActionConflict(spec, observations, actions);
}

// Specialty action scope follows the treated areas when every classified
// area (treatment-area-scopes.json) sits on one side; mixed or unclassified
// areas keep the preset default. Mirrored by specialtyActionScope in
// SchedulePage.jsx; the server derives the persisted metadata from the
// preset so a stale or crafted client can never mark an inspection as
// treated or a real productless treatment as untreated (local audit P1).
const AREA_SCOPES = require('./treatment-area-scopes.json');

function specialtyActionScopeForAreas(areas, defaultScope) {
  const scopes = new Set((Array.isArray(areas) ? areas : [])
    .map((area) => {
      const label = String(area || '').trim();
      if (AREA_SCOPES.interior.includes(label)) return 'interior';
      if (AREA_SCOPES.exterior.includes(label)) return 'exterior';
      return null;
    })
    .filter(Boolean));
  return scopes.size === 1 ? [...scopes][0] : defaultScope;
}

function specialtyProtocolActionScopes(serviceKey, { actions, areas } = {}) {
  const spec = SPECIALTY_SERVICE_CLOSEOUTS[specialtyServiceKey({ serviceKey })];
  if (!spec) return null;
  const byLabel = new Map((spec.protocols || []).map((action) => [action.label, action]));
  return (Array.isArray(actions) ? actions : [])
    .filter((label) => byLabel.has(label))
    .map((label) => ({
      label,
      scope: specialtyActionScopeForAreas(areas, byLabel.get(label).scope),
      // treatmentApplied = a pesticide/product application (drives applicationMade,
      // re-entry evidence and weather-at-application copy). treatmentPerformed =
      // treatment occurred, chemical or not (heat, steam) — keeps aftercare and
      // the stored re-entry guidance without claiming pesticide use.
      treatmentApplied: byLabel.get(label).treatmentApplied === true,
      treatmentPerformed: byLabel.get(label).treatmentApplied === true || byLabel.get(label).treatmentPerformed === true,
    }));
}

// Specialty lanes complete with their preset areas. A stale pre-preset tab can
// still submit a former generic chip ("Kitchen" on a fire-ant visit); on an
// explicitly profiled lane that is refused, and on a keyless legacy row only
// the lane's own legacy generic vocabulary is tolerated — never a value the
// shared area map could read as the wrong side (codex P1 r13 #3701).
const LEGACY_COMPLETION_AREAS = require('./legacy-completion-areas.json');
const SPECIALTY_LEGACY_AREA_CATEGORY = Object.freeze({
  dethatching: 'lawn', plugging: 'lawn', mosquito: 'mosquito', fire_ant: 'pest', tick_control: 'pest',
  bee_wasp_removal: 'pest', mud_dauber_removal: 'pest', bed_bug_treatment: 'bed_bug',
});

function validateSpecialtyAreas(serviceKey, areas, { enforcePresetAreas = true } = {}) {
  const canonical = specialtyServiceKey({ serviceKey });
  const spec = SPECIALTY_SERVICE_CLOSEOUTS[canonical];
  if (!spec) return null;
  const allowed = new Set(spec.areas);
  if (!enforcePresetAreas) {
    (LEGACY_COMPLETION_AREAS.categories[SPECIALTY_LEGACY_AREA_CATEGORY[canonical]] || []).forEach((area) => allowed.add(area));
  }
  const invalid = (Array.isArray(areas) ? areas : []).find((area) => !allowed.has(String(area || '').trim()));
  return invalid ? `“${invalid}” is not a treatment area for this service.` : null;
}

module.exports = {
  validateSpecialtyAreas,
  specialtyActionScopeForAreas,
  specialtyProtocolActionScopes,
  SPECIALTY_SERVICE_CLOSEOUTS,
  SPECIALTY_SERVICE_OBSERVATIONS_BY_KEY,
  observationsForSpecialtyService,
  specialtyServiceKey,
  validateSpecialtyObservationCombination,
  validateSpecialtyClosureCombination,
};
