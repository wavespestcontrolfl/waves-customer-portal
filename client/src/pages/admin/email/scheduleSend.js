import { addETDays, etDateString, etDatetimeLocalToISO, etDatetimeLocalValue, etParts, formatETDateTime } from "../../../lib/timezone";

// Gmail's "Schedule send" choices, in Eastern wall-clock (YYYY-MM-DDTHH:MM,
// the form POST /api/admin/email/schedule takes). Monday morning is left out
// when tomorrow is already Monday, as Gmail does.
export function schedulePresets(now = new Date()) {
  const tomorrow = etDateString(addETDays(now, 1));
  const daysToMonday = (8 - etParts(now).dayOfWeek) % 7 || 7;
  const monday = etDateString(addETDays(now, daysToMonday));
  const presets = [
    { key: "tomorrow_morning", label: "Tomorrow morning", sendAt: `${tomorrow}T08:00` },
    { key: "tomorrow_afternoon", label: "Tomorrow afternoon", sendAt: `${tomorrow}T13:00` },
  ];
  if (monday !== tomorrow) presets.push({ key: "monday_morning", label: "Monday morning", sendAt: `${monday}T08:00` });
  return presets;
}

// "Thu, Oct 23, 9:00 AM" for an Eastern wall-clock string or a stored instant.
export function formatSendAt(value) {
  const iso = /T\d{2}:\d{2}$/.test(String(value)) ? etDatetimeLocalToISO(value) : value;
  return formatETDateTime(iso, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// The earliest value the date-and-time picker offers: the next whole minute
// plus two, so the server's one-minute floor still holds when the operator
// takes a moment (a picker value has no seconds).
// A wall-clock minute that happens twice (the fall-back hour) is refused by
// the server, so the minimum moves past it.
export function earliestPick(now = new Date()) {
  const hour = 60 * 60 * 1000;
  const wall = (ms) => etDatetimeLocalValue(new Date(ms));
  let pick = Math.ceil(now.getTime() / 60000) * 60000 + 2 * 60 * 1000;
  while (wall(pick - hour) === wall(pick) || wall(pick + hour) === wall(pick)) pick += 60 * 1000;
  return wall(pick);
}
