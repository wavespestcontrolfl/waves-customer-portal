# Intelligence Bar data-scope catalog

Every Intelligence Bar tool declares a `scope` in
`server/services/intelligence-bar/action-policy.json`: the class of customer
data it can reach. `server/services/intelligence-bar/scope-policy.js` reads the
declaration; `task-context.js` enforces it inside a customer-scoped task (a task
where the operator named, selected or viewed a specific customer); the action
registry refuses to load a tool whose scope is missing or invalid for its kind.

This replaced six hand-kept name lists in `task-context.js`
(`BROAD_CUSTOMER_ROW_READERS`, `SCOPED_CUSTOMER_ROW_READERS`,
`ACTOR_WIDE_READERS`, `PHONE_KEYED_READERS`, `EMAIL_KEYED_READERS`,
`ROUTE_WIDE_WRITERS`). Review rounds on the platform stack kept surfacing one
more unlisted reader per round; with a required per-tool field, a new tool
cannot exist without a reviewed class, and a tool in no class fails closed.

## Classes

Read tools (`kind: read`):

| scope | meaning | inside a customer-scoped task |
|---|---|---|
| `none` | touches no customer-identifying rows (infra, SEO, catalogs, pure totals) | unrestricted |
| `record` | reads one customer's records through a customer or record selector | a selector-free call inherits the single task customer; refused (`customer_scope_required`) when an explicitly named customer did not resolve and no selector was supplied |
| `scoped` | confines its rows to the task's read scope (`readCustomerIds`) | refused when an explicitly named customer did not resolve, since the scope would be empty |
| `broad` | lists other customers' identifiable rows and takes no selector | refused whenever the request is customer-specific (resolved target, unresolved name, or a phone/email literal) |
| `actor_wide` | the operator's own conversation history, quoting any customer | refused whenever the request is customer-specific |
| `phone_keyed` / `email_keyed` | keyed by a contact | the key must belong to a task customer (`target_clarification_required`); refused when the named customer did not resolve |

Write tools (`kind: internal_write` or `external_action`):

| scope | meaning | inside a customer-scoped task |
|---|---|---|
| `none` | touches no customer records | unrestricted (still subject to its approval gate) |
| `record` | acts on specific customer records | every referenced record must belong to a task customer (`validateRecordTarget`) |
| `route_wide` | acts on every stop for a date or technician, no record ids | refused (`customer_scope_required`), also for an unresolved explicit name |

A tool the catalog does not know, or whose scope does not fit its kind, is
refused with `scope_unclassified` by `prepareReadInput` and
`validateRecordTarget`, and never joins `ActionRegistry.actions` (so it is
also `capability_unimplemented` to the model).

## Where the rules are asserted

- `server/tests/intelligence-bar-action-registry.test.js` freezes the
  membership of every non-`none` class (`SCOPE_SNAPSHOT`), asserts every policy
  entry has a valid scope, asserts a reader whose schema takes `customer_id` or
  `customer_name` is `record` or `scoped`, and proves a missing or invalid scope
  keeps a tool out of the registry.
- `server/tests/intelligence-bar-target-context.test.js` runs one
  representative per class through resolved, unresolved and unnamed customers,
  and proves an unclassified reader or writer is refused in all three.

## Adding or reclassifying a tool

1. Decide the class from what the executor returns, not from the description.
   Any per-customer row (name, id, phone, email, address, balance, appointment)
   for customers other than a selected one, with no selector, is `broad`.
   Technician names, vendors, products and totals are not customer data; lead
   rows are.
2. Add or change `scope` in `action-policy.json`.
3. Update `SCOPE_SNAPSHOT` in the registry test for any class other than `none`.

## Deferred

- `find_available_slots` is `record` (its `customer_id` is a destination, and
  a selector-free call already fails closed for an unresolved name), but the
  slots it returns name the neighbouring stops' customers
  (`find-time.js` `insertion.after_name` / `before`). Redacting those names, or
  moving the tool to `broad`, is a policy decision this catalog does not make.
- `get_railway_logs`, `get_sentry_issue_detail` and `get_managed_agent_runs`
  are `none` because they return no structured customer rows, but each carries
  free text (log lines, exception messages, run titles) that could
  incidentally quote a customer identifier.
- `assign_technician`, `move_stops_to_day`, `bulk_update_customers` and
  `bulk_update_leads` act on many customers at once but carry record ids that
  `validateRecordTarget` checks per customer, so they stay `record` rather than
  `route_wide`; the bulk-lead dry-run cohort path depends on that.
