import React, { useState, useEffect, useCallback, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Inbox, AlertTriangle } from "lucide-react";
import { Badge, Button, Card, CardBody } from "../../components/ui";
import { adminFetch, isRateLimitError } from "../../utils/admin-fetch";
import { formatETDateTime } from "../../lib/timezone";

// Communications -> Portal tab (GATE_PORTAL_INBOX). Lists what customers asked
// for inside the customer portal and nobody answered: portal chat hand-offs and
// customer service requests, plus (GATE_PORTAL_BOOKING_ITEMS) visitors who started to book and left. The last 14 days come first; open items older than
// that are listed one by one under the "Older than 14 days" line. Mark handled
// works on both. "Close all older" closes every older item and sends nothing to
// a customer.

const KIND_LABEL = { chat: "Chat", request: "Request", booking: "Booking not finished" };
const HANDLED_NOTE = "Handled in Communications → Portal";

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

const DONE_STATUSES = { chat: ["resolved", "dismissed"], request: ["resolved", "closed", "cancelled"], booking: ["done"] };

// Did the update route really finish the item? A request PATCH that lost a race
// answers 200 with the still-open row (statusChanged: false); keep it then. A booking item is a bell: its Done
// route answers { updated: true } only when this call closed it (false = someone else did, or it changed).
function handledStatus(item, res) {
  if (item.kind === "booking") return res?.updated === true ? "done" : "";
  return item.kind === "chat" ? res?.escalation?.status : res?.request?.status;
}

// Mark handled uses the existing update routes: chat -> the escalation PUT,
// request -> the request PATCH, booking -> the bell's own Done. `quiet` asks that PATCH not to email the customer "Resolved"
// (the server honors it only while GATE_PORTAL_ITEM_CLOSE is on; Customer 360 keeps its email).
function markHandled(item) {
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

// The slot the visitor picked, as a person says it: "Tue Nov 3, 1-2 PM" (the bell's own wording).
function clockParts(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ""));
  if (!m) return null;
  const hour = Number(m[1]);
  return { hour12: hour % 12 || 12, minute: m[2], meridiem: hour >= 12 ? "PM" : "AM" };
}

const clockText = (p, withMeridiem) => `${p.hour12}${p.minute === "00" ? "" : `:${p.minute}`}${withMeridiem ? ` ${p.meridiem}` : ""}`;

function rangeText(start, end) {
  const from = clockParts(start);
  if (!from) return "";
  const to = clockParts(end);
  if (!to) return clockText(from, true);
  return from.meridiem === to.meridiem ? `${clockText(from, false)}-${clockText(to, true)}` : `${clockText(from, true)}-${clockText(to, true)}`;
}

function slotText(slot) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(slot?.date || "");
  if (!m) return "";
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  const when = day.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).replace(",", "");
  const range = rangeText(slot.start, slot.end);
  return range ? `${when}, ${range}` : when;
}

function BookingDetails({ item }) {
  const picked = slotText(item.slot);
  const where = item.source === "estimate_card" ? "the card step of an estimate" : "the booking page";
  return (
    <>
      {item.service && <div className="text-14 font-medium text-zinc-900 mt-1" data-testid="booking-service">{item.service}</div>}
      {picked && <div className="text-14 text-zinc-800 mt-1" data-testid="booking-slot">They picked {picked}.</div>}
      <div className="text-14 text-ink-secondary mt-1" data-testid="booking-where">
        They left at {where} without finishing.
        {item.estimateId && (
          <>
            {" "}
            <Link className="underline" to={`/admin/estimates?estimateId=${encodeURIComponent(item.estimateId)}`}>Open the estimate</Link>
          </>
        )}
      </div>
      {item.verified === false && (
        <div className="text-14 text-ink-secondary mt-1" data-testid="booking-unverified">
          The phone was typed in online and is not verified.
        </div>
      )}
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

function InboxRow({ item, busy, error, onHandled, onReply, onOpenCustomer }) {
  const hasCustomer = Boolean(item.customer?.id);
  const canReply = Boolean(replyHref(item.customer));
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
      <div className="flex flex-wrap gap-2 mt-3">
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
      {error && (
        <div role="alert" className="flex items-center gap-2 text-14 text-alert-fg mt-2">
          <AlertTriangle size={14} strokeWidth={1.75} aria-hidden /> {error}
        </div>
      )}
    </div>
  );
}

const olderTotal = (older) => older.chats + older.requests + (older.bookings || 0);

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
      const closed = (res?.closed?.chats || 0) + (res?.closed?.requests || 0) + (res?.closed?.bookings || 0);
      setConfirming(false);
      setDone(`Closed ${plural(closed, "item", "items")}.`);
      onClosed();
    } catch (err) {
      setError(isRateLimitError(err) ? "You're going too fast — try again in a few seconds." : "Could not close them. Nothing changed.");
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
        });
      })
      .catch((err) => {
        setLoadError(isRateLimitError(err) ? "You're going too fast — try again in a few seconds." : "Failed to load.");
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
      handledSinceLoad.current += 1;
      // Lower a count only for a row still listed, so it drops once per row.
      // A recent row lowers the total; an older row lowers its older count.
      setData((prev) => {
        if (prev.items.some((row) => rowKey(row) === key)) {
          return { ...prev, items: prev.items.filter((row) => rowKey(row) !== key), total: Math.max(0, prev.total - 1) };
        }
        if (prev.olderItems.some((row) => rowKey(row) === key)) {
          const field = { chat: "chats", request: "requests", booking: "bookings" }[item.kind];
          return {
            ...prev,
            olderItems: prev.olderItems.filter((row) => rowKey(row) !== key),
            older: { ...prev.older, [field]: Math.max(0, (prev.older[field] || 0) - 1) },
          };
        }
        return prev;
      });
    } catch (err) {
      // A booking bell's Done answers 409 when the bell changed after this list loaded.
      const changed = item.kind === "booking" && err?.status === 409;
      const message = isRateLimitError(err)
        ? "You're going too fast — try again in a few seconds."
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
                  onHandled={handle}
                  onReply={reply}
                  onOpenCustomer={openCustomer}
                />
              ))}
            </div>
          ) : null}
          {data && (
            <OlderLine older={data.older} cutoff={data.cutoff} onClosed={() => setData((prev) => ({ ...prev, olderItems: [], older: { chats: 0, requests: 0, ...(prev.older.bookings !== undefined ? { bookings: 0 } : {}) } }))}>
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
                        onHandled={handle}
                        onReply={reply}
                        onOpenCustomer={openCustomer}
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
