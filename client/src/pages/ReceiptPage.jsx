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
import { CUSTOMER_SURFACE } from '../theme-customer';
import { DOC, DOC_FONT, DOC_EYEBROW, FS, FW, LH, SP, RADIUS } from '../theme-doc';
import { useGlassSurface } from '../glass/glass-engine';
import DocumentActionBar from '../components/DocumentActionBar';
import React, { useState, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import Icon from '../components/Icon';
import {
  WavesShell,
  BrandCard,
  SerifHeading,
  HelpPhoneLink,
} from '../components/brand';
import BrandFooter from '../components/BrandFooter';

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
  borderRadius: RADIUS.input,
};

// The shared uppercase eyebrow spec (DOC_EYEBROW); margin stays a
// per-call-site delta, so zero out the token's default.
const eyebrow = { ...DOC_EYEBROW, marginBottom: 0 };

function fullName(customer = {}) {
  return [customer.firstName, customer.lastName].filter(Boolean).join(' ') || 'Waves customer';
}

function cityStateZip(customer = {}) {
  const region = [customer.state || (customer.city ? 'FL' : ''), customer.zip].filter(Boolean).join(' ');
  return [customer.city, region].filter(Boolean).join(customer.city && region ? ', ' : '');
}

function StatusPill({ tone = 'neutral', children }) {
  const tones = {
    paid: { bg: DOC.successBg, color: DOC.success, border: DOC.successBorder },
    processing: { bg: '#EEF6FF', color: '#065A8C', border: '#BFE4F8' },
    refunded: { bg: 'rgba(200,16,46,0.08)', color: DOC.danger, border: 'rgba(200,16,46,0.22)' },
    partial: { bg: '#EEF6FF', color: '#065A8C', border: '#BFE4F8' },
    neutral: { bg: CUSTOMER_SURFACE.page, color: DOC.ink, border: CUSTOMER_SURFACE.border },
  };
  const t = tones[tone] || tones.neutral;
  const glassClear = t === tones.neutral ? { 'data-glass-clear': '' } : {};
  return (
    <span {...glassClear} style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      minHeight: 28,
      padding: '4px 8px',
      borderRadius: RADIUS.input,
      background: t.bg,
      border: `1px solid ${t.border}`,
      color: t.color,
      fontSize: FS.caption,
      fontWeight: FW.heavy,
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
      <div style={{ ...eyebrow, marginBottom: SP.xs }}>{label}</div>
      <div style={{ fontSize: FS.body, color: DOC.ink, lineHeight: LH.body }}>
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
      gap: SP.md,
      padding: strong ? '12px 0 0' : '8px 0',
      marginTop: strong ? SP.xs : 0,
      borderTop: strong ? `1px solid ${DOC.border}` : 'none',
      color: danger ? DOC.danger : strong ? DOC.ink : DOC.muted,
      fontSize: strong ? FS.lead : FS.body,
      fontWeight: strong ? FW.heavy : danger ? FW.bold : FW.medium,
      fontFamily: DOC_FONT,
    }}>
      <span>{label}</span>
      <span style={{
        color: danger ? DOC.danger : DOC.ink,
        fontFamily: DOC_FONT,
        fontWeight: strong ? FW.heavy : FW.semibold,
        whiteSpace: 'nowrap',
      }}>
        {value}
      </span>
    </div>
  );
}


export default function ReceiptPage() {
  // Full liquid-glass scene (owner 2026-07-09 — the quiet 'pro' wash is
  // retired; the pay lane renders the same scene as every glass surface).
  // Native data-glass markup — no classify() walker on this page.
  useGlassSurface(true, 'full');
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

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
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/receipt/${token}`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) {
          const loadError = new Error(r.status === 404 ? 'Receipt not found' : 'Failed to load');
          loadError.status = r.status;
          throw loadError;
        }
        return r.json();
      })
      .then((d) => { if (!controller.signal.aborted) { setData(d); setLoading(false); } })
      .catch((e) => { if (!controller.signal.aborted) { setError({ message: e.message, status: e.status }); setLoading(false); } });
    return () => controller.abort();
  }, [token, loadAttempt]);

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
        <div style={{ padding: '64px 20px', textAlign: 'center', color: DOC.muted }}>
          Loading receipt…
        </div>
      </WavesShell>
    );
  }

  if (error?.status === 404) {
    return (
      <WavesShell variant="customer" topBar="solid">
        <div style={{ maxWidth: 560, margin: '48px auto', padding: '0 16px' }}>
          <BrandCard>
            <SerifHeading style={{ marginBottom: SP.sm }}>We couldn't find that receipt</SerifHeading>
            <p style={{ margin: 0, fontSize: FS.lead, color: DOC.ink, lineHeight: LH.body }}>
              The link may be mistyped. Give us a call and we'll pull up your records — <HelpPhoneLink tone="dark" inline />.
            </p>
          </BrandCard>
        </div>
      </WavesShell>
    );
  }

  if (error || !data) {
    return (
      <WavesShell variant="customer" topBar="solid">
        <div style={{ maxWidth: 560, margin: '48px auto', padding: '0 16px' }}>
          <BrandCard>
            <SerifHeading style={{ marginBottom: SP.sm }}>We couldn't load that receipt</SerifHeading>
            <p style={{ margin: '0 0 16px', fontSize: FS.lead, color: DOC.ink, lineHeight: LH.body }}>
              This looks temporary. Your link is still valid—try again in a moment.
            </p>
            <button
              type="button"
              onClick={() => setLoadAttempt((attempt) => attempt + 1)}
              style={{ border: 0, borderRadius: RADIUS.input, padding: '11px 16px', background: DOC.ink, color: '#fff', font: 'inherit', fontWeight: FW.bold, cursor: 'pointer' }}
            >
              Try again
            </button>
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
  // Unpaid = the invoice reverted after a failed payment (e.g. an ACH debit
  // bounced post-redirect) — the old neutral state still said "Receipt /
  // Total charged / keep this for your records" for money never collected.
  const unpaid = !paid && !processing && invoice.status !== 'refunded' && !refundState;
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
          : unpaid
            ? 'Not paid'
            : 'Receipt';
  const heading = processing
    ? 'Bank payment submitted'
    : paid
      ? 'Payment received'
      : unpaid
        ? 'Payment not completed'
        : 'Receipt';
  const statusDetail = processing
    ? 'Bank payments usually take 3-5 business days to clear. We will send the final receipt after the payment settles.'
    : refundState === 'fully_refunded'
      ? 'This payment has been fully refunded.'
      : refundState === 'partially_refunded'
        ? `${fmtCurrency(payment.refundAmount)} has been refunded. Net paid: ${fmtCurrency(payment.remainingPaid)}.`
        : unpaid
          ? 'This payment didn’t go through, so the invoice is still open. Please use your payment link to try again, or call us at (941) 297-5749.'
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
              gap: SP.sm,
              marginBottom: SP.lg,
              padding: '20px 16px',
              textAlign: 'center',
            }}
          >
            {/* Checkmark graphic removed (owner 2026-07-09 — no decorative icons on customer document pages). */}
            <div style={{
              fontFamily: DOC_FONT,
              fontWeight: FW.bold,
              fontSize: FS.h2,
              color: DOC.ink,
              lineHeight: LH.heading,
            }}>
              {heading}
            </div>
            <div style={{ fontSize: FS.body, color: DOC.muted }}>
              {processing
                ? `Thanks, ${customer.firstName || 'there'} - your bank payment is processing.`
                : `Thanks, ${customer.firstName || 'there'} - a receipt is on its way to you.`}
            </div>
          </div>
        )}

        {consentFailed && (
          <div className="waves-no-print" style={{
            marginBottom: SP.md,
            padding: SP.md,
            borderRadius: RADIUS.input,
            background: 'rgba(200,16,46,0.06)',
            border: '1px solid rgba(200,16,46,0.28)',
            color: DOC.ink,
            fontSize: FS.body,
            lineHeight: LH.body,
            display: 'flex',
            gap: SP.sm,
            alignItems: 'flex-start',
          }}>
            <Icon name="warning" size={17} strokeWidth={2} style={{ color: DOC.danger, marginTop: 1, flexShrink: 0 }} />
            <div>
              <div style={{ fontWeight: FW.heavy, color: DOC.danger, marginBottom: SP.xxs }}>Save-on-file authorization not recorded</div>
              <div style={{ color: DOC.muted }}>
                Your payment went through, but we couldn't record your authorization to save this payment method on file. Waves will reach out to confirm before any future charge. Questions: call <HelpPhoneLink tone="dark" inline />.
              </div>
            </div>
          </div>
        )}

        {refundState === 'fully_refunded' && (
          <div className="waves-no-print" style={{
            marginBottom: SP.md,
            padding: SP.md,
            borderRadius: RADIUS.input,
            background: 'rgba(200,16,46,0.06)',
            border: '1px solid rgba(200,16,46,0.28)',
            color: DOC.danger,
            fontSize: FS.body,
            fontWeight: FW.bold,
            display: 'flex',
            alignItems: 'center',
            gap: SP.sm,
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
            marginBottom: SP.md,
            padding: SP.md,
            borderRadius: RADIUS.input,
            background: '#EEF6FF',
            border: '1px solid #BFE4F8',
            color: DOC.ink,
            fontSize: FS.body,
            lineHeight: LH.body,
            display: 'flex',
            gap: SP.sm,
            alignItems: 'flex-start',
          }}>
            <Icon name="refresh" size={17} strokeWidth={2} style={{ color: '#065A8C', marginTop: 1 }} />
            <div>
              <div style={{ fontWeight: FW.heavy, color: '#065A8C', marginBottom: SP.xxs }}>Partial refund issued</div>
              <div style={{ color: DOC.muted }}>
                {fmtCurrency(payment.refundAmount)} refunded
                {payment.refundedAt ? ` on ${fmtDate(payment.refundedAt)}` : ''}
                {' · '}
                Net paid: {fmtCurrency(payment.remainingPaid)}
              </div>
            </div>
          </div>
        )}

        <DocumentActionBar
          pdfUrl={hasReceiptPdf ? `${API_BASE}/receipt/${token}/pdf` : null}
          pdfFileName="Waves_Receipt.pdf"
          shareTitle="Waves receipt"
        />
        <BrandCard className="waves-print-card" padding={28} style={{ marginBottom: SP.lg }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: SP.md,
            alignItems: 'flex-start',
            flexWrap: 'wrap',
            marginBottom: SP.lg,
          }}>
            <div style={{ display: 'flex', gap: SP.md, alignItems: 'flex-start', minWidth: 0 }}>
              {/* Status icon tile removed (owner 2026-07-09 — no decorative icons). */}
              <div style={{ minWidth: 0 }}>
                <div style={{ ...eyebrow, marginBottom: SP.xs }}>
                  {processing ? 'Payment pending' : 'Receipt'} · Invoice {invoice.invoiceNumber}
                </div>
                <SerifHeading style={{ marginBottom: SP.xs }}>{heading}</SerifHeading>
                <p style={{ margin: 0, fontSize: FS.bodyLg, color: DOC.muted, lineHeight: LH.body }}>
                  {serviceLabel}
                  {serviceDateLabel ? ` · ${serviceDateLabel}` : ''}
                </p>
              </div>
            </div>
            <StatusPill tone={statusTone}>{statusLabel}</StatusPill>
          </div>

          <div data-glass-clear="" style={{
            ...subtlePanel,
            padding: SP.md,
            marginBottom: SP.lg,
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto',
            gap: SP.lg,
            alignItems: 'center',
          }}>
            <div>
              <div style={eyebrow}>{processing ? 'Submitted amount' : unpaid ? 'Amount due' : 'Receipt total'}</div>
              <div style={{ marginTop: 6, fontSize: FS.h1, lineHeight: LH.solid, fontWeight: FW.heavy, color: DOC.ink, fontFamily: DOC_FONT }}>
                {fmtCurrency(chargedTotal)}
              </div>
              <div style={{ marginTop: SP.xs, fontSize: FS.body, color: DOC.muted, lineHeight: LH.body }}>
                {statusDetail}
              </div>
            </div>
            {/* Document icon tile removed (owner 2026-07-09 — no decorative icons). */}
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: SP.md,
            marginBottom: SP.lg,
          }}>
            <DetailBlock label="Billed to">
              {payer ? (
                <>
                  <div style={{ fontWeight: FW.heavy }}>{payer.name}</div>
                  {payer.address && <div>{payer.address}</div>}
                  {[payer.city, [payer.state, payer.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') && (
                    <div>{[payer.city, [payer.state, payer.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')}</div>
                  )}
                  {payer.poNumber && <div style={{ color: DOC.muted }}>PO: {payer.poNumber}</div>}
                </>
              ) : (
                <>
                  <div style={{ fontWeight: FW.heavy }}>{fullName(customer)}</div>
                  {customer.address && <div>{customer.address}</div>}
                  {locationLine && <div>{locationLine}</div>}
                  {customer.email && <div style={{ color: DOC.muted }}>{customer.email}</div>}
                </>
              )}
            </DetailBlock>
            {payer && (
              <DetailBlock label="Service address">
                <div style={{ fontWeight: FW.heavy }}>{fullName(customer)}</div>
                {customer.address && <div>{customer.address}</div>}
                {locationLine && <div>{locationLine}</div>}
              </DetailBlock>
            )}

            <DetailBlock label="Payment details">
              {paidAt && (
                <div>
                  <span style={{ color: DOC.muted }}>{processing ? 'Submitted: ' : 'Paid: '}</span>
                  {fmtDate(paidAt)}
                </div>
              )}
              {methodDisplay && (
                <div>
                  <span style={{ color: DOC.muted }}>Method: </span>
                  {methodDisplay}
                </div>
              )}
              {service.techName && (
                <div>
                  <span style={{ color: DOC.muted }}>Technician: </span>
                  {service.techName}
                </div>
              )}
              <div>
                <span style={{ color: DOC.muted }}>Receipt #: </span>
                <span style={{ fontFamily: DOC_FONT, fontSize: FS.body }}>{invoice.invoiceNumber}</span>
              </div>
            </DetailBlock>
          </div>

          {visibleLineItems.length > 0 && (
            <div style={{ marginBottom: SP.lg }}>
              <div style={{ ...eyebrow, marginBottom: SP.xs }}>Receipt items</div>
              <div style={{ border: `1px solid ${DOC.border}`, borderRadius: RADIUS.input, overflow: 'hidden' }}>
                <div data-glass-clear="" style={{
                  ...eyebrow,
                  display: 'grid',
                  gridTemplateColumns: '1fr auto auto',
                  gap: '0 16px',
                  padding: '12px',
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
                      gap: '0 16px',
                      padding: '12px',
                      borderBottom: idx < visibleLineItems.length - 1 ? `1px solid ${DOC.border}` : 'none',
                      fontSize: FS.body,
                      color: DOC.ink,
                      alignItems: 'start',
                    }}
                  >
                    <div style={{ lineHeight: LH.snug, minWidth: 0 }}>{item.description}</div>
                    <div style={{ textAlign: 'right', fontFamily: DOC_FONT }}>{item.quantity || 1}</div>
                    <div style={{ textAlign: 'right', fontFamily: DOC_FONT, minWidth: 82, fontWeight: FW.semibold }}>
                      {fmtCurrency(item.amount ?? (item.quantity || 1) * (item.unit_price || 0))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div data-glass-clear="" style={{ ...subtlePanel, padding: SP.md }}>
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
            <SummaryRow label={processing ? 'Total submitted' : unpaid ? 'Amount due' : 'Total charged'} value={fmtCurrency(chargedTotal)} strong />

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
            <div data-glass-clear="" style={{ marginTop: SP.lg, ...subtlePanel, padding: SP.md }}>
              <div style={{ ...eyebrow, marginBottom: SP.xs }}>Notes</div>
              <p style={{ margin: 0, fontSize: FS.bodyLg, color: DOC.ink, lineHeight: LH.body, whiteSpace: 'pre-wrap' }}>
                {invoice.notes}
              </p>
            </div>
          )}

          {/* In-card PDF/Print chips superseded by the DocumentActionBar at
              the top of the page (owner 2026-07-09). The processing note
              stays — it explains the missing Download button. */}
          {!hasReceiptPdf && processing ? (
            <div className="waves-no-print" style={{ marginTop: SP.xl, fontSize: FS.body, color: DOC.muted }}>
              Receipt PDF available after bank payment clears
            </div>
          ) : null}
        </BrandCard>

        <div className="waves-no-print waves-customer-help">
          Questions about this receipt? <HelpPhoneLink tone="dark" inline /> or reply to the text or email.
        </div>
        {/* Newsletter signup lives only on the newsletter pages (owner
            2026-07-09, supersedes the 2026-07-08 glass-footer ruling).
            Hidden from the receipt printout via waves-no-print. */}
        <div className="waves-no-print">
          <BrandFooter />
        </div>
      </div>
    </WavesShell>
  );
}
