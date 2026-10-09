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
//   - the $75 inspection credit toggle, only where the full form shows it.
//
// Required before Complete: a note and an outcome pick. Nothing else blocks.
//
// Two writes, in this order, and why both are safe:
//   1. POST /admin/consultations/:id/outcome, the outcome upsert. It is
//      idempotent (an upsert keyed on the visit that only a "won" row refuses)
//      and can be recorded again any number of times, and it sends nothing to
//      anyone. A tech who fixes a mistake and completes again just records the
//      newer read.
//   2. POST /admin/dispatch/:id/complete through useFastCompleteSubmit, under
//      one idempotency key. A lost response or a dropped connection resends the
//      SAME body under the SAME key, so the server replays or resumes it.
// If step 1 lands and step 2 does not, the visit stays open with its read
// recorded, which is a true state; the tech completes again. Step 2 never runs
// before step 1 has answered, so a completed visit never lacks its read.
// A retry of a held completion does not write the outcome again.
//
// Nothing about the visit is read live: the pest, lawn and tree & shrub sheets
// open their visit through a context route, and none of them takes an
// assessment (the pest recap context answers 409 not_pest_control). The visit
// identity the tech tapped (customer, property, service type, day) goes with
// the completion as `expectedVisit`, and the server compares it with the locked
// visit row, so a visit moved or retyped since the schedule loaded is refused
// (visit_identity_changed) and the tech reopens it.
import React, { useCallback, useId, useRef, useState } from 'react';
import useIsMobile from '../../hooks/useIsMobile';
import useModalFocus from '../../hooks/useModalFocus';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import useFastCompleteSubmit from '../../hooks/useFastCompleteSubmit';
import { recapVisitIdentity } from '../../hooks/useServiceRecapDraft';
import {
  INTEREST_OPTIONS, LOST_REASON_OPTIONS, OUTCOME_OPTIONS,
  buildOutcomePayload, formFromRow, readOnlyReason, useRecordedOutcome, validationErrorOf,
} from '../ConsultationOutcomeSheet';
import { offersInspectionCredit } from '../../lib/pest-fast-complete';
import { InspectionCreditToggle, PhotoStripSection, useVisitPhotos } from './FastCompleteReport';
import {
  Chip, ChoiceSection, CompleteFooter, FastCompleteFrame, RecoveredCompletion, SavedView, SheetHeader, VisitNote,
  refusalWithoutContext, submissionHolds, toggleInSet, usePhotoManager,
} from './FastCompleteParts';
import TechServicePhotosModal from './TechServicePhotosModal';
import { ActionFeedback } from '../ui';
import '../../styles/tech-workflow.css';

// The outcome write's own refusal that needs no stop: the consultation already
// converted (the sale closed first), so its read is final and the completion
// goes on.
const ALREADY_WON = 'ALREADY_WON';

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
export function assessmentCompletionBody({ note, offerCredit, expectedVisit }) {
  return {
    visitOutcome: 'completed',
    ...(expectedVisit && Object.keys(expectedVisit).length ? { expectedVisit } : {}),
    technicianNotes: String(note || '').trim(),
    ...(offerCredit === true || offerCredit === false ? { offerInspectionCredit: offerCredit } : {}),
    sendCompletionSms: false,
    requestReview: false,
  };
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
  // The outcome write in flight (step 1 above), lifted so Close and Full form wait for it.
  const [recording, setRecording] = useState(false);
  // A recorded dictation clip still being taken or transcribed: the full form
  // carries nothing over, so Full form waits for it, like Complete.
  const [dictationPending, setDictationPending] = useState(false);

  const close = useCallback(() => {
    if (submitting || recording) return;
    // The completion response rides along: admin Dispatch reads it for its bookkeeping.
    if (done) onCompleted?.(done.response || null);
    else onClose?.(submission.failure ? { refresh: true } : undefined);
  }, [submitting, recording, done, submission.failure, onClose, onCompleted]);
  closeRef.current = close;
  // Nothing is editable while a save is in flight, unresolved or refused for
  // good; the full form cannot resume a /complete attempt.
  const locked = submissionHolds(submission) || recording;

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
        submitting={submitting || recording}
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
        recording={recording}
        onRecording={setRecording}
        dictationPending={dictationPending}
        onDictationPending={setDictationPending}
        onCompleted={onCompleted}
      />
    </FastCompleteFrame>
  );
}

function SheetBody({ service, request, recorded, submission, locked, photos, recording, onRecording, dictationPending, onDictationPending, onCompleted }) {
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
      recording={recording}
      onRecording={onRecording}
      dictationPending={dictationPending}
      onDictationPending={onDictationPending}
    />
  );
}

function AssessmentForm({ service, request, row, submission, locked, photos, recording, onRecording, dictationPending, onDictationPending }) {
  // The outcome form starts from the recorded read (a tech who completes
  // again, or the office, may have recorded one already), so a soft quote or a
  // follow-up date saved earlier rides through the upsert unchanged.
  const [outcomeForm, setOutcomeForm] = useState(() => formFromRow(row));
  const [note, setNote] = useState('');
  // The credit toggle: shown exactly where the full form shows it (an
  // inspection profile, the credit lane live, the profile read answered).
  const creditShown = offersInspectionCredit(service) && service?.completionProfileLookupFailed !== true;
  const [offerCredit, setOfferCredit] = useState(true);
  const [outcomeError, setOutcomeError] = useState('');
  const visitPhotos = useVisitPhotos({ serviceId: service?.id, request, version: photos.version });

  // A won consultation (the sale closed first) keeps its read: the sheet shows
  // it and writes nothing.
  const locksOutcome = readOnlyReason(row);
  const setOutcome = (patch) => { setOutcomeError(''); setOutcomeForm((prev) => ({ ...prev, ...patch })); };
  const appendNote = useCallback((text) => {
    setNote((prev) => (prev.trim() ? `${prev.trimEnd()} ${text}` : text));
  }, []);

  const missingReason = (() => {
    if (dictationPending) return 'Finish dictating before you complete.';
    if (!note.trim()) return 'Tell me about the visit.';
    return locksOutcome ? '' : validationErrorOf(outcomeForm) || '';
  })();

  const submit = async () => {
    // A held completion (a retry) resends as it is; the read was written with it.
    if (submission.hasPendingBody()) {
      submission.retry();
      return;
    }
    if (missingReason || recording) return;
    if (!locksOutcome) {
      onRecording(true);
      setOutcomeError('');
      try {
        await request(`/admin/consultations/${encodeURIComponent(service.id)}/outcome`, {
          method: 'POST',
          body: JSON.stringify(buildOutcomePayload(outcomeForm, { followUpTouched: false, loadedRow: row })),
        });
      } catch (err) {
        if (err?.code !== ALREADY_WON) {
          setOutcomeError(err?.message || 'Could not save how it went. Try again.');
          onRecording(false);
          return;
        }
      }
      onRecording(false);
    }
    submission.submit(
      () => assessmentCompletionBody({
        note,
        offerCredit: creditShown ? offerCredit : null,
        expectedVisit: assessmentVisitIdentity(service),
      }),
      `Assessment · ${locksOutcome ? 'won' : outcomeForm.outcome}`,
    );
  };

  const formLocked = locked || dictationPending;
  // The footer shows the outcome write as part of the save.
  const footerSubmission = recording ? { ...submission, submitting: true } : submission;

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
            </>
          )}
          {creditShown && <InspectionCreditToggle checked={offerCredit} locked={locked} onChange={setOfferCredit} />}
        </fieldset>
        {outcomeError && <ActionFeedback error className="tech-visit-feedback">{outcomeError}</ActionFeedback>}
        {footerSubmission.submitting && <ActionFeedback className="tech-visit-feedback">Saving completion…</ActionFeedback>}
      </div>
      <CompleteFooter
        submission={footerSubmission}
        missingReason={missingReason}
        label="Complete assessment"
        onSubmit={submit}
      />
    </div>
  );
}
