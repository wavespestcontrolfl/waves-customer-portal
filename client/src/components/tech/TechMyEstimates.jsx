import { useCallback, useEffect, useRef, useState } from 'react';
import { techEstimateRequest } from './useTechEstimates';
import TechEstimateSend from './TechEstimateSend';
import { INK, LineList, MUTED, s, statusWords, Totals, totalsWords } from './techEstimateParts';

const LOAD_ERROR = 'Could not load your estimates. Try again.';

// One of his estimates with its lines. The Send button shows only while the server says canSend. A send outcome is read
// back from the server; after a text whose result the app cannot see, the button never comes back for that estimate.
function Detail({ id, onBack, locked, onLock, onGone }) {
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState(null);
  const [lockedHere, setLockedHere] = useState(locked);
  const goneRef = useRef(onGone);
  goneRef.current = onGone;
  const read = useCallback(() => techEstimateRequest(`/${encodeURIComponent(id)}`)
    .then((data) => { setQuote(data); setError(''); })
    .catch((err) => { if (err.status === 404) goneRef.current(); else setError(LOAD_ERROR); }), [id]);
  useEffect(() => { void read(); }, [read]);
  const outcome = (result) => {
    if (result.gone) { onGone(); return; }
    if (result.lock) { onLock(id); setLockedHere(true); }
    setNote(result);
    if (result.reread) void read();
  };
  return (
    <div>
      <button type="button" style={{ ...s.small, marginBottom: 12 }} onClick={onBack}>Back</button>
      {error && <div role="alert" style={s.error}>{error}</div>}
      {!quote && !error && <p role="status" style={s.muted}>Loading estimate…</p>}
      {quote && (
        <div>
          <h3 style={{ margin: 0, fontSize: 18, color: INK }}>{quote.who || 'No name'}</h3>
          <p style={s.muted}>{quote.addressLine} · {statusWords(quote.status)}</p>
          {quote.officeFirst?.required && <p style={{ ...s.notice, marginTop: 10 }}>Office checks first</p>}
          <div style={{ ...s.card, marginTop: 12 }}>
            <LineList lines={quote.lines} />
            <Totals quote={quote} />
          </div>
          {note && <div role="status" style={note.ok ? s.card : s.notice}>{note.text}</div>}
          {quote.canSend && !lockedHere && <TechEstimateSend id={id} who={quote.who} needsTextRequest={quote.needsTextRequest} onOutcome={outcome} />}
        </div>
      )}
    </div>
  );
}

export default function TechMyEstimates() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const [listNote, setListNote] = useState('');
  const [version, setVersion] = useState(0);
  const locked = useRef(new Set());
  useEffect(() => {
    let live = true;
    techEstimateRequest('')
      .then((data) => { if (live) { setRows(Array.isArray(data?.estimates) ? data.estimates : []); setError(''); } })
      .catch(() => { if (live) setError(LOAD_ERROR); });
    return () => { live = false; };
  }, [version]);
  const close = (note = '') => { setOpenId(null); setListNote(note); setVersion((v) => v + 1); };
  if (openId) {
    return (
      <Detail
        id={openId} locked={locked.current.has(openId)} onLock={(id) => locked.current.add(id)}
        onBack={() => close()} onGone={() => close('This estimate is no longer in your list.')}
      />
    );
  }
  if (error) return <div role="alert" style={s.error}>{error}</div>;
  if (!rows) return <p role="status" style={s.muted}>Loading your estimates…</p>;
  return (
    <div>
      {listNote && <div role="status" style={s.notice}>{listNote}</div>}
      {rows.length === 0 && <p style={s.muted}>You have not saved an estimate yet.</p>}
      {rows.map((row) => (
        <button
          key={row.id} type="button" onClick={() => { setListNote(''); setOpenId(row.id); }}
          style={{ ...s.card, display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer', font: 'inherit', marginBottom: 10 }}
        >
          <strong style={{ fontSize: 16, color: INK }}>{row.who || 'No name'}</strong>
          <span style={{ ...s.muted, display: 'block' }}>{row.addressLine}</span>
          <span style={{ ...s.muted, display: 'block', color: MUTED }}>
            {statusWords(row.status)} · {totalsWords(row)}
          </span>
          {row.officeFirst?.required && <span style={{ ...s.muted, color: '#854d0e', display: 'block' }}>Office checks first</span>}
          {row.canSend && !locked.current.has(row.id) && (
            <span style={{ display: 'inline-block', marginTop: 6, padding: '2px 8px', borderRadius: 3, background: '#e7e5e4', color: INK, fontSize: 14 }}>Ready to send</span>
          )}
        </button>
      ))}
    </div>
  );
}
