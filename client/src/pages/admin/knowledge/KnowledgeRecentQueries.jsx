import { useState } from "react";
import {
  ActionFeedback,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  UiSurface,
  cn,
} from "../../../components/ui";

// Spec §5.7: answers are collapsed to three lines and expandable. The toggle is
// rendered for every answer rather than measured, so the control never depends
// on a layout read that jsdom and the first paint cannot supply.
function QueryCard({ query }) {
  const [expanded, setExpanded] = useState(false);
  const answerId = `knowledge-query-answer-${query.id}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Q: {query.query}</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <p
          id={answerId}
          className={cn(
            "text-ui-body leading-relaxed text-zinc-800",
            !expanded && "line-clamp-3",
          )}
        >
          {query.answer}
        </p>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          aria-controls={answerId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show full answer"}
        </Button>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-ui-caption text-ink-secondary u-nums">
          <span>{query.asked_by}</span>
          <span>{new Date(query.created_at).toLocaleString()}</span>
          {query.response_quality && <span>{query.response_quality}/5</span>}
          {query.filed_back && <span>Filed back</span>}
        </div>
      </CardBody>
    </Card>
  );
}

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
          <QueryCard key={query.id} query={query} />
        ))}
      </div>
    );
  }

  return <UiSurface density="comfortable">{content}</UiSurface>;
}
