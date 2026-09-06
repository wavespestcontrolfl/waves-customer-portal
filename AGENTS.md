# AGENTS.md

Code-review rubric for the automated reviewers that audit diffs in the
**waves-customer-portal** monorepo: the Codex pre-push hook, the `@codex`
GitHub bot, and ultrareview. Every rule names the failure it prevents and
the file it protects. Automated review invocations return JSON matching
`.github/codex-review-schema.json` and cite `file:line` for every finding.
Other tasks use the user's requested response format. Coding agents follow
the applicable invariants and Implementation defaults below.
The pre-push hook (`scripts/hooks/pre-push`, wired via `core.hooksPath` by
`npm prepare`) blocks a push on any P0 and warns on P1.

**Budget: this file stays under 30 KB** — `npm run check:domain-rules`
fails when it grows past that. Codex limits automatically loaded project
instructions to the configured project-document budget; the default is
32 KiB across the loaded project instruction chain. Repo orientation lives
in `CLAUDE.md`, procedures live in `.claude/skills/*`, and the per-route
security contracts live in `docs/public-route-contracts.md`. Do not
duplicate them here; point at them.

For coding work, read `CLAUDE.md` before editing and load only the relevant
skills and reference sections. For an audit or explanation, read applicable
rules as evidence; do not execute the workflows they describe.

## Codex local database policy

- Never point a Codex session at production. Use a Railway dev/preview
  Postgres `DATABASE_URL`. Managed `npm run dev` checks database readiness
  without migrating; setup and explicit `dev:migrate` live in
  `docs/development.md`. With no dev database, verify frontend-only work with
  `npm run dev:client` or `npm run build` and say in the PR summary that
  migrations were not run. Backend or migration work needs a real dev
  `DATABASE_URL` before claiming end-to-end DB verification.

## Treat as P0

- **Stripe webhook raw-body order.** `server/routes/stripe-webhook.js`
  mounts `express.raw({ type: 'application/json' })` and is registered
  **before** the global `express.json()` in `server/index.js`. Moving the
  mount after the JSON parser, swapping `raw` for `json`, or feeding a
  parsed object into `stripe.webhooks.constructEvent` breaks signature
  verification — every webhook 400s silently in prod.
- **Stripe webhook idempotency.** Every event is deduped against
  `stripe_webhook_events.id` before its handler runs. Removing the dedupe
  `SELECT`, marking `processed=true` before the handler succeeds, or
  short-circuiting the insert lets a Stripe retry double-charge,
  double-refund, or double-create `payments` rows.
- **No second Stripe webhook router.** All Stripe events flow through the
  one mount at `/api/stripe/webhook`. A `/webhook-v2` or per-event mount
  bypasses the central idempotency table.
- **Webhook secret presence.** A falsy `stripeConfig.webhookSecret` must
  reject with 500 and never call `constructEvent`. Defaulting the secret
  to `''` or accepting unverified events is a forged-event vector.
- **Surcharge math comes from `computeChargeAmount`.**
  `server/services/stripe-pricing.js` is the single source of truth for
  the card surcharge (`CONFIGURED_COST_BPS = 290`, capped by
  `NETWORK_CAP_BPS`; consent copy says "up to 2.9%"; `CARD_SURCHARGE_RATE`
  is a deprecated mirror). The surcharge applies only when
  `opts.funding === 'credit'` — debit, prepaid, unknown, and ACH pay the
  base. The amount shown to the customer, the `amountCents` sent to
  Stripe, and the `card_surcharge` on the `payments` row must all derive
  from one `computeChargeAmount(invoice.total, methodType, { funding })`
  call. Ad-hoc `* 1.03`, `* 0.03`, or local rounding drifts the three
  numbers apart and breaks reconciliation.
- **`isCardMethodType` is the surcharge classifier.** A new payment method
  type (`cashapp`, `affirm`, …) that is not added to `isCardMethodType` in
  `stripe-pricing.js` is silently surcharged as card-family.
- **PI ↔ invoice ↔ webhook amount agreement.** `pay-v2.js` rewrites the
  PaymentIntent via `/update-amount` when the customer switches card/ACH.
  The PI `amount`, the invoice `total`, and the webhook's recorded
  `payments.amount` must agree to the cent; a change to one without the
  others is P0.
- **Terminal handoff burn stays atomic.** The single
  `UPDATE terminal_handoff_tokens SET used_at = now() WHERE jti = ? AND used_at IS NULL AND expires_at > now()`
  in `server/routes/stripe-terminal.js` is the burn. Splitting it into
  `SELECT` + `UPDATE`, dropping `used_at IS NULL`, or moving it after
  `paymentIntents.create` lets two iOS devices share one mint and
  double-charge. The claim/DB comparison right after the burn stays — it
  catches cross-environment replay if the JWT secret leaks.
- **Handoff mint rate limit is DB-enforced** (`stripe-terminal.js`
  header comment) so it survives deploys and replicates across pods. An
  in-memory `Map` / `setInterval` / process-local counter is P0.
- **Handoff TTL stays short.** `HANDOFF_TTL_SECONDS = 60`. Past ~5 minutes
  widens the leaked-token window; P0 unless the PR body argues for it.
- **`scheduled_services.status` is gated by a CHECK constraint, not a
  helper.** Migration `20260426000004_relax_scheduled_services_status_enum`
  (under `server/models/migrations/`, run via `--knexfile server/knexfile.js`)
  defines `pending | confirmed | rescheduled | en_route | on_site |
  completed | cancelled | skipped`. A new status string without a
  migration extending the CHECK throws at runtime and CI won't catch it.
  Writers use direct `update({ status })` (admin-schedule.js,
  admin-dispatch.js); new dispatcher/tech code appends to
  `job_status_history` (from→to, CHECK-mirrored); legacy callers stay on
  `service_status_log`. The customer-visible tracker state is a separate
  `track_state` enum owned by `server/services/track-transitions.js`.
- **`/api/admin/*` routers apply auth at the router level.** Every
  `server/routes/admin-*.js` starts with
  `router.use(adminAuthenticate, requireAdmin | requireTechOrAdmin)` from
  `server/middleware/admin-auth.js`. A new file that omits it, or a diff
  that removes it, exposes admin endpoints. Both halves are required on
  new routers: `adminAuthenticate` alone admits technicians to
  admin-intended pages. An existing router that already mounts only
  `adminAuthenticate` is a known consistency defect (P2 — technician
  reach, not an unauthenticated hole); flag it when the diff adds a router
  or removes a guard, not on unrelated edits. Per-handler middleware is
  acceptable; missing entirely is P0.
- **Internal and worker routes authenticate.** Any `/api/internal/*` mount
  needs `adminAuthenticate` + `requireAdmin` or an HMAC-signed header
  check; each `/api/integrations/*-worker` mount authenticates via its own
  HMAC check inside the router. An unauthenticated one is P0.
- **Public route surface.** `docs/public-route-contracts.md` lists every
  route served with no session auth (unauthenticated or token-only;
  customer-JWT `authenticate` routes are not public) and the guards each
  one carries. A new public route not added to that document in the same
  PR is P0. Every token route keeps a token format gate before
  any DB read, a generic 404 (unknown, malformed, dark-gated, and
  ineligible rows indistinguishable), a rate limit, and privacy headers;
  a dark `GATE_*` route skips its limiter so a probe never sees a
  revealing 429. That baseline applies where a route's entry says nothing
  else; where the entry records a different or narrower guard set (the
  bond switcher's uniform 403 while dark, the automation-preview page's
  token-plus-noindex-only contract), the entry is authoritative — flag
  drift from the entry, never the entry itself, and flag a NEW route or a
  widened payload that adopts less than the baseline without its entry
  saying why. Writes on the `/api/reports/:token/*` family gate on
  `service_report_v1` + the token format check, use atomic conditional
  updates for one-shot guards (409 on 0 rows), mirror the read-side
  eligibility check, validate bodies before `Number()` coercion, and ride
  `reportEventLimiter`. Contract e-signature tokens burn when signed. The
  estimate `ask` and `find-slots` routes keep the estimate token gate, the
  short-lived signed `askToken`, terminal/expired rejection, their rate
  limits, no raw question/query logging, and never book. Any change to a
  listed route's auth, gate, payload, or headers that the document does
  not describe is P0.
- **`/receipt/:token` permanence.** The receipt token is `invoices.token`
  and is intentionally permanent — customers re-share receipt links with
  bookkeepers months later. A `used` / `viewed_count` / `expires_at` gate
  on `/api/receipt/:token` or `/pdf`, token rotation after payment, or auth
  on those endpoints is P0.
- **No string-interpolated user input in `db.raw`.** Query builders are
  parameterized; `.raw()` is not. `db.raw(\`… ${x} …\`)` or
  `db.raw('… ' + x + ' …')` where `x` comes from `req.body / req.query /
  req.params` is SQL injection (`check:domain-rules` does not scan for it).
  `db.raw('… WHERE id = ?', [x])` and constant-string raw are fine.
- **Card PAN, CVV, full SSN, or full Stripe `payment_method` objects in
  logs.** Railway logs and `errors.log` are plain text. last4 is fine; the
  full PM object (BIN, fingerprint) is not.
- **Hardcoded Anthropic model IDs.** Anthropic IDs live only in
  `server/config/models.js` (tiers `DEEP` / `FLAGSHIP` / `WORKHORSE` /
  `FAST` / `VOICE` / `VISION` / `EXTREME`) and `services/llm/deep.js`;
  `check:domain-rules` enforces it. A new `'claude-…'` literal elsewhere
  pins a tier and defeats the env-var swap. Per-service OpenAI/Gemini
  defaults (transcription and extraction in
  `call-recording-processor.js`) are a documented exception, not a
  finding. Every DEEP call site goes through `createDeepMessage`
  (thinking-block stripping + refusal fallback).
- **Estimate service-mix rail member exclusion**
  (`server/routes/estimate-public.js` `applyServiceMixChange`,
  `server/routes/admin-estimates.js` `applyLeadServiceForSend`). A priced
  customer add (`GATE_ESTIMATE_SERVICE_ADD`) and the send-time lead-service
  park (`GATE_ESTIMATE_LEAD_SERVICE_SEND`) price NEW-customer terms; a plan
  member's ladder is a different program. Both read the ONE evidence reader
  `memberEvidenceInEstimateData`, run a strict live `isActivePlanCustomer`
  check that fails CLOSED, and re-check on a `FOR UPDATE` customer row
  inside the write (estimate row locked first — the accept path's order).
  Also security-critical: the add branch is customer-only (`actor !==
  'customer'` → 400), an add whose recompute yields no new recurring row
  fails closed (409 `add_unavailable`), and a staff-parked offer re-enters
  only under the add gate. Dropping any of these plants fresh-quote
  pricing on a member plan or lets staff parks masquerade as customer
  removals.

## Treat as P1

- **Blind `content[0].text` on a raw Anthropic response.** Reasoning
  models may lead with a `thinking` block that has no `.text`, so the real
  answer sits in `content[1]` and the caller takes its "model returned
  nothing" branch. It is input-dependent, so a smoke test never reproduces
  it; a tier swap (#2814) killed ten Claude-backed event sources for a
  week this way. Flag any new raw `client.messages.create` read via
  `content[0]` without `stripThinkingBlocks` (`services/llm/deep.js`), or
  better, any raw call that bypasses the `llm/` helpers.
- **America/New_York discipline.** Railway runs `TZ=UTC`; the portal is
  Eastern-only. Use `server/utils/datetime-et.js` (`parseETDateTime`,
  `etParts`, `formatET*`). Flag `new Date(\`${ymd}T${hm}\`).get*()`,
  `toLocaleString` without `timeZone: 'America/New_York'` on wall-clock
  fields, and `node-cron` schedules without `timezone: 'America/New_York'`.
- **Near-today date literals in tests.** A literal that passes through a
  not-in-the-past validator (Joi `.min(todayStartEt)`) goes red the night
  the ET calendar passes it (`schedule-confirm-race.test.js`, 2026-07-23).
  Compute relative dates for anything a freshness check validates.
- **PII in logs (non-card).** Phone, email, street address, full inbound
  SMS bodies, or customer names interpolated into log lines. Log ids.
- **Floating promises in Express handlers.** A bare `someAsync()` inside an
  async handler that isn't awaited. Mark deliberate fire-and-forget with
  `void someAsync().catch(err => logger.error(...))`.
- **No `{ virtual: true }` jest mocks of real modules.** A virtual mock
  registers under a synthesized key; in a warmed shared worker the module
  under test requires the REAL package and bypasses it — order-dependent,
  green locally, red in CI (`google-ads-sync.test.js` made a live OAuth
  call, #2843). `virtual` is only for modules that don't exist (e.g. the
  `./stripe-webhook-helpers` mock in `stripe-webhook-refund-failed.test.js`).
- **Feature flags fail closed.** `client/src/hooks/useFeatureFlag.js`
  returns `false` on API error by design. `|| true`, `?? true`,
  `localStorage` overrides, or env bypasses are P1 (P0 if they expose a V2
  admin page with broken data wiring). Re-fetching a flag per list-row
  render instead of once at the page boundary is also P1.
- **Retained V1 shared-export modules.** `client/src/pages/admin/`
  `SchedulePage.jsx`, `CustomersPage.jsx`, `EstimatePage.jsx`, and
  `CommunicationsPage.jsx` survive the V1→V2 migration as utility modules;
  their named exports (`CompletionPanel`, `RescheduleModal`,
  `EditServiceModal`, `ProtocolPanel`, `MONTH_NAMES`, `PRODUCT_DESCRIPTIONS`,
  `TRACK_SAFETY_RULES`, `stripLegacyBoilerplate`, `STAGES`, `STAGE_MAP`,
  `KANBAN_STAGES`, `LEAD_SOURCES`, `CustomerMap`, `CustomerIntelligenceTab`,
  `STATUS_CONFIG`, `PIPELINE_FILTERS`, `DECLINE_REASONS`, `classifyEstimate`,
  `getUrgencyIndicator`, `detectCompetitor`, `ALL_NUMBERS`,
  `NUMBER_LABEL_MAP`) are imported by V2 pages. Touching them is a
  coordinated change; deleting or resurrecting the files is not allowed.
- **Style-system mixing.** Tier-2 pages use inline styles + the `D`
  palette; Tier-1 V2 pages use Tailwind + `components/ui`. A file that
  imports `components/ui/*` and defines a `D = { … }` palette is mixing.
  Visual-refresh PRs on V2 pages are strict 1:1 on data, endpoints, and
  metrics — content or endpoint changes never share a PR with them.
  `alert-fg` red is for genuine alerts only; the one sanctioned exception
  is the Customers V2 status indicators (health rings, tier badges, stage
  badge) on `/admin/customers`.
- **Retired-tool names.** New imports, env vars, or literals referencing
  Square, Zapier, Make (Integromat), Elementor, NitroPack, or RankMath.
  Flag only when the diff introduces or moves them.
- **Twilio `From` / `MessagingServiceSid` hardcoded.** Numbers per GBP
  location come from config; `+1…` literals in route code drift.
- **Permission-allowlist entries** (`.claude/settings.json`
  `permissions.allow`, command-frontmatter `allowed-tools`) auto-approve
  every variant the pattern matches. Flag: (a) an npm wrapper whose
  `pre`/`post` hook writes the DB, calls external APIs, or spends money
  (`predev` runs `db:migrate`); (b) a wildcard over a script family that
  mixes safe and spending commands (`check:*` sweeps in `check:lawn-models`,
  which POSTs to three LLM providers); (c) a prefix rule over a command
  with destructive flags (`git branch:*` has `-D`, `git push:*` has
  `--no-verify`/`-f`, `git fetch:*` moves refs, `gh api:*` POSTs,
  `git ls-remote:*` allows `--upload-pack=<exec>`, `gh pr create` pushes,
  `gh pr comment:*` has `--delete-last`, `npm ci` runs install scripts,
  `npm run test:contracts` calls live Stripe/Twilio/GitHub/Cloudflare when
  secrets are loaded); (d) an exact command with a remote side effect —
  `npm run dev:server` boots `initScheduledJobs()` with `cronJobs`
  defaulting ON outside prod, and `npm run models:check` sends
  `ANTHROPIC_API_KEY` to api.anthropic.com — none of these may be
  pre-approved. Prefer exact forms; note a trailing `:*` enforces a
  word boundary, so colon-named scripts need exact entries. Accepted
  residual risk (owner ruling, #2768): local read/stage prefix rules
  (`git status/diff/log/show/add/commit:*`) stay — damage is local and
  visible before the always-prompting `git push`. Flag any new prefix rule
  whose abuse is remote, irreversible, or invisible.
- **`ops/agents/` convention.** Scripts declare READ-ONLY or MUTATES in
  the header, default to dry-run (`--execute` to write), and contain no
  secrets, tokens, customer names, or invoice numbers (`ops/agents/README.md`).
- **Customer PII in the repo.** Names, lead addresses, or live payload
  dumps never appear in code, tests, migration headers, commit messages,
  or PR bodies — reference accounts by id. One violation forced a branch
  history rewrite.
- **"Per application" price copy.** Customer-facing units read "per
  application", never "per visit", and no combined plan totals ("$X/mo",
  "$X/yr") appear on any customer-facing estimate surface. Exempt:
  invoice/prepay previews (the estimate payment section's breakdown boxes,
  where the prepay box lists the 12-month LIST annual as a line item, never
  a total), commercial proposals, and true monthly-billed legacy plans.
  One owner exception: the service-report cross-sell card headline shows
  the bare per-application amount with no unit; the number is still the
  per-application amount and "per visit" stays banned there too.
- **Appointment windows start on the hour.** `window_start` is always
  HH:00:00 — flag slot/window creation that can produce :15/:30 starts
  (`admin-leads.js` rejects them at entry, #3056). `window_end` is
  duration-driven and may land off-hour (`classifySlot` yields 10:30 for a
  90-min service at 09:00) — never round or reject it. Customer-facing
  arrival copy is `window_start` → +120 min, display-only, via
  `arrivalWindowRange()` (`server/utils/sms-time-format.js`); never change
  `window_end` for display.
- **Email-change token fanout.** When a customer's email moves,
  `customer-email-fanout.js` rotates email-bound subscriber tokens
  (`newsletter_subscribers.confirmation_token` / `unsubscribe_token`);
  never retarget unlinked sends by email alone. Per-delivery
  `newsletter_send_deliveries.engagement_token` values are NOT rotated —
  don't describe them as rotating, and flag diffs that widen what an old
  emailed token can reach. `invoices.token` receipt links never rotate.
- **Compliance language on any customer surface** (portal copy, prep
  guides, reports, estimator lines, marketing): no pesticide is ever
  "safe" (incl. "pet-safe"/"family-safe"); "EPA-registered"/"EPA-exempt",
  never "EPA-approved"; never a fixed re-entry/drying minute figure — the
  idiom is "safe once dry" + technician confirms timing. When one banned
  claim appears, sweep the tree for the class. Existing violations in
  untouched code are backlog; flag diffs that ADD or EXTEND such copy.
- **Estimate follow-up truth scope** (`estimate-followup-copy.js`):
  recurring residential lanes get the callbacks/90-day/no-contract line;
  rodent/termite/commercial/bundle/unknown are terms-neutral — termite
  never gets recurring terms; copy failures fail soft and never block.
- **Report/track egress.** Access/gate/lockbox codes are excluded from
  customer-facing reports (`report-copy-context.js`). Raw
  `technician_notes` never egress on any report path. The
  `/api/public/track/:token` payload masks email/phone server-side.
- **WDO and pre-treatment termite certificates are FDACS paper compliance
  documents** — no AI narrative, no ask bar, conservative surfaces.
  ("Infestation extent" is legitimate FDACS wording on the WDO page.)
- **Call pipeline do-not-regress** (`call-recording-processor.js` and the
  extraction/routing stack): call-created bookings resolve to a real
  `services` row (`service_id` set) or book "Waves Assessment" — never an
  invented `service_type` with a null `service_id`; recurring intent beats
  the presenting pest (`applyRecurringIntentDefault`: ambiguous cadence →
  Quarterly, upgrade-only backstop, explicit "just one-time" keeps the
  single service, general-pest only); only `scheduling.status ===
  'confirmed'` becomes an appointment; extraction schema changes are
  additive-only (both schema JSONs + normalizer + persisted enum +
  `SCHEMA_VERSION` bump, never added to `required`, new fields join the
  replay `FIELD_GROUPS`; a prompt/schema/catalog change bumps the
  `ai_extraction_prompt_version` hash, which resets the promotion cohort
  so shadow rows from an older contract never count as evidence;
  downstream composers read v2 + raw transcript, never v1); address validation counts only `hasReplacedComponents` as a
  correction, never accepts unless `inServiceArea === true`, holds for
  review when AV is unreachable, and treats a `PREMISE` verdict missing
  only `subpremise` as a resolved building without its unit
  (`avMissingUnitOnly` — hold with `missing_unit_number`, never street
  recovery); an owed ask auto-closes only on evidence answering THAT ask
  (`missing_unit_number` has no auto-resolution — human verdict only, in
  `triage-auto-resolve.js`); auto-routing stays confidence-gated (address
  validates AND service maps AND no HOA/commercial flag, else triage),
  inserts keep idempotency keys, TCPA consent precedes any SMS; hard-
  bounced call-captured emails are re-verified against the recording and
  surfaced for owner read-back, never auto-corrected or resent.
- **Estimator engine authority.** `generateEstimate` is the sole dollar
  authority — LLM output proposes intent only and never reaches
  proposal/price fields; engine drafts never auto-send; existing customers
  are blocked from engine drafting; low-confidence markers (fpSource
  fallback, low pricingConfidence, turfBasis fallbacks) route to review.
  Caller-stated unit size + `relationship_to_property: tenant` outrank
  county sqft for commercial tenants. Two owner-approved exceptions mint a
  customer-viewable estimate for the tapping customer — a priced
  cross-sell tap (`GATE_REPORT_CLICK_TO_ESTIMATE`) and a churned
  customer's "Restart my plan" tap (`GATE_CANCEL_FLOW_V2`, `plan_restart`
  mint, account re-verified churned under the row lock, families with live
  recurring rows excluded) — under the same bounds: deterministic options
  only, no LLM, the server recompute must match the shown/snapshotted
  price to the cent or the mint refuses, and zero delivery (no send, no
  follow-up automation, no customer comms). "Never auto-send" stands
  everywhere else.
- **Lawn-diagnostic lockstep.** `CONDITION_LABELS` / `SUMMARY_CAUSE_RE` /
  `CONFIRMABLE_CONDITION` / the `GOVERNED_CAUSE` test stay mirrored and
  plural-aware; customer egress is confidence-gated and allowlisted —
  never publish client- or LLM-supplied `customer_wording`. Persistence
  stamps provenance server-side: `tech-lawn-diagnostic.js` accepts
  `body.aiAnalysis` but overwrites `provenance` (`challenge_reverified`,
  writer, run id) from the verified `lawn_diagnostic_runs` row — a client
  must never be able to forge either and make an unreviewed summary look
  eligible for confident customer voice.
- **Lawn protocol data fan-out.** A product/protocol change reaches BOTH
  sources of truth (field-exec `protocols.json` AND `lawn_protocol_products`
  rates/gates + windows) plus `products_catalog` (rates match
  `default_rate_per_1000`, lowercase category, `epa_reg` NOT NULL and never
  guessed), pricing.csv, and the plan-matcher. Premium/optional rows are
  `default_in_plan:false` + a gate. Never write a full product name into a
  parsable disclaimer line; never bulk-import the legacy 4-turf workbook.
- **Booking conflict-check class.** Tech-scoped conflict WHEREs are blind
  to technician-NULL rows (`filterCollidingSlots`) — every new
  booking/reschedule surface needs the mirror guard.
- **Condo aggregation guards.** Keep the `parcel.aggregated` branch ahead
  of `countyUseDescToPropertyType`; don't lower `AGGREGATE_MIN_UNITS` (5).
- **Twilio number classification.** `TWILIO_NUMBERS.findByNumber` reports
  the AI toll-free number as `type:'location', locationId:'bradenton'` —
  "location numbers only" logic must also exclude the AI number explicitly.
- **Admin OAuth pattern.** Admin auth is bearer-only (`Authorization` from
  `localStorage.waves_admin_token`; no cookie/query fallback). A "connect"
  endpoint returns the consent URL as JSON for the SPA to navigate — a
  bearer-protected `res.redirect` hard-401s on top-level navigation. The
  callback validates via a one-time `state` nonce, not bearer.
- **`@waves/*` CJS workspace packages** join `optimizeDeps.include` +
  `build.commonjsOptions.include` in `client/vite.config.js` or fail Rollup
  named-export analysis in prod. Exception: SERVER-ONLY packages (Node
  built-ins, e.g. `@waves/affiliate-registry`) must NOT be added — mark them
  SERVER-ONLY in their `package.json` description.
- **Company name in copy** is "Waves Pest Control", never "Waves Lawn &
  Pest". The mascot artwork carrying the old name is intentional.

## Implementation defaults

Authoring defaults for any agent writing code here; reviewers flag at the
severity noted.

- **Simplest implementation that fully meets the current requirement.**
  No speculative config, single-call-site generic handlers,
  one-implementation interfaces, or future-proofing layers. P2.
- **Structural lint is a signal, not a gate.** `eslint.config.js:26`
  (`QUALITY_WARN`) warns, never errors, on `complexity` > 20 and
  `max-depth` > 4 in every production block. A warning on a function the
  diff adds or rewrites is P2 (remove decisions per CLAUDE.md rule 20 — not
  a one-use helper that just moves the branches); a warning on untouched
  legacy code is ignored. Never add `--max-warnings` to the lint-staged
  command — it would block commits on pre-existing code (#3787).
- **No compat shims for code changed in the same PR.** Migrate every
  internal call site; no deprecated wrappers, re-export aliases, or dual
  paths for callers this repo controls (P2). The inverse is mandatory for
  external consumers — deployed native apps, in-flight tokenized links,
  astro-fleet form posts, webhook payloads, existing DB rows must keep
  working; breaking them is P0.
- **Use existing dependencies; no new ones without owner approval.** Don't
  hand-roll what a library in `package.json` provides. A new `package.json`
  entry not called out in the PR body is P1.
- **Extend the existing mechanism; don't build a parallel one.** Before
  adding a status writer, cron sweep, approval path, rate limiter, dedupe
  stamp, or date util, find the existing one and extend it. A second
  mechanism for a purpose an existing one serves is P1 unless the PR body
  names the existing mechanism and why it can't be extended (instances
  rated P0 above, e.g. a second Stripe webhook mount, keep P0).

## Out of scope (do not flag)

- `client/dist/**` (built bundle), `waves-customer-portal.tar.gz`,
  `SESSION-*-AUDIT.md`, `TODO.md`, `errors.log`.
- `docs/design/DECISIONS.md` — append-only log; new entries at the bottom.
- Cross-timezone concerns. The portal is Eastern-only.
- Style-of-existing-code refactors. Match the file; don't rewrite legacy
  inline styles to Tailwind in a non-redesign PR.
- Settled owner rulings: the one-time completion gate stays removed
  (#3013); `ESTIMATE_DEPOSIT_REQUIRED` stays off; lawn IS
  WaveGuard-tier-discountable; `deposit_credit` ledger credits face value;
  missed surcharges are forward-only (no clawback).

## Maintaining this file

- A rule earns its place by naming the failure it prevents and the file
  that carries it. If you can't name the failure, delete the rule.
- One bullet = the invariant, the protected `file:line`, and the incident
  in one clause. No snapshot counts, no "as of" dates, no review-round
  narration — those rot within weeks and a wrong instruction costs more
  than a missing one.
- Before adding, sharpen the existing rule that covers the class. Before
  writing prose, ask whether the rule can be a test or a scanner
  (`check:domain-rules`, the route-surface allowlist, contract tests); if
  so, write that and leave a one-line pointer here.
- Procedures go in a skill; orientation goes in `CLAUDE.md`; route
  contracts go in `docs/public-route-contracts.md`. `/lesson` routes a
  correction to the right file.
- After every model upgrade, run `claude doctor` and a manual stale-fact
  pass: verify each cited file, constant, and gate still exists as
  described, and drop anything the current models do unprompted.
