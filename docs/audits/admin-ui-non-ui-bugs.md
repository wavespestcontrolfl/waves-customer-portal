# Non-UI bugs found during admin UI migration

Separate follow-up register requested by the owner. Keep functional/data defects here rather than folding backend or business-rule changes into visual migrations. Add evidence and verification limits; distinguish confirmed code behavior from database/provider reproduction. UI-only findings and their fixes belong in each migration's acceptance record.

## ADMIN-BUG-003 — Equipment financial endpoints do not enforce the owner-only UI restriction

- **Status:** Fixed for review in [PR #4231](https://github.com/wavespestcontrolfl/waves-customer-portal/pull/4231); separate from the Equipment UI migration.
- **Priority:** P1 — authenticated technicians can reach financial reads that the UI reserves for the owner.
- **Found:** September 9, 2026; equipment baseline `a785d48596ff0c01debcbb6b750c2bed3bddb1b4`.
- **Source:** `client/src/pages/admin/EquipmentPage.jsx`, `OWNER_ONLY_EQUIPMENT_TABS`; `server/routes/admin-equipment.js`, `/job-costs` and `/job-costs/summary`; `server/routes/admin-equipment-maintenance.js`, analytics handlers; `server/middleware/admin-auth.js`.
- **Trigger:** An authenticated active technician requests the job-cost list or summary directly instead of using the hidden Costs group.
- **Actual:** The page declares financial leaves owner-only, but these routes only use `adminAuthenticate, requireTechOrAdmin`. The job-cost handlers contain no owner check before querying and returning revenue/cost/margin data. Authentication checks employment and token validity, but supplies no path-specific financial restriction.
- **Expected:** Enforce the approved owner-only financial policy at the API boundary while preserving technician access to supported operational equipment screens.
- **Evidence:** Code trace from the server mounts through the shared middleware and the list/summary handlers. No database or live technician account was used; this establishes the missing authorization guard, not a production data-exposure reproduction. Maintenance overview also feeds the technician-accessible fleet screen. The owner confirmed retaining the existing maintenance/fuel/book-value fields in that operational view.
- **Fix and validation:** Admin guards cover all eight financial read/write methods, including the legacy dashboard summary. Real JWT/shared-auth tests with a mocked database cover anonymous 401, technician 403, forged-role claims, admin success, and five operational reads plus two writes remaining available to technicians. The focused server run passed 42 tests; final-head CI and Codex review passed. No live data-exposure or database integration test was performed.

## ADMIN-BUG-004 — Equipment date-only values shift days in Eastern time

- **Status:** Fixed for review in [PR #4238](https://github.com/wavespestcontrolfl/waves-customer-portal/pull/4238); presentation-only drafts preserve their original date behavior until integration.
- **Priority:** P2 — equipment dates can display the previous day, and evening calibration verification can default to the following day.
- **Found:** September 9, 2026; equipment baseline `a785d48596ff0c01debcbb6b750c2bed3bddb1b4`.
- **Source:** `client/src/pages/admin/EquipmentMaintenancePage.jsx`, purchase/warranty/due-date formatting; `client/src/pages/admin/EquipmentCalibrationPanel.jsx`, `todayInputValue` and the `verified_at` payload.
- **Trigger:** Render a date-only value through `new Date(value).toLocaleDateString()` in America/New_York, or open calibration verification after the UTC calendar has advanced beyond the local day.
- **Actual:** The synthetic asset's purchase date `2024-01-01` remains January 1 in the edit dialog but displays December 31, 2023 in maintenance details. At September 9, 2026, 11:30 p.m. Eastern, `toISOString().slice(0, 10)` defaults verification to September 10; the save payload then uses that chosen day.
- **Expected:** Preserve the recorded calendar day for date-only fields and derive the default verification day in Eastern time, distinguishing those values from actual timestamp fields.
- **Evidence:** Chromium/WebKit synthetic screenshots and a deterministic Node reproduction under `TZ=America/New_York`. The existing date helper and serialized verification payload matched the starting commit. No database or live calibration was changed.
- **Fix and validation:** Canonical client helpers preserve date-only fields, use Eastern verification defaults, and serialize selected noon Eastern as an explicit UTC instant. Eight component tests plus four existing date-helper tests passed under both UTC and Eastern process timezones (24 executions). Synthetic desktop/phone captures confirm January 1 purchase dates and the Eastern evening default. Final-head CI and Codex review passed; no live calibration or database migration was run.
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
