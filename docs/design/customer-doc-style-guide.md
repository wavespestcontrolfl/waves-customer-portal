# Customer Document Pages — Style Guide

The tokened document surfaces — `/estimate/:token`, `/report/*`, `/prep`,
`/receipt`, `/pay`, `/pay/statement/:token`, `/contract`, `/service-outlines`,
`/lawn-care/what-is-included` — share one design system with a single source
of truth:

- **Web:** `client/src/theme-doc.js` (import `FS/FW/LH/SP/DOC/RADIUS/SHADOW`,
  `docButton/docInput/docCard/docHeading`, `DOC_EYEBROW`, `DOC_FONT`,
  `DOC_COLUMN`)
- **Print/PDFKit twin:** `server/services/pdf/pdf-tokens.js` (literal values —
  change BOTH files or web and print drift)
- **Tailwind pages** (`ServiceOutlinePage`, `LawnCareIncludedPage`) keep
  utility classes but only via `tailwind.config.js` `colors.waves.*` keys that
  mirror the same values.

New customer document pages must compose from these — no local palettes, no
ad-hoc font sizes.

## Type scale

One body stack: `DOC_FONT` = `'Inter', system-ui, sans-serif` (the glass
runtime forces the SF-clean family live; the authored value keeps print/PDF
coherent). Serif accents: `DOC_FONT_SERIF`.

| Token | px | Use |
|---|---|---|
| `FS.body` | 14 | default body, buttons, table cells |
| `FS.bodyLg` | 16 | primary prose paragraphs (owner D1 2026-09-05) |
| `FS.lead` | 16 | lead-ins and ALL text inputs (16 = no iOS focus zoom) |
| `FS.sub` | 18 | sub-headings, intro lines |
| `FS.h4/h3/h2/h1` | 16/20/26/40 | headings (see `docHeading(level)`); the glass sheet renders h1 as `clamp(32px, 4vw, 40px)` |

**Nothing under 14px on a glass surface** — the runtime sheet in
`glass/glass-theme.css` forces eyebrows and fine print to 14 (owner ruling
2026-09-03); the scale starts at `FS.body` (14) — `FS.micro` / `FS.caption` are gone
(the PDF twin keeps its own 8/9 print sizes).
`check-portal-brand.js` refuses every literal under 14 and the retired tokens.
Weights snap to `FW` {400, 500, 600, 700}; `FW.heavy` (800) is gone and 850
never appears (the gate refuses weights over 700, ternaries included).
Line heights snap to `LH` {1, 1.1, 1.2, 1.35, 1.5}: solid for
buttons/badges, display for h1, heading for h2–h4, snug for dense meta, body
for prose.

Uppercase section labels use `DOC_EYEBROW` (14px/600/0.06em/1.2/uppercase/
`var(--text-muted)`) — author as `<div data-gt="eyebrow" style={DOC_EYEBROW}>`
so glass and non-glass renders agree.

## Controls

Primary action = `BrandButton` (48px, r10, weight 600, sentence case — owner
2026-09-04; the marketing site's UPPERCASE rule does not apply on glass).
Gold accent actions (`data-glass-accent`) are 44px minimum; choice chips
(`data-glass="chip"`) 40px minimum with a 999 radius when they are pills.
Inputs are 48px, r10, 16px text (no iOS zoom), placeholder 14px `#64748B`.
Every control shows the shared `:focus-visible` ring (2px accent, 2px
offset). Under `prefers-reduced-transparency` and `forced-colors` cards
render solid with a real border — the same fallback as no `backdrop-filter`.

## Glass tiers

Three and only three: `data-glass="card"` (outer card, blur 32, the
estimate's warm tint), `data-glass="soft"` (inner box, blur 18),
`data-glass="chip"` (pill / chip, blur 18). One scene for every customer
page — the quieter `pro` scene was retired 2026-09-03.

## Spacing scale

4px grid, from `SP`: **4, 8, 12, 16, 20, 24, 32, 48, 64**. All margins,
paddings, and gaps come from this set (48 = page-level vertical rhythm,
64 = bottom-of-page breathing room). Optical exceptions (tight badge
padding, hairline 1–3px offsets) are allowed but must be deliberate.

## Layout

- Document column: **760px** (`DOC_COLUMN` = `min(100% - 32px, 760px)`;
  owner ruling PR #2527 — "pay's cap is the standard"). Prefer
  `className="waves-receipt-page"` which also carries the standard
  `28px auto 56px` page margins.
- Radii from `RADIUS`: tag 6, input 8, button 10, card 12, modal 16,
  pill 999. The glass sheet renders cards 12, controls 10, pills 999. The pay family's shipped 8px card idiom is expressed as
  `RADIUS.input` — do not re-round it.
- Shadows from `SHADOW` (card / modal / focusRing). Transitions via
  `docTransition('background', 'color', …)` — 160ms ease, explicit
  properties, never `all`.

## Color roles

`DOC.*` roles are CSS-var references **on purpose**: warm brand navy
`#1B2C5B` in print/PDF/non-glass renders, canonical glass navy `#04395E`
while a glass scene is mounted. `DOC.navyLiteral` (#1B2C5B) pins chrome that
must not shift (e.g. DocumentActionBar fills). Semantic roles: `danger`,
`success` (+ `successBg/successBorder`), `soft/softBorder` washes,
`border/borderStrong`, `page` (#FAF8F3 warm).

Deliberate palette forks (do not "fix"):

- **Estimate surface** keeps `components/estimate/tokens.js` (gold `#F0A500`,
  alert red `#C8312F`, the W borders, PRICE_FONT clamp) and consumes only
  scale tokens from theme-doc. The marketing red `#C8102E` must never appear
  on the estimate surface.
- **Report status-badge palette** (~40 hexes) and status washes on the pay
  family are semantic sets, not drift.
- **GoogleProfilesCard** Roboto and Stripe iframe font stacks stay literal.

## Primitives

- `docButton('primary'|'chip')` — THE document button (border-box,
  minHeight 48; canonical values shipped in `DocumentActionBar`, PR #2532).
  Estimate CTAs are a different anatomy (16px vertical padding) and stay
  local by design.
- `docInput()` — contract signing fields are the reference (48px, 16px text).
- `docCard()` — white surface, `DOC.border`, radius 12, `SHADOW.card`.
- `docHeading(1–4)` — mirrors what the glass theme forces at runtime.

## Cache invalidation rule

`ReportViewPage` renders to stored PDFs via puppeteer: any styling change to
the report surface must bump `SERVICE_REPORT_PDF_STORAGE_VERSION`
(`server/services/service-report/pdf-storage.js`) or customers keep getting
stale cached PDFs (pattern established in PR #2378).
