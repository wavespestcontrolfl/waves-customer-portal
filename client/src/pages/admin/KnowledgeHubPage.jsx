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
    <div className="mx-auto max-w-[1300px]">
      <UiSurface density="comfortable">
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
      </UiSurface>

      <Suspense
        fallback={(
          <div className="p-10 text-center text-14 text-ink-tertiary">
            Loading knowledge workspace…
          </div>
        )}
      >
        {area === "base" ? (
          <KnowledgeBasePage embedded />
        ) : (
          <KnowledgePage embedded />
        )}
      </Suspense>
    </div>
  );
}
