/**
 * Glass slot-picker helpers (docs/design/estimate-glass-plan.md, PR C) —
 * pure functions behind the glass components: slot freshness, the
 * real-data scarcity badge, and the slot-aware CTA metadata.
 *
 * All calendar math is ET wall-clock (lib/timezone.js — scheduling is ET,
 * never browser-local), mirroring the server's reserve guard in
 * server/services/slot-reservation.js so the client disables exactly the
 * slots the server would reject.
 */
import { etDateString, etParts } from './timezone';

// Matches the slot generator's minimumLeadMinutes default
// (server/services/estimate-slot-availability.js) and the reserve guard.
export const GLASS_SLOT_LEAD_MINUTES = 120;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function windowStartMinutes(windowStart) {
  const [h, m] = String(windowStart || '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function formatWindowStart(windowStart) {
  const mins = windowStartMinutes(windowStart);
  if (mins == null) return String(windowStart || '');
  const h24 = Math.floor(mins / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mins % 60).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
}

// Weekday name for a YYYY-MM-DD slot date. Slot dates are ET calendar
// dates; parsing at UTC noon keeps the weekday stable in any browser TZ.
export function glassSlotWeekday(dateYmd) {
  const d = new Date(`${dateYmd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return WEEKDAYS[d.getUTCDay()];
}

/**
 * A slot is stale once its window start is STRICTLY inside the booking lead
 * window (or past). Mirrors both the generator (which offers starts AT the
 * lead boundary: startMin >= earliest) and reserveSlot's guard — a slot
 * exactly two hours out is bookable everywhere.
 */
export function glassSlotIsStale(slot, now = new Date()) {
  if (!slot?.date) return false;
  const todayEt = etDateString(now);
  if (slot.date < todayEt) return true;
  if (slot.date > todayEt) return false;
  const startMins = windowStartMinutes(slot.windowStart);
  if (startMins == null) return false;
  const nowEt = etParts(now);
  return startMins < nowEt.hour * 60 + nowEt.minute + GLASS_SLOT_LEAD_MINUTES;
}

/**
 * Slot-aware CTA metadata for a selected slot: "Approve — Tue 9:00 AM ✓".
 */
export function glassSlotMeta(slot) {
  if (!slot?.date || !slot.windowStart) return null;
  const weekday = glassSlotWeekday(slot.date);
  if (!weekday) return null;
  return {
    slotId: slot.slotId,
    date: slot.date,
    windowStart: slot.windowStart,
    dow: weekday.slice(0, 3),
    time: formatWindowStart(slot.windowStart),
    // Real technician from the availability payload — the chip must never
    // default to the wrong name for a valid slot.
    techFirstName: slot.techFirstName || null,
  };
}

/**
 * Real-data scarcity: only when the FIRST day with availability truly has
 * ≤2 open slots — "Only 1 opening tomorrow — 9:00 AM". The count comes
 * from the server's pre-curation pool (metadata.firstDayAvailability):
 * the display list is diversified-by-day and sliced, so counting IT could
 * manufacture scarcity that doesn't exist. Returns null without the
 * server count, when the day has plenty, or when its visible slots have
 * gone stale — the badge self-removes rather than overstate urgency.
 */
export function glassScarcityInfo(slots, firstDayAvailability, now = new Date()) {
  const openCount = Number(firstDayAvailability?.openCount);
  const firstDay = firstDayAvailability?.date;
  if (!firstDay || !Number.isFinite(openCount) || openCount < 1 || openCount > 2) return null;
  const daySlots = (Array.isArray(slots) ? slots : [])
    .filter((s) => s?.date === firstDay && !glassSlotIsStale(s, now));
  if (!daySlots.length) return null;
  const todayEt = etDateString(now);
  const dayDiff = Math.round(
    (Date.parse(`${firstDay}T12:00:00Z`) - Date.parse(`${todayEt}T12:00:00Z`)) / 86400000,
  );
  const when = dayDiff <= 0 ? 'today' : dayDiff === 1 ? 'tomorrow' : `on ${glassSlotWeekday(firstDay)}`;
  const times = daySlots
    .map((s) => ({ mins: windowStartMinutes(s.windowStart), label: formatWindowStart(s.windowStart) }))
    .sort((a, b) => (a.mins ?? 0) - (b.mins ?? 0))
    .map((t) => t.label);
  return {
    count: openCount,
    label: `Only ${openCount} opening${openCount === 1 ? '' : 's'} ${when} — ${times.join(' & ')}`,
  };
}
