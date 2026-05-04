// Cash tender with numpad — Square-style per IMG_3862. The amount field
// defaults to the invoice total via placeholder; numpad taps build a
// cents-based amount that overrides on submit. Tender fires the existing
// /admin/invoices/:id/record-payment endpoint with method='cash'. Checkout
// mints the invoice before this sheet opens, so cash needs to settle that
// invoice instead of writing only a scheduled-service prepaid marker.

import { ArrowLeft, Delete } from 'lucide-react';
import { useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function fmt(cents) {
  const d = cents / 100;
  return `$${d.toFixed(2)}`;
}

export default function MobileCashTenderSheet({
  invoiceId,
  amount,           // invoice total (dollars)
  onClose,
  onRecorded,
}) {
  // Entered amount in cents — 0 means "use placeholder (invoice total)".
  const [entered, setEntered] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const placeholderText = `$${Number(amount || 0).toFixed(2)}`;

  function pressDigit(s) {
    setEntered((prev) => {
      // Append digit(s) — treat each tap as "shift left one decimal, add digit"
      const next = prev * 10 + Number(s[0]);
      if (s.length > 1) return next * 10 + Number(s[1]);
      // Clamp at 9 digits of cents ($9,999,999.99)
      return next > 99_999_999_9 ? prev : next;
    });
  }

  function pressBackspace() {
    setEntered((prev) => Math.floor(prev / 10));
  }

  async function handleTender() {
    if (saving) return;
    const submitAmount = entered > 0 ? entered / 100 : Number(amount || 0);
    if (!Number.isFinite(submitAmount) || submitAmount <= 0) {
      setError('Enter an amount');
      return;
    }
    if (!invoiceId) {
      setError('Missing invoice id');
      return;
    }
    if (Math.round(submitAmount * 100) !== Math.round(Number(amount || 0) * 100)) {
      setError('Cash payment must match the invoice total');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/admin/invoices/${invoiceId}/record-payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
        },
        body: JSON.stringify({ method: 'cash', note: null, sendReceipt: false }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || 'Failed to record payment');
      }
      const data = await r.json();
      onRecorded?.({ amount: submitAmount, method: 'cash', invoice: data.invoice });
      onClose?.();
    } catch (e) {
      setError(e.message || 'Failed to record payment');
      setSaving(false);
    }
  }

  const displayValue = entered > 0 ? fmt(entered) : '';

  return (
    <div className="fixed inset-0 z-[115] bg-white flex flex-col md:hidden">
      {/* Header */}
      <div
        className="flex items-center px-3 border-b border-hairline border-zinc-200"
        style={{ height: 56, paddingTop: 'env(safe-area-inset-top, 0)' }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Back"
          className="flex items-center justify-center h-11 w-11 u-focus-ring text-zinc-900"
        >
          <ArrowLeft size={22} strokeWidth={2} />
        </button>
        <div className="flex-1 text-center font-medium text-zinc-900" style={{ fontSize: 16 }}>
          {placeholderText} Cash
        </div>
        <div className="w-11" />
      </div>

      {/* Amount + Tender card */}
      <div className="px-4 pt-4" style={{ maxWidth: 560, width: '100%', alignSelf: 'center' }}>
        <div
          className="border border-hairline border-zinc-200 rounded-sm"
          style={{
            padding: '16px 18px',
            minHeight: 56,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          {displayValue ? (
            <span className="u-nums text-zinc-900" style={{ fontSize: 22, fontWeight: 500 }}>
              {displayValue}
            </span>
          ) : (
            <span className="u-nums text-ink-tertiary" style={{ fontSize: 22, fontWeight: 500 }}>
              {placeholderText}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={handleTender}
          disabled={saving}
          className="w-full u-focus-ring"
          style={{
            marginTop: 0,
            padding: '18px 24px',
            fontSize: 18,
            fontWeight: 600,
            background: '#111111',
            color: '#FFFFFF',
            border: 'none',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Recording…' : 'Tender'}
        </button>
        {error && (
          <div className="text-alert-fg" style={{ fontSize: 13, marginTop: 10, textAlign: 'center' }}>
            {error}
          </div>
        )}
      </div>

      {/* Spacer — numpad hugs the bottom */}
      <div className="flex-1" />

      {/* Numpad */}
      <div
        className="grid grid-cols-3 border-t border-hairline border-zinc-200"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}
      >
        {['1','2','3','4','5','6','7','8','9'].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => pressDigit(d)}
            className="u-focus-ring"
            style={keyStyle}
          >
            {d}
          </button>
        ))}
        <button
          type="button"
          onClick={() => pressDigit('00')}
          className="u-focus-ring"
          style={{ ...keyStyle, background: '#E5E5E5' }}
        >
          00
        </button>
        <button
          type="button"
          onClick={() => pressDigit('0')}
          className="u-focus-ring"
          style={keyStyle}
        >
          0
        </button>
        <button
          type="button"
          onClick={pressBackspace}
          aria-label="Backspace"
          className="u-focus-ring flex items-center justify-center"
          style={{ ...keyStyle, background: '#E5E5E5' }}
        >
          <Delete size={22} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

const keyStyle = {
  height: 68,
  fontSize: 24,
  fontWeight: 500,
  color: '#111111',
  background: '#FFFFFF',
  border: 'none',
  borderRight: '1px solid #E5E5E5',
  borderBottom: '1px solid #E5E5E5',
  cursor: 'pointer',
};
