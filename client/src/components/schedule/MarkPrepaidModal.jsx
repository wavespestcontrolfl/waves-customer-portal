// Small modal for recording that a visit was paid in advance (cash, Zelle,
// phone CC, etc.). On submit → POST /admin/schedule/:id/prepaid. Once set,
// the completion handler will skip auto-invoicing and send a "thanks for
// your payment" SMS instead of a pay-link SMS.
//
// Mobile-first layout — stays inside the admin V2 system (Tailwind zinc ramp).

import { useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      ...(options.headers || {}),
    },
  }).then(async (r) => {
    if (!r.ok) throw new Error(await r.text().catch(() => `${r.status}`));
    return r.json();
  });
}

const METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'zelle', label: 'Zelle' },
  { value: 'check', label: 'Check' },
  { value: 'card_over_phone', label: 'Card (over phone)' },
  { value: 'other', label: 'Other' },
];

export default function MarkPrepaidModal({ service, onClose, onSaved }) {
  const [amount, setAmount] = useState(() => {
    const p = service?.estimatedPrice;
    return p != null ? String(p) : '';
  });
  const [method, setMethod] = useState('cash');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function handleSave() {
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt < 0) {
      setError('Enter a valid amount');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await adminFetch(`/admin/schedule/${service.id}/prepaid`, {
        method: 'POST',
        body: JSON.stringify({ amount: amt, method, note: note.trim() || null }),
      });
      onSaved?.();
    } catch (e) {
      setError(e.message || 'Failed to save');
      setSaving(false);
    }
  }

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[110] flex items-end md:items-center justify-center"
      style={{ background: 'rgba(15,23,42,0.55)', padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full bg-white rounded-2xl"
        style={{ maxWidth: 480, padding: 20 }}
      >
        <div
          className="flex items-start justify-between"
          style={{ marginBottom: 16 }}
        >
          <div>
            <div
              className="font-medium text-zinc-900"
              style={{ fontSize: 18 }}
            >
              Mark prepaid
            </div>
            <div
              className="text-ink-secondary"
              style={{ fontSize: 13, marginTop: 2 }}
            >
              {service.customerName} — {service.serviceType || 'Service'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex items-center justify-center rounded-full bg-white border border-hairline border-zinc-200 u-focus-ring"
            style={{ width: 32, height: 32, fontSize: 18, lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        <label
          className="block uppercase tracking-label text-ink-secondary font-medium"
          style={{ fontSize: 11, marginBottom: 6 }}
        >
          Amount received
        </label>
        <div
          className="flex items-center border border-hairline border-zinc-200 rounded-lg"
          style={{ padding: '0 12px', marginBottom: 14 }}
        >
          <span className="text-ink-secondary" style={{ fontSize: 15 }}>$</span>
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="flex-1 u-nums text-zinc-900 outline-none"
            style={{ padding: '12px 8px', fontSize: 15, border: 'none', background: 'transparent' }}
            placeholder="0.00"
          />
        </div>

        <label
          className="block uppercase tracking-label text-ink-secondary font-medium"
          style={{ fontSize: 11, marginBottom: 6 }}
        >
          Method
        </label>
        <div
          className="flex flex-wrap"
          style={{ gap: 6, marginBottom: 14 }}
        >
          {METHODS.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setMethod(m.value)}
              className={
                'rounded-full u-focus-ring ' +
                (method === m.value
                  ? 'bg-zinc-900 text-white'
                  : 'bg-white text-zinc-900 border border-hairline border-zinc-200')
              }
              style={{ padding: '8px 14px', fontSize: 13, fontWeight: 500 }}
            >
              {m.label}
            </button>
          ))}
        </div>

        <label
          className="block uppercase tracking-label text-ink-secondary font-medium"
          style={{ fontSize: 11, marginBottom: 6 }}
        >
          Note (optional)
        </label>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="w-full border border-hairline border-zinc-200 rounded-lg text-zinc-900 outline-none"
          style={{ padding: '12px', fontSize: 14, marginBottom: 18 }}
          placeholder="Check #, who took it, etc."
        />

        {error && (
          <div
            className="text-alert-fg"
            style={{ fontSize: 13, marginBottom: 12 }}
          >
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="w-full rounded-full bg-zinc-900 text-white font-medium u-focus-ring"
          style={{ padding: '14px 20px', fontSize: 15, opacity: saving ? 0.6 : 1 }}
        >
          {saving ? 'Saving…' : 'Save prepayment'}
        </button>
      </div>
    </div>
  );
}
