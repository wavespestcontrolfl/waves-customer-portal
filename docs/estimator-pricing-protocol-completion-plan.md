# Protocol completion plan — every service line that bills

Requested 2026-09-02 as an addendum to `docs/estimator-pricing-audit.md` (§7): "complete all protocols, for every service line that bills". This document is the inventory and the plan. It does **not** author protocol content — product rates, carrier volumes, re-entry intervals and application times must come from current product labels and from the owner/technician; the audit rule is that no pesticide rate is invented or overwritten. Every cell marked **UNKNOWN** is a blank the owner fills (or a label lookup), not a guess.

Sources: `server/config/protocols.json` (prose protocols, 9 top-level keys), `lawn_protocols` / `lawn_protocol_windows` / `lawn_protocol_products` (structured lawn operating layer, 4 protocols / 48 windows / 141 product rows), `protocol_templates` (1 active deterministic template, 3 product rows without rates), `service_product_usage` (32 rows, display-name keyed), `products_catalog` (192 active; 173 without a costing unit), production invoice lines and completed visits (read-only aggregates, 2026-01-01 → 2026-09-02).

## 1. Which service lines bill

Ranked by invoice lines since 2026-01-01 (aggregate) with completed visits since 2026-06-01 in parentheses:

| Billing line (invoice description / visit type) | Invoice lines · $ | Visits since Jun | Engine key | Catalog key | Protocol today |
|---|---|---|---|---|---|
| Quarterly Pest Control Service (+ legacy names "Pest Control Service", "Quarterly Pest Control", "Pest Control", "General Pest Control") | 115 · $14,853 (+ prepaid variants) | 99 + 39 + 26 + 20 + 8 | `pest_control` | `pest_general_quarterly` | `protocols.json.pest` — 6 visits, products named in prose, **no rates, no carrier, no time** |
| WaveGuard Membership setup / 12-months prepaid / membership | 28 · $2,772 / 24 · $11,487 / 14 · $1,386 | — | setup fee / prepay construct | `waveguard_initial_setup`, `waveguard_membership` | n/a (billing construct) |
| First service application | 28 · $2,876 | — | per-application slice | — | inherits the plan's protocol |
| One-Time Pest Control Service | 17 · $3,395 | 9 | `one_time_pest` | `one_time_pest_control` | shares `pest` (no one-time variant) |
| Every 6 Weeks Lawn Care Service (9x) | 16 · $1,138 (+1 prepaid) | 20 | `lawn_care` enhanced | `lawn_care_6week` | `lawn_protocols` (structured, 12 windows/track, rates + carrier) ✔ + `protocols.json.lawn` |
| Monthly Lawn Care Service (12x) / Lawn Care Visit / Lawn Care | 2 · $126 | 8 + 7 + 5 | `lawn_care` premium | `lawn_care_monthly` | same |
| Rodent Trapping Service / Rodent Control | 13 · $4,450 | 7 + 3 | `rodent_trapping` | `rodent_trapping` | `protocols.json.rodent` — 4 visits, **no products, no rates** |
| WDO Inspection Service | 6 · $1,325 | 9 | `wdo_inspection` | `wdo_inspection` | **none** (inspection checklist only in closeout requirements) |
| Slab Pre-Treat Termite Service / Pre-Slab Termidor | 4 · $1,437 | 1 + 1 | `pre_slab_termiticide` | `termite_slab_pretreat` | `protocols.json.termite` (prose) + pricing constants carry oz/10 sf and label-confirmation flags |
| Monthly Pest Control Service | 4 · $293 | 7 | `pest_control` monthly | `pest_general_monthly` | `pest` |
| Cockroach Treatment / Cockroach Control Service | — (booked from calls) | 8 + 1 | `pest_initial_roach` / `german_roach` | `cockroach_control`, `german_roach` | `protocols.json.cockroach` — 3 visits, products named, **no rates** |
| Bee / Wasp Nest Removal Service | 3 · $700 | 1 | `stinging` / `wasp` | `bee_wasp_removal` | **none** |
| Bi-Monthly Pest Control Service | 2 · $216 | 2 + 1 | `pest_control` bimonthly | `pest_general_bimonthly` | `pest` |
| Semiannual Pest Control Service | 2 · $257 | 1 | **none (engine reprices as quarterly)** | `pest_general_semiannual` | `pest` |
| Termite Pretreatment Service | 2 · $514 | 2 | none (duplicate of pre-slab) | `termite_pretreatment` | `termite` |
| Rodent Exclusion Service / Rodent Trapping, Exclusion & Sanitation Service / Rodent Exclusion & Trapping | 1 · $125 / 1 · $500 | 0–1 | `rodent_exclusion` / bundles | `rodent_exclusion_only`, bundles | `rodent` (no exclusion/sanitation steps) |
| Rodent Inspection Service | 1 · $75 | — | `rodent_inspection` | `rodent_inspection` | **none** |
| Flea Control Service | 1 · $200 | 2 | `flea` | `flea_tick` | **none** |
| Termite Liquid Treatment Service | 1 · $1,055 | — | none (trenching is the priced liquid barrier) | `termite_liquid` | `termite` (prose) |
| Termite Spot Treatment Service / Termite | 1 · $224 | 1 + 1 | `termite_foam` / `foam_drill` | `termite_spot_treatment`, `foam_drill` | `termite` |
| Quarterly Rodent Bait Station Service | 1 · $30 | — | `rodent_bait` | `rodent_bait_quarterly` | `rodent` (bait visits: 4, no products) |
| Initial German Roach Knockdown Service | 1 · $100 | — | `german_roach_initial` | archived row | `cockroach` |
| Mosquito Barrier Treatment / Monthly Mosquito Control Service | — | 1 + 1 | `mosquito` | `mosquito_monthly`, `mosquito_seasonal` | `protocols.json.mosquito` — 3 visits, **no products/rates** (pricing constants carry usage) |
| Bi-Monthly Tree & Shrub Care Service | — | 0 (1 all-time) | `tree_shrub` | `tree_shrub_program` | `protocols.json.tree_shrub` — 12 visit types, products, rates per 100 gal, calibration formulas ✔ (6-visit program; 9x sold) |
| Palm Injection Service | — | 0 | `palm_injection` | `palm_injection` | `protocols.json.palm_injection` — products named, **no dose by size** |
| Bed Bug Treatment Service | — | 0 | `bed_bug` | `bed_bug_treatment` | `protocols.json.bed_bug` — products named (IGR disabled until label verified), **no rates** |
| Pest Control Re-Service / Lawn Care Re-Service | $0 lines | 7 + 1 | callbacks | `pest_re_service`, `lawn_re_service` | inherits |

Lines that are catalog rows but have not billed in 2026 and are not in `protocols.json` at all: dethatching, plugging, top dressing, fire ant, tick control, mud dauber, wildlife trapping, trenching (priced, prose only), Bora-Care (priced, prose only), recurring foam, termite bond/rental (riders), trap-only retainers, rodent guarantee, sanitation tiers, wire mesh / bird box.

## 2. Required protocol fields (the completion template)

Every billing line needs one **versioned** protocol record with these fields (the audit brief's list, §10). Column "Where it will live" is the target model from the audit report §15 (`protocol_templates` + `protocol_template_products`, extended):

| # | Field | Type / unit | Today | Where it will live |
|---|---|---|---|---|
| 1 | `service_key` (catalog) + `engine_key` | text | `protocol_template_service_types.service_type` (name string) | template row, keyed by `services.service_key` |
| 2 | Target pest / disease / weed / condition | list | prose `notes` | `target` jsonb |
| 3 | Treatment zones (exterior perimeter, interior, beds, turf, attic, slab, stations…) | list | `protocol_template_areas` (3 rows) | areas |
| 4 | Products (catalog `product_id`) | FK | `protocol_template_products.product_id` (3 rows) | products |
| 5 | Product rotation (by visit / season / MoA group) | ordered list | T&S `annual_rotation` prose | `rotation` jsonb |
| 6 | Application method (broadcast, spot, foliar, soil drench, granular, injection, foam, trench, bait) | enum | `application_method` text | products.application_method |
| 7 | Application rate + unit + basis (per 1,000 sf / per 100 gal / per station / per palm / per LF / per room) | numeric + enum | `rate`, `rate_unit` (NULL on all 3 template rows); lawn rows carry it | products.rate / rate_unit / rate_basis |
| 8 | Carrier volume (gal per 1,000 sf or gal per 100 gal mix) | numeric | lawn rows (`carrier_gal_per_1000`) only | products.carrier_gal_per_1000 |
| 9 | Coverage basis (which measurement the rate multiplies: treatable turf, bed area, footprint, perimeter LF, stations, palms, rooms) | enum | implicit per pricer | template.coverage_basis |
| 10 | Batch size (gallons per tank / backpack) | numeric | equipment_systems.tank_capacity_gal (110 / 4) | template.batch_size_gal |
| 11 | Equipment (system id) | FK | none | template.equipment_system_id |
| 12 | Labor steps + expected minutes (setup, mix, application, inspection, documentation, cleanup) | list + minutes | none (dethatching time model only) | template.labor_steps jsonb (feeds the labor model) |
| 13 | PPE | list | `products_catalog.ppe_required/ppe_text` | products (already) |
| 14 | Re-entry / drying restriction | hours | `products_catalog.rei_hours / reentry_text` | products (already) |
| 15 | Follow-up schedule (days, visit count) | numeric | flea/cockroach/bed bug visit counts in pricing | template.follow_up |
| 16 | Callback policy (included count / window) | text | rodent trapping "unlimited"; flea retreat window | template.callback_policy |
| 17 | Seasonal variation | by month/window | lawn windows ✔; T&S visit types ✔ | windows |
| 18 | Property-type variation (residential / commercial / condo / multifamily) | variants | none | template.variants |
| 19 | Label limitations (max rate, sites, turf species, tank-mix exclusions) | from label | `products_catalog.max_label_rate_per_1000`, `labeled_turf_species`, `do_not_tank_mix_with` | products (already) |
| 20 | Maximum annual application | numeric | `products_catalog.max_annual_per_1000` | products (already) |
| 21 | Material cost per application (derived: rate × coverage × catalog cost) | $ | prose `material_cost` (10,000-sf basis) | computed, not stored |
| 22 | Expected application time | minutes | none | from #12 |
| 23 | Label source + revision date + `label_verified_at/by` | text/date | `products_catalog.label_url / label_verified_at` (19 active products unverified) | products (already) |
| 24 | Version, effective dates, status | — | `protocol_templates` (immutable when active) ✔ | template |

## 3. Per-line gap inventory (what exists → what is UNKNOWN)

Legend: ✔ present as data · P present in prose only · — absent · UNKNOWN = owner/label input required.

| Line | 2 target | 3 zones | 4 products | 5 rotation | 6 method | 7 rate+unit | 8 carrier | 9 coverage basis | 10 batch | 11 equipment | 12 labor steps + minutes | 15 follow-up | 16 callback | 17 seasonal | 18 property variants | 21 material cost | 23 label verified |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Pest control (quarterly / bi-monthly / monthly) | P | P (exterior/interior) | P (Talak, Taurus SC, Tekko Pro, Temprid, Demand CS per the orphan `pest_service_costs` row) | P | P | **UNKNOWN** (oz per gal / per 1,000 sf per label) | **UNKNOWN** (gal per home) | footprint + perimeter (implicit) | 4 gal backpack / 110 gal | FlowZone / tank #1 (unverified) | **UNKNOWN** — observed 44 min median is the only measurement | n/a | 2.6% observed; policy UNKNOWN | P (6 visits) | condo/townhome adjustments in price only | literal $6.67 | Talak/Taurus/Tekko verified; Temprid/Demand CS UNKNOWN |
| One-time pest | shares pest | | | | | **UNKNOWN** (heavier initial rate?) | | | | | **UNKNOWN** (observed 36 min) | | | | | | |
| Lawn care (6/9/12) — 4 tracks | ✔ windows | ✔ | ✔ 141 rows (6 unlinked, 18 without rate) | ✔ by window | ✔ | ✔ (18 rows UNKNOWN) | ✔ (1/2/3 gal per 1,000 by role) | treatable turf | 110 gal | tank #2 lawn gun (unverified) | **UNKNOWN** (observed 44/37 min) | ✔ recheck dates | $2/visit reserve; policy UNKNOWN | ✔ 12 windows | commercial variant separate | derived by `audit-waveguard-protocol-material-costs.js` (run it) | mostly ✔ |
| Tree & shrub (4/6/9) | ✔ visit types | ✔ | ✔ (per 100 gal) | ✔ annual_rotation | ✔ foliar/soil/granular | ✔ per 100 gal (prose) | ✔ 110-gal / 2.5-gal formulas | bed area + tree/palm counts | 110 / 4 gal | tank #1 / FlowZone | **UNKNOWN** (engine: 20 + bed/500 + 1.5/tree + 10) | — | 0 reserve | ✔ | commercial variant | derived once (materialModel) | UNKNOWN per product |
| Mosquito (9/12) | P | P | — (pricing constants name Bifen I/T, Tekko Pro, Scion, In2Care, dunks) | — | P (mist blower) | **UNKNOWN** (constants: 0.5 oz/1,000 + 3 oz base; 1 oz Tekko) | **UNKNOWN** | treatable lot | 4 gal backpack / mist blower | **UNKNOWN** | **UNKNOWN** (30 min assumed) | — | UNKNOWN | P (3 visits) | commercial variant | literal $4.27 | Bifen/Tekko verified |
| Rodent bait stations | P | P | — (Trelona is termite; rodent bait product UNKNOWN) | — | bait | **UNKNOWN** | n/a | footprint → stations | n/a | n/a | **UNKNOWN** (5 min/station assumed) | quarterly checks | UNKNOWN | — | commercial same brackets | $1.50/station literal | UNKNOWN |
| Rodent trapping | P | P | — | — | trapping | n/a | n/a | home + lot | n/a | traps (count UNKNOWN) | **UNKNOWN** (observed 92 min) | ✔ unlimited callbacks | ✔ unlimited | — | — | — | n/a |
| Rodent exclusion / sanitation / guarantee | — | — | — | — | mesh/foam/box; bleach + wipe | n/a | n/a | points / LF / sq ft | n/a | — | **UNKNOWN** (v2 calc: 5 min/point) | — | guarantee terms ✔ | — | — | — | n/a |
| Rodent inspection | — | — | — | — | inspection | n/a | n/a | n/a | n/a | — | **UNKNOWN** | n/a | n/a | — | — | — | n/a |
| WDO inspection | — | — | — | — | inspection | n/a | n/a | structure | n/a | — | **UNKNOWN** (observed 60 min) | n/a | n/a | — | commercial → manual | — | n/a |
| Cockroach knockdown / German cleanout | P | P | P | — | P | **UNKNOWN** | **UNKNOWN** | footprint / severity | 4 gal | FlowZone | **UNKNOWN** (observed 36 min) | ✔ visits 1–4 | UNKNOWN | — | — | literal $10/$15 | UNKNOWN |
| Bed bug (chemical / heat / hybrid) | P | P | P (PT Alpine WSG; IGR disabled) | — | P | **UNKNOWN** | **UNKNOWN** | rooms | — | heat equipment | ✔ minutes per visit in pricing constants | ✔ 14-day | UNKNOWN | — | occupancy multipliers | $50.42/room literal | Alpine UNKNOWN (flag set) |
| Flea (single / package) | — | — | — | — | — | **UNKNOWN** | **UNKNOWN** | footprint + exterior sq ft | — | — | **UNKNOWN** | ✔ 10–21 days | ✔ conditional retreat | — | — | — | UNKNOWN |
| Stinging insects | — | — | — | — | — | **UNKNOWN** | n/a | nests | — | — | ✔ v2 (15 + 8/nest) | — | — | — | — | — | UNKNOWN |
| Termite bait (install + monitoring) | P | P | P (Trelona ATBS; Advance legacy) | — | station install / check | 1 station per 15 ft (pricing) vs 10 ft (usage map) — **UNKNOWN which** | n/a | perimeter LF | n/a | — | 5 min/station assumed; **UNKNOWN** | quarterly | UNKNOWN | — | commercial variant | station literals | label spacing UNKNOWN (10–15 ft) |
| Pre-slab | P | slab | ✔ in constants (Termidor SC, Taurus SC, Bifen I/T, Talstar P) | — | ✔ | ✔ 0.8 / 1.0 oz per 10 sf (constants) | finished gallons implicit | slab sq ft | — | — | ✔ hours curve | — | — | — | builder-batch / same-trip contexts | catalog-linked | `requiresLabelConfirmation` per job |
| Trenching | P | perimeter | ✔ in constants | — | ✔ | ✔ 0.8/1.6 oz per finished gal; 4 gal per 10 LF per ft depth | ✔ finished gallons | perimeter LF | — | — | **UNKNOWN** (LF price, not cost-plus) | annual renewal ✔ | warranty tiers ✔ | — | — | container literals (stale) | label confirmation per job |
| Bora-Care | P | attic / surface | ✔ | — | ✔ | ✔ 275 sf/gal | n/a | attic sq ft / LF × height | — | — | ✔ hours curve | — | — | — | — | $91.98/gal literal | UNKNOWN |
| Foam (one-time / recurring) | P | points | ✔ Termidor Foam | — | ✔ | cans per point tier | n/a | drill points | n/a | — | ✔ hours per tier | recurring cadence | — | — | — | $39.08/can literal | UNKNOWN |
| Palm injection | P | palms | ✔ products | — | injection | **UNKNOWN dose by size** | n/a | palm count (+ size) | n/a | Arborjet QUIK-jet (asset) | **UNKNOWN** | per treatment type | — | — | — | audit-only literals | UNKNOWN |
| Plugging / top dressing / dethatching | — | turf | plugs / sand / none | — | ✔ | ✔ spacing / depth | n/a | lawn sq ft | — | dethatcher / top dresser assets | ✔ time models | — | — | — | — | literals | n/a |
| Fire ant / tick / mud dauber / wildlife / termite liquid / termite pretreatment (billed 2026 but no pricer) | — | — | — | — | — | **UNKNOWN** | **UNKNOWN** | **UNKNOWN** | — | — | **UNKNOWN** | — | — | — | — | — | — |

## 4. Completion sequence

1. **Freeze the list of billing lines** (owner): confirm §1 and the retire list (semiannual pest, quarterly lawn, termite liquid/pretreatment/monitoring/active, fire ant/tick/mud dauber/wildlife, palm semiannual, trap-only monthly). Lines that stay must get a protocol; lines that go get hidden from the quote form and the builder.
2. **Promote the lawn operating layer to the template shape** (already structured) — fill the 18 `rate_per_1000` NULLs and link the 6 unlinked products; run `server/scripts/audit-waveguard-protocol-material-costs.js` and record the variance against `LAWN_MATERIAL_BUDGETS`.
3. **Pest, mosquito, cockroach, rodent bait, termite bait** — the highest-volume lines with prose-only protocols: create one `protocol_templates` row each (version 2026.09) with product rows from the catalog; owner/label supplies rate + unit + carrier + zones; technician supplies labor steps and minutes (seed minutes from the production medians in the audit: pest 44, monthly pest 36, cockroach 36; mosquito/rodent/termite UNKNOWN until recorded).
4. **Inspections and trapping** (WDO 60 min, rodent trapping 92 min observed, rodent inspection UNKNOWN): protocol = checklist + labor steps + callback policy; no products.
5. **Flea, stinging, bed bug, palm injection**: product rows + rates from labels; bed-bug IGR stays disabled until `label_verified_at` is set; palm dose by trunk size from the Arborjet label.
6. **Termite treatments** (pre-slab, trenching, Bora-Care, foam): move the constants' rates into template rows so the pricer and the protocol read the same numbers; link trenching container costs to the catalog (audit MAT-001).
7. **Field-verify the three calibrations** (FlowZone, tank #1, tank #2) — without `field_verified` the plan engine refuses every mix and no protocol can convert a rate into gallons and dollars.
8. **Wire protocol@version into the estimate** (`pricingMetadata.protocolVersions`) and into the cost view (material = rate × coverage × catalog cost; labor = steps' minutes × loaded rate), report-only first.

What this plan needs from the owner before any of it can be written: the freeze list (§4.1), product-by-service confirmation for pest/mosquito/rodent/cockroach/flea/stinging (which products are actually used today), the termite station spacing in use (10 vs 15 ft), and access to the current labels for every product in `products_catalog` still lacking `label_verified_at` (19 active rows).
