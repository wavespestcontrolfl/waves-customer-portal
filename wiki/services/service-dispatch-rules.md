# Service Line Dispatch Rules

**Summary:** Which technician to assign to each service type, license requirements, time estimates, and upsell flags per service line. Single source of truth for tech-to-job matching logic.

**Category:** services
**Tags:** dispatch, assignment, license-requirements, time-estimates, upsell, service-lines

---

## General Pest Control
- **Who:** Any licensed tech (all 3)
- **License required:** Pest control
- **Estimated time:** 30–45 min residential, 45–60 min commercial
- **Recurring:** Yes — backbone of route
- **Upsell flags:** Mosquito add-on, rodent stations, perimeter+interior upgrade, WaveGuard enrollment
- **Callback rule:** Route to original tech when available same day

## Termite (Bora-Care / Termidor / Foam Drill)
- **Who:** Adam ONLY
- **License required:** Termite treatment license
- **Estimated time:** 2–4 hours (Bora-Care full install), 60–90 min (spot/foam)
- **Recurring:** Bora-Care is one-time + annual renewal; Termidor pre-slab is pre-construction only
- **Upsell flags:** Annual renewal contract, moisture barrier, exclusion package
- **Hard limit:** Max 2 termite jobs per day — never schedule back-to-back with full route day

## WDO Inspection
- **Who:** Adam ONLY
- **License required:** WDO license (only Adam holds it)
- **Estimated time:** 45–90 min depending on property size
- **Recurring:** No — pre-sale or annual
- **Upsell flags:** Termite treatment if evidence found, full pest program enrollment
- **Priority:** High revenue + high upsell conversion — protect slot, never bump

## Lawn Care (Fertilization / Weed / Fungicide)
- **Who:** Adam or Tech 2
- **License required:** Lawn & Ornamental (FDACS)
- **Estimated time:** 20–45 min by sq footage
- **Recurring:** Yes — 6x or 8x per year programs
- **Upsell flags:** PGR (T-Nex), soil amendment (humic/fulvic), aeration/seeding, tree & shrub add-on
- **Weather rule:** Reschedule if rain forecast within 1 hour of appointment

## Mosquito Control
- **Who:** Any licensed tech
- **License required:** Pest control
- **Estimated time:** 20–30 min per property
- **Recurring:** Monthly or bi-monthly
- **Upsell flags:** WaveGuard Gold/Platinum upgrade, automatic misting quote, tick/flea add-on
- **Seasonality:** High demand April–October in SWFL — push promos starting March

## Tree & Shrub Care
- **Who:** Adam (Arborjet-certified) for injection; Tech 2 for foliar spray only
- **License required:** Lawn & Ornamental; Arborjet cert for injections
- **Estimated time:** 45–90 min
- **Recurring:** 4x or 6x per year
- **Upsell flags:** Palm nutrition injection ($35/palm, $75 visit minimum), whitefly treatment, fungicide rotation
- **Hard rule:** Arborjet palm injection is Adam only — no exceptions

## German Roach Treatment
- **Who:** Adam preferred; Tech 2 acceptable
- **License required:** Pest control
- **Estimated time:** 60–90 min (full protocol — gel, IGR, crack/crevice)
- **Recurring:** Book 14-day and 30-day follow-ups immediately at time of first service
- **Upsell flags:** Quarterly general pest program after resolution
- **Flag:** Auto-schedule follow-up slot at booking

## Stinging Insect Removal
- **Who:** Any tech for standard nests; Adam only for Aggressive Colony Surcharge jobs
- **License required:** Pest control
- **Estimated time:** 30–60 min
- **Recurring:** No — one-time
- **Upsell flags:** Quarterly perimeter pest program, exclusion

## Rodent Bait Stations (Contrac + Protecta Evo)
- **Who:** Any licensed tech
- **License required:** Pest control
- **Estimated time:** 30–45 min (setup), 20 min (monitoring visit)
- **Recurring:** Monthly monitoring
- **Upsell flags:** Exclusion package, interior general pest add-on
- **Billing:** Monthly — no setup fee

## Callback / Retreat
- **Who:** Original tech first; if unavailable → best-rated tech for that service type
- **License required:** Same as original service
- **Estimated time:** Same as original + 15 min buffer
- **Recurring:** No — priority insert
- **Hard rule:** Must complete within 5 business days of original service date
- **Score boost:** +15 pts — renewal retention is high value
