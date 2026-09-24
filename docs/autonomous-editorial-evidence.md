# Autonomous editorial evidence

The editorial lane researches, drafts, reviews, repairs, and publishes without
human approval. Failed articles remain unpublished while other work continues.
Existing content safety, privacy, schema, topic, image, and SEO gates still run.

## Boundaries

- Managed writers submit section questions and direct answers through
  `validate_answer_plan` before `emit_draft`. Three unsuccessful plan checks
  exhaust the session's plan budget.
- Draft review checks answer-first sections, independently inventoried claims,
  standalone passages, title fulfillment, and specific, useful writing. Every
  check must complete explicitly; errors are not passes.
- One body repair and a complete re-review are allowed before the existing
  gates. Repair preserves frontmatter, imports, components, image references,
  anchors, and template tokens. Unresolved failures use the runner's existing
  feedback-informed retry/skip mechanism, never an approval request.
- The publisher independently reviews the final serialized article after image
  and metadata transformations, then commits its signed evidence atomically
  with the article. The PR merge paths verify the exact immutable head.
- New or changed Astro blog files require matching evidence in `publish:post`,
  CI, and builds when enabled. The pinned initial baseline exempts existing
  article bytes only; edits remove that exemption. Service/city collection
  expansion is not enabled by this first rollout.

## Evidence and sources

The shared contract in `packages/editorial-evidence/index.cjs` is maintained
upstream in the Astro repository and copied byte-for-byte here. It binds the
full document, path, hub domain, policy version, reviewer model, timestamp,
all five checks, and source excerpts with SHA-256 hashes using Ed25519.
When changing the contract, update Astro first and copy it here in the same
coordinated change; run both repositories' contract tests.

The reviewer retrieves cited URLs and explicitly supplied source URLs through
the existing DNS-pinned, redirect-checking public-web fetcher. It saves bounded
text excerpts, publisher identity, URL, and retrieval time. The model must
identify supporting passages and independently inventory omitted claims.
Quantitative claims, quotations, and named examples require suitable primary
or authoritative evidence. Exact quote inclusion, source hashes, response
coverage, and result shapes are validated in code. Semantic truth and source
suitability remain model judgments, not a guarantee of correctness.

Purely instructional drafts with no externally verifiable claims may have an
empty source list; external claims still require retained supporting evidence.
No sources are fabricated to meet a quota.

Source retrieval is bounded to eight URLs, 20,000 characters per source, and
100,000 total characters. HTML/text sources are supported; inaccessible,
unsupported, or incomplete evidence cannot pass by assumption. A writer can
research an accessible primary source, narrow/remove the claim, or skip the
article. No numerical-claim quota is imposed.

## Autonomous PR handling

The trusted Astro `pull_request_target` workflow executes **portal main** code,
never scripts from the article PR. It reads PR articles as data. Hand-authored
articles may receive a bounded body repair followed by the existing publishing
validators. Portal-owned `content/` branches retain their existing remediation
and database-mirroring authority; the workflow only regenerates their evidence.

The CLI retries source/provider failures or head races three times with 15/30
second backoff, then reports the article as deferred and leaves it unpublished.
No approval message is sent. New article revisions trigger new checks.
Scheduled checks retry missing, invalid, or expired evidence twice hourly. A
rotating three-PR work window prevents persistently failing articles from
starving other PRs. Every evidence push requires a fresh build/review of the
resulting head.

Seven-day freshness applies at publishing and PR validation. Already-published,
unchanged signed files do not expire during unrelated builds. Exact document
edits always require new evidence. Signing-key failures fail closed.

## Activation

The implementation ships dark. Configuration is a deployment prerequisite,
not an article approval step:

1. Deploy matching contract and publisher code to the portal and Astro.
2. Sync the existing managed writer/refresh agent IDs with version-checked
   `POST /v1/agents/{id}` updates of their complete `system` and `tools`
   configurations, so `validate_answer_plan` is available in new sessions.
3. Generate an Ed25519 key pair. Store `EDITORIAL_REVIEW_PRIVATE_KEY` only in
   the portal and trusted CI reviewer environment; provide
   `EDITORIAL_REVIEW_PUBLIC_KEY` to both repositories/builds.
4. Configure the Astro workflow secrets documented in its
   `docs/editorial-evidence.md`, including a bot token whose pushes trigger CI.
5. Run `node server/scripts/eval-editorial-review.js > editorial-calibration.json`
   with model credentials in the isolated evaluator environment. The seed corpus
   must satisfy every labeled expectation; errors fail calibration. Enable
   `GATE_EDITORIAL_EVIDENCE=true` in the portal, Astro build environment, and
   Astro repository variable together after automated checks pass.

The existing `GATE_FACTCHECK=false` setting cannot waive the mandatory factual
review while this gate is active. Model unavailability is retryable; it never
counts as factual approval. Setting `GATE_EDITORIAL_EVIDENCE=false` is the
explicit rollback to the prior publishing behavior.

## Verification

Run the new editorial review, evidence, answer-plan, and PR workflow Jest suites,
plus the existing runner, publisher, scheduler, dispatcher, GitHub-client, and
PR-poller regression suites. Astro additionally has
`npm run test:editorial-evidence`, an enabled baseline scan, `publish:post`, and
the full build. These tests mock providers and do not assert production model
accuracy or infrastructure activation.
