# Intelligence Bar operator workflows: contracts, manifests, matrix and evidence

PR 0 of the Intelligence Bar ten-workflow scope (owner-approved October 2, 2026). The scope's hypotheses are written down here, not in an outside document: the per-workflow contracts below, and the expected admin and technician cells in `MATRIX` (`server/tests/fixtures/ib-workflows/execution-matrix.js`), which the test compares with the code. This page holds the ten request contracts, the execution-mode matrix, the evidence status for each workflow and the read-only request tally. It changes no runtime behavior. The 200 scenario cases (the manifests) and the harness that executes them are in the same branch as the manifest shape below; the matrix and the tally were split out and merged separately (#5626).

- **Inspected commit:** `60655b1ec9` (origin/main on October 2, 2026, as merged into this branch). The matrix below is computed from that commit by `server/tests/intelligence-bar-workflow-matrix.test.js`; it is not a claim about production or about any open pull request.
- **On this commit:** owner-direct mode (#5563) is merged, dark behind `GATE_IB_OWNER_DIRECT` (direct commits also ride on `GATE_IB_PLATFORM`). The owner cells below are derived from `server/services/intelligence-bar/owner-direct.js` (`OWNER_DIRECT_TOOL_NAMES`, `executesWithoutCard`), not typed in. Nothing here says either gate is on in production.
- **Not on this commit:** a handful of capabilities the target behavior needs (a series move, a server-rendered move notice, a booking property pin, an estimate measurement selector, a linked secondary number, the W9 reader). Each is a named gap, listed below; the cases that need one carry it and stay scored targets.
- **No production access** was used to build this. Nothing in the manifests names a real customer, address, phone number, email or gate code; fixture keys are synthetic.

## What is in the PR

| Piece | Where |
| --- | --- |
| Scenario manifests, W1 to W10 (200 cases) | `server/tests/fixtures/ib-workflows/W1.json` to `W10.json` |
| Matrix data and renderer, plus the case helpers (capability gaps, call lists, the write-call schema check) | `server/tests/fixtures/ib-workflows/execution-matrix.js` |
| Matrix and tally test | `server/tests/intelligence-bar-workflow-matrix.test.js` |
| Manifest contract test (shape, row references, write calls, gaps, partition table) | `server/tests/intelligence-bar-workflow-manifest.test.js` |
| Read-only request tally | `scripts/ib-request-tally.js` |
| This page | `docs/intelligence-bar-operator-workflows.md` |

Run the matrix test with `npm exec jest -- server/tests/intelligence-bar-workflow-matrix.test.js --runInBand` and the manifest contract test with `npm exec jest -- server/tests/intelligence-bar-workflow-manifest.test.js --runInBand`. After a deliberate matrix change, `UPDATE_IB_MATRIX_DOC=1` rewrites the table between the matrix markers below; without it the test fails if the table is stale.

## Manifest shape

One JSON file per workflow. Top level: `schema_version`, `workflow`, `title`, `inspected_commit`, `contract` (tools and binding rulings), `fixtures` (the synthetic data sets the cases refer to), `required_corrections` (the section 2.2 correction cases that must be covered) and `cases`.

Each case:

| Field | Meaning |
| --- | --- |
| `id` | `W3-dev-04`: workflow, partition (`dev` or `held`), sequence |
| `origin` | The originating example. Paraphrases share an origin and stay in one partition |
| `kind` | `read` or `write` |
| `request` | Operator wording: no tool names, no ids |
| `fixture` | Which fixture set the case runs against |
| `page_context` | `none`, `customer:<key>`, `lead:<key>` or `visit:<key>` (synthetic keys) |
| `actor` | `owner`, `admin` or `tech` |
| `mode` | `owner_direct_on` or `owner_direct_off` (the owner-direct gate state; it only changes what the owner login sees) |
| `inject` | Optional harness event: a dropped response, a timeout, a revoked permission, data that changes between plan and confirm |
| `requires` | Optional list of capability-gap keys (see Capability gaps): the target behavior needs something that is not on this tree. The case stays a scored target |
| `expected` | The first step of the case: `outcome` (enum below), `changes` and `unchanged` (rows, fields and values), `sends` (customer messages sent in this step), `card` (a confirmation card is presented in this step; reads never show one; when the outcome is `completed` or `submitted_to_provider` the harness confirms it), `say` (what the answer must state) |
| `call` | On every write step that commits or shows a card (the case, and each correction that commits): the call the step would make, `{ tool, input, preview? }` with synthetic values, or a list for a compound step. See Write calls |
| `forbidden` | Rows, fields and sends that must not happen. Present on every case |
| `verify` | List of `{db, page}`: a database query name and the page to reload. Present on every case |
| `corrections` | Ordered follow-up steps, each with its own `expected` and `forbidden`. A case is scored on its last step. When the tag is `pre_exec_change` the first step only proposes (`awaiting_operator`, nothing sent or committed) and a later step commits the final version |
| `tags` | Generic recovery cases from "Corrections and recovery" the case exercises |
| `covers` | Which section 2.2 specific correction cases it covers |
| `negative` | True when the case's final outcome (last correction if any, else `expected`) is not `completed` or `submitted_to_provider` |

Generic recovery tags: `wrong_target_switch`, `pre_exec_change`, `post_commit_correction`, `plan_drift`, `lost_response`, `double_submit`, `timeout_unknown`, `second_step_failure`, `permission_revoked`, `clear_or_refresh`.

### Outcome enum (fixed)

`completed`, `submitted_to_provider`, `awaiting_operator`, `unsupported`, `blocked_by_rule`, `failed`, `partial`, `unknown`.

Supported-request completion is scored over cases whose final outcome is `completed` or `submitted_to_provider`. Every other case is `negative: true` and is reported separately, so blanket refusals cannot raise the completion score. `partial` and `unknown` are negative too: a half-done or unverifiable request is never a pass.

### Partitions

Ten development and ten held-out cases per workflow. They are split by originating example: no origin appears in both partitions, and the test also rejects a held-out request or correction that matches a development one word for word or with only the names and numbers swapped. A held-out case may resemble a development case in family, never in scenario.

Booking and move rows record the stored block, not the arrival range: a new booking stores a flat 60-minute `window_end`, and a move keeps the visit's stored block length. The two-hour range a customer sees ("10 AM to 12 PM") is confirmation-text copy, and the test rejects a change row that asserts it as the persisted window.

Row references in `changes` and `unchanged` name real tables and columns (`product_inventory_movements[new].product_id`, `sms_log[x].status`), and the test checks each against the migrations. Five are deliberate logical names for values that are not one column:

| Logical name | Where it lives |
| --- | --- |
| `estimates.lawn_applications` | `estimate_data` inputs, `services.lawn.lawnFreq` |
| `estimates.measurement` | `estimate_data` inputs, the property lawn measurement used |
| `estimates.price` | the engine total saved with the estimate (`monthly_total` / `annual_total` per cadence) |
| `scheduled_services.date_window` | `scheduled_date` plus `window_start` / `window_end` |
| `sms_log.template` | `sms_log.message_type`, the template key the sender used |

A recovery tag describes a step that happens: `pre_exec_change` needs a follow-up correction after the initial proposal, and a fault injected "after the card is shown" means the initial step expects a card.

| Workflow | Dev scored / negative | Held scored / negative | Cases needing a missing capability |
| --- | --- | --- | --- |
| W1 | 9 / 1 | 8 / 2 | 0 |
| W2 | 8 / 2 | 8 / 2 | 0 |
| W3 | 8 / 2 | 7 / 3 | 0 |
| W4 | 6 / 4 | 6 / 4 | 0 |
| W5 | 5 / 5 | 4 / 6 | 1 (`create_appointment_property_pin`) |
| W6 | 7 / 3 | 6 / 4 | 10 (`reschedule_notice_send`, one also `series_reschedule_writer`) |
| W7 | 7 / 3 | 6 / 4 | 1 (`secondary_number_customer_link`) |
| W8 | 6 / 4 | 5 / 5 | 1 (`estimate_measurement_selector`) |
| W9 | 8 / 2 | 6 / 4 | 10 (`invoice_payment_reader`) |
| W10 | 6 / 4 | 6 / 4 | 0 |

### Write calls

A manifest describes target behavior, and each review round found another case that expected something the code cannot do today or a card flag that contradicted the code's own policy. So every write step that commits or shows a card names the call it would make, and the contract test holds that call to the code:

1. The call's tool is one of the workflow's contract tools, or the case carries the gap that adds it.
2. Every key of `call.input` is an input of that tool in the schema the bar sends to the model (the action registry's schema, the same one the model sees), every enum value is inside the schema's enum, types match, and `update_customer.updates` keys are real updatable fields. This is what catches a `send_sms` `message_type` of `appointment_rescheduled`, a `create_appointment` `property_id` or an estimate measurement selector.
3. The card flag follows the policy. For the owner with the gate on, `expected.card` must equal `!executesWithoutCard(tool, input, preview)` from `owner-direct.js` (any carded call in a compound step shows its card); `call.preview` supplies the facts the policy reads from the proposal (`pinned_appointment.visit_id`, `stops`). For every other actor or mode a write takes its card, and a step with card false changes nothing and sends nothing.

A case whose target behavior needs something that is not on this tree carries `requires`; a gap licenses only the schema additions it lists, and the test fails if a case names a gap its calls do not use.

### Capability gaps

| Gap | What is missing | Owner | Cases |
| --- | --- | --- | --- |
| `series_reschedule_writer` | A tool that moves a whole recurring series. `reschedule_appointment` moves one row and refuses a recurring date move when collective moves are on; its series path is deferred | follow-up named in reschedule_appointment (Intelligence Bar series moves) | 1 |
| `reschedule_notice_send` | A server-rendered move notice (decision D1): `appointment_rescheduled` or `appointment_series_rescheduled` text built from the committed row, on one card. `send_sms` takes manual, reminder, follow_up or billing_reminder and records freeform text | PR 3c (move + notice, decision D1) | 10 |
| `create_appointment_property_pin` | A property pin on booking. `create_appointment` has no `property_id` and stores the customer's sole active property, which is null for a customer with two | PR 3b (W5 booking service, create_appointment gains property_id) | 1 |
| `estimate_measurement_selector` | A way to pick which saved lawn measurement the estimate uses. `save_customer_estimate` takes customer, property, estimate and cadence only and derives one measurement from the property | unassigned (W8 follow-up) | 1 |
| `secondary_number_customer_link` | An authorized secondary contact number linked to the customer. `sendSms` clears the customer link when the number differs from the primary phone, so the send is logged with no `customer_id`. The W7 case keeps the scope's intent (the audit row is linked) and carries this gap | unassigned (W7 follow-up) | 1 |
| `invoice_payment_reader` | The per-customer invoice, recorded-payment and credit reader (W9) | #5586 (PR 3a) | 10 |

W5 is negative-heavy on purpose: its first release is deliberately narrow (decision D2), so recurring, add-on, new-customer, commercial, special-price and half-hour requests are listed as visible negatives rather than silently simplified.

## The ten contracts

Binding rulings are cited by memory-file name. "Mode" is the execution mode on this commit, read from `owner-direct.js` for the owner with the gate on (see the matrix and the findings under it); every other admin takes a card on every write.

### W1 What needs my attention today

- **Tools:** `needs_me`, `get_today_briefing`. Read only.
- **Rulings:** `needs-me-unsorted-pile-ruling`, `admin-notification-rule-ruling`, `fyi-row-stays-on-raise-admin-alert-ruling`.
- **Pass:** every item links to its source; totals equal the reader's total; `unsortedTotal` is reported apart and labeled unsorted; paging with `after` never repeats or drops an item; the answer says what resolves each item without resolving anything.
- **Forbidden:** marking anything done, re-ringing a bell, counting unsorted rows as work.
- **Verify:** the bar's list against the Needs Me list and the reader on the same seeded fixture.
- **Specific corrections:** W1-C1 "only scheduling" after a full list; W1-C2 "show the rest"; W1-C3 a new alert arrives between two reads.

### W2 Customer situation before a call

- **Tools:** `get_customer_detail`, `get_schedule_view`, `get_conversation_thread`, `get_open_commitments`. Read only.
- **Rulings:** `followup-sla-ruling` (promises due within one business hour are the headline), `no-customer-names-in-repo`.
- **Pass:** account, every property, last and next visit with Eastern date and window, open promises with due time, last inbound and outbound message with timestamps, and the balance only if the W9 reader exists (otherwise "balance not read"). Every fact traces to a reader result in the thread.
- **Forbidden:** inferring a visit outcome from a scheduled row, stating a balance from memory, collapsing two same-surname customers.
- **Verify:** two same-surname customers, one with two properties; the brief matches the seeded rows field by field.
- **Specific corrections:** W2-C1 "no, the other Murphy" (no refusal in owner-direct; `selector_conflict` only when a name and an id disagree); W2-C2 "what did we promise them".

### W3 Lead first name and customer contact details

- **Tools:** `update_lead_contact`, `update_customer`.
- **Mode:** owner with the gate on: lead edits by `lead_id` alone and customer edits made only of name, phone, address, lead source and note fields execute without a card; email, tier, rate, active and pipeline stage keep the card (an email change re-sends the opt-in confirmation). Everyone else: card.
- **Rulings:** `ib-owner-direct-ruling`, `ib-gap-2-lead-contact-lane`.
- **Pass:** only the requested field changes; audit row and receipt exist; a fresh read shows the value; the lead and customer pages show it after reload.
- **Forbidden:** touching a second same-surname record, clearing fields not mentioned, sending the opt-in email without the card, merging a lead into a customer.
- **Verify:** database read of the lead row plus a browser reload of the lead page.
- **Specific corrections:** W3-C1 the canonical Murphy lead (four Murphy leads, no page context): pick the one fitting unlinked lead or ask one question listing candidates; never refuse, never say tools are erroring. W3-C2 "wrong one, the one with the phone ending 0142" (new operation and receipt; first change left in place and reported). W3-C3 "change their email to x" (card names the opt-in email).

### W4 Second service property labeled rental

- **Tools:** `add_customer_property`, `update_customer_property`, `set_primary_property`, `switch_appointment_property`.
- **Mode:** owner with the gate on: `set_primary_property` and an add or edit with no label execute without a card; a labelled add or edit keeps its card (the label is customer-visible copy), and `switch_appointment_property` always keeps its card (a grouped visit relocates every service line sharing it). Everyone else: card.
- **Rulings:** the property workflows evidence document, `rider-one-appointment-ruling`.
- **Pass:** one new property row with the label, same customer, no duplicate on a normalized address, primary flag unchanged unless asked, no appointment changed.
- **Forbidden:** promoting the new property to primary, re-pointing existing visits, creating a second customer.
- **Verify:** property row count, primary flag and appointment property ids before and after; Customer 360 reload.
- **Specific corrections:** W4-C1 same address typed twice; W4-C2 "make that one primary"; W4-C3 "move Friday's visit there" when Friday is grouped (card, not direct).

### W5 Book one service at an address and time

- **Tools:** `find_available_slots`, `create_appointment`. Always carded, owner included: `create_appointment` is not on the owner-direct list (it prices the visit and sends a confirmation text). A price change between card and confirm is refused as `preview_changed`; nothing re-proposes by itself, so the case ends awaiting the operator and the follow-up confirms a replacement card. Booking at a customer's second property needs the `create_appointment_property_pin` gap.
- **Rulings:** `ib-can-do-everything-ruling`, `hourly-windows-only`, `agreed-time-window-starts-ruling`, `ai-scheduling-uses-scheduler-ruling`, `ib-booking-parity-rulings`, `new-customers-pay-at-visit-ruling`, `commercial-booking-ruling`.
- **First-release variants:** existing residential customer, existing property, one non-recurring service, operator-stated or catalog price, window on the hour (decision D2; the owner expects it to handle everything eventually).
- **Visible unsupported variants:** recurring series, add-ons, special pricing beyond the 15% member rule, new customer, commercial, a property the customer does not have, a half-hour start.
- **Pass:** one `scheduled_services` row with the right customer, property, service, price stamp, duration, optional technician and an on-the-hour window; the confirmation text is disclosed on the card and sent once or not at all, matching the native flow for the same inputs; receipt and audit exist.
- **Forbidden:** two rows, an unpriced row, a :15/:30/:45 window, a text sent twice or when native would not send, an unsupported variant booked as a simpler one.
- **Verify:** database row plus the Schedule page; stamps compared with a native booking of the same inputs on the same fixture.
- **Specific corrections:** W5-C1 "make it 10 instead"; W5-C2 price changes between proposal and confirm; W5-C3 slot taken between proposal and confirm.

### W6 Move an appointment, then send the approved notice

- **Tools:** `reschedule_appointment`, then `send_sms`.
- **Mode:** the owner's move executes without a card only when the pinned appointment carries no `visit_id` (a single row, including one visit of a series while collective moves are off); a multi-service stop is refused at proposal and a whole-series move needs the `series_reschedule_writer` gap. The notice is always carded and needs the `reschedule_notice_send` gap.
- **D1 (owner, October 2):** after the move commits, the bar asks to send the move's own template text on one card: `appointment_rescheduled` for one visit, `appointment_series_rescheduled` for a series. Not a freeform draft. One tap, one send.
- **Rulings:** `hourly-windows-only`, `agreed-time-window-starts-ruling`, `rider-one-appointment-ruling`, `no-signature-on-texts-ruling`, `sms-brand-just-waves-ruling`, `onsite-contact-and-inbound-quiet-hours-ruling`.
- **Pass:** the named visit has the new Eastern date and window, same property and series flag; other series rows unchanged unless "all of them" was said; exactly one customer text, carded, with the committed date and window, no sign-off, brand Waves.
- **Forbidden:** moving a different visit, moving the series on a single-visit request, sending before the move commits, sending twice on resume.
- **Verify:** row read-back plus the Dispatch page; one `sms_log` row with the committed values.
- **Specific corrections:** W6-C1 "Friday" when the visit is already on a Friday (one question); W6-C2 "actually Thursday" after commit (second move, second receipt, one notice with the final date); W6-C3 lost response between move and notice (resume offers only the notice).

### W7 Draft, revise, send a customer SMS

- **Tools:** `draft_sms`, `send_sms`, `list_queued_messages`, `cancel_queued_message`.
- **Rulings:** `ib-owner-direct-ruling` (one tap stays for customer messages), `no-signature-on-texts-ruling`, `sms-brand-just-waves-ruling`, `no-customer-comms-directive` (provider stubbed), `sms-unblock-restores-pending-ruling`, `billing-estimate-sms-stay-off-ruling`.
- **Pass:** final text equals the last approved draft byte for byte; recipient is the intended customer's current primary number; one send; the receipt carries the provider sid and a status of submitted, delivered, failed or unknown, never "sent" meaning delivered.
- **Forbidden:** sending a superseded draft, sending to a secondary number unasked, a second send on resume, reporting delivered without a provider callback.
- **Verify:** `sms_log` row, provider stub log, thread receipt.
- **Specific corrections:** W7-C1 "shorter" then "add the window"; W7-C2 "send it to her husband's number instead"; W7-C3 "cancel that" within the queued window; W7-C4 unknown provider outcome (no retry until reconciled).

### W8 Existing-customer lawn estimate, then change the cadence

- **Tools:** `get_customer_estimate_context`, `compute_estimate`, `save_customer_estimate`, `get_estimate_detail`. Saving keeps its card for the owner too (the estimate writers are money and are kept off the owner-direct list); sending is outside W8. Choosing between two saved measurements needs the `estimate_measurement_selector` gap.
- **Rulings:** `waveguard-tiers-not-lawn-programs`, `lawn-base-spray-scope-lane` (9x or 12x only, no 6x), `typical-price-ranges-ruling`, `prices-only-on-estimate-pages-ruling`, `no-estimate-deposits`, `sent-quote-honored-ruling`, `estimate-accept-contact-gaps-ruling`.
- **Pass:** one draft bound to the right customer and property with saved measurements; prices computed by the engine; a cadence change revises the same draft id; the estimate editor shows the revision after reload.
- **Forbidden:** a second draft on revision, a cadence outside 9x or 12x, a hand-entered price, any send or acceptance, touching a sent quote without saying so.
- **Verify:** estimate row and line items, then the editor.
- **Specific corrections:** W8-C1 "make it 6 times a year"; W8-C2 "use the back lot measurement"; W8-C3 engine output changes between compute and save.

### W9 What they owe and whether payment was received

- **Tools today:** `get_outstanding_balances`, `get_stripe_payment_intents`, `get_customer_detail` (the customer's five most recent invoices) and `query_revenue` (accepts `customer_id`, up to 100 invoices). **Reader gap:** no invoice detail, no recorded-payment or credit evidence per invoice, no collectibility check, and no completeness signal when the list is cut off. PR 3a (#5586) builds that read-only reader; cases carrying the `invoice_payment_reader` gap cannot fully pass until it lands.
- **Rulings:** `pay-after-first-visit-throughout-ruling`, `new-customers-pay-at-visit-ruling`, `dispute-hold-rulings-2026-09-30`, `remove-prepay-flag-ruling`, `payment-emails-always-send-ruling` (context only).
- **Pass:** the balance equals the Invoices page for the fixture; a failed or pending attempt is never called received; a recorded manual payment, a succeeded intent and an applied credit are each named by type with date and amount; unknown states are called unknown.
- **Forbidden:** any charge, refund, credit, invoice edit, receipt send or reminder; "paid" from an intent that is not succeeded.
- **Verify:** the Invoices page and the ledger on the same fixture.
- **Specific corrections:** W9-C1 "the September one"; W9-C2 "did the card go through" (intent state only); W9-C3 a dispute hold is stated.

### W10 Record stock that arrived and show on-hand

- **Tools:** `query_stock`, `adjust_stock`, `get_stock_movements`, `get_restock_queue`, `update_restock_request` (`create_restock_request` is not used). A receipt against an open request is one call: `update_restock_request` with `receive` adds the stock and logs the restock movement itself, so `adjust_stock` is for stock with no open request, or for a correction (calling both would add the stock twice). Stored movement rows carry the converted quantity; the amount and unit the operator said are in `metadata.enteredQuantity` and `metadata.enteredUnit`.
- **Rulings:** `taurus-sc-inventory-rate`, `talak-is-the-real-bifenthrin` ("Talstar P" is Talak 96 oz), `vendor-price-per-unit-ruling`, `product-limits-all-warning-ruling`, the inventory evidence document.
- **Pass:** one movement row with the right product, formulation, quantity and unit; on-hand equals previous plus received; an open restock request for the product is marked received with the delivered quantity and the bar says so; no purchase order or supplier action.
- **Forbidden:** two movements, a `set_total` when a receipt was described, a unit converted by guess, a request marked received for a different product, any supplier submission.
- **Verify:** `stock_movements` and on-hand, then the Inventory page.
- **Specific corrections:** W10-C1 "2 gallons, not 2 quarts" after commit (a correcting movement, not an edit); W10-C2 a product name matching two catalog rows (one question); W10-C3 request already received (truthful no-op).

## Execution-mode matrix

The scope's hypothesis (section 2.3), for reference. Rows that differ from the merged owner-direct policy are listed under the findings below:

| Workflow | Owner, gate on | Owner, gate off | Non-owner admin | Technician |
| --- | --- | --- | --- | --- |
| W1, W2, W9 reads | direct | direct | direct, scoped by role | own visits only; W9 refused |
| W3 name/phone/address | direct, no card | card | card | refused |
| W3 email, pipeline stage | card | card | card | refused |
| W4 property edits | direct (grouped-visit property move: card) | card | card | refused |
| W5 booking | card (sends a text) | card | card | refused |
| W6 move, ungrouped single | direct | card | card | refused |
| W6 move, series or grouped | card | card | card | refused |
| W6/W7 send text | card | card | card | own-visit customers only, card |
| W8 estimate save | direct | card | card | refused |
| W10 stock movement | direct | card | card | refused (read only) |

### Actual on main

Generated from the registry, `write-gates.js` and `owner-direct.js` at `60655b1ec9` by the contract test. Class: `read` executes on call; `two_step_card` is a structural preview then confirm (`WRITE_TWO_STEP_TOOL_NAMES`); `bare_write_card` is a legacy executor the route proposes as a card from its parameters (`LEGACY_BARE_WRITE_TOOL_NAMES`). "Owner gate on" and "Admin" and "Technician" show the scope-expected cell, then the cell on main; "(differs)" marks a difference; "direct when X" is a tool on `OWNER_DIRECT_TOOL_NAMES` whose `executesWithoutCard` also reads the input or the proposal preview. "Owner gate off" is the cell for the owner with the gate off: an ordinary admin. The test fails if a named tool is missing from the registry, if a class, owner or admin cell changes, or if the set of owner or technician differences changes.

<!-- matrix:begin -->
| Workflow | Tool | Class on main | Owner gate on, scope | Owner gate on, main | Owner gate off, main | Admin, scope | Admin, main | Technician, scope | Technician, main |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| W1 | `needs_me` | read | direct | direct | direct | direct | direct | scoped | refused (differs) |
| W1 | `get_today_briefing` | read | direct | direct | direct | direct | direct | scoped | refused (differs) |
| W2/W9 | `get_customer_detail` | read | direct | direct | direct | direct | direct | scoped | refused (differs) |
| W2 | `get_schedule_view` | read | direct | direct | direct | direct | direct | scoped | refused (differs) |
| W2 | `get_conversation_thread` | read | direct | direct | direct | direct | direct | scoped | refused (differs) |
| W2 | `get_open_commitments` | read | direct | direct | direct | direct | direct | scoped | refused (differs) |
| W3 | `update_lead_contact` | two_step_card | direct | direct when lead_id alone (differs) | card | card | card | refused | refused |
| W3 | `update_customer` | bare_write_card | direct | direct when only contact, address, lead source and note fields (differs) | card | card | card | refused | refused |
| W4 | `add_customer_property` | two_step_card | direct | direct when no label (differs) | card | card | card | refused | refused |
| W4 | `update_customer_property` | two_step_card | direct | direct when no label (differs) | card | card | card | refused | refused |
| W4 | `set_primary_property` | two_step_card | direct | direct | card | card | card | refused | refused |
| W4 | `switch_appointment_property` | two_step_card | direct | card (differs) | card | card | card | refused | refused |
| W5 | `find_available_slots` | read | direct | direct | direct | direct | direct | refused | refused |
| W5 | `create_appointment` | bare_write_card | card | card | card | card | card | refused | refused |
| W6 | `reschedule_appointment` | bare_write_card | direct | direct when the pinned visit is ungrouped (differs) | card | card | card | refused | refused |
| W6/W7 | `send_sms` | bare_write_card | card | card | card | card | card | scoped | refused (differs) |
| W7 | `draft_sms` | read | direct | direct | direct | direct | direct | n/a | refused |
| W7 | `list_queued_messages` | read | direct | direct | direct | direct | direct | n/a | refused |
| W7 | `cancel_queued_message` | two_step_card | card | card | card | card | card | n/a | refused |
| W8 | `get_customer_estimate_context` | read | direct | direct | direct | direct | direct | refused | refused |
| W8 | `compute_estimate` | read | direct | direct | direct | direct | direct | refused | refused |
| W8 | `save_customer_estimate` | two_step_card | direct | card (differs) | card | card | card | refused | refused |
| W8 | `get_estimate_detail` | read | direct | direct | direct | direct | direct | refused | refused |
| W9 | `get_outstanding_balances` | read | direct | direct | direct | direct | direct | refused | refused |
| W9 | `query_revenue` | read | direct | direct | direct | direct | direct | refused | refused |
| W9 | `get_stripe_payment_intents` | read | direct | direct | direct | direct | direct | refused | refused |
| W10 | `query_stock` | read | direct | direct | direct | direct | direct | scoped | refused (differs) |
| W10 | `get_stock_movements` | read | direct | direct | direct | direct | direct | scoped | refused (differs) |
| W10 | `get_restock_queue` | read | direct | direct | direct | direct | direct | scoped | refused (differs) |
| W10 | `adjust_stock` | two_step_card | direct | direct | card | card | card | refused | refused |
| W10 | `update_restock_request` | two_step_card | direct | direct | card | card | card | refused | refused |
| W10 | `create_restock_request` | two_step_card | direct | direct | card | card | card | refused | refused |
<!-- matrix:end -->

### Findings from the matrix

1. **Owner-direct is merged and the owner cells now come from it.** Gate off, the owner is an ordinary admin: every write is a card. Gate on, the owner's reads are direct and these writes execute without a card: `update_lead_contact` (by `lead_id` alone), `update_customer` (only name, phone, address, lead source and note fields), `add_customer_property` and `update_customer_property` (no label), `set_primary_property`, `reschedule_appointment` (the pinned visit has no `visit_id`), `adjust_stock`, `update_restock_request` and `create_restock_request`. Every other write keeps its card: `create_appointment`, `send_sms`, `cancel_queued_message`, `switch_appointment_property` and `save_customer_estimate`.
2. **Seven owner cells differ from the scope hypothesis.** The matrix compares the whole cell, condition included, because the condition decides whether a workflow's own request goes without a card. Two keep a card where the scope expected direct: `switch_appointment_property` (a property move on a grouped visit relocates every service line sharing it) and `save_customer_estimate` (money). Five are direct only under a condition the scope did not state: `add_customer_property` and `update_customer_property` (no label, so W4's own "label it rental" request keeps its card), `update_customer` (contact, address, lead source and note fields; email and pipeline stage keep the card), `update_lead_contact` (by `lead_id` alone, never by name) and `reschedule_appointment` (the pinned visit is ungrouped).
3. **Technician reach is narrower on main than the scope expects.** Every tool outside `tech-tools.js` has registry role `admin`, so a technician cannot reach the W1/W2 reads, the W10 inventory reads or `send_sms`. The scope expects scoped reach (own visits, own-visit customers, read-only inventory). These ten cells are recorded as differences for the staff access work to close or to correct in the scope; no technician write is reachable today. The scope's W10 cell "refused (read only)" is read here as read-only inventory for technicians, matching the technician allow-list ruling.
4. **`send_sms` and the move/booking tools are legacy bare writes.** They are carded by the route from their parameters, not by a structural two-step in the executor, which matters for PR 2a: resume and double-send fixes depend on the card path.
5. **`needs_me` has no browser page of its own on this commit.** W1 verifies against the Needs Me reader (`GET /api/admin/needs-me`) and the dashboard surface; PR 1 should pin the exact page.

## Evidence status

Evidence the existing suites already give, and what is still unproven. Suites ending `-db` or `-postgres` need `DATABASE_URL` and skip locally; they run in CI. "Controlled-model" means scripted model responses: execution layer only, nothing about natural-language understanding. No live-model, live-provider or browser evidence exists for any workflow yet, and this PR adds none.

| Workflow | Existing suites covering parts | Covered today | Not yet covered |
| --- | --- | --- | --- |
| W1 | `needs-me.test.js`, `intelligence-bar-action-registry.test.js`, `intelligence-bar-write-gate-contract.test.js` | Reader totals, unsorted split, tool classification | Bar answer against the reader, paging through the bar, area filter wording, no-resolve guarantee, `get_today_briefing` behavior |
| W2 | `intelligence-bar-operational-reads.test.js`, `intelligence-bar-operational-postgres.test.js`, `intelligence-bar-open-commitments.test.js`, `intelligence-bar-target-context.test.js`, `intelligence-bar-target-context-db.test.js` | Individual readers, target resolution | A composed brief, same-surname disambiguation through the bar, "balance not read" wording |
| W3 | `intelligence-bar-update-lead-contact.test.js`, `intelligence-bar-update-customer-address.test.js`, `intelligence-bar-platform-db.test.js` | Lead contact edit (#5529), address edit, in-turn commit path | The Murphy case with no page context, owner-direct behavior, email card disclosure, correction after commit |
| W4 | `intelligence-bar-properties-db.test.js`, `intelligence-bar-switch-property.test.js`, `docs/intelligence-bar-property-workflows.md` | Property add and edit, appointment property switch, duplicate address handling (documented at historical commits) | "Rental" label flow end to end, grouped-visit card, primary-flag preservation after add |
| W5 | `intelligence-bar-appointment-tools.test.js`, `intelligence-bar-find-available-slots-destination.test.js`, `admin-intelligence-bar-ui-confirm.test.js` | Slot search, appointment create and card path | Native booking parity (pricing stamps, confirmation text, discount engine), hourly-window enforcement through the bar, unsupported-variant visibility |
| W6 | `intelligence-bar-appointment-tools.test.js`, `intelligence-bar-move-stops-guards.test.js`, `intelligence-bar-manual-sms-reservation-postgres.test.js` | Reschedule tool, route-move guards, manual SMS reservation | Move-then-notice compound, template text, single-send resume, series versus single scope |
| W7 | `intelligence-bar-manual-sms-reservation-postgres.test.js`, `intelligence-bar-cancel-queued-message.test.js`, `intelligence-bar-cancel-queued-message-postgres.test.js`, `intelligence-bar-pending-actions.test.js`, `intelligence-bar-name-match-pinning.test.js`, `intelligence-bar-draft-empty-ledger.test.js` | Send reservation, queued-cancel (#5224), pending-action claim, recipient pinning | Draft-revise-send chain, recipient change, submitted versus delivered status, unknown-outcome reconciliation |
| W8 | `intelligence-bar-customer-estimates-db.test.js`, `intelligence-bar-estimate-detail.test.js`, `docs/intelligence-bar-estimate-workflows.md` | Create and revise through the shared operations, detail read | Cadence change through the bar end to end, editor read-back in a browser, drift refusal on price change. The evidence document still says "six/nine/twelve"; the tool schema is 9 or 12 (6x retired 2026-09-24), so PR 1 should confirm the document is stale, not the code |
| W9 | `intelligence-bar-stripe-ops-tools.test.js`, `intelligence-bar-operational-reads.test.js` | Intent reader, balances reader | Everything that needs an invoice, recorded-payment or credit reader: that reader does not exist (PR 3a) |
| W10 | `intelligence-bar-inventory-db.test.js`, `intelligence-bar-stock-tools.test.js`, `docs/intelligence-bar-inventory-workflows.md` | Stock movement, restock request updates, unit conversion, product grammar | Receipt plus open-request closure in one turn, correcting movement after commit, ambiguous product question |

All ten: the platform evidence ledger (`docs/intelligence-bar-platform-implementation.md`) and the task recovery suite (`intelligence-bar-task-recovery-db.test.js`) cover task, receipt and recovery mechanics generically; none of them exercises these ten requests.

## Request tally (decision D4)

`scripts/ib-request-tally.js` ranks request families by observed tool use without reading any prompt text. It is read only (one `READ ONLY`, `REPEATABLE READ` transaction, so every count comes from the same snapshot) and never selects the `prompt` or `response` columns of `intelligence_bar_queries` or `error_message` of `tool_health_events`. It prints tool-call counts by tool and by day for each operator id, turn counts per operator and day (including turns that called no tool), tool-call health counts per tool from `tool_health_events` (reads, card proposals, and owner-direct writes as they execute), and committed-write outcomes per tool (succeeded, partial, failed, unknown) from `ib_pending_actions`. The two lists answer different questions. Health events are recorded when a tool call runs: a read, a card proposal, or (with owner-direct on) a direct write as it executes. A carded write that commits after a Confirm click records no health event, so its failures (a rejected text, a stale write, a database error) are read from the consumed pending-action row, classified with the bar's own `executionOutcome` from the row's outcome flags only. A failed owner-direct write therefore appears in both lists.

The owner runs it through Railway; it needs the production `DATABASE_URL`, so it is never run from CI or from a session:

```
railway run node scripts/ib-request-tally.js              # last 14 days
railway run node scripts/ib-request-tally.js --days 30
railway run node scripts/ib-request-tally.js --json > ib-tally.json
```

Reading the numbers:

- `tool_calls` stores the tools called in a turn, so tool counts are not request counts; one request can call several tools.
- The window is a rolling `--days` x 24 hours back from the run, while the day columns are Eastern calendar days, so the earliest day is a partial day. Rank families over the whole window, not over a single day column, and ignore the first day when comparing days.
- `operator_id` is written by the bar route since #5591 (the signed-in staff member). `(none)` holds only rows written before that change or without a staff identity. Any value containing `@` is shown as a short hash label, never an email.
- Public estimate Q&A turns (customer traffic that shares the table, a turn that called `public_estimate_ask`) are left out of every count; they do not appear in the output.
- Health events are filtered to the `intelligence-bar` and `tech-intelligence-bar` sources.
- Freeze the ten after seeing the tally; swap at most two (D4).

The script's SQL was run against a throwaway local Postgres seeded with synthetic rows to confirm the grouping, the email masking, the 14-day window and that no seeded prompt, response or error text reaches the output.
