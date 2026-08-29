/**
 * Sprinkler settings follow the home. After a primary-address change
 * (property_preferences.irrigation_home_changed_at, stamped by the address
 * fan-out / a merge of different homes) every instruction-shaping figure the
 * weekly plan or the lawn report would size watering from is UNCONFIRMED
 * until the customer re-saves it for the new home:
 *   - portal sizing fields (zone minutes, watering days, head type, typed
 *     inches) — confirmation accrues per field in irrigation_confirmed_fields
 *     (the portal autosaves one field per PUT; the move resets the set);
 *   - a tech-recorded fallback figure (turf profile / latest assessment) —
 *     confirmed only once a complete portal schedule outranks it (typed
 *     inches, or minutes + days + head type), since the customer cannot
 *     re-save a tech reading (codex #3565 gh-r19 … r25).
 * One resolver shared by the sweep and the report so the two never disagree.
 */
const IRRIGATION_SIZING_FIELDS = ['irrigation_run_minutes', 'watering_days', 'irrigation_system_type', 'irrigation_inches_per_week'];
const RUNTIME_FIELDS = ['irrigation_run_minutes', 'watering_days', 'irrigation_system_type'];

function present(v) {
  if (v == null || v === '') return false;
  if (typeof v === 'string' && /^\s*\[\s*\]\s*$/.test(v)) return false;
  return !(Array.isArray(v) && v.length === 0);
}

function parseConfirmed(raw) {
  let list = raw;
  if (typeof raw === 'string') { try { list = JSON.parse(raw); } catch { list = []; } }
  return Array.isArray(list) ? list.filter((f) => typeof f === 'string') : [];
}

/**
 * @param row  the prefs columns (+ optional turf_/assessment_irrigation_inches_per_week)
 * @returns true when ANY figure the plan/report would size from is unconfirmed.
 */
function sizingFieldsUnconfirmed(row = {}) {
  const confirmed = parseConfirmed(row.irrigation_confirmed_fields);
  const ok = (f) => present(row[f]) && confirmed.includes(f);
  if (IRRIGATION_SIZING_FIELDS.some((f) => present(row[f]) && !confirmed.includes(f))) return true;
  const techFallback = present(row.turf_irrigation_inches_per_week) || present(row.assessment_irrigation_inches_per_week);
  if (!techFallback) return false;
  const portalScheduleConfirmed = ok('irrigation_inches_per_week') || RUNTIME_FIELDS.every(ok);
  return !portalScheduleConfirmed;
}

/** The whole move guard: a stamped move AND something unconfirmed to size from. */
function scheduleUnconfirmedAfterMove(row = {}) {
  return !!row.irrigation_home_changed_at && sizingFieldsUnconfirmed(row);
}

module.exports = { IRRIGATION_SIZING_FIELDS, sizingFieldsUnconfirmed, scheduleUnconfirmedAfterMove, parseConfirmedFields: parseConfirmed };
