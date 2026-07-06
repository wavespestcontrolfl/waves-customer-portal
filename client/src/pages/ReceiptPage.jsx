// client/src/pages/ReceiptPage.jsx
//
// Customer-facing post-payment receipt view. Reached via redirect
// from PayPage(V2) on successful Stripe Payment Intent confirmation.
// Renders success badge, invoice details, payment summary, and a
// "download PDF" link that proxies to server/services/pdf/
// invoice-pdf.js.
//
// Endpoints:
//   GET  /api/billing/v2/invoice/:token        (re-fetch by public
//                                               token to render
//                                               final state)
//   GET  /api/billing/v2/invoice/:token/pdf    (PDF stream)
//
// Customer-facing styling (CLAUDE.md): warm tone — no admin monochrome.
//
// Audit focus:
// - "Still confirming" race: a 3DS-required charge can take a few
//   seconds to clear after PI.confirm returns. If the receipt loads
//   before the webhook updates the invoice to paid, we may render
//   "still confirming" or even the unpaid view. Confirm there's a
//   short retry / polling path, or that the success state is
//   render-able from the PI's intent status (not just the invoice
//   row).
// - Token reuse: GET /:token is the same public token used by
//   PayPage. After payment, the token still works (operator may
//   need to re-share). Confirm there's no path where loading the
//   receipt mutates payment state.
// - PDF stream: large invoices may take time. Verify there's a
//   reasonable timeout + a non-PDF fallback (download fails →
//   plain-HTML view).
// - Email forwarding: if the customer forwards the receipt URL,
//   does the recipient see the same invoice? That's intended (it's
//   a receipt) but should NOT expose card details.
import { FONTS } from '../theme-brand';
import { CUSTOMER_SURFACE } from '../theme-customer';
import { useGlassSurface } from '../glass/glass-engine';
import React, { useState, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import Icon from '../components/Icon';
import {
  WavesShell,
  BrandCard,
  SerifHeading,
  HelpPhoneLink,
} from '../components/brand';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function fmtCurrency(n) {
  const v = Number(n || 0);
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function isDiscountLineItem(item) {
  const amount = Number(item?.amount ?? ((Number(item?.quantity) || 1) * (Number(item?.unit_price) || 0)));
  return item?._kind === 'discount' || item?.discount_for || amount < 0;
}

// Acceptance-deposit credit lines are prior payments, not discounts — they
// stay out of the item table but MUST surface in the totals block, or the
// visible rows won't reconcile to the total charged (bookkeeping-grade
// receipts need every dollar accounted for).
function depositCreditTotalFromLineItems(lineItems) {
  return (lineItems || [])
    .filter((item) => item?.category === 'deposit_credit')
    .reduce((sum, item) => {
      const amount = Number(item?.amount ?? ((Number(item?.quantity) || 1) * (Number(item?.unit_price) || 0)));
      return sum + (Number.isFinite(amount) ? Math.abs(amount) : 0);
    }, 0);
}

function fmtDate(d) {
  if (!d) return '';
  const dt = typeof d === 'string'
    ? new Date(d.length === 10 ? d + 'T12:00:00' : d)
    : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}

const subtlePanel = {
  background: CUSTOMER_SURFACE.page,
  border: `1px solid ${CUSTOMER_SURFACE.border}`,
  borderRadius: 8,
};

const eyebrow = {
  fontSize: 12,
  color: 'var(--text-muted)',
  fontWeight: 850,
  letterSpacing: 0,
  textTransform: 'uppercase',
};

function fullName(customer = {}) {
  return [customer.firstName, customer.lastName].filter(Boolean).join(' ') || 'Waves customer';
}

function cityStateZip(customer = {}) {
  const region = [customer.state || (customer.city ? 'FL' : ''), customer.zip].filter(Boolean).join(' ');
  return [customer.city, region].filter(Boolean).join(customer.city && region ? ', ' : '');
}

function StatusPill({ tone = 'neutral', children }) {
  const tones = {
    paid: { bg: '#F0FDF4', color: 'var(--success)', border: '#BBF7D0' },
    processing: { bg: '#EEF6FF', color: '#065A8C', border: '#BFE4F8' },
    refunded: { bg: 'rgba(200,16,46,0.08)', color: 'var(--danger)', border: 'rgba(200,16,46,0.22)' },
    partial: { bg: '#EEF6FF', color: '#065A8C', border: '#BFE4F8' },
    neutral: { bg: CUSTOMER_SURFACE.page, color: 'var(--text)', border: CUSTOMER_SURFACE.border },
  };
  const t = tones[tone] || tones.neutral;
  const glassClear = t === tones.neutral ? { 'data-glass-clear': '' } : {};
  return (
    <span {...glassClear} style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      minHeight: 28,
      padding: '5px 9px',
      borderRadius: 8,
      background: t.bg,
      border: `1px solid ${t.border}`,
      color: t.color,
      fontSize: 12,
      fontWeight: 850,
      letterSpacing: 0,
      textTransform: 'uppercase',
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

function DetailBlock({ label, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ ...eyebrow, marginBottom: 7 }}>{label}</div>
      <div style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.55 }}>
        {children}
      </div>
    </div>
  );
}

function SummaryRow({ label, value, strong, danger }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      gap: 16,
      padding: strong ? '12px 0 0' : '7px 0',
      marginTop: strong ? 8 : 0,
      borderTop: strong ? '1px solid var(--border)' : 'none',
      color: danger ? 'var(--danger)' : strong ? 'var(--text)' : 'var(--text-muted)',
      fontSize: strong ? 16 : 14,
      fontWeight: strong ? 850 : danger ? 750 : 500,
      fontFamily: FONTS.body,
    }}>
      <span>{label}</span>
      <span style={{
        color: danger ? 'var(--danger)' : 'var(--text)',
        fontFamily: FONTS.mono,
        fontWeight: strong ? 850 : 650,
        whiteSpace: 'nowrap',
      }}>
        {value}
      </span>
    </div>
  );
}

// Inline success checkmark — navy ring, white tick. Used in the fresh-payment
// badge scale-in animation.
function SuccessCheck({ size = 56 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 56 56"
      role="img"
      aria-label="Payment received"
      style={{ display: 'block' }}
    >
      <circle cx="28" cy="28" r="26" fill="var(--success)" />
      <path
        d="M16 29 L25 37 L41 20"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function ReceiptPage() {
  // Liquid-glass 'pro' variant (visual only).
  // Native data-glass markup — no classify() walker on this page.
  useGlassSurface(true, 'pro');
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // ── ?fresh=1 animation — fires ONCE on first mount, then strips the param
  // from the URL so cmd-R refresh doesn't re-trigger the badge animation.
  // ?consent_failed=1 surfaces a banner when the save-payment-method
  // authorization couldn't be recorded on the server (the payment itself
  // still succeeded). Stripped the same way so reloads don't re-show it.
  const [showFreshBadge, setShowFreshBadge] = useState(false);
  const [consentFailed, setConsentFailed] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    let mutated = false;
    if (params.get('fresh') === '1') {
      setShowFreshBadge(true);
      params.delete('fresh');
      mutated = true;
    }
    if (params.get('consent_failed') === '1') {
      setConsentFailed(true);
      params.delete('consent_failed');
      mutated = true;
    }
    if (mutated) {
      const qs = params.toString();
      const nextUrl = window.location.pathname + (qs ? `?${qs}` : '');
      window.history.replaceState(null, '', nextUrl);
    }
  }, []);

  useEffect(() => {
    fetch(`${API_BASE}/receipt/${token}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? 'Receipt not found' : 'Failed to load');
        return r.json();
      })
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [token]);

  const refundState = useMemo(() => {
    if (!data?.payment) return null;
    const { refundAmount, state } = data.payment;
    if (state === 'fully_refunded' || (refundAmount > 0 && refundAmount >= Number(data.payment.amount || 0))) {
      return 'fully_refunded';
    }
    if (state === 'partially_refunded' || refundAmount > 0) return 'partially_refunded';
    return null;
  }, [data]);

  if (loading) {
    return (
      <WavesShell variant="customer" topBar="solid">
        <div style={{ padding: '64px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
          Loading receipt…
        </div>
      </WavesShell>
    );
  }

  if (error || !data) {
    return (
      <WavesShell variant="customer" topBar="solid">
        <div style={{ maxWidth: 560, margin: '48px auto', padding: '0 16px' }}>
          <BrandCard>
            <SerifHeading style={{ marginBottom: 12 }}>We couldn't find that receipt</SerifHeading>
            <p style={{ margin: 0, fontSize: 16, color: 'var(--text)', lineHeight: 1.55 }}>
              The link may be mistyped. Give us a call and we'll pull up your records — <HelpPhoneLink tone="dark" inline />.
            </p>
          </BrandCard>
        </div>
      </WavesShell>
    );
  }

  const { invoice, service, customer, payment, payer } = data;
  const visibleLineItems = (invoice.lineItems || []).filter(item => !isDiscountLineItem(item));
  const depositCreditTotal = depositCreditTotalFromLineItems(invoice.lineItems);
  // When account credit (fully or partly) covered the invoice there may be no
  // payments row — fall back to the amount DUE net of applied credit (zero for a
  // fully credit-covered invoice), never the gross invoice.total, so the
  // "Account credit applied" line and the charged total reconcile.
  const chargedTotal = payment?.amount != null
    ? payment.amount
    : Math.max(0, Number(invoice.total || 0) - Number(invoice.creditApplied || 0));
  const paid = invoice.status === 'paid';
  // A fully-refunded invoice moves to status 'refunded' but keeps a permanent,
  // downloadable bookkeeping receipt (the PDF route serves 'paid' + 'refunded'),
  // so the download link must show for both — else a refund hides the PDF button.
  const hasReceiptPdf = paid || invoice.status === 'refunded';
  const processing = invoice.status === 'processing' || payment?.state === 'processing';
  const paidAt = invoice.paidAt || payment?.paymentDate;
  const invoiceMethod = String(invoice.paymentMethod || '').toLowerCase();
  const methodDisplay = payment?.cardBrand && payment?.cardLastFour
    ? `${payment.cardBrand.toUpperCase()} ···· ${payment.cardLastFour}`
    : (invoiceMethod === 'us_bank_account' && invoice.cardLastFour
      ? `Bank account ···· ${invoice.cardLastFour}`
      : (invoice.cardBrand && invoice.cardLastFour
        ? `${invoice.cardBrand.toUpperCase()} ···· ${invoice.cardLastFour}`
        : null));
  const serviceLabel = invoice.title || service.type || 'Service';
  const serviceDateLabel = service.date ? fmtDate(service.date) : null;
  const locationLine = cityStateZip(customer);
  const statusTone = refundState === 'fully_refunded'
    ? 'refunded'
    : refundState === 'partially_refunded'
      ? 'partial'
      : processing
        ? 'processing'
        : paid
          ? 'paid'
          : 'neutral';
  const statusLabel = refundState === 'fully_refunded'
    ? 'Refunded'
    : refundState === 'partially_refunded'
      ? 'Partial refund'
      : processing
        ? 'Processing'
        : paid
          ? 'Paid'
          : 'Receipt';
  const heading = processing ? 'Bank payment submitted' : paid ? 'Payment received' : 'Receipt';
  const statusDetail = processing
    ? 'Bank payments usually take 3-5 business days to clear. We will send the final receipt after the payment settles.'
    : refundState === 'fully_refunded'
      ? 'This payment has been fully refunded.'
      : refundState === 'partially_refunded'
        ? `${fmtCurrency(payment.refundAmount)} has been refunded. Net paid: ${fmtCurrency(payment.remainingPaid)}.`
        : 'Keep this receipt for your records.';

  return (
    <WavesShell variant="customer" topBar="solid">
      {/* @media print — strip the shell chrome and render bookkeeping-grade
          output when a customer hits cmd-P. */}
      <style>{`
        @keyframes waves-badge-in {
          0%   { opacity: 0; transform: scale(0.6); }
          60%  { opacity: 1; transform: scale(1.08); }
          100% { opacity: 1; transform: scale(1); }
        }
        .waves-fresh-badge { animation: waves-badge-in 420ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }
        @media print {
          @page { margin: 0.5in; }
          body { background: #FFFFFF !important; }
          header, footer, .waves-no-print { display: none !important; }
          .waves-print-root { padding: 0 !important; margin: 0 !important; max-width: 100% !important; }
          .waves-print-card {
            box-shadow: none !important;
            border: 1px solid #CCCCCC !important;
            border-radius: 0 !important;
            padding: 24px !important;
            page-break-inside: avoid;
          }
          .waves-fresh-badge { display: none !important; }
          a { color: #000000 !important; text-decoration: none !important; }
        }
      `}</style>

      <div className="waves-print-root waves-receipt-page">
        {showFreshBadge && (
          <div
            className="waves-fresh-badge waves-no-print"
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 10,
              marginBottom: 20,
              padding: '20px 16px',
              textAlign: 'center',
            }}
          >
            <SuccessCheck size={56} />
            <div style={{
              fontFamily: FONTS.body,
              fontWeight: 750,
              fontSize: 24,
              color: 'var(--text)',
              lineHeight: 1.2,
            }}>
              {heading}
            </div>
            <div style={{ fontSize: 14, color: 'var(--text-muted)' }}>
              {processing
                ? `Thanks, ${customer.firstName || 'there'} - your bank payment is processing.`
                : `Thanks, ${customer.firstName || 'there'} - a receipt is on its way to you.`}
            </div>
          </div>
        )}

        {consentFailed && (
          <div className="waves-no-print" style={{
            marginBottom: 16,
            padding: 14,
            borderRadius: 8,
            background: 'rgba(200,16,46,0.06)',
            border: '1px solid rgba(200,16,46,0.28)',
            color: 'var(--text)',
            fontSize: 14,
            lineHeight: 1.5,
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
          }}>
            <Icon name="warning" size={17} strokeWidth={2} style={{ color: 'var(--danger)', marginTop: 1, flexShrink: 0 }} />
            <div>
              <div style={{ fontWeight: 850, color: 'var(--danger)', marginBottom: 3 }}>Save-on-file authorization not recorded</div>
              <div style={{ color: 'var(--text-muted)' }}>
                Your payment went through, but we couldn't record your authorization to save this payment method on file. Waves will reach out to confirm before any future charge. Questions: call <HelpPhoneLink tone="dark" inline />.
              </div>
            </div>
          </div>
        )}

        {refundState === 'fully_refunded' && (
          <div className="waves-no-print" style={{
            marginBottom: 16,
            padding: 14,
            borderRadius: 8,
            background: 'rgba(200,16,46,0.06)',
            border: '1px solid rgba(200,16,46,0.28)',
            color: 'var(--danger)',
            fontSize: 14,
            fontWeight: 750,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}>
            <Icon name="warning" size={17} strokeWidth={2} />
            <span>
              This payment has been fully refunded
              {payment?.refundedAt ? ` on ${fmtDate(payment.refundedAt)}` : ''}.
            </span>
          </div>
        )}

        {refundState === 'partially_refunded' && (
          <div className="waves-no-print" style={{
            marginBottom: 16,
            padding: 14,
            borderRadius: 8,
            background: '#EEF6FF',
            border: '1px solid #BFE4F8',
            color: 'var(--text)',
            fontSize: 14,
            lineHeight: 1.5,
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
          }}>
            <Icon name="refresh" size={17} strokeWidth={2} style={{ color: '#065A8C', marginTop: 1 }} />
            <div>
              <div style={{ fontWeight: 850, color: '#065A8C', marginBottom: 3 }}>Partial refund issued</div>
              <div style={{ color: 'var(--text-muted)' }}>
                {fmtCurrency(payment.refundAmount)} refunded
                {payment.refundedAt ? ` on ${fmtDate(payment.refundedAt)}` : ''}
                {' · '}
                Net paid: {fmtCurrency(payment.remainingPaid)}
              </div>
            </div>
          </div>
        )}

        <BrandCard className="waves-print-card" padding={28} style={{ marginBottom: 20 }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 16,
            alignItems: 'flex-start',
            flexWrap: 'wrap',
            marginBottom: 18,
          }}>
            <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', minWidth: 0 }}>
              <span style={{
                width: 46,
                height: 46,
                borderRadius: 8,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                background: statusTone === 'refunded' ? 'rgba(200,16,46,0.08)' : (statusTone === 'processing' || statusTone === 'partial') ? '#EEF6FF' : '#F0FDF4',
                color: statusTone === 'refunded' ? 'var(--danger)' : (statusTone === 'processing' || statusTone === 'partial') ? '#065A8C' : 'var(--success)',
                border: `1px solid ${statusTone === 'refunded' ? 'rgba(200,16,46,0.22)' : (statusTone === 'processing' || statusTone === 'partial') ? '#BFE4F8' : '#BBF7D0'}`,
              }}>
                <Icon name={statusTone === 'processing' ? 'clock' : (statusTone === 'refunded' || statusTone === 'partial') ? 'refresh' : 'check'} size={22} strokeWidth={2.4} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ ...eyebrow, marginBottom: 8 }}>
                  {processing ? 'Payment pending' : 'Receipt'} · Invoice {invoice.invoiceNumber}
                </div>
                <SerifHeading style={{ marginBottom: 8 }}>{heading}</SerifHeading>
                <p style={{ margin: 0, fontSize: 15, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  {serviceLabel}
                  {serviceDateLabel ? ` · ${serviceDateLabel}` : ''}
                </p>
              </div>
            </div>
            <StatusPill tone={statusTone}>{statusLabel}</StatusPill>
          </div>

          <div data-glass-clear="" style={{
            ...subtlePanel,
            padding: 18,
            marginBottom: 20,
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto',
            gap: 18,
            alignItems: 'center',
          }}>
            <div>
              <div style={eyebrow}>{processing ? 'Submitted amount' : 'Receipt total'}</div>
              <div style={{ marginTop: 6, fontSize: 34, lineHeight: 1, fontWeight: 850, color: 'var(--text)', fontFamily: FONTS.body }}>
                {fmtCurrency(chargedTotal)}
              </div>
              <div style={{ marginTop: 8, fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.45 }}>
                {statusDetail}
              </div>
            </div>
            <span data-glass="soft" style={{
              width: 42,
              height: 42,
              borderRadius: 8,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--brand)',
              background: '#FFFFFF',
              border: '1px solid var(--border)',
            }}>
              <Icon name="document" size={20} strokeWidth={2} />
            </span>
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 16,
            marginBottom: 20,
          }}>
            <DetailBlock label="Billed to">
              {payer ? (
                <>
                  <div style={{ fontWeight: 800 }}>{payer.name}</div>
                  {payer.address && <div>{payer.address}</div>}
                  {[payer.city, [payer.state, payer.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') && (
                    <div>{[payer.city, [payer.state, payer.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')}</div>
                  )}
                  {payer.poNumber && <div style={{ color: 'var(--text-muted)' }}>PO: {payer.poNumber}</div>}
                </>
              ) : (
                <>
                  <div style={{ fontWeight: 800 }}>{fullName(customer)}</div>
                  {customer.address && <div>{customer.address}</div>}
                  {locationLine && <div>{locationLine}</div>}
                  {customer.email && <div style={{ color: 'var(--text-muted)' }}>{customer.email}</div>}
                </>
              )}
            </DetailBlock>
            {payer && (
              <DetailBlock label="Service address">
                <div style={{ fontWeight: 800 }}>{fullName(customer)}</div>
                {customer.address && <div>{customer.address}</div>}
                {locationLine && <div>{locationLine}</div>}
              </DetailBlock>
            )}

            <DetailBlock label="Payment details">
              {paidAt && (
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>{processing ? 'Submitted: ' : 'Paid: '}</span>
                  {fmtDate(paidAt)}
                </div>
              )}
              {methodDisplay && (
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>Method: </span>
                  {methodDisplay}
                </div>
              )}
              {service.techName && (
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>Technician: </span>
                  {service.techName}
                </div>
              )}
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Receipt #: </span>
                <span style={{ fontFamily: FONTS.mono, fontSize: 14 }}>{invoice.invoiceNumber}</span>
              </div>
            </DetailBlock>
          </div>

          {visibleLineItems.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ ...eyebrow, marginBottom: 8 }}>Receipt items</div>
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                <div data-glass-clear="" style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto auto',
                  gap: '0 14px',
                  padding: '10px 12px',
                  fontSize: 12,
                  color: 'var(--text-muted)',
                  fontWeight: 850,
                  textTransform: 'uppercase',
                  background: CUSTOMER_SURFACE.page,
                  borderBottom: `1px solid ${CUSTOMER_SURFACE.border}`,
                }}>
                  <div>Description</div>
                  <div style={{ textAlign: 'right' }}>Qty</div>
                  <div style={{ textAlign: 'right', minWidth: 82 }}>Amount</div>
                </div>
                {visibleLineItems.map((item, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto auto',
                      gap: '0 14px',
                      padding: '12px',
                      borderBottom: idx < visibleLineItems.length - 1 ? '1px solid var(--border)' : 'none',
                      fontSize: 14,
                      color: 'var(--text)',
                      alignItems: 'start',
                    }}
                  >
                    <div style={{ lineHeight: 1.45, minWidth: 0 }}>{item.description}</div>
                    <div style={{ textAlign: 'right', fontFamily: FONTS.mono }}>{item.quantity || 1}</div>
                    <div style={{ textAlign: 'right', fontFamily: FONTS.mono, minWidth: 82, fontWeight: 650 }}>
                      {fmtCurrency(item.amount ?? (item.quantity || 1) * (item.unit_price || 0))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div data-glass-clear="" style={{ ...subtlePanel, padding: 16 }}>
            <SummaryRow label="Subtotal" value={fmtCurrency(invoice.subtotal)} />
            {invoice.discountAmount > 0 && (
              <SummaryRow label={invoice.discountLabel || 'Discount'} value={`− ${fmtCurrency(invoice.discountAmount)}`} />
            )}
            {invoice.taxAmount > 0 && customer?.isCommercial && (
              <SummaryRow label={`Tax (${(Number(invoice.taxRate || 0) * 100).toFixed(2)}%)`} value={fmtCurrency(invoice.taxAmount)} />
            )}
            {depositCreditTotal > 0 && (
              <SummaryRow label="Deposit paid at acceptance" value={`− ${fmtCurrency(depositCreditTotal)}`} />
            )}
            {payment?.surchargeAmountCents > 0 && (
              <SummaryRow
                label={`Credit card surcharge${payment.surchargeRateBps > 0 ? ` (${Number((payment.surchargeRateBps / 100).toFixed(2))}%)` : ''}`}
                value={fmtCurrency(payment.surchargeAmountCents / 100)}
              />
            )}
            {invoice.creditApplied > 0 && (
              <SummaryRow label="Account credit applied" value={`− ${fmtCurrency(invoice.creditApplied)}`} />
            )}
            <SummaryRow label={processing ? 'Total submitted' : 'Total charged'} value={fmtCurrency(chargedTotal)} strong />

            {refundState && payment?.refundAmount > 0 && (
              <>
                <SummaryRow
                  label={`Refunded${payment.refundedAt ? ` · ${fmtDate(payment.refundedAt)}` : ''}`}
                  value={`− ${fmtCurrency(payment.refundAmount)}`}
                  danger
                />
                <SummaryRow label="Net paid" value={fmtCurrency(payment.remainingPaid)} strong />
              </>
            )}
          </div>

          {invoice.notes && (
            <div data-glass-clear="" style={{ marginTop: 18, ...subtlePanel, padding: 16 }}>
              <div style={{ ...eyebrow, marginBottom: 8 }}>Notes</div>
              <p style={{ margin: 0, fontSize: 15, color: 'var(--text)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                {invoice.notes}
              </p>
            </div>
          )}

          <div className="waves-no-print" style={{ marginTop: 22, display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 14 }}>
            {hasReceiptPdf ? (
              <a
                href={`${API_BASE}/receipt/${token}/pdf`}
                data-glass="chip" data-glass-pill=""
                style={{
                  minHeight: 40,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '0 12px',
                  borderRadius: 8,
                  border: '1px solid var(--border-strong)',
                  color: 'var(--brand)',
                  textDecoration: 'none',
                  fontSize: 14,
                  fontWeight: 800,
                  background: '#FFFFFF',
                }}
              >
                <Icon name="download" size={16} strokeWidth={2} />
                Receipt PDF
              </a>
            ) : processing ? (
              <span style={{ color: 'var(--text-muted)', alignSelf: 'center' }}>
                Receipt PDF available after bank payment clears
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => window.print()}
              data-glass="chip" data-glass-pill=""
              style={{
                minHeight: 40,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '0 12px',
                borderRadius: 8,
                border: '1px solid var(--border-strong)',
                color: 'var(--brand)',
                background: '#FFFFFF',
                fontSize: 14,
                fontWeight: 800,
                cursor: 'pointer',
                fontFamily: FONTS.body,
              }}
            >
              <Icon name="print" size={16} strokeWidth={2} />
              Print
            </button>
          </div>
        </BrandCard>

        <div className="waves-no-print waves-customer-help">
          Questions about this receipt? <HelpPhoneLink tone="dark" inline /> or reply to the text or email.
        </div>
      </div>
    </WavesShell>
  );
}
