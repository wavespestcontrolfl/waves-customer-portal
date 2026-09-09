import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { adminFetch } from "./emailApi";
import useEmailResource from "./useEmailResource";

const EMPTY_INBOX = { emails: [], total: 0 };
const EMPTY_BLOCKED = { blocked: [] };
const SEARCH_DEBOUNCE_MS = 300;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i;

export default function useEmailInbox(active, clearDraftResult) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  // The inbox request follows the search box after a pause, the way the
  // SMS and call searches do, instead of one request per keystroke. The
  // page resets in the same commit as the query, so the list never asks
  // for page 1 of the old query while the pause runs.
  const [searchQuery, setSearchQuery] = useState("");
  useEffect(() => {
    if (search === searchQuery) return undefined;
    const timer = setTimeout(() => {
      setSearchQuery(search);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, searchQuery]);
  const [showArchived, setShowArchived] = useState(false);
  const [tab, setTab] = useState("inbox");
  const [blockInput, setBlockInput] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [thread, setThread] = useState([]);
  const selectedIdRef = useRef(null);
  const messageSequenceRef = useRef(0);
  const threadSequenceRef = useRef(0);
  const [threadState, setThreadState] = useState({ loading: false, error: false });
  const [messageState, setMessageState] = useState({ loading: false, error: false });
  const [selectionRetry, setSelectionRetry] = useState(0);
  const selectionRetryRef = useRef(0);
  const [actionFeedback, setActionFeedback] = useState(null);
  const [pendingAction, setPendingAction] = useState(null);
  const pendingActionRef = useRef(null);
  const beginAction = (key) => {
    if (pendingActionRef.current) return false;
    pendingActionRef.current = key;
    setPendingAction(key);
    setActionFeedback(null);
    return true;
  };
  const finishAction = () => {
    pendingActionRef.current = null;
    setPendingAction(null);
  };
  const wasActiveRef = useRef(false);
  selectedIdRef.current = selectedEmail?.id;
  useEffect(
    () => () => {
      selectedIdRef.current = null;
    },
    [],
  );
  const isSelected = useCallback((id) => selectedIdRef.current === id, []);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const selectMessageId = (id, replace = false) => {
    const location = window.location;
    if (location.pathname.replace(/\/+$/, "") !== "/admin/communications")
      return;
    const next = new URLSearchParams(location.search);
    const entry = window.history.state;
    // Keep the original inbox entry across message selection and reloads.
    const inboxIndex = next.get("id") ? entry?.usr?.emailInboxIndex : entry?.idx;
    if (id) next.set("id", id);
    else next.delete("id");
    navigate(
      { pathname: location.pathname, search: `?${next}`, hash: location.hash },
      { replace, state: { emailInboxIndex: id ? inboxIndex : null } },
    );
  };

  const params = new URLSearchParams({
    page,
    limit: 50,
    is_archived: showArchived,
  });
  if (filter !== "all") params.set("category", filter);
  if (searchQuery) params.set("search", searchQuery);
  const [status, loadStatus, , statusState] = useEmailResource(
    "/api/admin/email/oauth/status",
    null,
  );
  const [stats, loadStats, , statsState] = useEmailResource("/api/admin/email/stats");
  const [digest, loadDigest, , digestState] = useEmailResource(
    "/api/admin/email/daily-digest",
  );
  const [inbox, loadEmails, setInbox, inboxState] = useEmailResource(
    `/api/admin/email/inbox?${params}`,
    EMPTY_INBOX,
  );
  const [blockedData, loadBlocked, setBlockedData, blockedState] = useEmailResource(
    "/api/admin/email/blocked",
    EMPTY_BLOCKED,
  );
  const emails = inbox.emails || [];
  const total = inbox.total || 0;
  const blocked = blockedData.blocked || [];
  const setEmails = (update) =>
    setInbox((current) => ({
      ...current,
      emails: update(current.emails || []),
    }));
  const setBlocked = (update) =>
    setBlockedData((current) => ({
      ...current,
      blocked: update(current.blocked || []),
    }));
  const patchEmail = (id, patch) => {
    setEmails((current) =>
      current.map((email) =>
        email.id === id ? { ...email, ...patch } : email,
      ),
    );
    setSelectedEmail((current) =>
      current?.id === id ? { ...current, ...patch } : current,
    );
  };

  const handleConnectGmail = async () => {
    if (!beginAction("connect")) return;
    setConnecting(true);
    try {
      const r = await adminFetch("/api/admin/email/oauth/auth-url");
      const d = await r.json();
      if (!r.ok || !d.url) throw new Error(d.error || `HTTP ${r.status}`);
      window.location.assign(d.url);
    } catch {
      setActionFeedback({ error: true, message: "Could not start the Gmail connection. Try Connect Gmail again." });
    } finally {
      setConnecting(false);
      finishAction();
    }
  };

  useEffect(() => {
    if (active) loadStatus();
  }, [active, loadStatus]);
  useEffect(() => {
    if (active && status?.connected) loadEmails();
  }, [active, status?.connected, loadEmails]);
  // Stats and the digest do not follow the list's filters; a search or
  // page change reloads the list alone.
  useEffect(() => {
    if (active && status?.connected) {
      loadStats();
      loadDigest();
    }
  }, [active, status?.connected, loadStats, loadDigest]);
  useEffect(() => {
    if (active && tab === "blocked") loadBlocked();
  }, [active, tab, loadBlocked]);

  // Old bells/OAuth returns keep working through /admin/email's alias.
  // Observe query changes as well as mount so Back/Forward can select mail.
  useEffect(() => {
    const retrying = selectionRetry !== selectionRetryRef.current;
    selectionRetryRef.current = selectionRetry;
    const activated = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (!active || !status?.connected) return;
    const id = searchParams.get("id");
    if (id && id === selectedIdRef.current && !activated && !retrying) return;
    if (id !== selectedIdRef.current) {
      if (id) setTab("inbox");
      selectedIdRef.current = null;
      setSelectedEmail(null);
      setThread([]);
      setThreadState({ loading: false, error: false });
      clearDraftResult();
    }
    if (!id) { setMessageState({ loading: false, error: false }); return; }
    let cancelled = false;
    const request = ++messageSequenceRef.current;
    setMessageState({ loading: true, error: false });
    (async () => {
      try {
        const r = await adminFetch(
          `/api/admin/email/message/${encodeURIComponent(id)}`,
        );
        // GET /message/:id already marked it read server-side; hand openEmail
        // the read state so it does not toggle it back (codex P2).
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const email = await r.json();
        if (!cancelled && request === messageSequenceRef.current) await openEmail({ ...email, is_read: true });
      } catch {
        if (!cancelled && request === messageSequenceRef.current) setMessageState({ loading: false, error: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, status?.connected, searchParams, selectionRetry]);

  const loadThread = async (email) => {
    // A completed send/read for an earlier email must not supersede the
    // current conversation's request or leave its loading state unresolved.
    if (!isSelected(email.id)) return;
    const request = ++threadSequenceRef.current;
    setThreadState({ loading: true, error: false });
    try {
      const response = await adminFetch(
        `/api/admin/email/thread/${email.gmail_thread_id}`,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (isSelected(email.id) && request === threadSequenceRef.current) {
        setThread(data.thread || []);
        setThreadState({ loading: false, error: false });
      }
    } catch {
      if (isSelected(email.id) && request === threadSequenceRef.current)
        setThreadState({ loading: false, error: true });
    }
  };

  const openEmail = async (email) => {
    messageSequenceRef.current += 1;
    setMessageState({ loading: false, error: false });
    selectedIdRef.current = email.id;
    setSelectedEmail(email);
    setThread([]);
    setThreadState({ loading: true, error: false });
    clearDraftResult();
    if (searchParams.get("id") !== email.id) selectMessageId(email.id);
    if (!email.is_read) {
      try {
        const response = await adminFetch(`/api/admin/email/message/${email.id}/read`, {
          method: "POST",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        patchEmail(email.id, { is_read: true });
        loadStats();
      } catch {
        if (isSelected(email.id)) setActionFeedback({ error: true, message: "The email could not be marked as read." });
      }
    }
    await loadThread(email);
  };

  const closeEmail = (emailId, returnToInbox = false) => {
    messageSequenceRef.current += 1;
    setMessageState({ loading: false, error: false });
    const selectedInUrl = new URLSearchParams(window.location.search).get("id") === emailId;
    const entry = window.history.state, inboxIndex = entry?.usr?.emailInboxIndex;
    if (returnToInbox && selectedInUrl && Number.isInteger(inboxIndex) && Number.isInteger(entry?.idx) && inboxIndex < entry.idx) {
      navigate(inboxIndex - entry.idx);
      return;
    }
    selectedIdRef.current = null;
    setSelectedEmail(null);
    setThread([]);
    if (selectedInUrl) selectMessageId(null, true);
  };

  const handleStar = async (event, email) => {
    event.stopPropagation();
    if (!beginAction(`star:${email.id}`)) return;
    try {
      const response = await adminFetch(
        `/api/admin/email/message/${email.id}/star`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      patchEmail(email.id, { is_starred: data.is_starred });
      setActionFeedback({ message: data.is_starred ? "Email starred." : "Star removed." });
    } catch {
      setActionFeedback({ error: true, message: "Could not update the star. Try again." });
    } finally { finishAction(); }
  };

  const removeEmail = async (emailId, action) => {
    if (!beginAction(`${action}:${emailId}`)) return;
    try {
      const response = await adminFetch(`/api/admin/email/message/${emailId}/${action}`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setEmails((current) => current.filter((email) => email.id !== emailId));
      if (isSelected(emailId)) closeEmail(emailId);
      loadStats();
      setActionFeedback({ message: action === "archive" ? "Email archived." : "Email moved to trash." });
    } catch {
      setActionFeedback({ error: true, message: action === "archive" ? "Could not archive the email. Try again." : "Could not move the email to trash. Try again." });
    } finally { finishAction(); }
  };

  const handleReclassify = async (emailId) => {
    if (!beginAction(`reclassify:${emailId}`)) return;
    try {
      const response = await adminFetch(
        `/api/admin/email/message/${emailId}/reclassify`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      patchEmail(emailId, { classification: data.classification?.category, extracted_data: data.classification });
      setActionFeedback({ message: "Email reclassified." });
    } catch {
      setActionFeedback({ error: true, message: "Could not reclassify the email. Try again." });
    } finally { finishAction(); }
  };

  const handleBlock = async () => {
    const value = blockInput.trim().toLowerCase().replace(/^@/, "");
    if (!value) return;
    const isEmail = value.includes("@");
    if (
      (isEmail && !EMAIL_RE.test(value)) ||
      (!isEmail && !DOMAIN_RE.test(value))
    ) {
      setActionFeedback({ error: true, message: "Enter a valid email address or domain, like bad@example.com or example.com." });
      return;
    }
    if (!beginAction("block")) return;
    try {
      const response = await adminFetch("/api/admin/email/block", {
        method: "POST",
        body: JSON.stringify({
          email_address: isEmail ? value : null,
          domain: isEmail ? null : value,
          reason: "Manual block from admin portal",
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setBlockInput("");
      loadBlocked();
      setActionFeedback({ error: Boolean(data.warning), message: data.warning || "Sender blocked." });
    } catch {
      setActionFeedback({ error: true, message: "Could not block the sender. Try again." });
    } finally { finishAction(); }
  };

  const handleUnblock = async (id) => {
    if (!beginAction(`unblock:${id}`)) return;
    try {
      const response = await adminFetch(`/api/admin/email/blocked/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setBlocked((current) => current.filter((entry) => entry.id !== id));
      setActionFeedback({ message: "Sender unblocked." });
    } catch {
      setActionFeedback({ error: true, message: "Could not unblock the sender. Try again." });
    } finally { finishAction(); }
  };

  const handleDownloadAttachment = async (event, msg, att) => {
    event.preventDefault();
    try {
      const r = await adminFetch(
        `/api/admin/email/message/${msg.id}/attachment/${att.gmail_attachment_id}`,
        {
          skipContentType: true,
        },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = att.filename || "attachment";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setActionFeedback({ error: true, message: "Could not download the attachment. Try again." });
    }
  };

  // A linked message remains visible even when it is outside the list filter.
  const visibleEmails =
    selectedEmail && !emails.some((email) => email.id === selectedEmail.id)
      ? [selectedEmail, ...emails]
      : emails;

  return {
    statusState, inboxState, statsState, digestState, blockedState, threadState, messageState,
    actionFeedback, pendingAction,
    loadStatus, loadEmails, loadBlocked, loadDigest,
    retrySelection: () => setSelectionRetry((current) => current + 1),
    status,
    stats,
    digest,
    total,
    visibleEmails,
    filter,
    setFilter,
    search,
    setSearch,
    page,
    setPage,
    showArchived,
    setShowArchived,
    tab,
    setTab,
    blocked,
    blockInput,
    setBlockInput,
    connecting,
    handleConnectGmail,
    selectedEmail,
    thread,
    openEmail,
    closeEmail,
    handleStar,
    removeEmail,
    handleReclassify,
    handleBlock,
    handleUnblock,
    handleDownloadAttachment,
    loadStats,
    loadThread,
    isSelected,
  };
}
