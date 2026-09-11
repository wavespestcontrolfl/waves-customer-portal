import React, { Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { BookOpen, Brain, Library } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import { UiSurface } from "../../components/ui";

const KnowledgePage = React.lazy(() => import("./KnowledgePage"));
const KnowledgeBasePage = React.lazy(() => import("./KnowledgeBasePage"));

const AREAS = [
  { key: "wiki", label: "Wiki", Icon: BookOpen },
  { key: "base", label: "Knowledge Base", Icon: Brain },
];

export default function KnowledgeHubPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const area = searchParams.get("area") === "base" ? "base" : "wiki";

  const setArea = (nextArea) => {
    const next = new URLSearchParams(searchParams);
    if (nextArea === "base") {
      next.set("area", "base");
      next.delete("wikiTab");
    } else {
      next.delete("area");
      next.delete("kbTab");
    }
    setSearchParams(next, { replace: true });
  };

  return (
    // The density context wraps the whole workspace rather than the header
    // alone: a wrapper no taller than the header would become the sticky
    // header's containing block and pin it out of view as the content scrolls.
    <UiSurface density="comfortable" className="mx-auto max-w-[1300px]">
      <AdminCommandHeader
        variant="workspace"
        title="Knowledge"
        icon={Library}
        sections={AREAS}
        activeKey={area}
        onSectionChange={setArea}
        ariaLabel="Knowledge area"
        navGridClassName="grid-cols-2"
      />

      <Suspense
        fallback={(
          <div className="p-10 text-center text-14 text-ink-tertiary">
            Loading knowledge workspace…
          </div>
        )}
      >
        {/* The children are still on legacy presentation -- their own
            AdminCommandHeader reads the density from context, so the hub's
            comfortable scope has to stop here. Migrated panels inside them
            re-establish comfortable on their own surfaces. */}
        <UiSurface density="legacy">
          {area === "base" ? (
            <KnowledgeBasePage embedded />
          ) : (
            <KnowledgePage embedded />
          )}
        </UiSurface>
      </Suspense>
    </UiSurface>
  );
}
