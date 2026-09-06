/**
 * Feature Gates — Human-in-the-loop safety layer
 *
 * Every integration that touches real customers or third-party services
 * is gated behind a flag. In production, these default to OFF until
 * Adam manually enables them after verifying each one works.
 *
 * Set these as environment variables on Railway:
 *   GATE_TWILIO_SMS=true        (enable real SMS sending)
 *   GATE_TECH_ARRIVED_SMS=true  (enable customer "tech has arrived" SMS)
 *   GATE_TWILIO_VOICE=true      (enable voice call handling)
 *   GATE_VOICE_AI_AGENT=true    (enable bilingual AI voice backstop on unanswered calls)
 *   GATE_AI_ASSISTANT=true      (enable AI auto-replies to customers)
 *   GATE_LEGACY_AI_DRAFTS=true  (enable inbound SMS AI draft approval queue)
 *   GATE_SMS_SHADOW_DRAFTS=true (silent house-voice shadow drafts of inbound SMS)
 *   GATE_VOICE_CORPUS_MINER=true (nightly brand-voice corpus mining)
 *   GATE_CALL_RESEARCH_MINER=true (nightly voice-of-customer call-research mining)
 *   GATE_SHADOW_JUDGE=true      (nightly shadow-draft vs human-reply scoring)
 *   GATE_SMS_AUTO_SEND=true     (autonomously send verified house-voice drafts for graduated intents)
 *   GATE_AI_BLOG_WRITER=true    (enable AI blog content generation)
 *   GATE_BLOG_BODY_IMAGES=true  (autonomous posts get ≥2 generated in-article images)
 *   GATE_CRON_JOBS=true         (enable all automated cron jobs)
 *   GATE_WEBHOOKS=true          (enable inbound webhook processing)
 *   GATE_EMAIL_TEMPLATE_AUTOMATIONS=true (enable template automation sends)
 *   GATE_LEAD_ESTIMATE_AUTOMATION=true    (generate priced lead draft estimates)
 *   GATE_LEAD_ESTIMATE_AUTO_SEND=true    (auto-send generated lead estimates)
 *   GATE_LEAD_TURNSTILE=true    (enforce Cloudflare Turnstile on the public lead webhook)
 *   GATE_LAWN_ASSESSMENT=true   (public lawn-assessment photo funnel — paid vision per upload)
 *   GATE_AGENT_ACTIVITY=true    (Activity tab in /admin/agents — read-only feed over existing ledgers; dark in dev AND prod)
 *   GATE_OPS_DIGESTS_IN_APP=true (owner ops digests become ops_digest bell rows in the Activity feed instead of contact@ emails; dark in dev AND prod)
 *   GATE_CLOSEOUT_MONEY_COMMS_ALERTS=true (closeout alerts also map the comms / invoice / invoiceDelivery facts — failed completion notice, invoice owed but not minted, invoice or receipt delivery incomplete — as per-visit cards + closeout_gaps_today members; their outage holds the floor; read-only, no comms; dark in dev AND prod)
 *   GATE_PEST_IDENTIFIER=true   (public pest-identifier photo funnel — paid vision per upload)
 *   GATE_AUTOPAY_CUSTOMER_SMS=true       (enable customer-facing autopay SMS)
 *   GATE_PORTAL_METHOD_REMOVAL_GUARD=true (portal DELETE /api/billing/cards/:id refuses the method Auto Pay is using — 409 autopay_method_in_use — and never mutates Auto Pay as a side effect; off = legacy remove-and-silently-disable)
 *   GATE_PORTAL_CARD_REMOVAL_HOLD_NOTICE=true (portal GET /api/billing/cards stamps holdsAppointment on a card holding a future secured visit, so Remove opens the call-us disclaimer; removal itself is never blocked — off = field absent, payload unchanged)
 *   GATE_PAYMENT_METHOD_CHANGE_EMAILS=true (customer lifecycle emails for Auto Pay turned OFF and saved method REMOVED — portal, and Stripe-dashboard detaches via webhook)
 *   GATE_ESTIMATE_DEPOSIT_ABANDONMENT_SMS=true (deposit-step abandonment recovery SMS)
 *   GATE_INCIDENT_EVAL=true     (weekly live-LLM incident regression eval)
 *   GATE_CALL_REPLAY_EVAL=true  (weekly reviewed-call extraction replay eval)
 *   GATE_ADS_BUDGET_LIVE_PUSH=true (capacity cron pushes budget changes to Google Ads)
 *   GATE_BOOKING_FUNNEL_CANARY=true (alert when /book funnel entries see zero conversions)
 *   GATE_LLM_DISPATCH_METRICS=true (log dispatcher outcomes + daily exception digest email)
 *   GATE_LLM_CALL_LEDGER=true   (one llm_dispatch_log row per provider call — tokens, latency, served model, lane / run correlation; dark in dev AND prod)
 *   GATE_LLM_CALL_TRACES=true   (redacted prompt / response bodies in llm_call_traces for lanes whose runtime policy opts in; needs GATE_LLM_CALL_LEDGER; dark in dev AND prod)
 *   GATE_AGENT_CONTROL_READ=true (Agents hub Control center reads: /api/admin/agents/control/areas + /control/lanes over the call ledger, features.ledger on the hub probe; off = 404 + probe says no ledger; dark in dev AND prod)
 *   GATE_AGENT_RUNS=true      (agent run ledger WRITES — services/agent-control/runs.js records work_items / agent_runs / steps / events for lanes that call it; off = every handle is inert; the /control/runs reads stay on GATE_AGENT_CONTROL_READ; dark in dev AND prod)
 *   GATE_AUTO_WAVEGUARD_TIER=true (auto-stamp/lapse WaveGuard tier from upcoming recurring coverage)
 *   GATE_APPT_CARD_NO_SHOW_FEE=true (auto-charge the disclosed no-show/late-cancel fee on /secure-secured visits)
 *   GATE_STICKY_CANCEL_WINDOW=true (sticky cancel window — a customer reschedule inside the fee window keeps a later cancel chargeable)
 *   GATE_APPT_CARD_COMPLETION_CHARGE=true (auto-charge one-time visit completions against the /secure-consented card)
 *   GATE_CARD_HOLD_RESCHEDULE_ADOPT=true (completion DETECTS a same-estimate card hold stranded on a cancelled/rescheduled visit and bells the office — no auto-charge)
 *   GATE_CARD_HOLD_PARK_ON_CANCEL=true (cancelling a visit with a one-time card hold PARKS the hold for the rebooked visit instead of releasing it; fees/offboarding/revocation unchanged)
 *   GATE_PEST_STRANDED_RECOVERY=<ISO timestamp> (stranded-activation recovery sweep covers PEST parents created at/after this epoch; set AFTER a rollout completes so old-instance bookings from the Railway overlap can never match; unset/invalid = pest excluded — owner ruling 2026-08-27)
 *   GATE_COMPLETION_AUTOPAY_CHARGE=true (completion auto-charge extends to EVERY autopay customer's collectible self-pay completion invoice — hard-capped at the visit's accepted price or membership dues rate; no anchor or above-anchor → office review bell, never an uncapped charge)
 *   GATE_COMPLETION_COMMS_GUARD=true (flag completions with open customer comms — admin bell + dispatch alert, never blocks)
 *   GATE_LEAD_TO_CASH_SWEEP=true (daily 6:55 ET read-only lead-to-cash invariants sweep — FIX: email to contact@ only on findings; never writes)
 *   GATE_RESCHEDULE_INTENT_FLAGS=true (real-time reschedule/away SMS flag rows + owner bell/push — owner silenced the lane 2026-08-15)
 *   GATE_CONTACT_CORRECTION=true (auto-apply customer-stated name/email/address corrections from inbound SMS and processed calls)
 *   GATE_REPORT_CROSS_SELL=true (live service-report cross-sell offer card with estimator pricing)
 *   GATE_REPORT_CLICK_TO_ESTIMATE=true (priced cross-sell tap mints a real estimate and redirects into it)
 *   GATE_CALL_PROPERTY_ROLE=true (call-classified property roles: fill unknown occupancies + park a one-click property_role_confirm review card)
 *   GATE_RESERVICE_REPORT_COPY=true (re-service/callback customer reports key off service_records.is_callback: lawn-vs-pest hero copy below the honest V2 status branches, "$0 — included with WaveGuard" line on web + PDF for member tiers; unset = legacy name-regex headline)
 *   GATE_SOUTH_ZONE_DAY_FUNNEL=true (estimate picker funnels far-south zones onto days with an existing zone stop, seeding one day when none exists)
 *   GATE_JOB_CARD=true (Service Protocol drawer "Job card" tab: customer paragraph (FAST-tier rewrite of portal fields, template fallback, cached on scheduled_services.job_card), per-product spray check from NWS hourly at the property, tank mix search; read at call time; unset = tab hidden, endpoint answers {enabled:false})
 *   GATE_VAN_SCENE=true (the "look for this van" scene under the appointment header card and on the booking confirmation step; dev-open (every non-production NODE_ENV renders it regardless), prod dark; prod kill = unset)
 *   GATE_SLOT_TRAVEL_GAP=true (every customer-facing picker + commit gate requires modeled drive time + SLOT_TRAVEL_BUFFER_MINUTES (default 15) between consecutive stops; read at call time; unset = pure-overlap legacy)
 *   GATE_ESTIMATE_SERVICE_OPT_OUT=true (customer drops one recurring service line on a sent estimate; canonical engine re-price behind a dryRun preflight, no comms, no bell — STRICT opt-in in dev too)
 *   GATE_ESTIMATE_SERVICE_ADD=true (priced add-a-service on the opt-out rail — pest/lawn/mosquito join a sent estimate behind the same dryRun preflight; STRICT opt-in, needs the opt-out gate)
 *   GATE_ESTIMATE_LEAD_SERVICE_SEND=true (send-time lead-with-one-service: the second of exactly two recurring lines on a new customer's estimate is parked as a staff opt-out event before delivery; STRICT opt-in, needs opt-out + add)
 *   GATE_ESTIMATE_RETURN_VISIT=true (estimate page returning-visitor strip: visit number + named changes since the previous visit; read-only projection, no comms; dev-open, prod dark)
 *   GATE_HERMES_WATCHDOG=true (external agent watchdog: GET /api/integrations/watchdog-worker/status serves the PII-free health snapshot to the hermes_watchdog key and the 23-min liveness cron bells when the watchdog stops polling; off = 404 + cron no-op; kill = unset)
 *   GATE_ADMIN_OPS_QUEUE=true (Agents hub "Queue" tab: one read-only view of every long-running lane's pending / parked / failed rows — jobs, call processing, content parks, email approvals, IB confirmations, report delivery, follow-ups, open alerts; off = tab hidden, /api/admin/agents/queue 404)
 *   GATE_IB_TOOL_ACTIVITY=true (Intelligence Bar answers carry a toolActivity list — one operator-facing line per tool the exchange ran: label, done/error/proposed, duration — rendered above the answer in the ⌘K palette; off = response byte-identical to today)
 *   GATE_CALL_TRANSCRIPT_SYNC=true (admin call log: diarized transcript segments render as a clickable, audio-synced list — click a line to seek the recording; off = today's plain-text transcript)
 *   GATE_TECH_DICTATION_UPLOAD=true (tech completion notes: when the browser has no SpeechRecognition — iOS home-screen PWA, Firefox — the mic records with MediaRecorder and POSTs the clip to /api/tech/services/:id/dictation for server transcription; off = today's behavior, mic hidden without SpeechRecognition)
 *   GATE_ESTIMATE_LAWN_CALENDAR=true ("Your program" block under the lawn price card — annual application count + four plain season rows behind a toggle; count from the scheduling catalog on /data; dev-open, prod dark)
 *   GATE_ESTIMATE_SUCCESS_REFERRAL=true (referral share card on accepted / just-accepted estimate screens + POST /:token/referral-link; enrolls on the tap only; dev-open, prod dark)
 *   GATE_ESTIMATE_HOT_VIEW_ALERT=true (owner-side admin bell when the multi_view_high_intent rule matches on a page open; one per estimate per 24h, silent until the owner enables the category; not a customer message — STRICT opt-in in dev too)
 *   GATE_ESTIMATE_SOFT_EXIT=true (customer soft exit on a sent estimate: reason-tagged decline, still-deciding signal, change request → service_requests row + admin bell; no customer comms; dev-open, prod dark)
 *   GATE_PAY_PAGE_FAQ=true      (public /pay page: short FAQ accordion under the Pay button — card fee, bank timing, Zelle, saved card; copy-only, no money moves; dark in dev AND prod)
 *   GATE_PREPAY_CARD_AND_CHARGE=true (annual-prepay accepts require the card-on-file capture like per-application AND auto-charge the prepay invoice at accept — read directly in server/services/recurring-card-on-file.js, same style as RECURRING_CARD_ON_FILE.
 *     ⚠ PREREQUISITES: this gate is INERT unless RECURRING_CARD_ON_FILE=true
 *     AND GATE_AUTO_APPLY_ACCOUNT_CREDIT=true are BOTH also set — the prod
 *     default for the credit gate is false (see autoApplyAccountCredit
 *     below), so flipping only this gate silently keeps the legacy
 *     invoice-and-pay-link behavior. isPrepayCardAndChargeEnabled() enforces
 *     the conjunction; the flip checklist is all three vars.)
 *
 * In development, most gates are OPEN by default so you can test locally.
 * Customer-facing auto-send gates still require explicit opt-in everywhere.
 */

const isProd = process.env.NODE_ENV === 'production';

const gates = {
  // Payer Phase 2 — NET-terms consolidated statements (accrual core).
  // OFF unless explicitly enabled, in dev AND prod (unlike the dev-open gates
  // below): flipping it on changes invoice behaviour for net15/net30 payers
  // (accrue each visit to one monthly statement instead of instant-invoicing the
  // AP), so it must never turn on silently in tests/dev. due_on_receipt payers
  // — i.e. everyone today — are unaffected at any setting.
  payerStatements: process.env.GATE_PAYER_STATEMENTS === 'true',

  // Portal ACH Auto Pay (2026-07-13): existing customers add a bank account
  // in the portal (Financial Connections first, micro-deposit fallback) and
  // put Auto Pay on it. Opt-in in EVERY environment — it's a customer-facing
  // money surface. OFF also closes a pre-existing leak: the AutopayCard
  // Payment Element minted card_or_bank unconditionally, letting a bank
  // account be saved while the customer saw the CARD consent copy; with the
  // gate off the portal setup-intent route now mints card-only. Kill
  // switch: unset or any non-'true' value. Booking flows stay card-only
  // regardless (owner ruling 2026-07-13); the estimate accept capture has
  // its own gate below (acceptAchCapture, owner ruling 2026-09-01).
  portalAchAutopay: process.env.GATE_PORTAL_ACH_AUTOPAY === 'true',

  // Bank account on the estimate-accept Auto Pay capture (owner ruling
  // 2026-09-01): the recurring per-application and in-lane prepay
  // SetupIntent mints card_or_bank with INSTANT verification only
  // (Financial Connections) — the accept trust boundary stays a live
  // succeeded intent, so a bank that cannot instant-verify falls back to a
  // card in the same session; no micro-deposit pending state at accept.
  // An existing customer whose ach_status is set and not 'active' mints
  // card-only (same precheck as the pay page's capture-setup). The one-time
  // card hold and the /secure appointment-card link stay card-only. Gate
  // off = byte-identical card-only mint and card copy. Customer-facing
  // money surface — fail-closed ==='true' in every environment.
  acceptAchCapture: process.env.GATE_ACCEPT_ACH_CAPTURE === 'true',

  // Portal payment-method removal guard (owner ruling 2026-08-27): the
  // method Auto Pay is using (getAutopaySelectedMethodIds — the charge
  // resolver's pick + the enrollment pointer, expired included) cannot be
  // detached from the portal; the customer replaces it or turns Auto Pay
  // off first. DELETE is side-effect-free under the gate — it never flips
  // customers.autopay_enabled. Gate off = the legacy path (unconditional
  // remove + best-effort, non-transactional Auto Pay disable). Customer-
  // facing money surface — fail-closed ==='true' in every environment.
  portalMethodRemovalGuard: process.env.GATE_PORTAL_METHOD_REMOVAL_GUARD === 'true',

  // Portal card-removal hold notice (owner ruling 2026-09-03): a saved card
  // that secures a FUTURE visit (held estimate_card_holds row, or a fee-
  // agreed appointment_card_requests row) is stamped holdsAppointment on
  // GET /api/billing/cards, and the portal's Remove opens a disclaimer —
  // the visit and its agreed late-cancel fee survive removal, call us or
  // reschedule. Removal is NEVER refused (card-network stored-credential
  // rules: the customer can always withdraw consent). Off = field absent,
  // payload byte-identical. Customer-facing money surface — fail-closed
  // ==='true' in every environment.
  portalCardRemovalHoldNotice: process.env.GATE_PORTAL_CARD_REMOVAL_HOLD_NOTICE === 'true',

  // Negative lifecycle emails (payment.autopay_disabled /
  // payment.method_removed) — the positive counterparts have shipped for
  // months; these fire on the portal Turn-off, portal remove, and the
  // payment_method.detached webhook (Stripe-dashboard removals). Separate
  // from the guard gate so either can run alone. Off = senders no-op.
  paymentMethodChangeEmails: process.env.GATE_PAYMENT_METHOD_CHANGE_EMAILS === 'true',

  // /secure/:token plan-choice step (pay per application vs. annual prepay)
  // on the appointment card-request page. Customer-facing money surface —
  // fail-closed ==='true' in EVERY environment. Gate off: the page payload
  // carries no planContext and /secure renders exactly the card-only
  // experience; the select-plan endpoint 404s (unobservable while dark).
  securePlanChoice: process.env.GATE_SECURE_PLAN_CHOICE === 'true',

  // Standalone "set up Auto Pay" link (owner ruling 2026-09-01): an
  // operator sends an existing customer a tokenized /secure/:token page
  // with no visit attached (kind='customer' rows in
  // appointment_card_requests, 30-day expiry) — card, plus bank account
  // only while GATE_ACCEPT_ACH_CAPTURE is also on (one ACH-capture kill
  // switch for every tokenized capture, judged at mint AND completion),
  // instant bank verification only, same save → consent → enroll tail as
  // every other save surface. Operator-initiated only (Customers page
  // action: copy link, text it via the card_request purpose with the
  // autopay_setup_link template, seeded inactive — and the text ALSO needs
  // GATE_AUTOPAY_CUSTOMER_SMS, since the message type classifies as an
  // Auto Pay customer SMS; the action reports autopay_sms_gate_off
  // otherwise — or email it via the payment.autopay_setup_link email
  // template through the template library). Gate off: the admin
  // action reports gate_off and mints nothing; already-minted links keep
  // working (the gate governs new links). Customer-facing money surface —
  // fail-closed ==='true' in every environment.
  autopaySetupLink: process.env.GATE_AUTOPAY_SETUP_LINK === 'true',

  // Appointment-card fee rail (owner-approved 2026-08-01): auto-charge the
  // no-show/late-cancel fee the /secure lane DISCLOSES against the card it
  // captured, for visits with frozen fee terms on the appointment_card_
  // requests row. Money surface — fail-closed ==='true' in EVERY
  // environment. Gate off: chargeAppointmentNoShowFee returns
  // feature_disabled, cancel previews report feeApplies:false, and every
  // no_show/cancel path behaves byte-identically to today (the fee stays a
  // manual office decision). Frozen terms still stamp while dark so the
  // disclosed amount is enforceable the day the gate lights. Kill switch:
  // unset or any non-'true' value.
  apptCardNoShowFee: process.env.GATE_APPT_CARD_NO_SHOW_FEE === 'true',

  // Sticky cancel window (owner ruling 2026-08-10): a customer reschedule
  // made inside the late-cancel fee window keeps a later cancel chargeable —
  // closes the reschedule-then-cancel fee dodge on BOTH saved-card rails.
  // Money gate: strict opt-in in EVERY environment; while dark, every
  // cancel/preview/reminder path is byte-identical to today (only the
  // updated disclosure copy is live). Enforcement additionally requires the
  // per-row sticky_window_disclosed consent marker, so flipping this never
  // touches legacy consents. Kill switch: unset or any non-'true' value.
  stickyCancelWindow: process.env.GATE_STICKY_CANCEL_WINDOW === 'true',

  // Completion auto-charge for one-time visits whose card came through the
  // /secure lane (owner-approved 2026-08-01): the lane's SMS promises "your
  // card is only charged after service is completed" — this gate makes that
  // charge automatic (dispatch /complete AND the pest-recap closeout path),
  // hard-capped at the accepted_amount FROZEN on the lane row at consent
  // (+ disclosed tax/surcharge; never the live estimated_price, which
  // appointment editors rewrite — Codex #3153 r1) with the same above-quote
  // review routing as the per-application rail. Page-secured rows only get
  // an accepted_amount when the /secure page DISPLAYED the price, which
  // requires GATE_SECURE_PLAN_CHOICE — flip that gate first or completions
  // route to office review instead of charging (Codex #3153 r2). Money
  // surface — fail-closed ==='true' in EVERY environment. Gate off:
  // completion invoices go out as pay links exactly as today. Kill switch:
  // unset or any non-'true' value.
  apptCardCompletionCharge: process.env.GATE_APPT_CARD_COMPLETION_CHARGE === 'true',

  // Reschedule-orphan hold DETECTION (owner lane 2026-08-25): an operator
  // reschedule composed as cancel + fresh create strands the one-time card
  // hold on the dead visit id, so the completion charge misses and a pay
  // link goes out despite a consent-backed hold — silently. With this gate
  // on, a completion whose primary hold lookup misses detects the
  // customer's surviving 'held' hold from the SAME estimate stranded on a
  // cancelled/rescheduled visit (unambiguous 1:1 shape only) and BELLS the
  // office with the operator repair command (ops/agents/
  // repoint-orphaned-card-hold.js). NO money moves and nothing is
  // repointed under this gate — estimate lineage is not a durable
  // reschedule link, so collecting on the hold stays a per-case operator
  // decision through the dry-run-default ops script. Fail-closed ==='true'
  // in EVERY environment. Gate off: completions are byte-identical to
  // today. Kill switch: unset or any non-'true' value.
  cardHoldRescheduleAdopt: process.env.GATE_CARD_HOLD_RESCHEDULE_ADOPT === 'true',

  // Park-on-cancel for one-time card holds (owner ruling 2026-08-26:
  // cancelling a visit with a live hold KEEPS the hold active so it can
  // follow the rebooked visit, instead of releasing it). With this gate
  // on, a cancel that would have released free (outside the fee window,
  // past-start cleanup, or an admin waive that is NOT an offboarding)
  // leaves the hold 'held' on the cancelled visit — the stranded-hold
  // detection lane (cardHoldRescheduleAdopt) bells when the successor
  // completes, and ops/agents/repoint-orphaned-card-hold.js is the mover.
  // In-window late-cancel FEES are unchanged (disclosed policy), consent
  // revocation still releases, and offboarding always releases. Money-
  // adjacent surface — fail-closed ==='true' in EVERY environment. Gate
  // off: cancels release exactly as today. Kill switch: unset or any
  // non-'true' value.
  cardHoldParkOnCancel: process.env.GATE_CARD_HOLD_PARK_ON_CANCEL === 'true',

  // Completion auto-charge for EVERY autopay customer (owner ruling
  // 2026-08-26/27, membership completion-invoice case): completing a visit that carries a
  // collectible SELF-PAY invoice auto-charges the customer's saved Auto
  // Pay method — not just the per-application and appointment-card lanes.
  // The charge is HARD-CAPPED at the same anchor the completion mint
  // prices from (the visit's stamped accepted price, else the membership
  // dues rate for membership-mode customers — completionInvoiceAmount
  // precedence; owner cap ruling 2026-08-27: those ARE the agreed price).
  // An invoice above the anchor, or with no anchor at all, is NEVER
  // charged — it parks with an office bell and keeps the normal pay-link
  // flow. Money-moving surface — fail-closed ==='true' in EVERY
  // environment. Gate off: completions bill exactly as today (invoice +
  // pay link, per-application/appointment-card lanes unchanged). Kill
  // switch: unset or any non-'true' value.
  completionAutopayCharge: process.env.GATE_COMPLETION_AUTOPAY_CHARGE === 'true',

  // Overdue-balance visibility (owner ruling 2026-08-08, Donovan case): the
  // invoice EMAIL carries a "previous balance" note when the customer has
  // other open, live-payer-verified self-pay invoices, so one email surfaces
  // everything owed. Originally EMAIL ONLY (the /pay page was barred from
  // sibling data — pre-push P0 ×2); the 2026-08-16 owner ruling under
  // payIncludeBalance below supersedes that bar for the pay page. The
  // authenticated portal Billing tab (portalPayNow) is the in-app
  // counterpart. Display-only — no money
  // moves under this gate and every underlying invoice stays intact
  // (dunning still ages off each invoice's own due date, so the oldest debt
  // keeps escalating — ruling #2). Customer-facing copy change, so
  // fail-closed ==='true' in EVERY environment. Gate off: emails
  // byte-identical to today.
  balanceVisibility: process.env.GATE_BALANCE_VISIBILITY === 'true',

  // Past-due balance line on the completion SMS (owner directive
  // 2026-08-15): customers whose invoices deliver via the completion-SMS
  // rail never see the balanceVisibility email note — the with-invoice
  // completion texts get a one-sentence past-due reminder instead. The line
  // is code-built (open-balance.pastDueSmsLineForCustomer) from the SAME
  // self-pay open-invoice authority as the email note, excluding the visit's
  // own invoice, and renders '' while this gate is off — the {past_due_line}
  // token ships expand/contract like {reservice_line}, so sends stay
  // byte-identical until Adam approves the copy and flips. Display-only; no
  // money moves and no sibling data ever rides the public /pay surface.
  // Customer-facing copy change, so fail-closed ==='true' in EVERY
  // environment. Kill switch: unset or any non-'true' value.
  completionSmsBalance: process.env.GATE_COMPLETION_SMS_BALANCE === 'true',

  // Completion full-balance Auto Pay pull (owner ruling 2026-08-08: "when
  // autopay runs after a visit and the customer also has an old unpaid
  // balance, take everything they owe"). After a completion auto-charge
  // SUCCEEDS on the visit's own invoice, sweep the customer's OTHER open,
  // already-delivered self-pay invoices oldest-first through the same
  // chargeInvoiceWithSavedCard authority — one charge per invoice, each
  // capped at that invoice's own current amount, so every existing lock/
  // surcharge/ledger/receipt rail applies unchanged and a decline stops the
  // sweep (the remaining invoices keep their pay links + dunning exactly as
  // today). Money surface — fail-closed ==='true' in EVERY environment.
  // Kill switch: unset or any non-'true' value.
  completionBalanceSweep: process.env.GATE_COMPLETION_BALANCE_SWEEP === 'true',

  // Pay-page full-balance collection (owner ruling 2026-08-16, SUPERSEDING
  // the "no sibling-invoice data on /pay" P0 and the email-only scope of
  // balanceVisibility above): the public /pay page ITEMIZES the customer's
  // other open self-pay invoices (numbers/dates/amounts — never their
  // tokens) and the single Pay button charges the COMBINED total. One
  // PaymentIntent carries a per-invoice allocation in metadata (the
  // payer-statement pattern); the settle paths mark every allocated invoice
  // paid with its own ledger row, so per-invoice receipts, dunning stops,
  // and reporting all stay per-invoice. Invoices are never merged or
  // re-totalled; admin-stopped-dunning invoices are excluded from the
  // forced total. Money surface — fail-closed ==='true' in EVERY
  // environment. Gate off: the pay page and all pay flows are byte-
  // identical to today. Kill switch: unset or any non-'true' value.
  payIncludeBalance: process.env.GATE_PAY_INCLUDE_BALANCE === 'true',

  // Pay-page FAQ (2026-09-03): a short accordion under the Pay button that
  // restates facts the page already carries — the credit-card surcharge and
  // how to avoid it, how long a bank (ACH) payment takes, Zelle, and whether
  // the card is saved. Display-only; no money moves and no new data rides
  // the public /pay payload beyond a boolean. Customer-facing copy, so
  // fail-closed ==='true' in EVERY environment. Gate off: the GET payload
  // and the page are byte-identical to today. Kill switch: unset or any
  // non-'true' value.
  payPageFaq: process.env.GATE_PAY_PAGE_FAQ === 'true',

  // Visit groups (docs/design/visit-group-scope.md rev 5): parent
  // service_visits rows grouping same-stop scheduled_services. CREATION
  // gate only — off means no new groups are stamped; existing visits keep
  // the behaviour they were created under (behavior_version frozen at
  // creation) and issued /visit/:token links keep resolving. Fail-closed
  // ==='true' in EVERY environment; kill switch: unset.
  visitGroups: process.env.GATE_VISIT_GROUPS === 'true',

  // Quote-wizard repeat-run dedupe (#3834 split, PR A′): a tokenless
  // /calculate rerun of an OPEN quote_wizard lead (same email + phone +
  // address + service, 30 days) files as status 'duplicate' carrying
  // extracted_data.duplicate_of_lead_id instead of a second 'new' lead —
  // label only, the public route never writes the original. OFF (default,
  // every environment): every run files as 'new', byte-identical to before.
  // Flip only once the conversion side (PR B′: accept-time and self-booking
  // resolution of a repeat to its root) has merged, or accepted reruns
  // credit no lead as won. Kill switch: unset. This entry is for
  // logGateStatus; the route reads gateEnvValue at CALL time.
  wizardLeadDedupe: gateEnvValue('GATE_WIZARD_LEAD_DEDUPE'),

  // Booking stamping contract (Tier 2 consolidation): the shared
  // field-stamping authority in services/booking/create-scheduled-service.js
  // that scheduled_services insert sites converge on. Gate OFF = no
  // behavioral enrichment: the contract only validates and stamps
  // provenance attribution (source_action/booking_source, caller values
  // always win), so adopting a call site changes nothing at rest. Gate ON
  // = enrichment stamps apply (catalog-identity snapshot completion for
  // rows the caller left snapshot-less).
  // Fail-closed ==='true' in EVERY environment; kill switch: unset.
  bookingStampingContract: process.env.GATE_BOOKING_STAMPING_CONTRACT === 'true',

  // Two-program combined visits retired (owner 2026-08-31, follow-through
  // on the 08-28 combo ruling "I want to remove all of these"): with visit
  // groups live, a sold pest + termite-bait pair (and lawn + tree & shrub)
  // schedules as TWO standalone catalog visits the office can group at one
  // stop, instead of one combined row. The termite bait + BOND routes are
  // NOT two programs — the bond is a billing rider on the bait check (one
  // visit is the product; whole-plan per-application pricing divides
  // across it) — and keep combining. The converter reads the env at CALL
  // time so a Railway flip takes effect on the next accept; this entry is
  // the status-listing registration. Fail-closed ==='true'; kill: unset.
  separateComboVisits: process.env.GATE_SEPARATE_COMBO_VISITS === 'true',

  // Service-report cross-sell (owner-approved 2026-08-11): the LIVE web
  // report offers the next service family the customer lacks (pest ↔ lawn,
  // then tree & shrub, then termite) with estimator-backed pricing, falling
  // back to an unpriced request-a-quote CTA when property data can't support
  // a real number. Customer-facing pricing surface — fail-closed ==='true'
  // in EVERY environment. Gate off: report payloads carry no crossSell key
  // and every report renders byte-identical to today. PDF/static/sms_preview
  // renders never carry it at ANY setting (the PDF is a pricing-free
  // permanent record and its S3 cache key does not vary on this gate).
  reportCrossSell: process.env.GATE_REPORT_CROSS_SELL === 'true',

  // Warm the property-evidence cache at visit completion so the cross-sell
  // card can price at render (the composer reads cache-only — a customer
  // must never wait on county APIs). Runs the composer itself with a
  // persisting lookup, post-commit and fire-and-forget, so every render
  // suppression also suppresses the spend. External-API + vision spend per
  // completed report on a cold cache — ships dark, owner flips. Inert
  // unless GATE_REPORT_CROSS_SELL is also on. Gate off: completions behave
  // exactly as today and the card keeps falling back to the quote CTA.
  reportCrossSellPrewarm: process.env.GATE_REPORT_CROSS_SELL_PREWARM === 'true',

  // A PRICED cross-sell tap mints a customer-viewable estimate at the exact
  // shown price and the response redirects into the estimate page (slot pick
  // + per-application / pay-in-full acceptance). Customer-facing money
  // surface — fail-closed ==='true' in EVERY environment, and inert unless
  // GATE_REPORT_CROSS_SELL is also on (the tap only exists on a live card).
  // Gate off: taps keep today's request-row + office-bell flow byte-for-byte
  // and the response carries no estimate URL. Quote-mode (CTA) taps keep the
  // request flow at ANY setting.
  reportClickToEstimate: process.env.GATE_REPORT_CLICK_TO_ESTIMATE === 'true',

  // Report-lane completion text for a visit that DOES have a bill. The
  // service_report_v1_with_invoice template ("Your {service_type} report is
  // ready … Invoice for today's visit: {pay_url}") has been unreachable since
  // it was written: admin-dispatch computed its pay link but the branch that
  // consumes it required !invoiceCreated, so every report-v1 line with an
  // invoice fell through to the generic service_complete_with_invoice instead.
  // #3166 rewrote the copy of a template nothing could render.
  // Customer-facing copy change on a billed visit — ships dark. Gate off: the
  // report lane keeps standing down whenever an invoice exists and the generic
  // invoice text sends exactly as today. Kill switch: unset or any non-'true'
  // value. The template must ALSO be present and active (probed per send) —
  // gate on, row missing/inactive = unchanged behavior.
  reportV1InvoiceSms: process.env.GATE_REPORT_V1_INVOICE_SMS === 'true',

  // Annual prepay sold from the New Appointment modal on a booking with NO
  // linked quote. Operator-initiated, but it invoices a customer for a full
  // year and sends the pay link, so it ships dark and opt-in in EVERY
  // environment. Gate off: the availability probe answers false, the modal
  // renders no Billing control at all (never an offered choice that silently
  // no-ops — Codex #2921 P2), and the preview endpoint 404s, so the mint can
  // only be reached from Customer 360 as before. Kill switch: unset or any
  // non-'true' value; nothing is minted retroactively when it flips.
  prepayOnBook: process.env.GATE_PREPAY_ON_BOOK === 'true',

  // Switching an ALREADY-ACCEPTED per-application customer to annual prepay
  // from the appointment sheet — the "changed their mind on site" case
  // (owner ask 2026-08-12). Opens the same prepay-on-book preview + Customer
  // 360 mint on an ESTIMATE-ORIGIN series, which the preview otherwise
  // refuses because the accept flow owns that choice; once the estimate is
  // accepted the quote is closed and its prepay door is gone, so this is the
  // only door left. Owner ruling 2026-08-12: the $99 setup fee already
  // invoiced on the accept-minted draft is WAIVED on the switch — the flow
  // supersedes (voids) that unpaid invoice, so the prepaid year is exactly
  // visits × per-visit price. Money surface — fail-closed ==='true' in EVERY
  // environment. Gate off: the availability probe answers switchEnabled
  // false, the sheet renders no prepay action, and the preview refuses
  // estimate-origin series exactly as today. Kill switch: unset or any
  // non-'true' value; nothing already minted is affected when it flips.
  //
  // Deliberate overlap with GATE_PREPAY_ON_BOOK: this gate also admits the
  // preview's COMMITTED mode for a NON-estimate series, so the sheet's
  // action works on a phone-booked recurring plan too (the on-site twin of
  // prepay-on-book). It never admits the pre-save DRAFT probe — that stays
  // the New Appointment modal's, behind its own gate. Both are read-only;
  // every mint still goes through the Customer 360 route and its guards.
  onsitePrepaySwitch: process.env.GATE_ONSITE_PREPAY_SWITCH === 'true',

  // Setting a recurring plan's LENGTH from Edit appointment. The count is not
  // a stored field — a fixed plan is recurring_ongoing=false plus exactly N
  // live rows — so lowering it CANCELS real future visits, which is why it
  // ships dark. Gate off: /series-summary answers canSetCount:false, the modal
  // hides "End repeating" and "Count" on a series template exactly as before,
  // and update-details refuses a recurringPlannedCount outright rather than
  // silently ignoring one (an ignored count reads to the office as a plan they
  // capped). Kill switch: unset or any non-'true' value; visits already added
  // or cancelled are not reversed when it flips.
  editApptAddress: process.env.GATE_EDIT_APPT_ADDRESS === 'true',
  editApptVisitCount: process.env.GATE_EDIT_APPT_VISIT_COUNT === 'true',

  // Applying a PRICE or primary-SERVICE change from Edit appointment to "this
  // and following" visits of a recurring series (per-visit stays the default).
  // "Following" rewrites the stored price/service on real future visits AND
  // stamps the change into the series template's recurring_template_overrides
  // so auto-extend / top-up / alert-extend rows inherit it (the series parent
  // row is usually already completed, so its own columns can't be rewritten
  // without falsifying the first visit's record) — which is why it ships dark.
  // Gate off: /series-summary answers canScopePriceService:false so the modal
  // never renders the selector, update-details refuses a posted
  // priceServiceScope outright rather than silently applying it per-visit,
  // and the extension writers ignore any stored overrides — extensions copy
  // the parent row exactly as before this lane existed. Kill switch: unset or
  // any non-'true' value; sibling rows already rewritten are not reversed
  // when it flips.
  editApptPriceServiceScope: process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE === 'true',

  // Collective series moves on every staff surface (owner rulings 2026-07-30
  // + 2026-08-28): with the gate on, ANY date move of a cadence visit that
  // reaches SmartRebooker.reschedule — dispatch drag, the Edit appointment
  // modal, an SMS date reply, a choke-point delegation from any future caller
  // — shifts the customer's future sister visits by the same delta (date
  // only: siblings keep window/status/tech; manual date exceptions shift by
  // the delta instead of regenerating). Auto-dispatch nudges are excluded by
  // construction. Read directly in rebooker.js (collectiveMoveGateOn) — this
  // entry keeps the flip checklist honest; series_moves rows are the
  // telemetry to review before un-gating. Kill switch: unset. Gate off: the
  // drag confirm's explicit "Reschedule series" button still works as before.
  adminCollectiveMove: process.env.GATE_ADMIN_COLLECTIVE_MOVE === 'true',

  // Customer duplicate auto-merge (customer-dedupe.js green tier). An
  // auto-WRITER — merges shell duplicate rows into their real customer on the
  // nightly cron — so like dataHygieneAutoApply it is opt-in in EVERY
  // environment; dev/staging pointed at prod snapshots must never merge rows
  // silently. Detection + the /admin/customers/duplicates review queue are
  // read-only and NOT behind this gate. Kill switch: unset or set to any
  // non-'true' value; every merge is journaled and hand-reversible.
  customerDedupeAutoMerge: process.env.GATE_CUSTOMER_DEDUPE_AUTO_MERGE === 'true',

  // Red-pair auto-dismiss (customer-dedupe.js red tier). Red is the
  // detector's own "two different people sharing a phone" verdict —
  // different last names AND a positively different address — so those
  // pairs can never be merged and would otherwise park in the review queue
  // forever. When on, the same nightly cron upserts a "not a duplicate"
  // dismissal for every currently-red pair (created_by 'auto:red-tier').
  // An auto-WRITER like the merge gate above, so opt-in in EVERY
  // environment. Reversible: delete the dismissal row and the pair
  // re-surfaces in the queue. Kill switch: unset.
  customerDedupeAutoDismissRed: process.env.GATE_CUSTOMER_DEDUPE_AUTO_DISMISS_RED === 'true',

  // Photo-assessment lead magnets (wavespestcontrol.com/lawn-assessment +
  // /pest-identifier). Public, unauthenticated, and every accepted upload is a
  // paid dual-model vision call — explicit opt-in in EVERY environment, and the
  // whole /api/public/lawn-assessment / /api/public/pest-identifier surface
  // 404s while off (same unobservable-when-dark contract as payerStatements).
  lawnAssessmentMagnet: process.env.GATE_LAWN_ASSESSMENT === 'true',
  pestIdentifier: process.env.GATE_PEST_IDENTIFIER === 'true',
  // Public careers application funnel (POST /api/public/careers/apply).
  // Dark until the owner turns hiring on; the admin recruiting queue works
  // at any setting (it only reads/updates existing rows).
  jobApplications: process.env.GATE_JOB_APPLICATIONS === 'true',

  // Route-aware estimate slot ranking (2026-07-20): when ON, the estimate
  // funnel's offered slots lead with the guaranteed soonest card, then
  // route-fit days (detour ≤ the existing 20-min proximity bound to a stop
  // already on the calendar), then pure-capacity days — instead of pure
  // soonest-first ordering. Read-only re-ordering of the same bookable
  // pool; no slot is added or removed. Opt-in in EVERY environment so
  // offer-ordering tests stay deterministic. Kill switch: unset — ordering
  // instantly reverts to soonest-first.
  geoSlotRanking: process.env.GATE_GEO_SLOT_RANKING === 'true',

  // South-zone estimate day funnel (2026-08-24): when ON, estimates that
  // resolve to a funneled far-south service zone (default: the Venice zone;
  // SOUTH_FUNNEL_ZONE_SLUGS overrides the slug list — which CITIES form the
  // zone stays DB-authoritative in service_zones.cities) only offer days the
  // calendar already has a live stop in that zone, so far-south trips cluster
  // onto one day instead of scattering across the week. A window with no
  // BOOKABLE cluster-day slot (no zone stop yet, or the zone days are full)
  // offers exactly ONE seed day (cheapest-detour, else soonest) so the
  // booking creates or extends the cluster. Offer-time only — already-signed
  // slot offers stay redeemable. Opt-in in EVERY environment so slot tests
  // stay deterministic. Kill switch: unset — offers instantly revert to the
  // full pool.
  southZoneDayFunnel: process.env.GATE_SOUTH_ZONE_DAY_FUNNEL === 'true',

  // Booking-funnel conversion canary (2026-07-18): alerts Adam when real
  // /book funnel entries see zero conversions across a window — the July
  // slot_sig outage signature. Opt-in in EVERY environment (it texts
  // ADAM_PHONE; dev/test must not fire it by accident). Kill switch: unset —
  // the scheduler tick no-ops and nothing else changes.
  bookingFunnelCanary: process.env.GATE_BOOKING_FUNNEL_CANARY === 'true',

  // LLM dispatch observability (2026-07-31): every dispatchWithFallback chain
  // logs one llm_dispatch_log row, and a daily cron emails ONLY exceptions
  // (all-providers-failed, fallback-rate spike, policy gone silent) to the
  // company inbox. Opt-in in EVERY environment (dev/test must not email or
  // write metrics rows by accident). Kill switch: unset — recording and the
  // digest email no-op instantly; the daily retention prune keeps running so
  // existing rows still age out.
  llmDispatchMetrics: process.env.GATE_LLM_DISPATCH_METRICS === 'true',

  // Hybrid knowledge retrieval (lane A2): vector+FTS+RRF search behind the
  // IB's search_field_intelligence, plus the nightly knowledge-index sync
  // that embeds corpus chunks (paid OpenAI embedding calls — pennies/run,
  // but still spend). Opt-in in EVERY environment. Kill switch: unset —
  // search instantly reverts to the lane-A1 FTS path, the nightly sync
  // no-ops, and existing embeddings stay in place for a later re-enable.
  hybridKnowledge: process.env.GATE_HYBRID_KNOWLEDGE === 'true',

  // MCP read-only knowledge tools (lane C): the /api/mcp machine endpoint
  // exposing hybrid knowledge search + catalog/protocol lookups to MCP
  // clients (Claude Code sessions, agents) under MCP_SERVICE_TOKEN.
  // Read-only by construction; opt-in in EVERY environment. Kill switch:
  // unset — the endpoint 403s.
  mcpReadTools: process.env.GATE_MCP_READ_TOOLS === 'true',

  // Public MCP server: the /api/public/mcp anonymous read-only tool surface
  // for third-party AI agents (catalog, pricing ranges, service areas, quote
  // contract). No auth BY DESIGN; rate-limited; opt-in in EVERY environment.
  // Kill switch: unset — the endpoint 404s (dark).
  mcpPublic: process.env.GATE_MCP_PUBLIC === 'true',

  // Public A2A endpoint: /api/public/a2a — the informational Agent2Agent
  // server behind the hub's agent-card.json. Static single-reply, LLM-free,
  // read-only. No auth BY DESIGN; rate-limited; opt-in in EVERY environment.
  // Kill switch: unset — the endpoint 404s (dark).
  a2aPublic: process.env.GATE_A2A_PUBLIC === 'true',

  // Twilio — sends real SMS to real phone numbers
  twilioSms: isProd ? process.env.GATE_TWILIO_SMS === 'true' : true,

  // Tech Arrived SMS — customer-facing "your tech has arrived" text fired
  // automatically from track-transitions markOnProperty when the live tracker
  // flips to on-site. Customer-facing auto-send, so it is explicit opt-in in
  // EVERY environment (off in dev/preview too, unlike twilioSms) — otherwise a
  // preview/dev env with real Twilio creds would text real customers the moment
  // markOnProperty runs. Dark until Adam sets GATE_TECH_ARRIVED_SMS=true; the
  // en-route SMS is unaffected. Still subject to twilioSms + per-customer pref.
  techArrivedSms: process.env.GATE_TECH_ARRIVED_SMS === 'true',

  // Multi-touch review-request cadence (Review Outreach tab). When on, the
  // processReviewSequences cron advances Day 0/3/4 SMS+email
  // sequences. Customer-facing auto-send → explicit opt-in in EVERY env (off in
  // dev/preview too) so a preview env with real Twilio/SendGrid creds can't
  // text/email real customers. Still subject to twilioSms + per-customer pref.
  // One-off manual sends from the same tab are NOT gated by this.
  reviewSequences: process.env.GATE_REVIEW_SEQUENCES === 'true',

  // Personalized review-ask bodies: cadence SMS touches are drafted from the
  // customer's own call/SMS history (review-ask-drafter.js) and AUTO-SEND
  // after deterministic verification, per owner ruling 2026-07-30 (scoped to
  // this lane — inbound-reply drafts stay approval-gated). Off = cadence
  // touches send the standard outreach templates. Customer-facing generated
  // text → explicit opt-in in EVERY env.
  reviewAskPersonalized: process.env.GATE_REVIEW_ASK_PERSONALIZED === 'true',

  // Review asks link STRAIGHT to the Google review form (via the tracked
  // /api/rate/:token/go redirect) instead of the 1-10 rate page. Kill switch
  // for the direct-link rollout: off = every ask body resolves {review_url}
  // to the tokenized /rate/<token> NPS page exactly as before. The /rate page
  // itself stays live either way (old links, fallback for unknown locations).
  reviewDirectLink: process.env.GATE_REVIEW_DIRECT_LINK === 'true',

  // Digital business card — the card.issued email a customer gets after their
  // FIRST completed visit (services/customer-card.js). The card row and the
  // /card/:token page are NOT behind this gate (tokenized, unlisted,
  // customer-initiated — same contract as the other public token pages); the
  // gate covers ONLY the outbound email. Customer-facing auto-send → explicit
  // opt-in in EVERY environment per house rule, so a dev/preview env with real
  // SendGrid creds can't email real customers on a completion.
  digitalBusinessCard: process.env.GATE_DIGITAL_BUSINESS_CARD === 'true',

  // Twilio — handles real inbound voice calls
  twilioVoice: isProd ? process.env.GATE_TWILIO_VOICE === 'true' : true,

  // Bilingual AI Voice Agent — backstops UNANSWERED inbound calls (no-answer,
  // or the opt-in "answers first" override) with a Spanish/English auto-detect
  // agent instead of dumb voicemail. Customer-facing AND sits on the live call
  // path, so it is explicit opt-in in EVERY environment (off in dev too, unlike
  // twilioVoice): with the gate off, decideVoiceRoute is never consulted and
  // calls route exactly as they do today. Behaviour is further tuned (and can be
  // disabled live with no deploy) via the `call_routing` system_settings row.
  voiceAiAgent: process.env.GATE_VOICE_AI_AGENT === 'true',

  // Spanish language vestibule on inbound calls — "Para español, oprima dos"
  // folded into the greeting; press 2 hands the call to the SAME Sandy relay
  // agent in an es-US session. Customer-facing and on the live call path, so
  // explicit opt-in in EVERY environment. Off ⇒ /voice TwiML is byte-identical
  // to today (no <Gather> is rendered). Also requires voiceAiAgent + a reachable
  // relay endpoint + `spanishMenuEnabled` in the call_routing settings row —
  // the vestibule is never offered when no Spanish session could start.
  voiceSpanishMenu: process.env.GATE_VOICE_SPANISH_MENU === 'true',

  // Sandy PR 1B — interruption-aware conversation context. On, a barge-in
  // rewrites the cut reply in the model's history to what the caller actually
  // heard (the played-text record, "… [interrupted]") and prefixes the next
  // caller message with `[Caller interrupted you after: "…"]`, so the model
  // resumes from there instead of repeating the unheard clause. Off ⇒ a
  // barge-in only aborts the generation; the model's messages are
  // byte-identical to today. Read at CALL time in
  // services/voice-agent/relay-conversation.js (a flip needs no redeploy);
  // this entry is the status/log listing. Kill switch: unset.
  voiceRelayInterruptContext: gateEnvValue('GATE_VOICE_RELAY_INTERRUPT_CONTEXT'),

  // Sandy PR 2A — human handoff. On, and ONLY while the office is open right
  // now, the relay registers `transfer_to_office`: the caller is handed to
  // the staff simul-ring (press-1 screen, ≤20-word whisper after accept)
  // with a server-built handoff packet on call_log.metadata.relay_handoff
  // and call_outcome='ai_transferred'. After hours the tool is absent and
  // the prompt offers a callback via capture_lead. Off ⇒ no tool, prompt and
  // /relay-complete byte-identical to today. Read at CALL time
  // (services/voice-agent/relay-transfer.js, exact 'true'); this entry is the
  // status/log listing. Kill switch: unset.
  voiceRelayTransfer: process.env.GATE_VOICE_RELAY_TRANSFER === 'true',

  // Sandy PR 2B — voice-session recovery. On, a relay socket that fails
  // mid-call is reconnected ONCE (/relay-complete re-renders the relay with
  // a resumed greeting; the new socket takes the claim), every socket's
  // transcript lands as a segment (metadata.relay_segments) and the owning
  // close composes the whole call; a second failure hands the caller to the
  // office (transfer gate, office open) or voicemail; a second consecutive
  // model / tool failure hands off instead of re-prompting. Off ⇒
  // /relay-complete and the close-time writes are byte-identical to today.
  // Read at CALL time (services/voice-agent/relay-recovery.js, exact
  // 'true'); this entry is the status/log listing. Kill switch: unset.
  voiceRelayRecovery: process.env.GATE_VOICE_RELAY_RECOVERY === 'true',

  // AI Assistant — auto-sends AI replies to customers via SMS
  aiAssistantAutoReply: isProd ? process.env.GATE_AI_ASSISTANT === 'true' : true,

  // Ask Waves — public conversational intake on the marketing site (hub). The
  // brain answers pest questions and steers visitors to the instant quote; it
  // can NEVER state a price (pricing only comes from the existing contact-gated
  // /api/public/quote/calculate path). Replies only when a visitor asks — not
  // an auto-send — so dev is open like aiAssistantAutoReply; prod ships dark
  // until Adam sets GATE_ASK_WAVES=true.
  askWaves: isProd ? process.env.GATE_ASK_WAVES === 'true' : true,

  // Legacy SMS AI Drafts — creates message_drafts rows and owner "Approve"
  // alerts from inbound customer SMS. Off by default in prod until the
  // approval workflow is ready.
  legacyAiDrafts: isProd ? process.env.GATE_LEGACY_AI_DRAFTS === 'true' : true,

  // SMS Shadow Drafter (brand-voice loop, Phase B) — silently records what
  // the house-voice AI would have replied to inbound customer SMS as
  // message_drafts status='shadow' rows. Never sends, never alerts, never
  // enters the approval queue; a later judge pass scores drafts against the
  // reply a human actually sent. Burns one Anthropic call per inbound
  // customer SMS, so prod requires explicit opt-in.
  smsShadowDrafts: isProd ? process.env.GATE_SMS_SHADOW_DRAFTS === 'true' : true,

  // Voice-Corpus Miner (brand-voice loop, Phase A) — nightly mining of
  // human-authored SMS replies + consent-gated call transcripts into
  // voice_corpus_examples (redacted text only, reader-not-ingestor).
  // No sends, no customer-visible effect; prod opt-in per house pattern.
  voiceCorpusMiner: isProd ? process.env.GATE_VOICE_CORPUS_MINER === 'true' : true,

  // Call-Research Miner (voice-of-customer corpus) — nightly extraction of
  // verbatim double-redacted quote chunks from call transcripts into
  // call_research_chunks (research taxonomy, reader-not-ingestor). Paid
  // Gemini extraction per new call (pennies nightly). No sends, no
  // customer-visible effect; prod opt-in per house pattern.
  callResearchMiner: isProd ? process.env.GATE_CALL_RESEARCH_MINER === 'true' : true,

  // Call re-transcription backfill (voice-corpus training) — hourly, batched
  // upgrade of consented legacy call recordings to diarized transcripts via
  // the same pipeline new calls use; feeds the corpus miner. DEFAULT ON per
  // the 2026-07-11 hands-off/training directive (kill switch
  // GATE_CALL_RETRANSCRIBE_BACKFILL=false). Self-terminating: exactly one
  // attempt per call, no-ops once the backlog drains. No sends, no
  // customer-visible effect; spend bounded by RETRANSCRIBE_BATCH_LIMIT.
  callRetranscribeBackfill: process.env.GATE_CALL_RETRANSCRIBE_BACKFILL !== 'false',

  // Voice-Profile Distiller (brand-voice loop, Loop 2) — DAILY distillation
  // of the redacted corpus into a style-only voice profile. Exception-based:
  // green auto-applies, flagged parks for review in the Agents hub. DEFAULT
  // ON (owner directive 2026-07-11: hands-off — merging this IS the flip);
  // kill switch GATE_VOICE_PROFILE_DISTILLER=false. Deliberately not the
  // opt-in pattern: no sends, no customer-visible effect (sole consumer is
  // the owner-activation-gated phone agent), ≤1 DEEP call/day.
  voiceProfileDistiller: process.env.GATE_VOICE_PROFILE_DISTILLER !== 'false',

  // Link Library sitemap sync — DAILY pull of www.wavespestcontrol.com's
  // sitemap into the composer's link_library rows (services/link-library.js).
  // Read-only against the public site, no sends, no customer data. DEFAULT
  // ON; kill switch GATE_LINK_LIBRARY_SYNC=false. The Settings "Sync now"
  // button calls the same sync directly and is not gated here.
  linkLibrarySync: process.env.GATE_LINK_LIBRARY_SYNC !== 'false',

  // Shadow Judge (brand-voice loop, Phase C) — nightly scoring of
  // message_drafts status='shadow' rows against the reply a human actually
  // sent, per intent class (shadow_draft_judgments). LLM is called only
  // when the human replied; batch-capped per run. No sends, no
  // customer-visible effect; prod opt-in per house pattern.
  shadowJudge: isProd ? process.env.GATE_SHADOW_JUDGE === 'true' : true,

  // SMS Suggest Mode (brand-voice loop, Phase D) — intents flipped to
  // 'suggest' in sms_intent_modes surface their house-voice draft as an
  // Agent Review card in the comms composer. A human still reads, edits,
  // and sends — never auto-sends. Escalation intents and scheduling-intent
  // messages stay shadow regardless. Prod opt-in per house pattern.
  smsSuggestMode: isProd ? process.env.GATE_SMS_SUGGEST_MODE === 'true' : true,

  // SMS Auto-Send Executor (brand-voice loop, Phase E) — the top rung of the
  // ladder shadow → suggest → auto_send. Intents flipped to 'auto_send' in
  // sms_intent_modes have their VERIFIED house-voice draft sent to the
  // customer automatically, no human in the loop. The single most sensitive
  // gate in the loop: customer-facing autonomous send, so it is explicit
  // opt-in in EVERY environment (off in dev too, unlike the silent
  // shadow/judge gates). Even with the gate on, the executor re-checks
  // graduation readiness server-side at send time and escalation/scheduling
  // intents never auto-send — the gate only unlocks the path, the data still
  // has to earn each intent.
  smsAutoSend: process.env.GATE_SMS_AUTO_SEND === 'true',

  // SMS Sealed Eval (brand-voice loop measurement) — a locked exam for the
  // house-voice drafter: frozen (inbound, day-of facts, human reply) items
  // replayed through the current drafter per provider leg and graded by the
  // live judge, with McNemar significance vs a baseline run. The weekly cron
  // only tops up the item pool (pure selection, no LLM); exam RUNS are
  // manual-trigger only (admin endpoint) because each burns items × several
  // LLM calls. No sends, no customer-visible effect; prod opt-in per house
  // pattern.
  smsSealedEval: isProd ? process.env.GATE_SMS_SEALED_EVAL === 'true' : true,

  // Sealed-exam AUTO-RUN — nightly sweep runs the exam for any drafter
  // PROMPT_VERSION that lacks a completed run per leg (first baselines +
  // every prompt bump). Spends LLM calls on its own, so it follows the
  // auto-writer pattern: opt-in in EVERY environment, kill = unset.
  // Spend rails: SEALED_EXAM_AUTO_MIN_ITEMS / SEALED_EXAM_AUTO_MAX_ITEMS.
  smsSealedExamAutoRun: process.env.GATE_SMS_SEALED_EXAM_AUTORUN === 'true',

  // Shadow Backfill (brand-voice loop accelerator) — drafts house-voice
  // replies for HISTORICAL inbound SMS that already have a human reply and
  // feeds them to the existing judge, compressing months of per-intent
  // score accumulation into days. Hourly batches, self-terminating once
  // history is exhausted. Burns ~2 Anthropic calls per sample, so prod
  // requires explicit opt-in; flip off (or leave — it no-ops) when done.
  shadowBackfill: isProd ? process.env.GATE_SHADOW_BACKFILL === 'true' : true,

  // SMS Pathology Ledger (brand-voice loop diagnostics) — nightly classifies
  // each draft_unsafe judgment into a fixed (harness surface × failure mode)
  // cell, and weekly parks a harness-patch PROPOSAL card when a cell
  // accumulates enough fresh evidence. Proposals never auto-apply — a prompt
  // change is a human-shipped version bump. No sends, no customer-visible
  // effect; burns one FAST call per unsafe judgment + ≤2 weekly DEEP calls,
  // so prod requires explicit opt-in per house pattern.
  smsPathologyLedger: isProd ? process.env.GATE_SMS_PATHOLOGY_LEDGER === 'true' : true,

  // AI Blog Writer — generates content via Anthropic API
  aiBlogWriter: isProd ? process.env.GATE_AI_BLOG_WRITER === 'true' : true,

  // Cron Jobs — automated scheduled tasks (reminders, billing, intelligence)
  cronJobs: isProd ? process.env.GATE_CRON_JOBS === 'true' : process.env.GATE_CRON_JOBS !== 'false',

  // Weekly lawn pricing invariant sweep — re-runs the pricing engine across the
  // full track×size×tier grid against LIVE DB config and raises an admin alert
  // on ladder violations or material-budget drift vs live inventory COGS.
  // Read-only + one alert upsert; kill = unset GATE_LAWN_PRICING_SWEEP.
  lawnPricingInvariantSweep: isProd ? process.env.GATE_LAWN_PRICING_SWEEP === 'true' : true,

  // Webhooks — process inbound Twilio/Stripe/Lead webhooks
  webhooks: isProd ? process.env.GATE_WEBHOOKS === 'true' : true,

  // SEO Intelligence — DataForSEO API calls, rank tracking, backlink scans
  seoIntelligence: isProd ? process.env.GATE_SEO_INTELLIGENCE === 'true' : true,

  // Geo-grid map-pack rank tracking (Pillar 3) — weekly DataForSEO sweep of an
  // N×N grid of pins per office. PAY-PER-CALL (offices × keywords × grid² live
  // calls), so opt-in in EVERY env (not default-on in dev) to avoid surprise
  // spend; the underlying serpMaps also needs seoIntelligence on.
  geoGridTracking: process.env.GATE_GEO_GRID === 'true',

  // Self-Booking — customer self-scheduling after estimate acceptance
  selfBooking: isProd ? process.env.GATE_SELF_BOOKING === 'true' : true,

  // Self-Booking customers-only mode — /book requires a verified current
  // customer (portal OTP bearer) or an estimate-token entry; bookings that
  // would mint a NEW customer are refused with a get-a-quote handoff (owner
  // directive 2026-07-23: new people quote first, they don't self-schedule).
  // The client learns the mode via GET /booking/config `customers_only`;
  // /booking/confirm enforces it server-side regardless of what the client
  // shows. Dark until Adam flips it in prod.
  bookingCustomersOnly: isProd ? process.env.GATE_BOOKING_CUSTOMERS_ONLY === 'true' : true,

  // Customer self-serve re-service scheduler — the standing /reservice/:token
  // link (customers.reservice_token) that lets an active recurring / WaveGuard
  // customer book their free pest/lawn re-service callback themselves, on the
  // same route-aware availability engine as /book and /reschedule. Gates the
  // WHOLE surface: the public route 404s, buildReserviceLink mints nothing,
  // the portal schedule payload omits its reservice block, and the admin
  // comms composer helper 404s. Customer-facing scheduling surface, so opt-in
  // in EVERY environment (fail-closed ==='true', like securePlanChoice).
  // Kill switch: unset GATE_RESERVICE_SELF_SERVE — the surface goes dark
  // again with no data cleanup needed (booked callbacks are ordinary
  // is_callback visits the office already manages).
  reserviceSelfServe: process.env.GATE_RESERVICE_SELF_SERVE === 'true',

  // Re-service request streamline — the picker (/reservice/:token) becomes the
  // only path for covered re-services (owner ruling 2026-08-08): the portal's
  // Request Service overlay hands eligible pest/lawn issues to the picker
  // instead of filing a notify-only service_requests ticket, schedule_change
  // offers the per-visit /reschedule/:token pages, the legacy
  // POST /api/schedule/:id/reschedule stops flipping visits to
  // status='rescheduled' (off the books), and the completion/report/review SMS
  // carry the customer's standing re-service link. Rides ON TOP of
  // reserviceSelfServe — with that gate dark nothing here can surface either.
  // Customer-facing behavior change, so opt-in in EVERY environment.
  // Kill switch: unset GATE_RESERVICE_STREAMLINE — overlay files tickets,
  // reschedule flips status, and the SMS line renders empty again.
  reserviceStreamline: process.env.GATE_RESERVICE_STREAMLINE === 'true',

  // Portal "Pay now" — authenticated /billing/balance includes the
  // customer's open-invoice pay links (`openInvoices`) so the Billing tab
  // can offer the existing tokenized /pay checkout in-app instead of the
  // audit's pay-a-balance dead end (S2-1). Read-only surface over invoices
  // that already exist; gate off = payload byte-identical to today.
  portalPayNow: isProd ? process.env.GATE_PORTAL_PAY_NOW === 'true' : true,

  // Estimate accept — widen existing-appointment detection to ANY upcoming
  // pending/confirmed appointment belonging to the estimate's customer (not
  // just rows already linked to the estimate). A match swaps the accept
  // wizard's slot picker for payment options and the accept stamps
  // source_estimate_id onto that visit. Changes which visit an acceptance
  // attaches to, so it FAILS CLOSED (explicit opt-in in every environment)
  // until the owner verifies the first customer-wide match end-to-end.
  estimateExistingApptCustomerWide: process.env.GATE_ESTIMATE_EXISTING_APPT_CUSTOMER_WIDE === 'true',
  // Estimate accept may adopt a visit that is already en_route/on_site —
  // the on-site accept: the tech is at the door, the customer accepts the
  // sent estimate from the phone, and the in-progress visit must become the
  // plan's first (priced) application instead of minting a duplicate
  // pending row. Same fail-closed opt-in as the customer-wide gate above
  // (changes which visit an acceptance attaches to). The decision point
  // re-reads the env through gateEnvValue so a var flip is a live kill
  // (GH codex #3814 r1 P1); this entry is the inventory/boot-log row.
  estimateAdoptInProgressVisit: gateEnvValue('GATE_ESTIMATE_ADOPT_IN_PROGRESS_VISIT'),
  // Call-pipeline booking confirmation carries the customer's open estimate
  // link: a phone booking against an unaccepted (sent/viewed) estimate is
  // unpriced by design — the recurring rate is plan billing, and the
  // per-visit price depends on the frequency the customer picks at accept.
  // The link lets them accept, pick the plan, and add the card before the
  // visit instead of on the doorstep. Customer-facing copy → dark until
  // the owner approves the wording; `false`/unset is the kill, read at
  // call time through gateEnvValue (GH codex #3814 r1 P1). PREREQUISITE:
  // GATE_ESTIMATE_EXISTING_APPT_CUSTOMER_WIDE — the link is sent only when
  // the accept page would adopt the call-booked visit, which an unlinked
  // row reaches through that customer-wide fallback alone; with it off the
  // link gate is inert (warns per booking).
  callConfirmationEstimateLink: gateEnvValue('GATE_CALL_CONFIRMATION_ESTIMATE_LINK'),

  // Backlink Agent — Playwright browser automation for profile signups
  backlinkAgent: isProd ? process.env.GATE_BACKLINK_AGENT === 'true' : true,

  // Backlink path investigator (Manager v2 step 3) — the hourly job that
  // fetches ≤8 pages per registry domain and spends ONE WORKHORSE LLM call to
  // classify HOW a link can be acquired (plan §5). PAY-PER-DOMAIN (fetches +
  // LLM), so opt-in in EVERY env (not default-on in dev) — a dev box with a
  // real ANTHROPIC_API_KEY must not burn batches on boot. Investigation only:
  // it never sends, pays, or leases work. While ON, a registry domain still
  // at `new` (never investigated) is not claimable either (plan §7) — the
  // worker reads this gate for that rule.
  linkInvestigator: process.env.GATE_LINK_INVESTIGATOR === 'true',

  // GATE_LINK_AUTHORITY — Backlink Manager v2 step 4: the acquisition-authority
  // policy engine may grant AUTO_* levels, and every automated claim and every
  // irreversible step re-checks it. OFF ⇒ no automated lease of ANY level is
  // granted (owner-approved rows included), in-flight work stops before its
  // next irreversible action; nothing's lifecycle status changes (plan §12).
  // Step 4a (PR 1) declares it and shows it on the Policy panel; step 4b lands
  // the waiver/approval schema (PR 2a-i) and then gates the nightly
  // `link-authority` bridge on it (PR 2a-ii: off ⇒ selection-only, no
  // placements, no parks, no bell). Nothing consumes a stamp until the claim
  // predicate re-check lands (PR 4). The shipped policy defaults route every
  // row to the owner regardless. Opt-in in EVERY env.
  linkAuthority: process.env.GATE_LINK_AUTHORITY === 'true',

  // Backlink profile → astro sameAs sync — weekly job that opens a PR adding
  // verifier-confirmed (status live/indexed) directory/citation/social profile
  // URLs from seo_link_prospects to the marketing site's entity-profiles.auto.json
  // (Organization sameAs). This job WRITES to an external repo, so it is opt-in in
  // EVERY env (not default-on in dev) — a dev/preview box with real
  // DATABASE_URL/GITHUB_TOKEN must not open Astro PRs without an explicit flag.
  // Even when on, it only opens a PR for human review (never auto-merges).
  backlinkProfileSync: process.env.GATE_BACKLINK_PROFILE_SYNC === 'true',

  // Hermes Worker — machine-to-machine claim/report contract for the Hermes
  // (Docker) acquisition agent. Off in prod until the worker is deployed and
  // HERMES_SERVICE_TOKEN is set; the auth middleware also fails closed without it.
  hermesWorker: isProd ? process.env.GATE_HERMES_WORKER === 'true' : true,

  // Link Prospect Outreach — master switch for the outreach lane: serves outreach
  // prospects to the worker (claim) AND arms the M3b approval-gated send valve
  // (link-prospect-outreach.js). Default OFF everywhere; even when ON, a send still
  // requires an operator's explicit, authenticated approval click — never auto-send.
  linkProspectOutreach: process.env.GATE_LINK_OUTREACH === 'true',

  // Outreach Drafter — in-process cron that claims outreach prospects, drafts a
  // 1:1 pitch via Claude, and parks it as 'drafted' for the approval queue. It
  // NEVER sends. Independent of linkProspectOutreach so drafts can be generated
  // and reviewed BEFORE the send valve is armed (two-step trust ladder). Default
  // OFF in prod.
  outreachDrafter: isProd ? process.env.GATE_OUTREACH_DRAFTER === 'true' : true,

  // Signup Runner — the citation/directory submission lane: the classifier cron
  // and (Phase 1b) the fail-closed browser runner that auto-submits FREE listings
  // and parks account/payment/CAPTCHA-gated ones. Never spends money (payments are
  // Phase 2). Default OFF in prod; the manual classify/run CLIs work regardless.
  // PREREQUISITE before enabling in prod: an egress firewall on the runner's Railway
  // service blocking private CIDRs (RFC1918 / 169.254 / ::1 / fc00::/7) — the browser
  // runner drives a headless browser against untrusted pages (see signup-runner.js).
  signupRunner: isProd ? process.env.GATE_SIGNUP_RUNNER === 'true' : true,

  // Local-Opportunity Prospector — the PROACTIVE link lane: a weekly cron that runs
  // curated local-intent SERP queries (youth-sports/charity-run sponsorships, chamber
  // member directories, community calendars, local podcasts) and promotes the scored,
  // lane-routed result domains onto the seo_link_prospects board. Read-only discovery +
  // dedupe-guarded inserts; NEVER sends — rows sit inert behind GATE_LINK_OUTREACH /
  // GATE_SIGNUP_RUNNER like harvested rows. Default OFF in prod; the manual CLI works
  // regardless. Complements the reactive competitor harvest (backlink-deep-harvest.js).
  localOpportunityProspector: isProd ? process.env.GATE_LOCAL_OPPORTUNITY_PROSPECTOR === 'true' : true,

  // Marchex Auto-Block — reject inbound calls the Marchex Clean Call
  // Marketplace add-on flags as spam. Explicit opt-in everywhere: until the
  // gate is on, verdicts are only logged (shadow) and never block a caller.
  marchexAutoBlock: process.env.GATE_MARCHEX_AUTO_BLOCK === 'true',

  // Lead Auto-Bridge — when a website lead comes in during business hours,
  // ring Adam and offer Press-1 to bridge directly to the customer. Off by
  // default in prod until verified; admin-click bridge is unaffected.
  leadAutoBridge: isProd ? process.env.GATE_LEAD_AUTO_BRIDGE === 'true' : true,

  // Lead Estimate Automation — generates priced draft estimates from new
  // lead-webhook submissions. Explicit opt-in everywhere so leads can keep
  // flowing while quoting stays manual.
  leadEstimateAutomation: process.env.GATE_LEAD_ESTIMATE_AUTOMATION === 'true',

  // Lead Estimate Auto-Send — sends generated lead-webhook draft estimates
  // after a delay. Requires leadEstimateAutomation in the scheduler too.
  leadEstimateAutoSend: process.env.GATE_LEAD_ESTIMATE_AUTO_SEND === 'true',

  // Lead Webhook Turnstile — enforce Cloudflare Turnstile on the public,
  // unauthenticated lead webhook (POST /api/leads). Closes the direct-POST spam
  // vector: without it any bot can mint a lead + customer + draft estimate and
  // page the owner's cell. Explicit opt-in in EVERY environment (off in dev/test
  // too) so the Jest suite + local forms that issue no token keep working, and so
  // prod stays on today's behavior until (a) TURNSTILE_SECRET_KEY is set on
  // Railway and (b) the Astro forms shipping the widget have fully propagated on
  // Cloudflare Pages. While OFF, tokens are still verified-and-logged (shadow)
  // but never block; a missing secret or a Cloudflare error always fails OPEN so
  // real leads never break. Flip GATE_LEAD_TURNSTILE=true to begin blocking.
  leadTurnstile: process.env.GATE_LEAD_TURNSTILE === 'true',

  // AutoPay Customer SMS — customer-facing autopay/pre-charge/payment-retry
  // texts are opt-in everywhere until the WaveGuard autopay rollout is
  // verified. This does not affect internal admin alerts.
  autopayCustomerSms: process.env.GATE_AUTOPAY_CUSTOMER_SMS === 'true',

  // Customer SMS send window (owner ruling 2026-08-07): automated customer/
  // lead texts only between 8:00 AM and 8:00 PM ET — an evening schedule
  // change had the reminder cron texting customers at 9:15 PM. Enforced as
  // a sendCustomerMessage validator plus a pre-send guard in the reminder
  // cron (24h reminders that would defer into the visit's own day are
  // skipped outright). Operator-initiated sends and conversational replies
  // are exempt. Opt-in in EVERY environment; unset = today's behavior.
  smsSendWindow: process.env.GATE_SMS_SEND_WINDOW === 'true',

  // Email-first 72h appointment reminders for ONE-TIME visits (owner
  // rulings 2026-08-29): a one-time visit's 72h reminder DEFAULT channel
  // becomes email — the appointment.reminder_72h template with the
  // self-serve reschedule CTA and the card-hold fee-policy note — with the
  // existing no-usable-email SMS fallback intact. Recurring-lineage visits
  // (is_recurring / recurring_parent_id / recurring_pattern) keep their SMS
  // rhythm; explicit 'both' preferences keep both legs; the 24h reminder is
  // untouched. Customer-facing channel change: explicit opt-in in EVERY
  // environment; unset = SMS-led 72h reminders (today's behavior).
  reminder72hEmailFirst: process.env.GATE_REMINDER_72H_EMAIL_FIRST === 'true',

  // Estimate Deposit-Abandonment SMS — texts customers who started the
  // deposit payment step on a public estimate (a pending Stripe
  // PaymentIntent in estimate_deposits) but never completed it. Customer-
  // facing auto-send: explicit opt-in in EVERY environment. Until the gate
  // is on, the follow-up cron only logs candidate counts (shadow) and never
  // claims or sends.
  estimateDepositAbandonmentSms: process.env.GATE_ESTIMATE_DEPOSIT_ABANDONMENT_SMS === 'true',

  // Pre-connect caller screen — inbound callers with NO customer match AND
  // STIR/SHAKEN attestation B (spoofed-number robocall profile; 67% dead-air
  // in 60d of prod signal, ~2% of lead calls) must press a key before staff
  // phones ring. Failures land in the Waves voicemail recorder, never a
  // hangup. Caller-facing friction: explicit opt-in in EVERY environment.
  // Off → qualifying calls are only stamped
  // call_log.metadata.preconnect_screen='would_gate' (shadow daily counters,
  // zero caller impact).
  callPreconnectScreen: process.env.GATE_CALL_PRECONNECT_SCREEN === 'true',

  // Payment-step-abandonment follow-up EMAIL — emails customers who reached
  // the save-a-card step of accepting an estimate (Auto Pay card on a
  // recurring accept, or the one-time card hold; estimate_checkout_events
  // row) but never completed the acceptance. Successor to the deposit-
  // abandonment recovery above — deposits are retired from the accept flow.
  // Customer-facing auto-send: explicit opt-in in EVERY environment. Until
  // the gate is on, the follow-up cron only logs candidate counts (shadow)
  // and never claims or sends.
  paymentStepFollowup: process.env.GATE_PAYMENT_STEP_FOLLOWUP === 'true',

  // Estimate engagement engine — behavior-triggered follow-up EMAILS keyed
  // to estimate view sessions (return visit, dark-then-return, high intent,
  // unopened, gone-quiet, expiring). V1 scope: pest + lawn estimates only.
  // Customer-facing auto-send: explicit opt-in in EVERY environment. Until
  // the gate is on, the engine still schedules and consumes jobs but marks
  // them 'shadow' and logs the would-send — volume is judgeable with zero
  // send risk and no post-flip backlog burst.
  estimateEngagementFollowup: process.env.GATE_ESTIMATE_ENGAGEMENT_FOLLOWUP === 'true',

  // Nightly critical-churn "CHURN ALERT" SMS to the owner's phone
  // (retention-engine, 3AM Customer Intelligence Pipeline). Internal-only —
  // it texts ADAM_PHONE, never a customer — but the owner paused health
  // notifications 2026-07-11, so it fails CLOSED in every environment until
  // explicitly re-enabled with GATE_CHURN_ALERT_SMS=true. Retention outreach
  // drafts still queue as pending_approval either way; only the owner-alert
  // SMS is gated.
  churnAlertSms: process.env.GATE_CHURN_ALERT_SMS === 'true',

  // Abandoned-booking recovery — chases /book drop-offs (booking_intents) with a
  // ~1h recovery SMS + ~24h email. A customer-facing auto-send, so it FAILS CLOSED
  // (explicit opt-in in EVERY environment) per the house rule — a preview/dev env
  // with real Twilio/SendGrid creds + cronJobs on must NOT auto-send. Owner sets
  // GATE_BOOKING_ABANDON_RECOVERY=true on prod at merge to go live (effectively
  // "live on merge", one env flip). Off → the cron only shadow-logs candidates.
  bookingAbandonRecovery: process.env.GATE_BOOKING_ABANDON_RECOVERY === 'true',

  // Click-followup action queue — turns human short-link clicks on estimate /
  // booking links that DIDN'T convert into PENDING message_drafts (intent
  // 'click_followup') for owner review in /admin/drafts. This lane NEVER
  // sends anything itself — the draft is the terminal artifact and only the
  // owner's approval in /admin/drafts puts a message on the wire. The gate
  // covers the queue writes (action rows + drafts): off → the cron only
  // shadow-logs candidate counts so volume can be judged first. Flip
  // GATE_CLICK_FOLLOWUP=true to start queueing drafts.
  clickFollowup: process.env.GATE_CLICK_FOLLOWUP === 'true',

  // Estimate Clarify Asks — when automated quote drafting dead-ends on a
  // machine-readable missing item (no address / no concrete service), park
  // ONE clarifying SMS in /admin/drafts (intent 'estimate_clarify') for the
  // owner's one-click approval. The writer never sends; the approve route
  // re-checks this gate before putting anything on the wire. Off → dead
  // ends keep today's operator-bell-only behavior.
  estimateClarifyAsks: process.env.GATE_ESTIMATE_CLARIFY_ASKS === 'true',

  // Clarify unit write-back — when the customer texts back the apartment/
  // unit the completed-call clarify ask requested, write it into the record:
  // lead address line 2; the customer's line 2 when their own address IS
  // that building; otherwise the building + unit as a property row on the
  // account (owner ruling 2026-09-03). Off → the reply is stamped on the
  // Triage Inbox card only (the office enters it by hand). Reads
  // GATE_ESTIMATE_CLARIFY_ASKS' lane; meaningless alone. The answer is
  // stamped on the call row as a fence every draft creator checks, and the
  // call's unsent building-level draft(s) are HELD for the operator (PR
  // C2a of the #3775 split); the automatic re-draft is PR C2b.
  clarifyUnitWriteback: process.env.GATE_CLARIFY_UNIT_WRITEBACK === 'true',

  // Ads Budget Live Push — allow the 2-hourly capacity-based budget cron
  // (BudgetManager.adjustBudgets) to push its budget changes to the Google
  // Ads API. Off until the owner verifies campaign links + base budgets in
  // /admin/ads: with it off the cron records intended budgets locally only
  // (dashboard/advisor state, no real spend change). Manual budget/mode
  // controls in /admin/ads push live regardless of this gate — it covers
  // only the autonomous loop. Controls real ad spend, so like the auto-send
  // gates it FAILS CLOSED (explicit opt-in in EVERY environment): a dev or
  // preview env with copied Google Ads creds + cronJobs open must never
  // mutate live campaign budgets by default.
  adsBudgetLivePush: process.env.GATE_ADS_BUDGET_LIVE_PUSH === 'true',

  // Booking "pay per application" — LINKED-ESTIMATE, PEST-ONLY BY DESIGN: prices
  // ONLY a booking explicitly linked to an estimate (estimate_id), and only for
  // the quarterly pest_control series this route actually seeds (lawn/mosquito/
  // tree bookings are single visits). Everything else fails closed to today's
  // price-less behavior. Lighting up the common quote-wizard booking (no
  // estimate_id) is a follow-up that passes a server-trusted estimate reference
  // from the quote flow — not identity inference. When priceable (service- +
  // cadence-bound, no supplemental program), stamp the per-application price +
  // payment_method_preference='pay_at_visit' + create_invoice_on_complete onto
  // the booked visit (and its inherited recurring follow-ups) so completion
  // invoicing bills each visit from estimated_price. Self-booked customers carry
  // no WaveGuard tier, so the invoice-on-complete flag is what makes completion
  // auto-invoice fire. No charge or card capture happens AT booking; billing +
  // card-save ride the existing completion → invoice → /pay path. A money-path
  // behavior change, so it FAILS CLOSED (explicit opt-in in every environment);
  // off → bookings stay price-less as before. Owner sets
  // GATE_BOOKING_PAY_AT_VISIT=true after verify.
  bookingPayAtVisit: process.env.GATE_BOOKING_PAY_AT_VISIT === 'true',

  // Proactive line-type lookup — before the first SMS to a number, Twilio Lookup
  // its line type and skip landlines (avoids the wasted send + 30006 bounce that
  // the reactive suppression in #2160 only catches after the fact). Adds a paid
  // Lookup (~$0.008) on the first send to each uncached number, so it is opt-in
  // in EVERY environment until the owner enables it; results cache in
  // phone_line_types (one lookup per number, ever) and detected landlines also
  // get a non_mobile suppression row.
  proactiveLineTypeLookup: process.env.GATE_PROACTIVE_LINETYPE_LOOKUP === 'true',

  // Zero-triage call pipeline (2026-07-10 mining mission) — all dark by
  // default; see docs/call-mining-2026-07-10.md.
  // Disposition rules layer: stamps a terminal disposition on every processed
  // call (call_log.disposition). No behavior change beyond the stamp.
  callDispositionV1: process.env.GATE_CALL_DISPOSITION_V1 === 'true',
  // Layered spam classifier: records verdicts to call_spam_verdicts (100%
  // precision offline; any discard action is a separate consumer decision).
  callSpamClassifier: process.env.GATE_CALL_SPAM_CLASSIFIER === 'true',
  // Profile-enrichment writer: gate codes/pets/notes from extraction into
  // property_preferences + customers.internal_notes (admin-edit-preserving).
  callProfileEnrichment: process.env.GATE_CALL_PROFILE_ENRICHMENT === 'true',
  // Admin bell for service-request voicemails that do NOT take the workable
  // lead path (existing-customer or content-veto'd voicemails with concrete
  // service intent + callback number). Bell only — no customer comms.
  voicemailCallbackAlert: process.env.GATE_VOICEMAIL_CALLBACK_ALERT === 'true',
  // Nightly self-audit: samples recent calls, strong-model re-read, drift
  // metrics to call_audit_findings; alerts ONLY on threshold breach.
  callSelfAudit: process.env.GATE_CALL_SELF_AUDIT === 'true',
  // Fail-open booking: a CONFIRMED appointment books despite recoverable
  // contact-field flags (ANI satisfies caller_phone_missing; an existing
  // customer's on-file address clears address flags; garbled email is
  // advisory). Google Address Validation still governs new addresses; hard
  // blocks (out_of_service_area, do_not_contact, caller_not_authorized, spam)
  // stay. Creates real appointments — owner-flip only.
  callFailOpenBooking: process.env.GATE_CALL_FAIL_OPEN_BOOKING === 'true',
  // Agent-commitment booking authorization: when OUR agent explicitly
  // committed to the confirmed slot on the call ("we'll confirm it for noon
  // on Sunday" — evidence-pinned to an AGENT-spoken quote), a third-party
  // caller (realtor/PM booking for a buyer/tenant) no longer hard-blocks on
  // caller_not_authorized: the appointment books and the flag files as an
  // advisory "confirm the account holder" card (book-and-flag). All other
  // hard blocks stay. Independent of callFailOpenBooking. Creates real
  // appointments — owner-flip only.
  callAgentCommitBooking: process.env.GATE_CALL_AGENT_COMMIT_BOOKING === 'true',
  // Companion trust gate for callAgentCommitBooking: the Agent:/Caller:
  // transcript labels the commitment-grounding relies on are LLM-inferred
  // today (labelTranscriptWithOpenAI infers unclear identities; its integrity
  // check preserves words, not attribution). Flip ONLY when speaker labels
  // come from a deterministic source (dual-channel recording / channel-
  // derived diarization) — or when the owner explicitly accepts LLM-label
  // risk. Without this gate the agent-commitment demotion never fires, even
  // with GATE_CALL_AGENT_COMMIT_BOOKING on. Owner-flip only.
  callAgentCommitTrustedLabels: process.env.GATE_CALL_AGENT_COMMIT_TRUSTED_LABELS === 'true',
  // Implied consent for INBOUND bookings: a caller who called us and agreed to
  // a time has implied consent for the transactional confirmation SMS
  // (established business relationship). do-not-contact always overrides.
  // Sends customer SMS — owner-flip only.
  callInboundImpliedConsent: process.env.GATE_CALL_INBOUND_IMPLIED_CONSENT === 'true',
  // Payer (third-party Bill-To) linkage from a call: when a caller names a
  // DISTINCT paying party (e.g. "the owner Jim pays by credit card", "bill the
  // management company"), find-or-create a `payers` Bill-To from that contact
  // and stamp payer_id on the booking so the completion invoice routes to the
  // payer's AP inbox. Reuses the existing (live) payer subsystem; only fires
  // alongside GATE_CALL_SECONDARY_CONTACT (the payer IS a secondary party).
  callPayerLinking: process.env.GATE_CALL_PAYER_LINKING === 'true',
  // OUTBOUND-callback auto-booking: a confirmed booking taken on an outbound
  // call (a return call to an inbound lead) creates the appointment LIVE, the
  // same as an inbound one — status confirmed, reminders armed, lead
  // converted, confirmation + card-request through the normal TCPA-gated legs
  // — instead of being skipped as 'outbound_call'. (The pending-office-review
  // hold this gate originally shipped with was removed 2026-08-11 by owner
  // directive, PR #3361 — enabling this is a fully customer-facing lane, not
  // a staged rollout.) Requires a real catalog service (no generic-placeholder
  // fallback for outbound). Off → outbound bookings stay manual.
  callOutboundBooking: process.env.GATE_CALL_OUTBOUND_BOOKING === 'true',
  // Call-ingest completeness watchdog: a 30-min cron that diffs Twilio's own
  // call ledger against call_log and rings an admin bell for any answered
  // inbound call (completed, >=20s) the pipeline never received — born from
  // the 2026-07 reconciliation that found 391 Feb–Mar calls silently never
  // ingested. Read-only against Twilio; writes only admin notifications.
  // Off → cron ticks are no-ops.
  callIngestWatchdog: process.env.GATE_CALL_INGEST_WATCHDOG === 'true',
  // Call-processing stall watchdog: recorded calls that never reach a
  // terminal processing state (wedged claim, dead processor, provider
  // outage) ring an admin bell instead of silently costing leads — the
  // 2026-08-31 wedge and a row stuck since 07-10 both went unnoticed.
  callProcessingStallWatchdog: process.env.GATE_CALL_PROCESSING_STALL_WATCHDOG === 'true',
  // Call commitments: every processed call records what Waves promised and
  // what the caller agreed to as evidence-linked rows (call_commitments),
  // seeded from the V2 extraction plus one bounded model pass over the
  // transcript, and links each promise to the later record that fulfils it.
  // Off → nothing is written; the Calls tab still renders rows already
  // recorded. Kill switch: unset. See services/call-commitments.js.
  callCommitments: process.env.GATE_CALL_COMMITMENTS === 'true',
  // Unrecorded-call alert: the "Twilio has no recording either" step of the
  // existing 5-min missing-recording sweep (call-recording-processor
  // .recoverMissingRecentRecordings). Rings an admin bell for any answered
  // inbound call (>=60s, not voicemail/AI-relay) still without a recording
  // 30 min after it ENDED — the blind spot the ingest watchdog can't see
  // (the SID IS known; the audio never arrived). Born 2026-08-29: pool
  // exhaustion → webhook 502 → Twilio's static voice-fallback bridged a
  // 4:17 call with no <Dial record>, so no transcript/extraction/lead ever
  // followed. Reads notifications; writes only admin bells.
  // Off → the sweep recovers recordings exactly as before, no bells.
  unrecordedCallWatchdog: process.env.GATE_UNRECORDED_CALL_WATCHDOG === 'true',
  // Booking-miss watchdog: a 30-min cron that rings an admin bell when a
  // call's V2 extraction says a concrete appointment slot was CONFIRMED but
  // no non-cancelled scheduled_services row exists for that customer on that
  // ET date — the pager for confirmed-but-never-booked calls (outbound skip,
  // v2 routing block, missing fields all park silently in triage otherwise;
  // born from a 2026-07-28 outbound callback whose confirmed Saturday-noon
  // slot was never booked). Reads call_log + scheduled_services; writes only
  // admin notifications.
  // Off → cron ticks are no-ops.
  callBookingMissWatchdog: process.env.GATE_CALL_BOOKING_MISS_WATCHDOG === 'true',
  // Shared-writer cancellation notice (job-status.js): when a visit whose
  // reminders already went out is cancelled through ANY path (cascade,
  // track, IB, raw transition), text the customer the existing
  // appointment_cancelled template instead of vanishing silently
  // (2026-08-05 silent-cancel incident). Fail-closed; owner flips.
  cancelNoticeHook: process.env.GATE_CANCEL_NOTICE_HOOK === 'true',
  // Per-family plan-rate ledger (owner ruling 2026-08-06): with the gate ON,
  // an accept's customers.monthly_rate becomes the SUM of the customer's
  // customer_plan_rates components, so a multi-plan customer's same-family
  // re-quote replaces only that family's slice instead of the whole scalar.
  // OFF, accepts keep the legacy #3241 scalar semantics byte-for-byte while
  // the ledger dual-writes advisorily (data accumulates pre-flip). Kill
  // switch = unset; owner flips after the ops backfill seeds components.
  planRateLedger: process.env.GATE_PLAN_RATE_LEDGER === 'true',
  // Cancellation resolution engine + portal cancel v2 (PR E, owner GO
  // 2026-08-30): the deterministic reason→template retention layer
  // (server/services/cancellation-resolution/), the customer cancel-
  // resolution preview endpoint, and the processor's churn tier/rate
  // wind-down (clears waveguard_tier / monthly_rate / plan-rate components
  // on full churn — the 08-30 audit's money-leak fix). OFF, every cancel
  // path behaves byte-identically to H0 (#3614). Most call sites read the
  // env at call time via gateEnvValue('GATE_CANCEL_FLOW_V2'); kill switch =
  // unset. Owner flips with the C1 portal flow.
  cancelFlowV2: process.env.GATE_CANCEL_FLOW_V2 === 'true',
  // Schedule-integrity watchdog: daily cron paging two silent-loss classes —
  // past-dated visits stuck in on_site/en_route (performed but never
  // completed → no service record, invoice, report, or post-service SMS;
  // 89 found in prod 2026-08-04) and upcoming recurring series with no price
  // on any row (a Tree & Shrub series was live wholly unpriced the same
  // day). Reads scheduled_services; writes only admin notifications.
  // Off → cron ticks are no-ops.
  scheduleIntegrityWatchdog: process.env.GATE_SCHEDULE_INTEGRITY_WATCHDOG === 'true',
  // Retroactive call_log→customer linking: an hourly cron that links
  // customer_id-NULL calls to a customer by UNAMBIGUOUS primary-phone match
  // (same single-match rule as webhook intake) — heals calls that arrived
  // before their customer record existed (observed 2026-07: a voicemail
  // orphaned for two weeks). Skips deliberate unlinks (internal-number
  // phantoms, rejected voicemails). Idempotent, never overwrites a non-NULL
  // link.
  // Off → cron ticks are no-ops.
  callLogRelink: process.env.GATE_CALL_LOG_RELINK === 'true',
  // Triage dead-letter drain: a nightly sweep that auto-resolves OPEN
  // triage_items whose condition is provably moot (customer now has the
  // address/name the card asked for; the call verifiably produced a booking
  // via source_call_log_id) and auto-dismisses aged informational flags
  // (spam 7d, listed advisory codes 30d). Explicit reason-code allowlist —
  // owed-work cards (quote_promised, cancellation_request, booking holds,
  // email_bounce_reverify, …) and in_progress cards are NEVER touched.
  // Born from the 2026-07 backlog: ~1,800 open vs 32 ever resolved.
  // Off → cron ticks are no-ops.
  triageAutoResolve: process.env.GATE_TRIAGE_AUTO_RESOLVE === 'true',
  // Evidence rules layered on the sweep above (needs it ON to run at all):
  // quote_promised closes on an estimate DIRECTLY linked to the call and
  // delivered after it; email_unverified on the call-captured address
  // engaging (open/click, not merely delivered) with a later email;
  // caller_not_authorized on a human adding the caller's number as a
  // service contact after the call; not_confirmed on a live booking created
  // after the card; address cards on a completed visit at the address the
  // call named. Every rule needs evidence that postdates the CARD, never
  // same-customer coincidence. Off → the four original rules only.
  triageAutoResolveEvidence: process.env.GATE_TRIAGE_AUTO_RESOLVE_EVIDENCE === 'true',
  // Bounce-triggered call-audio email re-verification: a hard bounce on a
  // call-captured address re-runs the source RECORDING through transcription
  // (letter-fidelity contact pass) + a deterministic name-anchored candidate
  // generator, and cards the ranked corrections for the owner's read-back
  // confirm. Writes nothing to the customer, sends nothing. LIVE BY DEFAULT
  // (owner call 2026-07-11: bounces are rare, the card is pure upside) —
  // GATE_CALL_BOUNCE_REVERIFY=false is the kill switch (stops the
  // transcription spend; bounces then behave as before: domain-corrector
  // recovery + admin alert only).
  callBounceReverify: process.env.GATE_CALL_BOUNCE_REVERIFY !== 'false',

  // Voicemail lead text-back — when a NEW prospect's voicemail produces a
  // workable lead, text them a prefilled quote-wizard link ("got your message
  // about X — get your quote: …"). A customer-facing auto-send, so it FAILS
  // CLOSED (explicit opt-in in EVERY environment) per the house rule — a
  // preview/dev env with real Twilio creds must NOT auto-text prospects.
  // Owner sets GATE_VOICEMAIL_LEAD_SMS=true on prod to go live. Off → the
  // voicemail still becomes a Needs-Review lead; only the SMS is skipped.
  voicemailLeadSms: process.env.GATE_VOICEMAIL_LEAD_SMS === 'true',

  // Dropped-call address-request text (services/dropped-call-sms.js): a NEW
  // prospect whose intake call died mid-conversation before the service
  // address was captured gets ONE text asking for it. Same fail-CLOSED rule
  // as voicemailLeadSms — customer-facing auto-send, explicit opt-in in
  // every environment. Owner sets GATE_DROPPED_CALL_SMS=true to go live.
  // Off → the dropped call still opens its call-back triage card; only the
  // SMS is skipped.
  droppedCallSms: process.env.GATE_DROPPED_CALL_SMS === 'true',

  // GrowthBook experimentation — master gate for A/B experiment assignment on
  // customer-facing surfaces (experimentation initiative, Phase 0/1). When ON,
  // eligible requests consult GrowthBook (server SDK; LOCAL eval against a
  // cached feature payload — no network in the request path) to assign a
  // variation and log one exposure row to experiment_exposures. When OFF,
  // NOTHING calls GrowthBook and every code path is byte-identical to
  // pre-experiment behavior. It changes which page a real customer sees (e.g.
  // the estimate view v1/v2 holdback), so like the customer-facing gates it
  // FAILS CLOSED — explicit opt-in in EVERY environment. Requires
  // GROWTHBOOK_CLIENT_KEY (an sdk-… SDK Connection key — NOT the secret_admin_…
  // management key) and GROWTHBOOK_API_HOST; with the gate ON but the key
  // missing/unreachable, assignment fails OPEN to control (current behavior).
  growthbookExperiments: process.env.GATE_GROWTHBOOK === 'true',

  // Universal links / Android App Links — serves the /.well-known association
  // files that let the installed native app claim portal.wavespestcontrol.com
  // URLs (routes/well-known.js). Explicit opt-in in EVERY environment: it
  // changes how links behave on customers' phones (open in app vs browser)
  // and should flip only alongside binaries carrying the Associated Domains
  // entitlement / autoVerify intent-filter. Kill = unset; both OSes fall back
  // to the browser on their next association re-validation.
  universalLinks: process.env.GATE_UNIVERSAL_LINKS === 'true',

  // Email Template Automations — executes trigger-mapped template sends from
  // the email template automation catalog. Off by default in prod until each
  // trigger has been verified with run history and idempotency checks.
  emailTemplateAutomations: isProd ? process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS === 'true' : true,

  // Treatment Automation Enroll — for wired pests (bed_bug only for now; the
  // per-pest map in appointment-tagger.js controls which, so flipping this
  // gate never silently enables an unwired pest), a first-time booking
  // enrolls the Automations-tab sequence and that sequence REPLACES the
  // transactional prep.<pest> email as the one guide email (owner directive
  // 2026-07-11: exactly one email per booking, editable in the tab). The
  // prep SMS legs key off the enrollment. Explicit opt-in in EVERY
  // environment (like universalLinks): it emails customers, and non-prod runs
  // the same every-minute scheduler, so a dev/staging booking replay must
  // never enroll anyone by default.
  // Kill: unset reverts wired pests to the transactional prep lane AND stops
  // new enrollments; toggling the automation off in the Automations tab holds
  // in-flight enrollments (the runner only picks enabled templates).
  treatmentAutomationEnroll: process.env.GATE_TREATMENT_AUTOMATION_ENROLL === 'true',

  // Confident click-tracking auto-link for unlinked Google reviews: when a
  // review syncs in with no name match and EXACTLY ONE customer's tracked
  // review-link click sits shortly before it (location-matched, tight
  // window — see review-click-correlation.js findConfidentClickMatch), link
  // the review to that customer instead of parking it in the manual-match
  // queue. Explicit opt-in: a wrong link suppresses that customer's future
  // review asks AND (via reviewThankYouEnroll) can text them a thank-you.
  // Kill: unset — reviews fall back to the unlinked-review notification and
  // the office's manual match flow; already-made links keep their
  // link_source='click_auto' stamp for audit.
  reviewClickAutoLink: process.env.GATE_REVIEW_CLICK_AUTOLINK === 'true',
  // The surname rung of that matcher (click_name: the ONE in-window clicker
  // whose complete last name is the reviewer's; see
  // findConfidentClickMatch). Ships DARK on its own switch because its
  // ambiguity semantics were still converging at review time (#3822 r6):
  // off, the rung never links and its inverse-location scan never runs —
  // sole_click and click_near stay on reviewClickAutoLink alone; the
  // surname still ranks SUGGESTIONS. Needs reviewClickAutoLink too. Kill:
  // unset.
  reviewClickAutoLinkSurname: process.env.GATE_REVIEW_CLICK_AUTOLINK_SURNAME === 'true',

  // Event → Automations-tab sequence wirings (all explicit opt-in in EVERY
  // environment, same rationale as treatmentAutomationEnroll; each kill =
  // unset the var, or toggle the sequence off in the tab to hold in-flight):
  //
  // Google review attributed to a customer (4-5 stars) → the matching
  // location's Review Thank You sequence. Once per customer ever.
  reviewThankYouEnroll: process.env.GATE_REVIEW_THANKYOU_ENROLL === 'true',
  // Automatic Google review replies. The gate is a MODE, not a boolean:
  // GATE_REVIEW_AUTO_REPLY = off (unset) | shadow (drafts only) | auto
  // (4-5★ post to Google; 1-3★ + unrated always park for a human). This
  // boolean is the "lane is on at all" view for status surfaces; the runner
  // reads the mode itself (services/review-reply/runner.js). Kill = unset.
  reviewAutoReply: ['shadow', 'auto'].includes(String(process.env.GATE_REVIEW_AUTO_REPLY || '').trim().toLowerCase()),
  // Autopay charge failure → payment_failed sequence, REPLACING the
  // transactional retry-notice email (owner rule: one email; the failure SMS
  // with the card-update link is unchanged). 14-day dedupe = one enrollment
  // per failure episode across the retry ladder. Unset = retry-notice email
  // returns.
  paymentFailedEnroll: process.env.GATE_PAYMENT_FAILED_ENROLL === 'true',
  // GATE_SERVICE_RENEWAL_ENROLL removed 2026-07-13: the renewal announcement
  // lane was scrapped (owner: no-term services never get "renewal" language;
  // termite-bond SMS reminders remain in workflows/renewal-reminder.js, and
  // price changes use the price-change notice workflow).
  // Positive-review referral invite → referral_nudge sequence, REPLACING the
  // transactional referral.invite email (one email; the referral SMS nudge is
  // unchanged). Once per customer ever, mirroring referral.invite's own
  // idempotency. Unset = referral.invite email returns.
  referralNudgeEnroll: process.env.GATE_REFERRAL_NUDGE_ENROLL === 'true',

  // Field Content Module — master gate for the tech capture → review →
  // publish pipeline (content_prompts, dispatches, media_uploads,
  // content_queue). Off means no routes, no cron, no UI. Sub-flags for
  // phased rollout live in the DB-backed feature_flags table:
  //   field_content.sms_prompts     (phase 3)
  //   field_content.auto_assemble   (phase 4)
  //   field_content.publish_fanout  (phase 5)
  // All three cascade-require this master gate.
  fieldContentModule: isProd ? process.env.GATE_FIELD_CONTENT === 'true' : true,

  // Autonomous Content Engine — runs the daily content pipeline.
  // Even when this gate is ON, individual action types stay in shadow
  // mode until SHADOW_MODE_<ACTION_TYPE>=false is set (per v3.1 plan
  // rollout — per-action-type trust-build before live publish).
  autonomousContentEngine: isProd ? process.env.GATE_AUTONOMOUS_CONTENT === 'true' : true,

  // Named-competitor comparison tables in autonomous blog posts. The writer can
  // ALWAYS emit a CATEGORY comparison ("national chain vs local SWFL company vs
  // DIY"); this flag additionally lets it NAME a real competitor — but only one
  // on the curated competitor-facts.js allowlist, never with disparagement or a
  // self-declared ranking (comparison-table-gate.js enforces all of that, and
  // routes every named-competitor post to human review regardless of this
  // flag). Default OFF in prod (legal/brand sensitivity): ships dormant so a
  // named-competitor draft routes to review instead of auto-publishing until
  // GATE_NAMED_COMPETITOR_COMPARISON=true. Category comparisons are unaffected.
  namedCompetitorComparison: isProd ? process.env.GATE_NAMED_COMPETITOR_COMPARISON === 'true' : true,

  // Autonomous blog body images (owner rule 2026-08-27: every autopublished
  // post ships ≥3 images — hero + ≥2 in-article illustrations). When ON,
  // publishOrUpdatePage, publishRefresh and the calendar/scheduler lane's
  // publishAstro generate the missing body images, commit them
  // beside the hero (/images/blog/<slug>/body-N.webp) and inserts them at the
  // end of two section's prose; generation failure parks the run (same
  // fail-closed posture as the hero). OFF in EVERY environment unless set to
  // exactly 'true' — it adds two image-generation calls per publish. Kill =
  // unset.
  blogBodyImages: process.env.GATE_BLOG_BODY_IMAGES === 'true',

  // Owner-authorized unattended blog publishing. Explicit false disables
  // competitor autopublishing; comparison/content checks remain mandatory.
  namedCompetitorAutopublish: process.env.GATE_NAMED_COMPETITOR_AUTOPUBLISH == null || process.env.GATE_NAMED_COMPETITOR_AUTOPUBLISH === 'true',

  // Affiliate links in blog bodies (owner monetization pilot 2026-08-31).
  // When ON, content-guardrails resolves <AffiliateLink product="…"> tags
  // against the vendored @waves/affiliate-registry (product rows the owner
  // approved by merging their astro registry PR); when OFF — the default —
  // the product index is empty, so EVERY AffiliateLink is a P0
  // UNREGISTERED_AFFILIATE_LINK and the lane is fully dark. Raw affiliate
  // URLs never pass regardless (DISALLOWED_EXTERNAL_LINK), and channel
  // stripping (newsletter/social) runs regardless of this flag. OFF in
  // EVERY environment unless set to EXACTLY 'true' (policy flag, same
  // posture as GATE_NAMED_COMPETITOR_AUTOPUBLISH — '1'/'on' stay dark);
  // content-guardrails reads process.env.GATE_AFFILIATE_LINKS === 'true' at
  // CALL time (the reserviceReportCopy pattern) so flips and tests take
  // effect immediately; kill switch = unset GATE_AFFILIATE_LINKS.
  affiliateLinks: process.env.GATE_AFFILIATE_LINKS === 'true',

  // aeo_gap opportunity mining — feeds answer-engine (LLM) visibility gaps into
  // the content engine's opportunity_queue. Default OFF in prod: ships dormant
  // so it can be enabled (GATE_AEO_GAP_MINING=true) only after the
  // seo_llm_mentions tracker has several days of data and the opportunities
  // have been eyeballed. When off, the aeo_gap bucket miner returns [].
  aeoGapMining: isProd ? process.env.GATE_AEO_GAP_MINING === 'true' : true,

  // answer_gap opportunity mining — queries a page already ranks 9–30 for
  // (per gsc_query_page_map) whose body never directly answers them; emits
  // refresh_existing_page opportunities whose drafts add self-contained
  // answer blocks. Default OFF in prod: ships dormant so the first mined
  // batch can be eyeballed before the refresh lane starts consuming it
  // (GATE_ANSWER_GAP_MINING=true to enable). When off, the bucket miner
  // returns [].
  answerGapMining: isProd ? process.env.GATE_ANSWER_GAP_MINING === 'true' : true,

  // Listicle brief overlay — when a supporting-blog brief's query is
  // list-shaped ("signs of…", "10 natural…"), the brief-builder layers the
  // citable-listicle architecture (count-in-title, numbered H2 per item,
  // 60-word quick answer, sourced methodology note, dated line) on top of the
  // normal supporting-blog contract. Informational lists only — the overlay's
  // voice notes forbid vendor rankings, and transactional queries never reach
  // the blog lane anyway (router's terminal guard). Default OFF in prod, ON in
  // dev; page_type stays 'supporting-blog' so every existing quality/SEO gate
  // and the Codex publish review apply untouched. Kill switch: unset.
  listicleBriefs: isProd ? process.env.GATE_LISTICLE_BRIEFS === 'true' : true,

  // listicle_family opportunity mining — clusters fragmented list-shaped GSC
  // queries ("drought tolerant plants florida" and its word-order variants)
  // into families whose SUMMED impressions clear the scoring floor, then
  // emits a new_supporting_blog opportunity on the family's top real query.
  // Feeds the listicle brief overlay (same list-shape grammar via
  // listicle-query.js) and REQUIRES listicleBriefs to also be on — the
  // miner returns [] unless both gates are true, because mining without
  // the overlay would persist rows whose briefs come out as ordinary
  // supporting blogs (lane looks enabled, produces no listicles).
  // Default OFF in prod: ships dormant so the first mined batch can be
  // eyeballed before the blog lane starts consuming it
  // (GATE_LISTICLE_FAMILY_MINING=true to enable).
  listicleFamilyMining: isProd ? process.env.GATE_LISTICLE_FAMILY_MINING === 'true' : true,
  // Email-reply approval loop for parked autonomous content runs (owner
  // directive 2026-07-28). Explicit opt-in in EVERY environment — a dev
  // server with real SMTP/IMAP creds must never email the real owner inbox
  // or poll the shared mailbox (same posture as the auto-send policy
  // above). Kill switch = unset.
  contentEmailApprovals: process.env.GATE_CONTENT_EMAIL_APPROVALS === 'true',
  // Parked-content digest (owner-authorized lane 2026-08-07): a daily ACT:
  // rollup email of autonomous runs parked completed_pending_review on the
  // admin review queue — the NON-approvable kinds (gate_fail,
  // publish_validation_failed, operator_slug_mismatch, canary caps, …) that
  // the email-approval flow above never covers and that otherwise park
  // silently. Visibility only: reads runs/opportunities, writes nothing but
  // its own ops_email_send_state watermark — no approvals, no tokens, no
  // reply parsing. Exception-based: sends only on NEW parks since the last
  // sent digest, plus a Sunday full digest while the backlog is non-empty.
  // Explicit opt-in in EVERY environment (same posture as
  // contentEmailApprovals — a dev server must never email the real owner
  // inbox). Kill switch = unset.
  parkedRunDigest: process.env.GATE_PARKED_RUN_DIGEST === 'true',

  // Data Hygiene Agent — split into sub-gates so each phase ships
  // independently. All default OFF in prod, ON in dev — except auto-apply,
  // which is opt-in in EVERY environment, and sensitive reveal, which is off
  // by default outside explicit prod enablement. Dev/staging running against
  // prod snapshots otherwise silently mutates or exposes shared data.
  //   Scanner cron is double-gated: cronJobs AND dataHygieneScanner.
  //   When dataHygieneAutoApply is OFF, would-be auto-tier proposals enqueue
  //   as pending tier='high' for manual review instead.
  dataHygieneScanner:          isProd ? process.env.GATE_DATA_HYGIENE_SCANNER    === 'true' : true,
  dataHygieneReviewUi:         isProd ? process.env.GATE_DATA_HYGIENE_UI         === 'true' : true,
  dataHygieneBootstrap:        isProd ? process.env.GATE_DATA_HYGIENE_BOOTSTRAP  === 'true' : true,
  dataHygieneDedupeCandidates: isProd ? process.env.GATE_DATA_HYGIENE_DEDUPE     === 'true' : true,
  // One extraction gate covers both Phase 4 call and SMS extractors.
  dataHygieneExtraction:       isProd ? process.env.GATE_DATA_HYGIENE_EXTRACTION === 'true' : true,
  dataHygieneAutoApply:                 process.env.GATE_DATA_HYGIENE_AUTO_APPLY === 'true',
  // Vault decrypt/reveal is explicit opt-in in every shared environment.
  dataHygieneSensitiveReveal: isProd ? process.env.GATE_DATA_HYGIENE_REVEAL === 'true' : false,

  // Inventory unit alias auto-fix (inventory-unit-review.js). Nightly sweep
  // that clears the unit-review queue's PURE-ALIAS rows only: an
  // unsupported unit string whose normalization resolves to exactly one
  // supported, unambiguous unit at conversion factor 1 ("Gallons" -> gal,
  // "FL OZ" -> fl_oz). Never touches missing-unit or ambiguous-oz rows —
  // those stay parked for review. An auto-WRITER (products_catalog +
  // movement audit rows) so, like dataHygieneAutoApply, it is opt-in in
  // EVERY environment. Kill switch: unset; every fix leaves a
  // product_inventory_movements audit row (source
  // 'inventory_unit_review_autofix') and is hand-reversible from the
  // unit-review tab.
  inventoryUnitAutofix: process.env.GATE_INVENTORY_UNIT_AUTOFIX === 'true',

  // Weekly incident regression eval — replays the incident corpus
  // (server/fixtures/incident-eval/) through the LIVE fact-check gate and
  // inbox classifier to catch prompt/model drift. Read-only except one admin
  // notification on regression. Enable with GATE_INCIDENT_EVAL=true.
  incidentRegressionEval: isProd ? process.env.GATE_INCIDENT_EVAL === 'true' : true,

  // Weekly call extraction replay eval — replays the reviewed-call corpus
  // (server/fixtures/call-extraction-eval/) through the LIVE v2 call
  // extractor to catch prompt/model drift before routing regresses. Read-only
  // except one admin notification on regression. Enable with
  // GATE_CALL_REPLAY_EVAL=true.
  callReplayEval: isProd ? process.env.GATE_CALL_REPLAY_EVAL === 'true' : true,

  // Estimate "Show your work" — public estimate page trust block: property
  // facts with friendly data-source labels, the county parcel match line,
  // and the red parcel-outline satellite overlay on the Waves AI card.
  // Off in prod until the rendered section is verified on a live estimate.
  // Enable with GATE_ESTIMATE_SHOW_YOUR_WORK=true.
  estimateShowYourWork: isProd ? process.env.GATE_ESTIMATE_SHOW_YOUR_WORK === 'true' : true,

  // Estimate extension request — "Request an extension" button on the React
  // estimate page's expired/not-found screen. First click per estimate
  // AUTO-GRANTS +7 days (shared estimate-extension service: expiry push,
  // status revival, `estimate_extended` SMS with the refreshed link — SMS
  // sending still requires the Twilio gate and passes the consent/opt-out
  // checks inside sendCustomerMessage). The auto-grant is capped at one per
  // estimate lifetime; repeat requests only notify the office. Gates BOTH
  // the /data 404 eligibility flag (which is what makes the button render)
  // and the POST endpoint itself.
  // Enable with GATE_ESTIMATE_EXTENSION_REQUEST=true.
  estimateExtensionRequest: isProd ? process.env.GATE_ESTIMATE_EXTENSION_REQUEST === 'true' : true,

  // "Does the lawn size look off?" — the customer challenge sheet on the
  // treatable-area line of the estimate (owner GO 2026-08-12). Parks a
  // service_requests row ('lawn_area_review') + admin notification; the sent
  // estimate never changes until the office re-measures. Gates BOTH the /data
  // payload flag (which is what renders the link) and the POST endpoint.
  // No customer comms anywhere in the flow. Ships DARK.
  // Enable with GATE_ESTIMATE_MEASUREMENT_REVIEW=true.
  estimateMeasurementReview: isProd ? process.env.GATE_ESTIMATE_MEASUREMENT_REVIEW === 'true' : true,

  // Returning-visitor mode on the estimate page: on the second or later
  // VISIT (estimate_views sessionized at the engagement engine's 30-minute
  // gap) the /data payload carries a `returnVisit` block — visit number, the
  // previous visit's end, and the customer-visible changes since then, each
  // named from a durable stamp (opt-out events, extension grant). Never a
  // "price changed" inferred from updated_at. Read-only projection, no write,
  // no comms. Dev-open, prod dark.
  // Enable with GATE_ESTIMATE_RETURN_VISIT=true.
  estimateReturnVisit: isProd ? process.env.GATE_ESTIMATE_RETURN_VISIT === 'true' : true,

  // Customer-facing service opt-out on a sent estimate: the customer drops one
  // recurring service line and the estimate re-prices through the canonical
  // engine (PUT /:token/service-opt-out, with a dryRun preflight that shows
  // the new numbers before anything is written). No customer comms anywhere in
  // the flow; one activity_log row, no bell.
  // STRICT opt-in in EVERY environment — deliberately not the dev-open
  // `isProd ? … : true` shape the measurement-review gate above uses: this
  // route rewrites monthly_total, annual_total and onetime_total, so a
  // local/dev run must arm it explicitly (same posture as securePlanChoice
  // and reserviceSelfServe). Dark = the /data payload omits the keys and the
  // route answers the generic 404, indistinguishable from an unknown token.
  // Enable with GATE_ESTIMATE_SERVICE_OPT_OUT=true.
  estimateServiceOptOut: process.env.GATE_ESTIMATE_SERVICE_OPT_OUT === 'true',

  // Priced add-a-service on a sent estimate: the mirror of the opt-out. A
  // never-quoted residential line (pest / lawn / mosquito) joins the plan
  // through the SAME PUT /:token/service-opt-out dryRun-preview → confirm
  // rail and the same canonical recompute (mode 'add'). Requires the opt-out
  // gate too. No customer comms; one activity_log row, no bell. STRICT
  // opt-in in every environment for the same reason as the opt-out: it
  // rewrites monthly_total / annual_total / onetime_total.
  // Enable with GATE_ESTIMATE_SERVICE_ADD=true (with the opt-out gate on).
  estimateServiceAdd: process.env.GATE_ESTIMATE_SERVICE_ADD === 'true',

  // Send-time "lead with one service": when a NEW residential customer's
  // estimate carries EXACTLY two recurring lines (the non-lead one removable),
  // sendEstimateNow parks the second as a staff-authored opt-out event
  // (actor 'staff') before delivery, so the customer receives a single-
  // service quote with the other offered as a one-tap priced add-on on the
  // page. Three-line estimates go out as the full bundle (one atomic park,
  // never a partial mix). Lead = the estimator's first selected recurring service. Existing
  // members, commercial, grouped and proposal estimates are untouched.
  // STRICT opt-in: this changes what gets sent and billed.
  // Enable with GATE_ESTIMATE_LEAD_SERVICE_SEND=true (needs opt-out + add on).
  estimateLeadServiceSend: process.env.GATE_ESTIMATE_LEAD_SERVICE_SEND === 'true',
  // Send requires engine-authoritative pricing (validation audit SEC-002,
  // 2026-09-02). An admin save whose server recompute failed or had no
  // replayable inputs persists the BROWSER preview as a NON-authoritative
  // price (estimates.pricing_authority = CLIENT_FALLBACK — deliberately
  // fail-open so a broken engine never blocks the save). With this gate on,
  // every send of such a row is refused (409 CLIENT_FALLBACK_PRICING) until
  // it is re-saved through the engine, and a revision of a DELIVERED row
  // whose recompute falls back is refused at save time; off, the send goes
  // out and the would-block is logged so the count can be read before the
  // flip. The lead auto-send lane skips these rows regardless of the gate.
  // Enable with GATE_SEND_REQUIRES_SERVER_PRICING=true; unset = revoke.
  sendRequiresServerPricing: process.env.GATE_SEND_REQUIRES_SERVER_PRICING === 'true',
  // Lawn program seasons on the estimate page: under the lawn price card,
  // the program's annual application count and four plain season rows
  // (what each SWFL turf season is for) behind a toggle — education, not a
  // schedule (owner 2026-09-05: no per-season counts, month ranges, or
  // interval line). Gates the /data `lawnCalendar` block ({ programs: {
  // [frequencyKey]: { visitsPerYear, cadence, months } } }, projected by
  // describeLawnProgramCadence). No product, step, or fertilizer names
  // (owner-owned business logic). Dev-open, prod dark.
  // Enable with GATE_ESTIMATE_LAWN_CALENDAR=true.
  estimateLawnCalendar: isProd ? process.env.GATE_ESTIMATE_LAWN_CALENDAR === 'true' : true,

  // Referral prompt on the estimate's accepted / just-accepted screens: the
  // same share module the report page and the portal Refer tab use. Gates
  // the `referral` card in /data + the accept payload and the
  // POST /:token/referral-link tap (enrolls the promoter ON THE TAP, never on
  // a read). Live program settings still decide whether the card shows at
  // all. Dev-open, prod dark. Enable with GATE_ESTIMATE_SUCCESS_REFERRAL=true.
  estimateSuccessReferral: isProd ? process.env.GATE_ESTIMATE_SUCCESS_REFERRAL === 'true' : true,
  // Owner-side "reading it now" bell: when the engagement engine's
  // multi_view_high_intent rule matches on a page open (>= minSessions
  // sittings inside windowHours — the DB-tunable rule params), raise ONE
  // admin notification per estimate per 24h so the owner can call while the
  // estimate is open in front of the customer. NOT a customer message — the
  // customer email job path is untouched. Category estimate_hot_view is
  // silent by default under the admin bell policy (owner ruling 2026-08-28)
  // and the owner enables it under push settings.
  // STRICT opt-in in EVERY environment (a local run must never ring the
  // office). Enable with GATE_ESTIMATE_HOT_VIEW_ALERT=true.
  estimateHotViewAlert: process.env.GATE_ESTIMATE_HOT_VIEW_ALERT === 'true',
  // Customer soft exit on a sent estimate: the "Not what you expected?" sheet.
  // Three outcomes, none of which message the customer: a reason-tagged
  // decline (PUT /:token/decline gains optional reason/competitor/note
  // fields that land in the disposition columns the staff modal already
  // writes), a "still deciding" signal (one activity_log row, no bell), and
  // a change request (POST /:token/change-request parks ONE service_requests
  // row + an admin bell; the estimate is never mutated). Gates the /data
  // `softExit` flag that renders the sheet, the reason fields on /decline,
  // and the change-request route. Dev-open, prod dark.
  // Enable with GATE_ESTIMATE_SOFT_EXIT=true.
  estimateSoftExit: isProd ? process.env.GATE_ESTIMATE_SOFT_EXIT === 'true' : true,

  // The `lawn_area` block on POST /public/quote/calculate — the priced
  // treatable-area basis the website estimator renders as "Priced for N sq
  // ft". Ships DARK because merely EMITTING the field activates the deployed
  // astro widget's source labels, and until astro PR #464 deploys those
  // labels include the banned verify-on-first-visit wording (owner ruling
  // 2026-08-12). Flip AFTER #464 is live on the hub + spokes.
  // Enable with GATE_PUBLIC_QUOTE_LAWN_AREA=true.
  publicQuoteLawnArea: isProd ? process.env.GATE_PUBLIC_QUOTE_LAWN_AREA === 'true' : true,

  // Commercial estimate glass parity — the customer estimate page renders an
  // authored commercial proposal's line items INSIDE the glass layout (plus
  // the commercial copy pack + inclusions) instead of the bare "formal
  // proposal is ready" card, and auto-priced commercial estimates swap their
  // residential inclusions/CTA-micro for the commercial stack. Carried to the
  // client via cta.commercialGlass on /data (fail-closed: absent → today's
  // rendering). Off in prod until verified on a live proposal.
  // Kill switch: unset GATE_ESTIMATE_COMMERCIAL_GLASS.
  estimateCommercialGlass: isProd ? process.env.GATE_ESTIMATE_COMMERCIAL_GLASS === 'true' : true,

  // Commercial scoped one-time auto-pricing — one-time services whose price is
  // already unit-scoped (slab sqft, linear ft, drill points, rooms, entry
  // points, palm counts) price identically on commercial properties instead of
  // collapsing to the generic manual-quote line, carrying commercial line
  // marking (FL nonresidential pest tax flag, no residential discounts) from
  // markCommercialOneTimeLine. Extends owner directive 2026-06-29 ("ALL
  // commercial pricing is auto") to the scoped one-time family; the recurring
  // foam bypass (owner 2026-06-25) is the precedent. Home-size-bracket
  // one-times (one-time pest/lawn, roach programs, rodent trapping, flea)
  // stay manual — they need commercial bases and owner-approved numbers first.
  // WDO also stays manual (footprint-BRACKETED, and public quote can supply a
  // synthetic 2,000 sqft for unmeasured commercial buildings), as does palm
  // injection (recurring program whose legacy-mapper round trip drops the
  // commercial identity) — both codex #3594 P1s.
  // Off everywhere until the owner verifies a priced commercial estimate —
  // pricing gates are env-only in every environment (GATE_UNIT_BAND_PRICING /
  // GATE_BERMUDA_SUPPRESSION convention); the engine re-reads the env at call
  // time via gateEnvValue so tests and gate flips take effect immediately.
  // Kill switch: unset GATE_COMMERCIAL_ONETIME_SCOPED.
  commercialOneTimeScoped: gateEnvValue('GATE_COMMERCIAL_ONETIME_SCOPED'),

  // Browser-rendered estimate PDF — GET /api/estimates/:token/pdf, the admin
  // proposal.pdf download, and the proposal email attachment render the React
  // EstimateProposalDocument (service-report-style document) through the
  // headless-browser pipeline instead of the legacy pdfkit proposal. Every
  // failure path falls back to the pdfkit document so estimate delivery never
  // blocks on a browser. Off in prod until the rendered document is verified.
  // Kill switch: unset GATE_ESTIMATE_DOC_PDF.
  estimateDocPdf: isProd ? process.env.GATE_ESTIMATE_DOC_PDF === 'true' : true,

  // Estimate acceptance terms (owner ruling 2026-08-28): the public estimate
  // renders a one-line authorization + inline "View terms" drawer directly
  // above Accept (same steps, no extra page) and the accept route records
  // the verbatim text/version, time, IP and device on `estimate_acceptances`
  // + stamps estimates.terms_version / customers.accepted_terms_version.
  // Off ⇒ /data payload and the accept flow are byte-identical to today and
  // nothing is recorded (nothing was shown). Counsel reviews the copy once
  // before this flips. Kill switch: unset GATE_ESTIMATE_ACCEPTANCE_TERMS.
  //
  // Rollout is two-step on the same variable: `true` shows + records, and
  // an accept that carries NO attestation (a tab loaded before the flip —
  // legacy SSR page or the previous bundle) still accepts unrecorded, so no
  // live tokenized flow is stranded; `required` (flip once every open tab
  // has had time to reload) refuses an unattested accept with the
  // reloadable 409 too, so every acceptance under the gate has its record.
  estimateAcceptanceTerms: ['true', 'required'].includes(process.env.GATE_ESTIMATE_ACCEPTANCE_TERMS),
  estimateAcceptanceTermsRequired: process.env.GATE_ESTIMATE_ACCEPTANCE_TERMS === 'required',

  // The liquid-glass theme gates (GATE_ESTIMATE_GLASS / GATE_EMAIL_GLASS /
  // GATE_REPORT_GLASS / GATE_PORTAL_GLASS) were retired once glass shipped to
  // 100% of customers. Glass is now the unconditional theme on every customer
  // surface — estimate, service/lawn report, portal shell, login, booking,
  // receipts, pay, statements, and emails — so the flags and their pre-glass
  // code paths have been removed. (The estimate glass COPY packs still roll out
  // per service category; that is a content flag carried in the /data payload,
  // not a theme gate.)

  // Waves AI schedule search on the wavespestcontrol.com /book page (astro
  // island). Exposed to the marketing site via GET /api/booking/config as
  // `ai_search`, so the island fails closed: the search bar only renders when
  // the portal affirms the flag. The portal's own /book page and the estimate
  // page are NOT behind this gate — their bars are already live.
  // Kill switch: unset GATE_BOOK_AI_SEARCH.
  bookAiSearch: isProd ? process.env.GATE_BOOK_AI_SEARCH === 'true' : true,

  // Recipient double opt-in (#2948 follow-up): newly added on-location
  // contacts get a "Reply YES" confirmation text, and appointment texts to
  // them hold until confirmed. Double-dark: this gate AND the
  // recipient_optin_request sms_templates row (seeded inactive) must both
  // be on before anything sends. Pre-existing contacts are grandfathered
  // (no recipient_optin row = allowed). Kill switch: unset
  // GATE_RECIPIENT_DOUBLE_OPTIN.
  recipientDoubleOptin: isProd ? process.env.GATE_RECIPIENT_DOUBLE_OPTIN === 'true' : true,

  // Multi-service public booking (owner-authorized 2026-07-23): /book can
  // select 2-3 services in one visit — composite service key through the
  // same signed-offer path, summed duration, joined label. Exposed to the
  // client via GET /api/booking/config as `multi_service` (fail-closed:
  // the selector only renders when the portal affirms; the server also
  // refuses composite keys while the gate is off). Kill switch: unset
  // GATE_MULTI_SERVICE_BOOKING.
  multiServiceBooking: isProd ? process.env.GATE_MULTI_SERVICE_BOOKING === 'true' : true,

  // Auto-Dispatch — autonomous daily optimizer for FUTURE recurring visits.
  // Master gate for the cron job (double-gated behind cronJobs). Off by default
  // in prod until the owner validates dry-run output; even when ON it stays in
  // dry_run mode until AUTO_DISPATCH_MODE=apply is set. The admin API + manual
  // run endpoints are unaffected by this gate (they're requireAdmin-only).
  autoDispatch: isProd ? process.env.GATE_AUTO_DISPATCH === 'true' : true,

  // ROUTE-TIERS — tiered day-move radius for recurring maintenance visits
  // inside the auto-dispatch run (≥14d: ±5 days; 7–13d: ±3; <7d: no day-moves;
  // <72h or 72h-reminder-sent: frozen), plus the ±5-day cumulative drift
  // budget, the ≥5-days-out destination floor, and the reminder-sent freeze.
  // OFF = auto-dispatch's legacy flat 14-day lock, byte for byte. Read at CALL
  // time via gateEnvValue (same pattern and rationale as
  // GATE_DRIVE_TIME_CALIBRATION: it moves the numbers/windows scheduling
  // decisions are made with, so the flip is a deliberate act in EVERY
  // environment — never an ambient dev default — and needs no redeploy).
  // Kill switch: unset GATE_ROUTE_TIERS.
  routeTiers: gateEnvValue('GATE_ROUTE_TIERS'),

  // ROUTE-TIERS nightly intra-day reorder pass (tier 3 band, 72h–7d): 4:20am
  // cron that rewrites route_order per tech-day when savings clear the floor.
  // Separate kill switch from routeTiers — either half can run alone. Explicit
  // opt-in in every environment (it writes scheduled_services.route_order and
  // can call the Google Routes API, so it must never auto-run in dev).
  // Double-gated behind cronJobs. Kill switch: unset GATE_ROUTE_REORDER.
  routeReorder: gateEnvValue('GATE_ROUTE_REORDER'),

  // WINDOW-FIT FALLBACK inside the nightly reorder pass: when Google's
  // distance-optimal order fails the window chronology/feasibility guards,
  // compute the best LEGAL order in-process (backbone of promised windows +
  // exhaustive/greedy interleaving, same 805 m floor, same fenced write)
  // instead of skipping the day. Nested inside GATE_ROUTE_REORDER — it only
  // ever runs from that pass. Explicit opt-in in every environment; OFF =
  // the pre-fallback skip, byte for byte. Read at CALL time via
  // gateEnvValue (flip needs no redeploy). Kill switch: unset
  // GATE_ROUTE_REORDER_WINDOW_FIT.
  routeReorderWindowFit: gateEnvValue('GATE_ROUTE_REORDER_WINDOW_FIT'),

  // Drive-Time Calibration — swaps the straight-line drive-time approximation
  // (haversine × 1.4 road factor @ 30 mph) for a two-term model fitted against
  // real trips: a fixed per-leg overhead plus a per-mile rate. Purely an
  // estimator change — no external calls, no new data, no customer-facing
  // surface of its own; it moves the numbers auto-dispatch and the find-time
  // scorer rank slots with. Opt-in everywhere so the shift in slot ordering is
  // a deliberate flip. Off → the legacy constants apply unchanged.
  // NOTE: consumers read this through gateEnvValue() at CALL time rather than
  // this baked value, so a flip takes effect without a redeploy. Parsed with
  // the SAME helper here so the registry and the startup log can never disagree
  // with the scheduler — with a bare === 'true' a value of `1`/`on`/`TRUE`
  // would calibrate the estimator while logGateStatus reported it disabled.
  driveTimeCalibration: gateEnvValue('GATE_DRIVE_TIME_CALIBRATION'),

  // Slot Travel Gap — the customer-facing pickers (estimate, one-tap, /book,
  // reschedule, re-service, voice, rain-out, AI assistant) and every commit
  // gate behind them require modeled drive time + SLOT_TRAVEL_BUFFER_MINUTES
  // (default 15) between a candidate window and its neighbouring stops. Off →
  // pure half-open overlap, byte for byte (back-to-back windows across a
  // 30-minute drive were offered and reserved — 2026-09-03 field report).
  // Consumers read gateEnvValue at CALL time (services/scheduling/travel-gap.js)
  // so a flip needs no redeploy; kill switch: unset GATE_SLOT_TRAVEL_GAP.
  slotTravelGap: gateEnvValue('GATE_SLOT_TRAVEL_GAP'),

  // JOB CARD tab in the Service Protocol drawer (Tech Resource Drawer PR 2):
  // one GET assembles the customer strip, a 1–3 sentence paragraph written
  // from portal fields (FAST tier, deterministic template fallback, cached
  // per visit), a per-product spray check against NWS hourly at the
  // property, and the 110/1-gal tank mix helper. Read-only apart from the
  // paragraph cache; no comms. Consumers read gateEnvValue at CALL time
  // (services/job-card.js) so a flip needs no redeploy; kill switch: unset
  // GATE_JOB_CARD — the endpoint answers {enabled:false} and the tab hides.
  jobCard: gateEnvValue('GATE_JOB_CARD'),
  // Current-visit procedure and readable SOP sheet inside the Job Card drawer.
  // Uses the same visit resolver; unset restores the legacy protocol tabs.
  protocolSop: gateEnvValue('GATE_PROTOCOL_SOP'),
  // The wrapped-van scene on the appointment page + booking step 4 (owner
  // 2026-09-03). Rides the existing page payloads (appointment `vanScene`,
  // booking config `van_scene`) — no extra client fetch. Kill switch: unset
  // GATE_VAN_SCENE.
  vanScene: isProd ? process.env.GATE_VAN_SCENE === 'true' : true,

  // Vision Delta Scoring — one VISION-tier call per treatment outcome's best
  // before/after photo pair (server/services/vision-delta.js); the verdict
  // feeds the agronomic wiki as photo-verified visual change. Paid vision
  // per pair, so explicit opt-in in EVERY environment. Off → the sweep
  // returns {skipped:'gated'} before any DB read and the whole lane is
  // inert (the 3:40 ET cron leg adds no gate of its own — the check inside
  // sweepUnscoredOutcomes is the single source of truth). Kill switch:
  // unset or any non-truthy value.
  // NOTE: the sweep parses this at CALL time via gateEnvValue() (tests flip
  // the env at runtime, and a flip must not depend on this module's load
  // moment) — registered with the SAME parser so this registry entry,
  // logGateStatus, and the sweep can never disagree.
  visionDelta: gateEnvValue('GATE_VISION_DELTA'),

  // Supplies auto-reorder sweep (6:10 ET daily): a product with
  // auto_reorder_enabled at/below its low_stock_threshold gets ONE open
  // product_restock_requests row (source auto_reorder) + one deduped office
  // bell. Off → the sweep returns {skipped:'gated'} before any DB read.
  // CALL-time gateEnvValue in the sweep (same parser as this entry); kill
  // switch = unset. No order is ever placed by this gate — that is PR 2's
  // GATE_AUTO_ORDER.
  autoReorder: gateEnvValue('GATE_AUTO_REORDER'),

  // Vendor order dispatch (runs right after the 6:10 ET reorder sweep): an
  // open auto_reorder request whose vendor has an adapter is ORDERED —
  // Sticker Mule reorder API, SiteOne browser bot — under the env spend caps
  // (AUTO_ORDER_MAX_PER_ORDER_CENTS + AUTO_ORDER_MAX_MONTHLY_CENTS, both
  // required). Master gate AND the per-vendor gate must be true; all three
  // are read at CALL time (gateEnvValue), kill = unset any one. Revoke a
  // placed order: ops/agents/auto-order-revoke.js. Off → the sweep bells
  // "order manually" exactly as before.
  autoOrder: gateEnvValue('GATE_AUTO_ORDER'),
  autoOrderStickerMule: gateEnvValue('GATE_AUTO_ORDER_STICKERMULE'),
  autoOrderSiteOne: gateEnvValue('GATE_AUTO_ORDER_SITEONE'),

  // Auto property-lookup on call-pipeline property creation — each NEWLY
  // created customer_properties row from a call fires one full property
  // lookup (county + LLM trio + satellite vision: real per-call spend) and
  // fill-only patches lat/lng/property_type. Off → enqueue is a no-op and
  // the run returns {skipped:'gated'} (CALL-time gateEnvValue, same
  // contract as visionDelta). Kill switch: unset.
  callPropertyLookup: gateEnvValue('GATE_CALL_PROPERTY_LOOKUP'),

  // Nightly property-enrichment backfill — up to PROPERTY_BACKFILL_BATCH
  // (default 20) existing NULL customer_properties rows of real customers
  // get the same lookup + fill-only patch per night (~1,000 rows are NULL
  // today, so ~2 months at the default cap). Independent of the per-call
  // gate above so the two lanes flip separately. Real nightly LLM spend —
  // explicit opt-in in EVERY environment. Kill switch: unset.
  propertyEnrichBackfill: gateEnvValue('GATE_PROPERTY_ENRICH_BACKFILL'),

  // Weekly Manatee pool-permit sync (ACA "Pool Permits (CSV)" report →
  // pool_permit_records). Closes the closed-permit blind window between the
  // open-permits GIS layer and the annual assessment roll. Off → the sync
  // returns {skipped:'gated'} before any fetch or DB read; the read path
  // (county-permits.js) is ungated — it just sees an empty table. Same
  // CALL-time gateEnvValue contract as visionDelta. Kill switch: unset.
  permitSync: gateEnvValue('GATE_PERMIT_SYNC'),

  // Weekly autonomous vendor price scan -> stages a price-match draft for the
  // SiteOne rep (never auto-sends; a human reviews + sends from /admin/price-match).
  // Explicit opt-in in ALL envs (it hits external vendor sites via a headless
  // browser, so it must never auto-run in dev). The admin "run now" endpoint is
  // requireAdmin-only and unaffected by this gate. Double-gated behind cronJobs.
  priceScanWeekly: process.env.GATE_PRICE_SCAN === 'true',

  // Card-Present Surcharge (Tap to Pay) — adds the 2.9% credit-card surcharge to
  // in-person card_present charges, mirroring the online flow. Card-present
  // funding is only known AFTER the tap, so the PI is minted at base and raised
  // to base+surcharge between collect and confirm — and only when the card reads
  // as credit; debit, prepaid, and unknown funding stay at base (never
  // over-surcharged). Real money on real customer cards, depends on Stripe's
  // preview surcharge API, and needs on-device disclosure + a real-card field
  // test, so it is explicit opt-in in EVERY environment and ships dormant: when
  // off, /apply-surcharge is a no-op and the charge collects base-only exactly
  // like today.
  terminalSurcharge: process.env.GATE_TERMINAL_SURCHARGE === 'true',

  // Auto-Apply Account Credit — when an invoice is created, automatically draw
  // down the customer's account_credits (e.g. the $25 referral reward) against
  // its amount due via credit_applied, so the reward silently lowers the next
  // bill. Money movement on real invoices, so off by default in prod until
  // verified; the Stripe/Terminal charge paths bill total − credit_applied and
  // the void paths restore the credit, so partial application is safe.
  autoApplyAccountCredit: isProd ? process.env.GATE_AUTO_APPLY_ACCOUNT_CREDIT === 'true' : true,

  // Divert Micro-deposit Dunning — when an unpaid invoice's only blocker is an
  // unfinished ACH micro-deposit verification (its PaymentIntent is stuck in
  // requires_action / verify_with_microdeposits), the customer isn't refusing to
  // pay — they need to confirm two small bank deposits. Instead of the misleading
  // "your invoice is overdue, pay now" dunning, the late-payment + per-invoice
  // follow-up sweeps send a verification re-nudge on the same cadence. Changes
  // customer-facing messaging, so off by default in prod until verified.
  divertMicrodepositDunning: isProd ? process.env.GATE_MICRODEPOSIT_DUNNING_DIVERSION === 'true' : true,

  // Weekly Irrigation Recommendation Email — Monday-morning "cut back / add
  // water" email to lawn-care customers who entered weekly irrigation inches
  // in the portal, based on last week's rainfall at their coordinates vs. the
  // seasonal target. Customer-facing auto-send, so explicit opt-in in EVERY
  // environment (off in dev/preview too) — a preview env with real SendGrid
  // creds + cronJobs on must NOT email real customers. Until the gate is on,
  // the Monday sweep only shadow-logs candidate counts and never sends.
  irrigationWeeklyEmail: process.env.GATE_IRRIGATION_WEEKLY_EMAIL === 'true',
  // Monday irrigation email + lawn report: replace the static "ease up / add
  // a few minutes" callouts with a concrete legal-first watering plan
  // (minutes per turf zone, hold, conditional-on-rain) from
  // @waves/irrigation-runtime buildWeekPlan. Off = today's copy exactly.
  // Kill = unset GATE_IRRIGATION_WEEK_PLAN.
  irrigationWeekPlan: process.env.GATE_IRRIGATION_WEEK_PLAN === 'true',

  // Existing-customer campaign drafts (V1) — the seasonal-reactivation cron and
  // the daily upsell generator write message_drafts status='pending' rows
  // (campaign_type reactivation/upsell) for OWNER APPROVAL in the drafts queue.
  // This lane NEVER auto-sends: the only send path is the operator's explicit
  // approve/revise click on /api/admin/drafts, which runs the full messaging
  // policy chain (marketing consent, seasonal_tips/sms_enabled prefs).
  // With the gate OFF the generators only shadow-log candidate counts —
  // zero drafts, zero sends. Explicit opt-in in EVERY environment (off in dev
  // too) so campaign drafts never accumulate silently in a preview/dev queue.
  campaignDrafts: process.env.GATE_CAMPAIGN_DRAFTS === 'true',

  // WDO Report Payment Hold — "pay before you get the report". Arms the
  // hold option on the WDO send-with-invoice flow: the customer gets the
  // invoice + pay link only, and the FDACS-13645 report is emailed
  // automatically once the invoice settles (release sweep). A money-path +
  // customer-facing delivery change, so it FAILS CLOSED (explicit opt-in in
  // EVERY environment). The gate governs CREATING new holds only — releases
  // of already-held reports (payment sweep, manual send, public 402 gate)
  // always run, so flipping it off can never strand a held report.
  wdoReportPaymentHold: process.env.GATE_WDO_REPORT_PAYMENT_HOLD === 'true',

  // Prepaid Invoice Receipt — when an operator marks a single visit prepaid
  // (cash / check / Zelle / card-over-phone) with "Email a paid receipt"
  // checked, mint the visit's invoice, apply the prepaid amount as payment, and
  // — only if it lands fully paid — send the customer a branded paid receipt
  // (email + SMS, via the same idempotent pipeline as /admin/invoices/:id/
  // send-receipt). Touches a real customer email/SMS AND mints a paid invoice,
  // so it ships dark in prod until verified. OFF means the Mark-prepaid flow
  // behaves exactly as before: it records the prepayment and nothing is minted
  // or sent. The mint/credit/send building blocks (Charge-now, send-receipt)
  // stay individually available regardless of this gate.
  prepaidInvoiceReceipt: isProd ? process.env.GATE_PREPAID_INVOICE === 'true' : true,

  // Zelle payment-notice reconciler — the Gmail sync recognises Capital One
  // "Someone sent you money with Zelle" notices (forwarded from the owner's
  // personal inbox to contact@), matches the payer + exact amount to ONE open
  // self-pay invoice and settles it through services/invoice-manual-payment.js
  // — the operator's Add-payment path — INCLUDING the paid receipt (email +
  // SMS). OWNER RULING 2026-09-02: an exact single match may mark the invoice
  // paid and send the receipt with no human in the loop; anything else parks
  // on the Invoices page for one-click Apply / Ignore. Money + a customer
  // comm, so it ships dark in prod. OFF = the hook returns before any DB
  // read and the email flows through normal classification exactly as
  // today; the parked-notice admin routes stay live so history remains
  // actionable after a kill. Read at CALL time (gateEnvValue) so unsetting
  // GATE_ZELLE_NOTICE_RECONCILE on Railway is a live kill switch — the
  // consumer (services/zelle-notice-reconciler.js) and logGateStatus must
  // keep using this same parser.
  zelleNoticeReconcile: isProd ? gateEnvValue('GATE_ZELLE_NOTICE_RECONCILE') : process.env.GATE_ZELLE_NOTICE_RECONCILE !== 'false',

  // Treatment Zone Mapper — tech traces the treated perimeter over a satellite
  // photo of the property; the traced path + snapshot replace the generic
  // schematic on the customer's service report. Gates BOTH the tech capture
  // routes (/api/tech/services/:id/treatment-zone) and the report payload's
  // treatmentMap.traced block. Dev-open for local testing; dark in prod until
  // Adam flips GATE_TREATMENT_ZONE_MAP=true. Kill switch: unset the var —
  // reports instantly fall back to the schematic; stored rows are untouched.
  treatmentZoneMap: isProd ? process.env.GATE_TREATMENT_ZONE_MAP === 'true' : true,

  // WDO report attention sweep — admin bell for WDO reports stalled before
  // send (uncompleted inspections, signed-but-unsent drafts, stuck holds).
  // Admin-notification-only; no customer contact.
  wdoReportAttention: isProd ? process.env.GATE_WDO_REPORT_ATTENTION === 'true' : true,

  // Stale-visit sweep — nightly admin bell for past-dated appointments still
  // sitting in an open status (pending/confirmed/en_route/on_site).
  // Detection-only: never mutates the rows, no customer contact.
  staleVisitSweep: isProd ? process.env.GATE_STALE_VISIT_SWEEP === 'true' : true,
  // Daily 6:55 ET lead-to-cash invariants sweep (services/lead-to-cash-
  // invariants.js): a read-only registry over existing detectors (churned
  // accounts with live plan state, WaveGuard field drift, recurring-schedule
  // anomalies, stale open visits, converted-but-open estimates, completion-
  // lane catalog coverage, failed closeout facts). Emails contact@ ONLY when
  // a detector finds something or cannot run. Dark everywhere until flipped
  // (it would email from every dev boot otherwise); kill = unset.
  leadToCashInvariantSweep: process.env.GATE_LEAD_TO_CASH_SWEEP === 'true',

  // Customer rain chip — attaches a "chance of rain" percentage (NWS daily
  // outlook) to the customer portal's visit-tracker payload so the tracker
  // can show a "42% chance of rain — your tech may adjust timing" caption.
  // Display-only: no rescheduling, no customer sends. Customer-facing
  // surface change, so opt-in in EVERY environment. Kill switch: unset (or
  // any non-'true' value) — the field is omitted from the payload and the
  // tracker reverts to today's forecast-string behavior.
  customerRainChip: process.env.GATE_CUSTOMER_RAIN_CHIP === 'true',

  // Booking rain chips — attaches the NWS daily rain chance (office-point
  // outlook) to the customer booking payloads: the estimate slot picker
  // (React + legacy server-rendered), the /book funnel, and the public
  // rescheduler (which shares /book's availability builder). The UIs show a
  // soft "☔ 42% rain" chip on ≥40% days. Display-only decoration: the
  // attach is bounded + fail-open, and clients render only when the field
  // is present — gate off keeps every payload byte-identical to today.
  // Customer-facing surface change, so opt-in in EVERY environment. Kill
  // switch: unset (or any non-'true' value) — the field is omitted from
  // every payload and the chips disappear.
  bookingRainChips: process.env.GATE_BOOKING_RAIN_CHIPS === 'true',

  // Admin bell policy — the shared admin bell rings ONLY for new leads,
  // inbound SMS, voicemail callbacks, accepted estimates, and money failures
  // (payment failures, billing exceptions, disputes, refund failures, PCI
  // events) plus twilio_failure; everything else is silenced at the
  // NotificationService chokepoint with a per-category owner override in
  // Settings → Notifications, and the live dashboard-alert overlay stops
  // merging into the bell (the dashboard banner is untouched). Changes what
  // the owner SEES for operational exceptions, so explicit opt-in in EVERY
  // environment (dev too — a dev bell that silently drops categories would
  // mask notification regressions during testing). Kill switch: unset (or
  // any non-'true' value) — every insert and the live overlay revert to
  // today's behavior byte-for-byte; override rows stay inert in
  // notification_preferences.
  adminBellPolicy: process.env.GATE_ADMIN_BELL_POLICY === 'true',

  // WaveGuard auto-tier from recurring coverage (owner directive 2026-07-28),
  // BOTH directions: a customer with upcoming recurring qualifying services
  // on the schedule is stamped a tier automatically (1 family = Bronze,
  // 2 = Silver, 3 = Gold, 4+ = Platinum) at series-seeding time and via a
  // nightly reconcile — and a label-only tiered customer is realigned to
  // their upcoming recurring coverage by the same nightly job: raised,
  // lowered, or cleared back to No Plan when it lapses (paying members and
  // paid billing lanes are never auto-realigned; the cancellation/
  // offboarding flow owns their tier). An auto-WRITER on
  // customer records that also changes future membership pricing
  // eligibility, so opt-in in EVERY environment. It writes waveguard_tier
  // ONLY (never monthly_rate / member_since / billing fields) and sends no
  // customer communications. Kill switch: unset or any non-'true' value —
  // booking flows and the nightly job revert to the old members-only
  // re-alignment.
  autoWaveguardTierEnroll: process.env.GATE_AUTO_WAVEGUARD_TIER === 'true',

  // Inspection fee credited toward a service booked within the promised
  // window (owner-approved 2026-08-02). Two halves, one gate: the tech
  // closeout checkbox that RECORDS the promise, and the redemption that
  // MINTS it into account credit when the customer books. Money surface —
  // fail-closed ==='true' in EVERY environment. Gate off: no offer row is
  // written, the receipt carries no credit line, and any offer recorded
  // while the gate was on stays dormant (redemption checks the gate too),
  // so flipping it off mid-window strands nothing — it only stops new
  // promises and pauses redemption. Kill switch: unset or any non-'true'
  // value.
  inspectionCredit: process.env.GATE_INSPECTION_CREDIT === 'true',

  // Completion-path comms guard (2026-08-07): when a dispatch /complete
  // lands while the customer has a pending reschedule/away flag (#3232's
  // comms_guards agent_decisions rows) or an unanswered inbound text, the
  // post-commit hook surfaces one admin exception — bell notification +
  // dispatch_alerts card, deduped per visit. Detection/surface ONLY: it
  // NEVER blocks completion or invoicing and sends no customer
  // communications. Opt-in in EVERY environment (payerStatements pattern):
  // dark until the owner flips it after eyeballing the first flagged
  // completion. Kill switch: unset or any non-'true' value — completions
  // behave byte-identically to today.
  completionCommsGuard: process.env.GATE_COMPLETION_COMMS_GUARD === 'true',

  // Real-time reschedule/away-intent flag lane (flagger bell/push + the
  // durable agent_decisions flag rows). Owner ruling 2026-08-15: the bells
  // fired on consent-shaped replies ("I will not be there but okay") and
  // tapbacks — silence the whole lane. Opt-in in EVERY environment; the
  // daily watcher keeps its own RESCHEDULE_INTENT_WATCHER_DISABLED switch.
  // Revert: GATE_RESCHEDULE_INTENT_FLAGS=true restores the lane unchanged.
  rescheduleIntentFlags: process.env.GATE_RESCHEDULE_INTENT_FLAGS === 'true',

  // Auto-apply customer-stated contact corrections (owner ruling
  // 2026-08-15, the 08-13 SMS-correction incident): name/email/address ONLY, never
  // phone; linked customers only; compare-and-set writes with an
  // agent_decisions audit row per field and one owner FYI bell per batch.
  // Sources: inbound SMS (FAST-tier extraction behind a regex prefilter)
  // and processed call recordings (consumes the already-staged
  // customer_field_candidates rows — no second extraction). Kill switch:
  // unset or any non-'true' value — no record is ever touched.
  contactCorrection: process.env.GATE_CONTACT_CORRECTION === 'true',

  // WaveGuard tier extension to existing services (owner decision
  // 2026-08-10, reversing the 2026-08-05 review-bell-only ruling): a
  // tier-RAISING estimate for a linked member lists their current
  // qualifying services at the combined tier's extra percentage points off
  // the contracted per-visit price, and accepting applies exactly that
  // frozen plan — upcoming visit rows repriced, monthly-lane slices
  // adjusted via the plan-rate ledger where attributable, annual-prepaid
  // terms credited the difference instead of being repriced. The gate is
  // checked at THREE points that silence together (codex #3338 r1):
  // snapshot population (no new estimate advertises the extension), the
  // public projection (a plan frozen while the gate was on stops
  // DISPLAYING the moment it flips off), and the converter apply
  // (inspectionCredit's dormant-while-off pattern) — so display and
  // billing can never disagree across a flip in either direction. Money
  // surface — fail-closed ==='true' in EVERY environment. Kill switch:
  // unset or any non-'true' value — estimates and accepts revert to the
  // 2026-08-05 review-bell behavior.
  waveguardExtendExisting: process.env.GATE_WAVEGUARD_EXTEND_EXISTING === 'true',

  // Bank Import (2026-08-13): statement-CSV staging + expense reconciliation
  // under /admin/tax. Staff-only and read-mostly, but OFF in every
  // environment until Adam flips it — routes read GATE_BANK_IMPORT through
  // gateEnvValue() at call time so a flip needs no redeploy. The registry
  // entry uses the SAME parser so the startup gate report can never
  // disagree with request-time enforcement ('1'/'on' variants included).
  bankImport: gateEnvValue('GATE_BANK_IMPORT'),

  // Stops-away tracker count (2026-08-14): "N stops away" on the portal
  // ServiceTracker + public /track page. Read-only, fires no comms; count
  // is bare (never other customers' info), capped at 3, clamped monotonic
  // per display date (owner rulings in PR). OFF everywhere until Adam
  // flips GATE_STOPS_AWAY — read at call time via gateEnvValue so the
  // flip needs no redeploy. Kill switch: unset the var.
  stopsAway: gateEnvValue('GATE_STOPS_AWAY'),

  // Pest stranded-activation recovery (owner ruling 2026-08-27): the value is
  // an ISO timestamp EPOCH, not a boolean — consumers read it at CALL time via
  // gateEnvTimestamp() (flip needs no redeploy); this entry mirrors it as a
  // boolean for status/inspection. Kill switch: unset.
  pestStrandedRecovery: gateEnvTimestamp('GATE_PEST_STRANDED_RECOVERY') != null,

  // Best-time hints (2026-08-14): advisory "Best times this day" chips on
  // the admin date/time pickers (edit, reschedule, create), ranked by the
  // existing find-time drive-detour engine. Warn-only by design — picking a
  // chip only fills the time fields; no save is ever blocked or disabled on
  // this data. OFF in every environment until Adam flips it; the find-time
  // route reads the env through gateEnvValue() at call time (hint requests
  // only — the ungated Find-a-Time button never sends `hint`) so a flip
  // needs no redeploy. Kill switch: unset — hint requests answer gated:true
  // with no slots and every picker renders exactly as today.
  bestTimeHints: gateEnvValue('GATE_BEST_TIME_HINTS'),

  // Call property-role classification (2026-08-15): the extraction classifies
  // each property a call discusses (occupancy + which one is the caller's
  // primary residence); the pipeline fills only-unknown occupancies directly
  // and parks everything else as a 'property_role_confirm' Needs Review card
  // the office applies with one click — never a silent primary flip or
  // occupancy overwrite (a 2026-08-13 multi-property call left a
  // portfolio inverted). OFF everywhere until Adam flips it; the processor
  // reads the env at call time (gateEnvValue) so a flip needs no redeploy.
  // Co-req: GATE_CUSTOMER_PROPERTIES (the staging block lives inside the
  // multi-property persistence path — no property rows, nothing to label).
  // While dark: extraction still captures the new fields (capture-only);
  // nothing fills, parks, or renders. Kill switch: unset the var.
  callPropertyRole: gateEnvValue('GATE_CALL_PROPERTY_ROLE'),

  // "Traced spray map or nothing" across the whole pest line (owner
  // 2026-08-31, generalizing the #3631 callback rule): with the gate on, a
  // pest report with no technician trace renders NO generated schematic —
  // web rings diagram, PDF drawn map, and /map.svg all suppress; the
  // '-ton1' PDF key suffix re-renders cached pest documents once.
  // Consumers re-read the env at call time via
  // pestTraceOrNothingGateOn() (pest-report-v2.js → gateEnvValue), so a
  // flip needs no redeploy. Kill switch: unset GATE_PEST_TRACE_OR_NOTHING.
  pestTraceOrNothing: gateEnvValue('GATE_PEST_TRACE_OR_NOTHING'),

  // Re-service (callback) report copy (2026-08-30): the customer report for
  // a callback visit keys off `service_records.is_callback` instead of the
  // editable display name, drops below the honest V2 status branches, splits
  // lawn vs pest wording, and prints the "$0 — included with WaveGuard" line
  // the tech completion panel already promises — on the web hero AND the PDF.
  // OFF everywhere until Adam flips it (exact 'true'); reservice-report.js
  // reads the env at call time so a flip needs no redeploy — cached PDFs
  // re-render via the -rs1 key component. This entry is the status/log
  // listing. Kill switch: unset the var (payload keeps `isCallback` as data).
  reserviceReportCopy: process.env.GATE_RESERVICE_REPORT_COPY === 'true',

  // Server-persisted Intelligence Bar threads (owner-ratified 2026-08-31):
  // admin conversations survive refresh/route changes; the palette resumes
  // the latest thread. OFF everywhere until Adam flips it (explicit opt-in —
  // it persists operator conversations to the DB). Kill switch: unset — the
  // exact pre-thread ephemeral behavior returns and the /threads endpoints
  // 404. Read at CALL time via gateEnvValue in
  // services/intelligence-bar/threads.js (flip needs no redeploy); this
  // entry is the status/log listing — same parser as the request path so
  // the listing can never disagree with what /query actually does.
  // (gateEnvValue is a hoisted function declaration, safe to call here.)
  ibThreads: gateEnvValue('GATE_IB_THREADS'),

  // Tips from your tech (scope + owner decisions 2026-09-01): the completion
  // screen's searchable tip picker (replacing the free-text Observations /
  // Recommendations boxes) and, in a later PR, the quoted note on the live
  // service report. OFF unless set ('1' / 'true' / 'on'), in dev AND prod — the
  // gate-off answer of GET /admin/dispatch/:serviceId/tech-tips is
  // { available: false } and the completion screen keeps today's textareas.
  // Kill switch: unset. Read at CALL time so a flip needs no redeploy.
  techTips: gateEnvValue('GATE_TECH_TIPS'),

  // Ops queue (2026-09-02): the Agents hub "Queue" tab — a read-only
  // projection of every long-running lane's persisted state (pending /
  // parked / failed) in one place. No actions live there. OFF unless set,
  // dev AND prod — GET /api/admin/agents/control/hub (features.queue) answers
  // features.queue false, /queue is 404, and the tab is not rendered.
  // Kill switch: unset. Read at CALL time so a flip needs no redeploy.
  adminOpsQueue: gateEnvValue('GATE_ADMIN_OPS_QUEUE'),

  // External agent watchdog — routes/integrations-watchdog-worker.js +
  // services/agent-watchdog-liveness.js. ON: the hermes_watchdog key can read
  // GET /api/integrations/watchdog-worker/status (job_health classes, ops-queue
  // COUNTS, link-worker lease state — never item titles), and the 23-min
  // liveness cron rings one bell per ET day when the watchdog stops polling.
  // OFF (default, dev AND prod): /status answers 404 { error: 'watchdog lane
  // disabled' } and the cron is a no-op. Kill switch: unset. This entry is for
  // logGateStatus; both readers use gateEnvValue('GATE_HERMES_WATCHDOG') at
  // CALL time, so a flip needs no redeploy. Still requires GATE_HERMES_WORKER
  // (the shared link-worker auth gate) to reach the router at all.
  hermesWatchdog: gateEnvValue('GATE_HERMES_WATCHDOG'),
  // Intelligence Bar tool activity (2026-09-02): POST /query answers carry a
  // `toolActivity` list — one operator-facing line per tool call the exchange
  // ran (label, done / error / proposed, duration, round) — and the ⌘K
  // palette renders it above the answer so a confirmation card is read next
  // to what the bar actually checked. Labels only: never tool inputs, never
  // results, never the model's reasoning. OFF unless set, dev AND prod — off
  // = the response is byte-identical to today. Kill switch: unset. Read at
  // CALL time so a flip needs no redeploy.
  ibToolActivity: gateEnvValue('GATE_IB_TOOL_ACTIVITY'),
  // Audio-synced call transcript (admin call log). When on, calls whose
  // call_log.transcript_structured carries diarized segments render them as
  // a clickable list that follows recording playback; click a line to seek.
  // OFF unless set, dev AND prod — GET /api/ai/admin/calls reports
  // transcript_sync_enabled:false and the tab keeps the plain-text
  // transcript. Read-only, no comms, no writes. Kill switch: unset. Read at
  // CALL time so a flip needs no redeploy.
  callTranscriptSync: gateEnvValue('GATE_CALL_TRANSCRIPT_SYNC'),
  // Field dictation upload (2026-09-02): the completion-notes mic falls back
  // to MediaRecorder + server transcription (OpenAI, same transcriber and
  // PAN scrub as call recordings) when SpeechRecognition is unavailable.
  // OFF unless set, dev AND prod — GET /api/tech/services/:id/dictation/
  // availability answers { available: false } and the client keeps today's
  // behavior (no mic without SpeechRecognition). Nothing is persisted: the
  // transcript goes straight into the tech's notes box. Kill switch: unset.
  // Read at CALL time so a flip needs no redeploy.
  techDictationUpload: gateEnvValue('GATE_TECH_DICTATION_UPLOAD'),

  // Agent Activity feed — the Activity tab in /admin/agents: one read-only
  // timeline built from autonomous_runs, content_email_approvals,
  // message_drafts and job_health (server/services/agent-activity.js). OFF
  // unless set ('1' / 'true' / 'on'), in dev AND prod — gate-off answer of
  // GET /admin/agents/activity is { available: false } and the tab shows a
  // "not enabled" note. Kill switch: unset. This entry is for
  // logGateStatus; the service reads gateEnvValue('GATE_AGENT_ACTIVITY')
  // at CALL time (the techTips idiom), so a flip needs no redeploy.
  agentActivity: gateEnvValue('GATE_AGENT_ACTIVITY'),

  // LLM call ledger — services/llm-dispatch-metrics.js recordCall. ON: every
  // provider call through the llm adapters (call.js, deep.js) and every
  // Managed Agents session writes one row_kind=call / session row to
  // llm_dispatch_log with token usage, latency, the model actually served
  // and the ambient agent-control lane / run / step ids. OFF (default, dev
  // AND prod): no row, no DB touch — the chain rows GATE_LLM_DISPATCH_METRICS
  // governs are unaffected either way. Kill switch: unset. This entry is for
  // logGateStatus; the recorder reads gateEnvValue at CALL time.
  llmCallLedger: gateEnvValue('GATE_LLM_CALL_LEDGER'),

  // LLM call traces — services/llm-dispatch-metrics.js recordTrace. ON: for
  // lanes whose agent-control runtime policy sets trace: true, the REDACTED
  // system / prompt / response bodies (pii-redactor, 8 KB cap each) are kept
  // in llm_call_traces for 7 days, keyed to the call row — so it needs the
  // ledger gate too. Inbound lanes skip low-confidence redactions. OFF
  // (default, dev AND prod): nothing is written. Kill switch: unset. Read at
  // CALL time via gateEnvValue.
  llmCallTraces: gateEnvValue('GATE_LLM_CALL_TRACES'),

  // Agent-control hub read — routes/admin-agents.js /control/areas +
  // /control/lanes via services/agent-control/hub-read.js. ON: the Control
  // center reads per-lane calls, ok / fallback rates, latency, tokens and
  // attention status from the llm_dispatch_log call ledger, and the hub
  // probe reports features.ledger = true. OFF (default, dev AND prod): both
  // routes 404 and the probe says no ledger, so the client renders nothing
  // new. Read-only either way. Kill switch: unset. This entry is for
  // logGateStatus; the route reads gateEnvValue at CALL time.
  agentControlRead: gateEnvValue('GATE_AGENT_CONTROL_READ'),

  // Agent run ledger writes — services/agent-control/runs.js. ON: startRun /
  // runManaged record work_items, agent_runs, agent_attempts, agent_run_steps,
  // run_artifacts and run_events (migration 20260905000010) for every lane
  // that calls them, and the hub probe reports features.runs = true. OFF
  // (default, dev AND prod): every handle is inert — the wrapped work runs
  // exactly as before and nothing is written. The /control/runs reads are
  // gated by GATE_AGENT_CONTROL_READ, not this. Kill switch: unset. This
  // entry is for logGateStatus; the writer reads gateEnvValue at CALL time.
  agentRuns: gateEnvValue('GATE_AGENT_RUNS'),

  // Ops digests in-app — server/services/ops-digest.js deliverOpsDigest.
  // ON: the FIX:/ACT:/FIRST: watcher + digest emails (15 senders) become
  // ops_digest bell rows the Activity feed lists, and the email is skipped
  // (bell-write failure still emails). OFF (default, dev AND prod): every
  // sender emails exactly as before. Requires GATE_AGENT_ACTIVITY too (the
  // rows need a surface) — with it off the helper fails closed to email.
  // The reply-to-approve flows and the stripe-webhook-health / llm-dispatch
  // FIX alerts are not routed here. Kill switch: unset. This entry is for
  // logGateStatus; the helper reads both env vars at CALL time.
  // Tech visit notifications (Field Team Program Phase 0 item 2,
  // services/tech-visit-notifications.js): the assigned field technician gets
  // a tech-home card + a one-line push when a visit is assigned to them, taken
  // off them, moved, or cancelled. Staff-only — never a customer channel.
  // OFF unless set, dev AND prod; unset is the kill switch. The service reads
  // gateEnvValue at CALL time, so a flip needs no redeploy; this entry is for
  // logGateStatus.
  techVisitNotifications: gateEnvValue('GATE_TECH_VISIT_NOTIFICATIONS'),

  opsDigestsInApp: gateEnvValue('GATE_OPS_DIGESTS_IN_APP'),

  // Closeout money + comms alerts — services/closeout-alerts.js maps three
  // more closeout facts to operator issues: comms failed (completion notice
  // rejected by the provider), invoice pending on an actionable reason
  // (parked manual bill, frozen required mint, expected-<lane>-not-minted),
  // and invoiceDelivery failed / never-sent (receipt with no recipient or
  // exhausted, pay-link text failed, paid-but-no-receipt, payer invoice
  // unsent). Transient, queue-owned, consent-blocked and not_required
  // states stay silent. With the gate on, comms + invoiceDelivery outages
  // also HOLD the closeout_gaps_today floor like the mapped facts do. OFF
  // (default, dev AND prod): the pre-gate five-fact mapping, byte-identical.
  // Read-only, no comms, no bell-policy change. Kill switch: unset. This
  // entry is for logGateStatus; the service reads gateEnvValue at CALL time.
  // EPA label weather review; request-time checks use gateEnvValue.
  labelPipeline: gateEnvValue('GATE_LABEL_PIPELINE'),

  closeoutMoneyCommsAlerts: gateEnvValue('GATE_CLOSEOUT_MONEY_COMMS_ALERTS'),
};

// Parse a gate env var at CALL time (for request-time availability checks
// and gates enforced inside the pricing engine, where a flip must not need
// a client redeploy and tests mutate the env at runtime). One parser, one
// truth: '1' / 'true' / 'on', case-insensitive.
function gateEnvValue(envName) {
  return ['1', 'true', 'on'].includes(String(process.env[envName] || '').toLowerCase());
}

// Timestamp-valued gate parsed at CALL time (rollout EPOCHS such as
// GATE_PEST_STRANDED_RECOVERY). STRICT: a full ISO-8601 timestamp WITH an
// explicit offset (`2026-08-28T14:00:00Z` / `2026-08-28T10:00:00-04:00`)
// → Date; anything else — unset, a bare date, an offset-less local time
// (Railway would read it as UTC and open the gate hours early), a number,
// a locale string — → null (fail closed: an ambiguous value never enables
// anything).
// The regex lives INSIDE the function (codex r4 P1): the `gates` object
// above evaluates gateEnvTimestamp() at module load, and a module-level
// const declared below it would be in its temporal dead zone — the server
// would fail to boot exactly when the gate is set. Calendar components are
// round-trip validated (r4 P2): `2026-02-30T…` is ISO-shaped but JS would
// normalise it to March 2 — an impossible date fails closed instead.
function gateEnvTimestamp(envName) {
  const raw = String(process.env[envName] || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(raw);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] || '00'].map(Number);
  const calendar = new Date(Date.UTC(y, mo - 1, d));
  if (calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== mo - 1 || calendar.getUTCDate() !== d) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isEnabled(gate) {
  const enabled = gates[gate];
  if (enabled === undefined) {
    console.warn(`[feature-gates] Unknown gate: ${gate}`);
    return false;
  }
  return enabled;
}

function logGateStatus() {
  console.log('[feature-gates] Status:');
  for (const [name, enabled] of Object.entries(gates)) {
    console.log(`  ${enabled ? '✅' : '🔒'} ${name}: ${enabled ? 'ENABLED' : 'DISABLED'}`);
  }
}

module.exports = { gates, isEnabled, logGateStatus, gateEnvValue, gateEnvTimestamp };
// gates 1775330914
