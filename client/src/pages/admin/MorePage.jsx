import { Link, Navigate, useNavigate, useOutletContext } from "react-router-dom";
import {
  LogOut,
  Settings,
  SlidersHorizontal,
  ExternalLink,
  ChevronRight,
} from "lucide-react";
import { refetchFlags, useFeatureFlag } from "../../hooks/useFeatureFlag";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import useIsMobile from "../../hooks/useIsMobile";
import { markUsageSource } from "../../lib/adminUsage";
import { ADMIN_MOBILE_MORE_SECTIONS, ADMIN_MOBILE_TABS } from "../../config/adminNavigation";
import { MOBILE_SETTINGS_SECTIONS } from "../../config/mobileSettingsSections";

// The Settings leaves this page lists inline: every entry of the former
// mobile Settings index whose destination is NOT already a nav row or tab
// on this surface (Invoices, Banking, Communications are; the SettingsPage
// ?tab= leaves and the standalone Early-feature-access route are not).
// Derived, not hand-picked, so a destination can't silently vanish from
// mobile (codex P1: the flags route was dropped by a ?tab=-only filter).
const NAV_PATHS = new Set(
  [...ADMIN_MOBILE_TABS, ...ADMIN_MOBILE_MORE_SECTIONS.flatMap(({ items }) => items)]
    .map(({ path }) => path.split("?")[0]),
);
const SETTINGS_LEAVES = MOBILE_SETTINGS_SECTIONS.filter(
  (sec) => !NAV_PATHS.has(sec.to.split("?")[0]) || sec.to.includes("?tab="),
);

export default function MorePage() {
  const navigate = useNavigate();
  // The "More" menu is a mobile-only nav surface (its root is `md:hidden`, so
  // on desktop it rendered a blank page). Desktop uses the full sidebar — send
  // it to the dashboard instead. Reactive: resizing to desktop redirects too.
  const isMobile = useIsMobile();
  // Role comes from the shell's Outlet context — the SERVER-verified
  // /admin/auth/me profile — never the spoofable localStorage copy (codex
  // P1). Missing context fails closed: owner-only items stay hidden.
  const outletContext = useOutletContext();
  const currentRole = outletContext?.user?.role || null;
  const agentEstimateEnabled = useFeatureFlag("agent_estimate", false);

  if (!isMobile) return <Navigate to="/admin" replace />;

  const handleLogout = () => {
    localStorage.removeItem("waves_admin_token");
    localStorage.removeItem("waves_admin_user");
    refetchFlags();
    navigate("/admin/login", { replace: true });
  };

  const visibleSettingsLeaves = SETTINGS_LEAVES.filter(
    (sec) => currentRole === "admin" || !sec.adminOnly,
  );

  return (
    <div className="md:hidden pb-4">
      {/* No extra padding wrapper: the shell already pads the page 16px, so
          a px-4/pt-4 here inset the header card 32px — visibly narrower than
          the full-bleed lists beneath it. */}
      <AdminCommandHeader title="Settings" icon={Settings} sticky={false} />
      {ADMIN_MOBILE_MORE_SECTIONS.map(({ section, items }) => {
        const visibleItems = items
          .filter((item) => !item.adminOnly || currentRole === "admin")
          .filter((item) => !item.flag || (item.flag === "agent_estimate" && agentEstimateEnabled));
        // Role/flag filtering can empty a whole section (e.g. Marketing for
        // a technician) — skip the orphaned heading.
        if (visibleItems.length === 0) return null;
        return (
        <section key={section} className="mt-2">
          {" "}
          <div className="px-4 py-2 text-[10px] font-medium uppercase tracking-label text-zinc-500">
            {section}
          </div>{" "}
          <ul className="list-none pl-0 my-0 bg-white border-y border-hairline border-zinc-200 divide-y divide-zinc-200/70">
            {visibleItems.map(({ path, icon: Icon, label }) => (
              <li key={path}>
                {" "}
                <Link
                  to={path}
                  onClick={(e) => {
                    // Modified clicks open elsewhere and leave this tab in
                    // place — no navigation here consumes the mark.
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    markUsageSource("more");
                  }}
                  className="flex items-center gap-3 px-4 h-14 active:bg-zinc-50 text-zinc-900 no-underline"
                >
                  {" "}
                  <Icon
                    size={20}
                    strokeWidth={1.75}
                    className="text-zinc-600 shrink-0"
                  />{" "}
                  <span className="flex-1 text-14">{label}</span>{" "}
                  <ChevronRight size={16} className="text-zinc-400" />{" "}
                </Link>{" "}
              </li>
            ))}
          </ul>{" "}
        </section>
        );
      })}
      {visibleSettingsLeaves.length > 0 && (
        <section className="mt-2">
          {" "}
          <div className="px-4 py-2 text-[10px] font-medium uppercase tracking-label text-zinc-500">
            Settings
          </div>{" "}
          <ul className="list-none pl-0 my-0 bg-white border-y border-hairline border-zinc-200 divide-y divide-zinc-200/70">
            {visibleSettingsLeaves.map(({ key, to, label }) => (
              <li key={key}>
                {" "}
                <Link
                  to={to}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    markUsageSource("more");
                  }}
                  className="flex items-center gap-3 px-4 h-14 active:bg-zinc-50 text-zinc-900 no-underline"
                >
                  {" "}
                  <SlidersHorizontal
                    size={20}
                    strokeWidth={1.75}
                    className="text-zinc-600 shrink-0"
                  />{" "}
                  <span className="flex-1 text-14">{label}</span>{" "}
                  <ChevronRight size={16} className="text-zinc-400" />{" "}
                </Link>{" "}
              </li>
            ))}
          </ul>{" "}
        </section>
      )}
      <section className="mt-6">
        {" "}
        <ul className="list-none pl-0 my-0 bg-white border-y border-hairline border-zinc-200 divide-y divide-zinc-200/70">
          {" "}
          <li>
            {" "}
            <Link
              to="/"
              className="flex items-center gap-3 px-4 h-14 active:bg-zinc-50 text-zinc-600 no-underline"
            >
              {" "}
              <ExternalLink
                size={20}
                strokeWidth={1.75}
                className="shrink-0"
              />{" "}
              <span className="flex-1 text-14">Customer Portal</span>{" "}
              <ChevronRight size={16} className="text-zinc-400" />{" "}
            </Link>{" "}
          </li>{" "}
          <li>
            {" "}
            <button
              type="button"
              onClick={handleLogout}
              className="w-full flex items-center gap-3 px-4 h-14 active:bg-alert-bg text-alert-fg"
            >
              {" "}
              <LogOut size={20} strokeWidth={1.75} className="shrink-0" />{" "}
              <span className="flex-1 text-14 text-left">Sign Out</span>{" "}
            </button>{" "}
          </li>{" "}
        </ul>{" "}
      </section>{" "}
    </div>
  );
}
