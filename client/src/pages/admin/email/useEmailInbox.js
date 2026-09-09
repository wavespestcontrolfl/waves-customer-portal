import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { adminFetch } from "./emailApi";
import useEmailResource from "./useEmailResource";

const DISCONNECTED = { connected: false };
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
    if (id) next.set("id", id);
    else next.delete("id");
    navigate(
      { pathname: location.pathname, search: `?${next}`, hash: location.hash },
      { replace },
    );
  };

  const params = new URLSearchParams({
    page,
    limit: 50,
    is_archived: showArchived,
  });
  if (filter !== "all") params.set("category", filter);
  if (searchQuery) params.set("search", searchQuery);
  const [status, loadStatus] = useEmailResource(
    "/api/admin/email/oauth/status",
    null,
    DISCONNECTED,
  );
  const [stats, loadStats] = useEmailResource("/api/admin/email/stats");
  const [digest, loadDigest] = useEmailResource(
    "/api/admin/email/daily-digest",
  );
  const [inbox, loadEmails, setInbox] = useEmailResource(
    `/api/admin/email/inbox?${params}`,
    EMPTY_INBOX,
  );
  const [blockedData, loadBlocked, setBlockedData] = useEmailResource(
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
    setConnecting(true);
    try {
      const r = await adminFetch("/api/admin/email/oauth/auth-url");
      const d = await r.json();
      if (!r.ok || !d.url) throw new Error(d.error || `HTTP ${r.status}`);
      window.location.assign(d.url);
    } catch (err) {
      window.alert("Failed to start Gmail connection: " + err.message);
    } finally {
      setConnecting(false);
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
    const activated = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (!active || !status?.connected) return;
    const id = searchParams.get("id");
    if (id && id === selectedIdRef.current && !activated) return;
    if (id !== selectedIdRef.current) {
      if (id) setTab("inbox");
      selectedIdRef.current = null;
      setSelectedEmail(null);
      setThread([]);
      clearDraftResult();
    }
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch(
          `/api/admin/email/message/${encodeURIComponent(id)}`,
        );
        // GET /message/:id already marked it read server-side; hand openEmail
        // the read state so it does not toggle it back (codex P2).
        if (!r.ok) return;
        const email = await r.json();
        if (!cancelled) await openEmail({ ...email, is_read: true });
      } catch {
        /* the inbox still renders */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, status?.connected, searchParams]);

  const loadThread = async (email) => {
    const r = await adminFetch(
      `/api/admin/email/thread/${email.gmail_thread_id}`,
    );
    const d = await r.json();
    if (isSelected(email.id)) setThread(d.thread || []);
  };

  const openEmail = async (email) => {
    selectedIdRef.current = email.id;
    setSelectedEmail(email);
    setThread([]);
    clearDraftResult();
    if (searchParams.get("id") !== email.id) {
      selectMessageId(email.id);
    }
    try {
      if (!email.is_read) {
        await adminFetch(`/api/admin/email/message/${email.id}/read`, {
          method: "POST",
        });
        setEmails((prev) =>
          prev.map((e) => (e.id === email.id ? { ...e, is_read: true } : e)),
        );
        loadStats();
      }
      await loadThread(email);
    } catch {
      /* ignore */
    }
  };

  const closeEmail = (emailId) => {
    selectedIdRef.current = null;
    setSelectedEmail(null);
    setThread([]);
    if (new URLSearchParams(window.location.search).get("id") === emailId)
      selectMessageId(null, true);
  };

  const handleStar = async (event, email) => {
    event.stopPropagation();
    try {
      const response = await adminFetch(
        `/api/admin/email/message/${email.id}/star`,
        { method: "POST" },
      );
      const data = await response.json();
      patchEmail(email.id, { is_starred: data.is_starred });
    } catch {
      /* ignore */
    }
  };

  const removeEmail = async (emailId, action) => {
    try {
      await adminFetch(`/api/admin/email/message/${emailId}/${action}`, {
        method: "POST",
      });
      setEmails((current) => current.filter((email) => email.id !== emailId));
      if (isSelected(emailId)) closeEmail(emailId);
      loadStats();
    } catch {
      /* ignore */
    }
  };

  const handleReclassify = async (emailId) => {
    try {
      const response = await adminFetch(
        `/api/admin/email/message/${emailId}/reclassify`,
        { method: "POST" },
      );
      const data = await response.json();
      patchEmail(emailId, {
        classification: data.classification?.category,
        extracted_data: data.classification,
      });
    } catch {
      /* ignore */
    }
  };

  const handleBlock = async () => {
    const value = blockInput.trim().toLowerCase().replace(/^@/, "");
    if (!value) return;
    const isEmail = value.includes("@");
    if (
      (isEmail && !EMAIL_RE.test(value)) ||
      (!isEmail && !DOMAIN_RE.test(value))
    ) {
      window.alert(
        "Enter a valid email address or domain, like bad@example.com or example.com.",
      );
      return;
    }
    try {
      await adminFetch("/api/admin/email/block", {
        method: "POST",
        body: JSON.stringify({
          email_address: isEmail ? value : null,
          domain: isEmail ? null : value,
          reason: "Manual block from admin portal",
        }),
      });
      setBlockInput("");
      loadBlocked();
    } catch {
      /* ignore */
    }
  };

  const handleUnblock = async (id) => {
    try {
      await adminFetch(`/api/admin/email/blocked/${id}`, { method: "DELETE" });
      setBlocked((prev) => prev.filter((b) => b.id !== id));
    } catch {
      /* ignore */
    }
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
    } catch (err) {
      window.alert("Failed to download attachment: " + err.message);
    }
  };

  // A linked message remains visible even when it is outside the list filter.
  const visibleEmails =
    selectedEmail && !emails.some((email) => email.id === selectedEmail.id)
      ? [selectedEmail, ...emails]
      : emails;

  return {
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
