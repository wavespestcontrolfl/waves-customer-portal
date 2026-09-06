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
// Any explicit irrigation edit confirms that a system exists, including
// legacy rows whose retired toggle is false. Shared by all profile writers.
const IRRIGATION_INPUT_FIELDS = [
  'irrigation_controller_location', 'irrigation_zones', 'irrigation_inches_per_week',
  'irrigation_run_minutes', 'irrigation_schedule_notes', 'watering_days',
  'irrigation_system_type', 'rain_sensor', 'irrigation_issues',
];
const IRRIGATION_SIZING_FIELDS = ['irrigation_run_minutes', 'watering_days', 'irrigation_system_type', 'irrigation_inches_per_week'];
// Watering JURISDICTION after a move: the turf profile's county is evidence
// about the former home until a technician re-saves the profile's county
// for the new one. That save (the only writer of turf county) confirms this
// entry in the same ledger; the profile's row-wide updated_at never does —
// unrelated turf writers (the assessment's grass-type auto-capture, a
// chinch note) bump it without touching the premise (codex gh-r32).
const COUNTY_CONFIRMED_FIELD = 'turf_county';
// Grass type is a property of the LAWN (its Kc sizes the plan): after a move
// it describes the former yard until a writer that actually reviewed the
// current lawn re-establishes it — a turf-profile save that CHANGES the
// grass, or the assessment auto-capture filling a blank profile. Re-saving
// the four sizing fields says nothing about the grass (codex #3565 gh-r41).
const GRASS_CONFIRMED_FIELD = 'turf_grass';
// The rain-sensor flag describes the former home's controller after a move —
// confirmed only when the customer re-saves that field itself (gh-r41).
const RAIN_SENSOR_CONFIRMED_FIELD = 'rain_sensor';
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
  // A confirmed portal schedule outranks the former home's tech reading
  // only when it actually YIELDS a figure: re-confirmed zeros, drip-only or
  // mixed head types derive nothing, so the resolver would fall through to
  // the stale tech number while this guard reported it replaced (codex
  // gh-r47).
  const explicit = Number(row.irrigation_inches_per_week);
  const explicitUsable = ok('irrigation_inches_per_week') && Number.isFinite(explicit) && explicit > 0;
  const { deriveIrrigationInchesPerWeek } = require('@waves/irrigation-runtime');
  const runtimeUsable = RUNTIME_FIELDS.every(ok)
    && deriveIrrigationInchesPerWeek({ runMinutes: row.irrigation_run_minutes, wateringDays: row.watering_days, systemType: row.irrigation_system_type }).inchesPerWeek != null;
  return !(explicitUsable || runtimeUsable);
}

/** The whole move guard: a stamped move AND something unconfirmed to size from. */
function scheduleUnconfirmedAfterMove(row = {}) {
  return !!row.irrigation_home_changed_at && sizingFieldsUnconfirmed(row);
}

/** The turf county was re-saved after the last move (or there was no move). */
function countyConfirmedAfterMove(row = {}) {
  if (!row.irrigation_home_changed_at) return true;
  return parseConfirmed(row.irrigation_confirmed_fields).includes(COUNTY_CONFIRMED_FIELD);
}

/** The grass type was re-established for the current home (or no move). */
function grassConfirmedAfterMove(row = {}) {
  if (!row.irrigation_home_changed_at) return true;
  return parseConfirmed(row.irrigation_confirmed_fields).includes(GRASS_CONFIRMED_FIELD);
}

/** The rain-sensor field was re-saved for the current home (or no move). */
function rainSensorConfirmedAfterMove(row = {}) {
  if (!row.irrigation_home_changed_at) return true;
  return parseConfirmed(row.irrigation_confirmed_fields).includes(RAIN_SENSOR_CONFIRMED_FIELD);
}

/**
 * Add entries to the customer's confirmation set. ONE atomic union over the
 * row's CURRENT value under the customer-scoped preference lock — the same
 * shape the portal autosave uses (codex gh-r26) — so a confirmation that
 * overlaps an address change can never write a pre-move set back over the
 * fan-out's reset. Upserts a minimal row when the customer has no
 * preferences yet (tech-only irrigation readings are common). Given a
 * transaction, joins it — a caller whose OWN write is the evidence (the
 * turf-profile save) commits the two together, so a move that lands between
 * them can never be followed by a confirmation of the former home's county
 * (hook P1 on 45beb0731).
 */
async function confirmIrrigationFields(conn, customerId, fields) {
  const list = (Array.isArray(fields) ? fields : []).filter((f) => typeof f === 'string' && f);
  if (!customerId || !list.length) return 0;
  const run = async (trx) => {
    await trx.raw(
      'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['property-preferences', String(customerId)],
    );
    const union = trx.raw(
      "(SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb) FROM jsonb_array_elements_text(COALESCE(irrigation_confirmed_fields, '[]'::jsonb) || ?::jsonb) AS t(v))",
      [JSON.stringify(list)],
    );
    const n = await trx('property_preferences').where({ customer_id: customerId }).update({ irrigation_confirmed_fields: union });
    if (n) return n;
    await trx('property_preferences')
      .insert({ customer_id: customerId, irrigation_confirmed_fields: JSON.stringify(list) })
      .onConflict('customer_id')
      .merge({ irrigation_confirmed_fields: union });
    return 1;
  };
  return conn.isTransaction ? run(conn) : conn.transaction(run);
}

module.exports = { IRRIGATION_INPUT_FIELDS, IRRIGATION_SIZING_FIELDS, COUNTY_CONFIRMED_FIELD, GRASS_CONFIRMED_FIELD, RAIN_SENSOR_CONFIRMED_FIELD, sizingFieldsUnconfirmed, scheduleUnconfirmedAfterMove, countyConfirmedAfterMove, grassConfirmedAfterMove, rainSensorConfirmedAfterMove, confirmIrrigationFields, parseConfirmedFields: parseConfirmed };
