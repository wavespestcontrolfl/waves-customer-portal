import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// Waves brand palette
const W = {
  blue: '#1565C0', blueBright: '#2196F3', bluePale: '#E3F2FD',
  red: '#A83B34', yellow: '#FDD835',
  teal: '#0ea5e9', green: '#4CAF50', greenLight: '#E8F5E9',
  navy: '#1E1E2B', textBody: '#455A64', textCaption: '#90A4AE',
  white: '#FFFFFF', offWhite: '#F8FAFB', sand: '#FDF6EC',
  border: '#E0E0E0', borderLight: '#F0F0F0',
};

const TIER_COLORS = {
  Bronze: { bg: '#F5E6D3', text: '#8D6E63', accent: '#A1887F' },
  Silver: { bg: '#ECEFF1', text: '#607D8B', accent: '#90A4AE' },
  Gold: { bg: '#FFF8E1', text: '#F9A825', accent: '#FFD54F' },
  Platinum: { bg: '#F3F1F0', text: '#6D6D6D', accent: '#E5E4E2' },
};

export default function PayPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [paymentState, setPaymentState] = useState('idle'); // idle, loading-sdk, ready, processing, success, error
  const [paymentError, setPaymentError] = useState(null);
  const [paymentResult, setPaymentResult] = useState(null);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 600);
  const cardRef = useRef(null);
  const paymentsRef = useRef(null);
  const cardInstanceRef = useRef(null);
  const applePayRef = useRef(null);
  const googlePayRef = useRef(null);
  const achRef = useRef(null);

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 600);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  // Load invoice data
  useEffect(() => {
    fetch(`${API_BASE}/pay/${token}`)
      .then(r => { if (!r.ok) throw new Error(r.status === 404 ? 'Invoice not found' : 'Failed to load'); return r.json(); })
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [token]);

  // Initialize Square Web Payments SDK
  const initSquare = useCallback(async () => {
    if (!data?.square?.appId || !data?.square?.locationId) return;
    if (data.invoice.status === 'paid') return;

    setPaymentState('loading-sdk');

    // Load Square SDK script
    if (!document.getElementById('square-web-payments-sdk')) {
      const script = document.createElement('script');
      script.id = 'square-web-payments-sdk';
      script.src = data.square.environment === 'production'
        ? 'https://web.squarecdn.com/v1/square.js'
        : 'https://sandbox.web.squarecdn.com/v1/square.js';
      script.async = true;
      document.head.appendChild(script);
      await new Promise((resolve, reject) => {
        script.onload = resolve;
        script.onerror = () => reject(new Error('Failed to load Square SDK'));
      });
    }

    try {
      const payments = window.Square.payments(data.square.appId, data.square.locationId);
      paymentsRef.current = payments;

      // Card form
      const card = await payments.card();
      await card.attach(cardRef.current);
      cardInstanceRef.current = card;

      // Apple Pay (if available)
      try {
        const applePayReq = payments.paymentRequest({
          countryCode: 'US', currencyCode: 'USD',
          total: { amount: String(Math.round(data.invoice.total * 100)), label: 'Waves Pest Control' },
        });
        const applePay = await payments.applePay(applePayReq);
        applePayRef.current = applePay;
      } catch { /* Apple Pay not available */ }

      // Google Pay (if available)
      try {
        const googlePayReq = payments.paymentRequest({
          countryCode: 'US', currencyCode: 'USD',
          total: { amount: String(Math.round(data.invoice.total * 100)), label: 'Waves Pest Control' },
        });
        const googlePay = await payments.googlePay(googlePayReq);
        await googlePay.attach('#google-pay-button');
        googlePayRef.current = googlePay;
      } catch { /* Google Pay not available */ }

      // ACH
      try {
        const ach = await payments.ach();
        achRef.current = ach;
      } catch { /* ACH not available */ }

      setPaymentState('ready');
    } catch (err) {
      console.error('Square init failed:', err);
      setPaymentState('error');
      setPaymentError('Payment form failed to load. Please refresh and try again.');
    }
  }, [data]);

  useEffect(() => { if (data) initSquare(); }, [data, initSquare]);

  // Process payment
  const handlePay = async (method = 'card') => {
    setPaymentState('processing');
    setPaymentError(null);

    try {
      let result;
      if (method === 'card' && cardInstanceRef.current) {
        result = await cardInstanceRef.current.tokenize();
      } else if (method === 'apple_pay' && applePayRef.current) {
        result = await applePayRef.current.tokenize();
      } else if (method === 'google_pay' && googlePayRef.current) {
        result = await googlePayRef.current.tokenize();
      } else if (method === 'ach' && achRef.current) {
        result = await achRef.current.tokenize({
          accountHolderName: `${data.customer.firstName} ${data.customer.lastName}`,
        });
      }

      if (!result || result.status !== 'OK') {
        throw new Error(result?.errors?.[0]?.message || 'Card tokenization failed');
      }

      const res = await fetch(`${API_BASE}/pay/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceId: result.token,
          verificationToken: result.verificationToken,
          paymentMethod: method,
        }),
      });

      const payResult = await res.json();
      if (!res.ok) throw new Error(payResult.error || 'Payment failed');

      setPaymentState('success');
      setPaymentResult(payResult);
    } catch (err) {
      setPaymentState('ready');
      setPaymentError(err.message);
    }
  };

  // ── Loading ──
  if (loading) return (
    <div style={{ minHeight: '100vh', background: W.offWhite, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ width: 40, height: 40, border: `3px solid ${W.border}`, borderTopColor: W.blue, borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 16px' }} />
        <div style={{ color: W.textCaption, fontFamily: "'Poppins', sans-serif", fontSize: 14 }}>Loading your service details...</div>
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    </div>
  );

  // ── Error ──
  if (error) return (
    <div style={{ minHeight: '100vh', background: W.offWhite, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ textAlign: 'center', maxWidth: 400 }}>
        <div style={{ fontFamily: "'Montserrat', sans-serif", fontSize: 20, fontWeight: 700, color: W.navy, marginBottom: 8 }}>Invoice Not Found</div>
        <div style={{ fontFamily: "'Poppins', sans-serif", fontSize: 14, color: W.textBody }}>This link may have expired or the invoice has been removed. Contact us at <a href="tel:+19413187612" style={{ color: W.blue }}>(941) 318-7612</a> if you need help.</div>
      </div>
    </div>
  );

  const { invoice, service, customer, square } = data;
  const isPaid = invoice.status === 'paid';
  const tier = customer.tier;
  const tierColors = TIER_COLORS[tier] || TIER_COLORS.Bronze;

  return (
    <div style={{ minHeight: '100vh', background: W.offWhite, fontFamily: "'Poppins', sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Poppins:wght@400;500;600&display=swap" rel="stylesheet" />

      {/* ── Header ── */}
      <div style={{ background: `linear-gradient(135deg, ${W.blue} 0%, ${W.navy} 100%)`, padding: isMobile ? '24px 16px 32px' : '32px 24px 40px', textAlign: 'center', position: 'relative', overflow: 'hidden' }}>
        {/* Wave texture */}
        <div style={{ position: 'absolute', bottom: -2, left: 0, right: 0, height: 30 }}>
          <svg viewBox="0 0 1440 60" fill="none" style={{ width: '100%', height: '100%', display: 'block' }}>
            <path d="M0 30 C360 0 720 60 1080 30 C1260 15 1380 0 1440 10 L1440 60 L0 60 Z" fill={W.offWhite} />
          </svg>
        </div>
        <div style={{ fontSize: isMobile ? 24 : 28, fontFamily: "'Montserrat', sans-serif", fontWeight: 800, color: W.white, letterSpacing: -0.5 }}>WAVES</div>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', letterSpacing: 2, textTransform: 'uppercase', marginTop: 2 }}>Pest Control</div>
      </div>

      <div style={{ maxWidth: 560, margin: '0 auto', padding: isMobile ? '0 12px 40px' : '0 16px 60px' }}>

        {/* ── Status Banner ── */}
        {isPaid && (
          <div style={{ background: W.greenLight, border: `1px solid ${W.green}`, borderRadius: 12, padding: '16px 20px', marginTop: -16, marginBottom: 20, textAlign: 'center' }}>
            <div style={{ fontFamily: "'Montserrat', sans-serif", fontWeight: 700, fontSize: 16, color: '#2E7D32' }}>Payment Received</div>
            <div style={{ fontSize: 13, color: W.textBody, marginTop: 4 }}>
              Paid {invoice.paidAt ? new Date(invoice.paidAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : ''}
              {invoice.cardBrand && invoice.cardLastFour ? ` -- ${invoice.cardBrand} ****${invoice.cardLastFour}` : ''}
            </div>
          </div>
        )}

        {/* ── Customer Greeting ── */}
        <div style={{ marginTop: isPaid ? 0 : -8, marginBottom: 24 }}>
          <div style={{ fontFamily: "'Montserrat', sans-serif", fontSize: isMobile ? 18 : 22, fontWeight: 700, color: W.navy }}>
            {isPaid ? `Thank you, ${customer.firstName}!` : `Hi ${customer.firstName}!`}
          </div>
          <div style={{ fontSize: 14, color: W.textBody, marginTop: 4 }}>
            {isPaid
              ? 'Here\'s a summary of your recent service.'
              : `Here's everything from your ${service.type || 'service'} today.`
            }
          </div>
        </div>

        {/* ── Service Recap Card ── */}
        {(service.type || service.techName) && (
          <div style={{ background: W.white, borderRadius: 16, border: `1px solid ${W.border}`, overflow: 'hidden', marginBottom: 20 }}>
            <div style={{ background: W.bluePale, padding: '16px 20px', borderBottom: `1px solid ${W.border}` }}>
              <div style={{ fontFamily: "'Montserrat', sans-serif", fontWeight: 700, fontSize: 15, color: W.navy }}>Service Completed</div>
              <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 13, color: W.textBody, flexWrap: 'wrap' }}>
                {service.date && <span>{new Date(service.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</span>}
                {service.techName && <span>Tech: {service.techName}</span>}
              </div>
            </div>

            <div style={{ padding: isMobile ? 14 : 20 }}>
              {/* Products Applied */}
              {service.productsApplied?.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: W.textCaption, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>Products Applied</div>
                  {service.productsApplied.map((p, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '8px 0', borderBottom: i < service.productsApplied.length - 1 ? `1px solid ${W.borderLight}` : 'none' }}>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 500, color: W.navy }}>{p.product_name}</div>
                        {p.active_ingredient && <div style={{ fontSize: 12, color: W.textCaption }}>Active: {p.active_ingredient}</div>}
                      </div>
                      {p.application_rate && (
                        <div style={{ fontSize: 12, color: W.textCaption, whiteSpace: 'nowrap', marginLeft: 12 }}>
                          {p.application_rate} {p.rate_unit}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Tech Notes */}
              {service.techNotes && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: W.textCaption, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>Tech Notes</div>
                  <div style={{ fontSize: 14, color: W.textBody, lineHeight: 1.6, background: W.offWhite, padding: 14, borderRadius: 10, borderLeft: `3px solid ${W.blue}` }}>
                    {service.techNotes}
                  </div>
                </div>
              )}

              {/* Before/After Photos */}
              {service.photos?.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: W.textCaption, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>Service Photos</div>
                  <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 }}>
                    {service.photos.map((photo, i) => (
                      <div key={i} style={{ position: 'relative', borderRadius: 10, overflow: 'hidden', aspectRatio: '4/3', background: W.borderLight }}>
                        <img src={photo.s3_url} alt={photo.caption || photo.photo_type} loading="lazy"
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        <div style={{
                          position: 'absolute', bottom: 0, left: 0, right: 0, padding: '4px 8px',
                          background: 'linear-gradient(transparent, rgba(0,0,0,0.6))', fontSize: 10, color: W.white, textTransform: 'uppercase',
                        }}>{photo.photo_type}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Invoice Card ── */}
        <div style={{ background: W.white, borderRadius: 16, border: `1px solid ${W.border}`, overflow: 'hidden', marginBottom: 20 }}>
          <div style={{ padding: '16px 20px', borderBottom: `1px solid ${W.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontFamily: "'Montserrat', sans-serif", fontWeight: 700, fontSize: 15, color: W.navy }}>Invoice</div>
              <div style={{ fontSize: 12, color: W.textCaption, marginTop: 2 }}>{invoice.invoiceNumber}</div>
            </div>
            {invoice.dueDate && !isPaid && (
              <div style={{ fontSize: 12, color: W.textCaption }}>Due {new Date(invoice.dueDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
            )}
          </div>

          <div style={{ padding: isMobile ? 14 : 20 }}>
            {/* Line Items */}
            {invoice.lineItems?.map((item, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: i < invoice.lineItems.length - 1 ? `1px solid ${W.borderLight}` : 'none' }}>
                <div>
                  <div style={{ fontSize: 14, color: W.navy, fontWeight: 500 }}>{item.description}</div>
                  {item.quantity > 1 && <div style={{ fontSize: 12, color: W.textCaption }}>{item.quantity} x ${item.unit_price.toFixed(2)}</div>}
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: W.navy, whiteSpace: 'nowrap' }}>${(item.quantity * item.unit_price).toFixed(2)}</div>
              </div>
            ))}

            {/* Totals */}
            <div style={{ borderTop: `2px solid ${W.border}`, marginTop: 12, paddingTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: W.textBody, marginBottom: 6 }}>
                <span>Subtotal</span><span>${invoice.subtotal.toFixed(2)}</span>
              </div>

              {invoice.discountAmount > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                  <span style={{ color: W.green, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ background: tierColors.bg, color: tierColors.text, fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 600 }}>{tier}</span>
                    {invoice.discountLabel}
                  </span>
                  <span style={{ color: W.green, fontWeight: 600 }}>-${invoice.discountAmount.toFixed(2)}</span>
                </div>
              )}

              {invoice.taxAmount > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: W.textBody, marginBottom: 6 }}>
                  <span>Tax ({(invoice.taxRate * 100).toFixed(1)}%)</span><span>${invoice.taxAmount.toFixed(2)}</span>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: isMobile ? 18 : 20, fontFamily: "'Montserrat', sans-serif", fontWeight: 800, color: W.navy, marginTop: 8, paddingTop: 8, borderTop: `2px solid ${W.navy}` }}>
                <span>Total</span><span>${invoice.total.toFixed(2)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* ── Payment Section ── */}
        {!isPaid && paymentState !== 'success' && (
          <div style={{ background: W.white, borderRadius: 16, border: `1px solid ${W.border}`, overflow: 'hidden', marginBottom: 20 }}>
            <div style={{ padding: '16px 20px', borderBottom: `1px solid ${W.border}` }}>
              <div style={{ fontFamily: "'Montserrat', sans-serif", fontWeight: 700, fontSize: 15, color: W.navy }}>Pay Now</div>
              <div style={{ fontSize: 12, color: W.textCaption, marginTop: 2 }}>Secure payment powered by Square</div>
            </div>

            <div style={{ padding: isMobile ? 14 : 20 }}>
              {/* Digital wallets */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                {applePayRef.current && (
                  <button onClick={() => handlePay('apple_pay')} disabled={paymentState === 'processing'}
                    style={{ flex: 1, padding: 14, background: '#000', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>
                    Apple Pay
                  </button>
                )}
                <div id="google-pay-button" style={{ flex: 1 }} />
              </div>

              {(applePayRef.current || googlePayRef.current) && (
                <div style={{ textAlign: 'center', color: W.textCaption, fontSize: 12, margin: '12px 0', position: 'relative' }}>
                  <span style={{ background: W.white, padding: '0 12px', position: 'relative', zIndex: 1 }}>or pay with card</span>
                  <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 1, background: W.border }} />
                </div>
              )}

              {/* Card form */}
              <div ref={cardRef} style={{ minHeight: 90, marginBottom: 16 }} />

              {/* ACH option */}
              {achRef.current && (
                <button onClick={() => handlePay('ach')} disabled={paymentState === 'processing'}
                  style={{ width: '100%', padding: 12, background: 'transparent', border: `1px solid ${W.border}`, borderRadius: 10, color: W.textBody, fontSize: 13, cursor: 'pointer', marginBottom: 12 }}>
                  Pay with bank account (ACH)
                </button>
              )}

              {paymentError && (
                <div style={{ background: '#FFF3F3', border: `1px solid ${W.red}`, borderRadius: 10, padding: '10px 14px', fontSize: 13, color: W.red, marginBottom: 12 }}>
                  {paymentError}
                </div>
              )}

              <button onClick={() => handlePay('card')} disabled={paymentState !== 'ready'}
                style={{
                  width: '100%', padding: 16, background: paymentState === 'processing' ? W.textCaption : W.blue,
                  color: W.white, border: 'none', borderRadius: 12,
                  fontFamily: "'Montserrat', sans-serif", fontWeight: 700, fontSize: 16,
                  cursor: paymentState === 'ready' ? 'pointer' : 'default',
                  opacity: paymentState === 'ready' ? 1 : 0.6,
                  transition: 'all 0.2s',
                }}>
                {paymentState === 'processing' ? 'Processing...'
                  : paymentState === 'loading-sdk' ? 'Loading payment form...'
                    : `Pay $${invoice.total.toFixed(2)}`}
              </button>

              <div style={{ textAlign: 'center', marginTop: 12, fontSize: 11, color: W.textCaption }}>
                256-bit encrypted -- Processed by Square
              </div>
            </div>
          </div>
        )}

        {/* ── Payment Success ── */}
        {paymentState === 'success' && paymentResult && (
          <div style={{ background: W.greenLight, borderRadius: 16, border: `1px solid ${W.green}`, padding: 28, textAlign: 'center', marginBottom: 20 }}>
            <div style={{ fontFamily: "'Montserrat', sans-serif", fontWeight: 700, fontSize: 20, color: '#2E7D32', marginBottom: 8 }}>Payment Successful!</div>
            <div style={{ fontSize: 15, color: W.textBody, marginBottom: 4 }}>
              ${paymentResult.amount?.toFixed(2)} paid for {paymentResult.invoiceNumber}
            </div>
            <div style={{ fontSize: 13, color: W.textCaption }}>
              A receipt has been sent to your phone.
            </div>
          </div>
        )}

        {/* ── WaveGuard Upgrade Nudge (Bronze only, not paid) ── */}
        {tier === 'Bronze' && !isPaid && paymentState !== 'success' && (
          <div style={{ background: `linear-gradient(135deg, ${W.sand} 0%, #FFF8E1 100%)`, borderRadius: 14, border: '1px solid #E8D5B7', padding: '18px 20px', marginBottom: 20 }}>
            <div style={{ fontFamily: "'Montserrat', sans-serif", fontWeight: 700, fontSize: 14, color: '#8D6E63', marginBottom: 4 }}>
              Save on every visit
            </div>
            <div style={{ fontSize: 13, color: W.textBody, lineHeight: 1.5 }}>
              Upgrade to <strong style={{ color: '#F9A825' }}>Gold WaveGuard</strong> and save 15% on all services -- that's ${(invoice.subtotal * 0.15).toFixed(2)} off today's service alone.
              Reply to the text from Waves or call <a href="tel:+19413187612" style={{ color: W.blue }}>(941) 318-7612</a>.
            </div>
          </div>
        )}

        {/* ── Footer ── */}
        <div style={{ textAlign: 'center', padding: '20px 0', color: W.textCaption, fontSize: 12 }}>
          <div style={{ marginBottom: 8 }}>Questions? Reply to the text or call <a href="tel:+19413187612" style={{ color: W.blue, textDecoration: 'none' }}>(941) 318-7612</a></div>
          <div>Waves Pest Control -- Southwest Florida</div>
          <div style={{ marginTop: 4 }}>wavespestcontrol.com</div>
        </div>
      </div>
    </div>
  );
}
