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
import CustomerReviews from '../components/estimate/CustomerReviews';
import AppShowcaseCard from '../components/estimate/AppShowcaseCard';
import EstimateGlassTheme, { fireGlassConfetti } from '../components/estimate/glass/EstimateGlassTheme';

// Payment Element renders inside Stripe's iframe, so the glass theme can't
// restyle it via CSS — when the theme is mounted the modals pass brand-tuned
// appearance variables instead. Visual-only, follows the ?glass=1 gate.
const glassAppearanceActive = () => document.documentElement.hasAttribute('data-glass-theme');
import { estimateCard, estimateInnerBox } from '../components/estimate/cardStyles';
import TerminalStateCard from '../components/estimate/TerminalStateCard';
import { estimateCopyFor } from '../lib/estimate-copy';
import {
  glassCopyActive,
  glassCtaMicroFor,
  glassDayLinesFor,
  glassEstimateCopyFor,
  glassServiceSlug,
  glassTierDisplay,
  setGlassDefault,
  GLASS_COPY,
} from '../lib/estimate-glass-copy';
import {
  GlassProofStrip,
  GlassSectionCta,
  GlassStickyBookBar,
  useFeaturedReviews,
} from '../components/estimate/glass/GlassEstimateExtras';
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

// Universal hero headline (owner directive 2026-07-03). The eyebrow line
// ("Your estimate · <quoted services>") carries the service specifics, so
// the headline itself never has to guess at per-service phrasing — and can
// never invite a "choose your option" on an estimate with nothing to choose.
const UNIVERSAL_HEADLINE = 'Hello {first}, your estimate is ready!';

// Small uppercase section kicker — same treatment as "How often?" /
// "Customize your visit" so every card opens with a matching subheader.
const SECTION_KICKER_STYLE = {
  fontSize: 12,
  fontWeight: 700,
  color: ESTIMATE_MUTED,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  marginBottom: 6,
};

const BOOKING_SECTION_ID = 'estimate-booking-section';
const PRICE_SECTION_ID = 'estimate-price-section';

function scrollToPriceSection() {
  const el = typeof document !== 'undefined' ? document.getElementById(PRICE_SECTION_ID) : null;
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function scrollToBookingSection() {
  const el = typeof document !== 'undefined' ? document.getElementById(BOOKING_SECTION_ID) : null;
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Primary booking CTA — same navy treatment as the add-service button;
// jumps the customer straight to the scheduling section.
function GetServiceTodayCta({ showGuaranteeMicro = false, slotMeta = null, microText = null }) {
  const glass = glassCopyActive();
  // Slot-aware label (PR C): once a slot is picked the CTA names it, so the
  // action reads as confirming THAT visit rather than restarting the flow.
  const label = glass
    ? (slotMeta ? `Approve — ${slotMeta.dow} ${slotMeta.time}` : GLASS_COPY.ctaMain)
    : 'Get service today!';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', margin: '16px 0 24px' }}>
      <button
        type="button"
        onClick={scrollToBookingSection}
        style={{
          minHeight: 44,
          minWidth: 220,
          padding: '0 28px',
          background: ESTIMATE_BUTTON_BG,
          color: COLORS.white,
          border: 'none',
          borderRadius: 10,
          fontSize: 15,
          fontWeight: 800,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        {label}
        {glass && slotMeta ? <Icon name="check" size={16} strokeWidth={2.6} /> : null}
      </button>
      {/* Terms microcopy is opt-in per call site, and the line itself is
          category-aware (glassCtaMicroFor): recurring plans carry the
          contract/callback/guarantee terms, one-time projects carry the
          license + satisfaction-guarantee line instead. */}
      {glass && showGuaranteeMicro ? (
        <div style={{ marginTop: 10, fontSize: 12.5, color: ESTIMATE_MUTED, textAlign: 'center', lineHeight: 1.5 }}>
          {microText || GLASS_COPY.ctaMicro}
        </div>
      ) : null}
    </div>
  );
}

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

// Per-service cadence: find the precomputed combo matching the customer's
// independent per-section selections so the combined total reflects EVERY
// service's chosen cadence (not just the pest cadence). Returns null when the
// estimate carries no combos or its sections don't map onto the combo axes.
function selectedServiceCadenceCombo(pricing = {}, services = [], selected = {}) {
  const combos = Array.isArray(pricing?.serviceCadenceCombos) ? pricing.serviceCadenceCombos : [];
  if (!combos.length) return null;
  const axisKeys = Object.keys(combos[0].selection || {});
  if (!axisKeys.length) return null;
  const current = {};
  for (const axis of axisKeys) {
    const section = services.find((s) => s.key === axis);
    if (!section) return null;
    const key = selected[section.key] || section.defaultFrequencyKey || section.frequencies?.[0]?.key;
    if (!key) return null;
    current[axis] = key;
  }
  return combos.find((c) => {
    const sel = c.selection || {};
    return Object.keys(sel).length === axisKeys.length && axisKeys.every((k) => sel[k] === current[k]);
  }) || null;
}

function serviceLabelForKey(key) {
  switch (key) {
    case 'tree_shrub': return 'Tree & Shrub';
    case 'lawn_care': return 'Lawn Care';
    case 'mosquito': return 'Mosquito Control';
    case 'termite_bait': return 'Termite Bait';
    case 'palm_injection': return 'Palm Injection';
    case 'rodent_bait': return 'Rodent Bait Stations';
    case 'pest_control': return 'Pest Control';
    default: return 'Service';
  }
}

// Customer-facing service label — normalizes the server's short section
// labels (owner directive: "Mosquito" always reads "Mosquito Control").
function displayServiceLabel(label) {
  const clean = String(label || '').trim();
  return /^mosquito$/i.test(clean) ? 'Mosquito Control' : clean;
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
    // Glass copy names the actual mechanics instead of the abstract "next
    // pricing tier" — but the Silver/10% claim is only true when lawn would
    // be the SECOND service; a multi-service pest plan is already past
    // Silver, so it gets the tier-agnostic body.
    if (glassCopyActive()) {
      const lawnWouldBeSecondService = currentKeys.size === 1;
      return {
        serviceKey: 'lawn_care',
        label: 'Lawn Care',
        icon: 'leaf',
        title: GLASS_COPY.lawnOfferTitle,
        body: lawnWouldBeSecondService ? GLASS_COPY.lawnOfferBody : GLASS_COPY.lawnOfferBodyMulti,
        buttonLabel: lawnWouldBeSecondService ? GLASS_COPY.lawnOfferButton : GLASS_COPY.lawnOfferButtonMulti,
      };
    }
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

// Liquid-glass theme gate (docs/design/estimate-glass-plan.md). Re-evaluated
// per render — released estimates learn glassDefault from the /data payload
// (setGlassDefault), which lands after the first loading render, so the
// wrapper must pick the flip up rather than read once at mount. The URL
// param still forces either way (?glass=1 / ?glass=0).
function Page({ children }) {
  const glassActive = glassCopyActive();
  return (
    <div style={{
      minHeight: '100vh', background: ESTIMATE_BG,
      fontFamily: FONT_BODY, color: COLORS.navy,
      display: 'flex', flexDirection: 'column',
    }}>
      <EstimateGlassTheme active={glassActive} />
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
      {/* Estimate pages get the quiet contact footer — no newsletter signup
          in the middle of a quote (matches the server-rendered estimate). */}
      <BrandFooter variant="contact" />
    </div>
  );
}

function SkeletonBlock() {
  return (
    <div style={estimateCard()}>
      <div style={{ height: 12, width: 120, background: ESTIMATE_CHROME, borderRadius: 4 }} />
      <div style={{ height: 32, width: '60%', background: ESTIMATE_CHROME, borderRadius: 4, marginTop: 14 }} />
      <div style={{ height: 14, width: '40%', background: ESTIMATE_CHROME, borderRadius: 4, marginTop: 10 }} />
    </div>
  );
}

function NotFoundCard() {
  return (
    <div style={estimateCard({ padding: 32, textAlign: 'center', marginTop: 40 })}>
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

// Mirrors the server-rendered hero's phone display: 10-digit US numbers get
// the (xxx) xxx-xxxx treatment, anything else renders as stored.
function formatCustomerPhone(phone) {
  const raw = String(phone || '').replace(/\D/g, '');
  const digits = raw.length === 11 && raw.startsWith('1') ? raw.slice(1) : raw;
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return String(phone || '').trim();
}

// Eyebrow type treatment — shared by the "Your estimate · …" kicker and the
// customer-contact lines under the headline (matches the SSR .hero-contact).
const HEADER_EYEBROW_STYLE = {
  fontSize: 12,
  color: ESTIMATE_MUTED,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  fontWeight: 700,
};

function Header({ customerFirstName, customerName, customerEmail, customerPhone, address, serviceLabel, headline, eyebrowOverride = null, subline = null }) {
  const firstName = customerFirstName || 'there';
  const headlineText = String(headline || UNIVERSAL_HEADLINE).replace('{first}', firstName);
  const phoneDisplay = formatCustomerPhone(customerPhone);
  const contactLines = [
    customerName,
    customerEmail,
    phoneDisplay,
    address,
  ].map((line) => String(line || '').trim()).filter(Boolean);
  return (
    <div style={{ padding: '8px 0 24px' }}>
      <div style={{ ...HEADER_EYEBROW_STYLE, marginBottom: 6 }}>
        {/* The glass eyebrow carries the plan framing itself, so it drops the
            "· {service}" suffix instead of stacking both. */}
        {eyebrowOverride || `Your estimate${serviceLabel ? ` · ${serviceLabel}` : ''}`}
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
      {subline ? (
        <p style={{ margin: '14px 0 0', fontSize: 16, color: ESTIMATE_BODY, lineHeight: 1.55, maxWidth: '62ch' }}>
          {subline}
        </p>
      ) : null}
      {contactLines.length ? (
        <div style={{ marginTop: 14, display: 'grid', gap: 4 }}>
          {contactLines.map((line) => (
            <div key={line} style={{ ...HEADER_EYEBROW_STYLE, lineHeight: 1.5 }}>{line}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WaveGuardIntelligenceCard({ intelligence, address, copy, showYourWork = null, lockInCta = null }) {
  if (!intelligence) return null;
  const metrics = Array.isArray(intelligence.metrics) ? intelligence.metrics : [];
  const signals = Array.isArray(intelligence.signals) ? intelligence.signals : [];
  // "Show your work" (estimateShowYourWork gate): the parcel-outline
  // satellite image replaces the plain one when the server resolved it.
  const satelliteUrl = showYourWork?.overlaySatelliteUrl || intelligence.satelliteUrl;
  const showYourWorkFacts = Array.isArray(showYourWork?.facts) ? showYourWork.facts : [];

  return (
    <section style={estimateCard()}>
      <div style={{ marginBottom: 10 }}>
        <div style={SECTION_KICKER_STYLE}>
          {intelligence.eyebrow || copy?.aiEyebrow || 'Waves AI'}
        </div>
        <h2 style={{
          fontFamily: FONTS.serif,
          fontSize: 24,
          fontWeight: 500,
          lineHeight: 1.18,
          color: ESTIMATE_TEXT,
          margin: 0,
          letterSpacing: 0,
        }}>
          {intelligence.title || copy?.aiTitle || 'Waves AI reviewed your property before pricing this estimate'}
        </h2>
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
              style={estimateInnerBox({ padding: '10px 12px' })}
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

      {lockInCta}
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
    <section style={{ ...estimateCard(), display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontFamily: FONTS.serif, fontSize: 24, fontWeight: 500, lineHeight: 1.18, color: ESTIMATE_TEXT, margin: 0 }}>
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
    <section style={{ ...estimateCard(), display: 'grid', gap: 12 }}>
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
          fontSize: 24,
          fontWeight: 500,
          lineHeight: 1.18,
          color: ESTIMATE_TEXT,
          margin: 0,
          letterSpacing: 0,
        }}>
          {glassCopyActive() ? GLASS_COPY.askTitle : 'Ask Waves'}
        </h2>
        {glassCopyActive() ? (
          <p style={{ margin: '6px 0 0', fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.55 }}>
            {GLASS_COPY.askExcerpt}
          </p>
        ) : null}
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
            fontSize: 15,
            fontWeight: 800,
            cursor: asking || !question.trim() ? 'not-allowed' : 'pointer',
            // Stay clearly navy while disabled — at 0.65 the button read
            // as gray next to the other brand buttons.
            opacity: asking || !question.trim() ? 0.8 : 1,
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

// `acceptedMode` pins the label to the mode the customer actually accepted
// ('one_time' | 'recurring'): a terminal/success header must not re-offer the
// "X or One-Time X" choice, and an accepted one-time booking on a mixed
// estimate reads "One-Time X", not the default recurring cadence.
export function getServiceLabel(frequency, estimate, pricing, acceptedMode = null) {
  if (estimate?.isOneTimeOnly) {
    // Every billable line belongs in the eyebrow, not just the first —
    // mirrors the SSR page's quotedOneTimeNames.join(' + '). Fee/review rows
    // (inspections, $0 credits, WaveGuard setup) aren't quoted services, but
    // if nothing billable remains they're better than "One-time service".
    const rows = (pricing?.oneTimeBreakdown?.items || [])
      .filter((item) => item && item.kind !== 'discount');
    const billable = rows.filter((item) => !isNonBillableBreakdownRow(item));
    const names = (billable.length ? billable : rows)
      .map((item) => String(item.label || '').trim())
      .filter(Boolean);
    const unique = [...new Set(names)];
    return unique.length ? unique.join(' + ') : 'One-time service';
  }
  // A multi-service plan names every quoted service (SSR parity:
  // quotedServiceNames.join(' + ')) — the per-section cards below carry
  // each service's own cadence, so the eyebrow stays cadence-free here.
  const recurringSections = pricingServices(pricing).filter((section) => section?.isRecurring);
  if (recurringSections.length > 1) {
    return recurringSections.map((section) => displayServiceLabel(section.label) || serviceLabelForKey(section.key)).join(' + ');
  }
  const category = frequencyServiceCategory(frequency, pricing);
  const service = recurringServiceForEstimate(pricing);
  const serviceLabel = displayServiceLabel(service?.label) || serviceLabelForKey(category);
  if (acceptedMode === 'one_time') {
    return `One-Time ${serviceLabel}`;
  }
  if (!acceptedMode && estimate?.showOneTimeOption && (pricing?.anchorOneTimePrice || 0) > 0) {
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

function isBoraCareBreakdownItem(item = {}) {
  if (['bora_care', 'boracare'].includes(String(item.service || '').toLowerCase())) return true;
  const raw = [item.label, item.name, item.displayName]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  return raw.includes('bora care') || raw.includes('boracare');
}

// Mirrors the server isNonBillableOneTimeRow: inspections, the WaveGuard setup
// fee, and any discount/credit/zero row (amount <= 0) carry no billable service
// of their own. A positive unrecognized charge is intentionally treated as
// billable so it blocks a "Bora-Care-only" classification.
function isNonBillableBreakdownRow(item = {}) {
  const raw = [item.service, item.label, item.name, item.detail]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  if (/(inspection|field review|office review)/.test(raw)) return true;
  if (raw.includes('waveguard setup')) return true;
  const amount = Number(item.amount ?? item.price ?? item.total);
  return Number.isFinite(amount) && amount <= 0;
}

function germanRoachVisitPhrase(visits) {
  const n = Number(visits) || 0;
  const words = { 1: 'One visit', 2: 'Two visits', 3: 'Three visits', 4: 'Four visits' };
  return words[n] || (n > 0 ? `${n} visits` : 'Multiple visits');
}

export function oneTimePriceCopy(breakdown = {}) {
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
  // Bora-Care is a borate wood treatment, not a pest visit — mirror the SSR copy
  // and omit the 30-day pest callback/guarantee line. Gated on Bora-Care-ONLY (like
  // the server hasOnlyBoraCareServiceMix) so a mixed quote with another positive
  // billable row keeps the default callback copy instead of dropping it.
  const boraCareOnly = items.some(isBoraCareBreakdownItem)
    && items.every((it) => isBoraCareBreakdownItem(it) || isNonBillableBreakdownRow(it));
  if (boraCareOnly) {
    return 'Bora-Care is a borate wood treatment applied to the measured attic and surface areas. It treats bare wood for termites, wood-boring beetles, and wood-decay fungi. Pay on the service day, no recurring schedule.';
  }
  // A guarantee-only renewal is a 12-month re-entry warranty with NO service
  // visit — it accepts through the payment-only invoice path, so the default
  // "One visit, pay on service day" copy would contradict the "No appointment
  // needed" acceptance card below it. Gated on guarantee-ONLY (mirrors the
  // server's isRodentGuaranteeOnlyEstimate shape) so a bundled rodent job
  // keeps the visit copy.
  const rodentGuaranteeOnly = items.some((item) => item?.service === 'rodent_guarantee')
    && items.every((item) => item?.service === 'rodent_guarantee' || isNonBillableBreakdownRow(item));
  if (rodentGuaranteeOnly) {
    return 'Annual rodent guarantee — 12-month re-entry warranty, renewable annually. No service visit to schedule: accept below and we send your invoice.';
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
          {glassCopyActive() ? GLASS_COPY.setupWaivedNote : 'Waived when you pay the year in full up front.'}
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
    <section style={estimateCard({ padding: 16 })}>
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
              // Centered under the title + body, sized to its label.
              margin: '12px auto 0',
              width: 'fit-content',
              minWidth: 220,
              padding: '0 24px',
              minHeight: 44,
              border: 'none',
              borderRadius: 10,
              background: isReceived ? '#166534' : ESTIMATE_BUTTON_BG,
              color: COLORS.white,
              fontSize: 15,
              fontWeight: 800,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              cursor: isSubmitting || isReceived ? 'default' : 'pointer',
              opacity: isSubmitting ? 0.72 : 1,
            }}
          >
            <Icon name={isReceived ? 'check' : 'plus'} size={17} strokeWidth={2.4} />
            {isSubmitting ? 'Sending request...' : isReceived ? 'Request received' : (offer.buttonLabel || `Add ${offer.label}`)}
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
    <div style={estimateCard()}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: FONTS.serif, fontSize: 32, fontWeight: 500, color: ESTIMATE_TEXT, lineHeight: 1 }}>
        {fmtMoney(oneTimePrice)}
        </span>
        <span style={{ fontSize: 15, fontWeight: 500, color: ESTIMATE_MUTED }}>one-time</span>
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
    <div style={estimateCard({ padding: 18 })}>
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
  // recurringAmount is the authoritative recurring slice — prefer it over a
  // server-provided monthlyAmount, which older/other bundle paths may still
  // derive from the combined amount that now includes the one-time slice.
  const recurring = Number(manualDiscount.recurringAmount);
  if (Number.isFinite(recurring)) {
    return recurring > 0 ? Math.round((recurring / 12) * 100) / 100 : 0;
  }
  const monthly = Number(manualDiscount.monthlyAmount);
  if (Number.isFinite(monthly) && monthly > 0) return Math.round(monthly * 100) / 100;
  // Legacy estimates saved before the slice fields existed: amount was recurring-only.
  const amount = Number(manualDiscount.amount);
  return Number.isFinite(amount) && amount > 0 ? Math.round((amount / 12) * 100) / 100 : 0;
}

export function CombinedRecurringPriceCard({ combined, selectedFrequency, waveGuardTier }) {
  if (!combined) return null;
  const quoteRequired = selectedFrequency?.quoteRequired === true;
  const quoteReason = quoteRequired ? quoteRequiredReasonText(selectedFrequency || combined) : '';
  const monthly = quoteRequired ? null : (selectedFrequency?.monthly ?? combined.monthlySubtotal);
  const annual = quoteRequired ? null : (selectedFrequency?.annual ?? combined.annualSubtotal);
  const manualDiscount = combined.manualDiscount && Number(combined.manualDiscount.amount) > 0
    ? combined.manualDiscount
    : null;
  const manualDiscountMonthly = manualDiscountMonthlyAmount(manualDiscount);
  // Narrow low-confidence commercial estimate: range the combined recurring total
  // on its aggregate low-confidence share (mirrors PriceCard). The uncertain LOW
  // dollars are FIXED while the exact part moves with the selected cadence, so
  // derive the fraction from the server's raw lowConfidenceMonthly against the
  // SELECTED monthly (band = LOW × pct at every selection); the stamped
  // default-subtotal fraction is only a fallback for older payloads.
  const round2 = (n) => Math.round(Number(n) * 100) / 100;
  const lowConfidencePct = quoteRequired ? 0 : Number(selectedFrequency?.lowConfidenceRangePct ?? combined.lowConfidenceRangePct) || 0;
  const rawFraction = Number(selectedFrequency?.lowConfidenceFraction ?? combined.lowConfidenceFraction);
  const stampedFraction = Number.isFinite(rawFraction) && rawFraction > 0 ? Math.min(rawFraction, 1) : 1;
  const rawLowMonthly = Number(selectedFrequency?.lowConfidenceMonthly ?? combined.lowConfidenceMonthly);
  const lowConfidenceFraction = Number.isFinite(rawLowMonthly) && rawLowMonthly > 0 && Number(monthly) > 0
    ? Math.min(rawLowMonthly / Number(monthly), 1)
    : stampedFraction;
  const showLowConfidenceRange = lowConfidencePct > 0 && monthly != null && monthly > 0;
  const monthlyBand = showLowConfidenceRange ? monthly * lowConfidenceFraction * lowConfidencePct : 0;
  const rangeLow = showLowConfidenceRange ? round2(monthly - monthlyBand) : null;
  const rangeHigh = showLowConfidenceRange ? round2(monthly + monthlyBand) : null;
  const annualBand = showLowConfidenceRange && annual ? Number(annual) * lowConfidenceFraction * lowConfidencePct : 0;
  const annualRangeLow = showLowConfidenceRange && annual ? round2(Number(annual) - annualBand) : null;
  const annualRangeHigh = showLowConfidenceRange && annual ? round2(Number(annual) + annualBand) : null;
  return (
    <section style={estimateCard()}>
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
            fontSize: quoteRequired ? 34 : showLowConfidenceRange ? 34 : 46,
            lineHeight: 1,
            color: ESTIMATE_TEXT,
            fontWeight: 500,
          }}>
            {quoteRequired
              ? 'Quote required'
              : showLowConfidenceRange
              ? `${fmtMoney(rangeLow)}–${fmtMoney(rangeHigh)}`
              : fmtMoney(monthly)}
            {!quoteRequired ? <span style={{ fontFamily: FONT_BODY, fontSize: 20, color: ESTIMATE_MUTED }}> /mo</span> : null}
          </div>
          {!quoteRequired && annual ? (
            <div style={{ fontSize: 14, color: ESTIMATE_MUTED, marginTop: 8 }}>
              {showLowConfidenceRange
                ? `${fmtMoney(annualRangeLow)} – ${fmtMoney(annualRangeHigh)} / year`
                : `${fmtMoney(annual)} / year`}
            </div>
          ) : null}
          {showLowConfidenceRange ? (
            <div style={{ fontSize: 14, color: ESTIMATE_MUTED, marginTop: 8, lineHeight: 1.5, maxWidth: 320 }}>
              Estimated range — we confirm your exact price with a quick site visit.
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
    <div style={estimateCard()}>
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
function DepositModal({ intent, onSuccess, onCancel, creditTarget = 'your first invoice' }) {
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
        appearance: glassAppearanceActive()
          ? { theme: 'stripe', variables: { borderRadius: '12px', colorPrimary: '#0A7EC2', colorText: '#04395E', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' } }
          : { theme: 'stripe', variables: { borderRadius: '8px', fontFamily: FONTS.body } },
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
          A {fmtMoney(intent.amount)} deposit holds your spot. It is applied to {creditTarget}.
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

// One-time card-on-file hold (dark until ONE_TIME_CARD_HOLD). Mirrors
// DepositModal but captures a card via a SetupIntent — NO money is taken. On a
// succeeded setup the saved card's intent id flows to accept; the card is
// charged the final total on completion, and a flat fee only on a no-show /
// late cancel.
function CardHoldModal({ intent, onSuccess, onCancel }) {
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
        appearance: glassAppearanceActive()
          ? { theme: 'stripe', variables: { borderRadius: '12px', colorPrimary: '#0A7EC2', colorText: '#04395E', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' } }
          : { theme: 'stripe', variables: { borderRadius: '8px', fontFamily: FONTS.body } },
      });
      const paymentElement = elements.create('payment');
      paymentElement.mount(mountRef.current);
      paymentElement.on('ready', () => { if (!cancelled) setReady(true); });
      stripeRef.current = stripe;
      elementsRef.current = elements;
    }).catch(() => {
      if (!cancelled) setError('Could not load the secure card form. Check your connection and try again.');
    });
    return () => { cancelled = true; };
  }, [intent]);

  const feeText = fmtMoney(intent.noShowFeeAmount != null ? intent.noShowFeeAmount : 49);
  const windowText = `${intent.cancelWindowHours != null ? intent.cancelWindowHours : 24} hours`;

  const handleSave = useCallback(async () => {
    if (!stripeRef.current || !elementsRef.current) return;
    setSubmitting(true);
    setError(null);
    try {
      // Re-tap after a succeeded setup — honor the captured card instead of
      // re-confirming.
      const existing = await stripeRef.current.retrieveSetupIntent(intent.clientSecret);
      if (existing?.setupIntent?.status === 'succeeded') {
        onSuccess(existing.setupIntent.id);
        return;
      }
      const result = await stripeRef.current.confirmSetup({
        elements: elementsRef.current,
        confirmParams: { return_url: window.location.href },
        redirect: 'if_required',
      });
      if (result.error) {
        setError(result.error.message || 'We could not save that card. Try another card.');
        setSubmitting(false);
        return;
      }
      const si = result.setupIntent;
      if (si && si.status === 'succeeded') {
        onSuccess(si.id);
        return;
      }
      setError('That card could not be saved. Try again in a moment.');
      setSubmitting(false);
    } catch {
      setError('We could not save that card. Try again.');
      setSubmitting(false);
    }
  }, [intent, onSuccess]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(27,44,91,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
      <div style={{ background: COLORS.white, borderRadius: 16, maxWidth: 440, width: '100%', padding: 24, boxShadow: '0 18px 50px rgba(0,0,0,0.25)', maxHeight: '90vh', overflow: 'auto' }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: COLORS.navy }}>Hold your appointment</div>
        <div style={{ fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.5, margin: '6px 0 14px' }}>
          We won&rsquo;t charge you today. Your card is charged the final total after your visit is completed.
          A {feeText} fee applies only if you cancel within {windowText} or aren&rsquo;t home.
          {' '}Credit cards add a small processing fee; debit and bank cards don&rsquo;t.
        </div>
        <div ref={mountRef} />
        {error ? (
          <div role="alert" style={{ color: '#C8312F', fontSize: 14, lineHeight: 1.45, marginTop: 10 }}>{error}</div>
        ) : null}
        <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
          <button
            type="button"
            onClick={handleSave}
            disabled={!ready || submitting}
            style={{
              padding: '16px 20px', background: ESTIMATE_BUTTON_BG, color: COLORS.white,
              border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 600, cursor: 'pointer',
              opacity: !ready || submitting ? 0.6 : 1,
            }}
          >{submitting ? 'Saving…' : 'Save card & hold my spot'}</button>
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

export function ReviewPhase({ slotId, existingAppointment, paymentPreference, secondsRemaining, onConfirm, onCancel, invoiceMode, invoiceOnly = false, siteConfirmationHold = false, manualScheduling = false, serviceMode, depositNote }) {
  const usingExistingAppointment = !!existingAppointment;
  const recurringPayPerApplication = serviceMode !== 'one_time' && paymentPreference === 'pay_at_visit';
  // A held (site-confirmation) recurring accept mints NO invoice whatever the
  // billing mode — the account manager confirms the exact price on site, then
  // the first invoice follows — so the generic "due now / creates your invoice"
  // copy would promise a payment step that never happens. Mirrors
  // PaymentPreferenceButtons' heldRecurring gate (NOT invoice-gated).
  const heldForSiteConfirmation = siteConfirmationHold && serviceMode !== 'one_time';
  const paymentLabel = heldForSiteConfirmation
    ? 'No payment now — price confirmed on site'
    : invoiceMode
      ? 'Invoice due now'
      : recurringPayPerApplication
        ? 'Pay per application'
        : paymentPreference === 'prepay_annual'
          ? 'Pay the 12-month plan in full'
          : 'Pay at the visit';
  const confirmLabel = invoiceOnly
    ? 'Accept + send invoice'
    : heldForSiteConfirmation
      ? (usingExistingAppointment ? 'Confirm approval' : 'Approve estimate')
    : usingExistingAppointment
      ? recurringPayPerApplication
        ? 'Confirm invoice'
        : paymentPreference === 'prepay_annual'
          ? 'Confirm annual prepay'
          : 'Confirm appointment'
      : 'Confirm booking';
  const confirmSub = invoiceOnly
    ? 'No appointment needed. Next step creates your invoice and makes secure payment available.'
    : heldForSiteConfirmation
      ? (usingExistingAppointment
        ? 'Your existing appointment stays scheduled. No payment needed now — we confirm your exact price on a quick site visit, then send your first invoice.'
        : 'No payment needed now. Your account manager confirms the exact price on a quick site visit, then sends your first invoice.')
    : usingExistingAppointment
      ? recurringPayPerApplication
        ? 'Your existing appointment stays scheduled. Next step creates your invoice and makes secure payment available.'
        : paymentPreference === 'prepay_annual'
          ? 'Your existing appointment stays scheduled. Annual prepay invoice is available for optional payment after confirmation.'
          : 'Your existing appointment stays scheduled. We will collect payment with the tech on-site.'
      : '';
  return (
    <div style={{ ...estimateCard(), borderTop: `4px solid ${ESTIMATE_BUTTON_BG}` }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: ESTIMATE_BUTTON_BG, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {invoiceOnly
          ? 'Confirm your acceptance'
          : heldForSiteConfirmation
            ? 'Confirm your approval'
            : usingExistingAppointment ? 'Confirm invoice option' : 'Confirm your booking'}
      </div>
      <div style={{ fontSize: 18, color: COLORS.navy, marginTop: 10, lineHeight: 1.5 }}>
        {heldForSiteConfirmation ? 'Payment: ' : usingExistingAppointment ? 'Selected invoice option: ' : 'Pay option: '}
        <strong>{paymentLabel}</strong>{usingExistingAppointment ? '.' : null}
      </div>
      <div style={{ fontSize: 14, color: ESTIMATE_BODY, marginTop: 4 }}>
        {invoiceOnly
          ? 'No appointment to schedule.'
          : usingExistingAppointment
            ? `Appointment: ${formatAppointmentLabel(existingAppointment)}`
            : manualScheduling
              ? 'Scheduling: a Waves team member will reach out to set up your visit.'
              : `Slot: ${slotId}`}
      </div>
      {!usingExistingAppointment && !invoiceOnly && !manualScheduling ? <div style={{ marginTop: 16 }}><CountdownLine secondsRemaining={secondsRemaining} /></div> : null}
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
      <div style={{ ...estimateCard({ padding: 28, textAlign: 'center' }), borderTop: `4px solid ${COLORS.green}` }}>
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
      <div style={{ ...estimateCard({ padding: 28, textAlign: 'center' }), borderTop: `4px solid ${COLORS.green}` }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.navy, marginTop: 8 }}>
          Your annual prepay is approved.
        </div>
        <div style={{ fontSize: 16, color: ESTIMATE_BODY, marginTop: 10, lineHeight: 1.55 }}>
          Your annual prepay{prepayAmountText} is approved. Our team will follow up with the invoice details and confirm the schedule.
        </div>
      </div>
    );
  }

  if (nextStep === 'site_confirmation') {
    // Narrow low-confidence commercial: approved online, but the exact price is
    // confirmed on site before the first invoice — so no payment step here.
    return (
      <div style={{ ...estimateCard({ padding: 28, textAlign: 'center' }), borderTop: `4px solid ${COLORS.green}` }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.navy, marginTop: 8 }}>
          You're approved — no payment needed yet.
        </div>
        <div style={{ fontSize: 16, color: ESTIMATE_BODY, marginTop: 10, lineHeight: 1.55 }}>
          Your Waves account manager will confirm the exact price on a quick site visit, then send your first
          invoice. Nothing is charged until that's done.
        </div>
      </div>
    );
  }

  if (nextStep === 'book_one_time') {
    return (
      <div style={{ ...estimateCard({ padding: 28, textAlign: 'center' }), borderTop: `4px solid ${COLORS.green}` }}>
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
    <div style={{ ...estimateCard({ padding: 28, textAlign: 'center' }), borderTop: `4px solid ${COLORS.green}` }}>
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

// Staff draft preview marker — rendered only when the /data payload carries
// the JWT-verified adminDraftPreview flag. Customer-surface styling (matches
// SlotIssueBanner), not the admin monochrome spec: this banner lives on the
// customer page even though only staff ever see it.
export function DraftPreviewBanner() {
  return (
    <div style={{
      background: '#fff4e5', borderRadius: 12, padding: 14,
      border: '1px solid #f5bb5c', marginBottom: 16,
    }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: COLORS.navy }}>
        Draft preview — not sent to the customer yet
      </div>
      <div style={{ fontSize: 14, color: COLORS.navy, marginTop: 4 }}>
        This is the exact page the customer will get. Booking, payment, and
        requests stay disabled until the estimate is sent.
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
  if (acceptance.mode === 'invoice_only') {
    // Payment-only accept (guarantee-only renewal) — informational, no call
    // CTA: the accept button below handles the whole flow.
    return (
      <div style={estimateCard()}>
        <div style={{ fontSize: 20, fontWeight: 700, color: ESTIMATE_TEXT, marginBottom: 8 }}>
          No appointment needed.
        </div>
        <div style={{ fontSize: 15, color: ESTIMATE_BODY, lineHeight: 1.55 }}>
          This renews your annual guarantee coverage — there is no service visit to
          schedule. Accept below and we will send your invoice by text and email.
        </div>
      </div>
    );
  }
  // Held (site-confirmation) commercial estimate: the customer approves online
  // WITHOUT picking a slot — the accept CTA renders right below this card — so
  // this is informational (no call-to-book), explaining who schedules the visit.
  if (acceptance.mode === 'commercial_site_confirmation') {
    return (
      <div style={estimateCard()}>
        <div style={{ fontSize: 20, fontWeight: 700, color: ESTIMATE_TEXT, marginBottom: 8 }}>
          Approve online — we handle the scheduling.
        </div>
        <div style={{ fontSize: 15, color: ESTIMATE_BODY, lineHeight: 1.55 }}>
          No appointment to pick here: after you approve, a Waves team member reaches out to
          schedule your commercial service, and your account manager confirms the exact price
          on a quick site visit before your first invoice.
        </div>
      </div>
    );
  }
  const title = acceptance.mode === 'quote_required'
    ? 'This treatment needs a custom quote.'
    : acceptance.mode === 'contact_office'
      ? 'Call Waves to finish this renewal.'
      : 'Waves will help schedule this estimate.';
  const body = acceptance.mode === 'inspection_request'
    ? 'This plan needs an inspection before a normal service slot can be reserved online.'
    : acceptance.mode === 'contact_office'
      ? 'No appointment is needed — call and we will set up your invoice and activate your coverage.'
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

// Rendered in place of the slot picker / accept CTA when the estimate is
// review-before-booking (cta.reviewBeforeBooking — e.g. a priced termite
// trenching quote): NOT a terminal state. The price cards and Ask-Waves stay
// live; only self-booking is gated — a Waves specialist confirms the plan and
// schedules the visit. Mirrors the server-rendered page's review card.
function ReviewBeforeBookingCard({ reason }) {
  const isTrenching = reason === 'termite_trenching_review';
  return (
    <div style={{
      background: COLORS.white,
      borderRadius: 16,
      padding: 24,
      border: `1px solid ${ESTIMATE_BORDER}`,
      marginBottom: 16,
    }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: ESTIMATE_TEXT, marginBottom: 8 }}>
        {isTrenching
          ? 'Waves will confirm & schedule your trenching'
          : 'Waves will confirm & schedule this service'}
      </div>
      <div style={{ fontSize: 15, color: ESTIMATE_BODY, lineHeight: 1.55 }}>
        {isTrenching
          ? 'Your price is set from the measured treatment path. Because trenching drills concrete, lays a chemical soil barrier, and carries a retreat warranty, a Waves specialist confirms the plan with you — access, exact footage, product, and warranty — then schedules your visit, so it can’t be self-booked online.'
          : 'A Waves specialist reviews this quote with you and schedules your visit — it can’t be self-booked online.'}
      </div>
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
        Call Waves to confirm — {WAVES_PHONE_DISPLAY}
      </a>
      <div style={{ fontSize: 14, color: ESTIMATE_MUTED, marginTop: 12, lineHeight: 1.5 }}>
        Prefer we reach out? We’ll follow up to confirm and schedule your visit. You pay on service day; no card or deposit now.
      </div>
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
  showGetServiceCta = false,
  showAddOns: showAddOnsProp = true,
  glassSetupBulletEligible = false,
  ctaSlotMeta = null,
}) {
  if (!section) return null;
  const frequencies = Array.isArray(section.frequencies) ? section.frequencies : [];
  const current = frequencies.find((frequency) => frequency.key === selectedFrequencyKey) || frequencies[0] || null;
  const copy = section.copy || {};
  // Glass cards restate the per-day figure with a value-anchor comparison
  // tail (pest keeps its cadence-matched trio; other programs get their
  // service-matched line). Sections without a glass line — and every
  // section when glass is off — keep their server-provided wording.
  const sectionSlug = section.isPest ? 'pest_control' : glassServiceSlug(section.key || section.label);
  const glassDayLines = glassCopyActive() ? glassDayLinesFor(sectionSlug) : null;
  const priceWording = glassDayLines
    ? { ...copy.priceWording, dayLineByKey: glassDayLines }
    : copy.priceWording;
  const showSlider = frequencies.length > 1;
  const showAddOns = showAddOnsProp
    && section.isPest
    && section.isRecurring
    && renderFlags.showPestRecurringAddOns === true
    && Array.isArray(current?.addOns)
    && current.addOns.length > 0;
  // A one-line checklist that just re-states the quoted service name tells
  // the customer nothing ("What's included: Pest Control") — only render
  // when the list actually adds information (lawn/tree/mosquito programs
  // describe their applications here and nowhere else). Bundle boxes stay
  // checklist-free (owner directive), so single-service layouts only.
  const includedItems = Array.isArray(current?.included) ? current.included : [];
  const showIncludedChecklist = servicesLength === 1
    && (includedItems.length > 1 || includedItems.some((item) => item?.detail));

  return (
    <section>
      {/* Frequency choice + price live in ONE shadow-box card, same
          treatment as every other section (owner: "all boxes should
          render like" the Waves AI card). */}
      <div style={estimateCard()}>
        {servicesLength > 1 ? (
          <h3 style={{
            fontSize: 18,
            color: ESTIMATE_TEXT,
            margin: '0 0 14px',
            fontWeight: 800,
          }}>
            {displayServiceLabel(section.label) || 'Service'}
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
            waveGuardTier={servicesLength > 1 ? null : (section?.waveGuardTierEligible !== false ? waveGuardTier : null)}
            wording={priceWording}
            glassSetupBullet={glassSetupBulletEligible}
            // showSavings only governs the struck-through pre-discount anchor
            // next to the member price now — the "You save" line is gone
            // (anchor−cadence delta misattributed to the tier; owner
            // directive to remove).
            showSavings={servicesLength === 1 || section?.waveGuardTierEligible !== false}
            showGuarantee={servicesLength === 1}
          />
        ) : null}

        {showGetServiceCta ? <GetServiceTodayCta showGuaranteeMicro slotMeta={ctaSlotMeta} microText={glassCtaMicroFor(sectionSlug)} /> : null}
      </div>

      {afterPrice}

      {showIncludedChecklist ? <IncludedChecklist included={includedItems} /> : null}

      {showAddOns ? (
        <AddOnsBlock
          addOns={current?.addOns || []}
          selectedKeys={selectedAddOns}
          onToggle={(key) => onAddOnToggle(section.key, key)}
          disabled={disabled}
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
  // Staff draft preview (?adminPreview=1 — opened from the estimate tool's
  // "Customer View" / the estimates list's Preview). Makes the /data fetch
  // attach the staff session's Bearer token so the server will serve an
  // UNPUBLISHED draft through this page — the real customer renderer —
  // instead of the diverging legacy SSR preview. Read once; the 3DS param
  // scrub below leaves unrelated params (incl. this one) in place.
  const [adminPreviewRequested] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get('adminPreview') === '1';
    } catch {
      return false;
    }
  });

  const [selected, setSelected] = useState({});
  const [selectedAddOns, setSelectedAddOns] = useState({});
  const [selectedSlotId, setSelectedSlotId] = useState(null);
  // Slot metadata for the glass slot-aware CTAs/tech chip ("Approve — Tue
  // 9:00 AM") — SlotPicker reports it alongside the id; cleared with it.
  const [selectedSlotMeta, setSelectedSlotMeta] = useState(null);
  // Curated Google-review pool for the glass hero proof strip (PR C) —
  // fetch only under the dark launch.
  const featuredReviews = useFeaturedReviews(glassCopyActive(), 12);
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
  // One-time card-on-file hold (dark until ONE_TIME_CARD_HOLD). cardHoldIntent
  // holds the live POST /card-hold-intent response while the capture modal is
  // open; the succeeded SetupIntent id rides to accept via the ref.
  const [cardHoldIntent, setCardHoldIntent] = useState(null);
  const cardHoldSetupIntentIdRef = useRef(null);
  const [slotsRefreshSignal, setSlotsRefreshSignal] = useState(0);
  const [addServiceRequestState, setAddServiceRequestState] = useState({ status: 'idle', message: '' });

  const [countdownSeconds, setCountdownSeconds] = useState(0);
  const countdownRef = useRef(null);
  const selectedRef = useRef({});
  // Only the first /data fetch of a session is a real customer "view"; every
  // later re-fetch (preference/slot/accept refresh) passes ?refresh=1 so the
  // server doesn't inflate view_count / estimate_views. Reset per token.
  const initialViewCountedRef = useRef(false);
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
      // confirmSetup (one-time card hold, 3DS cards) returns with
      // ?setup_intent=...&redirect_status=succeeded — carry it forward so the
      // captured card isn't lost on the redirect and we don't re-mint a hold.
      const siFromRedirect = params.get('setup_intent');
      if (siFromRedirect && params.get('redirect_status') === 'succeeded') {
        cardHoldSetupIntentIdRef.current = siFromRedirect;
      }
      if (piFromRedirect || siFromRedirect) {
        ['payment_intent', 'payment_intent_client_secret', 'setup_intent', 'setup_intent_client_secret', 'redirect_status']
          .forEach((k) => params.delete(k));
        const qs = params.toString();
        window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
      }
    } catch { /* non-fatal */ }
  }, []);

  const services = useMemo(() => pricingServices(data?.pricing), [data]);
  const acceptance = data?.estimate?.acceptance || { mode: 'standard_slot_pick' };
  const existingAppointment = acceptance.mode === 'existing_appointment' ? acceptance.appointment : null;
  // Payment-only accept (guarantee-only renewal): no slot picker, no
  // reservation — accept goes straight to review, then invoice.
  const invoiceOnlyAccept = acceptance.mode === 'invoice_only';
  // Held (site-confirmation) commercial estimate with no linked appointment:
  // no self-servable slots exist (the slots endpoints return the empty
  // commercial-manual list), so the accept CTA renders WITHOUT a slot pick —
  // the team schedules after approval.
  const manualScheduleAccept = acceptance.mode === 'commercial_site_confirmation';
  const selectedFrequency = useMemo(() => selectedPricingFrequencyKey(data?.pricing, services, selected), [data?.pricing, services, selected]);
  // Per-service cadence (bundles): the precomputed combo matching every section's
  // independent selection, plus the non-pest selection map sent on accept.
  const serviceCadenceCombos = useMemo(
    () => (Array.isArray(data?.pricing?.serviceCadenceCombos) ? data.pricing.serviceCadenceCombos : []),
    [data?.pricing],
  );
  // The combo's selection keys are the only INDEPENDENTLY selectable sections
  // (pest + lawn/tree). Any other recurring section (e.g. mosquito, which isn't
  // a combo axis) must mirror the pest cadence and stay locked — otherwise the
  // customer could change it but accept would ignore it (not in serviceCadences).
  const comboAxisKeys = useMemo(
    () => (serviceCadenceCombos.length ? new Set(Object.keys(serviceCadenceCombos[0].selection || {})) : null),
    [serviceCadenceCombos],
  );
  // Combo behavior (independent selection + non-axis locking) applies ONLY when
  // every combo axis is actually rendered as its own section. If the bundle fell
  // back to a single synthetic `bundle` section (split validation failed,
  // pest-only choice, …), combos don't apply to this render — stay fully legacy
  // so the one cadence slider keeps working.
  const comboModeActive = useMemo(
    () => !!comboAxisKeys && Array.from(comboAxisKeys).every((axis) => services.some((s) => s.key === axis)),
    [comboAxisKeys, services],
  );
  const selectedCombo = useMemo(
    () => selectedServiceCadenceCombo(data?.pricing, services, selected),
    [data?.pricing, services, selected],
  );
  const serviceCadences = useMemo(() => {
    if (!serviceCadenceCombos.length) return null;
    const axisKeys = Object.keys(serviceCadenceCombos[0].selection || {}).filter((k) => k !== 'pest_control');
    if (!axisKeys.length) return null;
    const out = {};
    for (const axis of axisKeys) {
      const section = services.find((s) => s.key === axis);
      if (!section) continue;
      const key = selected[section.key] || section.defaultFrequencyKey || section.frequencies?.[0]?.key;
      if (key) out[axis] = key;
    }
    return Object.keys(out).length ? out : null;
  }, [serviceCadenceCombos, services, selected]);
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
    const isRefresh = initialViewCountedRef.current;
    const params = [];
    if (isRefresh) params.push('refresh=1');
    let fetchOpts;
    if (adminPreviewRequested) {
      params.push('adminPreview=1');
      // Same-origin SPA: the staff session token lives in localStorage. An
      // absent/expired token just means the server ignores the preview param
      // and an unpublished draft 404s into the normal "link isn't valid"
      // screen — never an error state.
      const staffToken = localStorage.getItem('waves_admin_token');
      if (staffToken) fetchOpts = { headers: { Authorization: `Bearer ${staffToken}` } };
    }
    const r = await fetch(`${API_BASE}/estimates/${token}/data${params.length ? `?${params.join('&')}` : ''}`, fetchOpts);
    if (r.status === 404) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    if (!r.ok) throw new Error(`estimate fetch failed: ${r.status}`);
    initialViewCountedRef.current = true;
    const body = await r.json();
    // Glass release flag (GATE_ESTIMATE_GLASS): set the module state BEFORE
    // setData so every glassCopyActive() consumer sees it on the render that
    // paints the loaded page. URL ?glass=1/?glass=0 still override.
    setGlassDefault(body.glassDefault === true);
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
    let nextSelected = defaultSelectedForServices(nextServices, selectedRef.current, preserveSelection);
    // For a reopened ACCEPTED estimate, pin the recurring frequency to the one
    // booked (acceptedFrequencyKey) so the read-only recap shows the agreed plan
    // and price, not the section default (quarterly). selectedFrequency and the
    // combined price both derive from `selected`, so seeding it here propagates
    // through the whole recap. Only set for accepted rows (null otherwise).
    const acceptedFreqKey = body?.estimate?.acceptedFrequencyKey;
    if (acceptedFreqKey) {
      nextSelected = { ...nextSelected };
      for (const section of nextServices) {
        if ((section.frequencies || []).some((f) => f.key === acceptedFreqKey)) {
          nextSelected[section.key] = acceptedFreqKey;
        }
      }
    }
    setSelected(nextSelected);
    setSelectedAddOns(selectedAddOnsForServices(nextServices, nextSelected));
  }, [token, adminPreviewRequested]);

  // Verified staff draft preview (server sets this only after checking the
  // staff JWT): show the banner and keep every money/booking action inert —
  // the server would 409 a draft accept anyway (isEstimateAcceptActive), but
  // the preview shouldn't offer actions that can only fail.
  const adminDraftPreview = data?.adminDraftPreview === true;

  // A different estimate token is a fresh session — let its first load count.
  useEffect(() => { initialViewCountedRef.current = false; }, [token]);

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
        setSelectedSlotMeta(null);
        setPaymentPreference(null);
        setSlotsRefreshSignal((v) => v + 1);
      }
    };
    tick();
    countdownRef.current = setInterval(tick, 1000);
    return () => clearInterval(countdownRef.current);
  }, [reservation]);

  const onToggleAddOn = useCallback(async (sectionKey, key) => {
    // Draft preview: PUT /preferences persists into estimate_data, and the
    // server 400s a draft anyway (isEstimateAcceptActive) — but its "no
    // longer active" message reads like a broken draft. Explain instead.
    if (adminDraftPreview) {
      setError('Draft preview — add-on choices are the customer\'s to make once the estimate is sent.');
      return;
    }
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
      // The toggles sit below the schedule card — jump back up so the
      // customer sees the price adjust (owner directive).
      scrollToPriceSection();
    } catch (err) {
      setError(err.message);
      setSelectedAddOns((prev) => {
        const current = prev[sectionKey] || new Set();
        const nextForSection = new Set(current);
        if (nextChecked) nextForSection.delete(key); else nextForSection.add(key);
        return { ...prev, [sectionKey]: nextForSection };
      });
    }
  }, [adminDraftPreview, loadEstimate, selectedAddOns, token]);

  const releaseHeldReservation = useCallback((scheduledServiceId) => {
    if (!scheduledServiceId) return;
    fetch(`${API_BASE}/public/estimates/${token}/reserve/${encodeURIComponent(scheduledServiceId)}`, {
      method: 'DELETE',
    }).catch(() => {});
  }, [token]);

  const handlePaymentChoice = useCallback(async (pref) => {
    // Staff draft preview: every booking path starts here — keep it inert
    // (no reservation, no deposit/card-hold intent) with an explaining error.
    if (adminDraftPreview) {
      setError('Draft preview — this estimate has not been sent yet. Send it to the customer to enable booking.');
      return;
    }
    if (existingAppointment) {
      setPaymentPreference(pref);
      setReservation({ existingAppointmentId: existingAppointment.id });
      setCtaPhase('review');
      setError(null);
      return;
    }
    if (invoiceOnlyAccept) {
      // Nothing to reserve — the synthetic reservation only satisfies the
      // review-phase render gate; accept sends no slot/appointment.
      setPaymentPreference(pref);
      setReservation({ invoiceOnly: true });
      setCtaPhase('review');
      setError(null);
      return;
    }
    if (manualScheduleAccept && serviceMode !== 'one_time') {
      // Held commercial accept: no slot to reserve — the team schedules after
      // approval. The sentinel keeps the review phase rendered (it's gated on
      // a truthy reservation) and tells ReviewPhase to show the manual-
      // scheduling line instead of a slot + countdown. Recurring only: the
      // one-time toggle is hidden for this mode (a one-time card-hold/deposit
      // accept requires a booked appointment that can't exist here).
      setPaymentPreference(pref);
      setReservation({ manualScheduling: true });
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
        setSelectedSlotMeta(null);
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
  }, [adminDraftPreview, existingAppointment, invoiceOnlyAccept, manualScheduleAccept, loadEstimate, releaseHeldReservation, selectedSlotId, serviceMode, selectedFrequency, token]);

  const handleFrequencyChange = useCallback((sectionKey, nextFrequency) => {
    reserveAttemptRef.current += 1;
    // With per-service combos: combo-axis sections (pest + lawn/tree) are
    // INDEPENDENT — only the changed section moves (so sections sharing a tier
    // key, e.g. lawn + tree both having "standard", don't move together). But
    // NON-axis recurring sections (e.g. mosquito) still mirror the pest cadence,
    // so a pest change carries them along (they're locked from direct change).
    // Legacy bundles (no combos) keep the all-share-the-key mirror behavior.
    const affectedSections = comboModeActive
      ? services.filter((section) => (
        section.key === sectionKey
        || (!comboAxisKeys.has(section.key) && section.frequencies?.some((item) => item.key === nextFrequency))
      ))
      : services.filter((section) => (
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
    setSelectedSlotMeta(null);
    setPaymentPreference(null);
    setReservation(null);
    setAcceptResult(null);
    setError(null);
    setCtaPhase('configure');
    setSlotsRefreshSignal((v) => v + 1);
  }, [services, comboAxisKeys, comboModeActive]);

  const performAccept = useCallback(async () => {
    // Defense in depth for the draft preview — handlePaymentChoice already
    // blocks the flow before review, and the server 409s a draft accept.
    if (adminDraftPreview) {
      setError('Draft preview — this estimate has not been sent yet. Send it to the customer to enable booking.');
      return;
    }
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
          serviceCadences: serviceCadences || undefined,
          depositPaymentIntentId: depositPaymentIntentIdRef.current || undefined,
          cardHoldSetupIntentId: cardHoldSetupIntentIdRef.current || undefined,
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
        if (r.status === 402 && body.code === 'CARD_HOLD_REQUIRED') {
          // The captured card couldn't be verified — drop it so the next
          // confirm re-opens the capture modal and mints a fresh SetupIntent.
          cardHoldSetupIntentIdRef.current = null;
          throw new Error(body.error || 'Add a card to hold your appointment to confirm this visit.');
        }
        if (r.status === 409) {
          if (/estimate is no longer active/i.test(body.error || '')) {
            setCtaPhase('configure');
            setReservation(null);
            setSelectedSlotId(null);
            setSelectedSlotMeta(null);
            setPaymentPreference(null);
            await loadEstimate();
            return;
          }
          const expired = /expired|no active reservation/i.test(body.error || '');
          setCtaPhase(expired ? 'reservation_expired' : 'slot_conflict');
          setSlotsRefreshSignal((v) => v + 1);
          setReservation(null);
          setSelectedSlotId(null);
          setSelectedSlotMeta(null);
          setPaymentPreference(null);
          return;
        }
        throw new Error(body.error || `accept failed: ${r.status}`);
      }
      const body = await r.json();
      setAcceptResult(body);
      setCtaPhase('success');
      setReservation(null);
      // Booking-confirmed celebration — visual-only and isolated: the accept
      // has already succeeded, so an animation failure (e.g. a WebView
      // without Element.animate) must never surface as a booking error.
      try {
        fireGlassConfetti(window.innerWidth / 2, window.innerHeight * 0.35);
      } catch { /* visual only */ }
    } catch (err) {
      setError(err.message);
      setCtaPhase('review');
    }
  }, [adminDraftPreview, existingAppointment, loadEstimate, token, selectedSlotId, paymentPreference, serviceMode, selectedFrequency, serviceCadences]);

  // Deposit-gated confirm (flat $49/$99, PR #1660). When the resolved policy
  // requires a deposit and none is collected yet, mint the intent and open
  // the Payment Element modal; accept continues from the modal's onSuccess.
  // Dark-safe: depositPolicy.required is false while ESTIMATE_DEPOSIT_REQUIRED
  // is off, so this falls straight through to performAccept.
  const handleConfirm = useCallback(async () => {
    // One-time card-on-file hold (dark until ONE_TIME_CARD_HOLD). When a card
    // is required to book this one-time visit and none is captured yet, mint
    // the SetupIntent and open the capture modal; accept continues from the
    // modal's onSuccess. Dark-safe: cardHoldPolicy.requiredForOneTime is false
    // while the flag is off, so this falls straight through.
    const cardHoldPolicy = data?.cardHoldPolicy;
    if (serviceMode === 'one_time' && cardHoldPolicy?.requiredForOneTime && !cardHoldSetupIntentIdRef.current) {
      setCtaPhase('submitting');
      setError(null);
      try {
        const r = await fetch(`${API_BASE}/public/estimates/${token}/card-hold-intent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serviceMode, paymentMethodPreference: paymentPreference }),
        });
        const body = await r.json().catch(() => ({}));
        if (r.status === 409 && body.exemptReason) {
          // Policy says no hold owed — fall through to accept.
        } else if (!r.ok) {
          throw new Error(body.error || 'Could not start the card hold. Please try again.');
        } else {
          setCardHoldIntent(body);
          setCtaPhase('review');
          return; // modal takes over; accept continues from onSuccess
        }
      } catch (err) {
        setError(err.message);
        setCtaPhase('review');
        return;
      }
    }
    const depositPolicy = data?.depositPolicy;
    // requiredForOneTime: a site-confirmation-held estimate zeroes `required`
    // (its recurring accept collects nothing) but a one-time switch still owes
    // that mode's deposit — keep consulting /deposit-intent, which re-resolves
    // per mode and 409-exempts when nothing is owed.
    const depositRequired = depositPolicy?.required
      || (serviceMode === 'one_time' && depositPolicy?.requiredForOneTime);
    // Prepay-annual owes the deposit too — it credits against the annual
    // invoice minted at accept; the server accept gate re-verifies either way.
    if (depositRequired && !depositPaymentIntentIdRef.current) {
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

  const handleCardHoldSuccess = useCallback(async (setupIntentId) => {
    cardHoldSetupIntentIdRef.current = setupIntentId;
    setCardHoldIntent(null);
    await performAccept();
  }, [performAccept]);

  const handleCardHoldCancel = useCallback(() => setCardHoldIntent(null), []);

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
    // Draft preview: don't file a real bundle inquiry (it notifies the team)
    // from a staff preview click — show what the customer would get instead.
    if (adminDraftPreview) {
      setAddServiceRequestState({
        status: 'error',
        message: 'Draft preview — customer requests are disabled until the estimate is sent.',
      });
      return;
    }
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
  }, [adminDraftPreview, addServiceOffer, addServiceRequestState.status, token]);

  if (loading) {
    return <Page><Header customerFirstName={null} address={null} /><SkeletonBlock /><SkeletonBlock /></Page>;
  }
  if (notFound || !data) {
    return <Page><NotFoundCard /></Page>;
  }

  const { estimate, pricing, cta } = data;
  const canAccept = cta?.canAccept === true;
  // Review-before-booking (e.g. priced termite trenching) is NOT terminal: the
  // price + Ask-Waves stay visible and only self-booking is gated. A genuine
  // terminal state (accepted/declined/expired/quote_required) always wins.
  const reviewBeforeBooking = cta?.reviewBeforeBooking === true && !cta?.terminalState;
  const showAskBar = !['accepted', 'declined', 'expired'].includes(cta?.terminalState);
  const serviceCategory = estimate?.serviceCategory || (services.length > 1 ? 'bundle' : services[0]?.key) || 'pest_control';
  const copy = estimateCopyFor(serviceCategory);
  // Glass copy pack — null unless glass is active; every service category
  // has a pack now (unknown categories fall back to the property-generic
  // bundle pack), and every use below still falls back to the standard copy
  // when glass is off. `glassContent` alone gates the service-agnostic swaps.
  const glassContent = glassCopyActive();
  const glassPack = glassEstimateCopyFor(serviceCategory);
  const headline = glassPack?.heroH1 || UNIVERSAL_HEADLINE;
  // The server's intelligence.title/body outrank the static copy fallbacks in
  // WaveGuardIntelligenceCard, so the glass headline has to be applied to the
  // intelligence payload itself — metrics/signals/satellite stay untouched.
  const intelligenceDisplay = glassPack && estimate.intelligence
    ? { ...estimate.intelligence, title: glassPack.aiTitle, body: glassPack.aiBody }
    : estimate.intelligence;
  const askChips = glassPack?.askChips || pricing.askChips;
  const headerContactProps = {
    customerFirstName: estimate.customerFirstName,
    customerName: estimate.customerName,
    customerEmail: estimate.customerEmail,
    customerPhone: estimate.customerPhone,
    address: estimate.address,
  };
  const renderFlags = pricing?.renderFlags || {};
  const canShowSlotPicker = acceptance.mode === 'standard_slot_pick';
  // Resolve the tier label unconditionally; whether the badge actually renders
  // is decided by per-section eligibility (server-authoritative
  // section.waveGuardTierEligible — true iff the section covers >=1 WaveGuard
  // service), so an excluded section (palm/rodent) never shows it even alongside
  // an eligible service, and an eligible single service / bundle always can.
  const waveGuardTier = pricing.combinedRecurring?.waveGuardTierLabel || pricing.waveGuardTier || null;
  // The whole-plan tier badge and combined summary show the tier only if any
  // section in the bundle is eligible, so an excluded-only bundle (e.g.
  // palm + rodent) stays badge-free.
  const combinedTierEligible = services.some((s) => s?.waveGuardTierEligible === true);
  // Combined card total reflects EVERY service's chosen cadence: when a combo
  // matches the per-section selections, use its authoritative total; otherwise
  // fall back to the pest-cadence entry (single-cadence / legacy bundles).
  const combinedBaseFrequency = selectedCombinedFrequency(pricing, selectedFrequency);
  const combinedFrequency = selectedCombo
    ? {
      ...combinedBaseFrequency,
      monthly: selectedCombo.monthly,
      annual: selectedCombo.annual,
      perServiceTreatments: selectedCombo.perServiceTreatments ?? combinedBaseFrequency?.perServiceTreatments,
      sameDayTreatmentTotal: selectedCombo.sameDayTreatmentTotal ?? combinedBaseFrequency?.sameDayTreatmentTotal,
    }
    : combinedBaseFrequency;
  // A recurring section that isn't a combo axis (e.g. mosquito when only
  // lawn/tree are independently selectable) mirrors the pest cadence and is
  // locked from direct change — its slider would otherwise let the customer
  // pick a cadence that accept ignores (not in serviceCadences/the combo).
  const isLockedMirrorSection = (section) => (
    comboModeActive && section?.isRecurring && section.key !== 'pest_control' && !comboAxisKeys.has(section.key)
  );
  // Live price for the glass sticky book bar — it must quote exactly what
  // the cards quote. Bundles: combinedFrequency.monthly IS the monthly
  // total CombinedRecurringPriceCard renders as /mo — no cadence multiply.
  // Single service: the cadence price PriceCard renders.
  const stickyBarPrice = (() => {
    const HIDDEN = { label: null, period: null };
    if (services.length > 1) {
      const monthly = combinedFrequency?.monthly;
      if (combinedFrequency?.quoteRequired === true || monthly == null) return HIDDEN;
      // Narrow low-confidence commercial estimates price as a $low–$high
      // RANGE on the cards; a fixed bar quoting one exact number would
      // contradict them mid-booking, so it stays hidden for ranged pricing.
      if (Number(combinedFrequency?.lowConfidenceRangePct) > 0) return HIDDEN;
      return { label: fmtMoney(Math.round(Number(monthly) * 100) / 100), period: '/mo' };
    }
    const src = currentFrequency;
    if (!src || src.quoteRequired === true || src.monthly == null) return HIDDEN;
    if (Number(src.lowConfidenceRangePct) > 0) return HIDDEN;
    const billingKey = src.billingFrequencyKey || src.key;
    const intervalMonths = billingKey === 'quarterly' ? 3 : billingKey === 'bi_monthly' ? 2 : 1;
    const period = billingKey === 'quarterly' ? '/quarter' : billingKey === 'bi_monthly' ? '/bi-monthly' : '/mo';
    return { label: fmtMoney(Math.round(Number(src.monthly) * intervalMonths * 100) / 100), period };
  })();
  const quoteRequiredReason = cta?.quoteRequiredReason || pricing?.quoteRequiredReason || pricing?.quoteRequiredItems?.[0]?.reason || '';
  const isCommercialProposal = cta?.commercialProposal === true || quoteRequiredReason === 'commercial_proposal';
  const proposalPdfEmailed = cta?.proposalPdfEmailed === true;

  // Service/price cards — shared by the live configurator (below) and the
  // read-only recap on an accepted estimate, so reopening an accepted link
  // still shows the services + pricing the customer booked (legacy parity).
  // `readOnly` disables every selector (incl. the add-on toggles) and drops
  // booking-only extras (app-showcase upsell, one-time add-on pickers).
  // `modeOverride` pins the recap to the mode actually accepted — the live
  // `serviceMode` can derive 'recurring' for a one-time acceptance on a mixed
  // estimate, so the accepted recap passes `acceptedServiceMode`.
  const renderQuoteDetailCards = (readOnly = false, modeOverride = null) => {
    const cardsDisabled = readOnly || ctaPhase === 'submitting';
    const mode = modeOverride || serviceMode;
    if (mode === 'recurring') {
      return (
        <>
          {/* Multi-service plans show the WaveGuard tier ONCE, above the
              boxes on the left — not repeated in every card. */}
          {services.length > 1 && waveGuardTier && combinedTierEligible ? (
            <div style={{ marginBottom: 12 }}>
              <span style={{
                display: 'inline-block', padding: '5px 11px',
                background: '#EEF2FF', color: COLORS.blueDeeper,
                borderRadius: 6, fontSize: 14, fontWeight: 700, letterSpacing: '0.02em',
              }}>
                WaveGuard {glassContent ? glassTierDisplay(waveGuardTier) : waveGuardTier}
              </span>
            </div>
          ) : null}

          {/* Multi-service plans stack vertically (owner directive) —
              each service keeps its own boxed price section. */}
          <div>
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
                glassSetupBulletEligible={setupFees.some((fee) => fee?.waivedWithPrepay === true)}
                ctaSlotMeta={glassContent ? selectedSlotMeta : null}
                selectedFrequencyKey={selected[section.key]}
                selectedAddOns={selectedAddOns[section.key] || new Set()}
                onFrequencyChange={handleFrequencyChange}
                onAddOnToggle={onToggleAddOn}
                disabled={cardsDisabled || isLockedMirrorSection(section)}
                renderFlags={renderFlags}
                waveGuardTier={waveGuardTier}
                afterPrice={afterPrice}
                showGetServiceCta={!readOnly && canShowSlotPicker && services.length === 1}
                // Glass removes the customize section everywhere — including
                // this accepted read-only recap (owner directive; the booked
                // add-ons still price into the totals shown).
                showAddOns={readOnly && !glassContent}
              />
            );
          })}
          </div>

          {/* The combined recurring total is the number the invoice/payment
              copy uses — the customer has to see it before approving, so it
              stays even though the per-service boxes each show a price. */}
          {services.length > 1 && renderFlags.showRecurringSummary ? (
            <CombinedRecurringPriceCard
              combined={pricing.combinedRecurring}
              selectedFrequency={combinedFrequency}
              // Tier pill already renders ONCE above the service boxes
              // (owner directive: single WaveGuard pill per bundle).
              waveGuardTier={null}
            />
          ) : null}


          {/* One guarantee line for the whole plan — not one per box. */}
          {services.length > 1 ? (
            <div style={{ textAlign: 'center', fontSize: 16, color: ESTIMATE_TEXT, marginTop: 10, lineHeight: 1.5 }}>
              Try us risk-free — 90-day money-back guarantee.
            </div>
          ) : null}

          {!readOnly && canShowSlotPicker && services.length > 1 ? <GetServiceTodayCta showGuaranteeMicro slotMeta={glassContent ? selectedSlotMeta : null} microText={glassCtaMicroFor(serviceCategory)} /> : null}

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

        </>
      );
    }
    return (
      <>
        <OneTimePriceCard
          oneTimePrice={pricing.anchorOneTimePrice || pricing.oneTimeBreakdown?.total || 0}
          breakdown={pricing.oneTimeBreakdown}
        />
        {!readOnly && canShowSlotPicker ? <GetServiceTodayCta slotMeta={glassContent ? selectedSlotMeta : null} /> : null}
        <OneTimeBreakdownCard breakdown={pricing.oneTimeBreakdown} />
        {!readOnly && !glassContent && renderFlags.showOneTimePestAddOns === true ? (
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
    );
  };

  if (!canAccept && !reviewBeforeBooking) {
    // An accepted estimate keeps a read-only recap of the booked services +
    // pricing below the banner (legacy parity) so the customer/bookkeeper can
    // reopen the link and see what they agreed to. Gate on a STORED accepted
    // mode: pre-column legacy accepts have none, and deriving mode/frequency
    // from the live configurator default could misrepresent a one-time or
    // non-default-frequency booking — better to show just the terminal card
    // than a wrong recap. (New accepts always persist it.) Declined/expired
    // keep just the terminal card too.
    const showAcceptedRecap = cta.terminalState === 'accepted' && !!estimate.acceptedServiceMode;
    return (
      <Page>
        {adminDraftPreview ? <DraftPreviewBanner /> : null}
        <Header
          {...headerContactProps}
          serviceLabel={getServiceLabel(
            currentFrequency,
            estimate,
            pricing,
            cta.terminalState === 'accepted' ? estimate.acceptedServiceMode || null : null,
          )}
          headline={headline}
          eyebrowOverride={glassPack?.eyebrow || null}
        />
        <MembershipCard membership={estimate.membership} />
        <WaveGuardIntelligenceCard intelligence={intelligenceDisplay} address={estimate.address} copy={copy} showYourWork={data.showYourWork || null} />
        {showAskBar ? (
          <EstimateAskBar
            token={token}
            askToken={estimate.askToken}
            selectedFrequency={selectedFrequency}
            serviceMode={serviceMode}
            chips={askChips}
          />
        ) : null}
        <TerminalStateCard
          state={cta.terminalState}
          customerFirstName={estimate.customerFirstName}
          address={estimate.address}
          quoteReason={quoteRequiredReason}
          isProposal={isCommercialProposal}
          proposalPdfEmailed={proposalPdfEmailed}
          // Booked + upcoming visit → show the date, not "we'll follow up".
          appointmentLabel={cta.terminalState === 'accepted' && existingAppointment
            ? formatAppointmentLabel(existingAppointment)
            : null}
          appointmentServiceType={cta.terminalState === 'accepted' ? existingAppointment?.serviceType || null : null}
        />
        {showAcceptedRecap ? renderQuoteDetailCards(true, estimate.acceptedServiceMode || serviceMode) : null}
        <AppShowcaseCard />
        <CustomerReviews />
        <GuaranteeStrip licenseNumber={estimate.licenseNumber} />
      </Page>
    );
  }

  if (ctaPhase === 'success') {
    return (
      <Page>
        <Header
          {...headerContactProps}
          serviceLabel={getServiceLabel(currentFrequency, estimate, pricing, serviceMode)}
          headline={headline}
          eyebrowOverride={glassPack?.eyebrow || null}
        />
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
      <WaveGuardIntelligenceCard intelligence={intelligenceDisplay} address={estimate.address} copy={copy} showYourWork={data.showYourWork || null} />
      <EstimateAskBar
        token={token}
        askToken={estimate.askToken}
        selectedFrequency={selectedFrequency}
        serviceMode={serviceMode}
        chips={askChips}
      />
      <EstimateAddServiceRequestCard
        offer={addServiceOffer}
        requestState={addServiceRequestState}
        onRequest={handleAddServiceRequest}
      />
    </>
  );

  // Review-before-booking (priced termite trenching): the price cards + Waves AI
  // panel + Ask bar all stay visible — this is NOT quoteRequired — but the slot
  // picker / payment CTAs are replaced by the review card, mirroring the
  // server-rendered page. Without this branch, !canAccept fell through to
  // TerminalStateCard's null-state default and told the customer their quote
  // had expired.
  if (reviewBeforeBooking) {
    return (
      <Page>
        {adminDraftPreview ? <DraftPreviewBanner /> : null}
        <Header
          {...headerContactProps}
          serviceLabel={getServiceLabel(currentFrequency, estimate, pricing)}
          headline={headline}
          eyebrowOverride={glassPack?.eyebrow || null}
          subline={glassPack?.heroSub || null}
        />
        {renderQuoteDetailCards(true)}
        {aiPanelBlock}
        <ReviewBeforeBookingCard reason={cta?.reviewReason} />
        <AppShowcaseCard />
        <CustomerReviews />
        <GuaranteeStrip licenseNumber={estimate.licenseNumber} />
      </Page>
    );
  }

  return (
    <Page>
      {adminDraftPreview ? <DraftPreviewBanner /> : null}
      <Header
        {...headerContactProps}
        serviceLabel={getServiceLabel(currentFrequency, estimate, pricing)}
        headline={headline}
        eyebrowOverride={glassPack?.eyebrow || null}
        // The booking-forward subline only belongs where booking is still on
        // the table — terminal and success states keep the plain hero.
        subline={glassPack?.heroSub || null}
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
                disabled={adminDraftPreview}
                serviceMode={serviceMode}
                setupFee={pricing.setupFee || null}
                annualPrepayEligible={pricing.annualPrepayEligible === true}
                invoiceMode={!!estimate.billByInvoice}
                siteConfirmationHold={!!estimate.siteConfirmationHold}
                selectedFrequency={combinedFrequency}
                cardHold={data?.cardHoldPolicy || null}
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
            invoiceOnly={invoiceOnlyAccept}
            siteConfirmationHold={!!estimate.siteConfirmationHold}
            manualScheduling={!!reservation?.manualScheduling}
            serviceMode={serviceMode}
            depositNote={serviceMode === 'one_time' && data?.cardHoldPolicy?.requiredForOneTime
              ? `A card on file holds your visit — not charged today. We charge the final total after completion; a ${fmtMoney(data.cardHoldPolicy.noShowFeeAmount)} fee applies only if you cancel within ${data.cardHoldPolicy.cancelWindowHours} hours or aren't home. Credit cards add a small processing fee; debit and bank cards don't.`
              : ((data?.depositPolicy?.required || (serviceMode === 'one_time' && data?.depositPolicy?.requiredForOneTime))
                ? (invoiceOnlyAccept
                  ? `A ${fmtMoney(data.depositPolicy.oneTimeAmount)} deposit is due today — it is applied to your invoice.`
                  : paymentPreference === 'prepay_annual'
                    ? `A ${fmtMoney(data.depositPolicy.recurringAmount)} deposit is due today to hold your spot — it is applied to your annual prepay invoice.`
                    : `A ${fmtMoney(serviceMode === 'one_time' ? data.depositPolicy.oneTimeAmount : data.depositPolicy.recurringAmount)} deposit is due today to hold your spot — it is applied to your first invoice.`)
                : null)}
          />
          {depositIntent ? (
            <DepositModal
              intent={depositIntent}
              onSuccess={handleDepositSuccess}
              onCancel={handleDepositCancel}
              creditTarget={paymentPreference === 'prepay_annual' ? 'your annual prepay invoice' : 'your first invoice'}
            />
          ) : null}
          {cardHoldIntent ? (
            <CardHoldModal
              intent={cardHoldIntent}
              onSuccess={handleCardHoldSuccess}
              onCancel={handleCardHoldCancel}
            />
          ) : null}
          {aiPanelBlock}
        </>
      ) : (
        <>
          {/* One-time mode toggle — only rendered when admin opted this
              estimate into the one-time option AND there's a non-zero
              one-time price to offer. Default mode is 'recurring' so
              estimates without the flag behave identically to before.
              Hidden for the no-slot (site-confirmation) commercial mode: its
              ranged price is a recurring concept, and a one-time accept there
              dead-ends — no slots exist, and the one-time card-hold/deposit
              gates require a booked appointment the customer can't pick. */}
          {!estimate.isOneTimeOnly && !manualScheduleAccept && estimate.showOneTimeOption && (pricing.anchorOneTimePrice || 0) > 0 ? (
            <OneTimeModeToggle
              mode={serviceMode}
              oneTimePrice={pricing.anchorOneTimePrice}
              onChange={(m) => {
                reserveAttemptRef.current += 1;
                setServiceMode(m);
                // Reset selection state that doesn't apply in the other mode
                setSelectedSlotId(null);
                setSelectedSlotMeta(null);
                setPaymentPreference(null);
                setReservation(null);
                setAcceptResult(null);
                setError(null);
                setCtaPhase('configure');
                setSlotsRefreshSignal((v) => v + 1);
              }}
            />
          ) : null}

          {/* Glass (PR C): proof before price — continuous five-star ticker. */}
          {glassContent ? <GlassProofStrip reviews={featuredReviews} /> : null}

          <div id={PRICE_SECTION_ID}>
            {renderQuoteDetailCards()}
          </div>

          {/* Waves AI panel + Ask bar render AFTER the price/plan (matches the
              server-rendered estimate's order: price → Waves AI → booking) so
              the customer sees the price first. Glass reorders per the
              approved section positioning (schedule directly after price;
              why-price-custom, reviews, app, Ask, and the lawn upsell follow
              below) — only the membership card keeps this spot. */}
          {glassContent ? <MembershipCard membership={estimate.membership} /> : aiPanelBlock}

          <div id={BOOKING_SECTION_ID}>
            {canShowSlotPicker ? (
              <SlotPicker
                token={token}
                askToken={estimate.askToken}
                selectedSlotId={selectedSlotId}
                onSelect={setSelectedSlotId}
                onSelectMeta={setSelectedSlotMeta}
                selectedSlotFallbackMeta={selectedSlotMeta}
                licenseNumber={estimate.licenseNumber}
                refreshSignal={slotsRefreshSignal}
                serviceMode={serviceMode}
                selectedFrequency={selectedFrequency}
              />
            ) : (
              <AcceptanceModeCard acceptance={acceptance} />
            )}
          </div>

          {/* Pest visit-preference toggles ("Skip parts you don't need")
              live BELOW the schedule card (owner directive). Glass removes
              the customize section entirely — zero lifetime toggle clicks
              (owner directive); pre-checked defaults still apply. */}
          {serviceMode === 'recurring' && !glassContent && renderFlags.showPestRecurringAddOns === true
            ? services
              .filter((section) => section.isPest && section.isRecurring)
              .map((section) => {
                const frequency = selectedFrequencyForSection(section, selected);
                const addOns = Array.isArray(frequency?.addOns) ? frequency.addOns : [];
                if (!addOns.length) return null;
                return (
                  <AddOnsBlock
                    key={`${section.key}-visit-prefs`}
                    addOns={addOns}
                    selectedKeys={selectedAddOns[section.key] || new Set()}
                    onToggle={(key) => onToggleAddOn(section.key, key)}
                    disabled={ctaPhase === 'submitting'}
                  />
                );
              })
            : null}

          {existingAppointment ? (
            <ExistingAppointmentCard appointment={existingAppointment} />
          ) : null}

          {(existingAppointment || invoiceOnlyAccept || (canShowSlotPicker && selectedSlotId) || (manualScheduleAccept && serviceMode !== 'one_time')) ? (
            <PaymentPreferenceButtons
              onSelect={handlePaymentChoice}
              // Draft preview: dead from first render (Codex rd 1), not just
              // guarded on click — but rendered, so staff still see the exact
              // payment options the customer will get. Forcing cta.canAccept
              // false server-side would fall through to the null-terminal
              // "expired" card and destroy the preview's purpose.
              disabled={adminDraftPreview || ctaPhase === 'submitting'}
              serviceMode={serviceMode}
              setupFee={pricing.setupFee || null}
              annualPrepayEligible={pricing.annualPrepayEligible === true}
              invoiceMode={!!estimate.billByInvoice}
              invoiceOnly={invoiceOnlyAccept}
              siteConfirmationHold={!!estimate.siteConfirmationHold}
              selectedFrequency={combinedFrequency}
              cardHold={data?.cardHoldPolicy || null}
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

          {/* Glass-ordered tail (approved section positioning): why-price-
              custom with its lock-in CTA, reviews with the join CTA, the app
              section, Ask, then the lawn upsell — replaces both the
              aiPanelBlock spot above and the shared tail below. */}
          {glassContent ? (
            <>
              <WaveGuardIntelligenceCard
                intelligence={intelligenceDisplay}
                address={estimate.address}
                copy={copy}
                showYourWork={data.showYourWork || null}
                lockInCta={canShowSlotPicker
                  ? <GlassSectionCta label="This price fits my home — lock it in →" onClick={scrollToBookingSection} />
                  : null}
              />
              <CustomerReviews onJoinNeighbors={canShowSlotPicker ? scrollToBookingSection : null} />
              <AppShowcaseCard onBookToday={canShowSlotPicker ? scrollToBookingSection : null} />
              <EstimateAskBar
                token={token}
                askToken={estimate.askToken}
                selectedFrequency={selectedFrequency}
                serviceMode={serviceMode}
                chips={askChips}
              />
              <EstimateAddServiceRequestCard
                offer={addServiceOffer}
                requestState={addServiceRequestState}
                onRequest={handleAddServiceRequest}
              />
            </>
          ) : null}
        </>
      )}

      {/* During slot review the booking section isn't rendered, so the app
          card's "Book today!" would scroll nowhere — drop it for that phase.
          The glass configure branch renders app + reviews in its own ordered
          tail above, so only the contact hatch + guarantee remain here. */}
      {glassContent && !(ctaPhase === 'review' && reservation) ? null : (
        <>
          <AppShowcaseCard onBookToday={canShowSlotPicker && !(ctaPhase === 'review' && reservation) ? scrollToBookingSection : null} />
          <CustomerReviews />
        </>
      )}
      <QuestionsEscapeHatch estimateSlug={estimate.slug} />
      <GuaranteeStrip licenseNumber={estimate.licenseNumber} />

      {/* Sticky mobile book bar (glass, ≤640px via CSS): live price/period +
          slot-aware approve. Configure phase only — during slot review it
          would cover the confirm/cancel buttons. */}
      {glassContent && canShowSlotPicker && serviceMode === 'recurring' && !(ctaPhase === 'review' && reservation) ? (
        <GlassStickyBookBar
          priceLabel={stickyBarPrice.label}
          periodLabel={stickyBarPrice.period}
          slotMeta={selectedSlotMeta}
          onApprove={scrollToBookingSection}
        />
      ) : null}
    </Page>
  );
}
