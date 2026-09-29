// Smallest shared choke point for a control that leaves the WHOLE app —
// sign-out (AdminLayoutV2's handleLogout, shared by the legacy sidebar
// button and AdminWorkspaceNavigation's own Sign out button) is the first
// one — and therefore can't be reached by a page's own in-app guards
// (CustomersPageV2's guardLink/guardHistory/guardNavigateAway, a profile's
// own tab/close guard, …), since those only see popstate and <a href>
// clicks that stay inside the app.
//
// The page with something at stake (today only CustomersPageV2) sets the one
// guard while mounted and clears it on unmount; a control that navigates
// away from everything (never just this page) asks confirmLeaveIfGuarded()
// first. The guard returns true when it's fine to proceed (nothing open, or
// the person just confirmed discarding it) and false to block the leave.
let activeGuard = null;

export function registerLeaveGuard(confirmLeave) {
  activeGuard = confirmLeave;
  // Only clear our own guard: a remount can set the next one before the
  // previous instance's cleanup runs.
  return () => {
    if (activeGuard === confirmLeave) activeGuard = null;
  };
}

export function confirmLeaveIfGuarded() {
  return !activeGuard || activeGuard();
}
