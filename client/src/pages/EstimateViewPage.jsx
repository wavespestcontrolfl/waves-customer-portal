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
 *   ctaPhase             — 'configure' | 'review' | 'submitting' | 'success' | 'slot_conflict' | 'reservation_expired'
 *   reservation          — { scheduledServiceId, expiresAt } | null
 *   paymentPreference    — 'card_on_file' | 'pay_at_visit' | 'prepay_annual' | null
 *   countdownSeconds     — derived from reservation.expiresAt
 *
 * Matches PayPage / TrackPage convention: inline styles + W palette,
 * mobile-first stacked layout, two-column desktop via grid.
 */
import Icon from '../components/Icon';
import { COLORS, FONTS } from '../theme-brand';
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
const ESTIMATE_BG = '#FAF8F3';
const ESTIMATE_BORDER = '#E7E2D7';
const ESTIMATE_MUTED = '#6B7280';
const ESTIMATE_TEXT = '#1B2C5B';
const ESTIMATE_BUTTON_BG = COLORS.blueDeeper;

function fmtMoney(n) {
  if (n == null) return '—';
  const v = Math.round(Number(n) * 100) / 100;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function Page({ children }) {
  return (
    <div style={{
      minHeight: '100vh', background: ESTIMATE_BG,
      fontFamily: FONT_BODY, color: COLORS.navy,
      display: 'flex', flexDirection: 'column',
    }}>
      <header style={{ background: COLORS.white, borderBottom: `1px solid ${ESTIMATE_BORDER}` }}>
        <div style={{
          maxWidth: 960,
          margin: '0 auto',
          padding: '16px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
        }}>
          <a href={`tel:${WAVES_PHONE_TEL}`} style={{
            color: ESTIMATE_TEXT,
            fontSize: 15,
            fontWeight: 600,
            textDecoration: 'none',
          }}>
            {WAVES_PHONE_DISPLAY}
          </a>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 28, display: 'block' }} />
        </div>
      </header>
      <div style={{ flex: 1, padding: '32px 20px 64px', maxWidth: 720, width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
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

function Header({ customerFirstName, address, serviceLabel, canChooseOneTime }) {
  const firstName = customerFirstName || 'there';
  return (
    <div style={{ padding: '8px 0 24px' }}>
      <div style={{
        fontSize: 12,
        color: ESTIMATE_MUTED,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        fontWeight: 700,
        marginBottom: 6,
      }}>
        Your estimate{serviceLabel ? ` · ${serviceLabel}` : ''}
      </div>
      <h1 style={{
        fontFamily: FONTS.serif,
        fontSize: 'clamp(34px, 5vw, 48px)',
        fontWeight: 500,
        letterSpacing: '-0.01em',
        lineHeight: 1.1,
        color: ESTIMATE_TEXT,
        margin: 0,
      }}>
        Hey {firstName}, {canChooseOneTime ? 'choose your pest control option.' : "here's your custom quote."}
      </h1>
      {address ? (
        <div style={{ fontSize: 20, color: '#3F4A65', marginTop: 16, lineHeight: 1.35 }}>{address}</div>
      ) : null}
    </div>
  );
}

function WaveGuardIntelligenceCard({ intelligence, address }) {
  if (!intelligence) return null;
  const metrics = Array.isArray(intelligence.metrics) ? intelligence.metrics : [];
  const signals = Array.isArray(intelligence.signals) ? intelligence.signals : [];
  const satelliteUrl = intelligence.satelliteUrl;

  return (
    <section style={{
      background: 'linear-gradient(180deg, #F5F1E6 0%, #FFFFFF 100%)',
      border: `1px solid ${ESTIMATE_BORDER}`,
      borderRadius: 12,
      padding: 24,
      marginBottom: 16,
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: 16,
        flexWrap: 'wrap',
        marginBottom: 10,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 12,
            color: ESTIMATE_MUTED,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            fontWeight: 700,
            marginBottom: 6,
          }}>
            {intelligence.eyebrow || 'Waves AI'}
          </div>
          <h2 style={{
            fontFamily: FONTS.serif,
            fontSize: 28,
            fontWeight: 500,
            lineHeight: 1.18,
            color: ESTIMATE_TEXT,
            margin: 0,
            letterSpacing: 0,
          }}>
            {intelligence.title || 'Waves AI reviewed your property before pricing this estimate'}
          </h2>
        </div>
      </div>

      <p style={{
        margin: satelliteUrl || metrics.length ? '0 0 14px' : '0',
        color: '#3F4A65',
        fontSize: 14,
        lineHeight: 1.55,
      }}>
        {intelligence.body}
      </p>

      {satelliteUrl ? (
        <img
          src={satelliteUrl}
          alt={`Satellite view of ${address || 'your property'}`}
          loading="lazy"
          style={{
            display: 'block',
            width: '100%',
            maxHeight: 320,
            objectFit: 'cover',
            borderRadius: 10,
            border: `1px solid ${ESTIMATE_BORDER}`,
            background: '#F7F5EE',
          }}
        />
      ) : null}

      {metrics.length ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))',
          gap: 10,
          marginTop: 14,
        }}>
          {metrics.map((metric) => (
            <div
              key={`${metric.label}-${metric.value}`}
              style={{
                background: COLORS.white,
                border: `1px solid ${ESTIMATE_BORDER}`,
                borderRadius: 10,
                padding: '10px 12px',
              }}
            >
              <div style={{
                fontSize: 14,
                color: ESTIMATE_MUTED,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginBottom: 4,
              }}>
                {metric.label}
              </div>
              <div style={{
                fontFamily: FONTS.serif,
                fontSize: 18,
                fontWeight: 500,
                color: ESTIMATE_TEXT,
              }}>
                {metric.value}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {signals.length ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 10,
          marginTop: 14,
        }}>
          {signals.map((signal) => (
            <div
              key={signal}
              style={{
                border: `1px solid ${ESTIMATE_BORDER}`,
                borderLeft: `4px solid ${COLORS.blueBright}`,
                borderRadius: 10,
                background: COLORS.white,
                padding: '10px 12px',
                color: '#3F4A65',
                fontSize: 16,
                lineHeight: 1.45,
              }}
            >
              {signal}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

const ESTIMATE_ASK_PROMPTS = [
  'What is included?',
  'How does billing work?',
  'Why this price?',
  'Who is Waves?',
];

function EstimateAskBar({ token, askToken, selectedFrequency, serviceMode = 'recurring' }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState(false);

  const ask = useCallback(async (prompt) => {
    const q = String(prompt ?? question).trim();
    if (!q || asking) return;
    setAsking(true);
    setFailed(false);
    setAnswer('Checking...');
    try {
      const response = await fetch(`${API_BASE}/public/estimates/${token}/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(askToken ? { 'X-Estimate-Ask-Token': askToken } : {}),
        },
        body: JSON.stringify({
          question: q,
          selectedFrequency,
          serviceMode,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'question_failed');
      setAnswer(body.answer || 'I could not answer that from this estimate.');
      setQuestion('');
    } catch {
      setFailed(true);
      setAnswer(`I could not answer that right now. Call or text Waves at ${WAVES_PHONE_DISPLAY}.`);
    } finally {
      setAsking(false);
    }
  }, [asking, askToken, question, selectedFrequency, serviceMode, token]);

  return (
    <section style={{
      background: COLORS.white,
      border: '1px solid #CFE7F5',
      borderRadius: 12,
      padding: 24,
      marginBottom: 16,
      display: 'grid',
      gap: 12,
    }}>
      <div>
        <div style={{
          fontSize: 12,
          color: ESTIMATE_MUTED,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          fontWeight: 700,
          marginBottom: 6,
        }}>
          Waves AI
        </div>
        <h2 style={{
          fontFamily: FONTS.serif,
          fontSize: 28,
          fontWeight: 500,
          lineHeight: 1.18,
          color: ESTIMATE_TEXT,
          margin: 0,
          letterSpacing: 0,
        }}>
          Ask Waves AI
        </h2>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          ask();
        }}
        style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 10, alignItems: 'center' }}
      >
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Ask about services, pricing, scheduling, or Waves"
          aria-label="Ask Waves AI about this estimate"
          maxLength={500}
          style={{
            width: '100%',
            minHeight: 48,
            border: '1px solid #CFE7F5',
            borderRadius: 10,
            padding: '12px 14px',
            font: `500 15px/1.35 ${FONT_BODY}`,
            color: ESTIMATE_TEXT,
            background: '#F8FCFE',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        <button
          type="submit"
          disabled={asking || !question.trim()}
          style={{
            minHeight: 48,
            border: 0,
            borderRadius: 10,
            padding: '0 18px',
            background: ESTIMATE_BUTTON_BG,
            color: COLORS.white,
            fontSize: 14,
            fontWeight: 700,
            cursor: asking || !question.trim() ? 'not-allowed' : 'pointer',
            opacity: asking || !question.trim() ? 0.65 : 1,
          }}
        >
          {asking ? 'Asking...' : 'Ask'}
        </button>
      </form>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }} aria-label="Example questions">
        {ESTIMATE_ASK_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => {
              setQuestion(prompt);
              ask(prompt);
            }}
            disabled={asking}
            style={{
              border: `1px solid ${ESTIMATE_BORDER}`,
              background: ESTIMATE_BUTTON_BG,
              color: COLORS.white,
              borderRadius: 999,
              padding: '8px 12px',
              fontSize: 12,
              fontWeight: 700,
              cursor: asking ? 'not-allowed' : 'pointer',
              opacity: asking ? 0.65 : 1,
            }}
          >
            {prompt}
          </button>
        ))}
      </div>

      {answer ? (
        <div
          aria-live="polite"
          style={{
            borderLeft: `4px solid ${failed ? COLORS.red : ESTIMATE_BUTTON_BG}`,
            background: failed ? '#FFF5F5' : '#F8FCFE',
            borderRadius: 10,
            padding: '12px 14px',
            color: ESTIMATE_TEXT,
            fontSize: 14,
            lineHeight: 1.55,
            whiteSpace: 'pre-line',
          }}
        >
          {answer}
        </div>
      ) : null}
    </section>
  );
}

function getServiceLabel(frequency, estimate, pricing) {
  if (estimate?.isOneTimeOnly) {
    const primary = pricing?.oneTimeBreakdown?.items?.find((item) => item?.kind !== 'discount');
    return primary?.label || 'One-time service';
  }
  if (estimate?.showOneTimeOption && (pricing?.anchorOneTimePrice || 0) > 0) {
    return `${frequency?.label || 'Quarterly'} Pest Control or One-Time Pest Control`;
  }
  if (frequency?.label) return `${frequency.label} Pest Control`;
  return 'Custom quote';
}

function SetupFeeCard({ fee }) {
  if (!fee) return null;
  return (
    <div style={{
      marginTop: 12,
      marginBottom: 18,
      padding: '14px 16px',
      border: '1px solid #D4CBB8',
      borderRadius: 10,
      background: COLORS.white,
    }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: ESTIMATE_TEXT, lineHeight: 1.35 }}>
        + {fmtMoney(fee.amount)} one-time {fee.label || 'first-visit setup'}
      </div>
      {fee.waivedWithPrepay ? (
        <div style={{ fontSize: 14, color: ESTIMATE_MUTED, marginTop: 2, lineHeight: 1.45 }}>
          Waived when you pay the year in full up front.
        </div>
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
      background: '#F1F5F9', borderRadius: 999, padding: 4,
      border: '1px solid #E2E8F0', marginBottom: 18,
      display: 'flex', gap: 4,
      boxShadow: '0 1px 4px rgba(15,23,42,.04)',
    }}>
      <button
        type="button"
        onClick={() => onChange('recurring')}
        style={{
          ...pillBase,
          background: mode === 'recurring' ? ESTIMATE_BUTTON_BG : 'transparent',
          color: mode === 'recurring' ? COLORS.white : COLORS.textBody,
        }}
      >Recurring Pest Control</button>
      <button
        type="button"
        onClick={() => onChange('one_time')}
        style={{
          ...pillBase,
          background: mode === 'one_time' ? ESTIMATE_BUTTON_BG : 'transparent',
          color: mode === 'one_time' ? COLORS.white : COLORS.textBody,
        }}
      >One-Time Pest Control</button>
    </div>
  );
}

function OneTimePriceCard({ oneTimePrice }) {
  return (
    <div style={{
      padding: '14px 0 24px',
      marginBottom: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: FONTS.serif, fontSize: 56, fontWeight: 500, color: ESTIMATE_TEXT, lineHeight: 1 }}>
        {fmtMoney(oneTimePrice)}
        </span>
        <span style={{ fontSize: 24, fontWeight: 500, color: ESTIMATE_MUTED }}>one-time</span>
      </div>
      <div style={{ fontSize: 16, color: '#3F4A65', marginTop: 14, lineHeight: 1.55 }}>
        One visit, pay on service day. No recurring schedule, no tier discount.
        Includes a 30-day callback period if pests return after this visit.
      </div>
    </div>
  );
}

function OneTimeBreakdownCard({ breakdown, excludeServices = [] }) {
  const excluded = new Set(excludeServices.filter(Boolean));
  const items = (Array.isArray(breakdown?.items) ? breakdown.items : [])
    .filter((item) => !excluded.has(item?.service));
  if (items.length === 0) return null;
  const hasQuoteRequired = items.some((item) => item?.quoteRequired === true || item?.kind === 'quote_required');
  const total = excludeServices.length === 0 && Number.isFinite(Number(breakdown?.total))
    ? Number(breakdown.total)
    : items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const totalIsQuoteRequired = hasQuoteRequired && total <= 0;

  return (
    <div style={{
      background: COLORS.white, borderRadius: 16, padding: 18,
      border: `1px solid ${COLORS.grayLight}`, marginBottom: 16,
      boxShadow: '0 1px 6px rgba(15,23,42,0.04)',
    }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.navy, marginBottom: 10 }}>
        One-time services
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        {items.map((item, i) => {
          const isQuoteRequired = item.quoteRequired === true || item.kind === 'quote_required';
          const amount = Number(item.amount) || 0;
          const isDiscount = !isQuoteRequired && (amount < 0 || item.kind === 'discount');
          const isIncluded = !isQuoteRequired && item.kind === 'included';
          return (
            <div key={`${item.service || item.label || 'item'}-${i}`} style={{
              display: 'grid', gridTemplateColumns: '1fr auto', gap: 12,
              alignItems: 'start', paddingBottom: i === items.length - 1 ? 0 : 10,
              borderBottom: i === items.length - 1 ? 'none' : `1px solid ${COLORS.grayLight}`,
            }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.navy }}>
                  {item.label || 'One-time service'}
                </div>
                {item.detail ? (
                  <div style={{ fontSize: 12, color: COLORS.textCaption, marginTop: 2, lineHeight: 1.35 }}>
                    {item.detail}
                  </div>
                ) : null}
              </div>
              <div style={{
                fontSize: 14, fontWeight: 700,
                color: isQuoteRequired ? COLORS.red : (isDiscount || isIncluded ? COLORS.green : COLORS.navy),
                whiteSpace: 'nowrap',
              }}>
                {isQuoteRequired ? 'Quote Required' : (isIncluded ? 'Included' : `${isDiscount ? '-' : ''}${fmtMoney(Math.abs(amount))}`)}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between', gap: 12,
        borderTop: `1px solid ${COLORS.grayLight}`, marginTop: 12, paddingTop: 12,
        fontSize: 15, fontWeight: 700, color: COLORS.navy,
      }}>
        <span>{totalIsQuoteRequired ? 'Quote status' : 'One-time total'}</span>
        <span style={totalIsQuoteRequired ? { color: COLORS.red } : null}>
          {totalIsQuoteRequired ? 'Quote Required' : fmtMoney(total)}
        </span>
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
      borderTop: `4px solid ${ESTIMATE_BUTTON_BG}`, boxShadow: '0 2px 12px rgba(15,23,42,0.06)',
      marginBottom: 16,
    }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: ESTIMATE_BUTTON_BG, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        Confirm your booking
      </div>
      <div style={{ fontSize: 18, color: COLORS.navy, marginTop: 10, lineHeight: 1.5 }}>
        Pay option: <strong>{
          invoiceMode ? 'Invoice due now'
          : paymentPreference === 'card_on_file' ? 'Card on file'
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
            padding: '16px 20px', background: ESTIMATE_BUTTON_BG, color: COLORS.white,
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

function SuccessCard({ acceptResult }) {
  const nextStep = acceptResult?.nextStep || (acceptResult?.invoiceMode ? 'pay_invoice' : 'confirmed');
  const onboardingToken = acceptResult?.onboardingToken || null;
  const bookingUrl = acceptResult?.bookingUrl || null;
  const invoiceLinkDelivered = !!acceptResult?.invoiceLinkDelivered;
  const prepayInvoiceAmount = Number(acceptResult?.prepayInvoiceAmount);
  const prepayAmountText = Number.isFinite(prepayInvoiceAmount) && prepayInvoiceAmount > 0
    ? ` for ${fmtMoney(prepayInvoiceAmount)}`
    : '';

  if (nextStep === 'pay_invoice') {
    return (
      <div style={{
        background: COLORS.white, borderRadius: 16, padding: 28, textAlign: 'center',
        borderTop: `4px solid ${COLORS.green}`, boxShadow: '0 2px 12px rgba(15,23,42,0.06)',
        marginBottom: 16,
      }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.navy, marginTop: 8 }}>
          {invoiceLinkDelivered ? 'Thanks — your invoice is on the way.' : 'Thanks — your estimate is approved.'}
        </div>
      <div style={{ fontSize: 16, color: COLORS.textBody, marginTop: 10, lineHeight: 1.55 }}>
        {invoiceLinkDelivered
          ? 'Use the invoice pay link we sent to complete payment. Your service request has been received and our team will confirm the schedule.'
          : 'Our team will follow up with the invoice details. Your service request has been received and our team will confirm the schedule.'}
      </div>
    </div>
    );
  }

  if (nextStep === 'prepay_invoice') {
    return (
      <div style={{
        background: COLORS.white, borderRadius: 16, padding: 28, textAlign: 'center',
        borderTop: `4px solid ${COLORS.green}`, boxShadow: '0 2px 12px rgba(15,23,42,0.06)',
        marginBottom: 16,
      }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.navy, marginTop: 8 }}>
          Your annual prepay is approved.
        </div>
        <div style={{ fontSize: 16, color: COLORS.textBody, marginTop: 10, lineHeight: 1.55 }}>
          Our team will review and send the annual prepay invoice{prepayAmountText}. Your service request has been received and our team will confirm the schedule.
        </div>
      </div>
    );
  }

  if (nextStep === 'book_one_time') {
    return (
      <div style={{
        background: COLORS.white, borderRadius: 16, padding: 28, textAlign: 'center',
        borderTop: `4px solid ${COLORS.green}`, boxShadow: '0 2px 12px rgba(15,23,42,0.06)',
        marginBottom: 16,
      }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.navy, marginTop: 8 }}>
          You're approved for a one-time service.
        </div>
        <div style={{ fontSize: 16, color: COLORS.textBody, marginTop: 10, lineHeight: 1.55 }}>
          {bookingUrl
            ? 'Check your phone for the booking link, or pick your appointment now.'
            : 'Our team will follow up to help schedule your appointment.'}
        </div>
        {bookingUrl ? (
          <a
            href={bookingUrl}
            style={{
              display: 'inline-block', marginTop: 16, padding: '14px 20px',
              background: ESTIMATE_BUTTON_BG, color: COLORS.white, textDecoration: 'none',
              borderRadius: 12, fontWeight: 600, fontSize: 15,
            }}
          >Pick appointment</a>
        ) : null}
      </div>
    );
  }

  if (nextStep === 'complete_onboarding') {
    return (
      <div style={{
        background: COLORS.white, borderRadius: 16, padding: 28, textAlign: 'center',
        borderTop: `4px solid ${COLORS.green}`, boxShadow: '0 2px 12px rgba(15,23,42,0.06)',
        marginBottom: 16,
      }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.navy, marginTop: 8 }}>
          You're booked.
        </div>
        <div style={{ fontSize: 16, color: COLORS.textBody, marginTop: 10, lineHeight: 1.55 }}>
          Check your phone for the confirmation text. Finish setup to keep your appointment moving.
        </div>
        {onboardingToken ? (
          <a
            href={`/onboard/${onboardingToken}`}
            style={{
              display: 'inline-block', marginTop: 16, padding: '14px 20px',
              background: ESTIMATE_BUTTON_BG, color: COLORS.white, textDecoration: 'none',
              borderRadius: 12, fontWeight: 600, fontSize: 15,
            }}
          >Continue to setup</a>
        ) : null}
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
        Check your phone for the confirmation text. Our team will confirm the schedule.
      </div>
    </div>
  );
}

function SlotIssueBanner({ kind = 'conflict', onRetry }) {
  const expired = kind === 'expired';
  return (
    <div style={{
      background: '#fff4e5', borderRadius: 12, padding: 14,
      border: `1px solid #f5bb5c`, marginBottom: 16,
    }}>
      <div style={{ fontSize: 14, color: COLORS.navy }}>
        {expired
          ? 'Your hold expired. Pick a new time to continue.'
          : "That slot was just taken. We've refreshed the options below — pick another."}
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          style={{
            marginTop: 10, padding: '8px 14px',
            background: ESTIMATE_BUTTON_BG, color: COLORS.white, border: 'none',
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
  // serviceMode: 'recurring' | 'one_time'. Most estimates default to
  // recurring; structurally one-time estimates are forced to one_time after
  // the data endpoint loads.
  const [serviceMode, setServiceMode] = useState('recurring');
  const [paymentPreference, setPaymentPreference] = useState(null);
  const [ctaPhase, setCtaPhase] = useState('configure');
  const [reservation, setReservation] = useState(null);
  const [acceptResult, setAcceptResult] = useState(null);
  const [error, setError] = useState(null);
  const [slotsRefreshSignal, setSlotsRefreshSignal] = useState(0);

  const [countdownSeconds, setCountdownSeconds] = useState(0);
  const countdownRef = useRef(null);
  const selectedFrequencyRef = useRef(null);
  const reserveAttemptRef = useRef(0);

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
    const defaultServiceMode = body?.estimate?.defaultServiceMode || body?.pricing?.defaultServiceMode;
    const isOneTimeOnly = body?.estimate?.isOneTimeOnly === true || defaultServiceMode === 'one_time';
    setServiceMode((prev) => {
      if (isOneTimeOnly) return 'one_time';
      if (preserveSelection) return prev;
      return defaultServiceMode === 'one_time' ? 'one_time' : 'recurring';
    });
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
        setCtaPhase('reservation_expired');
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

  const releaseHeldReservation = useCallback((scheduledServiceId) => {
    if (!scheduledServiceId) return;
    fetch(`${API_BASE}/public/estimates/${token}/reserve/${encodeURIComponent(scheduledServiceId)}`, {
      method: 'DELETE',
    }).catch(() => {});
  }, [token]);

  const handlePaymentChoice = useCallback(async (pref) => {
    if (!selectedSlotId) return;
    const attemptId = reserveAttemptRef.current + 1;
    reserveAttemptRef.current = attemptId;
    const slotIdForAttempt = selectedSlotId;
    const serviceModeForAttempt = serviceMode;
    const selectedFrequencyForAttempt = selectedFrequency;
    setPaymentPreference(pref);
    setCtaPhase('submitting');
    setError(null);

    try {
      const reservePayload = { slotId: slotIdForAttempt, serviceMode: serviceModeForAttempt };
      if (serviceModeForAttempt !== 'one_time' && selectedFrequencyForAttempt) {
        reservePayload.selectedFrequency = selectedFrequencyForAttempt;
      }
      const r = await fetch(`${API_BASE}/public/estimates/${token}/reserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reservePayload),
      });
      if (r.status === 409) {
        const body = await r.json().catch(() => ({}));
        if (reserveAttemptRef.current !== attemptId) return;
        const message = body.error || 'Unable to reserve this slot.';
        setPaymentPreference(null);
        setSelectedSlotId(null);
        if (/slot no longer available/i.test(message)) {
          setCtaPhase('slot_conflict');
          setSlotsRefreshSignal((v) => v + 1);
        } else if (/estimate is no longer active/i.test(message)) {
          setCtaPhase('configure');
          await loadEstimate();
        } else {
          setError(message);
          setCtaPhase('configure');
        }
        return;
      }
      if (!r.ok) throw new Error(`reserve failed: ${r.status}`);
      const body = await r.json();
      if (reserveAttemptRef.current !== attemptId) {
        releaseHeldReservation(body.scheduledServiceId);
        return;
      }
      setReservation({ scheduledServiceId: body.scheduledServiceId, expiresAt: body.expiresAt });
      setCtaPhase('review');
    } catch (err) {
      if (reserveAttemptRef.current !== attemptId) return;
      setError(err.message);
      setCtaPhase('configure');
    }
  }, [loadEstimate, releaseHeldReservation, selectedSlotId, serviceMode, selectedFrequency, token]);

  const handleFrequencyChange = useCallback((nextFrequency) => {
    reserveAttemptRef.current += 1;
    setSelectedFrequency(nextFrequency);
    setSelectedSlotId(null);
    setPaymentPreference(null);
    setReservation(null);
    setAcceptResult(null);
    setError(null);
    setCtaPhase('configure');
    setSlotsRefreshSignal((v) => v + 1);
  }, []);

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
          if (/estimate is no longer active/i.test(body.error || '')) {
            setCtaPhase('configure');
            setReservation(null);
            setSelectedSlotId(null);
            setPaymentPreference(null);
            await loadEstimate();
            return;
          }
          const expired = /expired|no active reservation/i.test(body.error || '');
          setCtaPhase(expired ? 'reservation_expired' : 'slot_conflict');
          setSlotsRefreshSignal((v) => v + 1);
          setReservation(null);
          setSelectedSlotId(null);
          setPaymentPreference(null);
          return;
        }
        throw new Error(body.error || `accept failed: ${r.status}`);
      }
      const body = await r.json();
      setAcceptResult(body);
      setCtaPhase('success');
      setReservation(null);
    } catch (err) {
      setError(err.message);
      setCtaPhase('review');
    }
  }, [loadEstimate, token, selectedSlotId, paymentPreference, serviceMode, selectedFrequency]);

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
  const showAskBar = !['accepted', 'declined', 'expired'].includes(cta?.terminalState);

  if (!canAccept) {
    return (
      <Page>
        <Header customerFirstName={estimate.customerFirstName} address={estimate.address} />
        <WaveGuardIntelligenceCard intelligence={estimate.intelligence} address={estimate.address} />
        {showAskBar ? (
          <EstimateAskBar
            token={token}
            askToken={estimate.askToken}
            selectedFrequency={selectedFrequency}
            serviceMode={serviceMode}
          />
        ) : null}
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
        <SuccessCard acceptResult={acceptResult} />
        <GuaranteeStrip licenseNumber={estimate.licenseNumber} />
      </Page>
    );
  }

  return (
    <Page>
      <Header
        customerFirstName={estimate.customerFirstName}
        address={estimate.address}
        serviceLabel={getServiceLabel(currentFrequency, estimate, pricing)}
        canChooseOneTime={estimate.showOneTimeOption && (pricing.anchorOneTimePrice || 0) > 0}
      />

      <WaveGuardIntelligenceCard intelligence={estimate.intelligence} address={estimate.address} />

      <EstimateAskBar
        token={token}
        askToken={estimate.askToken}
        selectedFrequency={selectedFrequency}
        serviceMode={serviceMode}
      />

      {ctaPhase === 'slot_conflict' || ctaPhase === 'reservation_expired' ? (
        <SlotIssueBanner
          kind={ctaPhase === 'reservation_expired' ? 'expired' : 'conflict'}
          onRetry={() => setSlotsRefreshSignal((v) => v + 1)}
        />
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
          {!estimate.isOneTimeOnly && estimate.showOneTimeOption && (pricing.anchorOneTimePrice || 0) > 0 ? (
            <OneTimeModeToggle
              mode={serviceMode}
              oneTimePrice={pricing.anchorOneTimePrice}
              onChange={(m) => {
                reserveAttemptRef.current += 1;
                setServiceMode(m);
                // Reset selection state that doesn't apply in the other mode
                setSelectedSlotId(null);
                setPaymentPreference(null);
                setReservation(null);
                setAcceptResult(null);
                setError(null);
                setCtaPhase('configure');
                setSlotsRefreshSignal((v) => v + 1);
              }}
            />
          ) : null}

          {serviceMode === 'recurring' ? (
            <>
              {pricing.frequencies && pricing.frequencies.length > 1 ? (
                <FrequencySlider
                  frequencies={pricing.frequencies}
                  selected={selectedFrequency}
                  onChange={handleFrequencyChange}
                  disabled={ctaPhase === 'submitting'}
                />
              ) : null}

              <PriceCard
                frequency={currentFrequency}
                waveGuardTier={pricing.waveGuardTier}
              />

              {(pricing.firstVisitFees && pricing.firstVisitFees.length > 0
                ? pricing.firstVisitFees
                : (pricing.setupFee ? [pricing.setupFee] : [])
              ).map((fee, i) => <SetupFeeCard key={`${fee.label || 'fee'}-${i}`} fee={fee} />)}

              {!estimate.showOneTimeOption ? (
                <OneTimeBreakdownCard
                  breakdown={pricing.oneTimeBreakdown}
                  excludeServices={(pricing.firstVisitFees || []).map((fee) => fee.service)}
                />
              ) : null}

              <IncludedChecklist included={currentFrequency?.included || []} />

              <AddOnsBlock
                addOns={currentFrequency?.addOns || []}
                selectedKeys={selectedAddOns}
                onToggle={onToggleAddOn}
              />
            </>
          ) : (
            <>
              <OneTimePriceCard oneTimePrice={pricing.anchorOneTimePrice || pricing.oneTimeBreakdown?.total || 0} />
              <OneTimeBreakdownCard breakdown={pricing.oneTimeBreakdown} />
            </>
          )}

          <SlotPicker
            token={token}
            selectedSlotId={selectedSlotId}
            onSelect={setSelectedSlotId}
            refreshSignal={slotsRefreshSignal}
            serviceMode={serviceMode}
            selectedFrequency={selectedFrequency}
          />

          {selectedSlotId ? (
            <PaymentPreferenceButtons
              onSelect={handlePaymentChoice}
              disabled={ctaPhase === 'submitting'}
              serviceMode={serviceMode}
              setupFee={pricing.setupFee || null}
              annualPrepayEligible={pricing.annualPrepayEligible === true}
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
