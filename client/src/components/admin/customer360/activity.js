// Customer 360 activity helpers — pure functions over the events
// GET /admin/customers/:id/timeline returns (see server/services/
// customer-timeline.js for the shape). Kept out of the components so the
// date handling and labels are unit-tested without rendering.
//
// Time discipline: a `dateKind: "date"` event is a calendar day with no time
// (a Postgres date column) and is never shown with a clock time; a
// `timestamp` event renders in Eastern wall-clock. Relative words are never
// derived from the current clock for undated rows.
import { etDateString, formatETDate, formatETDateOnly, formatETTime } from "../../../lib/timezone";

export const ACTIVITY_FILTERS = [
  { key: "all", label: "All" },
  { key: "messages", label: "Texts", types: ["sms"] },
  { key: "calls", label: "Calls", types: ["call"] },
  { key: "visits", label: "Visits", types: ["service", "scheduled_service"] },
  { key: "payments", label: "Payments", types: ["payment"] },
  { key: "notes", label: "Notes", types: ["interaction", "review", "activity"] },
];

// Legacy profile tabs → activity filter, so a deep link that used to open the
// Services or Comms tab lands on the matching slice of the feed.
export const LEGACY_TAB_FILTERS = { services: "visits", comms: "messages" };

export function filterEvents(events, filterKey) {
  const filter = ACTIVITY_FILTERS.find((f) => f.key === filterKey);
  if (!filter || !filter.types) return events;
  const allowed = new Set(filter.types);
  return events.filter((e) => allowed.has(e.type));
}

export function eventDay(event) {
  if (!event?.date) return null;
  if (event.dateKind === "date") return /^\d{4}-\d{2}-\d{2}$/.test(event.date) ? event.date : null;
  const d = new Date(event.date);
  return Number.isNaN(d.getTime()) ? null : etDateString(d);
}

function shiftDay(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days, 12));
  return shifted.toISOString().slice(0, 10);
}

// Group header text. Today / Yesterday / Tomorrow by the Eastern calendar,
// otherwise the date. Undated events collect under one honest heading.
export function dayLabel(day, today = etDateString()) {
  if (!day) return "Date not recorded";
  if (day === today) return "Today";
  if (day === shiftDay(today, -1)) return "Yesterday";
  if (day === shiftDay(today, 1)) return "Tomorrow";
  const year = day.slice(0, 4);
  return formatETDateOnly(day, {
    month: "short",
    day: "numeric",
    ...(year !== today.slice(0, 4) ? { year: "numeric" } : {}),
  });
}

// Events arrive sorted newest-first; keep that order inside each group.
export function groupByDay(events, today = etDateString()) {
  const groups = [];
  let current = null;
  for (const event of events) {
    const day = eventDay(event);
    if (!current || current.day !== day) {
      current = { day, label: dayLabel(day, today), events: [] };
      groups.push(current);
    }
    current.events.push(event);
  }
  return groups;
}

// Row-level time: the clock for timestamps, nothing for date-only rows (the
// group header already names the day) — never a fabricated "just now".
export function eventTimeLabel(event) {
  if (!event?.date || event.dateKind === "date") return "";
  const d = new Date(event.date);
  return Number.isNaN(d.getTime()) ? "" : formatETTime(d);
}

// Exact stamp for the details expansion / title attribute.
export function eventExactLabel(event) {
  if (!event?.date) return "Date not recorded";
  if (event.dateKind === "date") {
    return formatETDateOnly(event.date, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }
  const d = new Date(event.date);
  if (Number.isNaN(d.getTime())) return "Date not recorded";
  return `${formatETDate(d, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}, ${formatETTime(d)} ET`;
}

export function humanize(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/^\w/, (ch) => ch.toUpperCase());
}

export function formatDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return null;
  const mins = Math.floor(s / 60);
  const secs = Math.round(s % 60);
  return mins ? `${mins}m ${secs}s` : `${secs}s`;
}

// Provider delivery wording shared with the inbox: the provider accepting or
// queueing a text is NOT delivery.
export function deliveryLabel(status) {
  const normalized = String(status || "").toLowerCase();
  if (!normalized) return null;
  if (normalized === "delivered") return { label: "Delivered", tone: "neutral" };
  if (normalized === "sent") return { label: "Sent to carrier", tone: "neutral" };
  if (normalized === "queued" || normalized === "accepted" || normalized === "sending" || normalized === "scheduled") {
    return { label: "Queued", tone: "neutral" };
  }
  if (normalized === "undelivered") return { label: "Undelivered", tone: "alert" };
  if (normalized === "failed") return { label: "Failed", tone: "alert" };
  return { label: humanize(normalized), tone: "neutral" };
}

const VISIT_STATES = {
  pending: { label: "Scheduled", tone: "neutral" },
  confirmed: { label: "Confirmed", tone: "neutral" },
  rescheduled: { label: "Rescheduled", tone: "neutral" },
  en_route: { label: "En route", tone: "neutral" },
  on_site: { label: "On site", tone: "neutral" },
  completed: { label: "Completed", tone: "strong" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  canceled: { label: "Cancelled", tone: "neutral" },
  skipped: { label: "Skipped", tone: "neutral" },
  no_show: { label: "No-show", tone: "alert" },
};

// One place decides how a row reads: its kind word, a state chip, and
// whether it is something the customer did or something the system wrote.
export function describeEvent(event) {
  const meta = event?.metadata || {};
  switch (event?.type) {
    case "sms": {
      const inbound = meta.direction === "inbound";
      const state = inbound
        ? (meta.isRead === false ? { label: "Unread", tone: "strong" } : null)
        : deliveryLabel(meta.deliveryStatus);
      return { kind: inbound ? "Text in" : "Text out", state, automated: !inbound && !!meta.messageType && meta.messageType !== "manual" };
    }
    case "call": {
      const inbound = meta.direction === "inbound";
      const outcome = meta.outcome || (meta.durationSeconds ? formatDuration(meta.durationSeconds) : null);
      const missed = /no answer|busy|failed|cancelled/i.test(outcome || "");
      return { kind: inbound ? "Call in" : "Call out", state: outcome ? { label: outcome, tone: missed ? "alert" : "neutral" } : null, automated: false };
    }
    case "scheduled_service": {
      const state = VISIT_STATES[String(meta.status || "").toLowerCase()] || (meta.status ? { label: humanize(meta.status), tone: "neutral" } : null);
      return { kind: "Visit", state, automated: false };
    }
    case "service":
      return { kind: "Service", state: { label: meta.status && meta.status !== "completed" ? humanize(meta.status) : "Completed", tone: "strong" }, automated: false };
    case "payment": {
      const status = String(meta.status || "paid").toLowerCase();
      const refunded = Number(meta.refundedAmount || 0) > 0;
      const state = status === "failed"
        ? { label: "Failed", tone: "alert" }
        : refunded
          ? { label: Number(meta.refundedAmount) >= Number(meta.amount) ? "Refunded" : "Partly refunded", tone: "neutral" }
          : { label: humanize(status), tone: status === "paid" ? "strong" : "neutral" };
      return { kind: "Payment", state, automated: false };
    }
    case "interaction":
      return { kind: meta.automated ? "Auto note" : "Note", state: null, automated: !!meta.automated };
    case "review":
      return { kind: "Review", state: null, automated: false };
    case "activity":
      return { kind: "System", state: null, automated: true };
    default:
      return { kind: "Event", state: null, automated: false };
  }
}
