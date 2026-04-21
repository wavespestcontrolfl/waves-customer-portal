// Check Out Appointment — mobile-only, full-screen sheet opened from
// MobileAppointmentDetailSheet's "Review & checkout" CTA. Square-style
// layout per IMG_3729: Charge button up top, service line items below,
// Add Service / Add Item or Discount buttons at the bottom.
//
// "Charge" mints an invoice via /admin/schedule/:id/invoice and hands
// the invoice id + total to MobilePaymentSheet, which picks the payment
// method. Service-line edit (tap a row) is stubbed here — PR 2 adds the
// dedicated edit modal.

import { X, Tag } from 'lucide-react';
import { useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

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

export default function MobileCheckoutSheet({
  service,
  onClose,
  onChargeSuccess,
  onEditServiceLine,
  onAddService,
  onAddItem,
}) {
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState(null);

  if (!service) return null;

  const tier = service.waveguardTier ? String(service.waveguardTier).toLowerCase() : null;
  const pct = tier && TIER_DISCOUNT[tier] != null ? TIER_DISCOUNT[tier] : 0;
  const rawPrice = service.estimatedPrice != null ? Number(service.estimatedPrice) : null;
  const price = rawPrice != null ? rawPrice : Number(service.monthlyRate || 0);
  const discount = Math.round(price * pct * 100) / 100;
  const total = Math.max(0, price - discount);

  const startTime = formatTime(service.windowStart);
  const duration = service.estimatedDuration ? `${service.estimatedDuration} mins` : '';
  const timeSubtitle = [startTime, duration].filter(Boolean).join(' · ');

  const billingSubtitle = tier
    ? `WaveGuard ${tierLabel(tier)} | Monthly autopay`
    : 'Single visit';

  async function handleCharge() {
    if (minting) return;
    setMinting(true);
    setMintError(null);
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
      if (!data.invoiceId) throw new Error('No invoice id returned');
      onChargeSuccess?.({ service, invoiceId: data.invoiceId, amount: total });
    } catch (e) {
      setMintError(e.message || 'Failed to create invoice');
      setMinting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[55] bg-white overflow-y-auto md:hidden">
      {/* Header */}
      <div
        className="sticky top-0 bg-white border-b border-hairline border-zinc-200 flex items-center px-3"
        style={{ height: 56, paddingTop: 'env(safe-area-inset-top, 0)' }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex items-center justify-center h-11 w-11 u-focus-ring text-zinc-900"
        >
          <X size={22} strokeWidth={1.75} />
        </button>
        <div
          className="flex-1 text-center font-medium text-zinc-900"
          style={{ fontSize: 16 }}
        >
          Check Out Appointment
        </div>
        <div className="w-11" />
      </div>

      <div className="px-4 pt-5 pb-10 mx-auto" style={{ maxWidth: 560 }}>
        {/* Primary Charge CTA */}
        <button
          type="button"
          onClick={handleCharge}
          disabled={minting}
          className="w-full bg-zinc-900 text-white font-medium rounded-xs u-focus-ring"
          style={{ padding: '16px 20px', fontSize: 16, opacity: minting ? 0.6 : 1 }}
        >
          {minting ? 'Opening payment…' : `Charge $${total.toFixed(2)}`}
        </button>
        <div
          className="text-center text-ink-tertiary"
          style={{ fontSize: 12, marginTop: 8 }}
        >
          Card surcharge of 3% may apply.
        </div>
        {mintError && (
          <div
            className="text-center text-alert-fg"
            style={{ fontSize: 12, marginTop: 6 }}
          >
            {mintError}
          </div>
        )}
        <div
          className="text-center text-ink-secondary"
          style={{ fontSize: 13, marginTop: 14, lineHeight: 1.4 }}
        >
          Finalize the price for each of your services and add
          <br />
          any additional products or discounts.
        </div>

        {/* Service line items */}
        <div className="mt-6">
          <button
            type="button"
            onClick={() => onEditServiceLine?.(service)}
            className="w-full flex items-start justify-between gap-3 py-4 border-b border-hairline border-zinc-200 text-left u-focus-ring"
          >
            <div className="flex-1 min-w-0 pr-2">
              <div className="flex items-center gap-1.5">
                <span
                  className="font-medium text-blue-600 truncate"
                  style={{ fontSize: 15 }}
                >
                  {service.serviceType || 'General Service'}
                </span>
                <Tag size={14} className="text-zinc-400 shrink-0" strokeWidth={1.5} />
              </div>
              <div
                className="text-ink-tertiary truncate"
                style={{ fontSize: 12, marginTop: 2 }}
              >
                {billingSubtitle}
              </div>
              {timeSubtitle && (
                <div
                  className="text-ink-tertiary u-nums"
                  style={{ fontSize: 12, marginTop: 1 }}
                >
                  {timeSubtitle}
                </div>
              )}
            </div>
            <div
              className="u-nums text-zinc-900 font-medium shrink-0"
              style={{ fontSize: 15 }}
            >
              ${price.toFixed(0)}
            </div>
          </button>

          {pct > 0 && (
            <div className="flex items-center justify-between py-4 border-b border-hairline border-zinc-200">
              <span
                className="font-medium text-blue-600"
                style={{ fontSize: 15 }}
              >
                {pct === TIER_DISCOUNT.silver ? 'Silver' : tierLabel(tier)} Discount
              </span>
              <span className="u-nums text-zinc-900" style={{ fontSize: 15 }}>
                −${discount.toFixed(2)}
              </span>
            </div>
          )}

          <div className="flex items-center justify-between py-4">
            <span className="text-zinc-900" style={{ fontSize: 15 }}>
              Total
            </span>
            <span className="u-nums text-zinc-900" style={{ fontSize: 15 }}>
              ${total.toFixed(2)}
            </span>
          </div>
        </div>

        {/* Add Service / Add Item or Discount */}
        <div className="mt-4 space-y-3">
          <button
            type="button"
            onClick={onAddService}
            className="w-full bg-zinc-100 text-zinc-900 font-medium rounded-xs u-focus-ring"
            style={{ padding: '14px 20px', fontSize: 15 }}
          >
            Add Service
          </button>
          <button
            type="button"
            onClick={onAddItem}
            className="w-full bg-zinc-100 text-zinc-900 font-medium rounded-xs u-focus-ring"
            style={{ padding: '14px 20px', fontSize: 15 }}
          >
            Add Item or Discount
          </button>
        </div>
      </div>
    </div>
  );
}
