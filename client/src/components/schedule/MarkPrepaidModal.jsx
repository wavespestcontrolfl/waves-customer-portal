// Small modal for recording that a visit was paid in advance (cash, Zelle,
// phone CC, etc.). On submit → POST /admin/schedule/:id/prepaid. Once set,
// the completion handler will skip auto-invoicing and send a "thanks for
// your payment" SMS instead of a pay-link SMS.
//
// Mobile-first layout — stays inside the admin V2 system (Tailwind zinc ramp).

import { useState } from 'react';
import { useFeatureFlag } from '../../hooks/useFeatureFlag';

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

function serviceDisplayName(service) {
  return service?.serviceTypeDisplay || service?.serviceType || 'Service';
}

// True when this appointment is part of a recurring family — either it's a
// template parent (`isRecurring`) or a spawned child (`recurringParentId`).
// The "Apply to entire series" toggle only shows up in those cases; one-off
// visits don't have anything to fan out to.
function serviceIsPartOfSeries(service) {
  return !!(service?.isRecurring || service?.recurringParentId || service?.recurring_parent_id);
}

function patternLabel(pattern) {
  if (!pattern) return 'recurring plan';
  const p = String(pattern).toLowerCase();
  if (p === 'monthly') return 'monthly plan';
  if (p === 'quarterly') return 'quarterly plan';
  if (p === 'biweekly' || p === 'bi-weekly') return 'bi-weekly plan';
  if (p === 'weekly') return 'weekly plan';
  if (p === 'annual' || p === 'yearly') return 'annual plan';
  return `${p} plan`;
}

// Friendly copy for when a prepayment was recorded but no receipt was sent. The
// prepayment always saves; this only explains why the optional receipt didn't go.
const RECEIPT_REASON_TEXT = {
  disabled: 'Receipt sending isn’t enabled yet — the prepayment was still recorded.',
  series_unsupported:
    'For a whole plan, receipts go out with each visit rather than as one — the prepayment was recorded.',
  no_chargeable_amount:
    'This visit has no price set, so there was nothing to receipt — the prepayment was recorded.',
  not_paid_in_full:
    'The amount received doesn’t cover this visit in full, so no receipt was sent — the prepayment was recorded.',
  payer_billed:
    'This visit is billed to a third-party payer, so no homeowner receipt was sent — the prepayment was recorded.',
  send_failed:
    'The prepayment was recorded, but the receipt couldn’t be sent just now. You can resend it from the invoice.',
  error: 'The prepayment was recorded, but the receipt couldn’t be sent just now.',
};
function receiptReasonText(receipt) {
  const base = RECEIPT_REASON_TEXT[receipt?.reason]
    || 'The prepayment was recorded, but no receipt was sent.';
  if (receipt?.reason === 'not_paid_in_full' && receipt?.balance != null) {
    return `${base} Balance remaining: $${Number(receipt.balance).toFixed(2)}.`;
  }
  return base;
}

// Default visit count used to seed the plan-total field when the operator
// opens the modal on a recurring child. The server fans the input across the
// ACTUAL sibling count when it saves — this is just a best-guess pre-fill.
const DEFAULT_SERIES_VISIT_GUESS = 4;

export default function MarkPrepaidModal({ service, onClose, onSaved }) {
  const isSeries = serviceIsPartOfSeries(service);
  // True when we're editing an existing prepayment (operator tapped "Edit" on
  // the green banner) rather than recording a fresh one. The modal becomes a
  // round-trip view of the saved state instead of overwriting it with
  // estimatedPrice/cash defaults on first save.
  const existingPerVisit = service?.prepaidAmount != null && Number(service.prepaidAmount) > 0
    ? Number(service.prepaidAmount)
    : null;
  const existingSeriesTotal = service?.prepaidSeriesContext?.seriesTotal != null
    && service?.prepaidSeriesContext?.totalCoveredVisits > 1
    ? Number(service.prepaidSeriesContext.seriesTotal)
    : null;
  const isExistingSeries = existingSeriesTotal != null;
  const isExistingPrepayment = existingPerVisit != null;

  // applyToSeries default: keep an existing series prepayment in series mode;
  // an existing single-visit prepayment stays single-visit; otherwise fall
  // back to the recurring-family heuristic from #1059.
  const [applyToSeries, setApplyToSeries] = useState(
    isExistingSeries ? true : isExistingPrepayment ? false : isSeries,
  );

  // Amount default: editing a recorded prepayment prefills the saved figure
  // (series total when applicable so the operator sees the dollars they
  // actually collected, not a recomputed per-visit slice).
  const [amount, setAmount] = useState(() => {
    if (isExistingSeries) return String(existingSeriesTotal);
    if (isExistingPrepayment) return String(existingPerVisit);
    const p = Number(service?.estimatedPrice);
    if (!Number.isFinite(p) || p <= 0) return '';
    return String(isSeries ? p * DEFAULT_SERIES_VISIT_GUESS : p);
  });
  const [method, setMethod] = useState(() => service?.prepaidMethod || 'cash');
  const [note, setNote] = useState(() => service?.prepaidNote || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Optional "email a paid receipt" — single visit only, gated behind the
  // prepaid-receipt flag (fails closed). Default on; hidden in series mode.
  const receiptFlag = useFeatureFlag('prepaid-receipt');
  const [emailReceipt, setEmailReceipt] = useState(true);
  const [receiptNote, setReceiptNote] = useState(null);
  const [savedWithNote, setSavedWithNote] = useState(false);

  // When the operator flips between "this visit" and "the whole plan" we
  // re-seed the amount field so they don't have to clear it manually — single
  // visit pre-fills the per-visit price, series pre-fills the same default
  // best-guess as the initial render. They can always override.
  function toggleApplyToSeries(next) {
    setApplyToSeries(next);
    const perVisit = Number(service?.estimatedPrice || 0);
    if (!Number.isFinite(perVisit) || perVisit <= 0) return;
    setAmount(next ? String(perVisit * DEFAULT_SERIES_VISIT_GUESS) : String(perVisit));
  }

  const amt = parseFloat(amount);
  const previewVisits = applyToSeries ? DEFAULT_SERIES_VISIT_GUESS : 1; // best-guess; server fans to actual count
  const previewPerVisit = Number.isFinite(amt) && previewVisits > 0
    ? Math.round((amt / previewVisits) * 100) / 100
    : 0;

  const wantsReceipt = receiptFlag && !applyToSeries && emailReceipt;

  async function handleSave() {
    if (!Number.isFinite(amt) || amt < 0) {
      setError('Enter a valid amount');
      return;
    }
    setSaving(true);
    setError(null);
    setReceiptNote(null);
    try {
      const result = await adminFetch(`/admin/schedule/${service.id}/prepaid`, {
        method: 'POST',
        body: JSON.stringify({
          amount: amt,
          method,
          note: note.trim() || null,
          applyToSeries: applyToSeries || undefined,
          emailReceipt: wantsReceipt || undefined,
        }),
      });
      // The prepayment saved. If a receipt was requested but didn't go out,
      // keep the modal open to explain why; dismissing still refreshes the list.
      if (wantsReceipt && result?.receipt && !result.receipt.sent) {
        setReceiptNote(receiptReasonText(result.receipt));
        setSavedWithNote(true);
        setSaving(false);
        return;
      }
      onSaved?.();
    } catch (e) {
      setError(e.message || 'Failed to save');
      setSaving(false);
    }
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
        <div
          className="flex items-start justify-between"
          style={{ marginBottom: 16 }}
        >
          <div>
            <div
              className="font-medium text-zinc-900"
              style={{ fontSize: 18 }}
            >
              {isExistingPrepayment ? 'Edit prepayment' : 'Mark prepaid'}
            </div>
            <div
              className="text-ink-secondary"
              style={{ fontSize: 13, marginTop: 2 }}
            >
              {service.customerName} — {serviceDisplayName(service)}
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

        {isSeries && (
          <label
            className="flex items-start gap-3 border border-hairline border-zinc-200 rounded-lg bg-zinc-50 cursor-pointer"
            style={{ padding: 12, marginBottom: 14 }}
          >
            <input
              type="checkbox"
              checked={applyToSeries}
              onChange={(e) => toggleApplyToSeries(e.target.checked)}
              className="mt-1"
              style={{ width: 16, height: 16, accentColor: '#18181B' }}
            />
            <div className="flex-1 min-w-0">
              <div className="text-zinc-900 font-medium" style={{ fontSize: 14 }}>
                Apply to entire {patternLabel(service?.recurringPattern || service?.recurring_pattern)}
              </div>
              <div className="text-ink-secondary" style={{ fontSize: 12, marginTop: 2 }}>
                {applyToSeries
                  ? `Splits the total evenly across every upcoming visit in this series so future appointments show "paid in full."`
                  : `Only marks this visit as prepaid.`}
              </div>
            </div>
          </label>
        )}

        <label
          className="block uppercase tracking-label text-ink-secondary font-medium"
          style={{ fontSize: 11, marginBottom: 6 }}
        >
          {applyToSeries ? 'Total received for the plan' : 'Amount received'}
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
        {applyToSeries && previewPerVisit > 0 && (
          <div
            className="text-ink-secondary"
            style={{ fontSize: 12, marginTop: -6, marginBottom: 14 }}
          >
            Splits to about ${previewPerVisit.toFixed(2)} per visit. Actual visit
            count is read from the recurring series when you save.
          </div>
        )}

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

        {receiptFlag && !applyToSeries && (
          <label
            className="flex items-start gap-3 border border-hairline border-zinc-200 rounded-lg bg-zinc-50 cursor-pointer"
            style={{ padding: 12, marginBottom: 14 }}
          >
            <input
              type="checkbox"
              checked={emailReceipt}
              onChange={(e) => setEmailReceipt(e.target.checked)}
              className="mt-1"
              style={{ width: 16, height: 16, accentColor: '#18181B' }}
            />
            <div className="flex-1 min-w-0">
              <div className="text-zinc-900 font-medium" style={{ fontSize: 14 }}>
                Email a paid receipt to the customer
              </div>
              <div className="text-ink-secondary" style={{ fontSize: 12, marginTop: 2 }}>
                Emails and texts a receipt once the prepayment covers this visit in full.
              </div>
            </div>
          </label>
        )}

        {receiptNote && (
          <div
            className="border border-hairline border-zinc-200 rounded-lg bg-zinc-50 text-ink-secondary"
            style={{ fontSize: 13, padding: 12, marginBottom: 12 }}
          >
            {receiptNote}
          </div>
        )}

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
          onClick={savedWithNote ? () => onSaved?.() : handleSave}
          disabled={saving}
          className="w-full rounded-full bg-zinc-900 text-white font-medium u-focus-ring"
          style={{ padding: '14px 20px', fontSize: 15, opacity: saving ? 0.6 : 1 }}
        >
          {saving ? 'Saving…' : savedWithNote ? 'Done' : isExistingPrepayment ? 'Save changes' : 'Save prepayment'}
        </button>
      </div>
    </div>
  );
}
