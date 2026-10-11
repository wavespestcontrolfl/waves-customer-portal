// client/src/lib/fast-complete-wrap-up.js
//
// The pure rules of the Fast Complete Wrap-up section (components/tech/FastCompleteWrapUp.jsx):
// the body fragment it posts, the submit-time guards, the re-entry seeds, and the billing facts
// that decide which rows show. Each rule is the full Complete Service form's, from the same lib
// functions (lib/completion-review-timing.js, lib/completion-invoice-prediction.js).
import {
  REVIEW_TIMING_DEFAULT,
  completionTimeOnSiteBody,
  customReviewTimeProblem,
  reviewDelayMinutesOf,
  reviewScheduledForOf,
} from './completion-review-timing';
import { completionInvoicePrediction } from './completion-invoice-prediction';

export const REENTRY_MAX = 1440;
export const ADJUSTED_RANGE_MESSAGE = 'Adjusted time on site must be 1–720 minutes.';
export const REVIEW_TIME_MISSING_MESSAGE = 'Choose a review request time.';

// Will the completion invoice, and who pays: the schedule row's own facts. A confirmed third-party
// payer gets the banner and no pay-link row.
export function wrapUpBilling(service) {
  const { willInvoice, reviewAwaitsPayment } = completionInvoicePrediction({ service: service || {}, visitPrice: service?.estimatedPrice });
  const payer = service?.billedToPayer;
  const payerBanner = payer
    ? `Billed to ${payer.name || 'a third-party payer'} — don't collect payment on site. The invoice goes to the payer, and the customer's completion text gets no pay link.`
    : null;
  return { willInvoice, reviewAwaitsPayment, payerBanner };
}

// The re-entry seeds the server names: a side with no countdown is 0.
const seedSide = (value) => {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
};
export const reentrySeedsFrom = (data) => ({ exteriorMinutes: seedSide(data?.exteriorMinutes), interiorMinutes: seedSide(data?.interiorMinutes) });

// A side whose seed drops to 0 hides its stepper, so its value follows to 0; a side the tech never
// moved adopts the new seed; a moved side is never clobbered.
export const adoptSeed = (current, previousSeed, seed) => (seed === 0 || current == null || current === previousSeed ? seed : current);

// A stepper value is posted only once it is off its seed.
export const reentryMoved = (value, seed) => value != null && value !== (seed ?? null);

export const stepReentry = (delta) => (current) => Math.min(REENTRY_MAX, Math.max(0, (current ?? 0) + delta));

// The review timing keys. `reviewTiming` always posts, unless `omitAutoTiming` (a sheet that posted
// no `reviewTiming` before keeps the key absent while the timing is Automatic). The explicit delay
// and time post only off Automatic, as the full form's reviewDelayMinutes / reviewScheduledFor do.
function timingFields(timing, omitAutoTiming) {
  if (timing.reviewTiming === REVIEW_TIMING_DEFAULT) return omitAutoTiming ? {} : { reviewTiming: timing.reviewTiming };
  return { reviewTiming: timing.reviewTiming, reviewDelayMinutes: reviewDelayMinutesOf(timing), reviewScheduledFor: reviewScheduledForOf(timing) };
}

function reentryFields({ ext, int, seeds }) {
  return {
    ...(reentryMoved(ext, seeds?.exteriorMinutes) ? { reentryExteriorMinutes: ext } : {}),
    ...(reentryMoved(int, seeds?.interiorMinutes) ? { reentryInteriorMinutes: int } : {}),
  };
}

// The pay link a sheet posts. A sheet whose text carries no pay link (`noPayLink`: the pest re-service's
// fixed text and its report-flow text) posts false whatever the tech does; any other posts the tech's
// choice only while the visit invoices and the text is on, else true.
const payLinkPosted = ({ noPayLink, willInvoice, sendSms, includePayLink }) => (noPayLink ? false : (willInvoice && sendSms ? includePayLink : true));

// The body fragment. Untouched it is the four customer-text flags the sheets always posted; every
// other key appears only when the tech changed it. `adjusted` is the admin's typed minutes ('' for
// anyone else): blank sends nothing (the server measures check-in to Complete), a number overrides.
export function wrapUpFields({ sendSms, includePayLink, willInvoice, willReview, reviewTiming, reviewCustomAt, adjusted, ext, int, seeds, omitAutoTiming, noPayLink }) {
  const timing = { willReview, reviewTiming, reviewCustomAt };
  return {
    sendCompletionSms: sendSms,
    includePayLink: payLinkPosted({ noPayLink, willInvoice, sendSms, includePayLink }),
    requestReview: willReview,
    ...timingFields(timing, omitAutoTiming),
    ...completionTimeOnSiteBody({ backfill: false, adjustedMinutes: adjusted, elapsed: '', preparing: true }),
    ...reentryFields({ ext, int, seeds }),
  };
}

// Submit-time guards, in the full form's order. Each returns the problem in words, or null.
// A typo in the override must never silently fall back to the inflated timer.
export function adjustedTimeProblem({ isAdmin, adjusted }) {
  if (!isAdmin || String(adjusted || '').trim() === '') return null;
  const minutes = Math.round(Number(adjusted));
  return Number.isFinite(minutes) && minutes >= 1 && minutes <= 720 ? null : ADJUSTED_RANGE_MESSAGE;
}

export function reviewTimeMissingProblem(timing) {
  return timing.willReview && reviewDelayMinutesOf(timing) === null ? REVIEW_TIME_MISSING_MESSAGE : null;
}

export function customTimeProblem({ willReview, reviewTiming, reviewCustomAt }) {
  return willReview && reviewTiming === 'custom' ? customReviewTimeProblem(reviewCustomAt) : null;
}

// "Automatic" is a server decision bucketed by time of day, so it is read again at submit. Every
// other timing is read again only while the scheduler's state is unknown, so a submit never
// silently accepts an ask that may never send.
export const previewRecheckWanted = ({ willReview, reviewTiming, schedulerStateKnown }) => willReview && (reviewTiming === REVIEW_TIMING_DEFAULT || !schedulerStateKnown);
