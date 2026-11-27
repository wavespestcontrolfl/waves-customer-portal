// client/src/pages/admin/OnHoldStrip.jsx
//
// "On hold - customer will call" list for the office (GATE_VISIT_HOLD, owner 2026-11-27). Held visits leave every day
// view, so this is where the office finds them: customer, the visit's old date, how long it has been held, the note, and
// Release hold. It texts nobody. Renders nothing while the gate is off or the list is empty.
import React, { useCallback, useEffect, useState } from 'react';
import { adminFetch } from '../../utils/admin-fetch';
import { formatETDateOnly } from '../../lib/timezone';

export default function OnHoldStrip({ enabled = false, refreshKey = 0, onChanged }) {
  const [visits, setVisits] = useState([]);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await adminFetch('/admin/schedule/on-hold');
      setVisits(Array.isArray(res?.visits) ? res.visits : []);
    } catch {
      setVisits([]);
    }
  }, []);

  useEffect(() => {
    if (!enabled) { setVisits([]); return undefined; }
    load();
    return undefined;
  }, [enabled, refreshKey, load]);

  const release = async (row) => {
    setBusyId(row.id);
    setError('');
    try {
      await adminFetch(`/admin/schedule/${row.id}/hold/release`, { method: 'POST', body: JSON.stringify({}) });
      setVisits((rows) => rows.filter((r) => r.id !== row.id));
      onChanged?.(row);
    } catch (err) {
      setError(err?.message || 'Could not release. Try again.');
    } finally {
      setBusyId('');
    }
  };

  if (!enabled || !visits.length) return null;
  return (
    <details className="mb-3 rounded-md border border-solid border-zinc-200 bg-white px-4 py-3" data-testid="on-hold-strip">
      <summary className="cursor-pointer text-zinc-900 font-medium" style={{ fontSize: 16 }}>
        On hold - customer will call ({visits.length})
      </summary>
      <ul className="mt-3 flex flex-col gap-3 list-none p-0 m-0">
        {visits.map((row) => (
          <li key={row.id} className="flex flex-col gap-1 border-t border-hairline border-zinc-200 pt-3">
            <div className="text-zinc-900 font-medium" style={{ fontSize: 16 }}>
              {row.customerName || 'Customer'} · {row.serviceType || 'Visit'}
            </div>
            <div className="text-ink-secondary" style={{ fontSize: 14 }}>
              Was {row.scheduledDate ? formatETDateOnly(String(row.scheduledDate).slice(0, 10)) : 'unscheduled'} · on hold {row.daysOnHold} {row.daysOnHold === 1 ? 'day' : 'days'}
              {row.inSeries ? ' · closes if the next plan visit comes first' : ''}
            </div>
            {row.holdNote && <div className="text-zinc-900" style={{ fontSize: 14 }}>{row.holdNote}</div>}
            <div className="mt-1 flex gap-2">
              <button
                type="button"
                onClick={() => release(row)}
                disabled={busyId === row.id}
                className="rounded-full bg-white border border-hairline border-solid border-zinc-200 text-zinc-900 font-medium u-focus-ring disabled:opacity-50"
                style={{ padding: '10px 16px', fontSize: 14 }}
              >
                {busyId === row.id ? 'Releasing…' : 'Release hold'}
              </button>
              {row.customerId && (
                <a
                  href={`/admin/customers?customerId=${encodeURIComponent(row.customerId)}`}
                  className="rounded-full bg-white border border-hairline border-solid border-zinc-200 text-zinc-900 font-medium u-focus-ring no-underline"
                  style={{ padding: '10px 16px', fontSize: 14 }}
                >
                  Open customer
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
      {error && <div role="alert" className="mt-2 text-14 text-alert-fg">{error}</div>}
    </details>
  );
}
