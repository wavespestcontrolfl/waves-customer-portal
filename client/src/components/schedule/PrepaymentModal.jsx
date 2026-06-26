// Completion-screen annual-prepay offer. The operator offers an existing recurring
// customer "pay the year up front" right after finishing the visit. Two paths:
//   Send with report → POST /admin/customers/:id/annual-prepay-invoice (default
//     deliver) — emails + texts the customer the unpaid prepay invoice (the
//     coverage badge renders on /pay/:token), riding alongside the service report.
//   Tap to Pay       → same route with deliver:false (mints, does NOT send), then
//     hands the invoice to MobilePaymentSheet to charge the year in person.
//
// Reuses the existing annual-prepay invoice/term machinery as-is: NO -5% discount
// is applied (amount is operator-entered, suggested from monthly_rate * 12), and
// payment (link or Tap-to-Pay) activates the term + stamps the covered visits via
// the existing Stripe webhook path. Admin V2 system (Tailwind zinc ramp).

import { useState, useEffect } from 'react';
import MobilePaymentSheet from './MobilePaymentSheet';

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
    if (!r.ok) {
      let msg = `${r.status}`;
      try { const j = await r.json(); msg = j.error || msg; } catch { msg = (await r.text().catch(() => '')) || msg; }
      throw new Error(msg);
    }
    return r.json();
  });
}

function serviceDisplayName(service) {
  return service?.serviceTypeDisplay || service?.serviceType || service?.service_type || 'Quarterly Pest Control';
}

// Visit count is implied by cadence over a 12-month term.
const CADENCES = [
  { value: 'quarterly', label: 'Quarterly', visits: 4 },
  { value: 'bimonthly', label: 'Bi-monthly', visits: 6 },
  { value: 'monthly', label: 'Monthly', visits: 12 },
];

export default function PrepaymentModal({ service, customerId, customerName, monthlyRate, onClose, onSent }) {
  const cid = customerId || service?.customerId || service?.customer_id;
  const cname = customerName || service?.customerName || service?.customer_name || 'Customer';

  const [amount, setAmount] = useState(() => {
    const r = Number(monthlyRate);
    return Number.isFinite(r) && r > 0 ? String(Math.round(r * 12 * 100) / 100) : '';
  });
  const [serviceType, setServiceType] = useState(() => serviceDisplayName(service));
  const [cadence, setCadence] = useState('quarterly');
  const [visitCount, setVisitCount] = useState(4);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [paymentInvoice, setPaymentInvoice] = useState(null); // Tap-to-Pay handoff

  // When the caller didn't pass a monthly rate (e.g. the completion screen has no
  // customer record loaded), fetch it so we can pre-fill the year's amount. The
  // operator can always override; an empty field just means they type it.
  useEffect(() => {
    if (amount || !cid || (Number(monthlyRate) > 0)) return;
    let cancelled = false;
    adminFetch(`/admin/customers/${cid}`)
      .then((c) => {
        const r = Number(c?.monthly_rate ?? c?.monthlyRate);
        if (!cancelled && Number.isFinite(r) && r > 0) {
          setAmount(String(Math.round(r * 12 * 100) / 100));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid]);

  const amt = parseFloat(amount);
  const perVisit = Number.isFinite(amt) && visitCount > 0
    ? Math.round((amt / visitCount) * 100) / 100
    : 0;

  function pickCadence(next) {
    setCadence(next.value);
    setVisitCount(next.visits);
  }

  async function submit(deliver) {
    if (!cid) { setError('Missing customer for this visit'); return; }
    if (!Number.isFinite(amt) || amt <= 0) { setError('Enter a valid amount'); return; }
    setSaving(true);
    setError(null);
    try {
      const result = await adminFetch(`/admin/customers/${cid}/annual-prepay-invoice`, {
        method: 'POST',
        body: JSON.stringify({
          amount: amt,
          serviceType: serviceType.trim() || undefined,
          visitCount,
          cadence,
          deliver,
        }),
      });
      if (deliver) {
        onSent?.({ sent: true, ...result });
      } else {
        // Tap to Pay: the payment sheet takes over with the minted (unsent) invoice.
        setPaymentInvoice(result.invoice);
        setSaving(false);
      }
    } catch (e) {
      setError(e.message || 'Failed to create the prepayment');
      setSaving(false);
    }
  }

  // Once a Tap-to-Pay invoice is minted, the payment sheet replaces the form.
  if (paymentInvoice) {
    return (
      <MobilePaymentSheet
        desktopVisible
        service={{ ...service, customerId: cid, customerName: cname }}
        invoiceId={paymentInvoice.id}
        invoiceToken={paymentInvoice.token}
        amount={Number(paymentInvoice.total) || amt}
        onClose={() => { setPaymentInvoice(null); onClose?.(); }}
        onChargeSuccess={() => onSent?.({ charged: true, invoice: paymentInvoice })}
        onPrepaidRecorded={() => onSent?.({ charged: true, invoice: paymentInvoice })}
        onInvoiceSent={() => onSent?.({ sent: true, invoice: paymentInvoice })}
      />
    );
  }

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[1200] flex items-end md:items-center justify-center"
      style={{ background: 'rgba(15,23,42,0.55)', padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full bg-white rounded-2xl"
        style={{ maxWidth: 480, padding: 20 }}
      >
        <div className="flex items-start justify-between" style={{ marginBottom: 16 }}>
          <div>
            <div className="font-medium text-zinc-900" style={{ fontSize: 18 }}>Annual prepay</div>
            <div className="text-ink-secondary" style={{ fontSize: 13, marginTop: 2 }}>
              {cname} — pay the year up front
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

        <label className="block uppercase tracking-label text-ink-secondary font-medium" style={{ fontSize: 11, marginBottom: 6 }}>
          Amount for the year
        </label>
        <div className="flex items-center border border-hairline border-zinc-200 rounded-lg" style={{ padding: '0 12px', marginBottom: 14 }}>
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

        <label className="block uppercase tracking-label text-ink-secondary font-medium" style={{ fontSize: 11, marginBottom: 6 }}>
          Service
        </label>
        <input
          type="text"
          value={serviceType}
          onChange={(e) => setServiceType(e.target.value)}
          className="w-full border border-hairline border-zinc-200 rounded-lg text-zinc-900 outline-none"
          style={{ padding: '12px', fontSize: 14, marginBottom: 14 }}
          placeholder="Quarterly Pest Control"
        />

        <label className="block uppercase tracking-label text-ink-secondary font-medium" style={{ fontSize: 11, marginBottom: 6 }}>
          Cadence
        </label>
        <div className="flex flex-wrap" style={{ gap: 6, marginBottom: 14 }}>
          {CADENCES.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => pickCadence(c)}
              className={
                'rounded-full u-focus-ring ' +
                (cadence === c.value
                  ? 'bg-zinc-900 text-white'
                  : 'bg-white text-zinc-900 border border-hairline border-zinc-200')
              }
              style={{ padding: '8px 14px', fontSize: 13, fontWeight: 500 }}
            >
              {c.label} · {c.visits}
            </button>
          ))}
        </div>

        {amt > 0 && visitCount > 0 && (
          <div className="text-ink-secondary" style={{ fontSize: 12, marginTop: -6, marginBottom: 14 }}>
            ${amt.toFixed(2)} ÷ {visitCount} visits ≈ ${perVisit.toFixed(2)} per visit. Covers a 12-month term;
            paying activates the coverage and marks those visits prepaid.
          </div>
        )}

        {error && (
          <div className="text-alert-fg" style={{ fontSize: 13, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div className="flex" style={{ gap: 8 }}>
          <button
            type="button"
            onClick={() => submit(true)}
            disabled={saving}
            className="flex-1 rounded-full bg-zinc-900 text-white font-medium u-focus-ring"
            style={{ padding: '14px 16px', fontSize: 14, opacity: saving ? 0.6 : 1 }}
          >
            {saving ? 'Working…' : 'Send with report'}
          </button>
          <button
            type="button"
            onClick={() => submit(false)}
            disabled={saving}
            className="flex-1 rounded-full bg-white text-zinc-900 border border-hairline border-zinc-300 font-medium u-focus-ring"
            style={{ padding: '14px 16px', fontSize: 14, opacity: saving ? 0.6 : 1 }}
          >
            Tap to Pay
          </button>
        </div>
        <div className="text-ink-tertiary text-center" style={{ fontSize: 12, marginTop: 10 }}>
          “Send with report” emails + texts a pay link · “Tap to Pay” charges in person now
        </div>
      </div>
    </div>
  );
}
