# CLAUDE.md — Waves Customer Portal

Context for Claude Code sessions working on the waves-customer-portal monorepo.

## Dev Workflow

- Start `npm run dev` in background on session start
- Monitor build output; fix errors immediately before continuing other work

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
- **AI:** Anthropic Claude API + cross-provider routing (OpenAI/Gemini). Two ambient rules, both enforced by `npm run check:domain-rules`: (1) **Never hardcode model IDs** — import a quality tier (`DEEP` / `FLAGSHIP` / `WORKHORSE` / `FAST` / `VOICE` / `VISION`) from `server/config/models.js`; cross-provider features go through the `ROUTES` map + `server/services/llm/call.js` and keep an automatic fallback to Claude. (2) **Every DEEP call site MUST go through `server/services/llm/deep.js` (`createDeepMessage`)** — fable-5 thinking-block stripping + refusal fallback live there; DEEP sites need `max_tokens` ≥4096. Generated text uses the two-provider `TEXT_POLICIES` map + `dispatchWithFallback` (same module) — every policy crosses providers (reports: GPT-5.6 Sol → Claude Opus, with a deterministic safe-copy last resort); never run both providers in parallel in production. Everything else — tier semantics and resolution, which features are live on GPT-5.5 / Gemini 3.5 Flash, fallback rules, env overrides, the call-recording and managed-agents exceptions — lives in the **`waves-llm` skill**: use it when adding or modifying any LLM call site.
- **Deployment:** Railway (portal server + client + PostgreSQL). Spoke fleet (15 sites) = Astro on Cloudflare Pages/Workers.

## Key Team Members

- **Adam Benetti** — Owner-operator: primary admin user AND the only field technician (uses both admin and Tech portals). Fleet-style multi-tech metrics are legacy.
- **Virginia** — Office manager/CSR; uses CommunicationsPage and LeadsPage daily

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
10. **Plan first for non-trivial work.** For anything beyond a small, well-specified change, present a plan and get sign-off before writing code (use Plan mode). A misunderstanding caught at the plan stage costs minutes; caught after the code is written, it costs the rework.
11. **When a mistake is caught, record the rule.** Run `/lesson` (or follow `.claude/commands/lesson.md`) so the correction lands in AGENTS.md, the matching skill, or here — in the same PR as the fix. Rules belong in skills or AGENTS.md by default; this file stays lean.

## Admin UI & Design Systems

**Dual style system:** Tier 1 V2 admin pages use `components/ui` primitives + Tailwind zinc ramp; legacy/Tier 2 pages use inline styles + the `D` dark palette. Match what the file you're editing already uses; never mix them in one component (rule 4). Ambient hard lines: `alert-fg` red is for genuine alerts only (Customers V2 status indicators are the one sanctioned exception); 14px minimum readable text; never apply customer-facing brand styling inside `/admin/*` — admin stays monochrome; visual-refresh PRs are strict 1:1 on data and behavior.

Everything else — which pages are V2 and their routes, the retained V1 shared-export modules (do NOT delete or resurrect them), palettes/tokens/fonts, the Customers-colored-indicators spec, the feature-flag system — lives in the **`waves-design` skill**: use it for ANY UI work on any portal surface. Authoritative specs: `docs/design/waves-portal-ui-redesign-spec.md` (admin), `docs/design/waves-customer-facing-design-brief.md` (customer), `docs/design/DECISIONS.md` (append-only log).

# Intelligence Bar System

Natural-language AI command center embedded across admin + tech portals — one Express route (`server/routes/admin-intelligence-bar.js`), many contexts; tool modules in `server/services/intelligence-bar/{context}-tools.js` export `TOOLS` + `executeTool` (see rule 7). Three ambient rules:

1. **Write tools go through the UI-confirm trust boundary** (`write-gates.js` + its mirror contract test) — use the **`ib-write-tools` skill** for any tool that creates, updates, sends, or schedules.
2. **Every tool must pass the contract gate** (`npm run test:contracts` — schema, DB columns incl. raw SQL, execute smoke, response shape; runs in CI, warnings block). Write tools flag `sideEffects`, Claude-spawning tools flag `sonnetBacked`, UUID params declare `format: 'uuid'`.
3. **Tech portal is isolated** — `tech-tools` only, read-only, low max_tokens.

Everything else — architecture, the context→tools mapping, design decisions, the add-a-tool checklist — lives in the **`waves-ib` skill**: use it when adding or modifying any IB tool, context, or wrapper.

---

# Other Systems (Quick Reference)

**Managed Agents (5)** — Anthropic Claude Managed Agents API. Configs are the `*-agent-config.js` files in `server/services/`. Blog Content Engine, Backlink Strategy, Customer Assistant, Lead Response, Weekly BI Briefing. (Customer Retention was removed 2026-07-08 — owner directive: no automated churn outreach to customers; retention drafts remain owner-approved via /admin customer-intel.)

**Spoke Fleet — 15 Astro sites on Cloudflare Pages/Workers** — hub-and-spoke SEO network across SWFL markets (Bradenton, Parrish, Palmetto, Sarasota, Venice, North Port). Multi-domain GSC integration, multi-site publishing, DataForSEO rank tracking, 157-post blog calendar. **NOT WordPress. NOT Elementor. NOT RankMath.** Do not reintroduce any of them.

**Pricing Engine** — $35/hr loaded labor. Interpolated bracket pricing. Services: pest control, lawn care (grass tracks A/B/C1/C2/D), tree & shrub, mosquito (WaveGuard tiers Bronze/Silver/Gold/Platinum with tiered discounts), termite, rodent, WDO, specialty.

**Stripe** — Payment Element (card/Apple Pay/Google Pay/ACH). All customer/billing data in PostgreSQL; Stripe is processor only, not a system of record.

**Twilio** — SMS (appointment reminders with Lookup landline detection, post-service automation, review requests 90–180min delay, manual messaging). Voice forwarding with call recording + transcription (no AI voice agent). Multiple numbers across 4 GBP locations + tracking numbers.

**Operator/agent tooling** — recurring prod-ops scripts (token pulls, Railway var hygiene, audit purges) live in `ops/agents/`; check its README before writing a new scratchpad script for prod access. Mutating scripts there are dry-run by default (`--execute` to write).

## Environment Variables (Railway)

Core: `DATABASE_URL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`, `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`, `JWT_SECRET`.

Optional model overrides: `MODEL_DEEP` / `MODEL_EXTREME` / `MODEL_FLAGSHIP` / `MODEL_WORKHORSE` / `MODEL_FAST` / `MODEL_VOICE` / `MODEL_VISION` (global), `INTELLIGENCE_BAR_MODEL` / `INTELLIGENCE_BAR_TECH_MODEL` (IB-specific). Fable is never automatic; opt in explicitly through `MODEL_EXTREME` or a deliberate feature route.

Cross-provider routing: `MODEL_OPENAI_REPORT_WRITER` (Sol), `MODEL_OPENAI_BALANCED` (Terra), `MODEL_OPENAI_FAST` (Luna), plus legacy `MODEL_OPENAI_BEST` as a Terra-compatible override. Knowledge embeddings: `MODEL_OPENAI_EMBEDDING` (default `text-embedding-3-small`, 1536-dim) behind `GATE_HYBRID_KNOWLEDGE` — single-provider BY DESIGN (embedding spaces don't cross providers; unavailable → search degrades to full-text), and changing the model requires re-embedding the corpus. Completed-service reports are Sol-first, Opus-second, and return deterministic safe copy if both miss. Generated text must use a two-provider `TEXT_POLICIES` entry; a same-provider fallback is rejected by the dispatcher. No permanent shadow/parallel model calls. Gemini vision/image/video and call transcription/extraction keep their specialized provider ladders.
