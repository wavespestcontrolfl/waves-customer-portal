# Saved-property workflows through the Intelligence Bar

This phase adds three operations to the platform registry: save an additional
property, change its label/relationship/occupancy, and select a primary residence. They use
the same operations as the customer property editor. It does not establish
parity for other customer actions or complete the platform assignment.

| Capability | Portal entry | Shared operation | Approval and effects |
| --- | --- | --- | --- |
| Add property | Customer 360 → Property → Add service address | `customer-properties.addManualProperty` | Admin; complete address and dedupe; IB confirmation. Registers the old account property when needed, saves the additional property, and writes an audit. An addressless account receives a primary property and account address. |
| Relabel/change relationship or occupancy | Customer 360 → Property row | `customer-properties.editManualProperty` | Admin; exact property/customer relationship; IB confirmation of the current label/occupancy. No address relocation. |
| Select primary | Customer 360 → Property → Make primary | `customer-properties.changePrimaryProperty` | Admin; current impact preview required in both interfaces. Existing residential owner-occupied/unknown occupancy policy is retained. Commercial/rental/tenant properties cannot use this residence promotion. |

All three tools are discovered from other admin pages through the existing
registry. They do not send messages, create appointments, or initiate payments.
The coverage census maps the four write/preview request sites to these tools;
other unmapped rows remain in the denominator.

## Approval, persistence, and history

The preview is mutation-free and binds the normalized input, full-precision
customer/property versions, and the affected legacy invoice IDs. The existing
pending-action claim and contract hash protect against replay. Confirmation
recomputes the preview; the shared domain operation rechecks its version while
holding the customer and property locks. Read-back checks the stored fields and
primary/account address agreement before committing an audit and result.

Primary promotion extends `property-role-proposals.applyPropertyRoleProposals`.
Its existing pins preserve unstamped appointments and ongoing recurring roots;
historical service records are left intact. The new primary's address,
coordinates, and saved measurements become the account mirror. Occupancy and
irrigation-review effects are disclosed before confirmation.

Existing invoice documents previously read the live customer address. A nullable
`invoices.customer_address_snapshot` freezes that address in the shared primary
flip operation, including the existing triage path with the platform gate off;
every new invoice saves its own snapshot regardless of the platform gate.
This also protects a concurrent invoice insert that read the previous address
before a primary flip committed. Admin/public invoice loaders and invoice/receipt PDFs use it, including
email and project callers that supply a live customer object. Payer authority,
recipients, amounts, statuses, and permanent receipt tokens are unchanged.
Stored snapshots remain authoritative when the gate is turned off.

The operation takes the existing property-preferences/comms/customer/property locks, then acquires
invoice locks with `NOWAIT`. Billing and merge workflows use different invoice
lock orders, so contention produces a retryable refusal and rollback instead
of waiting in a deadlock. A duplicate-add refusal also rolls back any attempted
primary-address completion; a failed request does not leave a partial write.
Triage batches freeze before companion occupancy writes and leave the card open
on contention. Stale, already-applied and occupancy-only proposals do not freeze
invoices. A busy refusal keeps its operational error metadata through the portal
error handler and IB confirmation, producing a failed result rather than an
unknown outcome.

Database verification also exposed a pre-existing invoice detail query selecting
the nonexistent `customers.card_on_file` column. It now uses the default
`payment_methods` projection already used by the invoice list.

## UI behavior

Customer 360 has a touch/keyboard opener for the shell's existing bar. Record
overlays publish their customer on Customers, Dispatch, and Communications;
closing an overlay restores only a still-mounted page scope. Confirmed property
receipts refresh the matching open record and property list. A result for A
does not refresh B. Escape closes the topmost bar without closing Customer 360.
The primary impact dialog uses the shared Dialog and sits above the record drawer.
The server returns primary eligibility from the same guard used by the preview;
ineligible rows show a disabled control with a reason, refreshed after occupancy edits.
Initial loads and refreshes share request sequencing and customer guards, so
an older read or an A save finishing after navigation cannot replace B's profile.

## Evidence and limits

`server/tests/intelligence-bar-properties-db.test.js` exercises natural-language
task input through a **scripted model**, real bearer authentication, the actual
route/confirmation store, shared services, and isolated Railway development
Postgres. Independent row reads cover:

- Two new properties, relabeling and primary selection for A while viewing B;
  B remains untouched and service/invoice/receipt locations remain correct.
- Equivalent portal/IB add/edit outcomes and audit attribution, foreign-property
  rejection, stale approvals, replay and duplicate creation.
- Two-connection invoice-lock contention with a clean refusal, followed by a
  successful retry after the billing transaction releases its locks.
- An unregistered old account address and the first property on an addressless
  account, including mutation-free previews and stored-field verification.

`invoice-address.test.js` generates actual invoice and receipt PDFs and verifies
the text sent to PDFKit uses the stored address even when the caller supplies
the current customer. Contract tests exercise mutation-free previews, explicit
label clearing, strict registration, and approval classification.

Rendered tests cover confirmation, navigation races, target-scoped refresh and
overlay scope restoration, including overlapping same-customer refreshes and a
late save from a departed customer. Chrome/Playwright checks use 1440×1050 and 390×844
viewports against the actual client/API and synthetic Postgres fixtures, with a
controlled model and no live customer communications. They exercise IB add,
portal primary selection, IB relabel, touch opening, Escape, and refresh without
navigation. Screenshots/evidence are private under `.local/ib-properties-*`.
Ancillary payers/requests are not mounted in that harness; disabled thread reads
return 404. No live-model or real iOS keyboard claim is made.

Validation: 150 server unit tests across seven suites and four real-Postgres
acceptance tests passed. The five rendered client suites pass 61 tests. The
production build, portal-brand check and capability coverage check pass.
Independent review findings on label-clearing disclosure, invoice-lock
contention and profile-refresh races were fixed and covered by regression tests.

After integrating the reviewed foundation and PR #4015, the combined foundation
and property Postgres suites pass all 19 tests. The two legacy route/invoice
suites pass 56 tests after updating their mocks to the shared service contract;
13 bar tests and 24 profile-state tests also pass. Both browser viewports were
rerun successfully. The current census retains 1,734 sites after integrating
foundation read-scope and current-main email changes: four verified
property operations, ten transport exceptions, and 1,720 unsupported/unverified
domain sites.

Review remediation adds four further real-Postgres cases (eight property tests
passing): triage invoice preservation and atomic billing-contention rollback,
manual/IB busy outcome classification through the production error handler,
the preferences-before-customer lock order, and primary eligibility for rental,
commercial, seasonal, vacant and incomplete properties. The affected five server
unit suites pass 74 tests; the property panel passes 14 rendered tests. The build,
brand check and census pass. Desktop/mobile browser runs also exercise an
ineligible property becoming eligible after an occupancy edit.

A ninth Postgres case pauses the real invoice factory after its customer read,
commits a primary flip, then finishes the invoice insert with the platform gate
off. Persisted data, both invoice loaders and the actual PDF retain the original
address; an invoice created after the flip uses the new address. All nine cases
pass across the full-suite and corrected targeted fixture runs. Five invoice
unit suites also pass 82 tests, including pricing preview, tier and deposit
agreement. Static review found one production invoice insert, in the shared
factory. The existing additive migration must precede this code; no additional
migration or gate activation is required.

The local preview is `http://127.0.0.1:5292/admin/customers` while the isolated
harness runs. Vite must run from `client/`, with its explicit proxy pointing to
the isolated API; starting it from the repository root omits Tailwind classes.
The earlier unstyled screenshots are superseded by the property browser run.

`20260906000062_invoice_customer_address_snapshot.js` was checked up/down/up in a
rolled-back transaction and applied only to the isolated development database.
`GATE_IB_PLATFORM` remains off by default. Production migration, gate activation,
merge and deployment are not authorized by this implementation assignment.

The split foundation integration preserves the new upstream property relationship
field separately from occupancy, using the existing relationship vocabulary and
normalizer in both portal and IB writes. Confirmation effects show relationship
changes and clearing. First-property previews mirror the existing manager
default without inferring ownership from occupancy. The upstream relationship
migrations were dry-run and applied only in the dedicated QA database.

Current integration evidence: 137 server unit tests and 57 client tests passed;
two further approval-effect regressions passed. The ten property Postgres cases
passed across the full run and focused fixture/assertion reruns. Desktop/mobile
Chrome exercised the relationship disclosure, persisted relationship, IB creation
and relabel, portal occupancy/primary changes, touch opening and scoped refresh.
The current census retains 1,748 sites: four verified property operations, seven
IB transport exceptions and 1,737 unsupported/unverified sites. No historical
site was removed from the denominator.

Final foundation integration passes all ten property PostgreSQL scenarios in
one run (72.60 seconds), 142 server unit/contract tests and 61 client tests.
The production build and coverage/domain/portal-brand checks pass. Desktop
1440 and mobile 390 Chrome verify relationship disclosure, creation, primary
eligibility/selection, relabeling, focus and saved-state refresh. Screenshots
were inspected with vision. The harness's auxiliary payer/request/unread/thread
routes remain unavailable; there are no IB or property failures, JavaScript
exceptions or horizontal overflow. The model is scripted and physical iOS
keyboard/notch behavior remains unverified. Final GitHub Codex review is
pending its shared usage-limit reset; this remains a development-only draft.

The latest review corrections also cover a legacy account selecting its own
saved, non-primary address row, and completed visits already linked to the old
primary but missing their service-address stamp. Existing stamps and visits at
other properties remain untouched. The primary confirmation uses the Dialog's
layer prop so it stays above the Customer 360 overlay. Verification passes all
15 isolated PostgreSQL cases, 28 property unit tests and 16 panel tests. Chrome
at 1440 and 390 pixels confirms the dialog is visible and clickable over the
profile, with loaded fonts, no JavaScript exceptions and no horizontal overflow.
