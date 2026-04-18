# Waves Portal — UI Redesign Specification

A prescriptive design spec for rebuilding the Waves Portal (/admin and /tech) in a monochrome-professional visual language. Written to be handed to Claude Code as an implementation brief.

**Target aesthetic:** Attio / Pylon / Bloomberg Terminal / Stripe Dashboard. Near-white surfaces, hairline 0.5px borders, 6–8px corner radii, essentially monochrome with red reserved exclusively for team alerts, UPPERCASE CTAs with letter-spacing, 13–14px body text, zero gradients, zero shadows except focus rings, light mode only.

**Non-goals:** Notion-style whitespace, Framer-style hero sections, Material Design elevation, rounded-full pill buttons, playful illustrations, Title Case buttons, multi-hue status palettes, dark mode.

**Related specs (separate documents):**

- `waves-customer-facing-design-brief.md` — customer-facing surfaces (estimate, invoice, booking, appointment, portal, post-service) use a warmer, Waves-branded design language. Do not apply this admin spec to those surfaces.
- `DECISIONS.md` — running log of design decisions and the reasoning behind them.

---

## 0. Scope

**Tier 1 — full redesign (this spec gives deep specs):**

1. `/admin/login`
2. `/admin/dashboard`
3. `/admin/dispatch` — absorbs `/admin/schedule` as a calendar view toggle
4. `/admin/customers` + `/admin/customers/:id`
5. `/admin/estimates` + `/admin/estimates/new`
6. `/admin/communications` + `/admin/communications/sms`

**Tier 2 — token pass only (apply tokens, strip colors, uppercase CTAs, fix status indicators; no layout restructuring, no archetype enforcement, no component architecture changes):**

- `/admin/revenue`
- `/admin/reviews`
- `/admin/inventory`
- `/admin/blog`, `/admin/content/blog`, `/admin/seo`, `/admin/ads/*`, `/admin/drafts` — group these as a "Growth" nav section
- `/admin/knowledge`, `/admin/lookup/property`, `/admin/services`, `/admin/protocols/*`
- `/admin/settings/*`, `/admin/workflows/status`, `/admin/tracker`, Referrals, Pipeline/CRM, Preferences

**Out of scope entirely:**

- `/tech` (Tech Home) — **do not touch**. Current implementation works for the techs; revisit only when there's a specific complaint from the field.
- The Intelligence Bar (104 tools across 13 contexts) — needs its own UX design exercise before any visual refresh. Do not restyle piecemeal.
- All customer-facing surfaces — see `waves-customer-facing-design-brief.md`.

**Tech portal, tier 2:**

- `/tech/route`, `/tech/estimate`, `/tech/protocols` — token pass only, preserve existing mobile layout and tap target sizes.

---

## 1. Design Principles

1. **Information density over whitespace.** Employees are doing a job, not browsing. A screen that shows 20 rows of data is better than one that shows 5 prettier rows.
2. **One primary action per view.** Ever. Never two. Secondary actions are outlined. Tertiary actions are ghost buttons or menu items.
3. **Color is a scarce resource.** The interface is essentially monochrome. Red is the only accent and is reserved exclusively for items the team needs to notice and act on: overdue invoices, unassigned jobs, system failures, errors. If everything is colored, nothing is.
4. **State is encoded by shape and weight, not hue.** Filled dark dot = active now. Hollow/outlined dot = dormant or done. Filled red dot = needs attention. Text weight and opacity differentiate completed vs active vs queued work.
5. **Optimistic UI with undo.** No confirmation modals for reversible actions. Toast + undo is the pattern.
6. **Keyboard-first.** Every destination reachable via ⌘K. Every list navigable with j/k. Every modal closeable with Esc.
7. **The list stays visible.** When drilling into a record, the list on the left persists. No full-page navigation traps for common flows.
8. **Tabular numerals everywhere numbers appear.** `font-variant-numeric: tabular-nums` on all metric cards, tables, dates, money, counts.
9. **Sentence case for content. UPPERCASE for structural labels and CTAs only.**

---

## 2. Design Tokens

### 2.1 Color

Two colors: neutral grayscale and alert red. Nothing else. Light mode only.

**Neutral ramp (zinc):**

| Token | Value | Usage |
|-------|-------|-------|
| `bg-canvas` | `#FAFAF9` | Page background |
| `bg-surface` | `#FFFFFF` | Cards, nav, menus |
| `bg-subtle` | `#F4F4F5` | Metric cards, hover, subtle fills |
| `bg-muted` | `#E4E4E7` | Input backgrounds, pressed |
| `border-hairline` | `rgba(9,9,11,0.06)` | Default 0.5px |
| `border-default` | `rgba(9,9,11,0.1)` | Hover, emphasis |
| `border-strong` | `rgba(9,9,11,0.16)` | Active, focus ring base |
| `text-primary` | `#09090B` | Headings, numbers, active state, primary button bg |
| `text-secondary` | `#52525B` | Labels, queued items, muted content |
| `text-tertiary` | `#71717A` | Timestamps, hints, completed/dormant items |
| `text-disabled` | `#A1A1AA` | Disabled controls |

**Alert red — the only chromatic color in the system:**

| Token | Value | Usage |
|-------|-------|-------|
| `alert-bg` | `#FCEBEB` | Alert row/card background tint |
| `alert-border` | `rgba(163, 45, 45, 0.15)` | Hairline border on alert surfaces |
| `alert-dot` | `#C8312F` | Status dot fill |
| `alert-text` | `#A32D2D` | Text on alert backgrounds, badge text |
| `alert-text-strong` | `#791F1F` | Text on strong alert fills (rare) |

**Red is reserved for these states and nothing else:**

- Overdue invoices or payments past due
- Unassigned jobs, jobs without a tech, scheduling gaps
- System failures, API errors, agent failures in Tool Health
- Form validation errors
- Destructive action confirmations (delete, void, cancel)
- Alert counts in global status indicators

**Red is NOT used for:**

- Active / En route / In progress (use filled dark dot + primary text)
- Complete / Paid / Done (use hollow outlined dot + tertiary text)
- Queued / Scheduled / Pending (use hollow outlined dot + secondary text)
- Positive metric deltas (tertiary text, no color)
- WaveGuard tier badges (monochrome)
- Draft / unpublished / inactive states (tertiary text)

**WaveGuard tier badges (monochrome):** all tier pills use `bg-subtle` + `text-primary`, weight 500, UPPERCASE, 10px, `radius-xs`. Differentiation is textual (`BRONZE` vs `PLATINUM`), not chromatic.

**Rules of color use:**

- 95% of every screen is neutral grayscale.
- Red appears only when user attention is required. If a screen has no alerts, it has no color.
- Charts use neutral grayscale: `text-primary` for the highlighted series, `text-tertiary` for comparison. No multi-hue legends.
- Hover states are background tints (`bg-subtle`), never color changes.
- Links in body copy: `text-primary` with `text-decoration: underline; text-underline-offset: 2px`.

### 2.2 Typography

**Font stack:** `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`
Alternative: `Geist`. Load via `@fontsource/inter` weights 400 and 500 only.
**Numerals:** `font-variant-numeric: tabular-nums` on all data. Utility class `.tabular`.
**Mono:** `"JetBrains Mono", "SF Mono", Menlo, monospace` for IDs, SKUs, codes.

**Scale:**

| Token | Size | Line height | Weight | Letter-spacing | Case | Usage |
|-------|------|-------------|--------|----------------|------|-------|
| `text-display` | 28px | 1.2 | 500 | -0.02em | sentence | Revenue hero only |
| `text-h1` | 22px | 1.3 | 500 | -0.015em | sentence | Page title |
| `text-h2` | 18px | 1.35 | 500 | -0.005em | sentence | Section heading |
| `text-h3` | 14px | 1.4 | 500 | 0 | sentence | Card title |
| `text-metric` | 20px | 1.2 | 500 | -0.015em | — | Metric card value |
| `text-body` | 13px | 1.5 | 400 | 0 | sentence | Default body, table cells |
| `text-body-lg` | 14px | 1.5 | 400 | 0 | sentence | Emphasized body |
| `text-label` | 12px | 1.4 | 500 | 0 | sentence | Form labels |
| `text-caption` | 11px | 1.4 | 400 | 0 | sentence | Timestamps, helper text |
| `text-overline` | 10–11px | 1.3 | 500 | 0.06em | UPPERCASE | Section dividers, column headers, status chips |
| `text-button` | 11px | 1 | 500 | 0.06em | UPPERCASE | All button labels |
| `text-nav` | 11px | 1.3 | 500 | 0.06em | UPPERCASE | Top bar page label |

**Weights:** only 400 and 500. No 600, no 700, no italic except for system-generated states.

**Case rules:**

- **Sentence case:** page titles, names, addresses, descriptions, table content, form values, review quotes, paragraph body.
- **UPPERCASE with letter-spacing 0.05–0.06em:** all button labels, table column headers, overline section labels (`CONTACT`, `PROPERTY`, `TOOL HEALTH`), status chips (`COMPLETE`, `EN ROUTE`, `OPEN`), nav page labels (`DASHBOARD`), tier badges (`PLATINUM`).
- Never Title Case. Never ALL CAPS without letter-spacing.

### 2.3 Spacing

4px base grid. Use: `0, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 32, 40, 48, 64`.

| Context | Value |
|---------|-------|
| Icon-to-text gap | 6px |
| Inline gap (inside row) | 8px |
| Card padding | 11px 13px (compact) / 16px 20px (roomy) |
| Grid gap | 10px (tight) / 12px (default) |
| Section rhythm | 16 / 20 / 24px |
| Page edge padding | 20px desktop, 16px tablet, 12px mobile |
| Button padding | 5px 10px (sm) / 6px 12px (md) / 8px 14px (lg) |

### 2.4 Borders and radius

- **Default border:** `0.5px solid border-hairline`. Always 0.5px.
- **Hover border:** `0.5px solid border-default`.
- **Focus ring:** `box-shadow: 0 0 0 2px rgba(9,9,11,0.3)` — neutral dark, never chromatic.
- **Alert surface border:** `0.5px solid var(--alert-border)`.
- **Radius:** xs=3px (badges, kbd, tier pills) / sm=4px (buttons, inputs) / md=6px (cards, modals, menus — default) / lg=8px (hero surfaces).
- Never use `radius-xl` or `rounded-full` except for avatars and status dots.
- No border-radius on single-sided borders.

### 2.5 Motion

- Duration: 120ms micro, 200ms state, 280ms page — never longer than 300ms.
- Easing: `cubic-bezier(0.2, 0, 0, 1)` for enters, `cubic-bezier(0.4, 0, 1, 1)` for exits.
- Honor `prefers-reduced-motion`.
- No parallax, no scroll-triggered animation, no shimmers longer than 400ms.

### 2.6 Shadows

None. Only focus rings.

---

## 3. Component Library

Build or adapt from shadcn/ui. Every component below lives in `src/components/ui/`.

### 3.1 Button

Variants: `primary`, `secondary`, `ghost`, `danger`, `icon`.

All text variants use `text-button` styling: 11px, weight 500, UPPERCASE, `letter-spacing: 0.06em`.

| Variant | Background | Border | Text | Hover |
|---------|-----------|--------|------|-------|
| primary | `text-primary` | `0.5px text-primary` | white | 90% opacity |
| secondary | transparent | `0.5px border-hairline` | `text-primary` | `bg-subtle` |
| ghost | transparent | none | `text-secondary` | `bg-subtle`, text → primary |
| danger | transparent | `0.5px border-hairline` | `alert-text` | `alert-bg` |
| icon | transparent | none | `text-secondary` | `bg-subtle` |

Sizes: sm (24px) / md (28–30px, default) / lg (32px). Admin cap 32px. **One primary per view.**

### 3.2 Input / Select / Textarea

- Heights: 28/32/36px. Admin default 32px.
- `bg-surface`, `border-hairline`, 2px neutral dark focus ring.
- Placeholder: `text-tertiary`. Padding: 6px 10px sm / 8px 12px md.
- Label above, sentence case, `text-label`. Never floating labels.

### 3.3 Status indicator

State encoded by dot shape and text treatment.

| State | Dot | Text |
|-------|-----|------|
| Active / En route / In progress | 5px filled, `text-primary` | `text-primary`, 500, UPPERCASE |
| Queued / Scheduled / Pending | 5px hollow, 1px `text-secondary` border | `text-secondary`, UPPERCASE |
| Complete / Paid / Done | 5px hollow, 1px `text-tertiary` border | `text-tertiary`, UPPERCASE |
| Alert / Open / Overdue / Failed | 5px filled, `alert-dot` | `alert-text`, 500, UPPERCASE |

Chip labels: 10px, 500, `letter-spacing: 0.04em`, UPPERCASE, 6px gap between dot and text.

### 3.4 Cards

- **Metric card** (`bg-subtle`, no border): overline label + `text-metric` number + `text-caption` delta in tertiary. If metric is in alert state, use `alert-bg` + `alert-border` + red text.
- **Surface card** (`bg-surface`, 0.5px border, `radius-md`): for contact, property, sidebar modules.
- **Data card** (`bg-surface`, 0.5px border): for list rows, padding on rows not container.

### 3.5 Tables

Flex/grid rows, not `<table>` unless sorting is needed.

- Row height: 36px default / 32px compact.
- First column: fixed, tabular-nums, tertiary. Last column: fixed, status or action.
- Middle: `flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;`.
- Row state: completed → tertiary. Active → `bg-subtle` + primary + 500 on key columns. Queued → secondary. Alert → `alert-bg` + `alert-text`.
- Header row: `text-overline`, 8px vertical padding, 0.5px bottom border.
- No zebra striping.

### 3.6 Command palette (⌘K)

Preserve existing `GlobalCommandPalette` behavior. Update visuals: `bg-surface`, `radius-md`, 0.5px border, 560px max-width, 120px from top. Search 40px tall no border with bottom hairline. Results 36px rows. Kbd hints at bottom.

### 3.7 Top bar

48px tall, `bg-surface`, 0.5px bottom border.

**Layout:** Waves mark (20px, `text-primary` bg, white W) → page label UPPERCASE (`text-nav`, parents secondary + current primary 500) → flex → command palette trigger (320px, `bg-subtle`, 28px, placeholder sentence case + `⌘K` kbd) → flex → global alert indicator (red filled dot + `N ALERTS` in `alert-text`, UPPERCASE — hide entirely when 0) → user avatar (24px, `bg-subtle`, `text-primary` initials, 0.5px border, never colored).

### 3.8 Left nav (admin)

220px expanded / 52px collapsed. `bg-surface`, 0.5px right border.

**Primary sections** (sentence case, 13px):

- Dashboard
- Dispatch
- Customers
- Estimates
- Communications

**Collapsible groups** with `text-overline` label:

- `GROWTH` — Revenue, Reviews, Blog, SEO, PPC, Drafts
- `OPERATIONS` — Inventory, Services, Protocols, Workflows, Property Lookup, Tracker
- `SETTINGS` — Knowledge, Referrals, Pipeline, Preferences, Settings

Active: `bg-subtle` + 2px `text-primary` left border + 500 weight. Hover: `bg-subtle` only. Item height: 30px. Alert badge: small 4px red dot on the right, never a numbered bubble.

### 3.9 Toasts — two tiers

**Tier 1: Alert toast (red).** Errors, failures, destructive confirmations. `alert-bg`, `alert-border`, `alert-text`. Bottom-right. 8000ms auto-dismiss if undo present, 5000ms otherwise.

**Tier 2: Neutral toast (grayscale).** Positive confirmations, non-urgent notifications — "Payment cleared", "New review", "Lead received", "Estimate sent". `bg-surface`, `border-hairline`, `text-primary`. **Top-right** (visually distinct from bottom-right alert stack). 4000ms auto-dismiss. No undo action (these are informational, not reversible).

Both types: 40px tall, 0.5px border, `radius-md`, 12px 14px padding, body 13px. Stack limit 3 per tier — older collapse into `+N MORE` pill.

### 3.10 Modal / sheet

Modal: 560px max-width, centered, `bg-surface`, `radius-md`, 0.5px border. Overlay `rgba(9,9,11,0.4)`. Sheet: right-slide, 480px, full height. Header 48px + title `text-h2` + actions + close. Body 16px 20px. Optional 56px footer with right-aligned actions.

### 3.11 Empty state

240px centered. 32px outlined icon in tertiary. `text-h3` headline sentence case. `text-caption` supporting line. Primary button UPPERCASE.

### 3.12 Tabs

32px tall, `text-body` size (sentence case), underline active (1px `text-primary`). Inactive: `text-tertiary`. 12–16px gap. Never boxed/pill.

### 3.13 Kbd

10–11px `text-secondary` on `bg-subtle`, `radius-xs`, 1px 5px padding, 0.5px border.

---

## 4. Layout Archetypes

**A. Auth** — Centered card on canvas. 380px wide, 24px padding, `radius-md`, 0.5px border.

**B. Dashboard** — Top bar → page title row → 4-col metric grid → 2-col body (2/3 : 1/3).

**C. List + detail** — Top bar → sidebar → list + right detail sheet (pinned by default). List stays visible. Selected row: `bg-subtle` + 2px `text-primary` left border.

**D. Map + panel** — Top bar → sidebar → 360px left panel + map fills right. Map controls top-right.

**E. Calendar** (rendered *inside* Dispatch as a view toggle, not its own archetype) — week/day/month segmented control, grid fills remaining, right inspector sheet.

**F. Form / multi-step flow** — Top bar → centered 720px column → step progress → form body → sticky footer with back/continue.

**G. Table-first** — Top bar → sidebar → filter bar (search + multi-select filters + saved views) → table.

**H. Reference / docs** — Top bar → sidebar → in-page TOC + article max 720px.

**I. Mobile field** — Full viewport, no sidebar, bottom tab bar 56px. Thumb-reachable primary at bottom.

---

## 5. Tier 1 Page Specs

### 5.1 `/admin/login` — Archetype A

Card: Waves mark (32px centered), "Sign in to Waves Portal" (`text-h2`, sentence case), email input, password input, `SIGN IN` primary full-width, "Forgot password" ghost link. Inline errors under fields in `alert-text` 11px — never modals. Below card: 11px tertiary "Waves Pest Control & Lawn Care · v2.x".

### 5.2 `/admin/dashboard` — Archetype B

**Metric row (4 cards):**

1. Revenue MTD — number + delta in tertiary (never green).
2. Jobs today — number + completed/total split.
3. Open estimates — number + pipeline $.
4. Overdue invoices — alert styling if count > 0.

**Left column (2/3):**

- "Today's dispatch" — 8 rows, tech + status dot. Completed → tertiary. Active → `bg-subtle`. Unassigned → alert row. Click jumps to Dispatch with job selected.
- "Recent estimates" — 6 rows, status + age. Click → estimate detail.

**Right column (1/3):**

- `BI BRIEFING` card — Weekly BI Briefing Agent output. Headline sentence case + 3 bullets + `OPEN FULL BRIEFING` ghost.
- `REVIEWS` card — `4.9 · 187` numeric in header, recent quote, "4 new this week" tertiary (no "+", no color).
- `TOOL HEALTH` card — 5 rows. OK: hollow dot + tertiary. Failing: filled red dot + red text.

**Remove during migration:** hero banners, welcome messages ("Good morning, Waves"), motivational copy, colored backgrounds for non-alert metrics.

### 5.3 `/admin/dispatch` — Archetype D (absorbs `/admin/schedule`)

Schedule lives inside Dispatch as a view toggle — segmented control top-left: `MAP` (default) / `DAY` / `WEEK` / `MONTH`. Map archetype when MAP is active; Calendar archetype (E) inside this page when a date view is active.

**Left panel (360px):**

- Date picker top, arrow-key navigable.
- Tabs: `UNASSIGNED` / `ASSIGNED` / `IN PROGRESS` / `COMPLETE` — counts on each; Unassigned count in red when > 0.
- Job list: 44px rows, customer name (500) + address/ETA secondary + tech initials + status dot. Unassigned rows: alert styling. Drag handle on hover.

**Map area:**

- Mapbox monochrome style (no satellite default).
- Pins: 24px circles with tech initials, neutral grayscale. Selected: 2px dark ring. Unassigned: filled red.
- Route lines: 2px dark gray at 40% opacity, selected tech at 100%.
- Top-right controls: layer, zoom, recenter. Icon buttons only.
- Bottom-left tech legend.

**Calendar view (when active):**

- 7-column week grid, 15-min rows. Optional tech swim lanes toggle.
- Event cards: customer + service sentence case, tech initials corner.
- Drag to reschedule, edge to resize.
- Right inspector sheet on event click: `OPEN CUSTOMER` / `RESCHEDULE` / `CANCEL JOB`.

**Bulk actions:** multi-select → bar at top of panel with `ASSIGN TO TECH` / `RESCHEDULE` / `NOTIFY CUSTOMERS`.

### 5.4 `/admin/customers` + `/admin/customers/:id` — Archetype C

**List page:**

- Filter bar: search 280px left + Status / Tier / Territory / Tech filters + saved views chips UPPERCASE (`MY ASSIGNED`, `OVERDUE`, `PLATINUM ONLY`). `+ NEW CUSTOMER` primary right.
- Columns: Name (sentence case), City, Tier (monochrome pill), Services count, Last service date, Status dot. 36px rows, tabular on counts and dates.
- Detail opens as right sheet by default.

**Detail:**

- Header: Name `text-h1` + tier pill (monochrome) + active/inactive dot. Right: `MESSAGE` / `SCHEDULE` secondary / `NEW ESTIMATE` primary.
- Metric row (4): Lifetime value, Services YTD, Next visit, Assigned tech. Alert card if overdue.
- **Left (grow):** tabbed content — All / Services / Invoices / Notes / Communications. Content is a data table.
- **Right (220px):** three surface cards — `CONTACT`, `PROPERTY` (lot, turf sqft, home sqft, built year, grass type), `WAVEGUARD` (per-service status, dot + UPPERCASE).

### 5.5 `/admin/estimates` + `/admin/estimates/new` — Archetype G (list) / F (new)

**List:**

- Filters: search, status (Draft/Sent/Viewed/Accepted/Expired/Lost), age, $ range, service line.
- Columns: Est # (mono tabular), Customer, Property, Services (chips), Total (tabular), Sent date, Status, Age.
- Expired/Lost → tertiary. Stale (Sent > 14d no view) → alert row.
- Row click opens right sheet with customer-facing preview and admin controls: `EDIT` / `DUPLICATE` / `VOID` (danger) / `RESEND`.

**`/new` flow — 4 steps:**

1. Customer (search or `+ CREATE`) — skip if entered from Customer Detail.
2. Property (address → satellite + RentCast → confirm sqft/lot/home).
3. Services (service picker with bracket pricing, discount library, add-ons).
4. Review & send (preview, delivery: email/SMS/portal).

Progress dots top (current filled, future hollow). Sticky footer: `BACK` ghost / `SAVE DRAFT` secondary / `CONTINUE` primary.

### 5.6 `/admin/communications` — Archetype C

Sub-routes: unified inbox (default) and `/sms` (channel-scoped).

- **List:** threads by most-recent message. Row: customer name + 2-line preview + timestamp + channel icon + unread dot (dark, not colored).
- **Detail panel:** chat thread with channel tabs at top. Reply composer bottom — 60px auto-growing, attachment icon, template picker, `SEND` button.
- **Voice Agent transcripts:** phone icon, speaker-separated blocks, AI summary at top (3-line collapsed, expandable).

---

## 6. Tier 2 — Token Pass Only

For every other admin route, Claude Code applies tokens (§2), swaps buttons to UPPERCASE per §3.1, strips any colored Tailwind classes (see §7.6), converts status indicators to §3.3 dot system, and **stops there**. No layout restructuring, no archetype enforcement, no consolidation.

The pages receiving this treatment: `/admin/revenue`, `/admin/reviews`, `/admin/inventory`, `/admin/blog`, `/admin/content/blog`, `/admin/seo`, `/admin/ads/*`, `/admin/drafts`, `/admin/knowledge`, `/admin/lookup/property`, `/admin/services`, `/admin/protocols/*`, `/admin/settings/*`, `/admin/workflows/status`, `/admin/tracker`, Referrals, Pipeline/CRM, Preferences.

If any tier 2 page genuinely obstructs daily work during the tier 1 migration, promote it to tier 1 with a proper spec — don't inline-redesign it during a token pass.

---

## 7. Tech Portal

**`/tech` (Tech Home): DO NOT TOUCH.** Current implementation is working for Jose, Jacob, and Adam. Revisit only when a tech reports a specific problem.

**`/tech/route`, `/tech/estimate`, `/tech/protocols`: tier 2 token pass only.**

Preserve existing mobile layout, tap target sizes (44px minimum), and bottom tab bar behavior. Apply tokens, strip colored classes, convert status indicators per §3.3. No archetype changes, no restructuring.

---

## 8. Implementation Notes

### 8.1 Stack

- **Styling:** Tailwind with custom theme per §2. No `shadow-*`. No dark mode config.
- **Components:** shadcn/ui base, tree-shaken. `components.json` uses neutral zinc and 6px default radius.
- **Icons:** `lucide-react` — 16px admin, 20px tech.
- **Fonts:** Inter via `@fontsource/inter` weights 400 + 500 only.
- **Charts:** Recharts stripped of default styling. Monochrome only.

### 8.2 Storybook is the canonical visual reference

Before building any page, stand up Storybook (or a single `/admin/_design-system` internal route) with every component from §3 rendered in every state (default, hover, active, disabled, loading, error, empty). When Claude Code implements a page, its reference should be the rendered Storybook component — not the prose in this spec. Prose specs drift. Rendered components don't.

**Order:** Storybook + tokens ship in PR #1, before any page migration begins. Every subsequent PR updates Storybook when a new state is needed.

### 8.3 Feature flags — mandatory

Every tier 1 redesign ships behind a per-user feature flag. Never deploy a redesigned page to all users at once.

**Rollout per page:**

1. Flag ships off for everyone.
2. Turn on for operator (you) for 1 day. Self-test against §7.5 preservation checklist.
3. Turn on for Virginia for 1 business day. She logs issues in shared doc.
4. Triage her list. If anything is broken or confusing, fix before promoting.
5. Turn on for all admin users.
6. Remove the flag after 2 weeks stable.

Use LaunchDarkly, PostHog flags, or a hand-rolled env-var toggle — any of these work. The point is **instant rollback without a deploy**.

### 8.4 Formal UAT with Virginia

After the operator-day and before the all-users flip, each tier 1 page gets a Virginia day. She uses it for real work. She logs anything awkward in a shared doc (Google Doc or Linear issue — doesn't matter which, pick one and stick to it). Her notes are triaged before the flag flips. This is non-optional.

### 8.5 Performance measurement

Before migration starts: record Lighthouse scores and Core Web Vitals for Dashboard, Dispatch, Customers, Customer Detail, Estimates, and Communications. Store in `DECISIONS.md` as a baseline.

After each page migration: re-measure. If LCP increases, JS bundle grows more than 10%, or CLS regresses — investigate before merging. Beautiful UI that paints slowly is a regression.

### 8.6 DECISIONS.md

Maintain a running decision log at the repo root. Each major design or architectural call gets a paragraph explaining the *why*, not just the *what*. See the separate `DECISIONS.md` template for the starter state. Add to it as calls are made. This prevents re-litigation three months from now when someone asks "why is everything uppercase?"

### 8.7 Tailwind config snippet

```js
// tailwind.config.js extend
colors: {
  canvas: 'hsl(60 9% 98%)',
  surface: 'hsl(0 0% 100%)',
  subtle: 'hsl(240 5% 96%)',
  muted: 'hsl(240 5% 90%)',
  border: {
    DEFAULT: 'hsl(240 6% 90% / 0.6)',
    strong: 'hsl(240 5% 84%)',
    alert: 'hsl(0 56% 41% / 0.15)',
  },
  foreground: {
    DEFAULT: 'hsl(240 10% 4%)',
    secondary: 'hsl(240 4% 36%)',
    tertiary: 'hsl(240 4% 46%)',
    disabled: 'hsl(240 5% 64%)',
  },
  alert: {
    bg: '#FCEBEB',
    dot: '#C8312F',
    text: '#A32D2D',
    strong: '#791F1F',
  },
},
fontSize: {
  'caption': ['11px', { lineHeight: '1.4' }],
  'label': ['12px', { lineHeight: '1.4', fontWeight: '500' }],
  'body': ['13px', { lineHeight: '1.5' }],
  'body-lg': ['14px', { lineHeight: '1.5' }],
  'metric': ['20px', { lineHeight: '1.2', fontWeight: '500', letterSpacing: '-0.015em' }],
  'h3': ['14px', { lineHeight: '1.4', fontWeight: '500' }],
  'h2': ['18px', { lineHeight: '1.35', fontWeight: '500', letterSpacing: '-0.005em' }],
  'h1': ['22px', { lineHeight: '1.3', fontWeight: '500', letterSpacing: '-0.015em' }],
  'display': ['28px', { lineHeight: '1.2', fontWeight: '500', letterSpacing: '-0.02em' }],
  'overline': ['10px', { lineHeight: '1.3', fontWeight: '500', letterSpacing: '0.06em' }],
  'button': ['11px', { lineHeight: '1', fontWeight: '500', letterSpacing: '0.06em' }],
  'nav': ['11px', { lineHeight: '1.3', fontWeight: '500', letterSpacing: '0.06em' }],
},
borderRadius: { xs: '3px', sm: '4px', md: '6px', lg: '8px' },
borderWidth: { DEFAULT: '0.5px' },
fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
```

### 8.8 Utility classes

```css
.uppercase-label {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 500;
}
.tabular { font-variant-numeric: tabular-nums; }
.alert-surface {
  background: var(--alert-bg);
  border: 0.5px solid var(--alert-border);
  color: var(--alert-text);
}
.dot { width: 5px; height: 5px; border-radius: 50%; display: inline-block; }
.dot-filled { background: var(--foreground-DEFAULT); }
.dot-hollow { border: 1px solid var(--foreground-secondary); box-sizing: border-box; }
.dot-alert { background: var(--alert-dot); }
```

### 8.9 Migration order

1. **Storybook + tokens + primitives.** No visible changes to any page yet.
2. **Top bar + left nav.** Instant portal-wide visual refresh.
3. **Dashboard** (§5.2). Lowest complexity tier 1 — validates the language.
4. **Customers + Customer Detail** (§5.4). Virginia's most-used flow.
5. **Dispatch** (§5.3). Highest complexity — do after primitives are proven.
6. **Estimates + new-estimate flow** (§5.5).
7. **Communications** (§5.6).
8. **Tier 2 token pass sweep** — one PR per nav section (Growth, Operations, Settings).

Each tier 1 page goes through: flag-off → operator day → Virginia day → all-users. Tier 2 sweep can ship directly if it passes preservation checklist (§9.5).

### 8.10 What to delete during migration

Audit and remove:

- Any `shadow-*` utility
- Any `rounded-full` except on avatars/status dots
- Any `font-weight: 600` or `700`
- Any `text-green-*` / `text-blue-*` / `text-yellow-*` / `text-amber-*` / `text-purple-*` / `text-teal-*` / `text-orange-*` classes — replace with neutral tokens. Red classes permitted only on alert contexts.
- Any `dark:*` prefixes — dark mode is cut
- Any Title Case button labels — convert to UPPERCASE per §3.1
- Any confirmation modals for reversible actions — replace with toast + undo
- Any dashboard widgets nobody uses (measure before cutting)
- Any emoji in UI copy
- Any star glyphs (★) or decorative typographic flourishes
- Any loading spinners longer than 400ms — replace with skeletons
- Any colored avatar backgrounds

---

## 9. Rules of Engagement for Claude Code

This is a visual refresh across a production codebase handling live customer bookings, Stripe payments, Voice Agent calls, SMS automations, and six Managed Agents running autonomously. Breakage has real operational cost. The rules below keep scope tight and surface decisions before they become problems.

### 9.1 Core stance

**Preserve behavior, change only appearance.** Every page should look different after your work and behave identically. Same routes, same data, same flows, same keyboard shortcuts, same network calls. If you find yourself refactoring state, renaming functions, changing data shapes, modifying APIs, restructuring folders, or touching database queries — stop. Out of scope.

**When in doubt, ask. Never guess.** Better to pause and surface a question than make a plausible-looking change that quietly breaks a flow the spec didn't anticipate. The user would rather answer ten clarifying questions than debug one silent regression in production.

**Small atomic PRs.** Foundation (Storybook + tokens + components) as one PR. Then one page per PR. Never batch multiple pages.

**Read before writing.** Before modifying any file, read it end-to-end. Understand what it does before changing how it looks.

### 9.2 What you must NOT change

Even if it looks ugly or disorganized, leave it alone unless the spec tells you to change it.

- **Business logic** — pricing, estimate engine, satellite analysis, bracket interpolation, discounts, tax, agronomic decision trees. Anything under `/services/`, `/lib/business/`, `/engines/`, or named `calculate*`, `compute*`, `resolve*`, `price*`, `estimate*`.
- **Data contracts** — props shapes, API response types, DB queries, Zod schemas, TS interfaces on domain entities. If your change edits a `.d.ts` or schema, it's out of scope.
- **State management** — Zustand stores, React contexts, custom hooks, useReducer, query caches, React Query keys.
- **Routing** — paths, guards, middleware, redirects, params, loaders.
- **Keyboard shortcuts and command palette.** Preserve exactly. If new styling hides an affordance, restore the affordance — never remove the shortcut.
- **Integrations** — Stripe Elements, Twilio flows, Voice Agent ConversationRelay, WordPress REST, DataForSEO, GSC, Arborjet, FAWN, SMS cron.
- **Managed Agents and Intelligence Bar** — prompts, tool configs, 104 tools across 13 contexts. Do not restyle piecemeal.
- **Tests.** If a test breaks, investigate — don't update assertions to pass.
- **Analytics and a11y attributes** — `data-testid`, `data-analytics`, `aria-*`. Preserve verbatim.
- **Environment / config** — `.env`, `railway.json`, `package.json` scripts, CI config, infra.

### 9.3 What to ask about before acting

- Spec is silent on an element visible on the existing page.
- Removing a component would lose functionality not referenced in spec.
- Existing page behavior differs from spec (e.g. nav vs sheet).
- Change would cascade into another page or shared component.
- Token would break an existing accessibility affordance.
- You find a bug unrelated to the refresh — log it, don't fix.
- New dependency needed.
- File outside the current route needs changing.
- You're considering a "clever" solution that needs a comment to explain.

### 9.4 Workflow per page

1. Read the page end-to-end.
2. Identify scope (§9.2 guides this).
3. **Post a short plan and wait for confirmation before writing code.** Numbered list of changes, questions on anything ambiguous.
4. Implement one concern at a time. Commit between concerns.
5. Self-test against preservation checklist (§9.5).
6. Surface observations — bugs, tech debt, dead code you saw but left alone.

### 9.5 Preservation checklist per page

- Loads without console errors
- All linked routes resolve
- All data loads: empty, loaded, error states
- Forms submit with correct loading/success/error feedback
- All buttons do what they did before
- Keyboard: Tab, Shift+Tab, Enter, Esc, ⌘K, page-specific shortcuts
- Focus visible and managed (modals trap, drawers restore)
- Works at 1440 / 1024 / 768 / 390px
- No `console.log` / `debugger` left behind
- No colored Tailwind classes snuck in
- All buttons UPPERCASE per §3.1
- Red only on action-required elements
- No new dependencies, no new routes, no routes changed
- `data-testid` and `data-analytics` preserved verbatim
- Tests pass

### 9.6 When to stop immediately

- Editing a file in `/services/`, `/lib/business/`, `/api/`, `/db/`, `/agents/`, `/engines/`
- Changing a type or schema
- Deleting a multi-page component
- Test failing without clear cause
- Spec contradicts itself
- Introducing a new library or architectural pattern
- Page has features spec doesn't mention
- Single task needs > ~5 file changes
- Existing integration code looks broken or suspicious
- You catch yourself thinking "I'll also just quickly…"
- Something in the codebase surprises you

### 9.7 Commit hygiene

- One concern per commit.
- Format: `<scope>: <change>` — `tokens: add monochrome palette`, `dashboard: apply metric cards`.
- PR description references spec section: *"Implements §5.2 Dashboard per spec."*
- PR body includes ticked §9.5 checklist + observations note.
- Never force-push shared branches.

### 9.8 The failure mode to avoid

**Silent regressions from over-reach.** The pattern: AI completes the styling task correctly, *and* tidies adjacent code, *and* refactors a hook that looked off, *and* renames a file for consistency. Each change seems harmless. In aggregate, something downstream breaks, and debugging is a scattered diff across 40 files instead of a focused diff across 5.

If the spec doesn't tell you to change it, don't change it. Note it in observations. The operator will triage. Your job is styling, nothing else.
