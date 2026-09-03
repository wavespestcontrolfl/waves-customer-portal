# Estimator pricing — field requirements per service

Companion to `docs/estimator-pricing-audit.md` (evidence) and `docs/estimator-pricing-service-matrix.md` (one row per service). Audit baseline: `origin/main` @ `66ecc95dc`, production data read-only on 2026-09-02.

For every priced service this page lists what the price actually needs, where that value comes from today, and what happens when it is missing. "Required" means the formula reads it; "collected" means an entry point supplies it. The gap between the two columns is the remediation backlog.

Conventions: **UI-A** = admin builder (`client/src/pages/admin/EstimateToolViewV2.jsx` → `POST /api/admin/estimator/calculate-estimate` → `translateV2CallToV1Input` in `server/routes/property-lookup-v2.js`); **UI-P** = website quote (`server/routes/public-quote.js`); **AI** = estimator engine composer (`server/services/estimator-engine/intent-schema.js`); **LEAD** = lead-webhook keyword builder (`server/services/lead-estimate-automation.js`). Line references are to the engine files under `server/services/pricing-engine/`.

---

## 0. Cross-cutting requirements (every service)

| Requirement | Today | Missing-data behaviour today | Required behaviour |
|---|---|---|---|
| Loaded labor rate | `GLOBAL.LABOR_RATE` $35 (`constants.js:21`), DB-overridable `pricing_config.global_labor_rate` | n/a | keep DB-authoritative; version it with an effective date |
| Drive minutes per visit | `GLOBAL.DRIVE_TIME` 20 (`constants.js:22`); lawn uses `routeDensityMinutes.DENSE` 5 (`constants.js:321-326`) | n/a | one definition, or an explicit reason lawn differs |
| Admin overhead | `GLOBAL.ADMIN_ANNUAL` $51/service/yr; commercial $120 | n/a | keep |
| Callback reserve | lawn $2/visit; commercial $3/visit; residential T&S/pest/mosquito/rodent 0 (`constants.js:308,631,657`) | n/a | seed pest with the observed 2.6% callback rate × (28 min + drive) ≈ $0.75/visit, report-only |
| Card processing | 2.9% credit-only surcharge at checkout (`server/services/stripe-pricing.js:24`), never in the engine price | n/a | include in contribution-margin reporting only |
| Margin floor | `GLOBAL.MARGIN_FLOOR` 0.35, **report-only** since the 2026-07-17 owner ruling (`discount-engine.js applyMarginGuard`) | below-floor lines are flagged, never lifted | owner decision: keep report-only or re-arm per service |
| Inventory cost per product | `products_catalog.best_price` / `cost_per_unit` (173 of 192 active products have no `cost_per_unit`) | pre-slab only: fail-open to constants (`db-bridge.js:762-811`); every other service uses literals | every product-driven service reads the catalog; missing cost → warning on the line, never silent $0 |
| Protocol version | `server/config/protocols.json` (prose) + `lawn_protocols` rows; never stamped on an estimate | n/a | stamp `protocolKey@version` on each line |
| Equipment calibration | `equipment_calibrations.carrier_gal_per_1000` (3 rows, all `estimated_not_field_verified`) | never read by pricing | field-verify, then feed material quantities |
| Override audit | manual discount `internalReason` (required for custom presets only); no user id, no timestamp, no original price on the estimate row | n/a | `overridden_by`, `overridden_at`, `original_price`, `override_reason` per line |
| Pricing snapshot | `estimate_data.sendSnapshot.pricingBundle` (send) + `pricing_authority`/`price_locked_at` (accept) + `estimate_pricing_audit_snapshots` | no `pricing_config` hash/version on the row | stamp a config hash / `pricing_config_version` at price time |

---

## 1. Pest control — recurring (`pest_control`)

| Field | Required by formula | Collected by | Validation today | Missing-data behaviour | Required behaviour |
|---|---|---|---|---|---|
| Structure sq ft (living area) | yes → footprint = round(sqft ÷ stories) (`property-calculator.js calculateFootprint`) | UI-A, UI-P (clamped 500..20,000), AI (county/caller), LEAD (default **2,000**) | UI-A: none (blank → 0 → default 2,000 footprint via `resolvePestFootprint`); UI-P clamps | 2,000 sf silently unless LEAD (review flag `property_measurements_defaulted`) | fail closed on blank/≤0/non-integer at every entry point; huge values (>20,000 residential) → review |
| Stories | yes (footprint divisor) | UI-A (HTML min/max only), UI-P (1–3), AI (`storiesSource`) | UI-A accepts −3 and 2.7 (audit run: 2.7 → footprint 741, no flag) | defaults to 1 | integer 1–4; anything else rejected |
| Pool / cage / cage size | yes (+$5…+$18) | UI-A, UI-P, lookup vision | enum | defaults none | keep; surface `poolCageSizeInferred` |
| Shrub density | yes (−$5/0/+$6) | UI-A, lookup | enum | translator defaults **light** when absent (form default is moderate) | one default |
| Landscape complexity | yes (−$5/0/+$3) | UI-A, lookup | enum | translator defaults simple | one default |
| Near water | yes (+$3) | UI-A, lookup | boolean/level | none | keep |
| Attached garage / indoor | yes (+$5 / +$15) | UI-A | boolean | none | keep |
| Property type | yes (−$8…−$22) | UI-A, UI-P, AI, LEAD | whitelist → `single_family` for unknown strings (`property-lookup-v2.js:3790-3801`) | unknown → single-family silently (unit-scope gate marks `unknown` on the LEAD path only) | unknown → review |
| Frequency | yes (×1.00/0.88/0.78, visits 4/6/12) | all | `normalizePestFrequency` maps unknown → quarterly with a warning | semiannual → quarterly silently (P2) | reject cadences the engine cannot price |
| Roach type | yes (fires `pest_initial_roach`) | UI-A, AI, LEAD (dropped) | enum | none | LEAD must carry roach identity (AI-002) |
| Inventory fields | none read | — | — | chemical cost is the literal `{talak 1.30, taurus 4.87, surfactant 0.50}` (`service-pricing.js:1425`) | read `products_catalog` for Talak / Taurus SC / Tekko Pro; warn when missing |
| Protocol fields | none read | — | — | — | link `pest` protocol version |
| Labor assumption | 25 min on-site (20 monthly) + 20 drive, report-only (`service-pricing.js:1427`) | — | — | — | recalibrate to observed median 44 min (p75 63) or document why the model differs |

## 2. One-time pest (`one_time_pest`)

Same property fields as §1 (the price is `max($199, round(quarterly base × 2.2)) × urgency`). Additional: `urgency` (NONE/SOON/URGENT), `afterHours`, `recurringCustomer` (15% perk, re-floored, then the strict "> quarterly base + $99" clamp). Missing property data → the quarterly baseline's defaults apply silently (same P2 as §1). Commercial → manual quote line.

## 3. Lawn care — recurring (`lawn_care`) and one-time (`one_time_lawn`)

| Field | Required | Collected by | Validation today | Missing-data behaviour | Required behaviour |
|---|---|---|---|---|---|
| Treatable lawn sq ft | yes — bracket lookup (`lookupLawnBracket`) | UI-A (`measuredTurfSf`, number + slider; `TURF_CONFIRMATION_REQUIRED` 400 when a whole-lawn service has no manual turf), UI-P (lot-derived), AI/LEAD (lot × 0.68 fallback, `turfBasis: lotFallback`, LOW confidence) | UI-A: negative → dropped silently to the AI/lot estimate; 0 accepted and priced (audit run: 0 sf → $45.33/app, no flag) | lot-derived turf with `FIELD_VERIFY_TURF_SQFT` (review) | 0/negative fail closed; lot-derived turf always parks (it does on the LEAD path) |
| Grass track | yes (4 bracket tables) | UI-A, AI, LEAD (default st_augustine) | unknown string → st_augustine + `unknown_grass_type_priced_st_augustine` | default track | keep; require on UI-A |
| Cadence (6/9/12) | yes | UI-A (menu no longer offers 4), AI (`tier`), LEAD (default enhanced 9x) | `lawnFreq=4` / `tier=basic` → **enhanced 9x silently** (`resolveLawnTier`) | 9x default | reject 4x or add a 4x column (catalog still sells `lawn_care_quarterly`) |
| Bermuda suppression | optional adder (+$15 + $2/1,000 sf per app) | UI-A (st_augustine only; gate on in prod) | fail-closed when the gate or knobs are invalid | — | keep |
| Route density | cost model only | — | — | DENSE (5 min) | expose as a knob or measure |
| Inventory fields | none read | — | — | `LAWN_MATERIAL_BUDGETS` hand-derived (`packages/lawn-cost-floor/index.js:54-59`) | derive budgets from `lawn_protocol_products` × catalog cost per window, automatically |
| Protocol fields | `lawn_protocols.default_carriers`, `lawn_protocol_products.rate_per_1000/carrier_gal_per_1000` exist but are not read at price time | — | — | — | read them |
| Equipment | `equipment_calibrations` not read | — | — | — | carrier volume × treated sqft → gallons → material |
| Labor assumption | 12 + 2.5 min/1,000 sf + 5 drive (`constants.js:309-326`), report-only; a dead `$26.96/visit` literal also lives in `service-pricing.js:2113` | — | — | — | recalibrate to observed 44 min median (9x, n=17) |

One-time lawn additionally needs `treatmentType` (fert/weed/pest/fungicide multipliers) and inherits the recurring per-app; floor $115.

## 4. Tree & Shrub (`tree_shrub`) — palms audited separately

| Field | Required | Collected by | Validation today | Missing-data behaviour | Required behaviour |
|---|---|---|---|---|---|
| Ornamental bed sq ft | yes (material $0.055/sf; labor bed/500 min) | UI-A (`bedArea` → sent as `estimatedBedAreaSf`, stamped `bedAreaSource: estimated` even when hand-measured), UI-P/AI (lot × density %), lookup vision | no clamp (owner ruling 2026-08-10); ≥ 8,000 → review | lot-based estimate (`medium` confidence, not parked); no lot → 2,000 fallback + review | a typed bed area must be `explicit`; lot-based must carry a review reason |
| **Non-palm tree count** | yes (1.5 min/tree; $4/tree/yr) | UI-A (`treeCount`), UI-P, AI (`treeCount` 1–200), lookup vision | UI-A: blank → explicit **0** (suppresses the density fallback; audit run: $45.25/mo vs $58.75/mo with density estimate), negative accepted | density fallback {light 3, moderate 6, heavy 10} only when truly absent | blank must be absent, not 0; require ≥0 integer |
| **Palm count** | yes when armed; today folds into per-tree terms **only when supplied on the service line** (`service-pricing.js:2745-2770`) | UI-P and AI send `services.treeShrub.palmCount` (priced); **UI-A sends `profile.palmCount` (property level) → $0 effect** (audit run: 30 palms $53.08/mo vs $95.17/mo) | UI-A guards 1–200 when a T&S line is selected | property-level palms ignored silently (P1) | translator passes `palmCount` on the service line; engine treats property palms as a source when no line value |
| Palm size / height / method | not modeled in T&S (only in `palm_injection`) | — | — | — | owner decision: add palm size to the routine reserve when armed |
| Shrub count / shrub size | **not modeled** (density enum only) | — | — | — | owner decision |
| Access difficulty | yes (0/8/15 min) | UI-P/AI (`access`); **UI-A does not collect it** (translator sends `{tier:'standard'}` only) | enum | easy | add to UI-A |
| Tier (4/6/9) | yes | UI-P/AI; **UI-A hardcodes standard** | enum | standard | add to UI-A |
| Initial vs maintenance | not modeled (no corrective/initial visit) | — | — | — | owner decision |
| Inventory | none read (June-2026 catalog prices baked into `materialModel`) | — | — | — | re-derive from catalog |
| Protocol | `protocols.json` T&S (6 visits); pricing sells 4/6/9 | — | — | — | align protocol cadence with sold cadence |

## 5. Palm injection (`palm_injection`)

Required (fail-closed in the engine): `treatmentType` (nutrition / insecticide / combo / fungal / lethalBronzing / treeAge), `palmCount` positive integer (1–200), `palmSize` (small/medium/large) for tiered types, `dbhInches` for Tree-Age, `diagnosisConfirmed` + `selectedProduct` for fungal, `palmStatus` for lethal bronzing, `customPricePerPalm` when a quote flag is set. UI-A collects all of these; AI allows nutrition only; the customer pricing AI defaults `combo` + `medium` size (P2). **Not modeled:** dose per palm size, injection plugs, minutes per palm (price is a flat $/palm with a $75 visit minimum). Missing palm count → engine throws (correct).

## 6. Mosquito (`mosquito`, `one_time_mosquito`)

| Field | Required | Collected by | Validation | Missing-data behaviour | Required behaviour |
|---|---|---|---|---|---|
| Lot sq ft | yes → treatable = lot − footprint − hardscape estimate (`constants.js HARDSCAPE`) | all | UI-P clamps; UI-A none | no lot → ACRE bucket (fail-expensive) + review | keep fail-expensive; add lot validation on UI-A |
| Footprint (from structure sqft/stories) | yes | all | see §1 | 2,000 default | fail closed |
| Pool/cage, trees, complexity, irrigation, water level | pressure factors (+5…+15%) and graduated water multiplier ×1.02–1.35 | UI-A, lookup | enum | none | docs say +10% nearWater; engine uses ×1.20 for CLOSE — fix docs |
| Program (seasonal9 / monthly12) | yes | UI-A, AI (required), LEAD (default monthly12) | alias map | recommendation by pressure | keep |
| Stations / dunks | optional add-ons ($39 / $4 per year recurring; $75 / $15 one-time) | UI-A | ≥0 integers | 0 | keep |
| Inventory | none read (Bifen I/T $41.08/gal, Tekko Pro $52.97/16 oz literals equal the catalog today) | — | — | — | read catalog |
| Equipment | mist-blower assumption in comments only | — | — | — | calibration record |
| Labor | 30 min + 20 drive report-only | — | — | — | measure |

## 7. Termite bait (`termite_bait`) + riders (`termite_bond`, `termite_station_rental`)

| Field | Required | Collected by | Validation | Missing-data behaviour | Required behaviour |
|---|---|---|---|---|---|
| Footprint sq ft or perimeter LF | yes → stations = max(8, ceil(perimeter ÷ 15 ft)) | UI-A (`termiteFootprintSqFt` / `termitePerimeterLF` override), lookup | positive numbers | quote required (`from` price = 8-station rate) | keep |
| Layout complexity | perimeter × 1.25 / 1.35 | UI-A | enum | standard | keep |
| Stories source | review flag only | lookup | — | — | keep |
| Ownership (own / rent) | install $ vs rental uplift | UI-A (gated) | literal 'rent' | own | keep |
| Bond term | rider $60/$54/$45 per application | UI-A (gated) | enum | none | keep |
| Inventory | station cost $22.05 literal; catalog Trelona row is $24 and flagged stale/needs_pricing | — | — | — | link station and cartridge cost to the catalog |
| Labor | install 5 min/station computed but excluded from the billed base (`service-pricing.js:4772-4774`); monitoring 5 min/station report-only | — | — | — | owner decision on whether install labor is priced |

## 8. Rodent (`rodent_bait`, `rodent_trapping`, exclusion, sanitation, guarantee)

| Service | Required inputs | Collected by | Missing-data behaviour | Required behaviour |
|---|---|---|---|---|
| Rodent bait | footprint (bracket); **station count is derived, never entered** | UI-A, UI-P, AI, LEAD | missing/zero/negative footprint → 2,500 sf bracket silently (P2) | fail closed on missing footprint |
| Rodent trapping | homeSqFt, lot, pressure, emergency flag; **trap count not entered**; follow-ups unlimited and unpriced | UI-A, UI-P | none | add a callback reserve to the cost view |
| Exclusion (V2) | entry-point counts by type (standard/roof mesh; bird boxes), mesh LF by substrate, roof type, stories, waive-inspection | UI-A | V2 branch fires only when any count > 0; legacy wire-mesh/bird-box services unreachable from UI-A | keep V2; retire the two legacy pricers |
| Sanitation | tier, affected sq ft (blank → literal 0 → footprint fallback residential; commercial → manual quote), debris cu ft, access | UI-A | 0 accepted | require sq ft |
| Guarantee | home size, stories, sealed points, 4 completion attestations (fail-closed) | UI-A | throws when unmet | keep |
| Inspection | none ($75 flat, creditable 14 days) | UI-P only | — | add to UI-A |

## 9. WDO inspection (`wdo_inspection`)

No required input (flat $250; footprint only feeds review flags). Commercial → manual quote line. Observed on-site 60 min (n=9): at $35/hr + 20 drive ≈ $47 labor per $250 inspection (reported nowhere). Required: none; recommended: stamp expected minutes for the reality-check tool.

## 10. Termite treatments (`trenching`, `pre_slab_termiticide`, `bora_care`, `foam_drill`, `foam_recurring`)

| Service | Required inputs | Inventory today | Required behaviour |
|---|---|---|---|
| Trenching | measured perimeter LF (or concrete/dirt LF), concrete %, product, application rate, depth, warranty tier, label confirmed | container costs are literals — Termidor SC $375/78 oz vs catalog $174.72 (surcharge over-charge ≈ $125 on 200 LF); Bifen/Talstar sizes wrong (96 oz) | link to catalog like pre-slab |
| Pre-slab | slab sq ft, product, job context, warranty, volume tier, label confirmed | **linked** (`db-bridge.js syncPreSlabContainerCostsFromCatalog`, approved vendor price, ±2× sanity band, fail-open) | make fail-open visible on the line |
| Bora-Care | attic/raw-wood sq ft or surface LF × height | $91.98/gal literal (= catalog today) | link |
| Foam drill | drill points (select 5/10/15/20; >20 fails closed) | $39.08/can literal (= catalog today) | link |
| Recurring foam | points + cadence | same | link |

## 11. German roach / cockroach (`german_roach`, `pest_initial_roach`)

German roach cleanout requires `severity` (light/moderate/heavy; severe → heavy). Missing severity defaults to LIGHT with a `severityWasDefaulted` flag but no review (P2) — require it. `pest_initial_roach` needs footprint + roach type; the fee override has no reason/user/timestamp.

## 12. Bed bug (`bed_bug`)

Required (engine throws otherwise): rooms (positive integer), method (CHEMICAL/HEAT/HYBRID), severity, prepStatus, occupancyType; heat/hybrid also need equipment (INHOUSE/SUBCONTRACT), heatScope, and `subcontractCost` when subcontracted; whole-home heat needs footprint. Material $50.42/room is a literal derived from a $220.53 container price; the catalog lists Alpine WSG at $163.56 → link and re-derive. Label verification is flagged in constants (`labelVerificationRequired: true`).

## 13. Flea (`flea`)

Required: offer key (single vs 2-visit package), `fleaComplexity` (light/moderate/heavy), footprint; optional exterior area + source (unknown/AI source → review). LEAD defaults complexity to light (cheapest). Require complexity on every entry point.

## 14. Stinging insects (`stinging`)

Required: species, tier (1–3), removal option; optional aggressiveness/height/confined. **UI-A collects none of them** — every admin wasp quote is a tier-2 paper wasp with no removal (`property-lookup-v2.js:4232-4241`). Add the fields to the builder.

## 15. Lawn specialty (`plugging`, `top_dressing`, `dethatching`)

- Plugging: plug area (blank → **whole lawn**, e.g. 4,500 sf → $10,995) and spacing → require an explicit area.
- Top dressing: area (blank → 65% of lawn when no recurring lawn; show the assumption), depth.
- Dethatching: lawn sq ft, grass type (St. Augustine needs manager approval), cleanup level, access, thatch probes (raw strings pass through by design).

## 16. Commercial (`commercial_*`)

Required: building sq ft (footprint; unknown → quote required for pest/termite/rodent), measured turf (lawn), bed area + tree count (T&S), lot (mosquito always prices), risk type (cadence bucket), interior on/off (pest), cadence overrides. All commercial lines are 45%-margin cost buildups on literals with $120 admin; none has a catalog row; per-application quotes render pre-tax while completion invoices tax pest/mosquito/termite/rodent at 7% (TAX-001).

---

## Recommended missing-data policy (one rule, every service)

1. **Required scope missing or invalid (blank, 0, negative, non-integer count):** fail closed — no price, line marked `quote_required` with the field named. Applies at the API boundary, not only in the browser.
2. **Scope inferred (lot-derived turf/bed area, density-estimated tree count, synthetic 2,000/8,000 defaults, AI-extracted counts below the confidence floor):** price, but stamp `inferred` + a review reason on the line; the send gate refuses auto-send while any such reason exists (today true on the LEAD path only; the `LEAD_ESTIMATE_AUTO_SEND_ALLOWED_REVIEW_REASONS=property_measurements_defaulted` value set in production would re-open this if `GATE_LEAD_ESTIMATE_AUTO_SEND` were turned on).
3. **Cost data missing (no catalog price, stale > 90 days, unverified label):** price on the last known cost with a `cost_stale` warning on the line and in the pricing audit snapshot; never silent $0 (today `product-costing.js` returns `cost: 0` with a warning string that no pricing surface shows).
4. **Protocol missing:** the service prices only if it has a protocol key; otherwise `quote_required`.
