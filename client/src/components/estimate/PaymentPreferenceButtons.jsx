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

export default function PaymentPreferenceButtons({ onSelect, disabled, serviceMode, setupFee }) {
  const isOneTime = serviceMode === 'one_time';
  const offerPrepay = !isOneTime && setupFee && setupFee.waivedWithPrepay;

  const btnBase = {
    padding: '16px 20px', borderRadius: 12,
    fontSize: 15, fontWeight: 600,
    cursor: disabled ? 'wait' : 'pointer',
    border: 'none', textAlign: 'center', width: '100%',
    opacity: disabled ? 0.65 : 1,
  };

  const depositLabel = isOneTime ? 'Book + pay upfront' : 'Reserve + pay deposit now';
  const payAtVisitLabel = isOneTime ? 'Book + pay on service day' : 'Reserve + pay at visit';
  const fineprint = isOneTime
    ? "You'll only be charged on service day unless you pick \"pay upfront.\""
    : offerPrepay
      ? "You'll only be charged on service day unless you pick \"pay deposit now\" or \"pay the year upfront.\""
      : "You'll only be charged on service day unless you pick \"pay deposit now.\"";

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
