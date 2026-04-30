# Admin Typography Strategy

Authoritative reference for text in the Tier 1 V2 admin (post-H1). H1 styling is unchanged from the original V2 spec (`text-28 font-normal tracking-h1`); this document defines everything below.

Strategy in one sentence: **role-based, not size-based.** Every text element gets a role; each role pins one size + weight + color + tracking. Reuses the existing tokens in `client/tailwind.config.js` (sizes 11–28, weights 400/500, ink ramp).

## The roles

| Role | Size | Weight | Color | Tracking | Element | Use |
|---|---|---|---|---|---|---|
| `h2` | 18 | 500 | ink-primary | tight (-0.01) | `h2` | Card group headers, modal titles |
| `h3` | 14 | 500 | ink-primary | normal | `h3` | Card titles, table section headers |
| `body` | 14 | 400 | ink-primary | normal | `p` | Default paragraph, form values, table cells |
| `body-secondary` | 14 | 400 | ink-secondary | normal | `p` | Supporting copy, descriptions |
| `body-small` | 13 | 400 | ink-secondary | normal | `p` | Dense tables, tooltips, helper text |
| `label` | 11 | 500 | ink-secondary | label (0.06, UPPERCASE) | `div` | Form labels, column headers, eyebrow tags |
| `caption` | 12 | 400 | ink-tertiary | normal | `div` | Timestamps, "last updated", row meta |
| `metric` | 22 | 500 | ink-primary | tight, tabular-nums | `div` | KPI big numbers |
| `metric-sm` | 16 | 500 | ink-primary | normal, tabular-nums | `span` | Inline counts, table totals |
| `link` | inherit | 500 | waves-blue | inherit | `a` | Inline anchors |
| `alert` | inherit | 500 | alert-fg | inherit | `span` | Genuine alerts only (per existing rule) |

## Three rules

1. **Weight does hierarchy, not size.** 400 = content, 500 = structure/emphasis. No bold (already enforced in `tailwind.config.js`: `fontWeight: { normal: '400', medium: '500' }`).
2. **Color does priority, not decoration.** Primary for what you're reading, secondary for context, tertiary for chrome. The existing customer-status color exception (Customers V2) still applies.
3. **Numbers always tabular** so columns align without monospace. Built into `metric` and `metric-sm` via `u-nums`.

## How to use

```jsx
import { Text } from 'components/ui';

<Text role="label">Active Customers</Text>
<Text role="metric">{fmtMoney(value)}</Text>
<Text role="metric" tone="alert">{value}</Text>
<Text role="caption" tone="secondary" className="mt-1">{periodLabel}</Text>

// Override element when semantics demand:
<Text role="h2" as="h3">Section title under an existing h2</Text>

// Inline (default <span>):
<Text role="alert" as="span">{count} failing</Text>
```

Props:
- `role` (required) — picks size/weight/color/tracking/element from the table above
- `as` — override the rendered element
- `tone` — override only the color (`primary | secondary | tertiary | disabled | alert | inherit`)
- `className` — additive Tailwind, applied last; use sparingly (responsive overrides, spacing, narrow exceptions)

## Out of scope

- **H1.** Page titles keep their existing `text-28 font-normal tracking-h1` styling. Adding an `h1` role would invite drift.
- **Tier 2 / legacy `D`-palette pages.** These remain on inline styles + DM Sans. Migration to V2 happens page-by-page on its own PRs.
- **Customer-facing surfaces.** Warm tone, brand fonts (Luckiest Guy / Baloo 2). The admin strategy does not apply.

## Migration path

Page-at-a-time. Each migration is a strict visual-refresh PR (no data, endpoint, or behavior changes), per the existing rule in `CLAUDE.md`.

Migrated:
- `pages/admin/DashboardPageV2.jsx`

Pending: Dispatch, Customers + 360, Estimates + new, Communications, admin shell.
