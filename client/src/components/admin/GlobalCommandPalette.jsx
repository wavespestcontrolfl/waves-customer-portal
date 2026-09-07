import { useIntelligenceBarPageData } from '../../hooks/useIntelligenceBarPageData';
/**
 * Global Command Palette (⌘K / mobile bottom sheet)
 * client/src/components/admin/GlobalCommandPalette.jsx
 *
 * Desktop: centered modal triggered by ⌘K / Ctrl+K from any admin page.
 * Mobile:  full-height bottom sheet triggered by the Sparkles button in
 *          the admin shell's top bar. Also opens via ⌘K if a keyboard
 *          is attached.
 *
 * Auto-detects which page you're on and loads the right context/tools.
 * Recent prompts (last 5) surfaced at the top on mobile for fast re-run.
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";
import { useLocation } from "react-router-dom";
import useIsMobile from "../../hooks/useIsMobile";
import useModalFocus from "../../hooks/useModalFocus";
import DictationButton from "../tech/DictationButton";
import PendingActionsCard from "./PendingActionsCard";
import IntelligenceTaskCard from "./IntelligenceTaskCard";
import { ibSessionId } from "../../utils/ibSession";
import ToolActivityList from "./ToolActivityList";
import { filesToImageParts, MAX_ATTACHMENTS } from "../../utils/ibImages";
import { formatETDateTime } from "../../lib/timezone";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const RECENTS_KEY = "admin_ib_recents";
// Thread id the operator dismissed with "New chat" — a reload must not
// resume it (it stays on the server for history/retention, just not as the
// auto-resumed conversation). Keyed per admin account so staff sharing a
// browser can't clear or resurrect each other's dismissal.
const DISMISSED_THREAD_KEY = "admin_ib_dismissed_thread";
function dismissedThreadKey() {
  let uid = "";
  try {
    uid = JSON.parse(localStorage.getItem("waves_admin_user") || "null")?.id || "";
  } catch { /* storage unavailable */ }
  return uid ? `${DISMISSED_THREAD_KEY}:${uid}` : DISMISSED_THREAD_KEY;
}
const RECENTS_MAX = 5;
const D = {
  bg: "#F1F5F9",
  card: "#FFFFFF",
  border: "#E2E8F0",
  teal: "#0A7EC2",
  green: "#16A34A",
  amber: "#F0A500",
  red: "#C0392B",
  purple: "#7C3AED",
  text: "#334155",
  muted: "#64748B",
  white: "#fff",
};

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then(async (r) => {
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      const err = new Error(body.message || body.error || `HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  });
}

// ─── Route → Context mapping ────────────────────────────────────
const ROUTE_CONTEXT_MAP = {
  "/admin/schedule": "schedule",
  "/admin/dispatch": "dispatch",
  "/admin/dashboard": "dashboard",
  "/admin": "dashboard",
  "/admin/customers": "customers",
  "/admin/pipeline": "leads",
  "/admin/estimates": "estimates",
  "/admin/seo": "seo",
  "/admin/blog": "seo",
  "/admin/ppc": "seo",
  "/admin/social-media": "seo",
  "/admin/inventory": "procurement",
  "/admin/revenue": "revenue",
  "/admin/invoices": "revenue",
  "/admin/tax": "tax",
  "/admin/reviews": "reviews",
  "/admin/referrals": "reviews",
  "/admin/communications": "comms",
  "/admin/email": "email",
  "/admin/banking": "banking",
  "/admin/pricing-logic": "revenue",
};

const CONTEXT_LABELS = {
  schedule: "Schedule & Dispatch",
  dispatch: "Dispatch",
  dashboard: "Dashboard",
  customers: "Customers",
  seo: "SEO & Content",
  blog: "Blog",
  procurement: "Procurement",
  revenue: "Revenue",
  reviews: "Reviews & Reputation",
  comms: "Communications",
  tax: "Taxes",
  leads: "Pipeline",
  email: "Email",
  banking: "Banking & Cash Flow",
  estimates: "Estimates & Quoting Agent",
};

const CONTEXT_COLORS = {
  schedule: D.teal,
  dispatch: D.teal,
  dashboard: D.teal,
  customers: D.teal,
  seo: D.teal,
  blog: D.teal,
  procurement: D.purple,
  revenue: D.green,
  reviews: D.amber,
  comms: "#3b82f6",
  tax: D.purple,
  leads: D.amber,
  email: D.green,
  banking: D.green,
  estimates: D.teal,
};

function detectContext(pathname, search = "", hash = "", user) {
  if (pathname.replace(/\/+$/, "") === "/admin/communications" && user?.role === "admin"
    && new URLSearchParams(hash.replace(/^#/, "")).get("tab") === "email") return "email";
  // /admin/pipeline hosts both the Leads pipeline and the consolidated
  // Estimates workspace (the old /admin/estimates now redirects here with
  // ?tab=…), so pathname alone can't pick the context — the tab query
  // decides. Estimates / Create Estimate / Pricing Logic keep the
  // quote-agent tools; Leads (or no tab) keeps lead quick actions. An
  // ?estimateId= deep link with no tab lands on the Estimates list
  // (EstimatesPageV2 initialTab), so it maps to estimates too.
  if (pathname === "/admin/pipeline" || pathname.startsWith("/admin/pipeline/")) {
    const params = new URLSearchParams(search);
    const tab = params.get("tab");
    if (["estimates", "new", "pricing"].includes(tab)) {
      return "estimates";
    }
    if (!tab && params.get("estimateId")) return "estimates";
    return "leads";
  }
  if (ROUTE_CONTEXT_MAP[pathname]) return ROUTE_CONTEXT_MAP[pathname];
  const routes = Object.entries(ROUTE_CONTEXT_MAP).filter(([route]) => route !== "/admin").sort(
    (a, b) => b[0].length - a[0].length,
  );
  // The exact "/admin" catch-all must not shadow the role-aware fallback
  // below — for a technician it would map every unmapped page (Settings,
  // Reports, Equipment, Knowledge, Staff) to `dashboard`, which the IB
  // rejects for that role (codex P2).
  for (const [route, ctx] of routes) {
    if (pathname.startsWith(route)) return ctx;
  }
  // Fallback context: the IB rejects `dashboard` for non-admin roles
  // (server pins them to the tech toolset anyway).
  if (user && user.role !== "admin") return "customers";
  return ROUTE_CONTEXT_MAP["/admin"];
}

function loadRecents() {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRecent(prompt) {
  if (!prompt || !prompt.trim()) return;
  const t = prompt.trim();
  const list = loadRecents().filter((p) => p !== t);
  list.unshift(t);
  try {
    localStorage.setItem(
      RECENTS_KEY,
      JSON.stringify(list.slice(0, RECENTS_MAX)),
    );
  } catch {}
}

// ─── Markdown renderer ──────────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return null;
  const lines = text.split("\n");
  const elements = [];
  let key = 0;
  for (const line of lines) {
    if (line.startsWith("### ")) {
      elements.push(
        <div
          key={key++}
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: "#0F172A",
            marginTop: 12,
            marginBottom: 4,
          }}
        >
          {line.slice(4)}
        </div>,
      );
      continue;
    }
    if (line.startsWith("## ")) {
      elements.push(
        <div
          key={key++}
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: "#0F172A",
            marginTop: 14,
            marginBottom: 6,
          }}
        >
          {line.slice(3)}
        </div>,
      );
      continue;
    }
    if (line.match(/^[-•*]\s/)) {
      elements.push(
        <div
          key={key++}
          style={{ display: "flex", gap: 8, paddingLeft: 4, marginBottom: 3 }}
        >
          <span style={{ color: D.teal, fontSize: 10, marginTop: 5 }}>●</span>
          <span>{renderInline(line.replace(/^[-•*]\s/, ""))}</span>
        </div>,
      );
      continue;
    }
    if (line.match(/^\d+\.\s/)) {
      const num = line.match(/^(\d+)\./)[1];
      elements.push(
        <div
          key={key++}
          style={{ display: "flex", gap: 8, paddingLeft: 4, marginBottom: 3 }}
        >
          <span
            style={{
              color: D.teal,
              fontSize: 12,
              fontWeight: 700,
              fontFamily: "JetBrains Mono, monospace",
              minWidth: 18,
            }}
          >
            {num}.
          </span>
          <span>{renderInline(line.replace(/^\d+\.\s/, ""))}</span>
        </div>,
      );
      continue;
    }
    if (!line.trim()) {
      elements.push(<div key={key++} style={{ height: 8 }} />);
      continue;
    }
    elements.push(
      <div key={key++} style={{ marginBottom: 4 }}>
        {renderInline(line)}
      </div>,
    );
  }
  return elements;
}

function renderInline(text) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**"))
      return (
        <strong key={i} style={{ color: "#0F172A", fontWeight: 500 }}>
          {part.slice(2, -2)}
        </strong>
      );
    return part;
  });
}

// ─── MAIN COMPONENT ─────────────────────────────────────────────
function GlobalCommandPalette({ user }, ref) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState(null);
  const [pendingActions, setPendingActions] = useState([]);
  const [activeTask, setActiveTask] = useState(null);
  const [savedTasks, setSavedTasks] = useState([]);
  const [tasksAvailable, setTasksAvailable] = useState(false);
  const tasksAvailableRef = useRef(false);
  tasksAvailableRef.current = tasksAvailable;
  const sessionIdRef = useRef(null);
  if (!sessionIdRef.current) sessionIdRef.current = ibSessionId();
  const submittingRef = useRef(false);
  // GATE_IB_TOOL_ACTIVITY: operator-facing lines for what this exchange ran.
  const [toolActivity, setToolActivity] = useState([]);
  const [conversationHistory, setConversationHistory] = useState([]);
  // Server-persisted thread id (GATE_IB_THREADS). Null = ephemeral/new chat;
  // the id is set from query responses and from resume-on-open.
  const [threadId, setThreadId] = useState(null);
  // The thread tail seq this client last saw — sent with each query so the
  // server rejects an append that would interleave with another tab's.
  const threadSeqRef = useRef(null);
  const resumeAttemptedRef = useRef(false);
  // Bumped by submit/"New chat" so a still-inflight resume or query response
  // can't clobber newer state (it only applies if the epoch is unchanged).
  const threadEpochRef = useRef(0);
  // True once /threads/latest answered 200 — the server gate is on. While
  // false the palette keeps the exact pre-thread ephemeral behavior
  // (conversation cleared on route/context change). The ref drives effects;
  // the state mirror drives rendering (the History affordance).
  const threadsAvailableRef = useRef(false);
  const [threadsAvailable, setThreadsAvailable] = useState(false);
  const markThreadsAvailable = useCallback((v) => {
    threadsAvailableRef.current = v;
    setThreadsAvailable(v);
  }, []);
  // Previous-conversations picker (lazy: the list is fetched on open).
  const [showThreads, setShowThreads] = useState(false);
  const [threads, setThreads] = useState([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [quickActions, setQuickActions] = useState([]);
  const [recents, setRecents] = useState(() => loadRecents());
  const [attachments, setAttachments] = useState([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [dragY, setDragY] = useState(0);
  const dragStartRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const attachmentConversionRef = useRef(0);
  const attachmentsLoadingRef = useRef(false);
  const location = useLocation();
  const isMobile = useIsMobile(768);
  // Dialog semantics: trap Tab focus inside the palette while open and restore
  // focus to the opener on close. Escape stays handled by the palette's own
  // key handlers, so no onEscape is passed here.
  const paletteRef = useModalFocus(open);

  const ibPageData = useIntelligenceBarPageData();
  const context = detectContext(location.pathname, location.search, location.hash, user);
  const accentColor = CONTEXT_COLORS[context] || D.teal;
  const contextLabel = CONTEXT_LABELS[context] || "Admin";

  useImperativeHandle(
    ref,
    () => ({
      open: () => setOpen(true),
      close: () => setOpen(false),
      toggle: () => setOpen((v) => !v),
    }),
    [],
  );

  // ⌘K / Ctrl+K listener
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  // Focus input when opening + refresh recents
  useEffect(() => {
    if (open) {
      setRecents(loadRecents());
      setDragY(0);
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [open]);

  // Load context-specific quick actions when context changes
  useEffect(() => {
    if (!open) return;
    adminFetch(`/admin/intelligence-bar/quick-actions?context=${context}`)
      .then((d) => setQuickActions(d.actions || []))
      .catch(() => setQuickActions([]));
  }, [context, open]);

  const setAttachmentBusy = useCallback((busy) => {
    attachmentsLoadingRef.current = busy;
    setAttachmentsLoading(busy);
  }, []);

  const resetAttachments = useCallback(() => {
    attachmentConversionRef.current += 1;
    setAttachments([]);
    setAttachmentBusy(false);
  }, [setAttachmentBusy]);

  // With threads enabled, a context change no longer wipes the conversation
  // (operating-terminal scope, owner-ratified 2026-08-31): the thread
  // survives route changes — the server trims what reaches the model, and
  // tool availability is recalculated per request from the new context.
  // Gate off (or not yet probed): the exact pre-thread ephemeral behavior —
  // clear everything. Attachments stay per-message either way.
  useEffect(() => {
    threadEpochRef.current += 1;
    submittingRef.current = false;
    setLoading(false);
    setActiveTask(null);
    setResponse(null);
    // Legacy threaded approvals have no task recovery. Keep their bound cards
    // until resolved; task-backed cards can be reopened from Saved requests.
    if (!threadsAvailableRef.current) setPendingActions([]);
    else if (tasksAvailableRef.current) setPendingActions(previous => previous.filter(action => !action.taskId));
    setToolActivity([]);
    if (!threadsAvailableRef.current) {
      // Unlike New chat/submit (deliberate detach — no re-resume), a
      // context-driven invalidation should let the next palette open retry
      // the resume probe; otherwise a route change during the inflight
      // probe disables resume for the component's lifetime.
      resumeAttemptedRef.current = false;
      setConversationHistory([]);
      setResponse(null);
      setPendingActions([]);
      setToolActivity([]);
      // Detach any persisted thread too — /query evaluates the gate at call
      // time, so a threadId can exist even after the availability probe
      // failed; appending a fresh conversation to it would corrupt the
      // thread.
      setThreadId(null);
      threadSeqRef.current = null;
    }
    resetAttachments();
  }, [location.pathname, location.search, context, ibPageData?.customer_id, ibPageData?.appointment_id, ibPageData?.viewed_date, resetAttachments]);

  // Load a server thread into the palette (resume-on-open and the picker
  // share this). Shows the thread's last reply — otherwise the palette
  // looks like a new chat while silently sending the old history with the
  // next prompt. Server-side taint markers are presentation noise here;
  // they stay on the stored turns.
  const hydrateThread = useCallback((thread) => {
    const hist = thread?.conversationHistory;
    if (!hist?.length) return false;
    setConversationHistory(hist);
    setThreadId(thread.id);
    threadSeqRef.current = Number.isInteger(thread.lastSeq) ? thread.lastSeq : null;
    setPendingActions([]);
    setToolActivity([]);
    try { localStorage.removeItem(dismissedThreadKey()); } catch { /* storage unavailable */ }
    const lastAssistant = [...hist].reverse().find((t) => t.role === "assistant");
    setResponse(
      lastAssistant
        ? String(lastAssistant.content || "")
          .replace(/\n\[Image attachment context may contain PII\]/g, "")
          .replace(/\n\[PII-bearing tool context may contain customer PII\]/g, "")
        : null,
    );
    return true;
  }, []);

  // Picker: fetch the actor's recent threads (server-side actor-bound).
  const loadThreads = useCallback(() => {
    setThreadsLoading(true);
    adminFetch("/admin/intelligence-bar/threads?limit=20")
      .then((data) => setThreads(Array.isArray(data?.threads) ? data.threads : []))
      .catch(() => setThreads([]))
      .finally(() => setThreadsLoading(false));
    adminFetch(`/admin/intelligence-bar/tasks?session_id=${encodeURIComponent(sessionIdRef.current)}`)
      .then(data => setSavedTasks(data.tasks || [])).catch(() => setSavedTasks([]));
  }, []);

  const toggleThreads = () => {
    const next = !showThreads;
    setShowThreads(next);
    if (next) loadThreads();
  };

  // Picker: reopen a previous conversation. Deliberate like New chat —
  // invalidates any inflight resume/query so their late responses can't
  // clobber the chosen thread.
  const openThread = (id) => {
    threadEpochRef.current += 1;
    const epoch = threadEpochRef.current;
    setThreadsLoading(true);
    adminFetch(`/admin/intelligence-bar/threads/${encodeURIComponent(id)}`)
      .then((data) => {
        if (threadEpochRef.current !== epoch) return;
        if (hydrateThread(data?.thread)) setShowThreads(false);
      })
      .catch(() => { /* thread gone or not ours — stay where we are */ })
      .finally(() => setThreadsLoading(false));
  };

  // Resume the latest server-persisted thread when the palette first opens
  // with no local history. 404 = threads not enabled — quietly stay
  // ephemeral (the pre-threads behavior).
  useEffect(() => {
    if (!open || resumeAttemptedRef.current || conversationHistory.length > 0) return;
    resumeAttemptedRef.current = true;
    const epoch = threadEpochRef.current;
    adminFetch("/admin/intelligence-bar/threads/latest")
      .then((data) => {
        markThreadsAvailable(true); // 200 = gate on (thread may be null)
        if (threadEpochRef.current !== epoch) return; // user submitted/cleared meanwhile
        let dismissedId = null;
        try { dismissedId = localStorage.getItem(dismissedThreadKey()); } catch { /* storage unavailable */ }
        if (data?.thread?.id && data.thread.id === dismissedId) return; // operator dismissed it with New chat
        hydrateThread(data?.thread);
      })
      .catch((err) => {
        // 404 = gate off, 403 = not an admin — definitive, stay ephemeral.
        // Anything else is transient (network/5xx): allow the next palette
        // open to retry the probe instead of losing resume for the
        // component's lifetime.
        if (err?.status !== 404 && err?.status !== 403) {
          resumeAttemptedRef.current = false;
        }
      });
  }, [open, conversationHistory.length]);

  const submit = useCallback(
    async (text, selectedTarget) => {
      const q = (text || prompt).trim();
      if (!q || loading || submittingRef.current || attachmentsLoadingRef.current) return;
      submittingRef.current = true;
      threadEpochRef.current += 1; // invalidate any inflight thread resume
      const epoch = threadEpochRef.current;
      setShowThreads(false); // a query from the History view shows its answer
      setLoading(true);
      setResponse(null);
      setToolActivity([]);
      saveRecent(q);
      setRecents(loadRecents());

      try {
        const data = await adminFetch("/admin/intelligence-bar/query", {
          method: "POST",
          body: JSON.stringify({
            prompt: q,
            conversationHistory,
            context,
            session_id: sessionIdRef.current,
            request_key: crypto.randomUUID(),
            ...(selectedTarget ? { selected_target: selectedTarget } : {}),
            ...(threadId
              ? {
                  thread_id: threadId,
                  ...(Number.isInteger(threadSeqRef.current) ? { thread_seq: threadSeqRef.current } : {}),
                }
              : {}),
            pageData: { ...ibPageData, route: location.pathname, search: location.search },
            ...(attachments.length
              ? { images: attachments.map(({ mediaType, data: d }) => ({ mediaType, data: d })) }
              : {}),
          }),
        });
        // "New chat" (or a context reset) while the query was inflight —
        // drop the stale response instead of restoring the cleared thread.
        if (threadEpochRef.current === epoch) {
          setResponse(data.response);
          setPendingActions(previous => [...previous, ...(data.pendingActions || []).filter(action => !previous.some(old => old.id === action.id)).map(action => ({ ...action, taskId: data.taskId || null, receivedAt: Date.now() }))]);
          setActiveTask(data.taskId ? data : null);
          setToolActivity(Array.isArray(data.toolActivity) ? data.toolActivity : []);
          setConversationHistory(data.conversationHistory || []);
          if (data.threadId) {
            setThreadId(data.threadId);
            threadSeqRef.current = Number.isInteger(data.threadSeq) ? data.threadSeq : null;
          } else if (data.threadsEnabled === true && threadId) {
            // Threads are on but this exchange wasn't appended — the server
            // rejected it (another tab appended first, or the thread is
            // gone) or the best-effort write failed. Detach so the next
            // exchange starts a fresh thread instead of interleaving.
            setThreadId(null);
            threadSeqRef.current = null;
          }
          // The server states thread availability on every query, so a
          // RUNTIME gate change is reflected: off → detach and return to
          // ephemeral mode (the kill switch's promise); on → thread mode
          // even if the availability probe failed earlier or this
          // exchange's best-effort append didn't return an id.
          if (data.threadsEnabled === true) {
            markThreadsAvailable(true);
          } else if (data.threadsEnabled === false) {
            markThreadsAvailable(false);
            setThreadId(null);
            threadSeqRef.current = null;
          }
        }
      } catch (err) {
        if (threadEpochRef.current === epoch) setResponse(`Error: ${err.message}`);
      }
      if (threadEpochRef.current === epoch) {
        submittingRef.current = false;
        setLoading(false);
        setPrompt("");
        resetAttachments();
      }
    },
    [prompt, loading, conversationHistory, context, threadId, location.pathname, location.search, attachments, resetAttachments, ibPageData],
  );

  const refreshTask = async (id = activeTask?.taskId, operation = null, candidate = null) => {
    if (!id || submittingRef.current) return;
    const epoch = ++threadEpochRef.current;
    submittingRef.current = true;
    setLoading(true);
    try {
      const data = await adminFetch(operation ? `/admin/intelligence-bar/tasks/${encodeURIComponent(id)}/${operation}`
        : `/admin/intelligence-bar/tasks/${encodeURIComponent(id)}?session_id=${encodeURIComponent(sessionIdRef.current)}`,
      operation ? { method: 'POST', body: JSON.stringify({ session_id: sessionIdRef.current,
        ...(candidate ? { customer_id: candidate.customer_id } : {}) }) } : {});
      if (threadEpochRef.current !== epoch) return;
      setActiveTask(data);
      setResponse(data.response);
      setConversationHistory(data.conversationHistory || []);
      setThreadId(data.threadId || null);
      threadSeqRef.current = Number.isInteger(data.threadSeq) ? data.threadSeq : null;
      setPendingActions((data.pendingActions || []).map(action => ({ ...action, taskId: data.taskId })));
      setToolActivity(data.toolActivity || []);
      setShowThreads(false);
    } catch (err) {
      if (threadEpochRef.current === epoch) setResponse(`Status unavailable: ${err.message}`);
    } finally {
      if (threadEpochRef.current === epoch) { submittingRef.current = false; setLoading(false); }
    }
  };

  const actionEpoch = threadEpochRef.current;
  const onActionResolved = (action, decision, body) => {
    // A retained legacy card still needs its receipt after navigation. Mapping
    // by ID cannot restore a card removed by Clear or task-context isolation.
    setPendingActions(previous => previous.map(item => item.id === action.id
      ? { ...item, receipt: body, resolvedStatus: decision === 'cancel' && body.cancelled ? 'cancelled' : undefined } : item));
    if (threadEpochRef.current !== actionEpoch) return;
    if (activeTask) void refreshTask();
  };
  const taskCard = <IntelligenceTaskCard task={activeTask}
    onSelectTarget={candidate => refreshTask(activeTask?.taskId, 'select-target', candidate)}
    onRefresh={() => refreshTask()} onContinue={() => refreshTask(activeTask?.taskId, 'resume')} onResolved={onActionResolved} />;
  const taskHistory = savedTasks.length > 0 && <div style={{ marginBottom: 12 }}>
    <div style={{ fontSize: 14, marginBottom: 8 }}>Saved requests — clearing a chat does not cancel actions</div>
    {savedTasks.map(task => <button key={task.id} type="button" onClick={() => refreshTask(task.id)}
      style={{ display: 'block', width: '100%', minHeight: 44, padding: 8, textAlign: 'left' }}>
      {task.target?.target?.label || 'Platform request'} · {task.state.replaceAll('_', ' ')}
    </button>)}
  </div>;

  useEffect(() => {
    if (!open) return;
    adminFetch(`/admin/intelligence-bar/tasks?session_id=${encodeURIComponent(sessionIdRef.current)}`)
      .then(data => { setTasksAvailable(true); setSavedTasks(data.tasks || []); })
      .catch(() => setTasksAvailable(false));
  }, [open]);

  const addAttachments = useCallback(
    async (files) => {
      const conversionId = attachmentConversionRef.current + 1;
      attachmentConversionRef.current = conversionId;
      setAttachmentBusy(true);
      try {
        const parts = await filesToImageParts(files, attachments.length);
        if (attachmentConversionRef.current === conversionId && parts.length)
          setAttachments((prev) => [...prev, ...parts].slice(0, MAX_ATTACHMENTS));
      } finally {
        if (attachmentConversionRef.current === conversionId) {
          setAttachmentBusy(false);
        }
      }
    },
    [attachments.length, setAttachmentBusy],
  );

  const removeAttachment = useCallback((index) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const clear = () => {
    // "New chat": drops the local view AND detaches from the persisted
    // thread — the next query starts a fresh thread (old ones remain until
    // retention). The dismissed id is remembered so a reload doesn't
    // resurrect the conversation the operator just cleared.
    if (threadId) {
      try { localStorage.setItem(dismissedThreadKey(), threadId); } catch { /* storage unavailable */ }
    }
    threadEpochRef.current += 1; // invalidate any inflight thread resume
    submittingRef.current = false;
    setLoading(false);
    setActiveTask(null);
    setConversationHistory([]);
    setResponse(null);
    setPendingActions([]);
    setToolActivity([]);
    setPrompt("");
    setThreadId(null);
    threadSeqRef.current = null;
    setShowThreads(false);
    resetAttachments();
  };

  // Merge each dictation transcript chunk into the input, space-separated.
  const appendTranscript = useCallback((text) => {
    if (!text) return;
    setPrompt((prev) => (prev ? `${prev.trimEnd()} ${text}` : text));
  }, []);

  const close = () => setOpen(false);

  // Touch handlers for swipe-down-to-close on mobile
  const onTouchStart = (e) => {
    if (!isMobile) return;
    dragStartRef.current = e.touches[0].clientY;
  };
  const onTouchMove = (e) => {
    if (!isMobile || dragStartRef.current == null) return;
    const dy = e.touches[0].clientY - dragStartRef.current;
    if (dy > 0) setDragY(dy);
  };
  const onTouchEnd = () => {
    if (!isMobile) return;
    if (dragY > 120) {
      setOpen(false);
    } else {
      setDragY(0);
    }
    dragStartRef.current = null;
  };

  if (!open) return null;

  if (isMobile) {
    return (
      <MobileSheet
        paletteRef={paletteRef}
        close={close}
        dragY={dragY}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        inputRef={inputRef}
        prompt={prompt}
        setPrompt={setPrompt}
        submit={submit}
        handleKeyDown={handleKeyDown}
        loading={loading}
        response={response}
        pendingActions={pendingActions}
        taskCard={taskCard}
        activeTask={activeTask}
        onActionResolved={onActionResolved}
        taskHistory={taskHistory}
        toolActivity={toolActivity}
        recents={recents}
        quickActions={quickActions}
        contextLabel={contextLabel}
        clear={clear}
        threadsAvailable={threadsAvailable || tasksAvailable}
        showThreads={showThreads}
        toggleThreads={toggleThreads}
        threads={threads}
        threadsLoading={threadsLoading}
        openThread={openThread}
        accentColor={accentColor}
        appendTranscript={appendTranscript}
        attachments={attachments}
        attachmentsLoading={attachmentsLoading}
        addAttachments={addAttachments}
        removeAttachment={removeAttachment}
      />
    );
  }

  // ─── Desktop centered modal (unchanged from original) ─────────
  return (
    <>
      {" "}
      <div
        onClick={close}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.6)",
          backdropFilter: "blur(4px)",
          zIndex: 9998,
        }}
      />{" "}
      <div
        ref={paletteRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        style={{
          position: "fixed",
          top: "10%",
          left: "50%",
          transform: "translateX(-50%)",
          width: "90%",
          maxWidth: 640,
          maxHeight: "75vh",
          background: D.card,
          border: `1px solid ${D.border}`,
          borderRadius: 16,
          boxShadow: "0 24px 80px rgba(0,0,0,0.15)",
          zIndex: 9999,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          animation: "paletteIn 0.15s ease",
        }}
      >
        {" "}
        <div
          style={{
            padding: "14px 18px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            borderBottom: `1px solid ${D.border}44`,
          }}
        >
          {" "}
          <div style={{ flex: 1, position: "relative" }}>
            {" "}
            <input
              ref={inputRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything..."
              autoFocus
              style={{
                width: "100%",
                padding: "10px 14px",
                paddingRight: 128,
                background: "#FFFFFF",
                border: `1px solid ${D.border}`,
                borderRadius: 10,
                color: D.text,
                fontSize: 15,
                fontFamily: "Roboto, Arial, sans-serif",
                outline: "none",
                boxSizing: "border-box",
              }}
              onFocusCapture={(e) =>
                (e.target.style.borderColor = accentColor + "66")
              }
              onBlurCapture={(e) => (e.target.style.borderColor = D.border)}
            />{" "}
            <div
              style={{
                position: "absolute",
                right: 8,
                top: "50%",
                transform: "translateY(-50%)",
                display: "flex",
                gap: 6,
                alignItems: "center",
              }}
            >
              {!loading && (
                <AttachButton
                  onClick={() => fileInputRef.current?.click()}
                  color={D.muted}
                  size={30}
                  disabled={attachmentsLoading}
                />
              )}
              {!loading && (
                <DictationButton
                  onAppend={appendTranscript}
                  title="Dictate your question"
                  size={30}
                  palette={{ accent: accentColor, muted: D.muted, red: D.red, card: "#fff" }}
                />
              )}
              {loading || attachmentsLoading ? (
                <div
                  style={{
                    padding: "5px 10px",
                    borderRadius: 6,
                    background: `${accentColor}22`,
                    color: accentColor,
                    fontSize: 11,
                    fontWeight: 500,
                    fontFamily: "JetBrains Mono, monospace",
                    animation: "pulse 1.5s ease infinite",
                  }}
                >
                  {loading ? "thinking..." : "attaching..."}
                </div>
              ) : prompt.trim() ? (
                <button
                  onClick={() => submit()}
                  style={{
                    padding: "5px 12px",
                    borderRadius: 6,
                    background: accentColor,
                    color: D.white,
                    border: "none",
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  Go
                </button>
              ) : (
                <span
                  style={{
                    padding: "4px 8px",
                    borderRadius: 4,
                    background: D.bg,
                    border: `1px solid ${D.border}`,
                    fontSize: 10,
                    color: D.muted,
                    fontFamily: "JetBrains Mono, monospace",
                  }}
                >
                  ESC
                </span>
              )}
            </div>{" "}
          </div>{" "}
          <div
            style={{
              padding: "4px 10px",
              borderRadius: 8,
              background: `${accentColor}15`,
              border: `1px solid ${accentColor}33`,
              color: accentColor,
              fontSize: 11,
              fontWeight: 500,
              whiteSpace: "nowrap",
            }}
          >
            {contextLabel}
          </div>{" "}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            addAttachments(e.target.files);
            e.target.value = "";
          }}
        />
        {attachments.length > 0 && (
          <AttachmentStrip
            attachments={attachments}
            onRemove={removeAttachment}
            border={D.border}
          />
        )}
        {showThreads && !loading && (
          <div style={{ flex: 1, overflow: "auto", padding: "10px 18px 14px" }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 500,
                color: D.muted,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                padding: "4px 0 8px",
              }}
            >
              Previous conversations
            </div>
            {taskHistory}
            <ThreadList threads={threads} loading={threadsLoading} onOpen={openThread} variant="dark" />
          </div>
        )}
        {!response && pendingActions.length === 0 && !loading && !showThreads && quickActions.length > 0 && (
          <div
            style={{
              padding: "12px 18px",
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              borderBottom: `1px solid ${D.border}22`,
            }}
          >
            {quickActions.map((a) => (
              <button
                key={a.id}
                onClick={() => {
                  setPrompt(a.prompt);
                  submit(a.prompt);
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "5px 12px",
                  borderRadius: 9999,
                  background: "#FFFFFF",
                  border: `1px solid ${D.border}`,
                  color: "#000",
                  fontSize: 12,
                  fontWeight: 500,
                  fontFamily: "'Roboto', system-ui, sans-serif",
                  cursor: "pointer",
                  transition: "all 0.1s",
                }}
                onMouseEnter={(e) => {
                  e.target.style.borderColor = accentColor + "55";
                }}
                onMouseLeave={(e) => {
                  e.target.style.borderColor = D.border;
                }}
              >
                {a.icon && <span style={{ fontSize: 13 }}>{a.icon}</span>}
                {a.label}
              </button>
            ))}
          </div>
        )}
        {loading && (
          <div style={{ padding: "14px 18px" }}>
            {[90, 70, 85, 55].map((w, i) => (
              <div
                key={i}
                style={{
                  height: 13,
                  borderRadius: 6,
                  marginBottom: 6,
                  background: `linear-gradient(90deg, ${D.border}44, ${D.border}88, ${D.border}44)`,
                  backgroundSize: "200% 100%",
                  animation: "shimmer 1.5s ease infinite",
                  width: `${w}%`,
                }}
              />
            ))}
          </div>
        )}
        {(response || pendingActions.length > 0) && !loading && !showThreads && (
          <div style={{ flex: 1, overflow: "auto", padding: "14px 18px" }}>
            {taskCard}
            {" "}
            <IntelligenceResponse response={response} activity={toolActivity} task={activeTask} variant="dark" />
            {!activeTask && <PendingActionsCard actions={pendingActions} variant="dark" onResolved={onActionResolved} />}
          </div>
        )}
        {(response || pendingActions.length > 0) && !loading && !showThreads && (
          <div
            style={{
              padding: "10px 18px",
              borderTop: `1px solid ${D.border}33`,
              display: "flex",
              gap: 8,
            }}
          >
            {" "}
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Follow up..."
              style={{
                flex: 1,
                padding: "8px 12px",
                background: "#FFFFFF",
                border: `1px solid ${D.border}`,
                borderRadius: 8,
                color: D.text,
                fontSize: 13,
                fontFamily: "Roboto, Arial, sans-serif",
                outline: "none",
              }}
            />{" "}
            <button
              onClick={() => submit()}
              disabled={!prompt.trim()}
              style={{
                padding: "8px 14px",
                background: accentColor,
                color: D.white,
                border: "none",
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
                opacity: prompt.trim() ? 1 : 0.4,
              }}
            >
              Send
            </button>{" "}
            <button
              onClick={clear}
              style={{
                padding: "8px 10px",
                background: "transparent",
                border: `1px solid ${D.border}`,
                borderRadius: 8,
                color: D.muted,
                fontSize: 11,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Clear
            </button>{" "}
          </div>
        )}
        <div
          style={{
            padding: "6px 18px",
            borderTop: `1px solid ${D.border}22`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          {" "}
          <span style={{ fontSize: 10, color: D.border }}>
            Intelligence Bar — context: {contextLabel}
          </span>{" "}
          {(threadsAvailable || tasksAvailable) && (
            <button
              onClick={toggleThreads}
              style={{
                padding: "3px 8px",
                background: showThreads ? `${accentColor}15` : "transparent",
                border: `1px solid ${showThreads ? accentColor + "55" : D.border}`,
                borderRadius: 6,
                color: showThreads ? accentColor : D.muted,
                fontSize: 10,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              {showThreads ? "Back" : "History"}
            </button>
          )}
          <span
            style={{
              fontSize: 10,
              color: D.border,
              fontFamily: "JetBrains Mono, monospace",
            }}
          >
            {navigator.platform?.includes("Mac") ? "⌘" : "Ctrl"}+K to toggle
          </span>{" "}
        </div>{" "}
      </div>{" "}
      <style>{`
        @keyframes paletteIn {
          from { opacity: 0; transform: translateX(-50%) translateY(-10px) scale(0.98); }
          to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
        }
        @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      `}</style>{" "}
    </>
  );
}

// ─── Mobile bottom sheet ───────────────────────────────────────
function MobileSheet({
  paletteRef,
  close,
  dragY,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
  inputRef,
  prompt,
  setPrompt,
  submit,
  handleKeyDown,
  loading,
  response,
  pendingActions,
  taskCard,
  activeTask,
  onActionResolved,
  taskHistory,
  toolActivity,
  recents,
  quickActions,
  contextLabel,
  clear,
  threadsAvailable,
  showThreads,
  toggleThreads,
  threads,
  threadsLoading,
  openThread,
  accentColor,
  appendTranscript,
  attachments,
  attachmentsLoading,
  addAttachments,
  removeAttachment,
}) {
  const fileInputRef = useRef(null);
  return (
    <>
      {/* Backdrop */}
      <div
        onClick={close}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          zIndex: 9998,
          touchAction: "none",
        }}
      />
      {/* Sheet */}
      <div
        ref={paletteRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: "var(--keyboard-inset, 0px)",
          top: "calc(var(--vv-offset-top, 0px) + env(safe-area-inset-top, 0px) + 12px)",
          background: "#FFFFFF",
          zIndex: 9999,
          display: "flex",
          flexDirection: "column",
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          boxShadow: "0 -12px 40px rgba(0,0,0,0.18)",
          transform: `translateY(${dragY}px)`,
          transition: dragY === 0 ? "transform 0.2s ease" : "none",
          paddingBottom: "env(safe-area-inset-bottom, 0)",
        }}
      >
        {/* Drag handle + header */}
        <div
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          style={{ paddingTop: 8, paddingBottom: 4, touchAction: "pan-y" }}
        >
          {" "}
          <div
            style={{
              width: 40,
              height: 4,
              borderRadius: 2,
              background: "#D4D4D8",
              margin: "0 auto",
            }}
          />{" "}
        </div>{" "}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px 16px 12px",
          }}
        >
          {" "}
          <div>
            {" "}
            <div
              style={{
                fontSize: 18,
                fontWeight: 500,
                color: "#18181B",
                letterSpacing: "-0.01em",
              }}
            >
              Intelligence Bar
            </div>{" "}
            <div
              style={{
                fontSize: 11,
                color: "#71717A",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                marginTop: 2,
              }}
            >
              {contextLabel}
            </div>{" "}
          </div>{" "}
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <details style={{ position: "relative" }}>
              <summary aria-label="Conversation options" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 44, height: 44, cursor: "pointer", fontSize: 22 }}>⋯</summary>
              <div style={{ position: "absolute", right: 0, top: 44, minWidth: 170, padding: 6, border: "1px solid #E4E4E7", borderRadius: 10, background: "#FFF", zIndex: 1 }}>
                {threadsAvailable && <button onClick={toggleThreads} style={{ display: "block", width: "100%", minHeight: 44, textAlign: "left", padding: 10, border: 0, background: "transparent", font: "inherit" }}>{showThreads ? "Back to request" : "History"}</button>}
                <button onClick={clear} style={{ display: "block", width: "100%", minHeight: 44, textAlign: "left", padding: 10, border: 0, background: "transparent", font: "inherit" }}>New chat</button>
              </div>
            </details>
          <button
            onClick={close}
            aria-label="Close"
            style={{
              width: 44,
              height: 44,
              borderRadius: 8,
              border: "none",
              background: "#F4F4F5",
              color: "#18181B",
              fontSize: 18,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            ×
          </button>{" "}
          </div>
        </div>
        {/* Input */}
        <div style={{ padding: "0 16px 12px" }}>
          {" "}
          <div style={{ position: "relative" }}>
            {" "}
            <input
              ref={inputRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything…"
              enterKeyHint="send"
              style={{
                width: "100%",
                padding: "14px 96px 14px 16px",
                boxSizing: "border-box",
                background: "#FAFAFA",
                border: "1px solid #E4E4E7",
                borderRadius: 10,
                color: "#18181B",
                fontSize: 16,
                fontFamily: "Roboto, Arial, sans-serif",
                outline: "none",
              }}
            />{" "}
            {!loading && (
              <div
                style={{
                  position: "absolute",
                  right: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                {" "}
                <AttachButton
                  onClick={() => fileInputRef.current?.click()}
                  color="#A1A1AA"
                  size={44}
                  disabled={attachmentsLoading}
                />{" "}
                <DictationButton
                  onAppend={appendTranscript}
                  title="Tap to talk"
                  size={44}
                  palette={{ accent: accentColor, muted: "#A1A1AA", red: "#EF4444", card: "#fff" }}
                />{" "}
              </div>
            )}{" "}
          </div>{" "}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              addAttachments(e.target.files);
              e.target.value = "";
            }}
          />
          {attachments.length > 0 && (
            <AttachmentStrip
              attachments={attachments}
              onRemove={removeAttachment}
              border="#E4E4E7"
              padded={false}
            />
          )}{" "}
          {(prompt.trim() || loading || attachmentsLoading) && <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            {" "}
            <button
              onClick={() => submit()}
              disabled={!prompt.trim() || loading || attachmentsLoading}
              style={{
                flex: 1,
                padding: "12px 16px",
                minHeight: 44,
                borderRadius: 10,
                border: "none",
                background: prompt.trim() && !loading && !attachmentsLoading ? "#18181B" : "#E4E4E7",
                color: prompt.trim() && !loading && !attachmentsLoading ? "#FFFFFF" : "#A1A1AA",
                fontSize: 14,
                fontWeight: 500,
                cursor: prompt.trim() && !loading && !attachmentsLoading ? "pointer" : "not-allowed",
                fontFamily: "Roboto, Arial, sans-serif",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}
            >
              {loading ? "Thinking…" : attachmentsLoading ? "Attaching…" : "Ask"}
            </button>
          </div>}
        </div>
        {/* Body: scrollable region below the input */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            WebkitOverflowScrolling: "touch",
            padding: "0 16px 20px",
          }}
        >
          {loading && (
            <div style={{ padding: "8px 0" }}>
              {[90, 70, 85, 55].map((w, i) => (
                <div
                  key={i}
                  style={{
                    height: 14,
                    borderRadius: 6,
                    marginBottom: 8,
                    background:
                      "linear-gradient(90deg, #E4E4E744, #E4E4E7AA, #E4E4E744)",
                    backgroundSize: "200% 100%",
                    animation: "shimmer 1.5s ease infinite",
                    width: `${w}%`,
                  }}
                />
              ))}
            </div>
          )}

          {response && !loading && !showThreads && (
            taskCard
          )}
          {response && !loading && !showThreads && (
            <IntelligenceResponse response={response} activity={toolActivity} task={activeTask} variant="light" />
          )}
          {pendingActions.length > 0 && !loading && !showThreads && !activeTask && (
            <PendingActionsCard actions={pendingActions} variant="light" onResolved={onActionResolved} />
          )}

          {showThreads && !loading && (
            <Section label="Previous conversations">
              {taskHistory}
              <ThreadList threads={threads} loading={threadsLoading} onOpen={openThread} variant="light" />
            </Section>
          )}

          {!response && pendingActions.length === 0 && !loading && !showThreads && recents.length > 0 && (
            <Section label="Recent">
              {recents.map((r, i) => (
                <SheetRow
                  key={`r-${i}`}
                  onClick={() => {
                    setPrompt(r);
                    submit(r);
                  }}
                >
                  {" "}
                  <span style={{ fontSize: 14, color: "#18181B" }}>
                    {r}
                  </span>{" "}
                </SheetRow>
              ))}
            </Section>
          )}

          {!response && pendingActions.length === 0 && !loading && !showThreads && quickActions.length > 0 && (
            <Section label="Quick actions">
              {quickActions.map((a) => (
                <SheetRow
                  key={a.id}
                  onClick={() => {
                    setPrompt(a.prompt);
                    submit(a.prompt);
                  }}
                >
                  {a.icon && <span style={{ fontSize: 16 }}>{a.icon}</span>}
                  <span style={{ fontSize: 14, color: "#18181B" }}>
                    {a.label}
                  </span>{" "}
                </SheetRow>
              ))}
            </Section>
          )}

          {!response &&
            pendingActions.length === 0 &&
            !loading &&
            !showThreads &&
            recents.length === 0 &&
            quickActions.length === 0 && (
              <div
                style={{
                  padding: "32px 16px",
                  textAlign: "center",
                  fontSize: 13,
                  color: "#71717A",
                }}
              >
                Ask a question, or try a quick action once they load.
              </div>
            )}
        </div>{" "}
      </div>{" "}
      <style>{`
        @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
      `}</style>{" "}
    </>
  );
}

// Attach (photo) control — square icon button sized to match DictationButton.
function IntelligenceResponse({ response, activity, task, variant }) {
  const hasActions = task && (task.pendingActions?.length || task.receipts?.length);
  const prose = <div style={{ fontSize: 14, lineHeight: 1.65, color: '#27272A' }}>{renderMarkdown(response)}</div>;
  return <>
    {!hasActions && prose}
    {(hasActions || activity.length > 0) && <details style={{ marginTop: 12, fontSize: 14, color: '#52525B' }}>
      <summary style={{ minHeight: 44, cursor: 'pointer', paddingTop: 8 }}>Execution details</summary>
      <ToolActivityList items={activity} variant={variant} />
      {hasActions && prose}
    </details>}
  </>;
}

function AttachButton({ onClick, color, size = 30, disabled = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title="Attach a photo"
      aria-label="Attach a photo"
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        border: "none",
        background: "transparent",
        color,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
      }}
    >
      <svg
        width={Math.round(size * 0.5)}
        height={Math.round(size * 0.5)}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
    </button>
  );
}

// Thumbnail strip for attached photos, with per-item remove.
function AttachmentStrip({ attachments, onRemove, border, padded = true }) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        padding: padded ? "10px 18px" : "10px 0 0",
      }}
    >
      {attachments.map((a, i) => (
        <div
          key={i}
          style={{
            position: "relative",
            width: 52,
            height: 52,
            borderRadius: 8,
            overflow: "hidden",
            border: `1px solid ${border}`,
          }}
        >
          <img
            src={a.previewUrl}
            alt={a.name}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
          <button
            type="button"
            onClick={() => onRemove(i)}
            title="Remove"
            aria-label={`Remove ${a.name}`}
            style={{
              position: "absolute",
              top: 2,
              right: 2,
              width: 16,
              height: 16,
              borderRadius: "50%",
              border: "none",
              background: "rgba(255,255,255,0.92)",
              color: "#18181B",
              fontSize: 11,
              lineHeight: 1,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// Previous-conversations picker rows. "dark" = desktop D-palette modal,
// "light" = mobile sheet (rendered inside a Section card).
function ThreadList({ threads, loading, onOpen, variant }) {
  const light = variant === "light";
  const textColor = light ? "#18181B" : D.text;
  const mutedColor = light ? "#71717A" : D.muted;
  if (loading && threads.length === 0) {
    return (
      <div style={{ padding: light ? "14px 16px" : "8px 0", fontSize: 13, color: mutedColor }}>
        Loading…
      </div>
    );
  }
  if (threads.length === 0) {
    return (
      <div style={{ padding: light ? "14px 16px" : "8px 0", fontSize: 13, color: mutedColor }}>
        No previous conversations yet.
      </div>
    );
  }
  return threads.map((t) => {
    const when = t.last_active_at
      ? formatETDateTime(t.last_active_at, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : "";
    const where = CONTEXT_LABELS[t.context] || t.context || "";
    return (
      <button
        key={t.id}
        onClick={() => onOpen(t.id)}
        style={{
          display: "flex",
          // Phones: meta stacks under the title so the title keeps the width.
          flexDirection: light ? "column" : "row",
          alignItems: light ? "stretch" : "center",
          justifyContent: "space-between",
          gap: light ? 3 : 12,
          width: "100%",
          padding: light ? "12px 16px" : "9px 10px",
          minHeight: light ? 52 : 0,
          background: light ? "#FFFFFF" : "transparent",
          border: "none",
          borderBottom: light ? "0.5px solid #E4E4E7" : `1px solid ${D.border}22`,
          borderRadius: light ? 0 : 6,
          cursor: "pointer",
          textAlign: "left",
          fontFamily: "Roboto, Arial, sans-serif",
        }}
      >
        <span
          style={{
            flex: light ? "none" : 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: light ? 14 : 13,
            color: textColor,
          }}
        >
          {t.title || "Conversation"}
        </span>
        <span style={{ fontSize: light ? 12 : 11, color: mutedColor, whiteSpace: "nowrap" }}>
          {where}{where && when ? " · " : ""}{when}
        </span>
      </button>
    );
  });
}

function Section({ label, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      {" "}
      <div
        style={{
          fontSize: 10,
          fontWeight: 500,
          color: "#71717A",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          padding: "6px 4px",
        }}
      >
        {label}
      </div>{" "}
      <div
        style={{
          background: "#FFFFFF",
          border: "1px solid #E4E4E7",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        {children}
      </div>{" "}
    </div>
  );
}

function SheetRow({ children, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        padding: "14px 16px",
        background: "#FFFFFF",
        border: "none",
        borderBottom: "0.5px solid #E4E4E7",
        cursor: "pointer",
        textAlign: "left",
        minHeight: 52,
      }}
    >
      {children}
    </button>
  );
}

export default forwardRef(GlobalCommandPalette);
