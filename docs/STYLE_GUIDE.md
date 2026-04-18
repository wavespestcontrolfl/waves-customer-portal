# Waves Pest Control — Style Guide

**Source:** Van-wrap spec (Pantone-sampled, 2026-04-17). Site tokens updated to match.
**Stack:** Astro + Tailwind v4 (tokens live in `src/styles/global.css` @theme block).
**Headings:** Anton (Google Fonts) for H1/H2, Montserrat for H3/H4, Inter for body and H5/H6.

---

## 1. Brand Palette

### Primary brand tokens
Matched to van-wrap spec (Pantone-derived from on-vehicle samples, 2026-04-17).

| Token | Hex | Pantone | Notes |
|---|---|---|---|
| `--color-brand-blue` | `#009CDE` | 2925 C | Primary brand blue — van body, section backgrounds, links. |
| `--color-brand-blueDeeper` | `#1B2C5B` | 2766 C | Navy — halftone dots, heading text on light backgrounds. |
| `--color-brand-blueDark` | `#065A8C` | — | Interstitial between brand blue and navy. |
| `--color-brand-blueLight` | `#E3F5FD` | — | Hover fills, light wash, soft highlights. |
| `--color-brand-sky` | `#4DC9F6` | — | Hero background. |
| `--color-brand-gold` | `#FFD700` | — | Pure gold — CTA fill, focus rings. (Van wrap is PMS 7563 `#CA9526` amber, but pure gold reads better against brand-blue.) |
| `--color-brand-yellow` | `#FFF176` | — | Hover state for gold CTA. |
| `--color-brand-red` | `#C8102E` | 186 C | Fire-engine red (cap, overalls). Used sparingly. |

### Neutrals (Tailwind slate scale, oklch)
| Token | oklch | Use |
|---|---|---|
| `slate-50` | `oklch(98.4% .003 247.858)` | Lightest backgrounds |
| `slate-100` | `oklch(96.8% .007 247.896)` | Card/alt backgrounds |
| `slate-200` | `oklch(92.9% .013 255.508)` | Borders, dividers |
| `slate-300` | `oklch(86.9% .022 252.894)` | Subtle borders |
| `slate-400` | `oklch(70.4% .04 256.788)` | Muted icons |
| `slate-500` | `oklch(55.4% .046 257.417)` | Secondary text |
| `slate-600` | `oklch(44.6% .043 257.281)` | Body text (alternate) |
| `slate-700` | `oklch(37.2% .044 257.287)` | **Default body copy** |
| `slate-900` | `oklch(20.8% .042 265.755)` | Strongest text |

### Semantic accents actually used on homepage
- **Green 500** `oklch(72.3% .219 149.579)` + **Green 400** `oklch(79.2% .209 151.711)` — success/checks
- **Amber 700** `oklch(55.5% .163 48.998)` — warnings
- **Red 500** `oklch(63.7% .237 25.331)` — errors
- **White** `#fff` — on brand-blue sections

---

## 2. Typography

### Font stacks (as declared in `@theme`)
```css
--font-heading:    "Anton", "Burbank Big Condensed", "Luckiest Guy", cursive;  /* H1 + H2 display */
--font-subheading: "Montserrat", "Inter", system-ui, sans-serif;               /* H3 / H4 step-down */
--font-sans:       "Inter", system-ui, sans-serif;                             /* Body, UI, buttons, H5/H6 */
--font-serif:      "Source Serif 4", Georgia, "Times New Roman", serif;        /* Long-form / editorial body */
--font-mono:       "JetBrains Mono", monospace;                                /* Code/mono only */
--font-sub:        "Inter", system-ui, sans-serif;                             /* Back-compat alias → Inter */
```

### Heading hierarchy rules (declared in `global.css`)
- **H1, H2** → `--font-heading` (Anton), letter-spacing `0.02em`
- **H3** → `--font-subheading` (Montserrat 700), letter-spacing `-0.01em`
- **H4** → `--font-subheading` (Montserrat 500), letter-spacing `0`
- **H5, H6** → `--font-sans` (Inter 600), uppercase, letter-spacing `0.08em`, `0.78rem`

### Loaded weights
- **Anton:** 400 — primary display face (H1/H2), matches the condensed heavy feel of the van wrap
- **Burbank Big Condensed:** 700 (Bold), 900 (Black) — self-hosted OTFs at `public/fonts/burbank/`, fallback for `--font-heading`
- **Luckiest Guy:** 400 — legacy fallback for H1 while Burbank loads
- **Montserrat:** 500, 600, 700 — H3/H4 step-down
- **Inter:** 400, 500, 600, 700 — body, UI, chrome, buttons
- **Source Serif 4:** 400, 400-italic, 500, 600 — long-form / editorial body
- **JetBrains Mono:** 400 — code/mono only

> **Note:** DM Sans, Baloo 2, and Nunito are no longer in use. DM Sans package may still be installed as a legacy holdover but is unreferenced.

### Font licensing note
Burbank Big Condensed is a House Industries commercial typeface. A desktop/print license does **not** cover web embedding — production use requires a separate web font license. Verify before public deploy.

### Type scale (Tailwind v4 tokens × 18px root)
| Token | rem | Effective px (18px root) |
|---|---|---|
| `text-xs` | 0.75 | 13.5 |
| `text-sm` | 0.875 | 15.75 |
| `text-base` | 1 | 18 |
| `text-lg` | 1.125 | 20.25 |
| `text-xl` | 1.25 | 22.5 |
| `text-2xl` | 1.5 | 27 |
| `text-3xl` | 1.875 | 33.75 |
| `text-4xl` | 2.25 | 40.5 |
| `text-5xl` | 3 | 54 |
| `text-6xl` | 3.75 | 67.5 |
| `text-7xl` | 4.5 | 81 |
| `text-8xl` | 6 | 108 |

### Font weights (tokenized)
- `--font-weight-medium: 500`
- `--font-weight-semibold: 600`
- `--font-weight-bold: 700`
- `--font-weight-extrabold: 800`

### Tracking (letter-spacing)
- `--tracking-wide: .025em`
- `--tracking-wider: .05em`
- `--tracking-widest: .1em`

### Leading (line-height)
- `--leading-tight: 1.25`
- `--leading-snug: 1.375`
- `--leading-relaxed: 1.625`

### Actual heading specs on homepage
| | H1 | H2 | H3 | H4 |
|---|---|---|---|---|
| Example text | "Pests Gone Today. 100% Guaranteed." | "What are you interested in?" | "Pest Control" | (form heading) |
| Font | Anton | Anton | Montserrat | Montserrat |
| Size | 48px | 24px | 24px | 24px |
| Weight | 400 | 400 | 700 | 500 |
| Letter-spacing | 0.02em | 0.02em | -0.01em | 0 |
| Color | `#fff` (on sky) | `#1B2C5B` | `#1B2C5B` | `#1B2C5B` |

> **Note:** H1 and H2 render via `--font-heading` (Anton). H3/H4 use `--font-subheading` (Montserrat) for readability on body-adjacent text.

---

## 3. Spacing

Base unit: `--spacing: 0.25rem`. The root `html` font-size is **18px** (bumped from the browser default 16px), so `1rem = 18px` everywhere on the site. That means `--spacing` resolves to 4.5px, Tailwind's `p-4` = 18px, `py-20` = 90px, etc. All type-scale, spacing, and container tokens inherit this 12.5% uplift.

### Margin values observed in use
`-24, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 56, 96` px

### Padding values observed in use
`4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 40, 56, 64, 80` px

### Gap values observed in use
`4, 8, 12, 16, 20, 24, 40` px

### Section rhythm (all full-width `<section>`s use the same pattern)
```html
<section class="py-20 md:py-28 bg-white">…</section>
<section class="py-20 md:py-28 bg-brand-blue text-white">…</section>
```
- Mobile: **80px top / 80px bottom** (`py-20`)
- Desktop ≥768px: **112px top / 112px bottom** (`py-28`)
- Backgrounds alternate `white` ↔ `#009CDE` for the full page (see §9).

---

## 4. Container Widths

```css
--container-md:  28rem  /*  448px */
--container-lg:  32rem  /*  512px */
--container-xl:  36rem  /*  576px */
--container-2xl: 42rem  /*  672px */
--container-3xl: 48rem  /*  768px */
--container-4xl: 56rem  /*  896px */
--container-5xl: 64rem  /* 1024px */
--container-6xl: 72rem  /* 1152px */
--container-7xl: 80rem  /* 1280px */
```

---

## 5. Border Radius

```css
--radius-md:  .375rem  /*  6px */
--radius-lg:  .5rem    /*  8px */
--radius-xl:  .75rem   /* 12px */
--radius-2xl: 1rem     /* 16px */
--radius-3xl: 1.5rem   /* 24px */
/* pill/circle: rounded-full (9999px equivalent) */
```

Observed in use: **6, 8, 12, 16, 24, full**. Chip selectors use `rounded-xl` (12px). All CTA pills and the FAB use `rounded-full`.

---

## 6. Elevation / Shadows

Standard Tailwind shadow ladder (all in use):

| Token | Values |
|---|---|
| `shadow-sm` | `0 1px 3px 0 rgba(0,0,0,.1), 0 1px 2px -1px rgba(0,0,0,.1)` |
| `shadow-md` | `0 4px 6px -1px rgba(0,0,0,.1), 0 2px 4px -2px rgba(0,0,0,.1)` |
| `shadow-lg` | `0 10px 15px -3px rgba(0,0,0,.1), 0 4px 6px -4px rgba(0,0,0,.1)` |
| `shadow-xl` | `0 20px 25px -5px rgba(0,0,0,.1), 0 8px 10px -6px rgba(0,0,0,.1)` |
| `shadow-2xl` | `0 25px 50px -12px rgba(0,0,0,.25)` |

Custom stacks:
- **Gold focus ring:** `0 0 0 4px #FFD700, 0 25px 50px -12px rgba(0,0,0,.25)`
- **Green focus ring:** `0 0 0 2px rgba(green/30), 0 25px 50px -12px rgba(0,0,0,.25)`
- **Chat bubble up-glow:** `0 -4px 20px 0 rgba(0,0,0,.25)`

Drop shadows:
- `--drop-shadow-md: 0 3px 3px #0000001f`
- `--drop-shadow-lg: 0 4px 4px #00000026`

Blur:
- `--blur-sm: 8px`, `--blur-lg: 16px`

---

## 7. Motion

```css
--default-transition-duration: .15s;
--default-transition-timing-function: cubic-bezier(.4, 0, .2, 1);
--ease-out: cubic-bezier(0, 0, .2, 1);
--ease-in-out: cubic-bezier(.4, 0, .2, 1);

--animate-pulse:  pulse 2s cubic-bezier(.4, 0, .6, 1) infinite;
--animate-bounce: bounce 1s infinite;
```

Durations seen in use: **150ms** (default), **200ms** (transforms on interactive chips), **500ms** (slower fades). Hover chips use `hover:scale-[1.03]` + `active:scale-95`.

---

## 8. Components

### Chip selector (service picker: 🛡️ Pest / 🌿 Lawn / 🏠 Both)
```
flex flex-col items-center gap-2 px-4 py-4
rounded-xl border-2
bg-white text-slate-700 font-semibold
border-slate-200
hover:scale-[1.03] hover:border-brand-blue hover:bg-brand-blueLight
active:scale-95 transition-all
```
Resolved: padding 16px, radius 12px, border 1.25px, font 16px/600.

### Primary CTA — gold pill (used on Subscribe)
```
px-5 h-10 rounded-full
bg-brand-gold text-brand-blueDeeper
text-sm font-extrabold
hover:bg-brand-yellow transition-colors
disabled:opacity-50
```
Resolved: bg `#FFD700`, text `#04395e`, 14px / 800, height 40px, horizontal padding 20px, pill.

### FAB (bottom-right chat launcher)
```
w-16 h-16 rounded-full
shadow-2xl
hover:scale-110 active:scale-95 transition-all
animate-chat-pulse
```
Resolved: 64×64, full round, 25px 50px -12px shadow, pulse animation.

### Section header pattern (observed)
- `h2` in Anton 24px, weight 400, letter-spacing 0.02em, color `#1B2C5B` on white bg — or `#fff` on brand-blue bg
- Followed by one-line subtitle in Inter `text-base`/`text-lg`, slate-600 or white/80

### Social icons (Footer + portal login)
- **Circle:** 36px, `rounded-full`, bg `rgba(255,255,255,0.15)`
- **Icon fill:** `#FFD700` (brand-gold) — "white-parts-yellow" rule
- **Hover (Astro footer):** circle fills brand-gold `#FFD700`, icon inverts to `#1B2C5B` navy
- **Classes (Astro):** `bg-white/10 hover:bg-brand-gold text-brand-gold hover:text-brand-blueDeeper`
- **Portal (inline-style):** `color: B.yellow` (`#FFD700`) on `rgba(255,255,255,0.15)` background

---

## 9. Page rhythm (homepage section map)

| # | Bg | Pad Y (desktop) | First heading |
|---|---|---|---|
| 1 | `bg-brand-sky` `#4dc9f6` | custom | Pests Gone Today. 100% Guaranteed. |
| 2 | `bg-white` | 80 / 112 | Got Pest Problems? Go Waves! |
| 3 | `bg-brand-blue` | 80 / 112 | Trusted Across Southwest Florida |
| 4 | `bg-white` | 80 / 112 | Bundle Services. Save More. |
| 5 | `bg-brand-blue` | 40 / 48 | (CTA band) |
| 6 | `bg-white` | 80 / 112 | Every Pest Problem. One Team. |
| 7 | `bg-brand-blue` | 80 / 112 | Get Your Price. Keep Your Saturday. |
| 8 | `bg-white` | 80 / 112 | It Works, or You Don't Pay. |
| 9 | `bg-brand-blue` | 80 / 112 | Manage Everything From Your Phone. |
| 10 | `bg-white` | 80 / 112 | Pro Tips & DIY Tricks |
| 11 | `bg-brand-blue` | 80 / 112 | 4 Locations Across SWFL |
| 12 | `bg-white` | 80 / 112 | More Happy Neighbors |
| 13 | `bg-brand-blue` | 80 / 112 | Questions We Hear Every Day |

**Pattern:** strict white ↔ `#009CDE` (`bg-brand-blue`, PMS 2925) alternation. All full sections use `py-20 md:py-28` except the compact CTA band (`py-10 md:py-12`).

---

## 10. Hero

```html
<section class="relative overflow-hidden bg-brand-sky">
  <video autoplay muted loop playsinline preload="none"
         poster="/images/brand/waves-ford-2.webp"
         class="absolute inset-0 w-full h-full object-cover opacity-30 hidden md:block">
    <source src="/images/brand/waves-van-hero-section.mp4" type="video/mp4">
  </video>
  <img src="/images/brand/waves-ford-2.webp" …>
  <!-- H1 + form overlay on top -->
</section>
```

- **Background:** `bg-brand-sky` (`#4dc9f6`)
- **Video:** 30% opacity, only rendered at `md:` breakpoint and up (mobile shows the poster image)
- **Poster fallback:** `/images/brand/waves-ford-2.webp`
- **H1:** Anton 48px / 400, white, letter-spacing 0.96px (0.02em), margin-bottom 24px

---

## 11. Breakpoints

Tailwind v4 defaults plus two custom compound queries:

| Name | Query |
|---|---|
| sm | `(min-width: 40rem)` / 640px |
| md | `(min-width: 48rem)` / 768px |
| lg | `(min-width: 64rem)` / 1024px |
| xl | `(min-width: 80rem)` / 1280px |
| 2xl | `(min-width: 96rem)` / 1536px |
| custom | `(max-width: 480px)` — mobile nav tweak |
| custom | `(max-height: 640px)` — short-viewport adjustment |
| custom | `(min-width: 641px) and (min-height: 641px)` |
| custom | `(min-width: 871px) and (min-height: 641px)` |
| custom | `(hover: hover)` — pointer-device hover states |

---

## 12. Quick-reference CSS variable dump

```css
/* Brand (van-wrap spec) */
--color-brand-blue:        #009CDE;  /* PMS 2925 */
--color-brand-blueDeeper:  #1B2C5B;  /* PMS 2766 */
--color-brand-blueDark:    #065A8C;
--color-brand-blueLight:   #E3F5FD;
--color-brand-sky:         #4DC9F6;
--color-brand-gold:        #FFD700;  /* pure gold — not PMS 7563 */
--color-brand-yellow:      #FFF176;
--color-brand-red:         #C8102E;  /* PMS 186  */

/* Fonts */
--font-heading:    "Anton", "Burbank Big Condensed", "Luckiest Guy", cursive;
--font-subheading: "Montserrat", "Inter", system-ui, sans-serif;
--font-sans:       "Inter", system-ui, sans-serif;
--font-serif:      "Source Serif 4", Georgia, "Times New Roman", serif;
--font-mono:       "JetBrains Mono", monospace;

/* Spacing base */
--spacing: .25rem;

/* Radii */
--radius-md: .375rem; --radius-lg: .5rem; --radius-xl: .75rem;
--radius-2xl: 1rem;   --radius-3xl: 1.5rem;

/* Motion */
--default-transition-duration: .15s;
--default-transition-timing-function: cubic-bezier(.4,0,.2,1);
```

---

## 13. Open items / things to verify

1. **Burbank web license:** OTF files are still present in `public/fonts/burbank/` as a legacy fallback, but H1/H2 now render in Anton (Google Fonts — open license). If Burbank is ever re-enabled as the primary face, confirm House Industries web license is in place before public deploy.
2. **CTA hover:** gold `#FFD700` → yellow `#FFF176` on hover. Subtle lightening, currently shipping.
3. **Hero video** has `preload="none"` — good for LCP, but the poster image (`waves-ford-2.webp`) is the actual LCP asset on mobile. Ensure it's preloaded/priority.
4. **Fonts declared but not exercised on homepage:** `text-5xl` through `text-8xl` (48–96px) are tokenized but H1 is the largest actual text on the page at 48px. If any spoke site needs a 60/72/96px display heading, the token is already there.

---

## 14. Portal alignment (waves-customer-portal)

The customer-facing portal (LoginPage, OnboardingPage, EstimateViewPage, PortalPage, ReportViewPage, BookingPage, ReportViewPage) consumes this style guide via `client/src/theme-brand.js`, which is imported by 5 of 6 pages. Palette and fonts there should stay in sync with the tokens above.

**Key equivalents:**

| Style Guide token | theme-brand.js key | Hex |
|---|---|---|
| `--color-brand-blue` | `COLORS.wavesBlue` | `#009CDE` |
| `--color-brand-blueDeeper` | `COLORS.blueDeeper` | `#1B2C5B` |
| `--color-brand-red` | `COLORS.red` / `redBright` | `#C8102E` |
| `--color-brand-gold` | `COLORS.yellow` | `#FFD700` |
| `--font-heading` | `FONTS.display` | `'Anton', 'Luckiest Guy', cursive` |
| `--font-subheading` | `FONTS.heading` | `'Montserrat', 'Inter', system-ui, sans-serif` |
| `--font-sans` | `FONTS.body` / `FONTS.ui` | `'Inter', system-ui, sans-serif` |

**Admin portal (`/admin/*`) is out of scope** — admin stays on the `D` dark palette + DM Sans. Do not apply customer brand palette to admin pages (see `feedback_admin_style_guide_exclusion`).

**BookingPage exception:** has its own local `BRAND` object (does not import from `theme-brand.js`). Keep its tokens aligned manually.
