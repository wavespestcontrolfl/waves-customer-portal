// The number on the global Messages icon: conversations with an inbound text
// nobody has read (GET /admin/communications/unread-count — the inbox's own
// per-thread rule, counted server-side). Refreshes on the same bounded
// cadence the notification bell uses, when the tab becomes visible again,
// and immediately when a customer thread is marked read anywhere in the app
// (UNREAD_CHANGED_EVENT). A failed poll keeps the last known number: the
// badge must never blank or inflate because a request dropped.
import { useEffect, useState } from "react";
import { adminFetch } from "../utils/admin-fetch";

export const UNREAD_CHANGED_EVENT = "waves:sms-unread-changed";
const POLL_MS = 30000;

export default function useUnreadConversations(enabled = true) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const load = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const r = await adminFetch("/admin/communications/unread-count");
        if (!cancelled) setCount(Math.max(0, Number(r?.conversations) || 0));
      } catch {
        /* keep the last known count */
      }
    };
    load();
    const timer = setInterval(load, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(UNREAD_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(UNREAD_CHANGED_EVENT, load);
    };
  }, [enabled]);

  return count;
}

export function notifyUnreadChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(UNREAD_CHANGED_EVENT));
}
