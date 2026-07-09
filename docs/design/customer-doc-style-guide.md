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
| `FS.micro` | 11 | uppercase micro-labels/footnote stamps ONLY (never body) |
| `FS.caption` | 12 | captions, legal, meta rows, eyebrows |
| `FS.body` | 14 | default body, buttons, table cells |
| `FS.bodyLg` | 15 | primary prose paragraphs |
| `FS.lead` | 16 | lead-ins and ALL text inputs (16 = no iOS focus zoom) |
| `FS.sub` | 18 | sub-headings, intro lines |
| `FS.h4/h3/h2/h1` | 16/20/24/34 | headings (see `docHeading(level)`) |

**13px is banned** on customer surfaces (glass ruling; `check-portal-brand.js`
enforces literal 11/13). Weights snap to `FW` {400, 500, 600, 700, 800} — no
variable-font one-offs (650/750/850). Line heights snap to `LH`
{1, 1.1, 1.2, 1.35, 1.5}: solid for buttons/badges, display for h1, heading
for h2–h4, snug for dense meta, body for prose.

Uppercase section labels use `DOC_EYEBROW` (12px/700/0.11em/1.2/uppercase/
`var(--text-muted)`) — author as `<div data-gt="eyebrow" style={DOC_EYEBROW}>`
so glass and non-glass renders agree.

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
  pill 999. The pay family's shipped 8px card idiom is expressed as
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
