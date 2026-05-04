// Check tender — Square-style per IMG_3864. Amount is for tracking only;
// no actual processing happens (the customer hands over a physical check).
// Fires /admin/invoices/:id/record-payment with method='check'. Checkout
// mints the invoice before this sheet opens, so the check payment must mark
// that invoice paid for AR and completion-SMS branching.

import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

export default function MobileCheckTenderSheet({
  invoiceId,
  amount,           // invoice total (dollars)
  onClose,
  onRecorded,
}) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const amountText = `$${Number(amount || 0).toFixed(2)}`;

  async function handleRecord() {
    if (saving) return;
    if (!invoiceId) {
      setError('Missing invoice id');
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
        body: JSON.stringify({
          method: 'check',
          note: note.trim() || null,
          reference: note.trim() || null,
          sendReceipt: false,
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || 'Failed to record payment');
      }
      const data = await r.json();
      onRecorded?.({ amount: Number(amount || 0), method: 'check', note, invoice: data.invoice });
      onClose?.();
    } catch (e) {
      setError(e.message || 'Failed to record payment');
      setSaving(false);
    }
  }

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
          {amountText} Check
        </div>
        <div className="w-11" />
      </div>

      <div className="px-5 pt-6 pb-6" style={{ maxWidth: 560, width: '100%', alignSelf: 'center' }}>
        <p
          className="text-center text-ink-secondary"
          style={{ fontSize: 15, lineHeight: 1.4, marginBottom: 20 }}
        >
          Amount entered is for tracking purposes only. You will not receive a deposit for this transaction.
        </p>

        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional Note"
          className="w-full border border-hairline border-zinc-200 rounded-sm text-zinc-900 outline-none"
          style={{ padding: '16px 18px', fontSize: 16 }}
        />

        <button
          type="button"
          onClick={handleRecord}
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
          {saving ? 'Recording…' : 'Record Payment'}
        </button>
        {error && (
          <div className="text-alert-fg" style={{ fontSize: 13, marginTop: 10, textAlign: 'center' }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
