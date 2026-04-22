import React, { useState, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
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

function fmtDate(d) {
  if (!d) return '';
  const dt = typeof d === 'string'
    ? new Date(d.length === 10 ? d + 'T12:00:00' : d)
    : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
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
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // ── ?fresh=1 animation — fires ONCE on first mount, then strips the param
  // from the URL so cmd-R refresh doesn't re-trigger the badge animation.
  const [showFreshBadge, setShowFreshBadge] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('fresh') === '1') {
      setShowFreshBadge(true);
      params.delete('fresh');
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
              The link may be mistyped. Give us a call and we'll pull up your records —
              {' '}<HelpPhoneLink tone="dark" />.
            </p>
          </BrandCard>
        </div>
      </WavesShell>
    );
  }

  const { invoice, service, customer, payment } = data;
  const paid = invoice.status === 'paid';
  const paidAt = invoice.paidAt || payment?.paymentDate;
  const methodDisplay = payment?.cardBrand && payment?.cardLastFour
    ? `${payment.cardBrand.toUpperCase()} ···· ${payment.cardLastFour}`
    : (invoice.cardBrand && invoice.cardLastFour
      ? `${invoice.cardBrand.toUpperCase()} ···· ${invoice.cardLastFour}`
      : null);

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

      <div className="waves-print-root" style={{ maxWidth: 640, margin: '32px auto 64px', padding: '0 16px' }}>
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
              fontFamily: "'Instrument Serif', Georgia, serif",
              fontSize: 24,
              color: 'var(--text)',
              lineHeight: 1.2,
            }}>
              Payment received
            </div>
            <div style={{ fontSize: 14, color: 'var(--text-muted)' }}>
              Thanks, {customer.firstName || 'there'} — a receipt is on its way to you.
            </div>
          </div>
        )}

        {refundState === 'fully_refunded' && (
          <div className="waves-no-print" style={{
            marginBottom: 16,
            padding: '12px 16px',
            borderRadius: 'var(--radius-md)',
            background: 'rgba(200,16,46,0.06)',
            border: '1px solid var(--danger)',
            color: 'var(--danger)',
            fontSize: 14,
            fontWeight: 500,
          }}>
            This payment has been fully refunded
            {payment?.refundedAt ? ` on ${fmtDate(payment.refundedAt)}` : ''}.
          </div>
        )}

        {refundState === 'partially_refunded' && (
          <div className="waves-no-print" style={{
            marginBottom: 16,
            padding: '12px 16px',
            borderRadius: 'var(--radius-md)',
            background: 'rgba(0,156,222,0.08)',
            border: '1px solid rgba(0,156,222,0.35)',
            color: 'var(--text)',
            fontSize: 14,
            lineHeight: 1.5,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Partial refund issued</div>
            <div style={{ color: 'var(--text-muted)' }}>
              {fmtCurrency(payment.refundAmount)} refunded
              {payment.refundedAt ? ` on ${fmtDate(payment.refundedAt)}` : ''}
              {' · '}
              Net paid: {fmtCurrency(payment.remainingPaid)}
            </div>
          </div>
        )}

        <BrandCard className="waves-print-card" padding={32} style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Receipt · Invoice {invoice.invoiceNumber}
            </div>
            {paid && !refundState && (
              <span style={{
                display: 'inline-block',
                padding: '4px 10px',
                borderRadius: 999,
                background: 'rgba(4,120,87,0.1)',
                color: 'var(--success)',
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}>
                Paid
              </span>
            )}
            {refundState === 'fully_refunded' && (
              <span style={{
                display: 'inline-block',
                padding: '4px 10px',
                borderRadius: 999,
                background: 'rgba(200,16,46,0.08)',
                color: 'var(--danger)',
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}>
                Refunded
              </span>
            )}
            {refundState === 'partially_refunded' && (
              <span style={{
                display: 'inline-block',
                padding: '4px 10px',
                borderRadius: 999,
                background: 'rgba(0,156,222,0.1)',
                color: '#065A8C',
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}>
                Partial refund
              </span>
            )}
          </div>

          <SerifHeading style={{ marginBottom: 4 }}>
            {paid ? 'Payment received' : 'Receipt'}
          </SerifHeading>
          <p style={{ margin: '0 0 24px', fontSize: 16, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {invoice.title || service.type || 'Service'}
            {service.date ? ` · ${fmtDate(service.date)}` : ''}
          </p>

          {/* Receipt meta grid — bill-to + payment details, two columns on wide,
              stacks on mobile */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 24,
            marginBottom: 24,
            fontSize: 14,
            lineHeight: 1.6,
            color: 'var(--text)',
          }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>
                Billed to
              </div>
              <div style={{ fontWeight: 600 }}>{customer.firstName} {customer.lastName}</div>
              {customer.address && <div>{customer.address}</div>}
              {(customer.city || customer.state || customer.zip) && (
                <div>{customer.city}{customer.city ? ', ' : ''}{customer.state || 'FL'} {customer.zip || ''}</div>
              )}
              {customer.email && <div style={{ color: 'var(--text-muted)' }}>{customer.email}</div>}
            </div>

            <div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>
                Payment details
              </div>
              {paidAt && (
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>Paid: </span>
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
                <span style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 13 }}>
                  {invoice.invoiceNumber}
                </span>
              </div>
            </div>
          </div>

          {/* Line items — mirrors PayPageV2 for visual continuity */}
          {invoice.lineItems?.length > 0 && (
            <div style={{ marginBottom: 20, borderTop: '1px solid var(--border)' }}>
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto auto',
                gap: '0 16px',
                padding: '12px 0 8px',
                fontSize: 11,
                color: 'var(--text-muted)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                borderBottom: '1px solid var(--border)',
              }}>
                <div>Description</div>
                <div style={{ textAlign: 'right' }}>Qty</div>
                <div style={{ textAlign: 'right', minWidth: 80 }}>Amount</div>
              </div>
              {invoice.lineItems.map((item, idx) => (
                <div
                  key={idx}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto auto',
                    gap: '0 16px',
                    padding: '12px 0',
                    borderBottom: idx < invoice.lineItems.length - 1 ? '1px solid var(--border)' : 'none',
                    fontSize: 14,
                    color: 'var(--text)',
                  }}
                >
                  <div style={{ lineHeight: 1.4 }}>{item.description}</div>
                  <div style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
                    {item.quantity || 1}
                  </div>
                  <div style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', ui-monospace, monospace", minWidth: 80 }}>
                    {fmtCurrency(item.amount ?? (item.quantity || 1) * (item.unit_price || 0))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Totals + refund breakdown (original transaction is never hidden) */}
          <div style={{ fontSize: 14, fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
              <span style={{ color: 'var(--text-muted)', fontFamily: "'Inter', system-ui, sans-serif" }}>
                Subtotal
              </span>
              <span>{fmtCurrency(invoice.subtotal)}</span>
            </div>
            {invoice.discountAmount > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
                <span style={{ color: 'var(--text-muted)', fontFamily: "'Inter', system-ui, sans-serif" }}>
                  {invoice.discountLabel || 'Discount'}
                </span>
                <span>− {fmtCurrency(invoice.discountAmount)}</span>
              </div>
            )}
            {invoice.taxAmount > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0' }}>
                <span style={{ color: 'var(--text-muted)', fontFamily: "'Inter', system-ui, sans-serif" }}>
                  Tax ({(Number(invoice.taxRate || 0) * 100).toFixed(2)}%)
                </span>
                <span>{fmtCurrency(invoice.taxAmount)}</span>
              </div>
            )}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '12px 0 0',
              marginTop: 8,
              borderTop: '1px solid var(--border)',
              fontSize: 20,
              fontWeight: 700,
              color: 'var(--text)',
            }}>
              <span style={{ fontFamily: "'Inter', system-ui, sans-serif", letterSpacing: '0.06em', textTransform: 'uppercase', fontSize: 13 }}>
                Total charged
              </span>
              <span>{fmtCurrency(payment?.amount || invoice.total)}</span>
            </div>

            {refundState && payment?.refundAmount > 0 && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 6px' }}>
                  <span style={{ color: 'var(--danger)', fontFamily: "'Inter', system-ui, sans-serif", fontWeight: 500 }}>
                    Refunded
                    {payment.refundedAt ? ` · ${fmtDate(payment.refundedAt)}` : ''}
                  </span>
                  <span style={{ color: 'var(--danger)' }}>− {fmtCurrency(payment.refundAmount)}</span>
                </div>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '10px 0 0',
                  marginTop: 4,
                  borderTop: '1px solid var(--border)',
                  fontSize: 16,
                  fontWeight: 700,
                  color: 'var(--text)',
                }}>
                  <span style={{ fontFamily: "'Inter', system-ui, sans-serif", letterSpacing: '0.06em', textTransform: 'uppercase', fontSize: 12 }}>
                    Net paid
                  </span>
                  <span>{fmtCurrency(payment.remainingPaid)}</span>
                </div>
              </>
            )}
          </div>

          {invoice.notes && (
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>
                Notes
              </div>
              <p style={{ margin: 0, fontSize: 14, color: 'var(--text)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                {invoice.notes}
              </p>
            </div>
          )}

          <div className="waves-no-print" style={{ marginTop: 24, display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 13 }}>
            <a
              href={`${API_BASE}/receipt/${token}/pdf`}
              style={{ color: 'var(--brand)', textDecoration: 'underline', textUnderlineOffset: 3 }}
            >
              Download receipt PDF
            </a>
            <button
              type="button"
              onClick={() => window.print()}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                color: 'var(--brand)',
                textDecoration: 'underline',
                textUnderlineOffset: 3,
                fontSize: 13,
                cursor: 'pointer',
                fontFamily: "'Inter', system-ui, sans-serif",
              }}
            >
              Print
            </button>
            {invoice.stripeReceiptUrl && (
              <a
                href={invoice.stripeReceiptUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--text-muted)', textDecoration: 'underline', textUnderlineOffset: 3 }}
              >
                Stripe receipt
              </a>
            )}
          </div>
        </BrandCard>

        <div className="waves-no-print" style={{ marginTop: 28, textAlign: 'center', fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          Questions about this receipt? <HelpPhoneLink tone="dark" /> or reply to the text or email.
        </div>
      </div>
    </WavesShell>
  );
}
