/**
 * <ContractsPage> — top-level "Contracts" surface at /admin/contracts.
 *
 * Consolidates what used to be two sibling nav items — "Documents"
 * (the reusable template library) and "Doc Requests" (the queue of
 * documents sent to customers for signature/acknowledgment) — into one
 * section with two tabs. Both halves run on the same backend pipeline
 * (document_templates -> customer_contracts), so they belong together:
 * Templates = author & send, Requests = track & follow up.
 *
 * Per-tab URL state via ?tab=<templates|requests>. Default = templates.
 *
 * Each child page keeps its own AdminCommandHeader (with its own actions
 * and level-2 filter tabs — categories for Templates, statuses for
 * Requests). This page renders only the slim top-level tab switch above
 * them, so there's no second sticky header to collide with the child's.
 *
 * Legacy /admin/documents and /admin/document-requests routes still work
 * (App.jsx redirects) so existing bookmarks land on the right tab.
 *
 * Tier 1 V2 styling.
 */
import React, { Suspense, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { FileClock, FileText } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import useRenderedTabBeacon from "../../hooks/useRenderedTabBeacon";

const DocumentTemplatesPage = React.lazy(() => import("./DocumentTemplatesPage"));
const DocumentRequestsPage = React.lazy(() => import("./DocumentRequestsPage"));

const TABS = [
  { key: "templates", label: "Templates", Icon: FileText },
  { key: "requests", label: "Requests", Icon: FileClock },
];

export default function ContractsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get("tab");
  const tab = TABS.some((t) => t.key === raw) ? raw : "templates";

  // Usage beacon for the tab that actually RENDERS — an invalid or missing
  // ?tab= resolves to Templates without rewriting the URL (Codex #2961 r17).
  useRenderedTabBeacon("/admin/contracts", tab, [searchParams]);

  const setTab = (key) => {
    // Re-clicking the active section renders nothing new — skip the URL
    // churn (and the usage beacon it would re-fire).
    if (key === tab) return;
    const next = new URLSearchParams(searchParams);
    next.set("tab", key);
    setSearchParams(next, { replace: true });
  };

  const [secondary, setSecondary] = useState(null);

  return (
    <div className="mx-auto max-w-[1500px]">
      {/* One header card: Templates / Requests on the first row; the active
          tab page hands its category/status filters + actions up for the
          second row instead of stacking a second header. */}
      <AdminCommandHeader
        title="Contracts"
        icon={FileText}
        sections={TABS}
        activeKey={tab}
        onSectionChange={setTab}
        ariaLabel="Contracts section"
        navGridClassName="grid-cols-2"
        actions={secondary?.actions}
        secondarySections={secondary?.sections || []}
        secondaryActiveKey={secondary?.activeKey}
        onSecondaryChange={secondary?.onChange}
        secondaryAriaLabel={secondary?.ariaLabel}
        secondaryNavGridClassName={secondary?.navGridClassName}
      />

      <Suspense
        fallback={
          <div className="p-10 text-13 text-ink-secondary">Loading…</div>
        }
      >
        {tab === "requests" ? (
          <DocumentRequestsPage embedded onSecondaryNav={setSecondary} />
        ) : (
          <DocumentTemplatesPage embedded onSecondaryNav={setSecondary} />
        )}
      </Suspense>
    </div>
  );
}
