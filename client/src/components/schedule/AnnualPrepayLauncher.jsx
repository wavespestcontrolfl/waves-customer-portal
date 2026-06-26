// Thin launcher for the completion screen: fetches the customer detail that the
// proven Customer 360 AnnualPrepayInvoiceModal needs, then renders that exact
// modal. This lets "Offer annual prepay" at completion reuse the correct
// annual-prepay invoice flow (commercial-tax preview, full cadence set, term
// dates, amount inference) rather than a parallel reimplementation.

import { useState, useEffect } from 'react';
import { AnnualPrepayInvoiceModal } from '../admin/Customer360ProfileV2';
import MobilePaymentSheet from './MobilePaymentSheet';

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

// Mirror of Customer 360's displayedAnnualPrepayTerm so the reused modal's
// defaults + the server overlap guard line up: a truly active/renewal-pending
// term, else a sent-but-unpaid (payment_pending) one, else a renewal-decided /
// renewal-lapsed term whose paid window still covers today (the overlap guard
// 409s all of these). Without this the modal would default termStart to today and
// the operator would hit a 409. Null when there's no binding term.
function pickActiveTerm(terms = []) {
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const endStr = (t) => String(t?.termEnd || '').slice(0, 10);
  return terms.find((t) => ['active', 'renewal_pending'].includes(t.status))
    || terms.find((t) => t.status === 'payment_pending')
    || terms.find((t) =>
      (['renewed', 'switch_plan'].includes(t.status)
        || (t.status === 'cancelled' && t.renewalDecision === 'cancel'))
      && endStr(t) >= todayStr)
    || null;
}

export default function AnnualPrepayLauncher({ customerId, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [paymentInvoice, setPaymentInvoice] = useState(null);

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

  const customerName = [data.customer?.firstName, data.customer?.lastName]
    .filter(Boolean).join(' ').trim() || 'Customer';

  // Tap-to-Pay handoff: once the operator chose "Charge in person", the prepay
  // invoice is minted (no term yet) — charge it on the spot. Any successful tender
  // marks it paid and the webhook creates + activates the term; an abort just
  // leaves a benign unpaid draft (no orphan term).
  if (paymentInvoice) {
    return (
      <MobilePaymentSheet
        desktopVisible
        service={{ customerId: data.customer?.id || customerId, customerName }}
        invoiceId={paymentInvoice.id}
        invoiceToken={paymentInvoice.token}
        amount={Number(paymentInvoice.total) || 0}
        onClose={onClose}
        onChargeSuccess={() => { onSaved?.(); onClose?.(); }}
        onPrepaidRecorded={() => { onSaved?.(); onClose?.(); }}
        onInvoiceSent={() => { onSaved?.(); onClose?.(); }}
      />
    );
  }

  return (
    <AnnualPrepayInvoiceModal
      customer={data.customer}
      activeTerm={pickActiveTerm(data.annualPrepayTerms)}
      prepaidPlans={data.prepaidPlans || []}
      annualPrepayTerms={data.annualPrepayTerms || []}
      allowChargeInPerson
      onChargeInPerson={(invoice) => setPaymentInvoice(invoice)}
      onClose={onClose}
      onSaved={() => { onSaved?.(); onClose?.(); }}
    />
  );
}
