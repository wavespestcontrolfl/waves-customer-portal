/**
 * <AssessmentsHubPage> — consolidated assessments surface at
 * /admin/lawn-assessments. Two tabs rendered under one command header:
 *   - "Lead Magnets"     — PhotoAssessmentsPage (lawn + pest lead-magnet
 *                          funnels, admin-created assessments) (default)
 *   - "Field Assessment" — LawnAssessmentPanel (tech photo-scoring flow,
 *                          turf profiles, assessment history)
 *
 * Per-tab URL state via ?tab=<key>, same pattern as AdminDispatchPage.
 * The legacy /admin/lawn-assessment route still works (App.jsx redirect to
 * ?tab=field) so existing bookmarks and internal links aren't broken.
 *
 * Why a tab wrapper (not two nav entries): the Marketing "Assessments" page
 * and the Field & Equipment "Lawn Assessment" page were two top-level areas
 * for the same subject — one canonical section removes the split.
 */
import React, { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Camera, Leaf } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import PhotoAssessmentsPage from "./PhotoAssessmentsPage";

const LawnAssessmentPanel = React.lazy(() => import("./LawnAssessmentPanel"));

const TAB_KEY = "tab";
const TABS = { FUNNEL: "funnel", FIELD: "field" };
const TAB_LIST = [
  { key: TABS.FUNNEL, label: "Lead Magnets", Icon: Camera },
  { key: TABS.FIELD, label: "Field Assessment", Icon: Leaf },
];
const VALID_TABS = TAB_LIST.map((t) => t.key);

export default function AssessmentsHubPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initial = VALID_TABS.includes(searchParams.get(TAB_KEY))
    ? searchParams.get(TAB_KEY)
    : TABS.FUNNEL;
  const [tab, setTab] = useState(initial);

  // Keep URL in sync without remount-thrashing the active tab content.
  useEffect(() => {
    const current = searchParams.get(TAB_KEY);
    if (current !== tab) {
      const next = new URLSearchParams(searchParams);
      next.set(TAB_KEY, tab);
      setSearchParams(next, { replace: true });
    }
  }, [tab]); // deliberately not keyed on searchParams — tab drives the URL

  return (
    <div className="max-w-[1200px]">
      <AdminCommandHeader
        title="Assessments"
        icon={Camera}
        sections={TAB_LIST}
        activeKey={tab}
        onSectionChange={setTab}
        ariaLabel="Assessments section"
        navGridClassName="grid-cols-2"
      />
      {tab === TABS.FIELD ? (
        <Suspense
          fallback={
            <div className="text-14 text-ink-tertiary p-10 text-center">
              Loading field assessment…
            </div>
          }
        >
          <LawnAssessmentPanel embedded />
        </Suspense>
      ) : (
        <PhotoAssessmentsPage embedded />
      )}
    </div>
  );
}
