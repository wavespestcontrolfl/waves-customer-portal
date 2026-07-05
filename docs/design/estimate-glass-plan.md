# Estimate Glass Redesign — Implementation Plan

Owner-approved 2026-07-04 (live preview session against a real estimate; customer anonymized here).
The complete approved behavior is codified in `estimate-glass-blueprint.js` (DOM-injection
prototype run against prod data via dev proxy). This plan splits it into three PRs per the
repo rule that visual and content changes never share a PR.

## PR A — Glass theme (visual only, strict 1:1)

Dark-launched: renders ONLY when the URL carries `?glass=1` (no DB flag yet; flag column can
follow once approved for rollout). Zero behavior/copy changes.

- Scene layer component (`EstimateGlassScene`): fixed mesh gradient (brand blues + gold, corner
  vignette), 5 parallax orbs + dot lattice (z 0), film-grain overlay (SVG turbulence, ~3% alpha,
  z 3), content wrapper z 1. Pointer + scroll parallax, disabled under reduced-motion.
- Glass tokens (CSS file, real classes — no `!important` war): `--glass-bg/border/blur(32px)/
  sat(185%)/--spring cubic-bezier(.34,1.56,.64,1); --brand #04395E; accent rgb(10,126,194)`.
- Three surface tiers: `glass-card` (section cards, radius 26–28, hover lift+glow suppressed
  when hovering interactive children via `:has()`), `glass-soft` (nested panes, blur 18),
  `glass-chip` (buttons/links, pill radius). Edge treatment: hairline + inner top/bottom
  highlights + restrained chromatic fringe (cyan TL / warm BR insets).
- Cursor specular: `::before` radial at `--mx/--my` (280px, .30 core, hover opacity .65) — one
  delegated rAF pointermove handler. Gold accent CTAs: translucent gold gradient fill, pale-gold
  hairline, warm glow, navy text (`#1B2C5B`), disabled at .55.
- Apple type system: system SF stack; H1 clamp(2.4–3.3rem)/700/-0.035em; H2 1.6–2rem/600/-0.03em;
  eyebrows 12px/700/+0.11em uppercase; body 400/1.5; excerpts 15px/400/1.55 max 62ch; fine print
  11.5px; metrics 700 tabular-nums; ALL headings + price in `--brand`. Contact block + eyebrows
  weight 700. Buttons 600.
- Floating pill nav (sticky glass header), scroll-reveal on section cards (IntersectionObserver,
  16px rise, spring), stat count-up on sq-ft tiles, smooth scrolling (`scroll-behavior: smooth`).
- Form controls always above glass overlays (`input/select/textarea { position:relative; z-index:2 }`).
- Reduced-motion: kills transitions/reveal/parallax/count-up/confetti. `@supports` fallback to
  near-opaque white when `backdrop-filter` unavailable. Mobile: reduce blur (20/14px), simplify.

## PR B — Copy repositioning (content only)

Full map in blueprint `COPY` object. Highlights: hero "{firstName}, your pest-free home plan is
ready." + subline; offer-first headers (see blueprint); technical offer stack (7 bullets incl.
premium non-repellent + repellent, unlimited callbacks 100% guaranteed, 90-day money-back,
no contract, $99 setup waived w/ annual); "WaveGuard Bronze" displayed as "WaveGuard Home
Protection" on single-plan estimates (Bronze/Silver/Gold only when comparing tiers); footer
cities Bradenton · Parrish · Sarasota · Venice linked to g.page profiles (in `locations.js`,
strip `/review`); CTAs "Approve my plan and schedule" / "Book my first visit"; guarantee
microcopy under primary CTA.
- Fixes: dynamic today/tomorrow/this-week in scheduler header (from real first slot); search
  results positive phrasing ("N open times for {day} {qualifier} — pick what works:") replacing
  the double "No route near you" lines; REMOVE the "You save $X with WaveGuard {tier}" line
  (anchor-vs-cadence delta misattributed to tier; one-time uses a multiplier so the comparison
  is not real — owner directive to remove, at minimum for 0%-discount tiers).
- REMOVE the "Customize your visit" toggles section entirely (zero lifetime engagement).
- Per-day value line under price, recomputed per frequency (price×periods/365) with
  per-frequency tails (gas-station / morning coffee / grocery rounding error).

## PR C — Components (new functionality)

- Frequency selector as gold/glass segmented pills (horizontal desktop, vertical mobile,
  "Recommended" chip on quarterly), driving the existing select state.
- Offer-stack accordion ("See everything included (7) ▾", collapsed default).
- GBP-native review card component (Roboto, white card, #dadce0 border, name + city, Google
  stars #FBBC04, G mark; NO avatar, NO relative date) + continuous marquee (~38s, pause on
  hover) fed from `google_reviews` (5★, curated); hero single-line review ticker (edge-masked).
- Sticky mobile book bar (≤640px): live price/period + "Approve my plan →".
- Slot-aware CTA: selection rewrites CTAs to "Approve — {dow} {time} ✓"; technician chip
  (photo + license + chosen slot) appears ONLY once a slot is selected; clears if slot list
  changes or slot goes stale.
- Slot freshness: 2-hour minimum lead enforced client-side (60s re-check; stale slots disabled,
  stale selections cleared) + server-side lead validation on reserve.
- Real scarcity badge: renders only when first day has ≤2 open slots ("Only 1 opening tomorrow
  — 9:00 AM"), self-removes otherwise. Parse structured slot data, never concatenated text.
- Route-day priority tags on slot chips ("⚡ Tech nearby — priority") bound to real route markers.
- Section CTAs: "This price fits my home — lock it in →" (under smart pricing), "Join your
  neighbors →" (under reviews header); both scroll to approve. Approve confetti on booking
  CONFIRMATION (not the scroll CTA).
- App section: single hero phone (tracking screen) + glow, glass feature chips, App Store badge
  + Google Play badge (unlinked until store URL exists), "Book my first visit" at section bottom.
- Section order (from owner-approved positioning): hero offer → price/guarantee → schedule →
  included → why-price-custom → reviews → app bonus → AI Q&A → lawn upsell (post-booking moment)
  → final CTA.

## Deferred / follow-ups
- Annotated satellite (perimeter/entry-point overlay) — needs polygon data from satellite analyzer.
- Mobile per-section accordions; dark mode variant (prefers-color-scheme).
- Real technician headshot asset (preview used marketing-site brand photo).
- App bug (separate small PR, pre-existing): `PriceCard.jsx` savings line attributes the
  anchor−cadence delta to the WaveGuard tier even when tier discount is 0%.

## Process notes
- `npm run check:portal-brand` before every push (client/ builds die otherwise).
- @codex tag on PR create; merge only when codex-clean (zero findings incl. P2).
- Customer-facing design brief (`waves-customer-facing-design-brief.md`) needs an addendum:
  this theme replaces the warm-serif direction for the estimate surface (SF Pro + deep-blue
  hierarchy + gold CTAs) — owner-approved 2026-07-04.
