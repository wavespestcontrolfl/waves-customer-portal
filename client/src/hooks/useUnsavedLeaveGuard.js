import { useEffect } from "react";
import { registerLeaveGuard } from "../lib/navigation-guard";

// Guards an editor with unsaved state across all four departure channels:
// tab close / reload (beforeunload), app-wide sign-out (registerLeaveGuard),
// in-app anchor clicks (document click capture), and browser Back/Forward
// (popstate capture using BrowserRouter's history.state.idx).
export function useUnsavedLeaveGuard(dirty, message = "Leave with unsaved changes?") {
  useEffect(() => {
    if (!dirty) return undefined;
    const confirmLeave = () => window.confirm(message);
    const beforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const guardLink = (event) => {
      const link = event.target.closest?.("a[href]");
      if (!link || link.target === "_blank" || event.metaKey || event.ctrlKey || link.hash) return;
      if (!confirmLeave()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const entryIndex = window.history.state?.idx;
    let restoring = false;
    const guardHistory = (event) => {
      if (restoring) {
        restoring = false;
        event.stopImmediatePropagation();
        return;
      }
      const nextIndex = event.state?.idx;
      if (!Number.isInteger(entryIndex) || !Number.isInteger(nextIndex) || entryIndex === nextIndex) return;
      if (confirmLeave()) return;
      event.stopImmediatePropagation();
      restoring = true;
      window.history.go(entryIndex - nextIndex);
    };
    window.addEventListener("popstate", guardHistory, true);
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", guardLink, true);
    const unregister = registerLeaveGuard(confirmLeave);
    return () => {
      window.removeEventListener("popstate", guardHistory, true);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", guardLink, true);
      unregister();
    };
  }, [dirty, message]);
}
