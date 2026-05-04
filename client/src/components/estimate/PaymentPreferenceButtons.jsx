/**
 * Payment preference picker. Rendered after a slot is selected. Clicking
 * any button triggers the /reserve → confirm → /accept flow.
 *
 * Copy shifts when serviceMode='one_time' — the customer is booking a
 * single visit, so framing changes.
 *
 * Third "Pay the year upfront" button renders only when setupFee is
 * present AND waivedWithPrepay is true (recurring pest estimates).
 * Selection encodes as 'prepay_annual' — the server treats it like
 * pay_at_visit for reservation purposes (no immediate charge) but
 * the converter creates the prepaid-annual draft invoice instead of
 * the standard $99 setup draft invoice.
 */
const W = {
  blue: '#065A8C', blueBright: '#009CDE', blueDeeper: '#1B2C5B',
  yellow: '#FFD700', yellowHover: '#FFF176',
  navy: '#0F172A', textBody: '#334155', textCaption: '#64748B',
  white: '#FFFFFF', border: '#CBD5E1',
  green: '#16A34A', greenDark: '#15803D',
};

export default function PaymentPreferenceButtons({ onSelect, disabled, serviceMode, setupFee, invoiceMode = false }) {
  const isOneTime = serviceMode === 'one_time';
  const offerPrepay = !invoiceMode && !isOneTime && setupFee && setupFee.waivedWithPrepay;

  const btnBase = {
    padding: '16px 20px', borderRadius: 12,
    fontSize: 15, fontWeight: 600,
    cursor: disabled ? 'wait' : 'pointer',
    border: 'none', textAlign: 'center', width: '100%',
    opacity: disabled ? 0.65 : 1,
  };

  const depositLabel = isOneTime ? 'Book visit' : 'Reserve + save card on file';
  const payAtVisitLabel = isOneTime ? 'Book + pay on service day' : 'Reserve + pay at visit';
  const fineprint = offerPrepay
    ? 'Saving a card on file locks your slot — we still charge on the visit day. Pick "pay the year upfront" to settle the year now.'
    : invoiceMode
      ? 'No card setup here. Once you accept, we send an invoice due immediately by text and email.'
      : isOneTime
        ? 'This books a single visit. We do not charge you now.'
      : 'Saving a card on file locks your slot. Either way, we charge on the visit day, not now.';

  if (invoiceMode) {
    return (
      <div style={{
        background: W.white, borderRadius: 16, padding: 24,
        border: `1px solid ${W.border}`, marginBottom: 16,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: W.textCaption,
          textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 14 }}>
          {isOneTime ? 'Book your visit' : 'Accept your estimate'}
        </div>

        <button
          type="button"
          disabled={disabled}
          onClick={() => onSelect('pay_at_visit')}
          style={{ ...btnBase, background: W.blueBright, color: W.white }}
        >
          {isOneTime ? 'Book + send invoice' : 'Accept + send invoice'}
        </button>

        <div style={{ fontSize: 12, color: W.textCaption, marginTop: 12, lineHeight: 1.5 }}>
          {fineprint}
        </div>
      </div>
    );
  }

  if (isOneTime) {
    return (
      <div style={{
        background: W.white, borderRadius: 16, padding: 24,
        border: `1px solid ${W.border}`, marginBottom: 16,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: W.textCaption,
          textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 14 }}>
          Book your visit
        </div>

        <button
          type="button"
          disabled={disabled}
          onClick={() => onSelect('pay_at_visit')}
          style={{ ...btnBase, background: W.yellow, color: W.navy }}
        >
          Book + pay on service day
        </button>

        <div style={{ fontSize: 12, color: W.textCaption, marginTop: 12, lineHeight: 1.5 }}>
          {fineprint}
        </div>
      </div>
    );
  }

  return (
    <div style={{
      background: W.white, borderRadius: 16, padding: 24,
      border: `1px solid ${W.border}`, marginBottom: 16,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: W.textCaption,
        textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 14 }}>
        {isOneTime ? 'Book your visit' : 'Reserve your spot'}
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSelect('deposit_now')}
          style={{ ...btnBase, background: W.blueBright, color: W.white }}
        >{depositLabel}</button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSelect('pay_at_visit')}
          style={{ ...btnBase, background: W.yellow, color: W.navy }}
        >{payAtVisitLabel}</button>
        {offerPrepay && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onSelect('prepay_annual')}
            style={{ ...btnBase, background: W.green, color: W.white, position: 'relative' }}
          >
            Pay the year upfront
            <span style={{
              display: 'block', fontSize: 12, fontWeight: 500,
              color: 'rgba(255,255,255,0.9)', marginTop: 2,
            }}>Save ${setupFee.amount} setup fee</span>
          </button>
        )}
      </div>

      <div style={{ fontSize: 12, color: W.textCaption, marginTop: 12, lineHeight: 1.5 }}>
        {fineprint}
      </div>
    </div>
  );
}
