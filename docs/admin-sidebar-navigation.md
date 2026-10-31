# Admin navigation

The grouped sidebar and mobile directory are the admin menu for every login,
filtered by role and the existing feature flags. The older flat sidebar and
the per-user `admin-navigation` flag are gone; saved flag rows are ignored.

The six daily destinations are Dashboard, Schedule, Customers, Sales,
Communications and Billing. Operations, Marketing, Team and Accounting
expand below them; Agent Ops stays direct and Settings stays in the footer.
Every leaf retains its canonical route, individual role requirement and
feature flag. Contracts stays owner-only under Customers; System health
stays owner-only under Settings.

A phone has no side menu and no menu button (owner 2026-10-29). The five
bottom tabs stay, and the Settings tab (`/admin/more`) is the one full menu:
every page that is not one of that login's tabs (an owner, who has no Today
tab, sees Today there), the other pages of a group whose main page is a tab
(Schedule, Customers) as plain rows so no row repeats a tab, the Settings
preferences, and the signed-in account. `MorePage` is a static import, so
this menu opens with no signal like the drawer it replaced.

Parent links open their default page, and a group lists only its other
pages, so no page appears twice (Sales opens Pipeline, Billing opens
Invoices). Adjacent chevrons expand the group. The active page expands its
group when navigation changes; that opening is never saved, and it ends when
navigation leaves the group. Expansion changed by hand is saved on this
browser per verified account. Only known group IDs and booleans are stored,
with a version: groups saved before version 2 (which saved every visited
group as open) are dropped once and pins carry over. Corrupt or unavailable
storage falls back to defaults.
Rendered tab reports keep Pipeline and Estimates selection accurate when
a page consumes or changes its query. Usage tracking retains its existing
source names and authoritative rendered-tab beacons.

Search pages and Cmd/Ctrl+K open the page finder while the flag is enabled.
Results come from the same permitted destination registry, matching current
names, old names (including Tool Health), and
workspace terms. Arrow keys, Home and End move between result links; Enter
in the search field opens the first result. Escape closes search and returns
focus to its trigger. Modified clicks keep ordinary new-tab link behavior.
The mobile finder follows the shell's visible viewport above the keyboard.

Each verified account can pin up to three pages in this browser. Pins appear
in the sidebar and mobile Settings directory and survive reload. Unpinning
frees a slot; invalid IDs are ignored and restricted destinations are hidden.
Pins share the existing account-specific expansion preferences and store only
known destination IDs. Searches are neither stored nor sent to the server or
assistant. Selecting a result retains the existing `palette` usage source;
same-page selections dismiss search.

Ask Waves opens the existing assistant and preserves its unsent question
when switching between modes.
The palette retains the original focus target across mode switches, so
closing the assistant returns to the control that opened page search (on a
phone, the top-bar Search or Ask button).

The implementation retains UI foundation PR #4168's density and shared
controls, the field-recovery ScheduleSaveNotice beside Outlet (#4091), and
the Intelligence Bar page-data provider and opening callback. The page finder
extends GlobalCommandPalette's entry modes and retains the existing assistant
state and request paths.

Verification: `npm run build`; focused client tests for adminNavigation,
AdminWorkspaceNavigation, GlobalCommandPalette, AdminLayoutV2, MorePage and adminUsage; and
`node scripts/qa/admin-navigation.cjs`. The browser script uses the managed
local frontend, synthetic accounts and intercepted APIs. It starts no backend,
runs no migrations, and records screenshots under `.tmp/admin-navigation/`.
