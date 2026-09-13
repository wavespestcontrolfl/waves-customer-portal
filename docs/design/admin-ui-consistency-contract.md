# Admin UI consistency contract

**Status:** Active for new and migrated `/admin/*` work

**Scope:** Admin shell and admin pages. Customer and technician surfaces keep their own tokens and workflow layouts; sharing primitive behavior does not adopt the admin layout.

**Migration rule:** Apply this contract one page or shared component at a time. Do not run repository-wide style rewrites.

This contract records the admin UI that is actually shipped and supported. Where the older `waves-portal-ui-redesign-spec.md` conflicts with this document, this document governs new admin work. In particular, the shipped admin font is Roboto rather than Inter.

The September 8, 2026 foundation revision promotes the accepted Customer workspace presentation for new and deliberately migrated work. Start those surfaces with `<UiSurface density="comfortable">`. The existing catalog at `/admin/_design-system` demonstrates the controls, behavior, and implementation source. This revision does not globally restyle existing pages. See [the acceptance record](admin-foundation-acceptance-2026-09-08.md) for the original local implementation evidence and its verification limits.

## Explicitly promoted admin scopes

The following scopes use the full shared admin component foundation rather than the older redesign spec's token-only treatment. These entries are additive to previously accepted migrations; they are not an exhaustive route inventory:

- `/admin/service-library`: catalog and service editors, Discounts tools, and the separate mobile service/category screens.
- `/admin/agents`: Triage & Decisions, Shadow Drafts (including voice profiles, sealed exams and pathology review), and Data Hygiene.
- `/admin/lawn-assessments?tab=field`: the assessment hub's field panel, photo/scoring review and turf-profile editor.

These promotions cover presentation and component structure only. Existing data, fields, requests, actions, permissions and approval boundaries remain authoritative. They do not promote any customer-facing report or shared tech-app component. Blog, Reports and Referrals retain their existing scope until explicitly decided separately.

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
- **Record identity:** `ui-record-title`: 29px / 1.25 / 500 on desktop, 23px on phones. This is the Customer workspace's large identity treatment; ordinary page titles remain 22px.
- **Body:** `text-ui-body`, 14px / 1.55 / 400 minimum. Long operational copy may use 15–16px.
- **Caption:** `text-ui-caption`, 14px / 1.55 / 400. Compact density does not reduce the readable-text floor.
- **Form label:** `Field` / `ui-label`, 14px / 1.55 / 500; input, select, and textarea text is 16px.
- **Buttons, table headers, overlines, and status chips:** sentence case, 14px / 500, normal tracking. Do not apply uppercase utilities and reverse them with page CSS.
- **Numbers:** use tabular numerals (`u-nums`) for money, counts, dates, durations, and table metrics.
- Do not introduce a page-specific font stack. Code, IDs, and numeric values remain Roboto on the admin surface so the shell does not visibly switch families.

The admin font is scoped by `.admin-shell-v2` in `client/src/index.css`. Do not add another global font override.

Named preservation exception: unconverted Tier-1 pages and the `customer360=overlay` presentation retain the earlier scale while their migration is out of scope. Shared primitives have a `legacy` fallback for those existing callers; it is not a density choice for new work. The old numeric type utilities remain for those callers. Use semantic `text-ui-*` utilities on migrated content, including content reused inside portals.

## Page geometry and spacing

The shell owns page-edge spacing. A page must not add a second full-page padding layer.

- **Desktop shell padding:** 28px left/right and 24px top/bottom.
- **Mobile shell padding:** 16px left/right; shell safe-area padding owns the top and bottom clearances.
- **Default page width:** `max-w-[1300px] mx-auto`.
- **Wide data page:** up to `max-w-[1500px] mx-auto` when a table or board materially needs the space.
- **Focused form or article:** 720px maximum content column.
- **Record workspace:** may occupy the shell's full content width, with one directory return action, identity/actions, section navigation, and a scrolling record body. Keep customer-specific section order and field layout local.
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
- The named Customers exception retains health-score green/amber/red, metal-colored tier badges, and the existing stage colors. Other admin surfaces use zinc and alert red for genuine alerts.
- One primary action per view; other actions use secondary or ghost treatment.

## Shared component contract

Use the existing Tier-1 primitives instead of restyling local copies:

- Page command header and first-level sections: `AdminCommandHeader`.
- Directory/workspace command presentation: `AdminCommandHeader variant="workspace"`; the existing framed variant stays available to unmigrated pages.
- Surface density: `UiSurface`. Context carries the density through React portals; `Dialog` and `Sheet` also carry its CSS tokens on their portal roots. A custom portal must carry `data-ui-density={useUiDensity()}` on its root.
- Buttons: `Button`; navigation links with the same treatment use `buttonStyles` and keep their native `href` behavior. `ui-record-actions` wraps and spaces header/footer actions; `ui-action-menu` and `ui-menu-action` present existing disclosures without changing their interaction ownership.
- Inputs, selects, and textareas: existing form controls inside `Field` for a visible label and help/error associations. An existing native-input owner such as address autocomplete may use `inputStyles`; it keeps its existing ref, events, and provider behavior.
- Cards: `Card`, `CardHeader`, `CardBody`, and `CardFooter`.
- Tables: `Table`, `THead`, `TBody`, `TR`, `TH`, and `TD`. `Table layout="records"` presents the same semantic rows with visible `TD data-label` captions at widths of 1100px and below. Use the default scrolling layout when columns must remain aligned; sorting, data, permissions, and row actions stay with the caller.
- Secondary in-page tabs: `Tabs`; record sections use `variant="section"` and `TabList scrollable`. Section tabs have 54px targets and reveal the active tab on keyboard selection and resize.
- Overlays: `Dialog` or `Sheet`.
- Feedback: `ActionFeedback` for status, errors, and safe retry. `Button loading` retains its accessible name and reserves spinner space. The caller must guard the action itself against duplicate invocation; a disabled button does not replace that guard.

| Density | Control minimum | Intended use |
| --- | --- | --- |
| `comfortable` (default) | 44px | New admin forms and workspace actions |
| `compact` (explicit exception) | 36px only at 1024px+ with no coarse pointer; 44px below that width or when any pointer is coarse | Dense desktop tools and tables; retain 14px text and 16px field text |
| `touch` | 48px at every width | Field work and deliberately larger primary interactions |

These are Waves usability targets. A touch-capable tablet keeps the larger minimum when a mouse or hardware keyboard is attached. Buttons and fields share the same density rule; the existing legacy `size` prop does not choose density. Global coarse-pointer protection must honor the explicit height token instead of forcing a 48px field back to 44px.

Component classes own presentation. Customer styles may position record sections, contacts, contracts, and domain indicators; they must not resize generic buttons/fields/tables or repair `.text-11`, `.u-label`, `.rounded-sm`, or `.grid` descendants.

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
- Dialog titles register the ID they actually render, including custom IDs. An explicit `aria-label` remains authoritative; every `aria-labelledby` token must resolve.
- Dialog and Sheet own their internal and backdrop clicks. Portaled clicks must not activate a React ancestor. Nested overlays close only the top layer on Escape and restore focus to their opener.
- An overlay trigger focuses itself before opening on click (`event.currentTarget.focus({ preventScroll: true })`), as shown in the catalog. WebKit does not always focus a clicked button; the focus hook otherwise remembers the previously active field instead of the opener. Nested overlays use an explicit higher `layer`.

## Draft and role ownership

`TabPanel` unmounts inactive content by default. Opt a draft form into `keepMounted` only when its workflow needs it; inactive panels are hidden, inert, and outside the keyboard/accessibility flow. Alternatively, lift the draft to its existing controller. Keeping DOM mounted does not provide refresh persistence.

Customer 360 continues to own its recipient, editor, and composer state in the existing controllers. New form workflows must specify their customer/job key, reset boundary, failed-save behavior, and any persistence/recovery promise. Customer or staff/role changes must not expose another record's draft. Restricted panels must not render for the disallowed role; hiding them is not authorization.

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
8. Computed button/input/select sizes at 390, 700, 820, 1024, and 1440px, with fine/coarse pointers, portrait/landscape, and contracted keyboard viewport cases. Run `node scripts/qa/design-system.cjs` for the synthetic catalog checks; it uses the existing local frontend runner and never connects to the backend.
9. Record screenshot paths, exact checked commit/state, CI when applicable, and physical-device checks separately. Emulated viewport contraction is not an installed-iPhone keyboard/safe-area test.

Legacy cleanup is a later change. Do not delete the previous route or component in the same pull request that introduces its replacement.
