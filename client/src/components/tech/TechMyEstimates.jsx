import { useEffect, useState } from 'react';
import { techEstimateRequest } from './useTechEstimates';
import { INK, LineList, MUTED, s, statusWords, Totals, totalsWords } from './techEstimateParts';

const LOAD_ERROR = 'Could not load your estimates. Try again.';

// His own estimates, newest first (GET /api/tech/estimates), and one of them with its lines. Read only.
function Detail({ id, onBack }) {
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    techEstimateRequest(`/${encodeURIComponent(id)}`)
      .then((data) => { if (live) setQuote(data); })
      .catch(() => { if (live) setError(LOAD_ERROR); });
    return () => { live = false; };
  }, [id]);
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
        </div>
      )}
    </div>
  );
}

export default function TechMyEstimates() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  useEffect(() => {
    let live = true;
    techEstimateRequest('')
      .then((data) => { if (live) setRows(Array.isArray(data?.estimates) ? data.estimates : []); })
      .catch(() => { if (live) setError(LOAD_ERROR); });
    return () => { live = false; };
  }, []);
  if (openId) return <Detail id={openId} onBack={() => setOpenId(null)} />;
  if (error) return <div role="alert" style={s.error}>{error}</div>;
  if (!rows) return <p role="status" style={s.muted}>Loading your estimates…</p>;
  if (rows.length === 0) return <p style={s.muted}>You have not saved an estimate yet.</p>;
  return (
    <div>
      {rows.map((row) => (
        <button
          key={row.id} type="button" onClick={() => setOpenId(row.id)}
          style={{ ...s.card, display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer', font: 'inherit', marginBottom: 10 }}
        >
          <strong style={{ fontSize: 16, color: INK }}>{row.who || 'No name'}</strong>
          <span style={{ ...s.muted, display: 'block' }}>{row.addressLine}</span>
          <span style={{ ...s.muted, display: 'block', color: MUTED }}>
            {statusWords(row.status)} · {totalsWords(row)}
          </span>
          {row.officeFirst?.required && <span style={{ ...s.muted, color: '#854d0e', display: 'block' }}>Office checks first</span>}
        </button>
      ))}
    </div>
  );
}
