import { Gavel } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { UiSurface } from "../../components/ui";
import { confirmLeaveIfGuarded } from "../../lib/navigation-guard";
import BidDeskPage from "./BidDeskPage";
import BidKitPage from "./BidKitPage";
import BuilderProspectsPage from "./BuilderProspectsPage";
import MailProspectsPage from "./MailProspectsPage";
import RestaurantProspectsPage from "./RestaurantProspectsPage";

// One menu entry, five tabs: Open bids (Bid Desk), Bid kit, Builders, Restaurants and Mail. The tab lives in the URL
// (?tab=kit, ?tab=builders, ?tab=restaurants or ?tab=mail; no tab = Open bids) so a link or a reload lands on the same view.
const TABS = [
  { key: "desk", label: "Open bids", param: null },
  { key: "kit", label: "Bid kit", param: "kit" },
  { key: "builders", label: "Builders", param: "builders" },
  { key: "restaurants", label: "Restaurants", param: "restaurants" },
  { key: "mail", label: "Mail", param: "mail" },
];

export default function BidsPage() {
  const [params, setParams] = useSearchParams();
  const active = TABS.find((tab) => tab.param && tab.param === params.get("tab")) || TABS[0];

  const select = (key) => {
    if (key === active.key || !confirmLeaveIfGuarded()) return;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      const tab = TABS.find((entry) => entry.key === key);
      if (tab.param) next.set("tab", tab.param); else next.delete("tab");
      return next;
    }, { replace: true });
  };

  return (
    <UiSurface density="comfortable" className="mx-auto max-w-[1300px]">
      <AdminCommandHeader
        variant="workspace"
        title="Bids"
        icon={Gavel}
        sections={TABS.map(({ key, label }) => ({ key, label }))}
        activeKey={active.key}
        onSectionChange={select}
        ariaLabel="Bids view"
        navGridClassName="grid-cols-2 lg:grid-cols-5"
      />
      {active.key === "kit" && <BidKitPage embedded />}
      {active.key === "builders" && <BuilderProspectsPage embedded />}
      {active.key === "restaurants" && <RestaurantProspectsPage embedded />}
      {active.key === "mail" && <MailProspectsPage embedded />}
      {active.key === "desk" && <BidDeskPage embedded />}
    </UiSurface>
  );
}
