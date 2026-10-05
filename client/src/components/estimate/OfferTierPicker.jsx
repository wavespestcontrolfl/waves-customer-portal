/**
 * Good / Better / Best picker for a pest + lawn estimate (owner 2026-10-05).
 *
 * A VIEW over the service opt-out rail, not a pricing path: the server's
 * `offerTiers` block carries every number (the other state's figures are the
 * rail's own dry run), and a tile change is an ordinary rail move the page
 * previews and confirms before anything is written. This component only
 * renders the block and the confirm step the page hands it — no price,
 * discount or cadence constant lives here.
 *
 *   Best   = pest + lawn as quoted            (block state 'best')
 *   Better = lawn removed, recurring pest     (state 'pest_only', recurring)
 *   Good   = the one-time pest visit          (state 'pest_only', one-time)
 *
 * The only price unit on the page is "/ application" (repo rule): never
 * "per visit", never a monthly or yearly plan total.
 */
import React, { useEffect, useState } from 'react';
import { estimateCard, estimateInnerBox } from './cardStyles';
import { W, waveGuardChipStyle } from './tokens';
import { fmtMoney } from '../../lib/money';
import { CUSTOMER_SURFACE } from '../../theme-customer';
import { FS, FW, LH } from '../../theme-doc';

const NAVY = W.blueDeeper;
const PEST_KEY = 'pest_control';

const TILE_NAMES = {
  good: 'One-time visit',
  better: 'Pest control plan',
};

function bestTileName(tiers) {
  return `Pest + ${String(tiers?.companionLabel || 'lawn care').toLowerCase()}`;
}

export function offerTierName(key, tiers) {
  return key === 'best' ? bestTileName(tiers) : TILE_NAMES[key] || '';
}

// matchMedia is missing in some runtimes (older webviews, jsdom): fall back
// to the one-column layout rather than throwing.
function useMinWidth(px) {
  const query = `(min-width: ${px}px)`;
  const read = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? !!window.matchMedia(query).matches
    : false);
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(!!mql.matches);
    onChange();
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    if (typeof mql.addListener === 'function') {
      mql.addListener(onChange);
      return () => mql.removeListener(onChange);
    }
    return undefined;
  }, [query]);
  return matches;
}

function pestRow(view) {
  return (view?.rows || []).find((row) => row?.service === PEST_KEY) || null;
}

function positive(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function Chip({ style, children }) {
  return (
    <span style={{
      display: 'inline-block',
      fontSize: FS.body,
      fontWeight: FW.bold,
      lineHeight: LH.snug,
      padding: '3px 9px',
      borderRadius: 999,
      ...style,
    }}
    >
      {children}
    </span>
  );
}

function Tile({ selected, disabled, onClick, eyebrow, name, price, caption, extra, chips }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      style={{
        ...estimateInnerBox({
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 6,
          width: '100%',
          height: '100%',
          textAlign: 'left',
          padding: '14px 14px 13px',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled && !selected ? 0.6 : 1,
          font: 'inherit',
        }),
        ...(selected
          ? { border: `2px solid ${NAVY}`, boxShadow: `0 0 0 2px ${W.blueLight}`, background: '#F8FCFE' }
          : {}),
      }}
    >
      <span style={{ fontSize: FS.body, fontWeight: FW.bold, letterSpacing: '0.06em', color: W.textCaption }}>
        {eyebrow}
      </span>
      <span style={{ fontSize: FS.bodyLg, fontWeight: FW.bold, color: NAVY, lineHeight: LH.snug }}>{name}</span>
      <span style={{ fontSize: FS.sub, fontWeight: FW.bold, color: NAVY, lineHeight: LH.snug }}>
        {price}
        <span style={{ fontSize: FS.body, fontWeight: FW.semibold, color: W.textCaption }}> / application</span>
      </span>
      <span style={{ fontSize: FS.body, color: W.textBody, lineHeight: LH.body }}>{caption}</span>
      {extra ? (
        <span style={{ fontSize: FS.body, color: W.textBody, lineHeight: LH.body }}>{extra}</span>
      ) : null}
      {chips && chips.length ? (
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>{chips}</span>
      ) : null}
    </button>
  );
}

function cadenceCaption(rows, companionKey, companionLabel) {
  const word = (row) => (row.service === companionKey
    ? String(companionLabel || 'lawn').toLowerCase().replace(/ care$/, '')
    : 'pest');
  const parts = (rows || [])
    .map((row) => ({ word: word(row), n: positive(row?.visitsPerYear) }))
    .filter((part) => part.n);
  if (!parts.length) return null;
  return `${parts.map((part) => `${part.n} ${part.word}`).join(' and ')} applications a year`;
}

export default function OfferTierPicker({
  tiers,
  selectedKey,
  onSelect,
  disabled = false,
  estimate = null,
  change = null,
}) {
  const wide = useMinWidth(640);
  if (!tiers) return null;

  const noGuarantee = !!(estimate?.noGuaranteeClaims || estimate?.noEstimateWideGuarantee);
  const phase = change?.phase || 'idle';
  const busy = phase === 'previewing' || phase === 'committing';
  const tilesDisabled = disabled || busy;
  const { good, better, best } = tiers;
  const betterPest = pestRow(better);
  const bestPest = pestRow(best);
  const betterPestPrice = positive(betterPest?.perApplication);
  const bestPestPrice = positive(bestPest?.perApplication);
  const saving = betterPestPrice != null && bestPestPrice != null && bestPestPrice < betterPestPrice
    ? Math.round((betterPestPrice - bestPestPrice) * 100) / 100
    : null;

  const firstVisitLine = (view) => (positive(view?.oneTimeTotal)
    ? `+ ${fmtMoney(view.oneTimeTotal)} one-time first-visit charges`
    : null);

  const tiles = [];
  if (good) {
    tiles.push(
      <Tile
        key="good"
        selected={selectedKey === 'good'}
        disabled={tilesDisabled}
        onClick={() => onSelect && onSelect('good')}
        eyebrow="GOOD"
        name={TILE_NAMES.good}
        price={fmtMoney(good.oneTimeTotal)}
        caption={`One application · no plan, no commitment${noGuarantee ? '' : ' · 30-day callback'}`}
      />,
    );
  }
  if (better && betterPestPrice != null) {
    const cadence = cadenceCaption(better.rows, tiers.companionKey, tiers.companionLabel);
    const base = (positive(betterPest?.visitsPerYear) ? `${betterPest.visitsPerYear} applications a year` : null)
      || cadence
      || 'Year-round service';
    tiles.push(
      <Tile
        key="better"
        selected={selectedKey === 'better'}
        disabled={tilesDisabled}
        onClick={() => onSelect && onSelect('better')}
        eyebrow="BETTER"
        name={TILE_NAMES.better}
        price={fmtMoney(betterPestPrice)}
        caption={`${base}${noGuarantee ? '' : ' · Waves Guarantee'}`}
        extra={firstVisitLine(better)}
        chips={[<Chip key="pop" style={{ background: NAVY, color: W.white }}>Most popular</Chip>]}
      />,
    );
  }
  if (best && (best.rows || []).length) {
    const chips = [];
    if (best.waveGuardTier) {
      chips.push(
        <Chip key="wg" style={waveGuardChipStyle(best.waveGuardTier)}>{`WaveGuard ${best.waveGuardTier}`}</Chip>,
      );
    }
    if (saving != null) {
      chips.push(
        <Chip key="save" style={{ background: W.successWash, color: W.green, border: `1px solid ${W.greenLight}` }}>
          {`Save ${fmtMoney(saving)} per pest application`}
        </Chip>,
      );
    }
    tiles.push(
      <Tile
        key="best"
        selected={selectedKey === 'best'}
        disabled={tilesDisabled}
        onClick={() => onSelect && onSelect('best')}
        eyebrow="BEST"
        name={bestTileName(tiers)}
        price={best.rows.map((row) => fmtMoney(row.perApplication)).join(' + ')}
        caption={cadenceCaption(best.rows, tiers.companionKey, tiers.companionLabel) || 'Both programs on one plan'}
        extra={firstVisitLine(best)}
        chips={chips}
      />,
    );
  }
  if (!tiles.length) return null;

  const disclosures = Array.isArray(change?.quote?.disclosures) ? change.quote.disclosures : [];
  const targetName = change?.targetKey ? offerTierName(change.targetKey, tiers) : '';

  return (
    <section style={estimateCard({ padding: 16 })} aria-label="Choose your plan">
      <div style={{ fontSize: FS.body, fontWeight: FW.bold, letterSpacing: '0.06em', color: W.textCaption }}>
        Choose your plan
      </div>
      <h2 style={{
        margin: '4px 0 0', fontSize: FS.h3, fontWeight: FW.bold, lineHeight: LH.heading, color: CUSTOMER_SURFACE.text,
      }}
      >
        Pick the option that fits
      </h2>
      <p style={{ margin: '4px 0 12px', fontSize: FS.body, lineHeight: LH.body, color: W.textBody }}>
        You can change this any time before you approve.
      </p>
      <div
        role="radiogroup"
        aria-label="Plan options"
        style={{
          display: 'grid',
          gridTemplateColumns: wide ? `repeat(${Math.min(3, tiles.length)}, minmax(0, 1fr))` : '1fr',
          gap: 10,
        }}
      >
        {tiles}
      </div>
      {phase === 'previewing' || phase === 'committing' ? (
        <div role="status" style={{ marginTop: 10, fontSize: FS.body, color: W.textBody, lineHeight: LH.body }}>
          {phase === 'previewing' ? 'Checking your price…' : 'Updating your estimate…'}
        </div>
      ) : null}
      {phase === 'preview' && change?.quote ? (
        <div style={estimateInnerBox({ padding: '14px 16px', marginTop: 12 })}>
          <div style={{ fontSize: FS.bodyLg, fontWeight: FW.bold, color: CUSTOMER_SURFACE.text, marginBottom: 8 }}>
            {`Switch to ${targetName}?`}
          </div>
          {disclosures.length ? (
            <ul style={{ margin: '0 0 0', paddingLeft: 18, fontSize: FS.body, color: CUSTOMER_SURFACE.body, lineHeight: LH.body }}>
              {disclosures.map((d, i) => {
                const text = typeof d === 'string' ? d : (d?.message || d?.text || '');
                if (!text) return null;
                return <li key={d?.code ? `${d.code}-${i}` : i} style={{ marginBottom: 4 }}>{text}</li>;
              })}
            </ul>
          ) : (
            <div style={{ fontSize: FS.body, color: CUSTOMER_SURFACE.body, lineHeight: LH.body }}>
              Your estimate updates right away.
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={change.onConfirm}
              style={{
                padding: '10px 18px', background: NAVY, color: W.white, border: 'none',
                borderRadius: 12, fontSize: FS.body, fontWeight: FW.semibold, cursor: 'pointer',
              }}
            >
              Switch my plan
            </button>
            <button
              type="button"
              onClick={change.onCancel}
              style={{
                padding: '10px 18px', background: 'transparent', color: CUSTOMER_SURFACE.body,
                border: `1px solid ${CUSTOMER_SURFACE.border}`, borderRadius: 12, fontSize: FS.body,
                fontWeight: FW.medium, cursor: 'pointer',
              }}
            >
              Keep what I have
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
