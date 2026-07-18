import { Link, useNavigate } from "react-router-dom";
import {
  LogOut,
  ExternalLink,
  ChevronRight,
} from "lucide-react";
import { refetchFlags, useFeatureFlag } from "../../hooks/useFeatureFlag";
import { ADMIN_MOBILE_MORE_SECTIONS } from "../../config/adminNavigation";

export default function MorePage() {
  const navigate = useNavigate();
  let currentRole = null;
  try {
    currentRole = JSON.parse(localStorage.getItem("waves_admin_user") || "null")?.role || null;
  } catch {
    currentRole = null;
  }
  const agentEstimateEnabled = useFeatureFlag("agent_estimate", false);

  const handleLogout = () => {
    localStorage.removeItem("waves_admin_token");
    localStorage.removeItem("waves_admin_user");
    refetchFlags();
    navigate("/admin/login", { replace: true });
  };

  return (
    <div className="md:hidden pb-4">
      {" "}
      <div className="px-4 pt-4 pb-3">
        {" "}
        <h1 className="text-28 font-normal text-zinc-900 tracking-tight">
          More
        </h1>{" "}
        <p className="text-13 text-zinc-500 mt-1">
          Everything beyond the five tabs.
        </p>{" "}
      </div>
      {ADMIN_MOBILE_MORE_SECTIONS.map(({ section, items }) => (
        <section key={section} className="mt-2">
          {" "}
          <div className="px-4 py-2 text-[10px] font-medium uppercase tracking-label text-zinc-500">
            {section}
          </div>{" "}
          <ul className="list-none pl-0 my-0 bg-white border-y border-hairline border-zinc-200 divide-y divide-zinc-200/70">
            {items
              .filter((item) => !item.adminOnly || currentRole === "admin")
              .filter((item) => !item.flag || (item.flag === "agent_estimate" && agentEstimateEnabled))
              .map(({ path, icon: Icon, label }) => (
              <li key={path}>
                {" "}
                <Link
                  to={path}
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
      ))}
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
