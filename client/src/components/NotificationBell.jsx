import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import useLockBodyScroll from '../hooks/useLockBodyScroll';
import useModalFocus from '../hooks/useModalFocus';
import { useBiometricLock } from './BiometricGate';
import { ensurePushSubscription, isPushEnabled, syncPushSubscription } from '../lib/push-subscribe.js';
import { isNativeApp, nativePushConnectionState, requestNativePushPermission } from '../native/nativePush.js';
import api, { sameRequestSession, tokenSessionIdentity } from '../utils/api';
import { captureNativeBadgeUpdate } from '../native/nativeBadge';
import { UNREAD_CHANGED_EVENT } from '../hooks/useUnreadConversations';
import { CUSTOMER_SURFACE } from '../theme-customer';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const PUSH_RECEIVED_MESSAGE = 'waves:push-received';

// Local, unverified role hint from the staff JWT — gates nothing
// security-sensitive (same pattern as push-subscribe.js): the server
// already scopes counts and push badge fields to admin-role users; this
// only keeps a technician's portal session from painting a badge onto
// their home-screen icon, matching the push side's admin-only scope.
function staffRoleFromToken() {
  try {
    const raw = localStorage.getItem('waves_admin_token');
    if (!raw) return null;
    const payload = JSON.parse(atob(raw.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.role || null;
  } catch {
    return null;
  }
}

// Mirror a server-confirmed unread count onto the home-screen app icon
// (Badging API — iOS 16.4+ installed PWAs; no-op elsewhere). Only called
// with counts the server returned or accepted a read-write for, so an
// offline session never wipes a real badge. Also advances the service
// worker's badge-ordering state under the same Web Lock (sw.js
// applyAppBadge): a push issued before this count but delivered after —
// the delayed-push case — must not resurrect a number the admin already
// cleared by reading. `at` is the SERVER-clock stamp the response carried
// (unread-count/read/read-all all return one) — the same clock domain as
// the push payload's badgeAt, so device clock skew can never invert the
// ordering; without a stamp the seq write is skipped and ordering
// advances on the next stamped call. Never rejects; fire-and-forget.
async function syncAppBadge(count, at) {
  if (typeof navigator === 'undefined' || !('setAppBadge' in navigator)) return;
  const apply = async () => {
    try {
      if (Number.isFinite(at) && typeof caches !== 'undefined') {
        const cache = await caches.open('waves-badge-state');
        const prevRes = await cache.match('/__badge-seq');
        let prev = { seq: 0, count: -1 };
        if (prevRes) { try { prev = await prevRes.json(); } catch { /* corrupt → treat as empty */ } }
        if (prev.seq > at) return;
        if (prev.seq === at && prev.count >= count) return;
        await cache.put('/__badge-seq', new Response(JSON.stringify({ seq: at, count })));
      }
    } catch { /* ordering state is best-effort */ }
    try {
      if (count > 0) await navigator.setAppBadge(count);
      else await navigator.clearAppBadge();
    } catch { /* platform without a visible badge surface */ }
  };
  try {
    if (navigator.locks?.request) await navigator.locks.request('waves-badge', apply);
    else await apply();
  } catch { /* badge sync must never surface to the bell */ }
}

// ops_digest legacy prefix (pre admin-alerts-brevity scope, 2026-09-28): a
// row written before that scope still carries ACT:/FIX:/FIRST:/FYI:/OK:/
// [Review] on its title. A new row never does — the same grammar rides in
// metadata.kind instead (digestKindChip below), so this is display-only
// cleanup for old rows, never something a new row needs stripped.
const LEGACY_DIGEST_PREFIX = /^(ACT:|FIX:|FIRST:|FYI:|OK:|\[Review\])\s*/i;
function displayTitle(n) {
  return n && n.category === 'ops_digest' && n.title ? n.title.replace(LEGACY_DIGEST_PREFIX, '') : (n && n.title) || '';
}

function parsedMetadata(n) {
  if (!n) return null;
  if (n.metadata && typeof n.metadata === 'object') return n.metadata;
  if (typeof n.metadata === 'string') {
    try { return JSON.parse(n.metadata); } catch { return null; }
  }
  return null;
}

// Small chip for an ops_digest row's action grammar — 'Needs you' for
// ACT/REVIEW, 'Broken' for FIX. No chip for FYI or a non-digest row (the
// title carried the same grammar as a prefix before this scope; the chip
// replaces that, so a legacy row with no metadata.kind gets no chip either
// — it still reads fine once the prefix strip above runs).
function digestKindChip(n) {
  if (!n || n.category !== 'ops_digest') return null;
  const kind = parsedMetadata(n)?.kind;
  if (kind === 'ACT' || kind === 'REVIEW') return { label: 'Needs you' };
  if (kind === 'FIX') return { label: 'Broken' };
  return null;
}

// An ops_digest row whose link is the shared Activity feed gets `&focus=<id>`
// appended on click, so AgentActivityTab can expand and scroll straight to
// this row's item instead of landing on the top of a long feed.
const ACTIVITY_FEED_LINK_RE = /^\/admin\/agents\?tab=activity\b/;
function linkFor(n) {
  const link = n && n.link;
  if (!link) return link;
  if (n.category === 'ops_digest' && ACTIVITY_FEED_LINK_RE.test(link)) {
    return `${link}${link.includes('?') ? '&' : '?'}focus=${encodeURIComponent(n.id)}`;
  }
  return link;
}

// An ops_digest row's full report lives only in the Agents → Activity feed
// (`detail`). When the row's own tap goes somewhere else — a mapped work page
// like /admin/communications, or nowhere — a secondary "Full report" link
// keeps it one tap away; `focus=` loads that row whatever its age or read
// state (codex r3 P0 on #5236). Null when the row's tap already opens it.
function reportLinkFor(n) {
  if (!n || n.category !== 'ops_digest' || !n.id) return null;
  if (n.link && ACTIVITY_FEED_LINK_RE.test(n.link)) return null;
  return `/admin/agents?tab=activity&focus=${encodeURIComponent(n.id)}`;
}

// An admin row's body is cut to one sentence (notification-service's brevity
// guard) and the full original text is stored in `detail`. Every admin row
// but an ops_digest one (its full report is the Activity feed's "Full report"
// link above) reads that text back inline from the bell.
function fullTextFor(n, type) {
  if (type !== 'admin' || !n || n.category === 'ops_digest') return null;
  return typeof n.detail === 'string' && n.detail.trim() ? n.detail : null;
}

// "Show full text" / "Hide full text": its own click and key handling, never
// the row's — the row still navigates to its link and marks itself read only
// on its own tap. `pre-wrap` keeps a list body's line breaks.
// A persisted admin row can be marked done (docs/admin-notifications.md
// section 4.3: read is not done). The `live:` dashboard overlay rows have no
// persisted id and customer bells have no done state, so neither offers it.
function canMarkDone(n, type) {
  return type === 'admin' && n?.id != null && !String(n.id).startsWith('live:');
}

// "Done": its own click and key handling, never the row's (the row would
// navigate to its link). `tall` gives the phone layout its 44px tap target.
function DoneButton({ onDone, color, tall }) {
  return (
    <button type="button" className="waves-focus-ring" onClick={onDone} onKeyDown={(e) => e.stopPropagation()}
      style={{
        padding: tall ? '0 12px' : '2px 8px', minHeight: tall ? 44 : undefined, minWidth: tall ? 44 : undefined,
        border: 0, background: 'none', cursor: 'pointer',
        fontSize: 14, fontWeight: 600, textDecoration: 'underline', color,
      }}>Done</button>
  );
}

function FullText({ text, color, marginTop }) {
  const [shown, setShown] = useState(false);
  return (
    <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <button type="button" aria-expanded={shown} onClick={() => setShown((v) => !v)}
        style={{
          marginTop, padding: 0, border: 0, background: 'none', cursor: 'pointer',
          fontSize: 14, fontWeight: 600, textDecoration: 'underline', color,
        }}>{shown ? 'Hide full text' : 'Show full text'}</button>
      {shown && (
        <div style={{ marginTop: 4, fontSize: 14, lineHeight: 1.4, color, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</div>
      )}
    </div>
  );
}

export default function NotificationBell({ type = 'admin', customerId }) {
  // type: 'admin' or 'customer'
  // For admin: polls /api/admin/notifications/unread-count
  // For customer: polls /api/notifications/unread-count

  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [page, setPage] = useState(1);
  // The server's keyset cursor for the next page: rows can leave the feed
  // between requests (Done, an auto-close), so paging never uses offsets.
  const [nextCursor, setNextCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [tab, setTab] = useState('account'); // 'account' | 'whats_new'
  // "Recently done" (admin role only): done rows from the last 7 days, so an
  // accidental Done can be reopened. doneError is 'load' | 'reopen' | null.
  const [doneOpen, setDoneOpen] = useState(false);
  const [doneRows, setDoneRows] = useState([]);
  const [doneLoading, setDoneLoading] = useState(false);
  const [doneError, setDoneError] = useState(null);
  // Web Push enable state — only relevant for admin bell. The strip
  // shows when the current device hasn't subscribed to push yet, and
  // hides itself once the user grants permission.
  const [pushOn, setPushOn] = useState(false);
  const [pushEnabling, setPushEnabling] = useState(false);
  const [pushError, setPushError] = useState(null);
  const biometricLocked = useBiometricLock();
  const pushPromptRequested = useRef(false);
  const bellRef = useRef(null);
  const panelRef = useRef(null);
  // The customer shell keeps its bottom navigation through 899px, including
  // 844px iPhone landscape. Match that breakpoint so the notification sheet
  // clears the nav; admin retains its existing 768px layout breakpoint.
  const isMobile = typeof window !== 'undefined' && window.innerWidth < (type === 'customer' ? 900 : 768);

  const tokenKey = type === 'admin' ? 'waves_admin_token' : 'waves_token';
  const basePath = type === 'admin' ? '/admin/notifications' : '/customer-notifications';
  const nativeCustomer = type === 'customer' && isNativeApp();

  const getHeaders = () => ({
    Authorization: `Bearer ${localStorage.getItem(tokenKey)}`,
    'Content-Type': 'application/json',
  });

  // Customer requests go through the shared api client: customer access
  // tokens expire after 15 minutes and only the client can rotate the
  // refresh session on a 401 (and it rejects on error responses, so a 401
  // body is never mistaken for an empty notification list). The admin bell
  // keeps its separate raw-fetch flow — admin auth is a different token.
  const requestJson = (path, options = {}) => {
    if (type !== 'admin') return api.request(path, options);
    return fetch(`${API_BASE}${path}`, { ...options, headers: getHeaders() })
      .then((r) => {
        if (!r.ok) {
          const err = new Error(`Request failed (${r.status})`);
          err.status = r.status;
          throw err;
        }
        return r.json();
      });
  };

  // Poll unread count every 30 seconds. Component-scoped so mark-read can
  // re-sync the icon badge from the AUTHORITATIVE count (see markRead).
  const countSeqRef = useRef(0);
  const countActiveRef = useRef(false);
  const fetchCount = () => {
    const seq = ++countSeqRef.current;
    const token = api.token;
    const updateNativeBadge = captureNativeBadgeUpdate();
    requestJson(`${basePath}/unread-count`)
      .then(d => {
        if (!countActiveRef.current || seq !== countSeqRef.current) return;
        if (type === 'customer' && api.token !== token
          && !sameRequestSession(tokenSessionIdentity(token), tokenSessionIdentity(api.token))) return;
        if (!Number.isSafeInteger(d.count) || d.count < 0) return;
        setUnreadCount(d.count || 0);
        if (type === 'admin' && staffRoleFromToken() === 'admin') syncAppBadge(d.count || 0, d.at);
        // Absent on older server versions: do nothing. An explicit false is
        // the live kill switch. Never turn a failed/invalid count into zero.
        if (nativeCustomer && typeof d.nativeBadgeEnabled === 'boolean'
          && Number.isSafeInteger(d.count) && d.count >= 0) {
          void updateNativeBadge(d.nativeBadgeEnabled ? d.count : 0);
        }
      })
      .catch(() => {});
  };

  useEffect(() => {
    countActiveRef.current = true;
    fetchCount();
    const iv = setInterval(fetchCount, 30000);
    const onVisible = () => { if (document.visibilityState === 'visible') fetchCount(); };
    const onPushReceived = (event) => {
      if (event.data?.type === PUSH_RECEIVED_MESSAGE && document.visibilityState === 'visible') fetchCount();
    };
    document.addEventListener('visibilitychange', onVisible);
    const serviceWorker = typeof navigator !== 'undefined' ? navigator.serviceWorker : null;
    serviceWorker?.addEventListener?.('message', onPushReceived);
    if (type === 'admin') window.addEventListener(UNREAD_CHANGED_EVENT, fetchCount);
    if (nativeCustomer) {
      window.addEventListener('waves:native-notification', fetchCount);
    }
    return () => {
      countActiveRef.current = false;
      ++countSeqRef.current;
      clearInterval(iv);
      if (type === 'admin') window.removeEventListener(UNREAD_CHANGED_EVENT, fetchCount);
      window.removeEventListener('waves:native-notification', fetchCount);
      document.removeEventListener('visibilitychange', onVisible);
      serviceWorker?.removeEventListener?.('message', onPushReceived);
    };
  }, [type, customerId, nativeCustomer]);

  // Close on click outside. The panel is portaled to document.body, so it
  // is NOT a DOM descendant of the bell wrapper — check both refs.
  useEffect(() => {
    const handler = (e) => {
      if (bellRef.current && bellRef.current.contains(e.target)) return;
      if (panelRef.current && panelRef.current.contains(e.target)) return;
      setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Preserve the page's scroll offset while the customer panel is open.
  // A bare body overflow lock turns body into a new iOS scroll container and
  // can make the sticky portal header disappear when opened mid-scroll.
  useLockBodyScroll(open && type !== 'admin', { preserveSticky: true });

  // Self-heal the push link on load and on PWA resume (admin only). iOS
  // Safari rotates/drops push endpoints, and the server deactivates a
  // subscription after a 404/410 send — previously nothing re-registered
  // the device until the user manually hit Enable again. The sync is a
  // no-op unless permission is already granted, so it never prompts.
  // Throttled because iOS fires visibilitychange on every app switch.
  useEffect(() => {
    if (type !== 'admin') return;
    let lastSyncAt = 0;
    const sync = () => {
      if (Date.now() - lastSyncAt < 60 * 60 * 1000) return;
      lastSyncAt = Date.now();
      syncPushSubscription({ apiBase: API_BASE, token: localStorage.getItem(tokenKey) })
        .then((r) => { if (r?.ok) setPushOn(true); })
        .catch(() => {});
    };
    sync();
    const onVisible = () => { if (document.visibilityState === 'visible') sync(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [type]);

  // Probe Web Push state when the panel opens (admin only). Re-runs on
  // each open so a user who enabled push elsewhere doesn't see a stale
  // "Enable push" strip. Admins get operational Web Push. In the native
  // customer app this strip supplies recovery if automatic permission setup
  // did not connect. Customer web stays strip-free.
  const showPushStrip = (type === 'admin' || isNativeApp()) && !pushOn;
  useEffect(() => {
    if (!open) return;
    if (type === 'admin') {
      isPushEnabled({
        apiBase: API_BASE,
        token: localStorage.getItem(tokenKey),
        verifyServer: true,
      }).then(setPushOn).catch(() => setPushOn(false));
      return;
    }
    if (isNativeApp()) {
      nativePushConnectionState()
        .then((state) => setPushOn(state === 'granted'))
        .catch(() => setPushOn(false));
    }
  }, [open, type]);

  const handleEnablePush = async () => {
    setPushEnabling(true);
    setPushError(null);
    try {
      if (type === 'customer' && isNativeApp()) {
        const result = await requestNativePushPermission();
        if (result !== 'granted') {
          const errors = {
            denied: 'Notifications are off. Enable them for Waves in your device Settings, then try again.',
            setup_unavailable: 'The Waves app did not respond to notification setup. Close and reopen the app, then try again.',
            permission_unavailable: 'Waves did not receive a notification permission response. Check Waves in your device’s notification Settings, then try again.',
          };
          throw new Error(errors[result] || 'This device could not connect for app notifications. Check your connection and try again.');
        }
        setPushOn(true);
        return;
      }
      // Pass apiBase so push enrollment hits the same backend the rest
      // of the bell talks to. Without this, ensurePushSubscription
      // defaults to '/api' and breaks in any deployment where the
      // frontend is configured to talk to a different API origin.
      await ensurePushSubscription({
        apiBase: API_BASE,
        token: localStorage.getItem(tokenKey),
      });
      setPushOn(true);
    } catch (err) {
      setPushError(err.message || 'Push setup failed');
    } finally {
      setPushEnabling(false);
    }
  };

  // This bell mounts inside the authenticated customer portal. Show Apple's
  // normal permission popup after Face ID unlock, without a preliminary tap.
  // The OS remembers the choice; this ref avoids overlapping attempts when
  // the system sheet causes lock/foreground changes during the same mount.
  useEffect(() => {
    if (type !== 'customer' || !isNativeApp() || biometricLocked || pushPromptRequested.current) return;
    let current = true;
    void api.getCustomerPushStatus().then((status) => {
      if (!current || status?.available !== true) return;
      pushPromptRequested.current = true;
      void handleEnablePush();
    }).catch(() => { /* Availability fails closed; the drawer keeps its retry action. */ });
    return () => { current = false; };
  }, [type, biometricLocked]);

  // Load notifications when opened. A failed load is recorded — rendering
  // "No notifications yet" (or stale rows) for an outage would present a
  // broken inbox as a confirmed-empty one. Monotonic sequence: reopening
  // while a request is in flight starts a new one, and only the latest
  // issued request may write — a slow older failure must not hide a newer
  // successful list behind the retry screen.
  const loadSeqRef = useRef(0);
  const loadNotifications = async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setLoadFailed(false);
    setLoadingMore(false);
    setMoreFailed(false);
    try {
      const d = await requestJson(`${basePath}?limit=30`);
      if (seq !== loadSeqRef.current) return;
      setNotifications(d.notifications || []);
      setPage(1);
      setNextCursor(d.next || null);
      setHasMore(type === 'admin' && d.hasMore === true);
    } catch {
      if (seq !== loadSeqRef.current) return;
      setLoadFailed(true);
    }
    setLoading(false);
  };

  const loadMore = async () => {
    const seq = ++loadSeqRef.current;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const d = await requestJson(`${basePath}?limit=30&page=${page + 1}${nextCursor ? `&before=${encodeURIComponent(nextCursor)}` : ''}`);
      if (seq !== loadSeqRef.current) return;
      // New alerts can shift offset pages between requests. Keep each row
      // once while preserving the read state already confirmed in this panel.
      setNotifications(current => {
        const ids = new Set(current.map(n => n.id));
        return [...current, ...(d.notifications || []).filter(n => !ids.has(n.id))];
      });
      setPage(page + 1);
      setNextCursor(d.next || null);
      setHasMore(d.hasMore === true);
    } catch {
      if (seq !== loadSeqRef.current) return;
      setMoreFailed(true);
    }
    setLoadingMore(false);
  };

  const handleOpen = () => {
    if (!open) { loadNotifications(); setDoneOpen(false); }
    setOpen(!open);
  };

  // Full dialog contract via the shared hook: move focus into the panel,
  // trap Tab/Shift+Tab inside it, close on Escape, and restore focus to the
  // bell on close (same as the other portal dialogs). Merge its ref with the
  // existing panelRef (used for outside-click detection) since only one of
  // the mobile/desktop panels renders at a time.
  const dialogFocusRef = useModalFocus(open, () => setOpen(false));
  const attachPanelRef = (node) => {
    panelRef.current = node;
    dialogFocusRef.current = node;
  };

  // The row's "Full report" link: its own click, never the row's (the row
  // would navigate to its mapped work page instead).
  const openReport = async (e, n, report) => {
    e.stopPropagation();
    e.preventDefault();
    if (!n.read_at) await markRead(n.id);
    setOpen(false);
    window.location.href = report;
  };

  const markRead = async (id) => {
    // Only reflect the read state the server actually accepted — a rejected
    // write (expired token the refresh couldn't save) must not clear badges.
    try {
      await requestJson(`${basePath}/${id}/read`, { method: 'PUT' });
    } catch { return; }
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read_at: new Date().toISOString() } : n));
    // Optimistic list counter only — the ICON badge is re-synced from the
    // authoritative count below: a push landing between polls isn't in
    // local state, and a stale local decrement carries a fresh ordering
    // stamp that would beat the correct badge (codex round 14).
    setUnreadCount(prev => Math.max(0, prev - 1));
    if (type === 'admin' || nativeCustomer) fetchCount();
  };

  // Done leaves the bell: the row is removed once the server accepts it, and
  // the badge is re-synced from the authoritative count (see markRead).
  const markDone = async (e, n) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await requestJson(`${basePath}/${n.id}/done`, { method: 'PUT' });
    } catch { return; }
    setNotifications(prev => prev.filter(x => x.id !== n.id));
    if (!n.read_at) setUnreadCount(prev => Math.max(0, prev - 1));
    fetchCount();
  };

  const doneSeqRef = useRef(0);
  const loadDone = async () => {
    const seq = ++doneSeqRef.current;
    setDoneLoading(true);
    setDoneError(null);
    try {
      const d = await requestJson(`${basePath}/done`);
      if (seq !== doneSeqRef.current) return;
      setDoneRows(d.notifications || []);
    } catch {
      if (seq !== doneSeqRef.current) return;
      setDoneError('load');
    }
    setDoneLoading(false);
  };

  const toggleDone = () => {
    const next = !doneOpen;
    setDoneOpen(next);
    if (next) loadDone();
  };

  // Reopen puts the row back in the bell: it leaves this list once the server
  // accepts it, then the main list and the badge are re-read.
  const reopenDone = async (n) => {
    setDoneError(null);
    try {
      await requestJson(`${basePath}/${n.id}/reopen`, { method: 'PUT' });
    } catch {
      setDoneError('reopen');
      return;
    }
    setDoneRows(prev => prev.filter(x => x.id !== n.id));
    loadNotifications();
    fetchCount();
  };

  const markAllRead = async () => {
    try {
      await requestJson(`${basePath}/read-all`, { method: 'PUT' });
    } catch { return; }
    setNotifications(prev => prev.map(n => ({ ...n, read_at: n.read_at || new Date().toISOString() })));
    setUnreadCount(0);
    // Icon badge: refetch the authoritative post-mutation count — read-all
    // can fail soft on live-alert dismissal while still returning success,
    // and clearing the icon with a fresh stamp would beat the delayed push
    // for those alerts (codex round 15). Same pattern as markRead.
    if (type === 'admin' || nativeCustomer) fetchCount();
  };

  // Group by time: Today, Yesterday, This Week, Older
  const groupByTime = (notifs) => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const weekAgo = new Date(today.getTime() - 6 * 86400000);

    const groups = { 'Today': [], 'Yesterday': [], 'This Week': [], 'Older': [] };
    for (const n of notifs) {
      const d = new Date(n.created_at);
      if (d >= today) groups['Today'].push(n);
      else if (d >= yesterday) groups['Yesterday'].push(n);
      else if (d >= weekAgo) groups['This Week'].push(n);
      else groups['Older'].push(n);
    }
    return Object.entries(groups).filter(([, items]) => items.length > 0);
  };

  const timeAgo = (dateStr) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  };

  // Colors — detect theme from type
  const isDark = type === 'admin';
  const colors = isDark
    ? { bg: '#FFFFFF', border: '#E2E8F0', text: '#334155', muted: '#64748B', teal: '#0A7EC2', unreadBg: '#F0F7FC', white: '#0F172A', badge: '#C0392B' }
    // Customer palette = glass tokens (#04395E ink, #0A7EC2 accent) — the
    // old marketing navy/#009CDE rendered inside the glassed portal panel.
    : { bg: CUSTOMER_SURFACE.surface, border: CUSTOMER_SURFACE.border, text: CUSTOMER_SURFACE.text, muted: CUSTOMER_SURFACE.muted, teal: '#0A7EC2', unreadBg: 'rgba(10,126,194,0.10)', white: '#FFFFFF', badge: '#C8102E' };

  const moreControl = type === 'admin' && !loading && !loadFailed && hasMore && (
    <div style={{ padding: '16px 20px', textAlign: 'center' }}>
      {moreFailed && <div role="alert" style={{ marginBottom: 8, fontSize: 14, color: colors.text }}>Older notifications couldn&apos;t be loaded.</div>}
      <button type="button" onClick={loadMore} disabled={loadingMore} style={{
        padding: '8px 14px', minHeight: 44, borderRadius: 8,
        border: `1px solid ${colors.border}`, background: '#FFFFFF',
        color: colors.text, fontSize: 14, fontWeight: 500, cursor: loadingMore ? 'wait' : 'pointer',
      }}>{loadingMore ? 'Loading…' : moreFailed ? 'Try again' : 'Load more'}</button>
    </div>
  );

  // Admin ROLE only (AdminLayoutV2 mounts this bell for technicians too, still
  // as type 'admin'): the per-event bell/push toggles live on Settings →
  // Notifications, a tab CommunicationsPageV2 hides from non-admins, and it
  // reads the hash as #tab=<name>.
  const settingsLink = type === 'admin' && staffRoleFromToken() === 'admin' && (
    <div style={{ padding: '12px 20px 16px', textAlign: 'center' }}>
      <a href="/admin/communications#tab=notifications" style={{ color: colors.teal, fontSize: 14, fontWeight: 500, textDecoration: 'none' }}>
        Notification settings →
      </a>
    </div>
  );

  // Reopen is admin-only on the server, so the list is offered to the admin
  // role only (the local role hint gates nothing — the server enforces it).
  const doneControl = type === 'admin' && staffRoleFromToken() === 'admin' && (
    <div style={{ padding: '4px 20px 8px', textAlign: 'center' }}>
      <button type="button" className="waves-focus-ring" onClick={toggleDone} aria-expanded={doneOpen} style={{
        padding: '0 12px', minHeight: 44, border: 0, background: 'none', cursor: 'pointer',
        color: colors.teal, fontSize: 14, fontWeight: 500,
      }}>{doneOpen ? 'Hide recently done' : 'Recently done'}</button>
      {doneOpen && (
        <div style={{ textAlign: 'left' }}>
          {doneLoading && <div style={{ padding: '8px 0', fontSize: 14, color: colors.muted }}>Loading…</div>}
          {doneError && (
            <div role="alert" style={{ padding: '8px 0', fontSize: 14, color: colors.text }}>
              {doneError === 'reopen' ? 'Couldn\u2019t reopen that alert. Try again.' : 'Couldn\u2019t load recently done alerts.'}
            </div>
          )}
          {!doneLoading && !doneError && doneRows.length === 0 && (
            <div style={{ padding: '8px 0', fontSize: 14, color: colors.muted }}>Nothing marked done in the last 7 days.</div>
          )}
          {doneRows.map(n => (
            <div key={n.id} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0',
              borderTop: `1px solid ${colors.border}`,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayTitle(n)}</div>
                <div style={{ fontSize: 12, color: colors.muted }}>
                  {n.resolution || 'Marked done'} · {timeAgo(n.done_at)}
                </div>
              </div>
              <button type="button" className="waves-focus-ring" onClick={() => reopenDone(n)} style={{
                padding: '0 12px', minHeight: 44, border: 0, background: 'none', cursor: 'pointer',
                fontSize: 14, fontWeight: 600, textDecoration: 'underline', color: colors.text,
              }}>Reopen</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div ref={bellRef} style={{ position: 'relative' }}>
      {/* Bell Button */}
      <button onClick={handleOpen} aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : 'Notifications'} aria-haspopup="dialog" aria-expanded={open} style={{
        background: 'none', border: 'none', cursor: 'pointer', position: 'relative',
        padding: 8, fontSize: 20, color: isDark ? '#64748B' : colors.text, minWidth: 44, minHeight: 44,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
        {unreadCount > 0 && (
          <span style={{
            position: 'absolute', top: 4, right: 2,
            background: colors.badge, color: '#fff', fontSize: 10,
            fontWeight: 700,
            minWidth: 18, height: 18, borderRadius: 9, display: 'flex',
            alignItems: 'center', justifyContent: 'center', padding: '0 4px',
          }}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Panel — IMG_3718 style on mobile (full-screen, pill tabs, blue-dot rows); dropdown on desktop.
          Portaled to <body>: the customer portal header is a glass surface
          (backdrop-filter), which makes it the containing block for fixed
          descendants — rendered in place, the panel would collapse to the
          header's box instead of covering the viewport. */}
      {open && createPortal(
        isMobile ? (
          // Customer: floating glass sheet (data-glass="modal" picks up the
          // liquid-glass material from glass-theme.css — same idiom as the
          // account menu). Inset so the rounded sheet floats over the scene
          // and clears the notch + bottom tab bar. Admin: unchanged white
          // full-screen panel (no glass theme mounted on /admin).
          <div ref={attachPanelRef} role="dialog" aria-modal="true" aria-label="Notifications" data-glass={isDark ? undefined : 'modal'} style={{
            position: 'fixed',
            // 52px matches AdminLayoutV2's mobile top bar (calc(52px + safe-area));
            // 56 left a 4px strip of page showing between header and panel.
            top: isDark ? 'calc(52px + env(safe-area-inset-top, 0px))' : 'calc(env(safe-area-inset-top, 0px) + 8px)',
            left: isDark ? 0 : 'calc(10px + env(safe-area-inset-left, 0px))',
            right: isDark ? 0 : 'calc(10px + env(safe-area-inset-right, 0px))',
            bottom: isDark ? 'calc(56px + env(safe-area-inset-bottom, 0px))' : 'calc(var(--portal-bottom-nav-height, calc(70px + env(safe-area-inset-bottom, 0px))) + 8px)',
            background: '#FFFFFF', zIndex: 9999,
            borderRadius: isDark ? 0 : 24,
            border: isDark ? 'none' : '1px solid #E7E2D7',
            boxShadow: isDark ? 'none' : '0 18px 45px rgba(27,44,91,0.10)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            {/* Header: close + "Notifications" title + mark-all */}
            <div style={{ padding: '16px 20px 8px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ fontSize: 24, fontWeight: 700, color: isDark ? '#18181B' : CUSTOMER_SURFACE.text, letterSpacing: '-0.01em' }}>Notifications</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {unreadCount > 0 && (
                  <button onClick={markAllRead} style={{
                    background: 'none', border: 'none', color: isDark ? '#52525B' : CUSTOMER_SURFACE.text,
                    fontSize: isDark ? 13 : 14, fontWeight: 500, cursor: 'pointer', padding: isDark ? '4px 8px' : '0 8px',
                    minHeight: isDark ? undefined : 44,
                  }}>Mark all read</button>
                )}
                <button onClick={() => setOpen(false)} aria-label="Close" style={{
                  width: isDark ? 36 : 44, height: isDark ? 36 : 44, borderRadius: isDark ? 18 : 22, border: 'none',
                  background: isDark ? '#F4F4F5' : 'rgba(255,255,255,0.6)',
                  color: isDark ? '#18181B' : CUSTOMER_SURFACE.text, fontSize: 18, lineHeight: 1,
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>&#x2715;</button>
              </div>
            </div>

            {/* Pill tabs: Account / What's new */}
            <div style={{ padding: '8px 20px 16px', flexShrink: 0 }}>
              <div style={{
                display: 'flex', gap: 4,
                background: isDark ? '#F4F4F5' : 'rgba(27,44,91,0.07)',
                borderRadius: 999, padding: 4, width: 'fit-content',
              }}>
                {[
                  { key: 'account', label: 'Account' },
                  { key: 'whats_new', label: "What's new" },
                ].map(({ key, label }) => {
                  const active = tab === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setTab(key)}
                      style={{
                        padding: '8px 20px', borderRadius: 999, border: 'none',
                        background: active ? '#FFFFFF' : 'transparent',
                        color: isDark ? (active ? '#18181B' : '#71717A') : (active ? CUSTOMER_SURFACE.text : CUSTOMER_SURFACE.muted),
                        fontSize: 14, fontWeight: type === 'admin' ? 500 : 600, cursor: 'pointer',
                        boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                        minHeight: isDark ? undefined : 44,
                      }}
                    >{label}</button>
                  );
                })}
              </div>
            </div>

            {/* Enable Push strip — admin only, shown when not yet
                subscribed on this device. iOS reminder is folded into
                the error message that ensurePushSubscription throws. */}
            {showPushStrip && (
              <PushEnableStrip
                admin={type === 'admin'}
                enabling={pushEnabling}
                error={pushError}
                onClick={handleEnablePush}
              />
            )}

            {/* Notification list — overscroll containment keeps the sheet's
                scroll from chaining to the page behind it on iOS. */}
            <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}>
              {loading && <div style={{ padding: 40, textAlign: 'center', color: isDark ? '#71717A' : CUSTOMER_SURFACE.muted, fontSize: 14 }}>Loading…</div>}
              {!loading && loadFailed && tab === 'account' && (
                <div style={{ padding: 60, textAlign: 'center' }}>
                  <div style={{ fontSize: 14, color: isDark ? '#71717A' : CUSTOMER_SURFACE.muted }}>Notifications couldn&apos;t be loaded.</div>
                  <button type="button" onClick={loadNotifications} style={{
                    marginTop: 12, padding: '8px 14px', borderRadius: 8, border: '1px solid #D8D0C0',
                    background: '#fff', color: isDark ? '#04395E' : CUSTOMER_SURFACE.text, fontSize: 14,
                    fontWeight: 700, cursor: 'pointer',
                  }}>Try again</button>
                </div>
              )}
              {!loading && !loadFailed && tab === 'account' && notifications.length === 0 && (
                <div style={{ padding: 60, textAlign: 'center' }}>
                  <div style={{ fontSize: 14, color: isDark ? '#71717A' : CUSTOMER_SURFACE.muted }}>No notifications yet</div>
                </div>
              )}
              {!loading && tab === 'whats_new' && (
                <div style={{ padding: 60, textAlign: 'center' }}>
                  <div style={{ fontSize: 14, color: isDark ? '#71717A' : CUSTOMER_SURFACE.muted }}>Nothing new right now</div>
                </div>
              )}
              {!loading && !loadFailed && tab === 'account' && notifications.map(n => {
                const href = linkFor(n);
                const chip = digestKindChip(n);
                const report = reportLinkFor(n);
                const fullText = fullTextFor(n, type);
                return (
                <div key={n.id}
                  role={href ? 'link' : undefined}
                  tabIndex={href ? 0 : undefined}
                  className={href ? 'waves-focus-ring' : undefined}
                  onClick={async () => {
                    if (!n.read_at) await markRead(n.id);
                    if (href) { setOpen(false); window.location.href = href; }
                  }}
                  onKeyDown={href ? async (e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    if (!n.read_at) await markRead(n.id);
                    setOpen(false);
                    window.location.href = href;
                  } : undefined}
                  style={{
                    padding: '14px 20px', cursor: href ? 'pointer' : 'default',
                    borderBottom: `1px solid ${isDark ? '#F4F4F5' : 'rgba(27,44,91,0.08)'}`,
                    display: 'flex', gap: 12, alignItems: 'flex-start',
                  }}
                >
                  {/* Blue unread dot — reserves the same slot for read rows so text aligns */}
                  <div style={{ width: 8, flexShrink: 0, paddingTop: 8 }}>
                    {!n.read_at && (
                      <span style={{
                        display: 'block', width: 8, height: 8, borderRadius: '50%', background: '#2563EB',
                      }} />
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      <div style={{
                        fontSize: 15, fontWeight: 700, color: isDark ? '#18181B' : CUSTOMER_SURFACE.text, lineHeight: 1.3,
                        minWidth: 0, flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{displayTitle(n)}</div>
                      {chip && (
                        <span style={{
                          fontSize: 14, fontWeight: 600,
                          padding: '1px 6px', borderRadius: 4, flexShrink: 0,
                          color: chip.label === 'Broken' ? '#C0392B' : '#0A7EC2',
                          background: chip.label === 'Broken' ? 'rgba(192,57,43,0.12)' : 'rgba(10,126,194,0.12)',
                        }}>{chip.label}</span>
                      )}
                    </div>
                    {n.body && (
                      <div style={{
                        fontSize: 14, color: isDark ? '#52525B' : CUSTOMER_SURFACE.body, marginTop: 4, lineHeight: 1.4,
                        // Two lines for ops digests only — their full report is one
                        // tap away (reportLinkFor); every other row, customer rows
                        // included, keeps its whole body as before.
                        ...(n.category === 'ops_digest'
                          ? { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }
                          : {}),
                      }}>{n.body}</div>
                    )}
                    {report && (
                      <button type="button"
                        onClick={(e) => openReport(e, n, report)}
                        onKeyDown={(e) => e.stopPropagation()}
                        style={{
                          marginTop: 6, padding: 0, border: 0, background: 'none', cursor: 'pointer',
                          fontSize: 14, fontWeight: 600, textDecoration: 'underline',
                          color: isDark ? '#18181B' : CUSTOMER_SURFACE.text,
                        }}>Full report</button>
                    )}
                    {fullText && <FullText text={fullText} marginTop={6} color={isDark ? '#18181B' : CUSTOMER_SURFACE.text} />}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                      <div style={{ fontSize: 12, color: isDark ? '#A1A1AA' : CUSTOMER_SURFACE.muted }}>
                        {timeAgo(n.created_at)}
                      </div>
                      {canMarkDone(n, type) && <DoneButton tall onDone={(e) => markDone(e, n)} color={isDark ? '#18181B' : CUSTOMER_SURFACE.text} />}
                    </div>
                  </div>
                  {href && (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={isDark ? '#18181B' : CUSTOMER_SURFACE.text} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
                      <path d="M7 17L17 7M17 7H8M17 7V16"/>
                    </svg>
                  )}
                </div>
                );
              })}
              {tab === 'account' && moreControl}
              {doneControl}
              {settingsLink}
            </div>
          </div>
        ) : (
          // Desktop: admin keeps the flush right-edge drawer; customer gets a
          // floating glass panel (data-glass="modal" material, inset so the
          // rounded corners read intentionally).
          <div ref={attachPanelRef} role="dialog" aria-modal="true" aria-label="Notifications" data-glass={isDark ? undefined : 'modal'} style={{
            position: 'fixed',
            top: isDark ? 56 : 'calc(12px + env(safe-area-inset-top, 0px))',
            right: isDark ? 0 : 'calc(12px + env(safe-area-inset-right, 0px))',
            bottom: isDark ? 0 : 'calc(12px + env(safe-area-inset-bottom, 0px))',
            width: '100%', maxWidth: 400,
            background: colors.bg, border: `1px solid ${colors.border}`,
            borderRadius: isDark ? 0 : 24,
            boxShadow: isDark ? '-4px 0 20px rgba(0,0,0,0.15)' : '0 18px 45px rgba(27,44,91,0.10)',
            zIndex: 9999,
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            {/* Header */}
            <div style={{
              padding: '16px 20px', borderBottom: `1px solid ${colors.border}`,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              flexShrink: 0,
            }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: colors.text }}>Notifications</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {unreadCount > 0 && (
                  <button onClick={markAllRead} style={{
                    background: 'none', border: 'none', color: colors.teal,
                    fontSize: 12, fontWeight: type === 'admin' ? 500 : 600, cursor: 'pointer', padding: '4px 8px',
                  }}>Mark all read</button>
                )}
                <button onClick={() => setOpen(false)} aria-label="Close notifications" style={{
                  background: 'none', border: 'none', color: colors.muted,
                  fontSize: 20, cursor: 'pointer', padding: 4, minWidth: 44, minHeight: 44,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>&#x2715;</button>
              </div>
            </div>

            {/* Enable Push strip — admin only, shown when not yet
                subscribed on this device. */}
            {showPushStrip && (
              <PushEnableStrip
                admin={type === 'admin'}
                enabling={pushEnabling}
                error={pushError}
                onClick={handleEnablePush}
              />
            )}

            {/* Notification List */}
            <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}>
              {loading && <div style={{ padding: 40, textAlign: 'center', color: colors.muted }}>Loading...</div>}
              {!loading && loadFailed && (
                <div style={{ padding: 60, textAlign: 'center' }}>
                  <div style={{ fontSize: 14, color: colors.muted }}>Notifications couldn&apos;t be loaded.</div>
                  <button type="button" onClick={loadNotifications} style={{
                    marginTop: 12, padding: '8px 14px', borderRadius: 8, border: `1px solid ${colors.border || '#D8D0C0'}`,
                    background: 'transparent', color: colors.text || colors.muted, fontSize: 14, fontWeight: 700, cursor: 'pointer',
                  }}>Try again</button>
                </div>
              )}
              {!loading && !loadFailed && notifications.length === 0 && (
                <div style={{ padding: 60, textAlign: 'center' }}>
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={colors.muted} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12 }}>
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                  </svg>
                  <div style={{ fontSize: 14, color: colors.muted }}>No notifications yet</div>
                </div>
              )}
              {!loading && !loadFailed && groupByTime(notifications).map(([group, items]) => (
                <div key={group}>
                  <div style={{
                    padding: '8px 20px', fontSize: 11, fontWeight: 700, color: colors.muted,
                    textTransform: 'uppercase', letterSpacing: 0.5,
                    background: isDark ? '#0f172a' : 'rgba(255,255,255,0.75)', position: 'sticky', top: 0,
                    backdropFilter: isDark ? 'none' : 'blur(8px)', WebkitBackdropFilter: isDark ? 'none' : 'blur(8px)',
                  }}>{group}</div>
                  {items.map(n => {
                    const href = linkFor(n);
                    const chip = digestKindChip(n);
                    const report = reportLinkFor(n);
                    const fullText = fullTextFor(n, type);
                    const title = displayTitle(n);
                    return (
                    <div key={n.id}
                      role={href ? 'link' : undefined}
                      tabIndex={href ? 0 : undefined}
                      className={href ? 'waves-focus-ring' : undefined}
                      onClick={async () => {
                        if (!n.read_at) await markRead(n.id);
                        if (href) { setOpen(false); window.location.href = href; }
                      }}
                      onKeyDown={href ? async (e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        if (!n.read_at) await markRead(n.id);
                        setOpen(false);
                        window.location.href = href;
                      } : undefined}
                      style={{
                        padding: '12px 20px', cursor: href ? 'pointer' : 'default',
                        borderBottom: `1px solid ${colors.border}`,
                        background: n.read_at ? 'transparent' : colors.unreadBg,
                        display: 'flex', gap: 12, alignItems: 'flex-start',
                        minHeight: 44,
                      }}
                    >
                      <span style={{ fontSize: 20, flexShrink: 0, marginTop: 2 }}>{n.icon || '\u{1F514}'}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          <div title={title} style={{
                            fontSize: 15, fontWeight: n.read_at ? 400 : 700, color: colors.text,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            minWidth: 0, flex: '0 1 auto',
                          }}>{title}</div>
                          {chip && (
                            <span style={{
                              fontSize: 14, fontWeight: 600,
                              padding: '1px 6px', borderRadius: 4, flexShrink: 0,
                              color: chip.label === 'Broken' ? colors.badge : colors.teal,
                              background: chip.label === 'Broken' ? 'rgba(192,57,43,0.12)' : 'rgba(10,126,194,0.12)',
                            }}>{chip.label}</span>
                          )}
                        </div>
                        {n.body && (
                          <div title={n.body} style={{
                            fontSize: 14, color: colors.muted, marginTop: 2, lineHeight: 1.4,
                            overflow: 'hidden', textOverflow: 'ellipsis',
                            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                          }}>{n.body}</div>
                        )}
                        {report && (
                          <button type="button"
                            onClick={(e) => openReport(e, n, report)}
                            onKeyDown={(e) => e.stopPropagation()}
                            style={{
                              marginTop: 4, padding: 0, border: 0, background: 'none', cursor: 'pointer',
                              fontSize: 14, fontWeight: 600, textDecoration: 'underline', color: colors.teal,
                            }}>Full report</button>
                        )}
                        {fullText && <FullText text={fullText} marginTop={4} color={colors.text} />}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                          <div style={{ fontSize: 11, color: colors.muted }}>
                            {timeAgo(n.created_at)}
                          </div>
                          {canMarkDone(n, type) && <DoneButton onDone={(e) => markDone(e, n)} color={colors.text} />}
                        </div>
                      </div>
                      {!n.read_at && (
                        <span style={{
                          width: 8, height: 8, borderRadius: '50%', background: colors.teal,
                          flexShrink: 0, marginTop: 6,
                        }} />
                      )}
                    </div>
                    );
                  })}
                </div>
              ))}
              {moreControl}
              {doneControl}
              {settingsLink}
            </div>
          </div>
        ),
        document.body
      )}
    </div>
  );
}

// Inline strip rendered in both mobile + desktop bell views when the
// admin hasn't yet subscribed this device to Web Push. iOS PWA
// requirement is surfaced via the error-message path inside
// ensurePushSubscription, not pre-emptively here, so Android/desktop
// users don't see an irrelevant warning.
function PushEnableStrip({ admin, enabling, error, onClick }) {
  return (
    <div style={{
      padding: '12px 16px',
      background: '#F4F4F5',
      borderBottom: '1px solid #E4E4E7',
      fontSize: 13,
      color: '#18181B',
    }}>
      <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontWeight: admin ? 500 : 600 }}>Get push notifications on this device</span>
      </div>
      <div style={{ marginBottom: 8, color: '#52525B', fontSize: 12 }}>
        Banner alerts for failed payments, overdue invoices, unmapped calls, and more.
      </div>
      <button
        onClick={onClick}
        disabled={enabling}
        style={{
          padding: '8px 14px',
          background: '#18181B',
          color: '#FFFFFF',
          border: 'none',
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 500,
          cursor: enabling ? 'wait' : 'pointer',
        }}
      >
        {enabling ? 'Enabling…' : 'Enable push'}
      </button>
      {error && (
        <div style={{ marginTop: 8, color: '#C8312F', fontSize: 14, lineHeight: 1.4 }}>
          {error}
        </div>
      )}
    </div>
  );
}

// Pure helpers, exported for focused unit tests (avoids a full component
// render just to pin the prefix strip / chip / focus-link logic).
export const _test = { displayTitle, digestKindChip, linkFor, reportLinkFor, fullTextFor };
