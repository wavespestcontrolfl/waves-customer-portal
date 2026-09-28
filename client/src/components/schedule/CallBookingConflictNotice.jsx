// Shown on New Appointment when the server refused a create because the
// phone agent already booked the same service for this customer within a
// day of the date (409 duplicate_call_booking, admin-schedule POST /). Lists
// each existing visit with a link to open it, and "Book another anyway",
// which re-submits with an override naming exactly these visits. Same
// palette as CreateAppointmentModal's duplicate-series section.
const D = { border: '#E4E4E7', text: '#18181B', white: '#fff' };

// The service line the request collided with: the visit's own service, or
// an add-on on it ("Mosquito Control (add-on to General Pest Control)").
export function matchedLineLabel(visit) {
  const matched = visit.matchedService || visit.serviceType;
  return matched === visit.serviceType ? matched : `${matched} (add-on to ${visit.serviceType})`;
}

export default function CallBookingConflictNotice({ conflict, sectionRef, canSubmit, onBookAnother }) {
  if (!conflict) return null;
  return (
    <section ref={sectionRef} aria-label="Visit already booked by the phone agent" style={{ padding: 16, marginBottom: 16, border: `1px solid ${D.border}`, borderRadius: 8, fontSize: 14, lineHeight: 1.5 }}>
      <div style={{ fontWeight: 500 }}>The phone agent already booked this</div>
      {conflict.existingVisits?.map((visit) => (
        <div key={visit.id} style={{ padding: '10px 0', borderBottom: `1px solid ${D.border}` }}>
          <div>{matchedLineLabel(visit)} · {visit.scheduledDate} · {visit.windowStart || 'No time set'} · {visit.status}</div>
          <a href={`/admin/dispatch?tab=schedule&date=${encodeURIComponent(visit.scheduledDate)}&appointment=${encodeURIComponent(visit.id)}`}
            target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, color: D.text, textDecoration: 'underline' }}>Open existing visit</a>
        </div>
      ))}
      <div style={{ marginTop: 12 }}>
        <button type="button" disabled={!canSubmit}
          onClick={onBookAnother}
          style={{ minHeight: 44, padding: '10px 16px', fontSize: 14, borderRadius: 6, background: D.text, color: D.white, border: 'none', opacity: !canSubmit ? 0.5 : 1 }}>
          Book another anyway
        </button>
      </div>
    </section>
  );
}
