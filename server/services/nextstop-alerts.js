/**
 * Property-alerts compiler — the tech-facing Next-Stop alert block.
 *
 * Extracted verbatim from routes/admin-schedule.js (the day-feed enrichment
 * loop) so the pre-visit brief can reuse the SAME compiled block instead of
 * duplicating the rules. Pure function: callers fetch the
 * property_preferences row and pass visit fields in; behavior is 1:1 with
 * the inlined block it replaced (same alert types, same ordering, same
 * text). Contains RAW access codes — the day feed and the stored brief's
 * deterministic access block are the only consumers; this output must NEVER
 * be placed in an LLM prompt payload.
 */
const { stripSchedulerAuditText } = require('../utils/visit-notes');
const { mowingAlertText } = require('../utils/mowing-schedule');

/**
 * @param {object} args
 * @param {object|null} args.prefs               property_preferences row (or null)
 * @param {string|null} args.notes               scheduled_services.notes (raw)
 * @param {boolean} args.genuinelyNew            isNewCustomer verdict
 * @param {object|string|null} args.servicePreferences scheduled_services.service_preferences (jsonb or string)
 * @param {string} args.normalizedServiceType    normalizeServiceType(service_type)
 * @param {Array<object>|null} args.neighborhoodGate neighborhood directory entries
 *   (neighborhood-access.js neighborhoodGateEntriesForVisits), used only when
 *   the customer has no neighborhood gate code of their own
 * @param {boolean} args.neighborhoodActions   tag each neighborhood CODE alert
 *   with its directory entry (neighborhoodEntryId, neighborhoodEntryCode, reportedWrong) so the field
 *   screen can offer "Wrong code" on it (GATE_NEIGHBORHOOD_TECH_ACTIONS)
 * @returns {Array<{type: string, text: string}>}
 */
function compilePropertyAlerts({
  prefs = null,
  notes = null,
  genuinelyNew = false,
  servicePreferences = null,
  normalizedServiceType = '',
  neighborhoodGate = null,
  neighborhoodActions = false,
} = {}) {
  const cleanedNotes = (notes || '').trim();

  const alerts = [];
  if (prefs?.neighborhood_gate_code) alerts.push({ type: 'gate', text: `Gate: ${prefs.neighborhood_gate_code}` });
  else {
    // The customer has no code: the neighborhood's shared entry, labeled as
    // the neighborhood's (and "confirm on site" while unconfirmed).
    for (const e of neighborhoodGate || []) {
      const label = e.gate_label && e.gate_label !== 'Main gate' ? e.gate_label : 'Gate';
      const value = e.code || e.instructions;
      if (!value) continue;
      const tag = e.status === 'active' ? 'neighborhood' : 'neighborhood, confirm on site';
      const alert = { type: 'gate', text: `${label}: ${value} (${tag})` };
      if (neighborhoodActions && e.id && e.code) {
        alert.neighborhoodEntryId = e.id;
        alert.neighborhoodEntryCode = e.code;
        alert.reportedWrong = !!e.flagged_wrong_at;
      }
      alerts.push(alert);
    }
  }
  if (prefs?.property_gate_code) alerts.push({ type: 'gate', text: `Yard: ${prefs.property_gate_code}` });
  if (prefs?.garage_code) alerts.push({ type: 'gate', text: `Garage: ${prefs.garage_code}` });
  if (prefs?.lockbox_code) alerts.push({ type: 'gate', text: `Lockbox: ${prefs.lockbox_code}` });
  if (prefs?.pet_count > 0 || prefs?.pet_details) alerts.push({ type: 'pet', text: prefs.pet_details || `${prefs.pet_count} pet(s)` });
  if (prefs?.pets_secured_plan) alerts.push({ type: 'pet_plan', text: prefs.pets_secured_plan });
  if (prefs?.chemical_sensitivities) alerts.push({ type: 'chemical', text: prefs.chemical_sensitivity_details || 'Chemical sensitivity' });
  if (prefs?.access_notes) alerts.push({ type: 'access', text: prefs.access_notes });
  if (prefs?.side_gate_access) alerts.push({ type: 'access', text: `Side gate: ${prefs.side_gate_access}` });
  if (prefs?.parking_notes) alerts.push({ type: 'access', text: `Parking: ${prefs.parking_notes}` });
  if (prefs?.special_instructions) alerts.push({ type: 'special', text: prefs.special_instructions });
  // Mowing schedule — a cut right before/after an application undoes it,
  // so the tech needs to know when the mower comes through.
  const mowingAlert = mowingAlertText(prefs);
  if (mowingAlert) alerts.push({ type: 'mowing', text: mowingAlert });
  // Only add notes if there's meaningful content after cleaning. Ops
  // sessions write scheduling-audit trails into notes; those are internal
  // and never belong on the tech-facing alerts block.
  const displayNotes = stripSchedulerAuditText(cleanedNotes);
  if (displayNotes) alerts.push({ type: 'note', text: displayNotes });
  // Show "New customer" badge ONLY if genuinely new (no completed service records)
  if (genuinelyNew) alerts.push({ type: 'new_customer', text: 'New customer — first visit' });
  // Service-preference opt-outs — the customer toggled one of these off
  // in the estimator or portal. Surface prominently so the tech knows
  // to skip that part of the visit.
  let svcPrefs = null;
  try {
    svcPrefs = typeof servicePreferences === 'string'
      ? JSON.parse(servicePreferences || '{}')
      : (servicePreferences || null);
  } catch { svcPrefs = null; }
  // Away Mode (cancel-flow C2): dated exterior-only, independent of the
  // persistent service-preference toggle.
  const awayUntil = prefs?.away_mode_until ? String(prefs.away_mode_until).slice(0, 10) : null;
  const awayActive = awayUntil && awayUntil >= require('../utils/datetime-et').etDateString();
  if (awayActive && /pest/i.test(normalizedServiceType)) {
    alerts.push({ type: 'service_pref', text: `AWAY MODE — exterior only until ${awayUntil}, nobody home` });
  }
  if (svcPrefs && /pest/i.test(normalizedServiceType)) {
    if (!awayActive && svcPrefs.interior_spray === false) alerts.push({ type: 'service_pref', text: 'EXTERIOR ONLY — no interior treatment' });
    if (svcPrefs.exterior_sweep === false) alerts.push({ type: 'service_pref', text: 'Skip eave/cobweb sweep' });
  }

  return alerts;
}

module.exports = { compilePropertyAlerts };
