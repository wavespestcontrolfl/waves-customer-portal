/**
 * Tech instant answers — one-tap chips and an answer card for the tech
 * Intelligence Bar. Next stop, access notes and last treatment come from
 * GET /tech/answers (deterministic, no model call), never from the
 * Intelligence Bar query route. Renders nothing while the gate is off.
 */

import { useState, useEffect } from 'react';

const D = { bg: '#fafaf9', border: '#d6d3d1', teal: '#1c1917', text: '#1c1917', muted: '#57534e' };
const FONT = "'Roboto', system-ui, sans-serif";

// techFetch is the bar's own fetch helper (bearer token, throws on non-2xx).
export default function TechInstantAnswers({ techFetch, expanded, response, loading }) {
  const [kinds, setKinds] = useState([]);
  const [card, setCard] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    techFetch('/tech/answers')
      .then(d => { if (alive) setKinds(Array.isArray(d.kinds) ? d.kinds : []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [techFetch]);

  // A question sent to the AI bar replaces any instant answer.
  useEffect(() => { if (loading) setCard(null); }, [loading]);

  const open = async (kind) => {
    setBusy(true);
    try {
      const d = await techFetch(`/tech/answers/${encodeURIComponent(kind)}`);
      setCard({ title: d.title, lines: Array.isArray(d.lines) ? d.lines : [] });
    } catch {
      setCard({ title: 'Not available', lines: ['This answer could not be loaded. Try again.'], error: true });
    }
    setBusy(false);
  };

  if (!kinds.length) return null;

  if (card) {
    return (
      <div style={{ padding: '0 12px 12px' }} aria-live="polite">
        <div role={card.error ? 'alert' : undefined} style={{ border: `1px solid ${D.border}`, borderRadius: 4, background: D.bg, padding: '10px 12px', fontFamily: FONT }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: D.text, marginBottom: 6 }}>{card.title}</div>
          {card.lines.map((line, i) => (
            <div key={i} style={{ fontSize: 14, lineHeight: 1.6, color: D.text }}>{line}</div>
          ))}
          <button onClick={() => setCard(null)} aria-label="Close answer" style={{
            marginTop: 8, padding: '6px 10px', background: 'transparent', border: `1px solid ${D.border}`,
            borderRadius: 4, color: D.muted, fontSize: 14, fontWeight: 500, cursor: 'pointer', fontFamily: FONT,
          }}>Close</button>
        </div>
      </div>
    );
  }

  // Chips sit where the quick actions sit: open bar, no AI answer, not loading.
  if (!expanded || response || loading) return null;

  return (
    <div style={{ padding: '0 12px 10px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
      {kinds.map(k => (
        <button key={k.kind} onClick={() => open(k.kind)} disabled={busy} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '10px 10px',
          background: D.bg, border: `1px solid ${D.border}`, borderRadius: 4,
          color: D.muted, fontSize: 14, fontWeight: 500, cursor: busy ? 'not-allowed' : 'pointer',
          opacity: busy ? 0.6 : 1, fontFamily: FONT, textAlign: 'left',
        }}>
          <span>{k.label}</span>
        </button>
      ))}
    </div>
  );
}
