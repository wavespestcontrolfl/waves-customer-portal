# Combined visit closeout

## Approved outcome

For compatible services at one property, the customer selects one date and
arrival window. Scheduling reserves the time required for the entire selected
service mix. The technician closes the stop once. The customer receives one
organized summary, one itemized invoice, and one Auto Pay charge for that
invoice. Each service retains its own treatment record and recurring cadence.

This is the outcome approved in the implementation conversation. Existing
comments referring to one visit payment across separate invoices describe an
older design. The invoice for this lane must be a single invoice containing
the eligible service lines; do not implement a second payment-allocation system.

The owner approved a 60-minute booking allowance **per service** for combined
stops. Two services reserve 120 minutes, three reserve 180 minutes, and larger
mixes must not be truncated to the old 180-minute picker cap. Keep each member's
start on the hour and allocate the work sequentially. This is booking capacity;
the customer arrival window remains the shared start plus 120 minutes.
`GATE_VISIT_COMBINED_CAPACITY` requires `GATE_SEPARATE_COMBO_VISITS` so every
selected application has its own service record. Billing riders do not add work
hours; scheduling uses the converter’s physical service units. Combined selections
with unsupported converter families or cadences are refused before a hold.
Creation defaults off.

## Existing mechanisms to extend

- `services/visit-groups.js`: stop identity, membership locks, frozen membership,
  movement, reminder fanout, and refusal of legacy completion when a packet exists.
- `services/visit-combine.js`: office grouping and sequential service placement.
- `services/appointment-reminders.js` and its existing database sync/promotion
  functions: one shared arrival promise, reminder ownership, and cancellation
  handoff, including customers outside the Phase 1 visit-grouping cohort.
- `services/complete-scheduled-service.js`: canonical single-service validation,
  ownership, completion claims, durable writes, and resumable side effects.
- `services/completion-attempts.js`: existing idempotency and recovery protocol.
- `visit_completion_packets`, `visit_completion_packet_items`, `visit_effects`:
  persisted stop-level completion and effect state already created by the Phase 1
  migration. Inspect and extend these instead of adding parallel claim tables.
- `services/invoice.js`, `scheduled-invoice-mint.js`, `billing-lane.js`, and the
  existing Stripe invoice charger: invoice creation, tax, credits, eligibility,
  surcharge, payment retry, and receipt authority.

Paths above are relative to `server/`.

## Reviewable implementation stages

1. Extract the existing completion flow from `routes/admin-dispatch.js` into the
   service named above. Keep the current endpoint and request/response contract.
   Return `{ status, body }` from the service and throw unexpected errors. Pass
   authenticated actor information separately from the submitted body. Migrate
   internal tests to the functions' actual owners. No grouped billing is enabled
   by this prerequisite.
2. Make the booking hold represent all selected work. Reuse the existing slot
   reservation, technician eligibility, and technician-day conflict locks.
   Revalidate selected services at acceptance. A group must reserve sequential
   work time for one technician; overlapping member windows alone do not prove
   enough capacity. Keep the customer arrival window separate from work duration.
3. Add stop-level closeout using the existing packet and item tables. Validate
   every member before committing work. Freeze the member set and submitted
   outcomes under the existing stop/member locks. Retain service-specific forms,
   records, products, and required compliance documents. Refuse individual legacy
   completion once a packet owns a service.
4. Add one invoice containing the eligible completed service lines. Link every
   billed member to that invoice using durable server-owned identity. Existing
   single-service completion, billing sweeps, and retry paths must recognize that
   ownership and must not mint or charge a second invoice. Reuse existing tax,
   deposit, prepaid-credit, payer, and surcharge authorities; do not sum displayed
   quote values or client-supplied totals.
5. Add one customer summary and use the existing invoice charger and receipt
   sender once. Persist effect claims before external work and use the same
   identities on retries. Resume a saved closeout instead of rerunning completed
   service writes, inventory deductions, credit applications, or charges.
6. Add the technician stop sheet and customer summary surface. Enable Auto Pay
   grouping only with the full flow verified. Use the standard default-off gate
   mechanism; turning off creation must not strand previously committed packets.

## Required edge cases

- A skipped or postponed service is not billed merely because another member
  completed. Product-bearing incomplete work retains its required treatment
  record; apply existing billing rules, and surface ambiguous billing for review.
- Seasonal services whose first date differs are separate stops.
- A service that needs another technician or lacks a valid price cannot silently
  inherit the other service's assignment or price.
- A paid, refunded, prepaid, payer-billed, or already invoiced member must follow
  its existing financial contract. Unsupported combinations fail before charging
  and surface an office exception; they never charge again to simplify grouping.
- Concurrent closeouts, double taps, retries after provider timeouts, late Stripe
  webhooks, and gate changes must all converge on the same invoice/payment.
- Preserve all deployed native app and public token contracts. Specialty
  compliance documents remain available even when the summary groups services.

## Verification and rollout

Use synthetic records in a dedicated Railway dev/preview database. Prove
combined occupancy and conflict checks; packet locking; single durable treatment
records; invoice line totals, tax, and credit allocation; one charge under retry;
and one summary/receipt delivery with integrations isolated. Exercise desktop and
mobile closeout, partial outcomes, and retry states. Migrations require real
Postgres checks before claiming the lane verified.

Implementation approval covers building the changes. Merging the money changes,
enabling the customer-facing gate, and sending customer communications remain
separate rollout actions under the repository's shipping rules.
