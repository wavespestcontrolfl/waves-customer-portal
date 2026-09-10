# Non-UI bugs found during admin UI migration

Separate follow-up register requested by the owner. Keep functional/data defects here rather than folding backend or business-rule changes into visual migrations. Add evidence and verification limits; distinguish confirmed code behavior from database/provider reproduction. UI-only findings and their fixes belong in each migration's acceptance record.

## ADMIN-BUG-001 — Unrelated invoice can block marking a status-only visit free

- **Status:** Open; not changed by the billing UI migration.
- **Priority:** P1 — valid billing-recovery action can be refused.
- **Found:** September 9, 2026; foundation source `0c6337adc683d14ce046a3b391dafa7e248dd2fe`.
- **Source:** `server/routes/admin-billing-recovery.js`, `POST /:scheduledServiceId/dismiss`, invoice lookup inside the transaction (original lines 578–583).
- **Trigger:** A completed visit has no `service_records` row, so `visit.service_record_id` is null. An unrelated non-void invoice also has a null `service_record_id`.
- **Actual:** The lookup includes `service_record_id IS NULL OR scheduled_service_id = <selected visit>`. The unrelated invoice matches; the handler returns 409, “Visit is already invoiced,” although this visit is not invoiced.
- **Expected:** Only invoices attached to the selected visit or its existing, non-null service record block dismissal.
- **Evidence:** Generated the exact Knex query locally with `{client:'pg'}` and a synthetic visit ID: `select * from "invoices" where ("service_record_id" is null or "scheduled_service_id" = ?) and not "status" = ? limit ?`. This confirms SQL generation; no database was connected.
- **Follow-up:** Keep the visit predicate; add the service-record alternative only when an ID exists. Add a server regression with a status-only visit and an unrelated invoice with a null record ID, while retaining genuine-invoice rejection and the existing advisory lock.

## ADMIN-BUG-002 — Offline payment amount accepts a partial numeric prefix

- **Status:** Open; validation/payload behavior preserved in the billing UI migration.
- **Priority:** P2 — malformed input can be submitted as a different amount.
- **Found:** September 9, 2026; same foundation source.
- **Source:** `client/src/pages/admin/PayerDetailSheet.jsx`, `ReconcileForm` (`parseFloat(amount)` and its `valid` check); server reconciliation in `server/routes/admin-payers.js` only receives the parsed number.
- **Trigger:** Enter `100abc`, `100,50`, or `1,000.00` in the text Amount field.
- **Actual:** JavaScript parses these as 100, 100, and 1 respectively; all pass the client's positive-finite check. The original string is lost before the request. The server's locked-total tolerance rejects many mismatches, but cannot detect trailing garbage when the parsed amount matches a statement total.
- **Expected:** Validate the complete input according to a deliberate accepted currency format; reject malformed strings before constructing `{method, amount}`.
- **Evidence:** Local JavaScript reproduction confirmed `parseFloat('100abc') === 100` and `parseFloat('1,000.00') === 1`. No payment or reconciliation request was sent to a backend.
- **Follow-up:** Define whether grouping separators are accepted, validate the entire string, and cover malformed, blank, decimal and grouped input without changing the server's settlement safeguards.
