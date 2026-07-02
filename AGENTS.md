# AGENTS.md

Code-review rules for automated agents (Codex, ultrareview) auditing diffs in
the **waves-customer-portal** monorepo. Rules are derived from the actual code
in this repo and the failure modes that have shipped or come close to
shipping. Each rule cites the file it protects.

Codex integration reference:
<https://developers.openai.com/codex/integrations/github>

The pre-push hook in `.git/hooks/pre-push` blocks pushes that contain any P0
finding and warns on P1. Reviewers must return JSON matching
`.github/codex-review-schema.json`. Cite `file:line` for every finding.

## Codex local database policy

- Prefer a Railway dev or preview Postgres branch for Codex sessions:
  set `DATABASE_URL=postgresql://<user>:<pass>@<host>:<port>/<db>?sslmode=require`
  in the Codex environment/secrets panel. Do not point Codex at production.
- If `DATABASE_URL` is unset, `pg` may try the OS-user database
  (for example `adambenetti`) and `npm run db:migrate` can fail before
  `npm run dev` starts because `package.json` has `predev: npm run db:migrate`.
- When the sandbox has no dev database, it is acceptable to skip migrations,
  verify frontend-only work with `npm run dev:client` or `npm run build`, and
  note in the final/PR summary that migrations were not run locally.
- For backend or migration work, get a real dev `DATABASE_URL` before claiming
  end-to-end DB verification.

## Review guidelines

### Treat as P0

- **Stripe webhook raw-body order.** `server/routes/stripe-webhook.js` mounts
  `express.raw({ type: 'application/json' })` and is registered **before** the
  global `express.json()` parser in `server/index.js`. Any diff that moves the
  webhook mount after the JSON parser, swaps `raw` for `json`, or feeds a
  parsed object into `stripe.webhooks.constructEvent` breaks signature
  verification — all incoming webhooks would 400 silently in prod.
- **Stripe webhook idempotency.** Every event must be deduped against
  `stripe_webhook_events.id` before its handler runs (see `stripe-webhook.js`
  lines ~46–70). Removing the dedupe `SELECT`, marking `processed=true`
  *before* the handler succeeds, or short-circuiting the insert lets a
  Stripe retry double-charge / double-refund / double-create payments rows.
- **No second Stripe webhook router.** All Stripe events flow through one
  mount (`/api/stripe/webhook`). A new `/api/stripe/webhook-v2` or
  per-event mount bypasses the central idempotency table.
- **Webhook secret presence.** `stripeConfig.webhookSecret` falsy must reject
  with 500 and refuse to call `constructEvent`. Defaulting the secret to
  `''`, removing the guard, or accepting events without verification is a
  forged-event vector.
- **Surcharge math must come from `computeChargeAmount`.**
  `server/services/stripe-pricing.js` (the pure, unit-tested surcharge module
  imported by `stripe.js` — `computeChargeAmount`, `isCardMethodType`,
  `CARD_SURCHARGE_RATE`) is the single source of truth for the card surcharge —
  currently **3%** (`CONFIGURED_COST_BPS = 300`, capped at the `NETWORK_CAP_BPS`
  3% Visa/MC cap; consent text says "up to 3%"). `CARD_SURCHARGE_RATE = 0.03` is
  a deprecated legacy mirror — prefer the cents/bps API. The dollar amount displayed to the customer, the
  `amountCents` sent to Stripe (`Math.round(total * 100)`), and the
  `card_surcharge` recorded on the `payments` row must all derive from the
  same `computeChargeAmount(invoice.total, methodType, { funding })` call — the
  `funding` arg is required: the surcharge applies to confirmed **credit** cards
  only (`computeChargeAmount` returns a zero surcharge unless
  `opts.funding === 'credit'`; debit / prepaid / unknown / ACH pay the base). New
  ad-hoc `* 1.03`, `* 0.03`, or local rounding in pay/admin/autopay code
  will drift the three numbers apart and produce reconciliation breaks.
- **`isCardMethodType` is the surcharge classifier.** Adding a new payment
  method type (e.g. `cashapp`, `affirm`) without updating
  `isCardMethodType` in `server/services/stripe-pricing.js` silently surcharges
  it as card-family. Any diff that introduces a method type elsewhere must
  also update this function.
- **PI ↔ invoice ↔ webhook amount agreement.** `pay-v2.js` calls
  `/update-amount` to rewrite the PaymentIntent total when the customer
  switches between card and ACH in the Payment Element. The PI's
  `amount`, the invoice's `total`, and the webhook's recorded
  `payments.amount` must agree to the cent. A change that updates one
  without the others is a P0.
- **Terminal handoff burn must stay atomic.** The single
  `UPDATE terminal_handoff_tokens SET used_at = now() WHERE jti = ? AND used_at IS NULL AND expires_at > now()`
  in `server/routes/stripe-terminal.js:281-286` is the burn. Splitting this
  into `SELECT` + `UPDATE`, removing the `WHERE used_at IS NULL` clause, or
  moving the burn after the Stripe `paymentIntents.create` call lets two
  iOS devices share one mint and double-charge. The belt-and-suspenders
  claim/DB comparison at lines 330–350 must also stay — it catches
  cross-environment replay if the JWT secret leaks.
- **Handoff mint rate limit must be DB-enforced.** Per the comment at
  `stripe-terminal.js:26-46`, the per-tech mint ceiling is enforced in
  Postgres so it survives deploys and replicates across pods. Replacing it
  with an in-memory `Map` / `setInterval` / process-local counter is a P0.
- **Handoff TTL stays short.** `HANDOFF_TTL_SECONDS = 60` in
  `stripe-terminal.js`. Bumping it past ~5 minutes without explicit
  justification widens the leaked-token window for screenshot/sniff
  attacks. P0 unless the PR description argues for it.
- **`scheduled_services.status` is gated by a CHECK constraint, not a
  service helper.** Migration
  `server/models/migrations/20260426000004_relax_scheduled_services_status_enum.js`
  (migrations live under `server/models/migrations/`, run via
  `--knexfile server/knexfile.js`) rewrote the original
  5-value enum to:
  `pending | confirmed | rescheduled | en_route | on_site | completed | cancelled | skipped`.
  Direct `db('scheduled_services').update({ status: ... })` is the
  current pattern (admin-schedule.js, admin-dispatch.js) — there is
  no single helper today; an earlier sketch (`work-order-status.js`)
  was orphaned and removed (see #281). A diff that introduces a new
  status string without extending the CHECK via migration is P0
  (the write will throw at runtime; CI won't catch it). The audit
  trail lives in two tables: legacy `service_status_log` (status +
  lat/lng, no from→to) and the newer `job_status_history` from #280
  (full from→to with CHECK mirroring `scheduled_services.status`).
  New dispatcher / tech-mobile code should append to
  `job_status_history`; legacy callers stay on `service_status_log`.
- **`/api/admin/*` route files must apply admin auth at the router level.**
  Every existing admin route file starts with
  `router.use(adminAuthenticate, requireTechOrAdmin)` (or `requireAdmin`)
  imported from `server/middleware/admin-auth.js`. A new
  `server/routes/admin-*.js` file that omits this line, or removes it from
  an existing file, exposes admin endpoints unauthenticated. Per-handler
  middleware on each `router.get/post` is also acceptable, but missing it
  entirely is P0.
- **`/api/internal/*` (if introduced) must be authenticated.** The repo
  doesn't currently have an `/api/internal` mount; if a diff adds one, it
  must require either `adminAuthenticate` + `requireAdmin` or an
  HMAC-signed header check. An unauthenticated internal route is P0.
- **`/receipt/:token` permanence.** The receipt token is the same column
  as `invoices.token` and is intentionally permanent — customers re-share
  receipt links with bookkeepers for months. A diff that adds a `used` /
  `viewed_count` / `expires_at` gate to `/api/receipt/:token` or
  `/api/receipt/:token/pdf`, rotates `invoices.token` after payment, or
  requires auth on those endpoints is P0.
- **No string-interpolated user input in `db.raw`.** Knex query builders
  are parameterized; `.raw()` is not. `db.raw(\`… ${x} …\`)` or
  `db.raw('... ' + x + ' ...')` where `x` originates from `req.body /
  req.query / req.params` is a SQL-injection P0. `db.raw('... WHERE id = ?', [x])`
  and constant-string `db.raw('COUNT(*) as n')` are fine.
- **Card PAN, CVV, full SSN, or full Stripe `payment_method` objects in logs.**
  Both Railway logs and `errors.log` are plain text. Logging last4 is fine;
  the full PM object (which includes BIN/fingerprint) is not.
- **Hardcoded Anthropic model IDs.** Per `CLAUDE.md`, model IDs come from
  `server/config/models.js` (`FLAGSHIP` / `WORKHORSE` / `FAST` / `VISION`).
  A new string literal `'claude-opus-…'`, `'claude-sonnet-…'`,
  `'claude-haiku-…'`, or `'claude-3-…'` outside that file is P0 — it pins a
  tier to a model and defeats the env-var swap.

### Treat as P1

- **America/New_York timezone discipline.** Railway runs `TZ=UTC`; the
  portal is single-timezone Eastern. `server/utils/datetime-et.js` exposes
  `parseETDateTime`, `etParts`, `formatETDay/Date/Time`. Naive
  `new Date('2026-04-17T12:30').getHours()` reads UTC and drifts 4–5
  hours. Flag (P1) any new `new Date(\`${ymd}T${hm}\`).get*()`,
  `toLocaleString` without `timeZone: 'America/New_York'` on
  ET-wall-clock fields (schedule slots, business hours, appointment
  reminders, billing cron), or `node-cron` business-hour schedules
  without an explicit `timezone: 'America/New_York'` option.
- **PII in logs (non-card).** Phone, email, street address, full Twilio
  inbound SMS bodies, full customer names interpolated into log lines.
  Prefer ID-only logging
  (`logger.info(\`charged customer ${customerId}\`)`).
- **Floating promises in Express handlers.** Bare `someAsync()` inside
  `async (req, res) => { … }` that isn't awaited and isn't deliberately
  fire-and-forget. Mark intentional fire-and-forget with
  `void someAsync().catch(err => logger.error(...))`.
- **Feature-flag fail-closed.** `useFeatureFlag` in
  `client/src/hooks/useFeatureFlag.js` is fail-closed by design (returns
  `false` on API error). Adding `|| true`, `?? true`, `localStorage`
  overrides, or env bypasses is P1 (P0 if it auto-exposes a V2 admin
  page with broken data wiring to all users).
- **Don't delete the named-export utilities that V2 still consumes.**
  `client/src/pages/admin/SchedulePage.jsx`, `CustomersPage.jsx`,
  `EstimatePage.jsx`, and `CommunicationsPage.jsx` are retained as
  shared-utility modules after the V1→V2 migration. Their named exports
  (`CompletionPanel` / `RescheduleModal` / `EditServiceModal` /
  `ProtocolPanel` / `MONTH_NAMES` / `PRODUCT_DESCRIPTIONS` /
  `TRACK_SAFETY_RULES` / `stripLegacyBoilerplate` / `STAGES` /
  `STAGE_MAP` / `KANBAN_STAGES` / `LEAD_SOURCES` / `CustomerMap` /
  `CustomerIntelligenceTab` / `STATUS_CONFIG` / `PIPELINE_FILTERS` /
  `DECLINE_REASONS` / `classifyEstimate` / `getUrgencyIndicator` /
  `detectCompetitor` / `ALL_NUMBERS` / `NUMBER_LABEL_MAP`) are imported
  by V2 pages — touching them is a coordinated change.
- **Style-system mixing inside one file.** Per `CLAUDE.md`, Tier-2
  pages use the `D` palette + inline styles; Tier-1 V2 pages use Tailwind
  + `components/ui` primitives. A file that imports from `components/ui/*`
  and also defines a `D = { … }` palette object is mixing systems.
- **Retired-tool name re-introduction.** New imports, env vars, or string
  literals referencing **Square**, **Zapier**, **Make** (Integromat),
  **Elementor**, **NitroPack**, or **RankMath**. Stripe replaced Square;
  the Astro spoke fleet replaced WordPress + Elementor + RankMath; native
  automation replaced Zapier/Make. Existing references in untouched code
  are fine — flag only when the diff introduces or moves them.
- **`useFeatureFlag` polled in render hot paths.** Re-fetching the flag on
  every render of a list row (instead of once at the page boundary) is
  a P1 — the hook sessions-caches but still triggers re-renders.
- **Tier-1 V2 PRs that mix visual + content changes.** Per `CLAUDE.md`,
  visual-refresh PRs are strict 1:1 on data, endpoints, and metrics.
  Content / endpoint changes never share a PR with V2 visual changes.
- **`alert-fg` (red) used as decoration in admin V2.** Per `CLAUDE.md`,
  it's reserved for genuine alerts only.
  *Exception — Customers V2 status indicators (`/admin/customers` Directory +
  Customer 360):* health rings (≥70 green / 40–69 amber / <40 red), tier
  badges (Platinum/Gold/Silver/Bronze metals), and stage badge
  (green for `active_customer`/`won`, red for everything else) are
  intentionally color-coded for at-a-glance triage. Don't flag those.
- **Twilio `From`/`MessagingServiceSid` hardcoded.** Numbers per GBP
  location come from config; hardcoded `+1…` literals in route code drift
  when numbers move.

### Out of scope (do not flag)

- `client/dist/**` — built bundle, regenerated on deploy.
- `waves-customer-portal.tar.gz` — build artifact.
- `docs/design/DECISIONS.md` — append-only architectural log; new entries
  at the bottom are correct.
- `SESSION-*-AUDIT.md`, `TODO.md`, `errors.log` — working scratch.
- Cross-timezone concerns ("what if the user is in Pacific?"). The portal
  is Eastern-only.
- Style-of-existing-code refactors. Match the file. Don't rewrite legacy
  inline styles to Tailwind in a non-redesign PR.

## Context

- **Stack.** React 18 + Vite frontend, Express + Node.js backend with
  Knex.js, PostgreSQL on Railway. iOS WavesPay companion app under
  `ios/WavesPay/`. Spoke fleet of 15 Astro sites on Cloudflare
  Pages/Workers (separate repo concern).
- **Three portal surfaces.** `/admin/*` (owner/CSR), `/` (customer PWA),
  `/tech/*` (field tech).
- **Server timezone.** Railway runs `TZ=UTC`; the business runs in
  America/New_York. Always use `server/utils/datetime-et.js` helpers for
  ET-wall-clock fields. `node-cron` schedules pass
  `timezone: 'America/New_York'` explicitly.
- **Payment processor.** Stripe only — Payment Element (card / Apple Pay
  / Google Pay / ACH). Card-family pays a surcharge (up to 3%); ACH pays the base.
  Surcharge math is centralized in `server/services/stripe.js`
  (`computeChargeAmount`, `isCardMethodType`). Square is fully phased out
  and must not be reintroduced.
- **Webhooks.** Single Stripe webhook router at
  `server/routes/stripe-webhook.js`, mounted at `/api/stripe/webhook`
  before `express.json()`. Idempotency table:
  `stripe_webhook_events`.
- **Terminal handoff.** Tech mints a 60-second JWT via
  `POST /api/stripe/terminal/handoff`; iOS exchanges it via
  `POST /api/stripe/terminal/validate-handoff`, which atomically burns
  the `jti` row in `terminal_handoff_tokens` and verifies the JWT
  claims against the DB row.
- **Scheduled-service state machine.**
  Lifecycle gate is the `scheduled_services_status_check` CHECK
  constraint (migration `20260426000004`):
  `pending | confirmed | rescheduled | en_route | on_site | completed | cancelled | skipped`.
  Writers today are admin-schedule.js + admin-dispatch.js routes
  (direct `update({ status })`); no single helper. Audit log:
  legacy `service_status_log` and newer `job_status_history` (added
  in #280). The customer-visible state machine for the live tracker
  is a separate ENUM (`track_state`) on the same row, owned by
  `server/services/track-transitions.js` — that helper *is* canonical
  for tracker state and the en-route SMS fire.
- **Auth.** `server/middleware/admin-auth.js` exports `adminAuthenticate`
  + `requireAdmin` / `requireTechOrAdmin`. Every `admin-*.js` route file
  applies them at `router.use(...)` on line 1 of the router. JWT secret
  is `config.jwt.secret` (env: `JWT_SECRET`).
- **Public-by-token routes (no auth, by design).** `/api/pay/:token`,
  `/api/pay/statement/:token` (+ `/setup`, `/quote`, `/finalize`) — payer NET
  statement self-serve pay, **gated behind GATE_PAYER_STATEMENTS** (404 when off),
  64-hex `payer_statements.token` format gate + public-route rate limit; resolves
  a `payer_statements` row (never a homeowner record), charges the PAYER's Stripe
  customer only, exposes only the consolidated statement + serviced addresses
  already on it (no homeowner PII/links); settlement happens via the webhook,
  not the route,
  `/api/receipt/:token`, `/api/contracts/:token`, `/api/booking/*`,
  `/api/public/estimates/:token/ask`,
  `/api/public/estimates/:token/find-slots`, `/api/reports/:token/*`,
  the SPA `/recap/:token` "Your Visit, in Motion" recap player (token-gated; serves
  only an approved recap, consumes `/api/reports/:token/recap` + `/recap/video`,
  same noindex/no-referrer/no-store headers as `/report/:token`),
  `/api/stripe/webhook`, `/api/twilio/*-webhook`, `/api/bouncie-webhook`,
  `/api/sendgrid-webhook`, `/api/lead-webhook`,
  `/api/public/newsletter/*` (subscribe, confirm, unsubscribe, posts,
  posts/by-slug/:slug, rss, quiz/:token/:quizId/:answer — rate-limited,
  read-only for posts/rss, double-opt-in for subscribe; the quiz token is a
  per-recipient uuid `engagement_token` (newsletter_send_deliveries) — GET
  renders a confirm page only and the subscriber-tag write happens on a
  deliberate POST form submission (scanner-safe, mirrors confirm), answer key
  validated against the server-side quiz config, 30 req/min per IP, always
  returns 200 so it can't probe which tokens/answers are real),
  `/api/public/prep/:token` (read-only, 32-hex token format gate,
  60 req/min rate limit, privacy headers `no-store`/`noindex`/`no-referrer`,
  filters email-only blocks, server-side interpolation, generic 404),
  `/api/public/products` (read-only export; returns only active +
  customer_visibility=public + content_status=approved_for_public products;
  excludes pricing, vendor, SKU, dilution, MOA, inventory fields),
  `/api/service-outlines/:token` (approved/sent/viewed packets only,
  43-char base64url token format gate, 60 req/min read limit, 120 req/min
  CTA telemetry limit, privacy headers `no-store`/`noindex`/`no-referrer`,
  generic 404 for missing, draft, revoked, or malformed tokens),
  `/api/public/estimates/:token/deposit-intent` (required acceptance
  deposit; estimate token format gate, generic 404, 10 req/min limit,
  terminal/expired rejection, mirrors the accept-time quote gate so money
  is never collected for an estimate accept would reject, 409 for exempt
  policies, PaymentIntent idempotent per estimate+amount with
  metadata-pinned purpose/estimate id; dark behind
  ESTIMATE_DEPOSIT_REQUIRED).
  `/api/public/estimates/:token/card-hold-intent` (one-time card-on-file
  hold; estimate token format gate, generic 404, 10 req/min limit,
  terminal/expired rejection, mirrors the accept-time quote + one-time
  availability gates, 409 for exempt policies, customerless SetupIntent
  with metadata-pinned purpose/estimate id, NO money captured at booking —
  the saved card is charged on completion and a flat no-show fee only;
  dark behind ONE_TIME_CARD_HOLD).
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
  same pair is accepted by `/api/lead-webhook` with identical semantics).
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
  returns pricing only).
  `/api/public/ai-intake` (`GET /status` + `POST /message`) (the Ask Waves
  marketing-site chat brain — no auth, no token, **gated behind GATE_ASK_WAVES**
  (503 when off; fails closed in prod). Rate limits: 30 req/15min in-route on
  /message + a 120 req/day per-IP cap at the mount scoped to POST /message only
  (paid-LLM surface, same rationale as paidEstimatorDailyLimiter; GET /status
  is LLM-free and exempt so page-view gate checks from shared IPs can't lock
  out real chat turns). PII contract: requires NO PII and
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
  `/api/public/service-areas` (read-only canonical SWFL city list — no auth, no
  token, public `Cache-Control`. Consumed by the Astro build and the admin blog
  UI; no PII).
  `/api/public/credentials` (+ `/api/public/credentials/:slug`) (read-only
  canonical FDACS / license / insurance numbers — no auth, no token, public
  `Cache-Control`. Consumed by the Astro content build; intentionally public
  business credentials).
  `/api/public/automation-preview/:stepId/:token` (read-only; renders an
  automation step's HTML body with SAMPLE merge values only — no real customer
  data — for operator preview/share. Token in path, `noindex`).
  `/l/:code` (short-link resolver for every customer-facing short URL — 302 to
  target / 410 on expired / generic 404 with no enumeration leak; `noindex`).
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
  to its payload, in any state, as security-critical).
  `/api/reviews/featured` (read-only public featured Google reviews for the
  marketing site — no auth, no token, location filter + limit; reads
  `google_reviews` only).
  `/api/review/:token` (GET + POST; token-gated customer review flow — GET
  returns the review-request context by token, POST submits the customer's
  review. No auth beyond the review-request token).
  `/api/rate/:token` (+ `/:token/score`, `/:token/submit`,
  `/:token/generate-review`) (review-gate; token-scoped customer rating flow
  from a review-request link — high → the nearest GBP write-a-review URL, low →
  private feedback capture. No auth beyond the review-request token; picks
  nearest GBP by geocoded address. The bare `/api/rate` mount is not itself a
  route — only the token-scoped family is public).
  `/api/reports/project/:token/fdacs-pdf` (read-only; streams the filled, signed
  FDACS-13645 PDF for a WDO report so the public report page can show the official
  form instead of a blank template. Same long-lived report token + format gate as
  the sibling `/api/reports/project/:token/data` viewer
  (`extractProjectReportTokenLookup`), inherits the router-level 20 req/min
  `reportLimiter`, `no-store`/`noindex`/`no-referrer` privacy headers. Serves ONLY
  the already-emailed archived filing streamed from private S3 — never
  live/unsigned content — and returns a generic 404 for non-WDO projects, reports
  with no archived filing, or malformed tokens).
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
  unless the `?key=` query param matches `VOICE_RELAY_WS_SECRET` via a
  constant-time compare, so only Twilio carrying the configured secret can
  connect. Caller PII is masked in logs; lead writes require a valid E.164
  caller number (`capture_lead` tool + the capture-floor on session close).
  The live `/voice` backstop only routes a call here when the relay actually
  attached (`isRelayAttached`) AND the configured endpoint's scheme/host/path are
  trusted (`wss://` + this portal's own origin from `PUBLIC_PORTAL_URL` + the
  exact `/ws/voice-agent` path; `ws://localhost` for dev) — so the WS secret is
  never appended to a foreign host. Any change to this endpoint, its auth, or its
  frame handling is security-critical).
  New public routes outside this list are P0.
  The public estimate ask route must keep the estimate token format gate,
  a short-lived signed `askToken` bound to estimate id + estimate-token hash,
  terminal/expired-estimate rejection, public-route rate limits, no raw
  customer question/answer logging, and estimate-context-only answers.
  The estimate find-slots route is model-backed (parses a free-text "when"
  into a date window via Claude) and carries the same gate as ask: estimate
  token format gate, the short-lived signed `askToken`, terminal/expired
  rejection, public-route rate limit (15/min), and no raw query logging. It
  returns availability only (the same slot shape as available-slots) and never
  books.
  Contract links are short-lived bearer tokens for customer e-signature and
  must burn the token when signed.
  The `/api/reports/:token/*` family uses long-lived report tokens
  (`report_view_token` on `service_records`, 32-hex format enforced by
  `FULL_TOKEN_RE`). Writes on this family must: (a) gate state mutations on
  service_report_v1 + the report-token format check; (b) use atomic
  conditional updates for one-shot guards (e.g. one-rating-per-report uses
  `whereNull('client_pest_rating')` + 409 when 0 rows affected); (c) mirror
  the corresponding read-side eligibility check so a crafted POST can't
  store state for a report the customer can't see; (d) validate request
  bodies strictly before `Number()` coercion (raw `null`/`''`/`false`/`[]`
  must not coerce silently to 0); (e) ride the `reportEventLimiter`.
- **Receipt token permanence.** `/api/receipt/:token` reuses
  `invoices.token` and never expires or burns — customers share receipt
  links with bookkeepers months later.
- **Design tokens.** Two systems coexist by file:
  - **Legacy / Tier-2:** inline styles + `D` dark palette
    (`bg #0f1923`, `card #1e293b`, `border #334155`, `teal #0ea5e9`,
    `green #10b981`, `amber #f59e0b`, `red #ef4444`, `purple #a855f7`,
    `text #e2e8f0`, `muted #94a3b8`). Fonts: DM Sans, JetBrains Mono,
    Montserrat (tech).
  - **Tier-1 V2:** Tailwind zinc ramp + `components/ui` primitives,
    `border-hairline` chrome, type scale 11–28, `darkMode: false`,
    fontWeight 400/500 only. `alert-fg` red reserved for genuine alerts.
  - 14px text minimum on both. Customer-facing brand styling
    (Luckiest Guy / Baloo 2 / gold pill / mascot) is **not** applied
    inside `/admin/*`.
- **Anthropic model IDs.** Imported from `server/config/models.js`
  (`FLAGSHIP` / `WORKHORSE` / `FAST` / `VISION`). The three reasoning
  tiers currently resolve to `claude-opus-4-7`; `VISION` resolves to
  `claude-sonnet-4-6` because Opus 4.7 removed the `temperature`
  parameter and image scoring needs it. Tiers are env-swappable
  (`MODEL_FLAGSHIP` / `MODEL_WORKHORSE` / `MODEL_FAST` / `MODEL_VISION`,
  `INTELLIGENCE_BAR_MODEL` / `INTELLIGENCE_BAR_TECH_MODEL`). Never
  hardcode a model ID outside this file.
- **Feature flags.** `useFeatureFlag('<key>')` from
  `client/src/hooks/useFeatureFlag.js`. DB-backed
  (`user_feature_flags`), session-cached, fails closed. No localStorage,
  no percentage rollouts, no env variants.
