# Lawn Diagnostic — implementation plan

**Status:** Planning (approved 2026-05-28). Not yet built.
**Owner:** Adam.

## What this is

An **internal field tool for techs to diagnose lawn issues, and to send polished lawn
reports to *potential* clients** to win business.

It is a **standalone prospecting + diagnostic product**. It is **NOT** part of the
existing-customer lawn assessment system (`lawn_assessments` and friends), and the two
**never touch**. Naming is deliberately distinct:

- **Lawn Assessment** (existing) — customer-keyed, tracks baseline/history over time,
  feeds analytics (`product_efficacy`, `protocol_performance`, `neighborhood_benchmarks`,
  completion tracking), auto-writes snapshots + recommendation cards on `/confirm`.
- **Lawn Diagnostic** (this) — standalone, no customer required, no baseline, no history,
  never reaches any analytics table.

### Two modes
- **Internal** — tech snaps photos at any yard, gets AI diagnosis for their own eyes. No
  contact, no send.
- **Prospect-report** — tech sends a polished lawn report to a potential client.

## Why a separate table (decision)

Rejected "extend `lawn_assessments` with nullable `customer_id`." Grounded reasons from the
audit of the current repo:

- `lawn_assessments.customer_id` is `NOT NULL CASCADE`
  (`server/models/migrations/20260401000072_lawn_assessments.js:13`) — as are
  `lawn_assessment_photos.customer_id` and `property_health_snapshots.customer_id`.
  "Extend" means dropping NOT NULL on three tables.
- `lawn_assessments` is a shared **analytics fact table**. `assessment-analytics.js`
  (lines 379, 515), `product_efficacy`, `protocol_performance`, `neighborhood_benchmarks`,
  and `assessment_completion_tracking` all aggregate every row assuming it's a real
  customer assessment. Injecting prospect/spot-check rows silently corrupts those metrics
  unless a filter is patched into every consumer.
- Baseline is **auto-assigned on insert** (`server/routes/admin-lawn-assessment.js:613`:
  first row for a customer → `is_baseline = true`). Incompatible with standalone records.

Reuse doesn't require sharing the table: the AI engine, S3 upload, PDF renderer, and
report-token rails are all service-layer functions that don't care which table the row
lives in. Separate table = clean isolation, zero analytics blast radius, no baseline
interaction by construction.

## Data model

### `lawn_diagnostics` (new, independent of `lawn_assessments`)
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `mode` | enum | `internal` / `prospect` |
| `status` | enum | `draft` / `analyzed` / `sent` / `archived` |
| `lead_id` | uuid null FK→leads | optional, set on "save as lead" |
| `contact_snapshot` | jsonb null | name / email / phone for prospect sends |
| `address_snapshot` | jsonb null | address / GPS |
| `created_by_user_id` | uuid | technician |
| `ai_analysis` | jsonb | reuse `analyzePhoto()` output shape |
| `ai_confidence` | numeric null | net-new: inter-model agreement score |
| `overall_score` | integer null | |
| `ai_summary` | text null | customer-safe one-liner |
| `report_token` | char(32) null unique | minted only on send |
| `report_expires_at` | timestamp null | |
| `last_sent_at` | timestamp null | |
| `created_at` / `updated_at` / `archived_at` | timestamp | |

No `customer_id`, no baseline fields, no `tenant_id` (no multi-tenancy exists),
no `property_id` (no properties table — address lives on the customer row).

### `lawn_diagnostic_photos` (new)
Mirror of `lawn_assessment_photos`, FK→`lawn_diagnostics`. Same S3 key / quality-gate /
per-photo AI score columns.

## Reuse (service-layer, no rebuild)
- `server/services/lawn-assessment.js` → `analyzePhoto()` vision engine (Claude + Gemini).
- `server/services/photos.js` → `PhotoService.uploadBase64()` / `getViewUrl()` (S3 + signed URLs).
- Tokenized public-page pattern from estimates (`EstimateViewPage` + `estimate-public.js`) — web page, NOT PDF (no render-to-PDF exists in the repo).
- Public report token + `express-rate-limit` + expiry pattern from `server/routes/reports-public.js` / `estimate-public.js`.

**Not reused (existing-customer machinery, stays untouched):** `lawn-snapshot.js`,
`lawn-recommendation-engine.js`, baseline logic, `lawn_baseline_resets`, the
`server/routes/lawn-health.js` customer endpoints.

## Lifecycle
1. Tech starts a diagnostic → photos → AI diagnosis (their eyes only). Done, if internal.
2. To send: capture prospect name + email/address → mint `report_token` → tokenized public
   report web page (`/lawn-report/:token`). **Hard gate: no token minted without contact info.**
3. Optional one-tap "save as lead" → writes to the existing `leads` table (rich:
   name/phone/address/`extracted_data`/`customer_id`-null-until-converted) so it lands in
   the pipeline. Optional, never forced — a quick diagnosis shouldn't auto-spam the CRM.

## API (new)
All under tech auth (`requireTechOrAdmin`):
- `POST /api/tech/lawn-diagnostic/analyze` — analyze-only, no persistence (internal feedback).
- `POST /api/tech/lawn-diagnostic` — create/persist a draft.
- `POST /api/tech/lawn-diagnostic/:id/send` — capture contact, mint token, render report. Gate: contact required.
- `POST /api/tech/lawn-diagnostic/:id/lead` — save as lead (optional).
- Public (no-auth, by design — see Public-route policy below):
  - `GET /api/public/lawn-diagnostic/:token` — read-only tokenized report.
  - `POST /api/public/lawn-diagnostic/:token/quote-request` — request-a-quote CTA write.

## UI
New mobile-first **Lawn Diagnostic** view under `/tech/*` (dark `D` palette per CLAUDE.md —
not Tailwind, not the buried admin `LawnAssessmentPanel.jsx`). Flow:
photos → AI diagnosis → [Save internally · Send report · Save as lead · Archive].
New public report page (customer-facing warm tone, not admin monochrome).

## AI enhancement
Current engine is average + divergence flags (`divergence_flags` on >20pt Claude/Gemini
gaps), **no stored confidence**. Add `ai_confidence` from inter-model agreement; gate the
send path on it (low confidence → "review before sending"). Optional for v1.

## Hard gates (server-enforced)
1. `send` requires contact info (name + email or address) → 422 otherwise.
2. Diagnostic rows never appear in `lawn-health` endpoints or any analytics builder — free, separate table.
3. Public report payload whitelisted — no internal scores/notes leak.
4. Never writes `lawn_assessments` or any baseline/snapshot table.

## Public-route policy compliance (AGENTS.md) — REQUIRED before/at implementation
AGENTS.md maintains the canonical allowlist of public-by-token routes and treats
**any new public route outside that list as P0**. Both public endpoints above MUST be
added to that allowlist (AGENTS.md "Public-by-token routes" section) **in the
implementation PR**, each with an explicit contract. This is a planning commitment, not
optional.

### `GET /api/public/lawn-diagnostic/:token` (read) — model on `/api/public/prep/:token`
- 32-hex token format gate (`FULL_TOKEN_RE`-style) — generic 404 on any miss/expiry/mismatch.
- 60 req/min public-route rate limit.
- Privacy headers: `no-store`, `noindex`, `no-referrer`.
- Read-only; whitelisted payload (no internal scores, raw AI, product names, or tech notes).
- Honors `report_expires_at`; expired → generic 404.

### `POST /api/public/lawn-diagnostic/:token/quote-request` (write) — model on lead-webhook / newsletter-subscribe
- Same 32-hex token gate + generic 404; only valid for a `sent` diagnostic.
- Strict body validation BEFORE any coercion (reject `null`/`''`/`false`/`[]` — no silent
  `Number()`/truthy coercion), per the `/api/reports/:token/*` write rules.
- Dedicated public-route rate limiter + spam guard; double-submit protection
  (atomic conditional insert, 409 on repeat).
- No raw PII logging; only writes a lead/quote-request row — never mutates diagnostics
  scoring or any customer/assessment table.

If this allowlist + contract isn't acceptable, the fallback is to make the report
**authenticated** instead of public — but that defeats "send a link to a prospect who
isn't a customer," so public-with-contract is the intended path.

## Customer-facing report (the prospect-facing output)

**Decision: clone the estimate view, not a PDF.** Estimates are web-only tokenized pages
(`/estimate/:token`); there is NO render-to-PDF anywhere in the repo. The Lawn Diagnostic
report is a tokenized web page modeled on `client/src/pages/EstimateViewPage.jsx`.

### Reuse spine
- New public route `/lawn-report/:token`, same 32-char-hex token (`crypto.randomBytes(16)`)
  pattern as estimates.
- Reuse `EstimateViewPage`'s warm-brand shell verbatim: `theme-brand.js` palette
  (`#FAF8F3` bg, Source Serif 4 headings, navy `#1B2C5B`), `<Page>` / `<Header>` /
  `<BrandFooter>` / `<GuaranteeStrip>` / `<QuestionsEscapeHatch>`. NOT admin monochrome.
- **Satellite map embed already exists** — reuse the Static Maps URL pattern from
  `PortalPage.jsx:4260`:
  `https://maps.googleapis.com/maps/api/staticmap?center=${address}&zoom=19&size=640x280&scale=2&maptype=satellite&key=${VITE_GOOGLE_MAPS_API_KEY}`
  built from the diagnostic's `address_snapshot`. The estimate's `WaveGuardIntelligenceCard`
  (`EstimateViewPage.jsx:310-325`) already embeds `intelligence.satelliteUrl` — same mechanism.
- Fork `WaveGuardIntelligenceCard` → `LawnReportCard` (it already renders headline + body +
  metrics grid + signals grid in the warm theme; feed it lawn data).

### Report sections (plain-language, FL-specific — the net-new content layer)
Grass-type/agronomy context is NOT shown to customers anywhere today; this is the credibility builder.
1. **Hero** — property satellite aerial + "Here's what we saw at [address]".
2. **Lawn health at a glance** — the five existing metrics (Turf Density, Weed Pressure,
   Color/Health, Fungus, Thatch) translated from clinical scores to plain status
   (Healthy / Keep an eye on / Needs attention) + color dot. No raw "62/100".
3. **What we found** — findings/signals grid, each with photo thumbnail + why it matters in
   SW Florida. Specifics library: chinch bugs (St. Augustine), fungus/disease (large patch,
   dollar spot, gray leaf spot), weed type (dollarweed/sedge/crabgrass), nutrient deficiency
   (iron/nitrogen on sandy soil), drought/irrigation stress, shade thinning, grub damage,
   thatch buildup, bare/thin coverage, scalping from mow height.
4. **Your grass type & what it needs** — "Your lawn is St. Augustine, which here needs X / is
   prone to Y." Reads grass-type context.
5. **The plan to fix it** — recommended treatment + expected improvement + rough timeline
   (seasonal: peak/shoulder/dormant).
6. **CTA** — "Get my free lawn plan" → a lightweight **request-a-quote contact form**
   (name / phone / email / best time), NOT the full estimate flow. Decouples Diagnostic from
   Estimate; submission optionally creates a lead. The report sells the callback, not the price.

### Content generation — curated library, NOT AI free-write
A deep, agronomically sound SWFL copy library already exists. The AI **selects and assembles**
pre-written customer-safe snippets for what it sees in the photos; it does NOT invent agronomy.

**Canonical sources (verified — pull from these):**
- `wavespestcontrol-astro-/content-ops/facts-bank/services/lawn-care.md` (`status: verified`) —
  authoritative agronomy: chinch ID, sod webworm, dollarweed/sedge/crabgrass, result timing
  (weeds 10-14d, color 2-3wk, thickness 60-90d), turf types, salt tolerance.
- Micronutrient yellowing blog (`.../blog/sarasota-lawn-yellowing-micronutrient-deficiency.md`) —
  best customer-facing copy for color/yellowing: Fe (new growth) vs Mn (green veins) vs Mg
  (margins) vs N (uniform/older); sandy-soil + high-pH iron lockout.
- `server/services/lawn-snapshot.js` — reuse the cautious finding phrasing
  ("We saw signs consistent with …") verbatim for unconfirmed disease.

**Internal-only (powers the TECH view, never the customer report):**
- `server/models/migrations/20260401000026_service_protocols.js` — diagnostic differentials
  (chinch vs drought pull test, large patch vs TARR, weed IDs, float-test threshold ≥20/sqft).
  Contains product names + MOA rotation — strip entirely from customer output.

**Do NOT pull from (template/blocked):** facts-bank `lawn-pest-control.md`,
`lawn-fertilization.md`, `lawn-aeration.md`, `lawn-weed-control.md`.

### Compliance guardrails (hard filter on customer report copy)
- NO product/brand names or rates (Talstar/Arena/Celsius/Sedgehammer/Prodiamine/oz-per-1000).
  Facts-bank: "Do not make specific product brand promises in copy."
- "trained," NEVER "certified" BMP (until staff cert confirmed).
- NO "organic-only" claim (inaccurate).
- Cautious disease language only — "signs consistent with X," never a hard diagnosis.
- Phase III drought restrictions are `public_copy_allowed: false` — prompt context only.

### Resolved accuracy item — blackout county scope
**RESOLVED (2026-05-28, verified vs. charlottecountyfl.gov):** Charlotte County HAS a
June 1–Sept 30 fertilizer blackout (since 2008), banning both N AND P, 50% slow-release N
outside the window — same as Sarasota + Manatee. All three Waves service counties run the
identical blackout.
- `facts-bank/lawn-care.md` (Sarasota + Manatee + Charlotte) is CORRECT.
- `scripts/seed-knowledge-base.js` was WRONG (said Sarasota + Manatee only). **Fixed in
  PR #1329** (adds Charlotte). It has blast radius beyond this report (recommendation engine /
  intelligence bar read the KB); the live KB row must be re-seeded for the fix to take effect.
- Report can state the blackout confidently service-wide; still key exact phrasing off the
  prospect's county. Charlotte adds the Charlotte Harbor / red-tide "why" — good local credibility.
- Geo: North Port = Sarasota County; Port Charlotte = Charlotte County. All prospects covered.

## Phasing
- **v1:** capture → AI diagnosis → generate tokenized `/lawn-report/:token` web page
  (estimate-styled, satellite hero, plain-language findings, grass-type context, fix-it plan,
  CTA). Share link manually. Optional lead capture. **No PDF** (matches estimates).
- **v1.5:** SMS/email the link via the same rails estimates use + delivery logs; AI
  confidence/adjudication layer.

## Non-goals
Existing customer lawn assessment system untouched. Projects untouched. No baselines, no
customer history, no promotion-to-baseline, no auto-customer-creation.
