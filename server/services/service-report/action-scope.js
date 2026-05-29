// Shared scope classifier for completed service actions.
//
// Used by the protocol completion-action builder (admin-protocols) to tag
// live actions, and by the historical advisory backfill to recover scope from
// the action text already stored on old service_records. Keeping it in one
// place means "what counts as an interior treatment" is defined once.
//
// Interior is prioritized over exterior (the conservative safety choice for a
// re-entry/dry-time window). treatmentApplied is false for non-chemical
// actions (inspection / monitoring / declined / no-access) — those must never
// fire the interior re-entry countdown.

const INTERIOR_RE = /\b(interior|inside|indoor|kitchen|bath|bathroom|baseboard|baseboards|bedroom|crack|crevice|void|voids|cabinet|pantry|closet|hinge|hinges|appliance|appliances|plumbing)\b/;
const EXTERIOR_RE = /\b(exterior|outside|outdoor|perimeter|foundation|eave|eaves|soffit|yard|lawn|landscape|mulch|bed|beds|lanai|patio|driveway|fence|window|windows|door|doors|entry)\b/;
// Stems with a leading word boundary but no trailing one, so inflections match
// (inspect/inspection, monitor/monitored, declin/declined, sampl/sampling, …).
const NON_TREATMENT_RE = /\b(inspect|scout|audit|sampl|monitor|declin|unavailabl|skip|no access|not treated|customer not home)/;

function normalizeScopeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function scopeFromText(value) {
  const text = normalizeScopeText(value);
  if (INTERIOR_RE.test(text)) return 'interior';
  if (EXTERIOR_RE.test(text)) return 'exterior';
  return null;
}

function isNonTreatmentText(value) {
  return NON_TREATMENT_RE.test(normalizeScopeText(value));
}

// Returns { scope: 'interior'|'exterior'|null, treatmentApplied: boolean }.
function classifyActionScope(value) {
  const scope = scopeFromText(value);
  return { scope, treatmentApplied: scope != null && !isNonTreatmentText(value) };
}

module.exports = { classifyActionScope, scopeFromText, isNonTreatmentText, normalizeScopeText };
