# Schedule readiness strips

With `GATE_DISPATCH_READINESS=true` and `GATE_JOB_CARD=true`, Schedule's day
view shows compact Job Card exceptions on desktop and phone. Selecting a strip
opens the appointment's existing Protocol drawer. Short desktop blocks use
the Protocol button's position for an accessible exception icon; larger blocks
and phone rows show text. Completed, cancelled and skipped appointments are
not checked. Week and month views retain their existing presentation.

The page reads batches of at most six unique visit ids through the authenticated
`GET /api/admin/protocols/job-card/readiness?serviceIds=...` route. Each visit
uses the existing Job Card facts, booked plan, product weather verdicts, rig
resolution and unit-aware inventory snapshot. A technician's current assignment
is verified both before and after each build. Failures return an unavailable
check for that visit, without exposing customer facts, access codes, amounts or
vendor prices.

The summary skips paragraph generation and its cache write, distributor packs
and rotation copy. It performs no database writes, model calls, scheduling,
ordering or communications. Weather source reads retain the existing NWS/EPA
validation and caches. This stage adds no rate verification or calibration
expiry rule.

Stock means company inventory, not a truck count. Conditional unselected
products do not create planned shortages. Unknown quantities and incompatible
units remain unverified. Weather includes the Job Card's planned and conditional
products; a hold requires opening the card to see the applicable product.
Other dates say to check weather on the visit day. An empty exception list is
a link to the Job Card, never permission to apply.

Checks refresh after a schedule change, when returning to the visible page,
and every minute while it is visible. Refreshing clears prior verdicts; late
responses cannot cross schedule snapshots. Each batch has a 30-second client
deadline. A gate-off response hides the strips. Unset either gate to withdraw
the feature; no records or migrations need rollback.
