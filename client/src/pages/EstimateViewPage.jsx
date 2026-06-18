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
 *   selected             — { [section.key]: frequencyKey }
 *   selectedAddOns       — { [section.key]: Set(addon keys) }
 *   selectedSlotId       — string | null
 *   ctaPhase             — 'configure' | 'review' | 'submitting' | 'success' | 'slot_conflict' | 'reservation_expired'
 *   reservation          — { scheduledServiceId, expiresAt } | null
 *   paymentPreference    — 'pay_at_visit' | 'prepay_annual' | null
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
import { estimateCopyFor } from '../lib/estimate-copy';
import { quoteRequiredReasonNote, quoteRequiredReasonText } from '../lib/quoteDisplay';
import { loadStripeSdk } from '../lib/stripeLoader';

const FONT_BODY = "'Inter', system-ui, sans-serif";
const API_BASE = import.meta.env.VITE_API_URL || '/api';
const WAVES_PHONE_DISPLAY = '(941) 297-5749';
const WAVES_PHONE_TEL = '+19412975749';
const ESTIMATE_BG = '#FAF8F3';
const ESTIMATE_BORDER = '#E7E2D7';
const ESTIMATE_MUTED = '#6B7280';
const ESTIMATE_TEXT = '#1B2C5B';
const ESTIMATE_BODY = '#3F4A65';
const ESTIMATE_CHROME = '#F7F5EE';
const ESTIMATE_BUTTON_BG = COLORS.blueDeeper;

function fmtMoney(n) {
  if (n == null) return '—';
  const v = Math.round(Number(n) * 100) / 100;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function pricingServices(pricing = {}) {
  if (Array.isArray(pricing?.services) && pricing.services.length > 0) return pricing.services;
  const frequencies = Array.isArray(pricing?.frequencies) ? pricing.frequencies : [];
  if (!frequencies.length) return [];
  return [{
    key: 'pest_control',
    label: 'Pest Control',
    isRecurring: true,
    isPest: true,
    defaultFrequencyKey: frequencies[0]?.key || null,
    frequencies,
    setupFee: pricing?.setupFee || null,
    oneTimeContribution: null,
    intelligence: { metrics: [], chips: [] },
    quoteRequired: pricing?.quoteRequired === true,
    copy: null,
  }];
}

function defaultSelectedForServices(services = [], previous = {}, preserveSelection = false) {
  return services.reduce((next, section) => {
    const frequencies = Array.isArray(section.frequencies) ? section.frequencies : [];
    const previousKey = previous?.[section.key];
    const canPreserve = preserveSelection && previousKey && frequencies.some((frequency) => frequency.key === previousKey);
    next[section.key] = canPreserve
      ? previousKey
      : (section.defaultFrequencyKey || frequencies[0]?.key || null);
    return next;
  }, {});
}

function selectedFrequencyForSection(section, selected) {
  const frequencies = Array.isArray(section?.frequencies) ? section.frequencies : [];
  const selectedKey = selected?.[section?.key];
  return frequencies.find((frequency) => frequency.key === selectedKey) || frequencies[0] || null;
}

function selectedAddOnsForServices(services = [], selected = {}) {
  return services.reduce((next, section) => {
    const frequency = selectedFrequencyForSection(section, selected);
    next[section.key] = new Set((frequency?.addOns || []).filter((addOn) => addOn.preChecked).map((addOn) => addOn.key));
    return next;
  }, {});
}

function primarySelectedFrequencyKey(services = [], selected = {}) {
  const pestSection = services.find((section) => section.key === 'pest_control');
  const primary = pestSection || services.find((section) => section.isRecurring) || services[0];
  return primary ? selected[primary.key] || primary.defaultFrequencyKey || primary.frequencies?.[0]?.key || null : null;
}

function selectedPricingFrequencyKey(pricing = {}, services = [], selected = {}) {
  const sectionKey = primarySelectedFrequencyKey(services, selected);
  const frequencies = Array.isArray(pricing?.frequencies) ? pricing.frequencies : [];
  if (!frequencies.length) return sectionKey;
  if (frequencies.some((frequency) => frequency.key === sectionKey)) return sectionKey;
  return frequencies[0]?.key || null;
}

function selectedCombinedFrequency(pricing = {}, selectedFrequencyKey) {
  const frequencies = Array.isArray(pricing?.frequencies) ? pricing.frequencies : [];
  return frequencies.find((frequency) => frequency.key === selectedFrequencyKey) || frequencies[0] || null;
}

function serviceLabelForKey(key) {
  switch (key) {
    case 'tree_shrub': return 'Tree & Shrub';
    case 'lawn_care': return 'Lawn Care';
    case 'mosquito': return 'Mosquito';
    case 'termite_bait': return 'Termite Bait';
    case 'palm_injection': return 'Palm Injection';
    case 'rodent_bait': return 'Rodent Bait Stations';
    case 'pest_control': return 'Pest Control';
    default: return 'Service';
  }
}

function serviceKeysForEstimateSection(section = {}) {
  const keys = new Set();

  const collectText = (value) => {
    if (!value) return;
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value).toLowerCase();
      if (text.includes('pest')) keys.add('pest_control');
      if (text.includes('lawn')) keys.add('lawn_care');
      if (text.includes('mosquito')) keys.add('mosquito');
      if (text.includes('tree') || text.includes('shrub')) keys.add('tree_shrub');
      if (text.includes('termite')) keys.add('termite_bait');
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(collectText);
      return;
    }
    if (typeof value === 'object') {
      [
        value.key,
        value.service,
        value.serviceKey,
        value.service_key,
        value.category,
        value.label,
        value.name,
        value.title,
        value.description,
      ].forEach(collectText);
    }
  };

  if (section.isPest) keys.add('pest_control');
  collectText(section.memberKeys);
  collectText(`${section.key || ''} ${section.label || ''}`);
  collectText(section.services);
  collectText(section.serviceRows);
  collectText(section.serviceLines);
  collectText(section.recurringServices);
  const frequencies = Array.isArray(section.frequencies) ? section.frequencies : [];
  frequencies.forEach((frequency) => {
    collectText(frequency.perServiceTreatments);
    collectText(frequency.treatments);
    collectText(frequency.services);
    collectText(frequency.included);
    collectText(frequency.addOns);
  });

  return keys;
}

export function estimateAddServiceOffer(services = [], serviceMode = 'recurring', membership = null) {
  if (serviceMode !== 'recurring') return null;
  const currentKeys = new Set();
  services
    .filter((section) => section && section.isRecurring !== false)
    .forEach((section) => {
      serviceKeysForEstimateSection(section).forEach((key) => currentKeys.add(key));
    });

  // Existing customers: never offer a service already on the account.
  // Cross-sell ladder is seasonal mosquito → termite bait stations,
  // whichever they don't have yet (mirrors the server-rendered page).
  if (membership && membership.isExistingCustomer) {
    const combinedKeys = new Set([
      ...currentKeys,
      ...(membership.existingServiceKeys || []),
      ...((membership.existingServices || []).map((s) => s.key)),
      ...((membership.newServices || []).map((s) => s.key)),
    ]);
    if (!combinedKeys.has('mosquito')) {
      return {
        serviceKey: 'mosquito',
        label: 'Seasonal Mosquito',
        icon: 'sparkles',
        title: 'Add Seasonal Mosquito and save more',
        body: 'Seasonal barrier treatments for your lanai and yard — and bundling can unlock the next WaveGuard pricing tier.',
      };
    }
    if (!combinedKeys.has('termite_bait')) {
      return {
        serviceKey: 'termite_bait',
        label: 'Termite Bait Stations',
        icon: 'shield',
        title: 'Add Termite Bait Stations and save more',
        body: 'Year-round termite monitoring around your home perimeter — and bundling can unlock the next WaveGuard pricing tier.',
      };
    }
    return null;
  }

  if (currentKeys.has('pest_control') && !currentKeys.has('lawn_care')) {
    return {
      serviceKey: 'lawn_care',
      label: 'Lawn Care',
      icon: 'leaf',
      title: 'Add Lawn Care and save more',
      body: 'Bundling lawn care with your current service can unlock the next WaveGuard pricing tier.',
    };
  }
  if (currentKeys.has('lawn_care') && !currentKeys.has('pest_control')) {
    return {
      serviceKey: 'pest_control',
      label: 'Pest Control',
      icon: 'bug',
      title: 'Add Pest Control for bundled pricing',
      body: 'Add perimeter pest coverage and our team will send a revised bundled option.',
    };
  }
  if (currentKeys.has('pest_control') && currentKeys.has('lawn_care') && !currentKeys.has('mosquito')) {
    return {
      serviceKey: 'mosquito',
      label: 'Mosquito',
      icon: 'sparkles',
      title: 'Add Mosquito and save more',
      body: 'Add mosquito protection and our team will send an updated bundle option.',
    };
  }
  return null;
}

function recurringServiceForEstimate(pricing = {}) {
  const services = Array.isArray(pricing?.services) ? pricing.services : [];
  return services.find((service) => service?.isRecurring) || services[0] || null;
}

function frequencyServiceCategory(frequency = {}, pricing = {}) {
  if (frequency?.serviceCategory) return frequency.serviceCategory;
  const service = recurringServiceForEstimate(pricing);
  return service?.key || pricing?.serviceCategory || 'pest_control';
}

function labelAlreadyIncludesService(frequencyLabel, serviceLabel) {
  const left = String(frequencyLabel || '').toLowerCase();
  const right = String(serviceLabel || '').toLowerCase();
  return !!left && !!right && (left.includes(right) || right.includes(left));
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
      border: `1px solid ${ESTIMATE_BORDER}`, marginBottom: 16,
    }}>
      <div style={{ height: 12, width: 120, background: ESTIMATE_CHROME, borderRadius: 4 }} />
      <div style={{ height: 32, width: '60%', background: ESTIMATE_CHROME, borderRadius: 4, marginTop: 14 }} />
      <div style={{ height: 14, width: '40%', background: ESTIMATE_CHROME, borderRadius: 4, marginTop: 10 }} />
    </div>
  );
}

function NotFoundCard() {
  return (
    <div style={{
      background: COLORS.white, borderRadius: 16, padding: 32, textAlign: 'center',
      border: `1px solid ${ESTIMATE_BORDER}`, marginTop: 40,
    }}>
      <div style={{ fontSize: 32 }}></div>
      <div style={{ fontSize: 18, fontWeight: 600, marginTop: 8 }}>Estimate unavailable</div>
      <div style={{ fontSize: 16, color: ESTIMATE_BODY, marginTop: 12, lineHeight: 1.55 }}>
        This link may have expired or isn't valid. Call us at{' '}
        <a href={`tel:${WAVES_PHONE_TEL}`} style={{ color: COLORS.blueDark }}>{WAVES_PHONE_DISPLAY}</a>{' '}
        and we'll get you sorted.
      </div>
    </div>
  );
}

function Header({ customerFirstName, address, serviceLabel, canChooseOneTime, headline }) {
  const firstName = customerFirstName || 'there';
  const fallbackHeadline = `Hey {first}, ${canChooseOneTime ? 'choose your pest control option.' : "here's your custom quote."}`;
  const headlineText = String(headline || fallbackHeadline).replace('{first}', firstName);
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
        {headlineText}
      </h1>
      {address ? (
        <div style={{ fontSize: 20, color: '#3F4A65', marginTop: 16, lineHeight: 1.35 }}>{address}</div>
      ) : null}
    </div>
  );
}

function WaveGuardIntelligenceCard({ intelligence, address, copy, showYourWork = null }) {
  if (!intelligence) return null;
  const metrics = Array.isArray(intelligence.metrics) ? intelligence.metrics : [];
  const signals = Array.isArray(intelligence.signals) ? intelligence.signals : [];
  // "Show your work" (estimateShowYourWork gate): the parcel-outline
  // satellite image replaces the plain one when the server resolved it.
  const satelliteUrl = showYourWork?.overlaySatelliteUrl || intelligence.satelliteUrl;
  const showYourWorkFacts = Array.isArray(showYourWork?.facts) ? showYourWork.facts : [];

  return (
    <section style={{
      // Solid warm tan (matches the server-rendered estimate's .ai-card).
      // The previous gradient faded to #FFFFFF at the bottom, which erased
      // the contrast against the white metric/signal boxes inside the card.
      background: '#F2EEE0',
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
          <h2 style={{
            fontFamily: FONTS.serif,
            fontSize: 28,
            fontWeight: 500,
            lineHeight: 1.18,
            color: ESTIMATE_TEXT,
            margin: 0,
            letterSpacing: 0,
          }}>
            {intelligence.title || copy?.aiTitle || 'Waves AI reviewed your property before pricing this estimate'}
          </h2>
        </div>
        {/* Blue pill badge — mirrors the server-rendered estimate's
            .intelligence-badge (background #E3F5FD / color #065A8C / pill).
            Sits opposite the title in the flex header, exactly like the SSR. */}
        <span style={{
          flex: 'none',
          alignSelf: 'flex-start',
          padding: '6px 10px',
          borderRadius: 999,
          background: '#E3F5FD',
          color: '#065A8C',
          fontSize: 12,
          fontWeight: 800,
          lineHeight: 1,
          letterSpacing: 0,
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
        }}>
          {intelligence.eyebrow || copy?.aiEyebrow || 'Waves AI'}
        </span>
      </div>

      <p style={{
        margin: satelliteUrl || metrics.length ? '0 0 14px' : '0',
        color: '#3F4A65',
        fontSize: 14,
        lineHeight: 1.55,
      }}>
        {intelligence.body || copy?.aiBody || 'We reviewed the available property details and pricing rules before preparing this estimate.'}
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

      {showYourWork?.overlaySatelliteUrl ? (
        <div style={{ marginTop: 6, fontSize: 12, color: ESTIMATE_MUTED, lineHeight: 1.45 }}>
          Red outline: your property boundary from county records.
        </div>
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

      {/* "Show your work" trust block — mirrors the server-rendered
          .ai-show-work section (facts with friendly source labels, the
          county parcel match line, and the confirm-on-site quality note). */}
      {showYourWork ? (
        <div style={{
          display: 'grid',
          gap: 10,
          marginTop: 14,
          paddingTop: 14,
          borderTop: `1px solid ${ESTIMATE_BORDER}`,
        }}>
          <div style={{
            fontSize: 14,
            color: ESTIMATE_MUTED,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            fontWeight: 700,
          }}>
            Where these details came from
          </div>
          {showYourWorkFacts.length ? (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 8,
            }}>
              {showYourWorkFacts.map((fact) => (
                <div
                  key={`${fact.label}-${fact.value}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    background: COLORS.white,
                    border: `1px solid ${ESTIMATE_BORDER}`,
                    borderRadius: 10,
                    padding: '10px 12px',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      fontSize: 14,
                      color: ESTIMATE_MUTED,
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                      marginBottom: 4,
                    }}>
                      {fact.label}
                    </div>
                    <div style={{
                      fontFamily: FONTS.serif,
                      fontSize: 18,
                      fontWeight: 500,
                      color: ESTIMATE_TEXT,
                    }}>
                      {fact.value}
                    </div>
                  </div>
                  <span style={{
                    flex: 'none',
                    padding: '5px 9px',
                    borderRadius: 999,
                    background: '#E3F5FD',
                    color: '#065A8C',
                    fontSize: 14,
                    fontWeight: 800,
                    lineHeight: 1,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    whiteSpace: 'nowrap',
                  }}>
                    {fact.source}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {showYourWork.parcelLine ? (
            <p style={{ margin: 0, fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.5 }}>
              {showYourWork.parcelLine}
            </p>
          ) : null}
          {showYourWork.qualityNote ? (
            <p style={{ margin: 0, fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.5 }}>
              {showYourWork.qualityNote}
            </p>
          ) : null}
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

// Existing-customer WaveGuard membership benefits. Rendered only when the
// estimate is linked to an active customer (server returns estimate.membership).
// Display/transparency only — warm tone, matches the customer-facing brief.
function MembershipCard({ membership }) {
  if (!membership || !membership.isExistingCustomer) return null;
  const money = (n) => `$${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;
  const TIER_COLORS = {
    bronze: { bg: '#F3E7D8', fg: '#8A5A21' },
    silver: { bg: '#ECEEF1', fg: '#525B66' },
    gold: { bg: '#FBF1D6', fg: '#8A6A12' },
    platinum: { bg: '#EDEFF2', fg: '#2B3340' },
  };
  const tc = TIER_COLORS[membership.tier] || TIER_COLORS.bronze;
  // Mirrors renderMembershipBlockHtml in routes/estimate-public.js: Bronze
  // (0% tier discount) has no member benefits to show, so the card gates on
  // the snapshot's combined tier — the tier that priced this estimate.
  // Legacy snapshots without tierDiscountPct fall through to the row checks;
  // rows must carry a real non-zero benefit (margin guard can cap the
  // applied discount to 0 even at Silver+), and a card with no upgrade and
  // no rows left is skipped.
  if (membership.tierDiscountPct != null && !(Number(membership.tierDiscountPct) > 0)) return null;
  const existing = (Array.isArray(membership.existingServices) ? membership.existingServices : [])
    .filter((s) => Number(s.extraDiscountPct) > 0);
  const added = (Array.isArray(membership.newServices) ? membership.newServices : [])
    .filter((s) => Number(s.discountPct) > 0
      || Number(s.perApplicationSavings) > 0
      || Number(s.monthlySavings) > 0);
  if (!membership.upgrade && existing.length === 0 && added.length === 0) return null;
  const hello = membership.firstName ? `Welcome back, ${membership.firstName}` : 'Welcome back';

  const rowStyle = {
    display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12,
    background: COLORS.white, border: `1px solid ${ESTIMATE_BORDER}`, borderRadius: 10, padding: '10px 12px',
  };
  const sectionTitle = {
    fontSize: 14, color: ESTIMATE_MUTED, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700,
  };
  const labelStyle = { color: ESTIMATE_TEXT, fontWeight: 600, fontSize: 15 };
  const valStyle = { color: '#1F7A4D', fontSize: 14, fontWeight: 600, textAlign: 'right' };

  return (
    <section style={{
      background: '#F2EEE0', border: `1px solid ${ESTIMATE_BORDER}`, borderRadius: 12,
      padding: 24, marginBottom: 16, display: 'grid', gap: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontFamily: FONTS.serif, fontSize: 28, fontWeight: 500, lineHeight: 1.18, color: ESTIMATE_TEXT, margin: 0 }}>
            {hello}
          </h2>
          <p style={{ margin: '6px 0 0', color: '#3F4A65', fontSize: 14, lineHeight: 1.55 }}>
            Here&rsquo;s what your WaveGuard membership saves you on this estimate.
          </p>
        </div>
        <span style={{
          flex: 'none', alignSelf: 'flex-start', padding: '6px 12px', borderRadius: 999,
          background: tc.bg, color: tc.fg, fontSize: 14, fontWeight: 800, lineHeight: 1,
          letterSpacing: '0.04em', textTransform: 'uppercase', whiteSpace: 'nowrap',
          border: `1px solid ${ESTIMATE_BORDER}`,
        }}>
          WaveGuard {membership.tierLabel}
        </span>
      </div>

      {membership.upgrade ? (
        <div style={{
          background: COLORS.white, border: `1px solid ${ESTIMATE_BORDER}`,
          borderLeft: `4px solid ${COLORS.blueBright}`, borderRadius: 10, padding: '12px 14px',
          color: ESTIMATE_TEXT, fontSize: 15, lineHeight: 1.5,
        }}>
          Adding {membership.upgrade.addedServiceLabels.join(' & ') || 'this service'} bumps your membership from{' '}
          <strong>{membership.upgrade.fromLabel}</strong> up to <strong>{membership.upgrade.toLabel}</strong>
          {' '}— an extra {membership.upgrade.deltaPct}% off every qualifying service, including the ones you already have.
        </div>
      ) : null}

      {existing.length ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={sectionTitle}>Your existing services</div>
          {existing.map((s) => (
            <div key={s.key} style={rowStyle}>
              <span style={labelStyle}>{s.label}</span>
              <span style={valStyle}>
                +{s.extraDiscountPct}% off
                {Number(s.perVisitSavings) > 0 ? ` · save ${money(s.perVisitSavings)}/visit` : ''}
                {(Number(s.perVisitSavings) > 0 && s.remainingVisits > 0)
                  ? ` on your ${s.remainingVisits === 1 ? '' : `${s.remainingVisits} `}remaining${s.prepaid ? ' prepaid' : ''} ${s.remainingVisits === 1 ? 'visit' : 'visits'}`
                  : ''}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {added.length ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={sectionTitle}>This estimate</div>
          {added.map((s) => (
            <div key={s.key} style={rowStyle}>
              <span style={labelStyle}>{s.label}</span>
              <span style={valStyle}>
                {s.discountPct > 0 ? `${s.discountPct}% member discount` : 'Member pricing'}
                {Number(s.perApplicationSavings) > 0
                  ? ` · save ${money(s.perApplicationSavings)} per application`
                  : (Number(s.monthlySavings) > 0 ? ` · save ${money(s.monthlySavings)}/mo` : '')}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

// Customer portal showcase for recurring estimates. The recipient may not be
// a portal user yet, so this is a direct-explore invitation: it links to the
// portal and shows what they can do there. Warm customer-facing tone per the
// design brief; rendered for recurring plans only. Features listed here mirror
// real portal tabs (Visits, Billing, Request, on-location contacts, Refer,
// Documents) — keep them in sync with PortalPage so we never advertise a
// surface that does not exist.
const PORTAL_SHOWCASE_URL = 'https://portal.wavespestcontrol.com';

const PORTAL_SHOWCASE_FEATURES = [
  ['Upcoming visits', 'See every scheduled service and reschedule in a tap.'],
  ['Billing & autopay', 'View invoices, pay online, and turn on autopay.'],
  ['Request service', 'Ask for a re-service or add a service anytime.'],
  ['Loop in your family', 'Add a spouse, partner, or tenant to get appointment texts too.'],
  ['Refer & earn', 'Give $25, get $25 for every friend you send our way.'],
  ['Documents', 'Service reports, invoices, and agreements in one place.'],
];

function PortalShowcaseCard() {
  return (
    <section style={{
      background: COLORS.white, border: `1px solid ${ESTIMATE_BORDER}`, borderRadius: 12,
      padding: 24, marginBottom: 16, display: 'grid', gap: 16,
    }}>
      <div>
        <h2 style={{ fontFamily: FONTS.serif, fontSize: 28, fontWeight: 500, lineHeight: 1.18, color: ESTIMATE_TEXT, margin: 0 }}>
          Your customer portal
        </h2>
        <p style={{ margin: '6px 0 0', color: ESTIMATE_BODY, fontSize: 14, lineHeight: 1.55 }}>
          Manage your service from any device. Take a look around &mdash; here&rsquo;s what you can do inside.
        </p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        {PORTAL_SHOWCASE_FEATURES.map(([title, body]) => (
          <div key={title} style={{
            display: 'flex', gap: 10, alignItems: 'flex-start',
            background: '#F8FAFC', border: `1px solid ${ESTIMATE_BORDER}`, borderRadius: 10, padding: '12px 14px',
          }}>
            <span aria-hidden="true" style={{ color: COLORS.green, fontWeight: 800, fontSize: 15, lineHeight: 1.4 }}>&#10003;</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: ESTIMATE_TEXT, fontWeight: 700, fontSize: 15 }}>{title}</div>
              <div style={{ color: ESTIMATE_MUTED, fontSize: 13, lineHeight: 1.45, marginTop: 2 }}>{body}</div>
            </div>
          </div>
        ))}
      </div>
      <div>
        <a
          href={PORTAL_SHOWCASE_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-block', background: ESTIMATE_BUTTON_BG, color: COLORS.white,
            fontWeight: 700, fontSize: 15, padding: '12px 22px', borderRadius: 10, textDecoration: 'none',
          }}
        >
          Explore your portal
        </a>
      </div>
    </section>
  );
}

const ESTIMATE_ASK_PROMPTS = [
  'What is included?',
  'How does billing work?',
  'Why this price?',
  'Who is Waves?',
];

export function EstimateAskBar({ token, askToken, selectedFrequency, serviceMode = 'recurring', chips }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState(false);
  const prompts = Array.isArray(chips) && chips.length > 0
    ? chips.map((chip) => String(chip || '').trim()).filter(Boolean).slice(0, 6)
    : ESTIMATE_ASK_PROMPTS;

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
          Ask Waves
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
          Ask Waves
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
          aria-label="Ask Waves about this estimate"
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
        {prompts.map((prompt) => (
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

export function getServiceLabel(frequency, estimate, pricing) {
  if (estimate?.isOneTimeOnly) {
    const primary = pricing?.oneTimeBreakdown?.items?.find((item) => item?.kind !== 'discount');
    return primary?.label || 'One-time service';
  }
  const category = frequencyServiceCategory(frequency, pricing);
  const service = recurringServiceForEstimate(pricing);
  const serviceLabel = service?.label || serviceLabelForKey(category);
  if (estimate?.showOneTimeOption && (pricing?.anchorOneTimePrice || 0) > 0) {
    const recurringLabel = frequency?.label
      ? (labelAlreadyIncludesService(frequency.label, serviceLabel) ? frequency.label : `${frequency.label} ${serviceLabel}`)
      : serviceLabel;
    return `${recurringLabel} or One-Time ${serviceLabel}`;
  }
  if (frequency?.label) {
    return labelAlreadyIncludesService(frequency.label, serviceLabel)
      ? frequency.label
      : `${frequency.label} ${serviceLabel}`;
  }
  return 'Custom quote';
}

function isPreSlabBreakdownItem(item = {}) {
  const raw = [item.service, item.label, item.name, item.detail]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  return raw.includes('pre slab')
    && (raw.includes('termite') || raw.includes('termiticide') || raw.includes('soil treatment') || raw.includes('termidor'));
}

function isFleaBreakdownItem(item = {}) {
  const raw = [item.service, item.offerKey, item.label, item.name, item.detail]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  return raw.includes('flea');
}

function isGermanRoachCleanoutBreakdownItem(item = {}) {
  if (String(item.service || '').toLowerCase() === 'german_roach') return true;
  const raw = [item.label, item.name, item.displayName].filter(Boolean).join(' ').toLowerCase();
  return raw.includes('german roach') || (raw.includes('roach') && raw.includes('cleanout'));
}

function germanRoachVisitPhrase(visits) {
  const n = Number(visits) || 0;
  const words = { 1: 'One visit', 2: 'Two visits', 3: 'Three visits', 4: 'Four visits' };
  return words[n] || (n > 0 ? `${n} visits` : 'Multiple visits');
}

function oneTimePriceCopy(breakdown = {}) {
  const items = Array.isArray(breakdown?.items) ? breakdown.items : [];
  const germanRoachItem = items.find(isGermanRoachCleanoutBreakdownItem);
  if (germanRoachItem) {
    return `${germanRoachVisitPhrase(germanRoachItem.visits)} to break the breeding cycle. Pay on service day, no recurring schedule. 100% guaranteed with the Waves Guarantee.`;
  }
  const fleaItems = items.filter(isFleaBreakdownItem);
  if (fleaItems.length > 0) {
    const hasEliminationPackage = fleaItems.some((item) => item.offerKey === 'flea_elimination_two_visit' || Number(item.visits) === 2);
    if (hasEliminationPackage) {
      return 'Includes two interior treatments scheduled about 10-21 days apart. Retreat guarantee applies to treated areas when prep, pet-source, and follow-up requirements are met.';
    }
    return 'One interior flea treatment for active flea pressure. No retreat warranty included.';
  }
  const preSlabItems = items.filter(isPreSlabBreakdownItem);
  if (preSlabItems.length > 0) {
    const hasExtendedWarranty = preSlabItems.some((item) => {
      const raw = [item.warrantyStatus, item.detail].filter(Boolean).join(' ').toLowerCase();
      if (item.warrantyExtendedSelected === true) return true;
      if (raw.includes('no extended')) return false;
      return raw.includes('extended 5') || raw.includes('5-year') || raw.includes('5yr');
    });
    return 'Includes pre-slab soil treatment for the measured slab area. Certificate/termite-treatment documentation is provided when required. Warranty terms depend on the selected warranty option.'
      + (hasExtendedWarranty ? '' : ' No extended warranty selected.');
  }
  return 'One visit, pay on service day. No recurring schedule, no tier discount. Includes a 30-day callback period if pests return after this visit.';
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
      background: ESTIMATE_CHROME, borderRadius: 999, padding: 4,
      border: `1px solid ${ESTIMATE_BORDER}`, marginBottom: 18,
      display: 'flex', gap: 4,
      boxShadow: '0 1px 4px rgba(15,23,42,.04)',
    }}>
      <button
        type="button"
        onClick={() => onChange('recurring')}
        style={{
          ...pillBase,
          background: mode === 'recurring' ? ESTIMATE_BUTTON_BG : 'transparent',
          color: mode === 'recurring' ? COLORS.white : ESTIMATE_BODY,
        }}
      >Recurring Pest Control</button>
      <button
        type="button"
        onClick={() => onChange('one_time')}
        style={{
          ...pillBase,
          background: mode === 'one_time' ? ESTIMATE_BUTTON_BG : 'transparent',
          color: mode === 'one_time' ? COLORS.white : ESTIMATE_BODY,
        }}
      >One-Time Pest Control</button>
    </div>
  );
}

function EstimateAddServiceRequestCard({ offer, requestState, onRequest }) {
  if (!offer) return null;
  const status = requestState?.status || 'idle';
  const isSubmitting = status === 'submitting';
  const isReceived = status === 'received';
  const isError = status === 'error';
  return (
    <section style={{
      background: COLORS.white,
      border: `1px solid ${ESTIMATE_BORDER}`,
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
      boxShadow: '0 1px 6px rgba(15,23,42,0.04)',
    }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          background: '#ECFDF5',
          color: '#166534',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Icon name={offer.icon || 'plus'} size={19} strokeWidth={2.1} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: ESTIMATE_TEXT, lineHeight: 1.35 }}>
            {offer.title}
          </div>
          <div style={{ fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.5, marginTop: 4 }}>
            {offer.body}
          </div>
          <button
            type="button"
            onClick={onRequest}
            disabled={isSubmitting || isReceived}
            style={{
              marginTop: 12,
              width: '100%',
              minHeight: 44,
              border: 'none',
              borderRadius: 10,
              background: isReceived ? '#166534' : ESTIMATE_BUTTON_BG,
              color: COLORS.white,
              fontSize: 15,
              fontWeight: 800,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              cursor: isSubmitting || isReceived ? 'default' : 'pointer',
              opacity: isSubmitting ? 0.72 : 1,
            }}
          >
            <Icon name={isReceived ? 'check' : 'plus'} size={17} strokeWidth={2.4} />
            {isSubmitting ? 'Sending request...' : isReceived ? 'Request received' : `Add ${offer.label}`}
          </button>
          {isReceived ? (
            <div role="status" style={{
              marginTop: 10,
              background: '#ECFDF5',
              border: '1px solid #86EFAC',
              color: '#14532D',
              borderRadius: 10,
              padding: '10px 12px',
              fontSize: 14,
              lineHeight: 1.45,
            }}>
              <strong style={{ display: 'block', marginBottom: 2 }}>Request received.</strong>
              {requestState?.message || 'Got it. We are reviewing this service for your property and will follow up with a revised estimate shortly.'}
            </div>
          ) : null}
          {isError ? (
            <div role="alert" style={{
              marginTop: 10,
              background: '#FEF2F2',
              border: `1px solid ${COLORS.red}`,
              color: COLORS.red,
              borderRadius: 10,
              padding: '10px 12px',
              fontSize: 14,
              lineHeight: 1.45,
            }}>
              {requestState?.message || `Could not send the request. Call ${WAVES_PHONE_DISPLAY}.`}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function OneTimePriceCard({ oneTimePrice, breakdown }) {
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
        {oneTimePriceCopy(breakdown)}
      </div>
    </div>
  );
}

export function OneTimeBreakdownCard({ breakdown, excludeServices = [] }) {
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
      border: `1px solid ${ESTIMATE_BORDER}`, marginBottom: 16,
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
          const quoteNote = isQuoteRequired ? quoteRequiredReasonNote(item, item.detail || '') : '';
          return (
            <div key={`${item.service || item.label || 'item'}-${i}`} style={{
              display: 'grid', gridTemplateColumns: '1fr auto', gap: 12,
              alignItems: 'start', paddingBottom: i === items.length - 1 ? 0 : 10,
              borderBottom: i === items.length - 1 ? 'none' : `1px solid ${ESTIMATE_BORDER}`,
            }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.navy }}>
                  {item.label || 'One-time service'}
                </div>
                {item.detail ? (
                  <div style={{ fontSize: 12, color: ESTIMATE_MUTED, marginTop: 2, lineHeight: 1.35 }}>
                    {item.detail}
                  </div>
                ) : null}
                {quoteNote ? (
                  <div style={{ fontSize: 12, color: '#92400E', marginTop: 4, lineHeight: 1.35, fontWeight: 700 }}>
                    {quoteNote}
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
        borderTop: `1px solid ${ESTIMATE_BORDER}`, marginTop: 12, paddingTop: 12,
        fontSize: 15, fontWeight: 700, color: COLORS.navy,
      }}>
        <span>{totalIsQuoteRequired ? 'Quote status' : 'One-time total'}</span>
        <span style={totalIsQuoteRequired ? { color: COLORS.red } : null}>
          {totalIsQuoteRequired ? 'Quote Required' : fmtMoney(total)}
        </span>
      </div>
      {totalIsQuoteRequired ? (
        <div style={{ fontSize: 14, color: ESTIMATE_MUTED, marginTop: 8, lineHeight: 1.45 }}>
          Waves will confirm final pricing before this can be accepted online.
        </div>
      ) : null}
    </div>
  );
}

function manualDiscountMonthlyAmount(manualDiscount) {
  if (!manualDiscount) return 0;
  const monthly = Number(manualDiscount.monthlyAmount);
  if (Number.isFinite(monthly) && monthly > 0) return Math.round(monthly * 100) / 100;
  const amount = Number(manualDiscount.amount);
  return Number.isFinite(amount) && amount > 0 ? Math.round((amount / 12) * 100) / 100 : 0;
}

function CombinedRecurringPriceCard({ combined, selectedFrequency, waveGuardTier }) {
  if (!combined) return null;
  const quoteRequired = selectedFrequency?.quoteRequired === true;
  const quoteReason = quoteRequired ? quoteRequiredReasonText(selectedFrequency || combined) : '';
  const monthly = quoteRequired ? null : (selectedFrequency?.monthly ?? combined.monthlySubtotal);
  const annual = quoteRequired ? null : (selectedFrequency?.annual ?? combined.annualSubtotal);
  const manualDiscount = combined.manualDiscount && Number(combined.manualDiscount.amount) > 0
    ? combined.manualDiscount
    : null;
  const manualDiscountMonthly = manualDiscountMonthlyAmount(manualDiscount);
  return (
    <section style={{
      background: COLORS.white,
      border: `1px solid ${ESTIMATE_BORDER}`,
      borderRadius: 16,
      padding: 24,
      margin: '4px 0 16px',
      boxShadow: '0 8px 24px rgba(15,23,42,.06)',
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 18,
        alignItems: 'flex-start',
        flexWrap: 'wrap',
      }}>
        <div>
          <div style={{
            fontSize: 14,
            fontWeight: 700,
            color: ESTIMATE_MUTED,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            marginBottom: 6,
          }}>
            Recurring total
          </div>
          <div style={{ fontSize: 15, color: ESTIMATE_MUTED, lineHeight: 1.5 }}>
            Combined recurring services before any one-time items.
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{
            fontFamily: FONTS.serif,
            fontSize: quoteRequired ? 34 : 46,
            lineHeight: 1,
            color: ESTIMATE_TEXT,
            fontWeight: 500,
          }}>
            {quoteRequired ? 'Quote required' : fmtMoney(monthly)}
            {!quoteRequired ? <span style={{ fontFamily: FONT_BODY, fontSize: 20, color: ESTIMATE_MUTED }}> /mo</span> : null}
          </div>
          {!quoteRequired && annual ? (
            <div style={{ fontSize: 14, color: ESTIMATE_MUTED, marginTop: 8 }}>
              {fmtMoney(annual)} / year
            </div>
          ) : null}
          {quoteRequired && quoteReason ? (
            <div style={{ fontSize: 14, color: '#92400E', marginTop: 10, lineHeight: 1.4, fontWeight: 700, maxWidth: 320 }}>
              {quoteReason}
            </div>
          ) : null}
          {waveGuardTier ? (
            <div style={{
              display: 'inline-block',
              marginTop: 10,
              padding: '5px 11px',
              background: '#EEF2FF',
              color: ESTIMATE_TEXT,
              borderRadius: 6,
              fontSize: 14,
              fontWeight: 700,
            }}>
              WaveGuard {waveGuardTier}
            </div>
          ) : null}
        </div>
      </div>
      {!quoteRequired && manualDiscount && manualDiscountMonthly > 0 ? (
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 12,
          alignItems: 'center',
          marginTop: 16,
          padding: '10px 12px',
          border: '1px solid #DCFCE7',
          borderRadius: 10,
          background: '#F0FDF4',
          color: COLORS.green,
          fontSize: 14,
          fontWeight: 800,
          lineHeight: 1.35,
        }}>
          <span>{manualDiscount.label || 'Discount'}</span>
          <strong style={{ whiteSpace: 'nowrap' }}>-{fmtMoney(manualDiscountMonthly)} /mo</strong>
        </div>
      ) : null}
    </section>
  );
}

function CountdownLine({ secondsRemaining }) {
  const m = Math.max(0, Math.floor(secondsRemaining / 60));
  const s = Math.max(0, secondsRemaining % 60);
  return (
    <div style={{ fontSize: 14, color: ESTIMATE_MUTED, textAlign: 'center' }}>
      Slot held for {m}:{String(s).padStart(2, '0')}
    </div>
  );
}

function formatAppointmentLabel(appointment = {}) {
  const date = appointment.scheduledDate
    ? new Date(`${appointment.scheduledDate}T12:00:00Z`).toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      timeZone: 'America/New_York',
    })
    : '';
  const time = appointment.windowDisplay || appointment.windowStart || '';
  return [date, time].filter(Boolean).join(' · ') || 'Your scheduled appointment';
}

function ExistingAppointmentCard({ appointment }) {
  return (
    <div style={{
      background: COLORS.white,
      borderRadius: 16,
      padding: 24,
      border: `1px solid ${ESTIMATE_BORDER}`,
      marginBottom: 16,
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: ESTIMATE_MUTED, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        Existing appointment
      </div>
      <div style={{ fontSize: 20, fontWeight: 800, color: ESTIMATE_TEXT, marginTop: 8, lineHeight: 1.3 }}>
        {formatAppointmentLabel(appointment)}
      </div>
      <div style={{ fontSize: 15, color: ESTIMATE_BODY, marginTop: 4, lineHeight: 1.45 }}>
        {appointment?.serviceType || 'Service visit'}
      </div>
      <div style={{ fontSize: 14, color: ESTIMATE_BODY, marginTop: 12, lineHeight: 1.55 }}>
        Your visit is already on the schedule. Choose how you want to pay to approve this estimate.
      </div>
    </div>
  );
}

// Acceptance-deposit Payment Element modal (flat $49/$99, PR #1660).
// `intent` is the POST /deposit-intent response: clientSecret, amount,
// requiredAmount, receivedTotal, paymentIntentId, publishableKey. The PI is
// card-only server-side, so the Payment Element renders card fields only.
function DepositModal({ intent, onSuccess, onCancel }) {
  const mountRef = useRef(null);
  const stripeRef = useRef(null);
  const elementsRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    loadStripeSdk().then((StripeCtor) => {
      if (cancelled || !mountRef.current) return;
      const stripe = StripeCtor(intent.publishableKey);
      const elements = stripe.elements({
        clientSecret: intent.clientSecret,
        appearance: { theme: 'stripe', variables: { borderRadius: '8px', fontFamily: FONTS.body } },
      });
      const paymentElement = elements.create('payment');
      paymentElement.mount(mountRef.current);
      paymentElement.on('ready', () => { if (!cancelled) setReady(true); });
      stripeRef.current = stripe;
      elementsRef.current = elements;
    }).catch(() => {
      if (!cancelled) setError('Could not load the secure payment form. Check your connection and try again.');
    });
    return () => { cancelled = true; };
  }, [intent]);

  // Accept-gate contract: ensureDepositSatisfied live-verifies the PI and
  // only honors status === 'succeeded' — a processing PI would 402 at
  // accept. So only succeeded advances; processing shows a pending message,
  // and re-taps re-check the PI status instead of re-confirming an
  // in-flight intent.
  const PROCESSING_MSG = 'Your payment is processing — give it a few seconds, then tap Pay again. You will not be charged twice.';
  const handlePay = useCallback(async () => {
    if (!stripeRef.current || !elementsRef.current) return;
    setSubmitting(true);
    setError(null);
    try {
      const existing = await stripeRef.current.retrievePaymentIntent(intent.clientSecret);
      if (existing?.paymentIntent?.status === 'succeeded') {
        onSuccess(existing.paymentIntent.id);
        return;
      }
      if (existing?.paymentIntent?.status === 'processing') {
        setError(PROCESSING_MSG);
        setSubmitting(false);
        return;
      }
      const result = await stripeRef.current.confirmPayment({
        elements: elementsRef.current,
        confirmParams: { return_url: window.location.href },
        redirect: 'if_required',
      });
      if (result.error) {
        setError(result.error.message || 'Payment did not go through. Try another card.');
        setSubmitting(false);
        return;
      }
      const pi = result.paymentIntent;
      if (pi && pi.status === 'succeeded') {
        onSuccess(pi.id);
        return;
      }
      setError(pi && pi.status === 'processing' ? PROCESSING_MSG : 'Payment is still pending. Try again in a moment.');
      setSubmitting(false);
    } catch {
      setError('Payment did not go through. Try again.');
      setSubmitting(false);
    }
  }, [intent, onSuccess]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(27,44,91,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
      <div style={{ background: COLORS.white, borderRadius: 16, maxWidth: 440, width: '100%', padding: 24, boxShadow: '0 18px 50px rgba(0,0,0,0.25)', maxHeight: '90vh', overflow: 'auto' }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: COLORS.navy }}>Reserve your appointment</div>
        <div style={{ fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.5, margin: '6px 0 14px' }}>
          A {fmtMoney(intent.amount)} deposit holds your spot. It is applied to your first invoice.
          {Number(intent.receivedTotal) > 0 ? ` (${fmtMoney(intent.receivedTotal)} already received.)` : ''}
        </div>
        <div ref={mountRef} />
        {error ? (
          <div role="alert" style={{ color: '#C8312F', fontSize: 14, lineHeight: 1.45, marginTop: 10 }}>{error}</div>
        ) : null}
        <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
          <button
            type="button"
            onClick={handlePay}
            disabled={!ready || submitting}
            style={{
              padding: '16px 20px', background: ESTIMATE_BUTTON_BG, color: COLORS.white,
              border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 600, cursor: 'pointer',
              opacity: !ready || submitting ? 0.6 : 1,
            }}
          >{submitting ? 'Processing…' : `Pay ${fmtMoney(intent.amount)} deposit`}</button>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            style={{
              padding: '12px 20px', background: 'transparent', color: ESTIMATE_BODY,
              border: `1px solid ${ESTIMATE_BORDER}`, borderRadius: 12, fontSize: 14, fontWeight: 500, cursor: 'pointer',
            }}
          >Not now</button>
        </div>
      </div>
    </div>
  );
}

function ReviewPhase({ slotId, existingAppointment, paymentPreference, secondsRemaining, onConfirm, onCancel, invoiceMode, serviceMode, depositNote }) {
  const usingExistingAppointment = !!existingAppointment;
  const recurringPayPerApplication = serviceMode !== 'one_time' && paymentPreference === 'pay_at_visit';
  const paymentLabel = invoiceMode
    ? 'Invoice due now'
    : recurringPayPerApplication
      ? 'Pay per application'
      : paymentPreference === 'prepay_annual'
        ? 'Pay the 12-month plan in full'
        : 'Pay at the visit';
  const confirmLabel = usingExistingAppointment
    ? recurringPayPerApplication
      ? 'Confirm invoice'
      : paymentPreference === 'prepay_annual'
        ? 'Confirm annual prepay'
        : 'Confirm appointment'
    : 'Confirm booking';
  const confirmSub = usingExistingAppointment
    ? recurringPayPerApplication
      ? 'Your existing appointment stays scheduled. Next step creates your invoice and makes secure payment available.'
      : paymentPreference === 'prepay_annual'
        ? 'Your existing appointment stays scheduled. Annual prepay invoice is available for optional payment after confirmation.'
        : 'Your existing appointment stays scheduled. We will collect payment with the tech on-site.'
    : '';
  return (
    <div style={{
      background: COLORS.white, borderRadius: 16, padding: 24,
      borderTop: `4px solid ${ESTIMATE_BUTTON_BG}`, boxShadow: '0 2px 12px rgba(15,23,42,0.06)',
      marginBottom: 16,
    }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: ESTIMATE_BUTTON_BG, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {usingExistingAppointment ? 'Confirm invoice option' : 'Confirm your booking'}
      </div>
      <div style={{ fontSize: 18, color: COLORS.navy, marginTop: 10, lineHeight: 1.5 }}>
        {usingExistingAppointment ? 'Selected invoice option: ' : 'Pay option: '}
        <strong>{paymentLabel}</strong>{usingExistingAppointment ? '.' : null}
      </div>
      <div style={{ fontSize: 14, color: ESTIMATE_BODY, marginTop: 4 }}>
        {usingExistingAppointment
          ? `Appointment: ${formatAppointmentLabel(existingAppointment)}`
          : `Slot: ${slotId}`}
      </div>
      {!usingExistingAppointment ? <div style={{ marginTop: 16 }}><CountdownLine secondsRemaining={secondsRemaining} /></div> : null}
      <div style={{ display: 'grid', gap: 10, marginTop: 16 }}>
        <button
          type="button"
          onClick={onConfirm}
          style={{
            padding: '16px 20px', background: ESTIMATE_BUTTON_BG, color: COLORS.white,
            border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 600, cursor: 'pointer',
          }}
        >{confirmLabel}</button>
        {confirmSub ? (
          <div style={{ fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.45, textAlign: 'center' }}>
            {confirmSub}
          </div>
        ) : null}
        {depositNote ? (
          <div style={{ fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.45, textAlign: 'center' }}>
            {depositNote}
          </div>
        ) : null}
        {!usingExistingAppointment ? (
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: '12px 20px', background: 'transparent', color: ESTIMATE_BODY,
              border: `1px solid ${ESTIMATE_BORDER}`, borderRadius: 12, fontSize: 14, fontWeight: 500, cursor: 'pointer',
            }}
          >Go back</button>
        ) : null}
      </div>
    </div>
  );
}

function SuccessCard({ acceptResult }) {
  const nextStep = acceptResult?.nextStep || (acceptResult?.invoiceMode ? 'pay_invoice' : 'confirmed');
  const bookingUrl = acceptResult?.bookingUrl || null;
  const invoicePayUrl = acceptResult?.invoicePayUrl || null;
  const invoiceLinkDelivered = !!acceptResult?.invoiceLinkDelivered;
  const reservationCommitted = acceptResult?.reservationCommitted === true;
  const isAnnualPrepay = acceptResult?.billingTerm === 'prepay_annual';
  const isOneTimeInvoice = acceptResult?.serviceMode === 'one_time';
  const prepayInvoiceAmount = Number(acceptResult?.prepayInvoiceAmount);
  const prepayAmountText = Number.isFinite(prepayInvoiceAmount) && prepayInvoiceAmount > 0
    ? ` for ${fmtMoney(prepayInvoiceAmount)}`
    : '';

  if (nextStep === 'pay_invoice') {
    const title = reservationCommitted
      ? 'Your appointment is booked.'
      : (invoiceLinkDelivered ? 'Thanks — your invoice is on the way.' : 'Thanks — your estimate is approved.');
    const invoiceLabel = isAnnualPrepay
      ? 'annual prepay invoice'
      : (isOneTimeInvoice ? 'one-time service invoice' : 'setup + first application invoice');
    const payNowLabel = isOneTimeInvoice ? 'Pay invoice' : 'Pay now and save card';
    const serviceProgressLabel = reservationCommitted ? 'Your appointment' : 'Your service request';
    const deferredPaymentCopy = invoicePayUrl || invoiceLinkDelivered
      ? `${serviceProgressLabel} is not held up by payment, and you can use the invoice link later.`
      : `${serviceProgressLabel} is not held up by payment.`;
    return (
      <div style={{
        background: COLORS.white, borderRadius: 16, padding: 28, textAlign: 'center',
        borderTop: `4px solid ${COLORS.green}`, boxShadow: '0 2px 12px rgba(15,23,42,0.06)',
        marginBottom: 16,
      }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.navy, marginTop: 8 }}>
          {title}
        </div>
        <div style={{ fontSize: 16, color: ESTIMATE_BODY, marginTop: 10, lineHeight: 1.55 }}>
          {invoicePayUrl
            ? (isOneTimeInvoice
                ? `Payment is optional right now. Your ${invoiceLabel} is ready if you want to pay online.`
                : `Payment is optional right now. Your ${invoiceLabel} is ready if you want to pay now and save a card for future Waves payments.`)
            : invoiceLinkDelivered
              ? `Use the ${invoiceLabel} link we sent whenever you are ready. Payment is optional right now.`
              : `Our team will follow up with the ${invoiceLabel} details. Payment is optional right now.`}
        </div>
        {invoicePayUrl ? (
          <a
            href={invoicePayUrl}
            style={{
              display: 'inline-block', marginTop: 16, padding: '14px 20px',
              background: ESTIMATE_BUTTON_BG, color: COLORS.white, textDecoration: 'none',
              borderRadius: 12, fontWeight: 600, fontSize: 15,
            }}
          >{payNowLabel}</a>
        ) : null}
        <div style={{ fontSize: 14, color: ESTIMATE_MUTED, marginTop: 12, lineHeight: 1.45 }}>
          {deferredPaymentCopy}
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
        <div style={{ fontSize: 16, color: ESTIMATE_BODY, marginTop: 10, lineHeight: 1.55 }}>
          Your annual prepay{prepayAmountText} is approved. Our team will follow up with the invoice details and confirm the schedule.
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
        <div style={{ fontSize: 16, color: ESTIMATE_BODY, marginTop: 10, lineHeight: 1.55 }}>
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
      <div style={{ fontSize: 16, color: ESTIMATE_BODY, marginTop: 10, lineHeight: 1.55 }}>
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

function AcceptanceModeCard({ acceptance }) {
  if (!acceptance || acceptance.mode === 'standard_slot_pick' || acceptance.mode === 'existing_appointment') return null;
  const title = acceptance.mode === 'quote_required'
    ? 'This treatment needs a custom quote.'
    : 'Waves will help schedule this estimate.';
  const body = acceptance.mode === 'inspection_request'
    ? 'This plan needs an inspection before a normal service slot can be reserved online.'
    : 'Call Waves and we will finish the next step with you.';
  return (
    <div style={{
      background: COLORS.white,
      borderRadius: 16,
      padding: 24,
      border: `1px solid ${ESTIMATE_BORDER}`,
      marginBottom: 16,
    }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: ESTIMATE_TEXT, marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 15, color: ESTIMATE_BODY, lineHeight: 1.55 }}>{body}</div>
      <a href={`tel:${WAVES_PHONE_TEL}`} style={{
        display: 'inline-block',
        marginTop: 14,
        padding: '12px 18px',
        background: ESTIMATE_BUTTON_BG,
        color: COLORS.white,
        borderRadius: 10,
        textDecoration: 'none',
        fontSize: 14,
        fontWeight: 700,
      }}>
        {acceptance.ctaLabel || 'Call Waves'}
      </a>
    </div>
  );
}

export function ServiceSection({
  section,
  servicesLength = 1,
  selectedFrequencyKey,
  selectedAddOns = new Set(),
  onFrequencyChange,
  onAddOnToggle,
  disabled = false,
  renderFlags = {},
  waveGuardTier,
  afterPrice = null,
}) {
  if (!section) return null;
  const frequencies = Array.isArray(section.frequencies) ? section.frequencies : [];
  const current = frequencies.find((frequency) => frequency.key === selectedFrequencyKey) || frequencies[0] || null;
  const copy = section.copy || {};
  const showSlider = frequencies.length > 1;
  const showAddOns = section.isPest
    && section.isRecurring
    && renderFlags.showPestRecurringAddOns === true
    && Array.isArray(current?.addOns)
    && current.addOns.length > 0;

  return (
    <section>
      {servicesLength > 1 ? (
        <h3 style={{
          fontSize: 18,
          color: ESTIMATE_TEXT,
          margin: '20px 0 12px',
          fontWeight: 800,
        }}>
          {section.label || 'Service'}
        </h3>
      ) : null}

      {showSlider ? (
        <FrequencySlider
          frequencies={frequencies}
          selected={selectedFrequencyKey}
          onChange={(next) => onFrequencyChange(section.key, next)}
          disabled={disabled}
        />
      ) : null}

      {current ? (
        <PriceCard
          frequency={current}
          waveGuardTier={section?.waveGuardTierEligible !== false ? waveGuardTier : null}
          wording={copy.priceWording}
        />
      ) : null}

      {afterPrice}

      <IncludedChecklist included={current?.included || []} />

      {showAddOns ? (
        <AddOnsBlock
          addOns={current?.addOns || []}
          selectedKeys={selectedAddOns}
          onToggle={(key) => onAddOnToggle(section.key, key)}
        />
      ) : null}
    </section>
  );
}

export default function EstimateViewPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [selected, setSelected] = useState({});
  const [selectedAddOns, setSelectedAddOns] = useState({});
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
  // Acceptance deposit (flat $49/$99). depositIntent holds the live
  // POST /deposit-intent response while the Payment Element modal is open;
  // the ref carries the paid PI id into accept (server live-verifies it —
  // the id is flow plumbing, not trust).
  const [depositIntent, setDepositIntent] = useState(null);
  const depositPaymentIntentIdRef = useRef(null);
  const [slotsRefreshSignal, setSlotsRefreshSignal] = useState(0);
  const [addServiceRequestState, setAddServiceRequestState] = useState({ status: 'idle', message: '' });

  const [countdownSeconds, setCountdownSeconds] = useState(0);
  const countdownRef = useRef(null);
  const selectedRef = useRef({});
  const selectedFrequencyRef = useRef(null);
  const reserveAttemptRef = useRef(0);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  // 3DS redirect return: Stripe sends the customer back with
  // ?payment_intent=...&redirect_status=succeeded after a challenge.
  // Carry the paid PI forward and scrub the params from the URL.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const piFromRedirect = params.get('payment_intent');
      if (piFromRedirect && params.get('redirect_status') === 'succeeded') {
        depositPaymentIntentIdRef.current = piFromRedirect;
      }
      if (piFromRedirect) {
        ['payment_intent', 'payment_intent_client_secret', 'redirect_status'].forEach((k) => params.delete(k));
        const qs = params.toString();
        window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
      }
    } catch { /* non-fatal */ }
  }, []);

  const services = useMemo(() => pricingServices(data?.pricing), [data]);
  const acceptance = data?.estimate?.acceptance || { mode: 'standard_slot_pick' };
  const existingAppointment = acceptance.mode === 'existing_appointment' ? acceptance.appointment : null;
  const selectedFrequency = useMemo(() => selectedPricingFrequencyKey(data?.pricing, services, selected), [data?.pricing, services, selected]);
  const currentFrequency = useMemo(() => {
    const pestSection = services.find((section) => section.key === 'pest_control');
    const primarySection = pestSection || services.find((section) => section.isRecurring) || services[0];
    return selectedFrequencyForSection(primarySection, selected);
  }, [services, selected]);
  const addServiceOffer = useMemo(
    () => estimateAddServiceOffer(services, serviceMode, data?.estimate?.membership),
    [services, serviceMode, data?.estimate?.membership]
  );

  useEffect(() => {
    selectedFrequencyRef.current = selectedFrequency;
  }, [selectedFrequency]);

  useEffect(() => {
    setAddServiceRequestState({ status: 'idle', message: '' });
  }, [token, addServiceOffer?.serviceKey]);

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
    const nextServices = pricingServices(body?.pricing);
    const nextSelected = defaultSelectedForServices(nextServices, selectedRef.current, preserveSelection);
    setSelected(nextSelected);
    setSelectedAddOns(selectedAddOnsForServices(nextServices, nextSelected));
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

  const onToggleAddOn = useCallback(async (sectionKey, key) => {
    const sectionAddOns = selectedAddOns[sectionKey] || new Set();
    const nextChecked = !sectionAddOns.has(key);
    setSelectedAddOns((prev) => {
      const current = prev[sectionKey] || new Set();
      const nextForSection = new Set(current);
      if (nextForSection.has(key)) nextForSection.delete(key); else nextForSection.add(key);
      return { ...prev, [sectionKey]: nextForSection };
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
        const current = prev[sectionKey] || new Set();
        const nextForSection = new Set(current);
        if (nextChecked) nextForSection.delete(key); else nextForSection.add(key);
        return { ...prev, [sectionKey]: nextForSection };
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
    if (existingAppointment) {
      setPaymentPreference(pref);
      setReservation({ existingAppointmentId: existingAppointment.id });
      setCtaPhase('review');
      setError(null);
      return;
    }
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
  }, [existingAppointment, loadEstimate, releaseHeldReservation, selectedSlotId, serviceMode, selectedFrequency, token]);

  const handleFrequencyChange = useCallback((sectionKey, nextFrequency) => {
    reserveAttemptRef.current += 1;
    const affectedSections = services.filter((section) => (
      section.key === sectionKey
      || section.frequencies?.some((item) => item.key === nextFrequency)
    ));
    setSelected((prev) => affectedSections.reduce((next, section) => ({
      ...next,
      [section.key]: nextFrequency,
    }), { ...prev }));
    setSelectedAddOns((prev) => ({
      ...prev,
      ...affectedSections.reduce((next, section) => {
        const frequency = section.frequencies?.find((item) => item.key === nextFrequency);
        next[section.key] = new Set((frequency?.addOns || []).filter((addOn) => addOn.preChecked).map((addOn) => addOn.key));
        return next;
      }, {}),
    }));
    setSelectedSlotId(null);
    setPaymentPreference(null);
    setReservation(null);
    setAcceptResult(null);
    setError(null);
    setCtaPhase('configure');
    setSlotsRefreshSignal((v) => v + 1);
  }, [services]);

  const performAccept = useCallback(async () => {
    setCtaPhase('submitting');
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/estimates/${token}/accept`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slotId: existingAppointment ? undefined : selectedSlotId,
          existingAppointmentId: existingAppointment?.id,
          paymentMethodPreference: paymentPreference,
          serviceMode,
          selectedFrequency,
          depositPaymentIntentId: depositPaymentIntentIdRef.current || undefined,
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        if (r.status === 402 && body.code === 'DEPOSIT_REQUIRED') {
          // Ledger disagrees with what we collected (refund or partial under
          // us) — drop the cached PI; the next confirm mints a fresh top-up.
          depositPaymentIntentIdRef.current = null;
          throw new Error(body.error || 'A deposit is required to confirm your booking.');
        }
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
  }, [existingAppointment, loadEstimate, token, selectedSlotId, paymentPreference, serviceMode, selectedFrequency]);

  // Deposit-gated confirm (flat $49/$99, PR #1660). When the resolved policy
  // requires a deposit and none is collected yet, mint the intent and open
  // the Payment Element modal; accept continues from the modal's onSuccess.
  // Dark-safe: depositPolicy.required is false while ESTIMATE_DEPOSIT_REQUIRED
  // is off, so this falls straight through to performAccept.
  const handleConfirm = useCallback(async () => {
    const depositPolicy = data?.depositPolicy;
    if (depositPolicy?.required && paymentPreference !== 'prepay_annual' && !depositPaymentIntentIdRef.current) {
      setCtaPhase('submitting');
      setError(null);
      try {
        const r = await fetch(`${API_BASE}/public/estimates/${token}/deposit-intent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serviceMode, paymentMethodPreference: paymentPreference }),
        });
        const body = await r.json().catch(() => ({}));
        if (r.status === 409 && body.exemptReason) {
          // Policy says nothing owed — fall through to accept.
        } else if (!r.ok) {
          throw new Error(body.error || 'Could not start the deposit. Please try again.');
        } else if (!body.alreadySatisfied) {
          setDepositIntent(body);
          setCtaPhase('review');
          return; // modal takes over; accept continues from onSuccess
        }
      } catch (err) {
        setError(err.message);
        setCtaPhase('review');
        return;
      }
    }
    await performAccept();
  }, [data, paymentPreference, serviceMode, token, performAccept]);

  const handleDepositSuccess = useCallback(async (paymentIntentId) => {
    depositPaymentIntentIdRef.current = paymentIntentId;
    setDepositIntent(null);
    await performAccept();
  }, [performAccept]);

  const handleDepositCancel = useCallback(() => setDepositIntent(null), []);

  const handleReviewCancel = useCallback(() => {
    setCtaPhase('configure');
    setReservation(null);
    setPaymentPreference(null);
    // Don't clear selectedSlotId — the customer may want to retry with
    // the same slot if the reservation call succeeded. Reservation row
    // still exists server-side for up to 15 min; the commit-on-accept
    // is idempotent.
  }, []);

  const handleAddServiceRequest = useCallback(async () => {
    if (!addServiceOffer || addServiceRequestState.status === 'submitting') return;
    setAddServiceRequestState({ status: 'submitting', message: '' });
    try {
      const r = await fetch(`${API_BASE}/estimates/${token}/bundle-inquiry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestedService: addServiceOffer.serviceKey,
          suggestedService: addServiceOffer.label,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `request failed: ${r.status}`);
      setAddServiceRequestState({
        status: 'received',
        message: body?.confirmation?.message || `Got it. We're reviewing ${addServiceOffer.label.toLowerCase()} for your property and will follow up shortly.`,
      });
    } catch (err) {
      setAddServiceRequestState({
        status: 'error',
        message: err.message || `Could not send the request. Call ${WAVES_PHONE_DISPLAY}.`,
      });
    }
  }, [addServiceOffer, addServiceRequestState.status, token]);

  if (loading) {
    return <Page><Header customerFirstName={null} address={null} /><SkeletonBlock /><SkeletonBlock /></Page>;
  }
  if (notFound || !data) {
    return <Page><NotFoundCard /></Page>;
  }

  const { estimate, pricing, cta } = data;
  const canAccept = cta?.canAccept === true;
  const showAskBar = !['accepted', 'declined', 'expired'].includes(cta?.terminalState);
  const serviceCategory = estimate?.serviceCategory || (services.length > 1 ? 'bundle' : services[0]?.key) || 'pest_control';
  const copy = estimateCopyFor(serviceCategory);
  const renderFlags = pricing?.renderFlags || {};
  const canShowSlotPicker = acceptance.mode === 'standard_slot_pick';
  // Resolve the tier label unconditionally; whether the badge actually renders
  // is decided by per-section eligibility (server-authoritative
  // section.waveGuardTierEligible — true iff the section covers >=1 WaveGuard
  // service), so an excluded section (palm/rodent) never shows it even alongside
  // an eligible service, and an eligible single service / bundle always can.
  const waveGuardTier = pricing.combinedRecurring?.waveGuardTierLabel || pricing.waveGuardTier || null;
  // The combined bundle summary card represents the whole recurring plan: show
  // the tier only if any section in it is eligible (so an excluded-only bundle
  // — e.g. palm + rodent — stays badge-free here too).
  const combinedTierEligible = services.some((s) => s?.waveGuardTierEligible === true);
  const combinedFrequency = selectedCombinedFrequency(pricing, selectedFrequency);
  const quoteRequiredReason = cta?.quoteRequiredReason || pricing?.quoteRequiredReason || pricing?.quoteRequiredItems?.[0]?.reason || '';

  if (!canAccept) {
    return (
      <Page>
        <Header customerFirstName={estimate.customerFirstName} address={estimate.address} headline={copy.headline} />
        <MembershipCard membership={estimate.membership} />
        <WaveGuardIntelligenceCard intelligence={estimate.intelligence} address={estimate.address} copy={copy} showYourWork={data.showYourWork || null} />
        {showAskBar ? (
          <EstimateAskBar
            token={token}
            askToken={estimate.askToken}
            selectedFrequency={selectedFrequency}
            serviceMode={serviceMode}
            chips={pricing.askChips}
          />
        ) : null}
        <TerminalStateCard
          state={cta.terminalState}
          customerFirstName={estimate.customerFirstName}
          address={estimate.address}
          quoteReason={quoteRequiredReason}
        />
        <GuaranteeStrip licenseNumber={estimate.licenseNumber} />
      </Page>
    );
  }

  if (ctaPhase === 'success') {
    return (
      <Page>
        <Header customerFirstName={estimate.customerFirstName} address={estimate.address} headline={copy.headline} />
        <SuccessCard acceptResult={acceptResult} />
        <GuaranteeStrip licenseNumber={estimate.licenseNumber} />
      </Page>
    );
  }

  // Waves AI property-review panel + "Ask Waves" bar. Rendered AFTER the price
  // (configure branch) and also after the confirmation card (review branch) so
  // the price-before-AI ordering holds while the panel + ask stay available
  // during the held-slot review step too.
  const aiPanelBlock = (
    <>
      <MembershipCard membership={estimate.membership} />
      <WaveGuardIntelligenceCard intelligence={estimate.intelligence} address={estimate.address} copy={copy} showYourWork={data.showYourWork || null} />
      <EstimateAskBar
        token={token}
        askToken={estimate.askToken}
        selectedFrequency={selectedFrequency}
        serviceMode={serviceMode}
        chips={pricing.askChips}
      />
      <EstimateAddServiceRequestCard
        offer={addServiceOffer}
        requestState={addServiceRequestState}
        onRequest={handleAddServiceRequest}
      />
    </>
  );

  return (
    <Page>
      <Header
        customerFirstName={estimate.customerFirstName}
        address={estimate.address}
        serviceLabel={getServiceLabel(currentFrequency, estimate, pricing)}
        canChooseOneTime={estimate.showOneTimeOption && (pricing.anchorOneTimePrice || 0) > 0}
        headline={copy.headline}
      />

      {ctaPhase === 'slot_conflict' || ctaPhase === 'reservation_expired' ? (
        <SlotIssueBanner
          kind={ctaPhase === 'reservation_expired' ? 'expired' : 'conflict'}
          onRetry={() => setSlotsRefreshSignal((v) => v + 1)}
        />
      ) : null}

      {ctaPhase === 'review' && reservation ? (
        <>
          {existingAppointment ? (
            <>
              <ExistingAppointmentCard appointment={existingAppointment} />
              <PaymentPreferenceButtons
                onSelect={handlePaymentChoice}
                disabled={false}
                serviceMode={serviceMode}
                setupFee={pricing.setupFee || null}
                annualPrepayEligible={pricing.annualPrepayEligible === true}
                invoiceMode={!!estimate.billByInvoice}
                selectedFrequency={combinedFrequency}
              />
            </>
          ) : null}
          <ReviewPhase
            slotId={selectedSlotId}
            existingAppointment={existingAppointment}
            paymentPreference={paymentPreference}
            secondsRemaining={countdownSeconds}
            onConfirm={handleConfirm}
            onCancel={handleReviewCancel}
            invoiceMode={!!estimate.billByInvoice}
            serviceMode={serviceMode}
            depositNote={data?.depositPolicy?.required && paymentPreference !== 'prepay_annual'
              ? `A ${fmtMoney(serviceMode === 'one_time' ? data.depositPolicy.oneTimeAmount : data.depositPolicy.recurringAmount)} deposit is due today to hold your spot — it is applied to your first invoice.`
              : null}
          />
          {depositIntent ? (
            <DepositModal
              intent={depositIntent}
              onSuccess={handleDepositSuccess}
              onCancel={handleDepositCancel}
            />
          ) : null}
          {aiPanelBlock}
        </>
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
              {services.map((section) => {
                const setupFees = renderFlags.showWaveGuardSetupFee && section.setupFee
                  ? (pricing.firstVisitFees && pricing.firstVisitFees.length > 0
                    ? pricing.firstVisitFees
                    : (pricing.setupFee ? [pricing.setupFee] : []))
                  : [];
                const afterPrice = services.length === 1 ? (
                  <>
                    {setupFees.map((fee, i) => <SetupFeeCard key={`${fee.label || 'fee'}-${i}`} fee={fee} />)}
                    {!estimate.showOneTimeOption ? (
                      <OneTimeBreakdownCard
                        breakdown={pricing.oneTimeBreakdown}
                        excludeServices={setupFees.map((fee) => fee.service)}
                      />
                    ) : null}
                  </>
                ) : null;
                return (
                  <ServiceSection
                    key={section.key}
                    section={section}
                    servicesLength={services.length}
                    selectedFrequencyKey={selected[section.key]}
                    selectedAddOns={selectedAddOns[section.key] || new Set()}
                    onFrequencyChange={handleFrequencyChange}
                    onAddOnToggle={onToggleAddOn}
                    disabled={ctaPhase === 'submitting'}
                    renderFlags={renderFlags}
                    waveGuardTier={waveGuardTier}
                    afterPrice={afterPrice}
                  />
                );
              })}

              {services.length > 1 && renderFlags.showRecurringSummary ? (
                <CombinedRecurringPriceCard
                  combined={pricing.combinedRecurring}
                  selectedFrequency={combinedFrequency}
                  waveGuardTier={combinedTierEligible ? waveGuardTier : null}
                />
              ) : null}

              {services.length > 1 && renderFlags.showWaveGuardSetupFee ? (
                (pricing.firstVisitFees && pricing.firstVisitFees.length > 0
                  ? pricing.firstVisitFees
                  : (pricing.setupFee ? [pricing.setupFee] : [])
                ).map((fee, i) => <SetupFeeCard key={`${fee.label || 'fee'}-${i}`} fee={fee} />)
              ) : null}

              {services.length > 1 && !estimate.showOneTimeOption ? (
                <OneTimeBreakdownCard
                  breakdown={pricing.oneTimeBreakdown}
                  excludeServices={(pricing.firstVisitFees || []).map((fee) => fee.service)}
                />
              ) : null}

              <PortalShowcaseCard />
            </>
          ) : (
            <>
              <OneTimePriceCard
                oneTimePrice={pricing.anchorOneTimePrice || pricing.oneTimeBreakdown?.total || 0}
                breakdown={pricing.oneTimeBreakdown}
              />
              <OneTimeBreakdownCard breakdown={pricing.oneTimeBreakdown} />
              {renderFlags.showOneTimePestAddOns === true ? (
                services
                  .filter((section) => section.isPest)
                  .map((section) => {
                    const frequency = selectedFrequencyForSection(section, selected);
                    return (
                      <AddOnsBlock
                        key={`${section.key}-one-time-addons`}
                        addOns={frequency?.addOns || []}
                        selectedKeys={selectedAddOns[section.key] || new Set()}
                        onToggle={(key) => onToggleAddOn(section.key, key)}
                      />
                    );
                  })
              ) : null}
            </>
          )}

          {/* Waves AI panel + Ask bar render AFTER the price/plan (matches the
              server-rendered estimate's order: price → Waves AI → booking) so
              the customer sees the price first. */}
          {aiPanelBlock}

          {canShowSlotPicker ? (
            <SlotPicker
              token={token}
              askToken={estimate.askToken}
              selectedSlotId={selectedSlotId}
              onSelect={setSelectedSlotId}
              refreshSignal={slotsRefreshSignal}
              serviceMode={serviceMode}
              selectedFrequency={selectedFrequency}
            />
          ) : (
            <AcceptanceModeCard acceptance={acceptance} />
          )}

          {existingAppointment ? (
            <ExistingAppointmentCard appointment={existingAppointment} />
          ) : null}

          {(existingAppointment || (canShowSlotPicker && selectedSlotId)) ? (
            <PaymentPreferenceButtons
              onSelect={handlePaymentChoice}
              disabled={ctaPhase === 'submitting'}
              serviceMode={serviceMode}
              setupFee={pricing.setupFee || null}
              annualPrepayEligible={pricing.annualPrepayEligible === true}
              invoiceMode={!!estimate.billByInvoice}
              selectedFrequency={combinedFrequency}
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
