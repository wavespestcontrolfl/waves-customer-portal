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
 *   GATE_SHADOW_JUDGE=true      (nightly shadow-draft vs human-reply scoring)
 *   GATE_SMS_AUTO_SEND=true     (autonomously send verified house-voice drafts for graduated intents)
 *   GATE_AI_BLOG_WRITER=true    (enable AI blog content generation)
 *   GATE_CRON_JOBS=true         (enable all automated cron jobs)
 *   GATE_WEBHOOKS=true          (enable inbound webhook processing)
 *   GATE_EMAIL_TEMPLATE_AUTOMATIONS=true (enable template automation sends)
 *   GATE_LEAD_ESTIMATE_AUTOMATION=true    (generate priced lead draft estimates)
 *   GATE_LEAD_ESTIMATE_AUTO_SEND=true    (auto-send generated lead estimates)
 *   GATE_LEAD_TURNSTILE=true    (enforce Cloudflare Turnstile on the public lead webhook)
 *   GATE_AUTOPAY_CUSTOMER_SMS=true       (enable customer-facing autopay SMS)
 *   GATE_ESTIMATE_DEPOSIT_ABANDONMENT_SMS=true (deposit-step abandonment recovery SMS)
 *   GATE_INCIDENT_EVAL=true     (weekly live-LLM incident regression eval)
 *   GATE_CALL_REPLAY_EVAL=true  (weekly reviewed-call extraction replay eval)
 *   GATE_ADS_BUDGET_LIVE_PUSH=true (capacity cron pushes budget changes to Google Ads)
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
  // processReviewSequences cron advances operator-started Day 0/3/7 SMS+email
  // sequences. Customer-facing auto-send → explicit opt-in in EVERY env (off in
  // dev/preview too) so a preview env with real Twilio/SendGrid creds can't
  // text/email real customers. Still subject to twilioSms + per-customer pref.
  // One-off manual sends from the same tab are NOT gated by this.
  reviewSequences: process.env.GATE_REVIEW_SEQUENCES === 'true',

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

  // Shadow Backfill (brand-voice loop accelerator) — drafts house-voice
  // replies for HISTORICAL inbound SMS that already have a human reply and
  // feeds them to the existing judge, compressing months of per-intent
  // score accumulation into days. Hourly batches, self-terminating once
  // history is exhausted. Burns ~2 Anthropic calls per sample, so prod
  // requires explicit opt-in; flip off (or leave — it no-ops) when done.
  shadowBackfill: isProd ? process.env.GATE_SHADOW_BACKFILL === 'true' : true,

  // AI Blog Writer — generates content via Anthropic API
  aiBlogWriter: isProd ? process.env.GATE_AI_BLOG_WRITER === 'true' : true,

  // Cron Jobs — automated scheduled tasks (reminders, billing, intelligence)
  cronJobs: isProd ? process.env.GATE_CRON_JOBS === 'true' : true,

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

  // Backlink Agent — Playwright browser automation for profile signups
  backlinkAgent: isProd ? process.env.GATE_BACKLINK_AGENT === 'true' : true,

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

  // Estimate Deposit-Abandonment SMS — texts customers who started the
  // deposit payment step on a public estimate (a pending Stripe
  // PaymentIntent in estimate_deposits) but never completed it. Customer-
  // facing auto-send: explicit opt-in in EVERY environment. Until the gate
  // is on, the follow-up cron only logs candidate counts (shadow) and never
  // claims or sends.
  estimateDepositAbandonmentSms: process.env.GATE_ESTIMATE_DEPOSIT_ABANDONMENT_SMS === 'true',

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

  // Voicemail lead text-back — when a NEW prospect's voicemail produces a
  // workable lead, text them a prefilled quote-wizard link ("got your message
  // about X — get your quote: …"). A customer-facing auto-send, so it FAILS
  // CLOSED (explicit opt-in in EVERY environment) per the house rule — a
  // preview/dev env with real Twilio creds must NOT auto-text prospects.
  // Owner sets GATE_VOICEMAIL_LEAD_SMS=true on prod to go live. Off → the
  // voicemail still becomes a Needs-Review lead; only the SMS is skipped.
  voicemailLeadSms: process.env.GATE_VOICEMAIL_LEAD_SMS === 'true',

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

  // Email Template Automations — executes trigger-mapped template sends from
  // the email template automation catalog. Off by default in prod until each
  // trigger has been verified with run history and idempotency checks.
  emailTemplateAutomations: isProd ? process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS === 'true' : true,

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

  // aeo_gap opportunity mining — feeds answer-engine (LLM) visibility gaps into
  // the content engine's opportunity_queue. Default OFF in prod: ships dormant
  // so it can be enabled (GATE_AEO_GAP_MINING=true) only after the
  // seo_llm_mentions tracker has several days of data and the opportunities
  // have been eyeballed. When off, the aeo_gap bucket miner returns [].
  aeoGapMining: isProd ? process.env.GATE_AEO_GAP_MINING === 'true' : true,

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

  // Liquid-glass estimate experience (docs/design/estimate-glass-plan.md) —
  // makes glass the DEFAULT render for the React estimate view. Off = the
  // pre-glass page (glass still reachable per-link via ?glass=1); on = glass
  // for every customer (?glass=0 stays as the per-link escape hatch).
  // Kill switch: unset GATE_ESTIMATE_GLASS.
  estimateGlassTheme: isProd ? process.env.GATE_ESTIMATE_GLASS === 'true' : true,

  // Liquid-glass email chrome (glass rollout Phase 3) — switches every
  // email wrapper in services/email-template.js (transactional, service,
  // newsletter) from the warm sand chrome to the glass LAYOUT (orb
  // scene, floating pill header, hero on scene, frosted cards).
  // Explicit opt-in in EVERY environment (unlike estimateGlassTheme's
  // dev-open default): glass is a different DOM, so a dev-open gate
  // would make jest and local [TEST] sends render glass while prod
  // renders classic — the suite must exercise what prod sends.
  // Off = the pre-glass chrome, byte-for-byte. Kill switch: unset
  // GATE_EMAIL_GLASS.
  emailGlassTheme: process.env.GATE_EMAIL_GLASS === 'true',

  // Liquid-glass customer service-report experience — makes glass the DEFAULT
  // render for the React report viewer (live mode only: pdf/static/sms_preview
  // renders never mount the scene, so the print pipeline and cached artifacts
  // stay untouched). Off = the pre-glass page (glass still reachable per-link
  // via ?glass=1); on = glass for every customer (?glass=0 stays as the
  // per-link escape hatch). Kill switch: unset GATE_REPORT_GLASS.
  reportGlassTheme: isProd ? process.env.GATE_REPORT_GLASS === 'true' : true,

  // Liquid-glass portal shell + login page — makes glass the DEFAULT render
  // for the customer portal SPA (and the Capacitor apps, which load the same
  // web bundle). Served to the client via GET /api/public/ui-flags because
  // the shell has no per-page token payload to ride. Off = pre-glass portal
  // (glass still reachable per-link via ?glass=1); on = glass for every
  // customer (?glass=0 stays as the per-link escape hatch).
  // Kill switch: unset GATE_PORTAL_GLASS.
  portalGlassTheme: isProd ? process.env.GATE_PORTAL_GLASS === 'true' : true,

  // Waves AI schedule search on the wavespestcontrol.com /book page (astro
  // island). Exposed to the marketing site via GET /api/booking/config as
  // `ai_search`, so the island fails closed: the search bar only renders when
  // the portal affirms the flag. The portal's own /book page and the estimate
  // page are NOT behind this gate — their bars are already live.
  // Kill switch: unset GATE_BOOK_AI_SEARCH.
  bookAiSearch: isProd ? process.env.GATE_BOOK_AI_SEARCH === 'true' : true,

  // Auto-Dispatch — autonomous daily optimizer for FUTURE recurring visits.
  // Master gate for the cron job (double-gated behind cronJobs). Off by default
  // in prod until the owner validates dry-run output; even when ON it stays in
  // dry_run mode until AUTO_DISPATCH_MODE=apply is set. The admin API + manual
  // run endpoints are unaffected by this gate (they're requireAdmin-only).
  autoDispatch: isProd ? process.env.GATE_AUTO_DISPATCH === 'true' : true,

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
};

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

module.exports = { gates, isEnabled, logGateStatus };
// gates 1775330914
