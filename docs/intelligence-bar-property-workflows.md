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
The following UI slice maps the four write/preview request sites to these tools;
other unmapped rows remain in the coverage denominator.

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

## Verification

The property database regressions are divided by behavior:

- `invoice-property-history-db.test.js`: triage contention and concurrent invoice
  creation, including receipt and PDF history.
- `customer-properties-db.test.js`: native primary eligibility, tenant refusal,
  legacy-row restoration, duplicate addresses, visit history and lock order.
- `intelligence-bar-properties-db.test.js`: scripted natural-language discovery,
  real authentication and confirmation, persisted receipts, A while viewing B,
  native/IB parity, stale tenant approval, replay and duplicate refusal.

The suites share the isolated-database fixture and use synthetic records. The
model is scripted; no live-provider or production rollout claim is made. The
contract and write-gate suites verify approval effects and tool registration.
Customer 360 controls and rendered coverage are the fourth replacement slice.

Split validation: all 6 IB PostgreSQL scenarios, 88 authorization/write-gate/tool-
definition tests and 12 scoped contract checks pass. Contract smoke invokes the
unconfirmed preview, as required by the two-step tool registry; only the real
confirmation route can persist the write. The domain scan is clean.

The add-property definition retains its length constraints without provider
strict mode, whose grammar rejects them. A regression checks the actual tool
projection and preserves the 200-character server address bound. Reference:
[Anthropic schema limitations](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations).
