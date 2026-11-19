/**
 * Pure helpers for the Recruiting offer screens: dates (all Eastern), the
 * step-date rule, masked contact lines and the plain sentences for the
 * offer API's 409 codes.
 */

const DAY_MS = 86400000;
const ET = "America/New_York";
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// "YYYY-MM-DD" -> Date at UTC midnight, or null. Calendar math only: no zone.
function parseDay(value) {
  const m = DATE_RE.exec(String(value || ""));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayString(d) {
  return d.toISOString().slice(0, 10);
}

export function addDays(value, days) {
  const d = parseDay(value);
  return d ? dayString(new Date(d.getTime() + days * DAY_MS)) : "";
}

// Today's calendar date in Eastern, "YYYY-MM-DD".
export function todayET(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ET }).format(now);
}

// Monday to Thursday only (the offer's start days).
export function isStartWeekday(value) {
  const d = parseDay(value);
  if (!d) return false;
  const dow = d.getUTCDay();
  return dow >= 1 && dow <= 4;
}

/**
 * Pay step date: the first Monday strictly after day 90, day 1 = the start
 * date (so day 90 = start + 89 days). Start Mon 2027-01-04 -> 2027-04-05.
 */
export function stepDateFor(startDate) {
  if (!parseDay(startDate)) return "";
  let day = addDays(startDate, 90);
  while (parseDay(day).getUTCDay() !== 1) day = addDays(day, 1);
  return day;
}

// "Mon, Jan 4, 2027" from a calendar date (no time zone shift).
export function formatDay(value) {
  const d = parseDay(String(value || "").slice(0, 10));
  if (!d) return "";
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// "Fri, Dec 18, 2026" for the day the offer lapses: send day + 7 days (ET).
export function expiryLabel(now = new Date()) {
  return formatDay(addDays(todayET(now), 7));
}

// "Fri Dec 11, 10:20 AM" in Eastern, for the timeline.
export function formatTimelineTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: ET,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.weekday} ${parts.month} ${parts.day}, ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
}

export function maskPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "").slice(-10);
  if (digits.length < 10) return "";
  return `(${digits.slice(0, 3)}) ***-${digits.slice(6)}`;
}

export function maskEmail(email) {
  const [local, domain] = String(email || "").split("@");
  if (!local || !domain) return "";
  return `${local[0]}***@${domain}`;
}

export function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "";
}

const ERROR_TEXT = {
  TERMS_NOT_ISSUED: "The shared Technician Terms are not issued yet. Issue them in Staff Documents first.",
  OFFER_NOT_DRAFT: "This offer is no longer a draft. Close this form and check its state.",
  NO_CONTACT: "This applicant has no phone or email on file, so nothing can be sent.",
  APPLICATION_CLOSED: "This application is closed (hired, rejected or withdrawn). Move it back before sending an offer.",
  ROLE_NOT_SUPPORTED: "Offers are for technician applications only.",
};

// err = the Error the offer API helper throws (err.body.code on a 409).
export function offerErrorMessage(err) {
  const code = err?.body?.code || err?.code;
  return ERROR_TEXT[code] || err?.message || "Something went wrong. Try again.";
}

const OUTCOME_TEXT = {
  sent: "sent",
  deferred: "held for the 8 AM to 8 PM window, sends by itself",
  blocked: "blocked",
  failed: "failed",
  skipped: "skipped",
  disabled: "off",
  uncertain: "uncertain, may have been delivered",
};

// comms = { sms: {outcome, code}, email: {outcome, code} } -> "Text sent. Email sent."
export function commsSummary(comms) {
  const part = (label, c) => {
    if (!c) return null;
    const text = OUTCOME_TEXT[c.outcome] || c.outcome || "unknown";
    return `${label} ${text}${c.code && c.outcome !== "sent" ? ` (${c.code})` : ""}.`;
  };
  return [part("Text", comms?.sms), part("Email", comms?.email)].filter(Boolean).join(" ");
}
