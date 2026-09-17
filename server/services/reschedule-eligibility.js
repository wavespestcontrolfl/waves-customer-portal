'use strict';

// The ONE customer-facing verdict on whether an appointment can still be
// self-rescheduled. It lived inside routes/reschedule-public.js, where only
// that page could reach it; the promised-link worker has to reach exactly the
// same answer before it texts a customer a link to that page, and a second
// copy of the missed-appointment rule would drift (codex #4293 r3 P2).
// Grouped-visit membership needs a query and stays with each caller.

const { etDateString, etParts } = require('../utils/datetime-et');
const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS } = require('./call-booking-source-actions');

const RESCHEDULABLE_STATUSES = new Set(['pending', 'confirmed', 'rescheduled']);

// Customer-quoted arrival window: 2 hours from window_start (owner rule —
// the same promise the page, reminders, and the late detector all quote).
const ARRIVAL_PROMISE_MINUTES = 120;

function apptDateStr(scheduledDate) {
  if (!scheduledDate) return null;
  return scheduledDate instanceof Date
    ? scheduledDate.toISOString().slice(0, 10)
    : String(scheduledDate).slice(0, 10);
}

function hhmm(t) {
  return t ? String(t).slice(0, 5) : null;
}

// Customer-facing eligibility for the appointment behind the token.
// Returns { ok: true } or { ok: false, reason } with a customer-safe reason:
//   completed | cancelled | in_progress | past | not_available
function eligibility(svc, now = new Date()) {
  const status = String(svc.status || '').toLowerCase();
  if (status === 'completed') return { ok: false, reason: 'completed' };
  if (status === 'cancelled' || status === 'canceled') return { ok: false, reason: 'cancelled' };
  if (status === 'en_route' || status === 'on_site') return { ok: false, reason: 'in_progress' };
  if (!RESCHEDULABLE_STATUSES.has(status)) return { ok: false, reason: 'not_available' };
  // Same dispatch-owned guard as the authenticated schedule routes (codex
  // #3429 r2 P1): a call-created booking the office hasn't reviewed is
  // hidden from the customer's list/confirm/reschedule, so the bearer-token
  // page must refuse it too — reminder rows now arm before office confirm,
  // and reschedule tokens never expire.
  if (DISPATCH_OWNED_PENDING_SOURCE_ACTIONS.includes(svc.source_action)
    && status === 'pending'
    && !svc.customer_confirmed) {
    return { ok: false, reason: 'not_available' };
  }

  // A pending/confirmed visit whose time already passed was MISSED, not
  // served — the customer may rebook it from the same link (owner ruling
  // 2026-07-13: "we missed each other — pick a new time"). Terminal and
  // live states were already rejected above; the rebooker only validates
  // the TARGET date, so a future target on a past visit commits cleanly.
  // Only pending/confirmed rows qualify: a past 'rescheduled' row is a
  // pending-rebook PLACEHOLDER other code treats as non-live — reviving it
  // to confirmed would resurrect a phantom visit.
  const missable = status === 'pending' || status === 'confirmed';
  const dateStr = apptDateStr(svc.scheduled_date);
  const todayEt = etDateString(now);
  if (dateStr && dateStr < todayEt) {
    return missable ? { ok: true, missed: true } : { ok: false, reason: 'past' };
  }
  if (dateStr === todayEt) {
    // Same-day: the visit is only MISSED once BOTH the internal job block
    // (window_end) AND the customer-quoted arrival promise (window_start +
    // 2h — owner rule, same constant the page displays) have elapsed.
    // window_end alone is often just the job-duration block: a 9:00 visit
    // with window_end 10:00 is still legitimately "on the way" at 10:05
    // inside the quoted 9–11 arrival window, and must not read as missed.
    const toMin = (t) => {
      const [h, m] = String(t).split(':').map(Number);
      return h * 60 + (m || 0);
    };
    const candidates = [];
    const start = hhmm(svc.window_start);
    const end = hhmm(svc.window_end);
    if (end) candidates.push(toMin(end));
    if (start) candidates.push(toMin(start) + ARRIVAL_PROMISE_MINUTES);
    if (candidates.length) {
      const nowEt = etParts(now);
      if (Math.max(...candidates) <= nowEt.hour * 60 + nowEt.minute) {
        return missable ? { ok: true, missed: true } : { ok: false, reason: 'past' };
      }
    }
  }
  return { ok: true };
}

module.exports = { eligibility, apptDateStr, hhmm, RESCHEDULABLE_STATUSES, ARRIVAL_PROMISE_MINUTES };
