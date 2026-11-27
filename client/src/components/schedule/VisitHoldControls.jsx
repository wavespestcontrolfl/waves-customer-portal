// "Customer will call - put on hold" (GATE_VISIT_HOLD, owner 2026-11-27). Shown on the visit sheet in both apps (the
// office's Dispatch and the technician's Today). A held visit leaves the route and gets no reminders until the office
// releases it. Hidden while the server's day feed says visitHold is off. Sends nothing to a customer.
import { useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const HOLDABLE = ['pending', 'confirmed'];
const NOTE_MAX = 280;

async function holdFetch(path, body) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json?.error || `HTTP ${r.status}`);
  return json;
}

export function OnHoldChip({ service }) {
  if (!service?.heldAt) return null;
  return (
    <span
      data-testid="on-hold-chip"
      className="inline-flex items-center rounded-full border border-hairline border-solid border-zinc-300 bg-zinc-100 px-3 py-1 text-zinc-900 font-medium"
      style={{ fontSize: 14 }}
    >
      On hold
    </span>
  );
}

export default function VisitHoldControls({ service, enabled = false, adminActions = false, onChanged }) {
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!enabled || !service?.id) return null;
  const held = !!service.heldAt;
  const holdable = HOLDABLE.includes(String(service.status || '').toLowerCase());

  const run = async (path, body) => {
    setBusy(true);
    setError('');
    try {
      await holdFetch(path, body);
      onChanged?.(service);
    } catch (err) {
      setError(err.message || 'Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (held) {
    if (!adminActions) return null;
    return (
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => run(`/admin/schedule/${service.id}/hold/release`)}
          disabled={busy}
          className="w-full rounded-full bg-white border border-hairline border-solid border-zinc-200 text-zinc-900 font-medium u-focus-ring disabled:opacity-50"
          style={{ padding: '14px 20px', fontSize: 16 }}
        >
          {busy ? 'Releasing…' : 'Release hold'}
        </button>
        {error && <div role="alert" className="text-14 text-alert-fg">{error}</div>}
      </div>
    );
  }
  if (!holdable) return null;
  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="w-full rounded-full bg-white border border-hairline border-solid border-zinc-200 text-zinc-900 font-medium u-focus-ring"
        style={{ padding: '14px 20px', fontSize: 16 }}
      >
        Customer will call - put on hold
      </button>
    );
  }
  return (
    <div className="rounded-md border-hairline border-zinc-200 bg-zinc-50 px-4 py-4" data-testid="hold-confirm">
      <div className="text-14 font-medium text-zinc-900">
        Put {service.customerName || 'this visit'} on hold? The visit leaves the route and no reminder texts go out until the office releases it.
      </div>
      <label className="block mt-3 text-14 text-zinc-900" htmlFor={`hold-note-${service.id}`}>Note (optional)</label>
      <textarea
        id={`hold-note-${service.id}`}
        value={note}
        maxLength={NOTE_MAX}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        className="mt-1 w-full rounded-md border border-solid border-zinc-200 bg-white px-3 py-2 text-zinc-900"
        style={{ fontSize: 16 }}
      />
      <div className="mt-4 flex flex-col gap-2">
        <button
          type="button"
          onClick={() => run(`/admin/schedule/${service.id}/hold`, { note: note.trim() })}
          disabled={busy}
          className="w-full rounded-full border-0 bg-zinc-900 text-white font-medium u-focus-ring disabled:opacity-50"
          style={{ padding: '14px 20px', fontSize: 16 }}
        >
          {busy ? 'Saving…' : 'Confirm hold'}
        </button>
        <button
          type="button"
          onClick={() => { setConfirming(false); setError(''); }}
          disabled={busy}
          className="w-full rounded-full bg-white border border-hairline border-solid border-zinc-200 text-zinc-900 font-medium u-focus-ring disabled:opacity-50"
          style={{ padding: '14px 20px', fontSize: 16 }}
        >
          Keep on route
        </button>
      </div>
      {error && <div role="alert" className="mt-2 text-14 text-alert-fg">{error}</div>}
    </div>
  );
}
