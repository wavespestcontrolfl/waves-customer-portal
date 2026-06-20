# Third-party Payer — Phase 2: NET terms + consolidated monthly statements

Design doc (2026-06-19). Phase 2 of the third-party Payer (Bill-To) subsystem
(Phase 1 = PR #1850; deposit follow-up = PR #1906). **Design only — no code yet.**

## Goal

Today every payer-billed invoice is `due_on_receipt`: each visit instantly mints
an invoice that is routed to the payer's AP inbox individually. For payers on
**NET terms** (`net15` / `net30`) we instead want to **accrue** each visit charge
and send **one consolidated statement per payer per period** — a line per visit,
across all of that payer's customers — with **AR aging keyed on the payer**, not
the homeowner.

The `payers.payment_terms` column (`due_on_receipt | net15 | net30`) and
`payers.stripe_customer_id` already ship from Phase 1 but are stored-only — read
nowhere during invoicing/payment today. Phase 2 makes them load-bearing.

## What Phase 1 already gives us (so the delta is small)

Round-24 hardening already makes a payer-billed invoice invisible to the
homeowner end-to-end. These guards are **reused unchanged** by accrued invoices —
we do NOT rebuild them:

- Homeowner never gets a pay link (estimate-accept copy, completion SMS,
  in-app), never sees a `/pay` token, never gets the in-person payment sheet
  (`admin-dispatch.js`, `estimate-public.js`, `admin-schedule.js` charge-now
  guard, `track-public.js`).
- Homeowner autopay / prepay can't cover or be credited to a payer invoice
  (`admin-dispatch.js` completion; `invoice.create` skips `depositCredit` when a
  payer resolves).
- Dunning already excludes payer invoices (`invoice-followups.js` `runPending`
  `whereNull('i.payer_id')` + `fireStep` guard).
- Customer-health scorer excludes payer rows; reconcile + terminal-handoff
  reject payer invoices.

So Phase 2 is **not** "make payer billing safe" — that's done. Phase 2 is purely:
**(a)** don't individually email a NET-terms payer invoice to the AP, **(b)** roll
it into a statement, **(c)** build the statement's delivery / payment / AR /
dunning. The accrued invoice is "a Phase-1 payer invoice that is also held back
from individual AP delivery and grouped."

## Concept

```
visit completes / estimate accepts for a payer-billed customer
        │
        ▼  invoice.create() resolves the payer (unchanged)
   resolved payer.payment_terms?
        ├── due_on_receipt ─► Phase 1: invoice routes to AP inbox now  (UNCHANGED)
        └── net15 / net30 ──► accrue: link invoice to the OPEN statement
                              for (payer, period); never individually sent
        │
        ▼  monthly close (cron or manual)
   statement.status: open → finalized → sent (one PDF to AP, lines = the visits)
        │
        ▼  AP pays (one /pay link → Stripe on payer.stripe_customer_id, OR
                    offline check/ACH/wire reconciled by admin)
   statement paid ─► cascade: every accrued invoice on it settles atomically
        │
        ▼  if unpaid past due_date ─► statement-level dunning to the AP inbox
```

Key framing: **the statement, not the invoice, is the unit of send / payment /
AR / dunning** for NET-terms payers. Accrued invoices remain real `invoices`
rows (so all line-item / tax / total / PDF machinery is reused) but are never
individually delivered, collected, or dunned — they inherit the Phase-1 payer
suppression and add one new marker: `payer_statement_id`.

## Data model

### New: `payer_statements`
One open statement per `(payer_id, period)`. Accrued invoices attach to it.

| column | type | notes |
|---|---|---|
| `id` | bigserial PK | |
| `payer_id` | int FK→payers | **RESTRICT** (payers never hard-deleted, mirror invoices.payer_id) |
| `period_start` / `period_end` | date | the accrual window (see cadence decision) |
| `status` | varchar(20) | `open` → `finalized` → `sent` → `viewed` → `paid` → `void` (`overdue` is derived from `due_date`, not stored) |
| `terms_snapshot` | varchar(24) | the payer's `payment_terms` frozen at statement open |
| `subtotal` / `tax_amount` / `total` | numeric(10,2) | rolled up from accrued invoices; recomputed on attach/detach until `finalized`, frozen after |
| `invoice_count` | int | |
| `token` | varchar(64) unique | public `/pay` token, like `invoices.token` |
| `payer_snapshot` | jsonb | frozen AP bill-to at finalize (mirror invoices.payer_snapshot) |
| `due_date` | date | computed at finalize: `close_date + terms` |
| `finalized_at` / `sent_at` / `viewed_at` / `paid_at` | timestamptz | |
| `payment_method` / `stripe_charge_id` / `stripe_payment_intent_id` | varchar | settlement record |
| `created_at` / `updated_at` | timestamptz | |

Partial unique index `(payer_id, period_start) WHERE status = 'open'` — at most
one open statement per payer per period (the get-or-create target).

### Changed: `invoices`
- `+ payer_statement_id` bigint FK→payer_statements, `ON DELETE SET NULL`, indexed.
  - `payer_statement_id IS NOT NULL` ⇒ accrued (held from individual AP send,
    aged on the statement, not its own `due_date`).
  - Status stays `draft` while accrued — we do **not** add an `accrued` status
    enum value (it would force updates across every hard-coded status guard:
    `INVOICE_UNCOLLECTIBLE_STATUSES`, `AP_FROZEN_INVOICE_STATUSES`,
    followups, list filters). `payer_statement_id` is the semantic marker.

### Changed: `payments` — payer-scoped ledger shape (specify before P3)
A statement spans MANY customers, but `payments.customer_id` is `NOT NULL` today
and revenue/health paths key off `customer_id` / `metadata.invoice_id`. A naive
single row would either fail the insert or misattribute the payer's money to one
homeowner. So:
- `+ statement_id` bigint FK→payer_statements `ON DELETE SET NULL`.
- `+ payer_id` bigint FK→payers `ON DELETE SET NULL`.
- Make `customer_id` **nullable**; a statement settlement writes **one** row with
  `customer_id = NULL`, `payer_id` + `statement_id` set. (Alternative considered:
  a separate `payer_statement_payments` table — rejected to keep one ledger for
  reconciliation/refunds, but it means the customer-keyed readers below MUST be
  updated.)
- **`amount` = the CHARGED total, not the base statement total.** When a card
  surcharge applies (online card pay), `payments.amount` must be the surcharged
  total that actually hit the PaymentIntent, with the pre-surcharge / surcharge
  split in the same cents fields existing Stripe payment rows use. Storing the
  bare statement total would understate collected cash and make the ledger
  disagree with the PI/webhook. ACH/offline rows carry no surcharge so `amount` =
  statement total there.
- **Every customer-keyed payments reader must exclude payer-scoped rows** —
  mirror the existing payer-invoice exclusion pattern: add `customer_id IS NOT
  NULL` (or `payer_id IS NULL`) to revenue/health/per-customer ledger queries so
  payer money is never counted as a homeowner's payment. This is the same
  invariant as Phase 1's customer-health payer-row exclusion, applied to the
  ledger. Enumerate the readers in the P3 PR.

### New: `payer_statement_followups`
Mirror of `invoice_followup_sequences` but keyed on `statement_id` — statement-
level dunning to the AP inbox (intervals tuned to terms; see Dunning).

## Lifecycle & the accrual branch point

**Single branch point — `invoice.create()` (and `createFromService`).** It
already resolves the payer (`PayerService.resolveForInvoice`) and snapshots
`payer_id` / `payer_snapshot`. Phase 2 adds: when the resolved payer's
`payment_terms !== 'due_on_receipt'`, attach the new invoice to the open
statement for `(payer, period)` instead of leaving it free-floating:

```
resolvedPayerId set AND resolved terms ∈ {net15, net30}:
    statementId = getOrCreateOpenStatement(payerId, period, trx)   // see below
    insert invoice with { payer_id, payer_snapshot, payer_statement_id: statementId, status: 'draft' }
    bump statement subtotal/tax/total/invoice_count (in the same trx)
```

Because every accrued-vs-immediate decision lives in `create()`, the call sites
do not re-implement accrual. **The "don't individually send an accrued invoice"
guard MUST be centralized in the send helpers, NOT sprinkled at call sites.**
Accrued invoices stay `draft`, and the admin manual-send / batch-send / scheduled-
send / resend surfaces all funnel through `InvoiceService.sendViaSMSAndEmail` /
`sendInvoiceEmail`, which today happily accept a draft payer invoice and email the
AP a pay link. If the block lived only at the listed completion/accept call sites,
an operator could still deliver and collect an individual invoice from
`/admin/invoices` that should be payable ONLY through the consolidated statement.
So: **`sendViaSMSAndEmail` / `sendInvoiceEmail` (and any admin send/resend path)
hard-refuse `invoice.payer_statement_id IS NOT NULL`** — one chokepoint, fail-
closed. (The homeowner-side sends are already skipped by Phase 1.)

**Block the PAY paths too, not just send.** Blocking delivery is necessary but
not sufficient: a `create()`d invoice still mints a `/pay` token, and the invoice
payment paths (`/api/pay/:token` setup/finalize and the Stripe invoice-payment
path) gate mainly on *collectible status* — so a leaked or admin-visible child
token could be paid individually, then paid **again** by the statement cascade
(double collection). The accrued invoice must be uncollectible by ANY path except
its statement: add an explicit **`payer_statement_id IS NULL`** guard to the
invoice `/pay` token resolution and the Stripe invoice-PaymentIntent path (fail
closed → "this charge is billed on your monthly statement"). Statement payment is
the ONLY collection path for an accrued invoice.

**`getOrCreateOpenStatement(payerId, period, trx)`** — transaction-safe, mirrors
the charge-now mint lock:
1. `pg_advisory_xact_lock(hashtext('payer.statement.open'), hashtext(payerId||period))`
2. `SELECT ... WHERE payer_id=? AND period_start=? AND status='open'` → reuse, else insert.
   The partial unique index is the backstop if two trx race the lock.

**Accrual must be atomic even when the caller has no transaction.** Accept /
charge-now already pass `database: trx`, so the invoice insert + statement attach
+ rollup commit atomically there. But other callers (`createFromService`, the
admin manual/batch create paths) call `InvoiceService.create()` with the default
`db` — and `pg_advisory_xact_lock` releases at end-of-statement (not end-of-
function) outside a transaction, so the lock + insert + rollup would NOT be atomic
and two completions could race into duplicate open statements or drift the rollup
if a later write fails. **`create()` must open its OWN transaction when no
`database` runner is supplied** (wrap the get-or-create + insert + rollup), so the
advisory `xact` lock is held for the whole unit regardless of caller. The partial
unique index on `(payer_id, period_start) WHERE status='open'` is the final
backstop.

**Charge-now special case** (`admin-schedule.js`): today it hard-rejects ALL
payer invoices ("do not collect in person"). For NET payers we relax it to *mint
+ accrue* (no token returned to the tech sheet — accrued invoices have no
collectible pay link), while `due_on_receipt` payers keep the 400. The
post-lock `payer_id` recheck stays; it just routes net-terms to accrual instead
of refusal.

## Statement close & cadence — **DECIDED (statement-dated, calendar month)**

Owner decision (2026-06-19): **calendar-month close, statement-dated NET.**
`period_start` = first of month; at month end a cron finalizes each payer's open
statement: freeze totals + `payer_snapshot`, set `due_date = close_date +
(15|30)`, render PDF, deliver to AP, open the next month's statement lazily on
the next accrual. All lines on a statement share **one** due date and **one**
aging clock (net counts from the close date, not per visit). Manual "close & send
now" is available from `/admin/payers/:id` for off-cycle settlement.

**All close/aging date math is Eastern Time.** The portal is ET end-to-end and
Railway runs UTC, so a naive month-end cron can fire on the wrong calendar date
and compute `due_date` from the wrong close date. The close job MUST: schedule
with `timezone: 'America/New_York'` (node-cron), derive "month end / first of
month / today" via the shared `datetime-et` helpers (`etDateString` etc.) — never
`new Date()` / UTC — and compute `due_date = close_date + terms` in ET. `period_*`
and `due_date` are date-only (no timestamptz window leak). Run the close under
the existing `runExclusive` cron-lease pattern so two instances can't double-close.

**Close must serialize against concurrent accrual, not just other closes.**
`runExclusive` stops two close jobs, but it does NOT stop a service completion
that is concurrently `getOrCreateOpenStatement`-attaching a visit to the same open
statement. If finalize froze totals / rendered the PDF / sent while a child
invoice was mid-attach, the statement could send a stale total or have an invoice
land after it was sent. So the close path MUST take the **same per-`(payer,
period)` advisory lock** (`hashtext('payer.statement.open')`, `hashtext(payerId||
period)`) — and row-lock the statement (`SELECT … FOR UPDATE`) — before flipping
`open → finalized` and freezing. Once it is off `open`, `getOrCreateOpenStatement`
opens the next period's statement instead of attaching.

(Rejected: per-visit NET / rolling windows — more complex AR and not what a
"monthly statement" means.)

## Delivery

New sibling to `invoice-email.js`, e.g. `payer-statement-email.js`:
- Loads the statement + its accrued invoices; renders ONE consolidated PDF (a
  line per visit: date, customer/service address, service, amount; grouped by
  customer). Reuses the existing PDF renderer + the WDO consolidated-send PDF
  pattern as a starting point.
- Recipient = `PayerService.payerRecipient(payer)` (the SAME AP-email resolution
  individual payer invoices use — they must never diverge). Fail-closed if no AP
  email (no homeowner fallback), exactly like Phase 1.
- Sets `sent_at`, status `sent`, arms the statement followup sequence.

## Payment, reconciliation, webhook

- **Self-serve `/pay` (new path in `pay-v2.js`):** the statement's own
  `token` resolves the statement (+ its line items for display) and charges
  **`payer.stripe_customer_id`** (NOT the homeowner). This is a NET-new Stripe
  path — today `services/stripe.js` only charges `customer.stripe_customer_id`
  and explicitly rejects `invoice.payer_id`. We add a payer-scoped charge that is
  only ever reachable via a statement token, never a homeowner surface.
  - **Pay only a FROZEN statement — fail closed otherwise.** A PaymentIntent may
    be created ONLY for a statement in a payable frozen *stored* status
    (`finalized` / `sent` / `viewed`); `open` (still accruing), `void`, and
    already-`paid` must be refused. (`overdue` is **not** a stored status — it is
    derived from `due_date` for aging/dunning only; a past-due statement is still
    one of the stored frozen statuses and remains payable.) Paying an `open` statement lets AP
    settle a mutable total while later visits keep accruing into it — leaving
    those visits unpaid or the total changed after collection. The accrual branch
    and the pay branch are mutually exclusive on status: nothing attaches to a
    statement once it leaves `open`.
  - **Get-or-create the payer's Stripe customer first.** `payers.stripe_customer_id`
    is nullable + stored-only today; the first online payment by a payer with no
    Stripe customer would error or mint a no-customer PI. Add an
    `ensureStripePayerCustomer(payer)` (create-from-payer-metadata + persist the
    id), kept SEPARATE from the homeowner `ensureStripeCustomer` flow so payer and
    homeowner Stripe customers never cross.
  - **Surcharge is mandatory for card-family pay** (AGENTS.md / the
    cost-of-acceptance lane). Do NOT restate the rate here — it is configured
    (`CONFIGURED_COST_BPS`) and the lane's rule is *derive the displayed %, never
    hardcode it*. The statement
    pay MUST run the same quote → finalize → update flow as invoice card pay:
    derive the displayed total, the PaymentIntent amount, AND the recorded
    surcharge from `computeChargeAmount(statement.total, methodType, { funding })`
    (method type is the 2nd arg, options 3rd — per `server/services/stripe-pricing.js`)
    and take the cents fields from that result; verify the webhook amount against
    it. A flat
    "PaymentIntent = statement total" would undercharge card payments and drift
    the payment row from the webhook. ACH / offline (check/wire) carry **no**
    surcharge (debit/ACH are zero-cost, FL gating already handled by the shared
    helper). Statements are **not** deposits, so the deposit-surcharge-exemption
    rule does NOT apply — a card statement payment surcharges normally.
- **Admin reconcile (`admin-payments-reconcile.js`):** keep the existing payer
  rejection for *individual* payer invoices; add a statement reconcile that marks
  the statement paid and **cascades** (see below). Off-platform check/ACH/wire is
  the common AP path.
- **Webhook (`stripe-webhook.js`):** PaymentIntent metadata carries
  `statement_id`; on success → mark statement `paid` + cascade. Legacy
  `invoice_id`-only intents are unchanged.
- **Cascade-on-settle:** paying a statement settles every accrued invoice on it
  atomically — mark the statement `paid`, the child invoices `paid`
  (`paid_at = statement.paid_at`, a settlement marker, not N card charges), write
  ONE `payments` row keyed on `statement_id`, and stop the statement followup
  sequence. Revenue itself is unchanged — it was booked on `service_records` at
  completion, independent of AR.

## AR / aging / reporting

- **New AR layer = payer → statement → invoices.** Existing per-customer/per-
  invoice AR is untouched for self-pay. Add an `/admin/payers/:id` AR view plus a
  payer-statement filter on the invoice list.
- **Aging keyed on the statement**, not the child invoices: an accrued invoice is
  never "overdue" on its own `due_date`; the statement is, on `statement.due_date`.
  Aging buckets by terms (e.g. current / 1–15 / 16–30 / 31–45 / 45+).
- **Revenue dashboard:** add an "AR by terms" tile (open statement $ + avg age
  per `payment_terms`). MRR / acceptance / RPMH / margin are keyed on
  `service_records` and are **unaffected**.
- Re-confirm customer-health excludes payer-billed invoices (already true) so a
  slow-paying payer never dings the homeowner's score.

## Dunning (statement-level)

Keep the `invoice-followups.js` payer exclusion. Add a parallel
`payer_statement_followups` system: when an unpaid statement passes `due_date`,
fire AP-inbox reminders on a terms-aware schedule (e.g. due+0 reminder, +15
firmer, +30 final) — no homeowner contact ever. Same shape as the invoice
followups (cron `runPending`, `fireStep`, pause/stop on payment), so the existing
patterns transfer.

**Dun `sent` AND `viewed`, not `sent` only.** The status model moves an opened-
but-unpaid statement `sent → viewed`, so gating dunning on `sent` alone would stop
reminders the moment the AP contact clicks the link without paying — exactly when
we most want to keep nudging. The eligibility query covers both `sent` and
`viewed` (mirrors the invoice followups, which dun opened-but-unpaid invoices);
`viewed` is a timestamp fact, not a dunning exit. Only `paid` / `void` stop it.

## Open decisions (need Adam)

1. ~~Cadence / close day~~ — **DECIDED 06-19: statement-dated, calendar-month
   close** (`due_date = close + terms`; one due date + one aging clock per
   statement). See "Statement close & cadence".
2. ~~Self-serve statement pay~~ — **DECIDED 06-19: offer BOTH.** AP can pay online
   via a `/pay` link (Stripe on `payer.stripe_customer_id`) AND/OR settle offline
   (check/ACH/wire) reconciled by admin.
3. **Saved payer card / auto-charge** — **DECIDED 06-19: card save is OPTIONAL,
   NO silent auto-charge on `due_date`.** A statement is only charged by an
   explicit click (AP self-serve) or an admin reconcile. (Auto-charge-on-due can
   be revisited later as an opt-in per payer; not in scope now.)
4. **Mid-period edits** — if a visit is voided/repriced after it accrued but
   before the statement closes, the rollup recomputes (fine while `open`). After
   `finalized`/`sent`, corrections become a credit line on the *next* statement
   (recommend) vs reopening a sent statement (avoid).
5. **Deposit credit** — confirm homeowner deposits never apply to a payer
   statement (already true for payer invoices; statements inherit it). A payer
   pre-payment/credit, if ever needed, is a separate payer-ledger concept (out of
   scope).
6. **Partial statement payment** — does a statement allow partial settlement
   (AP pays $X of $Y), or is it all-or-nothing? (Recommend all-or-nothing in v1;
   partials are a later AR refinement.)
7. **Mixed-terms project consolidated-send** — a WDO/project bundle can span
   customers/payers; if some lines are NET-accrued and some `due_on_receipt`,
   forbid accrued invoices in the legacy consolidated PDF (they belong to a
   statement) vs handle the mix. (Recommend forbid + route accrued to the
   statement.)

## Phased build (gated, dry-run-first — mirrors the auto-dispatch lane)

Each PR ships behind a gate and is independently revertable; nothing changes for
`due_on_receipt` payers at any phase.

- **P1 — accrual core (gated, no outward change).** Schema (`payer_statements`,
  `invoices.payer_statement_id`, `payments` payer cols); `getOrCreateOpenStatement`
  (advisory lock + partial unique index); `invoice.create()` links NET-terms payer
  invoices to the open statement + rollup, opening its own trx when no caller trx;
  the **centralized** "refuse to individually send a `payer_statement_id` invoice"
  guard in `sendViaSMSAndEmail` / `sendInvoiceEmail`. Gate `GATE_PAYER_STATEMENTS`
  off ⇒ everyone stays `due_on_receipt`. Admin can *view* accumulating statements
  at `/admin/payers/:id`. No delivery yet.
- **P2 — close + deliver.** Statement finalize (freeze totals + snapshot +
  due_date), consolidated PDF, AP delivery (`payer-statement-email.js`); manual
  "close & send" first, then a monthly cron (dry-run preview before the first real
  send, like auto-dispatch).
- **P3 — payment + settlement.** Statement `/pay` token + payer-scoped Stripe
  charge **through `computeChargeAmount` (surcharge quote/finalize/update +
  webhook amount verification)**; the payer-scoped `payments` ledger shape
  (nullable `customer_id`, `payer_id`/`statement_id`, + exclude payer rows from
  customer-keyed readers); admin statement reconcile; webhook cascade; atomic
  settle-all-children.
- **P4 — AR + dunning.** Payer AR/aging view, "AR by terms" dashboard tile,
  statement-level followup sequences.

## Hardest integration points (call out early)

1. **Charge-now → accrual** (`admin-schedule.js`): minting a non-collectible
   accrued invoice for a future visit is a new state for the tech sheet — must
   return no pay token and the tech UI must not show a payment form (today every
   minted invoice is assumed collectible).
2. **Project consolidated-send vs statements** (`admin-projects.js`): the existing
   "send consolidated" bundles individual invoices; accrued invoices must be kept
   out of it (decision #7).
3. **Statement vs invoice aging everywhere AR is read**: queries that age on
   `invoices.due_date` silently miss accrued invoices (no individual due_date) —
   every aging/overdue surface must age accrued rows on `statement.due_date`.
4. **Payer-scoped Stripe** (`services/stripe.js`): first use of
   `payer.stripe_customer_id`; must be reachable ONLY via a statement token, never
   a homeowner surface, and never save a payer card to a homeowner.
5. **Get-or-create-open-statement concurrency**: two visits completing for the
   same payer at once must attach to one statement — advisory lock + partial
   unique index (mirrors the charge-now mint lock).
6. **Surcharge on card statement pay** (`services/stripe.js` + `pay-v2.js`):
   online card payment must derive total/PI/surcharge from `computeChargeAmount`,
   not the raw statement total, or card payments undercharge and drift from the
   webhook. ACH/offline don't surcharge. (Statements aren't deposits → not
   surcharge-exempt.)
7. **Payer-scoped `payments` ledger**: `customer_id` is `NOT NULL` today and
   reporting/health key off it; a cross-customer statement payment needs nullable
   `customer_id` + `payer_id`/`statement_id` and every customer-keyed reader
   updated to exclude payer rows — or it fails inserts / misattributes money.
8. **Eastern-time close cron**: month-end close + `due_date` math must use
   `datetime-et` + `timezone: 'America/New_York'` under `runExclusive`, or it
   fires on the wrong UTC date.
9. **Centralized send AND pay block** (`sendViaSMSAndEmail` / `sendInvoiceEmail`
   for delivery; `/api/pay/:token` + the Stripe invoice-PaymentIntent path for
   collection): accrued invoices stay `draft` and still mint a `/pay` token, so
   both the send helpers AND the pay paths must fail-closed on
   `payer_statement_id IS NOT NULL` — else a leaked child token is delivered or
   paid individually (and then double-collected by the statement cascade).
   Statement payment is the only collection path for an accrued invoice.
10. **Accrual atomicity without a caller trx**: `createFromService` + admin
    create paths use the default `db`; `create()` must open its own transaction
    when none is supplied or the advisory lock + insert + rollup aren't atomic.
11. **Close vs concurrent accrual**: the close must take the SAME per-(payer,
    period) advisory lock (not just `runExclusive`) before freezing, or a visit
    can attach after the statement was sent / the PDF total goes stale.
12. **Pay only frozen statements**: the statement `/pay` path must refuse `open`
    (still accruing), `void`, and `paid` — paying a mutable open statement lets AP
    settle a total that later visits still change.

## Out of scope (later)

PO hard-enforcement (separate Phase-2 item); tech-completion "Billed to … don't
collect" banner (lands after the CompletionPanel rebuild in the completion-flow
redesign); payer credit/pre-payment ledger; partial statement payments;
multi-currency.
