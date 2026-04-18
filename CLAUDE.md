# CLAUDE.md — Waves Customer Portal

This file provides context for Claude Code sessions working on the waves-customer-portal monorepo.

## Dev Workflow

- Always start `npm run dev` in background on session start
- Monitor build output for errors and warnings
- If errors appear, diagnose and fix immediately before continuing other work
- After every commit, create a fresh tar.gz in ~/Downloads (exclude node_modules, .git, dist)

## Active initiative: Admin UI redesign (Tier 1)

Authoritative specs live in `docs/design/`:
- `waves-portal-ui-redesign-spec.md` — full monochrome admin spec
- `waves-customer-facing-design-brief.md` — separate warmer language for customer surfaces (do not apply admin spec there)
- `DECISIONS.md` — architectural decisions log; append new entries at bottom, never edit old ones

Tier 1 scope (full redesign): Dashboard, Dispatch (absorbs Schedule), Customers + Detail, Estimates + `/new`, Communications. Everything else = tier 2 token pass only. `/tech` Home, Intelligence Bar, and customer-facing surfaces are **out of scope**.

**Feature flags (landed PR #2):** The redesign is rolled out page-by-page behind per-user flags stored in `user_feature_flags`. On the client, use `useFeatureFlag('<key>')` from `client/src/hooks/useFeatureFlag.js` — it fetches once per session, caches in-memory, fails closed (returns `false` if the API is unreachable), and does NOT persist to localStorage. Server routes live at `/api/admin/feature-flags` (admin-only for `/all` and `/toggle`). Flip flags via the UI at `/admin/_design-system/flags`. Do not add percentage rollouts, environment variants, or LaunchDarkly-style features to the schema — it is intentionally minimal.

**Dashboard (landed PR #2):** `/admin/dashboard` renders `DashboardGate`, which switches between `DashboardPage` (V1, default) and `DashboardPageV2` (monochrome redesign) based on the `dashboard-v2` flag. **Visual-refresh PRs are strict 1:1 on data, metrics, routing, and behavior** — V2 calls the exact same APIs and shows the exact same metric set as V1. Content changes and visual changes never share a PR.

**Dispatch Board (landed PR #3a):** `/admin/schedule` renders `DispatchGate`, which switches between `SchedulePage` (V1) and `DispatchPageV2` (monochrome redesign) based on the `dispatch-v2` flag. V2 restyles only the Board tab in day view (header, date nav, stats strip, Today's Focus, weather bar, TechSection + ServiceCard). Week/Month calendar views, the Protocols/Match/CSR/Job Scores/Insights tabs, RecurringAlertsBanner, ScheduleIntelligenceBar, and all modals (Completion/Reschedule/Edit/Protocol) still render V1 components unchanged — they'll get their own refresh in PR #3b/3c. To reuse V1's modals without duplicating ~1,500 lines, `EditServiceModal`/`ProtocolPanel`/`RescheduleModal`/`CompletionPanel`/`ProtocolReferenceTab`/`RecurringAlertsBanner` are named-exported from `SchedulePage.jsx`.

**Dispatch Week/Month views (landed PR #3b):** `client/src/components/schedule/CalendarViewsV2.jsx` exports `ViewModeSelectorV2`, `WeekViewV2`, `MonthViewV2` — monochrome versions of the V1 calendar components. Strict 1:1 with V1 on endpoints (`/admin/schedule/week`, `/admin/schedule/month`), slice counts (5/day week, 3/day month), and summary shape (total/completed/pending/unique + byCategory + byTech). Category color-coding collapses to zinc-900 dots; emoji icons dropped; teal/amber/purple accents replaced by zinc ramp + hairlines. V1 `CalendarViews.jsx` is untouched — flag-off SchedulePage keeps its current look.

**Dispatch AI/command surfaces (landed PR #3c):** Six V2 components under the `dispatch-v2` flag — all same endpoints and payloads as V1, monochrome chrome only. `components/dispatch/TechMatchPanelV2.jsx` (rules + simulator, alert-fg reserved for `required`), `CSRPanelV2.jsx` (scenario picker + slot cards), `RevenuePanelV2.jsx` (job-score list, alert tier fires only on score<55), `InsightsPanelV2.jsx` (summary + tech grid + forecast bars, alert-fg on drive%>25 / callback%>6 / variance<0). Plus `components/schedule/RecurringAlertsBannerV2.jsx` (banner uses alert-bg — these are action items) and `components/admin/ScheduleIntelligenceBarV2.jsx` (flat hairline container, plain dot bullets, no gradient). ProtocolReferenceTab stays V1 in PR #3c — it's a dense reference table with bespoke helpers (CurrentVisitCard, TierDots) and will get its own PR #3d.

**Dispatch ProtocolReferenceTab (landed PR #3d):** `client/src/pages/admin/ProtocolReferenceTabV2.jsx` replaces the V1 table behind the `dispatch-v2` flag. Strict 1:1 with V1 on endpoints (GET `/admin/protocols/programs`, GET `/admin/protocols/programs?track=<key>`, GET `/admin/protocols/programs?program=tree_shrub`), state (programs/selectedTrack/trackData/loading/showFullCalendar), month-match logic, and data shape. V2 uses `components/ui` primitives (`Button`, `Badge`, `Card`, `cn`), Tailwind zinc ramp, and reserves `alert-fg` only for the SAFETY bar, weather/threshold warnings inside the Current Visit card, and `⚠`-prefixed track-level notes. Tier dots collapse to zinc-900 filled / zinc-400 outlined; selected-track pill is zinc-900 (no teal); current-month row uses a zinc-50 fill (no teal highlight). `MONTH_NAMES`, `PRODUCT_DESCRIPTIONS`, `TRACK_SAFETY_RULES`, and `stripLegacyBoilerplate` are named-exported from `SchedulePage.jsx` so V1 and V2 share a single source for those static lookups. V1 `ProtocolReferenceTab` still ships for flag-off users.

**Customers — Directory + chrome (landed PR #4a):** `/admin/customers` renders `CustomersGate`, which switches between `CustomersPage` (V1) and `CustomersPageV2` (monochrome redesign) based on the `customers-v2` flag. V2 restyles only the header (view toggle, search, + Add), filter pills (City / Tier / Status / Has Balance), Directory list view (desktop grid rows + mobile cards + inline edit + pagination), and `QuickAddModalV2`. Pipeline / Map / Health / AI Advisor tabs still render V1 panels unchanged — they're reused via named exports from `CustomersPage.jsx` (`STAGES`, `STAGE_MAP`, `KANBAN_STAGES`, `LEAD_SOURCES`, `TIER_COLORS`, `CustomerMap`, `PipelineColumn`, `CustomerIntelligenceTab`). `Customer360Profile` slide-out also stays V1 until PR #4c. Strict 1:1 with V1 on endpoints (`/admin/customers` CRUD + `/admin/customers/pipeline/view`), filter shape, sort keys, and debounce behavior. Tier colors (purple/gold/teal) collapse to neutral Badges; alert-fg reserved for at-risk / churned / Has Balance / health<40. V1 generic `IntelligenceBar` still renders inside V2 — its reskin is deferred with the rest of the Intelligence Bar UX work.

**Customers — Pipeline kanban (landed PR #4b):** `PipelineColumnV2` + `PipelineCardV2` are defined inline in `CustomersPageV2.jsx` and render the Pipeline tab under the `customers-v2` flag. Strict 1:1 with V1 on endpoint (`/admin/customers/pipeline/view`), stage grouping (`KANBAN_STAGES` + `STAGE_MAP`), delete flow (DELETE `/admin/customers/:id` from the confirm), and monthly-rate sum. V2 uses `components/ui` primitives, Tailwind zinc ramp, and reserves `alert-fg` for the column at_risk/churned dot (header-level urgency signal) + the delete-confirm tint/button only — the STAGES config's teal/amber/purple/red palette collapses to zinc chrome. `HealthDot` + `TierBadgeV2` reused from the existing V2 helpers. V1 `PipelineColumn`/`PipelineCard` stay exported from `CustomersPage.jsx` so flag-off users keep their view.

**Estimates — Pipeline view + tab chrome (landed PR #5a):** `/admin/estimates` renders `EstimatesGate`, which switches between `EstimatePage` (V1) and `EstimatesPageV2` (monochrome redesign) based on the `estimates-v2` flag. V2 restyles only the page header, tab pills (Leads / Estimates / Create Estimate / Pricing Logic), and the Estimates tab itself — stats bar (6 cards), 7-pill filter bar (All / Needs Estimate / Ready to Send / Awaiting / Follow Up Now / Won / Lost), and list rows (status badge, customer info + source icon, urgency + competitor + decline-reason inline badges, tier, monthly total, timeline, action buttons). Leads / Create Estimate / Pricing Logic tabs still render V1 panels unchanged — `EstimateToolView`, `FollowUpModal`, `DeclineModal`, `STATUS_CONFIG`, `PIPELINE_FILTERS`, `classifyEstimate`, `getUrgencyIndicator`, `detectCompetitor` are named-exported from `EstimatePage.jsx`. Strict 1:1 with V1 on endpoints (`/admin/estimates` list, PATCH `/admin/estimates/:id`, POST `/admin/estimates/:id/send` + `/follow-up`), filter classification, urgency thresholds (72h/168h red, 24h/48h neutral), stat formulas. STATUS_CONFIG color map collapses to neutral Badges (alert tone only for declined/expired, strong for accepted); urgency alert-fg reserved for "Going cold" / "Final follow-up"; Follow-Up Overdue stat uses alert-fg only when count>0. Priority flag uses alert-bg. EstimateToolView (the big estimator form), FollowUpModal, and DeclineModal stay V1 in PR #5a — they'll each get their own pass (PR #5b and #5c).

**Estimates — EstimateToolView (landed PR #5b):** The Create Estimate tab in `EstimatesPageV2` now renders `client/src/pages/admin/EstimateToolViewV2.jsx` — a monochrome rewrite of the estimator form. Strict 1:1 with V1 on endpoints (POST `/admin/estimator/property-lookup`, POST `/admin/estimator/satellite-ai`, POST `/admin/estimator/calculate-estimate`, POST `/admin/estimates`, POST `/admin/estimates/:id/send`, POST `/admin/estimates/:id/follow-up`, GET `/admin/customers` search, GET `/admin/discounts`), state machine (form defaults, livePreview memo, lookupStatus, customerSearch, enrichedProfile, existingCustomerMatch, satelliteStatus/Data, discountPresets), pricing options (WaveGuard tiers, grass tracks A/B/C1/C2/D, tree & shrub tiers, termite/rodent/WDO add-ons, manual discount), Google Places autocomplete, multi-channel send (email/SMS/both), and schedule-send. V2 uses the components/ui primitives (`Button`, `Badge`, `Card`, `cn`), Tailwind zinc ramp, `border-hairline` structure, and reserves `alert-fg` for field-verify banners and AI confidence flags only — tier highlight collapses to zinc-900 ring with a neutral ✓, recommended dots become zinc, dimmed tiers use opacity-50. All numeric columns preserve `font-mono u-nums` for tabular alignment. V1 `EstimateToolView` is still exported from `EstimatePage.jsx` (flag-off users continue to hit it) — do not delete it. FollowUpModal and DeclineModal stay V1 in PR #5b; they get their own pass in PR #5c.

**Estimates — Follow-Up + Decline modals (landed PR #5c):** `client/src/components/admin/EstimateModalsV2.jsx` exports `FollowUpModalV2` and `DeclineModalV2`, now rendered inside `EstimatesPageV2` for the two pipeline-row actions. Strict 1:1 with V1 on endpoints (POST `/admin/estimates/:id/follow-up { message }`, PATCH `/admin/estimates/:id { status: 'declined', declineReason }`), default SMS copy (first-name + first address segment), and the `DECLINE_REASONS` list (now named-exported from `EstimatePage.jsx` so both V1 and V2 share a single source). V2 uses the `Dialog`/`DialogHeader`/`DialogBody`/`DialogFooter` primitives, `Textarea` primitive, and `Button` variants — `primary` for Send Follow-Up SMS, `danger` (alert-fg) reserved for the Mark-as-Lost destructive confirm. Decline radio options collapse to zinc-900 dot + zinc-50 selection tint (no red highlight on the row itself — the only red is the final button). V1 `FollowUpModal`/`DeclineModal` stay exported from `EstimatePage.jsx` so flag-off `EstimatePage` keeps working.

**Communications — page chrome + SMS tab (landed PR #6a):** `/admin/communications` renders `CommunicationsGate`, which switches between `CommunicationsPage` (V1) and `CommunicationsPageV2` (monochrome redesign) based on the `comms-v2` flag. V2 restyles the page header ("SMS & Calls"), tab pills (SMS / Calls / Templates / Email / CSR / Notifications), and a full monochrome rewrite of the SMS tab — 6 StatCardV2 filter buttons (All/Received/Sent/Missed/Failed/Unread), Compose Card (From select across 23 `ALL_NUMBERS`, customer-autocomplete To field, active-thread last-inbound preview, Message Textarea with char count, TEMPLATES chip row, Send + AI-Draft buttons, result toast, AI-auto-reply toggle), Conversations/Log view toggle, search input, threads list (unread dot via localStorage-persisted `threadReadAt`), `ConversationViewV2` thread detail with reply composer, and `SmsLogItemV2` message-level log rows. Calls / Templates / CSR tabs still render V1 panels unchanged (`CallLogTab`, `SmsTemplatesTab`, `CSRCoachTab` are named-exported from `CommunicationsPage.jsx` along with `ALL_NUMBERS` and `TEMPLATES` so both V1 and V2 share a single source). Email + Notifications tabs render the existing `EmailAutomationsPanel` and `PushSettings` separate-file panels (passthrough). `SEOIntelligenceBar context="comms"` renders above the tabs in V2 (unchanged — Intelligence Bar reskin is out of scope). Strict 1:1 with V1 on endpoints (GET `/admin/communications/log`, GET `/admin/communications/stats`, POST `/admin/communications/sms`, GET/POST `/admin/communications/ai-auto-reply[-status]`, POST `/admin/communications/ai-draft`, GET `/admin/customers` for To-field search), state machine (filters, smsView 'threads'|'log'|'conversation', activeThread, dirFilter/typeFilter), default from number `+19413187612`, and thread grouping logic. V2 uses `components/ui` primitives, Tailwind zinc ramp, `border-hairline` structure, and reserves `alert-fg` for Unread/Failed stat highlights and the unread dot only.

Foundation landed (PR #1):
- `client/src/components/ui/` — 13 hand-rolled primitives (Button, Input, Select, Checkbox, Radio, Switch, Textarea, Badge, Card, Table, Dialog, Sheet, Tabs) + `cn` helper. Import via `import { Button } from 'components/ui'`.
- `client/tailwind.config.js` — authoritative source for redesign tokens (zinc ramp, alert red, type scale 11–28, letterSpacing `label`/`tight`/`display`, radii xs/sm/md/lg, hairline border width). `darkMode: false` and `fontWeight` restricted to `normal`/`medium` by design — do not add weight 600/700.
- `client/src/styles/tokens.css` — utility classes only (`u-focus-ring`, `u-hairline`, `u-dot*`, `u-nums`, `u-label`). No color duplication — Tailwind config is the single source.
- `@fontsource/inter` weights 400 + 500 loaded in `client/src/index.css`.
- `/admin/_design-system` — canonical primitive reference, gated to dev or `VITE_DESIGN_SYSTEM_ALLOWLIST` user IDs. Not in sidebar nav. Excluded in `client/public/robots.txt`.

**When building Tier 1 pages:** use the new `components/ui` primitives + Tailwind classes + tokens. Do not mix with the legacy `D` palette in Tier 1 components.

**When building anything else (Tier 2 pages, Intelligence Bar tools, tech portal, customer surfaces):** keep using the existing inline-styles + `D` palette pattern documented below. Do not preemptively migrate non-Tier-1 code to the new primitives.

## Rules

1. **Only touch what you're asked to touch.** If the task is "add a tool to the Intelligence Bar," don't refactor the route file, don't update the UI theme, don't reorganize imports in unrelated files.
2. **Don't add features that weren't requested.** No "while I'm here, I also improved..." — scope creep is the enemy.
3. **Don't guess at business logic.** If you're unsure whether a service should be taxable, or what the WaveGuard tier thresholds are, ask — don't assume.
4. **Preserve the existing style.** This project uses inline styles (not Tailwind classes), the `D` color palette object, `adminFetch` for API calls, and `JetBrains Mono` for numbers. Match what's already there.
5. **Don't delete or rename existing files** without explicit instruction. Don't move files between directories.
6. **Test your SQL.** Every Intelligence Bar tool runs Knex queries against PostgreSQL. If a table or column might not exist, wrap it in a try/catch — don't let one bad query crash the whole tool module.
7. **Keep the Intelligence Bar pattern.** New tool modules follow the exact pattern documented below: export `TOOLS` array + `executeTool` function, wire 6 lines into the route file. Don't invent a new architecture.
8. **Stripe is the payment processor. Square is fully phased out.** Do not reference Square in new code.
9. **All automation is native.** Do not reference or suggest Zapier, Make, or any external automation tool.

## Project Overview

Waves Pest Control & Lawn Care — a family-owned company serving SW Florida (Manatee, Sarasota, Charlotte counties). This is a custom AI-native operations platform: React/Vite frontend + Express/Node.js backend + PostgreSQL, deployed on Railway.

**Three interfaces:**
- **Admin portal** (`/admin/*`) — Owner/operator dashboard. Full business management.
- **Customer portal** (`/`) — Customer-facing PWA. Service tracking, payments, referrals.
- **Tech portal** (`/tech/*`) — Field technician mobile app. Route, protocols, estimating.

## Tech Stack

- **Frontend:** React 18 + Vite, inline styles (no Tailwind build), DM Sans / JetBrains Mono / Montserrat fonts
- **Backend:** Express + Node.js, Knex.js query builder
- **Database:** PostgreSQL on Railway
- **Payments:** Stripe (Payment Element — card/Apple Pay/Google Pay/ACH). Square is fully phased out.
- **SMS/Voice:** Twilio (Programmable Messaging, ConversationRelay, Lookup)
- **AI:** Anthropic Claude API (Opus 4.6 for admin, Sonnet for tech/drafting)
- **Deployment:** Railway (portal server + client + PostgreSQL). **Spoke fleet (15 sites):** Astro on Cloudflare Pages/Workers.
- **No Zapier** — all automation is built natively in this monorepo

## Key Team Members

- **Waves** — Owner/operator, primary admin user
- **Virginia** — Office manager/CSR, uses CommunicationsPage and LeadsPage daily
- **Adam** — Lead field technician, uses Tech portal
- **Jose Alvarado, Jacob Heaton** — Field technicians

## Repository Structure

```
waves-customer-portal/
├── server/
│   ├── index.js                    # Express entry, route registration
│   ├── config/                     # locations.js, twilio-numbers.js, protocols.json
│   ├── middleware/                  # admin-auth.js, error handling
│   ├── models/
│   │   ├── db.js                   # Knex instance
│   │   └── migrations/             # Knex migrations (run: npx knex migrate:latest)
│   ├── routes/                     # ~60 Express route files
│   ├── services/                   # Business logic
│   │   ├── intelligence-bar/       # ⭐ Intelligence Bar tool modules
│   │   ├── twilio.js               # SMS/voice service
│   │   ├── google-business.js      # GBP API
│   │   ├── logger.js
│   │   └── ...
│   └── cron/                       # Scheduled jobs
├── client/
│   └── src/
│       ├── components/
│       │   ├── admin/              # Admin components (Intelligence Bar wrappers here)
│       │   ├── tech/               # Tech portal components
│       │   ├── AdminLayout.jsx     # Sidebar + ⌘K GlobalCommandPalette
│       │   └── TechLayout.jsx      # Mobile bottom nav
│       ├── pages/
│       │   ├── admin/              # ~40 admin pages
│       │   └── tech/               # Tech portal pages
│       └── lib/                    # estimateEngine.js, utils
├── CLAUDE.md                       # ← You are here
└── package.json
```

## Environment Variables (Railway)

All credentials in Railway environment variables. Key ones:
- `DATABASE_URL` — PostgreSQL connection
- `ANTHROPIC_API_KEY` — Claude API (used by Intelligence Bar, AI agents, voice agent)
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` — SMS/voice
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — Payments
- `JWT_SECRET` — Admin/tech auth tokens

## Design System

### Current Palette (existing admin pages)

All existing admin pages use inline styles with the `D` dark palette object. **Match this in existing pages:**
```js
const D = {
  bg: '#0f1923', card: '#1e293b', border: '#334155',
  teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b',
  red: '#ef4444', purple: '#a855f7',
  text: '#e2e8f0', muted: '#94a3b8', white: '#fff'
};
```
Fonts: `'DM Sans', sans-serif` (body), `'JetBrains Mono', monospace` (numbers/code), `'Montserrat', sans-serif` (headings in tech portal).

### Brand Palette (extracted from van wrap, mascot, favicon)

When restyling or building new admin pages, use these brand-accurate colors:
```js
const BRAND = {
  // Primary
  blue:         '#0A7EC2',   // Primary brand blue (van wrap, mascot)
  blueDark:     '#065A8C',   // Sidebar bg, active states
  blueDeeper:   '#04395E',   // Sidebar dark mode, headings
  blueLight:    '#E8F4FC',   // Table row hover, card bg
  blue50:       '#F0F7FC',   // Barely-there blue — page backgrounds
  // Accent
  red:          '#C0392B',   // Brand red (cap, overalls, favicon bg)
  redLight:     '#FDECEA',   // Error/danger backgrounds
  gold:         '#F0A500',   // Brand gold (thumbs up, phone number on van)
  goldLight:    '#FEF7E0',   // Warning backgrounds
  // Neutrals
  slate900:     '#0F172A',   // Primary text
  slate700:     '#334155',   // Secondary text
  slate500:     '#64748B',   // Muted text, placeholders
  slate300:     '#CBD5E1',   // Borders, dividers
  slate100:     '#F1F5F9',   // Table stripes, subtle backgrounds
  white:        '#FFFFFF',
  // Semantic
  success:      '#16A34A',
  successLight: '#DCFCE7',
};
```

### Admin UX Model — Jobber-Inspired, Waves-Owned

Use Jobber as the **structural** reference — not a visual clone. Borrow information architecture and usability patterns, apply Waves branding, go deeper on features Jobber can't touch.

**Take from Jobber:**
- Sidebar nav with icon + label, collapsible on desktop, slide-out drawer on mobile
- Section grouping in sidebar (Operations, Customers, Financial, Settings)
- Page structure: page title -> action bar (filters + primary button) -> content area
- Clean tables with consistent column alignment, sortable headers, row hover states
- Card-based dashboards with single-metric focus per card
- 3-tap rule: any common daily task reachable in <=3 clicks from dashboard

**Do differently from Jobber:**
- Deeper data density — Customer 360, Health Scores, Procurement Intelligence. Use progressive disclosure (summary -> expand -> detail page)
- AI-native surfaces — agent status cards, AI-generated insights, inline AI actions
- Brand warmth — `blue` as the anchor color throughout, not grayscale-neutral
- Contextual density — Virginia at office needs info-dense views; Adam/Jose/Jacob in the field need big tap targets. Support both via responsive layout

### Component Standards

**Sidebar:** Desktop 240px wide, `blueDeeper` bg, white text, `blue` active highlight with left border accent. Collapsed: 64px icon-only. Mobile: full-screen slide-out drawer.

**Top Bar:** 56px desktop, 48px mobile. Page title left, search center, user avatar + notifications right. White bg, `slate300` bottom border.

**Dashboard Cards:** CSS Grid `repeat(auto-fill, minmax(280px, 1fr))`. Label (muted, 14px) -> Value (bold, 24px) -> Trend indicator. White bg, subtle shadow, 8px radius. Don't cram charts — a number with context > a tiny chart.

**Tables:** Header `slate100` bg, 14px semibold uppercase. Rows alternating white/`blue50`, hover -> `blueLight`. Mobile: convert to card-stack below 768px.

**Buttons:** Primary: `blue` bg, white text, 6px radius, hover -> `blueDark`. Secondary: white bg, `slate700` text, `slate300` border. Danger: `red` bg, white text — destructive actions only. Default 36px height, compact 32px for table actions.

**Status Badges:** Inline pill, 12px radius, 12px font. Active: `success` on `successLight`. Warning: `gold` on `goldLight`. Danger: `red` on `redLight`. Neutral: `slate700` on `slate100`. Info: `blue` on `blueLight`.

**Modals:** 480px default, 640px forms, 800px complex. Max 90vw mobile. Fade + scale 95%->100% animation.

**Forms:** Labels above input, 14px medium, `slate700`. Inputs 40px height, 6px radius, `slate300` border, focus -> `blue` border + ring. Single column default, two-column >768px for related fields.

### Layout Rules

```
Page Template:
+------------------------------------------------+
|  Top Bar (56px)                                |
+------+-----------------------------------------+
|      |  Page Title          [Primary Action]   |
| Side |  ---------------------------------------  |
| bar  |  Filters / Tabs                         |
|      |  ---------------------------------------  |
| 240  |  Content Area                           |
|  px  |  (table, cards, form, detail view)      |
+------+-----------------------------------------+
```

**Breakpoints:** Desktop >=1024px (sidebar visible). Tablet 768-1023px (sidebar collapsed/hidden). Mobile <768px (sidebar hidden, single-column, tables -> card stacks).

**Content width:** Max 1280px centered. Padding 24px desktop, 16px mobile.

### What NOT To Do

- **No purple gradients.** We're a pest control company, not a fintech startup.
- **No chart overload.** Every chart must answer a specific question. If it doesn't, use a number + trend arrow.
- **No excessive animations.** Page transitions and hover states only. No bouncing, no parallax.
- **No tiny text.** Minimum 14px for anything a user needs to read. Virginia uses this 8 hours a day.
- **No mystery icons.** Every icon gets a text label in the sidebar and a tooltip elsewhere.
- **No gratuitous mascot usage.** The mascot is for customer-facing marketing. Admin gets the "W" mark or wordmark, sparingly. This is a tool, not a billboard.

---

# Intelligence Bar System

The Intelligence Bar is a natural language AI command center embedded across the admin and tech portals. It replaces rigid UI elements (buttons, tabs, static panels) with conversational queries powered by Claude.

## Architecture

```
   ⌘K (any admin page)  or  Embedded bar (13 pages)
        │
   POST /api/admin/intelligence-bar/query
        │
        ├── context parameter determines which tools load
        │
   ┌────┴────────────────────────────────────────────┐
   │  Claude Opus 4.6 (admin) / Sonnet (tech)        │
   │  + base tools (always)                           │
   │  + context-specific tools                        │
   │  + context-specific system prompt                │
   │  + pageData (live state from the UI)             │
   │  + up to 8 tool-use rounds                       │
   └─────────────────────────────────────────────────┘
```

**One Express route serves everything.** The `context` parameter determines which tool modules load and which system prompt extensions apply. No page-specific endpoints.

## File Inventory

### Server — Tool Modules (`server/services/intelligence-bar/`)

| File | Tools | Description |
|------|-------|-------------|
| `tools.js` | 14 | Base tools — customers, revenue, scheduling, SMS. Loaded on EVERY admin context. |
| `schedule-tools.js` | 9 | Route optimization, tech assignment, gap analysis, zone density |
| `dashboard-tools.js` | 10 | KPIs, period comparison, MRR trend, funnel, churn risk |
| `seo-tools.js` | 10 | GSC data, rankings, fleet health, blog performance, backlinks |
| `procurement-tools.js` | 10 | Products, vendors, AI price lookup (Sonnet+web_search), margins |
| `revenue-tools.js` | 6 | Service line P&L, ad attribution, tech RPMH, period comparison |
| `review-tools.js` | 9 | Review stats, AI reply drafting, outreach candidates, velocity |
| `comms-tools.js` | 9 | Unanswered threads, conversation search, call log, AI SMS draft |
| `tax-tools.js` | 10 | Tax dashboard, expenses, depreciation, P&L, quarterly estimates |
| `leads-tools.js` | 9 | Pipeline overview, stale leads, funnel, source ROI, bulk status updates |
| `tech-tools.js` | 8 | Read-only field tools — route, stop details, products, protocols, weather |

**Total: 104 tools across 11 modules.**

### Server — Route & Migration

| File | Purpose |
|------|---------|
| `server/routes/admin-intelligence-bar.js` | Single Express route. Context routing, system prompts, tool-use loop, quick actions endpoint. |
| `server/models/migrations/20260413000001_intelligence_bar.js` | Creates `intelligence_bar_queries` log table. |

### Client — Wrapper Components (`client/src/components/admin/`)

| Component | Pages | Accent |
|-----------|-------|--------|
| `IntelligenceBar.jsx` | CustomersPage | teal |
| `ScheduleIntelligenceBar.jsx` | SchedulePage | teal |
| `DashboardIntelligenceBar.jsx` | DashboardPage | teal |
| `SEOIntelligenceBar.jsx` | SEO, Blog, WordPress, Reviews, Comms, Tax, Leads | teal (context-driven) |
| `ProcurementIntelligenceBar.jsx` | InventoryPage | purple |
| `RevenueIntelligenceBar.jsx` | RevenuePage | green |
| `GlobalCommandPalette.jsx` | AdminLayout (⌘K overlay, every page) | per-context |
| `TechIntelligenceBar.jsx` | TechHomePage (mobile-first) | teal |

**`SEOIntelligenceBar` is the generic reusable wrapper.** It takes a `context` prop and works for any context. Use it for new pages unless the page needs custom `pageData` injection.

### Client — Pages with Embedded Bars

```
✅ DashboardPage        ✅ CustomersPage       ✅ SchedulePage
✅ RevenuePage           ✅ InventoryPage        ✅ SEODashboardPage
✅ BlogPage              ✅ WordPressSitesPage    ✅ TechHomePage
✅ ReviewsPage           ✅ CommunicationsPage    ✅ TaxPage
✅ LeadsPage
```

## Context → Tools Mapping

| Context | Route(s) | Tools loaded | Model |
|---------|----------|-------------|-------|
| `customers` | /admin/customers, /admin/health | base (14) | Opus |
| `leads` | /admin/leads | base + leads (23) | Opus |
| `schedule` | /admin/schedule | base + schedule (23) | Opus |
| `dispatch` | /admin/dispatch | base + schedule (23) | Opus |
| `dashboard` | /admin/dashboard, /admin | base + dashboard (24) | Opus |
| `seo` | /admin/seo, /admin/ppc, /admin/social-media | base + SEO (24) | Opus |
| `blog` | (via SEOIntelligenceBar) | base + SEO (24) | Opus |
| `wordpress` | /admin/wordpress | base + SEO (24) | Opus |
| `procurement` | /admin/inventory | base + procurement (24) | Opus |
| `revenue` | /admin/revenue, /admin/invoices | base + revenue (20) | Opus |
| `reviews` | /admin/reviews, /admin/referrals | base + review (23) | Opus |
| `comms` | /admin/communications | base + comms (23) | Opus |
| `tax` | /admin/tax | base + tax (24) | Opus |
| `tech` | /tech/* | tech ONLY (8) — no base tools | Sonnet |

Tech portal uses Sonnet (not Opus) with max_tokens 1024 for field speed. Tech tools are strictly read-only.

## How to Add a New Tool Module

This is the most common Intelligence Bar task. Follow this exact pattern:

### Step 1: Create the tool module

Create `server/services/intelligence-bar/{context}-tools.js`:

```js
const db = require('../../models/db');
const logger = require('../logger');

const MY_TOOLS = [
  {
    name: 'tool_name',
    description: `What this tool does and when to use it.
Use for: "example query 1", "example query 2"`,
    input_schema: {
      type: 'object',
      properties: {
        param1: { type: 'string', description: 'What this param does' },
      },
    },
  },
  // ... more tools
];

async function executeMyTool(toolName, input) {
  try {
    switch (toolName) {
      case 'tool_name': return await toolImplementation(input);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:mycontext] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

async function toolImplementation(input) {
  // Query the database, return JSON
  const rows = await db('some_table').where(...).select(...);
  return { results: rows, total: rows.length };
}

module.exports = { MY_TOOLS, executeMyTool };
```

### Step 2: Wire into the route (6 changes in `admin-intelligence-bar.js`)

```js
// 1. Import (top of file, with other imports)
const { MY_TOOLS, executeMyTool } = require('../services/intelligence-bar/my-tools');

// 2. Tool names set (after other TOOL_NAMES)
const MY_TOOL_NAMES = new Set(MY_TOOLS.map(t => t.name));

// 3. Context prompt (in CONTEXT_PROMPTS object)
CONTEXT_PROMPTS.mycontext = `
MY CONTEXT:
Description of what this page does and what the operator is trying to accomplish.
...`;

// 4. Tool loading (in getToolsForContext)
if (context === 'mycontext') {
  return [...TOOLS, ...MY_TOOLS];
}

// 5. Tool execution (in executeToolByName)
if (MY_TOOL_NAMES.has(toolName)) {
  return executeMyTool(toolName, input);
}

// 6. Quick actions (in GET /quick-actions handler)
} else if (context === 'mycontext') {
  res.json({ actions: [
    { id: 'action1', label: 'Label', prompt: 'What to ask Claude', icon: '📊' },
    // ...
  ] });
```

### Step 3: Add to GlobalCommandPalette route mapping

In `client/src/components/admin/GlobalCommandPalette.jsx`:

```js
// In ROUTE_CONTEXT_MAP:
'/admin/mypage': 'mycontext',

// In CONTEXT_LABELS:
mycontext: 'My Page Name',

// In CONTEXT_COLORS:
mycontext: D.teal,  // or D.purple, D.green, D.amber, '#3b82f6'
```

### Step 4: Add embedded bar to the page (optional — ⌘K already covers it)

In the page component:
```jsx
import SEOIntelligenceBar from '../../components/admin/SEOIntelligenceBar';

// In the JSX, after the header, before the main content:
<SEOIntelligenceBar context="mycontext" />
```

Only add an embedded bar if the page is data-rich and frequently used. For smaller pages, ⌘K is sufficient.

## Key Design Decisions

- **One route, many contexts.** No page-specific API endpoints. The context parameter drives everything.
- **Base tools always loaded** on admin contexts. This means any admin page can answer "how many active customers?" even if it's the SEO page.
- **Tech portal is isolated.** Only tech tools load (no base tools). All read-only. Uses Sonnet for speed.
- **Write operations require confirmation.** Claude drafts the action, shows it, and waits for "do it" / "send it" before executing.
- **`SEOIntelligenceBar` is the generic wrapper.** Pass a `context` prop. Only create a custom wrapper if you need to inject specific `pageData` from the page's React state.
- **Tool-use loop runs up to 8 rounds.** Complex queries (e.g., "compare March vs April revenue by service type") may chain 2-3 tool calls.
- **`run_price_lookup` and `draft_sms_reply` call Sonnet internally.** These tools spawn their own Claude API calls for content generation.

## What It Replaced

| Removed UI Element | Replaced By |
|---|---|
| Fix Tiers button (CustomersPage) | "fix customer tiers" |
| Optimize Routes button (SchedulePage) | "optimize routes for tomorrow" |
| AI Routes tab (SchedulePage) | "show me zone density gaps" |
| Sync AI Data button (SchedulePage) | queries live data every time |
| AI Price Agent tab (InventoryPage) | "find prices for Demand CS" |
| Static KPI detail panels (DashboardPage) | drill-down conversation |
| AI Tax Advisor tab (TaxPage) | "run the tax advisor" / "any savings opportunities?" |

## Deployment Checklist

- [x] Route registered in `server/index.js`
- [ ] Migration run: `npx knex migrate:latest` (creates `intelligence_bar_queries` table)
- [ ] `ANTHROPIC_API_KEY` set in Railway environment variables
- [ ] Test each context loads correct tools: `POST /api/admin/intelligence-bar/query` with `{ "prompt": "test", "context": "dashboard" }`
- [ ] Verify ⌘K opens on all admin pages and auto-detects context
- [ ] Verify tech portal uses Sonnet (check logs for model used)

---

# Other Systems (Quick Reference)

## Managed Agents (6 agents)
Built on Anthropic's Claude Managed Agents API. Configs in `server/services/agents/`. Blog Content Engine, Backlink Strategy, Customer Assistant, Lead Response, Customer Retention, Weekly BI Briefing.

## Spoke Fleet — Astro on Cloudflare (15 sites)
Hub-and-spoke SEO network. 15 spoke domains covering pest control, exterminator, and lawn care verticals across SWFL markets (Bradenton, Parrish, Palmetto, Sarasota, Venice, North Port). Each spoke is an **Astro** site deployed to **Cloudflare Pages/Workers**. Fleet monitoring, multi-domain GSC integration, multi-site publishing, DataForSEO rank tracking, and a blog content engine with a 157-post calendar.

> **Legacy naming note:** The admin page is still `WordPressSitesPage.jsx` and routes/APIs still use `/admin/wordpress/*` for historical reasons. The underlying platform is Astro + Cloudflare — do not reintroduce WordPress. Rename only on explicit instruction.

## Pricing Engine
Loaded labor rate: $35/hr. Interpolated bracket pricing. Service types: pest control, lawn care (5 grass tracks: A/B/C1/C2/D), tree & shrub, mosquito (WaveGuard tiers), termite, rodent, WDO, specialty. WaveGuard loyalty tiers: Bronze/Silver/Gold/Platinum with tiered discounts.

## Stripe Integration
Payment Element (card/Apple Pay/Google Pay/ACH). All customer/billing data in PostgreSQL. Stripe is the payment processor only — no Stripe customer records used for business logic.

## Twilio Integration
SMS: appointment reminders (Lookup for landline detection), post-service automation, review requests (90-180 min delay), manual messaging. Voice: ConversationRelay + Claude + ElevenLabs/Deepgram. Multiple phone numbers across 4 GBP locations + tracking numbers.
