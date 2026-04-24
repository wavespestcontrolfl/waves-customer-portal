import Icon from '../components/Icon';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import BrandFooter from '../components/BrandFooter';
import { Button } from '../components/Button';
import StickyBottomCTA from '../components/customer/StickyBottomCTA';
import SaveCardConsent from '../components/billing/SaveCardConsent';
import { COLORS, FONTS } from '../theme-brand';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

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
function StripePaymentForm({ publishableKey, clientSecret, amount, paymentIntentId, token, cardSurchargeRate, onSuccess, onError, saveCard, onSaveCardChange }) {
  const mountRef = useRef(null);
  const elementsRef = useRef(null);
  const stripeRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [elementError, setElementError] = useState(null);
  // 'card' by default (surcharged) so we never undercharge — flips to 'us_bank_account' when ACH is selected.
  const [selectedMethod, setSelectedMethod] = useState('card');
  const [displayedBase, setDisplayedBase] = useState(amount);
  const [displayedSurcharge, setDisplayedSurcharge] = useState(
    Math.round(amount * (cardSurchargeRate || 0.03) * 100) / 100,
  );
  const [displayedTotal, setDisplayedTotal] = useState(
    Math.round((amount + amount * (cardSurchargeRate || 0.03)) * 100) / 100,
  );
  const [syncingAmount, setSyncingAmount] = useState(false);

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
              colorPrimary: COLORS.wavesBlue,
              colorBackground: COLORS.white,
              colorText: COLORS.blueDeeper,
              colorDanger: COLORS.red,
              fontFamily: FONTS.body,
              borderRadius: '12px',
              spacingUnit: '4px',
            },
            rules: {
              '.Input': {
                border: `1.5px solid #E2E8F0`,
                boxShadow: 'none',
                padding: '12px 14px',
              },
              '.Input:focus': {
                border: `1.5px solid ${COLORS.wavesBlue}`,
                boxShadow: `0 0 0 3px rgba(0,156,222,0.15)`,
              },
              '.Label': {
                fontSize: '13px',
                fontWeight: '500',
                color: COLORS.textBody,
              },
              '.Tab': {
                border: `1.5px solid #E2E8F0`,
                borderRadius: '12px',
              },
              '.Tab--selected': {
                borderColor: COLORS.wavesBlue,
                backgroundColor: COLORS.blueLight,
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
          if (cancelled) return;
          setElementError(event.error?.message || null);
          const nextMethod = event.value?.type || null;
          if (nextMethod && nextMethod !== selectedMethod) {
            setSelectedMethod(nextMethod);
            syncAmountForMethod(nextMethod);
          }
        });

        paymentElement.mount(mountRef.current);
      } catch (err) {
        if (!cancelled) onError?.(err.message || 'Failed to initialize payment form');
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishableKey, clientSecret]);

  const syncAmountForMethod = async (methodCategory, saveCardOverride) => {
    if (!paymentIntentId || !token) return;
    setSyncingAmount(true);
    try {
      const res = await fetch(`${API_BASE}/pay/${token}/update-amount`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentIntentId,
          methodCategory,
          saveCard: saveCardOverride !== undefined ? saveCardOverride : !!saveCard,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setDisplayedBase(data.base);
        setDisplayedSurcharge(data.surcharge);
        setDisplayedTotal(data.total);
      }
    } catch {
      // Non-fatal — Stripe will still charge the PI's current amount.
    } finally {
      setSyncingAmount(false);
    }
  };

  // When the customer toggles the "save card" box, push the new
  // setup_future_usage value to the PI so Stripe's mandate language
  // matches what we just promised.
  useEffect(() => {
    if (!paymentIntentId) return;
    syncAmountForMethod(selectedMethod, !!saveCard);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveCard]);

  const isCardFamily = selectedMethod !== 'us_bank_account';

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

  const pct = Math.round((cardSurchargeRate || 0.03) * 100);
  const buttonAmount = isCardFamily ? displayedTotal : displayedBase;

  return (
    <div>
      {/* Processing fee disclosure */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12,
        padding: '10px 14px', borderRadius: 10,
        background: COLORS.blueLight, border: `1px solid ${COLORS.blueDark}33`,
      }}>
        <Icon name="card" size={18} strokeWidth={1.75} />
        <span style={{ fontSize: 14, color: COLORS.navy, fontWeight: 500 }}>
          A {pct}% processing fee is added to credit/debit card and wallet payments. Bank transfers (ACH) pay the quoted amount with no added fee.
        </span>
      </div>
      <div ref={mountRef} style={{ minHeight: 90, marginBottom: 16 }} />

      {/* Save-card opt-in */}
      <div style={{ marginBottom: 16 }}>
        <SaveCardConsent
          checked={!!saveCard}
          onChange={(v) => onSaveCardChange?.(v)}
        />
      </div>

      {/* Live total breakdown */}
      <div style={{
        marginBottom: 16, padding: '12px 14px', borderRadius: 10,
        background: COLORS.offWhite, border: `1px solid ${COLORS.grayLight}`, fontSize: 14,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ color: COLORS.textBody }}>Invoice total</span>
          <span style={{ color: COLORS.navy, fontWeight: 600 }}>${displayedBase.toFixed(2)}</span>
        </div>
        {isCardFamily && displayedSurcharge > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ color: COLORS.textBody }}>Card processing fee ({pct}%)</span>
            <span style={{ color: COLORS.navy, fontWeight: 600 }}>+ ${displayedSurcharge.toFixed(2)}</span>
          </div>
        )}
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          paddingTop: 6, marginTop: 6, borderTop: `1px solid ${COLORS.grayLight}`,
          fontSize: 14, fontWeight: 700, color: COLORS.navy,
        }}>
          <span>{isCardFamily ? 'Total charged' : 'Total (bank transfer)'}</span>
          <span>${buttonAmount.toFixed(2)}</span>
        </div>
      </div>

      {elementError && (
        <div style={{
          background: '#FFF3F3', border: `1px solid ${COLORS.red}`, borderRadius: 10,
          padding: '10px 14px', fontSize: 14, color: COLORS.red, marginBottom: 12,
        }}>
          {elementError}
        </div>
      )}

      <Button
        variant="primary"
        onClick={handleSubmit}
        disabled={isDisabled || syncingAmount}
        style={{
          width: '100%',
          padding: 16,
          fontSize: 16,
          background: processing ? COLORS.textCaption : undefined,
          cursor: (isDisabled || syncingAmount) ? 'default' : 'pointer',
        }}
      >
        {processing
          ? 'Processing...'
          : !ready
            ? 'Loading payment form...'
            : syncingAmount
              ? 'Updating total…'
              : `Pay $${buttonAmount.toFixed(2)}`}
      </Button>

      <div style={{ textAlign: 'center', marginTop: 12, fontSize: 12, color: COLORS.textCaption }}>
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
  const [saveCard, setSaveCard] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 600);
  const payNowRef = useRef(null);

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
      setPaymentError('Payment processing is temporarily unavailable. Please call (941) 297-5749.');
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
          paymentIntentId: setup.paymentIntentId,
          baseAmount: setup.baseAmount ?? setup.amount,
          cardSurchargeRate: setup.cardSurchargeRate ?? 0.03,
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
        setPaymentError('Payment form failed to load. Please refresh the page or call (941) 297-5749.');
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

    // Record card-on-file consent if the customer opted in. The Stripe
    // webhook handles persisting the payment_methods row asynchronously
    // and will back-fill the FK on the consent record.
    if (saveCard && paymentIntent.payment_method) {
      try {
        await fetch(`${API_BASE}/pay/${token}/consent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stripePaymentMethodId: paymentIntent.payment_method }),
        });
      } catch (err) {
        // Non-fatal — the card is still saved (via setup_future_usage) but
        // our audit row didn't land. Webhook logs will flag the mismatch.
        console.error('Consent record failed:', err);
      }
    }

    setPaymentState('success');
    setPaymentResult({
      amount: paymentIntent.amount / 100,
      invoiceNumber: data?.invoice?.invoiceNumber,
    });
  };

  // ── Loading ──
  if (loading) return (
    <div style={{ minHeight: '100vh', background: COLORS.offWhite, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ width: 40, height: 40, border: `3px solid ${COLORS.grayLight}`, borderTopColor: COLORS.blueDark, borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 16px' }} />
        <div style={{ color: COLORS.textCaption, fontFamily: FONTS.body, fontSize: 14 }}>Loading your service details...</div>
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    </div>
  );

  // ── Error ──
  if (error) return (
    <div style={{ minHeight: '100vh', background: COLORS.offWhite, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ textAlign: 'center', maxWidth: 400 }}>
        <div style={{ fontFamily: FONTS.heading, fontSize: 20, fontWeight: 700, color: COLORS.blueDeeper, marginBottom: 8, letterSpacing: '-0.01em' }}>Invoice Not Found</div>
        <div style={{ fontFamily: FONTS.body, fontSize: 14, color: COLORS.textBody }}>This link may have expired or the invoice has been removed. Contact us at <a href="tel:+19412975749" style={{ color: COLORS.blueDark }}>(941) 297-5749</a> if you need help.</div>
      </div>
    </div>
  );

  const { invoice, service, customer } = data;
  const isPaid = invoice.status === 'paid';
  const tier = customer.tier;
  const tierColors = TIER_COLORS[tier] || TIER_COLORS.Bronze;

  return (
    <div style={{ minHeight: '100vh', background: COLORS.offWhite, fontFamily: FONTS.body }}>
      {/* Brand fonts loaded globally via client/index.html */}

      {/* ── Header ── */}
      <div style={{ position: 'relative', overflow: 'hidden', background: `linear-gradient(135deg, ${COLORS.wavesBlue} 0%, ${COLORS.blueDeeper} 100%)`, padding: isMobile ? '24px 16px' : '32px 24px', textAlign: 'center' }}>
        {/* Hero video — waves-hero-service.mp4 */}
        <video autoPlay muted loop playsInline preload="none" poster="/brand/waves-hero-service.webp"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.3, zIndex: 0, pointerEvents: 'none' }}
          aria-hidden="true">
          <source src="/brand/waves-hero-service.mp4" type="video/mp4" />
        </video>
        <img src="/waves-logo.png" alt="Waves Pest Control" style={{ position: 'relative', zIndex: 1, height: 28, objectFit: 'contain' }} />
      </div>

      <div style={{ maxWidth: 560, margin: '0 auto', padding: isMobile ? '0 12px 40px' : '0 16px 60px' }}>

        {/* ── Paid Banner ── */}
        {isPaid && (
          <div style={{ background: COLORS.greenLight, border: `1px solid ${COLORS.green}`, borderRadius: 12, padding: '16px 20px', marginTop: -16, marginBottom: 20, textAlign: 'center' }}>
            <div style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 16, color: '#2E7D32' }}>Payment Received</div>
            <div style={{ fontSize: 14, color: COLORS.textBody, marginTop: 4 }}>
              Paid {invoice.paidAt ? new Date(invoice.paidAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }) : ''}
              {invoice.cardBrand && invoice.cardLastFour ? ` — ${invoice.cardBrand} ****${invoice.cardLastFour}` : ''}
            </div>
          </div>
        )}

        {/* ── Customer Greeting (hero H1) ── */}
        <div style={{ marginTop: isPaid ? 16 : 24, marginBottom: 24 }}>
          <h1 style={{
            fontFamily: FONTS.display, fontWeight: 400,
            fontSize: isMobile ? 32 : 40, color: COLORS.wavesBlue,
            letterSpacing: '0.02em', lineHeight: 1.05, margin: 0,
          }}>
            {isPaid ? `Thank you, ${customer.firstName}!` : `Hi ${customer.firstName}!`}
          </h1>
          <div style={{ fontSize: 14, color: COLORS.textBody, marginTop: 8 }}>
            We appreciate the opportunity to serve you and thank you for choosing Waves!
          </div>
        </div>

        {/* ── Service Date ── */}
        {service.date && (
          <div style={{ background: COLORS.white, borderRadius: 12, border: `1px solid ${COLORS.grayLight}`, padding: '14px 18px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 42, height: 42, borderRadius: 10, background: COLORS.blueLight,
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              fontSize: 20,
            }}></div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textCaption, textTransform: 'uppercase', letterSpacing: 0.8 }}>Service Date</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: COLORS.navy, marginTop: 2 }}>
                {new Date(service.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}
              </div>
            </div>
          </div>
        )}

        {/* ── Service Recap Card ── */}
        {(service.type || service.techName) && (
          <div style={{ background: COLORS.white, borderRadius: 16, border: `1px solid ${COLORS.grayLight}`, overflow: 'hidden', marginBottom: 20 }}>
            <div style={{ background: COLORS.blueLight, padding: '16px 20px', borderBottom: `1px solid ${COLORS.grayLight}` }}>
              <div style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 15, color: COLORS.blueDeeper }}>Service Completed</div>
              <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 14, color: COLORS.textBody, flexWrap: 'wrap' }}>
                {service.date && <span>{new Date(service.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' })}</span>}
                {service.techName && <span>Tech: {service.techName}</span>}
              </div>
            </div>

            <div style={{ padding: isMobile ? 14 : 20 }}>
              {service.productsApplied?.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textCaption, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>Products Applied</div>
                  {service.productsApplied.map((p, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '8px 0', borderBottom: i < service.productsApplied.length - 1 ? `1px solid ${COLORS.offWhite}` : 'none' }}>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 500, color: COLORS.navy }}>{p.product_name}</div>
                        {p.active_ingredient && <div style={{ fontSize: 12, color: COLORS.textCaption }}>Active: {p.active_ingredient}</div>}
                      </div>
                      {p.application_rate && (
                        <div style={{ fontSize: 12, color: COLORS.textCaption, whiteSpace: 'nowrap', marginLeft: 12 }}>
                          {p.application_rate} {p.rate_unit}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {service.techNotes && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textCaption, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>Tech Notes</div>
                  <div style={{ fontSize: 16, color: COLORS.textBody, lineHeight: 1.6, background: COLORS.offWhite, padding: 14, borderRadius: 10, borderLeft: `3px solid ${COLORS.blueDark}` }}>
                    {service.techNotes}
                  </div>
                </div>
              )}

              {service.photos?.length > 0 && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: COLORS.textCaption, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>Service Photos</div>
                  <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 }}>
                    {service.photos.map((photo, i) => (
                      <div key={i} style={{ position: 'relative', borderRadius: 10, overflow: 'hidden', aspectRatio: '4/3', background: COLORS.offWhite }}>
                        <img src={photo.s3_url} alt={photo.caption || photo.photo_type} loading="lazy"
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        <div style={{
                          position: 'absolute', bottom: 0, left: 0, right: 0, padding: '4px 8px',
                          background: 'linear-gradient(transparent, rgba(0,0,0,0.6))', fontSize: 10, color: COLORS.white, textTransform: 'uppercase',
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
        <div style={{ background: COLORS.white, borderRadius: 16, border: `1px solid ${COLORS.grayLight}`, overflow: 'hidden', marginBottom: 20 }}>
          <div style={{ padding: '16px 20px', borderBottom: `1px solid ${COLORS.grayLight}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 15, color: COLORS.blueDeeper }}>Invoice</div>
              <div style={{ fontSize: 12, color: COLORS.textCaption, marginTop: 2 }}>{invoice.invoiceNumber}</div>
            </div>
            {!isPaid && (() => {
              if (!invoice.dueDate) return <div style={{ fontSize: 12, color: COLORS.textCaption }}>Due upon receipt</div>;
              const d = new Date(String(invoice.dueDate).split('T')[0] + 'T12:00:00');
              if (isNaN(d.getTime())) return <div style={{ fontSize: 12, color: COLORS.textCaption }}>Due upon receipt</div>;
              return <div style={{ fontSize: 12, color: COLORS.textCaption }}>Due {d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })}</div>;
            })()}
          </div>

          <div style={{ padding: isMobile ? 14 : 20 }}>
            {invoice.lineItems?.map((item, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: i < invoice.lineItems.length - 1 ? `1px solid ${COLORS.offWhite}` : 'none' }}>
                <div>
                  <div style={{ fontSize: 14, color: COLORS.navy, fontWeight: 500 }}>{item.description}</div>
                  {item.quantity > 1 && <div style={{ fontSize: 12, color: COLORS.textCaption }}>{item.quantity} x ${item.unit_price.toFixed(2)}</div>}
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.navy, whiteSpace: 'nowrap' }}>${(item.quantity * item.unit_price).toFixed(2)}</div>
              </div>
            ))}

            <div style={{ borderTop: `2px solid ${COLORS.grayLight}`, marginTop: 12, paddingTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: COLORS.textBody, marginBottom: 6 }}>
                <span>Subtotal</span><span>${invoice.subtotal.toFixed(2)}</span>
              </div>

              {invoice.discountAmount > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 6 }}>
                  <span style={{ color: COLORS.green, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ background: tierColors.bg, color: tierColors.text, fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 600 }}>{tier}</span>
                    {invoice.discountLabel}
                  </span>
                  <span style={{ color: COLORS.green, fontWeight: 600 }}>-${invoice.discountAmount.toFixed(2)}</span>
                </div>
              )}

              {invoice.taxAmount > 0 && customer.isCommercial && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: COLORS.textBody, marginBottom: 6 }}>
                  <span>Tax ({(invoice.taxRate * 100).toFixed(1)}%)</span><span>${invoice.taxAmount.toFixed(2)}</span>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: isMobile ? 18 : 20, fontFamily: FONTS.heading, fontWeight: 800, color: COLORS.blueDeeper, marginTop: 8, paddingTop: 8, borderTop: `2px solid ${COLORS.blueDeeper}` }}>
                <span>Total</span><span>${invoice.total.toFixed(2)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* ── Payment Section (Stripe Payment Element) ── */}
        {!isPaid && paymentState !== 'success' && (
          <div ref={payNowRef} style={{ background: COLORS.white, borderRadius: 16, border: `1px solid ${COLORS.grayLight}`, overflow: 'hidden', marginBottom: 20 }}>
            <div style={{ padding: '16px 20px', borderBottom: `1px solid ${COLORS.grayLight}` }}>
              <div style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 15, color: COLORS.blueDeeper }}>Pay Now</div>
              <div style={{ fontSize: 12, color: COLORS.textCaption, marginTop: 2 }}>Card, Apple Pay, Google Pay, or bank transfer</div>
            </div>

            <div style={{ padding: isMobile ? 14 : 20 }}>
              {paymentError && !stripeSetup && (
                <div style={{
                  background: '#FFF3F3', border: `1px solid ${COLORS.red}`, borderRadius: 10,
                  padding: '10px 14px', fontSize: 14, color: COLORS.red, marginBottom: 12,
                }}>
                  {paymentError}
                </div>
              )}

              {paymentState === 'setup' && (
                <div style={{ textAlign: 'center', padding: '24px 0' }}>
                  <div style={{ width: 32, height: 32, border: `3px solid ${COLORS.grayLight}`, borderTopColor: COLORS.blueDark, borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px' }} />
                  <div style={{ fontSize: 14, color: COLORS.textCaption }}>Preparing secure checkout...</div>
                  <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
                </div>
              )}

              {stripeSetup && (
                <StripePaymentForm
                  publishableKey={stripeSetup.publishableKey}
                  clientSecret={stripeSetup.clientSecret}
                  paymentIntentId={stripeSetup.paymentIntentId}
                  token={token}
                  cardSurchargeRate={stripeSetup.cardSurchargeRate}
                  amount={stripeSetup.baseAmount ?? invoice.total}
                  onSuccess={handlePaymentSuccess}
                  onError={(msg) => setPaymentError(msg)}
                  saveCard={saveCard}
                  onSaveCardChange={setSaveCard}
                />
              )}
            </div>
          </div>
        )}

        {/* ── Payment Success ── */}
        {paymentState === 'success' && (
          <div style={{ background: COLORS.greenLight, borderRadius: 16, border: `1px solid ${COLORS.green}`, padding: 28, textAlign: 'center', marginBottom: 20 }}>
            <div style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 20, color: '#2E7D32', marginBottom: 8 }}>Payment Successful!</div>
            <div style={{ fontSize: 15, color: COLORS.textBody, marginBottom: 4 }}>
              {paymentResult?.amount
                ? `$${paymentResult.amount.toFixed(2)} paid for ${paymentResult.invoiceNumber || invoice.invoiceNumber}`
                : `Payment confirmed for ${invoice.invoiceNumber}`
              }
            </div>
            <div style={{ fontSize: 14, color: COLORS.textCaption }}>
              A receipt has been sent to your phone.
            </div>
          </div>
        )}

        {/* ── WaveGuard Upgrade Nudge (Bronze only, not paid) ── */}
        {tier === 'Bronze' && !isPaid && paymentState !== 'success' && (
          <div style={{ background: `linear-gradient(135deg, ${COLORS.sand} 0%, #FFF8E1 100%)`, borderRadius: 14, border: '1px solid #E8D5B7', padding: '18px 20px', marginBottom: 20 }}>
            <div style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 14, color: '#8D6E63', marginBottom: 4 }}>
              Save on every visit
            </div>
            <div style={{ fontSize: 16, color: COLORS.textBody, lineHeight: 1.5 }}>
              Upgrade to <strong style={{ color: '#F9A825' }}>Gold WaveGuard</strong> and save 15% on all services — that's ${(invoice.subtotal * 0.15).toFixed(2)} off today's service alone.
              Reply to the text from Waves or call <a href="tel:+19412975749" style={{ color: COLORS.blueDark }}>(941) 297-5749</a>.
            </div>
          </div>
        )}

        {/* ── Footer ── */}
        <BrandFooter />
      </div>

      <StickyBottomCTA
        visible={!isPaid && paymentState !== 'success'}
        primaryLabel="Pay Invoice"
        primaryAction={() => payNowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
        priceDisplay={invoice ? `$${invoice.total.toFixed(2)} due` : ''}
        secondaryLabel="Questions? Text us"
        secondaryAction={() => { window.location.href = 'sms:+19412975749'; }}
      />
    </div>
  );
}
