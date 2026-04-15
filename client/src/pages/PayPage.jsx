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

const SOCIAL_LINKS = [
  { name: 'Facebook',  url: 'https://facebook.com/wavespestcontrol',          path: 'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z' },
  { name: 'Instagram', url: 'https://instagram.com/wavespestcontrol',         path: 'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12s.014 3.668.072 4.948c.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24s3.668-.014 4.948-.072c4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948s-.014-3.667-.072-4.947c-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z' },
  { name: 'YouTube',   url: 'https://youtube.com/@wavespestcontrol',          path: 'M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z' },
  { name: 'TikTok',    url: 'https://tiktok.com/@wavespestcontrol',           path: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z' },
  { name: 'LinkedIn',  url: 'https://linkedin.com/company/wavespestcontrol',  path: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z' },
  { name: 'X',         url: 'https://x.com/wavespest',                        path: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z' },
];

const TIER_COLORS = {
  Bronze: { bg: '#F5E6D3', text: '#8D6E63', accent: '#A1887F' },
  Silver: { bg: '#ECEFF1', text: '#607D8B', accent: '#90A4AE' },
  Gold: { bg: '#FFF8E1', text: '#F9A825', accent: '#FFD54F' },
  Platinum: { bg: '#F3F1F0', text: '#6D6D6D', accent: '#E5E4E2' },
};

// ─── Stripe SDK loader (loads once, caches) ─────────────────────
let stripePromise = null;
function getStripe(publishableKey) {
  if (stripePromise) return stripePromise;
  stripePromise = new Promise((resolve, reject) => {
    if (window.Stripe) {
      resolve(window.Stripe(publishableKey));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://js.stripe.com/v3/';
    script.async = true;
    script.onload = () => resolve(window.Stripe(publishableKey));
    script.onerror = () => reject(new Error('Failed to load Stripe'));
    document.head.appendChild(script);
  });
  return stripePromise;
}

// ─── Stripe Payment Element wrapper ─────────────────────────────
function StripePaymentForm({ publishableKey, clientSecret, amount, onSuccess, onError }) {
  const mountRef = useRef(null);
  const elementsRef = useRef(null);
  const stripeRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [elementError, setElementError] = useState(null);

  useEffect(() => {
    if (!publishableKey || !clientSecret) return;
    let cancelled = false;

    (async () => {
      try {
        const stripe = await getStripe(publishableKey);
        if (cancelled) return;
        stripeRef.current = stripe;

        const elements = stripe.elements({
          clientSecret,
          appearance: {
            theme: 'stripe',
            variables: {
              colorPrimary: W.blue,
              colorBackground: W.white,
              colorText: W.navy,
              colorDanger: W.red,
              fontFamily: "'Poppins', sans-serif",
              borderRadius: '10px',
              spacingUnit: '4px',
            },
            rules: {
              '.Input': {
                border: `1px solid ${W.border}`,
                boxShadow: 'none',
                padding: '12px 14px',
              },
              '.Input:focus': {
                border: `1px solid ${W.blue}`,
                boxShadow: `0 0 0 1px ${W.blue}`,
              },
              '.Label': {
                fontSize: '13px',
                fontWeight: '500',
                color: W.textBody,
              },
              '.Tab': {
                border: `1px solid ${W.border}`,
                borderRadius: '10px',
              },
              '.Tab--selected': {
                borderColor: W.blue,
                backgroundColor: W.bluePale,
              },
            },
          },
        });

        if (cancelled) return;
        elementsRef.current = elements;

        const paymentElement = elements.create('payment', {
          layout: {
            type: 'accordion',
            defaultCollapsed: false,
            radios: true,
            spacedAccordionItems: true,
          },
          paymentMethodOrder: ['apple_pay', 'google_pay', 'card', 'us_bank_account'],
          wallets: {
            applePay: 'auto',
            googlePay: 'auto',
          },
        });

        paymentElement.on('ready', () => { if (!cancelled) setReady(true); });
        paymentElement.on('change', (event) => {
          if (!cancelled) setElementError(event.error?.message || null);
        });

        paymentElement.mount(mountRef.current);
      } catch (err) {
        if (!cancelled) onError?.(err.message || 'Failed to initialize payment form');
      }
    })();

    return () => { cancelled = true; };
  }, [publishableKey, clientSecret]);

  const handleSubmit = async () => {
    if (!stripeRef.current || !elementsRef.current || processing) return;
    setProcessing(true);
    setElementError(null);

    try {
      const { error, paymentIntent } = await stripeRef.current.confirmPayment({
        elements: elementsRef.current,
        confirmParams: {
          return_url: window.location.href,
        },
        redirect: 'if_required',
      });

      if (error) {
        setElementError(error.message);
        setProcessing(false);
        return;
      }

      if (paymentIntent && (paymentIntent.status === 'succeeded' || paymentIntent.status === 'processing')) {
        onSuccess?.(paymentIntent);
      } else if (paymentIntent && paymentIntent.status === 'requires_action') {
        setElementError('Additional verification required. Please follow the prompts.');
        setProcessing(false);
      } else {
        onSuccess?.(paymentIntent);
      }
    } catch (err) {
      setElementError(err.message || 'Payment failed');
      setProcessing(false);
    }
  };

  const isDisabled = !ready || processing;

  return (
    <div>
      {/* ACH savings nudge */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12,
        padding: '10px 14px', borderRadius: 10,
        background: W.greenLight, border: `1px solid ${W.green}33`,
      }}>
        <span style={{ fontSize: 18 }}>🏦</span>
        <span style={{ fontSize: 13, color: '#2E7D32', fontWeight: 500 }}>
          Save 3% when you pay by bank account
        </span>
      </div>
      <div ref={mountRef} style={{ minHeight: 90, marginBottom: 16 }} />

      {elementError && (
        <div style={{
          background: '#FFF3F3', border: `1px solid ${W.red}`, borderRadius: 10,
          padding: '10px 14px', fontSize: 13, color: W.red, marginBottom: 12,
        }}>
          {elementError}
        </div>
      )}

      <button
        onClick={handleSubmit}
        disabled={isDisabled}
        style={{
          width: '100%', padding: 16,
          background: processing ? W.textCaption : W.blue,
          color: W.white, border: 'none', borderRadius: 12,
          fontFamily: "'Montserrat', sans-serif", fontWeight: 700, fontSize: 16,
          cursor: isDisabled ? 'default' : 'pointer',
          opacity: isDisabled ? 0.6 : 1,
          transition: 'all 0.2s',
        }}
      >
        {processing ? 'Processing...' : !ready ? 'Loading payment form...' : `Pay $${amount.toFixed(2)}`}
      </button>

      <div style={{ textAlign: 'center', marginTop: 12, fontSize: 11, color: W.textCaption }}>
        256-bit encrypted — Processed by Stripe
      </div>
    </div>
  );
}

// ─── Main PayPage ───────────────────────────────────────────────
export default function PayPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [paymentState, setPaymentState] = useState('idle'); // idle, setup, ready, success, error
  const [paymentError, setPaymentError] = useState(null);
  const [paymentResult, setPaymentResult] = useState(null);
  const [stripeSetup, setStripeSetup] = useState(null);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 600);

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

  // Check for Stripe redirect return (3D Secure, bank redirect, etc.)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const piClientSecret = params.get('payment_intent_client_secret');
    const redirectStatus = params.get('redirect_status');

    if (piClientSecret && redirectStatus === 'succeeded') {
      setPaymentState('success');
      setPaymentResult({ redirected: true });
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Create Stripe PaymentIntent once invoice data loads
  useEffect(() => {
    if (!data || data.invoice.status === 'paid' || paymentState === 'success') return;
    if (!data.stripe?.available || !data.stripe?.publishableKey) {
      setPaymentError('Payment processing is temporarily unavailable. Please call (941) 318-7612.');
      return;
    }

    setPaymentState('setup');

    fetch(`${API_BASE}/pay/${token}/setup`, { method: 'POST' })
      .then(r => {
        if (!r.ok) throw new Error('Failed to initialize payment');
        return r.json();
      })
      .then(setup => {
        setStripeSetup({
          clientSecret: setup.clientSecret,
          publishableKey: setup.publishableKey || data.stripe.publishableKey,
        });
        setPaymentState('ready');
      })
      .catch(err => {
        setPaymentState('error');
        setPaymentError(err.message);
      });
  }, [data, token]);

  // Timeout if payment form doesn't load
  useEffect(() => {
    if (paymentState !== 'setup') return;
    const timeout = setTimeout(() => {
      if (paymentState === 'setup') {
        setPaymentState('error');
        setPaymentError('Payment form failed to load. Please refresh the page or call (941) 318-7612.');
      }
    }, 15000);
    return () => clearTimeout(timeout);
  }, [paymentState]);

  // Handle successful Stripe payment — confirm on backend + update UI
  const handlePaymentSuccess = async (paymentIntent) => {
    try {
      const res = await fetch(`${API_BASE}/pay/${token}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentIntentId: paymentIntent.id }),
      });
      const result = await res.json();

      if (!res.ok) {
        // Payment succeeded on Stripe but backend confirm had an issue
        // Still show success — stripe-webhook.js will reconcile
        console.error('Backend confirm error (webhook will reconcile):', result.error);
      }
    } catch (err) {
      // Network error on confirm — Stripe already charged, webhook handles it
      console.error('Confirm call failed (webhook will reconcile):', err);
    }

    setPaymentState('success');
    setPaymentResult({
      amount: paymentIntent.amount / 100,
      invoiceNumber: data?.invoice?.invoiceNumber,
    });
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

  const { invoice, service, customer } = data;
  const isPaid = invoice.status === 'paid';
  const tier = customer.tier;
  const tierColors = TIER_COLORS[tier] || TIER_COLORS.Bronze;

  return (
    <div style={{ minHeight: '100vh', background: W.offWhite, fontFamily: "'Poppins', sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Poppins:wght@400;500;600&display=swap" rel="stylesheet" />

      {/* ── Header ── */}
      <div style={{ background: `linear-gradient(135deg, ${W.blue} 0%, ${W.navy} 100%)`, padding: isMobile ? '24px 16px' : '32px 24px', textAlign: 'center' }}>
        <img src="/waves-logo.png" alt="Waves Pest Control" style={{ height: isMobile ? 40 : 48, maxWidth: '80%', objectFit: 'contain' }} />
      </div>

      <div style={{ maxWidth: 560, margin: '0 auto', padding: isMobile ? '0 12px 40px' : '0 16px 60px' }}>

        {/* ── Paid Banner ── */}
        {isPaid && (
          <div style={{ background: W.greenLight, border: `1px solid ${W.green}`, borderRadius: 12, padding: '16px 20px', marginTop: -16, marginBottom: 20, textAlign: 'center' }}>
            <div style={{ fontFamily: "'Montserrat', sans-serif", fontWeight: 700, fontSize: 16, color: '#2E7D32' }}>Payment Received</div>
            <div style={{ fontSize: 13, color: W.textBody, marginTop: 4 }}>
              Paid {invoice.paidAt ? new Date(invoice.paidAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : ''}
              {invoice.cardBrand && invoice.cardLastFour ? ` — ${invoice.cardBrand} ****${invoice.cardLastFour}` : ''}
            </div>
          </div>
        )}

        {/* ── Customer Greeting ── */}
        <div style={{ marginTop: isPaid ? 16 : 24, marginBottom: 24 }}>
          <div style={{ fontFamily: "'Montserrat', sans-serif", fontSize: isMobile ? 18 : 22, fontWeight: 700, color: W.navy }}>
            {isPaid ? `Thank you, ${customer.firstName}!` : `Hi ${customer.firstName}!`}
          </div>
          <div style={{ fontSize: 14, color: W.textBody, marginTop: 4 }}>
            We appreciate the opportunity to serve you and thank you for choosing Waves!
          </div>
        </div>

        {/* ── Service Date ── */}
        {service.date && (
          <div style={{ background: W.white, borderRadius: 12, border: `1px solid ${W.border}`, padding: '14px 18px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 42, height: 42, borderRadius: 10, background: W.bluePale,
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              fontSize: 20,
            }}>📅</div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: W.textCaption, textTransform: 'uppercase', letterSpacing: 0.8 }}>Service Date</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: W.navy, marginTop: 2 }}>
                {new Date(service.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              </div>
            </div>
          </div>
        )}

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

              {service.techNotes && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: W.textCaption, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>Tech Notes</div>
                  <div style={{ fontSize: 14, color: W.textBody, lineHeight: 1.6, background: W.offWhite, padding: 14, borderRadius: 10, borderLeft: `3px solid ${W.blue}` }}>
                    {service.techNotes}
                  </div>
                </div>
              )}

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
            {!isPaid && (() => {
              if (!invoice.dueDate) return <div style={{ fontSize: 12, color: W.textCaption }}>Due upon receipt</div>;
              const d = new Date(String(invoice.dueDate).split('T')[0] + 'T12:00:00');
              if (isNaN(d.getTime())) return <div style={{ fontSize: 12, color: W.textCaption }}>Due upon receipt</div>;
              return <div style={{ fontSize: 12, color: W.textCaption }}>Due {d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>;
            })()}
          </div>

          <div style={{ padding: isMobile ? 14 : 20 }}>
            {invoice.lineItems?.map((item, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: i < invoice.lineItems.length - 1 ? `1px solid ${W.borderLight}` : 'none' }}>
                <div>
                  <div style={{ fontSize: 14, color: W.navy, fontWeight: 500 }}>{item.description}</div>
                  {item.quantity > 1 && <div style={{ fontSize: 12, color: W.textCaption }}>{item.quantity} x ${item.unit_price.toFixed(2)}</div>}
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: W.navy, whiteSpace: 'nowrap' }}>${(item.quantity * item.unit_price).toFixed(2)}</div>
              </div>
            ))}

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

              {invoice.taxAmount > 0 && customer.isCommercial && (
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

        {/* ── Payment Section (Stripe Payment Element) ── */}
        {!isPaid && paymentState !== 'success' && (
          <div style={{ background: W.white, borderRadius: 16, border: `1px solid ${W.border}`, overflow: 'hidden', marginBottom: 20 }}>
            <div style={{ padding: '16px 20px', borderBottom: `1px solid ${W.border}` }}>
              <div style={{ fontFamily: "'Montserrat', sans-serif", fontWeight: 700, fontSize: 15, color: W.navy }}>Pay Now</div>
              <div style={{ fontSize: 12, color: W.textCaption, marginTop: 2 }}>Card, Apple Pay, Google Pay, or bank transfer</div>
            </div>

            <div style={{ padding: isMobile ? 14 : 20 }}>
              {paymentError && !stripeSetup && (
                <div style={{
                  background: '#FFF3F3', border: `1px solid ${W.red}`, borderRadius: 10,
                  padding: '10px 14px', fontSize: 13, color: W.red, marginBottom: 12,
                }}>
                  {paymentError}
                </div>
              )}

              {paymentState === 'setup' && (
                <div style={{ textAlign: 'center', padding: '24px 0' }}>
                  <div style={{ width: 32, height: 32, border: `3px solid ${W.border}`, borderTopColor: W.blue, borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px' }} />
                  <div style={{ fontSize: 13, color: W.textCaption }}>Preparing secure checkout...</div>
                  <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
                </div>
              )}

              {stripeSetup && (
                <StripePaymentForm
                  publishableKey={stripeSetup.publishableKey}
                  clientSecret={stripeSetup.clientSecret}
                  amount={invoice.total}
                  onSuccess={handlePaymentSuccess}
                  onError={(msg) => setPaymentError(msg)}
                />
              )}
            </div>
          </div>
        )}

        {/* ── Payment Success ── */}
        {paymentState === 'success' && (
          <div style={{ background: W.greenLight, borderRadius: 16, border: `1px solid ${W.green}`, padding: 28, textAlign: 'center', marginBottom: 20 }}>
            <div style={{ fontFamily: "'Montserrat', sans-serif", fontWeight: 700, fontSize: 20, color: '#2E7D32', marginBottom: 8 }}>Payment Successful!</div>
            <div style={{ fontSize: 15, color: W.textBody, marginBottom: 4 }}>
              {paymentResult?.amount
                ? `$${paymentResult.amount.toFixed(2)} paid for ${paymentResult.invoiceNumber || invoice.invoiceNumber}`
                : `Payment confirmed for ${invoice.invoiceNumber}`
              }
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
              Upgrade to <strong style={{ color: '#F9A825' }}>Gold WaveGuard</strong> and save 15% on all services — that's ${(invoice.subtotal * 0.15).toFixed(2)} off today's service alone.
              Reply to the text from Waves or call <a href="tel:+19413187612" style={{ color: W.blue }}>(941) 318-7612</a>.
            </div>
          </div>
        )}

        {/* ── Footer ── */}
        <div style={{ textAlign: 'center', padding: '24px 0 8px' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: W.navy, fontFamily: "'Montserrat', sans-serif", marginBottom: 14 }}>
            🌊 Stay in the loop
          </div>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 20 }}>
            {SOCIAL_LINKS.map(s => (
              <a key={s.name} href={s.url} target="_blank" rel="noopener noreferrer" title={s.name}
                style={{
                  width: 40, height: 40, borderRadius: '50%',
                  background: W.bluePale, color: W.blue,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  textDecoration: 'none', transition: 'all 0.2s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = W.blue; e.currentTarget.style.color = W.white; e.currentTarget.style.transform = 'scale(1.1)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = W.bluePale; e.currentTarget.style.color = W.blue; e.currentTarget.style.transform = 'scale(1)'; }}
              >
                <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor"><path d={s.path} /></svg>
              </a>
            ))}
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: W.navy, fontFamily: "'Montserrat', sans-serif", marginBottom: 6, padding: '0 16px' }}>
            We appreciate the opportunity to serve you and thank you for choosing Waves!
          </div>
          <div style={{ fontSize: 11, color: W.textCaption, marginTop: 10 }}>
            wavespestcontrol.com · <a href="tel:+19413187612" style={{ color: W.blue, textDecoration: 'none' }}>(941) 318-7612</a>
          </div>
        </div>
      </div>
    </div>
  );
}
