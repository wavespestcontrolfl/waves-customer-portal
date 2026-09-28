# AI citation measurement

The SEO → Authority → Backlinks & Citations → LLM Mentions panel separates brand mentions from attached source links. Its fixed cohort is the 40 exact questions in `server/data/aeo-benchmark-v1.json`, version `swfl-2026-09-v1`. Q1–Q10 preserve the earlier manual benchmark. The companion Astro repository's `content-ops/ai-citation-tracker.md` contains the consumer-interface protocol and destination map.

## Evidence and denominators

Version 2 stores `measurement_version`, `answer_available`, `citations_complete`, and `source_urls` alongside existing answer, model, and citation fields. Only answered observations with resolved citation evidence enter the rates. A fully observed answer without an owned link is a citation miss. Legacy mixed-source rows, no-answer rows, and unresolved attribution remain visible and are excluded.

The current grid takes the latest observation for each question, engine, and reported model within 30 days. The daily benchmark history uses the observations on each date. Custom queries stay outside the fixed benchmark. Always compare equivalent question and engine/model cohorts, with the measured and excluded counts visible.

### Recommended and missing (additive, 2026-09-27)

`recommended` sits next to `mentioned`/`cited` in both the sitewide summary and the fixed-benchmark block: a measured answer counts when Waves is mentioned, the light sentiment pass (`classifySentiment`) scored it `positive`, and `rank_position` — the 1-indexed order Waves' first mention appears among Waves + the hardcoded `COMPETITORS` list in `llm-mention-prober.js`'s `parse()` — is 1, 2, or 3. Same denominator as mentioned/cited (measured answers), so all three rates stay comparable; `recommendedRate` is the numerator/denominator pair the panel renders. This is a proxy for "would this answer actually steer a prospect to Waves", not a claim about a consumer-facing ranked list — no answer engine in this cohort returns an explicit rank.

`missing` sits next to `noAnswer` in the fixed-benchmark block only: expected pairs (active benchmark questions × CONFIGURED engines — the prober's own provider set, passed in by `getDashboard`) that have no observation of any kind in the window. Measured, `noAnswer`, `legacy`, `unresolved` and `missing` therefore partition `expectedObservations`. The engine denominator is never derived from successful rows: `runDaily` skips null probes, so a newly enabled engine, or one failing for the whole window, has no rows and would otherwise shrink the denominator and read as full coverage; a removed engine's leftover rows never offset a configured engine's gap. A rotating daily attempt window (see below) means a healthy, fully-configured cohort still carries some `missing` most days — it is a coverage gauge, not a failure count on its own; watch its trend, not a single day's value.

Both fields are purely additive: every existing field name and denominator (`mentioned`, `cited`, `mentionRate`, `citationRate`, `noAnswer`, `unresolved`, `legacy`) is unchanged.

- OpenAI: `url_citation` annotations. The dedicated `gpt-5-search-api` Chat Completions model replaces the retired 4o search preview, which returned 404 during preflight; `OPENAI_MENTIONS_MODEL` remains configurable. Each reported model stays in its own cohort. [Official web-search response documentation](https://developers.openai.com/api/docs/guides/tools-web-search)
- Gemini: grounding support indexes linking an answer segment to a chunk. Chunk lists alone are source pools. Known Google redirect URLs are resolved without requesting the destination or forwarding credentials. [Google grounding documentation](https://ai.google.dev/gemini-api/docs/google-search)
- Claude: citations attached to answer text blocks. Thinking and refusal blocks are excluded. [Anthropic web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
- Perplexity: answer citation markers select entries from its citation array. Unused entries and `search_results` remain source evidence.
- Google AI Overview: references or links attached to textual overview elements. Top-level references only identify pages that may have been used. [DataForSEO response schema](https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/)

Provider adapters retain their own models and do not fall back across engines: a fallback would contaminate the engine being measured. Reported model identifiers are retained when a response provides them. This is an API observation series, not a claim about personalized consumer interfaces.

## Existing mechanisms

The managed-query API remains authoritative, including an intentionally empty active list. The seed migration inserts missing benchmark questions and preserves existing text, metadata, and active toggles; it audits inserted counts. Rollback preserves query rows and their history.

The existing daily prober and SEO gate remain in use. Provider attempts, including failures, consume the existing configurable run ceiling (200 by default). The stable question/engine list advances by one attempt window each Eastern calendar day, including failed pairs, so failed providers cannot monopolize a small ceiling. Same-day database uniqueness still prevents duplicate observations. No additional scheduler is added.

The backlink overview summarizes the same complete current observation cohort; its 20-row limit applies only to the detail list.

The opportunity miner requires attributable answer days and evaluates absence independently for each engine/model, then combines qualifying evidence into one existing city/service opportunity. A brand mention cannot suppress a citation gap. Publication feedback requires a link to the published page itself; an unrelated owned-domain link cannot mark that page as cited. Legacy feedback is re-evaluated under version 2.

## Entity-accuracy cohort

The citation benchmark asks prospect questions and measures retrieval and linking. The entity cohort in `server/data/aeo-entity-cohort-v1.json`, version `entity-2026-09-v1`, asks the engines about Waves itself: ten owner-approved questions (owner, founder, license and how to verify it, founding year, base and footprint, services, termite bond, franchise status, the longer public name, contact) plus two search-query tests. Each question records its approved answer, supporting source, the facts an answer must state and the claims it must not make.

Scoring is deterministic (`server/services/seo/aeo-entity-facts.js`): regular expressions over the stored answer text, run at insert time and stored in `seo_llm_mentions.entity_facts`. No model call is involved, so a fact check never varies between runs. A score needs an answer; it does not need resolved citations. Facts and claims are both assertions: a match counts only when its clause, bounded by sentence punctuation or a contrastive conjunction, carries no negation before or after it. A denied fact ("was not founded in 2024") earns no credit, a correct denial ("does not cover termite damage", "fumigation is not offered") is never a wrong claim, and "not a franchise, but it offers fumigation" still flags fumigation. The founding-year claim captures the asserted year and counts any value other than 2024. The global forbidden claims apply to every question: a founding year other than 2024, ownership attributed to someone else, a franchise, fumigation offered, or a headquarters outside Southwest Florida. The termite question adds the owner's rulings: no damage-repair coverage, no free re-treatment or blanket guarantee, and no first-year inclusion inferred from the word bond.

The panel shows the facts-right rate, the share of answers carrying a wrong claim, and the most often missing facts and wrong claims, by engine/model and by question. The cohort rows join the managed query list through the same seed pattern as the benchmark (existing text, metadata and toggles preserved; rollback keeps query rows and observations and removes only the score column). They stay out of the fixed citation benchmark, and the opportunity miner ignores them: an identity miss is not a city/service page gap. The daily attempt window is unchanged; adding 12 questions lengthens the rotation cycle rather than the daily spend.

A baseline for this cohort is recorded before the hub identity changes (author `knowsAbout`, blog byline `sameAs`, About page founder node, Sunbiz `sameAs`) ship, so any later movement can be compared against it.

## Verification and release

Focused unit checks: `aeo-citations.test.js`, `aeo-entity-facts.test.js`, `impact-tracker.test.js`, and `gsc-opportunity-miner.test.js`.

`aeo-measurement-db.test.js` runs only when `AEO_TEST_DATABASE_URL` names a dedicated `waves_qa_` database. It creates and removes its own schema, exercises both migration directions and seed preservation, and verifies the miner and impact queries against PostgreSQL. Follow `docs/development.md` to create the verified nonproduction database. Never use production credentials for these checks.

The schema migration must be deployed with the API and panel changes. No customer-facing feature gate is changed. The existing SEO intelligence gate controls probing; the existing AEO gap-mining gate controls publisher input.

The September 7 pre-publication API baseline is recorded in [the summary](aeo-baseline-2026-09-07.json) and [question outcomes](aeo-baseline-2026-09-07.csv): all 40 questions were attempted on four configured engines, producing 160 observations. OpenAI linked an owned URL in 16/40 answers; Claude in 15/40; Gemini in 15/40; and Google AI Overview in 18/36 answered observations, with four no-overview results excluded. These are current presence measurements, not improvement claims. Perplexity was unconfigured.

The run used staging provider credentials with a dedicated QA database in codex-dev; no production database was accessed. The retired OpenAI search default was replaced after a 404 preflight. Original local credentials had failed authentication. Raw answer evidence remains in the task's local evidence bundle; no customer or credential payload is committed.

Consumer-interface observations are recorded separately in the companion tracker. Google Search, ChatGPT and Perplexity access challenges and Copilot regional unavailability must not be counted as citation misses. The signed-out Gemini sample uses its displayed Flash-Lite mode, separately from the Gemini API model.

## 2026-09-27 grid snapshot

[The current admin-dashboard grid](aeo-grid-2026-09-27.csv) — the latest observation per question x engine within 30 days, same columns as the September 7 baseline above — now carries five engines including Perplexity `sonar`: 196 measured (answer-available, citations-complete) of 200 attempted, 105 with an owned link, 30 with the brand named.

This is **not like-for-like** with the September 7 four-engine baseline: Perplexity was unconfigured then and is measured now, so the pooled totals cannot be diffed as before/after movement on the same cohort. A true comparison holds question, engine and model fixed and compares matching rows only. No causal claim is made about anything shipped between the two snapshots — this is a coverage/composition note, not an improvement measurement.

## Owned cited-URL health check

A citation with no live page behind it is worse than no citation — motivating case: `bradentonflpestcontrol.com/pest-control-costs/` was cited 39x/30d while it had gone 301→404, unnoticed. `server/services/seo/owned-url-health.js` runs daily at 3:45am ET (behind `GATE_SEO_INTELLIGENCE`, right after the 3:00am mention probe): it collects the distinct owned URLs cited in `seo_llm_mentions.waves_cited_urls` over the trailing 30 days — attributable V2 answers only, the same `ownedCitations` rule the citation rates use (legacy rows mixed source pools into that column) — fetches each with a SAFE, allowlisted fetcher (hub + the 16 fleet spoke domains only, https, every redirect hop re-validated against that allowlist before it is requested, private/internal IPs blocked on the real socket connection, ~10s timeout, ~1.5MB cap, concurrency ≤3), and classifies the result past the bare HTTP status:

- `ok` / `redirect_ok` — live; `redirect_ok` is specifically a 301/308 chain landing on an ok page
- `soft_404` — a 2xx response rendering a not-found template (title/body markers; the Astro fleet's own `404.astro` renders "Page Not Found" with `robots=noindex,nofollow`), or a 204 / 2xx with no visible text (`detail.reason = empty_body`) — a blank page is never a clean result
- `not_found` / `server_error` — 404/410, or 5xx
- `challenge` — a bot/login/rate-limit interstitial (401/403/429, or a Cloudflare-style challenge page)
- `noindex` — meta robots or `X-Robots-Tag` says noindex
- `canonical_elsewhere` — the page's own `rel=canonical` normalizes to a different URL than where the chain landed
- `fetch_blocked` — timeout/DNS/TLS/size/disallowed-host; **never** reported as `not_found`, so a checker outage never reads as "the page is gone"

Results persist to `seo_owned_url_health` (one row per URL per day; migration `20260928020000_seo_owned_url_health.js`). The dashboard's `citedUrlHealth` block (candidates, checked, unchecked, bad count, the bad URLs with verdict/final URL/citation count/last-checked date; a cited URL with no health row yet is `unchecked` and the panel shows it as not checked, never as clean) renders in the LLM Mentions panel, and a FIX ops-digest item posts (via the same `deliverOpsDigest` seam every other watcher uses, in-app under `GATE_OPS_DIGESTS_IN_APP` or email otherwise) whenever the bad count is above zero, retiring on the next clean run.
