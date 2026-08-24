import React from "react";
import { BarChart3, Calculator, Megaphone } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import PricingLogicPage from "./PricingLogicPage";
import PricingStrategyPage from "./PricingStrategyPage";
import AdminPriceChangePage from "./AdminPriceChangePage";
import useRenderedTabBeacon from "../../hooks/useRenderedTabBeacon";
import { getAdminUser } from "../../lib/adminAuth";

export const PRICING_AREAS = [
  { key: "logic", label: "Logic & Margins", Icon: Calculator },
  // /api/admin/pricing is admin-only (requireAdmin) — hide the area for
  // technicians rather than mounting a page whose every request 403s.
  { key: "strategy", label: "Strategy & Offers", Icon: BarChart3, adminOnly: true },
  { key: "notices", label: "Price Notices", Icon: Megaphone },
];

export default function PricingHubPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const isAdmin = getAdminUser()?.role === "admin";
  const visibleAreas = PRICING_AREAS.filter(({ adminOnly }) => !adminOnly || isAdmin);
  const visibleAreaKeys = new Set(visibleAreas.map(({ key }) => key));
  const requestedArea = searchParams.get("area");
  const activeArea = visibleAreaKeys.has(requestedArea)
    ? requestedArea
    : "logic";

  // Usage beacon for the area that actually RENDERS — an invalid or
  // missing ?area= resolves to Logic & Margins without rewriting the URL
  // (Codex #2961 r17). The Logic area DEFERS (null) to PricingLogicPage,
  // which owns the deeper ?section= leaf and reports it itself — a parent
  // 'logic' beacon here would suppress the raw beacon that used to carry
  // the section (Codex #2961 r18).
  useRenderedTabBeacon(
    "/admin/pricing-logic",
    activeArea === "logic" ? null : activeArea,
    [searchParams],
  );

  const selectArea = (area) => {
    // Re-clicking the active area renders nothing new — skip the URL
    // churn (and the usage beacon it would re-fire).
    if (area === activeArea) return;
    const nextParams = new URLSearchParams(searchParams);
    if (area === "logic") nextParams.delete("area");
    else nextParams.set("area", area);
    setSearchParams(nextParams);
  };

  return (
    <div>
      <nav
        aria-label="Pricing areas"
        className="max-w-[1300px] mx-auto mb-4 grid grid-cols-1 sm:grid-cols-3 gap-1 rounded-md border-hairline border-zinc-200 bg-white p-2"
      >
        {visibleAreas.map(({ key, label, Icon }) => {
          const active = activeArea === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => selectArea(key)}
              aria-current={active ? "page" : undefined}
              className={[
                "h-11 px-3 rounded-sm border-hairline text-12 font-medium uppercase tracking-label",
                "inline-flex items-center justify-center gap-2 u-focus-ring transition-colors",
                active
                  ? "bg-zinc-900 text-white border-zinc-900"
                  : "bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50 hover:text-zinc-900",
              ].join(" ")}
            >
              <Icon size={15} strokeWidth={1.8} aria-hidden />
              {label}
            </button>
          );
        })}
      </nav>

      {activeArea === "logic" && <PricingLogicPage />}
      {activeArea === "strategy" && <PricingStrategyPage />}
      {activeArea === "notices" && <AdminPriceChangePage />}
    </div>
  );
}
