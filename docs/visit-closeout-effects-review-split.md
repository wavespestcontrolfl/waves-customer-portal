# Visit closeout effects review split

PR #4023 remains the original, unmerged effects draft at `63e2c1b636`.
Its fifth review found three P1s and three P2s. The replacement stack starts
at the billing prerequisite, #4017, and keeps the approved outcome in
`docs/design/visit-closeout-phase2.md`.

1. **Billing finalization** carries the saved-invoice charge guard, payment
   claims and shared-invoice status readers. Recap-only members do not create
   covered-plan billing holds. Existing zero balances close through the invoice
   service's non-cash settlement path, without another account-credit movement,
   payment request or provider call. The original allocations remain available
   to the existing reversal and void paths.
2. **Member-effect recovery** carries canonical per-service completion and the
   existing packet recovery queue. Missing report tokens remain retryable;
   terminal immutable-form rejections become office exceptions. Interrupted
   operational effects must retain a durable retry path.
3. **Summary delivery** carries token persistence, projection, the email
   template, delivery claims and review enrollment. SMS intent comes from
   visible members. Email recovery uses existing recipient delivery identities
   to distinguish accepted, uncertain and proven-unsent recipients.

The first stage has no new production creation route or scheduler. Its database
tests seed the completed-member boundary directly; they do not claim member
effect or summary-delivery verification. Those behaviors belong to their
respective stages. The final technician/public-surface child, #4026, must be
retargeted only after the replacement stack is implemented and verified.

This work does not authorize a merge, production data changes, customer
communications or activation of grouped closeout. The original draft remains
available for comparison and review history.
