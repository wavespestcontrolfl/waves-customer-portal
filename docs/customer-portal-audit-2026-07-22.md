# Customer-Facing Portal Audit — 2026-07-22

**Scope:** every surface a paying or prospective customer touches — estimate portal, self-scheduling (`/book`), multi-service booking, Stripe checkout + WaveGuard recurring billing, post-service reports, lawn assessment output, notification-recipient management and SMS opt-in, account/billing self-service. Admin, dispatch, internal tooling, and the agent fleet are out of scope and not reported on.

**Method:** read-only code audit of the repo at `59ab2fd`. Every finding cites `file:line` from code opened during this audit; anything not confirmable in code is in UNVERIFIED. No fixes were applied. Audience lens throughout: SWFL homeowners (Manatee/Sarasota/Charlotte), retirement-age skew, arriving cold on a 390×844 phone from GBP/Ads/spoke-site/SMS links.

**Overall shape:** the estimate → accept → pay → book conversion path and the Stripe money path are unusually well-hardened (idempotent accepts, advisory-locked slot reservation, two-step surcharge disclosure, versioned payment consent snapshots, honest failure states — receipts of ~2 years of prior audit fixes are visible in the code). The weight of what remains sits in three places: **(1) SMS/TCPA consent infrastructure** (no consent records, no quiet-hours floor, no HELP handler, third-party numbers collected without recipient consent), **(2) the `/book` public funnel** (no service choice, no price, no service-area gate), and **(3) portal self-service dead-ends** (no way to pay a balance, membership changes are request-only).

---

## PHASE 1 — ENTRY AND SURFACE

Route table from `client/src/App.jsx:474-647`. "Entry point" = the real-world thing that lands a customer there.

### Public (no token, no auth)

| Route | Component | Entry point |
|---|---|---|
| `/book` | PublicBookingPage (App.jsx:506) | GBP "Book" links, Google Ads (`?gclid=`), marketing-site iframe embed (booking.js:2605 `/embed-snippet`), estimate-accept handoff (`?source=estimate-accept`) |
| `/login` | LoginPage (App.jsx:474) | Portal bookmark, app, `?next=` redirects from protected routes (App.jsx:461-462) |
| `/newsletter/archive/:id` | NewsletterArchivePage (App.jsx:510) | Learn-tab reader, newsletter links |
| `/estimate`, `/quote` | external redirect → marketing quote wizard (App.jsx:507-508) | typed URLs, old links |
| `/newsletter` | external redirect → wavespestcontrol.com (App.jsx:509) | old links |
| `/estimate/<marketing-slug>` | external redirects (App.jsx:493-495) | ad/spoke-site slugs |

### Tokenized links (bearer token in URL; SMS/email is the entry point for all of these)

| Route | Component (App.jsx line) | What mints the link |
|---|---|---|
| `/estimate/:token` | **Server-side fork, not always the SPA:** `server/index.js:507-511` routes this path into `handleEstimateView`, which serves the React EstimateViewPage (App.jsx:496) only when `use_v2_view` is true, invoice-mode/card-hold/recurring-card forces React, or a GrowthBook assignment says so — otherwise the **legacy server-rendered HTML estimate** serves on this same URL (estimate-public.js:7167-7209; a GrowthBook holdback deliberately keeps a v1 control group, 7183-7204) | estimate SMS/email (admin-estimate-persistence.js:36, estimate-follow-up.js:273, etc.) |
| `/pay/:token` | PayPageV2 (485) | invoice SMS/email, accept-success "Pay now" |
| `/pay/statement/:token` | StatementPayPage (484) | statement sends |
| `/receipt/:token` | ReceiptPage (486) | post-payment redirect + receipt sends |
| `/report/:token` | ReportViewPage (482) | post-service report SMS |
| `/report/project/:token` | ProjectReportViewPage (481) | WDO/termite/project reports (also emailed to realtor/title on WDO — reports-public.js:631-639) |
| `/lawn-report/:token` | LawnReportViewPage (502) | lawn diagnostic funnel SMS |
| `/pest-report/:token` | PestReportViewPage (503) | pest identifier funnel SMS |
| `/service-outlines/:token` | ServiceOutlinePage (504) | program-outline sends |
| `/track/:token` | TrackPage (488) | day-of-service tracking SMS |
| `/reschedule/:token` | ReschedulePage (489) | confirmation/reminder SMS reschedule line |
| `/secure/:token` | SecureAppointmentPage (490) | card-on-file capture links (/book step 4, appointment-card-request) |
| `/prep/:token` | PrepGuidePage (491) | pre-visit prep SMS |
| `/price-change/:token` | PriceChangeNoticePage (492) | price-change notices |
| `/contract/:token` | ContractSignPage (487) | agreement/autopay-authorization sends |
| `/rate/:token` | RatePage (477) | post-service review request SMS |
| `/card/:token` | CardPage (480) | digital business card |
| Redirect-only: `/recap/:token` → `/report/:token#visit-recap` (483), `/review/:token` → `/rate/:token` (505), `/book/:estimateToken` → `/estimate/:token` (511) | | legacy links already texted to customers |

### Authenticated

| Route | Component | Entry |
|---|---|---|
| `/*` (catch-all) | PortalPage behind ProtectedRoute (App.jsx:638-647) | app icon / login; tabs: Home, Plan, Visits, Billing, Refer + More (Documents, My Property, Learn) (PortalPage.jsx:12761-12768) |

### Flags

- **Two live estimate renderers on the same customer link.** The texted `/estimate/:token` URL is server-forked (see table above): estimates without `use_v2_view` — and GrowthBook experiment holdbacks — get the legacy server-rendered HTML page, not the React page this audit traced. `GET /api/estimates/:token` additionally serves the legacy HTML unconditionally (estimate-public.js:7411). **This audit's estimate journey (Phase 2A) covers the React renderer only; the legacy SSR renderer was not audited** — see UNVERIFIED and finding S4-9.
- **Self-serve quote API in this repo:** `/api/public/quote` (server/index.js:512, behind a paid-estimator daily limiter) is the no-auth backend of the marketing-site quote wizard — `POST /calculate` (public-quote.js:462) runs the pricing engine, creates/updates lead records, and delivers estimate links, with honeypot + rate-limit + Turnstile-on-step-1 defenses visible at the route head. The wizard UI lives in the astro repo, so the end-to-end journey is not auditable here — see UNVERIFIED.
- **Staff-data leakage:** none found on customer surfaces. Reports strip internal keys and amounts at egress (reports-public.js:539-544, 621, 660); a targeted search of PortalPage for internal-note/margin/cost fields found only CSS `margin` properties; the estimate `/data` endpoint projects a public boundary (estimate-public.js:17063-17110) and the draft-preview bypass requires a verified staff JWT (estimate-public.js:17108-17110).
- **Third-party PII exposure by design:** WDO project reports print the homeowner's name/email/phone/address and the same link is emailed to realtor/title companies — explicit owner ruling 2026-07-16, recorded in code (reports-public.js:631-639). Flagged for awareness, not as a defect.

---

## PHASE 2 — JOURNEY TRACE

### A. Cold visitor → estimate link → service cards → accept → pay → book slot → SMS confirmation

The cold visitor's entry is the texted/emailed `/estimate/:token` link. Estimates reach customers two ways: minted by the office/agents, or self-served through the marketing-site quote wizard — whose UI lives on wavespestcontrol.com but whose backend is this repo's no-auth `POST /api/public/quote/calculate` (server/index.js:512; public-quote.js:462), which prices, creates the lead/estimate records, and delivers the link. The portal-domain `/estimate` path itself only redirects to that wizard (App.jsx:507). The wizard-side journey is not auditable from this repo (see UNVERIFIED).

**Renderer scope:** this trace covers the React `EstimateViewPage` — served when the estimate is v2 (`use_v2_view`), invoice-mode/card-hold/recurring-card forced, or experiment-assigned. Estimates outside that population receive the legacy server-rendered HTML page on the same link (estimate-public.js:7167-7209), which was **not** audited (see UNVERIFIED, finding S4-9).

**Screens/states (EstimateViewPage.jsx):**
1. **Loading** — skeleton hero + cards (4738-4748). **Load error** — `PublicLoadError` with Try again (4749-4759). **Invalid/expired** — `NotFoundCard` with phone + self-serve 7-day extension when server confirms the token was a real expired estimate (579-708; server gate estimate-public.js:17086-17092). Extension success re-fetches and revives the page in place (4760-4782). *No dead end.*
2. **Configure** — hero with name/contact/estimate#/expiry (729-812), service cards (Pest Protection / Mosquito Defense / Termite Defense headlines, 3092-3101) with per-application pricing (PriceCard.jsx:200-216), frequency pills, termite bond selector (3492-3511), one-time toggle when offered (5419-5442), WaveGuard membership card for existing customers (1041-1150), Waves-AI property panel, Ask-Waves bar, reviews/GBP proof, slot picker.
3. **Slot picker** (SlotPicker.jsx) — 3 slots + "Show N more" (113-115, 576-604), AI date search + 90-day picker, per-minute staleness re-check (151-156). **Empty:** "No open slots in the next 14 days — try searching a specific date above, or call us" (501-510). **Fetch error:** call fallback (442-450). *No dead end.*
4. **Payment preference** (PaymentPreferenceButtons.jsx) — "Pay per application" with itemized setup + first-application invoice preview and "No payment is charged on this page" (264-314); "Pay the 12-month plan in full" when eligible (318-334); invoice-mode / one-time / card-hold / held-commercial variants with mode-correct copy (185-246).
5. **Reserve** — POST `/reserve` creates a 15-min hold (estimate-slots-public.js:394-485). **409 slot taken** → `slot_conflict` banner + refreshed slots (EstimateViewPage.jsx:4160-4177, 2965-2989). **Hold expiry** → countdown hits 0 → `reservation_expired` banner + re-pick (3966-3988). *Both recoverable.*
6. **Review** — confirm card with pay option, slot, countdown, deposit/Auto-Pay disclosures (2670-2774, 5316-5382); "Go back" preserved slot (4589-4602). Deposit modal ($49/$99, Payment Element, express wallets, two-step surcharge disclosure, 2175-2428), card-hold modal (2435-2541), Auto-Pay modal with verbatim consent checkbox (2549-2668) — each has "Not now" and Esc.
7. **Accept** — PUT `/accept`; 402 lanes re-open the right modal (4265-4294); 409s re-derive state and reload (4295-4325); errors return to review with banner + phone (2951-2963). **Success** — "You're booked!" with date/time + app badges (2883-2923); invoice-mode variants with pay link (2789-2826).
8. **SMS confirmation** — sent server-side post-commit via the consent-checked wrapper, honoring the customer's confirmation-channel pref, with a reschedule link; template-gated with a logged warn if the template is disabled (estimate-public.js:9599-9641).

**Happy path:** link → configure → tap slot → tap pay option → Confirm booking → success + SMS. **Dead ends: none found on this flow.** Terminal states (accepted/declined/expired/quote-required) each render a purpose-built card, and the accepted state keeps a read-only recap (5098-5181).

### B. Multi-service selection in one booking

- **On the estimate** — fully supported: multi-service estimates render per-service sections with independent cadence combos where the server provides them (3770-3807), mirrored non-axis sections locked so the customer can't pick a cadence accept would ignore (4874-4880), plan-wide credit itemization (PlanTotalSummary, 1998-2122), and one accept books the whole plan. Add-a-service upsell files a bundle inquiry (412-495, 4703-4736).
- **On `/book`** — impossible. One `service` per booking, fixed by URL param, and **no service picker exists in the UI** (finding S3-1).

### C. Returning customer → post-service report / lawn assessment

- SMS `/report/:token` → glass report: status card, recap video (self-hides while unapproved — finding S3-12), products applied, coverage map, photos, V2 lawn/pest dashboards, review ask, Ask-Waves. 404/410 → "Report unavailable" + Call Waves (no visible digits — finding S3-11). Non-404 errors → retryable `PublicLoadError` (ReportViewPage.jsx:8405-8480).
- Portal path: Visits → Completed → expand → View report / Download PDF (PortalPage.jsx:2266, 2916); lawn health card under Plan → Lawn Care row (PortalPage.jsx:533 `useLawnHealth`; lawn-health.js is auth-gated, lawn-health.js:25).
- Diagnostic funnels (`/pest-report`, `/lawn-report`) end in Book/Call/quote-request CTAs — no dead ends (agent-verified journey; QuoteRequestForm maps machine codes to friendly copy, LawnReportViewPage.jsx:138-154).

### D. Add a notification recipient → SMS opt-in → consent record

Portal → Visits (Upcoming) → "On-location contacts" → name/phone → Save contact (PortalPage.jsx:3972-4016) → `updatePropertyNotificationPrefs`. **The chain ends there:**
- No consent language shown to the account holder, no attestation the recipient agreed (4009).
- **No double opt-in exists anywhere for SMS** — no confirmation text, no YES consumption; the only YES/START handling is re-subscribe after STOP (twilio-webhook.js:260-294). `notification_prefs.sms_enabled` defaults to `true` at row creation (migrations/20260401000001_initial_schema.js:169).
- **No consent record is written** — no opted_in_at/source/language columns exist; the messaging audit log stores only caller-asserted `consentBasis` at send time plus a hash/preview of the outbound body, never the disclosure the person saw (services/messaging/audit.js:65-67). See findings S1-2/S1-4.
Failure handling on save is good (optimistic revert + alert). The consent architecture is the gap, not the UX.

### E. Membership: view tier, upgrade, downgrade, cancel

- **View:** Home badge (0 taps) / Plan tab (1 tap); tier + % discount + AI price estimate with confidence label (PortalPage.jsx:7801).
- **Upgrade:** Plan → tier explorer → Check My Price → "Request This Tier" → `createRequest({category:'upgrade'})` → "Request sent" (7930, 8196). **Request-only, not self-service.**
- **Downgrade:** lower tiers can't be priced (`canPriceTier = targetIdx > currentIdx`, 7886) — "Lower-tier changes need a manual account review" (8083), and the request files under `category:'upgrade'` (7930). **Request-only + miscategorized.**
- **Cancel/Pause:** Account Options → reason → submit → `createRequest({category:'cancellation'})` (9376) → terminal sentence "Cancellation request received. We will reach out to finalize." (9398-9401) — no reference number, no effective date, no artifact (finding S3-7).
- **Billing mechanics behind it (server):** recurring dues are a custom daily cron, not Stripe Subscriptions (scheduler.js:3809 → billing-cron.js:99 → stripe.js:2103); cancellation processing genuinely stops charging — `active:false, autopay_enabled:false, next_charge_date:null`, retries disarmed, recurring series stopped (cancellation-processor.js:79-135) and the cron's guards exclude the customer (billing-cron.js:122, 155).

### F. Failed payment → recovery

- **Server:** retry ladder Day 1/3/5 (`RETRY_DELAYS_DAYS=[2,2]`, billing-cron.js:27, 437, 1176-1178) with SMS carrying an update-card URL at each rung (465-475, 1196-1206); third strike pauses service + notifies owner and customer (1124-1165). Ambiguous Stripe outcomes are parked, never blind-retried (stripe.js:1957-1968, 2039-2086).
- **Portal:** red banner + failed history row offer **only "Update Payment Method"** (PortalPage.jsx:5279) — no retry-now/pay-now control; with Auto Pay off and a balance due, the only affordance is "enable Auto Pay and wait for the cron" (4617-4621), while the dashboard tile labeled "Pay now" (1769) routes to a Billing tab with no pay button. **This is the S2 dead end (finding S2-1).**
- **Tokenized invoice links** (`/pay/:token`) recover fine: declined cards re-try in place, 3DS handled, ACH-processing and saved-card-pending states are honest (PayPageV2.jsx:1789-1808), receipt redirect after settle.
- **SCA edge:** off-session card charge landing `requires_action` gets no retry and the only customer nudge is an SMS from a template keyed `bank_verification_incomplete` (billing-cron.js:388; stripe-webhook.js:3806) — mislabeled for a card-3DS situation (finding S3-16).

---

## PHASE 3 — CONVERSION FRICTION

### Estimate flow (`/estimate/:token`)

- **Taps, landing → booked (live default, deposit lane on):** select slot (1) → payment preference (2) → Confirm booking (3) → deposit modal: card entry + Pay (4) (+1 more tap if a credit-card surcharge quote relabels the button — DepositModal two-step, EstimateViewPage.jsx:2369-2372). **4-5 taps + one card entry.** With the seamless Auto-Pay flag on, slot tap auto-advances with `pay_at_visit` preselected (4693-4701): **2 taps + card entry.**
- **Form fields: 0.** Identity, address, and pricing are all prefilled from the estimate; the only typing is the card.
- **Required-that-could-be-inferred:** none left — this flow is already at the floor.
- **Waits without feedback: none found.** Skeletons on load (4738-4748), "Loading available times…" (SlotPicker.jsx:434-440), button-label processing states on every money action, "Checking..." on AI asks (1180).
- **Decisions without information:** the recurring-vs-one-time toggle and cadence pills are fully priced before choice; the payment-preference step explains each option's invoice consequences inline (PaymentPreferenceButtons.jsx:264-314). The one under-informed decision is **"Pay the 12-month plan in full," which shows no dollar figure on the button itself** — the annual total lives further up in the price card (`$X / year`, CombinedRecurringPriceCard 1935-1941); the prepay invoice amount only becomes concrete at the review/success step.
- **Highest-drop-off step:** the deposit/card-entry modal — it is the first moment money moves, it interrupts a flow that was tap-only until then, and it adds a surcharge-disclosure second tap for credit cards. (The code already works to soften it: "$0 today" copy, wallets, applied-to-invoice framing.)

### `/book` public funnel

- **Taps:** address type+select (1) → "Find my best times" (2) → day (3) → time (4) → Continue (5) → Confirm booking (6). **Fields:** phone, first name, last name required (PublicBookingPage.jsx:1142); email + notes optional; all fields skipped for a recognized existing customer (1030-1049).
- **Waits:** all have feedback ("Checking the route map…" 776-780, "Loading times…" 924-926).
- **Decisions without information:** the whole funnel — **service is never chosen (it's a URL param) and price is never shown** (findings S3-1/S3-2). The customer picks a time and hands over contact info without knowing what the visit costs or being able to say what it's for.
- **Highest-drop-off step:** step 2 → 3 (contact form after time pick). A cold visitor is asked for their phone number for an unpriced service they never explicitly selected.

### Returning customer → report / assessment

- SMS link → report: **0 taps** to value. Portal: 3-4 taps (Visits → Completed → expand → View report). No friction issues beyond findings S3-11..15.

### Add notification recipient

- ~3 taps + typing name/phone (PortalPage.jsx:3972-4016). Friction is fine; the missing consent step is the issue (S1-4).

### Membership change

- Upgrade ≈5 taps to a *request*, not a completed change; cancel ≈4 taps to a request with no artifact. The friction is not the taps — it's that the flow ends in "we'll call you" (S3-6/7).

### Failed payment → recovery

- Via SMS pay link: 1 tap to a full checkout. Via portal: **no path** (S2-1).

---

## PHASE 4 — TRUST AND CLARITY

### Estimate service cards + checkout

- **Total price & cadence before commit: yes.** Per-application price with cadence label and `$X / year` (PriceCard.jsx:200-216; CombinedRecurringPriceCard 1896-1946); one-time totals itemized (OneTimeBreakdownCard 1757-1847); setup fee called out with prepay-waiver note (SetupFeeCard 1552-1582); ranged commercial pricing says "we confirm your exact price with a quick site visit" instead of faking precision (1942-1946).
- **First-charge timing: yes, per mode.** Deposit: "A $X deposit is due today to hold your spot — it is applied to your first invoice" (5330-5346); pay-per-application: invoice preview + "No payment is charged on this page. After confirmation, we open the invoice…" (PaymentPreferenceButtons.jsx:308-314); card-hold: "We don't charge you today… charged the final total after your visit is completed. A $49 fee applies only if you cancel within 24 hours or aren't home" (241, 2515-2518); Auto Pay: "Nothing is charged today… after each completed service, that service's amount is charged automatically" (5343-5346).
- **Contract length / cancellation: yes.** "No long-term contract," "cancel anytime" in the CTA micro-terms (estimate-glass-copy.js:56, 338, 357, 364, 370, 376); consent text names revocation channels (email/phone/app/portal) verbatim and is version-locked v10_2026-07-13 (paymentMethodConsentText.js:5-16).
- **Surcharge: exemplary.** Disclosure phrase is extracted verbatim from the versioned consent copy so it cannot drift from the charged rate (PaymentPreferenceButtons.jsx:23-40); exact totals shown before every card confirm (PayPageV2 quote step 911-925; DepositModal 2403-2407).
- **License/guarantee/social proof at the decision point: yes.** FDACS `JB351547` in every shell footer (TrustFooter.jsx:6; BrandFooter.jsx:306) and on the slot-picker tech chip (SlotPicker.jsx:520-522); review strip before price + Google-profile proof on the estimate (5444-5445, 5570-5573); "Try us risk-free — 90-day money-back guarantee" beside the plan (5019-5023).
- **Copy promising outcomes:** none found in customer-facing static copy that overpromises — service headlines are protection-framed ("whatever's getting inside, it stops here", 3092-3101), and the one prose use of "guarantee" in reports explicitly disclaims immediate elimination (ReportViewPage.jsx:941). **The claims to verify against the actual service agreement are "90-day money-back guarantee" and "Unlimited free callbacks"** (estimate-glass-copy.js:56) — see UNVERIFIED.
- **Have-to-call-to-find-out items:** legitimately gated cases only (quote-required, trenching review, commercial site-confirmation), each with an explanatory card (2992-3086). The genuine call-to-find-out gap is on `/book`, not the estimate.

### `/book`

- **Price: absent entirely** (S3-2). **Service: not chooseable** (S3-1). License/terms only in the footer; no guarantee or proof anywhere in the funnel. A first-time visitor cannot learn what the visit costs without calling — the exact anti-pattern this audit hunts.

### Portal

- Balance, YTD totals, autopay state, and consent-gated card management are clear; reward figures only render when server-confirmed (PortalPage.jsx:1762-1766). Trust gaps: dashboard shows the literal string "Call us" as the balance on a transient error (1748); cancel/pause produce no artifact (9398-9401); no invoice/receipt PDF (S3-8).

---

## PHASE 5 — BREAK IT

**Tokenized estimate link**
- *Expired:* 404 gate → NotFoundCard + self-serve one-time 7-day extension; later clicks notify office (EstimateViewPage.jsx:579-708; server eligibility flag estimate-public.js:17086-17092).
- *Already accepted:* accept replays return the full success payload with `alreadyAccepted` (estimate-public.js:7464-7488); reopening shows a read-only recap pinned to the accepted frequency (3919-3927, 5098-5147).
- *Forwarded to a third party:* the holder sees the customer's name/email/phone/address (729-812) and can accept, pay the deposit, and book. Mitigations: `no-store` + `Referrer-Policy: no-referrer` on every payload (estimate-public.js:17071-17073; estimate-slots-public.js:115-120), expiry, rate limits. Inherent tokenized-link tradeoff — accepted risk to note, not a bug.
- *Opened twice / two tabs:* each tab is independent; re-reserve of the customer's own slot refreshes the same hold, a different slot supersedes it (4594-4601); the losing tab's accept 409s into `reservation_expired`/`slot_conflict` recovery (4317-4324); a second accept after success replays idempotently.
- *Opened after price change:* prices are never client-authoritative — add-on/bond changes PUT to the server and re-fetch (`loadEstimate`), serialized through a mutation chain so a stale reload can't win (3990-4095); accept re-derives everything server-side; bond+prepay incompatibility is force-re-chosen (4076-4080).

**Double-submit**
- *Accept:* synchronous ref latch (`acceptInFlightRef`, 3669-3670, 4243-4244) + phase-ref guards on every entry point (4356-4360); server accept is idempotent.
- *Pay:* `processingRef` flips before any await (PayPageV2.jsx:421-429); deposit re-taps re-check PI status instead of re-confirming (2325-2334); server locks the invoice `forUpdate` and 409s a live payment row (stripe.js:3352, 3555-3564); charge idempotency keys are scoped per invoice/PI/day (stripe.js:2123, 3659-3660).
- *Booking (`/book`):* client guard is state-based only (PublicBookingPage.jsx:414-416) — no sync ref — but the server replays double-submits idempotently (booking.js:2382-2384) and takes customer/tech/zone/date advisory locks (booking.js:1784-1800). Contained (S4-6).
- *Webhooks:* atomic `ON CONFLICT DO NOTHING` event-id dedupe with stale-claim lease (stripe-webhook.js:530-541; stripe-webhook-helpers.js:33-46).

**Back button / refresh mid-checkout**
- Estimate: refresh drops React state back to configure; the server-side hold survives (15 min) and re-picking the same slot reclaims it; a paid deposit survives refresh — `/deposit-intent` returns `alreadySatisfied` and accept re-verifies the ledger (estimate-slots-public.js:684-692). 3DS redirects restore intent ids from URL params, then scrub them (3728-3754).
- `/pay`: full redirect-return machinery — consent re-POST with retry, `?fresh=1` receipt flow, stale-invoice version guard forces a reload if an admin edited the invoice between GET and pay (PayPageV2.jsx:1522-1605, 1716-1727).
- `/book`: refresh loses wizard progress (plain state, no persistence) — restart from address; the abandoned-intent recovery cron (capture-intent, keepalive, PublicBookingPage.jsx:358-399) is the safety net.

**Two customers, same slot**
- Reserve runs in one transaction: estimate row `FOR UPDATE`, then `pg_advisory_xact_lock` on the slot date so two *different* estimates serialize too (slot-reservation.js:321-491). Loser gets `SLOT_UNAVAILABLE` 409 **with fresh slots in the response body** (estimate-slots-public.js:463-477) and the UI re-picks. `/book` mirrors this with its own lock stack + signed slot offers (`slot_sig`, booking.js:434-438 client / 540-543 verify).

**Stripe**
- *Declined card:* message surfaced in a `role="alert"` with retry (PayPageV2.jsx:1221-1232); deposit modal same (2408-2410).
- *3DS:* inline `handleNextAction` on finalize (954-979; deposit 2310-2317); redirect variants return with `payment_intent`/`setup_intent` params handled at page level.
- *Webhook before redirect:* invoice already `paid`/`processing` → `/pay` redirects straight to receipt (1662-1669); `/setup` 409 `inProgress` renders the calm bank-processing state instead of an error (1789-1808).
- *Webhook late:* client `/confirm` settles synchronously after every tender (PayPageV2.jsx:1844-1865) — verified server-side to mark paid under locks with credit-card bypass detection fail-closed (stripe.js:4774-4830) — so the webhook is a backstop, not the only settle.
- *Webhook never arrives AND the client `/confirm` call was lost (tab closed at the exact wrong moment):* no scheduled reconciliation poll exists; recovery is opportunistic — the next `/setup` detects a succeeded PI on an unpaid invoice, 409s the customer, and raises an admin alert (stripe.js:3638-3652) — or manual admin reconcile. Customer can look unpaid and get dunned until an operator acts (S3-15).
- *Customer closes tab mid-payment:* PI persists; reload re-derives state from the live PI (deposit 2325-2334; pay `/setup` triage). No double-charge vector found.
- *Charges:* integer cents end-to-end at the Stripe boundary (stripe-pricing.js:63-94), amounts always server-derived — no endpoint accepts a client-posted charge amount on customer paths (agent-verified; finalize re-derives and rejects drift, stripe.js:4171-4180). Stripe SDK: `maxNetworkRetries: 2`, no explicit timeout (SDK default 80s) (stripe.js:25).

**Twilio**
- *STOP mid-flow:* honored — inbound STOP writes phone-keyed suppression + `sms_enabled=false` (twilio-webhook.js:210-224), reminder gates check both before sending (appointment-reminders.js:93, 106-111), email fallback where available (twilio-webhook.js:878-884). Compliant STOP confirmation reply (twilio-webhook.js:256). START/YES re-subscribes (260-294).
- *…except one path:* the estimate "text me the details packet" button calls `TwilioService.sendSMS` directly, bypassing the suppression-checking wrapper entirely (estimate-public.js:17013-17016) — a STOPped customer can still be texted (S2-4).
- *Invalid number/landline:* proactive Twilio Lookup validator exists but is dark (`proactiveLineTypeLookup` gate, line-type.js:117) and fails open; reactive suppression only on carrier code 30006 (twilio-webhook.js:895-901; landline-suppression.js:63-73).
- *Delivery failure:* operator-visible only (`notifyTwilioFailure` → /admin/communications, twilio-webhook.js:857-871); nothing customer-visible. "Consent recorded but message never delivered" has no state because no confirmation message exists (S1-2).

**Address outside service area** — `/book` has no geographic gate: availability offers slots for any geocodable address, detour distance only drives the soft "No route near you that day yet" banner (booking.js:545-548; find-time.js:227-265; PublicBookingPage.jsx:597-604), and `createSelfBooking` validates dates/blackouts/units but not geography (booking.js:1226-1290). A Naples or Miami address can complete a booking the office must unwind (S3-3). Estimate-flow bookings are in-area by construction (office mints the estimate).

**Zone with zero availability / boundary** — `/book` empty state: "No times available in the next 2 weeks. Call…" (256-258); per-date empty: "No open times on that date…" (945-949). Estimate slot picker and reschedule page both have search + call fallbacks (SlotPicker.jsx:501-510; ReschedulePage.jsx:1137-1145). Boundaries are detour-scored, no cliff behavior.

**Empty states** — new-customer portal renders sensible empties (balance "…", "All current", section gating); reports gate every section on content and render "Photo unavailable" tiles (ProjectReportViewPage.jsx:1259).

**Timezone & DST** — ET-pinned via IANA-zone formatting on estimate dates (codified after a prior P1 — EstimateViewPage.jsx:743-753), expiry labels (620-624), booking windows (booking.js:1073-1077), reminder scheduling, and receipt/contract/statement dates (small-page sweep found no UTC-midnight day-shift: ReschedulePage.jsx:99, ReceiptPage.jsx:77-81, StatementPayPage.jsx:39). Two exceptions: TrackPage renders times with no ET label for out-of-state viewers (S3-9) and reuses an ET-projecting date formatter on a naive local string (S4-5).

**Money integrity** — cents at every charge site; the one float path is the portal's *display* balance summing `parseFloat` dollars across rows (billing-v2.js:627, 679) — penny-drift display risk only (S4-7).

**External calls / silent failures** — client fetches consistently surface failures with retry or phone fallback; exceptions: ServiceOutlinePage can render "HTTP 500" with no exit (S2-2), recap deep-link no-ops silently (S3-12), `/book`'s SMS-sent claim is never checked (S3-4), and `/book` surfaces raw "Unexpected end of JSON input" on non-JSON availability errors (S3-17, render-verified).

---

## PHASE 6 — MOBILE AND DESIGN (390×844)

- **Input zoom: correctly mitigated globally.** iOS auto-zoom on sub-16px inputs is suppressed by `@media (pointer: coarse) input { font-size: 16px !important }` (index.css:42-48) while pinch-zoom stays enabled (index.html:6-7 has no `user-scalable=no`). Inline 14-15px input styles across the portal/pages are overridden by this on touch devices — not a live defect.
- **Body text below 16px is the systemwide norm** — the doc theme pins body at 14 / captions at 12 (theme-doc.js:41), report body copy runs 14-15px with 12px load-bearing footers and 10px map labels (ReportViewPage.jsx:6391, 6409, 6228), the portal has 12px subs and even 9-10px labels (PortalPage.jsx:716, 2660). Contrast is disciplined (slate-600 `#475569`/`#3F4A65` on white — AA-safe; theme-customer.js:22-23), so this is a size problem, not a color problem — and for this audience a conversion problem (S3-10).
- **Tap targets:** most primary CTAs are ≥44-48px (estimateCtaStyle 99-102; docButton; touch-audit annotations throughout). Below-floor exceptions: RatePage's ten score buttons at 40px × ~35px on 390px — the primary interaction of the whole review funnel (RatePage.jsx:400, 417) (S3-13); portal notification/billing toggles 44×24 and 48×32, "Set default"/"Remove" card buttons at ~33px, Pause/Cancel links minHeight 36 (PortalPage.jsx:3807, 5381, 5032-5034, 8727); lawn-photo arrows 36px (LawnReportV2.jsx:349) (S4-1).
- **Modals:** estimate money modals have focus trap + Esc + `maxHeight: 90vh` internal scroll (useModalFocus.js:1-60; EstimateViewPage.jsx:2384-2392); no scroll-lock omission found on the money path.
- **Forms:** `/book` contact step is the model — label htmlFor/id pairs, `autocomplete="tel/given-name/family-name/email"`, correct `inputMode` (PublicBookingPage.jsx:1052-1115); error text in `role="alert"` blocks adjacent to fields (782-787, 1130-1135).
- **Horizontal scroll/pinch:** none found on the audited pages (max-width columns; grids collapse); the one pinch-forcing surface is the legacy report's fixed-620px PDF iframe (S3-14).
- **Brand warmth vs admin monochrome:** customer surfaces consistently carry the customer system (glass scene, serif headings, navy/gold, warm footers — enforced by `check:portal-brand` in the build, package.json prebuild); no admin-zinc leakage found. The only unstyled-default reads: ServiceOutlinePage's bare error card (S2-2) and the dead-code `NotificationPreferences.jsx` grays (#999/#888) which are unmounted (S4-8).
- **Color-only signaling:** lawn diagnostic severity is a colored border with no text label or legend (LawnReportViewPage.jsx:36, 256) (S4-2).

---

## PHASE 6.5 — RENDER PASS + OWNER-REPORTED UI ISSUES (added 2026-07-22, same day)

After the code-only pass, a live render pass was run at 390×844 (Chromium, iPhone-class emulation, touch + `pointer: coarse` verified matching) against the Vite dev client and the repo's fixture preview harnesses, plus a code trace of four UI issues the owner reported from a real device.

**Render-verified (real interactions, not just screenshots):**
- **Estimate happy path renders end-to-end**: frequency pill switch → slot select → payment preference → review card → confirm → "You're booked!" success screen, with the booked date/time carried through (preview harness + endpoint mocks for reserve/accept).
- **Deposit modal (secondary window)**: opens via the 402 DEPOSIT_REQUIRED path, correct "$49.00 deposit… applied to your first invoice" disclosure, **fits the viewport un-clipped** (measured box 333-582px within a 914px viewport) and **Escape closes it**. The 402 → error banner → re-confirm → modal recovery sequence works as coded.
- **No horizontal page overflow** on any rendered surface (estimate pest/bundle/lawn/accepted scenarios, service report, project report, /login, /book): `document.scrollWidth == innerWidth` everywhere; the only >viewport-width elements are decorative (glass orbs, review-ticker tracks) inside overflow containers.
- **The 16px input-zoom override is live on the real SPA**: with `pointer: coarse` matching, the index.css rule (`input, textarea, select { font-size: 16px !important }`) is present in the loaded stylesheet and wins over inline 14-15px styles — /login and /book inputs compute 16px. (Earlier sub-16px readings were taken before Vite's async style injection settled; the dev-preview harnesses don't load index.css at all, which is harness-only.)
- **Slot staleness guard works as designed**: the fixture's past-dated slots rendered correctly grayed and un-tappable.
- **Not renderable in this sandbox**: the authenticated portal (My Property, tier explorer, billing) needs a live API + session — the owner's device screenshots below stand in for it, with causes traced in code.

**Owner-reported issues from device screenshots, traced to code:** findings S4-12 through S4-15 and S3-17 below.

---

## PHASE 7 — COMPLIANCE

**SMS / A2P 10DLC / TCPA**
- **Consent model is single opt-in, disclosure-based, with the disclosure living outside this repo** (marketing-site forms). In-repo customer surfaces show no opt-in language at all: the live portal contacts UI has none (PortalPage.jsx:4009), `/book` has none (grep-verified), and the only compliant strings are the STOP reply (twilio-webhook.js:256) and an **unwired** HELP template (opt-out-detector.js:46-49, exported but never imported by the webhook — twilio-webhook.js:9). Message frequency and "Msg & data rates may apply" appear nowhere a customer opts in. (S1-3)
- **No durable consent record** — no timestamp/source/language capture for SMS consent anywhere; `messaging_audit_log` stores caller-asserted basis per send, not the opt-in event (audit.js:65-67). The codebase itself proves the team knows how to do this right: payment consent snapshots verbatim text + version + IP + UA (payment-method-consents.js:41-50). SMS never got that rigor. (S1-2)
- **STOP enforcement is real but architectural only at the wrapper layer** — `TwilioService.sendSMS` itself never checks suppression (twilio.js:320-535, provider call at 488); one live customer path bypasses the wrapper today (estimate-public.js:17013) and any future direct caller silently will too. (S2-4)
- **No TCPA calling-window floor (8am-9pm local)** — quiet hours exist only when a customer personally set them, and only on the dispatcher path (notification-dispatcher.js:65-83); the canonical wrapper has no time-of-day validator (send-customer-message.js:153-164). Exposure in practice depends on cron timing, but no code prevents a night send. (S1-3)
- **Third-party enrollment**: referral invites and on-location contacts text numbers whose owners never consented to anything; the referral send self-asserts `consentBasis: {status:'transactional_allowed', source:'referral_invite_form'}` (referrals-v2.js:243-255) — an assertion, not a capture; referral invites are promotional in nature. Mitigations that do exist: sends route through the suppression-checking wrapper, 24h per-number cooldown (218-229), honest `sms_failed` states in the UI. (S1-4)

**Recurring-billing disclosure before first charge** — strong. Verbatim, versioned consent text behind an explicit checkbox before any card is saved for Auto Pay (EstimateViewPage.jsx:2638-2647; SaveCardConsent on `/pay`); enrollment server-side requires a v8+ scoped consent row (payment-method-consents.js MIN_ENROLLMENT_CONSENT_MAJOR); first-charge timing stated per mode (Phase 4). ACH variant covers NACHA/Reg-E revocation timing (paymentMethodConsentText.js:18-29).

**Terms/cancellation reachable from checkout** — yes: Privacy Policy + Terms of Service links in both customer footers rendered on the estimate and pay surfaces (BrandFooter.jsx:39-40, 179-181, 298-300; TrustFooter.jsx:8-9, 42), plus "No long-term contract / cancel anytime" in the decision-point copy.

**Review solicitation** — `/rate` gates by score: 8-10 → Google-review path with AI writer; 1-7 → private feedback only, and the server 403s the review writer below 8 (RatePage.jsx:162-170; review-gate.js:404-406). Meanwhile the post-service report's ask sends *everyone* to Google in one tap (ReportViewPage.jsx:2647-2658) — inconsistent with the gate and, in the gated funnel, the classic "review gating" pattern Google's policies prohibit and the FTC's 2024 reviews rule scrutinizes. (S1-1)

---

## PHASE 8 — FINDINGS

Severity: **S1** loses a sale / charges incorrectly / drops a consent record / legal exposure · **S2** blocks booking or paying · **S3** degraded, workaround exists · **S4** polish.

---

**[S1-1] Review funnel gates public reviews by score**
Where: `client/src/pages/RatePage.jsx:162-170`; `server/routes/review-gate.js:404-406`
Repro: 1. Open `/rate/:token` from a review-request SMS. 2. Tap a score of 7 or below. 3. Observe the private-feedback screen with no Google option; server refuses the review writer (`403 'Review writer is available for high-rating responses only'`). Tap 8+ instead → Google-review path + AI-drafted review.
Expected / Actual: Solicitation treats all customers alike / only 8-10 scorers are steered to public reviews; 1-7 are diverted to a private channel.
Blast radius: every review request sent; legal/policy exposure (Google review-gating policy, FTC Consumer Reviews rule) rather than UX breakage — works exactly as designed.
Fix sketch: offer the public-review option to all scores (keep the AI writer as an 8+ perk if desired), or route everyone through a neutral "share feedback" step that always includes the Google link. Owner/counsel decision.

**[S1-2] No durable SMS consent record (timestamp + source + language)**
Where: `server/services/messaging/audit.js:65-67`; `server/models/migrations/20260401000001_initial_schema.js:169`; contrast `server/services/payment-method-consents.js:41-50`
Repro: 1. Become a customer via any path. 2. `notification_prefs` row is created with `sms_enabled` defaulting true; no opted_in_at/consent_source/consent_text column exists in any migration. 3. Carrier/plaintiff asks "prove this person opted in, when, and to what language" — nothing to produce.
Expected / Actual: a per-recipient consent capture like the payment-consent snapshot / only per-send, caller-asserted `consentBasis` on the audit log.
Blast radius: entire SMS program (every recipient), A2P 10DLC audit and TCPA defense posture.
Fix sketch: add an `sms_consents` table (phone, customer_id, captured_at, source, verbatim disclosure, version — mirror `payment_method_consents`), write it at every capture point, and pass it as the wrapper's consentBasis.

**[S1-3] No TCPA quiet-hours floor; HELP keyword unwired; no in-repo opt-in disclosure**
Where: `server/services/notification-dispatcher.js:65-83` (only quiet-hours check, customer-set only); `server/services/messaging/send-customer-message.js:153-164` (validator chain has no time-of-day gate); `server/services/messaging/opt-out-detector.js:46-49,143-152` (HELP template defined, never imported — `twilio-webhook.js:9`); `client/src/pages/PortalPage.jsx:4009` + `client/src/pages/PublicBookingPage.jsx` (no Msg&data-rates / frequency / STOP-HELP copy at any in-repo capture point)
Repro: 1. Any cron/wrapper send fires outside 8am-9pm — nothing blocks it. 2. Text "HELP" to the Waves number — no compliance auto-reply is generated by this codebase. 3. Search client for "Msg & data rates" — zero hits.
Expected / Actual: CTIA/10DLC baseline (time window, HELP response, disclosure at capture) / present only for STOP.
Blast radius: carrier registration risk for the sending number (suspension would silence every reminder/confirmation flow), plus statutory TCPA exposure for any night send.
Fix sketch: add a default ET 8am-9pm validator to the wrapper's chain (with a transactional-override list if desired); wire `detectHelp` → `HELP_RESPONSE_TEMPLATE` in the inbound webhook; add the standard disclosure line wherever a number is captured. Verify whether Twilio Advanced Opt-Out already covers HELP at the account level before wiring (see UNVERIFIED).

**[S1-4] Third-party numbers enrolled for SMS with no recipient consent capture**
Where: `client/src/pages/PortalPage.jsx:10175-10177,10527` (referral "Text a friend"); `client/src/pages/PortalPage.jsx:3972-4016` (on-location contacts); `server/routes/referrals-v2.js:243-255` (send self-asserts `consentBasis {status:'transactional_allowed', source:'referral_invite_form'}`)
Repro: 1. Portal → Refer → enter any name + phone → submit: Waves texts that number a promotional referral invite. 2. Visits → On-location contacts → add any phone → Save: that number now receives recurring appointment texts. Neither flow shows consent language, an attestation, or a confirmation opt-in to the recipient.
Expected / Actual: recipient-consent capture (or at minimum an attestation + first-message opt-out instructions) / consent is asserted on the recipient's behalf by the account holder.
Blast radius: every referral invite and every added property contact; referral invites are promotional — the highest-risk TCPA category. Mitigations already present: sends route through the suppression wrapper (a prior STOP blocks them), 24h cooldown per number, honest `sms_failed` UI.
Fix sketch: add "I confirm they've agreed to receive this text" attestation + STOP line in the first message for contacts; for referral invites, consider a compliance review — recipient-initiated claim links (customer shares the link themselves) carry far less risk than Waves-originated texts.

**[S2-1] Portal has no way to pay a balance; failed-payment recovery has no pay/retry action**
Where: `client/src/pages/PortalPage.jsx:1769` ("Pay now" quick action → Billing tab), `:4617-4621` (Auto-Pay-off banner: "Add or enable Auto Pay below to run future charges automatically"), `:5279` (failed row → "Update Payment Method" only); BillingTab render read in full (4775-5460) — no pay control exists
Repro: 1. Have a balance due with Auto Pay off. 2. Home tile says "Pay now" → lands on Billing. 3. Find: add/remove card, enable Auto Pay — no button that moves money today. 4. After a failed payment, the red "avoid service interruption" banner offers only the add-card modal; the re-charge is an invisible server retry.
Expected / Actual: a "Pay $X now" that opens the existing `/pay/:token` checkout for the open invoice / enable-autopay-and-wait, or dig the invoice SMS back out of message history.
Blast radius: every balance-due customer who opens the app instead of the SMS link — delayed collections, "service interruption" anxiety with no relief valve, support calls.
Fix sketch: surface the open invoice's existing tokenized pay link ("Pay now" → `/pay/:token`) on the dashboard tile, the Billing header, and the failed-payment banner; add "Retry payment" after a card update. The checkout already exists — this is wiring, not new payments code.

**[S2-2] Service-outline errors dead-end with no phone/retry and can show a raw "HTTP 500"**
Where: `client/src/pages/ServiceOutlinePage.jsx:20-28` (ErrorState: heading + message only), `:65-69` (`body.error || \`HTTP ${response.status}\``); expired 410 from `server/routes/service-outlines-public.js:100`
Repro: 1. Open a `/service-outlines/:token` link after expiry (410) or during a server error (500 → non-JSON body). 2. See "Service Outline Unavailable" + either the server sentence or literally "HTTP 500". 3. No retry button, no phone number, no link out.
Expected / Actual: the standard expired-card treatment every other token page has (phone + retry) / a hard dead-end on a page whose job is the "View Estimate" handoff.
Blast radius: every recipient of an expired/errored outline link — a prospect-facing lost-sale path.
Fix sketch: reuse `PublicLoadError` for non-404s and add the phone + "call us and we'll resend it" copy to the terminal state; never render the raw status text.

**[S2-3] Login dead-ends for phones not on file — the friendly copy is dead code**
Where: `server/routes/auth.js:254` (unknown phone: log-only, uniform response), `:294` (verify → 401 'Invalid or expired verification code'); `client/src/pages/LoginPage.jsx:27` keys on the string `'No account found for this phone number'`, which no server route emits (grep-verified)
Repro: 1. Enter a mobile number Waves doesn't have (account is under a spouse's number/landline). 2. Advance to the code screen (anti-enumeration). 3. Any code → "Invalid or expired verification code," forever. No "not on file — call us" guidance ever appears.
Expected / Actual: after N failed verifies, guidance ("that number may not be on file — call (941) 297-5749") / an infinite invalid-code loop.
Blast radius: every customer whose account phone differs from the phone in their hand — a common retiree household pattern; blocks all portal self-service and generates "your app is broken" calls.
Fix sketch: keep the uniform send-code response, but after 2-3 failed verifications for a phone with no account, show the "may not be on file, call us" line client-side (no enumeration leak — attacker learns nothing before burning verify attempts).

**[S2-4] One live SMS path bypasses STOP suppression (and the enforcement layer invites more)**
Where: `server/routes/estimate-public.js:17013-17016` (`TwilioService.sendSMS(contact.customerPhone, …)` direct); enforcement lives only in the wrapper (`send-customer-message.js:155-156`), `twilio.js:320-535` has no suppression check (provider call at 488)
Repro: 1. Customer texts STOP (suppression row written, twilio-webhook.js:210-224). 2. Later they (or anyone holding their estimate link) tap "Text me the link" on a service-details packet. 3. The SMS sends — no suppression lookup on this path.
Expected / Actual: STOP suppresses all traffic per carrier rules / this send goes out.
Blast radius: narrow today (customer-initiated, in-session, deduped) but it is a post-STOP send — the per-text statutory TCPA category — and the architecture means any future direct `sendSMS` caller repeats it silently.
Fix sketch: route this send through `sendCustomerMessage`; add a lint/contract check (or a suppression check inside `TwilioService.sendSMS` itself) so customer-numbered direct sends fail loudly.

**[S3-1] `/book` has no service picker — service is a URL parameter**
Where: `client/src/pages/PublicBookingPage.jsx:93,100` (service from `?service=`, default `pest_control`); `SERVICES` catalog (15-23) never rendered as UI; step 1 is address-only (668-750); no `setService` call exists
Repro: 1. Open bare `/book` (GBP button, typed URL). 2. You are booking Pest Control; nothing on any step lets you choose lawn/mosquito/termite/rodent. 3. Multi-service booking in one pass is impossible.
Expected / Actual: pick what you're booking / silently pre-decided.
Blast radius: every cold direct/GBP visitor wanting a non-pest service — they either book the wrong thing, bounce, or call. Also forecloses the multi-service booking the estimate flow supports.
Fix sketch: render the existing SERVICES array as step 0 (cards with the descriptions already written), defaulting from the URL param when present.

**[S3-2] `/book` never shows a price**
Where: `client/src/pages/PublicBookingPage.jsx` — full flow; step-3 recap shows label only (1008-1013); step-4 confirmation has no amount (1170-1195)
Repro: 1. Complete a booking. 2. At no point is a dollar figure, range, or "from $X" shown; there's no link to pricing.
Expected / Actual: price or honest range before the contact-info commitment / zero price disclosure; first price contact is the invoice or the tech.
Blast radius: conversion (price-anxious visitors abandon at the contact step) and trust (price-surprised customers cancel/complain later). This funnel is where ad spend lands.
Fix sketch: show the estimate-engine's "from $X/visit" (or a range) per service on the picker and in the step-3 recap; where address-priced quoting exists (`estimate_token` handoff already prices visits), reuse it.

**[S3-3] `/book` accepts out-of-service-area addresses**
Where: `server/routes/booking.js:545-548` (detour drives messaging only), `server/services/scheduling/find-time.js:227-265` (no max distance), `booking.js:1226-1290` (`createSelfBooking` gates dates/blackouts/units — not geography); client shows only the soft banner (PublicBookingPage.jsx:597-604)
Repro: 1. Enter a geocodable Miami address. 2. Receive real slots (marked not-nearby). 3. Book; confirmation code issued.
Expected / Actual: "outside our service area" stop with the counties named / a booking the office must call to unwind.
Blast radius: low volume but each instance costs a slot hold, an awkward call, and a disappointed prospect; ads targeting keeps most out-of-area traffic away today.
Fix sketch: hard-gate availability on distance-to-zone (service_zones already exists) with a friendly out-of-area screen; log the address as a lead for expansion tracking.

**[S3-4] `/book` claims "We just texted a confirmation" unconditionally**
Where: `client/src/pages/PublicBookingPage.jsx:1167-1169`; server send is best-effort inside try/catch (`booking.js:2199-2224`), response carries no sent flag (2320)
Repro: 1. Book with the confirmation template disabled / Twilio down / a landline. 2. Step 4 still says the text was sent.
Expected / Actual: claim only what happened (cf. the estimate extension's honest `smsSent`/`emailSent`, EstimateViewPage.jsx:586-617) / a promise the server may not have kept.
Blast radius: any send failure turns into "they said they texted me and never did" — trust damage with the exact demographic that screenshots confirmations.
Fix sketch: return `confirmationSmsSent` from `/booking/confirm` and vary the copy ("We just texted…" vs "Your confirmation code is below — save it").

**[S3-5] Membership changes are request-only; downgrades are miscategorized as upgrades**
Where: `client/src/pages/PortalPage.jsx:7930` (`createRequest({category:'upgrade'…})` for both directions), `:7886` (`canPriceTier = targetIdx > currentIdx`), `:8083` ("Lower-tier changes need a manual account review")
Repro: 1. Plan → tier explorer → higher tier → "Request This Tier" → "Request sent" (nothing changes). 2. Lower tier → pricing disabled → "Request Plan Review" → files under category `upgrade`.
Expected / Actual: self-service change, or at least correctly-labeled requests / sales-assisted requests only, with downgrade intents disguised as upgrades in internal reporting.
Blast radius: upgrade revenue waits on a callback; downgrade/retention signals are misfiled.
Fix sketch: at minimum pass a real category ('downgrade'/'plan_review'); longer term let upgrades apply immediately (they raise revenue and the AI price estimate already exists).

**[S3-6] Cancel/pause end in a bare sentence — no artifact, no reference**
Where: `client/src/pages/PortalPage.jsx:9376-9401` (cancel), `:9324` (pause)
Repro: 1. Plan → Account Options → Cancel → reason → submit. 2. Terminal state is one sentence; no reference number, effective date, or email confirmation; the buttons vanish for the session.
Expected / Actual: a receipt of the request ("Request #1234, we'll confirm by …") / "we will reach out to finalize."
Blast radius: cancellation disputes ("I cancelled months ago") with nothing customer-holdable; pairs badly with S2-1 since the customer also can't stop payment themselves.
Fix sketch: return and render the request id + date, and trigger a confirmation email/SMS through the existing notification path.

**[S3-7] No invoice or receipt document anywhere in the portal**
Where: `client/src/pages/PortalPage.jsx:11400` (Documents' "Invoices and receipts" card just links to Billing), `:5263-5308` (history rows: description/amount/status, no download)
Repro: 1. Billing → payment history → need a paid-invoice PDF for HOA/taxes. 2. No per-row receipt, no invoice list, no PDF anywhere.
Expected / Actual: receipt/invoice download (the server already renders invoice PDFs — `pay-v2.js:1247` `/:token/invoice.pdf`) / call the office.
Blast radius: recurring low-grade support load; the retiree-with-HOA use case is common in this market.
Fix sketch: link each history row to its existing receipt page/`invoice.pdf` via the invoice token the server already holds.

**[S3-8] Legacy-visit "Reschedule" quietly degrades to a pre-filled SMS**
Where: `client/src/pages/PortalPage.jsx:3552` (also 3594, 2012): `href={s.rescheduleUrl || 'sms:+19412975749?body=…'}`
Repro: 1. Upcoming visit lacking a server `rescheduleUrl`. 2. Tap Reschedule → SMS composer opens instead of the self-serve `/reschedule/:token` flow.
Expected / Actual: consistent in-app reschedule / some visits self-serve, others text-the-office, with no explanation of the difference.
Blast radius: depends on how many visits lack tokens (UNVERIFIED); each is a manual Virginia touch.
Fix sketch: mint reschedule tokens for all reschedulable visits server-side; keep SMS as the labeled fallback ("Text us to reschedule").

**[S3-9] TrackPage shows appointment times with no ET label**
Where: `client/src/pages/TrackPage.jsx:63-70` (`toLocaleTimeString(undefined,…)` on a naive local ISO); `server/routes/track-public.js:100-105` (window composed as zone-less `YYYY-MM-DDTHH:MM:SS`)
Repro: 1. Snowbird in Denver opens the day-of tracking link. 2. "9:00–11:00 AM" renders with no zone; they read it as Mountain time. (Digits are ET wall-clock because naive-parse round-trips — but nothing says so.)
Expected / Actual: "9:00–11:00 AM ET" / unlabeled time for an audience that is regularly out of state.
Blast radius: missed-window confusion and "where's my tech" calls during snowbird months.
Fix sketch: append "ET" to the window strings on Track (and any other page rendering `window.start` for possibly-remote viewers).

**[S3-10] Sub-16px body text is the system default on customer surfaces**
Where: `client/src/theme-doc.js:41` (body 14 / caption 12); representative: `client/src/pages/ReportViewPage.jsx:6391,6409` (12px labels/footer disclaimers), `:6228` (10px map labels); `client/src/pages/PortalPage.jsx:716` (9px), `:2660` (10px); 14px body throughout the estimate/pay/portal pages
Repro: open any customer page at 390×844; body copy renders 14px, secondary 12px, some labels 9-10px.
Expected / Actual: ≥16px body for a retirement-age market (per this audit's brief) / a deliberate 14px design system — legible, AA-contrast, but small; the 12px report footer carries load-bearing terms.
Blast radius: subtle, systemwide conversion/comprehension tax on the exact audience; not a defect against the current design spec (14 is its floor), so this is a spec-level decision.
Fix sketch: raise DOC body to 16 and caption to 13-14 in theme-doc (one file re-flows the document pages); audit the 9-12px call sites for anything load-bearing (report footer terms first).

**[S3-11] Report/project error states say "Call Waves" with no visible number**
Where: `client/src/pages/ReportViewPage.jsx:4720-4724`; `client/src/pages/ProjectReportViewPage.jsx:476-480` — `tel:` buttons labeled only "Call Waves"; contrast digits shown at `PestReportViewPage.jsx:106`, `LawnReportViewPage.jsx:108`
Repro: 1. Open an expired `/report/:token` on a desktop (retirees frequently read email on laptops). 2. Button does nothing without a dialer; no digits to hand-dial.
Expected / Actual: "(941) 297-5749" visible / dead-end on desktop.
Blast radius: expired-link holders on desktop; cheap to fix.
Fix sketch: render the display number in the button/label as the diagnostic pages do.

**[S3-12] Recap-video SMS deep-link silently no-ops while the clip is unapproved**
Where: `client/src/pages/ReportViewPage.jsx:2001-2006` (card returns null unless `recap.ready`), `:8438-8440` (anchor no-op acknowledged in comment); server attaches recap only when approved (`reports-public.js:1426`)
Repro: 1. Receive the recap SMS, tap while the clip is still processing/unapproved. 2. Land at the top of the report; no video, no placeholder, no explanation.
Expected / Actual: "Your visit video is still processing — check back soon" / silent nothing.
Blast radius: every early tap on a recap link; reads as a broken link.
Fix sketch: when `location.hash === '#visit-recap'` and no recap is in the payload, render a small processing placeholder at the anchor.

**[S3-13] Rate-page score buttons are below tap-target floor on the funnel's only interaction**
Where: `client/src/pages/RatePage.jsx:400` (`repeat(10,…)` grid, gap 4), `:417` (`minHeight: 40`) — ~35px wide at 390px
Repro: 1. Open `/rate/:token` on a phone. 2. Ten adjacent 35×40px buttons; an off-by-one tap changes the score — and at the 7/8 boundary, which path you're routed down.
Expected / Actual: ≥44px targets on the primary control / sub-floor targets where a mis-tap has routing consequences.
Blast radius: every review request; skewed scores and mis-routed reviewers among tremor/low-vision users.
Fix sketch: two rows of five (or 1-5 stars), ≥48px cells.

**[S3-14] Legacy service reports render as a 620px PDF iframe**
Where: `client/src/pages/ReportViewPage.jsx:4794-4795`
Repro: open a pre-V1 report on a phone → double-scroll letterboxed PDF; some mobile browsers refuse inline PDF entirely.
Expected / Actual: readable fallback / near-unusable on 390px.
Blast radius: legacy-record customers only (shrinking population).
Fix sketch: replace the iframe with the styled download card + "open PDF" link.

**[S3-15] Lost-webhook + lost-confirm invoice settlement has no automated reconciliation**
Where: `server/services/stripe.js:4238-4249` (finalize confirms PI, does not mark paid); client `/confirm` covers the normal case (`client/src/pages/PayPageV2.jsx:1844-1865`); recovery is opportunistic only — next `/setup` detects succeeded-PI-on-unpaid and 409s + admin-alerts (`stripe.js:3638-3652`)
Repro: 1. Card customer completes `/finalize`; tab dies before `/confirm`; the `payment_intent.succeeded` webhook is also lost (outage). 2. Invoice stays unpaid-looking; dunning may chase a paid customer until they revisit the pay page or an operator reconciles.
Expected / Actual: a periodic succeeded-PI-vs-unpaid-invoice sweep / manual + opportunistic recovery only. (Double-charge is blocked — the fence 409s any new attempt — so this is honesty/dunning, not money loss.)
Blast radius: rare (two failures must coincide) but the failure mode is "paid customer treated as delinquent."
Fix sketch: small cron: unpaid invoices with a bound PI older than N minutes → retrieve PI → settle or alert. The webhook handler's settle routine already exists to call.

**[S3-16] Off-session SCA failure sends a mislabeled SMS and arms no retry**
Where: `server/services/billing-cron.js:388` (SCA → skip retry, defer to webhook); `server/routes/stripe-webhook.js:3806` (renders `bank_verification_incomplete` template for every requires_action)
Repro: 1. WaveGuard member's bank demands 3DS on the monthly off-session charge. 2. Customer gets a "bank verification incomplete"-keyed SMS (confusing for a card) pointing at /billing — where (per S2-1) there is no pay/authorize action to take. No retry is scheduled.
Expected / Actual: "your card needs verification — tap to pay this month's charge" with an on-session pay link / mislabeled nudge into a tab with no action.
Blast radius: SCA-triggering cards (minority, but recurring — same member every month); silent churn into the 3-strike pause.
Fix sketch: distinct template for card SCA linking an on-session pay/authorize flow (the tokenized invoice checkout handles 3DS today).

**[S4-1] Sub-44px secondary controls in the portal and reports**
Where: `client/src/pages/PortalPage.jsx:3807` (44×24 toggles), `:5381,5429` (48×32), `:5032-5034` (Set default/Remove ~33px), `:8727` (Pause/Cancel minHeight 36); `client/src/components/report/lawnV2/LawnReportV2.jsx:349` (36px arrows)
Repro/Expected/Actual: as cited; billing/notification state changes on sub-floor targets.
Blast radius: mis-taps for tremor users on state-changing controls.
Fix sketch: bump to ≥44px hit areas (padding, not necessarily visual size).

**[S4-2] Lawn-diagnostic severity is color-only**
Where: `client/src/pages/LawnReportViewPage.jsx:36` (SEVERITY_DOT), `:256` (colored border, no text/legend)
Fix sketch: add a "Mild/Moderate/Severe" text chip per finding.

**[S4-3] Already-signed contract link renders as an error**
Where: `server/routes/contracts-public.js:83-85` (410 'Contract has already been signed'); `client/src/pages/ContractSignPage.jsx:258-260` (generic "We could not open that contract")
Repro: re-tap the SMS link after signing → alarming error framing for a completed legal action.
Fix sketch: branch on the 410's `status: 'signed'` and render "Already signed — you're all set" with the signed date.

**[S4-4] Receipt's unpaid state references a "payment link" it doesn't render**
Where: `client/src/pages/ReceiptPage.jsx:352-354`
Repro: failed-after-redirect payment lands on the receipt's `unpaid` branch → "Please use your payment link to try again" with no link on screen (the token in the URL is the same one `/pay/:token` needs).
Fix sketch: render a "Try payment again" button to `/pay/:token`.

**[S4-5] TrackPage reuses the ET-projecting date formatter on naive local strings**
Where: `client/src/pages/TrackPage.jsx:78-84` (formatter comment says "completed_at is a real UTC instant"), used on `window.start` at `:593,623`
Blast radius: theoretical wrong-day label for near-midnight windows viewed off-ET; effectively dormant (no midnight visits).
Fix sketch: use the naive-local day formatter for window dates.

**[S4-6] `/book` confirm lacks a synchronous double-tap latch**
Where: `client/src/pages/PublicBookingPage.jsx:414-416` (state-only guard); server replay makes it safe (`booking.js:2382-2384`)
Fix sketch: mirror the `processingRef` pattern used on every other money/commit button.

**[S4-7] Portal balance figures are float-summed**
Where: `server/routes/billing-v2.js:627` (`sum + parseFloat(p.amount||0)`), `:679`
Blast radius: display-only penny drift vs the cents-based charge path.
Fix sketch: sum in integer cents like `invoiceAmountDue` (invoice-helpers.js:42-44).

**[S4-8] Dead components still in the tree — one with a swallow-errors save**
Where: `client/src/components/portal/NotificationPreferences.jsx:42-53` (no `r.ok` check → "Saved" on failure), `client/src/components/portal/ReferralTab.jsx:43-51` (error body unreachable), `client/src/components/customer/StickyBottomCTA.jsx` — none imported anywhere (grep-verified)
Blast radius: none live; risk is future re-mounting of a broken save path.
Fix sketch: delete, or fix the `r.ok` check before any revival. (Per repo rule 5, deletion needs explicit instruction — flagging only.)

**[S4-9] Two live renderers serve the estimate money link — only one was audited**
Where: `server/index.js:507-511` (`/estimate/:token` → `handleEstimateView`); `server/routes/estimate-public.js:7167-7209` (React only when `use_v2_view` / invoice-mode / card-hold / recurring-card forces, or a GrowthBook assignment; otherwise legacy server HTML — with a deliberate experiment holdback keeping a v1 control, 7183-7204); `GET /api/estimates/:token` always serves legacy HTML (7411)
Repro: 1. Open a customer SMS estimate link for an estimate without `use_v2_view` (or one held back by the experiment). 2. The legacy server-rendered page serves — not the React page whose journeys, error states, and double-submit defenses this audit verified.
Expected / Actual: one audited renderer on the money surface / a second, live, unaudited renderer sharing the same URL. (The fork is intentional — a v1/v2 lift experiment — so this is a scope/drift risk, not a defect.)
Blast radius: whatever share of live estimates is v1-or-holdback (needs a prod query — UNVERIFIED); those customers get a page none of this report's estimate findings or positives cover.
Fix sketch: either audit the legacy renderer separately while the experiment runs, or — once the experiment concludes — retire the SSR path and redirect `/api/estimates/:token` to the SPA route.

**[S4-10] Report review-ask sends every customer to public Google in one tap**
Where: `client/src/pages/ReportViewPage.jsx:2647-2658`; `ProjectReportEngage.jsx:195-207`
Note: inconsistent with `/rate`'s gate (S1-1) — and the flip side of it: no private path for the unhappy. Whatever the S1-1 decision is, make the two surfaces consistent.

**[S4-11] Estimate deposit "Reserve your appointment" modal Esc/cancel disabled only while submitting — fine — but express-wallet failure copy can be technical**
Where: `client/src/pages/EstimateViewPage.jsx:2252` ("A card verification is still pending on this deposit — finish it, or wait a moment and try again.")
Note: accurate but jargon-y for the audience; polish only.

**[S3-17] `/book` shows raw "Unexpected end of JSON input" to the customer when availability returns a non-JSON error** *(render-verified)*
Where: `client/src/pages/PublicBookingPage.jsx:234-235` (`const data = await res.json();` runs **before** the `res.ok` check), `:263` (`setError(err.message)` puts the parser message in the funnel banner); same parse-before-ok order in `runAiSearch` (:525-526) and `handleConfirm` (:469); contrast the safe pattern already used in `onPickDate` (:567 `res.json().catch(() => ({}))`)
Repro: 1. Open `/book`, enter an address, reach step 2 while `/api/booking/availability` returns a non-JSON body (edge/proxy 5xx, gateway timeout, dropped connection mid-body). 2. The red banner reads literally "Unexpected end of JSON input". (Reproduced in a live render with the API absent.)
Expected / Actual: "We couldn't load times right now — try again or call…" / raw JavaScript exception text in the paid-traffic funnel.
Blast radius: every availability/search/confirm hiccup that isn't well-formed JSON — precisely the moments an anxious first-time booker decides whether to retry or leave.
Fix sketch: `await res.json().catch(() => ({}))` in the three call sites (the page's own `onPickDate` pattern), with a friendly fallback message.

**[S4-12] My Property cards render a white header strip over a blue-tinted body** *(owner screenshot, cause traced)*
Where: `client/src/pages/PortalPage.jsx:5469-5521` — `PropertySection` is a `data-glass="card"` surface (the glass engine tints it) while the header `<button>` hardcodes opaque `background: '#fff'` (:5484) and the body div carries no surface of its own (:5520)
Repro: More → My Property → expand any card (HOA, Scheduling, Irrigation, Technician notes) on a device with the glass scene active. Header band stays white; label/content area shows the blue glass tint — an abrupt two-tone card.
Expected / Actual: one continuous card surface / white-on-blue banding that reads unfinished.
Fix sketch: give the header button `background: 'transparent'` (or mark the body `data-glass-clear=""`) so both halves sit on the same surface.

**[S4-13] Tier-explorer Bronze card floats its content in vertical dead space** *(owner screenshot, cause traced)*
Where: `client/src/pages/PortalPage.jsx:8033` (`minHeight: 142` on the native `<button>` tier card) — a native button vertically centers its content, so Bronze's short content (title + "Base plan" + one service line) floats mid-card with blank space above and below, while fuller Silver/Gold/Platinum cards look normal
Fix sketch: add `display:flex; flexDirection:'column'; alignItems:'stretch'; justifyContent:'flex-start'` (or drop `minHeight` on the single-column mobile layout).

**[S4-14] Preferred-time pills have no AM/PM** *(owner screenshot, confirmed in code)*
Where: `client/src/pages/PortalPage.jsx:6387-6389` — labels `'7-9' / '9-11' / '11-1' / '1-4'`
Note: "11-1" and "1-4" force the reader to infer noon-crossing; trivial copy fix (`7-9 AM`, `9-11 AM`, `11 AM-1 PM`, `1-4 PM`).

**[S4-15] Portal chrome overlap: card content scrolls legibly under the translucent sticky header, and page content peeks out beneath the floating bottom nav** *(owner screenshots)*
Where: visible in the owner's My Property screenshots (pets-note text half-hidden under the top bar; a stray content line visible below the bottom nav). Header/nav are translucent-glass surfaces; the scroll container appears to lack matching top/bottom clearance. Exact style locations for the portal shell chrome were not pinned down in code during this pass — partially verified; the screenshots are the evidence.
Fix sketch: add scroll-padding/margins matching the fixed chrome heights (plus `env(safe-area-inset-bottom)` under the nav), or make the chrome surfaces opaque enough that pass-under text doesn't read as a glitch.

---

## TOP 10 (severity, then revenue impact)

1. **S1-4** Third-party SMS enrollment without recipient consent (referrals + on-location contacts)
2. **S1-2** No durable SMS consent record anywhere
3. **S1-3** No quiet-hours floor / HELP unwired / no in-repo opt-in disclosure
4. **S1-1** Review-funnel score gating (legal/policy call for owner + counsel)
5. **S2-1** Portal cannot pay a balance; failed-payment recovery has no action — direct collections impact
6. **S2-4** Post-STOP send path bypassing suppression (estimate details packet)
7. **S2-3** Login dead-end for phones not on file — locks customers out of all self-service
8. **S2-2** Service-outline dead-end with raw HTTP status — prospect-facing lost-sale path
9. **S3-2 + S3-1** `/book` shows no price and offers no service choice — the paid-traffic funnel's conversion ceiling
10. **S3-16 + S3-15** Recurring-billing edge recovery (SCA mislabel; lost-webhook reconciliation) — small counts, but each is a paying member drifting toward pause/dunning

## UNVERIFIED

- **Legacy SSR estimate renderer journey:** estimates outside the React population (no `use_v2_view`, or GrowthBook holdback) serve the legacy server-HTML page on the same `/estimate/:token` link (estimate-public.js:7167-7209). That renderer's screens, error states, and booking flow were not audited, and the share of live estimates it serves needs a prod query. (See S4-9.)
- **Public quote wizard journey:** the marketing-site quote wizard posts into this repo's no-auth `/api/public/quote` (`POST /calculate`, public-quote.js:462 — prices, creates lead/estimate records, delivers links). The wizard UI lives in the astro repo, so the end-to-end funnel (copy, consent language at capture, error states) is not auditable here; the 1,677-line API route itself was only characterized at the entry points, not journey-audited.
- **Twilio account-level config:** whether Messaging Service "Advanced Opt-Out" answers HELP (and supplements STOP) at the account level — would partially offset S1-3. Confirm in the Twilio console.
- **Opt-in disclosure at capture:** the actual SMS-consent language shown on the marketing-site/astro forms (quote wizard, lawn assessment) lives outside this repo; its CTIA elements can't be audited here. Confirm on the spoke/hub forms.
- **Guarantee claims vs contract:** "90-day money-back guarantee" and "Unlimited free callbacks" (estimate-glass-copy.js:56) — confirm the service agreement actually grants both, for every service category the micro-line renders under.
- **`estimate_service_details` template kill-switch state** (would narrow S2-4's live exposure) — DB-driven, not visible in code.
- **`rescheduleUrl` coverage** (S3-8): what share of upcoming visits carry a token — needs a prod query.
- **Dunning behavior after a card update** (S2-1): whether the retry ladder picks up a newly-added card automatically before the next rung — billing-cron's rungs re-charge the default method, but end-to-end timing wasn't traced.
- **`bank_verification_incomplete` rendered wording** (S3-16): template body is DB-stored; only the key and its role are code-verified.
- **Real-device rendering:** partially closed by the Phase 6.5 render pass (390×844 Chromium emulation: estimate flow end-to-end, deposit modal, /book, /login, report previews — overflow, modal-clipping, and input-zoom checks all pass). Still not rendered: the **authenticated portal** (needs live API + session — the owner's device screenshots plus code tracing stand in, findings S4-12..15) and real-iOS behaviors emulation can't reproduce; size/tap findings for the portal remain source-derived.
- **Server routes for the diagnostic funnels** (`public-pest-identifier.js`, `public-lawn-diagnostic.js`): client handling verified; server expiry/rate-limit behavior not read.
- **Joi schema patterns** for referral phone validation (`referrals-v2.js` inviteSchema/submitSchema): schemas exist; exact phone-format rules weren't read.

## THREE FIXES THAT MOVE BOOKED REVENUE MOST IN ONE DAY

1. **Put "Pay now" links where balances are (S2-1).** Wire the existing `/pay/:token` checkout into the dashboard tile, Billing header, and failed-payment banner, and return a retry action after card update. Everything needed already exists server-side; this converts every in-app balance-due session and failed-payment recovery into same-day collections instead of a wait for the cron or a phone call.
2. **Give `/book` a service picker with "from $X/visit" pricing (S3-1 + S3-2).** The SERVICES catalog with descriptions is already written and never rendered; per-visit engine pricing already exists. One screen + one price line removes the two biggest silent bounces in the paid-traffic funnel — booking the wrong-service default, and handing over a phone number for an unpriced visit.
3. **Un-dead-end the two prospect-facing terminal states (S2-2 + S2-3).** Phone + retry on the service-outline error card, and "that number may not be on file — call us" after repeated failed logins. Both are copy-plus-one-conditional changes that recover sessions currently ending in a technical wall — the cheapest lost-sale patches in this report.

---

*Method note: five parallel read-only sweeps (portal, reports, SMS/consent backend, tokenized pages, billing backend) fed this report; every S1/S2 citation and each load-bearing S3 citation was re-verified against the source before inclusion. One agent claim was corrected during verification: portal inputs specified at 14px do **not** trigger iOS zoom — the global `@media (pointer: coarse)` 16px override (index.css:42-48) covers them (later confirmed live in the render pass: rule present, matching, and computing 16px). Same-day revisions: (1) Codex review corrections — the `/estimate/:token` renderer fork and the public-quote API were added to scope statements (Phase 1/2A, S4-9) and a dangling S1-5 cross-reference was fixed; (2) a 390×844 render pass and four owner-reported device screenshots added Phase 6.5 and findings S3-17, S4-12..15.*
