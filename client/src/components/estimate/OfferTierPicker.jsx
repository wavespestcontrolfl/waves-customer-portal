/**
 * Good / Better / Best plan picker for the customer estimate page
 * (GATE_ESTIMATE_OFFER_TIERS, owner 2026-10-05). Replaces the
 * [Recurring | One-time] toggle on an eligible estimate:
 *
 *   good   — one visit (the one-time price)
 *   better — the pest-only plan, preselected "Most popular"
 *   best   — the full quoted bundle, with the WaveGuard saving called out
 *
 * Every amount, cadence and discount comes from the server's payload
 * (`pricing.offerTiers`, `pricing.frequencies`) — nothing is priced here. The
 * only constants are display copy. House style: estimateInnerBox tiles and W
 * tokens (same idiom as SecurePlanChoice), so the glass walker restyles it.
 */
import React, { useEffect, useState } from 'react';
import { estimateCard, estimateInnerBox } from './cardStyles';
import { perApplicationNetForFrequency } from './PriceCard';
import { CUSTOMER_SURFACE } from '../../theme-customer';
import { FS, FW, LH } from '../../theme-doc';
import { W, waveGuardChipStyle } from './tokens';
import { fmtMoney } from '../../lib/money';

const NAVY = W.blueDeeper;
const RING = '0 0 0 4px rgba(4,57,94,.18)';

const COMPANION_NAMES = {
  lawn_care: 'lawn care',
  tree_shrub: 'tree & shrub care',
  mosquito: 'mosquito',
};
const COMPANION_SHORT = {
  lawn_care: 'lawn',
  tree_shrub: 'tree & shrub',
  mosquito: 'mosquito',
};
// WaveGuard membership discount by tier, used only when the server did not
// stamp a percentage on the tier's combined summary.
const WAVEGUARD_PCT = { bronze: 0, silver: 10, gold: 15, platinum: 20 };
const CADENCE_VISITS = { quarterly: 4, bi_monthly: 6, monthly: 12 };

function humanizeKey(key) {
  return String(key || '').replace(/_/g, ' ').trim();
}

// `tier.services` is the server's list of service keys (the tier's own
// `sections` are the page's rendering objects, not read here).
function tierServiceKeys(tier) {
  return (Array.isArray(tier?.services) ? tier.services : []).filter((key) => typeof key === 'string' && key);
}

function companionKeys(tier) {
  return tierServiceKeys(tier).filter((key) => key !== 'pest_control' && key !== 'bundle');
}

function pestSectionDefaultKey(pricing) {
  const sections = Array.isArray(pricing?.services) ? pricing.services : [];
  const section = sections.find((s) => s?.key === 'pest_control') || sections.find((s) => s?.key === 'bundle') || sections[0];
  return section?.defaultFrequencyKey || null;
}

function defaultFrequency(frequencies, preferredKey) {
  const list = Array.isArray(frequencies) ? frequencies : [];
  return list.find((f) => f?.key === preferredKey)
    || list.find((f) => f?.recommended === true || f?.selected === true)
    || list[0]
    || null;
}

function pestVisitsFor(frequency) {
  if (!frequency) return null;
  const direct = Number(frequency.visitsPerYear);
  if (direct > 0) return direct;
  const rows = Array.isArray(frequency.perServiceTreatments) ? frequency.perServiceTreatments : [];
  const pest = rows.find((row) => row?.service === 'pest_control') || (rows.length === 1 ? rows[0] : null);
  const fromRow = Number(pest?.visitsPerYear);
  if (fromRow > 0) return fromRow;
  return CADENCE_VISITS[frequency.key] || null;
}

function discountPctFor(tier) {
  const stamped = Number(tier?.combinedRecurring?.waveGuardDiscountPct);
  if (stamped > 0) return Math.round(stamped * 100);
  const key = String(tier?.waveGuardTier || '').replace(/^WaveGuard\s+/i, '').trim().toLowerCase();
  return WAVEGUARD_PCT[key] || 0;
}

function useNarrow() {
  const query = '(max-width: 639px)';
  const read = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false);
  const [narrow, setNarrow] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(query);
    const onChange = () => setNarrow(mql.matches);
    onChange();
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onChange);
    else if (typeof mql.addListener === 'function') mql.addListener(onChange);
    return () => {
      if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', onChange);
      else if (typeof mql.removeListener === 'function') mql.removeListener(onChange);
    };
  }, []);
  return narrow;
}

function Pill({ children, style }) {
  return (
    <span style={{
      display: 'inline-block',
      fontSize: FS.body,
      fontWeight: FW.bold,
      lineHeight: LH.snug,
      padding: '3px 10px',
      borderRadius: 999,
      ...style,
    }}
    >
      {children}
    </span>
  );
}

function tileModel(tier, tiers, pricing, estimate = null) {
  const key = tier.key;
  // The server's guarantee decision (serviceMixMakesNoGuaranteeClaim): on a
  // no-guarantee estimate no tile may claim a callback or the Waves
  // Guarantee — the same flag the price cards honor.
  const noGuarantee = !!(estimate?.noGuaranteeClaims || estimate?.noEstimateWideGuarantee);
  if (key === 'good') {
    return {
      eyebrow: 'GOOD',
      name: 'One-time visit',
      price: fmtMoney(tier.oneTimeTotal),
      unit: 'one visit',
      caption: noGuarantee ? 'No plan, no commitment' : 'No plan, no commitment · 30-day callback',
      chips: [],
    };
  }
  if (key === 'better') {
    const frequency = defaultFrequency(pricing?.frequencies, pestSectionDefaultKey(pricing));
    const perApp = perApplicationNetForFrequency(frequency) ?? (Number(frequency?.perVisit) > 0 ? Number(frequency.perVisit) : null);
    const visits = pestVisitsFor(frequency);
    return {
      eyebrow: 'BETTER',
      name: 'Pest control plan',
      price: perApp != null ? fmtMoney(perApp) : null,
      unit: perApp != null ? '/ application' : null,
      caption: `${visits ? `${visits} visits a year` : 'Year-round visits'}${noGuarantee ? '' : ' · Waves Guarantee'}`,
      chips: [{ tone: 'navy', text: 'Most popular' }],
    };
  }
  // best
  const better = tiers.find((t) => t?.key === 'better') || null;
  const betterFrequency = better ? defaultFrequency(pricing?.frequencies, pestSectionDefaultKey(pricing)) : null;
  const bestFrequency = defaultFrequency(tier.frequencies, betterFrequency?.key || null);
  const companions = companionKeys(tier);
  const name = companions.length
    ? `Pest + ${companions.map((k) => COMPANION_NAMES[k] || humanizeKey(k)).join(' + ')}`
    : (tier.label || 'Pest control + companion plan');
  const rows = Array.isArray(bestFrequency?.perServiceTreatments) ? bestFrequency.perServiceTreatments : [];
  const pestVisits = pestVisitsFor(bestFrequency);
  const parts = [`${pestVisits ? `${pestVisits}×/yr ` : ''}pest`];
  for (const k of companions) {
    const row = rows.find((r) => r?.service === k);
    const visits = Number(row?.visitsPerYear);
    parts.push(`${COMPANION_SHORT[k] || humanizeKey(k)}${visits > 0 ? ` ${visits}×/yr` : ''}`);
  }
  // Per application is the estimate surface's one billing unit (owner
  // 2026-07-11); the tile leads with each program's net per-application
  // figure, never a monthly spread.
  const perAppParts = rows
    .map((r) => (Number(r?.displayPrice) > 0 ? Number(r.displayPrice) : (Number(r?.perTreatment) > 0 ? Number(r.perTreatment) : null)))
    .filter((n) => n != null);
  const pct = discountPctFor(tier);
  const chips = [];
  if (pct > 0) {
    chips.push({ tone: 'green', text: `Save ${pct}% on ${tierServiceKeys(tier).length > 2 ? 'all' : 'both'}` });
    if (tier.waveGuardTier) chips.push({ tone: 'metal', text: `WaveGuard ${String(tier.waveGuardTier).replace(/^WaveGuard\s+/i, '')}`, tier: tier.waveGuardTier });
  }
  return {
    eyebrow: 'BEST',
    name,
    price: perAppParts.length ? perAppParts.map((n) => fmtMoney(n)).join(' + ') : null,
    unit: perAppParts.length ? '/ application' : null,
    caption: parts.join(' · '),
    chips,
  };
}

function chipStyle(chip) {
  if (chip.tone === 'navy') return { background: NAVY, color: W.white, border: `1px solid ${NAVY}` };
  if (chip.tone === 'green') return { background: W.greenLight, color: W.green, border: '1px solid #BBF7D0' };
  return waveGuardChipStyle(chip.tier);
}

export default function OfferTierPicker({ tiers, selectedKey, onSelect, disabled = false, pricing = null, estimate = null }) {
  const narrow = useNarrow();
  if (!Array.isArray(tiers) || tiers.length === 0) return null;

  return (
    <div style={estimateCard()}>
      <div style={{
        fontSize: 14, fontWeight: 700, color: W.textCaption,
        textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 8,
      }}
      >
        Choose your plan
      </div>
      <h2 style={{
        fontSize: FS.h2,
        fontWeight: FW.medium,
        color: NAVY,
        lineHeight: LH.heading,
        margin: 0,
        marginBottom: 4,
      }}
      >
        Pick the option that fits
      </h2>
      <div style={{ fontSize: 14, color: CUSTOMER_SURFACE.muted, lineHeight: 1.5, marginBottom: 20 }}>
        You can change this any time before you approve.
      </div>
      <div
        role="radiogroup"
        aria-label="Choose your plan"
        style={{
          display: 'grid',
          gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : 'repeat(3, minmax(0, 1fr))',
          gap: 12,
        }}
      >
        {tiers.map((tier) => {
          const model = tileModel(tier, tiers, pricing, estimate);
          const selected = tier.key === selectedKey;
          return (
            <button
              key={tier.key}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => { if (!disabled) onSelect?.(tier.key); }}
              style={{
                ...estimateInnerBox({
                  position: 'relative',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 6,
                  width: '100%',
                  textAlign: 'left',
                  padding: '16px 16px 14px',
                  cursor: disabled ? 'default' : 'pointer',
                  opacity: disabled ? 0.6 : 1,
                  font: 'inherit',
                }),
                ...(selected
                  ? { border: `2px solid ${NAVY}`, boxShadow: RING, background: '#F8FCFE' }
                  : {}),
              }}
            >
              <span style={{
                fontSize: 14, fontWeight: FW.bold, color: W.textCaption,
                textTransform: 'uppercase', letterSpacing: '0.12em',
              }}
              >
                {model.eyebrow}
              </span>
              <span style={{ fontSize: FS.bodyLg, fontWeight: FW.bold, color: NAVY, lineHeight: LH.snug }}>
                {model.name}
              </span>
              <span style={{ lineHeight: LH.snug }}>
                {model.price ? (
                  <span style={{ fontSize: 22, fontWeight: FW.bold, color: NAVY }}>{model.price}</span>
                ) : null}
                {model.unit ? (
                  <span style={{ fontSize: 14, fontWeight: FW.semibold, color: W.textCaption }}>{` ${model.unit}`}</span>
                ) : null}
              </span>
              <span style={{ fontSize: 14, color: W.textCaption, lineHeight: LH.body }}>
                {model.caption}
              </span>
              {model.chips.length ? (
                <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
                  {model.chips.map((chip) => (
                    <Pill key={chip.text} style={chipStyle(chip)}>{chip.text}</Pill>
                  ))}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
