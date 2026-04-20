// Mobile-only detail sheet shown when a user taps an appointment row in the
// MobileDispatchList. Matches IMG_3675 layout: Review & checkout CTA at top,
// then Customer / Services & items / Date & time sections.
//
// Review & checkout → opens CompletionPanel (tech notes + AI recap live there).
// Edit (top-right) → opens EditServiceModal (existing V1).

import { useState } from 'react';
import { TIMEZONE } from '../../lib/timezone';
import { launchTapToPay } from '../../lib/tapToPay';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// WaveGuard tier → discount fraction. Source: server/services/estimate-converter.js.
// Kept in sync with that file. Used only for display here; the authoritative
// invoice amount is computed server-side on completion.
const TIER_DISCOUNT = {
  bronze: 0,
  silver: 0.10,
  gold: 0.15,
  platinum: 0.18,
};

function tierLabel(t) {
  if (!t) return '';
  const s = String(t).toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatDateLong(dateStr) {
  if (!dateStr) return '';
  const iso = String(dateStr).split('T')[0];
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', {
    timeZone: TIMEZONE,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatTime(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return '';
  const m = hhmm.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const h24 = parseInt(m[1], 10);
  const mm = m[2];
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ap = h24 < 12 ? 'AM' : 'PM';
  return `${h12}:${mm} ${ap}`;
}

function formatWindow(svc) {
  const s = formatTime(svc.windowStart);
  const e = formatTime(svc.windowEnd);
  if (!s) return svc.windowDisplay || '';
  if (!e) return s;
  return `${s} – ${e}`;
}

export default function MobileAppointmentDetailSheet({
  service,
  onClose,
  onEdit,
  onReviewCheckout,
  onMarkPrepaid,
}) {
  const [charging, setCharging] = useState(false);
  const [chargeError, setChargeError] = useState(null);

  if (!service) return null;

  const tier = service.waveguardTier ? String(service.waveguardTier).toLowerCase() : null;
  const pct = tier && TIER_DISCOUNT[tier] != null ? TIER_DISCOUNT[tier] : 0;
  const rawPrice = service.estimatedPrice != null ? Number(service.estimatedPrice) : null;
  const price = rawPrice != null ? rawPrice : Number(service.monthlyRate || 0);
  const discount = Math.round(price * pct * 100) / 100;
  const total = Math.max(0, price - discount);
  const timeWindow = formatWindow(service);

  // WaveGuard monthly autopay customers have estimated_price = 0 on each visit
  // (already paid via the monthly cycle). Surface this so the tech doesn't try
  // to charge them again at the door.
  const coveredByMembership = !!tier && (rawPrice === 0 || rawPrice == null);
  const prepaidAmt = service.prepaidAmount != null ? Number(service.prepaidAmount) : null;
  const isPrepaid = prepaidAmt != null && prepaidAmt > 0;

  // Mints an invoice for this visit pre-completion, then hands off to the
  // Stripe Terminal / Tap-to-Pay iOS shell via a signed handoff JWT so the
  // tech can charge the card at the door before finishing the service report.
  // The completion handler will later reuse this invoice rather than cutting
  // a second one.
  async function handleChargeNow() {
    if (charging) return;
    setCharging(true);
    setChargeError(null);
    try {
      const r = await fetch(`${API_BASE}/admin/schedule/${service.id}/invoice`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
        },
      });
      if (!r.ok) throw new Error(await r.text().catch(() => `${r.status}`));
      const data = await r.json();
      if (!data.invoiceId) throw new Error('No invoice returned');
      await launchTapToPay(data.invoiceId);
    } catch (e) {
      setChargeError(e.message || 'Failed to start charge');
      setCharging(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-white overflow-y-auto">
      {/* Top bar: close + edit */}
      <div
        className="sticky top-0 bg-white border-b border-hairline border-zinc-200 flex items-center justify-between px-3"
        style={{ height: 56 }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex items-center justify-center rounded-full bg-zinc-100 u-focus-ring"
          style={{ width: 36, height: 36, fontSize: 18, lineHeight: 1 }}
        >
          ×
        </button>
        <button
          type="button"
          onClick={() => onEdit?.(service)}
          className="rounded-full bg-zinc-900 text-white font-medium u-focus-ring"
          style={{ padding: '8px 20px', fontSize: 14 }}
        >
          Edit
        </button>
      </div>

      <div className="px-4 pt-4 pb-10 mx-auto" style={{ maxWidth: 560 }}>
        {/* Review & checkout */}
        <button
          type="button"
          onClick={() => onReviewCheckout?.(service)}
          className="w-full rounded-full bg-zinc-900 text-white font-medium u-focus-ring"
          style={{ padding: '14px 20px', fontSize: 16 }}
        >
          {coveredByMembership || isPrepaid ? 'Complete visit' : 'Review & checkout'}
        </button>
        {coveredByMembership && !isPrepaid && (
          <div
            className="text-ink-secondary"
            style={{ fontSize: 12, marginTop: 8, textAlign: 'center' }}
          >
            Covered by WaveGuard {tierLabel(tier)} — no charge needed
          </div>
        )}
        {isPrepaid && (
          <div
            className="text-ink-secondary"
            style={{ fontSize: 12, marginTop: 8, textAlign: 'center' }}
          >
            Prepaid ${prepaidAmt.toFixed(2)}
            {service.prepaidMethod ? ` via ${service.prepaidMethod.replace(/_/g, ' ')}` : ''} — no charge needed
          </div>
        )}

        {/* Charge now — mint invoice + launch Tap-to-Pay BEFORE completion.
            Lets the tech take payment at the door, then finish the report later. */}
        {!coveredByMembership && !isPrepaid && (
          <button
            type="button"
            onClick={handleChargeNow}
            disabled={charging}
            className="w-full rounded-full bg-zinc-100 text-zinc-900 font-medium u-focus-ring"
            style={{ padding: '12px 20px', fontSize: 14, marginTop: 10, opacity: charging ? 0.6 : 1 }}
          >
            {charging ? 'Opening Tap to Pay…' : `Charge now (${total > 0 ? `$${total.toFixed(2)}` : 'Tap to Pay'})`}
          </button>
        )}
        {chargeError && (
          <div
            className="text-alert-fg"
            style={{ fontSize: 12, marginTop: 6, textAlign: 'center' }}
          >
            {chargeError}
          </div>
        )}

        {/* Mark prepaid — only show when not already prepaid and not WG-covered */}
        {!coveredByMembership && !isPrepaid && (
          <button
            type="button"
            onClick={() => onMarkPrepaid?.(service)}
            className="w-full rounded-full bg-zinc-100 text-zinc-900 font-medium u-focus-ring"
            style={{ padding: '12px 20px', fontSize: 14, marginTop: 10 }}
          >
            Mark prepaid (cash · Zelle · phone CC)
          </button>
        )}

        {/* Customer */}
        <section className="mt-8">
          <div
            className="font-medium text-zinc-900"
            style={{ fontSize: 20, marginBottom: 10 }}
          >
            Customer
          </div>
          <div
            className="py-3 border-b border-hairline border-zinc-200"
          >
            <div
              className="font-medium text-zinc-900"
              style={{ fontSize: 15 }}
            >
              {service.customerName || 'Unassigned'}
            </div>
            <div
              className="text-ink-secondary"
              style={{ fontSize: 13, marginTop: 2 }}
            >
              {service.customerPhone || '—'}
            </div>
          </div>
        </section>

        {/* Services and items */}
        <section className="mt-8">
          <div
            className="font-medium text-zinc-900"
            style={{ fontSize: 20, marginBottom: 10 }}
          >
            Services and items
          </div>
          <div
            className="py-3 border-b border-hairline border-zinc-200 flex items-start justify-between gap-3"
          >
            <div className="flex-1 min-w-0">
              <div
                className="font-medium text-zinc-900"
                style={{ fontSize: 15 }}
              >
                {service.serviceType || '—'}
              </div>
              <div
                className="text-ink-secondary"
                style={{ fontSize: 13, marginTop: 2 }}
              >
                {timeWindow}
                {service.estimatedDuration ? (timeWindow ? ' · ' : '') + `${service.estimatedDuration} mins` : ''}
              </div>
            </div>
            <div
              className="u-nums text-zinc-900 font-medium"
              style={{ fontSize: 15 }}
            >
              ${price.toFixed(2)}
            </div>
          </div>

          {pct > 0 && (
            <div className="py-3 border-b border-hairline border-zinc-200 flex items-center justify-between">
              <span className="text-zinc-900" style={{ fontSize: 14 }}>
                WaveGuard {tierLabel(tier)} Discount ({Math.round(pct * 100)}%)
              </span>
              <span className="u-nums text-zinc-900" style={{ fontSize: 14 }}>
                −${discount.toFixed(2)}
              </span>
            </div>
          )}

          <div className="py-3 flex items-center justify-between">
            <span className="font-medium text-zinc-900" style={{ fontSize: 16 }}>
              Total
            </span>
            <span className="u-nums font-medium text-zinc-900" style={{ fontSize: 16 }}>
              ${total.toFixed(2)}
            </span>
          </div>
        </section>

        {/* Date and time */}
        <section className="mt-8">
          <div
            className="font-medium text-zinc-900"
            style={{ fontSize: 20, marginBottom: 10 }}
          >
            Date and time
          </div>
          <div className="text-zinc-900" style={{ fontSize: 14 }}>
            {formatDateLong(service.scheduledDate)}
          </div>
          {timeWindow && (
            <div
              className="text-ink-secondary"
              style={{ fontSize: 14, marginTop: 2 }}
            >
              {timeWindow}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
