import { useCallback, useEffect, useRef, useState } from "react";
import { Clock } from "lucide-react";
import { adminFetch } from "./emailApi";

// Cancelled emails already back in the composer whose "restored" mark the
// server has not confirmed. They stay hidden here, and every reload sends the
// mark again, so Open as draft can never bring the same text back twice.
// Kept per signed-in user, and removed with the drafts at sign-out
// (clearEmailDrafts), so another user never marks a row they do not hold.
export const LIST_RETRY_MS = 30 * 1000;

const pendingKey = (userId) => `waves_email_restored_pending:${userId}`;
function readPending(userId) {
  try {
    const ids = JSON.parse(sessionStorage.getItem(pendingKey(userId)) || "[]");
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
  } catch { return new Set(); }
}
// Returns false when the tab could not save the set.
function savePending(userId, ids) {
  try {
    sessionStorage.setItem(pendingKey(userId), JSON.stringify([...ids]));
    return true;
  } catch { return false; }
}
async function sendRestoredMark(id) {
  try {
    const response = await adminFetch(`/api/admin/email/scheduled/${encodeURIComponent(id)}/restored`, { method: "POST" });
    return response.ok;
  } catch { return false; }
}

// Per scheduled email, the key this tab claims its text with on Cancel send.
// Kept in sessionStorage so a retry after a lost answer, even after a reload,
// sends the same key and gets the draft; another tab's key gets 409.
const restoreKeysKey = (userId) => `waves_email_restore_keys:${userId}`;
function restoreKeyFor(userId, id) {
  let keys = {};
  try { keys = JSON.parse(sessionStorage.getItem(restoreKeysKey(userId)) || "{}") || {}; } catch { keys = {}; }
  if (typeof keys[id] === "string") return keys[id];
  const key = crypto.randomUUID();
  try {
    sessionStorage.setItem(restoreKeysKey(userId), JSON.stringify({ ...keys, [id]: key }));
    return key;
  } catch { return null; }
}

// Rows this tab took over from another tab's claim (Open here anyway), saved
// before the request: any draft this tab later gets for such a row, on a
// retry or after a reload, keeps the takenOver guard. Kept per user, like
// the restore keys.
const takeoversKey = (userId) => `waves_email_takeovers:${userId}`;
function readTakeovers(userId) {
  try { return new Set(JSON.parse(sessionStorage.getItem(takeoversKey(userId)) || "[]")); } catch { return new Set(); }
}
function rememberTakeover(userId, id) {
  try {
    sessionStorage.setItem(takeoversKey(userId), JSON.stringify([...readTakeovers(userId), id]));
    return true;
  } catch { return false; }
}

// The Email > Scheduled list (GATE_EMAIL_SEND_LATER). `enabled` stays false
// until the server says the gate is on, so the Send arrow and the tab stay
// hidden with the gate off or the list unreadable.
export default function useScheduledEmails(active, userId) {
  const [state, setState] = useState({ enabled: false, emails: [], loading: false, error: false });
  const [pendingId, setPendingId] = useState(null);
  // Reloads can finish out of order: only the newest one publishes.
  const latest = useRef(0);
  const pendingRestored = useRef(null);
  if (pendingRestored.current === null) pendingRestored.current = readPending(userId);

  // Sends every unconfirmed mark again; a confirmed one leaves the set.
  const flushRestored = useCallback(async () => {
    const pending = pendingRestored.current;
    if (!pending.size) return;
    const done = await Promise.all([...pending].map(async (id) => ((await sendRestoredMark(id)) ? id : null)));
    done.filter(Boolean).forEach((id) => pending.delete(id));
    savePending(userId, pending);
  }, [userId]);

  const reload = useCallback(async () => {
    const seq = ++latest.current;
    setState((current) => ({ ...current, loading: true, error: false }));
    await flushRestored();
    try {
      const response = await adminFetch("/api/admin/email/scheduled");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (seq !== latest.current) return;
      const emails = (Array.isArray(data.emails) ? data.emails : [])
        .filter((row) => !(row.status === "cancelled" && pendingRestored.current.has(row.id)));
      setState({ enabled: data.enabled === true, emails, loading: false, error: false });
    } catch {
      if (seq !== latest.current) return;
      // Fail closed: an unverifiable gate hides the arrow and the tab.
      setState((current) => ({ ...current, enabled: false, loading: false, error: true }));
    }
  }, [flushRestored]);

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

  // Cancels on the server, then hands the email back for the composer.
  // Returns the draft, or null with the server's reason.
  const cancel = async (id, { takeover = false } = {}) => {
    if (pendingId) return { draft: null };
    // Without a saved key a lost answer could not be recovered: do not start.
    const restoreKey = restoreKeyFor(userId, id);
    if (!restoreKey || (takeover && !rememberTakeover(userId, id))) return { draft: null, error: "Cancel did not start: this browser could not save its safety key." };
    setPendingId(id);
    try {
      const response = await adminFetch(`/api/admin/email/scheduled/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify({ restoreKey, ...(takeover ? { takeover } : {}) }) });
      const data = await response.json().catch(() => null);
      // No readable answer, or a server error: the cancel may have happened.
      if (!data || response.status >= 500 || (response.ok && !data.draft)) throw new Error("Cancel outcome unknown");
      if (!response.ok) return { draft: null, error: data.error || "The scheduled email was not cancelled. Try again.", claimedElsewhere: data.claimedElsewhere === true };
      return { draft: readTakeovers(userId).has(id) ? { ...data.draft, takenOver: true } : data.draft };
    } catch {
      // The server may have cancelled it; a repeated cancel returns the same
      // draft, so the caller offers Try again on this row.
      return { draft: null, retryable: true, error: "The cancel was not confirmed. Tap Try again to get the draft back." };
    } finally {
      setPendingId(null);
      reload();
    }
  };

  // The cancelled email is back in the composer: hide it at once and tell the
  // server, which drops it from the list. An unconfirmed mark is retried on
  // every reload (see PENDING_KEY).
  // Resolves true once the mark is durable: saved in this tab (retried on
  // every reload) or confirmed by the server. Neither means a reload could
  // offer the same text again, so the caller takes the draft back.
  const markRestored = async (id) => {
    const pending = pendingRestored.current;
    pending.add(id);
    let durable = savePending(userId, pending);
    if (!durable) {
      durable = await sendRestoredMark(id);
      if (!durable) pending.delete(id);
    }
    reload();
    return durable;
  };

  const queued = state.emails.filter((row) => row.status === "scheduled").length;
  return { ...state, reload, cancel, markRestored, pendingId, tabLabel: queued ? `Scheduled (${queued})` : "Scheduled" };
}

// The Email page's view of schedule send: its tab (between Inbox and Blocked,
// only with the gate on), which pane shows, a fresh list on entering
// Scheduled, and the editor extended with the arrow menu's two inputs.
export function useScheduledSection({ active, tab, editor, baseSections, userId }) {
  const scheduled = useScheduledEmails(active, userId);
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
