// client/src/components/portal/PortalMessages.jsx
// The customer's "Messages" page: one thread between the customer and the Waves
// office, so a question asked in the app is answered in the app. Dark behind a
// server gate: PortalPage only lists the tab once GET /api/portal-messages/unread-count
// answers 200. Contract (server/routes/portal-messages):
//   GET  /portal-messages[?before=ISO]  { messages oldest->newest, hasMore, unread }
//   POST /portal-messages               { body, requestId } -> { message }
//        or multipart with up to MAX_PHOTOS `photos`; a message's photos come back as photos: [{ url }]
//   POST /portal-messages/read          { throughId } -> { unread }
// PortalChat is the same thread as the Waves Chat sheet (owner 2026-11-20): the
// thread scrolls and the message box stays pinned under it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../utils/api';
import { COLORS as B, FONTS } from '../../theme-brand';
import { CUSTOMER_SURFACE as SHELL } from '../../theme-customer';
import { etNowMinutes, formatETDateTime } from '../../lib/timezone';
import { scrollBehavior } from '../../lib/scrollMotion';
import { MMS_TOTAL_BUDGET_BYTES, fitImagesToBudget } from '../../utils/imageCompression';
import Icon from '../Icon';

export const MAX_MESSAGE_LENGTH = 2000;
// The counter only shows when the limit is close.
const COUNTER_FROM = 1800;
const REFRESH_MS = 60 * 1000;
// Photos on one message (the server's PHOTO_MAX), the types its sanitizer takes, and the size the batch is
// compressed to before it is sent: the admin texting composer's own budget and ladder.
export const MAX_PHOTOS = 3;
const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif';
const PHOTO_TYPE_RE = /^image\/(jpe?g|png|webp|heic|heif)$/i;

export const MESSAGES_COPY = {
  title: 'Messages',
  subtitle: 'Questions and answers between you and the Waves team.',
  empty: 'No messages yet. When our team answers a question you asked in the app, it shows up here. You can also write to us below.',
  loadError: 'Messages couldn’t be loaded.',
  placeholder: 'Write a message to the Waves team',
  help: 'We answer between 8 AM and 8 PM, usually within one business hour.',
  tooMany: 'Too many messages in a short time. Please wait a little, or call or text our office.',
  sendFailed: 'Your message didn’t send. Check your connection and try again.',
  addPhoto: 'Add a photo',
  photoType: 'Photos must be JPEG, PNG, WebP or HEIC images.',
  photoLimit: `You can send up to ${MAX_PHOTOS} photos in one message.`,
  photosTooLarge: 'Those photos are too large to send together. Remove one and try again.',
  chatTitle: 'Waves Chat',
  chatPlaceholder: 'Message Waves',
  chatOpen: 'Open until 8 PM',
  chatClosed: 'Closed. Back at 8 AM',
  chatIntro: 'Your message goes straight to the Waves team. We usually answer within one business hour, and the reply shows up right here.',
  chatReceived: 'We got your message',
  chatReceivedDetail: 'Our team answers between 8 AM and 8 PM. The reply will show up here after we open.',
};

// What a new chat offers to start from. A tap fills the message box; nothing is
// sent until the customer presses Send.
export const CHAT_STARTERS = [
  { label: 'Pest, lawn or plant problem', draft: 'I have a pest, lawn or plant problem: ' },
  { label: 'Schedule or move a visit', draft: 'I would like to schedule or move a visit: ' },
  { label: 'Question about my bill', draft: 'I have a question about my bill: ' },
  { label: 'Something else', draft: '' },
];

// The hours MESSAGES_COPY.help promises, on the Eastern clock.
const OPEN_FROM = 8 * 60;
const OPEN_UNTIL = 20 * 60;
export const chatOpenNow = () => {
  const minutes = etNowMinutes();
  return minutes >= OPEN_FROM && minutes < OPEN_UNTIL;
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
  // The server's own words for a message or photo it refused, or photos it could not save.
  if ([400, 413].includes(err?.status) && err.message) return err.message;
  if (err?.code === 'photo_storage' && err.message) return err.message;
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
  // The newest time any server page held (a message added on this screen does not count): a refresh page
  // joins the thread only when it reaches back to it.
  const fetchedNewestRef = useRef(null);
  const noteFetched = (list) => {
    for (const m of list) {
      const t = Date.parse(m.createdAt);
      if (Number.isFinite(t) && (fetchedNewestRef.current == null || t > fetchedNewestRef.current)) fetchedNewestRef.current = t;
    }
  };
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  // Bumped whenever the shown window is replaced (a load, or a refresh that does not reach back): an
  // earlier-page answer for the old window is dropped.
  const windowRef = useRef(0);

  const load = useCallback(() => {
    setStatus('loading');
    api.getPortalMessages()
      .then((d) => {
        if (!live.current) return;
        const list = Array.isArray(d?.messages) ? d.messages : [];
        noteFetched(list);
        windowRef.current += 1;
        setMessages(list);
        setHasMore(d?.hasMore === true);
        setStatus('ready');
      })
      .catch(() => { if (live.current) setStatus('error'); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const loadEarlier = useCallback(() => {
    const oldest = messagesRef.current[0];
    if (!oldest) return;
    const shown = windowRef.current;
    setLoadingEarlier(true);
    setEarlierError(false);
    api.getPortalMessages(oldest.createdAt)
      .then((d) => {
        if (!live.current || shown !== windowRef.current) return;
        setMessages((prev) => mergeMessages(prev, Array.isArray(d?.messages) ? d.messages : []));
        setHasMore(d?.hasMore === true);
      })
      .catch(() => { if (live.current && shown === windowRef.current) setEarlierError(true); })
      .finally(() => { if (live.current) setLoadingEarlier(false); });
  }, []);

  const add = useCallback((message) => setMessages((prev) => mergeMessages(prev, [message])), []);

  // A new answer from the office shows up without a reload. One refresh at a
  // time, so answers never cross. A failed refresh is silent: the thread on
  // screen is still right. A page that does not reach back to the newest message
  // an earlier page held (more came than one page holds: the page was hidden, or
  // refreshes failed) replaces the thread, and "Show earlier messages" reaches
  // the rest, so no gap is left that no button can fill.
  const refreshingRef = useRef(false);
  const refresh = useCallback(() => {
    if (!isVisible() || status !== 'ready' || refreshingRef.current) return;
    refreshingRef.current = true;
    api.getPortalMessages()
      .then((d) => {
        if (!live.current || !Array.isArray(d?.messages)) return;
        const oldest = Date.parse(d.messages[0]?.createdAt);
        const reaches = d.hasMore !== true || (fetchedNewestRef.current != null && Number.isFinite(oldest) && oldest <= fetchedNewestRef.current);
        noteFetched(d.messages);
        if (!reaches) {
          windowRef.current += 1;
          // A message sent here after the page was read is newer than all of it: it stays.
          const pageNewest = Date.parse(d.messages[d.messages.length - 1]?.createdAt);
          setMessages((prev) => mergeMessages(d.messages, prev.filter((m) => Date.parse(m.createdAt) > pageNewest)));
          setHasMore(true);
          return;
        }
        setMessages((prev) => mergeMessages(prev, d.messages));
      })
      .catch(() => {})
      .finally(() => { refreshingRef.current = false; });
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

// The draft, its photos and its send. A requestId belongs to the exact text and photos it was made for: a
// failed send keeps both, so Try again with the same message can never save it twice, and a changed message
// gets a new id (the first try may have been saved). The draft is read-only while it sends, so nothing typed
// then is lost.
const photoKey = (file) => `${file.name}:${file.size}:${file.lastModified}`;

function useComposer(onSent, initialDraft = '') {
  const [draft, setDraft] = useState(initialDraft);
  const [photos, setPhotos] = useState([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef(null);

  const addPhotos = (fileList) => {
    const picked = Array.from(fileList || []);
    const images = picked.filter((file) => PHOTO_TYPE_RE.test(file.type || ''));
    const room = MAX_PHOTOS - photos.length;
    setPhotos((prev) => [...prev, ...images].slice(0, MAX_PHOTOS));
    setError(images.length < picked.length ? MESSAGES_COPY.photoType : (images.length > room ? MESSAGES_COPY.photoLimit : ''));
  };
  const removePhoto = (index) => setPhotos((prev) => prev.filter((_, i) => i !== index));

  const send = async () => {
    const text = draft.trim();
    if ((!text && !photos.length) || sending) return;
    const content = [text, ...photos.map(photoKey)].join('\n');
    if (requestRef.current?.content !== content) requestRef.current = { id: makeRequestId(), content };
    setSending(true);
    setError('');
    try {
      const fit = await fitImagesToBudget(photos, { availableBytes: MMS_TOTAL_BUDGET_BYTES });
      if (!fit.ok) { setError(MESSAGES_COPY.photosTooLarge); return; }
      const res = await api.sendPortalMessage(text, requestRef.current.id, fit.files);
      if (res?.message) onSent(res.message);
      setDraft('');
      setPhotos([]);
      requestRef.current = null;
    } catch (err) {
      setError(sendErrorText(err));
    } finally {
      setSending(false);
    }
  };
  const idle = sending || (!draft.trim() && !photos.length);
  return { draft, setDraft, photos, addPhotos, removePhoto, sending, idle, error, send };
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
  const photos = Array.isArray(message.photos) ? message.photos : [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start' }}>
      <div style={{ fontSize: 14, color: SHELL.muted, marginBottom: 4 }}>
        <span style={{ fontWeight: 700, color: SHELL.text }}>{mine ? 'You' : (message.ai ? 'Waves AI' : 'Waves')}</span>
        {' · '}
        <time dateTime={message.createdAt}>{stamp(message.createdAt)}</time>
      </div>
      {photos.length > 0 && (
        <div style={{ display: 'grid', gap: 6, justifyItems: mine ? 'end' : 'start', marginBottom: message.body ? 6 : 0 }}>
          {photos.map((photo, i) => (
            <img
              key={photo.url}
              src={photo.url}
              alt={`Photo ${i + 1} ${mine ? 'you sent' : 'from Waves'}`}
              loading="lazy"
              style={{ display: 'block', maxWidth: 'min(240px, 100%)', maxHeight: 320, objectFit: 'cover', borderRadius: 12, border: `1px solid ${SHELL.softBorder}` }}
            />
          ))}
        </div>
      )}
      {message.body && <div style={{
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
      }}>{message.body}</div>}
    </div>
  );
}

// The photos picked for the next message, each with a Remove button.
function PhotoTray({ composer }) {
  const { photos, removePhoto, sending } = composer;
  const urls = useMemo(() => photos.map((file) => (typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : '')), [photos]);
  useEffect(() => () => urls.forEach((url) => { if (url) URL.revokeObjectURL(url); }), [urls]);
  if (!photos.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
      {photos.map((file, i) => (
        <div key={`${photoKey(file)}:${i}`} style={{ position: 'relative', width: 72, height: 72 }}>
          <img src={urls[i]} alt={`Photo ${i + 1} to send`} style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: `1px solid ${SHELL.borderStrong}`, display: 'block' }} />
          <button
            type="button"
            onClick={() => removePhoto(i)}
            disabled={sending}
            aria-label={`Remove photo ${i + 1}`}
            style={{
              position: 'absolute', top: -10, right: -10, width: 44, height: 44, padding: 0, border: 'none', borderRadius: 999,
              background: 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            }}
          >
            <span style={{
              width: 24, height: 24, borderRadius: 999, background: B.glassNavy, color: '#fff',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Icon name="x" size={14} strokeWidth={2.5} />
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}

// The camera button: opens the phone's photo picker (camera or library).
function PhotoButton({ composer }) {
  const inputRef = useRef(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={PHOTO_ACCEPT}
        multiple
        hidden
        data-portal-photo-input=""
        onChange={(e) => { composer.addPhotos(e.target.files); e.target.value = ''; }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={composer.sending || composer.photos.length >= MAX_PHOTOS}
        aria-label={MESSAGES_COPY.addPhoto}
        style={{
          width: 44, height: 44, flexShrink: 0, borderRadius: 999, padding: 0,
          border: `1px solid ${SHELL.softBorder}`, background: '#fff', color: B.glassNavy,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          opacity: composer.photos.length >= MAX_PHOTOS ? 0.5 : 1,
        }}
      >
        <Icon name="camera" size={20} strokeWidth={2} />
      </button>
    </>
  );
}

function Composer({ composer, composerRef }) {
  const { draft, setDraft, sending, idle, error, send } = composer;
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
      <PhotoTray composer={composer} />
      {error && (
        <div role="alert" style={{ fontSize: 14, color: B.red, fontWeight: 700 }}>{error}</div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <PhotoButton composer={composer} />
        <button
          data-glass-accent=""
          data-glass-size="primary"
          type="submit"
          disabled={idle}
          style={{ ...primaryButton, opacity: idle ? 0.6 : 1, cursor: idle ? 'default' : 'pointer' }}
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

// The message box of the Waves Chat sheet: one growing line and a round Send.
function ChatComposer({ composer, inputRef }) {
  const { draft, setDraft, sending, idle, error, send } = composer;
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [draft, inputRef]);
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); send(); }}
      style={{
        flexShrink: 0,
        padding: '10px calc(12px + env(safe-area-inset-right, 0px)) calc(12px + env(safe-area-inset-bottom, 0px)) calc(12px + env(safe-area-inset-left, 0px))',
        borderTop: `1px solid ${SHELL.softBorder}`,
        background: '#fff',
        display: 'grid',
        gap: 6,
      }}
    >
      {draft.length >= COUNTER_FROM && (
        <div style={{ fontSize: 14, color: draft.length >= MAX_MESSAGE_LENGTH ? B.red : SHELL.muted, textAlign: 'right' }}>
          {draft.length} / {MAX_MESSAGE_LENGTH}
        </div>
      )}
      {error && (
        <div role="alert" style={{ fontSize: 14, color: B.red, fontWeight: 700 }}>{error}</div>
      )}
      <PhotoTray composer={composer} />
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        <PhotoButton composer={composer} />
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          readOnly={sending}
          maxLength={MAX_MESSAGE_LENGTH}
          rows={1}
          placeholder={MESSAGES_COPY.chatPlaceholder}
          aria-label={MESSAGES_COPY.chatPlaceholder}
          style={{
            flex: 1,
            minWidth: 0,
            boxSizing: 'border-box',
            minHeight: 44,
            padding: '9px 14px',
            borderRadius: 10,
            border: `1px solid ${SHELL.borderStrong}`,
            background: SHELL.soft,
            color: SHELL.text,
            fontFamily: FONTS.body,
            // 16px floor: smaller makes iOS zoom the page on focus.
            fontSize: 16,
            lineHeight: 1.5,
            resize: 'none',
          }}
        />
        <button
          data-glass-accent=""
          type="submit"
          disabled={idle}
          aria-label={sending ? 'Sending message' : 'Send message'}
          style={{
            width: 44, height: 44, flexShrink: 0, borderRadius: 999, border: 'none', padding: 0,
            background: B.yellow, color: B.glassNavy,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            opacity: idle ? 0.5 : 1, cursor: idle ? 'default' : 'pointer',
          }}
        >
          <Icon name="arrowUp" size={20} strokeWidth={2.5} />
        </button>
      </div>
    </form>
  );
}

// The Waves Chat sheet's content: header, the thread, and the message box.
// PortalPage owns the sheet around it and passes its close button.
export function PortalChat({ onUnread, firstName = '', initialDraft = '', closeButton = null } = {}) {
  const thread = useThread();
  const inputRef = useRef(null);
  const logRef = useRef(null);
  const composer = useComposer(thread.add, initialDraft);
  useMarkRead(thread.messages, thread.status === 'ready', onUnread);
  // Re-read the clock each minute so the header turns over at 8 AM and 8 PM.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const open = chatOpenNow();

  const { messages } = thread;
  const newest = messages[messages.length - 1] || null;
  // A new message (theirs or ours) shows at the bottom; earlier pages do not move the view.
  // A photo that loads after that grows the thread: stay at the bottom unless the customer has scrolled up.
  const atBottomRef = useRef(true);
  const toBottom = useCallback(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(() => { atBottomRef.current = true; toBottom(); }, [newest?.id, thread.status, toBottom]);

  const start = (text) => {
    if (text) composer.setDraft(text);
    inputRef.current?.focus();
  };
  const fresh = thread.status === 'ready' && messages.length === 0;
  const gutter = 'calc(16px + env(safe-area-inset-right, 0px)) 16px calc(16px + env(safe-area-inset-left, 0px))';

  return (
    <>
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12,
        padding: `12px calc(12px + env(safe-area-inset-right, 0px)) 12px calc(16px + env(safe-area-inset-left, 0px))`,
        borderBottom: `1px solid ${SHELL.softBorder}`,
      }}>
        <span style={{
          width: 40, height: 40, borderRadius: 8, background: SHELL.soft, color: B.glassNavy,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <Icon name="message" size={19} strokeWidth={2} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 26, fontWeight: 700, color: B.glassNavy, lineHeight: 1.15 }}>{MESSAGES_COPY.chatTitle}</h2>
          <div style={{ fontSize: 14, color: SHELL.muted, marginTop: 2 }}>{open ? MESSAGES_COPY.chatOpen : MESSAGES_COPY.chatClosed}</div>
        </div>
        {closeButton}
      </div>

      <div
        ref={logRef}
        onScroll={(e) => { const el = e.currentTarget; atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}
        onLoadCapture={() => { if (atBottomRef.current) toBottom(); }}
        style={{
        flex: '1 1 0', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch',
        padding: `16px ${gutter}`, display: 'flex', flexDirection: 'column',
      }}>
        {thread.status === 'loading' && (
          <div role="status" style={{ fontSize: 16, color: SHELL.muted }}>Loading messages&hellip;</div>
        )}
        {thread.status === 'error' && (
          <div role="alert">
            <div style={{ fontSize: 16, fontWeight: 700, color: B.glassNavy }}>{MESSAGES_COPY.loadError}</div>
            <button data-glass-accent="" type="button" onClick={thread.load} style={{ ...secondaryButton, marginTop: 10 }}>Try again</button>
          </div>
        )}
        {fresh && (
          <div style={{ marginTop: 'auto', display: 'grid', gap: 16 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: B.glassNavy, lineHeight: 1.2 }}>
                {firstName ? `Hi ${firstName}, what can we help with?` : 'What can we help with?'}
              </h3>
              <p style={{ margin: '8px 0 0', fontSize: 16, lineHeight: 1.5, color: SHELL.body }}>{MESSAGES_COPY.chatIntro}</p>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {CHAT_STARTERS.map((s) => (
                <button key={s.label} type="button" onClick={() => start(s.draft)} style={{ ...secondaryButton, borderRadius: 999, padding: '8px 16px', borderColor: SHELL.softBorder }}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {thread.status === 'ready' && !fresh && (
          <div style={{ marginTop: 'auto', display: 'grid', gap: 14 }}>
            <Thread thread={thread} />
            {!open && newest?.from === 'you' && (
              <div role="status" style={{
                display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', borderRadius: 12,
                background: '#fff', border: `1px solid ${SHELL.softBorder}`,
              }}>
                <Icon name="clock" size={20} strokeWidth={2} style={{ color: B.glassNavy, flexShrink: 0, marginTop: 2 }} />
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: B.glassNavy }}>{MESSAGES_COPY.chatReceived}</div>
                  <div style={{ fontSize: 14, lineHeight: 1.5, color: SHELL.body, marginTop: 2 }}>{MESSAGES_COPY.chatReceivedDetail}</div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {thread.status === 'ready' && <ChatComposer composer={composer} inputRef={inputRef} />}
    </>
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
