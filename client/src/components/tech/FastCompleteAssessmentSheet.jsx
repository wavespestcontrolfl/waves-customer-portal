// client/src/components/tech/FastCompleteAssessmentSheet.jsx
//
// Fast Complete for the WAVES ASSESSMENT (GATE_ASSESSMENT_FAST_COMPLETE, owner
// 2026-10-09): one phone screen instead of the long full form. An assessment is
// an internal-only consultation (completion_mode 'internal_only'): the server
// forces delivery off, sends no text and no review ask, refuses products and a
// rating. So the sheet asks for what the tech has to say and nothing else:
//
//   - a talk note, with the mic (the shared VisitNote and its dictation);
//   - photos, staged on the visit by the photo manager the pest sheet opens and
//     promoted into the record by the server at completion (no body field);
//   - how it went (warm, cold or lost, and why when lost) and what is
//     recommended (the interest chips): the consultation outcome of
//     ConsultationOutcomeSheet.jsx, whose options and payload builder are
//     imported from there, never copied;
//   - an optional "Call back on" date, the office sheet's own follow-up rule
//     (followUpApplies, followUpPayload, its blank-date default);
//   - the customer's estimate, READ-ONLY: whether one exists and whether it
//     went out, and a link that opens it for staff, or "No estimate yet" and a
//     link to start one (owner 2026-10-09: the estimate sets the price). The
//     sheet prints NO amount: the stored totals are annualized accounting
//     figures, not the price a per-application or one-time-option estimate
//     states, and no one function states that price to a person. There is no
//     price field and nothing of the estimate is written into the outcome row;
//     the quote fields the row already holds ride through untouched;
//   - the $75 inspection credit toggle, only where the full form shows it.
//
// Required before Complete: a note and an outcome pick. Nothing else blocks.
//
// ONE write. The read of the visit rides the /complete body as
// `consultationOutcome` (the payload ConsultationOutcomeSheet's own
// buildOutcomePayload builds), and the server records it through recordOutcome
// inside the completion's transaction, under the visit lock it already holds
// (services/completion-consultation-outcome.js). So the read commits with the
// completion and rolls back with it: a visit rescheduled or retyped by someone
// else mid-completion leaves no outcome row behind, and every refusal (a changed
// visit, a dead status, a reassigned visit) arrives as the completion's own
// failure. The completion retries under one idempotency key, resending the SAME
// body, which records the same read again. The only separate request is the
// read of the recorded outcome that seeds the form.
//
// Nothing about the visit is read live: the pest, lawn and tree & shrub sheets
// open their visit through a context route, and none of them takes an
// assessment (the pest recap context answers 409 not_pest_control). The visit
// identity the tech tapped (customer, property, service type, day) goes with
// the completion as `expectedVisit`, and the server compares it with the locked
// visit row, so a visit moved or retyped since the schedule loaded is refused
// (visit_identity_changed) and the tech reopens it.
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { isPathAdminOnly } from '../../config/adminNavigation';
import useIsMobile from '../../hooks/useIsMobile';
import useModalFocus from '../../hooks/useModalFocus';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import useFastCompleteSubmit from '../../hooks/useFastCompleteSubmit';
import useVisiblePageRefresh from '../../hooks/useVisiblePageRefresh';
import { recapVisitIdentity } from '../../hooks/useServiceRecapDraft';
import {
  FOLLOW_UP_DEFAULT_HINT, INTEREST_OPTIONS, LOST_REASON_OPTIONS, OUTCOME_OPTIONS,
  buildOutcomePayload, followUpApplies, followUpPayload, formFromRow, readOnlyReason, useRecordedOutcome, validationErrorOf,
} from '../ConsultationOutcomeSheet';
import { adminEstimateHref, customerEstimateHref } from '../admin/StickyActionBar';
import { estimateLineOf } from '../../lib/assessment-fast-complete';
import { offersInspectionCredit } from '../../lib/pest-fast-complete';
import { InspectionCreditToggle, PhotoStripSection, useVisitPhotos } from './FastCompleteReport';
import {
  Chip, ChoiceSection, CompleteFooter, FastCompleteFrame, RecoveredCompletion, SavedView, SheetHeader, VisitNote,
  refusalWithoutContext, submissionHolds, toggleInSet, usePhotoManager,
} from './FastCompleteParts';
import TechServicePhotosModal from './TechServicePhotosModal';
import { ActionFeedback, Field, Input } from '../ui';
import '../../styles/tech-workflow.css';

// The visit the tech tapped, in the keys the server compares under its row
// lock (pest-recap.js recapVisitIdentityChanged). A key the row does not carry
// is left out, so nothing is compared that the sheet never saw; the address is
// left out too, since the schedule row holds it only as one line of text.
export function assessmentVisitIdentity(service) {
  const identity = {
    customerId: service?.routedCustomerId || undefined,
    propertyId: service?.routedPropertyId,
    serviceType: service?.routedServiceType || undefined,
    scheduledDate: service?.routedScheduledDate || undefined,
  };
  return recapVisitIdentity(identity);
}

// The complete body: what the tech said and nothing the assessment cannot take.
// `offerCredit` is null when the toggle is not shown, and then the field is not
// sent at all (the server's default-on applies, as for a hidden toggle on the
// full form), so a value the tech never saw is never sent.
export function assessmentCompletionBody({ note, offerCredit, expectedVisit, consultationOutcome }) {
  return {
    visitOutcome: 'completed',
    ...(expectedVisit && Object.keys(expectedVisit).length ? { expectedVisit } : {}),
    // Null for a consultation that already converted (won): its read stays.
    ...(consultationOutcome ? { consultationOutcome } : {}),
    technicianNotes: String(note || '').trim(),
    ...(offerCredit === true || offerCredit === false ? { offerInspectionCredit: offerCredit } : {}),
    sendCompletionSms: false,
    requestReview: false,
  };
}

// The estimate that belongs to this assessment, read for display. A read that
// fails or answers nothing shows nothing: the estimate line is a convenience
// and never blocks the sheet. Both links open a new tab, so the read runs again
// when this tab is shown or focused again (useVisiblePageRefresh: one request
// in flight, none while offline or hidden). It holds only the summary; nothing
// the tech typed is touched. A response that is not the newest request's, or
// that lands after unmount, is dropped; a failed refresh keeps the last answer.
export function useAssessmentEstimate(serviceId, request) {
  const [summary, setSummary] = useState(null);
  const latest = useRef(0);
  const load = useCallback(async ({ keepOnError = false } = {}) => {
    const mine = ++latest.current;
    try {
      const data = await request(`/admin/consultations/${encodeURIComponent(serviceId)}/estimate`);
      if (mine === latest.current) setSummary(data?.estimate || null);
    } catch {
      if (mine === latest.current && !keepOnError) setSummary(null);
    }
  }, [serviceId, request]);
  useEffect(() => {
    setSummary(null);
    load();
    // Unmount, or another visit: no later answer of this one may land.
    return () => { latest.current += 1; };
  }, [load]);
  useVisiblePageRefresh(() => load({ keepOnError: true }), { intervalMs: 0 });
  return summary;
}

// Whether this login can reach the staff Estimates page: the admin shell's own
// deep-link rule (AdminLayoutV2: the SERVER-returned role it hands down through
// its Outlet context, and isPathAdminOnly). A technician is redirected off
// /admin/estimates and its APIs require admin, so a link there would only
// bounce. An unknown role gets no link.
const ESTIMATES_PATH = '/admin/estimates';
export function useCanOpenEstimates() {
  const role = useOutletContext()?.user?.role;
  return role === 'admin' || (Boolean(role) && !isPathAdminOnly(ESTIMATES_PATH));
}

// Read-only. No input: the estimate sets the price. Everyone who can use the
// sheet sees the line; the links show only for a login that can open them, in
// a new tab so the note being typed is not lost.
function EstimateLine({ summary, service }) {
  const canOpen = useCanOpenEstimates();
  const line = estimateLineOf(summary);
  if (!line) return null;
  // Open needs the estimate's id, which only an admin's answer carries. Create
  // prefills the visit's FULL address (the sheet's own `address` is the short
  // display line, and the estimate tool looks the property up by this text).
  const href = line.kind === 'found'
    ? (line.estimateId ? adminEstimateHref(line.estimateId) : null)
    : customerEstimateHref({
      id: service?.routedCustomerId,
      name: service?.customerName,
      address: service?.fullAddress || service?.address,
      phone: service?.customerPhone,
    });
  return (
    <section className="tech-visit-card" aria-label="Estimate">
      <p className="tech-visit-muted" role="status">{line.text}</p>
      {canOpen && href && (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {line.kind === 'found' ? 'Open estimate' : 'Create estimate'}
        </a>
      )}
    </section>
  );
}

export default function FastCompleteAssessmentSheet({ service, request, operatorId, onClose, onCompleted, onFullForm }) {
  const isMobile = useIsMobile();
  const closeRef = useRef(null);
  const dialogRef = useModalFocus(true, () => closeRef.current?.());
  useLockBodyScroll(true);
  const titleId = useId();
  const base = `/admin/dispatch/${service?.id}`;
  const recorded = useRecordedOutcome(service?.id, request);
  const submission = useFastCompleteSubmit({ base, request, serviceId: service?.id, operatorId });
  const { submitting, done } = submission;
  const photoManager = usePhotoManager();
  // A recorded dictation clip still being taken or transcribed: the full form
  // carries nothing over, so Full form waits for it, like Complete.
  const [dictationPending, setDictationPending] = useState(false);

  const close = useCallback(() => {
    if (submitting) return;
    // The completion response rides along: admin Dispatch reads it for its bookkeeping.
    if (done) onCompleted?.(done.response || null);
    // A refused or unknown completion, or a recorded read that could not be loaded
    // (the visit may have been reassigned or changed), leaves the schedule row stale.
    else onClose?.(submission.failure || recorded.error ? { refresh: true } : undefined);
  }, [submitting, done, submission.failure, recorded.error, onClose, onCompleted]);
  closeRef.current = close;
  // Nothing is editable while a save is in flight, unresolved or refused for
  // good; the full form cannot resume a /complete attempt.
  const locked = submissionHolds(submission);

  return (
    <FastCompleteFrame
      isMobile={isMobile}
      dialogRef={dialogRef}
      titleId={titleId}
      onDismiss={close}
      hiddenProps={photoManager.hiddenProps}
      overlay={photoManager.isOpen && (
        <TechServicePhotosModal serviceId={service?.id} customerName={service?.customerName} onClose={photoManager.close} />
      )}
    >
      <SheetHeader
        titleId={titleId}
        title={done ? 'Assessment complete' : 'Complete assessment'}
        service={service}
        visit={null}
        done={!!done}
        locked={locked}
        dictationPending={dictationPending}
        submitting={submitting}
        onFullForm={onFullForm}
        onClose={close}
      />
      <SheetBody
        service={service}
        request={request}
        recorded={recorded}
        submission={submission}
        locked={locked}
        photos={photoManager}
        dictationPending={dictationPending}
        onDictationPending={setDictationPending}
        onCompleted={onCompleted}
      />
    </FastCompleteFrame>
  );
}

function SheetBody({ service, request, recorded, submission, locked, photos, dictationPending, onDictationPending, onCompleted }) {
  if (submission.done) {
    return <SavedView service={service} summary={submission.done.summary} notice={submission.done.notice} onCompleted={() => onCompleted?.(submission.done.response || null)} />;
  }
  if (submission.recovering) return <ActionFeedback className="tech-visit-feedback tech-visit-loading">Checking for an unfinished completion…</ActionFeedback>;
  if (submission.restored) return <RecoveredCompletion submission={submission} />;
  const noContext = { loading: recorded.loading, loadError: recorded.error, blockedReason: '' };
  const refusal = refusalWithoutContext(submission, noContext);
  if (refusal) return refusal;
  if (recorded.loading) return <ActionFeedback className="tech-visit-feedback tech-visit-loading">Loading…</ActionFeedback>;
  if (recorded.error) {
    return <ActionFeedback error className="tech-visit-feedback tech-visit-loading">{`${recorded.error} — close and reopen this visit, or use Full form.`}</ActionFeedback>;
  }
  return (
    <AssessmentForm
      service={service}
      request={request}
      row={recorded.row}
      submission={submission}
      locked={locked}
      photos={photos}
      dictationPending={dictationPending}
      onDictationPending={onDictationPending}
    />
  );
}

function AssessmentForm({ service, request, row, submission, locked, photos, dictationPending, onDictationPending }) {
  // The outcome form starts from the recorded read (a tech who completes
  // again, or the office, may have recorded one already), so a soft quote or a
  // follow-up date saved earlier rides through the upsert unchanged.
  const [outcomeForm, setOutcomeForm] = useState(() => formFromRow(row));
  // The office sheet's rule: a date the tech picked is sent; an untouched one
  // rides as saved while the outcome is unchanged (followUpPayload).
  const [followUpTouched, setFollowUpTouched] = useState(false);
  const estimate = useAssessmentEstimate(service?.id, request);
  const [note, setNote] = useState('');
  // The credit toggle: shown exactly where the full form shows it (an
  // inspection profile, the credit lane live, the profile read answered).
  const creditShown = offersInspectionCredit(service) && service?.completionProfileLookupFailed !== true;
  const [offerCredit, setOfferCredit] = useState(true);
  const visitPhotos = useVisitPhotos({ serviceId: service?.id, request, version: photos.version });

  // A won consultation (the sale closed first) keeps its read: the sheet shows
  // it and writes nothing.
  const locksOutcome = readOnlyReason(row);
  const setOutcome = (patch) => setOutcomeForm((prev) => ({ ...prev, ...patch }));
  const appendNote = useCallback((text) => {
    setNote((prev) => (prev.trim() ? `${prev.trimEnd()} ${text}` : text));
  }, []);

  const missingReason = (() => {
    if (dictationPending) return 'Finish dictating before you complete.';
    if (!note.trim()) return 'Tell me about the visit.';
    return locksOutcome ? '' : validationErrorOf(outcomeForm) || '';
  })();

  const submit = () => {
    // A held completion (a retry) resends as it is.
    if (submission.hasPendingBody()) {
      submission.retry();
      return;
    }
    if (missingReason) return;
    submission.submit(
      () => assessmentCompletionBody({
        note,
        offerCredit: creditShown ? offerCredit : null,
        expectedVisit: assessmentVisitIdentity(service),
        consultationOutcome: locksOutcome ? null : buildOutcomePayload(outcomeForm, { followUpTouched, loadedRow: row }),
      }),
      `Assessment · ${locksOutcome ? 'won' : outcomeForm.outcome}`,
    );
  };

  const formLocked = locked || dictationPending;
  // Show the date that will be sent: a saved date the new outcome would not
  // keep is not shown as if it would be (followUpPayload decides, not a copy).
  const followUpShown = followUpTouched || followUpPayload({
    outcome: outcomeForm.outcome, followUpDate: outcomeForm.followUpDate, followUpTouched, loadedRow: row,
  }) ? outcomeForm.followUpDate : '';

  return (
    <div className="tech-visit-form-area">
      <div className="tech-visit-body">
        <fieldset className="tech-visit-form" disabled={locked}>
          <VisitNote note={note} onChange={setNote} onDictated={appendNote} onDictationPending={onDictationPending} serviceId={service?.id} locked={locked} micInside />
          <PhotoStripSection photos={visitPhotos.photos} locked={formLocked} onOpen={photos.open} />
          {locksOutcome ? (
            <section className="tech-visit-choice-section">
              <div className="tech-visit-section-head">
                <h3 className="tech-visit-section-title">How did it go</h3>
              </div>
              <p className="tech-visit-muted" role="status">{locksOutcome}</p>
            </section>
          ) : (
            <>
              <ChoiceSection title="How did it go" columns={3}>
                {OUTCOME_OPTIONS.map((option) => (
                  <Chip
                    key={option.value}
                    disabled={locked}
                    label={option.label}
                    pressed={outcomeForm.outcome === option.value}
                    onClick={() => setOutcome({ outcome: option.value })}
                  />
                ))}
              </ChoiceSection>
              {outcomeForm.outcome === 'lost' && (
                <ChoiceSection title="Why" columns={3}>
                  {LOST_REASON_OPTIONS.map((option) => (
                    <Chip
                      key={option.value}
                      disabled={locked}
                      label={option.label}
                      pressed={outcomeForm.lostReason === option.value}
                      onClick={() => setOutcome({ lostReason: option.value })}
                    />
                  ))}
                </ChoiceSection>
              )}
              <ChoiceSection title="Recommended" columns={2}>
                {INTEREST_OPTIONS.map((option) => (
                  <Chip
                    key={option.value}
                    disabled={locked}
                    label={option.label}
                    pressed={outcomeForm.interests.includes(option.value)}
                    onClick={() => setOutcome({ interests: [...toggleInSet(new Set(outcomeForm.interests), option.value)] })}
                  />
                ))}
              </ChoiceSection>
              {followUpApplies(outcomeForm.outcome) && (
                <Field label="Call back on" help={FOLLOW_UP_DEFAULT_HINT} className="tech-visit-field">
                  <Input
                    className="tech-visit-control"
                    type="date"
                    disabled={locked}
                    value={followUpShown}
                    onChange={(event) => { setFollowUpTouched(true); setOutcome({ followUpDate: event.target.value }); }}
                  />
                </Field>
              )}
            </>
          )}
          <EstimateLine summary={estimate} service={service} />
          {creditShown && <InspectionCreditToggle checked={offerCredit} locked={locked} onChange={setOfferCredit} />}
        </fieldset>
        {submission.submitting && <ActionFeedback className="tech-visit-feedback">Saving completion…</ActionFeedback>}
      </div>
      <CompleteFooter
        submission={submission}
        missingReason={missingReason}
        label="Complete assessment"
        onSubmit={submit}
      />
    </div>
  );
}
