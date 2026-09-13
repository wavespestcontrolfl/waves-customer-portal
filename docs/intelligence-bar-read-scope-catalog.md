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
| `record` | reads one customer's records through a customer or record selector | a selector-free call inherits the single task customer; refused (`customer_scope_required`) when the request was customer-specific (a name, or a phone/email literal) but nobody resolved and no selector was supplied |
| `scoped` | confines its rows to the task's read scope (`readCustomerIds`) | refused when the request was customer-specific but nobody resolved, since the scope would be empty |
| `broad` | lists other customers' identifiable rows and takes no selector, or returns provider/operations text that can echo customer identifiers (alert bodies, error text, log lines, targeting predicates, trip traces, call quotes keyed by call id) | refused whenever the request is customer-specific (resolved target, unresolved name, or a phone/email literal) |
| `actor_wide` | the operator's own conversation history, quoting any customer | refused whenever the request is customer-specific |
| `phone_keyed` / `email_keyed` | keyed by a contact | the key must belong to a task customer (`target_clarification_required`); refused when the named customer did not resolve |
| `address_keyed` | keyed by a street address (`lookup_property`) | the address must be one of the task customers' ACTIVE saved properties (customer address or service property), compared as a full address by the estimator's canonical comparer (same street, exact unit, no conflicting city or ZIP), and the reader receives the saved property's full address rather than the supplied text, so a substituted, partial or same-street-different-city address cannot expose or price another property; a saved row with neither city nor ZIP cannot verify a locality and never binds, every city, state or ZIP the supplied text carries must be present on the saved row and equal to it, and a bare street line that matches two different saved parcels binds neither; refused when the named customer did not resolve; open outside a customer-scoped task, where new leads have no saved address yet |

Write tools (`kind: internal_write` or `external_action`):

| scope | meaning | inside a customer-scoped task |
|---|---|---|
| `none` | touches no customer records | unrestricted (still subject to its approval gate) |
| `record` | acts on customer records | every record it references must belong to a task customer (`validateRecordTarget`); a writer that references none at proposal time (creating a customer or estimate, or a cohort the route has already resolved to ids) is admitted on that basis, so the class proves referenced records, not that a reference exists |
| `route_wide` | acts on every stop for a date or technician, no record ids | refused (`customer_scope_required`), also for an unresolved explicit name |

A tool the catalog does not know, whose scope does not fit its kind, or whose
`kind` is not one of `read` / `internal_write` / `external_action`, is refused
with `scope_unclassified` by `prepareReadInput` and `validateRecordTarget`
(which requires a tool name; a call without one is refused the same way), and
never joins `ActionRegistry.actions` (so it is also `capability_unimplemented`
to the model).

The route's PII set (`server/services/intelligence-bar/pii-tools.js`, used
to redact query telemetry and log only field names) is DERIVED from this
catalog: every tool whose scope is not `none` is a PII tool. The file also
keeps a reviewed list explaining why particular tools carry identifiers; the
registry test asserts each reviewed name has a non-`none` scope and that the
derived set equals the non-`none` tools exactly, so a reader that returns
customer identities is covered by its class rather than by a hand-kept
inventory (round 3 found `get_ar_aging`, `get_outstanding_balances`,
`get_top_revenue_customers` and `get_open_commitments` missing from the
old list).

## Where the rules are asserted

- `server/tests/intelligence-bar-action-registry.test.js` freezes the
  membership of every non-`none` class (`SCOPE_SNAPSHOT`), asserts every policy
  entry has a valid scope, asserts a reader whose schema takes `customer_id` or
  `customer_name` is `record` or `scoped`, asserts the PII set is exactly the
  non-`none` tools and every reviewed PII name is non-`none`,
  and proves a missing or invalid scope (or kind) keeps a tool out of the
  registry.
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

## Classification notes

- `compute_estimate` is `record`: with `leadId` it returns that lead's matched
  customer account (customer id, tier, active services, spend), so the lead is
  bound to the task customer like any other record reference. Without a lead it
  is a pure pricing engine and stays available.
- `block_sender` is a `record` write with no record id; `validateSenderBlock`
  binds it to the task customer's own address.
- `merge_customers` is `record`: its two role-named ids (`winner_customer_id`,
  `loser_customer_id`) are mapped to the customer collection by
  `validateRecordTarget` (`CUSTOMER_PAIR_SELECTORS`), so both halves are loaded
  and version-stamped. The task establishes at most one customer target, so
  only ONE half of the pair needs to already belong to the task — the task
  customer is either the winner or the loser (the stub page or the real
  customer's page). The OTHER half is admitted only when it is a live,
  eligible duplicate-queue candidate under that exact pairing, per
  `customer-dedupe.js`'s canonical `duplicatePairEligibility` (never
  re-derived in task-context.js) — a red-tier, out-of-queue, or
  address-conflicted pairing is refused like any other foreign record, and so
  is a pairing where neither id is the task's customer. An unreadable
  dismissals table answers `dismissals_unreadable` (fail-closed) — never an
  admitted pair.
- Operations and provider readers whose text can echo customer identifiers
  (`get_twilio_alerts`, `get_scheduled_job_health`, `get_railway_logs`, the
  three Sentry readers, the two GrowthBook readers, `get_managed_agent_runs`,
  `get_truck_trips`) and `search_call_research` (call quotes keyed by
  `call_log_id`) are `broad`: unavailable inside a customer-scoped task, open
  otherwise.

## Deferred

- `find_available_slots` is `record`: inside a customer-scoped task the
  destination is pinned to the task customer (supplied `lat`/`lng` are
  dropped so the reader resolves the customer's own coordinates, and a
  supplied `address` must be one of the customer's active saved properties
  and is replaced by that saved address together with the property's stored
  coordinates; the executor treats an explicit address as the destination and
  geocodes it when no coordinates came with it, rather than falling back to
  the primary address). Outside a customer-scoped task the
  slots it returns still name the neighbouring stops' customers
  (`find-time.js` `insertion.after_name` / `before`) around whatever location
  the operator asked about. Redacting those names, or moving the tool to
  `broad`, is a policy decision this catalog does not make.
- `find_schedule_gaps` is `record`: with `candidate_service_id` it loads that
  appointment's customer preferences, plan holds and location, so the
  candidate is validated as an appointment reference that must belong to a
  task customer. Without a candidate it returns per-technician minute
  budgets only: the IB executor strips the measurement's planned-stop ids,
  visit ids and arrival windows (kept for the route-performance ledger), the
  missing-coordinate and default-duration id lists (now counts) and the ids
  on late-visit rows, so a date-only call reads no
  customer-identifying rows and stays open for a resolved, unnamed or
  unresolved task ("gaps for Labor Day" reads "Labor" as a name;
  `SELECTOR_FREE_READS_NO_CUSTOMER_ROWS` in task-context.js).
- `get_expenses` and `get_vendor_invoices` are `broad`: job-expense descriptions
  are operator free text that can name a customer or address (expense rows
  can be tied to a customer), and vendor-invoice rows carry sender names,
  addresses and subjects like the other email readers. Mileage and activity
  readers return aggregates only and stay `none`.
- `search_field_intelligence`, `search_knowledge_base`, `get_restock_queue`,
  `recent_pricing_changes`, `get_estimate_funnel` and `get_lost_analysis` are `broad` (self-sweep of
  every `none` reader after round 11): each returns operator free text
  verbatim — technician notes, call-research snippets and knowledge-entry
  summaries and content snippets (heuristically redacted only; both search
  tools return them), restock request reasons, pricing
  changelog summaries and rationale, the estimate `service_interest` group
  key, and `lost_reason` — and a name or address can be typed into any of
  them. `compare_technicians` stays `none`: its `cities` value is a
  de-duplicated aggregate of service-area cities, not a customer location.
- `get_ad_attribution` and `get_customer_acquisition` are `broad`: they group
  by `customers.lead_source`, an operator free-text label ("Referral —
  <name>") returned verbatim; `get_source_performance` stays `none` because
  it reads the `lead_sources` catalog. `get_commit_info` and
  `get_recent_merged_prs` are `broad`: commit messages and PR titles are
  developer free text where customer details have appeared (AGENTS.md).
  `get_social_channel_status` (post titles) and `get_gbp_status` (local-post
  summaries) return business-authored free text verbatim and are `broad`, as
  do the SEO readers that return blog or page titles, target keywords and
  concept labels (`get_content_pipeline`, `get_content_workflow_brief`,
  `query_blog_performance`, `get_content_decay_alerts`, `query_seo_rankings`,
  `inspect_url`, `get_semantic_concept_map`), the readers that return raw
  Search Console queries (`query_top_queries`, `intent_routing_report`), the
  advertising readers that return campaign, ad-group and ad names and provider
  issue messages (both Google Ads and both Meta readers), and
  `get_cloudflare_pages_builds` (deployment branch names),
  `get_backlink_overview` (third-party anchor text and agent-written strategy
  summaries), `get_integration_token_health` (provider error messages, like
  the Sentry and Twilio readers) and `get_play_store_status` (human-typed
  release names). The remaining SEO and infrastructure readers return URLs,
  counts, statuses and scores and stay `none`.

  The line the sweeps draw: **per-item free text typed or echoed about an
  event or an item** — descriptions, reasons, notes, messages, titles, search
  queries, campaign/ad/branch/release names, error text — is `broad`, because
  a customer's name or address can be typed into it. **Business catalog
  labels** — product, vendor, technician, pricing-tier, equipment, lead-source
  and infrastructure service names — are `none`: they name the business's own
  things, and a catalog reader that lists them touches no customer row.
  Aggregates keyed by such labels (technician revenue, vendor pricing, tax
  advisor prose generated from equipment and revenue tables only) stay
  `none` for the same reason.
- A word after "for" is a filter rather than an unresolved customer when the
  database verifies it as a customer city, an active technician, a vendor or
  expense vendor, a lead source name or channel, or it is a known marketing
  channel word, and no customer carries it as a name
  (`verifiedFilterWords`), so "expenses for SiteOne" or "attribution for
  Facebook" reach the now-`broad` analytics readers.
- `get_truck_status` is `broad`: the live last position of a truck during
  service hours is a customer's property, so it is refused inside a
  customer-scoped task like `get_truck_trips`.
- `assign_technician`, `move_stops_to_day`, `bulk_update_customers` and
  `bulk_update_leads` act on many customers at once but carry record ids that
  `validateRecordTarget` checks per customer, so they stay `record` rather than
  `route_wide`; the bulk-lead dry-run cohort path depends on that.
