# AGENTS.md

Code-review rules for automated agents (Codex, ultrareview) auditing diffs in
the **waves-customer-portal** monorepo. Rules are derived from the actual code
in this repo and the failure modes that have shipped or come close to
shipping. Each rule cites the file it protects.

Codex integration reference:
<https://developers.openai.com/codex/integrations/github>

The pre-push hook at `scripts/hooks/pre-push` (wired via `core.hooksPath` by
the npm `prepare` script) blocks pushes that contain any P0
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
  currently **2.9%** (`CONFIGURED_COST_BPS = 290` since PR #1836, capped at the
  `NETWORK_CAP_BPS` 3% Visa/MC cap; consent text v8 says "up to 2.9%"). `CARD_SURCHARGE_RATE = 0.03` is
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
  in `server/routes/stripe-terminal.js:418-423` is the burn. Splitting this
  into `SELECT` + `UPDATE`, removing the `WHERE used_at IS NULL` clause, or
  moving the burn after the Stripe `paymentIntents.create` call lets two
  iOS devices share one mint and double-charge. The belt-and-suspenders
  claim/DB comparison immediately after the burn must also stay — it catches
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

- **Blind `content[0].text` on a raw Anthropic response.** Reasoning-capable
  models may lead with a `thinking` / `redacted_thinking` block, which has no
  `.text` — so `response.content[0].text` reads `''` and the real answer sits
  in `content[1]`. Whether a thinking block appears is INPUT-dependent, not
  tier-dependent: a trivial probe prompt returns a single text block on every
  tier, so this does not reproduce in a smoke test. It fails silently — the
  caller sees empty output and takes its "model returned nothing" branch.
  When #2814 moved `WORKHORSE`/`FAST` from opus-4-8 to sonnet-5 (2026-07-18)
  this killed all 10 Claude-backed event sources for 7 days (newsletter
  autopilot starved to 1 eligible event and skipped a week) and silently
  disabled AI lead triage, with no error anywhere but a generic
  "did not return parseable JSON". Flag (P1) any new raw
  `client.messages.create` whose result is read via `content[0]` without
  `stripThinkingBlocks` (`server/services/llm/deep.js`) — or, better, that
  does not go through the `llm/` helpers at all. A model-tier swap is a
  breaking change for every raw call site.
- **America/New_York timezone discipline.** Railway runs `TZ=UTC`; the
  portal is single-timezone Eastern. `server/utils/datetime-et.js` exposes
  `parseETDateTime`, `etParts`, `formatETDay/Date/Time`. Naive
  `new Date('2026-04-17T12:30').getHours()` reads UTC and drifts 4–5
  hours. Flag (P1) any new `new Date(\`${ymd}T${hm}\`).get*()`,
  `toLocaleString` without `timeZone: 'America/New_York'` on
  ET-wall-clock fields (schedule slots, business hours, appointment
  reminders, billing cron), or `node-cron` business-hour schedules
  without an explicit `timezone: 'America/New_York'` option.
- **Hardcoded near-today calendar dates in tests.** A test that sends a
  date literal through a not-in-the-past validator (e.g. Joi
  `.min(todayStartEt)`) goes red the night the ET calendar passes it —
  `schedule-confirm-race.test.js` broke exactly this way at the 2026-07-23
  ET rollover with no code change on the branch. Tests must compute
  relative dates (`Date.now() + N days`) for any value a freshness/past
  check validates; date literals are fine only for stored/historical
  fixture fields no validator inspects.
- **PII in logs (non-card).** Phone, email, street address, full Twilio
  inbound SMS bodies, full customer names interpolated into log lines.
  Prefer ID-only logging
  (`logger.info(\`charged customer ${customerId}\`)`).
- **Floating promises in Express handlers.** Bare `someAsync()` inside
  `async (req, res) => { … }` that isn't awaited and isn't deliberately
  fire-and-forget. Mark intentional fire-and-forget with
  `void someAsync().catch(err => logger.error(...))`.
- **No `{ virtual: true }` jest mocks of real modules.** A virtual mock
  registers under a synthesized name key instead of the resolved module
  path; in a shared jest worker whose resolver was warmed by an earlier
  suite, the module under test can require the REAL package and bypass
  the mock — order-dependent, so it passes locally and goes red only in
  CI (2026-07-18 incident: `google-ads-sync.test.js` drove the real
  `google-ads-api` into a live OAuth call, #2843). Flag (P1) any
  `jest.mock(name, factory, { virtual: true })` where `name` actually
  resolves (installed package or existing relative file). `virtual` is
  only for modules that genuinely don't exist — e.g. the
  `./stripe-webhook-helpers` mock in
  `server/tests/stripe-webhook-refund-failed.test.js:29`.
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
- **Permission-allowlist entries must account for npm lifecycle hooks,
  wildcard sweep, and destructive flag variants.** `.claude/settings.json`
  `permissions.allow` (and command-frontmatter `allowed-tools`) entries
  auto-approve every variant the pattern matches. Flag any addition of:
  (a) an npm wrapper script whose `pre`/`post` hooks (check `package.json`)
  write to the DB, call external APIs, or spend money — root `predev` runs
  `db:migrate`, so `npm run dev` auto-approves a DB write;
  (b) a wildcard over a script family that mixes safe and spending
  commands — `npm run check:*` swept in `check:lawn-models`, which POSTs
  live prompts to three LLM providers;
  (c) a prefix rule over a command with destructive flags or subcommands —
  `git branch:*` includes `-D`/`-M`, `git push:*` includes
  `--no-verify`/`-f`/`-d` (bypasses the Codex pre-push gate),
  `git fetch:*` accepts ref-moving refspecs, `gh api:*` can POST.
  Prefer exact command forms (`dev:client` not `dev`; `check:portal-brand`
  not `check:*`; `git branch --show-current` not `git branch:*`).
  Syntax trap: a trailing `:*` (equivalent to ` *`) enforces a word
  boundary — `npm run test:*` matches `npm run test -x` but NOT
  `npm run test:contracts`; colon-named scripts need exact entries.
  Known sharp edges already ruled on: `git ls-remote:*` allows
  `--upload-pack=<exec>` (arbitrary code execution), `gh pr create` can
  itself push an unpushed branch, `gh pr comment:*` includes
  `--delete-last`, and `npm run dev:server` boots `initScheduledJobs()`
  with `cronJobs` defaulting ON outside prod; `npm ci` executes dependency
  lifecycle scripts (`hasInstallScript` packages = remote code on a
  lockfile change); `npm run models:check` sends `ANTHROPIC_API_KEY` to
  api.anthropic.com; `npm run test:contracts` runs `execute-smoke` by
  default, calling IB ops tools that make authenticated
  Stripe/Twilio/GitHub/Cloudflare requests when secrets are loaded
  (`test:contracts:list` is the safe variant) — none of these may be
  pre-approved.
  *Accepted residual risk (owner ruling 2026-07-16, PR #2768):*
  high-frequency LOCAL read/stage commands stay as prefix rules
  (`git status/diff/log/show/add/commit:*`) despite write-capable flags
  (`--output`, `-A`, `--amend`) — damage is local, reversible, and
  visible in `git status`/`git diff` before push, and the containment
  boundary is the always-prompting `git push`. Do not re-flag these
  specific prefix rules; DO flag any new prefix rule whose abuse is
  remote, irreversible, or invisible.
- **`ops/agents/` convention violations.** Scripts in that folder must
  declare READ-ONLY or MUTATES in their header, default to dry-run when
  they mutate (write only under `--execute`), and contain no secrets,
  tokens, customer names, or invoice numbers. See `ops/agents/README.md`.
- **Customer PII in the repo itself.** Customer names, lead addresses, or
  live payload dumps must never appear in code, tests, migration headers,
  commit messages, or PR bodies — reference accounts by id. (One violation
  forced a branch history rewrite.) Same class as the PII-in-logs rules
  above, but for the repo surface.
- **"Per application" price copy.** Customer-facing price units read
  "per application", never "per visit", and no combined plan totals
  ("$X/mo" / "$X/yr") appear on any customer-facing estimate surface
  (owner rule re-affirmed 2026-07-23). Invoice/prepay surfaces and
  commercial proposals are exempt; true monthly-billed legacy plans keep
  "/mo". No service is ever presented as a flat monthly spread.
  One owner-dictated exception (2026-08-13, iterated live on the rendered
  page): the service-report cross-sell card HEADLINE shows the bare
  per-application amount with no unit ("… protected for just $114!") —
  the owner cut the unit deliberately after the "per visit" flag, and the
  request flow behind the click confirms full per-application terms before
  anything is scheduled (moving to the estimate page itself in the
  click-to-estimate PR). The exception is the missing UNIT only: the
  number is still the per-application amount, and "per visit" and monthly
  spreads stay banned here like everywhere else.
- **Appointment windows start on the hour.** `window_start` is always
  HH:00:00 (owner 2026-07-27) — flag any slot/window creation that can
  produce :15/:30 STARTS. `window_end` is duration-driven and may
  legitimately land off-hour (`classifySlot` in
  `estimate-slot-availability.js` produces a 10:30 end for a 90-min
  service at 09:00 — regression-asserted); never round or reject it.
  GAP CLOSED (2026-08-03): the lead-booking path (`LeadsTabs.jsx` time
  input → `admin-leads.js`) now REJECTS off-hour starts at the handler
  entry (#3056, `Appointment windows start on the hour (HH:00)`), so
  `windowStart` downstream of that guard is always hour-aligned.
  Customer-facing arrival copy is
  `window_start` → +120 min, DISPLAY-ONLY, via `arrivalWindowRange()`
  (`server/utils/sms-time-format.js`); never change `window_end` itself
  (it drives scheduling/overlap), and report "next appointment" displays
  follow the same +2h rule.
- **Email-change token fanout.** When a customer's email moves, the
  fanout ROTATES email-bound subscriber tokens
  (`newsletter_subscribers.confirmation_token` / `unsubscribe_token`,
  `customer-email-fanout.js`); never retarget unlinked sends by email
  address alone. KNOWN GAP (2026-07-29): per-delivery
  `newsletter_send_deliveries.engagement_token` values are NOT yet
  rotated — don't describe them as rotating, and flag diffs that widen
  what an old emailed token can reach. Permanent public artifacts are
  explicitly exempt from rotation — `invoices.token` receipt links never
  rotate (see the receipt-permanence P0 above).
- **Compliance language on any customer surface** (portal copy, prep
  guides, reports, estimator benefit lines, marketing): no pesticide is
  ever "safe" (incl. "pet-safe"/"family-safe"); "EPA-registered"/"EPA-
  exempt", never "EPA-approved"; never a fixed re-entry/drying minute
  figure — the idiom is "safe once dry" + technician confirms timing.
  When one instance of a banned claim class appears, sweep the whole tree
  for the class. Existing violations in untouched code are a remediation
  backlog, not proof the rule is wrong — flag diffs that ADD or EXTEND
  such copy. Known outstanding as of 2026-07-29: the `/api/feed/faq`
  pet-safe/drying-minutes copy (`server/routes/feed.js` ~474) and the
  PortalPage FAQ — a copy-sweep fix is owed.
- **Estimate follow-up truth scope** (`estimate-followup-copy.js`):
  recurring residential lanes get the callbacks/90-day/no-contract line;
  rodent/termite/commercial/bundle/unknown packs are terms-neutral —
  termite NEVER gets recurring terms; copy failures fail soft to
  'unknown' and never block a send.
- **Report/track egress.** Access/gate/lockbox codes are deliberately
  EXCLUDED from customer-facing service reports (`report-copy-context.js`)
  — keep it that way. Raw `technician_notes` never egress on any report
  path (parser-approved copy only). The `/api/public/track/:token` payload
  masks email/phone server-side — do not un-mask.
- **WDO + pre-treatment termite certificates are FDACS paper compliance
  documents** — no AI narrative, no ask bar, conservative surfaces.
  ("Infestation extent" is legitimate FDACS terminology on the WDO page
  even though it's banned copy elsewhere.)
- **Call pipeline do-not-regress** (`call-recording-processor.js` and the
  extraction/routing stack):
  - Call-created bookings must resolve to a real `services` catalog row
    (`service_id` set); no confident match → book "Waves Assessment";
    never an invented/coarse `service_type` with a null `service_id`.
  - Recurring intent beats the single presenting pest
    (`applyRecurringIntentDefault`): ambiguous/unstated cadence →
    Quarterly; the backstop is upgrade-only; an explicit "just one-time"
    keeps the single service; general-pest scope only.
  - Only `scheduling.status === 'confirmed'` maps to a booked appointment
    — "do you have availability Friday?" is not an appointment.
  - Extraction schema changes are ADDITIVE-ONLY: update both schema JSONs
    (model-output + persisted) + normalizer pass-through + persisted enum
    + SCHEMA_VERSION bump; never add to `required`; new fields join the
    replay FIELD_GROUPS; prompt-hash bumps reset the promotion cohort;
    downstream composers read enriched/v2 extraction + raw transcript,
    never v1.
  - Address-validation routing: only `hasReplacedComponents` counts as a
    correction (`hasInferredComponents` is benign on nearly every clean
    address); never `validated_accept`/`corrected` unless
    `inServiceArea === true`; AV unreachable → hold for review, never
    silent auto-route.
  - A `PREMISE`-granularity verdict whose only missing component is
    `subpremise` is a resolved building without its unit, NOT a garbled
    street — never feed it to street recovery (`avMissingUnitOnly`
    guard). There is no mis-hearing to find, so a "successful" recovery
    can only confirm a DIFFERENT real address and turn the caller's
    ambiguous hold into an accepted wrong-parcel booking. It holds for
    review with `missing_unit_number` naming the ask.
  - An owed ask is auto-closed only by evidence that answers THAT ask,
    not merely evidence of the same KIND. `missing_unit_number` gets no
    auto-resolution for exactly this reason: a later call validating
    some unit at the building cannot be attributed to an earlier
    unit-less ask (a landlord's unnamed unit A, then a call about unit
    B), because the earlier extraction has no unit to tie it to. It
    joins the owed-confirmation family in `triage-auto-resolve.js` —
    resolved by a human verdict, never aged out, never mooted.
  - Auto-routing stays confidence-gated (auto-create only when confidence
    ≥ threshold AND the address validates AND the service maps AND no
    HOA/commercial flag — else triage), appointment inserts keep their
    idempotency keys, and TCPA consent is checked before any SMS (email
    fallback).
  - Hard-bounced call-captured emails are re-verified against the
    recording and surfaced for owner read-back — never auto-corrected or
    auto-resent.
- **Estimator engine authority.** `generateEstimate` is the SOLE dollar
  authority — LLM output proposes intent only and never reaches
  proposal/price fields; engine drafts never auto-send; existing customers
  are blocked from engine drafting; engine low-confidence markers
  (fpSource fallback, low pricingConfidence, turfBasis fallbacks) route to
  the review lane, never auto-apply. Caller-stated unit size +
  `relationship_to_property: tenant` outrank county building sqft for
  commercial tenants.
  - OWNER-APPROVED EXCEPTION (ruling 2026-08-13, click-to-estimate lane):
    a PRICED cross-sell tap (`GATE_REPORT_CLICK_TO_ESTIMATE`) mints a
    customer-viewable estimate for the tapping customer — including an
    existing member — because the customer is the one initiating on a
    price the card already showed. Bounds that keep the rule's intent:
    no LLM in the loop (the offer matrix is deterministic); only
    `optionIsPriceable` offers reach the mint (manual-review and
    low-confidence offers were already demoted to the unpriced CTA);
    the recomputed per-application price must match the shown price to
    the cent or the mint refuses; the estimate is published with ZERO
    delivery — no send, no follow-up automation, no customer comms.
    "Never auto-send" stands everywhere else.
- **Lawn-diagnostic lockstep.** The four artifacts (CONDITION_LABELS /
  SUMMARY_CAUSE_RE / CONFIRMABLE_CONDITION / the GOVERNED_CAUSE test) must
  stay mirrored, plural-aware; customer-facing egress is
  confidence-gated/allowlisted — never publish client- or LLM-supplied
  `customer_wording`, and persist ignores client provenance.
- **Lawn protocol data fan-out.** A product/protocol change must reach
  BOTH sources of truth (the field-exec `protocols.json` AND the DB
  operating layer: `lawn_protocol_products` rates/gates + windows) plus
  `products_catalog` (seeded rates must match `default_rate_per_1000`;
  lowercase category; `epa_reg` NOT NULL and never guessed), pricing.csv,
  and the plan-matcher. Premium/optional rows are `default_in_plan:false`
  + a conditional gate. Never write a full product name into parsable
  protocol disclaimer lines (negated disclaimers re-add it via substring
  match), and never bulk-import the legacy 4-turf workbook.
- **Booking conflict-check class.** Tech-scoped conflict WHEREs are blind
  to technician-NULL rows (the `filterCollidingSlots` class) — every new
  booking/reschedule surface needs the mirror guard.
- **Condo aggregation guards.** Never remove the `parcel.aggregated`
  branch ahead of `countyUseDescToPropertyType` (associations would price
  as one residential unit), and don't lower `AGGREGATE_MIN_UNITS` (5).
- **Twilio number classification.** `TWILIO_NUMBERS.findByNumber` reports
  the AI toll-free number as `type:'location', locationId:'bradenton'` —
  "location numbers only" logic must ALSO exclude the AI number
  explicitly.
- **Admin OAuth pattern.** Admin auth is bearer-only (`Authorization`
  header from `localStorage.waves_admin_token` — no cookie/query
  fallback). An admin "connect" endpoint must return the consent URL as
  JSON for the SPA to navigate; a bearer-protected `res.redirect`
  hard-401s on top-level navigation. The OAuth callback validates via a
  one-time `state` nonce, not bearer.
- **New `@waves/*` CJS workspace packages** must join
  `optimizeDeps.include` + `build.commonjsOptions.include` in
  `client/vite.config.js`, or linked packages fail Rollup named-export
  analysis in prod builds.
- **Company name in written copy** is "Waves Pest Control" — never
  "Waves Lawn & Pest". The mascot logo artwork carrying the old name is
  current and intentional; do not flag it.

### Implementation defaults

Authoring defaults for any agent writing code in this repo. Reviewers flag
violations at the severity noted.

- **Choose the simplest implementation that fully meets the current
  requirements.** No speculative abstraction: no config options nobody
  asked for, no generic handlers with a single call site, no interfaces
  with one implementation, no "future-proofing" layers for requirements
  that aren't in the task. Flag as P2.
- **No compat shims for code changed in the same PR.** When a change
  renames or reshapes something internal, migrate every call site in the
  same PR — no deprecated wrappers, re-export aliases, or dual code paths
  left behind for callers this repo controls. Flag leftover internal
  compat scaffolding as P2. The inverse is MANDATORY for anything an
  external consumer can touch: deployed native apps (iOS WavesPay,
  Android), in-flight tokenized links (pay / receipt / estimate /
  contract / report / prep), astro-fleet form posts, webhook payloads,
  and existing DB rows must keep working — breaking those is P0 (see the
  public-route, receipt-permanence, and astro-consumer rules).
- **Use existing dependencies instead of hand-rolling; no new
  dependencies without owner approval.** Don't write a custom
  implementation of something a library already in `package.json`
  provides (date/timezone handling, validation, retries, parsing).
  Adding a NEW dependency is a supply-chain and upgrade-surface decision:
  the PR body must name it and why, and it needs Adam's explicit
  approval. A new `package.json` entry not called out in the PR
  description is P1.
- **Find and extend the existing mechanism; don't build a parallel
  one.** The in-repo counterpart of the dependency rule above: before
  implementing behavior the repo likely already has (a status writer, a
  cron sweep, an approval/email path, a rate limiter, a dedupe stamp, a
  date util), locate the existing mechanism and extend its coverage —
  don't add a sibling that serves the same purpose. A diff introducing a
  second mechanism for a purpose an existing one already serves is P1
  unless the PR body names the existing mechanism and explains why it
  can't be extended. (Instances rated P0 elsewhere in this file — e.g. a
  second Stripe webhook mount — keep their P0 severity.)

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
- Settled owner rulings — do not re-flag or re-propose: the one-time
  completion gate stays removed (#3013); `ESTIMATE_DEPOSIT_REQUIRED` stays
  off (Auto Pay opt-in replaced required deposits); lawn IS
  WaveGuard-tier-discountable (2026-07-28); deposit `deposit_credit`
  ledger credits face value; missed surcharges are forward-only (no
  clawback).

## Context

- **Stack.** React 18 + Vite frontend, Express + Node.js backend with
  Knex.js, PostgreSQL on Railway. iOS WavesPay companion app under
  `ios/WavesPay/`. Spoke fleet of 15 Astro sites on Cloudflare
  Pages/Workers (separate repo concern).
- **Three portal surfaces.** `/admin/*` (owner/CSR), `/` (customer PWA),
  `/tech/*` (field tech).
- **Operator/agent tooling.** Recurring prod-ops scripts (token pulls,
  Railway var hygiene, audit purges) live in `ops/agents/` — not imported
  by app code, invoked manually from the repo root. Index and conventions:
  `ops/agents/README.md`.
- **Server timezone.** Railway runs `TZ=UTC`; the business runs in
  America/New_York. Always use `server/utils/datetime-et.js` helpers for
  ET-wall-clock fields. `node-cron` schedules pass
  `timezone: 'America/New_York'` explicitly.
- **Payment processor.** Stripe only — Payment Element (card / Apple Pay
  / Google Pay / ACH). Card-family pays a surcharge (up to 2.9%); ACH pays the base.
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
  applies `adminAuthenticate` at `router.use(...)` on line 1 of the router
  (verified across all 207 mounted routers, 2026-08-07: none lacks auth
  entirely; `adminAuthenticate` itself enforces active staff role ∈
  {admin, technician}, rejects terminal-scope JWTs, and checks
  token-version revocation). The ROLE half is NOT universal: known files
  applying `adminAuthenticate` without a role middleware are
  `admin-health.js`, `admin-knowledge-bridge.js`,
  `admin-pricing-strategy.js` (imports requireTechOrAdmin, never uses it),
  and `tool-health.js` — technician-level reach into admin-intended pages,
  a consistency defect rather than an unauthenticated hole. New admin
  routers must pair both. JWT secret is `config.jwt.secret`
  (env: `JWT_SECRET`).
- **Public-by-token routes (no auth, by design).** `/api/pay/:token`
  (+ `/setup`, `/quote`, `/finalize`, `/confirm`, `/consent`,
  `/capture-setup`, `/setup-complete`, `/update-amount`, `/error`,
  `/invoice.pdf`, `/attachments/:id` — the invoice pay surface; router-wide
  60/min limiter + url-safe 20-64 token format gate with generic 404,
  mirroring pay-statement.js; legacy 25-32 char invoice tokens remain
  valid),
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
  `/api/stripe/webhook`, `/api/webhooks/twilio` (all Twilio inbound),
  `/api/bouncie` + `/api/webhooks/bouncie`, `/api/webhooks/sendgrid`,
  `/api/webhooks/resend` (Svix-signed), `/api/webhooks/lead`
  (+ `POST /api/leads`, an alias accepting the same pair with identical
  semantics),
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
  `/api/public/prep/:token` (read-only, 32-hex token format gate,
  60 req/min rate limit, privacy headers `no-store`/`noindex`/`no-referrer`,
  filters email-only blocks, server-side interpolation, generic 404),
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
  ESTIMATE_DEPOSIT_REQUIRED is unset only AFTER this lights).
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
  send, generic errors — no PII in responses or logs).
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
  row, and gate-off are indistinguishable — 5 req/hr per-IP limit, dark
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
  with identical semantics).
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
  `/api/documents/shared/:token` (read-only shared-document fetch incl.
  on-the-fly service-report PDFs — customer PII by design; 64-hex format
  gate, 24h expiry with 410, access-count audit, 30/15min limiter,
  `no-store`).
  `POST /api/stripe/terminal/validate-handoff` (machine-to-machine burn of
  the 60s single-use handoff JWT — the token IS the auth; see the atomic
  burn rule above).
  `/api/admin/push/vapid-key` (GET; deliberate — the VAPID public key is
  public by protocol).
  `/api/health` (GET; liveness probe, no data).
  `/api/integrations/*-worker` mounts (hermes workers; each authenticates
  via its own HMAC-signed header check inside the router — an
  unauthenticated internal route here is P0).
  The auth/OAuth login family (`/api/auth/login`, refresh, OAuth
  callbacks) is public by definition and rate-limited via
  `unauthenticatedAuthLimitKey`.
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
  server-derived arrival range, plan/one-time flag, confirmed flag) plus
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
  `/api/public/reschedule/:token` (GET + POST, plus `POST /:token/find-slots`;
  customer self-serve reschedule linked from appointment
  confirmation/72h/24h texts + reminder emails.
  `scheduled_services.reschedule_token` (64-hex, `TOKEN_RE` format gate)
  is the ONLY gate, plus 60 req/min router limit and 10 req/min on the POST.
  GET returns the appointment summary (customer first name, service type,
  current date/window, recurring flag, `missed` flag, and — series visits
  only — the `reanchorPullForwardDays` threshold) + live open slots from the
  /book availability engine. POST is a WRITE with two owner-authorized
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
  review. No auth beyond the review-request token).
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
  `/api/public/secure-card/:token` (+ `/:token/complete`, `/:token/select-plan`) (GET + POST;
  "secure your appointment" card-on-file capture page for the
  appointment-card-request funnel — dark until `APPOINTMENT_CARD_REQUEST`
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
- **AI model IDs and generated-text fallback.** All IDs live in
  `server/config/models.js`. Cost-aware Anthropic tiers are Opus 4.8 for
  `FLAGSHIP`/`DEEP`, Sonnet 5 for `WORKHORSE`/`FAST`/`VOICE`, Sonnet 4.6 for
  `VISION`, and explicit-only Fable 5 for `EXTREME`. Generated text uses a
  named `TEXT_POLICIES` entry through `services/llm/call.js`; every policy
  must cross OpenAI and Anthropic, and the dispatcher rejects a same-provider
  fallback. Reports are Sol → Opus; customer/content copy is Sonnet → Terra;
  structured high-volume work is Luna → Sonnet. Never hardcode a model ID
  outside the registry.
- **Feature flags.** `useFeatureFlag('<key>')` from
  `client/src/hooks/useFeatureFlag.js`. DB-backed
  (`user_feature_flags`), session-cached, fails closed. No localStorage,
  no percentage rollouts, no env variants.
