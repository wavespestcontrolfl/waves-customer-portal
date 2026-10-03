// Open hours on a schedule day: each on-the-hour 60-minute slot between
// OPEN_HOURS_START and OPEN_HOURS_END that no live visit touches. Shown as
// tappable "Open" blocks on the mobile day list and the desktop day grid so
// the office can see the day's room at a glance (owner ask 2026-10-03).
// Display only — booking still goes through CreateAppointmentModal and the
// server's own window and capacity checks.

import { useEffect, useState } from 'react';
import { etDateString, etParts } from '../../lib/timezone';

// 7 AM to 7 PM (owner 2026-10-03), narrowed to the booking hours the server
// enforces when the feed sends them (`bookingHours`, capacity mode: 8 AM–6 PM;
// owner 2026-10-03: "match the server").
export const OPEN_HOURS_START = 7;
export const OPEN_HOURS_END = 19;

// Statuses that free their hour — the admin occupancy rule
// (ADMIN_OCCUPANCY_EXCLUDE_STATUSES, server scheduling/window-rules.js).
export const NOT_OCCUPYING = new Set(['cancelled', 'completed', 'skipped', 'no_show']);

function parseHHMM(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// Minutes [start, end) a visit holds: its booked window; with no usable end,
// its stored duration (as the server's occupancy reads it), else one hour.
function occupiedRange(svc) {
  const start = parseHHMM(svc?.windowStart);
  if (start == null) return null;
  const end = parseHHMM(svc?.windowEnd);
  if (end != null && end > start) return [start, end];
  const dur = Number(svc?.estimatedDuration);
  return [start, start + (Number.isFinite(dur) && dur > 0 ? dur : 60)];
}

/**
 * Start hours (24h integers) of the day's open slots. A slot is open when no
 * occupying visit overlaps it. Past days have none; today drops hours that
 * have already started (ET).
 */
export function openHoursForDay(dateStr, services, { now = new Date(), bookingHours = null } = {}) {
  const today = etDateString(now);
  if (!dateStr || dateStr < today) return [];
  const { hour, minute } = etParts(now);
  const nowMin = dateStr === today ? hour * 60 + minute : -1;
  const ranges = (services || [])
    .filter((s) => !NOT_OCCUPYING.has(s?.status))
    .map(occupiedRange)
    .filter(Boolean);
  const open = [];
  const first = bookingHours ? Math.max(OPEN_HOURS_START, Math.ceil(bookingHours.startMinutes / 60)) : OPEN_HOURS_START;
  const end = bookingHours ? Math.min(OPEN_HOURS_END, Math.floor(bookingHours.endMinutes / 60)) : OPEN_HOURS_END;
  for (let h = first; h < end; h += 1) {
    const from = h * 60;
    // An hour that has begun (10:00 itself included) is no longer open.
    if (from <= nowMin) continue;
    if (!ranges.some(([s, e]) => s < from + 60 && e > from)) open.push(h);
  }
  return open;
}

// "Now", refreshed at each hour boundary so a list left open past 10:00
// stops offering the 10 AM hour.
export function useHourClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const msToHour = 3600000 - (now.getTime() % 3600000) + 1000;
    const t = setTimeout(() => setNow(new Date()), msToHour);
    return () => clearTimeout(t);
  }, [now]);
  return now;
}

export function hourToHHMM(h) {
  return `${String(h).padStart(2, '0')}:00`;
}

// "9–10 AM", "11 AM–12 PM", "12–1 PM".
export function formatOpenHour(h) {
  const label = (x) => (x % 12 === 0 ? 12 : x % 12);
  const ap = (x) => (x < 12 ? 'AM' : 'PM');
  return ap(h) === ap(h + 1)
    ? `${label(h)}–${label(h + 1)} ${ap(h)}`
    : `${label(h)} ${ap(h)}–${label(h + 1)} ${ap(h + 1)}`;
}
