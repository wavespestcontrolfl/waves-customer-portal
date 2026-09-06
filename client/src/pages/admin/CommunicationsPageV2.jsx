// client/src/pages/admin/CommunicationsPageV2.jsx
// Monochrome V2 of CommunicationsPage. Strict 1:1 on endpoints, payloads,
// state shape, threading logic, unread tracking, and AI-draft flow.
//
// Endpoints preserved:
//   GET  /admin/communications/log[?search=...]
//   GET  /admin/communications/stats
//   POST /admin/communications/sms
//   GET  /admin/communications/ai-auto-reply-status
//   POST /admin/communications/ai-auto-reply
//   POST /admin/communications/ai-draft
//   POST /admin/communications/rewrite-sms
//   GET  /admin/customers?search=...
//
// Scope: Full V2 redesign of all tabs. CallLogTabV2, SmsTemplatesTabV2,
// CSRCoachTabV2, EmailAutomationsPanelV2, and PushSettingsV2 each
// render here. The comms-v2 flag and V1 CommunicationsPage default
// export were retired in the V1→V2 migration; CommunicationsPage.jsx
// is retained only as a shared-utility module (ALL_NUMBERS,
// NUMBER_LABEL_MAP) consumed here and by CallLogTabV2.
//
// Daily driver: Virginia (CSR) — 8 hrs/day. SMS thread view + outbound
// composer + AI-draft suggestion is the primary workflow. Unread tracking
// drives the inbox badge.
//
// Audit focus:
// - Threading logic: messages keyed by (customer phone, business
//   number) tuple. Confirm a customer texting from a new number doesn't
//   silently merge into a different customer's thread, and that a
//   customer with multiple historical numbers shows all threads.
// - Unread tracking: stats endpoint returns counts; client maintains
//   local optimistic decrement on view. Race with inbound webhook
//   (new SMS arrives while operator is reading) — does the badge get
//   stuck or double-count?
// - AI-draft (POST /ai-draft): how is the operator-edit-then-send flow
//   handled? If the operator edits the draft, do we still send the
//   edited version (not the AI's original)? Single-flight on send?
// - SMS send (POST /sms): single-flight against double-click. Empty /
//   whitespace-only body must not submit unless image attachments are ready.
//   mediaUrls path needs the attach endpoint to complete first
//   (multipart upload race).
// - AI auto-reply toggle: server-side state; if a customer replies
//   while toggling, who handles it? Confirm the toggle flips
//   atomically and the UI reflects the actual server state on
//   refresh.
// - Search bar query against /log?search=: debounce + abort to avoid
//   stale results on a fast typer.
// - Unicode / SMS segment counting: a long SMS or one with emojis
//   crosses a 160-char (GSM-7) or 70-char (UCS-2) boundary and gets
//   split + billed per segment. Worth checking the composer warns.
// - Twilio inbound webhook (server-side via twilio-webhook.js): spam
//   block + STOP/UNSUBSCRIBE handling + dual-write to legacy + unified
//   messages. This is the untrusted-input boundary — flag any
//   missing signature verification or path that creates customers
//   from arbitrary inbound numbers without rate-limiting.
import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import {
  Bell,
  BookOpen,
  Bot,
  FileText,
  Headphones,
  Inbox,
  Loader2,
  Mail,
  MessageSquare,
  Mic,
  MicOff,
  PhoneCall,
  Sparkles,
  Zap,
  ClipboardList,
} from "lucide-react";
import { useLocation, useNavigate, useOutletContext } from "react-router-dom";
import EmailPage from "./EmailPage";
import { ALL_NUMBERS, NUMBER_LABEL_MAP } from "./CommunicationsPage";
import CallLogTabV2 from "./CallLogTabV2";
import TriageInboxTabV2 from "./TriageInboxTabV2";
import OwedTabV2 from "./OwedTabV2";
import { SmsTemplatesTabV2, CSRCoachTabV2 } from "./CommunicationsTabsV2";
import EmailTemplatesPanelV2 from "./EmailTemplatesPanelV2";
import NotificationEventsTabV2 from "./NotificationEventsTabV2";
import PushSettingsV2 from "../../components/admin/PushSettingsV2";
import CallRoutingSettingsV2 from "../../components/admin/CallRoutingSettingsV2";
import { callViaBridge } from "../../components/admin/CallBridgeLink";
import Customer360ProfileV2 from "../../components/admin/Customer360ProfileV2";
import InsertLinkSheet from "../../components/admin/InsertLinkSheet";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  Badge,
  Button,
  Card,
  Dialog,
  Radio,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  Select,
  cn,
} from "../../components/ui";
import useRenderedTabBeacon from "../../hooks/useRenderedTabBeacon";
import useSpeechDictation from "../../hooks/useSpeechDictation";
import {
  MMS_TOTAL_BUDGET_BYTES,
  fitImagesToBudget,
  formatBytes,
} from "../../utils/imageCompression";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then(async (r) => {
    if (!r.ok) {
      let serverMsg = "";
      try {
        const body = await r.clone().json();
        serverMsg =
          body?.error || body?.reason || body?.message || body?.code || "";
      } catch {
        try {
          serverMsg = (await r.text()).trim();
        } catch {
          /* ignore */
        }
      }
      const err = new Error(serverMsg || `HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    if (r.status === 204) return null;
    return r.json();
  });
}

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const mins = Math.floor((Date.now() - d) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

function formatTimestamp(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  if (isToday)
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (isYesterday)
    return (
      "Yesterday " +
      d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    );
  return (
    d.toLocaleDateString([], { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  );
}

function phoneKey(value) {
  return String(value || "").replace(/\D/g, "").slice(-10);
}

function getInitials(nameOrPhone) {
  if (!nameOrPhone) return "?";
  const trimmed = String(nameOrPhone).trim();
  if (!trimmed) return "?";
  const hasLetters = /\p{L}/u.test(trimmed);
  if (!hasLetters) {
    const digits = trimmed.replace(/\D/g, "");
    return digits.slice(-2) || "#";
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] || "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase() || trimmed[0].toUpperCase();
}

function getCustomerOptionName(customer) {
  if (!customer) return "Customer";
  const first = customer.firstName || customer.first_name || "";
  const last = customer.lastName || customer.last_name || "";
  return (
    [first, last].filter(Boolean).join(" ") ||
    customer.name ||
    customer.phone ||
    "Customer"
  );
}

function findKnownWavesNumber(value) {
  if (!value) return "";
  return ALL_NUMBERS.flatMap((group) => group.numbers.map((n) => n.number)).find(
    (number) => phoneKey(number) === phoneKey(value),
  ) || "";
}

const TABS = [
  {
    key: "events",
    label: "Message Automations",
    Icon: Zap,
  },
  { key: "sms", label: "SMS", Icon: MessageSquare },
  { key: "email", label: "Email", Icon: Mail, adminOnly: true },
  { key: "calls", label: "Calls", Icon: PhoneCall },
  { key: "triage", label: "Triage", Icon: Inbox },
  // Open promises across calls (call_commitments) — staff-wide like Calls.
  { key: "owed", label: "Promises", Icon: ClipboardList },
  // Management tabs below are owner-only (2026-08-25 role lockdown):
  // template/routing/notification CONFIG and staff-performance scoring are
  // not day-to-day comms work. Events/SMS/Calls/Triage stay staff-wide.
  {
    key: "templates",
    label: "Message Templates",
    Icon: FileText,
    adminOnly: true,
  },
  {
    key: "csr",
    label: "CSR Coach",
    Icon: Headphones,
    adminOnly: true,
  },
  {
    key: "call_routing",
    label: "Call Routing",
    Icon: Bot,
    adminOnly: true,
  },
  {
    key: "notifications",
    label: "Notifications",
    Icon: Bell,
    adminOnly: true,
  },
];
const SMS_LOG_PAGE_SIZE = 500;

// ── V2 helpers ────────────────────────────────────────────────

function smsThreadKey(phone) {
  return String(phone || "").replace(/\D/g, "").slice(-10) || "unknown";
}

// Canonical presence check for tracked customer bearer links: operators edit
// bodies, and a case-changed hostname or a dropped https:// still carries
// the SAME live token — an exact `includes` would treat that edit as a
// deletion, forget the tracking entry, and let a later recipient change
// send the previous customer's link unguarded. Compare scheme-stripped and
// lowercased on both sides (a case-mangled token path is a dead link, but
// the entry then simply lingers tracked until the line is stripped).
function linkFragment(url) {
  return String(url || "").replace(/^https?:\/\//i, "").toLowerCase();
}
function bodyHasLink(body, url) {
  const frag = linkFragment(url);
  return !!frag && String(body || "").toLowerCase().includes(frag);
}
function stripLinkLines(body, url) {
  const frag = linkFragment(url);
  if (!frag) return body;
  return body
    .split("\n")
    .filter((l) => !l.toLowerCase().includes(frag))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function smsMessageMatchesLine(message, lineNumber) {
  const lineKey = phoneKey(lineNumber);
  if (!lineKey || !message) return false;
  const messageLine = message.direction === "inbound" ? message.to : message.from;
  return phoneKey(messageLine) === lineKey;
}

function mergeSmsMessages(existing, incoming) {
  const seen = new Set(existing.map((m) => m.id));
  return [...existing, ...incoming.filter((m) => !seen.has(m.id))];
}

function StatCardV2({ label, value, sub, active, alert, onClick }) {
  const clickable = typeof onClick === "function";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      className={cn(
        "flex-1 min-w-[140px] bg-white border-hairline rounded-md p-3.5 text-left",
        "transition-colors",
        clickable && "hover:bg-zinc-50 cursor-pointer",
        active ? "border-zinc-900" : "border-zinc-200",
        !clickable && "cursor-default",
      )}
    >
      {" "}
      <div className="flex items-center gap-1.5 mb-1">
        {" "}
        <span className="text-11 uppercase tracking-label text-ink-tertiary">
          {label}
        </span>{" "}
      </div>{" "}
      <div
        className={cn(
          "text-22 font-medium u-nums",
          alert ? "text-alert-fg" : "text-zinc-900",
        )}
      >
        {value}
      </div>
      {sub && <div className="text-11 text-ink-tertiary mt-0.5">{sub}</div>}
    </button>
  );
}

function StatusBadgeV2({ status }) {
  if (!status) return null;
  const strong = status === "delivered" || status === "received";
  const alert = status === "failed";
  return (
    <Badge tone={alert ? "alert" : strong ? "strong" : "neutral"}>
      {status}
    </Badge>
  );
}

function SmsDeliveryReceiptV2({ status, readAt }) {
  const normalized = String(status || "").toLowerCase();
  if (readAt) {
    return `Read internally ${formatTimestamp(readAt)}`;
  }
  if (!normalized) return null;
  if (normalized === "delivered") return "Delivered";
  if (normalized === "sent") return "Sent to carrier";
  if (normalized === "queued" || normalized === "accepted") return "Queued";
  if (normalized === "undelivered") return "Undelivered";
  if (normalized === "failed") return "Failed";
  return normalized.replace(/_/g, " ");
}

function TypeBadgeV2({ type }) {
  if (!type) return null;
  return <Badge tone="neutral">{type.replace(/_/g, " ")}</Badge>;
}

function MessageMediaV2({ media = [], inverted = false }) {
  // A signed media URL that fails to load (expired signature, offline) left a
  // blank image box inside the bubble — on an outbound (dark) bubble that
  // reads as a big empty black rectangle. Swap failed loads for a labeled
  // chip that still links to the attachment.
  const [failed, setFailed] = useState({});
  const items = Array.isArray(media) ? media.filter((m) => m?.url) : [];
  if (!items.length) return null;
  return (
    <div className="mt-2 grid grid-cols-2 gap-1.5">
      {items.map((item, idx) => (
        <a
          key={item.key || item.url || idx}
          href={item.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "block overflow-hidden rounded-sm border-hairline u-focus-ring",
            inverted
              ? "border-white/30 bg-white/10"
              : "border-zinc-300 bg-white",
          )}
        >
          {" "}
          {failed[item.url] ? (
            <span
              className={cn(
                "flex items-center justify-center h-12 px-2 text-14",
                inverted ? "text-white/80" : "text-ink-secondary",
              )}
            >
              {item.fileName || "Attachment"}
            </span>
          ) : (
            <img
              src={item.url}
              alt={item.fileName || `SMS attachment ${idx + 1}`}
              className="h-28 w-full object-cover"
              loading="lazy"
              onError={() =>
                setFailed((f) => ({ ...f, [item.url]: true }))
              }
            />
          )}{" "}
        </a>
      ))}
    </div>
  );
}

function SmsLogItemV2({ msg: m, onReply }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = m.body && m.body.length > 80;
  const hasMedia = Array.isArray(m.media) && m.media.length > 0;
  const contactPhone = m.direction === "outbound" ? m.to : m.from;
  const ourNumber = m.direction === "outbound" ? m.from : m.to;
  const contactLabel = m.customerName || contactPhone;
  return (
    <div
      className="py-2.5 border-b border-hairline border-zinc-200 cursor-pointer"
      onClick={() => setExpanded(!expanded)}
    >
      {" "}
      <div className="flex items-start gap-2.5">
        {" "}
        <span
          className={cn(
            "text-14 leading-5 flex-shrink-0 w-5 text-center",
            m.direction === "outbound" ? "text-zinc-900" : "text-ink-secondary",
          )}
          aria-hidden
        >
          {m.direction === "outbound" ? "↑" : "↓"}
        </span>{" "}
        <div className="flex-1 min-w-0">
          {" "}
          <div className="flex items-center gap-2 flex-wrap mb-0.5">
            {" "}
            <span className="font-mono text-12 text-ink-secondary u-nums">
              {m.from} → {m.to}
            </span>
            {m.customerName && (
              <span className="text-11 text-zinc-900">({m.customerName})</span>
            )}
          </div>{" "}
          <div
            className={cn(
              "text-13 leading-normal break-words",
              expanded
                ? "whitespace-pre-wrap text-zinc-900"
                : "text-ink-secondary",
            )}
          >
            {m.body
              ? expanded
                ? m.body
                : isLong
                  ? m.body.slice(0, 80) + "…"
                  : m.body
              : hasMedia
                ? `${m.media.length} photo${m.media.length === 1 ? "" : "s"}`
                : ""}
          </div>
          {expanded && <MessageMediaV2 media={m.media} />}
        </div>{" "}
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          {" "}
          <div className="flex gap-1">
            {" "}
            <StatusBadgeV2 status={m.status} />{" "}
            <TypeBadgeV2 type={m.messageType} />{" "}
          </div>{" "}
          <span className="font-mono text-11 text-ink-tertiary">
            {timeAgo(m.createdAt)}
          </span>{" "}
        </div>{" "}
      </div>
      {expanded && (
        <div className="mt-2 ml-7 flex flex-wrap gap-2">
          {contactPhone && (
            <Button
              size="sm"
              variant="secondary"
              onClick={(e) => {
                e.stopPropagation();
                callViaBridge(contactPhone, contactLabel, ourNumber);
              }}
            >
              <PhoneCall size={13} strokeWidth={1.75} className="mr-1.5" aria-hidden />
              Call back
            </Button>
          )}
          {contactPhone && (
            <Button
              size="sm"
              variant="primary"
              onClick={(e) => {
                e.stopPropagation();
                onReply(contactPhone, ourNumber, m.customerId);
              }}
            >
              <MessageSquare size={13} strokeWidth={1.75} className="mr-1.5" aria-hidden />
              Text back
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={(e) => {
              e.stopPropagation();
              navigator.clipboard.writeText(m.body || "");
            }}
          >
            Copy
          </Button>{" "}
        </div>
      )}
    </div>
  );
}

function ConversationViewV2({
  thread,
  messages,
  onReply,
  onBack,
  onOpenProfile,
}) {
  const contactPhone = thread.contactPhone;
  const contactName = thread.customerName || contactPhone;
  const canOpenProfile = !!(thread.customerName && thread.customerId);
  return (
    <div className="flex flex-col h-full">
      {" "}
      <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3 mb-4 pb-3 border-b border-hairline border-zinc-200">
        {" "}
        <div className="flex items-center gap-2 min-w-0 md:flex-1">
          <Button size="sm" variant="secondary" onClick={onBack}>
            Back
          </Button>{" "}
          <div className="min-w-0 flex-1">
            {canOpenProfile ? (
              <button
                type="button"
                onClick={() => onOpenProfile(thread.customerId)}
                className="text-14 font-medium text-zinc-900 truncate hover:underline text-left block max-w-full"
                title="Open customer profile"
              >
                {contactName}
              </button>
            ) : (
              <div className="text-14 font-medium text-zinc-900 truncate">
                {contactName}
              </div>
            )}
            <div className="font-mono text-12 text-ink-secondary truncate">
              {contactPhone}
            </div>{" "}
          </div>{" "}
        </div>{" "}
        <div className="flex items-center gap-2 md:gap-3 shrink-0">
          <Button
            size="sm"
            variant="secondary"
            className="flex-1 md:flex-none"
            onClick={() => callViaBridge(contactPhone, contactName, thread.ourNumber)}
          >
            <PhoneCall size={13} strokeWidth={1.75} className="mr-1.5" aria-hidden />
            Call back
          </Button>{" "}
          <Button
            size="sm"
            variant="primary"
            className="flex-1 md:flex-none"
            onClick={() =>
              onReply(contactPhone, thread.ourNumber, thread.customerId)
            }
          >
            <MessageSquare size={13} strokeWidth={1.75} className="mr-1.5" aria-hidden />
            Text back
          </Button>{" "}
        </div>{" "}
      </div>{" "}
      <div className="flex-1 md:max-h-[500px] md:overflow-y-auto flex flex-col gap-2">
        {messages.map((m) => {
          const isOut = m.direction === "outbound";
          const receipt = isOut
            ? SmsDeliveryReceiptV2({ status: m.status })
            : SmsDeliveryReceiptV2({ readAt: m.readAt });
          return (
            <div
              key={m.id}
              className={cn("flex", isOut ? "justify-end" : "justify-start")}
            >
              {" "}
              <div
                className={cn(
                  "max-w-[75%] px-3.5 py-2.5 rounded-md border-hairline",
                  isOut
                    ? "bg-zinc-900 text-white border-zinc-900 rounded-br-xs"
                    : "bg-zinc-50 text-zinc-900 border-zinc-200 rounded-bl-xs",
                )}
              >
                {" "}
                <div className="text-13 leading-normal whitespace-pre-wrap break-words">
                  {/* a whitespace-only body (stray newlines) rendered as a
                      giant empty bubble under whitespace-pre-wrap — blank it;
                      bodies with content render verbatim */}
                  {(typeof m.body === "string" && m.body.trim()
                    ? m.body
                    : "") ||
                    (Array.isArray(m.media) && m.media.length ? "Photo" : "")}
                </div>{" "}
                <MessageMediaV2 media={m.media} inverted={isOut} />{" "}
                <div
                  className={cn(
                    "flex items-center gap-1.5 mt-1",
                    isOut ? "justify-end" : "justify-start",
                  )}
                >
                  {" "}
                  <span
                    className={cn(
                      "text-11",
                      isOut ? "text-white/70" : "text-ink-tertiary",
                    )}
                  >
                    {formatTimestamp(m.createdAt)}
                  </span>
                  {m.messageType && (
                    <span
                      className={cn(
                        "text-11 uppercase tracking-label",
                        isOut ? "text-white/70" : "text-ink-tertiary",
                      )}
                    >
                      {m.messageType.replace(/_/g, " ")}
                    </span>
                  )}
                  {receipt && (
                    <span
                      className={cn(
                        "text-11",
                        isOut
                          ? m.status === "failed" || m.status === "undelivered"
                            ? "text-red-200"
                            : "text-white/70"
                          : "text-ink-tertiary",
                      )}
                    >
                      {receipt}
                    </span>
                  )}
                </div>{" "}
              </div>{" "}
            </div>
          );
        })}
      </div>{" "}
    </div>
  );
}

// ── SMS tab ───────────────────────────────────────────────────

// Personalized compose prefill for the link-insert buttons. Only used when
// the composer is EMPTY — an operator-typed draft gets the bare server
// clause appended instead, so the greeting never lands mid-message. Returns
// null when there is no first name to greet with (fall back to the clause).
// The TEMPLATE copy stays plain ASCII on purpose — an em dash or curly
// quote silently flips the SMS to UCS-2 and cuts each segment from 160 to
// 70 chars. Dynamic values (name, service type) pass through untouched: a
// customer named José still gets greeted correctly, and the operator sees
// the resulting body (and char count) before sending.
export function buildReschedulePrefill({ firstName, day, serviceType, url }) {
  const first = String(firstName || "").trim();
  if (!first || !url) return null;
  return `Hi ${first}, it's Waves Pest Control. Reschedule your ${day}${
    serviceType ? ` ${serviceType}` : ""
  } visit here: ${url}`;
}

export function buildReservicePrefill({ firstName, laneLabel, url }) {
  const first = String(firstName || "").trim();
  if (!first || !url) return null;
  return `Hi ${first}, it's Waves Pest Control. Book your free${
    laneLabel ? ` ${laneLabel}` : ""
  } re-service here: ${url}`;
}

// Both-channel review ask: the /sms response says whether the email copy went.
export function reviewEmailNote(outcome) {
  if (!outcome) return "";
  if (outcome.sent) return " Review request emailed too.";
  const why = {
    text_not_sent: "the text did not go out, so the email was held back",
    no_email: "no email on file",
    email_off: "review emails are off in their preferences",
    email_blocked: "the address is suppressed",
    prefs_unavailable: "preferences could not be read",
    email_not_attempted: "the text went out but its delivery could not be recorded, so the email was held back — send it from Quick Links",
    email_uncertain: "it may or may not have gone out — check the customer's email log before sending it again",
    already_reviewed: "this customer is already marked as having left a review",
  }[outcome.reason] || "it could not be sent";
  return ` Review email skipped — ${why}.`;
}

// The Quick Links sheet's "For this customer" rows. reschedule/reservice
// keep their dedicated endpoints; the other minted kinds go through
// POST /admin/communications/customer-link. portal_login is the one static
// row in the group — same link for everyone, scheme-less per the SMS
// link policy for portal hosts. Keywords feed the sheet's search.
export const CUSTOMER_COMPOSER_LINKS = [
  { key: "reschedule", name: "Reschedule link", keywords: "appointment move change visit time", dynamic: true },
  { key: "reservice", name: "Re-service link", keywords: "free callback between visit retreat", dynamic: true },
  // channels: picking the row asks Text / Email / Both (owner ruling
  // 2026-09-03) — Text inserts the link, Email sends the review email now,
  // Both inserts the link and emails when the text is sent.
  { key: "review_request", name: "Review request", keywords: "rate rating feedback stars ask google email", dynamic: true, channels: true },
  { key: "pay_balance", name: "Pay balance link", keywords: "pay payment invoice bill billing owe money", dynamic: true },
  { key: "estimate", name: "Latest estimate link", keywords: "estimate proposal open pending price quote", dynamic: true },
  { key: "referral", name: "Referral link", keywords: "refer friend neighbor share reward", dynamic: true },
  { key: "autopay_setup", name: "Auto Pay setup link", keywords: "autopay auto pay card on file save payment method bank ach enroll secure", dynamic: true },
  { key: "appointment", name: "Appointment page link", keywords: "appointment visit details confirm calendar upcoming next", dynamic: true },
  { key: "card_request", name: "Card request link", keywords: "card request secure appointment hold card on file first visit", dynamic: true },
  { key: "prep_guide", name: "Prep guide link", keywords: "prep prepare checklist flea bed bug cockroach roach treatment", dynamic: true },
  { key: "service_report", name: "Latest service report link", keywords: "report service report visit summary last recap", dynamic: true },
  { key: "contract", name: "Contract signing link", keywords: "contract sign signature agreement document esign", dynamic: true },
  { key: "statement", name: "Statement pay link", keywords: "statement payer bill-to property manager builder net30 pay", dynamic: true },
  { key: "project_report", name: "Project report link", keywords: "project report wdo termite inspection specialty findings pdf", dynamic: true },
  {
    key: "portal_login",
    name: "Portal login",
    url: "portal.wavespestcontrol.com/login",
    clause: "Manage your account and appointments here",
    keywords: "portal login account app sign in manage",
  },
  // Cancellation lands IN the portal (owner ruling 2026-09-03): the cancel
  // flow lives on the My Plan tab behind login, so the link is the login
  // page with the plan tab as its post-login destination (LoginPage's
  // safeNextPath honors ?next=; same encoded form the project emails use).
  {
    key: "cancel_plan",
    name: "Cancel plan link",
    url: "portal.wavespestcontrol.com/login?next=%2F%3Ftab%3Dplan",
    clause: "You can review or cancel your plan from your account here",
    keywords: "cancel cancellation stop plan end service quit",
  },
].map((l) => ({ ...l, category: "customer" }));

// Personalized empty-composer prefill for the generic minted links (the
// reschedule/re-service builders above stay specialized). `clause` is the
// server's ready-made sentence, trimmed of its trailing clause newlines.
// Same plain-ASCII template rule as the builders above.
export function buildCustomerLinkPrefill({ firstName, clause }) {
  const first = String(firstName || "").trim();
  const line = String(clause || "").trim();
  if (!first || !line) return null;
  return `Hi ${first}, it's Waves Pest Control. ${line}`;
}

// Append a static link clause to the composer body (empty body gets the
// clause alone). Returns the body unchanged when the URL is already present
// — a second click must not stack a duplicate link.
export function appendStaticLinkClause(body, { url, clause }) {
  const b = String(body || "");
  if (b.includes(url)) return b;
  if (!b.trim()) return clause;
  return `${b.replace(/\s+$/, "")}\n\n${clause}`;
}

// The rendered insert text for a library row: "{clause}: {url}" with the
// row's name standing in when no clause was authored (sitemap rows).
export function libraryLinkClause(link) {
  const prefix = String(link.clause || "").trim() || String(link.name || "").trim() || "More info";
  return `${prefix}: ${link.url}`;
}

function SmsTab({ active }) {
  // Prep-guide sender lives with the composer's other outbound actions.
  const [prepSendOpen, setPrepSendOpen] = useState(false);
  // Server-verified role: draft APPROVAL is owner-only (PUT /approve and
  // /revise 403 for technicians). A tech following a draftId deep link
  // still gets the prefilled text/recipient, but sends as a plain manual
  // SMS — the AI draft stays pending for the owner (codex P2).
  const smsOutletContext = useOutletContext();
  const smsIsAdminRole = smsOutletContext?.user?.role === "admin";
  const [messages, setMessages] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [smsFilter, setSmsFilter] = useState("all");

  const [aiAutoReply, setAiAutoReply] = useState(false);
  const [togglingAi, setTogglingAi] = useState(false);

  // Compose
  const [toNumber, setToNumber] = useState("");
  const [toSearch, setToSearch] = useState("");
  const [toResults, setToResults] = useState([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState(null);
  const [fromNumber, setFromNumber] = useState("+19413187612");
  const [msgBody, setMsgBody] = useState("");
  const [sending, setSending] = useState(false);
  // Mirrors `sending` for async code that must not act mid-send: canceling
  // a review row while its /sms is in flight can land before the server's
  // delivered-marking and suppress an ask the customer actually received.
  const sendInFlightRef = useRef(false);
  const [sendResult, setSendResult] = useState(null);
  const [aiDrafting, setAiDrafting] = useState(false);
  const [insertingResched, setInsertingResched] = useState(false);
  // The last inserted reschedule link and the recipient it was minted for:
  // { url, recipientKey, customerId }. The bearer link must not outlive its
  // recipient — the effect below strips it from the body if To changes.
  const [insertedResched, setInsertedResched] = useState(null);
  const [insertingReservice, setInsertingReservice] = useState(false);
  // Same contract for the standing re-service link (free between-visit
  // callback booking) — a bearer credential tracked per recipient.
  const [insertedReservice, setInsertedReservice] = useState(null);
  const [rewritingSms, setRewritingSms] = useState(false);
  const [agentDraft, setAgentDraft] = useState(null);
  const [agentDraftLoading, setAgentDraftLoading] = useState(false);
  const [selectedAgentDraft, setSelectedAgentDraft] = useState(null);
  const [loadedMessageDraft, setLoadedMessageDraft] = useState(null);
  // MMS attachments: [{ url, key, fileName, size, mimeType, previewUrl }, ...]
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  // Purely a label distinction — `uploading` gates the controls for the whole
  // compress-then-upload span. Downscaling several phone photos takes a beat,
  // and "Uploading…" while the network is still idle reads as a stall.
  const [compressing, setCompressing] = useState(false);
  // Delayed send: 'now' | 'tomorrow_8' | 'custom'. Mirrors invoice builder pattern.
  // Scheduled rows land in sms_log with status='scheduled' and are picked up by
  // the /5min cron in server/services/scheduler.js.
  const [sendTiming, setSendTiming] = useState("now");
  const [sendCustomAt, setSendCustomAt] = useState("");
  const dictation = useSpeechDictation((text) => {
    setMsgBody((b) => (b ? `${b} ${text}` : text));
  });
  const { listening, supported: dictationSupported, toggle: toggleDictation } =
    dictation;
  useEffect(() => {
    if (!active && listening) toggleDictation();
  }, [active, listening, toggleDictation]);
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  const [showAttachSheet, setShowAttachSheet] = useState(false);
  // Insert Link sheet — the searchable link library (customer links +
  // reviews + the whole website + app stores + socials).
  const [showLinkSheet, setShowLinkSheet] = useState(false);
  // Library rows from GET /admin/communications/link-library, fetched once
  // per page load on first open (search/filtering is client-side).
  const [libraryLinks, setLibraryLinks] = useState(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState(null);
  // Which minted customer link is mid-lookup ('reschedule' | 'reservice' |
  // a /customer-link kind), and the inserted minted links being tracked per
  // kind: { url, recipientKey, customerId, requestId?, contractId? }. Same bearer-link
  // strip contract as insertedResched/insertedReservice above.
  const [insertingCustomerLink, setInsertingCustomerLink] = useState(null);
  const [insertedCustomerLinks, setInsertedCustomerLinks] = useState({});

  // Filters
  const [dirFilter, setDirFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");

  // Threading
  const [smsView, setSmsView] = useState("threads");
  const [activeThread, setActiveThread] = useState(null);
  const [smsSearch, setSmsSearch] = useState("");
  // PR 4 — status filter chips, reply-from lock.
  const [statusFilter, setStatusFilter] = useState("all");
  const [threadLock, setThreadLock] = useState(null);
  const [selected360Id, setSelected360Id] = useState(null);
  const [smsPage, setSmsPage] = useState(1);
  const [smsHasMore, setSmsHasMore] = useState(false);
  const [smsLoadingMore, setSmsLoadingMore] = useState(false);
  const smsSearchRef = useRef("");
  const smsLoadSeqRef = useRef(0);
  const rewriteContextRef = useRef({
    toNumber: "",
    selectedCustomerId: null,
    fromNumber: "",
    activeThreadKey: "",
  });
  rewriteContextRef.current = {
    toNumber,
    selectedCustomerId,
    fromNumber,
    activeThreadKey: activeThread?.contactPhone ? smsThreadKey(activeThread.contactPhone) : "",
  };

  const loadData = useCallback((search = "", options = {}) => {
    const normalizedSearch = search.trim();
    const page = options.page || 1;
    const append = !!options.append;
    const requestSeq = ++smsLoadSeqRef.current;
    const params = new URLSearchParams({
      limit: String(SMS_LOG_PAGE_SIZE),
      page: String(page),
    });
    if (normalizedSearch) params.set("search", normalizedSearch);
    const logUrl = `/admin/communications/log?${params.toString()}`;
    return Promise.all([
      adminFetch(logUrl).catch(() => ({ messages: [] })),
      adminFetch("/admin/communications/stats").catch(() => null),
    ]).then(([logData, statsData]) => {
      if (
        requestSeq !== smsLoadSeqRef.current ||
        normalizedSearch !== smsSearchRef.current
      ) {
        return;
      }
      const nextMessages = logData.messages || [];
      setMessages((prev) =>
        append ? mergeSmsMessages(prev, nextMessages) : nextMessages,
      );
      setSmsPage(logData.page || page);
      setSmsHasMore(!!logData.hasMore);
      setStats(statsData);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    smsSearchRef.current = smsSearch.trim();
    const t = setTimeout(() => {
      loadData(smsSearch.trim());
    }, 300);
    return () => clearTimeout(t);
  }, [smsSearch, loadData]);

  const markMessagesRead = useCallback(
    async (thread) => {
      const threadMessages = Array.isArray(thread?.messages)
        ? thread.messages
        : Array.isArray(thread?.messagesList)
          ? thread.messagesList
          : [];
      const unreadIds = threadMessages
        .filter((m) => m.direction === "inbound" && !m.isRead)
        .map((m) => m.id)
        .filter(Boolean);
      const conversationIds = [
        ...new Set(threadMessages.map((m) => m.conversationId).filter(Boolean)),
      ];
      const readBefore =
        thread?.lastTimestamp ||
        threadMessages.reduce(
          (latest, m) =>
            !latest || new Date(m.createdAt) > new Date(latest)
              ? m.createdAt
              : latest,
          null,
        );
      if (!unreadIds.length && !conversationIds.length) return;

      const readAt = new Date().toISOString();
      setMessages((prev) =>
        prev.map((m) =>
          unreadIds.includes(m.id) ? { ...m, isRead: true, readAt } : m,
        ),
      );
      setActiveThread((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          messages: prev.messages.map((m) =>
            unreadIds.includes(m.id) ? { ...m, isRead: true, readAt } : m,
          ),
        };
      });

      try {
        await adminFetch("/admin/communications/messages/read", {
          method: "POST",
          body: JSON.stringify({
            messageIds: unreadIds,
            conversationIds,
            readBefore,
          }),
        });
      } catch {
        loadData(smsSearch.trim());
      }
    },
    [loadData, smsSearch],
  );

  useEffect(() => {
    adminFetch("/admin/communications/ai-auto-reply-status")
      .then((d) => setAiAutoReply(d.enabled))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const phone = toNumber.trim();
    if (!phone && !selectedCustomerId) {
      setAgentDraft(null);
      setAgentDraftLoading(false);
      setSelectedAgentDraft(null);
      return;
    }

    let cancelled = false;
    const t = setTimeout(() => {
      const params = new URLSearchParams();
      if (selectedCustomerId) params.set("customerId", selectedCustomerId);
      if (phone) params.set("phone", phone);
      setAgentDraftLoading(true);
      adminFetch(`/admin/communications/agent-draft?${params.toString()}`)
        .then((d) => {
          if (!cancelled) setAgentDraft(d?.draft || null);
        })
        .catch(() => {
          if (!cancelled) setAgentDraft(null);
        })
        .finally(() => {
          if (!cancelled) setAgentDraftLoading(false);
        });
    }, 200);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [toNumber, selectedCustomerId]);

  useEffect(() => {
    setSelectedAgentDraft(null);
  }, [toNumber, selectedCustomerId]);

  useEffect(() => {
    setSelectedAgentDraft((current) => {
      if (!current) return null;
      return current.decisionId === agentDraft?.decisionId ? current : null;
    });
  }, [agentDraft?.decisionId]);

  // Prefill compose from deep links (Estimates/Customers SMS button, Agent Ops drafts).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const phone = params.get("phone");
    const queryFromNumber = findKnownWavesNumber(params.get("fromNumber"));
    if (phone) {
      setToNumber(phone);
      setToSearch("");
      setSelectedCustomerId(null);
      if (queryFromNumber) {
        setFromNumber(queryFromNumber);
        setThreadLock({
          contactPhone: phone,
          ourNumber: queryFromNumber,
          label: NUMBER_LABEL_MAP[queryFromNumber] || queryFromNumber,
        });
      }
    }
    const draftId = params.get("draftId");
    if (draftId) {
      adminFetch(`/admin/drafts/${encodeURIComponent(draftId)}`)
        .then((draft) => {
          if (draft?.draftResponse) setMsgBody(draft.draftResponse.slice(0, 1000));
          const draftPhone = draft?.recipientPhone || draft?.customerPhone || "";
          let finalPhone = phone || draftPhone;
          if (draftPhone && (!phone || phoneKey(phone) !== phoneKey(draftPhone))) {
            setToNumber(draftPhone);
            finalPhone = draftPhone;
          }
          // The draft payload carries the CONFIG-resolved From
          // (resolvedFromNumber/-Label come from TWILIO_NUMBERS on the
          // server — the same authority the send path uses), so the
          // composer thread-locks to the conversation's own line without
          // consulting the client's hardcoded list; a GBP-tracking-anchored
          // thread would otherwise fall to the composer default and split
          // (Codex #3700 r6 P1). This also records the from-number the
          // STATE is becoming, not the initial closure value — a stale
          // capture would trip the mismatch effect below and silently
          // detach the draft (r2 P1).
          const draftFrom = draft?.resolvedFromNumber || queryFromNumber || null;
          if (draftFrom) {
            // Lock UNCONDITIONALLY when a resolved From exists — even when
            // it equals the composer default, an editable selector would
            // let a From change clear loadedMessageDraft and quietly turn
            // the approval into a manual send (Codex r7 P1). Only the
            // state write is guarded on inequality.
            if (draftFrom !== fromNumber) setFromNumber(draftFrom);
            setThreadLock({
              contactPhone: finalPhone,
              ourNumber: draftFrom,
              label: draft?.resolvedFromLabel || NUMBER_LABEL_MAP[draftFrom] || draftFrom,
            });
          }
          setLoadedMessageDraft(smsIsAdminRole && draft?.id ? {
            id: draft.id,
            draftResponse: draft.draftResponse || "",
            recipientPhone: finalPhone,
            fromNumber: draftFrom || fromNumber,
          } : null);
          if (draft?.customerId && draft?.customerPhone && phoneKey(finalPhone) === phoneKey(draft.customerPhone)) {
            setSelectedCustomerId(draft.customerId);
          } else {
            setSelectedCustomerId(null);
          }
        })
        .catch(() => {
          setLoadedMessageDraft(null);
        });
      return;
    }
    const draft = params.get("draft");
    if (draft) setMsgBody(draft.slice(0, 1000));
    setLoadedMessageDraft(null);
  }, []);

  useEffect(() => {
    if (!loadedMessageDraft?.id) return;
    if (
      phoneKey(toNumber) !== phoneKey(loadedMessageDraft.recipientPhone) ||
      fromNumber !== loadedMessageDraft.fromNumber
    ) {
      setLoadedMessageDraft(null);
    }
  }, [fromNumber, loadedMessageDraft, toNumber]);

  const toggleAiAutoReply = async () => {
    setTogglingAi(true);
    try {
      const r = await adminFetch("/admin/communications/ai-auto-reply", {
        method: "POST",
        body: JSON.stringify({ enabled: !aiAutoReply }),
      });
      setAiAutoReply(r.enabled);
    } catch {
      /* ignore */
    }
    setTogglingAi(false);
  };

  // Compute the scheduled-for value as an ET-naive wall-clock string
  // (YYYY-MM-DDTHH:MM) or null if "now". The server parses ET-naive strings
  // via parseETDateTime() — emitting ISO/UTC here would lose the ET intent
  // when the admin browser isn't on America/New_York. Mirrors the invoice
  // builder's invoiceScheduledFor() pattern.
  const etDateOnly = (date) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  };
  const resolveScheduledFor = () => {
    if (sendTiming === "now") return { value: null, error: null };
    if (sendTiming === "tomorrow_8") {
      const [y, m, d] = etDateOnly(new Date()).split("-").map(Number);
      // Build "tomorrow in ET" by adding 1 day at UTC noon (collision-free
      // around DST boundaries), then re-format in ET.
      const tomorrow = new Date(Date.UTC(y, m - 1, d + 1, 12, 0, 0));
      return { value: `${etDateOnly(tomorrow)}T08:00`, error: null };
    }
    if (!sendCustomAt) return { value: null, error: "Pick a date and time" };
    return { value: sendCustomAt, error: null };
  };
  // Format the ET-naive string for the confirmation toast without
  // routing through `new Date(etNaive)`, which would interpret the
  // wall-clock parts in the admin browser's timezone. Stuffing the ET
  // parts into a UTC instant and formatting in UTC reproduces the
  // intended ET wall-clock 1:1.
  const formatScheduledForToast = (etNaive) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(etNaive);
    if (!m) return etNaive;
    const utc = new Date(
      Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])),
    );
    return utc.toLocaleString("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const handleSend = async () => {
    if (!toNumber.trim() || (!msgBody.trim() && attachments.length === 0))
      return;
    const { value: scheduledFor, error: scheduleErr } = resolveScheduledFor();
    if (scheduleErr) {
      setSendResult({ ok: false, text: scheduleErr });
      return;
    }
    if (scheduledFor && attachments.length > 0) {
      setSendResult({
        ok: false,
        text: "Attachments aren't supported on scheduled sends yet — send now, or remove attachments.",
      });
      return;
    }
    if (loadedMessageDraft?.id && scheduledFor) {
      setSendResult({ ok: false, text: "Send draft SMS now, or clear the draft before scheduling." });
      return;
    }
    if (loadedMessageDraft?.id && attachments.length > 0) {
      setSendResult({ ok: false, text: "Draft approval does not support attachments. Remove attachments or start a new SMS." });
      return;
    }
    // A composer-inserted review link is marked delivered by the immediate
    // /sms send. The scheduled and draft-approval paths can't do that yet,
    // so a review ask riding them would go out untracked — invisible to the
    // 3-in-180d cap and cooldown — and could double-ask later. Block instead.
    if (insertedCustomerLinks.review_request && (scheduledFor || loadedMessageDraft?.id)) {
      setSendResult({
        ok: false,
        text: "Review request links can only go on an immediate send — send now, or remove the review link first.",
      });
      return;
    }
    // A per-row bearer credential (Auto Pay setup, contract signing, prep
    // guide — anything the server minted with an expiresAt — plus the
    // kinds it flags immediateOnly: card request, statement pay, appointment
    // page, service report, project report) is only
    // re-checked at delivery on the immediate send; the schedule picker has
    // no upper bound and a draft dispatches without a re-check. Immediate
    // sends only, same rule as review links (the server re-fences).
    {
      const bearer = Object.entries(insertedCustomerLinks).find(([, entry]) => entry?.expiresAt || entry?.immediateOnly);
      if (bearer && (scheduledFor || loadedMessageDraft?.id)) {
        const name = CUSTOMER_COMPOSER_LINKS.find((l) => l.key === bearer[0])?.name || "This";
        setSendResult({
          ok: false,
          text: `${name}s are re-checked at delivery — send now, or remove that link first.`,
        });
        return;
      }
    }
    // SYNCHRONOUS bearer-link check at the send boundary: the recipient-
    // change strip runs in an effect (and defers while `sending`), so a
    // recipient edit followed immediately by Send can race it and transmit
    // the PREVIOUS customer's tokenized pay/estimate/review URL. Re-verify
    // every tracked link still in the body against the current recipient
    // right now; any mismatch refuses the send — the effect strips the
    // stale line as soon as it runs.
    {
      const trimmedTo = toNumber.trim();
      const recipientKey = trimmedTo ? smsThreadKey(trimmedTo) : "";
      const staleLink = Object.values(insertedCustomerLinks).some(
        (entry) =>
          bodyHasLink(msgBody, entry.url) &&
          (entry.recipientKey !== recipientKey ||
            (selectedCustomerId || null) !== entry.customerId),
      );
      if (staleLink) {
        setSendResult({
          ok: false,
          text: "A customer link in this message was minted for a different recipient — remove it and re-insert before sending.",
        });
        return;
      }
    }
    setSending(true);
    sendInFlightRef.current = true;
    setSendResult(null);
    try {
      if (loadedMessageDraft?.id) {
        const original = String(loadedMessageDraft.draftResponse || "").trim();
        const revised = msgBody.trim();
        if (revised === original) {
          await adminFetch(`/admin/drafts/${encodeURIComponent(loadedMessageDraft.id)}/approve`, {
            method: "PUT",
            body: JSON.stringify({ fromNumber }),
          });
        } else {
          await adminFetch(`/admin/drafts/${encodeURIComponent(loadedMessageDraft.id)}/revise`, {
            method: "PUT",
            body: JSON.stringify({ revisedResponse: revised, fromNumber }),
          });
        }
        setSendResult({ ok: true, text: "Draft sent." });
      } else if (scheduledFor) {
        await adminFetch("/admin/communications/schedule-sms", {
          method: "POST",
          body: JSON.stringify({
            to: toNumber.trim(),
            body: msgBody.trim(),
            customerId: selectedCustomerId || undefined,
            messageType: "manual",
            fromNumber,
            scheduledFor,
            agentDecisionId: selectedAgentDraft?.decisionId || undefined,
            agentDraft: selectedAgentDraft?.suggestedMessage || undefined,
          }),
        });
        setSendResult({
          ok: true,
          text: `Scheduled for ${formatScheduledForToast(scheduledFor)}.`,
        });
      } else {
        const sent = await adminFetch("/admin/communications/sms", {
          method: "POST",
          body: JSON.stringify({
            to: toNumber.trim(),
            body: msgBody.trim(),
            customerId: selectedCustomerId || undefined,
            messageType: "manual",
            fromNumber,
            mediaUrls:
              attachments.length > 0
                ? attachments.map((a) => a.url)
                : undefined,
            mediaAttachments:
              attachments.length > 0
                ? attachments.map(({ previewUrl, ...a }) => a)
                : undefined,
            agentDecisionId: selectedAgentDraft?.decisionId || undefined,
            agentDraft: selectedAgentDraft?.suggestedMessage || undefined,
            // The send that just left IS the review ask — the server marks
            // the inline review_requests row delivered (see /sms route).
            reviewRequestId: insertedCustomerLinks.review_request?.requestId || undefined,
            // Both: email the same ask once the text has really sent.
            reviewRequestEmail: insertedCustomerLinks.review_request?.emailToo ? true : undefined,
            // A freshly inserted contract signing link is unwritten until
            // this send activates it — the server needs the contract it names.
            contractId: insertedCustomerLinks.contract?.contractId || undefined,
          }),
        });
        setSendResult({ ok: true, text: `Message sent.${reviewEmailNote(sent?.reviewEmail)}` });
      }
      setToNumber("");
      setToSearch("");
      setSelectedCustomerId(null);
      setMsgBody("");
      // Cleared in the same batch as the body: the strip effect must see the
      // sent links as already forgotten, not as operator-withdrawn (which
      // would cancel a review ask that just went out).
      setInsertedCustomerLinks({});
      setAgentDraft(null);
      setSelectedAgentDraft(null);
      setLoadedMessageDraft(null);
      // Release blob preview URLs before clearing so we don't leak them.
      for (const a of attachments) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
      setAttachments([]);
      setSendTiming("now");
      setSendCustomAt("");
      loadData(smsSearch.trim());
    } catch (e) {
      setSendResult({ ok: false, text: `Failed: ${e.message}` });
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  };

  // Upload one-or-more image files → S3 → mediaUrls. Called from the hidden
  // <input type="file">triggered by the + button.
  const handleUpload = async (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    const remaining = 10 - attachments.length;
    if (remaining <= 0) {
      alert("Max 10 attachments per message");
      return;
    }
    const queue = files.slice(0, remaining);
    // Twilio rejects an MMS whose body + all media exceeds 5MB total, so the
    // per-file 5MB cap isn't enough once several images are attached. Rather
    // than refuse the batch, shrink it to fit: a batch that already fits
    // uploads untouched, and one that doesn't sheds the least quality that
    // gets it under budget. Compressing HERE — before the upload — means the
    // multer per-file cap, the attachment token's bound size, and the
    // send-time aggregate check all see the final bytes.
    const existingBytes = attachments.reduce((s, a) => s + (a.size || 0), 0);
    setUploading(true);
    setCompressing(true);
    try {
      const fit = await fitImagesToBudget(queue, {
        availableBytes: MMS_TOTAL_BUDGET_BYTES - existingBytes,
      });
      if (!fit.ok) {
        // Report the whole tray, not just this selection, and name the target
        // we actually enforce — a 4.7MB uncompressible file is over our 4.5MB
        // safety budget while still under Twilio's 5MB ceiling.
        alert(
          `Attachments would total ${
            fit.bestBytesIsFloor ? "at least " : ""
          }${formatBytes(
            existingBytes + fit.bestBytes,
          )} even after compression, over the ${formatBytes(
            MMS_TOTAL_BUDGET_BYTES,
          )} per-message budget. Remove an image and try again.`,
        );
        return;
      }
      setCompressing(false);
      const fd = new FormData();
      for (const f of fit.files) fd.append("attachments", f);
      const token = localStorage.getItem("waves_admin_token");
      const r = await fetch(`${API_BASE}/admin/communications/attach`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `Upload failed (${r.status})`);
      }
      const d = await r.json();
      const withPreview = d.attachments.map((a, idx) => ({
        ...a,
        previewUrl: URL.createObjectURL(fit.files[idx]),
      }));
      setAttachments((prev) => [...prev, ...withPreview]);
    } catch (e) {
      alert(`Upload failed: ${e.message}`);
    } finally {
      setCompressing(false);
      setUploading(false);
    }
  };

  const removeAttachment = (idx) => {
    setAttachments((prev) => {
      const next = [...prev];
      const [removed] = next.splice(idx, 1);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return next;
    });
  };

  const handleAiDraft = async () => {
    if (!toNumber.trim()) {
      alert("Enter a To number first");
      return;
    }
    setAiDrafting(true);
    try {
      const lastMsg = messages.find(
        (m) =>
          m.direction === "inbound" &&
          (m.from === toNumber.trim() ||
            m.from?.includes(toNumber.trim().replace(/\D/g, "").slice(-10))),
      );
      const d = await adminFetch("/admin/communications/ai-draft", {
        method: "POST",
        body: JSON.stringify({
          customerPhone: toNumber.trim(),
          lastMessage: lastMsg?.body || "",
        }),
      });
      if (d.draft) setMsgBody(d.draft.slice(0, 160));
    } catch (e) {
      alert("AI draft failed: " + e.message);
    } finally {
      setAiDrafting(false);
    }
  };

  // Insert the recipient's self-serve reschedule link (their next upcoming
  // visit's tokened /reschedule page) into the message body. The server
  // resolves WHICH visit; feedback lands in the sendResult line under the
  // buttons so the operator can see what the link points to before sending.
  const handleInsertRescheduleLink = async () => {
    const requestRecipient = toNumber.trim();
    if (!requestRecipient || insertingResched) return;
    const requestRecipientKey = smsThreadKey(requestRecipient);
    const requestCustomerId = selectedCustomerId || null;
    const requestThreadKey = activeThread?.contactPhone
      ? smsThreadKey(activeThread.contactPhone)
      : "";
    // Stale-response guard (mirrors handleRewriteSms): the operator may
    // switch threads or edit the recipient while the request is in flight —
    // applying the response then would drop THIS customer's bearer link (or
    // its error) into a message addressed to someone else. Discard silently.
    const rescheduleContextChanged = () => {
      const latest = rewriteContextRef.current;
      const latestRecipient = latest.toNumber.trim();
      const latestRecipientKey = latestRecipient
        ? smsThreadKey(latestRecipient)
        : "";
      return (
        latestRecipientKey !== requestRecipientKey ||
        (latest.selectedCustomerId || null) !== requestCustomerId ||
        latest.activeThreadKey !== requestThreadKey
      );
    };
    setInsertingResched(true);
    setSendResult(null);
    try {
      // POST body, never a query string — the request logger's redacted-url
      // does not treat `phone` as sensitive, so a GET would write the
      // customer's number to the request logs on every click.
      const d = await adminFetch("/admin/communications/reschedule-link", {
        method: "POST",
        body: JSON.stringify({
          phone: requestRecipient,
          customerId: requestCustomerId || undefined,
        }),
      });
      if (rescheduleContextChanged()) return;
      const clause = (d.line || "").trim() || `Reschedule online: ${d.url}`;
      // Noon anchor keeps the Y-M-D string on its own calendar day in every
      // US zone (same idiom as the server's reschedule confirmation copy).
      const day = new Date(
        `${d.appointment.scheduledDate}T12:00:00`,
      ).toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      // Empty composer → prefill a full greeting message (recipient first
      // name + the visit the link points to); anything already typed keeps
      // the bare clause-append behavior.
      const prefill = buildReschedulePrefill({
        firstName: d.firstName,
        day,
        serviceType: d.appointment.serviceType,
        url: d.url,
      });
      // Replace-don't-stack: every lookup mints a FRESH short code, and the
      // strip-on-recipient-change effect only knows the one tracked URL — a
      // second click stacking a second clause would leave the first link
      // unstrippable. Drop any line carrying the previously tracked URL
      // before appending. (Inserts are serialized by the insertingResched
      // guard, so the click-time snapshot of insertedResched is current; if
      // the operator already deleted that line, the filter is a no-op.)
      const prevUrl = insertedResched?.url || null;
      setMsgBody((b) => {
        const base = prevUrl
          ? b
              .split("\n")
              .filter((l) => !l.includes(prevUrl))
              .join("\n")
              .replace(/\n{3,}/g, "\n\n")
              .trim()
          : b;
        return base.trim()
          ? `${base.replace(/\s+$/, "")}\n\n${clause}`
          : prefill || clause;
      });
      setInsertedResched({
        url: d.url,
        recipientKey: requestRecipientKey,
        customerId: requestCustomerId,
      });
      setSendResult({
        ok: true,
        text: `Reschedule link added — points to the ${day}${
          d.appointment.serviceType ? ` ${d.appointment.serviceType}` : ""
        } visit.`,
      });
    } catch (e) {
      if (!rescheduleContextChanged()) {
        setSendResult({ ok: false, text: e.message });
      }
    } finally {
      setInsertingResched(false);
    }
  };

  // An inserted reschedule link is a bearer credential for ONE customer's
  // visit — it must not survive a recipient change. If To (or the selected
  // customer) no longer matches what the link was minted for, strip the
  // link's line from the body and say so. Also forgets the tracked link once
  // the operator deletes it (or the body clears on send).
  useEffect(() => {
    if (!insertedResched) return;
    if (!msgBody.includes(insertedResched.url)) {
      setInsertedResched(null);
      return;
    }
    const currentRecipient = toNumber.trim();
    const currentRecipientKey = currentRecipient
      ? smsThreadKey(currentRecipient)
      : "";
    if (
      currentRecipientKey !== insertedResched.recipientKey ||
      (selectedCustomerId || null) !== insertedResched.customerId
    ) {
      setMsgBody((b) =>
        b
          .split("\n")
          .filter((l) => !l.includes(insertedResched.url))
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim(),
      );
      setInsertedResched(null);
      setSendResult({
        ok: true,
        text: "Reschedule link removed — the recipient changed.",
      });
    }
  }, [insertedResched, msgBody, toNumber, selectedCustomerId]);

  // Insert the recipient's standing self-serve re-service link (their free
  // between-visit callback booking page) into the message body. The server
  // resolves eligibility from LIVE plan state (active recurring / WaveGuard
  // only) and answers 404 with a plain reason when there is no lane.
  const handleInsertReserviceLink = async () => {
    const requestRecipient = toNumber.trim();
    if (!requestRecipient || insertingReservice) return;
    const requestRecipientKey = smsThreadKey(requestRecipient);
    const requestCustomerId = selectedCustomerId || null;
    const requestThreadKey = activeThread?.contactPhone
      ? smsThreadKey(activeThread.contactPhone)
      : "";
    // Stale-response guard (same contract as handleInsertRescheduleLink):
    // discard the response if the operator moved on mid-flight.
    const reserviceContextChanged = () => {
      const latest = rewriteContextRef.current;
      const latestRecipient = latest.toNumber.trim();
      const latestRecipientKey = latestRecipient
        ? smsThreadKey(latestRecipient)
        : "";
      return (
        latestRecipientKey !== requestRecipientKey ||
        (latest.selectedCustomerId || null) !== requestCustomerId ||
        latest.activeThreadKey !== requestThreadKey
      );
    };
    setInsertingReservice(true);
    setSendResult(null);
    try {
      // POST body, never a query string — same request-log redaction reason
      // as the reschedule lookup.
      const d = await adminFetch("/admin/communications/reservice-link", {
        method: "POST",
        body: JSON.stringify({
          phone: requestRecipient,
          customerId: requestCustomerId || undefined,
        }),
      });
      if (reserviceContextChanged()) return;
      const clause = (d.line || "").trim() || `Book your free re-service: ${d.url}`;
      const laneLabel =
        Array.isArray(d.lanes) && d.lanes.length
          ? d.lanes
              .map((l) => (l === "pest" ? "pest" : l === "lawn" ? "lawn" : l))
              .join(" + ")
          : null;
      // Empty composer → full greeting message; typed draft → clause append
      // (same contract as the reschedule insert).
      const prefill = buildReservicePrefill({
        firstName: d.firstName,
        laneLabel,
        url: d.url,
      });
      // Replace-don't-stack, same as the reschedule insert: drop any line
      // carrying the previously tracked URL before appending the fresh one.
      const prevUrl = insertedReservice?.url || null;
      setMsgBody((b) => {
        const base = prevUrl
          ? b
              .split("\n")
              .filter((l) => !l.includes(prevUrl))
              .join("\n")
              .replace(/\n{3,}/g, "\n\n")
              .trim()
          : b;
        return base.trim()
          ? `${base.replace(/\s+$/, "")}\n\n${clause}`
          : prefill || clause;
      });
      setInsertedReservice({
        url: d.url,
        recipientKey: requestRecipientKey,
        customerId: requestCustomerId,
      });
      setSendResult({
        ok: true,
        text: `Re-service link added${laneLabel ? ` — covers the ${laneLabel} plan` : ""}.`,
      });
    } catch (e) {
      if (!reserviceContextChanged()) {
        setSendResult({ ok: false, text: e.message });
      }
    } finally {
      setInsertingReservice(false);
    }
  };

  // Same bearer-credential rule as the reschedule link: an inserted
  // re-service link must not survive a recipient change, and the tracked
  // link is forgotten once the operator deletes it from the body.
  useEffect(() => {
    if (!insertedReservice) return;
    if (!msgBody.includes(insertedReservice.url)) {
      setInsertedReservice(null);
      return;
    }
    const currentRecipient = toNumber.trim();
    const currentRecipientKey = currentRecipient
      ? smsThreadKey(currentRecipient)
      : "";
    if (
      currentRecipientKey !== insertedReservice.recipientKey ||
      (selectedCustomerId || null) !== insertedReservice.customerId
    ) {
      setMsgBody((b) =>
        b
          .split("\n")
          .filter((l) => !l.includes(insertedReservice.url))
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim(),
      );
      setInsertedReservice(null);
      setSendResult({
        ok: true,
        text: "Re-service link removed — the recipient changed.",
      });
    }
  }, [insertedReservice, msgBody, toNumber, selectedCustomerId]);

  // Load the link library once per page load — the sheet's search runs
  // client-side over the full list (office review links + sitemap-synced
  // website pages + hand-managed rows).
  const loadLinkLibrary = async () => {
    if (libraryLoading) return;
    setLibraryLoading(true);
    setLibraryError(null);
    try {
      const d = await adminFetch("/admin/communications/link-library");
      setLibraryLinks(Array.isArray(d.links) ? d.links : []);
    } catch (e) {
      setLibraryError(`Couldn't load the link library: ${e.message}`);
    } finally {
      setLibraryLoading(false);
    }
  };

  const openLinkSheet = () => {
    setShowLinkSheet(true);
    if (!libraryLinks && !libraryLoading) loadLinkLibrary();
  };

  // Insert a static library row (or the portal-login customer row). No
  // bearer-link machinery — append once, confirm in the result line, and
  // refuse to stack a duplicate.
  const handleInsertLibraryLink = (link) => {
    if (msgBody.includes(link.url)) {
      setSendResult({ ok: true, text: `${link.name} is already in the message.` });
      return;
    }
    setMsgBody((b) => appendStaticLinkClause(b, { url: link.url, clause: libraryLinkClause(link) }));
    setSendResult({ ok: true, text: `${link.name} added.` });
  };

  // Insert one of the generic minted per-customer links (review request /
  // pay balance / latest estimate / referral) via POST /customer-link. Same
  // three invariants as the reschedule/re-service handlers above: stale-
  // response guard, replace-don't-stack per kind, and the strip-on-
  // recipient-change effect below.
  const CUSTOMER_LINK_NOTES = {
    review_request: (d) => `Review request added — personal link${d.firstName ? ` for ${d.firstName}` : ""}${d.channel === "both" ? "; the email goes out when you send" : ""}.`,
    pay_balance: (d) =>
      d.balance
        ? `Pay link added — $${Number(d.balance.total).toFixed(2)} open across ${d.balance.count === 1 ? "1 invoice" : `${d.balance.count} invoices`}.`
        : "Pay link added.",
    estimate: (d) => `Estimate link added${d.estimate?.serviceType ? ` — ${d.estimate.serviceType}` : ""}.`,
    referral: (d) => `Referral link added${d.firstName ? ` — ${d.firstName}'s personal link` : ""}.`,
    autopay_setup: () => "Auto Pay setup link added — nothing is charged until they save a payment method.",
    appointment: (d) => `Appointment page link added${d.appointment?.scheduledDate ? ` — visit on ${d.appointment.scheduledDate}` : ""}.`,
    card_request: (d) =>
      `Card request link added${d.appointment?.scheduledDate ? ` for the ${d.appointment.scheduledDate} visit` : ""} — nothing is charged until they save a card.`,
    prep_guide: (d) =>
      `Prep guide link added${d.prep?.label ? ` — ${d.prep.label}` : ""}${d.prep?.scheduledDate ? ` on ${d.prep.scheduledDate}` : ""}.`,
    service_report: (d) => `Service report link added${d.report?.serviceDate ? ` — visit on ${d.report.serviceDate}` : ""}.`,
    contract: (d) =>
      `Contract signing link added${d.contract?.title ? ` — ${d.contract.title}` : ""}.`,
    statement: (d) =>
      d.statement
        ? `Statement pay link added — ${d.statement.number}, $${Number(d.statement.total).toFixed(2)} for ${d.statement.payerName}.`
        : "Statement pay link added.",
    project_report: (d) => `Project report link added${d.projectReport?.title ? ` — ${d.projectReport.title}` : ""}${d.projectReport?.projectDate ? ` (${d.projectReport.projectDate})` : ""}.`,
  };

  // Withdrawal is NON-destructive: the pending review row is SHARED — every
  // composer inserting for the same customer holds the same row (createInline
  // reuse), so canceling it here would 409 another operator's valid in-flight
  // send. Forgetting the local entry is enough: the row is unscheduled (never
  // auto-sends), the customer's next insert reuses it, and only a claimed
  // /sms send delivers it.

  // Email channel: the server sent the review email — nothing to insert,
  // and a Text/Both review link still in the draft comes OUT: the email
  // started the ask's cooldown, so the composer send would be refused for
  // the stale reviewRequestId (GH Codex #3856 r2 P2).
  const applyEmailedReviewAsk = (kind, d) => {
    const staleUrl = insertedCustomerLinks[kind]?.url || null;
    if (staleUrl) {
      setMsgBody((b) => stripLinkLines(b, staleUrl));
      setInsertedCustomerLinks((m) => {
        const { [kind]: _dropped, ...rest } = m;
        return rest;
      });
    }
    setSendResult({
      ok: true,
      text: `Review request emailed${d.firstName ? ` to ${d.firstName}` : ""}.${staleUrl ? " The review link was removed from the text." : ""}`,
    });
  };

  // Owner-bound kinds (Auto Pay, prep guide, appointment page, service
  // report) hand back the resolved owner: adopt it as the selected customer
  // when none was picked, so the send carries customerId and the
  // recipient's own consent policy applies (the server refuses the strict-
  // owner kinds otherwise). The phone did
  // not change — links already minted for this recipient with no selected
  // customer adopt the resolved owner too, or the recipient-change effects
  // would strip them (r4 P2).
  const adoptResolvedOwner = (d, requestCustomerId, requestRecipientKey) => {
    if (requestCustomerId || !d.customerId) return;
    const adopt = (e) => (
      e && e.recipientKey === requestRecipientKey && e.customerId == null
        ? { ...e, customerId: d.customerId }
        : e
    );
    setSelectedCustomerId(d.customerId);
    setInsertedResched(adopt);
    setInsertedReservice(adopt);
    setInsertedCustomerLinks((m) => Object.fromEntries(Object.entries(m).map(([k, e]) => [k, adopt(e)])));
  };

  // The minted line goes into the draft. Replace-don't-stack per kind (same
  // rule as the reschedule insert): a replaced review link's row is NOT
  // canceled — reuse means the fresh insert hands back the same shared row
  // anyway. A standalone line (Auto Pay: the reviewed SMS template, already
  // greeted) goes in as-is; the generic prefill wraps the others.
  const insertCustomerLinkLine = ({ kind, channel, d, requestRecipientKey, linkCustomerId }) => {
    const clause = String(d.line || "").trim() || `${d.url}`;
    const prefill = d.standalone ? clause : buildCustomerLinkPrefill({ firstName: d.firstName, clause });
    const prevUrl = insertedCustomerLinks[kind]?.url || null;
    setMsgBody((b) => {
      const base = prevUrl ? stripLinkLines(b, prevUrl) : b;
      return base.trim()
        ? `${base.replace(/\s+$/, "")}\n\n${clause}`
        : prefill || clause;
    });
    setInsertedCustomerLinks((m) => ({
      ...m,
      [kind]: {
        url: d.url,
        recipientKey: requestRecipientKey,
        customerId: linkCustomerId,
        requestId: d.requestId || null,
        contractId: d.contract?.id || null,
        // Both: the send posts reviewRequestEmail so the same ask is
        // emailed once the text has really gone out.
        emailToo: channel === "both",
        // Expiring / immediate-only bearer links refuse scheduled and
        // draft sends (see the send boundary) — the server says which.
        expiresAt: d.expiresAt || null,
        immediateOnly: !!d.immediateOnly,
      },
    }));
    setSendResult({ ok: true, text: (CUSTOMER_LINK_NOTES[kind] || (() => "Link added."))({ ...d, channel }) });
  };

  const handleInsertCustomerLink = async (kind, channel = null) => {
    const requestRecipient = toNumber.trim();
    if (!requestRecipient || insertingCustomerLink) return;
    const requestRecipientKey = smsThreadKey(requestRecipient);
    const requestCustomerId = selectedCustomerId || null;
    const requestThreadKey = activeThread?.contactPhone
      ? smsThreadKey(activeThread.contactPhone)
      : "";
    const contextChanged = () => {
      const latest = rewriteContextRef.current;
      const latestRecipient = latest.toNumber.trim();
      const latestRecipientKey = latestRecipient ? smsThreadKey(latestRecipient) : "";
      return (
        latestRecipientKey !== requestRecipientKey ||
        (latest.selectedCustomerId || null) !== requestCustomerId ||
        latest.activeThreadKey !== requestThreadKey
      );
    };
    setInsertingCustomerLink(kind);
    setSendResult(null);
    try {
      // POST body, never a query string — same request-log redaction reason
      // as the reschedule/re-service lookups.
      const d = await adminFetch("/admin/communications/customer-link", {
        method: "POST",
        body: JSON.stringify({
          phone: requestRecipient,
          customerId: requestCustomerId || undefined,
          kind,
          channel: channel || undefined,
        }),
      });
      if (contextChanged()) {
        // The mint landed after the operator moved on — just drop it. The
        // shared pending row stays reusable (see the withdrawal note above).
        // (An Email-channel review ask has already been sent by the server;
        // the toast is the only thing dropped.)
        return;
      }
      if (d.sent && channel === "email") {
        applyEmailedReviewAsk(kind, d);
        return;
      }
      if (d.autoSecured) {
        // A consented saved card covered the ask (Auto Pay enrolled, or the
        // appointment secured) — a successful outcome with nothing to insert.
        setSendResult({
          ok: true,
          text: kind === "card_request"
            ? "A consented card was already on file — the appointment is secured, no link needed."
            : "A consented card was already on file — Auto Pay is now enrolled, no link needed.",
        });
        return;
      }
      adoptResolvedOwner(d, requestCustomerId, requestRecipientKey);
      insertCustomerLinkLine({ kind, channel, d, requestRecipientKey, linkCustomerId: d.customerId || requestCustomerId });
    } catch (e) {
      if (!contextChanged()) {
        setSendResult({ ok: false, text: e.message });
      }
    } finally {
      setInsertingCustomerLink(null);
    }
  };

  // Same bearer-credential rule as the reschedule/re-service links: a minted
  // customer link must not survive a recipient change, and the tracked entry
  // is forgotten once the operator deletes it from the body (presence is
  // checked canonically — bodyHasLink — so a case/scheme edit of a still-
  // live URL never sheds tracking). Withdrawal never cancels the shared
  // review row (see the note above handleInsertCustomerLink).
  useEffect(() => {
    const entries = Object.entries(insertedCustomerLinks);
    if (!entries.length) return;
    // Defer while a send is in flight — the effect re-runs when `sending`
    // settles: a successful send has already forgotten the links (cleared
    // with the body), a failed one re-evaluates then.
    if (sending) return;
    const currentRecipient = toNumber.trim();
    const currentRecipientKey = currentRecipient ? smsThreadKey(currentRecipient) : "";
    let removedForRecipient = false;
    const kept = {};
    for (const [kind, entry] of entries) {
      if (!bodyHasLink(msgBody, entry.url)) {
        // Operator deleted the line (or the body cleared) — forget it.
        continue;
      }
      if (
        currentRecipientKey !== entry.recipientKey ||
        (selectedCustomerId || null) !== entry.customerId
      ) {
        setMsgBody((b) => stripLinkLines(b, entry.url));
        removedForRecipient = true;
        continue;
      }
      kept[kind] = entry;
    }
    if (Object.keys(kept).length !== entries.length) {
      setInsertedCustomerLinks(kept);
      if (removedForRecipient) {
        setSendResult({ ok: true, text: "Customer link removed — the recipient changed." });
      }
    }
  }, [insertedCustomerLinks, msgBody, toNumber, selectedCustomerId, sending]);

  // The sheet's full list: the customer group first, then the library rows.
  // Every dynamic row dispatches to a requireAdmin endpoint (reschedule-link,
  // reservice-link, customer-link) — a technician selecting one would only
  // get a 403, so those rows are admin-only; the static rows stay staff-wide.
  const insertSheetLinks = useMemo(
    () => [
      ...CUSTOMER_COMPOSER_LINKS.filter((l) => smsIsAdminRole || !l.dynamic),
      ...(libraryLinks || []),
    ],
    [libraryLinks, smsIsAdminRole],
  );

  const handleInsertSheetPick = (link, channel = null) => {
    setShowLinkSheet(false);
    if (link.key === "reschedule") return handleInsertRescheduleLink();
    if (link.key === "reservice") return handleInsertReserviceLink();
    if (link.dynamic) return handleInsertCustomerLink(link.key, channel);
    return handleInsertLibraryLink(link);
  };

  const handleRewriteSms = async () => {
    const cleanBody = msgBody.trim();
    if (!cleanBody || rewritingSms) return;
    const requestRecipient = toNumber.trim();
    const requestRecipientKey = requestRecipient ? smsThreadKey(requestRecipient) : "";
    const requestCustomerId = selectedCustomerId || null;
    const requestFromNumber = fromNumber;
    const requestFromNumberKey = phoneKey(requestFromNumber);
    const activeThreadMatchesRecipient =
      requestRecipientKey &&
      activeThread?.contactPhone &&
      smsThreadKey(activeThread.contactPhone) === requestRecipientKey;
    const requestActiveThreadKey = activeThreadMatchesRecipient
      ? smsThreadKey(activeThread.contactPhone)
      : "";
    const recentNewestMessages =
      activeThreadMatchesRecipient && Array.isArray(activeThread?.messages)
        ? activeThread.messages
            .filter((m) => smsMessageMatchesLine(m, requestFromNumber))
            .slice(0, 8)
      : [];
    const lastInbound = recentNewestMessages.find((m) => m.direction === "inbound");
    const recentMessages = [...recentNewestMessages].reverse().map((m) => ({
      direction: m.direction,
      body: m.body,
      createdAt: m.createdAt,
    }));

    setRewritingSms(true);
    setSendResult(null);
    try {
      const d = await adminFetch("/admin/communications/rewrite-sms", {
        method: "POST",
        body: JSON.stringify({
          body: cleanBody,
          customerId: requestCustomerId || undefined,
          customerPhone: requestRecipient || undefined,
          lastInboundMessage: lastInbound?.body || "",
          recentMessages,
        }),
      });
      if (d?.body) {
        setMsgBody((current) => {
          const latestContext = rewriteContextRef.current;
          const latestRecipient = latestContext.toNumber.trim();
          const latestRecipientKey = latestRecipient ? smsThreadKey(latestRecipient) : "";
          const latestCustomerId = latestContext.selectedCustomerId || null;
          const latestFromNumberKey = phoneKey(latestContext.fromNumber);
          if (
            latestRecipientKey !== requestRecipientKey ||
            latestCustomerId !== requestCustomerId ||
            latestFromNumberKey !== requestFromNumberKey ||
            latestContext.activeThreadKey !== requestActiveThreadKey
          ) {
            return current;
          }
          return current.trim() === cleanBody ? d.body : current;
        });
      }
    } catch (e) {
      setSendResult({ ok: false, text: `Rewrite failed: ${e.message}` });
    } finally {
      setRewritingSms(false);
    }
  };

  const threads = useMemo(() => {
    const threadMap = {};
    const sorted = [...messages].sort(
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
    );
    const allNums = new Set();
    ALL_NUMBERS.forEach((g) => g.numbers.forEach((n) => allNums.add(n.number)));
    sorted.forEach((m) => {
      let contactPhone, ourNumber;
      if (m.direction === "inbound") {
        contactPhone = m.from;
        ourNumber = m.to;
      } else {
        contactPhone = m.to;
        ourNumber = m.from;
      }
      const key = smsThreadKey(contactPhone);
      if (!threadMap[key]) {
        threadMap[key] = {
          contactPhone,
          ourNumber,
          customerName: m.customerName || null,
          customerId: m.customerId || null,
          messages: [],
          lastMessage: null,
          lastTimestamp: null,
          lastDirection: null,
          unread: false,
        };
      }
      const thread = threadMap[key];
      thread.messages.push(m);
      if (m.customerName) thread.customerName = m.customerName;
      if (m.customerId) thread.customerId = m.customerId;
      if (ourNumber && allNums.has(ourNumber)) thread.ourNumber = ourNumber;
      thread.lastMessage =
        m.body ||
        (Array.isArray(m.media) && m.media.length
          ? `${m.media.length} photo${m.media.length === 1 ? "" : "s"}`
          : "");
      thread.lastTimestamp = m.createdAt;
      thread.lastDirection = m.direction;
    });
    const threadList = Object.values(threadMap).map((t) => {
      t.messages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      t.unanswered = t.lastDirection === "inbound";
      t.unread = t.messages.some((m) => m.direction === "inbound" && !m.isRead);
      return t;
    });
    threadList.sort(
      (a, b) => new Date(b.lastTimestamp) - new Date(a.lastTimestamp),
    );
    return threadList;
  }, [messages]);

  useEffect(() => {
    if (!activeThread) return;
    const nextThread = threads.find(
      (t) => smsThreadKey(t.contactPhone) === smsThreadKey(activeThread.contactPhone),
    );
    if (nextThread && nextThread.messages.length !== activeThread.messages.length) {
      setActiveThread(nextThread);
    }
  }, [threads, activeThread?.contactPhone, activeThread?.messages?.length]);

  // Deep-link from a notification: /admin/communications?thread=<customerId>
  // opens that customer's SMS conversation. The sms_reply notification carries
  // the customer id as its thread id (see notification-triggers.js); threads are
  // keyed by phone but each carries its customerId, so we match on that and snap
  // into the conversation view once the message log has loaded. Runs once.
  const threadDeepLinkDone = useRef(false);
  useEffect(() => {
    if (!active) return;
    if (threadDeepLinkDone.current) return;
    const threadCustomerId = new URLSearchParams(window.location.search).get("thread");
    if (!threadCustomerId) {
      threadDeepLinkDone.current = true;
      return;
    }
    if (!threads.length) return; // wait for the log to load
    threadDeepLinkDone.current = true;
    const match = threads.find(
      (t) => t.customerId && String(t.customerId) === String(threadCustomerId),
    );
    if (!match) return; // no thread yet for this customer — stay on the list
    const openedThread = { ...match };
    setActiveThread(openedThread);
    setSmsView("conversation");
    setToNumber(match.contactPhone);
    setToSearch("");
    setSelectedCustomerId(match.customerId || null);
    if (match.ourNumber) {
      setFromNumber(match.ourNumber);
      setThreadLock({
        contactPhone: match.contactPhone,
        ourNumber: match.ourNumber,
        label: NUMBER_LABEL_MAP[match.ourNumber] || match.ourNumber,
      });
    }
    markMessagesRead(openedThread);
  }, [active, threads, markMessagesRead]);

  const filteredThreads = threads.filter((t) => {
    // PR 4 — status filter chips (stacked on top of message-type smsFilter).
    if (statusFilter !== "all") {
      const hasUnseen = t.unread;
      if (statusFilter === "unread" && !hasUnseen) return false;
      if (statusFilter === "unanswered" && !t.unanswered) return false;
      if (statusFilter === "unknown" && t.customerName) return false;
    }
    if (smsFilter === "all") return true;
    if (smsFilter === "sent")
      return t.messages.some((m) => m.direction === "outbound");
    if (smsFilter === "received")
      return t.messages.some((m) => m.direction === "inbound");
    if (smsFilter === "auto_reply")
      return t.messages.some(
        (m) => m.messageType === "auto_reply" || m.messageType === "ai_draft",
      );
    if (smsFilter === "reminder")
      return t.messages.some((m) =>
        ["reminder", "confirmation", "appointment_confirmation"].includes(
          m.messageType,
        ),
      );
    if (smsFilter === "review_request")
      return t.messages.some((m) => m.messageType === "review_request");
    if (smsFilter === "estimate")
      return t.messages.some((m) => m.messageType === "estimate");
    return true;
  });

  const chipCounts = useMemo(() => {
    let unread = 0,
      unanswered = 0,
      unknown = 0;
    threads.forEach((t) => {
      if (t.unread) unread++;
      if (t.unanswered) unanswered++;
      if (!t.customerName) unknown++;
    });
    return { all: threads.length, unread, unanswered, unknown };
  }, [threads]);

  const handleThreadReply = (contactPhone, ourNumber, customerId = null) => {
    setToNumber(contactPhone);
    setToSearch("");
    setSelectedCustomerId(customerId || null);
    if (ourNumber) {
      setFromNumber(ourNumber);
      setThreadLock({
        contactPhone,
        ourNumber,
        label: NUMBER_LABEL_MAP[ourNumber] || ourNumber,
      });
    }
    setSmsView("threads");
    setActiveThread(null);
    setTimeout(() => {
      const el = document.getElementById("sms-compose-v2");
      if (el) el.scrollIntoView({ behavior: "smooth" });
    }, 100);
  };

  const totalSent =
    stats?.totalSent ||
    stats?.channelStats?.reduce((s, c) => s + (c.sent || 0), 0) ||
    0;
  const totalReceived =
    stats?.totalReceived ||
    stats?.locationStats?.reduce((s, l) => s + (l.received || 0), 0) ||
    0;
  const channelStats = stats?.channelStats || [];
  const messageTypes = [
    ...new Set(messages.map((m) => m.messageType).filter(Boolean)),
  ];

  const filtered = messages.filter((m) => {
    if (dirFilter === "inbound" && m.direction !== "inbound") return false;
    if (dirFilter === "outbound" && m.direction !== "outbound") return false;
    if (typeFilter !== "all" && m.messageType !== typeFilter) return false;
    return true;
  });

  const handleLoadMoreSmsHistory = async () => {
    if (smsLoadingMore || !smsHasMore) return;
    setSmsLoadingMore(true);
    try {
      await loadData(smsSearch.trim(), { page: smsPage + 1, append: true });
    } finally {
      setSmsLoadingMore(false);
    }
  };

  const renderLoadMore = (label) =>
    smsHasMore ? (
      <div className="pt-4 flex justify-center">
        <Button
          type="button"
          variant="secondary"
          onClick={handleLoadMoreSmsHistory}
          disabled={smsLoadingMore}
        >
          {smsLoadingMore ? "Loading..." : label}
        </Button>
      </div>
    ) : null;

  if (loading) {
    return (
      <div className="p-10 text-center text-13 text-ink-secondary">
        Loading communications…
      </div>
    );
  }

  return (
    <div>
      {/* Stats + auto-reply */}
      <div className="hidden md:flex items-center gap-2 mb-4 flex-wrap">
        {" "}
        <StatCardV2
          label="Sent This Month"
          value={totalSent}
          active={smsFilter === "sent"}
          onClick={() => setSmsFilter((f) => (f === "sent" ? "all" : "sent"))}
        />{" "}
        <StatCardV2
          label="Received This Month"
          value={totalReceived}
          active={smsFilter === "received"}
          onClick={() =>
            setSmsFilter((f) => (f === "received" ? "all" : "received"))
          }
        />{" "}
        <StatCardV2
          label="Auto-Replies"
          value={channelStats.find((c) => c.type === "auto_reply")?.sent || 0}
          active={smsFilter === "auto_reply"}
          alert={
            (channelStats.find((c) => c.type === "auto_reply")?.sent || 0) === 0
          }
          onClick={() =>
            setSmsFilter((f) => (f === "auto_reply" ? "all" : "auto_reply"))
          }
        />{" "}
        <StatCardV2
          label="Reminders"
          value={
            channelStats.find((c) => c.type === "reminder")?.sent ||
            channelStats.find((c) => c.type === "confirmation")?.sent ||
            0
          }
          active={smsFilter === "reminder"}
          onClick={() =>
            setSmsFilter((f) => (f === "reminder" ? "all" : "reminder"))
          }
        />{" "}
        <StatCardV2
          label="Review Requests"
          value={
            channelStats.find((c) => c.type === "review_request")?.sent || 0
          }
          active={smsFilter === "review_request"}
          onClick={() =>
            setSmsFilter((f) =>
              f === "review_request" ? "all" : "review_request",
            )
          }
        />{" "}
        <StatCardV2
          label="Estimates"
          value={channelStats.find((c) => c.type === "estimate")?.sent || 0}
          active={smsFilter === "estimate"}
          onClick={() =>
            setSmsFilter((f) => (f === "estimate" ? "all" : "estimate"))
          }
        />{" "}
      </div>
      {/* Compose */}
      <Card id="sms-compose-v2" className="p-5 mb-5">
        {" "}
        <div className="flex items-center justify-end mb-3 flex-wrap gap-2">
          <button
            type="button"
            onClick={toggleAiAutoReply}
            disabled={togglingAi}
            aria-pressed={aiAutoReply}
            className="flex items-center gap-2 min-h-[44px] md:min-h-0 px-1 md:px-0 u-focus-ring"
          >
            {" "}
            <span className="text-13 md:text-11 text-ink-secondary">
              AI Auto-Reply
            </span>{" "}
            <span
              className={cn(
                "h-6 w-10 rounded-full border-hairline transition-colors relative",
                aiAutoReply
                  ? "bg-zinc-900 border-zinc-900"
                  : "bg-white border-zinc-300",
              )}
            >
              {" "}
              <span
                className={cn(
                  "absolute top-0.5 h-4 w-4 rounded-full transition-all",
                  aiAutoReply ? "left-5 bg-white" : "left-0.5 bg-zinc-400",
                )}
              />{" "}
            </span>{" "}
          </button>{" "}
        </div>
        {/* PR 4 — thread-reply lock banner */}
        {threadLock && (
          <div className="flex items-center gap-2 px-3 py-2 bg-zinc-50 border-hairline border-zinc-900 rounded-sm mb-3">
            {" "}
            <Badge tone="strong">Locked</Badge>{" "}
            <span className="text-12 text-zinc-900 flex-1">
              Replying from <strong>{threadLock.label}</strong>to continue
              thread with {threadLock.contactPhone}
            </span>{" "}
            <button
              type="button"
              onClick={() => setThreadLock(null)}
              className="text-13 md:text-11 min-h-[44px] md:min-h-0 inline-flex items-center px-2 text-ink-secondary underline hover:text-zinc-900 u-focus-ring"
            >
              Override
            </button>{" "}
          </div>
        )}
        <label className="block text-13 md:text-11 font-medium md:font-normal md:uppercase tracking-normal md:tracking-label text-zinc-900 md:text-ink-secondary mb-1">
          From{threadLock && " (locked to thread)"}
        </label>{" "}
        <select
          value={fromNumber}
          onChange={(e) => setFromNumber(e.target.value)}
          disabled={!!threadLock}
          className={cn(
            "w-full bg-white border-hairline rounded-sm py-2 px-3 text-16 md:text-13 text-zinc-900 mb-3 min-h-[44px] md:min-h-0",
            "focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900",
            threadLock
              ? "border-zinc-900 opacity-60 cursor-not-allowed"
              : "border-zinc-300",
          )}
        >
          {ALL_NUMBERS.map((group) => (
            <optgroup key={group.group} label={group.group}>
              {group.numbers.map((n) => (
                <option key={n.number} value={n.number}>
                  {n.formatted} — {n.label}
                </option>
              ))}
            </optgroup>
          ))}
          {/* A thread-locked From resolved from server config (e.g. a GBP
              tracking line) may not be in the client list — render it so
              the locked select doesn't show blank. */}
          {threadLock && fromNumber
            && !ALL_NUMBERS.some((g) => g.numbers.some((n) => n.number === fromNumber)) && (
            <option value={fromNumber}>{threadLock.label}</option>
          )}
        </select>{" "}
        <label className="block text-13 md:text-11 font-medium md:font-normal md:uppercase tracking-normal md:tracking-label text-zinc-900 md:text-ink-secondary mb-1">
          To
        </label>{" "}
        <input
          type="text"
          placeholder="Search by name or enter phone number…"
          value={toSearch || toNumber}
          onChange={async (e) => {
            const val = e.target.value;
            if (/^[\d\s()\-+]+$/.test(val)) {
              setToNumber(val);
              setSelectedCustomerId(null);
              setToSearch("");
              setToResults([]);
            } else {
              setToSearch(val);
              setToNumber("");
              setSelectedCustomerId(null);
              if (val.length >= 2) {
                try {
                  const r = await fetch(
                    `${API_BASE}/admin/customers?search=${encodeURIComponent(val)}&limit=8`,
                    {
                      headers: {
                        Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
                      },
                    },
                  );
                  if (r.ok) {
                    const d = await r.json();
                    setToResults(d.customers || []);
                  }
                } catch {
                  /* ignore */
                }
              } else {
                setToResults([]);
              }
            }
          }}
          className={cn(
            "w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-16 md:text-13 text-zinc-900 min-h-[44px] md:min-h-0",
            "focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900",
            toResults.length ? "mb-0" : "mb-3",
          )}
        />
        {toResults.length > 0 && (
          <div className="bg-white border-hairline border-zinc-300 border-t-0 rounded-b-sm max-h-[180px] overflow-y-auto mb-3">
            {toResults.map((c) => (
              <div
                key={c.id}
                onClick={() => {
                  const name = getCustomerOptionName(c);
                  setToNumber(c.phone || "");
                  setSelectedCustomerId(c.id || null);
                  setToSearch(`${name} — ${c.phone || ""}`);
                  setToResults([]);
                }}
                className="px-3 py-2 cursor-pointer border-b border-hairline border-zinc-200 text-13 text-zinc-900 hover:bg-zinc-50"
              >
                {" "}
                <span className="font-medium">
                  {getCustomerOptionName(c)}
                </span>{" "}
                <span className="text-ink-secondary ml-2 font-mono">
                  {c.phone || "no phone"}
                </span>{" "}
              </div>
            ))}
          </div>
        )}
        {activeThread &&
          (() => {
            const lastInbound = activeThread.messages.find(
              (m) => m.direction === "inbound",
            );
            if (!lastInbound) return null;
            return (
              <div className="mb-3 px-3 py-2.5 bg-zinc-50 border-hairline border-zinc-200 rounded-sm">
                {" "}
                <div className="text-13 md:text-11 font-medium md:font-normal md:uppercase tracking-normal md:tracking-label text-zinc-900 md:text-ink-tertiary mb-1">
                  Last message from customer
                </div>{" "}
                <div className="text-15 md:text-13 text-zinc-900 leading-normal whitespace-pre-wrap">
                  {lastInbound.body}
                </div>{" "}
                <div className="text-12 md:text-11 text-ink-tertiary mt-1">
                  {formatTimestamp(lastInbound.createdAt)}
                </div>{" "}
              </div>
            );
          })()}
        {(agentDraft || agentDraftLoading) && (
          <div className="mb-3 px-3 py-2.5 bg-white border-hairline border-zinc-300 rounded-sm">
            <div className="flex items-center gap-2 mb-2">
              <span className="flex items-center justify-center h-7 w-7 rounded-full bg-zinc-100 text-zinc-900">
                <Bot size={15} strokeWidth={2} />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-13 md:text-11 font-medium md:font-normal md:uppercase tracking-normal md:tracking-label text-zinc-900 md:text-ink-secondary">
                  Agent review draft
                </div>
                {agentDraft?.workflow && (
                  <div className="text-12 md:text-11 text-ink-tertiary truncate">
                    {agentDraft.workflow.replace(/_/g, " ")}
                    {agentDraft.scenarioLabel
                      ? ` · ${agentDraft.scenarioLabel.replace(/_/g, " ")}`
                      : ""}
                  </div>
                )}
              </div>
              {agentDraft?.suggestedMessage && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setMsgBody(agentDraft.suggestedMessage);
                    setSelectedAgentDraft(agentDraft);
                  }}
                >
                  Use Draft
                </Button>
              )}
            </div>
            {agentDraftLoading ? (
              <div className="text-13 text-ink-secondary">Checking pending review…</div>
            ) : (
              <div className="text-15 md:text-13 text-zinc-900 leading-normal whitespace-pre-wrap">
                {agentDraft.suggestedMessage}
              </div>
            )}
            {agentDraft?.lintFailures?.length > 0 && (
              <div className="mt-2 pt-2 border-t border-hairline border-zinc-200 text-12 md:text-11">
                <div className="font-medium text-zinc-900">
                  Failed comms-lint — review before sending
                </div>
                {agentDraft.lintFailures.map((f) => (
                  <div key={f.rule} className="text-ink-secondary">
                    {f.reason}
                  </div>
                ))}
              </div>
            )}
            {agentDraft?.inboundMessage && (
              <div className="mt-2 pt-2 border-t border-hairline border-zinc-200 text-12 md:text-11 text-ink-tertiary line-clamp-2">
                Trigger: {agentDraft.inboundMessage}
              </div>
            )}
          </div>
        )}
        <label className="block text-13 md:text-11 font-medium md:font-normal md:uppercase tracking-normal md:tracking-label text-zinc-900 md:text-ink-secondary mb-1">
          Message
        </label>{" "}
        <div>
          <textarea
            placeholder={listening ? "Listening…" : "Type your message…"}
            value={msgBody}
            onChange={(e) => setMsgBody(e.target.value)}
            readOnly={rewritingSms}
            rows={3}
            className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-16 md:text-13 text-zinc-900 resize-y focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={handleRewriteSms}
              disabled={
                rewritingSms ||
                listening ||
                sending ||
                uploading ||
                !msgBody.trim()
              }
              aria-label="Rewrite message in Waves tone"
              title="Rewrite in Waves tone"
              className={cn(
                "inline-flex items-center justify-center h-11 w-11 rounded-sm u-focus-ring",
                "bg-zinc-100 text-zinc-700 hover:bg-zinc-200",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              {rewritingSms ? (
                <Loader2 size={16} strokeWidth={2.2} className="animate-spin" />
              ) : (
                <Sparkles size={16} strokeWidth={2.2} />
              )}
            </button>
            {dictationSupported && (
              <button
                type="button"
                onClick={toggleDictation}
                disabled={rewritingSms}
                aria-label={listening ? "Stop dictation" : "Start voice dictation"}
                title={listening ? "Stop dictation" : "Start voice dictation"}
                className={cn(
                  "inline-flex items-center justify-center h-11 w-11 rounded-sm u-focus-ring",
                  listening
                    ? "bg-alert-fg text-white animate-pulse"
                    : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                )}
              >
                {listening ? (
                  <MicOff size={16} strokeWidth={2.2} />
                ) : (
                  <Mic size={16} strokeWidth={2.2} />
                )}
              </button>
            )}
          </div>
        </div>
        {/* Attachment tray */}
        {attachments.length > 0 && (
          <div className="flex gap-2 flex-wrap mt-2">
            {attachments.map((a, i) => (
              <div
                key={a.key || i}
                className="relative"
                style={{ width: 56, height: 56 }}
              >
                {" "}
                <img
                  src={a.previewUrl || a.url}
                  alt={a.fileName}
                  className="object-cover rounded-sm border-hairline border-zinc-300"
                  style={{ width: 56, height: 56 }}
                />{" "}
                <button
                  type="button"
                  onClick={() => removeAttachment(i)}
                  aria-label={`Remove ${a.fileName}`}
                  className="absolute -top-1.5 -right-1.5 flex items-center justify-center rounded-full bg-zinc-900 text-white u-focus-ring"
                  style={{ width: 28, height: 28, fontSize: 16, lineHeight: 1 }}
                >
                  ×
                </button>{" "}
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between text-13 md:text-11 font-mono text-ink-tertiary u-nums mt-1 mb-3">
          {" "}
          <span>
            {attachments.length > 0
              ? `${attachments.length} attached · ${formatBytes(
                  attachments.reduce((s, a) => s + (a.size || 0), 0),
                )}`
              : ""}
          </span>{" "}
          <span>{rewritingSms ? "Rewriting…" : `${msgBody.length} chars`}</span>{" "}
        </div>
        {/* Hidden file inputs, triggered by the + menu buttons. */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            handleUpload(e.target.files);
            e.target.value = "";
          }}
        />{" "}
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            handleUpload(e.target.files);
            e.target.value = "";
          }}
        />{" "}
        <label className="block text-13 md:text-11 font-medium md:font-normal md:uppercase tracking-normal md:tracking-label text-zinc-900 md:text-ink-secondary mb-1">
          Send
        </label>{" "}
        <select
          value={sendTiming}
          onChange={(e) => setSendTiming(e.target.value)}
          className={cn(
            "w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-16 md:text-13 text-zinc-900 min-h-[44px] md:min-h-0",
            "focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900",
            sendTiming === "custom" ? "mb-2" : "mb-3",
          )}
        >
          {" "}
          <option value="now">Immediately</option>{" "}
          <option value="tomorrow_8">Tomorrow at 8 AM</option>{" "}
          <option value="custom">Custom time…</option>{" "}
        </select>
        {sendTiming === "custom" && (
          <input
            type="datetime-local"
            value={sendCustomAt}
            onChange={(e) => setSendCustomAt(e.target.value)}
            className={cn(
              "w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-16 md:text-13 text-zinc-900 min-h-[44px] md:min-h-0 mb-3",
              "focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900",
            )}
          />
        )}
        <div className="flex flex-wrap gap-2 items-center">
          {/* Plus — attachment menu */}
          <div className="relative">
            {" "}
            <button
              type="button"
              onClick={() => setShowAttachSheet((v) => !v)}
              disabled={uploading}
              aria-label="Add attachment"
              title="Add image"
              className="flex items-center justify-center h-11 w-11 rounded-full bg-zinc-100 text-zinc-900 hover:bg-zinc-200 u-focus-ring disabled:opacity-50"
            >
              {" "}
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.25"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {" "}
                <line x1="12" y1="5" x2="12" y2="19" />{" "}
                <line x1="5" y1="12" x2="19" y2="12" />{" "}
              </svg>{" "}
            </button>
            {showAttachSheet && (
              <div
                className="absolute bottom-full left-0 mb-2 z-10 bg-white border-hairline border-zinc-300 rounded-sm shadow-lg overflow-hidden"
                style={{ width: 180 }}
              >
                {" "}
                <button
                  type="button"
                  onClick={() => {
                    setShowAttachSheet(false);
                    cameraInputRef.current?.click();
                  }}
                  className="block w-full min-h-11 text-left px-3 py-2.5 text-13 text-zinc-900 hover:bg-zinc-100 u-focus-ring"
                >
                  Take photo
                </button>{" "}
                <button
                  type="button"
                  onClick={() => {
                    setShowAttachSheet(false);
                    fileInputRef.current?.click();
                  }}
                  className="block w-full min-h-11 text-left px-3 py-2.5 text-13 text-zinc-900 hover:bg-zinc-100 border-t border-hairline border-zinc-200 u-focus-ring"
                >
                  Photo library
                </button>{" "}
              </div>
            )}
          </div>{" "}
          <Button
            variant="primary"
            className="flex-1"
            onClick={handleSend}
            disabled={
              sending ||
              uploading ||
              rewritingSms ||
              // Mid-lookup send would go out WITHOUT the link the operator
              // just asked for (and clearing the recipient on send discards
              // the response) — wait out the link fetches.
              insertingResched ||
              insertingReservice ||
              !!insertingCustomerLink ||
              !toNumber.trim() ||
              (!msgBody.trim() && attachments.length === 0)
            }
          >
            {sending
              ? sendTiming === "now"
                ? "Sending…"
                : "Scheduling…"
              : rewritingSms
                ? "Rewriting…"
              : compressing
                ? "Compressing…"
              : uploading
                ? "Uploading…"
                : sendTiming === "now"
                  ? "Send"
                  : "Schedule"}
          </Button>{" "}
          <Button
            variant="secondary"
            onClick={handleAiDraft}
            disabled={aiDrafting || !toNumber.trim()}
          >
            {aiDrafting ? "Drafting…" : "AI Draft"}
          </Button>{" "}
          {/* Insert Link — opens the searchable link library sheet: the
              per-customer minted links, per-office review links, the whole
              website, app stores, and socials. */}
          <Button
            variant="secondary"
            onClick={openLinkSheet}
            disabled={
              insertingResched ||
              insertingReservice ||
              !!insertingCustomerLink ||
              !toNumber.trim()
            }
            title="Quick Links — insert a customer, review, website, or app link into the message"
            aria-haspopup="dialog"
            aria-expanded={showLinkSheet}
          >
            {insertingResched || insertingReservice || insertingCustomerLink
              ? "Adding…"
              : "Quick Links"}
          </Button>{" "}
          <Button
            variant="secondary"
            className="gap-2"
            onClick={() => setPrepSendOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={prepSendOpen}
          >
            <BookOpen size={15} strokeWidth={1.9} aria-hidden />
            Send prep guide
          </Button>
        </div>
        <PrepSendDialog
          open={active && prepSendOpen}
          onClose={() => setPrepSendOpen(false)}
        />
        <InsertLinkSheet
          open={active && showLinkSheet}
          onClose={() => setShowLinkSheet(false)}
          links={insertSheetLinks}
          loading={libraryLoading}
          error={libraryError}
          onRetry={loadLinkLibrary}
          busyKey={
            insertingResched
              ? "reschedule"
              : insertingReservice
                ? "reservice"
                : insertingCustomerLink
          }
          onPick={handleInsertSheetPick}
          groupCaptions={{
            customer: "Personal links — each one is looked up for this recipient",
            website: "Every wavespestcontrol.com page, synced nightly from the sitemap",
          }}
        />
        {sendResult && (
          <div
            className={cn(
              "mt-2.5 text-12",
              sendResult.ok ? "text-zinc-900" : "text-alert-fg",
            )}
          >
            {sendResult.text}
          </div>
        )}
      </Card>
      {/* View toggle — desktop power-user feature; mobile just shows Conversations */}
      <div className="hidden md:flex items-center gap-3 mb-3 flex-wrap">
        {" "}
        <div className="flex border-hairline border-zinc-300 rounded-sm p-0.5 bg-white">
          {" "}
          <button
            type="button"
            onClick={() => {
              setSmsView("threads");
              setActiveThread(null);
            }}
            className={cn(
              "px-3.5 py-2.5 md:py-1 min-h-[44px] md:min-h-0 text-14 md:text-12 normal-case md:uppercase tracking-normal md:tracking-label rounded-xs u-focus-ring transition-colors",
              smsView === "threads" || smsView === "conversation"
                ? "bg-zinc-900 text-white"
                : "text-ink-secondary hover:bg-zinc-50",
            )}
          >
            Conversations
          </button>{" "}
          <button
            type="button"
            onClick={() => {
              setSmsView("log");
              setActiveThread(null);
            }}
            className={cn(
              "px-3.5 py-2.5 md:py-1 min-h-[44px] md:min-h-0 text-14 md:text-12 normal-case md:uppercase tracking-normal md:tracking-label rounded-xs u-focus-ring transition-colors",
              smsView === "log"
                ? "bg-zinc-900 text-white"
                : "text-ink-secondary hover:bg-zinc-50",
            )}
          >
            Log View
          </button>{" "}
        </div>{" "}
      </div>
      {/* Search */}
      <div className="mb-3">
        {" "}
        <input
          type="text"
          placeholder="Search all SMS by name, phone, or message text…"
          value={smsSearch}
          onChange={(e) => {
            smsSearchRef.current = e.target.value.trim();
            setSmsSearch(e.target.value);
          }}
          className="w-full bg-white border-hairline border-zinc-300 rounded-sm py-2 px-3 text-16 md:text-13 text-zinc-900 min-h-[44px] md:min-h-0 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
        />{" "}
      </div>
      {/* Thread list / conversation / log */}
      {smsView === "conversation" && activeThread ? (
        <Card className="p-5">
          {" "}
          <ConversationViewV2
            thread={activeThread}
            messages={activeThread.messages.slice().reverse()}
            onReply={handleThreadReply}
            onBack={() => {
              setSmsView("threads");
              setActiveThread(null);
            }}
            onOpenProfile={(id) => setSelected360Id(id)}
          />{" "}
          {renderLoadMore("Load older SMS history")}
        </Card>
      ) : smsView === "threads" ? (
        <Card className="p-5">
          {" "}
          <div className="flex items-center justify-between mb-3">
            {" "}
            <div className="text-14 md:text-11 font-medium md:font-normal md:uppercase tracking-normal md:tracking-label text-zinc-900 md:text-ink-secondary">
              Conversations
              <span className="ml-2 u-nums">
                ({filteredThreads.length})
              </span>{" "}
            </div>{" "}
          </div>
          {/* Status filter — one dropdown instead of a pill row so it
              costs a single line on phones; counts ride in the labels. */}
          <div className="mb-3">
            <label htmlFor="sms-thread-filter" className="sr-only">
              Filter conversations
            </label>
            <Select
              id="sms-thread-filter"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              {[
                { key: "all", label: "All", count: chipCounts.all },
                { key: "unread", label: "Unread", count: chipCounts.unread },
                {
                  key: "unanswered",
                  label: "Unanswered",
                  count: chipCounts.unanswered,
                },
                { key: "unknown", label: "Unknown", count: chipCounts.unknown },
              ].map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {opt.label} ({opt.count})
                </option>
              ))}
            </Select>
          </div>
          <div className="md:max-h-[600px] md:overflow-y-auto">
            {filteredThreads.length === 0 ? (
              <div className="p-5 text-center text-13 text-ink-secondary">
                No conversations found.
              </div>
            ) : (
              filteredThreads.map((t, i) => {
                const preview = t.lastMessage
                  ? t.lastMessage.length > 60
                    ? t.lastMessage.slice(0, 60) + "…"
                    : t.lastMessage
                  : "";
                const hasUnseen = t.unread;
                const displayName = t.customerName || t.contactPhone;
                const initials = getInitials(t.customerName || t.contactPhone);
                return (
                  <div
                    key={i}
                    onClick={() => {
                      const openedThread = { ...t };
                      setActiveThread(openedThread);
                      setSmsView("conversation");
                      setToNumber(t.contactPhone);
                      setToSearch("");
                      setSelectedCustomerId(t.customerId || null);
                      if (t.ourNumber) {
                        setFromNumber(t.ourNumber);
                        setThreadLock({
                          contactPhone: t.contactPhone,
                          ourNumber: t.ourNumber,
                          label: NUMBER_LABEL_MAP[t.ourNumber] || t.ourNumber,
                        });
                      }
                      markMessagesRead(openedThread);
                    }}
                    className={cn(
                      "w-full text-left px-3.5 py-3.5 md:py-3 border-b border-hairline border-zinc-200 flex items-center gap-3 cursor-pointer",
                      "hover:bg-zinc-50 transition-colors",
                      hasUnseen && "bg-zinc-50",
                    )}
                  >
                    {" "}
                    <div
                      className="flex-shrink-0 flex items-center justify-center h-10 w-10 rounded-full bg-zinc-100 text-zinc-700 text-13 font-medium tracking-tight u-nums"
                      aria-hidden
                    >
                      {initials}
                    </div>{" "}
                    <div className="flex-1 min-w-0">
                      {" "}
                      <div className="flex items-center justify-between gap-2 mb-0.5">
                        {" "}
                        <div className="flex items-center gap-1.5 min-w-0">
                          {t.customerName && t.customerId ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelected360Id(t.customerId);
                              }}
                              className={cn(
                                "text-16 md:text-14 truncate hover:underline text-left text-zinc-900",
                                hasUnseen ? "font-medium" : "font-normal",
                              )}
                              title="Open customer profile"
                            >
                              {t.customerName}
                            </button>
                          ) : (
                            <span
                              className={cn(
                                "text-16 md:text-14 truncate text-zinc-900",
                                hasUnseen ? "font-medium" : "font-normal",
                              )}
                            >
                              {displayName}
                            </span>
                          )}
                        </div>{" "}
                        <span className="font-mono text-12 md:text-11 text-ink-tertiary flex-shrink-0">
                          {timeAgo(t.lastTimestamp)}
                        </span>{" "}
                      </div>{" "}
                      <div
                        className={cn(
                          "text-15 md:text-12 truncate leading-snug",
                          hasUnseen ? "text-zinc-900" : "text-ink-secondary",
                        )}
                      >
                        {preview || (
                          <span className="text-ink-tertiary italic">
                            No messages
                          </span>
                        )}
                      </div>{" "}
                    </div>{" "}
                    <div className="w-2 flex-shrink-0 flex justify-center">
                      {hasUnseen && (
                        <span
                          className="block w-2 h-2 rounded-full bg-zinc-900"
                          aria-label="Unread"
                        />
                      )}
                    </div>{" "}
                  </div>
                );
              })
            )}
          </div>{" "}
          {renderLoadMore("Load older conversations")}
        </Card>
      ) : (
        <Card className="p-5">
          {" "}
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            {" "}
            <div className="text-14 md:text-11 font-medium md:font-normal md:uppercase tracking-normal md:tracking-label text-zinc-900 md:text-ink-secondary">
              SMS log
            </div>{" "}
            <div className="flex gap-2">
              {" "}
              <select
                value={dirFilter}
                onChange={(e) => setDirFilter(e.target.value)}
                className="bg-white border-hairline border-zinc-300 rounded-xs py-2 md:py-1 px-2 text-16 md:text-12 text-zinc-900 min-h-[44px] md:min-h-0 focus:outline-none focus:ring-2 focus:ring-zinc-900"
              >
                {" "}
                <option value="all">All directions</option>{" "}
                <option value="inbound">Inbound</option>{" "}
                <option value="outbound">Outbound</option>{" "}
              </select>{" "}
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="bg-white border-hairline border-zinc-300 rounded-xs py-2 md:py-1 px-2 text-16 md:text-12 text-zinc-900 min-h-[44px] md:min-h-0 focus:outline-none focus:ring-2 focus:ring-zinc-900"
              >
                {" "}
                <option value="all">All types</option>
                {messageTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>{" "}
            </div>{" "}
          </div>{" "}
          <div className="md:max-h-[600px] md:overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="p-5 text-center text-13 text-ink-secondary">
                No messages found.
              </div>
            ) : (
              filtered.map((m) => (
                <SmsLogItemV2
                  key={m.id}
                  msg={m}
                  onReply={(phone, from, customerId) => {
                    setToNumber(phone);
                    setToSearch("");
                    setSelectedCustomerId(customerId || null);
                    setFromNumber(from);
                    // The admin shell scrolls .admin-main, not the window —
                    // window.scrollTo() is a no-op here.
                    document
                      .querySelector(".admin-main")
                      ?.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                />
              ))
            )}
          </div>{" "}
          {renderLoadMore("Load older messages")}
        </Card>
      )}

      {active && selected360Id && (
        <Customer360ProfileV2
          customerId={selected360Id}
          onClose={() => setSelected360Id(null)}
        />
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────

// Search a customer by name and send them a treatment prep guide. Smart
// channel: the server emails the formatted guide when the customer has an
// email on file, otherwise it texts the self-contained prep. Mirrors the
// server's PREP_CONFIG allow-list (prep-guide-sender.js).
const PREP_TYPES = [
  { value: "flea", label: "Flea treatment" },
  { value: "bed_bug", label: "Bed bug treatment" },
  { value: "cockroach", label: "Cockroach treatment" },
  { value: "interior_pest", label: "Interior pest treatment" },
  { value: "rodent", label: "Rodent service" },
  { value: "termite", label: "Termite service" },
  { value: "mosquito", label: "Mosquito treatment" },
  { value: "lawn", label: "Lawn treatment" },
];

// Operator-chosen channel (owner ruling 2026-09-03). Text carries the
// guide page link, which needs an upcoming visit of that type.
const PREP_CHANNELS = [
  { value: "both", label: "Email and text" },
  { value: "email", label: "Email only" },
  { value: "sms", label: "Text only" },
];

function PrepSendDialog({ open, onClose }) {
  const [pestType, setPestType] = useState("flea");
  const [channel, setChannel] = useState("both");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!open) {
      setPestType("flea");
      setChannel("both");
      setSearch("");
      setResults([]);
      setSelected(null);
      setSending(false);
      setResult(null);
    }
  }, [open]);

  useEffect(() => {
    if (selected) return undefined;
    const q = search.trim();
    if (q.length < 2) {
      setResults([]);
      // Clearing back below 2 chars cancels any in-flight debounce; reset the
      // spinner too, or it stays stuck on "Searching…" with an empty input.
      setSearching(false);
      return undefined;
    }
    let cancelled = false;
    // Drop any results from a previous query so a stale row can't be clicked
    // and sent to the wrong customer during this query's debounce/fetch window.
    setResults([]);
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const data = await adminFetch(
          `/admin/customers?search=${encodeURIComponent(q)}&limit=8`,
        );
        if (!cancelled) setResults(data?.customers || []);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, selected]);

  const handleSend = async () => {
    if (!selected || sending) return;
    setSending(true);
    setResult(null);
    try {
      const data = await adminFetch("/admin/communications/send-prep", {
        method: "POST",
        body: JSON.stringify({ customerId: selected.id, pestType, channel }),
      });
      // A Both send with one leg down is flagged, not celebrated.
      setResult({ ok: !data?.partial, text: data?.message || "Prep sent." });
    } catch (e) {
      setResult({ ok: false, text: e.message || "Couldn't send the prep." });
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} size="md">
      <DialogHeader>
        <DialogTitle>Send prep guide</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <p className="text-13 text-zinc-600 mb-3">
          Search a customer by name, pick the guide, and choose how it goes
          out. A text carries the guide page link, so it needs an upcoming
          visit of that type on the calendar.
        </p>
        <label className="block text-11 uppercase tracking-label text-zinc-500 mb-1">
          Treatment
        </label>
        <select
          value={pestType}
          onChange={(e) => {
            setPestType(e.target.value);
            setResult(null);
          }}
          className="w-full h-10 px-3 mb-3 rounded-sm border-hairline border-zinc-200 text-14 text-zinc-900 bg-white u-focus-ring"
        >
          {PREP_TYPES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <fieldset className="flex flex-col gap-2 border-0 p-0 m-0 mb-3 min-w-0">
          <legend className="text-11 uppercase tracking-label text-zinc-500 mb-1 p-0">Send by</legend>
          {PREP_CHANNELS.map((c) => (
            <Radio
              key={c.value}
              id={`prep-channel-${c.value}`}
              name="prep-channel"
              label={c.label}
              checked={channel === c.value}
              onChange={() => {
                setChannel(c.value);
                setResult(null);
              }}
              disabled={sending}
            />
          ))}
        </fieldset>
        {selected ? (
          <div className="flex items-center justify-between border-hairline border-zinc-200 rounded-sm px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-14 font-medium text-zinc-900 truncate">
                {getCustomerOptionName(selected)}
              </div>
              <div className="text-12 text-zinc-500 truncate">
                {selected.email || "No email on file"}
                {selected.phone ? ` · ${selected.phone}` : ""}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSelected(null);
                setResult(null);
              }}
            >
              Change
            </Button>
          </div>
        ) : (
          <>
            <input
              type="text"
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search customer by name…"
              className="w-full h-10 px-3 rounded-sm border-hairline border-zinc-200 text-14 text-zinc-900 u-focus-ring"
            />
            {searching && (
              <div className="text-12 text-zinc-500 mt-2">Searching…</div>
            )}
            {!searching &&
              search.trim().length >= 2 &&
              results.length === 0 && (
                <div className="text-12 text-zinc-500 mt-2">
                  No customers found.
                </div>
              )}
            {results.length > 0 && (
              <div className="mt-2 border-hairline border-zinc-200 rounded-sm divide-y divide-zinc-100 max-h-60 overflow-y-auto">
                {results.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => {
                      setSelected(c);
                      setResults([]);
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-zinc-50"
                  >
                    <div className="text-13 font-medium text-zinc-900">
                      {getCustomerOptionName(c)}
                    </div>
                    <div className="text-12 text-zinc-500">
                      {c.email || "No email"}
                      {c.phone ? ` · ${c.phone}` : ""}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {result && (
          <div
            className={cn(
              "mt-3 text-12",
              result.ok ? "text-zinc-900" : "text-alert-fg",
            )}
          >
            {result.text}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
        <Button onClick={handleSend} disabled={!selected || sending}>
          {sending ? "Sending…" : "Send prep guide"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// Usage-beacon leaf for the rendered tab state (exported for tests).
// Underscore keys (call_routing; the email_templates back-compat hash →
// the email sub-view of Templates) canonicalize to the hyphenated slug
// shape the tracking pipeline accepts, and the Templates sub-view reports
// the DEEPEST rendered leaf, matching the nested-*Tab convention.
export function usageLeafFor(tab, templateKind) {
  const leaf = tab === "templates" && templateKind === "email" ? "email-templates" : tab;
  return leaf.replace(/_/g, "-");
}

const TEMPLATE_KINDS = [
  { key: "sms", label: "SMS Templates" },
  { key: "email", label: "Email Templates" },
];

export default function CommunicationsPageV2() {
  const location = useLocation();
  const navigate = useNavigate();
  const [tab, setTab] = useState(() => new URLSearchParams(location.hash.replace(/^#/, "")).get("tab") || "sms");
  const [smsVisited, setSmsVisited] = useState(tab === "sms");
  // SMS / Email are sub-views of the single Message Templates tab.
  const [templateKind, setTemplateKind] = useState("sms");
  // Server-verified role from the shell's Outlet context (never localStorage).
  const outletContext = useOutletContext();
  const isAdminRole = outletContext?.user?.role === "admin";
  // Memoized by role: the hash-sync effect below depends on `tabs`, and a
  // fresh array every render would re-run applyHashTab() after each tab
  // click, snapping the user back to the deep-linked tab (codex P2).
  const tabs = useMemo(
    () => TABS.filter((t) => !t.adminOnly || isAdminRole),
    [isAdminRole],
  );
  const activeTab = tabs.some((item) => item.key === tab) ? tab : "sms";
  useEffect(() => { if (activeTab === "sms") setSmsVisited(true); }, [activeTab]);
  const selectTab = (nextTab) => {
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    params.set("tab", nextTab);
    navigate({ pathname: location.pathname, search: location.search, hash: `#${params}` });
  };

  // A hash deep link (or stale state) to a hidden management tab must not
  // strand a non-admin on a blank/unauthorized view.
  useEffect(() => {
    if (!tabs.some((t) => t.key === tab)) setTab("sms");
  }, [tabs, tab]);

  useEffect(() => {
    const applyHashTab = () => {
      const raw = window.location.hash.replace(/^#/, "");
      if (!raw) { setTab("sms"); return; }
      const params = new URLSearchParams(raw);
      const nextTab = params.get("tab");
      if (!nextTab) return;
      // Back-compat: the standalone Email Templates tab is now a sub-view of
      // Message Templates, so #tab=email_templates still lands on it.
      if (nextTab === "email_templates") {
        setTemplateKind("email");
        setTab("templates");
        return;
      }
      if (nextTab === "templates") setTemplateKind("sms");
      setTab(tabs.some((item) => item.key === nextTab) ? nextTab : "sms");
    };
    applyHashTab();
    window.addEventListener("hashchange", applyHashTab);
    return () => window.removeEventListener("hashchange", applyHashTab);
  }, [tabs, location.hash]);

  // Record the leaf that actually renders, including role fallbacks and the
  // raw hash links from NotificationEventsTabV2 that bypass router navigation.
  useRenderedTabBeacon("/admin/communications", usageLeafFor(activeTab, templateKind));

  const navigation = {
    title: "Communications", icon: MessageSquare, sections: tabs,
    activeKey: activeTab, onSectionChange: selectTab,
    ariaLabel: "Communications section", navGridClassName: "grid-cols-2 md:grid-cols-7",
  };

  return (
    <div className="bg-surface-page min-h-full font-sans text-zinc-900 max-w-[1300px] mx-auto">
      {" "}
      {activeTab === "email" ? <EmailPage key={outletContext.user.id} navigation={navigation} /> : <AdminCommandHeader
        {...navigation}
        secondarySections={tab === "templates" ? TEMPLATE_KINDS : []}
        secondaryActiveKey={templateKind}
        onSecondaryChange={setTemplateKind}
        secondaryAriaLabel="Template kind"
        secondaryNavGridClassName="grid-cols-2"
      />}
      {activeTab === "events" && <NotificationEventsTabV2 />}
      {smsVisited && <div hidden={activeTab !== "sms"}><SmsTab active={activeTab === "sms"} /></div>}
      {activeTab === "calls" && <CallLogTabV2 />}
      {activeTab === "triage" && <TriageInboxTabV2 />}
      {activeTab === "owed" && <OwedTabV2 />}
      {activeTab === "templates" && (
        <>
          {templateKind === "sms" ? (
            <SmsTemplatesTabV2 />
          ) : (
            <EmailTemplatesPanelV2 />
          )}
        </>
      )}
      {activeTab === "csr" && <CSRCoachTabV2 />}
      {activeTab === "call_routing" && <CallRoutingSettingsV2 />}
      {activeTab === "notifications" && <PushSettingsV2 />}
    </div>
  );
}
