// The customer's text conversation without leaving the profile. Desktop: a
// side panel on the right edge; phone: a full-height sheet whose composer
// rides above the keyboard. Reuses the existing per-customer thread
// (GET /admin/customers/:id/comms), the canonical read writer
// (POST /admin/communications/messages/read) and the same send route the
// Communications composer uses (POST /admin/communications/sms). Lead
// outreach keeps POST /admin/leads/:id/send-sms for its lifecycle writes.
//
// Read rule: only inbound texts the server returned as unread are marked
// read, only after the thread loaded successfully, and only once the server
// acknowledges — the badge is told to refresh after that acknowledgement.
// Drafts are kept per customer in sessionStorage so switching profiles or
// closing the panel never loses typed text. Sends are single-flight and
// pinned to the customer the panel was opened for.
import { createContext, useContext, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import { Button, Textarea } from "../../ui";
import { cn } from "../../ui/cn";
import useModalFocus from "../../../hooks/useModalFocus";
import useIsMobile from "../../../hooks/useIsMobile";
import { isAcceptedSms } from "../../../utils/sms-delivery";
import { adminFetch } from "../../../utils/admin-fetch";
import { notifyUnreadChanged } from "../../../hooks/useUnreadConversations";
import { getAdminUser } from "../../../lib/adminAuth";
import AuthenticatedCallAudio from "../AuthenticatedCallAudio";
import { deliveryLabel, formatDuration } from "./activity";
import { etDateString, formatETDate, formatETTime } from "../../../lib/timezone";

// Estimate contacts are historical snapshots after acceptance. Resolve the
// account's current phone before opening an account-scoped conversation.
export async function openEstimateMessages(estimate, openMessages) {
  try {
    if (!estimate.customerId) {
      openMessages?.({ firstName: estimate.customerName, phone: estimate.customerPhone });
      return;
    }
    const { customer } = await adminFetch(`/admin/customers/${estimate.customerId}/estimates-summary`);
    if (!customer?.phone) throw new Error("This customer has no current phone number.");
    openMessages?.({ id: customer.id, firstName: customer.first_name, lastName: customer.last_name, phone: customer.phone });
  } catch (err) {
    window.alert(err?.message || "Could not load the customer's current contact.");
  }
}

const REFRESH_MS = 30000;
const NEAR_BOTTOM_PX = 48;

const draftKey = (identity) => {
  const staffId = getAdminUser()?.id;
  return staffId ? `c360:sms-draft:${staffId}:${identity}` : null;
};
function readDraft(customerId) {
  try {
    return sessionStorage.getItem(draftKey(customerId) || "") || "";
  } catch {
    return "";
  }
}
function writeDraft(customerId, value) {
  try {
    const key = draftKey(customerId);
    if (!key) return;
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    /* storage unavailable — the draft lives in state for this mount */
  }
}

// The exact consultation-invite LINE last inserted for this identity,
// remembered alongside the draft (pre-push Codex P1): every short link
// shares the same host, so combineAppendedDraft below used to sweep ANY
// line on that host — a pasted pay/review/estimate link, not just a prior
// consultation clause. Session-scoped like the draft itself.
const consultationLineKey = (identity) => {
  const staffId = getAdminUser()?.id;
  return staffId ? `c360:sms-consult-line:${staffId}:${identity}` : null;
};
function readConsultationLine(identity) {
  try {
    return sessionStorage.getItem(consultationLineKey(identity) || "") || "";
  } catch {
    return "";
  }
}
function writeConsultationLine(identity, value) {
  try {
    const key = consultationLineKey(identity);
    if (!key) return;
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    /* storage unavailable — falls back to the wording+host heuristic */
  }
}

function stampLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = etDateString(d);
  const today = etDateString();
  const time = formatETTime(d);
  if (day === today) return time;
  return `${formatETDate(d, { month: "short", day: "numeric" })}, ${time}`;
}

function MessageBubble({ m }) {
  const inbound = m.direction === "inbound";
  if (m.channel === "sms") {
    const receipt = inbound ? null : deliveryLabel(m.deliveryStatus);
    return (
      <div className={cn("flex", inbound ? "justify-start" : "justify-end")}>
        <div
          className={cn(
            "max-w-[85%] px-3.5 py-2.5 rounded-md border-hairline text-16 md:text-14 leading-normal",
            inbound ? "bg-zinc-50 text-zinc-900 border-zinc-200 rounded-bl-xs" : "bg-zinc-900 text-white border-zinc-900 rounded-br-xs",
          )}
        >
          <div className="whitespace-pre-wrap break-words">
            {(typeof m.body === "string" && m.body.trim() ? m.body : "") || (Array.isArray(m.media) && m.media.length ? `${m.media.length} photo${m.media.length === 1 ? "" : "s"}` : "")}
          </div>
          <div className={cn("flex items-center gap-2 mt-1 text-12", inbound ? "text-ink-tertiary" : "text-white/70")}>
            <span className="u-nums">{stampLabel(m.createdAt)}</span>
            {receipt ? <span className={cn(receipt.tone === "alert" && "text-red-200")}>{receipt.label}</span> : null}
          </div>
        </div>
      </div>
    );
  }
  const rec = (m.media || []).find((x) => x && x.type === "recording");
  const duration = formatDuration(m.durationSeconds ?? rec?.duration_seconds);
  const summary = m.aiSummary || null;
  return (
    <div className={cn("flex", inbound ? "justify-start" : "justify-end")}>
      <div className="max-w-[90%] px-3.5 py-2.5 bg-zinc-50 border-hairline border-zinc-200 rounded-md text-14">
        <div className="flex items-center gap-2 text-ink-secondary">
          <span className="font-medium text-zinc-900">{inbound ? "Incoming call" : "Outgoing call"}</span>
          {duration ? <span className="u-nums">{duration}</span> : null}
          {m.deliveryStatus && m.deliveryStatus !== "completed" ? <span>{String(m.deliveryStatus).replace(/-/g, " ")}</span> : null}
          {m.answeredBy ? <span>· {m.answeredBy}</span> : null}
        </div>
        {summary ? <div className="text-zinc-900 mt-1 whitespace-pre-wrap break-words">{summary}</div> : null}
        {(rec?.available || m.recordingSid) && (rec?.sid || m.recordingSid) ? (
          <AuthenticatedCallAudio recordingId={rec?.sid || m.recordingSid} className="mt-1.5 w-full h-9" />
        ) : null}
        <div className="u-nums text-12 text-ink-tertiary mt-1">{stampLabel(m.createdAt)}</div>
      </div>
    </div>
  );
}

// The first http(s) URL a text contains, and the host it points at (scheme
// + path ignored) — used to recognize "this line is a previously-inserted
// bearer link" the same way CommunicationsPageV2.jsx's stripLinkLines does,
// generalized to "same short-link host" rather than "the exact same URL":
// each consultation mint is a FRESH short code (a new 14-day token), so a
// second insert never matches the first insert's literal URL the way a
// static link would.
//
// Scheme-free links count too (Codex #4709 P1): the SMS template renderer
// strips https://, so the real consultation line reads "wavespest.co/l/abc".
// A scheme-free match needs a dotted host AND a path, so ordinary prose
// ("it's Waves.") never reads as a URL.
// No regex lookbehind (Codex #4709 r5 P2): Safari/WKWebView before 16.4
// cannot parse it, and this panel runs on phones. The boundary is a
// captured leading start-of-text or separator instead.
function firstUrlIn(text) {
  const str = String(text || "");
  const withScheme = str.match(/https?:\/\/\S+/i);
  if (withScheme) return withScheme[0];
  const bare = str.match(/(^|[\s(<"'])((?:[a-z0-9-]+\.)+[a-z]{2,}\/\S+)/i);
  return bare ? bare[2] : null;
}
function urlHost(url) {
  if (!url) return null;
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try { return new URL(withScheme).host.toLowerCase(); } catch { return null; }
}

// initialDraft only SEEDS an empty draft — an existing per-identity draft
// (sessionStorage) wins over it, same as opening the panel fresh. A caller
// whose text must actually land in the box regardless of what's already
// there (Send consultation link) passes appendDraft instead: joined onto
// whatever draft already exists (existing, matching how the Communications
// composer's own Insert Link actions add a clause to the current body
// rather than silently losing it — CommunicationsPageV2 insertCustomerLinkLine).
//
// A stored draft already carrying an earlier consultation insert (the
// operator collapsed and re-expanded the row, or clicked the button twice)
// must not get a SECOND copy of the same invite appended below it
// (pre-push Codex P2) — this is the only appendDraft caller in this
// component today, so the prior clause is replaced in place rather than
// appended twice. Every short link shares the same short-link host
// (pre-push Codex P1), so "any line whose URL shares the new addition's
// host" is NOT unambiguously the prior consultation clause — it also
// matches a pasted pay/review/estimate link, which this used to silently
// delete. The exact line last inserted is remembered per identity
// (sessionStorage, alongside the draft itself) and only THAT line is
// removed; a wording+host match is a fallback for when nothing is
// remembered yet (a fresh session, or storage unavailable) — narrower than
// "same host alone" so an unrelated short link still survives on a first
// insert.
const CONSULTATION_WORDING_RE = /consultation/i;
// The single line inside a consultation appendDraft that carries its URL —
// what's remembered (by the caller, alongside the draft write) and what
// combineAppendedDraft below matches on the NEXT insert. Pure: reads
// nothing, has no side effect, so calling it twice (as the mount race
// below does) is harmless.
function consultationLineOf(addition) {
  const text = String(addition || "");
  const host = urlHost(firstUrlIn(text));
  if (!host) return null;
  const lines = text.split("\n");
  return lines.find((line) => urlHost(firstUrlIn(line)) === host) || lines[0];
}
// combineAppendedDraft is PURE — no storage reads or writes. `remembered`
// (the previously inserted consultation line) is read by the CALLER before
// any state update (Codex #4709 P1): React StrictMode runs a setState
// updater twice with the same previous draft, so an updater that read the
// remembered line and then overwrote it would see the NEW line on its
// second run and fail to strip the old link. The caller persists the draft
// and the new remembered line outside the updater.
function combineAppendedDraft(existing, addition, remembered) {
  if (!addition) return existing;
  const base = String(existing || "");
  const newHost = urlHost(firstUrlIn(addition));
  if (newHost) {
    // The remembered line is trusted only while it is still in the draft
    // verbatim (Codex #4709 r5 P2): an operator edit to that line leaves the
    // memory stale, and exact matching would then keep the old invite. Fall
    // back to the wording + host heuristic in that case.
    const rememberedPresent = remembered && base.split("\n").includes(remembered);
    // An EDITED remembered line is still found by its own link (Codex #4709
    // r10 P2) — the URL the operator did not change — so rewording the
    // invite ("inspection" for "consultation") never leaves the old bearer
    // behind. The wording + host heuristic is only for when nothing is
    // remembered at all.
    const rememberedUrl = remembered ? firstUrlIn(remembered) : null;
    const isPriorClauseLine = (line) => {
      if (rememberedPresent) return line === remembered;
      if (rememberedUrl) return line.includes(rememberedUrl);
      return urlHost(firstUrlIn(line)) === newHost && CONSULTATION_WORDING_RE.test(line);
    };
    const withoutPriorClause = base
      .split("\n")
      .filter((line) => !isPriorClauseLine(line))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return withoutPriorClause ? `${withoutPriorClause}\n\n${addition}` : addition;
  }
  const trimmedBase = base.replace(/\s+$/, "");
  return trimmedBase ? `${trimmedBase}\n\n${addition}` : addition;
}

export default function CustomerSmsPanel({ customer, open, onClose, onSent, leadId, initialDraft = "", appendDraft = "" }) {
  const isMobile = useIsMobile();
  const customerId = customer?.id ? String(customer.id) : null;
  const phone = customer?.phone || "";
  const phoneDigits = phone.replace(/\D/g, "");
  const phoneIdentity = phoneDigits.length === 10 && !phone.trim().startsWith("+") ? `1${phoneDigits}` : phoneDigits;
  const identity = customerId || (phone ? `phone:${phoneIdentity}` : null);
  const name = `${customer?.firstName || ""} ${customer?.lastName || ""}`.trim() || "Customer";

  const [messages, setMessages] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState(() => (identity ? combineAppendedDraft(readDraft(identity) || initialDraft, appendDraft, readConsultationLine(identity)) : ""));
  // The latest draft, for the appendDraft effect to build on without a
  // setState updater (see that effect).
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [sentNote, setSentNote] = useState("");
  const [pendingNew, setPendingNew] = useState(0);
  const [liveNote, setLiveNote] = useState("");

  const seqRef = useRef(0);
  const customerRef = useRef(identity);
  customerRef.current = identity;
  const sendingRef = useRef(false);
  const listRef = useRef(null);
  const knownIdsRef = useRef(new Set());
  const close = useCallback(() => {
    if (!sendingRef.current) onClose();
  }, [onClose]);
  const panelRef = useModalFocus(open, close);

  // Drop everything that belonged to the previous customer the moment the
  // id changes — a late response for the old customer is discarded by seq.
  useEffect(() => {
    seqRef.current += 1;
    setMessages([]);
    setLoaded(false);
    setLoadError("");
    setSendError("");
    setSentNote("");
    setPendingNew(0);
    setLiveNote("");
    knownIdsRef.current = new Set();
    const base = identity ? readDraft(identity) || initialDraft : "";
    draftRef.current = base;
    setDraft(base);
  }, [identity, initialDraft]);

  // appendDraft joins onto the draft the panel already holds — including
  // whatever the operator may have typed already, or an appendDraft-aware
  // mount the reset effect above (which does not know about appendDraft)
  // would otherwise clobber back to the plain seeded value in the SAME
  // post-mount effect flush. Started at a sentinel that never equals a
  // real appendDraft value, so this DOES fire on mount too — after the
  // reset effect's setDraft — and is guarded only against re-applying the
  // SAME value again on a later re-render that does not change it.
  const appliedAppendDraftRef = useRef(undefined);
  useEffect(() => {
    if (appendDraft && appendDraft !== appliedAppendDraftRef.current) {
      // No setState updater here (Codex #4709 P1): the next draft is
      // computed once from draftRef, then set and persisted synchronously,
      // so StrictMode's double-invoked updaters and re-run mount effects
      // can neither strip the wrong line nor lose an unpersisted append.
      const remembered = identity ? readConsultationLine(identity) : "";
      const next = combineAppendedDraft(draftRef.current, appendDraft, remembered);
      draftRef.current = next;
      setDraft(next);
      if (identity) {
        writeDraft(identity, next);
        writeConsultationLine(identity, consultationLineOf(appendDraft));
      }
    }
    appliedAppendDraftRef.current = appendDraft;
  }, [appendDraft, identity]);

  const isNearBottom = () => {
    const el = listRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  };
  const scrollToBottom = () => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const markRead = useCallback(async (rows, forCustomerId, seq) => {
    const unreadIds = rows
      .filter((m) => m.channel === "sms" && m.direction === "inbound" && !m.isRead && m.id)
      .map((m) => m.id);
    if (!unreadIds.length) return;
    try {
      await adminFetch("/admin/communications/messages/read", {
        method: "POST",
        body: JSON.stringify({ messageIds: unreadIds }),
      });
      if (seq !== seqRef.current || customerRef.current !== forCustomerId) return;
      setMessages((prev) => prev.map((m) => (unreadIds.includes(m.id) ? { ...m, isRead: true } : m)));
      notifyUnreadChanged();
    } catch {
      /* unread stays unread; the next load or the inbox can mark it */
    }
  }, []);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!identity) return;
    const seq = ++seqRef.current;
    const forCustomerId = identity;
    if (!silent) {
      setLoading(true);
      setLoadError("");
    }
    try {
      const data = await adminFetch(customerId
        ? `/admin/customers/${customerId}/comms?limit=100`
        : `/admin/communications/log?phone=${encodeURIComponent(phone)}&limit=100`);
      if (seq !== seqRef.current || customerRef.current !== forCustomerId) return;
      const rows = [...(data?.comms || (data?.messages || []).map((m) => ({ ...m, channel: "sms", deliveryStatus: m.status })))].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const wasNearBottom = isNearBottom();
      const fresh = rows.filter((m) => m.id && !knownIdsRef.current.has(m.id));
      const hadAny = knownIdsRef.current.size > 0;
      knownIdsRef.current = new Set(rows.map((m) => m.id).filter(Boolean));
      setMessages(rows);
      setLoaded(true);
      setLoadError("");
      if (hadAny && fresh.length) {
        const inboundFresh = fresh.filter((m) => m.direction === "inbound").length;
        if (inboundFresh) setLiveNote(`${inboundFresh} new message${inboundFresh === 1 ? "" : "s"} from ${name}`);
        if (!wasNearBottom) setPendingNew((n) => n + fresh.length);
      }
      if (!hadAny || wasNearBottom) {
        requestAnimationFrame(scrollToBottom);
      }
      await markRead(rows, forCustomerId, seq);
    } catch (err) {
      if (seq !== seqRef.current || customerRef.current !== forCustomerId) return;
      setLoadError(err?.message || "Could not load messages");
    } finally {
      if (seq === seqRef.current && customerRef.current === forCustomerId) setLoading(false);
    }
  }, [identity, customerId, phone, markRead, name]);

  // Load on open; refresh on the bell's bounded cadence while open and
  // visible; refresh again when the tab regains focus. All listeners go
  // away on close or customer switch.
  useEffect(() => {
    if (!open || !identity) return undefined;
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load({ silent: true });
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") load({ silent: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      seqRef.current += 1; // any in-flight response is discarded
    };
  }, [open, identity, load]);

  const onDraftChange = (value) => {
    setDraft(value);
    if (identity) writeDraft(identity, value);
    if (sendError) setSendError("");
    if (sentNote) setSentNote("");
  };

  const send = async () => {
    const body = draft.trim();
    if (sendingRef.current || !body || !phone || !identity) return;
    const forCustomerId = identity;
    const to = phone;
    sendingRef.current = true;
    setSending(true);
    setSendError("");
    setSentNote("");
    try {
      const result = await adminFetch(leadId ? `/admin/leads/${leadId}/send-sms` : "/admin/communications/sms", {
        method: "POST",
        body: JSON.stringify(leadId ? { message: body, to } : { to, body, ...(customerId ? { customerId } : {}), messageType: "manual" }),
      });
      if (!isAcceptedSms(result)) {
        throw new Error(result?.reason || result?.error || "Text was not handed to the provider. Your draft is retained.");
      }
      if (customerRef.current === forCustomerId) {
        setDraft("");
        setSentNote("Provider accepted; delivery is not yet confirmed.");
      }
      writeDraft(forCustomerId, "");
      notifyUnreadChanged();
      onSent?.();
      if (customerRef.current === forCustomerId) await load({ silent: true });
    } catch (err) {
      if (customerRef.current === forCustomerId) setSendError(err?.message || "Text failed to send");
    } finally {
      sendingRef.current = false;
      if (customerRef.current === forCustomerId) setSending(false);
    }
  };

  if (!open || !identity) return null;

  const fullConversationHref = customerId && messages.length
    ? `/admin/communications?thread=${encodeURIComponent(customerId)}`
    : `/admin/communications?phone=${encodeURIComponent(phone)}&action=sms`;

  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Messages with ${name}`}
      tabIndex={-1}
      className={cn(
        "admin-shell-v2 fixed z-[1050] bg-white flex flex-col outline-none text-zinc-900",
        isMobile ? "inset-0" : "top-0 right-0 bottom-0 w-[420px] max-w-full border-0 border-l border-solid border-zinc-300 shadow-lg",
      )}
      style={isMobile ? { paddingTop: "env(safe-area-inset-top, 0px)" } : undefined}
    >
      <div className="flex items-center gap-3 px-4 py-3 border-0 border-b border-solid border-zinc-200 shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-16 font-medium text-zinc-900 truncate">{name}</div>
          <div className="u-nums text-14 text-ink-secondary truncate">{phone || "No mobile number on file"}</div>
        </div>
        <Link to={fullConversationHref} aria-disabled={sending || undefined} onClick={(event) => { if (sendingRef.current) event.preventDefault(); }} className="text-14 text-zinc-900 underline underline-offset-2 whitespace-nowrap u-focus-ring rounded-xs">
          Open full conversation
        </Link>
        <button
          type="button"
          onClick={close}
          disabled={sending}
          aria-label="Close messages"
          className="inline-flex items-center justify-center h-11 w-11 rounded-sm border-0 bg-transparent text-zinc-900 hover:bg-zinc-50 u-focus-ring"
        >
          <X size={20} strokeWidth={1.75} aria-hidden />
        </button>
      </div>

      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-2" aria-busy={loading}>
        {loading && !loaded ? <div className="text-14 text-ink-secondary text-center py-6" role="status">Loading messages…</div> : null}
        {loadError ? (
          <div role="alert" className="flex items-center justify-between gap-3 px-3 py-2 rounded-sm border-hairline border-zinc-300 bg-zinc-50 text-14">
            <span>{loaded ? "Could not refresh — showing the last loaded messages." : loadError}</span>
            <Button size="sm" variant="secondary" onClick={() => load()}>Retry</Button>
          </div>
        ) : null}
        {loaded && !messages.length && !loadError ? <div className="text-14 text-ink-secondary text-center py-6">No messages yet.</div> : null}
        {messages.map((m, i) => <MessageBubble key={m.id || i} m={m} />)}
      </div>

      {pendingNew > 0 ? (
        <div className="px-4 pb-2 shrink-0">
          <Button
            size="sm"
            variant="secondary"
            className="w-full"
            onClick={() => {
              setPendingNew(0);
              scrollToBottom();
            }}
          >
            {pendingNew} new message{pendingNew === 1 ? "" : "s"} — jump to latest
          </Button>
        </div>
      ) : null}
      <div role="status" aria-live="polite" className="sr-only">{liveNote}</div>

      <div
        className="shrink-0 border-0 border-t border-solid border-zinc-200 px-4 pt-3"
        style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px) + var(--keyboard-inset, 0px))" }}
      >
        {phone ? (
          <>
            <label htmlFor="c360-sms-draft" className="sr-only">Message to {name}</label>
            <Textarea
              id="c360-sms-draft"
              rows={2}
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Type a message… (Enter to send, Shift+Enter for a new line)"
              className="text-16"
              disabled={sending}
            />
            <div className="flex items-center justify-between gap-3 mt-2">
              <div className="min-w-0 text-14" aria-live="polite">
                {sendError ? <span className="text-alert-fg">{sendError}</span> : null}
                {!sendError && sentNote ? <span className="text-ink-secondary">{sentNote}</span> : null}
              </div>
              <Button onClick={send} disabled={sending || !draft.trim()} className="shrink-0">
                {sending ? "Sending…" : "Send text"}
              </Button>
            </div>
          </>
        ) : (
          <div className="text-14 text-ink-secondary">This customer has no mobile number on file, so a text cannot be sent.</div>
        )}
      </div>
    </div>
  );

  return createPortal(
    <>
      {isMobile ? null : <div className="fixed inset-0 z-[1049] bg-zinc-900/20" onClick={close} aria-hidden />}
      {panel}
    </>,
    document.body,
  );
}


const ConversationContext = createContext(null);
export function useCustomerSms() { return useContext(ConversationContext); }

// Pipeline uses the same panel as Customer 360, so opening Messages leaves
// editor form state mounted. A lead without an account is scoped by phone.
export function CustomerSmsProvider({ children }) {
  const [conversation, setConversation] = useState(null);
  const open = useCallback((customer, options = {}) => setConversation({ customer, ...options }), []);
  return <ConversationContext.Provider value={open}>
    {children}
    {conversation && <CustomerSmsPanel key={conversation.customer.id || conversation.customer.phone}
      {...conversation} open onClose={() => setConversation(null)} />}
  </ConversationContext.Provider>;
}
