# Deletion ledger

Recorded before deletion. All references/lines below are anchored to baseline `32de1dc5c`; final line numbers change after cleanup. No production data, migrations, schema, endpoints, public assets, packages, historical records or supported tests are deletion candidates.

## Approved high-confidence candidates

| Exact candidate | Why unused/superseded; consumers checked | Replacement and parity | Required verification / rollback | Confidence |
|---|---|---|---|---|
| `AdsPage.jsx:1875` `SEODashboardTab` | Private function; Babel program binding has zero reference paths and zero writes. Absent from six `TABS`/render branches and from export surface (only default `AdsPage`). | Live SEO Dashboard is in `SEOPage.jsx`; no runtime retirement required. | PPC six-tab fixtures, SEO render, build/lint; restore deletion commit. | High |
| `AdsPage.jsx:2666` `SEOAdvisorTab` | Same lexical proof; no registration/import/evaluation path. | Live SEO advisor retained. | Same; retain all advisor APIs/actions. | High |
| `AdsPage.jsx:3247` `RankingsTab` | Same proof; occurrence of same name in another module is a separate lexical binding, not a consumer. | Live SEO rankings retained. | Same. | High |
| `AdsPage.jsx:3413` `BacklinksTab` | Same proof. | Live SEO authority/backlink workflow retained, including newer owner/reconciliation work. | Same. | High |
| `AdsPage.jsx:3570` `ContentQATab` | Same proof. | Live SEO Content QA retained. | Same. | High |
| `AdsPage.jsx:3730` `AIOverviewTab` | Same proof. | Live SEO AI Overview retained. | Same. | High |
| `AdsPage.jsx:3878` `SEOFunnelTab` | Same proof. | Live SEO Funnel retained. | Same. | High |
| `AdsPage.jsx:4021` `CitationsTab` | Same proof. | Live SEO Citations retained. | Same. | High |
| `AdsPage.jsx:4160` `SiteAuditTab` | Same proof. | Live SEO Site Health retained. | Same. | High |
| Any import/helper used exclusively by those declarations | Only delete after recalculating binding references with the nine functions removed; no blanket autofix. | None needed for unreachable callers. | Record exact removed symbols below after second pass; live PPC expressions remain byte-identical. | Conditional until checked |
| `SettingsPage.jsx:2539` `TeamList` and `tab=team` render/metadata | Single local JSX caller; only effect fetches `/admin/auth/me`, sets `[me]` and displays name/email/role/initial. No export, list/search/action/form/draft. General's Logged In As already displays same fields from page-level request. | General/Account; old `?tab=team` uses existing fallback while preserving URL query/hash. Actual Staff employee manager untouched. | Both roles, legacy/general URL, failure, one profile request, mobile navigation, Back; revert UI retirement commit. | High after fixture parity |
| `IntegrationHealthSection` `intro` and `showRefresh` props | Only custom caller is Tool Health; Settings uses defaults. Repository-wide reference scan includes tests, source/config, scripts and wrappers. | Canonical Settings instance always renders existing default description and manual check control. | Settings catalog/one mocked check/error, Tool Health no duplicate GET; revert UI retirement commit. | High after caller removal |

PPC lexical proof was produced by parsing `AdsPage.jsx` with `@babel/parser`, traversing Program bindings with the installed Babel traverse dependency, and inspecting `referencePaths`/`constantViolations`. All nine had `[]` and `0`. Whole-tree `rg` plus the AST inventory checked App route/lazy imports, named exports, JSX references, string registries, `import.meta.glob`, `require.context`, `eval`/`new Function`, scripts/tests, source configs, agent prompts/tools, jobs and workers. No dynamic loading mechanism can reach these private declarations. All hooks/effects are inside uninvoked functions; removing declarations runs no code.

Database-held links, external bookmarks, native clients and service workers can only address routes/assets/exports; these symbols are private and no route/asset/export is deleted. `/admin/ppc`, legacy `/admin/ads`, `/admin/seo`, all APIs and SEO workers remain. This proves more than “no imports found.” It does not justify deleting corresponding SEO backend services or identical-looking functions in the live SEO module.

## Deliberately retained

Second-pass candidates, recorded before deletion: `AdsPage.jsx` private
`isAdminUser` has zero remaining references after removing the nine declarations;
all prior callers were inside those declarations. The seven named Recharts
imports (`BarChart`, `Bar`, `XAxis`, `YAxis`, `CartesianGrid`, `Tooltip`,
`ResponsiveContainer`) likewise have no remaining references. This is a named
component import, not an intentional side-effect import. The Recharts dependency
and live PPC dashboard/chart consumers remain. No other helper or import is
proposed for deletion. The live-node comparison excludes precisely these eight
bindings and the nine functions above.

| Candidate/class | Disposition and missing deletion proof |
|---|---|
| `SchedulePage.jsx`, `CustomersPage.jsx`, `EstimatePage.jsx`, `CommunicationsPage.jsx` | **KEEP** mandated shared exports; current V2, schedule/customer/tech components import them. Old filenames are not dead evidence. |
| `IntelligenceBarShell`, `useIntelligenceBar`, `TechIntelligenceBar`, `WdoIntelligenceBar`, pending-actions/thread modules | **KEEP** active Agent Estimate/tech/shared consumers and confirmation history. Main already retired former admin embeds; do not claim those other sessions' deletions as this audit's work. |
| `CustomerIntelligenceTab`, tax/SEO/PPC Advisor panels | **DEFER PENDING EVIDENCE** unique retained record dispositions/history; not proven replaced by IB. |
| Events/Templates code and APIs | **DEFER** cross-channel/role/version parity absent. Producers/jobs/runtime templates remain valuable even if a tab moves. |
| Agent decisions, drafts, triage, CSR follow-ups, commitments, Ops Queue | **KEEP** distinct source records/approval boundaries. No usage window proves these lanes obsolete. |
| Agent Estimate | **KEEP** gated dedicated drafting/evidence/memory workflow, same canonical estimate record. |
| Turf Height review and maintenance/design/dev paths | **KEEP** supported hidden recovery/maintenance roots. No static sidebar entry required. |
| Banking/Tax/A/R/Recovery, Operating Costs editor | **DEFER** different measures/permissions; no financial code/records removed. |
| Inventory/protocol/wiki overlap | **DEFER** field, price, compliance, content and evidence consumers; schema/config fan-out not established for removal. |
| All APIs, historical migrations, DB tables/columns, service-worker/native/public assets | **KEEP** external/maintenance consumers cannot be excluded, and data deletion is outside scope. |
| Dependencies | **KEEP** no package removal proposed. Bundling/static no-import output does not exclude scripts, server/native/build/peer consumers. |

## Skeptical review pass

Before deletion, assume each candidate is live. Attempt to reach it through route/lazy roots, named exports, runtime string selection, flags, side-effect evaluation, a job/script, a public asset or an older client. Reject any candidate whose reachability or parity remains ambiguous. The nine PPC declarations survive this challenge because lexical privacy plus absence of all references is decisive; a sidebar absence alone is not.

After deletion, compare the live PPC AST nodes before/after (ignoring source positions/comments), inspect the diff, run relevant tests/build, and verify no endpoint was removed. For UI retirement, verify the new destination before removing old markup. Record final outcomes and any extra dead symbols in verification.md. Rollback is an ordinary revert of the relevant local commit; no database recovery or provider action is needed.
