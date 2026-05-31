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

function fmtMoney(n) {
  if (n == null) return '—';
  const v = Math.round(Number(n) * 100) / 100;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function billingIntervalMonths(frequency = {}) {
  const key = frequency.billingFrequencyKey || frequency.key;
  if (key === 'quarterly') return 3;
  if (key === 'bi_monthly' || key === 'bimonthly') return 2;
  return 1;
}

function firstVisitAmount(frequency = {}) {
  const monthly = Number(frequency.monthly);
  if (Number.isFinite(monthly) && monthly > 0) {
    return Math.round(monthly * billingIntervalMonths(frequency) * 100) / 100;
  }
  const perVisit = Number(frequency.perVisit || frequency.perApp || frequency.pa);
  return Number.isFinite(perVisit) && perVisit > 0 ? Math.round(perVisit * 100) / 100 : null;
}

export default function PaymentPreferenceButtons({
  onSelect,
  disabled,
  serviceMode,
  setupFee,
  invoiceMode = false,
  annualPrepayEligible = false,
  selectedFrequency = null,
}) {
  const isOneTime = serviceMode === 'one_time';
  const waivableSetupFee = setupFee && setupFee.waivedWithPrepay ? setupFee : null;
  const offerPrepay = !invoiceMode && !isOneTime && (annualPrepayEligible || !!waivableSetupFee);
  const setupAmount = Number(setupFee?.amount);
  const hasSetupInvoice = Number.isFinite(setupAmount) && setupAmount > 0;
  const firstVisit = firstVisitAmount(selectedFrequency || {});

  const btnBase = {
    padding: '16px 20px', borderRadius: 12,
    fontSize: 15, fontWeight: 600,
    cursor: disabled ? 'wait' : 'pointer',
    border: 'none', textAlign: 'center', width: '100%',
    opacity: disabled ? 0.65 : 1,
  };
  const optionNote = {
    fontSize: 14,
    color: W.textCaption,
    lineHeight: 1.45,
    marginTop: 8,
    padding: '0 2px',
    textAlign: 'center',
  };
  const optionWrap = { textAlign: 'center' };
  const invoiceRows = [
    ...(hasSetupInvoice ? [{ label: 'WaveGuard Membership Setup', amount: setupAmount }] : []),
    ...(firstVisit ? [{ label: 'First service visit', amount: firstVisit }] : []),
  ];

  const cardOnFileLabel = isOneTime ? 'Book visit' : 'Pay after each visit';
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
          <div style={optionNote}>Approve now, then save a card for autopay after each completed service visit.</div>
          {invoiceRows.length > 0 ? (
            <div style={{
              marginTop: 14,
              border: `1px solid ${W.border}`,
              borderRadius: 12,
              padding: 14,
              background: '#F8FAFC',
              textAlign: 'left',
            }}>
              {invoiceRows.map((row) => (
                <div
                  key={row.label}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 12,
                    alignItems: 'baseline',
                    fontSize: 14,
                    color: W.navy,
                    lineHeight: 1.4,
                    marginBottom: 8,
                  }}
                >
                  <span>{row.label}</span>
                  <strong style={{ whiteSpace: 'nowrap' }}>{fmtMoney(row.amount)}</strong>
                </div>
              ))}
              {hasSetupInvoice ? (
                <div style={{
                  borderTop: `1px solid ${W.border}`,
                  paddingTop: 10,
                  marginTop: 2,
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 12,
                  alignItems: 'baseline',
                  fontSize: 14,
                  fontWeight: 800,
                  color: W.blueDeeper,
                }}>
                  <span>Invoice total</span>
                  <strong>{fmtMoney(setupAmount)}</strong>
                </div>
              ) : null}
              <div style={{ fontSize: 13, color: W.textCaption, lineHeight: 1.45, marginTop: 10 }}>
                No payment is charged on this page. {hasSetupInvoice ? `The ${fmtMoney(setupAmount)} setup invoice is prepared after approval; ` : ''}
                {firstVisit ? `your first service visit bills after completion at ${fmtMoney(firstVisit)}.` : 'your service visits bill after completion.'}
              </div>
            </div>
          ) : null}
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
