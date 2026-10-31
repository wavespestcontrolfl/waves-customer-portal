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

function ReplyBox({ canReply, onSend }) {
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
    if (!trimmed || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError("");
    try {
      await onSend(trimmed);
      setText("");
    } catch (err) {
      setError(isRateLimitError(err) ? SLOW_DOWN
        : err?.status === 409 ? WINDOW_NOTE
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
        disabled={sending}
        aria-label="Reply on Facebook"
        placeholder="Write a reply"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" density="comfortable" variant="primary" disabled={sending || !trimmed} onClick={send}>
          {sending ? "Sending…" : "Send"}
        </Button>
        <span className="text-14 text-ink-secondary">
          {sending ? "Sending to Facebook. Wait for it to finish." : !trimmed ? "Type a reply to send it." : "Sends on Facebook as the page."}
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
  const [threads, setThreads] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [selectedId, setSelectedId] = useState(threadFromHash);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState("");

  const loadThreads = useCallback(() => {
    setLoadError("");
    return adminFetch("/admin/messenger/threads")
      .then((d) => setThreads(d.threads || []))
      .catch((err) => setLoadError(isRateLimitError(err) ? SLOW_DOWN : "Failed to load."));
  }, []);

  useEffect(() => { loadThreads(); }, [loadThreads]);

  useEffect(() => {
    if (threads) onCount?.(threads.filter((t) => !t.answered).length);
  }, [threads, onCount]);

  const openThread = useCallback(async (id) => {
    setSelectedId(id);
    setDetailError("");
    try {
      const d = await adminFetch(`/admin/messenger/threads/${encodeURIComponent(id)}`);
      setDetail(d);
      if (d.thread?.unread > 0) {
        await adminFetch(`/admin/messenger/threads/${encodeURIComponent(id)}/read`, { method: "POST" });
        setThreads((prev) => prev && prev.map((t) => (t.id === id ? { ...t, unread: 0 } : t)));
      }
    } catch (err) {
      setDetail(null);
      setDetailError(isRateLimitError(err) ? SLOW_DOWN : "Could not open this thread.");
    }
  }, []);

  // A thread named in the page link opens once, when the tab first renders.
  useEffect(() => { if (selectedId) openThread(selectedId); }, []);

  const send = async (text) => {
    await adminFetch(`/admin/messenger/threads/${encodeURIComponent(selectedId)}/reply`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    await Promise.all([openThread(selectedId), loadThreads()]);
  };

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
                <ReplyBox key={detail.thread.id} canReply={detail.thread.canReply} onSend={send} />
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
