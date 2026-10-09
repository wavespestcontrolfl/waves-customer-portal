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
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import useIsMobile from '../../hooks/useIsMobile';
import useModalFocus from '../../hooks/useModalFocus';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import { Button, ActionFeedback } from '../ui';
import FastCompleteSheet from './FastCompleteSheet';
import FastCompleteLawnSheet from './FastCompleteLawnSheet';
import { FastCompleteFrame, VisitNote } from './FastCompleteParts';
import { deleteVisitCompletionDraft, putVisitCompletionDraft } from '../../lib/completion-resume-store';
import {
  clearTerminalDrafts, loadVisitCloseout, operatorScope, packetConfirm, packetErrorMessage, paymentLine, postVisitPacket, rediscoverCloseout,
} from '../../lib/visit-closeout-packet';
import '../../styles/tech-workflow.css';

const INERT = { 'aria-hidden': true, inert: '' };
const PARTS = [
  { kind: 'pest', label: 'Pest' },
  { kind: 'lawn', label: 'Lawn' },
];
const noop = () => {};
const LABELS = { pest: 'Pest', lawn: 'Lawn' };
// A packet refusal that means the short screen cannot close this stop: the long form's.
const REFUSAL_CODES = /^lawn_fast|visit_grouped|visit_members/;
const FULL_FORM_NOTE = 'The long form starts blank: nothing typed here is carried over.';

// The stop's saved forms and the apply rule for the parts' onPrepared calls. A call is applied only if its seq is
// greater than the last applied for that service; calls are written one at a time so two parts never overwrite each
// other's save. A failed save rejects (the part stays not ready).
function useStopDraft({ visitId, scope, onLoaded }) {
  const [state, setState] = useState({ status: 'loading', detail: null, rows: [], draft: null, restored: [], error: '' });
  const draftRef = useRef(null);
  const lastSeq = useRef({});
  const chain = useRef(Promise.resolve());
  const loadedRef = useRef(onLoaded);
  loadedRef.current = onLoaded;

  useEffect(() => {
    let live = true;
    loadVisitCloseout(visitId, scope).then(({ detail, rows, draft }) => {
      if (!live) return;
      draftRef.current = draft;
      // The parts whose saved body was found on load (a reload): shown as saved until the tech edits them.
      setState({ status: 'ready', detail, rows, draft, restored: Object.keys(draft.forms).filter((id) => draft.forms[id]?.body), error: '' });
      loadedRef.current?.({ detail, rows, draft });
    }).catch((err) => { if (live) setState((s) => ({ ...s, status: 'error', error: err.message || 'Could not load the stop.' })); });
    return () => { live = false; };
  }, [visitId, scope]);

  const write = useCallback(async (mutate) => {
    const next = mutate(draftRef.current);
    if (!await putVisitCompletionDraft(visitId, next, scope)) {
      throw new Error('Could not save this part on this device. Free some storage and try again.');
    }
    draftRef.current = next;
    setState((s) => ({ ...s, draft: next }));
  }, [visitId, scope]);

  const apply = useCallback((serviceId, bodyOrNull, seq) => {
    const run = async () => {
      if (!(seq > (lastSeq.current[serviceId] ?? 0))) return;
      await write((draft) => {
        const forms = { ...draft.forms };
        if (bodyOrNull) forms[serviceId] = { body: bodyOrNull }; else delete forms[serviceId];
        return { ...draft, forms };
      });
      lastSeq.current[serviceId] = seq;
    };
    const next = chain.current.then(run, run);
    chain.current = next.catch(() => {});
    return next;
  }, [write]);

  // Drops a part's saved body (the tech chose to edit it).
  const drop = useCallback((serviceId) => {
    const run = () => write((draft) => {
      const forms = { ...draft.forms };
      delete forms[serviceId];
      return { ...draft, forms };
    });
    const next = chain.current.then(run, run);
    chain.current = next.catch(() => {});
    return next;
  }, [write]);

  const replace = useCallback((draft) => { draftRef.current = draft; setState((s) => ({ ...s, draft })); }, []);
  return { ...state, apply, drop, replace, setState };
}

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

// Sending the stop: the packet request, the confirm prompts, a lost response, and a refusal the tech can act on.
function useStopSubmit({ visitId, scope, stop, ids, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refusal, setRefusal] = useState('');
  const [result, setResult] = useState(null);
  const [packet, setPacket] = useState(null);
  // A part whose form was put back (a declined promise) starts a fresh sheet.
  const [fresh, setFresh] = useState({});
  const submitting = useRef(false);
  const started = stop.detail?.packet || packet;

  // A refused or lost send: say why, and ask the server what it has (a timeout does not mean it failed).
  const settleFailure = async (err, candidate) => {
    const text = packetErrorMessage(err);
    setError(text);
    if (REFUSAL_CODES.test(String(err.code || '')) || err.details?.reason === 'grouped_visit') setRefusal(err.message || text);
    try {
      const found = await rediscoverCloseout({ visitId, candidate, err, scope });
      if (found.finished) setError('');
      if (found.detail.packet) { setPacket(found.detail.packet); onSaved?.(); }
      stop.setState((s) => ({ ...s, detail: found.detail }));
    } catch { /* the same key and bodies stay saved for a later retry */ }
  };

  const send = async (candidate) => {
    const response = await postVisitPacket({ visitId, packet: started, draft: candidate, services: stop.rows, scope });
    setResult(response);
    setPacket({ id: response.packetId });
    if (['done', 'office_required'].includes(response.state)) await clearTerminalDrafts(visitId, stop.detail.members, scope);
    onSaved?.();
  };

  // Returns the draft to send again (a confirmed prompt), or null.
  const failed = async (err, candidate) => {
    const confirm = await packetConfirm({ err, candidate, packet: started, visitId, scope });
    if (confirm?.resend) { stop.replace(confirm.resend); return confirm.resend; }
    if (confirm?.reopened) {
      stop.replace(confirm.reopened);
      const kind = confirm.reopened.forms[ids.pest]?.body === null ? 'pest' : 'lawn';
      setFresh((f) => ({ ...f, [kind]: (f[kind] || 0) + 1 }));
      setError(confirm.message);
    } else if (!confirm) await settleFailure(err, candidate);
    return null;
  };

  const submit = async (candidate = stop.draft) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    let again = null;
    try { await send(candidate); } catch (err) { again = await failed(err, candidate); } finally {
      submitting.current = false;
      setBusy(false);
    }
    if (again) await submit(again);
  };

  return { busy, error, refusal, setRefusal, result, packet, started, fresh, submit };
}

function PartSheet({ kind, part, note, request, operatorId, catalog, onPrepared, onFullForm }) {
  const common = { service: part.service, request, operatorId, embedded: true, onPrepared, sharedNote: note, onFullForm, onClose: noop, onCompleted: noop };
  return kind === 'pest'
    ? <FastCompleteSheet {...common} voiceFillEnabled={part.voiceFillEnabled === true} />
    : <FastCompleteLawnSheet {...common} catalog={catalog} />;
}

function Header({ titleId, pest, lawn, onFullForm, onClose, busy }) {
  const { customerName, address } = pest.service;
  return (
    <header className="tech-visit-header">
      <div>
        <h2 id={titleId} className="tech-visit-title">Close out stop</h2>
        <p className="tech-visit-muted">{customerName || 'Customer'}</p>
        {address && <p className="tech-visit-muted">{address}</p>}
        <p className="tech-visit-muted">{pest.service.serviceType} + {lawn.service.serviceType}</p>
      </div>
      <Button variant="ghost" className="tech-visit-action" onClick={onFullForm} disabled={busy}>Full form</Button>
      <Button variant="ghost" className="tech-visit-action tech-visit-close" onClick={onClose} disabled={busy} aria-label="Close">×</Button>
    </header>
  );
}

function FullFormCard({ text, onFullForm }) {
  return (
    <div role="alert" className="tech-visit-card">
      <p className="tech-visit-warning">{text}</p>
      <p className="tech-visit-muted">{FULL_FORM_NOTE}</p>
      <Button className="tech-visit-action tech-visit-wide" onClick={onFullForm}>Full form</Button>
    </div>
  );
}

// One part: its saved summary after a reload (until the tech edits it), else the embedded sheet.
function ComboPart({ kind, part, shared, sub }) {
  const { stop, note, request, operatorId, catalog, onFullForm, dropped, setDropped, preparedFor } = shared;
  const id = part.service.id;
  const saved = !!stop.draft?.forms?.[id]?.body;
  const label = LABELS[kind];
  let status = 'Not saved yet';
  if (saved) status = 'Saved for this stop';
  else if (dropped[kind]) status = `${label} part changed. Save it again below.`;
  const showSaved = saved && !dropped[kind] && stop.restored.includes(id);
  return (
    <PartCard title={`${label} · ${part.service.serviceType || ''}`.trim()} status={status}>
      {showSaved ? (
        <div className="tech-visit-card">
          <p className="tech-visit-muted">Saved earlier on this device. Edit it to change anything.</p>
          <Button className="tech-visit-action" onClick={() => { void stop.drop(id); setDropped((d) => ({ ...d, [kind]: true })); }}>Edit this part</Button>
        </div>
      ) : (
        <PartSheet key={`${kind}-${sub.fresh[kind] || 0}`} kind={kind} part={part} note={note} request={request} operatorId={operatorId} catalog={catalog} onPrepared={preparedFor[kind]} onFullForm={onFullForm} />
      )}
    </PartCard>
  );
}

function ComboFooter({ error, finished, lines, started, busy, canComplete, onDone, onSubmit }) {
  return (
    <footer className="tech-visit-footer tech-visit-footer--stacked">
      {error && <ActionFeedback error className="tech-visit-feedback tech-visit-error-banner">{error}</ActionFeedback>}
      {!finished && lines.length > 0 && <p className="tech-visit-muted" role="status">{lines.join(' · ')}</p>}
      <div className="tech-visit-actions">
        {finished ? (
          <Button className="tech-visit-action tech-visit-complete tech-visit-wide" onClick={onDone}>Done</Button>
        ) : (
          <Button className="tech-visit-action tech-visit-complete tech-visit-wide" loading={busy} disabled={started ? busy : !canComplete} onClick={onSubmit}>
            {started ? 'Resume closeout' : 'Complete stop'}
          </Button>
        )}
      </div>
    </footer>
  );
}

export default function FastCompleteComboSheet({ visitId, pest, lawn, request, operatorId, catalog, onClose, onSaved, onFullForm }) {
  const isMobile = useIsMobile();
  const closeRef = useRef(null);
  const dialogRef = useModalFocus(true, () => closeRef.current?.());
  useLockBodyScroll(true);
  const titleId = useId();
  const scope = operatorScope();
  const stop = useStopDraft({ visitId, scope });
  const ids = { pest: pest.service.id, lawn: lawn.service.id };
  const sub = useStopSubmit({ visitId, scope, stop, ids, onSaved });
  const [note, setNote] = useState('');
  const [dictating, setDictating] = useState(false);
  const [dropped, setDropped] = useState({});

  // The stop must still be exactly this pair, with every other member history; anything else is the long form's.
  const live = (stop.detail?.members || []).filter((member) => member.requiresForm === true).map((member) => member.id).sort();
  const samePair = stop.status === 'ready' && live.join() === [ids.pest, ids.lawn].sort().join();
  const finished = sub.result ? ['done', 'office_required'].includes(sub.result.state) : ['done', 'failed'].includes(stop.detail?.packet?.status);
  const bothReady = [ids.pest, ids.lawn].every((id) => !!stop.draft?.forms?.[id]?.body);
  const canComplete = [bothReady, !sub.busy, !dictating, !sub.refusal, samePair, !finished].every(Boolean);

  const close = useCallback(() => { if (!sub.busy) onClose?.(); }, [sub.busy, onClose]);
  closeRef.current = close;
  const fullForm = async () => {
    if (sub.busy) return;
    await deleteVisitCompletionDraft(visitId, scope).catch(() => {});
    onFullForm?.();
  };
  const partFullForm = useCallback(() => sub.setRefusal('The server says this stop needs the long form.'), [sub.setRefusal]);

  // A part's onPrepared: the seq rule and the save live in useStopDraft. A null after a body marks the part as changed.
  const { apply } = stop;
  const markChanged = (kind) => (serviceId, bodyOrNull, seq) => apply(serviceId, bodyOrNull, seq)
    .then(() => setDropped((d) => ({ ...d, [kind]: !bodyOrNull })));
  const shared = { stop, note, request, operatorId, catalog, onFullForm: partFullForm, dropped, setDropped, preparedFor: { pest: markChanged('pest'), lawn: markChanged('lawn') } };
  const lines = PARTS.filter(({ kind }) => !stop.draft?.forms?.[ids[kind]]?.body).map(({ kind, label }) => `${label} part: ${dropped[kind] ? 'changed, save it again' : 'not saved yet'}`);
  const inert = sub.busy || finished || sub.started ? INERT : {};

  return (
    <FastCompleteFrame isMobile={isMobile} dialogRef={dialogRef} titleId={titleId} onDismiss={close}>
      <Header titleId={titleId} pest={pest} lawn={lawn} onFullForm={fullForm} onClose={close} busy={sub.busy} />
      <div className="tech-visit-body">
        {stop.status === 'loading' && <ActionFeedback className="tech-visit-feedback tech-visit-loading">Loading the stop…</ActionFeedback>}
        {stop.status === 'error' && <FullFormCard text={stop.error} onFullForm={fullForm} />}
        {stop.status === 'ready' && !samePair && <FullFormCard text="This stop changed since the schedule loaded. Use the long form." onFullForm={fullForm} />}
        {samePair && (
          <div {...inert}>
            {sub.refusal && <FullFormCard text={sub.refusal} onFullForm={fullForm} />}
            <VisitNote
              note={note}
              onChange={setNote}
              onDictated={(text) => setNote((prev) => (prev.trim() ? `${prev.trimEnd()} ${text}` : text))}
              onDictationPending={setDictating}
              serviceId={ids.pest}
              locked={sub.busy}
              micInside
            />
            <ComboPart kind="pest" part={pest} shared={shared} sub={sub} />
            <ComboPart kind="lawn" part={lawn} shared={shared} sub={sub} />
          </div>
        )}
        {finished && <FinishedNote result={sub.result} detail={stop.detail} />}
      </div>
      <ComboFooter error={sub.error} finished={finished} lines={lines} started={sub.started} busy={sub.busy} canComplete={canComplete} onDone={onClose} onSubmit={() => sub.submit()} />
    </FastCompleteFrame>
  );
}

function FinishedNote({ result, detail }) {
  const office = result?.state === 'office_required' || detail?.packet?.status === 'failed';
  return (
    <p role="status" className="tech-visit-card">
      {office ? 'Stop recorded. The office has an alert to review the closeout, billing, or delivery.' : 'Stop recorded.'}
      {paymentLine(result) ? ` ${paymentLine(result)}` : ''}
    </p>
  );
}
