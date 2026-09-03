# Estimator pricing lane — plan A–D, revision 2 (for owner sign-off; nothing built)

Baseline `origin/main` @ `66ecc95dc`, worktree `~/wt-pricing-audit` (audit artifacts untracked, uncommitted). Sources: `docs/estimator-pricing-audit.md`, `docs/estimator-pricing-audit-owner-followup-2026-09-02.md`, the protocol-completion and field-requirements docs, memory note `estimator-pricing-audit-2026-09-02`, four read-only code sweeps, one adversarial code review, and the external review Adam shared on 09-03 (ChatGPT "Review Pricing Plan"). Paths are under `server/services/pricing-engine/` unless stated; line numbers are at the baseline.

## 0. Response to the 09-03 external review

Verified independently before adopting: BASF's Trelona ATBS FAQ (PSS 26-1201) — **two bait cartridges per station**, label allows an **annual** inspection interval (more often permitted), replace a cartridge when **more than 1/3 of the matrix is consumed or missing**, cartridges stay viable **≥ 5 years** under typical conditions, spacing **up to 20 ft**, stations are owned and managed by the pest company; distributor listing — 16 stations ship preloaded with 32 cartridges (124 g each). Florida: **s. 482.227(2)–(3)** (first page, bold: repair-and-retreat / retreat-only / no warranty, plus bold disclaimers and exclusions); **FAC 5E-14.105(2)** (contract furnished before any work and before payment; must state period, renewal option, first-page subterranean/drywood scope, named invasive-species exclusions, reinspection intervals and fees, retreat and repair conditions, exact annual renewal fee shown separately, bond obligations, signatures) and (6) three-year report retention; **s. 501.165** (contracts of 12+ months that auto-renew for more than a month: notice 30–60 days before the cancellation deadline; cancellation by the same means as acceptance). The review's "15-month maximum interval" was not found in the FAQ or listing and is dropped.

| Review point | Verdict | Why |
|---|---|---|
| Cartridge model understated (2 per station; 33% of *cartridges* ≈ $68/yr, not $34) | **Accepted** | FAQ confirms two per station; the variable is renamed to a per-cartridge rate |
| $249 / $0-setup / 36-month plan is a break-even product | **Accepted** | with $68 cartridges the three-year cumulative is +$16 on $747 |
| Massey $225 is an incumbent renewal, not a new-install benchmark; Sentricon stations cannot be taken over | **Accepted** | no hardware in Massey's renewal; a Waves quote is a new Trelona install |
| Drop the 36-month term; 12-month prepaid coverage + annual renewal | **Accepted** | uses the prepay lane as-is, removes PR A3 and every cancel-flow change |
| Setup fee + annual fee, one customer-facing plan, retreat-only, no bond/drywood at launch | **Accepted** | matches Sentricon/Terminix/Massey structure; sidesteps the prepay+bond refusal |
| Florida contract and auto-renewal requirements belong in A2 | **Accepted** | verified above; v3 agreement + 30–60-day notice + online nonrenewal |
| Lawn 9x: reject the 40-day interval; explicit seasonal calendar with seeder support | **Accepted** | product calendar first; the seeder's month walk is the mechanism to extend |
| 20-min drive; labor base must cover load/mix/report | **Accepted** | already the recommendation |
| Generated budgets: usable-unit costs, waste factor, effective date + version | **Accepted** | small additions to B4 |
| Dollar contribution floor beside the 35% floor; instrument quote loss before raising the grid | **Accepted** | field designed now, value later; "headroom" claim withdrawn |
| T&S: 20-ft standard / 20–25 review, no palm double-count, starting-condition input, accept gate, vision prefill-only for counts, retire 9x and its factor | **Accepted** | all consistent with the audit's INP/PRO findings |
| One-time: reject a universal 2.2×; shared pipeline with treatment-specific costs, gate + shadow, sequence last, T&S one-time manual | **Accepted with one change** | Adam asked for one rule: the rule stays "2.2 × the recurring anchor", and the treatment material difference comes from the B4 catalog costs instead of hand-typed factors; that is one rule with data, not four multipliers |
| Review's launch grid ($449 / $299 …) | **Not adopted as numbers** | its figures are unsourced; the plan derives candidates from the verified BOM and lets Adam pick (ruling A-1) |
| Review's "45-day statutory notice" | **Adjusted** | statute says 30–60 days before the cancellation deadline; the plan ties the existing 30-day notice to the deadline and adds one at 45 |

## Context

The audit scored the estimator 5.5/10: formulas reproduce (0 price mismatches over 1,259 scenarios; one cadence mismatch, CAD-002) but the cost side is assumed, and the three lines Adam does not trust — termite bait, recurring lawn, tree & shrub — have 0 accepted quotes between them. Adam's 09-02 inputs give the plan real numbers: Trelona ATBS stations **$24.00** as a loaded assembly (16-ct box $384.00, two cartridges each), replacement cartridges **$10.70 / $6.83 / $6.70** by pack, label spacing 10–15 ft recommended, 20 ft max, and one local data point: Massey renews a Waves customer's already-installed Sentricon at **$225/yr with one annual inspection** ($275 incl. drywood coverage, $400 one-time drywood spray). That customer has been waiting since 08-27 — Adam's action, outside this plan. Adam fixed the order: **A** termite annual-check plan; **B** lawn product rates → protocol check → labor → budgets → floor/grid; **C** T&S bed-area measurement, Gemini palm count, editable overrides, calendars, definitions, admin inputs; **D** one one-time multiplier rule.

Every lane ends in numbered **rulings** (recommendation first); nothing price-moving is built before them. Binding rules for every PR: pricing is DB-authoritative (`constants.js` default + `pricing_config` read-modify-write migration + `pricing_config_audit` row + client mirrors per the pricing-config skill; the client `estimateEngine.js` mirror is pinned by source-text drift tests); billing is **per application or annual prepay, never monthly**; customer copy says "per application", never a combined total outside prepay previews; no customer comms from a session; no PII; new behaviour ships dark behind `GATE_*`; extend the existing mechanism (rule 15), delete what is superseded (rule 19); Codex rounds on every head, uncapped by hand when the hook is quota-empty; Adam merges.

---

## A. Termite — one annual subterranean protection plan

### A0. Verified state

| Item | Value | Where |
|---|---|---|
| Install | `stations × ($22.05 + $5.25 + $0.75) × 1.45`; stations = `max(8, ceil(perimeter ÷ 15 ft))`; perimeter = `4√footprint × 1.25/1.35`; install labor 5 min/station computed, **never billed** | `constants.js:981-1008` (Trelona `spacingFt: 15` at :1001), `service-pricing.js:4762-4774` |
| Monitoring | `$19/mo + $5 × max(0, ceil(stations/5) − 2)`; billed per application `monthly × 12 ÷ 4`; `monitoringVisitsPerYear: 4` scalar | `constants.js:1018-1027`, `service-pricing.js:228-233, 4851` |
| Riders | bond `1yr $60 / 5yr $54 / 10yr $45` **per quarter** ($216/yr for 5-yr; line name load-bearing for `termite_bonds` sync); rental = install ÷ 20 quarters, 0 production uses; **prepay + bond refused**, multi-service prepay refused | `constants.js:1035-1060`, `service-pricing.js:4577-4635`; gates `estimate-engine.js:1053, 1125`; `estimate-converter.js:4092-4111` |
| DB overlay | `termite_install`, `termite_monitoring`, `termite_bond`, `termite_rental` (`station_spacing_ft` retired, stripped at `admin-pricing-config.js:180-192`) | `db-bridge.js:1168-1243`; validators `admin-pricing-config.js:186, 329-375`; pattern `20260728000001_termite_monitoring_station_brackets.js` |
| Annual prepay lane | handles a 1-visit/yr plan end to end: `prepay-cadence.js:26-27, 62`; `annual-prepay-renewals.js:252-264` (12-month interval; 30/15/7-day renewal notices); seeder `recurring-appointment-seeder.js:20, 126, 161`; converter coverage cadence/visits `estimate-converter.js:3818-3821, 3873-3878`; `resolveAnnualPrepayInvoiceTotal :2887-2904` with `isNonDiscountableRecurringLine :2668-2683`; `billing-cron.js:220-226` skips the lane; `cancellation-eligibility.js:59-64` sees a live term. Per-application billing knows only monthly/bi-monthly/quarterly (`billing-cadence.js:18-66`) — **not needed for a prepaid plan** | |
| Catalog | `termite_active_annual` "Termite Active Annual Bait Station Service — inspect, replace spent cartridges, re-bait", `frequency annual`, 1 visit, $199, bookable, plan-sync `recurringPattern 'annual'`; no-pricer siblings `termite_monitoring`, `termite_installation_setup`, `termite_active_bait_quarterly` | `20260408000001_add_missing_services.js:404-424`; `self-booking-plan-sync.js:231-240` |
| Agreement | signed program agreement = `customer_contracts` row (`contract_type 'document_template'`) with `renewal_date`, `cancellation_deadline`, `auto_renewal_notice_required`; v2 template text hardcodes "Quarterly station check … (4 applications per year)" and "Either party may cancel at any time"; `prepareAgreement` fails closed without a per-application price | `termite-program-agreement.js:25-28, 34-36, 970-981`; `20260511000002_contract_signing_workflow.js:16-18, 53`; `20260730000001_termite_program_agreements_v2.js:66-71, 116-119` |
| Cancel | no term concept anywhere; rental cancel = station retrieval task, no fee; "no commitment contracts" copy renders only on recurring residential lanes (termite slot empty); a voice-profile guard repeats it generically | `cancellation-processor.js:68, 82, 1376`; `cancellation-resolution/impact.js:174-189`; `estimate-followup-copy.js:36-52, 184-193`; `voice-profile-distiller.js:155` |
| Costs | code $22.05 vs supplier $24.00 (catalog row $24, `needs_pricing`); cartridges in no price; `service_product_usage` "Termite Bait" note "1 per 10 linear ft" | `20260401000091_seed_service_product_usage.js:60`; MAT-003 |
| Drywood | no product, row, or option; agreements exclude drywood; one-time `bora_care` is the nearest product | `constants.js:1607-1618`, `service-pricing.js:6284-6320` |

A 2,000 sf home today: **$610 install + $72 × 4 = $898 year one**, then $288/yr for four checks. Massey's $225 renews stations Massey already owns; a Waves quote for that home is a new Trelona installation.

### A1. Bill of materials and economics (15 stations, 2,000 sf; labor ASSUMED 120 min install, 5 min/station + 20 drive per service, $35/hr)

| Cost element | Basis | Amount |
|---|---|---|
| Loaded station assembly (2 cartridges included) | 15 × $24.00 (supplier app $384/16); 15 × $18.37 = $276 if bought at $293.94/16 (owner 09-03; diypestcontrol.com lists the same box at $399.50 today — record the real vendor in `vendor_pricing`) | $360 (one-time) |
| Install labor | 120 min | $70 (one-time) |
| Annual service labor | 95 min | $55 / yr |
| Replacement cartridges | 30 installed × **33% per cartridge** × $6.83 | **$68 / yr** ($205 at 100%) |
| Activity follow-up reserve | ASSUMED 0.25 extra visits/yr × $55 | $14 / yr |
| **Steady-state annual cost** | | **≈ $137 / yr** |

The replacement rate is a fraction of *installed cartridges* (two per station) replaced per annual service, label-driven (> 1/3 consumed or missing); 33% is a conservative planning input until the tech `/complete` product ledger records real swaps. PR A1 adds a `--termite-plan` mode to `scripts/audit-estimator-pricing.js` that prints setup × annual × replacement × minutes → year-one and steady-state margin (until then the script rejects the unknown flag).

Candidate price shapes (setup fee + annual protection, both prepaid):

| Shape | Setup (15 stations) | Annual (11–15) | Year one | Setup margin | Annual margin | 3-yr cumulative |
|---|---|---|---|---|---|---|
| **P1 — cost-recovery setup, margin in the annual** | stations × $30 × 1.0 = **$450** | base $249 + $50 per 5-station bracket above 10 → **$299** | $749 | 4% | 54% | +$506 on $1,347 (38%) |
| P2 — today's install formula, lower annual | $653 (existing 1.45×) | $249 | $902 | 34% | 45% | +$559 on $1,400 (40%) |
| Rejected — $0 setup, $249, 36-month term | $0 | $249 | $249 | — | — | +$16 on $747 (2%) |

At $18.37/station the same shapes read P1 $366 + $299 = $665 year one, P2 $530 + $249 = $779. P1 lowers the entry price $150 below today's year one and keeps the recurring number (the one a customer compares to a competitor's renewal) at a real margin; P2 keeps today's setup economics. Both use the existing per-station install formula (a plan-specific multiplier) and the existing 5-station bracket function; neither needs a term.

**Worked example — a 16-station home** (single story, ≈2,100 sf, 230 LF perimeter → **16 stations**, bracket 16–20, one full box; an existing quarterly pest customer at Silver). The expired rental offer on file for that home was $0 install + quarterly monitoring at $445.20/yr (Silver); the incumbent renews it at $225/yr on stations the incumbent already owns. Under this scope (setup not tier-discounted, annual fee tier-discounted like monitoring today): **P1** setup 16 × $30 = $480 ($390 at $18.37/station) + annual $349 (Silver −10% → $314) = **$794 year one ($704 at the cheaper box), then $314/yr**; **P2** install $696 ($565) + $299 (Silver → $269) = $965 ($834) year one, then $269/yr. Yearly cost to Waves ≈ $144 ($58 labor, $72 cartridges on 32 installed at 33%, $14 follow-up reserve) → 54–59% on the annual fee. One expired draft on that account priced 182 rented stations ($7,402 retail, $3,575/yr) — an input error worth a glance.

### A2. The product

**Waves Subterranean Termite Protection** (customer name — ruling A-1): company-owned Trelona ATBS stations placed at the label spacing; **station setup fee** (does not transfer ownership) + **annual protection fee** prepaid for a 12-month coverage period; renews annually. Included: one scheduled whole-structure inspection with every station serviced, cartridge replacement per label condition, label-directed follow-up visits when activity or heavy consumption is found, **retreatment for covered subterranean activity**, a signed annual inspection report retained three years, station retrieval when coverage ends. Excluded and stated on the first page: drywood termites (Bora-Care is quoted separately), repair of damage, and named invasive species if Adam excludes them (5E-14.105(2)(e)). No 5% prepay discount (`isNonDiscountableRecurringLine`). Standard soil placement included; hardscape coring, unusual access and supplemental stations → review.

Retired from the customer-facing menu at flip: quarterly monitoring (activity-driven extra visits become operational, funded by the reserve), the own/rent choice, and the bond rider on this plan (existing bonds keep syncing on the legacy quarterly product). A commitment promotion (waive part of the setup for a longer term) is a later, separate product decision — not the default.

### A3. Engineering — two PRs, dark until `GATE_TERMITE_ANNUAL_PLAN`

**PR A1 — BOM and cost basis (ungated; one deliberate price move: install $610 → $653 at 15 stations)**
- **Link station and cartridge cost to inventory** (owner 09-03: "termite bait stations should be linked to inventory for price changes — this is an easy one"): extend the existing pre-slab catalog link (`db-bridge.js:762-811` `syncPreSlabContainerCostsFromCatalog` — approved vendor price, `[0.5×, 2×]` sanity band, kill switch `link_container_costs_to_catalog`) to `TERMITE.systems.trelona.stationCost` (Trelona ATBS row: box price ÷ 16, loaded assembly incl. two cartridges) and a new `cartridgeCost` (25-pack row ÷ 25). A stale or missing catalog price falls back to the constant **with `materialCostSource` stamped on the line** (never silent); `constants.js:1001` default `22.05 → 24.00` stays as the fresh-env fallback. Add `cartridgesPerStation 2`, `cartridgeReplacementRate 0.33`, `followUpVisitReserve 0.25` as report-only cost inputs; the monitoring cost model (`service-pricing.js:~4900`) emits cartridges × rate + reserve into `costs` (LAB-006). The install/setup price then follows the approved vendor price: $384/16 = $24.00 → install $653 at 15 stations; a $293.94 box = $18.37 → install $530, P1 setup $366.
- Migration: `termite_install.trelona_bait 24.00` read-modify-write + `pricing_config_audit` + `pricing_changelog`; `db-bridge.js:1168-1243` + validator `admin-pricing-config.js:186` learn the cost keys.
- `service_product_usage` "Termite Bait": loaded station 1 per 15 LF (install) + replacement cartridges 0.67 per station per year (annual service) — two rows, the BOM the audit COGS map can express.
- Catalog data (admin inventory UI): Trelona ATBS `best_price 384.00`, status current, note "2 cartridges included"; add the cartridge products ($64.17/6, $170.75/25).
- Tests regenerate deliberately (golden cases, termite suites, `pricing-engine.baseline.json`, client mirror `estimateEngine.js:726-765`); calculator constants updated in the same PR; docs `TERMITE-PRICING.md` (stale flat tiers, inverted $22.05/$24 sentence), `POLICY.md` "Other services", addendum §7.3 (cartridges $34 → $68 basis).

**PR A2 — the plan on the prepay lane (gated)**
- Engine: `TERMITE.annualPlan { setupMultiplier, annualBase, annualStep, bracketStations: 5, followUpVisitReserve }` + `pricing_config.termite_annual_plan` (db-bridge, validator, seed, migration); `priceTermiteBait` (`service-pricing.js:4637-4853`) gains `plan: 'annual_protection'` producing a one-time setup line + a recurring annual line (`visitsPerYear 1`); `estimate-engine.js:1047-1141` assembles it under the gate, the quarterly/rental/bond shapes stay for gate-off and legacy rows; `v1-legacy-mapper.js:460-466, 840-866` maps the lines.
- Catalog: **repurpose `termite_active_annual`** (rename "Subterranean Termite Protection — Annual Service", `engine_keys`); converter key maps (`estimate-converter.js:258-305, 866-874`), `self-booking-plan-sync.js:231-240, 465`; `public-services-menu.js:114` moves in the same PR (spoke-fleet contract `:484-488`); the setup line is a one-time termite line (like `termite_installation_setup`, repointed rather than a new row); siblings hidden at flip.
- Prepay: seeding gate `estimate-converter.js:3441-3443` accepts `annual / 1`; the plan key joins `isNonDiscountableRecurringLine`; the setup (one-time) + annual (recurring) pairing must pass the multi-service prepay guard (`:4102-4111`); bond stays refused on prepay (not offered).
- Agreement v3 (`PROGRAM_TEMPLATE_KEYS`, `termite-program-agreement.js:34-36`, new `document_template_versions` row): first page in bold "retreatment only — no repair" + limitations/exclusions (482.227(2)–(3)); first page subterranean-only and named exclusions; period 12 months, renewal option, exact annual renewal fee shown separately from the setup, reinspection interval "annual, plus activity-directed visits", retreat conditions, signatures (5E-14.105(2)); furnished and signed before payment — the accept flow presents the agreement before the prepay charge; `prepareAgreement` receives the annual fee as its per-application price (1 application); the signed annual inspection report is retained via the existing service-report store (verify 3-year retention).
- Renewal and nonrenewal (501.165): `customer_contracts.renewal_date` = coverage end, `cancellation_deadline` = renewal date; notices at **45 and 30 days** before the deadline stating the auto-renewal and how to cancel (extend `annual-prepay-renewals.js` notice ladder; the 15/7-day ones stay as reminders); nonrenewal available online through the cancel flow v2 (`GATE_CANCEL_FLOW_V2`) since acceptance is online — never call-the-office; coverage runs to the paid-through date, retrieval task after (`cancellation-processor.js:1376` mechanism).
- Surfaces: the plan renders as one server-stamped block (like the rental disclosure `EstimateViewPage.jsx:4715-4755`): setup line + "$X per year, one inspection" — never through the cadence-label path; PDF: agreement terms on the existing last page (least words); admin inputs `EstimateToolViewV2.jsx:2316-2325` (+ hardcoded "Quarterly" at `:1334`); `estimate-service-lines.js:28-30, 360-404` + `estimate-service-details.js` copy; dedupe `RECURRING_LINE_SERVICES` (`estimate-public.js:3632` vs `:16606`); count-less quotes stay `quote_required` (no autonomous price without perimeter/stations). No new public route; `docs/public-route-contracts.md` `/accept` entry lists any new refusal code.
- Copy: scope `voice-profile-distiller.js:155` so the generic "no contracts" line never covers a 12-month prepaid agreement.
- Tests: bracket/setup golden cases, converter (annual prepay, 1 visit, no 5%, setup + annual pairing), seeder (one visit/yr), accept lock, agreement v3 render + first-page assertions, renewal-notice ladder, PDF snapshot.
- Before flip: Florida pest-control counsel and the certified operator review the v3 agreement (ruling A-11).

### A4. Rulings

1. **Price shape**: P1 — setup `stations × $30` (≈ $450 at 15) + annual $249 base / $50 per 5-station bracket above 10 ($299 at 11–15) (rec); or P2 — today's $653 install + $249/yr. Customer name for the plan.
2. **Term**: none — 12-month prepaid coverage, annual renewal (rec). Commitment-for-waived-setup only as a later promotion.
3. **Spacing**: 15 ft estimating default; 20 ft label maximum; field placement authoritative.
4. **Replacement assumption**: 33% of installed cartridges (2 per station) until the ledger measures it.
5. **Coverage**: retreatment-only, subterranean-only, drywood and damage repair excluded on the first page; no bond rider on this plan; Bora-Care quoted separately; Formosan/invasive exclusion — Adam's call.
6. **Quarterly monitoring**: retire from the customer-facing menu at flip; activity-driven visits operational (reserve 0.25/yr in the cost model).
7. **Station cost**: catalog-linked (approved vendor box price ÷ 16, loaded assembly incl. two cartridges) with the $24 constant as fallback; install moves with the catalog ($653 at $24.00/station, $530 at $18.37).
8. **Billing**: annual prepay only, no 5%.
9. **Catalog**: reuse `termite_active_annual`; repoint the setup identity; hide the remaining no-pricer siblings at flip.
10. **Takeover**: no automatic $225 match — a Sentricon property is a new install; any discount for the waiting customer is Adam's manual, per-estimate decision.
11. **Compliance**: counsel + certified operator sign-off on the v3 agreement before the gate flips.
12. Standing, unchanged: legacy count-less termite links (monthly pin vs refuse).

---

## B. Recurring lawn — product rates → protocol double-check → labor → budgets → floor and grid

### B0. Verified state

| Item | Value | Where |
|---|---|---|
| Budgets | `LAWN_MATERIAL_BUDGETS` keyed track → sold visit count at 4,500 sf, linear in sf: st_augustine `{4:75, 6:103, 9:182, 12:225}` (dead `4:` rows); also fund the spot reserves (¼ / ⅛ of `conditional_cost`); no `pricing_config` overlay (pure package the client imports) | `packages/lawn-cost-floor/index.js:54-74`; consumers `service-pricing.js:2110, 2191`, `client/src/lib/estimateEngine.js:45, 1676`, `lawn-pricing-invariant-sweep.js:208, 284` |
| Protocol flags | St. Augustine: bronze 6 (Jan Mar Jul Aug Oct Dec), **silver 8 (Jan Mar Apr Jun Aug Sep Oct Dec)**, enhanced 12, premium 12. Aug and Dec flagged for every tier but carry Premium-only product money ($22.81, $84.29 — 56% of the bronze sum of $190.28; Dec alone 44%); derivations sum `material_cost` per flagged slot with no tier split. No sold tier maps to silver | `server/config/protocols.json:3-217`; `waveguard-pricing-exposure.test.js:15-19, 39-67`; `lawn-cost-floor-shared.test.js:16-32` |
| Sold 9x | accept maps `enhanced → lawn_care_6week / every_6_weeks / 9 visits`; seeded `custom` at 42-day intervals → 378 days = 8.69 visits/yr (projection skips Dec, Apr, Jul); the same row serves T&S 9x; `=== 42` checks and a 38–48-day window in four other files; label "9 visits/year"; the seeder's month walk (`SEASONAL_FEB_OCT`) is the only month-anchored mechanism and prepay coverage **refuses** it (so mosquito seasonal9 prepay already fails closed) | `estimate-public.js:20563-20570`; `self-booking-plan-sync.js:111-122, 159-170, 530`; `admin-schedule.js:437, 4835, 13732`; `annual-prepay-renewals.js:270, 283, 1046`; `secure-appointment-plans.js:134`; `prepay-cadence.js:21, 47-56, 62`; `recurring-appointment-seeder.js`; `self-booking-plan-sync.test.js:33-37` |
| Operating layer | `lawn_protocol_products.rate_per_1000 / rate_unit / carrier_gal_per_1000`; nutrition rows `rate_per_1000 NULL` with `rate_unit 'lb_n'`, N target only a string in `gates.targetN`; nothing under `pricing-engine/` reads these tables | `20260529000003_lawn_protocol_operating_layer.js:71-93, 240-256` |
| Write paths | rates: `PUT /api/admin/protocols/lawn/products/:id` (draft-only), UI read-only; **`products_catalog.cost_per_unit` written only by migrations**; `default_rate_per_1000` migration-only | `admin-protocols.js:1802, 1827, 2209-2261`; `admin-inventory.js:521-529, 3644-3669` |
| Labor | floor 12 + 2.5 min/1,000 sf + DENSE 5 drive, $35, admin $51, callback $2 (+5/+5); 35% floor report-only (`useLawnCostFloor: false`, `programMinimumMonthly: 0`); `$26.96` literal and `scaledMaterial` clamp reachable only via `??` fallbacks that never fire | `constants.js:247-327`; `service-pricing.js:1972-2053, 2112-2118, 2303, 2387-2404` |
| Grid | `LAWN_BRACKETS` `[sqft, 6x, 9x, 12x monthly]` (st_aug 4,500 = `[38, 48, 64]`); overlays `lawn_pricing_v2` + `lawn_pricing_brackets`; admin UI `/admin/pricing-config/lawn-brackets` | `constants.js:417-506`; `db-bridge.js:915-922, 1951-1954`; `admin-pricing-config.js:720-795` |
| Checks | weekly prod-DB sweep flags only budgets >15% under (`BUDGET_DRIFT_RATIO 1.15`) | `lawn-pricing-invariant-sweep.js:206-300`; `scheduler.js:1171-1192` |
| Market | 9x $384/yr at 2,000 sf vs one TruGreen Sarasota starting price of $449; 0/12 lawn quotes accepted — cause unknown (price, trust, lead intent, follow-up, or sample size) | addendum §3.1 |

### B1. Product rates first (data; one small code PR for the cost write path)

1. **Worklist (read-only)**: PR B1 adds a `--lawn-rates` mode to `scripts/audit-pricing-data-quality.js` (the script rejects the unknown flag until then) listing the rate-less nutrition rows (protocol, window, product, role, `gates.targetN`), unlinked rows, lawn-named products missing `cost_per_unit` / `rate_unit` / `label_verified_at`, `oz`-rated liquids to hand-check.
2. **Candidates computed, never invented**: nutrition rate per 1,000 sf = target lb N ÷ (N analysis ÷ 100) from the bag analysis on the catalog row, printed beside `max_label_rate_per_1000`; `cost_per_unit = best_price ÷ unit_size` in the usable unit. Every cell confirmed by Adam before it is written.
3. **Write path**: rates via draft → edit → publish, then the AGENTS.md fan-out (`protocols.json`, `products_catalog.default_rate_per_1000`, pricing.csv, plan-matcher) as one data migration. Costs: small code PR adding `costPerUnit` + `costUnit` to the inventory PUT allow-list behind the owner-only gate + the `InventoryPage.jsx:~2538` input; the first confirmed batch lands by migration.
4. Exit: every lawn-protocol product has rate + unit + cost + unit; `server/scripts/audit-waveguard-protocol-material-costs.js` runs clean, variance recorded.

### B2. Protocol double-check and the seasonal calendar mechanism

1. **Six real applications on 6x**: Aug and Dec get a genuine bronze/silver product (ruling B-1); otherwise the plan is relabelled "4 applications + 2 lawn-health inspections". An inspection is never called an application.
2. **9x = nine explicit seasonal application months**: silver's eight (Jan Mar Apr Jun Aug Sep Oct Dec) plus one Adam names — **Jul recommended** (bronze's summer insect month, which also makes 9x a superset of 6x). Sold `enhanced` maps to the silver flags with that month added (flag keys unchanged; the tier map is a pinned contract). Customer wording "9 seasonal applications per year", never "every six weeks".
3. **Scheduling follows the product calendar**: extend the seeder's existing month walk into a generic per-plan `scheduleMonths` (lawn 6x/9x/12x, T&S 4x/6x, mosquito seasonal9) — plan rows carry months instead of a day interval; `prepay-cadence.js`, `annual-prepay-renewals.js`, `secure-appointment-plans.js` and the `=== 42` checks read the plan row; prepay coverage accepts month lists (which also fixes the seasonal9 refusal); the season timeline (`GATE_ESTIMATE_LAWN_CALENDAR`) renders the same months. The 42-day row is deleted when nothing reads it (rule 19).
4. Record `applications` and `visits` per tier as data in `protocols.json`, so nothing derives counts from flags again; label at `estimate-public.js:20567` fixed.

### B3. One labor assumption

- The cost-floor model is the only model: a test proves `costFloorDetails` present for every bracket, then the `26.96` literal, the clamp and the `??` fallbacks go (`service-pricing.js:2112-2118, 2303, 2393`); minutes DB-tunable (`pricing_config.lawn_labor_model`), report-only; **drive 20 min** (ruling B-3); base minutes must cover load/mix, tank switch, report completion and setup — stated in the knob comments and the reality-check comparison, so "time on property" is never mistaken for production labor.
- Validation is operational (check out before driving; `time_on_site_adjusted_minutes`); after one clean quarter medians replace the assumption (MON-004).

### B4. Re-derive budgets (generated data)

- `audit-waveguard-protocol-material-costs.js` (extended) computes per-track, per-tier material at 4,500 sf from `lawn_protocol_products × carrier × products_catalog.cost_per_unit` (usable units) over each tier's ruled months, plus the spot-reserve share of `conditional_cost`, times a configurable **waste/mixing-residual factor**; writes `packages/lawn-cost-floor/material-budgets.generated.json` with **effective date + pricingVersion** so old estimates keep their assumptions; the package imports it (stays pure and client-safe). The same generator emits the T&S knob values (C5). Drift detection = the weekly sweep made **two-sided**. Needs a numeric `target_lb_n_per_1000` column and per-tier flags on the operating layer (migration).
- Changelog migration in the shape of `20260717000001_lawn_spot_reserve_version.js`; `lawn-cost-floor-shared.test.js:26-32` pins regenerate deliberately.

### B5. Floor and grid (last)

- Floor rule designed now, values later: `required = max(grid, cost ÷ (1 − 0.35), cost + minimum contribution $ per application)` — the contribution field exists from B3 with no value until route and overhead data are visible.
- Shadow the floor on the real inputs (B1–B4) per bracket, then ruling B-5: enforce at Bronze list / report at tiers, or keep report-only. **No price cut; no material increase until quote-loss tracking exists** — instrument with the existing estimate events and decline reasons (delivered, viewed, plan selected, abandoned, lost reason, competitor and price when volunteered, size and tier); a single competitor starting price is not evidence of headroom.

### B6. Rulings

1. 6x: six genuine applications (rec) — name the Aug and Dec products for 6x — or relabel.
2. 9x: nine seasonal months = silver's eight + Jul (rec); confirm the full sequence at protocol review.
3. Drive 20 min (rec); base minutes include load/mix/report/setup.
4. Confirm the computed nutrition rates and the cost backfill before they are written.
5. Floor: shadow first; enforce percentage + contribution floor later; grid moves only via the admin UI with a changelog, after loss tracking.

---

## C. Tree & shrub — measurement protocol, Gemini palm count, editable overrides, calendars, definitions, admin inputs

### C0. Verified state

| Item | Value | Where |
|---|---|---|
| Engine | material `(15 + 4/tree + 0.055/sf × density) × tier factor (light 0.75, 9x 1.25) + palm reserve`; labor `max(25, 20 + bed÷500 + 1.5/tree + palm min + access 0/8/15)`; only service-line palms fold into the tree terms; property-level palms reach only the **disarmed** reserve (INP-001); bed fallback lot × 10/18/25% (+5%) else 2,000 sf + `missing_bed_area_fallback` | `service-pricing.js:2625-2940` (palms `:2717-2792`, labor `:2776`, material `:2793-2798`, bed `:2470-2545`, review `:2830-2859`); `constants.js:64-73, 588-633` |
| DB knobs | `pricing_config.ts_material_rates` already overlays `fixed / per_tree / per_sqft / light_factor / enhanced_factor / density_* / palm_per_palm_annual / palm_minutes_per_visit / callback_reserve_per_visit`, plus `ts_monthly_floors` | `db-bridge.js:1062-1114`; `constants.js:611-614`; replay guard `estimate-tree-shrub-knob-replay.js:25` |
| Admin builder | bed area, palms, trees only (`:6402-6417`), all property-level; service line is the literal `{ tier: 'standard' }`; blank tree count posts 0; `public-quote.js:1288-1312` builds the line correctly | `EstimateToolViewV2.jsx:400-403, 4497-4539, 6402-6417`; `property-lookup-v2.js:3970, 4406-4426`; `estimate-engine.js:927-941` |
| Protocol | `2026.06-swfl-tree-shrub-10`: `tier_4x` (Jan Apr Jul Oct) and `tier_6x` (Jan Mar May Jul Sep Oct) defined; **no `tier_9x`**; Snapshot per 1,000 sf beds; 8-2-12 palm 1.5 lb/100 sf root zone; foliar per 100 gal; basis 2,000 sf beds / 400 sf palm / 20 gal | `protocols.json:849-1157` |
| Scheduling | `bimonthly 6 / every_6_weeks 9 (shared 42-day row) / quarterly 4`; no month mapping — every T&S appointment resolves to protocol visit 1 | `self-booking-plan-sync.js:147-184`; `protocol-matcher.js:225-229` |
| Vision | satellite prompt already returns `bed_area_sqft`, `palm_count`, `tree_count`, densities; lookup carries `estimatedPalmCount / estimatedTreeCount / estimatedBedAreaSf`, `aiDivergences`, `palmCountTrusted`; Gemini leg on `MODEL_GEMINI_VISION` (`gemini-3.5-flash`, fallback `gemini-2.5-flash`); `[turf-footprint] shadow comparison` and `property-facts-shadow.js` log coarse diffs; builder prefill keeps `_palmCountAuto` | `satellite-analyzer.js:24-52, 258`; `property-lookup-v2.js:1354-1356, 2073-2081, 2279, 2314-2330, 4600, 4680-4712`; `server/config/models.js:113, 128`; `EstimateToolViewV2.jsx:3868-3880, 4055-4066` |
| Lawn override | `measuredTurfSf` editable, **not audited**; the audited mechanism `property_lookups.verified_overrides` (`POST /property-lookup/verify`, admin-authed) has no turf/bed/palm/tree field and writes no `audit_log` row | `property-calculator.js:123-129`; `lookup-cache.js:54-71, 539-577`; `property-lookup-v2.js:48, 1037-1058`; `audit-log.js:29` |
| Persisted | `customers` / `customer_properties` `bed_sqft`, `palm_count`; no `tree_count` column; estimates keep `tsMeta` in `estimate_data` | `20260629000001_customer_properties.js:42-44`; `v1-legacy-mapper.js:583-607` |
| Production | 4 of 5 T&S quotes priced on fallback / lot-guessed bed area | addendum §1 |

### C1. Definitions (ratify)

- **Bed area** = sq ft of maintained ornamental beds, foundation plantings and hedge lines receiving the covered bed-level granular, nutritional and plant-health treatments; excludes turf, hardscape, pool-cage interiors, unmanaged natural areas and excluded specialty plantings. Measured or confirmed, never guessed on an accepted estimate.
- **Tree count** = ground-accessible ornamental trees **up to 20 ft** on the foliar/soil program (crape myrtle, ligustrum, magnolia, citrus, small oaks); **20–25 ft → access review** (`largeTreeCount`, counted for review, not priced); taller trees are injection add-ons.
- **Palm count** = palms specifically listed on the program receiving palm-specific 8-2-12 granular and foliar micronutrients. Material roles never double-count: general bed products price by bed sf (palm root zones inside a measured bed are already in it); palm-specific products price by count (the ~100 sf root-zone figure is only the conversion for the palm fertilizer rate); eligible tree foliar prices by tree count; injections stay separate.
- **Starting condition** (new input): `maintenance` (normal program), `corrective_start` (active scale/whitefly, severe nutritional decline, heavy disease → knockdown/setup treatment, PRO-003 uplift ruling), `manual_review` (specialty tree, severe decline, inaccessible canopy, uncertain diagnosis).

### C2. Bed-area measurement protocol (same footing as turf)

`bedAreaSource` ranking with confidence and review reason: **measured** (typed → `explicit`, fixes INP-003) → **vision** (`estimatedBedAreaSf`, parcel-clamped → provisional price with `bed_area_vision_estimate`, confirmation required before send) → **lot_density** (internal draft only, review reason) → **fallback** 2,000 sf → `quote_required`. Admin builder: `BED_CONFIRMATION_REQUIRED` mirroring `TURF_CONFIRMATION_REQUIRED`. **Accept gate**: a T&S estimate is not sent or accepted with fallback or density-guessed bed area, tree count or palm count — explicit values (explicit zero allowed), access and starting condition are required; drafts may carry fallbacks.

### C3. Vision assists, never decides

Prompt and fields exist; the work is wiring, trust and gating: confirm the Gemini leg is in the merge quorum (`property-lookup-v2.js:2073-2081`); bed area → provisional price + confirmation (C2); **palm and tree counts → prefill only** with "Estimated palm count (vision)" + confidence + imagery date; `lookupPalmCountIsTrustworthy` is the review trigger; explicit zero is never overwritten by a model; a verified override always wins. Tier via `MODELS.GEMINI_VISION_BEST` / `MODEL_GEMINI_VISION` (never a literal); Claude fan-out fallback stays. Shadow = add palm/bed fields to the existing `[turf-footprint]` comparison and the `propertyFactsV2` draft diff (coarse, no PII). Gate `GATE_TS_VISION_MEASUREMENT`; flip criterion ≥ 50 field-confirmed properties, median palm-count error ≤ 1, no systematic undercount — until then vision saves typing, not decides the bill.

### C4. Editable, audited overrides

Add `treatableTurfSf`, `bedAreaSf`, `palmCount`, `treeCount` to `VERIFIABLE_FIELDS` + `sanitizeVerifiedValue` (`lookup-cache.js:54-71, 119-157`; palms 1–200, bed area unclamped per the 08-10 ruling), stamp evidence in `applyVerifiedOverrides` (`:586-600`), write an `audit_log` row per override (typed helper in `audit-log.js`: source, user, timestamp, before/after), "Save as field-verified" beside each estimated value in the builder (pattern `EstimateToolViewV2.jsx:5986, 6392`), including the turf panel. A verified count outranks the distrust verdict (`:2279, 4420`). No new table; admin-authed route, no contracts entry.

### C5. Calendars and material through the existing knobs

- **4x** = `tier_4x` (Jan Apr Jul Oct); **6x** = `tier_6x` (Jan Mar May Jul Sep Oct) — customer wording "four / six seasonal applications", not "bimonthly" (catalog name ruling C-2); Aug scout and Dec report are not charged and not counted as visits. **9x retired** (ruling C-3): `enhanced_factor` semantics deleted, `constants.js:594` un-retirement reversed, POLICY.md already says retired.
- No runtime material engine: the B4 generator computes the **values** of the existing `ts_material_rates` knobs per cadence (`per_sqft` from Snapshot + 13-0-13 rates × cost ÷ visits; `per_tree` from the foliar per-100-gal basis; `light_factor` from the 4x ÷ 6x product totals; `palm_per_palm_annual` = palm-specific 8-2-12 at 1.5 lb/100 sf × ~100 sf × 3 apps × $/lb + foliar micronutrient share; `palm_minutes_per_visit 1.5`) and arms them through `pricing_config` (the row is the switch; client mirror untouched). Corrective-start uplift = a separate knob (PRO-003 ruling).
- Month alignment: seeded visits map to protocol months via the B2 `scheduleMonths` mechanism (fix `protocol-matcher.js:225-229`); service promise copy: "each scheduled visit includes inspection and seasonally appropriate targeted treatment of covered ornamentals based on plant needs and pest, disease and nutritional conditions" — never "every plant, every chemistry, every visit".
- Price-moving via the row: `pricing_changelog` + baseline regen (`CAPTURE_BASELINE=1`) + POLICY.md §T&S.

### C6. Admin builder inputs

Translator builds `services.treeShrub = { tier, access, treeCount, palmCount, condition, largeTreeCount }` from the form (mirror `public-quote.js:1288-1312`); builder adds access, tier (4x/6x), starting condition and large-tree fields beside `:6402-6417`; blank tree count = unknown (draft-only fallback), never 0; typed bed = `explicit`; integer/≥0 bounds at `/calculate-estimate` (INP-001..005). Golden cases pinning today's behaviour flip deliberately; `EstimatePage.jsx` (legacy twin) gets the same spots.

### C7. PR order

1. **PR C1** builder inputs + translator (INP-001..005) — small, ungated bug fix.
2. **PR C2** audited overrides (turf, bed, palms, trees) + `explicit` stamping + `BED_CONFIRMATION_REQUIRED` + the accept gate.
3. **PR C4** calendars, definitions, generated knob values armed through `pricing_config`, 9x retirement, month alignment (after rulings C-1..C-4 and B1 costs).
4. **PR C3** Gemini wiring, gated + shadow — after manual quoting is correct, never a prerequisite for it.

### C8. Rulings

1. Definitions as in C1 (20-ft standard, 20–25 review, material-role separation, starting condition).
2. 6x calendar = Jan Mar May Jul Sep Oct as "six seasonal applications" (rec); catalog display names.
3. 9x: retire (rec).
4. Palm economics: protocol-derived palm material and labor through the existing reserve knobs (rec); never "one palm = one generic tree".
5. Vision: bed area provisional + confirmation; palm/tree prefill-only until the flip criterion is met (rec).
6. Corrective-start uplift value (PRO-003).

---

## D. One-time services — one rule with data, gated, last

### D0. Verified state

| Line | Basis | Ratio to recurring per-application | Where |
|---|---|---|---|
| Pest | quarterly per-app × **2.2** → floor $199 → urgency → 15% perk → floor → "> quarterly + $99" clamp; DB `onetime_pest` with a ≥2 invariant | 2.20 | `constants.js:1330-1346`; `service-pricing.js:5350-5449`; `db-bridge.js:189-216, 1621-1633` |
| Lawn | 6x standard per-app × 1.50 → floor $115 → × treatment (1.00 / 1.12 / 1.30 / 1.38) → urgency → perk; `fungicideFloor` dead; Lawn Pest Knockdown uses `pest` | 1.58–2.84 | `constants.js:1349-1358`; `service-pricing.js:5678-5755`; `estimate-engine.js:1342-1360` |
| Mosquito | anchors $156 … $282 with 500-sf interpolation, over-acre +$42/10,000 sf + review, stations $75, dunks $15; no urgency, no floor; buckets differ from the seasonal pricer's | 2.03–2.76 | `constants.js:1368-1378`; `service-pricing.js:5760-5874`; seasonal9 `constants.js:913-943` |
| T&S, rodent bait | none (a "One-Time Tree & Shrub Visit" label exists with no pricer) | — | `EstimateViewPage.jsx:1634` |

### D1. The rule

**One-time price = max(line floor, recurring per-application anchor × 2.2 + treatment material difference ÷ (1 − 0.35)) → urgency → 15% recurring-customer perk → floor again.** The material difference = catalog cost of the one-time treatment's products minus the anchor's average per-application material, both from the B4 generator (zero for pest and mosquito, so those lines are plain 2.2×; lawn fungicide keeps its real cost without a hand-typed 1.38); the pest "> quarterly + $99" clamp stays pest-only. Mosquito anchors on the seasonal9 per-visit price and **keeps the over-acre increment** as the large-lot slope. T&S one-time is **manual review** until a defined scope exists (evaluation-only / evaluation + standard foliar / corrective insect / corrective disease / nutritional); rodent bait one-time stays absent. Lawn keeps today's treatment multipliers until B4 supplies costs — no interim change.

Effects at reference sizes once costed: mosquito 8,000 sf $156 → $169; 40,000 sf ≈ $224 + over-acre increment (ruling D-3 sees the delta); lawn 4,500 sf fert ≈ $141, fungicide ≈ $141 + its material difference; pest unchanged.

### D2. Changes (one PR, gated `GATE_ONE_TIME_PRICING_V2` with a shadow log of old vs new on every one-time quote; old pricers deleted after the flip — the named rule-19 exception)

- `constants.js:1348-1379` → `ONE_TIME.{pest, lawn, mosquito} = { multiplier 2.2, floor }` + mosquito add-ons + over-acre increment; `service-pricing.js:5678-5755` (lawn: anchor × 2.2 + material difference), `:5757-5874` (mosquito on `priceMosquito(…, { tier: 'seasonal9' })`; `getOneTimeMosquitoAreaBucket` / `getOneTimeMosquitoBase` exports at `:8901-8902` retired after checking consumers of `areaBucket` / `overageSqFt`); the T&S one-time label → `quote_required`.
- `db-bridge.js:1579-1651` overlays reshaped; the ≥2 invariant (`:202-216`) generalized; `admin-pricing-config.js:636-637` seeds; migration (pattern `20260808010000_mosquito_5pct_raise.js`) with `pricing_config_audit` + `pricing_changelog`; `services.mosquito_one_time` base/range re-aligned; `admin-schedule.js:1739-1796, 1845-1890` booking default re-pointed; `public-ranges.js:764-833` values only (no contracts entry).
- Client mirror `estimateEngine.js:52-80, 2809-2882` + the source-text drift test (`client-estimate-engine-pricing-drift.test.js:497-569`); wizard copy (`EstimateToolViewV2.jsx:1738-1768`, `EstimatePage.jsx:5730-5740`).
- Tests: `pricing-engine-one-time-treatments`, `mosquito-cadence-guard:45-53`, `pricing-engine-mosquito-hardening:269`, `pricing-engine-db-bridge:200-250, 340-445`, `estimateEngine.mosquito.test.js`, baselines regenerated, lawn/mosquito golden cases + `expectOneTime*` twins in the calculator; POLICY.md.

### D3. Rulings

1. Adopt the rule as one pipeline with a data-driven material term (rec) — not a bare universal multiplier.
2. T&S one-time: manual review until a scope is defined (rec); $199 may later floor an "evaluation + standard treatment" service.
3. Mosquito floor $156 with the over-acre increment retained (rec); confirm the 40,000 sf outcome.
4. Lawn anchor stays 6x standard (rec).
5. Gate + shadow before any one-time price moves; D runs last.

---

## Sequencing, verification, scope fence

| Order | PR | Gate / switch | Price moves? | Depends on |
|---|---|---|---|---|
| 1 | C1 T&S builder inputs; A1 termite BOM/cost basis | none | palm-heavy admin quotes up; install +$43 at 15 stations | A-3, A-4, A-7 |
| 2 | C2 audited overrides + accept gate | none (admin) | no | C1 |
| 3 | B1 rates + cost write path | none (data + small code) | no | B-4 |
| 4 | B2 seasonal-calendar mechanism (lawn 6x/9x, T&S 4x/6x, mosquito seasonal9) + C4 definitions/9x retirement | none | no | B-1, B-2, C-1..3 |
| 5 | B3 labor + B4 generated budgets and T&S knob values (shadow) | none | no (report-only) | B1, B-3 |
| 6 | A2 termite plan + agreement v3 + renewal notices | `GATE_TERMITE_ANNUAL_PLAN` | new product | A-1, A-2, A-5, A-6, A-8..A-11 |
| 7 | C3 Gemini wiring | `GATE_TS_VISION_MEASUREMENT` + shadow | no | C2, C-5 |
| 8 | B5 floor shadow → activation; C4 knob arming | `pricing_config` rows | owner-decided | B4, B-5, C-4, C-6 |
| 9 | D one-time v2 | `GATE_ONE_TIME_PRICING_V2` + shadow | yes, at flip | B4, D-1..5 |
| 10 | Delete superseded pricers, hide legacy termite rows | after flips | — | 6, 9 stable |

Verification per PR: `pricing-audit-golden-cases.test.js` (976) plus every touched suite green; `node scripts/audit-estimator-pricing.js` re-run with the calculator's constants updated in the same PR whenever a price deliberately moves; `AUDIT_DB_URL=… --db` overlay after each `pricing_config` migration deploys; `npm run check:domain-rules` for C3; ui-verify on A2 surfaces and C2/C6 builder changes; Railway deploy + `/api/health` after each merge; watch-firsts to contact@ for the first annual-plan accept, the first 45-day renewal notice, the first accept-gate refusal on a T&S estimate, and the first vision-vs-typed palm disagreement.

Not in this plan (separate lanes): BIL-001/BIL-002 completion billing and lanes (also the home of any "two applications on one visit" billing), MAT-001/002 catalog links, CAT-* catalog identity, DIS-001 FIXED-discount cap, MON-002 labor digest, the waiting takeover customer's answer (Adam). Doc corrections owed in the first PR touching each file: addendum §4.3 (the protocol does define `tier_6x`), §7.3 (cartridge basis two per station), TERMITE-PRICING.md's inverted station-cost sentence.
