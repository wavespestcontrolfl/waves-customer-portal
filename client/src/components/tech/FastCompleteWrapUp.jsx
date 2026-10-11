// client/src/components/tech/FastCompleteWrapUp.jsx
//
// The "Wrap-up" section of the Fast Complete sheets (GATE_FAST_COMPLETE_WRAP_UP): the bottom of the
// full Complete Service form (SchedulePage's CompletionPanel, "Options" and "Next scheduled visit")
// on the sheet. Always open: the sheets are made to be fast, not short. Its rows and the rules for
// showing, disabling and posting each one are the full form's, from the same lib functions
// (lib/completion-review-timing.js, lib/completion-invoice-prediction.js).
//
// useWrapUp holds the state and yields the body fragment (`fields()`) and the submit-time guard
// (`check()`); the sheet spreads the fragment into its /complete body in place of the fixed
// customer-text flags, so the shared submit hook (stored attempts, retry under the same key) sees
// one body. Untouched, the fragment is exactly those four flags. "Backdated closeout" and "One-time
// recap + review only" change charging and invoicing: they stay on the full form.
import React, { useEffect, useId, useRef, useState } from 'react';
import { getAdminUser } from '../../lib/adminAuth';
import {
  REVIEW_TIMING_DEFAULT,
  REVIEW_TIMING_OPTIONS,
  MAX_REVIEW_DELAY_MS,
  completionReviewHint,
  completionReviewSuppressionReason,
  completionTimeOnSiteBody,
  completionWillReview,
  customReviewTimeProblem,
  formatReentryStepperMinutes,
  reviewDelayMinutesOf,
  reviewPreviewSubmitVerdict,
  reviewScheduledForOf,
  reviewSendPreviewPath,
} from '../../lib/completion-review-timing';
import { completionInvoicePrediction } from '../../lib/completion-invoice-prediction';
import { etDateString } from '../../lib/timezone';
import { Button, Checkbox, Input, Select } from '../ui';
import '../../styles/tech-workflow.css';

// The steppers' step and ceiling, the full form's.
const REENTRY_STEPS = { exterior: 5, interior: 15 };
const REENTRY_MAX = 1440;
const PREVIEW_POLL_MS = 60 * 1000;
const ADJUSTED_RANGE_MESSAGE = 'Adjusted time on site must be 1–720 minutes.';

const nextVisitDate = (date) => (date
  ? new Date(`${date}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  : 'N/A');

const stepReentry = (delta) => (current) => Math.min(REENTRY_MAX, Math.max(0, (current ?? 0) + delta));

// `enabled` false (the gate is off, or a part of a grouped stop): nothing is read and nothing is
// sent; `fields()` is the four flags the sheets always posted. `applicationsRecorded`: the sheet
// records a product (the full form's spray evidence), which brings the re-entry steppers back on
// a no-spray visit. `customerConcern`: the full form's fourth customer choice, which suppresses
// the review ask (the sheets offer three choices, so they pass false).
export function useWrapUp({ enabled, service, request, base, applicationsRecorded = false, customerConcern = false }) {
  const serviceId = service?.id;
  const customerId = service?.customerId || service?.routedCustomerId || null;
  const serviceType = service?.serviceType || '';
  const requestRef = useRef(request);
  requestRef.current = request;
  const isAdmin = enabled && getAdminUser()?.role === 'admin';

  const [sendSms, setSendSms] = useState(true);
  const [includePayLink, setIncludePayLink] = useState(true);
  const [requestReview, setRequestReview] = useState(true);
  const [reviewTiming, setReviewTiming] = useState(REVIEW_TIMING_DEFAULT);
  const [reviewCustomAt, setReviewCustomAt] = useState('');
  const [adjusted, setAdjusted] = useState('');
  const [reentrySeeds, setReentrySeeds] = useState(null);
  const [reentryExt, setReentryExt] = useState(null);
  const [reentryInt, setReentryInt] = useState(null);
  const [nextVisit, setNextVisit] = useState(null);
  const [nextNoteOpen, setNextNoteOpen] = useState(false);
  const [nextNote, setNextNote] = useState('');
  const [preview, setPreview] = useState(null);
  const [notice, setNotice] = useState('');
  const previewRef = useRef(null);
  previewRef.current = preview;
  const failureNoticedRef = useRef(false);
  const recheckingRef = useRef(false);
  const reentrySeedsRef = useRef(null);

  const { willInvoice, reviewAwaitsPayment } = completionInvoicePrediction({ service: service || {}, visitPrice: service?.estimatedPrice });
  const payerBanner = service?.billedToPayer
    ? `Billed to ${service.billedToPayer.name || 'a third-party payer'} — don't collect payment on site. The invoice goes to the payer, and the customer's completion text gets no pay link.`
    : null;
  const suppression = completionReviewSuppressionReason({ customerConcernInteraction: customerConcern });
  const willReview = completionWillReview({ requestReview, reviewSuppressionReason: suppression });
  const hint = completionReviewHint({ willReview, effectiveSendSms: sendSms, reviewTiming, reviewCustomAt, preview, reviewAwaitsPayment }).text;

  // The re-entry steppers' seeds (the full form's rule): what a hands-off completion would persist.
  // A side the tech never moved adopts a new seed; a moved side is never clobbered; a failed read
  // hides the steppers and posts nothing.
  useEffect(() => {
    if (!enabled || !serviceId) return undefined;
    let live = true;
    requestRef.current(`${base}/reentry-defaults?applicationsRecorded=${applicationsRecorded ? 1 : 0}`)
      .then((data) => {
        if (!live) return;
        const ext = Number(data?.exteriorMinutes);
        const int = Number(data?.interiorMinutes);
        const seeds = {
          exteriorMinutes: Number.isFinite(ext) && ext > 0 ? Math.round(ext) : 0,
          interiorMinutes: Number.isFinite(int) && int > 0 ? Math.round(int) : 0,
        };
        const prev = reentrySeedsRef.current;
        reentrySeedsRef.current = seeds;
        setReentrySeeds(seeds);
        // A side whose seed drops to 0 hides its stepper, so its value follows to 0 too.
        setReentryExt((cur) => (seeds.exteriorMinutes === 0 || cur == null || cur === prev?.exteriorMinutes ? seeds.exteriorMinutes : cur));
        setReentryInt((cur) => (seeds.interiorMinutes === 0 || cur == null || cur === prev?.interiorMinutes ? seeds.interiorMinutes : cur));
      })
      .catch(() => {
        if (!live) return;
        reentrySeedsRef.current = null;
        setReentrySeeds(null);
        setReentryExt(null);
        setReentryInt(null);
      });
    return () => { live = false; };
  }, [enabled, serviceId, base, applicationsRecorded]);

  useEffect(() => {
    if (!enabled || !customerId) return undefined;
    let live = true;
    requestRef.current(`/admin/schedule/next-visit?customerId=${customerId}`)
      .then((data) => { if (live && data?.nextVisit) setNextVisit(data.nextVisit); })
      .catch(() => {});
    return () => { live = false; };
  }, [enabled, customerId]);

  // The server preview of the "Automatic" send time, read again each minute while the review is
  // asked for (the smart window is bucketed by time of day). Off, it is forgotten: a preview cached
  // from before must not count as known at submit.
  const fetchPreview = () => requestRef.current(reviewSendPreviewPath(serviceType)).catch(() => null);
  useEffect(() => {
    if (!enabled || !willReview) {
      setPreview(null);
      return undefined;
    }
    let cancelled = false;
    const load = () => fetchPreview().then((data) => {
      if (cancelled) return;
      setPreview(data);
      if (data) failureNoticedRef.current = false;
    });
    load();
    const timer = setInterval(load, PREVIEW_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [enabled, serviceId, serviceType, willReview]);

  // The body fragment. Untouched it is the four flags the sheets always posted; every other key
  // appears only when the tech changed it, as on the full form.
  const extDirty = reentryExt != null && reentryExt !== (reentrySeeds?.exteriorMinutes ?? null);
  const intDirty = reentryInt != null && reentryInt !== (reentrySeeds?.interiorMinutes ?? null);
  const timing = { willReview, reviewTiming, reviewCustomAt };
  const fields = {
    sendCompletionSms: sendSms,
    includePayLink: willInvoice && sendSms ? includePayLink : true,
    requestReview: willReview,
    reviewTiming,
    ...(reviewTiming !== REVIEW_TIMING_DEFAULT
      ? { reviewDelayMinutes: reviewDelayMinutesOf(timing), reviewScheduledFor: reviewScheduledForOf(timing) }
      : {}),
    // Blank sends nothing (the server measures check-in to Complete); a number overrides the timer.
    ...(isAdmin ? completionTimeOnSiteBody({ backfill: false, adjustedMinutes: adjusted, elapsed: '', preparing: true }) : {}),
    ...(extDirty ? { reentryExteriorMinutes: reentryExt } : {}),
    ...(intDirty ? { reentryInteriorMinutes: reentryInt } : {}),
    ...(nextVisit && nextNote ? { nextVisitAdjustmentNote: nextNote } : {}),
  };
  const latest = useRef(null);
  latest.current = { fields, willReview, reviewTiming, reviewCustomAt, isAdmin, adjusted };

  useEffect(() => { setNotice(''); }, [reviewTiming, reviewCustomAt, adjusted, requestReview]);

  // The submit-time guards of the full form, in its order. Resolves true to go on; false after
  // saying why in `notice`. The sheet skips it for a stored attempt it replays (immutable body).
  const check = async () => {
    const stop = (message) => { setNotice(message); return false; };
    setNotice('');
    let now = latest.current;
    // A typo in the override must never silently fall back to the inflated timer.
    if (now.isAdmin && String(now.adjusted || '').trim() !== '') {
      const minutes = Math.round(Number(now.adjusted));
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 720) return stop(ADJUSTED_RANGE_MESSAGE);
    }
    if (now.willReview && reviewDelayMinutesOf(now) === null) return stop('Choose a review request time.');
    // "Automatic" is a server decision bucketed by time of day: read it again so the tech never
    // submits against a preview a boundary just invalidated. Every other timing is read again only
    // while the scheduler's state is unknown, so a submit never silently accepts an ask that may
    // never send.
    const schedulerStateKnown = typeof previewRef.current?.schedulerEnabled === 'boolean';
    if (now.willReview && (now.reviewTiming === REVIEW_TIMING_DEFAULT || !schedulerStateKnown)) {
      if (recheckingRef.current) return false;
      recheckingRef.current = true;
      let fresh;
      try {
        fresh = await fetchPreview();
      } finally {
        recheckingRef.current = false;
      }
      const shown = previewRef.current;
      if (fresh) setPreview(fresh);
      const verdict = reviewPreviewSubmitVerdict({ reviewTiming: now.reviewTiming, fresh, shown, failureNoticed: failureNoticedRef.current });
      if (verdict) {
        if (verdict.noticed) failureNoticedRef.current = true;
        if (verdict.dropShown) setPreview(null);
        return stop(verdict.message);
      }
      now = latest.current;
    }
    if (now.willReview && now.reviewTiming === 'custom') {
      const problem = customReviewTimeProblem(now.reviewCustomAt);
      if (problem) return stop(problem);
    }
    return true;
  };

  return {
    enabled,
    isAdmin,
    fields: () => latest.current.fields,
    check,
    // What the section draws.
    view: {
      sendSms, setSendSms,
      includePayLink, setIncludePayLink,
      requestReview, setRequestReview,
      reviewTiming, setReviewTiming,
      reviewCustomAt, setReviewCustomAt,
      adjusted, setAdjusted,
      reentrySeeds, reentryExt, reentryInt,
      stepExt: (delta) => setReentryExt(stepReentry(delta)),
      stepInt: (delta) => setReentryInt(stepReentry(delta)),
      nextVisit, nextNoteOpen, openNextNote: () => setNextNoteOpen(true), nextNote, setNextNote,
      willInvoice, payerBanner, suppression, willReview, hint, notice,
    },
  };
}

function Toggle({ checked, disabled, onChange, children, indent = false }) {
  return (
    <label className={indent ? 'ui-choice-label tech-visit-choice tech-wrapup-indent' : 'ui-choice-label tech-visit-choice'}>
      <Checkbox className="tech-visit-checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

function ReentryRow({ label, step, value, onStep }) {
  return (
    <div className="tech-wrapup-stepper">
      <div className="tech-wrapup-stepper-text">
        <span>{label}</span>
        <span className="tech-wrapup-stepper-value">{formatReentryStepperMinutes(value)}</span>
      </div>
      <Button type="button" variant="secondary" className="tech-visit-action" aria-label={`Decrease ${label} by ${step} minutes`} disabled={value <= 0} onClick={() => onStep(-step)}>{`−${step}`}</Button>
      <Button type="button" variant="secondary" className="tech-visit-action" aria-label={`Increase ${label} by ${step} minutes`} disabled={value >= REENTRY_MAX} onClick={() => onStep(step)}>{`+${step}`}</Button>
    </div>
  );
}

export default function FastCompleteWrapUp({ wrapUp }) {
  const adjustId = useId();
  if (!wrapUp?.enabled) return null;
  const v = wrapUp.view;
  const seeds = v.reentrySeeds;
  const showReentry = !!seeds && (seeds.exteriorMinutes > 0 || seeds.interiorMinutes > 0);
  return (
    <section className="tech-visit-choice-section tech-wrapup" aria-label="Wrap-up">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Wrap-up</h3>
      </div>
      {v.payerBanner && <p className="tech-visit-status--warn" role="status">{v.payerBanner}</p>}
      {wrapUp.isAdmin && (
        <div className="tech-wrapup-block">
          <label htmlFor={adjustId} className="tech-product-editor-label">Adjust time on site (minutes)</label>
          <Input
            id={adjustId}
            className="tech-visit-control"
            type="number"
            inputMode="numeric"
            min="1"
            max="720"
            step="1"
            value={v.adjusted}
            placeholder="Use timer"
            onChange={(e) => v.setAdjusted(e.target.value)}
          />
          <p className="tech-visit-muted">Overrides the running timer in the recorded duration. Leave blank to record the timer.</p>
        </div>
      )}
      {showReentry && (
        <div className="tech-wrapup-block">
          <span className="tech-product-editor-label">Re-entry countdown</span>
          <p className="tech-visit-muted">What the customer&apos;s report counts down before treated areas are ready.</p>
          {seeds.exteriorMinutes > 0 && (
            <ReentryRow label="Exterior (dry-down)" step={REENTRY_STEPS.exterior} value={v.reentryExt ?? seeds.exteriorMinutes} onStep={v.stepExt} />
          )}
          {seeds.interiorMinutes > 0 && (
            <ReentryRow label="Interior re-entry" step={REENTRY_STEPS.interior} value={v.reentryInt ?? seeds.interiorMinutes} onStep={v.stepInt} />
          )}
        </div>
      )}
      <Toggle checked={v.sendSms} onChange={v.setSendSms}>Send completion text</Toggle>
      {v.willInvoice && v.sendSms && !v.payerBanner && (
        <Toggle indent checked={v.includePayLink} onChange={v.setIncludePayLink}>
          Include payment link in the text
          <span className="tech-visit-muted">
            {v.includePayLink ? 'Texts the service report and the pay link.' : 'Report only — no pay link (e.g. paid in person).'}
          </span>
        </Toggle>
      )}
      <Toggle checked={v.willReview} disabled={!!v.suppression} onChange={v.setRequestReview}>
        {v.suppression ? 'Review request suppressed' : 'Send review request'}
      </Toggle>
      {v.willReview && (
        <div className="tech-wrapup-timing tech-wrapup-indent">
          <Select className="tech-visit-control" aria-label="Review request timing" value={v.reviewTiming} onChange={(e) => v.setReviewTiming(e.target.value)}>
            {REVIEW_TIMING_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select>
          {v.reviewTiming === 'custom' && (
            <Input
              className="tech-visit-control"
              type="datetime-local"
              aria-label="Custom review time"
              value={v.reviewCustomAt}
              max={`${etDateString(new Date(Date.now() + MAX_REVIEW_DELAY_MS))}T23:59`}
              onChange={(e) => v.setReviewCustomAt(e.target.value)}
            />
          )}
          <p className="tech-visit-muted">{v.hint}</p>
        </div>
      )}
      {v.nextVisit && (
        <div className="tech-wrapup-block">
          <span className="tech-product-editor-label">Next scheduled visit</span>
          <p className="tech-wrapup-next">{nextVisitDate(v.nextVisit.date)}</p>
          <p className="tech-visit-muted">{v.nextVisit.serviceType || 'Standard service'}</p>
          {v.nextNoteOpen ? (
            <Input
              className="tech-visit-control"
              type="text"
              aria-label="Next visit adjustment note"
              value={v.nextNote}
              placeholder="Note about next visit adjustment…"
              onChange={(e) => v.setNextNote(e.target.value)}
            />
          ) : (
            <Button type="button" variant="secondary" className="tech-visit-action" onClick={v.openNextNote}>Needs adjustment?</Button>
          )}
        </div>
      )}
      {v.notice && <p className="tech-visit-feedback" role="alert">{v.notice}</p>}
    </section>
  );
}
