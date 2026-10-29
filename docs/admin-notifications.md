# Admin notifications: the rule

Owner ruling 2026-09-30. Applies to every notification an admin sees: the bell, push,
the dashboard Action Inbox, page banners, and the Agents Activity feed. It is written for
two readers: the owner, who reads the copy, and a Claude session, which reads the
structured fields and acts on them.

If you are adding or changing an admin notification, this page is the contract. Raise it
through `composeAdminAlert` (`server/services/admin-alert-compose.js`), never with a
hand-written title and body.

## 1. Two kinds, two surfaces

- **An event** is something that just happened and needs a person or Claude: a customer
  texted, a card declined, a visit completed unpriced, a check found a new exception.
  An event rings the bell once per episode.
- **A standing condition** is a state that persists: 25 drafts unsent, 63 hygiene
  exceptions, 7 callbacks due today. A standing condition never rings. It is a count in
  the dashboard Action Inbox (`server/services/dashboard-alerts.js`) and on the page where
  the work happens, and it clears itself at zero. It may ring once when it first appears
  or when a new member joins (`count` / `newCount` / `itemKeys`, ring only on change).

Test before you add a bell: can someone do something about this now, is it new, and would
they miss it if it were only a count on a page? If any answer is no, it is not a bell.

## 2. The eight parts

| Part | Limit | Rule |
|---|---|---|
| **Area** | one of nine | Comms, Schedule, Billing, Estimates, Leads, Customers, Inventory, Content, System. |
| **Headline** | 60 chars | `<Area> — <what to do>`. Verb-led and self-contained: it reads correctly with nothing else visible. No `ACT:` / `FIX:` / `[Review]` prefix. |
| **Why** | 110 chars, one sentence | The fact that makes it worth doing now: who, how much, how old. |
| **Severity** | `needs-you` / `broken` / `fyi` | `needs-you`: a person decides or acts; rings the bell. `broken`: something of ours failed; goes to the Activity feed, not the bell. `fyi`: never rings and writes no row. |
| **Link** | one | Opens the record where the fix is made, not a list page, whenever a record id is known. Never the Activity feed for a `needs-you` row. |
| **Subject** | `{type, id}` | What the row is about: `customer`, `visit`, `invoice`, `estimate`, `lead`, `call`, `check`, `equipment` (a truck or a tool). One open row per subject per class. |
| **Done-when** | a named predicate | The condition that clears it, e.g. `invoice_sent`, `visit_priced`, `promise_fulfilled`, `count_zero`. The emitter that raises a row owns clearing it. |
| **Who** | `person` / `claude` / `either` | Who may resolve it. See section 5. |

Examples:

| Headline | Why |
|---|---|
| Billing — charge 5 invoices with a card on file | $1,254 never charged; the oldest is 41 days old. |
| Schedule — book Diane Dizon's wasp removal | She confirmed Sat Oct 4 at 11:00 on a call; nothing is on the calendar. |
| Comms — call Mona Refay back | Promised on a 3:22 PM call; an hour has passed with no contact. |
| System — Venice review sync silent 3 days | No new reviews fetched since Sat; Google shows 2. |

**Say who and what** (owner audit 2026-10-01). A bell is read before anything is opened, so
the customer's name (or the sender's) belongs in the headline and the words behind the alert
belong in the why: a text, an email, a promise we made, the failed amount, the visit date.
"Comms — send Albert Clark the estimate" with "“Swarming termites mobile home tenting free
estimate” (Sep 29) — no estimate sent yet." works; "An SMS request needs follow-up" does not.
Quote the customer, redacted the way every bell body is (`redactSensitiveText`, so a phone
number or street address is masked), cut to the 110 characters at a word, and keep the whole
quote in `detail`. `server/services/admin-alert-names.js` has the helpers (`fitAction` keeps a
long name inside the 60-character headline; `whyWithQuote` budgets the quote). Where an
alert is about a visit or an invoice, the link opens that visit or invoice, not a list page.

### A ninth part: Buttons (optional; owner 2026-10-29)

A row may carry up to three buttons, so a person can act from the bell without opening the page.
The owner's rules ("ok go" on the plan, Oct 29):

1. A button does only what a button on the linked page already does, through the same server
   step and the same checks.
2. The server reads the record again at the tap. It never trusts the row's words.
3. No button texts or emails a customer, moves money or flips a gate, unless the owner rules so
   for that kind of notification. A kind whose step can do one of those holds the button back in
   those cases, and the page does it instead.
4. The server sets a row's buttons when it raises the row. The phone or browser cannot add one:
   a tap names a button the row carries, and nothing else runs.
5. A tap records who pressed what and when (`metadata.buttonTaps`, one entry per tap), and
   closes the row. One tap runs at a time: it claims the row in one conditional write against the
   version the bell served, so a second tap at the same moment, or after, does nothing.

How: `buttons: { kind, items: [{ id, label, prompt?, args? }] }` in the spec, kept as
`metadata.buttons`. `kind` names a handler in `server/services/admin-alert-buttons.js` (`KINDS`).
`id` is a slug; `label` is at most 32 characters; `prompt` is one sentence of at most 110 characters
that the bell asks before it sends (give one to any step the bell cannot undo); `args` holds up to
four short strings or numbers that the handler checks again at the tap. `composeAdminAlert` checks
the shape and the section 3 tokens in labels and prompts. The bell list serves a row's buttons as
`actions` (`{ id, label, prompt }`) to the admin role only, on open rows, while the kind's gate is
on. A kind whose buttons depend on the record as it stands now gives its handler `visibleItems(rows)`:
one read for that kind's rows on the page, answering which stored buttons each row serves (a row it
leaves out serves none; a failed read serves none of that kind). The tap still checks again. A tap is `POST /api/admin/notifications/:id/actions/:actionId` with the row's `version` (the
Done fence). A changed row, a second tap or a refusal by the step answers 409 with a short message,
and the bell reloads its list.

Kinds today:
- `referral_inbound` (`server/services/referral-inbound-bell.js`, `GATE_REFERRAL_INBOUND_BELL`): the
  row for a card in Referrals → Queue, with **Confirm <referrer>** and **Not a referral**, the
  Queue's own `confirmInboundReferral` and `dismissInboundReferral`. Confirm is offered only for one
  sure referrer (the link code's owner, or the one customer whose first and last name match the name
  the caller gave), only while the program pays rewards at the first visit, only before the
  friend's first plan visit, and only when it is not the referrer's 3rd, 5th or 10th referral. Then
  the tap sends nothing and moves no money: the $25 credits and the referrer's 9:00 AM email follow
  the first plan visit. The confirm step itself (`deferredOnly`) checks each of these again under its
  locks and saves nothing when one fails. Any other case is answered in the Queue.
- `close_note` (`server/services/admin-alert-buttons.js`, `GATE_ALERT_CLOSE_BUTTONS`): close-only
  buttons. **Handled** on a customer's texts (the `sms_reply` thread row), **Called back** on a
  text call-back follow-up (an `sms_operational_followup` row for a call-back promise; other
  promise kinds and email follow-ups get no button) and on a missed call (`customer_missed_call`). The step is the bell's own
  Done with the button's label as the note, fenced on the version the tap claimed (a new message
  that rewrote the row meanwhile is never closed unseen), and it settles a text follow-up the row
  speaks for, as Done does. It sends no reply and places no call. A follow-up row that is no longer
  call-back only writes `buttons: null`, so a refresh drops the old button. The emitters set the button when they raise the
  row (`closeNoteButtons`), so rows raised before the change carry none.
- `bid_decision` (`server/services/bid-desk/alert-buttons.js`, `GATE_BID_ALERT_BUTTONS`, a trial;
  owner 2026-10-29): **No bid** and **Bid** on a new bid invite's row (`bid-desk:new:<bid>`). Both
  are stored at raise; `visibleItems` serves No bid while the bid is still new, and Bid only once
  its due date is confirmed on the Bid desk (its reminders run on no other date). A tap is the Bid
  desk's own save step (`saveBidUpdate` in `server/routes/admin-bid-desk.js`, behind the page's Save
  decision) with the same checks again under its row lock: still new, and a confirmed date for Bid.
  It sends nothing to a buyer or customer and moves no money. Off unless `GATE_BID_DESK` is on too.

## 3. Never in a headline or a why

Timestamps and ISO dates, UUIDs and hashes, table and column names, `GATE_*` and other
env names, file paths, status values in code form (`on_site`), bracketed check names
(`[venice:silent_empty]`), the phrase "0 new", counts of things that did not change, good
news, emoji, exclamation marks. Those belong in `detail` or in the record behind the link.

A weekday or a short date a person would say ("Sat Oct 4 at 11:00") is fine.

**What counts as one sentence.** The check is deliberately simple: a `.`, `?` or `!`
followed by a space and a capital letter ends a sentence, except after a title that is
always followed by a name (Mr, Mrs, Ms, Dr, St, Mt, Ft). So "Acme Inc. Retry it now" and
"plan A. Review it" are two sentences, and "J. Rivera asked" reads as two as well: write
the full name. `firstSentence(text)` in the same module takes the first sentence of a
customer's message by this rule.

## 4. Lifecycle

1. **Ring once per episode.** A refresh of the same subject and class updates the row in
   place and keeps its read state (`refreshOnDedupe` with `ringOnRefresh`). A comeback
   after the row was cleared rings again.
   A customer who keeps texting is one subject: a known sender's texts share ONE bell row
   (`dedupeKey` `sms-thread:<customerId>`, `refreshOnDedupe` + `bumpOnRefresh`). Each new
   text rewrites it (latest text as the body, "3 texts from Name" in the title, unread,
   moved to the top) and still pushes; the count restarts once the row was read or done.
   The link keeps its `?thread=<customerId>` prefix, which the thread-read matchers use.
   A standing backlog (overdue promises past five) is a count on its page, never a bell:
   its aggregate row is Activity-only (`metadata.feed = 'activity'`). Engineering work a
   Claude window picks up by itself (an Intelligence Bar gap) goes to the Activity feed
   as an `ops_digest` row, not the bell.
2. **Clear yourself.** An emitter that re-raises a stable key closes it when its
   done-when holds (`server/services/admin-alert-episodes.js`). The relevance sweep
   (`server/services/admin-alert-relevance.js`) is the backstop for one-shot classes, and
   for the customer-contact bells (owner 2026-10-24: "most of these should close
   automatically ... text sent, agent confirms resolved, appt booked, rescheduled").
   A customer's text, voicemail callback request, email or new lead closes once
   a person answered it (a missed-call bell is closed by `server/services/missed-call-bell.js`,
   its one owner, on the same facts: a person's text, a booked visit, a handed-off quote, beside
   its own called-back proof), judged only by what happened AFTER the text, call or email the bell
   is about, and only by the repo's shared witnesses: the Messages "needs a reply" reader
   for a text, a person's text, a person's call back, a call a human answered, a booked
   visit, a quote handed off, a person's Gmail reply. Never because someone opened or read
   the bell (`read_at` is not evidence). It is behind `GATE_ALERT_CONTACT_CLOSE`: off, or
   `shadow` (records what would close in `audit_log`, changes no bell), or `true` (closes).
   Two rules carry their own gate (off / `shadow` / `true`, rollback = unset): a voicemail
   closes once the customer's own visit completed after it the same Eastern day
   (`GATE_VOICEMAIL_VISIT_UNDERWAY`), and a Leads bell with `doneWhen: 'lead_contacted'` and a
   lead id closes once the lead was texted or called back, booked or quoted after the bell
   (`GATE_LEAD_CONTACTED_CLOSE`). Details in `docs/gates-and-env.md`.
   A staff action also answers a text (`GATE_SMS_STAFF_ACTION_ANSWERS`, off / `shadow` / `true`,
   rollback = unset): a visit a person booked in the admin, or a payment a person recorded,
   for the text's customer (by customer id) within 24 hours after the text. In `true` the Messages
   reader counts the text as answered too, so the Unanswered filter and the evening digest agree.
   A new text from the same sender rings a fresh bell: the thread row is rewritten, rung and
   re-opened. The sweep never contacts a customer.
3. **Budget.** Rows that are not a customer reaching out should ring at most 10 times a
   day in total. A class that would push past that becomes a standing count.
   Exception (owner ruling 2026-10-01): time-critical field work, a visit due today or
   tomorrow with no time or technician (`server/services/combined-booking-check.js`), always
   rings; tomorrow it may be too late to act.
   Exception (owner audit 2026-10-22, finding 1): the auto-dispatch move-check-down notice
   (`server/services/auto-dispatch/check-down-notice.js`) rings once per outage and is never
   held back by the allowance; it counts toward it. A tool that has stopped moving visits is
   the notice that must reach a person.
   Far double bookings (owner audit 2026-10-22, decision D1; `GATE_AUTO_DISPATCH_FAR_CONFLICT_QUIET`):
   a visit auto-dispatch leaves in conflict more than 14 days out is a line on one standing
   Activity row (ops digest `auto-dispatch-far-conflicts`, audience fyi), outside the allowance
   and off the bell; it rings as the ordinary needs-a-person notice once it is within 14 days.
4. **Retention.** An `fyi` fact lives on its page for 7 days at most. A `needs-you` row
   unread for 14 days belongs in the Monday summary, not in the bell.
   Built now (owner 2026-10-26, `GATE_ALERT_RETENTION`, `server/services/admin-alert-retention.js`,
   nightly 1:32 AM ET): a bell row not done whose last activity is more than 30 days old is marked
   done, read or unread; an `fyi` row (and an `ops_digest` row of audience `fyi`) idle for more than
   7 days is marked done. Last activity is the latest of `created_at`, `metadata.rungAt`,
   `metadata.observedAt` and `metadata.lastFailureAt`, so a row its emitter still refreshes with a
   ring stays; a quiet refresh leaves no stamp and ages from the last ring. The row is marked done
   (`done_by` `retention`, a plain `resolution`, `metadata.retention` with the run time), never
   deleted, and its read state is not touched. The 14-day Monday-summary rule is not built. An
   emitter that dedupes on open rows only (`dedupeOpenOnly`) raises a fresh row when its condition
   still holds after the old one expired; `RERING` in the module names each one, caps the ones a
   sweep raises again with no new event, and skips an overdue-promise row while its promise is open.
   `server/scripts/undo-admin-alert-retention.js` reopens one run.
5. **Read is not done.** A row has a `done` state (`notifications.done_at`, `done_by`,
   `resolution`), the GitHub inbox model. Reading a row only stops it counting as unread; a
   done row leaves the bell, its unread count and mark-all-read. A row goes done when the
   condition it was about has cleared (the emitter's own close, or the relevance sweep) or when
   a person marks it done by hand. A done row keeps a one-line `resolution` of what fixed it,
   and a comeback of the same alert clears the done state and rings again.

## 5. Who may act

- **`claude`**: a Claude session may resolve it without asking. Owner-approved classes:
  engineering failures (`broken`), deterministic data-hygiene fixes, re-sends of failed
  system email, and reminders about stale drafts (the reminder, never the send).
- **`person`**: money decisions, anything that contacts a customer, gate flips, and
  anything behind a kill switch.
- **`either`**: Claude drafts, a person approves.

A Claude session that resolves a row says what fixed it (the PR or the change). It never
resolves a `person` row.

**Claude's own queue** (owner 2026-10-26, `GATE_ALERT_CLAUDE_QUEUE`). Two kinds of row never
belong in the owner's bell, because the owner would only relay them to Claude:
- a reminder from a Claude job on the owner's Mac (`metadata.opsJob`, stamped by
  `~/ops-oneshots/lib/bell.js`). A job marks an ask that is the owner's (a gate flip for the
  owner's gates, a money ask) with `metadata.opsWho = 'person'`; that row stays in the bell.
  Every other job row is Claude's. An `ask` job row is `needs-you`, an `fyi` one is `fyi`.
- one of our own engineering faults, from the named table in
  `server/services/admin-alert-routing.js` (`CLAUDE_QUEUE_CLASSES`): the SMS draft canary
  (`sms-draft-canary:`), a Mac reminder job that failed (`ops-reminder-broken:`), a Google
  review sync that is degraded or cannot store rows (`metadata.reason` `gbp_sync_degraded`), and
  the review sync health escalation marker (`metadata.opsKey` `gbp-sync-health`). These are
  `broken`. Add a class there when a new engineering fault would otherwise ring the owner.
The routing is server-side, in `NotificationService.create` and `notifyAdmin`: no emitter and no
Mac code decides it. A routed row is written Activity-only (`metadata.feed = 'activity'`) and
stamped `who = 'claude'`, so `needs-me --who claude` lists it. It is written even when the
bell policy would silence a ring, because it is no longer a ring, and a refresh never puts it
back in the bell. Never routed: a customer-contact category (`inbound_sms`, `inbound_email`,
`missed_call`, `voicemail_callback`, `new_lead`), a trigger-registry row, a row tied to a
customer, and an `ops_digest` row (owner 2026-09-11: ACT / FIX exceptions from the Mac ops
checks stay in the bell). The Agents Activity feed shows every routed row (`metadata.claudeQueue`: open ones however old, plus ones created or closed in the window) under the agent "Claude's queue", fyi rows included (`needs-me` leaves fyi out because it is never work); the feed's Done is the same fenced done write. Rows already open in the bell move once with
`server/scripts/reroute-claude-queue-rows.js` (dry run by default).

## 6. What is enforced today

| Rule | Where | State |
|---|---|---|
| Headline 60, why 110 and one sentence, Area from the list, severity / subject / done-when / who present, a link that opens an admin page other than the Activity feed | `composeAdminAlert` throws on a violation | enforced for every caller of the helper |
| Forbidden tokens in headline and why | `composeAdminAlert` throws | enforced for every caller of the helper |
| New code must use the helper | `server/tests/admin-alert-raw-callsite-ratchet.test.js` counts raw `notifyAdmin(` call sites per file against a checked-in ceiling; a file may not gain one | ratchet |
| No emoji in admin text | `notification-service.js` | enforced, all categories |
| Done state: a done row is hidden from the bell list, its unread count and mark-all-read (the Activity feed keeps it, marked Done). Every id-addressed done write is `NotificationService.markAdminDone`; emitters that close inside their own fenced update spread `doneColumns` into it. Auto-done sources: episode closes (`closeAdminAlertKeys`, `done_by` `episodes`), the relevance sweep (`relevance`; also the customer-contact bells once a person answered, behind `GATE_ALERT_CONTACT_CLOSE`: a text no longer needing a reply, a voicemail callback request after a person called back or texted or a visit or quote followed, and, closed by `missed-call-bell.js` instead (`done_by` `supersede`), a missed call after a person texted the caller or a visit or quote followed, an email a person replied to, a lead a person contacted), an ops-digest fall-off resolve, a superseded missed-call bell (a voicemail on the same call, or the caller got through on a later call within 7 days: `retireCalledBackMissedCalls`, 2-minute call-alert cron), a retired missing-deduction bell, a superseded promise-chaser bell, a resolved no-show dispatch tracking bell, a booking-miss bell once its visit is booked, done on another day, or 14 days after its agreed day (`call-booking-miss-watchdog.js`; a visit booked on another day turns the bell into a date check), a logged-delivery bell once no live restock request may cover it (`purchase-receipts/sweep.js`; a delivery with no such request writes none), and every other system retire (a newer bell replaced it, a batch absorbed it, the work was done: the call-commitments watchdog, the follow-up pager, procurement, collections cards, the setup-fee and first-application alerts, the cancellation review bell). A system writer never retires an alert with `read_at` alone; `server/tests/notification-system-retire-closes-done-contract.test.js` fails any non-null `read_at` write that does not also close done, unless it is a named person's read or another table. Not done: any mark-read by a person (a thread open, mark-all-read, a dashboard dismiss). | `PUT /api/admin/notifications/:id/done` (same role scope as mark-read) and `/:id/reopen` (admin only; body `{ doneAt }` is the `done_at_token` the Recently-done list served, a row done again since answers 409 `changed`, and only a row a person closed (`done_by` a technician id or `claude`) can be reopened, a system close answers 409 `not_reopenable`); the bell's Done control | enforced |
| Claude's own reminders and our engineering faults leave the bell: an admin row with `metadata.opsJob` (unless `opsWho` is `person`) or in a named fault class is written Activity-only and stamped `who = claude`, `severity` `broken` for a fault; customer-contact categories, registry events, customer-tied rows and `ops_digest` rows are never routed | `server/services/admin-alert-routing.js`, applied in `NotificationService.create` and `notifyAdmin`; `server/scripts/reroute-claude-queue-rows.js` moves rows already open | enforced while `GATE_ALERT_CLAUDE_QUEUE` is on (dark by default) |
| Retention: a bell row idle 30 days, and an `fyi` row idle 7 days, is marked done (never deleted, read state kept). Not built: the 14-day Monday summary for an unread `needs-you` row | `runAdminAlertRetention` in `server/services/admin-alert-retention.js`, nightly 1:32 AM ET, gate `GATE_ALERT_RETENTION` (`shadow` records one audit_log summary, `true` expires); undo with `server/scripts/undo-admin-alert-retention.js` | enforced when the gate is `true` |
| Catalog (owner 2026-10-29, step D1): every `TRIGGER_REGISTRY` type declares a `rule`: area, severity, who, and either `doneWhen` + `closedBy` (the module that marks its rows done) or `expiryDays` (30 for needs-you and broken, 7 for fyi; only the retention sweep closes it). Severity `fyi` replaces the old `informational` flag. In watch mode a muted alert is countable: when the bell policy silences an admin row, one `audit_log` row per Eastern day per distinct alert records its category, trigger key and digit-free title stem. Nothing is refused | `server/tests/admin-alert-catalog-contract.test.js` fails a type with no valid rule; `auditBellPolicyMuted` in `server/services/audit-log.js`, called at both silence points (`NotificationService.create`, and `triggerNotification`, which checks the policy itself and returns before create), action `notification.bell_policy.muted` | contract enforced; watch mode behind `GATE_ALERT_CATALOG=watch` (dark by default) |
| Body over 110 chars moves to `detail`, read from the bell's "Show full text" | `notification-service.js`, kill switch `ADMIN_BODY_GUARD_ALL` | enforced, all categories |
| Buttons (section 2, part 9): only a button the row carries runs; its handler reads the record again; a tap is admin only, claims the row against the version the bell served (one tap at a time), is recorded on the row, and closes it | `server/services/admin-alert-buttons.js` (`withAlertButtons`, `runAlertButton`) behind `POST /api/admin/notifications/:id/actions/:actionId`; the shape is checked by `composeAdminAlert` | enforced per kind while its gate is on (`referral_inbound`: `GATE_REFERRAL_INBOUND_BELL`, dark by default) |

Existing raw `notifyAdmin` call sites keep working. They are converted by Area in later
changes, and the ratchet's numbers only fall.

## 7. How to raise one

`composeAdminAlert(spec)` is pure. It validates the eight parts and returns
`{ headline, why, link, metadata }`, where metadata carries:

```
metadata.area        one of the nine Areas
metadata.severity    needs-you | broken | fyi
metadata.subject     { type, id }
metadata.doneWhen    predicate name
metadata.who         person | claude | either
metadata.buttons     { kind, items } when the spec has buttons (section 2, part 9)
```

Then, by severity:

- **`needs-you`**: `raiseAdminAlert(category, spec, opts)` composes and calls
  `NotificationService.notifyAdmin(category, headline, why, { ...opts, link, metadata })`.
  `category` stays the emitter's own, because notification preferences and the bell policy
  key on it. `opts` are `notifyAdmin`'s own (`dedupeKey`, `refreshOnDedupe`,
  `ringOnRefresh`, `trx`, `bell`).
- **`broken`**: the Activity feed reads `ops_digest` rows only, so an engineering finding
  goes through `deliverOpsDigest` (`server/services/ops-digest.js`) with the composed
  `headline` and `why` as its `headline` and `summary`, `audience: 'engineering'`, and
  the full finding as `text`. `raiseAdminAlert` refuses a `broken` spec and says so.
- **`fyi`**: `raiseAdminAlert` writes nothing and returns
  `{ id: null, suppressed: true, reason: 'fyi' }`. An FYI fact belongs on its page.
  The one exception is an emitter the owner has ruled should leave a row: it passes
  `fyiRow: true` in `opts` and the FYI is written like a `needs-you` row, with
  `metadata.severity` still `fyi` (today only the `/book` preferred-time request that
  closes itself when the customer books, under category `lead`).

A rule violation never costs an alert. Outside tests, a `needs-you` spec that breaks the
rule still rings, with its headline cut to 60, the structured fields that are valid
(area, severity, subject, done-when, who) kept, a link the rule refuses dropped, and `metadata.ruleViolations` naming the
rules it broke, and a warning is logged with the category and rule names only. Under
`NODE_ENV=test` the same violation throws, so the emitter's own tests catch it.

A why that quotes a customer's own words (a service request, a text) can trip the
section 3 checks through no fault of the emitter. That is the fallback's job; do not
rewrite what the customer said to get past it.

## 8. For Claude specifically

Read what is open in one call instead of reading alert text and guessing. Each item comes
back in the shape of section 2: area, headline, why, severity, link, subject, done-when,
who. Pick the ones a session may fix alone with `who=claude` (exact: it returns `claude` only,
never `either`, where a person still approves; `who=either` lists those; section 5 says what each
may do), and never resolve a `person` item.

- Route: `GET /api/admin/needs-me?who=&area=&limit=` (`server/routes/admin-needs-me.js`),
  scoped to the caller's role like the bell list.
- Intelligence Bar tool: `needs_me` (`server/services/intelligence-bar/needs-me-tools.js`).
- CLI: `railway run --service Postgres node ops/agents/needs-me.js --who claude`
  (`--json` for the full object).
- All three are one reader, `listNeedsMe` in `server/services/needs-me.js`. It lists open
  admin rows that are not done, including Activity-feed rows (the bell never shows those; they
  carry `activityOnly: true`, and engineering `broken` findings are among them), and the
  dashboard's standing counts, which are `needs-you`, `person`, done when the count is zero.
An `ops_digest` row for the `fyi` audience is severity `fyi` and is never listed. An alert
carries `detail`, the full finding (bounded to 2,000 characters; an engineering digest's
diagnosis may live only there); when the row has no body, `why` is the first sentence of it.
Every open row joins one global order (no scan cap: the walk reads only what classifying and ordering need, and body/detail are read for the returned page alone). A digest already marked `resolved` is closed even without `done_at`. A source that partly fails says so in `warnings`: a dashboard queue that threw is named
(`{ source: 'dashboard_alerts', generator, error }`) instead of reading as empty.

**Unsorted** (owner 2026-10-01): a raw `notifyAdmin` row with no stamped severity that is
neither an `ops_digest` nor a registry event (`metadata.triggerKey`) carries no signal for work
versus note. It is listed with `unsorted: true` and `severity: null`, after all known work, and
is left out of `total` and `counts`; `unsortedTotal` counts it. The bar tool returns these in
`unsorted`, the CLI under its own heading. A source leaves the pile by raising through
`raiseAdminAlert` (or the trigger registry).

An item with `derived: true` comes from an older raw `notifyAdmin` call that never stamped
the eight parts (a dashboard standing condition is not one of these: it is `derived: false`).
Its area is inferred from the admin page its link opens, else from the category, its severity is `broken` only for a
`FIX` digest (for a digest with no stamped kind, the legacy title prefix decides: `FIX:` broken,
`ACT:` / `[Review]` needs-you, `FYI:` / `OK:` fyi and left out), a registry event whose rule declares severity `fyi` (a payment received, a job completed) is `fyi` and left out, its who is `person` (an engineering digest is `claude`), its subject is read
from the ids in its metadata, and its done-when is unknown. Treat those as best guesses and
read the record behind the link before acting.
