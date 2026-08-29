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
// Watering JURISDICTION after a move: the turf profile's county is evidence
// about the former home until a technician re-saves the profile's county
// for the new one. That save (the only writer of turf county) confirms this
// entry in the same ledger; the profile's row-wide updated_at never does —
// unrelated turf writers (the assessment's grass-type auto-capture, a
// chinch note) bump it without touching the premise (codex gh-r32).
const COUNTY_CONFIRMED_FIELD = 'turf_county';
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

/** The turf county was re-saved after the last move (or there was no move). */
function countyConfirmedAfterMove(row = {}) {
  if (!row.irrigation_home_changed_at) return true;
  return parseConfirmed(row.irrigation_confirmed_fields).includes(COUNTY_CONFIRMED_FIELD);
}

/**
 * Add entries to the customer's confirmation set. ONE atomic union over the
 * row's CURRENT value under the customer-scoped preference lock — the same
 * shape the portal autosave uses (codex gh-r26) — so a confirmation that
 * overlaps an address change can never write a pre-move set back over the
 * fan-out's reset. Upserts a minimal row when the customer has no
 * preferences yet (tech-only irrigation readings are common).
 */
async function confirmIrrigationFields(conn, customerId, fields) {
  const list = (Array.isArray(fields) ? fields : []).filter((f) => typeof f === 'string' && f);
  if (!customerId || !list.length) return 0;
  return conn.transaction(async (trx) => {
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
  });
}

module.exports = { IRRIGATION_SIZING_FIELDS, COUNTY_CONFIRMED_FIELD, sizingFieldsUnconfirmed, scheduleUnconfirmedAfterMove, countyConfirmedAfterMove, confirmIrrigationFields, parseConfirmedFields: parseConfirmed };
