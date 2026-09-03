# Waves Estimator Pricing Audit — 2026-09-02

Audit-first, read-only. No production pricing, database record, protocol, or engine code was changed. Artifacts created: this report; `docs/estimator-pricing-service-matrix.{md,csv}`; `docs/estimator-pricing-field-requirements.md`; `docs/estimator-pricing-protocol-completion-plan.md` (owner request 2026-09-02: a protocol inventory and completion plan for every service line that bills — no rates invented); `docs/estimator-pricing-audit-owner-followup-2026-09-02.md` (owner review: labor-actuals correction, termite bait / lawn / tree & shrub deep-dive, palm and bed-area definitions, one-time multiplier consistency); `scripts/audit-estimator-pricing.js` (independent calculator + scenario matrix); `scripts/audit-pricing-data-quality.js` (read-only data audit); `server/tests/pricing-audit-golden-cases.test.js` (979 golden/boundary/invariant tests (961 formula-parity + 15 frozen literal prices + 3 frozen WaveGuard tier bundles), green); evidence appendices `docs/audits/estimator-pricing-audit-2026-09-02-calculator-run.md` and `docs/audits/estimator-pricing-audit-2026-09-02-data-quality-prod.md`.

Baseline: `wavespestcontrolfl/waves-customer-portal`, `origin/main` @ `66ecc95dc` (2026-09-02), detached worktree `~/wt-pricing-audit`. Production data was read in a Postgres session opened `READ ONLY` (`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`, verified by a refused `CREATE TEMP TABLE`), aggregates and catalog/config rows only; no customer name, phone, email, or address was selected or is reproduced here. The prior independent validation (`docs/audits/estimator-pricing-engine-audit-validation-2026-09-01.md`, engine + billing scope, 7/10) is treated as an input; its findings SEC-001/SEC-002/DATA-001 were fixed by PRs #3741/#3750/#3751 (merged 2026-09-02) and are not re-raised.

Verification labels used below: **Reproduced** (engine or database output observed in this audit), **Static** (traced in code at the cited lines), **Data** (production aggregate), **Hypothesis** (not proven; the test or query needed is named), **Ruling** (an owner decision, not a defect).

---

## 1. Executive summary

**Overall score: 5.5 / 10.** The pricing formulas are correct and reproducible — an independent calculator rebuilt every core price from the constants and the documented formulas and matched the engine on 1,246 of the 1,247 independently compared scenarios (a further 41 engine-only observations carry no expected value and are listed separately in the appendix), including every bracket boundary, cadence identity, discount stack and tier count; the one mismatch is not a price but a prepay coverage cadence (CAD-002: a 9-visit tree & shrub plan resolves to `bimonthly`, six covered visits). The weakness is everything *behind* the price: the labor minutes are assumed and cannot yet be validated (recorded check-out times include drive time, per the owner's 2026-09-02 review, so the production minutes are not on-site time); material costs are literals copied from invoices months ago and, for one product, 2.1× the live catalog price; no protocol, inventory row, or equipment calibration feeds a price except pre-slab termiticide; the reported margins are therefore optimistic, and the lawn program is below its own 35% floor at list price before any discount. Operationally, completed billable visits since June are leaving uninvoiced with only a log line as the signal (the audit's first count was ~18; the Billing Recovery workbench, whose predicate the audit script now mirrors, is the authoritative number).

Ten most important findings (full register in §13):

| # | ID | Sev | Finding | Evidence |
|---|---|---|---|---|
| 1 | MON-004 (was LAB-001) | P2 | **Withdrawn as a labor finding on owner review 2026-09-02**: recorded check-out times include drive time, so the production "on-site" minutes (pest median 44 vs 25 modeled) are not a valid comparison. The residual finding is that on-site time is not captured separately, so no labor assumption can be validated from production data. See the follow-up addendum §0. | Data (measurement invalid) |
| 2 | LAB-002 | P1 | Lawn 9x at the 4,500 sf reference lists at 30.7% margin by the engine's own cost model (below the 35% floor, `marginFloorOk=false`); Platinum takes it to 13.3%. The observed-labor variant of this claim is withdrawn with MON-004. | Reproduced |
| 3 | BIL-001 | P1 | Completed billable visits since 2026-06-01 with no invoice: the audit's first pass counted 18 within ±3 days (est. $1,333) under a looser predicate than the Billing Recovery workbench's (`admin-billing-recovery.js uninvoicedLeakQuery`: effective price, dispositions, record callbacks, always-free types, payer, autopay). The script now mirrors that predicate but has not been re-run against production, so the workbench figure supersedes the 18. The only completion-time signal is `logger.warn` in `admin-dispatch.js:9301`. 128 of 182 per-application customers have no `per_application_fee` (pre-exclusion of internal test accounts; regenerate on the next run). | Data + Static |
| 4 | INP-001 | P1 | Palms entered in the admin builder never reach the tree & shrub price: the translator sends `profile.palmCount` (property level) and the pricer only folds *service-line* palms into the per-tree terms. 30 palms: $53.08/mo (admin) vs $95.17/mo (website form, same property). | Reproduced |
| 5 | MAT-001 | P2 | Trenching Termidor SC container cost is a $375 literal vs $174.72 in the live catalog; a 200-LF Termidor trench carries a $181 product surcharge instead of ≈$56 (+$125 over-charge). Bifen/Talstar container sizes are also wrong (96 oz vs 128 oz). | Reproduced + Data |
| 6 | INV-001 | P2 | Inventory cannot support pricing yet: 173 of 192 active products have no `cost_per_unit`, 89 no `rate_unit`, 43 not `current`, 19 labels unverified; the COGS map (`service_product_usage`, 32 rows) is keyed by display names (0 match a catalog key) and costs `packets` at $0. | Data |
| 7 | CAT-001 | P2 | Catalog sells cadences the engine cannot price: `pest_general_semiannual` reprices as quarterly (4 visits) with a warning only; `lawn_care_quarterly` (4x, retired) reprices as 9x; 15 active quote-selectable rows have no price path at all (fire ant, tick, mud dauber, wildlife, termite liquid/pretreatment, …). | Reproduced + Data |
| 8 | MAR-001 | Ruling/P1 | All margin floors are report-only (owner 2026-07-17). Platinum on the reference 4-service bundle takes lawn to 13.3%, rodent bait to 21.5%, T&S to 31.2%; a FIXED manual discount can zero an estimate. The engine flags, nothing stops the send. | Reproduced |
| 9 | CFG-001 | P2 | DB-authoritative pest floor is **$79** (`pricing_config.pest_base.floor`) while `constants.js`, POLICY.md and README say **$89**; four other doc/code drifts (mosquito prices, cadence curve, T&S 0.43, +10% water). | Data + Static |
| 10 | EQP-001 | P2 | Three equipment calibrations exist (FlowZone 1.33 gal/1,000; two 110-gal rigs at 2.0 gal/1,000), all `estimated_not_field_verified`, none verified, none read by pricing. GPM references (15 / 4.2 / 0.73) are stored but never confused with carrier volume — because nothing consumes them. | Data + Static |

Three changes that would most improve profitability and reliability (detail in §15):

1. **Replace assumed labor minutes with measured ones and expose the true margin per line** — `time_on_site_adjusted_minutes` / check-in-out already exist on 250+ completed visits; wire the medians into the cost models (report-only first), then reprice lawn and monthly pest against a real 35% floor.
2. **Make inventory the material source for every product-driven service, the way pre-slab already works** — one `costLineFromCatalog()` with a stale/missing warning that shows on the estimator and in the audit snapshot; kill the literal tables (pest chem, mosquito, trenching, Bora-Care, foam, bed bug).
3. **Fail closed on missing scope at the API boundary and close the two entry-point inconsistencies** — palms on the service line from the admin builder; blank tree count as absent; reject cadences the engine cannot price; block completion-without-invoice with a bell instead of a log line.

Owner decisions that block implementation: §16 (11 items).

---

## 2. Scope, method, and what was verified

- **Code mapped** (read-only): `server/services/pricing-engine/*` (21,232 lines), `estimator-engine/*`, `admin-estimate-persistence.js`, `estimate-converter.js`, `estimate-public.js`, `admin-estimates.js`, `property-lookup-v2.js`, `public-quote.js`, `lead-estimate-automation.js`, `customer-pricing-ai.js`, `intelligence-bar/estimate-tools.js`, `tax-calculator.js`, `invoice.js`, `stripe-pricing.js`, `billing-lane.js`, `billing-cron.js`, `job-costing.js`, `product-costing.js`, `estimate-pricing-audit.js`, `pricing-reality-check.js`, `estimate-actuals.js`, `db-bridge.js`, `protocol-*`, `waveguard-plan-engine.js`, `equipment-*`, `packages/lawn-cost-floor`, the admin builder `EstimateToolViewV2.jsx`, 80+ migrations, `docs/pricing/POLICY.md`, the engine README, `SERVICE_LIBRARY_MAPPING.md`, `TERMITE-PRICING.md`. Eight read-only mapping agents produced file:line evidence tables; every claim used in this report was re-read at the cited line before inclusion.
- **Independent calculator**: `scripts/audit-estimator-pricing.js` rebuilds pest, lawn (all four tracks, three cadences, every bracket row ±1), mosquito (treatable-area anchors, pressure, water multiplier), rodent bait (brackets + ladder), termite bait (perimeter → stations → install → bracket monitoring), one-time pest, tree & shrub (cost buildup), WDO, German roach, foam drill, top dressing, plugging, palm injection, WaveGuard tiers and discounts, cadence identities, annual-prepay base — from `constants.js` and the documented formulas, without calling any engine pricer — then diffs against `generateEstimate()`. 1,288 scenarios — 1,247 with an independent expected value (1,246 match) plus 41 engine-only observations — **0 price mismatches and 1 cadence mismatch** (CAD-002) on in-code constants; the command exits nonzero while any mismatch stands. The production overlay run (`--db`) predates the cadence assertion and the termite cartridge cost model and is owed a re-run.
- **Production data**: `scripts/audit-pricing-data-quality.js` (20 aggregate checks) and ad-hoc read-only aggregates: 92 services (77 active), 892 live estimates (100 accepted), 813 real customers (pre-exclusion of internal test accounts — the billing-lane query now applies the `INTERNAL_TEST_CUSTOMERS` predicate; regenerate on the next read-only run), 434 completed visits (252 with on-site minutes), 331 `job_costs`, 324 pricing audit snapshots, 216 products, 65 `pricing_config` rows, 3 calibrations.
- **Tests**: new `server/tests/pricing-audit-golden-cases.test.js` — 979 tests green on `origin/main`; they assert the *independent* numbers, so a future engine/formula divergence fails loudly rather than a regenerated baseline hiding it. Existing pricing suites were inventoried (§14) but not re-run beyond the new file.
- **Not done**: visual/mobile pass of the builder (input behaviour was traced in code instead); label verification against EPA/manufacturer sources (rates are reported as stored, with `label_verified_at` coverage); technician-level grouping (Adam is the only technician, so per-tech variance is moot).

---

## 3. Pricing data-flow map (customer request → invoice → actuals)

| Step | Source file / function | Route | Table · columns | Source of truth | Fallback / silent default | Provenance kept? | Stale risk |
|---|---|---|---|---|---|---|---|
| Customer request | website form → `public-quote.js:1454 generateEstimate`; lead form → `lead-webhook.js:859` → `lead-estimate-automation.js:475`; call/SMS → `estimator-engine/index.js:2272` → `draft-builder.js:1238`; admin → `EstimateToolViewV2.jsx` → `property-lookup-v2.js:4499` → `admin-estimate-persistence.js:1215`; IB → `estimate-tools.js:1539`; report click-mint → `click-estimate-mint.js:596`; restart → `restart.js:833`; one-tap → `one-tap-purchase.js:228` | `POST /api/public/quote/calculate`, `POST /api/webhooks/lead`, `POST /api/admin/estimates`, `PUT /api/admin/estimates/:id`, IB tools, `POST /api/reports/:token/events`, `POST /api/requests/restart-plan`, `POST /api/one-tap/init` | `estimates` (14 insert sites, all enumerated in §12) | `generateEstimate` is the sole dollar authority (AGENTS.md; verified — no route accepts client totals; admin saves fail *open* to `CLIENT_FALLBACK` only on engine error, and the send gate `GATE_SEND_REQUIRES_SERVER_PRICING=true` now blocks those) | public quote clamps sqft/lot/stories; admin path has no bounds; LEAD defaults 2,000/8,000 sf; IB defaults lot = 4× home | `pricing_authority`, `engineInputs`/`engineRequest`, `estimatorEngine.*` (lane, evidence, model, confidence) | live `pricing_config` at price time (60 s cache) |
| Service selection / key normalisation | `estimate-engine.js:737-1935` per-service dispatch; `v1-legacy-mapper.js` shape adapter; `service-catalog-names.js`, `slot-reservation.js:167-206` (visits → catalog name) | — | `services.service_key/engine_keys` | engine `service` key on the line; catalog identity resolved by `engine_keys` (only ~20 keys) else by **name string** | unknown cadence → quarterly (pest) / 9x (lawn) silently | line `service` + `pricingBasis` | catalog renames change name-based matches (`recurring-appointment-seeder.js:237-260` parses labels before counts) |
| Residential/commercial | `commercial-helpers.js isCommercialProperty`, `commercial-risk-type.js` | — | `estimates.category`, `customers.property_type` | explicit flag > property type > category | LEAD hardcodes `isCommercial:false` (`lead-estimate-automation.js:300`); guardrail catches only under `GATE_UNIT_SCOPE_GUARDRAILS` (on in prod) | yes | — |
| Property data | `property-lookup-v2.js` (4 county PAOs + vision), `source-arbitration.js`, `lookup-cache.js` (`property_lookups`, TTL 180 d, `verified_overrides` never expire) | `/api/admin/estimator/property-lookup*` | `property_lookups` | county > verified > vision > caller | `property-calculator.js:258-271`: impervious 20%, bed 15% of open area ⇒ lot-fallback turf ≈ lot × 0.68 (`turfConfidence: LOW`, review) | `turfBasis`, `bedAreaSource`, `storiesSource` | 180-day cache; no retrieved-at on the estimate |
| Scope extraction / inputs / validation | admin translator `translateV2CallToV1Input` (`property-lookup-v2.js:3783-4466`); public `public-quote.js:975-1102` clamps; AI `intent-schema.js` | — | `estimate_data.inputs`, `engineRequest` | — | see §9 (blank → 0, negative dropped, unknown enums defaulted) | inputs snapshot yes | — |
| Pricing formula | `service-pricing.js` per service; `estimate-engine.js` orchestration; `discount-engine.js` | — | — | `constants.js` overlaid by `pricing_config` (`db-bridge.js:854`), `lawn_pricing_brackets`, `residential_unit_pricing` | DB sync failure → in-code defaults with `console.error` only (`db-bridge.js:1988-1992`) | `pricing_version`, `pricingMetadata` arm state, per-service version tokens; **no config hash** | 60 s cache; failed sync silently serves code defaults |
| Labor | `pestVisitCostModel` (`service-pricing.js:1424-1436`), lawn cost floor (`packages/lawn-cost-floor`), T&S `:2774-2801`, commercial buildups, specialty tiers | — | — | literals + `pricing_config.global_labor_rate/global_drive_time` | none | in `costs` on the line | never recalibrated (see §5) |
| Protocol selection | `protocol-matcher.js` (name match), `protocol-reader.js` (`protocols.json`), `lawn_protocols` operating layer | admin/tech protocol routes | `lawn_protocols`, `lawn_protocol_windows`, `lawn_protocol_products`, `protocol_templates` | protocol never contributes dollars (`protocol-reader.js:4-6`) | — | not stamped on the estimate | — |
| Product quantities / inventory cost | pre-slab only: `db-bridge.js:762-811` reads `products_catalog.best_price` via approved `vendor_pricing`; everything else literal (§6) | — | `products_catalog`, `vendor_pricing` | catalog (pre-slab); literals (rest) | pre-slab fail-open to constants (silent); audit `product-costing.js:273-277` → `cost: 0` + warning string | no | catalog `best_price_updated_at`; 43 not current |
| Equipment / calibration | `equipment_calibrations.carrier_gal_per_1000` read by `waveguard-plan-engine.js:1353` (field plan) — **not by pricing** | — | `equipment_systems`, `equipment_calibrations` | field plan fails closed on unverified calibration | — | — | all 3 rows unverified |
| Direct cost / margin | per line `costs`, `margin`, `finalMargin`, `belowMarginFloor`; commercial `computed = cost / (1 − 0.45)` | — | — | engine | report-only | yes | — |
| Floors / caps | pest `$79` (DB) per-visit floor; program floors disarmed; lawn table max 20,000 sf → extrapolate + custom-quote flag; palm $75 visit minimum; specialty floors | — | `pricing_config` | DB | — | `pricingMetadata` | — |
| Discounts | `determineWaveGuardTier` (count of qualifying), `getEffectiveDiscount`, manual discount block (`estimate-engine.js:2229-2360`), one-time perk 15% | public `select-tier` (now eligibility-guarded) | `estimates.waveguard_tier`, `estimate_data.summary.manualDiscount` | engine | manual FIXED uncapped (zeroes estimate); Platinum + manual stack uncapped by design | `internalReason` (custom presets only); no user/time | — |
| Tax | `tax-calculator.js` (residential 0; commercial 7% via `tax_rates`, `service_taxability`, exemptions); converter blended prepay rate; `invoice.js:1530-1596` | — | `invoices.tax_rate/tax_amount` | TaxCalculator | `invoice.js:1595` catch hardcodes 7% (commercial only reachable); `calculateUpdateFinancials` skips exemptions | separate columns | — |
| Deposit | retired (`estimate-deposits.js:67 isDepositEnforced() → false`); ledger for 2026-06/07 rows | — | `estimate_deposits` | — | — | — | — |
| Payment fees | `stripe-pricing.js` 290 bps credit-only, at checkout (`computeChargeAmount`) | `pay-v2 /quote /finalize` | invoices, payments | single function | engine's `cardProcessingFeeRate 0.029` is an orphan | — | — |
| Annual prepay | `estimate-converter.js:2876-2918 resolveAnnualPrepayInvoiceTotal` (5% only for no-setup-fee mixes; pest/mosquito keep the $99 waiver); term rows | accept + manual accept | `annual_prepay_terms`, `customers.billing_mode='annual_prepay'` | converter | cron guards (`billing-cron.js:220-263`) | yes | expired term stays in lane (DATA-002, open) |
| Estimate record + lines | `admin-estimate-persistence.js:1498-1518`; `sendSnapshot` at send (`admin-estimates.js:548-584`) | — | `estimates.monthly_total/annual_total/onetime_total/estimate_data` | engine result | — | `estimate_pricing_audit_snapshots` at send (99/100 accepted have one) | — |
| Rendering | SSR estimate page + `EstimateViewPage.jsx` (bundle), PDF (`estimate-pdf.js` proposal-only scope block), portal, accept email | `/estimate/:token`, `/:token/pdf` | — | frozen `sendSnapshot.pricingBundle` (7 guards fall through to live) | live recompute on guard fall-through (DATA-003, open) | — | — |
| Acceptance | `estimate-public.js:9802-10484` (selected frequency/combo → `LOCKED`, `price_locked_at`), `estimate-manual-acceptance.js` (row columns only) | `PUT /api/estimates/:token/accept`, `POST /admin/estimates/:id/mark-accepted` | `estimates.pricing_authority='LOCKED'`, `pricingAuthorityAtLock` | CAS + lock | — | yes | — |
| Invoice | converter first-application invoice (`:6499-6560`), `InvoiceService.create` (tax, deposit credit, cents), scheduled mint (`scheduled-invoice-mint.js`, price-moved CAS), completion (`admin-dispatch.js:5810-5820 completionInvoiceAmount`) | — | `invoices.line_items/subtotal/tax_amount/total`, `customers.monthly_rate/per_application_fee/billing_mode` | invoice row (`invoiceAmountDue`) | per-application visit with no price and no fee completes **uninvoiced** with `logger.warn` (`admin-dispatch.js:9301`) | `activity_log` for accept/opt-out | — |
| Service completion / actuals | `scheduled_services.check_in_time/check_out_time/actual_duration_minutes/time_on_site_adjusted_minutes`; `job_costs` (`job-costing.js`); `estimate_actuals` (nightly 02:37); `pest_production_calibration_records` (0 rows) | tech `/complete` | as named | — | `job_costs.products_cost` from `product_inventory_movements` else catalog else cheapest vendor row (unfiltered) — lawn averages $5,943/visit (unit error) | — | — |
| Profitability feedback | `pricing-reality-check.js` (on demand), `estimate_actuals` digest (turf only), `lawn-pricing-invariant-sweep` (Mon 06:30) | admin pages | — | none writes back to pricing (correct) | — | — | quoted-vs-actual labor has no cron/alert |

**Hard-coded price/rate/cost/minute inventory:** `scripts/audit-estimator-pricing.js` emits `hardCodedRates` (labor, materials, prices, margin divisors) from the live constants object; the human-readable catalogue is §6.3 and the service matrix columns `labor_formula` / `material_formula` / `minimum_price` / `floor` / `cap`.

---

## 4. Source-of-truth analysis

| Concept | Authoritative | Duplicates / shadows | Verdict |
|---|---|---|---|
| Customer price | `generateEstimate()` on `constants.js` ⊕ `pricing_config` | client fallback engine `client/src/lib/estimateEngine.js` (helpers only in the shipped builder; `calculateEstimate` unreachable), `pricing-engine-v2.js` references in docs (file absent), `TechEstimatorPage` (redirect stub) | single authority — verified (Static; validation §6) |
| Pricing knobs | `pricing_config` (DB) via `db-bridge.js`; `constants.js` = fresh-env default | POLICY.md / README / TERMITE-PRICING.md | **DB wins and has drifted**: pest floor $79 vs $89; `waveguard_qualifying`, `waveguard_caps`, `global_processing` ("3% baked in"), `pest_service_costs` (33 on-site min, $41.80 cost) are orphan rows no bridge key reads |
| Labor rate | `pricing_config.global_labor_rate` = 35 | 13 more literal `35`s (IB `estimate-tools.js:1600, 2809`, `pricing-reality-check.js:5`, `job-costing.js:35`, `pnl-report.js:77`, client engine, `LAWN_PRICING_V2.laborRateLoaded`) | a DB rate change would not reach IB margin checks, the reality-check tool, job costing or P&L |
| Labor minutes | literals per pricer (§5) | `admin-pricing-config.js:45-92 ESTIMATE_COST_FALLBACKS` (15–30 min) for `/margin-check`; `pest_service_costs` DB row (33 min) | three different minute models for the same visit |
| Material cost | literals per pricer; pre-slab → catalog | `products_catalog.best_price` (216 rows), `vendor_pricing` (179), `tank_mixes.cost_per_1000sf` (price-sync only), `service_product_usage` (audit only) | no single source; see §6 |
| Protocol | `server/config/protocols.json` (prose, inline `($N)`), `lawn_protocols*` (structured, with carrier), `protocol_templates` (1 active), `service_product_usage` (audit) | — | three unreconciled representations; e.g. Prodiamine 3.0 oz/app (`service_product_usage`) vs 0.30 oz/1,000 (`lawn_protocol_products`) vs 0.37 (`products_catalog`) |
| Cadence → visits | engine constants per service | 12 label→visits maps (§7.2) incl. label-first parsers | display labels are parsed into counts in four places |
| WaveGuard policy | `constants.WAVEGUARD` + `rodent_waveguard` DB row + `service_discount_rules` table | `waveguard_qualifying` orphan row; docs | consistent in prod today (rodent_bait qualifies since 2026-08-29) |
| Tier discount % | `constants.WAVEGUARD.tiers` ⊕ `pricing_config.waveguard_tiers` | `discounts` catalog rows (waveguard_silver/gold/platinum) used on invoices | two representations, same values |
| Accepted price | `estimates.monthly_total/annual_total` written at lock from the selected bundle row | manual acceptance reads columns only | consistent (validation §5) |
| Actual labor | `scheduled_services.time_on_site_adjusted_minutes` > `actual_duration_minutes` > check-in/out | `service_records.started_at/ended_at`, `time_entries` | fine; unused by pricing |

---

## 5. Labor audit

### 5.1 What the $35 represents
`constants.js:21` "loaded (wages + benefits + WC + vehicle + insurance)"; POLICY.md §Loaded labor rate: ≈1.55× gross wage including payroll tax, workers' comp, vehicle amortisation + fuel, insurance, benefits. It does **not** include: paid travel beyond the per-visit drive allowance, non-billable time, overtime, training, uniforms, management or admin support (the $51/service/yr `ADMIN_ANNUAL` covers billing/scheduling/CRM). `company_financials.loaded_labor_rate` (job costing) carries the same 35 with `target_gross_margin_pct = 55`, which nothing reconciles to the engine's 35/45 targets. No double-count found; the omission is everything outside the visit.

### 5.2 Every labor-time assumption that shapes a price or a reported margin
| Service | On-site minutes | Drive | Setup / mixing / reporting | Callback | Techs | Height / access | Where | Moves price? |
|---|---|---|---|---|---|---|---|---|
| Pest recurring | 25 (20 monthly) | 20 | none | none | 1 | none | `service-pricing.js:1427` | no (bracket) |
| Pest production diagnostics | 18 base ± footprint/lot/cage/shrub/complexity (shadow) | — | — | — | — | — | `constants.js:194-227` | no (shadow) |
| Lawn | 12 + 2.5/1,000 sf + complexity 0–20 | 5 (DENSE) | none | $2/visit | 1 | none | `constants.js:309-326`, `packages/lawn-cost-floor` | no (bracket; floor disarmed); dead `$26.96/visit` literal at `service-pricing.js:2113` |
| Tree & shrub | max(25, 20 + bed/500 + 1.5/tree + access 0/8/15) **+10 undocumented** | 0 (inside the +10?) | — | 0 | 1 | access only | `service-pricing.js:2774-2801` | **yes** |
| Mosquito | 30 | 20 | — | — | 1 | — | `:4471` | no |
| Rodent bait | 5/station | 20 | — | — | 1 | — | `:4900` | no |
| Termite install | 5/station (computed, **not billed**) | — | — | — | 1 | — | `:4772-4774` | no |
| Termite monitoring | 5/station | 20 | — | — | 1 | — | `:4900` | no |
| Commercial pest / mosquito / termite / rodent / lawn / T&S | 15–25 base + per-unit + 8–10 overhead | 15 | overhead line | $3/visit (lawn) | 1 | — | `constants.js:651-775` | **yes** |
| Bed bug chemical | 45 + 30 + 30/room (v1); 25 + 20/room (v2) | 20 | in base | — | 1 | stories mult | `constants.js:2024-2026` | **yes** |
| Foam drill | 1.0/1.5/2.0/3.0 h by tier | — | — | — | 1 | — | `:1771-1774` | **yes** |
| Pre-slab | 0.5 h + 1 h/1,500 sf (1–5 h) | 20 standalone only | $25 compliance | — | 1 | — | `:1758-1763` | **yes** |
| Bora-Care | 1.5 + sf/1,000 h (2–6; 6–10 multi-day) | — | — | — | 1 | attic floors | `service-pricing.js:6355-6359` | **yes** |
| Dethatching / top dressing / plugging | sf-per-minute proxies, setup 30/45, cleanup, access | — | in model | — | 1 | access | `constants.js:1433-1448`, `:7692-7697`, `:1415` | **yes** |
| Exclusion v2 / foam v2 / stinging v2 / rodent plugging | 5/point × roof × story + 30; 2–4/point + 10; 15 + 8/nest; 3–5/point + $45 trip | — | setup | — | 1 | roof/story | `service-pricing.js:8656-8780` | **yes** |
| WDO, German roach, rodent trapping, flea, palm injection | none modeled | — | — | trapping: unlimited follow-ups unpriced | — | — | — | flat |

**Bundle sharing:** no residential path shares drive/setup/reporting across services on the same visit; each recurring line carries its own drive (pest $11.67, lawn $2.92 × 9, mosquito $11.67 per visit). Pre-slab `includeDriveCostByContext` and commercial pest interior (shares the exterior trip) are the only sharing rules. Because prices are bracket-based this does not double-charge the customer; it makes reported bundle margins conservative (Hypothesis #15: no double charge; under-count only in the sense that a 3-service visit's reported cost includes three drives).

### 5.3 Estimated vs actual (production, 2026-06-01 → 2026-09-02, completed visits with recorded minutes)

> **Owner review 2026-09-02: the recorded minutes below are NOT on-site time.** Check-out is often stamped while driving to the next stop. Read every "actual" column as *recorded span including drive*; the comparisons are retained only to document what the data currently contains. The residual finding is MON-004 (on-site time is not captured separately).
| Service type (as stored) | n | Modeled on-site min | Median | Avg | p75 | p90 | Modeled labor $/visit | Actual (median) $/visit | Margin shift (per visit) | Recommended assumption |
|---|---|---|---|---|---|---|---|---|---|---|
| Quarterly Pest Control Service | 89–98 | 25 | 44 | 48 | 63 | 78–79 | $14.58 | $25.67 | −$11.08 (−9.9 pts at $112) | 45 min (median), report p75 |
| Pest Control Service / Quarterly Pest Control / Pest Control (legacy names) | 19–33 each | 25 | 51–57 | 53–58 | 65–68 | 78–85 | $14.58 | $29.75–33.25 | −$15 to −$19 | same |
| Monthly Pest Control Service | 6 | 20 | 36–37 | 41 | 51 | 61 | $11.67 | $21.58 | −$9.91 (−12.7 pts at $78) | 35 min |
| Every 6 Weeks Lawn Care Service (9x) | 17 | 23.25 (4,500 sf) | 44 | 51 | 50 | 56 | $16.48 (incl. 5 drive) | $28.58 (recorded span, drive included) | −$12 to −$21 (−19 to −33 pts at $64) | 45 min + real drive |
| Monthly Lawn Care Service (12x) | 7 | 23.25 | 37 | 40 | 46 | 54 | $16.48 | $24.50 | −$8 (−19 pts at $41) | 40 min |
| Lawn Care Visit / Lawn Care (legacy) | 3–6 | 23.25 | 46–54 | 58–61 | 64–69 | 70–100 | $16.48 | $32–$36 | — | — |
| One-Time Pest Control Service | 3 | (2.2× quarterly) | 36 | 37 | 38–39 | 40 | — | $32.67 | fine ($182 avg) | — |
| Cockroach Treatment | 3 | 15–25 extra | 36 | 35 | 40 | 42 | — | $32.67 | fine ($231 avg) | — |
| WDO Inspection Service | 9 | none | 60 | 60 | 60 | 60 | $0 | $46.67 | 18.7% of $250 unmodeled | 60 min |
| Rodent Trapping Service | 7 | none | 92 | 92 | 92 | 92 | $0 | $65.33 (+ unlimited callbacks) | 28% of $235 avg unmodeled | 90 min + callback reserve |
| Pest Control Re-Service (callbacks) | 4–7 | none | 28 | 30 | 38 | 44 | $0 | $28 | 8 of 307 visits (2.6%) ⇒ ≈$0.73/visit | add reserve |

Realized revenue per hour of RECORDED span (production; the span already contains drive, so no drive minutes are added — MON-004; from the data-quality appendix): quarterly pest $305/h, one-time pest $295/h, cockroach $445/h, monthly pest $124/h, **lawn 9x $101/h**, **lawn 12x $92/h**, **lawn visit $77/h**. These are revenue per recorded hour, not margins, and carry no pricing recommendation; even so, at a $35 loaded hour plus materials, lawn is the thin line.

Grouping by residential/commercial, size band and discount tier is **UNKNOWN** from production today: `scheduled_services` carries no sqft, `customers.property_sqft` is lawn area by schema, and the `service_type` string does not identify the plan (42 distinct strings, 21 match a catalog name, 0 match a key). Query needed once `service_key_snapshot` (219 of 434 visits) is universal: join `scheduled_services.source_estimate_id → estimates.estimate_data.engineInputs.homeSqFt/lawnSqFt` and `customers.waveguard_tier`.

### 5.4 Labor findings
- **LAB-001 — withdrawn (owner review 2026-09-02), re-filed as MON-004 (P2)** — see §1 #1 and §14. The pest 25-vs-44-minute comparison was invalid: recorded check-out times include drive. The calculator run (`docs/audits/...calculator-run.md` §Annual economics) now prices the 2,000 sf quarterly $112/app plan at 58.6% modeled gross margin (Platinum 48.2%); its recorded-span columns (59.4% at the median, 49.5% at p75, drive never re-added) are context only and carry no labor conclusion.
- **LAB-002 (P1)** lawn 9x 4,500 sf St. Augustine $64/app is below the 35% floor on the engine's own labor model: modeled 30.7% (already `marginFloorOk:false`), Silver 23.0%, Gold 18.4%, Platinum 13.3%. The recorded-span columns (16.3% median / 10.9% p75, drive included, MON-004) carry no pricing recommendation; the earlier "$91.36/app needed at observed labor" figure was derived by re-adding drive to a span that already contains it and is withdrawn.
- **LAB-003 (P2, Static)** `service-pricing.js:2113 laborPerVisit = 26.96` (= 46.2 min at $35) is a dead literal that still reaches `costs.annualLabor` when cost-floor details are absent.
- **LAB-004 (P2, Static)** T&S `(onSiteMin + 10)` at `:2800` — the 10 is undocumented and not DB-tunable.
- **LAB-005 (P3, Static)** `/margin-check` uses `ESTIMATE_COST_FALLBACKS` minutes (pest 20, lawn 30, T&S 25, mosquito 15) that disagree with the engine's models; the IB `margin_check` payload hard-codes `35`.
- **LAB-006 (P2, Static)** termite install labor (5 min/station) is computed but excluded from the billed base by design (`constants.js:1004-1007`); termite monitoring at 5 min/station + 20 drive costs more than the $19–$39/mo bracket collects (calculator: −23% at Bronze for a 2,000 sf home under the plan's cartridge-replacement cost model — installed cartridges × 33% × $6.83 plus a 0.25-visit follow-up reserve; an earlier −65% had borrowed the rodent bait / station-amortization rates, which the termite pricer does not define). Ruling needed (§16).

---

## 6. Inventory audit

### 6.1 Can inventory support pricing today? **No** (Data).
| Field (products_catalog, 192 active) | Present | Missing |
|---|---|---|
| `cost_per_unit` + `cost_unit` (normalised costing unit) | 19 | **173** |
| `best_price` (container price) | 162 | 30 |
| `unit_size_oz` (package size) | 166 | 26 |
| `default_rate_per_1000` or `default_rate` | 163 | 29 |
| `rate_unit` | 103 | **89** |
| `label_verified_at` | 173 | 19 |
| `best_price_status = current` | 149 | 43 (36 `needs_mapping`, 7 `stale`) |
| `best_price_updated_at` | 156 | 36 never |
| `epa_reg_number` | 192 | 0 |
| `vendor_pricing` normalised unit price (`price_per_oz` / `normalized_unit_price`) | 43 of 179 | **136**; 160 without `unit`; 177 `last_checked_at` > 90 d |
| duplicates | 0 duplicate names; **1 duplicate SKU** | — |
| shipping / tax / landed cost | columns exist (`vendor_pricing.landed_cost`); population unknown — UNKNOWN (query: `count(*) filter (where landed_cost is not null)`) | |
| coverage rate with area unit | `default_rate_per_1000` + `rate_unit` (no carrier column on `products_catalog`; carrier lives on `lawn_protocol_products.carrier_gal_per_1000`) | |
| substitutes | `lawn_protocol_product_substitutions` (0 rows) | |

Unit vocabulary: `cost_unit` ∈ {oz 8, fl_oz 7, lb 2, tablet 1, station 1}; `rate_unit` ∈ {fl_oz 58, lb 29, oz 15, g 1}. `product-costing.js:8-26` treats `oz` and `fl_oz` as the same unit (deliberately dimension-ambiguous) — an ounces-vs-fluid-ounces confusion is structurally possible for any product whose `cost_unit` says `oz` and whose rate says `fl_oz` (or vice versa); the 15 `oz`-rated products should be checked by hand (**Hypothesis**; query: rows where `rate_unit='oz'` and the label is a liquid).

### 6.2 Linkage
- Pricing reads the catalog for **one** service: pre-slab termiticide (`db-bridge.js:762-811`, approved vendor price, `[0.5×, 2×]` sanity band, fail-open, kill switch `link_container_costs_to_catalog`). 
- `service_product_usage` (32 rows, 24 service types) is the audit's COGS map; **all 32 `service_type` values are display strings, none is a catalog key**; 6 rows point at products with no cost; `packets` (Alpine WSG) is not a recognised unit → `convertToOz` null → **$0 cost with a warning string nobody renders** (`product-costing.js:246-277`).
- `tank_mixes` (`price-sync.js`) recost from the catalog but no pricer reads them ("Does NOT modify pricingEngine constants", `price-sync.js:14`).
- `job_costs.products_cost` falls back to the **cheapest vendor row with no active/approval filter** (`job-costing.js:285-287`) and silently skips uncosted lines; production averages show the unit error (lawn "products" $5,943/visit, quarterly pest $54–$180 vs the engine's $6.67) — **INV-003 (P2, Data)**.

### 6.3 Hard-coded material constants vs the live catalog (Data, 2026-09-02)
| Constant (file:line) | Code value | Catalog `best_price` (status) | Verdict |
|---|---|---|---|
| pest chem `talak 1.30 / taurus 4.87 / surfactant 0.50` per visit (`service-pricing.js:1425`) | $41.57/gal Talak; $95/78 oz Taurus | Talak $41.57 (current); Taurus SC $95.00 (current) | consistent today; not linked; `pest_service_costs` DB row is an orphan copy |
| `MOSQUITO.productCosts` (`constants.js:951-957`) | Bifen I/T $41.08/128 oz; Tekko Pro $52.97/16 oz; Scion $161.30/32 oz; In2Care $13.14; dunks $26.88/20 | $41.08; $52.97; $161.30; $13.14 (**stale, needs_pricing**); $26.88 (**stale**) | equal today; not linked |
| `TERMITE.systems.trelona.stationCost 22.05` (`:1001`) / advance 13.16 | | Trelona ATBS Bait Station **$24.00 (stale, needs_pricing)**; Advance $14.00 (stale) | code behind supplier: 16-ct box is $384.00 = $24.00/station (owner 2026-09-02); replacement cartridges ($6.70–$10.70 each) in no pricer |
| `SPECIALTY.trenching.products.termidor_sc.containerCost 375 / 78 oz` (`:1495`) | | Termidor SC **$174.72** (current) | **2.1× over**; MAT-001 |
| trenching `taurus_sc 85/78` | | $95.00 | 10.5% under |
| trenching `bifen_it 55/96 oz`, `talstar_p 65/96 oz` | | Bifen I/T $41.08 / **128 oz**; Talstar P no price (`needs_mapping`) | wrong container size and price |
| pre-slab `termidor_sc 174.72`, `taurus_sc 95`, `bifen_it 41.53`, `talstar_p 38.99` (`:1650-1727`) | | linked — equal | consistent |
| `boraCare.galCost 91.98` (`:1608`) | | Bora-Care $91.98 | equal; not linked |
| `foamDrill.canCost 39.08` (`:1768`) | | Termidor Foam $39.08 | equal; not linked |
| `BED_BUG` PT Alpine WSG container $220.53/500 g → $50.42/room (`:2036`) | | Alpine WSG **$163.56** (current) | 35% over; not linked |
| `PALM.internalCostBasis` Palm-Jet $125.63/L, Ima-Jet $295/L, Ima-Jet 10 $427.75 (`:894-906`) | | $125.63; $295.00; $427.75 | equal; audit-only |
| T&S `materialModel` ($15 + $4/tree + $0.055/sf) derived from June-2026 LESCO/Snapshot prices (`:541-551`) | | Snapshot 2.5TG $149.24/50 lb; LESCO rows | derivation not reproducible from the DB |
| `LAWN_MATERIAL_BUDGETS` (`packages/lawn-cost-floor/index.js:54-59`) | e.g. St. Augustine 9x $182/yr @ 4,500 sf | hand-derived from `protocols.json` `material_cost` + `conditional_cost` | no automated check; `audit-waveguard-protocol-material-costs.js` exists for manual reconciliation |

### 6.4 Recommended missing-cost behaviour
Adopt **"last known cost + stale warning, fail closed when no cost ever existed"**: the estimator line and the pricing audit snapshot carry `materialCostSource ∈ {catalog_current, catalog_stale, constants_fallback, missing}`; `missing` blocks autonomous send and the public quote for that service (`quote_required`), never a silent $0. Today the only fail-open is pre-slab (silent) and the audit's `cost: 0`.

---

## 7. Protocol audit

### 7.1 Protocol-to-price map
| Service | Protocol source | Products / rates / carrier present? | Priced from the protocol? | Gap |
|---|---|---|---|---|
| Pest | `protocols.json.pest` (prose with `($N)`) | rates inline in prose; no carrier | no — $6.67 literal | rotation (Talak/Taurus/Tekko Pro/Temprid/Demand CS per the orphan `pest_service_costs` row) not modelled; Tekko Pro IGR ($3.31–4.54/visit) absent from the $6.67 |
| Lawn | `protocols.json.lawn.<track>` + `lawn_protocols`/`windows`/`products` (structured: `rate_per_1000`, `rate_unit`, `carrier_gal_per_1000` 1/2/3 gal by role) | yes — 141 product rows (6 unlinked product_id, 18 without rate) | no — budgets hand-derived once (2026-07-16 spot-reserve fold) | budget drift undetected; protocol carrier (2 gal/1,000 insecticide/fungicide) never meets the 2.0 gal/1,000 calibration |
| Tree & shrub | `protocols.json.tree_shrub` (6-visit "10/10 SWFL" protocol; 110-gal and 2.5-gal formulas as text) | rates per 100 gal in prose | no — `materialModel` derived once | pricing sells 4/6/**9** visits; protocol tops out at 6; palms in protocol (8-2-12 palm fert) but palm reserve dark |
| Mosquito | `protocols.json.mosquito` | prose | no — usage constants (3 oz Bifen base + 0.5 oz/1,000; 1 oz Tekko) | stations/dunks priced as add-ons; consistent |
| Termite bait | `protocols.json.termite`; `service_product_usage` "Termite Bait" Trelona **1 station / 10 LF** | — | no — 15-ft spacing in pricing | usage map says 10 ft, pricing 15 ft (Trelona label 10–15, max 20) |
| Pre-slab / trenching / Bora-Care / foam | `protocols.json.termite` | rates in constants (oz/gal, oz/10 sf, gal/275 sf, cans/tier) | partially (constants) | label confirmation flags exist (`requiresLabelConfirmation`) |
| Rodent | `protocols.json.rodent` | — | no — $1.50/station bait literal | — |
| Palm injection | `protocols.json.palm_injection` | products named (Palm-Jet Mg, Ima-Jet, PHOSPHO-Jet, Propizol, Arbor OTC, Tree-Age) | no — $/palm | no dose by trunk size |
| Cockroach / bed bug | `protocols.json.cockroach/bed_bug` | bed bug: PT Alpine WSG; IGR **disabled until label verified** (`constants.js:2040-2044`) | partially | — |
| Flea, stinging, tick, mud dauber, wildlife, fire ant, plugging, top dressing, dethatching, WDO | none in `protocols.json`; `protocol-matcher.js` has no rule | — | no | no protocol linkage at all (14 services) |
| Deterministic `protocol_templates` | 1 active template, 3 product rows, **all 3 without a rate** (`rate_basis = label_compliant_default`) | — | no | — |

Protocol fields required by the brief (target pest, zones, products, rotation, method, rate, carrier, coverage basis, batch size, equipment, labor steps, PPE, re-entry, follow-up, callback policy, seasonal variation, property-type variation, label limits, max annual, material cost, application time) exist **only partially and only in the lawn operating layer** (`lawn_protocol_windows.main_tank/spot_work/required_tasks/conditional_triggers`, `lawn_protocol_gates`); everywhere else they are prose. Application time exists nowhere as data.

### 7.2 Problems found (all Static unless noted)
- **PRO-001 (P2)** three unreconciled rate representations (Prodiamine 3.0 oz/app vs 0.30 oz/1,000 vs 0.37 oz/1,000 across `service_product_usage` / `lawn_protocol_products` / `products_catalog`).
- **PRO-002 (P2)** T&S sells 9 visits; protocol documents 6; `pricing_config.ts_material_rates.note` and POLICY.md say 9x retired while `constants.js:594` un-retired it (2026-07-23).
- **PRO-003 (P2)** initial vs maintenance: no service has an initial-visit material/labor uplift except pest roach knockdown fees and flea packages; first lawn/T&S/mosquito visits are priced like maintenance (Hypothesis #16 confirmed as absent-by-design — ruling needed).
- **PRO-004 (P3)** callbacks: pest re-service 2.6% of visits, unpriced; rodent trapping "unlimited callbacks" unpriced.
- **PRO-005 (P3)** `protocols.json` `material_cost` (10,000-sf basis) vs `conditional_cost` (per-1,000) — the budget derivation mixes bases in a comment only (`packages/lawn-cost-floor:41-53`); the reconciliation script `server/scripts/audit-waveguard-protocol-material-costs.js` should be run and its variance recorded (**Hypothesis**).
- Label verification: 19 active products have no `label_verified_at`; rates in this report are reported as stored and marked UNKNOWN where the catalog has no `label_verified_at`.

---

## 8. Equipment and calibration audit (Data + Static)

| System | Type | Tank | Carrier gal/1,000 | Pump GPM ref | Gun/flow GPM ref | Status | Verified |
|---|---|---|---|---|---|---|---|
| FlowZone Typhoon Backpack | backpack | 4.00 | 1.330 | — | 0.730 (flow) | estimated_not_field_verified | never |
| 110-Gallon Spray Tank #1 | tank | 110.00 | 2.000 | 15.000 | 2.000 (gun) | estimated_not_field_verified | never |
| Udor KAPPA-18/12V-HP + 110-gal tank #2 – Lawn Gun | tank | 110.00 | 2.000 | 4.200 | — | estimated_not_field_verified | never |

Also stored (prose, `equipment.notes`): Udor KAPPA-55/GR5 "7 GPM @ 580 PSI max". Spreaders (EcoLawn ECO 250S 11.5 cu ft), Classen TR-20H dethatcher, Arborjet QUIK-jet are assets with purchase prices only. No walking speed, nozzle, refill, waste, or batch-size values exist beyond the calibration columns (`expected_refill_gallons`, `acceptable_first_pass_refill_*`, `target_bucket_30_sec_oz`) which are empty for all three rows (UNKNOWN — 45 columns, 3 rows, mostly NULL; query: `select * from equipment_calibrations`).

Findings: **EQP-001 (P2)** nothing in pricing reads a calibration; the field plan (`waveguard-plan-engine.js:863-906`) fails closed on `calibration_status !== 'field_verified'`, so the plan engine cannot compute a mix for any system today while estimates price with zero carrier knowledge. **EQP-002 (P3)** the pump-rated GPM (15 / 4.2 / 0.73) and carrier volume (2.0 / 1.33 gal/1,000) are stored as distinct columns — the confusion in Hypothesis #13 is *not* present in code, only unprevented. **EQP-003 (P3)** equipment cost is $0 everywhere: `equipmentReservePerVisit: 0`, `job_costs.equipment_cost` hard-wired 0 (`job-costing.js:500`), while `equipment_register` carries ~$60k of §179 basis.

---

## 9. Estimator inputs, property data, UI and validation audit

### 9.1 Tree, shrub and palm (explicit requirement)
| Field | Collected | Used by price | Verdict |
|---|---|---|---|
| Palm count | admin (`palmCount`, guarded 1–200), website (`treeShrub.palmCount`), AI (1–200), vision (`estimatedPalmCount`) | **only when on the service line** (`service-pricing.js:2745-2770`); admin translator sends property-level only (`property-lookup-v2.js:3970` sends `{tier:'standard'}`) | **INP-001 P1** — Reproduced: 30 palms $53.08 vs $95.17/mo |
| Palm size / height / method (foliar, soil, granular, injection) | palm injection only (size enum, dbh for Tree-Age, treatment type) | palm injection only | T&S has no palm size; routine palm reserve ships 0/0 |
| Non-palm tree count | admin (`treeCount`), website, AI, vision | yes (1.5 min/tree, $4/yr) | **INP-002 P2** blank admin field posts explicit 0 → suppresses density fallback ($45.25 vs $58.75/mo) |
| Shrub count / size | not collected anywhere | density enum ×1 (neutral) | absent by construction — ruling |
| Bed area | admin (`bedArea` → `estimatedBedAreaSf`, stamped `estimated`), website/AI (lot × density %), vision | yes | typed bed area never `explicit`; lot-based `medium` confidence evades the low-confidence lane (**INP-003 P2**) |
| Access difficulty | website/AI only; **admin does not collect** | 0/8/15 min | **INP-004 P2** |
| 6-visit vs 9-visit | website/AI (`tier`); admin hardcodes `standard` | yes | admin cannot sell 9x T&S through the builder (**INP-004**) |
| Initial vs maintenance | not modelled | — | ruling |
| Passes | not modelled | — | ruling |

### 9.2 Other inputs (admin builder unless noted)
- Numeric fields are raw strings with decorative `min/max` (`EstimateToolViewV2.jsx:948-961`); blank → `parseInt` → NaN → **0** for home/lot sqft and counts; negatives pass for stories/tree count; decimals truncate. Server translator has no schema (`server/schemas/` holds call-extraction only). Reproduced: stories 2.7 → footprint 741 → $97/app (no flag); stories −3 → treated as 1; homeSqFt 1e9 → $128/app, no review; lawnSqFt 0 → $45.33/app, no review; rodent bait with no footprint → 2,500 sf bracket silently (**INP-005 P2**, four cases).
- Lot vs treatable: `property-calculator.js:258-271` lot-fallback turf = lot × (1 − 20%) − 15% beds ≈ lot × 0.68 with `turfConfidence: LOW` and `FIELD_VERIFY_TURF_SQFT` (parks lawn on the LEAD/AI path; admin requires `measuredTurfSf` for whole-lawn services via `TURF_CONFIRMATION_REQUIRED`). Mosquito treatable = lot − footprint − hardscape curve (`HARDSCAPE`, `constants.js:50-61`). 7 delivered estimates carry `lotFallback` turf (Data).
- Property data provenance: county PAO > verified override (never expires) > vision (confidence floor 60) > caller > subdivision median; `data_saved_at` on `property_lookups`; not stamped on the estimate (**AUD-003 P3**).
- Commercial fields appear only when `isCommercial` (`:6224-6303`); subtype is free text.
- Manual prices: roach fee override, custom $/palm, bedbug vendor cost, manual discount — **no reason field except custom-preset discounts, no user, no timestamp, no original price** (`admin-estimate-persistence.js:1256-1345`; `adminUserId` is passed to manual acceptance but not persisted) — **AUD-001 P2**.
- Warnings reaching the customer: quote-required copy, low-confidence ranges, parcel-clamped turf note, "hard to confirm remotely". Not reaching the customer (admin-only): `CLIENT_FALLBACK`, `pricing_drift`, engine warnings/manualReviewReasons, palm clamp, member-linkage warning. Residential PDF carries no scope quantities (`estimate-pdf.js` scope block is commercial-proposal only) — **UI-001 P3**.
- Stinging insects: admin sends none of species/tier/removal → every admin wasp quote is tier-2 paper wasp, no removal (`property-lookup-v2.js:4232-4241`) — **INP-006 P2**.
- Legacy wire-mesh/bird-box services are unreachable from the admin builder (folded into Exclusion V2) while their pricers remain — dead paths (**CAT-006 P3**).

### 9.3 AI extraction (Static; runtime probes from the validation)
- Schema has **no sqft field**; property facts come from arbitration (`source-arbitration.js`, never defaults). Confidence is a 3-level self-report; non-high → yellow lane; nothing blocks pricing before `classifyLane` (pricing runs first, `estimator-engine/index.js:1892`), but drafts persist with the lane.
- Defaults classified (full table in the field-requirements doc): LEAD 2,000/8,000 sf **Must-require-review** (flagged, 182 live drafts, 0 delivered); IB `lotSqFt = homeSqFt × 4` **Financially risky, no review lane on `compute_estimate`**; `stories || 1` in four places (marker only in draft-builder) **Financially risky**; LEAD lawn `st_augustine/enhanced`, mosquito `monthly12`, flea `light`, German roach `light` (cheapest) **Financially risky**; bed-bug/stinging defaults **Must-require-review** (flagged); property type `'Single Family'` when the unit-scope gate is off **Label-sensitive** (gate on in prod); vision failure reads as `MODERATE` density **Label-sensitive**; mosquito missing lot → ACRE **Safe (fail-expensive)**.
- Keyword tables: portal pricing AI maps WDO/termite inspection → termite bait, German roach → recurring pest, "palm tree" → tree_shrub before palm (AI-001, open from the validation); SMS classifier returns a confidence nobody thresholds (**AI-004 P3**); top dressing/plugging → `lawn` in `sms-service-intent.js:37-38` while the composer and lead builder treat them as manual scope (**AI-005 P3**).
- Prod env: `GATE_LEAD_ESTIMATE_AUTO_SEND=false` but `LEAD_ESTIMATE_AUTO_SEND_ALLOWED_REVIEW_REASONS=property_measurements_defaulted` is **set** — the exact reason the code comment removed from the default allow-list. Latent: flipping the auto-send gate would auto-send synthetic-scope quotes (**AI-006 P2**).

---

## 10. Recurring frequency and annual economics

Cadence identities hold in the engine (calculator: `perApp × visits = annual`, `monthly × 12 = annual` within 6¢, all 12 cases; monthly12 mosquito never above seasonal9; lawn 6x/9x/12x per-app monotone at every tested size). Label maps (12 of them) agree on the canonical vocabulary; the risks are (a) label-first parsing in `recurring-appointment-seeder.js:237-260` and `billing-cadence.js:157-176`, (b) `patternFromVisitsPerYear` bucketing 9 → bimonthly when no cadence text exists (`seeder:176-185`), (c) `VALID_FREQUENCIES` lacking `triannual` that two other maps support, (d) `visitsForRecurringServiceName` deriving visits from the *name* (`estimate-public.js:1462-1478`) — **CAD-001 P2 (Static)**. **CAD-002 (P1, Reproduced)**: with no cadence text, a tree & shrub 9x line resolves its annual-prepay coverage cadence to `bimonthly` (calculator, `annualPrepayCoverageCadence`) — the prepay term would cover 6 of the 9 prepaid visits and the last three would complete-bill again; lawn 9x is protected by the forced-lawn mirror (`every_6_weeks`), tree & shrub is not (exposure is prospective: 0 accepted tree & shrub quotes today). Mosquito seasonal9 resolves `seasonal_feb_oct`, which term creation fails closed on by design (no prepay term, standard accept) — the calculator records that as an expected rejection, not a mismatch. Data: 0 active catalog rows where `frequency` disagrees with `visits_per_year` today (two historical drifts fixed 2026-08-05/08-29).

First-year vs renewal-year economics (engine labor model, 2,000 sf / 8,000 sf lot / 4,500 sf lawn reference; full tier table in the calculator run):

| Service | List /visit | Visits | Renewal revenue | Year-1 revenue | Modeled gross margin | Recorded-minutes margin (includes drive; unreliable, MON-004) | Bronze → Platinum modeled |
|---|---|---|---|---|---|---|---|
| Pest quarterly | $112 | 4 | $448 | $547 (+$99 setup) | 58.6% | 59.4% | 58.6 → 48.2% |
| Lawn 9x St. Augustine | $64 | 9 | $576 | $576 | 30.7% | 16.3% | 30.7 → 13.3% |
| Mosquito seasonal9 | $77 | 9 | $693 | $693 | 49.2% | UNKNOWN (no minutes stored per mosquito visit yet) | 49.2 → 36.5% |
| Rodent bait | $89 | 4 | $356 | $455 (+$99 setup, Bronze stand-alone only — waived beside any other qualifier) | 37.2% | UNKNOWN | 37.2 → 21.5% |
| Tree & shrub 6x (1,440 sf beds, 6 trees) | $95.82 | 6 | $575 | $575 | 45.0% | UNKNOWN | 45.0 → 31.3% |
| Termite bait monitoring | $72 | 4 | $288 | $898 ($288 + $610 billed install) | −23% (5 min/station + cartridge model) | UNKNOWN | −23 → −54% |

Annual prepay: base = the accepted annual; 5% off only when the mix carries no pest/mosquito setup fee (`estimate-converter.js:2876-2884`); pest/mosquito keep the $99 waiver; converter fences monthly billing (`billing-cron.js:220-263`); DATA-002 (expired term strands the lane) remains open from the validation. **BIL-002 (P1/Ruling, Data)**: 3 real customers sit in `monthly_membership` with `monthly_rate > 0` and are dues-cron eligible, contradicting the 2026-09-01 never-monthly ruling; 568 customers are in the legacy `per_visit` lane (invoice-on-complete, no fee) and 18 have no lane.

---

## 11. Discounts, bundles and margin

- Tier: count of qualifying keys {lawn_care, pest_control, tree_shrub, mosquito, termite_bait, rodent_bait} → Bronze 0 / Silver 10 / Gold 15 / Platinum 20% (Reproduced, 8 combos). Palm never counts; Gold+ $10/palm/yr flat credit capped at the palm annual. Excluded from every %: rodent guarantee, palm, bed bug, Bora-Care, pre-slab, recurring foam, bond, station rental, German roach (both), roach knockdown, rodent setup.
- Stacking: tier % → one-time perk 15% (never both on one line) → manual discount (PERCENT per bucket; FIXED spread proportionally, capped at the discountable total; lawn floor protection inert while floors are disarmed). Promo/composite caps were removed in v4.3; **no cap exists** — Platinum + 25% manual on the reference bundle: $1,883 → $1,412 with `manual_discount_below_margin_floor` warnings only; FIXED $99,999 → **$0 year-1 total** (Reproduced; **DIS-001 P2**).
- Setup fees: $99 pest setup and $99 rodent setup are never discounted (Static + Reproduced); pest setup is excluded from `summary.year1Total` (PRICE-004 open).
- Savings copy: `waveGuardSavings = before − after` from the same lines (consistent); customer-facing per-application copy re-derives per line (`PriceCard.jsx`) — Hypothesis: the client `round2` of a discounted per-app could differ by 1¢ from the server's per-line rounding (query: none; test: compare `perApplicationNetForFrequency` to server `perApp` across the golden cases).
- Tax after adjustments: residential 0; commercial blended rate on the discounted base (`estimate-converter.js:2617`) — consistent with `InvoiceService.create`.
- **Below-floor at the deepest permitted discount** (Reproduced, engine cost model): lawn 13.3%, rodent 21.5%, T&S 31.3%, mosquito 36.5%, pest 48.2% — and at observed labor lawn is negative from Silver. All report-only by ruling (**MAR-001**).
- Stand-alone vs bundled one-time pest: $246 vs $212 (2,000 sf) — the documented 15% perk, not an unexplained gap (Hypothesis #1 closed). Bundled recurring lines never share travel (§5.2), so bundle *margins* are understated, not overstated.

---

## 12. Entry points (all 14 insert sites and every price-bearing update were mapped; summary)

| Entry point | Engine? | Authority stamp | Override audit | Note |
|---|---|---|---|---|
| Website quote (`public-quote.js:2316`) | yes | SERVER / null (quote-on-request) | — | clamps inputs |
| Lead webhook (`lead-webhook.js:859`, `:1136`) | yes (`lead-estimate-automation`) | SERVER iff generated | — | no signature; honeypot + Turnstile (fail-open) + rate limits (**SEC-004 P3**) |
| Inbound email lead (`email-actions.js:341`) | yes | SERVER/null | — | |
| Admin create/revise (`admin-estimate-persistence.js:2193/2950`) | yes; fails open to `CLIENT_FALLBACK` on engine error | SERVER / CLIENT_FALLBACK / null | baseline snapshot; discount `internalReason` | send gate on (prod) |
| Admin proposal (`admin-estimates.js:3615`) | **no — operator line items** | null + provenance marker | — | sanctioned client-priced write |
| IB `create_pending_estimate` / agent draft (`estimate-tools.js:2017/3158`) | yes, cent-checked vs model claim | SERVER | `operatorPriceAdjustment.internalReason` required | |
| Autonomous estimator (`draft-builder.js:1238`), commercial scaffold, booking pre-draft | yes / none / none | SERVER / — / — | lane + evidence | |
| Click-mint (`click-estimate-mint.js:596`), restart (`restart.js:833`) | yes, cent-exact | SERVER + server_computed_price | — | born `sent` |
| One-tap (`one-tap-purchase.js:342`) | yes | **unstamped at insert**, LOCKED at confirm | ledger | **AUD-002 P3** |
| SMS intake, lead-response tool | none (unpriced shells) | — | — | |
| Public `select-tier` / `bond` / `interior-service` / `preferences` | **stored-blob arithmetic, no engine call** | none | none | now eligibility-guarded (#3741) but still blob math (**AUD-004 P2**) |
| Service opt-out / staff park (`estimate-public.js:15377`) | full recompute; re-stamps SERVER | SERVER | `activity_log` in-txn | |
| Accept (public / manual) | selected bundle row / row columns | LOCKED | `price_locked_by` | |
| Copy/duplicate estimate | **not found** (edit-source re-seeds the builder; saving re-prices) | | | |
| Mobile/tech estimator | **retired** (redirect stub) | | | |
| Estimate from customer record | prefill href only | | | |
| Legacy paths | `client estimateEngine.calculateEstimate` unreachable; `pricingEngineClient.js` dead; `test-engine.js` dead; `v1-legacy-mapper`, `unit-band-pricing`, `commercial-helpers`, `public-ranges` live and canonical | | | |

Estimate → invoice (Data): 100 accepted estimates, 91 with an invoice in the accept window; equality classes: 18 = annual (prepay), 9 = one-time total, 1 = monthly, 1 = monthly + $99; 36 accepted rows have no `accepted_service_mode` (legacy). The first invoice legitimately equals the per-application slice + setup, not `monthly_total`, so a to-the-cent reconciliation needs `resolveRecurringFirstVisitAmount` replayed per row — **Hypothesis / query needed**: for each accepted estimate join the first invoice and compare `line_items` to `estimate_data.sendSnapshot.pricingBundle.firstVisitFees` (not run; would touch line-item text).

---

## 13. Complete issue register

Fields: ID · Sev · Confidence · Area · Evidence (file:line / table) · Current → Expected · Example · Impact (customer / ops / $) · Frequency · Root cause · Fix · Migration/backfill · Tests · Monitoring · Owner decision · Effort · Regression risk.

**P0 — none.** Nothing found charges a customer an amount the engine did not compute, and the money-moving paths (accept lock, invoice, surcharge, prepay fences) were re-verified consistent with the validation.

**P1**

- **LAB-001 → withdrawn (owner review 2026-09-02)**; re-filed as **MON-004** · P2 · high (Data) · actuals capture · `scheduled_services.check_out_time` is often stamped while driving to the next stop, so recorded minutes (pest median 44 vs 25 modeled) are not on-site time · current: no reliable on-site duration exists; expected: on-site time captured separately from drive · impact: no labor assumption (pest 25, lawn 12 + 2.5/1,000 sf, T&S 20 + bed/500 + 1.5/tree) can be validated from production; the reality-check tool and `estimate_actuals` duration deltas are computed on contaminated minutes · fix: check out before driving, or complete from the driveway and let `time_on_site_adjusted_minutes` carry the correction; then re-run `visit_actual_minutes` after one quarter · tests: none · monitoring: reality-check digest once the data is clean · owner: operational habit · effort S · risk none.
- **LAB-002** · P1 · high · lawn economics · `LAWN_BRACKETS` vs `packages/lawn-cost-floor` cost model · current: 9x 4,500 sf lists at 30.7% (`marginFloorOk:false`) by the engine's own cost model; Silver 23.0%, Gold 18.4%, Platinum 13.3% · expected: ≥35% after tier % · example: $64/app needs ≈$68/app at the modeled cost to clear 35% at Bronze, ≈$85/app at Platinum · impact: ~40 lawn visits/quarter; every Silver+ lawn customer is below the floor on the engine's own numbers (the observed-labor variant of this claim was withdrawn, see MON-004) · root cause: 2026-08-04 re-grid targeted a 0-for-12 close rate; floors disarmed 2026-07-17; material budgets hand-derived and, for 9x, derived from the wrong protocol calendar (follow-up addendum §3.2) · fix: re-derive the 9x budget from the 8-visit silver calendar, pick one labor assumption, then reprice or re-arm `useLawnCostFloor` at a real 35% · migration: `lawn_pricing_brackets` + changelog · tests: lawn golden master regen (deliberate) · monitoring: `lawn-pricing-invariant-sweep` margin check · owner: yes · effort M · risk medium (customer-facing prices).
- **BIL-001** · P1 · high (Data+Static) · completion billing · `admin-dispatch.js:9297-9310`, `billing-lane.js completionInvoiceAmount`; `customers.per_application_fee` · current: per-application/per-visit visit with no price and no fee completes with `logger.warn` · expected: park + bell, or block completion until priced · example: since 06-01 the first-pass count was 26 per-application + 22 per-visit uninvoiced, 15 + 3 with no invoice within ±3 days ≈ $1,333 — a looser predicate than the Billing Recovery workbench's, which the script now mirrors (not re-run against prod; take the workbench count as authoritative); 128/182 per-application customers have no fee · impact: revenue leakage; manual invoicing burden · frequency: order of 10–20 per quarter (workbench count pending) · root cause: fee written only at acceptance; log-only signal · fix: bell on completion-without-amount + daily digest; add the admin per-application-fee writer (ruled 2026-09-01) · backfill: list the 128 accounts for owner review · tests: completion route test for the warn branch → bell · monitoring: lead-to-cash sweep detector "completed billable visit without invoice (48 h)" · owner: fee values for the 128 · effort S–M · risk low.
- **INP-001** · P1 · high (Reproduced) · T&S palm count · `property-lookup-v2.js:3970` (sends `{tier:'standard'}`), `service-pricing.js:2745-2770` (service-line-only fold), `public-quote.js:1300-1312` (sends line palms) · current: admin palms priced $0; website palms priced · example: 2,000 sf beds, 6 trees + 30 palms: $53.08/mo admin vs $95.17/mo website (+$505/yr) · impact: under-pricing on palm-heavy properties from the admin builder; entry-point inconsistency (Hypothesis #1 class) · frequency: every admin T&S quote with palms (UNKNOWN count; query `estimate_data.engineRequest.profile.palmCount > 0` on T&S estimates) · fix: translator passes `services.treeShrub.palmCount`, `access`, `tier`; engine falls back to property palms when no line value · tests: golden case `palm count property-level vs service-line` (present; flips when fixed) · owner: whether palms ride the per-tree terms or the reserve · effort S · risk low.
- **MAR-001** · P1/Ruling · high · margin protection · `discount-engine.js applyMarginGuard` (report-only), `estimate-engine.js:2229-2360` (uncapped manual) · example: reference 4-service Platinum: lawn 13.3%, rodent 21.5%, T&S 31.3%; FIXED $99,999 → $0 · owner: re-arm per-service floors or keep flags · effort S (flags exist) · risk: prices move if re-armed.
- **BIL-002** · P1/Ruling · high (Data) · billing lanes · 3 `monthly_membership` customers with `monthly_rate > 0` (dues cron eligible) vs the never-monthly ruling; 568 `per_visit`; 18 NULL · fix: owner re-lane; add a lane invariant to the lead-to-cash sweep · effort S.

**P2**

- **MAT-001** trenching product costs stale (Reproduced+Data): `constants.js:1495 containerCost 375` vs catalog $174.72 → +$125 surcharge on a 200-LF Termidor job; Bifen/Talstar 96 oz vs 128 oz · fix: link the trenching table to the catalog like pre-slab · owner: none.
- **MAT-002** bed-bug material literal $220.53/500 g vs catalog $163.56 (35% over; $50.42/room allowance) · fix: link.
- **MAT-003** termite station cost drift (code $22.05 vs supplier $24.00/station from the $384 16-ct box, owner 2026-09-02; replacement cartridges $6.70–$10.70 each in no pricer — corrected from the first draft's "$384/16 cartridges"); `service_product_usage` spacing 10 ft vs pricing 15 ft (label up to 20, 10–15 recommended).
- **INV-001** catalog completeness (§6.1) · fix: costing-unit backfill for the ~40 products that any pricer or protocol names; `needs_pricing` sweep.
- **INV-002** `service_product_usage` keyed by display names; `packets` unit → $0; 6 products without cost · fix: re-key by `service_key`, add carrier column, reject unknown units.
- **INV-003** `job_costs.products_cost` unit error (lawn $5,943/visit) and unfiltered cheapest-vendor fallback (`job-costing.js:285-296`) · fix: use `products_catalog.cost_per_unit` only, skip with a flag.
- **INV-004** pre-slab inventory link fails open silently (`db-bridge.js:792-810`) · fix: stamp `materialCostSource` on the line.
- **PRO-001/002/003** (§7.2).
- **EQP-001** (§8).
- **CAT-001** catalog sells cadences the engine cannot price: `pest_general_semiannual` → quarterly silently (`normalizePestFrequency`), `lawn_care_quarterly` → 9x (`resolveLawnTier`) · fix: hide rows or add pricers; reject unknown cadence at the boundary · owner: are they sold?
- **CAT-002** 15 active quote-selectable catalog rows have no pricer (fire_ant, tick_control, mud_dauber_removal, wildlife_trapping, termite_liquid, termite_pretreatment, rodent_general_one_time, palm_injection_semiannual, termite_active_*, termite_monitoring, trap-only retainers, termite_installation_setup, termite_cartridge_replacement) · fix: map, price, or mark non-selectable.
- **CAT-003** engine keys with no catalog identity: 6 `commercial_*` + `termite_station_rental` + `rodent_plugging`/`flea_package`/bundle-discount lines → booked visits carry `service_id NULL`; one key → many rows (`one_time_lawn` ×2, `rodent_sanitation` ×4, `termite_bond` ×3) · fix: catalog rows + `engine_keys` admin-editable (`service-library.js:10-27` omits it).
- **CAT-004** taxonomy drift in operational records: 42 distinct `service_type` strings on completed visits, 21 match a catalog name, 0 a key; `job_costs`/reality-check group by string · fix: universal `service_key_snapshot` (219/434 today).
- **CAT-005** same customer string "Cockroach Treatment Service" for the $350 2-visit catalog contract and the $119–$249 engine fee (`v1-legacy-mapper.js:201`) · owner: which contract.
- **CFG-001** DB/code/docs drift: pest floor $79 (DB) vs $89 (code, POLICY, README); README mosquito $105/$90 vs live $77/$69; README "v1 curve live" vs v2; POLICY T&S 0.43 direct-cost vs 0.45 admin-inclusive; README +10% water vs ×1.2 multiplier; README/TERMITE doc Basic/Premier $35/$65 vs station brackets; `ts_material_rates.note` "9x retired" vs sold · fix: doc PR + constants sync (pricing-config skill step 1) · owner: is $79 intended?
- **CFG-002** orphan `pricing_config` rows no bridge key reads (`waveguard_qualifying`, `waveguard_caps`, `global_processing` "3% baked in", `pest_service_costs`) — misleading in the admin panel · fix: delete or wire.
- **INP-002/003/004/005/006** (§9.1–9.2).
- **AUD-001** no per-override user/timestamp/original price; revise replaces `estimate_data` wholesale (`admin-estimate-persistence.js:2473-2510`); `internalReason` never replayed · fix: `estimate_price_overrides` table or `activity_log` rows on every override.
- **AUD-004** public bearer routes (`bond`, `interior-service`, `preferences`, `select-tier`) mutate `monthly_total/annual_total` with blob arithmetic, no engine call, no activity log · fix: route through the opt-out recompute path.
- **AUD-005** no `pricing_config` hash/version on estimates; `pricing_config_audit` only for `PUT /:key`; `pricing_changelog` only via proposals/migrations · fix: stamp `configHash` in `pricingMetadata`.
- **DIS-001** FIXED manual discount uncapped (zeroes estimate) · fix: cap at e.g. 50% of discountable total unless owner-acknowledged.
- **CAD-001** label-first cadence parsing (§10).
- **CAD-002** tree & shrub 9x annual-prepay coverage cadence resolves `bimonthly` — 6 of 9 prepaid visits covered (§10).
- **AI-006** `LEAD_ESTIMATE_AUTO_SEND_ALLOWED_REVIEW_REASONS=property_measurements_defaulted` set in prod (gate off) · fix: unset.
- **TAX-001** (open from validation) commercial per-application quotes render pre-tax; completion invoices tax 7%.
- **MON-001** pricing audit snapshots' `estimated_cost` is not fully loaded (avg cost $36 on $617 revenue; margin 0.944; 114/324 have no cost) — the margin column is not credible · fix: compute from the engine `costs` + catalog.
- **MON-002** quoted-vs-actual labor has no cron or alert (`pricing-reality-check` on demand only); `pest_production_calibration_records` empty · fix: weekly digest to contact@ with per-service median vs modeled.
- **MON-003** DB pricing sync failure is `console.error` only (`db-bridge.js:1990`) · fix: `admin_alerts` row + Sentry.
- **SEC-004** lead webhook unauthenticated (honeypot + fail-open Turnstile) creates priced drafts · fix: shared secret; out of pricing scope, noted.

**P3**

- **LAB-003/004/005**, **PRO-004/005**, **EQP-002/003**, **CAT-006** (dead legacy pricers: wire mesh, bird box, exclusion v1, foam v2/stinging v2/plugging v2 parallel calculators), **AUD-002** (one-tap unstamped at insert), **AUD-003** (lookup retrieved-at not on the estimate), **UI-001** (residential PDF has no scope quantities), **AI-004/005**, **DOC-002** (`docs/TERMITE-PRICING.md` cites a non-existent `pricing-engine-v2.js`), **FEE-001** (`estimate-engine.js:2645-2647 cardProcessingFeeRate 0.029` orphan; surcharge undisclosed on PDF/invoice email), **RND-001** (T&S whole-dollar re-rounding `estimate-engine.js:943-946` moves monthly ±$0.04; recurring foam 4-stage cascade; manual acceptance reads un-re-anchored columns), **TAXF-001** (`services.is_taxable=true` on residential rows — ignored by `TaxCalculator`, misleading), **CAT-007** (`waveguard_membership` row labelled monthly with no monthly billing), **INV-005** (`vendor_pricing` 177/179 stale, 136 without a normalised unit price), **LAB-007** (bundles never share drive/setup — margins understated), **DOC-003** (`waveguard_qualifying` note "rodent NOT a qualifier" contradicts the 08-29 ruling).

---

## 14. Test and monitoring coverage (validated)

Existing: engine golden masters (`pricing-engine.regression`, v1 adapter, lawn golden master 60+), per-service unit tests (pest hardening/margin guard/production, mosquito, rodent revisions, termite measurements/monitoring/bond/rental, T&S v4.4, palm, bed bug, flea, one-time, dethatching, manual discount, db-bridge), route/persistence/converter/invoice/prepay/deposit/surcharge suites, client drift guards (esbuild parity for the fallback engine; `TS_OPTS` no longer exists). Gaps closed by this audit's `pricing-audit-golden-cases.test.js`: direct rodent-bait bracket/ladder assertions, WDO, German roach tiers, foam tiers + >20 fail-closed, top dressing 65% assumption, plugging, palm minimum/fail-closed, tier/discount matrix incl. palm credit cap, FIXED-discount zeroing, cadence identities, the palm property-vs-line and treeCount-0 behaviours (as *current-behaviour* pins that flip when fixed), and the four silent-input cases. Still uncovered: sanitation tiers, exclusion V2 ladder, trenching product surcharge (add when MAT-001 is fixed), commercial lines in a golden master, accept→invoice cents reconciliation on real rows.

Monitoring in prod (gates read 2026-09-02): `GATE_LAWN_PRICING_SWEEP=true` (Mon 06:30, bell), `GATE_PRICE_SCAN=true` (Mon 06:00, draft only), `GATE_LEAD_TO_CASH_SWEEP=true` (06:55, email), turf-variance digest + `estimate_actuals` nightly on; no labor reality-check cron; no bell for completion-without-invoice; no alert on DB-sync failure.

---

## 15. Recommended target model and remediation sequence

Target (configuration vs history vs operations kept distinct):

1. **Canonical service catalog** = `services` with `engine_keys` admin-editable, `pricing_unit`, `required_scope_fields`, `cadence` (interval + visits, no labels), commercial rows for `commercial_*`, one row per engine line key.
2. **Versioned protocols**: `protocol_templates` (already versioned/immutable) become the only protocol store; each has products with `rate`, `rate_unit`, `carrier_gal_per_1000`, `coverage_basis`, `application_method`, `expected_minutes`, `label_url`, `label_verified_at`, `max_annual`, `follow_up`. `protocols.json` prose becomes generated documentation.
3. **Normalised inventory cost**: `products_catalog.cost_per_unit/cost_unit` mandatory for any product a protocol names; `cost_effective_at`; `vendor_pricing.landed_unit_price`; a single `materialCostFor(productId, quantity, unit)` with `{source, staleDays}`.
4. **Equipment calibrations** field-verified per system; `carrier_gal_per_1000` feeds gallons = treated sqft ÷ 1,000 × carrier; product = gallons × rate/100 gal.
5. **Labor assumptions** as versioned rows (`labor_models`: service, cadence, base minutes, per-unit minutes, drive, setup, reporting, callback rate, effective date) seeded from measured medians and reviewed quarterly by the reality-check digest.
6. **Pricing rules** consume catalog + scope + protocol@version + material cost + calibration + labor model; each line stores the **cost breakdown** it was priced on (labor $, material $ by product, drive, admin, callback, equipment) — the engine already emits `costs`; make it complete and authoritative.
7. **One discount policy** (`discount-engine.js` already) with an explicit cap on manual FIXED; margin floors evaluated after discounts with per-service arm switches (report vs enforce).
8. **Fail closed** on missing critical cost/scope data (§field-requirements policy).
9. **Snapshot per estimate**: `pricingMetadata.configHash`, `protocolVersions[]`, `laborModelVersion`, `materialCostSources[]`; accepted rows stay reproducible without re-running today's config (the `sendSnapshot` + audit snapshot already freeze the price; add the inputs above).
10. **Actuals feed a variance report** (`estimate_actuals` + minutes + product movements) — never the price.
11. **Override ledger**: user, time, reason, original, overridden, resulting margin, per line.
12. **Customer surfaces explain scope**: sqft/counts/visits on the residential PDF and page (already partly on the page).

Sequence (risk × dependency):

| # | Work | Resolves | Depends on | Effort | Owner decision |
|---|---|---|---|---|---|
| 1 | Completion-without-amount bell + digest; per-application-fee admin writer; re-lane 3 monthly + the NULL-lane rows | BIL-001, BIL-002 | — | S | fee values, lanes |
| 2 | Admin translator: pass T&S `palmCount`/`access`/`tier` on the service line; blank tree count = absent; input bounds at `/calculate-estimate` (integer stories 1–4, sqft caps, ≥0 counts); reject unpriceable cadences | INP-001..006, CAT-001 | — | S | palm reserve semantics |
| 3 | Labor recalibration knobs (`on_site_minutes` per service/cadence in `pricing_config`) seeded from medians; reality-check weekly digest | MON-004 (was LAB-001), LAB-002/006, MON-002 | 1 quarter of clean minutes (already have) | S–M | accept observed basis; lawn reprice |
| 4 | Catalog link for every literal product cost (`materialCostFor`), stale/missing warnings on the line + audit snapshot; fix trenching table | MAT-001..003, INV-004, MON-001 | INV backfill for ~40 products | M | none |
| 5 | Inventory backfill sprint (costing units, rate units, `needs_pricing`), re-key `service_product_usage` by service key with carrier | INV-001/002/005 | — | M (data entry) | none |
| 6 | Config/doc sync + orphan row cleanup + `configHash` stamp + override ledger + sync-failure alert | CFG-001/002, AUD-001/005, MON-003 | — | S | pest floor value |
| 7 | Catalog identity: commercial rows, `engine_keys` admin-editable, retire duplicate/legacy rows and parallel v2 pricers, universal `service_key_snapshot` | CAT-002..007 | — | M | retire list |
| 8 | Protocol consolidation into versioned templates with expected minutes; equipment field verification; gallons → product quantities in the cost view | PRO-*, EQP-* | 4, 5 | L | protocol content |
| 9 | Margin policy re-arm per service (after 3) | MAR-001, DIS-001 | 3 | S | yes |
| 10 | Commercial tax copy, public blob-arithmetic routes → recompute, AI keyword tables | TAX-001, AUD-004, AI-* | — | S–M | copy |

---

## 16. Owner decision log (blocking)

1. **Pest per-visit floor**: production `pricing_config` says $79; code and both policy docs say $89. Which is intended?
2. **Labor basis**: adopt observed medians (pest 45, monthly pest 35, lawn 45, WDO 60, trapping 90 min) for the cost models and margin reporting? (Prices do not move; reported margins drop ~10–20 pts.)
3. **Lawn program**: 9x lists below the 35% floor by the engine's own model and ~7% at observed labor; Silver+ negative. Reprice the grid, change the cadence discount, re-arm the cost floor, or accept as a loss-leader?
4. **Margin floors**: keep report-only (2026-07-17 ruling) or re-arm per service after #2?
5. **Termite monitoring**: $19–$39/mo brackets vs a 5 min/station + drive cost model that is negative at every tier — loss-leader for the $610 install, or reprice? (Install labor is also unbilled by design.)
6. **Palms in tree & shrub**: price palms as generic trees (today's service-line fold: $4/yr + 1.5 min each), arm the routine palm reserve with real values, or keep palms out of T&S?
7. **Catalog rows to retire or price**: semiannual pest, quarterly lawn, termite liquid/pretreatment/monitoring/active/installation/cartridge, fire ant, tick, mud dauber, wildlife, rodent general one-time, palm semiannual, trap-only retainers (monthly plan vs never-monthly ruling).
8. **Billing lanes**: the 3 `monthly_membership` and 18 lane-less real customers; fee values for the 128 per-application customers without a fee.
9. **Initial vs maintenance**: should first lawn / T&S / mosquito visits carry a corrective uplift (material and time), as pest roach knockdown and flea packages do?
10. **Manual FIXED discount cap** (today a FIXED discount can zero an estimate).
11. **Commercial tax copy** on per-application quotes (TAX-001) and whether commercial lawn/T&S should stay untaxed.

Prior open rulings restated: in-flight legacy count-less termite links (monthly pin vs refuse), expired-prepay lane roll (DATA-002), tier hand-pick permanence (kept).

---

## 17. Scorecard

| Area | Score | Evidence | To reach 10 |
|---|---|---|---|
| Service-catalog integrity | 5 | 92 rows; 15 active selectable rows without a pricer; 8 engine keys without a row; one-key→many-rows ×3; name-based matching; 42 free-text visit types | every engine line key ↔ exactly one catalog row; `engine_keys` editable; cadence as interval+visits; no name parsing |
| Input completeness | 5 | palms/access/tier missing from the admin T&S path; shrub count absent; stinging inputs absent; blank→0 | field-requirements §0–16 met at the API boundary |
| Pricing-formula correctness | 8 | 1,247 independently compared scenarios (+41 engine-only observations), 0 price mismatches, 1 cadence mismatch (CAD-002); cadence identities hold; discounts exact | remove T&S double-round; cap FIXED discount; reject unpriceable cadences |
| Labor-model accuracy | 4 | minutes are assumed and cannot be validated (recorded minutes include drive, MON-004); WDO/trapping unmodeled; three minute models disagree (engine, protocol $26.96/visit, `/margin-check` fallbacks) | one versioned labor model seeded from clean on-site actuals, reviewed quarterly |
| Material-cost accuracy | 4 | literals; trenching 2.1×; bed bug 1.35×; only pre-slab linked | every product-driven service costed from the catalog with provenance |
| Inventory completeness | 3 | 173/192 without costing unit; 89 without rate unit; 43 not current; usage map by display name | ≥95% of protocol-named products complete and < 90 days old |
| Protocol linkage | 3 | prose + three rate representations; no service prices from a protocol; 14 services with none | versioned templates with rates/carrier/minutes feeding price |
| Equipment/calibration linkage | 2 | 3 calibrations, none verified, none read | field-verified per system; carrier volume drives quantities |
| Margin protection | 4 | floors report-only; lawn below floor at list; Platinum lawn 13% | post-discount floors evaluated on measured cost with per-service arm |
| Discount integrity | 8 | tier/perk/exclusions exact; setup fees protected; stacking documented | FIXED cap; override ledger |
| Residential/commercial coverage | 6 | commercial cost buildups for 6 lines; WDO/one-time/roach commercial → manual; no catalog identity; pre-tax display | commercial catalog rows; tax copy; interior/exterior knobs verified |
| Recurring-plan economics | 5 | identities hold; first-year vs renewal computed; lawn/termite negative on observed or modeled cost | every plan ≥ target after tier % on measured cost |
| UI pricing integrity | 5 | no numeric validation; silent defaults; warnings admin-only; no override audit | fail-closed inputs; assumptions visible; overrides logged |
| Estimate-to-invoice consistency | 7 | lock + converter + `invoiceAmountDue` + surcharge single source; 99/100 accepted have cost snapshots; manual acceptance reads columns | cents reconciliation test on real rows; manual acceptance uses the bundle |
| Auditability | 6 | authority stamps, send snapshot, audit snapshots, changelog; no config hash; no override user/time | config hash + override ledger + protocol/labor versions on every estimate |
| Test coverage | 7 | 320 pricing-adjacent suites + 979 new cases (961 formula-parity + 15 frozen literal prices + 3 frozen WaveGuard tier bundles) | commercial golden master; sanitation/exclusion/trenching; invoice cents |
| Monitoring | 5 | three sweeps on; actuals nightly; no labor alert; log-only leakage; silent sync failure | weekly labor variance digest; completion-without-invoice bell; sync-failure alert |
| Maintainability | 4 | 8,928-line pricer; 13 literal `35`s; parallel v1/v2/V2 pricers; orphan config rows; docs drift | one pricer per service, constants only in `constants.js`/DB, docs generated |

---

## Appendix A — how to re-run

```
# formulas + scenario matrix (in-code constants)
node scripts/audit-estimator-pricing.js --md /tmp/calc.md --json /tmp/calc.json
# same, overlaying the live pricing_config (read-only session; never DATABASE_URL)
AUDIT_DB_URL=postgres://<read-only role> node scripts/audit-estimator-pricing.js --db --md /tmp/calc-db.md
# data quality (read-only aggregates)
AUDIT_DB_URL=postgres://<read-only role> node scripts/audit-pricing-data-quality.js --md /tmp/dq.md --since 2026-06-01
# golden / boundary / invariant tests
cd server && npx jest tests/pricing-audit-golden-cases.test.js
```

## Appendix B — UNKNOWNs and the exact query or measurement that resolves each

| Unknown | Why | Resolution |
|---|---|---|
| Per-service actual minutes for mosquito, T&S, termite, rodent bait | too few completed visits with minutes since 06-01 (n < 3) | keep recording `time_on_site_adjusted_minutes`; re-run `visit_actual_minutes` after one more quarter |
| Actual product usage per visit | `product_inventory_movements` is empty on the visits sampled (`job_costs.products_used` unit errors) | require the tech `/complete` product ledger; then `select service_type, avg(cost_used) from product_inventory_movements group by 1` |
| Margin by property-size band / tier / bundle | visits do not carry sqft or plan identity | join `scheduled_services.source_estimate_id → estimate_data.engineInputs` once `service_key_snapshot` is universal |
| Label-verified rates for the 19 unverified products | no `label_verified_at` | verify against the current label; store `label_url` + revision |
| Landed cost / shipping / tax on vendor rows | not sampled | `select count(*) filter (where landed_cost is not null) from vendor_pricing` |
| How many admin T&S estimates carried palms (INP-001 exposure) | not sampled | `select count(*) from estimates where estimate_data->'engineRequest'->'profile'->>'palmCount' > '0' and estimate_data::text like '%tree_shrub%'` |
| Accept → invoice cents reconciliation on real rows | needs line-item text, which this audit did not read | replay `resolveRecurringFirstVisitAmount` per accepted row against the first invoice `line_items` |
| Reconciliation of `LAWN_MATERIAL_BUDGETS` to today's catalog | manual script not run | `node server/scripts/audit-waveguard-protocol-material-costs.js` |

## Appendix C — files inspected (primary)

`server/services/pricing-engine/{constants,estimate-engine,service-pricing,discount-engine,db-bridge,property-calculator,modifiers,unit-band-pricing,commercial-helpers,commercial-risk-type,v1-legacy-mapper,public-ranges,README}.js|md`; `server/services/{admin-estimate-persistence,estimate-converter,estimate-manual-acceptance,estimate-deposits,estimate-pricing-audit,estimate-actuals,pricing-reality-check,job-costing,product-costing,inventory-units,price-sync,protocol-matcher,protocol-reader,waveguard-plan-engine,lawn-protocol-operating-layer,tax-calculator,invoice,invoice-prepay,annual-prepay-renewals,billing-cadence,billing-lane,billing-cron,stripe-pricing,lead-estimate-automation,lead-estimate-auto-send,customer-pricing-ai,sms-service-intent,estimator-engine/*,intelligence-bar/estimate-tools,service-library,service-catalog-names,slot-reservation,recurring-appointment-seeder}.js`; `server/routes/{estimate-public,admin-estimates,property-lookup-v2,public-quote,admin-pricing-config,admin-dispatch,admin-protocols,admin-inventory,admin-equipment-systems,lead-webhook}.js`; `packages/lawn-cost-floor/index.js`; `client/src/pages/admin/EstimateToolViewV2.jsx`, `client/src/pages/EstimateViewPage.jsx`, `client/src/lib/estimateEngine.js`; `server/models/migrations/*` (services, pricing_config, products, protocols, equipment, calibrations, job_costs, estimate audit snapshots, billing lanes); `docs/pricing/POLICY.md`, `docs/SERVICE_LIBRARY_MAPPING.md`, `docs/DISCOUNT_LIBRARY_MAPPING.md`, `docs/TERMITE-PRICING.md`, `docs/audits/estimator-pricing-engine-audit-validation-2026-09-01.md`, `AGENTS.md`, `CLAUDE.md`.
