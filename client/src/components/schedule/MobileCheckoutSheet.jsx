// Check Out Appointment — mobile-only, full-screen sheet opened from
// MobileAppointmentDetailSheet's "Review & checkout" CTA. Square-style
// layout per IMG_3729: Charge button up top, service line items below,
// Add Service / Add Item or Discount buttons at the bottom.
//
// "Charge" mints an invoice via POST /admin/schedule/:id/invoice and hands
// the invoice id + total to MobilePaymentSheet, which picks the payment
// method. Added services + discounts are sent as extraLineItems in the
// request body (negative amounts for discounts).
//
// Audit focus:
// - Discount math — TIER_DISCOUNT values are duplicated client-side from
//   the server's WaveGuard tier table. Worth confirming this stays in
//   sync with server/services/pricing-engine/constants.js (or refactor
//   to fetch from the server).
// - Charge → invoice → payment handoff: the invoice id + total are
//   passed to MobilePaymentSheet via parent state. Confirm the parent
//   doesn't allow re-clicking "Charge" before the first invoice POST
//   resolves (would create duplicate invoices).
// - extraLineItems shape: discounts go in as negative amounts. Server
//   should validate sign + cap; verify there's no client path that
//   could submit an unbounded negative discount.
// - Mobile sheet stack: this sheet opens MobileServicePickerSheet and
//   MobileItemDiscountPickerSheet as child sheets. Dismiss / re-open /
//   ESC behavior should restore the parent's scroll position and not
//   leak focus.

import { X, Tag } from 'lucide-react';
import { useMemo, useState } from 'react';
import MobileServicePickerSheet from './MobileServicePickerSheet';
import MobileItemDiscountPickerSheet from './MobileItemDiscountPickerSheet';

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

// Generate a short client-side id for tracking added rows.
let _uid = 0;
const uid = () => `ex_${Date.now()}_${++_uid}`;

export default function MobileCheckoutSheet({
  service,
  onClose,
  onChargeSuccess,
  onEditServiceLine,
}) {
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState(null);
  const [extras, setExtras] = useState([]);
  // { id, description, unit_price, quantity, amount, _kind }
  //   _kind is 'service' | 'discount' (UI label only — server treats uniformly)
  const [showServicePicker, setShowServicePicker] = useState(false);
  const [showItemPicker, setShowItemPicker] = useState(false);

  if (!service) return null;

  const tier = service.waveguardTier ? String(service.waveguardTier).toLowerCase() : null;
  const pct = tier && TIER_DISCOUNT[tier] != null ? TIER_DISCOUNT[tier] : 0;
  const rawPrice = service.estimatedPrice != null ? Number(service.estimatedPrice) : null;
  const price = rawPrice != null ? rawPrice : Number(service.monthlyRate || 0);

  // Separate extras: positive-amount services vs negative-amount discounts.
  // Tier discount applies only to services subtotal (base + positive extras)
  // to match the server-side DiscountEngine behavior for WaveGuard tiers.
  const { extraServicesTotal, extraDiscountsTotal } = useMemo(() => {
    let s = 0, d = 0;
    for (const e of extras) {
      if (Number(e.amount) >= 0) s += Number(e.amount);
      else d += Number(e.amount);
    }
    return { extraServicesTotal: s, extraDiscountsTotal: d };
  }, [extras]);

  const servicesSubtotal = price + extraServicesTotal;
  const tierDiscountAmt = Math.round(servicesSubtotal * pct * 100) / 100;
  const total = Math.max(0, servicesSubtotal - tierDiscountAmt + extraDiscountsTotal);

  const startTime = formatTime(service.windowStart);
  const duration = service.estimatedDuration ? `${service.estimatedDuration} mins` : '';
  const timeSubtitle = [startTime, duration].filter(Boolean).join(' · ');
  const billingSubtitle = tier
    ? `WaveGuard ${tierLabel(tier)} | Monthly autopay`
    : 'Single visit';

  const handleAddService = (svc) => {
    setShowServicePicker(false);
    const isVariable = svc.pricing_type === 'variable' || svc.pricing_type === 'quoted' || !(Number(svc.base_price) > 0);
    let unitPrice = Number(svc.base_price || 0);
    if (isVariable) {
      const input = window.prompt(`Price for ${svc.name}:`, unitPrice > 0 ? String(unitPrice) : '0');
      if (input == null) return;
      const n = Number(input);
      if (!Number.isFinite(n) || n <= 0) return;
      unitPrice = n;
    }
    setExtras((prev) => [...prev, {
      id: uid(),
      _kind: 'service',
      description: svc.name,
      quantity: 1,
      unit_price: unitPrice,
      amount: unitPrice,
      category: svc.category || null,
    }]);
  };

  const handleAddItem = (payload) => {
    setShowItemPicker(false);
    if (!payload) return;
    if (payload.kind === 'custom_amount') {
      setExtras((prev) => [...prev, {
        id: uid(),
        _kind: payload.amount < 0 ? 'discount' : 'service',
        description: payload.label || 'Custom Item',
        quantity: 1,
        unit_price: payload.amount,
        amount: payload.amount,
      }]);
      return;
    }
    // Discount (library row OR custom_discount)
    const d = payload.kind === 'discount' ? payload.discount : payload;
    const amt = Number(d.amount || 0);
    if (!amt) return;
    const isPercent = d.discount_type === 'percentage' || d.discount_type === 'variable_percentage';
    // Percentage applies to the current services subtotal (base + positive extras).
    // Snapshot at add-time so edits after feel deterministic.
    const dollarOff = isPercent
      ? Math.round(servicesSubtotal * (amt / 100) * 100) / 100
      : amt;
    const label = payload.kind === 'custom_discount'
      ? (isPercent ? `Custom Discount (${amt}%)` : 'Custom Discount')
      : (d.name || 'Discount');
    setExtras((prev) => [...prev, {
      id: uid(),
      _kind: 'discount',
      description: isPercent ? `${label} (${amt}%)` : label,
      quantity: 1,
      unit_price: -dollarOff,
      amount: -dollarOff,
    }]);
  };

  const removeExtra = (id) => setExtras((prev) => prev.filter((e) => e.id !== id));

  async function handleCharge() {
    if (minting) return;
    setMinting(true);
    setMintError(null);
    try {
      const body = {
        extraLineItems: extras.map(({ _kind: _k, id: _i, ...rest }) => rest), // eslint-disable-line no-unused-vars
      };
      const r = await fetch(`${API_BASE}/admin/schedule/${service.id}/invoice`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text().catch(() => `${r.status}`));
      const data = await r.json();
      if (!data.invoiceId) throw new Error('No invoice id returned');
      onChargeSuccess?.({ service, invoiceId: data.invoiceId, invoiceToken: data.token, amount: total });
    } catch (e) {
      setMintError(e.message || 'Failed to create invoice');
      setMinting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[105] bg-white overflow-y-auto md:hidden">
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
        <div className="flex-1 text-center font-medium text-zinc-900" style={{ fontSize: 16 }}>
          Check Out Appointment
        </div>
        <div className="w-11" />
      </div>

      <div className="px-4 pt-5 pb-10 mx-auto" style={{ maxWidth: 560 }}>
        <button
          type="button"
          onClick={handleCharge}
          disabled={minting}
          className="w-full bg-zinc-900 text-white font-medium rounded-xs u-focus-ring"
          style={{ padding: '16px 20px', fontSize: 16, opacity: minting ? 0.6 : 1 }}
        >
          {minting ? 'Opening payment…' : `Charge $${total.toFixed(2)}`}
        </button>
        {mintError && (
          <div className="text-center text-alert-fg" style={{ fontSize: 12, marginTop: 6 }}>
            {mintError}
          </div>
        )}
        {/* Service line items */}
        <div className="mt-6">
          {/* Base appointment service */}
          <button
            type="button"
            onClick={() => onEditServiceLine?.(service)}
            className="w-full flex items-start justify-between gap-3 py-4 bg-white border-b border-hairline border-zinc-200 text-left u-focus-ring"
          >
            <div className="flex-1 min-w-0 pr-2">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-blue-600 truncate" style={{ fontSize: 15 }}>
                  {service.serviceType || 'General Service'}
                </span>
                <Tag size={14} className="text-zinc-400 shrink-0" strokeWidth={1.5} />
              </div>
              <div className="text-ink-tertiary truncate" style={{ fontSize: 12, marginTop: 2 }}>
                {billingSubtitle}
              </div>
              {timeSubtitle && (
                <div className="text-ink-tertiary u-nums" style={{ fontSize: 12, marginTop: 1 }}>
                  {timeSubtitle}
                </div>
              )}
            </div>
            <div className="u-nums text-zinc-900 font-medium shrink-0" style={{ fontSize: 15 }}>
              ${price.toFixed(0)}
            </div>
          </button>

          {/* Extra added services + discounts */}
          {extras.map((e) => {
            const isDiscount = e._kind === 'discount' || e.amount < 0;
            return (
              <div
                key={e.id}
                className="flex items-center justify-between gap-3 py-4 border-b border-hairline border-zinc-200"
              >
                <div className="flex-1 min-w-0 pr-2">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="font-medium text-blue-600 truncate"
                      style={{ fontSize: 15 }}
                    >
                      {e.description}
                    </span>
                    <Tag size={14} className="text-zinc-400 shrink-0" strokeWidth={1.5} />
                  </div>
                </div>
                <div className="u-nums text-zinc-900 font-medium shrink-0" style={{ fontSize: 15 }}>
                  {isDiscount ? '−' : ''}${Math.abs(Number(e.amount)).toFixed(2)}
                </div>
                <button
                  type="button"
                  onClick={() => removeExtra(e.id)}
                  aria-label={`Remove ${e.description}`}
                  className="flex items-center justify-center h-8 w-8 rounded-full bg-white border border-hairline border-zinc-200 text-zinc-700 u-focus-ring"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </div>
            );
          })}

          {/* Tier discount (auto-applied WaveGuard) */}
          {pct > 0 && (
            <div className="flex items-center justify-between py-4 border-b border-hairline border-zinc-200">
              <span className="font-medium text-blue-600" style={{ fontSize: 15 }}>
                {tierLabel(tier)} Discount
              </span>
              <span className="u-nums text-zinc-900" style={{ fontSize: 15 }}>
                −${tierDiscountAmt.toFixed(2)}
              </span>
            </div>
          )}

          <div className="flex items-center justify-between py-4">
            <span className="text-zinc-900" style={{ fontSize: 15 }}>Total</span>
            <span className="u-nums text-zinc-900" style={{ fontSize: 15 }}>
              ${total.toFixed(2)}
            </span>
          </div>
        </div>

        {/* Add Service / Add Item or Discount */}
        <div className="mt-4 space-y-3">
          <button
            type="button"
            onClick={() => setShowServicePicker(true)}
            className="w-full bg-white text-zinc-900 font-medium rounded-xs u-focus-ring border border-hairline border-zinc-200"
            style={{ padding: '14px 20px', fontSize: 15 }}
          >
            Add Service
          </button>
          <button
            type="button"
            onClick={() => setShowItemPicker(true)}
            className="w-full bg-white text-zinc-900 font-medium rounded-xs u-focus-ring border border-hairline border-zinc-200"
            style={{ padding: '14px 20px', fontSize: 15 }}
          >
            Add Item or Discount
          </button>
        </div>
      </div>

      {showServicePicker && (
        <MobileServicePickerSheet
          onClose={() => setShowServicePicker(false)}
          onSelect={handleAddService}
        />
      )}
      {showItemPicker && (
        <MobileItemDiscountPickerSheet
          onClose={() => setShowItemPicker(false)}
          onSelect={handleAddItem}
        />
      )}
    </div>
  );
}
