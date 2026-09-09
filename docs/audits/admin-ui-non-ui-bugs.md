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
