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

The implementation is stacked on UI foundation PR #4168. Keep its density
and shared control changes when integrating. The open field-recovery PR
#4091 also touches the shell: preserve its ScheduleSaveNotice beside Outlet.
The Intelligence Bar stack's page-data provider and opening callback must
also survive integration; this phase leaves the palette implementation alone.

Verification: `npm run build`; focused client tests for adminNavigation,
AdminWorkspaceNavigation, AdminLayoutV2, MorePage and adminUsage; and
`node scripts/qa/admin-navigation.cjs`. The browser script uses the managed
local frontend, synthetic accounts and intercepted APIs. It starts no backend,
runs no migrations, and records screenshots under `.tmp/admin-navigation/`.
