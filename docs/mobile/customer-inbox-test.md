# Owner-controlled inbox-only badge test

`POST /api/admin/notifications/customer-inbox-test` extends the existing
notification admin API. It is not a notification composer or delivery test.
No new binary, UI, table or migration is required.

The route requires the existing bearer staff authentication plus `requireAdmin`.
It is disabled in every environment unless `GATE_CUSTOMER_INBOX_TEST` is enabled
and `CUSTOMER_INBOX_TEST_CUSTOMER_ID` contains one valid UUID. An absent/malformed
configuration or a different target returns 404. Configure only the exact
owner-confirmed test customer; account/property siblings are not included.

Send `{ "customerId": "<confirmed UUID>" }` for a dry-run. It returns
`dryRun: true`, `wouldCreate: 2`, `createdCount: 0` without writing or consuming
the test. After inspecting that exact target, repeat with `"execute": true`.
Only literal booleans are accepted; extra fields are rejected. The caller cannot
choose content, count, link, recipient type or delivery channels.

The execute request creates exactly two clearly labelled Account inbox items
and an audit record in the same transaction. It calls `NotificationService.create`
with that transaction, not a customer-message sender. No push, SMS, email,
billing, visit or notification-preference operation runs. An insert or audit
failure rolls back the entire pair. Existing unread/read items are untouched.

The customer row lock serializes concurrent requests. An append-only audit
marker prevents another pair even after the original items are read or pruned.
Retries return `alreadyCreated: true`, `createdCount: 0` and the original IDs;
they never mark items unread again. This action has no reset/delete operation.
It refuses inactive, churned or deleted customers. Dry-run is a current-state preview,
not a reservation; execution checks eligibility and the one-shot marker again.

After deployment and owner-authorized activation, verify a dry-run first. If
the confirmed account still has zero unread, execute once and use the existing
customer inbox/read/count routes and iPhone Mirroring to observe 2 -> 1 -> 0.
Unexpected unrelated unread items mean the total will differ; never clear them
just to force a test count. Existing items keep their original read states.
These fixtures exercise inbox taps and local badge sync, not APNs delivery or
background badge updates while Waves is closed.

Revoke by unsetting `GATE_CUSTOMER_INBOX_TEST` and allow the normal Railway
redeploy. Removing the target variable also closes the route. Leave
`GATE_CUSTOMER_NATIVE_BADGES` and all other notification gates unchanged.
Use dev/preview PostgreSQL for agent verification; never connect an agent
directly to production to create or inspect fixtures.

Verification from `server/`: `npx jest --runInBand --coverage=false
tests/customer-inbox-test.test.js` checks the route's authority/input gates.
With only a verified private dev/QA `DATABASE_URL` selected, run
`npx jest --runInBand --coverage=false tests/customer-inbox-test-postgres.test.js`
for real auth, atomicity, concurrent retry and the existing 2 -> 1 -> 0 API flow.
CI's DB-gated-suite sweep includes the PostgreSQL test after a full migration.
