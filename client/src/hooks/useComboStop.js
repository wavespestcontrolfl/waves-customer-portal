// client/src/hooks/useComboStop.js
//
// The state of the one-screen pest + lawn stop (FastCompleteComboSheet), split by responsibility:
//   useStopLoad       the stop and its saved draft, read once;
//   useStopReadiness  which parts are ready, and the note they were saved under;
//   useStopSend       sending the stop: the packet request and everything a refused or lost send decides.
//
// Readiness is derived, never stored loosely: ONE in-memory map (per service { body, seq, noteAtSave }) is the only thing
// "Complete stop" and the status line read. The draft store is persistence only: written through after the map changes,
// and on load it seeds the map. A part is ready only while its entry exists AND it was saved under the current shared
// note, so a note edit un-readies every part saved under the old one, mounted or not, and a restored part obeys the same
// rule as a live one.
import { useCallback, useEffect, useRef, useState } from 'react';
import { putVisitCompletionDraft } from '../lib/completion-resume-store';
import {
  clearTerminalDrafts, loadVisitCloseout, packetAfterSend, packetDisplayState, postVisitPacket, resolveSendFailure,
} from '../lib/visit-closeout-packet';

const PERSIST_ERROR = 'Could not save this on this device. Free some storage and try again.';
// A packet refusal that means the short screen cannot close this stop: the long form's.
const REFUSAL_CODES = /^lawn_fast|visit_grouped|visit_members/;

export function useStopLoad(visitId, scope) {
  const [state, setState] = useState({ status: 'loading', detail: null, rows: [], draft: null, error: '' });
  useEffect(() => {
    let live = true;
    loadVisitCloseout(visitId, scope).then(({ detail, rows, draft }) => {
      if (live) setState({ status: 'ready', detail, rows, draft, error: '' });
    }).catch((err) => { if (live) setState((s) => ({ ...s, status: 'error', error: err.message || 'Could not load the stop.' })); });
    return () => { live = false; };
  }, [visitId, scope]);
  const setDetail = useCallback((next) => setState((s) => ({ ...s, detail: typeof next === 'function' ? next(s.detail) : next })), []);
  const refresh = useCallback((rows) => setState((s) => ({ ...s, rows })), []);
  return { ...state, setDetail, refresh };
}

export function useStopReadiness({ visitId, scope, status, draft }) {
  const entries = useRef({});
  const noteRef = useRef('');
  const keyRef = useRef('');
  const lastSeq = useRef({});
  const chain = useRef(Promise.resolve());
  const [, setVersion] = useState(0);
  const [note, setNoteState] = useState('');
  const [restored, setRestored] = useState([]);
  const [persistError, setPersistError] = useState('');
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // Seed from the saved draft once the stop has loaded: the note comes back with the bodies.
  useEffect(() => {
    if (status !== 'ready') return;
    const saved = draft.forms || {};
    noteRef.current = draft.note || '';
    keyRef.current = draft.key;
    setNoteState(noteRef.current);
    entries.current = Object.fromEntries(Object.entries(saved).filter(([, form]) => form?.body)
      .map(([id, form]) => [id, { body: form.body, seq: 0, noteAtSave: form.noteAtSave ?? noteRef.current }]));
    setRestored(Object.keys(entries.current));
    bump();
  }, [status]); // seeded once, when the load settles

  // Write-through: the snapshot is taken now, written in order.
  const persist = useCallback(() => {
    const forms = Object.fromEntries(Object.entries(entries.current).map(([id, e]) => [id, { body: e.body, noteAtSave: e.noteAtSave }]));
    const snapshot = { visitId, key: keyRef.current, note: noteRef.current, forms };
    const run = async () => { if (!await putVisitCompletionDraft(visitId, snapshot, scope)) throw new Error(PERSIST_ERROR); };
    const next = chain.current.then(run, run);
    chain.current = next.catch(() => {});
    return next;
  }, [visitId, scope]);

  // A part's onPrepared (the contract in useFastCompleteSubmit): applied only if its seq is the greatest seen for the
  // service; a failed save puts the entry back as it was and rejects (the part stays not ready).
  const apply = useCallback((id, body, seq) => {
    if (!(seq > (lastSeq.current[id] ?? 0))) return Promise.resolve();
    lastSeq.current[id] = seq;
    const before = entries.current[id];
    if (body) entries.current[id] = { body, seq, noteAtSave: noteRef.current }; else delete entries.current[id];
    bump();
    return persist().catch((err) => {
      if (before) entries.current[id] = before; else delete entries.current[id];
      bump();
      throw err;
    });
  }, [persist, bump]);

  // "Edit this part": the entry is gone at once, the write follows; a failed write is shown, the part stays not ready.
  const drop = useCallback((id) => {
    delete entries.current[id];
    setRestored((ids) => ids.filter((x) => x !== id));
    bump();
    return persist().then(() => setPersistError(''), (err) => setPersistError(err.message));
  }, [persist, bump]);

  const setNote = useCallback((text) => {
    noteRef.current = text;
    setNoteState(text);
    persist().then(() => setPersistError(''), (err) => setPersistError(err.message));
  }, [persist]);

  // A confirmed or reopened draft from a send: bodies follow it (a reopened form has none: it is not ready).
  const replaceFrom = useCallback((next) => {
    for (const id of Object.keys(entries.current)) {
      const form = next.forms[id];
      if (form?.body) entries.current[id] = { ...entries.current[id], body: form.body }; else delete entries.current[id];
    }
    bump();
    void persist().catch((err) => setPersistError(err.message));
  }, [persist, bump]);

  const ready = (id) => entries.current[id]?.noteAtSave === noteRef.current && !!entries.current[id];
  const stale = (id) => !!entries.current[id] && !ready(id);
  // The draft the packet request sends: ready parts only, from the map (never from the loaded draft).
  const draftFor = (ids) => ({
    visitId, key: keyRef.current, note: noteRef.current,
    forms: Object.fromEntries(ids.filter(ready).map((id) => [id, { body: entries.current[id].body }])),
  });
  return { note, setNote, ready, stale, restored, apply, drop, replaceFrom, draftFor, persistError };
}

export function useStopSend({ visitId, scope, load, readiness, ids, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refusal, setRefusal] = useState('');
  const [result, setResult] = useState(null);
  // A part whose form was put back (a declined promise) starts a fresh sheet.
  const [fresh, setFresh] = useState({});
  const submitting = useRef(false);
  const packet = load.detail?.packet;
  const display = packetDisplayState({ result, detail: load.detail, busy });

  const send = async (candidate) => {
    const response = await postVisitPacket({ visitId, packet, draft: candidate, services: load.rows, scope });
    setResult(response);
    load.setDetail((cur) => ({ ...cur, packet: packetAfterSend(response) }));
    if (['done', 'office_required'].includes(response.state)) await clearTerminalDrafts(visitId, load.detail.members, scope);
    onSaved?.();
  };

  // Applies what resolveSendFailure decided, exactly as the long form does. Returns the draft to send again, or null.
  const failed = async (err, candidate) => {
    const outcome = await resolveSendFailure({ err, candidate, packet, visitId, scope });
    if (outcome.kind === 'resend') { readiness.replaceFrom(outcome.draft); return outcome.draft; }
    if (outcome.kind === 'reopened') {
      readiness.replaceFrom(outcome.draft);
      const kind = outcome.draft.forms[ids.pest]?.body === null ? 'pest' : 'lawn';
      setFresh((f) => ({ ...f, [kind]: (f[kind] || 0) + 1 }));
      setError(outcome.message);
    }
    if (outcome.kind !== 'error') return null;
    setError(outcome.error);
    if (REFUSAL_CODES.test(String(err.code || '')) || err.details?.reason === 'grouped_visit') setRefusal(err.message || outcome.error);
    if (outcome.found) {
      setResult(null);
      load.setDetail(outcome.found.detail);
      if (outcome.found.refreshed) load.refresh(outcome.found.refreshed.rows);
      if (outcome.found.detail.packet) onSaved?.();
    }
    if (outcome.reload) setRefusal('The stop could not be re-read. Use the long form.');
    return null;
  };

  const submit = async (candidate = readiness.draftFor([ids.pest, ids.lawn])) => {
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

  return { busy, error, refusal, setRefusal, result, display, started: !!packet, fresh, submit };
}
