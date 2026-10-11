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
  completionWillReview,
  formatReentryStepperMinutes,
} from '../../lib/completion-review-timing';
import {
  REENTRY_MAX,
  adjustedTimeProblem,
  customTimeProblem,
  previewRecheckWanted,
  reviewTimeMissingProblem,
  wrapUpBilling,
  wrapUpFields,
} from '../../lib/fast-complete-wrap-up';
import { etDateString, formatETDateOnly } from '../../lib/timezone';
import { useNextVisit, useReentrySteppers, useReviewPreview } from '../../hooks/useWrapUpReads';
import { TimeOnSite } from './FastCompleteParts';
import { Button, Checkbox, Input, Select } from '../ui';
import '../../styles/tech-workflow.css';

// The steppers' step, the full form's.
const REENTRY_STEPS = { exterior: 5, interior: 15 };
const NEXT_VISIT_DATE = { weekday: 'short', month: 'short', day: 'numeric' };
const INITIAL_CHOICE = { sendSms: true, includePayLink: true, requestReview: true, reviewTiming: REVIEW_TIMING_DEFAULT, reviewCustomAt: '', adjusted: '' };

// `gate` is the context's `wrapUp` (GATE_FAST_COMPLETE_WRAP_UP). Off, or a part of a grouped stop
// (`submission.preparing`, or a `sharedNote`), the section is not `enabled`: nothing is read, drawn or
// sent, and `fields(fallback)` is the fallback the sheet always posted. `applicationsRecorded`: the sheet
// records a product (the full form's spray evidence), which brings the re-entry steppers back on
// a no-spray visit. `customerConcern`: the full form's fourth customer choice, which suppresses
// the review ask (the sheets offer three choices, so they pass false). `omitAutoTiming`: the sheet
// posted no `reviewTiming` before (the pest report flow), so the key stays absent while the timing is
// Automatic. `onChecking(busy)`: the sheet that owns Close and the lock hears when the
// submit-time check starts and ends.
export function useWrapUp({ gate, submission, sharedNote, service, request, base, applicationsRecorded, customerConcern, omitAutoTiming, onChecking }) {
  const enabled = gate === true && !submission?.preparing && sharedNote == null;
  const requestRef = useRef(request);
  requestRef.current = request;
  const isAdmin = enabled && getAdminUser()?.role === 'admin';
  const [choice, setChoice] = useState(INITIAL_CHOICE);
  const [notice, setNotice] = useState('');
  const [checking, setChecking] = useState(false);
  const aliveRef = useRef(true);
  const checkingRef = useRef(false);
  const onCheckingRef = useRef(onChecking);
  onCheckingRef.current = onChecking;
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; onCheckingRef.current?.(false); };
  }, []);

  const billing = wrapUpBilling(service);
  const suppression = completionReviewSuppressionReason({ customerConcernInteraction: customerConcern });
  const willReview = completionWillReview({ requestReview: choice.requestReview, reviewSuppressionReason: suppression });
  const stepper = useReentrySteppers({ enabled, serviceId: service?.id, base, requestRef, applicationsRecorded });
  const nextVisit = useNextVisit({ enabled, customerId: service?.customerId || service?.routedCustomerId, requestRef });
  const review = useReviewPreview({ enabled, willReview, serviceId: service?.id, serviceType: service?.serviceType, requestRef });
  const hint = completionReviewHint({ willReview, effectiveSendSms: choice.sendSms, reviewTiming: choice.reviewTiming, reviewCustomAt: choice.reviewCustomAt, preview: review.preview, reviewAwaitsPayment: billing.reviewAwaitsPayment }).text;

  const state = { ...choice, omitAutoTiming, adjusted: isAdmin ? choice.adjusted : '', isAdmin, willReview, willInvoice: billing.willInvoice, ext: stepper.ext, int: stepper.int, seeds: stepper.seeds };
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => { setNotice(''); }, [choice.reviewTiming, choice.reviewCustomAt, choice.adjusted, choice.requestReview]);

  // The submit-time guards of the full form, in its order: a problem is a words-only stop.
  const runCheck = async () => {
    const early = adjustedTimeProblem(latest.current) || reviewTimeMissingProblem(latest.current);
    if (early) return early;
    const schedulerStateKnown = typeof review.previewRef.current?.schedulerEnabled === 'boolean';
    if (previewRecheckWanted({ ...latest.current, schedulerStateKnown })) {
      const verdict = await review.recheck(latest.current.reviewTiming);
      if (verdict) return verdict.message;
    }
    return customTimeProblem(latest.current);
  };
  // Resolves true to go on; false after saying why in `notice`, or when the sheet is gone by the
  // time the answer lands. While it runs the sheet is locked like a submit (`checking`).
  const check = async () => {
    if (checkingRef.current) return false;
    checkingRef.current = true;
    setNotice('');
    setChecking(true);
    onCheckingRef.current?.(true);
    try {
      const problem = await runCheck();
      if (!aliveRef.current) return false;
      setNotice(problem || '');
      return !problem;
    } finally {
      checkingRef.current = false;
      if (aliveRef.current) setChecking(false);
      onCheckingRef.current?.(false);
    }
  };

  return {
    enabled,
    isAdmin,
    checking,
    // The body's customer-text part: the section's choices, or `fallback` while it is off.
    fields: (fallback) => (enabled ? wrapUpFields(latest.current) : fallback),
    // A stored attempt replays its body unchanged, so only a fresh submit is checked.
    needsCheck: () => enabled && !submission?.hasPendingBody(),
    // While the check reads, the footer shows the submit's busy state and cannot be tapped twice.
    lock: (current) => (checking ? { ...current, submitting: true } : current),
    check,
    // What the section draws.
    view: {
      choice,
      set: (key) => (value) => setChoice((prev) => ({ ...prev, [key]: value })),
      stepper,
      nextVisit,
      willReview,
      suppression,
      hint,
      notice,
      willInvoice: billing.willInvoice,
      payerBanner: billing.payerBanner,
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

function AdjustTimeRow({ value, onChange }) {
  const id = useId();
  return (
    <div className="tech-wrapup-block">
      <label htmlFor={id} className="tech-product-editor-label">Adjust time on site (minutes)</label>
      <Input id={id} className="tech-visit-control" type="number" inputMode="numeric" min="1" max="720" step="1" value={value} placeholder="Use timer" onChange={(e) => onChange(e.target.value)} />
      <p className="tech-visit-muted">Overrides the running timer in the recorded duration. Leave blank to record the timer.</p>
    </div>
  );
}

function ReentryBlock({ stepper }) {
  const { seeds } = stepper;
  if (!seeds || (seeds.exteriorMinutes <= 0 && seeds.interiorMinutes <= 0)) return null;
  return (
    <div className="tech-wrapup-block">
      <span className="tech-product-editor-label">Re-entry countdown</span>
      <p className="tech-visit-muted">What the customer&apos;s report counts down before treated areas are ready.</p>
      {seeds.exteriorMinutes > 0 && (
        <ReentryRow label="Exterior (dry-down)" step={REENTRY_STEPS.exterior} value={stepper.ext ?? seeds.exteriorMinutes} onStep={stepper.stepExt} />
      )}
      {seeds.interiorMinutes > 0 && (
        <ReentryRow label="Interior re-entry" step={REENTRY_STEPS.interior} value={stepper.int ?? seeds.interiorMinutes} onStep={stepper.stepInt} />
      )}
    </div>
  );
}

function PayLinkRow({ checked, onChange }) {
  return (
    <Toggle indent checked={checked} onChange={onChange}>
      Include payment link in the text
      <span className="tech-visit-muted">
        {checked ? 'Texts the service report and the pay link.' : 'Report only — no pay link (e.g. paid in person).'}
      </span>
    </Toggle>
  );
}

function ReviewTiming({ choice, set, hint }) {
  return (
    <div className="tech-wrapup-timing tech-wrapup-indent">
      <Select className="tech-visit-control" aria-label="Review request timing" value={choice.reviewTiming} onChange={(e) => set('reviewTiming')(e.target.value)}>
        {REVIEW_TIMING_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </Select>
      {choice.reviewTiming === 'custom' && (
        <Input
          className="tech-visit-control"
          type="datetime-local"
          aria-label="Custom review time"
          value={choice.reviewCustomAt}
          max={`${etDateString(new Date(Date.now() + MAX_REVIEW_DELAY_MS))}T23:59`}
          onChange={(e) => set('reviewCustomAt')(e.target.value)}
        />
      )}
      <p className="tech-visit-muted">{hint}</p>
    </div>
  );
}

function NextVisitBlock({ nextVisit }) {
  return (
    <div className="tech-wrapup-block">
      <span className="tech-product-editor-label">Next scheduled visit</span>
      <p className="tech-wrapup-next">{formatETDateOnly(nextVisit.date, NEXT_VISIT_DATE) || 'N/A'}</p>
      <p className="tech-visit-muted">{nextVisit.serviceType || 'Standard service'}</p>
    </div>
  );
}

export default function FastCompleteWrapUp({ wrapUp }) {
  if (!wrapUp?.enabled) return null;
  const { choice, set, stepper, nextVisit, willReview, suppression, hint, notice, willInvoice, payerBanner } = wrapUp.view;
  return (
    <section className="tech-visit-choice-section tech-wrapup" aria-label="Wrap-up">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Wrap-up</h3>
      </div>
      {payerBanner && <p className="tech-visit-status--warn" role="status">{payerBanner}</p>}
      {wrapUp.isAdmin && <AdjustTimeRow value={choice.adjusted} onChange={set('adjusted')} />}
      <ReentryBlock stepper={stepper} />
      <Toggle checked={choice.sendSms} onChange={set('sendSms')}>Send completion text</Toggle>
      {willInvoice && choice.sendSms && !payerBanner && <PayLinkRow checked={choice.includePayLink} onChange={set('includePayLink')} />}
      <Toggle checked={willReview} disabled={!!suppression} onChange={set('requestReview')}>
        {suppression ? 'Review request suppressed' : 'Send review request'}
      </Toggle>
      {willReview && <ReviewTiming choice={choice} set={set} hint={hint} />}
      {nextVisit && <NextVisitBlock nextVisit={nextVisit} />}
      {notice && <p className="tech-visit-feedback" role="alert">{notice}</p>}
    </section>
  );
}

// The Time on-site clock, shown with the Wrap-up (the lawn sheet's own, shared) and nothing while it is off.
export function WrapUpClock({ wrapUp, since }) {
  return wrapUp.enabled ? <TimeOnSite since={since} /> : null;
}
