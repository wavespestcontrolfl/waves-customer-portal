import { Gavel } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { UiSurface } from "../../components/ui";
import { useFeatureFlagReady } from "../../hooks/useFeatureFlag";
import BidDeskPage from "./BidDeskPage";
import BidKitPage from "./BidKitPage";

// One menu entry, two tabs: Open bids (Bid Desk, GATE_BID_DESK) and Bid kit (GATE_BID_KIT). The tab lives in the URL
// (?tab=kit; no tab = Open bids) so a link or a reload lands on the same view. Each tab shows only while its own flag is on;
// the server sends a flag only while its gate is on, so with neither on the page fails closed.
const TABS = [
  { key: "desk", label: "Open bids", flag: "bid_desk", param: null },
  { key: "kit", label: "Bid kit", flag: "bid_kit", param: "kit" },
];

export default function BidsPage() {
  const [params, setParams] = useSearchParams();
  const desk = useFeatureFlagReady("bid_desk", false);
  const kit = useFeatureFlagReady("bid_kit", false);
  const enabled = { bid_desk: desk.enabled, bid_kit: kit.enabled };
  const visible = TABS.filter((tab) => enabled[tab.flag]);

  if (!desk.ready || !kit.ready) return <UiSurface density="comfortable" className="mx-auto max-w-[1300px]" />;

  if (visible.length === 0) {
    return (
      <UiSurface density="comfortable" className="mx-auto max-w-[1300px]">
        <AdminCommandHeader variant="workspace" title="Bids" icon={Gavel} />
        <div className="px-3 py-8 text-center text-ui-body text-ink-secondary">Bids are not turned on yet.</div>
      </UiSurface>
    );
  }

  const requested = params.get("tab") === "kit" ? "kit" : "desk";
  const active = visible.find((tab) => tab.key === requested) || visible[0];

  const select = (key) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    const tab = TABS.find((entry) => entry.key === key);
    if (tab.param) next.set("tab", tab.param); else next.delete("tab");
    return next;
  }, { replace: true });

  return (
    <UiSurface density="comfortable" className="mx-auto max-w-[1300px]">
      <AdminCommandHeader
        variant="workspace"
        title="Bids"
        icon={Gavel}
        sections={visible.length > 1 ? visible.map(({ key, label }) => ({ key, label })) : []}
        activeKey={active.key}
        onSectionChange={select}
        ariaLabel="Bids view"
        navGridClassName="grid-cols-2"
      />
      {active.key === "kit" ? <BidKitPage embedded /> : <BidDeskPage embedded />}
    </UiSurface>
  );
}
