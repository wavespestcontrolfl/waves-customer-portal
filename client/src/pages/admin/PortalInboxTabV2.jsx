import React, { useState, useEffect, useCallback, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Inbox, AlertTriangle } from "lucide-react";
import { Badge, Button, Card, CardBody, Textarea } from "../../components/ui";
import { adminFetch, isRateLimitError } from "../../utils/admin-fetch";
import { uuid } from "../../utils/ibSession";
import { formatETDateTime } from "../../lib/timezone";

// Communications -> Portal tab (GATE_PORTAL_INBOX). Lists what customers asked
// for inside the customer portal and nobody answered: portal chat hand-offs and
// customer service requests, plus (GATE_PORTAL_BOOKING_ITEMS) visitors who started to book and left. The last 14 days come first; open items older than
// that are listed one by one under the "Older than 14 days" line. Mark handled
// works on both. "Close all older" closes every older item and sends nothing to
// a customer.
//
// GATE_PORTAL_MESSAGES (the server says `replies: true`): "Reply in portal"
// answers a chat, a request or a customer's portal message inside the customer
// portal, and a customer's own portal message is a fourth kind of item.

const KIND_LABEL = { chat: "Chat", request: "Request", booking: "Booking not finished", message: "Message" };
const HANDLED_NOTE = "Handled in Communications → Portal";
const RATE_LIMITED = "You're going too fast — try again in a few seconds.";
const REPLY_KINDS = ["chat", "request", "message"];
const REPLY_MAX = 2000;

function customerName(customer) {
  const name = [customer?.firstName, customer?.lastName].filter(Boolean).join(" ");
  return name || "Customer";
}

function formatWhen(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return formatETDateTime(d, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

const DONE_STATUSES = { chat: ["resolved", "dismissed"], request: ["resolved", "closed", "cancelled"], booking: ["done"], message: ["done"] };

// Did the update route really finish the item? A request PATCH that lost a race
// answers 200 with the still-open row (statusChanged: false); keep it then. A booking item is a bell: its Done
// route answers { updated: true } only when this call closed it (false = someone else did, or it changed).
// A portal message is done once nothing in its thread is left open (open: true =
// the customer wrote again after the message this screen showed).
function handledStatus(item, res) {
  if (item.kind === "booking") return res?.updated === true ? "done" : "";
  if (item.kind === "message") return res?.open === false ? "done" : "";
  return item.kind === "chat" ? res?.escalation?.status : res?.request?.status;
}

// Mark handled uses the existing update routes: chat -> the escalation PUT,
// request -> the request PATCH, booking -> the bell's own Done. `quiet` asks that PATCH not to email the customer "Resolved"
// (the server honors it only while GATE_PORTAL_ITEM_CLOSE is on; Customer 360 keeps its email).
function markHandled(item) {
  if (item.kind === "message") {
    // Through the newest customer message this screen showed, so a newer one keeps the item open.
    return adminFetch(`/admin/portal-inbox/messages/${item.id}/handled`, {
      method: "POST",
      body: JSON.stringify({ throughId: item.throughId }),
    });
  }
  if (item.kind === "booking") {
    return adminFetch(`/admin/notifications/${item.id}/done`, {
      method: "PUT",
      body: JSON.stringify({ version: item.version, resolution: HANDLED_NOTE }),
    });
  }
  if (item.kind === "chat") {
    return adminFetch(`/ai/admin/escalations/${item.id}`, {
      method: "PUT",
      body: JSON.stringify({ status: "resolved", resolution_notes: HANDLED_NOTE }),
    });
  }
  return adminFetch(`/admin/requests/${item.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "resolved", quiet: true }),
  });
}

// Reply by text: open the customer's SMS thread when one exists, else a new
// text to their phone (the Customer 360 SMS panel picks the same way).
function replyHref(customer) {
  if (customer?.id && customer.hasTexts) return `/admin/communications?thread=${encodeURIComponent(customer.id)}#tab=sms`;
  if (customer?.phone) return `/admin/communications?phone=${encodeURIComponent(customer.phone)}&action=sms#tab=sms`;
  return null;
}

function RequestDetails({ item }) {
  const meta = [item.category, item.requestedService, item.source && `via ${item.source}`, item.urgency === "urgent" && "urgent"]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      {item.subject && <div className="text-14 font-medium text-zinc-900 mt-1">{item.subject}</div>}
      {item.property?.address && (
        <div className="text-14 text-ink-secondary mt-1" data-testid="request-property">
          {item.property.label ? `${item.property.label} · ` : ""}{item.property.address}
          {item.property.isPrimary ? "" : " (secondary property)"}
        </div>
      )}
      {item.description && <blockquote className="text-14 text-zinc-800 mt-1 border-l-2 border-zinc-300 pl-3">&ldquo;{item.description}&rdquo;</blockquote>}
      {meta && <div className="text-14 text-ink-secondary mt-1">{meta}</div>}
    </>
  );
}

function BookingDetails({ item }) {
  return (
    <>
      {item.service && <div className="text-14 font-medium text-zinc-900 mt-1" data-testid="booking-service">{item.service}</div>}
      <div className="text-14 text-ink-secondary mt-1" data-testid="booking-where">
        They left at the card step of an estimate without finishing.
        {item.estimateId && (
          <>
            {" "}
            <Link className="underline" to={`/admin/estimates?estimateId=${encodeURIComponent(item.estimateId)}`}>Open the estimate</Link>
          </>
        )}
      </div>
    </>
  );
}

function ChatDetails({ item }) {
  return (
    <>
      <blockquote className="text-14 text-zinc-800 mt-1 border-l-2 border-zinc-300 pl-3 whitespace-pre-wrap break-words">
        &ldquo;{item.customerMessage}&rdquo;
      </blockquote>
      {item.summary && item.summary.trim() !== item.customerMessage.trim() && (
        <div className="text-14 text-zinc-800 mt-2 whitespace-pre-wrap break-words" data-testid="chat-summary">
          <span className="font-medium">What they asked for:</span> {item.summary}
        </div>
      )}
      {item.assistantReply && (
        <div className="text-14 text-ink-secondary mt-2">
          <span className="font-medium">Assistant replied:</span> {item.assistantReply}
        </div>
      )}
    </>
  );
}

// The whole portal thread behind a message item (the item's text is a cut
// preview), newest 50 first loaded, oldest at the top.
function WholeThread({ threadId }) {
  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async (before) => {
    setLoading(true);
    setError("");
    try {
      const page = await adminFetch(`/admin/portal-inbox/messages/${threadId}${before ? `?before=${encodeURIComponent(before)}` : ""}`);
      const messages = Array.isArray(page?.messages) ? page.messages : [];
      setThread((prev) => ({ messages: before && prev ? [...messages, ...prev.messages] : messages, hasMore: page?.hasMore === true }));
    } catch (err) {
      setError(isRateLimitError(err) ? RATE_LIMITED : "Could not load the thread. Try again.");
    } finally {
      setLoading(false);
    }
  };

  if (!thread) {
    return (
      <div className="mt-2">
        <Button type="button" density="comfortable" variant="ghost" disabled={loading} onClick={() => load()}>
          {loading ? "Loading…" : "Show whole thread"}
        </Button>
        {error && <div role="alert" className="text-14 text-alert-fg mt-1">{error}</div>}
      </div>
    );
  }
  return (
    <div className="mt-3 space-y-2 border-l-2 border-zinc-200 pl-3" data-testid={`portal-thread-${threadId}`}>
      {thread.hasMore && (
        <Button type="button" density="comfortable" variant="ghost" disabled={loading} onClick={() => load(thread.messages[0]?.createdAt)}>
          {loading ? "Loading…" : "Show earlier messages"}
        </Button>
      )}
      {thread.messages.map((m) => (
        <div key={m.id}>
          <div className="text-14 text-ink-tertiary">{m.direction === "outbound" ? "Waves" : "Customer"} · {formatWhen(m.createdAt)}</div>
          <div className="text-14 text-zinc-900 whitespace-pre-wrap break-words">{m.body}</div>
        </div>
      ))}
      {error && <div role="alert" className="text-14 text-alert-fg">{error}</div>}
    </div>
  );
}

function MessageDetails({ item }) {
  return (
    <>
      <blockquote className="text-14 text-zinc-800 mt-1 border-l-2 border-zinc-300 pl-3 whitespace-pre-wrap break-words">
        &ldquo;{item.customerMessage}&rdquo;
      </blockquote>
      {item.lastAnswer && (
        <div className="text-14 text-ink-secondary mt-2">
          <span className="font-medium">Last answer:</span> {item.lastAnswer}
        </div>
      )}
      <WholeThread threadId={item.id} />
    </>
  );
}

// How the customer was told about an answer saved in the portal.
export function noticeLine(name, notice) {
  if (Number(notice?.pushAccepted) > 0) return `Sent to ${name} in the portal. They got a notice in the Waves app.`;
  if (notice?.email === "sent") return `Sent to ${name} in the portal. We emailed them your answer.`;
  if (notice?.pending) return `Sent to ${name} in the portal. Their notice did not go out yet; we try again in a few minutes.`;
  return `Sent to ${name} in the portal, but we could not reach them by app or email. Reply by text too.`;
}

// The answer box under a row. A request id belongs to the exact text it was
// made for: Send again after a failure, with the same text, is one answer (the
// server replays it); changed text gets a new id. The box is read-only while it
// sends.
function PortalReply({ item, onSent, onCancel }) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef(null);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    if (requestRef.current?.text !== text) requestRef.current = { id: uuid(), text };
    setSending(true);
    setError("");
    try {
      const res = await adminFetch("/admin/portal-inbox/reply", {
        method: "POST",
        body: JSON.stringify({ kind: item.kind, id: item.id, body: text, requestId: requestRef.current.id }),
      });
      onSent(item, res);
    } catch (err) {
      // The service's refusals carry a code and words for staff (gone, inactive customer, empty).
      setError(isRateLimitError(err) ? RATE_LIMITED : err?.code && err.message ? err.message : "Could not send. Try again.");
      setSending(false);
    }
  };

  return (
    <div className="mt-3 space-y-2" data-testid={`portal-reply-${item.kind}-${item.id}`}>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        readOnly={sending}
        maxLength={REPLY_MAX}
        rows={4}
        density="comfortable"
        aria-label="Answer in the portal"
        placeholder="Write your answer. The customer reads it in their portal."
      />
      <div className="text-14 text-ink-secondary">
        They get a notice in the Waves app, or an email with your answer when they don't have the app.
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" density="comfortable" variant="primary" disabled={sending || !draft.trim()} onClick={send}>
          {sending ? "Sending…" : "Send in portal"}
        </Button>
        <Button type="button" density="comfortable" variant="secondary" disabled={sending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error && (
        <div role="alert" className="flex items-center gap-2 text-14 text-alert-fg">
          <AlertTriangle size={14} strokeWidth={1.75} aria-hidden /> {error}
        </div>
      )}
    </div>
  );
}

function InboxRow({ item, busy, error, replies, onHandled, onReply, onOpenCustomer, onSent }) {
  const hasCustomer = Boolean(item.customer?.id);
  const canReply = Boolean(replyHref(item.customer));
  const canPortalReply = replies && hasCustomer && REPLY_KINDS.includes(item.kind);
  const [replying, setReplying] = useState(false);
  return (
    <div className="py-4 first:pt-0 last:pb-0" data-testid={`portal-row-${item.kind}-${item.id}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <Badge tone="neutral">{KIND_LABEL[item.kind]}</Badge>
        <span className="text-14 font-medium text-zinc-900">{customerName(item.customer)}</span>
        <span className="text-14 text-ink-tertiary">{formatWhen(item.createdAt)}</span>
      </div>
      {item.kind === "chat" && <ChatDetails item={item} />}
      {item.kind === "request" && <RequestDetails item={item} />}
      {item.kind === "booking" && <BookingDetails item={item} />}
      {item.kind === "message" && <MessageDetails item={item} />}
      <div className="flex flex-wrap gap-2 mt-3">
        {canPortalReply && !replying && (
          <Button type="button" density="comfortable" variant="secondary" onClick={() => setReplying(true)}>
            Reply in portal
          </Button>
        )}
        <Button type="button" density="comfortable" variant="secondary" disabled={!canReply} title={canReply ? undefined : "No phone on file"} onClick={() => onReply(item)}>
          Reply by text
        </Button>
        <Button type="button" density="comfortable" variant="secondary" disabled={!hasCustomer} onClick={() => onOpenCustomer(item)}>
          Open customer
        </Button>
        <Button type="button" density="comfortable" variant="primary" disabled={busy} onClick={() => onHandled(item)}>
          {busy ? "Saving…" : "Mark handled"}
        </Button>
      </div>
      {replying && <PortalReply item={item} onSent={onSent} onCancel={() => setReplying(false)} />}
      {error && (
        <div role="alert" className="flex items-center gap-2 text-14 text-alert-fg mt-2">
          <AlertTriangle size={14} strokeWidth={1.75} aria-hidden /> {error}
        </div>
      )}
    </div>
  );
}

const olderTotal = (older) => older.chats + older.requests + (older.bookings || 0) + (older.messages || 0);
const OLDER_FIELD = { chat: "chats", request: "requests", booking: "bookings", message: "messages" };

function OlderLine({ older, cutoff, onClosed, children }) {
  const total = olderTotal(older);
  const [confirming, setConfirming] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  if (!total && !done) return null;

  const closeThem = async () => {
    setClosing(true);
    setError("");
    try {
      const res = await adminFetch("/admin/portal-inbox/close-older", {
        method: "POST",
        body: JSON.stringify({ cutoff }),
      });
      const closed = (res?.closed?.chats || 0) + (res?.closed?.requests || 0) + (res?.closed?.bookings || 0) + (res?.closed?.messages || 0);
      setConfirming(false);
      setDone(`Closed ${plural(closed, "item", "items")}.`);
      onClosed();
    } catch (err) {
      setError(isRateLimitError(err) ? RATE_LIMITED : "Could not close them. Nothing changed.");
    } finally {
      setClosing(false);
    }
  };

  return (
    <div className="mt-4 pt-4 border-t border-zinc-200">
      {done ? (
        <div className="text-14 text-ink-secondary" role="status">{done}</div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-14 text-zinc-900">
              Older than 14 days: {plural(older.chats, "chat hand-off", "chat hand-offs")} and {plural(older.requests, "request", "requests")}
              {older.bookings > 0 && <>{" "}and {plural(older.bookings, "booking not finished", "bookings not finished")}</>}
              {older.messages > 0 && <>{" "}and {plural(older.messages, "portal message", "portal messages")}</>}
            </span>
            {!confirming && (
              <Button type="button" density="comfortable" variant="secondary" onClick={() => setConfirming(true)}>
                Close all older
              </Button>
            )}
          </div>
          {confirming && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <span className="text-14 text-zinc-900">
                Close {plural(total, "item", "items")}? Customers get no message.
              </span>
              <Button type="button" density="comfortable" variant="primary" disabled={closing} onClick={closeThem}>
                {closing ? "Closing…" : "Close them"}
              </Button>
              <Button type="button" density="comfortable" variant="secondary" disabled={closing} onClick={() => { setConfirming(false); setError(""); }}>
                Cancel
              </Button>
            </div>
          )}
          {error && (
            <div role="alert" className="flex items-center gap-2 text-14 text-alert-fg mt-2">
              <AlertTriangle size={14} strokeWidth={1.75} aria-hidden /> {error}
            </div>
          )}
          {children}
        </>
      )}
    </div>
  );
}

// onCount(n): tells the page how many items are open in the last 14 days, so
// the tab label stays in step as rows are handled.
export default function PortalInboxTabV2({ onCount }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState("");
  // Rows with a Mark handled in flight. The ref guards a second click on the
  // same row synchronously; the state drives each row's busy button.
  const pendingKeys = useRef(new Set());
  const [busyKeys, setBusyKeys] = useState(() => new Set());
  const [rowErrors, setRowErrors] = useState({});
  // The last portal answer sent from this tab: how the customer was told.
  const [sentNote, setSentNote] = useState("");
  // Rows handled since the last load: when they empty a capped list that still
  // has more open items (total), the tab loads the next ones once.
  const handledSinceLoad = useRef(0);

  const load = useCallback(() => {
    handledSinceLoad.current = 0;
    setLoadError("");
    return adminFetch("/admin/portal-inbox")
      .then((d) => {
        const items = d.items || [];
        setData({
          cutoff: d.cutoff,
          items,
          olderItems: d.olderItems || [],
          total: Number.isFinite(d.total) ? d.total : items.length,
          older: d.older || { chats: 0, requests: 0 },
          replies: d.replies === true,
        });
      })
      .catch((err) => {
        setLoadError(isRateLimitError(err) ? RATE_LIMITED : "Failed to load.");
      });
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCount = data ? data.total : null;
  useEffect(() => { if (openCount !== null) onCount?.(openCount); }, [openCount, onCount]);
  useEffect(() => {
    if (!data || handledSinceLoad.current === 0) return;
    const recentOut = data.items.length === 0 && data.total > 0;
    // The older list is capped too: once its listed rows are all handled, load the next ones.
    const olderOut = data.olderItems.length === 0 && olderTotal(data.older) > 0;
    if (recentOut || olderOut) load();
  }, [data, load]);

  const rowKey = (item) => `${item.kind}:${item.id}`;

  const setBusy = (key, on) => setBusyKeys((prev) => {
    const next = new Set(prev);
    if (on) next.add(key); else next.delete(key);
    return next;
  });

  // A handled or answered row leaves the list once. A recent row lowers the
  // total; an older row lowers its older count.
  const dropRow = (item) => {
    const key = rowKey(item);
    handledSinceLoad.current += 1;
    setData((prev) => {
      if (prev.items.some((row) => rowKey(row) === key)) {
        return { ...prev, items: prev.items.filter((row) => rowKey(row) !== key), total: Math.max(0, prev.total - 1) };
      }
      if (prev.olderItems.some((row) => rowKey(row) === key)) {
        const field = OLDER_FIELD[item.kind];
        return {
          ...prev,
          olderItems: prev.olderItems.filter((row) => rowKey(row) !== key),
          older: { ...prev.older, [field]: Math.max(0, (prev.older[field] || 0) - 1) },
        };
      }
      return prev;
    });
  };

  const handle = async (item) => {
    const key = rowKey(item);
    if (pendingKeys.current.has(key)) return;
    pendingKeys.current.add(key);
    setBusy(key, true);
    setRowErrors((prev) => ({ ...prev, [key]: "" }));
    try {
      const res = await markHandled(item);
      if (!DONE_STATUSES[item.kind].includes(handledStatus(item, res))) {
        setRowErrors((prev) => ({ ...prev, [key]: "This changed before you could mark it handled. It is still open." }));
        return;
      }
      dropRow(item);
    } catch (err) {
      // A booking bell's Done answers 409 when the bell changed after this list loaded.
      const changed = item.kind === "booking" && err?.status === 409;
      const message = isRateLimitError(err)
        ? RATE_LIMITED
        : changed ? "This changed before you could mark it handled. It is still open." : "Could not mark this handled. Try again.";
      setRowErrors((prev) => ({ ...prev, [key]: message }));
    } finally {
      pendingKeys.current.delete(key);
      setBusy(key, false);
    }
  };

  const reply = (item) => {
    const href = replyHref(item.customer);
    if (href) navigate(href);
  };
  const openCustomer = (item) => navigate(`/admin/customers?customerId=${encodeURIComponent(item.customer.id)}`);
  // An answer saved in the portal closes the item it answers.
  const sent = (item, res) => {
    dropRow(item);
    setSentNote(noticeLine(customerName(item.customer), res?.notice));
  };

  return (
    <div className="p-4 md:p-6 space-y-4">
      <p className="text-14 text-ink-secondary">
        What customers asked for in the customer portal and nobody answered yet. The last 14 days first, then anything older.
      </p>
      {data && data.total > data.items.length && (
        <p className="text-14 text-ink-secondary" role="status">
          Showing {data.items.length} of {data.total}. The rest load as you handle these.
        </p>
      )}
      {sentNote && (
        <p className="text-14 text-zinc-900" role="status" data-testid="portal-sent-note">{sentNote}</p>
      )}
      {loadError && (
        <div role="alert" className="flex items-center gap-2 text-14 text-alert-fg bg-alert-bg border-hairline border-alert-fg/30 rounded-md px-3 py-2">
          <AlertTriangle size={14} strokeWidth={1.75} aria-hidden /> {loadError}
        </div>
      )}
      <Card>
        <CardBody>
          {!data && !loadError ? (
            <div className="p-8 text-center text-ink-tertiary text-14">Loading&hellip;</div>
          ) : data && data.items.length === 0 ? (
            <div className="p-10 text-center">
              <Inbox size={28} strokeWidth={1.5} className="mx-auto text-ink-disabled mb-2" aria-hidden />
              <div className="text-14 text-ink-secondary">Nothing open from the last 14 days.</div>
            </div>
          ) : data ? (
            <div className="divide-y divide-zinc-200">
              {data.items.map((item) => (
                <InboxRow
                  key={rowKey(item)}
                  item={item}
                  busy={busyKeys.has(rowKey(item))}
                  error={rowErrors[rowKey(item)]}
                  replies={data.replies}
                  onHandled={handle}
                  onReply={reply}
                  onOpenCustomer={openCustomer}
                  onSent={sent}
                />
              ))}
            </div>
          ) : null}
          {data && (
            <OlderLine older={data.older} cutoff={data.cutoff} onClosed={() => setData((prev) => ({ ...prev, olderItems: [], older: { chats: 0, requests: 0, ...(prev.older.bookings !== undefined ? { bookings: 0 } : {}), ...(prev.older.messages !== undefined ? { messages: 0 } : {}) } }))}>
              {data.olderItems.length > 0 && (
                <div className="mt-4">
                  {olderTotal(data.older) > data.olderItems.length && (
                    <p className="text-14 text-ink-secondary mb-3" role="status">
                      Showing {data.olderItems.length} of {olderTotal(data.older)} older items, newest first.
                    </p>
                  )}
                  <div className="divide-y divide-zinc-200" data-testid="portal-older-list">
                    {data.olderItems.map((item) => (
                      <InboxRow
                        key={rowKey(item)}
                        item={item}
                        busy={busyKeys.has(rowKey(item))}
                        error={rowErrors[rowKey(item)]}
                        replies={data.replies}
                        onHandled={handle}
                        onReply={reply}
                        onOpenCustomer={openCustomer}
                        onSent={sent}
                      />
                    ))}
                  </div>
                </div>
              )}
            </OlderLine>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
