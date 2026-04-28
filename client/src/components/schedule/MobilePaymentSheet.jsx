// Payment method picker — mobile-only, full-screen sheet opened from
// MobileCheckoutSheet's "Charge $X.XX" button.
//
// Tender rows each open a dedicated Square-style sheet:
//   Tap to Pay           → native Stripe Terminal (WavesPay iOS deep link)
//   Cash                 → MobileCashTenderSheet (numpad + Tender)
//   Check                → MobileCheckTenderSheet (optional note + Record Payment)
//   Manual Credit Card   → MobileManualCardSheet  (in-app Stripe card entry)
//   Card on File         → MobileCardOnFileSheet  (saved cards + Charge)
//   Invoice              → send SMS + email pay link (no sheet)
//
// Cash App Pay was removed per operator request.
//
// Audit focus:
// - Tap to Pay: launches a deep link into the WavesPay iOS app. What
//   happens on Android / desktop / when the deep link doesn't resolve?
//   Confirm there's a fallback path so the operator isn't stuck.
// - Sheet stacking: this sheet opens four child tender sheets. Confirm
//   only one is open at a time, and that closing a tender sheet returns
//   to this sheet (not to the underlying checkout sheet).
// - Invoice + token handoff: invoiceId and invoiceToken are passed in
//   from MobileCheckoutSheet. Each tender sheet uses these for the
//   relevant POST. Verify nothing here re-creates an invoice (would
//   duplicate the bill).
// - Manual / Cash / Check tender record-payment endpoints: confirm each
//   is idempotent on the (invoiceId, amount, method, externalRef) tuple
//   so a network retry doesn't double-record.

import { X, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { launchTapToPay } from '../../lib/tapToPay';
import MobileManualCardSheet from './MobileManualCardSheet';
import MobileCashTenderSheet from './MobileCashTenderSheet';
import MobileCheckTenderSheet from './MobileCheckTenderSheet';
import MobileCardOnFileSheet from './MobileCardOnFileSheet';

export default function MobilePaymentSheet({
  service,
  invoiceId,
  invoiceToken,
  amount,
  onClose,
  onInvoiceSent,
  onChargeSuccess,
  onPrepaidRecorded,
}) {
  const [charging, setCharging] = useState(false);
  const [sendingInvoice, setSendingInvoice] = useState(false);
  const [showManualCard, setShowManualCard] = useState(false);
  const [showCash, setShowCash] = useState(false);
  const [showCheck, setShowCheck] = useState(false);
  const [showCardOnFile, setShowCardOnFile] = useState(false);
  const [error, setError] = useState(null);

  const API_BASE = import.meta.env.VITE_API_URL || '/api';

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

  const surcharge = Math.round(amount * 1.0399 * 100) / 100;

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

  const methods = [
    { key: 'cash', label: 'Cash', onClick: () => setShowCash(true) },
    { key: 'check', label: 'Check', onClick: () => setShowCheck(true) },
    { key: 'manual_cc', label: 'Manual Credit Card Entry', onClick: () => setShowManualCard(true) },
    { key: 'card_on_file', label: 'Card on File', onClick: () => setShowCardOnFile(true) },
    {
      key: 'invoice',
      label: 'Invoice',
      subtitle: sendingInvoice ? 'Sending…' : 'Send SMS + email',
      onClick: handleSendInvoice,
      disabled: sendingInvoice,
    },
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
            ${surcharge.toFixed(2)} with 3.99% credit card surcharge
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

          {/* Tender rows */}
          <div className="mt-6 bg-white">
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

      {showCash && (
        <MobileCashTenderSheet
          service={service}
          amount={amount}
          onClose={() => setShowCash(false)}
          onRecorded={(r) => {
            onPrepaidRecorded?.(r);
            onClose?.();
          }}
        />
      )}

      {showCheck && (
        <MobileCheckTenderSheet
          service={service}
          amount={amount}
          onClose={() => setShowCheck(false)}
          onRecorded={(r) => {
            onPrepaidRecorded?.(r);
            onClose?.();
          }}
        />
      )}

      {showCardOnFile && (
        <MobileCardOnFileSheet
          service={service}
          invoiceId={invoiceId}
          customerId={service?.customerId || service?.customer_id}
          customerName={service?.customerName || service?.customer_name}
          onClose={() => setShowCardOnFile(false)}
          onChargeSuccess={(r) => {
            onChargeSuccess?.(r);
            onClose?.();
          }}
        />
      )}
    </>
  );
}
