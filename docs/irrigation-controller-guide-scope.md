# Irrigation Controller Guide — concept scope

Status: **scoping only, nothing built.** Owner concept 2026-09-05: give lawn
customers a guide (email with brand buttons at the top, and/or a page) that
shows them how to operate THEIR irrigation controller — Rain Bird, Hunter,
and the rest — by the model on the wall. Deliver it in the prep-guide lane for
online signups and let the tech hand it out on the truck.

This doc records what already exists in both repos, what the research says
the guide must cover, three delivery options with a recommendation, the data
change needed to personalize it, the truth/compliance rules it sits under,
phased effort, and the owner decisions still open.

---

## 1. The problem the guide solves

Every irrigation email Waves sends today tells the customer *what* to do
(water each turf zone N minutes on your assigned day, skip turf watering this
week) but never *how* to do it on the box in their garage. The weekly
watering email, the lawn prep guide, the lawn service report's watering-in
instruction and the portal FAQ all assume the customer can find "Run Times"
and "Water Days" on their controller. Many can't, and a fertilizer visit that
isn't watered in (or is over-watered) is the fastest way to waste a treatment.

Compliance is the second driver. SWFWMD's Modified Phase III order currently
allows **one watering day per week through 2026-10-01** (Manatee, Sarasota,
covered portions of Charlotte), with a night-only window. Sarasota County
issued 18 citations for violations in April alone. Customers who don't know
how to change their controller's day and start time are exposed, and their
lawn is exposed when the order lifts and nobody widens the schedule back out.

## 2. What already exists (leverage points)

### Portal (`waves-customer-portal`)

| Mechanism | Where | Why it matters here |
|---|---|---|
| Block email templates with stacked CTA buttons | `server/services/email-template-library.js` (blocks: heading, paragraph, callout, details/faq, cta, image, list, …). First `cta` renders as a button, later ones as chips; per owner ruling 2026-07-06 all render as identical gold bars. | "Buttons at the top of an email" is expressible **today** as N `cta` blocks. No renderer work. |
| Prep-guide lane | `server/services/prep-guide-sender.js` (`PREP_CONFIG`, 8 `prep.*` keys), tokenized page `GET /api/public/prep/:token` (`server/routes/prep-public.js`), PDF twin, view analytics (`prep_guide_views`), SMS link template `auto_prep_guide_link`, operator "Send prep guide" in Communications, composer "Insert link → prep guide". | The exact shape the owner described: email + linkable page + PDF + send button. A `prep.irrigation_controller` key drops in. |
| Weekly irrigation email family | `server/services/irrigation-weekly-email.js` (`irrigation.weekly_*`, gated `GATE_IRRIGATION_WEEKLY_EMAIL`), `irrigation-week-plan.js`, `packages/irrigation-runtime` | Already targets recurring lawn customers and already carries a "confirm your schedule" CTA. The controller guide is the natural sibling link. |
| Restriction policy | `server/config/irrigation-restrictions.js` (`IRRIGATION_RESTRICTION_POLICY` env, fail-closed default = Phase III through 2026-10-01) | The guide must **never** hardcode "2 days a week" or hours. Day counts come from this policy or the weekly email. |
| Property irrigation data | `property_preferences`: `irrigation_system`, `irrigation_controller_location`, `irrigation_zones`, `irrigation_system_type` (spray/drip/rotor), `rain_sensor`, `watering_days`, `irrigation_run_minutes`, `irrigation_confirmed_fields` | Everything about the system EXCEPT its make/model. `irrigation_controller_location` is the near-miss neighbor. |
| Tech-side turf profile | `customer_turf_profiles.irrigation_type` (`in_ground/manual/none/mixed`) | Where a tech-recorded controller brand would live. No protocol step captures equipment today. |
| Customer "Learn" tab + FAQ | `client/src/pages/PortalPage.jsx` (Learn tab), `FAQ_DATA` + monthly tips in `server/routes/feed.js` | Evergreen home inside the app; FAQ already says "your irrigation controller is your best friend." |
| Link library | `server/services/link-library.js` (sitemap-synced) | Any hub page becomes insertable into the SMS composer automatically. |

### Marketing site (`wavespestcontrol-astro`)

- `src/content/pages/preparation/lawn-treatment-prep.md` → `/lawn-treatment-prep/`, already has a "Manage Irrigation" section.
- 45 `lawn-care` blog posts, several on watering (`lawn-watering-tips`, `water-grass-guide-sarasota-fl`, `overwatering-lawn-vs-underwatering`). **Zero** mentions of Rain Bird, Hunter or any controller brand anywhere in content.
- Facts bank `content-ops/facts-bank/services/lawn-care.md` carries the UF/IFAS watering facts and an explicit prohibition: **do not claim Waves does irrigation repair** (referred out). County facts files hold the baseline two-day schedules (before 10 AM / after 4 PM, by address digit).
- No tabs/accordion component; `ComparisonTable` exists; React islands are supported and already used for pickers (`ServiceFamilyPicker.tsx`, `LocationPicker.tsx`). No `/guides` or `/resources` namespace; evergreen pages are flat root slugs.

### What is missing (all three)

1. A controller **brand/model field** on any customer, property or turf record.
2. Any **per-brand instructional content**.
3. Any customer-facing surface that teaches **operating the box** (existing copy stops at "each turf zone", and `irrigation-week-plan.js` deliberately forbids "turn your controller off" phrasing).

## 3. Research: what to cover

### 3a. Controller landscape (SWFL residential)

Rain Bird and Hunter dominate installed residential cabinets; Orbit B-hyve
and Rachio are the common retrofit/smart replacements; Toro shows up on
older builder installs. Recommended coverage, tiered by expected frequency
on Waves properties (to be validated against tech-recorded data once
captured — see §5):

| Tier | Brand | Models to cover in v1 | Notes |
|---|---|---|---|
| 1 | **Rain Bird** | ESP-TM2, ESP-Me / ESP-Me3, ESP-RZXe, legacy ESP-M / ESP-Modular, SST | Dial-based. TM2: 3 programs × 4 start times, run 1 min–6 h, Seasonal Adjust 5–200%. Me3: up to 6 start times, 4 programs. All LNK2 WiFi-upgradable (app path = Rain Bird app). |
| 1 | **Hunter** | X-Core, X2, Pro-C (incl. HPC faceplate), Hydrawise HC / Pro-HC | Dial-based on X-Core/Pro-C: START TIMES → RUN TIMES → WATER DAYS → back to **RUN** (nothing runs unless the dial is on RUN — the single most common "my sprinklers stopped" cause). Seasonal Adjust 10–150%. Rain-sensor BYPASS/ACTIVE slide switch. Hydrawise = app-only. |
| 2 | **Orbit B-hyve** | B-hyve Smart Indoor/Outdoor, B-hyve XR | App-first; guide covers Smart Watering off/on, Rain Delay, manual zone run. |
| 2 | **Rachio** | Rachio 3, Rachio 3e | App-only; cover Fixed Schedule vs Flex, Rain Skip, Standby. |
| 3 | **Toro** | Evolution, TMC-212, legacy ECx | Older installs; short guide, link out. |
| 3 | **Other / don't know** | — | Photo-identification tips + "text us a photo of the faceplate" fallback. |

### 3b. The tasks every guide must teach (the same 8, per brand)

1. **Identify your controller** — where the model name is printed, photo cues (dial vs touchscreen vs app-only).
2. **Set the clock and date** — wrong AM/PM is the #1 cause of daytime watering violations.
3. **Pick your watering day(s)** — day-of-week selection; how to clear the other days. Day count and assigned day are **injected from the restriction policy / address**, never written into the guide body.
4. **Set the start time inside the legal window** — and understand that multiple start times stack, so one program with one start time is the safe default.
5. **Set run minutes per zone** — and how to tell spray from rotor from drip heads (reuse `HEAD_LABELS` from `packages/irrigation-runtime`); reference the weekly email for the recommended minutes rather than restating them.
6. **Run a manual zone / test cycle** — how to water in a treatment on request, one zone at a time.
7. **Skip a week or add a rain delay** — the "skip your turf watering" instruction from the weekly email, expressed as button presses (Rain Delay, Off/Standby, Seasonal Adjust to a lower %). Never "turn it off" as a permanent instruction.
8. **Rain sensor: what the bypass switch does** — and why leaving it on BYPASS all summer is the fastest path to fungus.

Plus a short "what NOT to do" callout (don't run zones midday, don't leave the dial on a programming position, don't cycle every day after fertilizer) and the referral line for actual repairs (broken heads, leaking valves, controller dead): Waves does not repair irrigation and refers out.

### 3c. Regulatory context to encode (not to hardcode)

- Baseline SWFWMD year-round rule: 2 days/week, no watering 10 AM–4 PM, by address digit (already in the facts bank).
- Current order: Modified Phase III, 1 day/week, night window, through 2026-10-01 (already the default in `irrigation-restrictions.js`, fail-closed after expiry).
- Sarasota County one-day schedule by last address digit (0/1 Mon … 8/9 Fri); Manatee and Charlotte publish their own tables. Reclaimed water is exempt.
- Implication: the guide body is **brand mechanics only**. Anything about how many days, which day, and which hours is rendered from policy + address at send/render time, exactly as the weekly email does it. When the order lifts, the guide stays correct without an edit.

## 4. Delivery options

### Option A — Portal-only: `prep.irrigation_controller` email + `/prep/:token` page

One new `PREP_CONFIG` entry and one new block template. Top of the email is a
row of `cta` blocks, one per brand, each linking to the same tokenized page
with a `#rain-bird` / `#hunter` anchor (or to a per-brand template key). Page
and PDF come free. Operator sends it from Communications like any prep guide.

- Pros: smallest build, fits the existing contract in `docs/public-route-contracts.md`, view analytics, PDF, SMS link template all reuse.
- Cons: content invisible to search; a token requires an upcoming visit to hang on (prep tokens live on `scheduled_services` / `projects`); brand-specific images would live in a DB block template, which is awkward to maintain; no evergreen URL to put in the Learn tab or on the truck.

### Option B — Hub-only: evergreen pages on wavespestcontrol.com

`/irrigation-controller-guides/` index + `/irrigation-controller-guides/{brand}/`
(hub-only `pages` collection entries, or a small React island brand picker on
one page). Email is a plain newsletter/campaign with brand buttons linking to
the hub pages.

- Pros: SEO value ("how to program Rain Bird ESP-TM2 Sarasota" is real local intent and none of it exists on the site); one source of truth; auto-appears in `link-library.js` for the SMS composer; linkable from the Learn tab, the weekly email, the lawn prep page and service reports; images are files in the repo.
- Cons: hub pages can't personalize (no assigned watering day, no customer's minutes); no per-customer view analytics; a new page family needs the hub/spoke gating decision (hub-only, or `domains:` fan-out to lawn spokes).

### Option C — Both, split by responsibility (**recommended**)

- **Content lives on the hub** (Option B pages): brand mechanics, photos, official quick-start PDFs linked. Static, versioned, SEO-indexed.
- **Delivery is the prep lane** (Option A): a `prep.irrigation_controller` template whose top row of gold buttons deep-links to the hub brand pages, and whose body carries the personalized part — the customer's assigned watering day and legal window (from policy + address), their recommended per-zone minutes (from `irrigation-runtime`), and the "water in / hold" instruction when it is sent alongside a lawn visit.
- **When the controller brand is known** (§5) the email collapses to one button for their brand plus a "not yours?" link to the index.
- **Truck path:** the tech records the controller in the lawn assessment; the same send button fires from the tech portal, or the operator sends it after the visit. The PDF twin can be printed and left on the controller.

## 5. Data change: capture the controller

Add to `property_preferences` (customer-editable, mirrors `irrigation_controller_location`):

- `irrigation_controller_brand` — enum-ish varchar: `rain_bird`, `hunter`, `orbit_bhyve`, `rachio`, `toro`, `other`, `unknown`.
- `irrigation_controller_model` — varchar 80, free text with suggestions from the guide's model list.

Wire-through (existing patterns, no new mechanism): Joi allow-list in
`server/routes/property.js`, `IRRIGATION_INPUT_FIELDS`, the Irrigation
`PropertySection` in `PortalPage.jsx`, and `irrigation_confirmed_fields` so the
weekly email's staleness ledger covers it. Tech capture goes on the lawn
assessment flow that already writes `customer_turf_profiles.irrigation_type`,
writing through to the same two columns (one source, not a sibling).

Payoff beyond the guide: the weekly email can say "on your Hunter X-Core,
turn the dial to Seasonal Adjust and drop to 80%" instead of generic copy,
and the brand mix tells us which guides to invest photos in.

## 6. Truth, compliance and IP rules this sits under

- **No irrigation-repair claims.** Facts bank prohibition. Every guide ends with a referral line, not a service offer.
- **Never "turn your controller off"** as a standing instruction (`irrigation-week-plan.js` rule). Skip/rain-delay/seasonal-adjust are the verbs.
- **Restrictions are a hard constraint above the model** (owner ruling 2026-08-28). Day counts and hours are rendered from policy, never typed into content. Fail closed: if coverage can't be established, the personalized block says so and the mechanics still render.
- **Manufacturer content:** write our own short steps and photograph our own controllers (or use manufacturer press assets under their terms). Link to the official quick-start PDFs (Hunter X-Core RC-172, Rain Bird ESP-TM2 manual, etc.) rather than reproducing them. Do not copy manual text.
- **Blog lane rules** don't apply (these are pages, not posts), but hub `pages` entries still need `modified:` bumps and, if fanned to spokes, token-clean copy.
- **Customer comms:** the owner sends. New template = seeded via migration, protected key, sent only through the existing prep sender / newsletter approval paths. No new auto-send without a `GATE_*` flag.
- **Public route contract:** reusing `/prep/:token` adds no new public route. Any new route would be a P0 per `docs/public-route-contracts.md`.

## 7. Phasing and rough effort

| Phase | Scope | Effort | Depends on |
|---|---|---|---|
| 0. Content | Write the 8-task guide for Tier 1 (Rain Bird ×2 model families, Hunter ×3) + identify-your-controller page + Tier 2/3 stubs. Photos of faceplates. | 2–3 days content + photo session on the truck | Owner: which models he actually sees (§8) |
| 1. Hub pages | `pages` collection entries or one island-driven page; index + per-brand; ComparisonTable for "which dial position does what" across brands; link from `/lawn-treatment-prep/` and the Learn tab. | 1–2 days | Phase 0; hub-only vs spoke decision |
| 2. Email + send button | `prep.irrigation_controller` template (brand buttons + personalized day/window/minutes blocks), `PREP_CONFIG` entry keyed to lawn services, SMS link copy, PDF renders for free. | 1–2 days | Phase 1 URLs |
| 3. Brand capture | Two columns, Joi, portal UI, tech assessment write-through, confirmed-fields ledger. Email collapses to one button when known. | 1 day | none (can run parallel to 0–2) |
| 4. Automation | Auto-attach the guide link to `welcome.new_recurring` for lawn plans and as a `small_note` link in the weekly irrigation email; optional "brand unknown → ask" nudge. All behind a `GATE_*` flag. | ½–1 day | Phases 2–3 |

Total: roughly two working weeks of part-time effort, with content and the
photo session as the long pole, not code.

## 8. Owner decisions needed before build

1. **Which brands/models do you actually see?** Tier list above is market-based; a week of noting controllers on the truck would re-rank it. Fine to start with Rain Bird ESP-TM2/Me3 + Hunter X-Core/Pro-C/Hydrawise and stub the rest.
2. **Hub-only or spoke fan-out?** Hub-only is simplest and safest for brand isolation. Fanning to the lawn-care spokes gives each market its own indexable copy but needs token-clean content and the per-spoke guardrail run.
3. **Who triggers it?** Manual send from Communications only (matches current prep guides), or also auto-attach to new recurring lawn welcomes and the weekly email (Phase 4, gated).
4. **Assigned watering day by address.** The weekly email today resolves county, not the address-digit day. Rendering "your day is Wednesday" in the guide needs the address-level lane the restriction config already anticipates. Ship without it (link to the county lookup) or build it first?
5. **Photos.** Own photos of customer controllers (with permission) vs manufacturer imagery vs illustrated diagrams.
6. **Naming.** "Irrigation Controller Guide" vs "Sprinkler Timer Guide" — customers say "sprinkler timer"; search volume favors it too.

## Sources consulted

- Rain Bird ESP-TM2 series page and user manual; ESP-Me3 manual (rainbird.com, manualslib.com)
- Hunter Residential AC Controller Comparison Chart; X-Core Quick Start Guide RC-172; Pro-C start-time/run-time support pages (hunterirrigation.com)
- SWFWMD Modified Phase III water-shortage order and 2026-08-27 extension (swfwmd.state.fl.us)
- Sarasota County water restrictions page; Manatee County Utilities watering-restrictions notices; Charlotte County "New Watering Schedule" (scgov.net, mymanatee.org, charlottecountyfl.gov)
- UF/IFAS turf irrigation guidance as already captured in `content-ops/facts-bank/services/lawn-care.md`
