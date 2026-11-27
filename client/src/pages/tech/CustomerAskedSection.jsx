// "Customer asked" on the tech Visit Brief: what the customer asked for about this visit, before the tech starts
// (facts.customer_asked from GET /admin/schedule/:id/visit-brief): the reason for a return visit, the customer's
// words behind it, the note typed when self-booking, and open portal requests. Read-only text; no prices.
//
// The facts are the stop's customer's, the same on every member of a grouped stop, so the first member that has them
// carries the section (the panel passes memberBits; the pick lives here). Style tokens match VisitBriefPanel's own
// (they are not exported there, and importing the panel from here would be circular).
import { formatETDateTime } from '../../lib/timezone';

const sectionLabelStyle = {
  fontSize: 14,
  fontWeight: 500,
  lineHeight: 1.4,
  color: 'var(--tfx-text, #1c1917)',
  margin: '16px 0 6px',
  fontFamily: "var(--tfx-font, 'Roboto', system-ui, sans-serif)",
};
const factRowStyle = { fontSize: 14, color: 'var(--tfx-text, #1c1917)', margin: '3px 0 0' };
const factMutedStyle = { fontSize: 14, color: 'var(--tfx-muted, #57534e)', margin: '3px 0 0' };

const KIND_LABELS = {
  reservice_reason: 'Return visit reason',
  reservice_words: "Customer's words",
  booking_note: 'Booking note',
  portal_request: 'Portal request',
};

function askedDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : formatETDateTime(d, { month: 'short', day: 'numeric' });
}

function labelLine(item) {
  const pests = Array.isArray(item.pests) ? item.pests.filter(Boolean) : [];
  return [KIND_LABELS[item.kind] || 'Customer asked', askedDate(item.at), pests.join(', ')].filter(Boolean).join(' · ');
}

export default function CustomerAskedSection({ memberBits }) {
  const items = (memberBits || []).map((m) => m.facts?.customer_asked?.items).find((list) => Array.isArray(list) && list.length);
  if (!items) return null;
  return (
    <div data-testid="visit-brief-customer-asked">
      <div style={sectionLabelStyle}>Customer asked</div>
      {items.map((item, i) => (
        <div key={`${item.kind}-${item.at}-${i}`}>
          <p style={factMutedStyle}>{labelLine(item)}</p>
          <p style={factRowStyle}>{item.text}</p>
        </div>
      ))}
    </div>
  );
}
