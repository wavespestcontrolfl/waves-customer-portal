// Thin launcher for the completion screen: fetches the customer detail that the
// proven Customer 360 AnnualPrepayInvoiceModal needs, then renders that exact
// modal. This lets "Offer annual prepay" at completion reuse the correct
// annual-prepay invoice flow (commercial-tax preview, full cadence set, term
// dates, amount inference) rather than a parallel reimplementation.

import { useState, useEffect } from 'react';
import { AnnualPrepayInvoiceModal } from '../admin/Customer360ProfileV2';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` },
  }).then(async (r) => {
    if (!r.ok) {
      let msg = `${r.status}`;
      try { const j = await r.json(); msg = j.error || msg; } catch { msg = (await r.text().catch(() => '')) || msg; }
      throw new Error(msg);
    }
    return r.json();
  });
}

// Mirror of Customer 360's displayedAnnualPrepayTerm intent: surface the customer's
// current binding term (active, then payment_pending) so the modal's defaults +
// the server overlap guard line up. Null when there's no open term.
function pickActiveTerm(terms = []) {
  return terms.find((t) => t.status === 'active')
    || terms.find((t) => t.status === 'payment_pending')
    || null;
}

export default function AnnualPrepayLauncher({ customerId, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!customerId) { setError('No customer for this visit'); return undefined; }
    let cancelled = false;
    adminFetch(`/admin/customers/${customerId}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e.message || 'Failed to load customer'); });
    return () => { cancelled = true; };
  }, [customerId]);

  if (error) {
    return (
      <div
        onClick={onClose}
        className="fixed inset-0 z-[1200] flex items-center justify-center"
        style={{ background: 'rgba(15,23,42,0.55)', padding: 16 }}
      >
        <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl" style={{ padding: 20, maxWidth: 420 }}>
          <div className="text-alert-fg" style={{ fontSize: 14, marginBottom: 12 }}>{error}</div>
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-full bg-zinc-900 text-white font-medium u-focus-ring"
            style={{ padding: '12px 16px', fontSize: 14 }}
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="fixed inset-0 z-[1200] flex items-center justify-center" style={{ background: 'rgba(15,23,42,0.55)' }}>
        <div className="bg-white rounded-2xl text-ink-secondary" style={{ padding: 20, fontSize: 14 }}>Loading…</div>
      </div>
    );
  }

  return (
    <AnnualPrepayInvoiceModal
      customer={data.customer}
      activeTerm={pickActiveTerm(data.annualPrepayTerms)}
      prepaidPlans={data.prepaidPlans || []}
      annualPrepayTerms={data.annualPrepayTerms || []}
      onClose={onClose}
      onSaved={() => { onSaved?.(); onClose?.(); }}
    />
  );
}
