import React from 'react';
import BrandCard from './BrandCard';
import {
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_SUPPORT_PHONE_TEL,
  WAVES_SUPPORT_SMS_TEL,
} from '../../constants/business';

// The one terminal-state card for public token pages (glass audit G-02/G-07).
//
// Before this, every page family hand-rolled its own not-found / expired /
// error card: card padding measured 20 / 24 / 32 at 390, the heading was an
// `h1` on two pages, a styled `div` on five and absent on four, and the CTA set
// ran from nothing at all through "Try again" at three different heights to a
// two-button Text+Call row. `PublicLoadError` covered only the load-error
// branch, and only on eight of the fifteen token pages.
//
// What this fixes BY CONSTRUCTION, so a page cannot drift again:
//   - one card grammar — BrandCard, whose padding is already the single
//     responsive clamp(20px, 4vw, 32px); this file authors no padding of its own
//   - an `h1`, always (G-07 measured h1Count === 0 on ten states). The glass
//     sheet sizes it — `html[data-glass-theme] h1` is `!important`, so an
//     authored size cannot assert itself and must not be passed
//   - contact actions built from constants/business.js, never a retyped number
//
// What this deliberately does NOT decide: the WORDING. `title` and the body are
// the page's own copy, because the four live phrasings for the same condition
// ("We couldn't find that X" / "This X isn't available" / "X not found" /
// "This X link has expired") are a content decision for the owner, not a
// refactor. The card makes them structurally identical; it does not rewrite
// what they say.
//
// `state` drives the default action set and nothing visual:
//   not-found / expired → contact pair (the link is dead; retrying cannot help)
//   error               → "Try again" (transient; `onRetry` is what fixes it)

const CONTACT_DEFAULT = { 'not-found': 'row', expired: 'row', error: 'none' };

// One card width, not a prop. The pages this replaces authored 440 / 480 / 560
// and "one card grammar" is the whole finding — a width knob would just let the
// three come back.
const CARD_MAX_WIDTH = 560;

// tone="light" is the dark-scene variant, and the page that uses it (/card)
// never calls useGlassSurface -- so `data-glass="card"` is inert there and the
// frosted material cannot be delegated to the sheet. These are the values that
// wrapper authored (CardPage's GLASS_MATERIAL): without the blur and the inset
// highlight the card reads as a flat translucent panel on the navy scene.
const LIGHT_SCENE_MATERIAL = {
  background: 'rgba(255,255,255,0.14)',
  border: '1px solid rgba(255,255,255,0.32)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.35)',
  backdropFilter: 'blur(20px) saturate(160%)',
  WebkitBackdropFilter: 'blur(20px) saturate(160%)',
};

// Action styling lives here rather than in BrandButton because two of the three
// actions are links (tel:/sms:), and BrandButton renders a <button>. The
// heights are the C3 ruling: 48 for the card's one primary, 44 floor for the
// rest. On glass the sheet's control floors are `!important`, so these are the
// off-glass floors and the data-glass tags are what claim the tier (G-03).
const ACTION_BASE = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 20px',
  borderRadius: 'var(--radius-md, 10px)',
  font: 'inherit',
  fontSize: 16,
  fontWeight: 600,
  textDecoration: 'none',
  cursor: 'pointer',
  boxSizing: 'border-box',
  whiteSpace: 'nowrap',
};

function primaryStyle(light) {
  return {
    ...ACTION_BASE,
    minHeight: 48,
    border: light ? '1px solid rgba(255,255,255,0.7)' : 0,
    background: light ? 'rgba(255,255,255,0.14)' : '#F4B014',
    color: light ? '#FFFFFF' : '#1B2C5B',
  };
}

// `data-glass="chip"` is the hook BrandButton's secondary variant uses; without
// it the sheet's chip material, blur and hover never reach these actions and
// they render as solid outlined controls -- the file called them the chip tier
// while giving the sheet nothing to match on.
const CHIP_ATTRS = { 'data-glass': 'chip' };

function secondaryStyle(light) {
  return {
    ...ACTION_BASE,
    minHeight: 44,
    border: light ? '1px solid rgba(255,255,255,0.45)' : '1px solid var(--border-strong, #C7D7E2)',
    background: light ? 'transparent' : 'var(--surface, #FFFFFF)',
    color: light ? '#FFFFFF' : 'var(--brand, #04395E)',
  };
}

// Exactly one primary per card (style guide §2). When the state is recoverable
// the retry owns it and contact drops to the chip treatment; when it is not,
// "Call Waves" is the primary and "Text Waves" the chip. The two-gold
// ContactRow that /secure and /reschedule authored is what that rule resolves.
function buildActions({ onRetry, mode, light }) {
  const actions = [];
  if (onRetry) {
    actions.push(
      <button
        key="retry"
        type="button"
        onClick={onRetry}
        data-glass-accent={light ? undefined : ''}
        data-glass-size="primary"
        style={primaryStyle(light)}
      >
        Try again
      </button>
    );
  }
  if (mode !== 'row' && mode !== 'call') return actions;

  // Call is the card's one primary whenever there is no retry to own that
  // tier — in `call` mode just as much as in `row` mode, where it is the ONLY
  // action on the card. Gating this on `mode === 'row'` left every
  // contact="call" page (both report pages, the project report's not-found,
  // the service outline's expired) rendering its single CTA as the 44 chip,
  // which is both a regression from the solid buttons they had and a
  // contradiction of the invariant documented above.
  const callIsPrimary = !onRetry;
  if (mode === 'row') {
    actions.push(
      <a key="text" href={WAVES_SUPPORT_SMS_TEL} {...CHIP_ATTRS} style={secondaryStyle(light)}>
        Text Waves
      </a>
    );
  }
  actions.push(
    <a
      key="call"
      href={WAVES_SUPPORT_PHONE_TEL}
      data-glass-accent={callIsPrimary && !light ? '' : undefined}
      data-glass-size={callIsPrimary ? 'primary' : undefined}
      {...(callIsPrimary ? null : CHIP_ATTRS)}
      style={callIsPrimary ? primaryStyle(light) : secondaryStyle(light)}
    >
      {mode === 'call' ? `Call ${WAVES_SUPPORT_PHONE_DISPLAY}` : 'Call Waves'}
    </a>
  );
  return actions;
}

export default function PublicStateCard({
  state,
  title,
  children,
  onRetry,
  contact,
  tone = 'dark',
  style,
  ...rest
}) {
  const light = tone === 'light';
  const mode = contact || CONTACT_DEFAULT[state] || 'none';
  // The one-card invariant has to be enforced, not just documented. BrandCard
  // reads `maxWidth` and `padding` as props, and `...rest` is spread after the
  // explicit maxWidth, so `<PublicStateCard maxWidth={440} padding={20}>` — or
  // the same keys in `style` — silently restored the per-page geometry this
  // replaces. Strip them at the door.
  const { maxWidth: _mw, padding: _pad, ...passThrough } = rest;
  const { maxWidth: _smw, padding: _spad, ...safeStyle } = style || {};
  const ink = light ? '#FFFFFF' : 'var(--text, #04395E)';
  const muted = light ? 'rgba(255,255,255,0.78)' : 'var(--text-subtle, #475569)';
  const actions = buildActions({ onRetry, mode, light });

  return (
    <BrandCard
      role="alert"
      data-state={state}
      maxWidth={CARD_MAX_WIDTH}
      style={{
        textAlign: 'center',
        margin: '0 auto',
        ...(light ? LIGHT_SCENE_MATERIAL : null),
        ...safeStyle,
      }}
      {...passThrough}
    >
      {/* No authored font-size: the sheet's h1 rule is !important on glass, so
          one here would be dead style that only misleads the next reader. */}
      <h1 style={{ margin: 0, color: ink, lineHeight: 1.15 }}>{title}</h1>
      {children ? (
        <div style={{ margin: '10px auto 0', maxWidth: 440, color: muted, fontSize: 16, lineHeight: 1.55 }}>
          {children}
        </div>
      ) : null}
      {actions.length ? (
        <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'center', flexWrap: 'wrap' }}>
          {actions}
        </div>
      ) : null}
    </BrandCard>
  );
}
