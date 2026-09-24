import { useEffect, useRef } from "react";
import { isNativeApp } from "../native/platform";

const DEFAULT_INTERVAL_MS = 30_000;

// Revalidate mounted list views while they are usable. Callers own request
// ordering and decide which local UI state a background refresh may replace.
export default function useVisiblePageRefresh(refresh, { intervalMs = DEFAULT_INTERVAL_MS, enabled = true } = {}) {
  const refreshRef = useRef(refresh);
  const running = useRef(false);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!enabled) return undefined;
    const run = async () => {
      if (document.visibilityState === "hidden" || navigator.onLine === false || running.current) return;
      // Do not interrupt text entry. Filter selects and checkboxes keep focus
      // after a choice, so they must not indefinitely suspend updates.
      // Pages also guard unsaved drafts after focus leaves the editor.
      if (document.activeElement?.matches('textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), [contenteditable]:not([contenteditable="false"])')) return;
      running.current = true;
      try {
        await refreshRef.current?.();
      } catch {
        // The page owns its error and Retry UI; a later cycle can recover.
      } finally {
        running.current = false;
      }
    };
    const resume = () => {
      if (document.visibilityState === "visible") run();
    };
    const restore = (event) => {
      if (event.persisted) run();
    };

    const timer = intervalMs > 0 ? window.setInterval(run, intervalMs) : null;
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", run);
    window.addEventListener("online", run);
    window.addEventListener("pageshow", restore);
    let disposed = false;
    let nativeListener;
    if (isNativeApp()) {
      import("@capacitor/app")
        .then(({ App }) => App.addListener("appStateChange", ({ isActive }) => {
          if (!disposed && isActive) resume();
        }))
        .then((listener) => {
          if (disposed) void listener.remove().catch(() => {});
          else nativeListener = listener;
        })
        .catch(() => {});
    }

    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", run);
      window.removeEventListener("online", run);
      window.removeEventListener("pageshow", restore);
      if (nativeListener) void nativeListener.remove().catch(() => {});
    };
  }, [intervalMs, enabled]);
}
