// Mobile-only detail sheet shown when a user taps an appointment row in the
// MobileDispatchList. Matches IMG_3675 layout: Review & checkout CTA at top,
// then Customer / Services & items / Date & time sections.
//
// Review & checkout → opens CompletionPanel (tech notes + AI recap live there).
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
  const price = Number(service.estimatedPrice || service.monthlyRate || 0);
  const discount = Math.round(price * pct * 100) / 100;
  const total = Math.max(0, price - discount);
  const window = formatWindow(service);

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
          Review &amp; checkout
        </button>

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
                {window}
                {service.estimatedDuration ? (window ? ' · ' : '') + `${service.estimatedDuration} mins` : ''}
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
          {window && (
            <div
              className="text-ink-secondary"
              style={{ fontSize: 14, marginTop: 2 }}
            >
              {window}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
