---
name: waves-design
description: Use when doing ANY UI work on the portal — admin pages (V2 zinc system or legacy D-palette), customer surfaces, or tech portal. Covers which style system a file uses, the V2 architecture (routes, retained V1 exports, feature flags), the palettes/tokens, the alert-fg and Customers-colored-indicators rules, and which spec document governs which surface.
---

# Waves portal design systems

Authoritative specs (this skill is the map, those are the law):
- `docs/design/waves-portal-ui-redesign-spec.md` — full monochrome admin spec
- `docs/design/waves-customer-facing-design-brief.md` — customer-surface warm
  tone (do NOT apply the admin spec to customer surfaces)
- `docs/design/DECISIONS.md` — architectural decisions log + full PR history;
  append new entries at bottom, never edit old ones

## The two style systems (never mix in one component)

**Tier 1 V2 (now-default admin)** — `import { Button, Badge, Card, ... }
from 'components/ui'`. 13 primitives in `client/src/components/ui/`.
Tailwind tokens in `client/tailwind.config.js`: zinc ramp, alert red, type
scale 11–28, `border-hairline`, letterSpacing `label`/`tight`/`display`.
`darkMode: false`; `fontWeight` restricted to 400/500 — do not add weight
600/700. Reference page at `/admin/_design-system` (dev-gated; excluded
from robots.txt).

**Legacy / V1 / Tier 2** — inline styles + the `D` dark palette:

```js
const D = {
  bg: '#0f1923', card: '#1e293b', border: '#334155',
  teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b',
  red: '#ef4444', purple: '#a855f7',
  text: '#e2e8f0', muted: '#94a3b8', white: '#fff'
};
```

Fonts: DM Sans (body), JetBrains Mono (numbers/code), Montserrat (tech
portal headings).

Match what the file you're editing already uses.

## Admin V2 architecture (shipped, default for everyone)

The Tier 1 V2 redesign for Dashboard, Dispatch, Customers + Detail,
Estimates + `/new`, Communications, and the admin shell is the default. The
V1 page components, the per-flag gates (`DashboardGate` / `DispatchGate` /
`CustomersGate` / `EstimatesGate` / `CommunicationsGate` /
`AdminLayoutGate`), and the V1-only `MobileAdminShell` were deleted.
`/admin/dashboard|customers|estimates|communications` route directly to
`*PageV2`; `/admin/dispatch` is `AdminDispatchPage` (Board tab +
DispatchPageV2 under tabs); `/admin/schedule` redirects to
`/admin/dispatch?tab=schedule`. The admin shell is `AdminLayoutV2`.

**Retained V1 modules (named-export only, no V1 page route):**
`SchedulePage.jsx`, `CustomersPage.jsx`, `EstimatePage.jsx`,
`CommunicationsPage.jsx` are shared-utility modules — they export constants
and sub-components consumed by V2 (`CompletionPanel` / `RescheduleModal` /
`EditServiceModal` / `ProtocolPanel` / `MONTH_NAMES` / `STAGES` /
`STAGE_MAP` / `KANBAN_STAGES` / `LEAD_SOURCES` / `CustomerMap` /
`CustomerIntelligenceTab` / `STATUS_CONFIG` / `PIPELINE_FILTERS` /
`DECLINE_REASONS` / `classifyEstimate` / `getUrgencyIndicator` /
`detectCompetitor` / `ALL_NUMBERS` / `NUMBER_LABEL_MAP`). The
`export default function ...Page()` component is gone from each — do not
resurrect it, and do not delete these files as "dead code".

## Rules for Tier 1 V2 work

- Visual-refresh PRs are **strict 1:1** on data, endpoints, metrics, and
  behavior. Content changes and visual changes never share a PR.
- Use `components/ui` primitives + Tailwind zinc ramp + `border-hairline`
  chrome.
- `alert-fg` (red) is reserved for genuine alerts only — never decoration.

**Exception — Customers V2 status indicators (`/admin/customers` Directory
+ Customer 360):** colored decoration is intentional on the customers
surface for at-a-glance triage. Specifically allowed:
- **Health score** (HealthDot, HealthCircle, "Score: NN/100" label): green
  `#10B981` (≥70), amber `#F59E0B` (40–69), red `#C8312F` (<40).
- **Tier badge** (Customer 360): metal-coded — Platinum `#E5E7EB`, Gold
  `#D4A017`, Silver `#9CA3AF`, Bronze `#A16207`.
- **Stage badge** (Customer 360): green `#10B981` for
  `active_customer`/`won`; red `#C8312F` for everything else.

Other admin surfaces follow strict zinc + alert-fg-for-alerts-only rules.

## Feature flags

`useFeatureFlag('<key>')` from `client/src/hooks/useFeatureFlag.js`.
DB-backed via `user_feature_flags`, session-cached in memory, fails closed
(returns `false` if the API is unreachable). No localStorage persistence,
no percentage rollouts, no environment variants — the schema is
intentionally minimal. The retired V2 keys (`dashboard-v2`, `dispatch-v2`,
`customers-v2`, `estimates-v2`, `comms-v2`, `mobile-shell-v2`,
`admin-shell-v2`) are no longer read by the client; stale rows are inert.

## Hard lines (both systems)

- 14px minimum for readable text (Virginia uses this 8 hours a day). The
  brand gate (`npm run check:portal-brand`) enforces this on customer
  surfaces.
- Never apply customer-facing brand styling (Luckiest Guy / Baloo 2 / gold
  pill / mascot) inside `/admin/*` — admin stays monochrome.
- Before requesting review on any UI-touching PR, run the **ui-verify
  skill** (render, screenshot, compare against the spec).

Full per-PR detail (endpoints touched, subcomponents shipped, alert-fg
rules per page): `docs/design/DECISIONS.md`.
