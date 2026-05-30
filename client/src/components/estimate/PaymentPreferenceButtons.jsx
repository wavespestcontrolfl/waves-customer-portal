/**
 * Payment preference picker. Rendered after a slot is selected. Clicking
 * any button triggers the /reserve -> confirm -> /accept flow.
 *
 * Copy shifts when serviceMode='one_time' - the customer is booking a
 * single visit, so framing changes.
 *
 * Third annual prepay button renders when the server marks the
 * recurring service mix as annual-prepay eligible. Older pricing bundles can
 * still surface it through a waivable setupFee.
 * Selection encodes as 'prepay_annual' - the server treats it like
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

const ACTION_BG = W.blueDeeper;

export default function PaymentPreferenceButtons({
  onSelect,
  disabled,
  serviceMode,
  setupFee,
  invoiceMode = false,
  annualPrepayEligible = false,
}) {
  const isOneTime = serviceMode === 'one_time';
  const waivableSetupFee = setupFee && setupFee.waivedWithPrepay ? setupFee : null;
  const offerPrepay = !invoiceMode && !isOneTime && (annualPrepayEligible || !!waivableSetupFee);

  const btnBase = {
    padding: '16px 20px', borderRadius: 12,
    fontSize: 15, fontWeight: 600,
    cursor: disabled ? 'wait' : 'pointer',
    border: 'none', textAlign: 'center', width: '100%',
    opacity: disabled ? 0.65 : 1,
  };
  const optionNote = {
    fontSize: 13,
    color: W.textCaption,
    lineHeight: 1.45,
    marginTop: 8,
    padding: '0 2px',
    textAlign: 'center',
  };
  const optionWrap = { textAlign: 'center' };

  const cardOnFileLabel = isOneTime ? 'Book visit' : 'Choose pay-after-visit setup';
  const fineprint = offerPrepay
    ? 'Choose autopay to be billed after each completed service visit, or annual prepay to approve the 12-month plan up front with setup included.'
    : invoiceMode
      ? 'No card setup here. Once you accept, we send an invoice pay link due immediately.'
      : isOneTime
        ? 'This books a single visit. We do not charge you now.'
        : 'Choose pay-after-visit setup to be billed after each completed service visit through autopay.';
  const cardNextStep = 'Next: confirm your booking. If card setup is required, we send you to the secure setup screen after confirmation.';
  const prepayNextStep = 'Next: confirm annual prepay. No payment screen opens here; our team reviews and sends the annual prepay invoice after approval.';

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
          style={{ ...btnBase, background: ACTION_BG, color: W.white }}
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
          style={{ ...btnBase, background: ACTION_BG, color: W.white }}
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

      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <div style={optionWrap}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onSelect('card_on_file')}
            style={{ ...btnBase, background: ACTION_BG, color: W.white }}
          >{cardOnFileLabel}</button>
          <div style={optionNote}>Billed after each completed service through autopay.</div>
        </div>
        {offerPrepay && (
          <div style={optionWrap}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSelect('prepay_annual')}
              style={{ ...btnBase, background: ACTION_BG, color: W.white, position: 'relative' }}
            >
              Pay the 12-month plan in full
            </button>
            <div style={optionNote}>
              {waivableSetupFee
                ? `Approve annual prepay and the setup is included at no charge.`
                : '12-month invoice after approval.'}
            </div>
          </div>
        )}
      </div>

      <div style={{ fontSize: 12, color: W.textCaption, marginTop: 12, lineHeight: 1.5 }}>
        {fineprint}
      </div>
    </div>
  );
}
