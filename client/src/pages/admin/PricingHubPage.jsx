import React, { useState } from "react";
import { BarChart3, Calculator, Megaphone } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import PricingLogicPage from "./PricingLogicPage";
import PricingStrategyPage from "./PricingStrategyPage";
import AdminPriceChangePage from "./AdminPriceChangePage";
import useRenderedTabBeacon from "../../hooks/useRenderedTabBeacon";
import { getAdminUser } from "../../lib/adminAuth";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";

import { UiSurface } from "../../components/ui";
import { cn } from "../../components/ui/cn";

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

  // Sub-tabs/actions registered by the embedded area page (null when the
  // active area has none).
  const [secondary, setSecondary] = useState(null);

  // Only Price Notices is migrated, so the comfortable density has to stop at
  // it — the comfortable rule sets font-size and line-height on the surface
  // itself, and letting that cascade would push Tier-1 typography through the
  // unmigrated inline-`D` Logic and Strategy pages. The density flips rather
  // than the element: swapping the wrapper's type would make React unmount and
  // remount this whole subtree, AdminCommandHeader included, on every area
  // switch, since a host element and a component never reconcile. `legacy` is
  // the context default, so those two areas render exactly as they do on main.
  const density = activeArea === "notices" ? "comfortable" : "legacy";

  return (
    <UiSurface density={density}>
      {/* One header card for the whole hub: area tabs on the first row; the
          active area (Logic & Margins) hands its own section tabs up for the
          second row instead of stacking a second header. */}
      {/* Width goes on the header itself (its sticky box must stay a direct
          child of the element that also contains the area content). */}
      <AdminCommandHeader variant="workspace"
          className="max-w-[1300px] mx-auto"
          title="Pricing"
          icon={Calculator}
          sections={visibleAreas}
          activeKey={activeArea}
          onSectionChange={selectArea}
          ariaLabel="Pricing areas"
          // `.ui-workspace-nav` is inline-flex, so the area strip and an area's
          // own section strip sit side by side whenever their combined width
          // fits the 1300px header — collapsing the two hierarchical rows the
          // block-level framed variant used to give. Full-width strips restore
          // the rows without touching the shared header component.
          navGridClassName="w-full grid-cols-1 sm:grid-cols-3"
          actions={secondary?.actions}
          secondarySections={secondary?.sections || []}
          secondaryActiveKey={secondary?.activeKey}
          onSecondaryChange={secondary?.onChange}
          secondaryAriaLabel={secondary?.ariaLabel}
          secondaryNavGridClassName={cn("w-full", secondary?.navGridClassName)}
      />

      {activeArea === "logic" && (
        <PricingLogicPage embedded onSecondaryNav={setSecondary} />
      )}
      {activeArea === "strategy" && (
        <PricingStrategyPage embedded onSecondaryNav={setSecondary} />
      )}
      {activeArea === "notices" && <AdminPriceChangePage embedded />}
    </UiSurface>
  );
}
