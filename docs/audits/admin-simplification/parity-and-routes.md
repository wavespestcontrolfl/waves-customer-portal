# Parity and route compatibility

Prepared before production edits. Final execution results belong in [verification.md](verification.md); “planned test” is not a pass. Source role/action contracts are in [capabilities.md](capabilities.md). No screen is retired based on a planned destination alone.

## Selected consolidations

| Old capability | Canonical destination | Permissions and data/action source | State preservation | Planned regression evidence | Remaining limitation |
|---|---|---|---|---|---|
| Settings → Team: signed-in user's name/email/role/avatar initial | Settings → General → Logged In As (`?tab=general`) | Same authenticated user from `/admin/auth/me`; no employee records or actions in old panel | `?tab=team` uses the existing invalid-leaf fallback to General. Other query/hash values remain in URL. No drafts, search, pagination, sorting, attachments, bulk actions or approval state existed here. | Render old link and Account for both roles; verify same identity fields and exactly one page-level user request, no Team Members duplicate; query-only navigation and mobile; error must not display another user's data. | General has existing fallback text on failed profile fetch. Real employee administration remains Staff; no employee workflow is removed. |
| Tool Health → Integration Configuration catalog | Settings → Integrations (`?tab=integrations`) | A only; same `IntegrationHealthSection`, `/admin/integrations/health`; manual `/admin/token-health/check` remains in Settings. Old Tool Health embed had `showRefresh=false`, so no action is lost. | No catalog search/filter/pagination/saved view/draft/attachments/bulk actions existed. Browser Back returns to runtime diagnostics; runtime window selection already resets on route unmount at baseline. | Link reachability; cached credential status visible in Settings; check button produces one mocked POST then one reload; admin/technician negative cases; loading/error views; no catalog GET on Tool Health; runtime errors/window/refresh/poll cleanup remain. | Provider freshness and actual outage notification delivery are not verified. Keep direct Tool Health entry until urgent visibility proven. |
| Mobile Tap to Pay and Integrations both open identical `?tab=integrations` | One Integrations link | Both were A only; same canonical settings guard | No distinct tap-to-pay selection or action existed in this navigation metadata. Technician payment/checkout flows elsewhere unchanged. | Mobile link uniqueness and reachability; retained Account/Integrations links; role filtering. | A dedicated Terminal settings focus could be useful, but inventing it is a separate product change. |
| Nine private SEO functions inside `AdsPage.jsx` | Existing `/admin/seo` remains; six PPC tabs unchanged | A; no removed function could mount, execute an effect or expose an action. SEO routes/APIs/tools unchanged. | No supported runtime state is owned by unreachable lexical declarations. No persisted identifiers or public exports removed. | Binding-reference proof, no dynamic lookup, all live PPC tabs exercise their expected GETs; SEO authoritative workspace unchanged/build/test; lazy chunk check. | Not nine live workflows retired. Already tree-shaken production code may yield no bundle savings. |

For both retired UI copies, keyboard focus, browser Back/Forward, direct load/refresh, desktop/mobile overflow, labels and failed-request behavior must be exercised in fixtures before reporting completion. The source component/shared field preservation is stronger evidence than a matching screenshot alone. Tests never click a real provider check or employee/customer mutation.

## Navigation and label parity

| Existing entry | New presentation | Permission / state / action invariant |
|---|---|---|
| Email under Marketing | Communications group, still `/admin/email` | Owner flag and route unchanged. No unmounting channel shell introduced; message/thread/drafts stay in original component. |
| Agent Estimate under Team & Automation | Customers & Sales beside Pipeline | A + `agent_estimate` unchanged; same IB hook/tool registry/pending-actions/threads and canonical estimates. |
| Price Match under Operations | Customers & Sales | A unchanged; draft statuses/actions/pricing unchanged. |
| Staff and Recruiting among agent tools | People heading, two direct links | Individual S/A restrictions retained. Group does not confer access to recruiting/compensation. |
| Pricing under Billing | Service operations alongside Services | Same route, owner guard, `area`/`section`/focus and all calculators. No price logic changes. |
| Reviews and Referrals mixed with customer service | Marketing | Same APIs, roles, filters, rewards/outreach and direct links. |
| Tool Health, Agent Ops, Settings across headings | System | All remain direct links; no urgent failure is hidden behind Settings. |
| Communications Events / Owed | Message Automations / Promises | Stable `events`/`owed` keys, hash links and usage leafs, components and actions. Newsletter Events remains distinct. |
| Customers AI Advisor | Retention & Upsells | Stable `view=intelligence`; same health/outreach/opportunity records and controls. Existing Intelligence Bar remains general assistant. |

No role gains capabilities. Navigation choice counts and click depth are measured separately; moving links does not count as eliminating independent implementation.

## Selected alias repairs

All aliases below already redirect at baseline. Their canonical target, tab and authorization stay the same. The change replaces a query/hash-dropping `Navigate` with existing `AdminTabRedirect`, which preserves remaining query keys and hash, forces the required destination leaf, and uses `replace` so Back does not bounce through the alias. It affects UI GET navigation only, never APIs/webhooks/mutations.

| Old `/admin/…` | Canonical destination | Context that must survive | Guard |
|---|---|---|---|
| `content-engine` | `/admin/blog?tab=autopilot` | Existing source/run/content query/hash, even if a specific panel does not consume every key | A→A |
| `content-registry` | `/admin/blog?tab=registry` | Registry source/filter/query/hash | A→A |
| `data-hygiene` | `/admin/agents?tab=hygiene` | Especially `status=auto_applied` consumed by `DataHygienePage` for digest links | A→A |
| `agent-decisions` | `/admin/agents?tab=decisions` | Query/hash transport; decision selection is currently local state | A→A |
| `drafts` | `/admin/agents?tab=drafts` | Query/hash transport; lane/draft list still uses its current state contract | A→A |
| `health` | `/admin/customers?view=health` | Customer query context/hash; `view` forced to health | Existing A alias→S canonical destination, source guard unchanged |
| `documents` | `/admin/contracts?tab=templates` | Template query/hash transport; editor IDs only supported where existing component consumes them | A→A |
| `document-requests` | `/admin/contracts?tab=requests` | Request query/hash transport | A→A |
| `discounts` | `/admin/service-library?tab=discounts` | Discount query/hash transport | A→A |

Tests read the actual `App.jsx` alias configuration and render the existing redirect, checking IDs, repeated query values, hash, canonical leaf, history replacement, direct refresh and technician/guest restrictions. Passing transport tests does **not** create new selected-record support in panels that never implemented it.

The shell now preserves its initial guest/expired-session URL in `?next=` using
the existing `AdminLoginPage` reader, which already rejects external/scheme and
double-slash/backslash targets. A browser fixture signs in through the real form
with an intercepted login response, then reaches Data Hygiene with the original
status and fragment. Technicians retain login's existing `/tech` destination
policy; an expired staff admin-workspace bookmark is not newly promised to return
there after technician login. No login API contract or token validation changed.

The shell previously rendered a restricted child for one frame before its role
redirect effect ran. The same existing role/path predicate now gates the Outlet.
Nine negative tests assert both the final Schedule destination and zero restricted
child renders. API permission checks remain authoritative and unchanged.

The self-profile parity test also caught a health-outage case: General coupled
health and profile success, while old Team's extra profile read could succeed
independently. Both existing reads now settle independently, preserving the
identity without retaining the duplicate request. Failed profile reads show the
existing Unknown fallback and expose no owner configuration.

All other routes have a **KEEP** or **DEFER** disposition in routes.csv/capabilities.md. Existing Schedule/Fleet/Assessment and remapping adapters are retained. `revenue`, `ads`, `call-recordings`, `phone-numbers`, `pricing-reality-check` still need a historical-context decision before broadening their redirect contract. No detailed record is claimed to resolve if it only reaches a generic dashboard.

## Proposed merges that are not ready for retirement

| Current workflow | Proposed destination | Parity that already exists | Missing/unresolved parity and retirement blocker |
|---|---|---|---|
| Customer Advisor + Health | Customers health/retention workspace; general questions via IB | Current customer/health sources; shared bar can read customers | Outreach approve/skip/send effects, upsell dispositions, metrics/history, all relevant permissions, selection and pageData, error states. Cannot replace this panel with chat alone. |
| Tax/PPC/SEO advisors | Specific analysis panels opened from canonical business workspace/IB | Some IB tools run/read tax/SEO analyses using existing services | Saved report history, editable recommendations/apply, review/acted-on/dismissed statuses and evidence differ. Keep dedicated panels; no extra conversation store. |
| Events + Message Templates | One automation/template workspace with event and library views | SMS template IDs and email automation/version endpoints shared | SMS staff write access versus owner-only library/email; version create/test/publish, variables, unmapped templates, delete constraints, previews, unsaved edits, retries and error handling. Merely linking to a library can lose event editing. |
| Email + SMS | Communications channel workspace reusing current inboxes | Same customer/contact links and shell authentication | Draft retention across tabs/reload, selected message/thread and return URLs, attachments/recipients/sender/signature support, unread/assignment states and provider/suppression/consent parity. Current email component state is insufficient for retirement. |
| Communications Triage + Agent Ops diagnostics | Source-based intervention links in existing Ops queue; communications work stays in Communications | Same call IDs, `triage_items`, route decisions/feedback available | Exact reason→work ownership; preserve open/resolved/auto-routed modes, verdict/retry/assignment/urgency, customer/property corrections, privacy and original call context. No independent resolution store permitted. |
| Promises / CSR follow-ups | Contextual communication attention views | Call/customer evidence can link records | `call_commitments`, `ai_follow_up_tasks`, triage and draft states differ. No automatic dedupe or cross-resolution. Keep deadline, who-promised, fulfilled/cancelled semantics and history. |
| Staff + Recruiting | People, differentiated Staff/Applicants | Navigation grouping is safe now | Staff tab URL state, compensation/attachments/permissions; applicant-to-employee handoff is not implemented by the hiring status route. Preserve both lists and all stages. |
| Agent Estimate + Pipeline | Canonical estimates plus source/owner/status views, dedicated drafting panel | Same estimate rows and send endpoint; IB canonical registry | Lead/evidence/account snapshots, learning/memory, approvals, attachments/dictation, conversation threads, estimate versions and mobile send-review workflow. No status remapping. |
| Billing Recovery/Invoices/Payers | Billing with three distinct leaves | Contextual invoice/customer/payer links | Selected invoice/debtor, create/edit drafts, scheduled send/credit/refund/payment-plan flows; missing invoices cannot become invoice filter; payer A/R excluded from tax A/R. Preserve cents and states independently. |
| Banking/Tax + duplicated Operating Costs | Accounting, single settings editor | Both cost editors read/write `/admin/revenue/settings` | Baseline permissions differ by containing page; categories/fields/defaults/save payload/error semantics, P&L drafts/date filters, bank upload/duplicates/settlement and exports. No financial refactor authorized. |
| Tool Health under Settings | Settings diagnostics with actionable failures linked from existing inbox/bell | Identical integration catalog can move safely | Prove every urgent runtime/provider failure still surfaces outside Settings; retain visibility separate from editing credentials. Keep current direct destination meanwhile. |
| Inventory/Services/Knowledge reports | Task-specific contextual summaries around their existing authorities | Shared catalog/protocol/evidence dependencies | Field execution/pricing fan-out and wiki versus structured evidence provenance; compliance and WDO records cannot be retired as low-use reports. |

These matrices intentionally identify unsupported replacement behaviors. They are open decisions, not permission to weaken assertions, merge entities, remove functionality or run live actions to make a demo look complete.
