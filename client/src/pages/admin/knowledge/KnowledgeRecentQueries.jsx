import {
  ActionFeedback,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  UiSurface,
} from "../../../components/ui";

export default function KnowledgeRecentQueries({ queries, loading, error, onRetry }) {
  let content;

  if (loading) {
    content = <ActionFeedback>Loading recent queries…</ActionFeedback>;
  } else if (error) {
    content = (
      <ActionFeedback error onRetry={onRetry}>
        {error}
      </ActionFeedback>
    );
  } else if (queries.length === 0) {
    content = (
      <Card>
        <CardBody className="py-10 text-center text-ui-body text-ink-secondary">
          No queries yet. Click “Ask a question” to start.
        </CardBody>
      </Card>
    );
  } else {
    content = (
      <div className="grid gap-3 lg:grid-cols-2">
        {queries.map((query) => (
          <Card key={query.id}>
            <CardHeader>
              <CardTitle>Q: {query.query}</CardTitle>
            </CardHeader>
            <CardBody className="space-y-3">
              <p className="max-h-32 overflow-hidden text-ui-body leading-relaxed text-zinc-800">
                {query.answer}
              </p>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-ui-caption text-ink-secondary u-nums">
                <span>{query.asked_by}</span>
                <span>{new Date(query.created_at).toLocaleString()}</span>
                {query.response_quality && <span>{query.response_quality}/5</span>}
                {query.filed_back && <span>Filed back</span>}
              </div>
            </CardBody>
          </Card>
        ))}
      </div>
    );
  }

  return <UiSurface density="comfortable">{content}</UiSurface>;
}
