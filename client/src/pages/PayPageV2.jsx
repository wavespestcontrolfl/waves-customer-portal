import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  WavesShell,
  BrandCard,
  BrandButton,
  SerifHeading,
  HelpPhoneLink,
} from '../components/brand';
import SaveCardConsent from '../components/billing/SaveCardConsent';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// ── Stripe SDK loader (loads once, caches) ─────────────────────────
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

// ── Stripe Payment Element wrapper ─────────────────────────────────
function PaymentForm({ publishableKey, clientSecret, amount, paymentIntentId, token, cardSurchargeRate, onSuccess, onError, saveCard, onSaveCardChange }) {
  const mountRef = useRef(null);
  const expressMountRef = useRef(null);
  const elementsRef = useRef(null);
  const stripeRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [elementError, setElementError] = useState(null);
  const [selectedMethod, setSelectedMethod] = useState('card');
  const [displayedBase, setDisplayedBase] = useState(amount);
  const [displayedSurcharge, setDisplayedSurcharge] = useState(
    Math.round(amount * (cardSurchargeRate || 0.03) * 100) / 100,
  );
  const [displayedTotal, setDisplayedTotal] = useState(
    Math.round((amount + amount * (cardSurchargeRate || 0.03)) * 100) / 100,
  );
  const [syncingAmount, setSyncingAmount] = useState(false);

  const syncAmountForMethod = useCallback(async (methodCategory, saveCardOverride) => {
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
      /* Stripe will charge the PI's current amount */
    } finally {
      setSyncingAmount(false);
    }
  }, [paymentIntentId, token, saveCard]);

  // Re-sync the PI whenever the save-card checkbox toggles — Stripe's
  // mandate wording switches between one-time and recurring on the
  // setup_future_usage change.
  useEffect(() => {
    if (!paymentIntentId) return;
    syncAmountForMethod(selectedMethod, !!saveCard);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveCard]);

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
              colorPrimary: '#1B2C5B',
              colorBackground: '#FFFFFF',
              colorText: '#0F172A',
              colorDanger: '#C8102E',
              fontFamily: "Inter, system-ui, sans-serif",
              borderRadius: '8px',
              spacingUnit: '4px',
            },
            rules: {
              '.Input': {
                border: '1px solid #E2E8F0',
                boxShadow: 'none',
                padding: '12px 14px',
              },
              '.Input:focus': {
                border: '1px solid #1B2C5B',
                boxShadow: '0 0 0 3px rgba(27,44,91,0.18)',
              },
              '.Label': {
                fontSize: '13px',
                fontWeight: '500',
                color: '#334155',
              },
              '.Tab': {
                border: '1px solid #E2E8F0',
                borderRadius: '8px',
              },
              '.Tab--selected': {
                borderColor: '#1B2C5B',
                backgroundColor: 'rgba(27,44,91,0.08)',
              },
            },
          },
        });

        if (cancelled) return;
        elementsRef.current = elements;

        // ── Express Checkout Element — prominent wallet button
        //
        // Renders Apple Pay / Google Pay / Link as a branded one-tap
        // pill at the top of the form (image reference: google-pay.png).
        // The card preview + last-four in the button are Google's own
        // surface, shown when the customer has a saved card in Google
        // Pay and our domain is registered with Stripe.
        //
        // We pre-apply the card-family surcharge on mount so the wallet
        // sheet displays the correct total ($X + 3%) — wallets are
        // always card-family, and updating the PI from inside the click
        // handler has too tight a deadline (1s).
        const express = elements.create('expressCheckout', {
          buttonTheme: { applePay: 'black', googlePay: 'black' },
          buttonType:  { applePay: 'buy',   googlePay: 'buy' },
          buttonHeight: 52,
          paymentMethodOrder: ['applePay', 'googlePay', 'link'],
        });

        express.on('ready', async () => {
          if (cancelled) return;
          // Surcharge wallets = card-family × 1.03. Pre-apply now so the
          // wallet sheet shows the right total instead of the base amount.
          try { await syncAmountForMethod('card', saveCard); } catch { /* non-fatal */ }
        });

        express.on('confirm', async () => {
          if (cancelled) return;
          try {
            const { error, paymentIntent } = await stripeRef.current.confirmPayment({
              elements: elementsRef.current,
              confirmParams: { return_url: window.location.href },
              redirect: 'if_required',
            });
            if (error) {
              setElementError(error.message);
              return;
            }
            if (paymentIntent && (paymentIntent.status === 'succeeded' || paymentIntent.status === 'processing')) {
              onSuccess?.(paymentIntent);
            } else if (paymentIntent && paymentIntent.status === 'requires_action') {
              setElementError('Additional verification required. Please follow the prompts.');
            }
          } catch (err) {
            setElementError(err.message || 'Payment failed');
          }
        });

        if (expressMountRef.current) express.mount(expressMountRef.current);

        // ── Payment Element — manual card + ACH
        //
        // Wallets moved into the Express Checkout Element above, so we
        // hide them here (wallets: 'never') and drop them from the
        // method order. The accordion now shows only card + ACH.
        const paymentElement = elements.create('payment', {
          layout: {
            type: 'accordion',
            defaultCollapsed: false,
            radios: true,
            spacedAccordionItems: true,
          },
          paymentMethodOrder: ['card', 'us_bank_account'],
          wallets: { applePay: 'never', googlePay: 'never' },
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

  const isCardFamily = selectedMethod !== 'us_bank_account';
  const pct = Math.round((cardSurchargeRate || 0.03) * 100);
  const buttonAmount = isCardFamily ? displayedTotal : displayedBase;

  const handleSubmit = async () => {
    if (!stripeRef.current || !elementsRef.current || processing) return;
    setProcessing(true);
    setElementError(null);

    try {
      const { error, paymentIntent } = await stripeRef.current.confirmPayment({
        elements: elementsRef.current,
        confirmParams: { return_url: window.location.href },
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

  const disabled = !ready || processing || syncingAmount;

  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 16,
        padding: '12px 14px', borderRadius: 'var(--radius-md)',
        background: 'rgba(0,156,222,0.08)', border: '1px solid rgba(0,156,222,0.24)',
        fontSize: 13, lineHeight: 1.5, color: 'var(--text)',
      }}>
        <span aria-hidden="true">💳</span>
        <span>
          A {pct}% processing fee is added to credit/debit card and wallet payments.
          Bank transfers (ACH) pay the quoted amount with no added fee.
        </span>
      </div>

      {/* Express wallet button (Google Pay / Apple Pay / Link) —
          Stripe only renders one on browser + device combos where the
          customer actually has a wallet set up, so this div will be
          empty for most desktop Chrome users without a Google Pay card
          on file. That's the Stripe-recommended behavior. */}
      <div ref={expressMountRef} style={{ marginBottom: 16 }} />
      <div ref={mountRef} style={{ minHeight: 90, marginBottom: 16 }} />

      {/* Save-card opt-in */}
      <div style={{ marginBottom: 16 }}>
        <SaveCardConsent
          checked={!!saveCard}
          onChange={(v) => onSaveCardChange?.(v)}
        />
      </div>

      <div style={{
        marginBottom: 16, padding: 14, borderRadius: 'var(--radius-md)',
        background: '#F8FAFB', border: '1px solid var(--border)',
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 13,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ color: 'var(--text-muted)', fontFamily: "'Inter', system-ui, sans-serif" }}>
            Invoice total
          </span>
          <span style={{ color: 'var(--text)' }}>{fmtCurrency(displayedBase)}</span>
        </div>
        {isCardFamily && displayedSurcharge > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ color: 'var(--text-muted)', fontFamily: "'Inter', system-ui, sans-serif" }}>
              Card processing fee ({pct}%)
            </span>
            <span style={{ color: 'var(--text)' }}>+ {fmtCurrency(displayedSurcharge)}</span>
          </div>
        )}
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          paddingTop: 10, marginTop: 8, borderTop: '1px solid var(--border)',
          fontWeight: 700, color: 'var(--text)',
        }}>
          <span style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
            {isCardFamily ? 'Total charged' : 'Total (bank transfer)'}
          </span>
          <span>{fmtCurrency(buttonAmount)}</span>
        </div>
      </div>

      {elementError && (
        <div style={{
          background: 'rgba(200,16,46,0.06)',
          border: '1px solid var(--danger)',
          borderRadius: 'var(--radius-md)',
          padding: '12px 14px',
          fontSize: 14,
          color: 'var(--danger)',
          marginBottom: 16,
        }}>
          {elementError}
        </div>
      )}

      <BrandButton variant="primary" fullWidth onClick={handleSubmit} disabled={disabled}>
        {processing
          ? 'Processing…'
          : !ready
            ? 'Loading payment form…'
            : syncingAmount
              ? 'Updating total…'
              : `Pay ${fmtCurrency(buttonAmount)}`}
      </BrandButton>

      <div style={{ textAlign: 'center', marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
        256-bit encrypted · Processed by Stripe
      </div>
    </div>
  );
}

// ── Main /pay/:token V2 page ───────────────────────────────────────
export default function PayPageV2() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [paymentState, setPaymentState] = useState('idle');
  const [paymentError, setPaymentError] = useState(null);
  const [stripeSetup, setStripeSetup] = useState(null);
  const [saveCard, setSaveCard] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/pay/${token}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? 'Invoice not found' : 'Failed to load');
        return r.json();
      })
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [token]);

  // Stripe redirect return (3DS, bank redirect)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const redirectStatus = params.get('redirect_status');
    if (redirectStatus === 'succeeded') {
      navigate(`/receipt/${token}?fresh=1`, { replace: true });
    }
  }, [navigate, token]);

  // Already paid → redirect to receipt page (no ?fresh=1 — this is a return visit)
  useEffect(() => {
    if (data?.invoice?.status === 'paid') {
      navigate(`/receipt/${token}`, { replace: true });
    }
  }, [data, navigate, token]);

  // Create Stripe PaymentIntent once invoice data loads
  useEffect(() => {
    if (!data || data.invoice.status === 'paid') return;
    if (!data.stripe?.available || !data.stripe?.publishableKey) {
      setPaymentError('Payment processing is temporarily unavailable. Please call (941) 297-5749.');
      return;
    }
    setPaymentState('setup');
    fetch(`${API_BASE}/pay/${token}/setup`, { method: 'POST' })
      .then((r) => { if (!r.ok) throw new Error('Failed to initialize payment'); return r.json(); })
      .then((setup) => {
        setStripeSetup({
          clientSecret: setup.clientSecret,
          paymentIntentId: setup.paymentIntentId,
          baseAmount: setup.baseAmount ?? setup.amount,
          cardSurchargeRate: setup.cardSurchargeRate ?? 0.03,
          publishableKey: setup.publishableKey || data.stripe.publishableKey,
        });
        setPaymentState('ready');
      })
      .catch((err) => {
        setPaymentState('error');
        setPaymentError(err.message);
      });
  }, [data, token]);

  const handlePaymentSuccess = async (paymentIntent) => {
    try {
      await fetch(`${API_BASE}/pay/${token}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentIntentId: paymentIntent.id }),
      });
    } catch (err) {
      // Stripe already charged — webhook will reconcile if confirm failed
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
        console.error('Consent record failed:', err);
      }
    }

    navigate(`/receipt/${token}?fresh=1`, { replace: true });
  };

  if (loading) {
    return (
      <WavesShell variant="customer" topBar="solid">
        <div style={{ padding: '64px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
          Loading invoice…
        </div>
      </WavesShell>
    );
  }

  if (error || !data) {
    return (
      <WavesShell variant="customer" topBar="solid">
        <div style={{ maxWidth: 560, margin: '48px auto', padding: '0 16px' }}>
          <BrandCard>
            <SerifHeading style={{ marginBottom: 12 }}>We couldn't find that invoice</SerifHeading>
            <p style={{ margin: 0, fontSize: 16, color: 'var(--text)', lineHeight: 1.55 }}>
              The link may have expired or been mistyped. Give us a call and we'll sort it out — <HelpPhoneLink tone="dark" inline />.
            </p>
          </BrandCard>
        </div>
      </WavesShell>
    );
  }

  const { invoice, service, customer } = data;
  const isOverdue = invoice.status !== 'paid'
    && invoice.dueDate
    && new Date(invoice.dueDate).getTime() < Date.now();

  return (
    <WavesShell variant="customer" topBar="solid">
      <div style={{ maxWidth: 640, margin: '32px auto 64px', padding: '0 16px' }}>
        {isOverdue && (
          <div style={{
            marginBottom: 16,
            padding: '12px 16px',
            borderRadius: 'var(--radius-md)',
            background: 'rgba(200,16,46,0.08)',
            border: '1px solid var(--danger)',
            color: 'var(--danger)',
            fontSize: 14,
            fontWeight: 500,
          }}>
            This invoice is overdue. Please pay at your earliest convenience.
          </div>
        )}

        <BrandCard padding={32} style={{ marginBottom: 20 }}>
          <div style={{ marginBottom: 8, fontSize: 12, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Invoice {invoice.invoiceNumber}
          </div>
          <SerifHeading style={{ marginBottom: 4 }}>
            Your invoice from Waves
          </SerifHeading>
          <p style={{ margin: '0 0 24px', fontSize: 16, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {invoice.title || service.type || 'Service'}
            {service.date ? ` · ${fmtDate(service.date)}` : ''}
            {invoice.dueDate ? ` · Due ${fmtDate(invoice.dueDate)}` : ''}
          </p>

          {/* Bill-to block */}
          <div style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--text)', marginBottom: 20 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>
              Billed to
            </div>
            <div style={{ fontWeight: 600 }}>{customer.firstName} {customer.lastName}</div>
            {customer.address && <div>{customer.address}</div>}
            {(customer.city || customer.state || customer.zip) && (
              <div>{customer.city}{customer.city ? ', ' : ''}{customer.state || 'FL'} {customer.zip || ''}</div>
            )}
          </div>

          {/* Line items */}
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

          {/* Totals */}
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
            {invoice.taxAmount > 0 && customer?.isCommercial && (
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
                Total
              </span>
              <span>{fmtCurrency(invoice.total)}</span>
            </div>
          </div>

          <div style={{ marginTop: 20 }}>
            <a
              href={`${API_BASE}/pay/${token}/invoice.pdf`}
              style={{
                fontSize: 13,
                color: 'var(--brand)',
                textDecoration: 'underline',
                textUnderlineOffset: 3,
              }}
            >
              Download invoice PDF
            </a>
          </div>
        </BrandCard>

        <BrandCard padding={28}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12 }}>
            Pay securely
          </div>
          {paymentError && (
            <div style={{
              background: 'rgba(200,16,46,0.06)',
              border: '1px solid var(--danger)',
              borderRadius: 'var(--radius-md)',
              padding: '12px 14px',
              fontSize: 14,
              color: 'var(--danger)',
              marginBottom: 16,
            }}>
              {paymentError}
            </div>
          )}
          {paymentState === 'ready' && stripeSetup ? (
            <PaymentForm
              publishableKey={stripeSetup.publishableKey}
              clientSecret={stripeSetup.clientSecret}
              amount={stripeSetup.baseAmount}
              paymentIntentId={stripeSetup.paymentIntentId}
              token={token}
              cardSurchargeRate={stripeSetup.cardSurchargeRate}
              onSuccess={handlePaymentSuccess}
              onError={(msg) => setPaymentError(msg)}
              saveCard={saveCard}
              onSaveCardChange={setSaveCard}
            />
          ) : paymentState === 'error' ? null : (
            <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
              Loading payment form…
            </div>
          )}
        </BrandCard>

        <div style={{ marginTop: 28, textAlign: 'center', fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          Questions about this invoice? <HelpPhoneLink tone="dark" inline /> or reply to the text or email.
        </div>
      </div>
    </WavesShell>
  );
}
