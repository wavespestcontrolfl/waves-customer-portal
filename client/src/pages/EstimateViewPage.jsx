/**
 * Customer-facing estimate view — React redesign (PR B.2), feature-flagged
 * behind estimates.use_v2_view. Server-HTML path remains default; IB tool
 * toggle_estimate_v2_view opts individual estimates into this surface.
 *
 * Fetches GET /api/estimates/:token/data on mount. Renders slider +
 * price card + checklist + add-ons + slot picker + payment preference
 * + guarantee strip. Handles the /reserve → confirm → /accept flow
 * with a 15-min countdown between reserve and final commit.
 *
 * State shape (kept in this one component — the subcomponents are
 * presentational):
 *   data, loading, error
 *   selectedFrequency    — one of { quarterly | bi_monthly | monthly }
 *   selectedAddOns       — Set of addon keys
 *   selectedSlotId       — string | null
 *   ctaPhase             — 'configure' | 'review' | 'submitting' | 'success' | 'slot_conflict'
 *   reservation          — { scheduledServiceId, expiresAt } | null
 *   paymentPreference    — 'deposit_now' | 'pay_at_visit' | null
 *   countdownSeconds     — derived from reservation.expiresAt
 *
 * Matches PayPage / TrackPage convention: inline styles + W palette,
 * mobile-first stacked layout, two-column desktop via grid.
 */
import Icon from '../components/Icon';
import { COLORS } from '../theme-brand';
import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import BrandFooter from '../components/BrandFooter';
import FrequencySlider from '../components/estimate/FrequencySlider';
import PriceCard from '../components/estimate/PriceCard';
import IncludedChecklist from '../components/estimate/IncludedChecklist';
import AddOnsBlock from '../components/estimate/AddOnsBlock';
import SlotPicker from '../components/estimate/SlotPicker';
import PaymentPreferenceButtons from '../components/estimate/PaymentPreferenceButtons';
import QuestionsEscapeHatch from '../components/estimate/QuestionsEscapeHatch';
import GuaranteeStrip from '../components/estimate/GuaranteeStrip';
import TerminalStateCard from '../components/estimate/TerminalStateCard';

const FONT_BODY = "'Inter', system-ui, sans-serif";
const API_BASE = import.meta.env.VITE_API_URL || '/api';
const WAVES_PHONE_DISPLAY = '(941) 297-5749';
const WAVES_PHONE_TEL = '+19412975749';

function fmtMoney(n) {
  if (n == null) return '—';
  const v = Math.round(Number(n) * 100) / 100;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function Page({ children }) {
  return (
    <div style={{
      minHeight: '100vh', background: COLORS.offWhite,
      fontFamily: FONT_BODY, color: COLORS.navy,
      display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ flex: 1, padding: '24px 16px 40px', maxWidth: 780, width: '100%', margin: '0 auto' }}>
        {children}
      </div>
      <BrandFooter />
    </div>
  );
}

function SkeletonBlock() {
  return (
    <div style={{
      background: COLORS.white, borderRadius: 16, padding: 24,
      border: `1px solid ${COLORS.grayLight}`, marginBottom: 16,
    }}>
      <div style={{ height: 12, width: 120, background: COLORS.offWhite, borderRadius: 4 }} />
      <div style={{ height: 32, width: '60%', background: COLORS.offWhite, borderRadius: 4, marginTop: 14 }} />
      <div style={{ height: 14, width: '40%', background: COLORS.offWhite, borderRadius: 4, marginTop: 10 }} />
    </div>
  );
}

function NotFoundCard() {
  return (
    <div style={{
      background: COLORS.white, borderRadius: 16, padding: 32, textAlign: 'center',
      border: `1px solid ${COLORS.grayLight}`, marginTop: 40,
    }}>
      <div style={{ fontSize: 32 }}></div>
      <div style={{ fontSize: 18, fontWeight: 600, marginTop: 8 }}>Estimate unavailable</div>
      <div style={{ fontSize: 16, color: COLORS.textBody, marginTop: 12, lineHeight: 1.55 }}>
        This link may have expired or isn't valid. Call us at{' '}
        <a href={`tel:${WAVES_PHONE_TEL}`} style={{ color: COLORS.blueDark }}>{WAVES_PHONE_DISPLAY}</a>{' '}
        and we'll get you sorted.
      </div>
    </div>
  );
}

function Header({ customerFirstName, address }) {
  return (
    <div style={{ marginBottom: 20, textAlign: 'center' }}>
      <div style={{ fontSize: 14, color: COLORS.textCaption, letterSpacing: 0.5, textTransform: 'uppercase' }}>
        Waves Pest Control
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: COLORS.blueDeeper, marginTop: 8 }}>
        {customerFirstName ? `Hi ${customerFirstName}` : 'Your estimate'}
      </div>
      {address ? (
        <div style={{ fontSize: 14, color: COLORS.textCaption, marginTop: 4 }}>{address}</div>
      ) : null}
    </div>
  );
}

// Segmented toggle between Recurring and One-time views. Only rendered
// when the estimate has show_one_time_option=true AND oneTimeTotal>0.
// Tap either to switch mode — slider, add-ons, and price card respond
// to the mode change (one-time hides slider + add-ons, shows one-time
// price card content).
function OneTimeModeToggle({ mode, oneTimePrice, onChange }) {
  const pillBase = {
    padding: '10px 16px', borderRadius: 999, fontSize: 14, fontWeight: 600,
    cursor: 'pointer', border: 'none', textAlign: 'center', flex: 1,
    transition: 'all 150ms ease',
  };
  return (
    <div style={{
      background: COLORS.white, borderRadius: 999, padding: 4,
      border: `1px solid ${COLORS.grayLight}`, marginBottom: 12,
      display: 'flex', gap: 4,
    }}>
      <button
        type="button"
        onClick={() => onChange('recurring')}
        style={{
          ...pillBase,
          background: mode === 'recurring' ? COLORS.wavesBlue : 'transparent',
          color: mode === 'recurring' ? COLORS.white : COLORS.textBody,
        }}
      >Recurring</button>
      <button
        type="button"
        onClick={() => onChange('one_time')}
        style={{
          ...pillBase,
          background: mode === 'one_time' ? COLORS.wavesBlue : 'transparent',
          color: mode === 'one_time' ? COLORS.white : COLORS.textBody,
        }}
      >One-time</button>
    </div>
  );
}

function OneTimePriceCard({ oneTimePrice }) {
  return (
    <div style={{
      background: COLORS.white, borderRadius: 16, padding: 24,
      boxShadow: '0 2px 12px rgba(15,23,42,0.06)',
      borderTop: `4px solid ${COLORS.yellow}`,
      marginBottom: 16,
    }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.yellow, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
        Single visit
      </div>
      <div style={{ fontSize: 42, fontWeight: 700, color: COLORS.navy, lineHeight: 1.1 }}>
        {fmtMoney(oneTimePrice)}
        <span style={{ fontSize: 18, fontWeight: 500, color: COLORS.textBody, marginLeft: 6 }}>one-time</span>
      </div>
      <div style={{ fontSize: 16, color: COLORS.textBody, marginTop: 12, lineHeight: 1.55 }}>
        One visit, pay on service day. No recurring schedule, no tier discount.
        Most pest problems come back — if this single treatment doesn't resolve it,
        switch to recurring and we'll credit this visit toward your first month.
      </div>
    </div>
  );
}

function CountdownLine({ secondsRemaining }) {
  const m = Math.max(0, Math.floor(secondsRemaining / 60));
  const s = Math.max(0, secondsRemaining % 60);
  return (
    <div style={{ fontSize: 14, color: COLORS.textCaption, textAlign: 'center' }}>
      Slot held for {m}:{String(s).padStart(2, '0')}
    </div>
  );
}

function ReviewPhase({ slotId, paymentPreference, secondsRemaining, onConfirm, onCancel, invoiceMode }) {
  return (
    <div style={{
      background: COLORS.white, borderRadius: 16, padding: 24,
      borderTop: `4px solid ${COLORS.wavesBlue}`, boxShadow: '0 2px 12px rgba(15,23,42,0.06)',
      marginBottom: 16,
    }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.wavesBlue, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        Confirm your booking
      </div>
      <div style={{ fontSize: 18, color: COLORS.navy, marginTop: 10, lineHeight: 1.5 }}>
        Pay option: <strong>{
          invoiceMode ? 'Invoice due now'
          : paymentPreference === 'deposit_now' ? 'Deposit now'
          : paymentPreference === 'prepay_annual' ? 'Pay the year upfront'
          : 'At the visit'
        }</strong>
      </div>
      <div style={{ fontSize: 14, color: COLORS.textBody, marginTop: 4 }}>
        Slot: {slotId}
      </div>
      <div style={{ marginTop: 16 }}><CountdownLine secondsRemaining={secondsRemaining} /></div>
      <div style={{ display: 'grid', gap: 10, marginTop: 16 }}>
        <button
          type="button"
          onClick={onConfirm}
          style={{
            padding: '16px 20px', background: COLORS.wavesBlue, color: COLORS.white,
            border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 600, cursor: 'pointer',
          }}
        >Confirm booking</button>
        <button
          type="button"
          onClick={onCancel}
          style={{
            padding: '12px 20px', background: 'transparent', color: COLORS.textBody,
            border: `1px solid ${COLORS.grayLight}`, borderRadius: 12, fontSize: 14, fontWeight: 500, cursor: 'pointer',
          }}
        >Go back</button>
      </div>
    </div>
  );
}

function SuccessCard({ onboardingToken, invoiceMode }) {
  if (invoiceMode) {
    return (
      <div style={{
        background: COLORS.white, borderRadius: 16, padding: 28, textAlign: 'center',
        borderTop: `4px solid ${COLORS.green}`, boxShadow: '0 2px 12px rgba(15,23,42,0.06)',
        marginBottom: 16,
      }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.navy, marginTop: 8 }}>
          Thanks — your invoice is on the way.
        </div>
        <div style={{ fontSize: 16, color: COLORS.textBody, marginTop: 10, lineHeight: 1.55 }}>
          Check your phone and email for the pay link. Your service request
          has been received and our team will confirm the schedule.
        </div>
      </div>
    );
  }
  return (
    <div style={{
      background: COLORS.white, borderRadius: 16, padding: 28, textAlign: 'center',
      borderTop: `4px solid ${COLORS.green}`, boxShadow: '0 2px 12px rgba(15,23,42,0.06)',
      marginBottom: 16,
    }}>
      <div style={{ fontSize: 40 }}></div>
      <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.navy, marginTop: 8 }}>
        You're booked.
      </div>
      <div style={{ fontSize: 16, color: COLORS.textBody, marginTop: 10, lineHeight: 1.55 }}>
        Check your phone for the confirmation text.
        {onboardingToken ? ' We also sent you an onboarding link to finish setup.' : ''}
      </div>
      {onboardingToken ? (
        <a
          href={`/onboard/${onboardingToken}`}
          style={{
            display: 'inline-block', marginTop: 16, padding: '14px 20px',
            background: COLORS.wavesBlue, color: COLORS.white, textDecoration: 'none',
            borderRadius: 12, fontWeight: 600, fontSize: 15,
          }}
        >Continue to setup</a>
      ) : null}
    </div>
  );
}

function SlotConflictBanner({ onRetry }) {
  return (
    <div style={{
      background: '#fff4e5', borderRadius: 12, padding: 14,
      border: `1px solid #f5bb5c`, marginBottom: 16,
    }}>
      <div style={{ fontSize: 14, color: COLORS.navy }}>
        That slot was just taken. We've refreshed the options below — pick another.
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          style={{
            marginTop: 10, padding: '8px 14px',
            background: COLORS.wavesBlue, color: COLORS.white, border: 'none',
            borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600,
          }}
        >Refresh times</button>
      ) : null}
    </div>
  );
}

export default function EstimateViewPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [selectedFrequency, setSelectedFrequency] = useState(null);
  const [selectedAddOns, setSelectedAddOns] = useState(new Set());
  const [selectedSlotId, setSelectedSlotId] = useState(null);
  // serviceMode: 'recurring' | 'one_time'. Only toggleable when the estimate
  // has show_one_time_option=true (admin-opted-in). Defaults to 'recurring'
  // so existing estimates keep current behavior; one-time shown as an
  // opt-in alternative when surfaced.
  const [serviceMode, setServiceMode] = useState('recurring');
  const [paymentPreference, setPaymentPreference] = useState(null);
  const [ctaPhase, setCtaPhase] = useState('configure');
  const [reservation, setReservation] = useState(null);
  const [onboardingToken, setOnboardingToken] = useState(null);
  const [invoiceMode, setInvoiceMode] = useState(false);
  const [error, setError] = useState(null);
  const [slotsRefreshSignal, setSlotsRefreshSignal] = useState(0);

  const [countdownSeconds, setCountdownSeconds] = useState(0);
  const countdownRef = useRef(null);
  const selectedFrequencyRef = useRef(null);

  useEffect(() => {
    selectedFrequencyRef.current = selectedFrequency;
  }, [selectedFrequency]);

  const loadEstimate = useCallback(async ({ preserveSelection = false } = {}) => {
    setLoading(true);
    const r = await fetch(`${API_BASE}/estimates/${token}/data`);
    if (r.status === 404) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    if (!r.ok) throw new Error(`estimate fetch failed: ${r.status}`);
    const body = await r.json();
    setData(body);
    setLoading(false);
    const frequencies = body?.pricing?.frequencies || [];
    const firstFreq = frequencies[0];
    setSelectedFrequency((prev) => {
      if (preserveSelection && prev && frequencies.some((f) => f.key === prev)) return prev;
      return firstFreq?.key || prev;
    });
    const preservedFrequency = selectedFrequencyRef.current;
    const freqForAddOns = (preserveSelection && preservedFrequency
      ? frequencies.find((f) => f.key === preservedFrequency)
      : firstFreq) || firstFreq;
    if (freqForAddOns) {
      setSelectedAddOns(new Set((freqForAddOns.addOns || []).filter((a) => a.preChecked).map((a) => a.key)));
    }
  }, [token]);

  // Fetch on mount
  useEffect(() => {
    let cancelled = false;
    loadEstimate().catch(() => {
      if (!cancelled) {
        setNotFound(true);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [loadEstimate]);

  // Rebuild add-on defaults when the customer changes frequency — but
  // preserve any manual toggles the customer already made by keying off
  // only defaults, not clobbering their selections outright. Simpler v1:
  // reset to the new frequency's defaults. Revisit if Virginia reports
  // "I kept unchecking inside spray and it kept re-checking."
  const currentFrequency = useMemo(() => {
    if (!data || !selectedFrequency) return null;
    return data.pricing?.frequencies?.find((f) => f.key === selectedFrequency) || null;
  }, [data, selectedFrequency]);

  useEffect(() => {
    if (!currentFrequency) return;
    setSelectedAddOns(new Set((currentFrequency.addOns || []).filter((a) => a.preChecked).map((a) => a.key)));
  }, [currentFrequency]);

  // Countdown timer tied to reservation.expiresAt
  useEffect(() => {
    if (!reservation?.expiresAt) {
      setCountdownSeconds(0);
      if (countdownRef.current) clearInterval(countdownRef.current);
      return undefined;
    }
    const tick = () => {
      const remaining = Math.max(0, Math.floor((new Date(reservation.expiresAt).getTime() - Date.now()) / 1000));
      setCountdownSeconds(remaining);
      if (remaining === 0) {
        clearInterval(countdownRef.current);
        setCtaPhase('configure');
        setReservation(null);
        setSelectedSlotId(null);
        setPaymentPreference(null);
        setSlotsRefreshSignal((v) => v + 1);
      }
    };
    tick();
    countdownRef.current = setInterval(tick, 1000);
    return () => clearInterval(countdownRef.current);
  }, [reservation]);

  const onToggleAddOn = useCallback(async (key) => {
    const nextChecked = !selectedAddOns.has(key);
    setSelectedAddOns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    try {
      const r = await fetch(`${API_BASE}/estimates/${token}/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: nextChecked }),
      });
      if (!r.ok) throw new Error(`preferences failed: ${r.status}`);
      await loadEstimate({ preserveSelection: true });
    } catch (err) {
      setError(err.message);
      setSelectedAddOns((prev) => {
        const next = new Set(prev);
        if (nextChecked) next.delete(key); else next.add(key);
        return next;
      });
    }
  }, [loadEstimate, selectedAddOns, token]);

  const handlePaymentChoice = useCallback(async (pref) => {
    if (!selectedSlotId) return;
    setPaymentPreference(pref);
    setCtaPhase('submitting');
    setError(null);

    try {
      const r = await fetch(`${API_BASE}/public/estimates/${token}/reserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slotId: selectedSlotId }),
      });
      if (r.status === 409) {
        setCtaPhase('slot_conflict');
        setSelectedSlotId(null);
        setSlotsRefreshSignal((v) => v + 1);
        return;
      }
      if (!r.ok) throw new Error(`reserve failed: ${r.status}`);
      const body = await r.json();
      setReservation({ scheduledServiceId: body.scheduledServiceId, expiresAt: body.expiresAt });
      setCtaPhase('review');
    } catch (err) {
      setError(err.message);
      setCtaPhase('configure');
    }
  }, [selectedSlotId, token]);

  const handleConfirm = useCallback(async () => {
    setCtaPhase('submitting');
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/estimates/${token}/accept`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slotId: selectedSlotId,
          paymentMethodPreference: paymentPreference,
          serviceMode,
          selectedFrequency,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        if (r.status === 409) {
          setCtaPhase('slot_conflict');
          setSlotsRefreshSignal((v) => v + 1);
          setReservation(null);
          setSelectedSlotId(null);
          return;
        }
        throw new Error(body.error || `accept failed: ${r.status}`);
      }
      const body = await r.json();
      setOnboardingToken(body.onboardingToken || null);
      setInvoiceMode(!!body.invoiceMode);
      setCtaPhase('success');
      setReservation(null);
    } catch (err) {
      setError(err.message);
      setCtaPhase('review');
    }
  }, [token, selectedSlotId, paymentPreference, serviceMode, selectedFrequency]);

  const handleReviewCancel = useCallback(() => {
    setCtaPhase('configure');
    setReservation(null);
    setPaymentPreference(null);
    // Don't clear selectedSlotId — the customer may want to retry with
    // the same slot if the reservation call succeeded. Reservation row
    // still exists server-side for up to 15 min; the commit-on-accept
    // is idempotent.
  }, []);

  if (loading) {
    return <Page><Header customerFirstName={null} address={null} /><SkeletonBlock /><SkeletonBlock /></Page>;
  }
  if (notFound || !data) {
    return <Page><NotFoundCard /></Page>;
  }

  const { estimate, pricing, cta } = data;
  const canAccept = cta?.canAccept === true;

  if (!canAccept) {
    return (
      <Page>
        <Header customerFirstName={estimate.customerFirstName} address={estimate.address} />
        <TerminalStateCard
          state={cta.terminalState}
          customerFirstName={estimate.customerFirstName}
          address={estimate.address}
        />
        <GuaranteeStrip licenseNumber={estimate.licenseNumber} />
      </Page>
    );
  }

  if (ctaPhase === 'success') {
    return (
      <Page>
        <Header customerFirstName={estimate.customerFirstName} address={estimate.address} />
        <SuccessCard onboardingToken={onboardingToken} invoiceMode={invoiceMode} />
        <GuaranteeStrip licenseNumber={estimate.licenseNumber} />
      </Page>
    );
  }

  return (
    <Page>
      <Header customerFirstName={estimate.customerFirstName} address={estimate.address} />

      {ctaPhase === 'slot_conflict' ? (
        <SlotConflictBanner onRetry={() => setSlotsRefreshSignal((v) => v + 1)} />
      ) : null}

      {ctaPhase === 'review' && reservation ? (
        <ReviewPhase
          slotId={selectedSlotId}
          paymentPreference={paymentPreference}
          secondsRemaining={countdownSeconds}
          onConfirm={handleConfirm}
          onCancel={handleReviewCancel}
          invoiceMode={!!estimate.billByInvoice}
        />
      ) : (
        <>
          {/* One-time mode toggle — only rendered when admin opted this
              estimate into the one-time option AND there's a non-zero
              one-time price to offer. Default mode is 'recurring' so
              estimates without the flag behave identically to before. */}
          {estimate.showOneTimeOption && (pricing.anchorOneTimePrice || 0) > 0 ? (
            <OneTimeModeToggle
              mode={serviceMode}
              oneTimePrice={pricing.anchorOneTimePrice}
              onChange={(m) => {
                setServiceMode(m);
                // Reset selection state that doesn't apply in the other mode
                setSelectedSlotId(null);
                setPaymentPreference(null);
              }}
            />
          ) : null}

          {serviceMode === 'recurring' ? (
            <>
              {pricing.frequencies && pricing.frequencies.length > 1 ? (
                <FrequencySlider
                  frequencies={pricing.frequencies}
                  selected={selectedFrequency}
                  onChange={setSelectedFrequency}
                />
              ) : null}

              <PriceCard
                frequency={currentFrequency}
                anchorOneTimePrice={pricing.anchorOneTimePrice}
                waveGuardTier={pricing.waveGuardTier}
              />

              {(pricing.firstVisitFees && pricing.firstVisitFees.length > 0
                ? pricing.firstVisitFees
                : (pricing.setupFee ? [pricing.setupFee] : [])
              ).map((fee, i) => (
                <div key={`${fee.label || 'fee'}-${i}`} style={{
                  background: COLORS.white, borderRadius: 12,
                  padding: '12px 16px', marginBottom: 8,
                  border: `1px solid rgba(15,23,42,0.08)`,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                }}>
                  <div style={{ fontSize: 14, color: COLORS.textBody, lineHeight: 1.4 }}>
                    <span style={{ fontWeight: 600, color: COLORS.navy }}>+ {fmtMoney(fee.amount)} one-time {fee.label}</span>
                    {fee.waivedWithPrepay && (
                      <span style={{ display: 'block', fontSize: 12, color: COLORS.textCaption || COLORS.textBody, marginTop: 2 }}>
                        Waived when you prepay the year upfront.
                      </span>
                    )}
                  </div>
                </div>
              ))}

              <IncludedChecklist included={currentFrequency?.included || []} />

              <AddOnsBlock
                addOns={currentFrequency?.addOns || []}
                selectedKeys={selectedAddOns}
                onToggle={onToggleAddOn}
              />
            </>
          ) : (
            <OneTimePriceCard oneTimePrice={pricing.anchorOneTimePrice} />
          )}

          <SlotPicker
            token={token}
            selectedSlotId={selectedSlotId}
            onSelect={setSelectedSlotId}
            refreshSignal={slotsRefreshSignal}
          />

          {selectedSlotId ? (
            <PaymentPreferenceButtons
              onSelect={handlePaymentChoice}
              disabled={ctaPhase === 'submitting'}
              serviceMode={serviceMode}
              setupFee={pricing.setupFee || null}
              invoiceMode={!!estimate.billByInvoice}
            />
          ) : null}

          {error ? (
            <div style={{
              background: '#fee', borderRadius: 12, padding: 12,
              border: `1px solid ${COLORS.red}`, marginBottom: 16,
              color: COLORS.red, fontSize: 14,
            }}>
              Something went wrong: {error}. Try again or call{' '}
              <a href={`tel:${WAVES_PHONE_TEL}`} style={{ color: COLORS.red }}>{WAVES_PHONE_DISPLAY}</a>.
            </div>
          ) : null}
        </>
      )}

      <QuestionsEscapeHatch estimateSlug={estimate.slug} />
      <GuaranteeStrip licenseNumber={estimate.licenseNumber} />
    </Page>
  );
}
