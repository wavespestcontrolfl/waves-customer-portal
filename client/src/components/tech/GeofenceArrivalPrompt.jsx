/**
 * GeofenceArrivalPrompt
 *
 * Polls /api/tech/notifications every 10s and renders:
 *   - an arrival reminder card for `geofence_arrival_reminder` (tech confirms / dismisses)
 *   - an auto-started info card for `geofence_timer_started`
 *   - a stop toast (with Undo) for `geofence_timer_stopped`
 *   - a visit card for `visit_assigned` / `visit_unassigned` /
 *     `visit_rescheduled` / `visit_cancelled` (tech-visit-notifications.js) —
 *     no auto-dismiss: it waits until the tech taps "Got it"
 *   - a text card for `tech_line_sms` (tech-line.js: a text to the tech's own
 *     Twilio line) — same kept-until-"Got it" rule and the same on-screen cap
 *   - a tracking card for `follow_through_tracking` (no-show-detector.js: a
 *     missing-departure/arrival warning on one of this tech's own visits) —
 *     same kept-until-"Got it" rule and cap, sharing the visit-card slot
 *   - an open-visits card for `tech_open_visit_nudge` (tech-open-visit-nudge.js:
 *     the 7 PM "visits from today still open" reminder for techs who aren't
 *     texted) — same kept-until-"Got it" rule and cap
 *   - a photo card for `customer_visit_photos` (visit-prep-tech-alert.js,
 *     GATE_VISIT_PREP_TECH_ALERTS: a customer sent prep photos for a stop
 *     on this tech's route) — same kept-until-"Got it" rule and cap,
 *     sharing the visit-card slot
 *
 * Mount once inside TechHomePage. `placement` decides where the cards sit
 * (owner 2026-10-05, after phone screenshots of notices covering the screen):
 *   - 'page' (default; the Today overview): every card renders in the page
 *     flow at the top, so the tech scrolls past them. No overlay.
 *   - 'elsewhere' (Tools, More, an open visit): only the time-critical
 *     arrival cards float; every other card waits on Today, and one small
 *     line at the top says how many there are and links there.
 *
 * Audit focus:
 * - Polling cleanup: confirm the 10s interval is cleared on unmount and
 *   doesn't leak across navigations / fast remounts.
 * - Network failure: a request that fails should not halt subsequent
 *   polls; verify the error path swallows quietly and resumes.
 * - Notification dedupe: if the same notification id arrives twice
 *   (server retry, late ack), do we render two cards?
 * - Auto-dismiss timers (REMINDER_AUTODISMISS_MS, STOP_TOAST_MS): they start
 *   only once the card has been seen (SeenOnScreen: visible on screen for
 *   SEEN_DWELL_MS, or tapped). An unseen card never expires on the clock and
 *   stays unread on the server. If the user confirms / dismisses manually
 *   before the timer fires, confirm we clear the pending timeout to avoid a
 *   late-firing dismiss racing with a fresh notification.
 * - Backgrounded tab behavior: when the tech's phone backgrounds the
 *   tab, polls pause. On resume, do we catch up correctly? Skipped
 *   notifications during the gap should still render once.
 * - Bouncie-mileage tie-in (if any): some installs have geofence
 *   timer events also drive mileage. Confirm a stop here doesn't
 *   double-write the mileage record.
 */
import { TIME_TRACKING_CHANGED } from './timeTrackingEvents';
import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { getAdminAuthToken } from '../../lib/adminAuth';
import { useTechBasePath } from './techBasePath';
import useIsMobile from '../../hooks/useIsMobile';
import { formatETDateOnly } from '../../lib/timezone';

const API = import.meta.env.VITE_API_URL || '';
const POLL_MS = 10_000;
// Timed cards (arrival, timer, storm) keep their clock, but it starts when the
// tech has SEEN the card, not when it arrived (owner 2026-10-06, "keep
// notices"): a card scrolled past or opened on a locked phone used to be
// marked read after 5 minutes unseen.
const REMINDER_AUTODISMISS_MS = 5 * 60 * 1000;
const STOP_TOAST_MS = 15_000;
// The server refuses Undo on a stop notice older than this (410), and stops
// serving the notice then, so the toast offers no Undo past it either.
const UNDO_WINDOW_MS = 30 * 60 * 1000;
// Seen = at least half the card (or half the screen, for a tall card) in view
// and not covered, still true after this long on a visible page, or a tap.
const SEEN_VISIBLE_RATIO = 0.5;
const SEEN_DWELL_MS = 1500;
const MAX_STORM_CARDS = 2;
// Visit cards never auto-dismiss, so a bulk assign or day swap could stack
// dozens over the actionable geofence prompts: same cap + summary line as
// storms, newest first, and prompts always render above them.
const MAX_VISIT_CARDS = 2;

// Visit cards are the tech's record of a schedule change; they never
// auto-dismiss (the 5-min reminder timer would mark them read unseen).
const VISIT_TYPES = new Set(['visit_assigned', 'visit_unassigned', 'visit_rescheduled', 'visit_cancelled']);
// A text on the tech's own line is kept the same way, and shares the cap.
const TEXT_TYPES = new Set(['tech_line_sms']);
// A missing-departure/arrival warning (no-show-detector.js) never
// auto-dismisses either — it identifies a visit that still needs an
// en_route/arrived stamp, so it stays until the tech taps "Got it" (or the
// server-side alert clears and the card falls out of the poll).
const TRACKING_TYPES = new Set(['follow_through_tracking']);
// The 7 PM open-visits reminder (tech-open-visit-nudge.js) is kept too: it is
// the durable copy when the push reaches no device.
const NUDGE_TYPES = new Set(['tech_open_visit_nudge']);
// A customer's visit-prep photo submission (visit-prep-tech-alert.js) —
// kept until "Got it" the same way, so it isn't lost to the 5-min auto-
// dismiss timer before the tech has opened the stop.
const PHOTO_TYPES = new Set(['customer_visit_photos']);
// Time-critical: these still float over Tools, More and an open visit.
const FLOATING_TYPES = new Set(['geofence_arrival_reminder', 'geofence_arrival_select', 'geofence_timer_started', 'geofence_timer_stopped']);
const KEPT_TYPES = new Set([...VISIT_TYPES, ...TEXT_TYPES, ...TRACKING_TYPES, ...NUDGE_TYPES, ...PHOTO_TYPES]);
// Waves Admin look: ink and stone, amber for a warning, red only where the
// notice is a genuine alert (a cancelled visit, a late arrival check).
const VISIT_ACCENT = {
  visit_assigned: '#1c1917',
  visit_rescheduled: '#854d0e',
  visit_unassigned: '#78716c',
  visit_cancelled: '#a32d2d',
};
const VISIT_ICON = {
  visit_assigned: '🗓',
  visit_rescheduled: '⏱',
  visit_unassigned: '↪',
  visit_cancelled: '✕',
};

const COLORS = {
  bg: '#ffffff',
  border: '#e7e5e4',
  borderStrong: '#d6d3d1',
  text: '#1c1917',
  muted: '#57534e',
  faint: '#78716c',
  ink: '#1c1917',
  amber: '#854d0e',
  red: '#a32d2d',
};

async function apiPost(path, body) {
  const token = getAdminAuthToken();
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.ok ? res.json() : Promise.reject(await res.text());
}

async function apiGet(path) {
  const token = getAdminAuthToken();
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  // A failed poll is skipped, not treated as an empty feed: the visit-card
  // reconcile below would otherwise clear every persistent card on a 5xx.
  return res.ok ? res.json() : Promise.reject(new Error(`${res.status}`));
}

function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({});
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve({}),
      { enableHighAccuracy: true, timeout: 5000 }
    );
  });
}

export default function GeofenceArrivalPrompt({ onStormReview, inlineScheduleChanges = false, placement = 'page', navigationBusy = false }) {
  const elsewhere = placement === 'elsewhere';
  const isMobile = useIsMobile();
  const [active, setActive] = useState([]);
  const seenIds = useRef(new Set());
  // When the tech first saw each card (id → ms). A card with no entry has not
  // been seen and its auto-dismiss clock has not started.
  const seenAt = useRef(new Map());
  const [seenTick, setSeenTick] = useState(0);
  const markSeen = useCallback((id) => {
    if (seenAt.current.has(id)) return;
    seenAt.current.set(id, Date.now());
    setSeenTick((t) => t + 1);
  }, []);

  const poll = useCallback(async () => {
    try {
      const { notifications = [] } = await apiGet('/api/tech/notifications');
      const fresh = notifications.filter((n) => !seenIds.current.has(n.id));
      fresh.forEach((n) => seenIds.current.add(n.id));
      // Automatic geofence mode starts and stops job timers server-side and
      // only posts these notices: the time clock reloads on them too (Codex #5786).
      if (fresh.some((n) => n.type === 'geofence_timer_started' || n.type === 'geofence_timer_stopped')) {
        window.dispatchEvent(new Event(TIME_TRACKING_CHANGED));
      }
      // The server feed is the source of truth for what is still open: a
      // card the feed no longer lists leaves this screen too (tapped "Got it"
      // on the tech's other device, pushed out of the feed window by a burst,
      // or aged out by the server: an arrival prompt at ET midnight, a stop
      // toast after its 30-minute Undo window, a storm nudge after 6 hours).
      // It is forgotten, so it can come back if the feed lists it again. No
      // /read post: the server already stopped serving it, or another device
      // handled it.
      const listed = new Set(notifications.map((n) => n.id));
      // A photo card's date is re-read from the live visit on every poll
      // (visit-prep-tech-alert.js refreshPhotoCardDates), so a card already
      // on screen takes the new payload when the visit moves (Codex #5303 r6).
      const photoPayloads = new Map(notifications.filter((n) => PHOTO_TYPES.has(n.type)).map((n) => [n.id, n.payload]));
      setActive((prev) => {
        const gone = prev.filter((n) => !listed.has(n.id));
        gone.forEach((n) => { seenIds.current.delete(n.id); seenAt.current.delete(n.id); });
        let refreshed = false;
        const kept = prev.filter((n) => !gone.includes(n)).map((n) => {
          if (!photoPayloads.has(n.id)) return n;
          const payload = photoPayloads.get(n.id);
          if (JSON.stringify(payload) === JSON.stringify(n.payload)) return n;
          refreshed = true;
          return { ...n, payload };
        });
        if (gone.length === 0 && fresh.length === 0 && !refreshed) return prev;
        return [...kept, ...fresh];
      });
    } catch {
      // network hiccups are fine; next poll will retry
    }
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  // Storm cards are capped so a burst of alerts can never bury the home
  // screen: one card per stop (newest wins when the sweep re-alerts), at
  // most MAX_STORM_CARDS on screen, the rest summarized in one line.
  const { cards, hiddenStormCount, hiddenVisitCount, waitingCount } = useMemo(() => {
    const stormByJob = new Map();
    const otherCards = [];
    const visitCards = [];
    for (const n of active) {
      // Shown in the page instead (TechScheduleChanges), not floated here.
      if (inlineScheduleChanges && VISIT_TYPES.has(n.type)) continue;
      if (KEPT_TYPES.has(n.type)) { visitCards.push(n); continue; }
      if (n.type !== 'storm_watch_alert') { otherCards.push(n); continue; }
      const jobKey = n.payload?.job_id || n.id;
      const prev = stormByJob.get(jobKey);
      if (!prev || new Date(n.created_at || 0) > new Date(prev.created_at || 0)) {
        stormByJob.set(jobKey, n);
      }
    }
    const stormAlerts = [...stormByJob.values()].sort(
      (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0),
    );
    // Away from Today only the arrival cards render; everything else is
    // counted for the "notices on Today" line and left unread.
    if (elsewhere) {
      return {
        cards: otherCards.filter((n) => FLOATING_TYPES.has(n.type)),
        hiddenStormCount: 0, hiddenVisitCount: 0,
        waitingCount: visitCards.length + stormAlerts.length,
      };
    }
    const shownStorms = stormAlerts.slice(0, MAX_STORM_CARDS);
    // Tracking cards (follow_through_tracking) rank ahead of routine kept
    // cards inside the cap — stage 2 first, then stage 1 — so two newer
    // routine visit/text cards can never push a stage-2 "needs an arrival
    // check" card into the hidden-count summary. Recency alone was the only
    // sort before this, and both buckets share MAX_VISIT_CARDS (codex P1).
    const trackingTier = (n) => (n.type === 'follow_through_tracking' ? (n.payload?.stage === 2 ? 2 : 1) : 0);
    const visitsRanked = [...visitCards].sort((a, b) => {
      const tierDiff = trackingTier(b) - trackingTier(a);
      if (tierDiff !== 0) return tierDiff;
      return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    });
    const shownVisits = visitsRanked.slice(0, MAX_VISIT_CARDS);
    // Order: actionable prompts, then storm warnings (both on a timer that
    // marks them read), then the persistent visit cards — nothing that can
    // expire unseen ever sits below something that waits for a tap.
    return {
      cards: [...otherCards, ...shownStorms, ...shownVisits],
      hiddenStormCount: stormAlerts.length - shownStorms.length,
      hiddenVisitCount: visitsRanked.length - shownVisits.length,
      waitingCount: 0,
    };
  }, [active, inlineScheduleChanges, elsewhere]);

  // Superseded same-stop storm alerts are duplicates of information the tech
  // IS seeing (the newest card for that stop) — mark them read immediately so
  // clearing the visible card doesn't promote each stale duplicate in turn.
  // Alerts for OTHER stops held back by the cap stay untouched/unread.
  useEffect(() => {
    const newestByJob = new Map();
    for (const n of active) {
      if (n.type !== 'storm_watch_alert') continue;
      const jobKey = n.payload?.job_id || n.id;
      const prev = newestByJob.get(jobKey);
      if (!prev || new Date(n.created_at || 0) > new Date(prev.created_at || 0)) {
        newestByJob.set(jobKey, n);
      }
    }
    for (const n of active) {
      if (n.type !== 'storm_watch_alert') continue;
      const jobKey = n.payload?.job_id || n.id;
      if (newestByJob.get(jobKey)?.id !== n.id) removeCard(n.id, { silent: true });
    }
  }, [active]);

  // Auto-dismiss timers — RENDERED and SEEN cards only. Storm alerts for other
  // stops held back by the cap must stay unread so they actually surface
  // later, and a card the tech has not yet seen must stay unread too: marking
  // either read here would hide it from every future unreadOnly poll without
  // the tech ever seeing it. The clock runs from the moment of first sight, so
  // a re-run of this effect (a new card arriving) never restarts it.
  useEffect(() => {
    const timers = cards
      .filter((n) => !KEPT_TYPES.has(n.type) && seenAt.current.has(n.id))
      .map((n) => {
        const ms = n.type === 'geofence_timer_stopped' ? STOP_TOAST_MS : REMINDER_AUTODISMISS_MS;
        const left = Math.max(0, ms - (Date.now() - seenAt.current.get(n.id)));
        return setTimeout(() => removeCard(n.id, { silent: true }), left);
      });
    return () => timers.forEach(clearTimeout);

  }, [cards, seenTick]);

  function removeCard(id, { silent } = {}) {
    setActive((prev) => prev.filter((n) => n.id !== id));
    if (!silent) {
      apiPost(`/api/tech/notifications/${id}/dismiss`).catch(() => {});
    } else {
      apiPost(`/api/tech/notifications/${id}/read`).catch(() => {});
    }
  }

  // "Got it" on a visit card: optimistic, but a dismiss the network lost
  // must not hide the card for the rest of the session — the server still
  // lists it, so forgetting the id lets the next poll bring it back.
  function dismissVisitCard(id) {
    setActive((prev) => prev.filter((n) => n.id !== id));
    apiPost(`/api/tech/notifications/${id}/dismiss`).catch(() => { seenIds.current.delete(id); });
  }

  async function handleStart(n, pick) {
    const pos = await getPosition();
    const body = pick
      ? { ...pos, customer_id: pick.customer_id, job_id: pick.job_id }
      : pos;
    try {
      await apiPost(`/api/tech/notifications/${n.id}/confirm-start`, body);
      removeCard(n.id, { silent: true });
      // The Today page's time clock reloads (TechTimeTrackingCard).
      window.dispatchEvent(new Event(TIME_TRACKING_CHANGED));
    } catch (err) {
      alert('Could not start timer: ' + String(err).slice(0, 140));
    }
  }

  async function handleUndo(n) {
    try {
      await apiPost(`/api/tech/notifications/${n.id}/undo-stop`);
      removeCard(n.id, { silent: true });
      window.dispatchEvent(new Event(TIME_TRACKING_CHANGED));
    } catch (err) {
      alert('Undo failed: ' + String(err).slice(0, 140));
    }
  }

  const showStack = cards.length > 0 || hiddenVisitCount > 0 || hiddenStormCount > 0;
  if (!showStack && waitingCount === 0) return null;

  return (
    <>
    {elsewhere && waitingCount > 0 && <NoticesOnToday count={waitingCount} busy={navigationBusy} />}
    {showStack && <div data-testid="notice-stack" data-placement={elsewhere ? 'float' : 'page'} style={elsewhere ? {
      // On a phone the floating arrival cards sit below the admin top bar (52px), so the bar stays reachable.
      position: 'fixed', top: isMobile ? 'calc(60px + env(safe-area-inset-top, 0px))' : 12, left: 12, right: 12, zIndex: 10_000,
      display: 'flex', flexDirection: 'column', gap: 10, pointerEvents: 'none',
      // Arrival cards are few; a cap keeps even a burst from covering the page.
      maxHeight: '50dvh', overflowY: 'auto',
    } : { display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
      {cards.map((n) => (
        <SeenOnScreen key={n.id} id={n.id} onSeen={markSeen} style={elsewhere ? { pointerEvents: 'auto', filter: 'drop-shadow(0 6px 14px rgba(28,25,23,0.18))' } : undefined}>
          {n.type === 'geofence_arrival_reminder' && (
            <ReminderCard n={n} onStart={() => handleStart(n)} onDismiss={() => removeCard(n.id)} />
          )}
          {n.type === 'geofence_arrival_select' && (
            <SelectorCard n={n} onPick={(pick) => handleStart(n, pick)} onDismiss={() => removeCard(n.id)} />
          )}
          {n.type === 'geofence_timer_started' && (
            <InfoCard n={n} onDismiss={() => removeCard(n.id, { silent: true })} />
          )}
          {n.type === 'geofence_timer_stopped' && (
            <StopToast n={n} onUndo={() => handleUndo(n)} onDismiss={() => removeCard(n.id, { silent: true })} />
          )}
          {VISIT_TYPES.has(n.type) && (
            <VisitCard n={n} onDismiss={() => dismissVisitCard(n.id)} />
          )}
          {TEXT_TYPES.has(n.type) && (
            <TextCard n={n} onDismiss={() => dismissVisitCard(n.id)} />
          )}
          {TRACKING_TYPES.has(n.type) && (
            <TrackingCard n={n} onDismiss={() => dismissVisitCard(n.id)} />
          )}
          {NUDGE_TYPES.has(n.type) && (
            <OpenVisitsCard n={n} onDismiss={() => dismissVisitCard(n.id)} />
          )}
          {PHOTO_TYPES.has(n.type) && (
            <PhotoCard n={n} onDismiss={() => dismissVisitCard(n.id)} />
          )}
          {n.type === 'storm_watch_alert' && (
            <StormCard
              n={n}
              onReview={() => {
                onStormReview?.(n.payload || {});
                removeCard(n.id, { silent: true });
              }}
              onDismiss={() => removeCard(n.id)}
            />
          )}
        </SeenOnScreen>
      ))}
      {hiddenVisitCount > 0 && (
        <div style={{ ...cardStyle(COLORS.muted), padding: 10 }} data-testid="visit-notice-more">
          <div style={{ fontSize: 13, color: COLORS.muted }}>
            🗓 {hiddenVisitCount} more notice{hiddenVisitCount === 1 ? '' : 's'} — they'll surface as you clear these.
          </div>
        </div>
      )}
      {hiddenStormCount > 0 && (
        <div style={{ ...cardStyle(COLORS.amber), padding: 10 }}>
          <div style={{ fontSize: 13, color: COLORS.muted }}>
            ⛈️ {hiddenStormCount} more storm watch{hiddenStormCount === 1 ? '' : 'es'} — they'll surface as you clear these.
          </div>
        </div>
      )}
    </div>}
    </>
  );
}

// Wraps one card and reports it SEEN once the tech has really had it on screen:
// at least SEEN_VISIBLE_RATIO of the card (or of the viewport, for a card taller
// than the screen) shows, and nothing sits on top of it. IntersectionObserver
// only decides when to look: it ignores a modal or sheet drawn over the card
// and cannot express "half the viewport" for a tall card, so the check runs at
// the END of a SEEN_DWELL_MS dwell with a fresh measurement (cardReallyInView).
// While the card is in the viewport and the page is visible the check repeats
// every dwell, so a modal that closes later lets the card count then. A tap on
// the card counts too. A browser without IntersectionObserver checks on the
// same schedule.
function SeenOnScreen({ id, onSeen, style, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    let nearViewport = typeof IntersectionObserver === 'undefined';
    let timer = null;
    let done = false;
    const pageVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const schedule = () => {
      if (done || timer || !nearViewport || !pageVisible()) return;
      timer = setTimeout(() => {
        timer = null;
        if (!nearViewport || !pageVisible()) return;
        if (cardReallyInView(el)) { done = true; onSeen(id); return; }
        schedule();
      }, SEEN_DWELL_MS);
    };
    const evaluate = () => {
      if (nearViewport && pageVisible()) schedule(); else stop();
    };
    let observer = null;
    if (!nearViewport) {
      observer = new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        nearViewport = entry.isIntersecting;
        evaluate();
      }, { threshold: 0 });
      observer.observe(el);
    }
    document.addEventListener('visibilitychange', evaluate);
    evaluate();
    return () => {
      done = true;
      stop();
      document.removeEventListener('visibilitychange', evaluate);
      if (observer) observer.disconnect();
    };
  }, [id, onSeen]);
  return <div ref={ref} style={style} onClickCapture={() => onSeen(id)}>{children}</div>;
}

// Fresh measurement: the part of the card inside the viewport covers at least
// SEEN_VISIBLE_RATIO of the card, or of the viewport when the card is taller
// than half of it, and the element at the middle of that part belongs to the
// card (nothing fixed on top of it).
function cardReallyInView(el) {
  const rect = el.getBoundingClientRect();
  const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;
  const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
  if (!(rect.width > 0 && rect.height > 0 && viewportH > 0 && viewportW > 0)) return false;
  const left = Math.max(rect.left, 0);
  const right = Math.min(rect.right, viewportW);
  const top = Math.max(rect.top, 0);
  const bottom = Math.min(rect.bottom, viewportH);
  if (right <= left || bottom <= top) return false;
  const shown = (right - left) * (bottom - top);
  const enough = shown >= rect.width * rect.height * SEEN_VISIBLE_RATIO
    || shown >= viewportW * viewportH * SEEN_VISIBLE_RATIO;
  if (!enough) return false;
  if (typeof document.elementFromPoint !== 'function') return true;
  const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
  return !!hit && el.contains(hit);
}

// "N notices on Today": the one in-page line shown away from Today for the
// cards that wait there. Held while a visit action is in flight, like the
// workspace's other links.
function NoticesOnToday({ count, busy }) {
  const base = useTechBasePath();
  return (
    <Link
      to={base}
      aria-disabled={busy || undefined}
      onClick={(event) => { if (busy) event.preventDefault(); }}
      data-testid="notices-on-today"
      style={{
        display: 'flex', alignItems: 'center', minHeight: 44, marginBottom: 12, padding: '0 14px', boxSizing: 'border-box',
        border: `0.5px solid ${COLORS.borderStrong}`, borderRadius: 6, background: COLORS.bg, color: COLORS.text,
        fontFamily: "'Roboto', system-ui, sans-serif", fontSize: 14, fontWeight: 500, textDecoration: 'none',
        opacity: busy ? 0.5 : 1,
      }}
    >
      {count} {count === 1 ? 'notice' : 'notices'} on Today
    </Link>
  );
}

// Storm-watch nudge: weather crossing the threshold for an upcoming
// stop. Review opens the Quick Move sheet pre-loaded for that job (via
// onStormReview from TechHomePage); the tech still makes the call.
function StormCard({ n, onReview, onDismiss }) {
  const p = n.payload || {};
  return (
    <div style={cardStyle(COLORS.amber)}>
      <div style={{ fontSize: 14, color: COLORS.muted, marginBottom: 4 }}>⛈️ Storm watch</div>
      <div style={{ fontSize: 15, fontWeight: 500, color: COLORS.text, marginBottom: 12 }}>
        {n.message || `Storms approaching an upcoming stop${p.city ? ` in ${p.city}` : ''}.`}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onReview} style={btnPrimary}>Review options</button>
        <button onClick={onDismiss} style={btnSecondary}>Working through it</button>
      </div>
    </div>
  );
}

function ReminderCard({ n, onStart, onDismiss }) {
  const p = n.payload || {};
  return (
    <div style={cardStyle(p.unscheduled ? COLORS.amber : COLORS.ink)}>
      <div style={{ fontSize: 14, color: COLORS.muted, marginBottom: 4 }}>
        {p.unscheduled ? '⚠️ Unscheduled visit' : '📍 Arrived'}
      </div>
      <div style={{ fontSize: 16, fontWeight: 500, color: COLORS.text, marginBottom: 4 }}>
        {p.customer_name || 'Customer'}
      </div>
      {p.service_type && (
        <div style={{ fontSize: 13, color: COLORS.muted, marginBottom: 12 }}>{p.service_type}</div>
      )}
      {p.unscheduled && (
        <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 12 }}>
          No job scheduled for today. Starting a timer logs this as an unscheduled visit.
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onStart} style={btnPrimary}>Start Timer</button>
        <button onClick={onDismiss} style={btnSecondary}>Not here yet</button>
      </div>
    </div>
  );
}

function SelectorCard({ n, onPick, onDismiss }) {
  const p = n.payload || {};
  const candidates = p.candidates || [];
  return (
    <div style={cardStyle(COLORS.ink)}>
      <div style={{ fontSize: 14, color: COLORS.muted, marginBottom: 4 }}>📍 Near multiple customers</div>
      <div style={{ fontSize: 13, color: COLORS.text, marginBottom: 12 }}>
        Pick the one you're at:
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
        {candidates.map((c, i) => (
          <button key={i} onClick={() => onPick(c)} style={{
            textAlign: 'left', padding: 12, borderRadius: 4,
            border: `0.5px solid ${COLORS.borderStrong}`, background: 'transparent',
            color: COLORS.text, cursor: 'pointer', fontSize: 13,
          }}>
            <div style={{ fontWeight: 500 }}>{c.customer_name}</div>
            {c.address && <div style={{ color: COLORS.muted, fontSize: 12 }}>{c.address}</div>}
            {c.service_type && <div style={{ color: COLORS.muted, fontSize: 11, marginTop: 2 }}>{c.service_type}</div>}
          </button>
        ))}
      </div>
      <button onClick={onDismiss} style={btnSecondary}>Not here yet</button>
    </div>
  );
}

// A schedule change on the tech's own route (tech-visit-notifications.js).
// Headline + who + the details the server composed; "Got it" dismisses.
function VisitCard({ n, onDismiss }) {
  const p = n.payload || {};
  const lines = [];
  if (n.type === 'visit_rescheduled') {
    if (p.service_type) lines.push(p.service_type);
    if (p.previous_when) lines.push({ text: `Was ${p.previous_when}`, struck: true });
    if (p.when) lines.push(`Now ${p.when}`);
  } else {
    lines.push([p.service_type, p.when].filter(Boolean).join(' · '));
    if (n.type === 'visit_assigned' && p.address) lines.push(p.address);
    // `ended`: the visit finished (cancelled / completed …) before this card landed — name that, not a holder.
    if (n.type === 'visit_unassigned') lines.push(p.ended ? `Now ${p.ended}` : (p.now_with ? `Now with ${p.now_with}` : 'Now unassigned'));
  }
  if (p.actor) {
    const verb = { visit_assigned: 'Assigned', visit_unassigned: 'Reassigned', visit_rescheduled: 'Moved', visit_cancelled: 'Cancelled' }[n.type];
    lines.push(`${verb} ${p.actor}`);
  }
  return (
    <div style={cardStyle(VISIT_ACCENT[n.type] || COLORS.ink)} data-testid="visit-notice">
      <div style={{ fontSize: 14, color: COLORS.muted, marginBottom: 4 }}>
        {VISIT_ICON[n.type]} {p.headline || 'Schedule change'}
      </div>
      <div style={{ fontSize: 16, fontWeight: 500, color: COLORS.text, marginBottom: 4 }}>
        {p.customer_name || 'Customer'}
      </div>
      <div style={{ fontSize: 13, color: COLORS.muted, marginBottom: 12, lineHeight: 1.4 }}>
        {lines.filter(Boolean).map((line, i) => (
          typeof line === 'string'
            ? <div key={i}>{line}</div>
            : <div key={i} style={{ textDecoration: 'line-through', color: COLORS.faint }}>{line.text}</div>
        ))}
      </div>
      <button onClick={onDismiss} style={{ ...btnSecondary, width: '100%' }}>Got it</button>
    </div>
  );
}

// A customer's visit-prep photo submission (visit-prep-tech-alert.js,
// GATE_VISIT_PREP_TECH_ALERTS). No customer name/address/note here — that
// same lock-screen discipline extends to the card, not just the push. The
// visit is usually days out and the tech app only opens today's route, so
// the card names the visit's DATE instead of a tap-through that would dead-
// end (Codex #5303 r1 P1); the photos are in that stop's Visit Brief.

function PhotoCard({ n, onDismiss }) {
  const visitDate = formatETDateOnly(n.payload?.scheduled_date, { weekday: 'short', month: 'short', day: 'numeric' }) || null;
  return (
    <div style={cardStyle(COLORS.ink)} data-testid="photo-notice">
      <div style={{ fontSize: 14, color: COLORS.muted, marginBottom: 4 }}>📷 Photos from a customer</div>
      <div style={{ fontSize: 15, fontWeight: 500, color: COLORS.text, marginBottom: visitDate ? 4 : 12 }}>
        {n.message || 'A customer sent photos for a visit on your route'}
      </div>
      {visitDate && (
        <div style={{ fontSize: 14, color: COLORS.muted, marginBottom: 12 }}>
          Visit on {visitDate}. The photos are in that stop&apos;s Visit Brief.
        </div>
      )}
      <button onClick={onDismiss} style={{ ...btnSecondary, width: '100%' }}>Got it</button>
    </div>
  );
}

// A text on the tech's own Twilio line (tech-line.js). The office sees the
// same thread in /admin/communications; this card is the tech's copy, kept
// until "Got it" like a visit card. Replying from the line is a later PR.
function TextCard({ n, onDismiss }) {
  const p = n.payload || {};
  const media = Number(p.media_count || 0);
  return (
    <div style={cardStyle(COLORS.ink)} data-testid="tech-line-text">
      <div style={{ fontSize: 14, color: COLORS.muted, marginBottom: 4 }}>
        💬 {p.headline || 'Text on your line'}
      </div>
      <div style={{ fontSize: 16, fontWeight: 500, color: COLORS.text, marginBottom: 4 }}>
        {p.customer_name || p.from || 'Unknown sender'}
      </div>
      <div style={{ fontSize: 14, color: COLORS.text, marginBottom: 12, lineHeight: 1.4, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {p.body || (media > 0 ? `${media} photo${media === 1 ? '' : 's'}` : '(empty message)')}
      </div>
      <button onClick={onDismiss} style={{ ...btnSecondary, width: '100%' }}>Got it</button>
    </div>
  );
}

// The 7 PM reminder that visits from today are still open
// (tech-open-visit-nudge.js). The server composes `message`: a count line,
// then one line per stop. Kept until "Got it" like a visit card.
function OpenVisitsCard({ n, onDismiss }) {
  const p = n.payload || {};
  return (
    <div style={cardStyle(COLORS.amber)} data-testid="tech-open-visits">
      <div style={{ fontSize: 14, color: COLORS.muted, marginBottom: 4 }}>
        📋 {p.headline || 'Visits from today still open'}
      </div>
      <div style={{ fontSize: 14, color: COLORS.text, marginBottom: 12, lineHeight: 1.4, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {n.message}
      </div>
      <button onClick={onDismiss} style={{ ...btnSecondary, width: '100%' }}>Got it</button>
    </div>
  );
}

// A missing-departure/arrival warning on one of this tech's own visits
// (no-show-detector.js). The server composes `message`; stage 2 means the
// promised window is well behind, not just due.
function TrackingCard({ n, onDismiss }) {
  const p = n.payload || {};
  const stage = p.stage;
  return (
    <div style={cardStyle(stage === 2 ? COLORS.red : COLORS.amber)} data-testid="tracking-notice">
      <div style={{ fontSize: 14, color: COLORS.muted, marginBottom: 4 }}>
        {stage === 2 ? '⚠️ Arrival check needed' : '📍 Window underway'}
      </div>
      {/* Same customer_name/when shape a VisitCard reads — identifies which
          stop this is about (codex P1: a tech with more than one open stop
          can't tell from the bare stage message alone). */}
      <div style={{ fontSize: 16, fontWeight: 500, color: COLORS.text, marginBottom: 4 }}>
        {p.customer_name || 'Customer'}
      </div>
      {p.when && (
        <div style={{ fontSize: 13, color: COLORS.muted, marginBottom: 12 }}>{p.when}</div>
      )}
      <div style={{ fontSize: 14, color: COLORS.text, marginBottom: 12, lineHeight: 1.4 }}>
        {n.message}
      </div>
      <button onClick={onDismiss} style={{ ...btnSecondary, width: '100%' }}>Got it</button>
    </div>
  );
}

function InfoCard({ n, onDismiss }) {
  return (
    <div style={cardStyle(COLORS.ink)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
        <div>
          <div style={{ fontSize: 14, color: COLORS.muted, marginBottom: 4 }}>✅ Timer auto-started</div>
          <div style={{ fontSize: 15, fontWeight: 500, color: COLORS.text }}>{n.message}</div>
        </div>
        <button onClick={onDismiss} style={closeX}>✕</button>
      </div>
    </div>
  );
}

function StopToast({ n, onUndo, onDismiss }) {
  const createdMs = new Date(n.created_at || 0).getTime();
  const undoOpen = !Number.isFinite(createdMs) || !n.created_at || Date.now() - createdMs <= UNDO_WINDOW_MS;
  return (
    <div style={cardStyle(COLORS.amber)}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 14, color: COLORS.text }}>⏱️ {n.message}</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {undoOpen && <button onClick={onUndo} style={btnSecondary}>Undo</button>}
          <button onClick={onDismiss} style={closeX}>✕</button>
        </div>
      </div>
    </div>
  );
}

function cardStyle(accent) {
  return {
    background: COLORS.bg,
    border: `0.5px solid ${COLORS.borderStrong}`,
    borderLeft: `4px solid ${accent}`,
    borderRadius: 6,
    padding: 14,
    fontFamily: "'Roboto', system-ui, sans-serif",
  };
}

const btnPrimary = {
  flex: 1, padding: '10px 12px', borderRadius: 4, border: 'none',
  background: COLORS.ink, color: '#fff', fontWeight: 500, fontSize: 14, cursor: 'pointer',
};

const btnSecondary = {
  padding: '10px 12px', borderRadius: 4, border: `0.5px solid ${COLORS.borderStrong}`,
  background: 'transparent', color: COLORS.text, fontWeight: 500, fontSize: 14, cursor: 'pointer',
};

const closeX = {
  background: 'transparent', border: 'none', color: COLORS.muted,
  fontSize: 16, cursor: 'pointer', padding: '4px 8px',
};
