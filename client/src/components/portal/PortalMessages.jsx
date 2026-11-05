// client/src/components/portal/PortalMessages.jsx
// The customer's "Messages" page: one thread between the customer and the Waves
// office, so a question asked in the app is answered in the app. Dark behind a
// server gate: PortalPage only lists the tab once GET /api/portal-messages/unread-count
// answers 200. Contract (server/routes/portal-messages):
//   GET  /portal-messages[?before=ISO]  { messages oldest->newest, hasMore, unread }
//   POST /portal-messages               { body, requestId } -> { message }
//   POST /portal-messages/read          { throughId } -> { unread }
import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../../utils/api';
import { COLORS as B, FONTS } from '../../theme-brand';
import { CUSTOMER_SURFACE as SHELL } from '../../theme-customer';
import { formatETDateTime } from '../../lib/timezone';
import { scrollBehavior } from '../../lib/scrollMotion';
import Icon from '../Icon';

export const MAX_MESSAGE_LENGTH = 2000;
// The counter only shows when the limit is close.
const COUNTER_FROM = 1800;
const REFRESH_MS = 60 * 1000;

export const MESSAGES_COPY = {
  title: 'Messages',
  subtitle: 'Questions and answers between you and the Waves team.',
  empty: 'No messages yet. When our team answers a question you asked in the app, it shows up here. You can also write to us below.',
  loadError: 'Messages couldn’t be loaded.',
  placeholder: 'Write a message to the Waves team',
  help: 'We answer between 8 AM and 8 PM, usually within one business hour.',
  tooMany: 'Too many messages in a short time. Please wait a little, or call or text our office.',
  sendFailed: 'Your message didn’t send. Check your connection and try again.',
};

// One UUID v4 per draft. crypto.randomUUID needs a secure context, so older
// WebViews fall through to getRandomValues and last to Math.random.
export function makeRequestId() {
  const c = typeof crypto !== 'undefined' ? crypto : null;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sendErrorText(err) {
  if (err?.status === 400 && err.message) return err.message;
  if (err?.status === 429) return MESSAGES_COPY.tooMany;
  return MESSAGES_COPY.sendFailed;
}

// Merge messages by id, oldest first. A refresh that returns a message the page
// already holds (one the customer just sent) never shows it twice.
function mergeMessages(current, incoming) {
  const seen = new Set(current.map((m) => m.id));
  const added = incoming.filter((m) => m && !seen.has(m.id));
  if (!added.length) return current;
  return [...current, ...added].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

const newestWavesId = (messages) => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].from === 'waves') return messages[i].id;
  }
  return null;
};

const isVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

// The thread: first load, "Show earlier messages", a quiet refresh while the
// page is open, and a way to add the message the customer just sent.
function useThread() {
  const [messages, setMessages] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState(false);
  const messagesRef = useRef([]);
  messagesRef.current = messages;
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const load = useCallback(() => {
    setStatus('loading');
    api.getPortalMessages()
      .then((d) => {
        if (!live.current) return;
        setMessages(Array.isArray(d?.messages) ? d.messages : []);
        setHasMore(d?.hasMore === true);
        setStatus('ready');
      })
      .catch(() => { if (live.current) setStatus('error'); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const loadEarlier = useCallback(() => {
    const oldest = messagesRef.current[0];
    if (!oldest) return;
    setLoadingEarlier(true);
    setEarlierError(false);
    api.getPortalMessages(oldest.createdAt)
      .then((d) => {
        if (!live.current) return;
        setMessages((prev) => mergeMessages(prev, Array.isArray(d?.messages) ? d.messages : []));
        setHasMore(d?.hasMore === true);
      })
      .catch(() => { if (live.current) setEarlierError(true); })
      .finally(() => { if (live.current) setLoadingEarlier(false); });
  }, []);

  const add = useCallback((message) => setMessages((prev) => mergeMessages(prev, [message])), []);

  // A new answer from the office shows up without a reload. A failed refresh
  // is silent: the thread on screen is still right. When more came than one
  // page holds (the page was hidden, or refreshes failed), the newest page
  // replaces the thread and "Show earlier messages" reaches the rest, so no gap
  // is left that no button can fill.
  const refresh = useCallback(() => {
    if (!isVisible() || status !== 'ready') return;
    api.getPortalMessages()
      .then((d) => {
        if (!live.current || !Array.isArray(d?.messages)) return;
        const held = new Set(messagesRef.current.map((m) => m.id));
        if (d.hasMore === true && !d.messages.some((m) => held.has(m.id))) {
          setMessages(d.messages);
          setHasMore(true);
          return;
        }
        setMessages((prev) => mergeMessages(prev, d.messages));
      })
      .catch(() => {});
  }, [status]);
  useEffect(() => {
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [refresh]);

  return { messages, hasMore, status, loadingEarlier, earlierError, load, loadEarlier, add };
}

// Marks the thread read through the newest Waves message the page showed: once
// per message, never while the page is hidden, and again when it comes back.
// One mark at a time; a newer answer that came while one was out is marked when
// it finishes, and a failed mark tries again on the next refresh tick.
function useMarkRead(messages, ready, onUnread) {
  const markedRef = useRef(null);
  const wantedRef = useRef(null);
  const inFlight = useRef(false);
  const liveRef = useRef(true);
  const onUnreadRef = useRef(onUnread);
  onUnreadRef.current = onUnread;
  const throughId = ready ? newestWavesId(messages) : null;
  wantedRef.current = throughId;

  const mark = useCallback(() => {
    const want = wantedRef.current;
    if (want == null || !isVisible() || inFlight.current || markedRef.current === want) return;
    inFlight.current = true;
    let marked = false;
    api.markPortalMessagesRead(want)
      .then((res) => {
        marked = true;
        markedRef.current = want;
        // Reported even when the page closed meanwhile: the badges live in the page shell, which drops a
        // result from another session.
        if (Number.isFinite(res?.unread)) onUnreadRef.current?.(res.unread);
      })
      .catch(() => {})
      .finally(() => {
        inFlight.current = false;
        if (marked && liveRef.current) mark();
      });
  }, []);

  useEffect(() => { mark(); }, [throughId, mark]);
  useEffect(() => {
    liveRef.current = true;
    const timer = setInterval(mark, REFRESH_MS);
    document.addEventListener('visibilitychange', mark);
    return () => { liveRef.current = false; clearInterval(timer); document.removeEventListener('visibilitychange', mark); };
  }, [mark]);
}

// The draft and its send. A requestId belongs to the exact text it was made
// for: a failed send keeps both, so Try again with the same text can never save
// the message twice, and changed text gets a new id (the first try may have been
// saved). The draft is read-only while it sends, so nothing typed then is lost.
function useComposer(onSent) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef(null);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    if (requestRef.current?.text !== text) requestRef.current = { id: makeRequestId(), text };
    setSending(true);
    setError('');
    try {
      const res = await api.sendPortalMessage(text, requestRef.current.id);
      if (res?.message) onSent(res.message);
      setDraft('');
      requestRef.current = null;
    } catch (err) {
      setError(sendErrorText(err));
    } finally {
      setSending(false);
    }
  };
  return { draft, setDraft, sending, error, send };
}

// Whether the server offers Messages, and the unread count for the badges.
// `ask` false (a cancelled account, a contact session, no customer yet) never
// probes. status: 'unknown' (probing) | 'on' (200) | 'off' (404). Any other
// first failure leaves the tab hidden; a later probe tries again. The caller
// runs probe(activeTab) when the tab changes, and the hook repeats it every
// minute while the page is visible. On the Messages tab the page reports the
// count itself (onUnread), so a probe answer cannot put back a cleared count.
const GATE_START = { status: 'unknown', unread: 0 };

export function usePortalMessagesGate(ask, sessionKey) {
  const [gate, setGate] = useState(GATE_START);
  const tabRef = useRef(null);
  const statusRef = useRef('unknown');
  statusRef.current = gate.status;
  const genRef = useRef(0);
  // Bumped by every probe and by every read the page reports: a probe answer
  // keeps its count only when nothing newer came after it asked.
  const seqRef = useRef(0);
  const sessionRef = useRef(sessionKey);
  sessionRef.current = sessionKey;

  const probe = useCallback((tab) => {
    if (tab !== undefined) tabRef.current = tab;
    if (!ask || statusRef.current === 'off' || !isVisible()) return;
    const gen = genRef.current;
    const seq = ++seqRef.current;
    Promise.resolve().then(() => api.getPortalMessagesUnread())
      .then((res) => {
        if (gen !== genRef.current) return;
        const fresh = seq === seqRef.current && tabRef.current !== 'messages';
        const count = Number.isFinite(res?.count) ? res.count : 0;
        setGate((prev) => ({ status: 'on', unread: fresh ? count : prev.unread }));
      })
      .catch((err) => {
        // A hiccup after Messages was on keeps it on; a first failure keeps it hidden.
        if (gen === genRef.current && err?.status === 404) setGate({ status: 'off', unread: 0 });
      });
  }, [ask]);

  useEffect(() => {
    genRef.current += 1;
    statusRef.current = 'unknown';
    setGate(GATE_START);
    if (!ask) return undefined;
    const timer = setInterval(() => probe(), REFRESH_MS);
    return () => { genRef.current += 1; clearInterval(timer); };
  }, [ask, sessionKey, probe]);

  // Bound to its session: a read result that lands after a session change is dropped.
  const setUnread = useCallback((n) => {
    if (sessionKey !== sessionRef.current) return;
    seqRef.current += 1;
    setGate((prev) => ({ ...prev, unread: n }));
  }, [sessionKey]);
  return { enabled: gate.status === 'on', off: gate.status === 'off', unread: gate.unread, setUnread, probe };
}

const card = {
  background: B.white,
  borderRadius: 8,
  padding: 16,
  border: `1px solid ${SHELL.border}`,
  boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
};

const secondaryButton = {
  minHeight: 44,
  padding: '8px 14px',
  borderRadius: 10,
  border: `1px solid ${SHELL.borderStrong}`,
  background: SHELL.surface,
  color: SHELL.text,
  fontFamily: FONTS.body,
  fontSize: 14,
  fontWeight: 700,
  cursor: 'pointer',
};

const primaryButton = {
  ...secondaryButton,
  minHeight: 48,
  padding: '10px 20px',
  border: 'none',
  background: B.glassNavy,
  color: '#fff',
  fontSize: 16,
};

const stamp = (value) => formatETDateTime(value, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function MessageBubble({ message }) {
  const mine = message.from === 'you';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start' }}>
      <div style={{ fontSize: 14, color: SHELL.muted, marginBottom: 4 }}>
        <span style={{ fontWeight: 700, color: SHELL.text }}>{mine ? 'You' : 'Waves Pest Control'}</span>
        {' · '}
        <time dateTime={message.createdAt}>{stamp(message.createdAt)}</time>
      </div>
      <div style={{
        maxWidth: '88%',
        padding: '10px 14px',
        borderRadius: 12,
        fontSize: 16,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
        background: mine ? B.glassNavy : SHELL.soft,
        color: mine ? '#fff' : SHELL.body,
        border: mine ? 'none' : `1px solid ${SHELL.softBorder}`,
      }}>{message.body}</div>
    </div>
  );
}

function Composer({ composer, composerRef }) {
  const { draft, setDraft, sending, error, send } = composer;
  const remaining = MAX_MESSAGE_LENGTH - draft.length;
  return (
    <form
      ref={composerRef}
      onSubmit={(e) => { e.preventDefault(); send(); }}
      style={{ marginTop: 16, display: 'grid', gap: 8 }}
    >
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        readOnly={sending}
        maxLength={MAX_MESSAGE_LENGTH}
        rows={3}
        placeholder={MESSAGES_COPY.placeholder}
        aria-label={MESSAGES_COPY.placeholder}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          minHeight: 96,
          padding: '10px 12px',
          borderRadius: 10,
          border: `1px solid ${SHELL.borderStrong}`,
          background: '#fff',
          color: SHELL.text,
          fontFamily: FONTS.body,
          // 16px floor: smaller makes iOS zoom the page on focus.
          fontSize: 16,
          lineHeight: 1.5,
          resize: 'vertical',
        }}
      />
      {draft.length >= COUNTER_FROM && (
        <div style={{ fontSize: 14, color: remaining <= 0 ? B.red : SHELL.muted, textAlign: 'right' }}>
          {draft.length} / {MAX_MESSAGE_LENGTH}
        </div>
      )}
      {error && (
        <div role="alert" style={{ fontSize: 14, color: B.red, fontWeight: 700 }}>{error}</div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button
          data-glass-accent=""
          data-glass-size="primary"
          type="submit"
          disabled={sending || !draft.trim()}
          style={{ ...primaryButton, opacity: sending || !draft.trim() ? 0.6 : 1, cursor: sending || !draft.trim() ? 'default' : 'pointer' }}
        >{sending ? 'Sending…' : 'Send'}</button>
        <div style={{ fontSize: 14, color: SHELL.muted, flex: '1 1 220px' }}>{MESSAGES_COPY.help}</div>
      </div>
    </form>
  );
}

function Thread({ thread }) {
  const { messages, hasMore, loadingEarlier, earlierError, loadEarlier } = thread;
  return (
    <div>
      {hasMore && (
        <div style={{ textAlign: 'center', marginBottom: 12 }}>
          <button data-glass-accent="" type="button" onClick={loadEarlier} disabled={loadingEarlier} style={secondaryButton}>
            {loadingEarlier ? 'Loading…' : 'Show earlier messages'}
          </button>
          {earlierError && (
            <div role="alert" style={{ marginTop: 6, fontSize: 14, color: B.red }}>Earlier messages couldn&rsquo;t be loaded. Try again.</div>
          )}
        </div>
      )}
      {messages.length === 0 ? (
        <p style={{ margin: 0, fontSize: 16, lineHeight: 1.5, color: SHELL.body }}>{MESSAGES_COPY.empty}</p>
      ) : (
        <div role="log" aria-label="Message thread" style={{ display: 'grid', gap: 14 }}>
          {messages.map((m) => <MessageBubble key={m.id} message={m} />)}
        </div>
      )}
    </div>
  );
}

export default function PortalMessages({ onUnread } = {}) {
  const thread = useThread();
  const composerRef = useRef(null);
  const composer = useComposer((message) => {
    thread.add(message);
    // The new message lands above the composer; keep the composer in view.
    window.requestAnimationFrame?.(() => composerRef.current?.scrollIntoView?.({ block: 'nearest', behavior: scrollBehavior() }));
  });
  useMarkRead(thread.messages, thread.status === 'ready', onUnread);

  return (
    <section aria-label="Messages" data-glass="card" style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, marginBottom: 14 }}>
        <span style={{
          width: 38, height: 38, borderRadius: 8, background: SHELL.soft, color: B.glassNavy,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <Icon name="message" size={18} strokeWidth={2} />
        </span>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: B.glassNavy, lineHeight: 1.2 }}>{MESSAGES_COPY.title}</h1>
          <div style={{ fontSize: 14, color: SHELL.muted, marginTop: 4 }}>{MESSAGES_COPY.subtitle}</div>
        </div>
      </div>

      {thread.status === 'loading' && (
        <div role="status" style={{ fontSize: 16, color: SHELL.muted }}>Loading messages&hellip;</div>
      )}
      {thread.status === 'error' && (
        <div role="alert">
          <div style={{ fontSize: 16, fontWeight: 700, color: B.glassNavy }}>{MESSAGES_COPY.loadError}</div>
          <button data-glass-accent="" type="button" onClick={thread.load} style={{ ...secondaryButton, marginTop: 10 }}>Try again</button>
        </div>
      )}
      {thread.status === 'ready' && (
        <>
          <Thread thread={thread} />
          <Composer composer={composer} composerRef={composerRef} />
        </>
      )}
    </section>
  );
}
