// Smallest shared choke point for a control that leaves the WHOLE app —
// sign-out (AdminLayoutV2's handleLogout, shared by the legacy sidebar
// button and AdminWorkspaceNavigation's own Sign out button) is the first
// one — and therefore can't be reached by a page's own in-app guards
// (CustomersPageV2's guardLink/guardHistory/guardNavigateAway, a profile's
// own tab/close guard, …), since those only see popstate and <a href>
// clicks that stay inside the app.
//
// A page registers a callback while it has something at stake and
// unregisters it on unmount; a control that navigates away from everything
// (never just this page) asks confirmLeaveIfGuarded() first. Each callback
// returns true when it's fine to proceed (nothing open, or the person just
// confirmed discarding it) and false to block the whole leave — the same
// shape as this page's own guardNavigateAway().
const guards = new Set();

export function registerLeaveGuard(confirmLeave) {
  guards.add(confirmLeave);
  return () => guards.delete(confirmLeave);
}

export function confirmLeaveIfGuarded() {
  for (const confirmLeave of guards) {
    if (!confirmLeave()) return false;
  }
  return true;
}
