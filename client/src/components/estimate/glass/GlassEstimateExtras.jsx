/**
 * Glass estimate components (docs/design/estimate-glass-plan.md, PR C) —
 * real React components for the behaviors the approved blueprint prototyped
 * with DOM injection (injected nodes kept getting teleported by re-renders).
 * Every component here no-ops or is simply not rendered unless the page is
 * under the glass theme (now unconditional); chrome lives in glass-components.css,
 * scoped to html[data-glass-theme].
 */
import { useEffect, useState } from 'react';
import './glass-components.css';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

/**
 * The featured-reviews endpoint returns star_rating >= 4 — every glass
 * proof surface renders five gold stars, so anything below a true 5 must
 * be filtered out before display. One shared filter so the proof strip,
 * the marquee, and the carousel-fallback gate can never disagree.
 */
export function fiveStarReviews(reviews) {
  return (Array.isArray(reviews) ? reviews : []).filter(
    (r) => r?.text && !r.fallback && Number(r.starRating) === 5,
  );
}

/**
 * Frequency selector as glass pills (gold when active, "Recommended" chip on
 * the server-recommended cadence) — same {frequencies, selected, onChange,
 * disabled} contract as FrequencySlider, driving the existing selection state.
 */
export function GlassFrequencyPills({ frequencies, selected, onChange, disabled = false }) {
  if (!frequencies || frequencies.length === 0) return null;
  // The pricing payload marks the actual recommendation (lawn/tree tiers can
  // recommend non-quarterly programs) — keying the chip on `quarterly` would
  // mislabel those (codex P2, PR #2439). Quarterly is only the fallback when
  // no frequency in the payload carries the flag (the pest default).
  const anyFlagged = frequencies.some((frequency) => frequency?.recommended === true);
  const isRecommended = (frequency) => (anyFlagged
    ? frequency?.recommended === true
    : /^quarterly$/i.test(frequency.key));
  return (
    <div role="group" aria-label="Service frequency" style={{ padding: '0 0 6px', marginBottom: 8 }}>
      <div className="gc-freq">
        {frequencies.map((frequency) => {
          const active = frequency.key === selected;
          return (
            <button
              key={frequency.key}
              type="button"
              className="gc-freq-btn"
              aria-label={`${frequency.label} frequency`}
              aria-pressed={active}
              disabled={disabled}
              {...(active ? { 'data-active': '' } : {})}
              onClick={() => { if (!disabled) onChange(frequency.key); }}
            >
              {frequency.label}
              {isRecommended(frequency) ? (
                <span className="gc-freq-rec" aria-label="Recommended">Recommended</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Fetch for the curated Google-review pool — same endpoint the reviews card
 * uses (/api/reviews/featured). `enabled` gates the request so non-glass
 * renders never pay for it; returns [] until loaded or on failure so
 * callers can just render nothing.
 */
export function useFeaturedReviews(enabled, limit = 12) {
  const [reviews, setReviews] = useState([]);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    fetch(`${API_BASE}/reviews/featured?limit=${limit}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('reviews fetch failed'))))
      .then((body) => {
        if (cancelled) return;
        setReviews((body?.reviews || []).filter((x) => x?.text && !x.fallback));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [enabled, limit]);
  return reviews;
}

// One short pull-quote per review — first sentence if it stays punchy,
// otherwise skip. Real 5-star quotes only, never truncated mid-thought.
function tickerQuotes(reviews) {
  return fiveStarReviews(reviews)
    .map((r) => {
      const first = String(r.text).split(/(?<=[.!?])\s/)[0].trim();
      return first.length >= 20 && first.length <= 90 ? { quote: first, name: r.reviewerName } : null;
    })
    .filter(Boolean)
    .slice(0, 7);
}

/**
 * Hero proof strip — continuous single-line ticker of short review quotes
 * above the price card. Renders nothing without at least 3 usable quotes
 * (a 1-quote "marquee" reads as filler, not proof).
 */
export function GlassProofStrip({ reviews }) {
  const quotes = tickerQuotes(reviews || []);
  if (quotes.length < 3) return null;
  const items = quotes.map((q, i) => (
    <span key={`${q.name}-${i}`} className="gc-proof-item">
      <span className="gc-proof-stars" aria-hidden="true">★★★★★</span>
      <span style={{ fontStyle: 'italic' }}>“{q.quote}”</span>
      <span style={{ fontWeight: 600, color: '#04395E' }}>— {q.name}</span>
    </span>
  ));
  return (
    <div className="gc-proof" aria-label="Recent 5-star Google reviews">
      <div className="gc-proof-track">
        {items}
        {/* second copy makes the -50% keyframe loop seamless */}
        {quotes.map((q, i) => (
          <span key={`dup-${q.name}-${i}`} className="gc-proof-item" aria-hidden="true">
            <span className="gc-proof-stars">★★★★★</span>
            <span style={{ fontStyle: 'italic' }}>“{q.quote}”</span>
            <span style={{ fontWeight: 600, color: '#04395E' }}>— {q.name}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

const G_MARK = (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-label="Google" role="img">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
  </svg>
);

/**
 * GBP-native review marquee — white Google-styled cards (name + city,
 * #FBBC04 stars, G mark; NO avatar, NO relative date — owner directive),
 * continuous scroll, pause on hover. 5★ reviews only.
 */
export function GlassReviewMarquee({ reviews }) {
  const fiveStar = fiveStarReviews(reviews);
  if (fiveStar.length < 3) return null;
  const card = (r, keyPrefix, hidden) => (
    <div key={`${keyPrefix}-${r.reviewerName}-${r.text.slice(0, 24)}`} className="gc-rm-card" {...(hidden ? { 'aria-hidden': true } : {})}>
      <div className="gc-gr-head">
        <span>
          <span className="gc-gr-name">{r.reviewerName || 'Waves customer'}</span>
          {r.location ? <span className="gc-gr-city">{r.location}</span> : null}
        </span>
        {G_MARK}
      </div>
      <div className="gc-gr-stars" aria-hidden="true">★★★★★</div>
      <div className="gc-gr-text">{r.text}</div>
    </div>
  );
  return (
    <div className="gc-marquee" aria-label="Google reviews from Waves customers">
      <div className="gc-rm-track">
        {fiveStar.map((r) => card(r, 'a', false))}
        {fiveStar.map((r) => card(r, 'b', true))}
      </div>
    </div>
  );
}

/**
 * Sticky mobile book bar (≤640px via CSS): live price/period on the left,
 * slot-aware approve button on the right. Hidden entirely off-mobile and
 * without glass (display:none default; the media query only flips it on
 * under html[data-glass-theme]).
 */
export function GlassStickyBookBar({ priceLabel, periodLabel, slotMeta, onApprove }) {
  if (!priceLabel) return null;
  return (
    <div className="gc-mbb">
      <div className="gc-mbb-price">
        {priceLabel}
        {periodLabel ? <span className="gc-mbb-period">{periodLabel}</span> : null}
      </div>
      <button type="button" className="gc-mbb-btn" onClick={onApprove}>
        {slotMeta ? `Approve ${slotMeta.dow} ${slotMeta.time} →` : 'Approve my plan →'}
      </button>
    </div>
  );
}

/**
 * Technician chip — renders ONLY once a slot is selected: who is coming and
 * when, with the license line. Initials avatar (no committed headshot asset
 * yet — plan defers the real photo).
 */
export function GlassTechChip({ slotMeta, techName = 'Adam', licenseNumber }) {
  if (!slotMeta) return null;
  // The availability payload names the slot's real technician — the default
  // only covers legacy slots with no tech attached.
  const name = slotMeta.techFirstName || techName;
  return (
    <div className="gc-tech-chip">
      <span className="gc-tc-avatar" aria-hidden="true">{name.charAt(0)}</span>
      <span>
        <strong style={{ color: '#04395E' }}>
          Your technician: {name} — {slotMeta.dow} {slotMeta.time}
        </strong>
        {licenseNumber ? <> · Licensed &amp; insured, FL {licenseNumber}</> : null}
      </span>
    </div>
  );
}

/**
 * Real-data scarcity badge — the caller computes glassScarcityInfo() from
 * live slot data; this renders it (or nothing).
 */
export function GlassScarcityBadge({ info }) {
  if (!info) return null;
  return (
    <div className="gc-scarcity">
      <span aria-hidden="true">⏳</span>
      {info.label}
    </div>
  );
}

/**
 * Gold section CTA pill ("This price fits my home — lock it in →",
 * "Join your neighbors →") — scrolls to the approve/booking section.
 */
export function GlassSectionCta({ label, onClick, style }) {
  return (
    <div style={{ display: 'flex', margin: '14px 0 4px', ...style }}>
      <button type="button" className="gc-section-cta" onClick={onClick}>
        {label}
      </button>
    </div>
  );
}
