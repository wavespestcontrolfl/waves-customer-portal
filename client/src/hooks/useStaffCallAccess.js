import { useOutletContext } from "react-router-dom";

// Customer calls are admin-only (owner 2026-10-02): a technician login gets
// no Calls tab, no call audio or transcript, and no "Open call" link. The
// server enforces it (requireAdmin); this only keeps a technician from being
// shown controls that can only 403.
//
// The role is the SERVER-returned one the admin shell hands down through its
// Outlet context. The Today workspace (TechFieldShell) re-provides the context
// with the same role as `techRole` and no `user`, so the hook reads both: a
// technician under /admin/today is refused the bridge like one under the rest
// of the shell. Outside the shell (a unit test) the role is unknown and this
// returns true: callers that always render for a technician pass their own
// explicit flag instead.
export function useCanAccessCalls() {
  const context = useOutletContext();
  const role = context?.user?.role || context?.techRole;
  return !role || role === "admin";
}
