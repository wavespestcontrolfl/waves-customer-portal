// "About this home": the one short lasting staff note for a home (server/services/home-note.js). Shown at the top of every
// visit on the tech Visit Brief, and on the admin customer profile for a home with no visit open. Staff only: the
// customer never sees it. `request(path, options)` is the caller's own staff fetch (it throws an Error with .status and the
// refusal body as .details or .body); `path` is the note's route. The Visit Brief hands the note in (`note`, read with the
// brief, so the panel adds no request); the office page gives none and the section reads `path` itself. Tech portal style
// rule: inline styles, no Tailwind.
import { useCallback, useEffect, useState } from 'react';
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

// The note the Visit Brief answer carries (visit-brief's `homeNote`, one per home): the first stop member that answered
// with it. { id, note } or null (no answer carried one: nothing to show).
export function homeNoteFor(services, byService) {
  const member = services.find((s) => byService?.[s.id]?.brief?.homeNote !== undefined);
  return member ? { id: member.id, note: byService[member.id].brief.homeNote } : null;
}

function byline(note) {
  const when = note.updatedAt ? formatETDate(note.updatedAt, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  return `Updated ${when}${note.updatedByFirstName ? ` by ${note.updatedByFirstName}` : ''}`;
}

function NoteEditor({ draft, setDraft, state, onSave, onCancel }) {
  return (
    <div data-testid="home-note-editor" style={{ marginTop: 8 }}>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, MAX))}
        rows={5}
        aria-label="About this home"
        style={{ width: '100%', boxSizing: 'border-box', padding: 8, borderRadius: 6, border: `1px solid ${C.border}`, background: C.card, color: C.text, fontSize: 16, resize: 'vertical' }}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
        <button type="button" onClick={onSave} disabled={state.busy} style={{ ...primaryBtn, opacity: state.busy ? 0.6 : 1 }}>{state.busy ? 'Saving…' : 'Save'}</button>
        <button type="button" onClick={onCancel} disabled={state.busy} style={quietBtn}>Cancel</button>
        <span style={{ ...lineStyle, margin: 0, marginLeft: 'auto' }}>{draft.length}/{MAX}</span>
      </div>
    </div>
  );
}

function Conflict({ note, onUse, onKeep }) {
  return (
    <div role="alert" data-testid="home-note-conflict" style={{ marginTop: 8, padding: 10, borderRadius: 4, border: `1px solid ${C.border}`, background: C.bg }}>
      <p style={{ ...lineStyle, color: C.amber, margin: 0 }}>Someone else changed this note.</p>
      <p style={{ fontSize: 14, color: C.text, margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{note ? note.body : 'The note was removed.'}</p>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" onClick={onUse} style={quietBtn}>Use their note</button>
        <button type="button" onClick={onKeep} style={quietBtn}>Keep editing mine</button>
      </div>
    </div>
  );
}

export default function HomeNoteSection({ request, path, note: provided, onSaved }) {
  const fed = provided !== undefined;
  const [load, setLoad] = useState(fed ? { status: 'ready', note: provided } : { status: 'loading', note: null });
  const [draft, setDraft] = useState(null);
  const [state, setState] = useState({ busy: false, error: '', saved: false, conflict: null });
  const read = useCallback(() => {
    setLoad({ status: 'loading', note: null });
    request(path)
      .then((data) => setLoad({ status: data?.editable === false ? 'none' : 'ready', note: data?.note || null }))
      .catch((err) => {
        const quiet = [403, 404, 422].includes(err?.status);
        setLoad({ status: quiet ? 'none' : 'error', note: null, message: err?.status === 422 ? err.message : '' });
      });
  }, [request, path]);
  useEffect(() => { if (!fed) read(); }, [fed, read]);
  // The brief read again (after a save, or a refresh) brings the newest note down.
  useEffect(() => { if (fed) setLoad({ status: 'ready', note: provided }); }, [fed, provided]);

  async function save() {
    if (state.busy) return;
    setState({ busy: true, error: '', saved: false, conflict: null });
    try {
      const out = await request(path, { method: 'PUT', body: JSON.stringify({ body: draft, expectedUpdatedAt: load.note?.updatedAt || null }) });
      setLoad({ status: 'ready', note: out?.note || null });
      setDraft(null);
      setState({ busy: false, error: '', saved: true, conflict: null });
      onSaved?.();
    } catch (err) {
      if (err?.status === 409) setState({ busy: false, error: '', saved: false, conflict: { note: refusalNote(err) || null } });
      else setState({ busy: false, error: String(err?.message || err).slice(0, 160), saved: false, conflict: null });
    }
  }
  const useTheirs = () => { setLoad({ status: 'ready', note: state.conflict.note }); setDraft(null); setState({ busy: false, error: '', saved: false, conflict: null }); };
  const keepMine = () => { setLoad({ status: 'ready', note: state.conflict.note }); setState({ busy: false, error: '', saved: false, conflict: null }); };

  if (load.status === 'none') return load.message ? <p style={lineStyle}>{load.message}</p> : null;
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
            <button type="button" onClick={() => { setDraft(note?.body || ''); setState({ busy: false, error: '', saved: false, conflict: null }); }} style={quietBtn}>{note ? 'Edit' : 'Add note'}</button>
          </div>
        </>
      )}
      {draft !== null && <NoteEditor draft={draft} setDraft={setDraft} state={state} onSave={save} onCancel={() => setDraft(null)} />}
      {state.conflict && <Conflict note={state.conflict.note} onUse={useTheirs} onKeep={keepMine} />}
      {state.saved && <p role="status" style={lineStyle}>Saved.</p>}
      {state.error && <p role="alert" style={{ ...lineStyle, color: C.red }}>{state.error}</p>}
    </div>
  );
}
