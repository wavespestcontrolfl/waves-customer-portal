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
import { CUSTOMER_SURFACE } from '../theme-customer';
import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import BrandFooter from '../components/BrandFooter';
import PriceCard from '../components/estimate/PriceCard';
import AddOnsBlock from '../components/estimate/AddOnsBlock';
import SlotPicker from '../components/estimate/SlotPicker';
import PaymentPreferenceButtons, { CARD_SURCHARGE_DISCLOSURE } from '../components/estimate/PaymentPreferenceButtons';
import { CARD_CONSENT_TEXT } from '../lib/paymentMethodConsentText';
import CustomerReviews from '../components/estimate/CustomerReviews';
import AppShowcaseCard from '../components/estimate/AppShowcaseCard';
import DocumentActionBar from '../components/DocumentActionBar';
import GoogleProfilesCard from '../components/estimate/GoogleProfilesCard';
import EstimateGlassTheme, { fireGlassConfetti } from '../components/estimate/glass/EstimateGlassTheme';

// Payment Element renders inside Stripe's iframe, so the glass theme can't
// restyle it via CSS — when the theme is mounted the modals pass brand-tuned
// appearance variables instead. Visual-only, applied whenever the glass theme is mounted.
const glassAppearanceActive = () => document.documentElement.hasAttribute('data-glass-theme');
import { estimateCard, estimateInnerBox } from '../components/estimate/cardStyles';
import TerminalStateCard from '../components/estimate/TerminalStateCard';
import { estimateCopyFor } from '../lib/estimate-copy';
import {
  glassCopyActive,
  glassCtaMicroForKeys,
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
  GlassFrequencyPills,
} from '../components/estimate/glass/GlassEstimateExtras';
import { quoteRequiredReasonNote, quoteRequiredReasonText } from '../lib/quoteDisplay';
import { loadStripeSdk } from '../lib/stripeLoader';
import useModalFocus from '../hooks/useModalFocus';
import { fmtMoney, fmtMoneySigned } from '../lib/money';
import { formatETDate } from '../lib/timezone';
import { PRICE_FONT, W, waveGuardChipStyle } from '../components/estimate/tokens';
import { DOC_COLUMN_MAX, DOC_FONT, docTransition } from '../theme-doc';

const FONT_BODY = DOC_FONT; // the one customer body stack (theme-doc alias)
const API_BASE = import.meta.env.VITE_API_URL || '/api';
const WAVES_PHONE_DISPLAY = '(941) 297-5749';
const WAVES_PHONE_TEL = '+19412975749';
const ESTIMATE_BG = CUSTOMER_SURFACE.page;
const ESTIMATE_BORDER = CUSTOMER_SURFACE.border;
// muted was gray-500 #6B7280 here while the portal used slate-600 #475569 —
// same constant name, drifted value. Normalized to the portal gray.
const ESTIMATE_MUTED = CUSTOMER_SURFACE.muted;
const ESTIMATE_TEXT = CUSTOMER_SURFACE.text;
const ESTIMATE_BODY = CUSTOMER_SURFACE.body;
const ESTIMATE_CHROME = CUSTOMER_SURFACE.chrome;
const ESTIMATE_BUTTON_BG = COLORS.glassNavy;

// THE estimate primary CTA (modal pay/confirm buttons + success links) —
// hoisted so the repeated inline copies can't drift (doc-style unify).
// NOTE: deliberately NOT theme-doc docButton — estimate buttons are a
// different anatomy (16px vertical padding, not minHeight 48).
const estimateCtaStyle = {
  padding: '16px 20px', background: ESTIMATE_BUTTON_BG, color: COLORS.white,
  border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 600, cursor: 'pointer',
};
// Quiet outline secondary ("Not now" / "Go back") — same dedupe.
const estimateSecondaryCtaStyle = {
  padding: '12px 20px', background: 'transparent', color: ESTIMATE_BODY,
  border: `1px solid ${ESTIMATE_BORDER}`, borderRadius: 12, fontSize: 14, fontWeight: 500, cursor: 'pointer',
};
// Call-Waves anchor CTA (AcceptanceModeCard / ReviewBeforeBookingCard).
const estimateCallCtaStyle = {
  display: 'inline-block', marginTop: 16, padding: '12px 20px',
  background: ESTIMATE_BUTTON_BG, color: COLORS.white, borderRadius: 10,
  textDecoration: 'none', fontSize: 14, fontWeight: 700,
};

// Universal hero headline (owner directive 2026-07-03). The eyebrow line
// ("Your estimate · <quoted services>") carries the service specifics, so
// the headline itself never has to guess at per-service phrasing — and can
// never invite a "choose your option" on an estimate with nothing to choose.
const UNIVERSAL_HEADLINE = 'Hello {first}, your estimate is ready!';

// Hero follows the CTA state (estimate audit 2026-07-07, finding #5): a
// terminal page must not promise "your plan is ready!" above a call-us /
// booked / declined card. Status statements only — no service claims, so
// they're category-safe without per-pack copy. A null eyebrow falls back
// to the standard "Your estimate · {service}" kicker.
const TERMINAL_HERO = {
  accepted: { h1: 'Hello {first}, your plan is booked!', eyebrow: 'Your Waves plan' },
  quote_required: { h1: 'Hello {first}, your custom quote is in the works.', eyebrow: 'Your custom quote' },
  declined: { h1: "Hello {first}, here's your Waves estimate.", eyebrow: null },
  expired: { h1: "Hello {first}, here's your Waves estimate.", eyebrow: null },
};

// Small uppercase section kicker — same treatment as "How often?" /
// "Customize your visit" so every card opens with a matching subheader.
const SECTION_KICKER_STYLE = {
  fontSize: 12,
  fontWeight: 700,
  color: ESTIMATE_MUTED,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  marginBottom: 8,
};

const BOOKING_SECTION_ID = 'estimate-booking-section';
const PRICE_SECTION_ID = 'estimate-price-section';
const PAYMENT_SECTION_ID = 'estimate-payment-section';
const REVIEW_SECTION_ID = 'estimate-review-section';

function scrollToPriceSection() {
  const el = typeof document !== 'undefined' ? document.getElementById(PRICE_SECTION_ID) : null;
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function scrollToBookingSection() {
  const el = typeof document !== 'undefined' ? document.getElementById(BOOKING_SECTION_ID) : null;
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Once a slot is picked the approve CTAs land on the payment step (the actual
// next action) instead of the top of the slot list — scrolling to the slot
// list leaves the payment card below the fold, still opacity-0 under the
// glass scroll-reveal, and the tap reads as doing nothing. Falls back to the
// booking section when the payment card isn't mounted (no slot picked yet).
function scrollToPaymentSection() {
  if (typeof document === 'undefined') return;
  const el = document.getElementById(PAYMENT_SECTION_ID);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  else scrollToBookingSection();
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
        onClick={slotMeta ? scrollToPaymentSection : scrollToBookingSection}
        style={{
          minHeight: 44,
          minWidth: 220,
          padding: '0 24px',
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
        <div style={{ marginTop: 12, fontSize: 14, color: ESTIMATE_MUTED, textAlign: 'center', lineHeight: 1.5 }}>
          {microText || GLASS_COPY.ctaMicro}
        </div>
      ) : null}
    </div>
  );
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

// Which report the showcase card sells (owner ask 2026-07-09): lawn-only
// estimates get the lawn report (health score + turf trends); any mix with
// pest/mosquito keeps the pest report with the tech recap video front and
// center.
//
// Deliberately NOT serviceKeysForEstimateSection: that helper scans marketing
// copy (labels, descriptions, included lines) for substrings, which is the
// right bias for estimateAddServiceOffer (never offer a service the customer
// arguably has) but wrong here — the lawn program's own included line
// "Chinch, sod webworm & turf pest response" would classify every lawn-only
// estimate as pest. Only structural identity fields decide the variant.
export function reportShowcaseVariantForServices(services = []) {
  const keys = new Set();
  const collectId = (id) => {
    const text = String(id || '').toLowerCase();
    if (!text) return;
    if (text.includes('pest')) keys.add('pest_control');
    if (text.includes('lawn')) keys.add('lawn_care');
    if (text.includes('mosquito')) keys.add('mosquito');
  };
  (Array.isArray(services) ? services : []).forEach((section) => {
    if (!section || typeof section !== 'object') return;
    if (section.isPest) keys.add('pest_control');
    [section.key, section.service, section.serviceKey].forEach(collectId);
    (Array.isArray(section.memberKeys) ? section.memberKeys : []).forEach(collectId);
    (Array.isArray(section.frequencies) ? section.frequencies : []).forEach((frequency) => {
      collectId(frequency?.serviceCategory);
    });
  });
  return keys.has('lawn_care') && !keys.has('pest_control') && !keys.has('mosquito')
    ? 'lawn'
    : 'pest';
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

// Liquid-glass theme — now unconditional on every estimate (the old page was
// retired at 100% rollout). Only the marketing COPY stays category-scoped via
// glassCopyActive(); the visual theme mounts for all estimates.
function Page({ children }) {
  return (
    <div style={{
      minHeight: '100vh', background: ESTIMATE_BG,
      fontFamily: FONT_BODY, color: COLORS.navy,
      display: 'flex', flexDirection: 'column',
    }}>
      <EstimateGlassTheme active />
      {/* Page-local phone/logo bar removed — the WavesShell top bar (App.jsx
          gateway wrap, owner 2026-07-06) provides the standard chrome. */}
      {/* Bottom padding: minimal — the pre-footer newsletter card is the
          buffer under the last content card now (owner 2026-07-09: "close
          the gap"), and it also gives the floating book bar something
          non-critical to overlap at full scroll. */}
      <div style={{ flex: 1, padding: '32px 20px 8px', maxWidth: DOC_COLUMN_MAX, width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
        {children}
      </div>
      {/* Newsletter signup lives only on the newsletter pages (owner 2026-07-09). */}
      {/* Standard footer on estimates too (owner 2026-07-06) — same identity/
          contact/socials/app-badge stack as every other customer page. */}
      <BrandFooter />
    </div>
  );
}

function SkeletonBlock({ minHeight = null }) {
  return (
    <div style={estimateCard(minHeight ? { minHeight } : {})}>
      <div style={{ height: 12, width: 120, background: ESTIMATE_CHROME, borderRadius: 6 }} />
      <div style={{ height: 32, width: '60%', background: ESTIMATE_CHROME, borderRadius: 6, marginTop: 16 }} />
      <div style={{ height: 14, width: '40%', background: ESTIMATE_CHROME, borderRadius: 6, marginTop: 12 }} />
    </div>
  );
}

// Loading-state stand-in for the hero's data-dependent tail (subline, four
// contact lines, estimate#/dates) — without it the loaded hero grows ~200px
// when /data lands and everything below jumps (CLS 0.259, estimate audit
// 2026-07-07). Bar sizes approximate the real line boxes; the goal is that
// the swap moves content by pixels, not viewports.
function HeaderTailSkeleton() {
  return (
    <div aria-hidden="true" style={{ padding: '0 0 24px' }}>
      <div style={{ height: 16, width: '90%', maxWidth: 480, background: ESTIMATE_CHROME, borderRadius: 6 }} />
      <div style={{ height: 16, width: '72%', maxWidth: 400, background: ESTIMATE_CHROME, borderRadius: 6, marginTop: 8 }} />
      <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
        {[120, 180, 140, 220].map((w) => (
          <div key={w} style={{ height: 14, width: w, background: ESTIMATE_CHROME, borderRadius: 6 }} />
        ))}
      </div>
      <div style={{ height: 15, width: 260, maxWidth: '85%', background: ESTIMATE_CHROME, borderRadius: 6, marginTop: 12 }} />
    </div>
  );
}

// extensionEligible comes from the /data 404 body: the server only sets it
// when the token maps to a real, published estimate that died of expiry (and
// the GATE_ESTIMATE_EXTENSION_REQUEST gate is on) — so garbage URLs never
// grow a button that can only fail. First click self-serves a 7-day
// extension (the server texts the refreshed link too); once the lifetime
// auto-grant is used, later clicks just notify the office. onExtended lets
// the parent re-fetch /data — the link is live again after an auto-grant.
function NotFoundCard({ token = null, extensionEligible = false, onExtended = null }) {
  // idle | sending | extended | requested | failed. Terminal states render
  // even if a parent re-fetch flips extensionEligible off (a successful
  // auto-grant makes the estimate viewable again, which does exactly that).
  const [requestState, setRequestState] = useState('idle');
  const [newExpiresAt, setNewExpiresAt] = useState(null);
  // The server reports whether the estimate_extended SMS/email actually went
  // out (no phone or email on file / opt-out / suppression / gates / template
  // inactive all block them) — only claim channels that really fired.
  const [smsSent, setSmsSent] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  const requestExtension = async () => {
    if (requestState !== 'idle' && requestState !== 'failed') return;
    setRequestState('sending');
    try {
      const r = await fetch(`${API_BASE}/estimates/${token}/extension-request`, { method: 'POST' });
      if (!r.ok) throw new Error(`extension_request_failed_${r.status}`);
      const body = await r.json().catch(() => ({}));
      if (body.autoExtended === true) {
        setNewExpiresAt(body.expiresAt || null);
        setSmsSent(body.smsSent === true);
        setEmailSent(body.emailSent === true);
        setRequestState('extended');
      } else {
        setRequestState('requested');
      }
    } catch {
      setRequestState('failed');
    }
  };

  const freshLinkSentence = smsSent && emailSent
    ? ' We also texted and emailed you a fresh link.'
    : smsSent
      ? ' We also texted you a fresh link.'
      : emailSent
        ? ' We also emailed you a fresh link.'
        : '';

  // ET, matching the SMS and every other estimate-expiry surface — a
  // West-Coast browser must not show a "through" date a day earlier than
  // the deadline the text message quotes.
  const expiryLabel = newExpiresAt
    ? new Date(newExpiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' })
    : null;

  // A granted extension flips the whole card's story: the estimate is live
  // again, so the "unavailable / call us" framing would contradict the
  // outcome the customer just got.
  const extendedNow = requestState === 'extended';

  return (
    <div style={estimateCard({ padding: 32, textAlign: 'center', marginTop: 40 })}>
      <div style={{ fontSize: 34 }}></div>
      <div style={{ fontSize: 18, fontWeight: 600, marginTop: 8 }}>
        {extendedNow ? "You're all set" : 'Estimate unavailable'}
      </div>
      {!extendedNow ? (
        <div style={{ fontSize: 16, color: ESTIMATE_BODY, marginTop: 12, lineHeight: 1.5 }}>
          This link may have expired or isn't valid. Call us at{' '}
          <a href={`tel:${WAVES_PHONE_TEL}`} style={{ color: COLORS.blueDark }}>{WAVES_PHONE_DISPLAY}</a>{' '}
          and we'll get you sorted.
        </div>
      ) : null}
      {token && (extensionEligible || requestState !== 'idle') ? (
        requestState === 'extended' ? (
          <>
            <div style={{ fontSize: 16, color: ESTIMATE_BODY, marginTop: 12, lineHeight: 1.5 }}>
              Your estimate has been extended{expiryLabel ? ` through ${expiryLabel}` : ' by 7 days'}.
              {freshLinkSentence}
            </div>
            {onExtended ? (
              <button
                type="button"
                onClick={onExtended}
                style={{
                  minHeight: 48,
                  border: 0,
                  borderRadius: 10,
                  padding: '0 24px',
                  marginTop: 16,
                  background: ESTIMATE_BUTTON_BG,
                  color: COLORS.white,
                  fontSize: 15,
                  fontWeight: 800,
                  cursor: 'pointer',
                }}
              >
                View your estimate
              </button>
            ) : null}
          </>
        ) : requestState === 'requested' ? (
          <div style={{ fontSize: 15, color: ESTIMATE_BODY, marginTop: 20, lineHeight: 1.5, fontWeight: 600 }}>
            Request sent — we've let our office know you'd like more time on this estimate. We'll reach out shortly.
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={requestExtension}
              disabled={requestState === 'sending'}
              style={{
                minHeight: 48,
                border: 0,
                borderRadius: 10,
                padding: '0 24px',
                marginTop: 20,
                background: ESTIMATE_BUTTON_BG,
                color: COLORS.white,
                fontSize: 15,
                fontWeight: 800,
                cursor: requestState === 'sending' ? 'not-allowed' : 'pointer',
                opacity: requestState === 'sending' ? 0.8 : 1,
              }}
            >
              {requestState === 'sending' ? 'Extending…' : 'Request an extension'}
            </button>
            {requestState === 'failed' ? (
              <div style={{ fontSize: 14, color: ESTIMATE_BODY, marginTop: 10, lineHeight: 1.5 }}>
                We couldn't extend that just now — give us a call and we'll get it done over the phone.
              </div>
            ) : null}
          </>
        )
      ) : null}
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

function Header({ customerFirstName, customerName, customerEmail, customerPhone, address, serviceLabel, headline, eyebrowOverride = null, subline = null, createdAt = null, expiresAt = null, slug = null }) {
  const firstName = customerFirstName || 'there';
  const headlineText = String(headline || UNIVERSAL_HEADLINE).replace('{first}', firstName);
  const phoneDisplay = formatCustomerPhone(customerPhone);
  // Name leads the contact block in the headline's own color (owner ask
  // 2026-07-09, live review screen); email/phone/address follow in the same
  // face at body size — no more uppercase caption treatment.
  const nameLine = String(customerName || '').trim();
  const contactLines = [
    customerEmail,
    phoneDisplay,
    address,
  ].map((line) => String(line || '').trim()).filter(Boolean);
  // Estimate issue + expiration dates (owner ask 2026-07-06). Invalid or
  // absent timestamps render nothing rather than "Invalid Date". ET-pinned:
  // SMS/email/PDF and the server-rendered page all stamp these dates in
  // Eastern time, so a browser in another timezone must not show a
  // different calendar day (codex P1, PR #2439).
  const fmtDate = (value) => {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime())
      ? null
      : formatETDate(d, { month: 'long', day: 'numeric', year: 'numeric' });
  };
  const issuedDisplay = fmtDate(createdAt);
  const expiresDisplay = fmtDate(expiresAt);
  return (
    <div style={{ padding: '8px 0 24px' }}>
      <div style={{ ...HEADER_EYEBROW_STYLE, marginBottom: 8 }}>
        {/* The glass eyebrow carries the plan framing itself, so it drops the
            "· {service}" suffix instead of stacking both. */}
        {eyebrowOverride || `Your estimate${serviceLabel ? ` · ${serviceLabel}` : ''}`}
      </div>
      <h1 style={{
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
        <p style={{ margin: '16px 0 0', fontSize: 16, color: ESTIMATE_BODY, lineHeight: 1.5, maxWidth: '62ch' }}>
          {subline}
        </p>
      ) : null}
      {(nameLine || contactLines.length) ? (
        /* One uniform block (owner 2026-07-09): email/phone/address align
           with the name — same face, size, weight, and color. data-gt="" on
           every line: the glass auto-tier tags small text as caption/fine
           and uppercases short names as eyebrows, which split this block
           across different faces — the block styles itself. */
        /* Slightly tighter + smaller than the 07-09 pass (owner ask
           2026-07-10): 17px/gap-4 read too heavy against the new
           per-application price cards. */
        <div style={{ marginTop: 14, display: 'grid', gap: 2 }}>
          {[nameLine, ...contactLines].filter(Boolean).map((line) => (
            <div key={line} data-gt="" style={{ fontSize: 15, fontWeight: 600, color: ESTIMATE_TEXT, lineHeight: 1.35 }}>{line}</div>
          ))}
        </div>
      ) : null}
      {(slug || issuedDisplay || expiresDisplay) ? (
        /* Estimate # + expiration directly under the contact block on every
           estimate (owner ask 2026-07-09; supersedes the 07-07 "Estimate
           {slug} · dates" line format). Body size — the expiry is
           action-relevant and must not carry the page's lowest emphasis. */
        <div style={{ marginTop: 12, fontSize: 14, lineHeight: 1.5 }}>
          {slug ? (
            <strong data-gt="" style={{ display: 'block', color: ESTIMATE_TEXT, fontWeight: 600 }}>Estimate #: {slug}</strong>
          ) : null}
          {issuedDisplay ? (
            <strong data-gt="" style={{ display: 'block', color: ESTIMATE_TEXT, fontWeight: 600 }}>Estimate issued: {issuedDisplay}</strong>
          ) : null}
          {expiresDisplay ? (
            <strong data-gt="" style={{ display: 'block', color: ESTIMATE_TEXT, fontWeight: 600 }}>Estimate expiration: {expiresDisplay}</strong>
          ) : null}
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
      <div style={{ marginBottom: 12 }}>
        <div style={SECTION_KICKER_STYLE}>
          {intelligence.eyebrow || copy?.aiEyebrow || 'Waves AI'}
        </div>
        <h2 style={{
          fontFamily: FONTS.serif,
          fontSize: 24,
          fontWeight: 500,
          lineHeight: 1.2,
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
        lineHeight: 1.5,
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
        <div style={{ marginTop: 8, fontSize: 12, color: ESTIMATE_MUTED, lineHeight: 1.5 }}>
          Red outline: your property boundary from county records.
        </div>
      ) : null}

      {metrics.length ? (
        <div style={{
          display: 'grid',
          // 3 metrics = one row of 3 (owner 2026-07-10 — auto-fit orphaned
          // the third tile onto its own row); any other count keeps the
          // responsive auto-fit grid (4 wraps 2×2 on phones).
          gridTemplateColumns: metrics.length === 3
            ? 'repeat(3, 1fr)'
            : 'repeat(auto-fit, minmax(132px, 1fr))',
          gap: 12,
          marginTop: 16,
        }}>
          {metrics.map((metric) => (
            <div
              key={`${metric.label}-${metric.value}`}
              style={estimateInnerBox({ padding: '12px 12px' })}
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
          gap: 12,
          marginTop: 16,
          paddingTop: 16,
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
                    padding: '12px 12px',
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
                    padding: '4px 8px',
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
          gap: 12,
          marginTop: 16,
        }}>
          {signals.map((signal) => (
            <div
              key={signal}
              style={{
                border: `1px solid ${ESTIMATE_BORDER}`,
                /* glass accent blue — the walker recolors text but never
                   border-left, so the old #009CDE survived under glass */
                borderLeft: '4px solid #0A7EC2',
                borderRadius: 10,
                background: COLORS.white,
                padding: '12px 12px',
                color: '#3F4A65',
                fontSize: 16,
                lineHeight: 1.5,
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
  const money = fmtMoney; // shared formatter (audit 2026-07-06)
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
    background: COLORS.white, border: `1px solid ${ESTIMATE_BORDER}`, borderRadius: 10, padding: '12px 12px',
  };
  const sectionTitle = {
    fontSize: 14, color: ESTIMATE_MUTED, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700,
  };
  const labelStyle = { color: ESTIMATE_TEXT, fontWeight: 600, fontSize: 15 };
  const valStyle = { color: W.green, fontSize: 14, fontWeight: 600, textAlign: 'right' };

  return (
    <section style={{ ...estimateCard(), display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontFamily: FONTS.serif, fontSize: 24, fontWeight: 500, lineHeight: 1.2, color: ESTIMATE_TEXT, margin: 0 }}>
            {hello}
          </h2>
          <p style={{ margin: '8px 0 0', color: '#3F4A65', fontSize: 14, lineHeight: 1.5 }}>
            Here&rsquo;s what your WaveGuard membership saves you on this estimate.
          </p>
        </div>
        <span style={{
          flex: 'none', alignSelf: 'flex-start', padding: '8px 12px', borderRadius: 999,
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
          /* glass accent blue — walker doesn't repaint border-left */
          borderLeft: '4px solid #0A7EC2', borderRadius: 10, padding: '12px 16px',
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
  // Abort an in-flight ask on unmount — the AI answer can take several
  // seconds, and its late resolution must not setState (or flash the call-us
  // fallback) against an unmounted bar.
  const askAbortRef = useRef(null);
  useEffect(() => () => { askAbortRef.current?.abort(); }, []);
  const prompts = Array.isArray(chips) && chips.length > 0
    ? chips.map((chip) => String(chip || '').trim()).filter(Boolean).slice(0, 6)
    : ESTIMATE_ASK_PROMPTS;

  const ask = useCallback(async (prompt) => {
    const q = String(prompt ?? question).trim();
    if (!q || asking) return;
    const controller = new AbortController();
    askAbortRef.current = controller;
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
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(body.error || 'question_failed');
      setAnswer(body.answer || 'I could not answer that from this estimate.');
      setQuestion('');
    } catch {
      if (controller.signal.aborted) return;
      setFailed(true);
      setAnswer(`I could not answer that right now. Call or text Waves at ${WAVES_PHONE_DISPLAY}.`);
    } finally {
      if (!controller.signal.aborted) setAsking(false);
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
          marginBottom: 8,
        }}>
          Ask Waves
        </div>
        <h2 style={{
          fontFamily: FONTS.serif,
          fontSize: 24,
          fontWeight: 500,
          lineHeight: 1.2,
          color: ESTIMATE_TEXT,
          margin: 0,
          letterSpacing: 0,
        }}>
          {glassCopyActive() ? GLASS_COPY.askTitle : 'Ask Waves'}
        </h2>
        {glassCopyActive() ? (
          <p style={{ margin: '8px 0 0', fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.5 }}>
            {GLASS_COPY.askExcerpt}
          </p>
        ) : null}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          ask();
        }}
        style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 12, alignItems: 'center' }}
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
            padding: '12px 16px',
            font: `500 15px/1.35 ${FONT_BODY}`,
            color: ESTIMATE_TEXT,
            background: '#F8FCFE',
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
            padding: '0 20px',
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
            className="gc-section-cta"
            style={{
              padding: '12px 16px', // >=40px hit height (touch audit 2026-07-06)
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
            borderLeft: `4px solid ${failed ? W.red : ESTIMATE_BUTTON_BG}`,
            background: failed ? '#FFF5F5' : '#F8FCFE',
            borderRadius: 10,
            padding: '12px 16px',
            color: ESTIMATE_TEXT,
            fontSize: 14,
            lineHeight: 1.5,
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

function isWaveGuardSetupBreakdownRow(item = {}) {
  if (item?.service === 'waveguard_setup') return true;
  const raw = [item.label, item.name, item.detail]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  return raw.includes('waveguard setup') || raw.includes('membership setup');
}

// Total for PaymentPreferenceButtons' "one-time services billed separately
// after completion" note. The WaveGuard setup row rides oneTimeBreakdown, but
// it's invoiced up front with the accept (PPB previews it as its own invoice
// line from `setupFee`), so counting it here would claim the same fee a
// second time as an after-completion charge. With showOneTimeOption the
// breakdown is the ALTERNATE one-time price (either/or), not extras on top —
// same gate OneTimeBreakdownCard uses.
export function oneTimeExtrasForPaymentNote(pricing, estimate, serviceMode) {
  if (serviceMode === 'one_time' || estimate?.showOneTimeOption) return 0;
  const breakdown = pricing?.oneTimeBreakdown;
  const total = Number(breakdown?.total) || 0;
  if (total <= 0) return 0;
  const setup = (Array.isArray(breakdown?.items) ? breakdown.items : [])
    .filter(isWaveGuardSetupBreakdownRow)
    .reduce((sum, row) => sum + (Number(row.amount ?? row.price ?? row.total) || 0), 0);
  return Math.max(0, Math.round((total - setup) * 100) / 100);
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

function SetupFeeCard({ fee, waiverBulletCovered = false }) {
  if (!fee) return null;
  // Under glass, a prepay-waivable setup fee is already stated inside the
  // pest offer stack ("$99 setup disappears with annual billing — waived
  // instantly", glassPestInclusions setup bullet, same waivedWithPrepay
  // eligibility) — rendering this card too said the same thing twice
  // (owner directive 2026-07-05). Hidden ONLY when that bullet actually
  // renders (a pest section exists to carry it — codex rd2: a non-pest
  // estimate with a waivable fee must keep the card or the fee vanishes);
  // non-waivable fees always keep the card.
  if (glassCopyActive() && fee.waivedWithPrepay && waiverBulletCovered) return null;
  return (
    <div style={{
      marginTop: 12,
      marginBottom: 20,
      padding: '16px 16px',
      border: '1px solid #D4CBB8',
      borderRadius: 10,
      background: COLORS.white,
    }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: ESTIMATE_TEXT, lineHeight: 1.35 }}>
        + {fmtMoney(fee.amount)} one-time {fee.label || 'first-visit setup'}
      </div>
      {fee.waivedWithPrepay ? (
        <div style={{ fontSize: 14, color: ESTIMATE_MUTED, marginTop: 2, lineHeight: 1.5 }}>
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
function OneTimeModeToggle({ mode, oneTimePrice, onChange, disabled = false }) {
  const pillBase = {
    padding: '12px 16px', borderRadius: 999, fontSize: 14, fontWeight: 600,
    cursor: disabled ? 'wait' : 'pointer', border: 'none', textAlign: 'center', flex: 1,
    transition: docTransition('background', 'color'),
    opacity: disabled ? 0.65 : 1,
  };
  return (
    <div style={{
      background: ESTIMATE_CHROME, borderRadius: 999, padding: 4,
      border: `1px solid ${ESTIMATE_BORDER}`, marginBottom: 20,
      display: 'flex', gap: 4,
      boxShadow: '0 1px 4px rgba(15,23,42,.04)',
    }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange('recurring')}
        style={{
          ...pillBase,
          background: mode === 'recurring' ? ESTIMATE_BUTTON_BG : 'transparent',
          color: mode === 'recurring' ? COLORS.white : ESTIMATE_BODY,
        }}
      >Recurring Pest Control</button>
      <button
        type="button"
        disabled={disabled}
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
      {/* Icon chip removed (owner 2026-07-06) — copy carries the offer. */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
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
              background: isReceived ? W.green : ESTIMATE_BUTTON_BG,
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
            {/* No plus glyph on the idle label (owner 2026-07-11) — only the
                received state keeps its check. */}
            {isReceived ? <Icon name="check" size={17} strokeWidth={2.4} /> : null}
            {isSubmitting ? 'Sending request...' : isReceived ? 'Request received' : (offer.buttonLabel || `Add ${offer.label}`)}
          </button>
          {isReceived ? (
            <div role="status" style={{
              marginTop: 12,
              background: '#ECFDF5',
              border: '1px solid #86EFAC',
              color: W.green,
              borderRadius: 10,
              padding: '12px 12px',
              fontSize: 14,
              lineHeight: 1.5,
            }}>
              <strong style={{ display: 'block', marginBottom: 2 }}>Request received.</strong>
              {requestState?.message || 'Got it. We are reviewing this service for your property and will follow up with a revised estimate shortly.'}
            </div>
          ) : null}
          {isError ? (
            <div role="alert" style={{
              marginTop: 12,
              background: '#FEF2F2',
              border: `1px solid ${W.red}`,
              color: W.red,
              borderRadius: 10,
              padding: '12px 12px',
              fontSize: 14,
              lineHeight: 1.5,
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
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: FONTS.serif, fontSize: 34, fontWeight: 500, color: ESTIMATE_TEXT, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
        {fmtMoney(oneTimePrice)}
        </span>
        <span style={{ fontSize: 15, fontWeight: 500, color: ESTIMATE_MUTED }}>one-time</span>
      </div>
      <div style={{ fontSize: 16, color: '#3F4A65', marginTop: 16, lineHeight: 1.5 }}>
        {oneTimePriceCopy(breakdown)}
      </div>
    </div>
  );
}

// Stable identity for a one-time breakdown row — the exclusion handshake
// between the embedded per-service rows and the standalone card below.
// The identity is the FULL row (service + label + amount + quote state),
// never `service` alone: two rows can share a service (a priced embedded
// install and a quote-required sibling), and a service-only key would drop
// the unembedded sibling from the standalone card so its Quote Required row
// never renders. Serviceless legacy rows (termite "Advance Installation")
// still key on label+amount. Contribution items are the same row objects as
// the breakdown items server-side, so fields match on both sides.
export function oneTimeRowIdentityKey(item = {}) {
  const label = String(item?.label || item?.name || item?.displayName || '').trim().toLowerCase();
  const amount = Number(item?.amount ?? item?.price);
  const quoteState = item?.quoteRequired === true || item?.kind === 'quote_required' ? 'qr' : '';
  return `row:${item?.service || ''}|${label}|${Number.isFinite(amount) ? amount : ''}|${quoteState}`;
}

export function OneTimeBreakdownCard({ breakdown, excludeServices = [], prepayWaivedServices = [] }) {
  // excludeServices accepts plain service keys (setup-fee callers) and
  // oneTimeRowIdentityKey values (embedded-row callers) — check both.
  const excluded = new Set(excludeServices.filter(Boolean));
  const items = (Array.isArray(breakdown?.items) ? breakdown.items : [])
    .filter((item) => !excluded.has(item?.service) && !excluded.has(oneTimeRowIdentityKey(item)));
  if (items.length === 0) return null;
  // Rows whose fee disappears with annual prepay (the WaveGuard setup fee) —
  // fed by pricing.firstVisitFees so the note only shows when the server says
  // the fee is actually waivable. Legacy label-only setup rows carry no
  // `service`, so fall back to the same label match the payment note uses.
  const prepayWaived = new Set(prepayWaivedServices.filter(Boolean));
  const isPrepayWaivedRow = (item) => prepayWaived.size > 0 && (
    prepayWaived.has(item?.service)
    || (prepayWaived.has('waveguard_setup') && isWaveGuardSetupBreakdownRow(item))
  );
  const hasQuoteRequired = items.some((item) => item?.quoteRequired === true || item?.kind === 'quote_required');
  const total = excludeServices.length === 0 && Number.isFinite(Number(breakdown?.total))
    ? Number(breakdown.total)
    : items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const totalIsQuoteRequired = hasQuoteRequired && total <= 0;

  return (
    <div style={estimateCard({ padding: 16 })}>
      <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.navy, marginBottom: 12 }}>
        One-time services
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        {items.map((item, i) => {
          const isQuoteRequired = item.quoteRequired === true || item.kind === 'quote_required';
          const amount = Number(item.amount) || 0;
          const isDiscount = !isQuoteRequired && (amount < 0 || item.kind === 'discount');
          const isIncluded = !isQuoteRequired && item.kind === 'included';
          const showPrepayWaiverNote = !isQuoteRequired && !isDiscount && !isIncluded && isPrepayWaivedRow(item);
          const quoteNote = isQuoteRequired ? quoteRequiredReasonNote(item, item.detail || '') : '';
          return (
            <div key={`${item.service || item.label || 'item'}-${i}`} style={{
              display: 'grid', gridTemplateColumns: '1fr auto', gap: 12,
              alignItems: 'start', paddingBottom: i === items.length - 1 ? 0 : 10,
              borderBottom: i === items.length - 1 ? 'none' : `1px solid ${ESTIMATE_BORDER}`,
            }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.navy }}>
                  {customerOneTimeLabel(item)}
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
                {showPrepayWaiverNote ? (
                  <div style={{ fontSize: 12, color: W.green, marginTop: 4, lineHeight: 1.35, fontWeight: 700 }}>
                    * {glassCopyActive() ? GLASS_COPY.setupWaivedNote : 'Waived when you pay the year in full up front.'}
                  </div>
                ) : null}
              </div>
              <div style={{
                fontSize: 14, fontWeight: 700,
                color: isQuoteRequired ? W.red : (isDiscount || isIncluded ? W.green : COLORS.navy),
                whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
              }}>
                {isQuoteRequired ? 'Quote Required' : (isIncluded ? 'Included' : (isDiscount ? fmtMoneySigned(-Math.abs(amount)) : fmtMoney(Math.abs(amount))))}
                {showPrepayWaiverNote ? '*' : ''}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between', gap: 12,
        borderTop: `1px solid ${ESTIMATE_BORDER}`, marginTop: 12, paddingTop: 12,
        fontSize: 15, fontWeight: 700, color: COLORS.navy, fontVariantNumeric: 'tabular-nums',
      }}>
        <span>{totalIsQuoteRequired ? 'Quote status' : 'One-time total'}</span>
        <span style={totalIsQuoteRequired ? { color: W.red } : null}>
          {totalIsQuoteRequired ? 'Quote Required' : fmtMoney(total)}
        </span>
      </div>
      {totalIsQuoteRequired ? (
        <div style={{ fontSize: 14, color: ESTIMATE_MUTED, marginTop: 8, lineHeight: 1.5 }}>
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
        gap: 20,
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
            marginBottom: 8,
          }}>
            Recurring total
          </div>
          <div style={{ fontSize: 15, color: ESTIMATE_MUTED, lineHeight: 1.5 }}>
            Combined recurring services before any one-time items.
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{
                        fontSize: quoteRequired || showLowConfidenceRange ? 34 : PRICE_FONT,
            lineHeight: 1,
            color: ESTIMATE_TEXT,
            fontWeight: 500,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {quoteRequired
              ? 'Quote required'
              : showLowConfidenceRange
              ? `${fmtMoney(rangeLow)}–${fmtMoney(rangeHigh)}`
              : fmtMoney(monthly)}
            {!quoteRequired ? <span style={{ fontFamily: FONT_BODY, fontSize: 20, color: ESTIMATE_MUTED }}> /mo</span> : null}
          </div>
          {!quoteRequired && annual ? (
            <div style={{ fontSize: 14, color: ESTIMATE_MUTED, marginTop: 8, fontVariantNumeric: 'tabular-nums' }}>
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
            <div style={{ fontSize: 14, color: '#92400E', marginTop: 12, lineHeight: 1.5, fontWeight: 700, maxWidth: 320 }}>
              {quoteReason}
            </div>
          ) : null}
          {waveGuardTier ? (
            <div style={{
              display: 'inline-block',
              marginTop: 12,
              padding: '4px 12px',
              ...waveGuardChipStyle(waveGuardTier),
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
          padding: '12px 12px',
          border: '1px solid #DCFCE7',
          borderRadius: 10,
          background: '#F0FDF4',
          color: W.green,
          fontSize: 14,
          fontWeight: 800,
          lineHeight: 1.35,
        }}>
          <span>{manualDiscount.label || 'Discount'}</span>
          <strong style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{fmtMoneySigned(-manualDiscountMonthly)} /mo</strong>
        </div>
      ) : null}
    </section>
  );
}

// Plan-level discount summary for a multi-service plan carrying a plan-wide
// credit (e.g. Referral Credit). The per-service cards quote their WaveGuard-net
// price PRE credit — the credit is applied to the combined plan, not baked into
// each row — so this is the one place the customer sees list subtotal → credit →
// the net they actually pay. Renders ONLY when there's a credit to itemize: the
// standalone "Recurring total" card was removed (owner directive 2026-07-07), so
// a no-credit multi-service plan stays summary-free and unchanged.
export function PlanTotalSummary({ combined, selectedFrequency = null, preCreditMonthly = null, planDiscount = null }) {
  if (!combined) return null;
  // The live discount object (selected row first — the server nulls
  // combined.manualDiscount whenever the DEFAULT cadence floor-suppresses the
  // credit — else the default payload's) prices the ranged fallback and
  // corroborates $0 nets; the itemized amounts come from the selected-cadence
  // difference below.
  const liveDiscount = (discount) => (discount && Number(discount.amount) > 0 ? discount : null);
  const manual = liveDiscount(selectedFrequency?.manualDiscount) || liveDiscount(combined.manualDiscount);
  // Render gate: ANY evidence the plan carries a manual credit. Combo rows drop
  // the discount fields and the combinedFrequency overlay keeps only the base
  // row's, so a credit that's suppressed on the default/base row but live in
  // the selected combo's net must gate in via the row's suppressed flag or the
  // payload-level planDiscount — its amount then comes from the diff. A
  // creditless plan carries none of these signals, so reconciliation drift can
  // never conjure a discount line out of nothing.
  const planHasCredit = Boolean(manual)
    || Boolean(selectedFrequency?.manualDiscount)
    || selectedFrequency?.manualDiscountSuppressed === true
    || Boolean(combined.manualDiscount)
    || Boolean(planDiscount);
  if (!planHasCredit) return null;
  const creditLabel = (manual || selectedFrequency?.manualDiscount || combined.manualDiscount || planDiscount)?.label || 'Discount';
  // Quote-required selection: the rest of the estimate hides exact dollars for a
  // quote-required row, so there's no exact subtotal/net to itemize here either.
  if (selectedFrequency?.quoteRequired === true) return null;

  const round2 = (n) => Math.round(Number(n) * 100) / 100;
  // A $0 net is real — a credit can fully comp the plan, and that's exactly when
  // the subtotal → credit → "Your price $0" story matters — so only a
  // negative/non-finite net bails. A zero net must additionally be corroborated
  // by the credit itself before rendering (below).
  const netMonthly = Number(selectedFrequency?.monthly ?? combined.monthlySubtotal);
  if (!Number.isFinite(netMonthly) || netMonthly < 0) return null;

  const row = { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' };
  const num = { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
  const per = (label) => <span style={{ color: ESTIMATE_MUTED, fontSize: 14, fontWeight: 500 }}> {label}</span>;
  const creditBox = (amount) => (
    <div style={{
      ...row,
      padding: '12px 14px',
      borderRadius: 10,
      border: `1px solid ${W.greenLight}`,
      background: W.successWash,
      color: W.green,
      fontWeight: 800,
      fontSize: 16,
    }}>
      <span>{creditLabel}</span>
      <strong style={num}>{fmtMoneySigned(-amount)}<span style={{ fontWeight: 600 }}> /mo</span></strong>
    </div>
  );

  // Credit = the ACTUAL reduction for the SELECTED cadence: the sum of the
  // pre-credit per-service cards minus the net the accept payload charges.
  // Deriving it as a difference (rather than reading a credit object) is correct
  // for every cadence, cap, and discount type by construction, and guarantees the
  // on-screen subtotal − credit = net reconciles. `preCreditMonthly` is that
  // per-service sum. Both branches below use this so a ranged plan doesn't show a
  // stale default-cadence credit either.
  const subtotalMonthly = round2(Number(preCreditMonthly));
  const hasServiceSum = subtotalMonthly > 0;
  const creditFromDiff = hasServiceSum && subtotalMonthly > netMonthly
    ? round2(subtotalMonthly - netMonthly)
    : null;
  // A $0 net renders only when a plan credit corroborates covering the whole
  // subtotal (1-cent tolerance, same as the split reconciliation): a legacy
  // payload with a zeroed/missing subtotal and an ordinary credit must not
  // render as "fully comped". Corroborate against the LARGEST candidate — a
  // row-level object capped for the BASE cadence must not shadow a payload
  // planDiscount that fully comps the selected combo.
  const corroboratingCreditMonthly = Math.max(
    manualDiscountMonthlyAmount(manual),
    manualDiscountMonthlyAmount(planDiscount),
  );
  if (netMonthly === 0 && corroboratingCreditMonthly < subtotalMonthly - 0.011) return null;

  // Ranged low-confidence (commercial) plan: the page quotes a confirmed-on-site
  // range, not one exact number — but the credit is applied by accept regardless,
  // so keep it visible as a credit-only line rather than printing an exact
  // subtotal/net the rest of the page deliberately avoids. Prefer the selected
  // cadence's difference. Fall back to the plan credit's own amount ONLY when
  // the per-service sum is genuinely unavailable — with a sum in hand, a zero
  // difference means the selected cadence caps/suppresses the credit away, and
  // the fallback would advertise a credit accept won't apply. Same when the
  // selected row itself marks the credit suppressed.
  const lowConfidencePct = Number(selectedFrequency?.lowConfidenceRangePct ?? combined.lowConfidenceRangePct) || 0;
  if (lowConfidencePct > 0) {
    const rangedCredit = hasServiceSum
      ? creditFromDiff
      // Row object first (selection-specific, possibly capped), else the
      // payload planDiscount — the same evidence the render gate accepts, so
      // gating in via planDiscount alone can still price this line.
      : (selectedFrequency?.manualDiscountSuppressed === true ? null : manualDiscountMonthlyAmount(manual || planDiscount));
    if (!(rangedCredit > 0)) return null;
    return (
      <section style={estimateCard()}>
        {creditBox(rangedCredit)}
        <div style={{ marginTop: 10, fontSize: 14, color: ESTIMATE_MUTED, lineHeight: 1.5 }}>
          Applied to your plan — we confirm your exact price with a quick site visit.
        </div>
      </section>
    );
  }

  // Exact case needs the per-service sum to itemize against.
  if (!(creditFromDiff > 0)) return null;
  const creditMonthly = creditFromDiff;
  // Credit-only card (owner directive 2026-07-11): the plan credit stays
  // visible, but a multi-service plan never restates a combined monthly or
  // annual total — per-application pricing on the service cards is the only
  // customer-facing price. The subtotal/net figures above remain solely as
  // reconciliation inputs for the credit amount. The service cards are
  // pre-credit, so the caption points at booking (where accept applies it),
  // not at the card prices.
  return (
    <section style={estimateCard()}>
      {creditBox(creditMonthly)}
      <div style={{ marginTop: 10, fontSize: 14, color: ESTIMATE_MUTED, lineHeight: 1.5 }}>
        Applied to your plan when you book.
      </div>
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
      <div style={{ fontSize: 20, fontWeight: 800, color: ESTIMATE_TEXT, marginTop: 8, lineHeight: 1.35 }}>
        {formatAppointmentLabel(appointment)}
      </div>
      <div style={{ fontSize: 15, color: ESTIMATE_BODY, marginTop: 4, lineHeight: 1.5 }}>
        {appointment?.serviceType || 'Service visit'}
      </div>
      <div style={{ fontSize: 14, color: ESTIMATE_BODY, marginTop: 12, lineHeight: 1.5 }}>
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
  const dialogRef = useModalFocus();
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
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Secure payment"
      onKeyDown={(e) => { if (e.key === 'Escape' && !submitting) onCancel(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(4,57,94,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}
    >
      <div style={{ background: COLORS.white, borderRadius: 16, maxWidth: 440, width: '100%', padding: 24, boxShadow: '0 18px 50px rgba(0,0,0,0.25)', maxHeight: '90vh', overflow: 'auto' }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: COLORS.navy }}>Reserve your appointment</div>
        <div style={{ fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.5, margin: '8px 0 16px' }}>
          A {fmtMoney(intent.amount)} deposit holds your spot. It is applied to {creditTarget}.
          {Number(intent.receivedTotal) > 0 ? ` (${fmtMoney(intent.receivedTotal)} already received.)` : ''}
        </div>
        <div ref={mountRef} />
        {error ? (
          <div role="alert" style={{ color: W.red, fontSize: 14, lineHeight: 1.5, marginTop: 12 }}>{error}</div>
        ) : null}
        <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
          <button
            type="button"
            onClick={handlePay}
            disabled={!ready || submitting}
            style={{ ...estimateCtaStyle, opacity: !ready || submitting ? 0.6 : 1 }}
          >{submitting ? 'Processing…' : `Pay ${fmtMoney(intent.amount)} deposit`}</button>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            style={estimateSecondaryCtaStyle}
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
  const dialogRef = useModalFocus();
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
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Secure payment"
      onKeyDown={(e) => { if (e.key === 'Escape' && !submitting) onCancel(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(4,57,94,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}
    >
      <div style={{ background: COLORS.white, borderRadius: 16, maxWidth: 440, width: '100%', padding: 24, boxShadow: '0 18px 50px rgba(0,0,0,0.25)', maxHeight: '90vh', overflow: 'auto' }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: COLORS.navy }}>Hold your appointment</div>
        <div style={{ fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.5, margin: '8px 0 16px' }}>
          We won&rsquo;t charge you today. Your card is charged the final total after your visit is completed.
          A {feeText} fee applies only if you cancel within {windowText} or aren&rsquo;t home.
          {' '}{CARD_SURCHARGE_DISCLOSURE}
        </div>
        <div ref={mountRef} />
        {error ? (
          <div role="alert" style={{ color: W.red, fontSize: 14, lineHeight: 1.5, marginTop: 12 }}>{error}</div>
        ) : null}
        <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
          <button
            type="button"
            onClick={handleSave}
            disabled={!ready || submitting}
            style={{ ...estimateCtaStyle, opacity: !ready || submitting ? 0.6 : 1 }}
          >{submitting ? 'Saving…' : 'Save card & hold my spot'}</button>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            style={estimateSecondaryCtaStyle}
          >Not now</button>
        </div>
      </div>
    </div>
  );
}

// Recurring card-on-file capture (dark until RECURRING_CARD_ON_FILE). Mirrors
// CardHoldModal — a SetupIntent saves the card, NO money is taken here (the
// deposit is its own modal) — but the authorization is Auto Pay: after each
// completed application the saved card is charged automatically. The locked
// card consent text is rendered verbatim behind a checkbox so the server's
// consent snapshot records exactly what the customer agreed to.
function RecurringCardModal({ intent, onSuccess, onCancel }) {
  const dialogRef = useModalFocus();
  const mountRef = useRef(null);
  const stripeRef = useRef(null);
  const elementsRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [agreed, setAgreed] = useState(false);
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
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Secure payment"
      onKeyDown={(e) => { if (e.key === 'Escape' && !submitting) onCancel(); }}
      data-glass-scrim=""
      style={{ position: 'fixed', inset: 0, background: 'rgba(27,44,91,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}
    >
      {/* data-glass="modal": the estimate page always mounts the glass
          scene, so this dialog picks up the strongest glass surface (owner
          ask 2026-07-12 — Auto Pay mirrors the glass UI); the inline styles
          are the non-glass fallback. */}
      <div data-glass="modal" style={{ background: COLORS.white, borderRadius: 16, maxWidth: 440, width: '100%', padding: 24, boxShadow: '0 18px 50px rgba(0,0,0,0.25)', maxHeight: '90vh', overflow: 'auto' }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: COLORS.navy }}>Set up Auto Pay</div>
        <div style={{ fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.5, margin: '8px 0 16px' }}>
          Save your card to confirm your recurring plan — nothing is charged
          today. After each completed service, your card is charged that
          service&rsquo;s amount automatically.
        </div>
        <div ref={mountRef} />
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 16, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            disabled={submitting}
            style={{ marginTop: 3, width: 16, height: 16, flex: 'none' }}
          />
          <span style={{ fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.5 }}>{CARD_CONSENT_TEXT}</span>
        </label>
        {error ? (
          <div role="alert" style={{ color: W.red, fontSize: 14, lineHeight: 1.5, marginTop: 12 }}>{error}</div>
        ) : null}
        <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
          <button
            type="button"
            onClick={handleSave}
            disabled={!ready || !agreed || submitting}
            style={{ ...estimateCtaStyle, opacity: !ready || !agreed || submitting ? 0.6 : 1 }}
          >{submitting ? 'Saving…' : 'Agree & save card'}</button>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            style={estimateSecondaryCtaStyle}
          >Not now</button>
        </div>
      </div>
    </div>
  );
}

export function ReviewPhase({ slotId, slotMeta = null, existingAppointment, paymentPreference, secondsRemaining, onConfirm, onCancel, invoiceMode, invoiceOnly = false, siteConfirmationHold = false, manualScheduling = false, serviceMode, depositNote, submitting = false }) {
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
      <div style={{ fontSize: 18, color: COLORS.navy, marginTop: 12, lineHeight: 1.5 }}>
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
              : slotMeta?.date
                // Human-readable date/time; the raw internal slot id only
                // appears when the slot metadata is missing.
                ? `Visit: ${new Date(`${slotMeta.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}${slotMeta.time ? ` · ${slotMeta.time}` : ''}`
                : `Slot: ${slotId}`}
      </div>
      {!usingExistingAppointment && !invoiceOnly && !manualScheduling ? <div style={{ marginTop: 16 }}><CountdownLine secondsRemaining={secondsRemaining} /></div> : null}
      <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
        <button
          type="button"
          onClick={onConfirm}
          disabled={submitting}
          style={submitting ? { ...estimateCtaStyle, opacity: 0.65, cursor: 'wait' } : estimateCtaStyle}
        >{confirmLabel}</button>
        {confirmSub ? (
          <div style={{ fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.5, textAlign: 'center' }}>
            {confirmSub}
          </div>
        ) : null}
        {depositNote ? (
          <div style={{ fontSize: 14, color: ESTIMATE_BODY, lineHeight: 1.5, textAlign: 'center' }}>
            {depositNote}
          </div>
        ) : null}
        {!usingExistingAppointment ? (
          <button
            type="button"
            onClick={onCancel}
            style={estimateSecondaryCtaStyle}
          >Go back</button>
        ) : null}
      </div>
    </div>
  );
}

export function SuccessCard({ acceptResult, appointmentLabel = null, recurring = false }) {
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
      <div style={{ ...estimateCard({ padding: 24, textAlign: 'center' }), borderTop: `4px solid ${W.green}` }}>
        <div style={{ fontSize: 24, fontWeight: 700, color: COLORS.navy, marginTop: 8 }}>
          {title}
        </div>
        <div style={{ fontSize: 16, color: ESTIMATE_BODY, marginTop: 12, lineHeight: 1.5 }}>
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
            style={{ ...estimateCtaStyle, display: 'inline-block', marginTop: 16, textDecoration: 'none', fontSize: 15 }}
          >{payNowLabel}</a>
        ) : null}
        <div style={{ fontSize: 14, color: ESTIMATE_MUTED, marginTop: 12, lineHeight: 1.5 }}>
          {deferredPaymentCopy}
        </div>
      </div>
    );
  }

  if (nextStep === 'prepay_invoice') {
    return (
      <div style={{ ...estimateCard({ padding: 24, textAlign: 'center' }), borderTop: `4px solid ${W.green}` }}>
        <div style={{ fontSize: 24, fontWeight: 700, color: COLORS.navy, marginTop: 8 }}>
          Your annual prepay is approved.
        </div>
        <div style={{ fontSize: 16, color: ESTIMATE_BODY, marginTop: 12, lineHeight: 1.5 }}>
          Your annual prepay{prepayAmountText} is approved. Our team will follow up with the invoice details and confirm the schedule.
        </div>
      </div>
    );
  }

  if (nextStep === 'site_confirmation') {
    // Narrow low-confidence commercial: approved online, but the exact price is
    // confirmed on site before the first invoice — so no payment step here.
    return (
      <div style={{ ...estimateCard({ padding: 24, textAlign: 'center' }), borderTop: `4px solid ${W.green}` }}>
        <div style={{ fontSize: 24, fontWeight: 700, color: COLORS.navy, marginTop: 8 }}>
          You're approved — no payment needed yet.
        </div>
        <div style={{ fontSize: 16, color: ESTIMATE_BODY, marginTop: 12, lineHeight: 1.5 }}>
          Your Waves account manager will confirm the exact price on a quick site visit, then send your first
          invoice. Nothing is charged until that's done.
        </div>
      </div>
    );
  }

  if (nextStep === 'book_one_time') {
    return (
      <div style={{ ...estimateCard({ padding: 24, textAlign: 'center' }), borderTop: `4px solid ${W.green}` }}>
        <div style={{ fontSize: 24, fontWeight: 700, color: COLORS.navy, marginTop: 8 }}>
          You're approved for a one-time service.
        </div>
        <div style={{ fontSize: 16, color: ESTIMATE_BODY, marginTop: 12, lineHeight: 1.5 }}>
          {bookingUrl
            ? (acceptResult?.alreadyAccepted
              // Already-accepted retry: /accept returns a fresh booking URL
              // but does NOT re-send the SMS — don't promise a text that
              // never went out; the on-screen button is the real path.
              ? 'This estimate was already accepted — pick your appointment now.'
              : 'Check your phone for the booking link, or pick your appointment now.')
            : 'Our team will follow up to help schedule your appointment.'}
        </div>
        {bookingUrl ? (
          <a
            href={bookingUrl}
            style={{ ...estimateCtaStyle, display: 'inline-block', marginTop: 16, textDecoration: 'none', fontSize: 15 }}
          >Pick appointment</a>
        ) : null}
      </div>
    );
  }

  return (
    // data-glass="card": the booked screen rides the estimate page's glass
    // scene like the Auto Pay modal (owner ask 2026-07-12); inline styles
    // stay as the non-glass fallback.
    <div data-glass="card" style={{ ...estimateCard({ padding: 24, textAlign: 'center' }), borderTop: `4px solid ${W.green}` }}>
      <div style={{ fontSize: 40 }}></div>
      <div style={{ fontSize: 24, fontWeight: 700, color: COLORS.navy, marginTop: 8 }}>
        You're booked.
      </div>
      {appointmentLabel ? (
        <div style={{ fontSize: 17, fontWeight: 600, color: COLORS.navy, marginTop: 10 }}>
          First visit: {appointmentLabel}
        </div>
      ) : null}
      <div style={{ fontSize: 16, color: ESTIMATE_BODY, marginTop: 12, lineHeight: 1.5 }}>
        {/* A retry of an already-accepted estimate returns the full success
            payload with alreadyAccepted: true — the original confirmation
            text may not re-send, so don't promise one. */}
        {acceptResult?.alreadyAccepted
          ? 'This estimate was already accepted — you\'re all set. Our team will confirm the schedule.'
          : 'Check your phone for the confirmation text. Our team will confirm the schedule.'}
      </div>
      {recurring ? (
        <div style={{ fontSize: 14, color: ESTIMATE_BODY, marginTop: 14, lineHeight: 1.5 }}>
          Download the Waves app to track visits, reschedule, and manage your
          plan anytime.
        </div>
      ) : null}
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
      background: '#fff4e5', borderRadius: 12, padding: 16,
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

// Shared failure banner for the reserve/accept/deposit/card-hold flow.
// Accept-path failures land the customer back in the REVIEW phase, not just
// configure, so both branches must render it — a review-phase 500 used to
// show nothing at all.
function EstimateErrorBanner({ error }) {
  if (!error) return null;
  return (
    <div style={{
      background: '#fee', borderRadius: 12, padding: 12,
      border: `1px solid ${W.red}`, marginBottom: 16,
      color: W.red, fontSize: 14,
    }}>
      Something went wrong: {error}. Try again or call{' '}
      <a href={`tel:${WAVES_PHONE_TEL}`} style={{ color: W.red }}>{WAVES_PHONE_DISPLAY}</a>.
    </div>
  );
}

function SlotIssueBanner({ kind = 'conflict', onRetry }) {
  const expired = kind === 'expired';
  return (
    <div style={{
      background: '#fff4e5', borderRadius: 12, padding: 16,
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
            marginTop: 12, padding: '8px 16px',
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
        <div style={{ fontSize: 15, color: ESTIMATE_BODY, lineHeight: 1.5 }}>
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
        <div style={{ fontSize: 15, color: ESTIMATE_BODY, lineHeight: 1.5 }}>
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
      <div style={{ fontSize: 15, color: ESTIMATE_BODY, lineHeight: 1.5 }}>{body}</div>
      <a href={`tel:${WAVES_PHONE_TEL}`} style={estimateCallCtaStyle}>
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
      <div style={{ fontSize: 15, color: ESTIMATE_BODY, lineHeight: 1.5 }}>
        {isTrenching
          ? 'Your price is set from the measured treatment path. Because trenching drills concrete, lays a chemical soil barrier, and carries a retreat warranty, a Waves specialist confirms the plan with you — access, exact footage, product, and warranty — then schedules your visit, so it can’t be self-booked online.'
          : 'A Waves specialist reviews this quote with you and schedules your visit — it can’t be self-booked online.'}
      </div>
      <a href={`tel:${WAVES_PHONE_TEL}`} style={estimateCallCtaStyle}>
        Call Waves to confirm — {WAVES_PHONE_DISPLAY}
      </a>
      <div style={{ fontSize: 14, color: ESTIMATE_MUTED, marginTop: 12, lineHeight: 1.5 }}>
        Prefer we reach out? We’ll follow up to confirm and schedule your visit. You pay on service day; no card or deposit now.
      </div>
    </div>
  );
}

// Service-related card headlines (owner directive 2026-07-10): every service
// box leads with copy about ITS service — the generic "Same protection" line
// only survives as the fallback for unmapped/bundle sections. Pest keeps its
// original line.
const SERVICE_CARD_HEADLINES = {
  pest_control: 'Pest Protection by Waves — whatever\u2019s getting inside, it stops here',
  mosquito: 'Mosquito Defense by Waves — evenings outside, mosquito-free',
  termite_bait: 'Termite Defense by Waves — protecting the biggest investment you own',
  lawn_care: 'Lawn Care by Waves — pick the program that fits your turf',
  tree_shrub: 'Tree & Shrub Care by Waves — ornamental protection through the seasons',
  foam_recurring: 'Targeted Foam Treatment by Waves — recurring protection at the source',
  rodent_bait: 'Rodent Defense by Waves — exterior stations monitored on schedule',
  palm_injection: 'Palm Care by Waves — injection care timed to your palms',
};

// One-time work that belongs to a service renders INSIDE that service's box
// (owner directive 2026-07-10: the Advance Installation lives with Termite
// Bait Monitoring, not in a detached card). Plain charges only — quote-
// required and waiver rows stay on the standalone breakdown card paths.
// Per-service "send me the full details" row (GATE_SERVICE_DETAILS_PDF,
// renderFlags.showServiceDetailsRequest). Customer-initiated transactional
// send to the contact info ALREADY on the estimate — the destination is
// never chosen client-side. Only services with a packet defined server-side
// render the row (SERVICE_DETAILS_KEYS mirrors SERVICE_DETAILS_COPY).
const SERVICE_DETAILS_KEYS = new Set(['pest_control', 'mosquito', 'termite_bait', 'lawn_care', 'tree_shrub']);

// Universally-recognized icons for the details-packet actions (inline SVG,
// currentColor — same pattern as QuestionsEscapeHatch's ChatIcon). The pills
// are icon-ONLY (owner 2026-07-11) — the label lives in aria-label/title.
function PdfDocIcon() {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8M8 17h5" />
    </svg>
  );
}
function EnvelopeIcon() {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-10 6L2 7" />
    </svg>
  );
}
function ChatBubbleIcon() {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

// Details-packet action pill — the page's gold CTA treatment (gc-section-cta),
// icon-only: square-ish padding keeps a ≥44px tap target without a text label.
const DETAILS_ACTION_STYLE = (disabled) => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  padding: '12px 16px', fontSize: 14, fontWeight: 700,
  textDecoration: 'none',
  pointerEvents: disabled ? 'none' : 'auto', opacity: disabled ? 0.6 : 1,
});

function ServiceDetailsRequestRow({ token, serviceKey, customerEmail, customerPhone, disabled = false, preview = false }) {
  const [state, setState] = useState({ status: 'idle', channel: null, message: '' });
  if (!SERVICE_DETAILS_KEYS.has(serviceKey)) return null;
  const send = async (channel) => {
    // Staff draft preview mirrors the customer layout for parity but never
    // fires a real send: the estimate hasn't reached the customer yet, and
    // the PDF endpoint 404s on drafts by design. The buttons render inert.
    if (preview || state.status === 'sending') return;
    setState({ status: 'sending', channel, message: '' });
    try {
      const r = await fetch(`${API_BASE}/estimates/${token}/service-details/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: serviceKey, channel }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.ok) {
        setState({ status: 'error', channel, message: body.error || 'Could not send right now — call or text us and we\u2019ll get it to you.' });
        return;
      }
      setState({ status: 'sent', channel, message: '' });
    } catch {
      setState({ status: 'error', channel, message: 'Could not send right now — call or text us and we\u2019ll get it to you.' });
    }
  };
  const sentLabel = state.channel === 'email'
    ? `Sent! Check ${customerEmail || 'your email'}.`
    : 'Sent! Check your texts for the link.';
  return (
    <div style={{ borderTop: `1px solid ${ESTIMATE_BORDER}`, marginTop: 16, paddingTop: 14, textAlign: 'center' }}>
      <div style={{ fontSize: 14, color: ESTIMATE_MUTED, lineHeight: 1.45, marginBottom: 10 }}>
        Want the fine print? Get the full details PDF.
      </div>
      {state.status === 'sent' ? (
        <div style={{ fontSize: 14, fontWeight: 700, color: W.green }}>
          <span aria-hidden="true" style={{ marginRight: 6 }}>&#10003;</span>{sentLabel}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
          {/* Direct view — opens the same tokenized PDF the send flows
              deliver, in a new tab where the browser's own print / download
              / share (incl. the mobile share sheet) take over. Rendered
              first so customers aren't forced through a send to read it.
              All three actions wear the page's gold CTA pill
              (gc-section-cta) as icon-only buttons (owner 2026-07-11) —
              the intro line above supplies the context, aria-label/title
              carry the action name. */}
          <a
            className="gc-section-cta"
            href={preview ? undefined : `${API_BASE}/estimates/${token}/service-details/${serviceKey}/pdf`}
            target={preview ? undefined : '_blank'}
            rel={preview ? undefined : 'noopener noreferrer'}
            onClick={preview ? (e) => e.preventDefault() : undefined}
            aria-label="View the PDF"
            title="View the PDF"
            style={{ ...DETAILS_ACTION_STYLE(preview ? false : disabled), ...(preview ? { cursor: 'pointer' } : null) }}
          >
            <PdfDocIcon />
          </a>
          {customerEmail ? (
            <button
              type="button"
              className="gc-section-cta"
              disabled={!preview && (disabled || state.status === 'sending')}
              onClick={preview ? undefined : () => send('email')}
              aria-label="Email me the PDF"
              title="Email me the PDF"
              style={DETAILS_ACTION_STYLE(preview ? false : (disabled || state.status === 'sending'))}
            >
              <EnvelopeIcon />
            </button>
          ) : null}
          {customerPhone ? (
            <button
              type="button"
              className="gc-section-cta"
              disabled={!preview && (disabled || state.status === 'sending')}
              onClick={preview ? undefined : () => send('sms')}
              aria-label="Text me the link"
              title="Text me the link"
              style={DETAILS_ACTION_STYLE(preview ? false : (disabled || state.status === 'sending'))}
            >
              <ChatBubbleIcon />
            </button>
          ) : null}
          {preview ? (
            <div style={{ flexBasis: '100%', fontSize: 14, color: ESTIMATE_MUTED, marginTop: 4, fontStyle: 'italic' }}>
              Preview only. This is exactly what the customer sees; the buttons become active once the estimate is sent.
            </div>
          ) : null}
        </div>
      )}
      {state.status === 'error' ? (
        <div style={{ fontSize: 14, color: W.noticeText, fontWeight: 600, marginTop: 8 }}>{state.message}</div>
      ) : null}
    </div>
  );
}

// Customer-facing one-time labels: product names mean nothing to customers —
// "Advance Installation" / "Trelona Installation" render as "Termite Bait
// Installation" (owner 2026-07-10); the detail line keeps stations/LF.
function customerOneTimeLabel(item = {}) {
  const label = String(item.label || '').trim();
  const isTermiteInstall = item.service === 'termite_bait_installation'
    || /\b(advance|trelona)\s+installation\b/i.test(label);
  if (isTermiteInstall) return 'Termite Bait Installation';
  return label || 'One-time service';
}

function SectionOneTimeBlock({ contribution, variant = 'trailing' }) {
  const items = Array.isArray(contribution?.items)
    ? contribution.items.filter((item) => item && item.quoteRequired !== true && item.kind !== 'quote_required')
    : [];
  if (!items.length) return null;
  const lead = variant === 'lead';
  // Owner copy (2026-07-10, investment framing): the termite install price
  // reads as a sentence, not a bare figure — "$639 gets every station in the
  // ground." Only the lead-variant termite install gets sentence treatment.
  const isTermiteInstall = (item) => item?.service === 'termite_bait_installation'
    || /\binstallation\b/i.test(String(item?.label || ''));
  return (
    <div style={lead
      ? { margin: '16px 0 4px' }
      : { borderTop: `1px solid ${ESTIMATE_BORDER}`, marginTop: 16, paddingTop: 14 }}>
      {/* No "One-time services" header inside a service box (owner
          2026-07-10) — the rows speak for themselves. */}
      <div style={{ display: 'grid', gap: 10 }}>
        {items.map((item, i) => {
          const amount = fmtMoney(Math.abs(Number(item.amount) || 0));
          if (lead && isTermiteInstall(item)) {
            return (
              <div key={`${item.service || item.label || 'item'}-${i}`}>
                <div style={{ fontSize: 15, fontWeight: 800, color: COLORS.navy }}>{customerOneTimeLabel(item)}</div>
                {item.detail ? (
                  <div style={{ fontSize: 14, color: ESTIMATE_MUTED, marginTop: 2, lineHeight: 1.35 }}>{item.detail}</div>
                ) : null}
                <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.navy, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
                  {amount} gets every station in the ground.
                </div>
              </div>
            );
          }
          return (
            <div key={`${item.service || item.label || 'item'}-${i}`} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, alignItems: 'start' }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.navy }}>{customerOneTimeLabel(item)}</div>
                {item.detail ? (
                  <div style={{ fontSize: 12, color: ESTIMATE_MUTED, marginTop: 2, lineHeight: 1.35 }}>{item.detail}</div>
                ) : null}
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.navy, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                {amount}
              </div>
            </div>
          );
        })}
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
  oneTimeEmbed = null,
  serviceDetailsRequest = null,
}) {
  if (!section) return null;
  const frequencies = Array.isArray(section.frequencies) ? section.frequencies : [];
  const current = frequencies.find((frequency) => frequency.key === selectedFrequencyKey) || frequencies[0] || null;
  const copy = section.copy || {};
  // Glass cards restate the per-day figure with a value-anchor comparison
  // tail (pest keeps its cadence-matched trio; other programs get their
  // service-matched line). Sections without a glass line — and every
  // section when glass is off — keep their server-provided wording.
  // Resolved from the section KEY, not isPest: the server's unsplittable
  // multi-service section is keyed 'bundle' with isPest:true whenever pest
  // is among the services, and that section must keep its server bundle
  // wording rather than pest value copy (codex rd2).
  const sectionSlug = glassServiceSlug(section.key || section.label);
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

  // The synthetic unsplittable multi-service section (key 'bundle') keeps
  // waveGuardTierEligible=true whenever ANY member service is eligible, but
  // badging it would resurrect the deleted plan-level badge on the whole
  // "Recurring services" card (owner directive: recurring pest + mosquito
  // lines badge individually ONLY) — real per-service sections only.
  const sectionTierEligible = section?.waveGuardTierEligible !== false && section?.key !== 'bundle';
  const showTierBadge = !!waveGuardTier && sectionTierEligible;
  return (
    <section>
      {/* Frequency choice + price live in ONE shadow-box card, same
          treatment as every other section (owner: "all boxes should
          render like" the Waves AI card). */}
      <div style={estimateCard({ position: 'relative' })}>
        {/* WaveGuard membership badge pinned to the box's top-right corner
            (owner directive 2026-07-10 — was inline next to the price). */}
        {showTierBadge ? (
          <span style={{
            position: 'absolute', top: 16, right: 16,
            display: 'inline-block', padding: '4px 12px',
            ...waveGuardChipStyle(waveGuardTier),
            borderRadius: 6, fontSize: 14, fontWeight: 700, letterSpacing: '0.02em',
            whiteSpace: 'nowrap',
          }}>
            WaveGuard {glassCopyActive() ? glassTierDisplay(waveGuardTier) : waveGuardTier}
          </span>
        ) : null}
        {servicesLength > 1 ? (
          <h3 style={{
            fontSize: 18,
            color: ESTIMATE_TEXT,
            margin: '0 0 16px',
            // Keep clear of the absolutely-positioned corner badge — sized
            // for the widest chip ("WaveGuard Platinum" at 14px/700 + pill
            // padding + the 16px corner inset).
            paddingRight: showTierBadge ? 170 : 0,
            fontWeight: 800,
          }}>
            {displayServiceLabel(section.label) || 'Service'}
          </h3>
        ) : null}

        {/* Every service box leads with its own service-related headline —
            the "HOW OFTEN?" eyebrow is gone and no-selector services
            (termite monitoring) get a headline too (owner 2026-07-10). */}
        <h2 style={{
          fontSize: 20, fontWeight: 500, lineHeight: 1.2,
          color: '#04395E', margin: '0 0 4px',
          // Same corner-badge clearance as the h3 above; only needed when
          // this headline is the first line in the card (single-service).
          paddingRight: servicesLength > 1 || !showTierBadge ? 0 : 170,
        }}>
          {SERVICE_CARD_HEADLINES[sectionSlug] || 'Same protection — pick the rhythm that fits your home'}
        </h2>
        {showSlider ? (
          <GlassFrequencyPills
            frequencies={frequencies}
            selected={selectedFrequencyKey}
            onChange={(next) => onFrequencyChange(section.key, next)}
            disabled={disabled}
          />
        ) : null}

        {/* Termite reads install-first (owner copy 2026-07-10, investment
            framing): stations go in once, then the bridge line hands off to
            the monitoring price so the two figures read as ONE plan. */}
        {sectionSlug === 'termite_bait' && oneTimeEmbed ? (
          <>
            <SectionOneTimeBlock contribution={oneTimeEmbed} variant="lead" />
            <div style={{ fontSize: 15, fontWeight: 700, color: '#04395E', margin: '14px 0 0' }}>
              Monitoring is what keeps them working:
            </div>
          </>
        ) : null}

        {current ? (
          <PriceCard
            frequency={current}
            // Every eligible section badges its own card — multi-service
            // plans no longer hoist one plan-level badge (owner directive
            // 2026-07-10). The server's waveGuardTierEligible flag keeps
            // palm/rodent cards badge-free, and the synthetic 'bundle'
            // fallback section never badges (see sectionTierEligible).
            waveGuardTier={sectionTierEligible ? waveGuardTier : null}
            // The card corner carries the badge now — PriceCard keeps the
            // tier only for its per-row service tags.
            showTierBadge={false}
            // Every recurring service bills per application (owner directive
            // 2026-07-11) — all real service cards lead with the
            // per-application price, not just pest/mosquito/termite. PriceCard
            // still falls back to the cadence rate when no unambiguous
            // per-application price exists (multi-row bundles, flat-monthly
            // monitoring, ranged or quote-required pricing).
            //
            // The synthetic unsplittable 'bundle' section is excluded: it
            // carries the combined recurring total, but a legacy bundle can
            // itemize only ONE member service as a treatment row (an
            // unitemized lawn slice — see server buildServiceSection key
            // 'bundle'). PriceCard would then read that lone row as the whole
            // bundle's per-application headline and understate the plan vs the
            // cadence total accept/billing charges, so the bundle card keeps
            // its combined /mo total.
            preferPerApplicationPrice={section.key !== 'bundle'}
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

        {/* One-time work belonging to THIS service lives inside its service
            box — multi-service plans no longer detach it into a separate card
            (owner 2026-07-10). Termite renders its install ABOVE the price
            (lead variant above); everything else trails the price block. */}
        {sectionSlug === 'termite_bait' ? null : <SectionOneTimeBlock contribution={oneTimeEmbed} />}

        {serviceDetailsRequest ? (
          <ServiceDetailsRequestRow
            token={serviceDetailsRequest.token}
            // RAW section key, not the glass slug: the slug normalizes
            // commercial keys (commercial_mosquito → mosquito) into buttons
            // whose POST the server rejects — it checks the estimate's
            // canonical recurring keys. Unsupported keys hide the row.
            serviceKey={section.key}
            customerEmail={serviceDetailsRequest.customerEmail}
            customerPhone={serviceDetailsRequest.customerPhone}
            // Only the submit-phase lock disables the request — the
            // mirror-section cadence lock (section `disabled`) must not.
            disabled={serviceDetailsRequest.disabled === true}
            // Staff draft preview: render for parity, but inert (no sends).
            preview={serviceDetailsRequest.preview === true}
          />
        ) : null}

        {showGetServiceCta ? (
          <GetServiceTodayCta
            showGuaranteeMicro
            slotMeta={ctaSlotMeta}
            // Synthetic unsplit-bundle sections resolve their terms from the
            // member services; a lone unresolvable key stays terms-neutral.
            microText={glassCtaMicroForKeys(
              Array.isArray(section.memberKeys) && section.memberKeys.length
                ? section.memberKeys
                : [section.key || section.label],
            )}
          />
        ) : null}
      </div>

      {afterPrice}

      {/* "What's included" checklist removed (owner 2026-07-06) — the plan
          card's inclusions already carry this. */}

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

// Phases where slot (re)selection must be inert: 'submitting' has a
// reserve/accept in flight, 'review' holds a live reservation, 'success' is
// booked. 'configure' / 'slot_conflict' / 'reservation_expired' stay out of
// this set — those render the picker for the customer to (re)pick a slot,
// and every path back to them clears the reservation first.
const SLOT_SELECTION_LOCKED_PHASES = new Set(['submitting', 'review', 'success']);

export default function EstimateViewPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // Set from the /data 404 body — true only when the server confirms this
  // token is a real published estimate that expired (see NotFoundCard).
  const [extensionEligible, setExtensionEligible] = useState(false);
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
  // First open slot ymd, reported up by SlotPicker for the hero {date} token.
  const [firstSlotDate, setFirstSlotDate] = useState(null);
  // Slot metadata for the glass slot-aware CTAs/tech chip ("Approve — Tue
  // 9:00 AM") — SlotPicker reports it alongside the id; cleared with it.
  const [selectedSlotMeta, setSelectedSlotMeta] = useState(null);
  // Curated Google-review pool for the glass hero proof strip (PR C) —
  // fetched only when the glass copy is active.
  const featuredReviews = useFeaturedReviews(glassCopyActive(), 12);
  // serviceMode: 'recurring' | 'one_time'. Most estimates default to
  // recurring; structurally one-time estimates are forced to one_time after
  // the data endpoint loads.
  const [serviceMode, setServiceMode] = useState('recurring');
  const [paymentPreference, setPaymentPreference] = useState(null);
  const [ctaPhase, setCtaPhaseState] = useState('configure');
  // Mirrors ctaPhase SYNCHRONOUSLY. ctaPhase is React state, so async work
  // started before a phase change — e.g. a SlotPicker AI slot search —
  // captures the OLD phase in its closure: when it resolved mid-submission
  // (or after the page entered review with a live reservation) its
  // selectSlot(null) passed the state guard and cleared the slot the
  // in-flight accept / held reservation was committing. The ref object is
  // stable across renders, so even a stale callback reads the live value.
  // Every phase transition goes through setCtaPhase below, keeping the ref
  // in lockstep on all submit/exit paths.
  const ctaPhaseRef = useRef('configure');
  const setCtaPhase = useCallback((phase) => {
    ctaPhaseRef.current = phase;
    setCtaPhaseState(phase);
  }, []);
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
  // Live-ref accept lock (same reasoning as ctaPhaseRef): performAccept is
  // also reached with ctaPhaseRef already 'submitting' (handleConfirm's
  // deposit/card-hold exempt fall-through), so it carries its own synchronous
  // single-flight latch — a double-invoke must not double-PUT /accept.
  const acceptInFlightRef = useRef(false);
  // Recurring card-on-file (dark until RECURRING_CARD_ON_FILE).
  // recurringCardIntent holds the live POST /recurring-card-intent response
  // while the Auto Pay capture modal is open.
  const [recurringCardIntent, setRecurringCardIntent] = useState(null);
  const recurringCardSetupIntentIdRef = useRef(null);
  // Server said RECURRING_CARD_REQUIRED but our /data snapshot predates the
  // requirement (flag flipped mid-session, or an exemption changed between
  // /data and /accept) — force the capture branch on the next confirm so the
  // customer isn't stuck re-submitting the same 402 until a full reload.
  const recurringCardForceRef = useRef(false);
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
        // Only one SetupIntent flow is ever live per accept (one-time → card
        // hold; recurring → Auto Pay card), so restore the id into BOTH refs —
        // accept sends each in its own field and the server pins trust to the
        // intent's purpose metadata, so the wrong-lane echo is ignored.
        cardHoldSetupIntentIdRef.current = siFromRedirect;
        recurringCardSetupIntentIdRef.current = siFromRedirect;
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
    // Accepted estimates always evaluate the offer in recurring terms (owner
    // ask 2026-07-09): the accepted page upsells the next recurring service
    // regardless of which mode the customer originally booked. data?.cta —
    // the destructured `cta` binding doesn't exist until after the early
    // returns below.
    () => estimateAddServiceOffer(
      services,
      data?.cta?.terminalState === 'accepted' ? 'recurring' : serviceMode,
      data?.estimate?.membership,
    ),
    [services, serviceMode, data?.cta?.terminalState, data?.estimate?.membership]
  );
  // Download PDF / Share / Print / Portal Login at the top of every estimate
  // render (owner ask 2026-07-09, live review screen) — the same shared bar
  // as the report/pay/receipt/contract pages. The PDF endpoint streams the
  // same proposal generator as the admin download and the emailed attachment.
  const estimateActionBar = (
    <DocumentActionBar
      pdfUrl={`${API_BASE}/estimates/${token}/pdf`}
      pdfFileName="Waves_Estimate.pdf"
      shareTitle="Your Waves estimate"
    />
  );

  useEffect(() => {
    selectedFrequencyRef.current = selectedFrequency;
  }, [selectedFrequency]);

  useEffect(() => {
    setAddServiceRequestState({ status: 'idle', message: '' });
  }, [token, addServiceOffer?.serviceKey]);

  const loadEstimate = useCallback(async ({ preserveSelection = false } = {}) => {
    const isRefresh = initialViewCountedRef.current;
    // Refreshes keep the loaded UI on screen instead of dropping back to the
    // skeleton — a failed refresh used to leave the skeleton up forever
    // because nothing on the error path reset `loading`.
    if (!isRefresh) setLoading(true);
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
      const notFoundBody = await r.json().catch(() => ({}));
      setExtensionEligible(notFoundBody?.extensionRequestEligible === true);
      setNotFound(true);
      setLoading(false);
      return;
    }
    if (!r.ok) {
      setLoading(false);
      throw new Error(`estimate fetch failed: ${r.status}`);
    }
    initialViewCountedRef.current = true;
    // A load can succeed AFTER a 404 set notFound — the expired-screen
    // extension auto-grant revives the estimate and re-fetches — so clear
    // the dead-end state or the loaded data would render the NotFoundCard.
    setNotFound(false);
    setExtensionEligible(false);
    const body = await r.json();
    // Glass COPY default: set the module state BEFORE setData so every
    // glassCopyActive() consumer sees it on the render that paints the loaded
    // page. The marketing copy stays category-scoped server-side; the old
    // ?glass URL override is retired. (The glass THEME itself is unconditional.)
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
    // Live-ref submit lock (mirror of the SlotPicker onSelect guards): the
    // disabled prop freezes the rendered toggles, but a callback retained
    // from before the submit — or a keyboard/synthetic change that skips the
    // disabled attribute — must not reprice the estimate underneath an
    // in-flight reserve/accept.
    if (ctaPhaseRef.current === 'submitting') return;
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
    // Synchronous single-flight guard: React state (`processing`-style flags)
    // lags a double-tap in the same frame — the ref flips before any await,
    // so a second entry can never double-PUT /accept.
    if (acceptInFlightRef.current) return;
    acceptInFlightRef.current = true;
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
          recurringCardSetupIntentId: recurringCardSetupIntentIdRef.current || undefined,
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
        if (r.status === 402 && body.code === 'RECURRING_CARD_REQUIRED') {
          // The Auto Pay card couldn't be verified — drop it so the next
          // confirm re-opens the capture modal. The server is authoritative:
          // force the capture branch even if our /data policy snapshot is
          // stale and still says no card is owed.
          recurringCardSetupIntentIdRef.current = null;
          recurringCardForceRef.current = true;
          throw new Error(body.error || 'Save a card for Auto Pay to confirm your recurring plan.');
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
          if (/existing appointment is no longer available/i.test(body.error || '')) {
            // Not a slot conflict: the customer's already-scheduled visit
            // changed underneath them — there's no slot picker to "pick
            // another" from. Reload so acceptance mode re-derives.
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
    } finally {
      acceptInFlightRef.current = false;
    }
  }, [adminDraftPreview, existingAppointment, loadEstimate, token, selectedSlotId, paymentPreference, serviceMode, selectedFrequency, serviceCadences]);

  // Deposit-gated confirm (flat $49/$99, PR #1660). When the resolved policy
  // requires a deposit and none is collected yet, mint the intent and open
  // the Payment Element modal; accept continues from the modal's onSuccess.
  // Dark-safe: depositPolicy.required is false while ESTIMATE_DEPOSIT_REQUIRED
  // is off, so this falls straight through to performAccept.
  const handleConfirm = useCallback(async () => {
    // Live-ref submit lock (mirror of the onToggleAddOn/SlotPicker guards):
    // a double-tap on Confirm must not double-enter the flow — the second
    // entry would re-mint a deposit/card-hold intent and re-PUT /accept.
    if (ctaPhaseRef.current === 'submitting') return;
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
    // Recurring card-on-file (dark until RECURRING_CARD_ON_FILE). When this
    // recurring accept owes an Auto Pay card and none is captured yet, mint
    // the SetupIntent and open the capture modal; the modal's onSuccess
    // re-enters handleConfirm so the deposit step (still owed alongside the
    // card) runs next. Prepay-annual is exempt — the server re-resolves with
    // the actual preference either way.
    const recurringCardPolicy = data?.recurringCardPolicy;
    if (serviceMode !== 'one_time' && !recurringCardSetupIntentIdRef.current
        && (recurringCardForceRef.current
          || (recurringCardPolicy?.required && paymentPreference !== 'prepay_annual'))) {
      setCtaPhase('submitting');
      setError(null);
      try {
        const r = await fetch(`${API_BASE}/public/estimates/${token}/recurring-card-intent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serviceMode, paymentMethodPreference: paymentPreference }),
        });
        const body = await r.json().catch(() => ({}));
        if (r.status === 409 && body.exemptReason) {
          // Policy says no card owed — fall through to the deposit/accept.
        } else if (!r.ok) {
          throw new Error(body.error || 'Could not start the card setup. Please try again.');
        } else {
          setRecurringCardIntent(body);
          setCtaPhase('review');
          return; // modal takes over; confirm continues from onSuccess
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
    // Card lane supersedes the deposit ("$0 today"): /data already reports
    // required:false when the lane is active, but a stale snapshot (flag
    // flipped mid-session) or a just-captured card must not open the
    // deposit modal — /deposit-intent and the accept gate both 409/exempt
    // it server-side regardless.
    const recurringCardLaneActive = serviceMode !== 'one_time'
      && (data?.recurringCardPolicy?.required || !!recurringCardSetupIntentIdRef.current);
    const depositRequired = !recurringCardLaneActive && (depositPolicy?.required
      || (serviceMode === 'one_time' && depositPolicy?.requiredForOneTime));
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

  // Unlike the card-hold success (which goes straight to accept — the hold
  // supersedes the deposit), the Auto Pay card rides ALONGSIDE the deposit:
  // re-enter handleConfirm so the deposit preflight runs next.
  const handleRecurringCardSuccess = useCallback(async (setupIntentId) => {
    recurringCardSetupIntentIdRef.current = setupIntentId;
    setRecurringCardIntent(null);
    await handleConfirm();
  }, [handleConfirm]);

  const handleRecurringCardCancel = useCallback(() => setRecurringCardIntent(null), []);

  const handleReviewCancel = useCallback(() => {
    setCtaPhase('configure');
    setReservation(null);
    setPaymentPreference(null);
    setError(null);
    // Don't clear selectedSlotId — the customer usually goes back to tweak
    // something and continues with the same slot. The hold stays live
    // server-side (up to 15 min) and is intentionally NOT released here:
    // continuing re-POSTs /reserve, which is idempotent for the customer's
    // own same-slot hold (returns/refreshes it) and supersedes it when a
    // different slot is picked. A /reserve 409 therefore still means a
    // genuine conflict (someone else holds the slot) and keeps its
    // slot_conflict handling.
  }, []);

  // Entering review (and success) swaps the tall configure page for a much
  // shorter layout, but the browser keeps the old scroll offset — the
  // customer who tapped a payment option ~2000px down was left staring at
  // the footer while "Confirm booking" rendered far above the viewport, a
  // dead end they read as "approve does nothing". Bring the active step to
  // them on each phase entry (re-entry after an accept error re-surfaces
  // the confirm card too).
  useEffect(() => {
    if (ctaPhase === 'review' && reservation) {
      const el = document.getElementById(REVIEW_SECTION_ID);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (ctaPhase === 'success') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [ctaPhase, reservation]);

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
    return (
      <Page>
        <Header customerFirstName={null} address={null} />
        <HeaderTailSkeleton />
        {/* First card ≈ the price card's real height at mobile widths. */}
        <SkeletonBlock minHeight={320} />
        <SkeletonBlock minHeight={200} />
      </Page>
    );
  }
  if (notFound || !data) {
    return (
      <Page>
        <NotFoundCard
          token={token}
          extensionEligible={extensionEligible}
          onExtended={() => {
            // Refresh semantics, NOT a first load: the initial 404 never
            // marked the view counted, so a bare loadEstimate() would flip
            // loading=true — swapping this card for the skeleton, stranding
            // the skeleton forever on a network rejection, and losing the
            // "You're all set" state on a 5xx. As a refresh the card stays
            // up until /data actually 200s (then the live estimate renders
            // in place); on failure nothing changes and the card—with its
            // success copy and retry button—survives. The server counts the
            // revived estimate's first real view regardless (?refresh=1 is
            // only honored once viewed_at is set).
            initialViewCountedRef.current = true;
            loadEstimate().catch(() => {});
          }}
        />
      </Page>
    );
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
  // Personalization tokens (owner 2026-07-06): {city} from the service
  // address, {date} from the first open slot (SlotPicker reports it up via
  // onFirstSlotDate; 'tomorrow' until it loads). {first} stays Header's job.
  const estimateCity = (() => {
    const m = /,\s*([^,]+),\s*FL\b/i.exec(String(estimate.address || ''));
    return m ? m[1].trim() : null;
  })();
  const soonestSlotLabel = firstSlotDate
    ? new Date(`${firstSlotDate}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })
    : null;
  // Until a REAL first slot is known (still loading, request failed, or no
  // openings), the "as soon as {date}" clause is dropped rather than guessed
  // — a "tomorrow" placeholder can contradict the slot picker below (codex
  // P2, PR #2439). The residual-token replace guards any future pack string
  // that uses {date} outside that phrase. {city} gets the same treatment:
  // when the address doesn't parse, strip the clause position-safely — a
  // literal 'your city' substitution rendered "your pest-free your city
  // plan is ready!".
  const fillGlassTokens = (str) => {
    if (!str) return str;
    const withCity = estimateCity
      ? String(str).replace(/\{city\}/g, estimateCity)
      : String(str)
        .replace(/\s+in \{city\}/gi, '')
        .replace(/\{city\}\s+home/gi, 'home')
        .replace(/\s*\{city\}\s*/g, ' ')
        .replace(/ {2,}/g, ' ');
    return soonestSlotLabel
      ? withCity.replace(/\{date\}/g, soonestSlotLabel)
      : withCity.replace(/\s*as soon as \{date\}/gi, '').replace(/\{date\}/g, 'soon');
  };
  const headline = fillGlassTokens(glassPack?.heroH1) || UNIVERSAL_HEADLINE;
  // The server's intelligence.title/body outrank the static copy fallbacks in
  // WaveGuardIntelligenceCard, so the glass headline has to be applied to the
  // intelligence payload itself — metrics/signals/satellite stay untouched.
  const intelligenceDisplay = glassPack && estimate.intelligence
    ? { ...estimate.intelligence, title: fillGlassTokens(glassPack.aiTitle), body: glassPack.aiBody }
    : estimate.intelligence;
  const askChips = glassPack?.askChips || pricing.askChips;
  const headerContactProps = {
    customerFirstName: estimate.customerFirstName,
    customerName: estimate.customerName,
    customerEmail: estimate.customerEmail,
    customerPhone: estimate.customerPhone,
    address: estimate.address,
    createdAt: estimate.createdAt,
    expiresAt: estimate.expiresAt,
    slug: estimate.slug,
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
  // Render gate for the glass sticky book bar. The bar displays NO price
  // (owner 2026-07-10) — this only decides whether the selection is PRICED:
  // quote-required and ranged (low-confidence commercial) selections keep
  // the bar hidden, everything else keeps its approve CTA. Multi-service
  // plans gate off the combined frequency's priced-ness WITHOUT computing a
  // displayable total (owner 2026-07-11: no combined totals anywhere;
  // codex 2639 r1: hiding the bar itself for multi-service was a bug).
  const stickyBarPriced = (() => {
    const src = services.length > 1 ? combinedFrequency : currentFrequency;
    if (!src || src.quoteRequired === true || src.monthly == null) return false;
    if (Number(src.lowConfidenceRangePct) > 0) return false;
    return true;
  })();
  const quoteRequiredReason = cta?.quoteRequiredReason || pricing?.quoteRequiredReason || pricing?.quoteRequiredItems?.[0]?.reason || '';
  const isCommercialProposal = cta?.commercialProposal === true || quoteRequiredReason === 'commercial_proposal';
  const proposalPdfEmailed = cta?.proposalPdfEmailed === true;

  // Service/price cards — shared by the live configurator (below) and the
  // read-only recap on an accepted estimate, so reopening an accepted link
  // still shows the services + pricing the customer booked (legacy parity).
  // `readOnly` disables every selector (incl. the add-on toggles) and drops
  // booking-only extras (one-time add-on pickers).
  // `modeOverride` pins the recap to the mode actually accepted — the live
  // `serviceMode` can derive 'recurring' for a one-time acceptance on a mixed
  // estimate, so the accepted recap passes `acceptedServiceMode`.
  const renderQuoteDetailCards = (readOnly = false, modeOverride = null) => {
    const cardsDisabled = readOnly || ctaPhase === 'submitting';
    const mode = modeOverride || serviceMode;
    // Service keys whose one-time fee is waived with annual prepay (the
    // WaveGuard setup fee) — the breakdown card marks these rows with an
    // asterisk + waiver note when they render inside the one-time list.
    const prepayWaivedServices = (pricing.firstVisitFees && pricing.firstVisitFees.length > 0
      ? pricing.firstVisitFees
      : (pricing.setupFee ? [pricing.setupFee] : []))
      .filter((fee) => fee?.waivedWithPrepay === true)
      .map((fee) => fee.service);
    if (mode === 'recurring') {
      return (
        <>
          {/* The plan-level WaveGuard badge is gone (owner directive
              2026-07-10) — the membership shows on each eligible service's
              own card (recurring pest / mosquito) instead. */}

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
                {setupFees.map((fee, i) => <SetupFeeCard key={`${fee.label || 'fee'}-${i}`} fee={fee} waiverBulletCovered={section.isPest === true} />)}
                {!estimate.showOneTimeOption ? (
                  <OneTimeBreakdownCard
                    breakdown={pricing.oneTimeBreakdown}
                    // Only exclude fees that actually render their own
                    // SetupFeeCard — a glass-suppressed card must stay in
                    // this list or the one-time total understates itself
                    // and stops reconciling with the surcharge line.
                    excludeServices={setupFees
                      .filter((fee) => !(glassContent && fee.waivedWithPrepay && section.isPest === true))
                      .map((fee) => fee.service)}
                    prepayWaivedServices={prepayWaivedServices}
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
                // Multi-service plans embed each service's one-time work in
                // its own box; single-service keeps the afterPrice breakdown.
                oneTimeEmbed={services.length > 1 ? section.oneTimeContribution : null}
                // Details-packet request buttons (GATE_SERVICE_DETAILS_PDF
                // kill switch, on by default). The staff draft preview shows
                // the row for customer-view parity but in an inert `preview`
                // state (no real sends, no draft PDF); the read-only accepted
                // recap still omits it entirely.
                serviceDetailsRequest={renderFlags.showServiceDetailsRequest && section.isRecurring && !readOnly
                  ? { token, customerEmail: estimate.customerEmail, customerPhone: estimate.customerPhone, disabled: cardsDisabled, preview: adminDraftPreview }
                  : null}
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

          {/* The combined "Recurring total" card was removed (owner directive
              2026-07-07) — the per-service boxes and the sticky book bar carry
              the bundle's monthly price. It returns ONLY to itemize a plan-wide
              credit (e.g. Referral Credit) and show the net: the per-service
              cards are pre-credit, so without this the credit + final price
              would never appear on a split multi-service plan. Renders nothing
              when there's no credit, so no-credit bundles stay unchanged. */}
          {services.length > 1 ? (
            <PlanTotalSummary
              combined={pricing.combinedRecurring}
              selectedFrequency={combinedFrequency}
              // Payload-level plan credit: gate/label evidence for selections
              // whose row-level discount fields are unavailable (combo overlays
              // keep only the base row's) — survives unless EVERY priced
              // frequency suppresses the credit.
              planDiscount={pricing.manualDiscount || null}
              // Sum of the per-service cards at their SELECTED cadence — these are
              // pre-credit (WaveGuard-net), so subtotal − net = the actual credit.
              // Mirrors each ServiceSection's frequency resolution.
              preCreditMonthly={services.reduce((sum, s) => {
                if (!s?.isRecurring) return sum;
                const freqs = Array.isArray(s.frequencies) ? s.frequencies : [];
                const cur = freqs.find((f) => f.key === selected[s.key]) || freqs[0] || null;
                const m = Number(cur?.monthly);
                return sum + (Number.isFinite(m) ? m : 0);
              }, 0)}
            />
          ) : null}

          {/* One guarantee line for the whole plan — not one per box. */}
          {services.length > 1 ? (
            <div style={{ textAlign: 'center', fontSize: 16, color: ESTIMATE_TEXT, marginTop: 12, lineHeight: 1.5 }}>
              Try us risk-free — 90-day money-back guarantee.
            </div>
          ) : null}

          {!readOnly && canShowSlotPicker && services.length > 1 ? <GetServiceTodayCta showGuaranteeMicro slotMeta={glassContent ? selectedSlotMeta : null} microText={glassCtaMicroForKeys(services.map((s) => s?.key || s?.label))} /> : null}

          {services.length > 1 && renderFlags.showWaveGuardSetupFee ? (
            (pricing.firstVisitFees && pricing.firstVisitFees.length > 0
              ? pricing.firstVisitFees
              : (pricing.setupFee ? [pricing.setupFee] : [])
            ).map((fee, i) => <SetupFeeCard key={`${fee.label || 'fee'}-${i}`} fee={fee} waiverBulletCovered={services.some((s) => s?.isPest === true)} />)
          ) : null}

          {services.length > 1 && !estimate.showOneTimeOption ? (
            <OneTimeBreakdownCard
              breakdown={pricing.oneTimeBreakdown}
              // Mirror of the single-service path: keep glass-suppressed
              // setup fees in the breakdown so the total stays honest.
              // Items embedded inside their own service box
              // (section.oneTimeContribution) are excluded — this card only
              // keeps one-time work that has no rendered service section,
              // and hides entirely when nothing is left.
              excludeServices={[
                ...(pricing.firstVisitFees || [])
                  .filter((fee) => !(glassContent && fee.waivedWithPrepay && services.some((s) => s?.isPest === true)))
                  .map((fee) => fee.service),
                // Identity keys, not bare service strings — embedded rows
                // without a `service` (label-normalized termite installs)
                // must still be excluded or they'd total twice. Mirror
                // SectionOneTimeBlock's quote-required filter: rows it
                // refuses to render never actually embed, so excluding them
                // here would make the required work vanish from the page
                // entirely instead of showing its "Quote Required" row.
                ...services.flatMap((s) => (s?.oneTimeContribution?.items || [])
                  .filter((item) => item && item.quoteRequired !== true && item.kind !== 'quote_required')
                  .map((item) => oneTimeRowIdentityKey(item))),
              ]}
              prepayWaivedServices={prepayWaivedServices}
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
                  // This one-time configure layout is what renders while
                  // ctaPhase is 'submitting' (reserve/accept in flight) — a
                  // toggle mid-submit would reprice the booking underneath
                  // the request. readOnly is false on this branch, so this
                  // is exactly the submit lock.
                  disabled={cardsDisabled}
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
    // A commercial proposal is quote_required by design but its terminal card
    // says "Your formal proposal is ready." — the generic "in the works" hero
    // would contradict it, so proposals get their own status statement.
    const stateHero = cta.terminalState === 'quote_required' && isCommercialProposal
      ? { h1: 'Hello {first}, your formal proposal is ready.', eyebrow: 'Your commercial proposal' }
      : TERMINAL_HERO[cta.terminalState] || null;
    if (cta.terminalState === 'accepted') {
      // Accepted = concise onboarding page (owner ask 2026-07-09): booked
      // hero, the booked-visit card, the Waves app invite, and the
      // add-service upsell. The sales machinery — contact/estimate-# block,
      // AI price-intelligence, pricing recap, report showcase, reviews, GBP
      // proof — is deliberately GONE: they already said yes, and the PDF in
      // the action bar carries the what-did-I-agree-to reference.
      return (
        <Page>
          {adminDraftPreview ? <DraftPreviewBanner /> : null}
          {/* Doc tools ABOVE the hero on every estimate (owner 2026-07-09). */}
          {estimateActionBar}
          <Header
            customerFirstName={estimate.customerFirstName}
            serviceLabel={getServiceLabel(currentFrequency, estimate, pricing, estimate.acceptedServiceMode || null)}
            headline={stateHero?.h1 || headline}
            eyebrowOverride={stateHero ? stateHero.eyebrow : null}
          />
          <TerminalStateCard
            state="accepted"
            customerFirstName={estimate.customerFirstName}
            address={estimate.address}
            // Booked + upcoming visit → show the date, not "we'll follow up".
            appointmentLabel={existingAppointment ? formatAppointmentLabel(existingAppointment) : null}
            appointmentServiceType={existingAppointment?.serviceType || null}
          />
          <AppShowcaseCard />
          <EstimateAddServiceRequestCard
            offer={addServiceOffer}
            requestState={addServiceRequestState}
            onRequest={handleAddServiceRequest}
          />
        </Page>
      );
    }
    return (
      <Page>
        {adminDraftPreview ? <DraftPreviewBanner /> : null}
        {estimateActionBar}
        <Header
          {...headerContactProps}
          serviceLabel={getServiceLabel(currentFrequency, estimate, pricing)}
          headline={stateHero?.h1 || headline}
          eyebrowOverride={stateHero ? stateHero.eyebrow : (glassPack?.eyebrow || null)}
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
        />
        <AppShowcaseCard />
        <CustomerReviews />
        <GoogleProfilesCard />
      </Page>
    );
  }

  if (ctaPhase === 'success') {
    return (
      <Page>
        {estimateActionBar}
        <Header
          {...headerContactProps}
          serviceLabel={getServiceLabel(currentFrequency, estimate, pricing, serviceMode)}
          // Just accepted — the booked hero, not the sales pitch.
          headline={TERMINAL_HERO.accepted.h1}
          eyebrowOverride={TERMINAL_HERO.accepted.eyebrow}
        />
        <SuccessCard
          acceptResult={acceptResult}
          // First-visit line (owner ask 2026-07-12): the slot the customer
          // just booked (kept in state through accept) or their validated
          // existing appointment; null renders the classic card.
          appointmentLabel={existingAppointment
            ? formatAppointmentLabel(existingAppointment)
            : (selectedSlotMeta?.date
              ? `${new Date(`${selectedSlotMeta.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })}${selectedSlotMeta.time ? ` · ${selectedSlotMeta.time}` : ''}`
              : null)}
          recurring={serviceMode !== 'one_time'}
        />
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
        {estimateActionBar}
        <Header
          {...headerContactProps}
          serviceLabel={getServiceLabel(currentFrequency, estimate, pricing)}
          headline={headline}
          eyebrowOverride={glassPack?.eyebrow || null}
          subline={fillGlassTokens(glassPack?.heroSub) || null}
        />
        {renderQuoteDetailCards(true)}
        {aiPanelBlock}
        <ReviewBeforeBookingCard reason={cta?.reviewReason} />
        <AppShowcaseCard />
        <CustomerReviews />
        <GoogleProfilesCard />
      </Page>
    );
  }

  return (
    <Page>
      {adminDraftPreview ? <DraftPreviewBanner /> : null}
      {estimateActionBar}
      <Header
        {...headerContactProps}
        serviceLabel={getServiceLabel(currentFrequency, estimate, pricing)}
        headline={headline}
        eyebrowOverride={glassPack?.eyebrow || null}
        // The booking-forward subline only belongs where booking is still on
        // the table — terminal and success states keep the plain hero.
        subline={fillGlassTokens(glassPack?.heroSub) || null}
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
                oneTimeExtrasTotal={oneTimeExtrasForPaymentNote(pricing, estimate, serviceMode)}
                setupFee={pricing.setupFee || null}
                annualPrepayEligible={pricing.annualPrepayEligible === true}
                invoiceMode={!!estimate.billByInvoice}
                siteConfirmationHold={!!estimate.siteConfirmationHold}
                selectedFrequency={combinedFrequency}
                cardHold={data?.cardHoldPolicy || null}
              />
            </>
          ) : null}
          {/* Anchor sits directly on the confirm card — in the existing-
              appointment mode the appointment + payment cards stack above
              ReviewPhase, and anchoring the group leaves the confirm action
              below the fold on mobile (Codex #2545). */}
          <div id={REVIEW_SECTION_ID} style={{ scrollMarginTop: 76 }}>
          {/* Inside the scroll anchor so a failed confirm scrolls the error
              into view along with the confirm card. Cleared on every retry
              (performAccept/handleConfirm) and on Go back (handleReviewCancel). */}
          <EstimateErrorBanner error={error} />
          <ReviewPhase
            slotId={selectedSlotId}
            slotMeta={selectedSlotMeta}
            existingAppointment={existingAppointment}
            paymentPreference={paymentPreference}
            secondsRemaining={countdownSeconds}
            onConfirm={handleConfirm}
            onCancel={handleReviewCancel}
            submitting={ctaPhase === 'submitting'}
            invoiceMode={!!estimate.billByInvoice}
            invoiceOnly={invoiceOnlyAccept}
            siteConfirmationHold={!!estimate.siteConfirmationHold}
            manualScheduling={!!reservation?.manualScheduling}
            serviceMode={serviceMode}
            depositNote={serviceMode === 'one_time' && data?.cardHoldPolicy?.requiredForOneTime
              ? `A card on file holds your visit — not charged today. We charge the final total after completion; a ${fmtMoney(data.cardHoldPolicy.noShowFeeAmount)} fee applies only if you cancel within ${data.cardHoldPolicy.cancelWindowHours} hours or aren't home. ${CARD_SURCHARGE_DISCLOSURE}`
              : ((data?.depositPolicy?.required || (serviceMode === 'one_time' && data?.depositPolicy?.requiredForOneTime))
                ? (invoiceOnlyAccept
                  ? `A ${fmtMoney(data.depositPolicy.oneTimeAmount)} deposit is due today — it is applied to your invoice.`
                  : paymentPreference === 'prepay_annual'
                    ? `A ${fmtMoney(data.depositPolicy.recurringAmount)} deposit is due today to hold your spot — it is applied to your annual prepay invoice.`
                    : `A ${fmtMoney(serviceMode === 'one_time' ? data.depositPolicy.oneTimeAmount : data.depositPolicy.recurringAmount)} deposit is due today to hold your spot — it is applied to your first invoice.${serviceMode !== 'one_time' && data?.recurringCardPolicy?.required ? ' You’ll also save a card for Auto Pay — after each completed service, it’s charged automatically.' : ''}`)
                // Deposit retired (card-on-file booking spec): the Auto Pay
                // disclosure must stand on its own once no deposit is owed —
                // the recurring accept is "$0 today, charged per application".
                : (serviceMode !== 'one_time' && data?.recurringCardPolicy?.required && paymentPreference !== 'prepay_annual'
                  ? `Nothing is charged today. Your card on file powers Auto Pay — after each completed service, that service's amount is charged automatically. ${CARD_SURCHARGE_DISCLOSURE}`
                  : null))}
          />
          </div>
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
          {recurringCardIntent ? (
            <RecurringCardModal
              intent={recurringCardIntent}
              onSuccess={handleRecurringCardSuccess}
              onCancel={handleRecurringCardCancel}
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
              // The configure layout is what renders while ctaPhase is
              // 'submitting' (reserve/accept in flight) — a mode flip
              // mid-submit would clear the slot the request is committing.
              disabled={ctaPhase === 'submitting'}
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

          <div id={PRICE_SECTION_ID} style={{ scrollMarginTop: 76 }}>
            {renderQuoteDetailCards()}
          </div>

          {/* Waves AI panel + Ask bar render AFTER the price/plan (matches the
              server-rendered estimate's order: price → Waves AI → booking) so
              the customer sees the price first. Glass reorders per the
              approved section positioning (schedule directly after price;
              why-price-custom, reviews, app, Ask, and the lawn upsell follow
              below) — only the membership card keeps this spot. */}
          {glassContent ? <MembershipCard membership={estimate.membership} /> : aiPanelBlock}

          <div id={BOOKING_SECTION_ID} style={{ scrollMarginTop: 76 }}>
            {canShowSlotPicker ? (
              // SlotPicker takes no disabled prop, so freeze it from out here
              // while a reserve/accept is in flight (ctaPhase 'submitting'
              // renders this configure layout): pointer-events blocks taps,
              // the guarded handlers block keyboard selection, and the wrapper
              // stays mounted either way so the slot fetch doesn't restart.
              // The handler guards read ctaPhaseRef, NOT ctaPhase — a slot
              // search started before the submit retains a callback with the
              // old phase in its closure, and only the ref stays live there.
              // They reject on every locked phase, not just 'submitting': a
              // pre-reserve search can also resolve after the page enters
              // review (or after a failed accept returns to review), where
              // its selectSlot(null) would clear the slot behind the
              // still-live reservation.
              <div
                aria-disabled={ctaPhase === 'submitting' || undefined}
                style={ctaPhase === 'submitting' ? { pointerEvents: 'none', opacity: 0.65 } : undefined}
              >
                <SlotPicker
                  token={token}
                  askToken={estimate.askToken}
                  selectedSlotId={selectedSlotId}
                  onSelect={(slotId) => { if (!SLOT_SELECTION_LOCKED_PHASES.has(ctaPhaseRef.current)) setSelectedSlotId(slotId); }}
                  onSelectMeta={(meta) => { if (!SLOT_SELECTION_LOCKED_PHASES.has(ctaPhaseRef.current)) setSelectedSlotMeta(meta); }}
                  selectedSlotFallbackMeta={selectedSlotMeta}
                  licenseNumber={estimate.licenseNumber}
                  refreshSignal={slotsRefreshSignal}
                  serviceMode={serviceMode}
                  selectedFrequency={selectedFrequency}
                  onFirstSlotDate={setFirstSlotDate}
                  cityLabel={estimateCity}
                />
              </div>
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
            <div id={PAYMENT_SECTION_ID} style={{ scrollMarginTop: 76 }}>
              <PaymentPreferenceButtons
                onSelect={handlePaymentChoice}
                // Draft preview: dead from first render (Codex rd 1), not just
                // guarded on click — but rendered, so staff still see the exact
                // payment options the customer will get. Forcing cta.canAccept
                // false server-side would fall through to the null-terminal
                // "expired" card and destroy the preview's purpose.
                disabled={adminDraftPreview || ctaPhase === 'submitting'}
                serviceMode={serviceMode}
                oneTimeExtrasTotal={oneTimeExtrasForPaymentNote(pricing, estimate, serviceMode)}
                setupFee={pricing.setupFee || null}
                annualPrepayEligible={pricing.annualPrepayEligible === true}
                invoiceMode={!!estimate.billByInvoice}
                invoiceOnly={invoiceOnlyAccept}
                siteConfirmationHold={!!estimate.siteConfirmationHold}
                selectedFrequency={combinedFrequency}
                cardHold={data?.cardHoldPolicy || null}
              />
            </div>
          ) : null}

          <EstimateErrorBanner error={error} />

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
                  ? <GlassSectionCta label="This price fits my home — lock it in →" onClick={scrollToBookingSection} style={{ justifyContent: 'center' }} />
                  : null}
              />
              {/* GBP proof directly after the review quotes. The report
                  showcase card was removed from the estimate page entirely
                  (owner 2026-07-11). This branch's approved reviews-before-app
                  order is preserved. */}
              <CustomerReviews onJoinNeighbors={canShowSlotPicker ? scrollToBookingSection : null} />
              <AppShowcaseCard onBookToday={canShowSlotPicker ? scrollToBookingSection : null} />
              {/* GBP proof directly above Ask Waves (owner 2026-07-06). */}
              <GoogleProfilesCard />
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
          <GoogleProfilesCard />
        </>
      )}
      {/* Sticky mobile book bar (glass, ≤640px via CSS): live price/period +
          slot-aware approve. Configure phase only — during slot review it
          would cover the confirm/cancel buttons. */}
      {glassContent && canShowSlotPicker && serviceMode === 'recurring' && !(ctaPhase === 'review' && reservation) ? (
        <GlassStickyBookBar
          show={stickyBarPriced}
          slotMeta={selectedSlotMeta}
          onApprove={selectedSlotMeta ? scrollToPaymentSection : scrollToBookingSection}
        />
      ) : null}
    </Page>
  );
}
