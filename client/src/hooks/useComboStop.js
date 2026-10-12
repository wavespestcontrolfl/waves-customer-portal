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
import { overlayStopFields } from '../lib/fast-complete-wrap-up';
import { completionFailureOutcome } from './useFastCompleteSubmit';
import {
  clearTerminalDrafts, comboDraftId, loadVisitCloseout, packetAfterSend, packetDisplayState, postVisitPacket, resolveSendFailure,
} from '../lib/visit-closeout-packet';

const PERSIST_ERROR = 'Could not save this on this device. Free some storage and try again.';

// A saved form: the body that goes, and (only when the stop's Wrap-up changed it) the body the part handed over, so
// the section can always be re-applied to the original.
const formOf = (entry, rest = {}) => ({ body: entry.body, ...(entry.base !== entry.body ? { base: entry.base } : {}), ...rest });
// The keys a confirm added to a body (the refusal's own flag), laid onto the handed-over body as well.
function withAdded(base, before, after) {
  const added = Object.fromEntries(Object.entries(after || {}).filter(([key]) => before && !(key in before)));
  return Object.keys(added).length ? { ...base, ...added } : base;
}

// A revoked part's body may still sit in the draft store (its write is pending, or failed). A small synchronous marker,
// kept apart from the store, says so: a load never trusts a stored body whose revocation has not landed, even after a
// crash. Cleared when a write that no longer holds the part lands.
const revokedKey = (scope, visitId) => `waves_combo_revoked:${scope}:${visitId}`;
function readRevoked(scope, visitId) {
  try { return JSON.parse(localStorage.getItem(revokedKey(scope, visitId)) || '[]'); } catch { return []; }
}
function writeRevoked(scope, visitId, ids) {
  try {
    if (ids.length) localStorage.setItem(revokedKey(scope, visitId), JSON.stringify(ids)); else localStorage.removeItem(revokedKey(scope, visitId));
  } catch { /* no marker: the in-memory map and the next write still hold */ }
}
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
    const revoked = readRevoked(scope, visitId);
    entries.current = Object.fromEntries(Object.entries(saved).filter(([id, form]) => form?.body && !revoked.includes(id))
      .map(([id, form]) => [id, { body: form.body, base: form.base ?? form.body, seq: 0, noteAtSave: form.noteAtSave ?? noteRef.current }]));
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
      const forms = Object.fromEntries(Object.entries(entries.current).map(([id, e]) => [id, formOf(e, { noteAtSave: e.noteAtSave })]));
      let ok = false;
      try { ok = await putVisitCompletionDraft(draftId, { visitId, key: keyRef.current, note: noteRef.current, forms }, scope); } catch { ok = false; }
      if (ok) {
        w.compensating = false;
        setPersistError('');
        // The store no longer holds any part the map does not: those markers are done.
        writeRevoked(scope, visitId, readRevoked(scope, visitId).filter((id) => id in forms));
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

  // INVARIANT: a rollback may only ever make a part LESS ready. The map is authoritative for what "Complete stop" may
  // send; the store only follows it. So a failed write never restores a body the part has since cleared or replaced:
  // a failed save leaves the part absent (not ready), and a failed revocation leaves it absent too (the store is stale,
  // the marker above keeps a reload from trusting it, and the error blocks Complete stop until a write lands).
  // A part's onPrepared (the contract in useFastCompleteSubmit): applied only if its seq is the greatest seen for the
  // service.
  const revoke = useCallback((id) => {
    writeRevoked(scope, visitId, [...new Set([...readRevoked(scope, visitId), id])]);
    delete entries.current[id];
    restoredRef.current = restoredRef.current.filter((x) => x !== id);
    bump();
  }, [scope, visitId, bump]);
  const apply = useCallback((id, body, seq) => {
    if (!(seq > (lastSeq.current[id] ?? 0))) return Promise.resolve();
    lastSeq.current[id] = seq;
    if (body) entries.current[id] = { body, base: body, seq, noteAtSave: noteRef.current }; else revoke(id);
    bump();
    return persist(() => { if (entries.current[id]?.seq === seq) delete entries.current[id]; })
      .then(() => { if (body) writeRevoked(scope, visitId, readRevoked(scope, visitId).filter((x) => x !== id)); })
      .catch((err) => { if (!body) setPersistError(err.message); throw err; });
  }, [persist, bump, revoke, scope, visitId]);

  // "Edit this part": the entry is gone at once, the write follows; a failed write is shown, the part stays not ready.
  const drop = useCallback((id) => {
    revoke(id);
    return persist().catch((err) => setPersistError(err.message));
  }, [persist, revoke]);

  // "Try again" on a persist error: write the current map again.
  const retryPersist = useCallback(() => persist().then(() => setPersistError(''), (err) => setPersistError(err.message)), [persist]);

  const setNote = useCallback((text) => {
    noteRef.current = text;
    bump();
    persist().catch((err) => setPersistError(err.message));
  }, [persist, bump]);

  // A confirmed or reopened draft from a send: bodies follow it (a reopened form has none: it is not ready).
  // `previous`: the draft the send carried before a confirm was added to it; the confirm joins the part's handed-over
  // body too, so a later send built from that body keeps it.
  const replaceFrom = useCallback((next, previous = null) => {
    for (const id of Object.keys(entries.current)) {
      const form = next.forms[id];
      if (form?.body) entries.current[id] = { ...entries.current[id], body: form.body, base: withAdded(entries.current[id].base, previous?.forms?.[id]?.body, form.body) }; else delete entries.current[id];
    }
    bump();
    persist().catch((err) => setPersistError(err.message));
  }, [persist, bump]);

  const seqOf = (id) => entries.current[id]?.seq ?? 0;
  const ready = (id) => !!entries.current[id] && entries.current[id].noteAtSave === noteRef.current;
  const stale = (id) => !!entries.current[id] && !ready(id);
  // The draft the packet request sends: ready parts only, from the map (never from the loaded draft).
  const draftFor = (ids, fromBase = false) => ({
    visitId, key: keyRef.current, note: noteRef.current,
    forms: Object.fromEntries(ids.filter(ready).map((id) => [id, fromBase ? { body: entries.current[id].base, base: entries.current[id].base } : formOf(entries.current[id])])),
  });
  return { note: noteRef.current, setNote, ready, stale, restored: restoredRef.current, apply, drop, replaceFrom, retryPersist, draftFor, seqOf, persistError, draftId };
}

// A send the server may have recorded: the shared submit's own classification (hooks/useFastCompleteSubmit.js
// completionFailureOutcome) calls it a "retry": no answer, a timeout (408, 425), a rate limit or lapsed login, any 5xx, an
// attempt still running. A retry under the same key must then carry the same bodies. A definite refusal (the correctable
// and terminal families, answered before any write) did not happen, so the next attempt follows the screen. A re-read that
// finds no packet proves nothing here: the first request may still be running.
const outcomeUnknown = (err, outcome) => outcome.kind === 'error' && completionFailureOutcome(err) === 'retry';

// `stopFields()`: what the stop's Wrap-up asks of the bodies, read at each send: null while the section is not shown (the
// saved bodies go as saved), {} while it is shown at its defaults (the parts' own handed-over bodies go, exactly), else the
// choices to lay onto those handed-over bodies.
export function useStopSend({ visitId, scope, load, readiness, ids, onSaved, stopFields }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refusal, setRefusal] = useState('');
  const [result, setResult] = useState(null);
  // A part whose form was put back (a declined promise) starts a fresh sheet.
  const [fresh, setFresh] = useState({});
  const submitting = useRef(false);
  // The attempt whose outcome is unknown (see outcomeUnknown): the exact draft it sent, and the parts' save numbers it was
  // built from. A retry sends that draft itself, never one rebuilt from remembered choices (a time computed from "tomorrow
  // at 8 AM" moves with the clock). It holds only while no part has been saved again since.
  const lastSeqs = useRef([]);
  const held = useRef(null);
  const [, bumpHeld] = useState(0);
  const heldStands = () => !!held.current && held.current.seqs.join() === [ids.pest, ids.lawn].map(readiness.seqOf).join();
  const remember = (candidate) => { held.current = candidate ? { candidate, seqs: lastSeqs.current } : null; bumpHeld((v) => v + 1); };
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
    remember(outcomeUnknown(err, outcome) ? candidate : null);
    if (outcome.kind === 'resend') { readiness.replaceFrom(outcome.draft, candidate); return outcome.draft; }
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

  // The draft this send carries, so that it always matches the section as shown now. The Wrap-up's choices are laid onto
  // the parts' handed-over bodies (never onto what an earlier send carried), so a choice put back to its default sends the
  // original again, and are saved with the bodies (replaceFrom persists them), so a retry under the same key and a reload
  // replay what was sent. The exception is an attempt whose outcome is unknown: its retry keeps that attempt's choices.
  const stopCandidate = () => {
    if (heldStands()) return held.current.candidate;
    lastSeqs.current = [ids.pest, ids.lawn].map(readiness.seqOf);
    const fields = stopFields?.();
    if (!fields || Object.keys(readiness.draftFor([ids.pest, ids.lawn]).forms).length < 2) return readiness.draftFor([ids.pest, ids.lawn]);
    const base = readiness.draftFor([ids.pest, ids.lawn], true);
    const next = Object.keys(fields).length ? overlayStopFields(base, fields) : base;
    readiness.replaceFrom(next);
    return next;
  };

  const submit = async (given) => {
    if (submitting.current) return;
    const candidate = given || stopCandidate();
    submitting.current = true;
    setBusy(true);
    setError('');
    let again = null;
    try { await send(candidate); remember(null); } catch (err) { again = await failed(err, candidate); } finally {
      submitting.current = false;
      setBusy(false);
    }
    if (again) await submit(again);
  };

  return { busy, error, refusal, setRefusal, result, display, started: !!packet, fresh, replaying: heldStands(), submit };
}
