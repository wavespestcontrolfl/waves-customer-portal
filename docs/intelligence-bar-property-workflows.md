# Saved-property workflows through the Intelligence Bar

This phase adds three operations to the platform registry: save an additional
property, change its label/occupancy, and select a primary residence. They use
the same operations as the customer property editor. It does not establish
parity for other customer actions or complete the platform assignment.

| Capability | Portal entry | Shared operation | Approval and effects |
| --- | --- | --- | --- |
| Add property | Customer 360 → Property → Add service address | `customer-properties.addManualProperty` | Admin; complete address and dedupe; IB confirmation. Registers the old account property when needed, saves the additional property, and writes an audit. An addressless account receives a primary property and account address. |
| Relabel/change occupancy | Customer 360 → Property row | `customer-properties.editManualProperty` | Admin; exact property/customer relationship; IB confirmation of the current label/occupancy. No address relocation. |
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
`invoices.customer_address_snapshot` freezes that address before a manual primary
change; invoices created while the platform gate is enabled save their own
snapshot. Admin/public invoice loaders and invoice/receipt PDFs use it, including
email and project callers that supply a live customer object. Payer authority,
recipients, amounts, statuses, and permanent receipt tokens are unchanged.
Stored snapshots remain authoritative when the gate is turned off.

The operation takes the existing comms/customer/property locks, then acquires
invoice locks with `NOWAIT`. Billing and merge workflows use different invoice
lock orders, so contention produces a retryable refusal and rollback instead
of waiting in a deadlock. A duplicate-add refusal also rolls back any attempted
primary-address completion; a failed request does not leave a partial write.

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

The local preview is `http://127.0.0.1:5292/admin/customers` while the isolated
harness runs. Vite must run from `client/`, with its explicit proxy pointing to
the isolated API; starting it from the repository root omits Tailwind classes.
The earlier unstyled screenshots are superseded by the property browser run.

`20260906000062_invoice_customer_address_snapshot.js` was checked up/down/up in a
rolled-back transaction and applied only to the isolated development database.
`GATE_IB_PLATFORM` remains off by default. Production migration, gate activation,
merge and deployment are not authorized by this implementation assignment.
