import { Gavel } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { UiSurface } from "../../components/ui";
import { useFeatureFlagReady } from "../../hooks/useFeatureFlag";
import BidDeskPage from "./BidDeskPage";
import BidKitPage from "./BidKitPage";

// One menu entry, two tabs: Open bids (Bid Desk, GATE_BID_DESK) and Bid kit. The tab lives in the URL
// (?tab=kit; no tab = Open bids) so a link or a reload lands on the same view. Open bids shows only while the bid_desk flag
// is on (the server sends it only while GATE_BID_DESK is on); the Bid kit tab always shows.
const TABS = [
  { key: "desk", label: "Open bids", flag: "bid_desk", param: null },
  { key: "kit", label: "Bid kit", flag: null, param: "kit" },
];

export default function BidsPage() {
  const [params, setParams] = useSearchParams();
  const desk = useFeatureFlagReady("bid_desk", false);
  const visible = TABS.filter((tab) => !tab.flag || desk.enabled);

  if (!desk.ready) return <UiSurface density="comfortable" className="mx-auto max-w-[1300px]" />;

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
