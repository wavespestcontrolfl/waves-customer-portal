import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { COLORS, FONTS } from '../theme-brand';
import { CUSTOMER_SURFACE } from '../theme-customer';
import BrandFooter from '../components/BrandFooter';
import { useGlassSurface } from '../glass/glass-engine';
import GuaranteeStrip from '../components/estimate/GuaranteeStrip';
import QuestionsEscapeHatch from '../components/estimate/QuestionsEscapeHatch';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const WAVES_PHONE_DISPLAY = '(941) 297-5749';
const WAVES_PHONE_TEL = '+19412975749';
const BOOK_URL = 'https://wavespestcontrol.com/book?source=pest-report';

// Warm-brand tokens — mirror LawnReportViewPage (customer surface, not admin).
const BG = '#FAF8F3';
const BORDER = '#E7E2D7';
const TEXT = '#1B2C5B';
const BODY = '#3F4A65';
const MUTED = CUSTOMER_SURFACE.muted;
const CARD = COLORS.white;
const TAN = '#F2EEE0';

const URGENCY_PILL = {
  high: { label: 'Worth addressing quickly', color: COLORS.red },
  moderate: { label: 'Worth getting ahead of', color: COLORS.orange },
  low: { label: 'No emergency', color: COLORS.green },
};

const SAFETY_LABELS = [
  ['venomous', 'Venomous — don’t handle'],
  ['stinging', 'Can sting'],
  ['disease_vector', 'Can carry disease'],
  ['structural_threat', 'Can damage structures'],
];

function Page({ children }) {
  return (
    <div className="pest-report-page" style={{ minHeight: '100vh', background: BG, fontFamily: FONTS.body, color: BODY, display: 'flex', flexDirection: 'column' }}>
      {/* Liquid glass — same scoped reset as the lawn report so the non-glass
          render stays pixel-identical and printing yields the paper document. */}
      <style>{`
        html[data-glass-theme] .pest-report-page { background: transparent !important; }
        html[data-glass-theme] .pest-report-page [data-glass] { position: relative; }
        @media print {
          html[data-glass-theme] .pest-report-page { background: #fff !important; }
          html[data-glass-theme] .pest-report-page [data-glass],
          html[data-glass-theme] .pest-report-page [data-glass-accent] {
            background: #fff !important;
            border-color: #d4d4d4 !important;
            box-shadow: none !important;
            backdrop-filter: none !important;
            -webkit-backdrop-filter: none !important;
          }
          html[data-glass-theme] .glass-scene-orbs,
          html[data-glass-theme] .glass-scene-grain { display: none !important; }
        }
      `}</style>
      <main style={{ flex: 1, width: '100%', maxWidth: 720, margin: '0 auto', padding: '20px 16px 48px' }}>{children}</main>
      <BrandFooter variant="light" />
    </div>
  );
}

function SectionCard({ children, style }) {
  return (
    <section data-glass="card" style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 16, ...style }}>
      {children}
    </section>
  );
}

function SectionTitle({ children }) {
  return <h2 style={{ fontFamily: FONTS.serif, fontSize: 22, fontWeight: 500, lineHeight: 1.2, color: TEXT, margin: '0 0 12px' }}>{children}</h2>;
}

function UrgencyPill({ urgency, notAPest }) {
  if (notAPest) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 999, background: COLORS.white, border: `1px solid ${BORDER}`, fontFamily: FONTS.heading, fontWeight: 700, fontSize: 14, color: TEXT }}>
        <span style={{ width: 10, height: 10, borderRadius: 999, background: COLORS.green, flex: 'none' }} />
        Good news
      </span>
    );
  }
  const pill = URGENCY_PILL[urgency] || URGENCY_PILL.low;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 999, background: COLORS.white, border: `1px solid ${BORDER}`, fontFamily: FONTS.heading, fontWeight: 700, fontSize: 14, color: TEXT }}>
      <span style={{ width: 10, height: 10, borderRadius: 999, background: pill.color, flex: 'none' }} />
      {pill.label}
    </span>
  );
}

function NotFoundCard() {
  return (
    <SectionCard style={{ textAlign: 'center', marginTop: 40 }}>
      <SectionTitle>This pest report isn&apos;t available</SectionTitle>
      <p style={{ margin: '0 0 16px', color: BODY, fontSize: 15, lineHeight: 1.55 }}>
        The link may have expired or is no longer active. Give us a call and we&apos;ll take a fresh look at what you&apos;re seeing.
      </p>
      <a data-glass-accent="" href={`tel:${WAVES_PHONE_TEL}`} style={{ display: 'inline-block', padding: '12px 18px', borderRadius: 10, background: COLORS.blueDeeper, color: COLORS.white, fontFamily: FONTS.heading, fontWeight: 700, fontSize: 15, textDecoration: 'none' }}>
        Call {WAVES_PHONE_DISPLAY}
      </a>
    </SectionCard>
  );
}

function PricingCard({ pricing }) {
  const tiers = Array.isArray(pricing?.tiers) ? pricing.tiers : [];
  if (!tiers.length) return null;
  return (
    <SectionCard>
      <SectionTitle>{pricing.service_label || 'Your plan'}</SectionTitle>
      <div style={{ display: 'grid', gap: 10 }}>
        {tiers.map((tier, i) => (
          <div key={`${tier.label}-${i}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', border: `1px solid ${tier.recommended ? COLORS.blueDeeper : BORDER}`, borderRadius: 10, background: COLORS.white, padding: '12px 14px' }}>
            <div>
              <div style={{ fontFamily: FONTS.heading, fontWeight: 700, fontSize: 15, color: TEXT }}>{tier.label}</div>
              {/* One-time packages count TOTAL visits (flea = 2-visit package),
                  not a recurring per-year cadence. */}
              {tier.visits ? (
                <div style={{ fontSize: 14, color: MUTED }}>
                  {tier.one_time != null ? `${tier.visits}-visit treatment` : `${tier.visits} visits per year`}
                </div>
              ) : null}
            </div>
            <div style={{ textAlign: 'right' }}>
              {tier.monthly != null ? (
                <div style={{ fontFamily: FONTS.heading, fontWeight: 800, fontSize: 18, color: TEXT }}>
                  ${tier.monthly}<span style={{ fontSize: 14, fontWeight: 600, color: MUTED }}>/mo</span>
                </div>
              ) : null}
              {tier.annual != null ? <div style={{ fontSize: 14, color: MUTED }}>${tier.annual}/yr</div> : null}
              {tier.one_time != null ? (
                <div style={{ fontFamily: FONTS.heading, fontWeight: 800, fontSize: 18, color: TEXT }}>
                  ${tier.one_time}<span style={{ fontSize: 14, fontWeight: 600, color: MUTED }}> one-time</span>
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {pricing.basis_note ? (
        <p style={{ margin: '12px 0 0', color: MUTED, fontSize: 14, lineHeight: 1.5 }}>{pricing.basis_note}</p>
      ) : null}
    </SectionCard>
  );
}

export default function PestReportViewPage() {
  const { token } = useParams();
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useGlassSurface(true, 'full');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/public/pest-identifier/${token}`);
      if (res.status === 404) { setNotFound(true); setLoading(false); return; }
      if (!res.ok) throw new Error(`pest report fetch failed: ${res.status}`);
      const body = await res.json();
      setReport(body.report || null);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <Page>
        <SectionCard style={{ height: 120 }} />
        <SectionCard style={{ height: 220 }} />
      </Page>
    );
  }
  if (notFound || !report) {
    return <Page><NotFoundCard /></Page>;
  }

  const greeting = report.first_name ? `${report.first_name}, here` : 'Here';
  const safetyFlags = SAFETY_LABELS.filter(([key]) => report.safety && report.safety[key]);
  const recommendation = report.recommendation;

  return (
    <Page>
      {/* Hero */}
      <SectionCard style={{ background: TAN }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
          <h1 style={{ fontFamily: FONTS.serif, fontSize: 26, fontWeight: 500, lineHeight: 1.18, color: TEXT, margin: 0 }}>
            {greeting}&apos;s what we identified
          </h1>
          <UrgencyPill urgency={report.urgency} notAPest={report.not_a_pest} />
        </div>
        <p style={{ margin: 0, fontFamily: FONTS.heading, fontWeight: 800, fontSize: 20, lineHeight: 1.3, color: TEXT }}>
          {/* Generic labels arrive lowercase ("an ant species") and read as a
              sentence; named labels ("Ghost Ants", "Likely Ghost Ants") stand
              alone as the headline. */}
          {/^[a-z]/.test(report.identified?.label || '') ? `We identified ${report.identified.label}` : (report.identified?.label || 'We took a close look')}
        </p>
        {safetyFlags.length ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            {safetyFlags.map(([key, label]) => (
              <span key={key} style={{ padding: '5px 10px', borderRadius: 999, background: '#FEF2F2', border: `1px solid ${COLORS.red}`, color: COLORS.red, fontFamily: FONTS.heading, fontWeight: 700, fontSize: 14 }}>
                {label}
              </span>
            ))}
          </div>
        ) : null}
      </SectionCard>

      {/* About */}
      {report.about ? (
        <SectionCard>
          <SectionTitle>{report.not_a_pest ? 'Why this one’s fine' : 'What you should know'}</SectionTitle>
          <p style={{ margin: 0, color: BODY, fontSize: 15, lineHeight: 1.6 }}>{report.about}</p>
        </SectionCard>
      ) : null}

      {/* Recommendation */}
      {recommendation ? (
        <SectionCard>
          <SectionTitle>Our recommendation</SectionTitle>
          <p style={{ margin: '0 0 6px', fontFamily: FONTS.heading, fontWeight: 700, fontSize: 15, color: TEXT }}>
            {recommendation.service_label}
            {recommendation.inspection_required ? ' — starting with a free inspection' : ''}
          </p>
          {recommendation.note ? (
            <p style={{ margin: 0, color: BODY, fontSize: 14, lineHeight: 1.55 }}>{recommendation.note}</p>
          ) : null}
          {report.next_step ? (
            <p style={{ margin: '10px 0 0', color: BODY, fontSize: 15, lineHeight: 1.55 }}>{report.next_step}</p>
          ) : null}
        </SectionCard>
      ) : null}

      {/* Pricing (server-computed at unlock; present only for priceable lines) */}
      {!report.not_a_pest ? <PricingCard pricing={report.pricing} /> : null}

      {/* CTA */}
      {!report.not_a_pest ? (
        <SectionCard style={{ background: TAN }}>
          <SectionTitle>Ready when you are</SectionTitle>
          <p style={{ margin: '0 0 14px', color: BODY, fontSize: 15, lineHeight: 1.55 }}>
            {recommendation?.inspection_required
              ? 'Book your free inspection online in about a minute, or call and a real person will help you right away.'
              : 'Book online in about a minute, or call and a real person will help you right away.'}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <a data-glass-accent="" href={BOOK_URL} style={{ flex: '1 1 200px', textAlign: 'center', padding: '14px 18px', borderRadius: 10, background: COLORS.yellow, color: TEXT, fontFamily: FONTS.heading, fontWeight: 800, fontSize: 16, textDecoration: 'none' }}>
              Book now
            </a>
            <a href={`tel:${WAVES_PHONE_TEL}`} style={{ flex: '1 1 200px', textAlign: 'center', padding: '14px 18px', borderRadius: 10, background: COLORS.blueDeeper, color: COLORS.white, fontFamily: FONTS.heading, fontWeight: 700, fontSize: 16, textDecoration: 'none' }}>
              Call {WAVES_PHONE_DISPLAY}
            </a>
          </div>
        </SectionCard>
      ) : (
        <SectionCard style={{ background: TAN }}>
          <SectionTitle>Seeing something else?</SectionTitle>
          <p style={{ margin: '0 0 14px', color: BODY, fontSize: 15, lineHeight: 1.55 }}>
            If different bugs show up — or this one keeps coming back in numbers — we&apos;re happy to take a look.
          </p>
          <a href={`tel:${WAVES_PHONE_TEL}`} style={{ display: 'inline-block', padding: '12px 18px', borderRadius: 10, background: COLORS.blueDeeper, color: COLORS.white, fontFamily: FONTS.heading, fontWeight: 700, fontSize: 15, textDecoration: 'none' }}>
            Call {WAVES_PHONE_DISPLAY}
          </a>
        </SectionCard>
      )}

      <GuaranteeStrip />
      <QuestionsEscapeHatch context="pest_report" />
    </Page>
  );
}
