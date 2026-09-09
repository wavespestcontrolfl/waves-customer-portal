# Admin navigation

The `admin-navigation` per-user flag enables the grouped sidebar and mobile
directory. It defaults off and uses the existing `/admin/feature-flags`
mechanism. Assign it through Early feature access, then reload the session.
Disable it and reload to restore the existing navigation. No flags are
enabled by this change.

The six daily destinations are Dashboard, Schedule, Customers, Sales,
Communications and Billing. Operations, Marketing, Team and Accounting
expand below them; Agent Ops stays direct and Settings stays in the footer.
Every leaf retains its canonical route, individual role requirement and
feature flag. Contracts stays owner-only under Customers; System health
stays owner-only under Settings. Mobile keeps its five existing tabs and
all the Settings preferences, with the same workspace destinations.

Parent links open their default page; adjacent chevrons expand the group.
The active page expands its group when navigation changes. Manual expansion
is saved on this browser per verified account. Only known group IDs and
booleans are stored; corrupt or unavailable storage falls back to defaults.
Rendered tab reports keep Pipeline and Estimates selection accurate when
a page consumes or changes its query. Usage tracking retains its existing
source names and authoritative rendered-tab beacons.

Search pages and Cmd/Ctrl+K open the page finder while the flag is enabled.
Results come from the same permitted destination registry, matching current
names, old names (including Recovery, Payers, Taxes and Tool Health), and
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
same-page selections dismiss both search and an open mobile menu.

Ask Waves opens the existing assistant and preserves its unsent question
when switching between modes. It also closes the originating mobile menu.
Closing the assistant returns focus to the persistent Open menu button when
it was opened from that menu, directly or through page search.
With the flag off, Cmd/Ctrl+K continues opening the assistant directly.

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
