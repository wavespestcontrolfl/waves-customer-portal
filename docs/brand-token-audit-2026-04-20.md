# Brand Token Audit — 2026-04-20

**Purpose:** Surface every place in `client/src/` that defines brand values outside of `theme-brand.js`. Intake for a follow-up cleanup PR. **Nothing is fixed in this PR.**

**Authoritative source:** `client/src/theme-brand.js` (mirror of `wavespestcontrol-astro/docs/STYLE_GUIDE.md`).

**Scope of this audit:**
1. Hardcoded brand hex values (any file other than `theme-brand.js` redefining brand colors)
2. Hardcoded font-family strings (Anton / Montserrat / Inter / Source Serif / etc.) instead of `FONTS` from `theme-brand`
3. Imports from the stale `'../theme'` path instead of `'../theme-brand'`

**Not scoped:** admin surfaces using the `D` dark palette (that's the intentional monochrome spec, not a drift). But if admin files redefine `#009CDE`/`#FFD700`/etc. on customer-brand values, they're flagged.

---

## 1. Imports from stale `'../theme'` path

`client/src/theme.js` is the pre-rebrand (Material-ish) palette — `#2196F3`/`#FDD835` — and is no longer the source of truth. Any import from `'../theme'` should be evaluated: either swap to `'../theme-brand'` (if the file needs real brand tokens) or switch to the admin `D` palette (if the file is an admin surface that got miswired).

| File | Line | Snippet |
|---|---|---|
| `client/src/pages/AdminLoginPage.jsx` | 3 | `import { FONTS, BUTTON_BASE } from '../theme';` |
| `client/src/pages/AdminDashboardPage.jsx` | 3 | `import { FONTS, BUTTON_BASE } from '../theme';` |

**Both are admin surfaces.** Neither should be pulling FONTS from the customer brand — admin stays on DM Sans (`D` palette convention). Follow-up: delete these imports, inline the admin-style fonts, or migrate the pages to the V2 admin design-system primitives.

`client/src/theme.js` itself should be reviewed for deletion once these two imports are unwound.

---

## 2. Hardcoded brand hex values (customer primaries)

The 5 van-wrap brand colors called out in the audit brief. **Every occurrence outside of `theme-brand.js` should be a `COLORS.*` reference.** Sorted by highest leverage first.

### 2a. Inline `BRAND` / `W` constant blocks (redefines the full palette)

These files declare their own brand constant object instead of importing `COLORS` from `theme-brand.js`. Highest priority to clean up — each one is a silent fork that won't update if the Astro site repaints.

| File | Line(s) | What it defines |
|---|---|---|
| `client/src/pages/PublicBookingPage.jsx` | 12, 13, 18, 19 | `navy:'#1B2C5B'`, `teal:'#009CDE'`, `coral:'#C8102E'`, `gold:'#FFD700'` |
| `client/src/pages/BookingPage.jsx` | 11, 12, 17 | `navy:'#1B2C5B'`, `teal:'#009CDE'`, `coral:'#C8102E'` |
| `client/src/pages/PayPage.jsx` | 11, 12, 15, 16 | `blueBright:'#009CDE'`, `blueDeeper:'#1B2C5B'`, `red:'#C8102E'`, `yellow:'#FFD700'` |
| `client/src/pages/ReviewPage.jsx` | 10, 11, 13, 14, 16 | `blueBright:'#009CDE'`, `blueDeeper:'#1B2C5B'`, `red:'#C8102E'`, `yellow:'#FFD700'`, `gold:'#FFD700'` |
| `client/src/pages/EstimateViewPage.jsx` | 8 | `const SAND = '#FDF6EC'` |
| `client/src/components/NotificationBell.jsx` | 107 | Inline theme object with `border:'#CBD5E1'`, `text:'#1B2C5B'`, `teal:'#009CDE'`, `unreadBg:'#E3F5FD'`, `badge:'#C8102E'` |

### 2b. Inline hex literals (not backed by a local constant)

| File | Line | Hex | Usage |
|---|---|---|---|
| `client/src/pages/RatePage.jsx` | 158 | `#009CDE` | spinner borderTopColor |
| `client/src/pages/RatePage.jsx` | 168 | `#C8102E` | link color ("Visit wavespestcontrol.com") |
| `client/src/pages/RatePage.jsx` | 179 | `#009CDE` | tech avatar gradient end |
| `client/src/pages/RatePage.jsx` | 182 | `#1B2C5B` | tech name color |
| `client/src/pages/RatePage.jsx` | 185 | `#1B2C5B` | prompt heading color |
| `client/src/pages/RatePage.jsx` | 196 | `#C8102E` | rating pill bg (low score) |
| `client/src/pages/RatePage.jsx` | 217 | `#1B2C5B` | confirmation heading |
| `client/src/pages/RatePage.jsx` | 222, 223 | `#009CDE` | highlight pill border + bg (selected) |
| `client/src/pages/RatePage.jsx` | 233 | `#1B2C5B` | inline SVG fill |
| `client/src/pages/RatePage.jsx` | 246, 256, 270, 286, 294, 315, 318, 370, 378, 397, 408 | `#1B2C5B` | body heading / input text color (11 occurrences) |
| `client/src/pages/RatePage.jsx` | 260, 261 | `#009CDE` | service-chip border + bg |
| `client/src/pages/RatePage.jsx` | 304, 329, 345 | `#009CDE` | submit button bg / copy button bg / edit link color |
| `client/src/pages/RatePage.jsx` | 369 | `#C8102E` | red alert pill text |
| `client/src/pages/RatePage.jsx` | 418 | `#009CDE` | page background |
| `client/src/pages/RatePage.jsx` | 429 | `#1B2C5B` | text-shadow |
| `client/src/pages/RatePage.jsx` | 431 | `#FFD700` | inline span color |
| `client/src/pages/RatePage.jsx` | 436 | `#C8102E`, `#FFD700` | gradient stripe |
| `client/src/pages/ButtonExamples.jsx` | 17, 60 | `#1B2C5B` | navy text color |
| `client/src/styles/buttons.css` | 36, 47, 54, 55, 72, 78, 89, 104, 105, 122, 128 | `#009CDE` / `#FFD700` / `#1B2C5B` | button variant palettes in raw CSS |

### 2c. `#FDF6EC` sand

| File | Line | Usage |
|---|---|---|
| `client/src/pages/EstimateViewPage.jsx` | 8 | `const SAND = '#FDF6EC'` (only match in client/src outside docs) |

Brief calls sand `#FDF6EC`, but `theme-brand.js` does **not** export a sand token — it has `blueSurface: '#F0F7FC'` instead. Two possible fixes: (a) add `sand` to `theme-brand` COLORS and port to Astro, or (b) delete the EstimateViewPage inline constant and switch to an existing token. Decision belongs upstream.

---

## 3. Hardcoded font-family strings

`FONTS` in `theme-brand.js` exports `display` (Anton), `heading` (Montserrat), `body`/`ui`/`sub` (Inter), `serif` (Source Serif 4), `mono` (JetBrains Mono). Every inline font-family string below should be one of those.

### 3a. Customer-facing pages (high priority — these render to homeowners)

| File | Lines | Fonts hardcoded |
|---|---|---|
| `client/src/pages/PublicBookingPage.jsx` | 184, 186, 212, 482 | Inter, Anton/Luckiest Guy, Inter |
| `client/src/pages/BookingPage.jsx` | 184 | Anton/Luckiest Guy |
| `client/src/pages/PayPage.jsx` | 411, 421, 422, 433, 452, 463, 495, 556, 599, 610, 651, 667 | Inter, Montserrat/Inter, Anton/Luckiest Guy (12 occurrences) |
| `client/src/pages/ReviewPage.jsx` | 92, 104, 120, 139, 145, 163, 186, 214, 233, 245, 273 | Inter, Anton/Luckiest Guy, Montserrat/Inter (11 occurrences) |
| `client/src/pages/RatePage.jsx` | 179, 185, 200, 217, 246, 370, 397, 408, 418, 427 | Anton/Luckiest Guy, Inter (10 occurrences) |
| `client/src/pages/ButtonExamples.jsx` | 14, 54, 58 | Montserrat/Inter, Inter, Anton/Luckiest Guy |
| `client/src/pages/LoginPage.jsx` | 91, 92 | `FONTS.display` reference + comment refers to Luckiest Guy, but FONTS.display is actually Anton — comment is stale |

### 3b. Tech portal (uses Montserrat per CLAUDE.md — acceptable but still hardcoded)

| File | Lines | Fonts hardcoded |
|---|---|---|
| `client/src/components/TechLayout.jsx` | 66, 71, 118 | `'Montserrat', sans-serif` |
| `client/src/pages/tech/TechHomePage.jsx` | 72, 95, 132, 197 | `'Montserrat', sans-serif` |
| `client/src/pages/tech/TechEstimatorPage.jsx` | 217, 219, 250, 284, 296, 464, 494, 508, 526, 536, 543, 568, 632, 650 | `'Montserrat', sans-serif` (14 occurrences) |

These are acceptable per the tech-portal heading convention, but should still switch to `FONTS.heading` so a font swap in Astro propagates.

### 3c. Raw CSS

| File | Line | Fonts hardcoded |
|---|---|---|
| `client/src/styles/buttons.css` | 42 | `font-family: 'Inter', system-ui, -apple-system, sans-serif;` |

### 3d. Admin surfaces loading non-brand fonts (informational)

| File | Line | Note |
|---|---|---|
| `client/src/pages/admin/EstimateToolViewV2.jsx` | 267 | `font-family: 'Inter', sans-serif !important;` in PAC container CSS — admin, but touches Inter |
| `client/src/pages/admin/EstimatePage.jsx` | 215 | Google Fonts link loads DM Sans + JetBrains Mono + Montserrat + Poppins at runtime — admin-only, documents admin's `D` palette typography |

---

## 4. Slate / neutral hex values (informational — not customer brand)

Many admin surfaces use inline slate values (`#334155`, `#64748B`, `#0F172A`, `#F1F5F9`, etc.). These are the same slate ramp `theme-brand.js` re-exports but are consumed by admin pages on the `D` palette, where the rule is inline-style-by-convention. **These are not flagged as drift** unless a customer-facing page is doing it.

Summary by file (counts for slate-ramp hits across the 62-file footprint — see raw grep for detail):

- Admin pages (expected): `EstimatePage.jsx`, `DispatchPage.jsx`, `SchedulePage.jsx`, `CommunicationsPage.jsx`, `PricingLogicPanel.jsx`, `Customer360Profile.jsx`, `CalendarViews.jsx`, etc.
- Customer-facing surfaces using slate inline (review for migration to `COLORS.slate*`): `PayPage.jsx` (13 hits), `ReviewPage.jsx` (6 hits), `RatePage.jsx` (33 hits), `BookingPage.jsx` (7 hits), `PublicBookingPage.jsx` (8 hits), `NotificationBell.jsx` (4 hits).

---

## 5. Recommended cleanup order (for follow-up PR)

1. **Delete inline `BRAND`/`W` constant blocks** on `PublicBookingPage.jsx`, `BookingPage.jsx`, `PayPage.jsx`, `ReviewPage.jsx`, `EstimateViewPage.jsx`. Replace with `import { COLORS } from '../theme-brand'` and rename references. Single biggest drift-risk reduction.
2. **Add `sand` to `theme-brand.js`** (after adding to Astro STYLE_GUIDE.md) so `EstimateViewPage.jsx` stops defining `#FDF6EC` locally.
3. **Unwire `AdminLoginPage.jsx` / `AdminDashboardPage.jsx`** from `'../theme'`. Decide whether they move to admin primitives or stay inline with `D` palette.
4. **Swap hardcoded font-family strings** on customer-facing pages for `FONTS.*` references (9 files, ~50 occurrences).
5. **Delete `client/src/theme.js`** once no imports remain.
6. **Move `styles/buttons.css` palette** to CSS custom properties sourced from `:root` tokens (same ones Astro exposes via `@theme`).

Total files flagged: **25** (customer-facing + tech + styles), excluding the 62-file slate-ramp footprint which is informational.
