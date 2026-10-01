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
| **Subject** | `{type, id}` | What the row is about: `customer`, `visit`, `invoice`, `estimate`, `lead`, `call`, `check`. One open row per subject per class. |
| **Done-when** | a named predicate | The condition that clears it, e.g. `invoice_sent`, `visit_priced`, `promise_fulfilled`, `count_zero`. The emitter that raises a row owns clearing it. |
| **Who** | `person` / `claude` / `either` | Who may resolve it. See section 5. |

Examples:

| Headline | Why |
|---|---|
| Billing — charge 5 invoices with a card on file | $1,254 never charged; the oldest is 41 days old. |
| Schedule — book Diane Dizon's wasp removal | She confirmed Sat Oct 4 at 11:00 on a call; nothing is on the calendar. |
| Comms — call Mona Refay back | Promised on a 3:22 PM call; an hour has passed with no contact. |
| System — Venice review sync silent 3 days | No new reviews fetched since Sat; Google shows 2. |

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
2. **Clear yourself.** An emitter that re-raises a stable key closes it when its
   done-when holds (`server/services/admin-alert-episodes.js`). The relevance sweep
   (`server/services/admin-alert-relevance.js`) is the backstop for one-shot classes only.
3. **Budget.** Rows that are not a customer reaching out should ring at most 10 times a
   day in total. A class that would push past that becomes a standing count.
4. **Retention.** An `fyi` fact lives on its page for 7 days at most. A `needs-you` row
   unread for 14 days belongs in the Monday summary, not in the bell.
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

## 6. What is enforced today

| Rule | Where | State |
|---|---|---|
| Headline 60, why 110 and one sentence, Area from the list, severity / subject / done-when / who present, a link that opens an admin page other than the Activity feed | `composeAdminAlert` throws on a violation | enforced for every caller of the helper |
| Forbidden tokens in headline and why | `composeAdminAlert` throws | enforced for every caller of the helper |
| New code must use the helper | `server/tests/admin-alert-raw-callsite-ratchet.test.js` counts raw `notifyAdmin(` call sites per file against a checked-in ceiling; a file may not gain one | ratchet |
| No emoji in admin text | `notification-service.js` | enforced, all categories |
| Done state: a done row is hidden from the bell list, its unread count and mark-all-read (the Activity feed keeps it, marked Done). Every id-addressed done write is `NotificationService.markAdminDone`; emitters that close inside their own fenced update spread `doneColumns` into it. Auto-done sources: episode closes (`closeAdminAlertKeys`, `done_by` `episodes`), the relevance sweep (`relevance`), an ops-digest fall-off resolve, a superseded missed-call bell, a retired missing-deduction bell, a superseded promise-chaser bell, a resolved no-show dispatch tracking bell, and every other system retire (a newer bell replaced it, a batch absorbed it, the work was done: the call-commitments watchdog, the follow-up pager, procurement, collections cards, the setup-fee and first-application alerts, the cancellation review bell). A system writer never retires an alert with `read_at` alone; `server/tests/notification-system-retire-closes-done-contract.test.js` fails any non-null `read_at` write that does not also close done, unless it is a named person's read or another table. Not done: any mark-read by a person (a thread open, mark-all-read, a dashboard dismiss). | `PUT /api/admin/notifications/:id/done` (same role scope as mark-read) and `/:id/reopen` (admin only; body `{ doneAt }` is the `done_at_token` the Recently-done list served, a row done again since answers 409 `changed`, and only a row a person closed (`done_by` a technician id or `claude`) can be reopened, a system close answers 409 `not_reopenable`); the bell's Done control | enforced |
| Body over 110 chars moves to `detail`, read from the bell's "Show full text" | `notification-service.js`, kill switch `ADMIN_BODY_GUARD_ALL` | enforced, all categories |

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
A source that partly fails says so in `warnings`: a dashboard queue that threw is named
(`{ source: 'dashboard_alerts', generator, error }`) instead of reading as empty.

An item with `derived: true` comes from an older raw `notifyAdmin` call that never stamped
the eight parts (a dashboard standing condition is not one of these: it is `derived: false`).
Its area is inferred from the category, its severity is `broken` only for a
`FIX` digest (for a digest with no stamped kind, the legacy title prefix decides: `FIX:` broken,
`ACT:` / `[Review]` needs-you, `FYI:` / `OK:` fyi and left out), a registry event its trigger marks `informational` (a payment received, a job completed) is `fyi` and left out, its who is `person` (an engineering digest is `claude`), its subject is read
from the ids in its metadata, and its done-when is unknown. Treat those as best guesses and
read the record behind the link before acting.
