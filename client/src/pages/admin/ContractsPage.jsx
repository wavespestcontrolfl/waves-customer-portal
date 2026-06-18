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
import React, { Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { FileClock, FileText } from "lucide-react";
import { cn } from "../../components/ui";

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

  const setTab = (key) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", key);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="mx-auto max-w-[1500px]">
      <nav
        aria-label="Contracts section"
        className="mb-4 flex items-center gap-1"
      >
        {TABS.map(({ key, label, Icon }) => {
          const active = tab === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex items-center gap-2 h-9 px-3 rounded-sm text-12 font-medium uppercase tracking-label u-focus-ring transition-colors",
                active
                  ? "bg-zinc-900 text-white"
                  : "bg-white text-zinc-700 border-hairline border-zinc-200 hover:bg-zinc-50 hover:text-zinc-900",
              )}
            >
              <Icon size={15} strokeWidth={1.8} aria-hidden />
              {label}
            </button>
          );
        })}
      </nav>

      <Suspense
        fallback={
          <div className="p-10 text-13 text-ink-secondary">Loading…</div>
        }
      >
        {tab === "requests" ? <DocumentRequestsPage /> : <DocumentTemplatesPage />}
      </Suspense>
    </div>
  );
}
