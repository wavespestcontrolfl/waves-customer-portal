// Mobile-only detail sheet shown when a user taps an appointment row in the
// MobileDispatchList. Matches IMG_3726 layout: Review & checkout CTA at top,
// then Customer / Services & items / Date & time sections.
//
// Review & checkout → opens MobileCheckoutSheet (Square-style pricing review
// → MobilePaymentSheet → Tap to Pay / Cash / etc.).
// Edit (top-right) → opens EditServiceModal (existing V1).

import { TIMEZONE } from '../../lib/timezone';

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
}) {
  if (!service) return null;

  const tier = service.waveguardTier ? String(service.waveguardTier).toLowerCase() : null;
  const pct = tier && TIER_DISCOUNT[tier] != null ? TIER_DISCOUNT[tier] : 0;
  const rawPrice = service.estimatedPrice != null ? Number(service.estimatedPrice) : null;
  const price = rawPrice != null ? rawPrice : Number(service.monthlyRate || 0);
  const discount = Math.round(price * pct * 100) / 100;
  const total = Math.max(0, price - discount);
  const timeWindow = formatWindow(service);

  // WaveGuard monthly autopay customers have estimated_price = 0 on each visit
  // (already paid via the monthly cycle). Surface this so the tech sees why
  // the CTA says "Complete visit" instead of "Review & checkout."
  const coveredByMembership = !!tier && (rawPrice === 0 || rawPrice == null);
  const prepaidAmt = service.prepaidAmount != null ? Number(service.prepaidAmount) : null;
  const isPrepaid = prepaidAmt != null && prepaidAmt > 0;

  return (
    <div className="fixed inset-0 z-50 bg-white overflow-y-auto">
      {/* Top bar: back · centered name+phone · edit (⋯) */}
      <div
        className="sticky top-0 bg-white flex items-center px-3"
        style={{ height: 64, paddingTop: 'env(safe-area-inset-top, 0)' }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Back"
          className="flex items-center justify-center rounded-full bg-zinc-100 u-focus-ring"
          style={{ width: 36, height: 36, fontSize: 20, lineHeight: 1 }}
        >
          ←
        </button>
        <div
          className="flex-1 min-w-0 text-center px-3"
          style={{ lineHeight: 1.2 }}
        >
          <div
            className="font-semibold text-zinc-900 truncate"
            style={{ fontSize: 17 }}
          >
            {service.customerName || 'Appointment'}
          </div>
          {service.customerPhone && (
            <div
              className="text-ink-secondary truncate"
              style={{ fontSize: 13, marginTop: 1 }}
            >
              {service.customerPhone}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => onEdit?.(service)}
          aria-label="Edit"
          className="flex items-center justify-center rounded-full bg-zinc-100 u-focus-ring"
          style={{ width: 36, height: 36, fontSize: 18, lineHeight: 1 }}
        >
          ⋯
        </button>
      </div>

      <div className="px-4 pt-2 pb-10 mx-auto" style={{ maxWidth: 560 }}>
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
