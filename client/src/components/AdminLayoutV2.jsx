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
import { useState, useEffect, useRef } from "react";
import { Outlet, useNavigate, useLocation, Link } from "react-router-dom";
import { consumeSnapshotOnMount } from "../lib/tapToPayReturn";
import { cn } from "./ui/cn";
import {
  Search,
  LogOut,
  Menu,
  X,
  Sparkles,
} from "lucide-react";
import useIsMobile from "../hooks/useIsMobile";
import { refetchFlags } from "../hooks/useFeatureFlag";
import { adminFetch } from "../utils/admin-fetch";
import {
  ADMIN_DESKTOP_NAV_SECTIONS,
  ADMIN_MOBILE_TABS,
  isAdminNavItemActive,
} from "../config/adminNavigation";
import NotificationBell from "./NotificationBell";
import GlobalCommandPalette from "./admin/GlobalCommandPalette";

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

export default function AdminLayoutV2() {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const [user, setUser] = useState(null);
  const [authStatus, setAuthStatus] = useState("checking");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Restore route if we just returned from WavesPay (iOS often evicts the
  // tab during the hand-off, reloading the app to its default route).
  // See lib/tapToPayReturn.js.
  useEffect(() => {
    consumeSnapshotOnMount(navigate);
    // Mount-only by design (react-hooks/exhaustive-deps isn't configured in
    // the errors-only lint config — a disable directive for it is itself an
    // unknown-rule error).
  }, []);
  const paletteRef = useRef(null);

  useEffect(() => {
    const token = localStorage.getItem("waves_admin_token");
    if (!token) {
      navigate("/admin/login", { replace: true });
      return;
    }
    adminFetch("/admin/auth/me")
      .then((profile) => {
        if (!profile) {
          setAuthStatus("error");
          return;
        }
        if (profile.mustChangePassword) {
          localStorage.removeItem("waves_admin_token");
          localStorage.removeItem("waves_admin_user");
          refetchFlags().catch(() => {});
          navigate("/admin/forgot-password", {
            replace: true,
            state: { email: profile.email, resetRequired: true },
          });
          return;
        }
        setUser(profile);
        setAuthStatus("ready");
        localStorage.setItem("waves_admin_user", JSON.stringify(profile));
      })
      .catch((err) => {
        if (err?.status === 401) {
          localStorage.removeItem("waves_admin_token");
          localStorage.removeItem("waves_admin_user");
          refetchFlags().catch(() => {});
          navigate("/admin/login", { replace: true });
          return;
        }
        setAuthStatus("error");
      });
  }, [navigate]);

  // Auto-close sidebar on route change (mobile) + when viewport grows to desktop.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [location.pathname, isMobile]);

  // .admin-main is the scroll container (the window never scrolls in this
  // shell), so the browser's scroll restoration can't reach it. Snap to the
  // top on navigation so pages don't open at the previous page's scroll
  // position. "instant" opts out of the shell's smooth scroll-behavior —
  // animating across a route change is disorienting.
  const mainRef = useRef(null);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [location.pathname]);

  const handleLogout = () => {
    localStorage.removeItem("waves_admin_token");
    localStorage.removeItem("waves_admin_user");
    refetchFlags().catch(() => {});
    navigate("/admin/login", { replace: true });
  };

  const openPalette = () => paletteRef.current?.open();

  const sidebarVisible = !isMobile || sidebarOpen;

  return (
    <div
      className="admin-shell-v2"
      style={{
        display: "flex",
        height: "100vh",
        minHeight: "100vh",
        overflow: "hidden",
        boxSizing: "border-box",
        background: "var(--surface-page)",
        color: "var(--text-primary)",
      }}
    >
      {/* Mobile top bar — only visible below breakpoint */}
      {isMobile && (
        <div
          style={{
            position: "fixed",
            top: 0,
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
          <button
            type="button"
            onClick={openPalette}
            aria-label="Open Intelligence Bar"
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
        style={{
          width: 220,
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
          overflowY: "auto",
          transform: sidebarVisible ? "translateX(0)" : "translateX(-100%)",
          transition: "transform 0.2s ease",
          boxShadow:
            isMobile && sidebarOpen ? "2px 0 16px rgba(0,0,0,0.12)" : "none",
        }}
      >
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
            padding: isMobile ? "12px 12px" : "8px 10px",
            minHeight: isMobile ? 44 : undefined,
            borderRadius: 8,
            border: "1px solid var(--border-default)",
            background: "var(--surface-hover)",
            color: "var(--text-tertiary)",
            fontSize: isMobile ? 14 : 13,
            cursor: "pointer",
            textAlign: "left",
          }}
          aria-label="Open search"
        >
          <Search size={isMobile ? 16 : 14} strokeWidth={2} />
          <span style={{ flex: 1 }}>Search…</span>
          <kbd
            style={{
              fontFamily: "'Roboto', Arial, sans-serif",
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
                  // Title-case section headers, weight 600 — heavier and
                  // closer to body copy than the prior all-caps tracked
                  // label, so the groupings read as section names rather
                  // than utility labels.
                  fontSize: 15,
                  fontWeight: 600,
                  color: "var(--text-primary)",
                  textTransform: "none",
                  letterSpacing: 0,
                  padding: "14px 12px 6px",
                  margin: 0,
                  userSelect: "none",
                }}
              >
                {section}
              </h2>
              {items.map((item) => {
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
                      if (location.pathname === path || location.pathname.startsWith(path + "/")) {
                        e.preventDefault();
                        navigate(path);
                      }
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: isMobile ? "10px 12px" : "8px 12px",
                      minHeight: isMobile ? 44 : undefined,
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
                    <span>{label}</span>
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
            <LogOut size={15} strokeWidth={1.75} />
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          maxWidth: "100%",
          marginLeft: isMobile ? 0 : 220,
          paddingTop: isMobile
            ? "calc(52px + env(safe-area-inset-top) + 16px)"
            : 24,
          paddingBottom: isMobile
            ? "calc(56px + env(safe-area-inset-bottom) + 16px)"
            : 24,
          paddingLeft: isMobile ? 16 : 28,
          paddingRight: isMobile ? 16 : 28,
          height: "100vh",
          minHeight: "100vh",
          boxSizing: "border-box",
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          background: "var(--surface-page)",
        }}
        className="admin-main"
        ref={mainRef}
      >
        {authStatus === "ready" ? (
          <Outlet context={{ user }} />
        ) : (
          <div role={authStatus === "error" ? "alert" : "status"}>
            {authStatus === "error"
              ? "Unable to verify staff access. Refresh to try again."
              : "Verifying staff access…"}
          </div>
        )}
      </div>

      {/* Mobile bottom tab bar */}
      {isMobile && (
        <nav
          aria-label="Primary"
          style={{
            position: "fixed",
            bottom: 0,
            left: 0,
            right: 0,
            background: "var(--surface-primary)",
            borderTop: "1px solid var(--border-default)",
            paddingBottom: "env(safe-area-inset-bottom)",
            zIndex: 95,
          }}
        >
          <div style={{ display: "flex", alignItems: "stretch", height: 56 }}>
            {ADMIN_MOBILE_TABS.map((item) => {
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
                  <Icon
                    size={22}
                    strokeWidth={active ? 2.25 : 1.75}
                    aria-hidden
                  />
                  <span
                    style={{
                      fontSize: 10,
                      lineHeight: 1,
                      letterSpacing: "0.08em",
                      fontWeight: 500,
                      textTransform: "uppercase",
                    }}
                  >
                    {label}
                  </span>
                </Link>
              );
            })}
          </div>
        </nav>
      )}

      {/* Global ⌘K palette */}
      <GlobalCommandPalette ref={paletteRef} />
    </div>
  );
}
