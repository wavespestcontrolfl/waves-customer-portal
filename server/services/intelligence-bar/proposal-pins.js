/**
 * W0B proposal-time pins shared by the route (proposal + confirm preflight)
 * and the executors (enforcement at the mutation's own read) — one
 * fingerprint definition so the two boundaries can never drift apart.
 *
 * The route computes a fingerprint over the state the card displayed; the
 * executor recomputes it from the row IT loaded (the same read its CAS/
 * claim is based on) and refuses with preview_changed on mismatch — the
 * approval is enforced at the final read, not only in a preflight query.
 */

const crypto = require('crypto');

// Terminal scheduled_services statuses — one-way; never movable. Owned here
// (the shared leaf both the route and the executors load, mocks never
// replace it) so the proposal guard and the executor can NEVER disagree:
// codex r7 on #3648 caught the route listing 'rescheduled' as terminal
// while the executor deliberately allows re-moving such visits.
const TERMINAL_APPOINTMENT_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show'];

function sha(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// ── Appointment (reschedule) ────────────────────────────────────────────
// Fields the reschedule effect depends on. customer_name is display-only
// and deliberately NOT hashed (a display join must not perturb the pin).
function normalizeAppointmentPin(row) {
  const iso = (v) => (v instanceof Date ? v.toISOString() : (v == null ? null : String(v)));
  return {
    id: row.id,
    status: row.status,
    scheduled_date: row.scheduled_date instanceof Date
      ? row.scheduled_date.toISOString().slice(0, 10)
      : String(row.scheduled_date || ''),
    time_window: row.time_window || null,
    window_start: iso(row.window_start),
    window_end: iso(row.window_end),
    estimated_duration_minutes: row.estimated_duration_minutes == null ? null : Number(row.estimated_duration_minutes),
    technician_id: row.technician_id || null,
    service_type: row.service_type || null,
    // The visit's OWNER is part of the identity: a row re-pointed to a
    // different customer with identical schedule fields is drift.
    customer_id: row.customer_id ? String(row.customer_id) : null,
    // Grouped-visit membership (GH r12 P1): moving a grouped row detaches
    // it and can dissolve the remaining visit (handleChildStopChanged) —
    // effects the card must disclose, so a row that joins or leaves a
    // group during the pending window is drift, never an undisclosed
    // detach/dissolve.
    visit_id: row.visit_id ? String(row.visit_id) : null,
    // Recurrence state (GH r19 P2): with the collective-move gate on, a
    // recurring row's DATE move is deterministically refused by the
    // executor — the proposal refuses first, and a row that becomes
    // recurring during the pending window is drift.
    is_recurring: row.is_recurring === true,
    // Tracker-lifecycle evidence, DERIVED (GH r8 on #3648): a date move of a
    // row with live status/track_state or leftover lifecycle stamps rewinds
    // the tracker (rebooker needsLifecycleRewind) — an effect the card must
    // disclose, so evidence appearing during the pending window is drift.
    // Boolean, not the raw stamps: a same-evidence re-read hashes alike.
    track_rewind: require('../rebooker').needsLifecycleRewind(row) === true,
  };
}

function appointmentPinFingerprint(pin) {
  return sha([
    String(pin.id), pin.status, pin.scheduled_date, pin.time_window, pin.window_start || null, pin.window_end || null,
    pin.estimated_duration_minutes ?? null, pin.technician_id ? String(pin.technician_id) : null, pin.service_type,
    pin.customer_id || null,
    pin.track_rewind === true,
    pin.visit_id || null,
    pin.is_recurring === true,
  ]);
}

// ── Email reply ─────────────────────────────────────────────────────────
// Everything the send depends on: recipient address, subject, thread,
// attributed customer. Works on the raw emails row and the route pin alike.
function emailPinFingerprint(email) {
  return sha([
    String(email.id), email.from_address || null, email.subject || null, email.gmail_thread_id || null,
    email.customer_id ? String(email.customer_id) : null,
  ]);
}

// ── Price approval ──────────────────────────────────────────────────────
// Every field the apply writes from: a re-priced, re-quantified or
// re-vendored approval must be drift. Works on the raw row (executor) and
// the route's pin object alike.
function priceApprovalFingerprint(a) {
  return sha([
    String(a.id), a.status, String(a.product_id || ''), String(a.vendor_id || ''),
    a.new_price == null ? null : Number(a.new_price), a.new_quantity || null,
  ]);
}

module.exports = { normalizeAppointmentPin, appointmentPinFingerprint, priceApprovalFingerprint, emailPinFingerprint, TERMINAL_APPOINTMENT_STATUSES };
