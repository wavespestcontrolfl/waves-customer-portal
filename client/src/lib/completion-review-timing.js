// client/src/lib/completion-review-timing.js
//
// The completion options that are pure rules: when the review ask goes out (the
// timing choices, their hints from the server's send-time preview, the custom
// time checks), why it is suppressed, the time-on-site and re-entry fragments.
// Moved out of pages/admin/SchedulePage.jsx unchanged so the full Complete Service
// form and the Fast Complete Wrap-up section (components/tech/FastCompleteWrapUp.jsx)
// follow the same rules. SchedulePage re-exports the ones its tests import.
import { addETDays, etDateString, etDatetimeLocalToISO, etParts, formatETDateTime } from "./timezone";

// Completion panel review timing (owner decisions 2026-09-07). "Automatic"
// is the cadence's smart send window — the server's calculateReviewSendPlan,
// previewed through /admin/reviews/send-time-preview so the panel shows the
// decision dispatch will make. "Customer asked for the link" is recorded on
// the sequence (who/when/source) and goes at the next cadence tick; it is
// never immediate, and the panel says so. The old "Now" / "In 2 hours"
// values are gone: saved drafts carrying them fall back to Automatic.
export const REVIEW_TIMING_OPTIONS = [
  { value: "auto", label: "Automatic (recommended)" },
  { value: "customer_requested", label: "Customer asked for the link" },
  { value: "tomorrow_8", label: "Tomorrow at 8 AM" },
  { value: "custom", label: "Custom time" },
];
export const REVIEW_TIMING_DEFAULT = "auto";
export function normalizeReviewTiming(value) {
  return REVIEW_TIMING_OPTIONS.some((o) => o.value === value) ? value : REVIEW_TIMING_DEFAULT;
}
// What the chosen timing means, from the server preview (never a client
// approximation of the smart window).
export function reviewTimingHint(options) {
  const hint = reviewTimingHintDetails(options);
  if (options.preview?.schedulerEnabled === true && options.reviewTiming !== "customer_requested") {
    return `For a new eligible enrollment: ${hint} An existing cadence keeps its schedule.`;
  }
  return hint;
}
function reviewTimingHintDetails({ reviewTiming, reviewCustomAt, preview, bundled, awaitsPayment = false }) {
  // An unpaid completion invoice holds the ask until payment lands (the
  // server's invoiceBlocksReview; enrollForPaidInvoice then enrolls). A
  // relative timing is re-derived from the payment time; an absolute one is
  // kept if it is still ahead (codex #4140 r10 P2).
  // The master cron gate is dark: nothing automated sends at all — not the
  // cadence ticks, not the legacy 15-minute scheduler (codex #4140 r15 P1).
  // Only a link bundled into the completion text itself still goes.
  // An UNKNOWN gate state (preview still loading, or failed) is not a
  // promise either: fail closed and say so until the preview succeeds
  // (codex #4140 r18 P1) — the same rule the Reviews page applies.
  if (!(reviewTiming === "customer_requested" && bundled)) {
    if (preview?.schedulerEnabled === false) return "Automated review texts are paused — the scheduler is off (GATE_CRON_JOBS). Nothing will send until it is turned on; the choice is recorded on this visit.";
    if (preview?.schedulerEnabled !== true) return "Whether automated review texts can send is not known yet (the send-time preview has not loaded). If the scheduler is off nothing sends; the choice is recorded on this visit.";
  }
  // Automatic after payment: enrollForPaidInvoice recovers no explicit
  // delay, so cadence mode computes the smart window from the payment and
  // the legacy path substitutes its 120-minute default (codex #4140 r19 P2).
  // Customer requested stores a zero delay, so it goes at the next tick.
  if (awaitsPayment && reviewTiming === "auto") {
    return preview?.reviewSequencesEnabled
      ? "Review text waits for the invoice to be paid, then goes out at the smart send window computed from the payment."
      : `Review text waits for the invoice to be paid, then goes out about 2 hours after payment, at the next scheduler tick${preview?.smsSendWindowEnabled ? " the 8 AM–8 PM window allows" : ""}.`;
  }
  if (awaitsPayment && reviewTiming === "customer_requested") return "The request is recorded on this visit. New review enrollment waits for invoice payment and visit eligibility. An existing cadence keeps its schedule.";
  const timed = timedReviewHint({ reviewTiming, reviewCustomAt, preview, bundled });
  return awaitsPayment && timed ? `Only once the invoice is paid: ${timed} A payment after that time sends at the next tick after payment.` : timed;
}
export function timedReviewHint({ reviewTiming, reviewCustomAt, preview, bundled }) {
  if (reviewTiming === "auto") {
    if (!preview?.at) return "Review text goes out separately at the smart send window.";
    // In cadence mode `at` is a jitter-free eligibility time: enrollment
    // adds up to ±15 min (earliestAt..latestAt) and the worker sends on its
    // ticks, so name the ticks either end lands on (codex #4140 r14 P2).
    // The legacy path has no jitter but its own worker ticks (the */15
    // scheduler): the row is eligible just after `at` and texts at the next
    // tick, so name that tick too (codex #4140 r18 P2).
    const lo = preview.reviewSequencesEnabled ? nextCadenceTickISO(preview.earliestAt || preview.at, workerTickMinutes(preview)) : null;
    const hi = nextCadenceTickISO(preview.latestAt || preview.at, workerTickMinutes(preview), { after: true });
    if (lo && hi && lo !== hi) return `Review text goes out separately at the cadence tick after about ${fmtReviewTime(preview.at)} — between about ${fmtReviewTime(lo)} and ${fmtReviewTime(hi)}.`;
    // The legacy +120 lands wherever the completion did — an evening visit's
    // 9:15 PM tick is refused by the send window and the row is re-queued for
    // the next 8 AM (codex #4140 r19 P2). Cadence mode's plan is already
    // fenced inside the window by the server.
    const legacyHeld = !preview.reviewSequencesEnabled && preview.smsSendWindowEnabled === true ? heldToWindowOpenISO(hi || preview.at, preview) : null;
    if (legacyHeld) return `Review text is held for the 8 AM–8 PM window — it goes out at the next 8 AM after about ${fmtReviewTime(preview.at)}, about ${fmtReviewTime(legacyHeld)}.`;
    return `Review text goes out separately, about ${fmtReviewTime(hi || preview.at)}.`;
  }
  if (reviewTiming === "customer_requested") {
    // `bundled` is the panel's own bundling condition (legacy path, completion
    // text going out) — the same shape as dispatch's shouldBundleReview. No
    // bounded time is promised: the next cadence tick still waits for the
    // 8 AM–8 PM send window (codex #4140 r2).
    return bundled
      ? "Review link is included in the completion text."
      : "The request is recorded on this visit. An existing cadence keeps its schedule; otherwise an eligible visit queues a separate review text, subject to the send window.";
  }
  if (reviewTiming === "tomorrow_8") {
    // In cadence mode 8:00 is the eligibility time; the worker's first tick
    // after it is 8:14 (codex #4140 r6).
    // The legacy path likewise: the target becomes a whole-minute delay and
    // the eligibility instant is rebuilt from a later Date.now(), so the row
    // is eligible just after 8:00 and the */15 scheduler sends at 8:15 (r18 P2).
    const tick = windowOpenTickISO(addETDays(new Date(), 1), preview, { after: true });
    return tick ? `Review text goes out separately tomorrow at the first ${tickNoun(preview)} after 8:00 AM — about ${fmtReviewTime(tick)}.` : "Review text goes out separately tomorrow at 8:00 AM.";
  }
  if (reviewTiming === "custom") return customReviewTimingHint(reviewCustomAt, preview);
  return "";
}
const fmtReviewTime = (d) => formatETDateTime(d, { weekday: "short", hour: "numeric", minute: "2-digit" });
// The server's MAX_REVIEW_DELAY_MINUTES (complete-scheduled-service.js).
export const MAX_REVIEW_DELAY_MS = 30 * 24 * 60 * 60000;
// The first cadence tick after the 8 AM send window opens on `day` (an ET
// date); null with cadences off or when the server did not name the ticks.
function windowOpenTickISO(day, preview, opts) {
  const openISO = etDatetimeLocalToISO(`${etDateString(day)}T08:00`);
  return openISO ? nextCadenceTickISO(openISO, workerTickMinutes(preview), opts) : null;
}
// The minutes of the hour the worker that will pick the row up runs on: the
// cadence ticks (:14/:44) in cadence mode, the legacy scheduler's */15
// otherwise — both named by the server (codex #4140 r18 P2). Null when it
// did not name them, so no tick is promised.
function workerTickMinutes(preview) {
  if (!preview) return null;
  return (preview.reviewSequencesEnabled ? preview.cadenceTickMinutesOfHour : preview.legacyTickMinutesOfHour) || null;
}
const tickNoun = (preview) => (preview?.reviewSequencesEnabled ? "cadence tick" : "scheduler tick");
// The worker tick a send at `iso` is held to when it falls outside the
// 8 AM–8 PM window (8 PM exclusive): the first tick after the window opens
// that morning, or the next morning after an evening send. Null inside it.
function heldToWindowOpenISO(iso, preview) {
  const { hour } = etParts(new Date(iso));
  if (hour >= 8 && hour < 20) return null;
  return windowOpenTickISO(addETDays(new Date(iso), hour >= 20 ? 1 : 0), preview);
}
// The custom-time mode: the one whose hint parses operator input and has to
// reconcile it with the send window and the worker's ticks.
// A spring-forward gap wall clock (2:30 AM on the DST day) does not exist in
// ET: the client helper and the server's parseETDateTime resolve it to
// different instants, so the hint would promise a tick an hour off the real
// send (codex #4140 r24 P2). Reject it instead of guessing.
export const ET_GAP_TIME_MESSAGE = "That time does not exist in Eastern time (clocks spring forward) — choose another time.";
export function etWallClockExists(value, iso) {
  if (!iso) return false;
  const [, timePart = ""] = String(value).split("T");
  const [h, mi] = timePart.split(":").map(Number);
  const et = etParts(new Date(iso));
  return et.hour === h && et.minute === mi;
}
export function customReviewTimingHint(reviewCustomAt, preview) {
  // The datetime-local value is an ET wall clock (the server parses it with
  // parseETDateTime) — never `new Date(value)`, which reads it in the
  // browser's zone (codex #4140 r1).
  const iso = etDatetimeLocalToISO(reviewCustomAt);
  if (!iso) return "Choose a time for the review text.";
  if (!etWallClockExists(reviewCustomAt, iso)) return ET_GAP_TIME_MESSAGE;
  // The server clamps every review delay to 30 days after completion
  // (MAX_REVIEW_DELAY_MINUTES): a later date would send ~30 days out, not
  // on the chosen day. Say so instead of promising the date (codex #4140 r10 P2).
  if (new Date(iso).getTime() > Date.now() + MAX_REVIEW_DELAY_MS) return `Review times can be at most 30 days after completion (by ${fmtReviewTime(new Date(Date.now() + MAX_REVIEW_DELAY_MS))}) — choose an earlier time.`;
  // Automated texts only go 8 AM–8 PM ET (the send window): a custom time
  // outside it is held to the next window (codex #4140 r3) — but only
  // while GATE_SMS_SEND_WINDOW is on. With the gate dark the server's
  // checkSendWindow passes everything, so the copy must not promise a
  // hold it will not get (codex #4140 r4 P2). The preview says which.
  const windowOn = preview?.smsSendWindowEnabled === true;
  const { hour } = etParts(new Date(iso));
  // In cadence mode the custom time is when the row becomes ELIGIBLE; the
  // worker runs on fixed ticks (:14/:44, sent by the preview), so 4:45 PM
  // cannot text before 5:14 PM. Say the tick, not the wish (codex #4140 r5).
  // `after: true`: the server turns the chosen time into a whole-minute delay
  // and rebuilds the eligibility instant from a later Date.now(), so the row
  // becomes eligible just AFTER the chosen minute — a time typed exactly on
  // :14 goes out at :44 (codex #4140 r6).
  // The legacy */15 scheduler has the same shape (r18 P2).
  const tick = nextCadenceTickISO(iso, workerTickMinutes(preview), { after: true });
  // The window is checked on the TICK when there is one: 7:50 PM is inside
  // the window but its 8:14 PM tick is not, and the validator holds that
  // send to the next morning (codex #4140 r8). 8:00 PM is exclusive.
  const sendHour = tick ? etParts(new Date(tick)).hour : hour;
  if (windowOn && (sendHour < 8 || sendHour >= 20)) {
    // The window opens at 8:00; in cadence mode the worker's first tick
    // after that is 8:14 (codex #4140 r7).
    const openTick = heldToWindowOpenISO(tick || iso, preview);
    const textHint = openTick
      ? `Review text is held for the 8 AM–8 PM window — it goes out at the first ${tickNoun(preview)} after 8 AM following ${fmtReviewTime(iso)}, about ${fmtReviewTime(openTick)}.`
      : `Review text is held for the 8 AM–8 PM window — it goes out at the next 8 AM after ${fmtReviewTime(iso)}.`;
    if (preview?.reviewSequencesEnabled) {
      return `${textHint} If the cadence uses email instead, it can send at the next cadence tick${tick ? `, about ${fmtReviewTime(tick)}` : ""}, without waiting for the SMS window.`;
    }
    return textHint;
  }
  if (tick && tick !== iso) return `Review text goes out separately at the next ${tickNoun(preview)} after ${fmtReviewTime(iso)} — about ${fmtReviewTime(tick)}.`;
  return `Review text goes out separately ${fmtReviewTime(iso)}.`;
}

// The first worker tick on or after `iso` (ticks are minutes of the hour; every
// ET offset is a whole hour, so UTC minutes are the same minutes). Null when
// the server did not name the ticks.
function nextCadenceTickISO(iso, tickMinutes, { after = false } = {}) {
  if (!Array.isArray(tickMinutes) || !tickMinutes.length) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const minute = d.getUTCMinutes();
  // `after`: the eligibility instant lands strictly after this minute.
  const pastTheMinute = after || d.getUTCSeconds() > 0 || d.getUTCMilliseconds() > 0;
  const next = tickMinutes.find((m) => m > minute || (m === minute && !pastTheMinute));
  const t = new Date(d.getTime());
  t.setUTCSeconds(0, 0);
  if (next != null) t.setUTCMinutes(next);
  else t.setUTCHours(t.getUTCHours() + 1, tickMinutes[0]);
  return t.toISOString();
}

// The key two "Automatic" previews are compared by: the server's `bucket`,
// the rule behind the time (a relative answer's instant moves every request).
export const reviewPreviewBucket = (preview) => preview?.bucket ?? null;

// Human copy for a re-entry stepper value ("No wait", "45 min", "2 hr",
// "2 hr 15 min"). Minutes only — the steppers clamp to 0..1440.
export function formatReentryStepperMinutes(min) {
  const n = Math.max(0, Math.round(Number(min) || 0));
  if (n === 0) return "No wait";
  const hr = Math.floor(n / 60);
  const rem = n % 60;
  if (!hr) return `${n} min`;
  return rem ? `${hr} hr ${rem} min` : `${hr} hr`;
}

// timeOnSite fragment of the completion POST body. The panel's running
// `elapsed` derives from the visit's ORIGINAL check-in — for a stale on_site
// row that's days or weeks — and the server books any submitted timeOnSite
// as explicit operator input (persisted service duration + job-costing
// labor). Under a backdated closeout only an operator-TYPED positive number
// of minutes may travel; blank/invalid omits the key so the duration stays
// unknown. On a live completion the wire contract is TYPE-based: a NUMBER
// is an admin-typed override of the running timer (validated 1..720 —
// out-of-range falls back to the elapsed string so a stray value never
// ships as operator input; handleSubmit blocks it with an alert first), a
// string is the auto-elapsed timer, recorded exactly as before. A prepared
// combined-visit form omits only that automatic string so packet save can
// allocate the shared canonical duration across members; explicit numeric
// operator input remains attached to its member.
export function completionTimeOnSiteBody({ backfill, typedMinutes, elapsed, adjustedMinutes = "", preparing = false }) {
  if (!backfill) {
    const trimmed = String(adjustedMinutes ?? "").trim();
    if (trimmed !== "") {
      const minutes = Math.round(Number(trimmed));
      if (Number.isFinite(minutes) && minutes >= 1 && minutes <= 720) {
        return { timeOnSite: minutes };
      }
    }
    return preparing ? {} : { timeOnSite: elapsed };
  }
  const minutes = Math.round(Number(typedMinutes));
  return Number.isFinite(minutes) && minutes > 0 ? { timeOnSite: minutes } : {};
}

// Why the review ask will not go out for this completion, or null when it
// follows the operator's toggle. "backfill" mirrors the server forcing
// requestReview=false under a backdated quiet closeout — with the reason set,
// the review checkbox shows the suppressed state and the custom-review-time
// validation never blocks a submit the server would silence anyway.
export function completionReviewSuppressionReason({
  isIncompleteVisit = false,
  backfillQuietCloseout = false,
  visitOutcome = "completed",
  customerConcernInteraction = false,
} = {}) {
  if (isIncompleteVisit) return "incomplete";
  if (backfillQuietCloseout) return "backfill";
  if (visitOutcome === "customer_declined") return "customer_declined";
  if (visitOutcome === "customer_concern" || customerConcernInteraction) {
    return "customer_concern";
  }
  // NOTE (coverage fix, 2026-07-30): an invoiced completion is deliberately
  // NOT a client-side suppression anymore. The server owns the invoice rule —
  // a completion-time ask is blocked only while the invoice is UNPAID
  // (admin-dispatch effectiveRequestReview), and the paid-invoice webhook
  // queues the ask when payment lands. The old blanket willInvoice=false here
  // posted requestReview=false, which killed the ask on BOTH sides — including
  // completions paid on the spot — and drove review coverage to near zero.
  return null;
}

export function completionWillReview({
  oneTimeRecapOnly = false,
  requestReview = true,
  reviewSuppressionReason = null,
} = {}) {
  return (oneTimeRecapOnly || !!requestReview) && !reviewSuppressionReason;
}

// The path of the server preview of the "Automatic" send time (GET /admin/reviews/send-time-preview).
export const reviewSendPreviewPath = (serviceType) => `/admin/reviews/send-time-preview?${new URLSearchParams({ serviceType: serviceType || "" })}`;

// The ET wall clock a "Tomorrow at 8 AM" or custom timing sends at; null for Automatic,
// customer-requested, a suppressed review and a one-time recap.
export function reviewScheduledForOf({ willReview, oneTimeRecapOnly = false, reviewTiming, reviewCustomAt }) {
  if (!willReview || oneTimeRecapOnly) return null;
  if (reviewTiming === "tomorrow_8") {
    return `${etDateString(addETDays(new Date(), 1))}T08:00`;
  }
  if (reviewTiming === "custom") return reviewCustomAt || null;
  return null;
}

// The explicit delay a timing posts: null when the choice is incomplete (custom, nothing valid
// typed), undefined for Automatic (no explicit delay: the server picks the smart send window).
export function reviewDelayMinutesOf({ willReview, oneTimeRecapOnly = false, reviewTiming, reviewCustomAt }) {
  if (!willReview) return null;
  if (oneTimeRecapOnly || reviewTiming === "customer_requested") return 0;
  if (reviewTiming === "custom") {
    const target = new Date(reviewCustomAt);
    return reviewCustomAt && !Number.isNaN(target.getTime()) ? 0 : null;
  }
  if (reviewTiming === "tomorrow_8") return 0;
  return undefined;
}

// The submit-time check of a custom review time: the problem in words, or null when it stands.
// The ONLY time-dependent pre-submit gate (the datetime-local value is an ET wall clock, as the
// server parses it, never `new Date(value)`, which reads it in the browser's zone: codex #4140 r13 P1).
export function customReviewTimeProblem(reviewCustomAt) {
  const targetISO = etDatetimeLocalToISO(reviewCustomAt);
  const target = new Date(targetISO || NaN);
  if (!reviewCustomAt || Number.isNaN(target.getTime()) || target.getTime() <= Date.now()) {
    return "Choose a future review request time.";
  }
  if (!etWallClockExists(reviewCustomAt, targetISO)) return ET_GAP_TIME_MESSAGE;
  // The server clamps to 30 days; a later time would silently move (codex #4140 r10 P2).
  if (target.getTime() > Date.now() + MAX_REVIEW_DELAY_MS) {
    return "The review request time can be at most 30 days after completion.";
  }
  return null;
}

// What to do with the fresh send-time preview read at submit, against the one the screen shows
// (`shown`): null to go on, else { message, noticed, dropShown }. A bucket change of an Automatic
// time needs the operator's second look; a failed re-check stops ONCE (`failureNoticed`), after
// which the submit proceeds and the server computes the window itself (codex #4140 r3, r13, r18).
export function reviewPreviewSubmitVerdict({ reviewTiming, fresh, shown, failureNoticed }) {
  if (reviewTiming === "auto" && fresh && shown && reviewPreviewBucket(fresh) !== reviewPreviewBucket(shown)) {
    return { message: `The automatic review time changed to ${formatETDateTime(fresh.at, { weekday: "short", hour: "numeric", minute: "2-digit" })}. Submit again to confirm.` };
  }
  if (!fresh && !failureNoticed) {
    return {
      noticed: true,
      dropShown: !!shown,
      message: reviewTiming === "auto" && shown
        ? "The automatic review time could not be re-checked. The server will pick the smart send window — submit again to continue."
        : "Whether automated review texts can send could not be checked. If the scheduler is off nothing sends; the choice is still recorded on this visit. Submit again to continue.",
    };
  }
  return null;
}

// The hint under the review timing, and whether the review link rides inside the completion
// text (the server's shouldBundleReview as far as it is known before the completion exists).
// An unpaid invoice holds the customer-requested ask server-side (invoiceBlocksReview), so the
// preview must not promise the link the timing hint says waits for payment (codex #4140 r22 P2).
// The one-time recap path is exempt server-side (recapReviewOnly) and stays exempt here.
export function completionReviewHint({ willReview, oneTimeRecapOnly = false, effectiveSendSms, reviewTiming, reviewCustomAt, preview, reviewAwaitsPayment }) {
  const bundled = willReview
    && effectiveSendSms
    && (oneTimeRecapOnly
      || (reviewTiming === "customer_requested"
        && preview?.bundlesImmediateAsk === true
        && !reviewAwaitsPayment));
  const text = willReview && !oneTimeRecapOnly
    ? reviewTimingHint({ reviewTiming, reviewCustomAt, preview, bundled, awaitsPayment: reviewAwaitsPayment })
    : "";
  return { text, bundled };
}
