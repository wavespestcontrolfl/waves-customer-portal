# Admin information architecture audit

Status: implementation guide

Audited: 2026-07-16

Scope: the authenticated `/admin/*` application shell, routes, and navigation

## Executive finding

The admin has 33 visible destinations, 65 mounted child paths, and 27 compatibility redirects. The gap is not a large body of provably dead pages. It is a set of specialist pages, duplicate entry routes, and already-retired URLs that are presented inconsistently.

Static code evidence cannot prove that a production page has no users. No mounted page should be deleted based only on this audit. Removal requires route telemetry or an owner-confirmed replacement, followed by a redirect window.

## Keep as primary destinations

The destinations in `client/src/config/adminNavigation.js` remain the supported primary inventory. Desktop and mobile now expose the same inventory through these groups:

- Overview
- Operations
- Customers & Sales
- Marketing
- Team & Automation
- Billing & Finance
- Resources
- Administration

The five mobile task tabs remain Dashboard, Schedule, Customers, Messages, and More.

## Already consolidated correctly

Keep these compatibility routes while old bookmarks, notifications, or server-generated links may exist:

| Old route | Canonical destination |
| --- | --- |
| `/admin/schedule` | `/admin/dispatch?tab=schedule` |
| `/admin/revenue` | `/admin/dashboard` |
| `/admin/ads` | `/admin/ppc` |
| `/admin/content-engine` | `/admin/blog?tab=autopilot` |
| `/admin/content-registry` | `/admin/blog?tab=registry` |
| `/admin/data-hygiene` | `/admin/agents?tab=hygiene` |
| `/admin/agent-decisions` | `/admin/agents?tab=decisions` |
| `/admin/lawn-assessment` | `/admin/lawn-assessments?tab=field` |
| `/admin/health` | `/admin/customers?view=health` |
| `/admin/fleet` | `/admin/equipment?tab=maintenance` |
| `/admin/documents` | `/admin/contracts?tab=templates` |
| `/admin/document-requests` | `/admin/contracts?tab=requests` |
| `/admin/discounts` | `/admin/service-library?tab=discounts` |
| `/admin/call-recordings` | `/admin/communications` |
| `/admin/phone-numbers` | `/admin/communications` |
| `/admin/pricing-reality-check` | `/admin/pricing-logic?section=reality` |
| `/admin/leads` | `/admin/pipeline?tab=leads` |
| `/admin/estimates` | `/admin/pipeline?tab=estimates` unless an explicit valid Pipeline tab is supplied |
| `/admin/equipment-calibration` | `/admin/equipment?tab=calibrations` |
| `/admin/credentials` | `/admin/compliance?tab=credentials` |
| `/admin/pricing` | `/admin/pricing-logic?area=strategy` |
| `/admin/price-change` | `/admin/pricing-logic?area=notices` |
| `/admin/auto-dispatch` | `/admin/dispatch?tab=automation` |
| `/admin/lawn-protocol` | `/admin/service-library?tab=protocols`; the former `tab` value is preserved as `protocolTab` |
| `/admin/kb` | `/admin/knowledge?area=base`; a known former `tab` value is preserved as `kbTab` |

These redirect routes are compatibility infrastructure, not dead sections. Removing them would break deep links without improving navigation.

## Newly completed route consolidations

These active entry routes now resolve inside a canonical destination. They use query- and hash-preserving redirects, and no underlying workflow or API has been removed.

| Current entry route | Evidence | Recommended destination |
| --- | --- | --- |
| `/admin/leads` | `LeadsPage` only wraps `LeadsSection`, which is also the Pipeline Leads tab. Server notifications still generate `?lead=` links. | `/admin/pipeline?tab=leads`, preserving all query parameters |
| `/admin/estimates` | The route and `/admin/pipeline` both mount `EstimatesPageV2`. | `/admin/pipeline?tab=estimates`, while honoring explicit `tab=new` and estimate deep links |
| `/admin/equipment-calibration` | `EquipmentCalibrationPanel` is already the Equipment `calibrations` tab. | `/admin/equipment?tab=calibrations` |
| `/admin/lawn-protocol` | The command center owns seven related protocol-authoring and readiness areas. Services is its operational parent, and alert-driven subarea links must remain addressable. | `/admin/service-library?tab=protocols&protocolTab=<subarea>` |
| `/admin/kb` | Wiki and Knowledge Base use separate APIs and workflows, but both are knowledge-management tools under the same Resources parent. | `/admin/knowledge?area=base`, while Wiki remains the default area |

The `/admin/estimates/:estimateId/proposal` detail route remains a real workflow and must not be redirected.

## Hub consolidation status

The identified specialist pages now live inside canonical, discoverable parents. Their underlying APIs and workflows remain separate, and legacy routes remain mounted as compatibility redirects. No active specialist workflow was deleted or hidden without a replacement.

## Intentional non-navigation routes

Keep these out of the primary sidebar:

- `/admin/customers/duplicates`: contextual customer cleanup workflow.
- `/admin/estimates/:estimateId/proposal`: estimate detail workflow.
- `/admin/settings/pest-pressure`: contextual settings detail.
- `/admin/_design-system` and `/admin/_design-system/flags`: internal implementation tools; confirm production authorization separately.
- `/admin/more`: mobile navigation surface, not a desktop destination.

## Dead-code finding

`CustomerHealthPage.jsx` is no longer mounted. `/admin/health` redirects into the Customers health view, which renders `CustomerHealthSection` from `CustomerHealthTabs.jsx`. The unused lazy import in `App.jsx` has been removed.

The old page file should be deleted only in a cleanup-only change after confirming that no active branch is still migrating code from it. Its server APIs remain live because the embedded Customers health view uses them.

## Recommended implementation order

1. Add route-reachability regression coverage for every navigation destination.
2. Completed: redirect Leads, Estimates, and Equipment Calibration to their existing canonical tabs while preserving query parameters and fragments.
3. Completed: Compliance + Credentials and the Pricing hub now remove the largest conceptual duplicates without deleting capabilities.
4. Completed: Auto Dispatch is now the Schedule Automation tab, and Lawn Protocol is the Services Protocol & Readiness area.
5. Completed: the Knowledge hub combines Wiki and Knowledge Base navigation while preserving both workflows and their nested URLs.
6. Collect route telemetry for at least one normal operating cycle before deleting retired page components.
7. Apply the UI consistency contract one completed hub at a time.

Each numbered step should remain a separate, reversible review unit.
