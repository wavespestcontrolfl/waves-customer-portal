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

const IDLE = { busy: false, error: '', saved: false, conflict: null };

export default function HomeNoteSection({ request, path, services, byService, onSaved }) {
  const picked = services ? homeNoteFor(services, byService) : null;
  const fed = Boolean(services);
  const route = fed ? (picked && visitNotePath(picked.id)) : path;
  const [load, setLoad] = useState(picked ? { status: 'ready', note: picked.note, customerId: picked.customerId } : { status: 'loading', note: null, customerId: null });
  const [draft, setDraft] = useState(null);
  // What editing started from: the route, the customer and the note's time. Every save is checked against these, never
  // against what the panel shows now, so a refreshed brief or a stop switched under an open editor cannot redirect it.
  const [pin, setPin] = useState(null);
  const [state, setState] = useState(IDLE);
  const routeRef = useRef(route);
  routeRef.current = route;
  const read = useCallback(() => {
    setLoad({ status: 'loading', note: null, customerId: null });
    request(route)
      .then((data) => setLoad({ status: data?.editable === false ? 'none' : 'ready', note: data?.note || null, customerId: data?.customerId || null }))
      .catch((err) => {
        const quiet = [403, 404, 422].includes(err?.status);
        setLoad({ status: quiet ? 'none' : 'error', note: null, customerId: null, message: err?.status === 422 ? err.message : '' });
      });
  }, [request, route]);
  useEffect(() => { if (!fed && request && route) read(); }, [fed, request, route, read]);
  // The brief read again (after a save, or a refresh) brings the newest note down; an open editor keeps its pin.
  const pickedNote = picked ? picked.note : undefined;
  const pickedCustomer = picked ? picked.customerId : null;
  useEffect(() => { if (pickedNote !== undefined) setLoad({ status: 'ready', note: pickedNote, customerId: pickedCustomer }); }, [pickedNote, pickedCustomer]);
  // Another stop (or customer) selected: the open draft belongs to the one it was typed for, so it is dropped.
  useEffect(() => { setDraft(null); setPin(null); setState(IDLE); }, [route]);

  async function save() {
    if (state.busy || !pin) return;
    setState({ ...IDLE, busy: true });
    try {
      const out = await request(pin.route, { method: 'PUT', body: JSON.stringify({ body: draft, expectedUpdatedAt: pin.base, expectedCustomerId: pin.customerId }) });
      if (routeRef.current !== pin.route) return;
      // An answer with no `note` field (an unreadable 2xx) is an unknown outcome: the draft stays.
      if (!out || !('note' in out)) throw new Error('Could not confirm the save. Your text is still here; check the note and try again.');
      setLoad({ status: 'ready', note: out.note || null, customerId: pin.customerId });
      setDraft(null);
      setState({ ...IDLE, saved: true });
      onSaved?.();
    } catch (err) {
      if (routeRef.current !== pin.route) return;
      if (err?.status === 409 && (err.details || err.body || {}).code !== 'customer_changed') setState({ ...IDLE, conflict: { note: refusalNote(err) || null } });
      else setState({ ...IDLE, error: String(err?.message || err).slice(0, 160) });
    }
  }
  const startEdit = () => { setPin({ route, base: load.note?.updatedAt || null, customerId: load.customerId }); setDraft(load.note?.body || ''); setState(IDLE); };
  // Keep editing: the draft stays, and the next save is checked against the newer note it just saw.
  const keepMine = () => { setPin({ ...pin, base: state.conflict.note?.updatedAt || null }); setLoad({ ...load, note: state.conflict.note }); setState(IDLE); };
  const cancelEdit = () => { if (state.conflict) setLoad({ ...load, note: state.conflict.note }); setDraft(null); setPin(null); setState(IDLE); };

  if (!request || !route || load.status === 'none') return load.message ? <p style={lineStyle}>{load.message}</p> : null;
  const note = load.note;
  return (
    <div data-testid="home-note-section">
      <div style={labelStyle}>About this home</div>
      {load.status === 'loading' && <p style={lineStyle}>Loading…</p>}
      {load.status === 'error' && (
        <p role="alert" style={{ ...lineStyle, color: C.amber }}>
          Couldn&apos;t load the note. <button type="button" onClick={read} style={{ ...quietBtn, minHeight: 40, marginLeft: 8 }}>Retry</button>
        </p>
      )}
      {load.status === 'ready' && draft === null && (
        <>
          {note ? (
            <>
              <p style={{ fontSize: 14, color: C.text, margin: '3px 0 0', whiteSpace: 'pre-wrap' }}>{note.body}</p>
              <p style={lineStyle}>{byline(note)}</p>
            </>
          ) : <p style={lineStyle}>No note yet.</p>}
          <div style={{ marginTop: 6 }}>
            <button type="button" onClick={startEdit} style={quietBtn}>{note ? 'Edit' : 'Add note'}</button>
          </div>
        </>
      )}
      {draft !== null && <NoteEditor draft={draft} setDraft={setDraft} state={state} onSave={save} onCancel={cancelEdit} />}
      {state.conflict && <Conflict note={state.conflict.note} onKeep={keepMine} onCancel={cancelEdit} />}
      {state.saved && <p role="status" style={lineStyle}>Saved.</p>}
      {state.error && <p role="alert" style={{ ...lineStyle, color: C.red }}>{state.error}</p>}
    </div>
  );
}
