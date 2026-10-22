import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "./emailApi";

// The Email > Scheduled list (GATE_EMAIL_SEND_LATER). `enabled` stays false
// until the server says the gate is on, so the Send arrow and the tab stay
// hidden with the gate off or the list unreadable.
export default function useScheduledEmails(active) {
  const [state, setState] = useState({ enabled: false, emails: [], loading: false, error: false });
  const [pendingId, setPendingId] = useState(null);

  const reload = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: false }));
    try {
      const response = await adminFetch("/api/admin/email/scheduled");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setState({ enabled: data.enabled === true, emails: Array.isArray(data.emails) ? data.emails : [], loading: false, error: false });
    } catch {
      setState((current) => ({ ...current, loading: false, error: true }));
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
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.draft) return { draft: null, error: data.error || "The scheduled email was not cancelled. Try again." };
      return { draft: data.draft };
    } catch {
      return { draft: null, error: "The cancel was not confirmed. Reload Scheduled before you try again." };
    } finally {
      setPendingId(null);
      reload();
    }
  };

  const queued = state.emails.filter((row) => row.status === "scheduled").length;
  return { ...state, reload, cancel, pendingId, tabLabel: queued ? `Scheduled (${queued})` : "Scheduled" };
}
