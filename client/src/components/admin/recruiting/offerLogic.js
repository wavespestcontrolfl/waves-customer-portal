/**
 * Pure helpers for the Recruiting offer screens: dates (all Eastern), the
 * step-date rule, masked contact lines and the plain sentences for the
 * offer API's 409 codes.
 */

import { etDateString, formatETDate, formatETDateTime } from "../../../lib/timezone";

const DAY_MS = 86400000;
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
  return etDateString(now);
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

// "Fri, Dec 11, 10:20 AM" in Eastern, for the timeline and signed copy.
export function formatTimelineTime(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "";
  return formatETDateTime(value, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// "Nov 10, 2026" for a timestamp (the Eastern calendar day, never a UTC slice).
export function formatIssued(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "";
  return formatETDate(value, { month: "short", day: "numeric", year: "numeric" });
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

// What Send will do, from the contact methods on file: "one text and one
// email", "one text", "one email", or null when the applicant has neither.
export function sendChannels(contact) {
  const text = Boolean(maskPhone(contact?.phone));
  const email = Boolean(maskEmail(contact?.email));
  if (text && email) return "one text and one email";
  if (text) return "one text";
  return email ? "one email" : null;
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
  DRAFT_CHANGED: "This draft changed after you opened it. Review the new preview, then send.",
  DRAFT_HASH_REQUIRED: "The draft could not be checked. Reload the offer, review the preview, then send.",
};

// err = the Error the offer API helper throws (err.body.code on a 409).
export function offerErrorMessage(err) {
  const code = err?.body?.code || err?.code;
  return ERROR_TEXT[code] || err?.message || "Something went wrong. Try again.";
}

// What a send outcome means for the owner. 'sent' and 'handoff' went out;
// 'deferred' is queued for the send window; 'uncertain' or no outcome may not
// have gone out; anything else did not go out.
function channelState(channel) {
  const outcome = channel.outcome;
  if (outcome === "sent" || outcome === "handoff") return "out";
  if (outcome === "deferred") return "queued";
  return !outcome || outcome === "uncertain" ? "maybe" : "failed";
}

const STATE_TEXT = {
  out: "went out",
  queued: "is queued",
  maybe: "may not have gone out",
  failed: "did not go out",
};

/**
 * The result of a send that answered 200: { headline, lines }.
 * comms = { sms: {outcome, code}, email: {outcome, code} }. "Offer sent to X."
 * only when every channel that was tried went out; otherwise "The offer is
 * open." and one short line per channel.
 */
export function describeSend(comms, firstName) {
  const channels = [["text", comms?.sms], ["email", comms?.email]].filter(([, c]) => c);
  const states = channels.map(([label, c]) => [label, channelState(c)]);
  if (states.length && states.every(([, st]) => st === "out")) return { headline: `Offer sent to ${firstName}.`, lines: [] };
  const lines = states.map(([label, st]) => `The ${label} ${STATE_TEXT[st]}.`);
  if (states.length && states.every(([, st]) => st === "failed")) {
    lines.push("Check his phone and email, then use Revise to send a new link.");
  }
  return { headline: "The offer is open.", lines };
}
