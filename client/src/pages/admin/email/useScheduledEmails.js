import { useCallback, useEffect, useRef, useState } from "react";
import { Clock } from "lucide-react";
import { adminFetch } from "./emailApi";

export const LIST_RETRY_MS = 30 * 1000;

// The Email > Scheduled list (GATE_EMAIL_SEND_LATER). `enabled` stays false
// until the server says the gate is on, so the Send arrow and the tab stay
// hidden with the gate off or the list unreadable.
export default function useScheduledEmails(active) {
  const [state, setState] = useState({ enabled: false, emails: [], loading: false, error: false });
  const [pendingId, setPendingId] = useState(null);
  // Reloads can finish out of order: only the newest one publishes.
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++latest.current;
    setState((current) => ({ ...current, loading: true, error: false }));
    try {
      const response = await adminFetch("/api/admin/email/scheduled");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (seq !== latest.current) return;
      setState({ enabled: data.enabled === true, emails: Array.isArray(data.emails) ? data.emails : [], loading: false, error: false });
    } catch {
      if (seq !== latest.current) return;
      // Fail closed: an unverifiable gate hides the arrow and the tab.
      setState((current) => ({ ...current, enabled: false, loading: false, error: true }));
    }
  }, []);

  useEffect(() => {
    if (active) reload();
  }, [active, reload]);

  // A failed list hides the tab and the arrow (fail closed), which also hides
  // its Try again: retry by itself while the page stays open.
  useEffect(() => {
    if (!active || !state.error) return undefined;
    const timer = setTimeout(reload, LIST_RETRY_MS);
    return () => clearTimeout(timer);
  }, [active, state.error, reload]);

  // Cancels on the server, which hands the text back once. Returns the draft,
  // or null with the server's reason. A lost answer is not retried: the
  // server may already have used up the copy, and the list then shows the
  // text read-only (Show text).
  const cancel = async (id) => {
    if (pendingId) return { draft: null };
    setPendingId(id);
    try {
      const response = await adminFetch(`/api/admin/email/scheduled/${encodeURIComponent(id)}/cancel`, { method: "POST" });
      const data = await response.json().catch(() => null);
      if (!data || response.status >= 500 || (response.ok && !data.draft)) throw new Error("Cancel outcome unknown");
      if (!response.ok) return { draft: null, error: data.error || "The scheduled email was not cancelled. Try again." };
      return { draft: data.draft };
    } catch {
      return { draft: null, error: "The cancel was not confirmed. If the email now shows as Cancelled, tap Show text to copy it." };
    } finally {
      setPendingId(null);
      reload();
    }
  };

  const queued = state.emails.filter((row) => row.status === "scheduled").length;
  return { ...state, reload, cancel, pendingId, tabLabel: queued ? `Scheduled (${queued})` : "Scheduled" };
}

// The Email page's view of schedule send: its tab (between Inbox and Blocked,
// only with the gate on), which pane shows, a fresh list on entering
// Scheduled, and the editor extended with the arrow menu's two inputs.
export function useScheduledSection({ active, tab, editor, baseSections }) {
  const scheduled = useScheduledEmails(active);
  const showScheduled = tab === "scheduled" && scheduled.enabled;
  // Scheduled with the gate off falls back to Inbox.
  const pane = tab === "blocked" ? "blocked" : showScheduled ? "scheduled" : "inbox";
  const { reload } = scheduled;
  useEffect(() => { if (showScheduled) reload(); }, [showScheduled, reload]);
  const sections = scheduled.enabled
    ? [baseSections[0], { key: "scheduled", label: scheduled.tabLabel, Icon: Clock }, ...baseSections.slice(1)]
    : baseSections;
  const mailEditor = { ...editor, scheduleEnabled: scheduled.enabled, onScheduled: reload };
  return { scheduled, sections, pane, mailEditor };
}
