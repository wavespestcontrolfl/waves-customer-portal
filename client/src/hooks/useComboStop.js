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
  clearTerminalDrafts, comboDraftId, loadVisitCloseout, packetAfterSend, packetDisplayState, postVisitPacket, resolveSendFailure,
} from '../lib/visit-closeout-packet';

const PERSIST_ERROR = 'Could not save this on this device. Free some storage and try again.';
// A packet refusal that means the short screen cannot close this stop: the long form's.
const REFUSAL_CODES = /^lawn_fast|visit_grouped|visit_members/;

export function useStopLoad(visitId, scope) {
  const [state, setState] = useState({ status: 'loading', detail: null, rows: [], draft: null, error: '' });
  useEffect(() => {
    let live = true;
    loadVisitCloseout(visitId, scope, comboDraftId(visitId)).then(({ detail, rows, draft }) => {
      if (live) setState({ status: 'ready', detail, rows, draft, error: '' });
    }).catch((err) => { if (live) setState((s) => ({ ...s, status: 'error', error: err.message || 'Could not load the stop.' })); });
    return () => { live = false; };
  }, [visitId, scope]);
  const setDetail = useCallback((next) => setState((s) => ({ ...s, detail: typeof next === 'function' ? next(s.detail) : next })), []);
  const refresh = useCallback((rows) => setState((s) => ({ ...s, rows })), []);
  return { ...state, setDetail, refresh };
}

export function useStopReadiness({ visitId, scope, status, draft }) {
  const draftId = comboDraftId(visitId);
  const entries = useRef({});
  const noteRef = useRef('');
  const keyRef = useRef('');
  const restoredRef = useRef([]);
  const seeded = useRef(false);
  const lastSeq = useRef({});
  const writer = useRef({ running: false, dirty: false, waiters: [], compensating: false });
  const [, setVersion] = useState(0);
  const [persistError, setPersistError] = useState('');
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // Seeded synchronously, in the render that sees the load settle: no part is ever drawn with an empty note and then
  // overwritten. The note comes back with the bodies; each body keeps the note it was saved under.
  if (status === 'ready' && !seeded.current) {
    seeded.current = true;
    const saved = draft.forms || {};
    noteRef.current = draft.note || '';
    keyRef.current = draft.key;
    entries.current = Object.fromEntries(Object.entries(saved).filter(([, form]) => form?.body)
      .map(([id, form]) => [id, { body: form.body, seq: 0, noteAtSave: form.noteAtSave ?? noteRef.current }]));
    restoredRef.current = Object.keys(entries.current);
  }

  // ONE serialized writer that always writes the map as it is when its turn runs ("persist latest"), never a snapshot
  // taken at call time. A call resolves when a write that includes its entry has landed. When a write fails, the
  // calls it carried are rolled back (their entries leave the map, synchronously, before the next snapshot is taken)
  // and one more write follows with the corrected map; if that one fails too, the writer stops and the error is shown.
  const drain = useCallback(async () => {
    const w = writer.current;
    while (w.dirty) {
      w.dirty = false;
      const batch = w.waiters.splice(0);
      const forms = Object.fromEntries(Object.entries(entries.current).map(([id, e]) => [id, { body: e.body, noteAtSave: e.noteAtSave }]));
      let ok = false;
      try { ok = await putVisitCompletionDraft(draftId, { visitId, key: keyRef.current, note: noteRef.current, forms }, scope); } catch { ok = false; }
      if (ok) {
        w.compensating = false;
        setPersistError('');
        batch.forEach((waiter) => waiter.resolve());
      } else {
        batch.forEach((waiter) => { waiter.rollback?.(); waiter.reject(new Error(PERSIST_ERROR)); });
        bump();
        if (w.compensating) { w.compensating = false; setPersistError(PERSIST_ERROR); } else { w.compensating = true; w.dirty = true; }
      }
    }
    w.running = false;
  }, [visitId, scope, draftId, bump]);

  const persist = useCallback((rollback) => new Promise((resolve, reject) => {
    const w = writer.current;
    w.waiters.push({ resolve, reject, rollback });
    w.dirty = true;
    if (!w.running) { w.running = true; void drain(); }
  }), [drain]);

  // A part's onPrepared (the contract in useFastCompleteSubmit): applied only if its seq is the greatest seen for the
  // service; a failed write puts the entry back as it was and rejects (the part stays not ready).
  const apply = useCallback((id, body, seq) => {
    if (!(seq > (lastSeq.current[id] ?? 0))) return Promise.resolve();
    lastSeq.current[id] = seq;
    const before = entries.current[id];
    if (body) entries.current[id] = { body, seq, noteAtSave: noteRef.current }; else delete entries.current[id];
    bump();
    return persist(() => {
      if (entries.current[id]?.seq !== seq && body) return;
      if (before) entries.current[id] = before; else delete entries.current[id];
    });
  }, [persist, bump]);

  // "Edit this part": the entry is gone at once, the write follows; a failed write is shown, the part stays not ready.
  const drop = useCallback((id) => {
    delete entries.current[id];
    restoredRef.current = restoredRef.current.filter((x) => x !== id);
    bump();
    return persist().catch((err) => setPersistError(err.message));
  }, [persist, bump]);

  const setNote = useCallback((text) => {
    noteRef.current = text;
    bump();
    persist().catch((err) => setPersistError(err.message));
  }, [persist, bump]);

  // A confirmed or reopened draft from a send: bodies follow it (a reopened form has none: it is not ready).
  const replaceFrom = useCallback((next) => {
    for (const id of Object.keys(entries.current)) {
      const form = next.forms[id];
      if (form?.body) entries.current[id] = { ...entries.current[id], body: form.body }; else delete entries.current[id];
    }
    bump();
    persist().catch((err) => setPersistError(err.message));
  }, [persist, bump]);

  const ready = (id) => !!entries.current[id] && entries.current[id].noteAtSave === noteRef.current;
  const stale = (id) => !!entries.current[id] && !ready(id);
  // The draft the packet request sends: ready parts only, from the map (never from the loaded draft).
  const draftFor = (ids) => ({
    visitId, key: keyRef.current, note: noteRef.current,
    forms: Object.fromEntries(ids.filter(ready).map((id) => [id, { body: entries.current[id].body }])),
  });
  return { note: noteRef.current, setNote, ready, stale, restored: restoredRef.current, apply, drop, replaceFrom, draftFor, persistError, draftId };
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
    const response = await postVisitPacket({ visitId, packet, draft: candidate, services: load.rows, scope, draftId: readiness.draftId });
    setResult(response);
    load.setDetail((cur) => ({ ...cur, packet: packetAfterSend(response) }));
    if (['done', 'office_required'].includes(response.state)) await clearTerminalDrafts(visitId, load.detail.members, scope);
    onSaved?.();
  };

  // Applies what resolveSendFailure decided, exactly as the long form does. Returns the draft to send again, or null.
  const failed = async (err, candidate) => {
    const outcome = await resolveSendFailure({ err, candidate, packet, visitId, scope, draftId: readiness.draftId });
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
