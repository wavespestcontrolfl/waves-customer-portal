# Waves Admin simplification audit

Review baseline: `32de1dc5ccb5a2f9b6e5969db319df37b96a025d`, fetched `origin/main` on 2026-09-05 ET. This is a source revision, **not a verified deployed revision**. Review branch: `audit/admin-simplification-review-20260905`. No merge, deployment, production query, database migration, provider action, or live agent launch is authorized or performed.

## Findings

1. **Name business work accurately before retiring AI panels.** Customers' “AI Advisor” is a retained operational panel for health signals, retention outreach and upsell dispositions, not a second chat assistant. The Intelligence Bar is already the general assistant, mounted once by the shell. Tax and advertising advisors also have saved reports and action histories that chat does not replace. Keep those workflows, give them specific names, and avoid a second tool registry or conversation store.
2. **Communications has real editor overlap, but its queues are not interchangeable.** Events pairs notification triggers with SMS/email templates. The template library adds custom/unmapped content, email versions, previews and publication. Triage fixes call extraction/routing; Promises records commitments; CSR follow-ups are another record type. Agent Ops already aggregates persisted source records and links to their owners. Move discoverability first; do not create another universal queue or synchronize “resolved” across unrelated records.
3. **Email belongs beside Communications.** Its operational inbox is currently filed under Marketing. Reuse the existing inbox and provider integration. Do not embed it behind a new tab until draft lifecycle and owner-only access are verified: current email drafts are component state, and unmounting can lose them.
4. **Several apparent finance duplicates answer different questions.** Invoice A/R, missing-billing exceptions, payer balances, Stripe settlement, bank reconciliation and tax reconciliation differ in scope. Group Billing and Accounting by task, but keep each source and all financial calculations. The two Operating Costs editors really do write the same settings; their permission/loading/save parity still needs verification before either is removed.
5. **Two small UI consolidations have unusually strong parity evidence.** Settings' Team panel fetches only the signed-in user's name/email/role, already displayed under General. It is not employee administration. Tool Health's integration catalog duplicates Settings' existing `IntegrationHealthSection`; its runtime tool/PDF errors remain valuable. Retire the misleading Team copy and link diagnostics to the one integration catalog.
6. **There is verified dead implementation outside the named examples.** Nine private SEO functions in `AdsPage.jsx` have no binding references, exports, registration or invocation. All six live PPC tabs render other functions. `/admin/seo` uses `SEOPage.jsx`. Deleting only those declarations removes a misleading second implementation without retiring a supported screen or changing a backend.
7. **Existing consolidation has already removed many full pages.** Leads/Estimates, Auto-Dispatch, content engine, Contracts, Equipment and Knowledge have compatibility routes into existing hubs. Retained V1 shared-export modules are active dependencies. Count neither aliases nor these modules as duplicate live workflows.
8. **Routing is a prerequisite for larger merges.** Some aliases use bare `Navigate`, discarding query/hash context. Other pages keep tabs in local state. The smallest compatibility fix uses the existing `AdminTabRedirect`; a full workspace rewrite before addressing state semantics would hide lost record context.

## Scope and evidence

- [Capability/disposition map](capabilities.md): all 34 desktop destinations, mobile/auth/hidden routes, subordinate workflows, authorities and consumers.
- [Route registry snapshot](routes.csv): 68 child routes plus the admin shell and separate admin auth entry routes. The index redirect is described in the capability map.
- [Module index](module-index.csv): 695 relevant modules, declared panels/modals/widgets, JSX consumers, tab/filter choices, direct API calls, guards, state/subscriptions and relative dependencies. Choices are syntactic candidates, **not all independent tabs**.
- [Entry points](entry-points.csv): 2,503 static references from client, server, jobs, tools and operational scripts; includes API strings as explicitly distinguishable entries. Dynamic segments are represented by `${…}`. Multiple references are contextual access, not proof of redundant workflows.
- [API mount map](api-mounts.csv): server mounts connecting client API prefixes to routers. Per-handler permissions and DB/service authority are described in the capability map and source.
- [Parity and compatibility](parity-and-routes.md), [deletion ledger](deletions.md), [verification](verification.md).

The [collector](collect-inventory.cjs) parses tracked source with the repository's Babel parser; it never imports application modules. Regenerate the full raw evidence with `node docs/audits/admin-simplification/collect-inventory.cjs`. Output belongs under ignored `.tmp/simplification/`. The CSVs are the **pre-change snapshot**, intentionally not a new runtime navigation registry. No parse failures occurred. Computed URLs, named-export reachability, in-handler guards, database-held references and external consumers require manual inspection; this tool does not declare code dead.

All top-level destinations and route declarations were inspected. Shared-module reachability and API consumers were traced statically, with closer UI→API→service/state review of proposed changes and the owner-requested comparisons. This is not a claim that every branch of every business handler received a security audit or an interactive test.

## Starting environment and concurrent work

The supplied main checkout was at `a2bb0bc49`, behind main, with many unrelated edits and untracked artifacts. It was left intact. The task owns `/private/tmp/waves-admin-simplification-review-20260905`. Other worktrees were inspected read-only. In particular, `feat/admin-workspace-consolidation` at `74c13a0f5` holds an unpublished 39-file proposal from the older base. No PR was found for that branch. It is not incorporated here: moving multiple financial and communication shells together has unverified parity. No other branch was changed or pushed.

Node `20.20.2` matches `.nvmrc`; dependencies were installed from the existing lockfile with `npm ci --ignore-scripts --no-audit --no-fund` in this worktree. No dependencies were added. `worktree:setup` and frontend doctor passed. Managed integration credentials are excluded and background jobs disabled. No `.env` or `DATABASE_URL` is present. All interactive QA uses loopback Vite with intercepted synthetic API responses and blocked external traffic/service workers. The server suite uses an additional test-only external-network block.

Feature state: production gate values and per-user flags were **not queried**. Existing release gates remain unchanged. The source inventory records flag reads. Relevant conditional destinations include `agent_estimate`, `dashboard-ai-charts`, estimate status pills, invoice feature flags, Agent Ops hub features (`queue`, `ledger`, `runs`), bank import and other server-returned availability. Browser fixtures exercise admin/technician/guest with optional flags off and unavailable diagnostic reads; flag-on destination counts come from the unchanged metadata. Existing flag tests run in the client suite. Gate-off does not mean dead.

Usage: the confirmed Waves Pest Control PostHog organization/project `489072` exposes mostly public booking/estimate events. A read-only `$pageview` trend filtered to `$pathname` matching `^/admin(/|$)` returned **0** for the tool-reported UTC window 2026-08-07–2026-09-06. This is a telemetry coverage limitation, not evidence of zero admin use. The app deliberately records private admin navigation through `client/src/lib/adminUsage.js` → `server/routes/admin-usage.js` → `portal_usage_events` instead. Its production report was not queried; no account-level activity was exported. No traffic-based deletion or time-saving claim is made.

## Current navigation

Desktop has 8 headings and 34 destinations with `agent_estimate` enabled (33 when disabled), all direct links. Permissions filter individual leaves. Mobile has Dashboard, Schedule, Customers, Messages, Settings; the owner-only Dashboard is omitted for technicians, and Settings (`/admin/more`) lists secondary workspaces and settings leaves. Its label is an existing owner decision, not a new “More” bucket introduced here.

```text
Overview: Dashboard
Operations: Schedule, Reports, Assessments, Services, Equipment, Inventory, Price Match
Customers & Sales: Customers, Pipeline, Communications, Contracts, Reviews, Referrals
Marketing: Email, PPC, SEO, Social Media, Blog, Newsletter
Team & Automation: Staff, Recruiting, Agent Ops, Agent Estimate [flag]
Billing & Finance: Invoices, Recovery, Payers, Banking, Taxes, Pricing
Resources: Knowledge
Administration: Compliance, Tool Health, Settings
```

## Target navigation proposal (not all implemented)

The target keeps frequent work directly reachable and distinguishes business entities. Group headings are not permissions or additional clicks. Specialist leaves can retain their existing routes; a single enormous wrapper page is unnecessary.

```text
Daily work
  Dashboard — action inbox and contextual summaries
  Customers — directory/map, Customer 360, health and retention/opportunities
  Schedule — dispatch board, calendar, field assessments and completion
  Communications — SMS, Email [owner], Calls, Triage, Promises
  Pipeline — Leads, Estimates, create action; Agent Estimate shortcut [owner + flag], Price Match
  Billing [owner] — Invoices, Billing exceptions, Payer accounts
Service operations
  Reports — report authoring, WDO and certificate workflows, archive
  Services [owner] — catalog, treatment plans, pricing/discount configuration
  Equipment — operational assets, maintenance, calibrations
  Inventory — stock, vendors, restock and price review
  Compliance [owner in admin shell] — application logs, limits, licenses/credentials
  Knowledge — staff wiki, structured knowledge base, field evidence
Business
  People — Staff/time; Recruiting [owner], kept as separate entities
  Marketing [owner] — Acquisition (PPC/SEO), Content (Blog/Social/Newsletter), Reputation (Reviews/Referrals)
  Accounting [owner] — settlements/reconciliation, expenses/assets/mileage, P&L, tax filings/reports
System
  Agent Ops [owner] — control center, runs, existing queue, decisions/drafts, model controls
  Settings — account/preferences; owner-only configuration and diagnostic details
```

Contracts remain available from Customers/Pipeline and through the canonical Contracts workspace. Report authoring and field protocols remain task-specific surfaces. Marketing's specialist routes should stay direct within its groups, not a deeply nested all-feature page. Email, hiring, money, configuration and agents retain their current owner guards even when reached through a staff-visible parent. There is no separate office role in `admin-auth.js`: supported staff roles are `admin` and `technician`; do not infer the office user's actual role or grant permissions from their job title.

## Authorized implementation slices selected before production edits

| Slice | Classification | Evidence and risk | Scope/rollback |
|---|---|---|---|
| 1. Regroup existing links, clarify Events/Promises/Customer Advisor labels | RELOCATE (navigation only) / KEEP capability | Same paths, flags, IDs and leaf roles; no extra click depth. Low risk, verify both navigation surfaces. | Navigation metadata and three labels; revert independently. |
| 2. Repair already-consolidated alias context | MERGE entry points into existing canonical routes | `AdminTabRedirect` already preserves query/hash with `replace`. Low risk for selected aliases; keep existing guards. | Only route elements; no APIs. |
| 3. Retire Settings Team duplication; link Tool Health to Settings integrations | RETIRE UI / MERGE presentation | Self-profile fields already exist under General; integration catalog is the identical shared component. Low/medium risk, verify failure, role, Back and no duplicate requests. | No employee or provider data changes; explicit legacy `?tab=team` behavior. |
| 4. Delete private unreferenced PPC SEO declarations and newly obsolete props/helper | DELETE VERIFIED DEAD CODE | Lexical binding + export/route/dynamic consumer proof in deletion ledger; PPC/SEO workflows tested with mocks. | Isolated deletion commit; no endpoint or dependency removal. |

Larger recommendations are **DEFER PENDING EVIDENCE** for implementation. Their parity gaps are listed in the matrix. This selection does not imply that the broader target is already implemented or that reducing the sidebar count is the acceptance metric.

## Implemented navigation and behavior

The review branch implements this tree, using the existing registry and individual
role/flag filters. Every leaf is still a direct link. Service operations stays
second so Schedule remains the second desktop destination.

```text
Overview: Dashboard
Service operations: Schedule, Reports, Assessments, Services, Pricing, Equipment, Inventory, Compliance, Knowledge
Customers & Sales: Customers, Pipeline, Agent Estimate [flag], Price Match, Contracts
Communications: Communications, Email
Billing & Finance: Invoices, Recovery, Payers, Banking, Taxes
People: Staff, Recruiting
Marketing: PPC, SEO, Social Media, Blog, Newsletter, Reviews, Referrals
System: Agent Ops, Tool Health, Settings
```

Implemented: three clearer panel labels, nine context-preserving aliases, Account
instead of the self-only Team view, one integration catalog under Settings, two
fewer mobile Settings links, and verified private PPC code deletion. The
Intelligence Bar, every business queue, all six PPC tabs, SEO, employee/applicant
entities, pricing and every backend/API remain intact.

The separate skeptical parity pass found two additional failures and added
regressions before fixing them: the Account profile must remain available when
the unrelated health endpoint fails, and a technician's restricted route child
must not mount before the existing redirect effect runs. Independent settlement
of the existing reads and the existing role predicate on the Outlet fix those
cases. The shell also supplies the original URL to login's existing validated
`next` mechanism. No new authorization policy, route registry or redirect helper
was introduced. Login's existing technician-to-`/tech` policy is retained.

Exact measurements, verification limits and per-slice rollback are in
[verification.md](verification.md). This is a local review implementation; no
push, PR, merge, deployment, production data change or provider action occurred.

## Remaining decisions

1. Which retention functions should share the Health panel, and must persistent outreach/upsell history be visible without opening chat? Preserve the existing owner-approved outreach boundary in every case.
2. Should a future Messages shell retain both mounted channel drafts, persist them per account/thread, or prompt on switching? Current Email does not provide reliable draft recovery across unmount/reload. Establish this before embedding/retiring its route.
3. Which Events editor operations are intended for technicians? Events and SMS template APIs are staff-wide; email template APIs and the separate template-library navigation are owner-only. Consolidating everything into that library would remove currently accessible SMS editing. Preserve those APIs and resolve this disagreement before merging editors.
4. Should communications triage be split by `triage_reason`/source into a contextual Agent Ops view? Specify the owner/assignment model and retain one source record, never synchronize separate queues.
5. Approve Billing versus Accounting scopes and canonical A/R definitions; the task does not authorize changing them. Decide how to link both Operating Costs editors to one location without changing role access.
6. Should People navigation remain two direct leaves under one heading or gain a shared workspace header? Applicant `hired` currently does not itself establish an employee transition in the inspected status route; do not invent automatic onboarding.
7. What urgent tool/integration failures are already guaranteed to reach the existing action inbox/bell? Until that is proven, retain the direct Tool Health destination. Do not hide outages in Settings.
8. Reconcile this branch with the unpublished workspace-consolidation branch before either is proposed for merge. This review branch never overwrites that work.

Before adding a new page, tab, AI assistant, queue, or action system, check whether the capability belongs in an existing canonical workflow. The existing navigation metadata, route tests, shared services and source queues are the prevention mechanism; no new governance service is needed.
