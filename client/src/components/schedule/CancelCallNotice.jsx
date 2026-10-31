// Shown on New Appointment under the chosen customer when that customer's latest
// call was a cancellation (GET /admin/schedule/cancel-call-notice,
// GATE_CALL_CANCEL_GUARD). A warning only: nothing here stops the save.
// 2026-10-30: a caller canceled at 7:08 AM while nothing was booked, and the
// office booked her at 11:22 from this form, which showed nothing about it.
// Same palette as CallBookingConflictNotice.
import { useCanAccessCalls } from '../../hooks/useStaffCallAccess';

const D = { border: '#E4E4E7', text: '#18181B', muted: '#71717A' };

function whenLabel(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const day = at.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' });
  return `${day}, ${time}`;
}

export default function CancelCallNotice({ call }) {
  const canOpenCall = useCanAccessCalls();
  if (!call) return null;
  return (
    <section role="note" aria-label="Customer canceled on a call" data-testid="cancel-call-notice"
      style={{ marginTop: 10, padding: 12, border: `1px solid ${D.border}`, borderRadius: 8, fontSize: 14, lineHeight: 1.5, color: D.text }}>
      <div style={{ fontWeight: 500 }}>Canceled on a call · {whenLabel(call.at)}</div>
      {call.summary && <div style={{ marginTop: 4 }}>{call.summary}</div>}
      <div style={{ marginTop: 4, color: D.muted }}>You can still book. Check with the customer first.</div>
      {canOpenCall && call.callId && (
        <a href={`/admin/communications#tab=calls&call=${encodeURIComponent(call.callId)}`} target="_blank" rel="noopener noreferrer"
          style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, color: D.text, textDecoration: 'underline' }}>Open the call</a>
      )}
    </section>
  );
}
