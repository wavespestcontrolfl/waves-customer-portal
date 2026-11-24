# Routing Rules — Waves Pest Control

**Summary:** Core routing logic for daily dispatch optimization in Southwest Florida. Covers cluster grouping, re-optimization triggers, drive time targets, and job ordering principles.

**Category:** protocols
**Tags:** routing, dispatch, optimization, drive-time, service-line-split

---

## Who Covers What (owner rulings 2026-11-21 / 11-22, FINAL)

Waves has **one technician today: Adam (the owner)**. Adam covers every service line in every served ZIP.

When the second technician is hired, the split is **by service line, not by ZIP or territory**:
- **Second tech:** all pest control and termite work, in every served ZIP.
- **Adam:** lawn care, tree & shrub, and exclusion, in every served ZIP; fills in on pest when needed.

Do not split work between techs by ZIP cluster. Group a day's stops by geography for drive time only.
The live mapping is in the auto-dispatch territory settings and the dispatch code; this page only summarizes the rulings.

## Route Building Order

1. Group all jobs for the day by the tech who does that service line, then by geography
2. Score each job using the job scoring formula
3. Anchor first stop: highest-score job nearest to tech's home zip
4. Subsequent stops: maximize cluster density × job score — minimize backtracking
5. Place high-score jobs (≥80) at natural positions — never bury them after low-score stops
6. Recurring jobs form the backbone; one-time jobs slot into geographic gaps
7. Inspection/estimate jobs get dedicated time blocks — never back-to-back with full service jobs
8. A full day is 12 stops per tech (owner 2026-11-22); 16 is a stretch day only

## Drive Time Targets

- Drive time < 25% of total shift (target 20%)
- Maximum single drive between stops: 30 minutes
- Flag any stop requiring 30+ min — consider moving to adjacent day or different tech
- Daily mileage target: < 60 miles per tech

## Re-Optimization Triggers

- **Cancellation:** Pull next best density-matched stop forward. Log result.
- **Same-day add-on:** Score new job, find best insertion point by zone proximity
- **Callback/retreat:** Insert at first available slot for original tech — flag as priority
- **Weather delay:** Re-sequence lawn/exterior jobs later in day; keep interior pest stops in place

## Recurring vs One-Time Routing

- **Recurring days:** Anchor on dense neighborhoods, up to 12 stops per tech, tight geography
- **One-time days:** Score-first ordering, accept wider geography, fewer stops per tech
- **Mixed days (default):** Recurring stops as backbone, one-time jobs fill in gaps by zone

## Shift Structure

- Start: 7:30–8:00 AM first stop
- No lunch break is scheduled (owner 2026-11-24); every clocked minute is paid. Do not hold a midday gap.
- End: auto-dispatch places no stop that ends after 5:00 PM (`DAY_CLOSE`); the paid day runs to about 6:00 PM
- Estimates/inspections: prefer 9–11 AM or 2–4 PM (customers more available)
