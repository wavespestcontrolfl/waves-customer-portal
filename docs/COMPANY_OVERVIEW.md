# Waves Pest Control & Lawn Care — Company Overview

Canonical reference for who Waves is, what we sell, who we serve, how we operate, and what powers the business.

_Last compiled: 2026-04-20. Source: CLAUDE.md, docs/, .claude/, server/, client/ across the waves-customer-portal monorepo._

---

## 1. Company Identity

- **Legal name:** Waves Pest Control & Lawn Care
- **Structure:** Family-owned, owner-operated
- **Market:** Southwest Florida — Manatee, Sarasota, and Charlotte counties
- **Primary domain:** wavespestcontrol.com
- **Business model:** Recurring-revenue home services anchored by the WaveGuard membership program

### Service Cities (tracked via Twilio numbers and GBP presence)

| City | Primary Number |
|---|---|
| Lakewood Ranch (HQ) | (941) 318-7612 |
| Bradenton | (941) 318-7612 / (941) 297-2817 |
| Parrish | (941) 297-2817 / (941) 253-5279 |
| Palmetto | (941) 213-5203 / (941) 294-3355 |
| Sarasota | (941) 297-2606 / (941) 297-2671 |
| Venice | (941) 297-3337 / (941) 299-8937 |
| North Port | (941) 240-2066 |
| Port Charlotte | (941) 258-9109 |

### Google Business Profile Locations (4)

1. Lakewood Ranch (HQ — Pest)
2. Sarasota (Pest)
3. Venice (Pest)
4. Port Charlotte (Pest)

---

## 2. People

| Role | Person | What they do |
|---|---|---|
| Owner / Operator | **Waves** | Strategy, sales, field work, tech/portal/SEO decisions. Primary admin user. |
| Office Manager / CSR | **Virginia** | Scheduling, customer communication, lead triage. Primary daily user of CommunicationsPage and LeadsPage. |
| Lead Field Technician | **Adam** | Route execution, service delivery, protocol calibration. Primary tech portal user. |
| Field Technician | **Jose Alvarado** | Service delivery across routes. |
| Field Technician | **Jacob Heaton** | Service delivery across routes. |

**Marketing headcount: zero.** All SEO, content, blog, and digital work is operator-driven (Waves personally) with AI assistance.

---

## 3. Services

### Pest Control — recurring
- Semiannual (2 visits/yr), Quarterly (4), Bi-Monthly (6), Monthly (12)
- Initial cleanout as entry service

### Pest Control — one-time / specialty
- Rodent trapping, exclusion, sanitation
- Mud dauber / bee / wasp / yellow jacket removal
- Fire ants, fleas & ticks
- German roach, bed bug
- Wildlife trapping
- Commercial contracts (HOA, office, restaurant, retail)

### Mosquito Control
- Monthly recurring program
- One-time event treatment
- Covered under WaveGuard tier structure

### Termite
- Termite bonds (1-yr, 5-yr, 10-yr; quarterly billing)
- Monitoring, active bait stations
- Spot treatment, pretreatment, trenching, slab pre-treat
- Bora-Care attic treatment
- Foam drill (1–4 cans, $250–$500+)

### Lawn Care — 5 grass tracks (A / B / C1 / C2 / D)
- Fertilization, weed control, insect control, fungicide, aeration
- Grass-track assignment drives protocol and product selection

### Tree & Shrub
- 6-week program (9 visits/yr)
- Bi-monthly program (6 visits/yr)
- Palm treatment add-on

### WDO (Wood-Destroying Organism) Inspections
- Florida Form 13645 compliance
- One-time service, $125–$175 typical
- Real-estate referral pipeline

---

## 4. WaveGuard Membership

Four-tier recurring program. Tier is the primary customer attribute driving pricing, discounts, and priority.

| Tier | Auto-discount | Typical monthly | Positioning |
|---|---|---|---|
| Bronze | 0% | ~$55–65 | General pest baseline |
| Silver | 10% | ~$60–75 | Pest + lawn + add-ons |
| Gold | 15% | ~$70–90 | All services + priority |
| Platinum | 20% | $150–250+ | Premium full suite + priority |

### Stackable discounts (with tier)
Military (5%), Multi-Home (10%), Senior 65+ (5%), Prepayment (5%), Referral ($50 fixed), WaveGuard-Member WDO (100% on WDO only), Custom % / Custom $.

### Non-stackable (compete within group)
Family & Friends (15%), New Customer Special ($149.99 one-time).

### Pricing engine rules
- $35/hr loaded labor rate
- 55% target margin (divisor 0.45)
- Interpolated bracket pricing (property size × service complexity)
- Termite minimums: $250 spot treatment floor; foam drill tiered by can count

---

## 5. Technology Platform

### Three interfaces, one codebase

| Interface | Path | Audience |
|---|---|---|
| Customer Portal (PWA) | `/` | Customers — service history, payments, booking, referrals |
| Admin Portal | `/admin/*` | Waves + Virginia — full business management |
| Tech Portal | `/tech/*` | Adam + Jose + Jacob — route, protocols, estimating |

### Stack
- **Frontend:** React 18 + Vite. Dual style system — legacy inline `D` palette for V1/Tier 2; Tailwind + `components/ui` for Tier 1 V2.
- **Backend:** Express + Node.js, Knex.js
- **Database:** PostgreSQL on Railway
- **Payments:** Stripe Payment Element (card / Apple Pay / Google Pay / ACH) + Stripe Terminal (Tap to Pay on iPhone, branded "WavesPay"). Square fully phased out.
- **SMS/Voice:** Twilio Programmable Messaging, ConversationRelay, Lookup (landline detection)
- **Storage:** AWS S3 (`waves-pest-control-photos`, prefix `service-photos/`)
- **AI:** Anthropic Claude via `server/config/models.js` — tiers `FLAGSHIP` / `WORKHORSE` / `FAST`, all currently `claude-opus-4-7`, env-overridable with no code change

### AI Systems

**Intelligence Bar** — natural-language AI command center.
- One endpoint: `POST /api/admin/intelligence-bar/query`
- Context param loads tools + system prompt extension + live `pageData`
- 14+ context-specific tool modules (customers, leads, dispatch, dashboard, seo, procurement, revenue, reviews, comms, tax, banking, email, estimate, tech)
- Tech portal is isolated: read-only, 1024 max_tokens for field speed

**Managed Agents (6)** — running on Claude Managed Agents API:
1. Blog Content Engine
2. Backlink Strategy
3. Customer Assistant
4. Lead Response
5. Customer Retention
6. Weekly BI Briefing

### Spoke Fleet — 15 Astro sites on Cloudflare Pages/Workers

Hub-and-spoke SEO network. **Not WordPress. Not Elementor. Not RankMath.**

| Vertical | Spokes |
|---|---|
| Pest Control (5) | Bradenton, Palmetto, Parrish, Sarasota, Venice |
| Lawn Care (4) | Bradenton, Parrish, Sarasota, Venice |
| Exterminator (4) | Bradenton, Palmetto, Parrish, Sarasota |

Hubs: wavespestcontrol.com (pest authority), waveslawncare.com (lawn).

Each spoke has independent Search Console property, multi-domain GSC integration, and publishes to a 157-post blog calendar managed by the Blog Content Engine.

### Deployment
- Portal: Railway (server + client + Postgres)
- Spokes: Cloudflare Pages/Workers with deploy hooks on post publish/unpublish

---

## 6. Customer-Facing Brand

_The brand palette below applies only to customer-facing surfaces (Astro spokes, customer portal). Admin (`/admin/*`) stays monochrome — see §7._

### Colors (van-wrap Pantone spec, 2026-04-17)
| Token | Hex | Use |
|---|---|---|
| Primary Blue | `#009CDE` | Van body, section bg, links |
| Navy | `#1B2C5B` | Headings on light bg |
| Gold | `#FFD700` | CTA fill (pure gold, not amber) |
| Sky | `#4DC9F6` | Hero background |
| Red | `#C8102E` | Character accents (cap, overalls), sparingly |

### Typography
- **H1/H2:** Anton (Google Fonts open license; Luckiest Guy fallback)
- **H3/H4:** Montserrat 500–700
- **Body/UI:** Inter 400–600
- **Long-form:** Source Serif 4
- **Mono:** JetBrains Mono (code only)

Deprecated: DM Sans, Baloo 2, Burbank Big Condensed.

### Voice & tone
Confident, knowledgeable, direct. Technical when it adds value, plain-spoken when it doesn't. Uses real product names (Termidor, Demand CS, Celsius WG) and real local references (FAWN stations, UF/IFAS, SWFL cities). No filler, no content-mill tone.

### Positioning (operator statement)
> The most technically knowledgeable, locally rooted pest control and lawn care operator in Southwest Florida. Not the cheapest. Not the biggest. The one that actually understands the science behind the service — and builds long-term protection instead of selling one-time band-aids.

### Hero tagline
**"Pests Gone Today. 100% Guaranteed."**

---

## 7. Admin Design System

Admin is intentionally **monochrome** and isolated from the customer brand. Never apply gold pills, Luckiest Guy, or brand-blue inside `/admin/*`.

### V1 (legacy, Tier 2) — `D` dark palette
```js
const D = {
  bg: '#0f1923', card: '#1e293b', border: '#334155',
  teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b',
  red: '#ef4444', purple: '#a855f7',
  text: '#e2e8f0', muted: '#94a3b8', white: '#fff'
};
```

### V2 (Tier 1 redesign, active initiative)
- Tailwind zinc ramp + `alert-fg` (red, reserved for real alerts)
- 13 primitives in `client/src/components/ui/`
- `border-hairline`, type scale 11–28, font weights 400/500 only
- Flag-gated per user at `/admin/_design-system/flags`

### Tier 1 V2 scope
Dashboard, Dispatch (absorbs Schedule), Customers + Detail, Estimates + `/new`, Communications. Everything else = Tier 2 token pass only. `/tech` Home, Intelligence Bar, and customer-facing surfaces are explicitly out of scope.

### Feature flags
| Flag | Gates |
|---|---|
| `dashboard-v2` | DashboardPageV2 |
| `dispatch-v2` | DispatchPageV2 |
| `customers-v2` | CustomersPageV2 + Customer360ProfileV2 |
| `estimates-v2` | EstimatesPageV2 + tool + modals |
| `comms-v2` | CommunicationsPageV2 (all 6 tabs) |
| `mobile-shell-v2` | MobileAdminShell below 768px |

Minimum readable text: 14px. Virginia uses this 8 hours a day.

---

## 8. Revenue Model

Ranked by importance:
1. **Recurring WaveGuard memberships** — pest, lawn, mosquito, termite, tree & shrub. $55–250+/mo.
2. **One-time pest treatments** — roaches, ants, rodents, stinging insects, urgent infestations.
3. **WDO inspections** — $125–175, real-estate referral pipeline.
4. **Termite treatments** — $800–2,500+ (structural, pre-slab, Bora-Care).
5. **Specialty / commercial** — HOA, office, restaurant, retail.

### Customer LTV
- Recurring pest: ~$660–900/yr
- Lawn care add-on: ~$780–1,440/yr
- Platinum bundle: $1,800–3,000+/yr
- Full household (pest + lawn): $1,500–4,000+/yr potential

### Payment preferences
ACH is preferred (3% price increase + ACH discount to encourage bank transfer). All billing data in PostgreSQL — Stripe is processor only, never a system of record.

### Capacity constraint
Business is rate-limited by team size (5 people). Every hour on marketing is an hour out of the field. This is why the AI platform exists.

---

## 9. Marketing & SEO

### Hub-and-spoke network (15 domains)
- 2 hubs accumulate authority; 13 spokes rank for "[city] [service]" and route leads to hub
- Multi-domain GSC, multi-site publishing, DataForSEO rank tracking
- 157-post blog calendar authored by operator + Claude, reviewed two-track (technical + editorial) before publish

### Keyword tiers
- **Highest commercial intent:** pest control / exterminator / lawn care / termite treatment / mosquito control + [Bradenton, Sarasota, Venice, Port Charlotte, Lakewood Ranch, North Port, Parrish] FL
- **High intent, lower volume:** WDO inspection [city], rodent control [city], ant/cockroach [city], lawn fertilization [city], tree spraying [city]
- **Topical authority:** chinch bug treatment on St. Augustine, palmetto bug vs. cockroach, pre-emergent timing Florida, large patch fungus, Formosan termite signs

### Local SEO levers
- GBP optimization across 4 locations
- Sentiment-aware review routing (7+ → nearest GBP; 6- → internal feedback)
- Post-service Twilio review requests (90–180min delay)
- Playwright-based digital PR / local backlink agent
- 24 tracked Twilio numbers across domains and placements

---

## 10. Operations & Compliance

### Editorial policy (two-track review)
- **Technical track:** FDACS-licensed reviewer verifies pest ID, pesticide use, application rates, safety. Sources: UF/IFAS, FDACS, field observation.
- **Editorial track:** Fact-checker verifies pricing (against live engine), service areas (against active license), dates, neighborhoods.
- **Correction policy:** Small corrections bump the "updated" date silently. Material corrections carry a visible "Corrected on YYYY-MM-DD" note.
- **Cadence:** Monthly seasonal, quarterly pricing/time-sensitive, annual evergreen, reader-triggered on "not helpful" votes.

### Regulatory
- FDACS Florida Structural Pest Control licensing for all field techs
- Florida Administrative Code 5E-14 (application rates, PPE, posting)
- Florida Form 13645 (WDO inspections)

### Data handling
- Stripe = processor only, not SOR. No local card storage.
- Square = fully phased out. Do not reference in new code.
- Twilio message logs persisted to `messages` table for Customer 360 thread reconstruction.
- Auth: phone OTP primary; email + password optional. JWT 7-day default.

---

## 11. Active Initiatives (as of 2026-04-20)

- **Tier 1 admin UI redesign** — V2 pages flag-gated behind per-user flags. Visual-refresh PRs are strict 1:1 on data, endpoints, metrics, and behavior. V1 components stay exported for flag-off users.
- **Pricing engine retirement (Session 11a/11b)** — Deleting v2 monolith (~1,447 lines), porting remaining v2-only paths to modular v1 engine. 11a = backend + validation window; 11b = frontend client cleanup.
- **Lawn-care spoke rebuild** — Dedicated lawn content for bradentonfllawncare.com, parrishfllawncare.com, sarasotafllawncare.com, venicelawncare.com (currently cloned pest content). Target: 35–40 lawn-specific pages per domain.

---

## 12. Source Index

| Topic | File |
|---|---|
| Architecture, team, rules | `CLAUDE.md` |
| Brand palette, typography, components | `docs/STYLE_GUIDE.md` |
| Pricing engine retirement plan | `docs/SESSION-11A-CANONICAL.md` |
| Service keys, billing types, brackets | `docs/SERVICE_LIBRARY_MAPPING.md` |
| Discount keys, stacking rules | `docs/DISCOUNT_LIBRARY_MAPPING.md` |
| Termite pricing (v4.3 audit-verified) | `docs/TERMITE-PRICING.md` |
| Two-track review, corrections | `docs/editorial-policy-v2.md` |
| Architecture decisions log (append-only) | `docs/design/DECISIONS.md` |
| Market positioning, keyword strategy | `.claude/seo-operator-prompt.md` |
| Phone number directory | `.claude/twilio-numbers.md` |
| Spoke network spec | `server/data/wordpress-specs/15-site-network-spec.md` |
| Intelligence Bar template | `server/services/intelligence-bar/README.md` |
| Model tier registry | `server/config/models.js` |
