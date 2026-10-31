import React, { useState, useEffect, useCallback, useRef } from "react";
import { MessagesSquare, AlertTriangle, ExternalLink } from "lucide-react";
import { Badge, Button, Card, CardBody, Textarea } from "../../components/ui";
import { adminFetch, isRateLimitError } from "../../utils/admin-fetch";
import { formatETDateTime } from "../../lib/timezone";

// Communications -> Messenger tab (GATE_MESSENGER_INBOX). The Facebook page's
// Messenger threads, read into the portal every 3 minutes. A reply goes out
// through Facebook's Send API, which allows it for 24 hours after the
// customer's last message; past that the tab links to Facebook instead.

const FACEBOOK_INBOX_URL = "https://business.facebook.com/latest/inbox/all";
const REPLY_MAX = 2000;
const WINDOW_NOTE = "Facebook allows a reply for 24 hours after the customer's last message.";
const REFRESH_MS = 60 * 1000;
const SLOW_DOWN = "You're going too fast — try again in a few seconds.";

function formatWhen(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return formatETDateTime(d, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function threadFromHash() {
  try {
    return new URLSearchParams(window.location.hash.replace(/^#/, "")).get("thread") || "";
  } catch {
    return "";
  }
}

function ThreadRow({ thread, selected, onOpen }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(thread.id)}
      aria-current={selected ? "true" : undefined}
      data-testid={`messenger-thread-${thread.id}`}
      className={`w-full text-left px-4 py-3 border-b border-zinc-200 last:border-b-0 hover:bg-zinc-50 ${selected ? "bg-zinc-100" : ""}`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-14 font-medium text-zinc-900">{thread.name}</span>
        {thread.unread > 0 && <Badge tone="neutral">{thread.unread} new</Badge>}
        {!thread.answered && thread.unread === 0 && <Badge tone="neutral">Not answered</Badge>}
        <span className="text-14 text-ink-tertiary ml-auto">{formatWhen(thread.lastMessageAt)}</span>
      </div>
      {thread.snippet && <div className="text-14 text-ink-secondary mt-1 break-words">{thread.snippet}</div>}
    </button>
  );
}

function MessageBubble({ message }) {
  const mine = message.direction === "outbound";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`} data-testid={`messenger-message-${message.id}`}>
      <div className={`max-w-[85%] rounded-md px-3 py-2 ${mine ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-900"}`}>
        <div className="text-14 whitespace-pre-wrap break-words">{message.body}</div>
        <div className={`text-14 mt-1 ${mine ? "text-zinc-300" : "text-ink-tertiary"}`}>
          {mine ? (message.author?.name ? `${message.author.name} · ` : "Page · ") : ""}{formatWhen(message.createdAt)}
        </div>
      </div>
    </div>
  );
}

// threadId: the thread whose detail is on screen (never the one just clicked).
// ready: false while the clicked thread is still loading, so a draft written for
// one thread cannot be sent to another.
function ReplyBox({ threadId, canReply, ready, onSend }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  // A ref guards a double click before the busy state renders.
  const inFlight = useRef(false);

  if (!canReply) {
    return (
      <div className="mt-4 pt-4 border-t border-zinc-200 space-y-2" data-testid="messenger-outside-window">
        <p className="text-14 text-zinc-900">{WINDOW_NOTE}</p>
        <a
          className="inline-flex items-center gap-1 text-14 font-medium text-zinc-900 underline"
          href={FACEBOOK_INBOX_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Reply in Facebook <ExternalLink size={14} strokeWidth={1.75} aria-hidden />
        </a>
      </div>
    );
  }

  const trimmed = text.trim();
  const send = async () => {
    if (!ready || !trimmed || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError("");
    try {
      await onSend(threadId, trimmed);
      setText("");
    } catch (err) {
      setError(isRateLimitError(err) ? SLOW_DOWN
        : err?.status === 409 ? WINDOW_NOTE
          // 504, or no answer reached the browser (a dropped connection): the reply may have gone out.
          : err?.status === 504 || !err?.status ? "Facebook did not confirm this reply. Check the thread in Facebook before you send it again."
            : "Facebook did not accept the reply. Nothing was sent.");
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  return (
    <div className="mt-4 pt-4 border-t border-zinc-200 space-y-2">
      <Textarea
        rows={3}
        value={text}
        maxLength={REPLY_MAX}
        onChange={(e) => setText(e.target.value)}
        disabled={sending || !ready}
        aria-label="Reply on Facebook"
        placeholder="Write a reply"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" density="comfortable" variant="primary" disabled={sending || !ready || !trimmed} onClick={send}>
          {sending ? "Sending…" : "Send"}
        </Button>
        <span className="text-14 text-ink-secondary">
          {!ready ? "Loading the thread you picked. Wait for it to open." : sending ? "Sending to Facebook. Wait for it to finish." : !trimmed ? "Type a reply to send it." : "Sends on Facebook as the page."}
        </span>
      </div>
      {error && (
        <div role="alert" className="flex items-center gap-2 text-14 text-alert-fg">
          <AlertTriangle size={14} strokeWidth={1.75} aria-hidden /> {error}
        </div>
      )}
    </div>
  );
}

// onCount(n): how many threads wait for an answer, so the tab label follows
// the list as replies go out.
export default function MessengerTabV2({ onCount }) {
  // list: the loaded threads, whether older ones exist, and the server's count of threads
  // waiting for an answer (the whole inbox, not just the loaded page).
  const [list, setList] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [selectedId, setSelectedId] = useState(threadFromHash);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState("");
  const listSeq = useRef(0);
  const olderLoaded = useRef(false);
  const threads = list ? list.items : null;

  // Reloads the newest page. When older pages were loaded, they stay below the fresh page.
  const loadThreads = useCallback(() => {
    listSeq.current += 1;
    const seq = listSeq.current;
    return adminFetch("/admin/messenger/threads")
      .then((d) => {
        if (seq !== listSeq.current) return;
        setLoadError("");
        const fresh = d.threads || [];
        setList((prev) => {
          if (!prev || !olderLoaded.current || !fresh.length) return { items: fresh, hasMore: Boolean(d.hasMore), unanswered: Number(d.unanswered) || 0 };
          // Older rows sit after the fresh page's last row in the server's order: newest time first,
          // then the higher id (the keyset is time, then id).
          const tail = fresh[fresh.length - 1];
          const afterTail = (t) => t.lastMessageAt < tail.lastMessageAt || (t.lastMessageAt === tail.lastMessageAt && t.id < tail.id);
          const kept = prev.items.filter((t) => afterTail(t) && !fresh.some((f) => f.id === t.id));
          return { items: [...fresh, ...kept], hasMore: prev.hasMore, unanswered: Number(d.unanswered) || 0 };
        });
      })
      .catch((err) => {
        if (seq === listSeq.current) setLoadError(isRateLimitError(err) ? SLOW_DOWN : "Failed to load.");
      });
  }, []);

  const showOlder = async () => {
    const last = list?.items[list.items.length - 1];
    if (!last || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const d = await adminFetch(`/admin/messenger/threads?before=${encodeURIComponent(last.lastMessageAt)}&beforeId=${encodeURIComponent(last.id)}`);
      olderLoaded.current = true;
      setList((prev) => ({
        items: [...prev.items, ...(d.threads || []).filter((t) => !prev.items.some((x) => x.id === t.id))],
        hasMore: Boolean(d.hasMore),
        unanswered: Number(d.unanswered) || 0,
      }));
    } catch (err) {
      setLoadError(isRateLimitError(err) ? SLOW_DOWN : "Failed to load older threads.");
    } finally {
      setLoadingOlder(false);
    }
  };

  useEffect(() => { loadThreads(); }, [loadThreads]);

  useEffect(() => {
    if (list) onCount?.(list.unanswered);
  }, [list, onCount]);

  // The thread the person last picked. A response for any other thread is stale and ignored,
  // and so is an older response for the same thread (detailSeq).
  const picked = useRef(selectedId);
  const detailSeq = useRef(0);
  const sending = useRef(0);
  const opening = useRef(0);
  const loadDetail = useCallback(async (id, { refresh = false } = {}) => {
    // A refresh waits out a send and a thread the person is still opening.
    if (refresh && (picked.current !== id || sending.current > 0 || opening.current > 0)) return;
    if (!refresh) {
      picked.current = id;
      setSelectedId(id);
      setDetailError("");
    }
    detailSeq.current += 1;
    const seq = detailSeq.current;
    const current = () => picked.current === id && seq === detailSeq.current;
    if (!refresh) opening.current += 1;
    try {
      const d = await adminFetch(`/admin/messenger/threads/${encodeURIComponent(id)}`);
      if (!current()) return;
      setDetail(d);
      if (d.thread?.unread > 0) {
        await adminFetch(`/admin/messenger/threads/${encodeURIComponent(id)}/read`, { method: "POST" });
        setList((prev) => prev && { ...prev, items: prev.items.map((t) => (t.id === id ? { ...t, unread: 0 } : t)) });
      }
    } catch (err) {
      if (refresh || !current()) return;
      setDetail(null);
      setDetailError(isRateLimitError(err) ? SLOW_DOWN : "Could not open this thread.");
    } finally {
      if (!refresh) opening.current -= 1;
    }
  }, []);
  const openThread = loadDetail;

  // A thread named in the page link opens once, when the tab first renders.
  useEffect(() => { if (selectedId) openThread(selectedId); }, []);

  // While the tab is open and visible, the list and the open thread refresh every minute, and
  // once when the page comes back into view. A refresh never touches the draft or the selection.
  useEffect(() => {
    const visible = () => document.visibilityState === "visible";
    const refresh = () => {
      if (!visible()) return;
      loadThreads();
      if (picked.current) loadDetail(picked.current, { refresh: true });
    };
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [loadThreads, loadDetail]);

  // Posts to the thread whose detail is displayed, then refreshes it if it is still the picked one.
  const send = async (threadId, text) => {
    sending.current += 1;
    try {
      await adminFetch(`/admin/messenger/threads/${encodeURIComponent(threadId)}/reply`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
    } finally {
      sending.current -= 1;
    }
    await Promise.all([picked.current === threadId ? openThread(threadId) : null, loadThreads()]);
  };

  const displayed = detail?.thread?.id || null;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <p className="text-14 text-ink-secondary">
        Messages sent to the Waves Pest Control Facebook page. New ones appear within a few minutes.
      </p>
      {loadError && (
        <div role="alert" className="flex items-center gap-2 text-14 text-alert-fg bg-alert-bg border-hairline border-alert-fg/30 rounded-md px-3 py-2">
          <AlertTriangle size={14} strokeWidth={1.75} aria-hidden /> {loadError}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card>
          <CardBody className="p-0">
            {!threads && !loadError ? (
              <div className="p-8 text-center text-ink-tertiary text-14">Loading&hellip;</div>
            ) : threads && threads.length === 0 ? (
              <div className="p-10 text-center">
                <MessagesSquare size={28} strokeWidth={1.5} className="mx-auto text-ink-disabled mb-2" aria-hidden />
                <div className="text-14 text-ink-secondary">No Facebook messages yet.</div>
              </div>
            ) : threads ? (
              <div>
                {threads.map((t) => (
                  <ThreadRow key={t.id} thread={t} selected={t.id === selectedId} onOpen={openThread} />
                ))}
                {list.hasMore && (
                  <div className="p-3 border-t border-zinc-200">
                    <Button type="button" density="comfortable" variant="secondary" disabled={loadingOlder} onClick={showOlder}>
                      {loadingOlder ? "Loading…" : "Show older"}
                    </Button>
                  </div>
                )}
              </div>
            ) : null}
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            {detailError && (
              <div role="alert" className="flex items-center gap-2 text-14 text-alert-fg">
                <AlertTriangle size={14} strokeWidth={1.75} aria-hidden /> {detailError}
              </div>
            )}
            {!detail && !detailError && (
              <div className="p-8 text-center text-ink-tertiary text-14">Pick a thread to read it.</div>
            )}
            {detail && (
              <div data-testid="messenger-detail">
                <div className="text-14 font-medium text-zinc-900 mb-3">{detail.thread.name}</div>
                <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                  {detail.messages.map((m) => <MessageBubble key={m.id} message={m} />)}
                </div>
                {detail.hasOlder && (
                  <p className="text-14 text-ink-secondary mt-2" data-testid="messenger-has-older">Showing the latest 500 messages.</p>
                )}
                <ReplyBox key={detail.thread.id} threadId={detail.thread.id} canReply={detail.thread.canReply} ready={displayed === selectedId} onSend={send} />
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
