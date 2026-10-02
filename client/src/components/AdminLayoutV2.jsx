import { clearStaffDeviceData, getAdminAuthToken, loadStaffOfflinePass, saveStaffOfflinePass } from "../lib/adminAuth";
import { installStaffSessionGuard } from "../lib/staffSessionGuard";
import { isFieldPath } from "../lib/adminBookmarkMeta";
import { IntelligenceBarPageDataProvider } from '../hooks/useIntelligenceBarPageData';
import ScheduleSaveNotice, { clearScheduleSaveNotices } from './schedule/ScheduleSaveNotice';
/*
 * AdminLayoutV2 — Square Dashboard-inspired light admin shell.
 *
 * The default admin shell for all users (V1 AdminLayout + AdminLayoutGate
 * were deleted in the V1→V2 migration). See DECISIONS.md entry dated
 * 2026-04-18 for the palette/typography rationale (warm stone, not
 * clinical zinc). The `admin-shell-v2` className below is kept as a
 * stable selector for theme-square.css — it is no longer a flag.
 *
 * Consumes only the CSS custom properties defined in theme-square.css —
 * no inline hex values. When the tech-portal dark variant lands, it can
 * remap the same tokens on a `[data-theme="tech-dark"]` scope without
 * touching this component.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { Outlet, useNavigate, useLocation, Link } from "react-router-dom";
import { consumeSnapshotOnMount } from "../lib/tapToPayReturn";
import { cn } from "./ui/cn";
import { Button } from "./ui";
import {
  Search,
  LogOut,
  Menu,
  X,
  Sparkles,
} from "lucide-react";
import useIsMobile from "../hooks/useIsMobile";
import useModalFocus from "../hooks/useModalFocus";
import { refetchFlags, useFeatureFlag, useFeatureFlagReady } from "../hooks/useFeatureFlag";
import { adminFetch, adminLoginUrl } from "../utils/admin-fetch";
import { trackAdminPageView, markUsageSource } from "../lib/adminUsage";
import {
  ADMIN_DESKTOP_NAV_SECTIONS,
  ADMIN_MOBILE_TABS,
  isAdminNavItemActive,
  isPathAdminOnly,
} from "../config/adminNavigation";
import NotificationBell from "./NotificationBell";
import useUnreadConversations from "../hooks/useUnreadConversations";
import GlobalCommandPalette from "./admin/GlobalCommandPalette";
import { clearEmailDrafts } from "../lib/emailDrafts";
import { AdminNavigationProvider } from "../hooks/useAdminNavigation";
import AdminWorkspaceNavigation from "./admin/AdminWorkspaceNavigation";
import { confirmLeaveIfGuarded } from "../lib/navigation-guard";
import { useTechNavigationLock } from "./tech/TechNavigationLock";

// Bound on the staff check so a dead zone cannot hold the field workspace on
// "Verifying staff access" forever (field paths only; see the auth effect).
export const AUTH_CHECK_TIMEOUT_MS = 15000;

function initialsFor(name) {
  if (!name) return "•";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function roleLabel(role) {
  if (!role) return "Staff";
  if (role === "admin") return "Admin";
  if (role === "technician") return "Technician";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

// Alert red (owner ruling 2026-09-07, DECISIONS.md): an unread inbound text is
// a genuine alert — a customer is waiting on a reply — so the Messages badge
// takes the `alert-fg` token class (Tailwind `alert.fg`, the same class the
// Button / Badge primitives use), not the inbox row's dark dot (§5.7). Hidden at zero;
// capped so a backlog never widens the tab.
function UnreadBadge({ count, style }) {
  if (!(count > 0)) return null;
  const label = count > 99 ? "99+" : String(count);
  return (
      <span
        aria-hidden="true"
        className="bg-alert-fg text-white"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          minWidth: 18,
          height: 18,
          padding: "0 5px",
          borderRadius: 9,
          fontSize: 11,
          fontWeight: 500,
          lineHeight: 1,
          fontVariantNumeric: "tabular-nums",
          ...style,
        }}
      >
        {label}
      </span>
  );
}

// Read after the label, so the link announces "Messages, 5 conversations needing a reply".
function UnreadSrText({ count }) {
  if (!(count > 0)) return null;
  return <span className="sr-only">, {count} conversation{count === 1 ? "" : "s"} needing a reply</span>;
}

export default function AdminLayoutV2() {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  // Field navigation lock (TechNavigationLock, mounted in App outside the
  // router): while a visit action is in flight on /admin/today, the field
  // shell disables its own links; the admin shell's sidebar, tab bar, palette
  // and sign-out must hold too, or they navigate away mid-action (pre-push
  // Codex P1 on the Today page).
  const fieldLock = useTechNavigationLock();
  const fieldBusy = Boolean(fieldLock?.navigationBusy);
  const holdWhileFieldBusy = (event) => {
    if (!fieldBusy) return;
    event.preventDefault();
    event.stopPropagation();
  };
  // The palette's ⌘K / Ctrl+K listener is a window bubble-phase handler; this
  // capture-phase listener runs first and swallows the shortcut while busy.
  useEffect(() => {
    if (!fieldBusy) return undefined;
    const swallowPaletteShortcut = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", swallowPaletteShortcut, true);
    return () => window.removeEventListener("keydown", swallowPaletteShortcut, true);
  }, [fieldBusy]);
  const [user, setUser] = useState(null);
  // True while the shell stands on the offline pass alone (no server answer):
  // that readiness is the field workspace's only. Leaving /admin/today
  // re-runs the online check before any other admin page mounts (Codex #5573
  // r8).
  const [offlineReady, setOfflineReady] = useState(false);
  const [authStatus, setAuthStatus] = useState("checking");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const menuTriggerRef = useRef(null);
  // Mobile drawer: focus moves in on open, Tab is trapped, Escape closes,
  // focus returns to the "Open menu" button (F0014).
  const drawerRef = useModalFocus(isMobile && sidebarOpen, () => setSidebarOpen(false));
  // Per verified account, like the field-workspace read below: an account
  // switch in another tab refetches flags (Codex #5573 r8).
  const agentEstimateEnabled = useFeatureFlag("agent_estimate", false, user?.id ?? null);
  const navigationEnabled = useFeatureFlag("admin-navigation", false, user?.id ?? null);
  const paletteRef = useRef(null);
  // Global Messages badge: conversations needing a reply. Polled
  // only once staff access is verified (same cadence as the bell). The icon's
  // destination is the inbox, never a particular customer.
  const sessionReady = authStatus === "ready" && !(offlineReady && !isFieldPath(location.pathname));
  const unreadConversations = useUnreadConversations(sessionReady && ["admin", "owner"].includes(user?.role));

  // Safari bookmark identity lives in App (AdminSafariShell) so /admin/login
  // is covered. The layout only owns chrome geometry.

  // Restore route if we just returned from WavesPay (iOS often evicts the
  // tab during the hand-off, reloading the app to its default route).
  // See lib/tapToPayReturn.js.
  useEffect(() => {
    consumeSnapshotOnMount(navigate);
    // Mount-only by design (react-hooks/exhaustive-deps isn't configured in
    // the errors-only lint config — a disable directive for it is itself an
    // unknown-rule error).
  }, []);

  // Bumped when the staff check answers for a token that is no longer the
  // stored one (another tab signed in): the check reruns for the new login
  // instead of applying the old login's answer.
  const [verifyRun, setVerifyRun] = useState(0);
  const locationRef = useRef(location);
  locationRef.current = location;

  useEffect(() => {
    const token = localStorage.getItem("waves_admin_token");
    if (!token) {
      navigate(adminLoginUrl(location), { replace: true });
      return undefined;
    }
    // The field workspace (/admin/today) must open with no signal, so only
    // there is the check bounded and allowed to fall back to the offline pass
    // a previous successful check left for THIS token. Every other admin
    // page keeps the plain check and its error state.
    const field = isFieldPath(location.pathname);
    let cancelled = false;
    const abort = field && typeof AbortController === "function" ? new AbortController() : null;
    const timer = abort ? setTimeout(() => abort.abort(), AUTH_CHECK_TIMEOUT_MS) : null;
    // Only a failure to REACH the server (or to read a 2xx body) may open from
    // the offline pass: adminFetch throws those with no HTTP status. A server
    // answer of any kind carries a status (or is a profile we reject below).
    // On the field path the 401 is handled below, after the token check, so
    // an old login's late 401 never sends a newer login (another tab) to the
    // sign-in page (pre-push P1).
    const verify = adminFetch("/admin/auth/me", abort ? { signal: abort.signal, redirectOn401: false } : {});
    verify
      .then((profile) => {
        if (cancelled) return;
        if (getAdminAuthToken() !== token) { setVerifyRun((n) => n + 1); return; }
        if (!profile) {
          setAuthStatus("error");
          return;
        }
        if (profile.mustChangePassword) {
          localStorage.removeItem("waves_admin_token");
          localStorage.removeItem("waves_admin_user");
          clearStaffDeviceData();
          refetchFlags().catch(() => {});
          navigate("/admin/forgot-password", {
            replace: true,
            state: { email: profile.email, resetRequired: true },
          });
          return;
        }
        setUser(profile);
        setOfflineReady(false);
        setAuthStatus("ready");
        // A failed cache write must not leave a stale copy behind.
        try {
          localStorage.setItem("waves_admin_user", JSON.stringify(profile));
        } catch {
          try { localStorage.removeItem("waves_admin_user"); } catch { /* storage unavailable */ }
        }
        // Every verified check refreshes the pass, so a later offline reopen
        // of the field workspace has one.
        saveStaffOfflinePass(token, profile);
      })
      .catch((err) => {
        if (cancelled) return;
        if (getAdminAuthToken() !== token) { setVerifyRun((n) => n + 1); return; }
        if (err?.status === 401) {
          localStorage.removeItem("waves_admin_token");
          localStorage.removeItem("waves_admin_user");
          clearStaffDeviceData();
          refetchFlags().catch(() => {});
          navigate(adminLoginUrl(location), { replace: true });
          return;
        }
        // Judged on the path NOW: navigating off Today while the check was
        // pending must not open another admin page from the pass.
        const onField = field && isFieldPath(locationRef.current.pathname);
        const stored = onField && err?.status === undefined ? loadStaffOfflinePass(token) : null;
        if (stored) {
          setUser(stored);
          setOfflineReady(true);
          setAuthStatus("ready");
          return;
        }
        setAuthStatus("error");
      })
      .finally(() => { if (timer) clearTimeout(timer); });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [navigate, verifyRun]);

  // The whole shell (it stays mounted across admin pages, so a switch made
  // while on another page must not reach Today later; pre-push P1): another
  // tab signing in or out changes the stored token under this shell. Drop the identity verified for the old token at
  // once (the outlet unmounts while "checking") and verify the new one.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== null && event.key !== "waves_admin_token") return;
      setUser(null);
      setAuthStatus(getAdminAuthToken() ? "checking" : "error");
      setVerifyRun((n) => n + 1);
      refetchFlags().catch(() => {});
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Entering Today after a failed or still-pending check elsewhere (no
  // signal on another page) re-runs it as the bounded field check, so the
  // workspace can still open from its pass (Codex #5573 r9).
  const onFieldNow = isFieldPath(location.pathname);
  useEffect(() => {
    // A still-pending non-field check has no time bound: restart it as the
    // field check too (pre-push P1).
    if (!onFieldNow || authStatus === "ready") return;
    setAuthStatus("checking");
    setVerifyRun((n) => n + 1);
  }, [onFieldNow]);

  useEffect(() => {
    if (!offlineReady || isFieldPath(location.pathname)) return;
    setOfflineReady(false);
    setUser(null);
    setAuthStatus("checking");
    setVerifyRun((n) => n + 1);
  }, [offlineReady, location.pathname]);

  // Field workspace only: a 401 from ANY staff API call for the current token
  // ends the session here (token, stored profile and saved route go), so an
  // offline reopen cannot unlock from a session the server already refused.
  const onFieldPath = isFieldPath(location.pathname);
  useEffect(() => {
    if (!onFieldPath) return undefined;
    return installStaffSessionGuard({
      getToken: getAdminAuthToken,
      onRejected: () => {
        localStorage.removeItem("waves_admin_token");
        localStorage.removeItem("adminToken");
        localStorage.removeItem("waves_admin_user");
        clearStaffDeviceData();
        setUser(null);
        setAuthStatus("checking");
        refetchFlags().catch(() => {});
        navigate(adminLoginUrl(locationRef.current), { replace: true });
      },
    });
  }, [navigate, onFieldPath]);

  // Role scoping on deep links: the sidebar/More page hide adminOnly
  // destinations from non-admin roles, but a typed URL bypasses nav.
  // Redirect off owner-only paths using the SERVER-returned role (`user`
  // comes from /admin/auth/me — never the spoofable localStorage copy).
  // UX scoping only: the API's requireAdmin middleware is the boundary.
  useEffect(() => {
    if (!user || user.role === "admin") return;
    if (isPathAdminOnly(location.pathname)) {
      // Today, not dashboard: admin-dashboard.js is requireAdmin, so the
      // dashboard would land a technician on a page of 403s (codex P1).
      // /admin/today is the technician's home inside Waves Admin.
      navigate("/admin/today", { replace: true });
    }
  }, [user, location.pathname, navigate]);

  // Auto-close sidebar on route change (mobile) + when viewport grows to desktop.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [location.pathname, location.search, location.hash, isMobile]);

  // .admin-main is the scroll container (the window never scrolls in this
  // shell), so the browser's scroll restoration can't reach it. Snap to the
  // top on navigation so pages don't open at the previous page's scroll
  // position. "instant" opts out of the shell's smooth scroll-behavior —
  // animating across a route change is disorienting.
  const mainRef = useRef(null);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [location.pathname]);

  // First-party usage beacon (Settings → Portal Usage). Fire-and-forget,
  // dedup'd inside the lib; PostHog is banned from /admin so this is the
  // only record of which admin surfaces get used. Waits for auth so an
  // expired session can't spray 401s.
  useEffect(() => {
    if (!sessionReady) return;
    trackAdminPageView({ pathname: location.pathname, search: location.search });
  }, [sessionReady, location.pathname, location.search]);

  const handleLogout = () => {
    if (fieldBusy) return;
    // Sign-out navigates by calling navigate() from a plain button — no
    // popstate, no <a href> click — so it reaches neither CustomersPageV2's
    // own guardLink/guardHistory nor any other page's in-app draft guard.
    // Ask the shared registry (client/src/lib/navigation-guard.js) first.
    if (!confirmLeaveIfGuarded()) return;
    clearEmailDrafts();
    clearScheduleSaveNotices();
    localStorage.removeItem("waves_admin_token");
    localStorage.removeItem("waves_admin_user");
    clearStaffDeviceData();
    refetchFlags().catch(() => {});
    navigate("/admin/login", { replace: true });
  };

  const closeSidebarForPalette = useCallback(() => {
    // The assistant must capture an opener that survives the hidden drawer.
    if (isMobile && sidebarOpen) menuTriggerRef.current?.focus({ preventScroll: true });
    setSidebarOpen(false);
  }, [isMobile, sidebarOpen]);
  // The page-data provider takes this opener as a context value, so it has to
  // be stable across renders that change neither the drawer nor the viewport.
  const openPalette = useCallback(() => { if (fieldBusy) return; closeSidebarForPalette(); paletteRef.current?.open(); },
    [closeSidebarForPalette, fieldBusy]);
  const openPageFinder = useCallback(() => { if (fieldBusy) return; paletteRef.current?.openNavigation(); }, [fieldBusy]);

  const sidebarVisible = !isMobile || sidebarOpen;
  // On a phone the field workspace (/admin/today) supplies its own header and
  // bottom nav, so the admin shell's mobile top bar and tab bar step aside.
  // Only while the field workspace actually renders: with the
  // tech-field-workspace flag off, /admin/today shows the legacy route UI,
  // which has no navigation of its own, so the admin chrome must stay.
  // Re-read per verified account: an account switch in another tab refetches
  // flags, and the chrome must follow the new login's value (pre-push P1).
  const fieldWorkspaceFlag = useFeatureFlagReady("tech-field-workspace", false, user?.id ?? null);
  const fieldChrome = isMobile && fieldWorkspaceFlag.enabled && isFieldPath(location.pathname);
  // The redirect effect runs after render. Apply its existing role policy to
  // the outlet too, so a restricted child's effects cannot run for one frame.
  // An offline-pass session is ready for the field workspace only: off Today
  // it is not ready in this very render, before the re-verify effect runs, so
  // no other admin page mounts on it for a frame (pre-push P1).
  const canRenderRoute = sessionReady
    && (user?.role === "admin" || !isPathAdminOnly(location.pathname));

  return (
    <IntelligenceBarPageDataProvider open={openPalette}>
    <AdminNavigationProvider key={user?.id || 'unverified'} user={user} enabled={navigationEnabled && sessionReady} agentEstimateEnabled={agentEstimateEnabled}>
    <div
      className="admin-shell-v2"
      style={{
        display: "flex",
        height: "var(--admin-vh, 100vh)",
        minHeight: "var(--admin-vh, 100vh)",
        overflow: "hidden",
        boxSizing: "border-box",
        background: "var(--surface-page)",
        color: "var(--text-primary)",
      }}
    >
      <a href="#admin-main" className="admin-skip-link">Skip to content</a>
      {/* Mobile top bar — only visible below breakpoint */}
      {isMobile && !fieldChrome && (
        <div
          style={{
            position: "fixed",
            top: "var(--vv-offset-top, 0px)",
            left: 0,
            right: 0,
            height: "calc(52px + env(safe-area-inset-top))",
            background: "var(--surface-primary)",
            borderBottom: "1px solid var(--border-default)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            paddingTop: "env(safe-area-inset-top)",
            paddingLeft: "max(8px, env(safe-area-inset-left))",
            paddingRight: "max(8px, env(safe-area-inset-right))",
            zIndex: 90,
          }}
        >
          <button
            type="button"
            ref={menuTriggerRef}
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
            aria-expanded={sidebarOpen}
            aria-controls="admin-sidebar"
            style={{
              background: "none",
              border: "none",
              color: "var(--text-primary)",
              width: 44,
              height: 44,
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <Menu size={22} strokeWidth={1.75} />
          </button>
          <img src="/waves-logo.png" alt="Waves" style={{ height: 24 }} />
          <div style={{ flex: 1 }} />
          {navigationEnabled && <Button density="comfortable" variant="ghost" onClick={openPageFinder} aria-label="Search pages" className="!px-3"><Search size={20} aria-hidden /></Button>}
          <button
            type="button"
            onClick={openPalette}
            aria-label={navigationEnabled ? "Ask Waves" : "Open Intelligence Bar"}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-primary)",
              width: 44,
              height: 44,
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <Sparkles size={20} strokeWidth={1.75} />
          </button>
          {/* Bell renders for every role — the feed itself is role-scoped
              server-side (fail-closed techVisible allowlist, #3499), so a
              technician sees only their day-to-day triggers. */}
          <NotificationBell type="admin" />
        </div>
      )}

      {/* Backdrop — only when mobile sidebar is open */}
      {isMobile && sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            zIndex: 99,
          }}
        />
      )}

      {/* Sidebar */}
      <aside
        id="admin-sidebar"
        onClickCapture={holdWhileFieldBusy}
        aria-busy={fieldBusy || undefined}
        ref={drawerRef}
        role={isMobile && sidebarOpen ? "dialog" : undefined}
        aria-modal={isMobile && sidebarOpen ? true : undefined}
        aria-label={isMobile && sidebarOpen ? "Admin menu" : undefined}
        // When mobile + closed the sidebar is translated offscreen but still
        // rendered; `inert` pulls it (and its links) out of the tab order and
        // AT tree so a keyboard user can't Tab into the invisible menu.
        {...(!sidebarVisible ? { inert: "" } : {})}
        style={{
          width: navigationEnabled ? 240 : 220,
          background: "var(--surface-primary)",
          borderRight: "1px solid var(--border-default)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          position: "fixed",
          left: 0,
          top: isMobile ? "var(--vv-offset-top, 0px)" : 0,
          bottom: isMobile ? "var(--keyboard-inset, 0px)" : 0,
          paddingTop: isMobile ? "env(safe-area-inset-top, 0px)" : undefined,
          paddingLeft: isMobile ? "env(safe-area-inset-left, 0px)" : undefined,
          paddingBottom: isMobile
            ? "env(safe-area-inset-bottom, 0px)"
            : undefined,
          zIndex: 100,
          overflowY: navigationEnabled ? "hidden" : "auto",
          transform: sidebarVisible ? "translateX(0)" : "translateX(-100%)",
          transition: "transform 0.2s ease",
          boxShadow:
            isMobile && sidebarOpen ? "2px 0 16px rgba(0,0,0,0.12)" : "none",
        }}
      >
        {navigationEnabled ? <AdminWorkspaceNavigation user={user} isMobile={isMobile} onClose={() => setSidebarOpen(false)} onAsk={openPalette} onSearch={openPageFinder} onLogout={handleLogout} unreadCount={unreadConversations} /> : <>
        {/* Logo + title + notification bell */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "16px 14px 12px",
            borderBottom: "1px solid var(--border-subtle)",
            flexShrink: 0,
          }}
        >
          <img src="/waves-logo.png" alt="Waves" style={{ height: 28 }} />
          <div style={{ flex: 1 }} />
          {isMobile ? (
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close menu"
              style={{
                background: "none",
                border: "none",
                color: "var(--text-secondary)",
                width: 44,
                height: 44,
                borderRadius: 6,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
              }}
            >
              <X size={20} strokeWidth={1.75} />
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={openPalette}
                aria-label="Open Intelligence Bar"
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-primary)",
                  width: 36,
                  height: 36,
                  borderRadius: 6,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                }}
              >
                <Sparkles size={18} strokeWidth={1.75} />
              </button>
              <NotificationBell type="admin" />
            </>
          )}
        </div>

        {/* Search trigger → opens ⌘K palette */}
        <button
          type="button"
          onClick={openPalette}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            margin: "10px 12px",
            padding: isMobile ? "0 12px" : "0 10px",
            minHeight: isMobile ? 44 : 36,
            boxSizing: "border-box",
            borderRadius: 4,
            border: "1px solid var(--border-default)",
            background: "var(--surface-hover)",
            color: "var(--text-tertiary)",
            fontSize: isMobile ? 14 : 13,
            cursor: "pointer",
            textAlign: "left",
          }}
          aria-label="Open search"
        >
          <Search size={isMobile ? 16 : 14} strokeWidth={2} aria-hidden />
          <span style={{ flex: 1 }}>Search…</span>
          <kbd
            style={{
              fontFamily: "inherit",
              fontSize: 11,
              padding: "2px 6px",
              borderRadius: 4,
              background: "var(--kbd-bg)",
              border: "1px solid var(--kbd-border)",
              color: "var(--kbd-fg)",
            }}
          >
            ⌘K
          </kbd>
        </button>

        {/* Nav sections */}
        <nav
          aria-label="Admin sections"
          style={{ flex: 1, padding: "4px 8px 12px" }}
        >
          {ADMIN_DESKTOP_NAV_SECTIONS.map(({ section, items }) => {
            const visibleItems = items
              .filter((item) => !item.adminOnly || user?.role === "admin")
              .filter((item) => !item.flag || (item.flag === "agent_estimate" && agentEstimateEnabled));
            // Role/flag filtering can empty a whole section (e.g. Marketing
            // for a technician) — an orphaned heading reads as a bug.
            if (visibleItems.length === 0) return null;
            const headingId = `admin-nav-${section
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")}`;
            return (
            <div
              key={section}
              role="group"
              aria-labelledby={headingId}
              style={{ marginBottom: 10 }}
            >
              <h2
                id={headingId}
                style={{
                  fontSize: 12,
                  lineHeight: 1.4,
                  fontWeight: 500,
                  color: "var(--text-secondary)",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  padding: "12px 12px 4px",
                  margin: 0,
                  userSelect: "none",
                }}
              >
                {section}
              </h2>
              {visibleItems.map((item) => {
                const { path, icon: Icon, label } = item;
                const isActive = isAdminNavItemActive(
                  item,
                  location.pathname,
                  location.search,
                );
                return (
                  <Link
                    key={path}
                    to={path}
                    aria-current={isActive ? "page" : undefined}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                      // A true no-op re-tap (already exactly at this URL, no
                      // query to strip) triggers no route change, so no
                      // beacon consumes the mark — don't leave a stale one
                      // for the next unmarked navigation to inherit.
                      if (`${location.pathname}${location.search}` !== path) {
                        markUsageSource("sidebar");
                      }
                      if (location.pathname === path || location.pathname.startsWith(path + "/")) {
                        e.preventDefault();
                        navigate(path);
                      }
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "0 12px",
                      minHeight: isMobile ? 44 : 36,
                      boxSizing: "border-box",
                      borderRadius: 6,
                      marginBottom: 1,
                      background: isActive
                        ? "var(--surface-active)"
                        : "transparent",
                      color: isActive
                        ? "var(--text-primary)"
                        : "var(--text-secondary)",
                      fontSize: isMobile ? 14 : 14,
                      fontWeight: isActive ? 600 : 500,
                      textDecoration: "none",
                      transition: "background 0.1s ease",
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive)
                        e.currentTarget.style.background =
                          "var(--surface-hover)";
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive)
                        e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <Icon size={18} strokeWidth={1.75} aria-hidden />
                    <span style={{ flex: 1 }}>
                      {label}
                      {item.id === "communications" ? <UnreadSrText count={unreadConversations} /> : null}
                    </span>
                    {item.id === "communications" ? (
                      <UnreadBadge count={unreadConversations} />
                    ) : null}
                  </Link>
                );
              })}
            </div>
            );
          })}
        </nav>

        {/* User chip footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 12px",
            borderTop: "1px solid var(--border-subtle)",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: "50%",
              background: "var(--surface-active)",
              color: "var(--text-primary)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              fontWeight: 500,
              flexShrink: 0,
            }}
          >
            {initialsFor(user?.name)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: "var(--text-primary)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {user?.name || "Staff"}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
              {roleLabel(user?.role)}
            </div>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            aria-label="Sign out"
            style={{
              background: "none",
              border: "none",
              color: "var(--text-tertiary)",
              cursor: "pointer",
              padding: isMobile ? 0 : 6,
              width: isMobile ? 44 : undefined,
              height: isMobile ? 44 : undefined,
              minWidth: isMobile ? 44 : undefined,
              borderRadius: isMobile ? 6 : 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--surface-hover)";
              e.currentTarget.style.color = "var(--text-primary)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "none";
              e.currentTarget.style.color = "var(--text-tertiary)";
            }}
          >
            <LogOut size={15} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
        </>}
      </aside>

      {/* Main content */}
      <main id="admin-main" tabIndex={-1}
        style={{
          flex: 1,
          minWidth: 0,
          maxWidth: "100%",
          marginLeft: isMobile ? 0 : navigationEnabled ? 240 : 220,
          paddingTop: fieldChrome ? 0 : isMobile
            ? "calc(52px + env(safe-area-inset-top) + 16px)"
            : 24,
          paddingBottom: fieldChrome ? 0 : isMobile
            ? "calc(56px + env(safe-area-inset-bottom) + 16px)"
            : 24,
          paddingLeft: fieldChrome ? 0 : isMobile ? 16 : 28,
          paddingRight: fieldChrome ? 0 : isMobile ? 16 : 28,
          height: "var(--admin-vh, 100vh)",
          minHeight: "var(--admin-vh, 100vh)",
          boxSizing: "border-box",
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          background: "var(--surface-page)",
        }}
        className="admin-main"
        ref={mainRef}
      >
        {canRenderRoute ? (
          <><Outlet context={{ user }} /><ScheduleSaveNotice /></>
        ) : (
          <div role={authStatus === "error" ? "alert" : "status"}>
            {authStatus === "error"
              ? "Unable to verify staff access. Refresh to try again."
              : "Verifying staff access…"}
          </div>
        )}
      </main>

      {/* Mobile bottom tab bar */}
      {isMobile && !fieldChrome && (
        <nav
          aria-label="Primary"
          className="admin-mobile-tabbar"
          onClickCapture={holdWhileFieldBusy}
          aria-busy={fieldBusy || undefined}
          style={{
            position: "fixed",
            bottom: "var(--keyboard-inset, 0px)",
            left: 0,
            right: 0,
            background: "var(--surface-primary)",
            borderTop: "1px solid var(--border-default)",
            paddingBottom: "env(safe-area-inset-bottom)",
            zIndex: 95,
          }}
        >
          <div style={{ display: "flex", alignItems: "stretch", height: 56 }}>
            {ADMIN_MOBILE_TABS.filter(
              (item) => (!item.adminOnly || user?.role === "admin")
                && (!item.technicianTab || user?.role === "technician"),
            ).map((item) => {
              const { path, icon: Icon, label } = item;
              const active = isAdminNavItemActive(
                item,
                location.pathname,
                location.search,
              );
              return (
                <Link
                  key={path}
                  to={path}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    // Same stale-mark guard as the sidebar: a no-op re-tap
                    // fires no route change and must not leave a mark.
                    if (`${location.pathname}${location.search}` !== path) {
                      markUsageSource("tabbar");
                    }
                    if (location.pathname === path || location.pathname.startsWith(path + "/")) {
                      e.preventDefault();
                      navigate(path);
                    }
                  }}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex-1 flex flex-col items-center justify-center gap-[3px] select-none no-underline",
                  )}
                  style={{
                    color: active
                      ? "var(--text-primary)"
                      : "var(--text-tertiary)",
                    minHeight: 44,
                  }}
                >
                  <span style={{ position: "relative", display: "inline-flex" }}>
                    <Icon
                      size={22}
                      strokeWidth={active ? 2.25 : 1.75}
                      aria-hidden
                    />
                    {item.id === "communications" ? (
                      <UnreadBadge
                        count={unreadConversations}
                        style={{ ...(navigationEnabled ? { fontSize: 14, minWidth: 22, height: 22, borderRadius: 11 } : {}), position: "absolute", top: -6, right: -12 }}
                      />
                    ) : null}
                  </span>
                  <span
                    style={{
                      fontSize: navigationEnabled ? 14 : 12,
                      lineHeight: 1.1,
                      letterSpacing: "0.02em",
                      fontWeight: 500,
                    }}
                  >
                    {label}
                    {item.id === "communications" ? <UnreadSrText count={unreadConversations} /> : null}
                  </span>
                </Link>
              );
            })}
          </div>
        </nav>
      )}

      {/* Global ⌘K palette */}
      <GlobalCommandPalette ref={paletteRef} user={user} onNavigate={closeSidebarForPalette} />
    </div>
    </AdminNavigationProvider>
    </IntelligenceBarPageDataProvider>
  );
}
