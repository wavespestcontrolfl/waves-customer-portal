# CLAUDE.md — Waves Customer Portal

This file provides context for Claude Code sessions working on the waves-customer-portal monorepo.

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
- **Deployment:** Railway (server + client + PostgreSQL)
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

All admin pages use inline styles with this color palette:
```js
const D = {
  bg: '#0f1923', card: '#1e293b', border: '#334155',
  teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b',
  red: '#ef4444', purple: '#a855f7',
  text: '#e2e8f0', muted: '#94a3b8', white: '#fff'
};
```
Fonts: `'DM Sans', sans-serif` (body), `'JetBrains Mono', monospace` (numbers/code), `'Montserrat', sans-serif` (headings in tech portal).

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

## WordPress Fleet (15 sites)
Hub-and-spoke SEO network. Pest control, exterminator, lawn care verticals across SWFL markets. Fleet monitoring, multi-domain GSC integration, multi-site publishing. DataForSEO rank tracking. Blog content engine with 157-post calendar.

## Pricing Engine
Loaded labor rate: $35/hr. Interpolated bracket pricing. Service types: pest control, lawn care (5 grass tracks: A/B/C1/C2/D), tree & shrub, mosquito (WaveGuard tiers), termite, rodent, WDO, specialty. WaveGuard loyalty tiers: Bronze/Silver/Gold/Platinum with tiered discounts.

## Stripe Integration
Payment Element (card/Apple Pay/Google Pay/ACH). All customer/billing data in PostgreSQL. Stripe is the payment processor only — no Stripe customer records used for business logic.

## Twilio Integration
SMS: appointment reminders (Lookup for landline detection), post-service automation, review requests (90-180 min delay), manual messaging. Voice: ConversationRelay + Claude + ElevenLabs/Deepgram. Multiple phone numbers across 4 GBP locations + tracking numbers.
