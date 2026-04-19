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
