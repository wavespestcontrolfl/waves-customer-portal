// "About this home": the one short lasting staff note for a home (server/services/home-note.js). Shown at the top of every
// visit on the tech Visit Brief, and on the admin customer profile for a home with no visit open. Staff only: the
// customer never sees it. `request(path, options)` is the caller's own staff fetch (it throws an Error with .status and the
// refusal body as .details or .body). In the Visit Brief the panel gives `services` + `byService`: the note rides the
// visit-brief answer (first stop member that carried it), so the panel adds no request; the office page gives `path` and the
// section reads it itself. The time a save is checked against is pinned when editing STARTS, so a brief that refreshes
// under an open editor can never make a save overwrite a newer note. Tech portal style rule: inline styles, no Tailwind.
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatETDate } from '../../lib/timezone';

const MAX = 1000;
const C = {
  bg: 'var(--tfx-bg, #fafaf9)',
  card: 'var(--tfx-card, #ffffff)',
  border: 'var(--tfx-border, #d6d3d1)',
  accent: 'var(--tfx-accent, #1c1917)',
  amber: 'var(--tfx-amber, #854d0e)',
  red: 'var(--tfx-red, #a32d2d)',
  text: 'var(--tfx-text, #1c1917)',
  muted: 'var(--tfx-muted, #57534e)',
  onAccent: 'var(--tfx-on-accent, #ffffff)',
};
const labelStyle = { fontSize: 14, fontWeight: 500, lineHeight: 1.4, color: C.text, margin: '16px 0 6px' };
const lineStyle = { fontSize: 14, color: C.muted, margin: '3px 0 0' };
const btnStyle = { minHeight: 48, padding: '8px 14px', borderRadius: 4, fontSize: 14, cursor: 'pointer' };
const primaryBtn = { ...btnStyle, border: 'none', background: C.accent, color: C.onAccent, fontWeight: 500 };
const quietBtn = { ...btnStyle, border: `1px solid ${C.border}`, background: 'transparent', color: C.text };

const refusalNote = (err) => (err?.details || err?.body || {}).note;

// The note the Visit Brief answer carries (visit-brief's `homeNote` = { note, customerId }, one per customer): the first stop
// member that answered with it. { id, note, customerId } or null (no answer carried one: nothing to show).
export function homeNoteFor(services, byService) {
  const member = services.find((s) => byService?.[s.id]?.brief?.homeNote !== undefined);
  if (!member) return null;
  const carried = byService[member.id].brief.homeNote;
  return { id: member.id, note: carried?.note || null, customerId: carried?.customerId || null };
}
// The customer a stop member is for NOW (the schedule's own row). A brief kept from before a merge or undo can still carry the
// old customer's note under the same visit id; when the two differ the note is not shown and any draft is dropped.
const memberCustomerId = (services, id) => {
  const member = services.find((m) => m.id === id);
  return (member && (member.customer_id || member.customerId)) || null;
};
const carriedForOtherCustomer = (services, picked) => {
  const now = picked && memberCustomerId(services, picked.id);
  return Boolean(now && picked.customerId && now !== picked.customerId);
};
// What the Visit Brief answer offers for this stop: the carried note, unless it is for another customer than the row's now.
const briefView = (services, byService) => {
  const carried = services ? homeNoteFor(services, byService) : null;
  const wrongCustomer = Boolean(services && carriedForOtherCustomer(services, carried));
  return { picked: wrongCustomer ? null : carried, wrongCustomer };
};
// The member row the edit started on now belongs to another customer (a merge or undo moved the visit): this holds even when
// the refreshed brief carries no note at all, so the check reads the schedule row, not the brief.
const pinnedMemberMoved = (services, pin) => {
  const now = services && pin && pin.memberId && memberCustomerId(services, pin.memberId);
  return Boolean(now && pin.customerId && now !== pin.customerId);
};
const livePinOf = (pin, stopKey, blocked) => (pin && pin.stopKey === stopKey && !blocked ? pin : null);
const visitNotePath = (id) => `/admin/schedule/${id}/home-note`;

function byline(note) {
  const when = note.updatedAt ? formatETDate(note.updatedAt, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  return `Updated ${when}${note.updatedByFirstName ? ` by ${note.updatedByFirstName}` : ''}`;
}

function NoteEditor({ draft, setDraft, state, onSave, onCancel }) {
  const over = draft.length > MAX;
  return (
    <div data-testid="home-note-editor" style={{ marginTop: 8 }}>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={state.busy}
        rows={5}
        aria-label="About this home"
        style={{ width: '100%', boxSizing: 'border-box', padding: 8, borderRadius: 6, border: `1px solid ${C.border}`, background: C.card, color: C.text, fontSize: 16, resize: 'vertical' }}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
        <button type="button" onClick={onSave} disabled={state.busy || over} style={{ ...primaryBtn, opacity: state.busy || over ? 0.6 : 1 }}>{state.busy ? 'Saving…' : 'Save'}</button>
        <button type="button" onClick={onCancel} disabled={state.busy} style={quietBtn}>Cancel</button>
        <span style={{ ...lineStyle, margin: 0, marginLeft: 'auto', color: over ? C.red : C.muted }}>{draft.length}/{MAX}</span>
      </div>
      {over && <p role="status" style={{ ...lineStyle, color: C.red }}>Shorten the note to {MAX} characters to save it.</p>}
    </div>
  );
}

function Conflict({ note, onKeep, onCancel }) {
  return (
    <div role="alert" data-testid="home-note-conflict" style={{ marginTop: 8, padding: 10, borderRadius: 4, border: `1px solid ${C.border}`, background: C.bg }}>
      <p style={{ ...lineStyle, color: C.amber, margin: 0 }}>Someone else changed this note.</p>
      <p style={{ fontSize: 14, color: C.text, margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{note ? note.body : 'The note was removed.'}</p>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" onClick={onKeep} style={quietBtn}>Keep editing</button>
        <button type="button" onClick={onCancel} style={quietBtn}>Cancel</button>
      </div>
    </div>
  );
}

function NoteReadView({ note, onEdit }) {
  return (
    <>
      {note ? (
        <>
          <p style={{ fontSize: 14, color: C.text, margin: '3px 0 0', whiteSpace: 'pre-wrap' }}>{note.body}</p>
          <p style={lineStyle}>{byline(note)}</p>
        </>
      ) : <p style={lineStyle}>No note yet.</p>}
      <div style={{ marginTop: 6 }}>
        <button type="button" onClick={onEdit} style={quietBtn}>{note ? 'Edit' : 'Add note'}</button>
      </div>
    </>
  );
}

const IDLE = { busy: false, error: '', saved: false, conflict: null };

const loadedFrom = (data) => ({ status: data?.editable === false ? 'none' : 'ready', note: data?.note || null, customerId: data?.customerId || null });
const failedLoad = (err) => ({
  status: [403, 404, 422].includes(err?.status) ? 'none' : 'error', note: null, customerId: null, message: err?.status === 422 ? err.message : '',
});
// A stale save shows the newer note; a visit that moved to another customer is only an error line.
const saveFailure = (err) => {
  const code = (err?.details || err?.body || {}).code;
  if (err?.status === 409 && code !== 'customer_changed') return { ...IDLE, conflict: { note: refusalNote(err) || null } };
  return { ...IDLE, error: String(err?.message || err).slice(0, 160) };
};
const initialLoad = (picked) => (picked
  ? { status: 'ready', note: picked.note, customerId: picked.customerId }
  : { status: 'loading', note: null, customerId: null });
// What editing is checked against: the stop, the member row, the customer, and the exact note (id + revision) it started from.
const pinFor = (route, stopKey, load, memberId) => ({
  route, stopKey, memberId, noteId: load.note?.id || null, revision: load.note?.revision || 0, customerId: load.customerId,
});
const repinned = (pin, note) => ({ ...pin, noteId: note?.id || null, revision: note?.revision || 0 });
// An answer with no `note` field (an unreadable 2xx) is an unknown outcome: the draft stays.
const confirmedNote = (out) => {
  if (!out || !('note' in out)) throw new Error('Could not confirm the save. Your text is still here; check the note and try again.');
  return out.note || null;
};
const movedToOtherCustomer = (pin, customerId) => Boolean(pin && customerId && pin.customerId && customerId !== pin.customerId);
// An open draft keeps its own route when a refreshed brief carries no note (a failed lookup) or another stop member supplies it.
const noteRoute = (picked, pin, path) => {
  if (path) return path;
  return picked ? visitNotePath(picked.id) : (pin && pin.route) || null;
};

export default function HomeNoteSection({ request, path, stopKey, services, byService, onSaved }) {
  const { picked, wrongCustomer } = briefView(services, byService);
  const fed = Boolean(services);
  const [load, setLoad] = useState(initialLoad(picked));
  const [draft, setDraft] = useState(null);
  // What editing started from: the route, the customer and the note's revision. Every save is checked against these, never
  // against what the panel shows now, so a refreshed brief or a stop switched under an open editor cannot redirect it.
  const [pin, setPin] = useState(null);
  const [state, setState] = useState(IDLE);
  // The draft belongs to ONE stop: a different stopKey ends it at once (nothing of it renders or can be saved), while the same
  // stopKey keeps it across a refresh that omits the note or a grouped stop switching the member that supplies it.
  const pinMoved = pinnedMemberMoved(services, pin);
  const livePin = livePinOf(pin, stopKey, wrongCustomer || pinMoved);
  const shownDraft = livePin ? draft : null;
  const route = noteRoute(picked, livePin, fed ? null : path);
  // The pin an in-flight save belongs to: an answer arriving after the draft ended (Cancel, another customer) is ignored.
  const pinRef = useRef(null);
  pinRef.current = livePin;
  const read = useCallback(() => {
    setLoad({ status: 'loading', note: null, customerId: null });
    request(route)
      .then((data) => setLoad(loadedFrom(data)))
      .catch((err) => setLoad(failedLoad(err)));
  }, [request, route]);
  useEffect(() => { if (!fed && request && route) read(); }, [fed, request, route, read]);
  // The brief read again (after a save, or a refresh) brings the newest note down; an open editor keeps its pin.
  const { note: pickedNote, customerId: pickedCustomer = null } = picked || {};
  useEffect(() => { if (pickedNote !== undefined) setLoad({ status: 'ready', note: pickedNote, customerId: pickedCustomer }); }, [pickedNote, pickedCustomer]);
  // The draft belongs to the customer it was typed for: it ends only on Cancel, a successful Save, or the panel moving to
  // a different customer (the office page: another path). A brief that omits the note, or a grouped stop that switches
  // which member supplies it, leaves the draft exactly as typed.
  const dropDraft = () => { setDraft(null); setPin(null); setState(IDLE); };
  useEffect(() => { if (movedToOtherCustomer(livePin, pickedCustomer)) dropDraft(); }, [pickedCustomer]);
  useEffect(() => { if (pin && !livePin) dropDraft(); }, [stopKey, wrongCustomer, pinMoved]);
  useEffect(() => { if (!fed) dropDraft(); }, [fed, path]);

  async function save() {
    if (state.busy || !livePin) return;
    const pin = livePin;
    setState({ ...IDLE, busy: true });
    try {
      const out = await request(pin.route, { method: 'PUT', body: JSON.stringify({ body: draft, expectedNoteId: pin.noteId, expectedRevision: pin.revision, expectedCustomerId: pin.customerId }) });
      if (pinRef.current !== pin) return;
      setLoad({ status: 'ready', note: confirmedNote(out), customerId: pin.customerId });
      setDraft(null);
      setPin(null);
      setState({ ...IDLE, saved: true });
      onSaved?.();
    } catch (err) {
      if (pinRef.current !== pin) return;
      setState(saveFailure(err));
    }
  }
  const startEdit = () => { setPin(pinFor(route, stopKey, load, picked && picked.id)); setDraft(load.note?.body || ''); setState(IDLE); };
  // Keep editing: the draft stays, and the next save is checked against the newer note it just saw.
  const keepMine = () => { setPin(repinned(livePin, state.conflict.note)); setLoad({ ...load, note: state.conflict.note }); setState(IDLE); };
  const cancelEdit = () => { if (state.conflict) setLoad({ ...load, note: state.conflict.note }); setDraft(null); setPin(null); setState(IDLE); };

  if (!request || !route || load.status === 'none') return load.message ? <p style={lineStyle}>{load.message}</p> : null;
  return (
    <div data-testid="home-note-section">
      <div style={labelStyle}>About this home</div>
      {load.status === 'loading' && <p style={lineStyle}>Loading…</p>}
      {load.status === 'error' && (
        <p role="alert" style={{ ...lineStyle, color: C.amber }}>
          Couldn&apos;t load the note. <button type="button" onClick={read} style={{ ...quietBtn, minHeight: 40, marginLeft: 8 }}>Retry</button>
        </p>
      )}
      {load.status === 'ready' && shownDraft === null && <NoteReadView note={load.note} onEdit={startEdit} />}
      {shownDraft !== null && <NoteEditor draft={shownDraft} setDraft={setDraft} state={state} onSave={save} onCancel={cancelEdit} />}
      {state.conflict && <Conflict note={state.conflict.note} onKeep={keepMine} onCancel={cancelEdit} />}
      {state.saved && <p role="status" style={lineStyle}>Saved.</p>}
      {state.error && <p role="alert" style={{ ...lineStyle, color: C.red }}>{state.error}</p>}
    </div>
  );
}
