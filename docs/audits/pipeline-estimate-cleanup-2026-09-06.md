# Pipeline and estimate workflow evidence

Local implementation in `codex/pipeline-estimate-cleanup-20260906`, based on locally available `origin/main` at `8c72d111aa6954b779108f87620479ce65e40a7c`. Code commits: `b620359c3` (server protections), `47f3f8ed9` (UI and shared conversations), and `3bdfb7406` (group delivery-option guard). The final code revision is `3bdfb7406`; this report is a separate documentation commit. That original checkpoint included no fetch, push, PR, merge, deployment, or production verification. The release-validation follow-up below supersedes its completion status.

## Scope and isolation

The original checkout and the active Customer 360 worktree were inspected and left untouched. Customer 360 owns its global unread hook, shell badge and conversation component. The canonical shell is `AdminLayoutV2`; the canonical sales route is `/admin/pipeline`, with existing redirects retained. No reference screenshots were attached to the brief in this session; repository design specifications and the actual rendered baseline guide the changes.

The preview uses the real Vite client and Express server, a dedicated local synthetic PostgreSQL database, and `scripts/qa/server.js` transport/network isolation. The schema was copied without data from an existing local QA database. No migration was run. Seeded records use synthetic contacts; no production credentials, customer data, live provider credentials, external messages or payment operations are used. This verifies local schema behavior only, not deployed schema or production pricing overrides.

Chrome DevTools MCP runs with a separate browser profile and external DNS blocked. The installed cached MCP package was reused; no global tooling was installed. Device checks are Chrome emulation, not physical iOS Safari/PWA verification.

## Directory review

Inventory means ownership/dependency review, not exhaustive file-by-file auditing. Route/import searches and relevant files were read; generated output, dependencies and binary assets are excluded.

| Directory | Finding / supporting paths | Implementation scope |
| --- | --- | --- |
| `client/src` | `App.jsx`, `AdminLayoutV2`, `EstimatesPageV2`, `LeadsTabs`, `EstimateToolViewV2`, `EstimateViewPage`, UI primitives and estimate libraries/tests | Primary sales workflow and preview parity |
| `server/routes` | `admin-leads`, `admin-estimates`, `property-lookup-v2`, `estimate-public`, `admin-customers`, `admin-pipeline` | Existing authenticated API and public renderer contracts |
| `server/services` | `admin-estimate-persistence`, `lead-estimate-link`, `customer-properties`, `estimate-property-linkage`, pricing engine, send/acceptance services | Draft identity, concurrency and canonical state ownership |
| `server/config`, schemas and migrations | Feature gates, model configuration, historical estimate/property schema, extraction schemas | Read for contracts; no schema/rate/model changes |
| `server` jobs/integrations/tests | Promised-estimate watcher, scheduled sender, conversion/idempotency tests, pricing golden suites | Preserve event and transport semantics; focused regression coverage |
| `packages` | `lawn-cost-floor`, `report-redaction`, `irrigation-runtime`, `blog-schema` | Shared authority/security consumers; no changes |
| `shared` | Shared sources contain no Pipeline/estimate owner | Outside implementation scope |
| `scripts` | `scripts/dev`, `scripts/qa`, estimate audit tools, build/domain/brand gates | Existing local runtime and verification mechanisms |
| `ops` | `ops/agents/pricing-funnel-report.js`, agent conventions and backfill scripts | Read-only ownership review; no operations/backfills run |
| `docs`, `wiki` | Admin design specs, public-route contracts, multi-property model, estimator field requirements, service dispatch/routing rules | Evidence and requirements; this audit is the only documentation addition planned |
| `ios` | Native sources have no Pipeline editor owner; operational estimate API exceptions retained | No native changes |
| `assets`, `video` | Binary/marketing assets; `video/render.mjs` has no sales-state ownership | Outside implementation scope |

## Action map

| Existing action | Location / resulting behavior |
| --- | --- |
| New lead | Compact Pipeline header; short contact/source/interest form, optional property intake |
| Create estimate | Separate header action; editor workflow, not a selected application destination |
| Search, stage, source/date scope, sort, list/board | One queue toolbar; query-backed state; mobile filters disclosed on demand |
| Stage change | Native select in list and board; keyboard alternative to dragging |
| Queue metrics | Existing Analytics destination; counts retain their original basis |
| Open lead / related estimate / follow-up | Existing expanded lead detail reused |
| Save draft / save changes | Explicit editor action; persisted identity survives further edits |
| Preview | Canonical persisted customer renderer, with section edit links and consequential actions disabled |
| Send/resend | One `EstimateSendDialog`: saved recipient, explicit channel, reviewed message, deliberate confirmation, and individual provider outcomes |
| Message contact | Shared Customer 360 conversation panel; editor stays mounted and keeps unsaved work |

## Service-input/source map

All dollars remain owned by `generateEstimate`, reached through `property-lookup-v2` and server-authoritative persistence. React proposes service inputs only. Unknown measurements stay distinct from confirmed zero; existing review and eligibility gates remain the authority.

| Family | Input meaning / canonical consumer |
| --- | --- |
| General pest | Home/unit dimensions, stories, recurring cadence vs one-time scope, supported roach exceptions → residential/commercial pest pricers |
| Mosquito | Lot less footprint/hardscape, program and station/dunk options; separate one-time path → mosquito adapter; treated lawn is not a substitute |
| Lawn | Confirmed treated turf, grass, actual applications/program, one-time treatment and supported modifiers → turf calculator/lawn pricer |
| Tree/shrub | Bed area and provenance, non-palm tree count, distinct property palm count, program and access → tree/shrub input translator/pricer |
| Palm treatment | Treatment count, type, size, applications/interval, diagnosis/product/DBH and authorization gates → palm injection pricer |
| Termite bait | Footprint/perimeter, system, ownership and approved terms; station count derived server-side → termite bait pricer |
| Trench/Bora-Care/pre-slab/foam | Linear feet, concrete/dirt/depth, product/label confirmation; wood area or surface length/height; slab area; drill points/cadence → specialized pricers and existing project/document handoffs |
| Rodent | Bait, trapping, retainer, wire mesh/exclusion, bird boxes, sanitation and guarantee eligibility remain separate → existing rodent pricers |
| WDO | Inspection/document scope → conservative document workflow; no AI narrative |
| Bed bugs/flea/roach/stinging | Supported scope, quantities, risk and review/manual-quote cases → specialty pricers; stinging scope fields now reach the existing engine options |
| Lawn specialties | Plugging area/spacing, topdress area, measured thatch/debris/access and approvals → specialty pricers |
| Commercial/multi-unit | Unit count/size, payer/property identity, risk and actual cadence; unsupported cases retain manual proposal/review → commercial pricers/proposal editor |

## Lifecycle and identity

| Record/event | Authoritative owner and protection |
| --- | --- |
| Lead | `admin-leads` and `lead-estimate-link`; canonical stages and source attribution |
| Customer/property | Separate customer and `customer_properties` IDs; an estimate address is its own snapshot, not permission to edit an account |
| Draft | `createOrReuseAdminEstimate`; a stable client draft UUID reuses a committed create after a lost response; no send on save; server recomputes money |
| Revision | `reviseAdminEstimate`; row-content witness refuses stale saves. Current policy updates the same ID/token in place. Sent/viewed saves publish on the existing link; accepted/checkout/send/proposal locks remain enforced |
| Preview | Persisted customer renderer; staff preview creates no customer engagement and disables booking, payment, service-selection writes, and live slot searches |
| Send | Existing claims plus persisted attempt receipts, reviewed offer/group versions and template hashes. Provider acceptance is not delivery; suppression is not send fulfillment |
| Group delivery options | Existing group-then-row lock and revision guard now also protect `billByInvoice` and `showOneTimeOption` PATCHes during another member's handoff, including an accepted anchor retaining a live claim |
| Owed estimate | Promised-estimate watcher and real delivery witness; a button click must not clear it |
| Acceptance/conversion | Existing conditional acceptance/conversion writers; customer/service/property reuse and retry protection |
| Invoice/payment/appointment | Distinct identities and downstream confirmed events; acceptance is not payment or scheduling |

## Removal ledger

| Path/symbol | Evidence and surviving protection |
| --- | --- |
| `EstimateToolViewV2.livePreview` unused approximate dollar arithmetic | Only selection counts and bundle posture are consumed by JSX; removed dollar fields had no consumers. Canonical generate/save engine remains; frozen pricing baselines retained |
| `EstimateToolViewV2.CustomerEstimatePreviewV2` and its preview-only pricing/cadence/fee helpers | Removed the parallel customer document and its presentation mode. Preview now opens `EstimateViewPage` with persisted data; existing customer renderer tests plus staff-preview interaction tests retain parity and mutation protections |
| `EstimateToolViewV2.doSend`, `saveAndSend`, send-time/recipient presentation controls; list/lead immediate-send handlers | Replaced by the shared `EstimateSendProvider`/`EstimateSendDialog`. Callers keep their existing refresh paths. Confirmation, failure/retry and reviewed-send tests protect the surviving route |
| `LeadsTabs` queue metric presentation | Relocated, not deleted: same metrics in Analytics; queue retains data-backed counts and follow-up context |
| `LeadsTabs` duplicated board pager/filter behavior | Shared filtered dataset and pager now serve both views; tests cover viewed-stage inclusion and page bounds |
| `LeadsTabs` bespoke button wrapper and competing board-stage list | Existing UI `Button` and canonical stages serve both views; queue and stage API tests protect the replacement |
| Retained V1 named-export modules | Kept; utility imports remain active. Unrouted `UnifiedPipelineView` kept because search alone does not establish safe deletion |

No historical migration, retained V1 module, pricing baseline, or whole source file was deleted. Changes to `client-estimate-engine-pricing-drift.test.js` remove checks for the superseded approximate preview, while retaining the engine payload/pricing protections. The two large editor/queue files together lost 2,073 net lines; tests and shared protections account for additions elsewhere.

## Verified defects and pricing evidence

- Draft retries could create another record after a lost response; the original UUID now reuses the saved identity. Subsequent edits issue a revision against that identity.
- Contact/property changes could retain measurements from another address, and late enrichment could overwrite manual values. Property/request identity checks and field provenance now prevent these cases. Reopening a draft also no longer blocks adding another property.
- A confirmed tree/shrub bed measurement was stamped as inferred. The translator now preserves `bedAreaSource: manual`; the existing engine decides its consequences. This is an intentional input-provenance correction, not a rate change.
- The former send interfaces could act on an unreviewed recipient/revision or conflate suppression, scheduling and delivery. A single confirmation now pins the saved offer and message, and durable receipts preserve outcomes across retries. Reviewed scheduled failures stop for staff review instead of silently detaching from their original review.
- Staff preview still allowed live scheduling searches. The renderer/slot picker now disable them; preview interactions produced no POST, PUT or DELETE requests in the recorded browser checks.
- At 768px the desktop lead table squeezed names and stages; it now uses readable rows at tablet widths. Phone editor fields use one column. Duplicate-match navigation now uses the canonical lead query and can open records beyond the first queue page.
- Independent review identified an existing gap in delivery-option PATCHes on a published sibling during a group send. The original real API returned 200 and changed both options while the anchor was `sending`. The fix returns 409 without altering the sibling, serializes against the existing PostgreSQL advisory lock, and permits editing after the handoff.

`server/services/pricing-engine/` is unchanged from the baseline. No approved prices, discount values, terms, deposit settings, billing rules or pricing fixtures were edited. Frozen pricing, V1 adapter, golden-case, mosquito, termite and palm suites passed without regenerating expectations. These establish equality for unchanged normalized inputs under the test configuration; they do not verify production DB overrides. Confirmed manual bed-area provenance is the explicit input-mapping exception above.

## Verification ledger

Commands used Node 20 via `PATH=/opt/homebrew/opt/node@20/bin:$PATH`. Jest ran in an empty inherited environment with `WAVES_LOCAL_DEV=1 LOCAL=1 NODE_ENV=test`; external providers were mocked. Local logs are in `.tmp/qa/pipeline-estimate/` and are not committed. Results below overlap; counts must not be added as unique coverage.

| Check / command | Result and evidence |
| --- | --- |
| Baseline focused Jest and Vitest runs | 10 server suites / 1,200 tests; 4 client files / 13 tests passed; no golden outputs regenerated |
| `jest --runInBand` pricing/revision/send/conversion selection | 22 suites / 1,729 tests passed (`final-server.log`), including `pricing-audit-golden-cases`, `pricing-engine.regression`, `pricing-engine-v1-adapter.regression`, `estimator-pricing-correctness`, `estimate-server-authoritative-pricing`, `admin-estimate-persistence`, `admin-estimate-revise`, `admin-estimates-reviewed-send`, `scheduled-estimate-reprice-hold`, public atomic acceptance, manual acceptance, addon-plan acceptance, conversion guard and lead linkage |
| Additional lead and communication Jest selections | 6 suites / 99 tests and 2 suites / 78 tests passed (`final-leads-server.log`, `final-communications-server.log`) |
| `npm --workspace client test -- <focused files> --maxWorkers=1 --minWorkers=1` | 18 files / 77 tests passed (`final-client.log`): queue, editor property/draft lifecycle, customer preview, send dialog, shared conversations, shell badge and slot picker. Later affected-file reruns passed: 20 lifecycle tests, 17 layout tests and 5 queue tests |
| `node --test scripts/qa/tests/*.test.js` | 25 passed, zero failures (`final-qa.log`) |
| `npm run build` | Passed; prebuild blog-schema, affiliate-registry, portal-brand and domain-rule gates passed (`final-build.log`) |
| ESLint on all changed JS/JSX | Exit 0, **204 warnings**, zero errors (`final-lint.log`). Complexity, nesting and unused-variable warnings remain; this is not a warning-free result |
| Real API journey: `node .tmp/qa/pipeline-estimate/final-api.cjs` | Passed (`final-api.log`): same-ID create retry, stale-save 409, correct second-property binding, unchanged customer/property records, staff-preview no state change, successful-send replay without new transport/activity, canonical `estimate_sent` lead state, four technician-route refusals |
| Queue/conversation fixture: `node .tmp/qa/pipeline-estimate/browsing-proof.cjs` | 64 total leads, 37 open and 14 on page two reconciled with actual records; off-page contact match resolved. Browser reading of a synthetic inbound message cleared the shared unread badge |
| Final group fix: `jest --runInBand server/tests/admin-estimates-reviewed-send.test.js server/tests/admin-estimate-revise.test.js server/tests/estimate-status-guards.test.js server/tests/admin-estimates-delivery-options.test.js` | 4 suites / 159 tests passed on the final fix (`resumed-group-guard-tests.log`); four regression cases added |
| `node .tmp/qa/pipeline-estimate/group-option-proof.cjs` | Real Express/PostgreSQL proof passed: both flags blocked with 409 and unchanged rows; accepted anchor with fresh delivery claim blocked; finished group editable; concurrent PATCH waited on the canonical lock and refused after sender claim. No transports; both temporary rows deleted (`group-option-proof.log`). `--baseline` was run only against the earlier API and reproduced both incorrect 200 responses |
| Final fix ESLint / `npm run check:domain-rules` / `git diff --check` | Passed; route lint retains 45 warnings, zero errors (`resumed-group-guard-lint.log`, `resumed-domain-rules.log`) |
| Document checks: `jest --runInBand server/tests/estimate-pdf-structured-sections.test.js server/tests/admin-estimates-email-template.test.js server/tests/email-template-reviewed-content.test.js` | 3 suites / 25 tests passed (`resumed-document-tests.log`); includes PDF structured sections and reviewed email parity |
| `node .tmp/qa/pipeline-estimate/render-documents.cjs` | Rendered synthetic SMTP HTML with the exact `estimateSmtpContent` source and canonical `wrapEmail`, plus the canonical PDF fallback using the existing structured fixture. No DB reads or provider calls. Browser HTML screenshots and PDF first-page image inspected |
| Independent review | Reviewed the original code commits and then the group-guard fix separately. No unresolved P0/P1 findings. The identified PATCH gap was fixed and re-reviewed without findings |

The final server-only guard does not change rendered output or pricing math; prior client/build/pricing results were reused. No separate type-check script is defined. Live-provider contract suites and production migrations were not run.

## Browser evidence and limits

The real Vite/Express workflow was exercised through Chrome DevTools: new lead, save/reopen/edit, saved customer preview, explicit stubbed send, lead state/activity, contact match, conversation draft/read behavior, filters/list/board/pagination and navigation. The test send reported **provider accepted; delivery not confirmed**, with a local transport capture only. Acceptance/conversion retries are covered by focused server suites; no real customer booking/payment was exercised.

Pipeline, lead detail, editor, customer preview and send-dialog screenshots were inspected at 360, 390, 430, 768 and 1440px. Each tested document fit the viewport. Editable customer fields were 16px; send confirmation remained reachable within the dialog scroll. Resumed checks reconfirmed Pipeline, draft hydration, confirmation-before-send and 390/1440px layout from the final UI commit.

| Surface | Before / after local artifacts |
| --- | --- |
| Pipeline | `/tmp/waves-pipeline-before-{390,1440}.png` → `/tmp/waves-pipeline-final-{360,390,430,768,1440}.png`; reconfirmed `/tmp/waves-pipeline-resumed-{390,1440}.png` |
| Lead detail | `/tmp/waves-lead-detail-final-{360,390,430,768,1440}.png` |
| Editor | `/tmp/waves-editor-before-390.png` → `/tmp/waves-editor-final-{360,390,430,768,1440}.png`; reconfirmed `/tmp/waves-editor-resumed-{390,1440}.png` |
| Services / conversation | `/tmp/waves-editor-services-final-390.png`, `/tmp/waves-messages-final-390.png`, `/tmp/waves-messages-keyboard-390.png` |
| Send / customer preview | `/tmp/waves-send-final-{360,390,430,768,1440}.png`, `/tmp/waves-customer-preview-final-{360,390,430,768,1440}.png`; send reconfirmed `/tmp/waves-send-resumed-390.png` |
| Email / proposal PDF | `/tmp/waves-estimate-email-resumed-{390,1440}.png`, `/tmp/waves-estimate-proposal-resumed.pdf`, `/tmp/waves-estimate-proposal-resumed.pdf.png` |

Braces denote separate existing files, not a single filename. Baselines belong to `8c72d111a`; final and resumed UI images belong to `47f3f8ed9` (unchanged in `3bdfb7406`). Images contain synthetic fixtures and remain local, outside Git.

The synthetic SMTP email fit 390/1440px without document overflow. Its unchanged repository images were embedded only in the local HTML artifact to accommodate blocked external DNS. The PDF fallback's first page showed property scope, corrective work, responsibilities, cadence, totals and authored terms without clipping. These are local renderer checks; no email was delivered, and no hosted document renderer was called.

Remaining limits:

- Local schema was restored without production data; no migration or production override verification. The resumed editor logs expected 404s for six absent synthetic pricing-config rows (`lawn_pricing_v2`, `onetime_flea`, `rodent_bait_brackets`, `rodent_setup_fee`, `rodent_waveguard`, `termite_rental`). Its saved draft, property and send-preview requests succeeded. These fixture gaps are not a clean-console claim.
- Input visibility/payload coverage combines code tracing, focused tests and representative browser journeys; every service family was not separately sent through a browser. Automated tests, rather than a live provider, establish reviewed email-template parity. Gmail/Outlook rendering, live SendGrid template versions and the hosted commercial-proposal document/PDF path were not exercised.
- Chrome emulation is not physical iOS Safari/PWA or native keyboard verification. The evidence does not prove device safe-area behavior.
- Structural warnings include changed functions (`EstimateSendDialog`, editor save/review, route send/PATCH) as well as untouched legacy code. Broader complexity cleanup is deferred; checks passed with warnings.
- The reused unread badge counts endpoint-scoped DB conversations, while the Communications inbox groups by contact phone. One contact messaging two Waves numbers can therefore count as two conversations but appear in one inbox thread. This existing semantic difference was retained.

## Live preview

Worktree: `/Users/wavespestcontrol/wt-pipeline-estimate-cleanup`.

- Pipeline: `http://127.0.0.1:19793/admin/pipeline`
- Create estimate: `http://127.0.0.1:19793/admin/pipeline?tab=new`
- Saved multi-property draft: `http://127.0.0.1:19793/admin/pipeline?editEstimateId=5d640f8a-ef3c-4e04-8dab-7c2eff5a35da`
- Sent journey: `http://127.0.0.1:19793/admin/pipeline?editEstimateId=ab5acae2-e662-4a45-9b34-a571fc082e88`
- API health: `http://127.0.0.1:19792/api/health`

At final verification Vite PID was `61495`, QA API PID `61535`; each process was checked against this worktree. The current API PID is also in `.tmp/qa/pipeline-estimate/api.pid`. The dedicated browser profile retains the synthetic admin login. For a separate browser, the local ignored fixture file holds `adminEmail` and `password`; credentials and secure customer tokens are omitted from this report.

From the worktree, use Node 20:

```sh
export PATH=/opt/homebrew/opt/node@20/bin:$PATH
npm run worktree:status
```

To stop Vite, `npm run worktree:stop`. Stop the QA API with Ctrl-C in its terminal, or run the guarded local command below from the worktree. It verifies both the executable and working directory before signaling the recorded PID:

```sh
python3 - <<'PY'
from pathlib import Path
import os, signal, subprocess
pid = int(Path('.tmp/qa/pipeline-estimate/api.pid').read_text())
assert 'scripts/qa/server.js' in subprocess.check_output(['ps', '-p', str(pid), '-o', 'command='], text=True)
assert 'n' + str(Path.cwd()) in subprocess.check_output(['lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'], text=True).splitlines()
os.kill(pid, signal.SIGTERM)
PY
```

For a restart, stop both task-owned processes first: the managed frontend doctor requires the reserved API port to be free. Start Vite first, then the QA API in a second terminal, preserving the existing isolated fixture/configuration:

```sh
# Terminal 1, worktree root
PATH=/opt/homebrew/opt/node@20/bin:$PATH npm run dev:managed-client

# Terminal 2, worktree root
PATH=/opt/homebrew/opt/node@20/bin:$PATH node .tmp/qa/pipeline-estimate/start-api.cjs
```

The API command uses the existing QA transport/network blockers; a normal backend startup is not a substitute. Both preview servers were left running. Their lifetime depends on the host/session; no persistence beyond this environment is promised.

## Release-validation follow-up

The owner authorized continuation through validation and PR preparation. The existing clean worktree was resumed at `2a3a30b60`. Current `origin/main` (`f9f6f3dc9`) was fetched and merged without conflicts in `f59fe5941`. A subsequent main update (`38254ecb9`) changes only social-content implementation/tests; it is included for PR compatibility without changing the checked estimate surfaces. No production access, migrations, live provider calls, or customer communications were performed.

### Additional implementation and verification

- Added safe-area padding to `EstimateSendDialog` and constrained its scrollable document to the available overlay height. Both collapsed and expanded message previews were exercised at 1440×900 and 390×900. There was no horizontal overflow; the expanded dialog stayed within 12px viewport margins and its confirmation action could be scrolled into view. Physical Safari/PWA behavior is still unverified.
- Filled all six previously missing **local synthetic** `pricing_config` rows from the checked-out engine defaults. Inserts ignored existing keys and were restricted to the worktree-owned loopback QA database; the six rows were read back. No production rate, engine constant, or committed pricing fixture changed.
- Re-ran six affected server suites after the main merge: **205 tests passed**, including revision, reviewed-send, group delivery-option, latest tier-selection and conversion protections. Seven affected client files passed **36 tests**. `npm run build` passed, including brand/domain/vendor gates; changed-dialog ESLint passed with its existing complexity warning and no errors. `git diff --check` passed.
- Re-ran the real Express/PostgreSQL journey after the merge and fixture completion: create retry retained the same ID, stale save returned 409, the second property retained its identity, customer/property records were unchanged, staff preview did not change engagement state, the sent-attempt replay produced no additional transport/activity, and four technician access checks returned 403.
- Browser coverage now includes all 27 listed service options, followed by measured-input cases and the commercial path. Every listed option plus a commercial office estimate reached a completed intercepted send after its synthetic measurements/eligibility confirmations were supplied. Dethatching was tested both without approval (held) and with a synthetic verified-thatch-probe approval (sent). Missing turf/bed/palm measurements and missing approvals were exercised separately from valid synthetic inputs. The completed runs produced no HTTP errors from pricing configuration or estimate APIs. All message transport was intercepted by the existing QA server; provider acceptance wording is a simulated outcome, not evidence of delivery.
- New screenshots were visually inspected: `/tmp/waves-pipeline-release-{1440,390}.png`, `/tmp/waves-send-release-{1440,390}.png`, and `/tmp/waves-send-expanded-release-390.png`. Pipeline names, native stage controls, toolbar and phone rows remain readable; the send dialog uses the admin monochrome palette and its actions remain reachable.

Local evidence: `.tmp/qa/pipeline-estimate/release-{server,client,build,api,lint}.log`, `service-browser-results.json`, `service-browser-measured-results.json`, `service-browser-final-cases.json`, and `service-browser-dethatch.json`. These contain synthetic fixtures and are intentionally excluded from Git. Repeated browser runs reached the login limiter; the final small follow-up used a short-lived fixture JWT signed with the existing local QA secret. Earlier browser and API journeys exercised real password login. No production authentication controls were changed.

### Customer360 integration

The separate `wt-customer360` checkout still contains uncommitted owner work and was not modified. Its `activity.js`, `useUnreadConversations.js` and `inbound-sms-read.js` match this lane byte-for-byte. The remaining shared differences were traced:

- This lane extends `CustomerSmsPanel` with phone-scoped lead conversations, the provider wrapper, explicit transport outcomes, and 16px input text. Customer360's customer-based call shape remains supported.
- This lane wraps the admin layout with the conversation/send providers. Customer360's forthcoming layout edits must retain those wrappers.
- The communications route includes the exact-phone query and the admin-only unread-count guard. Preserve those additions when reconciling Customer360.

This PR can be reviewed independently of the uncommitted Customer360 page work; a later Customer360 integration must merge these shared additions rather than replace the files with its older copies. Native/Astro consumer searches found no callers of the changed admin-estimate/property-lookup routes; no public route contract was widened.

### Deferred P2s and remaining external checks

- `client/src/components/admin/EstimateSendDialog.jsx:39`, `client/src/pages/admin/EstimateToolViewV2.jsx:3823` and `:4095`, and `server/routes/admin-estimates.js:1150` / `:4854`: structural complexity warnings remain. A meaningful reduction requires changing the save/send decision flow; moving branches into one-use helpers would not simplify it. This follow-up preserves the tested protections and records the deferral.
- Other changed shared components/queue functions retain structural and unused-variable warnings listed in `final-lint.log` (204 warnings in the original all-changed-file pass). This is not a warning-free release.
- `server/services/inbound-sms-read.js` / `client/src/hooks/useUnreadConversations.js`: the existing badge counts endpoint-scoped conversations, while the inbox groups by contact phone. A contact using two Waves numbers can therefore show a badge count of two and one inbox thread. Changing that metric is deferred to a coordinated Communications/Customer360 change.
- Physical iPhone Safari/PWA, Gmail/Outlook rendering, live provider template versions and the hosted commercial proposal/PDF renderer remain unverified. The original local SMTP/PDF checks remain applicable; no hosted document was generated during this follow-up.
- The local restored schema is not evidence that current migrations ran in a dev/preview or production environment. CI and final-head automated PR review must complete before this lane is described as merge-ready.

## PR review remediation

PR [#4014](https://github.com/wavespestcontrolfl/waves-customer-portal/pull/4014) passed all seven CI jobs on `d9b530ca7d`. Its first GitHub review found one P1, four P2s and one P3. The P1 and three local P2s are fixed:

- A scheduled deliberate resend persists the keys of the uncertain attempts the operator actually acknowledged. The cron honors those keys, still refuses its own already-started attempt, and refuses any later uncertainty that was not acknowledged. A receipt is also retained when an acknowledgement request has no explicit idempotency key.
- Email dispatch is recorded at the existing template library's `onQueued` boundary (and immediately before SMTP `sendMail`). Missing, disabled or changed reviewed templates now complete a definite failed attempt; a provider timeout still retains an uncertain receipt.
- Messaging refreshes the expanded lead's activity directly without toggling the detail closed.
- Duplicate suggestions combine the existing unconverted and customer-linked contact matchers. Open linked opportunities are included; closed leads remain excluded, and this advisory read never merges or creates records.

Five focused server suites passed **238 tests**; the queue file passed **6 tests**. The isolated real PostgreSQL/API proof confirmed a 409 without acknowledgement, persisted acknowledged keys when scheduled, zero transport from scheduling, and both linked/unlinked open candidates with the closed candidate excluded. Temporary proof rows were removed. Desktop and mobile browser messaging checks confirmed that activity refreshed and the lead stayed expanded; `/tmp/waves-lead-after-message-{1440,390}.png` were visually inspected. Build and brand/domain gates were re-run. Changed-file ESLint retained **74 warnings, zero errors**.

The send-dialog complexity P2 remains listed under Deferred P2s; reducing its decision flow is a separate simplification. The inbox-to-global-badge polling delay is P3 advisory and unchanged. Final-head CI and follow-up review are required for the remediation commit; the earlier green run is not its result. The local pre-push hook skipped the original large diff at its 500 KB cap, so it is not counted as a clean review.

### Integration with current main

The remediation push became conflicting after main gained the property lookup accuracy and admin navigation changes. The merge preserves the shared `PropertyLookupResult`, source/retrieval evidence, per-field verification, refreshed-record requests and edited-home/lot markers. The builder keeps one address invalidation mechanism and extends its existing property reset with `EMPTY_PROPERTY_MEASUREMENTS`; explicit selected-property hydration and same-property manual corrections remain intact. Clear All uses the same reset so edit/provenance flags cannot survive it.

The combined client passed 55 tests across 12 files, including all five incoming lookup accuracy cases and the existing property lifecycle tests. Five server suites passed 259 tests, including reviewed sending and property source/cache accuracy. Desktop (1440px) and mobile (390px) Chromium checks used synthetic county lookup responses over the isolated local API: a 2,600 sq ft manual correction survived refresh, changing the address cleared the old measurements and evidence, and neither viewport overflowed horizontally. The screenshots were visually inspected. Production build and prebuild gates passed. No migrations or external lookup/provider calls were run.

### Second review: lead outreach and contact identity

The review of `58db87e17` identified two P1 regressions and one P2. All three are fixed in the next remediation:

- Pipeline lead messages pass `leadId` into the shared panel and use the existing lead-send route, preserving `sms_sent`, first-response timing and the contacted/funnel update. The route requires the shared real-provider-send predicate before those writes, returns the provider receipt, checks a supplied destination against the current lead phone, and updates only a still-new lead. Its message-only external request remains valid. Audit attribution uses the current staff `name` field.
- Phone-scoped history compares the full normalized digits. Only NANP records also match the same ten digits without their leading 1; international numbers never participate in a suffix match. Phone draft keys retain the country code.
- Both estimate layouts load the existing customer summary before opening a customer-scoped conversation. A historical estimate phone cannot override the live customer phone; failed lookups show an error and do not open the stale destination.

Validation: 78 server tests across the lead-send and communications suites and 19 client tests across the panel, queue and mobile estimate row passed. The real isolated PostgreSQL/API proof confirmed contacted status, first response, one SMS activity and a provider receipt; two same-suffix international/US conversations remained separate in both directions and reading one left the other unread. Temporary proof records were removed. Desktop/mobile Chromium checks retained the open lead and refreshed activity, then opened the live customer phone from a synthetic historical snapshot. Screenshots were visually inspected. Build/prebuild gates passed; changed production files retained 50 lint warnings and no errors. Astro and native source searches found no callers of the affected lead-send/log paths. No migrations or production/provider traffic were run.
