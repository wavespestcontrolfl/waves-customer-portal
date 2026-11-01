/**
 * Feature Gates — Human-in-the-loop safety layer
 *
 * Every integration that touches real customers or third-party services
 * is gated behind a flag. In production, these default to OFF until
 * Adam manually enables them after verifying each one works.
 *
 * Set these as environment variables on Railway:
 *   GATE_CUSTOMER_APP_NOTIFICATIONS=true (customer App first preferences, account device resolution; strict opt-in via gateEnvValue)
 *   GATE_NEW_CLIENT_CONFIRM_EMAIL=true (owner 2026-10-24: a booking confirmation for a NEW client goes by text AND email. When the confirmation channel resolves to the default 'sms', the customer has no completed visit and became a customer (member_since) within the last 90 days or not yet, the channel is promoted to 'both' (the existing text + email path). Kept as today when the customer picked a confirmation channel in the portal (every customer whose settings row predates this change counts as having picked), the notification settings cannot be read, portal-wide email or the confirmation toggle is off, no usable email is on file, or any lookup fails. Reminders, en-route, reschedule and cancellation notices are unchanged. Strict opt-in, read at call time via newClientConfirmEmailLive(); dark by default; off = SMS-led confirmation exactly as before. Sends a customer email when on.)
 *   GATE_MOVE_NOTICE_EMAIL=true (owner 2026-10-24 "reschedule email": the email version of a reschedule or cancellation text that reached nobody. A customer whose line cannot take texts (a landline, a carrier bounce) otherwise hears nothing when a visit moves or is cancelled. On, when the reschedule text (handleReschedule, sendRescheduleNoticeForVisit) or the cancellation text (handleCancellation) reached no recipient and was not held (send window, visit move, unreadable settings), or a carrier later bounced it (handleUndeliveredSms), the customer gets the same notice by email (appointment.rescheduled / appointment.cancelled, transactional). No usable email raises the no-channel admin alert. One email per notice. Off = today's behavior: no reschedule or cancellation email. Kill: unset)
 *   GATE_PUBLIC_LLM_SHARED_CAP=true (security audit run 2, 2026-10-22 #13: the public paid-LLM routes (Ask Waves chat, lawn-assessment and pest-identifier photo analysis) also share one daily ceiling across all IPs and processes, counted in Postgres (public_llm_daily_usage, Eastern calendar day), on top of the per-IP in-memory limiters. Each route counts once, right before the paid call, after its own limiter, honeypot, Turnstile and validation; 1500/day Ask Waves (PUBLIC_LLM_DAILY_CAP_ASK_WAVES), 300/day photo (PUBLIC_LLM_DAILY_CAP_PHOTO); over the cap = the same 429 message. A database error fails open. Read at call time via publicLlmSharedCapLive(), strict 'true', dark by default; off = unchanged, no database call. Sends nothing to a customer.)
 *   GATE_AI_CREDIT_KEYS=true (owner 2026-10-29: the owner's Claude Max / ChatGPT Pro plans each give a monthly API credit that lands in its own API organization. With this on and ANTHROPIC_CREDIT_KEYS / OPENAI_CREDIT_KEYS set (comma-separated, one credit-only key per organization), Anthropic and OpenAI calls that carry the main key are tried on the credit keys first, in order, and fall back to the main key when a credit key runs out of credit, is rejected or is rate limited (paused in memory 6 h, 1 h or the retry-after time). Only stateless calls move (messages, count_tokens, chat completions, embeddings, moderations, images, audio, and /v1/responses with store:false); file, container, batch, session and streamed-body calls stay on the main key. One wrapper around globalThis.fetch installed at boot by server/services/llm/credit-key-pool.js, so a flip needs a redeploy. Strict 'true', dark by default; off = nothing wrapped, every call as before. Sends nothing to a customer.)
 *   GATE_BID_KIT=true (Bid kit, admin only: one page for the documents and company facts every government bid asks for (business license copy, certified operator certificate and notarized full-time statement, employee ID cards, product list, insurance certificate, W-9, Sunbiz status, tax receipt, E-Verify, references and the company fact sheet), each with its file, limits, source document, checked-on date, expiry and the owner's sign-off, plus a facts sheet the owner copies from while filling agency forms by hand. Files sit in private storage and open only by a short signed link. Never public, never on the website, never sent to anyone, no AI. Once a day at 6:05 AM ET (the compliance slot) a job posts one admin notification per item that expired or expires within 30 days (once a week per item). Read at call time via bidKitLive(), strict 'true', dark by default; off = every /api/admin/bid-kit route answers 404, the nav entry is hidden and the daily job does nothing.)
 *   GATE_BID_KIT_PRODUCT_LIST_SYNC=true (owner 2026-10-25: once a day in the 6:05 AM ET compliance slot the Bid kit Product List PDF (every product applied on a visit in the last 12 months, with active ingredient, EPA Reg. No., Label and SDS links) is rebuilt from the visit records. A changed list replaces the file; when ONLY products bought from SiteOne changed and the list is complete (every pesticide has an EPA number, label and SDS) the kit signs it off itself and logs an automatic sign-off, otherwise the file is left NOT signed off and ONE admin bell says what changed. Needs GATE_BID_KIT too. Read at call time via bidKitProductListSyncLive(), strict 'true', dark by default; off = the job returns before any query. Sends nothing to anyone.)
 *   GATE_PRODUCT_INTAKE_GUARD=true (owner 2026-10-26 "fix a": a purchase title that carries a product-line word the catalog product's own name lacks ("Dismiss NXT" vs "Dismiss", "Gentrol Complete EC3" vs "Gentrol") no longer matches that product by name containment or by the inventory agent's "existing" answer; it goes to a person through the agent's "not added" bell and no stock moves (alias matches are never guarded). A product the agent creates for a pesticide gets its EPA registration number and EPA label link from EPA's label system when one exact brand-name match proves it, otherwise the EPA number stays blank (never "N/A"), and the "logged a purchase" bell names what is still missing. Admin inventory only; nothing reaches a customer. Read at call time via productIntakeGuardLive(), strict 'true', dark by default; off = today's behavior.)
 *   GATE_REVIEW_FIRST_ASK_LOCK=true (owner 2026-10-26 "YES GO", option B: a customer who was never asked for a review (no review request ever texted or emailed, and not marked as already reviewed) gets the completion panel's review box labeled "First review ask", on by default and kept on. A tech can turn it off only with the reason "Complaint on site"; the server keeps the ask on for a never-asked customer unless the completion carries that reason, and saves the reason with the visit record. Customers asked before keep today's box. The ask text, timing, quiet hours, cap and cooldown, the already-reviewed rule, the unpaid-invoice hold and re-services staying off are unchanged. Strict opt-in, read at call time via reviewFirstAskLockLive(); dark by default; off = byte-identical. Texts a review ask on visits where a tech used to switch it off, so the owner flips it.)
 *   GATE_REVIEW_ASK_AFTER_REPORT=true (owner 2026-10-22: the same-day (Day 0) review-ask text goes out about 10 minutes after the service report text, for every service line, instead of the smart send window. Only a report sent as a text at completion anchors it: 10 minutes after that text, or 10 minutes after payment for a paid invoice. A report held for the morning moves the ask to 10 minutes after its 8 AM replay goes out as a text. A report sent by the Waves app, failed, blocked, skipped or unknown keeps the smart window. Cadence mode only (needs GATE_REVIEW_SEQUENCES): the legacy path ignores this gate. Covers a completion, a paid invoice and combined-visit packets; the ask goes at the first :14/:44 review send after the 10 minutes. The 8 AM-8 PM window, 72 h ask spacing, click guard, holds, opt-outs and explicit operator timing are unchanged. Read at call time; off unless exactly 'true'; off = today's smart window for new enrollments (an ask already planned keeps its time, at most ~10 minutes out).)
 *   GATE_REVIEW_SENDER_EVERY_5_MIN=true (owner 2026-10-22: the review cadence sender runs every 5 minutes on its own offset (:04 ... :59) instead of :14/:44, so a due review text goes within 5 minutes. Same job and lock. Read at boot; off unless exactly 'true'; off = :14/:44 exactly as before.)
 *   GATE_CALL_ENRICH_CODES_REQUIRE_ANI=true (a call writes gate / garage / lockbox codes and access notes to a customer's profile only when the call's caller ID is that customer's primary phone; a spoken callback number alone no longer does. Pets and internal notes are unchanged. Read at call time via callEnrichCodesRequireAniLive(), strict === 'true', dark by default; off = unchanged; sends nothing to a customer)
 *   GATE_BACKLINK_SIGNUP_URL_GUARD=true (security audit run 2, 2026-10-22: the backlink signup worker's Chromium opens only an http(s) URL whose host resolves to public IPv4, the model's signup_url must stay on the queued site, and a route guard aborts requests to blocked hostnames or literal non-public IPs. Read at call time via backlinkSignupUrlGuardLive(), strict 'true', dark by default; off = navigation exactly as before. Sends nothing to a customer.)
 *   GATE_EMAIL_AUTH_STRICT=true (inbound email trust: hasAlignedAuth parses only real Authentication-Results method results, and a vendor invoice books an expense only when the sender authenticated as its From domain; strict `=== 'true'`, read at call time by emailAuthStrictLive(); dark by default; sends nothing to a customer)
 *   GATE_DEDUPE_NO_UNVERIFIED_BACKFILL=true (the nightly duplicate auto-merge does not merge an untouched anonymous web-intake row whose typed email is not the kept customer's email; the pair stays on the Duplicates page for a manual merge; manual merges unchanged; strict opt-in read at call time by customer-dedupe.js; dark by default; sends nothing to a customer)
 *   GATE_NEWSLETTER_CLICK_BOUND=true (security audit run 2, 2026-10-22: the newsletter event link /api/public/newsletter/e/:token/:eventId redirects to the event's URL only when the token is a real delivery and the event is in that send's lineup (locked or alternate ids); any other pair goes to the homepage, so the portal host is not an open redirect; the target is the URL the send carried (newsletter_sends.event_url_snapshot, written at send time). Read at call time via newsletterClickBoundLive(), strict 'true', dark by default; off = redirect exactly as before. Sends nothing.)
 *   GATE_NEWSLETTER_AUTO_SEND=true (owner 2026-10-30, option A: the weekly issue sends itself Tuesday at 6:00 AM ET once the automatic checks pass. The Monday proof step queues it and emails the owner an FYI copy; a HOLD reply or Cancel schedule in History skips that week. The inactive-reader check-in email also queues itself. Needs GATE_NEWSLETTER_PROOF_APPROVAL on. Read at call time via newsletterAutoSendLive(), strict 'true', dark by default; off = the issue waits for an APPROVED reply, as before. Emails the list.)
 *   GATE_ESTIMATE_LAWN_LIMITS=true (owner 2026-10-22: a recurring lawn estimate says in writing what the program can and can't fix, and the office can flag other grasses (carpetgrass, bahiagrass, bermudagrass, torpedograss, dallisgrass) and suspected virus streaks on the lawn's turf profile; each flag adds one line to the estimate page, the estimate PDF and the pdfkit fallback. The tech sheet warns when Celsius WG is picked on a carpetgrass lawn. Read at call time via estimateLawnLimitsLive(), strict 'true', dark by default; off = every estimate, turf profile and tech sheet output exactly as before. Sends nothing and prints no prices.)
 *   GATE_SMS_ANY_LANGUAGE_TRIAL=true (test answers to customer texts in another language: the text is translated to English, the normal SMS drafter answers it with every English check, and the reply is translated back and double-checked (numbers, times, prices, links unchanged; a back-translation must say the same thing). Stored in sms_translation_trials for the owner to read; NOTHING is sent and the real reply path for these texts is unchanged. Strict opt-in via gateEnvValue, read at call time by server/services/sms-translation.js; dark by default. Sends nothing to a customer.)
 *   GATE_SMS_ANY_LANGUAGE_INBOX=true (inbox assist for a customer text in another language: when GATE_SMS_ANY_LANGUAGE_TRIAL has stored a test answer for the customer's latest text and nobody has answered it, the Communications composer shows the English translation of their text and the checked reply in their language beside its English, with a Use button that fills the message box. Staff press Send through the ordinary composer; nothing sends on its own and no reply path changes. Strict opt-in via gateEnvValue, read at call time by server/services/sms-translation.js inboxAssistFor(); dark by default; off = GET /admin/communications/agent-draft returns translation: null.)
 *   GATE_SMS_BARE_YES_REPLY=true (owner 2026-10-29, weekly sweep #5007 B3: a bare "YES" text from a number with nothing to re-subscribe (no active suppression, texts not turned off on the customer, no recipient ask the YES would confirm) is an ordinary reply: it reaches the reply bell and the inbound consumers instead of getting "You've been re-subscribed". START and the other opt-in keywords are unchanged; a failed lookup keeps the opt-in. Read at call time by server/routes/twilio-webhook.js via smsBareYesReplyLive(); dark by default; off = a bare YES is START, as before. Sends nothing new to a customer.)
 *   GATE_CALL_EMAIL_CHECKS=true (owner 2026-10-29 "yes build", after the call-agent audit: checks on an email heard on a call. The Gemini-only spelling decoder falls back to OpenAI (the 2026-10-05 spelled-email rule keeps working when Gemini fails); a domain with no mail server is set aside with an email_invalid card; a SendGrid "no mail server" failure is a bad address (no retry; the office alert and the recording re-check, never an automatic correction or resend); the office can type the right address on any email card. Read at call time via callEmailChecksLive(); dark by default; off = exactly as before. It sends no new kind of message.)
 *   GATE_SMS_VOICE_PROFILE_PIN=<voice_profiles.version integer> (owner 2026-10-24 "do all": the texting AI's drafter uses THAT voice profile version instead of the newest approved one. Only a version that was once approved (status approved, or superseded with an approval row in activity_log) counts; a missing, pending or rejected version, or a value that is not a whole number, falls back to the newest approved profile and logs once, with no customer data. The nightly distiller keeps running and approving as before: only the drafter's reading is pinned. The same pin is what graduation, the sealed exam and auto-send read as the effective profile. The phone agent keeps reading the newest approved profile. Each draft's intended_actions.voice_profile_version already carries the version used. Read at call time by server/services/sms-shadow-drafter.js via smsVoiceProfilePinVersion(); dark by default (unset = byte-identical); a set pin adds the prompt-version tag v. Sends nothing to a customer.)
 *   GATE_SMS_EDIT_LEARNING=true (owner 2026-10-24 "do all": the texting AI learns from the owner's edits to its suggestions. The nightly voice-corpus miner also mines legacy ai_revised sends and stops mining a composer send that sent a suggestion unchanged (that would train the drafter on its own text), and the drafter's few-shot examples rank edited-suggestion replies and replies the judge scored human_better first, then newest, instead of newest only. The sealed-exam, opt-out and complaint exclusions stay. Strict opt-in via gateEnvValue, read at call time by server/services/sms-voice-corpus-miner.js and server/services/sms-shadow-drafter.js via smsEditLearningLive(); dark by default (off = byte-identical); on adds the prompt-version tag e. Sends nothing to a customer.)
 *   GATE_SMS_PROMPT_B1=true (owner 2026-10-24 "go b1", "yes all": the texting AI's suggestion drafter stops stalling and stops making false promises, in one prompt change. A missed-visit text gets 2-3 real open times to rebook (with no times it keeps the apology and the follow-up wording); a covered pest re-service text gets 2-3 of the re-service booking page's own openings; a reply never says a link, text, email, report, quote, proposal or photo "is being sent" unless the reply carries it, never promises that the office or a teammate will confirm, cancel, add, move, call or email something, never lets the follow-up timing promise more than a reply, and never opens a reply in an ongoing thread with Hi, Hello or Hey and a name; the latest finished visit's customer-safe notes (up to about 1,200 characters) and its findings reach the facts. Needs GATE_SMS_REAL_ANSWERS. Strict opt-in via gateEnvValue, read at call time by server/services/sms-shadow-drafter.js and server/services/context-aggregator.js via smsPromptB1Live(); dark by default (off = byte-identical prompt, facts and checks); on stamps a fresh prompt version (real_answers27_n, 28_n with GATE_SMS_OFFERS_SCHEDULER). Drafts are suggestion cards only: staff send them; sends, schedules and books nothing.)
 *   GATE_SMS_JUDGE_V2=true (owner 2026-10-24 "yes all": the grader of the texting AI drafts also answers the owner's question, could the person who replied have sent the AI draft instead (yes, yes with an edit, no), and counts a false promise as unsafe: a link, text, email, report, quote, proposal or photo "being sent", the office or a teammate "will confirm/cancel/add/move/call/email", or "within the hour" turned into a promise that a quote, proposal, photo, report or visit arrives by then. Rows carry judge_version j2 and could_send; the autonomy safety backstop then counts j2 rows only, so the stricter ruler never mixes with the old one; the sealed exam summary also counts could_send. Strict opt-in via gateEnvValue, read at call time by smsJudgeV2Live() in server/services/sms-shadow-judge.js and sms-graduation.js; dark by default; off = byte-identical prompt, parser output and rows. Measurement only: sends, holds and changes nothing, and the drafter prompt and its prompt_version are untouched.)
 *   GATE_DUPLICATES_SAME_ADDRESS=true (the admin Duplicates page and /api/admin/customer-duplicates also list customers at the same address with different phones, for the office to merge or mark as separate; review-only, never auto-merged, the auto-merge cron cannot see them; read at request time via duplicatesSameAddressLive(), strict === 'true', dark by default; off = the page and API are byte-identical to before; sends nothing to a customer)
 *   GATE_DUPLICATES_SAME_NAME=true (the admin Duplicates page and /api/admin/customer-duplicates also list customers with the same first and last name but a different phone and address, for the office to merge, merge while keeping the other address as a second property, or mark as separate; review-only, never auto-merged, the auto-merge cron cannot see them; pairs the shared-phone and same-address lists already show are left out; read at request time via duplicatesSameNameLive(), strict === 'true', dark by default; off = the page and API are byte-identical to before; sends nothing to a customer)
 *   GATE_QUIET_OVERDUE_LIST=true (owner 2026-10-24: one standing Billing bell listing open self-pay invoices no reminder reaches (paused with no end, stopped, finished, Auto Pay hold 7+ days, never set up); weekday 11:47 ET cron; admin only, sends nothing to a customer)
 *   GATE_UNBILLED_VISITS_LIST=true (owner 2026-10-25, Air Jobs Plan step 3: one standing Billing bell listing visits done in the last 30 days with no invoice, read from the Billing recovery page's own list; replaces the c02 check on the owner's MacBook Air; daily 07:23 ET cron; admin only, sends nothing to a customer)
 *   GATE_IB_LEAD_CONVERT=true (the Intelligence Bar's convert_lead write tool, owner ruling 2026-10-12 "yes to all recommendations" on the Stage 3 plan: an admin can convert one lead to an EXISTING customer on a confirm card (never owner-direct), by running the Leads page's own Convert to Customer handler (POST /admin/leads/:id/convert) in process. Writes the lead only (status won, customer link, value fields, a converted activity row, the ad funnel stage, and the lead's own estimate attached to the customer); creates no customer, books nothing, charges nothing, accepts no estimate and sends NO text, email or call to anyone. Needs GATE_IB_PLATFORM. Read at call time via ibLeadConvertLive(), strict 'true', dark by default; off = the tool is not offered and refuses every call, changing nothing.)
 *   GATE_IB_INVOICE_EDITS=true (the Intelligence Bar's invoice edit write tools, owner ruling 2026-10-12 "yes to all recommendations" on the Stage 3 plan, edit-type Invoices page actions: edit_invoice (title, notes and due date only: PUT /admin/invoices/:id; line items and the tax rate stay on the Invoices page), archive_invoice and unarchive_invoice (POST /:id/archive, /:id/unarchive) and unvoid_invoice (POST /:id/unvoid), each on its own confirm card (admin only, never owner-direct) by running the Invoices page's own handler in process. None sends a message, moves money, charges a card or refunds. Needs GATE_IB_PLATFORM. Read at call time via ibInvoiceEditsLive(), strict 'true', dark by default; off = the tools are not offered and a forced call refuses with gate_off, changing nothing.)
 *   GATE_IB_AGENT_REVIEW_DRAFTS=true (the Intelligence Bar's Agent Review draft tools, owner ask 2026-10-28, gap 7: an admin can list the AI-suggested replies waiting in the Communications composer as Agent Review drafts (list_agent_review_drafts), and approve (approve_agent_review_draft: send the draft as written, recorded accepted), revise (revise_agent_review_draft: send edited wording, recorded corrected) or ignore (ignore_agent_review_draft: record ignored, no text) ONE of them. Approve and revise run the composer's own POST /admin/communications/sms handler in process with the draft attached (its verification, atomic claim, thread parking, provider-boundary checks, canonical sender and accepted / corrected settlement), are ALWAYS a confirm card on every login including the owner's, and show the exact text, the recipient name and masked number, the inbound text it answers and any newer-text warning; the send uses exactly the carded text and stops if the customer texts again before the provider handoff. Needs GATE_IB_PLATFORM. Read at call time via ibAgentReviewDraftsLive(), strict 'true', dark by default; off = the tools are not offered and a forced call refuses, changing nothing.)
 *   GATE_IB_SET_BILL_TO=true (the Intelligence Bar's set_customer_bill_to write tool, owner ruling 2026-10-21 "BUILD" on IB gap #9: an admin can set ONE self-pay customer's Bill-To payer on a confirm card (never owner-direct), by running the customer page's own save handler (PUT /admin/customers/:id with only payerId) in process. Future billing only: offered only when the customer has no open invoice without a payer and no open checkout, so no invoice moves and nothing is cancelled; sends nothing. IB gap #19: the card can add a payer that is not set up yet first, as the page's New payer form does. Changing or removing an existing payer stays on the customer page. Needs GATE_IB_PLATFORM. Read at call time via ibSetBillToLive(), strict 'true', dark by default; off = the tool is not offered and a forced call refuses, changing nothing.)
 *   GATE_IB_RESOLVE_DISPATCH_ALERT=true (the Intelligence Bar's resolve_dispatch_alert write tool, owner ask 2026-10-28 IB gap #4: an admin can resolve ONE Action Queue card on the dispatch board on a confirm card (admin only, never owner-direct), by running the board's own single-card Resolve (PATCH /admin/dispatch/alerts/:id/resolve) through the shared resolveAlertAsDispatcher. Marks the card resolved by that admin, closes the linked tracking bells, and tells every open dispatch board to drop the card; sends nothing to a customer or technician and changes no visit. Clear-all stays on the board; a card that needs a decision (a visit not closed out) is refused. Needs GATE_IB_PLATFORM. Read at call time via ibResolveDispatchAlertLive(), strict 'true', dark by default; off = the tool is not offered and a forced call refuses, changing nothing.)
 *   GATE_IB_UNBLOCK_SENDER=true (the Intelligence Bar's unblock_sender write tool, owner ask 2026-10-28 IB gap #6: an admin can unblock ONE blocked email sender or domain on a confirm card (admin only, never owner-direct), by running the Email page's own unblock (DELETE /admin/email/blocked/:id) through the shared unblockSender. Removes the Gmail trash filter when one is on file and deletes the blocklist row; mail already in Trash stays there; sends nothing. Needs GATE_IB_PLATFORM. Read at call time via ibUnblockSenderLive(), strict 'true', dark by default; off = the tool is not offered and a forced call refuses, changing nothing.)
 *   GATE_BILL_TO_NO_VISIT_INVOICES=true (owner ruling 2026-10-22 "move": an unpaid self-pay invoice that rides no visit (a manual or project invoice) changes hands with the customer's default payer like a visit-linked one. Setting a customer default payer (customer page Bill-To, payer activation, a customer merge) withdraws it to the payer: pay link stops, its checkout is cancelled, applied credit returns, reminders pause; clearing the default releases it. The live owner answer already reads such an invoice as the payer's. Sends nothing. Read at call time via billToNoVisitInvoicesLive(), strict 'true', dark by default; off = such invoices are not moved, as before.)
 *   GATE_IB_VOID_INVOICE=true (the Intelligence Bar's void_invoice write tool, owner ruling 2026-10-12 "yes to all recommendations" on the Stage 3 plan: an admin can void ONE invoice that has collected nothing on a confirm card (never owner-direct), by running the Invoices page's own Void handler (POST /admin/invoices/:id/void) in process. Voids the invoice, stops its reminders, returns applied account credit, cancels an unconfirmed pay-page session; sends nothing. Refuses (by_owner_rule) any invoice with money received or in flight: refunds and card charges stay on the Invoices page. Needs GATE_IB_PLATFORM. Read at call time via ibVoidInvoiceLive(), strict 'true', dark by default; off = the tool is not offered and a forced call refuses, changing nothing.)
 *   GATE_IB_SCHEDULE_SMS=true (the Intelligence Bar's schedule_sms write tool, owner ruling 2026-10-28 gap 5 and B1: an admin can schedule ONE plain text to a customer for a later day and time on a confirm card (never owner-direct, every login), by replaying the Communications page's own schedule-sms handler through the shared writer services/scheduled-sms-queue.js. B1: only 8:00 AM through 7:45 PM Eastern is accepted (the sender runs every five minutes with no quiet-hours check, so 7:45 PM is the latest time that always leaves before 8 PM even if two runs are missed; 8 PM to 8 AM is refused) and the bar asks for a time in that range; the page keeps its behavior. It TEXTS a customer later, so the flip is the owner's. Read at call time via ibScheduleSmsLive(), strict 'true', needs GATE_IB_PLATFORM, dark by default; off = the tool is not offered and not executable, exactly as before)
 *   GATE_IB_INVOICE_REMINDERS=true (the Intelligence Bar's invoice reminder and scheduled-send write tools, dark: an admin can pause, resume or stop ONE invoice's automatic reminders (send nothing), send the invoice's next reminder now (texts and emails the customer; the card shows the channel, the masked recipient and the exact message), or schedule an unsent invoice to go out at a set Eastern time, each on a confirm card (never owner-direct), by running the Invoices page's own handlers (POST /admin/invoices/:id/followup/pause|resume|stop|send-now and /schedule-send) in process. Needs GATE_IB_PLATFORM. Read at call time via ibInvoiceRemindersLive(), strict 'true', dark by default; off = the tools are not offered and a forced call refuses, changing nothing.)
 *   GATE_IB_COMPOSE_EMAIL=true (the Intelligence Bar's compose_email write tool, owner ask 2026-10-28 IB gap #9: an admin can send ONE new email (not a reply) to ONE person on a confirm card, every time, the owner's login included (never owner-direct), by running the Email page's own Send (POST /admin/email/send) through the shared sendEmailMessage. It EMAILS the person (a customer on file, or any one address the operator names) from the office Gmail address: plain text exactly as carded, no signature, attachment, tracking or unsubscribe link, no copy saved, no opt-out check (the page's Send runs none). One recipient only; a portal link to a customer's account in the body is refused. The card pins the recipient, From, subject and body. Needs GATE_IB_PLATFORM. Read at call time via ibComposeEmailLive(), strict 'true', dark by default; off = the tool is not offered and a forced call refuses, sending nothing. An owner flip: it emails customers.)
 *   GATE_IB_PAYMENT_PLAN=true (the Intelligence Bar's create_payment_plan and cancel_payment_plan write tools, dark: an admin can create a payment plan on ONE invoice (the card lists each installment date and amount, says the plan charges no card, and says the customer is emailed the plan confirmation) or cancel the invoice's active plan (reminders re-arm), each on a confirm card (never owner-direct), by running the Invoices page's own handlers (POST /admin/invoices/:id/payment-plan and /payment-plan/cancel) in process. Needs GATE_IB_PLATFORM. Read at call time via ibPaymentPlanLive(), strict 'true', dark by default; off = the tools are not offered and a forced call refuses, changing nothing.)
 *   GATE_IB_CREATE_INVOICE=true (the Intelligence Bar's create_invoice write tool, owner ruling 2026-10-12 "yes to all recommendations" on the Stage 3 plan: an admin can create ONE DRAFT invoice for a customer on a confirm card (never owner-direct), by running the Invoices page's own create handler (POST /admin/invoices, or POST /admin/invoices/from-service when the operator names a completed visit and one amount) in process. A draft only: it sends no text, email or call, charges no card and records no payment; send_invoice sends it afterwards. The card pins the customer, every line and the server-computed total; the create rolls back if the total differs. A customer billed through a third-party payer, and a visit invoice that would use an estimate deposit or a retention offer, stay on the Invoices page. Needs GATE_IB_PLATFORM. Read at call time via ibCreateInvoiceLive(), strict 'true', dark by default; off = the tool is not offered and a forced call refuses, changing nothing.)
 *   GATE_IB_MULTI_CARD=true (owner request 2026-10-20: the Intelligence Bar may show up to five separate confirm cards in one answer when each is for a different record and none needs another card's result. Only open edits qualify (contact, address, status, schedule, text and booking cards); a refund, card charge, price, setting, delete or bulk card never joins a set. Each card confirms or cancels on its own and keeps its own pins. Needs GATE_IB_PLATFORM. Read at call time via ibMultiCardLive(), strict 'true', dark by default; off = one card per request, exactly as before.)
 *   GATE_IB_BILLING_MODE_EDIT=true (the Intelligence Bar's update_customer may change one customer's billing type (billing_mode) and per-application fee on its own confirm card, owner ruling D5 2026-10-06; the same billing-type rules as the customer page (services/billing-mode-rules.js), annual prepay and clearing the type refused, never owner-direct, no customer message; read at call time via ibBillingModeEditLive(), strict === 'true', dark by default; off = both fields are refused exactly as before)
 *   GATE_IB_TIER_UPGRADE_EMAIL=true (an Intelligence Bar update_customer card that raises a customer's WaveGuard tier AND changes the monthly rate they are billed emails that customer the membership.tier_upgraded notice after the card is confirmed and the update is saved; the card names the email before Confirm. Never on a bulk card, a first tier, a downgrade, a tier change with no price change, a rate the customer is not billed monthly, an auto-derived tier label, or an inactive or churned customer. Read at call time via ibTierUpgradeEmailLive(), strict 'true', dark by default; off = no pin, no card line and no email, exactly as before.)
 *   GATE_IB_REPRICE_VISITS=true (the Intelligence Bar's reprice_future_visits write tool, owner ruling 2026-10-07: one confirm card changes the per-visit price of one customer's future visits for one service, listing each visit's old -> new price; each visit is saved through the Schedule screen's own visit edit (updateVisitDetails over PUT /admin/schedule/:id/update-details), so the re-price block, validation and CAS are the screen's. Never a completed, in-progress, invoiced, prepaid, annual-prepay-covered or otherwise money-committed visit; a monthly-membership customer is refused (their price is the monthly rate). No customer message is sent. Read at call time via ibRepriceVisitsLive(), strict 'true', dark by default; off = the tool is not offered and refuses every call, changing nothing.)
 *   GATE_IB_GENERAL_READ=true (needs GATE_IB_PLATFORM; the Intelligence Bar's find_admin_reads and read_admin_data read tools, owner ruling 2026-10-12: on the owner login only, the bar may read what an admin screen reads. read_admin_data calls one reviewed admin GET endpoint from the generated catalog (server/services/intelligence-bar/admin-read-catalog.json) on this server as the logged-in owner and returns the JSON, capped. No write, no outside call, no file or stream. Read at call time via ibGeneralReadLive(), strict 'true', dark by default; off = the tools are not offered and refuse every call.)
 *   GATE_IB_GENERAL_READ_OFFICE=true (needs GATE_IB_GENERAL_READ; owner ruling 2026-10-28 "A1": a non-owner ADMIN login (the office, Virginia) gets find_admin_reads and read_admin_data limited to the catalog rows a person reviewed as OFFICE rows (`office: true` in admin-read-reviewed.json: dispatch alerts, the email-template and automation lists, the schedule blackout dates); every other row is refused with a plain "not available on this login", free-text notes are always withheld on that login whatever GATE_IB_READ_NOTES says, and every later write is still carded. The owner login keeps the whole catalog; technicians never. Banking, payouts, the SEO pipeline, payroll, tax, revenue settings, pricing config and credentials can never be office rows (the catalog build fails). Read at call time via ibGeneralReadOfficeLive(), strict 'true'; dark by default; off = the two tools are offered to the owner login only, byte-identical to before.)
 *   GATE_IB_READ_NOTES=true (needs GATE_IB_GENERAL_READ; owner ruling 2026-10-13: the Intelligence Bar's general read RETURNS free-text notes and access instructions (gate codes, lockbox instructions) instead of the `[note withheld: N characters]` marker, on the owner login only. Each returned note passes the structural link redaction (signed and private links) and ONE fixed-format secret scrubber (API key and token shapes, Bearer tokens, JWTs, PEM blocks, long base64/hex runs, credential query parameters in URLs, card numbers, SSN pattern), is cut at 1,000 characters, and the read keeps its untrusted-data marker so later writes show confirm cards. Labelled credentials (a credential key followed by ':' or '=') lose everything after the separator to the end of the note string. No other prose rules: a code or password written as plain words comes back as written. Read at call time via ibReadNotesLive(), strict 'true', dark by default; off = notes are withheld exactly as before.)
 *   GATE_IB_GENERAL_EDIT=true (needs GATE_IB_PLATFORM; the Intelligence Bar's find_admin_edits and propose_admin_edit tools, owner ruling 2026-10-12: a general EDIT tool for a reviewed allow-list of small internal edits only, on the owner login only, ALWAYS a confirm card, never owner-direct. propose_admin_edit takes one method and endpoint pattern from the generated catalog (server/services/intelligence-bar/admin-write-catalog.json), the path parameters and a body limited to the fields the reviewed row lists (any other field is refused), shows each field's new value (and the current one when a reviewed read supplies it), and on Confirm sends that exact body as a PUT or PATCH to this server as the logged-in owner, so the screen's own checks apply. Never a customer message, money, price, delete, bulk change, setting, user or credential; address text shows an ADDRESS CHANGE card. Read at call time via ibGeneralEditLive(), strict 'true', dark by default; off = the tools are not offered and refuse every call.)
 *   GATE_ESTIMATE_SENT_CLOSES_ASSESSMENT=true (an estimate sent to a customer after their Waves Assessment closes that assessment visit quietly — no report, text, review ask or invoice; a sweep every ten minutes, owner ruling 2026-10-04; off = nothing runs)
 *   GATE_NEIGHBORHOOD_ACCESS=true (a neighborhood gate code saved by the office, the customer's portal, a call or a customer text is also filed under that property's neighborhood in the shared directory, and a code that conflicts with the one on file is flagged needs_confirm and listed on the Gate codes page, with no bell (owner ruling 2026-10-03); read at call time via neighborhoodAccessLive(), dark by default; off = the save is byte-identical to before)
 *   GATE_CALL_PROMISE_AI_CLOSE=true (owner 2026-10-24: an open Waves call promise closes on its own when the same AI check the text-follow-up lane uses finds, across every line (texts both ways, calls, emails, visits booked, moved or completed, estimates, payments), a later record that kept it, quoted exactly; a customer text confirming it was done also closes it. Read at call time via callPromiseAiCloseLive(), strict 'true', dark by default; off = exactly today's behavior. Needs GATE_CALL_COMMITMENTS and PROMISE_EVIDENCE_CLOSE. Staff can Reopen from the Owed tab. Sends nothing to a customer.)
 *   GATE_CALL_PROMISE_LATER_TEXT_CHECK=true (owner 2026-10-25 "build it": a record proof the call-promise AI check accepted is no longer held for good by any later human text. The AI reads the texts that came after the proof and answers one question: does any of them say this promise was not kept, was undone, went wrong or is still needed? Only a clear no lets the proof close the promise; yes, unclear, a failed read, any later message with no words (a photo) or too long to read whole, more later texts than it reads, and card-number fragments it cannot attribute keep it held as before. Needs GATE_CALL_PROMISE_AI_CLOSE. Read at call time via callPromiseLaterTextCheckLive(), strict 'true', dark by default; off = exactly today's behavior. Staff can Reopen from the Owed tab. Sends nothing to a customer.)
 *   GATE_TECH_LOGIN_PRIVACY=true (owner 2026-10-25, second technician: a login with the technician role sees only its own customers' alerts and promises. Customer-text bells and pushes (sms_reply, reschedule intent, voicemail callback, service report and completion text failures, Twilio failures, job complete, follow-up bells) reach a technician only when the customer is on that technician's route (the same rule the Communications routes use); an alert with no customer keeps today's routing. The Promises tab feeds (proposals, open commitments, auto-closed) list only own-customer rows and closing, dismissing or reopening another customer's promise answers 404. The customer-deleted-account push goes to admin-role staff only. Admin and office logins see everything as before. Read at call time via techLoginPrivacyLive(), strict 'true', dark by default; off = byte-identical to before; sends nothing to a customer.)
 *   GATE_ESTIMATE_SLOT_ONE_PER_HOUR=true (owner 2026-10-25, second technician: the estimate time picker lists ONE opening for each date and start time, not one per technician. Of the openings sharing a start the picker keeps the one it sorts first (route-optimal, then the shortest detour to a nearby job, then the slot id); the kept opening is a complete reservable slot with its own technician and hold. The "Only N openings" count and every cut of the list follow the collapsed list, so a repeated time no longer pushes other times out. Same list the page, its search, the fresh recheck, one-tap purchase and the estimate-time text drafts read. Reserve and accept are unchanged. Read at call time via estimateSlotOnePerHourLive(), strict 'true', dark by default; off = byte-identical to before; sends nothing to a customer by itself.)
 *   GATE_SETUP_FEE_SETTLED_ANYWHERE=true (owner 2026-10-24 setup-fee alert audit: the "setup fee never invoiced, bill BOTH" admin alert, the completion hold it starts and the alert reconcile also treat the setup fee as settled when the customer's own invoices show it paid, waived or prepaid even though no invoice cites the accepted estimate: a paid line named setup fee or WaveGuard Membership for at least the frozen fee, a live $0 or waived setup-fee line, or a covered non-termite annual-prepay term or paid annual-prepay invoice. Settled = no alert, no hold, the normal visit invoice is made, and a standing alert is closed instead of reopened when the visit is billed. Read at call time via setupFeeSettledAnywhereLive(), strict 'true', dark by default; off = exactly today's behavior. Sends nothing to a customer and creates no invoice.)
 *   GATE_SETUP_FEE_APPLICATION_SETTLED=true (owner 2026-10-28, the three false setup-fee alerts of #6830: the setup-fee alert reconcile, which also runs right after a completion parks a new alert, counts a parked visit's application as billed when a prepay year whose bill is live (paid, or awaiting payment on a live prepay invoice) bought that visit, or when the visit's own invoices bill its base line plus its own add-on lines for the frozen visit charge. Billed = the alert closes, or shrinks to the charge still owed, instead of telling staff to bill the visit by hand. Read at call time via setupFeeApplicationSettledLive(), strict 'true', dark by default; off = exactly today's behavior. Sends nothing to a customer and creates no invoice.)
 *   GATE_SETUP_FEE_OPEN_INVOICE_NOTICE=true (owner 2026-10-31 "do these", the setup fee on an unpaid visit invoice: when the setup-fee alert's fee is not paid yet but the customer's open invoices (scheduled, sent, viewed, overdue or partly paid) carry fee lines that GATE_SETUP_FEE_SETTLED_ANYWHERE counts once they are paid, the alert stays open but says the fee is already on that invoice and must not be billed again, and the morning digest stops listing it as a fee to bill. The fee still counts as covered only once paid: paying the invoice resolves the alert, voiding it brings the fee instruction back. Read at call time via setupFeeOpenInvoiceNoticeLive(), strict 'true', dark by default; off = today's alert text, and a standing notice is rewritten back on the next reconcile. Sends nothing to a customer and creates no invoice.)
 *   GATE_CALL_ADDRESS_FAMILY_CARD=true (owner 2026-10-24 "yes build": a caller on a number no account carries who states a service address a live customer already has no longer gets a new customer record. The call files ONE suggest-only office card, "<caller> called about <customer>'s home. Add as a contact?", with two actions: Attach as contact (the caller's name, number and role go into the first free service-contact slot of that customer and the call is relinked to it) and New customer (the card is closed and the call is reprocessed, which creates the record the old way). While the gate is on, any family-account card basis also keeps the pass from creating a customer for the call. Read at call time via callAddressFamilyCardLive(), strict 'true', dark by default; off = byte-identical to before. Sends no message and starts no opt-in.)
 *   GATE_NEIGHBORHOOD_NAMING=true (the neighborhood sweep names every live home's community: it looks up homes never checked, names Sarasota homes from the plat number on the county's plat layer, and for a home the county cannot name uses the community the customer said on a call, linked as unconfirmed and kept out of the shared directory (no code filed from it, no entries read for its visits, no shared visitor pass) until the county or the office confirms it; read at call time via neighborhoodNamingLive(), dark by default; honoured only while GATE_NEIGHBORHOOD_ACCESS is live; off = the sweep is byte-identical to before. No message, no bell.)
 *   GATE_NEIGHBORHOOD_ADDRESS_LOOKUP=true (when a home's stored pin sits on another lot, the neighborhood naming asks the county roll for the home's own address and links it only when the lots at that house number, full street and ZIP all name one community; also reads a '#201' unit tail as a unit; read at call time via neighborhoodAddressLookupLive(), dark by default; honoured only while GATE_NEIGHBORHOOD_NAMING is live; off = the pin-only match as before. No message, no bell.)
 *   GATE_NEIGHBORHOOD_TECH_ACTIONS=true (on a visit assigned to them, a technician can add a keypad gate code to that visit's neighborhood (live at once; other live codes there then need confirming) and mark a neighborhood code wrong (it drops to needs_confirm, the office decides whether to retire it); owner ruling 2026-10-03. Honoured only while GATE_NEIGHBORHOOD_ACCESS is live; read at call time via neighborhoodTechActionsLive(), dark by default; off = the two routes answer 404 and the schedule feed carries no action data. No bell, nothing sent to a customer.)
 *   GATE_NEIGHBORHOOD_MERGE=true (the office can merge one neighborhood gate-code entry into another of the same county on Customers → Gate codes: homes, gate entries and filing-ledger rows move, the merged entry stays as an inactive pointer so new homes with its name land on the kept one, and Undo merge puts back what it moved; owner ruling 2026-10-25. Honoured only while GATE_NEIGHBORHOOD_ACCESS is live; read at call time via neighborhoodMergeLive(), dark by default; off = the merge routes answer 404 and the page shows no merge buttons. Staff only, no bell, nothing sent to a customer.)
 *   GATE_NEIGHBORHOOD_UNPLACED=true (Customers → Gate codes lists homes the directory cannot place — the county's lot at the pin matches the home's number and street but not its ZIP, or the customer saved a gate code on a home with no neighborhood — with a one-tap office link to the county's community; Add entry gets an "I have not seen this work" box that files Needs confirm with no date and demotes nothing; owner ruling 2026-10-26. Honoured only while GATE_NEIGHBORHOOD_ACCESS is live; read at call time via neighborhoodUnplacedLive(), dark by default; off = the list route answers 404 and the box is ignored. Staff only, nothing links by itself, no bell, nothing sent to a customer.)
 *   GATE_SCHEDULE_ACCESS_CODES=true (Gate and access codes on the office schedule, owner ruling 2026-10-26: Dispatch → Schedule shows each stop's codes on the phone list row, in the Complete service header (every Fast Complete sheet, the tech app's too), in a new Access section in Details (with Wrong code and Add gate code, which need GATE_NEIGHBORHOOD_TECH_ACTIONS) and in the desktop side panel. The lines are the day feed's gate alerts, the ones the tech app's stop brief shows; Details and the panel also list the office's accepted codes for the stop. The day feed carries `scheduleAccessEnabled` on each row while it is on. Strict opt-in: exactly 'true', read at call time via scheduleAccessCodesLive(). Ships DARK; off = the screens exactly as before. Staff screens only; nothing is sent to a customer.)
 *   GATE_HIRED_PACKET=true (owner ruling 2026-10-25, D7: the "Hired" button on the Staff page. On a prospective placeholder row an admin enters the hire's name, email, first day and pay, and one click makes the row an active staff account and emails the hire a set-password link (works 7 days) with a pointer to the Onboarding card. A "Resend link" action appears while the hire has not set a password yet. It never changes a customer; it sends ONE staff email per click. Strict opt-in: exactly 'true' in every environment, read at call time via hiredPacketLive(). Ships DARK; off = no button, both endpoints answer 404 before any database work and the Staff list is unchanged. The manual steps (rename, email, Active, Forgot password) still work.)
 *   GATE_STAFF_DOC_PREFILL=true (owner ruling 2026-10-25: a NEW staff form record opens with fields filled from the staff record, for the Vehicle Use & Commuting Agreement: assigned vehicle, home address and start date from the technicians row. The signer checks each value and saves; a typed value always wins. Never a checkbox, never a typed signature. Needs GATE_CONTROLLED_STAFF_DOCUMENTS. Strict opt-in: exactly 'true' in every environment, read at call time via staffDocPrefillLive(). Ships DARK; off = GET /versions/:id/prefill answers 404 { enabled: false } before any query and the form opens empty. Reads only; sends nothing to anyone.)
 *   GATE_REVIEW_BONUS_ASK_FIRST=true (census M8, second technician, 2026-10-25: a Google review bonus goes to the technician on the review ask that reached the customer, the latest ask delivered by email or text in the 45 days before the review (a click on the link is not used: nothing proves the customer made it); then today's order (latest service record, latest completed visit, latest ask). Changes who a NEW bonus row names; existing payout rows are never re-attributed. Read at call time via reviewBonusAskFirstLive(), strict 'true', dark by default; off = today's order byte for byte; rollback = unset. Bonus pay, so the owner flips it. Sends nothing.)
 *   GATE_CALLBACK_SOURCE_TECH=true (census M9, second technician, 2026-10-25: on the admin dashboard leaderboard a callback counts against the technician whose visit it corrects, not the one who did the callback. Source = the latest earlier regular record of the same customer and service category with a technician, within 60 days (services/callback-credit.js); none found = the callback's own technician, as today. Jobs, revenue and margins do not move. Reads only, owner-only screen. Read at call time via callbackSourceTechLive(), strict 'true', dark by default; off = no extra query and the same leaderboard; rollback = unset. Sends nothing.)
 *   GATE_CUSTOMER_TEXT_TO_VISIT_TECH=true (census M3, second technician, 2026-10-25: a known customer's text to an office line, while one of their visits today is en route, on site or its technician's next open stop, also reaches that visit's technician as a tech-home text card + one push (services/visit-tech-relay.js). An admin technician (the owner) gets no copy: the office bell already reaches the owner. The office inbox, bell and owner forward are unchanged; STOP/START/HELP keywords, reactions, courtesy-only texts and staff senders are not relayed. Read at call time via customerTextToVisitTechLive(), strict 'true', dark by default; off = no extra read; rollback = unset. Sends nothing to a customer.)
 *   GATE_IB_INVOICE_ACTIONS=true (the Intelligence Bar's send_invoice write tool, owner ruling 2026-10-07: for an EXISTING invoice only, an admin can send it to the customer on a confirm card (never owner-direct), through the Invoices page's own handler (POST /admin/invoices/:id/send). No invoice creation, amount edit, charge, refund or void. Read at call time via ibInvoiceActionsLive(), strict 'true', dark by default; off = the tools are not offered and refuse every call, changing nothing.)
 *   GATE_IB_INVOICE_EMAIL=true (owner ruling 2026-10-31, gap #20: send_invoice may also EMAIL the invoice (PDF + pay link) with at most one CC, on the same confirm card. Needs GATE_IB_INVOICE_ACTIONS. Read at call time via ibInvoiceEmailLive(), strict 'true', dark by default; off = send_invoice is text-only, exactly as before.)
 *   GATE_STAFF_ONBOARDING_DOCS=true (staff onboarding documents, owner 2026-10-08: a staff document an admin marks "Required at onboarding" is outstanding for every active staff member who can open it until they sign its CURRENT issued version (acknowledgment for a policy, a completed record for a form or procedure). Outstanding is derived on read; nothing is assigned or written. The Today page shows a card "Sign N documents to finish setup" that opens the first outstanding document, and the staff documents page shows each member's signed and outstanding documents. Needs GATE_CONTROLLED_STAFF_DOCUMENTS. Strict opt-in: exactly 'true' in every environment, read at call time via staffOnboardingDocsLive(). Ships DARK; off = no card and the onboarding endpoints answer empty with no query. Sends nothing to a customer.)
 *   GATE_TRUCK_CLOCK_IN=shadow (owner 2026-10-25, "this works": the rule is that a technician's shift starts by itself from the truck's GPS; THIS RELEASE ONLY RECORDS what that rule would do. The first of two triggers each Eastern work day wins: the truck's first GPS arrival at one of that technician's visits, or the start of the truck's first trip of the day (no earlier trip-start of a different trip for that truck in bouncie_webhook_log that Eastern day) within 200 m of the office. It notes whether the technician has no active shift and has a completed Vehicle Use & Commuting Agreement. Training days stay by hand (a trainee rides in the trainer's truck). Read at call time via truckClockInMode(): exactly 'shadow' (trimmed, any case) = decide and record one truck_clock_in_shadow row a day, never write time_entries; anything else, including 'true', = off, no code path runs. 'true' is not a value yet: live clock-in is a separate later change. Clock-out, the 9 PM reminder and the 11 PM close are unchanged. Sends nothing to a customer or staff member.)
 *   GATE_SPRAY_RAIN_RULES=shadow|true (owner 2026-10-26, plan page "Visit-Day Rain Rule", D1 = A and D2 = A: the visit-day spray check judges each product's label rain rule (server/config/label-rain-rules.js: "Do not make applications during rain" on the start hour, a label's dry-before-rain advice (a caution above 60%, the Warning level above 80%), water-in products not judged) and, for a tank spray whose label has no rain rule, the Waves rule for its service (reschedule-rules.js serviceSensitivity). One odds table for every rain number: caution above reschedule-rules caution_if_rain_prob_above (60%). Owner 2026-10-29 ("i just want to warn techs"): at `true` no weather reading withholds a dose anywhere (tech card, tank search, Tree & Shrub guide); a reading past reschedule_if_rain_prob_above (80%) or a wind or temperature limit is a caution that names it, the guide shows its mix when only the forecast is missing (an open label review still withholds it), and the Dispatch chip names the caution and the product ("Rain warning · Celsius WG", "Wind caution · Celsius WG") ahead of "Weather unknown" and is never red. Step 2: rain past 80% is the Warning level; wind and temperature are judged at the start hour and the next one; a tank spray whose label gives no dry time gets the Waves hours; a label heat line (Celsius: no adjuvant above 90°F) is a caution; each caution carries one action. Owner 2026-10-30: a label wind line is a caution at each label's own number (Cyper TC's on-grade line on termite visits only), and a fertilizer's "Do not apply if heavy rain is expected" is a caution when the start hour's forecast words say heavy rain or thunderstorms, on the same odds tiers. `shadow` = the live check is unchanged and the new verdict of each visit-day readiness / card build is upserted to spray_rain_rule_shadow (peak per visit per day); `true` keeps upserting the same row, which then counts the real rain odds. Off = byte-identical to today. Canonical CALL-TIME reader sprayRainRulesMode(). Kill switch: unset.)
 *   GATE_SATELLITE_PALM_COUNT_TYPED=true (owner 2026-10-24 "ok go", follow-up B to #6562: a never-sent estimate whose Tree & Shrub line priced a palm count read from the satellite image (palmCountFromLookup) is sent only after an admin types the palm count from the aerial photo in Review and send. Acknowledging the AI review is no longer enough; a typed count other than the priced one refuses the send with PALM_COUNT_MISMATCH, so the quote is rebuilt with the real count. Read at call time via satellitePalmCountTypedLive(), strict 'true', dark by default; off = the one-click acknowledgment as before. Never sends, never changes a price.)
 *   GATE_TRUCK_KIT=true (truck check, docs/tool-inventory-tracker-scope.md PR 1: a technician whose truck is an equipment row (category vehicle, assigned to them) gets a Truck check in the field workspace listing every equipment row kept on that truck (assigned_vehicle_id, set on Equipment → Assets) and a Today card once the last check is 7 or more days old; a check writes one equipment_checks row, a missing or damaged item opens a maintenance alert (tool_missing / tool_damaged, resolved on Equipment → Maintenance with Found / Lost or Repaired / Retired) and the check rings one office bell per truck that closes itself when every tool alert on the truck is resolved; with kit keys on rows and checklist items (PR 2) the Schedule readiness strip and the technician's Today page say which required tool a truck lacks. Read at call time via truckKitLive(), strict 'true', dark by default; off = GET and POST /api/tech/truck-check answer 404 { enabled: false }, the readiness poll reads nothing from the kit, nothing renders, nothing is written. Never contacts a customer, never changes an item's status by itself.)
 *   GATE_PIN_PARKED_CHECK=true (pin check after a visit, owner "build guardrail" 2026-10-09: a daily job compares the map pin of each customer whose visit was completed in the last 2 ET days with where the technician's Bouncie truck actually stopped that day. When the truck parked 175 m to 1500 m from the pin (the arrival radius is the setting gps_arrival.radius_meters) for 10+ minutes and never stopped inside that radius, it stores ONE open suggestion for the customer and posts ONE admin notification; the customer's address review panel shows the truck's spot with "Use the truck's spot" (fills the existing verify_pin form, staff still confirm) and "Dismiss". It never changes a pin, never calls the geocoder and sends nothing to a customer. Read at call time via pinParkedCheckLive(), strict 'true', dark by default; off = the job does nothing, the review endpoints carry no suggestion and the panel shows nothing new.)
 *   GATE_TRIP_LINK=true (trip link, owner "TRIP LINK" and "BOTH" 2026-10-26: a nightly job (01:40 ET, yesterday) and a backfill script link each Bouncie trip and truck stop to the completed visit it served, and store per-visit GPS arrival and departure, GPS minutes on site, drive minutes and drive miles in visit_gps_legs, plus where each trip ended and a business / personal SUGGESTION in trip_links. Shadow data only: it never writes mileage_log, scheduled_services, job_costs, pins or alerts and sends nothing. Read at call time via tripLinkLive(), strict 'true', dark by default; off = the job reads nothing and writes nothing and the summary route answers 404.)
 *   GATE_BID_DESK=true (Bid Desk, PR 1: every 15 minutes a job reads new rows of the emails table and files bid invites (BuildingConnected, Procore, bid portals, government RFP/RFQ mail) as bid opportunities with their due dates read from the fixed provider templates only, posts ONE admin notification per new bid, one when an addendum arrives on an open bid, and reminders 7 and 2 days before a due date the operator CONFIRMED; the admin Bid Desk page lists them and lets the operator confirm the date and set bid / no bid / submitted / won / lost. No AI call, no change to leads or the classifier, and it sends nothing to a buyer, contractor or customer. Read at call time via bidDeskLive(), strict 'true', dark by default; off = no job work, the routes answer 404 and the nav entry is hidden.)
 *   GATE_BID_DESK_SAM=true (Bid Desk, PR 2: once a day at 7:25 AM ET a job reads new federal notices from the official SAM.gov Opportunities API (NAICS 561710 pest control and 561730 landscaping, Florida, solicitations, combined synopses, presolicitations and sources sought) whose place of performance is in the Tampa Bay to Southwest Florida ZIP areas, and files each as a bid opportunity (source sam_gov, one per notice id) with its SAM.gov link and response deadline (never confirmed until the operator confirms it), posting ONE admin notification per new bid. Needs GATE_BID_DESK and SAM_GOV_API_KEY. No AI call; it sends nothing to an agency, contractor or customer. Read at call time via bidDeskSamLive(), strict 'true', dark by default; off = the job returns before any request.)
 *   GATE_BID_CHECKLIST=true (Bid Desk PR B, needs GATE_BID_DESK: each bid also carries its solicitation type, scored or pass/fail, a questions-due date, a mandatory job walk, a link to its estimate and proposal, its documents (the attachments of its emails), a per-bid checklist built from templates, and a submission record; adds a 14-day reminder before a confirmed due date, one reminder 2 days before the questions date and one 2 days before the job walk. Admin bell only: nothing goes to a buyer, contractor or agency. Read at call time via bidChecklistLive(), strict 'true', dark by default; off = the new fields are hidden and refused, no new reminder fires, and the Bid Desk works as before.)
 *   GATE_BID_DESK_AUTO_DATES=true (Bid Desk, needs GATE_BID_DESK: a due date read from a provider's fixed email template, or a SAM.gov response deadline, counts as confirmed when the bid is first filed, so the 7-day and 2-day reminders start by themselves; and an open bid still marked new, with no submission, closes itself as no bid once its due date is more than a day past (a date still waiting on an addendum check waits 30 days), with a note saying so. A date from a later email, an addendum or a SAM.gov deadline move still waits for the operator. Admin portal only: it sends nothing to a buyer, contractor, agency or customer and rings no new bell. Read at call time via bidDeskAutoDatesLive(), strict 'true', dark by default; off = the Bid Desk works as before.)
 *   GATE_BID_DESK_CHARLOTTE_DATES=true (Bid Desk, needs GATE_BID_DESK: an open Charlotte County Purchasing bid with a bid number and no due date gets its date from the county's own public bid list (purchasingbids.charlottecountyfl.gov, one read, at most hourly, and only while such a bid is waiting); the date counts as confirmed only while GATE_BID_DESK_AUTO_DATES is also on. An existing date, a decided bid and every other source are never touched. Admin portal only: it sends nothing to a buyer, contractor, agency or customer and rings no new bell. Read at call time via bidDeskCharlotteDatesLive(), strict 'true', dark by default; off = no call to the county and the Bid Desk works as before.)
 *   GATE_BID_DESK_NOT_OUR_WORK=true (Bid Desk, needs GATE_BID_DESK: a NEW bid whose title names grounds upkeep (mowing, edging, trimming, grounds or lot maintenance, tree work and the like) and names none of our work (herbicide, fertilizer, pest, weed control and the like) is filed as no bid with a note, and rings no new-bid bell. A bid a person marks by hand is never declined. Existing bids are never touched. Admin portal only: it sends nothing to a buyer, contractor, agency or customer. Read at call time via bidDeskNotOurWorkLive(), strict 'true', dark by default; off = every bid is filed as before.)
 *   GATE_CALL_APPLICANT_HANDLING=true (a phone call whose caller is a JOB APPLICANT or a vendor/partner is handled as that third party, not as a customer call: the call is labeled vendor_logged even when the model recommended no_action_needed; no customer-only review card is raised on it (service address, email, name, consent capture); a promise the office made on it is stored as kind other, so the customer follow-up watchdog does not page on it; and a job applicant call with a valid extraction files ONE Careers application (role technician, status new, source phone_call) unless an open application with the same phone already exists. Sends nothing to the applicant: no text, no email, no invite, no AI screen. Read at call time via callApplicantHandlingLive(), strict 'true', dark by default; off = every call is handled exactly as before.)
 *   GATE_CALL_PREPAY_CHOICE=true (a caller who chose annual prepay on a call, when the call extraction carries service_request.billing_choice = annual_prepay: (1) the scheduling payload of a not-booked call and its held-visit row on Dispatch say "Caller chose annual prepay", and Book it opens the New appointment form with Annual prepay preselected when the customer's linked estimate is prepay-eligible; (2) for a call the pipeline DID book, one admin-only Needs Review card (reason call_prepay_choice) per call, filed every 10 minutes while the customer's newest open estimate is prepay-eligible, whose one tap "Accept as annual prepay" runs the same accept the New appointment form runs (a DRAFT annual prepay invoice that is NOT sent, plus a payment-pending term). The office decides every accept; nothing is accepted, invoiced or texted by the sweep. Read at call time via callPrepayChoiceLive(), strict 'true', dark by default; off = no field is carried, no card is filed, the card's route answers 404, and the form opens as before.)
 *   GATE_CALL_CANCEL_GUARD=true (the New Appointment form shows "Canceled on a call" with the call's summary under the
 *     chosen customer when that customer's latest real conversation in the last 14 days filed a cancellation card that
 *     still stands. A warning only: the save goes through. Never texts, emails, changes a visit or closes a card. Read at
 *     call time via callCancelGuardLive(), strict 'true', dark by default.)
 *   GATE_AI_CHANGE_CHECK=true (owner 2026-10-30, "all": before-and-after AI check for every content change. The daily impact tracker compares how often AI answers cited a changed page in the 14 days before its deploy with the 14 days after, adjusted for site-wide Waves citations, and stores gained / lost / flat / no_data on the content_optimization_impact row. A "lost" verdict adds one FIX leg to the impact digest (also needs GATE_IMPACT_DIGEST), at most one email a day. Reads seo_llm_mentions that the daily prober already stored; fires no probes, costs $0, sends nothing to a customer. Read at call time via aiChangeCheckLive(), strict 'true', dark by default; off = no check runs and the digest has no such leg.)
 *   GATE_SAME_QUESTION_CHECK=true (content engine, owner 2026-10-30 "all": before a NEW supporting blog is drafted, topic-targeting-gate looks for a live post whose title, slug or primary keyword already holds every topic word of the brief's keyword (geo and framing words dropped, singular/plural folded; a one-word topic blocks only when at most 3 live posts hold it and it is not a broad pest or service word like termite or lawn). Off = the rule runs in shadow: it records run.topic_targeting_result.same_question and logs, and never blocks. On = the row is skipped by design (topic_targeting:TOPIC_SAME_QUESTION_LIVE) and one same_question_refresh row is queued against the owner page, which adds the candidate question as an answer block (ANSWER-GAP MODE) through the normal refresh chain: protected pages, in-flight page edit and the 28-day page cooldown still apply. Strict opt-in: exactly 'true', read at call time via sameQuestionCheckLive(). Ships DARK. Off also stops same_question_refresh rows already queued from being claimed (opportunity-queue lane fence); they wait and expire unclaimed after 60 days.)
 *   GATE_PORTAL_INBOX=true (owner 2026-10-31, option A: a Portal tab in Admin > Communications lists what customers asked for inside the customer portal and nobody answered: portal chat hand-offs (ai_escalations from a portal_chat session still pending) and customer service requests not yet resolved, closed or cancelled and not made by staff. Shows the last 14 days; older open items sit under one Older line with a Close all older button that closes them and sends nothing to customers. Mark handled on a row closes the item and the admin bell alerts raised for it. Admin only. Read at call time via portalInboxLive(), strict 'true', dark by default; off = the tab is hidden, the new routes answer enabled:false/404, and the escalation and request update routes close no alerts. Sends nothing to a customer.)
 *   GATE_MESSENGER_INBOX=true (owner 2026-10-31: a Messenger tab in Admin > Communications for the Facebook page's Messenger messages. Every 3 minutes the portal reads new messages from the Facebook page into the unified messages store (first run: last 6 months), rings one admin bell per thread with a new customer message, and closes it when someone replies. Staff reply from the tab through Facebook's Send API inside Meta's 24-hour window; past it the tab links to Facebook. Free API. Read at call time via messengerInboxLive(), strict 'true', dark by default; off = the poller does nothing, the routes answer enabled:false / 404 and the tab is hidden. The owner turns it on: it adds a customer-message path.)
 *   GATE_ROUTE_ENGINE_SUMMARY=true (owner 2026-10-31: the admin Day Scorecard payload also carries an `engine` block, a plain summary of the nightly auto-dispatch run over the last 7 ET nights: moves made, visits the per-run cap held back and how many of those moved later, and nights that failed or finished with errors; counts only, no drive-time estimate. Read-only over auto_dispatch_runs and auto_dispatch_audit_logs; sends nothing. Strict opt-in: exactly 'true', read at call time via routeEngineSummaryLive() by server/routes/admin-route-scorecard.js; dark by default; off = the scorecard payload is unchanged, with no engine key.)
 *   GATE_INSPECTION_REUSE_LEAD_SHELL=true (owner 2026-10-31: the public consultation page (routes/inspection-public.js) reuses the customer row the web form created for the lead, instead of minting a second customer row for the same person. Reused only when that row is still the lead's own untouched intake shell: stage new_lead, active, created at most 10 minutes before the lead, the lead is the first on it, no billing, login, visit, invoice or merge history, same phone and email as the lead, and no other lead's consultation provenance names it; a stored address that clearly differs falls back to a new prospect. A reused shell is booked as an outright prospect; the reuse changes nothing on its profile except to fill missing map coordinates. Read at call time via inspectionReuseLeadShellLive(), strict 'true', dark by default; off = the page creates the new prospect row exactly as before. Kill switch = unset the variable. Sends nothing to a customer.)
 *   GATE_QUOTE_SAME_PERSON_MATCH=true (owner 2026-10-31: the public quote wizard no longer adds a new customer row on every rerun when the typed phone already matches 2 to 10 customer rows that are all one person at one address. The wizard links the lead and estimate to the strongest of those rows, picked by the same winner rule the nightly duplicate sweep uses. Every matched row must be live, must have a name that fits the typed first and last name and each other, and must share one street address, unit, ZIP or city with the typed address and with each other row. Any mismatch or more than 10 rows keeps today's behavior: a new row. A single phone match, the email match, and the pre-pricing rodent lookup are unchanged. Strict opt-in: exactly 'true', read at call time via quoteSamePersonMatchLive() by server/routes/public-quote.js; dark by default; off = a phone that matches 2 or more rows adds a new customer row, as before. Kill switch = unset it.)
 *   GATE_CALL_LAST_NAME_LOOKUP=true (a phone caller who gave a first name and no last name gets a last-name SUGGESTION after the call: one admin notification with the answers from the county owner record (homeowner callers only), our own records, the caller's email address and the Twilio caller name; the office saves the name. Never writes a last name. Read at call time via callLastNameLookupLive(), strict 'true', dark by default; off = nothing runs.)
 *   GATE_ONSITE_CALLER_DEMOTE=true (when the on-site person a caller booked for answers YES to the opt-in text for that visit, the caller's appointment texts switch off account-wide (only when that person is the account's only service contact) and the on-site person gets the booking confirmation they missed; owner rulings 2026-09-30 and 2026-10-02. Read at call time via onSiteCallerDemoteLive(), dark by default; needs the recipient double opt-in rail on. Off, a YES still records consent and nothing else changes; rollback = unset)
 *   GATE_PAYROLL=true (basic payroll for Waves' own W-2 technicians, owner 2026-10-25, "can we start building basic now, and add layers to it at later stages?". Layer 1b-2a: an admin types the elections from a signed paper Form W-4 into the Staff page Payroll tab (filing status, Step 2 box, Step 3 credits, Step 4 amounts, exempt, date signed, first pay date it applies to); each entry is a new row and old rows are never edited. The admin also records how each technician is paid: paper check, or bank transfer with the date of the employee's written OK (Florida law). Stores no SSN and no bank account number; the paper W-4 keeps both. Read at call time via payrollLive(), strict 'true', dark by default; off = every /api/admin/payroll route answers 404 before any query and the Payroll tab is hidden; rollback = unset. Sends nothing to a customer or staff member.)
 *   GATE_PAYROLL_TAX_CALENDAR=true (basic payroll layer 2, owner 2026-10-25, "can we start building basic now, and add layers to it at later stages?". Needs GATE_PAYROLL for the finalized pay runs it reads. Puts the amount and due date of each payroll tax deposit and filing on the existing Tax page filing calendar: the monthly federal deposit, Form 941, Florida RT-6, a FUTA over $500 alert (FUTA deposits are out of scope), Form 940, W-2 and W-3, and the Florida new hire report. Due dates move past weekends and legal holidays by the IRS and Florida rules. The 14-day reminder text to the owner is the existing tax deadline alert. A row the owner marks filed or paid is never changed; if a pay run later raises an amount above what the marked rows cover, a new balance row holds the difference, and if the pay checks behind a marked return change, a review row asks the owner to check the figures. Read at call time via payrollTaxCalendarLive(), strict 'true', dark by default; off = the sync returns before any query. The owner makes every deposit and filing himself; sends nothing to a customer or staff member. Rollback = unset.)
 *   GATE_PAYROLL_FORM_FIGURES=true (basic payroll layer 3a, owner 2026-10-25, "can we start building basic now, and add layers to it at later stages?". Needs GATE_PAYROLL for the finalized pay runs it reads. Adds a Tax forms section to the Payroll tab and GET /api/admin/payroll/forms: the line-by-line figures to type onto Form 941 and the Florida RT-6 (one quarter), Form 940, and each employee's W-2 with the W-3 totals (one year), added up from finalized, not-voided pay checks by pay date, with a copy button on each amount. Rates come from the payroll calculator. Shows numbers to an admin only: no PDF is filled in, no SSN, EIN or bank number is held (those fields read "Enter from your records"), and nothing is filed, paid or sent. Read at call time via payrollFormFiguresLive(), strict 'true', dark by default; off = the route answers 404 and the section does not render. Rollback = unset.)
 *   GATE_PAYROLL_TIME_OFF=true (basic payroll, owner ruling 2026-10-26: "Paid days off. The portal's payroll cannot pay time off or holidays. Fix: add this before the tech's first day off." Needs GATE_PAYROLL. Adds paid time off and holidays to pay runs: an admin records a day per W-2 technician (kind pto or holiday, hours up to 24); the pay run pays those hours at the straight hourly rate on the same check, taxed like any wages, and never counts them toward overtime (hours not worked are not hours worked). A week with only time off still makes a check. A per-technician yearly allowance (technicians.pto_hours_per_year, a setting) only warns when paid time off passes it. A record is locked once the pay run for its week is final, whichever technician it paid; void the pay run to change it. The stub, the pay run table, the CSV and the tax package W-2 CSV show the new lines. Read at call time via payrollTimeOffLive(), strict 'true', dark by default; off = every output and route is byte for byte today's. Pays, sends and files nothing; rollback = unset.)
 *   GATE_PAYROLL_PAY_LINES=true (basic payroll, owner ruling 2026-10-29, D5 part 1 of the first-technician pay plan: "Build the payroll pieces now, switched off". Needs GATE_PAYROLL (and reads paid time off when GATE_PAYROLL_TIME_OFF is also on). Adds four kinds of pay line to pay runs: a review bonus, a sales commission, a monthly health allowance and an employer HSA contribution. An admin enters a line on the Payroll tab's Pay runs section (payroll_pay_lines) and the next pay run for that technician pays it, even for a technician who has left; a bonus, commission and allowance are taxable wages, while the employer HSA contribution is Section 125 cafeteria-plan money (not wages, not net pay, not in FIT/Social Security/Medicare/FUTA/RT-6 wages). Every line, the HSA one too, counts in the federal regular rate: the extra overtime half-time it causes is paid on the same check, a commission or allowance that covers several weeks is spread equally over those workweeks (29 CFR 778.120) and paid back from each week's approved hours. A covered week with worked time not yet approved makes the technician wait, and one with an unreviewed automatic clock-out holds the check (GATE_SHIFT_CLOSE_REVIEW); once a line is paid, the weeks it priced stay closed to timesheet edits and unlocks until its pay run is voided. W-2 box 12 code TT is filled only for a technician marked FLSA-covered (technicians.flsa_overtime_covered), from qualified_overtime_cents, and code W reports the employer HSA money; Form 940 line 3 includes it and line 4 lists it as exempt fringe benefits. Read at call time via payrollPayLinesLive(), strict 'true', dark by default; off = every output and route is byte for byte today's for checks drafted with it off (the pay-lines routes answer 404), and a check drafted with it on keeps showing and reporting the figures it stored; rollback = unset. Pays, sends and files nothing; the owner makes every payment and filing himself.)
 *   GATE_BI_TECH_SCORECARD=true (second technician build 7, owner GO 2026-10-29: the Monday BI briefing's get_operations_snapshot adds techScorecard for the last full week (Mon-Sun ET), one row per technician with a completed visit: stops a day, on-site minutes per stop against 25, drive minutes per stop (Bouncie), callbacks (credited to the technician whose visit they correct), review asks, and revenue per tech-day against the cost card's cost per tech-day. An unknown value is null with a reason, never 0. The agent prompt and the tool description gain the scorecard rules. Read at call time via biTechScorecardLive(), strict 'true', dark by default; off = the tool output and the prompt are byte for byte today's. The agent session takes its prompt and tools from the checked-in config on every run, so no agent sync is needed. Reads only; sends nothing. Rollback = unset.)
 *   GATE_TRUCK_VIEWS_PER_VEHICLE=true (tech roadmap build 6, owner "GO" 2026-10-29: "Every truck in the truck views." Today the Intelligence Bar truck answer ("what did the truck drive today?") reads one vehicle and the admin Mileage tab sums every vehicle with no split. On, get_truck_trips answers for every Bouncie vehicle, or the one named by an optional vehicle input (a nickname or a technician name), get_truck_status names each vehicle's technician, and the Mileage dashboard adds a per-vehicle list (today, month to date, live state, technician). Read-only; sends nothing to anyone. Read at call time via truckViewsPerVehicleLive(), strict 'true', dark by default; off = every response and the Mileage tab are byte for byte today's; rollback = unset.)
 *   GATE_PAYROLL_FAMILY_EMPLOYEE=true (basic payroll, owner ruling 2026-10-29, D5 part 2 of the first-technician pay plan: "Build the payroll pieces now, switched off". Needs GATE_PAYROLL. Adds a family-employee setting on a W-2 technician: the relationship (parent or spouse of the owner), the employer entity (sole proprietorship or single-member LLC with no S election) and the date it starts. A pay run dated on or after that date skips federal unemployment tax (26 U.S.C. 3306(c)(5)) and Florida reemployment tax (F.S. 443.1216(13)(d)) for that person and nothing else: income tax withholding, Social Security, Medicare, Form 941 and the W-2 stay the same. The exempt wages are reported as exempt on Form 940 line 4 (box 4e) and left out of the RT-6 wages, employee counts and wage list; they never count toward the $7,000 base. Read at call time via payrollFamilyEmployeeLive(), strict 'true', dark by default; off = every output and route is byte for byte today's for checks drafted with it off (the setting route answers 404), and a check drafted with it on keeps reporting what it stored; after it is turned off, exempt pay earlier in the year still never uses up the $7,000 base; rollback = unset. Pays, sends and files nothing; the owner makes every payment and filing himself.)
 *   GATE_PAYROLL_REVIEW_BONUS_IMPORT=true (basic payroll, owner ruling 2026-10-29, D5 part 3a of the first-technician pay plan: "Build the payroll pieces now, switched off". Needs GATE_PAYROLL and GATE_PAYROLL_PAY_LINES. Each time a pay run is drafted, recomputed or finalized, every earned Google review bonus (review_incentive_payouts) of a W-2 technician, earned on or before the run's week end, becomes an open review bonus pay line (source_type review_incentive_payout) that the run pays; finalizing the run marks the payout paid and voiding it puts the payout back to earned. While GATE_PAYROLL_PAY_LINES is on, an imported line whose payout was marked paid by hand or moved to another technician is dropped at the next draft, recompute or finalize; finalize and void keep the payouts in step with the lines they paid whatever the gates say. Read at call time via payrollReviewBonusImportLive(), strict 'true', dark by default; off = nothing is imported, every open imported line comes off the next run, and every pay run output is byte for byte today's; rollback = unset. Pays, sends and files nothing; the owner makes every payment himself.)
 *   GATE_COMMISSION_SOLD_BY=true (basic payroll, owner ruling 2026-10-29, D5 part 3b-1 of the first-technician pay plan: "the technician's flag, checked by the truck GPS, fills in 'Sold by'". Records who sold an estimate; pays, texts and charges nothing, the commission ledger is part 3b-2. On: the field-lead flag also records a GPS check (customer flag: a truck arrival at the visit in the 12 hours before; new 'Neighbor' flag: the truck within field_flag.gps_radius_m, default 300 m, of the typed address, position under 6 hours old; distance only, never the truck's coordinates), a verified flag from an active W-2 technician fills estimates.sold_by_technician_id while the estimate is not accepted and not cleared, and admins can set or clear it (PUT /api/admin/estimates/:id/sold-by, locked once accepted). Read at call time via commissionSoldByLive(), strict 'true', dark by default; off = the flag route, the flag modal and every estimate path are byte for byte today's and nothing is read, written or shown; rollback = unset (stored Sold by values stay but nothing reads or shows them).)
 *   GATE_PAYROLL_COMMISSION_LEDGER=true (basic payroll, owner ruling 2026-10-29, D5 part 3b-2 of the first-technician pay plan: the technician earns 10% of what Waves collects for the NEW service only, in its first 12 months, on work the tech brings in, paid in the next payroll after each payment, even after the tech leaves. Office-booked calls and web plans do not count; collected = net of sales tax, the card surcharge and refunds. Needs GATE_PAYROLL_PAY_LINES and reads estimates.sold_by_technician_id (GATE_COMMISSION_SOLD_BY fills it). On: each pay run (draft, recompute, finalize) records a commission sale for every accepted estimate sold by a W-2 technician, one ledger entry for each customer payment on the sold lines inside the 12 months, and one open 'commission' pay line per payment, so the commission rides on the pay run; a refund inside the 12 months comes off the technician's next commission, never below $0 and never from wages. Read at call time via payrollCommissionLedgerLive(), strict 'true', dark by default; off = no sales or entries are written, every open commission line comes off the next run, paid lines stay, and with the pay lines gate off every pay run is byte for byte today's; rollback = unset.)
 *   GATE_SHIFT_CLOSE_REVIEW=true (census H8 + M7, owner 2026-10-25: a shift the 9 PM/11 PM job or the 14-hour check closes for a technician who forgot to clock out ends at the last real activity (the latest completed visit or the end of the last job/drive/break/admin entry in the shift) instead of the forced time, is marked auto-closed and needing review, and blocks the technician's pay run line until an admin edits the clock-out or taps Confirm on the approvals screen; the 9 PM reminder and 11 PM notice go to the owner as an internal text and to every other technician as a Today card + push, never a customer-thread text. Read at call time via shiftCloseReviewLive(), strict 'true', dark by default; off = clock_out is the forced time, no flag, the same texts as today; rollback = unset. Texts only the owner's own phone.)
 *   GATE_PNL_PAY_RUN_WAGES=true (census M11, owner 2026-10-26, choice B "from the payroll the portal already runs": the P&L and the Schedule C draft count W-2 wages and employer payroll taxes from FINALIZED pay runs (payroll_checks.status 'finalized', by pay_date): wages = gross, employer taxes = employer Social Security + employer Medicare + FUTA + Florida reemployment. Bank payroll payments (net pay, the federal deposit, FUTA, RT-6) go in the expense category "Payroll (counted from pay runs)" (expense_categories.counted_from_pay_runs), which both leave out so nothing counts twice. P&L labor line = wages + employer taxes, plus a payroll block in the P&L JSON; Schedule C line 26 = wages, line 23 = employer taxes plus the other Taxes and licenses rows; the CPA README says so when GATE_TAX_PACKAGE_W2_LABOR is also on. Read at call time via pnlPayRunWagesLive(), strict 'true', dark by default; off = every output is byte for byte today's; rollback = unset. Changes report figures only; sends, files and pays nothing.)
 *   GATE_PAYROLL_BANK_MATCH=true (basic payroll item 8, owner 2026-10-28, "pay package is still being built, do these": the bank import ties a bank line to the paycheck or payroll tax payment it paid. A debit on a business account equal to a finalized, not-voided paycheck's net pay (pay date minus 3 days to plus 45 days, or plus 7 for a bank transfer) links when exactly one check and one bank line pair up, and a check number printed on the line breaks a tie; an IRS / EFTPS debit equal to a payroll federal deposit calendar row, and a Florida Department of Revenue debit equal to a payroll RT-6 row, link the same way. A linked line is booked as an expense in "Payroll (counted from pay runs)", which the P&L and Schedule C draft leave out. Anything else (two checks with one amount, an amount one cent off, a different check number) stays a suggestion with the paycheck named, and the owner picks. An automatic link is verified right after it commits (a later same-amount line or paycheck puts it back to review, nothing deleted), and a crash leftover is verified at the top of the next pass. It never moves money and never marks a calendar row paid; the Payroll tab shows Bank: matched / not seen yet / needs your pick per check, and the filing calendar shows Seen in the bank on <date>. Voiding a pay run releases the lines matched to its checks. That release, a changed or deleted calendar row and the owner's Unlink never delete or re-price an expense: the expense the match made stays as it is (the next pass finds it as the existing expense), and one it re-categorized gets its category back. Needs GATE_BANK_IMPORT for the bank lines, GATE_PAYROLL for the pay runs and GATE_PNL_PAY_RUN_WAGES (the match does nothing while that gate is off, so no expense is moved into a category the books do not leave out). Read at call time via payrollBankMatchLive(), strict 'true', dark by default; off = the bank import, the books and every response are byte for byte today's; rollback = unset (existing links stay).)
 *   GATE_TECH_PAY_STUBS=true (payroll item 7, owner 2026-10-28, "pay package is still being built, do these"; allowed by the technician allow-list v1 ruling of 2026-10-02, which gives a technician login its own pay. A technician sees a Pay stubs list on the Staff page for their own FINALIZED, not-voided pay checks and can open the stub (the admin stub: hours, earnings, taxes withheld, year to date, net pay; no employer taxes). GET /api/tech/payroll/checks and GET /api/tech/payroll/checks/:id/stub scope by the authenticated technician id; another person's check, a draft run or a voided run answers 404. Read at call time via techPayStubsLive(), strict 'true', dark by default; off = both routes answer 404 before any query and the list does not render. Everything else about payroll stays admin only. Pays, sends and files nothing; rollback = unset.)
 *   GATE_TECH_STAFF_GUARDS=true (census M12 + M6, owner 2026-10-25: (M12) an inbound text or call FROM the phone of an ACTIVE technician (technicians.employment_status 'active') is staff, like the env staff phones: a text to an office line stays in the office inbox (unread, with the owner's usual unknown-sender text forward) but gets no spam screen, estimator draft or new-prospect bell; a call keys no customer or lead and gets no missed-call text-back; a number that is also on a customer record stays a customer. Outbound sends and the owner phone set are unchanged. (M6) a technician's En Route or On Site tap on a booking the office has not reviewed no longer approves it: the tap answers 409 and ONE office notification per visit rings (Schedule, needs-you); an admin login still auto-confirms. Read at call time via techStaffGuardsLive(), strict 'true', dark by default; off = today's behavior byte for byte; rollback = unset. Sends nothing to a customer.)
 *   GATE_TECH_COST_RATES=true (L11a, owner 2026-10-26: "we need real actual calculation, this ($35) was a number I just thought". Job costing charges each visit for its own on-site minutes plus its drive minutes at its technician's worked-hour cost, and for its miles and vehicle time, when a cost card is in effect for that technician on the visit date (technician_cost_cards, vehicle_cost_cards; admin API /api/admin/cost-cards; Cost cards section on Settings > Operating costs). Read at call time via techCostRatesLive(), dark by default; exactly `true`. Off, or no card in effect = job_costs and service_records values are byte for byte today's loaded_labor_rate x on-job hours and drive_cost_per_stop. Customer prices never change. Kill switch: unset.)
 *   GATE_TECH_OPEN_TIME=true (L11b, owner 2026-10-26 "BOTH", build B: each visit carries only its own minutes and miles; the unbooked part of the paid day shows as one open time cost for each technician and day. Needs GATE_TECH_COST_RATES. On: the 01:40 ET job re-costs the visits the trip link just linked (so GPS drive legs reach job costs), GET /api/admin/cost-cards/open-time and the Open time panel in the Cost cards section answer, and the dashboard adjusted-EBITDA bridge adds one open time row. Read at call time via techOpenTimeLive(), dark by default; exactly `true`. Off = every one of those is exactly today's. Customer prices never change. Kill switch: unset.)
 *   GATE_JOB_COST_STANDARD_MINUTES=true (owner ruling 2026-10-31: the dashboard Gross Margin was wrong. Job costing books a lawn visit at 20 on-site minutes and a pest control visit at 25, a stale check-in span over 480 minutes at the visit's scheduled estimate, and the drive to a stop at the Average Drive Time (pricing_config global_drive_time, 20 min) at the loaded labor rate. Revenue keeps a recorded amount only when above $0, then falls back to the visit's own annual-prepay share or its linked invoice, never today's monthly rate. Cost and margin figures only: no price, invoice, payment or customer message changes. Read at call time via jobCostStandardMinutesLive(), dark by default; exactly `true`. Off = job_costs and service_records values are byte for byte today's. Kill switch: unset.)
 *   GATE_TECH_TRAINING_DATES=true (owner 2026-10-28, Tech 2 and 3 Roadmap question 3: ID-card and training due dates on the Compliance page Licenses tab, with a reminder before each date. F.S. 482.091: ID card applied within 30 days after hire, 5 days (40 hours) of field training with a written record (rule 5E-14.1421), 4 classroom hours within 6 months after the card is issued, 2 hours of continuing training before each yearly renewal. On: GET /licenses adds the dates and statuses for each technician with a hire date, PUT /licenses/:techId takes the four new dates, the admin-only training-days and training-record routes work, and a daily 6:52 AM ET sweep raises one admin bell for each technician and deadline and closes it when the date is entered. Admin bell only: nothing goes to a technician or a customer, and the Team tab's "Can be assigned field work" stays the owner's manual gate. Strict opt-in (exactly 'true'), read at call time via techTrainingDatesLive(); dark in every environment; off = the Licenses tab, routes and responses are as before and nothing is written or raised.)
 *   GATE_TAX_PACKAGE_W2_LABOR=true (census A8, owner 2026-10-25: the CPA tax package stops calling every technician's tracked time the owner's own non-deductible time. labor-timetracking-informational.csv keeps only technicians who are NOT W-2 employees (technicians.employment_type not 'w2'), and a new w2-payroll.csv lists one row per FINALIZED pay check (payroll_checks.status 'finalized') whose pay date falls in the package window: employee, week, pay date, regular and overtime hours, gross wages, the taxes withheld, the employer taxes and net pay, with a totals row; the README lists it (wages are Schedule C line 26, employer taxes line 23). Read at call time via taxPackageW2LaborLive(), strict 'true', dark by default; off = the package is byte for byte today's; rollback = unset. Changes a file for the CPA only; sends, files and pays nothing.)
 *   GATE_MISTING_LAYOUT_DESIGNER=true (mosquito misting satellite-map layout designer, step 1, owner 2026-10-26 "build staff version": the staff estimator shows a Design on map button beside the misting Nozzles input; it opens a modal over the property's satellite photo where staff draw eave and fence lines, nozzles are placed at every corner and about every 10 ft, and Use counts writes the nozzle total into the Nozzles input. Step 3 saves the layout per estimate (admin-estimate-misting-layout routes, misting_layouts) and adds a Proposed misting layout section to the estimate document. Staff drawing screen; no customer message, no price changes beyond the nozzle count staff already type. Needs GATE_MOSQUITO_MISTING also on. Ships DARK: strict true only. Off = the misting block of GET /admin/pricing-config/mosquito_misting_pricing, the layout routes (404), the estimate document and the estimator are byte-identical.)
 *   GATE_CONTACT_LOGIN=true (an on-location contact signs into the customer app with their OWN phone number through the same SMS code login, landing on the account they are a contact for as a CONTACT session: view-only schedule, visit history, technician tracking, service-report documents (never for a contact the report rule withholds from) and their own notification choices (GET/PUT /api/notifications/contact-preferences); every other portal route answers 403 ACCOUNT_HOLDER_ONLY — billing, payments, cards, referrals, credits, requests, chat, property, account deletion, the holder's preferences, push subscriptions. The account holder's own number always wins; a contact number is tried only when no holder row matches, and the contact's session dies at its next refresh once the holder removes them. Per-contact notification choices (service_contact_notification_prefs) only NARROW what the account sends: a purpose the holder turned off stays off. Owner rulings 2026-10-20: view only, no confirm or reschedule; the contact's in-app text-consent checkbox counts as the YES for a pending opt-in ask only, never over a STOP. Read at call time via contactLoginLive(), strict 'true', dark by default; off = a contact number never logs in, an existing contact token is refused (401) and the senders ignore the per-contact table, byte-identical to before. Sends nothing to a customer.)
 *   GATE_CONTACT_REPORT_TEXT=true (when the account holder's visit-complete text goes out, each confirmed on-location contact gets one plain text with the report link: no pay link, no review ask; the combined-stop summary text then goes to the account holder, not Contact 1; owner ruling 2026-10-03. Read at call time via contactReportTextLive(), dark by default; off = no contact text is queued, a queued one is dropped at its recheck, and the summary recipient is unchanged. The gate is the only supported switch: the contact_report_ready sms template row must stay active while it is on.)
 *   GATE_IB_STAFF_AUTOPAY_OFF=true (the Intelligence Bar's remove_saved_payment_method may turn a customer's Auto Pay off as the first step of one confirm card, then remove the card Auto Pay was using; owner ruling 2026-10-03. The off step is the portal's own disable (services/autopay-disable.js), so the customer gets the gated Auto Pay-off and payment-method-removed emails exactly as the portal sends them. Read at call time via ibStaffAutopayOffLive(), strict 'true', dark by default; off = the bar still removes a method Auto Pay is NOT using, and for one Auto Pay uses it answers that Auto Pay can't be turned off from the bar yet, changing nothing.)
 *   GATE_IB_TARGET_RULES_V2=true (Intelligence Bar target rules, owner rulings 2026-10-12 decision 3, 2026-10-20 and 2026-10-22, owner login in owner-direct mode only: (1) a card-free internal customer edit runs direct only for the on-screen customer, an operator pick, the sole match of one typed full name with no other identifier, or the sole match of one phone or email used alone; any qualifier, second name, unresolved name or choice-button reply keeps the card; (2) a request carrying several candidate customers cards every write and marks the thread for 30 minutes; (3) the same-name lookup lists up to 25 rows (id, name, checked city, last visit) the model may offer as buttons; (4) a grounded customer tool may make 5 direct edits per request, counted as each commits; lead and other exempt tools keep 2. Read at call time via ibTargetRulesV2Live(), strict 'true', dark by default; off = today's behavior byte for byte.)
 *   GATE_IB_RECORD_PAYMENT=true (the Intelligence Bar's record_payment write tool, owner ruling 2026-10-12 "yes to all recommendations" on the Stage 3 plan: an admin can record money ALREADY RECEIVED outside the portal (cash, check, Zelle, Venmo, PayPal or other) against one open invoice on a confirm card (never owner-direct), by running the Invoices page's own Record payment handler (POST /admin/invoices/:id/record-payment) in process. Settles the whole amount due and sends NO receipt (a receipt is the separate resend_receipt tool or the Invoices page). It never charges a card, creates a Stripe payment, refunds or voids; read at call time via ibRecordPaymentLive(), strict === 'true', dark by default, needs GATE_IB_PLATFORM; kill: unset)
 *   GATE_IB_RECORD_PAYMENT_PARTIAL=true (the Intelligence Bar's record_payment card may record PART of a bill (an amount less than the balance due) when GATE_PARTIAL_PAYMENTS is on too, owner 2026-10-28/29 "the bar does what the Invoices page does": the same recordManualPayment writer, a bar-only internal marker, the Invoices page's part-payment refusals, and the amount owed the card showed pinned and re-checked at Confirm. Never a receipt, never a card charge; read at call time via ibRecordPaymentPartialLive(), strict === 'true', dark by default; needs GATE_IB_RECORD_PAYMENT, GATE_IB_PLATFORM and GATE_PARTIAL_PAYMENTS; kill: unset)
 *   GATE_IB_ACCEPT_ESTIMATE=true (the Intelligence Bar's accept_estimate marks one sent or viewed estimate accepted from the bar, exactly as the estimate page's Mark accepted does (same handler, same conversion), always behind a confirm card that shows the service lines, the monthly bill before and after, the billing lane and tier, and every customer message; owner ruling 2026-10-07 Q5. Read at call time via ibAcceptEstimateLive(), strict 'true', dark by default; off = the tool is not offered and a forced call refuses, changing nothing.)
 *   GATE_IB_MODEL_FAILURE_NOTICE=true (when the Intelligence Bar's AI model call fails (a provider 4xx/5xx, a timeout, an overload such as the monthly spend limit), /query answers 200 with a plain reply (what failed, whether anything was changed, try again in a few minutes), records one 'ib-model' gap row, and rings one admin bell at most once an hour; never a customer message. Owner request 2026-10-20 after the 2026-10-19 limit outage. Read at call time via ibModelFailureNoticeLive(), strict 'true', dark by default; off = the error goes to the error handler, the task is marked outcome_unknown and nothing else is recorded, as before.)
 *   GATE_SERIES_MOVE_CARRIES_VISIT=true (staff whole-schedule moves carry each grouped visit partner to the new stop in the same transaction instead of refusing with VISIT_SERIES_MOVE_UNSUPPORTED; read at call time via seriesMoveCarriesVisitLive(), dark by default; customer self-serve moves unchanged; frozen visits still refuse)
 *   GATE_SERIES_MOVE_SKIP_CLOSED_DAYS=true (a staff series move re-dates the later visits of the plan; a re-dated visit that lands on a closed day (owner blackout date, weekly day off, closed holiday) moves forward to the next open day, as the Edit appointment cadence rewrite already does; the date the staffer picked stays as picked; owner 2026-10-22 "fix series edit". Read at call time via seriesMoveSkipClosedDaysLive(), strict 'true', dark by default; off = every projected date is byte-identical to before; customer moves unchanged)
 *   GATE_ONE_TEXT_PER_CUSTOMER_DAY=true (owner 2026-10-12/13: one on-the-way text and one arrived text per customer, service address, technician and ET day, however many services or visits that day has; appointment reminders are NOT changed (the existing same-slot merge owns them); the rule never reads visit_id, service_visits or visit_effects; read at call time via oneTextPerCustomerDayLive(), dark by default; off = every tracker text is byte-identical to before)
 *   GATE_ESTIMATE_DRAFT_RETIRE_ON_SEND=true (every 15 minutes, archive a customer's draft estimates that a later-created SENT estimate replaced, when nobody edited the draft after that send; read at call time via estimateDraftRetireOnSendLive(), dark by default; staff-facing only, sends nothing)
 *   GATE_REPORT_ONLY_PAYMENT_ALERT=true (hourly 8 AM-8 PM ET, a bill still open the ET day after a "report only, no pay link" completion raises one needs-you Billing alert to record the payment, and the alert closes when the bill is paid, voided or no longer owed; read at call time via reportOnlyPaymentAlertLive(), dark by default; office-side only, sends nothing)
 *   GATE_SERIES_MOVE_TEXT_COALESCE=true (when staff move a recurring series from the board or the edit modal, the customer text waits 3 minutes and only the newest move's date is sent; an older move's text is dropped when a newer staff move covers the same visit; reminders and other move effects stay immediate; read at call time via seriesMoveTextCoalesceLive(), dark by default; customer-facing)
 *   GATE_MULTI_TECH_TEXT_TIMES=true (the lead reply agent's next-available check, the text drafter's open-times fallback and the estimate converter's first service day read the website booking engine (per technician, route-aware) instead of the old by-city engine; a lead with only a city is placed at that city's centre; read at call time via multiTechTextTimesLive(), dark by default; customer-facing; off = the old by-city engine, byte-identical)
 *   GATE_PACKAGE_FOLLOWUP_AUTOBOOK=true (booking visit 1 of a two-treatment package — catalog cockroach_control, flea_tick or bed_bug_treatment — also books visit 2 in the same transaction: 14 days later (the catalog row's follow-up interval), same technician and window, confirmed with no office confirm step, $0 included, linked to visit 1 so a date move of visit 1 shifts it by the same days until the customer confirms or moves it (its time of day is kept) and a cancel, skip or no-show of visit 1 always retires it; owner rulings 2026-10-04. Covers admin Schedule create, estimate acceptance, the Leads page, the call pipeline (its visit 2 is written confirmed too); voice-agent and outbound-callback bookings are not covered yet. Off = visit 2 is booked only from the closeout card or a call that discussed it. Read at call time via packageFollowupAutobookLive(), dark by default; kill = unset. No confirmation text for visit 2; reminders arm through the self-heal sweep; the customer can reschedule it.)
 *   GATE_SHORTLINK_LEGACY_EXPIRE=true (retire the legacy 1-7 char short-link code space: /l/<legacy code> answers 410 and resolveShortCode returns null for it, so ~2k guessable codes that front never-expiring bearer-token URLs stop working; read at call time via shortlinkLegacyExpireLive(), dark by default; ungated either way, a re-send never reuses a legacy code)
 *   GATE_KB_SPECIES_QA=true (knowledge Q&A — texting assistant, tech field Q&A, lead agent — also reads the owner-approved species catalog; customer-facing callers get customer copy only, staff also get tech notes; read at call time via kbSpeciesQaLive(), dark by default)
 *   GATE_KB_CUSTOMER_AUDIENCE=true (knowledge Q&A — customer-facing callers such as the portal AI assistant and the lead agent — read only knowledge_base categories on the customer-safe allowlist, currently empty, instead of every active row; staff callers (tech_field, admin_manual) are unchanged; strict opt-in, read at call time via kbCustomerAudienceLive(), dark by default)
 *   GATE_LAWN_WIKI_PAUSE=true (owner 2026-10-30: pause the lawn wiki pages (agronomic wiki, knowledge_entries). The AI writes no page after a confirmed lawn visit or in the weekly refresh; the pages a visit feeds are flagged stale instead, so the refresh after a resume rewrites them. The weekly review digest stops and its open bell is retired. Treatment outcomes, weather, the wiki to Library sync and the admin Regenerate buttons keep working. Read at call time via lawnWikiPauseLive(), strict 'true'; unset = unchanged. Sends nothing to a customer.)
 *   GATE_PORTAL_ACTIVITY=true (customer activity in the logged-in portal and mobile app — strict opt-in, read at call time via portalActivityLive(), dark in dev AND prod: stamps customers.last_seen_at (throttled, 5 min) ONLY from the three foreground beacons — never from ordinary authenticated API traffic or background polling — and accepts POST /api/customer/activity/page-view + /push-open beacons that record portal tab views (`portal:<tab>`) and app opens from a push notification (`push:open`) into customer_page_views, plus POST /heartbeat (visible + recently-interacted sessions, at most every 5 minutes) which only stamps last_seen_at and writes no row. Staff browsers and bots are never recorded. Off = no stamp, no row, and the endpoints answer {enabled:false} so the client stops beaconing for the session. Sends nothing to a customer.)
 *   GATE_EMAIL_SEND_LATER=true (Gmail-style Schedule send in the admin email composer and reply box — strict opt-in, read at call time via emailSendLaterLive(), dark: the Send arrow menu and the Email > Scheduled tab appear, POST /api/admin/email/schedule queues a row in scheduled_emails, and a once-a-minute job sends due rows through the same Gmail path as Send, at most once. Off = no menu, no tab, the schedule route answers 404 {enabled:false}, and the job sends nothing; rows already queued stay queued, unsent, until it is on again. Sends customer email only at a time an office user picked.)
 *   GATE_BILLING_NOTIFICATION_CHANNELS=true (portal Email/Text/App billing-channel arrays; strict opt-in, stored choices remain enforced while dark)
 *   GATE_AGENT_SESSION_GUARD=true (Managed Agents cost guards, strict opt-in, read at call time via agentSessionGuardLive(): each blog, backlink, briefing and lead agent session is created with a hard spend cap, and a session its runner gave up on gets a user.interrupt. Off = sessions are created and left as before. Sends nothing to a customer.)
 *   GATE_TWILIO_SMS=true        (enable real SMS sending)
 *   GATE_TECH_ARRIVED_SMS=true  (enable customer "tech has arrived" SMS)
 *   GATE_TECH_LINES=true        (per-tech Twilio lines: a text/call to a tech line reaches that tech; dark = office-line semantics)
 *   GATE_TECH_WORK_DAYS=true (owner 2026-10-25, work days per technician: a technician row may carry technicians.work_days, the weekdays that person works (the Team tab "Work days" row; empty = every day). On, slot offers, automatic booking and automatic moves skip that technician on a day they do not work, and an automatic booking that lands on such a day stays unassigned for the owner; office saves (schedule create and edit, board assign and drag) still go through and add a plain warning line. Strict opt-in: exactly 'true', read at call time via techWorkDaysLive(). Ships DARK; off = work_days is ignored everywhere and the Team tab shows no editor. Sends nothing to a customer.)
 *   GATE_TECH_JOB_TYPE_CHECKS=true (owner 2026-10-25, second technician starts early 2027: job type from the service catalog. The capability checks (slot offers, automatic technician pick, tech-out auto-move, auto-dispatch apply, the save-time fences) today read a visit's job type from its NAME, so "Palm Tree Nutritional Treatment", "Semiannual Palm", "Palm Fert" and "Top Dress" read as general pest and a technician set to Off for Lawn can still get them. On, the category comes from the service library first (the visit's service_id, else its service key, to services.category, mapped onto the five capability categories by the same table the service-line map uses) and falls back to the name only when the catalog names none. Office saves (schedule create and edit, board assign and drag, lead booking, Dispatch New Appointment) also add a plain warning, never a block, when the chosen technician is set to Off for the visit's job type; "needs review" never warns. Strict opt-in: exactly 'true', read at call time via techJobTypeChecksLive(). Ships DARK; off = name-only classification and no extra warning, byte-identical. Sends nothing to a customer.)
 *   GATE_AUTO_DISPATCH_KEEP_TECH=true (owner 2026-10-25, second technician starts early 2027: the 04:10 auto-dispatch night run keeps each visit on its own technician. On, a visit that has a technician gets candidate slots on that same technician only (other technicians' slots are dropped as `other_tech`), and the write refuses to change a technician (`TECH_CHANGE_BLOCKED`, the visit stays). An unassigned visit is handled as before. Strict opt-in: exactly 'true', read at call time via autoDispatchKeepTechLive(), resolved once per run as config.keepTech. Ships DARK; off = the night run may move a visit to another technician for a shorter drive, byte-identical to before. Sends nothing to a customer.)
 *   GATE_PROMISE_RECORD_EVIDENCE=shadow|true (owner 2026-10-29, fix F4 "Stuck Alert Fixes": three false overdue bells on promises and asks the records had already answered. On, (1) an invoice Waves sent the customer after a staff promise ("I'll adjust the payment terms") is evidence the model may cite, (2) an estimate the customer accepted after a send-estimate ask counts even if it was sent before the ask, and (3) a waves row (promise or customer request) of kind other, callback or technician_follow_up whose customer has a live, non-series visit booked after the promise text and with its window end still ahead does not ring as overdue until that window end. `shadow` = change nothing; write audit_log rows for what it would have changed (sms_commitment.fulfillment.shadow, sms_commitment.on_track.shadow). Anything else = off, byte-identical. Read at call time via promiseRecordEvidenceMode(). See docs/gates-and-env.md.)
 *   GATE_ALERT_RETENTION=shadow|true (owner 2026-10-26, "ok go": admin alerts expire instead of piling up. A nightly 1:32 AM ET sweep marks done, never deletes, an admin bell row idle for more than 30 days (read or not) and an FYI row idle for more than 7 days; read state is untouched; `shadow` = judge and record one audit_log summary row (counts by rule and category, the re-ring list), change nothing; `true` = expire. Anything else = off. Read at call time via alertRetentionMode(). See docs/gates-and-env.md.)
 *   GATE_VOICEMAIL_VISIT_UNDERWAY=shadow|true (owner 2026-10-29, "Stuck Alert Fixes" F3: a voicemail callback bell closes once the voicemail's customer has a visit completed after the call on the same Eastern day; rides on GATE_ALERT_CONTACT_CLOSE, read at call time via voicemailVisitUnderwayMode(); shadow records, true closes, unset = off. See docs/gates-and-env.md.)
 *   GATE_ALERT_CATALOG=watch (owner 2026-10-29, "ok go" on admin bell rebuild step D1: every notification-registry type declares how it closes, and an admin alert the 08-28 bell policy silences is counted. `watch` = when NotificationService.create silences an admin row it writes ONE audit_log row (notification.bell_policy.muted) per Eastern day per distinct alert, category + trigger key + digit-free title stem only; the bell, pushes and create()'s return are unchanged. Anything else = off, byte-identical: no read, no write. Read at call time via alertCatalogMode(). See docs/gates-and-env.md.)
 *   GATE_SMS_STAFF_ACTION_ANSWERS=shadow|true (owner 2026-10-29, "Stuck Alert Fixes" F1: "A staff action answers a text" - a visit a person booked in the admin, or a payment a person recorded, for the text's customer within 24 hours after the text counts as the answer: the admin text alert closes, and in `true` the Messages Unanswered list and the evening Comms digest stop listing the text; rides on GATE_ALERT_CONTACT_CLOSE, read at call time via staffActionAnswersMode(); shadow records the would-close only, true closes, unset = off. See docs/gates-and-env.md.)
 *   GATE_LEAD_CONTACTED_CLOSE=shadow|true (owner 2026-10-29, "Stuck Alert Fixes" F5: a lead_contacted Leads bell closes once the lead was texted or called back, booked or quoted after the bell; its own gate, read at call time via leadContactedCloseMode(); shadow records, true closes, unset = off. See docs/gates-and-env.md.)
 *   GATE_LEAD_REPEAT_SWEEP=true (owner 2026-11-01, Action inbox agents A, "yes do this": a nightly 4:52 AM ET sweep files an unanswered lead that repeats the same person's open lead as its duplicate, so the inbox counts each person once and the person's real lead can settle. A waiting lead (the inbox's own leads_awaiting_contact queue) is filed only when an earlier live lead with the same phone, from the 30 days before it, leads to exactly one open root that has the same phone, a matching first or last name and no conflicting name, the same customer row when both are linked, the same street, unit and ZIP when both carry one, the same requested service by the quote wizard's own rule (catalog service_key, else the service label; no extra properties on either), and a live courtship (no closed estimate, shared with the wizard via lead-courtship.js). A won, lost or other closed earlier lead, another service, or a closed estimate never makes a repeat. The filing is the Leads page's own: status duplicate, the extracted_data.duplicate_of_lead_id marker the wizard's repeat dedupe writes, a status_change history row, then the funnel bridge. No first response is stamped. Sends nothing to anyone. Read at call time via leadRepeatSweepLive(), strict 'true', dark by default; off = no lead is touched. Undo a filing on the Leads page; the sweep never files that lead again. Kill switch: unset.)
 *   GATE_PORTAL_CHAT_ANSWERED_CLOSE=shadow|true (owner 2026-10-31, approved Portal inbox plan: a portal chat hand-off bell closes once a person texted, called or emailed that customer after the hand-off; its own gate, rides on GATE_ALERT_CONTACT_CLOSE, read at call time via portalChatAnsweredCloseMode(); shadow records, true closes, unset = off. See docs/gates-and-env.md.)
 *   GATE_AUTOPAY_HOLD_TIMEOUT=shadow|true|charge (owner 2026-10-26, "OK FIX": an invoice reminder sequence held for Auto Pay (status autopay_hold) is released into the normal reminder ladder when Auto Pay never charged it. Only a charge failure used to release a hold, so an invoice Auto Pay never charges (for example an annual-prepay invoice staff created after a visit) got no reminder and no charge, forever. A hold older than 3 days with no stripe_invoice_charge_attempts row for the invoice at all, no payments row for the customer since the hold began and no failed payment still on the Auto Pay retry ladder is released through releaseFromAutopayHold(); terminal, payer-billed and payment-plan invoices, an invoice whose linked visit is still open, and a customer the customer-level reminder engine owns or covers are left alone. `shadow` = write one audit_log row per would-release invoice a day (invoice_followup.autopay_hold_timeout_shadow), change nothing; `true` = release; `charge` (owner 2026-10-28, "Charge the saved card"; narrowed 2026-10-29, option B) = charge the customer's saved Auto Pay card or bank for a held VISIT bill only, and only inside the visit-completion rail's own authorization (completion-charge-verdict.js: the visit's agreed price cap, the same lanes; an issued-invoice closeout counts as a performed visit for this charge only). Keep the hold when the charge went through or its outcome is unclear (an office alert says check Stripe). Over the agreed price, no agreed price, a visit that was not performed, a payer, or any guard refusal = the hold is kept, nothing is charged or texted, one office alert asks for a review (it is looked at again only after the bill or visit price changes). Release the hold only when the card was really declined or there is no Auto Pay method; an invoice bound to no visit, an annual-prepay term rail invoice, or a bill no completion lane admits is released as `true` releases it, never charged (one office alert, one audit_log row per attempt, invoice_followup.autopay_hold_timeout_charge). `charge` MOVES MONEY: the owner flips it. Anything else = off, no query. Read at call time via autopayHoldTimeoutMode(). Runs inside the invoice follow-up job. See docs/gates-and-env.md.)
 *   GATE_AUTO_DISPATCH_CATCH_UP=true (owner 2026-10-26 ("build A"): a 5:00 AM Eastern catch-up run of the auto-dispatch night tool. The 04:10 run is cut off when a deploy restarts the server mid-run (2026-09-03 and 2026-10-26: nothing moved, nothing re-ran it). On, a 05:00 job checks whether today already has a finished night run (cron or catch_up, completed or completed_with_errors); if not, it marks any cron run left 'running' by a dead process as failed and runs the night tool once more (triggered_by catch_up, at most one catch-up a day), under the same run lock. It uses the same mode and rules as the 04:10 run. Strict opt-in: exactly 'true', read at call time via autoDispatchCatchUpLive(). Ships DARK; off = the 05:00 job does nothing and reads nothing. Sends nothing to a customer.)
 *   GATE_SERVICE_LINE_MAP=shadow (owner 2026-10-25, second technician starts early 2027: the service-line map. A service line (general pest, mosquito, lawn / tree & shrub, rodent, termite / WDO) has a home technician and a gap technician (Team tab "Service lines"). THIS RELEASE ONLY RECORDS: after each of six booking choice points commits (/book, phone live booking, after-call booking, estimate accept, office create left on Auto, the auto-dispatch night run) it writes one service_line_pick_shadow row with the technician actually chosen and the one the map would pick. Read at call time via serviceLineMapMode(): exactly 'shadow' (trimmed, any case) = record; exactly 'live' (build 4, owner "DO THIS NOW" 2026-10-30) = record AND pick: /book offers, the phone booking recheck, the after-call booking, the office Auto choice, the estimate time offers and the estimate accept send a mapped line's new work to its home technician, else its gap technician; a line with no technician set keeps today's choice. Anything else, including 'true', = off, no resolver call and no query. Shadow never changes a booking; neither value sends anything to a customer or staff member.)
 *   GATE_TERRITORY_ROUTING=true (owner 2026-10-30, "go" on question 4 of the Waves Territory Map page: each technician has a territory, drawn as a ZIP list in territory_zips. On, the service-line map (GATE_SERVICE_LINE_MAP) lays the territory over a pest, mosquito, rodent or termite / WDO line: the technician who owns the visit's ZIP is that line's home technician, and the line's own home (else gap) technician covers gaps. Lawn / tree & shrub keeps the line map. The ZIP comes from the visit's ZIP, else its map position (Census ZIP shapes), else the customer's row. A ZIP with no territory technician adds no rule. It acts only where the line map acts: shadow rows show it under 'shadow', picks follow it under 'live'. Strict opt-in: exactly 'true', read at call time via territoryRoutingLive(). Ships DARK; off = the line map exactly as before, no territory query. Sends nothing to a customer.)
 *   GATE_TERRITORY_NIGHT_RUN=true (owner 2026-10-30, "go" on question 4 of the Waves Territory Map page, build 7: the auto-dispatch night run gives an UNASSIGNED pest, mosquito, rodent or termite / WDO visit only to the technician who owns the visit's ZIP (territory_zips): every other technician's slot is dropped as a candidate (drops.other_territory), so with no slot for that technician the visit keeps its place. The ZIP comes from the visit's service ZIP, else its map position, else the customer row. A visit with a technician, a lawn / tree & shrub visit, or a ZIP with no territory technician adds no rule. Strict opt-in: exactly 'true', read at call time via territoryNightRunLive(). Ships DARK; off = the night run byte-identical, no territory query. Sends nothing to a customer.)
 *   GATE_TERRITORY_READOUT=true (owner 2026-10-30, "go" on question 4 of the Waves Territory Map page, build 3: the Team tab shows a Territories card, stops a week per technician and area, booked over the next 4 weeks and done over the last 4, so the re-cut rule is a number you see. The area is the visit's service ZIP, else its customer's ZIP, through territory_zips. Read only. Strict opt-in: exactly 'true', read at call time via territoryReadoutLive(). Ships DARK; off = the roster response carries no territoryReadoutEnabled flag and GET /api/admin/timetracking/territory-readout answers 404. Sends nothing.)
 *   GATE_UNASSIGNED_VISIT_GUARD=true (owner 2026-10-25, second technician starts early 2027: an office visit must not silently land with no technician. On, the office create modal's "Auto" technician choice picks a real technician: the one technician assignable that day (active, field-dispatchable, not off that day or absent, not Off for the service category), or, when several qualify, the existing scheduling pick when that is active; otherwise the visit is saved unassigned and the response and modal say so (the old tech-matcher path never existed, so Auto always saved it unassigned). A daily 6:10 PM ET check also reports timed visits tomorrow through 3 days out that have no technician as one standing Schedule bell (rings when a new visit joins, clears at zero). Strict opt-in: exactly 'true', read at call time via unassignedVisitGuardLive(). Ships DARK; off = Auto behaves exactly as before and the check does nothing, no query. Sends nothing to a customer.)
 *   GATE_SMS_LINE_ADDRESS_FALLBACK=true (customer location line: blank/unmapped city falls through ZIP → geocode instead of the Bradenton default; mapped cities unchanged)
 *   GATE_HOME_LINE=true (each customer's outbound texts and staff-placed calls use their stored home line — config/locations.js homeLineLocationId — over any per-call office; read at call time via homeLineLive(); the daily sweep stamps it)
 *   GATE_SERVICE_REPORT_COMPLETION_CHOICES=true (searchable completion choices plus prior same-line recommendations; dark by default)
 *   GATE_TWILIO_VOICE=true      (enable voice call handling)
 *   GATE_VOICE_AI_AGENT=true    (enable bilingual AI voice backstop on unanswered calls)
 *   GATE_OUTBOUND_VOICEMAIL_SMS=true (admin click-to-call that hits the customer's voicemail hangs up and texts "sorry we missed you" instead)
 *   GATE_MISSED_CALL_TEXT_BACK=true (unknown caller waits 15s+, no answer, no voicemail — texts them back from the line they called)
 *   GATE_MISSED_CALL_TEXT_BACK_EMPTY_VOICEMAIL=true (text-back lane only: a 15s+ unknown caller whose voicemail recording held no speech — rejected or marker-only transcript — also gets the text; needs GATE_MISSED_CALL_TEXT_BACK; the missed-call bell is unchanged; dark by default)
 *   GATE_MISSED_CALL_TEXT_SKIP_FAILED_SCREEN=true (text-back lane only: no text to a caller who failed the press-1 pre-connect screen, call_log.metadata.preconnect_screen 'failed'; settles skipped:screen_failed; the missed-call bell is unchanged; dark by default)
 *   GATE_SMS_SHADOW_DRAFTS=true (silent house-voice shadow drafts of inbound SMS)
 *   GATE_SMS_UNANSWERED_REPLY=true (a suggested house-voice reply nobody acted on goes out on its own after 2 open hours, ordinary questions only; strict opt-in, read at call time via smsUnansweredReplyLive(), dark by default; customer-facing)
 *   GATE_VOICE_CORPUS_MINER=true (nightly brand-voice corpus mining)
 *   GATE_CALL_RESEARCH_MINER=true (nightly voice-of-customer call-research mining)
 *   GATE_SHADOW_JUDGE=true      (nightly shadow-draft vs human-reply scoring)
 *   GATE_SMS_AUTO_SEND=true     (autonomously send verified house-voice drafts for graduated intents)
 *   GATE_SMS_GRATITUDE_REPLIES=true (allow the delayed gratitude-only auto-reply lane; independent of GATE_SMS_AUTO_SEND)
 *   SMS_GRATITUDE_ACTIVATED_AT=<ISO timestamp with offset> (strict live-webhook cutoff for gratitude replies)
 *   GATE_BLOG_BODY_IMAGES=true  (autonomous posts get ≥2 generated in-article images)
 *   GATE_CRON_JOBS=true         (enable all automated cron jobs)
 *   GATE_WEBHOOKS=true          (enable inbound webhook processing)
 *   GATE_TERMITE_ANNUAL_PLAN=true (estimator emits the Subterranean Termite Protection plan — station setup fee + prepaid annual fee, 1 inspection/yr — when an estimate requests plan 'annual_protection'; also requires GATE_CANCEL_FLOW_V2 for online nonrenewal; dark = today's quarterly program; flip only after the agreement v3 sign-off, ruling A-11)
 *   GATE_SIGNUP_SINGLE_EMAIL=true (ONE email at recurring signup: the accepted-onboarding email also carries the property and the plan (no payment section: the "Auto Pay is set up" email stays its own email, owner 2026-09-30), and the separate membership.started / welcome emails are skipped ONLY when that combined email was accepted for sending — each still sends if it was not; same-day later acceptances get a short per-property email; the welcome TEXT is unchanged; strict === 'true', read at call time; dark in dev AND prod)
 *   GATE_EMAIL_TEMPLATE_AUTOMATIONS=shadow (runs created + finalized as would_send, nothing dispatched) | true (live sends)
 *   GATE_LEAD_ESTIMATE_AUTOMATION=true    (generate priced lead draft estimates)
 *   GATE_LEAD_ESTIMATE_AUTO_SEND=true    (auto-send generated lead estimates)
 *   GATE_LEAD_TURNSTILE=true    (enforce Cloudflare Turnstile on the public lead webhook)
 *   GATE_LAWN_ASSESSMENT=true   (public lawn-assessment photo funnel — paid vision per upload)
 *   GATE_PUBLIC_WATERING_PLAN=true (owner 2026-10-31, backlink tools plan step 2, 'ok go, approved'): public lawn watering calculator API + embed; dark until flipped; no paid AI; weather from the existing Open-Meteo plan, MRMS and NWS. GET /api/public/watering-plan answers one JSON plan for a curated Florida location or ZIP: last 7 days of observed rain (NOAA MRMS merged with Open-Meteo), the plan-week forecast, the turf's weekly need (ET0 x crop coefficient, seasonal fallback) and the week's run/hold decision from the same engine as the Monday irrigation email. The legal ceiling is the county's restriction policy (config/irrigation-restrictions.js) and it fails closed: outside established coverage the answer is need_only (inches, no event count, no legal maximum). No customer row, no database write, nothing sent to anyone. 120 requests per 15 minutes per IP. Read at call time via publicWateringPlanLive(), strict 'true', dark by default; off = every request to /api/public/watering-plan, any method, answers the generic 404 in server/index.js before the wildcard CORS handler, the global /api/ limiter and this route's own limiter. Kill switch: unset.)
 *   GATE_AGENT_ACTIVITY=true    (Activity tab in /admin/agents — read-only feed over existing ledgers; dark in dev AND prod)
 *   GATE_OPS_DIGESTS_IN_APP=true (owner ops digests become ops_digest bell rows in the Activity feed instead of contact@ emails; dark in dev AND prod)
 *   GATE_CLOSEOUT_MONEY_COMMS_ALERTS=true (closeout alerts also map the comms / invoice / invoiceDelivery facts — failed completion notice, invoice owed but not minted, invoice or receipt delivery incomplete — as per-visit cards + closeout_gaps_today members; their outage holds the floor; read-only, no comms; dark in dev AND prod)
 *   GATE_PEST_IDENTIFIER=true   (public pest-identifier photo funnel — paid vision per upload)
 *   GATE_CUSTOMER_PHOTO_ID=true (authenticated customer Photo ID API — POST/GET /api/photo-id/*, comms-free; dark: every handler 404s while off)
 *   GATE_CUSTOMER_PHOTO_ID_ISSUES=true (customer pest Photo ID issue association + observation dates; strict opt-in in every environment; requires GATE_APP_PROPERTY_SCOPE)
 *   GATE_PHOTO_ID_V2=true (customer Photo ID PEST path calls the v2 species-catalog engine, identifyPestV2 — server/services/photo-id-v2/pest-engine.js — instead of v1's identifyPest; layered on GATE_CUSTOMER_PHOTO_ID, which must also be on. Response keeps every v1 field and ADDS `v2`; the customer v2 object is persisted with no migration, embedded in the existing report_contract jsonb column under a `v2` key. A v2 engine failure (ok:false) answers the SAME 503 the v1 path already does — never a silent fallback to v1. Stored v2 answers are served back (history headline, next step, detail `v2`) only while the gate is on. Dark = today's v1-only pest path, byte-identical, for new AND already-stored rows. Owner 2026-10-02: ON also sends lawn and tree_shrub (palm posts to tree_shrub with subject 'palm') through the plant engine's Gemini-only workup (identifyPlantV2, ladder 'gemini_only'), adding `v2` beside the still-computed v1 scores — lawn embeds it in report_contract.v2, tree_shrub in result_v2; OFF = both v1-only, byte-identical.)
 *   GATE_PHOTO_TRIAGE=true      (inbound photo texts that read like a lawn/plant/pest "what is this" run the admin photo assessment and park ONE pending reply draft for owner approval — never sends; paid vision capped by PHOTO_TRIAGE_DAILY_CAP per ET day, default 20, and the paid caption classifier by PHOTO_TRIAGE_CLASSIFIER_DAILY_CAP, default = the vision cap; a triage candidate skips the legacy AI draft; read at call time; dark in dev AND prod)
 *   GATE_AUTOPAY_CUSTOMER_SMS=true       (enable customer-facing autopay SMS)
 *   GATE_PORTAL_METHOD_REMOVAL_GUARD=true (portal DELETE /api/billing/cards/:id refuses the method Auto Pay is using — 409 autopay_method_in_use — and never mutates Auto Pay as a side effect; off = legacy remove-and-silently-disable)
 *   GATE_PORTAL_CARD_REMOVAL_HOLD_NOTICE=true (portal GET /api/billing/cards stamps holdsAppointment on a card holding a future secured visit, so Remove opens the call-us disclaimer; removal itself is never blocked — off = field absent, payload unchanged)
 *   GATE_PAYMENT_METHOD_CHANGE_EMAILS=true (customer lifecycle emails for Auto Pay turned OFF and saved method REMOVED — portal, and Stripe-dashboard detaches via webhook)
 *   GATE_INCIDENT_EVAL=true     (weekly live-LLM incident regression eval)
 *   GATE_CALL_REPLAY_EVAL=true  (weekly reviewed-call extraction replay eval)
 *   GATE_VOICE_RELAY_EVAL=true  (weekly voice relay conversation eval)
 *   GATE_ADS_BUDGET_LIVE_PUSH=true (capacity cron pushes budget changes to Google Ads)
 *   GATE_ADS_CAPACITY_WORK_DAYS=true (ads capacity counts a technician only on dates they work: absences and, with GATE_TECH_WORK_DAYS, off weekdays; strict 'true', read at call time via adsCapacityWorkDaysLive(); off = every assignable technician every day; changes ad budgets only, sends nothing to a customer)
 *   GATE_ADS_GAP_RULE=shadow|true (the 2-hour Google Ads budget job decides from the technician's next 7 days of open stops instead of one day: runs the ad at its base budget while open stops are plentiful, drops it to the 1% floor when few are left, and keeps its state between; the owner can also hold a campaign at base or stop until a chosen end date. 'shadow' records what the new rule would do and changes nothing; 'true' makes it the rule. Read at call time via adsGapRuleMode(); unset or anything else = off, byte-identical to today. Changes ad budgets only; sends nothing to a customer)
 *   GATE_SECOND_TECH_LOWS=true (owner 2026-10-25, second technician census lows L1 + L3: (L1) the admin dashboard tech utilization counts only assignable field staff (active and field-dispatchable) and, for each, only the days in the window they work (technicians.work_days; no list = every day), 8 hours a work day, instead of every active row on every calendar day; (L3) the four Intelligence Bar schedule-tool sites that pick a technician by name text with an unordered first() match use resolveTechnicianByName instead: assignable technicians only, and a name that fits two technicians is an error that lists them, never a guess. Strict opt-in: exactly 'true', read at call time via secondTechLowsLive(). Ships DARK; off = both paths byte-identical to before. Admin-only, sends nothing to a customer.)
 *   GATE_BOOKING_FUNNEL_CANARY=true (alert when /book funnel entries see zero conversions)
 *   GATE_LLM_DISPATCH_METRICS=true (log dispatcher outcomes + daily exception digest email)
 *   GATE_LLM_CALL_LEDGER=true   (one llm_dispatch_log row per provider call — tokens, latency, served model, lane / run correlation; dark in dev AND prod)
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
 *   GATE_LEAD_TO_CASH_SWEEP=true (daily 6:55 ET read-only lead-to-cash invariants sweep — FIX: email to contact@ only on findings; never writes)
 *   GATE_CONTACT_CORRECTION=true (auto-apply customer-stated name/email/address corrections from inbound SMS and processed calls)
 *   GATE_REPORT_CROSS_SELL=true (live service-report cross-sell offer card with estimator pricing)
 *   GATE_REPORT_CLICK_TO_ESTIMATE=true (priced cross-sell tap mints a real estimate and redirects into it)
 *   GATE_REPORT_PLAN_SUMMARY=true ("Your plan" section on the LIVE report: an active plan member's visit/re-service COUNTS for this year — never prices, owner ruling 2026-09-28; live view only, stripped from PDF/static like nextAppointment; dark = report payload carries no planSummary)
 *   GATE_REPORT_NEAR_YOU=true  ("Near you" line on the LIVE LAWN report only: the lawn pest most often found among other lawn customers in the same city over the last 30 ET days, shown only at/above the NEAR_YOU_MIN_CUSTOMERS distinct-customer floor — owner ruling 2026-09-28, "lawn only"; live view only, stripped from PDF/static like planSummary; dark = report payload carries no nearYou)
 *   GATE_STAMPED_ZERO_FREE=true (a scheduled_services.estimated_price stamped exactly 0 — not NULL, not '' — bills nothing in EVERY billing lane: per-application, per-visit, monthly_membership, legacy-null, annual prepay; owner ruling 2026-09-28, waves-billing skill invariant #8, "$0 means charge nothing", superseding invariant #6's monthly-fallback note while the gate is on. NULL/blank is unchanged — still falls through to per_application_fee / monthly_rate as today. Off = byte-identical to today on every path; canonical CALL-TIME reader stampedZeroFreeLive(). Kill switch: unset or any non-'true' value.)
 *   GATE_CALL_PROPERTY_ROLE=true (call-classified property roles: fill unknown occupancies + park a one-click property_role_confirm review card)
 *   GATE_RESERVICE_REPORT_COPY=true (re-service/callback customer reports key off service_records.is_callback: lawn-vs-pest hero copy below the honest V2 status branches, "$0 — included with WaveGuard" line on web + PDF for member tiers; unset = legacy name-regex headline)
 *   GATE_RESERVICE_REPORT_CARD=true (re-service report card: on a pest/lawn callback report whose reserviceReport block composed, the payload carries `reserviceReportCard` — a "You told us" section from the customer's booking words FROZEN onto service_data.reserviceRequest at completion (scrubbed with the report writer's customer-words scrub; picker/text = quoted, call/office = never quoted), a "What we did" summary (pests from product targets, where from areas_serviced, activity from the technician's tapped rating, the safety line only with a recorded wet application; performed visits only) and the "Still seeing X? Tell us" topic for the existing portal Schedule link, on the web report and the PDF (-rcd1 cache key). Read at call time by services/service-report/reservice-report-card.js, exact 'true', and only ever alongside GATE_RESERVICE_REPORT_COPY; off = payload, page and PDF key byte-identical to before. Kill switch: unset.)
 *   GATE_RESERVICE_DETAILS_REQUIRED=true (re-service picker's "What are you seeing?" box becomes required: any text counts, a pest chip alone does not replace it; GET /api/public/reservice/:token carries detailsRequired:true, the picker keeps Book disabled until the box has text, and POST answers 400 DETAILS_REQUIRED for a blank box. Read at call time via reserviceDetailsRequiredLive(), exact 'true'. Off = optional box, GET payload byte-identical. Sends nothing to a customer. Kill switch: unset.)
 *   GATE_RESERVICE_PHOTOS=true (re-service photos, optional: after a /reservice/:token booking the success card offers the visit-prep photo form for the visit just booked — the commit response carries prepPhotos {visitId, photosRemaining} and POST /api/public/reservice/:token/visits/:visitId/photos stores through services/visit-prep.js (entry 'reservice_page'), so the Visit Brief, office feed item, tech alert and photo reads apply unchanged. Needs GATE_VISIT_PREP_PHOTOS too; read at call time via reservicePhotosLive(), exact 'true'. Off = commit response byte-identical and the upload route 404s. Sends nothing to a customer. Kill switch: unset.)
 *   GATE_REVIEW_ALERT=true (bad-review bell: keeps one needs-you admin item open for every Google review of 1 to 4 stars that has no published reply, is not dismissed and is still on Google, written at or after this gate's activation boundary (stored once in system_settings at the start of the first gated review sync, two hours back, so turning it on never rings older reviews); checked after every review sync, closed when answered, rings again if a reply is removed; rules only, internal only, no customer send. Off unless exactly 'true'.)
 *   GATE_RESERVICE_OFFICE_REQUEST=true (New Appointment modal "Customer's words" box on a pest/lawn re-service: suggests the customer's latest inbound text or call note from the last 72 hours with a "Use this" button, saved to scheduled_services.customer_request/_source; the server decides the source — unchanged text/call = quotable text/call, edited or typed = office. Off unless exactly 'true' (isEnabled('reserviceOfficeRequest')); off = the modal shows nothing new, GET /api/admin/schedule/reservice-request-suggestion answers {enabled:false, suggestion:null}, and POST ignores customerRequest. Sends nothing to a customer.)
 *   GATE_SOUTH_ZONE_DAY_FUNNEL=true (estimate picker funnels far-south zones onto days with an existing zone stop, seeding one day when none exists)
 *   GATE_ZONE_ROUTE_DAYS=true (customer-facing booking + estimate picker lift the self-serve detour cap on a far zone's route day — default Friday for Venice / North Port — so an EMPTY route day can be offered and seeded; config in system_settings key schedule_zone_route_days; phone/office/IB/auto-dispatch untouched; read at call time via zoneRouteDaysLive(); unset = today's cap everywhere)
 *   GATE_JOB_CARD=true (Service Protocol drawer "Job card" tab: customer paragraph (deterministic template of portal fields, built on each read), per-product spray check from NWS hourly at the property, tank mix search; read at call time; unset = tab hidden, endpoint answers {enabled:false})
 *   GATE_JOB_CARD_CUSTOMER_CONTEXT=true (job card "Why they booked" box, owner "ok go" 2026-10-03: the visit's own scheduled_services.customer_request / _source / _pests — typed on the re-service page or texted (quoted), a call's AI summary or the office's wording (not quoted), and the pests picked; the customer's own inbound texts from the 14 ET days up to and including the visit's day, never past now (owner 2026-10-03: a fixed window, not "since the last visit"), newest three, tapbacks, recruiting rows and unresolved review-ask reservations dropped, null = unreadable; and, only with GATE_VISIT_PREP_PHOTOS live too, the photos the customer sent before the visit (visit-prep.js customerFlaggedFacts: topic, place, note, photo ids; thumbnails from GET /admin/schedule/:id/visit-prep-photos) — words code-scrubbed, shown under the paragraph. Display only: never in the paragraph, its grounding hash or a model call. Read at call time by services/job-card.js, exact 'true'; off = card payload byte-identical. Sends nothing to a customer. Kill switch: unset.)
 *   GATE_REPORT_PHOTO_CONTENT=true (tech-reviewed completion-photo captions/summary ground the AI report writer; read at call time via reportPhotoContentLive(), off unless exactly 'true')
 *   GATE_REPORT_WRITER_RULES=true (owner rules for the AI service report, owner "go" 2026-09-30, four-section report owner "ok go" 2026-10-01: WHAT WE FOUND / WHAT WE DID AND WHY / WHAT TO EXPECT / WHAT'S NEXT, length by the record, timeframes only from approved expectation wording, the reach-out date on one-time services and re-services, no booking state in the text (the report shows the next visit live); four-section notes are read only while this switch is on; one OWNER RULES block, no product/active names, amounts, footage, "safe", "per visit" or other company names in the copy, the technician note sorted by provenance, customer messages labeled and scrubbed, and output screens that reject what slips through. Every writer EXCEPT lawn and tree/shrub/palm, which stay byte-identical (owner: another lane owns them). Also the promise check at completion (owner "ok yes add these" 2026-10-01): the completion form lists the customer's open technician promises (GET /admin/dispatch/:id/promises), the report says only what the tech marked, Done closes the promise and Partly adds a still-left note (visit-promises.js). Off unless exactly 'true', read at call time via reportWriterRulesLive(); off = byte-identical prompts, inputs and screens, and no promise check)
 *   GATE_REPORT_BLOG_POST=true (Waves blog post on the service report, owner "ok go" 2026-10-01: the completion forms search the live Waves blog (GET /admin/dispatch/:id/blog-posts), the picked post is frozen on the record at completion (structured_notes.blogPost: title and live URL on the site's own host) and the customer's report shows it at the bottom as "From the Waves blog". Strict opt-in: exactly 'true' in every environment, read at call time via reportBlogPostLive(). Ships DARK; off = the search answers {available:false}, a picked post is ignored at completion and the report shows none, frozen ones included.)
 *   GATE_TECH_TIP_SOURCES=true (tips with facts, owner 2026-10-24: a library tip that names fact-register sources freezes its sourced words and its citations at completion, and the live report prints each citation's label as a link after the sentence, inside the quote, never the raw URL. Read at call time via techTipSourcesLive(); report-data re-checks every frozen citation against the host rule before it prints. Strict opt-in: exactly 'true'. Ships DARK; off = the freeze and the report are byte-identical to before, and frozen citations do not print.)
 *   GATE_REPORT_ASK_AI=true (service report "Ask Waves" answers written by AI, owner 2026-10-05, "use sonnet 5.5": POST /api/reports/:token/ask builds a short fact sheet from the report (service, date, technician first name, weather, pest pressure label, the customer's concern and the reviewed report sections, each applied product's approved plain wording, label precaution and re-entry text with inside or outside from the recorded area, the re-entry status; never the appointment, amounts, rates, totals, EPA numbers, prices or the per-product target pests) and has Claude Sonnet 5.5 (TEXT_POLICIES.reportAsk, OpenAI backup, MODEL_REPORT_ASK) answer the question in one to four plain sentences, screened by the report copy guards (no "safe", guarantees, prices, amounts). Pest, lawn and tree & shrub reports only (ruleAnswerReason): termite, rodent, mosquito and specialty reports, typed reports and reports with a visible companion section keep the fixed-rule answer. The recorded instructions the fixed-rule answer states are sent as required lines; a system-written line (watering aftercare, pet precaution, rinse caution) must stand as its own whole sentence of the AI answer word for word, and an answer that carries required lines may hold no dismissal anywhere (ignore, disregard, not true, no longer, outdated, you can skip; before or after the line), else the fixed-rule answer is used; next-visit and schedule questions keep the fixed-rule answer; any technician-sourced required line (recommendations, primary next step, finding recommendations) skips the model and keeps the fixed-rule answer. A miss, a timeout (about 8 s), an empty or rejected answer returns the old fixed-rule answer. The stored event stays question_length and topic; the question text is never stored or logged. Strict opt-in: exactly 'true', read at call time via reportAskAiLive(). Ships DARK; off = the fixed-rule answer alone, byte-identical, no model call.)
 *   GATE_STANDARD_WORDING_PREVIEW=true (owner mockup approval 2026-10-03: when a typed visit's record says nothing was found, the office Complete Service form, which greys out Generate AI report for it, shows the exact standard sentences the customer's report will use: POST /admin/dispatch/:id/standard-wording { values, activityScore } builds the report's own Today's Result as /complete builds it (the visit's own form, the score the completion keeps, the visit number and trend from the customer's earlier scores) and answers them only when the report would keep its standard wording (service-report/standard-wording-preview.js). Read-only, display-only. Strict opt-in: exactly 'true', read at call time via standardWordingPreviewLive(). Ships DARK; off = the route answers { available: false } and the form shows no card.)
 *   GATE_BLOG_SEARCH_SUGGEST=true (Suggest a post from the completion forms' blog search, owner mockup approval 2026-10-03; owner ruling 2026-10-02: straight into the autonomous blog queue, written and published automatically, no approval step. With GATE_REPORT_BLOG_POST on, a search no live post holds every word of says so, shows the closest posts and offers "Suggest a post about …" to the office (an admin login only): POST /admin/dispatch/:id/blog-suggestions writes one operator-pinned new_supporting_blog row into opportunity_queue (bucket operator_intercept, score 79, no city, service and specialty topic inferred from the phrase, signal_metadata.source tech_blog_search; unlike a manifest intercept it is SERP-profiled, the router's public-health, navigational and do_not_publish demotions apply to it, and the quality gate waives only GSC evidence), refusing a near-me, out-of-area or personal-data phrase (a customer's name in our records included), one with a letter outside a-z, a search a live post now covers, a topic the chain tried and skipped (declined), or more than 10 a person a day; the same phrase from any source answers already_queued. The tip seeder (server/scripts/seed-tech-tip-blogs.js, tips with facts) writes through the same path, at most five hand-picked tip topics a run, and refuses to write while this gate is off. The phrase is never logged. Strict opt-in: exactly 'true', read at call time via blogSearchSuggestLive(). Ships DARK; off = the search answers suggest:false, the forms show no button, the route answers 404 { enabled: false }, and suggestions already queued are not claimed (opportunity-queue fences source tech_blog_search; they wait, and expire unclaimed after 45 days).)
 *   GATE_PORTAL_CHAT_FACTS=true (portal Waves Assistant payment card: a charge / payment / receipt question shows the customer a server-rendered card of their last three payments from the Billing tab's own read, plus an Open Billing button; the model is told only that it was shown and the status words. Off unless exactly 'true', read at call time via portalChatFactsLive(); needs PORTAL_CHAT_SELF_SERVE live (default on). Off = the self-serve chat alone, byte-identical. Sends nothing to a customer.)
 *   GATE_PORTAL_CHAT_VISIT_FACTS=true (portal Waves Assistant past-visit answers: a question about what was done at a visit, when the last visit was, or where the report is reads the customer's last three completed visits from the Completed tab's own read; the model answers from the structured facts — date, service, technician first name, kinds of product applied — and the customer sees a server-rendered card with each visit's reviewed summary and report link; the owner-approved company facts join the portal prompt. The summary text, prices, product brands and addresses never reach the model. Off unless exactly 'true', read at call time via portalChatVisitFactsLive(); needs PORTAL_CHAT_SELF_SERVE live (default on); independent of GATE_PORTAL_CHAT_FACTS. Off = byte-identical. Sends nothing to a customer.)
 *   GATE_PORTAL_CHAT_RESERVICE=true (portal Waves Assistant free re-service offer, PEST ONLY unless GATE_PORTAL_CHAT_RESERVICE_LAWN is also on (the next entry adds the lawn line; with it off, lawn problems hand off with topic pest_problem): a customer whose message this turn is an active pest report (the SMS flow's isActivePestReport, no separately priced specialty) gets a server-built button to the /reservice booking page when that page's own verdict says the pest lane is bookable and no address hold applies, a button to move an already booked pest re-service when the reschedule page would move it, and a hand-off otherwise; never under a secondary saved-property selection (the page books at the primary address). The model never decides a visit is free. Also needs GATE_RESERVICE_SELF_SERVE and GATE_RESERVICE_STREAMLINE. Off unless exactly 'true', read at call time via portalChatReserviceLive(); needs PORTAL_CHAT_SELF_SERVE live (default on); independent of the other portal chat gates. Off = byte-identical apart from portal chat's newest-first history read. Sends nothing to a customer.)
 *   GATE_PORTAL_CHAT_RESERVICE_LAWN=true (the LAWN line of the portal assistant's free re-service offer, owner ruling 2026-10-03: the chat model judges whether the customer is reporting a lawn problem happening now and quotes them; the server verifies the quote is word for word in that turn's message and names a lawn subject, refuses a separately priced specialty, then applies the same /reservice page verdict as the pest line. No lawn word list. Honoured only while GATE_PORTAL_CHAT_RESERVICE is live. Off unless exactly 'true', read at call time via portalChatReserviceLawnLive(). Off = the pest-only offer, byte-identical. Sends nothing to a customer.)
 *   GATE_PORTAL_CHAT_EMAIL_CHANGE=true (portal Waves Assistant confirmed email-change hand-off, owner ruling 2026-10-02: a customer who asks to change their email types the new address, the chat reads it back, and once they confirm it the office gets ONE bell with the address on file and the new one; staff make the change. The chat model judges whether the customer confirmed; the server verifies the address is one the customer typed in that chat, and sends only the exact address its own read-back instruction carried in the previous turn and the assistant's reply showed. Nothing writes the customer row and no self-serve email edit exists. Off unless exactly 'true', read at call time via portalChatEmailChangeLive(); needs PORTAL_CHAT_SELF_SERVE live (default on); independent of the other portal chat gates. Off = byte-identical. Sends nothing to a customer.)
 *   GATE_PORTAL_YARD_CALENDAR=true ("Your yard this month" card in the logged-in portal, owner-approved 2026-10-01: the month's lawn, shrub and weed pressure from the species-catalog yard calendar, filtered to the customer's grass and plan lines, plus the same-city weather and household-pest forecast. Off unless exactly 'true', read at call time via portalYardCalendarLive(); off = GET /api/feed/yard answers {available:false} and the existing Local Conditions card renders exactly as before. Sends nothing to a customer.)
 *   GATE_PERMIT_DETAIL_SYNC=true (Manatee permit detail collection, address-match round 2 / R2-A: after the weekly report sync, a slow sequential pass reads each new-home permit's public ACA record page for conditioned and under-roof square footage, stories, bedrooms and bathrooms into construction_permit_records. Off unless exactly 'true', read at call time via permitDetailSyncLive(); independent of GATE_PERMIT_SYNC. Collects only: nothing reads it for a lookup or a price yet, nothing is sent to a customer. Kill switch: unset.)
 *   GATE_LOOKUP_LISTING_SIZE=true (address-match PR 5b, owner 2026-10-02: a commercial suite with no caller-stated size is priced off a size a public listing publishes for THAT suite. Plain code reads Google result snippets (DataForSEO; LoopNet and Crexi refuse every server fetch) and fetchable broker pages for a figure next to the typed street number and suite; a range or two different figures never count; no model reaches the number. Ranks below a caller/tech-stated size, above the DBPR license seats and the type default; draft stays yellow with the link. Off unless exactly 'true', read at call time via lookupListingSizeLive(); off = no search, no fetch, byte-identical ladder. Kill switch: unset.)
 *   GATE_LOOKUP_ADDRESS_STATUS=true (address-match PR 4: the admin estimate tool's property lookup shows one address status line from Google Address Validation, apart from the county roll's own answer: Address confirmed / Building confirmed, unit missing / Address needs confirmation / Outside the service area / Validation unavailable, with Google's business or residential classification. No scope effect: no measurement, flag, cache row or price changes. One validation call per address per 24 h, 4 s cap, fail-open to unavailable; needs ADDRESS_VALIDATION_ENABLED. Off unless exactly 'true', read at call time via lookupAddressStatusLive(); off = no call and a byte-identical response. Kill switch: unset.)
 *   GATE_LOOKUP_BUSINESS_IDENTITY=true (address-match PR 5: the admin estimate lookup and the estimator engine ask Google Places which operating business sits at the street number and read its type and tenant count, so a storefront with its own street number inside a plaza parcel is no longer priced off the whole building or a satellite guess. Needs GATE_COMMERCIAL_SUITE_SIZING and only runs for the opted-in admin lookup and engine, never a public route. A matched business with part-building evidence is one suite; one with none of that is scope_unresolved, no price until the CSR answers "just your space or the whole building?". Deterministic, no AI reaches a size or price. Off unless exactly 'true', read at call time via lookupBusinessIdentityLive(); off = no Places call and byte-identical output. Kill switch: unset.)
 *   GATE_LOOKUP_PERMIT_FACTS=true (address-match round 2 / R2-B: the property lookup reads the home's own Manatee building permit facts (conditioned and under-roof square footage, stories; collected by GATE_PERMIT_DETAIL_SYNC into construction_permit_records) when the county roll has no building for the address, and the admin estimate tool and the estimator engine prefill home sq ft from them as a sourced estimate above the plat median, always flagged for confirmation and never as a measurement. Off unless exactly 'true', read at call time via lookupPermitFactsLive(); off = no permit read, byte-identical lookup, profile and draft. Kill switch: unset.)
 *   GATE_LLM_COST_TRACKING=true (estimated AI spend: a weekly pull of OpenRouter's public per-token prices into llm_model_prices (never hand-typed), estimated cost per lane on the Agents hub Control center from the call ledger's tokens (needs GATE_LLM_CALL_LEDGER for rows to exist), and a daily 7:40 AM ET check that raises ONE admin item when a lane's spend yesterday is at least LLM_COST_ALERT_MIN_USD (default 5) and LLM_COST_ALERT_MULTIPLIER (default 3) times its average day over the week before; services/llm-cost.js; internal only, no customer sends; ships DARK, read at call time via llmCostTrackingLive(); unset = off, the hub shows no cost and nothing is fetched)
 *   GATE_TYPED_DECISIONS=true (typed yes/no decisions from TypeSafe Jev, pinned model ROUTES.typedDecision; services/typed-decisions/jev.js askPackage answers a registered decision package or returns {ok:false, reason:'gate_off'}; shadow/evidence only, no customer sends; ships DARK, read at call time via typedDecisionsLive(); unset = off)
 *   GATE_CALL_INCIDENTS=true (correction loop for calls: the nightly 04:10 ET job turns each self-audit field disagreement into an ai_incidents row, confirmed only when a second model on the other provider from the auditor's, reading the call blind, reaches the auditor's answer and both readers' excerpts are in the transcript (unknown auditor provider or a truncated call stays a lead); Sunday 04:50 fix proposals for calls; services/call-incidents.js. Adds about one fast-tier OpenAI call per finding; shadow data only, no customer sends; honoured only while GATE_CALL_SELF_AUDIT is on; ships DARK, read at call time via callIncidentsLive(); unset = off)
 *   GATE_VISIT_ACCESS_FLAGS=shadow (visit access and safety flags, shadow leg: the hourly :34 sweep 05:34 to 19:34 ET puts visit_access.v1, six yes/no reads, to the typed-decision providers for today's and tomorrow's open visits and records the answers in decision_reviews under subject_type scheduled_services; services/typed-decisions/visit-access-shadow.js; codes never leave: the state says only whether codes are on file and every text is redacted; nothing is shown to a technician, written to a visit or sent; honoured only while GATE_TYPED_DECISIONS is live; ships DARK, read at call time via visitAccessShadowLive(); unset or any other value = off)
 *   GATE_TYPED_DECISIONS_CLEF=true (the same decision packages put to Cloudflare Clef on Workers AI as a second provider, ROUTES.typedDecisionClef, model MODEL_CLOUDFLARE_CLEF default clef-flash; askPackage(..., { provider: 'cloudflare' }); honoured only while GATE_TYPED_DECISIONS is live; shadow/evidence only, no customer sends; ships DARK, read at call time via typedDecisionsClefLive(); unset = off)
 *   GATE_PREPAY_MINT_PRICE_HOLD=shadow|true (stamp-time price check for every annual prepay, not only a /secure pick: a new term records each covered visit's price when it is created (activity_log annual_prepay_mint_visit_prices); `true` = a visit whose price changed since then is not stamped as covered, bills normally and raises the existing 'repriced visit left uncovered' office alert; `shadow` = the price is recorded and a would-hold is only logged. Termite annual plans are left out. Off = byte-identical to today: nothing recorded, nothing read. Canonical CALL-TIME reader prepayMintPriceHoldMode(). Kill switch: unset.)
 *   GATE_PHOTO_PRIVACY=shadow (photo privacy check, Clef second wave idea 3: each technician social post's photo is put to Cloudflare Clef as photo_privacy.v1 (face, person, readable address text, license plate, child, pet) AFTER the post is published and logged, and the answers land in decision_reviews for labeling; services/typed-decisions/photo-privacy-shadow.js. SHADOW ONLY: nothing is held, changed or shown to the technician; `shadow` is the only value honoured (anything else = off) and only while GATE_TYPED_DECISIONS_CLEF is live; ships DARK, read at call time via photoPrivacyMode(); unset = off)
 *   GATE_ASK_WAVES_JEV_CHECK=shadow|enforce (Ask Waves Jev second check: a model-written website chat reply is also put to Jev as ask_waves_safety.v1, two yes/no reads (a blanket safety claim, a re-entry or use time), beside the existing word list; services/typed-decisions/ask-waves-safety-check.js. `shadow` changes nothing a visitor sees and adds no wait: after the chat log writes the assistant row, both answers are recorded in decision_reviews (subject_type agent_messages); `enforce` also swaps a reply Jev flags for the reviewed safety copy the word list serves (waits at most 800 ms, any miss keeps the reply); reviewed copy and emergency turns are never asked; anything else = off; honoured only while GATE_TYPED_DECISIONS is live; ships DARK, read at call time via askWavesJevCheckMode(); unset = off)
 *   GATE_LAWN_JEV_TIMING_CHECK=off|shadow|enforce (owner 2026-10-28/29: a TypeSafe Jev result-timing check on each sentence of the model-written lawn DIAGNOSIS summary (the contract's customer_summary stored in lawn_diagnostics by the public lawn assessment, the tech lawn diagnostic persist and the admin Analyze photos button), package lawn_result_timing.v1, services/service-report/lawn-jev-timing-check.js; needs GATE_TYPED_DECISIONS; `shadow` = store unchanged, add no wait, then ask Jev and record the verdict in decision_reviews (subject lawn_diagnostics); `enforce` = wait up to 3 s before the insert and drop the sentences Jev flags, so the stored summary never carries them; a failed or late verdict keeps the text; a technician's typed aiSummary is never checked; anything else = off; ships DARK, read at call time via lawnJevTimingCheckMode(); unset = off)
 *   GATE_REPORT_PRODUCT_COPY=true (owner-approved 2026-09-28 wording page: three short customer-facing lines per applied product on the service report — "How it works", "Also labeled for", "Pets & kids" — matched to the applied catalog product by EPA registration number primarily, an explicit name-alias list otherwise; server/config/report-product-copy.js. Unmatched products get NO copy — fail closed, never guessed. Customer display, plus the "How it works" line as grounding for the AI report writer under GATE_REPORT_WRITER_RULES (owner "ok go" 2026-10-01: the writer explains why the work fits, never where it was applied). Off unless exactly 'true', read at call time via reportProductCopyGateOn() in report-product-copy.js; the gates-map entry below is for logGateStatus only)
 *   GATE_VAN_SCENE=true (the "look for this van" scene under the appointment header card and on the booking confirmation step; dev-open (every non-production NODE_ENV renders it regardless), prod dark; prod kill = unset)
 *   GATE_SLOT_TRAVEL_GAP=true (every customer-facing picker + commit gate requires modeled drive time + SLOT_TRAVEL_BUFFER_MINUTES (default 15) between consecutive stops; read at call time; unset = pure-overlap legacy)
 *   GATE_ESTIMATE_SERVICE_OPT_OUT=true (customer drops one recurring service line on a sent estimate; canonical engine re-price behind a dryRun preflight, no comms, no bell — STRICT opt-in in dev too)
 *   GATE_ESTIMATE_SERVICE_ADD=true (priced add-a-service on the opt-out rail — pest/lawn/mosquito join a sent estimate behind the same dryRun preflight; STRICT opt-in, needs the opt-out gate)
 *   GATE_ESTIMATE_LEAD_SERVICE_SEND=true (send-time lead-with-one-service: the second of exactly two recurring lines on a new customer's estimate is parked as a staff opt-out event before delivery; STRICT opt-in, needs opt-out + add)
 *   GATE_ESTIMATE_RETURN_VISIT=true (estimate page returning-visitor strip: visit number + named changes since the previous visit; read-only projection, no comms; dev-open, prod dark)
 *   GATE_HERMES_WATCHDOG=true (external agent watchdog: GET /api/integrations/watchdog-worker/status serves the PII-free health snapshot to the hermes_watchdog key and the 23-min liveness cron bells when the watchdog stops polling; off = 404 + cron no-op; kill = unset)
 *   GATE_EXTERNAL_HEARTBEAT_WATCH=true (outside daily jobs: an hourly cron rings ONE admin bell per silence episode when a job's job_health row shows no complete run today by its due time (appt-sweep on the office Mac, 07:00 ET) and closes it when one lands; writes only admin notifications; strict opt-in via gateEnvValue, read at call time; dark; kill = unset)
 *   GATE_ADMIN_OPS_QUEUE=true (Agents hub "Queue" tab: one read-only view of every long-running lane's pending / parked / failed rows — jobs, call processing, content parks, email approvals, IB confirmations, report delivery, follow-ups, open alerts; off = tab hidden, /api/admin/agents/queue 404)
 *   GATE_IB_MERGE_CUSTOMERS=true (Intelligence Bar merge_customers: the confirmed duplicate-merge write is offered in admin tool lists and executes; off = the tool is not offered on either the legacy or the platform path and a forced call refuses; the admin duplicates-queue route is unaffected; kill = unset)
 *   GATE_IB_DELETE_CUSTOMER=true (Intelligence Bar delete_duplicate_customer, owner ruling 2026-10-07: an admin can ARCHIVE ONLY (soft-delete, nothing merged or moved, the other record untouched) ONE empty duplicate customer record - one that holds only the fields the unknown-caller stub creator writes, no linked rows, and that the duplicate queue lists as a confirmed same-identity duplicate of a record sharing its phone (a possible match, such as a different name, goes to merge_customers) - from a confirm card, through the customer page's own DELETE /api/admin/customers/:id handler; restorable via PATCH /api/admin/customers/:id/restore; never owner-direct; sends nothing to a customer. Strict opt-in: exactly 'true', read at call time via ibDeleteCustomerLive(). Ships DARK; off = the tool is not offered on either path and a forced call refuses; kill = unset)
 *   GATE_IB_OWNER_DIRECT=true (Intelligence Bar owner-direct mode, owner ruling 2026-10-01: for the owner login only (ibFullAccess) the bar takes the record it picks as the target with no target refusals, runs internal edits — lead/customer/property fields, statuses, notes, tech assignment, reschedule, stock — without a confirmation card, and answers in 1–3 lines; customer messages, money and bulk changes keep their one-tap card; every other login is unchanged; off = byte-identical to today; kill = unset)
 *   GATE_IB_TOOL_ACTIVITY=true (Intelligence Bar answers carry a toolActivity list — one operator-facing line per tool the exchange ran: label, done/error/proposed, duration — rendered above the answer in the ⌘K palette; off = response byte-identical to today)
 *   GATE_CALL_TRANSCRIPT_SYNC=true (admin call log: diarized transcript segments render as a clickable, audio-synced list — click a line to seek the recording; off = today's plain-text transcript)
 *   GATE_CALL_UNCLEAR_SERVICE_ASSESSMENT=true (call routing: a call with a confirmed on-the-hour time and a trusted address is no longer held only because the service is unclear — ambiguous_pest_or_service fails open so the Waves Assessment fallback books it; needs GATE_CALL_FAIL_OPEN_BOOKING; the office still gets the advisory card; off = byte-identical today)
 *   GATE_CALL_WHOLE_STRUCTURE_NO_UNIT=true (call booker: a WDO inspection or termite pre-treat on a unit-less duplex/building address is not held for the missing unit; condo/apartment interior work still is)
 *   GATE_CALL_BUSINESS_WHOLE_BUILDING_NO_UNIT=true (call booker: a business address (Google addressUse.business) given with no unit is not held for the missing unit when the caller says they own/lease/occupy the WHOLE building; the extraction judges it and the code verifies the pinned caller quote; suite/unit/strip-mall wording keeps the hold)
 *   GATE_CALL_FIRST_NAME_ADVISORY=true (call booker: a new caller who gave a last name but no first name still becomes a customer and books; the missing first name files an advisory office card instead of holding the booking; strict opt-in, read at call time)
 *   GATE_TECH_DICTATION_UPLOAD=true (tech completion notes: when the browser has no SpeechRecognition — iOS home-screen PWA, Firefox — the mic records with MediaRecorder and POSTs the clip to /api/tech/services/:id/dictation for server transcription; off = today's behavior, mic hidden without SpeechRecognition)
 *   GATE_ESTIMATE_LAWN_CALENDAR=true ("Your program" block under the lawn price card — annual application count + four plain season rows behind a toggle; count from the scheduling catalog on /data; dev-open, prod dark)
 *   GATE_ESTIMATE_SUCCESS_REFERRAL=true (referral share card on accepted / just-accepted estimate screens + POST /:token/referral-link; enrolls on the tap only; dev-open, prod dark)
 *   GATE_REFERRAL_INBOUND_CONFIRM=true (owner 2026-10-26 "YES GO": the Referrals Queue lists plan customers who came in through a referral link (?ref=CODE on their landing page) or named a referrer on their first call, with the likely referrer; the office confirms the referrer or marks "not a referral". Confirm makes the referral row and runs the existing conversion; when a performed recurring visit is on record, both $25 credits post at once, otherwise at the next performed recurring visit as today; either way the referrer gets one thank-you email at the next 9:00 AM ET and no reward text (owner 2026-10-29). Read at call time via referralInboundConfirmLive(), strict 'true', dark by default; off = the list and both actions are hidden.)
 *   GATE_REFERRAL_INBOUND_BELL=true (owner 2026-10-29 "ok go": one admin bell row for each card waiting in Referrals → Queue, with server-set buttons that run the Queue's own steps: Confirm <referrer>, only for one sure referrer, while rewards wait for the first visit, before the friend's first plan visit and not at a milestone (checked again under the confirm's locks), and Not a referral; the row closes when the card is answered in the bell or the Queue. Acts only while GATE_REFERRAL_INBOUND_CONFIRM is on. Read at call time via referralInboundBellLive(), strict 'true', dark by default; off = no row is raised, and no button is served or run.)
 *   GATE_ALERT_CLOSE_BUTTONS=true (owner 2026-10-29 "ok go", PR 2 of the bell buttons: close-only buttons the server sets on three admin bell rows, Handled on a customer's texts and Called back on a call-back follow-up and a missed call; a tap is the bell's own Done with that note and sends no reply and places no call. Read at call time via alertCloseButtonsLive(), strict 'true', dark by default; off = the rows serve no such button and a tap answers 409.)
 *   GATE_BID_ALERT_BUTTONS=true (owner 2026-10-29 "bid buttons, as a trial", PR 3 of the bell buttons: No bid on a new bid invite's bell row, and Bid only once the bid's due date is confirmed; a tap runs the Bid desk's own save step, sends nothing to a buyer or customer and moves no money. Week-1 read-out: ops job bid-buttons-trial-week1, Nov 5. Read at call time via bidAlertButtonsLive(), strict 'true', dark by default, and only while GATE_BID_DESK is on; off = the rows serve no such button and a tap answers 409.)
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
 *   GATE_PAY_AFTER_FIRST_VISIT=true (owner ruling 2026-09-30, "customers should save card, and then pay after first visit, throughout": the estimate page tells a customer on the card-on-file rail that nothing is charged today and the setup + first application are billed at the first visit — that is what the rail already does for the pay-per-application self-pay accept (card saved at accept, invoice attached to the first visit with no pay link, charged at completion). Customers OUTSIDE the rail (plan members, payer-billed, invoice-mode, commercial manual billing, one-time) and the setup-only shape keep today's wording. Needs RECURRING_CARD_ON_FILE. Moves NO money and sends NO message by itself; the setup-only and annual-prepay accepts are NOT changed by this gate (see estimate-public.js accept notes). Read at call time via payAfterFirstVisitLive(); strict 'true', dark in every environment. Off = byte-identical to today.)
 *   GATE_PAF_EXISTING_CUSTOMERS / GATE_PAF_SETUP_FEE / GATE_PAF_PREPAY / GATE_PAF_TERMITE =true (per-item rollout switches for the pay-after-first-visit program, owner ruling 2026-09-30; each is live only when BOTH GATE_PAY_AFTER_FIRST_VISIT and its own var are exactly 'true': existing customers adding a service, the monthly-tier setup fee, annual prepay charged after the first visit, termite annual charged after installation. Read at call time via pafExistingCustomersLive() / pafSetupFeeLive() / pafPrepayLive() / pafTermiteLive(); dark in every environment. Plumbing only until each item's own PR lands: reading them moves NO money and sends NO message. GATE_PAF_EXISTING_CUSTOMERS is live as of PR-B: an eligible existing customer (per-application / per-visit lane; NOT monthly-membership or annual-prepay lane) adding a service stops being exempt from the card rail in resolveRecurringCardPolicyForEstimate — card saved or already on file, invoice attached to the first visit, no pay link at accept, charged after the visit; a paused Auto Pay customer keeps the card but is never un-paused or auto-charged, and gets the normal pay link after the visit. GATE_PAF_SETUP_FEE is now consumed (PR-C): on the card rail, a monthly-tier (setup-only) accept stamps the WaveGuard setup fee on the first visit's series parent (scheduled_services.pending_setup_fee) instead of minting a payable unattached invoice, the first PERFORMED completion bills it on the visit's own invoice (one charge), and the estimate page / accept notification say so. GATE_PAF_PREPAY is consumed server-side (PR-D): an in-lane annual prepay accept still quotes and binds the exact cents and method, but the quote names the after_visit_prepay authorization and the resubmit must attest it; nothing is charged and no pay link is sent at approval. The durable charge job waits as 'awaiting_first_visit' (estimate_data.prepayAutoChargeJob.deferred_to_first_visit), the plan's visits are held (never billed per visit) while the term is payment_pending, the 15-minute prepay sweep releases the job after the first PERFORMED visit and charges the bound method for the acknowledged total or less (never more), a decline sends the pay link plus one office alert and keeps later visits held, no performed visit in 14 days raises one office alert, and a year voided or cancelled before any visit charges nothing. PR-E: /data recurringCardPolicy.prepayAfterFirstVisit drives the React page's after-visit wording, the capture/confirm consent text and the attestation.)
 *   GATE_ANNUAL_PREPAY_ADDON_BILLING=true (completing an annual-prepay-covered visit with no invoice at all and clearly priced add-ons bills them as their own invoice with the pay link and the unpaid completion text; any invoice already on the visit — never collected by the completion — an issued invoice missing an add-on, or an unclear amount — a visit-wide discount, an add-on awaiting its price — gets one office alert instead, ADMIN-BUG-R13, owner ruling 2026-09-26; read at call time and frozen on the service record at the first gate-on pass; dark = today's behavior: the covered visit bills nothing for its add-ons and an office invoice carrying them is voided)
 *
 *   GATE_LAWN_PROPERTY_HISTORY=true (property-scoped confirmed lawn history, one installed row per visit, report-date/reset windows and confirm-time baseline; dark in dev AND prod; consumers read at call time)
 *   GATE_LAWN_COMPLETION_DEFAULTS=true (appointment-plan completion defaults; requires GATE_LAWN_PROPERTY_HISTORY; opt-in in every environment)
 *   GATE_PROPERTY_SERVICE_AREAS=true (reviewed property areas for beds, lawn and mosquito; draft visit coverage and product-area prefills; opt-in in every environment)
 *   GATE_LAWN_ACTUALS_LEDGER=true (lawn actuals ledger for EVERY lawn visit — one-time, commercial and incomplete-with-products included, no protocol attribution invented; off = WaveGuard-only writer, byte-identical; read at call time)
 *   GATE_LAWN_DELIVERY_RECOVERY=true (resume a confirmed lawn visit's interrupted customer delivery; FAILS CLOSED everywhere — off = the sweep shadow-logs candidates and sends nothing)
 *   GATE_LAWN_WATERING_RULE=true (lawn report watering instruction: frozen per-product watering rules drive the aftercare writer, the top-of-report banner payload and the weekly-plan "not before" overlay; sets evidenceSource product_instruction so the existing verdict table finally resolves hold / credit; ships DARK, read at call time via lawnWateringRuleLive(); off = byte-identical report payload)
 *   GATE_LAWN_WATERING_FORECAST=true (lawn watering banner forecast + rain close-out, needs GATE_LAWN_WATERING_RULE: at completion a water-in instruction whose property forecast says at least the water-in amount of rain falls inside its window freezes ONE conditional sentence (instruction.forecast, in INCHES, never a probability) that the LIVE web banner shows beside the unchanged lines; on the live view only, radar-measured (MRMS) rain on whole days inside the window that reaches the water-in amount closes the banner with a measured-inches line. Holds never get either. The PDF, email, watering text, hero and assistant never change; ships DARK, read at call time via lawnWateringForecastLive(); off = byte-identical payload)
 *   GATE_LAWN_WATERING_TEXT_FORECAST=true (lawn watering forecast from two sources, needs GATE_LAWN_WATERING_FORECAST: the water-in rain sentence is frozen only when Open-Meteo's amount AND an NWS hourly "rain likely" hour agree in the window; a timed hold then a water-in gets the sentence for rain after the hold ends; the watering text carries the frozen sentence. Off = today: Open-Meteo alone, plain water-in only, live banner only)
 *   GATE_LAWN_WATERING_SHORT_TEXT=true (short lawn watering text, owner 2026-10-23: the watering text sends short steps built from the frozen instruction's fields under template lawn_watering_instruction_short ("Lawn watering: {watering_lines}") plus a short rain sentence; an unknown shape or a missing short row sends the full lines; report, PDF, banner and Ask Waves unchanged; ships DARK, read at call time via lawnWateringShortTextLive(); off = today's text byte for byte)
 *   GATE_WARRANTY_13692_CHECK=true (owner 2026-10-24, Rule 5E-14.105(1): the New Construction Termite Warranty and the Builder Master Agreement read the signed FDACS-13692 consumer notice on file (an e-signed Document Request or an office-uploaded scan of the paper form) instead of a typed date. On or before the notice grace end (2026-11-24) a missing notice only warns and the typed date still works; after it the issue refuses until a notice dated on or before the contract basis date and the treatment date is on file. Adds the admin consumer-notices routes. Read at call time via warranty13692CheckLive(), strict 1/true/on, dark by default; off = typed date only, routes answer 404. Sends nothing to a customer.)
 *   GATE_ESTIMATE_CONSUMER_NOTICE=true (owner 2026-10-25, Rule 5E-14.105(1), F.A.C.: an estimate with a termite line asks the customer to read and sign the FDACS-13692 consumer notice on the estimate page BEFORE they can accept. Adds POST /api/estimates/:token/consumer-notice (issues the consumer_notice.fdacs_13692 Document Request and returns its signing URL), cta.consumerNotice on GET /:token/data, and refuses PUT /:token/accept with 409 consumer_notice_required until the customer has a notice on file. Read at call time via estimateConsumerNoticeLive(), strict 1/true/on, dark by default; off = byte-identical estimate page and accept. Sends nothing to a customer.)
 *   GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_SEND=true (owner 2026-10-26, Rule 5E-14.105(1), F.A.C.: after the office's Mark accepted (or the Intelligence Bar accept) commits on an estimate with a termite line, and the customer has no signed FDACS-13692 on file, the consumer_notice.fdacs_13692 Document Request is issued (or the open one reused) and its signing link is sent by email and text through the Document Requests delivery; a failure rings the office bell. Read at call time via manualAcceptConsumerNoticeSendLive(), strict 1/true/on, dark by default; off = Mark accepted sends nothing new.)
 *   GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_RECONCILE=true (daily catch-up for the Mark accepted consumer notice send, needs GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_SEND: the send runs detached after the accept commits, so a restart in between loses it with no bell. The 6:10 AM ET document run re-runs the same send for an office accept from the last 21 days (none before the send went live on 2026-10-26) when no email or text of a 13692 Document Request went out since the accept and the office got no bell for it. Read at call time via manualAcceptConsumerNoticeReconcileLive(), strict 1/true/on, dark by default; off = no catch-up.)
 *   GATE_ESTIMATE_SERVICE_AGREEMENT=true (a signed service agreement for every residential recurring plan: once a residential estimate with a recurring pest, mosquito, rodent, lawn or tree & shrub line is accepted, the accepted page offers "Review and sign your service agreement" per lane (Residential Pest Service Agreement service_agreement.residential_pest; Lawn & Ornamental Service Agreement service_agreement.lawn_ornamental), signed on the existing /contract/:token page. Adds POST /api/estimates/:token/service-agreement (issues the Document Request and returns its signing URL) and cta.serviceAgreements on GET /:token/data for an accepted estimate. The estimate, visit, invoice and charge are never touched; nothing is sent to the customer. Read at call time via estimateServiceAgreementLive(), strict 1/true/on, dark by default; off = byte-identical accepted page.)
 *   GATE_AGREEMENT_RENEWAL_REMINDER=true (the daily warranty renewal reminder also covers the Commercial Pest Service Agreement: each signed agreement gets renewal_date = its term anchor (the start date staff typed at issue, else the customer's first visit on or after signing, else, 180 days after signing with no visit, the signing date) + 12 months, rolled forward each year, and ONE office bell 45 days before the term ends ("Customers — send <name> the agreement renewal notice"), closed when staff mark the notice sent on Customer 360 or the agreement is cancelled. No customer comms. Read at call time via agreementRenewalReminderLive(), strict 1/true/on, dark by default; off = the job touches warranties only, as before.)
 *   GATE_PREPAY_YEAR_END_BELL=true (office bell before a prepaid year ends: a daily job in the renewal-reminder workflow raises ONE bell per annual prepay term (not termite) from 30 days before the term ends until 60 days after, "Billing — send <name> next year's prepay", with what the nightly booking does after the year ends (the plan stops booking, or visits bill up to $X) and next year's prepay rule (visits x visit price, minus 5%). Closes itself once the customer has a later term that is paid and live, chose cancel or another plan, moved off annual prepay billing, or was deleted. Sends nothing to a customer and charges nothing. Read at call time via prepayYearEndBellLive(), strict 1/true/on, dark by default; off = the job returns before any query.)
 *   GATE_LAWN_EXPECTATIONS=true (lawn report monthly program line: snapshot.seasonalNote carries one calendar-based, tier-neutral sentence about what the lawn program v13 focuses on this month (lawn-program-line.js PROGRAM_LINES_V13, claims proven against server/config/lawn-protocol-v13.json), in place of the peak/shoulder/dormant season note, and the lead layout renders it once beside the trends; recurring lawn plan visits only (one-time jobs, callbacks and unresolved service identities keep the old note), and only a visit whose plan resolved the staged v13 version with GATE_LAWN_V13 on: a visit with no recorded version or an older one keeps the old note (the retired per-grass sentences were removed, so no past report is rewritten); null in Jun-Sep when a nitrogen product may have been applied (any unresolved product counts), then the old note stays; lawn only; ships DARK, read at call time via lawnExpectationsLive(); off = byte-identical report payload and render)
 *   GATE_LAWN_COVERAGE_HIDE_DEFAULT_ZONES=true (lawn report: no Lawn Coverage section when the visit's coverage zones were only the schematic defaults (no technician-marked zone) AT COMPLETION; owner 2026-10-06; the verdict is frozen once at completion by the lawn write gate into service_records.structured_notes.lawnCoverageVerdict { v: 1, defaultsOnly, frozenAt }, first writer wins, only while the gate is live and the zone / geometry reads succeeded; a render and the PDF key (':covhide=1' only for a frozen defaultsOnly true) read that frozen value and never the live zone rows; a visit with no frozen verdict, such as an older visit, renders exactly as with the gate off; ships DARK, read at call time via lawnCoverageHideDefaultZonesLive(); off = byte-identical payload)
 *   GATE_LAWN_PROGRAM_DETAIL=true (lawn report: under the v13 month sentence, the month's "Why now" line from lawn-program-line.js PROGRAM_DETAIL_V13: seasonal facts and the step by category, no product names, rates, watering advice or outcome timing; needs GATE_LAWN_EXPECTATIONS; strict 'true' only; owner 2026-10-06; ships DARK, read at call time via lawnProgramDetailLive(); off = byte-identical payload)
 *   GATE_LAWN_OUTLINE_V13=true (lawn service outline, the program overview staff send from an estimate: every section describes the v13 program, owner 2026-10-22 "lawn service outline ... updated with the new protocols, check other sections"; server/services/lawn-service-outline.js: the grass is the one the estimate recorded (inputs.grassType, the composer pick first; never a scan of the whole estimate, which read the bermudaSuppression flag as Bermuda), the same customer page for every lawn the program covers with no grass named on it (owner 2026-10-24 "i dont think we make this for spefic lawn types"; the program section says it is built around St. Augustine, and the side panel reads property.programLabel), the month's "why now" text from service-report/lawn-program-line.js, month bullets that cover every v13 line and plan-size variant, every section boxed on the customer page (section.visual tiles, chips, year chart, treatment cards, visit steps, exclusion tags; text bullets kept), the v13 treatment categories, no tier line, no "restricted-season logic" line, a bahia lawn blocked (no v13 program), packets stamped content lawn-v13-copy-1; needs GATE_LAWN_V13 (fails closed); ships DARK, read at call time via lawnOutlineV13Live(); off = byte-identical outline; sends nothing to a customer)
 *   GATE_LAWN_OUTLINE_DETAIL=true (lawn service outline, detailed: owner 2026-10-26 "this needs to be more detailed, and we should be using the protocols, and youtube transcripts", decisions D1-B/D2-A on the decision page, "do whatever you recommend"; server/services/lawn-service-outline.js adds a month list (each month's report "why now" line plus one thing to do at home; this month and the next two open), Problems We Watch For, Products We May Use (the v13 track's product names with the catalog's active ingredient, no rate), After A Treatment, Your Part: Watering (the Manatee/Sarasota one-day watering order tile until 2027-03-31), Your Part: Mowing, What To Expect and Common Questions; drops the month Service Focus box; packets stamped content lawn-v13-detail-1; needs GATE_LAWN_OUTLINE_V13 (fails closed); ships DARK, read at call time via lawnOutlineDetailLive(); off = the v13 outline exactly; sends nothing to a customer)
 *   GATE_LAWN_OUTLINE_VISUAL=true (lawn service outline, new layout: owner "build" 2026-10-31 on the nine-round outline scope page; server/services/lawn-outline-visual.js, called from lawn-service-outline.js for every lawn outline: a year bar (nine round blocks for an estimate whose lawn line would seed as lawn_rounds_9, which also needs GATE_LAWN_9X_ROUNDS; twelve month blocks for every other plan) with the local summer-rule band and caption, round cards or today's month list, an after-a-visit timeline, fact cards (the two tour videos, the Monday watering email, mowing) and a closed Problems and Common Questions list; folds the program tiles, treatment cards, After A Treatment, What To Expect, Local Rules and Safety sections into those; the property carries planLabel and a rounds outline's season carries roundLabel; every section keeps its text bullets; packets stamped content lawn-v13-visual-1; needs GATE_LAWN_OUTLINE_DETAIL (fails closed); ships DARK, read at call time via lawnOutlineVisualLive(); off = the detailed v13 outline exactly; sends nothing to a customer)
 *   GATE_LAWN_VISIT_MEMORY=true (lawn report treatment memory: freezes this visit's "what we applied / what we said we would watch" entry into service_records.structured_notes.lawnVisitMemory[assessmentId], first writer wins, no migration, and attaches reportV2.sinceLast built from the PRIOR visit's frozen entry (same property, strictly earlier date); data only, no customer render yet (the progress engine and copy writer read it later); ships DARK, read at call time via lawnVisitMemoryLive(); off = no reads, no writes, byte-identical report payload; the same gate builds the server-internal progress block, in-process only and never in the payload)
 *   GATE_LAWN_RAINFAST_WATCH=true (lawn rainfast breach watch, P31, needs GATE_LAWN_VISIT_MEMORY: on the LIVE web view only, once a product's stated rainfast interval (products_catalog.rainfast_minutes; no interval = never judged) has ended plus an hour, the property's hourly weather-model rain (Open-Meteo, past hours; not a gauge) is read for the whole hours inside [completion, completion + interval]; a total of at least 0.25 inch records ONE retreatCheck item on the frozen visit memory (first writer wins, compare-and-set, never creates an entry) and adds ONE fixed sentence to the lead's Watching line; any missing hour, failed fetch or missing completion time = no item and no sentence; the PDF, static builds, SMS and email never change; sends nothing to a customer; ships DARK, read at call time via lawnRainfastWatchLive(); off = byte-identical payload, no fetch, no write)
 *   GATE_LAWN_DIAGNOSTIC_EVIDENCE=true (prospect lawn report "why we think so": GET /api/public/lawn-diagnostic/:token adds a `basis` line ("Based on 4 photos.", plus a fixed note when photo quality limited the read) and, per finding, `evidence` { why, certainty, confirm }: what the condition looks like, how sure the read is, and the on-site check that would settle it. Every string is fixed copy in lawn-diagnostic-evidence.js selected by the finding's allowlisted condition label and clamped confidence; the stored observed_evidence / inferred_context / confirmation_step free text is still never published. One extra read (a photo count) per report view while live. The lawn-assessment teaser is unchanged. Ships DARK, read at call time via lawnDiagnosticEvidenceLive(); off = byte-identical payload and page)
 *   GATE_LAWN_SINCE_LAST=true (lawn report "Since your last visit" block: the lead gains reportV2.lead.sinceLast { priorDate, lines } and the web report prints it above "What we applied today": what the last visit applied, the overall direction and at most two per-treatment states from the progress engine, and which watched topics are still on today's list. Every sentence is a fixed string selected by key in lawn-since-last-copy.js (no model, no number, no timing word), and a state is spoken only for an owner-approved expectation row; photos that cannot support a comparison say nothing. Needs GATE_LAWN_VISIT_MEMORY (the memory it reads); with it off it does nothing. Live web view only (mode 'live'): PDF and static builds never carry the key, so the PDF and its cache key are unchanged. Ships DARK, read at call time via lawnSinceLastLive(); off = byte-identical report payload and render)
 *   GATE_LAWN_SHOT_LIST=true (lawn visit photo shot list, lawn report rebuild P18: the admin Schedule lawn photo step shows eight named shots (front, back, side, canopy close-up, blade and crown, hot edge, shadiest turf, problem area) each with a one-line instruction, accepts up to 8 photos instead of 3, tags every photo with its shot key as the recorded zone, and shows a soft hint when the 4-photo minimum (front, back or side, close-up, blade and crown) is not covered yet; NOTHING blocks the technician (owner: lawn visits are quick jobs). Server side: POST /admin/lawn-assessment/assess accepts the eight shot keys and up to 8 photos (one per shot, two problem-area photos), the legacy per-photo merge weights area scores by shot (detail shots count for nothing), the report's lead photo prefers the front shot, the report payload carries up to 8 photos with a zoneLabel each and its cache signature moves with the gate. The client learns the state from GET /admin/lawn-assessment/service/:id (`shotListEnabled`). Needs no migration. Ships DARK, read at call time via gateEnvValue('GATE_LAWN_SHOT_LIST'); off = byte-identical request contract, UI, report payload and PDF)
 *   GATE_LAWN_REPORT_PHOTO_SET=true (lawn report rebuild P23: for a lawn visit captured under the photo shot list (the `photoVocabulary: 'shot_list_v1'` marker stored beside the assessment photos), the customer report shows the visit's photos as a labeled set in shot order (Front yard, Back yard, Close-up and so on, fixed customer labels from shared/lawn-photo-shots.json) in place of the swipe-one-at-a-time strip (web) and the quality-ordered gallery (PDF); each photo URL is signed fresh on every view and never frozen. A visit with no marker keeps the strip it always had. Needs no migration. Ships DARK, read at call time via lawnReportPhotoSetLive(); off = byte-identical report payload and PDF)
 *   GATE_LAWN_REPORT_PHOTO_FINDINGS=true (lawn report rebuild P23b: a short "What the photos showed" block on the lawn report, built only from the technician-reviewed, kept findings of the visit's current confirmed assessment run (lawn_assessment_runs.reviewed_findings), symptom labels only, each with the thumbnails it cites and, where the technician marked it undeterminable from the photos, one fixed sentence naming the shot that would confirm it; it prints only while the report's own category card for that topic shows a concern. Exists only when BOTH this gate and GATE_LAWN_REPORT_PHOTO_SET are on and the visit has a photo set. Needs no migration. Ships DARK, read at call time via lawnReportPhotoFindingsLive(); off = no run read, and byte-identical report payload, PDF cache key and PDF)
 *   GATE_LAWN_LIGHTING=true (lawn lighting-aware color, owner 2026-10-04: sun, shade and cloud change a lawn's color in a photo, so (1) the lawn visit assessment reads each photo's light (full sun, overcast, open shade, mixed sun and shade, low light, unknown; hard shadows yes/no/unknown) under its own prompt version (lawn-visit-v1-lighting, or lawn-visit-v1-shot-list-lighting for a shot-list capture), tells the model to judge color from turf in even light and never to read shadowed turf as thinner or darker, and stores the read beside each photo's quality in the run's photo_quality (never shown to the technician, no new technician step, no new weather call); (2) the paired-photo recheck reads under lawn-paired-recheck-v3, which is told each pair's light and drops color from any pair whose two photos are not in compatible light; (3) the report's "Since your last visit" lines (live web view only) say nothing about color unless BOTH visits have a known, compatible light read (full sun and sun with shadows with each other, or overcast and open shade with each other; sun never with cloud or shade, owner 2026-10-22 option B; a visit whose photos mix sun with cloud or shade, hold any low light, or hold an overcast or open-shade read with hard shadows is mixed light and compared with nothing), a color move under 8 points is no change (a "behind" resting on it is withheld), and the overall line is kept only when thickness, weeds and stress damage agree with it, so color alone never produces up or down (the gate only ever removes a gate-off sentence, never prints a different one); (4) the report writer's prior-visit score line drops the color delta unless the light is compatible. A visit with no light read (every visit before this gate) is unknown, so its color is never compared. (5) the report's "Color & Vigor" trend, and the portal's Color / Nutrients since-first-visit comparison, are left out unless the latest visit and the one before are in known, compatible light. Needs GATE_LAWN_VISIT_ASSESSMENT also on (the light read comes only from that assessment; the reader reports off without it). Needs no migration. Ships DARK, read at call time via lawnLightingLive(); off = byte-identical prompt, schema, stored run, since-last lines, trends and recheck prompt)
 *   GATE_LAWN_SCORE_SCALE_V2=true (lawn score scale 2, owner 2026-10-24 lawn scoring review: the lawn visit assessment asks the model for the four scores the technician reviews as 0-100 ratings against written anchors (turf_density, weed_control, color_health, condition) under its own prompt versions (any lawn-visit-v1 variant plus -scale2), instead of scale 1's weed share of the lawn (stored as 100 minus it, so 95-99 on almost every lawn), color 1-10 x10 and a severity-word map for Condition; the severity words are still asked and stored; the server stores the ratings as read (weed_suppression = weed_control, color_health as read, stress_damage = condition, no season multiplier; fungus_control and thatch_level still come from the severity words; a Condition the AI cannot rate stays unknown until the technician enters it) and stamps lawn_assessments.score_scale = 2 on every scale-2 read, a failed one included; property history (lawn-assessment-history.js sameScoreScale) holds one score scale, the current visit's, else a scale the caller names, else the newest row's, so everything that compares visits (the report's since-last lines, prior-visit score line, before/after and trend chart, the paired recheck and treatment memory, baseline, property score, lawn health signal, portal lawn card and the technician's Last visit row, which follows the visit's own read) starts fresh at the first scale-2 visit, like a baseline reset, and so do the treatment-outcome deltas, the ROI improvement buckets, the neighbor benchmarks (one segment per scale) and the assistant's lawn health tool; the treatment guide's weed card reads a scale-2 row's rating, never a share of the lawn. Old rows are never rewritten. No customer message. Needs GATE_LAWN_VISIT_ASSESSMENT and GATE_LAWN_PROPERTY_HISTORY also on (the reader reports off without either). Migration: lawn_assessments.score_scale (nullable smallint; NULL = scale 1). Ships DARK, read at call time via lawnScoreScaleV2Live(); off = byte-identical prompt, schema, stored run and scores)
 *   GATE_LAWN_TECH_PARAGRAPH=true (lawn report "From your technician" paragraph, owner 2026-10-05; FIXED SENTENCES since 2026-10-06: every word comes from the owner-approved LAWN_SENTENCES in lawn-tech-paragraph.js ("Our technician saw {condition} in the {place}.", "There may be early signs of {label}; we will keep an eye on it.", "Today we applied {products}."); at most ONE model call per lawn visit extracts closed-list conditions and places with the technician's exact words and a seenToday judgment, and code keeps an item only when the quote is word for word in one note sentence naming the condition (the model judges, the code verifies, no word lists); the entry { text, slots, v: 2 } freezes first-writer-wins in structured_notes.lawnTechParagraph[assessmentId], is re-checked against its slots at read time and rides reportV2.lead.techParagraph on the web report and the PDF; lane lawn_tech_paragraph on TEXT_POLICIES.report; lawn only; read at call time via lawnTechParagraphLive(); off = no model call, byte-identical payload, PDF and PDF cache key)
 *   GATE_LAWN_COST_PLUS_LIST=true (residential recurring lawn care list price = annual cost / (1 - 0.45), never below the market table, at least $55 a visit, from the v13 program product cost plus 10 more labor minutes a visit; WaveGuard and manual discounts on the lawn line stop at a 35% margin; owner 2026-10-09; strict opt-in via gateEnvValue, read at CALL time in priceLawnCare and generateEstimate; a saved estimate replays as it was priced (pricingMetadata.lawnCostPlusList); the one-time lawn anchor and commercial lawn stay on the market table; ships DARK, off = byte-identical prices)
 *   GATE_SITEONE_PROGRAMS_CHECK=true (owner 2026-10-26: on the 1st of each month at 9:00 AM ET the portal signs in to siteone.com with the order bot's stored login, reads SiteOne's Early Order Programs, promotions and Partners points, compares them with last month's list and posts one admin notification for new programs, programs ending within 30 days and points expiring within 60 days. Read-only on SiteOne: never adds to the cart, never changes the account, never orders. Strict opt-in via gateEnvValue, read at call time by server/services/procurement/siteone-programs-check.js; dark by default; off = nothing runs. Sends nothing to a customer.)
 *   GATE_SITEONE_EMAIL_ORDER=true (owner 2026-10-26, "OK DO OPTION B": SiteOne's website blocks the order bot, so an owner can instead email ONE pickup order to SiteOne for an open restock request. The Restock tab shows "Email order to SiteOne" on an open request (admins only); it opens a preview with To, Subject, the body and the estimate before tax, and Send email goes out through SendGrid from contact@ to SITEONE_ORDER_EMAIL (cc SITEONE_ORDER_CC). Then the request is marked ordered, so Receive works as today. One email per request, ever. Strict opt-in via gateEnvValue, read at call time by server/services/procurement/vendor-order-email.js via siteOneEmailOrderLive(); dark by default; off = the two routes answer 404 and the tab shows no button. Sends an email to SiteOne, a vendor, never to a customer; the order bot is untouched.)
 *   GATE_MOSQUITO_MISTING=true (automatic mosquito misting system pricer: install price by tier, nozzle and riser overage, a $59 monthly plan and per-fill refill rates; the estimate engine accepts services.mosquitoMisting, the legacy mapper emits the plan line and a one-time install item, and the public price ranges list two rows; the line is not a WaveGuard tier service and takes no percent discount; draft prices, dealer cost unknown; also gates the misting system records (owner 2026-10-30): an admin-only Misting system panel on Customer 360 for the install calibration (spray-rate math checked against the label's daily limit) and the tank refill log, via /api/admin/misting-records, which answer 404 and render no panel when off; and the customer app's Home card, GET /api/misting-system (off = `{ system: null }` with no read); strict opt-in via gateEnvValue, read at CALL time via mosquitoMistingLive(); ships DARK, off = the key is ignored and every estimate is byte-identical)
 *   GATE_DEAD_ANIMAL_REMOVAL=true (owner 2026-10-26: the one-time Dead Rodent Removal & Odor Treatment line in the estimate engine: services.deadAnimalRemoval = { tier: reachable | attic | in_wall }, fixed tier prices, in_wall is a custom quote. NEW QUOTES ONLY: off = the estimator hides the choice and the engine refuses the input with a 400 failClosed error (DEAD_ANIMAL_REMOVAL_GATED); an estimate already saved with the line stays a normal estimate. Strict opt-in via gateEnvValue, read at CALL time via deadAnimalRemovalLive(); dark by default. Sends nothing to a customer.)
 *   GATE_LAWN_VISIT_SUMMARY_V2=true (PROTOTYPE ONLY: lawn report Visit Summary, FIXED SENTENCES, NO MODEL (owner 2026-10-07). The gate controls ONLY the freeze at completion: at completion code writes up to 5 sentences from the visit's structured facts, every word from closed phrase tables (the product CATEGORIES applied, never names or rates; the report's area reads with strong and healthy kept distinct; technician-kept PHOTO findings (the report's photo-finding selector; added details never count) by their own symptom label, hedged when the read is low or unknown confidence or undeterminable from the photos, and only while the report's own card for that topic shows a concern; one fixed results sentence and the next-visit topics, for a recurring plan visit with a scheduled next visit at this property only). There is NO watering sentence (the report's watering banner owns it). The technician note, the v13 program line, the headline and rain are not inputs. The frozen entry is { text, slots } in structured_notes.lawnVisitSummary[assessmentId], first writer wins. A RENDER shows any whole frozen summary whatever the gate says (it depends only on the record, so every pod and browser agrees during a rollout): the text must equal what the current tables render from the slots and pass the screens, else the report keeps the generic customerRecap. It replaces the lawn report's Visit Summary text (summarySource 'lawn_visit_summary'); the completion SMS keeps the short customerRecap; lawn only; customer copy, so strict opt-in: exactly 'true' in every environment, read at call time via lawnVisitSummaryV2Live(). Ships DARK; off = no new summaries are frozen and nothing else changes (rollback = unset the variable: summaries already frozen stay, because they are true statements))
 *   GATE_LAWN_REPORT_COPY_FIXES=true (lawn report copy fixes, owner 2026-10-08/09, six customer-copy defects: (1) no active-ingredient or catalog product name in any lawn sentence: the "What we applied today" sentence (buildCategoryTreatmentSummary) and the "From your technician" products sentence name the product CATEGORY in the Visit Summary phrase table (lawn-visit-summary.js APPLIED_PHRASES: a feeding, weed control, insect control, disease protection, a pre-emergent weed barrier), the AI treatment narrative (which writes actives) is not used for a lawn report, names stay on the product cards; the tech paragraph and the v6 "what we applied" field FREEZE the category form only for visits frozen while this is live, and every older frozen entry still renders word for word; (2) the seasonal color lines (cross-season note under the before/after slider, the trend footnote and the shoulder/dormant season note) print only when the visit month is in the cool season the report's own seasonality module defines (lawn-seasonality.js getSeason: shoulder and dormant) AND the overall score did not rise against the prior visit or the comparison base; no known score = no line; (3) the score card "Weed Pressure" reads "Weed Cleanliness" (same Strong / Healthy / Watch / Needs attention words, same scale, so "Strong" cannot read as strong weeds); (4) a lawn report never prints the pest program's re-service footer sentence, its "Book a free re-service" link or the legacy pest re-service header; (5) the Water Gap and Mowing Height charts are not rendered (web and PDF, no heading left) when their newest point is more than 45 days before the visit date; (6) one fixed sentence under the water Target range names the source of the figure (the weather in your area for the week ending on the visit, the grass type when known, the time of year; or the usual seasonal need when no weather figure existed); no line when the target came from the area snapshot. The target NUMBER never changes. Lawn only (tree & shrub and pest payloads, renders and PDFs unchanged). No model call. Customer copy, so strict opt-in: exactly 'true', read at call time via lawnReportCopyFixesLive(). Ships DARK; off = byte-identical payload, render, PDF and PDF cache key)
 *   GATE_LAWN_REPORT_LAYOUT=true (lawn report layout, owner 2026-10-08/09, LIVE WEB VIEW only: the lawn report is ordered for a phone and trimmed, from data the report already carries. Order: done and the next lawn visit, one "Your part" card (the re-entry sentence the re-entry builder returns, timed or condition; the watering banner with its label mow hold, printed once; the lead's own homeowner step; or one fixed "nothing for you to do" sentence), what we did and why now, photos and findings, the score (collapsed), what to expect and when to call, water this week (with one fixed mowing-height sentence from the Mowing Height table's row for the lawn's grass; no row = no sentence), rate us, products (collapsed). Each fact prints once, and only when the block that carries it is on the page and says the same thing: a finding's next step loses only the sentences that are the watering banner's own, an applied sentence is left out of the technician paragraph or Visit Summary only when the lead's applied sentence says all of it, a Watching line that only repeats the findings is dropped, the lead's next-visit date is dropped only when Your plan prints that lawn visit. Hidden, not deleted: the Visit Timeline, the re-entry card (its sentence and pet advisory are in Your part), the Weather call block, Your documents, the standard lead card (split into the sections above). Fixed sentences only (shared/lawn-report-layout-copy.json), no model. A report with no lead is the standard page. The server adds payload key lawnLayout while live; the PDF, static and SMS renders, and the PDF cache key never change. Lawn only (tree & shrub and pest untouched). Customer copy, so strict opt-in: exactly 'true', read at call time via lawnReportLayoutLive(). Ships DARK; off = byte-identical payload, render, PDF and PDF cache key)
 *   GATE_LAWN_REPORT_STORY=true (lawn report story order, owner 2026-10-23/24: "How did Adam do today ... towards the top", the technician's note near the top, products with "why are we doing this", then "keep both" for the in-page Ask Waves and the plan after the lawn sections. LIVE WEB VIEW only, and only on a page GATE_LAWN_REPORT_LAYOUT already orders: the server adds story:true inside the lawnLayout payload key, and the page prints STORY_LAYOUT_ORDER (client/src/components/report/lawnV2/LawnLayout.jsx): the review invitation and the technician's note after the status card, each applied product explained inside "what we did" (visible, with its Poison Control note), the Visit Summary collapsed, Ask Waves in the page, then the plan, the next visit, the re-service card and the blog after the lawn sections; the status card names the service "lawn care" and adds the lawn score. The PDF, static and SMS renders and the PDF cache key never change. Customer-facing layout, so strict opt-in: exactly 'true', read at call time via lawnReportStoryLive(). Ships DARK; off = byte-identical payload and the layout order as before.)
 *   GATE_LAWN_REPORT_POLISH=true (lawn report polish, owner 2026-10-09, three changes to the customer lawn report: (1) the Water card's THIRD state: a sprinkler schedule is on file (run minutes and/or watering days) but weekly inches are not and cannot honestly be derived (mixed head types, drip only, a missing piece, an implausible total): the Irrigation row prints what is on file in plain words ("45 min, Mondays"), the confidence line says weekly inches are not on file, no Total prints, and the call to action asks for the weekly inches; never "Not on file" when a schedule is on file. profileMissing stays true for every calculation (balance, status, weekly plan, Ask Waves, weekly email): only the card's presentation changes. A number is derived ONLY for exactly one turf head type (drip ignored) and then prints the portal's basis line; the derivation reads ONE rate table, the watering banner's (spray 15 min, rotor 40 min per quarter inch), from a constant the package exports. Consumers outside the lawn report (portal preview, weekly irrigation email, schedule-move guard, weekly plan) keep the package's own table and rules. (2) One label line per product card: at completion the decision is frozen with the lawn report facts (lawnReportFacts.labelLines, first writer wins; it freezes only while GATE_LAWN_REPORT_FACTS is also live, one helper lawnReportPolishFreezeLive(); the Water card and status card parts need no facts gate). (3) The longer-cycles line on the Water card: one fixed sentence advising fewer, longer runs on the allowed watering days, printed only for a schedule of 3 or more watering days on file (frozen at completion in lawnReportFacts.waterAdvice, same freeze condition), no new sod still establishing, no watering banner, weekly plan or after-visit watering note on the visit: a catalog precaution sentence whose parsed kind (until dry, or watered in and dry) is no stricter than the re-entry line's kind is dropped; a sentence the parser cannot read is kept; a record with no frozen decision renders as before. The status card's keep-off line no longer prints under a result that is not the condition sentence, and the layout's hero prints the lead's status headline instead of the walk-on rule that Your part states. Lawn only. Customer copy, so strict opt-in: exactly 'true', read at call time via lawnReportPolishLive(). The server adds payload key lawnPolish while live and the PDF key part ':polish=1'. Ships DARK; off = byte-identical payload, render, PDF and PDF cache key)
 *   GATE_LAWN_REPORT_STAGE1_FIXES=true (lawn report stage 1 fixes, owner 2026-10-09, five small fixes found on a real lawn report: (1) a spot insecticide row whose recorded target is a known pest (chinch bugs; armyworms and sod webworms read as caterpillars) changes the damage finding (a product target is not a sighting: only with a frozen technician or sure photo tie for the pest does it read "<Pest> damage in one area - treated today" with the Visit Summary's "Your technician found <pest> and treated that spot today."; with the target alone it reads "<Pest> spot treated today" with the product card's purpose sentence) and, when the spot area is recorded, "Applied <product> to about N sq ft." (the product category phrase instead of the name while GATE_LAWN_REPORT_COPY_FIXES is live); (2) "What to expect" prints a second line after the weed line, from sentences that already exist: the curative insecticide row when a spot insecticide was applied (none for a spot insecticide with no target or a preventive-locked product), else the fertilizer row, kept inside the existing word caps, for a visit whose copy freezes while this is live; (3) a frozen technician tip that asks the customer to add irrigation settings is left off the report when a sprinkler schedule is on file (needs GATE_LAWN_REPORT_POLISH for the runtime-only state); (4) the web page leaves out the "What we applied today" card only when it IS the Today's result sentence or that sentence plus the known targeting / surfactant clause; the PDF and the Visit Summary are unchanged; (5) the web hero leaves out the customer's email and phone; the PDF keeps every contact field. Lawn only. Customer copy, so strict opt-in: exactly 'true', read at call time via lawnReportStage1FixesLive(). The server adds payload key lawnStage1Fixes while live and the PDF key part ':s1=1'. Ships DARK; unsetting it is NOT fully byte-identical: a second "What to expect" line already frozen into a record's v6 copy keeps replaying, and its marker keeps PDF key part ':s1f=1' on that record; every other change reverts at once)
 *   GATE_LAWN_WATER_RAIN=true (lawn report "rain card", owner 2026-10-09: the Water This Week card is honest after rain. (1) The card STATUS counts each day's rain at most EVENT_DEPTH_MAX_INCHES (0.75 in, the package's per-event depth), summed over the card's 7 days; the Rain row still shows the measured total, the capped number is never shown, and with only a weekly total (no 7-day daily series) nothing is capped. No look-back beyond the 7 days; the Monday plan's carry is untouched. (2) New status "rain covered" (pill "Rain covered it"): the week's measured rain alone is at least the week's target, with or without a sprinkler schedule on file; one fixed sentence says to leave the sprinklers off until the grass shows the wilt signs, then run one full cycle on an allowed watering day. (3) The deficit and surplus card sentences are replaced (no result promise, no "add a few minutes to each run"; the amount per run stays fixed). (4) Once per rain-covered week, only when the property's rain sensor field is not true, one line about the Florida rain shutoff law. All of it is suppressed (today's card) when the visit carries a post-treatment hold or water-in instruction, new sod is still establishing, or the schedule is withheld after a move. Eligibility is decided once at completion and frozen with the report facts (lawnReportFacts.waterAdvice, version 2, first writer wins; it freezes only while GATE_LAWN_REPORT_FACTS is also live, one helper lawnWaterRainFreezeLive()); a record without it renders as today. Lawn only. Strict opt-in: exactly 'true', read at call time via lawnWaterRainLive(). Ships DARK; off = byte-identical payload, render, PDF and PDF cache key)
 *   GATE_LAWN_WATER_IN_RAIN=true (lawn report water-in after rain, owner 2026-10-09: a granular water-in banner counts the rain that fell since the visit. READ TIME ONLY, never frozen: on a replay of the frozen watering instruction (web /data and the PDF), when measured rain from completion to now (capped at the water-in deadline; Open-Meteo hourly, whole hours, a lower bound, the reader the rainfast watch uses) reaches the water-in amount, the banner state becomes "water_in_by_rain" and its lines become "Rain since your visit has watered today's treatment in." and "No extra sprinkler run is needed for it." (a hold line, if the visit had one, stays above them). The amount is parsed from the product's catalog precaution ("about 1/2 inch"), 0.5 inch when none is parseable. Before that, a pre-amount-only instruction that printed generic spray AND rotor minutes reads "...by Sat 9 AM: about 1/2 inch - around 30 minutes on spray heads or 80 on rotors." from the same rate table. The completion text is built from the frozen instruction and never changes. The PDF key gains ':wir=' only while the gate is live and the visit has a frozen water-in instruction. Strict opt-in: exactly 'true', read at call time via lawnWaterInRainLive(). Ships DARK; off = byte-identical payload, render, PDF and PDF cache key)
 *   GATE_REPORT_SHARED_TEMPLATE=true (shared customer report template, owner 2026-10-24: "all other reports have the same template except WDO and pre treat". Every regular customer report on the live web view (service, older service, project, lawn assessment, pest assessment) prints the pest report's customer header (eyebrow, title, then the name, email, phone and address each on its own line, ALL-CAPS records title-cased, the stage-1 contact hide kept) and one vertical, stacked layout: the side-by-side grids, the report action buttons and the price rows stack (client/src/components/report/reportTemplate.css). WDO inspections and pre-treatment certificates keep their paper documents. While live the server adds payload key reportTemplate:true to live views only (report /data in live mode, the project /data, the lawn-diagnostic and pest-identifier reports, the admin report preview); the PDF, static and SMS renders and the PDF cache key never change. Customer-facing layout, so strict opt-in: exactly 'true', read at call time via reportSharedTemplateLive(). Ships DARK; off = byte-identical payload and the page as before.)
 *   GATE_IRRIGATION_OWNER_RATES=true (one sprinkler head rate table for every reader, owner 2026-10-09 "build it": the owner's table, spray 15 and rotor 40 minutes per quarter inch (1.0 and 0.375 in/hr), replaces the package's UF/IFAS-typical table (spray 1.5, rotor 0.5 in/hr) in the Monday week plan (default-rate minutes per run), the weekly irrigation email (derived weekly inches and its provenance sentence), the schedule-move guard, the lawn report's derived irrigation figure and the portal's "About N inches a week" line, so the lawn report banner and the Monday email stop disagreeing (30 versus 20 minutes on spray for half an inch). The generic "½ to ¾ inch - about N minutes on spray zones, M on rotor zones" sentences in the Monday email and report card are computed from the same table (20 and 60 off, 30 and 80 on). With the gate on the portal line and the email's provenance sentence say "typical head rates" without the University of Florida attribution. A customer's MEASURED rate (typed weekly inches with a runtime) still outranks any table. The packages/irrigation-runtime package never reads the environment: the server picks the table in server/services/irrigation-rates.js and the portal receives the choice as irrigationOwnerRates in GET /api/property/preferences (key present only while the gate is live). Lawn report banner and water card output is unchanged (they already use the owner table). No migration, no template change, sends nothing. Customer copy, so strict opt-in: exactly 'true', read at call time via irrigationOwnerRatesLive() in server/services/irrigation-rates.js. Freeze rule: the gate is read only when a NEW week-plan decision is made; the snapshot records decisionInputs.rateTable ('owner' only, so a gate-off snapshot is unchanged) and replay plus every renderer of a stored plan read that key, a row without it being the package table. The schedule-move guard takes the same table as a required argument: a new decision reads the gate once for guard and decision together, replay passes the stored table. Ships DARK; off = byte-identical emails, week plan, portal response and lawn report)
 *   GATE_IRRIGATION_WATER_SAVINGS=true ("water you saved" on the Monday irrigation plan, owner 2026-10-22, phase 1 gallons only: one sentence in the plan email's note (and so on the My Property watering plan card, which reuses it) on a skip, forecast-conditional or run plan saying what one sprinkler run puts on the lawn ("Each 20-minute run you skip is about 1,550 gallons on your lawn, so skipping both of this week's runs saves about 3,100 gallons."), from depth per run x lawn area x 623 gallons per inch per 1,000 sq ft. Depth per run is the customer's own schedule when on file (typed weekly inches over their watering days, else zone minutes on the plan's head rate table); otherwise the owner default of a typical 20-minute run, twice a week, half an inch. The lawn area (customer_turf_profiles.lawn_sqft, withheld after a move until a lawn-size writer re-establishes it: its own ledger entry turf_lawn_sqft via lawnSqftConfirmedAfterMove, stamped by the turf-profile editor, a service-area lawn review, writeLawnSqft and a primary flip carrying a reviewed lawn; re-saving the grass does not release it) is never defaulted: no area, no sentence. A hold because irrigation is not permitted gets no sentence. No dollars (water source is not on file). Customer copy, so strict opt-in: exactly 'true', read at call time via irrigationWaterSavedLive() in server/services/irrigation-water-saved.js. Freeze rule: the gate is read only when a NEW week-plan decision is made; the block is written to decisionInputs.waterSaved (key absent when off or no area, so a gate-off snapshot is byte-identical) and replay plus every renderer of a stored plan read that block, never the gate or today's lawn size. No migration, no template change. Ships DARK; off = byte-identical emails, snapshots and app plan)
 *   GATE_IRRIGATION_SETUP_ASK_CADENCE=true (Monday irrigation email setup ask, owner 2026-10-24: a customer with no usable watering schedule gets the "add your watering schedule" callout and button on their first 3 setup emails, then at most once every 4 weeks (27 days since the last one SENT, from email_messages); the weeks between send irrigation.weekly_rain_report, the same rain report with no callout and no button (migration 20261024223000 copies the live setup_system body without them). History unreadable = the ask goes out (today's behavior). Customer copy, so strict opt-in: exactly 'true', read at call time via irrigationSetupAskCadenceLive() in server/services/irrigation-weekly-email.js. Ships DARK; off = byte-identical emails)
 *   GATE_IRRIGATION_WATER_DOLLARS=true ("water you saved" phase 2, owner 2026-10-23 "ok go": a dollar range after the gallons sentence, for a customer who answered County water under Water Source in the portal's Irrigation section (property_preferences.irrigation_water_source: county | reclaimed | well | null; its own confirmation-ledger entry irrigation_water_source, withheld after a move until re-saved). "On Manatee County water that is roughly $7 to $23 for the week." on a whole-week hold, "... a run." otherwise and on the setup / confirm asks. Range = the displayed gallons x the county's marginal $ per 1,000 gallons, low = a dedicated irrigation meter (water only), high = irrigation on the house meter (upper water tier + sewer): Manatee 3.11-10.78, Sarasota 4.00-13.00, Charlotte 6.84-16.49 (WATER_RATES_PER_1000_GAL, from the utilities' 2026 schedules; which meter the customer has is not on file). Reclaimed, well, unanswered, or a county without a rate: gallons only, exactly as phase 1. REQUIRES GATE_IRRIGATION_WATER_SAVINGS (no block, no dollars). Customer copy, so strict opt-in: exactly 'true', read at call time via irrigationWaterDollarsLive() in server/services/irrigation-water-saved.js. Freeze rule: the dollars ride decisionInputs.waterSaved.dollars, written only with a NEW decision (key absent otherwise, so a gate-off snapshot is byte-identical); replay and renderers read the block. Migration 20261023270000 adds the column; no template change; sends nothing. Ships DARK; off = byte-identical emails, snapshots and app plan)
 *   GATE_TS_TECH_PARAGRAPH=true (tree & shrub report "From your technician" paragraph, owner 2026-10-05, go-ahead; FIXED SENTENCES: the AI picks facts and code writes every word. At completion at most ONE model call (lane ts_tech_paragraph on TEXT_POLICIES.report, only when the technician left a note) extracts up to 3 closed-list { condition, plant } ids from the note; code verifies each against the note (the model's seenToday judgment must be true and its quote must be the technician's exact words naming the condition; plant only when the quote names it) and renders only the sentences in the TS_SENTENCES constant, plus deterministic lines from the products applied, low-confidence and confirmed kept photo findings, and the technician's own Excellent/Good rating; none of the model's text is printed. The watch list, the last visit, the report headline and product ingredients are not inputs; palm-banned terms (Ganoderma, conk, lethal bronzing, fusarium, crown, spear leaf, newest fronds) can never render. The survivor freezes first-writer-wins in structured_notes.treeShrubTechParagraph[assessmentId] as { text, slots } (never regenerated at render; at read time the text must equal render(slots) under the current templates; a failed or slow call freezes the deterministic lines only) and rides reportV2.techParagraph on the web report and the PDF; REQUIRES GATE_TS_TECH_FINDINGS_COPY (the technician's hide / confirm / edit decisions must govern the report the paragraph sits in); tree & shrub only; customer copy, so strict opt-in: exactly 'true' in every environment, read at call time via tsTechParagraphLive(). Ships DARK; off = no model call, byte-identical payload, PDF and PDF cache key)
 *   GATE_LAWN_SPOT_RULES=true (lawn Fast Complete sheet weed-spot rules, owner 2026-10-08: the context's plannedProducts.weedMix groups the weed-spray add-ons the protocol rows tie together (the lead others name in gates.tankMixWith, its tank-mix members, and the replacement whose gates.trigger is celsius_annual_cap_reached) into ONE "Weed spots" entry; the lead is offered while the plan's own limit reader (v13VisitLimits) shows it under its yearly cap, the replacement in its place once it is at the cap, and neither once both are at the cap; the surfactant member is left out when the property's current air temperature (FAWN, 2.5 s bound, any failure = unknown) is 90 F or hotter, added with a note when the temperature is unknown; the context also carries spotRules: true so the sheet asks the technician for the area treated on every spot-treatment row (quick sizes or a typed number, one shared area for the weed mix) and holds Complete until a spot row has an area or a typed amount; the area rides the /complete product row as areaValue/areaUnit sqft; technician sheet only, no customer message, no public payload; ships DARK, read at call time via lawnSpotRulesLive(); off = byte-identical context and sheet)
 *   GATE_LAWN_REPORT_FACTS=true (lawn report facts frozen at completion, owner 2026-10-08: three changes to the customer lawn report, each DECIDED ONCE at completion by the lawn write gate into service_records.structured_notes.lawnReportFacts { v: 1, reentry, productUse, ties, frozenAt } (first writer wins, before the first report build) and rendered only from the record. (1) Ready to re-enter is a CONDITION from the products applied, not a 30 minute clock: the visit's rule is the strictest of its products (dry < watered_in_and_dry; a product with no approved frozen facts, a label that is not plain 'until dry' (a stored hours figure, unreadable or no text), or no usable method marks the visit 'default' and keeps today's clock, so the condition is never weaker than the report's label floor); a lawn record carrying a real rule prints fixed sentences with no clock time and no countdown. (2) A spot product card says where it was used ('Spot treatment, about 250 sq ft' / 'Spot treatment'); whole-lawn cards unchanged. (3) A photo finding is tied to what was applied in fixed sentences: the Visit Summary freezes version 4 with the tie facts (v3 entries still render as they were frozen), the technician's chinch / caterpillar / fungus tap is a finding, and the tied product's 'What to expect' line reads curative. The tie part freezes only while GATE_LAWN_VISIT_SUMMARY_V2 is also live (lawnReportTiesLive()); the re-entry condition and the spot text need neither. The gate controls ONLY the freeze; a render and the PDF key (':rf=') read what the record carries, whatever the gate says, so a record without the block renders exactly as before. Strict opt-in: exactly 'true' in every environment, read at call time via lawnReportFactsLive(). Ships DARK; off = identical frozen notes and payload)
 *   GATE_LAWN_TREATMENT_GUIDE=true (lawn Fast Complete "Suggested from this lawn" cards, owner 2026-10-08, "build the guide": once the technician has confirmed the lawn assessment, the sheet shows one card per photo finding from a FIXED rule table in lawn-treatment-guide.js (no model call): weeds (10% coverage or more), fungus, chinch bugs and caterpillars (moderate or severe insect damage; the chinch card April through September) and dry spots, each with its check to do first and a one-tap product from the month's own add-ons; the technician taps every product, nothing is added by itself. A standing "Chinch bugs found" entry is in the optional list every month; Arena 50 WDG, then Atticus Talak 7.9 F at the Arena yearly cap, both resolved from the v13 program's staged rows. The context carries `treatmentGuide`, GET /:serviceId/lawn-fast/treatment-guide answers the cards, and the completion freezes which cards showed and what the technician did in structured_notes.lawnTreatmentGuide (never read by a customer or public path). Technician sheet only: no customer text, no report or public payload change. Strict opt-in: exactly 'true' in every environment, read at call time via lawnTreatmentGuideLive(), and live only while GATE_LAWN_SPOT_RULES and GATE_LAWN_V13 are also live (the weed card is the spot-rules Weed spots entry, and every product is read from the staged v13 rows). Ships DARK; off = the context, the routes and the sheet are byte-identical to before.)
 *   GATE_LAWN_TROUBLE_AREAS=true (lawn Fast Complete places and trouble areas, owner 2026-10-09, "start building these"; server/services/lawn-trouble-areas.js: every spot-treatment row on the sheet also asks WHERE on the lawn in one tap from a fixed closed list (Front, Back, Left side, Right side); the place rides the /complete product row as areaPlaces (a list: one spray on the Front and the Back is one application recorded at both; an older client's single areaPlace still works) and is stored with the completion's product record (service_products.treated_places, the first place also in treated_place, and the application ledger's, same); a per-property store of trouble areas (lawn_trouble_areas: place, type, first and last seen, active or cleared) is written at completion from spot rows that carry a place and read by the context, which shows the technician a compact "Known trouble areas" line, offers a known area as the default place for the matching row and lets the technician clear one (POST /:serviceId/lawn-fast/trouble-areas/:areaId/clear); the v13 yearly count and amount caps and the Arena 56-day interval are judged per (property, place) for spot rows that carry a place, the weed mix and the chinch ladder carry a decision per place (weedMix.byPlace, chinch.byPlace, troubleAreas.blocked), and the /complete preflight refuses a spot row whose place the cap forbids (400 lawn_place_limit) or that has no place (400 lawn_place_required); a ledger row with no place counts against every place of that lawn; whole-lawn rows keep the per-lawn logic; no limit value is added or changed; a guided pick (fungicide, caterpillar, dry spot) is held back only when no place permits it, and the weeds and chinch cards add a place's own set with one tap on the place; known limit: one place per product per visit; technician and office surfaces only: no customer text, no report or public payload change. Strict opt-in: exactly 'true' in every environment, read at call time via lawnTroubleAreasLive(), and live only while GATE_LAWN_SPOT_RULES, GATE_LAWN_V13 and GATE_LAWN_TREATMENT_GUIDE are also live (the guide is live in production; without it the sheet has no take-all or chinch ids). Ships DARK; off = the context, the routes, the sheet, the limits and the completion are byte-identical to before.)
 *   GATE_LAWN_RECLAIMED_HALF_N=true (owner 2026-10-05 and 2026-10-23: a lawn watered with reclaimed water gets half the nitrogen at every N visit, decided by the app, not the tech's memory; UF Mobile Irrigation Lab: 38% of 3,177 Manatee reclaimed-water evaluations got more than the recommended N from the water alone. server/services/lawn-reclaimed-water.js + server/services/waveguard-plan-engine.js nitrogenDecision: when the visit's property is marked reclaimed (customer_properties.reclaimed_water; an office or customer value wins over the Manatee County meter match of services/reclaimed-water-meters.js), a v13 N line's target is halved (the smaller of this and the November large-patch cut), the amount derives from it, and the line carries the note "Reclaimed water: half nitrogen today"; a pre-emergent plus fertilizer bag (October and 9x April Dimension) keeps its full rate because the pre-emergent rate matters, and the December 10-0-22 (a visit that states a potassium target) keeps its full rate because reclaimed water adds N, not K, and each says so; the new-sod swap bag (plain 24-0-11 in October and 9x April) is halved too; the county layer only ever says yes (a property at a meter), every other property stays unknown; lawnProtocols() serves the gate-on wording of the two reclaimed sentences only while this gate is on; the same gate shows the reclaimed control on the office property panel and runs the daily county-layer job (about weekly download, local match, no customer coordinate leaves the server). Strict opt-in: exactly 'true', read at call time via lawnReclaimedHalfNLive(). Ships DARK; off = the plan, the tank sheet, the Fast Complete planned amounts and every route are byte-identical to before.)
 *   GATE_LAWN_NO_SEASON_BOOST=true (owner 2026-10-24, lawn scoring review "GO", step 4: POST /admin/lawn-assessment/assess stores turf_density and color_health exactly as derived from the model, with no cool-week season multiplier (seasonAwareAdjustment shoulder 1.1/1.1, strong 1.15/1.25, or lawnAssessment.applySeasonalAdjustment shoulder x1.1, dormant x1.15/x1.25) on the one-call and the legacy path; the lawn prompt already asks for color "for the season", so the boost counted the season twice and could make the report's overall "up" line fire from the boost alone. Report wording (dormancyLikely, the seasonal color line) and the progress-engine season gates still read the season helpers. Strict opt-in: exactly 'true', read at call time via lawnNoSeasonBoostLive(). Ships DARK; off = today's seasonal boost, byte for byte. Only new assessments change.)
 *   GATE_STOCK_COUNT_AWARE_USAGE=true (owner 2026-10-29, "fix it": closing or back-filling a visit done BEFORE a product's latest physical count writes its usage movement (quantity, cost and job costing unchanged) but leaves inventory_on_hand and the insufficient-stock lockout alone, because the count already includes that use; the movement carries stock_before = stock_after and metadata.stockUnchanged 'used_before_latest_count'. Covers deductProductInventory and the per-completion consumables; server/services/inventory-count-guard.js. Strict opt-in, read at call time via stockCountAwareUsageLive(). Off = every close-out takes its usage off stock, as before. Kill switch: delete the variable.)
 *   GATE_LAWN_NOV_LARGE_PATCH_N=true (lawn v13 November visit, owner 2026-10-09; UF/IFAS Large Patch SS-PLP-5: reduce nitrogen, slow-release, November to May; server/services/waveguard-plan-engine.js visitNutrientTargets: when the lawn has an ACTIVE mapped LARGE PATCH (lawn_trouble_areas fungus area whose newest fungicide application at the place records the target Large patch, Brown patch or Rhizoctonia; another disease or an unknown one does not count since 2026-10-23; take-all does not count), the plan sizes the November nitrogen bag for 0.5 lb N per 1,000 sq ft instead of the visit's 0.75 lb N (LESCO 24-0-11: 2.1 lb per 1,000 instead of 3.1) and the line carries the note "Active large patch mapped: nitrogen reduced to 0.5 lb N (2.1 lb per 1,000). Close the spreader over the patch and 6 ft around it."; the one reduced target reaches the plan, the tank sheet, the completion defaults, the yearly limit check and the Fast Complete planned amount; never raises a target; November only (December's 10-0-22 bag is already 0.45 lb N); nitrogen only, potassium untouched; the rule is code config (server/config/lawn-v13-nitrogen-targets.js), no migration. Strict opt-in: exactly 'true', read at call time via lawnNovLargePatchNLive(), and live only while GATE_LAWN_TROUBLE_AREAS (which needs the v13 program) and GATE_LAWN_SPOT_TARGET (the disease target the large patch evidence is read from) are live, so a failed or empty trouble-area read keeps the normal target. Ships DARK; off = the plan, the tank sheet and the Fast Complete planned amounts are byte-identical to before.)
 *   GATE_LAWN_DEC_LARGE_PATCH_K=true (lawn v13 December visit, owner 2026-10-23, "do whatever is going to make the grass look its best"; UF/IFAS Large Patch SS-PLP-5: reduce nitrogen in the disease window; server/services/waveguard-plan-engine.js visitNutrientTargets / troubleProductSwap: when the lawn has an ACTIVE mapped LARGE PATCH (lawn_trouble_areas fungus area whose newest fungicide application at the place records the target Large patch, Brown patch or Rhizoctonia; another disease or an unknown one does not count; take-all does not count), the December whole-lawn bag is LESCO Black Out 0-0-24 AM Spar-TECH at 4.125 lb per 1,000 sq ft (0 lb N, 0.99 lb K2O, the same potassium as the 10-0-22) instead of the LESCO 10-0-22 at 4.5 lb (0.45 lb N); every other lawn keeps the 10-0-22; the rule is code config (server/config/lawn-v13-trouble-product-swaps.js) that reads the recipe's December swaps block (lawn-protocol-v13.json) and the 0-0-24 catalog row and staged December row come from migration 20261023121000. Strict opt-in: exactly 'true', read at call time via lawnDecLargePatchKLive(), and live only while GATE_LAWN_TROUBLE_AREAS (which needs the v13 program) and GATE_LAWN_SPOT_TARGET (the disease target the large patch evidence is read from) are live, so a failed or empty trouble-area read keeps the 10-0-22. Ships DARK; off = the plan, the tank sheet, the brief and the Fast Complete planned amounts are byte-identical to before.)
 *   GATE_LAWN_CHINCH_TETRINO_RATE=true (lawn v13 May visit, owner 2026-10-22; Tetrino label EPA 432-1591: chinch bugs 16-32 fl oz per acre, "under high pest pressure" the top rate, no more than 2 max-rate applications a year, 4 weeks apart, 64 fl oz per acre a year; server/services/waveguard-plan-engine.js visitNutrientTargets / chinchTetrinoRate: when the lawn has a mapped trouble area of type chinch (lawn_trouble_areas) that is ACTIVE or was resolved within the last 365 days, the May Tetrino line is planned at 0.735 fl oz per 1,000 sq ft (32 fl oz per acre) instead of 0.367 and carries the note "Chinch bugs mapped here: Tetrino at the label's high rate, 0.735 fl oz per 1,000 sq ft."; the one raised rate reaches the plan, the tank sheet, the completion defaults, the application-limit check, the Fast Complete planned amount and the previsit brief; May and Tetrino only, never lowers a rate, no other lawn changes; the raise also needs room under the Tetrino label limits (1.47 fl oz per 1,000 sq ft a year, 28 days between applications: a limit entry in server/config/lawn-v13-count-caps.js that applies to every Tetrino pass while GATE_LAWN_V13 is on, this gate on or off), else the visit plans 0.367; the rule is code config (server/config/lawn-v13-chinch-rate.js), no migration. Strict opt-in: exactly 'true', read at call time via lawnChinchTetrinoRateLive(), and live only while GATE_LAWN_TROUBLE_AREAS (which needs the v13 program) is live, so a failed or empty trouble-area read keeps the normal rate. Ships DARK; off = the plan, the tank sheet and the Fast Complete planned amounts are byte-identical to before.)
 *   GATE_LAWN_NEW_SOD_NOTE=true (lawn Fast Complete sheet applies the new-sod holds, owner 2026-10-09: for a visit at the home that has a sod record (property_preferences sod_laid_on), the context carries newSod: a banner (day N, whole lawn or the named part, the held classes, a large patch watch note), the product lines the holds cover (fertilizer bag, weed killer, pre-emergent, Tetrino, Dylox, Gravex) marked held with a plain reason and left off the sheet (the technician can still add one by hand, with a warning), a part-of-lawn record keeps the lines on with a skip-the-sod note (and a keep-fertilizer-off note through day 30), the LESCO 24-0-11 bag (2.5 lb per 1,000 in October, 2.1 lb in April) in place of the pre-emergent fertilizer bag while the pre-emergent hold is on, and a Sod mowed twice tick (POST /:serviceId/lawn-fast/sod-rooted) that saves sod_rooted_on once 30 days have passed (never for a visit dated after today), the hold-adjusted context goes only to a sheet that sends sodAware=1, and, when the holds take EVERY planned product off a whole-lawn visit, the sheet may be completed with no product (the context flags noProductAllowed with the one-sentence note; /complete re-judges an empty list that carries that note by rebuilding the context: 409 lawn_sod_no_product_stale when it disagrees); rules come from lawn-sod-holds.js; technician sheet only, no customer message; ships DARK, read at call time via lawnNewSodNoteLive(); off = byte-identical context and sheet)
 *   GATE_LAWN_NEW_SOD_REPORT_CARD=true (lawn web report "New sod" card, owner 2026-10-09: when a lawn Fast Complete completion at a home with an active sod hold kept a PLANNED product off the visit (fertilizer, weed killer, pre-emergent or Dylox), the completion transaction freezes structured_notes.lawnNewSod { v: 1, visitDay, sodLaidOn, covers, planRan, held: [{ kind, until, rootedCheck }], swap } (first writer wins, read on the transaction; a failed read freezes nothing and never fails the visit), and the web report adds payload key lawnNewSod, a card built from the frozen block alone by lawn-sod-report-card.js (title, what was held and when each resumes, the bag swap sentence, a fixed close); the page never re-reads the live sod record. Needs GATE_LAWN_NEW_SOD_NOTE as well (fails closed). Web report only: no PDF, SMS or email change, no model call, no migration. Strict opt-in: exactly 'true', read at call time via lawnNewSodReportCardLive(). Ships DARK; off = no freeze, byte-identical payload and page)
 *   GATE_LAWN_SPOT_TARGET=true (lawn Fast Complete target on a spot fungicide or insecticide row, owner 2026-10-09; server/services/lawn-spot-target.js: the context carries spotTargets (the closed lists of the expectations engine's own target table), the sheet shows one optional "Treating (optional)" choice on a spot fungicide or insecticide row and a "Recorded for:" line, with no tap, on a row a chinch find opened, and /complete stores service_products.targets for those rows from the SERVER's verdict (the trouble-area type confirmed by the staged sets decides; a tag is kept only when it stands for that same type). A stored target changes live customer text with existing sentences: the product's "What to expect" row reads curative and the product card's purpose line names the recorded target. Strict opt-in: exactly 'true' in every environment, read at call time via lawnSpotTargetLive(), and live only while GATE_LAWN_TREATMENT_GUIDE is also live. Ships DARK; off = no spotTargets key, no control, the sheet sends targets: [] and /complete stores exactly what it stored before.)
 *   GATE_LAWN_PHOTO_LABEL_PICK=true (lawn Fast Complete photo label, owner 2026-10-09; server/services/lawn-photo-shots.js: each filled photo slot on the lawn sheet gets a small chooser, "Shown to the customer as", over the shot list's customer wording, so a close-up the technician put in the Shaded area slot can read Close-up on the report. The chosen shot key rides with the photo to POST /admin/lawn-assessment/assess, is stored beside the photo in lawn_assessments.photos (no migration), and the report (web strip, photo set and PDF) prints that label instead of the slot's. The slot key itself (the recorded zone, the model's shot guide, pairing, hero order) never changes. Strict opt-in: exactly 'true' in every environment, read at call time via lawnPhotoLabelPickLive(). Ships DARK; off = byte-identical sheet, /assess payload, report payload, PDF and PDF cache key.)
 *   GATE_LAWN_FAST_COMPLETE=true (Lawn Fast Complete, server half, PR-C1: for a lawn visit of any type (recurring program, per-application or one-time), GET /:serviceId/lawn-fast/context answers what the one-screen completion sheet opens with (eligibility verdict with a reason, the visit's planned products each with its post-application watering rule, whether a confirmed lawn assessment exists, the soft photo status), POST /:serviceId/lawn-fast/watering-preview answers the per-product rules and the one watering sentence the report would print for the chosen products (the report's own builder, so they cannot differ), and a /complete body carrying a `lawnFast` block must pass a preflight: gate on, an eligible visit and a CONFIRMED lawn assessment. The photo minimum is advisory only, never a refusal. The schedule payload carries `lawnFastCompleteEnabled` per service. Customer-silent: sends no text or email and changes no completion messaging. Strict opt-in: exactly 'true' in every environment, read at call time via lawnFastCompleteLive(). Ships DARK; off = both routes answer 404 {enabled:false}, a `lawnFast` block on /complete is refused 409 lawn_fast_disabled, and the flag is false.)
 *   GATE_LAWN_WATERING_SMS=true (lawn visit watering text: a SEPARATE customer SMS right after the completion text carrying the visit's frozen watering instruction, rendered from the editable lawn_watering_instruction sms_templates row. Customer messaging, so strict opt-in: exactly 'true' in every environment, read at call time via lawnWateringSmsLive(); ALSO requires GATE_LAWN_WATERING_RULE (no frozen instruction exists without it). Ships DARK; off = byte-identical completion behavior, no extra reads or structured_notes writes.)
 *   GATE_LAWN_WATERING_EVERY_VISIT=true (lawn watering text for every product combination, owner 2026-10-22 "for all combinations, a text goes out, but the text is accurate": (1) a catalog watering rule may carry by_target entries (Acelepryn: water in for grubs, hold for caterpillars) and the visit's logged targets pick them (lawn-watering-rule.js rulesForTargets); (2) a water-in the label requires the same day (Dylox) beside a hold longer than its own label needs (the owner's 24-hour herbicide hold) shortens that hold to its label_minimum (lawn-watering-instruction.js rule E); (3) a visit whose products need no watering change gets the short "No watering change" text too; (4) a lawn visit that still gets no watering text raises ONE office alert naming the product or the clash, except a visit closed on a later day than it was worked (owner 2026-10-27, lawn-watering-late-close.js: no text, no alert, marker skipped_late_close); a visit closed with no tech-confirmed photo read alerts as no_lawn_read; (5) a guessed rule (source default, no stored label or owner rule) is no claim, so no text and the alert names the product; (6) the label ladder for clashing products (owner 2026-10-24): a label water-in window counts from the application, a hold shortens only to its own label_minimum and only for a stronger label line, a bait hold gives way to a label water-in, a humectant beside a hold takes its 24-hour window, and late in the day a same-day deadline may run to 11:59 PM with the full run (lawn-watering-instruction.js rule E, Y, H); a clash still left goes to the visit's technician as a Today-screen note, not the office (lawn-watering-tech-note.js). Customer messaging, strict opt-in: exactly 'true', read at call time via lawnWateringEveryVisitLive(); needs GATE_LAWN_WATERING_SMS and GATE_LAWN_WATERING_RULE. Off = today's instruction, text and no alert, byte for byte. Rollback: unset.)
 *   GATE_TS_FAST_COMPLETE=true (Tree & Shrub Fast Complete, server half: GET /:serviceId/tree-shrub/fast-context answers the one-screen completion sheet's month products, last-visit values and IRAC/palm-spacing warnings, and the schedule payload carries `treeShrubFastCompleteEnabled` for every technician (owner 2026-10-01: no per-tech flag; this gate is the only switch). Customer-silent; strict opt-in: exactly 'true' in every environment, read at call time via tsFastCompleteLive(). Ships DARK; off = the route answers 404 {enabled:false} and the flag is false.)
 *   GATE_FAST_COMPLETE_REPORT=true (Fast Complete report flow, owner "ok go" 2026-10-01: the tech portal opens the one-screen sheet for pest re-services AND regular untyped pest visits; the tech talks into a text box, taps customer home / pest activity 1-5 / one tip / the promise check, generates the AI report, reads it, traces the spray and completes through the full /complete path, billing and customer text as the full form. The schedule payload carries `fastCompleteReportEnabled`; POST /admin/dispatch/:id/voice-facts reads where the tech treated, the pests they named and how the sprays went down from the note, each quoted word for word. Strict opt-in: exactly 'true' in every environment, read at call time via fastCompleteReportLive(). Ships DARK; off = the flag is false, the route answers 404 {enabled:false} and the tech portal routes pest visits exactly as before.)
 *   GATE_TS_TECH_FINDINGS_COPY=true (Tree & Shrub tech findings in customer copy, parity with the lawn rulings, owner 2026-10-02: the technician's keep/confirm/hide/edit decisions on the photo-read findings are FROZEN on the service record (structured_notes.treeShrubTechFindings) whether or not the signed preview is accepted, and the customer report + AI report prompt obey them (a hidden finding never appears, a confirmed one reads as the technician's finding, an edit uses the technician's text; the photo read stays stored for the office). Also the palm-crown rule (owner 2026-10-01: photos are ground level, so no customer copy may call a palm's crown, spear leaf or newest fronds healthy). Customer copy, so strict opt-in: exactly 'true' in every environment, read at call time via tsTechFindingsCopyLive(). Ships DARK; off = nothing is stored and every report/prompt is byte-identical to before.)
 *   GATE_TS_LIGHTING=true (Tree & Shrub lighting-aware color, owner 2026-10-23, "add to tree and shrub", the lawn rule of GATE_LAWN_LIGHTING applied to plants: sun, shade and cloud change how green a plant looks in a photo, so (1) the T&S photo read (both models) also answers the photo's light (`lighting`: full_sun, overcast, open_shade, mixed_sun_shade, low_light, unknown; `hard_shadows`: yes, no, unknown); a missing or invalid answer becomes unknown and NEVER fails the read; (2) each visit's light is stored inside the assessment's existing composite_scores jsonb (`light`, `photo_lights`), no migration; the tech's Fast Complete / closeout preview carries the visit light back to Generate under its own signature (`lightSignature`), a missing or unsigned light is unknown; (3) the report's "Leaf Color & Vigor" trend is left out unless the latest two visits that carry a color score are in known, compatible light (lawn-lighting.js, owner 2026-10-22 option B: full sun and sun with shadows with each other, overcast and open shade with each other, sun never with diffuse light, a visit whose photos disagree is mixed light and compared with nothing). Overall, foliage, pest and water trends stay. A visit with no light read (every visit before this gate) is unknown and its color is never compared. Strict opt-in: exactly 'true' in every environment, read at call time via tsLightingLive(). Ships DARK; off = the prompt, schema, validation, stored data, preview response and report payload are byte-identical to before)
 *   GATE_TS_WATCH_LIST=true (Tree & Shrub seasonal watch list, owner DRAFT 2026-10-01, tech-facing and storage only: the photo read gains this month's watch list (server/config/tree-shrub-watch-list.js, month in America/New_York) and may name an item as a possible SIGNAL (an optional watch_signals field that never changes a score), GET /:serviceId/tree-shrub/fast-context adds `watchList`, the Fast Complete sheet shows a "This month's watch list" block (Seen / Not seen, Add from watch list, an extent) that never blocks Done, and the technician's choices are FROZEN on the service record (structured_notes.treeShrubWatchItems). Nothing reaches the customer report, PDF, SMS or email. Strict opt-in: exactly 'true' in every environment, read at call time via tsWatchListLive(). Ships DARK; off = the prompt and every result are byte-identical to before, fast-context has no watchList key and nothing is stored.)
 *   GATE_TS_OUTLINE=true (Tree & Shrub program overview, owner 2026-10-26 "also we need to go through other related outlines, etc and make sure they are more aligned like lawn outline", decision D4-A "do whatever you recommend": staff can build, preview, regenerate and send a Tree & Shrub outline from an estimate with a Tree & Shrub line (server/services/tree-shrub-service-outline.js, routes/admin-service-outlines.js serviceLine 'tree_shrub', the Estimates menu item, the composer), the lawn outline's customer page with the Tree & Shrub month list from the protocol's month cards, its products with the active ingredient and no rate, and its own text and email; packets stored with service_line tree_shrub and stamped content ts-v1-copy-1; ships DARK, read at call time via tsOutlineLive(); off = no Tree & Shrub outline can be built, regenerated or sent, the lawn outline and the Estimates list exactly as before, and a stored Tree & Shrub outline still opens from its link; the outline is sent only when staff press Send)
 *   GATE_PEST_OUTLINE=true (Pest Control program overview, owner 2026-10-26 "also we need to go through other related outlines, etc and make sure they are more aligned like lawn outline", decision D4-A "do whatever you recommend": staff can build, preview, regenerate and send a Pest Control outline from an estimate with a recurring pest line (server/services/pest-service-outline.js, routes/admin-service-outlines.js serviceLine 'pest_control', the Estimates menu item, the composer): the lawn outline's customer page with the year as four seasons, the inside rule of 2026-10-22, the plan's interior-spray and eave-sweep opt-outs, and the products read from the catalog with the active ingredient and no rate; packets stored with service_line pest_control and stamped content pest-v1-copy-1; ships DARK, read at call time via pestOutlineLive(); off = no Pest Control outline can be built, regenerated or sent, the other outlines and the Estimates list exactly as before, and a stored Pest Control outline still opens from its link; the outline is sent only when staff press Send)
 *   GATE_MOSQUITO_OUTLINE=true (Mosquito program overview, owner 2026-10-26 "also we need to go through other related outlines, etc and make sure they are more aligned like lawn outline", decision D4-A "do whatever you recommend": staff can build, preview, regenerate and send a Mosquito outline from an estimate with a recurring mosquito program row (server/services/mosquito-service-outline.js, routes/admin-service-outlines.js serviceLine 'mosquito', the Estimates menu item, the composer): the lawn outline's customer page with the year as four seasons, the tips read by id from the service-report tip library (a sourced-only tip drops with GATE_TECH_TIP_SOURCES off), Bti dunks and mosquito stations only when the estimate holds them, and the products read from the active catalog rows with the active ingredient and no rate; packets stored with service_line mosquito and stamped content mosquito-v1-copy-1; ships DARK, read at call time via mosquitoOutlineLive(); off = no Mosquito outline can be built, regenerated or sent, the other outlines and the Estimates list exactly as before, and a stored Mosquito outline still opens from its link; the outline is sent only when staff press Send)
 *   GATE_TS_PEST_CHECK=true (Tree & Shrub live-insect check, owner 2026-10-05, tech-facing and storage only: GET /:serviceId/tree-shrub/fast-context adds `pestCheck`, the Fast Complete sheet shows a "Live insects found?" Yes / No block with insect-type chips, blocks Merit when only armored scale is picked, notes a live-finds-only product on a No, and the answers are FROZEN on the service record (structured_notes.treeShrubPestCheck). Nothing reaches the customer report, PDF, SMS or email. Strict opt-in: exactly 'true' in every environment, read at call time via tsPestCheckLive(). Ships DARK; off = fast-context has no pestCheck key and nothing is stored.)
 *   GATE_ASSESSMENT_FAST_COMPLETE=true (Waves Assessment Fast Complete, owner 2026-10-09: the schedule payload carries `assessmentFastCompleteEnabled` for a visit whose completion profile is the assessment key, and admin Dispatch opens a one-screen sheet (talk note, photos, warm/cold/lost, recommended interests, the inspection credit toggle where the full form shows it) in place of the full form. Complete records the consultation outcome, then posts /complete with texts and the review ask off. Strict opt-in: exactly 'true', read at call time via assessmentFastCompleteLive(). Ships DARK; off = the full form as before.)
 *   GATE_LEAD_SERVICE_DISPLAY=true (Lead service names, owner 2026-10-09: the lead list and lead detail responses carry `service_display`, the lead's service named the way the booking catalog names it, and the Leads screen shows it with the stored text as a tooltip; lead search also matches the shown name. Display only: `leads.service_interest` is never rewritten and nothing is sent to a customer. Strict opt-in: exactly 'true', read at call time via leadServiceDisplayLive(). Ships DARK; off = the screen shows the stored text.)
 *   GATE_TS_NEONIC_CAP=true (Tree & Shrub yearly neonicotinoid cap per property, owner 2026-10-09, tech-facing; server/services/tree-shrub-neonic-ledger.js, server/config/tree-shrub-neonic-caps.js: Zylam and Safari share one dinotefuran cap, Merit has its own imidacloprid cap, each a label amount per acre per calendar year scaled to the property's bed area (customer_properties.bed_sqft); dinotefuran counts from any visit at the property, imidacloprid from tree & shrub visits only. GET /:serviceId/tree-shrub/fast-context adds `neonicCap`, the Fast Complete sheet shows how much of each capped product is left this year and holds Complete when an entered amount passes it. Like the live-insect check the hold is the sheet's; /complete does not refuse. No bed area = the yearly amount cannot be computed and the amount check blocks nothing; the application-count hold and the no-limit-on-file hold need no bed area and still apply. Nothing reaches the customer. Strict opt-in: exactly 'true' in every environment, read at call time via tsNeonicCapLive(). Ships DARK; off = fast-context has no neonicCap key and /complete never checks.)
 *   GATE_LAWN_RESERVICE_FAST_COMPLETE=true (Lawn re-service Fast Complete: GET /:serviceId/lawn-reservice/fast-context answers the one-screen completion sheet's last-lawn-visit product tiles and catalog, and the schedule payload carries `lawnReserviceFastCompleteEnabled` per service so the tech portal opens the sheet for a lawn_re_service visit instead of the typed Dispatch form. The sheet completes through the full /complete with one_time_lawn_treatment findings. Customer text is the full form's default completion text. Strict opt-in: exactly 'true' in every environment, read at call time via lawnReserviceFastCompleteLive(). Ships DARK; off = the route answers 404 {enabled:false}, the flag is false and routing is the typed Dispatch form exactly as before.)
 *   GATE_FAST_COMPLETE_VOICE_FILL=true (Fast Complete voice fill, server half: POST /api/admin/dispatch/:serviceId/fast-complete/voice-fill/clip transcribes the sheet's recording with our own transcriber and maps what the technician said onto the pest re-service sheet's own product, pest, where, how and activity choices through one structured model call (services/fast-complete-voice-fill.js), validated server-side so anything off-list or unspoken, including any amount without a spoken number, comes back as an `unclear` item, and splits the note into a customer note and an office note. Nothing is stored; the audit line carries counts only, never the audio, the transcript or notes. Strict opt-in: exactly 'true' in every environment, read at call time via fastCompleteVoiceFillLive(). The report flow (GATE_FAST_COMPLETE_REPORT: any untyped pest visit, and any specialty visit the sheet reads a lane or typed record for) has its own two reads under the same gate: .../voice-fill/dictation answers one clip as words for the note box, and .../voice-fill/products reads the products the note names when the report is written; the sheet lands them as rows the technician confirms. The lawn re-service sheet (GATE_LAWN_RESERVICE_FAST_COMPLETE also on) uses the same two reads against its own catalog and ways. Ships DARK; off = each route answers 404 {enabled:false}.)
 *   GATE_FAST_COMPLETE_INVOICED_VISITS=true (Fast Complete for a visit already invoiced or returning from the payment flow, owner 2026-10-09: admin Dispatch opens the visit's one-screen sheet instead of the full form, and the sheet posts invoiceAlreadySent: true exactly when the full form does (the visit carries completionInvoiceAlreadySent), so /complete takes the same branch: no second pay-link text, the existing invoice reused, a paid invoice left paid. The schedule row's `invoicedVisitFastCompleteEnabled` carries the gate. Strict opt-in: exactly 'true', read at call time via fastCompleteInvoicedVisitsLive(). Ships DARK; off = the full form, as before.)
 *   GATE_NOTE_BOX_PHOTOS=true (Photos in the notes box, owner "ok go" 2026-10-02 on the Fast Complete mockup v8: the office Complete Service form puts the visit's photos inside the notes box, each with a short description typed or dictated that rides as the photo's caption to the report writer and the customer's report, and the separate photo section goes away. The schedule payload carries `noteBoxPhotosEnabled` per service, never for lawn or tree, shrub & palm. Strict opt-in: exactly 'true', read at call time via noteBoxPhotosLive(). Ships DARK; off = the form's photo section exactly as before.)
 *   GATE_LANE_VOICE_FILL=true (Fast Complete step 2, owner "ok go" 2026-10-02 on the mockup v8: POST /admin/dispatch/:id/lane-facts reads a specialty visit's own record (bed bug, fire ant, tick, bee & wasp, mud dauber, mosquito) from the technician's note: the places from the lane's own list and at most one value per finding group, each with the note's own words, kept only when the lane's closeout offers it and the note holds the words, never a pair the completion refuses (services/visit-lane-facts.js, TEXT_POLICIES.fastStructured, lane visit_lane_facts). Writes nothing: the office form and the tech's sheet show each field with its words for a person to confirm. With GATE_FAST_COMPLETE_REPORT also on, the tech portal opens such a visit (one that completes without a project) in the Fast Complete sheet's report flow instead of the project editor: the sheet's record card fills from the note, and the report and the /complete body (areasServiced, structuredObservations) are written from it; the pest-recap context answers the visit's `lane`. Strict opt-in: exactly 'true', read at call time via laneVoiceFillLive(). Ships DARK; off = 404 { enabled: false }, and the tech portal routes lane visits to the project editor as before.)
 *   GATE_TYPED_VOICE_FILL=true (Fast Complete steps 3 to 5, owner "ok go" 2026-10-02 on the mockup v8: POST /admin/dispatch/:id/typed-facts reads a typed visit's own findings (cockroach, the German and palmetto knockdowns, flea, pest inspection, mosquito event, wildlife trapping, rodent exclusion, sanitation and inspection; step 4: rodent trap checks, rodent and termite bait stations; step 5: termite liquid, trenching, rodding, spot and foam treatments and termite inspections, never new-construction pre-treat) from the technician's note: each pick field's values from the typed form's own options (the form as served for the visit's service key), each count and the technician's own 0-5 rating where they set the score only when the quote states the number (digits or words), a termite treatment's solution strength only as the percent its quote states, each with the note's own words, kept only when the note holds the words and never a combination the completion's own validator (validateTypedFindings, requirements off) refuses, every side of a clash left for a person (services/visit-typed-facts.js, TEXT_POLICIES.fastStructured, lane visit_typed_facts). Free-text and product-filled (autoFilled) fields are never read, nor the state's notice questions (treatment notice posted, inspection notice affixed: always a tap); a rating already set (scoreSet) is never read over. The termite forms are read on the office form only: their visits keep the typed form on the tech portal (typedReportFlowEnabled stays off for them). Writes nothing: a person confirms every field. On, the schedule payload carries `typedVoiceFillEnabled` and Generate AI report on the office Complete Service form first posts the notes with the form's present values (judged only, never stored) and fills only the fields still empty, each shown with the words it came from; a field set is never filled over and a fill that clashes with one is left for a person. With GATE_FAST_COMPLETE_REPORT also on, the schedule payload carries `typedReportFlowEnabled` (never a combined visit) and the tech portal opens such a visit in the Fast Complete sheet's report flow in place of the typed form: Generate reads the record from the note the same way, its card shows each field with the words it came from (a Change for each pick, a box for a count or free text, the 0-5 score where the tech sets it), and the report and completion are written from the record (structuredFindings, the form's own treated areas, activityScore); a nothing-found record, a saved trace the report would show, or a product whose place only the full form records goes to the Full form. A typed inspection shows the office form's inspection-credit toggle (on unless the tech turns it off; sent as offerInspectionCredit), and, after sending, the sheet offers a one-tap "Book the follow-up" on the day a completion suggests (bed bug, flea, cockroach and the knockdowns; POST /admin/dispatch/:id/schedule-followup, a pending visit, as the office's Schedule follow-up books it; the sheet context's `followupBooking`). Strict opt-in: exactly 'true', read at call time via typedVoiceFillLive(). Ships DARK; off = 404 { enabled: false }, Generate is unchanged and typed visits open the typed form as before.)
 *   GATE_FAST_COMPLETE_WRAP_UP=true (owner 2026-10-10: the lawn visit and Tree & Shrub Fast Complete sheets show a "Wrap-up" section, the bottom of the full Complete Service form: adjust time on site (admin), re-entry countdown, completion text, payment link, review request and timing, next scheduled visit note. Their /lawn-fast/context and /tree-shrub/fast-context answers carry `wrapUp: true`; the sheets post the section's choices on /complete, which already takes every one. Untouched, the section posts the four customer-text flags the sheets already posted. Off = no key, and both sheets render and post exactly what they did. Strict opt-in: exactly 'true', read at call time via fastCompleteWrapUpLive(). Ships DARK.)
 *   GATE_PET_NAME_TEXT=true (WaveGuard perk, owner 2026-10-31 perks round 4 and 2026-11-01 "continue working on": the completion text adds one sentence that names the customer's dogs and cats and says when they can go back out, e.g. "Biscuit can go back out once the spray has dried." The sentence is one row of a closed table in server/services/pet-name-line.js, picked by the re-entry decision the visit's service report already prints (service-report/reentry.js buildReentryContext): a frozen lawn condition (dry, or watered in and dry), or the stored until-dry advisory of a pest, mosquito, lawn, tree and shrub or palm visit with an outside and/or inside re-entry target. Bait or station work, a visit with no re-entry on its report and an advisory not in the table get no sentence. No time or minute figure and no "safe"; the finished sentence still goes through customerCopyViolations. Names come from property_preferences.pets_structured (the customer app's Pets editor): dogs, cats and pets with no type only, one to three names (none or four and more = no sentence), an indoor pet left out of an outside line. It rides as its own paragraph after the template body and before the bundled review line, in every completion-family text except Fast Complete's fixed re-service text (which already carries its own pets line), and only for a performed visit. A failed read costs only the sentence, never the text. Customer copy, so strict opt-in: exactly 'true', read at call time via petNameTextLive(). Ships DARK; off = no extra read and byte-identical texts)
 *   GATE_STATION_FAST_COMPLETE=true (owner 2026-10-08: a termite or rodent bait station visit opens the one-screen Fast Complete sheet in admin Dispatch even while the station map (station-map-v1) is on. The sheet loads the property's station registry and shows "N stations, all OK"; the technician's note names exceptions by station number ("station 4 had activity, I replaced the bait in 7"), read by POST /admin/dispatch/:id/typed-facts when the request carries the sheet's stations (services/visit-station-facts.js: the number must be an active station of the visit's program, the status one of activity / serviced / no access, and the quoted words in the note, else dropped), each shown as a chip the technician taps to correct. The completion posts termiteStations exactly as the full form does (an entry per station, touched on exceptions) and the typed station counts from the shared rule (client/src/lib/station-checks.js). Adding, moving or retiring a station, a rodent trap check, a combined visit, an inspection-only outcome, a station with no pin and a registry that failed to load all stay on the full form. Needs GATE_FAST_COMPLETE_REPORT and GATE_TYPED_VOICE_FILL. The schedule payload carries `stationFastCompleteEnabled`. Strict opt-in: exactly 'true' in every environment, read at call time via stationFastCompleteLive(). Ships DARK; off = the flag is false, the typed-facts route reads no stations and station visits route exactly as before.)
 *   SELF_SERVE_NOTICE_HOURS=24 (not a gate — the self-serve BOOK notice window, server/services/scheduling/self-serve-notice.js: no SELF-SERVE booking of a slot starting within this many hours of now, on the estimate picker + reserve, /book, public reschedule's DESTINATION slot, public re-service and the assistant's booking tools; staff/admin/voice agent unaffected; cancels keep the fee-window policy; read at call time, default 24)
 *   SELF_SERVE_MOVE_NOTICE_HOURS=24 (not a gate — the self-serve MOVE notice window, same module, split out 2026-09-28 so a book-only env change never touches it, no fallback to SELF_SERVE_NOTICE_HOURS: no SELF-SERVE reschedule of a visit that itself currently starts within this many hours of now, on public reschedule (reschedule-public.js) and the promised-reschedule-link worker (reschedule-link-promises.js); the DESTINATION slot of a move still uses the book window above; read at call time, default 24)
 *   SELF_SERVE_ARRIVAL_GRACE_MINUTES=0 (not a gate — the self-serve arrival grace, server/services/scheduling/policy.js#selfServeArrivalGraceMinutes, owner ruling 2026-09-28 "I'd rather be more lenient than strict": a self-serve (customer-picked) time is an ARRIVAL window, kept when the technician can arrive within this many minutes of the window's start. CAPACITY MODE ONLY (GATE_SCHEDULING_CAPACITY) — reads 0 with it off — and never for a same-day pick (today's route is already live). Unset/blank/garbage/negative all read as 0 (today's byte-identical strict behavior); clamped to 120, the existing arrival-promise ceiling (ARRIVAL_WINDOW_MINUTES, utils/sms-time-format.js) — grace can only narrow that promise, never widen it. **ESTIMATE PICKER ONLY** (Codex r1 P1, #5314 — until GATE_BOOK_ARRIVAL_GRACE, the next line, gave /book its own opt-in): /book and public reschedule both run a STRICT pre-verify travel probe ahead of their capacity commit, so a grace-kept slot there would 409 SLOT_TAKEN before ever reaching the capacity check — `estimate-slot-availability.js` is the ONLY caller that opts find-time.js's `packCapacityEnds` into grace (`arrivalGrace: true`, checked in ADDITION to the env value — the flag is the real gate; the env alone changes nothing for /book, voice, re-service, inspection, or any reschedule surface, even though several of them share the SAME `packEnds:true` admission). Offer side also checks EVERY live hold on the tech/date (Codex r2 P1), not just the single nearest anchor `capacityGapNeighbours` picks per side — a hold's window is a promise, not a fixed slot, so an earlier-starting hold can still end later than a later-starting committed stop chosen instead, and grace must never overlook it. **A hold is certified ONCE, at reserve** (Codex r2 P0): `slot-reservation.js`'s `reserveSlot` is the ONLY `verifyArrivalCapacity` caller that passes `arrivalGraceMinutes` (its own commit path has no pre-verify probe under capacity), and it reads the EXACT grace that justified the offer — carried as its own HMAC-bound + cleartext field on the signed estimate slot offer (`utils/slot-offer-token.js`) — never a fresh live env read. **The wire format is opt-in PER OFFER, not a blanket bump** (Codex round 3: the first cut bumped the canonical string/slotId shape for every offer unconditionally, breaking every in-flight estimate offer at deploy even with grace dark — "default 0 = byte-identical" has to cover the wire format too): an ungraced offer (grace 0 or omitted — every `/book` offer, every estimate offer with capacity/grace off or the date excluded) signs/appends the EXACT `<base>.<exp>.<sig>` shape origin/main always produced, verifying under both old and new code across a deploy; only a genuinely graced offer takes the new `<base>.<exp>.<arrivalGrace>.<sig>` shape (and only such an offer in flight at the exact deploy instant fails once, same accepted trade as the file's original v1→v2 bump). `signCustomerFacingSlots` signs a non-zero grace only for a slot marked `routeMode: 'arrival_windows'` (find-time's own stamp, proof it passed the grace-aware filter at all — anything else signs 0, so a future non-route-mode generator's slot can never inherit an unchecked leniency). `commitReservation` NEVER applies a grace bound at all (keeps only the pre-existing 120-minute promise, byte-identical to before this lane): a hold reserved at grace 90 with an 80-minute delay is accepted regardless of what this env reads by accept time, and a grace change between offer and reserve is likewise inert for that one signed offer (fixed at mint time; only a fresh availability fetch picks up a changed value). `extendReservation` never re-verifies capacity fitness at all under capacity mode (a pre-existing, unrelated gap — a live hold's certified route order is trusted as-is; re-running the whole-route simulation on every extend was judged not cheap enough to add here), so a hold's grace certification is fixed at reserve time and is not re-checked if grace or the route changes before an extend.)
 *   GATE_BOOK_ARRIVAL_GRACE=true (owner-approved 2026-09-29: the SAME self-serve arrival grace the estimate picker already uses (SELF_SERVE_ARRIVAL_GRACE_MINUTES, above) now also applies to ONLINE BOOKING — /book offers (/api/booking/availability, /find-slots, the /capture-intent revalidation, public re-service, inspection booking) and their commit, createSelfBooking. **Ships DARK: off unless `true`/`1`/`on`**; needs GATE_BOOK_CAPACITY_COMMIT + GATE_SCHEDULING_CAPACITY live too (bookInsertionOffersLive()) and a grace value above 0 to change anything; read at call time via bookArrivalGraceLive() (config/feature-gates.js). Off = today's strict drive+15-minute travel-gap offer/commit, byte for byte. On: (1) the offer keeps a slot the strict gap would drop when the day's whole-route arrival simulation certifies the technician arrives within grace of the slot's start — waived ONLY against the PREVIOUS assigned committed stop (never a real window overlap, never a live hold, never the NEXT stop's side, never an unassigned/other-technician stop) and only when every other neighbour clears the strict gap; (2) find-time.js's packCapacityEnds now checks BOTH route neighbours of a candidate under that same rule (it used to test the previous-side pick against the previous stop only and the next-side pick against the next stop only, so picks that crowded the OTHER neighbour survived find-time and were dropped by /book's own mirror, emptying whole days); (3) the commit's strict pre-verify travel probe accepts exactly those waived previous-side clashes and verifyArrivalCapacity enforces the same grace bound, so offer and commit agree in both directions; (4) the offer's signed slot_sig carries a distinct policy tag (BOOK_ARRIVAL_GRACE_OFFER_POLICY, utils/slot-offer-token.js) and the EXACT grace that justified it (v3 field shape `<exp>.<grace>.<sig>`, only when grace > 0), so a flip between mint and confirm — either direction — fails the signature into the standard pick-your-time-again 409. The phone agent, public reschedule (its rebooker commit still runs the strict probe), office Find-a-Time, Intelligence Bar and auto-dispatch never opt in and are unaffected. Kill switch: unset it.)
 *   GATE_BOOK_PREFERRED_TIME=true (/book "Can't find a time?" block under the time picker: text-our-team link plus a preferred day/time request form -> POST /api/booking/preferred-time, which files an internal lead + one admin bell, and the lead closes itself as 'handled' (neither won nor lost, one admin FYI) when the customer later books online. Sends NOTHING to the customer (no SMS, no email, no confirmation text) and retires any open abandoned-booking intent for the same phone/session so the recovery worker cannot text them either. Strict opt-in in EVERY environment, read at call time via bookPreferredTimeLive(); the client learns it from GET /api/booking/config `preferred_time`. Off = the generic 404 on the POST and no block on the page.)
 *   GATE_BLOG_READ_DEPTH=true   (anonymous, cookie-free blog scroll-depth counter — POST /api/public/blog-read-depth accepts a no-cors beacon from the hub + spoke blog posts and upserts an aggregate daily count keyed by site/path/milestone; owner-approved 2026-09-27, "E2: cookie-free read-depth counts", extends the 2026-07-16 pre-consent Cloudflare-counter exception. Dark = the generic unknown-route 404 for EVERY request to the path, before the route's own rate limiter, per the house dark-GATE_* contract. No cookies, no IP, no per-visitor identifier is ever stored — see docs/public-route-contracts.md.)
 *   GATE_VISIT_PREP_PHOTOS=true (server-only dark foundation: customer attaches photos + a short note to a specific upcoming visit from the public /appointment/:token page — POST /api/public/appointment/:token/photos, plus an additive prepPhotos summary on the existing GET. Strict opt-in, read at call time via visitPrepPhotosLive(). The appointment-page entry ALSO needs GATE_APPOINTMENT_PAGE (it rides that router). The Waves app entry — POST /api/schedule/:id/prep-photos and the prepPhotos field on GET /api/schedule/next — needs only this gate; flipping it opens both entry points. Off = the generic 404 on both POST routes: the anonymous appointment-page route answers it before any body parse (visitPrepPreParserGuard, mounted ahead of the shared parsers in index.js); the authenticated app route answers it after the schedule router's normal authentication and shared parsers (a logged-in route exposes nothing to an anonymous probe), before its own limiter and multipart parse. Neither GET payload carries a prepPhotos key. Surfaces when on: the appointment-page box, the app's Send photos button, the tech Visit Brief's Customer flagged block, the stop chip, and the office feed item. Sends nothing to a customer.)
 *   GATE_VISIT_PREP_TECH_ALERTS=true (PR 6, customer-visit-photos scope doc §5.4 item 4: the assigned field technician gets a tech-home card plus a one-line push — "A customer sent photos for a visit on your route" — when a customer submits visit prep photos. Strict opt-in, read at call time via visitPrepTechAlertsLive() in server/services/visit-prep-tech-alert.js. ALSO requires GATE_VISIT_PREP_PHOTOS live (nothing to alert about otherwise). Deliberately its OWN gate rather than GATE_TECH_VISIT_NOTIFICATIONS — that gate is off in production, and this can be the first tech visit card to go live; it reuses that mechanism's card/push plumbing (tech_notifications + PushService.sendToAdminUser) without depending on its gate. Recipient = the visit's CURRENT assigned technician, re-read fresh at send time — never the pre-lock row. No technician, or a non-assignable one → no card. Never fired for a duplicate-only resubmit. Sends nothing to a customer.)
 *   GATE_EMAIL_APP_LINKS=true (customer emails: anchors to customer pages on the portal host skip SendGrid's click rewrite (clicktracking=off) so iOS universal links / Android App Links open them in the Waves app - services/messaging/email-link-policy.js untrackAppLinks via sendOne. Strict opt-in, read at call time via emailAppLinksLive(). Off = every link tracked as before #7229. Keep OFF until the app lands on the tapped page: device test 2026-10-31 opened the iPhone app on Home for /?tab=billing and /book.)
 *   GATE_SMS_LINK_WRAP=true (every portal link in an outbound customer/lead SMS becomes a tracked /l/<code> short link stamped to the text it went out in, so clicks show for ALL texts including manual ones typed with a full link — services/messaging/sms-link-wrap.js, wired at the sendCustomerMessage choke point before countSegments. Strict opt-in, read at call time via smsLinkWrapLive(). Customer/lead SMS only, never internal or MMS bodies, never non-portal hosts or links already /l/; any shortener error keeps the original link and logs a warn — never blocks a send. Dark = every body byte-identical to today.)
 *   GATE_OUTLINK_TRACKING=true (prep guides: every link to an OUTSIDE site — Amazon, Chewy, Elanco, Bravecto, ... — in the prep email and the public /prep/:token page is rewritten at RENDER time to /go/<code> on the portal host, which logs the click (template key, prep visit, customer, sha256 ip hash, UA; bots skipped) and 302s to the exact original URL. Destinations are pre-registered outbound_links rows keyed by a hash of the URL — the route never reads a URL from the request, so it is not an open redirect — and are never tagged or altered. Own-site, portal, mailto and tel links are untouched; the prep PDF keeps direct links; template content is never edited. Strict opt-in, read at call time via outlinkTrackingLive(). The /go route itself stays live in every state so links already sent keep working after the gate is turned off. Off = byte-identical to today. Sends nothing to a customer.)
 *   GATE_VISIT_PREP_PEST_READ=true (PR 5 — automatic pest read of a visit-prep submission's photos, dark. Strict opt-in, read at call time via visitPrepPestReadLive(); ALSO requires GATE_VISIT_PREP_PHOTOS and GATE_VISIT_FACTS live (the tech facts block is the only place a read is shown). Triggered from services/visit-prep.js's createVisitPrepSubmission — the ONE place a submission is created — fire-and-forget AFTER the submission's own transaction commits, never on the request path. A submission whose visit is a pest-only service (pest-production-calibration.js isPestOnlyServiceType — never a WDO inspection or assessment; a grouped stop counts if ANY live member at the same physical stop is), runs the same photo-id-v2 identifyPestV2 the app's Photo ID route calls and stores the result in pest_identifications with source='visit_prep', mode='internal' (already an allowed mode — no migration on that table). Lawn / tree & shrub / anything else resolves straight to read_status='unsupported', no engine call. VISIT_PREP_READ_DAILY_CAP (default 40) is this feature's OWN cap, separate from Photo ID's; a capped or failed read never blocks the submission — the technician still gets the photos, just with read_status='failed'. See docs in services/visit-prep-pest-read.js.)
 *   GATE_VISIT_PREP_PLANT_READ=true (sibling of GATE_VISIT_PREP_PEST_READ — automatic lawn / tree & shrub read of a visit-prep submission's photos, dark. Strict opt-in, read at call time via visitPrepPlantReadLive(); ALSO requires GATE_VISIT_PREP_PHOTOS and GATE_VISIT_FACTS live, same as the pest read. Triggered from the SAME single place, services/visit-prep.js's createVisitPrepSubmission, as its own independent fire-and-forget call — never disturbs the pest-read or tech-alert hooks there. A submission whose stop is a strict lawn-only or tree & shrub-only service (visit-prep-plant-applicability.js isLawnOnlyServiceType/isTreeShrubOnlyServiceType — never WDO, termite, or a Waves Assessment) runs the merged photo-id-v2 lawn/plant engine (identifyPlantV2, photo-id-v2/plant-engine.js — L3, no customer route yet) and stores the workup on the submission's own `read_result` jsonb column (no second table; the pest read's `read_ref` is untouched). A combined Lawn & Pest stop (one combined service_type such as "Lawn Care + Pest Control", or separate pest and lawn / tree & shrub members) gets BOTH reads under ONE claim (services/visit-prep-combo-read.js, read key 'combo:<subject>') only while BOTH this gate and GATE_VISIT_PREP_PEST_READ are live (owner ruling 2026-09-30); with one dark the one live engine reads that stop alone; the combo read counts 2 against the daily cap (two vision calls). Anything else resolves straight to read_status='unsupported', no engine call. Shares the pest read's SAME VISIT_PREP_READ_DAILY_CAP (default 40) and the same advisory lock key — deliberately ONE cap across both engines, not a second one; a capped or failed read never blocks the submission. See docs in services/visit-prep-plant-read.js.)
 *   GATE_VISIT_PREP_READ_SWEEP=true (visit-prep read recovery sweep, dark. Strict opt-in via visitPrepReadSweepLive(); ALSO requires a live read engine (visitPrepPestReadLive() or visitPrepPlantReadLive()). Every 15 minutes (scheduler.js, checked BEFORE the cron lock, so off = no query, no write) it re-runs the same dispatchVisitPrepRead (services/visit-prep-read-dispatch.js, which runs only live engines) for at most 10 submissions from the last 14 ET days on still-upcoming, join-eligible visits: read_status 'none' older than 15 minutes (never attempted: photo load failed, claim error, stop moved), 'unsupported' where a live engine now reads the stop, and a 'done' or 'failed' read made by the wrong engine or subject for the stop as it is now (released to 'none', then re-read; a row checked and needing nothing is skipped for an hour). Pending rows, and failed rows on the line they failed on, are never retried. One retry per row per case, per settled attempt for a stale read (activity_log markers); each retry claims only from the status it selected and counts against VISIT_PREP_READ_DAILY_CAP on the ET day it runs, like a first read. A batch with failed retries fails the job run (job_health).)
 *   GATE_CUSTOMER_ACTIVITY_TIMELINE=true (read-only Activity timeline on the admin customer screen: what a customer was sent (texts, emails) and what they did (link clicks, page views, text replies; email opens/clicks and raw token-page views are listed but never counted as engagement), merged from existing tables by services/customer-activity-timeline.js and served by GET /api/admin/customers/:id/activity. Strict opt-in, read at call time via customerActivityTimelineLive(). Dark = the route answers { enabled: false } and the panel renders nothing. Reads only; sends nothing to a customer and writes nothing.)
 *   GATE_CALL_COMMERCIAL_DICTATED_BOOKING=true (owner ruling 2026-09-30: a commercial job staff dictate on the call and the caller accepts, with a price agreed, auto-books on INBOUND calls (outbound waits for staff identity independent of the speaker labels) instead of always going to the office. The staff commitment quote AND the caller's acceptance quote must each appear word for word in a turn of their own speaker (call-reschedule-agreement.js groundRescheduleAgreement, reused unchanged); a missing/unlabeled transcript or a quote only in the other speaker's turn fails closed. Also needs GATE_CALL_AGENT_COMMIT_BOOKING (its kill switch) and GATE_CALL_AGENT_COMMIT_TRUSTED_LABELS. Only clears commercial_requires_quote — capacity, address validation, unit checks and the on-the-hour rule still apply, and no price agreed still goes to the office. Strict opt-in, read at call time via callCommercialDictatedBookingLive(). Off = byte-identical. hasAgentCommittedEvidence is untouched. See services/call-commercial-dictated-booking.js.)
 *   GATE_CALLBACK_SPAM_CLOSES_PARENT=true (an OUTBOUND call with metadata.relatedCallId (the admin Call back action on a voicemail) that lands a spam verdict also settles the parent inbound call: its open/in_progress triage_items whose reason a return call would have answered (the CALLBACK_SPAM_MOOT_CODES allowlist in call-triage-flags.js; other reasons stay open) resolve (resolution_source auto, resolution_rule callback_spam), its open Waves callback commitments are dismissed, review_status syncs to resolved when no card is left, metadata.callback_verdict is stamped. Nothing is sent. Strict opt-in, read via isEnabled. Off = today's behavior. Rollback: unset.)
 *   GATE_MISSED_CALL_ALERT_DETAIL=true (the missed-call bell and push body also name the line the caller dialed, the call length in seconds and, for a customer on file, the date of their next scheduled visit; admin copy only, nothing is sent to a customer. Strict opt-in, read via isEnabled. Off = today's sentence, byte-identical. Rollback: unset.)
 *   GATE_MISSED_CALL_REPUSH=true (a customer_missed_call bell still unread and not done 30 minutes after it rang gets ONE more admin push, same tag, renotify, during office hours Mon-Sat 8:00-18:00 ET; no new bell row, stamped metadata.repushed_at so it never repeats. Admin push only. Strict opt-in, read via isEnabled. Off = no sweep work. Rollback: unset.)
 *   GATE_CALL_EXTRACTION_SYSTEM_PROMPT=true (call extraction V2 sends its rules and output contract as a static system part and only the call's own facts and transcript as the user message, so the provider can cache the rules across calls. Same rules, different order and channel: its calls are their own prompt-version cohort (`s`, or `b` with the agent-proposed-slot block). Strict opt-in, read once per call via callExtractionSystemPromptLive(). Off = the one-message prompt, byte-identical. Rollback: unset.)
 *   GATE_CALL_EXTRACTION_V1_FALLBACK=true (call extraction V1 (extractCallData, the legacy extractor that still feeds the routing legs) runs on Gemini alone. When Gemini fails for a PROVIDER reason (a non-2xx answer such as 402 credits depleted, 429 or 5xx; a network error or timeout; GEMINI_API_KEY missing; or invalid JSON after the existing two parse attempts), this gate retries the SAME prompt through the house dispatcher: Claude first (MODELS.CALL_EXTRACTION_ANTHROPIC, pinned like the V2 Claude leg), then OpenAI (the pinned CALL_EXTRACTION_MODEL leg) if Claude also fails. Output goes through the same normalizeCallExtraction tail, so its shape is identical; the provider that served it is stamped as extraction_v1_provider in metadata.processing_timings and a warn line names the fallback. A bad answer that is not a provider failure keeps today's behavior, and when every backup leg fails the call takes the same path as before (extraction_failed with the attempt counter, or the invalid-JSON stub). Strict opt-in, read at call time via callExtractionV1FallbackLive(). Off = Gemini only, byte-identical. Rollback: unset. Sends nothing to a customer.)
 *   GATE_CALL_SPELLING_COLLAPSE_TRIGGER=true (call processing: the spelling-preserving second transcription pass and the contact decoder also run when the primary transcript shows what a collapsed spelling leaves behind: a name said twice in a row ("Serov, Serov"), a phrase that announces a spelling with no letters after it ("that's S", "with a C"), or, for the decoder, an extracted last name one or two letters from the stored one. Each match costs one extra transcription pass; the log line "[call-proc] spelling collapse trigger" names which signal fired. Strict opt-in, read at call time via callSpellingCollapseTriggerLive(). Off = the pass runs only on the signals it ran on before, byte-identical. Rollback: unset. See services/contact-dictation.js spellingCollapseSignals.)
 *   GATE_CALL_COMMERCIAL_ASSESSMENT_BOOKING=true (owner ruling 2026-10-06: a commercial Waves Assessment that Waves staff book on the call with NO price discussed auto-books, on OUTBOUND callback calls (lead_auto_bridge) as well as inbound, instead of always going to the office. Only the Waves Assessment catalog row (every service view of the call must resolve to it) and only when no price came up at all; any price mentioned goes to the priced path (GATE_CALL_COMMERCIAL_DICTATED_BOOKING), unchanged. The staff commitment and the caller acceptance are grounded word for word in the right speaker's turns (call-reschedule-agreement.js), including the shape where STAFF proposes the day and time, the caller says yes and staff then commits ("How does noon on Thursday sound?" / "Perfect." / "I'll book you for that"), which has its own extraction instruction while this gate is on. On an OUTBOUND recording the speaker labels are LLM-inferred and have swapped, so staff identity is proven independent of the labels: an Agent-labeled turn says "this is <name> with|from|at Waves" and no Caller-labeled turn does; otherwise it holds. Also needs GATE_CALL_AGENT_COMMIT_BOOKING (its kill switch) and GATE_CALL_AGENT_COMMIT_TRUSTED_LABELS. OUTBOUND calls qualify only as lead callback bridges (call metadata.type lead_auto_bridge) AND only when outbound booking creation itself is on: GATE_CALL_OUTBOUND_BOOKING plus V2 routing in enforce mode (CALL_EXTRACTION_V2_ENABLED=true and CALL_EXTRACTION_V2_DRIVES_ROUTING=true or CALL_TRIAGE_ENFORCE_V2_GATES=true); this gate never authorizes outbound creation by itself, and the routing lane and the creation path read one predicate (outboundAutoBookingEnabled). Only clears commercial_requires_quote and the advisory card still files; the on-the-hour rule, capacity, address validation and unit checks still apply. Strict opt-in, read at call time via callCommercialAssessmentBookingLive(). Off = byte-identical, outbound stays excluded. See services/call-commercial-dictated-booking.js.)
 *   GATE_LEAD_EMAIL_LINKS=true (Activity timeline only: also lists email that was sent to a prospect before they became a customer, matched by the lead / estimate the send recorded (email_messages.lead_id / estimate_id) through leads.customer_id and estimates.customer_id, not by address. Strict opt-in, read at call time via leadEmailLinksLive(). Dark = the timeline lists exactly what it did before. Recording the link on each send is not gated (additive columns).)
 *   GATE_RATE_REVIEW=true (annual rate review RANKING backend, plan annual-rate-review-2026-09-30 step 2: the monthly 1st-of-month job (scheduler.js, 6:20 AM ET) ranks every active recurring plan line whose anniversary falls in the following month into rate_review_snapshots (current rate per billing lane, today's list rate, treatment-minute median, revenue/hour, band A-D, whole-dollar proposal, exception flags) and sends ONE ACT:/OK: ops email to contact@; admin-only read routes + a recompute POST under /api/admin/rate-review. Strict opt-in, read at call time via rateReviewLive(). Dark = the cron tick returns before any query, the routes answer 404, nothing is written. The ranking never writes a rate or sends a customer anything. The APPLY lane (services/rate-review-apply.js, step 3) rides the same gate: an admin POST creates draft notice rows for approved rows (nothing sent — the comms lane sends), and the nightly 3:10 AM ET job writes the noticed rate on its effective date for SENT notices (per-application visits + per_application_fee + ledger slice, monthly dues + slice, or the prepaid term's next_term_prepay_amount), one transaction per notice, holds belled. Off = the apply tick returns before any query and the schedule route answers 404; customers keep the lower, current rate. The notice-sending lane is a later PR.)
 *   GATE_PLAN_RATE_LEDGER_RECONCILE=true (nightly plan-rate ledger invariant reconcile, 6:47 AM ET, services/plan-rate-ledger-reconcile.js: every live customer whose customer_plan_rates lines no longer add up to customers.monthly_rate is re-checked under the customer-comms lock and the customers row lock; a shortfall is parked in the 'unattributed' line (source invariant_repair), an overshoot is never deleted, and each distinct gap raises one Billing alert (at most 5 new a run). Never changes the billed rate, never charges, never messages a customer. Strict opt-in, read at call time via planRateLedgerReconcileLive(), which ALSO needs GATE_PLAN_RATE_LEDGER. Ships DARK; off = the tick returns before the cron lock: no query, no write, no alert.)
 *   GATE_ADMIN_MFA=true (staff two-step sign-in: a staff member who has set up an authenticator app must enter its 6-digit code (or a single-use recovery code) after the password before a session is issued, and a session minted without that step is refused; the enrollment page /admin/two-step and its /api/admin/auth/mfa routes answer only while on. Read at call time via adminMfaLive() in server/services/staff-mfa.js; off = login, /me and every staff session are exactly as before, whatever was enrolled, so unset is the kill switch.)
 *   GATE_ADMIN_MFA_ENFORCE=true (needs GATE_ADMIN_MFA: an ADMIN with no authenticator set up is held on the two-step enrollment page — every other staff route answers 403 MFA_ENROLLMENT_REQUIRED — until they finish it. Read at call time via adminMfaEnforceLive(); unset = enrollment stays optional.)
 *   GATE_STAFF_DEFAULT_DENY=true (owner 2026-10-02: a technician-role staff login reaches ONLY the routes on server/middleware/technician-scope.js — own schedule/visits, own timesheet, texts with own-visit customers, promises, protocols, documents, pay-growth, knowledge READ, equipment/inventory READ; every other staff route is a 403 before it runs. Off = today's behavior plus a once-per-route "[staff-scope] would-deny" log line so the production log shows real technician use before the flip. Admins are never affected. docs/technician-reachable-routes.md is the rendered list.)
 *   GATE_SERVER_DICTATION=true (every staff voice-to-text mic goes through our own transcriber: the mic records a clip and POSTs it to /api/tech/dictation, which hears it with `gpt-transcribe` primed with a server-built word list (the named customer, active technicians, catalog products, service names, pest and lawn terms) instead of the browser's speech recognition, which on iPhone is Apple dictation and mishears names, products and pests. Words appear after the mic stops, not live. Strict opt-in: exactly 'true' in every environment, read at call time via serverDictationLive(). Ships DARK; off = the endpoint answers 404 / {available:false} and every mic keeps today's browser behavior.)
 *   GATE_REPORT_PLAN_RESCHEDULE=true (service report, owner ruling 2026-10-06: "Your plan" and "Your upcoming visits" become one section, and each upcoming visit gets a Reschedule button that opens the customer's self-serve /reschedule link. The server adds rescheduleUrl to each visit and `merged: true` to upcomingVisitsCard; a link is reused, never minted again on each view, and is null when the visit is too close to move or the link cannot be built. Needs GATE_REPORT_UPCOMING_VISITS, which supplies the visits. Strict opt-in: exactly 'true' in every environment, read at call time via reportPlanRescheduleLive(). Ships DARK; off = the report payload and page are byte-identical to before and the two sections stay separate. Sends nothing to a customer.)
 *   GATE_LAWN_REPORT_CLARITY=true (lawn service report, owner ruling 2026-10-08, one gated change left: "Your plan" on a LAWN report lists only the next upcoming lawn visit at the report's property (needs GATE_REPORT_UPCOMING_VISITS; merged or standalone); other service lines are unchanged. The ruling's other half is permanent and ungated since 2026-10-09: a water-in instruction frozen at completion for a customer with NO sprinkler head type or measured rate on file states the AMOUNT and no minutes ("Water in today's treatment with about ½ inch by Fri 8 PM"), and the LIVE banner adds one line inviting the customer to add their sprinkler setup (banner.setupLine, stripped from the PDF, static and text renders). Strict opt-in: exactly 'true' in every environment, read at call time via lawnReportClarityLive(). Ships DARK; off = byte-identical plan card. Sends nothing to a customer.)
 *   GATE_DICTATION_CUSTOMER_NAMES=true (owner 2026-10-20, after a dictated surname was heard as a common word: staff dictation word list (needs GATE_SERVER_DICTATION) adds a "Customers who may be named" section, full names: the customer on screen first, then customers with a visit today or tomorrow (a technician login: only their own stops), customers who texted or called in the last 48 hours and recently updated active customers (admin logins only), and passes their surnames as extra transcriber keyword hints. Products shrink to make room; the prompt stays at 1800 characters. The list is cached 5 minutes per login scope and day. Strict opt-in: exactly 'true' in every environment, read at call time via dictationCustomerNamesLive(). Ships DARK; off = the word list and keyword hints are exactly as before. Sends nothing to a customer.)
 *   GATE_DICTATION_MONEY_NORMALIZE=true (owner 2026-10-21, after "sixty-one thirty-three" came back as 6133, $60.33 and $61.33: the staff mic's transcript is read for dollar amounts. In a money context only (a $ or a word like price, charge, rate, a month), the server SUGGESTS (never rewrites; the transcript is returned exactly as heard) "$61.33" for "sixty-one thirty-three", "61 33" or "sixty one dollars and thirty three cents" and "$105" for "a hundred and five"; a run-together "$6133" is kept as typed and flagged ambiguous, so the Intelligence Bar asks with answer buttons between $61.33 and $6,133. Phone numbers, street numbers, times, dates, ZIPs, invoice numbers and quantities with units are never touched. Strict opt-in: exactly 'true' in every environment, read at call time via dictationMoneyNormalizeLive(). Ships DARK; off = the transcript is returned as before. Sends nothing to a customer.)
 *   GATE_SERVICE_SHEET_PRICE_SCOPE=true (owner 2026-10-26 "Build it as shown", bug 4 of the 10-24 price audit: the service-line sheet (MobileServiceEditModal, phone checkout and the Dispatch checkout's service line) asks "This appointment only / This and following appointments" when a recurring-series visit's price is edited, the same choice Edit appointment offers, and posts it as priceServiceScope. Needs GATE_EDIT_APPT_PRICE_SERVICE_SCOPE too: /series-summary answers canScopeSheetPrice:true only when both are on. Strict opt-in, read at module load via isEnabled('serviceSheetPriceScope'); off = the sheet asks nothing and posts no scope, exactly as before. Kill switch: delete the variable.)
 *   GATE_TAX_DEADLINE_BELLS=true (owner 2026-10-30, "All tax deadlines ring": the 8:23 AM ET tax deadline job raises each reminder as an admin bell (category tax, owner Settings override still wins) in place of the text to the owner phone, which the bell policy had silenced since 2026-09-01 while the job still marked the row reminded. Payroll rows ring 14 days before, 3 days before, the business day before and each morning after a missed date until marked; other rows (sales tax, estimated tax) ring once, 14 days before. A bell closes when its row is marked filed or paid. Read at call time via taxDeadlineBellsLive(), strict 'true', dark by default; off = the text and the reminded marks are exactly as before. Sends nothing to a customer. Rollback = unset.)
 *   GATE_PAYROLL_MERCURY_STATUS=true (basic payroll option A, owner plan 2026-10-30: Waves works out each W-2 paycheck and Mercury sends it only after the owner approves it in the Mercury app. Needs GATE_PAYROLL. This is the read-only half: the 15-minute poller that reads each payment's approval request and transaction from Mercury, the recipient check when a Mercury recipient id is saved on a technician, the warnings before a send, and the payment chips on the pay run. Needs the env MERCURY_API_TOKEN (a custom token with read scopes and Send Money with Approval) and MERCURY_ACCOUNT_ID; MERCURY_API_BASE defaults to https://api.mercury.com/api/v1. The token, account number, routing number and any Mercury answer are never logged or stored. Read at call time via payrollMercuryStatusLive(), strict 'true', dark by default; off = no Mercury call at all and every payroll output and route is byte for byte today's; rollback = unset. Sends nothing to a customer or staff member.)
 *   GATE_PAYROLL_MERCURY_PAY=true (basic payroll option A, owner plan 2026-10-30. Needs GATE_PAYROLL and GATE_PAYROLL_MERCURY_STATUS. Turns on Send to Mercury and Send again on a finalized pay run: for each bank-transfer paycheck with a Mercury recipient id the portal asks Mercury for an APPROVAL REQUEST (POST request-send-money); no money moves until a different Mercury user approves it in the Mercury app, and the portal never calls Mercury's direct send. A request is never sent twice by code: a lost answer becomes an 'unknown' payment the owner resolves. Read at call time via payrollMercuryPayLive(), strict 'true', dark by default; off = no request is ever made; rollback = unset (existing payment rows stay and still block a void).)
 *   GATE_BUG_ID_EXTENSION=true (owner 2026-10-31, "Let's do the insect identification": the Chrome extension's bug identifier, POST /api/public/bug-id-extension/identify. Anonymous and worldwide, so no lead capture, no pricing, no row and no stored photo; 1–3 photos go to the v2 species-catalog pest engine (identifyPestV2, Gemini-only ladder, as the customer app) and only its customer-facing v2 answer comes back. Paid vision per request, bounded by 6/hour and 15/day per IP plus one worldwide daily cap of its own (PUBLIC_LLM_DAILY_CAP_BUG_ID_EXTENSION, default 100, bucket bug-id-extension) that counts whatever GATE_PUBLIC_LLM_SHARED_CAP says and fails closed. Read at call time via bugIdExtensionLive(), strict 'true', dark by default; off = the whole /api/public/bug-id-extension surface answers 404 before cors(), any limiter or body parser. Sends nothing to anyone. Kill switch: unset.)
 *
 * In development, most gates are OPEN by default so you can test locally.
 * Customer-facing auto-send gates still require explicit opt-in everywhere.
 */

const isProd = process.env.NODE_ENV === 'production';

const gates = {
  // GATE_AI_CREDIT_KEYS (credit-only API key pool for Anthropic and OpenAI calls, dark). Boot-log entry only; the wrapper is installed at boot by credit-key-pool.js.
  aiCreditKeys: process.env.GATE_AI_CREDIT_KEYS === 'true',
  // GATE_BID_KIT (Bid kit, admin only, dark). Boot-log entry only; the call-time reader is bidKitLive().
  bidKit: process.env.GATE_BID_KIT === 'true',
  // GATE_BID_KIT_PRODUCT_LIST_SYNC (daily Product List rebuild in the Bid kit, dark). Boot-log entry only; the call-time reader is bidKitProductListSyncLive().
  bidKitProductListSync: process.env.GATE_BID_KIT_PRODUCT_LIST_SYNC === 'true',
  // GATE_PRODUCT_INTAKE_GUARD (near-name guard + EPA number/label for agent-created pesticides, dark). Boot-log entry only; the call-time reader is productIntakeGuardLive().
  productIntakeGuard: process.env.GATE_PRODUCT_INTAKE_GUARD === 'true',
  // GATE_REVIEW_FIRST_ASK_LOCK (first review ask box locked on for a never-asked customer, dark). Boot-log entry only; the call-time reader is reviewFirstAskLockLive().
  reviewFirstAskLock: process.env.GATE_REVIEW_FIRST_ASK_LOCK === 'true',
  editorialEvidence: gateEnvValue('GATE_EDITORIAL_EVIDENCE'),
  // Customer iOS icon count; opt-in everywhere, with request-time route checks.
  customerNativeBadges: gateEnvValue('GATE_CUSTOMER_NATIVE_BADGES'),
  // Billing Email/Text/App preference API; opt-in everywhere and read at request time by the route.
  billingNotificationChannels: gateEnvValue('GATE_BILLING_NOTIFICATION_CHANNELS'),
  // Staff Quick Links receipt picker; delivery evidence is recorded even while dark.
  composerReceiptLinks: process.env.GATE_COMPOSER_RECEIPT_LINKS === 'true',
  // GATE_LAWN_PROPERTY_HISTORY: opt-in in every environment. Registered for
  // logGateStatus only; consumers use gateEnvValue at CALL time.
  lawnPropertyHistory: gateEnvValue('GATE_LAWN_PROPERTY_HISTORY'),
  // GATE_APP_PROPERTY_SCOPE: the customer app scopes visits and appointment
  // texts by SAVED PROPERTY (customer_properties) instead of by sibling
  // profile (docs/multi-property-model.md, "App property scope"). Off: the
  // session's propertyId claim is ignored (req.propertyId null),
  // GET /auth/properties answers the profile list, and select-property
  // ignores propertyId — tonight's behavior exactly. Registered for
  // logGateStatus; consumers read it at CALL time (gateEnvValue).
  appPropertyScope: gateEnvValue('GATE_APP_PROPERTY_SCOPE'),
  // GATE_APP_PROPERTY_TEXTS: appointment texts for a NON-primary saved
  // property follow that property's own toggles (property_notification_prefs,
  // ruling-R1 defaults). Off (ruling R5): the sender seams resolve the
  // property decision and record it in property_text_decisions next to the
  // customer-row decision — the shadow log — with zero change to sends. Only
  // meaningful with GATE_APP_PROPERTY_SCOPE on. Consumers read it at CALL
  // time (gateEnvValue).
  appPropertyTexts: gateEnvValue('GATE_APP_PROPERTY_TEXTS'),
  // Registered for startup logging; the planner decides both gates per operation.
  lawnCompletionDefaults: gateEnvValue('GATE_LAWN_COMPLETION_DEFAULTS'),
  propertyServiceAreas: gateEnvValue('GATE_PROPERTY_SERVICE_AREAS'),
  lawnCostPlusList: gateEnvValue('GATE_LAWN_COST_PLUS_LIST'),
  mosquitoMisting: gateEnvValue('GATE_MOSQUITO_MISTING'),
  // Registered for startup logging; the completion writer reads it at call time (strict 'true').
  lawnActualsLedger: process.env.GATE_LAWN_ACTUALS_LEDGER === 'true',
  // Lawn delivery recovery sweep. Resuming a confirmed visit's delivery can put
  // a real customer SMS on the wire, so it FAILS CLOSED in every environment per
  // the house rule — a dev box or preview pointed at a production-seeded database
  // must never text a customer on boot. Off → the sweep shadow-logs its candidate
  // count and delivers nothing. Double-gated: the cron also needs cronJobs.
  // gateEnvValue here and in the sweep, so startup logging can never report this
  // safety gate as disabled while it is actually open ('1' / 'on').
  lawnDeliveryRecovery: gateEnvValue('GATE_LAWN_DELIVERY_RECOVERY'),
  // Visit prep photos (dark server foundation). Registered for
  // logGateStatus only; the route and service read visitPrepPhotosLive()
  // at call time below so a flip needs no redeploy.
  visitPrepPhotos: process.env.GATE_VISIT_PREP_PHOTOS === 'true',
  // Tech card + push for a visit-prep photo submission (PR 6). Registered
  // for logGateStatus only; the service reads visitPrepTechAlertsLive() at
  // call time below so a flip needs no redeploy.
  visitPrepTechAlerts: process.env.GATE_VISIT_PREP_TECH_ALERTS === 'true',
  // Visit prep photos — automatic pest read (PR 5). Registered for
  // logGateStatus only; services/visit-prep-pest-read.js reads
  // visitPrepPestReadLive() at call time below (its own strict opt-in,
  // ALSO requiring visitPrepPhotosLive()).
  visitPrepPestRead: process.env.GATE_VISIT_PREP_PEST_READ === 'true',
  // Visit prep photos — automatic lawn / tree & shrub read (sibling of the
  // pest read above). Registered for logGateStatus only;
  // services/visit-prep-plant-read.js reads visitPrepPlantReadLive() at
  // call time below (its own strict opt-in, ALSO requiring
  // visitPrepPhotosLive() and GATE_VISIT_FACTS).
  visitPrepPlantRead: process.env.GATE_VISIT_PREP_PLANT_READ === 'true',
  // Visit prep read — recovery sweep. Registered for logGateStatus
  // only; services/visit-prep-pest-read-sweep.js reads
  // visitPrepReadSweepLive() at call time below (its own strict opt-in,
  // ALSO requiring a live read engine).
  visitPrepReadSweep: process.env.GATE_VISIT_PREP_READ_SWEEP === 'true',
  // SMS portal-link wrap. Registered for logGateStatus only; the choke point
  // reads smsLinkWrapLive() at call time below so a flip needs no redeploy.
  smsLinkWrap: process.env.GATE_SMS_LINK_WRAP === 'true',
  // Customer-email links that skip SendGrid's click rewrite (dark). Registered
  // for logGateStatus only; email-link-policy.js reads emailAppLinksLive().
  emailAppLinks: process.env.GATE_EMAIL_APP_LINKS === 'true',
  // Prep-guide outside-link click tracking (dark). Registered for
  // logGateStatus only; services/outlink-tracking.js reads
  // outlinkTrackingLive() at call time below.
  outlinkTracking: process.env.GATE_OUTLINK_TRACKING === 'true',
  // Portal / app activity (last_seen_at stamp + page-view and push-open beacons).
  // Registered for logGateStatus only; consumers read portalActivityLive() at
  // call time below so a flip needs no redeploy.
  portalActivity: process.env.GATE_PORTAL_ACTIVITY === 'true',
  emailSendLater: process.env.GATE_EMAIL_SEND_LATER === 'true',
  // Managed Agents session spend cap + interrupt of abandoned sessions (dark).
  // Registered for logGateStatus only; services/agent-control/session-guard.js
  // reads agentSessionGuardLive() at call time below.
  agentSessionGuard: process.env.GATE_AGENT_SESSION_GUARD === 'true',
  // Complete Service: job-matched estimate evidence and reviewed discounts.
  completionServicePricing: process.env.GATE_COMPLETION_SERVICE_PRICING === 'true',
  // Customer reschedule page names the next plan visit's new date beside Confirm (dark).
  // Registered for logGateStatus only; routes/reschedule-public.js reads the env at call time.
  rescheduleNextVisitDate: process.env.GATE_RESCHEDULE_NEXT_VISIT_DATE === 'true',
  // Customer-facing pickers stop at a 16:00 start (dark). Registered for logGateStatus only;
  // scheduling/customer-windows.js reads the env at call time.
  customerLastStart16: gateEnvValue('GATE_CUSTOMER_LAST_START_16'),
  // Customer reschedule page move limits: late-move limit by plan + 2 online moves of a first visit (dark).
  // Registered for logGateStatus only; scheduling/customer-move-limits.js reads the env at call time.
  rescheduleMoveLimits: gateEnvValue('GATE_RESCHEDULE_MOVE_LIMITS'),
  // Customer selects one available visit; later cadence dates await auto-dispatch ±3 days.
  customerRecurringDispatch: gateEnvValue('GATE_CUSTOMER_RECURRING_DISPATCH'),
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
  // keeps escalating — ruling #2). With payIncludeBalance also on, and only
  // when this invoice's Pay button collects every open invoice, the note
  // points at paying everything from this invoice's link and the attached
  // invoice PDF itemizes the same balance as a "Previous balance" block
  // (with service names; the email reaches only the customer's own saved
  // recipient). A customer under a collections dispute hold gets neither
  // the note nor the block. Customer-facing copy change, so
  // fail-closed ==='true' in EVERY environment. Gate off: emails and
  // their PDFs byte-identical to today.
  balanceVisibility: process.env.GATE_BALANCE_VISIBILITY === 'true',

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

  // Creation only. Saved packets and issued summary links survive the kill
  // switch. Read at call time.
  get visitCloseout() { return process.env.GATE_VISIT_CLOSEOUT === 'true'; },

  // Creation only: stamped reservations retain their full service capacity
  // through acceptance even after this gate is disabled. Strict opt-in.
  visitCombinedCapacity: process.env.GATE_VISIT_COMBINED_CAPACITY === 'true',

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
  // Pre-treatment certificate renders as the paper Notice of Termite
  // Protection label with its blanks filled, plus a details block for the
  // certificate fields the label has no blank for. Off = the field-grid
  // Certificate of Compliance. Look only; no data or send change.
  pretreatStickerReport: process.env.GATE_PRETREAT_STICKER_REPORT === 'true',

  // "Your plan" section on the LIVE report (owner ask 2026-09-28): an active
  // plan member's completed-visit + re-service COUNTS for this calendar year
  // (never a price — prices only appear on estimate pages).
  // Additive and read-only; off = report payloads carry no planSummary key,
  // byte-identical to today. Live view only, like nextAppointment — PDF/
  // static/sms_preview never carry it at any setting. Kill switch: unset or
  // any non-'true' value.
  reportPlanSummary: process.env.GATE_REPORT_PLAN_SUMMARY === 'true',

  // "Near you" line on the LIVE lawn report ONLY (owner ask 2026-09-28,
  // "lawn only"): one fixed-copy sentence naming the lawn pest most often
  // found among other lawn customers in the same city over the last 30 ET
  // days, shown only once at least NEAR_YOU_MIN_CUSTOMERS distinct
  // customers had it (report-data.js) — never a count, name, or address.
  // Additive and read-only; off = report payloads carry no nearYou key,
  // byte-identical to today. Live view only, like planSummary above — PDF/
  // static/sms_preview never carry it at any setting. Kill switch: unset or
  // any non-'true' value.
  reportNearYou: process.env.GATE_REPORT_NEAR_YOU === 'true',

  // A stamped estimated_price of exactly 0 bills nothing in every billing
  // lane (owner ruling 2026-09-28). This map entry is for logGateStatus
  // only, same discountStackingLive() convention — the canonical CALL-TIME
  // reader is stampedZeroFreeLive() below (strict 'true'), which
  // billing-lane.js's hasAuthoritativeZeroPrice and the handful of sites
  // that bypass the resolver read directly, so a flip needs no redeploy.
  // Off = byte-identical to today on every path.
  stampedZeroFree: process.env.GATE_STAMPED_ZERO_FREE === 'true',
  // Pay-after-first-visit wording on the estimate page for customers on the
  // card-on-file rail (owner ruling 2026-09-30). This map entry is for
  // logGateStatus only — the canonical CALL-TIME reader is
  // payAfterFirstVisitLive() below (strict 'true'), so a flip needs no
  // redeploy. Off = byte-identical to today.
  payAfterFirstVisit: process.env.GATE_PAY_AFTER_FIRST_VISIT === 'true',
  // Per-item sub-gates of the pay-after-first-visit program (owner ruling
  // 2026-09-30), so each item can roll out on its own. Map entries are for
  // logGateStatus only — the canonical CALL-TIME readers are
  // pafExistingCustomersLive() / pafSetupFeeLive() / pafPrepayLive() /
  // pafTermiteLive() below, each of which ALSO requires the master
  // GATE_PAY_AFTER_FIRST_VISIT. Off = byte-identical to today.
  pafExistingCustomers: process.env.GATE_PAF_EXISTING_CUSTOMERS === 'true',
  pafSetupFee: process.env.GATE_PAF_SETUP_FEE === 'true',
  pafPrepay: process.env.GATE_PAF_PREPAY === 'true',
  pafTermite: process.env.GATE_PAF_TERMITE === 'true',
  // Product-copy lines on the service report (owner-approved 2026-09-28) —
  // "How it works" / "Also labeled for" / "Pets & kids" per applied product,
  // matched against the static reviewed config in
  // server/config/report-product-copy.js. Live view only, like
  // planSummary/nearYou above — PDF/static/sms_preview never carry it at any
  // setting (stripLiveOnlyReportProductCopy), and termite-line reports never
  // get it. This map entry is for logGateStatus only — the
  // canonical CALL-TIME reader is reportProductCopyGateOn() in
  // server/services/service-report/report-product-copy.js, same posture as
  // pestReportExpectationsGateOn().
  reportProductCopy: process.env.GATE_REPORT_PRODUCT_COPY === 'true',
  // Shared customer report template (owner 2026-10-24): one header and one stacked layout on every
  // regular report's live web view. Ships DARK. This entry is for logGateStatus only: the report
  // routes read GATE_REPORT_SHARED_TEMPLATE at call time via reportSharedTemplateLive().
  reportSharedTemplate: process.env.GATE_REPORT_SHARED_TEMPLATE === 'true',

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

  // Add-ons on an annual-prepay-covered visit billed at completion
  // (ADMIN-BUG-R13): with no invoice at all, their own invoice through the
  // shared scheduled mint, pay link + unpaid completion text; any invoice
  // already on the visit, or an unclear amount, gets one office alert
  // instead. logGateStatus only — the completion
  // reads gateEnvValue('GATE_ANNUAL_PREPAY_ADDON_BILLING') at CALL time.
  // Off: the covered visit bills nothing for its add-ons, as before.
  annualPrepayAddonBilling: gateEnvValue('GATE_ANNUAL_PREPAY_ADDON_BILLING'),

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
  // GATE_EDIT_APPT_ADDRESS also admits the New Appointment "Service address"
  // picker (POST / with propertyId) — one flag for "the office chooses which
  // of a multi-property customer's addresses a visit lands on". Off: the
  // properties read answers canChangeAppointmentAddress:false, the modal
  // hides the picker, and a propertyId on create is refused (409), so a
  // stale tab cannot book to a secondary address while the lane is dark.
  editApptAddress: process.env.GATE_EDIT_APPT_ADDRESS === 'true',
  // Admin-only, reasoned second-program creation; reviewed IDs are checked
  // under the existing series-create lock. Unset hides and refuses the flow.
  separateRecurringProgram: process.env.GATE_SEPARATE_RECURRING_PROGRAM === 'true',
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

  // The same "Apply price change to" choice on the service-line sheet
  // (MobileServiceEditModal — phone checkout and the Dispatch checkout's
  // service line), whose series price edits otherwise post no scope and so
  // become the series price on a parent (owner 2026-10-26, bug 4 of the
  // 10-24 price audit). The sheet posts the same priceServiceScope, which
  // update-details honors only behind editApptPriceServiceScope, so
  // /series-summary answers canScopeSheetPrice:true only when BOTH gates are
  // on. Gate off: the sheet shows no choice and posts no scope — its save is
  // exactly what it was before. Kill switch: delete the variable.
  serviceSheetPriceScope: process.env.GATE_SERVICE_SHEET_PRICE_SCOPE === 'true',

  // Series price guards (services/series-price-guards.js). On: a series
  // extension (completion auto-extend, nightly top-up) whose price is more
  // than 25% over the series' last PAID visit still inserts but rings the
  // office; one templated from a CANCELLED root that the last paid visit
  // does not back is skipped and rings the office; a performed visit that
  // completes with no billable amount and nothing covering it rings the
  // office. Off = no extra reads, no skip, no alert. Kill switch: delete the
  // env var. Ships dark.
  seriesPriceGuards: process.env.GATE_SERIES_PRICE_GUARDS === 'true',

  // Multiple discounts on one service, and the one rule for how they combine
  // (owner ruling 2026-09-11, "the lesser of the two"): dollar credits come
  // off first, then percentages compound on what is left (10% then 5% off
  // $111 is $16.10, never an additive $16.65), with one WaveGuard tier per
  // document. The rule lives in server/services/discount-stack.js
  // (stackDiscounts / stackVisitDiscounts / stackDocumentDiscounts) and
  // GET /api/admin/discounts/stacking reports this value for pickers to
  // read. discount-engine.js's /calculate preview and invoice.js's manual-
  // discount save both already import discount-stack.js for its cent-exact
  // percentage rounding (live regardless of this gate), but neither reads
  // this gate to decide whether to COMPOUND — the preview always calls
  // stackDiscounts with compound:false, and the save doesn't compound at
  // all yet, so flipping this gate today changes nothing observable: off
  // OR on, every existing total stays byte-identical (rounding-corrected)
  // until slice 5 (invoice/document calculation) wires both the preview
  // and invoice.js's line-item/manual-discount save to read the live gate
  // TOGETHER. This map entry is for logGateStatus only — the canonical
  // CALL-TIME reader is discountStackingLive() below (strict 'true');
  // every caller, present and future, must use that, not this cached-at-
  // load value, so a flip needs no redeploy.
  discountStacking: process.env.GATE_DISCOUNT_STACKING === 'true',

  // Email division area-intel recompute cron (dark, no caller sends
  // anything). Map entry for logGateStatus only; canonical reader below.
  emailAreaIntel: process.env.GATE_EMAIL_AREA_INTEL === 'true',

  // Tech-reviewed completion-photo captions/summary grounding the AI report
  // writer (owner spec 2026-09-27). This map entry is for logGateStatus
  // only (pre-push P3, Codex #5145 r2) — the canonical CALL-TIME reader is
  // reportPhotoContentLive() below (strict 'true'), which admin-schedule.js's
  // POST /generate-report actually uses, so a flip needs no redeploy.
  reportPhotoContent: process.env.GATE_REPORT_PHOTO_CONTENT === 'true',

  // Owner rules for the AI report paragraph (every writer except lawn and
  // tree/shrub/palm). Map entry for logGateStatus only; the canonical
  // CALL-TIME reader is reportWriterRulesLive() below.
  reportWriterRules: process.env.GATE_REPORT_WRITER_RULES === 'true',
  // TypeSafe Jev typed decisions: ships DARK. CALL-TIME reader is
  // typedDecisionsLive() below; this entry is for logGateStatus only.
  typedDecisions: gateEnvValue('GATE_TYPED_DECISIONS'),
  // Cloudflare Clef as a second typed-decision provider: ships DARK. CALL-TIME
  // reader is typedDecisionsClefLive() below; this entry is for logGateStatus
  // and the integrations page, so it carries the same prerequisite the reader
  // enforces: with GATE_TYPED_DECISIONS off the lane is dark whatever this
  // variable says, and the status must not read as enabled (Codex r1 on #5557).
  typedDecisionsClef: gateEnvValue('GATE_TYPED_DECISIONS') && gateEnvValue('GATE_TYPED_DECISIONS_CLEF'),
  // Visit access and safety flags, shadow leg (Clef second wave idea 5):
  // ships DARK. CALL-TIME reader is visitAccessShadowLive() below; this entry
  // is for logGateStatus only and carries the reader's prerequisite.
  visitAccessFlags: gateEnvValue('GATE_TYPED_DECISIONS') && String(process.env.GATE_VISIT_ACCESS_FLAGS || '').trim().toLowerCase() === 'shadow',
  // Stamp-time price check for every annual prepay mint: ships DARK. CALL-TIME
  // reader is prepayMintPriceHoldMode() below ('shadow' or 'true'); this entry
  // is for logGateStatus only.
  prepayMintPriceHold: ['shadow', 'true'].includes(String(process.env.GATE_PREPAY_MINT_PRICE_HOLD || '').trim().toLowerCase()),
  // Lawn Jev timing check: ships DARK. CALL-TIME reader is lawnJevTimingCheckMode()
  // below; this entry is for logGateStatus only and carries the typed-decisions prerequisite.
  lawnJevTimingCheck: gateEnvValue('GATE_TYPED_DECISIONS') && ['shadow', 'enforce'].includes(String(process.env.GATE_LAWN_JEV_TIMING_CHECK || '').trim().toLowerCase()),
  // Photo privacy shadow: ships DARK. CALL-TIME reader is photoPrivacyMode()
  // below; this entry is for logGateStatus only and carries the reader's
  // prerequisites, so it never reads as enabled while the Clef leg is dark.
  photoPrivacy: gateEnvValue('GATE_TYPED_DECISIONS') && gateEnvValue('GATE_TYPED_DECISIONS_CLEF') && String(process.env.GATE_PHOTO_PRIVACY || '').toLowerCase() === 'shadow',
  // Estimated AI spend: ships DARK. CALL-TIME reader is llmCostTrackingLive()
  // below; this entry is for logGateStatus only.
  llmCostTracking: process.env.GATE_LLM_COST_TRACKING === 'true',

  // Portal "Your yard this month" card. Map entry for logGateStatus only; the
  // canonical CALL-TIME reader is portalYardCalendarLive() below.
  portalYardCalendar: process.env.GATE_PORTAL_YARD_CALENDAR === 'true',

  // Voice relay (Sandy) on an OpenAI model — benchmark/sandbox only. This map
  // entry is for logGateStatus only; the canonical CALL-TIME reader is
  // voiceRelayOpenaiLive() below (strict 'true', same convention as
  // GATE_DISCOUNT_STACKING) — every caller (relay-conversation.js's session
  // allowlist, the eval harness, the benchmark runner) must use that.
  voiceRelayOpenai: process.env.GATE_VOICE_RELAY_OPENAI === 'true',

  // Voice relay (Sandy) production INBOUND on an OpenAI model (owner
  // ruling 2026-09-28: GPT-6 Luna after the benchmark). Ships DARK — off
  // unless exactly 'true'. This is deliberately a SEPARATE gate from
  // GATE_VOICE_RELAY_OPENAI above, which is already live in prod for the
  // sandbox/eval lane alone: that gate must never be what opens production
  // inbound to an OpenAI model. This map entry is for logGateStatus only;
  // the canonical CALL-TIME reader is voiceRelayOpenaiInboundLive() below
  // (strict 'true') — relay-conversation.js's resolveSessionModel reads it,
  // at session construction, to decide whether a PRODUCTION inbound session
  // may resolve VOICE_RELAY_INBOUND_MODEL to a voice-eligible OpenAI id. The
  // shared VOICE_RELAY_MODEL / MODEL_VOICE chain stays Anthropic-only either
  // way (collections-conversation.js shares it).
  voiceRelayOpenaiInbound: process.env.GATE_VOICE_RELAY_OPENAI_INBOUND === 'true',

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

  // Authenticated customer Photo ID (pest / lawn / tree & shrub) API —
  // POST/GET /api/photo-id/*. Comms-free (no sendCustomerMessage, no email,
  // no notifications) — dark until Adam flips it: every handler 404s
  // {error:'Not found'} while off, including GET /, so the client can hide
  // the feature entirely off a single 404.
  customerPhotoId: process.env.GATE_CUSTOMER_PHOTO_ID === 'true',
  // Pest-only issue association for Customer Photo ID. Strict opt-in in every
  // environment; requires appPropertyScope so every issue has a durable saved-
  // property identity. Gate off keeps existing payloads and writes unchanged.
  customerPhotoIdIssues: process.env.GATE_CUSTOMER_PHOTO_ID_ISSUES === 'true',
  // v2 species-catalog pest engine (server/services/photo-id-v2/pest-engine.js)
  // behind the customer Photo ID PEST path only — lawn/tree_shrub are
  // unaffected at any setting. A SEPARATE, layered gate: customerPhotoId
  // above must also be on, or every handler still 404s regardless of this
  // one. Off = identifyPestV2 is never called, stored v2 answers are not
  // served back, and the v1 identifyPest path stays byte-identical to
  // today. Kill switch: unset or any non-'true' value.
  photoIdV2: process.env.GATE_PHOTO_ID_V2 === 'true',
  // Public careers application funnel (POST /api/public/careers/apply).
  // Dark until the owner turns hiring on; the admin recruiting queue works
  // at any setting (it only reads/updates existing rows).
  jobApplications: process.env.GATE_JOB_APPLICATIONS === 'true',

  // Recruiting comms (GATE_RECRUITING_COMMS): applicant-facing SMS/email —
  // the submit confirmation, the interview self-scheduling link + its
  // confirmation, and the admin stage-change notify modal's sends. Customer-
  // facing (well, applicant-facing) auto-send, so strict opt-in in EVERY
  // environment like techArrivedSms. Off: submit confirmation is skipped,
  // PATCH /admin/careers/:id/status ignores `notify` and reports
  // sending_enabled:false, and the public /interview/:token routes 404
  // BEFORE their rate limiter (same unobservable-when-dark contract as the
  // jobApplications prefix gate above, which stays in force independently).
  recruitingComms: process.env.GATE_RECRUITING_COMMS === 'true',

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

  // Zone route days (owner ruling 2026-09-29: Fridays are the Venice / North
  // Port route day): when ON, the self-serve (customer-facing) detour cap is
  // lifted for an address in a configured zone on that zone's route weekday,
  // so an empty Friday — whose first far stop is otherwise charged the full
  // round trip from HQ as "detour" — can be offered on /book and the
  // estimate picker, and seeded there by the south-zone funnel. Ships DARK:
  // off unless exactly 'true'. This entry is for logGateStatus only:
  // scheduling/zone-route-days.js reads GATE_ZONE_ROUTE_DAYS at call time via
  // zoneRouteDaysLive(). Kill switch: unset.
  zoneRouteDays: process.env.GATE_ZONE_ROUTE_DAYS === 'true',

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

  // Owner MCP admin reads: the /api/mcp-admin endpoint (routes/mcp-admin.js)
  // that serves an allow-list of Intelligence Bar read tools to Claude Code
  // under the owner's mcp_read key (services/mcp-admin-key.js). Read-only;
  // opt-in in EVERY environment. Kill switch: unset — the endpoint 403s and
  // every key stops.
  mcpAdminRead: process.env.GATE_MCP_ADMIN_READ === 'true',

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

  // GATE_REVIEW_SENDER_EVERY_5_MIN (owner 2026-10-22, "faster"): the review
  // cadence sender (processReviewSequences) runs every 5 minutes on its own
  // minute offset (:04, :09, :14 ... :59) instead of :14/:44 only, so a text
  // goes within 5 minutes of becoming due (the Day-0 ask about 10 minutes after
  // the report text, Tomorrow 8 AM at 8:04, a custom time). Same job, same
  // `review-sequences` lock. Read at boot (the Railway restart applies it);
  // strict 'true', dark by default; off = :14/:44 exactly as before. Sends
  // nothing a customer would not get anyway, only sooner.
  reviewSenderEvery5Min: process.env.GATE_REVIEW_SENDER_EVERY_5_MIN === 'true',

  // Personalized review-ask bodies: cadence SMS touches are drafted from the
  // customer's own call/SMS history (review-ask-drafter.js) and AUTO-SEND
  // after deterministic verification, per owner ruling 2026-07-30 (scoped to
  // this lane — inbound-reply drafts stay approval-gated). Off = cadence
  // touches send the standard outreach templates. Customer-facing generated
  // text → explicit opt-in in EVERY env.
  reviewAskPersonalized: process.env.GATE_REVIEW_ASK_PERSONALIZED === 'true',

  // Review asks in the technician's voice (owner rulings 2026-09-30/10-01):
  // EVERY cadence touch is drafted, the Day-0 SMS included, from the visit's
  // service report, the customer's texts, calls and own emails, and what this
  // cadence already sent; every detail must trace to that record or the draft
  // falls back to the fixed template. Off = today's personalized drafter and
  // the fixed Day-0 ask. Customer-facing generated text → opt-in in EVERY env.
  reviewAskTechVoice: process.env.GATE_REVIEW_ASK_TECH_VOICE === 'true',

  // Same-day review ask = one fixed line (owner 2026-10-22, "fixed line for
  // all"): while GATE_REVIEW_ASK_TECH_VOICE is on, the SMS day0 / day_after
  // touch sends "Hi <first>, it's <tech> from Waves. Thanks for having us out
  // today. A Google review would really help: {review_url}" with no model
  // call (the writer recited report findings and booking talk). Follow-up
  // texts keep the tech-voice writer; emails stay fixed as before. Strict opt-in; off =
  // today's writer. Customer-facing text, so opt-in in EVERY env.
  // Rollback: unset.
  reviewAskFixedDay0: process.env.GATE_REVIEW_ASK_FIXED_DAY0 === 'true',

  // Exact quotes for the tech-voice fact check (owner 2026-10-05, closing
  // #5893: fix it in the prompts, keep the code checks): the checker is asked
  // for the bare words of one record line (no "Visit report:" frame), the
  // writer for each fact in its source's own words, and a quote held by
  // several record lines is dated by the newest of them, not the oldest.
  // Off = today's prompts and dating. Customer-facing text, so opt-in in
  // EVERY env. Rollback: unset.
  reviewAskExactQuotes: process.env.GATE_REVIEW_ASK_EXACT_QUOTES === 'true',

  // Review ask texts/emails link STRAIGHT to the tracked /api/rate/:token/go
  // redirect (which 302s to the Google review form) instead of the /rate/<token>
  // thank-you page. Off = every ask body resolves {review_url} to /rate/<token>.
  // This gate decides ONLY that link target: /go itself always runs the tracked
  // flow (click stamp, cadence stop, referral invite), and the /rate page's Open
  // Google button always points at /go (the 1-10 rating is retired, so there is
  // no old flow to roll back to).
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

  // Sandy unbooked-call hand-off — a production relay call that closes
  // ai_handled with caller speech, no booking, no lead and no transfer rings
  // ONE office bell (relay_unbooked_call) and enters the lead pipeline
  // (services/voice-agent/relay-unbooked-handoff.js). Off ⇒ the close is
  // byte-identical to today. Read at CALL time via relayUnbookedHandoffLive();
  // this entry is the status/log listing. Kill switch: unset.
  relayUnbookedHandoff: process.env.GATE_RELAY_UNBOOKED_HANDOFF === 'true',

  // Ask Waves — public conversational intake on the marketing site (hub). The
  // brain answers pest questions and steers visitors to the instant quote; it
  // can NEVER state a price (pricing only comes from the existing contact-gated
  // /api/public/quote/calculate path). Replies only when a visitor asks — not
  // an auto-send — so dev is open; prod ships dark
  // until Adam sets GATE_ASK_WAVES=true.
  askWaves: isProd ? process.env.GATE_ASK_WAVES === 'true' : true,
  // Ask Waves topic routing — a safety, re-entry or medical-emergency question
  // gets reviewed copy instead of the model's own answer. Dark everywhere;
  // read at call time through askWavesTopicRoutingLive() (this entry is for
  // logGateStatus only).
  askWavesTopicRouting: process.env.GATE_ASK_WAVES_TOPIC_ROUTING === 'true',
  // Ask Waves emergency second opinion (#4899) — a fast classifier asks only
  // "is anyone in medical danger?" alongside every chat turn, and a yes turns
  // a non-emergency answer into the emergency script. Dark everywhere; read at
  // call time through askWavesEmergencyCheckLive() (logGateStatus only here).
  askWavesEmergencyCheck: process.env.GATE_ASK_WAVES_EMERGENCY_CHECK === 'true',
  // Ask Waves Jev second check: ships DARK. CALL-TIME reader is
  // askWavesJevCheckMode() below; this entry is for logGateStatus only.
  askWavesJevCheck: gateEnvValue('GATE_TYPED_DECISIONS') && ['shadow', 'enforce'].includes(String(process.env.GATE_ASK_WAVES_JEV_CHECK || '').trim().toLowerCase()),

  // SMS Shadow Drafter (brand-voice loop, Phase B) — silently records what
  // the house-voice AI would have replied to inbound customer SMS as
  // message_drafts status='shadow' rows. Never sends, never alerts, never
  // enters the approval queue; a later judge pass scores drafts against the
  // reply a human actually sent. Burns one Anthropic call per inbound
  // customer SMS, so prod requires explicit opt-in.
  smsShadowDrafts: isProd ? process.env.GATE_SMS_SHADOW_DRAFTS === 'true' : true,

  // SMS private-profile capture + existing admin exception bells. Runtime reads the gate again before writes. Activation
  // also requires GATE_SMS_OPERATIONAL_ACTIONS_SINCE (an offset ISO instant)
  // so enabling this lane never applies the historical training corpus.
  smsOperationalActions: gateEnvValue('GATE_SMS_OPERATIONAL_ACTIONS'),
  // Separate activation for commitment capture, follow-up bells and staff closure.
  smsCommitmentFollowup: gateEnvValue('GATE_SMS_COMMITMENT_FOLLOWUP'),
  // Owner 2026-10-04: an access code saves from the client's own wording
  // ("Gate code is 1234"), not only from the strict sentence form. Read at
  // call time in sms-operational-extractor.js. Off = strict form only.
  accessCodeCapture: gateEnvValue('GATE_ACCESS_CODE_CAPTURE'),

  // Access codes section (server half): a text that states a gate, door,
  // lockbox, garage, call-box or pass code is filed as a `found` row in
  // customer_access_codes for the office to accept, dismiss or retire, and the
  // admin API at /api/admin/access-codes serves them. Needs
  // GATE_ACCESS_CODES_SECTION_SINCE (an offset ISO instant) for the sweep, so
  // turning it on never reads history. Read at call time in
  // services/access-code-capture.js; this entry is for logGateStatus only.
  accessCodesSection: gateEnvValue('GATE_ACCESS_CODES_SECTION'),

  // Access codes from call transcripts (owner 2026-10-23): the same sweep also
  // reads calls (inbound, outbound, voicemail) into the same found list. Needs
  // GATE_ACCESS_CODES_SECTION and GATE_ACCESS_CODES_CALLS_SINCE (an offset ISO
  // instant), so turning it on never reads history. Read at call time in
  // services/access-code-capture.js; this entry is for logGateStatus only.
  accessCodesCalls: gateEnvValue('GATE_ACCESS_CODES_CALLS'),

  // Access codes from inbound customer emails (owner 2026-10-24): the same
  // sweep also reads emails into the same found list. Exactly `true` (not 1 or
  // on); needs GATE_ACCESS_CODES_SECTION and GATE_ACCESS_CODES_EMAILS_SINCE (an
  // offset ISO instant), so turning it on never reads history. Read at call
  // time in services/access-code-capture.js; this entry is for logGateStatus only.
  accessCodesEmails: process.env.GATE_ACCESS_CODES_EMAILS === 'true',

  // The found-codes bell (owner ruling 2026-10-24): one standing admin row lists
  // the access codes waiting on Customers → Gate codes, rings when a code joins
  // and closes itself when none wait. Exactly `true`. Read at call time in
  // services/access-code-found-bell.js; this entry is for logGateStatus only.
  accessCodesFoundBell: process.env.GATE_ACCESS_CODES_FOUND_BELL === 'true',

  // Email asks + staff promises, same shape as the SMS lane above. Also
  // requires GATE_EMAIL_OPERATIONAL_ACTIONS_SINCE. Read at call time in
  // email-operational-actions.js; this entry is for logGateStatus only.
  emailOperationalActions: gateEnvValue('GATE_EMAIL_OPERATIONAL_ACTIONS'),

  // SMS real answers (owner ruling 2026-09-27) — the shadow drafter answers
  // from the facts (real OPEN TIMES from AvailabilityEngine for booking/
  // rescheduling, exact amounts + send_payment_link, portal/estimate links)
  // instead of defaulting to "we'll confirm and follow up", and answers
  // CANCELLATIONS (skip/reschedule from OPEN TIMES only, never an invented
  // discount/credit/refund) instead of escalating them. Dark in every
  // environment: gate off keeps the drafter's prompts, facts block and
  // behavior byte-identical (draft rows keep stamping prompt_version
  // house_voice_v11). The one canonical reader is server/services/
  // sms-shadow-drafter.js, which re-reads gateEnvValue('GATE_SMS_REAL_ANSWERS')
  // at draft time — this entry is for logGateStatus only.
  smsRealAnswers: gateEnvValue('GATE_SMS_REAL_ANSWERS'),
  // Per-category hand-off gates (owner ruling 2026-09-27): each one, ON,
  // removes exactly that category from the HELD-FOR-A-PERSON list in the
  // real-answers prompt (smsRealAnswers must ALSO be on, or there is no
  // real-answers prompt to remove it from). All default off, dark in every
  // environment, read at call time by the same drafter module.
  smsAgentComplaints: gateEnvValue('GATE_SMS_AGENT_COMPLAINTS'),
  smsAgentBillingDisputes: gateEnvValue('GATE_SMS_AGENT_BILLING_DISPUTES'),
  smsAgentChemicalMedical: gateEnvValue('GATE_SMS_AGENT_CHEMICAL_MEDICAL'),
  smsAgentLegal: gateEnvValue('GATE_SMS_AGENT_LEGAL'),
  // Scheduler-backed appointment offers in the texting AI (owner ruling
  // 2026-09-29, slice 1): with smsRealAnswers ON, a text about ONE upcoming
  // visit is offered that visit's times from the customer's own reschedule-link
  // picker (routes/reschedule-public.js buildAvailabilityForService — service
  // time frames, proximity routing, planning minutes, detour cap) instead of
  // the zone-based availability finder; a visit the picker refuses gets no
  // OPEN TIMES. Estimate / new-service identities keep the old finder for now.
  // Dark in every environment: gate off keeps the drafter's prompts, facts
  // block and snapshot shape byte-identical. Read at call time by
  // server/services/sms-shadow-drafter.js — this entry is for logGateStatus only.
  smsOffersScheduler: gateEnvValue('GATE_SMS_OFFERS_SCHEDULER'),
  // Voice profile pin for the texting AI (owner 2026-10-24): a voice_profiles.version integer. Read at call
  // time by server/services/sms-shadow-drafter.js smsVoiceProfilePinVersion() — this entry is for logGateStatus only.
  smsVoiceProfilePin: Boolean(String(process.env.GATE_SMS_VOICE_PROFILE_PIN || '').trim()),
  // Learn from the owner's edited suggestions (owner 2026-10-24): miner + exemplar ranking. Read at call time by
  // sms-voice-corpus-miner.js and sms-shadow-drafter.js smsEditLearningLive() — this entry is for logGateStatus only.
  smsEditLearning: gateEnvValue('GATE_SMS_EDIT_LEARNING'),
  // Prompt change B1 for the texting AI's suggestion drafter (owner 2026-10-24). Read at call time by
  // sms-shadow-drafter.js and context-aggregator.js smsPromptB1Live() — this entry is for logGateStatus only.
  smsPromptB1: gateEnvValue('GATE_SMS_PROMPT_B1'),
  // Stricter SMS draft judge (owner 2026-10-24): the could-send question + false-promise rule. Read at call time by
  // sms-shadow-judge.js and sms-graduation.js smsJudgeV2Live() — this entry is for logGateStatus only.
  smsJudgeV2: gateEnvValue('GATE_SMS_JUDGE_V2'),
  // Test answers in the customer's language (owner 2026-10-02). Read at call
  // time by server/services/sms-translation.js — this entry is for logGateStatus only.
  smsAnyLanguageTrial: gateEnvValue('GATE_SMS_ANY_LANGUAGE_TRIAL'),
  // Inbox assist for those texts (owner 2026-10-03): staff see the translation and the checked reply in the
  // Communications composer and send it themselves. Read at call time by
  // server/services/sms-translation.js — this entry is for logGateStatus only.
  smsAnyLanguageInbox: gateEnvValue('GATE_SMS_ANY_LANGUAGE_INBOX'),
  // Courtesy reply to an automated visit text (owner 2026-10-14): a bare "Ok" / "Thanks" / 👍
  // after Waves' own confirmation, reminder, en-route, arrival or completion text is marked
  // read with no bell. Read at call time by server/routes/twilio-webhook.js
  // smsCourtesyAfterTemplateLive() — this entry is for logGateStatus only.
  smsCourtesyAfterTemplate: process.env.GATE_SMS_COURTESY_AFTER_TEMPLATE === 'true',
  // Bare YES as a reply (owner 2026-10-29, weekly sweep #5007 B3): a bare "YES" from a number
  // with nothing to re-subscribe is an ordinary inbound reply, not START. Read at call time by
  // server/routes/twilio-webhook.js smsBareYesReplyLive() — this entry is for logGateStatus only.
  smsBareYesReply: process.env.GATE_SMS_BARE_YES_REPLY === 'true',
  // SMS offer ledger (SMS booking completion, slice 1 of
  // sms-booking-complete-scope 2026-10-02): after the provider accepts a reply
  // that quoted appointment times, record in sms_offers which slots the SENT
  // text carried, for which job, and until when (services/sms-offers.js, called
  // from messaging/send-customer-message.js). Records only: nothing reads the
  // table to act, and no text changes. Dark in every environment: gate off, the
  // send path does not load the ledger module. Read at call time by
  // sms-offers.js offerLedgerLive() — this entry is for logGateStatus only.
  smsOfferLedger: gateEnvValue('GATE_SMS_OFFER_LEDGER'),
  // SMS scheduling suggestions (slice 1b of sms-booking-complete-scope
  // 2026-10-02): a scheduling-intent draft whose offered times came from a
  // booking picker (open_times_snapshot with a picker source and id) becomes
  // a staff suggestion card instead of silent shadow. Suggestion only, never
  // auto-send; staff press send and the send checks recheck the times. Read
  // at call time by sms-suggest-mode.js schedulingSuggestLive() — this entry
  // is for logGateStatus only.
  smsSchedulingSuggest: gateEnvValue('GATE_SMS_SCHEDULING_SUGGEST'),
  // SMS scheduling decide step, SHADOW (slice 2 of sms-booking-complete-scope
  // 2026-10-02): when a customer texts from a phone with an open sms_offers
  // row, one model (ROUTES.smsSchedulingDecide) reads the reply and code checks
  // its answer; the result is recorded in sms_offer_decisions as what it WOULD
  // have done. Nothing moves, books or sends. Read at call time by
  // sms-scheduling-decide.js decideLive() — this entry is for logGateStatus only.
  smsSchedulingDecide: gateEnvValue('GATE_SMS_SCHEDULING_DECIDE'),
  // SMS scheduling executor, MOVE (slice 3 of sms-booking-complete-scope
  // 2026-10-02): a would-move the decide step recorded is carried out. The
  // visit moves through the reschedule link's own checks and mover, and the
  // customer gets the standard rescheduled text. Needs the decide gate on.
  // Customer-visible when on. Read at call time by sms-scheduling-act.js
  // actMoveLive() — this entry is for logGateStatus only.
  smsSchedulingActMove: gateEnvValue('GATE_SMS_SCHEDULING_ACT_MOVE'),

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

  // Citation auditor — WEEKLY read-only GET of each seo_citations listing_url
  // (services/seo/citation-auditor.js: SSRF-pinned, sequential, one request per
  // row, nothing submitted or claimed) compared against config/locations.js NAP.
  // No sends, no customer data. DEFAULT ON; kill switch GATE_CITATION_AUDIT=false.
  citationAudit: process.env.GATE_CITATION_AUDIT !== 'false',

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

  // Narrow gratitude-only autonomous replies. This is deliberately separate
  // from the general Phase-E gate: enabling either switch cannot open the
  // other lane. The activation timestamp is checked at call/send time by the
  // executor so an old shadow draft or replay can never ride a later flip.
  // Customer-facing communication: explicit opt-in in every environment.
  smsGratitudeReplies: process.env.GATE_SMS_GRATITUDE_REPLIES === 'true',

  // Unanswered-text reply (owner ruling 2026-10-02): a suggested reply still
  // waiting after two open hours is sent by the Phase E executor. Its own
  // switch: neither GATE_SMS_AUTO_SEND nor the gratitude gate opens it, and it
  // opens neither. Live decisions read smsUnansweredReplyLive() at call time;
  // this entry is for logGateStatus only.
  smsUnansweredReply: process.env.GATE_SMS_UNANSWERED_REPLY === 'true',

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

  // Staff default-deny — technician reach becomes the allow-list in
  // server/middleware/technician-scope.js (owner 2026-10-02). Off in every
  // env until the owner approves docs/technician-reachable-routes.md; off =
  // nothing denied, would-deny lines logged once per route.
  staffDefaultDeny: process.env.GATE_STAFF_DEFAULT_DENY === 'true',

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

  // Re-service picker one-tap pest chips (owner-approved 2026-09-26): the
  // /reservice/:token picker's optional details box gets a row of one-tap
  // pest chips (server/services/reservice-request.js — ants/roaches/spiders/
  // wasps/other for pest, weeds/bugs in the lawn/brown patches/other for
  // lawn) above the now-secondary "Anything else?" textarea, and GET's
  // payload carries pestChoices for the customer's bookable lanes. Nested
  // inside reserviceSelfServe — with that gate dark the whole route 404s
  // before this one is ever read. Customer-facing surface, so opt-in in
  // EVERY environment (fail-closed ==='true'). Kill switch: unset
  // GATE_RESERVICE_PEST_CHIPS — GET drops pestChoices, POST ignores any
  // posted `pests`, and the picker renders byte-identical to before this
  // gate existed (the plain "What are you seeing?" textarea only). The
  // customer_request/_source/_pests columns themselves (migration
  // 20260927100000) are additive and are stamped from the details box
  // regardless of this gate — only the pest-chip normalization is gated.
  reservicePestChips: process.env.GATE_RESERVICE_PEST_CHIPS === 'true',

  // Re-service "what are you seeing?" box required (owner 2026-10-02: any
  // text counts — no minimum, and a pest chip alone does not replace it).
  // On, the /reservice/:token GET carries `detailsRequired: true`, the
  // picker keeps Book disabled until the box has text, and the POST answers
  // 400 DETAILS_REQUIRED for a blank box. Customer-facing, so opt-in in
  // EVERY environment (fail-closed ==='true'), read at CALL time via
  // reserviceDetailsRequiredLive() — this entry is for logGateStatus only.
  // Kill switch: unset GATE_RESERVICE_DETAILS_REQUIRED — the box goes back
  // to optional and the GET payload drops the key (byte-identical).
  reserviceDetailsRequired: process.env.GATE_RESERVICE_DETAILS_REQUIRED === 'true',

  // Re-service photos (owner 2026-10-02: optional). On, AND
  // GATE_VISIT_PREP_PHOTOS live, the /reservice/:token success card offers
  // the visit-prep photo form for the visit just booked, posting to
  // POST /api/public/reservice/:token/visits/:visitId/photos (visit-prep.js
  // storage, Visit Brief, office feed item and tech alert unchanged). Read
  // at CALL time via reservicePhotosLive(); this entry is for logGateStatus
  // only. Kill switch: unset GATE_RESERVICE_PHOTOS — the commit response
  // drops prepPhotos and the upload route 404s.
  reservicePhotos: process.env.GATE_RESERVICE_PHOTOS === 'true',

  // Office-booked re-service "Customer's words" (2026-10-01):
  // the New Appointment modal, on a pest/lawn re-service, offers the
  // customer's latest inbound text or call note from the last 72 hours with
  // a "Use this" button plus an editable box, saved to
  // scheduled_services.customer_request/_source (migration 20260927100000).
  // The SERVER decides the source: unchanged text/call keeps 'text'/'call',
  // anything typed or edited by staff is 'office'. Staff-facing only and
  // nothing is sent, but it ships DARK in EVERY environment (fail-closed
  // ==='true'). Read via isEnabled('reserviceOfficeRequest') by the
  // suggestion route and the POST intake in routes/admin-schedule.js; the
  // modal learns the gate from the route's {enabled} answer. Kill switch:
  // unset GATE_RESERVICE_OFFICE_REQUEST — the suggestion route answers
  // {enabled:false, suggestion:null}, POST /api/admin/schedule ignores
  // `customerRequest`, and the modal renders byte-identical to before.
  reserviceOfficeRequest: process.env.GATE_RESERVICE_OFFICE_REQUEST === 'true',

  // Re-service ranking demotion (owner ruling 2026-09-24: "prefer new
  // customers over existing — new-customer bookings get first pick of open
  // time; re-service/callback pickers rank after"). Nested inside
  // reserviceSelfServe — with that gate dark, /reservice/:token 404s and
  // this one never runs. Ranking only: buildBookingAvailability's offered
  // slot set (days[].slots, used for commit revalidation) never changes;
  // only reservice-public's curated strip order and each day's is_best_fit
  // badge move. This entry is for logGateStatus only — the one consumer
  // (routes/booking.js's rankProfile:'reservice' branch, opted into only by
  // reservice-public.js) reads reserviceRankAfterNewLive() at CALL time so a
  // flip needs no redeploy. Kill switch: unset GATE_RESERVICE_RANK_AFTER_NEW
  // — the strip returns to plain score ranking, byte-for-byte.
  reserviceRankAfterNew: gateEnvValue('GATE_RESERVICE_RANK_AFTER_NEW'),

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
  // prospects to the worker (claim) AND arms the M3b send valve
  // (link-prospect-outreach.js). Default OFF everywhere. When ON, a manual send needs
  // an operator's explicit, authenticated approval click, AND the nightly
  // link-authority run auto-sends (mode 'auto', seo/link-authority-bridge.js
  // dispatchAutoSends) every drafted prospect whose placement holds an AUTO_OUTREACH
  // grant (a lint-clean, commitment-free draft). ON is not approval-only (sweep #3960 A5).
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

  // Lead Call-Reply Ring — a web lead who answers our lead text with a bare
  // CALL between 8 AM and 8 PM ET rings Adam's cell with the press-1 bridge
  // (owner 2026-10-24, "ring my cell, like we had before"). One ring per
  // phone per 24 h; a ring nobody connects raises a "Missed call request"
  // bell. Off unless exactly 'true'. See services/lead-call-reply-ring.js.
  leadCallReplyRing: process.env.GATE_LEAD_CALL_REPLY_RING === 'true',

  // Lead Call/Text Follow-up — a lead who answers our lead text with TEXT
  // gets "What service(s) are you interested in?"; a CALL after 8 PM gets
  // "What time tomorrow works best for us to call you?" and a clear time
  // books a 15-minute call slot with a confirmation text (owner 2026-10-24).
  // Off unless exactly 'true'. See services/lead-call-text-followup.js.
  leadCallTextFollowup: process.env.GATE_LEAD_CALL_TEXT_FOLLOWUP === 'true',

  // Lead Repeat Form — a row that is still a lead (not yet a customer) and
  // sends the website quote form again keeps its open SMS intake state, so
  // its next CALL / TEXT or service reply is handled as for a new lead, and
  // rings one Leads alert (owner 2026-10-24, "A: both parts"). Sends nothing
  // to the lead. Off unless exactly 'true'; off, a repeat form writes its
  // note and clears the intake state, as before.
  leadRepeatForm: process.env.GATE_LEAD_REPEAT_FORM === 'true',

  // Nightly lead repeat sweep (owner 2026-11-01, Action inbox agents A). Boot-log
  // entry only; the call-time reader is leadRepeatSweepLive().
  leadRepeatSweep: process.env.GATE_LEAD_REPEAT_SWEEP === 'true',

  // Text-thread lead reader (owner 2026-10-23): every 5 minutes a model reads
  // the text thread of a number with no customer and no lead, once the number
  // has been quiet for 5 minutes, and makes a lead (name, address, email,
  // service) through the call path's lead writer, with one admin bell per
  // lead. Sends nothing to the texter. Off unless exactly 'true'.
  smsLeadExtraction: process.env.GATE_SMS_LEAD_EXTRACTION === 'true',

  // Reply outcome signals (owner 2026-10-24): every 30 minutes, for each Waves
  // text reply that is 72 hours old, record what the customer did next (confused
  // or repeated follow-up, opt-out, call within the hour, thanks, silence) in
  // sms_reply_outcomes, with the AI draft's prompt_version. Measurement only:
  // sends, changes and holds nothing. Off unless exactly 'true'.
  smsReplyOutcomes: process.env.GATE_SMS_REPLY_OUTCOMES === 'true',

  // SMS prompt auto-promote (owner rulings 2026-09-27 and 2026-10-24): the texting drafter's
  // prompt improves with no human approval step. A pathology proposal becomes ONE candidate
  // rule block, the sealed exam grades the drafter with it against the current prompt, a
  // candidate that clears the bar goes live under its own prompt_version tag, and a daily
  // monitor retires it when live drafts or customer replies get worse. This deliberately
  // replaces the old "proposals never auto-apply" rule of sms-pathology-ledger.js. Modes:
  // unset/anything else = off (nothing runs); 'observe' = candidates, exams and decisions are
  // recorded and NOTHING activates; 'true' = activation and rollback. Exam runs spend real LLM
  // API calls. Read at call time through smsPromptAutopromoteMode(); this entry is on in both
  // non-off modes (logGateStatus only).
  get smsPromptAutopromote() { return smsPromptAutopromoteMode() !== 'off'; },

  // Lead Estimate Automation — generates priced draft estimates from new
  // lead-webhook submissions. Explicit opt-in everywhere so leads can keep
  // flowing while quoting stays manual.
  leadEstimateAutomation: process.env.GATE_LEAD_ESTIMATE_AUTOMATION === 'true',

  // Lead draft county size (owner 2026-10-24, option A of the lead draft
  // page): a lead draft priced on the default home size gets the county-
  // assessed home and lot size from the property lookup (a free cache read at
  // build time; one paid lookup in the background, then a guarded re-price of
  // an untouched draft). Exactly `true`. Read at call time in
  // services/lead-draft-measurements.js; this entry is for logGateStatus only.
  leadDraftPropertyLookup: process.env.GATE_LEAD_DRAFT_PROPERTY_LOOKUP === 'true',

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

  // Unverified lead hold (owner 2026-10-04). While leadTurnstile enforces, a
  // lead form that posts with NO token (the visitor's background check never
  // finished) is saved as a customer-less lead with a bell for the office
  // instead of answered 403 with nothing saved. No customer, estimate, text,
  // email, agent run or bridge call is created for a held lead. Rejected,
  // oversized and unmapped-host tokens still get the 403. Default on;
  // GATE_LEAD_UNVERIFIED_HOLD=false restores the plain 403.
  leadUnverifiedHold: process.env.GATE_LEAD_UNVERIFIED_HOLD !== 'false',

  // Estimate accept-card phone (owner 2026-10-04). An estimate with no phone
  // and no linked customer cannot become a customer, and the card step and
  // the accept refuse it with "call the office". On, the estimate page asks
  // for a mobile number in the "Confirm your details" card and
  // PUT /api/estimates/:token/contact-phone saves it on the estimate before
  // the card step. A typed number that already belongs to a customer is never
  // saved or attached: the office gets a bell. Default on;
  // GATE_ESTIMATE_ACCEPT_PHONE=false hides the field and 404s the route.
  estimateAcceptPhone: process.env.GATE_ESTIMATE_ACCEPT_PHONE !== 'false',

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
  // GATE_NEW_CLIENT_CONFIRM_EMAIL (new client's booking confirmation by text AND email, dark). Boot-log entry only; the call-time reader is newClientConfirmEmailLive().
  newClientConfirmEmail: process.env.GATE_NEW_CLIENT_CONFIRM_EMAIL === 'true',
  // GATE_MOVE_NOTICE_EMAIL (the email version of a reschedule or cancellation text that reached nobody, dark). Boot-log entry only; the call-time reader is moveNoticeEmailLive().
  moveNoticeEmail: process.env.GATE_MOVE_NOTICE_EMAIL === 'true',

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

  // Abandoned-booking recovery — chases /book drop-offs (booking_intents) with a
  // ~1h recovery SMS + ~24h email. A customer-facing auto-send, so it FAILS CLOSED
  // (explicit opt-in in EVERY environment) per the house rule — a preview/dev env
  // with real Twilio/SendGrid creds + cronJobs on must NOT auto-send. Owner sets
  // GATE_BOOKING_ABANDON_RECOVERY=true on prod at merge to go live (effectively
  // "live on merge", one env flip). Off → the cron only shadow-logs candidates.
  bookingAbandonRecovery: process.env.GATE_BOOKING_ABANDON_RECOVERY === 'true',

  // Estimate Clarify Asks — when automated quote drafting dead-ends on a
  // machine-readable missing item (no address / no concrete service), park
  // ONE clarifying SMS in /admin/drafts (intent 'estimate_clarify') for the
  // owner's one-click approval. The writer never sends; the approve route
  // re-checks this gate before putting anything on the wire. Off → dead
  // ends keep today's operator-bell-only behavior.
  estimateClarifyAsks: process.env.GATE_ESTIMATE_CLARIFY_ASKS === 'true',

  // Photo-text auto-triage (services/photo-text-triage.js) — an inbound
  // text with a photo that reads like a lawn/plant/pest "what is this" runs
  // the admin photo-assessment pipeline (source 'auto_triage') and parks ONE
  // pending message_drafts reply (intent 'photo_triage') in /admin/drafts.
  // The lane never sends; approval does. logGateStatus only — the service
  // reads gateEnvValue('GATE_PHOTO_TRIAGE') at CALL time.
  photoTriage: gateEnvValue('GATE_PHOTO_TRIAGE'),

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

  // Ads capacity by work day (owner 2026-10-25). Registered for logGateStatus
  // only; BudgetManager reads adsCapacityWorkDaysLive() at CALL time. Ships
  // DARK. Kill switch: unset - capacity counts every assignable technician.
  adsCapacityWorkDays: process.env.GATE_ADS_CAPACITY_WORK_DAYS === 'true',

  // Ads gap-fill rule (owner 2026-10-29, plan A). Registered for logGateStatus only; BudgetManager reads adsGapRuleMode() at CALL time.
  // Ships DARK (shadow records only). Kill switch: unset - the one-day capacity rule decides as before.
  adsGapRule: ['shadow', 'true'].includes(String(process.env.GATE_ADS_GAP_RULE || '').trim().toLowerCase()),

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
  // Shadow records evidence; true also silences confident unknown-sender pitches.
  smsSpamClassifier: ['shadow', 'true'].includes(String(process.env.GATE_SMS_SPAM_CLASSIFIER || '').trim().toLowerCase()),
  // Profile-enrichment writer: gate codes/pets/notes from extraction into
  // property_preferences + customers.internal_notes (admin-edit-preserving).
  callProfileEnrichment: process.env.GATE_CALL_PROFILE_ENRICHMENT === 'true',
  // Admin bell for service-request voicemails that do NOT take the workable
  // lead path (existing-customer or content-veto'd voicemails with concrete
  // service intent + callback number). Bell only — no customer comms.
  voicemailCallbackAlert: process.env.GATE_VOICEMAIL_CALLBACK_ALERT === 'true',
  // Missed-call bell for numbers with NO customer on file (new prospects who
  // hung up at the voicemail greeting). Bell only — no customer comms. Ships
  // dark; the bell stays customers-only until the owner flips it.
  missedCallUnknownCallers: process.env.GATE_MISSED_CALL_UNKNOWN_CALLERS === 'true',
  // Quiet the push (not the bell row, never a text) for a robodialer wave (owner
  // 2026-10-20 "yes", narrowed after Codex #6392 r2): a Google Business Profile
  // line, under 30 s, no voicemail, and 3+ unknown numbers from the same 6-digit
  // block in 14 days. On = bell row written, no push, stamped block_quiet. Off =
  // shadow: the call still rings and is stamped missed_call_spam_wave_shadow.
  missedCallSpamWave: process.env.GATE_MISSED_CALL_SPAM_WAVE === 'true',
  // Quiet the push (not the bell row) for a robodialer burst (owner 2026-10-20
  // "ALL", narrowed after Codex #6392 r1): 3+ different first-time unknown
  // numbers on one line inside 24 h, each 15 s or more, within 1 s of each
  // other, none got through. Any line type. On = bell row written, no push,
  // stamped burst_quiet. Off = shadow: missed_call_spam_burst_shadow. The
  // text-back still sends, stamped missed_call_text_spam_shadow 'burst'.
  missedCallSpamBurst: process.env.GATE_MISSED_CALL_SPAM_BURST === 'true',
  // Admin bell when one number places 3+ inbound calls inside 3 hours
  // (repeat-caller-bell.js). Bell only — no customer comms. Ships dark.
  repeatCallerBell: process.env.GATE_REPEAT_CALLER_BELL === 'true',
  // Nightly self-audit: samples recent calls, strong-model re-read, drift
  // metrics to call_audit_findings; alerts ONLY on threshold breach.
  callSelfAudit: process.env.GATE_CALL_SELF_AUDIT === 'true',
  // Correction loop for calls (logGateStatus only; read live via callIncidentsLive()).
  callIncidents: gateEnvValue('GATE_CALL_INCIDENTS') && process.env.GATE_CALL_SELF_AUDIT === 'true',
  // Fail-open booking: a CONFIRMED appointment books despite recoverable
  // contact-field flags (ANI satisfies caller_phone_missing; an existing
  // customer's on-file address clears address flags; garbled email is
  // advisory). Google Address Validation still governs new addresses; hard
  // blocks (out_of_service_area, do_not_contact, caller_not_authorized, spam)
  // stay. Creates real appointments — owner-flip only.
  callFailOpenBooking: process.env.GATE_CALL_FAIL_OPEN_BOOKING === 'true',
  // Web-form lead, street-level address (owner ruling 2026-09-30): a new lead
  // whose address on file came from their own web form and who does not
  // repeat it on the call books to that form address even when Google
  // confirms only the STREET (route), not the house — new-build streets in
  // Parrish and Lakewood Ranch that Google has not indexed yet. The office
  // gets an address read-back card. Needs callFailOpenBooking. Creates real
  // appointments — owner-flip only. This entry is for logGateStatus only:
  // call-recording-processor.js reads GATE_CALL_LEAD_FORM_ADDRESS_STREET_LEVEL
  // at call time via callLeadFormAddressStreetLevelLive().
  callLeadFormAddressStreetLevel: process.env.GATE_CALL_LEAD_FORM_ADDRESS_STREET_LEVEL === 'true',
  // Whole-structure calls (WDO inspection, termite pre-treat / perimeter
  // treatment) are not held because the address lacks a unit number: Google's
  // "missing subpremise" on a duplex or building-level job is waived, and ONLY
  // that (every other address check, commercial and condo/apartment interior
  // work keep today's hold). Explicit service allowlist in
  // call-triage-flags.js. Owner ruling 2026-09-30. Off → byte-identical.
  callWholeStructureNoUnit: process.env.GATE_CALL_WHOLE_STRUCTURE_NO_UNIT === 'true',
  // A business address with no unit is not held for the "which unit?" ask when
  // the caller says they own, bought, lease or occupy the WHOLE building and
  // Google Address Validation says the address is a business. Same waiver
  // marker as the whole-structure gate (reason 'business_whole_building'), so
  // the audits rebuild it. Owner ruling 2026-10-06; the owner accepted the risk
  // of a strip-mall caller who has a suite. Both directions. Off →
  // byte-identical.
  callBusinessWholeBuildingNoUnit: process.env.GATE_CALL_BUSINESS_WHOLE_BUILDING_NO_UNIT === 'true',
  // Agent-commitment booking authorization: when OUR agent explicitly
  // committed to the confirmed slot on the call ("we'll confirm it for noon
  // on Sunday" — evidence-pinned to an AGENT-spoken quote), a third-party
  // caller (realtor/PM booking for a buyer/tenant) no longer hard-blocks on
  // caller_not_authorized: the appointment books and the flag files as an
  // advisory "confirm the account holder" card (book-and-flag). All other
  // hard blocks stay. Independent of callFailOpenBooking. Creates real
  // appointments — owner-flip only.
  callAgentCommitBooking: process.env.GATE_CALL_AGENT_COMMIT_BOOKING === 'true',
  // Unclear-service assessment booking (owner-approved review item, 2026-09-30):
  // a call with a CONFIRMED on-the-hour time and a trusted address is not held
  // on ambiguous_pest_or_service — the existing fail-open
  // "Waves Assessment" fallback books it and the office keeps its advisory
  // card to set the real service. Ships DARK: strict `=== 'true'`, default
  // off. Rides GATE_CALL_FAIL_OPEN_BOOKING (inert without it). Read through
  // isEnabled('callUnclearServiceAssessment') by the call processor, which
  // hands canAutoRoute the boolean as opts.unclearServiceAssessment.
  callUnclearServiceAssessment: process.env.GATE_CALL_UNCLEAR_SERVICE_ASSESSMENT === 'true',
  // Companion trust gate for callAgentCommitBooking: the Agent:/Caller:
  // transcript labels the commitment-grounding relies on are LLM-inferred
  // today (labelTranscriptWithOpenAI infers unclear identities; its integrity
  // check preserves words, not attribution). Flip ONLY when speaker labels
  // come from a deterministic source (dual-channel recording / channel-
  // derived diarization) — or when the owner explicitly accepts LLM-label
  // risk. Without this gate the agent-commitment demotion never fires, even
  // with GATE_CALL_AGENT_COMMIT_BOOKING on. Owner-flip only.
  callAgentCommitTrustedLabels: process.env.GATE_CALL_AGENT_COMMIT_TRUSTED_LABELS === 'true',
  // Commercial dictated booking (owner ruling 2026-09-30, call-booker gates
  // review item 8): a commercial job that Waves staff dictate on the call AND
  // the caller accepts, with a price agreed and grounded, books without the
  // office. INBOUND calls only for now (outbound speaker labels have swapped;
  // it waits for staff identity that does not depend on the labels). Safety:
  // BOTH the staff commitment quote and the caller's acceptance quote must be
  // found word for word in a turn of their own speaker (the reschedule
  // grounding, call-reschedule-agreement.js), so a missing or swapped speaker
  // label fails closed. Also needs GATE_CALL_AGENT_COMMIT_BOOKING (its kill
  // switch) and GATE_CALL_AGENT_COMMIT_TRUSTED_LABELS. Only clears
  // commercial_requires_quote; a job with no price agreed on the call still
  // goes to the office. The extraction judges the language (schema 1.21.0);
  // the code only verifies the pinned quotes. Ships DARK: off unless exactly 'true'. This entry is
  // for logGateStatus only — the canonical CALL-TIME reader is
  // callCommercialDictatedBookingLive() below. Creates real appointments —
  // owner-flip only.
  callCommercialDictatedBooking: process.env.GATE_CALL_COMMERCIAL_DICTATED_BOOKING === 'true',
  // A commercial Waves Assessment that staff book on the call with no price
  // discussed auto-books, outbound callback calls included (owner ruling
  // 2026-10-06). Ships DARK: off unless exactly 'true'. This entry is for
  // logGateStatus only — the canonical CALL-TIME reader is
  // callCommercialAssessmentBookingLive() below. Creates real appointments —
  // owner-flip only.
  callCommercialAssessmentBooking: process.env.GATE_CALL_COMMERCIAL_ASSESSMENT_BOOKING === 'true',
  // Call extraction V2 sends its rules as a static, cacheable system part and the
  // call's facts and transcript as the user message. Ships DARK: off unless
  // exactly 'true'. This entry is for logGateStatus only — the canonical
  // CALL-TIME reader is callExtractionSystemPromptLive() below.
  callExtractionSystemPrompt: process.env.GATE_CALL_EXTRACTION_SYSTEM_PROMPT === 'true',
  // Call extraction V1 falls back to Claude (then OpenAI) when its Gemini leg
  // fails for a provider reason (2026-10-21: Gemini 402 credits depleted failed
  // 19 of 19 recorded calls). Ships DARK: off unless exactly 'true'. This entry
  // is for logGateStatus only — the canonical CALL-TIME reader is
  // callExtractionV1FallbackLive() below.
  callExtractionV1Fallback: process.env.GATE_CALL_EXTRACTION_V1_FALLBACK === 'true',
  // The second transcription pass and the contact decoder also run when the primary
  // transcript shows what a collapsed spelling leaves behind (a repeated name token, an
  // announced spelling with no letters). Ships DARK: off unless exactly 'true'. This entry
  // is for logGateStatus only — the canonical CALL-TIME reader is
  // callSpellingCollapseTriggerLive() below.
  callSpellingCollapseTrigger: process.env.GATE_CALL_SPELLING_COLLAPSE_TRIGGER === 'true',
  // A new caller who gave a last name but no first name still becomes a customer and
  // books; the missing first name files an advisory card (owner ruling 2026-10-02).
  // Ships DARK: off unless exactly 'true'. This entry is for logGateStatus only —
  // the canonical CALL-TIME reader is callFirstNameAdvisoryLive() below.
  callFirstNameAdvisory: process.env.GATE_CALL_FIRST_NAME_ADVISORY === 'true',
  // Last-name suggestion for a phone caller who gave only a first name (owner
  // ruling 2026-10-08). Ships DARK: off unless exactly 'true'. This entry is for
  // logGateStatus only — the canonical CALL-TIME reader is
  // callLastNameLookupLive() below.
  callLastNameLookup: process.env.GATE_CALL_LAST_NAME_LOOKUP === 'true',
  // Bait station visits on the one-screen Fast Complete sheet (owner ruling
  // 2026-10-08). Ships DARK: off unless exactly 'true'. This entry is for
  // logGateStatus only — the canonical CALL-TIME reader is
  // stationFastCompleteLive() below.
  stationFastComplete: process.env.GATE_STATION_FAST_COMPLETE === 'true',
  // Pin check after a visit (owner "build guardrail" 2026-10-09). Ships DARK: off
  // unless exactly 'true'. This entry is for logGateStatus only — the canonical
  // CALL-TIME reader is pinParkedCheckLive() below.
  pinParkedCheck: process.env.GATE_PIN_PARKED_CHECK === 'true',
  // Trip link (owner "TRIP LINK" 2026-10-26). Ships DARK: off unless exactly
  // 'true'. This entry is for logGateStatus only — the canonical CALL-TIME
  // reader is tripLinkLive() below.
  tripLink: process.env.GATE_TRIP_LINK === 'true',
  // Truck check (docs/tool-inventory-tracker-scope.md PR 1). Ships DARK: off
  // unless exactly 'true'. This entry is for logGateStatus only — the canonical
  // CALL-TIME reader is truckKitLive() below.
  truckKit: process.env.GATE_TRUCK_KIT === 'true',
  // Bid Desk intake (PR 1). Ships DARK: off unless exactly 'true'. This entry is for logGateStatus only — the
  // canonical CALL-TIME reader is bidDeskLive() at the end of this file.
  bidDesk: process.env.GATE_BID_DESK === 'true',
  // GATE_BID_DESK_SAM (Bid Desk SAM.gov reader, dark). Boot-log entry only; the call-time reader is bidDeskSamLive().
  bidDeskSam: process.env.GATE_BID_DESK_SAM === 'true',
  // GATE_BID_CHECKLIST (Bid Desk checklist, dark). Boot-log entry only; the call-time reader is bidChecklistLive().
  bidChecklist: process.env.GATE_BID_CHECKLIST === 'true',
  // GATE_BID_DESK_AUTO_DATES (Bid Desk template dates + auto-close, dark). Boot-log entry only; the call-time reader is bidDeskAutoDatesLive().
  bidDeskAutoDates: process.env.GATE_BID_DESK_AUTO_DATES === 'true',
  // GATE_BID_DESK_CHARLOTTE_DATES (Bid Desk Charlotte County due dates from the county's public list, dark). Boot-log entry only; the call-time reader is bidDeskCharlotteDatesLive().
  bidDeskCharlotteDates: process.env.GATE_BID_DESK_CHARLOTTE_DATES === 'true',
  // GATE_BID_DESK_NOT_OUR_WORK (Bid Desk files grounds-upkeep bids as no bid, dark). Boot-log entry only; the call-time reader is bidDeskNotOurWorkLive().
  bidDeskNotOurWork: process.env.GATE_BID_DESK_NOT_OUR_WORK === 'true',
  // GATE_CALL_APPLICANT_HANDLING (job-applicant / vendor call hygiene + Careers row, dark). Boot-log entry only; the call-time reader is callApplicantHandlingLive().
  callApplicantHandling: process.env.GATE_CALL_APPLICANT_HANDLING === 'true',
  // GATE_CALL_EMAIL_CHECKS (call-captured email checks: decoder fallback, domain check, no-mail-server bounces, typed card correction; dark). Boot-log entry only; the call-time reader is callEmailChecksLive().
  callEmailChecks: process.env.GATE_CALL_EMAIL_CHECKS === 'true',
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
  // Owner ruling 2026-09-26: the four customer-facing call-processor features
  // #4912 deliberately kept inbound-only (booking-confirmation implied
  // consent, the dropped-mid-intake call-back card, customer-less lead
  // creation, the approval-gated unit/address clarify draft) may run the
  // same on an OUTBOUND call ONLY when the person contacted Waves FIRST —
  // a prior inbound call/text, a lead record, or an existing customer
  // (server/services/outbound-call-reason.js's hasPriorContact, unbounded,
  // reused rather than a second query). NEVER on a cold/sales call we
  // placed to someone who never contacted us. The shared outboundReturn
  // MessagesEligible flag is prior contact ONLY (codex pre-push r4 P1,
  // reversing r1's own guidance): each site keeps its OWN existing "real
  // conversation" precondition instead — a confirmed booking
  // (GATE_CALL_OUTBOUND_BOOKING), a workable lead signal, or the drop
  // detector's own MIN_CALL_SECONDS engagement floor — so a short but
  // genuinely confirmed exchange (offer → acceptance → confirmation, as
  // few as 3 turns) still gets its confirmation SMS. The ONE exception is
  // the clarify draft: nothing else at that site rules out an early drop,
  // so it alone ALSO requires hasRealTwoWayConversation (>= 4 exchanged
  // turns across >= 2 distinct speaker labels) on top of the shared flag.
  // Sends customer SMS + creates records — owner-flip only. Off → every
  // one of the four sites stays byte-identical to today (the
  // `!isOutboundCall(call)` checks are untouched; the lead-creation site's
  // new outbound restriction is a no-op while this gate is off).
  callOutboundReturnMessages: process.env.GATE_CALL_OUTBOUND_RETURN_MESSAGES === 'true',
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
  // Callback spam closes the parent voicemail: an admin callback
  // (metadata.relatedCallId) that reaches a solicitor resolves the parent
  // voicemail's open Needs Review cards and dismisses its open callback
  // promise, so a settled voicemail stops asking for work (2026-10-09 audit).
  callbackSpamClosesParent: process.env.GATE_CALLBACK_SPAM_CLOSES_PARENT === 'true',
  // Callback spoken-number link (2026-10-20 audit): an office callback dials the
  // voicemail's caller ID, but the caller may have spoken another number to ring
  // back, already a customer's primary phone (a quote form filed minutes
  // later). On, the call pass tries that number as a second chance before it
  // would create a customer. Nothing is sent or written to the phone fields.
  // Strict opt-in, read at call time via callbackSpokenNumberLinkLive(). Off =
  // today's behavior. Rollback: unset.
  callbackSpokenNumberLink: process.env.GATE_CALLBACK_SPOKEN_NUMBER_LINK === 'true',
  // Missed-call bell and push say more (owner "ALL" 2026-10-20): the line the
  // caller dialed, how many seconds they stayed on, and a customer's next
  // visit date. Admin copy only; nothing reaches a customer. Off = today's
  // sentence, byte for byte.
  missedCallAlertDetail: process.env.GATE_MISSED_CALL_ALERT_DETAIL === 'true',
  // One more push for a missed-call bell nobody has opened (owner "ALL"
  // 2026-10-20): 30 minutes after it rang, in office hours, once. No new
  // bell row. Admin push only.
  missedCallRepush: process.env.GATE_MISSED_CALL_REPUSH === 'true',
  // A missed-call bell for a customer on file whose visit moved after the call
  // (en route, arrived or completed, or an invoice paid, same ET day) is retired,
  // never rung and never re-pushed (owner 2026-10-21). Admin bell only.
  missedCallVisitUnderway: process.env.GATE_MISSED_CALL_VISIT_UNDERWAY === 'true',
  // Call commitments: every processed call records what Waves promised and
  // what the caller agreed to as evidence-linked rows (call_commitments),
  // seeded from the V2 extraction plus one bounded model pass over the
  // transcript, and links each promise to the later record that fulfils it.
  // Off → nothing is written; the Calls tab still renders rows already
  // recorded. Kill switch: unset. See services/call-commitments.js.
  callCommitments: process.env.GATE_CALL_COMMITMENTS === 'true',
  // One-hour follow-up pager (owner ruling 2026-09-26): a promise made on a
  // call (callback, quote, a time to come out) is due within one hour of
  // 8 AM–8 PM ET time; a missed one rings one bell, and a standing bell lists
  // everything missed in the last 24 hours. Internal only. Needs
  // callCommitments. Off → no-op. See services/followup-sla-watcher.js.
  followupSlaAlerts: process.env.GATE_FOLLOWUP_SLA_ALERTS === 'true',
  // Admin bell when a LEAD calls back on a number that still carries an
  // open, unkept Waves promise (a callback, a quote, a time to come out)
  // from an earlier unbooked call — the repeat-caller bell above only rings
  // on 3+ calls in 3 hours and misses a single, hours-later callback (owner
  // audit 2026-09-26: 41 such leads in 60 days). Needs callCommitments.
  // Bell only — no customer comms. Ships dark. See
  // services/promise-chaser-bell.js.
  promiseChaserBell: process.env.GATE_PROMISE_CHASER_BELL === 'true',
  // Call reschedule apply: a matched existing customer's agent-committed move
  // of a visit already on the books (V2 reschedule_requested + confirmed
  // start) is applied to that visit through the rebooker, the access note
  // lands on the visit, and the call's reschedule cards resolve as 'auto'.
  // Fail-closed on identity, confidence, and a single unambiguous visit.
  // Sends NO customer communication (owner directive 2026-09-08); the
  // reminder cron simply reads the new time. Off → cards stay open as
  // before. See services/call-reschedule-apply.js.
  // Automatic moves also require GATE_CALL_AGENT_COMMIT_TRUSTED_LABELS.
  callRescheduleApply: process.env.GATE_CALL_RESCHEDULE_APPLY === 'true',
  // Make-up move (owner 2026-10-22): a recurring visit that was MISSED (its
  // 6 PM missed-appointment check left an open customer_noshow row) and the
  // customer then calls, the agent agrees a new time and the caller accepts.
  // The pipeline moves THAT visit (series default policy) instead of
  // inserting a new general-service visit beside it. Runs before the booking
  // branch; a candidate that cannot be moved holds the booking for review,
  // never falls back to a new visit. NO customer communication. Off → today's
  // booking behavior. See services/call-reschedule-apply.js applyCallMakeupMove.
  // Automatic moves also require GATE_CALL_AGENT_COMMIT_TRUSTED_LABELS.
  callMakeupMove: process.env.GATE_CALL_MAKEUP_MOVE === 'true',
  rescheduleProposalCard: gateEnvValue('GATE_RESCHEDULE_PROPOSAL_CARD'),
  callbackCard: gateEnvValue('GATE_CALLBACK_CARD'),
  smsAdditionalProperty: gateEnvValue('GATE_SMS_ADDITIONAL_PROPERTY'),
  // Missing-departure/arrival tracking: flags a scheduled_services row whose
  // promised window (the last communicated arrival window — SMS/email/call
  // evidence, never the raw schedule) has passed with no en_route/arrived
  // evidence. Stage 1 (45 min) notifies the assigned tech; stage 2 (150 min,
  // or any unassigned visit) also raises an office Action Queue alert
  // through the existing tech_late/unassigned_overdue dispatch-alert
  // lifecycle. Off → services/no-show-detector.js#sweep is a no-op; the
  // READ-ONLY replay CLI (ops/agents/replay-no-show-detector.js) still runs
  // regardless of this gate. Staff alerts only — no customer comms.
  noShowDetector: gateEnvValue('GATE_NOSHOW_DETECTOR'),
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
  // Dispatch "Promised on a call, not booked" strip (owner 2026-10-12): a call
  // where staff agreed a visit with the caller and nothing is on the calendar
  // shows as a display-only HELD row on that day, with a Book it button.
  // Reads call_log, scheduled_services, triage_items; writes nothing.
  // Off -> the route returns an empty list and the strip never renders.
  callHeldVisit: process.env.GATE_CALL_HELD_VISIT === 'true',
  // GATE_CALL_PREPAY_CHOICE (annual prepay chosen on a call: carried to Dispatch + one office card per booked call, dark). Boot-log entry only; the call-time reader is callPrepayChoiceLive().
  callPrepayChoice: process.env.GATE_CALL_PREPAY_CHOICE === 'true',
  // GATE_CALL_CANCEL_GUARD (a "Canceled on a call" notice on New Appointment, dark). Boot-log entry only; the call-time reader is callCancelGuardLive().
  callCancelGuard: process.env.GATE_CALL_CANCEL_GUARD === 'true',
  // GATE_AI_CHANGE_CHECK (before-and-after AI citation check per content change + one lost-citations digest leg, dark). Boot-log entry only; the call-time reader is aiChangeCheckLive().
  aiChangeCheck: process.env.GATE_AI_CHANGE_CHECK === 'true',
  // GATE_SAME_QUESTION_CHECK (new-blog same-question check: owner page rewrite instead of a sibling post, dark). Boot-log entry only; the call-time reader is sameQuestionCheckLive().
  sameQuestionCheck: process.env.GATE_SAME_QUESTION_CHECK === 'true',
  // GATE_QUOTE_SAME_PERSON_MATCH (quote wizard links to one same-person row instead of adding a row per rerun, dark). Boot-log entry only; the call-time reader is quoteSamePersonMatchLive().
  quoteSamePersonMatch: process.env.GATE_QUOTE_SAME_PERSON_MATCH === 'true',
  // GATE_ROUTE_ENGINE_SUMMARY (engine summary block on the admin Day Scorecard, read-only, dark). Boot-log entry only; the call-time reader is routeEngineSummaryLive().
  routeEngineSummary: process.env.GATE_ROUTE_ENGINE_SUMMARY === 'true',
  // GATE_INSPECTION_REUSE_LEAD_SHELL (consultation page reuses the lead's own untouched intake customer row instead of creating a second one, dark). Boot-log entry only; the call-time reader is inspectionReuseLeadShellLive().
  inspectionReuseLeadShell: process.env.GATE_INSPECTION_REUSE_LEAD_SHELL === 'true',
  // Day-only agreement shadow (owner 2026-10-20, PR 1 of 2): every 10 minutes a
  // sweep reads recent two-party calls and quiet text threads where only a DAY
  // was agreed for a visit (or a move of one), asks the model what the office
  // should do, and records what the agent WOULD do in day_agreement_decisions
  // so a week of shadow can be scored against what staff did. Books nothing,
  // moves nothing, texts no one. The act step is a later PR.
  // Off -> the cron tick returns before it reads anything.
  dayAgreementShadow: process.env.GATE_DAY_AGREEMENT_SHADOW === 'true',
  // Shared-writer cancellation notice (job-status.js): when a visit whose
  // reminders already went out is cancelled through ANY path (cascade,
  // track, IB, raw transition), text the customer the existing
  // appointment_cancelled template instead of vanishing silently
  // (2026-08-05 silent-cancel incident). Fail-closed; owner flips.
  cancelNoticeHook: process.env.GATE_CANCEL_NOTICE_HOOK === 'true',
  // Invoice issued ⇒ visit completed (owner ruling 2026-09-07): an invoice
  // linked to an open visit that is SENT to the customer or PAID (by hand,
  // or by card / bank through the Stripe webhook) closes the visit out
  // quietly (no report / text / review ask / charge; the invoice is reused).
  // Owner ruling 2026-10-04: a past day closes an unstarted or an arrived
  // (on_site) visit; today only an arrived visit closes, and only on a
  // payment (issuedCloseoutVisitRefusal). Ships DARK; owner flips.
  invoiceIssuedClosesVisit: process.env.GATE_INVOICE_ISSUED_CLOSES_VISIT === 'true',
  // Per-family plan-rate ledger (owner ruling 2026-08-06): with the gate ON,
  // an accept's customers.monthly_rate becomes the SUM of the customer's
  // customer_plan_rates components, so a multi-plan customer's same-family
  // re-quote replaces only that family's slice instead of the whole scalar.
  // OFF, accepts keep the legacy #3241 scalar semantics byte-for-byte while
  // the ledger dual-writes advisorily (data accumulates pre-flip). Kill
  // switch = unset; owner flips after the ops backfill seeds components.
  planRateLedger: process.env.GATE_PLAN_RATE_LEDGER === 'true',
  // Plan-rate ledger nightly invariant reconcile. This entry is for logGateStatus only: the scheduler tick and
  // services/plan-rate-ledger-reconcile.js read GATE_PLAN_RATE_LEDGER_RECONCILE at call time via
  // planRateLedgerReconcileLive() (which also needs GATE_PLAN_RATE_LEDGER).
  planRateLedgerReconcile: process.env.GATE_PLAN_RATE_LEDGER_RECONCILE === 'true',
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
  // Boot diagnostics show the effective conjunction; selection reads it at call time.
  termiteAnnualPlan: termiteAnnualPlanSelectionEnabled(),
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
  // First-touch auto-release (2026-09-20 call-agent audit, finding 3): a
  // call-captured email whose read-back card is still open resolves on its
  // own when the dictation was UNAMBIGUOUS — no arbiter digit doubt, V1 and
  // V2 and the release target all agree, top candidate >= 0.9, no
  // name/email mismatch on the call, the domain has MX, the pending hold
  // targets that exact address, and the card is younger than
  // FIRST_TOUCH_AUTO_RELEASE_MAX_AGE_DAYS (default 7). The ledger sweep
  // then releases the hold — the new-lead drip and newsletter opt-in go
  // out. Layered on triageAutoResolve + triageAutoResolveEvidence. Sends
  // customer email — owner-flip only. Ships DARK.
  firstTouchAutoRelease: process.env.GATE_FIRST_TOUCH_AUTO_RELEASE === 'true',
  // First-touch auto-release for a clearly spelled email: the card carries
  // NO decoder candidates (one spelling heard), so the one-candidate rule
  // above never fires. On (and only while GATE_FIRST_TOUCH_AUTO_RELEASE is
  // on too), a no-candidate email_unverified card with confidence >= 0.9, a
  // valid release target and no email disagreement qualifies; every other
  // check (V1/V2/target agreement, digit doubt, MX, exact-address hold, max
  // age) still applies. Sends customer email — owner-flip only. Ships DARK.
  // Read at call time in triage-auto-resolve; registered here for the boot log.
  firstTouchAutoReleaseSpelled: process.env.GATE_FIRST_TOUCH_AUTO_RELEASE_SPELLED === 'true',
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
  // about X — get your quote: … Someone from the Waves team will follow up
  // as soon as possible."), at any hour (owner ruling 2026-09-28: no 8 AM
  // defer — 'voicemail_lead_sms' is a CUSTOMER_ACTION_ENTRY_POINTS entry). A
  // customer-facing auto-send, so it FAILS CLOSED (explicit opt-in in EVERY
  // environment) per the house rule — a preview/dev env with real Twilio
  // creds must NOT auto-text prospects. Owner sets
  // GATE_VOICEMAIL_LEAD_SMS=true on prod to go live. Off → the voicemail
  // still becomes a Needs-Review lead; only the SMS is skipped.
  voicemailLeadSms: process.env.GATE_VOICEMAIL_LEAD_SMS === 'true',

  // Outbound voicemail text-back (services/outbound-voicemail-sms.js): an
  // admin click-to-call that reaches the CUSTOMER'S voicemail hangs up the
  // customer leg before a message is left and texts "sorry we missed you"
  // instead (owner-directed 2026-09-08 — the "did you just call me?"
  // callbacks). Same fail-CLOSED rule as the other text-back lanes:
  // customer-facing auto-send, explicit opt-in in every environment. Owner
  // sets GATE_OUTBOUND_VOICEMAIL_SMS=true to go live. Off → the outbound
  // <Dial> requests no machine detection at all (no AMD charge, no hangup,
  // no text) — the call flow is unchanged from before this lane.
  outboundVoicemailSms: process.env.GATE_OUTBOUND_VOICEMAIL_SMS === 'true',

  // Automatic booking-link text after a call (owner ruling 2026-09-26): a
  // NEW lead who wanted someone to come out and ended the call with nothing
  // booked gets the existing free-consultation link text 2 hours later (or
  // 8 AM ET the next morning for a call ending at/after 6 PM ET) — staff get
  // the first shot at a callback, and every "never" condition (booked since,
  // opted out, an estimate linked, a link sent in the last 14 days…) is
  // re-checked at send time. Also requires GATE_LEAD_INSPECTION_LINK live
  // (buildLeadConsultationSmsLine's own gate). Off → nothing is read or
  // written; the call_log row carries no metadata for this lane. See
  // services/call-booking-link-text.js.
  callBookingLinkText: process.env.GATE_CALL_BOOKING_LINK_TEXT === 'true',
  // Missed-call text-back (services/missed-call-text-back.js): an UNKNOWN
  // caller (no customer record on file) calls a Waves line,
  // nobody answers, they wait >= 15s (missed-call-bell's own floor) and
  // hang up with no voicemail — one text goes from the exact line they
  // called ("it's Waves... someone will follow up... text us here... or
  // call back anytime"), at any hour (owner ruling 2026-09-28: no 8 AM
  // defer — it is a CUSTOMER_ACTION_ENTRY_POINTS entry). Same fail-CLOSED
  // rule as the other text-back lanes: customer-facing auto-send, explicit
  // opt-in in every environment. Owner sets GATE_MISSED_CALL_TEXT_BACK=true
  // to go live. Off → the post-call hook and the durable sweep send nothing
  // (gate read first, before any call query) — no text, no call_log write,
  // no claim taken. The sweep still reconciles claims this lane left
  // orphaned while it was on.
  missedCallTextBack: process.env.GATE_MISSED_CALL_TEXT_BACK === 'true',
  // Widens the text-back lane ONLY (not the bell): a caller who waited 15s+
  // at the voicemail greeting and hung up without speaking leaves a recording
  // the processor rejects as no-speech; the voicemail lane does nothing with
  // it, so the caller got no text. On → that call counts as "no message
  // left" once the processor has finished with it (a recording still
  // awaiting transcription never does). Needs GATE_MISSED_CALL_TEXT_BACK.
  // Off → byte-identical to before.
  missedCallTextBackEmptyVoicemail: process.env.GATE_MISSED_CALL_TEXT_BACK_EMPTY_VOICEMAIL === 'true',
  // Narrows the text-back lane ONLY (not the bell), owner ruling 2026-10-24
  // ("this should be fixed": no text-back to robocalls): a caller who failed
  // the press-1 pre-connect screen (GATE_CALL_PRECONNECT_SCREEN stamps
  // call_log.metadata.preconnect_screen 'failed' when an unknown caller on
  // STIR attestation B pressed no key) gets no text; the call settles
  // skipped:screen_failed. 'passed', 'gated', 'would_gate' and no stamp text
  // as before. Off → byte-identical to before.
  missedCallTextSkipFailedScreen: process.env.GATE_MISSED_CALL_TEXT_SKIP_FAILED_SCREEN === 'true',
  // Missed-call bell gaps (owner 2026-10-20, "ALL", after the call audit). Admin
  // bell only: none of the four sends a customer text, email or call. Each ships
  // dark; off = byte-identical to before, except gates A and B stamp
  // metadata.missed_call_gap_shadow on the calls they would have rung.
  // A: a customer on file who reached voicemail and left an empty recording
  // (no speech) rings the bell.
  missedCallEmptyVmCustomer: process.env.GATE_MISSED_CALL_EMPTY_VM_CUSTOMER === 'true',
  // B: a customer's inbound call that ended `completed` with no answered_by and
  // no recording (the status-callback fallback insert, the ingest watchdog)
  // counts as unanswered for the bell.
  missedCallNoOutcomeCustomer: process.env.GATE_MISSED_CALL_NO_OUTCOME_CUSTOMER === 'true',
  // C: our dialed callback counts as "the caller got through" only when the
  // customer leg was answered, not when the staff leg pressed 1 (bridged_at).
  callbackNeedsAnswer: process.env.GATE_CALLBACK_NEEDS_ANSWER === 'true',
  // D: a missed-call bell whose push reached no phone is retried once by the
  // 2-minute sweep, then settled; one admin alert per ET day names the failure.
  missedCallPushCheck: process.env.GATE_MISSED_CALL_PUSH_CHECK === 'true',

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
  // Three modes via GATE_EMAIL_TEMPLATE_AUTOMATIONS (see
  // emailTemplateAutomationsMode() below, the canonical live-read reader):
  // unset/anything else = kill (off); 'shadow' = runs are created and
  // finalized as would_send with NOTHING dispatched — for checking volumes
  // for two weeks before anything goes live; 'true' = live sends. This
  // boolean entry only decides whether the executor runs AT ALL (shadow
  // counts as on, same as live) — logGateStatus and every reader BELOW this
  // rule reads it; the shadow-vs-live SEND decision is
  // emailTemplateAutomationsMode()'s alone.
  //
  // SHADOW NEVER CHANGES A LIVE SEND. An existing producer ALREADY sent a
  // customer email/SMS on this boolean alone before shadow mode existed —
  // routing it into the executor on the boolean (true in shadow too)
  // would have shadow silently REPLACE its live send with a would_send
  // no-op. It now gates on `emailTemplateAutomationsMode() === 'live'`
  // instead, so shadow leaves it byte-identical to today's gate-off
  // behavior:
  //   - server/services/appointment-tagger.js (~line 657,
  //     triggerPrepEmailGuide): 'live' only ⇒ queues through the executor;
  //     off/shadow ⇒ returns { queued:false, reason:'gate_off' }, same as
  //     today, so the caller's companion-SMS branch never promises a guide
  //     email shadow mode won't actually send.
  // Every OTHER reader keeps reading this boolean (shadow counts as on,
  // same as live) because none of them sends anything outside the executor
  // itself: the admin trigger/process-due test routes (admin-email-templates.js
  // ~lines 850, 873), and the new estimate.expired / review.linked_5star
  // emitters (email-template-automation-emitters.js) — all of them route
  // INTO the executor, which is where the shadow-vs-live decision actually
  // lives (executeRun's dispatch chokepoint). A producer must read this
  // boolean ONLY when every one of its own sends already goes exclusively
  // through the executor with no direct-send fallback of its own.
  // The scheduler's due-run tick (scheduler.js, processDueRuns) reads no
  // gate at all: it runs in every mode, and with the mode off executeRun
  // settles each due run skipped (gate_off) instead of sending it.
  //
  // ONE SOURCE OF TRUTH (codex P1 round 4): this boolean is DERIVED from
  // emailTemplateAutomationsMode() at call time — on exactly when the mode
  // is 'shadow' or 'live' — in every environment. It used to be computed
  // separately (always true outside production), so a non-prod explicit
  // 'false'/'off' kill switch left it on while the mode read 'off': the
  // lifecycle emitters then passed their gate check, got the executor's
  // off-mode no-op and settled their intent markers 'processed', and the
  // admin trigger route reported success instead of "disabled". In
  // production the result is unchanged ('shadow'/'true' on, anything else
  // off); it now also follows a mid-process env change the same way the
  // mode reader always has.
  get emailTemplateAutomations() { return emailTemplateAutomationsMode() !== 'off'; },

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

  // First-party PostHog ingest proxy: /ingest/* on the portal origin forwards
  // to PostHog Cloud so ad blockers stop dropping the hub's and /book's funnel
  // events (10–25% by PostHog's figure). Inert until a caller points its SDK
  // host at it (hub PUBLIC_POSTHOG_HOST / portal VITE_POSTHOG_HOST). Kill:
  // unset → 404; revert the caller's host env too, or its SDK keeps posting
  // into the 404. This entry is for logGateStatus; the route reads
  // gateEnvValue('GATE_POSTHOG_INGEST_PROXY') at REQUEST time (the techTips
  // idiom), so a flip needs no CODE deploy — Railway's automatic redeploy on
  // the variable change is what restarts the process with the new value;
  // never set it with --skip-deploys. See server/routes/posthog-ingest.js.
  posthogIngestProxy: gateEnvValue('GATE_POSTHOG_INGEST_PROXY'),
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
  // location's Review Thank You sequence. Once per customer ever, and only
  // for a review posted within the last 14 days (a late or manual match of an
  // older review gets no "we saw your review" email; owner 2026-10-31).
  reviewThankYouEnroll: process.env.GATE_REVIEW_THANKYOU_ENROLL === 'true',
  // Automatic Google review replies. The gate is a MODE, not a boolean:
  // GATE_REVIEW_AUTO_REPLY = off (unset) | shadow (drafts only) | auto
  // (4-5★ post to Google; 1-3★ + unrated always park for a human). This
  // boolean is the "lane is on at all" view for status surfaces; the runner
  // reads the mode itself (services/review-reply/runner.js). Kill = unset.
  reviewAutoReply: ['shadow', 'auto'].includes(String(process.env.GATE_REVIEW_AUTO_REPLY || '').trim().toLowerCase()),
  // Bad-review bell (Clef second wave idea 7, owner CW-D4 2026-10-02 "yes"):
  // one needs-you item open for every unanswered Google review of 1–4 stars
  // written since this gate's first live run, checked after every review
  // sync (services/review-low-rating-alert.js). Rules only, no model;
  // internal only, never a customer send. Off unless exactly 'true'. Map entry for logGateStatus only;
  // the live reader is reviewLowRatingAlertLive() (call time).
  reviewLowRatingAlert: process.env.GATE_REVIEW_ALERT === 'true',
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
  // GATE_REFERRAL_INBOUND_CONFIRM (Referrals Queue: confirm the referrer of a linked or named inbound plan customer, dark). Boot-log entry only; the call-time reader is referralInboundConfirmLive().
  referralInboundConfirm: process.env.GATE_REFERRAL_INBOUND_CONFIRM === 'true',
  // GATE_REFERRAL_INBOUND_BELL (a bell row with Confirm / Not a referral for each card in Referrals → Queue, dark). Boot-log entry only; the call-time reader is referralInboundBellLive().
  referralInboundBell: process.env.GATE_REFERRAL_INBOUND_BELL === 'true',
  // GATE_ALERT_CLOSE_BUTTONS (Handled / Called back buttons on text, follow-up and missed-call bell rows, dark). Boot-log entry only; the call-time reader is alertCloseButtonsLive().
  alertCloseButtons: process.env.GATE_ALERT_CLOSE_BUTTONS === 'true',
  // GATE_BID_ALERT_BUTTONS (No bid / Bid buttons on a new bid invite's bell row, dark trial). Boot-log entry only; the call-time reader is bidAlertButtonsLive().
  bidAlertButtons: process.env.GATE_BID_ALERT_BUTTONS === 'true',

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
  // On, a blog still publishes only when every named competitor is on the
  // owner list (competitor-facts OWNER_APPROVED_AUTOPUBLISH_IDS, rulings
  // 2026-09-27 D2 + 2026-09-28).
  namedCompetitorAutopublish: process.env.GATE_NAMED_COMPETITOR_AUTOPUBLISH == null || process.env.GATE_NAMED_COMPETITOR_AUTOPUBLISH === 'true',

  // Affiliate links in blog bodies (owner monetization pilot 2026-08-31).
  // When ON, content-guardrails resolves <AffiliateLink product="…"> tags
  // against the vendored @waves/affiliate-registry (product rows the owner
  // approved by merging their astro registry PR); when OFF — the default —
  // the product index is empty, so EVERY AffiliateLink is a P0
  // UNREGISTERED_AFFILIATE_LINK and the lane is fully dark. Raw affiliate
  // URLs never pass regardless (DISALLOWED_EXTERNAL_LINK), and channel
  // stripping (newsletter/social) runs regardless of this flag. OFF in
  // EVERY environment unless set to EXACTLY 'true' (policy flag — '1'/'on'
  // stay dark; unlike GATE_NAMED_COMPETITOR_AUTOPUBLISH, unset is OFF);
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

  // aeo_question_gap opportunity mining — identify/decision/cost AEO
  // benchmark questions whose target page answer engines don't cite become
  // a refresh of that page (or one new article when it doesn't exist).
  // DARK in every environment unless exactly 'true'; read at call time so
  // unsetting it stops the bucket without a redeploy (off ⇒ []).
  get aeoQuestionGapMining() { return process.env.GATE_AEO_QUESTION_GAP_MINING === 'true'; },

  // answer_gap opportunity mining — queries a page already ranks 9–30 for
  // (per gsc_query_page_map) whose body never directly answers them; emits
  // refresh_existing_page opportunities whose drafts add self-contained
  // answer blocks. Default OFF in prod: ships dormant so the first mined
  // batch can be eyeballed before the refresh lane starts consuming it
  // (GATE_ANSWER_GAP_MINING=true to enable). When off, the bucket miner
  // returns [].
  answerGapMining: isProd ? process.env.GATE_ANSWER_GAP_MINING === 'true' : true,

  // citability_backfill seeding — operator-triggered scan of the live blog
  // corpus (server/scripts/seed-citability-backfill.js) that queues
  // refresh_existing_page rows for posts missing the citability traits the
  // quality gate nudges on (named sources / concrete specifics / comparison
  // / how-to-choose). Default OFF in prod: the seeder's --dry-run scan
  // always works, but writes need GATE_CITABILITY_BACKFILL=true so the
  // first batch is eyeballed before the refresh lane starts consuming it.
  // The same gate fences CONSUMPTION (opportunity-queue
  // citabilityBackfillLaneOpen: claimNext/peek skip the bucket while off),
  // so flipping it back off is a real kill switch for rows already queued.
  citabilityBackfill: isProd ? process.env.GATE_CITABILITY_BACKFILL === 'true' : true,

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

  // Weekly voice relay conversation eval — replays the synthetic-caller
  // scenario fixture (server/fixtures/voice-relay-eval/) through the LIVE
  // Sandy conversation loop and the pinned judge, in a child process (the
  // per-scenario gates it sets never reach this process). Notifications and
  // ordinary judge telemetry may write; synthetic conversations cannot.
  // Explicit opt-in in every environment: GATE_VOICE_RELAY_EVAL=true.
  voiceRelayEval: process.env.GATE_VOICE_RELAY_EVAL === 'true',

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

  // Good / Better / Best on a pest + lawn estimate (owner 2026-10-05): a
  // three-tile picker that is a VIEW over the service opt-out rail — Best is
  // the estimate as quoted, Better is lawn removed through the rail's own
  // canonical re-price, Good is the one-time choice on that pest-only row.
  // The stored row is always an ordinary valid estimate. Needs the opt-out
  // gate. Read at call time via estimateOfferTiersLive(); this map entry is
  // for logGateStatus only. STRICT opt-in.
  // Enable with GATE_ESTIMATE_OFFER_TIERS=true.
  estimateOfferTiers: process.env.GATE_ESTIMATE_OFFER_TIERS === 'true',

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
  // [frequencyKey]: { visitsPerYear } } }, one entry per lawn frequency
  // that is a catalog lawn plan). No product, step, or fertilizer names
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

  // Website estimate pages publish eligible engine quotes directly into the
  // existing estimate booking/Auto Pay flow. Ordinary lead forms never opt in.
  websiteQuoteBooking: process.env.GATE_WEBSITE_QUOTE_BOOKING === 'true',

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

  // Basic payroll settings (owner 2026-10-25): W-4 elections and pay method for W-2
  // technicians. OFF in every environment; read at call time via payrollLive().
  // Kill switch: unset GATE_PAYROLL.
  payroll: process.env.GATE_PAYROLL === 'true',

  // Payroll layer 2 (owner 2026-10-25): payroll tax deposits and filings on the
  // Tax page filing calendar. OFF in every environment; read at call time via
  // payrollTaxCalendarLive(). Kill switch: unset GATE_PAYROLL_TAX_CALENDAR.
  payrollTaxCalendar: process.env.GATE_PAYROLL_TAX_CALENDAR === 'true',

  // Tax deadline bells (owner 2026-10-30): the 8:23 ET tax deadline reminders ring
  // the admin bell. OFF in every environment; read at call time via
  // taxDeadlineBellsLive(). Kill switch: unset GATE_TAX_DEADLINE_BELLS.
  taxDeadlineBells: process.env.GATE_TAX_DEADLINE_BELLS === 'true',

  // Payroll Mercury paychecks (owner plan A, 2026-10-30): the read-only Mercury link (poller, recipient check,
  // warnings, chips) and, separately, the Send and Send again actions. OFF in every environment; read at call
  // time via payrollMercuryStatusLive() and payrollMercuryPayLive(). Kill switches: unset the gate.
  payrollMercuryStatus: process.env.GATE_PAYROLL_MERCURY_STATUS === 'true',
  payrollMercuryPay: process.env.GATE_PAYROLL_MERCURY_PAY === 'true',

  // Public lawn watering calculator API (owner 2026-10-31, backlink tools plan step 2, 'ok go, approved'): GET
  // /api/public/watering-plan. OFF in every environment; boot-log entry only, the call-time reader is
  // publicWateringPlanLive(). Kill switch: unset GATE_PUBLIC_WATERING_PLAN.
  publicWateringPlan: process.env.GATE_PUBLIC_WATERING_PLAN === 'true',

  // Payroll layer 3a (owner 2026-10-25): the line-by-line figures for Form 941,
  // RT-6, Form 940 and W-2/W-3 in the Payroll tab. OFF in every environment;
  // read at call time via payrollFormFiguresLive(). Kill switch: unset
  // GATE_PAYROLL_FORM_FIGURES.
  payrollFormFigures: process.env.GATE_PAYROLL_FORM_FIGURES === 'true',

  // Payroll time off (owner 2026-10-26): paid time off and holidays on pay runs. OFF in
  // every environment; read at call time via payrollTimeOffLive(). Kill switch: unset
  // GATE_PAYROLL_TIME_OFF.
  payrollTimeOff: process.env.GATE_PAYROLL_TIME_OFF === 'true',

  // Payroll pay lines (owner 2026-10-29, D5 part 1): review bonus, commission, health
  // allowance and employer HSA lines on pay runs, with the federal regular-rate overtime
  // they cause. OFF in every environment; read at call time via payrollPayLinesLive().
  // Kill switch: unset GATE_PAYROLL_PAY_LINES.
  payrollPayLines: process.env.GATE_PAYROLL_PAY_LINES === 'true',

  // Monday BI briefing, weekly scorecard per technician (owner GO 2026-10-29, second technician
  // build 7). OFF in every environment; read at call time via biTechScorecardLive().
  // Kill switch: unset GATE_BI_TECH_SCORECARD.
  biTechScorecard: process.env.GATE_BI_TECH_SCORECARD === 'true',
  // Truck views per vehicle (owner GO 2026-10-29, tech roadmap build 6): the Intelligence Bar
  // truck answer and the Mileage tab show each vehicle and its technician. OFF in every
  // environment; read at call time via truckViewsPerVehicleLive(). Kill switch: unset
  // GATE_TRUCK_VIEWS_PER_VEHICLE.
  truckViewsPerVehicle: process.env.GATE_TRUCK_VIEWS_PER_VEHICLE === 'true',

  // Payroll family employee (owner 2026-10-29, D5 part 2): a parent or spouse of the owner
  // on payroll pays no federal or Florida unemployment tax. OFF in every environment; read
  // at call time via payrollFamilyEmployeeLive(). Kill switch: unset GATE_PAYROLL_FAMILY_EMPLOYEE.
  payrollFamilyEmployee: process.env.GATE_PAYROLL_FAMILY_EMPLOYEE === 'true',

  // Payroll review bonus import (owner 2026-10-29, D5 part 3a): earned Google review bonuses
  // become pay lines on pay runs. OFF in every environment; read at call time via
  // payrollReviewBonusImportLive(). Kill switch: unset GATE_PAYROLL_REVIEW_BONUS_IMPORT.
  payrollReviewBonusImport: process.env.GATE_PAYROLL_REVIEW_BONUS_IMPORT === 'true',

  // Commission "Sold by" (owner 2026-10-29, D5 part 3b-1): the field-lead flag records a
  // truck GPS check and a verified W-2 flag fills the estimate's Sold by. OFF in every
  // environment; read at call time via commissionSoldByLive().
  // Kill switch: unset GATE_COMMISSION_SOLD_BY.
  commissionSoldBy: process.env.GATE_COMMISSION_SOLD_BY === 'true',

  // Commission ledger (owner 2026-10-29, D5 part 3b-2): customer payments on a technician's sales become
  // 'commission' pay lines on pay runs. Needs payrollPayLines. OFF in every environment; read at call
  // time via payrollCommissionLedgerLive(). Kill switch: unset GATE_PAYROLL_COMMISSION_LEDGER.
  payrollCommissionLedger: process.env.GATE_PAYROLL_COMMISSION_LEDGER === 'true',

  // Bid unit, private costing and validity controls; default off everywhere.
  // Readers always honor saved quantities and dates after the controls are off.
  commercialBidBuilder: gateEnvValue('GATE_COMMERCIAL_BID_BUILDER'),

  // Browser-rendered estimate PDF — GET /api/estimates/:token/pdf, the admin
  // proposal.pdf download, and the proposal email attachment render the React
  // EstimateProposalDocument (service-report-style document) through the
  // headless-browser pipeline instead of the legacy pdfkit proposal. Every
  // failure path falls back to the pdfkit document so estimate delivery never
  // blocks on a browser. Off in prod until the rendered document is verified.
  // Kill switch: unset GATE_ESTIMATE_DOC_PDF.
  estimateDocPdf: isProd ? process.env.GATE_ESTIMATE_DOC_PDF === 'true' : true,

  // Estimate PDF on the email (owner ask 2026-10-19: "attach a pdf version of
  // the estimates to all outgoing emails for customers who can't open the
  // estimate"). An open-estimate email (delivery, follow-ups, engagement,
  // extension notices) carries the browser-rendered work-order document as
  // a PDF attachment plus a one-line note under the button. Needs
  // GATE_ESTIMATE_DOC_PDF too: the attachment is the browser document only,
  // never the pdfkit proposal. A render failure sends the email as before.
  // Off or unset in prod: every estimate email is byte-identical to today.
  // Kill switch: unset GATE_ESTIMATE_EMAIL_PDF (read at boot; the Railway restart applies it).
  estimateEmailPdf: isProd ? process.env.GATE_ESTIMATE_EMAIL_PDF === 'true' : true,

  // Monthly AVERAGE beside per-application prices on residential estimates
  // (owner ruling 2026-10-20, "option A"). The per-application price stays the
  // price; a second, smaller line reads "$X a month", with the context
  // "Averaged over the year. You pay after each application." Covers the
  // delivery email's Estimated price row (and one sentence ahead of its
  // next-step paragraph), the estimate PDF document and the estimate page.
  // The plan average equals the stored monthly total; the per-service averages
  // add up to it to the cent (shared/estimate-monthly-average.cjs). Commercial
  // proposals, quote-required estimates, one-time-only estimates and
  // annual-prepay choices are untouched, and "$X/mo" as the PRICE stays banned.
  // Off or unset in prod: email, PDF and page are byte-identical to today.
  // Kill switch: unset GATE_ESTIMATE_MONTHLY_AVERAGE (read at boot; the Railway restart applies it).
  estimateMonthlyAverage: isProd ? process.env.GATE_ESTIMATE_MONTHLY_AVERAGE === 'true' : true,

  // Monthly average in the estimate FOLLOW-UP emails (owner 2026-10-21, "follow-ups
  // too"): the unviewed, viewed, final and expiring-notice emails carry the same
  // price row and context sentence the delivery email does ("$94.00 per
  // application · $31.33 a month", or "Priced per application · plan averages
  // $72.30 a month", plus "Averaged over the year. You pay after each
  // application."), built by the same shared builder and eligibility rules
  // (emailAverageParts). Needs GATE_ESTIMATE_MONTHLY_AVERAGE ON too. Off or unset in
  // prod: every follow-up payload is byte-identical to today.
  // Kill switch: unset GATE_ESTIMATE_FOLLOWUP_MONTHLY_AVERAGE (read at boot; the Railway restart applies it).
  estimateFollowupMonthlyAverage: isProd ? process.env.GATE_ESTIMATE_FOLLOWUP_MONTHLY_AVERAGE === 'true' : true,

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

  // Daily city-level forecast snapshots + read-only historical comparisons.
  // Opt-in everywhere after migration; live consumers use gateEnvValue at call time.
  pestForecastHistory: gateEnvValue('GATE_PEST_FORECAST_HISTORY'),

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

  // Null-position repair through the existing writer. Keeps customer promises
  // and positioned-stop order; requires drive calibration and the reorder gate.
  // Also enables verified service-address pin recovery in the hourly geocoder
  // backstop (with GATE_ROUTE_REORDER). Pin writes do not require calibration;
  // the subsequent route repair still does. No customer messages.
  // Explicit opt-in in every environment.
  routeReorderRepair: gateEnvValue('GATE_ROUTE_REORDER_REPAIR'),

  // Durable primary-address review and staff-verified pins. Explicit opt-in;
  // an existing verified pin stays protected after the UI is disabled.
  geocodeReview: gateEnvValue('GATE_GEOCODE_REVIEW'),

  // Nightly reorder pass only: on an unfrozen tech-day whose stored
  // route_order is incomplete (a null or a duplicate position), write any
  // strictly shorter promise-safe order instead of requiring the 805 m floor.
  // Complete orders keep the floor. Nested inside GATE_ROUTE_REORDER, read at
  // call time. Explicit opt-in in every environment. No customer messages.
  // Kill switch: unset GATE_ROUTE_REORDER_COMPLETE_ORDER.
  routeReorderCompleteOrder: gateEnvValue('GATE_ROUTE_REORDER_COMPLETE_ORDER'),

  // Stale-order canonicalization (nightly pass + the route-order-cleanup
  // script): on an unfrozen tech-day whose stored route_order is stale (a
  // null/duplicate position, a numeric gap, or a later promise numbered
  // ahead of an earlier one — staleOrderReasons in route-reorder-window-fit.js),
  // the comparison baseline becomes the promised-window order instead of the
  // stale stored order, and a day Google can't even run (coordless, too few
  // geocoded stops) still gets that baseline written. Non-stale days and
  // gate-off are byte-for-byte the pre-existing behavior. Nested inside
  // GATE_ROUTE_REORDER for the nightly pass; the cleanup script also honors
  // opts.canonicalizeStale directly. Read at call time. No customer messages.
  // Kill switch: unset GATE_ROUTE_REORDER_STALE_ORDER.
  routeReorderStaleOrder: gateEnvValue('GATE_ROUTE_REORDER_STALE_ORDER'),

  // Planned route measurements and candidate-specific gap checks in the
  // existing Intelligence Bar. Read-only and explicitly opt-in everywhere.
  scheduleQualityMeasurements: gateEnvValue('GATE_SCHEDULE_QUALITY_MEASUREMENTS'),

  // Existing Dispatch queue: unresolved future-route locations, durations,
  // modeled lateness, closures and unallocated work. Requires measurements;
  // separate opt-in so collection can stay observational.
  scheduleQualityAlerts: gateEnvValue('GATE_SCHEDULE_QUALITY_ALERTS'),

  // Admin-only per-day drive-vs-stops scorecard (day-scorecard.js): read-only
  // composition over the existing planned quality + saved-snapshot/recorded-
  // work readers, plus a Bouncie mileage_log rollup for the actual side of a
  // past day. No writes, no customer surface, no emails. Read at call time
  // by the route (server/routes/admin-route-scorecard.js) — off answers 404
  // {enabled:false} and the admin tab hides. Kill switch: unset
  // GATE_ROUTE_SCORECARD.
  routeScorecard: gateEnvValue('GATE_ROUTE_SCORECARD'),

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

  // DRIVE CLOCK (owner 2026-10-28, "add drive clock if its free"): every drive
  // leg in the scheduling math carries what our own GPS measured (estimate legs
  // 7.9 + 2.2 per straight-line mile, Google legs +4 minutes of parking). Read
  // at CALL time via gateEnvValue (scheduling/drive-clock.js); this entry is for
  // logGateStatus only. Moves scheduling numbers only; sends nothing. Dark.
  // Kill switch: unset GATE_DRIVE_CLOCK.
  driveClock: gateEnvValue('GATE_DRIVE_CLOCK'),

  // Schedule tie-proximity display order (owner ruling 2026-09-26) — when two
  // stops on a tech's day start within 30 minutes of each other, the one
  // closer to the previous stop shows first, instead of falling back to
  // whichever was booked first. DISPLAY ONLY: server/services/schedule-tie-
  // proximity.js returns a `displayOrder` per stop; nothing writes
  // route_order or any other column, and no customer communication is sent.
  // Uses the existing shared drive-time estimator (GATE_DRIVE_TIME_CALIBRATION
  // governs which one) — no new Google API calls. Off (default in every
  // environment) → the mobile day/week list and the desktop day board's route-
  // order badge sort by window start alone, exactly as before this gate
  // existed. Consumers read gateEnvValue() at CALL time, so a flip needs no
  // redeploy. Kill switch: unset GATE_SCHEDULE_TIE_PROXIMITY.
  scheduleTieProximity: gateEnvValue('GATE_SCHEDULE_TIE_PROXIMITY'),

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
  treeShrubFieldGuide: gateEnvValue('GATE_TREE_SHRUB_FIELD_GUIDE'),
  // Schedule day-view exceptions from the Job Card; no paragraph generation
  // or cache writes. Requires GATE_JOB_CARD too; unset removes the strips.
  dispatchReadiness: gateEnvValue('GATE_DISPATCH_READINESS'),
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

  // SiteOne savings-programs check (1st of the month, 9:00 AM ET): signs in
  // with the order bot's stored SiteOne login, READS the Early Order Programs,
  // promotions and Partners points (never adds to the cart, never changes the
  // account, never orders), compares with last month's snapshot and posts ONE
  // admin notification for new programs, programs ending within 30 days and
  // points expiring within 60 days. CALL-time gateEnvValue in
  // procurement/siteone-programs-check.js; off = { skipped: 'gated' } before
  // any DB read or browser launch. Opt-in, dark by default; kill = unset.
  siteOnePrograms: gateEnvValue('GATE_SITEONE_PROGRAMS_CHECK'),

  // SiteOne order by email (owner 2026-10-26, "OK DO OPTION B"): an admin
  // previews and sends ONE pickup-order email to SiteOne for an open restock
  // request (GET/POST /admin/inventory/restock-requests/:id/siteone-email);
  // the request then becomes ordered. CALL-time gateEnvValue through
  // siteOneEmailOrderLive() in procurement/vendor-order-email.js and the
  // restock queue; this entry is for logGateStatus. Off = both routes answer
  // 404 and the Restock tab shows no button. Opt-in, dark by default; kill =
  // unset. The order bot (GATE_AUTO_ORDER_SITEONE) is not touched.
  siteOneEmailOrder: gateEnvValue('GATE_SITEONE_EMAIL_ORDER'),

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

  // Weekly SiteOne deals bell (owner 2026-10-31, plan A): Monday 8:00 AM ET the
  // portal reads the last 7 days of the contact@ Gmail sync, keeps the SiteOne
  // and product-maker mail that looks like a deal (promo, flyer, early order,
  // rebate, price increase, price match), and rings ONE admin bell listing each
  // deal with its deadline and the catalog products it names. Plain rules over
  // rows already in the database: no model call, no paid API, no network, sends
  // nothing to anyone. Strict opt-in (`=== 'true'`) checked by the cron in
  // scheduler.js; double-gated behind cronJobs. Dark by default; kill = unset.
  siteOneDealsDigest: process.env.GATE_SITEONE_DEALS_DIGEST === 'true',

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
  irrigationWeekPlan: gateEnvValue('GATE_IRRIGATION_WEEK_PLAN'),

  // Saved Monday plan in My Property + the existing property-alerts sweep.
  // Explicit opt-in everywhere; email plan and property-alert gates still apply.
  irrigationAppPlan: process.env.GATE_IRRIGATION_APP_PLAN === 'true',

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

  // Record collected annual prepay: commit a receipt job with the payment,
  // then deliver through the standard receipt queue. Customer communications
  // stay off in every environment until explicitly enabled.
  recordedAnnualPrepayReceipt: process.env.GATE_RECORDED_ANNUAL_PREPAY_RECEIPT === 'true',

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

  // Zelle payments from the Plaid bank feed — the same decision table and
  // money path as zelleNoticeReconcile, fed by bank_transactions instead of
  // email: after each hourly Plaid sync, a new "Zelle money received from
  // <payer>" credit on a bank account settles the ONE open self-pay invoice
  // that matches it to the cent with a corroborating payer name, receipt
  // email + SMS included (owner ruling 2026-09-02); everything else parks on
  // the Invoices page. Money + a customer comm, so it ships dark in prod; the
  // owner flips it. OFF = the feed is never scanned (stale-claim recovery
  // still runs). Read at CALL time (gateEnvValue) by
  // services/zelle-notice-reconciler.js, so unsetting
  // GATE_ZELLE_BANK_RECONCILE is a live kill switch.
  zelleBankReconcile: isProd ? gateEnvValue('GATE_ZELLE_BANK_RECONCILE') : process.env.GATE_ZELLE_BANK_RECONCILE !== 'false',

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
  // "Visit not closed out" Action Queue cards (owner 2026-10-03): the 6 PM
  // missed-appointment check logs every visit still open at that hour; with
  // this on, each one also raises a dispatch card where a person rebooks it,
  // closes it out, dismisses it, or confirms it was a miss
  // (services/not-closed-out.js). Admin-only; no customer contact. Off: the
  // check logs as before and raises no card.
  notClosedOutQueue: isProd ? process.env.GATE_NOT_CLOSED_OUT_QUEUE === 'true' : true,
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

  // Admin bell policy — the shared admin bell rings ONLY for a customer reaching
  // out on any channel (new lead, text, email, voicemail, missed call, reschedule
  // note), accepted estimates, and failed customer payments (payment_failed; with
  // GATE_CUSTOMER_ALERTS_RING also bill_payment_error) — owner rulings 2026-08-28
  // and 2026-09-11; the allowlists live in services/notification-bell-policy.js.
  // Everything else (disputes, refund failures, PCI events and twilio_failure
  // included) is silenced at the
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

  // Plaid bank sync (2026-09-28): live Capital One checking/card feed into
  // the Bank Import staging table (read-only Transactions product — no money
  // movement). Nested under GATE_BANK_IMPORT; also needs PLAID_CLIENT_ID /
  // PLAID_SECRET / PLAID_ENV and a token key (PLAID_TOKEN_KEY, falls back to
  // DATA_HYGIENE_VAULT_KEY). Read at call time; kill switch = unset.
  plaidSync: gateEnvValue('GATE_PLAID_SYNC'),

  // Tax ledger rules + inbox (2026-10-23): deterministic payee rules that
  // pre-fill the Bank Import suggestion (category for an expense, or
  // personal / transfer / income / review) on every staged bank row, and an
  // Inbox tab under /admin/tax with one-tap decisions that can also write a
  // rule. Suggestion-only: no row changes status without the operator, the
  // expense itself still goes through /bank-import/:id/create-expense, an
  // Income decision keeps the row listed (nothing counts it as revenue), and
  // nothing leaves the admin. Nested under GATE_BANK_IMPORT; read at call
  // time via gateEnvValue so a flip needs no redeploy; dark by default.
  taxLedger: gateEnvValue('GATE_TAX_LEDGER'),

  // Shared bills + home office (2026-10-24): a bill that is part business
  // (a phone plan with business lines, home internet) books at its business
  // share when Bank Import turns the staged row into an expense, and the
  // simplified home-office deduction (sq ft x $5, max 300 sq ft) is kept per
  // tax year and added to the tax package. Nested under GATE_BANK_IMPORT; read
  // at call time via taxSharedBillsLive(); dark by default. Off = create-expense
  // and the tax package behave exactly as before.
  taxSharedBills: gateEnvValue('GATE_TAX_SHARED_BILLS'),

  // Tax return engine (2026-10-24): tax-year records (filing status, other
  // income, estimates paid, carryovers in), a federal return computed from the
  // P&L and the books (Schedule C, Schedule SE, NOL, QBI, income tax) and a
  // Return tab under Admin > Tax > Reports. Nested under GATE_BANK_IMPORT; read
  // at call time via taxReturnEngineLive(); dark by default. Off = the routes
  // 404 and the tab stays hidden; nothing else reads it.
  taxReturnEngine: gateEnvValue('GATE_TAX_RETURN_ENGINE'),

  // Slab pre-treat for a home is not taxed (2026-10-24): Florida taxes a
  // pre-construction termite treatment only for a nonresidential building
  // (Rule 12A-1.009), so a builder whose account is commercial owes no tax on
  // a home slab. TaxCalculator.calculateTax reads it at call time via
  // slabHomeNoTaxLive(); dark by default. Off = slab services are taxed by the
  // customer's property_type exactly as before.
  slabHomeNoTax: gateEnvValue('GATE_SLAB_HOME_NO_TAX'),

  // Residential building use is not taxed (2026-10-28): Florida taxes pest
  // control only at a nonresidential building (Rule 12A-1.009), whoever pays,
  // so an account whose won proposal says its site is a home or residential
  // community (customers.building_use = 'residential') owes no tax on its
  // visits. TaxCalculator.calculateTax reads it at call time via
  // buildingUseTaxLive(); dark by default. Off = commercial accounts are taxed
  // by property_type exactly as before.
  buildingUseTax: gateEnvValue('GATE_BUILDING_USE_TAX'),
  // Tax follows the serviced property's county (2026-10-29, fix 4 of the
  // proposal defaults check): Florida's surtax is due in the county where the
  // service is delivered (s. 212.054(3)(a); Rule 12A-15.003(5)(a)). On,
  // TaxCalculator.calculateTax reads the county from the visit's or the
  // estimate's saved property before the customer's own ZIP, maps DeSoto ZIPs,
  // and uses the 2026 Lee, Collier and DeSoto rates when no tax_rates row
  // covers the county. Read at call time via taxServiceCountyLive(); dark by
  // default. Off = the customer's ZIP and the 7% fallback, as before.
  taxServiceCounty: gateEnvValue('GATE_TAX_SERVICE_COUNTY'),
  // A slab pre-treat at a business building keeps its tax (2026-10-29, fix 5 of
  // the proposal defaults check): with GATE_SLAB_HOME_NO_TAX on, every slab
  // name not saying Commercial is billed as a home job, and the catalog has no
  // Commercial slab service. On, a commercial account's slab job whose serviced
  // property has Occupancy "Commercial" (customer_properties.occupancy_type)
  // keeps the county tax (Rule 12A-1.009). Read at call time via
  // slabBusinessSiteTaxLive(); dark by default. Off = every slab job of a
  // commercial account follows GATE_SLAB_HOME_NO_TAX exactly as before.
  slabBusinessSiteTax: gateEnvValue('GATE_SLAB_BUSINESS_SITE_TAX'),
  // Lawn 9x rounds (owner 2026-10-28): a NEW residential lawn 9x series (9
  // applications a year, today every-6-weeks or custom 42 days) is stored as
  // recurring_pattern 'lawn_rounds_9' with no interval, so it books one visit
  // in each of the nine fixed rounds a year instead of drifting on a 42-day
  // gap. Applied where a series' pattern is WRITTEN (office create and
  // make-recurring, estimate accept, online booking wizard, seeder follow-ups)
  // by lawnRoundsSeriesPattern in recurring-appointment-seeder.js; quotes and
  // cadence vocabulary stay every-6-weeks. Annual prepay covers a rounds series:
  // the term records coverage_cadence 'lawn_rounds_9' (an estimate accept with
  // annual prepay writes the rounds series and mints that term; prepay on book
  // of a rounds series mints it too, no downgrade), and its covered visits sit
  // on the round calendar. Read at call time via
  // lawn9xRoundsLive(); dark by default. Off = every series is written exactly
  // as before.
  lawn9xRounds: gateEnvValue('GATE_LAWN_9X_ROUNDS'),

  // Undo last manual payment (owner 2026-10-29, built before partial payments): the office can reverse a cash,
  // check, Zelle, Venmo, PayPal or other off-Stripe entry recorded by hand, the same Eastern day, before any
  // receipt or reminder went out (services/invoice-manual-payment-undo.js, POST /admin/invoices/:id/undo-payment).
  // Read at CALL time via undoManualPaymentLive(); strict `true`, dark by default. Off = the route answers 404
  // and the Invoices page hides the button. Kill switch: unset.
  undoManualPayment: process.env.GATE_UNDO_MANUAL_PAYMENT === 'true',

  // Partial payments (owner 2026-10-29): the Invoices page can record PART of a bill paid by a manual tender (cash, check, Zelle,
  // Venmo, PayPal, other) for a customer who is not on Auto Pay (recordManualPayment in services/invoice-manual-payment.js, POST
  // /admin/invoices/:id/record-payment with an explicit amount). Read at CALL time via partialPaymentsLive(); strict `true`, dark
  // by default. Off = the amount field stays locked to the full amount due and the writer refuses a smaller amount. Kill switch: unset.
  partialPayments: process.env.GATE_PARTIAL_PAYMENTS === 'true',

  // Lawn and landscape treatments are not taxed (2026-10-25): Florida does not
  // tax lawn spraying, residential or nonresidential (Rule 12A-1.009(6)), and
  // taxes pest control only for an infestation of a nonresidential building, so
  // tree and shrub and palm care is not taxed either. Mosquito work keeps its tax.
  // TaxCalculator.calculateTax reads it at call time via lawnSprayNoTaxLive();
  // dark by default. Off = these services are taxed by the customer's
  // property_type exactly as before.
  lawnSprayNoTax: gateEnvValue('GATE_LAWN_SPRAY_NO_TAX'),

  // Tax worksheets (2026-10-25): Tax > Reports > Sales tax (the Florida DR-15
  // lines for a month, quarter, half year or year from the books) and 1099s
  // (who was paid for contract labor or legal and professional work, and who
  // needs a 1099-NEC). Read-only; Mark filed uses the filing calendar's own
  // route. Nested under GATE_BANK_IMPORT; read at call time via
  // taxWorksheetsLive(); dark by default. Off = the routes 404 and the tabs
  // stay hidden.
  taxWorksheets: gateEnvValue('GATE_TAX_WORKSHEETS'),

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

  // Best-times road times (owner 2026-10-06): the best-times chips in the
  // availability strip (summary.best) and the picked hour's verdict get
  // their drive-in and added-drive numbers from Google's traffic-aware route
  // matrix instead of the straight-line model. Only the shown chips are
  // priced, on the picker's own allowance (route-optimizer hintTravelBudget,
  // never customer booking's), with a 6-hour cache per pin pair and hour.
  // Which hours fit is still decided by the model. OFF in every environment;
  // scheduling/hint-road-times.js reads it through gateEnvValue() at call
  // time. Kill switch: unset — chips show the model's numbers.
  bestTimesRoadTimes: gateEnvValue('GATE_BEST_TIMES_ROAD_TIMES'),

  // Open-times box (owner 2026-10-25, layout A, "all staff" + "start"): the
  // staff time picker on New Appointment, Edit appointment, Reschedule, the
  // drag-and-drop confirm and Quick Move lists only open times: 15 dates of
  // the next four weeks with "adds N min" and the technician, Best / Soonest,
  // Morning / Afternoon / Evening, a date's own open times when the Date field
  // changes, and a technician filter where the screen can change the
  // technician. No "doesn't fit" verdict, and Save never says "anyway". The
  // find-time route reads it through gateEnvValue() at call time (GET
  // /find-time/ui tells the pickers; a summary search with openTimes answers
  // summary.open_times). Needs GATE_BEST_TIME_HINTS. Dark in every
  // environment. Kill switch: unset, and the pickers show the availability
  // strip as before. This entry is for logGateStatus only.
  openTimesBox: gateEnvValue('GATE_OPEN_TIMES_BOX'),

  // Board open times (owner 2026-10-26, "start step 4"): while a visit is
  // dragged on the Dispatch day or week grid, the hours that fit it light up
  // with what each adds to the day's driving, amber over 30 min, the best one
  // tagged. The open-times search for the board's own days (the day grid:
  // every technician; the week grid: the visit's own technician). Display
  // only: the drop saves as before. The admin schedule day view carries it to
  // Dispatch as boardOpenTimes; the find-time route allows the open-times
  // search under it too. Needs GATE_BEST_TIME_HINTS. Dark in every
  // environment. Kill switch: unset, and a drag lights nothing.
  boardOpenTimes: gateEnvValue('GATE_BOARD_OPEN_TIMES'),

  // New Appointment route times (owner 2026-10-26, "fix both"): the open-times
  // box on New Appointment runs the same route check as Edit and the board, on
  // a new stop at the searched address, instead of the older gap check (which
  // offers no start after 4 PM). The find-time route reads it through
  // gateEnvValue() at call time. Needs GATE_BEST_TIME_HINTS, GATE_OPEN_TIMES_BOX
  // and GATE_ADMIN_ARRIVAL_WINDOWS. Suggestions only: the New Appointment save
  // is unchanged. Dark in every environment. Kill switch: unset, and New
  // Appointment searches the gaps as before. This entry is for logGateStatus
  // only.
  newApptRouteTimes: gateEnvValue('GATE_NEW_APPT_ROUTE_TIMES'),

  // New Appointment stop order (owner 2026-10-26, "OK GO"): after a New
  // Appointment save (POST /api/admin/schedule), the booked visit's technician
  // day is numbered in the order the route check certifies (placeMovedVisit,
  // like a staff move), so the board and the tech app list the visit in its
  // place instead of last. Needs
  // GATE_STAFF_ROUTE_INSERTION and GATE_ADMIN_ARRIVAL_WINDOWS. Never changes a
  // time or sends a message. The create route reads it through gateEnvValue()
  // at call time. Dark in every environment. Kill switch: unset. This entry is
  // for logGateStatus only.
  newApptStopOrder: gateEnvValue('GATE_NEW_APPT_STOP_ORDER'),

  // Phone agent stop order (owner 2026-10-26, "go d"): a fresh call-pipeline
  // booking numbers its technician's day the same way (placeMovedVisit, audit
  // source 'phone_call'), so the tech app lists it in its place instead of
  // last. A street-level pending row stays as it was. Needs
  // GATE_STAFF_ROUTE_INSERTION and GATE_ADMIN_ARRIVAL_WINDOWS. Never changes a
  // time or sends a message. call-recording-processor.js reads it through
  // gateEnvValue() at call time. Dark in every environment. Kill switch:
  // unset. This entry is for logGateStatus only.
  callBookingStopOrder: gateEnvValue('GATE_CALL_BOOKING_STOP_ORDER'),

  // New Appointment address-first best times (owner 2026-10-24, replacing the
  // 2026-10-21 Dispatch "Find a time" drawer): office staff on a call with a
  // NEW caller open New Appointment, pick the address in its New customer
  // block, and the time box (now above Services) shows the best hours for
  // that address alone, no customer record needed, on a 30-minute search
  // until a service sets the length. A chip fills the day and hour only: no
  // service is known yet, so the chip's technician is not pinned (Codex #6411
  // r1 on the retired drawer). Nothing is written until staff save. It needs GATE_BEST_TIME_HINTS
  // on to get an answer. OFF in every environment; the admin schedule day
  // view carries it to Dispatch as addressFirstTimes. Kill switch: unset —
  // the time box waits for a customer, as before.
  newApptAddressTimes: gateEnvValue('GATE_NEW_APPT_ADDRESS_TIMES'),

  // New Appointment phone match and one Save (owner 2026-10-24): in the New
  // customer block, a typed phone is looked up once it has ten digits and
  // each customer already on that number is offered with one tap ("Use this
  // customer"), never picked automatically (a household often shares one
  // phone). Save then adds a new caller and books the visit in one press (the
  // Add customer button goes away); a known phone or address still stops at
  // the Attach / Separate account choice, and a total that changes once the
  // customer exists waits for a second Save. A picked address suggestion
  // scrolls the best times into view. OFF in every environment; the admin
  // schedule day view carries it to Dispatch as newCustomerPhoneMatch. Kill
  // switch: unset — the Add customer button and the two-step flow return.
  newApptPhoneMatch: gateEnvValue('GATE_NEW_APPT_PHONE_MATCH'),

  // New-caller booking by address (owner 2026-10-25): with no customer
  // selected, the New customer block open, an address picked from the
  // suggestions and no name or phone typed, New Appointment's Book saves ONE
  // visit with that address and no customer (customer_id NULL, source_action
  // 'admin_new_caller', booking/new-caller-visit.js), stamped with the live
  // call the office answered (source_call_log_id; the office picks when more
  // than one is live). Nothing goes to the caller at Book: no text, no email,
  // no reminder. The call-recording agent links the customer after the call
  // and sends the confirmation (a later PR, same gate). OFF in every
  // environment; the admin schedule day view carries it to Dispatch as
  // newCallerBooking. Kill switch: unset — Book needs a customer, as before.
  newCallerBooking: gateEnvValue('GATE_NEW_CALLER_BOOKING'),

  // Booking rain rank (owner 2026-10-06): the New Appointment best-times rows
  // rank by rain fit before drive. Outdoor bookings (pest, lawn, T&S,
  // mosquito, termite treatment) sort hours with a 60%+ NWS chance in the
  // visit or the 2 hours after it below dry hours; rain-OK bookings
  // (assessments, estimates, WDO/termite inspections, rodent/trapping,
  // interior-only) sort them first. Next 3 days only. OFF in every
  // environment; scheduling/find-time-hints.js reads it through
  // gateEnvValue() at call time. Kill switch: unset — drive-only order.
  bookingRainRank: gateEnvValue('GATE_BOOKING_RAIN_RANK'),

  // Technician start points (owner 2026-10-22): a tech with a start address
  // (Team tab, technicians.start_lat/lng) starts and ends the day there, not
  // at the office, for STAFF callers that opt in (never public booking or a
  // commit-time check): the staff picker's open-gap search, the arrival-
  // window route check (scheduling/tech-start-point.js) and auto-dispatch
  // (its slot search and route math: auto-dispatch/route-model.js,
  // candidate-slots.js). Route
  // reorder and the estimate slot list follow in later PRs; flip only after
  // they merge, so every engine prices the same day the same way. OFF in
  // every environment; read through gateEnvValue() at call time. Kill switch:
  // unset — every route starts and ends at the office, as before.
  techStartPoints: gateEnvValue('GATE_TECH_START_POINTS'),

  // Technician "can move visits" switch (owner 2026-10-25, the way ServiceTitan
  // gates technician rescheduling): on, a non-admin technician whose Team tab
  // switch (technicians.can_move_visits) is off cannot move a visit: Quick Move
  // in the tech app and Quick Move / Reschedule from the dispatch routes answer
  // "Ask the office to move this visit." Every technician on file when the
  // column landed keeps moves on; a technician added later starts off. Admins
  // are never refused. OFF in every environment; read through gateEnvValue()
  // at call time (scheduling/tech-move-permission.js). Kill switch: unset —
  // every technician can move their own visits, as before.
  techMoveSwitch: gateEnvValue('GATE_TECH_MOVE_SWITCH'),

  // Technician login privacy (owner 2026-10-25): a technician login sees only its
  // own customers' alert bells, push banners and promises; the customer-deleted
  // account push goes to admins only. Exactly `true`. Read at call time in
  // notification-triggers.js, notification-service.js, admin-call-recordings.js
  // and push-notifications.js; this entry is for logGateStatus only.
  techLoginPrivacy: process.env.GATE_TECH_LOGIN_PRIVACY === 'true',

  // Estimate time picker keeps one opening per date and start time (owner
  // 2026-10-25, second technician). Exactly `true`. Read at call time in
  // estimate-slot-availability.js; this entry is for logGateStatus only.
  estimateSlotOnePerHour: process.env.GATE_ESTIMATE_SLOT_ONE_PER_HOUR === 'true',

  // Customer rain rank (owner 2026-10-08): the same rain-fit rule on the
  // customer booking surfaces. buildBookingAvailability (routes/booking.js:
  // /book, the inspection link, public reschedule) ranks its recommended
  // slots and each day's best fit by rain fit before route score; the
  // re-service profile keeps its own order. Order only: the hours offered,
  // the day list, signed offers and commit checks do not change. OFF in every
  // environment; scheduling/customer-rain-rank.js reads it through
  // gateEnvValue() at call time. Kill switch: unset — today's order.
  customerRainRank: gateEnvValue('GATE_CUSTOMER_RAIN_RANK'),

  // Call booking rain flag (owner 2026-10-08): the call pipeline books the
  // time a person agreed with the caller, so there is nothing to rank. When
  // that fresh visit is outdoor work in a rain window (rain-fit.js: 60%+
  // from the start through 2 h after the end, next 3 dates), the office gets
  // one admin notification on the 'schedule' channel. Nothing is moved, no
  // customer is texted, no triage card is created. OFF in every environment;
  // call-booking-rain-flag.js reads it through gateEnvValue() at call time.
  // Kill switch: unset.
  callBookingRainFlag: gateEnvValue('GATE_CALL_BOOKING_RAIN_FLAG'),

  // Auto-dispatch rain pass (owner 2026-10-08): the 04:10 run never moves a
  // visit inside 72 hours and the hourly rain forecast is good for 3 dates,
  // so the run cannot see rain. This pass reads the booked visits on those 3
  // dates every hour of the working day; an outdoor visit whose hourly chance reaches 70% from
  // its start through 2 h after its end gets one admin notification on the
  // 'schedule' channel, naming a dry open hour on the same date when there
  // is one. Nothing is moved and no customer is texted. OFF in every
  // environment; auto-dispatch/rain-pass.js reads it through gateEnvValue()
  // at call time. Kill switch: unset.
  autoDispatchRainPass: gateEnvValue('GATE_AUTO_DISPATCH_RAIN_PASS'),

  // Auto-dispatch conflict moves (owner 2026-10-09, "it should be moving
  // appointments that overlap"): a recurring visit whose arrival span
  // overlaps another customer's stop on its date, or that sits on an owner
  // blackout day, moves to the best legal slot in the 04:10 run without the
  // score bar or the drive floor (a free hour on the same day first for an
  // overlap). Every other guard still applies: the 73-hour and reminder
  // freeze, person-placed, customer-confirmed, the flex window, preferences.
  // OFF in every environment; auto-dispatch/config.js reads it through
  // gateEnvValue() at call time (config.conflictMovesEnabled). Kill switch:
  // unset.
  autoDispatchConflictMoves: gateEnvValue('GATE_AUTO_DISPATCH_CONFLICT_MOVES'),

  // Auto-dispatch road check (owner 2026-10-09, "drive time yes"): the 04:10
  // run scores slots on a straight-line drive model. On, an ordinary move's
  // drive saving is measured again on Google's traffic-aware route matrix
  // (the three legs around the visit, on the day it has and the day it would
  // take) and a move that saves under the drive floor on real roads does not
  // happen. It can only stop a move; a leg Google does not answer keeps the
  // model's number. OFF in every environment; auto-dispatch/config.js reads
  // it through gateEnvValue() at call time (config.roadCheckEnabled). Kill
  // switch: unset.
  autoDispatchRoadCheck: gateEnvValue('GATE_AUTO_DISPATCH_ROAD_CHECK'),

  // Auto-dispatch move proofreader (owner 2026-10-09 "proofreader yes";
  // 2026-10-12 "go with the better agent, and for moves it is unsure of
  // moving forward create admin notifications"). On, the 04:10 run in apply
  // mode asks one model (ROUTES.autoDispatchProofreader) about each move
  // right before it is written: the model reads the customer record and
  // answers allow / hold / unknown. Only an allow moves the visit, on the
  // slot the model read. An unknown raises one admin notice for the visit.
  // It can only stop a move and it sends the customer nothing. OFF in every
  // environment; auto-dispatch/config.js reads it through gateEnvValue() at
  // call time (config.proofreaderEnabled). Kill switch: unset.
  autoDispatchProofreader: gateEnvValue('GATE_AUTO_DISPATCH_PROOFREADER'),

  // Auto-dispatch arrival search (owner 2026-10-24 "build"): the 04:10 run
  // searches for a better hour with find-time's arrival-window engine (each
  // stop reached inside its 2-hour promise) instead of fixed one-hour blocks
  // with drive time on both sides, which read a day of 4-5 stops as full.
  // Only the night tool asks for it; every booking surface keeps today's
  // search and GATE_SCHEDULING_CAPACITY stays as it is. 'shadow' records,
  // per visit, what the arrival search would do and moves nothing; 'true'
  // moves on it. Needs GATE_AUTO_DISPATCH_SHARED_MODEL. Any other value is
  // off; auto-dispatch/config.js reads autoDispatchArrivalSearchMode() at
  // call time (config.arrivalSearch). Kill switch: unset.
  autoDispatchArrivalSearch: ['shadow', 'true'].includes(String(process.env.GATE_AUTO_DISPATCH_ARRIVAL_SEARCH || '').trim().toLowerCase()),

  // Auto-dispatch day rules (owner 2026-10-24: "dont skip sundays", "think
  // sundays should be a last resort", "yes build the 7:30 depature, and make
  // this ediatble in the admin portal"). On, the 04:10 run also searches
  // Sundays: a Sunday slot is taken only when no Monday-Saturday slot
  // qualifies, at most AUTO_DISPATCH_MAX_SUNDAY_MOVES_PER_RUN (2) a run, and
  // never for a plan that skips weekends. The van leaves at the Settings →
  // Scheduling departure time (default 07:30; scheduling/departure-time.js)
  // in the night tool's arrival search, the 04:20 route pass and the day
  // reports; no visit starts before its window opens. The staff time strip
  // stops calling Sunday closed. Booking pages do not change. OFF in every
  // environment; read at call time through autoDispatchDayRulesLive(). Kill
  // switch: unset.
  autoDispatchDayRules: gateEnvValue('GATE_AUTO_DISPATCH_DAY_RULES'),

  // Auto-dispatch keeps each visit on its own technician (owner 2026-10-25,
  // second technician starts early 2027). On, the 04:10 run offers a visit
  // that has a technician only that technician's slots, and the write
  // refuses a technician change. Unassigned visits are unchanged. Ships
  // DARK: exactly 'true'. Registered for logGateStatus only; the run reads
  // autoDispatchKeepTechLive() at call time (config.keepTech). Kill switch:
  // unset - the run may move a visit to another technician, as before.
  autoDispatchKeepTech: process.env.GATE_AUTO_DISPATCH_KEEP_TECH === 'true',

  // 5:00 AM auto-dispatch catch-up (owner 2026-10-26, "build A"). On, a second
  // run of the night tool starts at 05:00 ET when a deploy cut off the 04:10
  // run. Ships DARK: exactly 'true'. Registered for logGateStatus only; the
  // 05:00 job reads autoDispatchCatchUpLive() at call time. Kill switch:
  // unset - the 05:00 job returns at once, with no database read.
  autoDispatchCatchUp: process.env.GATE_AUTO_DISPATCH_CATCH_UP === 'true',

  // Combo route check (owner 2026-10-03): a visit shared by two or more
  // services answers `route_unverified` on every arrival check, because
  // certifying one half alone under-counts the work at the stop. On, a
  // caller that moves the WHOLE visit (`unit: true` on
  // loadArrivalRouteContext) gets it placed as one stop with the members'
  // summed work. OFF in every environment; arrival-route.js reads it through
  // gateEnvValue() at call time (comboRouteCheckLive). Kill switch: unset —
  // `unit` is ignored and a combo is unverified exactly as today. This entry
  // is for logGateStatus only.
  comboRouteCheck: gateEnvValue('GATE_COMBO_ROUTE_CHECK'),

  // Staff existing-visit picker + save checks use complete-route arrival
  // simulation within the existing two-hour customer promises. Advisory;
  // never changes neighbours' promises or sends notifications. Call-time
  // kill switch in scheduling/arrival-route.js; off in every environment.
  adminArrivalWindows: gateEnvValue('GATE_ADMIN_ARRIVAL_WINDOWS'),
  // Staff route insertion (owner 2026-10-25, "go" + "save order"): with
  // capacity mode off, a staff check of a MOVED visit (another day,
  // technician or start) tries it at every place in the technician's stored
  // order instead of after the last numbered stop, keeps every later stop 15
  // minutes inside its arrival window, and the staff save numbers that day in
  // the certified order. Never changes a customer's time or sends a message.
  // Dark in every environment; scheduling/arrival-route.js reads it through
  // gateEnvValue() at call time. Kill switch: unset. This entry is for
  // logGateStatus only.
  staffRouteInsertion: gateEnvValue('GATE_STAFF_ROUTE_INSERTION'),
  // Shared 08:00–18:00 capacity, catalog durations and complete-route booking.
  // Dark in every environment; callers read at operation time. Owner activation.
  schedulingCapacity: gateEnvValue('GATE_SCHEDULING_CAPACITY'),

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

  // Pest Report V2 "expectations" blocks (owner-approved 2026-09-27): rain +
  // treatment, spiders (#1 callback), and a short "what to expect" list keyed
  // to product class. OFF everywhere until Adam flips it (exact 'true' —
  // read directly, not through gateEnvValue's looser '1'/'on' parse, by
  // pestReportExpectationsGateOn() in pest-report-expectations.js). Kill
  // switch: unset GATE_PEST_REPORT_EXPECTATIONS. This entry is the
  // status/log listing only.
  pestReportExpectations: process.env.GATE_PEST_REPORT_EXPECTATIONS === 'true',

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

  // Re-service report card (2026-10-01, PR D of the Fast Complete scope,
  // owner-approved card 2026-09-26): "You told us" (the customer's booking
  // words, frozen on the record at completion), a "What we did" summary and
  // the "Still seeing X? Tell us" button on a pest/lawn callback report.
  // Dark in every environment until Adam flips it (exact 'true'); it only does
  // anything while GATE_RESERVICE_REPORT_COPY is on (the card hangs off the
  // reserviceReport block). reservice-report-card.js reads the env at call
  // time so a flip needs no redeploy — cached PDFs re-render via the -rcd1
  // key component. This entry is the status/log listing. Kill switch: unset
  // the var — payload, page and PDF key return to today's bytes.
  reserviceReportCard: process.env.GATE_RESERVICE_REPORT_CARD === 'true',

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

  // Platform-wide IB discovery/execution. Dark until explicitly enabled;
  // existing confirmation and role gates remain mandatory on every request.
  ibPlatform: gateEnvValue('GATE_IB_PLATFORM'),

  // Intelligence Bar merge_customers (#4348): an irreversible admin customer
  // write, dark by default like every other new IB capability. Read at CALL
  // time in services/intelligence-bar/customer-lifecycle-tools.js
  // (mergeCustomersEnabled) — tool lists on both paths and the executor
  // itself; this entry is the status/log listing.
  ibMergeCustomers: gateEnvValue('GATE_IB_MERGE_CUSTOMERS'),

  // Intelligence Bar delete_duplicate_customer (owner ruling 2026-10-07).
  // Ships DARK. Read at CALL time via ibDeleteCustomerLive() — tool lists on
  // both paths and the executor; this entry is for logGateStatus only.
  ibDeleteCustomer: process.env.GATE_IB_DELETE_CUSTOMER === 'true',

  // Tips from your tech (scope + owner decisions 2026-09-01): the completion
  // screen's searchable tip picker (replacing the free-text Observations /
  // Recommendations boxes) and, in a later PR, the quoted note on the live
  // service report. OFF unless set ('1' / 'true' / 'on'), in dev AND prod — the
  // gate-off answer of GET /admin/dispatch/:serviceId/tech-tips is
  // { available: false } and the completion screen keeps today's textareas.
  // Kill switch: unset. Read at CALL time so a flip needs no redeploy.
  techTips: gateEnvValue('GATE_TECH_TIPS'),

  // Searchable service-report completion vocabulary plus dated recommendations
  // from the customer's previous three visits on the same service line. Dark
  // by default and independent of GATE_TECH_TIPS. The dispatch route reads the
  // env at request time through gateEnvValue so unsetting it is a live kill.
  serviceReportCompletionChoices: gateEnvValue('GATE_SERVICE_REPORT_COMPLETION_CHOICES'),

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

  // EXTERNAL JOB HEARTBEAT WATCH (owner 2026-10-28, "the sweep writes a
  // heartbeat, and the portal rings if no complete run lands by 07:00"): the
  // hourly cron (scheduler.js, 07:05-22:05 ET) reads the job_health row an
  // outside job (first: appt-sweep on the office Mac) writes at the end of
  // each run, and rings ONE admin bell per silence episode when no complete
  // run has landed today by the job's due time; the bell closes itself when
  // one does. Read at CALL time via gateEnvValue in
  // services/external-job-heartbeat-watch.js; this entry is for logGateStatus
  // only. Writes only admin notifications; sends nothing to a customer.
  // Dark. Kill switch: unset GATE_EXTERNAL_HEARTBEAT_WATCH.
  externalHeartbeatWatch: gateEnvValue('GATE_EXTERNAL_HEARTBEAT_WATCH'),
  // Intelligence Bar tool activity (2026-09-02): POST /query answers carry a
  // `toolActivity` list — one operator-facing line per tool call the exchange
  // ran (label, done / error / proposed, duration, round) — and the ⌘K
  // palette renders it above the answer so a confirmation card is read next
  // to what the bar actually checked. Labels only: never tool inputs, never
  // results, never the model's reasoning. OFF unless set, dev AND prod — off
  // = the response is byte-identical to today. Kill switch: unset. Read at
  // CALL time so a flip needs no redeploy.
  ibToolActivity: gateEnvValue('GATE_IB_TOOL_ACTIVITY'),
  // Intelligence Bar owner-direct mode (owner ruling 2026-10-01). When on,
  // the owner login (ibFullAccess) gets no target refusals, no confirmation
  // card on the internal edits listed in services/intelligence-bar/
  // owner-direct.js, and a short-reply prompt. Customer messages, money and
  // bulk changes keep their card; other logins and technicians are
  // unchanged. OFF unless set, dev AND prod. Kill switch: unset. Read at
  // CALL time (owner-direct.js ownerDirectLive) so a flip needs no redeploy;
  // this map entry is for logGateStatus only.
  ibOwnerDirect: gateEnvValue('GATE_IB_OWNER_DIRECT'),
  // Intelligence Bar target rules v2 (owner 2026-10-20). Ships DARK. This entry is for logGateStatus only: the bar reads
  // GATE_IB_TARGET_RULES_V2 at call time via ibTargetRulesV2Live().
  ibTargetRulesV2: process.env.GATE_IB_TARGET_RULES_V2 === 'true',
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

  // Per-tech Twilio lines (Field Team Program Phase 0 item 3,
  // config/twilio-numbers.js `fieldTech` + services/tech-line.js). ON: a text
  // to a tech line also lands as a tech-home card + push for the technician
  // holding it, a call rings that tech's cell before the office list, and the
  // customer card carries the line. OFF (unset is the kill switch, dev AND
  // prod): the registry reports the line as an unassigned office number —
  // nothing dropped, nothing tech-specific. Read at CALL time by the
  // registry; this entry is for logGateStatus.
  techLines: gateEnvValue('GATE_TECH_LINES'),

  // Customer location line (services/twilio.js deriveOutboundNumber →
  // config/locations.js resolveServiceLocation). ON: a customer whose city is
  // blank or unmapped gets the line of the office their ZIP, then geocode,
  // resolves to. OFF (unset is the kill switch, dev AND prod): city-only, so
  // those customers default to the Bradenton line. Mapped cities resolve the
  // same either way. Read at CALL time; this entry is for logGateStatus.
  smsLineAddressFallback: gateEnvValue('GATE_SMS_LINE_ADDRESS_FALLBACK'),

  // Customer home line (owner ruling 2026-10-02, "local line everywhere").
  // ON: deriveOutboundNumber picks a known customer's stored home line
  // (homeLineLocationId) ahead of any per-call office, and the daily sweep
  // (services/home-line.js) stamps it. OFF (unset is the kill switch):
  // byte-identical to before. Read at CALL time via homeLineLive(); this
  // entry is for logGateStatus.
  homeLine: process.env.GATE_HOME_LINE === 'true',

  // Tech open-visit nudge (owner ask 2026-09-28: "just do an afternoon
  // nudge, at 7 pm" — ~1/3 of visits a week sit open past their day because
  // nothing reminds the tech to tap Complete). ON: one 7 PM ET text
  // (services/tech-open-visit-nudge.js, scheduler.js daily cron) to each
  // assignable technician who still has a pending/confirmed/en_route/on_site
  // visit scheduled for today, at most once per technician per ET day. OFF
  // unless exactly 'true', dev AND prod; unset is the kill switch. The
  // service reads process.env directly (strict '==='), so a flip needs no
  // redeploy; this entry is for logGateStatus.
  techOpenVisitNudge: process.env.GATE_TECH_OPEN_VISIT_NUDGE === 'true',

  opsDigestsInApp: gateEnvValue('GATE_OPS_DIGESTS_IN_APP'),

  // Ops digest ingest — routes/ops-digest-ingest.js, POST /api/ops/digest.
  // The external Waves ops crons on the owner's Mac (~/waves-ops/ops-crons,
  // 35 read-only checks) post their FIX:/ACT: findings here so they
  // land as ops_digest bell rows (the Waves Ops lane in Agents → Activity)
  // instead of emails to contact@ (owner ask 2026-09-11). Machine auth via
  // the OPS_DIGEST_INGEST_TOKEN bearer; the route 404s while the token is
  // unset, 409s while GATE_OPS_DIGESTS_IN_APP / GATE_AGENT_ACTIVITY are off,
  // and the caller emails on any non-2xx. Kill switch: unset the token.
  // Presence-only here for logGateStatus; the route reads env at CALL time.
  opsDigestIngest: Boolean(process.env.OPS_DIGEST_INGEST_TOKEN),

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
  // EPA label application-rate review (Inventory → product). Default off;
  // needs GATE_LABEL_PIPELINE too. Stores approved label directions in
  // products_catalog.label_rate_review only; nothing reads them for a dose
  // yet. Request-time checks use gateEnvValue. Kill switch: unset.
  labelRateReview: gateEnvValue('GATE_LABEL_RATE_REVIEW'),

  closeoutMoneyCommsAlerts: gateEnvValue('GATE_CLOSEOUT_MONEY_COMMS_ALERTS'),
  // Staff source/version UI and APIs. Default off; every request rechecks.
  controlledStaffDocuments: gateEnvValue('GATE_CONTROLLED_STAFF_DOCUMENTS'),
  // Staff page "Hired" button + Resend link (owner 2026-10-25, D7). Default off;
  // reads at call time via hiredPacketLive(). Emails one staff member a
  // set-password link per click. Kill switch: unset.
  hiredPacket: gateEnvValue('GATE_HIRED_PACKET'),
  // Staff form prefill from the staff record (owner 2026-10-25). Default off; reads at
  // call time via staffDocPrefillLive(). Reads only; sends nothing.
  staffDocPrefill: gateEnvValue('GATE_STAFF_DOC_PREFILL'),
  // Review bonus goes to the technician on the review ask the customer acted on
  // (census M8). Default off; reads at call time via reviewBonusAskFirstLive().
  reviewBonusAskFirst: gateEnvValue('GATE_REVIEW_BONUS_ASK_FIRST'),
  // Leaderboard callbacks count against the technician whose visit they correct
  // (census M9). Default off; reads at call time via callbackSourceTechLive().
  callbackSourceTech: gateEnvValue('GATE_CALLBACK_SOURCE_TECH'),
  // A customer's text during their visit also reaches the visit's technician
  // (census M3). Default off; reads at call time via customerTextToVisitTechLive().
  customerTextToVisitTech: gateEnvValue('GATE_CUSTOMER_TEXT_TO_VISIT_TECH'),
  // Field Team Program rev 2b: evidence and simulation only; never payroll.
  fieldTeamProgram: gateEnvValue('GATE_FIELD_TEAM_PROGRAM'),
  // Auto lunch (owner 2026-10-25): paid hours drop the unpaid meal. A completed
  // break of 30+ minutes, or 30 minutes on a day over 6 hours unless the tech
  // taps "No lunch today". This entry is for logGateStatus; the services read
  // autoLunchLive() at CALL time. Ships DARK: exactly 'true' only. Sends nothing.
  autoLunch: process.env.GATE_AUTO_LUNCH === 'true',
  // Shift close review (census H8 + M7, owner 2026-10-25): a forced clock-out ends at the
  // last real activity and is flagged for an admin; the clock-out texts follow the 7 PM
  // nudge routing. This entry is for logGateStatus; the services read shiftCloseReviewLive()
  // at CALL time. Ships DARK: exactly 'true' only. Texts only the owner's own phone.
  shiftCloseReview: process.env.GATE_SHIFT_CLOSE_REVIEW === 'true',
  // Staff guards (census M12 + M6, owner 2026-10-25): an active technician's own phone is a staff
  // sender, and a technician's field tap no longer approves an unreviewed booking. This entry is for
  // logGateStatus; the services read techStaffGuardsLive() at CALL time. Ships DARK: exactly 'true' only.
  techStaffGuards: process.env.GATE_TECH_STAFF_GUARDS === 'true',
  // Tax package W-2 labor (census A8, owner 2026-10-25): the CPA package's time-tracking file keeps
  // non-W-2 technicians only, and w2-payroll.csv lists finalized pay checks. This entry is for
  // logGateStatus; the tax package route reads taxPackageW2LaborLive() at CALL time. Ships DARK:
  // exactly 'true' only.
  taxPackageW2Labor: process.env.GATE_TAX_PACKAGE_W2_LABOR === 'true',
  // P&L and Schedule C wages from pay runs (census M11, owner 2026-10-26): finalized pay checks supply
  // wages and employer payroll taxes; the bank payroll category is left out. This entry is for
  // logGateStatus; pnl-report.js and tax-return-engine.js read pnlPayRunWagesLive() at CALL time.
  // Ships DARK: exactly 'true' only.
  pnlPayRunWages: process.env.GATE_PNL_PAY_RUN_WAGES === 'true',
  // Payroll bank match (owner 2026-10-28, payroll item 8): the bank import ties a bank line to the paycheck or
  // payroll tax payment it paid. This entry is for logGateStatus; bank-import.js reads payrollBankMatchLive()
  // at CALL time. Ships DARK: exactly 'true' only.
  payrollBankMatch: process.env.GATE_PAYROLL_BANK_MATCH === 'true',
  // Tech cost rates (L11a, owner 2026-10-26): job costing charges a visit at its technician's cost card
  // (labor per worked hour, vehicle fixed per worked hour and per mile). This entry is for logGateStatus;
  // job-costing.js and admin-cost-cards.js read techCostRatesLive() at CALL time. Ships DARK: exactly
  // 'true' only.
  techCostRates: process.env.GATE_TECH_COST_RATES === 'true',
  // Job cost standard minutes (owner 2026-10-31): job costing books a standard number of on-site minutes per lawn and pest
  // visit, a standard drive cost per stop, and revenue from the visit's own sources. This entry is for logGateStatus;
  // job-costing.js reads jobCostStandardMinutesLive() at CALL time. Ships DARK: exactly 'true' only.
  jobCostStandardMinutes: process.env.GATE_JOB_COST_STANDARD_MINUTES === 'true',
  // Tech open time (L11b, owner 2026-10-26): the nightly re-cost after the trip link, the open time report and the
  // bridge row. This entry is for logGateStatus; job-cost-recost.js, open-time routes and admin-dashboard.js read
  // techOpenTimeLive() at CALL time. Ships DARK: exactly 'true' only. Needs GATE_TECH_COST_RATES.
  techOpenTime: process.env.GATE_TECH_OPEN_TIME === 'true',
  // Tech pay stubs (payroll item 7, owner 2026-10-28): a technician opens their own finalized pay stubs. This entry is for
  // logGateStatus; routes/tech-payroll.js reads techPayStubsLive() at CALL time. Ships DARK: exactly 'true' only.
  techPayStubs: process.env.GATE_TECH_PAY_STUBS === 'true',
  // Tech training dates (owner 2026-10-28): ID-card and training due dates on the Licenses tab and their daily admin reminders. This entry is for
  // logGateStatus; admin-compliance-v2.js and technician-training-reminders.js read techTrainingDatesLive() at CALL time. Ships DARK: exactly 'true' only.
  techTrainingDates: process.env.GATE_TECH_TRAINING_DATES === 'true',
  // Misting layout designer (step 1, owner 2026-10-26): the staff estimator's Design on map button. This
  // entry is for logGateStatus; admin-pricing-config reads mistingLayoutDesignerLive() at CALL time.
  // Ships DARK: exactly 'true' only.
  mistingLayoutDesigner: process.env.GATE_MISTING_LAYOUT_DESIGNER === 'true',
  // Consultation-link lane ("Book with Adam", scope doc
  // lead-inspection-link-scope.md): the /inspection/:token public page, the
  // buildLeadConsultationLink composer/admin builder, and the recurring-lead
  // new_lead email's booking block all read the same flag. Ships DARK: off
  // unless exactly 'true' — every one of those three surfaces stays inert
  // (route 404s, builder returns { url: null }, email placeholder renders
  // empty) until Adam flips it. This map entry is for logGateStatus only —
  // the canonical CALL-TIME reader is leadInspectionLinkLive() below, same
  // discountStackingLive() convention, so a flip needs no redeploy.
  leadInspectionLink: process.env.GATE_LEAD_INSPECTION_LINK === 'true',
  // "Tech out today": mark a technician absent for a date, redistribute
  // their stops onto another eligible tech at the same promised arrival
  // window, park the rest as ranked dispatch alerts. Sends no customer
  // communication. This entry is for logGateStatus only; consumers
  // (services/tech-out.js, routes/admin-tech-out.js) read gateEnvValue at
  // CALL time.
  techOutRedistribute: gateEnvValue('GATE_TECH_OUT_REDISTRIBUTE'),
  // Tech-out AUTO-MOVE (PR B, on top of the park-only foundation above):
  // takes one open tech_out_overflow alert and tries the canonical rebooker
  // (SmartRebooker.reschedule) at the SAME date + window before leaving it
  // parked for a human. Requires GATE_TECH_OUT_REDISTRIBUTE ON too (checked
  // together by techOutAutoMoveEnabled() in services/tech-out-auto-move.js —
  // the canonical CALL-TIME reader); this entry is for logGateStatus only.
  // Sends no customer communication (see that file's header).
  techOutAutoMove: gateEnvValue('GATE_TECH_OUT_AUTO_MOVE'),
  // Nightly recurring-series top-up: keeps every ongoing recurring plan
  // booked out to RECURRING_TOPUP_HORIZON_DAYS (default 365) instead of
  // relying solely on the completion-time auto-extend (which only fires when
  // a visit is COMPLETED, so a plan left on_site/unclosed can run dry — see
  // services/recurring-series-topup.js). **Ships DARK: off unless exactly
  // `true`** — the canonical CALL-TIME reader is recurringSeriesTopUpLive()
  // below, same discountStackingLive() convention, so a flip needs no
  // redeploy. Off, the nightly cron still runs a SHADOW pass (computes what
  // it would insert, inside a transaction it rolls back, and logs the count
  // only — no writes). This entry is for logGateStatus only.
  recurringSeriesTopUp: process.env.GATE_RECURRING_SERIES_TOPUP === 'true',
  // Commercial suite sizing (PR #4840): a commercial tenant in a
  // multi-tenant building is sized by the SUITE (state food-license seats,
  // else a type default) instead of the whole building, in the admin
  // estimate lookup and the estimator engine. **Ships DARK: off unless
  // exactly `true`**; canonical CALL-TIME reader commercialSuiteSizingLive().
  // Off = byte-identical to before (the building size flows through).
  commercialSuiteSizing: process.env.GATE_COMMERCIAL_SUITE_SIZING === 'true',
  // Condo unit folio (unit-scope ruling #8): a typed Apt/Unit in a stacked
  // condo building resolves the unit's OWN county roll row instead of
  // dropping to the address search. **Ships DARK: off unless exactly
  // `true`**; canonical CALL-TIME reader condoUnitFolioLive(). Off =
  // byte-identical to before.
  condoUnitFolio: process.env.GATE_CONDO_UNIT_FOLIO === 'true',
  // Post-cancel recurring-series reseed (owner ruling 2026-09-24): a
  // single-visit cancel inside a counted plan adds one visit back at the
  // END of the series (services/recurring-series-cancel-reseed.js →
  // routes/admin-schedule.js#reseedRecurringSeriesAfterCancel). Ships DARK:
  // off unless exactly 'true'. Read live per call by
  // cancelReseedsRecurringLive(); this entry is for logGateStatus only.
  cancelReseedsRecurring: process.env.GATE_CANCEL_RESEEDS_RECURRING === 'true',
  // Annual rate review (services/rate-review.js ranking + services/
  // rate-review-apply.js apply): monthly snapshot batch + ops email + admin
  // routes + the nightly apply of SENT notices. Ships DARK: off unless
  // exactly 'true'. Read live per call by rateReviewLive(); this entry is
  // for logGateStatus only. Off = both crons return before any query, the
  // admin routes answer 404, nothing is written, every customer keeps the
  // lower current rate. Kill = unset the var.
  rateReview: process.env.GATE_RATE_REVIEW === 'true',
  // In-term placement for that reseed (owner ruling 2026-09-30): the added
  // visit goes into the widest gap left in the plan year that lost one,
  // falling back to the series end only when no gap fits
  // (recurring-series-cancel-reseed.js#pickInTermReseedDate). Ships DARK;
  // read live per call by cancelReseedInTermLive(); logGateStatus only here.
  cancelReseedInTerm: process.env.GATE_CANCEL_RESEED_IN_TERM === 'true',
  // Public estimate-page consultation offer ("Want us to come look first?",
  // consultation-first lane, owner ruling 2026-09-23): the same
  // /inspection/:token self-booking link the recurring-lead email offers,
  // surfaced on the estimate view too for a strongly-linked recurring-intent
  // lead. Ships DARK: off unless exactly 'true', and requires
  // GATE_LEAD_INSPECTION_LINK on as well (the offer builder checks both).
  // This entry is for logGateStatus only — the canonical CALL-TIME reader is
  // estimateConsultationOfferLive() below, same leadInspectionLinkLive()
  // convention.
  estimateConsultationOffer: process.env.GATE_ESTIMATE_CONSULTATION_OFFER === 'true',
  // "Rather have us come look first?" consultation-offer LINK inside the
  // estimate.engage_gone_quiet follow-up EMAIL (owner ruling 2026-09-26,
  // decision 2 of the estimate-email consultation-offer lane) — a separate
  // gate from the estimate PAGE's own GATE_ESTIMATE_CONSULTATION_OFFER
  // above, since the two surfaces (a page a customer already opened vs an
  // automated send) ship independently. Ships DARK: off unless exactly
  // 'true', and requires GATE_LEAD_INSPECTION_LINK on as well (checked by
  // estimateConsultationLead, the same shared eligibility the page uses).
  // This entry is for logGateStatus only — the canonical CALL-TIME reader is
  // estimateEmailConsultationOfferLive() below, same convention.
  estimateEmailConsultationOffer: process.env.GATE_ESTIMATE_EMAIL_CONSULTATION_OFFER === 'true',
  // Auto-Dispatch shared route model + day clustering (owner-approved
  // 2026-09-26 dispatch-backlog item 3, incident: the 04:10 ET run scored a
  // visit's CURRENT placement with plain haversine while CANDIDATES went
  // through the arrival-route/planning-minutes simulation, then proposed
  // moves the rebooker's own hard window-overlap probe refused — 17 applied,
  // 72 SLOT_TAKEN failures). On: current and candidate placements score on
  // ONE model (calibrated drive + owner planning minutes, the moving visit
  // included), candidates are pre-filtered by the SAME window-overlap
  // predicate the rebooker's writer enforces so a proposed move is one the
  // writer will actually accept, and the density score term is replaced by a
  // same-day-area clustering term (same 10-point weight). **Ships DARK: off
  // unless exactly `true`/`1`/`on`**, canonical CALL-TIME reader
  // autoDispatchSharedModelLive() below — off is today's auto-dispatch
  // scoring/candidate/apply behavior, byte for byte. Kill switch: unset
  // GATE_AUTO_DISPATCH_SHARED_MODEL.
  autoDispatchSharedModel: gateEnvValue('GATE_AUTO_DISPATCH_SHARED_MODEL'),

  // FLEXIBLE-TIER day moves for existing recurring visits (owner-approved
  // 2026-09-25/26, capacity-picker-scope-20260925.md §11: "this is costing
  // us the most money"). Runs INSIDE the auto-dispatch pass, in place of the
  // ROUTE-TIERS days-out ladder (mutually exclusive — this gate wins if both
  // are somehow on): every Flexible-tier visit (a series' 2nd+ occurrence —
  // eligibility.js's existing recurring-child-only checks already exclude a
  // series' first visit and one-time/first-time customers, the Fixed tier)
  // may re-time SAME DAY or move up to ±5 days, clamped so it can never
  // cross the series' adjacent occurrence (COALESCE(
  // date_exception_cadence_date, scheduled_date) among the parent's
  // children — auto-dispatch/flex-tier.js's loadSeriesNeighbors), until 73
  // hours before the visit (tighter than route-tiers' own 72.25h reminder-
  // claimable band, so it fully covers it) — the 72-hour reminder itself
  // still carries the FINAL window (appointment-reminders.js reads the
  // synced row at send time; the scheduled_services_sync_reminder DB
  // trigger keeps it in lockstep with every scheduled_date/window_start
  // write, auto-dispatch's included). Still no customer comms — apply.js's
  // rebooker call is unchanged. **Ships DARK: off unless exactly
  // `1`/`true`/`on`**, read at CALL time via gateEnvValue (same rationale as
  // GATE_ROUTE_TIERS — it moves the dates auto-dispatch may write, so the
  // flip is a deliberate act in every environment, never an ambient dev
  // default). OFF = whatever GATE_ROUTE_TIERS/legacy-lock behavior applies,
  // byte for byte. Kill switch: unset GATE_AUTO_DISPATCH_FLEX_TIER.
  autoDispatchFlexTier: gateEnvValue('GATE_AUTO_DISPATCH_FLEX_TIER'),

  // Amazon "Delivered" email → auto-restock (server/services/purchase-receipts).
  // Ships DARK: off unless set (gateEnvValue), read at call time by both the
  // post-email-sync hook and the ~15-minute scheduler sweep — a flip needs no
  // redeploy. Also requires PURCHASE_RECEIPT_SINCE (an ISO timestamp WITH an
  // explicit offset, read by gateEnvTimestamp) set, independently of this
  // gate, or the lane does nothing (see sweep.js).
  purchaseReceiptRestock: gateEnvValue('GATE_PURCHASE_RECEIPT_RESTOCK'),
  // Fast Complete for pest re-services (PR C): the tech portal opens a
  // one-screen completion sheet for pest_re_service (free callback) visits
  // instead of the full ServiceRecapModal. Read once at load and mirrored
  // onto the schedule payload as `reserviceFastCompleteEnabled` per service
  // (server/routes/admin-schedule.js, same pattern as `inspectionCredit`
  // below) — so TechHomePage learns the gate state from the job payload it
  // already fetches, no new endpoint. **Ships DARK: off unless exactly
  // `true`.** Off = the tech portal routes pest re-services to
  // ServiceRecapModal exactly as before. Kill switch: unset
  // GATE_RESERVICE_FAST_COMPLETE.
  reserviceFastComplete: process.env.GATE_RESERVICE_FAST_COMPLETE === 'true',
  // Fast Complete customer text (dark follow-up to the gate above; scope
  // decision 5): with it on, the one-screen sheet asks the server for ONE fixed
  // re-service text (customerRecapMode 'reservice_fixed') instead of pinning
  // sendCompletionSms / requestReview / includePayLink to false. The server
  // builds the text from the saved address, areas and product targets/methods
  // (services/reservice-fixed-recap.js: never AI, never signed, no review ask
  // or pay link) and sends it through its normal consent-checked path; no
  // customer wording lives in the client. Rides the schedule payload per
  // service as `fastCompleteRecapEnabled` (server/routes/admin-schedule.js),
  // the same pattern as `reserviceFastCompleteEnabled`, and is honored
  // server-side only while BOTH gates are on and the visit is a pest
  // re-service. **Ships DARK: off unless exactly `true`.** Off = the sheet's
  // body is byte-identical to today's (three false flags, no customer text).
  // Kill switch: unset GATE_FAST_COMPLETE_RECAP.
  fastCompleteRecap: process.env.GATE_FAST_COMPLETE_RECAP === 'true',
  // Waves blog post on the service report (owner "ok go" 2026-10-01).
  // Ships DARK in every environment. This entry is for logGateStatus only:
  // admin-dispatch.js, complete-scheduled-service.js and report-data.js
  // read GATE_REPORT_BLOG_POST at call time via reportBlogPostLive().
  reportBlogPost: process.env.GATE_REPORT_BLOG_POST === 'true',
  // Service report Ask Waves AI answers (owner 2026-10-05). Ships DARK.
  // report-ask-ai.js reads GATE_REPORT_ASK_AI at call time via
  // reportAskAiLive(); this entry is for logGateStatus only.
  reportAskAi: process.env.GATE_REPORT_ASK_AI === 'true',
  // Service report plan + upcoming visits merged, per-visit Reschedule
  // (owner 2026-10-06). Ships DARK. report-data.js reads
  // GATE_REPORT_PLAN_RESCHEDULE at call time via reportPlanRescheduleLive();
  // this entry is for logGateStatus only.
  reportPlanReschedule: process.env.GATE_REPORT_PLAN_RESCHEDULE === 'true',
  // Lawn report clarity (owner 2026-10-08): amount-only watering when no sprinkler
  // setup is on file, and one lawn visit on a lawn report's plan card. Ships DARK.
  // Read at call time via lawnReportClarityLive(); this entry is for logGateStatus only.
  lawnReportClarity: process.env.GATE_LAWN_REPORT_CLARITY === 'true',
  // GATE_STANDARD_WORDING_PREVIEW — the office form shows the standard
  // wording a nothing-found report keeps; read at call time via
  // standardWordingPreviewLive().
  standardWordingPreview: process.env.GATE_STANDARD_WORDING_PREVIEW === 'true',
  // GATE_BLOG_SEARCH_SUGGEST — a search no post covers suggested as a new
  // post for the autonomous blog queue; read at call time via
  // blogSearchSuggestLive().
  blogSearchSuggest: process.env.GATE_BLOG_SEARCH_SUGGEST === 'true',

  // Inventory agent (server/services/purchase-receipts/inventory-agent.js):
  // an LLM-backed resolver for a purchase-receipt line the deterministic
  // classifier held as unmatched/needs_size/size_mismatch — every proposal
  // it makes is checked by deterministic code before anything is written
  // (see the module header). Ships DARK: off unless set (gateEnvValue),
  // read at call time by receipt-processor.js's hand-off and by the
  // scheduler's post-sweep run — a flip needs no redeploy. Gate off leaves
  // GATE_PURCHASE_RECEIPT_RESTOCK's behavior byte-for-byte unchanged: those
  // three statuses stay held for a person exactly as before this lane.
  inventoryAgent: gateEnvValue('GATE_INVENTORY_AGENT'),

  // Confirm-time whole-route capacity re-check for self-serve bookings
  // (owner-approved 2026-09-26 dispatch backlog). Under GATE_SCHEDULING_CAPACITY,
  // the OFFER (find-time.js's findCapacitySlots, packed from arrival-route.js's
  // whole-route arrival simulation) already certifies a slot against the
  // technician's complete route and owner planning minutes, but createSelfBooking's
  // commit-time re-check only re-ran the overlap predicate (findConflictingVisits) —
  // another booking landing on the same tech-day between offer and confirm (a
  // late arrival, a day pushed over capacity) could make the route infeasible
  // without ever overlapping this exact window, and the commit still succeeded.
  // This entry is for logGateStatus only — the canonical CALL-TIME reader is
  // bookCapacityCommitLive() below. **Ships DARK: off unless exactly `true`/`1`/`on`**;
  // requires GATE_SCHEDULING_CAPACITY on too (checked together at the call site).
  // Kill switch: unset GATE_BOOK_CAPACITY_COMMIT — createSelfBooking's commit
  // gate goes back to the overlap-only re-check, byte for byte.
  bookCapacityCommit: gateEnvValue('GATE_BOOK_CAPACITY_COMMIT'),

  // Self-serve arrival grace for ONLINE BOOKING (owner-approved 2026-09-29;
  // see the header doc line for GATE_BOOK_ARRIVAL_GRACE and the estimate
  // picker's SELF_SERVE_ARRIVAL_GRACE_MINUTES it reuses). Entry is for
  // logGateStatus only — the canonical CALL-TIME reader is
  // bookArrivalGraceLive() below. **Ships DARK.** Also requires
  // GATE_BOOK_CAPACITY_COMMIT + GATE_SCHEDULING_CAPACITY (the call sites
  // check bookInsertionOffersLive() too): grace is judged by the whole-route
  // arrival simulation, which only exists under capacity mode, and the
  // commit needs createSelfBooking's verifyArrivalCapacity to enforce it.
  bookArrivalGrace: gateEnvValue('GATE_BOOK_ARRIVAL_GRACE'),

  // Tech-aware CONFIRM-side conflict checks for a second field technician
  // (owner-approved 2026-09-29). The offer side (booking.js's occupancy mirror)
  // already keeps only rows that are unassigned or on the slot's own technician
  // when GATE_SCHEDULING_CAPACITY is on; the confirm-side probes
  // (occupancy.js findConflictingVisits, /book's zone overlap check) were
  // tech-blind by design for the one-technician era, so a slot offered on
  // technician B's day was refused at confirm because technician A had an
  // overlapping or nearby stop. On (owner 2026-10-30: in hour mode too, no
  // longer needs capacity mode), the self-serve commits that pass a technicianId
  // scope their conflict rows to that technician plus unassigned rows, and the
  // /book and estimate offers scope the same way, so two technicians can book
  // the same hour. **Ships DARK: off unless exactly `true`/`1`/`on`**. This
  // entry is for logGateStatus only — the canonical CALL-TIME reader is
  // multiTechConfirmLive() below. Kill switch: unset GATE_MULTI_TECH_CONFIRM —
  // every confirm-side probe goes back to tech-blind, byte for byte.
  multiTechConfirm: gateEnvValue('GATE_MULTI_TECH_CONFIRM'),

  // Work days per technician (owner 2026-10-25). Ships DARK: exactly 'true'.
  // Registered for logGateStatus only; consumers read techWorkDaysLive() at
  // CALL time. Kill switch: unset - work_days is ignored everywhere.
  techWorkDays: process.env.GATE_TECH_WORK_DAYS === 'true',

  // Job type from the service catalog (owner 2026-10-25). Ships DARK: exactly 'true'.
  // Registered for logGateStatus only; consumers read techJobTypeChecksLive() at
  // CALL time. Kill switch: unset - capability checks classify by visit name only.
  techJobTypeChecks: process.env.GATE_TECH_JOB_TYPE_CHECKS === 'true',

  // Second technician census lows L1 + L3 (owner 2026-10-25). Ships DARK: exactly 'true'.
  // Registered for logGateStatus only; consumers read secondTechLowsLive() at
  // CALL time. Kill switch: unset - dashboard utilization and the IB name picks stay as before.
  secondTechLows: process.env.GATE_SECOND_TECH_LOWS === 'true',

  // Admin alert retention (owner 2026-10-26). Registered for logGateStatus only; the sweep reads
  // alertRetentionMode() at CALL time. 'shadow' records, 'true' expires. Kill switch: unset.
  alertRetention: ['shadow', 'true'].includes(String(process.env.GATE_ALERT_RETENTION || '').trim().toLowerCase()),

  // Admin alert catalog watch (owner 2026-10-29). Registered for logGateStatus only; NotificationService.create reads
  // alertCatalogMode() at CALL time. 'watch' records muted alerts, no refusal. Kill switch: unset.
  alertCatalog: String(process.env.GATE_ALERT_CATALOG || '').trim().toLowerCase() === 'watch',

  // Promise record evidence (owner 2026-10-29). Registered for logGateStatus only; consumers read
  // promiseRecordEvidenceMode() at CALL time. 'shadow' records, 'true' applies. Kill switch: unset.
  promiseRecordEvidence: ['shadow', 'true'].includes(String(process.env.GATE_PROMISE_RECORD_EVIDENCE || '').trim().toLowerCase()),

  // SMS courtesy tail (owner 2026-10-29). Registered for logGateStatus only; isCourtesyOnly and the
  // inbound webhook read courtesyTailMode() at CALL time. 'shadow' stamps, 'true' applies. Kill switch: unset.
  smsCourtesyTail: ['shadow', 'true'].includes(String(process.env.GATE_SMS_COURTESY_TAIL || '').trim().toLowerCase()),

  // Service-line map (owner 2026-10-25): 'shadow' records, 'live' (build 4) records and picks.
  // Registered for logGateStatus only; consumers read serviceLineMapMode() at CALL time. Kill switch: unset.
  serviceLineMapShadow: String(process.env.GATE_SERVICE_LINE_MAP || '').trim().toLowerCase() === 'shadow',
  serviceLineMapLive: String(process.env.GATE_SERVICE_LINE_MAP || '').trim().toLowerCase() === 'live',

  // Customer-contact admin alerts close themselves once a person answers (owner 2026-10-24,
  // approved 2026-10-26). Tri-state: 'shadow' records what would close, 'true' closes. Registered
  // for logGateStatus only; consumers read alertContactCloseMode() at CALL time. Kill switch: unset.
  alertContactClose: ['shadow', 'true'].includes(String(process.env.GATE_ALERT_CONTACT_CLOSE || '').trim().toLowerCase()),

  // A staff action answers a text (owner 2026-10-29, "Stuck Alert Fixes" F1). Tri-state; the alert
  // rule rides on GATE_ALERT_CONTACT_CLOSE, the Messages reader reads it alone. Registered for
  // logGateStatus only; consumers read staffActionAnswersMode() at CALL time. Kill switch: unset.
  smsStaffActionAnswers: ['shadow', 'true'].includes(String(process.env.GATE_SMS_STAFF_ACTION_ANSWERS || '').trim().toLowerCase()),

  // A voicemail bell closes once the customer's own visit ran later that day (owner 2026-10-29,
  // "Stuck Alert Fixes" F3). Tri-state; rides on GATE_ALERT_CONTACT_CLOSE. Registered for
  // logGateStatus only; consumers read voicemailVisitUnderwayMode() at CALL time. Kill switch: unset.
  voicemailVisitUnderway: ['shadow', 'true'].includes(String(process.env.GATE_VOICEMAIL_VISIT_UNDERWAY || '').trim().toLowerCase()),

  // A "lead_contacted" Leads bell closes once the lead was reached, booked or quoted (owner 2026-10-29,
  // "Stuck Alert Fixes" F5). Tri-state, its own gate. Registered for logGateStatus only; consumers
  // read leadContactedCloseMode() at CALL time. Kill switch: unset.
  leadContactedClose: ['shadow', 'true'].includes(String(process.env.GATE_LEAD_CONTACTED_CLOSE || '').trim().toLowerCase()),

  // A portal chat hand-off bell closes once a person answered that customer after it (owner 2026-10-31,
  // approved Portal inbox plan). Tri-state, own gate, rides on GATE_ALERT_CONTACT_CLOSE. Registered for
  // logGateStatus only; consumers read portalChatAnsweredCloseMode() at CALL time. Kill switch: unset.
  portalChatAnsweredClose: ['shadow', 'true'].includes(String(process.env.GATE_PORTAL_CHAT_ANSWERED_CLOSE || '').trim().toLowerCase()),

  // Unassigned-visit guard (owner 2026-10-25). Ships DARK: exactly 'true'. Registered for
  // logGateStatus only; consumers read unassignedVisitGuardLive() at CALL time. Kill switch: unset.
  unassignedVisitGuard: process.env.GATE_UNASSIGNED_VISIT_GUARD === 'true',

  // Territories by ZIP (owner 2026-10-30): the territory owner leads a pest / termite line in the
  // service-line map. Registered for logGateStatus only; consumers read territoryRoutingLive() at
  // CALL time. Kill switch: unset.
  territoryRouting: process.env.GATE_TERRITORY_ROUTING === 'true',
  // Territories by ZIP, build 3 (owner 2026-10-30): the Team tab's territory read-out. Registered for
  // logGateStatus only; consumers read territoryReadoutLive() at CALL time. Kill switch: unset.
  territoryReadout: process.env.GATE_TERRITORY_READOUT === 'true',

  // Territories by ZIP, build 7 (owner 2026-10-30): the night run gives an unassigned pest /
  // termite visit only to its ZIP's territory technician. Registered for logGateStatus only;
  // consumers read territoryNightRunLive() at CALL time. Kill switch: unset.
  territoryNightRun: process.env.GATE_TERRITORY_NIGHT_RUN === 'true',

  // Anonymous, cookie-free blog read-depth beacon (owner-approved 2026-09-27,
  // "E2: cookie-free read-depth counts"). Ships DARK: off unless exactly
  // 'true'. The route reads this via isEnabled('blogReadDepth') at request
  // time — same convention as payerStatements/lawnAssessmentMagnet above —
  // so the dark 404 is checked on every request, before the route's own
  // rate limiter (see server/routes/public-blog-read-depth.js).
  blogReadDepth: process.env.GATE_BLOG_READ_DEPTH === 'true',

  // Invoice follow-up ladder through Day 90 (dunning unification, owner
  // rulings 2026-09-27). Ships DARK: off unless exactly 'true'. This entry is
  // for logGateStatus only: services/invoice-followups.js reads
  // GATE_DUNNING_LADDER_90 at call time.
  dunningLadder90: process.env.GATE_DUNNING_LADDER_90 === 'true',

  // Pest Insider monthly proof-approval (email division fact register lane).
  // Ships DARK: off unless exactly 'true'. The monthly autopilot that sent
  // the proof (pest-insider-autopilot.js) was deleted as unused after #7191;
  // the gate still decides whether a Pest Insider proof can be approved
  // (newsletter-proof.js) or dispatched (newsletter-sender.js). This entry
  // is for logGateStatus only; pestInsiderProofLive() reads
  // GATE_PEST_INSIDER_PROOF at call time. Kill = unset: a Pest Insider
  // proof cannot be approved or dispatched.
  pestInsiderProof: process.env.GATE_PEST_INSIDER_PROOF === 'true',

  // Weekly newsletter sends itself after its checks (owner 2026-10-30,
  // option A). Ships DARK: off unless exactly 'true'. This entry is for
  // logGateStatus only; newsletterAutoSendLive() is read at call time by
  // services/newsletter-proof.js, newsletter-sunset.js and the History stop
  // route. Kill = unset: the issue waits for an APPROVED reply again.
  newsletterAutoSend: process.env.GATE_NEWSLETTER_AUTO_SEND === 'true',
  // Seven-day overdue-reminder spacing rule, SHADOW ONLY (dunning
  // unification PR 1, re-sequenced narrow 2026-09-28 — see #5108's wide
  // version for what this deliberately leaves out). Ships DARK: off unless
  // exactly 'true'. This entry is for logGateStatus only:
  // services/collections/contact-policy.js reads GATE_DUNNING_SPACING_SHADOW
  // at call time and only LOGS what the rule would have held — it never
  // holds, denies, or changes a send.
  dunningSpacingShadow: process.env.GATE_DUNNING_SPACING_SHADOW === 'true',

  // Orphan-invoice adoption sweep (dunning unification, PR 3b): invoices sent
  // outside the direct-send path never got an invoice_followup_sequences row.
  // Ships DARK: off unless exactly 'true'. The sweep never adopts an invoice
  // the retired legacy checker ever contacted. This
  // entry is for logGateStatus only: services/invoice-followups.js reads
  // GATE_DUNNING_ADOPT_ORPHANS at call time inside runPending().
  dunningAdoptOrphans: process.env.GATE_DUNNING_ADOPT_ORPHANS === 'true',

  // Pre-visit balance reminder window widens from 3 to 5 days before the
  // visit (dunning unification, owner ruling 2026-09-27, decision 6) — ahead
  // of the 72-hour appointment reminder. Ships DARK: off unless exactly
  // 'true'. This entry is for logGateStatus only:
  // services/previsit-balance-reminder.js's leadDays() reads
  // GATE_PREVISIT_BALANCE_5DAY at call time.
  previsitBalance5Day: process.env.GATE_PREVISIT_BALANCE_5DAY === 'true',

  // /book "Can't find a time?" block (owner 2026-09-29): a text-our-team link
  // plus a preferred day/time request form that files an internal lead + one
  // admin bell. Ships DARK in every environment; sends nothing to a customer.
  // This entry is for logGateStatus only: the route and GET /booking/config
  // read GATE_BOOK_PREFERRED_TIME at call time via bookPreferredTimeLive().
  bookPreferredTime: process.env.GATE_BOOK_PREFERRED_TIME === 'true',

  // Lawn watering text (owner 2026-09-30): a separate SMS after the lawn
  // completion text carrying the frozen watering instruction. Ships DARK in
  // every environment. This entry is for logGateStatus only:
  // complete-scheduled-service.js reads GATE_LAWN_WATERING_SMS at call time
  // via lawnWateringSmsLive().
  lawnWateringSms: process.env.GATE_LAWN_WATERING_SMS === 'true',

  // Lawn watering text for every product combination (owner 2026-10-22).
  // Ships DARK. This entry is for logGateStatus only: report-data.js and
  // lawn-watering-sms.js read GATE_LAWN_WATERING_EVERY_VISIT at call time via
  // lawnWateringEveryVisitLive().
  lawnWateringEveryVisit: process.env.GATE_LAWN_WATERING_EVERY_VISIT === 'true',

  // Tree & Shrub Fast Complete (owner 2026-10-01): the one-screen completion
  // sheet's server half. Ships DARK in every environment. This entry is for
  // logGateStatus only: admin-dispatch.js and admin-schedule.js read
  // GATE_TS_FAST_COMPLETE at call time via tsFastCompleteLive().
  tsFastComplete: process.env.GATE_TS_FAST_COMPLETE === 'true',

  // Fast Complete report flow (owner "ok go" 2026-10-01): pest re-services
  // and regular untyped pest visits complete on the one-screen sheet with the
  // AI report read before it goes. Ships DARK in every environment. This
  // entry is for logGateStatus only: admin-schedule.js and admin-dispatch.js
  // read GATE_FAST_COMPLETE_REPORT at call time via fastCompleteReportLive().
  fastCompleteReport: process.env.GATE_FAST_COMPLETE_REPORT === 'true',

  // Tree & Shrub tech findings in customer copy (owner 2026-10-02). Ships DARK
  // in every environment. This entry is for logGateStatus only: the completion
  // freeze, the T&S report builders and the report-writer prompt read
  // GATE_TS_TECH_FINDINGS_COPY at call time via tsTechFindingsCopyLive().
  tsTechFindingsCopy: process.env.GATE_TS_TECH_FINDINGS_COPY === 'true',

  // Tree & Shrub seasonal watch list (owner DRAFT 2026-10-01). Ships DARK in
  // every environment. This entry is for logGateStatus only: the photo read,
  // the fast-context answer and the completion freeze read GATE_TS_WATCH_LIST
  // at call time via tsWatchListLive().
  tsWatchList: process.env.GATE_TS_WATCH_LIST === 'true',
  // Tree & Shrub program overview (owner 2026-10-26). Boot-log entry only: the outline routes, the composer's
  // Estimates entry and tree-shrub-service-outline.js read GATE_TS_OUTLINE at call time via tsOutlineLive().
  tsOutline: process.env.GATE_TS_OUTLINE === 'true',
  // Pest Control program overview (owner 2026-10-26). Boot-log entry only: the outline routes, the composer's
  // Estimates entry and pest-service-outline.js read GATE_PEST_OUTLINE at call time via pestOutlineLive().
  pestOutline: process.env.GATE_PEST_OUTLINE === 'true',
  // Mosquito program overview (owner 2026-10-26). Boot-log entry only: the outline routes, the composer's
  // Estimates entry and mosquito-service-outline.js read GATE_MOSQUITO_OUTLINE at call time via mosquitoOutlineLive().
  mosquitoOutline: process.env.GATE_MOSQUITO_OUTLINE === 'true',
  // Tree & Shrub lighting-aware color (owner 2026-10-23). Boot-log entry only:
  // every caller reads GATE_TS_LIGHTING at call time via tsLightingLive().
  tsLighting: process.env.GATE_TS_LIGHTING === 'true',

  // Tree & Shrub live-insect check (owner 2026-10-05). Ships DARK in every
  // environment. This entry is for logGateStatus only: the fast-context answer
  // and the completion freeze read GATE_TS_PEST_CHECK at call time via
  // tsPestCheckLive().
  tsPestCheck: process.env.GATE_TS_PEST_CHECK === 'true',

  // Tree & Shrub yearly neonicotinoid cap per property (owner 2026-10-09). Ships DARK in every
  // environment. This entry is for logGateStatus only: the fast-context answer reads
  // GATE_TS_NEONIC_CAP at call time via tsNeonicCapLive().
  tsNeonicCap: process.env.GATE_TS_NEONIC_CAP === 'true',

  // Tree & Shrub report "From your technician" paragraph (proposed 2026-10-05, owner go-ahead pending): one
  // model call at completion, frozen, printed on the T&S report. Ships DARK in
  // every environment. This entry is for logGateStatus only: the completion
  // step and the report build read GATE_TS_TECH_PARAGRAPH at call time via
  // tsTechParagraphLive().
  tsTechParagraph: process.env.GATE_TS_TECH_PARAGRAPH === 'true',
  // Lawn re-service Fast Complete (owner 2026-10-01): the one-screen completion
  // sheet for the free between-visit lawn callback (lawn_re_service). Ships DARK
  // in every environment. This entry is for logGateStatus only: admin-dispatch.js
  // and admin-schedule.js read GATE_LAWN_RESERVICE_FAST_COMPLETE at call time via
  // lawnReserviceFastCompleteLive().
  lawnReserviceFastComplete: process.env.GATE_LAWN_RESERVICE_FAST_COMPLETE === 'true',
  // Lawn Fast Complete (lawn report rebuild, PR-C1): the one-screen completion
  // sheet for a regular recurring lawn program visit. Ships DARK in every
  // environment. This entry is for logGateStatus only: admin-dispatch.js,
  // admin-schedule.js and complete-scheduled-service.js read GATE_LAWN_FAST_COMPLETE
  // at call time via lawnFastCompleteLive().
  lawnFastComplete: process.env.GATE_LAWN_FAST_COMPLETE === 'true',
  // GATE_NOTE_BOX_PHOTOS — photos in the notes box; read through
  // noteBoxPhotosLive().
  noteBoxPhotos: process.env.GATE_NOTE_BOX_PHOTOS === 'true',
  // GATE_LANE_VOICE_FILL — a specialty visit's record filled from the note;
  // read through laneVoiceFillLive().
  laneVoiceFill: process.env.GATE_LANE_VOICE_FILL === 'true',
  // GATE_TYPED_VOICE_FILL — a typed visit's findings filled from the note;
  // read through typedVoiceFillLive().
  typedVoiceFill: process.env.GATE_TYPED_VOICE_FILL === 'true',

  // Fast Complete voice fill (owner 2026-10-02, D1-D3 approved): the server half
  // of "tell me what you did" on the Fast Complete sheets, pest re-service
  // first. Ships DARK in every environment. This entry is for logGateStatus
  // only: admin-dispatch.js reads GATE_FAST_COMPLETE_VOICE_FILL at call time via
  // fastCompleteVoiceFillLive().
  fastCompleteVoiceFill: process.env.GATE_FAST_COMPLETE_VOICE_FILL === 'true',
  // GATE_FAST_COMPLETE_INVOICED_VISITS — admin Dispatch opens a visit already
  // invoiced or returning from the payment flow in its Fast Complete sheet,
  // which then posts the full form's own invoiceAlreadySent field. Read through
  // fastCompleteInvoicedVisitsLive().
  fastCompleteInvoicedVisits: process.env.GATE_FAST_COMPLETE_INVOICED_VISITS === 'true',

  // Plant/tree/shrub/palm photo ID referee (owner ruling 2026-09-28): a
  // still-unsure scope after the Gemini -> OpenAI Sol escalation gets one
  // more look from Claude Fable 5.1. Ships DARK: off unless exactly 'true'.
  // This entry is for logGateStatus only: plant-engine.js's runReferee()
  // reads GATE_PLANT_ID_REFEREE at call time via plantIdRefereeLive().
  plantIdReferee: process.env.GATE_PLANT_ID_REFEREE === 'true',
  // Lawn visit assessment name referee (owner ruling 2026-09-29): this entry
  // is for logGateStatus only; lawn-visit-assessment.js reads
  // GATE_LAWN_ASSESSMENT_REFEREE at call time via lawnAssessmentRefereeLive().
  lawnAssessmentReferee: process.env.GATE_LAWN_ASSESSMENT_REFEREE === 'true',

  // Billing email details (owner-approved 2026-09-29 audit of email_messages):
  // the invoice / receipt / payment-failed / estimate follow-up emails carry
  // the service, service date, payment method, full street address, card
  // label, attempt date and the retry date the ladder armed. Ships DARK:
  // off unless exactly 'true'. This entry is for logGateStatus only: every
  // sender reads GATE_BILLING_EMAIL_DETAILS at call time via
  // billingEmailDetailsLive().
  billingEmailDetails: process.env.GATE_BILLING_EMAIL_DETAILS === 'true',

  // Call-address on-file assist (owner-approved review items 3 and 4,
  // 2026-09-30): the caller's on-file address rescues a spoken one when the
  // HOUSE NUMBER matches — the on-file street joins street recovery as an
  // extra candidate (a misheard street), and the on-file city + ZIP join a
  // street-only lookup (Google resolving "7417 Monteverdi" to New Jersey).
  // Also reads a non-FL result on a street-only request as missing_component,
  // not out_of_service_area. Ships DARK: off unless exactly 'true'. This entry
  // is for logGateStatus only: services/address-validation/onfile-assist.js
  // reads GATE_CALL_ADDRESS_ONFILE_ASSIST at call time via
  // callAddressOnFileAssistLive().
  callAddressOnFileAssist: process.env.GATE_CALL_ADDRESS_ONFILE_ASSIST === 'true',
  // Call-address route-spelling retry. A caller who says a numbered state, US
  // or county route with the direction FIRST ("14360 East State Road 64")
  // can get a Google verdict for a different premise, and street recovery
  // then gives up on a long candidate list. On, recovery first asks Google
  // once more with the route in its canonical order ("14360 SR 64 E") and
  // adopts that single verdict when it confirms the spoken house number on
  // the same route (read-back card, as for any recovered street). Ships
  // DARK: off unless exactly 'true'. This entry is for logGateStatus only:
  // services/address-validation/recovery.js reads
  // GATE_CALL_ROUTE_SPELLING_RETRY at call time via
  // callRouteSpellingRetryLive().
  callRouteSpellingRetry: process.env.GATE_CALL_ROUTE_SPELLING_RETRY === 'true',

  // Lawn report watering instruction (lawn report rebuild P2): the frozen
  // per-product watering rules drive the aftercare writer, the banner payload
  // and the weekly-plan not-before overlay. Ships DARK. This entry is for
  // logGateStatus only: report-data.js reads GATE_LAWN_WATERING_RULE at call
  // time via lawnWateringRuleLive().
  lawnWateringRule: gateEnvValue('GATE_LAWN_WATERING_RULE'),

  // Lawn watering banner forecast + observed-rain close-out (lawn report
  // rebuild P30). Ships DARK. This entry is for logGateStatus only: the write
  // gate and report-data.js read GATE_LAWN_WATERING_FORECAST at call time via
  // lawnWateringForecastLive().
  lawnWateringForecast: gateEnvValue('GATE_LAWN_WATERING_FORECAST'),

  // Lawn watering forecast from two sources, in the watering text (owner
  // 2026-10-22). Ships DARK. This entry is for logGateStatus only: the write
  // gate and lawn-watering-sms.js read GATE_LAWN_WATERING_TEXT_FORECAST at call
  // time via lawnWateringTextForecastLive().
  lawnWateringTextForecast: gateEnvValue('GATE_LAWN_WATERING_TEXT_FORECAST'),

  // Short lawn watering text (owner 2026-10-23). Ships DARK. This entry is for
  // logGateStatus only: lawn-watering-sms.js reads GATE_LAWN_WATERING_SHORT_TEXT
  // at call time via lawnWateringShortTextLive().
  lawnWateringShortText: gateEnvValue('GATE_LAWN_WATERING_SHORT_TEXT'),

  // Warranty FDACS-13692 consumer notice check (owner 2026-10-24). Ships DARK.
  // This entry is for logGateStatus only: new-construction-warranty.js and
  // admin-consumer-notices.js read GATE_WARRANTY_13692_CHECK at call time via
  // warranty13692CheckLive().
  warranty13692Check: gateEnvValue('GATE_WARRANTY_13692_CHECK'),

  // Mark accepted sends the FDACS-13692 consumer notice (owner 2026-10-26). Ships DARK.
  // This entry is for logGateStatus only: estimate-consumer-notice.js reads
  // GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_SEND at call time via manualAcceptConsumerNoticeSendLive().
  manualAcceptConsumerNoticeSend: gateEnvValue('GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_SEND'),

  // Daily catch-up for that send. Ships DARK. This entry is for logGateStatus only: estimate-consumer-notice.js reads
  // GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_RECONCILE at call time via manualAcceptConsumerNoticeReconcileLive().
  manualAcceptConsumerNoticeReconcile: gateEnvValue('GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_RECONCILE'),

  // Estimate consumer notice (owner 2026-10-25). Ships DARK. This entry is for
  // logGateStatus only: estimate-public.js and estimate-consumer-notice.js read
  // GATE_ESTIMATE_CONSUMER_NOTICE at call time via estimateConsumerNoticeLive().
  estimateConsumerNotice: gateEnvValue('GATE_ESTIMATE_CONSUMER_NOTICE'),

  // Residential service agreement on the accepted estimate page. Ships DARK. This
  // entry is for logGateStatus only: estimate-public.js and
  // estimate-service-agreement.js read GATE_ESTIMATE_SERVICE_AGREEMENT at call
  // time via estimateServiceAgreementLive().
  estimateServiceAgreement: gateEnvValue('GATE_ESTIMATE_SERVICE_AGREEMENT'),

  // Commercial agreement renewal reminder. Ships DARK. This entry is for
  // logGateStatus only: warranty-renewal-reminder.js reads
  // GATE_AGREEMENT_RENEWAL_REMINDER at call time via agreementRenewalReminderLive().
  agreementRenewalReminder: gateEnvValue('GATE_AGREEMENT_RENEWAL_REMINDER'),

  // Prepaid-year-end office bell. Ships DARK. This entry is for logGateStatus
  // only: prepay-year-end-bell.js reads GATE_PREPAY_YEAR_END_BELL at call time
  // via prepayYearEndBellLive().
  prepayYearEndBell: gateEnvValue('GATE_PREPAY_YEAR_END_BELL'),

  // Lawn report monthly program line (lawn report rebuild P9): snapshot.seasonalNote
  // becomes the month's lawn program v13 sentence (v13 visits only). Ships DARK. This
  // entry is for logGateStatus only: lawn-report-v2.js reads GATE_LAWN_EXPECTATIONS
  // at call time via lawnExpectationsLive().
  lawnExpectations: gateEnvValue('GATE_LAWN_EXPECTATIONS'),
  // GATE_LAWN_COVERAGE_HIDE_DEFAULT_ZONES (owner 2026-10-06): a lawn report whose
  // coverage zones were only the schematic defaults at completion (verdict frozen
  // then, structured_notes.lawnCoverageVerdict) shows no Lawn Coverage section.
  // Ships DARK. This entry is for logGateStatus only: report-data.js and the lawn
  // write gate read it at call time via lawnCoverageHideDefaultZonesLive().
  lawnCoverageHideDefaultZones: gateEnvValue('GATE_LAWN_COVERAGE_HIDE_DEFAULT_ZONES'),
  // GATE_LAWN_PROGRAM_DETAIL (owner 2026-10-06): under the v13 month sentence
  // (GATE_LAWN_EXPECTATIONS), the month's "Why now" line. Ships DARK. This entry is for logGateStatus only:
  // lawn-report-v2.js reads it at call time via lawnProgramDetailLive().
  lawnProgramDetail: process.env.GATE_LAWN_PROGRAM_DETAIL === 'true',

  // Lawn report treatment memory (lawn report rebuild P12): the per-assessment
  // frozen "what we applied / what we said we would watch" entry in
  // structured_notes.lawnVisitMemory and the reportV2.sinceLast payload built
  // from the prior visit's entry. Ships DARK. This entry is for logGateStatus
  // only: report-data.js reads GATE_LAWN_VISIT_MEMORY at call time via
  // lawnVisitMemoryLive().
  lawnVisitMemory: gateEnvValue('GATE_LAWN_VISIT_MEMORY'),

  // Lawn rainfast breach watch (lawn report rebuild P31): measured rain of at
  // least 0.25 inch inside a product's stated rainfast interval records one
  // retreat-check on the frozen visit memory and adds one fixed Watching
  // sentence on the live view. Ships DARK. Needs GATE_LAWN_VISIT_MEMORY. This
  // entry is for logGateStatus only: report-data.js reads GATE_LAWN_RAINFAST_WATCH
  // at call time via lawnRainfastWatchLive().
  lawnRainfastWatch: gateEnvValue('GATE_LAWN_RAINFAST_WATCH'),

  // Lawn paired-photo recheck (lawn report rebuild P19b, owner ruling 2026-09-29
  // round 3b): one model read of last visit's and today's SAME-SPOT overview
  // photos as pairs, written once onto the frozen visit memory's watched topics
  // (check.recheck, source 'photo_pair'). Ships DARK. Needs GATE_LAWN_VISIT_MEMORY
  // AND GATE_LAWN_PROPERTY_HISTORY too. This entry is for logGateStatus only: the
  // job reads GATE_LAWN_PAIRED_RECHECK at call time via lawnPairedRecheckLive().
  lawnPairedRecheck: gateEnvValue('GATE_LAWN_PAIRED_RECHECK'),

  // Prospect lawn report "why we think so" (fixed evidence copy per finding and
  // a photo-basis line on the public lawn-diagnostic payload). Ships DARK. This
  // entry is for logGateStatus only: the route reads
  // GATE_LAWN_DIAGNOSTIC_EVIDENCE at call time via lawnDiagnosticEvidenceLive().
  lawnDiagnosticEvidence: gateEnvValue('GATE_LAWN_DIAGNOSTIC_EVIDENCE'),
  // Lawn report "Since your last visit" block: the customer render of the
  // treatment memory and the progress engine, as reportV2.lead.sinceLast.
  // Ships DARK. This entry is for logGateStatus only: report-data.js reads
  // GATE_LAWN_SINCE_LAST at call time via lawnSinceLastLive().
  lawnSinceLast: gateEnvValue('GATE_LAWN_SINCE_LAST'),
  // Lawn visit photo shot list (lawn report rebuild P18): eight named shots, cap
  // 8, soft 4-photo minimum, zone-weighted legacy merge, front-first hero. Ships
  // DARK. This entry is for logGateStatus only: the lawn assessment route and
  // report-data.js read GATE_LAWN_SHOT_LIST at call time via gateEnvValue().
  lawnShotList: gateEnvValue('GATE_LAWN_SHOT_LIST'),
  // Lawn lighting-aware color (owner 2026-10-04): per-photo light read, no color
  // claim across different light, color never alone drives the overall direction.
  // Ships DARK. This entry is for logGateStatus only: the visit assessment, the
  // paired recheck, the progress engine's callers and the report writer's
  // prior-visit line read GATE_LAWN_LIGHTING at call time via lawnLightingLive().
  lawnLighting: process.env.GATE_LAWN_LIGHTING === 'true',
  // Lawn report "From your technician" paragraph (owner 2026-10-05): one model
  // call at completion, frozen, rendered under "What we applied today". Ships
  // DARK. This entry is for logGateStatus only: the completion gate and the
  // report build read GATE_LAWN_TECH_PARAGRAPH at call time via
  // lawnTechParagraphLive().
  lawnTechParagraph: gateEnvValue('GATE_LAWN_TECH_PARAGRAPH'),
  // Lawn report Visit Summary written from the visit's facts (PROTOTYPE ONLY,
  // GATE_LAWN_VISIT_SUMMARY_V2). Ships DARK. This entry is for logGateStatus
  // only: the completion gate and the report build read the variable at call
  // time via lawnVisitSummaryV2Live().
  lawnVisitSummaryV2: process.env.GATE_LAWN_VISIT_SUMMARY_V2 === 'true',
  // Lawn report copy fixes (owner 2026-10-08/09): six customer-copy defects on the
  // lawn report. Ships DARK. This entry is for logGateStatus only: the report
  // build, the completion freeze and the PDF key read GATE_LAWN_REPORT_COPY_FIXES
  // at call time via lawnReportCopyFixesLive().
  lawnReportCopyFixes: process.env.GATE_LAWN_REPORT_COPY_FIXES === 'true',
  // Lawn report layout (owner 2026-10-08/09): the web report reorder and trim. Ships
  // DARK. This entry is for logGateStatus only: the report payload reads
  // GATE_LAWN_REPORT_LAYOUT at call time via lawnReportLayoutLive().
  lawnReportLayout: process.env.GATE_LAWN_REPORT_LAYOUT === 'true',
  // Lawn report story order (owner 2026-10-23/24): a second order for the lawn web report layout. Ships
  // DARK. This entry is for logGateStatus only: the lawn layout payload reads GATE_LAWN_REPORT_STORY at
  // call time via lawnReportStoryLive().
  lawnReportStory: process.env.GATE_LAWN_REPORT_STORY === 'true',
  // Lawn report polish (owner 2026-10-09): the Water card's third state, one label line per
  // product card, the status card's keep-off line. Ships DARK. This entry is for logGateStatus
  // only: the report build and the completion freeze read GATE_LAWN_REPORT_POLISH at call time
  // via lawnReportPolishLive().
  lawnReportPolish: process.env.GATE_LAWN_REPORT_POLISH === 'true',
  // Lawn report stage 1 fixes (owner 2026-10-09): five small fixes to one real lawn report (damage finding names the
  // pest, a second "What to expect" line, no irrigation tip beside a schedule on file, the applied card not repeated,
  // no email or phone in the web hero). Ships DARK. This entry is for logGateStatus only: the report build, the
  // payload and the PDF key read GATE_LAWN_REPORT_STAGE1_FIXES at call time via lawnReportStage1FixesLive().
  lawnReportStage1Fixes: process.env.GATE_LAWN_REPORT_STAGE1_FIXES === 'true',
  // GATE_LAWN_WATER_RAIN (owner 2026-10-09): the lawn report's rain card. Ships DARK. This entry is for
  // logGateStatus only: the freeze and the report read it at call time via lawnWaterRainLive().
  lawnWaterRain: process.env.GATE_LAWN_WATER_RAIN === 'true',
  // GATE_LAWN_WATER_IN_RAIN (owner 2026-10-09): rain since the visit counts toward a water-in banner. Ships DARK. This entry is
  // for logGateStatus only: the report and the PDF key read it at call time via lawnWaterInRainLive().
  lawnWaterInRain: process.env.GATE_LAWN_WATER_IN_RAIN === 'true',
  // One sprinkler head rate table (owner 2026-10-09): the owner's 15 / 40 minutes per quarter inch for the Monday plan, the
  // weekly email, the schedule guard, the report's derived figure and the portal line. Ships DARK. This entry is for
  // logGateStatus only: every reader asks irrigationOwnerRatesLive() (server/services/irrigation-rates.js, which holds no heavy imports) at call time.
  irrigationOwnerRates: process.env.GATE_IRRIGATION_OWNER_RATES === 'true',
  // "Water you saved" gallons on the Monday irrigation plan (owner 2026-10-22). Ships DARK. This entry is for logGateStatus
  // only: the decision reads irrigationWaterSavedLive() (server/services/irrigation-water-saved.js) at call time.
  irrigationWaterSavings: process.env.GATE_IRRIGATION_WATER_SAVINGS === 'true',
  // Setup ask cadence (owner 2026-10-24). Listed for the boot log only: the sweep reads
  // irrigationSetupAskCadenceLive() (server/services/irrigation-weekly-email.js) at call time.
  irrigationSetupAskCadence: process.env.GATE_IRRIGATION_SETUP_ASK_CADENCE === 'true',
  // Phase 2 of the same (owner 2026-10-23 "ok go"): the dollar range beside the gallons for county-water customers. Ships
  // DARK. logGateStatus only: the block reads irrigationWaterDollarsLive() at decision time.
  irrigationWaterDollars: process.env.GATE_IRRIGATION_WATER_DOLLARS === 'true',
  // Lawn protocol v13 (owner 2026-10-05): one universal lawn program for every
  // grass, loaded beside the old program. Ships DARK: off unless exactly
  // 'true'. This entry is for logGateStatus only: every lawn recipe reader
  // (server/services/lawn-program.js) and the structured protocol lookup
  // (lawn-protocol-operating-layer.js) read GATE_LAWN_V13 at call time via
  // lawnV13Live(), so unsetting it is the kill switch (no redeploy).
  lawnV13: process.env.GATE_LAWN_V13 === 'true',
  // Bermuda removal add-on on lawn visits (owner 2026-10-06): a lawn the
  // customer's accepted estimate or staff marked "bermuda removal" gets a
  // Recognition + Fusilade II backpack spot step on the April and June visits
  // (St. Augustine and Zoysia only). Ships DARK: off unless exactly 'true'
  // (the 'on' / '1' spellings read off). Also counts the estimate add-on's
  // spray cost in the lawn margin (the estimate add-on stays St. Augustine
  // only). This entry is for
  // logGateStatus only: every reader calls lawnBermudaRemovalLive() at call
  // time, so unsetting the variable is the kill switch (no redeploy).
  lawnBermudaRemoval: process.env.GATE_LAWN_BERMUDA_REMOVAL === 'true',
  // Lawn Fast Complete weed-spot rules (owner 2026-10-08): one cap-aware Weed spots
  // entry, the surfactant left out at 90 F or hotter, and the technician's spot area.
  // Ships DARK. This entry is for logGateStatus only: lawn-fast-complete.js reads
  // GATE_LAWN_SPOT_RULES at call time via lawnSpotRulesLive().
  lawnSpotRules: process.env.GATE_LAWN_SPOT_RULES === 'true',
  // Lawn Fast Complete treatment guide (owner 2026-10-08): the "Suggested from this lawn" cards
  // after the assessment is confirmed. Ships DARK. This entry is for logGateStatus only:
  // lawn-fast-complete.js reads GATE_LAWN_TREATMENT_GUIDE at call time via
  // lawnTreatmentGuideLive() (which also needs the spot rules and the v13 program).
  lawnTreatmentGuide: process.env.GATE_LAWN_TREATMENT_GUIDE === 'true',
  // Lawn Fast Complete places and trouble areas (owner 2026-10-09): a place on every spot row, a
  // per-property trouble-area store, and the v13 yearly limits counted per place. Ships DARK. This
  // entry is for logGateStatus only: lawn-fast-complete.js, application-limits.js and the completion
  // read GATE_LAWN_TROUBLE_AREAS at call time via lawnTroubleAreasLive() (which also needs the spot
  // rules, the v13 program and the treatment guide).
  lawnTroubleAreas: process.env.GATE_LAWN_TROUBLE_AREAS === 'true',
  // Lawn Fast Complete spot target (owner 2026-10-09): a target on a spot fungicide / insecticide row. Ships DARK. This entry is for
  // logGateStatus only: lawn-spot-target.js reads GATE_LAWN_SPOT_TARGET at call time via lawnSpotTargetLive() (which also needs the guide).
  lawnSpotTarget: process.env.GATE_LAWN_SPOT_TARGET === 'true',
  // Lawn Fast Complete photo label (owner 2026-10-09). Ships DARK. This entry is for logGateStatus only: lawn-photo-shots.js callers read
  // GATE_LAWN_PHOTO_LABEL_PICK at call time via lawnPhotoLabelPickLive().
  lawnPhotoLabelPick: process.env.GATE_LAWN_PHOTO_LABEL_PICK === 'true',
  // Lawn service outline on the v13 program (owner 2026-10-22). This entry is for logGateStatus only: lawn-service-outline.js reads
  // GATE_LAWN_OUTLINE_V13 at call time via lawnOutlineV13Live() (which also needs GATE_LAWN_V13).
  lawnOutlineV13: process.env.GATE_LAWN_OUTLINE_V13 === 'true',
  // Detailed lawn service outline (owner 2026-10-26). This entry is for logGateStatus only: lawn-service-outline.js reads
  // GATE_LAWN_OUTLINE_DETAIL at call time via lawnOutlineDetailLive() (which also needs GATE_LAWN_OUTLINE_V13).
  lawnOutlineDetail: process.env.GATE_LAWN_OUTLINE_DETAIL === 'true',
  // New lawn outline layout (owner 2026-10-31). This entry is for logGateStatus only: lawn-service-outline.js reads
  // GATE_LAWN_OUTLINE_VISUAL at call time via lawnOutlineVisualLive() (which also needs GATE_LAWN_OUTLINE_DETAIL).
  lawnOutlineVisual: process.env.GATE_LAWN_OUTLINE_VISUAL === 'true',
  // Lawn v13 May Tetrino chinch rate (owner 2026-10-22). This entry is for logGateStatus only: waveguard-plan-engine.js reads
  // GATE_LAWN_CHINCH_TETRINO_RATE at call time via lawnChinchTetrinoRateLive() (which also needs GATE_LAWN_TROUBLE_AREAS).
  lawnChinchTetrinoRate: process.env.GATE_LAWN_CHINCH_TETRINO_RATE === 'true',
  // Lawn Fast Complete new-sod holds (owner 2026-10-09). This entry is for logGateStatus only: lawn-sod-sheet.js reads
  // GATE_LAWN_NEW_SOD_NOTE at call time via lawnNewSodNoteLive().
  lawnNewSodNote: process.env.GATE_LAWN_NEW_SOD_NOTE === 'true',
  // Lawn v13 November large patch nitrogen (owner 2026-10-09). This entry is for logGateStatus only: waveguard-plan-engine.js reads
  // GATE_LAWN_NOV_LARGE_PATCH_N at call time via lawnNovLargePatchNLive() (which also needs GATE_LAWN_TROUBLE_AREAS).
  lawnNovLargePatchN: process.env.GATE_LAWN_NOV_LARGE_PATCH_N === 'true',
  // Lawn reclaimed water half nitrogen (owner 2026-10-23). This entry is for logGateStatus only: the plan engine, the property routes and the
  // county-layer job read GATE_LAWN_RECLAIMED_HALF_N at call time via lawnReclaimedHalfNLive().
  lawnReclaimedHalfN: process.env.GATE_LAWN_RECLAIMED_HALF_N === 'true',
  // Lawn v13 December large patch potassium bag (owner 2026-10-23). This entry is for logGateStatus only: waveguard-plan-engine.js reads
  // GATE_LAWN_DEC_LARGE_PATCH_K at call time via lawnDecLargePatchKLive() (which also needs GATE_LAWN_TROUBLE_AREAS).
  lawnDecLargePatchK: process.env.GATE_LAWN_DEC_LARGE_PATCH_K === 'true',
  // Lawn web report New sod card (owner 2026-10-09). This entry is for logGateStatus only: lawn-sod-report-card.js reads
  // GATE_LAWN_NEW_SOD_REPORT_CARD at call time via lawnNewSodReportCardLive() (which also needs GATE_LAWN_NEW_SOD_NOTE).
  lawnNewSodReportCard: process.env.GATE_LAWN_NEW_SOD_REPORT_CARD === 'true',
  // GATE_LAWN_REPORT_FACTS (owner 2026-10-08): the lawn report's re-entry condition, spot-use text and
  // finding-to-product tie, frozen at completion. Ships DARK. This entry is for logGateStatus only:
  // the lawn write gate reads it at call time via lawnReportFactsLive().
  lawnReportFacts: process.env.GATE_LAWN_REPORT_FACTS === 'true',

  // Intelligence Bar cancel_appointment card-confirm (ib-cancel-pinned-effects
  // lane, owner ruling 2026-09-28: the bar cancels BARE visits only — see
  // card_cancel_refusals in services/appointment-cancel-impact.js). Ships DARK: off unless exactly
  // 'true'. This entry is for logGateStatus only — the canonical CALL-TIME
  // reader is ibCancelAppointmentLive() below, same discountStackingLive()
  // convention, so a flip needs no redeploy.
  ibCancelAppointment: process.env.GATE_IB_CANCEL_APPOINTMENT === 'true',
  // Intelligence Bar cancel of a visit WITH an invoice, credit or linked visit (owner decision 2026-10-12): Confirm
  // replays the Dispatch cancel handler. Ships DARK; also needs GATE_IB_CANCEL_APPOINTMENT. For logGateStatus only;
  // the canonical call-time reader is ibCancelWithEffectsLive() below.
  ibCancelWithEffects: process.env.GATE_IB_CANCEL_WITH_EFFECTS === 'true',
  // Admin customer Activity timeline (read-only). For logGateStatus only; the
  // route reads customerActivityTimelineLive() at call time.
  customerActivityTimeline: process.env.GATE_CUSTOMER_ACTIVITY_TIMELINE === 'true',
  // Prospect email on the customer Activity timeline. logGateStatus only;
  // the timeline reads leadEmailLinksLive() at call time.
  leadEmailLinks: process.env.GATE_LEAD_EMAIL_LINKS === 'true',

  // Customer-level overdue reminders (dunning consolidation, PR 1: inert
  // foundations — nothing reads these yet). A customer with 2+ actively-
  // dunned open invoices gets ONE customer_dunning_schedules row that owns
  // the cadence, instead of one reminder per invoice. Both gates ship DARK:
  // off unless exactly 'true'. These three entries are for logGateStatus
  // only; the readers live in services/customer-dunning/ (later PRs), which
  // read the env at call time. SHADOW computes and logs only (no rows, no
  // mints, no reservations, no sends); the live gate additionally needs
  // GATE_DUNNING_LADDER_90 and the pay-page balance gate (payIncludeBalance)
  // on. dunningCustomerScheduleAllowlist reads ENABLED when
  // DUNNING_CUSTOMER_SCHEDULE_ALLOWLIST (comma list of customer uuids) is
  // CONFIGURED — unset = everyone, configured = only the valid ids, and a
  // configured list with no valid id = nobody (logGateStatus says so). The
  // one-customer canary before a full flip.
  dunningCustomerScheduleShadow: process.env.GATE_DUNNING_CUSTOMER_SCHEDULE_SHADOW === 'true',
  dunningCustomerSchedule: process.env.GATE_DUNNING_CUSTOMER_SCHEDULE === 'true',
  dunningCustomerScheduleAllowlist: String(process.env.DUNNING_CUSTOMER_SCHEDULE_ALLOWLIST || '').trim() !== '',
};

// Parse a gate env var at CALL time (for request-time availability checks
// and gates enforced inside the pricing engine, where a flip must not need
// a client redeploy and tests mutate the env at runtime). One parser, one
// truth: '1' / 'true' / 'on', case-insensitive.
// GATE_IB_DELETE_CUSTOMER read at CALL time — strict `=== 'true'`, dark in
// every environment. On, the Intelligence Bar offers delete_duplicate_customer
// (archive-only soft-delete of one empty duplicate record, always a confirm card).
function ibDeleteCustomerLive() {
  return process.env.GATE_IB_DELETE_CUSTOMER === 'true';
}

function gateEnvValue(envName) {
  return ['1', 'true', 'on'].includes(String(process.env[envName] || '').toLowerCase());
}

// Pest Insider proof approval — read at CALL time so turning the gate off
// takes effect without a redeploy at every point that matters: approval
// (newsletter-proof.js maybeHandleProofApproval) and dispatch of an
// already-approved issue (newsletter-sender.js processScheduledSends).
// Off = no approval and no dispatch, which is
// what "kill switch" has to mean: a proof that went out while the gate was
// on cannot be approved or dispatched after it is turned off.
// GATE_PORTAL_ACTIVITY read at CALL time — strict `=== 'true'`. The one
// canonical reader for the customer-activity beacon routes (which also stamp
// last_seen_at), so a flip or an unset kill needs no restart. Kept up here,
// not at the end of the file, so concurrent gate PRs appending readers at the
// bottom never conflict with it.
// GATE_PUBLIC_WATERING_PLAN read at CALL time, strict `=== 'true'`, dark in every environment. Off = every
// /api/public/watering-plan request answers the generic 404. Kill switch = unset.
function publicWateringPlanLive() {
  return process.env.GATE_PUBLIC_WATERING_PLAN === 'true';
}
function portalActivityLive() {
  return process.env.GATE_PORTAL_ACTIVITY === 'true';
}

// GATE_EMAIL_SEND_LATER read at CALL time — strict `=== 'true'`, dark.
// Owner 2026-10-22: "build it like Gmail has it". Read by routes/admin-email.js
// (schedule / list / cancel) and services/email/scheduled-email-sender.js.
function emailSendLaterLive() {
  return process.env.GATE_EMAIL_SEND_LATER === 'true';
}

// GATE_SMS_VOICE_PROFILE_PIN read at CALL time. Owner 2026-10-24: a voice_profiles.version (positive whole number).
// Anything else (unset, empty, 'true', '5.5', '0', '-3') reads as NO PIN, so a typo can never pin a wrong profile.
// Returns the version number or null. Read by sms-shadow-drafter.js (resolveEffectiveVoiceProfile, prompt version).
function smsVoiceProfilePinVersion() {
  const raw = String(process.env.GATE_SMS_VOICE_PROFILE_PIN || '').trim();
  if (!/^[0-9]{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

// GATE_SMS_EDIT_LEARNING read at CALL time — strict opt-in via gateEnvValue, dark. Owner 2026-10-24.
// Read by sms-voice-corpus-miner.js (what it mines) and sms-shadow-drafter.js (exemplar ranking, prompt version).
function smsEditLearningLive() {
  return gateEnvValue('GATE_SMS_EDIT_LEARNING');
}

// GATE_SMS_PROMPT_B1 read at CALL time — strict opt-in via gateEnvValue, dark. Owner 2026-10-24. The change is part of the
// real-answers prompt, so it applies only while GATE_SMS_REAL_ANSWERS is also on. Read by sms-shadow-drafter.js (prompt,
// facts, checks, prompt version) and context-aggregator.js (the latest visit's notes and findings). Suggestion cards only.
function smsPromptB1Live() {
  return gateEnvValue('GATE_SMS_PROMPT_B1') && gateEnvValue('GATE_SMS_REAL_ANSWERS');
}

// GATE_SMS_JUDGE_V2 read at CALL time — strict opt-in via gateEnvValue, dark. Owner 2026-10-24. Measurement only.
function smsJudgeV2Live() {
  return gateEnvValue('GATE_SMS_JUDGE_V2');
}

// GATE_SERIES_MOVE_CARRIES_VISIT read at CALL time — strict `=== 'true'`.
// Owner ruling 2026-10-01: a pest visit riding a lawn visit is ONE appointment;
// when either moves, both move. Unset = a staff series move that sweeps an
// occurrence sitting in a grouped visit is refused (VISIT_SERIES_MOVE_UNSUPPORTED),
// byte-identical to before. Read by rebooker.js and visit-groups.js.
function seriesMoveCarriesVisitLive() {
  return process.env.GATE_SERIES_MOVE_CARRIES_VISIT === 'true';
}

// GATE_SERIES_MOVE_SKIP_CLOSED_DAYS read at CALL time — strict `=== 'true'`.
// Owner 2026-10-22 ("fix series edit"): a staff move of one plan visit
// re-anchored the plan to the last Thursday and put the next visit on
// Thanksgiving, a closed day nobody picked. On, a staff series move and its
// preview move each re-dated later visit off a closed day (rebooker.js
// makeSeriesProjector). Unset = projected dates byte-identical to before.
function seriesMoveSkipClosedDaysLive() {
  return process.env.GATE_SERIES_MOVE_SKIP_CLOSED_DAYS === 'true';
}

// GATE_SERIES_MOVE_TEXT_COALESCE read at CALL time — strict `=== 'true'`, dark.
// Owner ruling 2026-10-06: a customer got two series-move texts a minute
// apart because staff moved the same series twice. On, a staff board or Edit
// appointment series move holds its customer text 3 minutes and drops it when
// a newer staff move covers the same visit (services/series-move-text-
// coalesce.js, read by routes/admin-dispatch.js applySeriesMoveEffects).
// Unset = the text goes out the moment the move commits, byte-identical to
// before. A held text already waiting when the gate is turned off goes out at
// the next pass (the 15-minute reconciler).
// GATE_ESTIMATE_DRAFT_RETIRE_ON_SEND read at CALL time — strict `=== 'true'`
// (server/services/estimate-draft-retire.js via the scheduler). Owner
// 2026-10-06: once a customer's estimate is sent, older untouched drafts for
// that customer are archived. Unset = kill, no redeploy.
function estimateDraftRetireOnSendLive() {
  return process.env.GATE_ESTIMATE_DRAFT_RETIRE_ON_SEND === 'true';
}

// GATE_REPORT_ONLY_PAYMENT_ALERT read at CALL time — strict `=== 'true'`
// (server/services/report-only-payment-alert.js via the scheduler). Owner
// 2026-10-30 (tech portal gaps, option A): a bill still open the ET day after
// a "report only, no pay link" completion raises one office alert to record
// the payment. Office-side only; sends no customer message. Unset = kill.
function reportOnlyPaymentAlertLive() {
  return process.env.GATE_REPORT_ONLY_PAYMENT_ALERT === 'true';
}

function seriesMoveTextCoalesceLive() {
  return process.env.GATE_SERIES_MOVE_TEXT_COALESCE === 'true';
}

// GATE_MULTI_TECH_TEXT_TIMES read at CALL time — strict `=== 'true'`, dark.
// Multi-technician booking PR 4 (owner "go PR 4" 2026-10-06). The callers that
// only READ appointment times — the lead reply agent's check_next_availability
// (lead-response-tools.js), the text drafter's city-based OPEN TIMES fallback and
// its send-time recheck (sms-shadow-drafter.js) and the estimate converter's
// first service day (estimate-converter.js) — ask the website booking engine
// (routes/booking.js, per technician, route-aware) through
// services/scheduling/text-offer-times.js instead of the old by-city engine
// (services/availability.js getAvailableSlots: no technicians, no routes). A
// lead known only by city is placed at that city's centre. Unset = the old
// by-city engine, byte-identical; the old path is the rollback.
function multiTechTextTimesLive() {
  return process.env.GATE_MULTI_TECH_TEXT_TIMES === 'true';
}

// GATE_KB_SPECIES_QA read at CALL time (server/services/knowledge/wiki-qa.js).
// Unset = WikiQA answers from knowledge_base alone, byte-identical to before.
function kbSpeciesQaLive() {
  return process.env.GATE_KB_SPECIES_QA === 'true';
}

// GATE_SMS_UNANSWERED_REPLY read at CALL time (server/services/sms-unanswered-reply.js):
// strict `=== 'true'`, dark in every environment. Unset = no draft is stamped,
// the sweep does nothing and every claim in flight refuses at its next check.
function smsUnansweredReplyLive() {
  return process.env.GATE_SMS_UNANSWERED_REPLY === 'true';
}

// GATE_SHORTLINK_LEGACY_EXPIRE read at CALL time — strict `=== 'true'`, dark.
// Security audit 2026-10-02: 5-char codes minted 2026-04-19..2026-08-07 (~26
// bits) are still live and front never-expiring bearer-token URLs. On, the /l
// route answers 410 for any 1-7 char code and resolveShortCode returns null
// for it (services/short-url.js `isLegacyShortCode`). Unset = byte-identical.
function shortlinkLegacyExpireLive() {
  return process.env.GATE_SHORTLINK_LEGACY_EXPIRE === 'true';
}

// GATE_KB_CUSTOMER_AUDIENCE read at CALL time (server/services/knowledge/wiki-qa.js).
// Unset = WikiQA reads every active knowledge_base row for every caller,
// byte-identical to before. On = a customer-facing caller (any source outside
// STAFF_SOURCES, a missing source included) reads only the categories in
// server/services/knowledge/customer-safe-categories.js.
function kbCustomerAudienceLive() {
  return process.env.GATE_KB_CUSTOMER_AUDIENCE === 'true';
}

// GATE_LAWN_WIKI_PAUSE read at CALL time (server/services/agronomic-wiki.js,
// server/services/wiki-yellow-digest.js) — strict `=== 'true'`. Owner
// 2026-10-30: no reader uses the lawn wiki pages and most wait on a review,
// so on = no automatic AI page writes and no review digest. Unset = unchanged.
function lawnWikiPauseLive() {
  return process.env.GATE_LAWN_WIKI_PAUSE === 'true';
}

// GATE_TS_FAST_COMPLETE read at CALL time — strict `=== 'true'`, dark in every
// environment. The canonical reader for the T&S fast-context route and the
// schedule payload's `treeShrubFastCompleteEnabled`.
function tsFastCompleteLive() {
  return process.env.GATE_TS_FAST_COMPLETE === 'true';
}

// GATE_TS_TECH_FINDINGS_COPY read at CALL time — strict `=== 'true'`, dark in
// every environment. The canonical reader for the T&S tech-findings freeze, the
// report builders' tech-decision overlay and the palm-crown copy rule.
function tsTechFindingsCopyLive() {
  return process.env.GATE_TS_TECH_FINDINGS_COPY === 'true';
}

// GATE_TS_WATCH_LIST read at CALL time — strict `=== 'true'`, dark in every
// environment. The canonical reader for the T&S photo read's watch-list block,
// the fast-context `watchList` and the completion freeze of watch items.
function tsWatchListLive() {
  return process.env.GATE_TS_WATCH_LIST === 'true';
}

// GATE_TS_OUTLINE read at CALL time — strict `=== 'true'`, so an unset variable is the kill switch. The canonical reader
// for building, regenerating and sending a Tree & Shrub outline and for its Estimates entry; off = no Tree & Shrub
// outline can be made or sent.
function tsOutlineLive() {
  return process.env.GATE_TS_OUTLINE === 'true';
}

// GATE_PEST_OUTLINE read at CALL time — strict `=== 'true'`, so an unset variable is the kill switch. The canonical
// reader for building, regenerating and sending a Pest Control outline and for its Estimates entry; off = no Pest
// Control outline can be made or sent.
function pestOutlineLive() {
  return process.env.GATE_PEST_OUTLINE === 'true';
}

// GATE_MOSQUITO_OUTLINE read at CALL time — strict `=== 'true'`, so an unset variable is the kill switch. The canonical
// reader for building, regenerating and sending a Mosquito outline and for its Estimates entry; off = no Mosquito
// outline can be made or sent.
function mosquitoOutlineLive() {
  return process.env.GATE_MOSQUITO_OUTLINE === 'true';
}

// GATE_TS_LIGHTING read at CALL time — strict `=== 'true'`, dark in every
// environment. The canonical reader for the T&S photo read's light ask, the
// stored visit light and the report's Leaf Color & Vigor trend condition.
function tsLightingLive() {
  return process.env.GATE_TS_LIGHTING === 'true';
}

// GATE_TS_PEST_CHECK read at CALL time — strict `=== 'true'`, dark in every
// environment. The canonical reader for the T&S fast-context `pestCheck` and
// the completion freeze of the live-insect answers.
function tsPestCheckLive() {
  return process.env.GATE_TS_PEST_CHECK === 'true';
}

// GATE_TS_NEONIC_CAP read at CALL time — strict `=== 'true'`, dark in every
// environment. The canonical reader for the T&S fast-context `neonicCap`.
function tsNeonicCapLive() {
  return process.env.GATE_TS_NEONIC_CAP === 'true';
}

// GATE_TS_TECH_PARAGRAPH read at CALL time — strict `=== 'true'`, dark in every
// environment (customer copy). The one reader for the tree & shrub report's
// "From your technician" paragraph (tree-shrub-tech-paragraph.js): the
// completion step makes its one model call and freezes the text, and the report
// build hands a frozen text to the report, only while this is live. It also
// needs GATE_TS_TECH_FINDINGS_COPY: the technician's hide / confirm / edit
// decisions must govern the report the paragraph sits in. Off = no model call,
// no read, and the payload, the PDF and its cache key are byte-identical.
function tsTechParagraphLive() {
  return process.env.GATE_TS_TECH_PARAGRAPH === 'true' && tsTechFindingsCopyLive();
}

// GATE_LAWN_RESERVICE_FAST_COMPLETE read at CALL time — strict `=== 'true'`, dark
// in every environment. The canonical reader for the lawn re-service
// fast-context route and the schedule payload's `lawnReserviceFastCompleteEnabled`.
function lawnReserviceFastCompleteLive() {
  return process.env.GATE_LAWN_RESERVICE_FAST_COMPLETE === 'true';
}

// GATE_LAWN_FAST_COMPLETE read at CALL time — strict `=== 'true'`, dark in every
// environment. The canonical reader for the lawn Fast Complete context and
// watering-preview routes, the /complete `lawnFast` preflight and the schedule
// payload's `lawnFastCompleteEnabled`.
function lawnFastCompleteLive() {
  return process.env.GATE_LAWN_FAST_COMPLETE === 'true';
}

// GATE_NOTE_BOX_PHOTOS read at CALL time — ships DARK, off unless exactly
// 'true'. The schedule payload's per-service `noteBoxPhotosEnabled`.
function noteBoxPhotosLive() {
  return process.env.GATE_NOTE_BOX_PHOTOS === 'true';
}

// GATE_LANE_VOICE_FILL read at CALL time — ships DARK, off unless exactly
// 'true'. POST /admin/dispatch/:id/lane-facts (services/visit-lane-facts.js).
function laneVoiceFillLive() {
  return process.env.GATE_LANE_VOICE_FILL === 'true';
}

// GATE_TYPED_VOICE_FILL read at CALL time — ships DARK, off unless exactly
// 'true'. POST /admin/dispatch/:id/typed-facts (services/visit-typed-facts.js).
function typedVoiceFillLive() {
  return process.env.GATE_TYPED_VOICE_FILL === 'true';
}

// GATE_FAST_COMPLETE_VOICE_FILL read at CALL time — strict `=== 'true'`, dark in
// every environment. The canonical reader for the Fast Complete voice-fill route
// (POST /:serviceId/fast-complete/voice-fill/clip).
function fastCompleteVoiceFillLive() {
  return process.env.GATE_FAST_COMPLETE_VOICE_FILL === 'true';
}

// GATE_FAST_COMPLETE_INVOICED_VISITS read at CALL time — strict `=== 'true'`,
// dark in every environment. The schedule row's `invoicedVisitFastCompleteEnabled`
// lets admin Dispatch open a Fast Complete sheet for a visit that is already
// invoiced or returning from payment (the sheet then sends invoiceAlreadySent
// exactly as the full form does).
function fastCompleteInvoicedVisitsLive() {
  return process.env.GATE_FAST_COMPLETE_INVOICED_VISITS === 'true';
}

// GATE_SERVER_DICTATION read at CALL time — strict `=== 'true'`, dark in every
// environment. Every staff mic (useSpeechDictation) records a clip and the
// server transcribes it (routes/tech-dictation.js); off = browser speech.
function serverDictationLive() {
  return process.env.GATE_SERVER_DICTATION === 'true';
}

// GATE_LLM_COST_TRACKING read at CALL time — ships DARK, off unless exactly
// 'true'. The one reader for estimated AI spend (services/llm-cost.js: the
// price pull and the daily spend check; agent-control/hub-read.js: the
// Control center's cost numbers). Off = no price fetch, no cost on the hub.
function llmCostTrackingLive() {
  return process.env.GATE_LLM_COST_TRACKING === 'true';
}

// GATE_PACKAGE_FOLLOWUP_AUTOBOOK read at CALL time — strict `=== 'true'`. Gates
// package-followup-booking.ensurePackageFollowUpVisit (visit 2 of a cockroach /
// flea / bed bug package booked with visit 1), the call pipeline's package
// follow-up plan and child shape, and the office-confirm hook in job-status.
function packageFollowupAutobookLive() {
  return process.env.GATE_PACKAGE_FOLLOWUP_AUTOBOOK === 'true';
}

// GATE_FAST_COMPLETE_REPORT read at CALL time — strict `=== 'true'`, dark in
// every environment. The canonical reader for the schedule payload's
// `fastCompleteReportEnabled` and the voice-facts route.
function fastCompleteReportLive() {
  return process.env.GATE_FAST_COMPLETE_REPORT === 'true';
}

// GATE_NEIGHBORHOOD_ACCESS read at CALL time — strict `=== 'true'`; unset = kill.
// Files a saved neighborhood gate code under the property's neighborhood
// (services/neighborhood-access.js fileGateCodeAfterSave).
function neighborhoodAccessLive() {
  return process.env.GATE_NEIGHBORHOOD_ACCESS === 'true';
}

// GATE_NEIGHBORHOOD_NAMING read at CALL time — strict `=== 'true'`; unset = kill.
// The neighborhood sweep's naming pass (services/neighborhood-naming.js). Needs
// the directory itself live.
function neighborhoodNamingLive() {
  return neighborhoodAccessLive() && process.env.GATE_NEIGHBORHOOD_NAMING === 'true';
}

// GATE_NEIGHBORHOOD_ADDRESS_LOOKUP read at CALL time — strict `=== 'true'`;
// unset = kill. The county search by a home's own address when its pin sits on
// another lot (services/neighborhood-access.js homeParcel). Needs the naming
// pass live.
function neighborhoodAddressLookupLive() {
  return neighborhoodNamingLive() && process.env.GATE_NEIGHBORHOOD_ADDRESS_LOOKUP === 'true';
}

// GATE_SETUP_FEE_SETTLED_ANYWHERE read at CALL time — strict `=== 'true'`; unset = kill.
// setup-fee-obligation.js setupFeeSettledElsewhere() is the ONE predicate behind the
// unminted-setup-fee alert, its completion hold and setup-fee-alert-reconcile.js.
function setupFeeSettledAnywhereLive() {
  return process.env.GATE_SETUP_FEE_SETTLED_ANYWHERE === 'true';
}

// GATE_SETUP_FEE_APPLICATION_SETTLED read at CALL time — strict `=== 'true'`; unset = kill.
// setup-fee-alert-reconcile.js: a parked visit's application is billed when a live prepay
// year bought it or the visit's own invoices bill its frozen charge (base + its add-ons).
function setupFeeApplicationSettledLive() {
  return process.env.GATE_SETUP_FEE_APPLICATION_SETTLED === 'true';
}

// GATE_SETUP_FEE_OPEN_INVOICE_NOTICE read at CALL time — strict `=== 'true'`; unset = kill.
// setup-fee-alert-reconcile.js: an unpaid fee already on open invoices reads "do NOT bill it
// again" instead of "still owed" (setupFeeSettledElsewhere's `open`).
function setupFeeOpenInvoiceNoticeLive() {
  return process.env.GATE_SETUP_FEE_OPEN_INVOICE_NOTICE === 'true';
}

// GATE_CALL_PROMISE_AI_CLOSE read at CALL time — strict `=== 'true'`; unset = kill.
// call-promise-ai-close.js: the nightly watchdog pass and the Owed queue read run the
// text-follow-up AI check over a call promise the fixed rules left open.
function callPromiseAiCloseLive() {
  return process.env.GATE_CALL_PROMISE_AI_CLOSE === 'true';
}

// GATE_CALL_PROMISE_LATER_TEXT_CHECK read at CALL time — strict `=== 'true'`; unset = kill.
// call-promise-later-text-check.js: whether a later human text still holds a record proof the AI close
// accepted. Honoured only while the AI close itself is live.
function callPromiseLaterTextCheckLive() {
  return callPromiseAiCloseLive() && process.env.GATE_CALL_PROMISE_LATER_TEXT_CHECK === 'true';
}

// GATE_CALL_ADDRESS_FAMILY_CARD read at CALL time — strict `=== 'true'`; unset = kill.
// call-family-name-link.js matchStatedAddressAccounts (the stated_address_on_account basis),
// the processor's no-mint hold on a filed family card, and the card's two actions
// (routes/admin-triage.js attach-contact / new-customer) all read it here.
function callAddressFamilyCardLive() {
  return process.env.GATE_CALL_ADDRESS_FAMILY_CARD === 'true';
}

// A technician's add / mark-wrong on a visit's neighborhood gate codes
// (routes/admin-neighborhood-access.js). Needs the directory itself live.
function neighborhoodTechActionsLive() {
  return neighborhoodAccessLive() && process.env.GATE_NEIGHBORHOOD_TECH_ACTIONS === 'true';
}

// The office's merge of one neighborhood entry into another
// (services/neighborhood-merge.js). Needs the directory itself live.
function neighborhoodMergeLive() {
  return neighborhoodAccessLive() && process.env.GATE_NEIGHBORHOOD_MERGE === 'true';
}

// The office's "Homes not placed" list and the Add-as-unconfirmed box
// (routes/admin-neighborhood-access.js). Needs the directory itself live.
function neighborhoodUnplacedLive() {
  return neighborhoodAccessLive() && process.env.GATE_NEIGHBORHOOD_UNPLACED === 'true';
}

// Gate and access codes on the office schedule (owner ruling 2026-10-26), read
// at CALL time. Strict `=== 'true'`, dark by default; unset is the kill switch.
function scheduleAccessCodesLive() {
  return process.env.GATE_SCHEDULE_ACCESS_CODES === 'true';
}

// Staff onboarding documents (services/staff-onboarding.js), read at CALL time.
// Strict `=== 'true'`, dark in every environment; unsetting it is the kill switch.
// The reads also need the staff documents gate itself.
function staffOnboardingDocsLive() {
  return process.env.GATE_STAFF_ONBOARDING_DOCS === 'true';
}

// Truck clock-in (services/truck-clock-in.js), read at CALL time: 'shadow' or 'off'.
// 'shadow' (exactly, trimmed, any case) decides and records one truck_clock_in_shadow row per
// technician per Eastern work day and never writes time_entries. Anything else, 'true'
// included, is off: no code path runs. Live clock-in is a separate later change. Unset is
// the kill, no redeploy.
function truckClockInMode() {
  return String(process.env.GATE_TRUCK_CLOCK_IN || '').trim().toLowerCase() === 'shadow' ? 'shadow' : 'off';
}

// Caller demotion + booking-confirmation replay after an on-site contact's YES
// (services/recipient-optin.js settleOnSiteFollowUps), read at CALL time.
// Strict `=== 'true'`, dark in every environment.
function onSiteCallerDemoteLive() {
  return process.env.GATE_ONSITE_CALLER_DEMOTE === 'true';
}

// GATE_IB_INVOICE_ACTIONS read at CALL time — strict `=== 'true'`, dark. The
// Intelligence Bar's send_invoice tool
// (services/intelligence-bar/invoice-action-tools.js): offered and executable
// only while on. Kill: unset.
function ibInvoiceActionsLive() {
  return process.env.GATE_IB_INVOICE_ACTIONS === 'true';
}

// GATE_IB_INVOICE_EMAIL read at CALL time — strict `=== 'true'`, dark. The
// Intelligence Bar's send_invoice email channel (channel: 'email', optional one
// CC): offered and executable only while on AND GATE_IB_INVOICE_ACTIONS is on.
// Off: send_invoice stays text-only, exactly as before. Kill: unset.
function ibInvoiceEmailLive() {
  return process.env.GATE_IB_INVOICE_EMAIL === 'true' && ibInvoiceActionsLive();
}

// Report text to on-location contacts (services/contact-report-text.js),
// read at CALL time. Strict `=== 'true'`, dark in every environment.
function contactReportTextLive() {
  return process.env.GATE_CONTACT_REPORT_TEXT === 'true';
}

// Contact login (middleware/auth.js, routes/auth.js, the per-contact
// notification filter in services/contact-notification-prefs.js), read at
// CALL time. Strict `=== 'true'`, dark in every environment. Kill: unset —
// a contact token is refused at its next request and the senders ignore the
// per-contact table.
function contactLoginLive() {
  return process.env.GATE_CONTACT_LOGIN === 'true';
}

// GATE_IB_REPRICE_VISITS read at CALL time — strict `=== 'true'`, dark. The
// Intelligence Bar's reprice_future_visits tool (services/intelligence-bar/
// reprice-visits-tools.js): offered and executable only while on. Kill: unset.
function ibRepriceVisitsLive() {
  return process.env.GATE_IB_REPRICE_VISITS === 'true';
}

// GATE_IB_MULTI_CARD read at CALL time — strict `=== 'true'`, dark, and it needs
// GATE_IB_PLATFORM (the write frontier it relaxes exists only on the platform
// path). The Intelligence Bar may then mint up to five independent confirm
// cards in one request (services/intelligence-bar/multi-card.js). Kill: unset.
function ibMultiCardLive() {
  return process.env.GATE_IB_MULTI_CARD === 'true' && gateEnvValue('GATE_IB_PLATFORM');
}

// GATE_IB_LEAD_CONVERT read at CALL time — strict `=== 'true'`, dark, and it needs
// GATE_IB_PLATFORM (the tool exists only on the platform path). The Intelligence
// Bar's convert_lead tool (services/intelligence-bar/lead-convert-tools.js):
// offered and executable only while on. Kill: unset.
function ibLeadConvertLive() {
  return process.env.GATE_IB_LEAD_CONVERT === 'true' && gateEnvValue('GATE_IB_PLATFORM');
}

// GATE_IB_VOID_INVOICE read at CALL time — strict `=== 'true'`, dark, and it needs
// GATE_IB_PLATFORM (the tool exists only on the platform path). The Intelligence
// Bar's void_invoice tool (services/intelligence-bar/void-invoice-tools.js):
// offered and executable only while on. Kill: unset.
function ibVoidInvoiceLive() {
  return process.env.GATE_IB_VOID_INVOICE === 'true' && gateEnvValue('GATE_IB_PLATFORM');
}

// GATE_IB_INVOICE_EDITS read at CALL time — strict `=== 'true'`, dark, and it needs
// GATE_IB_PLATFORM (the tools exist only on the platform path). The Intelligence
// Bar's edit_invoice (title, notes, due date only) / archive_invoice / unarchive_invoice /
// unvoid_invoice tools (services/intelligence-bar/invoice-edit-tools.js): offered
// and executable only while on. Kill: unset.
function ibInvoiceEditsLive() {
  return process.env.GATE_IB_INVOICE_EDITS === 'true' && gateEnvValue('GATE_IB_PLATFORM');
}

// GATE_IB_INVOICE_REMINDERS read at CALL time — strict `=== 'true'`, dark, and it needs
// GATE_IB_PLATFORM (the tools exist only on the platform path). The Intelligence
// Bar's pause_invoice_reminders / resume_invoice_reminders / stop_invoice_reminders /
// send_invoice_reminder_now / schedule_invoice_send tools
// (services/intelligence-bar/invoice-reminder-tools.js): offered and executable
// only while on. Kill: unset.
function ibInvoiceRemindersLive() {
  return process.env.GATE_IB_INVOICE_REMINDERS === 'true' && gateEnvValue('GATE_IB_PLATFORM');
}

// GATE_IB_PAYMENT_PLAN read at CALL time — strict `=== 'true'`, dark, and it needs
// GATE_IB_PLATFORM (the tools exist only on the platform path). The Intelligence
// Bar's create_payment_plan / cancel_payment_plan tools
// (services/intelligence-bar/payment-plan-tools.js): offered and executable only
// while on. Kill: unset.
function ibPaymentPlanLive() {
  return process.env.GATE_IB_PAYMENT_PLAN === 'true' && gateEnvValue('GATE_IB_PLATFORM');
}

// GATE_IB_CREATE_INVOICE read at CALL time — strict `=== 'true'`, dark, and it needs
// GATE_IB_PLATFORM (the tool exists only on the platform path). The Intelligence
// Bar's create_invoice tool (services/intelligence-bar/create-invoice-tools.js):
// offered and executable only while on. Kill: unset.
function ibCreateInvoiceLive() {
  return process.env.GATE_IB_CREATE_INVOICE === 'true' && gateEnvValue('GATE_IB_PLATFORM');
}

// GATE_IB_SET_BILL_TO read at CALL time — strict `=== 'true'`, dark, and it needs
// GATE_IB_PLATFORM (the tool exists only on the platform path). The Intelligence
// Bar's set_customer_bill_to tool (services/intelligence-bar/bill-to-tools.js):
// offered and executable only while on. Kill: unset.
function ibSetBillToLive() {
  return process.env.GATE_IB_SET_BILL_TO === 'true' && gateEnvValue('GATE_IB_PLATFORM');
}

// GATE_IB_RESOLVE_DISPATCH_ALERT read at CALL time — strict `=== 'true'`, dark, and
// it needs GATE_IB_PLATFORM (the tool exists only on the platform path). The
// Intelligence Bar's resolve_dispatch_alert tool
// (services/intelligence-bar/dispatch-alert-tools.js): offered and executable
// only while on. Kill: unset.
function ibResolveDispatchAlertLive() {
  return process.env.GATE_IB_RESOLVE_DISPATCH_ALERT === 'true' && gateEnvValue('GATE_IB_PLATFORM');
}

// GATE_IB_UNBLOCK_SENDER read at CALL time — strict `=== 'true'`, dark, and it
// needs GATE_IB_PLATFORM. The Intelligence Bar's unblock_sender tool
// (services/intelligence-bar/unblock-sender-tools.js): offered and executable
// only while on. Kill: unset.
function ibUnblockSenderLive() {
  return process.env.GATE_IB_UNBLOCK_SENDER === 'true' && gateEnvValue('GATE_IB_PLATFORM');
}

// GATE_BILL_TO_NO_VISIT_INVOICES read at CALL time — strict `=== 'true'`, dark. On, the Bill-To withdrawal's owner
// answer (services/visit-linked-invoice-withdrawal.js) covers invoices that ride no visit, owned through the customer
// default. Kill: unset.
function billToNoVisitInvoicesLive() {
  return process.env.GATE_BILL_TO_NO_VISIT_INVOICES === 'true';
}

// GATE_IB_SCHEDULE_SMS read at CALL time — strict `=== 'true'`, dark, and it needs
// GATE_IB_PLATFORM (the tool exists only on the platform path). The Intelligence
// Bar's schedule_sms tool (services/intelligence-bar/schedule-sms-tools.js):
// offered and executable only while on. It texts a customer later: the flip is the owner's. Kill: unset.
function ibScheduleSmsLive() {
  return process.env.GATE_IB_SCHEDULE_SMS === 'true' && gateEnvValue('GATE_IB_PLATFORM');
}

// GATE_IB_AGENT_REVIEW_DRAFTS read at CALL time — strict `=== 'true'`, dark, and it needs
// GATE_IB_PLATFORM (the tools exist only on the platform path). The Intelligence Bar's Agent Review
// draft tools (services/intelligence-bar/agent-review-tools.js): offered and executable only while
// on. Kill: unset.
function ibAgentReviewDraftsLive() {
  return process.env.GATE_IB_AGENT_REVIEW_DRAFTS === 'true' && gateEnvValue('GATE_IB_PLATFORM');
}

// GATE_IB_COMPOSE_EMAIL read at CALL time — strict `=== 'true'`, dark, and it needs
// GATE_IB_PLATFORM (the tool exists only on the platform path). The Intelligence
// Bar's compose_email tool (services/intelligence-bar/compose-email-tools.js):
// offered and executable only while on. It emails a person: an owner flip. Kill: unset.
function ibComposeEmailLive() {
  return process.env.GATE_IB_COMPOSE_EMAIL === 'true' && gateEnvValue('GATE_IB_PLATFORM');
}

// GATE_IB_GENERAL_READ read at CALL time — strict `=== 'true'`, dark, and it
// needs GATE_IB_PLATFORM. The Intelligence Bar's find_admin_reads /
// read_admin_data tools (services/intelligence-bar/admin-read-tools.js):
// offered and executable only while on, and only on the owner login. Only the
// platform path has the owner-only access model (fullAccess), so with
// GATE_IB_PLATFORM off nothing offers the tools and a forced call is refused:
// this reader is false then, everywhere. Kill: unset either variable.
function ibGeneralReadLive() {
  return process.env.GATE_IB_GENERAL_READ === 'true' && gateEnvValue('GATE_IB_PLATFORM');
}

// GATE_IB_READ_NOTES read at CALL time — strict `=== 'true'`, dark, and it needs
// GATE_IB_GENERAL_READ (so GATE_IB_PLATFORM too). With it on, the general read
// (admin-read-tools.js) returns free-text notes through one fixed-format secret
// scrubber, cut at 1,000 characters, instead of the withheld marker. Off = the
// marker, as before. Kill: unset the variable.
function ibReadNotesLive() {
  return process.env.GATE_IB_READ_NOTES === 'true' && ibGeneralReadLive();
}

// GATE_IB_GENERAL_READ_OFFICE read at CALL time — strict `=== 'true'`, dark, and it needs
// GATE_IB_GENERAL_READ (so GATE_IB_PLATFORM too). The non-owner admin login (the office) gets the
// general admin read limited to reviewed `office: true` catalog rows
// (services/intelligence-bar/admin-read-tools.js). Kill: unset.
function ibGeneralReadOfficeLive() {
  return process.env.GATE_IB_GENERAL_READ_OFFICE === 'true' && ibGeneralReadLive();
}

// GATE_IB_GENERAL_EDIT read at CALL time — strict `=== 'true'`, dark, and it
// needs GATE_IB_PLATFORM. The Intelligence Bar's find_admin_edits /
// propose_admin_edit tools (services/intelligence-bar/admin-write-tools.js):
// offered and executable only while on, and only on the owner login, always
// behind a confirm card. Only the platform path has the owner-only access
// model (fullAccess), so with GATE_IB_PLATFORM off this reader is false,
// everywhere. Kill: unset either variable.
function ibGeneralEditLive() {
  return process.env.GATE_IB_GENERAL_EDIT === 'true' && gateEnvValue('GATE_IB_PLATFORM');
}

// GATE_IB_TOOL_SEARCH read at CALL time — strict `=== 'true'`, dark. A
// full-access Intelligence Bar login on an ordinary admin page gets its page's
// tools up front plus every other allowed tool deferred behind the Anthropic
// API's tool search (action-registry.js initialTools, scope.toolSearch). Off =
// the page list plus discover_capabilities for everyone. Has effect only on a
// model that accepts tool search (models.anthropicSupportsToolSearch) and does
// not think by default (models.anthropicThinksByDefault); any other model
// keeps the ordinary list. Kill: unset.
function ibToolSearchLive() {
  return process.env.GATE_IB_TOOL_SEARCH === 'true';
}

// GATE_IB_OPENAI_BACKUP read at CALL time — strict `=== 'true'`, dark. When the
// Intelligence Bar's Anthropic call fails with a provider error (usage limit,
// auth, overloaded, 5xx, timeout), the request finishes on OpenAI with tool
// calling (services/intelligence-bar/openai-tool-adapter.js). Off = no
// fallback, today's behavior. Kill: unset.
function ibOpenaiBackupLive() {
  return process.env.GATE_IB_OPENAI_BACKUP === 'true';
}

// GATE_IB_BILLING_MODE_EDIT read at CALL time — strict `=== 'true'`, dark.
// The Intelligence Bar's update_customer billing type + per-application fee
// edit (services/intelligence-bar/billing-mode-change.js). Kill: unset.
function ibBillingModeEditLive() {
  return process.env.GATE_IB_BILLING_MODE_EDIT === 'true';
}

// GATE_IB_TIER_UPGRADE_EMAIL read at CALL time — strict `=== 'true'`, dark. An
// Intelligence Bar update_customer card that raises the WaveGuard tier and
// changes the billed monthly rate emails the customer the tier-upgrade notice
// (services/intelligence-bar/tier-upgrade-email.js). Kill: unset.
function ibTierUpgradeEmailLive() {
  return process.env.GATE_IB_TIER_UPGRADE_EMAIL === 'true';
}

// Staff Auto Pay-off step of the Intelligence Bar's remove_saved_payment_method
// (services/intelligence-bar/billing-write-tools.js), read at CALL time.
// Strict `=== 'true'`, dark in every environment.
function ibStaffAutopayOffLive() {
  return process.env.GATE_IB_STAFF_AUTOPAY_OFF === 'true';
}

// The Staff page "Hired" button (routes/admin-timetracking.js POST
// /technicians/:id/hire and /hire/resend), read at CALL time. Strict
// `=== 'true'`, dark in every environment; unsetting it is the kill switch.
// Each click emails ONE staff member a set-password link, never a customer.
function hiredPacketLive() {
  return process.env.GATE_HIRED_PACKET === 'true';
}

// Staff form prefill (routes/tech-staff-documents.js GET /versions/:id/prefill), read at
// CALL time. Strict `=== 'true'`, dark in every environment. Reads only.
function staffDocPrefillLive() {
  return process.env.GATE_STAFF_DOC_PREFILL === 'true';
}

// Review bonus attribution (services/review-incentives.js resolveTechnicianForGoogleReview),
// read at CALL time. Strict `=== 'true'`, dark in every environment. Bonus pay: the owner flips it.
function reviewBonusAskFirstLive() {
  return process.env.GATE_REVIEW_BONUS_ASK_FIRST === 'true';
}

// Leaderboard callback credit (routes/admin-dashboard.js, services/callback-credit.js),
// read at CALL time. Strict `=== 'true'`, dark in every environment. Reads only.
function callbackSourceTechLive() {
  return process.env.GATE_CALLBACK_SOURCE_TECH === 'true';
}

// Visit tech relay (routes/twilio-webhook.js -> services/visit-tech-relay.js), read at
// CALL time. Strict `=== 'true'`, dark in every environment. Sends nothing to a customer.
function customerTextToVisitTechLive() {
  return process.env.GATE_CUSTOMER_TEXT_TO_VISIT_TECH === 'true';
}

// Intelligence Bar accept_estimate (services/intelligence-bar/estimate-accept-tools.js),
// read at CALL time. Strict `=== 'true'`, dark in every environment.
function ibAcceptEstimateLive() {
  return process.env.GATE_IB_ACCEPT_ESTIMATE === 'true';
}

// GATE_IB_RECORD_PAYMENT read at CALL time — strict `=== 'true'`, dark, and it needs
// GATE_IB_PLATFORM (the tool exists only on the platform path). The Intelligence
// Bar's record_payment tool (services/intelligence-bar/record-payment-tools.js):
// offered and executable only while on. Kill: unset.
function ibRecordPaymentLive() {
  return process.env.GATE_IB_RECORD_PAYMENT === 'true' && gateEnvValue('GATE_IB_PLATFORM');
}

// GATE_IB_MODEL_FAILURE_NOTICE read at CALL time (routes/admin-intelligence-bar.js), strict `=== 'true'`, dark in every
// environment. On, a failed Intelligence Bar model call becomes a plain 200 answer, a gap row and one hourly admin bell.
// Off = the error reaches the error handler, as before.
function ibModelFailureNoticeLive() {
  return process.env.GATE_IB_MODEL_FAILURE_NOTICE === 'true';
}

// GATE_DUPLICATES_SAME_ADDRESS read at REQUEST time — strict `=== 'true'`, dark.
// Adds the "Same address, different phone" section to the admin Duplicates
// review queue (customer-dedupe.js findSameAddressGroups). Review-only: the
// auto-merge cron never reads that group kind. Off = byte-identical.
function duplicatesSameAddressLive() {
  return process.env.GATE_DUPLICATES_SAME_ADDRESS === 'true';
}

// GATE_DUPLICATES_SAME_NAME read at REQUEST time — strict `=== 'true'`, dark.
// Adds the "Same name, different phone and address" section to the admin
// Duplicates review queue (customer-dedupe.js findSameNameGroups). Review-only:
// the auto-merge cron never reads that group kind. Off = byte-identical.
function duplicatesSameNameLive() {
  return process.env.GATE_DUPLICATES_SAME_NAME === 'true';
}

// GATE_MISSED_CALL_TEXT_BACK_EMPTY_VOICEMAIL — ships DARK, off unless exactly
// 'true'. Same switch the text-back service reads through isEnabled().
function missedCallTextBackEmptyVoicemailLive() {
  return process.env.GATE_MISSED_CALL_TEXT_BACK_EMPTY_VOICEMAIL === 'true';
}

// GATE_ESTIMATE_SENT_CLOSES_ASSESSMENT read at CALL time — strict `=== 'true'`,
// dark. On, the ten-minute sweep (assessment-estimate-closeout.js) completes
// an open Waves Assessment visit once an estimate has been sent to its
// customer after it (owner ruling 2026-10-04). Off = the sweep returns before
// reading anything. Kill switch: unset it.
function estimateSentClosesAssessmentLive() {
  return process.env.GATE_ESTIMATE_SENT_CLOSES_ASSESSMENT === 'true';
}

// GATE_REVIEW_ASK_AFTER_REPORT read at CALL time — strict `=== 'true'`, dark.
// On, an Automatic Day-0 review ask is due REVIEW_AFTER_REPORT_DELAY_MINUTES
// (10) after enrollment — the moment the report text goes out, or the moment
// payment lifts the unpaid-invoice hold — for every service line, sent at the
// next :14/:44 review send. Off = the smart send window exactly as before.
function reviewAskAfterReportLive() {
  return process.env.GATE_REVIEW_ASK_AFTER_REPORT === 'true';
}

// GATE_CALL_ENRICH_CODES_REQUIRE_ANI read at CALL time, strict `=== 'true'`, dark in every environment.
// services/call-profile-enrichment.js: a call writes gate / garage / lockbox codes and access notes to the
// customer's profile only when the call's caller ID is that customer's primary phone (a callback number the
// caller spoke can resolve the customer, but proves nothing about who is on the line). Sends nothing.
// Off = today's behavior, byte for byte.
function callEnrichCodesRequireAniLive() {
  return process.env.GATE_CALL_ENRICH_CODES_REQUIRE_ANI === 'true';
}
// GATE_BACKLINK_SIGNUP_URL_GUARD read at CALL time — strict `=== 'true'`, dark by
// default. URL and egress guard for the backlink signup worker's browser.
function backlinkSignupUrlGuardLive() {
  return process.env.GATE_BACKLINK_SIGNUP_URL_GUARD === 'true';
}

// GATE_EMAIL_AUTH_STRICT read at CALL time, strict `=== 'true'`, dark. On, hasAlignedAuth
// (services/email/inbox-hygiene.js) reads only real method results of Google's
// Authentication-Results (comments and quoted strings dropped, authserv-id mx.google.com), so a quoted
// envelope sender cannot fake a DKIM pass, and processVendorInvoice (services/email/invoice-processor.js)
// books an expense only when the sender authenticated as its From domain. Sends nothing. Off = today's behavior.
function emailAuthStrictLive() {
  return process.env.GATE_EMAIL_AUTH_STRICT === 'true';
}

// GATE_DEDUPE_NO_UNVERIFIED_BACKFILL read at CALL time — strict `=== 'true'`.
// When on, the AUTOMATIC duplicate merge (customer-dedupe.js executeMerge mode
// 'auto') refuses a pair whose duplicate is an untouched anonymous intake row
// with an email that is not the kept customer's. The sweep reports it as
// skipped (unverified_intake_email) and the pair stays on the Duplicates page
// for a manual merge. Manual merges are unchanged. Off = old behavior.
// Sends nothing to a customer. Kill switch: unset it.
function dedupeNoUnverifiedBackfillLive() {
  return process.env.GATE_DEDUPE_NO_UNVERIFIED_BACKFILL === 'true';
}

// GATE_NEWSLETTER_CLICK_BOUND read at CALL time — strict `=== 'true'`, dark by
// default. Binds the newsletter event-click redirect to the send's lineup and
// to the URLs snapshotted on the send (security audit run 2).
function newsletterClickBoundLive() {
  return process.env.GATE_NEWSLETTER_CLICK_BOUND === 'true';
}

// GATE_NEWSLETTER_AUTO_SEND read at CALL time, strict `=== 'true'`, dark by
// default (owner 2026-10-30, option A). On, the weekly proof step queues the
// issue for its Tuesday 6:00 AM ET target and the owner's copy is FYI (reply
// HOLD to skip the week); the inactive-reader check-in email queues itself.
// Off = the issue waits for an APPROVED reply. Emails the list.
function newsletterAutoSendLive() {
  return process.env.GATE_NEWSLETTER_AUTO_SEND === 'true';
}

// GATE_ESTIMATE_LAWN_LIMITS read at CALL time — strict `=== 'true'`, dark by
// default (owner 2026-10-22). services/estimate-lawn-limits.js: the "What we
// can and can't fix" block on a recurring lawn estimate, the two turf profile
// flags (other_grasses, virus_streaks_suspected) and the Celsius WG warning on
// the lawn Fast Complete sheet. Off = every output is byte-identical to before.
function estimateLawnLimitsLive() {
  return process.env.GATE_ESTIMATE_LAWN_LIMITS === 'true';
}

// GATE_MOSQUITO_MISTING read at CALL time (gateEnvValue: '1'/'true'/'on'), dark by
// default. The mosquito misting system pricer in the estimate engine, the
// legacy mapper's plan and install rows, and the two public price-range rows.
// Off = the services.mosquitoMisting key is ignored and output is unchanged.
// Also gates the misting system records (owner 2026-10-30): the admin-only Misting system
// panel on Customer 360 and /api/admin/misting-records (install calibration and refill
// log). Off = those routes answer 404 and the panel renders nothing.
// Also gates the customer app's Home card, GET /api/misting-system: off = `{ system: null }`
// with no read.
function mosquitoMistingLive() {
  return gateEnvValue('GATE_MOSQUITO_MISTING');
}

// GATE_DEAD_ANIMAL_REMOVAL read at CALL time (gateEnvValue: '1'/'true'/'on'), dark by
// default. NEW QUOTES ONLY: off = the estimator hides the Dead Rodent Removal & Odor
// Treatment choice and pricing a services.deadAnimalRemoval input throws a 400
// failClosed DEAD_ANIMAL_REMOVAL_GATED error, so nothing is dropped silently. A saved
// estimate that already carries the line is not re-gated: send, accept, booking and
// completion work like any rodent line.
function deadAnimalRemovalLive() {
  return gateEnvValue('GATE_DEAD_ANIMAL_REMOVAL');
}

// GATE_BID_KIT read at CALL time, strict `=== 'true'`, dark by default in every environment. The one reader for the
// Bid kit: routes/admin-bid-kit.js, services/bid-kit-expiry.js (the daily job) and the `bid_kit` flag on
// GET /api/admin/feature-flags that shows the nav entry. Off: every route answers 404, the nav entry is hidden and the job
// returns before any query. It stores and sends nothing public. Kill: unset.
function bidKitLive() {
  return process.env.GATE_BID_KIT === 'true';
}

// GATE_BID_KIT_PRODUCT_LIST_SYNC read at CALL time, strict `=== 'true'`, dark by default. The one reader for the daily Product List
// rebuild (services/bid-kit-product-list.js). It runs only while GATE_BID_KIT is also on. Off: the job returns before any query.
// Kill: unset.
function bidKitProductListSyncLive() {
  return process.env.GATE_BID_KIT_PRODUCT_LIST_SYNC === 'true';
}

// GATE_PRODUCT_INTAKE_GUARD read at CALL time, strict `=== 'true'`, dark by default. The one reader for the purchase near-name guard
// (purchase-receipts/product-matcher.js, inventory-agent.js) and the EPA number/label lookup for agent-created pesticides.
// Off: today's behavior byte for byte (name containment as before, EPA "N/A", today's bell text, no EPA call). Kill: unset.
function productIntakeGuardLive() {
  return process.env.GATE_PRODUCT_INTAKE_GUARD === 'true';
}

// GATE_REVIEW_FIRST_ASK_LOCK read at CALL time, strict `=== 'true'`, dark by default. The one reader for the first-review-ask lock: the
// completion panel's "First review ask" box (GET /api/admin/reviews/send-time-preview with a serviceId) and the server rule in
// services/complete-scheduled-service.js that keeps a never-asked customer's ask on unless the completion carries the "Complaint on site"
// reason. Off: the box, the preview and the saved choice are byte for byte as before. Kill: unset.
function reviewFirstAskLockLive() {
  return process.env.GATE_REVIEW_FIRST_ASK_LOCK === 'true';
}

// GATE_ANNUAL_PLAN_DOCUMENTS: owner-only informational annual-plan PDFs in
// Documents. Read at request time; off skips the extra list query and returns
// 404 for downloads. Existing My Plan/signed-agreement reads stay independent.
function annualPlanDocumentsLive() {
  return process.env.GATE_ANNUAL_PLAN_DOCUMENTS === 'true';
}

// GATE_COMMERCIAL_PROPOSAL_SIGN read at CALL time, strict `=== 'true'`, dark by default in every environment. The one reader
// for "Accept & sign agreement" on an authored commercial proposal: POST /api/estimates/:token/commercial-agreement
// (services/commercial-proposal-agreement.js), the `cta.commercialAgreement` block on GET /:token/data, the sign hook in
// routes/contracts-public.js and the agreement line on GET /api/admin/estimates/:id/proposal. Off: the route answers the generic 404,
// /data and the admin read carry nothing new, the sign hook is inert; every surface is byte-identical to before. On, a proposal
// recipient can sign the Commercial Pest Service Agreement online; the signed copy goes to the customer through the existing
// signed-contract email. The estimate is never accepted and no visit, invoice or charge is made. Kill: unset.
function commercialProposalSignLive() {
  return process.env.GATE_COMMERCIAL_PROPOSAL_SIGN === 'true';
}

// GATE_COMMERCIAL_AUTOPAY read at CALL time, strict `=== 'true'`, dark by default in every environment (owner 2026-10-24,
// "autopay default"). The one reader for Auto Pay as a commercial proposal payment term: the builder's Auto Pay choice and
// prefill (GET/PUT /api/admin/estimates/:id/proposal), the signing chokepoint (services/commercial-proposal-agreement.js
// agreementTermsConflict) and the Auto Pay setup step after an Auto Pay agreement is signed (routes/contracts-public.js).
// Off: Auto Pay cannot be saved or signed and every surface is as before. A proposal already saved with Auto Pay keeps
// it, prints it, and cannot be signed online. Kill: unset.
function commercialAutopayLive() {
  return process.env.GATE_COMMERCIAL_AUTOPAY === 'true';
}

// GATE_COMMERCIAL_FIRST_VISIT read at CALL time, strict `=== 'true'`, dark by default in every environment (owner
// 2026-10-26, "OK GO" on decision page choice 1B). The one reader for "Pick your first visit" after a commercial agreement
// is signed (services/commercial-first-visit.js): `cta.commercialFirstVisit` on GET /api/estimates/:token/data, the
// first-visit availability and booking routes in routes/estimate-public.js, the signing page's way back to the estimate
// (routes/contracts-public.js) and the signed-agreement alert's copy. Off: the routes answer the generic 404, /data
// carries nothing new, and the office books the first visit as before. On, the signer of an eligible proposal books the
// first visit from open slots; it books, marks the proposal won, seeds the series and texts the booking confirmation.
// Kill: unset.
function commercialFirstVisitLive() {
  return process.env.GATE_COMMERCIAL_FIRST_VISIT === 'true';
}

// GATE_ESTIMATE_ASSESSMENT_FIRST read at CALL time, strict `=== 'true'`, dark by default in every environment (owner
// 2026-10-26, "OK GO" on decision page choice 3A). The one reader for "Book a free Waves Assessment first" on an open
// estimate: `assessmentFirst` on GET /api/estimates/:token/data and the estimate-token booking page's API
// (routes/estimate-assessment-public.js, mounted with its pre-guard on /api/public/estimate-assessment). Off: the API
// answers the generic 404, /data carries nothing new and the lead-only consultation offer is as before. On, a customer
// viewing an eligible open estimate can book a free Waves Assessment from it; the booking texts its confirmation.
// Kill: unset.
function estimateAssessmentFirstLive() {
  return process.env.GATE_ESTIMATE_ASSESSMENT_FIRST === 'true';
}

// GATE_TAX_SHARED_BILLS read at CALL time (so a flip needs no redeploy); needs GATE_BANK_IMPORT too, like the ledger.
function taxSharedBillsLive() {
  return gateEnvValue('GATE_BANK_IMPORT') && gateEnvValue('GATE_TAX_SHARED_BILLS');
}

// GATE_TAX_RETURN_ENGINE read at CALL time (so a flip needs no redeploy); needs GATE_BANK_IMPORT too, like the ledger.
function taxReturnEngineLive() {
  return gateEnvValue('GATE_BANK_IMPORT') && gateEnvValue('GATE_TAX_RETURN_ENGINE');
}

// GATE_SLAB_HOME_NO_TAX read at CALL time (so a flip needs no redeploy).
function slabHomeNoTaxLive() {
  return gateEnvValue('GATE_SLAB_HOME_NO_TAX');
}

// GATE_BUILDING_USE_TAX read at CALL time (so a flip needs no redeploy).
function buildingUseTaxLive() {
  return gateEnvValue('GATE_BUILDING_USE_TAX');
}

// GATE_UNDO_MANUAL_PAYMENT read at CALL time (so a flip needs no redeploy). Strict `=== 'true'`.
function undoManualPaymentLive() {
  return process.env.GATE_UNDO_MANUAL_PAYMENT === 'true';
}

// GATE_PARTIAL_PAYMENTS read at CALL time (so a flip needs no redeploy). Strict `=== 'true'`.
function partialPaymentsLive() {
  return process.env.GATE_PARTIAL_PAYMENTS === 'true';
}

// GATE_IB_RECORD_PAYMENT_PARTIAL read at CALL time. Strict `=== 'true'`. The Intelligence Bar's record_payment card may record a part of the
// balance only while this AND GATE_PARTIAL_PAYMENTS are on (recordManualPayment re-checks both when the bar marks a part).
function ibRecordPaymentPartialLive() {
  return process.env.GATE_IB_RECORD_PAYMENT_PARTIAL === 'true';
}

// GATE_TAX_SERVICE_COUNTY read at CALL time (so a flip needs no redeploy).
function taxServiceCountyLive() {
  return gateEnvValue('GATE_TAX_SERVICE_COUNTY');
}

// GATE_SLAB_BUSINESS_SITE_TAX read at CALL time (so a flip needs no redeploy).
function slabBusinessSiteTaxLive() {
  return gateEnvValue('GATE_SLAB_BUSINESS_SITE_TAX');
}

// GATE_LAWN_9X_ROUNDS read at CALL time (so a flip needs no redeploy).
function lawn9xRoundsLive() {
  return gateEnvValue('GATE_LAWN_9X_ROUNDS');
}

// GATE_LAWN_SPRAY_NO_TAX read at CALL time (so a flip needs no redeploy).
function lawnSprayNoTaxLive() {
  return gateEnvValue('GATE_LAWN_SPRAY_NO_TAX');
}

// GATE_TAX_WORKSHEETS read at CALL time (so a flip needs no redeploy); needs GATE_BANK_IMPORT too, like the ledger.
function taxWorksheetsLive() {
  return gateEnvValue('GATE_BANK_IMPORT') && gateEnvValue('GATE_TAX_WORKSHEETS');
}

// GATE_PUBLIC_LLM_SHARED_CAP read at CALL time (so a flip needs no redeploy); strict 'true'.
function publicLlmSharedCapLive() {
  return process.env.GATE_PUBLIC_LLM_SHARED_CAP === 'true';
}

// GATE_SMS_FOLLOWUP_WITNESS_FIX read at CALL time (so a flip needs no redeploy); strict 'true', dark in every environment.
// On: a staff call to ANY of the customer's phones answers a text follow-up, an estimate sent to a customer whose
// follow-up names no property answers it, and Done on the bell also settles the follow-up. Off = today's behavior.
function smsFollowupWitnessFixLive() {
  return process.env.GATE_SMS_FOLLOWUP_WITNESS_FIX === 'true';
}

function pestInsiderProofLive() {
  return process.env.GATE_PEST_INSIDER_PROOF === 'true';
}

// GATE_DISCOUNT_STACKING read at CALL time — strict `=== 'true'`, NOT
// gateEnvValue's more permissive '1'/'true'/'on' case-insensitive rule,
// because this gate's documented contract (and the endpoint test locking it
// in) is that any other spelling or casing — 'TRUE', '1', unset — is off.
// The `discountStacking` gates-map entry above is for logGateStatus only;
// this is the one canonical reader every caller must use — today
// server/routes/admin-discounts.js's GET /stacking, and later whichever
// schedule/invoice slice wires an actual caller — so none of them can drift
// from what the endpoint reports (Codex pre-push audit P1: the route used
// to read the load-time gates-map value via isEnabled(), which never sees a
// flip until the process restarts).
function discountStackingLive() {
  return process.env.GATE_DISCOUNT_STACKING === 'true';
}

// GATE_EMAIL_AREA_INTEL read at CALL time. Unset = the scheduler tick
// (server/services/scheduler.js) returns immediately.
function emailAreaIntelLive() {
  return process.env.GATE_EMAIL_AREA_INTEL === 'true';
}

// GATE_REPORT_PHOTO_CONTENT read at CALL time — off unless exactly 'true'
// (repo gate convention, matching discountStackingLive above). On, the AI
// report writer's grounding (POST /generate-report, admin-schedule.js) may
// include the technician's own tech-reviewed photo captions / photo summary,
// labeled as a TECHNICIAN PHOTO OBSERVATIONS block. Off, byte-identical to
// before this lane: no captions or summary reach the model. The
// `reportPhotoContent` gates-map entry above is for logGateStatus only.
function reportPhotoContentLive() {
  return process.env.GATE_REPORT_PHOTO_CONTENT === 'true';
}

// GATE_ADMIN_MFA / GATE_ADMIN_MFA_ENFORCE read at CALL time — strict
// `=== 'true'`, ships DARK. The ONLY readers (server/services/staff-mfa.js):
// off, every persisted enrollment is ignored, so unset is the kill switch and
// needs no redeploy. Enforce is honoured only while the master gate is on.
function adminMfaLive() {
  return process.env.GATE_ADMIN_MFA === 'true';
}

function adminMfaEnforceLive() {
  return adminMfaLive() && process.env.GATE_ADMIN_MFA_ENFORCE === 'true';
}

// GATE_TYPED_DECISIONS read at CALL time — ships DARK, off unless set
// (gateEnvValue: true / 1 / on). Off, askPackage (typed-decisions/jev.js)
// returns { ok:false, reason:'gate_off' } before any provider call, so a flip
// needs no redeploy and unset is the kill.
function typedDecisionsLive() {
  return gateEnvValue('GATE_TYPED_DECISIONS');
}

// GATE_CALL_INCIDENTS read at CALL time — ships DARK, off unless set, and
// honoured only while GATE_CALL_SELF_AUDIT is on (its findings are the
// evidence). Off, the nightly adjudicator and the Sunday call proposer return
// before any read or provider call; unset is the kill, no redeploy.
function callIncidentsLive() {
  return gateEnvValue('GATE_CALL_INCIDENTS') && process.env.GATE_CALL_SELF_AUDIT === 'true';
}

// GATE_TYPED_DECISIONS_CLEF read at CALL time — ships DARK, off unless set,
// and honoured only while GATE_TYPED_DECISIONS is also live (the second
// provider answers the same packages into the same review lane). Off,
// askPackage(..., { provider: 'cloudflare' }) returns gate_off before any
// provider call; unset is the kill, no redeploy.
function typedDecisionsClefLive() {
  return typedDecisionsLive() && gateEnvValue('GATE_TYPED_DECISIONS_CLEF');
}

// GATE_VISIT_ACCESS_FLAGS read at CALL time — ships DARK, live only when it
// is exactly 'shadow' AND GATE_TYPED_DECISIONS is live (the sweep's answers
// are decision_reviews rows). Off, the visit-access sweep
// (typed-decisions/visit-access-shadow.js) returns before any read or
// provider call; unset is the kill, no redeploy. Shadow is the only mode this
// gate has: nothing reaches a technician's card yet.
function visitAccessShadowLive() {
  return typedDecisionsLive() && String(process.env.GATE_VISIT_ACCESS_FLAGS || '').trim().toLowerCase() === 'shadow';
}

// GATE_PHOTO_PRIVACY read at CALL time: 'shadow' while the variable says
// shadow AND the Clef typed-decision leg is live (the photo questions go to
// Clef only), otherwise 'off'. `suggest` and `act` are not built: any other
// value is off, so a later mode can never switch on by a typo. Unset is the
// kill, no redeploy.
function photoPrivacyMode() {
  if (!typedDecisionsClefLive()) return 'off';
  return String(process.env.GATE_PHOTO_PRIVACY || '').toLowerCase() === 'shadow' ? 'shadow' : 'off';
}

// GATE_LAWN_JEV_TIMING_CHECK read at CALL time: 'shadow', 'enforce' or 'off'.
// The Jev result-timing check on the model-written lawn diagnosis summary
// (services/service-report/lawn-jev-timing-check.js). Any other value is off.
// Unset is the kill, no redeploy.
function lawnJevTimingCheckMode() {
  const raw = String(process.env.GATE_LAWN_JEV_TIMING_CHECK || '').trim().toLowerCase();
  return raw === 'shadow' || raw === 'enforce' ? raw : 'off';
}

// GATE_PREPAY_MINT_PRICE_HOLD read at CALL time: 'shadow', 'true' or 'off'.
// The stamp-time price check (annual-prepay-renewals.js holdPriceDriftedRows)
// for annual prepay terms that are not a /secure pick. 'shadow' records each
// covered visit's price when a term is created and only logs a visit the
// check would hold; 'true' also holds it. Any other value is off: nothing is
// recorded or read. Unset is the kill, no redeploy.
// GATE_SPRAY_RAIN_RULES read at CALL time: 'shadow' or 'true', anything else is off.
function sprayRainRulesMode() {
  const value = String(process.env.GATE_SPRAY_RAIN_RULES || '').trim().toLowerCase();
  return value === 'shadow' || value === 'true' ? value : 'off';
}

function prepayMintPriceHoldMode() {
  const value = String(process.env.GATE_PREPAY_MINT_PRICE_HOLD || '').trim().toLowerCase();
  return value === 'shadow' || value === 'true' ? value : 'off';
}

// GATE_REPORT_WRITER_RULES read at CALL time — off unless exactly 'true'.
// On, POST /generate-report (admin-schedule.js) gives every report writer
// except lawn and tree/shrub/palm the owner rules block, withholds product
// names, rates and footage from the model, labels and scrubs customer
// messages, and screens the output for what the rules forbid
// (server/services/service-report/report-writer-rules.js). Off, prompts,
// inputs and screens are byte-identical to before this lane.
function reportWriterRulesLive() {
  return process.env.GATE_REPORT_WRITER_RULES === 'true';
}

// GATE_PEST_REPORT_VOICE read at CALL time — strict `=== 'true'`, dark in
// every environment. On (with GATE_REPORT_WRITER_RULES), the recurring pest
// report writer gets one prompt in one voice (service-report/pest-report-voice.js)
// in place of its stacked blocks; inputs and output screens are unchanged.
// Off, the pest prompt is byte-identical to before.
function pestReportVoiceLive() {
  return process.env.GATE_PEST_REPORT_VOICE === 'true';
}

// GATE_PEST_QUIET_VISIT read at CALL time — strict `=== 'true'`, dark in
// every environment. On (with GATE_REPORT_WRITER_RULES and
// GATE_PEST_REPORT_VOICE), the one-voice pest writer gets pest_report_voice_v2:
// a quiet visit opens on what we saw and where we worked, never on what the
// customer did not say, and the route stops sending its empty "None" input
// lines and the sheet's customer-home setting. Off, v1 is byte-identical.
function pestQuietVisitLive() {
  return process.env.GATE_PEST_QUIET_VISIT === 'true';
}

// GATE_COMPLETION_TEXT_PLAIN read at CALL time — off unless exactly 'true'.
// On, the completion recap text (server/services/completion-recap.js) makes
// no AI call for a completed visit with nothing visit-specific recorded and
// sends a short fixed text instead of seasonal filler; the fixed text drops
// the generic "normal activity" sentence and says "checked your stations" on
// a station visit instead of "we treated". Off, byte-identical.
function completionTextPlainLive() {
  return process.env.GATE_COMPLETION_TEXT_PLAIN === 'true';
}

// GATE_REPORT_BLOG_POST read at CALL time — strict `=== 'true'`, dark in
// every environment. Off, the blog search answers unavailable, a picked post
// is ignored at completion and no report shows one (frozen picks included).
function reportBlogPostLive() {
  return process.env.GATE_REPORT_BLOG_POST === 'true';
}

// GATE_TECH_TIP_SOURCES read at CALL time — strict `=== 'true'`, dark in
// every environment (owner 2026-10-24, "tips with facts"). On: a sourced tip
// freezes its sourced words and citations, and the live report prints the
// citations as links. Off: the freeze and the report are unchanged.
function techTipSourcesLive() {
  return process.env.GATE_TECH_TIP_SOURCES === 'true';
}

// GATE_REPORT_ASK_AI read at CALL time — strict `=== 'true'`, dark in every
// environment. Off, POST /api/reports/:token/ask answers with the fixed-rule
// text alone and makes no model call.
function reportAskAiLive() {
  return process.env.GATE_REPORT_ASK_AI === 'true';
}

// GATE_REPORT_PLAN_RESCHEDULE read at CALL time — strict `=== 'true'`, dark in
// every environment. On, the service report merges "Your plan" with "Your
// upcoming visits" and each visit carries a Reschedule link.
function reportPlanRescheduleLive() {
  return process.env.GATE_REPORT_PLAN_RESCHEDULE === 'true';
}

// GATE_LAWN_REPORT_CLARITY read at CALL time — strict `=== 'true'`, dark in every
// environment. On, a water-in frozen at completion with no sprinkler setup on file
// gives the amount and no minutes, and a lawn report's plan card shows only the
// next lawn visit. Off, both stay exactly as before.
function lawnReportClarityLive() {
  return process.env.GATE_LAWN_REPORT_CLARITY === 'true';
}

// GATE_STANDARD_WORDING_PREVIEW read at CALL time — strict `=== 'true'`, dark
// in every environment. Off, the preview route answers { available: false }.
function standardWordingPreviewLive() {
  return process.env.GATE_STANDARD_WORDING_PREVIEW === 'true';
}

// GATE_BLOG_SEARCH_SUGGEST read at CALL time — strict `=== 'true'`, dark in
// every environment. Off, the blog search answers suggest:false, the
// suggestion route answers 404 and the queue claims no queued suggestion.
function blogSearchSuggestLive() {
  return process.env.GATE_BLOG_SEARCH_SUGGEST === 'true';
}

// GATE_RELAY_UNBOOKED_HANDOFF read at CALL time — ships DARK, off unless
// exactly 'true'. The one reader for Sandy's unbooked-call hand-off.
function relayUnbookedHandoffLive() {
  return process.env.GATE_RELAY_UNBOOKED_HANDOFF === 'true';
}

// GATE_VOICE_RELAY_OPENAI read at CALL time — the one reader every entry
// point into a non-Anthropic voice-relay session model must use: the session
// allowlist (relay-conversation.js's resolveSessionModel/isAllowedOverride
// Model), the eval harness (voice-relay-replay.js), and the benchmark runner
// (run-voice-relay-benchmark.js), so a candidate OpenAI model is accepted
// consistently across inbound, sandbox and eval alike. Unset (the production
// default) or any spelling other than exactly 'true' keeps every non-
// Anthropic override rejected — the existing reject → fallback → warn-once →
// stamped model_fallback_reason path applies unchanged.
function voiceRelayOpenaiLive() {
  return process.env.GATE_VOICE_RELAY_OPENAI === 'true';
}

// GATE_VOICE_RELAY_OPENAI_INBOUND read at CALL time — ships DARK, off unless
// exactly 'true' (owner ruling 2026-09-28: GPT-6 Luna for Sandy's inbound
// phone agent after the benchmark). The ONE reader relay-conversation.js's
// resolveSessionModel uses, at session construction, to decide whether a
// PRODUCTION inbound session (sandbox === false, evalHarness === false) may
// resolve VOICE_RELAY_INBOUND_MODEL to a voice-eligible OpenAI id — a
// DELIBERATELY SEPARATE gate from voiceRelayOpenaiLive() above, which is
// already live in prod for the sandbox/eval lane and must never be read as
// authorizing production inbound. Off: production inbound rejects any
// OpenAI override exactly as before this gate existed — byte-identical. On:
// the model-switchboard's voice_relay row (inboundOverrideParse /
// inboundOverrideAllowed) reads this same function so the Models tab shows
// what production inbound actually resolves.
function voiceRelayOpenaiInboundLive() {
  return process.env.GATE_VOICE_RELAY_OPENAI_INBOUND === 'true';
}

// GATE_LEAD_INSPECTION_LINK read at CALL time — strict `=== 'true'`, same
// convention as discountStackingLive(). The `leadInspectionLink` gates-map
// entry above is for logGateStatus only; this is the one canonical reader
// every caller (the public page route, buildLeadConsultationLink, and the
// new_lead email runner) must use, so none of them can drift from what an
// admin flip actually does.
// GATE_RECURRING_SERIES_TOPUP read at CALL time — strict `=== 'true'`, same
// convention as discountStackingLive() / leadInspectionLinkLive(). The
// `recurringSeriesTopUp` gates-map entry above is for logGateStatus only;
// this is the one canonical reader the nightly cron (scheduler.js) and the
// one-shot ops script (scripts/recurring-series-topup.js) both use, so a
// flip is a live kill/enable with no redeploy and neither caller can drift
// on what "on" means.
function recurringSeriesTopUpLive() {
  return process.env.GATE_RECURRING_SERIES_TOPUP === 'true';
}

// Same live-read contract as recurringSeriesTopUpLive: a flip is a live
// kill/enable with no redeploy. Kill = unset GATE_CANCEL_RESEEDS_RECURRING.
function cancelReseedsRecurringLive() {
  return process.env.GATE_CANCEL_RESEEDS_RECURRING === 'true';
}

// GATE_RATE_REVIEW read at CALL time — strict `=== 'true'`, same convention
// as cancelReseedsRecurringLive(). The one reader for the monthly cron tick
// (scheduler.js), the batch builder (services/rate-review.js) and the admin
// routes (routes/admin-rate-review.js), so a flip is a live kill/enable
// with no redeploy. The `rateReview` gates-map entry above is for
// logGateStatus only. Kill = unset GATE_RATE_REVIEW.
function rateReviewLive() {
  return process.env.GATE_RATE_REVIEW === 'true';
}

// GATE_PLAN_RATE_LEDGER_RECONCILE read at CALL time — strict `'true'` only, so an unset variable is the
// kill switch. The one reader for the nightly tick (scheduler.js, checked before the cron lock) and the
// run itself (services/plan-rate-ledger-reconcile.js). Live only while GATE_PLAN_RATE_LEDGER is on too
// (gates.planRateLedger, the value every ledger writer reads): with the ledger advisory, lines that
// disagree with the billed rate are expected pre-flip data, not a defect, and parking them would bake
// half-collected data into the lines a later flip bills. Off = no query, no write, no alert.
function planRateLedgerReconcileLive() {
  return process.env.GATE_PLAN_RATE_LEDGER_RECONCILE === 'true' && gates.planRateLedger === true;
}

// Same live-read contract. Kill = unset GATE_CANCEL_RESEED_IN_TERM (the
// reseed then appends at the series end, as before).
function cancelReseedInTermLive() {
  return process.env.GATE_CANCEL_RESEED_IN_TERM === 'true';
}

// GATE_COMMERCIAL_SUITE_SIZING read at CALL time — strict `=== 'true'`,
// same convention as recurringSeriesTopUpLive(). The one reader for both
// suite-sizing entry points (performPropertyLookup's opt-in and the
// estimator engine's own resolve), so a flip is a live kill/enable.
function commercialSuiteSizingLive() {
  return process.env.GATE_COMMERCIAL_SUITE_SIZING === 'true';
}

// GATE_CONDO_UNIT_FOLIO read at CALL time — strict `=== 'true'`, same
// convention as commercialSuiteSizingLive().
function condoUnitFolioLive() {
  return process.env.GATE_CONDO_UNIT_FOLIO === 'true';
}

function leadInspectionLinkLive() {
  return process.env.GATE_LEAD_INSPECTION_LINK === 'true';
}

// GATE_AUTO_DISPATCH_SHARED_MODEL read at CALL time via gateEnvValue (same
// convention as GATE_ROUTE_TIERS / GATE_DRIVE_TIME_CALIBRATION — it moves
// the numbers auto-dispatch ranks placements with, so the flip is deliberate
// in every environment and needs no redeploy). The one canonical reader for
// every entry point: candidate-slots.js (current-placement scoring + the
// writer-agreement pre-filter), scoring.js (the clustering term), and
// apply.js (the SLOT_TAKEN next-candidate fallback). The `autoDispatchSharedModel`
// gates-map entry above is for logGateStatus only.
function autoDispatchSharedModelLive() {
  return gateEnvValue('GATE_AUTO_DISPATCH_SHARED_MODEL');
}

// GATE_AUTO_DISPATCH_ARRIVAL_SEARCH read at CALL time: 'shadow', 'true' or
// 'off' (any other value; unset is the kill, no redeploy). The one canonical
// reader; the `autoDispatchArrivalSearch` gates-map entry above is for
// logGateStatus only. auto-dispatch/config.js also requires the shared model.
function autoDispatchArrivalSearchMode() {
  const value = String(process.env.GATE_AUTO_DISPATCH_ARRIVAL_SEARCH || '').trim().toLowerCase();
  return value === 'shadow' || value === 'true' ? value : 'off';
}

// GATE_AUTO_DISPATCH_DAY_RULES read at CALL time via gateEnvValue: unset is
// the kill, no redeploy. The one canonical reader for the night tool
// (auto-dispatch/config.js), the departure time (scheduling/departure-time.js)
// and the staff strip's Sunday label (find-time-hints.js). The
// `autoDispatchDayRules` gates-map entry above is for logGateStatus only.
function autoDispatchDayRulesLive() {
  return gateEnvValue('GATE_AUTO_DISPATCH_DAY_RULES');
}

// GATE_AUTO_DISPATCH_KEEP_TECH read at CALL time - strict `=== 'true'`. The
// one reader for the night run (auto-dispatch/config.js resolves it once per
// run as `config.keepTech`; candidate-slots.js and apply.js read that). The
// `autoDispatchKeepTech` gates-map entry above is for logGateStatus only.
function autoDispatchKeepTechLive() {
  return process.env.GATE_AUTO_DISPATCH_KEEP_TECH === 'true';
}

// GATE_AUTO_DISPATCH_CATCH_UP read at CALL time - strict `=== 'true'`. The one
// reader for the 05:00 catch-up job in scheduler.js. The `autoDispatchCatchUp`
// gates-map entry above is for logGateStatus only.
function autoDispatchCatchUpLive() {
  return process.env.GATE_AUTO_DISPATCH_CATCH_UP === 'true';
}

// GATE_ESTIMATE_CONSULTATION_OFFER read at CALL time — strict `=== 'true'`,
// same convention as leadInspectionLinkLive(). The `estimateConsultationOffer`
// gates-map entry above is for logGateStatus only; this is the one canonical
// reader server/services/estimate-consultation-offer.js uses. The offer
// additionally requires leadInspectionLinkLive() (the /inspection/:token page
// itself must be live too) — checked by the builder, not duplicated here.
// GATE_ESTIMATE_OFFER_TIERS read at CALL time — strict `'true'` only.
function estimateOfferTiersLive() {
  return process.env.GATE_ESTIMATE_OFFER_TIERS === 'true';
}

function estimateConsultationOfferLive() {
  return process.env.GATE_ESTIMATE_CONSULTATION_OFFER === 'true';
}

// GATE_ESTIMATE_EMAIL_CONSULTATION_OFFER read at CALL time — strict
// `=== 'true'`, same convention as estimateConsultationOfferLive(). The
// `estimateEmailConsultationOffer` gates-map entry above is for
// logGateStatus only; this is the one canonical reader
// server/services/estimate-email-consultation-offer.js uses. Like the page
// offer, this additionally requires leadInspectionLinkLive() (checked
// inside the shared estimateConsultationLead eligibility, not duplicated
// here).
function estimateEmailConsultationOfferLive() {
  return process.env.GATE_ESTIMATE_EMAIL_CONSULTATION_OFFER === 'true';
}

// GATE_RESERVICE_DETAILS_REQUIRED read at CALL time — the one canonical
// reader (server/routes/reservice-public.js GET + POST). Strict 'true'.
function reserviceDetailsRequiredLive() {
  return process.env.GATE_RESERVICE_DETAILS_REQUIRED === 'true';
}

// GATE_REFERRAL_INBOUND_CONFIRM read at CALL time, strict `=== 'true'`, dark by default. The one reader for the Referrals Queue's
// inbound list and its confirm / dismiss actions (routes/admin-referrals-v2.js, services/referral-inbound.js).
// Off: GET /inbound answers enabled:false with no list, both actions 404, and the page shows no section. Kill: unset.
function referralInboundConfirmLive() {
  return process.env.GATE_REFERRAL_INBOUND_CONFIRM === 'true';
}

// GATE_REFERRAL_INBOUND_BELL read at CALL time, strict `=== 'true'`, dark by default. The one reader for the new-referral
// bell row and its buttons (services/referral-inbound-bell.js, the scheduler's referral-inbound-bell job). It acts only
// while referralInboundConfirmLive() is true too. Off: no row is raised, open rows serve no buttons, a tap answers 409. Kill: unset.
function referralInboundBellLive() {
  return process.env.GATE_REFERRAL_INBOUND_BELL === 'true';
}

// GATE_ALERT_CLOSE_BUTTONS read at CALL time, strict `=== 'true'`, dark by default. The one reader for the close_note
// button kind (services/admin-alert-buttons.js): Handled on a customer's texts, Called back on a call-back follow-up
// and a missed call. Off: those rows serve no such button and a tap answers 409. Kill: unset.
function alertCloseButtonsLive() {
  return process.env.GATE_ALERT_CLOSE_BUTTONS === 'true';
}

// GATE_BID_ALERT_BUTTONS read at CALL time, strict `=== 'true'`, dark by default. The one reader for the bid_decision
// button kind (services/bid-desk/alert-buttons.js): No bid on a new bid invite's bell row, Bid once its due date is
// confirmed. Off: those rows serve no such button and a tap answers 409. Kill: unset.
function bidAlertButtonsLive() {
  return process.env.GATE_BID_ALERT_BUTTONS === 'true';
}

// GATE_RESERVICE_PHOTOS read at CALL time — the one canonical reader
// (server/routes/reservice-public.js). Strict 'true', and only alongside
// GATE_VISIT_PREP_PHOTOS (the storage and tech surfaces it rides).
function reservicePhotosLive() {
  return process.env.GATE_RESERVICE_PHOTOS === 'true' && visitPrepPhotosLive();
}

// GATE_RESERVICE_RANK_AFTER_NEW read at CALL time — the one canonical
// reader buildBookingAvailability's reservice rank-profile branch uses
// (server/routes/booking.js). The `reserviceRankAfterNew` gates-map entry
// above is for logGateStatus only.
function reserviceRankAfterNewLive() {
  return gateEnvValue('GATE_RESERVICE_RANK_AFTER_NEW');
}

// GATE_BOOK_CAPACITY_COMMIT read at CALL time — the one canonical reader
// createSelfBooking's commit-time capacity re-check uses (server/routes/booking.js).
// The `bookCapacityCommit` gates-map entry above is for logGateStatus only.
// Also requires GATE_SCHEDULING_CAPACITY (scheduling/policy.js's capacityEnabled())
// — the call site checks both, since re-running the whole-route placement
// evaluation only makes sense once the offer itself comes from that model.
function bookCapacityCommitLive() {
  return gateEnvValue('GATE_BOOK_CAPACITY_COMMIT');
}

// GATE_BOOK_ARRIVAL_GRACE read at CALL time — the one canonical reader
// /book's offer builder (routes/booking.js buildBookingAvailability),
// find-time's packCapacityEnds opt-in, and createSelfBooking's commit share
// (services/scheduling/book-arrival-grace.js). The `bookArrivalGrace`
// gates-map entry above is for logGateStatus only. Callers additionally
// require bookInsertionOffersLive() (GATE_BOOK_CAPACITY_COMMIT AND
// GATE_SCHEDULING_CAPACITY) and a positive selfServeArrivalGraceMinutes().
function bookArrivalGraceLive() {
  return gateEnvValue('GATE_BOOK_ARRIVAL_GRACE');
}

// GATE_CUSTOMER_ROUTE_CHECK read at CALL time (owner 2026-10-29, "start the
// builds"): 'shadow' or 'true', anything else (unset too) is off. Returns
// 'off' | 'shadow' | 'on'. Customer-facing time lists run the dispatcher's
// 2-hour arrival-window route check as a drop-only filter
// (services/scheduling/customer-route-check.js). shadow = compute and log,
// serve today's list; on = drop only the starts that would make ANOTHER
// customer arrive after their window. Unset is the kill, no redeploy.
function customerRouteCheckMode() {
  const value = String(process.env.GATE_CUSTOMER_ROUTE_CHECK || '').trim().toLowerCase();
  if (value === 'shadow') return 'shadow';
  return value === 'true' ? 'on' : 'off';
}

// GATE_REVIEW_NAME_MATCH_V2 read at CALL time (owner 2026-10-31, review matching plan PR 3):
// 'off' | 'shadow' | 'on'. After each hourly review sync, services/review-name-match.js scores every
// live Google review against every customer (names, first known contact, activity) and records the
// decision on google_reviews.name_match_*. shadow = score and log the counts, write nothing; on =
// write the decisions, which the Reviews match queue lists for one tap. Nothing links, marks or
// sends either way. Unset is the kill, no redeploy.
function reviewNameMatchMode() {
  const value = String(process.env.GATE_REVIEW_NAME_MATCH_V2 || '').trim().toLowerCase();
  if (value === 'shadow') return 'shadow';
  return value === 'true' ? 'on' : 'off';
}

// GATE_REVIEW_PROBABLE_REVIEWER_GUARD read at CALL time (owner 2026-10-31, review matching plan
// PR 4): 'true' = every review ask, at the moment it would leave and inside the per-customer
// review-send lock, also stops when the customer probably already left a Google review: an open
// review-matcher decision names them (services/review-name-match.js; a person's Dismiss closes it;
// services/review-click-guard.js). Covers the first-ask lock. Unset = today's guard, no redeploy.
function reviewProbableReviewerGuardLive() {
  return String(process.env.GATE_REVIEW_PROBABLE_REVIEWER_GUARD || '').trim().toLowerCase() === 'true';
}

// GATE_ASSISTANT_ROUTE_TIMES read at CALL time (owner 2026-10-29, "start the
// builds", Route Check Everywhere build 3c). The portal assistant's
// check_availability and the text drafter's city-based OPEN TIMES fallback
// (services/scheduling/assistant-route-times.js) read the customer pages' time
// list instead of the by-city zone finder. 'off' (unset or any other value) is
// today's finder byte for byte; 'shadow' computes both, logs the difference
// and serves the finder's; 'on' (GATE_ASSISTANT_ROUTE_TIMES=true) serves the
// customer pages' list in the finder's response shape.
function assistantRouteTimesMode() {
  const value = String(process.env.GATE_ASSISTANT_ROUTE_TIMES || '').trim().toLowerCase();
  if (value === 'shadow') return 'shadow';
  return value === 'true' ? 'on' : 'off';
}

// GATE_MULTI_TECH_CONFIRM read at CALL time — the one canonical reader for the
// tech-aware confirm-side conflict scope (scheduling/occupancy.js
// techScopedConfirmActive; owner 2026-10-30: it no longer also requires
// GATE_SCHEDULING_CAPACITY, so the gate alone scopes in hour mode, and the offer
// sites scope on capacity mode OR this gate). The `multiTechConfirm`
// gates-map entry above is for logGateStatus only.
function multiTechConfirmLive() {
  return gateEnvValue('GATE_MULTI_TECH_CONFIRM');
}

// GATE_ROUTE_ORDER_TIME_FALLBACK read at CALL time - strict `=== 'true'`. The one reader for
// arrival-route.js placeInSavepoint (owner 2026-11-01, "build fixes", dispatch lane F1): when the
// route check REFUSES to place a visit, the visit is numbered by its arrival time among the
// day's numbered stops instead of keeping route_order NULL (which lists it last). Off = the
// refusal leaves the number empty, byte-identical to before.
function routeOrderTimeFallbackLive() {
  return process.env.GATE_ROUTE_ORDER_TIME_FALLBACK === 'true';
}

// GATE_ADS_CAPACITY_WORK_DAYS read at CALL time - strict `=== 'true'`. The one
// reader for BudgetManager.getTechCountForArea: on, a dated capacity count skips
// a technician on a date they are absent or do not work; off, every assignable
// technician counts every day (byte-identical to before).
function adsCapacityWorkDaysLive() {
  return process.env.GATE_ADS_CAPACITY_WORK_DAYS === 'true';
}

// GATE_ADS_GAP_RULE read at CALL time: 'shadow' -> 'shadow', 'true' -> 'live', anything else (unset, 'false', 'live') -> 'off'.
// BudgetManager.adjustBudgets and the /api/admin/ads/gap-rule routes read it. Off = the one-day capacity rule, byte-identical.
function adsGapRuleMode() {
  const v = String(process.env.GATE_ADS_GAP_RULE || '').trim().toLowerCase();
  if (v === 'shadow') return 'shadow';
  if (v === 'true') return 'live';
  return 'off';
}

// GATE_TECH_WORK_DAYS read at CALL time - strict `=== 'true'`. The one reader for
// technicians.work_days (services/technician-eligibility.js): on, a technician
// is skipped by slot offers and automatic placement on a day they do not work;
// off, work_days is ignored everywhere (byte-identical to before).
function techWorkDaysLive() {
  return process.env.GATE_TECH_WORK_DAYS === 'true';
}

// GATE_TECH_JOB_TYPE_CHECKS read at CALL time - strict `=== 'true'`. The one reader for the
// catalog-first job type of a visit (services/technician-capabilities.js) and the office
// "set to Off for this job type" warning (services/technician-eligibility.js): off, both
// are byte-identical to before.
function techJobTypeChecksLive() {
  return process.env.GATE_TECH_JOB_TYPE_CHECKS === 'true';
}

// GATE_SECOND_TECH_LOWS read at CALL time - strict `=== 'true'`. The one reader for census
// lows L1 (admin dashboard tech utilization counts assignable staff on their work days,
// routes/admin-dashboard.js) and L3 (Intelligence Bar schedule tools resolve a technician
// by name through resolveTechnicianByName, services/intelligence-bar/schedule-tools.js):
// off, both are byte-identical to before.
function secondTechLowsLive() {
  return process.env.GATE_SECOND_TECH_LOWS === 'true';
}

// GATE_ALERT_RETENTION read at CALL time: 'shadow', 'true' or 'off' (services/admin-alert-retention.js).
// 'shadow' (trimmed, any case) judges every candidate and records one audit_log summary row, changing
// nothing; 'true' marks the expired rows done. Anything else is off: no query. Unset is the kill.
function alertRetentionMode() {
  const value = String(process.env.GATE_ALERT_RETENTION || '').trim().toLowerCase();
  return value === 'shadow' || value === 'true' ? value : 'off';
}

// GATE_ALERT_CATALOG read at CALL time: 'watch' or 'off' (NotificationService.create). 'watch' (trimmed, any
// case) writes one audit_log row per Eastern day per distinct admin alert the bell policy silences, and
// refuses nothing. Anything else is off: no read, no write. Unset is the kill.
function alertCatalogMode() {
  return String(process.env.GATE_ALERT_CATALOG || '').trim().toLowerCase() === 'watch' ? 'watch' : 'off';
}

// GATE_PROMISE_RECORD_EVIDENCE read at CALL time: 'shadow', 'true' or 'off' (services/sms-commitment-fulfillment.js
// and sms-operational-actions.js). 'shadow' (trimmed, any case) records what would change and changes nothing;
// 'true' applies it. Anything else is off. Unset is the kill.
function promiseRecordEvidenceMode() {
  const value = String(process.env.GATE_PROMISE_RECORD_EVIDENCE || '').trim().toLowerCase();
  return value === 'shadow' || value === 'true' ? value : 'off';
}

// GATE_SMS_COURTESY_TAIL read at CALL time: 'shadow', 'true' or 'off' (isCourtesyOnly in
// services/sms-intent.js). 'shadow' (trimmed, any case) leaves every result alone and lets the
// inbound webhook stamp metadata.courtesyTailWould; 'true' applies the courtesy-tail rule
// ("Perfect. Go browns" closes the thread). Anything else is off. Unset is the kill.
function courtesyTailMode() {
  const value = String(process.env.GATE_SMS_COURTESY_TAIL || '').trim().toLowerCase();
  return value === 'shadow' || value === 'true' ? value : 'off';
}

// GATE_AUTOPAY_HOLD_TIMEOUT read at CALL time: 'shadow', 'true', 'charge' or 'off' (releaseStaleAutopayHolds in
// services/invoice-followups.js). 'shadow' (trimmed, any case) records what would be released and
// changes nothing; 'true' releases stale Auto Pay holds; 'charge' (owner 2026-10-28) charges the customer's
// saved Auto Pay card or bank for a stale hold first, and releases it only when that charge was declined or
// refused. 'charge' moves money: the owner flips it. Anything else is off: no query. Unset is the kill.
function autopayHoldTimeoutMode() {
  const value = String(process.env.GATE_AUTOPAY_HOLD_TIMEOUT || '').trim().toLowerCase();
  return value === 'shadow' || value === 'true' || value === 'charge' ? value : 'off';
}

// GATE_SERVICE_LINE_MAP read at CALL time: 'shadow', 'live' or 'off' (exactly, trimmed, any
// case). 'shadow' lets the six booking choice points record what the service-line map
// (services/scheduling/line-technician.js) would pick next to what was actually chosen, in
// service_line_pick_shadow. 'live' (build 4) keeps those rows and also makes the map pick:
// a mapped line's new work goes to its home technician, else its gap technician
// (lineOfferRanking / pickLineTechnician). Anything else, 'true' included, is off: no
// resolver call, no query. Unset is the kill, no redeploy.
function serviceLineMapMode() {
  const value = String(process.env.GATE_SERVICE_LINE_MAP || '').trim().toLowerCase();
  return value === 'shadow' || value === 'live' ? value : 'off';
}

// GATE_UNASSIGNED_VISIT_GUARD read at CALL time - strict `=== 'true'`. On: the office create
// modal's Auto technician choice resolves a real technician (or says it could not), and the
// daily 6:10 PM ET check reports timed unassigned visits in the next 3 days. Off = byte-identical.
function unassignedVisitGuardLive() {
  return process.env.GATE_UNASSIGNED_VISIT_GUARD === 'true';
}

// GATE_TERRITORY_ROUTING read at CALL time - strict `=== 'true'`. On: the service-line map
// (services/scheduling/line-technician.js) makes the technician who owns a visit's ZIP
// (territory_zips) the home technician of a pest, mosquito, rodent or termite line, in the
// map's shadow rows and live picks alike. Off = the line map byte-identical, no territory query.
function territoryRoutingLive() {
  return process.env.GATE_TERRITORY_ROUTING === 'true';
}

// GATE_TERRITORY_NIGHT_RUN read at CALL time - strict `=== 'true'`. On: the auto-dispatch night
// run (services/auto-dispatch/candidate-slots.js) keeps only the territory technician's slots
// for an unassigned pest, mosquito, rodent or termite visit whose ZIP has one (territory_zips).
// Off = byte-identical, no territory query.
function territoryNightRunLive() {
  return process.env.GATE_TERRITORY_NIGHT_RUN === 'true';
}

// GATE_TERRITORY_READOUT read at CALL time - strict `=== 'true'`. On: the Team tab's Territories card
// (routes/admin-timetracking.js GET /territory-readout): stops a week per technician and area. Read
// only. Off = no roster flag and the route answers 404.
function territoryReadoutLive() {
  return process.env.GATE_TERRITORY_READOUT === 'true';
}

// Fresh annual contracts require the term-aware cancellation path. Read both
// switches at call time so pricing, availability and delivery agree.
function termiteAnnualPlanSelectionEnabled() {
  return gateEnvValue('GATE_TERMITE_ANNUAL_PLAN') && gateEnvValue('GATE_CANCEL_FLOW_V2');
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

// GATE_ASK_WAVES_TOPIC_ROUTING read at CALL time — strict `=== 'true'`, same
// convention as estimateConsultationOfferLive(). The `askWavesTopicRouting`
// gates-map entry above is for logGateStatus only; this is the one canonical
// reader server/services/ask-waves-intake.js uses, so a flip (or an unset
// kill) needs no restart.
function askWavesTopicRoutingLive() {
  return process.env.GATE_ASK_WAVES_TOPIC_ROUTING === 'true';
}

// Same live-read convention for the #4899 emergency second opinion.
function askWavesEmergencyCheckLive() {
  return process.env.GATE_ASK_WAVES_EMERGENCY_CHECK === 'true';
}

// GATE_ASK_WAVES_JEV_CHECK read at CALL time: 'shadow', 'enforce' or 'off'.
// Anything else (unset, 'true', a typo) is off, so a mode can never switch on
// by accident; unset is the kill, no redeploy. askPackage itself still needs
// GATE_TYPED_DECISIONS.
function askWavesJevCheckMode() {
  const mode = String(process.env.GATE_ASK_WAVES_JEV_CHECK || '').trim().toLowerCase();
  return mode === 'shadow' || mode === 'enforce' ? mode : 'off';
}

// Email Template Automations shadow rollout — read at CALL time (same
// convention as askWavesTopicRoutingLive/askWavesEmergencyCheckLive above),
// so the executor's per-run shadow-vs-live decision needs no redeploy once
// the `emailTemplateAutomations` boolean gate above is already on. PROD:
// 'shadow' = runs created and finalized as would_send, nothing dispatched;
// 'true' = live sends; anything else (unset included) = off. NON-PROD:
// keeps today's default of 'live' (existing tests exercise the executor
// with the gate implicitly on) unless the env var explicitly overrides it —
// 'shadow' to exercise shadow mode locally, or an explicit false/off kill.
function emailTemplateAutomationsMode() {
  const raw = String(process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS || '').trim().toLowerCase();
  if (raw === 'shadow') return 'shadow';
  if (raw === 'true') return 'live';
  if (process.env.NODE_ENV === 'production') return 'off';
  return (raw === 'false' || raw === 'off') ? 'off' : 'live';
}

// GATE_VISIT_PREP_PHOTOS read at CALL time — strict `=== 'true'`, same
// convention as estimateConsultationOfferLive(). The one canonical reader
// for every entry point (appointment-public.js's new POST + the GET's
// additive prepPhotos summary, and services/visit-prep.js's eligibility
// check) so a flip or an unset kill needs no restart. The `visitPrepPhotos`
// gates-map entry above is for logGateStatus only.
function visitPrepPhotosLive() {
  return process.env.GATE_VISIT_PREP_PHOTOS === 'true';
}

// GATE_PLANT_ID_REFEREE read at CALL time — ships DARK, off unless exactly
// 'true' (owner ruling 2026-09-28, plant engine only — the pest engine's
// TEXT_POLICIES.photoIdVision ladder is untouched). The one canonical reader
// for plant-engine.js's runReferee(): on, a scope still unsure after the
// Gemini -> OpenAI Sol escalation gets one more look from Claude Fable 5.1 as
// a deciding vote. Off, byte-identical to the Gemini -> Sol ladder — no third
// call, no third-vote merge.
function plantIdRefereeLive() {
  return process.env.GATE_PLANT_ID_REFEREE === 'true';
}

// GATE_CALL_LEAD_FORM_ADDRESS_STREET_LEVEL read at CALL time — strict
// `=== 'true'`, ships DARK (owner ruling 2026-09-30). The one canonical reader
// for call-recording-processor.js's on-file verdict path: on, a web-form lead's
// on-file address Google confirms only to the street may still satisfy the
// on-file address rule (the booking is held pending for the office). Off, byte-identical
// to before — the verdict path never looks at street-level matches.
function callLeadFormAddressStreetLevelLive() {
  return process.env.GATE_CALL_LEAD_FORM_ADDRESS_STREET_LEVEL === 'true';
}

// GATE_BOOK_PREFERRED_TIME read at CALL time — strict `=== 'true'`, dark in
// every environment (owner 2026-09-29). The one canonical reader for the
// /book "Can't find a time?" block: POST /api/booking/preferred-time answers
// the generic 404 while it is off, and GET /api/booking/config only tells the
// page to render the block while it is on.
function bookPreferredTimeLive() {
  return process.env.GATE_BOOK_PREFERRED_TIME === 'true';
}

// GATE_LAWN_WATERING_RULE read at CALL time (same 1/true/on convention as
// gateEnvValue). The one canonical reader for the lawn report's watering
// instruction: report-data.js builds it from the frozen product rules and
// hands it to buildLawnReportV2. Off = the report payload is byte-identical
// to before (no banner, no product_instruction aftercare, no afterHold plan).
function lawnWateringRuleLive() {
  return gateEnvValue('GATE_LAWN_WATERING_RULE');
}

// GATE_LAWN_WATERING_FORECAST read at CALL time (same 1/true/on convention as
// gateEnvValue). Lawn report rebuild P30: the forecast-aware water-in sentence
// frozen at completion and the live-view rain close-out. Needs the watering
// instruction (GATE_LAWN_WATERING_RULE) to exist at all. Off = the write gate
// reads no forecast, the payload and PDF are byte-identical.
function lawnWateringForecastLive() {
  return gateEnvValue('GATE_LAWN_WATERING_FORECAST');
}

// GATE_LAWN_WATERING_TEXT_FORECAST read at CALL time (same 1/true/on convention
// as gateEnvValue). Owner 2026-10-22: the forecast sentence needs both sources
// (Open-Meteo amount + NWS "rain likely"), a timed hold then a water-in gets it
// for rain after the hold, and the watering text carries it. Needs
// GATE_LAWN_WATERING_FORECAST. Off = today's forecast sentence, byte for byte.
function lawnWateringTextForecastLive() {
  return gateEnvValue('GATE_LAWN_WATERING_TEXT_FORECAST');
}

// GATE_LAWN_WATERING_SHORT_TEXT read at CALL time (same 1/true/on convention
// as gateEnvValue). Owner 2026-10-23: the watering text is too wordy; send
// short steps from the same frozen fields. Off = today's text byte for byte.
function lawnWateringShortTextLive() {
  return gateEnvValue('GATE_LAWN_WATERING_SHORT_TEXT');
}

// GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_SEND read at CALL time (same 1/true/on
// convention as gateEnvValue). Owner 2026-10-26: a phone sale the office marks
// accepted gets the FDACS-13692 by email and text. Off = nothing is sent.
function manualAcceptConsumerNoticeSendLive() {
  return gateEnvValue('GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_SEND');
}

// GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_RECONCILE read at CALL time (same 1/true/on
// convention as gateEnvValue): the daily run re-sends a Mark accepted notice a
// restart lost. Off = no catch-up.
function manualAcceptConsumerNoticeReconcileLive() {
  return gateEnvValue('GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_RECONCILE');
}

// GATE_WARRANTY_13692_CHECK read at CALL time (same 1/true/on convention as
// gateEnvValue). Owner 2026-10-24: the warranty needs the signed FDACS-13692
// notice on file (Rule 5E-14.105(1)). Off = the typed date only, as before.
function warranty13692CheckLive() {
  return gateEnvValue('GATE_WARRANTY_13692_CHECK');
}

// GATE_ESTIMATE_CONSUMER_NOTICE read at CALL time (same 1/true/on convention as
// gateEnvValue). Owner 2026-10-25, Rule 5E-14.105(1): the customer signs the
// FDACS-13692 consumer notice on the estimate page before accepting a termite
// estimate. Off = the estimate page, /data and accept are byte-identical.
function estimateConsumerNoticeLive() {
  return gateEnvValue('GATE_ESTIMATE_CONSUMER_NOTICE');
}

// GATE_ESTIMATE_SERVICE_AGREEMENT read at CALL time (same 1/true/on convention as
// gateEnvValue). A signed service agreement for every residential recurring plan:
// the accepted estimate page offers the Residential Pest / Lawn & Ornamental
// Service Agreement for signing (estimate-service-agreement.js). Off = the accepted
// page, /data and the route are byte-identical.
function estimateServiceAgreementLive() {
  return gateEnvValue('GATE_ESTIMATE_SERVICE_AGREEMENT');
}

// GATE_AGREEMENT_RENEWAL_REMINDER read at CALL time (same 1/true/on convention as
// gateEnvValue). The daily warranty renewal reminder (warranty-renewal-reminder.js)
// also covers the Commercial Pest Service Agreement's 12-month auto-renewal while
// this is live: an office bell 45 days before each signed agreement's term ends.
// Off = the job reads and writes warranties only, exactly as before.
function agreementRenewalReminderLive() {
  return gateEnvValue('GATE_AGREEMENT_RENEWAL_REMINDER');
}

// GATE_PREPAY_YEAR_END_BELL read at CALL time (same 1/true/on convention as
// gateEnvValue). The daily renewal-reminder workflow also runs the prepaid-year-end
// office bell (prepay-year-end-bell.js) while this is live. Off = the job returns
// before any query. Office bell only: no customer text, email or charge.
function prepayYearEndBellLive() {
  return gateEnvValue('GATE_PREPAY_YEAR_END_BELL');
}

// GATE_LAWN_EXPECTATIONS read at CALL time (same 1/true/on convention as
// gateEnvValue). The one canonical reader for the lawn monthly program line:
// buildLawnReportV2 swaps snapshot.seasonalNote for the lawn program v13 month
// sentence (v13 visits only) while it is live. Off = the payload is
// byte-identical to before.
function lawnExpectationsLive() {
  return gateEnvValue('GATE_LAWN_EXPECTATIONS');
}

// GATE_LAWN_COVERAGE_HIDE_DEFAULT_ZONES read at CALL time (same 1/true/on
// convention as the other lawn report gates). Live: the lawn write gate freezes
// the coverage verdict at completion, and a render hides the coverage section
// (the A-D perimeter list under a satellite photo claimed marks nobody made)
// only when that frozen verdict says defaults only. No frozen verdict = shown as
// before. Off = the payload is byte-identical to before.
function lawnCoverageHideDefaultZonesLive() {
  return gateEnvValue('GATE_LAWN_COVERAGE_HIDE_DEFAULT_ZONES');
}

// GATE_LAWN_PROGRAM_DETAIL read at CALL time. Live (with GATE_LAWN_EXPECTATIONS,
// which supplies the month sentence it sits under): snapshot.seasonalDetail
// carries the month's whyNow line (lawn-program-line.js PROGRAM_DETAIL_V13).
// Off = byte-identical payload.
function lawnProgramDetailLive() {
  // Strict 'true' only (codex #6091 r1). The detail renders in the lead
  // layout's "This time of year" card.
  return process.env.GATE_LAWN_PROGRAM_DETAIL === 'true';
}

// GATE_LAWN_VISIT_MEMORY read at CALL time (same 1/true/on convention as
// gateEnvValue). The one canonical reader for the lawn treatment memory:
// report-data.js freezes the visit's entry and attaches reportV2.sinceLast only
// while it is live. Off = no reads, no writes, byte-identical payload.
function lawnVisitMemoryLive() {
  return gateEnvValue('GATE_LAWN_VISIT_MEMORY');
}

// GATE_LAWN_PAIRED_RECHECK read at CALL time (same 1/true/on convention as
// gateEnvValue). The one canonical reader for the paired-photo recheck
// (services/lawn-paired-recheck.js). THREE prerequisites, all required:
// GATE_LAWN_VISIT_MEMORY (it writes onto that store's frozen entry) and
// GATE_LAWN_PROPERTY_HISTORY (the prior visit exists only from the
// property-scoped history; without it the first render freezes sinceLast: null
// and the one chance this visit has to be rechecked would be spent for good).
// With any of them off it reports off: no hook, no extra model call, no photo
// read, no stored field, byte-identical payload.
function lawnPairedRecheckLive() {
  return gateEnvValue('GATE_LAWN_PAIRED_RECHECK') && lawnVisitMemoryLive() && gateEnvValue('GATE_LAWN_PROPERTY_HISTORY');
}

// GATE_LAWN_RAINFAST_WATCH read at CALL time (same 1/true/on convention as
// gateEnvValue). Lawn report rebuild P31: the rainfast breach watch
// (service-report/lawn-rainfast-watch.js). It writes onto the frozen visit
// memory entry, so GATE_LAWN_VISIT_MEMORY is a prerequisite. Off, or with the
// memory off: no weather read, no write, byte-identical payload.
function lawnRainfastWatchLive() {
  return gateEnvValue('GATE_LAWN_RAINFAST_WATCH') && lawnVisitMemoryLive();
}

// GATE_LAWN_DIAGNOSTIC_EVIDENCE read at CALL time (same 1/true/on convention).
function lawnDiagnosticEvidenceLive() {
  return gateEnvValue('GATE_LAWN_DIAGNOSTIC_EVIDENCE');
}

// GATE_LAWN_SINCE_LAST read at CALL time (same 1/true/on convention). The
// block needs the memory it reads, so this is false unless both gates are
// live.
function lawnSinceLastLive() {
  return gateEnvValue('GATE_LAWN_SINCE_LAST') && lawnVisitMemoryLive();
}

// GATE_LAWN_WATERING_SMS read at CALL time — strict `=== 'true'`, dark in every
// environment (customer messaging, explicit opt-in; owner 2026-09-30). The one
// canonical reader for the separate lawn watering text sent after the lawn
// completion text (services/service-report/lawn-watering-sms.js). The send
// also requires lawnWateringRuleLive(): no frozen instruction exists without
// it. Off = no extra reads and no structured_notes writes on completion.
function lawnWateringSmsLive() {
  return process.env.GATE_LAWN_WATERING_SMS === 'true';
}

// GATE_LAWN_WATERING_EVERY_VISIT read at CALL time — strict `=== 'true'`, dark
// in every environment (customer messaging, owner 2026-10-22). The one
// canonical reader for the every-combination watering rules: target rules and
// the label-first same-day rule when the instruction is built
// (service-report/report-data.js), and the "no watering change" text plus the
// office alert when the watering text goes out (lawn-watering-sms.js).
// It needs GATE_LAWN_WATERING_RULE: that kill switch off reads it as off
// everywhere, so the report and every other caller are back to the contracted
// payload (docs/public-route-contracts.md). The text and its office alert also
// need GATE_LAWN_WATERING_SMS, which lawn-watering-sms.js checks first.
function lawnWateringEveryVisitLive() {
  return process.env.GATE_LAWN_WATERING_EVERY_VISIT === 'true' && lawnWateringRuleLive();
}

// GATE_CALL_ADDRESS_ONFILE_ASSIST read at CALL time — strict `=== 'true'`, off
// by default. The one canonical reader for
// server/services/address-validation/onfile-assist.js. Off, the call pipeline
// is byte-identical: no extra street candidate, no on-file locality line, no
// out-of-state reclassification. The gates-map entry above is for
// logGateStatus only.
function callAddressOnFileAssistLive() {
  return process.env.GATE_CALL_ADDRESS_ONFILE_ASSIST === 'true';
}

// GATE_CALL_ROUTE_SPELLING_RETRY read at CALL time — strict `=== 'true'`, off
// by default. The one canonical reader for
// server/services/address-validation/recovery.js. Off, street recovery is
// byte-identical: no extra Address Validation request. The gates-map entry
// above is for logGateStatus only.
function callRouteSpellingRetryLive() {
  return process.env.GATE_CALL_ROUTE_SPELLING_RETRY === 'true';
}

// GATE_LAWN_ASSESSMENT_REFEREE read at CALL time — ships DARK, off unless
// exactly 'true' (owner ruling 2026-09-29). ONE gate covers both the GPT-6 Sol
// second opinion and the Claude Fable name referee in
// lawn-visit-assessment.js's analyzeVisit (the second opinion exists only to
// feed the referee). Off, analyzeVisit is byte-identical to the single
// Gemini -> Sol fallback chain: no extra call, same return shape.
function lawnAssessmentRefereeLive() {
  return process.env.GATE_LAWN_ASSESSMENT_REFEREE === 'true';
}

// GATE_BILLING_EMAIL_DETAILS read at CALL time — ships DARK, off unless exactly
// 'true' (owner-approved 2026-09-29). ONE gate covers every change of the
// billing-email-details lane: the extra detail rows on invoice.sent /
// invoice.receipt / billing.notice / billing.receipt_notice, the card label,
// attempt date and armed retry date on payment.failed, the Property row on the
// estimate follow-ups. The template
// blocks are variable-driven, so with the gate off no sender fills the new
// variables and every email renders exactly as before.
function billingEmailDetailsLive() {
  return process.env.GATE_BILLING_EMAIL_DETAILS === 'true';
}

// GATE_IB_CANCEL_APPOINTMENT read at CALL time — strict `=== 'true'`, same
// convention as discountStackingLive(). The one canonical reader for both
// entry points that need to know whether the Intelligence Bar may
// card-confirm a visit cancellation: proposePendingWrite (proposal site) and
// /confirm-action (confirm site) in routes/admin-intelligence-bar.js. Off =
// byte-identical to before this lane — cancel_appointment always refuses to
// the Dispatch screen (CANCEL_NOT_CARD_CONFIRMABLE_MESSAGE). The
// `ibCancelAppointment` gates-map entry above is for logGateStatus only.
function ibCancelAppointmentLive() {
  return process.env.GATE_IB_CANCEL_APPOINTMENT === 'true';
}

// GATE_IB_CANCEL_WITH_EFFECTS read at CALL time — strict `=== 'true'`, dark by default, and live only while
// GATE_IB_CANCEL_APPOINTMENT is also on. On: the bar cancels a visit that has an invoice, an inspection credit or a
// linked follow-up visit by replaying the Dispatch cancel handler (admin-dispatch.js cancelServiceFromBar). Off: the
// bar refuses those visits exactly as before.
function ibCancelWithEffectsLive() {
  return ibCancelAppointmentLive()
    && process.env.GATE_IB_CANCEL_WITH_EFFECTS === 'true';
}

// GATE_CUSTOMER_ACTIVITY_TIMELINE read at CALL time — strict `=== 'true'`, dark
// by default. The canonical reader for GET /api/admin/customers/:id/activity
// (routes/admin-customers.js); the admin panel hides itself on the route's
// `{ enabled: false }`. Read-only: no customer message, no write.
function customerActivityTimelineLive() {
  return process.env.GATE_CUSTOMER_ACTIVITY_TIMELINE === 'true';
}

// GATE_LEAD_EMAIL_LINKS read at CALL time — strict `=== 'true'`, dark by
// default. Read-only: widens which email_messages rows the Customer Activity
// timeline lists (mail sent to the customer's lead / estimate before they
// converted). Nothing is sent or written.
function leadEmailLinksLive() {
  return process.env.GATE_LEAD_EMAIL_LINKS === 'true';
}

// GATE_VISIT_PREP_TECH_ALERTS read at CALL time — strict `=== 'true'`, same
// convention as visitPrepPhotosLive(). The canonical reader for
// server/services/visit-prep-tech-alert.js. Deliberately independent of
// GATE_TECH_VISIT_NOTIFICATIONS (unset in production): this gate alone
// decides whether the customer-photos tech card/push go out, so it can be
// the first tech visit card to go live without also turning on assignment/
// reschedule/cancel cards. The service ALSO requires visitPrepPhotosLive()
// — see its own header for why.
function visitPrepTechAlertsLive() {
  return process.env.GATE_VISIT_PREP_TECH_ALERTS === 'true';
}

// GATE_HOME_LINE read at CALL time — strict `=== 'true'`. The canonical
// reader for the customer home line (twilio.js deriveOutboundNumber and the
// home-line sweep); the `homeLine` gates-map entry above is for
// logGateStatus only.
function homeLineLive() {
  return process.env.GATE_HOME_LINE === 'true';
}

// GATE_SMS_LINK_WRAP read at CALL time — strict `=== 'true'`, same convention
// as visitPrepPhotosLive(). The canonical reader for the sendCustomerMessage
// choke point's portal-link wrap (services/messaging/sms-link-wrap.js). Off =
// every SMS body byte-identical to before; the `smsLinkWrap` gates-map entry
// above is for logGateStatus only.
function smsLinkWrapLive() {
  return process.env.GATE_SMS_LINK_WRAP === 'true';
}

// GATE_EMAIL_APP_LINKS read at CALL time - strict `=== 'true'`. The canonical
// reader for services/messaging/email-link-policy.js. Off = every email link
// goes through SendGrid's click tracking, as before #7229.
function emailAppLinksLive() {
  return process.env.GATE_EMAIL_APP_LINKS === 'true';
}

// GATE_VISIT_PREP_PEST_READ read at CALL time — strict `=== 'true'`, own
// switch INSIDE the visit-prep gate (scope doc §5.6: "the read adapter has
// its own switch inside the gate so the pipe can go live before the
// read"). ALSO requires visitPrepPhotosLive() — the read has no meaning
// without the foundation it rides on, and a stray env flip of this gate
// alone (with the foundation gate unset) must not turn anything on. The
// canonical reader for services/visit-prep-pest-read.js; the
// visitPrepPestRead gates-map entry above is for logGateStatus only.
function visitPrepPestReadLive() {
  // Also needs the technician facts surface (GATE_VISIT_FACTS, read the
  // same way as previsit-brief.js visitFactsGateEnabled), the only place a
  // read is shown: without it a paid read would be invisible (Codex #5305 r8).
  return process.env.GATE_VISIT_PREP_PEST_READ === 'true' && visitPrepPhotosLive()
    && process.env.GATE_VISIT_FACTS === 'true';
}

// GATE_VISIT_PREP_PLANT_READ read at CALL time — strict `=== 'true'`, own
// switch, sibling of visitPrepPestReadLive() for the lawn / tree & shrub
// counterpart (photo-id-v2/plant-engine.js's identifyPlantV2 — merged L3,
// no customer route yet; this lane's own daily-cap claim is its only
// runtime caller today). ALSO requires visitPrepPhotosLive() and
// GATE_VISIT_FACTS, same convention and same reason as the pest read gate.
// The canonical reader for services/visit-prep-plant-read.js; the
// visitPrepPlantRead gates-map entry above is for logGateStatus only.
function visitPrepPlantReadLive() {
  return process.env.GATE_VISIT_PREP_PLANT_READ === 'true' && visitPrepPhotosLive()
    && process.env.GATE_VISIT_FACTS === 'true';
}

// GATE_VISIT_PREP_READ_SWEEP read at CALL time — strict `=== 'true'`, same
// convention as visitPrepPestReadLive(). The canonical reader for
// services/visit-prep-pest-read-sweep.js. ALSO requires
// a live read engine — visitPrepPestReadLive() or visitPrepPlantReadLive()
// (each cascades to visitPrepPhotosLive() and GATE_VISIT_FACTS) — a stray
// flip of this gate alone, with both read lanes dark, must retry nothing.
// The sweep re-dispatches through visit-prep-read-dispatch.js, which runs
// only the live engines. The visitPrepReadSweep gates-map
// entry above is for logGateStatus only.
function visitPrepReadSweepLive() {
  return process.env.GATE_VISIT_PREP_READ_SWEEP === 'true' && (visitPrepPestReadLive() || visitPrepPlantReadLive());
}

// GATE_STAMPED_ZERO_FREE read at CALL time — strict `=== 'true'`, same
// convention as discountStackingLive(). The canonical reader for
// billing-lane.js's hasAuthoritativeZeroPrice (widens it to ANY stamped 0,
// not just the discount-engine provenance shape) and for the handful of
// charge-fallback sites that compute a visit's amount without going
// through that resolver. Off = byte-identical to today everywhere.
// GATE_REVIEW_ALERT read at CALL time — strict `=== 'true'`, dark in every
// environment (the bad-review bell, services/review-low-rating-alert.js). The
// gates map entry is for logGateStatus only.
function reviewLowRatingAlertLive() {
  return process.env.GATE_REVIEW_ALERT === 'true';
}

function stampedZeroFreeLive() {
  return process.env.GATE_STAMPED_ZERO_FREE === 'true';
}

// GATE_PAY_AFTER_FIRST_VISIT read at CALL time — strict `=== 'true'`, dark in
// every environment. The canonical reader for estimate-public.js's SSR
// pay-after-first-visit wording (renderPage opts.payAfterFirstVisitCopy) and
// recurring-card-on-file.js's payAfterFirstVisitCardRail(). Copy only: it moves
// no money and sends no message. Off = byte-identical to today.
function payAfterFirstVisitLive() {
  return process.env.GATE_PAY_AFTER_FIRST_VISIT === 'true';
}

// Per-item sub-gates of GATE_PAY_AFTER_FIRST_VISIT, read at CALL time — each
// strict `=== 'true'` on its own var AND the master gate, so one item can
// roll out (or be killed) without the others and nothing is live while the
// master is off. Dark in every environment.
function pafExistingCustomersLive() {
  return payAfterFirstVisitLive() && process.env.GATE_PAF_EXISTING_CUSTOMERS === 'true';
}
function pafSetupFeeLive() {
  return payAfterFirstVisitLive() && process.env.GATE_PAF_SETUP_FEE === 'true';
}
function pafPrepayLive() {
  return payAfterFirstVisitLive() && process.env.GATE_PAF_PREPAY === 'true';
}
function pafTermiteLive() {
  return payAfterFirstVisitLive() && process.env.GATE_PAF_TERMITE === 'true';
}

// ADMIN_ALERT_RELEVANCE read at CALL time — the one lane that ships LIVE:
// on unless set to exactly 'off', 'false' or '0' (case-insensitive), so an
// unset env is the live state and the env is a pure kill switch (owner
// ruling 2026-09-28, rule 14). The canonical reader for
// admin-alert-relevance.js's periodic sweep and for the ring-time check
// notification-service.js's createPlainAdmin runs through the existing
// ringGate seam. Off = byte-identical to before everywhere.
function adminAlertRelevanceLive() {
  return !['off', 'false', '0'].includes(String(process.env.ADMIN_ALERT_RELEVANCE ?? '').trim().toLowerCase());
}

// GATE_ALERT_CONTACT_CLOSE read at CALL time: 'shadow', 'true' or 'off'. The
// customer-contact classes of admin-alert-relevance.js (a text, a voicemail, a
// missed call or an email from a customer, and a new lead a person reached).
// 'shadow' judges them and records what would close in audit_log, changing no
// bell; 'true' closes them like every other class. Any other value, unset
// included, is off: these classes are not judged at all. Ships dark.
function alertContactCloseMode() {
  const value = String(process.env.GATE_ALERT_CONTACT_CLOSE || '').trim().toLowerCase();
  return value === 'shadow' || value === 'true' ? value : 'off';
}

// GATE_VOICEMAIL_VISIT_UNDERWAY read at CALL time: 'shadow', 'true' or 'off'. One extra close reason
// of the voicemail-callback class in admin-alert-relevance.js: the voicemail's customer has a visit
// that completed after the voicemail, on the same Eastern day. It runs inside GATE_ALERT_CONTACT_CLOSE
// (that gate off = the class is not judged at all) and never closes more than that gate allows:
// 'shadow' records the would-close in audit_log and changes no bell, 'true' closes. Anything else,
// unset included, is off: the reason is not offered, and a bell it closed is put back.
function voicemailVisitUnderwayMode() {
  const value = String(process.env.GATE_VOICEMAIL_VISIT_UNDERWAY || '').trim().toLowerCase();
  return value === 'shadow' || value === 'true' ? value : 'off';
}

// GATE_SMS_STAFF_ACTION_ANSWERS read at CALL time: 'shadow', 'true' or 'off'. A staff action for the
// text's customer (by customer id, never by phone) within 24 hours after the text answers it: a visit a
// person booked in the admin, or a payment a person recorded (services/sms-staff-action-answers.js).
// 'shadow' (trimmed, any case) makes the admin text alert RECORD the would-close in audit_log and changes
// nothing else; 'true' closes the alert and makes the Messages reader (Unanswered list, badge, evening
// digest) count the text as answered. Anything else, unset included, is off: no query, and the reader's
// SQL is byte-identical to before. The alert rule runs inside GATE_ALERT_CONTACT_CLOSE.
function staffActionAnswersMode() {
  const value = String(process.env.GATE_SMS_STAFF_ACTION_ANSWERS || '').trim().toLowerCase();
  return value === 'shadow' || value === 'true' ? value : 'off';
}

// GATE_LEAD_CONTACTED_CLOSE read at CALL time: 'shadow', 'true' or 'off'. The "lead_contacted" Leads
// bells (call/reply to a lead) as a class of admin-alert-relevance.js: closed once a person's text or
// call reached the lead, a visit was booked, or an estimate was handed off, each after the bell.
// 'shadow' records the would-close in audit_log and changes no bell; 'true' closes. Anything else,
// unset included, is off: the class is not judged, and a bell it closed is put back.
function leadContactedCloseMode() {
  const value = String(process.env.GATE_LEAD_CONTACTED_CLOSE || '').trim().toLowerCase();
  return value === 'shadow' || value === 'true' ? value : 'off';
}

// GATE_LEAD_REPEAT_SWEEP read at CALL time, strict `=== 'true'`, dark in every environment. Off = the 4:52 AM
// lead repeat sweep touches no lead; a repeat stays in the waiting queue as before.
function leadRepeatSweepLive() {
  return process.env.GATE_LEAD_REPEAT_SWEEP === 'true';
}

// GATE_PORTAL_CHAT_ANSWERED_CLOSE read at CALL time: 'shadow', 'true' or 'off'. A portal chat hand-off bell
// (portal-chat-escalation:<id>, doneWhen 'customer_answered') as a class of admin-alert-relevance.js: closed
// once a person called back, answered the customer's call, texted or emailed that customer after the bell's
// latest event. Rides on GATE_ALERT_CONTACT_CLOSE (the weaker of the two wins). 'shadow' records the
// would-close in audit_log and changes no bell; 'true' closes. Anything else, unset included, is off: the
// class is not judged, and a bell it closed is put back.
function portalChatAnsweredCloseMode() {
  const value = String(process.env.GATE_PORTAL_CHAT_ANSWERED_CLOSE || '').trim().toLowerCase();
  return value === 'shadow' || value === 'true' ? value : 'off';
}

// ALERT_EPISODES read at CALL time — ships LIVE: on unless set to exactly
// 'off', 'false' or '0' (case-insensitive), so an unset env is the live state
// and the env is a pure kill switch (owner-approved scope 2026-09-29, rule
// 14). The canonical reader for the schedule-integrity watchdog's alert
// episodes: each of its four classes closes its own bell when the problem is
// fixed (notification-service's closeAdminAlertKeys) and rings again when the
// problem comes back (raiseAdminAlertWithReopen). Off = byte-identical to
// before: no close pass, no reopen, the same notifyAdmin calls.
function alertEpisodesLive() {
  return !['off', 'false', '0'].includes(String(process.env.ALERT_EPISODES ?? '').trim().toLowerCase());
}

// GATE_SITEONE_EMAIL_ORDER read at CALL time (so a flip needs no redeploy).
function siteOneEmailOrderLive() {
  return gateEnvValue('GATE_SITEONE_EMAIL_ORDER');
}

// GATE_TECH_LOGIN_PRIVACY read at CALL time (so a flip needs no redeploy); strict 'true'.
function techLoginPrivacyLive() {
  return process.env.GATE_TECH_LOGIN_PRIVACY === 'true';
}

// GATE_ESTIMATE_SLOT_ONE_PER_HOUR read at CALL time (so a flip needs no redeploy); strict 'true'.
function estimateSlotOnePerHourLive() {
  return process.env.GATE_ESTIMATE_SLOT_ONE_PER_HOUR === 'true';
}

// GATE_ACCESS_CODES_FOUND_BELL read at CALL time (so a flip needs no redeploy); strict 'true'.
function accessCodesFoundBellLive() {
  return process.env.GATE_ACCESS_CODES_FOUND_BELL === 'true';
}

// GATE_LEAD_DRAFT_PROPERTY_LOOKUP read at CALL time (so a flip needs no redeploy); strict 'true'.
function leadDraftPropertyLookupLive() {
  return process.env.GATE_LEAD_DRAFT_PROPERTY_LOOKUP === 'true';
}

// GATE_QUIET_OVERDUE_LIST read at CALL time (so a flip needs no redeploy); strict 'true'.
function quietOverdueListLive() {
  return process.env.GATE_QUIET_OVERDUE_LIST === 'true';
}

// GATE_UNBILLED_VISITS_LIST read at CALL time (so a flip needs no redeploy); strict 'true'.
function unbilledVisitsListLive() {
  return process.env.GATE_UNBILLED_VISITS_LIST === 'true';
}

// ADMIN_BODY_GUARD_ALL read at CALL time — ships LIVE: on unless set to
// exactly 'off', 'false' or '0' (case-insensitive), so an unset env is the
// live state and the env is a pure kill switch (owner ruling 2026-09-30, rule
// 14). The canonical reader for notification-service's admin brevity guard:
// on, an over-length admin BODY of ANY category is cut to one sentence with the
// full text kept in `detail` (the bell's "Show full text"); off, only
// ops_digest is cut, byte-identical to before.
function adminBodyGuardAllLive() {
  return !['off', 'false', '0'].includes(String(process.env.ADMIN_BODY_GUARD_ALL ?? '').trim().toLowerCase());
}

// PORTAL_CHAT_SELF_SERVE read at CALL time — DEFAULT ON; off only when set to
// 'off', 'false' or '0' (case-insensitive), a pure kill switch (rule 14). The
// canonical reader for the portal chat assistant (services/ai-assistant): on,
// portal chat hands the customer a Reschedule button or the portal page that
// holds the answer instead of handing off, and a hand-off rings the admin
// bell and tells the customer only what happened; off, portal chat is
// byte-identical to before (hand-off on every reschedule, queue row only).
function portalChatSelfServeLive() {
  return !['off', 'false', '0'].includes(String(process.env.PORTAL_CHAT_SELF_SERVE ?? '').trim().toLowerCase());
}

// PROMISE_EVIDENCE_CLOSE read at CALL time — DEFAULT ON (owner ruling
// 2026-09-28, "close it, show proof"); off only when set to 'off', 'false'
// or '0' (case-insensitive). On, call-commitments' fulfillment refresh closes
// an open Waves promise on association proof (and dismisses one whose
// customer left) with the evidence stored on the row, and the Owed tab offers
// Reopen. Off = byte-identical to before: association proof stays a hint.
// The one canonical reader for every entry point, so a Railway flip is a
// live kill with no redeploy.
function promiseEvidenceCloseLive() {
  return !['off', 'false', '0'].includes(String(process.env.PROMISE_EVIDENCE_CLOSE || '').trim().toLowerCase());
}

// PROMISE_CONTACT_CHECK read at CALL time — DEFAULT ON (owner ruling
// 2026-09-29); off only when set to 'off', 'false' or '0' (case-insensitive).
// On, a periodic job (call-commitment-contact-check.js) asks a model whether a
// person's later delivered text or call back to the caller delivered what an
// open Waves "other" promise from a call said it would, and closes the promise
// on a grounded yes (evidence kept on the row, Reopen on the Owed tab). It
// also needs PROMISE_EVIDENCE_CLOSE and GATE_CALL_COMMITMENTS. Off = no NEW
// checks; a promise it already closed stays closed while its witness stands.
// No customer message either way.
function promiseContactCheckLive() {
  return !['off', 'false', '0'].includes(String(process.env.PROMISE_CONTACT_CHECK || '').trim().toLowerCase());
}

// GATE_CALL_COMMERCIAL_DICTATED_BOOKING read at CALL time — strict
// `=== 'true'`, dark by default (owner ruling 2026-09-30). The canonical reader
// for call-recording-processor.js's two canAutoRoute call sites (the enforce
// lane and the audit reconstruction): on, a commercial_requires_quote hold
// clears when staff dictated the booking and the caller accepted it, both
// grounded word for word in a turn of the right speaker, with a price agreed
// and grounded (see services/call-commercial-dictated-booking.js). Inbound only, and only with GATE_CALL_AGENT_COMMIT_BOOKING on (processor).
// Off, byte-identical to before — the hold stays. The
// `callCommercialDictatedBooking` gates-map entry above is for logGateStatus only.
function callCommercialDictatedBookingLive() {
  return process.env.GATE_CALL_COMMERCIAL_DICTATED_BOOKING === 'true';
}

// GATE_CALL_COMMERCIAL_ASSESSMENT_BOOKING read at CALL time — strict
// `=== 'true'`, dark by default (owner ruling 2026-10-06). The canonical reader
// for call-recording-processor.js's canAutoRoute call sites (the enforce lane,
// the shadow pass and the audit reconstruction): on, a commercial_requires_quote
// hold clears for a Waves Assessment staff booked on the call with no price
// discussed — outbound callback calls too, once staff identity is proven
// independent of the speaker labels (see services/call-commercial-dictated-booking.js).
// Needs GATE_CALL_AGENT_COMMIT_BOOKING on (processor). Off, byte-identical to
// before. The `callCommercialAssessmentBooking` gates-map entry above is for
// logGateStatus only.
function callCommercialAssessmentBookingLive() {
  return process.env.GATE_CALL_COMMERCIAL_ASSESSMENT_BOOKING === 'true';
}

// GATE_CALL_EXTRACTION_SYSTEM_PROMPT read at CALL time — strict `=== 'true'`,
// dark by default. The canonical reader for call-recording-processor.js: on, the
// V2 extraction request carries the rules and the output contract as a static
// system part (cacheable across calls) and the call's own facts and transcript
// as the user message, and the prompt version carries the `s` / `b` cohort mark.
// Off, the one-message prompt and its version are byte-identical to before. The
// `callExtractionSystemPrompt` gates-map entry above is for logGateStatus only.
function callExtractionSystemPromptLive() {
  return process.env.GATE_CALL_EXTRACTION_SYSTEM_PROMPT === 'true';
}

// GATE_CALL_EXTRACTION_V1_FALLBACK read at CALL time — strict `=== 'true'`, dark by
// default. The canonical reader for call-recording-processor.js extractCallData: on,
// a provider failure of the Gemini V1 leg retries the same prompt on Claude, then
// OpenAI. Off = Gemini only, byte-identical. The `callExtractionV1Fallback`
// gates-map entry above is for logGateStatus only.
function callExtractionV1FallbackLive() {
  return process.env.GATE_CALL_EXTRACTION_V1_FALLBACK === 'true';
}

// GATE_CALL_SPELLING_COLLAPSE_TRIGGER read at CALL time — strict `=== 'true'`, dark by
// default. The canonical reader for call-recording-processor.js: on, the second
// transcription pass and the contact decoder also run when spellingCollapseSignals
// (contact-dictation.js) finds the marks a collapsed spelling leaves in the primary
// transcript. Off, only detectContactDictationSignals decides, byte-identical to before.
// The `callSpellingCollapseTrigger` gates-map entry above is for logGateStatus only.
function callSpellingCollapseTriggerLive() {
  return process.env.GATE_CALL_SPELLING_COLLAPSE_TRIGGER === 'true';
}

// GATE_CALL_FIRST_NAME_ADVISORY read at CALL time — strict `=== 'true'`, dark by
// default (owner ruling 2026-10-02: the AI booker approved two confirmed bookings,
// then skipped one because the caller gave only a last name). The canonical reader
// for call-recording-processor.js: on, a caller with a last name and no first name
// still gets a customer row (first_name stored empty — the column is NOT NULL), the
// booking validator treats a missing first name as advisory like the last name, and
// the office gets a missing_first_name card. Off, byte-identical to before. The
// `callFirstNameAdvisory` gates-map entry above is for logGateStatus only.
function callFirstNameAdvisoryLive() {
  return process.env.GATE_CALL_FIRST_NAME_ADVISORY === 'true';
}

// GATE_CALLBACK_SPOKEN_NUMBER_LINK read at CALL time — strict `=== 'true'`, dark by
// default. The canonical reader for call-recording-processor.js
// findCustomerViaCallbackSpokenNumber. The `callbackSpokenNumberLink` gates-map
// entry above is for logGateStatus only.
function callbackSpokenNumberLinkLive() {
  return process.env.GATE_CALLBACK_SPOKEN_NUMBER_LINK === 'true';
}

// GATE_CALL_LAST_NAME_LOOKUP read at CALL time — strict `=== 'true'`, dark by
// default (owner ruling 2026-10-08). The canonical reader for
// services/call-last-name-lookup.js: on, a call that left a customer with a
// first name and no last name fires a background lookup (county owner record
// for the homeowner, our own records, the email address, the Twilio caller
// name) that posts ONE admin notification suggesting the last name. It never
// writes the name; the office saves it. Off, nothing runs. Kill: unset.
function callLastNameLookupLive() {
  return process.env.GATE_CALL_LAST_NAME_LOOKUP === 'true';
}

// GATE_STATION_FAST_COMPLETE read at CALL time — strict `=== 'true'`, dark by
// default (owner ruling 2026-10-08). On, a termite or rodent bait station visit
// opens the one-screen Fast Complete sheet in admin Dispatch with the station
// checks on it (client/src/components/tech/FastCompleteStations.jsx), and
// POST /admin/dispatch/:id/typed-facts reads station exceptions from the note
// (services/visit-station-facts.js). Off, the schedule row flag is false and
// station visits route as before. Kill: unset.
function stationFastCompleteLive() {
  return process.env.GATE_STATION_FAST_COMPLETE === 'true';
}

// GATE_PIN_PARKED_CHECK read at CALL time — strict `=== 'true'`, dark by default
// (owner "build guardrail" 2026-10-09). The canonical reader for
// services/pin-parked-check.js and the pin_suggestion part of
// routes/admin-customer-geocodes.js. Off: the daily job returns before any query,
// the review endpoints add no suggestion and the dismiss route answers 404.
// It never writes a pin and never contacts a customer. Kill: unset.
function pinParkedCheckLive() {
  return process.env.GATE_PIN_PARKED_CHECK === 'true';
}

// GATE_TRIP_LINK read at CALL time — strict `=== 'true'`, dark by default
// (owner "TRIP LINK" and "BOTH" 2026-10-26). The canonical reader for
// services/trip-link.js (the 01:40 ET job in scheduler.js, the backfill script)
// and routes/admin-trip-link.js. Off: the job reads nothing and writes nothing
// and the summary route answers 404. It writes only visit_gps_legs and
// trip_links, never mileage_log, scheduled_services, job_costs, pins or alerts,
// and sends nothing. Kill: unset.
function tripLinkLive() {
  return process.env.GATE_TRIP_LINK === 'true';
}

// Auto lunch (services/time-tracking.js), read at CALL time. Strict
// `=== 'true'`, dark in every environment; unsetting it is the kill switch.
function autoLunchLive() {
  return process.env.GATE_AUTO_LUNCH === 'true';
}

// Shift close review (services/time-tracking.js, time-tracking-crons.js,
// payroll-runs.js), read at CALL time. Strict `=== 'true'`, dark in every
// environment; unsetting it is the kill switch.
function shiftCloseReviewLive() {
  return process.env.GATE_SHIFT_CLOSE_REVIEW === 'true';
}

// Staff guards (services/staff-sender-phones.js, routes/tech-track.js), read at CALL time. Strict
// `=== 'true'`, dark in every environment; unsetting it is the kill switch.
function techStaffGuardsLive() {
  return process.env.GATE_TECH_STAFF_GUARDS === 'true';
}

// Tax package W-2 labor (routes/admin-tax.js GET /export/tax-package), read at CALL time. Strict
// `=== 'true'`, dark in every environment; unsetting it is the kill switch.
function taxPackageW2LaborLive() {
  return process.env.GATE_TAX_PACKAGE_W2_LABOR === 'true';
}

// P&L and Schedule C wages from finalized pay runs (services/pnl-report.js, tax-return-engine.js,
// pay-run-books.js), read at CALL time. Strict `=== 'true'`, dark in every environment; unsetting
// it is the kill switch.
function pnlPayRunWagesLive() {
  return process.env.GATE_PNL_PAY_RUN_WAGES === 'true';
}

// Payroll bank match (services/bank-import.js, payroll-bank-match.js, payroll-runs.js, routes/admin-tax.js),
// read at CALL time. Strict `=== 'true'`, dark in every environment; unsetting it is the kill switch. Also needs
// GATE_PNL_PAY_RUN_WAGES: only then do the P&L and Schedule C leave the pay-run category out and count the pay runs.
function payrollBankMatchLive() {
  return process.env.GATE_PAYROLL_BANK_MATCH === 'true' && pnlPayRunWagesLive();
}

// Tech cost rates (services/job-costing.js, routes/admin-cost-cards.js), read at CALL time. Strict
// `=== 'true'`, dark in every environment; unsetting it is the kill switch.
function techCostRatesLive() {
  return process.env.GATE_TECH_COST_RATES === 'true';
}

// Job cost standard minutes (services/job-costing.js, scripts/job-cost-standard-recost.js), read at CALL time. Strict
// `=== 'true'`, dark in every environment; unsetting it is the kill switch.
function jobCostStandardMinutesLive() {
  return process.env.GATE_JOB_COST_STANDARD_MINUTES === 'true';
}

// Tech open time (services/job-cost-recost.js, routes/admin-cost-cards.js, routes/admin-dashboard.js), read at CALL
// time. Strict `=== 'true'`, dark in every environment; unsetting it is the kill switch. Needs GATE_TECH_COST_RATES.
function techOpenTimeLive() {
  return process.env.GATE_TECH_OPEN_TIME === 'true';
}

// Tech pay stubs (routes/tech-payroll.js, services/payroll-runs.js), read at CALL time. Strict `=== 'true'`, dark in every
// environment; unsetting it is the kill switch. Off = both /api/tech/payroll routes answer 404 before any query.
function techPayStubsLive() {
  return process.env.GATE_TECH_PAY_STUBS === 'true';
}

// Tech training dates (routes/admin-compliance-v2.js, services/technician-training-reminders.js), read at CALL time. Strict `=== 'true'`, dark in
// every environment; unsetting it is the kill switch.
function techTrainingDatesLive() {
  return process.env.GATE_TECH_TRAINING_DATES === 'true';
}

// Misting layout designer (routes/admin-pricing-config.js misting block), read at CALL time. Strict
// `=== 'true'`, dark in every environment; unsetting it is the kill switch. Needs GATE_MOSQUITO_MISTING.
function mistingLayoutDesignerLive() {
  return process.env.GATE_MISTING_LAYOUT_DESIGNER === 'true';
}

// GATE_TRUCK_KIT read at CALL time — strict `=== 'true'`, dark by default
// (docs/tool-inventory-tracker-scope.md PR 1). The canonical reader for
// services/truck-kit.js and routes/tech-truck-check.js. Off: both tech routes
// answer 404 { enabled: false } before any query, the field workspace shows no
// Truck check tile or card and nothing is written. Kill: unset.
function truckKitLive() {
  return process.env.GATE_TRUCK_KIT === 'true';
}

// GATE_SIGNUP_SINGLE_EMAIL read at CALL time — strict `=== 'true'`, dark by
// default in every environment (owner-approved 2026-09-29; the owner flips it
// after previewing the template). The canonical reader for the one-signup-email
// lane: server/services/estimate-accepted-email.js (the combined email),
// routes/estimate-public.js PUT /:token/accept (holds the separate
// membership.started and sends it only when the combined email was not
// accepted for sending; the Auto Pay confirmation is not held) and
// services/new-recurring-welcome-sms.js (skips ONLY the welcome email at queue
// delivery — the welcome text is unchanged). Off = byte-identical to before.
function signupSingleEmailLive() {
  return process.env.GATE_SIGNUP_SINGLE_EMAIL === 'true';
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
  const allow = dunningCustomerScheduleAllowlistStatus();
  if (allow.configured) {
    console.log(allow.valid.length
      ? `  ↳ dunning customer-schedule allowlist: ${allow.valid.length} customer(s)`
      : '  ↳ dunning customer-schedule allowlist configured but has no valid ids → nobody');
    if (allow.invalidCount) console.log(`  ↳ dunning customer-schedule allowlist ignored ${allow.invalidCount} malformed entr${allow.invalidCount === 1 ? 'y' : 'ies'}`);
  }
}

// Known GATE_* Railway variable names, for the Intelligence Bar's
// set_railway_gate tool (it refuses a name not listed here, so a typo can
// never create a new variable). Derived from THIS file's own source so a new
// gate is known the moment it is documented or registered here, with no
// second list to keep in step: every gate name the file mentions, in code or
// in its comments. A gate read only by some other module, and never mentioned
// in this file, is not known here.
//
// Each entry says whether the gate is a plain on/off switch (`boolean`), so
// the tool never writes 'true'/'false' into a gate that takes something else:
//   - boolean:   the header documents it as `=true`, or the code reads it as
//                exactly 'true' / gateEnvValue(...) — and nothing in this file
//                shows it taking a mode or timestamp.
//   - mode:      a mode value is visible here ('shadow', 'auto', an ISO
//                timestamp, a *_SINCE / *_AT / *_ALLOWLIST name).
//   - unverified: only mentioned in a comment; nothing shows how it is read.
// Only `boolean` gates can be flipped from the bar. Each entry also records
// its `reader` — how the code parses the value — so the bar judges the
// current state the way the runtime does: 'loose' (gateEnvValue: '1' / 'true'
// / 'on', any case), 'strict' (exactly 'true'; also assumed for a gate known
// only from the header), or 'mixed' (read both ways in this file).
// RETIRED names stay out entirely: they must not be re-enabled from the bar
// (glass: the theme gates were removed).
const RETIRED = new Set([
  'GATE_ESTIMATE_GLASS',
  'GATE_EMAIL_GLASS',
  'GATE_REPORT_GLASS',
  'GATE_PORTAL_GLASS',
  // Read by nothing: the AI blog lane runs on GATE_AUTONOMOUS_CONTENT + the
  // GATE_BLOG_* sub-gates, so flipping this from the bar changed nothing
  // (weekly sweep #6341 B1).
  'GATE_AI_BLOG_WRITER',
]);
const INVERTED_GATE_RE = /_(OFF|DISABLE|DISABLED|KILL_SWITCH)$/;
let gateCatalogCache = null;

function knownGateCatalog() {
  if (gateCatalogCache) return gateCatalogCache;
  const src = require('fs').readFileSync(__filename, 'utf8');
  const tokenRe = /GATE_[A-Z0-9_]*[A-Z0-9]/g;
  const headerEnd = src.indexOf('*/');
  // A header entry is its ` *   GATE_X=value (…)` line PLUS any indented
  // ` *     …` continuation lines under it (prerequisites often live there).
  // The description is kept COMPLETE — never truncated — because the bar's
  // confirmation card shows it as what the operator approves (Codex r3 on
  // #5514).
  const headerDocs = new Map();
  const entryRe = /^ \*   (GATE_[A-Z0-9_]*[A-Z0-9])=(\S*)[ \t]*(.*(?:\n \*\s{5,}\S.*)*)/gm;
  for (const [, name, value, body] of src.slice(0, headerEnd).matchAll(entryRe)) {
    const text = body.replace(/\n \*\s+/g, ' ').replace(/^\(/, '').replace(/\)\s*$/, '').trim();
    headerDocs.set(name, { valueIsTrue: value === 'true', description: text || null });
  }
  const strictEvidence = new Set();
  const looseEvidence = new Set();
  const modeEvidence = new Set();
  for (const line of src.slice(headerEnd).split('\n')) {
    for (const name of line.match(tokenRe) || []) {
      if (/['"](shadow|auto)['"]/.test(line) || /(=|\|)\s*(shadow|auto)\b/.test(line) || /<ISO/.test(line)) modeEvidence.add(name);
      else {
        if (line.includes(`process.env.${name} === 'true'`)) strictEvidence.add(name);
        if (line.includes(`gateEnvValue('${name}')`)) looseEvidence.add(name);
      }
    }
  }
  const catalog = new Map();
  for (const name of new Set(src.match(tokenRe) || [])) {
    if (RETIRED.has(name)) continue;
    const doc = headerDocs.get(name);
    const mode = modeEvidence.has(name) || /(_SINCE|_AT|_ALLOWLIST)$/.test(name) || (doc && !doc.valueIsTrue);
    let kind = 'unverified';
    if (mode) kind = 'mode';
    else if ((doc && doc.valueIsTrue) || strictEvidence.has(name) || looseEvidence.has(name)) kind = 'boolean';
    let reader = 'strict';
    if (looseEvidence.has(name)) reader = strictEvidence.has(name) ? 'mixed' : 'loose';
    // Inverted (negative-polarity) gates: 'true' DISABLES the named thing
    // (GATE_IB_WRITES_DISABLED=true turns writes off), so the bar
    // never presents 'true' as "on" for these.
    const inverted = INVERTED_GATE_RE.test(name);
    catalog.set(name, { name, kind, boolean: kind === 'boolean', inverted, reader, description: doc ? doc.description : null });
  }
  gateCatalogCache = catalog;
  return catalog;
}

// GATE_OUTLINK_TRACKING read at CALL time — strict `=== 'true'`, same
// convention as visitPrepPhotosLive(). The canonical reader for
// server/services/outlink-tracking.js (render-time rewrite of outside links
// in the prep email and /prep page). Only the REWRITE is gated: the /go/:code
// redirect route stays live so a link already sent keeps working after a
// kill. The `outlinkTracking` gates-map entry above is for logGateStatus only.
function outlinkTrackingLive() {
  return process.env.GATE_OUTLINK_TRACKING === 'true';
}

// Customer-level dunning gates read at CALL time — strict `=== 'true'`. The
// `dunningCustomerSchedule*` gates-map entries above are for logGateStatus
// only. Both ship dark; the live reader is separate from the shadow reader so
// a shadow run can never be mistaken for authority to send. BOTH readers also
// require the prerequisites the schedule depends on and fail closed without
// them: GATE_DUNNING_LADDER_90 (the Day 60/90 cadence, read as
// invoice-followups.js reads it) and the pay-page balance gate
// (payIncludeBalance, read as pay-combined.js reads it, via the gates map) —
// without the first the cadence is the legacy Day 30 one, without the second
// the page shows one invoice while a reminder names the set.
function dunningCustomerSchedulePrereqsLive() {
  return process.env.GATE_DUNNING_LADDER_90 === 'true' && gates.payIncludeBalance === true;
}

function dunningCustomerScheduleShadowLive() {
  return process.env.GATE_DUNNING_CUSTOMER_SCHEDULE_SHADOW === 'true' && dunningCustomerSchedulePrereqsLive();
}

function dunningCustomerScheduleLive() {
  return process.env.GATE_DUNNING_CUSTOMER_SCHEDULE === 'true' && dunningCustomerSchedulePrereqsLive();
}

// DUNNING_CUSTOMER_SCHEDULE_ALLOWLIST — comma-separated customer ids (uuids),
// read at CALL time. It only ever NARROWS the live gate (a canary); it never
// turns anything on by itself. Three states, deliberately distinct:
//   unset / whitespace only        -> null      (no allowlist: everyone)
//   configured, >= 1 valid uuid    -> Set       (only those customers)
//   configured, NO valid uuid      -> empty Set (nobody — a typo'd canary must
//                                    fail closed, never widen to everyone)
// A malformed entry (not a uuid) is dropped and only COUNTED in
// dunningCustomerScheduleAllowlistStatus() / logGateStatus — an entry is never
// logged (it may be a mistyped id or something that should not be in a log).
const ALLOWLIST_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dunningCustomerScheduleAllowlistStatus() {
  const raw = String(process.env.DUNNING_CUSTOMER_SCHEDULE_ALLOWLIST || '');
  if (raw.trim() === '') return { configured: false, valid: [], invalidCount: 0 };
  const valid = [];
  let invalidCount = 0;
  for (const id of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    if (!ALLOWLIST_UUID.test(id)) invalidCount += 1;
    else if (!valid.includes(id.toLowerCase())) valid.push(id.toLowerCase());
  }
  return { configured: true, valid, invalidCount };
}

function dunningCustomerScheduleAllowlist() {
  const status = dunningCustomerScheduleAllowlistStatus();
  return status.configured ? new Set(status.valid) : null;
}

// GATE_ZONE_ROUTE_DAYS read at CALL time — strict `=== 'true'`, same
// convention as outlinkTrackingLive(). The canonical reader for
// scheduling/zone-route-days.js and policy.js's customerMaxDetourMinutes();
// the `zoneRouteDays` gates-map entry above is for logGateStatus only.
function zoneRouteDaysLive() {
  return process.env.GATE_ZONE_ROUTE_DAYS === 'true';
}

// GATE_PORTAL_YARD_CALENDAR read at CALL time — ships DARK, off unless exactly
// 'true' (owner-approved 2026-10-01). The one reader for GET /api/feed/yard
// (routes/feed.js); the portal client learns the gate from that endpoint's
// {available} answer, like the property-score card. Off = the endpoint answers
// {available:false} and the Learn tab's Local Conditions card is untouched.
function portalYardCalendarLive() {
  return process.env.GATE_PORTAL_YARD_CALENDAR === 'true';
}

// GATE_PERMIT_DETAIL_SYNC read at CALL time — ships DARK, off unless exactly
// 'true'. The one reader for the Manatee permit detail collector
// (services/property-lookup/manatee-permit-detail.js): off, the weekly cron
// step returns {skipped:'gated'} before any network or DB read. Independent
// of GATE_PERMIT_SYNC (the report sync). Collection only.
function permitDetailSyncLive() {
  return process.env.GATE_PERMIT_DETAIL_SYNC === 'true';
}

// GATE_LOOKUP_BUSINESS_IDENTITY read at CALL time — ships DARK, off unless
// exactly 'true'. The one reader for the business-identity leg of the admin
// property lookup and the estimator engine (services/property-lookup/
// business-identity.js): off, no Places request is made and the lookup and
// the engine behave exactly as before.
function lookupBusinessIdentityLive() {
  return process.env.GATE_LOOKUP_BUSINESS_IDENTITY === 'true';
}

// GATE_LOOKUP_LISTING_SIZE read at CALL time — ships DARK, off unless exactly
// 'true'. The one reader for the listing-size leg of commercial suite sizing
// (services/commercial-suite-size/listing-size.js): off, no search and no
// page fetch, and the sizing ladder is exactly as before.
function lookupListingSizeLive() {
  return process.env.GATE_LOOKUP_LISTING_SIZE === 'true';
}

// GATE_LOOKUP_ADDRESS_STATUS read at CALL time — ships DARK, off unless exactly
// 'true'. The one reader for the admin lookup's address status line
// (services/property-lookup/address-status.js): off, no Address Validation
// call is made for a lookup and the route's response is exactly as before.
function lookupAddressStatusLive() {
  return process.env.GATE_LOOKUP_ADDRESS_STATUS === 'true';
}

// GATE_LOOKUP_PERMIT_FACTS read at CALL time — ships DARK, off unless exactly
// 'true'. The one reader for the permit-facts leg of the property lookup
// (routes/property-lookup-v2.js: the _permitBuildingFacts stamp and the
// enriched profile's permitBuildingFacts) and the estimator engine's
// permit-plan sqft source: off, construction_permit_records is never read
// for a lookup and the lookup, profile and draft are exactly as before.
function lookupPermitFactsLive() {
  return process.env.GATE_LOOKUP_PERMIT_FACTS === 'true';
}

// GATE_LAWN_REPORT_PHOTO_SET read at CALL time — ships DARK, off unless
// exactly 'true'. The one reader for the lawn report's photo set (report-data.js
// buildLawnAssessmentReportData, lawnAssessmentPdfSignature): off, the report
// payload and the PDF cache key are byte-identical to before.
function lawnReportPhotoSetLive() {
  return process.env.GATE_LAWN_REPORT_PHOTO_SET === 'true';
}

// GATE_LAWN_REPORT_PHOTO_FINDINGS read at CALL time — ships DARK, off unless
// exactly 'true'. The one reader for the lawn report's "What the photos showed"
// block (report-data.js, lawn-photo-findings.js). It works only together with
// GATE_LAWN_REPORT_PHOTO_SET (the block hangs off the photo set); off, the run
// is never read and the payload and the PDF cache key are unchanged.
function lawnReportPhotoFindingsLive() {
  return process.env.GATE_LAWN_REPORT_PHOTO_FINDINGS === 'true';
}

// GATE_LAWN_LIGHTING read at CALL time — ships DARK, off unless exactly 'true' AND
// GATE_LAWN_VISIT_ASSESSMENT is on. The light read comes only from the one-call
// visit assessment (POST /admin/lawn-assessment/assess stays on the legacy
// per-photo path without it), so with that gate off no run would ever store a
// light and every effect below would only hide color for nothing: the reader
// reports off then, and NO effect of the gate can run without the reader that
// feeds it (same composition as lawnPairedRecheckLive).
// The one reader for the lawn lighting-aware color work (owner 2026-10-04):
// the visit assessment's light read and prompt variant (lawn-visit-assessment.js),
// the paired recheck's v3 prompt (lawn-paired-recheck.js), the progress engine's
// color rules (service-report/lawn-progress.js, called from report-data.js) and
// the report writer's prior-visit score line (report-copy-context.js). Off, every
// one of them is byte-identical to before.
function lawnLightingLive() {
  return process.env.GATE_LAWN_LIGHTING === 'true' && gateEnvValue('GATE_LAWN_VISIT_ASSESSMENT');
}

// GATE_LAWN_SCORE_SCALE_V2 read at CALL time, strict 'true' (owner 2026-10-24,
// lawn scoring review). The one reader for score scale 2: the visit assessment's
// prompt variant and score derivation (lawn-visit-assessment.js) and the scale
// stamp the /assess route writes. Scale-2 rows are kept apart from scale-1 rows
// by property history, so the gate needs GATE_LAWN_PROPERTY_HISTORY, and the
// prompt runs only on the one-call read (GATE_LAWN_VISIT_ASSESSMENT).
function lawnScoreScaleV2Live() {
  return process.env.GATE_LAWN_SCORE_SCALE_V2 === 'true'
    && gateEnvValue('GATE_LAWN_VISIT_ASSESSMENT') && gateEnvValue('GATE_LAWN_PROPERTY_HISTORY');
}

// GATE_LAWN_TECH_PARAGRAPH read at CALL time (same 1/true/on convention as
// gateEnvValue) — ships DARK. The one reader for the lawn report's "From your
// technician" paragraph (lawn-tech-paragraph.js): the completion gate
// (lawn-report-write-gate.js) makes its one model call and freezes the text
// only while this is live, and the report build hands a frozen text to the lead
// only while it is live. It renders only inside the lead. Off = no model call, no read, and the payload, the
// PDF and its cache key are byte-identical to before.
function lawnTechParagraphLive() {
  return gateEnvValue('GATE_LAWN_TECH_PARAGRAPH');
}

// GATE_LAWN_VISIT_SUMMARY_V2 read at CALL time, strict `=== 'true'` (customer copy),
// so an unset variable is the kill switch for NEW summaries. The one reader for the lawn Visit
// Summary composer (lawn-visit-summary.js, fixed sentences, no model): ONLY the completion gate
// (lawn-report-write-gate.js) reads it, to compose and freeze. A render shows any whole frozen
// summary whatever this says, so every pod and browser agrees during a rollout and a rollback
// leaves existing summaries in place.
function lawnVisitSummaryV2Live() {
  return process.env.GATE_LAWN_VISIT_SUMMARY_V2 === 'true';
}

// GATE_LAWN_REPORT_COPY_FIXES read at CALL time, strict `=== 'true'` (customer copy), so an
// unset variable is the kill switch. The one reader for the six lawn report copy fixes (category
// words instead of chemical names, the seasonal color line rule, "Weed Cleanliness", no pest
// re-service wording, no stale charts, the water target source line). Lawn reports only: every
// caller checks the service line first. Off = the payload, render, PDF and PDF cache key are
// byte-identical to before. Frozen entries (the tech paragraph, the v6 copy) are written in the
// category form only while this is live and replay unchanged afterwards.
function lawnReportCopyFixesLive() {
  return process.env.GATE_LAWN_REPORT_COPY_FIXES === 'true';
}

// GATE_LAWN_REPORT_LAYOUT read at CALL time, strict `=== 'true'` (customer copy), so an unset
// variable is the kill switch. The one reader for the lawn web report layout: the payload key
// `lawnLayout` (lawn-report-layout.js) is added only while it is live, and the page orders and
// trims the report from that key. Lawn reports only: every caller checks the service line first.
// Off = the payload, render, PDF and PDF cache key are byte-identical to before.
function lawnReportLayoutLive() {
  return process.env.GATE_LAWN_REPORT_LAYOUT === 'true';
}

// GATE_LAWN_REPORT_POLISH read at CALL time, strict `=== 'true'` (customer copy), so an unset variable
// is the kill switch. The one reader for the lawn report polish: the Water card's third state, the
// frozen one-label-line decision, the status card's keep-off line. Lawn reports only: every caller
// checks the service line first. Off = the payload, render, PDF and PDF cache key are byte-identical.
function lawnReportPolishLive() {
  return process.env.GATE_LAWN_REPORT_POLISH === 'true';
}

// GATE_LAWN_REPORT_STAGE1_FIXES read at CALL time, strict `=== 'true'` (customer copy), so an unset variable
// is the kill switch. The one reader for the five lawn report stage 1 fixes (the damage finding names the targeted
// pest, a second "What to expect" line, no irrigation-settings tip beside a schedule on file, the applied card not
// repeated, no email or phone in the web hero). Lawn reports only: every caller checks the service line first.
// Off = the payload, render, PDF and PDF cache key of a record with no frozen stage 1 copy are byte-identical to before;
// a second "What to expect" line frozen while the gate was live keeps replaying (and its PDF key part ':s1f=1') after it is unset.
function lawnReportStage1FixesLive() {
  return process.env.GATE_LAWN_REPORT_STAGE1_FIXES === 'true';
}

// The FREEZE half of GATE_LAWN_REPORT_POLISH (the one-label-line decision and the longer-cycles decision) is live
// only while GATE_LAWN_REPORT_FACTS is also live: both decisions are frozen INSIDE the facts block
// (lawnReportFacts.labelLines, lawnReportFacts.waterAdvice, written by the facts freeze), and with the facts gate dark
// nothing is frozen. Both gates must be live, so the dependency is stated here, once, and the freeze reads this helper
// instead of the polish gate. The Water card half (third state, basis line) and the status card half read
// lawnReportPolishLive() alone and need no facts gate. A render reads the frozen record whatever either gate says.
function lawnReportPolishFreezeLive() {
  return lawnReportPolishLive() && lawnReportFactsLive();
}

// GATE_LAWN_WATER_RAIN read at CALL time, strict `=== 'true'` (customer copy), so an unset variable is the kill
// switch. It controls ONLY the freeze at completion: a render reads the frozen record (lawnReportFacts.waterAdvice,
// version 2) whatever this gate says. Lawn reports only: every caller checks the service line first.
function lawnWaterRainLive() {
  return process.env.GATE_LAWN_WATER_RAIN === 'true';
}

// GATE_LAWN_WATER_IN_RAIN read at CALL time, strict `=== 'true'` (customer copy), so an unset variable is the kill switch.
// Read-time only: nothing is frozen, so the PDF cache key (':wir=') follows this gate while a frozen water-in instruction exists.
function lawnWaterInRainLive() {
  return process.env.GATE_LAWN_WATER_IN_RAIN === 'true';
}

// The freeze of the rain-card decision is live only while GATE_LAWN_REPORT_FACTS is also live: the decision is frozen
// INSIDE the facts block (lawnReportFacts.waterAdvice), and with the facts gate dark nothing is frozen. The one place
// the dependency is stated.
function lawnWaterRainFreezeLive() {
  return lawnWaterRainLive() && lawnReportFactsLive();
}

// GATE_LAWN_V13 read at CALL time — strict `'true'` only, so an unset variable
// is the kill switch. The one reader for the v13 lawn program: lawn-program.js
// hands every recipe reader the v13 program instead of protocols.json `lawn`,
// and getActiveLawnProtocol resolves the staged v13 protocol version for a
// visit with no assignment. Off = every output is byte-identical to before.
function lawnV13Live() {
  return process.env.GATE_LAWN_V13 === 'true';
}

// GATE_LAWN_BERMUDA_REMOVAL read at CALL time, strict 'true' only. The one
// reader for the lawn bermuda-removal add-on (services/lawn-bermuda-removal.js,
// the plan engine, the tank sheet and the cost line in service-pricing.js). Off = every output is byte-identical to before.
function lawnBermudaRemovalLive() {
  return process.env.GATE_LAWN_BERMUDA_REMOVAL === 'true';
}

// GATE_LAWN_OUTLINE_V13 read at CALL time — strict `'true'` only, so an unset variable is the kill switch. Live only while the
// v13 program is too (fail closed): the outline describes the v13 recipe. The outline build, its packet stamp and the stale check
// on the Estimates list follow this one reader; off = the old outline exactly.
function lawnOutlineV13Live() {
  return process.env.GATE_LAWN_OUTLINE_V13 === 'true' && lawnV13Live();
}

// GATE_LAWN_OUTLINE_DETAIL read at CALL time — strict `'true'` only, so an unset variable is the kill switch. Live only while the
// v13 outline is too (fail closed): the detail sections extend the v13 outline. The outline build, its packet stamp and the
// stale check on the Estimates list follow this one reader; off = the v13 outline exactly.
function lawnOutlineDetailLive() {
  return process.env.GATE_LAWN_OUTLINE_DETAIL === 'true' && lawnOutlineV13Live();
}

// GATE_LAWN_OUTLINE_VISUAL read at CALL time — strict `'true'` only, so an unset variable is the kill switch. Live only while the
// detailed outline is too (fail closed): the new layout rebuilds the detail sections. The outline build, its packet stamp and the
// stale check on the Estimates list follow this one reader; off = the detailed v13 outline exactly.
function lawnOutlineVisualLive() {
  return process.env.GATE_LAWN_OUTLINE_VISUAL === 'true' && lawnOutlineDetailLive();
}

// GATE_LAWN_SPOT_RULES read at CALL time — strict `'true'` only, so an unset variable
// is the kill switch. The lawn Fast Complete context adds plannedProducts.weedMix and
// spotRules only while it is on (lawn-fast-complete.js); off = the old payload exactly.
function lawnSpotRulesLive() {
  return process.env.GATE_LAWN_SPOT_RULES === 'true';
}

// GATE_LAWN_TREATMENT_GUIDE read at CALL time — strict `'true'` only, so an unset variable
// is the kill switch. Live only while the spot rules AND the v13 program are too (fail closed):
// the weed card is the spot rules' Weed spots entry, and every product comes from the staged v13
// rows. The lawn Fast Complete context, the treatment-guide route and the completion record all
// follow this one reader; off = the old behavior exactly.
function lawnTreatmentGuideLive() {
  return process.env.GATE_LAWN_TREATMENT_GUIDE === 'true' && lawnSpotRulesLive() && lawnV13Live();
}

// GATE_LAWN_TROUBLE_AREAS read at CALL time — strict `'true'` only, so an unset variable is the kill
// switch. Live only while the spot rules, the v13 program AND the treatment guide are too (fail closed): the
// place belongs to the spot rows the spot rules ask for, the per-place limits are the v13 yearly caps, and the
// guide supplies the take-all and chinch sets the places are classified and held to (the guide is live in
// production; without it the sheet has no take-all ids). The context, the clear route, the /complete preflight
// and record, and the limit reader all follow this one reader; off = the old behavior exactly.
function lawnTroubleAreasLive() {
  return process.env.GATE_LAWN_TROUBLE_AREAS === 'true' && lawnSpotRulesLive() && lawnV13Live() && lawnTreatmentGuideLive();
}

// GATE_LAWN_NEW_SOD_NOTE read at CALL time — strict `'true'` only, so an unset variable is the kill
// switch. The lawn Fast Complete context carries `newSod` (the banner, the held lines, the bag swap) and
// the rooted-tick route answers only while it is on (lawn-sod-sheet.js); off = the old payload exactly.
function lawnNewSodNoteLive() {
  return process.env.GATE_LAWN_NEW_SOD_NOTE === 'true';
}

// GATE_LAWN_NOV_LARGE_PATCH_N read at CALL time — strict `'true'` only, so an unset variable is the kill switch. Live only while the
// trouble areas are too (fail closed): the rule reads the mapped fungus areas, and lawnTroubleAreasLive() already needs the v13 program.
// Since 2026-10-23 it also needs the spot target capture (GATE_LAWN_SPOT_TARGET): the rule asks for large patch evidence (the target on the
// fungicide application), which only that capture records. The plan and the tank sheet follow this one reader; off = the old targets exactly.
function lawnNovLargePatchNLive() {
  return process.env.GATE_LAWN_NOV_LARGE_PATCH_N === 'true' && lawnTroubleAreasLive() && lawnSpotTargetLive();
}

// GATE_LAWN_DEC_LARGE_PATCH_K read at CALL time — strict `'true'` only, so an unset variable is the kill switch. Live only while the
// trouble areas are too (fail closed), like the November rule: the swap reads the mapped fungus areas. Also live only while the spot
// target capture is (GATE_LAWN_SPOT_TARGET): the disease of a fungus area is known only from the target the sheet records on the fungicide
// application, so without the capture no area can be shown to be a large patch and the rule would never apply (fail closed).
function lawnDecLargePatchKLive() {
  return process.env.GATE_LAWN_DEC_LARGE_PATCH_K === 'true' && lawnTroubleAreasLive() && lawnSpotTargetLive();
}

// GATE_LAWN_RECLAIMED_HALF_N read at CALL time — strict `'true'` only, so an unset variable is the kill switch (owner 2026-10-23). The plan
// halves a reclaimed lawn's N lines, the office property panel shows the reclaimed control and the daily county-layer job runs only while
// it is on; off = the old plan and routes exactly.
function lawnReclaimedHalfNLive() {
  return process.env.GATE_LAWN_RECLAIMED_HALF_N === 'true';
}

// GATE_LAWN_NO_SEASON_BOOST read at CALL time — strict `'true'` only, so an unset variable is the kill switch (owner 2026-10-24, lawn scoring review
// "GO", step 4). New lawn visit assessments store turf_density and color_health as the model derived them, with no season multiplier; the prompt
// already asks for color "for the season". Off = the seasonal boost exactly.
function lawnNoSeasonBoostLive() {
  return process.env.GATE_LAWN_NO_SEASON_BOOST === 'true';
}

// GATE_LAWN_CHINCH_TETRINO_RATE read at CALL time — strict `'true'` only, so an unset variable is the kill switch. Live only while the
// trouble areas are too (fail closed): the rule reads the mapped chinch areas, and lawnTroubleAreasLive() already needs the v13 program.
// The plan, the tank sheet and the previsit brief follow this one reader; off = the old rate exactly.
function lawnChinchTetrinoRateLive() {
  return process.env.GATE_LAWN_CHINCH_TETRINO_RATE === 'true' && lawnTroubleAreasLive();
}

// GATE_LAWN_NEW_SOD_REPORT_CARD read at CALL time — strict `'true'` only, so an unset variable is the kill switch.
// It also needs the sheet's own holds (GATE_LAWN_NEW_SOD_NOTE): the card is frozen from the sod-aware context. Controls
// the freeze at completion and the payload key (lawn-sod-report-card.js); off = no freeze, the old payload exactly.
function lawnNewSodReportCardLive() {
  return process.env.GATE_LAWN_NEW_SOD_REPORT_CARD === 'true' && lawnNewSodNoteLive();
}

// GATE_LAWN_SPOT_TARGET read at CALL time — strict `'true'` only, so an unset variable is the kill switch. Live only while the
// treatment guide is too (fail closed): the confirmation of a row's type uses the guide's staged sets. The context key, the sheet's
// control and the completion's stored targets all follow this one reader; off = the old behavior exactly.
function lawnSpotTargetLive() {
  return process.env.GATE_LAWN_SPOT_TARGET === 'true' && lawnTreatmentGuideLive();
}

// GATE_LAWN_PHOTO_LABEL_PICK read at CALL time — strict `'true'` only, so an unset variable is the kill switch. Controls the sheet's
// "Shown to the customer as" chooser (via the assess lookup), the stored pick and the report's label; off = the old behavior exactly.
function lawnPhotoLabelPickLive() {
  return process.env.GATE_LAWN_PHOTO_LABEL_PICK === 'true';
}

// GATE_LAWN_REPORT_FACTS read at CALL time — strict `'true'` only, so an unset variable is the kill
// switch. It controls ONLY the freeze at completion (the lawn write gate): a render and the PDF key
// read what the record already carries and never this gate, so a flip cannot change a stored report.
function lawnReportFactsLive() {
  return process.env.GATE_LAWN_REPORT_FACTS === 'true';
}

// The TIE part of GATE_LAWN_REPORT_FACTS (the finding-to-product tie and its curative "What to expect" line) is
// live only while the surfaces that print it are live: the Visit Summary freeze (GATE_LAWN_VISIT_SUMMARY_V2 writes
// the tie sentences); the v6 copy that prints the "What to expect" line is always live. With the Visit Summary
// dark, no tie is frozen. The re-entry condition and the spot-product text need no other gate. This is the one
// place the dependency is stated.
function lawnReportTiesLive() {
  return lawnReportFactsLive() && lawnVisitSummaryV2Live();
}

// GATE_AIO_GAP_SWEEP_MONTHLY read at CALL time — strict 'true' only, so an
// unset variable is off. Lets the scheduler start the monthly AI Overview gap
// sweep (services/seo/aio-gap-sweep.js) on the 2nd. A manual sweep started
// from the admin route needs no gate.
function aioGapSweepMonthlyLive() {
  return process.env.GATE_AIO_GAP_SWEEP_MONTHLY === 'true';
}

// GATE_PAYROLL read at CALL time — strict 'true' only, so an unset variable is
// off. Gates the basic payroll settings (services/payroll-w4.js, routes/
// admin-payroll.js): W-4 elections typed from the paper form and each W-2
// technician's pay method. Stores no SSN and no bank account number.
function payrollLive() {
  return process.env.GATE_PAYROLL === 'true';
}

// GATE_PAYROLL_TAX_CALENDAR read at CALL time — strict 'true' only, so an unset
// variable is off. Gates the payroll tax deposits and filings written to
// tax_filing_calendar (services/payroll-tax-calendar.js). Off = the sync
// returns before any query.
function payrollTaxCalendarLive() {
  return process.env.GATE_PAYROLL_TAX_CALENDAR === 'true';
}

// GATE_TAX_DEADLINE_BELLS read at CALL time — strict 'true' only, so an unset
// variable is off. Gates the bell path of the 8:23 ET tax deadline job
// (services/tax-deadline-reminders.js) and the bell close in PUT
// /api/admin/tax/filings/:id. Off = the owner-phone text, exactly as before.
function taxDeadlineBellsLive() {
  return process.env.GATE_TAX_DEADLINE_BELLS === 'true';
}

// GATE_PAYROLL_MERCURY_STATUS read at CALL time — strict 'true' only, so an unset variable is off. Gates every
// Mercury read for payroll (services/payroll-mercury.js, payroll-mercury-poller.js, mercury-client.js) and the
// payment fields on the pay run. Off = no Mercury call at all and no output gains a key.
function payrollMercuryStatusLive() {
  return process.env.GATE_PAYROLL_MERCURY_STATUS === 'true';
}

// GATE_PAYROLL_MERCURY_PAY read at CALL time — strict 'true' only, and only while the status gate is also on.
// Gates the Send to Mercury and Send again actions. Off = no request to Mercury is ever made.
function payrollMercuryPayLive() {
  return process.env.GATE_PAYROLL_MERCURY_PAY === 'true' && payrollMercuryStatusLive();
}

// GATE_PAYROLL_FORM_FIGURES read at CALL time — strict 'true' only, so an unset
// variable is off. Gates GET /api/admin/payroll/forms (services/payroll-form-
// figures.js) and the Tax forms section of the Payroll tab. Off = the route
// answers 404. Shows figures to an admin; files, pays and sends nothing.
function payrollFormFiguresLive() {
  return process.env.GATE_PAYROLL_FORM_FIGURES === 'true';
}

// GATE_PAYROLL_TIME_OFF read at CALL time — strict 'true' only, so an unset variable is
// off. Gates paid time off and holidays on pay runs (services/payroll-time-off.js,
// payroll-runs.js, payroll-calc.js, routes/admin-payroll.js). Off = every output is
// byte for byte today's.
function payrollTimeOffLive() {
  return process.env.GATE_PAYROLL_TIME_OFF === 'true';
}

// GATE_PAYROLL_PAY_LINES read at CALL time — strict 'true' only, so an unset variable is
// off. Gates the review bonus, commission, health allowance and employer HSA pay lines on
// pay runs and the regular-rate overtime they cause (services/payroll-pay-lines.js,
// payroll-regular-rate.js, payroll-runs.js, payroll-calc.js, payroll-form-figures.js,
// routes/admin-payroll.js). Off = every output and route is byte for byte today's.
function payrollPayLinesLive() {
  return process.env.GATE_PAYROLL_PAY_LINES === 'true';
}

// GATE_BI_TECH_SCORECARD read at CALL time — strict 'true' only, so an unset variable is off.
// Gates techScorecard in get_operations_snapshot and the scorecard lines of the BI agent's
// prompt and tool description (services/bi-agent-tools.js, bi-agent-config.js,
// bi-tech-scorecard.js). Off = the tool output and the prompt are byte for byte today's.
function biTechScorecardLive() {
  return process.env.GATE_BI_TECH_SCORECARD === 'true';
}

// GATE_TRUCK_VIEWS_PER_VEHICLE read at CALL time — strict 'true' only, so an unset variable is
// off. Gates the per-vehicle truck answers and Mileage dashboard list
// (services/intelligence-bar/bouncie-ops-tools.js, services/bouncie-mileage.js getDashboard,
// client MileageTab). Off = every response and the Mileage tab are byte for byte today's.
function truckViewsPerVehicleLive() {
  return process.env.GATE_TRUCK_VIEWS_PER_VEHICLE === 'true';
}

// GATE_PAYROLL_FAMILY_EMPLOYEE read at CALL time — strict 'true' only, so an unset variable
// is off. Gates the family-employee setting and the unemployment tax exemption it causes
// (services/payroll-family-employee.js, payroll-runs.js, payroll-calc.js, payroll-w4.js,
// routes/admin-payroll.js). Off = every output and route is byte for byte today's.
function payrollFamilyEmployeeLive() {
  return process.env.GATE_PAYROLL_FAMILY_EMPLOYEE === 'true';
}

// GATE_PAYROLL_REVIEW_BONUS_IMPORT read at CALL time — strict 'true' only, so an unset variable
// is off. Gates the import of earned review bonus payouts as pay lines on pay runs
// (services/payroll-review-bonuses.js, payroll-runs.js). Needs GATE_PAYROLL_PAY_LINES. Off = nothing
// is imported and every pay run output is byte for byte today's.
function payrollReviewBonusImportLive() {
  return process.env.GATE_PAYROLL_REVIEW_BONUS_IMPORT === 'true';
}

// GATE_COMMISSION_SOLD_BY read at CALL time — strict 'true' only, so an unset variable is off.
// Gates the truck GPS check on field leads (routes/tech-field-lead.js), the estimate Sold by
// auto-fill and its admin routes (services/estimate-sold-by.js, admin-estimate-persistence.js,
// routes/admin-estimates.js) and the tech app's Neighbor flag. Off = the flag route, the modal
// and every estimate path are byte for byte today's and nothing is read, written or shown.
function commissionSoldByLive() {
  return process.env.GATE_COMMISSION_SOLD_BY === 'true';
}

// GATE_PAYROLL_COMMISSION_LEDGER read at CALL time — strict 'true' only, so an unset variable is off.
// Gates the commission ledger (services/payroll-commission.js, payroll-runs.js): commission sales,
// entries and the 'commission' pay lines made from customer payments. Needs GATE_PAYROLL_PAY_LINES.
// Off = no sales or entries are written and every open commission line comes off the next run.
function payrollCommissionLedgerLive() {
  return process.env.GATE_PAYROLL_COMMISSION_LEDGER === 'true';
}

// GATE_PORTAL_CHAT_FACTS read at CALL time — ships DARK, off unless exactly
// 'true'. The one reader for the portal assistant's account-fact tools
// (services/ai-assistant): on, the portal chat can show the customer a
// server-rendered card of their recent payments (the Billing tab's own
// rows) and the model is told only that it was shown; off, the chat has the
// PORTAL_CHAT_SELF_SERVE behavior alone (buttons, no account facts).
function portalChatFactsLive() {
  return process.env.GATE_PORTAL_CHAT_FACTS === 'true';
}

// GATE_PORTAL_CHAT_VISIT_FACTS read at CALL time — ships DARK, off unless
// exactly 'true'. The one reader for the portal assistant's past-visit tool
// and company-facts prompt block (services/ai-assistant). Independent of
// GATE_PORTAL_CHAT_FACTS; both need PORTAL_CHAT_SELF_SERVE.
function portalChatVisitFactsLive() {
  return process.env.GATE_PORTAL_CHAT_VISIT_FACTS === 'true';
}

// GATE_PORTAL_CHAT_RESERVICE read at CALL time — ships DARK, off unless
// exactly 'true'. The one reader for the portal assistant's free re-service
// offer (services/ai-assistant offer_reservice). Needs PORTAL_CHAT_SELF_SERVE.
function portalChatReserviceLive() {
  return process.env.GATE_PORTAL_CHAT_RESERVICE === 'true';
}

// GATE_PORTAL_CHAT_RESERVICE_LAWN read at CALL time — ships DARK, off unless
// exactly 'true'. The lawn line of the portal assistant's re-service offer;
// honoured only while GATE_PORTAL_CHAT_RESERVICE is live (services/ai-assistant).
function portalChatReserviceLawnLive() {
  return process.env.GATE_PORTAL_CHAT_RESERVICE_LAWN === 'true';
}

// GATE_PORTAL_CHAT_EMAIL_CHANGE read at CALL time — ships DARK, off unless
// exactly 'true'. The one reader for the portal assistant's confirmed
// email-change hand-off (services/ai-assistant request_email_change). Needs
// PORTAL_CHAT_SELF_SERVE.
function portalChatEmailChangeLive() {
  return process.env.GATE_PORTAL_CHAT_EMAIL_CHANGE === 'true';
}

// GATE_SMS_COURTESY_AFTER_TEMPLATE read at CALL time — strict `=== 'true'`.
// The one reader for the inbound-SMS courtesy rule after an automated visit
// text (server/routes/twilio-webhook.js lastOutboundAskedQuestion). Off = a
// reply after such a text counts as answering it, as before.
function smsCourtesyAfterTemplateLive() {
  return process.env.GATE_SMS_COURTESY_AFTER_TEMPLATE === 'true';
}

// GATE_SMS_PROMPT_AUTOPROMOTE read at CALL time: 'true' = candidates, exams, activation and
// rollback; 'observe' = candidates, exams and recorded decisions only, nothing activates;
// unset or anything else = off. The canonical reader for sms-prompt-patch.js and the cron.
function smsPromptAutopromoteMode() {
  const raw = String(process.env.GATE_SMS_PROMPT_AUTOPROMOTE || '').trim().toLowerCase();
  if (raw === 'true') return 'true';
  return raw === 'observe' ? 'observe' : 'off';
}

// GATE_SMS_BARE_YES_REPLY read at CALL time — strict `=== 'true'`. The one
// reader for the inbound-SMS bare-YES rule (server/routes/twilio-webhook.js,
// decided by server/services/messaging/bare-yes-reply.js). Off = a bare YES is
// START, as before.
function smsBareYesReplyLive() {
  return process.env.GATE_SMS_BARE_YES_REPLY === 'true';
}

// GATE_STOCK_COUNT_AWARE_USAGE read at CALL time — strict `'true'` only, so an unset variable is the kill switch (owner 2026-10-29, "fix it").
// Closing or back-filling a visit done BEFORE a product's latest physical count writes its usage movement but leaves inventory_on_hand alone,
// because the count already includes that use (server/services/inventory-count-guard.js). Off = every close-out takes its usage off stock, as before.
function stockCountAwareUsageLive() {
  return process.env.GATE_STOCK_COUNT_AWARE_USAGE === 'true';
}

module.exports = { gates, isEnabled, logGateStatus, gateEnvValue, gateEnvTimestamp, discountStackingLive, voiceRelayOpenaiLive, voiceRelayOpenaiInboundLive, reserviceRankAfterNewLive, termiteAnnualPlanSelectionEnabled, leadInspectionLinkLive, recurringSeriesTopUpLive, cancelReseedsRecurringLive, rateReviewLive, cancelReseedInTermLive, estimateConsultationOfferLive, estimateEmailConsultationOfferLive, askWavesTopicRoutingLive, askWavesEmergencyCheckLive, commercialSuiteSizingLive, condoUnitFolioLive, autoDispatchSharedModelLive, bookCapacityCommitLive, visitPrepPhotosLive, reportPhotoContentLive, stampedZeroFreeLive, pestInsiderProofLive, emailTemplateAutomationsMode, ibCancelAppointmentLive, ibCancelWithEffectsLive, emailAreaIntelLive, visitPrepTechAlertsLive, visitPrepPestReadLive, visitPrepReadSweepLive, outlinkTrackingLive, promiseEvidenceCloseLive, promiseContactCheckLive, adminAlertRelevanceLive, alertEpisodesLive, visitPrepPlantReadLive };
module.exports.bookArrivalGraceLive = bookArrivalGraceLive;
module.exports.customerRouteCheckMode = customerRouteCheckMode;
module.exports.reviewNameMatchMode = reviewNameMatchMode;
module.exports.reviewProbableReviewerGuardLive = reviewProbableReviewerGuardLive;
module.exports.assistantRouteTimesMode = assistantRouteTimesMode;
module.exports.lawnScoreScaleV2Live = lawnScoreScaleV2Live;
module.exports.packageFollowupAutobookLive = packageFollowupAutobookLive;
// GATE_LAWN_NO_SEASON_BOOST reader (kept off the end-of-file append point, where gate PRs keep colliding).
module.exports.lawnNoSeasonBoostLive = lawnNoSeasonBoostLive;
// Exported on its own line (not in the shared list above) so concurrent gate
// PRs appending to that one-line list never conflict with this one.
module.exports.knownGateCatalog = knownGateCatalog;
// GATE_PUBLIC_WATERING_PLAN reader, on its own line so gate PRs never conflict.
module.exports.publicWateringPlanLive = publicWateringPlanLive;
// GATE_UNDO_MANUAL_PAYMENT reader, on its own line so gate PRs never conflict.
module.exports.undoManualPaymentLive = undoManualPaymentLive;
// GATE_PARTIAL_PAYMENTS reader, on its own line so gate PRs never conflict.
module.exports.partialPaymentsLive = partialPaymentsLive;
// GATE_IB_RECORD_PAYMENT_PARTIAL reader, on its own line.
module.exports.ibRecordPaymentPartialLive = ibRecordPaymentPartialLive;
// GATE_ADMIN_MFA readers (mid-list, away from the end other gate PRs append to).
module.exports.adminMfaLive = adminMfaLive;
module.exports.adminMfaEnforceLive = adminMfaEnforceLive;
// GATE_IB_DELETE_CUSTOMER reader, on its own line so gate PRs never conflict.
module.exports.ibDeleteCustomerLive = ibDeleteCustomerLive;
// Exported on its own line (not in the shared list above) so concurrent gate
// PRs appending to that one-line list never conflict with this one.
module.exports.smsLinkWrapLive = smsLinkWrapLive;
module.exports.emailAppLinksLive = emailAppLinksLive;
module.exports.homeLineLive = homeLineLive;
// Exported on its own line (not in the shared list above) so concurrent
// gate PRs appending to that one-line list never conflict with this one.
module.exports.portalActivityLive = portalActivityLive;
module.exports.emailSendLaterLive = emailSendLaterLive;
module.exports.smsVoiceProfilePinVersion = smsVoiceProfilePinVersion;
module.exports.smsEditLearningLive = smsEditLearningLive;
module.exports.smsPromptB1Live = smsPromptB1Live;
module.exports.smsJudgeV2Live = smsJudgeV2Live;
module.exports.customerActivityTimelineLive = customerActivityTimelineLive;
module.exports.signupSingleEmailLive = signupSingleEmailLive;
module.exports.leadEmailLinksLive = leadEmailLinksLive;
module.exports.plantIdRefereeLive = plantIdRefereeLive;
module.exports.callCommercialDictatedBookingLive = callCommercialDictatedBookingLive;
module.exports.callCommercialAssessmentBookingLive = callCommercialAssessmentBookingLive;
module.exports.callExtractionSystemPromptLive = callExtractionSystemPromptLive;
module.exports.callExtractionV1FallbackLive = callExtractionV1FallbackLive;
module.exports.callSpellingCollapseTriggerLive = callSpellingCollapseTriggerLive;
module.exports.callFirstNameAdvisoryLive = callFirstNameAdvisoryLive;
module.exports.callbackSpokenNumberLinkLive = callbackSpokenNumberLinkLive;
module.exports.callLeadFormAddressStreetLevelLive = callLeadFormAddressStreetLevelLive;
module.exports.bookPreferredTimeLive = bookPreferredTimeLive;
module.exports.lawnWateringRuleLive = lawnWateringRuleLive;
module.exports.lawnWateringForecastLive = lawnWateringForecastLive;
module.exports.lawnWateringTextForecastLive = lawnWateringTextForecastLive;
module.exports.lawnWateringShortTextLive = lawnWateringShortTextLive;
module.exports.warranty13692CheckLive = warranty13692CheckLive;
module.exports.lawnExpectationsLive = lawnExpectationsLive;
module.exports.lawnCoverageHideDefaultZonesLive = lawnCoverageHideDefaultZonesLive;
module.exports.lawnProgramDetailLive = lawnProgramDetailLive;
module.exports.lawnVisitMemoryLive = lawnVisitMemoryLive;
// Own line (P19b) so concurrent gate PRs appending to the shared list never conflict.
module.exports.lawnPairedRecheckLive = lawnPairedRecheckLive;
module.exports.lawnDiagnosticEvidenceLive = lawnDiagnosticEvidenceLive;
module.exports.lawnSinceLastLive = lawnSinceLastLive;
module.exports.lawnWateringSmsLive = lawnWateringSmsLive;
module.exports.lawnWateringEveryVisitLive = lawnWateringEveryVisitLive;
module.exports.dunningCustomerSchedulePrereqsLive = dunningCustomerSchedulePrereqsLive;
module.exports.dunningCustomerScheduleShadowLive = dunningCustomerScheduleShadowLive;
module.exports.dunningCustomerScheduleLive = dunningCustomerScheduleLive;
module.exports.dunningCustomerScheduleAllowlist = dunningCustomerScheduleAllowlist;
module.exports.dunningCustomerScheduleAllowlistStatus = dunningCustomerScheduleAllowlistStatus;
module.exports.zoneRouteDaysLive = zoneRouteDaysLive;
module.exports.callAddressOnFileAssistLive = callAddressOnFileAssistLive;
module.exports.callRouteSpellingRetryLive = callRouteSpellingRetryLive;
module.exports.lawnAssessmentRefereeLive = lawnAssessmentRefereeLive;
module.exports.billingEmailDetailsLive = billingEmailDetailsLive;
module.exports.multiTechConfirmLive = multiTechConfirmLive;
// GATE_ADS_CAPACITY_WORK_DAYS reader, on its own line so gate PRs never conflict.
module.exports.adsCapacityWorkDaysLive = adsCapacityWorkDaysLive;
// GATE_ADS_GAP_RULE reader, on its own line so gate PRs never conflict.
module.exports.adsGapRuleMode = adsGapRuleMode;
// GATE_TECH_WORK_DAYS reader, on its own line so gate PRs never conflict.
module.exports.techWorkDaysLive = techWorkDaysLive;
// GATE_TECH_JOB_TYPE_CHECKS reader, on its own line so gate PRs never conflict.
module.exports.techJobTypeChecksLive = techJobTypeChecksLive;
// GATE_SECOND_TECH_LOWS reader, on its own line so gate PRs never conflict.
module.exports.secondTechLowsLive = secondTechLowsLive;
// GATE_ALERT_RETENTION reader, on its own line so gate PRs never conflict.
module.exports.alertRetentionMode = alertRetentionMode;
// GATE_SMS_COURTESY_TAIL reader, on its own line so gate PRs never conflict.
module.exports.courtesyTailMode = courtesyTailMode;
// GATE_SERVICE_LINE_MAP reader, on its own line so gate PRs never conflict.
module.exports.serviceLineMapMode = serviceLineMapMode;
// GATE_UNASSIGNED_VISIT_GUARD reader, on its own line so gate PRs never conflict.
module.exports.unassignedVisitGuardLive = unassignedVisitGuardLive;
module.exports.territoryRoutingLive = territoryRoutingLive;
module.exports.territoryNightRunLive = territoryNightRunLive;
module.exports.territoryReadoutLive = territoryReadoutLive;
module.exports.autoDispatchArrivalSearchMode = autoDispatchArrivalSearchMode;
module.exports.autoDispatchDayRulesLive = autoDispatchDayRulesLive;
module.exports.autoDispatchKeepTechLive = autoDispatchKeepTechLive;
// GATE_AUTO_DISPATCH_CATCH_UP reader, on its own line so gate PRs never conflict.
module.exports.autoDispatchCatchUpLive = autoDispatchCatchUpLive;
// Exported on its own line (not in the shared list above) so concurrent gate
// PRs appending to that one-line list never conflict with this one.
module.exports.payAfterFirstVisitLive = payAfterFirstVisitLive;
module.exports.pafExistingCustomersLive = pafExistingCustomersLive;
module.exports.pafSetupFeeLive = pafSetupFeeLive;
module.exports.pafPrepayLive = pafPrepayLive;
module.exports.pafTermiteLive = pafTermiteLive;
module.exports.adminBodyGuardAllLive = adminBodyGuardAllLive;
// PORTAL_CHAT_SELF_SERVE reader, on its own line so gate PRs never conflict.
module.exports.portalChatSelfServeLive = portalChatSelfServeLive;
// gates 1775330914
// GATE_SERIES_MOVE_CARRIES_VISIT reader, on its own line mid-block (not the
// shared list, not the file's last line) so other gate PRs never conflict.
module.exports.seriesMoveCarriesVisitLive = seriesMoveCarriesVisitLive;
// GATE_SERIES_MOVE_SKIP_CLOSED_DAYS reader, on its own line so gate PRs never conflict.
module.exports.seriesMoveSkipClosedDaysLive = seriesMoveSkipClosedDaysLive;
// GATE_REPORT_WRITER_RULES reader, exported at the end of the file (after the
// shared list) so gate PRs adding lines above never touch this one.
module.exports.reportWriterRulesLive = reportWriterRulesLive;
module.exports.pestReportVoiceLive = pestReportVoiceLive;
module.exports.pestQuietVisitLive = pestQuietVisitLive;
module.exports.completionTextPlainLive = completionTextPlainLive;
// GATE_REPORT_BLOG_POST reader, on its own line beside the writer rules'.
module.exports.reportBlogPostLive = reportBlogPostLive;
module.exports.techTipSourcesLive = techTipSourcesLive;
module.exports.reportAskAiLive = reportAskAiLive;
module.exports.standardWordingPreviewLive = standardWordingPreviewLive;
module.exports.blogSearchSuggestLive = blogSearchSuggestLive;
module.exports.kbSpeciesQaLive = kbSpeciesQaLive;
// Exported on its own line (not in the shared list above) so concurrent gate
// PRs appending to that one-line list never conflict with this one.
module.exports.portalYardCalendarLive = portalYardCalendarLive;
// GATE_PORTAL_CHAT_FACTS reader, on its own line so gate PRs never conflict.
module.exports.portalChatFactsLive = portalChatFactsLive;
// GATE_PORTAL_CHAT_VISIT_FACTS reader, on its own line so gate PRs never conflict.
module.exports.portalChatVisitFactsLive = portalChatVisitFactsLive;
// GATE_PORTAL_CHAT_RESERVICE reader, on its own line so gate PRs never conflict.
module.exports.portalChatReserviceLive = portalChatReserviceLive;
// GATE_PORTAL_CHAT_RESERVICE_LAWN reader, on its own line so gate PRs never conflict.
module.exports.portalChatReserviceLawnLive = portalChatReserviceLawnLive;
// GATE_PORTAL_CHAT_EMAIL_CHANGE reader, on its own line so gate PRs never conflict.
module.exports.portalChatEmailChangeLive = portalChatEmailChangeLive;
// GATE_TYPED_DECISIONS reader, on its own line so gate PRs adding lines above
// never touch this one.
module.exports.typedDecisionsLive = typedDecisionsLive;
module.exports.callIncidentsLive = callIncidentsLive;
module.exports.typedDecisionsClefLive = typedDecisionsClefLive;
module.exports.visitAccessShadowLive = visitAccessShadowLive;
module.exports.photoPrivacyMode = photoPrivacyMode;
module.exports.askWavesJevCheckMode = askWavesJevCheckMode;
module.exports.lawnJevTimingCheckMode = lawnJevTimingCheckMode;
module.exports.tsFastCompleteLive = tsFastCompleteLive;
module.exports.tsTechFindingsCopyLive = tsTechFindingsCopyLive;
module.exports.tsLightingLive = tsLightingLive;
module.exports.tsWatchListLive = tsWatchListLive;
// GATE_TS_PEST_CHECK reader, on its own line so gate PRs never conflict.
module.exports.tsPestCheckLive = tsPestCheckLive;
// GATE_TS_OUTLINE reader, on its own line so gate PRs never conflict.
module.exports.tsOutlineLive = tsOutlineLive;
// GATE_PEST_OUTLINE reader, on its own line so gate PRs never conflict.
module.exports.pestOutlineLive = pestOutlineLive;
// GATE_MOSQUITO_OUTLINE reader, on its own line so gate PRs never conflict.
module.exports.mosquitoOutlineLive = mosquitoOutlineLive;
// GATE_TS_NEONIC_CAP reader, on its own line so gate PRs never conflict.
module.exports.tsNeonicCapLive = tsNeonicCapLive;
// GATE_TS_TECH_PARAGRAPH reader, on its own line so gate PRs never conflict.
module.exports.tsTechParagraphLive = tsTechParagraphLive;
module.exports.lawnReserviceFastCompleteLive = lawnReserviceFastCompleteLive;
module.exports.lawnFastCompleteLive = lawnFastCompleteLive;
module.exports.noteBoxPhotosLive = noteBoxPhotosLive;
module.exports.laneVoiceFillLive = laneVoiceFillLive;
module.exports.typedVoiceFillLive = typedVoiceFillLive;
// GATE_LLM_COST_TRACKING reader, on its own line.
module.exports.llmCostTrackingLive = llmCostTrackingLive;
// GATE_FAST_COMPLETE_VOICE_FILL reader, on its own line so gate PRs adding lines above
// never touch this one.
module.exports.fastCompleteVoiceFillLive = fastCompleteVoiceFillLive;
// GATE_FAST_COMPLETE_REPORT reader, on its own line so gate PRs adding lines
// above never touch this one.
module.exports.fastCompleteReportLive = fastCompleteReportLive;
// GATE_KB_CUSTOMER_AUDIENCE reader, on its own line.
module.exports.kbCustomerAudienceLive = kbCustomerAudienceLive;
// GATE_LAWN_WIKI_PAUSE reader, on its own line.
module.exports.lawnWikiPauseLive = lawnWikiPauseLive;
// GATE_SERIES_MOVE_TEXT_COALESCE reader, on its own line.
module.exports.seriesMoveTextCoalesceLive = seriesMoveTextCoalesceLive;
// GATE_ESTIMATE_DRAFT_RETIRE_ON_SEND reader. Kept here, away from the end of the file, so gate PRs appending there never conflict with it.
module.exports.estimateDraftRetireOnSendLive = estimateDraftRetireOnSendLive;
module.exports.reportOnlyPaymentAlertLive = reportOnlyPaymentAlertLive;
// GATE_SMS_UNANSWERED_REPLY reader, on its own line.
module.exports.smsUnansweredReplyLive = smsUnansweredReplyLive;
// GATE_NEIGHBORHOOD_ACCESS reader, on its own line.
module.exports.neighborhoodAccessLive = neighborhoodAccessLive;
// GATE_NEIGHBORHOOD_NAMING reader, on its own line.
module.exports.neighborhoodNamingLive = neighborhoodNamingLive;
// GATE_NEIGHBORHOOD_ADDRESS_LOOKUP reader, on its own line.
module.exports.neighborhoodAddressLookupLive = neighborhoodAddressLookupLive;
// GATE_NEIGHBORHOOD_TECH_ACTIONS reader, on its own line.
module.exports.neighborhoodTechActionsLive = neighborhoodTechActionsLive;
// GATE_NEIGHBORHOOD_MERGE reader, on its own line.
module.exports.neighborhoodMergeLive = neighborhoodMergeLive;
// GATE_NEIGHBORHOOD_UNPLACED reader, on its own line.
module.exports.neighborhoodUnplacedLive = neighborhoodUnplacedLive;
// GATE_SCHEDULE_ACCESS_CODES reader, on its own line.
module.exports.scheduleAccessCodesLive = scheduleAccessCodesLive;
// GATE_CONTACT_REPORT_TEXT reader, on its own line.
module.exports.contactReportTextLive = contactReportTextLive;
// GATE_CONTACT_LOGIN reader, on its own line.
module.exports.contactLoginLive = contactLoginLive;
// GATE_IB_STAFF_AUTOPAY_OFF reader, on its own line.
module.exports.ibStaffAutopayOffLive = ibStaffAutopayOffLive;
// GATE_HIRED_PACKET reader, on its own line.
module.exports.hiredPacketLive = hiredPacketLive;
// GATE_STAFF_DOC_PREFILL reader, on its own line.
module.exports.staffDocPrefillLive = staffDocPrefillLive;
// GATE_IB_ACCEPT_ESTIMATE reader, on its own line.
module.exports.ibAcceptEstimateLive = ibAcceptEstimateLive;
// GATE_IB_RECORD_PAYMENT reader, on its own line.
module.exports.ibRecordPaymentLive = ibRecordPaymentLive;
// GATE_IB_LEAD_CONVERT reader, on its own line.
module.exports.ibLeadConvertLive = ibLeadConvertLive;
// GATE_IB_MODEL_FAILURE_NOTICE reader, on its own line.
module.exports.ibModelFailureNoticeLive = ibModelFailureNoticeLive;
// GATE_SHORTLINK_LEGACY_EXPIRE reader, on its own line.
module.exports.shortlinkLegacyExpireLive = shortlinkLegacyExpireLive;
module.exports.reserviceDetailsRequiredLive = reserviceDetailsRequiredLive;
// GATE_REFERRAL_INBOUND_CONFIRM reader, on its own line so gate PRs never conflict.
module.exports.referralInboundConfirmLive = referralInboundConfirmLive;
// GATE_REFERRAL_INBOUND_BELL reader, on its own line so gate PRs never conflict.
module.exports.referralInboundBellLive = referralInboundBellLive;
// GATE_ALERT_CLOSE_BUTTONS reader, on its own line so gate PRs never conflict.
module.exports.alertCloseButtonsLive = alertCloseButtonsLive;
// GATE_BID_ALERT_BUTTONS reader, on its own line so gate PRs never conflict.
module.exports.bidAlertButtonsLive = bidAlertButtonsLive;
module.exports.reservicePhotosLive = reservicePhotosLive;
module.exports.reviewLowRatingAlertLive = reviewLowRatingAlertLive;
// GATE_DUPLICATES_SAME_ADDRESS reader, on its own line.
module.exports.duplicatesSameAddressLive = duplicatesSameAddressLive;
// GATE_DUPLICATES_SAME_NAME reader, on its own line.
module.exports.duplicatesSameNameLive = duplicatesSameNameLive;
// GATE_ESTIMATE_SENT_CLOSES_ASSESSMENT reader, on its own line.
module.exports.estimateSentClosesAssessmentLive = estimateSentClosesAssessmentLive;
// GATE_PERMIT_DETAIL_SYNC reader, on its own line so gate PRs never conflict.
module.exports.permitDetailSyncLive = permitDetailSyncLive;
// GATE_LOOKUP_BUSINESS_IDENTITY reader, on its own line so gate PRs never conflict.
module.exports.lookupBusinessIdentityLive = lookupBusinessIdentityLive;
// GATE_LOOKUP_LISTING_SIZE reader, on its own line so gate PRs never conflict.
module.exports.lookupListingSizeLive = lookupListingSizeLive;
// GATE_LOOKUP_ADDRESS_STATUS reader, on its own line so gate PRs never conflict.
module.exports.lookupAddressStatusLive = lookupAddressStatusLive;
// GATE_LOOKUP_PERMIT_FACTS reader, on its own line so gate PRs never conflict.
module.exports.lookupPermitFactsLive = lookupPermitFactsLive;
// GATE_LAWN_RAINFAST_WATCH reader, on its own line so gate PRs never conflict.
module.exports.lawnRainfastWatchLive = lawnRainfastWatchLive;
// GATE_LAWN_LIGHTING reader, on its own line so gate PRs never conflict.
module.exports.lawnLightingLive = lawnLightingLive;
// GATE_LAWN_REPORT_PHOTO_SET reader, on its own line so gate PRs never conflict.
module.exports.lawnReportPhotoSetLive = lawnReportPhotoSetLive;
// GATE_LAWN_REPORT_PHOTO_FINDINGS reader, on its own line so gate PRs never conflict.
module.exports.lawnReportPhotoFindingsLive = lawnReportPhotoFindingsLive;
// GATE_MISSED_CALL_TEXT_BACK_EMPTY_VOICEMAIL reader, on its own line so gate PRs never conflict.
module.exports.missedCallTextBackEmptyVoicemailLive = missedCallTextBackEmptyVoicemailLive;
// GATE_RELAY_UNBOOKED_HANDOFF reader, on its own line so gate PRs never conflict.
module.exports.relayUnbookedHandoffLive = relayUnbookedHandoffLive;
// GATE_LAWN_TECH_PARAGRAPH reader, on its own line so gate PRs never conflict.
module.exports.lawnTechParagraphLive = lawnTechParagraphLive;
// GATE_LAWN_VISIT_SUMMARY_V2 reader, on its own line so gate PRs never conflict.
module.exports.lawnVisitSummaryV2Live = lawnVisitSummaryV2Live;
// GATE_LAWN_REPORT_COPY_FIXES reader, on its own line so gate PRs never conflict.
module.exports.lawnReportCopyFixesLive = lawnReportCopyFixesLive;
// GATE_LAWN_REPORT_LAYOUT reader, on its own line so gate PRs never conflict.
module.exports.lawnReportLayoutLive = lawnReportLayoutLive;

// GATE_LAWN_REPORT_STORY read at CALL time, strict `=== 'true'` (customer-facing layout), dark in every environment.
// The one reader for the lawn report story order: story:true is added inside the `lawnLayout` payload key
// (lawn-report-layout.js), so only a report the lawn layout already orders can take it. Off = the payload and the
// layout order are byte-identical to before.
function lawnReportStoryLive() {
  return process.env.GATE_LAWN_REPORT_STORY === 'true';
}
// GATE_LAWN_REPORT_STORY reader, on its own line so gate PRs never conflict.
module.exports.lawnReportStoryLive = lawnReportStoryLive;
// GATE_LAWN_REPORT_POLISH reader, on its own line so gate PRs never conflict.
module.exports.lawnReportPolishLive = lawnReportPolishLive;
module.exports.lawnReportPolishFreezeLive = lawnReportPolishFreezeLive;
// GATE_LAWN_REPORT_STAGE1_FIXES reader, on its own line so gate PRs never conflict.
module.exports.lawnReportStage1FixesLive = lawnReportStage1FixesLive;
module.exports.lawnWaterRainLive = lawnWaterRainLive;
module.exports.lawnWaterRainFreezeLive = lawnWaterRainFreezeLive;
// GATE_LAWN_WATER_IN_RAIN reader, on its own line so gate PRs never conflict.
module.exports.lawnWaterInRainLive = lawnWaterInRainLive;
// GATE_ONSITE_CALLER_DEMOTE reader, on its own line so gate PRs never conflict.
module.exports.onSiteCallerDemoteLive = onSiteCallerDemoteLive;
// GATE_PREPAY_MINT_PRICE_HOLD reader, on its own line so gate PRs never conflict.
module.exports.prepayMintPriceHoldMode = prepayMintPriceHoldMode;
module.exports.sprayRainRulesMode = sprayRainRulesMode;
// GATE_ALERT_CONTACT_CLOSE reader, on its own line so gate PRs never conflict.
module.exports.alertContactCloseMode = alertContactCloseMode;
// GATE_VOICEMAIL_VISIT_UNDERWAY reader, on its own line so gate PRs never conflict.
module.exports.voicemailVisitUnderwayMode = voicemailVisitUnderwayMode;
// GATE_LEAD_CONTACTED_CLOSE reader, on its own line so gate PRs never conflict.
module.exports.leadContactedCloseMode = leadContactedCloseMode;
// GATE_LEAD_REPEAT_SWEEP reader, on its own line so gate PRs never conflict.
module.exports.leadRepeatSweepLive = leadRepeatSweepLive;
// GATE_PORTAL_CHAT_ANSWERED_CLOSE reader, on its own line so gate PRs never conflict.
module.exports.portalChatAnsweredCloseMode = portalChatAnsweredCloseMode;
// GATE_ESTIMATE_OFFER_TIERS reader, on its own line so gate PRs never conflict.
module.exports.estimateOfferTiersLive = estimateOfferTiersLive;
// GATE_LAWN_V13 reader, on its own line so gate PRs never conflict.
module.exports.lawnV13Live = lawnV13Live;
// GATE_LAWN_BERMUDA_REMOVAL reader, on its own line so gate PRs never conflict.
module.exports.lawnBermudaRemovalLive = lawnBermudaRemovalLive;
// GATE_LAWN_OUTLINE_V13 reader, on its own line so gate PRs never conflict.
module.exports.lawnOutlineV13Live = lawnOutlineV13Live;
// GATE_LAWN_OUTLINE_DETAIL reader, on its own line so gate PRs never conflict.
module.exports.lawnOutlineDetailLive = lawnOutlineDetailLive;
// GATE_LAWN_OUTLINE_VISUAL reader, on its own line so gate PRs never conflict.
module.exports.lawnOutlineVisualLive = lawnOutlineVisualLive;
// GATE_LAWN_SPOT_RULES reader, on its own line so gate PRs never conflict.
module.exports.lawnSpotRulesLive = lawnSpotRulesLive;
// GATE_LAWN_TREATMENT_GUIDE reader, on its own line so gate PRs never conflict.
module.exports.lawnTreatmentGuideLive = lawnTreatmentGuideLive;
// GATE_LAWN_TROUBLE_AREAS reader, on its own line so gate PRs never conflict.
module.exports.lawnTroubleAreasLive = lawnTroubleAreasLive;
// GATE_LAWN_NEW_SOD_NOTE reader, on its own line so gate PRs never conflict.
module.exports.lawnNewSodNoteLive = lawnNewSodNoteLive;
// GATE_LAWN_NOV_LARGE_PATCH_N reader, on its own line so gate PRs never conflict.
module.exports.lawnNovLargePatchNLive = lawnNovLargePatchNLive;
// GATE_LAWN_DEC_LARGE_PATCH_K reader, on its own line so gate PRs never conflict.
module.exports.lawnDecLargePatchKLive = lawnDecLargePatchKLive;
// GATE_LAWN_CHINCH_TETRINO_RATE reader, on its own line so gate PRs never conflict.
module.exports.lawnChinchTetrinoRateLive = lawnChinchTetrinoRateLive;
// GATE_LAWN_NEW_SOD_REPORT_CARD reader, on its own line so gate PRs never conflict.
module.exports.lawnNewSodReportCardLive = lawnNewSodReportCardLive;
// GATE_LAWN_SPOT_TARGET reader, on its own line so gate PRs never conflict.
module.exports.lawnSpotTargetLive = lawnSpotTargetLive;
// GATE_LAWN_PHOTO_LABEL_PICK reader, on its own line so gate PRs never conflict.
module.exports.lawnPhotoLabelPickLive = lawnPhotoLabelPickLive;
// GATE_LAWN_REPORT_FACTS reader, on its own line so gate PRs never conflict.
module.exports.lawnReportFactsLive = lawnReportFactsLive;
// GATE_LAWN_REPORT_FACTS tie part (needs the Visit Summary and report lead gates), on its own line.
module.exports.lawnReportTiesLive = lawnReportTiesLive;
// GATE_MULTI_TECH_TEXT_TIMES reader, on its own line so gate PRs never conflict.
module.exports.multiTechTextTimesLive = multiTechTextTimesLive;
// GATE_SERVER_DICTATION reader, on its own line so gate PRs never conflict.
module.exports.serverDictationLive = serverDictationLive;
// GATE_REPORT_PLAN_RESCHEDULE reader, on its own line so gate PRs never conflict.
module.exports.reportPlanRescheduleLive = reportPlanRescheduleLive;
// GATE_IB_INVOICE_ACTIONS reader, on its own line so gate PRs never conflict.
module.exports.ibInvoiceActionsLive = ibInvoiceActionsLive;
// GATE_IB_INVOICE_EMAIL reader, on its own line so gate PRs never conflict.
module.exports.ibInvoiceEmailLive = ibInvoiceEmailLive;
// GATE_IB_REPRICE_VISITS reader, on its own line so gate PRs never conflict.
module.exports.ibRepriceVisitsLive = ibRepriceVisitsLive;
// GATE_IB_MULTI_CARD reader, on its own line so gate PRs never conflict.
module.exports.ibMultiCardLive = ibMultiCardLive;
// GATE_IB_VOID_INVOICE reader, on its own line.
module.exports.ibVoidInvoiceLive = ibVoidInvoiceLive;
// GATE_IB_SCHEDULE_SMS reader, on its own line.
module.exports.ibScheduleSmsLive = ibScheduleSmsLive;
// GATE_IB_INVOICE_EDITS reader, on its own line.
module.exports.ibInvoiceEditsLive = ibInvoiceEditsLive;
// GATE_IB_INVOICE_REMINDERS reader, on its own line.
module.exports.ibInvoiceRemindersLive = ibInvoiceRemindersLive;
// GATE_IB_PAYMENT_PLAN reader, on its own line.
module.exports.ibPaymentPlanLive = ibPaymentPlanLive;
// GATE_IB_CREATE_INVOICE reader, on its own line.
module.exports.ibCreateInvoiceLive = ibCreateInvoiceLive;
// GATE_IB_SET_BILL_TO reader, on its own line so gate PRs never conflict.
module.exports.ibSetBillToLive = ibSetBillToLive;
// GATE_IB_AGENT_REVIEW_DRAFTS reader, on its own line so gate PRs never conflict.
module.exports.ibAgentReviewDraftsLive = ibAgentReviewDraftsLive;
// GATE_IB_RESOLVE_DISPATCH_ALERT reader, on its own line so gate PRs never conflict.
module.exports.ibResolveDispatchAlertLive = ibResolveDispatchAlertLive;
// GATE_IB_UNBLOCK_SENDER reader, on its own line so gate PRs never conflict.
module.exports.ibUnblockSenderLive = ibUnblockSenderLive;
// GATE_IB_COMPOSE_EMAIL reader, on its own line so gate PRs never conflict.
module.exports.ibComposeEmailLive = ibComposeEmailLive;
// GATE_IB_GENERAL_READ reader, on its own line so gate PRs never conflict.
module.exports.ibGeneralReadLive = ibGeneralReadLive;
// GATE_IB_READ_NOTES reader, on its own line so gate PRs never conflict.
module.exports.ibReadNotesLive = ibReadNotesLive;
// GATE_IB_GENERAL_READ_OFFICE reader, on its own line so gate PRs never conflict.
module.exports.ibGeneralReadOfficeLive = ibGeneralReadOfficeLive;
// GATE_IB_GENERAL_EDIT reader, on its own line so gate PRs never conflict.
module.exports.ibGeneralEditLive = ibGeneralEditLive;
// GATE_IB_TOOL_SEARCH reader, on its own line so gate PRs never conflict.
module.exports.ibToolSearchLive = ibToolSearchLive;
// GATE_IB_OPENAI_BACKUP reader, on its own line so gate PRs never conflict.
module.exports.ibOpenaiBackupLive = ibOpenaiBackupLive;
// GATE_IB_BILLING_MODE_EDIT reader, on its own line so gate PRs never conflict.
module.exports.ibBillingModeEditLive = ibBillingModeEditLive;
// GATE_AIO_GAP_SWEEP_MONTHLY reader, on its own line so gate PRs never conflict.
module.exports.aioGapSweepMonthlyLive = aioGapSweepMonthlyLive;
// GATE_PAYROLL reader, on its own line so gate PRs never conflict.
module.exports.payrollLive = payrollLive;
// GATE_PAYROLL_TAX_CALENDAR reader, on its own line so gate PRs never conflict.
module.exports.payrollTaxCalendarLive = payrollTaxCalendarLive;
// GATE_TAX_DEADLINE_BELLS reader, on its own line so gate PRs never conflict.
module.exports.taxDeadlineBellsLive = taxDeadlineBellsLive;
// GATE_PAYROLL_MERCURY_STATUS reader, on its own line so gate PRs never conflict.
module.exports.payrollMercuryStatusLive = payrollMercuryStatusLive;
// GATE_PAYROLL_MERCURY_PAY reader, on its own line so gate PRs never conflict.
module.exports.payrollMercuryPayLive = payrollMercuryPayLive;
// GATE_PAYROLL_FORM_FIGURES reader, on its own line so gate PRs never conflict.
module.exports.payrollFormFiguresLive = payrollFormFiguresLive;
// GATE_PAYROLL_TIME_OFF reader, on its own line so gate PRs never conflict.
module.exports.payrollTimeOffLive = payrollTimeOffLive;
// GATE_PAYROLL_PAY_LINES reader, on its own line so gate PRs never conflict.
module.exports.payrollPayLinesLive = payrollPayLinesLive;
// GATE_BI_TECH_SCORECARD reader, on its own line so gate PRs never conflict.
module.exports.biTechScorecardLive = biTechScorecardLive;
// GATE_TRUCK_VIEWS_PER_VEHICLE reader, on its own line so gate PRs never conflict.
module.exports.truckViewsPerVehicleLive = truckViewsPerVehicleLive;
// GATE_PAYROLL_FAMILY_EMPLOYEE reader, on its own line so gate PRs never conflict.
module.exports.payrollFamilyEmployeeLive = payrollFamilyEmployeeLive;
// GATE_PAYROLL_REVIEW_BONUS_IMPORT reader, on its own line so gate PRs never conflict.
module.exports.payrollReviewBonusImportLive = payrollReviewBonusImportLive;
// GATE_COMMISSION_SOLD_BY reader, on its own line so gate PRs never conflict.
module.exports.commissionSoldByLive = commissionSoldByLive;
// GATE_PAYROLL_COMMISSION_LEDGER reader, on its own line so gate PRs never conflict.
module.exports.payrollCommissionLedgerLive = payrollCommissionLedgerLive;
// GATE_IB_TIER_UPGRADE_EMAIL reader, on its own line so gate PRs never conflict.
module.exports.ibTierUpgradeEmailLive = ibTierUpgradeEmailLive;
// GATE_STAFF_ONBOARDING_DOCS reader, on its own line so gate PRs never conflict.
module.exports.staffOnboardingDocsLive = staffOnboardingDocsLive;
// GATE_TRUCK_CLOCK_IN reader, on its own line so gate PRs never conflict.
module.exports.truckClockInMode = truckClockInMode;
// GATE_CALL_LAST_NAME_LOOKUP reader, on its own line so gate PRs never conflict.
module.exports.callLastNameLookupLive = callLastNameLookupLive;
// GATE_PIN_PARKED_CHECK reader, on its own line so gate PRs never conflict.
module.exports.pinParkedCheckLive = pinParkedCheckLive;
// GATE_TRIP_LINK reader, on its own line so gate PRs never conflict.
module.exports.tripLinkLive = tripLinkLive;
// GATE_AUTO_LUNCH reader, on its own line so gate PRs never conflict.
module.exports.autoLunchLive = autoLunchLive;
module.exports.truckKitLive = truckKitLive;
// GATE_LAWN_REPORT_CLARITY reader, on its own line so gate PRs never conflict.
module.exports.lawnReportClarityLive = lawnReportClarityLive;
// GATE_FAST_COMPLETE_INVOICED_VISITS reader, on its own line so gate PRs never conflict.
module.exports.fastCompleteInvoicedVisitsLive = fastCompleteInvoicedVisitsLive;

// GATE_AGENT_SESSION_GUARD read at CALL time, strict `=== 'true'`: a flip or
// an unset kill needs no restart.
function agentSessionGuardLive() {
  return process.env.GATE_AGENT_SESSION_GUARD === 'true';
}
// GATE_AGENT_SESSION_GUARD reader, on its own line so gate PRs never conflict.
module.exports.agentSessionGuardLive = agentSessionGuardLive;
// GATE_STATION_FAST_COMPLETE reader, on its own line so gate PRs never conflict.
module.exports.stationFastCompleteLive = stationFastCompleteLive;

// GATE_LEAD_SERVICE_DISPLAY read at CALL time, strict `=== 'true'`: a flip or
// an unset kill needs no restart.
function leadServiceDisplayLive() {
  return process.env.GATE_LEAD_SERVICE_DISPLAY === 'true';
}
// GATE_LEAD_SERVICE_DISPLAY reader, on its own line so gate PRs never conflict.
module.exports.leadServiceDisplayLive = leadServiceDisplayLive;

// GATE_ASSESSMENT_FAST_COMPLETE read at CALL time — strict `=== 'true'`, dark in
// every environment. On, the schedule payload's per-service
// `assessmentFastCompleteEnabled` is true for a Waves Assessment visit, and admin
// Dispatch opens its one-screen Fast Complete sheet instead of the full form.
function assessmentFastCompleteLive() {
  return process.env.GATE_ASSESSMENT_FAST_COMPLETE === 'true';
}
// GATE_ASSESSMENT_FAST_COMPLETE reader, on its own line so gate PRs never conflict.
module.exports.assessmentFastCompleteLive = assessmentFastCompleteLive;

// GATE_FAST_COMPLETE_WRAP_UP read at CALL time, strict `=== 'true'`, dark in every environment.
function fastCompleteWrapUpLive() {
  return process.env.GATE_FAST_COMPLETE_WRAP_UP === 'true';
}
// GATE_FAST_COMPLETE_WRAP_UP reader, on its own line so gate PRs never conflict.
module.exports.fastCompleteWrapUpLive = fastCompleteWrapUpLive;

// GATE_PET_NAME_TEXT read at CALL time, strict `=== 'true'`, dark in every environment.
function petNameTextLive() {
  return process.env.GATE_PET_NAME_TEXT === 'true';
}
// GATE_PET_NAME_TEXT reader, on its own line so gate PRs never conflict.
module.exports.petNameTextLive = petNameTextLive;

// GATE_ONE_TEXT_PER_CUSTOMER_DAY read at CALL time, strict `=== 'true'`, dark in every environment.
function oneTextPerCustomerDayLive() {
  return process.env.GATE_ONE_TEXT_PER_CUSTOMER_DAY === 'true';
}
// GATE_ONE_TEXT_PER_CUSTOMER_DAY reader, on its own line so gate PRs never conflict.
module.exports.oneTextPerCustomerDayLive = oneTextPerCustomerDayLive;

// GATE_ONE_TAP_REPORT read at CALL time, strict `=== 'true'`, dark in every environment.
// On, the recurring pest report sheet starts its AI writer on the 1-5 rating tap, makes the trace optional
// (typed feet cover it) and reads no AI note for products. Off = today's sheet.
function oneTapReportLive() {
  return process.env.GATE_ONE_TAP_REPORT === 'true';
}
// GATE_ONE_TAP_REPORT reader, on its own line so gate PRs never conflict.
module.exports.oneTapReportLive = oneTapReportLive;

// GATE_PEST_RAIN_OUTLOOK read at CALL time, strict `=== 'true'`, dark in every environment (owner 2026-10-24).
// On, a pest visit's completion freezes a 48-hour rain outlook in structured_notes.rainOutlook (a second forecast
// fetch beside the conditions fetch) and the report's Weather call card may add, after its own text, dry weather
// ahead, or rain ahead with a sentence on how dried spray behaves when the visit's outside sprays are fipronil or
// pyrethroid.
// Off = no forecast call, no key on the record, card and PDF key byte-identical to before.
function pestRainOutlookLive() {
  return process.env.GATE_PEST_RAIN_OUTLOOK === 'true';
}
// GATE_PEST_RAIN_OUTLOOK reader, on its own line so gate PRs never conflict.
module.exports.pestRainOutlookLive = pestRainOutlookLive;

// GATE_PEST_LABEL_FACTS read at CALL time, strict `=== 'true'`, dark in every environment (owner 2026-10-24, "labels
// go"). On, the pest report writer's PRODUCT FACTS add "its label lists <pest>" for a pest the technician named today
// (note, observations, product tags) that the product's reviewed EPA label list names (label-pest-facts.js). Off =
// the block is byte-identical to before.
function pestLabelFactsLive() {
  return process.env.GATE_PEST_LABEL_FACTS === 'true';
}
// GATE_PEST_LABEL_FACTS reader, on its own line so gate PRs never conflict.
module.exports.pestLabelFactsLive = pestLabelFactsLive;

// GATE_SPECIALTY_REPORT_VOICE read at CALL time, strict `=== 'true'`, dark in every environment (owner 2026-10-24,
// "yes build voice"). On (with GATE_REPORT_WRITER_RULES), the termite, cockroach, rodent and mosquito report writers
// get one prompt in the pest report's voice (service-report/specialty-report-voice.js) in place of their stacked
// blocks, and the route leaves out the same empty input lines as the quiet pest writer. Output screens are unchanged.
// Off = their prompts and inputs are byte-identical to before.
function specialtyReportVoiceLive() {
  return process.env.GATE_SPECIALTY_REPORT_VOICE === 'true';
}
// GATE_SPECIALTY_REPORT_VOICE reader, on its own line so gate PRs never conflict.
module.exports.specialtyReportVoiceLive = specialtyReportVoiceLive;

// GATE_SMS_COURTESY_AFTER_TEMPLATE reader, on its own line so gate PRs never conflict.
module.exports.smsCourtesyAfterTemplateLive = smsCourtesyAfterTemplateLive;
// GATE_SMS_BARE_YES_REPLY reader, on its own line so gate PRs never conflict.
module.exports.smsBareYesReplyLive = smsBareYesReplyLive;

// GATE_ALERT_RING_ONCE read at CALL time, strict `=== 'true'`, dark in every environment.
// On, an overdue promise bell (SMS and email, ringOverdueBell) never makes a second row or
// ring while its first row is still open, and the call booking-miss watchdog skips its
// repeat rings. Off = today's behavior, byte for byte.
function alertRingOnceLive() {
  return process.env.GATE_ALERT_RING_ONCE === 'true';
}
// GATE_ALERT_RING_ONCE reader, on its own line so gate PRs never conflict.
module.exports.alertRingOnceLive = alertRingOnceLive;

// GATE_ACCEPTED_PLAN_RING_ON_CHANGE read at CALL time, strict `=== 'true'`, dark in every environment
// (owner 2026-10-29, "go"). On, the schedule-integrity watchdog versions its "Accepted recurring plan
// needs schedule review" bell by the finding (issues, pattern, planned and recorded counts) instead of
// every visit row's revision and date, so a routine visit edit no longer rings a standing bell again
// or undoes a person's Done; a changed finding still rings. Off = today's behavior, byte for byte.
function acceptedPlanRingOnChangeLive() {
  return process.env.GATE_ACCEPTED_PLAN_RING_ON_CHANGE === 'true';
}
// GATE_ACCEPTED_PLAN_RING_ON_CHANGE reader, on its own line so gate PRs never conflict.
module.exports.acceptedPlanRingOnChangeLive = acceptedPlanRingOnChangeLive;

// GATE_CUSTOMER_ALERTS_RING read at CALL time, strict `=== 'true'`, dark in every environment (owner 2026-10-29,
// "small" E1 of the admin bell rebuild). On, an admin alert declared as a customer contact or as a promise we owe a
// customer (registry rule `contact`/`promise`, or the same flag in the alert's metadata) rings whatever else the bell
// policy says, and a customer's failed invoice payment (bill_payment_error) rings beside payment_failed. Off = what
// rings is today's behavior, byte for byte.
function customerAlertsRingLive() {
  return process.env.GATE_CUSTOMER_ALERTS_RING === 'true';
}
// GATE_CUSTOMER_ALERTS_RING reader, on its own line so gate PRs never conflict.
module.exports.customerAlertsRingLive = customerAlertsRingLive;

// GATE_ALERT_CLAUDE_QUEUE read at CALL time, strict `=== 'true'`, dark in every environment (owner 2026-10-26, "ok go").
// On, an admin row that is a reminder from a Claude job on the owner's Mac (metadata.opsJob, unless metadata.opsWho is
// 'person') or one of our own engineering faults (the classes in services/admin-alert-routing.js) is written Activity-only
// and stamped who 'claude': it leaves the owner's bell and `needs-me --who claude` lists it. Off = every row lands as before.
function alertClaudeQueueLive() {
  return process.env.GATE_ALERT_CLAUDE_QUEUE === 'true';
}
// GATE_ALERT_CLAUDE_QUEUE reader, on its own line so gate PRs never conflict.
module.exports.alertClaudeQueueLive = alertClaudeQueueLive;
// GATE_ALERT_CATALOG reader, on its own line so gate PRs never conflict.
module.exports.alertCatalogMode = alertCatalogMode;

// GATE_NEW_CLIENT_CONFIRM_EMAIL read at CALL time, strict `=== 'true'`, dark by default in every environment. The one reader for
// the new-client confirmation promotion: services/appointment-reminders.js resolveConfirmationChannel. Off: a booking confirmation
// keeps today's channel (text first, email only when the text fails). On: a confirmation that would go by text alone goes by text
// AND email when the customer has no completed visit and a member_since unset or within 90 days (see the gate doc line at the top of this file). Kill: unset.
function newClientConfirmEmailLive() {
  return process.env.GATE_NEW_CLIENT_CONFIRM_EMAIL === 'true';
}
// GATE_NEW_CLIENT_CONFIRM_EMAIL reader, on its own line so gate PRs never conflict.
module.exports.newClientConfirmEmailLive = newClientConfirmEmailLive;

// GATE_MOVE_NOTICE_EMAIL read at CALL time, strict `=== 'true'` (customer email), dark by default in every environment. The one reader
// for the move-notice email: services/appointment-reminders.js deliverMoveNoticeEmail and bouncedNoticeKind. Off: a reschedule or
// cancellation text that reached nobody sends nothing else (today). On: the same notice goes by email. Kill: unset.
function moveNoticeEmailLive() {
  return process.env.GATE_MOVE_NOTICE_EMAIL === 'true';
}
// GATE_MOVE_NOTICE_EMAIL reader, on its own line so gate PRs never conflict.
module.exports.moveNoticeEmailLive = moveNoticeEmailLive;

// GATE_REPORT_SHARED_TEMPLATE read at CALL time, strict `=== 'true'` (customer-facing layout), dark in every
// environment. The one reader for the shared customer report template: the payload key `reportTemplate`
// (service-report/report-template.js) is added to live web views only while it is live. Off = the payload
// and the page are byte-identical to before.
function reportSharedTemplateLive() {
  return process.env.GATE_REPORT_SHARED_TEMPLATE === 'true';
}
// GATE_REPORT_SHARED_TEMPLATE reader, on its own line so gate PRs never conflict.
module.exports.reportSharedTemplateLive = reportSharedTemplateLive;

// GATE_IB_TARGET_RULES_V2 read at CALL time, strict `=== 'true'`, dark in every environment. The one reader for the
// Intelligence Bar target rules (owner rulings 2026-10-12 decision 3 and 2026-10-20): a card for an unnamed, off-screen
// customer in owner-direct mode, a 25-row same-name lookup with rows the model can offer as buttons, and 5 direct edits
// per tool per request. Off = today's behavior, byte for byte.
function ibTargetRulesV2Live() {
  return process.env.GATE_IB_TARGET_RULES_V2 === 'true';
}
// GATE_IB_TARGET_RULES_V2 reader, on its own line so gate PRs never conflict.
module.exports.ibTargetRulesV2Live = ibTargetRulesV2Live;

// GATE_NAME_MATCH_V2 read at CALL time, strict `=== 'true'`, dark in every environment.
// On, the Intelligence Bar's dictated-name search (query_customers) ranks with the v2 matcher: Double Metaphone and
// sound-alike tolerances, run-together words ("Mac Donald"), possessives, up to 8 results, a ranking bonus for the
// customer on screen, with a visit today or tomorrow, or contacted in the last 7 days, and sound-alike alternatives
// beside a single exact hit. Read only; it sends nothing. Off = today's behavior, byte for byte.
function nameMatchV2Live() {
  return process.env.GATE_NAME_MATCH_V2 === 'true';
}
// GATE_NAME_MATCH_V2 reader, on its own line so gate PRs never conflict.
module.exports.nameMatchV2Live = nameMatchV2Live;

// GATE_CUSTOMER_SEARCH_FUZZY read at CALL time, strict `=== 'true'`, dark in every environment.
// On, the admin customer pickers (GET /admin/customers?search=, GET /admin/schedule/list?search=) add up to 8
// sound-alike / close-spelling rows after the exact rows when the exact search finds fewer than 3 and the search
// looks like a name ("Orlan damp" finds "Orlan Stompf"). The rows carry `approximate: true`. Read only; it sends
// nothing. Off = today's behavior, byte for byte.
function customerSearchFuzzyLive() {
  return process.env.GATE_CUSTOMER_SEARCH_FUZZY === 'true';
}
// GATE_CUSTOMER_SEARCH_FUZZY reader, on its own line so gate PRs never conflict.
module.exports.customerSearchFuzzyLive = customerSearchFuzzyLive;
// GATE_DICTATION_CUSTOMER_NAMES read at CALL time, strict `=== 'true'`, dark in every environment. The one reader
// for the customer-name section of the staff dictation word list (services/dictation-word-list.js) and the
// surname keyword hints (routes/tech-dictation.js). Off = today's word list byte for byte.
function dictationCustomerNamesLive() {
  return process.env.GATE_DICTATION_CUSTOMER_NAMES === 'true';
}
// GATE_DICTATION_CUSTOMER_NAMES reader, on its own line so gate PRs never conflict.
module.exports.dictationCustomerNamesLive = dictationCustomerNamesLive;

// GATE_DICTATION_MONEY_NORMALIZE read at CALL time, strict `=== 'true'`, dark in every environment. The one reader
// for the dictated-amount rewrite in routes/tech-dictation.js and the Intelligence Bar's ambiguous-amount note
// (routes/admin-intelligence-bar.js). Off = the transcript and the system prompt are exactly as before.
function dictationMoneyNormalizeLive() {
  return process.env.GATE_DICTATION_MONEY_NORMALIZE === 'true';
}
// GATE_DICTATION_MONEY_NORMALIZE reader, on its own line so gate PRs never conflict.
module.exports.dictationMoneyNormalizeLive = dictationMoneyNormalizeLive;
// GATE_REVIEW_ASK_AFTER_REPORT reader, on its own line so gate PRs never conflict.
module.exports.reviewAskAfterReportLive = reviewAskAfterReportLive;

// GATE_BID_DESK read at CALL time — strict `=== 'true'`, dark by default in every environment. The one reader for the
// Bid Desk: services/bid-desk (intake job, reminders, backfill), routes/admin-bid-desk.js and the `bid_desk` flag on
// GET /api/admin/feature-flags that shows the nav entry. Off: the job returns before any query, the routes answer 404
// and the nav entry is hidden. It never contacts a buyer, a contractor or a customer. Kill: unset.
function bidDeskLive() {
  return process.env.GATE_BID_DESK === 'true';
}
// GATE_BID_DESK reader, on its own line so gate PRs never conflict.
module.exports.bidDeskLive = bidDeskLive;
// GATE_BID_DESK_SAM read at CALL time, strict `=== 'true'`, dark by default. It also needs the Bid Desk itself on.
function bidDeskSamLive() {
  return bidDeskLive() && process.env.GATE_BID_DESK_SAM === 'true';
}
// GATE_BID_CHECKLIST read at CALL time, strict `=== 'true'`, dark by default. It also needs the Bid Desk itself on.
// Off: the new bid fields and the checklist routes are refused, the page hides them, and no new reminder (14-day, questions,
// job walk) fires; the Bid Desk behaves exactly as before. Admin bell only. Kill: unset.
function bidChecklistLive() {
  return bidDeskLive() && process.env.GATE_BID_CHECKLIST === 'true';
}
// GATE_BID_DESK_AUTO_DATES read at CALL time, strict `=== 'true'`, dark by default. It also needs the Bid Desk itself on.
// Off: every bid is filed with an unconfirmed date and nothing closes itself, exactly as before. On: a template or SAM.gov
// date counts as confirmed when the bid is first filed, and a bid still marked new closes as no bid one day after its
// due date (30 days when the date is flagged for confirmation). A bid marked bid never closes by itself.
// Admin bell only (no new bell); nothing goes to a buyer, contractor, agency or customer. Kill: unset.
function bidDeskAutoDatesLive() {
  return bidDeskLive() && process.env.GATE_BID_DESK_AUTO_DATES === 'true';
}
// GATE_BID_DESK_CHARLOTTE_DATES read at CALL time, strict `=== 'true'`, dark by default. It also needs the Bid Desk itself on.
// Off: no call to the county's bid list and no date is filled, exactly as before. On: an open Charlotte County bid with no due
// date gets it from the county's public list (services/bid-desk/charlotte-county.js). Nothing is sent to anyone. Kill: unset.
function bidDeskCharlotteDatesLive() {
  return bidDeskLive() && process.env.GATE_BID_DESK_CHARLOTTE_DATES === 'true';
}
// GATE_BID_DESK_NOT_OUR_WORK read at CALL time, strict `=== 'true'`, dark by default. It also needs the Bid Desk itself on.
// Off: every new bid is filed as new with its bell, exactly as before. On: a new bid whose title names grounds upkeep and none
// of our work is filed as no bid with a note and no bell (rules.js notOurWork). Nothing is sent to anyone. Kill: unset.
function bidDeskNotOurWorkLive() {
  return bidDeskLive() && process.env.GATE_BID_DESK_NOT_OUR_WORK === 'true';
}

// GATE_CALL_APPLICANT_HANDLING read at CALL time, strict `=== 'true'`, dark by default.
// Off: a job-applicant or vendor call is processed exactly as before. On: it keeps the vendor_logged label, raises no
// customer-only review card, stores office promises as kind other, and (job applicant) files one Careers row.
// Nothing is sent to the applicant. Kill: unset.
function callApplicantHandlingLive() {
  return process.env.GATE_CALL_APPLICANT_HANDLING === 'true';
}

// GATE_CALL_EMAIL_CHECKS read at CALL time, strict `=== 'true'`, dark by default (owner 2026-10-29).
// Off: call-captured emails are checked exactly as before. On: server/services/call-email-checks.js
// (domain check), contact-dictation.js (decoder fallback), email-bounce-recovery.js and
// webhooks-sendgrid.js (no-mail-server bounces) and admin-triage.js (typed correction on any
// email card). Kill: unset.
function callEmailChecksLive() {
  return process.env.GATE_CALL_EMAIL_CHECKS === 'true';
}

// GATE_BID_DESK_SAM reader, on its own line so gate PRs never conflict.
module.exports.bidDeskSamLive = bidDeskSamLive;
// GATE_BID_CHECKLIST reader, on its own line so gate PRs never conflict.
module.exports.bidChecklistLive = bidChecklistLive;
// GATE_BID_DESK_AUTO_DATES reader, on its own line so gate PRs never conflict.
module.exports.bidDeskAutoDatesLive = bidDeskAutoDatesLive;
// GATE_BID_DESK_CHARLOTTE_DATES reader, on its own line so gate PRs never conflict.
module.exports.bidDeskCharlotteDatesLive = bidDeskCharlotteDatesLive;
// GATE_BID_DESK_NOT_OUR_WORK reader, on its own line so gate PRs never conflict.
module.exports.bidDeskNotOurWorkLive = bidDeskNotOurWorkLive;
// GATE_CALL_LEAD_LAZY_STRIPE read at CALL time, strict `=== 'true'`, dark in every environment.
// services/call-recording-processor.js: a customer created from a call no longer gets a Stripe profile at once
// (every card-save and payment path creates it on demand), so a lead that never pays leaves no empty profile to
// block a later duplicate merge. Sends nothing. Off = today's behavior, byte for byte.
function callLeadLazyStripeLive() {
  return process.env.GATE_CALL_LEAD_LAZY_STRIPE === 'true';
}
// GATE_SATELLITE_PALM_COUNT_TYPED read at CALL time — strict `=== 'true'`, dark by
// default (owner 2026-10-24, follow-up B to #6562). The canonical reader for the
// send gate in routes/admin-estimates.js (assertEstimateSendable + send-preview):
// a satellite palm count stays a suggestion until an admin types the real count
// before the first send. Off = the AI-review acknowledgment alone, as before.
function satellitePalmCountTypedLive() {
  return process.env.GATE_SATELLITE_PALM_COUNT_TYPED === 'true';
}
// GATE_CALL_PREPAY_CHOICE read at CALL time, strict `=== 'true'`, dark in every environment. The owner flips it (it leads to a draft
// annual prepay invoice). Off = byte-identical: no billing_choice on any payload or held row, no card, the accept route answers 404.
function callPrepayChoiceLive() {
  return process.env.GATE_CALL_PREPAY_CHOICE === 'true';
}
// GATE_CALL_CANCEL_GUARD read at CALL time, strict `=== 'true'`, dark in every environment. Off = byte-identical: the
// cancel-notice route answers {enabled:false}, so New Appointment renders as before.
function callCancelGuardLive() {
  return process.env.GATE_CALL_CANCEL_GUARD === 'true';
}
// GATE_AI_CHANGE_CHECK read at CALL time, strict `=== 'true'`, dark in every environment. Off = checkAiChange is a no-op and the impact
// digest has no lost-citations leg. Read-only over stored seo_llm_mentions; no probes, no customer message.
function aiChangeCheckLive() {
  return process.env.GATE_AI_CHANGE_CHECK === 'true';
}

// GATE_SAME_QUESTION_CHECK read at CALL time, strict `=== 'true'`, dark in every environment. Off, the same-question rule only records a shadow result;
// on, it blocks the new post and queues the owner-page rewrite. Also the consumption switch for same_question_refresh rows.
function sameQuestionCheckLive() {
  return process.env.GATE_SAME_QUESTION_CHECK === 'true';
}

// GATE_PORTAL_INBOX read at CALL time, strict `=== 'true'`, dark in every environment.
// Off, the Portal tab in Communications is hidden and the portal-inbox routes answer enabled:false / 404.
function portalInboxLive() {
  return process.env.GATE_PORTAL_INBOX === 'true';
}
// GATE_MESSENGER_INBOX read at CALL time, strict `=== 'true'`, dark in every environment.
// Off, the Messenger poller does nothing and the Messenger tab and routes answer enabled:false / 404.
function messengerInboxLive() {
  return process.env.GATE_MESSENGER_INBOX === 'true';
}
// GATE_ROUTE_ENGINE_SUMMARY read at CALL time, strict `=== 'true'`, dark in every environment. Off = the route scorecard payload has no
// engine key. Read-only over the auto-dispatch run and audit tables; sends nothing.
function routeEngineSummaryLive() {
  return process.env.GATE_ROUTE_ENGINE_SUMMARY === 'true';
}
// GATE_INSPECTION_REUSE_LEAD_SHELL read at CALL time, strict `=== 'true'`, dark in every environment. Off = the consultation page
// creates a new prospect customer for an unverified (web-form) lead, exactly as before. On = it first looks for the lead's own
// untouched intake shell (inspection-public.js#leadOwnIntakeShell) and books onto that row. Kill switch = unset the variable.
function inspectionReuseLeadShellLive() {
  return process.env.GATE_INSPECTION_REUSE_LEAD_SHELL === 'true';
}
// GATE_QUOTE_SAME_PERSON_MATCH read at CALL time, strict `=== 'true'`, dark in every environment. Off = a typed phone that matches
// 2 or more customer rows adds a new customers row on every quote wizard run, as before.
function quoteSamePersonMatchLive() {
  return process.env.GATE_QUOTE_SAME_PERSON_MATCH === 'true';
}
// GATE_BUG_ID_EXTENSION read at CALL time, strict `=== 'true'`, dark in every environment (paid vision for anonymous
// worldwide callers). Off = every /api/public/bug-id-extension request answers the generic 404. Kill switch = unset.
function bugIdExtensionLive() {
  return process.env.GATE_BUG_ID_EXTENSION === 'true';
}
// GATE_STAFF_EDIT_LOCK_START_ONLY read at CALL time, strict `=== 'true'`, dark. On, a staff edit that changes only a
// plan visit's window END (same date, same start) does not set auto_dispatch_locked. Off = any window change locks. Kill = unset.
function staffEditLockStartOnlyLive() {
  return process.env.GATE_STAFF_EDIT_LOCK_START_ONLY === 'true';
}
// GATE_CALL_LEAD_LAZY_STRIPE reader, on its own line so gate PRs never conflict.
module.exports.callLeadLazyStripeLive = callLeadLazyStripeLive;
// GATE_EMAIL_AUTH_STRICT reader, on its own line so gate PRs never conflict.
module.exports.emailAuthStrictLive = emailAuthStrictLive;
// GATE_DEDUPE_NO_UNVERIFIED_BACKFILL reader, on its own line so gate PRs never conflict.
module.exports.dedupeNoUnverifiedBackfillLive = dedupeNoUnverifiedBackfillLive;
// GATE_BUG_ID_EXTENSION reader, on its own line so gate PRs never conflict.
module.exports.bugIdExtensionLive = bugIdExtensionLive;
// Retired gate names, for the admin gate list (services/gate-list.js), on its own line.
module.exports.RETIRED_GATES = RETIRED;
// GATE_CALL_ENRICH_CODES_REQUIRE_ANI reader, on its own line so gate PRs never conflict.
module.exports.callEnrichCodesRequireAniLive = callEnrichCodesRequireAniLive;
module.exports.backlinkSignupUrlGuardLive = backlinkSignupUrlGuardLive;
module.exports.newsletterClickBoundLive = newsletterClickBoundLive;
// GATE_NEWSLETTER_AUTO_SEND reader, on its own line so gate PRs never conflict.
module.exports.newsletterAutoSendLive = newsletterAutoSendLive;
// GATE_BILL_TO_NO_VISIT_INVOICES reader, on its own line so gate PRs never conflict.
module.exports.billToNoVisitInvoicesLive = billToNoVisitInvoicesLive;
// GATE_QUIET_OVERDUE_LIST reader, on its own line so gate PRs never conflict.
module.exports.quietOverdueListLive = quietOverdueListLive;
// GATE_UNBILLED_VISITS_LIST reader, on its own line so gate PRs never conflict.
module.exports.unbilledVisitsListLive = unbilledVisitsListLive;
// GATE_ESTIMATE_LAWN_LIMITS reader, on its own line so gate PRs never conflict.
module.exports.estimateLawnLimitsLive = estimateLawnLimitsLive;
// GATE_LAWN_RECLAIMED_HALF_N reader, on its own line so gate PRs never conflict.
module.exports.lawnReclaimedHalfNLive = lawnReclaimedHalfNLive;
// GATE_MOSQUITO_MISTING reader, on its own line so gate PRs never conflict.
module.exports.mosquitoMistingLive = mosquitoMistingLive;
// GATE_DEAD_ANIMAL_REMOVAL reader, on its own line so gate PRs never conflict.
module.exports.deadAnimalRemovalLive = deadAnimalRemovalLive;
// GATE_BID_KIT reader, on its own line so gate PRs never conflict.
module.exports.bidKitLive = bidKitLive;
// GATE_BID_KIT_PRODUCT_LIST_SYNC reader, on its own line so gate PRs never conflict.
module.exports.bidKitProductListSyncLive = bidKitProductListSyncLive;
// GATE_PRODUCT_INTAKE_GUARD reader, on its own line so gate PRs never conflict.
module.exports.productIntakeGuardLive = productIntakeGuardLive;
// GATE_REVIEW_FIRST_ASK_LOCK reader, on its own line so gate PRs never conflict.
module.exports.reviewFirstAskLockLive = reviewFirstAskLockLive;
module.exports.annualPlanDocumentsLive = annualPlanDocumentsLive;
// GATE_COMMERCIAL_PROPOSAL_SIGN reader, on its own line so gate PRs never conflict.
module.exports.commercialProposalSignLive = commercialProposalSignLive;
module.exports.commercialAutopayLive = commercialAutopayLive;
// GATE_COMMERCIAL_FIRST_VISIT reader, on its own line so gate PRs never conflict.
module.exports.commercialFirstVisitLive = commercialFirstVisitLive;
// GATE_ESTIMATE_ASSESSMENT_FIRST reader, on its own line so gate PRs never conflict.
module.exports.estimateAssessmentFirstLive = estimateAssessmentFirstLive;
// GATE_TAX_SHARED_BILLS reader, on its own line so gate PRs never conflict.
module.exports.taxSharedBillsLive = taxSharedBillsLive;
// GATE_TAX_RETURN_ENGINE reader, on its own line so gate PRs never conflict.
module.exports.taxReturnEngineLive = taxReturnEngineLive;
// GATE_SLAB_HOME_NO_TAX reader, on its own line so gate PRs never conflict.
module.exports.slabHomeNoTaxLive = slabHomeNoTaxLive;
// GATE_LAWN_SPRAY_NO_TAX reader, on its own line so gate PRs never conflict.
module.exports.lawnSprayNoTaxLive = lawnSprayNoTaxLive;
// GATE_TAX_WORKSHEETS reader, on its own line so gate PRs never conflict.
module.exports.taxWorksheetsLive = taxWorksheetsLive;
// GATE_PUBLIC_LLM_SHARED_CAP reader, on its own line so gate PRs never conflict.
module.exports.publicLlmSharedCapLive = publicLlmSharedCapLive;
// GATE_SMS_FOLLOWUP_WITNESS_FIX reader, on its own line so gate PRs never conflict.
module.exports.smsFollowupWitnessFixLive = smsFollowupWitnessFixLive;
// GATE_SETUP_FEE_SETTLED_ANYWHERE reader, on its own line so gate PRs never conflict.
module.exports.setupFeeSettledAnywhereLive = setupFeeSettledAnywhereLive;
// GATE_CALL_PROMISE_AI_CLOSE reader, on its own line so gate PRs never conflict.
module.exports.callPromiseAiCloseLive = callPromiseAiCloseLive;
// GATE_CALL_PROMISE_LATER_TEXT_CHECK reader, on its own line so gate PRs never conflict.
module.exports.callPromiseLaterTextCheckLive = callPromiseLaterTextCheckLive;
// GATE_SATELLITE_PALM_COUNT_TYPED reader, on its own line so gate PRs never conflict.
module.exports.satellitePalmCountTypedLive = satellitePalmCountTypedLive;
// GATE_CALL_ADDRESS_FAMILY_CARD reader, on its own line so gate PRs never conflict.
module.exports.callAddressFamilyCardLive = callAddressFamilyCardLive;
// GATE_ACCESS_CODES_FOUND_BELL reader, on its own line so gate PRs never conflict.
module.exports.accessCodesFoundBellLive = accessCodesFoundBellLive;
// GATE_PLAN_RATE_LEDGER_RECONCILE reader, on its own line so gate PRs never conflict.
module.exports.planRateLedgerReconcileLive = planRateLedgerReconcileLive;
// GATE_LEAD_DRAFT_PROPERTY_LOOKUP reader, on its own line so gate PRs never conflict.
module.exports.leadDraftPropertyLookupLive = leadDraftPropertyLookupLive;
// GATE_ESTIMATE_CONSUMER_NOTICE reader, on its own line so gate PRs never conflict.
module.exports.estimateConsumerNoticeLive = estimateConsumerNoticeLive;
// GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_SEND reader, on its own line so gate PRs never conflict.
module.exports.manualAcceptConsumerNoticeSendLive = manualAcceptConsumerNoticeSendLive;
// GATE_ESTIMATE_SERVICE_AGREEMENT reader, on its own line so gate PRs never conflict.
module.exports.estimateServiceAgreementLive = estimateServiceAgreementLive;
// GATE_AGREEMENT_RENEWAL_REMINDER reader, on its own line so gate PRs never conflict.
module.exports.agreementRenewalReminderLive = agreementRenewalReminderLive;
// GATE_PREPAY_YEAR_END_BELL reader, on its own line so gate PRs never conflict.
module.exports.prepayYearEndBellLive = prepayYearEndBellLive;
// GATE_SHIFT_CLOSE_REVIEW reader, on its own line so gate PRs never conflict.
module.exports.shiftCloseReviewLive = shiftCloseReviewLive;
// GATE_TECH_LOGIN_PRIVACY reader, on its own line so gate PRs never conflict.
module.exports.techLoginPrivacyLive = techLoginPrivacyLive;
// GATE_ESTIMATE_SLOT_ONE_PER_HOUR reader, on its own line so gate PRs never conflict.
module.exports.estimateSlotOnePerHourLive = estimateSlotOnePerHourLive;
// GATE_TECH_STAFF_GUARDS reader, on its own line so gate PRs never conflict.
module.exports.techStaffGuardsLive = techStaffGuardsLive;
// GATE_TAX_PACKAGE_W2_LABOR reader, on its own line so gate PRs never conflict.
module.exports.taxPackageW2LaborLive = taxPackageW2LaborLive;
// GATE_PNL_PAY_RUN_WAGES reader, on its own line so gate PRs never conflict.
module.exports.pnlPayRunWagesLive = pnlPayRunWagesLive;
// GATE_PAYROLL_BANK_MATCH reader, on its own line so gate PRs never conflict.
module.exports.payrollBankMatchLive = payrollBankMatchLive;
// GATE_MISTING_LAYOUT_DESIGNER reader, on its own line so gate PRs never conflict.
module.exports.mistingLayoutDesignerLive = mistingLayoutDesignerLive;
// GATE_REVIEW_BONUS_ASK_FIRST reader, on its own line so gate PRs never conflict.
module.exports.reviewBonusAskFirstLive = reviewBonusAskFirstLive;
// GATE_CALLBACK_SOURCE_TECH reader, on its own line so gate PRs never conflict.
module.exports.callbackSourceTechLive = callbackSourceTechLive;
// GATE_CUSTOMER_TEXT_TO_VISIT_TECH reader, on its own line so gate PRs never conflict.
module.exports.customerTextToVisitTechLive = customerTextToVisitTechLive;
// Own line so concurrent gate PRs appending to the shared list never conflict with this one.
module.exports.smsPromptAutopromoteMode = smsPromptAutopromoteMode;
// GATE_SITEONE_EMAIL_ORDER reader, on its own line so gate PRs never conflict.
module.exports.siteOneEmailOrderLive = siteOneEmailOrderLive;
// GATE_AUTOPAY_HOLD_TIMEOUT reader, on its own line so gate PRs never conflict.
module.exports.autopayHoldTimeoutMode = autopayHoldTimeoutMode;
// GATE_TECH_COST_RATES reader, on its own line so gate PRs never conflict.
module.exports.techCostRatesLive = techCostRatesLive;
// GATE_JOB_COST_STANDARD_MINUTES reader, on its own line so gate PRs never conflict.
module.exports.jobCostStandardMinutesLive = jobCostStandardMinutesLive;
// GATE_TECH_OPEN_TIME reader, on its own line so gate PRs never conflict.
module.exports.techOpenTimeLive = techOpenTimeLive;
// GATE_TECH_PAY_STUBS reader, on its own line so gate PRs never conflict.
module.exports.techPayStubsLive = techPayStubsLive;
// GATE_TECH_TRAINING_DATES reader, on its own line so gate PRs never conflict.
module.exports.techTrainingDatesLive = techTrainingDatesLive;
// GATE_MANUAL_ACCEPT_CONSUMER_NOTICE_RECONCILE reader, on its own line so gate PRs never conflict.
module.exports.manualAcceptConsumerNoticeReconcileLive = manualAcceptConsumerNoticeReconcileLive;
// GATE_SETUP_FEE_APPLICATION_SETTLED reader, on its own line so gate PRs never conflict.
module.exports.setupFeeApplicationSettledLive = setupFeeApplicationSettledLive;
// GATE_SETUP_FEE_OPEN_INVOICE_NOTICE reader, on its own line so gate PRs never conflict.
module.exports.setupFeeOpenInvoiceNoticeLive = setupFeeOpenInvoiceNoticeLive;
// GATE_BUILDING_USE_TAX reader, on its own line so gate PRs never conflict.
module.exports.buildingUseTaxLive = buildingUseTaxLive;
// GATE_SMS_STAFF_ACTION_ANSWERS reader, on its own line so gate PRs never conflict.
module.exports.staffActionAnswersMode = staffActionAnswersMode;
// GATE_PROMISE_RECORD_EVIDENCE reader, on its own line so gate PRs never conflict.
module.exports.promiseRecordEvidenceMode = promiseRecordEvidenceMode;
// GATE_STOCK_COUNT_AWARE_USAGE reader, on its own line so gate PRs never conflict.
module.exports.stockCountAwareUsageLive = stockCountAwareUsageLive;
// GATE_TAX_SERVICE_COUNTY reader, on its own line so gate PRs never conflict.
module.exports.taxServiceCountyLive = taxServiceCountyLive;
// GATE_SLAB_BUSINESS_SITE_TAX reader, on its own line so gate PRs never conflict.
module.exports.slabBusinessSiteTaxLive = slabBusinessSiteTaxLive;
// GATE_LAWN_9X_ROUNDS reader, on its own line so gate PRs never conflict.
module.exports.lawn9xRoundsLive = lawn9xRoundsLive;
// GATE_CALL_APPLICANT_HANDLING reader, on its own line so gate PRs never conflict.
module.exports.callApplicantHandlingLive = callApplicantHandlingLive;
// GATE_CALL_EMAIL_CHECKS reader, on its own line so gate PRs never conflict.
module.exports.callEmailChecksLive = callEmailChecksLive;
// GATE_CALL_PREPAY_CHOICE reader, on its own line so gate PRs never conflict.
module.exports.callPrepayChoiceLive = callPrepayChoiceLive;
// GATE_CALL_CANCEL_GUARD reader, on its own line so gate PRs never conflict.
module.exports.callCancelGuardLive = callCancelGuardLive;
// GATE_AI_CHANGE_CHECK reader, on its own line so gate PRs never conflict.
module.exports.aiChangeCheckLive = aiChangeCheckLive;
// GATE_SAME_QUESTION_CHECK reader, on its own line so gate PRs never conflict.
module.exports.sameQuestionCheckLive = sameQuestionCheckLive;
// GATE_PORTAL_INBOX reader, on its own line so gate PRs never conflict.
module.exports.portalInboxLive = portalInboxLive;
// GATE_MESSENGER_INBOX reader, on its own line so gate PRs never conflict.
module.exports.messengerInboxLive = messengerInboxLive;
// GATE_ROUTE_ENGINE_SUMMARY reader, on its own line so gate PRs never conflict.
module.exports.routeEngineSummaryLive = routeEngineSummaryLive;
// GATE_INSPECTION_REUSE_LEAD_SHELL reader, on its own line so gate PRs never conflict.
module.exports.inspectionReuseLeadShellLive = inspectionReuseLeadShellLive;
// GATE_QUOTE_SAME_PERSON_MATCH reader, on its own line so gate PRs never conflict.
module.exports.quoteSamePersonMatchLive = quoteSamePersonMatchLive;
// GATE_ROUTE_ORDER_TIME_FALLBACK reader, on its own line so gate PRs never conflict.
module.exports.routeOrderTimeFallbackLive = routeOrderTimeFallbackLive;
// GATE_STAFF_EDIT_LOCK_START_ONLY reader, on its own line so gate PRs never conflict.
module.exports.staffEditLockStartOnlyLive = staffEditLockStartOnlyLive;
