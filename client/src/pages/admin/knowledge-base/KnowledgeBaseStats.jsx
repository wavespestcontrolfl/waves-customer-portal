import { ActionFeedback, Card, CardBody } from "../../../components/ui";

const STAT_ITEMS = [
  { key: "active", label: "Active" },
  { key: "flagged", label: "Flagged" },
  { key: "stale", label: "Stale (30d+)" },
  { key: "highConfidence", label: "High Conf" },
  { key: "lowConfidence", label: "Needs Review" },
];

export default function KnowledgeBaseStats({ stats, loading, error, onRetry }) {
  return (
    <section aria-label="Knowledge base totals" className="mb-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {STAT_ITEMS.map(({ key, label }) => (
          <Card key={key}>
            <CardBody className="min-h-[82px] text-center">
              <div className="u-nums text-22 leading-[1.3] font-medium text-zinc-900">
                {stats?.[key] ?? "—"}
              </div>
              <div className="mt-1 text-ui-caption text-ink-secondary">{label}</div>
            </CardBody>
          </Card>
        ))}
      </div>
      {loading && (
        <ActionFeedback className="mt-3">Loading knowledge base totals…</ActionFeedback>
      )}
      {error && (
        <ActionFeedback error onRetry={onRetry} className="mt-3">
          {error}
        </ActionFeedback>
      )}
    </section>
  );
}
