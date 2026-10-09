// client/src/components/tech/FastCompleteComboSheet.jsx
//
// One short screen for a stop that holds exactly one regular pest visit and one lawn visit (GATE_COMBO_FAST_COMPLETE,
// owner 2026-10-09): one talk note at the top, a Pest part, a Lawn part, one "Complete stop".
//
// The two parts are the existing Fast Complete sheets, embedded (one frame, one scroll: both parts stacked, each with
// its own action button at the end of its part). Each part hands its body up through
// onPrepared(serviceId, bodyOrNull, seq) (the contract in hooks/useFastCompleteSubmit.js): a call is applied only if
// its seq is greater than the last applied for that service; a body is saved in the visit draft store (so a reload
// keeps it); a null drops the body and blocks "Complete stop"; a call that fails (the device cannot save it) rejects,
// and the part stays not ready. "Complete stop" records the whole stop once, through the same packet request the long
// closeout form makes (lib/visit-closeout-packet.js), so the invoice, the texts and the schedule refresh are exactly
// that form's. The long form stays one tap away ("Full form"); nothing typed here is carried over to it.
import React, { useCallback, useId, useMemo, useRef, useState } from 'react';
import useIsMobile from '../../hooks/useIsMobile';
import useModalFocus from '../../hooks/useModalFocus';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import { useStopLoad, useStopReadiness, useStopSend } from '../../hooks/useComboStop';
import { Button, ActionFeedback } from '../ui';
import FastCompleteSheet from './FastCompleteSheet';
import FastCompleteLawnSheet from './FastCompleteLawnSheet';
import { FastCompleteFrame, PartBusyContext, VisitNote } from './FastCompleteParts';
import { deleteVisitCompletionDraft } from '../../lib/completion-resume-store';
import { isFinishedState, isOfficeReviewState, operatorScope, paymentLine } from '../../lib/visit-closeout-packet';
import '../../styles/tech-workflow.css';

const INERT = { 'aria-hidden': true, inert: '' };
const noop = () => {};
const PARTS = [
  { kind: 'pest', label: 'Pest' },
  { kind: 'lawn', label: 'Lawn' },
];
const LABELS = { pest: 'Pest', lawn: 'Lawn' };
const FULL_FORM_NOTE = 'The long form starts blank: nothing typed here is carried over.';

function PartCard({ title, status, children }) {
  return (
    <section className="tech-combo-part" aria-label={`${title} part`}>
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">{title}</h3>
        <span className="tech-visit-muted" role="status">{status}</span>
      </div>
      {children}
    </section>
  );
}

function PartSheet({ kind, part, note, request, operatorId, catalog, onPrepared, onFullForm }) {
  const common = { service: part.service, request, operatorId, embedded: true, onPrepared, sharedNote: note, onFullForm, onClose: noop, onCompleted: noop };
  return kind === 'pest'
    ? <FastCompleteSheet {...common} voiceFillEnabled={part.voiceFillEnabled === true} />
    : <FastCompleteLawnSheet {...common} catalog={catalog} />;
}

// `onViewDetails`: the Details pill (owner 2026-10-09), as on every Fast Complete sheet; absent = no pill.
function Header({ titleId, pest, lawn, onFullForm, onViewDetails, onClose, blocked }) {
  const { customerName, address } = pest.service;
  return (
    <header className="tech-visit-header">
      <div className="tech-visit-header-text">
        <h2 id={titleId} className="tech-visit-title">Close out stop</h2>
        <p className="tech-visit-muted">{customerName || 'Customer'}</p>
        {address && <p className="tech-visit-muted">{address}</p>}
        <p className="tech-visit-muted">{pest.service.serviceType} + {lawn.service.serviceType}</p>
      </div>
      <div className="tech-visit-header-actions">
        {onViewDetails && <Button variant="ghost" className="tech-visit-action" onClick={() => onViewDetails()} disabled={blocked}>Details</Button>}
        <Button variant="ghost" className="tech-visit-action" onClick={onFullForm} disabled={blocked}>Full form</Button>
      </div>
      <Button variant="ghost" className="tech-visit-action tech-visit-close" onClick={onClose} disabled={blocked} aria-label="Close">×</Button>
    </header>
  );
}

function FullFormCard({ text, onFullForm, disabled }) {
  return (
    <div role="alert" className="tech-visit-card">
      <p className="tech-visit-warning">{text}</p>
      <p className="tech-visit-muted">{FULL_FORM_NOTE}</p>
      <Button className="tech-visit-action tech-visit-wide" onClick={onFullForm} disabled={disabled}>Full form</Button>
    </div>
  );
}

// What a part says about itself: saved, saved under an older note, changed since, or not saved.
// `status` heads the part; `line` is the short reason in the footer (empty when the part is ready).
function partStatus(readiness, id, label, changed) {
  if (readiness.ready(id)) return { status: 'Saved for this stop', line: '' };
  if (readiness.stale(id)) return { status: 'Note changed. Save this part again.', line: 'note changed, save it again' };
  return changed ? { status: `${label} part changed. Save it again below.`, line: 'changed, save it again' } : { status: 'Not saved yet', line: 'not saved yet' };
}

// One part: its saved summary after a reload (until the tech edits it or the note changes), else the embedded sheet.
function ComboPart({ kind, part, shared }) {
  const { readiness, send, note, request, operatorId, catalog, onFullForm, changed, markChanged } = shared;
  const id = part.service.id;
  const label = LABELS[kind];
  const showSaved = readiness.ready(id) && readiness.restored.includes(id);
  // A null after a body marks the part as changed; a body clears it.
  const onPrepared = (serviceId, bodyOrNull, seq) => {
    if (!bodyOrNull) markChanged(kind, true);
    return readiness.apply(serviceId, bodyOrNull, seq).then(() => markChanged(kind, !bodyOrNull));
  };
  return (
    <PartCard title={`${label} · ${part.service.serviceType || ''}`.trim()} status={partStatus(readiness, id, label, changed[kind]).status}>
      {showSaved ? (
        <div className="tech-visit-card">
          <p className="tech-visit-muted">Saved earlier on this device. Edit it to change anything.</p>
          <Button className="tech-visit-action" onClick={() => { void readiness.drop(id); markChanged(kind, true); }}>Edit this part</Button>
        </div>
      ) : (
        <PartSheet key={`${kind}-${send.fresh[kind] || 0}`} kind={kind} part={part} note={note} request={request} operatorId={operatorId} catalog={catalog} onPrepared={onPrepared} onFullForm={onFullForm} />
      )}
    </PartCard>
  );
}

function ComboFooter({ error, state, lines, blocked, canComplete, onDone, onSubmit, onRetry }) {
  const finished = isFinishedState(state);
  const resume = state === 'pending_resume';
  return (
    <footer className="tech-visit-footer tech-visit-footer--stacked">
      {error && <ActionFeedback error className="tech-visit-feedback tech-visit-error-banner">{error}</ActionFeedback>}
      {onRetry && <Button variant="secondary" className="tech-visit-action tech-visit-wide" onClick={onRetry}>Try again</Button>}
      {!finished && lines.length > 0 && <p className="tech-visit-muted" role="status">{lines.join(' · ')}</p>}
      <div className="tech-visit-actions">
        {finished ? (
          <Button className="tech-visit-action tech-visit-complete tech-visit-wide" onClick={onDone}>Done</Button>
        ) : (
          <Button className="tech-visit-action tech-visit-complete tech-visit-wide" loading={state === 'busy'} disabled={resume ? blocked : !canComplete} onClick={onSubmit}>
            {resume ? 'Resume closeout' : 'Complete stop'}
          </Button>
        )}
      </div>
    </footer>
  );
}

function FinishedNote({ state, result }) {
  return (
    <p role="status" className="tech-visit-card">
      {isOfficeReviewState(state) ? 'Stop recorded. The office has an alert to review the closeout, billing, or delivery.' : 'Stop recorded.'}
      {paymentLine(result) ? ` ${paymentLine(result)}` : ''}
    </p>
  );
}

// The in-flight work the parts report, one key per hook instance and source (see usePartBusy): a key is present while its
// work runs, and the parts are busy while any key is.
function usePartsBusy() {
  const [busy, setBusy] = useState({});
  const report = useCallback((key, on) => setBusy((cur) => {
    if (!!cur[key] === on) return cur;
    const next = { ...cur };
    if (on) next[key] = true; else delete next[key];
    return next;
  }), []);
  return { anyPartBusy: Object.keys(busy).length > 0, report };
}

// `suspended`: kept mounted but hidden behind the appointment details sheet (see FastCompleteFrame).
export default function FastCompleteComboSheet({ visitId, pest, lawn, request, operatorId, catalog, onClose, onSaved, onFullForm, onViewDetails, suspended = false }) {
  const isMobile = useIsMobile();
  const closeRef = useRef(null);
  const dialogRef = useModalFocus(!suspended, () => closeRef.current?.());
  useLockBodyScroll(true);
  const titleId = useId();
  const scope = operatorScope(operatorId);
  const ids = useMemo(() => ({ pest: pest.service.id, lawn: lawn.service.id }), [pest.service.id, lawn.service.id]);
  const load = useStopLoad(visitId, scope);
  const readiness = useStopReadiness({ visitId, scope, status: load.status, draft: load.draft });
  const send = useStopSend({ visitId, scope, load, readiness, ids, onSaved });
  const { anyPartBusy, report } = usePartsBusy();
  const [dictating, setDictating] = useState(false);
  const [changed, setChanged] = useState({});
  const markChanged = useCallback((kind, on) => setChanged((cur) => ({ ...cur, [kind]: on })), []);

  // The stop must still be exactly this pair; anything else is the long form's.
  const live = (load.detail?.members || []).filter((member) => member.requiresForm === true).map((member) => member.id).sort();
  const samePair = load.status === 'ready' && live.join() === [ids.pest, ids.lawn].sort().join();
  const finished = isFinishedState(send.display);
  const blocked = send.busy || dictating || anyPartBusy;
  const canComplete = [[ids.pest, ids.lawn].every(readiness.ready), !readiness.persistError, !blocked, !send.refusal, samePair, !finished].every(Boolean);

  const close = useCallback(() => { if (!blocked) onClose?.(); }, [blocked, onClose]);
  closeRef.current = close;
  // The long form starts blank: the saved forms are deleted first, and the switch waits for the delete to land (it
  // resolves false on a failure, it does not reject). On a failure the tech stays here with the error and tries again.
  const [leaveError, setLeaveError] = useState('');
  const fullForm = async () => {
    if (blocked) return;
    const removed = await deleteVisitCompletionDraft(readiness.draftId, scope).catch(() => false);
    if (!removed) { setLeaveError('Could not discard the saved forms on this device, so the long form was not opened. Tap Full form to try again.'); return; }
    setLeaveError('');
    onFullForm?.();
  };
  const partFullForm = useCallback(() => send.setRefusal('The server says this stop needs the long form.'), [send.setRefusal]);
  const shared = { readiness, send, note: readiness.note, request, operatorId, catalog, onFullForm: partFullForm, changed, markChanged };
  const lines = PARTS.filter(({ kind }) => !readiness.ready(ids[kind])).map(({ kind, label }) => `${label} part: ${partStatus(readiness, ids[kind], label, changed[kind]).line}`);
  const error = leaveError || send.error || readiness.persistError;

  return (
    <FastCompleteFrame isMobile={isMobile} dialogRef={dialogRef} titleId={titleId} onDismiss={close} suspended={suspended}>
      <Header titleId={titleId} pest={pest} lawn={lawn} onFullForm={fullForm} onViewDetails={samePair && !finished ? onViewDetails : undefined} onClose={close} blocked={blocked} />
      <div className="tech-visit-body">
        {load.status === 'loading' && <ActionFeedback className="tech-visit-feedback tech-visit-loading">Loading the stop…</ActionFeedback>}
        {load.status === 'error' && <FullFormCard text={load.error} onFullForm={fullForm} disabled={blocked} />}
        {load.status === 'ready' && !samePair && <FullFormCard text="This stop changed since the schedule loaded. Use the long form." onFullForm={fullForm} disabled={blocked} />}
        {samePair && (
          <PartBusyContext.Provider value={report}>
            <div {...(send.busy || finished || send.started ? INERT : {})}>
              {send.refusal && <FullFormCard text={send.refusal} onFullForm={fullForm} disabled={blocked} />}
              <VisitNote
                note={readiness.note}
                onChange={readiness.setNote}
                onDictated={(text) => readiness.setNote(readiness.note.trim() ? `${readiness.note.trimEnd()} ${text}` : text)}
                onDictationPending={setDictating}
                serviceId={ids.pest}
                locked={send.busy}
                micInside
              />
              <ComboPart kind="pest" part={pest} shared={shared} />
              <ComboPart kind="lawn" part={lawn} shared={shared} />
            </div>
          </PartBusyContext.Provider>
        )}
        {finished && <FinishedNote state={send.display} result={send.result} />}
      </div>
      <ComboFooter error={error} state={send.display} lines={lines} blocked={blocked} canComplete={canComplete} onDone={onClose} onSubmit={() => send.submit()} onRetry={readiness.persistError ? readiness.retryPersist : null} />
    </FastCompleteFrame>
  );
}
