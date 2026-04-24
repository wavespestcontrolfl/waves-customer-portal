// Payment method picker — mobile-only, full-screen sheet opened from
// MobileCheckoutSheet's "Charge $X.XX" button. Square-style per IMG_3732.
//
// Tap to Pay launches the existing Stripe Terminal → WavesPay iOS deep
// link flow via launchTapToPay(invoiceId). Cash hands back to the parent
// so it can open MarkPrepaidModal (existing prepaid flow). Manual CC +
// Cash App open the /pay/:token public pay page in a new tab. Invoice
// fires the existing /admin/invoices/:id/send endpoint.
//
// Card on File lights up when the customer has saved payment methods
// (consent captured during onboarding / portal / pay page). Tapping a
// saved card charges it off-session via Stripe.

import { X, ChevronRight, CreditCard } from 'lucide-react';
import { useEffect, useState } from 'react';
import { launchTapToPay } from '../../lib/tapToPay';
import MobileManualCardSheet from './MobileManualCardSheet';

export default function MobilePaymentSheet({
  service,
  invoiceId,
  invoiceToken,
  amount,
  onClose,
  onSelectCash,
  onInvoiceSent,
  onChargeSuccess,
}) {
  const [charging, setCharging] = useState(false);
  const [sendingInvoice, setSendingInvoice] = useState(false);
  const [cards, setCards] = useState([]);
  const [cardsLoading, setCardsLoading] = useState(false);
  const [chargingCardId, setChargingCardId] = useState(null);
  const [showManualCard, setShowManualCard] = useState(false);
  const [error, setError] = useState(null);

  const API_BASE = import.meta.env.VITE_API_URL || '/api';
  const customerId = service?.customerId || service?.customer_id;

  useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    setCardsLoading(true);
    fetch(`${API_BASE}/admin/customers/${customerId}/cards`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}` },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (!cancelled) setCards(Array.isArray(d.cards) ? d.cards : []); })
      .catch(() => { if (!cancelled) setCards([]); })
      .finally(() => { if (!cancelled) setCardsLoading(false); });
    return () => { cancelled = true; };
  }, [customerId, API_BASE]);

  if (!service || !invoiceId) return null;

  async function handleSendInvoice() {
    if (sendingInvoice) return;
    setSendingInvoice(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/admin/invoices/${invoiceId}/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
        },
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || 'Failed to send invoice');
      }
      onInvoiceSent?.();
    } catch (e) {
      setError(e.message || 'Failed to send invoice');
      setSendingInvoice(false);
    }
  }

  function openPayPage(methodHint) {
    if (!invoiceToken) {
      setError('Missing invoice token — refresh and try again');
      return;
    }
    const base = `${window.location.origin}/pay/${invoiceToken}`;
    const url = methodHint ? `${base}#${encodeURIComponent(methodHint)}` : base;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  const surcharge = Math.round(amount * 1.03 * 100) / 100;

  async function handleTapToPay() {
    if (charging) return;
    setCharging(true);
    setError(null);
    try {
      await launchTapToPay(invoiceId);
      // Control is now handed off to the native iOS shell. Leave the sheet
      // open so the deep link has a stable document to return to; the
      // parent will close it once the payment webhook updates status.
    } catch (e) {
      setError(e.message || 'Failed to open Tap to Pay');
      setCharging(false);
    }
  }

  function handleCash() {
    onClose?.();
    onSelectCash?.(service);
  }

  async function handleChargeCard(card) {
    if (chargingCardId) return;
    setChargingCardId(card.id);
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
      setChargingCardId(null);
    }
  }

  function formatCardLabel(c) {
    if (c.method_type === 'ach') {
      return `${c.bank_name || 'Bank'} •${c.last_four}`;
    }
    const brand = c.brand ? c.brand.toUpperCase() : 'Card';
    return `${brand} •${c.last_four}`;
  }

  // Gift Card removed per operator request — not a tender Waves accepts.
  // Manual CC opens an in-app Stripe card sheet so the tech never leaves
  // the admin app. Cash App still punches out to the public /pay page
  // (Stripe wallet support lives there). Invoice fires the existing
  // /admin/invoices/:id/send endpoint so the customer gets the pay link
  // by SMS + email; the sheet closes on success.
  const methods = [
    { key: 'cash', label: 'Cash', onClick: handleCash },
    { key: 'manual_cc', label: 'Manual Credit Card Entry', onClick: () => setShowManualCard(true) },
    {
      key: 'invoice',
      label: 'Invoice',
      subtitle: sendingInvoice ? 'Sending…' : 'Send SMS + email',
      onClick: handleSendInvoice,
      disabled: sendingInvoice,
    },
    { key: 'cash_app', label: 'Cash App Pay', onClick: () => openPayPage('cashapp') },
  ];

  return (
    <>
    <div className="fixed inset-0 z-[110] bg-white overflow-y-auto md:hidden">
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
        <div className="flex-1" />
      </div>

      <div className="px-5 pt-8 pb-10 mx-auto" style={{ maxWidth: 560 }}>
        {/* Amount */}
        <div
          className="text-zinc-900"
          style={{ fontSize: 64, fontWeight: 400, letterSpacing: '-0.02em', lineHeight: 1 }}
        >
          ${amount.toFixed(2)}
        </div>
        <div
          className="text-ink-tertiary"
          style={{ fontSize: 14, marginTop: 10 }}
        >
          ${surcharge.toFixed(2)} with 3% credit card surcharge
        </div>

        {/* Tap to Pay card */}
        <div
          className="mt-5 rounded-md border-hairline border-zinc-200 bg-white"
          style={{
            padding: '20px 16px 16px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.04), 0 4px 10px rgba(0,0,0,0.04)',
          }}
        >
          <button
            type="button"
            onClick={handleTapToPay}
            disabled={charging}
            className="w-full bg-zinc-900 text-white font-medium rounded-full u-focus-ring"
            style={{ padding: '16px 20px', fontSize: 16, opacity: charging ? 0.6 : 1 }}
          >
            {charging ? 'Opening Tap to Pay…' : 'Tap to Pay on iPhone'}
          </button>
          <div
            className="text-center text-ink-tertiary"
            style={{ fontSize: 13, marginTop: 10 }}
          >
            Powered by Stripe Terminal
          </div>
        </div>
        {error && (
          <div
            className="text-alert-fg text-center"
            style={{ fontSize: 13, marginTop: 8 }}
          >
            {error}
          </div>
        )}

        {/* Card on File — one row per saved payment method. Empty state
            renders a disabled "No cards on file" row so the slot is
            still visible to the tech. */}
        <div className="mt-6 bg-white">
          {cardsLoading && (
            <div
              className="w-full flex items-center justify-between py-4 border-b border-hairline border-zinc-200 text-left bg-white"
            >
              <span className="font-medium text-ink-tertiary" style={{ fontSize: 15 }}>
                Card on File
              </span>
              <span className="text-ink-tertiary" style={{ fontSize: 14 }}>Loading…</span>
            </div>
          )}
          {!cardsLoading && cards.length === 0 && (
            <div
              className="w-full flex items-center justify-between py-4 border-b border-hairline border-zinc-200 text-left bg-white opacity-60"
            >
              <span className="font-medium text-ink-tertiary" style={{ fontSize: 15 }}>
                Card on File
              </span>
              <span className="text-ink-tertiary" style={{ fontSize: 14 }}>No cards on file</span>
            </div>
          )}
          {!cardsLoading && cards.map((c) => {
            const isCharging = chargingCardId === c.id;
            const anotherCharging = chargingCardId && chargingCardId !== c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => handleChargeCard(c)}
                disabled={isCharging || anotherCharging}
                className={
                  'w-full flex items-center justify-between py-4 border-b border-hairline border-zinc-200 text-left u-focus-ring bg-white ' +
                  ((isCharging || anotherCharging) ? 'opacity-60 cursor-not-allowed' : 'active:bg-zinc-50')
                }
              >
                <div className="flex items-center gap-3 min-w-0">
                  <CreditCard size={18} strokeWidth={1.75} className="text-zinc-600 shrink-0" />
                  <span className="font-medium text-zinc-900 truncate" style={{ fontSize: 15 }}>
                    {formatCardLabel(c)}
                  </span>
                  {c.is_default && (
                    <span
                      className="text-ink-tertiary"
                      style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.3 }}
                    >
                      Default
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-ink-tertiary" style={{ fontSize: 14 }}>
                    {isCharging ? 'Charging…' : `Charge $${surcharge.toFixed(2)}`}
                  </span>
                  <ChevronRight size={16} className="text-ink-tertiary" />
                </div>
              </button>
            );
          })}

          {/* Other methods */}
          {methods.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={m.onClick}
              disabled={m.disabled}
              className={
                'w-full flex items-center justify-between py-4 border-b border-hairline border-zinc-200 text-left u-focus-ring bg-white ' +
                (m.disabled ? 'opacity-60 cursor-not-allowed' : 'active:bg-zinc-50')
              }
            >
              <span
                className={
                  'font-medium ' +
                  (m.disabled ? 'text-ink-tertiary' : 'text-zinc-900')
                }
                style={{ fontSize: 15 }}
              >
                {m.label}
              </span>
              <div className="flex items-center gap-2">
                {m.subtitle && (
                  <span
                    className="text-ink-tertiary"
                    style={{ fontSize: 14 }}
                  >
                    {m.subtitle}
                  </span>
                )}
                <ChevronRight size={16} className="text-ink-tertiary" />
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
    {showManualCard && (
      <MobileManualCardSheet
        invoiceToken={invoiceToken}
        amount={amount}
        onClose={() => setShowManualCard(false)}
        onChargeSuccess={(r) => {
          onChargeSuccess?.(r);
          onClose?.();
        }}
      />
    )}
    </>
  );
}
