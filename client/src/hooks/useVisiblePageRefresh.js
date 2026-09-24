import { useEffect, useRef } from "react";

const DEFAULT_INTERVAL_MS = 30_000;

// Revalidate mounted list views while they are usable. Callers own request
// ordering and decide which local UI state a background refresh may replace.
export default function useVisiblePageRefresh(refresh, { intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const run = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void Promise.resolve(refreshRef.current?.()).catch(() => {});
    };
    const resume = () => {
      if (document.visibilityState === "visible") run();
    };
    const restore = (event) => {
      if (event.persisted) run();
    };

    const timer = window.setInterval(run, intervalMs);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", run);
    window.addEventListener("online", run);
    window.addEventListener("pageshow", restore);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", run);
      window.removeEventListener("online", run);
      window.removeEventListener("pageshow", restore);
    };
  }, [intervalMs]);
}
