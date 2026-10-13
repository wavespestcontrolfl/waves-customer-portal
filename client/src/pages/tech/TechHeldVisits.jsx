import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getAdminAuthToken } from '../../lib/adminAuth';
import { etDateString } from '../../lib/timezone';
import { fromCall, heldWhen, kindText } from '../admin/HeldVisitsStrip';

// "From calls, not on the calendar" on the Today page (GATE_CALL_HELD_VISIT, owner
// 2026-10-12): visits promised or discussed on a recorded call for today that nothing on the
// calendar carries. The same rows as the Dispatch strip, display only. Mounted for an admin
// login only: a held row belongs to no technician, and a technician login sees its own
// assigned visits and nothing else (the server route is admin-only for the same reason).
// Booking happens in Dispatch; this card links there.

const API = import.meta.env.VITE_API_URL || '';

async function readHeldVisits(date) {
  const res = await fetch(`${API}/api/admin/schedule/held-visits?date=${date}`, {
    headers: { Authorization: `Bearer ${getAdminAuthToken()}` },
  });
  if (!res.ok) throw new Error(`held visits ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.heldVisits) ? data.heldVisits : [];
}

export default function TechHeldVisits() {
  const [state, setState] = useState({ date: etDateString(), rows: [] });
  // Only the newest read of a still-mounted card may show.
  const mounted = useRef(true);
  const latest = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback(async () => {
    const mine = latest.current + 1;
    latest.current = mine;
    const date = etDateString();
    try {
      const rows = await readHeldVisits(date);
      if (mounted.current && latest.current === mine) setState({ date, rows });
    } catch {
      // No connection or a server fault: keep what is on screen. This card never
      // stands in the way of the route.
    }
  }, []);
  useEffect(() => {
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);

  if (state.rows.length === 0) return null;
  return (
    <section className="tf-card tf-card-main" aria-label="From calls, not on the calendar">
      <h2 className="tf-overline">From calls, not on the calendar</h2>
      {state.rows.map((row) => {
        const place = [row.address?.line1, row.address?.line2, row.address?.city].filter(Boolean).join(', ');
        return (
          <div key={row.call_log_id} className="tf-alert">
            <strong>{heldWhen(row)} · {row.caller_name}</strong>
            <div><span className="tf-tag">{kindText(row).tag}</span></div>
            {(place || row.service) && <div>{[place, row.service].filter(Boolean).join(' · ')}</div>}
            <div className="tf-muted">{fromCall(row)}{row.phone ? ` · ${row.phone}` : ''}</div>
            {row.notes && <div className="tf-muted">From the call: {row.notes}</div>}
          </div>
        );
      })}
      <div className="tf-actions"><Link className="tf-button" to={`/admin/dispatch?date=${state.date}`}>Book in Dispatch</Link></div>
    </section>
  );
}
