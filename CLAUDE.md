# CLAUDE.md — Waves Customer Portal

Context for Claude Code sessions working on the waves-customer-portal monorepo.

## Dev Workflow

- Start `npm run dev` in background on session start
- Monitor build output; fix errors immediately before continuing other work
- After every commit, drop a fresh tar.gz into ~/Downloads (exclude node_modules, .git, dist)

## Project Overview

Waves Pest Control & Lawn Care — family-owned, SW Florida (Manatee / Sarasota / Charlotte counties). Custom AI-native operations platform: React/Vite frontend + Express/Node.js backend + PostgreSQL, deployed on Railway.

Three interfaces:
- **Admin portal** (`/admin/*`) — owner/operator dashboard, full business management
- **Customer portal** (`/`) — customer-facing PWA (service tracking, payments, referrals)
- **Tech portal** (`/tech/*`) — field technician mobile app (route, protocols, estimating)

## Tech Stack

- **Frontend:** React 18 + Vite. **Dual style system** — legacy inline styles + `D` palette for Tier 2 pages and the residual shared-export modules; Tailwind + `components/ui` primitives for Tier 1 (now-default) admin pages. Match what the file you're editing already uses; don't mix them inside a single component.
- **Backend:** Express + Node.js, Knex.js
- **Database:** PostgreSQL on Railway
- **Payments:** Stripe (Payment Element — card/Apple Pay/Google Pay/ACH)
- **SMS/Voice:** Twilio (Programmable Messaging, Voice with recording + transcription, Lookup)
- **AI:** Anthropic Claude API. **Never hardcode model IDs** — import `FLAGSHIP` / `WORKHORSE` / `FAST` from `server/config/models.js`. All three currently resolve to `claude-opus-4-7`; tiers can be swapped via `MODEL_FLAGSHIP` / `MODEL_WORKHORSE` / `MODEL_FAST` env vars with no code change.
- **Deployment:** Railway (portal server + client + PostgreSQL). Spoke fleet (15 sites) = Astro on Cloudflare Pages/Workers.

## Key Team Members

- **Waves** — Owner/operator, primary admin user
- **Virginia** — Office manager/CSR; uses CommunicationsPage and LeadsPage daily
- **Adam** — Lead field technician; uses Tech portal
- **Jose Alvarado, Jacob Heaton** — Field technicians

## Rules

1. **Only touch what you're asked to touch.** If the task is "add a tool to the Intelligence Bar," don't refactor the route file, don't update the UI theme, don't reorganize imports in unrelated files.
2. **Don't add features that weren't requested.** No "while I'm here, I also improved..."
3. **Don't guess at business logic.** WaveGuard tier thresholds, taxability rules, pricing brackets — ask.
4. **Match the file's existing style.** Don't mix `D` palette with `components/ui` primitives in the same component.
5. **Don't delete or rename existing files** without explicit instruction. Don't move files between directories.
6. **Test your SQL.** Every Intelligence Bar tool runs Knex queries against PostgreSQL. Wrap uncertain tables/columns in try/catch — don't crash a tool module on one bad query.
7. **Keep the Intelligence Bar pattern.** Tool modules export `TOOLS` + `executeTool`; wire 6 lines into the route file. Don't invent a new architecture. See `server/services/intelligence-bar/README.md` for the template.
8. **Stripe is the payment processor. Square is fully phased out.** Do not reference Square in new code.
9. **All automation and site infra is native.** Do not reference Zapier, Make, Elementor, NitroPack, RankMath, or any external automation/CMS tool in new code.

## Admin UI: V2 is the default

Authoritative specs:
- `docs/design/waves-portal-ui-redesign-spec.md` — full monochrome admin spec
- `docs/design/waves-customer-facing-design-brief.md` — customer-surface warm tone (do NOT apply admin spec to customer surfaces)
- `docs/design/DECISIONS.md` — architectural decisions log + full PR history; append new entries at bottom, never edit old ones

The Tier 1 V2 redesign for Dashboard, Dispatch, Customers + Detail, Estimates + `/new`, Communications, and the admin shell has shipped and is now the default for everyone. The V1 page components, the corresponding per-flag gates (`DashboardGate` / `DispatchGate` / `CustomersGate` / `EstimatesGate` / `CommunicationsGate` / `AdminLayoutGate`), and the V1-only `MobileAdminShell` have been deleted. `/admin/dashboard|customers|estimates|communications` route directly to `*PageV2`; `/admin/dispatch` is `AdminDispatchPage` (Board tab + DispatchPageV2 under tabs); `/admin/schedule` redirects to `/admin/dispatch?tab=schedule`. The admin shell is `AdminLayoutV2`.

**Retained V1 modules (named-export only, no V1 page route):** `SchedulePage.jsx`, `CustomersPage.jsx`, `EstimatePage.jsx`, `CommunicationsPage.jsx` are kept as shared-utility modules — they still export constants and sub-components consumed by V2 (`CompletionPanel` / `RescheduleModal` / `EditServiceModal` / `ProtocolPanel` / `MONTH_NAMES` / `STAGES` / `STAGE_MAP` / `KANBAN_STAGES` / `LEAD_SOURCES` / `CustomerMap` / `CustomerIntelligenceTab` / `STATUS_CONFIG` / `PIPELINE_FILTERS` / `DECLINE_REASONS` / `classifyEstimate` / `getUrgencyIndicator` / `detectCompetitor` / `ALL_NUMBERS` / `NUMBER_LABEL_MAP`). The `export default function ...Page()` component has been gone from each.

**Rules for Tier 1 V2 work (still in effect):**
- Visual-refresh PRs are **strict 1:1** on data, endpoints, metrics, and behavior. Content changes and visual changes never share a PR.
- Use `components/ui` primitives + Tailwind zinc ramp + `border-hairline` chrome.
- `alert-fg` (red) is reserved for genuine alerts only — never decoration.

**Feature flag system:** `useFeatureFlag('<key>')` from `client/src/hooks/useFeatureFlag.js`. DB-backed via `user_feature_flags` table, session-cached in memory, fails closed (returns `false` if API unreachable). No localStorage persistence, no percentage rollouts, no environment variants — the schema is intentionally minimal. The retired V2 keys (`dashboard-v2`, `dispatch-v2`, `customers-v2`, `estimates-v2`, `comms-v2`, `mobile-shell-v2`, `admin-shell-v2`) are no longer read by the client; stale rows in `user_feature_flags` are inert.

Full per-PR detail (endpoints touched, subcomponents shipped, alert-fg rules per page): `docs/design/DECISIONS.md`.

## Design System Quick Reference

**Legacy / V1 / Tier 2** — use inline styles + the `D` dark palette:
```js
const D = {
  bg: '#0f1923', card: '#1e293b', border: '#334155',
  teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b',
  red: '#ef4444', purple: '#a855f7',
  text: '#e2e8f0', muted: '#94a3b8', white: '#fff'
};
```
Fonts: DM Sans (body), JetBrains Mono (numbers/code), Montserrat (tech portal headings).

**Tier 1 V2** — `import { Button, Badge, Card, ... } from 'components/ui'`. 13 primitives in `client/src/components/ui/`. Tailwind tokens live in `client/tailwind.config.js` (zinc ramp, alert red, type scale 11–28, `border-hairline`, letterSpacing `label`/`tight`/`display`). `darkMode: false`; `fontWeight` restricted to 400/500 — do not add weight 600/700. Reference page at `/admin/_design-system` (dev-gated; excluded from robots.txt).

Both systems: 14px minimum for readable text (Virginia uses this 8 hours a day). Never apply the customer-facing brand styling (Luckiest Guy / Baloo 2 / gold pill / mascot) inside `/admin/*` — admin stays monochrome.

---

# Intelligence Bar System

Natural-language AI command center embedded across admin + tech portals. Replaces rigid UI elements (buttons, tabs, static panels) with conversational queries powered by Claude.

## Architecture

```
⌘K (any admin page) or embedded bar
    ↓
POST /api/admin/intelligence-bar/query
    ↓
context param loads: base tools (admin only) + context tools
                   + context system prompt + pageData (live UI state)
    ↓
Claude (FLAGSHIP default; env-overridable via INTELLIGENCE_BAR_MODEL
        and INTELLIGENCE_BAR_TECH_MODEL) → up to 8 tool-use rounds
```

One Express route serves everything: `server/routes/admin-intelligence-bar.js`. Tool modules live in `server/services/intelligence-bar/{context}-tools.js`, one file per context. The `context` parameter drives which tools load and which system-prompt extension applies — no page-specific endpoints.

## Context → Tools Mapping

| Context | Route(s) | Extra tool module |
|---|---|---|
| `customers` | `/admin/customers`, `/admin/health` | — (base only) |
| `leads` | `/admin/leads` | `leads-tools` |
| `schedule` / `dispatch` | `/admin/schedule`, `/admin/dispatch` | `schedule-tools` |
| `dashboard` | `/admin/dashboard`, `/admin` | `dashboard-tools` |
| `seo` / `blog` | `/admin/seo`, `/admin/ppc`, `/admin/social-media` | `seo-tools` |
| `procurement` | `/admin/inventory` | `procurement-tools` |
| `revenue` | `/admin/revenue`, `/admin/invoices` | `revenue-tools` |
| `reviews` | `/admin/reviews`, `/admin/referrals` | `review-tools` |
| `comms` | `/admin/communications` | `comms-tools` |
| `tax` | `/admin/tax` | `tax-tools` |
| `banking` | (via IB) | `banking-tools` |
| `email` | (via IB) | `email-tools` |
| `estimate` | `/admin/estimates` | `estimate-tools` |
| `tech` | `/tech/*` | `tech-tools` ONLY — no base tools, read-only, max_tokens 1024 |

All admin contexts get base tools from `tools.js` (customers / revenue / scheduling / SMS). Tech portal is isolated — no base tools, strictly read-only, lower max_tokens for field speed.

## Key Design Decisions

- **One route, many contexts.** No page-specific API endpoints.
- **Base tools always loaded on admin contexts.** Any admin page can answer "how many active customers?" even if it's the SEO page.
- **Tech portal is isolated.** Only `tech-tools` loads. All read-only. Field-speed max_tokens.
- **Write operations require confirmation.** Claude drafts the action, shows it, waits for "do it"/"send it" before executing.
- **`SEOIntelligenceBar` is the generic reusable wrapper.** Pass a `context` prop. Only build a custom wrapper if you need to inject page-specific React state as `pageData`.
- **Some tools spawn their own Claude calls.** `run_price_lookup`, `draft_sms_reply` — they call Claude internally for content generation.

## Adding a new tool module

See `server/services/intelligence-bar/README.md` for the full template + 6-line route-wiring checklist.

---

# Other Systems (Quick Reference)

**Managed Agents (6)** — Anthropic Claude Managed Agents API. Configs in `server/services/agents/`. Blog Content Engine, Backlink Strategy, Customer Assistant, Lead Response, Customer Retention, Weekly BI Briefing.

**Spoke Fleet — 15 Astro sites on Cloudflare Pages/Workers** — hub-and-spoke SEO network across SWFL markets (Bradenton, Parrish, Palmetto, Sarasota, Venice, North Port). Multi-domain GSC integration, multi-site publishing, DataForSEO rank tracking, 157-post blog calendar. **NOT WordPress. NOT Elementor. NOT RankMath.** Do not reintroduce any of them.

**Pricing Engine** — $35/hr loaded labor. Interpolated bracket pricing. Services: pest control, lawn care (grass tracks A/B/C1/C2/D), tree & shrub, mosquito (WaveGuard tiers Bronze/Silver/Gold/Platinum with tiered discounts), termite, rodent, WDO, specialty.

**Stripe** — Payment Element (card/Apple Pay/Google Pay/ACH). All customer/billing data in PostgreSQL; Stripe is processor only, not a system of record.

**Twilio** — SMS (appointment reminders with Lookup landline detection, post-service automation, review requests 90–180min delay, manual messaging). Voice forwarding with call recording + transcription (no AI voice agent). Multiple numbers across 4 GBP locations + tracking numbers.

## Environment Variables (Railway)

Core: `DATABASE_URL`, `ANTHROPIC_API_KEY`, `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`, `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`, `JWT_SECRET`.

Optional model overrides: `MODEL_FLAGSHIP` / `MODEL_WORKHORSE` / `MODEL_FAST` (global), `INTELLIGENCE_BAR_MODEL` / `INTELLIGENCE_BAR_TECH_MODEL` (IB-specific).
