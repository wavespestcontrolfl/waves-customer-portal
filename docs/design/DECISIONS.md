# DECISIONS.md

A running log of design and architectural decisions for the Waves Portal. Each entry explains the *why*, not just the *what*. Keep entries short — a paragraph is plenty.

**Why this file exists:** six months from now, when someone asks "why are all our buttons uppercase?" or "why is there no dark mode?", this file is the answer. Without it, the decision gets re-litigated every time a new pair of eyes looks at the system.

**Format:** append new entries at the bottom. Never edit or delete old entries — if a decision is reversed, add a new entry explaining the reversal. The log is immutable.

**Entry template:**

```
## [Date] — [Short title of decision]

**Decision:** [one-sentence statement of what was decided]

**Context:** [what was the question or situation]

**Reasoning:** [why this choice over alternatives]

**Revisit if:** [what would prompt reconsideration]
```

---

## 2026-04 — UI redesign baseline: monochrome + red, uppercase CTAs, light mode only

**Decision:** The admin portal will use a near-monochrome design language (grayscale + red as the only chromatic color), UPPERCASE letter-spaced CTAs, and will support light mode only.

**Context:** The portal had accumulated inconsistent use of color, weight, and button styling as features shipped over time. The owner wanted a "super clean professional dashboard" with strong visual hierarchy.

**Reasoning:** Employee software optimizes for throughput and error reduction, not engagement. A monochrome palette with red reserved for items needing team action makes alerts impossible to ignore and everything else visually quiet. UPPERCASE CTAs push the aesthetic register toward institutional (Attio, Pylon, Bloomberg) rather than consumer-friendly (Notion, Linear). Dark mode was cut because the primary usage context — Virginia in a sunny Bradenton office and techs on iPhones in Florida sunlight — doesn't benefit from it, and supporting it doubles QA surface for every page.

**Revisit if:** Virginia or techs specifically report the interface feels cold or hostile during extended use; a significant portion of usage shifts to low-light environments; customer-facing surfaces (which use different design rules) bleed into admin contexts.

---

## 2026-04 — Customer-facing surfaces use a separate, warmer design language

**Decision:** Customer-facing surfaces (estimate, invoice, booking, appointment, portal, post-service) will use a distinct, brand-forward design language — not the admin monochrome spec. Wave Teal accent, warmer neutrals, Title Case CTAs allowed, larger type sizes, imagery permitted.

**Context:** The admin spec's monochrome-institutional register would actively hurt conversion on surfaces where a homeowner is deciding whether to trust Waves with ongoing payments.

**Reasoning:** Consumer UI and employee UI solve different problems. Applying a Bloomberg Terminal aesthetic to a $261/month lawn service estimate creates a trust gap at the exact moment trust matters most. Consumer surfaces need warmth, brand presence, and clarity for non-experts — attributes that would be noise in admin.

**Revisit if:** The separation creates component-duplication pain that outweighs the aesthetic benefit; customers report the estimate page feels "off-brand" relative to the marketing site.

---

## 2026-04 — Tier 1 redesign scoped to 5 admin routes

**Decision:** Full-redesign (tier 1) treatment is limited to Dashboard, Dispatch (absorbing Schedule as a view toggle), Customers + Detail, Estimates + /new, and Communications. Every other admin route receives a "tier 2" token pass only: apply tokens, strip colored classes, convert status indicators — no layout restructuring, no archetype enforcement.

**Context:** The portal has 30+ admin routes. A full redesign of all of them would take months and apply design polish to pages Virginia rarely opens.

**Reasoning:** Design polish has diminishing returns beyond the core daily-use surfaces. The 5 tier 1 routes are what Virginia touches every hour. The others work fine functionally and benefit from visual consistency (tokens) without justifying full restructuring. This also keeps the project scoped to something shippable in weeks, not months.

**Revisit if:** A tier 2 page becomes a daily operational burden during the tier 1 migration; a business change elevates a tier 2 page to tier 1 status (e.g. commercial pest vertical requires a new operational view).

---

## 2026-04 — Tech Home (`/tech`) will not be touched in this redesign

**Decision:** The tech portal home page stays exactly as it is. Other tech pages (`/tech/route`, `/tech/estimate`, `/tech/protocols`) receive tier 2 token treatment only.

**Context:** Jose, Jacob, and Adam use the tech app every working day without complaint. The field-facing UI has different ergonomic requirements (big tap targets, sun glare, one-handed use) that risk being degraded by a design system designed primarily for office use.

**Reasoning:** Don't fix what isn't broken. The field team has muscle memory on the current layout. A design refresh without a specific field-reported problem is all downside: no throughput gain for the techs, potential disruption. Revisit when there's specific field feedback.

**Revisit if:** A tech reports specific frustration with the current home page; tech portal metrics (job completion time, photos-per-job) regress.

---

## 2026-04 — Intelligence Bar UX is out of scope for the visual refresh

**Decision:** The Intelligence Bar (104 tools across 13 contexts) will not be restyled piecemeal during the redesign. It needs its own UX design exercise first — covering discovery, organization, context-awareness, favorites/recents — before any visual work touches it.

**Context:** The Intelligence Bar has accumulated tools faster than a UX pattern for organizing them. Restyling each tool within the current structure would lock in an organizational model that may be wrong.

**Reasoning:** Visual refresh without fixing the underlying UX is lipstick on a pig. Better to pause, design the bar's organizational model properly, then apply visual polish. Doing it twice is more work than doing it once correctly.

**Revisit:** After the 5 tier 1 pages ship and stabilize. At that point, dedicate a separate design pass to the Intelligence Bar as its own project.

---

## 2026-04 — Feature flags are mandatory for every tier 1 page ship

**Decision:** Every redesigned tier 1 page ships behind a per-user feature flag. Rollout order: operator → Virginia (1 business day formal UAT) → all admin users → flag removed after 2 weeks stable.

**Context:** Virginia dispatches real jobs on the live portal. A silent regression locks her out of daily work until someone reverts.

**Reasoning:** Instant rollback without a deploy is the only safe way to iterate on a production tool used by the operations team during working hours. Flags are cheap; downtime is expensive.

**Revisit if:** Flag infrastructure becomes itself a maintenance burden that outweighs the safety benefit (unlikely at this team size).

---

## 2026-04 — Storybook is the canonical component reference

**Decision:** Storybook (or a `/admin/_design-system` internal route) ships before any page migration. Every component from the spec renders there in every state.

**Context:** Written specs drift. When Claude Code implements a page three weeks into the project, its reference should be a rendered component, not prose.

**Reasoning:** Visual references beat textual references for design implementation. A rendered component shows exactly what "default" and "hover" and "disabled" look like with no interpretation needed. Prose specs leave room for drift, especially across many PRs and AI sessions.

**Revisit if:** Storybook overhead outweighs its value for this team size — unlikely while there are multiple AI-assisted sessions building against the system.

---

## 2026-04-18 — Pre-redesign performance baselines captured (Tier 1 routes)

**Decision:** Record raw Core Web Vitals and JS transfer sizes for the 5 Tier 1 routes against production, on the current codebase, before any redesign foundation work lands. Freeze these numbers so PR #2+ can prove regression-or-not.

**Context:** Captured via Chrome DevTools MCP driving a local Chrome against `portal.wavespestcontrol.com` on git SHA `dc1db9b5a3286823c4a8a4548fad0ba796f1ae0a` at `2026-04-18T10:30:58Z`. Customer Detail (`Customer360Profile.jsx`) is rendered inline from CustomersPage — there is no `/admin/customers/:id` route — so it is folded into the Customers baseline. All resources served from Cloudflare immutable cache (`transferSize ≈ 0` on repeat visit is realistic for this portal); `decodedBodySize` is the regression-proof number.

Raw numbers:

| Page | URL | LCP | CLS | TTFB | Script decoded | Total decoded | fetch (wire / decoded) | resources |
|------|-----|-----|-----|------|----------------|---------------|------------------------|-----------|
| Dashboard | /admin/dashboard | 712ms | 0.13 | 208ms | 1564 KB | 3285 KB | 3.2 KB / 7.1 KB | — |
| Dispatch (→ Schedule) | /admin/schedule | 1448ms | 0.00 | 216ms | 1564 KB | 2903 KB | 2.1 KB / 172.6 KB | — |
| Customers (incl. Customer360 inline) | /admin/customers | 760ms | 0.00 | 205ms | 1564 KB | 2879 KB | 1.8 KB / 148.9 KB | — |
| Estimates | /admin/estimates | n/a | 0.01 | 136ms | 1732 KB | 2992 KB | 6 KB / 93.6 KB | — |
| Communications | /admin/communications | n/a | 0.00 | 216ms | 1564 KB | 2782 KB | 3 KB / 51 KB | 18 |

Raw traces archived at `/tmp/waves-baseline-traces/0{1..6}-*.json`.

**Reasoning:** Spec §8.5 requires a regression check after each Tier 1 page ship. Without a dated, SHA-locked pre-redesign baseline, "we regressed" becomes a matter of opinion. One shared LCP/CLS number per route, captured the same way every time (MCP-driven Chrome, repeat-visit with Cloudflare cache warm), removes the debate. LCP was unmeasurable on Estimates and Communications under the trace — those pages render through state transitions that never produced a single definitive largest-contentful paint event; redesign will make them paint a single hero region and their LCP will become measurable, which is itself a win.

**Revisit if:** Any Tier 1 page ships a PR that moves LCP by >150ms or CLS by >0.05 vs these numbers — that PR's description must explain the move before merge. If Cloudflare cache rules change (e.g. bundles stop being immutable), replace these baselines with fresh captures.

---

## 2026-04-18 — In-repo `/admin/_design-system` route over standalone Storybook

**Decision:** Ship the canonical component reference as an authenticated in-repo admin route (`/admin/_design-system`) rather than standing up a separate Storybook app. Keep the route behind admin auth, gated to non-production OR an explicit user-id allowlist, and excluded from the sidebar nav + `robots.txt`.

**Context:** Spec §8.2 calls for "Storybook (or a `/admin/_design-system` internal route)" — explicit permission to pick either. This portal is a single React/Vite SPA with inline-styles-migrating-to-Tailwind, one build, one deploy, one auth system.

**Reasoning:** A second app (Storybook) means a second build pipeline, a second deploy target, a second auth story for an internal tool, and a second dependency graph to keep in sync with production React/Vite. An in-repo route reuses the existing bundler, layout primitives, auth middleware, and deploy pipeline — every primitive rendered there is literally the one production uses, not a Storybook facsimile. The tradeoff is losing Storybook's built-in controls/addons, which this team has never used. Leave the door open: if the design system grows to need args tables and snapshot testing, Storybook can be added later without throwing the route away.

**Revisit if:** Multiple external designers/contractors start contributing components and need a sandboxed environment without portal credentials; or interaction testing (Storybook test-runner) becomes a thing this team wants.

---

## 2026-04-18 — Hand-rolled primitives with Radix fallback, not shadcn CLI

**Decision:** Build the 13 UI primitives (Button, Input, Select, Checkbox, Radio, Switch, Textarea, Badge, Card, Table, Dialog, Sheet, Tabs) by hand in `client/src/components/ui/`. Use `@radix-ui/react-dialog` as the underlying primitive for `Modal` + `Sheet` only, if hand-rolling focus-trap logic produces noticeably worse UX. No `shadcn` CLI, no `class-variance-authority`.

**Context:** Spec references shadcn/ui as an aesthetic reference, not a dependency requirement. shadcn's CLI copies vendored source into the repo — after that, it's indistinguishable from hand-rolled. This project already uses inline styles + `D` palette; introducing shadcn's CVA pattern here would create a third styling idiom alongside the two that already exist.

**Reasoning:** The spec's whole point is restraint — a small fixed set of primitives, no prop explosion, weights limited to 400/500, colors limited to the zinc ramp + one alert red. `cva` encourages variant proliferation, which is exactly the drift the spec is pushing against. Hand-rolled components in the same idiom as the rest of the codebase are easier for the next person (human or AI) to understand and extend. Radix's Dialog/Sheet primitives solve one genuinely hard problem (focus-trap + scroll-lock + escape-key + portal) that is not worth re-implementing; reach for them only if the hand-roll gets ugly.

**Revisit if:** Primitive count grows past ~20 (CVA starts paying off at higher variant counts); or a second engineer joins who's more productive with the shadcn mental model.

---

## 2026-04-18 — Admin shell pivots to Square-inspired warm-stone + blue CTA

**Decision:** The admin shell (sidebar, app frame, future top-level chrome) adopts a Square Dashboard-inspired light theme: white `--surface-primary`, warm-stone `--surface-page`/`--surface-hover`, near-black warm-neutral text, and a single `#006AFF` blue reserved for the one primary CTA per screen. Tokens live in `client/src/styles/theme-square.css` scoped to `.admin-shell-v2`. Ships as `AdminLayoutV2` behind the `admin-shell-v2` per-user feature flag. Location switcher from the original pitch removed — work scopes by customer address, not GBP location.

**Context:** The earlier Tier 1 spec (zinc ramp, monochrome) was correct in spirit but clinical in execution; Virginia and the operator both have years of Square muscle memory from Square Appointments / POS. Building in the visual language they already know collapses training cost on redesigned pages to roughly zero. Stone beats zinc because zinc reads cold against the warm tonality Square has settled on; the difference is small in isolation but compounds across a dashboard.

**Reasoning:** Combining the token file and the first shell consumer in one PR instead of splitting them — inline hex in `AdminLayoutV2` followed by a tokens-retrofit PR would bake silent drift into the file that matters most, and leave a multi-day window where both shells coexist with different levels of tokenization. Tokens aren't the expensive part (≈40 lines of CSS vars); the expensive part was picking the palette, which is already decided. Scoping tokens to `.admin-shell-v2` (rather than `:root`) prevents leakage into flag-off V1 pages while both shells coexist, and leaves room for a `[data-theme="tech-dark"]` override for the tech portal later without rewriting consumers. Location switcher dropped because Waves doesn't actually scope work by GBP location — jobs scope by customer address, so the pattern was imported from Square without a real workflow match.

**Revisit if:** Florida-sun glare on tablets forces the office team off light mode (unlikely — Virginia works indoors). Also revisit if the next Tier 1 page migration onto these tokens reveals missing semantic slots (e.g. chart colors, success/warning — intentionally omitted until a real consumer needs them).

---

## 2026-04-18 — Rename `ai_conversations`/`ai_messages` → `agent_sessions`/`agent_messages`

**Decision:** Rename the `ai_conversations` and `ai_messages` tables to `agent_sessions` and `agent_messages`, freeing the `conversations`/`messages` namespace for the new unified customer communications schema.

**Context:** PR 1 of the comms unification (see entry below) introduces a `conversations` + `messages` pair to consolidate SMS, voice, voicemail, email, and Beehiiv touchpoints into a single channel-agnostic thread + message model. The existing `ai_conversations` table — created in migration 039 alongside `call_log` — sounds like the same thing but is actually agent execution-state: AI assistant session tracking with `tool_calls`, `tool_results`, `requires_approval`, `escalated`, `conversation_summary`. It is not a customer-facing thread.

**Reasoning:** Letting both names coexist means every developer (and every future Claude Code session) has to relearn "when we say conversation we mean…" for the lifespan of the codebase. The cost is silent for years and then expensive once. Six file references via grep, ~45 string occurrences total; a one-PR rename is cheaper than the ambiguity tax. `agent_sessions` is more accurate to what the table actually stores (a session per agent run), and `agent_messages` parallels it. Migration is a straight `renameTable` — Postgres tracks FKs by OID, not name, so the existing `ai_messages.conversation_id → ai_conversations.id` constraint continues to work; only the constraint *name* is now stale (cosmetic).

**Revisit if:** A future agent framework requires a different mental model (e.g., persistent agent memory that spans sessions) that doesn't fit `agent_sessions` semantics. In that case, add a new table; don't rename again.

---

## 2026-04-18 — Unified `conversations` + `messages` as the comms schema; PR 1 ships dual-write only

**Decision:** Land a single `conversations` + `messages` schema that all channels (voice, sms, email, newsletter, voicemail, system_note) write into, alongside `blocked_numbers` + `blocked_call_attempts` for spam handling. PR 1 adds the tables and dual-writes from existing webhooks; the inbox keeps reading the legacy `sms_log`/`call_log`/`emails` tables. PR 2 cuts the read path over and backfills history.

**Context:** Today the admin Communications inbox reads only `sms_log` — calls, emails, and recordings live in three other tables that the inbox never joins. Virginia experiences this as "I can't find Aaron's old texts" and will experience it as "I can't find Aaron's old emails" the moment email gets surfaced. Beehiiv newsletter sends are entirely opaque. The pain is the same pain across six channels; solving it once is the lever. The full strategy doc covers seven sequential PRs; this entry covers PR 1 only.

**Reasoning:** The conversation row is keyed on `(customer_id, channel, our_endpoint_id)` — meaning a customer who's texted two of our 25 Twilio numbers gets two SMS conversation rows. That preserves the routing fidelity (reply-from must default to the number the customer most recently used per channel) without forcing Virginia to triage that customer across two threads — the inbox UI groups by `(customer, channel)` via a derived view layered over the raw rows. Dual-write in PR 1 (rather than cut-over) means a botched migration doesn't break the inbox Virginia uses 8 hours a day; old reads keep working until new tables are validated. Spam-block tables ship in the same migration so the data model is complete from day one — defining the full `block_type` enum (`hard_block`, `silent_voicemail`, `ai_screen`, `sms_silent`) now means PR 4's inbox dropdown and the later AI-screener PR don't need schema changes to introduce them.

**Revisit if:** The dual-write phase reveals a column the new `messages` schema is missing (likely candidates: `email`-specific threading headers, Beehiiv campaign IDs, Twilio Voice Intelligence tags). Add as `metadata` keys first; promote to columns only if they become query targets. Also revisit if backfill volume turns out to be larger than expected — current estimate ≈ 50–100k rows total across legacy tables, well within a single in-place migration.

---

## 2026-04-18 — PR 2 lands the read-path cutover; sms_log + call_log become write-through legacy

**Decision:** Cut the Communications inbox, dashboard inbox, Customer 360 timeline, and channel-stats endpoints over to read from `conversations` + `messages`. Preserve the dual-writes to `sms_log` and `call_log` for the queue/processing flows that still depend on them (scheduled-SMS cron, call-recording processor). Backfill historical SMS + voice rows via a standalone idempotent script (`server/scripts/backfill-comms-pr2.js`) rather than a knex migration so Railway's deploy timeout is not a constraint.

**Context:** PR 1 left a dual-write in place but every read still hit the legacy tables. Five surfaces consume those reads: `GET /api/admin/communications/log`, `GET /api/admin/communications/stats`, `GET /api/admin/dashboard/inbox` (+ `/read` + `/reply`), `GET /api/admin/customers/:id` timeline, and the call-recordings list. Switching all five at once is the right unit because the alternative — leaving any one on the legacy table — means Virginia sees ghost messages where the dual-write started (everything older missing) until the next cutover lands. Backfill solves that by populating history before cutover, but the only safe way to ship cutover + backfill together is to do both in this PR.

**Reasoning:** Adds three columns to `messages` (`is_read`, `message_type`, `ai_summary`) for legacy fields the schema didn't model in PR 1 — the alternative was stuffing them into `metadata`, which would have made the inbox unread query a JSONB filter. Adds outbound dual-write in `TwilioService.sendSMS` and `POST /api/admin/communications/call`, since PR 1 only wired inbound webhooks. Reply-from on the dashboard inbox now passes `our_endpoint_id` from the originating thread back into `sendSMS({ fromNumber })`, which closes a long-standing routing bug where a reply could go out from the default Lakewood Ranch line even when the inbound landed on a spoke tracker — Virginia's "why is this customer getting two threads from us" frustration. Also fixes a P0 schema collision discovered en route: `admin-call-recordings.js` was inserting into `blocked_numbers` with the pre-PR-1 column shape (`phone`, string `blocked_by`); the call-disposition spam path would have thrown a column-not-found error the first time anyone tagged a call as spam.

The backfill script is idempotent on `(channel, twilio_sid)` so a partial run that gets killed (Railway, network blip) can be safely resumed. Email is intentionally out of scope — `emails` has no twilio_sid, lives on a separate Gmail-sync pipeline, and the inbox does not surface email today; the schema will accept email rows whenever PR 5 (Beehiiv + email intake) gets to it.

**Revisit if:** A consumer is found that still reads `sms_log` or `call_log` directly and breaks because of the cutover. The known-safe writes-through targets are the scheduled-SMS cron (queries `where status='scheduled'`) and the call-recordings processing pipeline (`processing_status` + `recording_url` workflow). If a third consumer surfaces, decide per-case whether to add a unified read or extend the dual-write further.

---

## 2026-04-18 — PR 3 lands Customer 360 unified Comms tab; SMS + voice share one thread

**Decision:** Replace the Customer 360 Comms tab's SMS-only feed with a unified per-customer thread that interleaves SMS and voice messages in a single chronological view. Ships a new `GET /api/admin/customers/:id/comms` endpoint and rewires the Comms tab in both `Customer360Profile.jsx` (V1) and `Customer360ProfileV2.jsx` (V2) to fetch from it. Channel-aware rendering: SMS stays as chat bubbles; voice renders as a compact call card with duration, ai_summary (or transcript fallback), answered-by, and an inline audio player when a recording is attached.

**Context:** Before this PR, the Customer 360 Comms tab consumed `data.smsLog` — the per-customer SMS-only feed returned by `GET /api/admin/customers/:id`. Voice interactions existed only in the Timeline (a separate zone further down the panel, mixed with service/payment/note rows). From Virginia's and Waves's perspective, a customer's "conversation with Waves" is one stream — remembering whether you last talked to Aaron over SMS or over the phone before you open his profile is the kind of friction the unification is specifically designed to remove. This PR consumes the new `conversations` + `messages` read surface that PR 2 made authoritative; it's the first customer-facing view wired to it beyond the Timeline cutover.

**Reasoning:** Both V1 and V2 had to ship in the same PR because the feature-flag (`customers-v2`) is set per-user — cutting V2 alone would leave flag-off users on the legacy SMS-only Comms tab for the lifespan of the rollout, and the strategy doc is explicit that unification is the load-bearing improvement here, not the visual refresh. Channel-aware rendering (voice as a card, not a bubble) is chosen over flattening both to bubbles because a voice touchpoint has fundamentally different content — duration, who answered, an audio recording — that doesn't compress into a chat-bubble metaphor without losing information Virginia needs for CSR coaching and call review. The endpoint includes `ourEndpointLabel` via `TWILIO_NUMBERS.findByNumber` so a future PR 4 iteration can show "last SMS came in on Lakewood Ranch HQ" without re-querying; for now the field is plumbed but not displayed. Limit defaults to 100 with a 500 ceiling — larger than sms_log's old 20-row cutoff because the unified view is the primary place Virginia reconstructs multi-month customer histories; the old 20-row limit was the main complaint on long-tenure customers.

**Revisit if:** Call transcripts + ai_summary grow long enough that the inline card crowds the thread (current calls average 1–3 minutes with 60–200-word summaries; if average summary length passes ~400 words, collapse-by-default is the right move). Also revisit once PR 5 adds email to the schema — email belongs on this same unified thread, and the current channel-aware dispatcher will need a third branch with its own card shape (subject line, thread depth indicator, attachment chips).

---

## 2026-04-18 — PR 4 lands inbox filter chips, reply-from lock, and unknown + block UX

**Decision:** Bundle four inbox-hardening sub-features into a single PR on the Communications SMS tab: (1) filter chips row (All / Unread / Unanswered / Unknown / Blocked) that stacks with the existing StatCard-driven `smsFilter`, (2) reply-from lock that pins the outgoing number to the thread's `our_endpoint` once a thread reply is active, (3) Unknown-contact badge + styling on thread rows where the phone number doesn't resolve to a customer, (4) Block / Unblock inline action on each thread row backed by three new endpoints (`GET/POST/DELETE /api/admin/communications/blocked-numbers`). Also folds in a P1 bug fix on `server/routes/voice-agent.js` — the inbound-voice spam check was querying `blocked_numbers.phone`, a column that no longer exists after PR 1's `phone → number` rename, and the query's failure was being silently swallowed by a try/catch meant for "table doesn't exist yet."

**Context:** PR 1–3 gave Virginia a unified message schema and a unified Customer 360 thread, but the inbox itself — the list view she spends most of her day in — was still unchanged from the pre-unification UI. Three complaints show up repeatedly in her feedback: (a) no way to filter to just the threads that actually need her (unread, unanswered) without hunting; (b) the reply-from selector quietly resets between thread clicks, so she accidentally replies from the wrong Twilio number; (c) there was no inbox-level action to block a known spam number — every block had to be tagged post-hoc from call-recordings, which only catches voice spam, never SMS. At the same time, the voice-agent spam block was broken since PR 1 and nobody noticed because the try/catch hid the error, so this PR closes the loop on both inbound SMS spam UX and inbound-voice spam enforcement.

**Reasoning:** Bundled over split because the four sub-features share one surface (the inbox list), one state slice (`blockedNumbers` + `statusFilter` + `threadLock`), and one user (Virginia). Splitting would either force the first PR to include UI scaffolding that the second PR duplicates, or ship a half-wired inbox (e.g. chips without Block action) for a week. Filter-chip state chosen as a new `statusFilter` rather than overloading the existing `smsFilter` (which is tied to StatCard clicks filtering by message type — reminder / review / post-service / recurring) because the two concepts stack: "show me unread reviews" is a legitimate query. Phone matching uses a last-10-digit `phoneLast10` normalizer + a `Set` of blocked last-10s — blocked rows store E.164 (`+1…`) while thread `contactPhone` comes from the messages table in varying shapes, and string-equality across stored formats would miss matches. Reply-from lock mirrors how the real conversation works: when Virginia clicks Reply on a thread that landed on Lakewood Ranch HQ, every subsequent outbound in that session should go out from Lakewood Ranch HQ, not silently default to the first number in the select; an explicit Override link is rendered next to the locked banner for the rare case where she genuinely wants to switch. Block action writes synchronously on click (no confirm modal) because the reverse — an Unblock button rendered on the same row — is one click away and the cost of accidental block is low; this matches the standing "minimum-surgical" preference.

On the voice-agent fix: the alternative was to ship it as its own pre-PR but the bug was caught while auditing spam-block code paths for this PR's UX, both mutations touch the same table/shape, and the PR's headline feature is "block this number" — shipping an inbox Block button while leaving inbound voice blocking broken would have been misleading to Virginia. The try/catch that was swallowing the error stays in place (it legitimately guards against the table being absent on very old deploys), but the column reference is now correct and the logic checks `block_type === 'hard_block'` before issuing `<Reject/>` so that soft-block types (`silent_voicemail`, `ai_screen`) can take different branches later without a second column-rename-style regression.

V1 + V2 shipped in the same PR for the same reason PR 3 did: `comms-v2` is set per-user, so cutting only one version would leave half the team on a different inbox behavior for the rollout window. V1 uses inline styles + the `D` palette (teal border for the lock banner, amber for Blocked chip, slate-muted for Unknown); V2 uses Tailwind + the `Badge` primitive with `tone="strong"/"muted"`. Both render identical behavior; only the chrome differs.

**Revisit if:** Virginia starts getting customer complaints that legitimately-unknown new leads are being blocked because the Block action is too close to the tap target on mobile — if that happens, move Block to a thread-detail secondary action rather than a row-level affordance. Also revisit once PR 6 (template effectiveness analytics) lands: the filter chips may need an additional `Template-sent` facet to filter down to threads where a template was the last outbound, which the current `statusFilter` state slot can accommodate without schema changes.

---

## 2026-04-18 — PR 5 lands in-house newsletter sender on SendGrid; Beehiiv earmarked for removal

**Decision:** Ship a newsletter composer, subscriber management, and a send path inside the admin portal, built on top of the PR 1 unified comms schema. SendGrid (Twilio-owned) is the sending provider, swapped in late during the design conversation after the operator pre-configured a SendGrid account with domain authentication on `wavespestcontrol.com` (DKIM at `s1._domainkey` + `s2._domainkey`, return-path subdomain `wavesnewsletter.wavespestcontrol.com`, link-tracking subdomain `click.wavespestcontrol.com`). Scope covers everything admin-side — migration, provider wrapper, admin API routes, public unsubscribe endpoint + RFC 8058 one-click header, V2 Newsletter tab with Compose / History / Subscribers sub-views, and a feature flag (`newsletter-v1`) to gate the surface until DNS records propagate. V1 does not get a Newsletter tab — the feature is net-new and V1 users had no newsletter tool before, so this is not a 1:1 visual refresh. Public signup form + spoke-fleet archive pages are explicitly deferred to PR 6 so they can be designed against the customer-facing brand brief rather than the monochrome admin spec.

**Context:** Waves currently pays Beehiiv and uses their hosted newsletter product. Two problems: (a) cost grows with list size and the revenue model is misaligned with a small-list small business, and (b) Beehiiv sends from their own SPF/DKIM (newsletter.wavespestcontrol.com CNAMEs to cname.beehiiv.com for the web archive only) so a customer's newsletter opens never appear on their Customer 360 thread, defeating the whole point of the PR 1 unification. Every newsletter send to a known customer should dual-write into `messages` with `channel='newsletter'` so Virginia reconstructing a customer's history sees the same stream of touchpoints — SMS, voice, email, newsletter — without jumping tools.

**Reasoning on the provider:** The initial design recommendation in the same session was Resend, on grounds of DKIM simplicity (one CNAME vs three) and modern API. The operator pivoted to SendGrid mid-implementation because (a) the Twilio account already exists and adding a SendGrid sub-account collapses billing onto one invoice, (b) the SendGrid Sender Authentication wizard had already been completed before code review, so the DNS work was effectively done, and (c) at the volume Waves actually sends, the per-1k pricing delta between SendGrid and Resend is roughly $5/mo — not load-bearing against the operational simplicity of one vendor. The code wrapper is small enough (~150 LOC) that switching providers later is a ~1-hour change if SendGrid deliverability disappoints. The interface in `server/services/sendgrid-mail.js` (`sendOne`, `sendBatch`, `unsubscribeUrl`, `injectUnsubscribeFooter`) is intentionally vendor-shaped enough to swap without consumer changes — `admin-newsletter.js` only knows about the higher-level helpers, not SendGrid REST shapes.

**Reasoning on the schema:** Splits into three tables — `newsletter_subscribers` gets patched (adds `unsubscribe_token`, `customer_id` FK, bounce tracking, vendor contact id) so the minimal 20260416 table becomes usable for one-click compliance; `newsletter_sends` is one-row-per-campaign with aggregate counters; `newsletter_send_deliveries` is per-recipient and is what a future SendGrid Event Webhook handler will update on `bounce`/`spamreport`/`open`/`click`. Splitting campaigns from deliveries (rather than stuffing everything into `newsletter_sends`) means a 5k-recipient send doesn't require a JSONB array mutation for every event — the webhook handler upserts a single row by message id. The deliveries column is named `resend_message_id` historically (artifact of the brief Resend-first scaffolding); kept as-is to avoid a follow-up rename migration since it's vendor-portable in semantics — it stores whichever provider's message id is current.

**Reasoning on unsubscribe:** Ships RFC 8058 compliant out of the gate. SendGrid's `personalizations[].headers` array supports per-recipient `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, and a `{{unsubscribe_url}}` substitution inside the body footer expands to the per-recipient URL in the same API call (1000-recipient personalizations cap, chunked at 500 for safety). The POST endpoint always returns 200 (even for missing / malformed tokens) because Gmail treats any non-200 as an unsub failure and may penalize sender reputation. The GET endpoint renders a self-contained HTML confirmation page (no template engine, no client bundle) so it works during any outage that might take down the SPA. SendGrid's own `subscription_tracking` is explicitly disabled — we own the unsub flow so Customer 360 stays the single source of truth.

**Reasoning on the feature flag:** Default is off — the tab literally does not appear in the nav until the flag is flipped, because sending before DNS is configured + verified would produce SPF/DKIM-fail bounces that damage `wavespestcontrol.com`'s sender reputation. The gating rationale is not "we're unsure if this works" (it's tested end-to-end via the public unsubscribe path); it's "we physically cannot send mail until DNS propagates and SendGrid's wizard turns green." The flag is a forcing function: flip it the same day DNS goes live.

The Beehiiv service (`server/services/beehiiv.js`) and its `EmailAutomationsPanel` consumer are intentionally left in place — they handle 7 Zapier-replacement automation flows (lead nurture, review thank-you, treatment-specific emails) that are separate from the broadcast newsletter. A later PR will migrate those to SendGrid (or, if the BI agent needs templated marketing automation, to SendGrid Marketing Campaigns) once the newsletter path has run in production for a few cycles and the DNS + deliverability baseline is proven. Do not remove Beehiiv in this PR.

**Revisit if:** Bounce rate exceeds 2% on the first real send, which would indicate the subscriber list imported from Beehiiv has decayed — in that case, run a re-engagement sequence before any blast. Also revisit if SendGrid's shared-IP deliverability proves insufficient (less likely now with the dedicated authenticated domain) — at Waves's volume a dedicated IP is overkill, but Postmark becomes a serious alternative for transactional reputation if needed; the vendor-coupled surface is small enough (the wrapper + future webhook handler) that switching is a single-PR change.

---

## 2026-04-22 — `--danger` token aligned to marketing brand red (`#C8102E`)

**Decision:** Swap the customer-tier `--danger` token in `waves-customer-surfaces-spec.md` §3 from a generic red (`#B91C1C`) to the marketing site's brand red (`#C8102E`, matching `--color-brand-red` on `wavespestcontrol.com`). `--success` stays at `#047857` unchanged — marketing does not define a brand green and the operational success color is a portal concern, not a marketing inheritance. The swap is spec-only for now; `/apps/portal/src/styles/brand-tokens.css` does not yet exist in the repo, so no live CSS change is required and no render-site regression is possible at this stage. When the customer-tier portal surfaces begin implementation (§7.1 `/login` first), the token file will be published with the new value baked in.

**Context:** Same session as the §3 brand-token swap to marketing's `--waves-navy` (`#1B2C5B`) earlier today. Two token placeholders remained after that pass — `--danger` and `--success`. Marketing has a dedicated brand red (`#C8102E`, visible as an accent on bordered marketing elements and pulled from the site's Tailwind config as `--color-brand-red`) but no corresponding brand green. Leaving `--danger` generic while the rest of the tokens pulled from marketing would introduce a visible inconsistency the first time an overdue invoice, a destructive confirm modal, and the marketing CTA were on screen in the same viewing session — the reds wouldn't match, and on a customer portal where the invoice is a branded artifact, that matters.

**Reasoning:** `#C8102E` passes WCAG AA on white surface by a margin — contrast ratio 5.88:1 against `--surface` (`#FFFFFF`) versus the 4.5:1 normal-text threshold, 3:1 large-text threshold. The corrections prompt called out a fallback (`#B00D26`) if AA failed; contrast is clear so no fallback needed and no deviation to note. `--success` stays put because the portal's operational semantic (payment confirmed, service complete, earned-receipt green moment per §7.10) is a portal-tier design decision, not a marketing inheritance — and marketing has no established green to borrow from. Forcing a marketing-aligned green when marketing doesn't have one would be manufacturing a token drift rather than fixing one.

The four documented render sites — `/pay/:token` overdue header band + Amount Due figure, Invoice PDF "PAST DUE" block (§7.11.1), `PortalPage` Balance Due tile overdue state, and destructive `<ConfirmModal>` buttons (admin surfaces per `waves-admin-email-ui-spec.md`, now marked out-of-scope per same-day corrections) — will all inherit the swap automatically via `var(--danger)` once the token file publishes; none have been implemented against the new spec yet, so there is no existing UI to regression.

**Revisit if:** A future build discovers the brand red on a dark or mid-tone admin surface (e.g., a dark-mode variant or a red-on-colored-pill pattern) where `#C8102E` fails AA. The fallback `#B00D26` from the corrections prompt remains the documented secondary; any adopted deviation should add an entry here, not silently change the token file. Also revisit if marketing rebrands — the `--waves-navy` + `--color-brand-red` pair is the current canonical accent pair; if marketing drops one, re-pull and reconcile.

---

## 2026-04-28 — Termite bait install pricing realigned (1.75× → 1.45×, default Trelona → Advance, labor estimate 15 min/sta → 5 min/sta)

**Decision:** Drop `TERMITE.installMultiplier` from 1.75× to 1.45×, switch default `system` from `'trelona'` to `'advance'` across all entry points (`service-pricing.priceTermiteBait`, `estimate-engine.js`, `property-lookup-v2.js`), correct per-station `stationCost` to verified wholesale (`advance` $14 → $13.16 from $131.60/10-cs RFID; `trelona` $24 → $22.05 from $352.80/16-cs pre-baited annual RFID), and re-calibrate the install-labor cost estimate at `service-pricing.js:474` from 0.25 hr/sta (15 min) to 0.083 hr/sta (5 min) to match observed real-world pace. Trelona stays selectable as the premium upsell. Per-station `laborMaterial` ($5.25) and `misc` ($0.75) are unchanged — they are the only labor recovery in the marked-up base (the install labor figure at line 474 is for margin tracking only and does not flow into the customer price), so removing them would silently under-recover labor and was deferred to a separate formula refactor.

**Context:** All U Need Pest Control invoice from 4/29/2025 (same Manatee market, 2750 89th Street Circle E, Palmetto): 21 Sentricon Recruit HD bait stations installed for $375 total (no tax, ~78 min on-site, single tech). Sentricon Recruit HD is active-bait at the same wholesale tier as Advance ($13–15/sta). Our engine on the same 21-sta footprint quoted $1,103 (Trelona default × 1.75) — roughly 3× the competitor's doorstep number. Even on Advance the engine returned $735 (~2× competitor). The 1.75× multiplier had been bumped from a prior 1.45× during a margin audit on the assumption that the install needed to stand on its own; in reality bait-station economics are a 5–10 year monitoring annuity (Waves charges $35–$65/mo) and the install is a foot-in-the-door for that recurring stream, exactly as the competitor is operating.

**Reasoning on the multiplier:** Reverting to 1.45× brings the canonical 21-sta job (1,764 sf footprint, slab, block, standard landscape) to **$583 on Advance** and **$854 on Trelona**. With the corrected labor estimate (see below), engine-reported `installation.margin` lands at **20.5% on Advance** and **23.9% on Trelona** — under the 35% global floor but acceptable for termite, which is the **only** pricing function that doesn't return `marginFloorOk` (`service-pricing.js:485–502` returns `installation.margin` for display but no floor flag), so `discount-engine.js:134` does not reject the line at sub-floor margin. The field is informational; the real economics for bait stations are the 5–10 year monitoring annuity ($35–$65/mo), and the install is the foot-in-the-door. Stress-cases still clear the floor: Advance + crawlspace + wood frame = $821 at 43.6% margin. Going below 1.45× was modeled (1.35× lands Advance at ~$543, 1.25× at ~$502 with the $6/sta buildup intact) and rejected: a single competitor data point isn't a market average, and 1.45× already puts our doorstep within ~50% of the competitor's loss-leader install. If we see 3+ more invoices at $375–$450 across SWFL bait-station competitors, drop to 1.35× as a follow-up; the change is one line.

**Reasoning on the labor estimate change:** The pre-existing 0.25 hr/sta (15 min) figure at `service-pricing.js:474` predates the wholesale audit and proved empirically wrong against the competitor invoice — 21 Sentricon stations installed in 78 min by one tech = 3.7 min/sta. Bait-station install is fast: walk the perimeter, auger or core a hole, drop the pre-baited cassette, cap, log the RFID. It is not the trenching-and-injecting work the legacy figure seems to assume. Calibrating to 5 min/sta (0.083 hr) is the conservative middle ground — slightly above the observed 3.7 min/sta to absorb travel between stations on irregular lots, irrigation chase, and per-station data entry, but well below the 15 min that effectively double-billed labor on top of the $5.25/sta `laborMaterial` buildup that was already present in the marked-up base. Net effect: reported install margin moves from ~−0.5% / 9.5% (Advance/Trelona at 1.45× with the old labor figure) up to 20.5% / 23.9%, which is what the unit economics actually look like. This change touches only the cost-side margin computation; `installPrice` (the customer-facing number) is unaffected. The figure is hard-coded with no DB override path, so the migration in this PR doesn't need to address it.

**Reasoning on the default switch:** Trelona was the historical default in part because it ships pre-baited (no separate cartridge install), but the price difference is significant ($22.05 vs $13.16 wholesale = $186/sta delta marked up at 1.45× = ~$270 difference on a 21-sta job). For the residential SWFL market where the competitive doorstep is the deciding number, leading with Advance is the right shape — Trelona becomes a "premium active monitoring" upsell with a clear story (RFID + always-active bait + fewer service callbacks for recharging) rather than the silent default. The orchestrator at `estimate-engine.js:181` and the property-lookup pre-fill at `property-lookup-v2.js:1219` both updated to match so admins building a quote without explicitly choosing get Advance.

**Reasoning on wholesale cost correction:** The prior $14/$24 figures were within $1–2 of actual wholesale, so the cost correction itself moves the headline number trivially (~$15–25 on a 21-sta job). The reason to update them anyway is engine integrity — `installMargin` at `service-pricing.js:477` is reported back to the estimate UI and feeds margin-floor checks at `GLOBAL.MARGIN_FLOOR` (35%). Slightly inflated cost basis falsely depresses reported margin; correcting it gives operators (Waves directly) accurate visibility when they're editing prices at the margin.

**Reasoning on the unchanged $6/sta buildup:** `service-pricing.js:473–476` calculates `installMaterialCost = stations × (stationCost + laborMaterial + misc)` and applies the 1.45× markup only to that aggregate; `installLabor` (15 min × $35/hr per station) is computed at line 474 but only flows into `installCost` for margin tracking, not into the marked-up base. The $5.25 `laborMaterial` + $0.75 `misc` per station, marked up 1.45×, contributes ~$8.70/sta to the customer price — close to the actual labor cost ($8.75/sta) it's effectively standing in for. Removing the buildup as "redundant" was tempting on first read but would drop labor recovery to zero, leaving the install priced at material × 1.45 only and putting margin under floor on small jobs. The cleaner long-term fix is to fold actual install labor into the marked-up base and delete the synthetic buildup; that's a formula refactor with regression-test implications and was scoped out.

**DB migration:** The `pricing_config` table has two coexisting termite_install schemas — short-key (from `admin-pricing-config.js`, what `db-bridge.js:127–141` actually reads) and long-key (from migration `20260414000026`, dead-read but populated). Migration `20260428000004_termite_install_pricing_april_2026.js` does a single JSONB merge that updates both shapes so any environment converges regardless of which seeder ran. Without the migration, `db-bridge.js`'s 60s reload would silently overwrite the new `constants.js` defaults with the stale DB row.

**Revisit if:** Three or more SWFL competitor invoices come in at $375–$500 for ~20-sta installs (drop multiplier to 1.35× and consider rebalancing the buildup at the same time). Also revisit if the Corteva or BASF wholesale lines change by >10% — the cost basis is hard-coded and `db-bridge.js` only overrides if the DB row has the matching key. Also revisit if Waves decides Trelona's RFID + always-active bait is a meaningful enough differentiator to lead with again, in which case the default flip is one line back.

---

## 2026-05-03 — Public booking confirms customers from address match and stabilizes curated availability

**Decision:** Ship the address-based public-booking flow in two mainline commits: `c064afa` (`Fix public booking availability loop`) and `db23154` (`Confirm booking customer from address match`). The public booking page now avoids reloading availability when the geocoded coordinates are unchanged, hides redundant address-label copy, and switches the step-3 copy to a confirmation state when an existing customer is uniquely matched by address.

**Context:** The touched surface is `client/src/pages/PublicBookingPage.jsx`; the backend touchpoint is `server/routes/booking.js` (`GET /api/booking/customer-lookup` and `POST /api/booking/confirm`). Customer lookup can now resolve a single customer by normalized address with optional city/ZIP guards, and confirmation re-verifies that address before accepting an existing-customer booking without phone verification.

**Reasoning:** The booking-curation rules remain aimed at presenting the 3-4 best times instead of a raw slot dump: prefer different days, balance AM/PM choices, and weight soonness so customers see useful near-term options without every refresh reshuffling the list. The address-match confirmation path reduces friction for known customers booking from their service address while avoiding ambiguous address collisions by requiring a unique match.

**Revisit if:** Multiple customers legitimately share the same service address (multi-unit, property manager, duplex) and the unique-match rule blocks good bookings. In that case, add unit-aware matching before loosening the existing address verification.

---

## 2026-05-23 — Data Hygiene Agent ships deterministic-first, proposal-based, and sensitive-aware

**Decision:** Build the Data Hygiene Agent as a phased, review-first system: scanners create `data_hygiene_proposals`; admins approve/reject through an allowlisted apply layer; every applied/reverted mutation writes a transactional `audit_log` row. Phase 0 creates the durable foundation only: `data_hygiene_runs`, `data_hygiene_proposals`, `data_hygiene_source_extractions`, `data_hygiene_sensitive_vault`, feature gates, audit helpers, and a no-op orchestrator with a DB-backed run lock and stuck-run reaper.

**Context:** The live data snapshot on 2026-05-22 reframed the work. The visible raw-phone inbox rows are primarily orphaned `conversations.customer_id IS NULL`, not blank customer names. Calls are the richer source for operational details: `call_log.ai_extraction` already has hundreds of structured rows, and call transcripts are more useful for gate/access extraction than inbound SMS. Dedupe must stay advisory and account-level because multiple `customers` rows under one `customer_accounts` row represent real rentals, second homes, property managers, and shared contacts. Shared phone/email alone is not a merge signal.

**Reasoning:** Deterministic rules (phone/email/ZIP/name whitespace, link candidates, backfill candidates, dedupe candidates) stay explainable and reviewable. LLM use is limited to Phase 4 extraction, gated separately, tracked in `data_hygiene_source_extractions` by `(source_type, source_id, extractor_version, source_hash)`, and retry-limited with `attempt_count` plus terminal `failed_max_retries` so bad transcripts do not burn budget forever. `data_hygiene_runs` uses a partial unique index on `status='running'` instead of `pg_try_advisory_lock`, avoiding pooled-connection lock/unlock ambiguity. The reaper marks stale running rows failed after two hours so a missed close cannot permanently block scans.

Sensitive operational fields (gate codes, lockbox codes, garage codes, access notes) are not stored raw in proposal or audit rows. Normal proposal/audit surfaces hold redacted values and keyed HMAC hashes; raw before/after values live in `data_hygiene_sensitive_vault` encrypted with `DATA_HYGIENE_VAULT_KEY`, read only for permissioned reveal/revert paths and themselves audit-logged. This reconciles two requirements that otherwise conflict: masked long-lived audit tables and conflict-guarded safe revert.

**Constraints baked into the design:** `stripe_customer_id` and Square fields are read-only; email-derived names remain low-confidence proposals forever; auto-apply is explicit opt-in in every environment; Phase 1.5 bootstrap can backfill only from already-linked calls, while orphan calls produce link proposals first; actual merge execution is out of scope for v1 and the Possible duplicates tab is read-only.

**Revisit if:** The first dry-run week shows more than 2% rejection on any auto-apply candidate rule, if the sensitive vault needs key rotation tooling, or if property managers/multi-property accounts create too many ambiguous link proposals for manual review. Actual merge handling should remain a separate Stripe-aware Phase 6 plan.

---

## 2026-05-28 — Pest pricing: margin guard, one-time recurring-incentive model, config guardrails

**Decision:** Three coupled changes to pest control pricing in `server/services/pricing-engine/`:
1. **Post-discount margin guard for pest.** Generalized `applyMarginGuard` (was Tree & Shrub-only) to also cover `pest_control`, using pest's single `costs.annualCost` (direct + admin) as the cost basis. The WaveGuard **auto** discount is now capped so displayed margin never drops below the 35% floor; the estimate engine applies the guard to pest in the same branch as T&S. **Manual** owner discounts are intentionally NOT capped — they emit a warn-only entry in `summary.marginWarnings` (`type: manual_discount_below_margin_floor`, distributed proportionally across eligible recurring lines) and set `manualMarginWarning`/`manualFinalMargin` on the line. `validateEstimateDiscounts` stays retired (returns `[]`); the new warnings are computed inline in `estimate-engine.js`.
2. **One-time pest = `(quarterlyPerApp + $99 setupEquivalent) × 1.20 premiumMultiplier`**, floored at $199 (rarely binds). Replaces the old `quarterly × 1.75`. The one-time price is now always **anchored on the quarterly rate** — the estimate engine passes pest line `basePrice` (frequency-independent) instead of the selected-frequency `perApp`, fixing a bug where a customer quoted recurring monthly would get a one-time anchored on the discounted monthly per-app. New `ONE_TIME.pest` shape: `{ setupEquivalent, premiumMultiplier, floor }` (legacy `multiplier` removed).
3. **DB-bridge economic guardrails.** `validatePestPricingConfig` now rejects `frequencyDiscounts` outside `(0, 1]` and validates the new `ONE_TIME.pest.{premiumMultiplier, setupEquivalent}` fields. (`floor > base` is intentionally allowed — it just raises the minimum quote; `max(floor, base + adjustments)` still lets larger homes exceed it.) Sync reads new `onetime_pest` keys (`setup_equivalent`, `premium_multiplier`); the legacy `multiplier` key is ignored (different semantics — would mis-map). Migration `20260528000021_onetime_pest_setup_premium_model.js` rewrites existing `pricing_config.onetime_pest` rows to the new shape (preserving any customized floor); the route seed default is updated to match.

**Context:** Originated from a pest-pricing audit. Findings: pest had no margin-floor enforcement after discounts (only T&S did), so WaveGuard + manual discounts could silently quote pest below cost; `validateEstimateDiscounts` was a no-op; DB validation was type-only (accepted 0/negative/base<floor); and one-time pest (~$205) sat at or below a recurring customer's visit-1 cost ($99 setup + $117 quarterly = $216), giving customers no reason to commit to recurring.

**Reasoning:** Owner chose "cap auto, warn on manual" (loss-leader/goodwill pricing stays possible but is flagged) and "setup + premium markup" for one-time (one-time now strictly exceeds recurring entry: ~$259 vs $216 at 2,000 sf). At default constants the margin cap never binds (pest margins ~47–61% even at Platinum), so existing quotes are unchanged; the guard only engages if base is lowered or discounts deepened. The client-side `client/src/lib/estimateEngine.js` still carries the legacy `× 1.75` one-time math but is deprecated and not the live pricing path (V2 admin tool prices via the server engine); it was left untouched.

**Revisit if:** the margin cap starts binding on normal Platinum bundles (means base/cost drifted and pest base pricing needs a real re-anchor, not a discount cap), or if the one-time premium suppresses one-off conversions enough to hurt top-of-funnel. The legacy client estimateEngine one-time math should be reconciled or removed when that file is next refactored.

---

## 2026-05-29 — One-time pest = pure multiple off the quarterly rate (2.2×)

**Decision:** Replace the one-time pest formula `max($199, (quarterlyPerApp + $99) × 1.20)` (shipped days earlier in #1324) with a straight multiple: **`max($199, quarterlyPerApp × 2.2)`**. Drop the flat `setup_equivalent` ($99) and `premium_multiplier` constants; one knob now: `ONE_TIME.pest.{multiplier: 2.2, floor: 199}`. Migration `20260528000031` rewrites the `pricing_config.onetime_pest` row to `{floor, multiplier}` (supersedes `20260528000021`); seed default + db-bridge sync (`onetime_pest.multiplier`) + the client mirror (`lib/estimateEngine.js`) all updated to match.

**Context:** Owner's insight during review of #1324: one-time pest should **not** carry a separate size component, because the quarterly rate already encodes every property metric — footprint, lot, tree/shrub density, pool/cage, driveway, complexity, property type, age. A flat `+$99` add-on actually *inverted* the scaling: small/simple homes paid a higher effective multiple (~2.5× quarterly) than loaded/complex ones (~1.9×), the opposite of real job cost. A pure multiple makes one-time track job difficulty proportionally.

**Reasoning:** 2.2× keeps a typical home (~$117 quarterly) at ~$257 (≈ the prior $259, smooth transition) while correcting the curve: small/simple homes settle at the $199 floor (keeps the foot-in-the-door lead competitive), loaded homes rise to reflect real effort (e.g. ~$180 quarterly → ~$396). The recurring incentive is preserved and **enforced two ways** (both surfaced and hardened across Codex review rounds): (1) the db-bridge validates `floor` and `multiplier` *together*, scanning reachable quarterly bases with the SAME dollar rounding the pricer uses (`max(otFloor, round(q × multiplier))`) and requiring the result to stay **strictly above** recurring visit-1 (`PEST.floor + PEST.initialFee`) — so neither a lowered floor nor a near-boundary multiplier that only ties after rounding can quietly break it; (2) a runtime post-discount clamp keeps the 15% recurring-customer loyalty perk from ever dropping a one-time visit to/below that same recurring visit-1 cost on small homes (clamped strictly above, +$1 minimal margin since prices are whole dollars). Together these guarantee a one-off is always strictly more expensive than committing — for every property and every customer type.

**Blast radius:** At default constants the change only moves one-time pest (typical ~flat, loaded up, small down to floor); recurring pricing, the margin guard, and all other services are untouched. Migration is pre-deploy + fail-fast; sync reads only `multiplier` (legacy `premium_multiplier`/`setup_equivalent` ignored, incompatible with the `>=2` guard). Client mirror updated in lockstep (drift test enforces parity).

**Revisit if:** one-time conversion data shows 2.2× is suppressing one-off leads (lower it toward 2.0, the floor of the guard), or margin analysis on heavy initial visits says the multiple should be higher for the largest properties (consider a mild progressive multiple rather than reintroducing a flat add-on).

---

## 2026-05-29 — German Roach Cleanout = severity tiers, all-in flat price (replaces footprint + setup charge)

**Decision:** Replace the German Roach Cleanout (`german_roach`) pricing model. Old: footprint-interpolated base (`$450` base, `$400` floor, `±$40…+$85` footprint adjustment) **plus** a separate `$100` setup charge, fixed at 3 visits (`total = price + 100`, e.g. `$574` at 2,800 sf). New: a flat, **all-in** price keyed purely on infestation severity, with the visit count rising by tier:
- Light → `$350`, 2 visits
- Medium (`moderate`) → `$450`, 3 visits
- Heavy → `$550`, 4 visits

The tier price is the full customer total — there is **no separate setup charge** (`setupCharge: 0`) and **footprint is no longer consulted at all**. `severe` collapses into the Heavy tier; a missing/invalid severity defaults to **Light** (`severityWasDefaulted: true`). `pricingModel` is now `german_roach_severity_tier_cleanout` (the old `german_roach_three_visit_cleanout` is retained as `legacyPricingModel` for backward compat). The line stays `noRecurringDiscount` (excluded from WaveGuard/recurring percentage discounts) as before.

**Implementation:** `SPECIALTY.germanRoach` in `constants.js` is now `{ defaultSeverity, tiers: { light, moderate, heavy } }` (the `base`/`floor`/`setupCharge`/`footprintAdj` keys are gone). `priceGermanRoach` (`service-pricing.js`) does a severity → tier lookup instead of footprint interpolation. The client mirror (`client/src/lib/estimateEngine.js`) was updated in lockstep (drift test enforces server/client parity across all three tiers). `severity` now flows through both line-item normalizers (`v1-legacy-mapper.js` + client) so the quoted tier is visible to the UI. `db-bridge.js`'s `validatePestPricingConfig` was updated to validate the new tier shape (`defaultSeverity` references a real tier; each of light/moderate/heavy has a positive `price` and `visits`) instead of the removed `base`/`floor`/`footprintAdj` keys. The V2 server translate path (`property-lookup-v2.js`) already forwarded `germanRoachSeverity || roachSeverity` into `services.germanRoach`, so no engine-routing change was needed there.

**Admin UI:** both estimators (`EstimateToolViewV2.jsx` default, legacy `EstimatePage.jsx`) now show an **Infestation Severity** selector (Light/Medium/Heavy with visit + price hints) when the roach Service Type is "German Roach Cleanout", wired to a new `germanRoachSeverity` form field (defaults `light`). V2 posts it in the server options payload; the legacy page maps it to `roachSeverity` for the client-preview engine. The Service Type option label dropped the hardcoded "— 3 Visit Program" suffix since the visit count is now tier-dependent.

**Context:** Owner request — the old footprint+setup model "made no sense" for German roach: square footage is a poor proxy for the real cost driver (number of return trips to break the breeding cycle), and the separate setup charge obscured the all-in price. Severity tiers are easier for the office/techs to quote and for customers to understand, and tie visit count directly to infestation severity.

**Blast radius:** Only `german_roach` pricing moves; every other service (including the single-visit `pest_initial_roach` initial knockdown fees and the zeroed `roachModifier`) is untouched. The DB seed row `onetime_german_roach` is inert with respect to the engine (db-bridge only validates `SPECIALTY.germanRoach`; it does not override it from DB config), so no migration was needed. Default (no severity selected) now quotes Light/$350/2 visits where the old default was $574 at 2,800 sf.

**Revisit if:** severity self-reporting proves unreliable (techs consistently re-tier on site) — consider an in-field severity confirmation step before the cleanout price locks; or if a very large heavy infestation genuinely costs more than the flat Heavy tier covers (reintroduce a bounded size or visit add-on rather than reverting to footprint interpolation).

---

## 2026-05-29 — WDO inspection → filled FDACS-13645 PDF + combined report-with-invoice send

**Decision:** Built the missing pieces of the WDO inspection workflow so a `wdo_inspection` project can be turned into the genuine, filled state form and delivered to the customer alongside an invoice in a single action.

**What shipped:**
- `server/services/pdf/wdo-report-pdf.js` — fills the **real** FDACS-13645 AcroForm from `project.findings` using `pdf-lib`, then flattens it. Field map covers Section 1 company/inspector header (from `server/constants/business.js`), property/requester, Section 2 finding checkboxes + narrative, inaccessible-area checkboxes (keyword-detected), previous-treatment + treated-at-inspection radios, treatment method, and Section 5 comments. The form is flattened (locked); the licensee **signature line is left blank** by design.
- The official `forms.fdacs.gov/13645.pdf` is owner-password encrypted with no usable AcroForm in the older bundled copy. The current official form **is** a fillable AcroForm (71 fields). We committed the decrypted (qpdf `--decrypt`, empty password) fillable copy to `server/assets/forms/fdacs-13645-fillable.pdf` as the fill template. The pre-existing flat reference PDF at `client/public/forms/fdacs-13645-wdo-inspection-report.pdf` is untouched (techs still open it as a reference).
- `POST /admin/projects/:id/send` now attaches the filled FDACS-13645 PDF to the report email for WDO projects.
- `GET /admin/projects/:id/fdacs-pdf` — admin preview/download of the filled form.
- `POST /admin/projects/:id/send-with-invoice` — combined delivery: **one** email (FDACS PDF + invoice PDF attached, report link + pay link in body) and **one** SMS (report link + pay link). Supports `dry_run` to surface the resolved invoice amount before sending. Auto-creates a draft WDO inspection invoice when none is linked, priced from `SPECIALTY.wdo.brackets` (≤2500 $175 · ≤3500 $200 · >3500 $225). On delivery it transitions the invoice `draft → sent` directly (not via `InvoiceService.sendInvoice`) so the invoice's own SMS path doesn't fire a duplicate text.
- `project-email.js` gained `attachments` pass-through on `sendProjectReportReady` + a new `sendProjectReportWithInvoice` (reuses the seeded `project.report_ready` template — no new template to ship).
- UI: a **"Send report + invoice"** button on the WDO project detail (`ProjectsPage.jsx`), gated to `wdo_inspection`, non-closed projects. Dry-run first to confirm the invoice amount, then send. New `pdf-lib` dependency added to `server/package.json`.

**Signature protocol:** Per Rule 5E-14.142 F.A.C. / Ch. 482.226 F.S., form 13645 must carry the licensee/cardholder signature and date. We do not auto-forge a signature — printed name, ID-card number, and date are filled; the signature line stays blank for the licensee to sign before filing. A stored-signature-image option was deliberately deferred.

**Blast radius:** Additive. New module + two new routes + one extended email helper + one UI button. The existing `/send` flow is unchanged except for the WDO email attachment. To avoid coupling the projects route's boot to the `@waves/lawn-cost-floor` workspace package, the WDO fee is read from `pricing-engine/constants.js` (pure config) rather than importing `service-pricing.js`.

**SMS constraint:** SMS cannot carry attachments, so the customer gets the FDACS + invoice PDFs by email; the SMS carries the report link and the pay link. Both PDFs are also reachable from those links.

**Revisit if:** the owner wants the signature captured digitally (add a stored/e-sign step before flatten); or wants the combined send to skip the dry-run amount confirmation; or FDACS reissues the form with renamed fields (the filler logs and skips unknown fields rather than throwing, so a revision degrades gracefully but should be re-mapped).

**Addendum (same day, PR #1386 review):** WDO auto-invoice pricing changed from the `SPECIALTY.wdo.brackets` lookup to a **flat $250** for now, per owner. The real WDO tiers are **$150 / $200 / $250** by *structure* footprint, but the WDO inspection form doesn't capture structure footprint yet (`customers.property_sqft` is treated *lawn* area, not the structure), so inferring a tier from customer columns mis-bills small houses on large lots. The flat fee is a draft the operator can adjust in the dry-run; switch `resolveWdoInspectionFee` to the $150/$200/$250 tiers once the form captures structure sq ft. Also: the FDACS Section-1 inspector identity (Print Name / ID Card No) is now resolved from the project's technician (`created_by_tech_id` → `technicians.name` + `fl_applicator_license`), since the WDO findings don't collect it and the PDF routes load the project without the `tech_name` join.

**Addendum 2 (same day, PR #1386):** Three WDO additions. (1) **Licensee e-signature** — per owner, a WDO report is an official FDACS-13645 filing and now requires a captured signature before it can be sent. New `projects.wdo_signature` JSONB, a `POST/DELETE /admin/projects/:id/wdo-signature` endpoint, a canvas `WdoSignaturePad` on the WDO project detail, and the signature image is stamped into the form's `signaturelicensee` field before flattening. The report/combined sends now 422 with `code: 'signature_required'` until signed; the detail GET returns signature metadata only (image stripped). (2) **Supplemental Photo Addendum** — the generated PDF now appends addendum pages (2 captioned photos per page, "Page A-N") built from the project's S3 photos, matching the owner-supplied sample. (3) **Combined-send invoice guard** now also rejects `processing`/`sending` invoices (not just paid/void), matching the canonical invoice non-sendable set. Note: AI-written WDO narrative and photo upload already existed (`draftProjectReport` is photo-grounded; `project_photos` + `WdoIntelligenceBar`), so this work focused on the report *output* (signed FDACS + photo addendum) rather than re-building capture.

**Addendum 3 (same day, PR #1386):** WDO auto-invoice pricing moved from the interim flat $250 to **structure-footprint tiers** ($150 ≤2500 sq ft · $200 ≤3500 · $250 >3500), now that the WDO form captures footprint. Added a `structure_sqft` findings field to `wdo_inspection`; `resolveWdoInspectionFee(findings)` tiers on it and defaults to the top $250 tier when it's blank (conservative; operator adjusts in the dry-run). Kept local rather than `SPECIALTY.wdo.brackets` (still $175/$200/$225 and keyed to lawn-area `property_sqft`), which the owner confirmed is stale; the customer-facing estimate engine still reads those constants and is out of scope for this PR.

**Addendum 4 (same day, PR #1386):** WDO "Property specs" — the WDO Intelligence lookup (`lookupPropertyFromAITrio`, Claude web_search over SWFL county appraisers + listing sites) already resolved construction material / foundation / roof / year built / sq ft / stories; now surfaced. `WdoIntelligenceBar` renders a **Property specs** panel (with source + confidence + "verify on site") and an **Apply to report** button that maps the profile onto findings via `client/src/lib/wdoProfileToFindings.js`: sq ft → `structure_sqft` (drives the fee), stories+construction → `structures_inspected`, slab foundation → a Section-3 "Crawlspace: N/A — slab-on-grade" note, and year/construction/roof → Comments. The resolved profile is cached on `projects.property_profile` (new column) so the panel renders on reload without re-running the lookup; the detail GET returns it (image-free, small) and the list strips nothing extra. Suggestions only — everything stays tech-editable for the legal filing. (Phase 1+2 of the property-specs idea; prior-treatment/permit-history lookup deferred as Phase 3.)
