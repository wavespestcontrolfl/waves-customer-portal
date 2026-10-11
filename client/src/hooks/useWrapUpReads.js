// client/src/hooks/useWrapUpReads.js
//
// The three reads behind the Fast Complete Wrap-up (components/tech/FastCompleteWrapUp.jsx), each
// the full Complete Service form's own read: the re-entry stepper seeds, the customer's next
// scheduled visit, and the server preview of the "Automatic" review send time.
import { useEffect, useRef, useState } from 'react';
import { adoptSeed, reentrySeedsFrom, stepReentry } from '../lib/fast-complete-wrap-up';
import { reviewPreviewSubmitVerdict, reviewSendPreviewPath } from '../lib/completion-review-timing';

const PREVIEW_POLL_MS = 60 * 1000;

// What a hands-off completion would persist, per side. A failed read hides the steppers and posts nothing.
export function useReentrySteppers({ enabled, serviceId, base, requestRef, applicationsRecorded }) {
  const [seeds, setSeeds] = useState(null);
  const [ext, setExt] = useState(null);
  const [int, setInt] = useState(null);
  const seedsRef = useRef(null);
  useEffect(() => {
    if (!enabled || !serviceId) return undefined;
    let live = true;
    const adopt = (data) => {
      const next = reentrySeedsFrom(data);
      const prev = seedsRef.current;
      seedsRef.current = next;
      setSeeds(next);
      setExt((cur) => adoptSeed(cur, prev?.exteriorMinutes, next.exteriorMinutes));
      setInt((cur) => adoptSeed(cur, prev?.interiorMinutes, next.interiorMinutes));
    };
    const clear = () => {
      seedsRef.current = null;
      setSeeds(null);
      setExt(null);
      setInt(null);
    };
    requestRef.current(`${base}/reentry-defaults?applicationsRecorded=${applicationsRecorded ? 1 : 0}`)
      .then((data) => { if (live) adopt(data); })
      .catch(() => { if (live) clear(); });
    return () => { live = false; };
  }, [enabled, serviceId, base, applicationsRecorded, requestRef]);
  return { seeds, ext, int, stepExt: (delta) => setExt(stepReentry(delta)), stepInt: (delta) => setInt(stepReentry(delta)) };
}

export function useNextVisit({ enabled, customerId, requestRef }) {
  const [nextVisit, setNextVisit] = useState(null);
  useEffect(() => {
    if (!enabled || !customerId) return undefined;
    let live = true;
    requestRef.current(`/admin/schedule/next-visit?customerId=${customerId}`)
      .then((data) => { if (live && data?.nextVisit) setNextVisit(data.nextVisit); })
      .catch(() => {});
    return () => { live = false; };
  }, [enabled, customerId, requestRef]);
  return nextVisit;
}

// The preview, read again each minute while the review is asked for (the smart window is bucketed by
// time of day). Off, it is forgotten: a preview cached from before must not count as known at submit.
// `recheck(reviewTiming)` is the submit-time read: it applies a fresh answer and returns the verdict
// (null to go on, else { message }), per the full form's guards (codex #4140 r3, r13, r18).
export function useReviewPreview({ enabled, willReview, serviceId, serviceType, requestRef }) {
  const [preview, setPreview] = useState(null);
  const previewRef = useRef(null);
  previewRef.current = preview;
  const failureNoticedRef = useRef(false);
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
  }, [enabled, serviceId, serviceType, willReview, requestRef]);

  const recheck = async (reviewTiming) => {
    const fresh = await fetchPreview();
    const shown = previewRef.current;
    if (fresh) setPreview(fresh);
    const verdict = reviewPreviewSubmitVerdict({ reviewTiming, fresh, shown, failureNoticed: failureNoticedRef.current });
    if (verdict?.noticed) failureNoticedRef.current = true;
    if (verdict?.dropShown) setPreview(null);
    return verdict;
  };
  return { preview, previewRef, recheck };
}
