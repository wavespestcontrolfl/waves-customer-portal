# Weekly irrigation email: "water you saved" line (scope, 2026-10-22)

Question from the owner: the typical client runs the sprinklers automatically on
two days a week, about 20 minutes a zone, even in weeks when rain already covered
the lawn. When the Monday email tells them to skip, how much water and money does
that skip actually represent, and is it worth putting the number in the email?

Status: phase 1 (gallons only) is BUILT behind `GATE_IRRIGATION_WATER_SAVINGS`, dark by
default (owner go-ahead 2026-10-22). Contract: `docs/gates-and-env.md`; code in
`server/services/irrigation-water-saved.js`. Phase 2 (water source + dollars) is
not built.

## What the email already knows

- The Monday plan (`server/services/irrigation-week-plan.js`) already decides
  `hold` (skip the week), `run`, or a forecast-conditional run, and already carries
  the one-soaking-skips-one-run rule (½" of rain before a run means skip it).
- The schedule on file (`property_preferences`): `irrigation_run_minutes`,
  `watering_days`, `irrigation_system_type` (spray / rotor / drip),
  `irrigation_zones`, optional `irrigation_inches_per_week`.
- Head rates: `@waves/irrigation-runtime`, owner table (spray 15 min and rotor
  40 min per ¼", i.e. 1.0 and 0.375 in/hr) behind `GATE_IRRIGATION_OWNER_RATES`,
  package table (1.5 / 0.5 in/hr) otherwise. A stored plan renders with the table
  frozen in its snapshot (`irrigation-rates.js`); nothing here changes that.
- Lawn area: `customer_turf_profiles.lawn_sqft`. The eligibility query in
  `irrigation-weekly-email.js` already LEFT JOINs the active turf profile, so the
  column is one select away. Coverage, measured 2026-10-22 against the sweep's own
  audience (owner ran `~/waves-ops-checkout/_lawn_area_count_read.js`): 41 customers,
  35 with a lawn area, 6 without (2 have no turf profile at all). Median area 4,241
  sq ft, average 5,297, range 1,100 to 14,000. Only 6 of the 41 have a full sprinkler
  schedule (minutes, days, head type) on file and 4 a typed weekly figure, so the
  owner default carries most of the book.

## What the email does not know

- **Water source.** Potable (county meter), reclaimed, or private well. Nothing
  in `property_preferences` records it. This is the single biggest driver of the
  dollar figure: a well lawn saves pump electricity only (cents), a reclaimed
  lawn saves a dollar or two, a potable lawn on the house meter saves real money.
  A large share of SWFL irrigated turf is on wells or reclaimed water.
- **Utility and tier.** Rates differ by county and city, and the marginal tier
  depends on the household's total use that month.
- **Actual zone flow.** We derive depth from head type, not from a measured
  gallons-per-minute figure. The gallon number is an estimate, not a meter read.

## The math

**Owner default (2026-10-22):** every customer is assumed to run the sprinklers
twice a week, 20 minutes a zone, and 20 minutes puts down ½ inch. That is 1 inch
a week. A customer's own schedule on file (minutes, days, head type, or typed
weekly inches) replaces the default when it is there; the default fills in for
the rest of the recurring-lawn book, so the line prints for everyone with a lawn
area on file.

Depth to gallons: 1 inch over 1,000 sq ft is about 623 gallons (UF/IFAS AE220).

| Lawn area | Gallons per skipped run (½") | Gallons per skipped week (2 runs) |
|---|---|---|
| 3,000 sq ft | ~930 | ~1,870 |
| 5,000 sq ft | ~1,560 (printed "about 1,550") | ~3,100 |
| 8,000 sq ft | ~2,490 | ~4,980 |

Cross-check by zone flow: a typical residential zone runs 8–12 gpm, so 20 minutes
is 160–240 gal a zone. Six zones is roughly 1,000–1,400 gal per run. Same order of
magnitude, so the default is defensible as a "typical" figure.

## What the gallons are worth

Marginal per-1,000-gallon prices, from the counties' published schedules:

| Situation | Marginal $/1,000 gal | One skipped run, 5,000 sq ft (~1,550 gal) | A skipped week (~3,100 gal) |
|---|---|---|---|
| Manatee, irrigation on the house meter (water $3.89 tier + sewer $6.89) | ~$10.78 | ~$17 | ~$33 |
| Manatee, dedicated irrigation meter (no sewer), $3.11 to $9.36 tiers | $3.11–9.36 | ~$5–15 | ~$10–29 |
| Sarasota County potable, FY2024 tiers $3.70–6.42 before the FY2026 rises, plus wastewater if on the house meter | ~$4–13 | ~$6–20 | ~$12–40 |
| Reclaimed water | ~$1 | ~$1.50 | ~$3 |
| Private well | pump electricity only | well under $1 | well under $1 |

Manatee rates are from the county's own notices (2025 usage report card and the
June 1, 2026 rate post, which disagree on residential tier breakpoints; the
irrigation-meter and sewer figures are consistent). Sarasota County tiers are from
the FY2024 financial report; the county raised water 6.4% plus a 2.23% index for
FY2026 and proposed another 6.4% for FY2027, so treat them as a floor.

**Per year.** The engine holds or skips in roughly 12–16 wet-season weeks and
every other week in the cool season (`SEASONAL_MAX_EVENTS.cool` = 1). Call it
15 skipped weeks a customer actually acts on, about 46,000 gallons on a 5,000
sq ft lawn. On the house meter in Manatee that is on the order of $500 a year; on
a dedicated irrigation meter $150–430; reclaimed about $45; a well, effectively
nothing in dollars.

Sources: [Manatee rates effective June 1, 2026](https://www.mymanatee.org/connect/news-and-information/news-and-information/article-detail/utilities-water-division-blog/2026/05/07/rates-for-water-and-sewer---effective-june-1--2026), [Manatee 2025 water usage report card](https://www.mymanatee.org/media/docs/default-source/utilities-documents/water-division-documents/2025-water-usage-report-carde07b30247ccd4f08b370bd2a68d7921f.pdf), [Sarasota County FY2026 rate increase](https://sarasotanewsleader.com/2025/08/page/3/), [Sarasota County FY2024 ACFR tiers](https://cms6ftp.visioninternet.com/sarasotaclerkfl/2024ComprehensiveFinancialReport/342/), [UF/IFAS AE220 application rates](https://ask.ifas.ufl.edu/AE220).

## Is it worth it

**Gallons: yes, cheaply. Dollars: not without a water-source answer.**

- A gallons line is honest with the data already on file, needs no new input,
  and gives the "skip" instruction a reason the customer can feel ("that run is
  about 1,000 gallons"). It is the behavior nudge the owner is after: the
  customer's controller is on automatic, and the email is the only thing that
  will make them press "rain delay".
- A dollar figure printed to a well or reclaimed customer is wrong by 10x to
  100x and reads as a sales pitch. Printing one only when the customer has told
  us the sprinklers run on county water is safe; printing one by default is not.
- The absolute dollars are modest (tens of dollars a month in the wet season for
  a potable spray lawn, single digits for rotor). That is enough to be a
  credible line, not enough to be a headline. The email's lead stays the lawn
  health instruction.

## Proposed shape (if approved)

1. **Gallons line on skip plans.** In `renderWeekPlanEmail` / the app plan notes,
   when `plan.action === 'hold'` or the plan is forecast-conditional, add one
   sentence: "Each 20-minute run you skip is about N gallons on your lawn." N =
   depth per run × `lawn_sqft` × 0.623 / 1,000, rounded to the nearest 50. Depth
   per run is the customer's own schedule when on file (minutes × the plan's frozen
   head rate, or typed weekly inches ÷ days), else the owner default of ½" (20
   minutes, twice a week). The footer small note names which was used and invites
   the customer to enter their own minutes and days. Printed only when `lawn_sqft`
   is on file (open question below). Unconditional `run` plans that carry the
   ½"-rain skip rule get the same sentence after that rule. A customer with a
   sprinkler system on file but no usable schedule never reaches the plan (they
   get the setup ask), so the default-basis sentence is appended to that ask too:
   that is most of the book (Codex #6498 r1).
2. **Water-source field, optional, phase 2.** Add `irrigation_water_source`
   (`county` | `reclaimed` | `well` | null) to `property_preferences` and the
   portal Irrigation section. When `county`, append a dollar range from a small
   per-county table (Manatee, Sarasota, Charlotte; house-meter vs irrigation
   meter is unknowable from here, so quote the irrigation-meter tier as the low
   end and house-meter as the high end). Any other value prints gallons only.
3. **Gate.** `GATE_IRRIGATION_WATER_SAVINGS`, strict `=== 'true'`, dark by default.
   Off = email and app plan byte-identical. Documented in `docs/gates-and-env.md`
   and `npm run gates:index`.
4. **Freeze.** The gallons figure is computed at decision time and stored in the
   snapshot's `decisionInputs` beside `rateTable`, so a stored plan replays the
   same number; renderers never recompute.

Not in scope: a running "you've saved X this year" total (needs proof the
customer actually skipped, which we do not have), any claim on the service
report, and an admin dashboard.

Effort: phase 1 is one renderer change, one column read, one gate, tests, and an
`email-template-library` version only if the template body needs a slot (the
notes array may already carry it). Phase 2 adds a migration, a Joi field, a
portal pill row, and the rate table.

## Owner decisions needed

1. Ship phase 1 (gallons only) alone, or hold for phase 2?
2. Lawn area with nothing on file: print nothing, or assume a default (5,000
   sq ft is the median SWFL irrigated turf figure we use elsewhere)? Data
   (2026-10-22): only 6 of 41 lack an area, and the real median is 4,241 sq ft,
   so a 5,000 default would overstate. Built as "print nothing"; the six get
   their size entered by hand.
3. Rounding and wording of the gallons sentence (above is a draft).
4. Whether to ask customers the water-source question at all. It is one more
   portal field, and the dollar line is only as good as the answer.

Decided 2026-10-22 (owner): default schedule is twice a week, 20 minutes a zone,
½ inch per run. The default stands in for a missing schedule; it never overrides
one on file.

Note: no Gmail connector was attached to this session, so the sent emails in the
inbox were not reviewed; the scope is from the code and the public rate tables.
