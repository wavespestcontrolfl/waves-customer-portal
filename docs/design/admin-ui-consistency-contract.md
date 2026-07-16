# Admin UI consistency contract

**Status:** Active for new and migrated `/admin/*` work

**Scope:** Admin shell and admin pages only; customer and technician surfaces keep their own design systems.

**Migration rule:** Apply this contract one page or shared component at a time. Do not run repository-wide style rewrites.

This contract records the admin UI that is actually shipped and supported. Where the older `waves-portal-ui-redesign-spec.md` conflicts with this document, this document governs new admin work. In particular, the shipped admin font is Roboto rather than Inter.

## Safety rules

1. Keep information-architecture, visual, content, and endpoint changes in separate pull requests.
2. A visual migration must preserve data, requests, actions, permissions, URL state, and responsive behavior.
3. Do not mix the Tier-1 component system with a page-local `D` palette in the same file.
4. Do not replace legacy inline styles globally. Move a page only when that page is the declared scope.
5. Keep old URLs as redirects until internal links, alerts, bookmarks, and usage telemetry confirm they can be retired.
6. Shared-shell changes require desktop and mobile verification before page-level migration continues.

## Typography

- **Admin family:** `Roboto, system-ui, sans-serif`.
- **New Tier-1 weights:** 400 for body copy and 500 for emphasis. Existing 600/700 legacy text may remain until its page is migrated.
- **Page title:** 22px / 1.3 / 500.
- **Section title:** 18px / 1.35 / 500.
- **Card title:** 14px / 1.4 / 500.
- **Body:** 13px / 1.5 / 400; use 14px for emphasized or long-form body copy.
- **Caption:** 11px / 1.4 / 400.
- **Form label:** 12px / 1.4 / 500.
- **Buttons, table headers, overlines, and status chips:** 11–12px / 500 / uppercase / `0.06em` tracking.
- **Numbers:** use tabular numerals (`u-nums`) for money, counts, dates, durations, and table metrics.
- Do not introduce a page-specific font stack. Code, IDs, and numeric values remain Roboto on the admin surface so the shell does not visibly switch families.

The admin font is scoped by `.admin-shell-v2` in `client/src/index.css`. Do not add another global font override.

## Page geometry and spacing

The shell owns page-edge spacing. A page must not add a second full-page padding layer.

- **Desktop shell padding:** 28px left/right and 24px top/bottom.
- **Mobile shell padding:** 16px left/right; shell safe-area padding owns the top and bottom clearances.
- **Default page width:** `max-w-[1300px] mx-auto`.
- **Wide data page:** up to `max-w-[1500px] mx-auto` when a table or board materially needs the space.
- **Focused form or article:** 720px maximum content column.
- **Spacing grid:** 4px base. Prefer 4, 8, 12, 16, 20, 24, 32, 40, and 48px.
- **Header-to-content:** 20px (`mb-5`).
- **Section rhythm:** 20–24px.
- **Default grid gap:** 12px; use 8–10px only for compact data controls.
- **Card body:** 16px. Card header/footer: 12px vertical and 16px horizontal.
- **Inline icon/text gap:** 6–8px.

Avoid negative margins and page-specific viewport-width calculations unless the page is an intentional map, calendar, or dispatch-board archetype.

## Surfaces, borders, radius, and color

- The admin shell uses the CSS variables in `theme-square.css` for page chrome.
- Tier-1 page content uses the zinc/ink/surface tokens from Tailwind and `components/ui`.
- Card and panel backgrounds are white on the neutral page surface.
- Default borders are the existing hairline border token.
- Controls use 4px radius; cards, menus, dialogs, and sheets use 6px; 8px is reserved for large hero surfaces.
- Shadows are not decorative. Use borders for separation and focus rings for focus.
- Red is reserved for errors, destructive actions, overdue states, and genuine attention-required alerts.
- Green and amber are semantic status colors, not navigation or decoration.
- One primary action per view; other actions use secondary or ghost treatment.

## Shared component contract

Use the existing Tier-1 primitives instead of restyling local copies:

- Page command header and first-level sections: `AdminCommandHeader`.
- Buttons: `components/ui/Button`.
- Inputs, selects, and textareas: `components/ui` form controls.
- Cards: `Card`, `CardHeader`, `CardBody`, and `CardFooter`.
- Tables: `Table`, `THead`, `TBody`, `TR`, `TH`, and `TD`.
- Secondary in-page tabs: `Tabs` components.
- Overlays: `Dialog` or `Sheet`.

Touch controls must be at least 44px high on mobile. Desktop controls may use the compact sizes already encoded in the shared primitives.

## Navigation and accessibility

- Desktop, mobile tabs, and mobile More navigation must derive from one registry.
- Every destination has one canonical ID, label, route, group, icon, role policy, and search keywords. Surface-specific overrides must be explicit.
- The canonical groups are Overview, Operations, Customers & Sales, Marketing, Team & Automation, Billing & Finance, Resources, and Administration.
- Mobile keeps Dashboard, Schedule, Customers, Messages, and More as the five primary task tabs. More contains every remaining destination under the same canonical groups used on desktop.
- A destination cannot be removed from either surface until usage and replacement-route checks are documented. Retired URLs must redirect during their deprecation window.
- Active navigation uses both a visible state and `aria-current="page"`.
- Navigation landmarks require an accessible label; section labels use real headings.
- Menu buttons expose `aria-expanded` and `aria-controls`.
- Every interactive element has a visible keyboard focus state.
- Icon-only buttons require an accessible name; decorative icons use `aria-hidden`.
- Do not use color as the only indicator of active, failed, overdue, or successful state.
- Preserve 200% browser zoom, text resizing, reduced motion, and horizontal table access.

## Required states

Every migrated page must deliberately render:

- Loading without layout collapse.
- Empty with a plain-language explanation and appropriate next action.
- Error with retry when retry is safe.
- Disabled actions with a reason when the reason is not obvious.
- Partial data without presenting stale or missing metrics as zero.
- Mobile layouts without clipped tabs, off-screen actions, or nested page padding.

## Per-page migration checklist

Before changing a page, record its current routes, query parameters, API requests, actions, role behavior, and mobile layout. After the change, verify:

1. Direct load, refresh, back/forward, and deep links.
2. All reads and mutations use the same endpoints and payloads.
3. Admin, CSR, and technician permissions remain correct.
4. Page title, spacing, cards, forms, tables, tabs, and overlays follow this contract.
5. Keyboard navigation, focus return, accessible names, and active states work.
6. Desktop and mobile layouts work at representative widths.
7. Focused tests and the production build pass.

Legacy cleanup is a later change. Do not delete the previous route or component in the same pull request that introduces its replacement.
