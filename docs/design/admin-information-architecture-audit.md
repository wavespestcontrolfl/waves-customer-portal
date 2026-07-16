# Admin information architecture audit

Status: implementation guide

Audited: 2026-07-16

Scope: the authenticated `/admin/*` application shell, routes, and navigation

## Executive finding

The admin has 35 visible destinations, 65 mounted child paths, and 22 compatibility redirects. The gap is not a large body of provably dead pages. It is a set of specialist pages, duplicate entry routes, and already-retired URLs that are presented inconsistently.

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

These redirect routes are compatibility infrastructure, not dead sections. Removing them would break deep links without improving navigation.

## Newly completed route consolidations

These routes rendered a component that already existed inside a canonical destination. They now use query- and hash-preserving redirects. Their wrapper files remain in the repository until a later cleanup-only change.

| Current entry route | Evidence | Recommended destination |
| --- | --- | --- |
| `/admin/leads` | `LeadsPage` only wraps `LeadsSection`, which is also the Pipeline Leads tab. Server notifications still generate `?lead=` links. | `/admin/pipeline?tab=leads`, preserving all query parameters |
| `/admin/estimates` | The route and `/admin/pipeline` both mount `EstimatesPageV2`. | `/admin/pipeline?tab=estimates`, while honoring explicit `tab=new` and estimate deep links |
| `/admin/equipment-calibration` | `EquipmentCalibrationPanel` is already the Equipment `calibrations` tab. | `/admin/equipment?tab=calibrations` |

The `/admin/estimates/:estimateId/proposal` detail route remains a real workflow and must not be redirected.

## Consolidate into hubs before hiding

These pages are active and must not be classified as dead. They should become tabs or sub-routes of a clearer parent so they are discoverable without adding more top-level navigation.

| Current page | Why it is active | Recommended parent |
| --- | --- | --- |
| Pricing Strategy (`/admin/pricing`) | Uses the pricing strategy API for offers, LTV, upsells, and value calculations; Pricing Logic does not replace those functions. | One Pricing hub containing Logic, Strategy, Reality Check, and Notices |
| Lawn Protocol (`/admin/lawn-protocol`) | Inventory and readiness alerts deep-link to it; it owns publishing, readiness, product assignment, and substitutions. | Operations → Protocol & Readiness |
| Auto Dispatch (`/admin/auto-dispatch`) | Owns dispatch runs, decisions, locks, exclusions, and manual triggers. | Schedule → Automation/Audit tab, with role restrictions retained |
| Wiki (`/admin/knowledge`) and Knowledge Base (`/admin/kb`) | Both are implemented and use separate APIs, but their labels describe overlapping concepts. | One Resources hub with Wiki and Knowledge Base tabs |

Until those hubs exist, retain the direct routes. Hiding them now would make active alert-driven workflows harder to recover.

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
3. Compliance + Credentials completed. Build the Pricing hub to remove the remaining large conceptual duplicate without deleting capabilities.
4. Add Protocol & Readiness and Auto Dispatch inside Operations/Schedule.
5. Build the Resources hub for Wiki and Knowledge Base.
6. Collect route telemetry for at least one normal operating cycle before deleting retired page components.
7. Apply the UI consistency contract one completed hub at a time.

Each numbered step should remain a separate, reversible review unit.
