import { clearStaffDeviceData } from "../../lib/adminAuth";
import { Link, Navigate, useNavigate, useOutletContext } from "react-router-dom";
import {
  LogOut,
  Settings,
  SlidersHorizontal,
  ExternalLink,
  ChevronRight,
  User,
} from "lucide-react";
import { refetchFlags } from "../../hooks/useFeatureFlag";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import useIsMobile from "../../hooks/useIsMobile";
import { markUsageSource } from "../../lib/adminUsage";
import { ADMIN_MOBILE_MORE_SECTIONS, ADMIN_MOBILE_TABS, getAdminMobileTabs } from "../../config/adminNavigation";
import { MOBILE_SETTINGS_SECTIONS } from "../../config/mobileSettingsSections";
import { clearEmailDrafts } from "../../lib/emailDrafts";
import { clearScheduleSaveNotices } from "../../components/schedule/ScheduleSaveNotice";
import { UiSurface } from "../../components/ui";
import { PinnedWorkspaceLinks, WorkspaceGroup, WorkspaceLink } from "../../components/admin/AdminWorkspaceNavigation";
import useAdminNavigation from "../../hooks/useAdminNavigation";
import { releaseInAppPush } from "../../native/wavesAdminPush";

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
  const navigation = useAdminNavigation();

  if (!isMobile) return <Navigate to="/admin" replace />;

  const handleLogout = () => {
    // Waves Admin: this iPhone stops getting staff alerts (needs the token).
    void releaseInAppPush();
    clearEmailDrafts();
    clearScheduleSaveNotices();
    localStorage.removeItem("waves_admin_token");
    localStorage.removeItem("waves_admin_user");
    clearStaffDeviceData();
    refetchFlags();
    navigate("/admin/login", { replace: true });
  };

  const workspaceSettings = navigation?.groups.find(({ id }) => id === 'settings')?.items
    .filter(({ id }) => id !== 'settings').map(({ id, label, path, adminOnly }) => ({ key: id, label, to: path, adminOnly })) || [];
  const visibleSettingsLeaves = [...workspaceSettings, ...SETTINGS_LEAVES].filter(
    (sec) => currentRole === "admin" || !sec.adminOnly,
  );
  // On a phone this page is the one full menu (owner 2026-10-29). A page that
  // is one of THIS login's bottom tabs is not listed again (an owner has no
  // Today tab, so Today is listed). A group whose main page is a tab
  // (Schedule, Customers) shows its other pages as plain rows, so no row
  // repeats a tab's name.
  const tabIds = new Set(getAdminMobileTabs(currentRole).map(({ id }) => id));
  const mobileWorkspaces = navigation?.groups.filter(({ id }) => id !== 'settings').map((group) => {
    const items = group.items.filter(({ id }) => !tabIds.has(id));
    const flat = Boolean(group.target && tabIds.has(group.target.id));
    return { ...group, items, flat, target: items.includes(group.target) ? group.target : undefined };
  }).filter(({ items }) => items.length);

  return (
    <div className="md:hidden pb-4">
      {/* No extra padding wrapper: the shell already pads the page 16px, so
          a px-4/pt-4 here inset the header card 32px — visibly narrower than
          the full-bleed lists beneath it. */}
      <AdminCommandHeader title="Settings" icon={Settings} sticky={false} variant="workspace" />
      {navigation && <UiSurface className="space-y-1 border-y border-zinc-200 py-3" density="comfortable">
        <PinnedWorkspaceLinks source="more" />
        <h2 className="m-0 px-4 py-2 text-14 font-medium text-zinc-500">Workspaces</h2>
        {mobileWorkspaces.map((group) => (group.flat ? group.items.map((item) => {
          const Icon = item.icon;
          return <WorkspaceLink key={item.id} item={item} source="more" active={navigation.selection.itemId === item.id}>
            <Icon size={18} strokeWidth={1.75} className="shrink-0" aria-hidden /><span className="min-w-0 flex-1">{item.label}</span>
          </WorkspaceLink>;
        }) : <WorkspaceGroup key={group.id} group={group} source="more" />))}
      </UiSurface>}
      {visibleSettingsLeaves.length > 0 && (
        <section className="mt-2">
          {" "}
          <div className="px-4 py-2 text-14 font-medium text-zinc-500">
            Preferences
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
          {/* The phone has no side menu, so the signed-in account shows here. */}
          {outletContext?.user?.name && <li className="flex items-center gap-3 px-4 h-14 text-14 text-zinc-600">
            <User size={20} strokeWidth={1.75} className="shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">Signed in as <span className="font-medium text-zinc-900">{outletContext.user.name}</span></span>
            <span>{currentRole === "admin" ? "Admin" : "Technician"}</span>
          </li>}
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
              className="w-full flex items-center gap-3 px-4 h-14 active:bg-zinc-100 text-zinc-600"
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
