# AI citation measurement

The SEO → Authority → Backlinks & Citations → LLM Mentions panel separates brand mentions from attached source links. Its fixed cohort is the 40 exact questions in `server/data/aeo-benchmark-v1.json`, version `swfl-2026-09-v1`. Q1–Q10 preserve the earlier manual benchmark. The companion Astro repository's `content-ops/ai-citation-tracker.md` contains the consumer-interface protocol and destination map.

## Evidence and denominators

Version 2 stores `measurement_version`, `answer_available`, `citations_complete`, and `source_urls` alongside existing answer, model, and citation fields. Only answered observations with resolved citation evidence enter the rates. A fully observed answer without an owned link is a citation miss. Legacy mixed-source rows, no-answer rows, and unresolved attribution remain visible and are excluded.

The current grid takes the latest observation for each question, engine, and reported model within 30 days. The daily benchmark history uses the observations on each date. Custom queries stay outside the fixed benchmark. Always compare equivalent question and engine/model cohorts, with the measured and excluded counts visible.

- OpenAI: `url_citation` annotations. [Official web-search response documentation](https://developers.openai.com/api/docs/guides/tools-web-search)
- Gemini: grounding support indexes linking an answer segment to a chunk. Chunk lists alone are source pools. Known Google redirect URLs are resolved without requesting the destination or forwarding credentials. [Google grounding documentation](https://ai.google.dev/gemini-api/docs/google-search)
- Claude: citations attached to answer text blocks. Thinking and refusal blocks are excluded. [Anthropic web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
- Perplexity: answer citation markers select entries from its citation array. Unused entries and `search_results` remain source evidence.
- Google AI Overview: references or links attached to textual overview elements. Top-level references only identify pages that may have been used. [DataForSEO response schema](https://docs.dataforseo.com/v3/serp/google/organic/live/advanced/)

Provider adapters retain their own models and do not fall back across engines: a fallback would contaminate the engine being measured. Reported model identifiers are retained when a response provides them. This is an API observation series, not a claim about personalized consumer interfaces.

## Existing mechanisms

The managed-query API remains authoritative, including an intentionally empty active list. The seed migration inserts missing benchmark questions and preserves existing text, metadata, and active toggles; it audits inserted counts. Rollback preserves query rows and their history.

The existing daily prober and SEO gate remain in use. Provider attempts, including failures, consume the existing configurable run ceiling (200 by default). Question/engine pairs rotate by their last observation so a small ceiling does not starve later engines. Same-day database uniqueness still prevents duplicate observations. No additional scheduler is added.

The opportunity miner requires attributable answer days and evaluates absence independently for each engine/model, then combines qualifying evidence into one existing city/service opportunity. A brand mention cannot suppress a citation gap. Publication feedback requires a link to the published page itself; an unrelated owned-domain link cannot mark that page as cited. Legacy feedback is re-evaluated under version 2.

## Verification and release

Focused unit checks: `aeo-citations.test.js`, `impact-tracker.test.js`, and `gsc-opportunity-miner.test.js`.

`aeo-measurement-db.test.js` runs only when `AEO_TEST_DATABASE_URL` names a dedicated `waves_qa_` database. It creates and removes its own schema, exercises both migration directions and seed preservation, and verifies the miner and impact queries against PostgreSQL. Follow `docs/development.md` to create the verified nonproduction database. Never use production credentials for these checks.

The schema migration must be deployed with the API and panel changes. No customer-facing feature gate is changed. The existing SEO intelligence gate controls probing; the existing AEO gap-mining gate controls publisher input.

The September 7 local provider preflight produced no observations: OpenAI and Claude returned authentication errors, Gemini returned HTTP 400, and Perplexity/DataForSEO were unconfigured. A version-2 baseline remains unmeasured until valid provider configuration is available. Record a successful baseline before publishing the companion guides if a pre-publication comparison is required. Never present synthetic UI fixtures or historical mixed-source data as that baseline.
