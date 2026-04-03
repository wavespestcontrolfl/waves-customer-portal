# Routing Rules — Waves Pest Control

**Summary:** Core routing logic for daily dispatch optimization in Southwest Florida. Covers cluster grouping, re-optimization triggers, drive time targets, and job ordering principles.

**Category:** protocols
**Tags:** routing, dispatch, optimization, clusters, drive-time, zone, territory

---

## Territory Clusters

**North cluster (Adam primary):**
- Parrish: 34219, 34221
- Bradenton: 34208, 34209, 34210, 34211
- Lakewood Ranch: 34202, 34240

**South cluster (Tech 2 primary):**
- Sarasota: 34229, 34231, 34232, 34233, 34234, 34235, 34237, 34238, 34239, 34241, 34242
- Venice: 34285, 34292, 34293
- North Port: 34286, 34287, 34288, 34289 (Tech 3)
- Port Charlotte: 33948, 33952, 33980, 33981 (Tech 3)

## Route Building Order

1. Group all jobs for the day by tech territory
2. Score each job using the job scoring formula
3. Anchor first stop: highest-score job nearest to tech's home zip
4. Subsequent stops: maximize cluster density × job score — minimize backtracking
5. Place high-score jobs (≥80) at natural positions — never bury them after low-score stops
6. Recurring jobs form the backbone; one-time jobs slot into geographic gaps
7. Inspection/estimate jobs get dedicated time blocks — never back-to-back with full service jobs
8. Maximum 10 stops per tech per day

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

- **Recurring days:** Anchor on density clusters, 6–8 stops per tech, tight geography
- **One-time days:** Score-first ordering, accept wider geography, 4–6 stops per tech
- **Mixed days (default):** Recurring stops as backbone, one-time jobs fill in gaps by zone

## Shift Structure

- Start: 7:30–8:00 AM first stop
- Break window: 11:30 AM–12:30 PM — avoid scheduling stops 11:45–12:15
- End: Last stop no later than 5:00 PM
- Estimates/inspections: prefer 9–11 AM or 2–4 PM (customers more available)
