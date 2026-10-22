import { useCallback, useEffect, useRef, useState } from "react";
import { Clock } from "lucide-react";
import { adminFetch } from "./emailApi";

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

  // Cancels on the server, then hands the email back for the composer.
  // Returns the draft, or null with the server's reason.
  const cancel = async (id) => {
    if (pendingId) return { draft: null };
    setPendingId(id);
    try {
      const response = await adminFetch(`/api/admin/email/scheduled/${encodeURIComponent(id)}/cancel`, { method: "POST" });
      const data = await response.json().catch(() => null);
      // No readable answer, or a server error: the cancel may have happened.
      if (!data || response.status >= 500 || (response.ok && !data.draft)) throw new Error("Cancel outcome unknown");
      if (!response.ok) return { draft: null, error: data.error || "The scheduled email was not cancelled. Try again." };
      return { draft: data.draft };
    } catch {
      // The server may have cancelled it; a repeated cancel returns the same
      // draft, so the caller offers Try again on this row.
      return { draft: null, retryable: true, error: "The cancel was not confirmed. Tap Try again to get the draft back." };
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
export function useScheduledSection({ active, connected, tab, editor, baseSections }) {
  const scheduled = useScheduledEmails(active && connected);
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
