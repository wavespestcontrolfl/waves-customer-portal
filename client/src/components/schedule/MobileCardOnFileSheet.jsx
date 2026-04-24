// Card on File tender — Square-style per IMG_3863 but with no Square
// branded copy. Full-screen sheet opened from MobilePaymentSheet's
// "Card on File" row. Loads the customer's saved Stripe payment methods,
// renders one row per card (brand badge + "VISA 9710") with an inline
// Charge button, and fires /admin/invoices/:id/charge-card on tap.

import { ArrowLeft } from 'lucide-react';
import { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function brandStyle(brand) {
  const b = (brand || '').toLowerCase();
  if (b === 'visa') return { bg: '#FFFFFF', fg: '#1A1F71', border: '#E5E5E5' };
  if (b === 'mastercard') return { bg: '#FFFFFF', fg: '#EB001B', border: '#E5E5E5' };
  if (b === 'amex' || b === 'american express') return { bg: '#FFFFFF', fg: '#2E77BC', border: '#E5E5E5' };
  if (b === 'discover') return { bg: '#FFFFFF', fg: '#F68121', border: '#E5E5E5' };
  return { bg: '#FFFFFF', fg: '#111111', border: '#E5E5E5' };
}

function brandLabel(c) {
  const b = (c.brand || 'Card').toString();
  return b.toUpperCase();
}

function cardTitle(c) {
  if (c.method_type === 'ach') {
    return `${c.bank_name || 'Bank'} ${c.last_four}`;
  }
  const brand = c.brand
    ? c.brand.charAt(0).toUpperCase() + c.brand.slice(1).toLowerCase()
    : 'Card';
  return `${brand} ${c.last_four}`;
}

export default function MobileCardOnFileSheet({
  service,
  invoiceId,
  customerId,
  customerName,
  onClose,
  onChargeSuccess,
}) {
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [chargingId, setChargingId] = useState(null);
  const [error, setError] = useState(null);

  const resolvedCustomerId = customerId || service?.customerId || service?.customer_id;
  const resolvedName = customerName || service?.customerName || service?.customer_name || 'Customer';

  useEffect(() => {
    if (!resolvedCustomerId) { setLoading(false); return; }
    let cancelled = false;
    fetch(`${API_BASE}/admin/customers/${resolvedCustomerId}/cards`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (!cancelled) setCards(Array.isArray(d.cards) ? d.cards : []); })
      .catch(() => { if (!cancelled) setCards([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [resolvedCustomerId]);

  async function handleCharge(card) {
    if (chargingId) return;
    setChargingId(card.id);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/admin/invoices/${invoiceId}/charge-card`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
        },
        body: JSON.stringify({ paymentMethodId: card.id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Charge failed');
      onChargeSuccess?.(d);
      onClose?.();
    } catch (e) {
      setError(e.message || 'Charge failed');
      setChargingId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-[115] bg-white overflow-y-auto md:hidden">
      {/* Header — back button left, customer name centered. */}
      <div
        className="sticky top-0 bg-white flex items-center px-3 border-b border-hairline border-zinc-200"
        style={{ height: 64, paddingTop: 'env(safe-area-inset-top, 0)' }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Back"
          className="flex items-center justify-center h-11 w-11 rounded-full u-focus-ring text-zinc-900"
          style={{ background: '#F4F4F5' }}
        >
          <ArrowLeft size={20} strokeWidth={2} />
        </button>
        <div className="flex-1 text-center font-semibold text-zinc-900" style={{ fontSize: 18 }}>
          {resolvedName}
        </div>
        <div className="w-11" />
      </div>

      <div className="px-4 pt-6 pb-10 mx-auto" style={{ maxWidth: 560 }}>
        {loading && (
          <div className="text-ink-secondary text-center" style={{ fontSize: 14, padding: '20px 0' }}>
            Loading cards…
          </div>
        )}
        {!loading && cards.length === 0 && (
          <div className="text-ink-secondary text-center" style={{ fontSize: 14, padding: '24px 0' }}>
            No cards on file for this customer.
          </div>
        )}
        {!loading && cards.map((c) => {
          const style = brandStyle(c.brand);
          const isCharging = chargingId === c.id;
          const anotherCharging = chargingId && chargingId !== c.id;
          return (
            <div
              key={c.id}
              className="flex items-center justify-between"
              style={{
                padding: '12px 0',
                borderBottom: '1px solid transparent',
              }}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span
                  aria-hidden
                  className="inline-flex items-center justify-center"
                  style={{
                    width: 52,
                    height: 34,
                    borderRadius: 6,
                    background: style.bg,
                    border: `1px solid ${style.border}`,
                    color: style.fg,
                    fontSize: 11,
                    fontWeight: 800,
                    letterSpacing: 0.3,
                    flexShrink: 0,
                  }}
                >
                  {brandLabel(c)}
                </span>
                <span
                  className="font-semibold text-zinc-900 truncate"
                  style={{ fontSize: 18 }}
                >
                  {cardTitle(c)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => handleCharge(c)}
                disabled={isCharging || anotherCharging}
                className="u-focus-ring"
                style={{
                  padding: '12px 24px',
                  fontSize: 16,
                  fontWeight: 600,
                  borderRadius: 999,
                  background: (isCharging || anotherCharging) ? '#E5E5E5' : '#111111',
                  color: (isCharging || anotherCharging) ? '#A3A3A3' : '#FFFFFF',
                  border: 'none',
                  flexShrink: 0,
                }}
              >
                {isCharging ? 'Charging…' : 'Charge'}
              </button>
            </div>
          );
        })}
        {error && (
          <div className="text-alert-fg" style={{ fontSize: 13, marginTop: 12, textAlign: 'center' }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
