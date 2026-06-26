// Completion-screen annual-prepay offer. After finishing a visit, the operator
// (admin/office — CompletionPanel renders in the admin portal) can offer an
// existing customer to pay their year up front. The unpaid prepay invoice is
// emailed + texted (the coverage badge renders on /pay/:token), riding alongside
// the service report. Paying it activates the term and stamps the covered visits
// via the existing Stripe webhook path.
//
// Reuses the existing annual-prepay invoice/term machinery as-is: NO -5% discount
// (amount is operator-entered, suggested from monthly_rate * 12). The term starts
// the day AFTER this visit so the just-completed visit isn't counted as one of the
// paid (but un-stampable) covered visits.
//
// Tap-to-Pay (charge the year in person) is a deferred follow-up — it needs the
// webhook-watching charge lifecycle the existing checkout sheet provides.
//
// Admin V2 system (Tailwind zinc ramp).

import { useState, useEffect } from 'react';

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

// Coverage starts the day after the just-completed visit (local date — operators
// are ET). Excludes today's completed visit from the term so the paid visit count
// matches what actually gets stamped prepaid.
function tomorrowDateString() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Visit count is implied by cadence over a 12-month term.
const CADENCES = [
  { value: 'quarterly', label: 'Quarterly', visits: 4 },
  { value: 'bimonthly', label: 'Bi-monthly', visits: 6 },
  { value: 'monthly', label: 'Monthly', visits: 12 },
];

// Default the coverage cadence/visit count to the customer's ACTUAL plan (the
// service being completed). The annual-prepay engine honors an explicit
// coverage_cadence + visit count, so defaulting a monthly/bi-monthly customer to
// quarterly/4 would sell a full year that only stamps 4 visits — the rest would
// re-bill. The operator can still override via the pills.
function cadenceFromService(service) {
  const p = String(
    service?.recurringPattern || service?.recurring_pattern
    || service?.serviceTypeDisplay || service?.serviceType || service?.service_type || '',
  ).toLowerCase();
  if (/bi-?monthly|every other month/.test(p)) return CADENCES.find((c) => c.value === 'bimonthly');
  if (/month/.test(p)) return CADENCES.find((c) => c.value === 'monthly');
  return CADENCES.find((c) => c.value === 'quarterly');
}

export default function PrepaymentModal({ service, customerId, customerName, monthlyRate, onClose, onSent }) {
  const cid = customerId || service?.customerId || service?.customer_id;
  const cname = customerName || service?.customerName || service?.customer_name || 'Customer';

  const [amount, setAmount] = useState(() => {
    const r = Number(monthlyRate);
    return Number.isFinite(r) && r > 0 ? String(Math.round(r * 12 * 100) / 100) : '';
  });
  const [serviceType, setServiceType] = useState(() => serviceDisplayName(service));
  const initialCadence = cadenceFromService(service);
  const [cadence, setCadence] = useState(initialCadence.value);
  const [visitCount, setVisitCount] = useState(initialCadence.visits);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  // Don't let a backdrop/× tap unmount the modal while the send is in flight —
  // that hides the result (incl. the "created but not delivered" path) and can
  // leave the operator unsure whether the invoice/term were created.
  const requestClose = () => { if (!saving) onClose?.(); };

  // When the caller didn't pass a monthly rate (the completion screen has no
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

  async function handleSend() {
    if (!cid) { setError('Missing customer for this visit'); return; }
    if (!Number.isFinite(amt) || amt <= 0) { setError('Enter a valid amount'); return; }
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const result = await adminFetch(`/admin/customers/${cid}/annual-prepay-invoice`, {
        method: 'POST',
        body: JSON.stringify({
          amount: amt,
          serviceType: serviceType.trim() || undefined,
          visitCount,
          cadence,
          termStart: tomorrowDateString(),
        }),
      });
      // The route returns 201 even when SMS/email delivery fails — the invoice +
      // term exist but no pay link reached the customer. Don't report success:
      // tell the operator to resend it from the customer's invoices.
      if (result?.delivery && result.delivery.ok === false) {
        setNote(
          `Prepay invoice ${result.invoice?.invoice_number || ''} was created, but the pay link couldn’t be delivered`
          + `${result.delivery.error ? ` (${result.delivery.error})` : ''}. Resend it from the customer’s invoices.`,
        );
        setSaving(false);
        return;
      }
      onSent?.({ sent: true, ...result });
    } catch (e) {
      setError(e.message || 'Failed to create the prepayment');
      setSaving(false);
    }
  }

  return (
    <div
      onClick={requestClose}
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
            onClick={requestClose}
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
            ${amt.toFixed(2)} ÷ {visitCount} visits ≈ ${perVisit.toFixed(2)} per visit. Covers a 12-month term
            starting after today’s visit; paying activates the coverage and marks those visits prepaid.
          </div>
        )}

        {note && (
          <div
            className="border border-hairline border-zinc-200 rounded-lg bg-zinc-50 text-ink-secondary"
            style={{ fontSize: 13, padding: 12, marginBottom: 12 }}
          >
            {note}
          </div>
        )}
        {error && (
          <div className="text-alert-fg" style={{ fontSize: 13, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={note ? onClose : handleSend}
          disabled={saving}
          className="w-full rounded-full bg-zinc-900 text-white font-medium u-focus-ring"
          style={{ padding: '14px 20px', fontSize: 15, opacity: saving ? 0.6 : 1 }}
        >
          {saving ? 'Sending…' : note ? 'Done' : 'Send prepay invoice with report'}
        </button>
      </div>
    </div>
  );
}
