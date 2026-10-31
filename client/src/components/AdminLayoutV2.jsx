import { clearStaffDeviceData } from "../lib/adminAuth";
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
import { useEffect, useRef, useCallback } from "react";
import { Outlet, useNavigate, useLocation, Link } from "react-router-dom";
import { consumeSnapshotOnMount } from "../lib/tapToPayReturn";
import { prepareInAppReader } from "../lib/tapToPay";
import { registerInAppPush } from "../native/wavesAdminPush";
import { cn } from "./ui/cn";
import { Button } from "./ui";
import {
  Search,
  Sparkles,
} from "lucide-react";
import useIsMobile from "../hooks/useIsMobile";
import { refetchFlags, useFeatureFlag } from "../hooks/useFeatureFlag";
import { trackAdminPageView, markUsageSource } from "../lib/adminUsage";
import {
  getAdminMobileTabs,
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
import useStaffSession from "../hooks/useStaffSession";


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

// Main-area padding: desktop, then phone (below the fixed top bar, above the
// fixed tab bar). /admin/today uses the same chrome as every other page.
const MAIN_PADDING = [
  { top: 24, bottom: 24, x: 28 },
  { top: "calc(52px + env(safe-area-inset-top) + 16px)", bottom: "calc(56px + env(safe-area-inset-bottom) + 16px)", x: 16 },
];

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
  // Staff-session state machine (verify, offline pass, cross-tab sign-in,
  // 401 handling): see useStaffSession.
  const { user, userId, authStatus, sessionReady } = useStaffSession();
  // Per verified account, like the field-workspace read below: an account
  // switch in another tab refetches flags (Codex #5573 r8).
  const agentEstimateEnabled = useFeatureFlag("agent_estimate", false, userId);
  // Bid Desk (GATE_BID_DESK): the server only sends this flag while the gate is on.
  const bidDeskEnabled = useFeatureFlag("bid_desk", false, userId);
  // Bid kit (GATE_BID_KIT): the server only sends this flag while the gate is on.
  const bidKitEnabled = useFeatureFlag("bid_kit", false, userId);
  const paletteRef = useRef(null);
  // Global Messages badge: conversations needing a reply. Polled
  // only once staff access is verified (same cadence as the bell). The icon's
  // destination is the inbox, never a particular customer.
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

  // Waves Admin (the iOS staff app): connect the phone's card reader while
  // staff work, so Tap to Pay opens at once, and register the app for staff
  // alerts. Only the roles that /stripe/terminal/connection-token and staff
  // push accept. No-op in a browser.
  useEffect(() => {
    if (!sessionReady || !["admin", "technician"].includes(user?.role)) return undefined;
    const stopReader = prepareInAppReader();
    const stopPush = registerInAppPush();
    return () => {
      stopReader();
      stopPush();
    };
  }, [sessionReady, user?.role]);

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

  // The page-data provider takes this opener as a context value, so it has to
  // be stable across renders.
  const openPalette = useCallback(() => { if (fieldBusy) return; paletteRef.current?.open(); }, [fieldBusy]);
  const openPageFinder = useCallback(() => { if (fieldBusy) return; paletteRef.current?.openNavigation(); }, [fieldBusy]);

  // /admin/today keeps the admin top bar and tab bar on a phone, like every
  // other page (owner 2026-10-05); the navigation hold below covers them.
  const mainPadding = MAIN_PADDING[Number(isMobile)];
  const fieldHold = { onClickCapture: holdWhileFieldBusy, "aria-busy": fieldBusy || undefined };
  // The redirect effect runs after render. Apply its existing role policy to
  // the outlet too, so a restricted child's effects cannot run for one frame.
  // An offline-pass session is ready for the field workspace only: off Today
  // it is not ready in this very render, before the re-verify effect runs, so
  // no other admin page mounts on it for a frame (pre-push P1).
  const canRenderRoute = sessionReady
    && (user?.role === "admin" || !isPathAdminOnly(location.pathname));

  return (
    <IntelligenceBarPageDataProvider open={openPalette}>
    <AdminNavigationProvider key={user?.id || 'unverified'} user={user} enabled={sessionReady} agentEstimateEnabled={agentEstimateEnabled} bidDeskEnabled={bidDeskEnabled} bidKitEnabled={bidKitEnabled}>
    <div
      className="admin-shell-v2"
      style={{
        display: "flex",
        height: "var(--admin-shell-vh, var(--admin-vh, 100vh))",
        minHeight: "var(--admin-shell-vh, var(--admin-vh, 100vh))",
        overflow: "hidden",
        boxSizing: "border-box",
        background: "var(--surface-page)",
        color: "var(--text-primary)",
      }}
    >
      <a href="#admin-main" className="admin-skip-link">Skip to content</a>
      {/* Mobile top bar — only visible below breakpoint */}
      {isMobile && (
        <div
          {...fieldHold}
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
          {/* No menu button: on a phone the Settings tab is the one full menu
              (owner 2026-10-29), so the top bar keeps search, Ask and the bell. */}
          <img src="/waves-logo.png" alt="Waves" style={{ height: 24, marginLeft: 8 }} />
          <div style={{ flex: 1 }} />
          <Button density="comfortable" variant="ghost" onClick={openPageFinder} aria-label="Search pages" className="!px-3"><Search size={20} aria-hidden /></Button>
          <button
            type="button"
            onClick={openPalette}
            aria-label="Ask Waves"
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

      {/* Sidebar: computer only. A phone reaches every page from the bottom
          tabs and the Settings tab, which lists the rest of this menu. */}
      {!isMobile && (
        <aside
          id="admin-sidebar"
          {...fieldHold}
          style={{
            width: 240,
            background: "var(--surface-primary)",
            borderRight: "1px solid var(--border-default)",
            display: "flex",
            flexDirection: "column",
            flexShrink: 0,
            position: "fixed",
            left: 0,
            top: 0,
            bottom: 0,
            zIndex: 100,
            overflowY: "hidden",
          }}
        >
          <AdminWorkspaceNavigation user={user} onAsk={openPalette} onSearch={openPageFinder} onLogout={handleLogout} unreadCount={unreadConversations} />
        </aside>
      )}

      {/* Main content */}
      <main id="admin-main" tabIndex={-1}
        style={{
          flex: 1,
          minWidth: 0,
          maxWidth: "100%",
          marginLeft: isMobile ? 0 : 240,
          paddingTop: mainPadding.top,
          paddingBottom: mainPadding.bottom,
          paddingLeft: mainPadding.x,
          paddingRight: mainPadding.x,
          height: "var(--admin-shell-vh, var(--admin-vh, 100vh))",
          minHeight: "var(--admin-shell-vh, var(--admin-vh, 100vh))",
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
      {isMobile && (
        <nav
          aria-label="Primary"
          className="admin-mobile-tabbar"
          {...fieldHold}
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
            {getAdminMobileTabs(user?.role).map((item) => {
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
                        style={{ fontSize: 14, minWidth: 22, height: 22, borderRadius: 11, position: "absolute", top: -6, right: -12 }}
                      />
                    ) : null}
                  </span>
                  <span
                    style={{
                      fontSize: 14,
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
      <GlobalCommandPalette ref={paletteRef} user={user} />
    </div>
    </AdminNavigationProvider>
    </IntelligenceBarPageDataProvider>
  );
}
