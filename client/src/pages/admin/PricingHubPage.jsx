import React from "react";
import { BarChart3, Calculator, Megaphone } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import PricingLogicPage from "./PricingLogicPage";
import PricingStrategyPage from "./PricingStrategyPage";
import AdminPriceChangePage from "./AdminPriceChangePage";

export const PRICING_AREAS = [
  { key: "logic", label: "Logic & Margins", Icon: Calculator },
  { key: "strategy", label: "Strategy & Offers", Icon: BarChart3 },
  { key: "notices", label: "Price Notices", Icon: Megaphone },
];

const PRICING_AREA_KEYS = new Set(PRICING_AREAS.map(({ key }) => key));

export default function PricingHubPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedArea = searchParams.get("area");
  const activeArea = PRICING_AREA_KEYS.has(requestedArea)
    ? requestedArea
    : "logic";

  const selectArea = (area) => {
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
        {PRICING_AREAS.map(({ key, label, Icon }) => {
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
