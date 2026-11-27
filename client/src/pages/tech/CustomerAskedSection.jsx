// "Customer asked" on the tech Visit Brief: what the customer asked for about this visit, before the tech starts
// (facts.customer_asked from GET /admin/schedule/:id/visit-brief): the reason for a return visit, the customer's
// words behind it, the note typed when self-booking, and open portal requests. Read-only text; no prices.
//
// A grouped stop merges every member's list: portal requests and the customer's words are shared (shown once), while
// each member's own return reason and booking note stay with its service. The panel passes memberBits; the merge
// lives here. Style tokens match VisitBriefPanel's own
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

// Return reasons and booking notes belong to one service; everything else is the customer's, the same on every member.
const OWN_KINDS = new Set(['reservice_reason', 'booking_note']);

// Every member's list, merged: shared items once (by kind, date and text), each member's own reason or note kept with its
// service (named only on a grouped stop). Newest first.
function mergedItems(memberBits) {
  const grouped = (memberBits || []).length > 1;
  const seen = new Set();
  const merged = [];
  for (const m of memberBits || []) {
    const list = m.facts?.customer_asked?.items;
    if (!Array.isArray(list)) continue;
    const own = grouped ? (m.service?.serviceType || m.service?.service_type || null) : null;
    for (const item of list) {
      const mine = OWN_KINDS.has(item.kind);
      const key = [item.kind, item.at, item.text, mine ? m.service?.id : ''].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(mine && own ? { ...item, serviceLabel: own } : item);
    }
  }
  return merged.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function labelLine(item) {
  const pests = Array.isArray(item.pests) ? item.pests.filter(Boolean) : [];
  return [KIND_LABELS[item.kind] || 'Customer asked', item.serviceLabel, askedDate(item.at), pests.join(', ')].filter(Boolean).join(' · ');
}

export default function CustomerAskedSection({ memberBits }) {
  const items = mergedItems(memberBits);
  if (!items.length) return null;
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
