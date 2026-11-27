// The customer's last five completed visits, every service line, on the tech Visit Brief
// (facts.past_visits from GET /admin/schedule/:id/visit-brief; owner 2026-11-26). Read-only:
// date, service, the note written that day, product names and a free return visit mark.
// No prices. The panel shows this in place of its single "Last visit" block; this component
// owns that choice: it renders its children (the old block) only when NO member's facts carry
// the past_visits key (old server, read failure). An empty list is a confirmed "no earlier
// visits" and renders nothing. Tech portal style rule: inline styles only.
import { useState } from 'react';

const INITIAL_SHOWN = 3;

const labelStyle = {
  fontSize: 14,
  fontWeight: 500,
  lineHeight: 1.4,
  color: 'var(--tfx-text, #1c1917)',
  margin: '16px 0 6px',
  fontFamily: "var(--tfx-font, 'Roboto', system-ui, sans-serif)",
};
const rowStyle = { fontSize: 14, color: 'var(--tfx-text, #1c1917)', margin: '3px 0 0' };
const mutedStyle = { fontSize: 14, color: 'var(--tfx-muted, #57534e)', margin: '3px 0 0' };
const entryStyle = { marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--tfx-border, #d6d3d1)' };
const moreButtonStyle = {
  minHeight: 48, marginTop: 8, padding: '8px 12px', borderRadius: 4, fontSize: 14, cursor: 'pointer',
  border: '1px solid var(--tfx-border, #d6d3d1)', background: 'transparent', color: 'var(--tfx-muted, #57534e)',
};

function PastVisit({ visit }) {
  const names = (Array.isArray(visit.products) ? visit.products : []).map((p) => p?.name).filter(Boolean);
  return (
    <div style={entryStyle}>
      <p style={rowStyle}>
        {String(visit.date || '').slice(0, 10)}{visit.type ? ` · ${visit.type}` : ''}
        {visit.callback ? <span style={{ color: 'var(--tfx-amber, #854d0e)' }}> · Free return visit</span> : null}
      </p>
      {visit.notes && <p style={mutedStyle}>{visit.notes}</p>}
      {names.length > 0 && (
        <p style={rowStyle}>
          <span style={{ color: 'var(--tfx-muted, #57534e)' }}>Products: </span>
          {names.join(', ')}
        </p>
      )}
    </div>
  );
}

function PastVisitList({ visits }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? visits : visits.slice(0, INITIAL_SHOWN);
  const hidden = visits.length - INITIAL_SHOWN;
  return (
    <>
      <div style={labelStyle}>Past visits</div>
      {shown.map((v, i) => <PastVisit key={`${v.date || 'd'}-${i}`} visit={v} />)}
      {hidden > 0 && (
        <button type="button" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded} style={moreButtonStyle}>
          {expanded ? 'Show fewer' : `${hidden} more`}
        </button>
      )}
    </>
  );
}

// The list is customer-wide, so every member's facts carry the same one: the first that has the key.
export default function PastVisitsSection({ memberBits = [], children = null }) {
  const visits = memberBits.map((m) => m.facts?.past_visits).find(Array.isArray);
  if (!visits) return children;
  return visits.length ? <PastVisitList visits={visits} /> : null;
}
