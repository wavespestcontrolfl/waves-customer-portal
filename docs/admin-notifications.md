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
quote in `detail`. One exception: the SMS reader's review bell ("Comms — check <name>'s text
note") never stores the text, because a text can hold a code or a word that opens a door and no
screen catches every form; the bell list reads it from the text itself while it serves the list
(`withTextNoteSources` in `server/services/sms-operational-actions.js`, admin role only, masked
the same way) and the bell shows it in quotes as `source_text`. `server/services/admin-alert-names.js` has the helpers (`fitAction` keeps a
long name inside the 60-character headline; `whyWithQuote` budgets the quote; `nameOnFileForPhone` names the
person behind a number with no customer link: the customer records on it, then estimates, then leads, only when
they agree on one person. The promise chaser, a text to a website line and a voicemail use it; owner 2026-10-21 and
2026-11-04, "it should be the name of the person rather than just the number, if possible, if we have it on file"). Where an
alert is about a visit or an invoice, the link opens that visit or invoice, not a list page.

**The bell names the customer and says what to do** (owner 2026-11-02, `GATE_ALERT_EXPLAINER`, admin logins
only). Many rows still never name the customer (an older raw emitter, an ops check), and a long body cut into
`detail` read back as raw check output. Two things cover every row, whatever its emitter wrote:
- The bell list serves the customer a row is about (`customer: { id, name }`), read by
  `server/services/admin-alert-customer.js` from the record behind it: a customer id (subject, top level,
  trigger payload, SMS thread, a customer page link), else the visit, estimate, invoice, lead or call it names,
  in one query per table for the page. An estimate or lead with no customer keeps its own name. The bell shows
  "Customer: Name" under the title unless the title already carries the whole name. `GATE_ALERT_CUSTOMER_LINE`
  (owner 2026-11-05) gives the admin bell this line alone while `GATE_ALERT_EXPLAINER` stays off: the same name
  read (a database read, no AI call) adds `customer` and nothing else to each row, so there is no "What to do"
  button and the row keeps "Show full text". Only the bell list gets names; the done list does not.
- "Show full text" becomes **What to do**: what happened, one to three steps, and whether the owner or Claude
  fixes it. `server/services/admin-alert-explainer.js` asks an AI for it the first time an admin opens it
  (`POST /api/admin/notifications/:id/explain`, `TEXT_POLICIES.routineAnswer`, lane `alert_explainer`), from the
  row's title, body, detail and page (phone numbers, emails and street addresses masked, as in every bell body) and
  the customer's name, and saves it on the row (`notifications.explainer`)
  for the content version it was written from. The summary is not part of the version, so saving it never
  fences a Done or a tap; a row whose text changes gets a new one. A stamped `who` decides the fixer. When both
  providers fail the panel shows the row's own words, marked as such, nothing is saved, and the row is not asked
  about again for a minute. The original text
  stays one tap further ("Show original text"). Emitters change nothing: a good headline and why still matter,
  because the bell is read before anything is opened.

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
   version the bell served, so a second tap at the same moment, or after, does nothing. The one
   exception is **Call** (kind `call_back` below): a call can ring out, so its step answers
   `keepOpen`, the row stays open (the bell reads its list again for the new version), and the row
   closes by its own done-when, its close button or Done. A later tap calls again, as the page's own
   button would.

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
- `call_back` (`server/services/alert-call-button.js`, `GATE_ALERT_CALL_BUTTON`; owner 2026-11-02:
  "for the voicemail, or missed call notifications, or any other related to calls, cant we add a call
  button, where we can call them from the admin notification", and a lead's CALL reply): **Call** on a
  row about one caller. The owner's ruling for this kind under rule 3: a tap places a call, and only
  after the owner presses 1 on their own phone does it ring the customer. The row names one record in
  `args`: its call (`callLogId`, or `callSid` for an urgent Sandy caller raised during the call) on a
  missed call, a voicemail, a promise chaser, a repeat caller and a Sandy hand-off; its lead
  (`leadId`) on a new-lead alert (owner 2026-11-02, "A Call button on new website-lead alerts"),
  else its customer (`customerId`) on a web form whose lead row failed, a landline, a lead's
  call-back bells, a text call-back follow-up and a lead's bare CALL text, else an unknown sender's
  text (`smsSid`) on a new-lead alert for a text to a website number. The tap reads that record
  again and runs the handler behind
  `POST /api/admin/communications/call` in-process (`placeCallFromAlert`) with the body the linked
  page's own button sends: the Call Log's "Call back" (the caller's number, else the linked customer's,
  `source: 'call-log-callback'`, `relatedCallId`), the Leads page's Call Now (the lead's number, its
  customer as `customerIdHint`), the customer page's Call (`customerIdHint`), or the Communications
  thread's Call back (the sender's number). The
  step's own refusal (a callback already ringing) is shown as it reads. The row stays open (rule 5).
  A row that had a close button keeps it after Call (**Called back** on a missed call and a text
  call-back follow-up, **Handled** on the CALL text); that button is the `close_note` step itself and
  follows `GATE_ALERT_CLOSE_BUTTONS`, so each button is served while its own gate is on
  (`visibleItems`). A text thread row takes the buttons of the text it shows: the CALL text's
  emission carries Call, the next text's emission drops it, and an older late text keeps the row's own.
  **On the phone push** (owner 2026-11-02, "A Call button on the phone push notification itself"):
  a registry alert whose row carries Call pushes to admin-role logins with `apnsCategory: 'WAVES_CALL'`
  (APNs `aps.category`) and `callAction: '<row id>.<version>'` (`pushCallAction`, the version the bell
  serves right after the write). The Waves Admin iPhone app (1.8 and later) registers that category
  with a **Call** action, shown when the notification is pressed or pulled down. The action hands
  `<row id>.<version>` to the open staff page as a cancelable `wavesadmin:alertcall` window event, or,
  with no page to take it, loads `/admin/dashboard?alertCall=<row id>.<version>` (`/admin` redirects and
  drops the query); either way the bell runs that
  row's Call through `POST /api/admin/notifications/:id/actions/call` with that version (only inside
  the app, once the staff session is verified; the address loses the param first). The answer waits outside
  the bell for whichever bell is on screen when it lands, so a bell the layout or a route change mounts again
  still shows it. A row that changed since the push answers 409 and the bell shows its list. Alerts raised through `raiseAdminAlert` ring the bell only and send no push.
- `text_note` (`server/services/sms-text-note-buttons.js`, `GATE_ALERT_CLOSE_BUTTONS`; owner 2026-11-02
  "C"): **Save to profile** and **One visit only** on the SMS reader's review bell ("Comms — check
  <name>'s text note", `sms-property-instructions:<sms>`). Both are stored at raise; `visibleItems`
  serves Save only while it would write something. Save re-reads the held-back facts of the bell's
  source text (`bellExceptions`, the set the bell rang for) and writes each through the SMS lane's
  shared compare-and-set writer (`data-hygiene/property-preferences.js`) under the
  `property-preferences` lock: a long-text note (special instructions, access, pet, parking and the two
  irrigation notes) gets the text as a new `[text <date>]` line, and any other field (the four codes,
  the controller location, the contact preference) is filled only while it is empty, so a value on
  file is never overwritten. The profile row is the customer's, so Save writes only for a customer
  with exactly one active property, read at the tap, and only facts that name no property or that one;
  a fact the reader could not pin to one value or topic, or a "no" / "not sure" pet or irrigation report
  it held for a person to read, is left for the profile too. Save follows the reader's own rules: it is off
  while `GATE_SMS_OPERATIONAL_ACTIONS` is off or for a text from before `GATE_SMS_OPERATIONAL_ACTIONS_SINCE`,
  it refuses while a later text's suggestion for the same field waits in Data hygiene, and it retires only
  suggestions from this text or older ones. Each write is audited as
  `sms.property_preference.updated` (field names only), and the bell closes on the version the tap
  claimed; a bell that changed rolls the write back. One visit only is the bell's own Done, fenced the
  same way. Neither sends anything to a customer.
- `negative_keyword` (`server/services/ads/negative-keyword-buttons.js`, `GATE_ADS_NEGATIVES`; owner plan A,
  2026-11-02): **Add** and **Decline** on one ads-advisor word's row (`ads-negative:<id>`, area Leads, category
  `system`, link `/admin/ppc?tab=advisor&negative=<id>`). Both are stored at raise; `visibleItems` serves them only
  while the word is still pending on the Ads page. A tap is the Ads page's own decide step
  (`decideSuggestion` in `server/services/ads/negative-keyword-actions.js`, the route
  `POST /api/admin/ads/negatives/:id/decide`) with its checks again under the row lock: the campaign is still a linked
  Google Ads campaign, the word is not a brand, service or city word, and no search with it brought a conversion in
  90 days. Add writes a phrase-match negative to Google Ads; Decline only records the answer. Each outcome that leaves
  the word not pending closes the row. A Google error leaves the row open to try again. At most 3 new rows a day
  (Eastern); the rest wait on the Ads page and ring on later days, oldest first, and a backlog is never a bell row.
  The owner's own word list sends no bell. It sends nothing to a customer and moves no money; it changes where the ad
  can show, and **Undo** is on the Ads page.

**Listen on a voicemail** (owner 2026-11-04: "for voicemails, can we have a button where we can click on the
voicemail and listen to it within the admin section"). A voicemail row (`customer_voicemail_callback`; not the AI-call
callback, `reason` `sandy_provider_failure`, raised before any recording exists) shows **Listen** above its buttons, for
the admin role. One tap loads the recording of the call the row names (`payload.callLogId`) through the admin-only audio
proxy the Calls tab uses (`GET /api/admin/call-recordings/audio/:id`) and plays it in the bell
(`AuthenticatedCallAudio` with `playOnLoad`). It is not a button kind: it runs no server step, changes nothing on the
row and never opens it; the row closes by its own done-when as before.

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
   A number with no customer record texting a website or van-wrap line is one subject too
   (owner screenshot 2026-11-04: two texts from one number rang two rows): its texts share
   one `new_lead` row (`dedupeKey` `sms-tracking-thread:<hash of the number>`, the same
   refresh, `ringTrackingLineTextBell` in `server/services/sms-reply-alert-delivery.js`),
   "2 texts from wavespestcontrol.com" in the title and the latest text quoted in the why,
   masked like every bell body, then the masked number; with a name on file for the number
   (`nameOnFileForPhone`), the name leads the title and the why ends "via <the line>".
   Its link and Call follow the latest text.
   `GATE_RING_NEW_CONTACTS` (owner 2026-11-04, "ring new", dark) gives a number with no
   customer record texting a location line or a Google Business Profile line the same row
   (`ringUnknownOfficeText`, source "the Parrish (Pest) line"), and the quiet `inbound-text`
   Activity row is skipped when the ring lands (kept when it fails). The AI line, tech lines,
   staff senders, reactions and courtesy closers are not rung. The `tracking_text` sweep class
   closes these rows once a person answers, like a tracking-line row.
   A customer's number that keeps failing texts is one subject too (owner 2026-11-04, "fix check",
   `GATE_DEAD_NUMBER_ALERT`, `server/services/dead-number-alert.js`): the second failed text in a row (Twilio 30003 or
   30005; no delivered text in between, ordered by send time) to the same number in 180 days raises ONE row,
   "Customers — Jane D.'s phone can't get texts" (`dedupeKey` `dead-number:<customerId>:<last10>`, open-only,
   done-when `phone_replaced`). It closes at the customer's next delivered text when that text went to the dead
   number and was sent after its last failure, or the number is no longer their phone or secondary phone.
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
   a person answered it (a text to a website or van-wrap line from a number with no customer
   record too, judged by that text's sender number: owner 2026-11-04, "D") (a missed-call bell is closed by `server/services/missed-call-bell.js`,
   its one owner, on the same facts: a person's text, a booked visit, a handed-off quote, beside
   its own called-back proof), judged only by what happened AFTER the text, call or email the bell
   is about, and only by the repo's shared witnesses: the Messages "needs a reply" reader
   for a text, a person's text, a person's call back, a call a human answered, a booked
   visit, a quote handed off, a person's Gmail reply. Never because someone opened or read
   the bell (`read_at` is not evidence). It is behind `GATE_ALERT_CONTACT_CLOSE`: off, or
   `shadow` (records what would close in `audit_log`, changes no bell), or `true` (closes).
   Three rules carry their own gate (off / `shadow` / `true`, rollback = unset): a voicemail
   closes once the customer's own visit completed after it the same Eastern day
   (`GATE_VOICEMAIL_VISIT_UNDERWAY`), a Leads bell with `doneWhen: 'lead_contacted'` and a
   lead id closes once the lead was texted or called back, booked or quoted after the bell
   (`GATE_LEAD_CONTACTED_CLOSE`), and a portal chat hand-off bell (`doneWhen: 'customer_answered'`)
   closes once a person called back, answered the customer's call, texted or emailed that
   customer after the bell (`GATE_PORTAL_CHAT_ANSWERED_CLOSE`; never the email-change bell).
   Details in `docs/gates-and-env.md`.
   A staff action also answers a text (`GATE_SMS_STAFF_ACTION_ANSWERS`, off / `shadow` / `true`,
   rollback = unset): a visit a person booked in the admin, or a payment a person recorded,
   for the text's customer (by customer id) within 24 hours after the text. In `true` the Messages
   reader counts the text as answered too, so the Unanswered filter and the evening digest agree.
   A text-note bell (the SMS reader's "Comms — check <name>'s text note", `doneWhen: 'text_note_checked'`)
   closes by itself under `GATE_ALERT_CONTACT_CLOSE` alone (owner 2026-11-02), once both hold after the
   bell: a person answered that customer (a text that reached them, a call a person made or took, or a
   person's email) and a visit of that customer was completed, on any day. Either alone leaves it open.
   The estimator's call bells (category `lead`, `estimator_engine`, a `callSid`: "Quote promised on call",
   "AI estimate draft needs review", the commercial scaffold) close by themselves, with no gate (owner
   2026-11-09), once a quote was handed off to the call's customer or lead (`handedOffWithin`, never
   `sent_at`) or a live top-level visit was booked for them, after the CALL STARTED (`callStartedAtSql` over
   the call's `call_log` row, not the bell's `created_at`: a quote can go out between the call and the bell).
   The lead is the bell's own and the one the call is stamped with or that carries the call's sid
   (`call_log.metadata` `lead_id` or `relay_lead_id`; `leads.twilio_call_sid`; an estimator bell links to the estimate and carries no `leadId`). No call row, or a call
   with no customer and no lead, leaves the bell open. A text-origin bell (a
   `smsThreadKey`, no `callSid`) is not in the class. Re-armed like every class if the evidence goes.
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
   Far double bookings (owner audit 2026-10-22, decision D1):
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
   Quiet policy (owner ruling 2026-11-04, "IF THE ALERT IS OVER 3 DAYS OLD,, IT SHOULD FALL OFF";
   `GATE_ALERT_QUIET_FALL_OFF`): a second policy of the same module, `runAdminAlertQuietPolicy` in
   `server/services/admin-alert-retention.js`. It shares the nightly policy's candidates, activity stamps, `RERING`
   registry, version-fenced writer and cursor helpers, and differs in cadence (its own cron, every 10 minutes, its own
   lock and its own cursor key) and rules. An open bell row with no new activity for 72 hours is marked done
   (`done_by` `quiet-72h`, resolution "No new activity for 3 days"), never deleted, read state untouched, at most 200
   rows a tick. Last activity is the latest of `created_at`, `metadata.rungAt`, `observedAt`, `lastFailureAt` and
   `quietHoldFrom`; a quiet refresh is not news. These stay (owner ruling 2026-11-05, "A": money alerts stay until
   settled): the `billing`, `payment`, `dispute`, `refund`, `tax`, `payout`, `payroll` and `llm_cost` categories
   (`KEEP_UNTIL_SETTLED_CATEGORIES`, one line each; `payment_failed` and `bill_payment_error` both write `payment`).
   A person marks them done; a dispute alert stays until then, which covers "until the dispute closes". Also kept:
   Activity-only rows, Claude-queue rows, and the rows of an emitter that raises a fresh row by itself while its
   condition holds (the row's first `RERING` match is `periodic`: held, never closed). Recently done offers Reopen for a
   `quiet-72h` row; the Reopen stamps `metadata.quietHoldFrom`, so the row gets 72 more hours (a relevance re-arm
   stamps it too, and a quiet refresh keeps the row's own stamp). A new emission with changed content rings a
   fallen-off alert back, as after a person's Done, and a ringing refresh drops the stamp. The auto-dispatch schedule
   notices (a visit with no arrival time, a visit that needs a person) change their words once, 7 days before the
   visit (`server/services/auto-dispatch/audit.js` `visitSubject`; owner 2026-11-08, dispatch audit), so a fallen-off
   one rings once more while its problem stands. `shadow` counts and logs,
   writes nothing. A run is recorded (audit_log `admin_alert_quiet_fall_off.close`, `metadata.retention` on each row)
   only when it closed a row. `server/scripts/quiet-fall-off-dry-run.js` prints what would close;
   `server/scripts/reopen-quiet-fall-off.js (--since <ISO> | --run <id>) [--apply]` reopens what the policy closed.
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

**Claude's own queue** (owner 2026-10-26, `GATE_ALERT_CLAUDE_QUEUE`). Three kinds of row never
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
- a list Claude works through by itself, a class in the same table that names its own severity:
  the 8:05 AM list of AI-test cases with no grade yet (`typed-decisions-review:`,
  `server/services/typed-decisions/daily-review-item.js`), an `fyi` the Claude labeler grades
  each night (owner 2026-11-02: plain words, not the owner's to-do).
- work a job on the owner's Mac already does (owner 2026-11-02, "A"): the daily list of website
  posts that wait for a terminal draft (`Content — write N website posts in the terminal`,
  `metadata.terminalDue` `claude`, class `content-terminal-due`). The 9:15 AM blog-run job on the
  Mac writes those drafts, so the row is `fyi`. Its emitter stamps it only while
  `AUTONOMOUS_CONTENT_TERMINAL_DUE_QUIET` is not `false`; the owner's bell gets its own row,
  `Content — blog-run left N website posts for 2 days` (`content-terminal-stalled:<ET date>`, never
  routed), when rows wait 44 hours on the same brief with no draft.
The routing is server-side, in `NotificationService.create` and `notifyAdmin`: no emitter and no
Mac code decides it. A routed row is written Activity-only (`metadata.feed = 'activity'`) and
stamped `who = 'claude'`, so `needs-me --who claude` lists it. It is written even when the
bell policy would silence a ring, because it is no longer a ring, and a refresh never puts it
back in the bell. Never routed: a customer-contact category (`inbound_sms`, `inbound_email`,
`missed_call`, `voicemail_callback`, `new_lead`), a trigger-registry row, a row tied to a
customer, and an `ops_digest` row (owner 2026-09-11: ACT / FIX exceptions from the Mac ops
checks stay in the bell). The Agents Activity feed shows every routed row (`metadata.claudeQueue`: open ones however old, plus ones created or closed in the window) under the agent "Claude's queue", fyi rows included (`needs-me` leaves fyi out because it is never work); the feed's Done is the same fenced done write. Rows already open in the bell move once with
`server/scripts/reroute-claude-queue-rows.js` (dry run by default).

**Dropped faults go to Claude's queue** (owner 2026-11-02, "build all"; `GATE_ALERT_CLAUDE_FAULTS`). The bell
policy writes no row for an alert it silences, so a fault the code marks "Claude fixes this" used to vanish (the
property-lookup canary failed for weeks with no row anywhere). With the gate on, the two drop points
(`NotificationService.create` and `triggerNotification`) write such an alert to Claude's queue instead: Activity-only,
`who = 'claude'`, `severity` `broken`, `claudeQueue` = the trigger key or class, and no phone push. Only an alert the
policy would drop is rescued, so nothing that rings today stops ringing and nothing new rings. Rescued: the
trigger-registry alerts named in `CLAUDE_FAULT_TRIGGERS` (`property_lookup_canary_failed`, `seo_sync_failed`,
`event_sources_unhealthy`) and a `token_alert` row (an expired or failing platform credential). Left out on purpose,
with the reason in `CLAUDE_FAULT_TRIGGERS_LEFT_OUT`: `internal_admin_alert` (its text can be anything) and the three
service-report failures (each is about one customer's report). A customer-tied alert (`customerId`, `customer_id`,
`threadId`, `scopeCustomerId`, top level or in the payload) is never rescued. `server/tests/admin-alert-routing.test.js`
fails when a registry rule says `who: 'claude'` and neither list names it. On the owner's Mac, the notif-dispatch
launcher opens one Claude tab per `broken` queue row.

**Send to Claude from the bell** (owner 2026-11-02: "for the stuff that needs to be fixed ... we need to be able to send
that back to terminal, open a terminal session, to have Claude fix that"; scope narrowed to "A" below;
`GATE_ALERT_SEND_TO_CLAUDE`; owner 2026-11-03: "this should have been for sending to terminal, and opening a session to
fix issues we run into, errors, etc, it should be for any issue", so the button no longer needs `GATE_ALERT_EXPLAINER`).
Every bell row the list below permits carries a **Send to Claude** button, under its text or its "What to do" panel, with an
optional note (500 characters) and a 10-second Undo. The button shows only on an alert whose words our own code wrote (owner 2026-11-02, "A": a Claude terminal tab can change code, and
a customer's words had reached alerts with no contact mark, such as a service request typed in the portal). Offered on:
a system alert (`system`, `inventory`, `llm_cost`, `agents`, `token_alert`) or a Mac ops check digest (`ops_digest` with
`source` `ops-crons`; the portal's own owner digests can quote customers, such as the unworked-comms digest) that names
no customer record;
an alert the code marks Claude's (`who = 'claude'`, severity `broken`, or a registry rule that says who `claude`); and the
reviewed checks on a customer's records in `CHECK_CLASSES` (`admin-alert-send-to-claude.js`, by dedupe-key class: a visit
auto-dispatch cannot place, a recurring visit with no slot or window or map location, an accepted plan whose visits do not
match, prepaid coverage, an unpriced series, a combined booking, a rain move, a lawn visit with no watering instruction, a
series price guard, an unbilled visit, first-application invoices that disagree). Each class's emitter was read first; a
new class joins only after the same read. Never offered, whatever else the row says: the customer-contact categories,
`review`, `internal_admin_alert`, and a row whose metadata or registry rule declares `contact: true` or `promise: true`.
Everything else stays with the owner. The list route marks each such row `sendToClaude: true` for the admin role
(`withSendToClaudeFields`). One tap and an optional note (`POST /api/admin/notifications/:id/send-to-claude`, owner login only (ib-access `ibFullAccess`; Codex security review on #7548),
fenced on the version the bell served like Done) moves the row into Claude's queue: Activity-only, `who = 'claude'`, `claudeQueue` =
`sent-to-claude`, severity `broken` if it was broken and `needs-you` otherwise, and a `sentToClaude` stamp that holds
trusted facts only (Codex security reviews): when, who sent it, the alert's `kind` (its trigger key or dedupe-key class),
the `customerId` and the ids of the records it names, the row's own who and severity, and the admin's own `note` when one
was typed (cleaned of control and invisible characters; an admin login typed it, and the owner is the only admin). No alert
text, no customer name and no summary go into the handoff: a customer sets their own name, and receipts, model output and record fields can carry
any words. The Claude tab reads the alert, its summary and its customer itself, read-only, as data, and names the customer
in its first line. `needs-me` shows a sent row by its kind only ("Sent to Claude from the bell (kind)"), and gives each
alert's customer by id only, never by name. While the
row is open, a refresh of the same alert updates its text but keeps it in Claude's queue (`keepSentToClaude` in
`admin-alert-routing.js`); a refresh that rings after it was closed brings it back to the bell without the stamp. The
write takes the alert's dedupe lock, so a refresh in flight can never undo the send. The Undo (`markAdminUnsentFromClaude`)
takes the same lock and re-checks its fence inside the transaction: open, sent at the stamped time, no `startedAt`. On the owner's Mac, the
notif-dispatch launcher opens one Claude tab per sent row (its own kind, not counted in the daily tab cap). Its prompt
gets the stamp's ids only; it never texts, emails or calls a customer,
never moves money, and closes the row with what fixed it when the fix is live. `needs-me` marks a sent row `sent: true`,
so the queue tab leaves it to its own tab.

**Send an idea to Claude from the Intelligence Bar box** (owner 2026-11-03: "it should be for any issue, even ones that dont
have an issue mid day, but ideas"; `GATE_IB_SEND_TO_CLAUDE`). The owner types or dictates an idea in the Cmd+K / mobile
box and taps the free **Send to Claude** button beside Ask (no model call; Ask stays the paid path). `POST /api/admin/claude-ideas`
(`server/services/admin-claude-ideas.js`) writes one row through `notifyAdmin`, not `raiseAdminAlert`: it is not an alert,
it carries the owner's own words. Shape: category `system`, title `Idea for Claude`, body `An idea from the owner.`, no
`detail`, link `/admin`, Activity-only (`feed` `activity`, `who` `claude`, `severity` `needs-you`, `claudeQueue`
`sent-to-claude`), **`ownerOnly: true`**, and a `sentToClaude` stamp with `kind` `owner-idea`, `idea` (the full cleaned idea,
4,000 characters at most; the words live here and nowhere else), `at`, `by`, `records` (UUID-shaped ids),
`page.route` (a plain `/admin/...` path or null), `viewedDate`, `pasted` and `was`. The dedupe key is `owner-idea:<16 hex of
sha1 of the lowercased, whitespace-collapsed idea>`, so the same idea while its row is open answers `duplicate` and writes
nothing. The 10-second Undo (`POST /api/admin/claude-ideas/:id/cancel`, `markAdminIdeaCancelled`) closes the row as done by the
admin ("Cancelled by the owner.") under the same dedupe lock unless `sentToClaude.startedAt` is set. An `ownerOnly` row (metadata) is for the owner login alone
(`ibFullAccess`; Codex security review round 4): the Recently done list (`getAdminDoneNotifications`, `fullAccess`) and the
Activity feed (`getActivity`, `fullAccess`, focus included) leave it out for any other login, and `PUT /:id/done` and
`PUT /:id/reopen` answer such a login 404 `not_found`, as for an unknown row. The Mac's `markAdminDone` is not affected. The Mac launcher opens a
Claude tab that scopes the idea and asks the owner.

**Send a copy to Claude (step 3)** (owner 2026-11-03, decision 1 = A: "customer alerts = a COPY, read-only until approval";
`GATE_ALERT_SEND_TO_CLAUDE_COPY`). "Send to Claude" refuses a bell row that is customer contact or whose words our own code did
not write (`customer_contact`, `not_system_written`). For those rows only, the owner login gets **Send a copy to Claude
(read-only)** (`sendCopyToClaude: true` on the bell row; `POST /api/admin/notifications/:id/send-copy-to-claude`,
`server/services/admin-alert-copy-to-claude.js`). The tap writes ONE new row through `notifyAdmin` with title `Copy for Claude`
and a fixed body, Activity-only, `ownerOnly: true`, `claudeQueue` `sent-to-claude`, dedupe key `claude-copy:<parent id>`, and a
`sentToClaude` stamp: `kind` `guarded-copy`, `guarded: true`, `parentId`, `parentKind`, `parentCategory`, `records` (UUID-shaped
ids) and the owner's optional note. No customer word is in the row; the locked Mac tab (launcher v2b, outside this repo)
reads the parent alert itself, as data. The parent STAYS in the bell, because a reply may be owed. A step 1 row still uses step 1;
an alert that step 1 can send gets no copy button. The 10-second Undo (`POST /:id/cancel-copy`, on the copy's id)
closes the copy under the same dedupe lock unless a Mac tab started. The tab writes a plan that comes back as an owner-only
bell (the bell list, `getAdminNotifications` with `fullAccess`, hides `ownerOnly` rows from every other login, and the alert
button route refuses them). The owner acts with his own words: step 1 for a system alert, step 2 (Intelligence Bar) for the rest.
Nothing here sends anything to a customer or makes a model call.

### Bell order and Area chip (owner 2026-11-05, `GATE_ALERT_BELL_ORDER`, dark)

The bell lists the alerts that need the owner first. Rank 0 is `metadata.severity` `needs-you`; rank 1 is a row with no
severity label (an older alert stays above known FYI rows); rank 2 is any other severity. Inside a rank the order is newest
first. Each row whose `metadata.area` is one of the nine Areas also shows one Area chip (`areaChip`). The list response says
`order: 'needs-you-first'` and the bell keeps that order (no day groups). The paging cursor is `<rank>~<timestamp>~<id>`. A cursor of
the other order (the gate flipped under an open panel) restarts at page 1 with `restart: true`, and the bell replaces its list. The unread count and the Recently done list do not change. See `docs/gates-and-env.md`.

## 6. What is enforced today

| Rule | Where | State |
|---|---|---|
| Headline 60, why 110 and one sentence, Area from the list, severity / subject / done-when / who present, a link that opens an admin page other than the Activity feed | `composeAdminAlert` throws on a violation | enforced for every caller of the helper |
| Forbidden tokens in headline and why | `composeAdminAlert` throws | enforced for every caller of the helper |
| New code must use the helper | `server/tests/admin-alert-raw-callsite-ratchet.test.js` counts raw `notifyAdmin(` call sites per file against a checked-in ceiling; a file may not gain one | ratchet |
| No emoji in admin text | `notification-service.js` | enforced, all categories |
| Done state: a done row is hidden from the bell list, its unread count and mark-all-read (the Activity feed keeps it, marked Done). Every id-addressed done write is `NotificationService.markAdminDone`; emitters that close inside their own fenced update spread `doneColumns` into it. Auto-done sources: the quiet fall-off (`quiet-72h`, a row with no activity for 72 hours; the only system close that Recently done offers Reopen for), episode closes (`closeAdminAlertKeys`, `done_by` `episodes`), the relevance sweep (`relevance`; also the customer-contact bells once a person answered, behind `GATE_ALERT_CONTACT_CLOSE`: a text-note bell once a person answered the customer and a visit of theirs was completed after it, a text no longer needing a reply, a voicemail callback request after a person called back or texted or a visit or quote followed, and, closed by `missed-call-bell.js` instead (`done_by` `supersede`), a missed call after a person texted the caller or a visit or quote followed, an email a person replied to, a lead a person contacted), an ops-digest fall-off resolve, a newer digest of the same check (`supersedePrior` on `deliverOpsDigest`, used by the unworked-comms and parked-run digests: each send closes the older open copy with `resolution` "Replaced by a newer digest from the same check" and `done_by` the sender's key, so one stays open; the SMS draft canary closes its old keyless FAILING rows the same way), a superseded missed-call bell (a voicemail on the same call, or the caller got through on a later call within 7 days: `retireCalledBackMissedCalls`, 2-minute call-alert cron), a retired missing-deduction bell, a superseded promise-chaser bell, a resolved no-show dispatch tracking bell, a booking-miss bell once its visit is booked, done on another day, or 14 days after its agreed day (`call-booking-miss-watchdog.js`; a visit booked on another day turns the bell into a date check), a logged-delivery bell once no live restock request may cover it (`purchase-receipts/sweep.js`; a delivery with no such request writes none), and every other system retire (a newer bell replaced it, a batch absorbed it, the work was done: the call-commitments watchdog, the follow-up pager, procurement, collections cards, the setup-fee and first-application alerts, the cancellation review bell). A system writer never retires an alert with `read_at` alone; `server/tests/notification-system-retire-closes-done-contract.test.js` fails any non-null `read_at` write that does not also close done, unless it is a named person's read or another table. Not done: any mark-read by a person (a thread open, mark-all-read, a dashboard dismiss). | `PUT /api/admin/notifications/:id/done` (same role scope as mark-read) and `/:id/reopen` (admin only; body `{ doneAt }` is the `done_at_token` the Recently-done list served, a row done again since answers 409 `changed`, and only a row a person closed (`done_by` a technician id or `claude`) can be reopened, a system close answers 409 `not_reopenable`); the bell's Done control | enforced |
| Claude's own reminders, our engineering faults and the AI-test list leave the bell: an admin row with `metadata.opsJob` (unless `opsWho` is `person`) or in a named class is written Activity-only and stamped `who = claude`, `severity` `broken` for a fault and `fyi` for the AI-test list; customer-contact categories, registry events, customer-tied rows and `ops_digest` rows are never routed | `server/services/admin-alert-routing.js`, applied in `NotificationService.create` and `notifyAdmin`; `server/scripts/reroute-claude-queue-rows.js` moves rows already open | enforced while `GATE_ALERT_CLAUDE_QUEUE` is on (dark by default) |
| A fault the code marks "Claude fixes this" that the bell policy would drop is written to Claude's queue instead (Activity-only, `who = claude`, `broken`, no push): the registry alerts in `CLAUDE_FAULT_TRIGGERS` and `token_alert` rows; customer-tied alerts and the `CLAUDE_FAULT_TRIGGERS_LEFT_OUT` triggers stay dropped | `rescueClaudeFault` in `server/services/admin-alert-routing.js`, called at the drop in `NotificationService.create` and `triggerNotification` | enforced while `GATE_ALERT_CLAUDE_FAULTS` is on (dark by default) |
| Retention: a bell row idle 30 days, and an `fyi` row idle 7 days, is marked done (never deleted, read state kept). The 14-day Monday summary for an unread `needs-you` row is the Monday review bell (`server/services/monday-review-bell.js`, Mondays 9:20 AM ET, gate `GATE_MONDAY_REVIEW_BELL`; with `GATE_MONDAY_FELL_OFF_LINE` on, its first list names the customer alerts that fell off the bell after 3 quiet days with no reply instead) | `runAdminAlertRetention` in `server/services/admin-alert-retention.js`, nightly 1:32 AM ET, gate `GATE_ALERT_RETENTION` (`shadow` records one audit_log summary, `true` expires); undo with `server/scripts/undo-admin-alert-retention.js` | enforced when the gate is `true` |
| Catalog (owner 2026-10-29, step D1): every `TRIGGER_REGISTRY` type declares a `rule`: area, severity, who, and either `doneWhen` + `closedBy` (the module that marks its rows done) or `expiryDays` (30 for needs-you and broken, 7 for fyi; only the retention sweep closes it). Severity `fyi` replaces the old `informational` flag. In watch mode a muted alert is countable: when the bell policy silences an admin row, one `audit_log` row per Eastern day per distinct alert records its category, trigger key and digit-free title stem, and for a composer alert its declared area, severity and who, with its kind (the dedupe key's class prefix). Nothing is refused | `server/tests/admin-alert-catalog-contract.test.js` fails a type with no valid rule; `auditBellPolicyMuted` in `server/services/audit-log.js`, called at both silence points (`NotificationService.create`, and `triggerNotification`, which checks the policy itself and returns before create), action `notification.bell_policy.muted` | contract enforced; watch mode behind `GATE_ALERT_CATALOG=watch` (dark by default) |
| Customer declaration (owner 2026-10-29, "small" E1): a registry `rule` or a composed spec may declare `contact: true` (a customer reached us) or `promise: true` (a follow-up we owe a customer): only `true`, never both, and only on a `needs-you` type for a person. A declared alert rings whatever the bell policy's later steps say (a site's explicit `bell: false` still wins), and a customer's failed invoice payment (`bill_payment_error`) rings beside `payment_failed` | `bellAllowed` in `server/services/notification-bell-policy.js` (step 1b), fed by `triggerNotification` (the type's rule; its bell write then carries `bell: true`) and `NotificationService.create` (the row's metadata); the shape is checked by `server/tests/admin-alert-catalog-contract.test.js` and `composeAdminAlert` | enforced while `GATE_CUSTOMER_ALERTS_RING` is on (dark by default) |
| Body over 110 chars moves to `detail`, read from the bell's "Show full text" (with `GATE_ALERT_EXPLAINER` on: "What to do", the original under "Show original text") | `notification-service.js`, kill switch `ADMIN_BODY_GUARD_ALL` | enforced, all categories |
| The bell names the customer a row is about, and "What to do" explains it in plain words (section 2) | `server/services/admin-alert-customer.js`, `server/services/admin-alert-explainer.js`, `POST /api/admin/notifications/:id/explain`, admin role only | enforced while `GATE_ALERT_EXPLAINER` is on (dark by default); the customer line alone follows `GATE_ALERT_CUSTOMER_LINE` (dark by default) |
| Send to Claude (section 5): a bell alert our own code wrote (system with no customer, marked Claude's, or a reviewed check class) can be moved to Claude's queue from the bell with an optional note, and un-sent for 10 seconds (`POST /api/admin/notifications/:id/unsend-from-claude`, while no Mac tab has started on it); fenced on the served version and the alert's dedupe lock; a refresh keeps an open sent row in Claude's queue; `needs-me` gives each alert's customer id and marks sent rows | `server/services/admin-alert-send-to-claude.js` behind `POST /api/admin/notifications/:id/send-to-claude` (admin only), `keepSentToClaude` in `server/services/admin-alert-routing.js`, `withCustomers` in `server/services/needs-me.js` | enforced while `GATE_ALERT_SEND_TO_CLAUDE` is on (dark by default; no explainer gate); the `needs-me` CLI always adds customer ids |
| Buttons (section 2, part 9): only a button the row carries runs; its handler reads the record again; a tap is admin only, claims the row against the version the bell served (one tap at a time), is recorded on the row, and closes it | `server/services/admin-alert-buttons.js` (`withAlertButtons`, `runAlertButton`) behind `POST /api/admin/notifications/:id/actions/:actionId`; the shape is checked by `composeAdminAlert` | enforced per kind while its gate is on (`referral_inbound`: `GATE_REFERRAL_INBOUND_BELL`, dark by default; `call_back`: `GATE_ALERT_CALL_BUTTON`, dark by default, the one kind that leaves its row open) |

Alert sounds (owner 2026-11-03): a Waves Admin iPhone push plays a sound per alert type. The map from
trigger key to sound file lives in `server/services/alert-sounds.js`; `triggerNotification` and the
missed-call re-push add the name to the push only when the admin's Sound switch is on. The files ship in the
app bundle (`ios/WavesPay/Resources/Sounds`). iOS plays its default sound when the named file is missing, so an
older app version still rings. A Sound switch set to off now holds on iOS too: `apns.js` sends no `aps.sound`
for a `silent` push. A new alert type gets a sound by adding a line to the map and a file to the app.

Bell-only kinds that also push (owner 2026-11-03, "ok add", choices A and B; gate `GATE_BELL_BANNERS`, dark): three
kinds of alert reached only the portal bell and now also send a phone banner when a write rings. A: `sms_operational_followup`
(a text follow-up due) and `call_commitment_overdue` (a promise to a caller overdue) push only from 7:00 AM up to 9:00 PM
Eastern, judged when the banner is sent; outside those hours the bell row stays and no banner goes (the 8 AM summary banner
covers them). B: the Facebook message bell (`messenger_reply`, one standing bell per thread) pushes at any hour, like a
text. `NotificationService.notifyAdmin` calls `bannerAfterWrite` in `server/services/bell-banners.js` once per write; a banner
goes only for a fresh unread row or a refresh that rang again, never for a repeat, a withheld bell, an Activity-only row (the
call-commitment backlog summary) or a row routed to Claude's queue, and only after the row commits (a rollback sends
nothing; a write inside a nested transaction waits for the outermost commit). It goes out through `triggerNotification` with
`pushOnly`, to admin-role phones, with the row's own title, body and link and a tag per row. A new kind of this sort is one
line in `BELL_BANNER_KINDS`, one registry entry whose `build` takes `alertTitle` / `alertBody` / `alertLink`, and a sound line.

New-lead email banner (owner 2026-11-04, "ring new"; gate `GATE_RING_NEW_CONTACTS`, dark; own gate, not
`GATE_BELL_BANNERS`): a lead created from an email, and a follow-up email that completed a quote request, put ONE phone
banner on the owner's phone at any hour (kind `new_lead_email`, the New lead sound). The writer (`email-actions.js`) keys the
existing `new_lead` bell row on the email id (`email-lead:<lead|draft>:<email id>`) and names the kind with
`notifyAdmin`'s `bannerKind` option, which is never stored on the row; a retry or re-sync finds the row and sends no
second banner, and no second bell row is written. Gate off: the unkeyed row and no banner, as before.

Lead call-back reminder banner (owner 2026-11-05, "remind"; gate `GATE_LEAD_CALL_REMINDER`, dark): two kinds of lead
bell reach only the portal bell. A "Missed call request" bell (`lead-call-reply-missed:<callLogId>`, a press-1 ring nobody
answered) and a night call-back bell (`lead-call-text-followup:<requestId>`, raised by `lead-call-text-followup.js`
`raiseLeadBell`) send no banner. With the gate on, the alert-relevance sweep (every 10 minutes, after its closes) runs
`server/services/lead-call-reminder.js`. A bell of those kinds that is still open one business hour after its latest
event (the follow-up SLA's clock, 8 AM to 8 PM ET) sends ONE banner (`lead_call_reminder`, the Missed call sound) when
nobody has reached the lead since. "Reached" uses the shared contact witnesses after that event: a person's text, a call
a person placed and spoke on, an inbound call a person answered, a person's Gmail send to the lead's customer's own
address, a visit booked for that customer, or an estimate handed off. A deleted lead, or one a person closed, sends nothing. Banners go out
only from 8:00 AM up to 8:00 PM Eastern, and only for bells of the last 24 hours. The banner carries the row's own title,
body and link, led by "Reminder: nobody has reached this lead yet.", `pushOnly` to admin-role phones with a tag per row.
The bell row is not rewritten: it is stamped `metadata.leadCallReminderAt` in one statement fenced on the row being open
and unchanged since it was read, so a row sends at most one banner. The stamp is not a ring, so the 3-day quiet fall-off
still counts from the bell's own event. The owner turns it off in Push Settings (Leads & Sales group, "Reminder: a lead
still waits for a call") or by unsetting the gate. It sends nothing to a lead.

Existing raw `notifyAdmin` call sites keep working. They are converted by Area in later
changes, and the ratchet's numbers only fall.

The 8 AM banner (owner 2026-11-03, "ok add", choice C; `GATE_MORNING_BANNER`, dark): once a day at 8:00 AM
ET, `server/services/morning-banner.js` sends ONE phone banner, "N items wait for you" ("1 item waits for you"),
where N counts the waiting items nobody has read yet (owner 2026-11-04, "fix count"), with the three busiest areas of
those in the text and the whole open count after them when some were already read ("Comms 6 · Schedule 3 · Billing 2 ·
334 open in all"). A tap opens the dashboard with the
alert list open (`/admin/dashboard?bell=open`, read by `NotificationBell`). It counts the open bell alerts that need
a person: an alert row not done, severity `needs-you` or `broken`, `who` = person, judged by `needs-me.js`
`mapAlertRow`. It leaves out Activity-only rows, rows sent to Claude, unsorted rows and the dashboard's standing
counts (an alert row already echoes most of them). With nothing unread it sends nothing. It is the `waiting_summary`
trigger, sent `pushOnly`: no bell row, admin-role phones only, and one banner per ET day (the send first takes a
`sms_send_claims` row `morning_banner:<ET date>`, so a deploy overlap or a restart cannot send a second one; a
day missed while the server was down is not made up). The owner turns it off in Push Settings (Alerts group,
"Morning summary: items waiting for you") or by unsetting the gate. It sends nothing to a customer.

The owner's open-visit banner (owner 2026-11-04, "banner"; `GATE_OWNER_NUDGE_BANNER`, dark): the 7 PM open-visit nudge
(`server/services/tech-open-visit-nudge.js`) reaches the owner as a Waves Admin banner instead of a text. It is the
`open_visits_nudge` trigger, sent `pushOnly` to his own admin user only (`onlyUserIds`): no bell row, one banner per ET day
(the nudge's own per-technician claim), same words as the text, a tap opens `/tech`. It counts as delivered only when a phone
accepted it; otherwise the text goes out as before. The owner can turn the type off in Push Settings (Alerts group,
"Evening nudge: visits still open"), which sends the text instead. It sends nothing to a customer.

Stuck-booking alert (owner 2026-11-05, "1, 2 and 3": the estimate page audit's fix 3 and fix 1's second step; no gate):
`server/services/estimate-stuck-alert.js` raises one standing bell per estimate (category `estimate_stuck`, dedupeKey
`estimate_stuck:<estimate id>`) when a customer gets stuck on the estimate page: the 90-day look-ahead found no times,
five date or Waves AI searches in a row came back empty, a time they picked expired with no booking, the time list
answered an error, or Approve was refused for a reason the page does not walk them through. The same row says when a
customer came back to an expired estimate. It rings at most once per Eastern day (the day is the `dedupeVersion`, and
`ringOnRefresh` rings only a new day); a second reason the same day rewrites the row without a ring. A ring also sends a
phone banner with the New lead sound (`bell-banners.js` kind `estimate_stuck`, 7:00 AM to 9:00 PM Eastern). The category
rings by default and the owner can silence it under Push Settings ("Customers stuck booking an estimate"); while it is
silenced nothing raises or refreshes (notifyAdmin reads the mute only on a fresh insert) and the 5-minute pass closes the
open rows. Bots, staff
browsers and the office network never raise it. The 5-minute estimate tick closes a row once its estimate is accepted,
declined or archived. Each date search, hold start and hold end is an `audit_log` row (`estimate_slot_search`,
`estimate_hold_started`, `estimate_hold_ended`) for the next booking audit. It sends nothing to a customer.

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
  (`--json` for the full object). It always gives each alert's customer id ("Customer id:" under the row, `customer`
  in JSON), read from the record behind the alert; the route and the bar tool do so while `GATE_ALERT_SEND_TO_CLAUDE`
  is on. The id only (Codex security review): a customer sets their own name, so a session that reports on an alert
  reads the name from the record, as data, and names the customer in its report. A row the owner sent from the bell ("Send to Claude") carries `sent: true`: the Mac launcher gives it its
  own tab.
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
