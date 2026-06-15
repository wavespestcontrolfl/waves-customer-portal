# Backlink Manager — Design Plan

**Status:** Draft / pre-implementation
**Owner:** Adam
**Date:** 2026-05-30
**Surface:** `/admin/seo → Backlinks → Link Building` (new sub-tab)

---

## 1. Goal

Add the one missing layer to the portal's backlink system: an **outbound link-building
pipeline** that tracks every link prospect from *identified target* → *live, followed, and
indexed*. Today the portal monitors the *inbound* profile (toxicity, loss, snapshots) and
*acquires* low-tier links (Playwright signup agent), but nothing tracks the lifecycle of a
single intended link, and **nothing checks indexing status at all**.

Hermes Agent (Nous Research, self-hosted) is adopted **only as the autonomous acquisition
worker** ("the hands"), behind a strict write-back boundary. It is never the strategist and
never the system of record.

### Field mapping (the requested columns → schema)

| Requested field        | Column                          | Source of truth                |
|------------------------|---------------------------------|--------------------------------|
| Prospect               | `target_domain` / `target_url`  | strategy agent / manual / gap  |
| Link status on Google  | `indexing_status`               | **GSC URL Inspection API**     |
| Target page            | `target_page`                   | strategist (the money page)    |
| Anchor text            | `anchor_planned` / `anchor_text`| planned vs. verified-live      |
| Placement date         | `placement_date` / `first_live_at` | verifier                    |
| Live URL               | `live_url`                      | Hermes report → verifier       |
| Link type              | `link_type`                     | strategist / classifier        |
| Follow / nofollow      | `is_dofollow`                   | **live verifier** (not assumed)|
| Indexing status        | `indexing_status`               | GSC URL Inspection             |
| Quality signals        | `quality_signals` (jsonb)       | DataForSEO + computed          |

---

## 2. Architecture — Brain / Books / Hands

```
  BRAIN (exists, keep)              BOOKS (build)                      HANDS (Hermes, new)
  ────────────────────              ─────────────                      ──────────────────
  waves-backlink-strategist    →    seo_link_prospects board     ←     Hermes acquisition
  Claude MODELS.FLAGSHIP            (Postgres = canonical funnel)       worker (self-hosted)
  decides WHAT to pursue,           reconciled nightly vs GSC +         executes signup/outreach,
  prioritizes, writes prospects     live profile (seo_backlinks)        crawls to verify, reports back
```

**Invariants**
1. **Brain stays Claude.** Strategy/prioritization remains the existing Managed Agent on
   `MODELS.FLAGSHIP`. Per standing rule "best system regardless of cost," we do not move
   reasoning onto Hermes' open/multi-model routing.
2. **Books stay in Postgres.** `seo_link_prospects` is the single funnel. Hermes never holds
   canonical state — its persistent memory holds *procedural* knowledge ("how to sign up at
   site X"); the portal DB holds *factual* state ("what is live and indexed").
3. **Verify, don't trust.** Hermes *claims* a placement; the portal's own verifier + GSC
   *confirm* it. A prospect only reaches `live`/`indexed` via portal-side verification.

---

## 3. Data model

### 3.1 New migration — `seo_link_prospects`

`server/models/migrations/2026XXXX_seo_link_prospects.js`

```js
exports.up = async (knex) => {
  await knex.schema.createTable('seo_link_prospects', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // Target (where the link will live)
    t.text('target_domain').notNullable();
    t.text('target_url');                       // specific page, if known
    t.integer('domain_rating');

    // Our side
    t.text('target_page').notNullable();        // the Waves money page being linked to
    t.string('anchor_planned');                 // anchor the strategist wants
    t.text('anchor_text');                       // anchor actually found live

    // Classification
    t.string('link_type');                       // editorial|directory|citation|guest_post|resource|social|haro
    t.string('source').notNullable();            // strategy_agent|competitor_gap|signup_agent|manual
    t.uuid('source_ref');                        // FK-ish back-pointer (gap id / queue id), nullable

    // Lifecycle
    t.string('status').notNullable().defaultTo('prospect');
    // prospect → contacted → negotiating → placed → live → indexed → lost | rejected
    t.string('priority');                        // high|medium|low (from strategist)
    t.date('placement_date');                    // when link went live (manual or detected)
    t.timestamp('first_live_at');                // first time verifier saw it live

    // Verified attributes (NEVER trusted from the agent's self-report)
    t.text('live_url');                          // exact URL the link sits on
    t.boolean('is_dofollow');                    // read from live rel=, null until verified
    t.string('indexing_status').defaultTo('not_checked'); // not_checked|indexed|not_indexed|crawled_not_indexed
    t.timestamp('last_live_check');
    t.timestamp('last_index_check');

    // Intelligence
    t.jsonb('quality_signals');                  // DataForSEO-sourced: {rank, referring_domains, spam_score, page_relevance, anchor_health}
    t.uuid('backlink_id').references('id').inTable('seo_backlinks'); // promoted link, once it appears inbound

    // Outreach / ops
    t.string('owner');                           // human or 'hermes'
    t.text('outreach_thread_ref');               // email thread / channel id
    t.timestamp('outreach_sent_at');
    t.timestamp('claimed_at');                   // worker lease timestamp (claim/report contract)
    t.string('claimed_by');                      // 'hermes' lease holder
    t.text('evidence_url');                      // screenshot/proof from the worker
    t.integer('attempts').defaultTo(0);
    t.text('notes');
    t.decimal('cost', 10, 2);

    t.timestamps(true, true);
    t.unique(['target_domain', 'target_page']);  // one prospect per (site, money-page)
    t.index('status');
    t.index('indexing_status');
  });
};

exports.down = (knex) => knex.schema.dropTableIfExists('seo_link_prospects');
```

### 3.2 Relationship to existing tables (no duplication)

- `seo_backlinks` — inbound profile (toxicity/loss). A prospect **promotes** to it: when the
  nightly cross-link finds `live_url` in `seo_backlinks`, set `backlink_id` and
  `status='indexed'` (or `live`). `seo_backlinks` stays the inbound source of truth.
- `seo_competitor_backlinks` — already has `prospect_status`/`outreach_sent_at`. These rows
  become a **feeder**: a competitor-gap row the strategist greenlights creates a
  `seo_link_prospects` row (`source='competitor_gap'`, `source_ref = gap.id`). The gap table
  stays intel; the board owns the lifecycle.
- `backlink_agent_queue` / `backlink_agent_profiles` — the Playwright signup pipeline. Each
  completed profile creates/updates a prospect (`source='signup_agent'`). Migrated to Hermes
  in §8.

---

## 4. Reconciliation jobs (portal-side "verify, don't trust")

Three jobs keep the board honest. All in `server/services/seo/`, wired into
`server/services/scheduler.js` (existing weekly Sunday 3:30am backlink scan stays).

### 4.1 Live / follow verifier — `link-prospect-verifier.js`
- **Primary source = DataForSEO Backlinks API** (`/backlinks/backlinks/live`). Per-link it
  returns `dofollow`, `anchor`, `is_lost`, `first_seen`, `last_seen`, `rank`, `backlink_spam_score`
  — so for any link DataForSEO has indexed we set `is_dofollow` / `anchor_text` / live-vs-lost
  **without crawling**. ⚠️ The existing `dataforseo.getBacklinks()` hard-filters
  `['dofollow','=',true]` — add a `getBacklinkDetail(targetUrl/sourceUrl)` (or relax the
  filter) so nofollow links are visible to the verifier.
- **Fallback = direct crawl** for *fresh* links not yet in DataForSEO's index: fetch
  `live_url`, confirm an `<a>` to a `wavespestcontrol.com` target page, read `rel=` for real
  follow/nofollow, capture live `anchor_text`. (Reuse `onPageAudit` / the existing
  `waves-customer-portal-link-verifier` worktree logic.)
- Transitions: `placed → live` (found, set `first_live_at`), `live → lost` (DFS `is_lost`
  or crawl miss).
- **Schedule:** nightly. DataForSEO pass first (cheap, batched), crawl only the residue.

### 4.2 Indexer — `link-prospect-indexer.js`  ← the net-new capability
**Correction (2026-05-30):** GSC URL Inspection works **only on URLs inside our own verified
property** — it *cannot* inspect a third-party linking page. So `indexing_status` (the requested
"link status on Google", which is about the *external* page hosting our link) uses **DataForSEO**,
and GSC URL Inspection is repurposed for what it *can* do — confirming our own money pages.

- **`indexing_status` (external linking page)** → `dataforseo.checkIndexed(live_url)`, a
  `site:` SERP lookup. Returns `indexed | not_indexed | unknown`. An unindexed linking page
  passes ~no equity, so this is the signal that matters.
- **`quality_signals.target_indexed` (our money page)** → `SearchConsole.inspectUrl(target_page)`
  via the existing service-account client (`urlInspection.index.inspect`, `webmasters.readonly`
  scope — confirmed authorized). Cached per unique `target_page` within a run to save quota.
- Only checks prospects already `live`/`indexed`; oldest `last_index_check` first; capped per
  run (DataForSEO SERP costs credits → gated by `seoIntelligence`). Promotes `live → indexed`
  when the linking page is found indexed; demotes back if it drops out.
- **Schedule:** nightly (5:00AM ET), after the verifier (4:30AM ET).

### 4.3 Profile cross-link — folded into the nightly scan
- After `BacklinkMonitor.scan()`, match live `seo_backlinks.source_url` against
  prospect `live_url`; on hit set `backlink_id` + promote status. Closes the loop between
  "we built it" (outbound) and "Google sees it on our profile" (inbound).

### 4.4 DataForSEO usage map (we already have access — `DATAFORSEO_LOGIN/PASSWORD`)

| Need                     | DataForSEO endpoint                          | Used by            |
|--------------------------|----------------------------------------------|--------------------|
| Live / follow / lost     | `/backlinks/backlinks/live`                  | §4.1 verifier      |
| Domain quality signals   | `/backlinks/summary/live`, bulk `rank`/`spam_score`/`referring_domains` | `quality_signals`  |
| Page relevance / live-check fallback | `/on_page/instant_pages` (`onPageAudit`) | §4.1 fallback |
| **Prospect discovery**   | `/backlinks/domain_intersection/live`, `/backlinks/competitors/live` | feeder (below) |

**Discovery feeder (new).** DataForSEO domain-intersection ("links competitors have that we
don't") can auto-source prospects straight into the board (`source='competitor_gap'`,
quality_signals pre-filled), complementing the strategist and reducing dependence on the
X-poller for sourcing. Runs alongside the weekly strategy cycle; the strategist triages the
feed and sets `priority`/`target_page` before it's worked.

**Credit discipline:** all DataForSEO is gated by `seoIntelligence` and already logs per-call
cost. Use **bulk** endpoints for quality signals (one call, many domains), batch the verifier,
and align discovery to the existing weekly Sunday cadence rather than per-prospect calls.

---

## 5. Hermes integration (the hands)

### 5.1 Deployment — **Docker** (decided 2026-05-30)
- Self-hosted per Nous instructions (`hermes setup`) using the **Docker sandbox backend**, in
  its own container, not in the portal process. Reaches the portal only over the HTTP contract
  below. Subagents get isolated Docker exec environments (the §2 "parallel processing" win).
- **Outreach sends via the existing Waves Gmail OAuth** (decided 2026-05-30) — Hermes does not
  own a separate inbox. See §9 for the deliverability mitigation this choice requires.

### 5.2 Ownership split
| Hermes owns (procedural memory)        | Portal owns (canonical state)         |
|----------------------------------------|---------------------------------------|
| How to sign up / fill a form at site X | Whether a link is live / followed     |
| Learned skills, retry heuristics       | Indexing status (GSC)                  |
| Vision/browser session state           | Funnel status, priority, costs        |
| Channel/outreach drafting              | Approval gates, audit trail           |

### 5.3 Write-back contract (two endpoints — extend `admin-backlink-agent-v2.js`)

A worker, not a peer system. Add to the existing router (already auth'd
`adminAuthenticate, requireTechOrAdmin`; Hermes uses a service token):

```
GET  /api/admin/backlink-agent/prospects/claim?n=10&type=signup|outreach
       → leases N prospects in status 'prospect' (type-filtered), sets
         claimed_at/claimed_by='hermes' under a transaction + FOR UPDATE SKIP LOCKED
         so parallel Hermes subagents never grab the same row. Returns work packets
         plus `business_profile` — the canonical NAP (brand, website, contact email,
         per-office address/phone/place-id from config/locations.js) the worker MUST
         copy verbatim on signups; it never invents business details.

POST /api/integrations/backlink-worker/report
       body: { prospect_id, lease_token, outcome: 'placed'|'failed'|'skipped',
               live_url, claimed_anchor, evidence_url, notes, cost }
       → records the CLAIM only: status 'prospect'→'placed' (never straight to 'live').
         The nightly verifier (§4.1) + GSC (§4.2) independently promote to live/indexed.
       Guards: 'placed' REQUIRES live_url (else the row is verifier-invisible and
       unclaimable → 400). lease_token (the claimed_at from /claim) is REQUIRED and the
       update is conditional on it — a late report from a swept/reclaimed lease affects
       0 rows and returns 409 (stale_lease), so it can't clobber another worker's claim.
```

Lease expiry: an hourly sweep returns `claimed_at` older than N hours (default 6) back to
`prospect` (stuck-worker recovery). The lease_token is that `claimed_at` timestamp.

---

## 6. Strategy agent — feed the board (the brain) — **SHIPPED (M2)**

The existing `waves-backlink-strategist` runs audit → gap → discovery → queue → outreach-ideas
→ report. M2 gives it the board as an output target. Two tools added to the `switch` in
`server/services/seo/backlink-strategy-tools.js` and declared in `backlink-strategy-agent-config.js`:

```
create_link_prospects  → batch insert into seo_link_prospects (target_domain/url, target_page,
                         anchor_planned, link_type, priority, domain_rating, notes;
                         source='strategy_agent'). De-dupes on (target_domain, target_page).
list_prospects(status) → read board slice for situational awareness (called FIRST to avoid
                         dupes; finds re-work like "live but not indexed" / "lost → re-pitch").
```

(Tool is plural/batch — `create_link_prospects` — matching the existing `add_targets_to_queue`
convention, so the agent writes many prospects in one call.)

System-prompt addendum (shipped): the agent must `list_prospects` first, then `create_link_prospects`
for the higher-value lanes (editorial / resource / guest_post / HARO / local partnerships), score
priority on dual ROI, and keep using `add_targets_to_queue` for bulk Tier 4–5 directory signups.

---

## 7. API routes (summary)

New, mounted under the existing `admin-backlink-agent-v2.js` router:

| Method | Path                                              | Purpose                         |
|--------|---------------------------------------------------|---------------------------------|
| GET    | `/prospects`                                      | board list (filter status/type) |
| POST   | `/prospects`                                      | manual add                      |
| PATCH  | `/prospects/:id`                                  | edit status/notes/owner         |
| POST   | `/prospects/:id/recheck`                          | force verifier + GSC recheck    |
| GET    | `/prospects/claim`  *(service-token)*             | Hermes lease (§5.3)             |
| POST   | `/prospects/report` *(service-token)*             | Hermes write-back (§5.3)        |

---

## 8. UI — `Link Building` sub-tab

Add a 5th sub-tab to `BacklinksTab` in `client/src/pages/admin/SEOPage.jsx`
(alongside overview/citations/gaps/llm). A funnel board:

- **Smart views (status filters):** `Needs outreach` (prospect/contacted), `In progress`
  (placed), `Live — not indexed` (live + indexing_status≠indexed), `Indexed` (won),
  `Lost — re-pitch`.
- **Columns:** target domain (DR), target page, anchor (planned→actual), type,
  follow/nofollow badge, indexing badge, placement date, owner, live-URL link.
- **Row actions:** recheck, edit status, open evidence screenshot.
- **Header KPIs:** prospects, placed, live, indexed, lost; "indexing rate" = indexed/live.

---

## 9. Guardrails (must ship with v1)

- **Footprint / deliverability (raised by the Gmail decision):** because outreach sends from
  the **primary Waves Gmail** (not an isolated inbox), reputation protection shifts entirely to
  *behavioral* controls — there's no domain to sacrifice. Therefore in v1: outreach stays
  **human-approval-gated** (`status='contacted'` requires a click, not auto-send), hard
  **rate-limit** (e.g. ≤10–15 cold sends/day), personalized one-to-one only (no templated
  blasts), and reuse the existing centralized SMTP gate + send-idempotency guard from the email
  audit work so a loop can't double-send. This is the trade for using the real inbox: keep the
  send valve manual until volume/quality is proven, *then* consider loosening.
- **ToS / CAPTCHA:** scope Hermes to editorial / HARO / resource / whitelisted directories.
  No blast signups. The existing worker already aborts on CAPTCHA — preserve that.
- **Memory drift:** every Hermes run reconciles to Postgres. The board, not Hermes, is
  canonical; Hermes self-reports are claims pending verification.
- **GSC quota:** indexer respects the ~2k/day inspection cap, oldest-checked-first.

---

## 10. Feature gates & env

`server/config/feature-gates.js` (mirror existing `backlinkAgent`):
```
hermesWorker: isProd ? process.env.GATE_HERMES_WORKER === 'true' : true,   // claim/report endpoints
linkProspectOutreach: process.env.GATE_LINK_OUTREACH === 'true',           // auto-send (default OFF)
```
Env: `HERMES_SERVICE_TOKEN` (claim/report auth), `HERMES_BASE_URL` (if portal ever calls out).

---

## 11. Migration off the Playwright signup worker (phased)

1. **Coexist** — Hermes handles *new* signup/outreach prospects; Playwright worker keeps
   running. Both write to the board.
2. **Compare** — track success rate per worker (`owner` + `attempts`) for ~2 weeks.
3. **Cut over** — if Hermes' skill-learning beats the brittle selector worker, retire
   `signup-worker.js`; keep `x-poller` (feeds queue) and `email-verifier`.

---

## 12. Milestones

- **M1 — Board (no Hermes):** migration + routes + UI + manual add + verifier + GSC indexer.
  Delivers the requested tracker immediately, fed by the strategist + manual entry.
- **M2 — Strategist feed:** ✅ SHIPPED — `create_link_prospects` / `list_prospects` tools.
- **M3 — Hermes hands:**
  - **M3a — claim/report contract:** ✅ SHIPPED — `GET/POST /api/integrations/backlink-worker/{claim,report}`
    (service-token auth `hermes-auth.js`, `hermesWorker` gate), `link-prospect-worker.js`
    (FOR UPDATE SKIP LOCKED lease; `report` only moves prospects to `placed` — verifier promotes
    to live), hourly lease-expiry sweep. Env: `HERMES_SERVICE_TOKEN`, `GATE_HERMES_WORKER`,
    `GATE_LINK_OUTREACH`. Outreach lane stays unserved until `linkProspectOutreach` is on.
  - **M3b — approval-gated outreach send** (Gmail OAuth, `contact@wavespestcontrol.com`, rate-limit) — ✅ SHIPPED:
    `link-prospect-outreach.js` — `saveDraft` + `sendOutreach` + `reconcileSendError`, gated by
    `linkProspectOutreach`, trailing-24h rate-limit (`LINK_OUTREACH_DAILY_CAP`, default 12, counted by
    `outreach_attempted_at` so an attempt counts regardless of outcome). Send is idempotent + concurrency-safe:
    cap-check + claim run under a pg advisory lock; the claim stamps a private `outreach_send_token` and returns
    the locked row, so rollback/finalize touch only their own claim and the sent draft is the current one.
    Outreach state machine `none→drafted→sending→sent`, with `send_error` for AMBIGUOUS Gmail failures (may have
    reached Gmail) — never silently requeued: a stuck/ambiguous send is resolved only by the explicit
    `reconcileSendError` (`sent` vs `requeue`). Gmail send via `email/gmail-client` (sender `contact@`), with an
    `isConnected` pre-check so a misconfig fails clean. Worker gains a `drafted` outcome (Hermes hybrid lane:
    research + draft, human approves); `claim()` skips drafted/sending/sent/send_error rows; reports validate the
    recipient + reject reopening a sent/in-flight outreach. New columns
    `outreach_to_email/subject/body/status/send_token/attempted_at`. Admin routes `prospects/outreach/pending`,
    `prospects/:id/outreach/{draft,send,reconcile}` (the auth'd send IS the approval click). 51 unit tests.
    The approval-queue UI in the Link Building board is the immediate follow-up.
  - **M3c — Hermes agent deployment** (Docker, skill that calls claim/report) — signup skill SHIPPED in the
    dashboard; the **outreach auto-draft skill is authored** at `docs/hermes/waves-outreach-drafter-skill.md`
    (claim `?type=outreach` → research → compose one-to-one draft → report `outcome:"drafted"` → lands in the
    M3b approval queue). Deploying it into the Hostinger Skills tab + flipping `GATE_LINK_OUTREACH` are operator steps.
- **M4 — Cutover:** retire Playwright worker per §11.

M1 alone satisfies "Backlink Manager with all the columns." Hermes is M3 — additive, gated,
reversible.

---

## 13. Open decisions

1. ~~**GSC scope**~~ — **RESOLVED 2026-05-30: URL Inspection authorized.** GSC indexer (§4.2)
   unblocked; confirm the live client surfaces `urlInspection.index.inspect` (widen scope to
   `.../auth/webmasters` if the readonly client doesn't expose it).
2. ~~**Hermes host**~~ — **RESOLVED: Docker** sandbox backend, own container (§5.1).
3. ~~**Outreach channel**~~ — **RESOLVED: reuse existing Waves Gmail OAuth**, sender
   `contact@wavespestcontrol.com` for now (Adam will switch the sending identity later) (§5.1).
   Mitigation for using the primary inbox is mandatory, not optional (§9): approval-gated send +
   rate-limit + existing SMTP idempotency guard. **N/A for M1** — outreach is M3.
4. ~~**Auto-promote vs. manual**~~ — **RESOLVED: fully automatic.** The verifier promotes
   `placed → live → indexed` for all link types with no human glance (it only *reads* live
   reality via crawl/DataForSEO/GSC — promotion is an observation, not an outbound action, so
   it's low-risk to automate). Note this is separate from the outreach **send** valve in §9,
   which stays manually gated.

---

## 14. Target taxonomy & seed lists

**Driving principle — dual ROI.** For local home-services the best link targets are also
referral/revenue partners. Score `priority` on *link value × lead value*, not DR alone: a
realtor "preferred vendors" page (link **+** WDO closings) outranks a DR-50 generic directory.

**First-cycle focus = the WDO / real-estate lane (Tier 1).** Single highest-leverage angle:
WDO inspections are transaction-critical for FL home sales, so realtors *need* a vendor and
link naturally from resource pages. Point discovery + outreach here before spreading across
all five tiers.

### `link_type` enum (board)
`editorial | resource | guest_post | haro | directory | citation | social`

### Tiers (priority order)

**Tier 1 — Local business partnerships** · `resource`/`editorial` · dofollow · **human-led**
(Hermes finds + drafts, human closes) · *highest dual-ROI*
- Real estate agents & brokerages — "resources / preferred vendor" pages; WDO wedge; "moving
  to SWFL / new homeowner" guides
- Property management & HOA management companies — recurring contracts + vendor pages
- Home inspectors — mutual referral (non-competing)
- Complementary home services (non-competing): landscapers w/o pest, pool, pressure washing,
  gutter/irrigation, handyman — "trusted partners" cross-links

**Tier 2 — Local media & digital PR** · `editorial`/`haro` · **hybrid** (Hermes drafts, human
sends) · high authority
- Outlets: Bradenton Herald, Sarasota Herald-Tribune, Sarasota Magazine, SRQ Magazine,
  Venice Gondolier, North Port Sun / Charlotte Sun, LWR Life; TV: WWSB ABC7
- HARO / Qwoted / Featured — pest-expert quotes
- Seasonal hooks: termite swarm (spring), lovebugs, mosquito + hurricane/post-storm surge,
  no-see-ums, palmetto bugs, fall rodents
- **Linkable asset:** the Pest Pressure engine = citable local pest-activity data (earned-media bait)

**Tier 3 — Civic / community / sponsorship** · `citation`/`directory` · **approval-gated**
(`linkProspectOutreach`, costs money)
- Chambers: Manatee, Greater Sarasota, Venice Area, North Port Area, Lakewood Ranch Business
  Alliance (dofollow membership links)
- Youth sports / Little League sponsorships, charity/nonprofit donor pages (humane society,
  food bank), festivals/farmers markets, BNI groups

**Tier 4 — Industry / authoritative** · `directory`/`citation` · stable, high authority
- NPMA, FPMA (Florida Pest Management Association) member directories
- UF/IFAS Manatee/Sarasota County Extension (contribute as local pro)
- FDACS license verification, BBB accredited profile

**Tier 5 — Citation/directory baseline** · `directory`/`citation` · **Hermes/auto-signup lane**
- Yelp, Apple/Bing Maps, Angi, Thumbtack, Houzz, Nextdoor, Porch — NAP consistency (already
  partially covered by the citation auditor)

### Lane → worker → gate
| Lane                              | Worker                         | Gate                        |
|-----------------------------------|--------------------------------|-----------------------------|
| Tier 1 partnerships, Tier 3 sponsor | Human-led (Hermes finds/drafts) | outreach approval ON        |
| Tier 2 media / HARO               | Hybrid (Hermes drafts, human sends) | outreach approval ON     |
| Tier 4–5 directories              | Hermes / auto-signup           | `hermesWorker`              |

The strategist's `create_link_prospect` (§6) seeds from these tiers; DataForSEO
domain-intersection (§4.4) auto-fills Tier 1/4/5 candidates competitors already have.
