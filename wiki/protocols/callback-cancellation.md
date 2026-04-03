# Callback Protocol

**Summary:** Rules for handling retreat and callback jobs. Original tech gets first offer. Must complete within 5 business days. Score boost applied to protect renewal.

**Category:** protocols
**Tags:** callback, retreat, original-tech, renewal, 5-day-window

---

## Definition
A callback is any return visit where the customer reports the original treatment did not resolve the issue. Retreats are no-charge re-services.

## Assignment Rules
1. Route callback to the original tech first — always offer it before assigning elsewhere
2. If original tech unavailable same day: offer next available slot within 5 days
3. If original tech unavailable within 5 days: assign to best-rated tech for that service type
4. Never assign a callback to Tech 3 if the original service was Adam or Tech 2 — step down in capability is not acceptable

## Scheduling Rules
- Must complete within 5 business days of original service date
- Insert as priority stop — bump a low-score job if necessary
- Schedule in same time window as original visit when possible (same route cluster)

## Scoring
- Callback jobs receive +15 flat score boost
- Callbacks from Platinum/Gold customers receive additional +5
- Canceled account callbacks receive +20 (winback priority)

## Communication
- CSR calls customer within 2 hours of complaint
- Tech reviews original service notes before arriving
- Post-callback: escalate to different product or protocol if same issue recurs

---

# Cancellation Absorption Protocol

**Summary:** When a scheduled job cancels same-day, the route optimizer absorbs the gap by pulling the next best unscheduled stop into the open slot.

**Category:** protocols
**Tags:** cancellation, absorption, reoptimize, route-gap

---

## Steps
1. Mark job status = cancelled
2. Check unscheduled job queue for same date, same tech territory
3. If match found: assign to tech, insert at cancelled job's position
4. If no match: compress route (move stop N+1 forward), reduce drive time estimate
5. Log result with message for dispatch board

## Priority for Fill Jobs
1. Same zip cluster as cancelled job
2. Highest job score of available unscheduled jobs
3. Compatible with tech's license and service lines
4. Estimated duration ≤ cancelled job's duration + 15 min

## No-Fill Scenario
If no fill job available: tech finishes early. Do not add low-score filler jobs that hurt route efficiency.
