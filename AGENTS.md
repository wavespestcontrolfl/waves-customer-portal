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
  `server/services/stripe.js:39-47` is the single source of truth for the 3%
  card surcharge. The dollar amount displayed to the customer, the
  `amountCents` sent to Stripe (`Math.round(total * 100)`), and the
  `card_surcharge` recorded on the `payments` row must all derive from the
  same `computeChargeAmount(invoice.total, methodCategory)` call. New
  ad-hoc `* 1.03`, `* 0.03`, or local rounding in pay/admin/autopay code
  will drift the three numbers apart and produce reconciliation breaks.
- **`isCardMethodType` is the surcharge classifier.** Adding a new payment
  method type (e.g. `cashapp`, `affirm`) without updating
  `isCardMethodType` in `server/services/stripe.js:31-37` silently surcharges
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
- **Scheduled-service status changes go through `work-order-status.transition`.**
  Direct `db('scheduled_services').update({ status: ... })` outside
  `server/services/work-order-status.js` skips the
  `ALLOWED_TRANSITIONS` check (lines 21–31) and skips the
  `service_status_log` audit insert. The canonical lifecycle is
  `scheduled → en_route → on_site → in_progress → completed → invoiced → paid`,
  with `cancelled`/`rescheduled` branches that can only return to
  `scheduled`. A diff that direct-updates status — or that adds a new
  status string without extending `VALID_STATUSES` and the transitions
  map — is a P0 (silent illegal transitions corrupt dispatch + revenue
  reporting).
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
  `server/config/models.js` (`FLAGSHIP` / `WORKHORSE` / `FAST`). A new string
  literal `'claude-opus-…'`, `'claude-sonnet-…'`, `'claude-haiku-…'`, or
  `'claude-3-…'` outside that file is P0 — it pins a tier to a model and
  defeats the env-var swap.

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
- **Don't delete V1 components or named exports while V2 is flag-gated.**
  The flags `dashboard-v2`, `dispatch-v2`, `customers-v2`, `estimates-v2`,
  `comms-v2`, and `mobile-shell-v2` still serve V1 to flag-off users.
  Removing a V1 component file, named export, or prop while the flag is
  live breaks them.
- **Style-system mixing inside one file.** Per `CLAUDE.md`, V1/Tier-2
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
  / Google Pay / ACH). Card-family pays a 3% surcharge; ACH pays the base.
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
  `server/services/work-order-status.js` defines `VALID_STATUSES` and
  `ALLOWED_TRANSITIONS`. All status changes route through
  `transition()`, which writes to `service_status_log`.
- **Auth.** `server/middleware/admin-auth.js` exports `adminAuthenticate`
  + `requireAdmin` / `requireTechOrAdmin`. Every `admin-*.js` route file
  applies them at `router.use(...)` on line 1 of the router. JWT secret
  is `config.jwt.secret` (env: `JWT_SECRET`).
- **Public-by-token routes (no auth, by design).** `/api/pay/:token`,
  `/api/receipt/:token`, `/api/booking/*`, `/api/stripe/webhook`,
  `/api/twilio/*-webhook`, `/api/bouncie-webhook`,
  `/api/sendgrid-webhook`, `/api/lead-webhook`. New public routes outside
  this list are P0.
- **Receipt token permanence.** `/api/receipt/:token` reuses
  `invoices.token` and never expires or burns — customers share receipt
  links with bookkeepers months later.
- **Design tokens.** Two systems coexist by file:
  - **Legacy / V1 / Tier-2:** inline styles + `D` dark palette
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
  (`FLAGSHIP` / `WORKHORSE` / `FAST`). All currently resolve to
  `claude-opus-4-7`; tiers are env-swappable
  (`MODEL_FLAGSHIP` / `MODEL_WORKHORSE` / `MODEL_FAST`,
  `INTELLIGENCE_BAR_MODEL` / `INTELLIGENCE_BAR_TECH_MODEL`). Never
  hardcode a model ID outside this file.
- **Feature flags.** `useFeatureFlag('<key>')` from
  `client/src/hooks/useFeatureFlag.js`. DB-backed
  (`user_feature_flags`), session-cached, fails closed. No localStorage,
  no percentage rollouts, no env variants.
