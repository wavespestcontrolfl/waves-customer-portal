# Invoice address history during primary-property changes

Invoices store a nullable `customer_address_snapshot`. Existing invoices receive
that snapshot when the shared property-role writer changes a primary residence;
new invoices retain the address read when they were created. Invoice detail,
receipt and PDF readers use the snapshot even when a caller supplies the live
customer. Payer selection, amounts, recipients and permanent receipt tokens keep
their existing behavior.

The primary-role writer takes property-preferences, comms and customer locks,
then freezes legacy invoices with `NOWAIT`. A billing conflict rolls the whole
batch back, including companion occupancy changes, and leaves the triage card
open with a retryable `property_busy` response. Stale, already-applied and
occupancy-only batches do not snapshot invoices.

The existing migration is carried unchanged from the reviewed property stack.
This split introduces no replacement migration or production rollout decision.
The invoice detail query also uses the default payment-method projection already
used by the list; the old `customers.card_on_file` projection did not exist.

`invoice-property-history-db.test.js` uses isolated PostgreSQL and synthetic
records to verify triage contention, atomic rollback, no-op batches, permanent
receipt content and a concurrent invoice mint. `invoice-address.test.js` checks
invoice and receipt PDF text when the supplied customer has a different address.
The shared test fixture blocks non-development databases and scripts the model.

This is the first of four replacements for #4021: invoice history, shared saved
properties, Intelligence Bar property actions, and Customer 360 controls. The
weekday arrival-window fixture correction is retained for the same CI baseline.

Split validation: both PostgreSQL scenarios and all 91 invoice/address/role unit
tests pass. The domain scan is clean. No production migration was run.
