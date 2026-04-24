// Payment method picker — mobile-only, full-screen sheet opened from
// MobileCheckoutSheet's "Charge $X.XX" button. Square-style per IMG_3732.
//
// Tap to Pay launches the existing Stripe Terminal → WavesPay iOS deep
// link flow via launchTapToPay(invoiceId). Cash hands back to the parent
// so it can open MarkPrepaidModal (existing prepaid flow). The remaining
// methods are stubbed — Square wants them visually present in this slot
// but actual implementation lands in a follow-up.

import { X, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { launchTapToPay } from '../../lib/tapToPay';

export default function MobilePaymentSheet({
  service,
  invoiceId,
  amount,
  onClose,
  onSelectCash,
}) {
  const [charging, setCharging] = useState(false);
  const [error, setError] = useState(null);

  if (!service || !invoiceId) return null;

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

  function stub(label) {
    alert(`${label} — coming soon`);
  }

  const methods = [
    { key: 'cash', label: 'Cash', onClick: handleCash },
    { key: 'manual_cc', label: 'Manual Credit Card Entry', onClick: () => stub('Manual Credit Card Entry') },
    { key: 'gift_card', label: 'Gift Card', onClick: () => stub('Gift Card') },
    { key: 'card_on_file', label: 'Card on File', subtitle: 'Unable to load cards', disabled: true },
    { key: 'invoice', label: 'Invoice', onClick: () => stub('Invoice') },
    { key: 'cash_app', label: 'Cash App Pay', onClick: () => stub('Cash App Pay') },
  ];

  return (
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
        <span
          className="text-zinc-900 underline"
          style={{ fontSize: 14, padding: '0 8px' }}
        >
          Split Amount
        </span>
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

        {/* Other methods */}
        <div className="mt-6">
          {methods.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={m.onClick}
              disabled={m.disabled}
              className={
                'w-full flex items-center justify-between py-4 border-b border-hairline border-zinc-200 text-left u-focus-ring ' +
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
  );
}
