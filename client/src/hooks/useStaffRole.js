import * as RouterDom from "react-router-dom";
import { getAdminUser } from "../lib/adminAuth";

// Server-verified staff role handed down by AdminLayoutV2 (`user.role`) or
// TechFieldShell (`techRole`) via Outlet context — never trusting a spoofed
// localStorage role when the shell has verified the session. Falls back to the
// cached user ONLY when rendered outside the shell (e.g. isolated unit tests).
export function useStaffRole() {
  let context = null;
  try {
    if (typeof RouterDom.useOutletContext === "function") {
      context = RouterDom.useOutletContext();
    }
  } catch {
    context = null;
  }
  const verified = context?.user?.role || context?.techRole || null;
  if (verified) return verified;
  return getAdminUser()?.role || null;
}

export function useIsStaffAdmin() {
  return useStaffRole() === "admin";
}
