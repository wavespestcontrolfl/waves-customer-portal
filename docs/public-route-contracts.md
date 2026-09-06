# Public route contracts

Security contract for every route the portal serves with NO session auth
at all: token-gated customer surfaces, machine-to-machine webhooks, and
the anonymous public API. Routes behind the customer JWT (`authenticate`,
e.g. `/api/services`, `/api/schedule`) or the staff bearer are NOT public
and do not belong here. This is the list `AGENTS.md` refers to — **a new
public route outside this document is a P0**, and any change to a listed
route's auth, gate, rate limit, payload, or headers is security-critical
and must be reflected here in the same PR.

Read this when a diff touches a `server/routes/*` handler that runs with
neither `adminAuthenticate` nor customer `authenticate` in front of it, a
`server/index.js` mount, or anything under `server/services` that a
listed route calls. It is deliberately verbose:
each entry records the owner rulings and the exact guards that were argued
out in review, so a reviewer can check a diff against the contract instead
of re-deriving it.

Conventions used below: "token format gate" = a regex check on the path
token before any DB read; "generic 404" = unknown, malformed, dark-gated,
and ineligible rows are indistinguishable (no existence oracle); "privacy
headers" = `Cache-Control: no-store`, `X-Robots-Tag: noindex`,
`Referrer-Policy: no-referrer`.

## Routes

`/api/pay/:token`
(+ `/setup`, `/quote`, `/finalize`, `/confirm`, `/consent`,
`/capture-setup`, `/setup-complete`, `/update-amount`, `/error`,
`/invoice.pdf`, `/attachments/:id` — the invoice pay surface; router-wide
60/min limiter + url-safe 20-64 token format gate with generic 404,
mirroring pay-statement.js; legacy 25-32 char invoice tokens remain
valid. OWNER RULING 2026-08-16, superseding the earlier "no sibling-
invoice data on this surface" P0: with GATE_PAY_INCLUDE_BALANCE on, the
pay page ITEMIZES the customer's other open self-pay invoices — numbers,
dates, amounts, an accepted forwarded-link disclosure — and the Pay
button charges the COMBINED total via one PI carrying a per-invoice
metadata allocation (services/pay-combined.js is the one authority for
selection, allocation, and settle). Sibling TOKENS still never ride the
payload, and gate off ⇒ byte-identical to the single-invoice surface.
Off-Stripe tender block (2026-08-29; ZELLE-ONLY since 2026-09-02 — owner
ruling, Venmo and PayPal retired over their fees): the GET payload carries
an OPTIONAL `manualPayOptions` = `{ zelle: { recipient }, amountDue,
version, creditPending? }` only when `ZELLE_RECIPIENT` is set (unset ⇒ key
absent, payload byte-identical — that is the kill switch; `VENMO_HANDLE` /
`PAYPAL_ME_HANDLE` are ignored and cannot resurrect a tender) AND the
invoice is collectible, not saved-method-required, not fully covered by
account credit, not riding a combined-balance session, has no saved-card
charge reconciliation pending, and any stamped PaymentIntent is still
cancelable (inspect-only, fail-closed — unverifiable ⇒ key withheld). The
recipient is the business's own Zelle contact, never customer data. The
client re-reads this payload on expand / tab re-focus / 45 s cadence and
keeps every control disabled until a fresh read succeeds; no pre-filled
transfer link exists for Zelle, so nothing on the page constructs a
payment URL from the payload. FAQ flag (2026-09-03): with
GATE_PAY_PAGE_FAQ=true the GET payload carries `payFaq: true` — a display
flag for the copy-only "Common questions" accordion under the Pay button;
no other field changes, no customer or invoice data rides it, and gate off
⇒ key absent, payload byte-identical — unset the gate to kill it),
`/api/pay/statement/:token` (+ `/setup`, `/quote`, `/finalize`) — payer NET
statement self-serve pay, **gated behind GATE_PAYER_STATEMENTS** (404 when off),
64-hex `payer_statements.token` format gate + public-route rate limit; resolves
a `payer_statements` row (never a homeowner record), charges the PAYER's Stripe
customer only, exposes only the consolidated statement + serviced addresses
already on it (no homeowner PII/links); settlement happens via the webhook,
not the route,
`/api/receipt/:token`, `/api/contracts/:token`, `/api/booking/*`,
`/api/public/estimates/:token/ask`,
`/api/public/estimates/:token/find-slots`,
`/api/public/estimates/:token/available-slots` and `/reserve` (the recurring
service profile uses the converter's canonical stored/engine service rows.
Generated or saved tier selections replace the listed service cadences and
retain omitted companion programs; choosing a tier is not a service removal.
The existing pest-only recurring choice on eligible one-time-toggle estimates
retains its intentional companion exclusion, using the acceptance predicate.
Existing request fields, token/signature guards, rate limits and privacy headers
apply. With strict opt-in `GATE_VISIT_COMBINED_CAPACITY` and prerequisite
`GATE_SEPARATE_COMBO_VISITS`, multi-service recurring selections reserve 60 minutes
per physical service program. Termite rental and bond billing riders fold into
bait service; legacy supplements use the converter's physical-program rules.
Unsupported families/cadences, recurring foam and commercial programs return
409 `COMBINED_VISIT_UNAVAILABLE` before offering or holding combined work.
`durationMinutes` and `windowEnd` describe the whole work block; arrival copy
remains start plus 120 minutes. One assignable technician must have no selected
service capability explicitly disabled. The allocation stamp is server-owned
and excluded from public slot metadata. `/api/estimates/:token/accept` rechecks
the selection, technician and full occupancy under existing locks, then converts
the hold into separate sequential 60-minute service windows with independent
cadences. Missing or unmatched members abort the transaction. A stamped hold
retains its capacity policy when the creation gate turns off. Shared-arrival
reminder consumers use the persisted allocation, including with grouping off
or Auto Pay enabled; invoice and Auto Pay policies remain unchanged), `/api/reports/:token/*` (the
service-report V1 payload — `/data`, the PDF at `/:token`, `/map.svg`, and
the queued PDF / report-email renders that share `buildReportV1Data` —
renders the report's IDENTITY facts from the completion-time snapshot on
`service_records.service_data.reportIdentitySnapshot` when the record
carries one: `customerName`, `serviceAddress` / `propertyAddress` /
`cityState` and the `mapCenter` those resolved to, `technicianName`, the
`serviceDisplayName` title, and each application's approved product facts
(EPA number, precaution / re-entry / summary copy, approval). Records
completed before the snapshot shipped carry none and keep the live
customers / scheduled_services / technicians / products_catalog joins; a
snapshot leg that could not be frozen (missing customer or technician row)
is omitted and that leg stays live. The PDF filename and the canonical lawn
pin read the same overlaid row. Presentation (technician photo URL, copy
config) and the deliberately live sections (next visit, review CTA,
cross-sell) are unchanged. `services/service-report/report-identity-snapshot.js`),
the SPA `/recap/:token` "Your Visit, in Motion" recap player (token-gated; serves
only an approved recap, consumes `/api/reports/:token/recap` + `/recap/video`,
same noindex/no-referrer/no-store headers as `/report/:token`),
`/api/stripe/webhook`, `/api/webhooks/twilio` (all Twilio inbound),
`/api/webhooks/twilio/collections-vestibule[-key|-noinput]` +
`/api/webhooks/twilio/collections-relay-complete` +
`/api/webhooks/twilio/collections-transfer-complete` +
`/api/webhooks/twilio/collections-call-status` (POST; machine-to-machine
TwiML webhooks for the OUTBOUND collections voice lane — Twilio-signature
validated at the mount like every Twilio inbound route, and additionally
fail-closed to a bare `<Hangup/>` unless `GATE_VOICE_LATE_PAYMENT` is exactly
'true' AND the `callLogId` query param resolves to a call_log row this lane
itself originated (direction 'outbound', source 'collections_voice', a linked
collection case) whose CallSid matches the request. The vestibule is a FIXED
DTMF consent stage: deterministic script, `<Gather input="dtmf">` only, no
ConversationRelay/recording before press-1 — no call audio ever reaches
Waves systems pre-consent — and metadata-only logging before consent. The
ONE documented exception: Twilio's carrier-side AMD classification
(`machineDetection: DetectMessageEnd`) runs before the vestibule and
returns only a label (human/machine), never audio — a deliberate,
counsel-review-before-flip item (DECISIONS-PRB #13), required so machine
answers route to the capped generic-callback voicemail instead of playing
the consent script to an answering machine. Press-1 renders `<Connect><ConversationRelay>` to the
existing `/ws/voice-agent` endpoint with a per-call minted token and a
`session_mode=collections` Parameter — which the ws server treats as an
UNVERIFIED hint and re-proves against the same call_log row before any
account data exists in the session. Treat the gate, the call_log linkage
check, and the no-audio-before-consent contract as security-critical.
Dials originate from exactly two surfaces (PR C), both funneling through
`originateCollectionCall` — the single authorization boundary that
re-runs the full contact policy at dial time: the admin-only
`POST /api/admin/communications/collections-cases/:id/dial` (supervised
single dial, requireAdmin, master-gated) and the auto-dial cron sweep
behind `GATE_VOICE_LATE_PAYMENT_AUTODIAL` (which requires the master AND
`GATE_COLLECTIONS_POLICY` gates; autodial gate off = zero reads from the
SWEEP, pinned — the scheduler tick then runs only the master-gated
expired-approval reclamation, and a fully dark master = zero touches;
bounded
by `COLLECTIONS_AUTODIAL_MAX_PER_RUN`, default 2, hard ceiling 10). A
diff adding any OTHER path to `originateCollectionCall`, weakening the
guarded promote fences (state + case_version), or letting the sweep make
its own eligibility judgments is a P0),
`/api/bouncie` + `/api/webhooks/bouncie`, `/api/webhooks/sendgrid`,
`/api/webhooks/resend` (Svix-signed), `/api/webhooks/lead`
(+ `POST /api/leads`, an alias accepting the same pair with identical
semantics; both also accept an OPTIONAL `timeline` — the visitor's own
"when do you want this handled?" answer, `now` | `this_week` |
`this_month` | `browsing` plus the form aliases in
`server/services/lead-timeline.js`; stored verbatim in
`extracted_data.timeline`, mapped onto `leads.urgency`, and it WINS over
the AI triage's urgency guess; unknown values are ignored, never guessed),
`/api/public/newsletter/*` (subscribe, confirm, unsubscribe, posts,
posts/by-slug/:slug, rss, quiz/:token/:quizId/:answer,
feedback/:token/:reaction, e/:token/:eventId (event click-through:
records one deduped analytics row then 302s to the DB-locked event
URL; unknown token = untracked redirect, never blocks the reader)
— rate-limited, read-only for posts/rss,
double-opt-in for subscribe; the quiz and feedback tokens are the same
per-recipient uuid `engagement_token` (newsletter_send_deliveries) — GET
renders a confirm page only and the delivery-row write happens on a
deliberate POST form submission (scanner-safe, mirrors confirm), answer/
reaction keys validated against the server-side config allowlists
(newsletter-quiz.js / newsletter-feedback.js), 30 req/min per IP, always
returns 200 so it can't probe which tokens/answers are real),
`/api/public/prep/:token` (32-hex token format gate,
60 req/min rate limit, privacy headers `no-store`/`noindex`/`no-referrer`,
filters email-only blocks, server-side interpolation, generic 404; the
ONLY writes are its own view analytics, all after a successful render —
for a scheduled-service token the visit's `prep_view_count` /
`prep_first_viewed_at` stamp is fenced on the rendered template key (a
miss = the key moved, so the page re-resolves and renders the new guide),
which pairs with the manual prep sender's re-key / release fence on those
view columns so an opened page never changes guide or 404s behind the
customer; the `prep_guide_views` log row follows; response shape
unchanged),
`/api/public/prep/:token/pdf` (downloadable PDF twin of the prep page —
action-bar Download parity with service reports; same 32-hex token format
gate, same 60 req/min limiter, same privacy headers, generic 404; payload
is the SAME interpolated guide blocks plus customer name + service
address + technician first name/name — never email or phone (owner PII
ruling 2026-07-13); filename sanitized server-side before
Content-Disposition; no view-analytics writes on this route),
`/api/public/price-change/:token` (price-change notice page data;
32-hex token format gate, 60 req/min rate limit, privacy headers
`no-store`/`noindex`/`no-referrer`, generic 404; payload is first name +
the price change only — no address/email/PII; view counted for the
delivery record),
`/api/public/products` (read-only export; returns only active +
customer_visibility=public + content_status=approved_for_public products;
excludes pricing, vendor, SKU, dilution, MOA, inventory fields),
`/api/service-outlines/:token` (approved/sent/viewed packets only,
43-char base64url token format gate, 60 req/min read limit, 120 req/min
CTA telemetry limit, privacy headers `no-store`/`noindex`/`no-referrer`,
generic 404 for missing, draft, revoked, or malformed tokens),
`/api/public/estimates/:token/deposit-intent` (RETIRED VERDICT STUB —
owner ruling 2026-08-10: acceptance deposits are permanently
not-enforced. Token format gate + deposit rate limit, then an
unconditional 409 `{ exemptReason: 'deposits_retired' }` — the accept
client consults this after a non-superseding card/hold 409 and reads a
409-with-exemptReason as "nothing owed"; no PaymentIntent, no Stripe
call, no DB write. `/deposit-quote`, `/deposit-finalize`, and
`/deposit-reset` carry the SAME verdict stub — a 409 with exemptReason
is exactly what their kill-switch check returned while the flag was
off, so the retirement preserves the live contract for any stale open
page. The
deposit LEDGER — credit roll-forward, void-restore, refunds, webhook
recording — stays for the 2026-06/07 historical rows; the 2026-07-13
surcharge ruling and 2026-07-05 commercial-prepay exemption remain the
ledger's interpretation rules for those rows.)
`/api/public/estimates/:token/card-hold-intent` (one-time card-on-file
hold; estimate token format gate, generic 404, 10 req/min limit,
terminal/expired rejection, mirrors the accept-time quote + one-time
availability gates, 409 for exempt policies, customerless SetupIntent
with metadata-pinned purpose/estimate id, NO money captured at booking —
the saved card is charged on completion and a flat no-show fee only;
dark behind ONE_TIME_CARD_HOLD).
`/api/public/estimates/:token/recurring-card-intent` (recurring-accept
Auto Pay card per docs/card-on-file-booking-build-spec.md — card to book,
deposit retired, charge on completion only; estimate token format gate,
generic 404, 10 req/min limit, terminal/expired rejection, mirrors the
accept-time quote gate, 409 for exempt policies — one-time / invoice-mode
/ prepay-annual / existing plan member / payer-billed / already-on-Auto-
Pay / saved consented card (auto-satisfy: existing customers are never
re-asked) — customerless SetupIntent with metadata-pinned purpose
`estimate_recurring_card`, NO money captured at booking; accept-time
enrollment (consent row + enrollConsentedMethod) turns on Auto Pay so
completed applications auto-charge, capped at the accepted per-visit
amount (above-quote invoices route to office review instead of
auto-charging); dark behind RECURRING_CARD_ON_FILE, and
ESTIMATE_DEPOSIT_REQUIRED is unset only AFTER this lights.
Response carries `paymentMethodTypes` (`['card']`, or
`['card','us_bank_account']` behind GATE_ACCEPT_ACH_CAPTURE — bank with
INSTANT verification only, never micro-deposits; card-only for an existing
customer whose `customers.ach_status` is set and not `active`, and on any
ach_status lookup failure). The accept-time verify re-resolves the same
tender policy and refuses a captured bank method (402
RECURRING_CARD_REQUIRED → the client re-mints card-only) once the gate is
off or the customer's ACH state is unhealthy, so a previously minted
bank-capable intent cannot outlive the kill switch. The one-time
card-hold-intent route above stays card-only regardless).
`/api/estimates/:token/service-details/:serviceKey/pdf` (read-only
per-service details-packet PDF for the estimate view's "full details"
buttons; live by default, kill switch GATE_SERVICE_DETAILS_PDF=false —
404 when off; estimate
token format gate, generic 404, isEstimateCustomerViewable gate identical
to `/:token/data` (drafts/expired/send_failed 404 — even for staff, so a
draft can never produce a customer-facing document), serviceKey must be
BOTH a known guide key and a recurring service actually on this estimate,
60 req/min limit, `no-store`/`no-referrer` headers; the PDF contains the
service guide plus PUBLIC product-registry fields only — active
ingredient, EPA reg no., label/SDS links — never pricing, vendor, SKU,
dilution, or inventory data).
`/api/estimates/:token/warranty-comparison/pdf` (read-only termite
buy-vs-rent options sheet; dark behind GATE_TERMITE_COMPARISON_SHEET —
404 when off; same token format gate + generic 404 +
isEstimateCustomerViewable contract as the service-details PDF above;
content is two deterministic pricing-engine replays of the estimate's own
saved inputs (ownership toggled) plus the bond-term snapshot — the
builder is fail-closed, so a config where the rental cannot actually
price 404s instead of rendering a one-column comparison; 60 req/min
limit, `no-store`/`no-referrer` headers; no product-registry, vendor, or
cost data — customer-priced figures only).
`/api/estimates/:token/service-details/send` (write; emails or texts that
same packet to the contact info ALREADY ON the estimate — the destination
is NEVER caller-supplied (body carries only `service` + `channel`), so
the token cannot be used to spray documents at arbitrary addresses; same
gate-404 + token format gate + customer-viewable + service-on-estimate
checks as the GET, 6 req/hour limit, email sends idempotent per
estimate+service+day, suppression-blocked addresses return 409 with no
send, generic errors — no PII in responses or logs; while
GATE_SEND_REQUIRES_SERVER_PRICING is on, a row or group link that fails
the engine-pricing-authority verdict (#3750) answers the same generic 404
before either provider path; both provider paths re-read the row and repeat
the customer-viewable + call-side-hold check as the LAST step before the
SendGrid/Twilio handoff, so a clarify hold or archive that lands during the
PDF render withholds the packet with the same generic 404 and releases the
SMS dedup claim so a later legitimate retap can send).
`/api/estimates/:token/bond` (PUT; customer bond-term switcher on the
estimate page — same contract family as the service-preferences toggles.
Token IS the auth: slug-or-64-hex format gate rejects malformed probes
before any DB read, and the 404 is generic — unknown token, malformed
token, and non-active rows (draft/archived/expired/locked) are
indistinguishable, so a leaked inactive token never confirms a row
exists. Dark behind GATE_TERMITE_BOND_OPTION (off → uniform 403
`bond_option_disabled` before any DB read, and the 30/hr per-IP limiter
— shared /64-collapsing `rateLimitKey` — `skip`s while dark so probes
never see a revealing 429). Mutates ONLY the termite-bond selection:
the requested term must exist in the estimate's own QUOTE-TIME
`bondOptions` snapshot (never live constants — invalid/absent fails
closed 400), the rewrite adjusts rows + totals by the exact snapshot
deltas, and the update is TOCTOU-guarded exactly like /preferences
(accept-active pre-check re-asserted in the UPDATE's whereNotIn +
`price_locked_at IS NULL`, 409 on a lost race) so a concurrent accept's
frozen price can never be overwritten. Rollback = unset the gate (route
dead-ends; already-selected bonds are sold state and keep billing as
quoted).)
`/api/estimates/:token/extension-request` (POST; one-click "my link
expired, I still want this" from the React estimate page's expired/
not-found screen. Estimate token format gate (same slug-or-64-hex regex as
the slots router), generic 404 — unknown token, malformed token, ineligible
row, gate-off, and (while GATE_SEND_REQUIRES_SERVER_PRICING is on) a row or
group link that fails the engine-pricing-authority verdict (#3750; judged
before the auto-grant claim, nothing burned) are indistinguishable — 5
req/hr per-IP limit, dark
behind GATE_ESTIMATE_EXTENSION_REQUEST (the rate limiter `skip`s while the
gate is off so a dark probe sees only generic 404s, never a revealing 429,
and keys via the shared /64-collapsing `rateLimitKey`). Eligibility
requires a PUBLISHED estimate (sent_at/viewed_at set — the expiration
sweep flips never-sent drafts to 'expired' too, and those must never
qualify) that is past expires_at or sweep-expired, not
accepted/declined/archived. Concurrency: the 24h dedupe stamp and the
lifetime auto-grant burn live in DEDICATED estimates columns
(`extension_requested_at` / `extension_auto_granted_at`, migration
20260711000001 — never estimate_data, whose full-blob writers could erase
jsonb stamps and un-burn the cap), claimed by one atomic conditional
UPDATE so concurrent POSTs can't fan out duplicates. First request per
estimate AUTO-GRANTS a 7-day extension via the shared
services/estimate-extension.js core (same expiry anchoring, status
revival, `estimate_extended` SMS, and `estimate.extended` email as the
admin extend route — consent/opt-out/Twilio-gate enforcement inside
sendCustomerMessage, suppression/dedupe inside the email template
library; post-write SMS/email plumbing never throws; the write is guarded on the
snapshot's status/archived_at and never moves an expiry backwards, 409 on
conflict; LIVE 'sending' claims are refused — only date-expired stale
ones extend), burned ATOMICALLY in the same claim UPDATE before any
mutation. Failure handling is fail-closed: provably pre-write errors
(400/409) release both stamps; ambiguous errors keep the BURN but release
the dedupe stamp so a retry reaches the notify-office path instead of a
false alreadyRequested. Repeat requests fall back to notify-office-only.
Every path raises an in-app admin notification (the auto-grant alert
retries once and error-logs on double failure; the notify-only path
treats the notification as the deliverable and releases its claim + 500s
when it can't persist); response carries only
success/autoExtended/expiresAt/smsSent/emailSent — no PII),
`/api/public/lawn-diagnostic/:token` (read-only prospect lawn report;
32-hex token format gate, 60 req/min rate limit, privacy headers
`no-store`/`noindex`/`no-referrer`, only `status='sent'` and unexpired
diagnostics, strictly whitelisted customer-safe payload — no internal
scores, raw AI, product names, label constraints, reconciliation/QA
internals, or tech notes — generic 404 for missing/draft/expired/malformed),
`/api/public/lawn-diagnostic/:token/quote-request` (write; same token gate
+ sent/unexpired requirement + generic 404, 10 req/min limit, strict body
validation before coercion — name plus a valid email or phone — links one
lead per diagnostic via an atomic `whereNull('lead_id')` guard returning 409
on repeat, no raw PII logging, never mutates diagnostic scoring or any
customer/assessment table).
`/api/public/lawn-assessment/analyze` (write; prospect lawn-photo upload for
the wavespestcontrol.com lead-magnet funnel — no auth, no token. Paid
dual-model vision per accepted request, so it carries the full abuse triad:
entire surface 404s unless GATE_LAWN_ASSESSMENT is on, honeypot drop,
Turnstile verified and enforced with GATE_LEAD_TURNSTILE, 5 req/hour per-IP
in-route limit plus the shared 40/day photoAssessmentDailyLimiter at mount,
≤5 photos with per-photo size cap. Persists a `lawn_diagnostics` row
(mode=prospect, source=public_funnel) via the SAME shared analysis ladder as
the tech flow; the response is a TEASER ONLY — a strict subset of the public
report egress allowlist (status label, one gated finding, counts) plus a
32-hex claim token. The full report payload never leaves the server before
claim. Prospect free-text note is stored for admin view only — never fed to
models or customer copy. Privacy headers on all responses.)
`/api/card/:token` (read-only digital business card payload; 64-hex
`customer_cards.share_token` format gate, generic 404 for unknown/malformed
tokens and archived/merged customers, 60 req/min per-IP read limit on top of
the global /api limiter, `Cache-Control: private, no-store`; payload is a
strict whitelist — customer FIRST NAME + member-since year +
has_left_google_review flag only, tech name + presigned photo, office
phone, the tracked /l review short-link, and the customer's referral link
(share never exposes the card token) — no address, email, or phone PII;
the SPA shell `/card/:token` carries the same noindex/no-referrer/no-store
headers via sensitive-spa-headers.js),
`/api/card/:token/contact.vcf` (read-only Save-contact vCard; same 64-hex
token gate + archived-customer 404 + rate limit + `no-store`; contents are
COMPANY-ONLY — tech name/title, office line, company email/site/address,
license line — never customer data),
`/api/card/:token/wallet.pkpass` (read-only signed Apple Wallet pass; same
64-hex token gate + archived-customer 404 + per-route rate limit +
`no-store`; 404s whenever the PASS_* signing env vars are unset (config
self-gate — the card payload's walletAvailable mirrors it so the button
never renders a dead tap); pass carries customer FIRST NAME + member-since
year only — NO home coordinates, NO next-visit date (static pass, no
update plumbing), review QR falls back to the card link for
has_left_google_review customers).
`/api/public/lawn-assessment/:id/claim` (write; contact capture that unlocks
the full report — same gate-404 + honeypot + privacy headers, 10 req/min
limit, UUID + 32-hex claim-token format gates with generic 404 so tokens
can't be probed, strict body validation before coercion — name plus a valid
email or phone. Creates ONE lead per assessment inside a transaction with an
atomic status+`whereNull('lead_id')` guard (409 on replay), mints the
30-day report token served by `/api/public/lawn-diagnostic/:token`, and
stores a server-computed pricing snapshot from the pricing engine (size-band
basis, engine-authoritative — pricing failure never blocks the claim). After
the claim commits it best-effort inserts ONE ad_service_attribution funnel
row (lead_source=lawn_assessment, is_paid=false, idempotent on the unique
lead_id index) so the magnet reports in funnel-by-source like every other
channel. Optional `attribution` body is sanitized/allowlisted
(sanitizeAttribution) into leads.extracted_data + the row's click-id/utm
columns — first-touch evidence only, never a channel/is_paid reassignment.)
`/api/public/pest-identifier/analyze` (write; prospect pest-photo upload —
exact mirror of `/api/public/lawn-assessment/analyze` behind
GATE_PEST_IDENTIFIER, writing `pest_identifications`. Customer-visible copy
comes ONLY from the fixed PEST_LIBRARY allowlist in
services/pest-identification.js — model output never reaches a prospect, and
low-confidence/conflicting IDs degrade to generic category labels.)
`/api/public/pest-identifier/:id/claim` (write; mirror of the lawn claim —
same one-shot lead+token transaction, 409 on replay, same best-effort
ad_service_attribution row (lead_source=pest_identifier), typical-home
pricing snapshot only for engine-priceable service lines; termite/rodent/
bed-bug style IDs stay inspection-first with fixed suggestive-only copy that
must never read like a WDO/confirmed finding.)
`/api/public/pest-identifier/:token` (read-only tokenized pest report;
same contract as `/api/public/lawn-diagnostic/:token` — 32-hex format gate,
60 req/min, privacy headers, only sent/unexpired rows, strictly allowlisted
payload via buildPublicPestReport, generic 404, plus a set-once
`report_first_viewed_at` funnel stamp. Deliberately NOT behind
GATE_PEST_IDENTIFIER: sent reports are owner-initiated communications
(admin manual send works pre-launch), and an invalid token 404s exactly
like the dark surface — only analyze/claim are gated.)
`/api/public/pest-forecast` (+ `/pest-forecast/locations`) (read-only,
no auth, no DB writes, no PII — returns a deterministic Florida
pest-pressure model keyed only on a curated city slug / FL ZIP plus
public NWS + FAWN weather; no request body. Intentionally CORS-open
(`Access-Control-Allow-Origin: *`) so the free embeddable forecast
widget can run on third-party domains; inherits the global `/api/` IP
rate limit, served from a 3h per-location server cache and public CDN
`Cache-Control`. Note: unlike the token-gated read routes, this surface
is deliberately cacheable and indexable — it exposes only modeled,
non-sensitive forecast data, so `no-store`/`noindex` privacy headers do
NOT apply here).
`/api/public/ui-flags` (read-only, no auth, no token, no params, no DB
access, no PII — returns only client release-switch booleans (currently
`{ portalGlass }` from the GATE_PORTAL_GLASS feature gate) so the portal
SPA shell and login page, which have no per-page token payload, can learn
a glass release. `Cache-Control: no-store` so gate flips propagate on the
next page load; inherits the global `/api/` IP rate limit. Invariant: this
surface must never grow beyond boolean/enum release flags — anything
per-customer, secret, or configurable belongs on an authenticated payload).
`/api/public/social-feed` (read-only aggregate of already-public social
posts for the marketing /social page — Instagram + Facebook Graph API,
Google Business Profile localPosts, YouTube channel RSS; no tokens, no
PII, returns only public post metadata
(caption/thumbnail/permalink/timestamp), 60 req/min rate limit, 15-min
in-memory cache + 5-min public Cache-Control, per-source graceful failure,
never 500s — returns an empty payload on total upstream failure).
`/api/public/estimator/property-lookup` (write; unauthenticated lead-capture +
parcel lookup for the estimator — no auth, no token, 5 req/hour rate limit.
REQUIRES and stores customer PII — first name, last name, email, phone, and
address — into `leads`, and returns county parcel facts. Treat as a
PII-accepting public endpoint: scope any change to what it stores or logs.
Also accepts an OPTIONAL `prefill_lead_id` + `prefill_token` pair — the
lead-prefill HMAC below — which, when valid, makes the lead capture UPDATE
that existing open call-pipeline lead instead of inserting a new row; the
same pair is accepted by `/api/webhooks/lead` and its `/api/leads` alias
with identical semantics. Also accepts the OPTIONAL `timeline` described
under `/api/webhooks/lead` above, with the same storage and urgency
semantics; it survives the later `/api/public/quote/calculate` snapshot).
`/api/public/estimator/lead-prefill` (POST exchange, read-only semantics;
swaps the voicemail text-back link's `lead_id` + HMAC token for that ONE
lead's own contact fields — first/last name, email, phone, address, city,
zip, service_interest — so the /estimate quote wizard arrives prefilled.
Token is minted ONLY by the voicemail-lead SMS
(`utils/lead-prefill-token.js`):
`<expEpochSec>.<base64url(HMAC-SHA256("lead-prefill:<leadId>:<exp>"))>`,
14-day TTL, keyed on `LEAD_PREFILL_SECRET` (falls back to `JWT_SECRET`),
constant-time compare, fail-closed when no secret is configured. The token
is a bearer credential and stays OUT of URLs end-to-end: the SMS link
carries it in the /estimate URL FRAGMENT (never sent to the server, never
in Referer), the client scrubs it from the address bar at mount and strips
it from attribution landing_url, and the exchange is a POST body — never a
query string — so it can't land in morgan/Railway request logs. UUID
format gate on lead_id, 30 req/hour rate limit, privacy headers
`no-store`/`noindex`/`no-referrer`, and a generic 404 for invalid, expired,
mismatched, or unknown ids — indistinguishable on purpose (no oracle).
PREFILL/attach authority ONLY: it returns the contact data we already
texted the link-holder about, and is never accepted as identity or pricing
authority on any money path).
`/api/public/quote/calculate` (+ `/api/public/quote/upsell`) (write; public
instant estimate via the pricing engine — no auth, no token, 10 req/hour rate
limit. Persists a quote/lead and may text the quote via a Twilio short-link;
returns pricing only. Request shape: either `services` keyed by the engine
keys in `PUBLIC_QUOTE_SERVICE_KEYS` (`routes/public-quote.js`) or a catalog
`serviceKey` / `service_key` from the `/api/public/services/menu` payload,
which expands SERVER-SIDE via `quoteServicesForKey` — the posted body can
only add the site-collected options `mergeKeyedRequestOptions` allows
(today: the lawn grass `track`, forwarded into `lawn` AND
`lawnPestControl`). Service-menu phase 2 (2026-09-03) widened the instant
set by two keys: `oneTimeMosquito` (menu `mosquito_one_time`; priced by
treatable lot area; station / dunk add-ons are staff-scoped and never
site-selectable) and menu `lawn_pest_knockdown` → `lawnPestControl`
(turf-priced on the forwarded track; a lot-only lookup routes it to manual
review like the lawn programs). Catalog `cockroach_control` → `pestInitialRoach`
(owner ruling 2026-09-03: the two-treatment package priced as one
regular_standalone knockdown on the home footprint; species / severity /
price override stay staff-scoped, the site prices the native scale; the
included second visit is booked at completion at no charge). It prices
instantly but never mints a self-book slot (`bookingUrl` null, like bed
bug): the self-book funnel collapses it to the generic pest visit with no
catalog `service_id`, which the included second visit's scheduling needs —
the owner books the first visit. Instant eligibility also requires the live
`regular_standalone.treatments` display count to still read 2 — read from the persisted `pricing_config`
row itself (never process-local engine constants), on the menu build, on
the first eligibility read, and again immediately before the engine. The engine input freezes `packageTreatments: 2` and
`catalogServiceKey: cockroach_control` on the request, so the stored draft
regenerates the two-visit promise on every send / view and the accepted
visit resolves `service_id` by that exact key. All three are
additive — no existing key or response field changed. **Menu `flea_tick` changed product on 2026-09-03**
(owner ruling "flea is two visits"; PR #3845): the keyed request now
expands to the two-visit Flea Elimination Package (`flea_package`, 2
visits, conditional retreat guarantee) — previously the single-visit
knockdown. The retired `services.flea.offerKey = flea_knockdown_single`
is still accepted on the direct-`services` shape, but the engine prices
the package and routes the line to manual review
(`flea_single_visit_offer_retired`), so a stale caller gets a review
response, never an instant two-visit price it did not ask for. A
site-collected `services.flea.fleaComplexity` (`light` / `moderate` /
`heavy`) is forwarded on both shapes; absent, the package prices at the
base (light) rate. Lot-priced keys (`mosquito`, `oneTimeMosquito`,
`treeShrub`) park as `lot_size_requires_verification` when the lookup
flagged the lot verify-first; the response is then a manual quote, never a
price built from the synthetic sqft×4 fallback. Every mosquito line
(`mosquito`, `oneTimeMosquito`, commercial) goes one step further: the
engine line itself routes to review whenever the route passes
`lotSizeMeasured:false` (lookup miss, or a direct-API lot posted without
`lotSizeConfirmed`) — a mosquito price is only ever built from a
lookup-measured or customer-confirmed lot (owner ruling 2026-09-03; the
recurring program joined this contract then, so a direct-API caller that
posts an unconfirmed `lotSqFt` with `mosquito` now receives a manual
quote where it previously received a price)).

Repeat-run dedupe (#3834 split, PR A′; DARK behind `GATE_WIZARD_LEAD_DEDUPE`,
read at call time, default off in every environment — off, every run
files as `new` exactly as before): a tokenless `/calculate` whose typed
email AND phone AND quoted address AND service (catalog `serviceKey`, or
the normalized service-mix label for the direct `services` shape) equal an
OPEN `quote_wizard` lead's (`OPEN_LEAD_STATUSES`) created inside 30 days,
with no additional properties on either side and a live courtship (no
FK-linked estimate that is declined, expired or archived, and the LATEST
mirrored `estimate_data.lead_id` estimate, if any, is open), is filed as `status = 'duplicate'` carrying
`extracted_data.duplicate_of_lead_id` = that original's id, instead of a
second `new` lead. The token path (`leadId` + email) re-runs the exact
predicate against its OWN row, excluding itself and looking only back
(older rows), so the label lands, moves or clears on THIS row — scoped to
the status and typed identity the request read; a relabel that hits 0
rows follows the row as it now is. A row that just filed as a repeat
drops its own lead-stage `ad_service_attribution` row and the root's row
is rebuilt when missing. Label ONLY: the route never selects, updates or
reads the original for anything but re-validating the chosen target; the
marker grants no access (a typed contact is not ownership evidence), the
draft estimate stays mirrored to the run's own row, and `/upsell` reaches
only the authenticated lead's draft. Resolving a repeat to its root at
estimate acceptance / self-booking is PR B′ (services, not this route).
Kill switch: unset the gate — rows already labelled keep their marker.
`/api/public/ai-intake` (`GET /status` + `POST /message`) (the Ask Waves
marketing-site chat brain — no auth, no token, **gated behind GATE_ASK_WAVES**
(503 when off; fails closed in prod). Rate limits: 30 req/15min in-route on
/message + a 120 req/day per-IP cap at the mount scoped to plausible POST
/message bodies only (paid-LLM surface, same rationale as
paidEstimatorDailyLimiter; GET /status, non-POST probes, gate-off probes,
and empty/oversized bodies are all LLM-free — they 503/400 without spending
the cap, so shared-IP noise can't lock out real chat turns). PII contract:
requires NO PII and
asks for none — visitor free-text + client-echoed history (both length- and
turn-clamped, roles allowlisted) is sent to the LLM and logged best-effort to
agent_sessions/agent_messages (channel `ask_waves`); treat message content as
untrusted input, never as identity. HARD INVARIANT: this surface can never
emit a price — prompt rule + PRICE_TALK_RE post-scrub + no pricing endpoint;
the chat's quote step posts to the existing `/api/public/quote/calculate`
above, which owns the four-field contact gate, lead minting, and attribution.
All deterministic guards (price scrub, emergency + account-support fallback
when both LLM providers miss) read English AND Spanish — the prompt answers
Spanish visitors in Spanish. NOT CORS-open — credentialed allowlist origins
only (hub site)).
`/api/public/experiments` (`GET /status` + `POST /exposure`) (client-side
GrowthBook experimentation surface — no auth, anonymous visitors are the
unit. **POST /exposure is gated behind GATE_GROWTHBOOK** (404 when off) with
a 30 req/min per-route rate limit on top of the global limiter. Invariants:
strict shape validation (experiment/unit/variation regexes, scalar-only
value clamped to 100 chars); the experiment key must be a currently-live
tracking key in the cached GrowthBook feature payload; SERVER-owned
experiment keys (`estimate-view`, `booking-abandon-recovery`) are ALWAYS
refused — server-side sticky replay trusts `experiment_exposures`, so a
public post must never be able to pre-assign a real unit's arm;
`unit_type='anon'` + `metadata.source='client'` are forced server-side; the
response is 204 for stored AND dropped posts (no experiment-enumeration
oracle); the first-exposure-wins unique constraint dedups repeats. No PII —
anonymous visitor id only. The rate limit is scoped to gate-ON /exposure
posts — gate-off probes always see the 404 without spending it, and
`GET /status` is limiter-free (kill-switch probe must never starve).
`GET /status` returns only `{enabled}` (boolean, never 404s) = master gate
AND server feature-cache warm — the client SDK fetches feature definitions
only after it says enabled, which is what makes unsetting GATE_GROWTHBOOK a
real rollback for client experiments too (and keeps clients dark while the
server can't validate exposure keys)).
`/api/public/services/menu` (read-only catalog-derived product menu the
website quote form renders from — no auth, no token, no params, no PII.
Mounted at `server/index.js` → `routes/public-services-menu.js`; payload is
`{ generated_at, items }` from `services/public-services-menu.js`, served
with `Cache-Control: public, max-age=300` on success and `no-store` on
error; inherits the global `/api/` IP rate limit. Consumed by the Astro
quote form, so its item shape is a spoke-fleet contract per CLAUDE.md
rule 18 — additive changes only).
`/api/public/service-areas` (read-only canonical SWFL city list — no auth, no
token, public `Cache-Control`. Consumed by the Astro build and the admin blog
UI; no PII).
`/api/public/pricing-ranges` (read-only engine-derived per-service price
ranges — no auth, no token, public `Cache-Control`, no side effects, no PII.
Ranges are computed from the live pricing engine (DB-authoritative
pricing_config) so the published numbers cannot drift from admin-edited
pricing; owner ruling 2026-08-06 approved publishing ranges for all
residential services. Consumed by the Astro build for the agent-readable
/pricing.md surface and directly by AI agents. Exact per-property pricing
stays on POST /api/public/quote/calculate).
`/api/public/credentials` (+ `/api/public/credentials/:slug`) (read-only
canonical FDACS / license / insurance numbers — no auth, no token, public
`Cache-Control`. Consumed by the Astro content build; intentionally public
business credentials).
`/api/public/automation-preview/:stepId/:token` (read-only; renders an
automation step's HTML body with SAMPLE merge values only — no real customer
data — for operator preview/share. Token in path, `noindex`).
`/l/:code` (short-link resolver for every customer-facing short URL — 302 to
target / 410 on expired / generic 404 with no enumeration leak; `noindex`;
mounts OUTSIDE the global `/api/` limiter so it carries its own 120/min
per-key limiter; new codes are 10 chars ≈ 49.5 bits since 2026-08-07,
legacy 5-char codes still resolve).
`/r/:code` (referral click-track + redirect to the marketing site; also
OUTSIDE the `/api/` limiter — carries its own 30/min limiter and a
url-safe 4-32 code format gate before any DB read; every hit below the
gate writes a `referral_clicks` row, malformed/unknown codes redirect
home without touching the DB).
`/api/estimates/:token` core family (GET view + `/data`, PUT `/accept`,
`/decline`, `/select-tier`, `/preferences`, POST `/bundle-inquiry`, GET
`/pdf` — the customer estimate surface behind every estimate link.
Router-wide url-safe 15-64 token param gate (generic 404, prod-verified
against all live tokens 2026-08-07); accept/decline carry a 10/hr
limiter — the two heaviest public money-adjacent writes; select-tier/
preferences ride estimateToggleLimiter, data/pdf ride dataLimiter).
`/accept` fails CLOSED when the accepted plan's money cannot be resolved
(#3751): 409 `{ error, code }` with nothing booked and call-the-office copy
— `PER_APPLICATION_ADD_ON_UNPRICED` (an established per-application
customer adding a unit whose per-application price cannot be derived),
`LEGACY_MONTHLY_TERMITE_UNCONVERTIBLE` (an in-flight count-less termite
quote whose card discloses monthly installments — re-issued by the
office, never converted against its card), and
`INVOICE_MODE_PER_APPLICATION_UNRESOLVED` (an invoice-mode recurring
accept with no resolved per-application amount — never the monthly
display rate). Same contract via the admin manual-acceptance path, which
preserves these 4xx verbatim.
Overlapping annual coverage on public `/accept` returns 409
`{ error, code: 'ANNUAL_PREPAY_OVERLAP' }` with the existing call-the-office
explanation and no acceptance committed. Clients preserve the appointment
selection and display that billing conflict instead of a slot-taken message.
A clarify RE-PRICE HOLD (`estimate_data.estimatorEngine.reprice_pending_at`
non-empty — stamped by `estimate-clarify-asks` when a customer's unit or
bedroom reply proves the row's address or dollars stale; lifted only by the
operator's revision / proposal save or by the replacement draft's supersede
archive) takes the row out of the customer surface for as long as the
marker is on the row, whatever the row's status becomes afterwards. The
marker is stamped on UNSENT rows only (draft / scheduled / send_failed /
sending — a delivery that has not published yet); a building-level quote
staff already SENT before the customer's reply is NOT retracted by this
mechanism (the office is belled and the unit lands on the CRM record; an
automatic retract-and-replace is the C2b follow-up). While the marker is on:
the GET view (React `/data`, the legacy SSR page, `/pdf`, the slots
routes, every `isEstimateCustomerViewable` consumer) answers the same
generic 404 as an unknown token, and the two writes refuse with 409
`{ error: 'This estimate is being re-priced — please try again in a few
minutes' }` — `/accept` inside its locked read, `/decline` at the
guard AND on the UPDATE's own predicate (a hold landing between the two
parks the decline on that 409, never a stale 'declined' terminal); the
pricing mutations (`/select-tier`, `/bond`, `/interior-service`,
`/service-opt-out`, `/preferences`) and the ask endpoint treat a held
row as not accept-active / not answerable at the pre-read, and the five
mutations predicate their whole-blob writes on the marker's absence, so
none of them can overwrite the hold off the row; `/extension-request`
treats a held row as ineligible (the generic 404), and the auto-grant
claim, the notify-only claim, the guarded expiry write, and the sibling
revive all carry the marker predicate — a hold that lands after the
eligibility read never burns the grant, texts a link the renderer
refuses, or pages the office with a 201 (the zero-row claim re-reads and
answers the generic 404); `/bundle-inquiry` judges the locked row with
the same verdict (409 "no longer active", the route's existing shape for
an inactive row); the slots `/reserve` write re-judges the LOCKED row
with the same verdict before minting a hold (generic 404, no
reservation). A
group's held siblings are skipped at preflight, claim and publication;
a held ANCHOR parks as `send_failed`. No enumeration signal: the hold
is unobservable from outside beyond the accept/decline 409, which a held
row can only reach through a link that went out before the hold.
`/select-tier` refuses any tier above the tier the ENGINE wrote for the
estimate's qualifying services (400 `tier_not_available_for_current_services`
+ `maxTier`; downgrades stay allowed): the ceiling is the last opt-out
commit's `serviceOptOut.engineTier` stamp, else the stored `result` /
`engineResult` tier (every carrier shape the portal's readers accept), else
Bronze — fail closed, never a re-count of the stored rows under today's
qualifying policy, and never the row's own `waveguard_tier`, which holds the
customer's last selection once the route writes it back (validation audit
SEC-001, 2026-09-02; before it the ceiling applied only to opted-out
estimates). A membership reconcile that reprices the mix refreshes the
opt-out stamp with the row tier.
Appointment reminders registered by `/accept` derive their date and arrival
from the committed service row. A server-owned `reservation_service_mix`
allocation can preserve one booked arrival across sequential member work
windows, including when grouping is disabled. The existing reminder dedupe,
reschedule sync, sibling promotion, and send-time hold checks use that arrival;
a member moved away from its allocated date/start returns to its own arrival.
Registration still suppresses immediate confirmation delivery. This metadata
is internal and adds no request field or public payload field.
`/accept` existing-appointment adoption (`existingAppointmentId` in the
body, offered by the view contract instead of the slot picker): the row
must belong to this customer, be unclaimed or claimed by THIS estimate,
never a reservation hold or a callback visit, dated today or later, and
in an adoptable status. Adoptable statuses are `pending`/`confirmed`;
behind `GATE_ESTIMATE_ADOPT_IN_PROGRESS_VISIT` (fail-closed in every
environment — off unless the var is a `gateEnvValue` true: `true`, `1`
or `on`, case-insensitive; re-read per accept request, so a flip is a
live kill) `en_route`/`on_site` rows are adoptable too, so an on-site accept prices and claims the visit in
progress instead of minting a duplicate. The status set is snapshotted
ONCE per accept request and feeds both the preflight offer and the
under-lock UPDATE (a gate flip mid-request cannot 409 an offered row);
a row that stops qualifying between them answers 409 `existing appointment is no longer available`.
Adoption stamps `source_estimate_id`, the customer, the accepted plan's
per-visit price (or clears a stale one), and the catalog identity — it
never changes the row's status or date. The customer-wide fallback that
OFFERS an unlinked same-family row stays behind
`GATE_ESTIMATE_EXISTING_APPT_CUSTOMER_WIDE`.
`/data` carries an optional `lawnCalendar` block behind
`GATE_ESTIMATE_LAWN_CALENDAR` (dev-open, prod dark): `{ programs: {
[frequencyKey]: { visitsPerYear, cadence, months } } }` for the recurring
lawn section's frequencies, where `cadence` is the customer-facing interval
line and `months` the 0-based ET month indices of the program's projected
applications from the current month — both derived server-side by
`describeLawnProgramCadence` (self-booking-plan-sync.js) from the catalog
plan matching the frequency's visitsPerYear through the scheduler's own
`buildRecurringOccurrenceDates`; no customer data, no dates. A frequency
with no catalog plan is omitted; the key is ABSENT when the gate is off or
nothing resolves (it was boolean `true` from 2026-08 until #3755). The page
renders the count and fixed season copy from it and never derives an
interval itself; since 2026-09-05 it shows neither `cadence` nor `months`
(owner: education, not a schedule).
`/data` breakdown rows (`pricing.oneTimeBreakdown.items[]`) may carry a
`copy` object — `{ key, outcome, includes[], assurance|null, terms }` —
and a one-time-ONLY estimate whose billable rows all resolve to one copy
pack may carry `pricing.oneTimeServiceCopy` — `{ key, hero: { eyebrow, h1,
sub }, aiTitle?, aiBody?, askChips[] }` (hero strings keep `{first}`/`{city}`
tokens for the page; `aiTitle`/`aiBody` are present only for packs that
carry Waves AI copy) — both resolved server-side from the static pack in
`server/services/estimate-one-time-copy.json` (owner-approved customer
copy: what the visit includes + guarantee terms per service; no customer
or pricing data). A row with no pack entry omits `copy` (rows keep it on
mixed and recurring estimates — a recurring pest plan with a roach cleanout
add-on still describes the cleanout); `oneTimeServiceCopy` is omitted on
mixed one-time quotes and on any estimate with a recurring service; a
regulated certificate surface (WDO in the aligned OR raw rows) never
carries either key. When `oneTimeServiceCopy` is present its
`askChips` ARE `pricing.askChips` — a pack with its own chips supplies
them, a hero-only pack echoes the category chips the page renders — and the
server-rendered page reads the same pack, so the two paths cannot drift.
`/api/documents/shared/:token` (read-only shared-document fetch incl.
on-the-fly service-report PDFs — customer PII by design; 64-hex format
gate, 24h expiry with 410, access-count audit, 30/15min limiter,
`no-store`).
`POST /api/stripe/terminal/validate-handoff` (machine-to-machine burn of
the 60s single-use handoff JWT — the token IS the auth; see the atomic
terminal-handoff burn rule in AGENTS.md).
`/api/admin/push/vapid-key` (GET; deliberate — the VAPID public key is
public by protocol).
`/api/health` (GET; liveness probe, no data).
`/api/integrations/backlink-worker/claim` (GET) accepts `mode=draft|acquire`:
`outreach` defaults to drafting and `signup` to acquisition. Drafting requires
`GATE_OUTREACH_DRAFTER`; acquisition requests return an empty claim because
execution is restricted to the in-process signup runner. That runner requires
both authority/runner gates, a current executable free-path authority and a
reserved daily slot; its citation executor claims signup lanes only. `/report` (POST) binds new leases
to that authenticated provider and mode; a draft lease cannot report placement.
The in-process browser must atomically begin the reserved submission before a
placement report is accepted. Existing unstamped leases retain their report
contract during rollout. Reports never establish `live` or `indexed` truth.
`/api/integrations/*-worker` mounts (hermes workers; each authenticates
via its own HMAC-signed header check inside the router — an
unauthenticated internal route here is P0). `watchdog-worker` (GET
`/status`, key `hermes_watchdog`, gate `GATE_HERMES_WATCHDOG`) serves the
external agent watchdog a counts-only health snapshot — no customer data,
no item titles, no error text (job_health.last_error is only digit-masked),
no sub-read error messages; adding any free-text field is P0. `reasons` are
count-free stable keys — a count inside a key re-pages one incident.
`commitments-worker` (GET `/open`, key `hermes_commitments`, capability
`commitments_read`, gate `GATE_HERMES_COMMITMENTS`) reads existing open Waves
call commitments. HMAC only; backlink/watchdog keys and legacy bearer cannot
read it. Dark gate precedes the 30/minute IP limiter and auth/audit. Privacy
headers cover every response. Strict offset/limit-only query, max 100 rows
plus a has-more probe. Response includes obligation description, bounded
verbatim evidence with source anchors, identifiers, deadlines, record version,
and selected fulfillment hints; no contact fields, raw transcript, recording
URL, full customer row, or unrestricted JSON. Quotes may themselves contain
customer information: private case evidence only, never a shared wiki/log.
Reads never refresh/extract/fulfill or send; existing HMAC nonce/audit writes
remain. Failed audit finalization returns 503, not data. Coverage is stored
open call commitments, not SMS/email completeness or freshly verified state.
Offset pages are not a snapshot; absence cannot establish completion.
Customer authentication (`server/routes/auth.js`, mounted at `/api/auth`):
`POST /send-code`, `/verify-code`, `/refresh`, `/logout` are unauthenticated
by definition. send-code and verify-code sit behind the `server/index.js`
`authLimiter` (10 per 15 min keyed by `unauthenticatedAuthLimitKey` — JWT-
blind, IPv6 /64-collapsed) plus per-route `ip:phone` limiters (5 and 8 per
15 min); send-code returns ONE uniform response whether or not the number
matches a customer, verify-code returns one uniform error for a bad code OR
an unknown customer, logout is non-enumerating and idempotent, refresh and
logout share a 30 per 15 min limiter. The enforced anti-enumeration
contract is the uniform BODY: response timing is not equalized (the Twilio
send runs only when the number matches an active customer), so a timing
observer can still distinguish known numbers — do not widen the claim
beyond the body, and do not add a second observable difference. `/me`, `/properties`, `/select-property`
require the customer JWT.
Staff authentication (`server/routes/admin-auth.js`, mounted at
`/api/admin/auth`): `POST /login` sits behind the same `authLimiter` (10 per
15 min) and answers every failure with a generic 401 `Invalid credentials`;
`/forgot-password` (5 per 15 min) and `/reset-password` (10 per 15 min) key
on `unauthenticatedAuthLimitKey` with production-only limiters;
`/change-password`, `/register` (requireAdmin), and `/me` require the staff
bearer. OAuth callbacks validate a one-time `state` nonce, never bearer (see
the AGENTS.md admin OAuth rule).
`/.well-known/apple-app-site-association` + `/.well-known/assetlinks.json`
(static universal-link association JSON for the native app shell — no auth,
no PII, no request-derived content. **Both 404 behind GATE_UNIVERSAL_LINKS**;
AASA also requires a team ID (`APPLE_TEAM_ID`/`APNS_TEAM_ID`), assetlinks
also requires `ANDROID_ASSETLINKS_SHA256`. The AASA path list MUST keep
`/admin/*`, `/tech/*`, `/api/*` excluded — the shell is customer-only and
API/PDF responses must never be claimed by the app).
`/api/public/track/:token` (read-only live service tracker; the
`track_view_token` is the ONLY gate (`TOKEN_RE` format) plus a 120 req/min
rate limit. In ANY state it returns the customer property block — first name,
service address (line1/line2), lat/lng — and a top-level `prepToken` (set
whenever a linked project has a `prep_token`, NOT gated on state) that fans
out to `/prep/:token`. `en_route` additionally returns live tech coords + ETA
from Bouncie. The `complete` summary additionally hands out secondary bearer
tokens — `serviceReportToken` (`report_view_token`), `invoiceToken`, a
`/rate/:token` review URL, and TTL-presigned service-photo URLs — fanning out
to the report / receipt / rate surfaces. Treat the track token and any change
to its payload, in any state, as security-critical. The GET stays strictly
read-only; `POST /api/public/track/:token/stops-ahead` is the ONE write
companion — same token gate + rate limit, ignores its body, and only
persists the stops-ahead display-clamp floor (monotone LEAST,
skip-unchanged) via `computeStopsAhead` before returning the displayable
count; it must never grow beyond that single bounded metadata write).
`/api/public/appointment/:token` (GET summary + `GET /:token/calendar.ics`
+ `POST /:token/confirm`; the destination the 24h reminder and booking
confirmation texts link to. Gated by `scheduled_services.reschedule_token`
— the SAME secret /reschedule uses, deliberately reused rather than
minting a second one — plus a 60 req/min router limit and 10 req/min on
the confirm. **Every route 404s unless `GATE_APPOINTMENT_PAGE=true`.**
GET returns the visit summary (service type, date + window_start, the
server-derived arrival range, plan/one-time flag, confirmed flag, and
`vanScene` — a boolean that is exactly `GATE_VAN_SCENE` in production
(feature-gates `vanScene`: prod dark, unset = false; every other NODE_ENV
— local, preview, test — returns true regardless of the variable, so the
unset kill switch is a PRODUCTION statement) telling the page to render
the "look for this van" scene under the header card; it carries no visit
data and no other field changes with it) plus
decorations that are each individually fail-open: assigned tech first name
+ TTL-presigned photo, a same-tech-as-last-visit flag, and the day's NWS
rain chance. **NO customer name, and the page greets nobody** —
`loadByToken` deliberately does not select `c.first_name`. The token is
per-VISIT, not per-recipient: appointment notifications fan out to a
spouse, tenant, buyer or other service contact, each text personalized to
THAT contact, so serving the account holder's name both mis-greets the
reader and hands a third party an identity they were never told. Do not
reintroduce it. window_end is never returned — customer surfaces quote
start + 2h only, and the range is derived server-side with
`arrivalWindowRange()` so the page cannot drift from the reminders.
The ONLY write is the confirm: a status-only `pending -> confirmed`
transition guarded on the status AND the date/window that were read, plus
a `job_status_history` row. The client posts the slot it rendered and the
server confirms ONLY that slot — the office bulk reschedule moves
date/window while LEAVING the row pending, so a status-only guard would
bless a replacement slot the customer never saw. It never touches
date/window/tech and sends NOTHING to the customer. calendar.ics is a read-only RFC 5545 file for
the same visit, UID-stable per visit so re-downloading updates rather
than duplicates).
`GET /api/booking/config` (the /book page's public config payload, no token)
gains `van_scene` — the same `GATE_VAN_SCENE` boolean, read by booking step 4
to show the van scene above the secure-card block. Unset gate = `false`
in production (non-production envs return true, as above); no other field
changes.
`/api/public/reschedule/:token` (GET + POST, plus `POST /:token/find-slots`;
customer self-serve reschedule linked from appointment
confirmation/72h/24h texts + reminder emails.
`scheduled_services.reschedule_token` (64-hex, `TOKEN_RE` format gate)
is the ONLY gate, plus 60 req/min router limit and 10 req/min on the POST.
GET returns the appointment summary (customer first name, service type,
current date/window, recurring flag, `missed` flag, and — series visits
only — the `reanchorPullForwardDays` threshold) + live open slots from the
/book availability engine (`availability.days[].slots[]` — every slot
carries its own `nearby` boolean, true when its detour is within
`NEARBY_DETOUR_MINUTES`; `days[].nearby` and `availability.nearby` are the
roll-ups. The per-slot flag is shared by every consumer of that engine:
`/api/booking/availability`, this GET, re-service, and the find-slots
searches — added in #3888 so the picker labels each time from its own
route-fit, not the day's). Day lists contain all feasible starts; only the
separate recommendations are curated. Moving an existing self-booked visit
excludes that booking from its own day-cap count. POST is a WRITE with two owner-authorized
scopes (ruling 2026-07-13; single-visit-only before #2725), both limited
to the token's own customer/visit and never live/terminal visits (409),
and only to a slot the availability engine still offers for that day
(route feasibility, lunch reserve, self-book day caps re-checked
server-side):
  - default: moves the single visit via `SmartRebooker.reschedule`
    (advisory lock + tech-route overlap conflict check + `reschedule_log`
    audit as `customer_self_serve` + escalation flagging);
  - series re-anchor: a genuinely recurring visit (`is_recurring` only —
    booster extras never qualify or move) pulled forward by
    `RESCHEDULE_REANCHOR_PULLFORWARD_DAYS`+ (env, default 14) commits via
    `SmartRebooker.rescheduleSeries` — every later cadence occurrence
    re-anchors to the new date. Consent is explicit: the page swaps the
    "only this visit moves" note for the series-shift warning before
    Confirm (the GET's threshold drives it; the POST decides
    authoritatively). The anchor keeps the offered tech under the same
    advisory-lock overlap guard; shifted siblings that would double-book
    a route are committed UNASSIGNED inside the trx and parked as a
    `schedule_conflict` admin notification. Treat any widening of this
    scope (other customers' rows, live visits, non-cadence rows) as P0.
A pending/confirmed visit whose time already passed is MISSED (rebookable
via the same link — eligibility `missed:true`); terminal/live/no_show
still 409. Generic 404 for bad/unknown tokens.
`POST /:token/find-slots` is the Waves AI date/time search for this page:
model-backed (free-text "when" → date window via `parseWhen`, the same
parser the /book and estimate searches use) and READ-ONLY — it returns
availability in the same shape as the GET and never books or mutates. Same
64-hex token format gate + generic 404, same eligibility guards as the
commit POST (409 for non-reschedulable visits), its own 15 req/min limiter
(mirrors the estimate find-slots budget), and no raw query logging (the
route logs only service id + error message; parse-when logs only failure
messages). The parse window is clamped on BOTH ends to the booking_config
reschedule range (`advance_days_min..advance_days_max`) with no
expandOpenDays, so it can never offer a date or synthetic slot the GET list
and the POST commit revalidation would not themselves offer.
Treat the reschedule token and any change to this route family's payload
or commit path as security-critical).
`/api/public/reservice/:token` (GET + POST, plus `POST /:token/find-slots`;
customer self-serve FREE re-service (callback) scheduler — the standing
customer link texted by the office/comms composer and surfaced on the
portal Visits tab. Whole surface is dark behind GATE_RESERVICE_SELF_SERVE
(fail-closed `==='true'` in every env — every route 404s while off).
`customers.reservice_token` (64-hex, `TOKEN_RE` format gate; standing for
the life of the customer like the /card token) is the ONLY gate, plus
60 req/min router limit, 10 req/min on the commit POST, 15 req/min on
find-slots, and noStore privacy headers (the `/reservice/<token>` SPA
shell carries noindex/no-referrer/no-store via sensitive-spa-headers).
GET returns lane eligibility from LIVE plan state (pest and/or lawn —
active recurring coverage / WaveGuard membership only; rodent-, termite-,
mosquito-, tree-shrub-only and one-time customers get no lane), the
per-lane open-callback dedupe (an existing open re-service answers with
that visit's /reschedule link instead of a second booking), and open
slots from the /book availability engine around the token row's address.
POST is a WRITE limited to the token's own customer: lane re-validated,
slot re-validated against a fresh single-day availability build (route
feasibility, lunch reserve, day caps — the anti-forgery model
reschedule-public uses in place of the funnel's signed-offer HMAC), then
committed through `createSelfBooking`'s transaction with the
internal-only `callbackVisit` option (is_callback=true — completion
never bills the monthly rate; re-service catalog service_id; card-capture
step + ad attribution skipped; `/booking/confirm` pins the option null
after the body spread). The lane dedupe is re-checked INSIDE the commit
transaction under a customer+lane advisory lock, so parallel commits
cannot double-book a lane's free visit. find-slots mirrors the
reschedule search: model-backed parseWhen clamped on BOTH ends to the
booking window, READ-ONLY, no raw query logging. Generic 404 for
bad/unknown tokens and while the gate is off. Treat the reservice token,
the lane-eligibility gates, and the $0/is_callback commit contract as
security-critical).
`/api/reviews/featured` (read-only public featured Google reviews for the
marketing site — no auth, no token, location filter + limit; reads
`google_reviews` only).
`/api/review/:token` (GET + POST; token-gated customer review flow — GET
returns the review-request context by token, POST submits the customer's
review. No auth beyond the review-request token. Baseline guards
(`server/routes/review-public.js`): `REVIEW_TOKEN_RE` format gate (the
shape `services/review-request.js` mints — 32-64 url-safe chars) via
`router.param` before any DB read, one generic 404 body for malformed,
unknown, and expired tokens on both verbs, a router-wide 30 req/min limiter
on the shared IPv6-safe `rateLimitKey`, and the shared `noStore` privacy
headers (`no-store`, `noindex`, `no-referrer`) on every response. The GET
stamps open state and returns customer name data, so those guards are the
whole defense.)
`/api/rate/:token` (+ `/:token/score`, `/:token/submit`,
`/:token/generate-review`, `/:token/go`) (review-gate; token-scoped customer
rating flow from a review-request link — high → the nearest GBP
write-a-review URL, low → private feedback capture. Router-wide url-safe
32-64 token param gate (generic 404; malformed tokens on `/go` degrade to
the /rate page per its every-failure-lands-somewhere contract); the page
GET and score/submit writes carry a 30/min limiter. `/:token/go` is the
GATE_REVIEW_DIRECT_LINK tracked redirect: 64-hex token format gate, 30
req/min per-IP limit, stamps open/click on the review_requests row, stops
the customer's active review cadence, and 302s to the location's GBP review
URL — every failure path degrades to the /rate page, and the ONLY redirect
targets are config/locations.js googleReviewUrl values (never
request-derived). ONE deliberate non-failure carve-out (owner ruling,
2026-08-07 review audit): an EXPIRED but otherwise-valid, non-finalized
token still 302s to the GBP review URL while recording NOTHING — a willing
reviewer tapping an old text is not a failure case; finalized asks and
already-reviewed customers still degrade to /rate. No auth beyond the review-request token; picks nearest GBP
by geocoded address. The bare `/api/rate` mount is not itself a route — only
the token-scoped family is public).
`/api/reports/project/:token/fdacs-pdf` (read-only; streams the filled, signed
FDACS-13645 PDF for a WDO report so the public report page can show the official
form instead of a blank template. Same long-lived report token + format gate as
the sibling `/api/reports/project/:token/data` viewer
(`extractProjectReportTokenLookup`), inherits the router-level 20 req/min
`reportLimiter`, `no-store`/`noindex`/`no-referrer` privacy headers. Serves ONLY
the already-emailed archived filing streamed from private S3 — never
live/unsigned content — and returns a generic 404 for non-WDO projects, reports
with no archived filing, or malformed tokens).
`/api/reports/project/:token/ask` (POST; Waves AI on project reports — owner
ruling 2026-07-16. Deterministic keyword-routed template answers built ONLY
from the project's own findings/recommendations/follow-up — data the sibling
`/data` viewer already serves this token; internal finding keys
(`inspection_fee` class) are excluded server-side; no LLM, so nothing new can
leak or be injected. Same long-lived report token + format gate as the
`/data` viewer (`extractProjectReportTokenLookup`), inherits the router-level
20 req/min `reportLimiter`, question length capped at 500 chars. The WDO
payment hold 402s BEFORE any content-derived answer; the paper compliance
documents (wdo_inspection, pre_treatment_termite_certificate) return a
generic 404 — their pages never mount the ask bar. Only write: an
`activity_log` analytics row recording question length, never answer
content).
`/api/webhooks/voice-agent/lead` (POST; machine-to-machine webhook — the
bilingual AI voice agent (ElevenLabs) posts a captured lead when an AI-handled
call ends. NOT browser-facing. Fail-closed shared-secret auth in the route
(`voiceAgentAuth`): 403 unless `GATE_VOICE_AI_AGENT` is on, 503 unless
`VOICE_AGENT_WEBHOOK_SECRET` is set, 401 on a constant-time token mismatch —
so the endpoint is inert until the feature is explicitly enabled. Accepts PII
(caller name/phone/address); rejects non-E.164 caller IDs before any lead
create/merge and writes via `createLeadFromExtraction` into the existing lead
pipeline. Any change to this route or its payload is security-critical).
`/ws/voice-agent` (WebSocket upgrade; machine-to-machine — Twilio
ConversationRelay connects here for an AI-handled call and exchanges JSON
text frames with the Claude tool-use loop, which can spend Anthropic tokens
and write leads. NOT browser-facing. Fail-closed in two layers: (1) the ws
server only ATTACHES when `VOICE_RELAY_ENABLED=true` AND `ANTHROPIC_API_KEY`
AND `VOICE_RELAY_WS_SECRET` are all set — otherwise the endpoint does not
exist; (2) every upgrade is rejected (socket destroyed before handshake)
unless it carries a PER-CALL TOKEN — `?callSid=<sid>&t=v1.<exp>.<hmac>`, an
HMAC-SHA256 over that CallSid keyed by `VOICE_RELAY_WS_SECRET`, verified with a
constant-time compare, valid ~5 minutes, and accepted ONCE — the burn is an
`INSERT … ON CONFLICT DO NOTHING` on `voice_relay_token_burns` (hashed token),
i.e. SHARED storage, because a per-process claim is no claim at all here: a
second instance or a restart would take the replay. It fails closed, and the
CallSid the token authenticated is carried onto the socket — the setup frame
that follows is unverified input and may not rename the session (a mismatch
terminates it), or a token for call A would authenticate a session claiming
call B. **The raw secret is never put in a URL and is never accepted as a
credential** — it stays server-side (Railway env, and the Twilio Function env
that renders the sandbox TwiML), because a URL param is exactly what leaks:
Twilio logs request URLs, and a reusable key in one would let anyone who saw it
open unlimited synthetic sessions, spend Anthropic tokens and write leads with
no call behind them. Anything that renders this TwiML MUST mint the token
(`relay-protocol.mintCallToken` / `buildRelayTwiML({ callSid })`); a render
without a CallSid produces a URL the server refuses.
Caller PII is masked in logs; lead writes require a valid E.164
caller number (`capture_lead` tool + the capture-floor on session close).
The live `/voice` backstop only routes a call here when the relay actually
attached (`isRelayAttached`) AND the configured endpoint's scheme/host/path are
trusted (`wss://` + this portal's own origin from `PUBLIC_PORTAL_URL` + the
exact `/ws/voice-agent` path; `ws://localhost` for dev) — so the WS secret is
never appended to a foreign host. Caller RECOGNITION on this endpoint is a
third, independent layer: the WS setup frame's `from` is unverified input and
is cross-checked against the signature-verified `/voice` webhook's `call_log`
row before any account read, and `VOICE_RELAY_REQUIRE_ATTESTATION=true`
additionally demands STIR/SHAKEN attestation A — the carrier vouching that the
caller owns the number — before the caller is recognised at all. That switch
ships OFF: most genuine calls carry no attestation, so turning it on trades
spoofing resistance for treating real customers as strangers, and the
attestation is logged on every call so the distribution can be measured first.
**The SPLIT TIER (owner ruling 2026-08-12) is the default that does not wait
for that measurement**: an ANI match alone still recognises the caller and
answers the receptionist questions (who they are, appointments, today's ETA,
open estimates, visit dates and service names), but the reads a spoofed caller
ID would pay for — `get_invoice_history` (amounts), `get_message_history` and
`get_call_history` (the bodies of texts and calls), `get_service_report`
(what a technician found inside the home) — require attestation A, as do the
balance FIGURE (in the KNOWN CALLER block AND `get_account_overview` — the
amount is not even FETCHED unattested), the visit SUMMARY lines in
`get_service_history` (report detail through another door), and the session's
recent-texts block (not fetched at all without it). Enforced in
`relay-tools.ATTESTATION_ONLY_TOOLS` BEFORE the tool runs, so a new sensitive
tool cannot be added without deciding which side of the line it is on; fails
closed on a missing flag. When gating a read, gate EVERY reader of the same
loader — the balance figure and the report summaries each turned out to have a
second door.
Recognition is additionally bound to a freshness window on that call_log row
and to ONE session per CallSid — burned atomically as a metadata key on the
row itself (`relay_session_claimed_at`), so the claim holds across instances
and restarts and a historical (CallSid, from) pair cannot be replayed by
anyone holding the key. WRITES for a caller the ANI did
not fully authenticate — a looked-up account, or a number that matched only a
service-contact slot — are gated separately again by
`VOICE_RELAY_ALLOW_THIRD_PARTY_WRITES` (default OFF: full ANI match or no
booking and no re-service ticket).
Any change to this endpoint, its auth, or its frame handling is
security-critical).
`/api/webhooks/twilio/relay-sandbox` + `/api/webhooks/twilio/relay-sandbox/cell`
(POST; machine-to-machine TwiML webhooks — the voice URL and the in-call
`<Gather>` action of the dead GA# SANDBOX number, the only test path for the
AI receptionist. Twilio-signature validated at the `/api/webhooks/twilio`
mount like every Twilio inbound route, and additionally fail-closed to a 403
`<Hangup/>` unless the posted `To` is exactly `VOICE_RELAY_SANDBOX_NUMBER`
(unset ⇒ every request refused) and a `CallSid` is present; relay not
attached ⇒ a spoken notice and hangup. The first hit inserts a `call_log`
row for the CallSid (`direction` inbound, `source` 'voice_relay_sandbox')
under the same per-CallSid advisory lock `/voice` and `/call-status` take;
a generic `/call-status` fallback row that won the race (`source` NULL) is
adopted — sandbox source, customer link cleared — and any row with a foreign
non-null source is refused (403 hangup). `/call-status` itself writes the
sandbox-sourced row, with no customer link or touchpoint, when it sees the
sandbox number first. The handler then renders a 3-second two-digit DTMF
`<Gather>` (a relay-profile cell code, `relay-profiles.SANDBOX_CELLS`;
'99' = the raw env attributes; no digits ⇒ the production profile) followed
by the same `<Connect><ConversationRelay>` + per-call minted token that
`/voice` renders — the WS secret never leaves the server. Payload: standard
Twilio voice-webhook form fields (`CallSid`, `From`, `To`, `CallStatus`,
`Digits` on the cell action). The session that answers is a DRY RUN: the ws
upgrade proves the sandbox source from the call_log row and the relay answers
`capture_lead` / `request_reservice` / `request_booking` without running them,
its hangup capture floor stays down, and every call reader (Calls tab,
unified inbox, dashboard KPIs, corpus/research/insights miners, self-audit,
the relay's own call history) drops the source through
`relay-protocol.whereNotSandboxCall` — so a test call, or a stranger dialling
the test number, can neither create dispatch work nor move a metric. The
transcript, latency summary and version stamps land on the sandbox row
exactly as in production; that record is the bake-off. Any change to the
number gate or the dry-run invariant is security-critical).
`/api/webhooks/twilio/relay-complete` (POST; machine-to-machine TwiML
webhook — the `<Connect><ConversationRelay>` action Twilio calls when the
AI receptionist's relay leg ends. Twilio-signature validated at the
`/api/webhooks/twilio` mount like every Twilio inbound route. Payload:
standard Twilio voice-webhook form fields (`CallSid`, `SessionStatus`,
`ErrorCode`) plus `HandoffData` — the JSON string the relay's OWN end frame
set (absent on a caller hang-up or a session failure), which the handler
parses tolerantly and trusts for nothing beyond `reason`. Pre-PR-2A
behaviour is unchanged: a failed session ⇒ voicemail (sandbox: a
`relay_failed` stamp + hangup), otherwise a bare `<Response/>`. **Sandy PR
2A adds `reason: 'transfer'`** (`GATE_VOICE_RELAY_TRANSFER` exactly 'true'
— the gate lives at the `transfer_to_office` tool that emits the frame; the
frame itself only exists when the tool ran, and only the server's own
socket can send one): the handler claims ONE staff ring per CallSid
atomically on the call_log row (`metadata.relay_transfer_ring_at`, stamped
with `call_outcome = 'ai_transferred'` when the row is not already
terminal) under a 1.5s deadline, OWNER-BOUND to the frame's
`owner` (the socket's `relay_session_claim_owner` nonce; a superseded
socket's frame matches 0 rows), and renders the same staff simul-ring
`<Dial>` the live `/voice` backstop renders — identical screen / accept
URLs, no summary, no id and no query string on any URL: the ≤20-word staff
whisper is read from the persisted packet (`metadata.relay_handoff`) after
press-1 only. A Twilio retry (ring already claimed ⇒ 0 rows) gets a bare
response, never a second ring; an unconfirmed claim (timeout / error) and
a call with no staff forward numbers are stamped `voicemail` (bounded,
best-effort) and get the voicemail recorder; `?sandbox=1` (the signed
query the sandbox route rendered) hangs up — a test call never rings
staff. The caller's own text is never in the URL or the TwiML. **Sandy PR
2B adds session recovery** (`GATE_VOICE_RELAY_RECOVERY` exactly 'true',
read at call time; off ⇒ the failed branch is byte-identical to the above):
a FAILED session (`ErrorCode` / failed status) is reconnected ONCE — one
bounded, fenced UPDATE claims the reconnect on the call_log row
(`metadata.relay_reconnects` 0 → 1 + `relay_reconnect_ms`, outcome back to
NULL / status in-progress; a voicemail / transferred / relay_failed row is
never resumed; an unconfirmed claim never re-renders, a late-landing one is
put back) and the handler renders the same `<Connect><ConversationRelay>`
the call started with (an explicit untuned stamp stays untuned); production
reconnect rendering rechecks `voiceAiAgent` and the recovery gate after async
lookups. It retains the same action incl. `?lang=es` / `?sandbox=1`, plus
`gen=<the row's relay_reconnect_ms>` so the resumed leg's own failure is
told apart from a Twilio retry of the first leg's — a retry on a row that
already reconnected gets a bare `<Response/>` and never ends the healthy
session; a resumed welcome greeting, `<Parameter resumed="1">`, a token
minted AFTER the stamp so the new socket's generation is ≥ the fence. The session
treats `resumed` as a hint and re-proves it from the row before seeding the
earlier turns or skipping its capture floor. Close-time segment storage may
also use the server-verified, burned call token to retain that socket's own
text on an unclaimed row or after reconnect; this proof never grants account
access or prior-dialogue hydration. Captured lead ids persist in the segment
as a fallback when the call linkage stamp did not land. A second failure: office open
AND `GATE_VOICE_RELAY_TRANSFER` ⇒ the staff ring above (owner-bound to the
row's current claim owner, generic whisper); otherwise today's voicemail.
With recovery enabled, an unconfirmed reconnect claim/state read returns
503 with no fallback instructions. Voicemail, sandbox failure, and staff-ring
claims are fenced to the proven reconnect generation; voicemail/failure
writes also atomically refuse rows with a claimed staff ring or transferred
outcome, even if the replacement socket never acquired a session claim.
The ring claim stamps a server-generated `relay_transfer_ring_claim` id;
compensation matches that id plus the generation and owner fences, so its
own late claim can fall back to voicemail without changing another ring; a predicate that loses
to a newer reconnect returns a bare response instead of stale fallback TwiML.
Any change to the claim, the owner fence, the reconnect fence, the sandbox
branch or what the whisper may speak is security-critical).
`/api/public/secure-card/:token` (+ `/:token/complete`, `/:token/select-plan`) (GET + POST;
"secure your appointment" card-on-file capture page for the
appointment-card-request funnel — ALSO serves the standalone "set up
Auto Pay" link (`appointment_card_requests.kind='customer'`, dark behind
`GATE_AUTOPAY_SETUP_LINK`, operator-minted only from the Customers page):
same token/format/header/limiter contract; the GET payload carries
`kind:'customer'`, no visit/fee/plan fields, `paymentMethodTypes`
(card_or_bank with INSTANT bank verification only, card-only under an
unhealthy `customers.ach_status`), and renders `closed` once
`expires_at` (30 days) passes, the customer is archived or becomes
payer-billed, or Auto Pay is already active (the pending row is RETIRED to
`expired` so every later GET stays closed — never healed to satisfied); a
`completed` row renders `secured` only while the enrollment is still live
and chargeable; the POST runs the same
live-verify (purpose `autopay_setup_link` + request id) and the same
save → consent → enroll tail under the same claim/lease; `select-plan`
is not applicable to these rows. The visit lane below is unchanged — dark until `APPOINTMENT_CARD_REQUEST`
AND the `secure_appointment_card` SMS template are both enabled, and
unreachable until the funnel mints links. Bearer token
(`appointment_card_requests.token` — 22-char base64url / 128-bit since
2026-08-12 so the SMS link fits 2 GSM segments; legacy 64-hex rows stay
accepted) with format gate + generic 404 (no existence oracle); its own 60 req/min limiter on top of the global /api
limiter; `private, no-store` / `Referrer-Policy: no-referrer` /
`X-Robots-Tag: noindex` on EVERY outcome including 404s (the SPA shell
for `/secure/:token` carries the same headers via
`sensitive-spa-headers.js`). NO money moves on this surface — the GET
mints/replays a card-only off-session SetupIntent (request-pinned
metadata, deterministic idempotency key) after re-checking visit
liveness AND payer exemption; the POST live-verifies the SetupIntent
against Stripe (status + purpose + request id — never the client's
word), re-checks visit/payer again, and runs the idempotent
save → consent → enroll sequence under a pending → completing claim
with a 10-min stale-claim lease (page POST and the
`setup_intent.succeeded` webhook backstop are mutually exclusive;
failures revert and stay retryable). `/:token/select-plan` (POST, dark
behind `GATE_SECURE_PLAN_CHOICE` — 404 while off) records the pay-per-
application vs. annual-prepay choice: the client sends ONLY `{ plan }`
and every amount is re-derived server-side from the booked series. A
prepay selection MINTS a payable draft annual-prepay invoice +
payment_pending term (still no charge on this surface — payment happens
on the invoice's own `/pay/:token` page) inside one transaction with the
per-customer advisory overlap lock, an in-transaction FOR UPDATE
visit+customer revalidation and trx-scoped payer re-resolve, and the
request row as the idempotency anchor (double-submit returns the same
pay link; terminal invoices release the anchor). A recurring
plan-bearing request REFUSES `/complete` until a durable
`per_application` selection exists, and the completion claim is
plan-value-guarded so a selection switch cannot cross a capture
mid-flight. Treat the token, the verification
gates, the selection/mint transaction, and the claim mechanics as
security-critical.
**Appointment-card enforcement rails (2026-08-01, both dark, fail-closed
`feature-gates.js` money gates):** the /secure page RENDER stamps the
disclosed terms onto the pending request row (`no_show_fee_amount` /
`cancel_window_hours` + `accepted_amount`, the completion-charge cap —
last disclosure shown wins, fee-off renders clear the stamp), and the
completion tail only records consent (`fee_agreed_at`) against those
stamped values — it NEVER re-reads live config, so a config/price change
between render and consent cannot move an agreed fee or widen the cap
(Codex #3153 r1). The stamp is LOAD-BEARING: a failed/zero-row stamp
renders `unavailable` instead of the card form (an earlier render's
higher terms must never sit chargeable behind a lower disclosure), and
the fee rail refuses any row without a recorded `fee_agreed_at` +
positive frozen window (`no_fee_consent`). `accepted_amount` stamps
ONLY when the page DISPLAYED the price (planContext present — r2): with
`GATE_SECURE_PLAN_CHOICE` off no number renders, so page-secured rows
stay uncharged (completion routes to review) until that gate is on —
flip order matters. The stamp is MONOTONIC-DOWN with sticky sentinels
(r3): completion cannot know which open tab's render was consented
from, so a re-render may LOWER the frozen fee/cap (SQL LEAST, atomic)
but never raise it, and a render that disclosed no fee
(`cancel_window_hours = 0` sentinel) or no price (`accepted_amount = 0`
sentinel) pins the row unchargeable permanently — enforced terms are ≤
every disclosure ever shown on the link. The /secure page and the
enrollment email state the EXACT window hours being frozen (a fee under
an undisclosed cutoff is not consented); the SMS keeps the short
"last-minute" clause (segment budget — the page is the consent
surface). Fee-state machine is terminal-everything: a timely
free cancel persists `fee_status='released'` BEFORE reporting release
(cancellation retries re-run side effects — an unpersisted free cancel
must never become chargeable later), and BOTH races (lost charge claim,
lost free-release stamp) report the canonical NON-released
`charge_review`, never a clean outcome. Fee terms live on COMPLETED rows only; a `satisfied`
auto-secured row never saw the disclosure and is NEVER fee-charged (it
does get `accepted_amount`, frozen at auto-secure time); rows from
before the fee-terms migrations stay unchargeable. (1)
`GATE_APPT_CARD_NO_SHOW_FEE` — `chargeAppointmentNoShowFee` /
`handleAppointmentCardCancellation` in `appointment-card-request.js`
mirror the card-hold fee rail posture-for-posture (staleness guards +
shared exported constants, `fee_status` NULL→charging atomic claim,
ambiguous-outcome parking to `charge_review`, face-value
surcharge-exempt `chargeSavedPaymentMethodOffSession`, PI purpose
`appointment_card_no_show_fee`, webhook-settled as a paid refundable
taxRate-0 self-pay invoice via `settleAppointmentNoShowFee` + the shared
`sendNoShowFeeReceipt`). Runs ONLY as the no-hold fallback at the
existing card-hold call sites (dispatch no_show/cancel, schedule bulk/V2
cancel, cancellation-processor, offboarding waive — which gates the
deposit refund on a clean waive) — an `estimate_card_holds` row of ANY
status makes the rail skip (`card_hold_lane`), and that lookup FAILS
CLOSED: a lookup error or an in-flight `charging`/`charge_review`
fee_status returns a NON-released canonical `charge_review` from the
cancellation handler (never "released", never treated as absence). The
rail also RE-RESOLVES the payer both in eligibility AND at the claim
boundary (r6+r8): a third-party payer assigned after the card was
secured exempts the homeowner (`payer_billed` — a post-claim payer hit
closes the fee event terminally as 'released'), a payer lookup error is
unresolved / reverts the claim (fail closed), and unresolved fee states
are checked BEFORE the payer exemption so an in-flight charge can never
be reported as a clean payer release. The completion charge's frozen
cap (`maxAuthorizedSubtotal`) is enforced inside
`chargeInvoiceWithSavedCard` against the LOCKED invoice and BEFORE any
account-credit application — the fully-covered-by-credit early return
must never consume credit above consent — and the dispatch route's OWN
credit auto-apply is fenced off over-cap appointment-lane invoices AND
off UNVERIFIABLE lanes (lookup error — r9/r10: review must see the bill
exactly as minted, full coverage must not flip it prepaid past a
never-evaluated cap, and an error must not bypass the fence). The
cancel preview surfaces an unverifiable lane as fee-may-apply
(`unresolved: true`, never a silent "no fee"); the secured page repeats
the FROZEN row terms (EVERY satisfied transition carries none —
including the page's own auto-secure branch); and a card the customer
removed is honored as revoked — the fee closes 'released' with an
office alert, the local payment_methods row must still exist before any
fee charge, and the fee path performs NO attach self-heal at all (a
method detached by a racing removal fails the charge instead of being
resurrected). Every satisfied heal (auto-secure update, autopay heal, prepay
heal) applies the SAME monotonic-down accepted_amount stamp as the
render — a heal can never overwrite the sticky 0 sentinel or widen a
lower disclosed cap. The
`GET /:serviceId/card-hold` cancel preview merges both lanes so the
client waive prompts work unchanged. (2)
`GATE_APPT_CARD_COMPLETION_CHARGE` — the dispatch completion
auto-charge guard widens from `perApplicationBilling` to
`(perApplicationBilling || apptCardOneTimeCharge)`: a ONE-TIME visit
(`is_recurring !== true`, not per-app/prepay/membership lane, no hold
row) with a completed-or-satisfied `appointment_card_requests` row and
active Auto Pay auto-charges its completion invoice through the same
rail, hard-capped at the lane row's FROZEN `accepted_amount` ONLY —
never the live `estimated_price`, no acceptance-fee fallback, no
setup-fee allowance (those stay per-application concepts); NULL
accepted_amount routes to office review instead of charging. Autopay-log
source `appointment_card_completion`. The recap closeout path
(`pest-recap.js`, which completes without invoicing) runs
`chargeAppointmentCardForRecapCompletion` as the no-hold fallback after
the card-hold recap rail — same exclusions and frozen cap, invoice
minted through the SHARED `resolveOrMintRecapCompletionInvoice` helper,
which serializes on the CANONICAL `['schedule.invoice.mint', svc.id]`
advisory lock (the same lock every scheduled-service invoice writer
takes — a recap overlapping the dispatch /complete mint must contend on
it or both paths mint and auto-charge separate invoices; r4),
autopay-log source
`appointment_card_recap_completion`, every non-charge outcome alerts the
office (recap has no pay-link fallback). Source contracts pin the guard
strings — `admin-dispatch-backfill-completion.test.js` and
`appointment-card-fees.test.js` must move with any change here.)
`/api/mcp` (POST; machine-to-machine JSON-RPC — a minimal read-only MCP
server exposing the knowledge index (hybrid search, catalog service +
static protocol lookups, corpus stats) to MCP clients such as Claude Code
sessions and agents. Fail-closed in three ordered layers: 403 unless
`GATE_MCP_READ_TOOLS=true`, 503 unless `MCP_SERVICE_TOKEN` is configured,
401 unless the `Authorization: Bearer` / `X-MCP-Token` credential matches
via constant-time compare — the endpoint is unusable until deliberately
armed in an environment. Tools are READ-ONLY and free of generative LLM
calls by construction (the only model call is the query embedding, which
degrades to FTS-only when unavailable); no customer-PII tools and no write
tools may be added here — the write surface stays IB-only behind
write-gates. JSON-RPC batches are capped at 20; GET returns 405 (stateless
server, no SSE). Treat the auth ordering and the read-only tool surface as
security-critical).
`/api/client-errors` (POST; unauthenticated client error telemetry. An
anonymous surface — /admin/login, a public token route, or any page — can
crash in the browser, so the reporter cannot require auth. Hardened: per-IP
rate limit (30/min), every field truncated server-side before it reaches
Sentry (tagged `source=client`), and the client scrubs token-like path
segments out of the reported URL. No reads, no PII persistence, no writes to
app data — it only forwards to Sentry).
`/api/public/mcp` (POST; ANONYMOUS read-only MCP JSON-RPC server for
third-party AI agents — the surface the hub's /.well-known agent-readiness
cards point at. No token BY DESIGN (the audience is anonymous agents);
guarded instead by GATE_MCP_PUBLIC (404 dark until flipped), a per-IP rate
limit (60/15min), a 64kb body cap ahead of the global parsers, and the
/api/mcp batch caps, sharing the same JSON-RPC plumbing
(services/mcp-rpc.js). Tools are READ-ONLY, side-effect-free, LLM-free, and
expose only already-public data: customer-visible catalog rows (price
columns excluded AND `description` excluded — tighter than /api/mcp
get_service, because catalog descriptions are admin-editable free text
that is neither compliance-curated nor price-synced and must not reach an
anonymous surface),
the /api/public/pricing-ranges payload via its shared fail-closed producer,
the service-areas table, and a static description of the
/api/public/quote/calculate HTTP contract (how_to_request_quote). No
customer-PII tools and no write tools may be added here — exact quotes and
lead capture stay on /api/public/quote/calculate behind its four-field
contact gate; this surface documents that endpoint, never wraps it. Treat
the gate, the rate limit, and the read-only tool surface as
security-critical).
`/api/public/a2a` (POST; ANONYMOUS informational A2A (Agent2Agent) JSON-RPC
endpoint — the service behind the hub's /.well-known/agent-card.json.
Deliberately minimal: `message/send` returns ONE static, deterministic,
compliance-reviewed informational Message pointing agents at the public
MCP server and published pricing/quote surfaces; A2A task/streaming/push
methods return UnsupportedOperationError (-32004). No tasks, no state, no
LLM calls by construction, no PII, no writes — none may be added. Guards
mirror /api/public/mcp: GATE_A2A_PUBLIC (404 dark until flipped), per-client
rate limit (60/15min via the shared /64-collapsing key), 64kb body cap
ahead of the global parsers, GET 405. Treat the gate, the rate limit, and
the static-reply-only surface as security-critical).
`/api/estimates/:token/measurement-review` (POST; the "does the lawn size
look off?" challenge on a sent estimate — parks ONE `service_requests` row
(`requested_service='lawn_area_review'`) + an admin bell; the estimate is
NEVER mutated and the customer is NEVER auto-messaged (owner sends all
comms). Guards: `GATE_ESTIMATE_MEASUREMENT_REVIEW` dark by default with a
gate-aware limiter skip so dark-gate probes see the same generic 404 as
unknown/malformed tokens; estimate token format gate; 5/hr rate limit on
the shared IPv6-safe key; full customer-viewability + accepted/declined
exclusion + priced-lawn-basis requirement, ALL re-validated on the LOCKED
estimate row inside the write transaction; the durable call-side linkage
verdict re-checked under the estimates → leads → call_log lock order and
HELD through customer resolution and the insert; open-request dedupe on
the `service_requests` partial unique index, pre-checked under the lock
(a 23505 inside the transaction is a bug, not a race); `shownSqFt`/
`shownSource` derived server-side from the authoritative measured basis —
request-body figures are ignored. Treat the gate, the lock ordering, the
generic-404 indistinguishability, and the no-comms contract as
security-critical.)
`/api/estimates/:token/referral-link` (POST; the referral card's "Send My
Referral Link" tap on an ACCEPTED estimate, GATE_ESTIMATE_SUCCESS_REFERRAL.
Same composer as the service report's tap — `services/referral-share.js`
(`buildReferralShareForCustomer`: strict live-settings read, per-customer
`enrollPromoter` with the household 23505 fallback scoped to account_id,
owner-voice share copy, exact-cents referee amount). The RENDER payloads
(/data, the accept response, the already-accepted retry) carry only the
static headline + CTA via `composeReferralCard`; enrollment happens on the
tap only, never on a read. Guards: gate with a gate-aware limiter skip
(dark = generic 404), token format gate, 5/min shared IPv6-safe key, the
durable call-side linkage verdict, full customer-viewability +
accepted-only + linked-customer, inactive program = 404, `err.code`-only
logging (PG constraint errors quote phone numbers). Treat the gate, the
no-enroll-on-read rule, and the PII-in-logs rule as security-critical.)
`/api/estimates/:token/change-request` (POST; the non-decline half of the
customer soft-exit sheet, GATE_ESTIMATE_SOFT_EXIT. `kind:'change'` parks
ONE `service_requests` row (`requested_service='estimate_change_request'`)
+ an admin bell through the measurement review's shared notify core;
`kind:'still_deciding'` writes one `activity_log` row and nothing else.
The estimate is NEVER mutated and the customer is NEVER auto-messaged.
Guards mirror measurement-review exactly: gate with a gate-aware limiter
skip (dark = generic 404), token format gate, 5/hr shared IPv6-safe key,
full customer-viewability + accepted/declined exclusion re-validated on the
LOCKED row, the durable call-side linkage verdict re-checked under the
estimates → leads → call_log lock order and held through the insert, open-
request dedupe pre-checked under the lock. The same gate lets
`PUT /:token/decline` accept optional `reason` / `competitorName` /
`competitorPrice` / `note`, validated by `customerDispositionUpdates`
against the normalized loss codes the staff modal writes; with the gate
dark those fields are ignored so the plain decline stays byte-identical.
Treat the gate, the lock ordering, the no-comms contract, and the no-
estimate-write contract as security-critical.)
`/api/public/careers/apply` (POST; public job-application intake for the
careers funnel. Guards mirror the lead webhook: GATE_JOB_APPLICATIONS
(404 dark until flipped, unobservable-when-dark), IP limiter (6/10min)
+ per-phone limiter (3/hr), honeypot silent-200, Turnstile shadow-verify
with enforcement under the shared leadTurnstile gate, strict validation
with 400 fail-closed (malformed shapes, non-string or over-length
answers, over-length city, unknown role all reject; answer keys are an
ALLOWLIST — unknown keys are dropped by contract, and `source` is
server-sanitized attribution, not applicant content). Applicants
are NEVER customers or leads — the route never touches either table —
and nothing sends applicant-facing comms (owner contacts every applicant
himself). Post-insert side effects are fire-and-forget: an AI ranking
screen that is assist-only (it never changes status or any
applicant-facing outcome — every decision is the owner's, which also
keeps us clear of automated-employment-decision law) and an owner
bell/push. Treat the gate, the limiters, the no-customer/no-lead rule,
and the no-comms contract as security-critical.)
`/api/estimates/:token/service-opt-out` (PUT; the customer drops ONE
recurring service line from a sent estimate. Unlike the bond and interior
switchers this route re-prices the WHOLE estimate through the canonical
engine — `serverRecomputeFromEstimateData` with `replaySavedPricingKnobs`,
never delta arithmetic — and PERSISTS the result, so it is the first public
route to write that recompute's output. `dryRun: true` runs every
precondition and the full replay and returns before/after WITHOUT writing;
the customer confirms against real numbers, because a removal can RAISE the
price of the services they keep (tier collapse, the solo setup fee, the
prepay rate) and must never do so silently. Guards:
`GATE_ESTIMATE_SERVICE_OPT_OUT` STRICT opt-in in every environment (dev
included), dark = generic 404 indistinguishable from an unknown token, with
a gate-aware limiter skip so a probe cannot spot the route by a 429;
estimate token format gate; 40/hr on the shared IPv6-safe key; the durable
call-side linkage verdict; `isEstimateAcceptActive` + an explicit
`price_locked_at` refusal; removability from ONE resolver shared with the
`/data` projection, which refuses an itemized proposal on ITEMIZATION
PRESENCE (not `proposal.enabled`) — the same refusal applies to RESTORES
and suppresses the add-back projection, because an itemization added after
a removal is the authoritative billed quote — plus the last remaining
recurring line, `tree_shrub` and every `commercial_*` key; a fail-CLOSED 409 when the
recompute cannot run; and a 400 refusal when the removal would turn a
bundled-free one-time item into a charge (owner ruling — that one goes to
the office; the before-state resolves through `result` OR the mapped raw
`engineResult` so engine-only estimates never blind the guard). Membership
identity is loaded EXPLICITLY — `membershipSnapshot.isExistingCustomer ===
true`, never snapshot truthiness — or an existing member reprices as a
brand-new customer and a linked NEW customer steals the perk; when member
evidence survives (snapshot flag, priors in any carrier, or a surviving
recurring flag), the handler LIVE-verifies the plan itself and fails
closed on any lookup failure — the reconciler never throws and every
other consumer only renders, but this route persists. EVERY commit
(removal AND restore) must echo its dry run's `previewBasis` — an HMAC
digest over the row version AND the computed totals/tier, re-derived from
the commit's own recompute — and is refused when the row, the pricing
config, or the membership verdict moved since the preview, so the terms
the customer confirmed are the terms that persist — restores get the same
preview-and-confirm step, never a one-tap reprice. Confirm-panel copy is per-application only:
no combined plan totals ("$X/mo"/"$X/yr") per the standing price-copy rule;
the first-visit line is the invoice-preview exempt class. The write carries the same six-predicate rails +
ms-truncated CAS as the bond/interior writes, refreshes BOTH stored result
carriers (`result` and raw `engineResult`) from the same recompute, and
stamps `serviceOptOut.engineTier` as the select-tier eligibility ceiling.
A standing /select-tier override (row tier differing from the engine tier)
REFUSES all self-serve mix changes — removals, restores, and both /data
projections — because an opt-out reprice persists the engine's tier and
totals, and honoring a hand-picked tier through that rewrite would either
discard the choice or persist totals that disagree with the stored result
rows every renderer and accept reads; that interplay is an owner ruling,
not a route default, so it routes to the office. A removal with no
trustworthy before-state (no pricing rows in `result` or the mapped raw
`engineResult`) fails closed, and per-application disclosures derive from
effective post-discount amounts (`annualAfterDiscount`/`visitsPerYear`),
never the pre-discount list `perTreatment`.
NOTHING is sent to the customer and no bell rings: one `activity_log` row,
written ATOMICALLY with the estimate update, is the whole audit surface.
The same PUT is the priced ADD rail under `GATE_ESTIMATE_SERVICE_ADD`
(STRICT opt-in, needs the opt-out gate; off = the `/data` `addable` stamp is
withheld and the write refuses 400 `service_not_addable`): `included:true`
for a key the customer never removed adds a NEVER-quoted residential line
(`SERVICE_ADD_KEYS` pest / lawn / mosquito; lawn only from a supplied turf
basis — measured, `lawnSqFt`, or `estimatedTurfSf` — because lot-only
turf prices review-only) through the identical dry-run → `previewBasis`
confirm shape and canonical recompute (mode `add`). Eligibility is ONE
resolver (`serviceOptOutAddableKeys`) shared with the `/data`
`serviceOptOut.addable` stamp: `estimates.category` RESIDENTIAL
fail-closed, no member evidence via `memberEvidenceInEstimateData`, PLUS a
strict live `isActivePlanCustomer` check that fails closed on the stamp
and the write; the write re-checks membership on a `FOR UPDATE` customer
row inside its transaction (estimate row locked first, the accept path's
order). The add branch is customer-only (`actor !== 'customer'` → 400); an
add whose recompute yields no new recurring row, or one the engine could
only price for review (`lineReviewOnly`), fails closed 409
`add_unavailable`. The rail body is `applyServiceMixChange({ estimate,
body, actor })` — the route owns gate / token / viewability, the rail owns
eligibility, recompute, digest, CAS write and audit, and every event
persists the caller's `actor`. Second caller: the send-time lead-service
park in `admin-estimates.js` (`actor:'staff'`,
`GATE_ESTIMATE_LEAD_SERVICE_SEND`, strict opt-in): a NEW residential
customer's two-recurring-line estimate is sent leading with the
estimator's first selected service (no selection order = unshaped), the
other parked as ONE staff removal that `/data` ships as
`serviceOptOut.staffOfferedKeys` and the page words as an offer; a
customer restores it only under the add gate and the same live member
check. A send that delivers on NO channel restores the park through this
rail (`revertLeadServiceForSend`, bound to its `parkId`; that staff
restore alone admits a `send_failed` row); a failed restore is a durable
`leadServiceRevertPending` marker the next send retries first.
Treat the gate, the generic-404
indistinguishability, the fail-closed reprice, the explicit membership
identity, and the no-comms contract as security-critical.)
The route-WIDE invariants — every public route must be listed here, the
baseline token-route guards, the `/api/reports/:token/*` write rules,
contract-token burn, and the estimate ask / find-slots gates — live in the
AGENTS.md P0 rule "Public route surface", not in this document. This
document holds the per-route entries only.
