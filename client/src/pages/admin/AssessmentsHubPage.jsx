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
import React, { Suspense, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Camera, Leaf } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import PhotoAssessmentsPage from "./PhotoAssessmentsPage";
import { trackAdminPageView } from "../../lib/adminUsage";

const LawnAssessmentPanel = React.lazy(() => import("./LawnAssessmentPanel"));

const TAB_KEY = "tab";
const TABS = { FUNNEL: "funnel", FIELD: "field" };
const TAB_LIST = [
  { key: TABS.FUNNEL, label: "Lead Magnets", Icon: Camera },
  { key: TABS.FIELD, label: "Field Assessment", Icon: Leaf },
];
const VALID_TABS = TAB_LIST.map((t) => t.key);

export default function AssessmentsHubPage() {
  // The URL is the source of truth for the active tab — no mirrored local
  // state. Query-only navigation while the hub is mounted (sidebar click
  // clearing ?tab, a ?tab=field deep link from lawn-protocol) re-renders
  // with the right tab instead of going stale.
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get(TAB_KEY);
  const tab = VALID_TABS.includes(requested) ? requested : TABS.FUNNEL;

  const setTab = (key) => {
    // Re-clicking the active section renders nothing new — skip the URL
    // churn (and the usage beacon it would re-fire), matching Settings.
    if (key === tab) return;
    const next = new URLSearchParams(searchParams);
    next.set(TAB_KEY, key);
    setSearchParams(next, { replace: true });
  };

  // Usage beacon for the tab that actually RENDERS: an invalid deep link
  // (?tab=typo) falls back to Lead Magnets without rewriting the URL, so
  // the layout's raw-query beacon would record a tab that never rendered
  // (Codex #2961 r14). The authoritative beacon supersedes it — this page
  // is listed in SELF_REPORTING_PAGES (lib/adminUsage.js). searchParams is
  // a dep so a query-only change that does NOT move the resolved tab
  // (another bad deep link) still re-asserts the rendered tab.
  useEffect(() => {
    trackAdminPageView({
      pathname: "/admin/lawn-assessments",
      search: `?tab=${tab}`,
      authoritative: true,
    });
  }, [tab, searchParams]);

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
