/**
 * Pure helpers for the Recruiting offer screens: dates (all Eastern), the
 * step-date rule, masked contact lines and the plain sentences for the
 * offer API's 409 codes.
 */

import { addETDays, etDateString, etParts, formatETDate, formatETDateOnly, formatETDateTime } from "../../../lib/timezone";

// Calendar dates ("YYYY-MM-DD") go through the shared Eastern helpers in
// lib/timezone.js. Each day is anchored at noon UTC, which is the same Eastern
// calendar day all year, so no zone can move it. Only the offer's own rules
// live here: Monday-to-Thursday starts and the Monday pay step after day 90.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const anchorOf = (value) => new Date(`${value}T12:00:00Z`);
const weekdayOf = (value) => etParts(anchorOf(value)).dayOfWeek; // 0 Sunday .. 6 Saturday

// A real calendar date: Feb 30 and 5-digit years are not.
export function isValidDay(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const at = anchorOf(value);
  return !Number.isNaN(at.getTime()) && etDateString(at) === value;
}

export function addDays(value, days) {
  return isValidDay(value) ? etDateString(addETDays(anchorOf(value), days)) : "";
}

// Today's calendar date in Eastern, "YYYY-MM-DD".
export function todayET(now = new Date()) {
  return etDateString(now);
}

// A Monday (the pay step's day).
export function isMonday(value) {
  return isValidDay(value) && weekdayOf(value) === 1;
}

// Monday to Thursday only (the offer's start days).
export function isStartWeekday(value) {
  if (!isValidDay(value)) return false;
  const dow = weekdayOf(value);
  return dow >= 1 && dow <= 4;
}

/**
 * Pay step date: the first Monday strictly after day 90, day 1 = the start
 * date (so day 90 = start + 89 days, and the step is the first Monday on or
 * after start + 90 days). Start Mon 2027-01-04 -> 2027-04-05. Past year 9999
 * there is no 4-digit date: no step date, never a wrapped one.
 */
export function stepDateFor(startDate) {
  const after90 = addDays(startDate, 90);
  if (!isValidDay(after90)) return "";
  const step = addDays(after90, (8 - weekdayOf(after90)) % 7);
  return isValidDay(step) ? step : "";
}

// "Mon, Jan 4, 2027" from a calendar date (no time zone shift).
export function formatDay(value) {
  const day = String(value || "").slice(0, 10);
  return isValidDay(day) ? formatETDateOnly(day, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "";
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

// What Send will do, from the server's list of the channels it tries (the offer
// read's sendTo: a masked phone and email, each null when none is on file): "one
// text and one email", "one text", "one email", or null when there is neither.
export function sendChannels(sendTo) {
  const text = Boolean(sendTo?.sms);
  const email = Boolean(sendTo?.email);
  if (text && email) return "one text and one email";
  if (text) return "one text";
  return email ? "one email" : null;
}

// A write the server refused because the offer, its draft or the application is no
// longer what the owner was looking at (another admin acted, the applicant answered,
// or the offer expired). Nothing was written: re-read and show the message.
export const STALE_CODES = [
  "DRAFT_CHANGED",
  "OFFER_CHANGED",
  "OFFERS_CHANGED",
  "OFFER_NOT_DRAFT",
  "OFFER_NOT_WITHDRAWABLE",
  "OFFER_NOT_REVISABLE",
  "DRAFT_EXISTS",
  "OFFER_ALREADY_OPEN",
  "APPLICATION_CLOSED",
];

export function isStaleWrite(err) {
  return STALE_CODES.includes(err?.body?.code);
}

// A write whose answer was lost: no reply, a 5xx, or a reply that could not be
// read. The server may have done it, so the screen re-reads before it offers the
// write again. A 4xx answer is a refusal: nothing was written.
export function isLostAnswer(err) {
  const status = Number(err?.status);
  return !(status >= 400 && status < 500);
}

// GATE_JOB_OFFERS off: every offer endpoint answers exactly 404 { enabled: false }.
export function isGateOffAnswer(err) {
  return err?.status === 404 && err?.body?.enabled === false;
}

// After a lost answer the re-read still showed the old state. The write may still
// finish on the server. If it did, a repeat is refused (the server locks the offer
// and checks its state), so nothing happens twice. No text claims an outcome the
// screen cannot know.
export const LOST_ANSWER_TEXT = {
  save: "The save got no answer. The draft still reads as before, but the save may still finish. If it did, saving again is refused and this form shows the newer version.",
  send: "The send got no answer. The offer still reads as a draft, but it may still go out. If it did, sending again is refused, so it cannot go out twice.",
  card: "No answer came back. The card shows the offer as it reads now, but the action may still finish. If it did, a repeat is refused.",
};

export function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "";
}

const OFFERS_OFF_TEXT = "Job offers are turned off, so this did not go through. The plain Offer move works as before.";

// A first draft is refused while an offer is out (OFFER_ALREADY_OPEN): the card's Revise makes the next one. The form
// with no draft yet says it before any write, too.
export const OFFER_OUT_TEXT = "An offer is already out. Close this form and use Revise on the offer card to make an updated one.";

// Every offer write on a closed application is refused (APPLICATION_CLOSED). The form says it before any write, too.
export const APPLICATION_CLOSED_TEXT = "This application is closed (hired, rejected or withdrawn). Move it back before sending an offer.";

const ERROR_TEXT = {
  TERMS_NOT_ISSUED: "The shared Technician Terms are not issued yet. Issue them in Staff Documents first.",
  OFFER_NOT_DRAFT: "This offer is no longer a draft. Close this form and check its state.",
  NO_CONTACT: "This applicant has no phone or email on file, so nothing can be sent.",
  APPLICATION_CLOSED: APPLICATION_CLOSED_TEXT,
  OFFER_ALREADY_OPEN: OFFER_OUT_TEXT,
  ROLE_NOT_SUPPORTED: "Offers are for technician applications only.",
  // Save, Send and Discard all answer these two codes: the words name no action.
  DRAFT_CHANGED: "This draft changed after you opened it, so nothing was done. Review the new version first.",
  OFFER_CHANGED: "This offer changed after you opened it. Review it again.",
  // Only Send answers this one: the offer out (the one a revision replaces) changed after the owner reviewed it. The
  // form's notice then says what changed (outChangeDetail).
  OFFERS_CHANGED: "The offer you sent before changed after you opened this, so nothing was sent.",
  OFFER_NOT_WITHDRAWABLE: "This offer expired before you withdrew it. Nothing was changed.",
  OFFER_NOT_REVISABLE: "This offer expired before you revised it. Make a new offer instead.",
  DRAFT_HASH_REQUIRED: "The draft could not be checked, so nothing was done. Reload the offer and review it first.",
};

// A read whose offers out differ from the ones the owner reviewed in the form (an
// answer or a date request): the form locks with this and outChangeDetail until
// the owner presses Continue with this draft.
export const OUT_CHANGED_TEXT = "The offer you sent before changed after you opened this form.";

// An offer the applicant can act on (the server's OUT_STATUSES).
export const OUT_STATES = ["sent", "date_requested"];

// An offer's state, as the card names it.
export const STATUS_LABEL = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Signed",
  declined: "Declined",
  date_requested: "Asked for another date",
  expired: "Closed unsigned",
  withdrawn: "Withdrawn",
  superseded: "Replaced",
};

// "Asked to start Mon, Jan 18, 2027. Note: …" for an offer with a date request; else null.
export function dateRequestText(offer) {
  if (offer?.status !== "date_requested" || !offer.requestedStartDate) return null;
  return `Asked to start ${formatDay(offer.requestedStartDate)}.${offer.dateRequestNote ? ` Note: ${offer.dateRequestNote}` : ""}`;
}

// Every offer a read holds: the current one, a revision, the history.
export function offersOf(data) {
  return [data.current, data.draft, ...(data.history || [])].filter(Boolean);
}

// The offer with this id, wherever the read holds it; null with no read, or for an offer the read does not hold.
export function offerIn(data, id) {
  return (data && offersOf(data).find((o) => o.id === id)) || null;
}

// What changed, when only the offers out moved while a draft was open: the offer
// the draft replaces, as the card words it (a date request with its day and note).
export function outChangeDetail(data, draft) {
  const replaced = offerIn(data, draft?.supersedesId);
  if (!replaced) return "Check the offer card before you send.";
  return dateRequestText(replaced) || `It now shows: ${STATUS_LABEL[replaced.status] || replaced.status}.`;
}

// err = the Error the offer API helper throws (err.body.code on a 409).
export function offerErrorMessage(err) {
  if (isGateOffAnswer(err)) return OFFERS_OFF_TEXT;
  const code = err?.body?.code || err?.code;
  return ERROR_TEXT[code] || err?.message || "Something went wrong. Try again.";
}

// Every outcome the server's send gives a channel: the recruiting-comms legs ('sent', 'deferred', 'uncertain', 'failed',
// 'blocked'; 'stale' when the application moved before the leg; 'skipped' when the leg had nothing to send), and
// sendStageComms itself ('not_requested' for a channel with no phone or email on file, 'disabled' with the gate off).
// 'handoff' is the ledger's in-flight state, worded as went out.
const SEND_OUTCOMES = ["sent", "handoff", "deferred", "uncertain", "failed", "blocked", "stale", "skipped", "not_requested", "disabled"];

// Whether a send's answer says what each channel did: both channels, each with an outcome above. An answer that does
// not (offerApi sendOffer) cannot be worded, so it is a lost answer: the form re-reads and claims no result.
export function isSendComms(comms) {
  return ["sms", "email"].every((channel) => SEND_OUTCOMES.includes(comms?.[channel]?.outcome));
}

// What a send outcome means for the owner. 'sent' and 'handoff' went out;
// 'deferred' is queued for the send window; 'uncertain' or no outcome may not
// have gone out; anything else did not go out.
// A channel the offer never tried (no phone or email on file, not requested)
// is left out of the result.
const NOT_TRIED = ["not_requested", "no_phone", "no_email"];

function wasTried(channel) {
  return !NOT_TRIED.includes(channel.outcome) && !NOT_TRIED.includes(channel.code);
}

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

// Offer statuses that mean the applicant already answered, so the link reached them.
const ANSWERED = ["accepted", "declined", "date_requested"];

/**
 * The result of a send that answered 200: { headline, lines }.
 * comms = { sms: {outcome, code}, email: {outcome, code} }; offerStatus = the
 * status of the offer row in the same answer, read after delivery.
 * "Offer sent to X." only when the offer is still out and every channel that
 * was tried went out; otherwise "The offer is open." and one short line per
 * channel. An offer withdrawn or replaced during the send says so, with no Revise.
 */
// offerStatus: the sent offer's status in the send's answer (offerApi sendOffer requires it).
// byClock: the page's clock closed the offer (a sent offer past its expiry), not the server. The applicant may have
// signed since the last read, so the words claim only the expiry, and say how to read the offer again.
export function describeSend(comms, firstName, offerStatus, byClock = false) {
  const channels = [["text", comms?.sms], ["email", comms?.email]].filter(([, c]) => c && wasTried(c));
  const states = channels.map(([label, c]) => [label, channelState(c)]);
  const lines = states.map(([label, st]) => `The ${label} ${STATE_TEXT[st]}.`);
  if (ANSWERED.includes(offerStatus)) {
    return { headline: `Offer sent to ${firstName}.`, lines: [`${firstName} has already answered it. The offer card shows the answer.`] };
  }
  if (offerStatus === "expired" && byClock) {
    return { headline: "This offer's expiry has passed.", lines: [...lines, `Open the application again to see whether ${firstName} signed it before then.`] };
  }
  if (offerStatus === "expired") {
    return { headline: "This offer is no longer open.", lines: [...lines, `It passed its expiry before ${firstName} signed it. The offer card shows it as ${STATUS_LABEL.expired}.`] };
  }
  if (offerStatus !== "sent") {
    return { headline: "This offer is no longer open.", lines: [...lines, "It was withdrawn or replaced after you pressed Send. The offer card shows where it stands."] };
  }
  if (states.length && states.every(([, st]) => st === "out")) return { headline: `Offer sent to ${firstName}.`, lines: [] };
  if (states.length && states.every(([, st]) => st === "failed")) {
    lines.push("Check the phone and email on file, then use Revise to send a new link.");
  }
  return { headline: "The offer is open.", lines };
}

// The stage dialog's line about the application's job offers, or null. The server's stage preview says what the move
// would withdraw, by the rule the move applies, with the offer gate on or off (admin-careers.js stageOfferEffect); this
// only words it. owner_only: the move withdraws an offer the applicant holds, which only the owner account may do, so
// the dialog keeps Confirm off. A preview without `offers` never reaches the dialog: its read is refused (Try again).
export const OWNER_ONLY_MOVE_TEXT = "This application has a job offer out. Only the owner account can move it out of Offer.";

// The applicant's first name on the owner's screens: the first word of the name on file, or "the applicant".
export function firstNameOf(name) {
  return String(name || "the applicant").trim().split(/\s+/)[0];
}

export function stageMoveOfferNote(offers, name) {
  if (offers.owner_only) return OWNER_ONLY_MOVE_TEXT;
  const firstName = firstNameOf(name);
  if (offers.held) {
    return `This move also withdraws the offer you sent to ${firstName}, so their link stops working${offers.draft ? ", and discards the unsent draft" : ""}.`;
  }
  return offers.draft ? "This move also discards the unsent offer draft." : null;
}

// A 'sent' offer past its expiresAt reads as closed unsigned even before the
// server's own status says so.
export function shownOffer(offer, now = new Date()) {
  const lapsed = offer?.status === "sent" && offer.expiresAt && new Date(offer.expiresAt) < now;
  return lapsed ? { ...offer, status: "expired" } : offer;
}
