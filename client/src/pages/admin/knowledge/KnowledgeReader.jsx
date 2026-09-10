import { useEffect, useState } from "react";
import { ActionFeedback, Badge, Card, CardBody, CardHeader, CardTitle, UiSurface } from "../../../components/ui";
import { adminFetch } from "../../../utils/admin-fetch";

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags;
  if (typeof tags !== "string") return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function LoadingState({ children }) {
  return (
    <UiSurface className="min-h-40 rounded-md border-hairline border-zinc-200 bg-white p-4">
      <ActionFeedback className="h-full justify-center">{children}</ActionFeedback>
    </UiSurface>
  );
}

export function ArticleViewer({ articleId }) {
  const [article, setArticle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setArticle(null);
    setError("");
    adminFetch(`/admin/knowledge/article/${articleId}`)
      .then((data) => {
        if (!active) return;
        setArticle(data.article || null);
        if (!data.article) setError("Article not found.");
      })
      .catch((requestError) => {
        if (active) {
          setError(requestError?.message || "Could not load this article.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [articleId, attempt]);

  if (loading) return <LoadingState>Loading article…</LoadingState>;
  if (error || !article) {
    return (
      <UiSurface>
        <ActionFeedback error onRetry={() => setAttempt((value) => value + 1)}>
        {error || "Article not found."}
        </ActionFeedback>
      </UiSurface>
    );
  }

  const tags = normalizeTags(article.tags);

  return (
    <UiSurface as="article" className="mx-auto flex max-w-[720px] flex-col gap-4">
      <Card>
        <CardHeader className="space-y-1">
          <h2 className="text-22 font-medium leading-[1.3] text-zinc-900">
            {article.title}
          </h2>
          <p className="break-words text-ui-caption text-ink-secondary u-nums">
            {article.path} • v{article.version} • {article.word_count} words
          </p>
        </CardHeader>
        <CardBody className="space-y-3">
          {article.summary && (
            <p className="rounded-md border-l-2 border-zinc-900 bg-zinc-50 px-4 py-3 text-ui-body leading-relaxed text-zinc-800">
              {article.summary}
            </p>
          )}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-2" aria-label="Article tags">
              {tags.map((tag, index) => (
                <Badge key={`${tag}-${index}`}>{tag}</Badge>
              ))}
            </div>
          )}
          {(article.last_compiled || article.last_verified) && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-ui-caption text-ink-secondary u-nums">
              {article.last_compiled && (
                <span>
                  Compiled: {new Date(article.last_compiled).toLocaleDateString()}
                </span>
              )}
              {article.last_verified && (
                <span>
                  Verified: {new Date(article.last_verified).toLocaleDateString()}
                </span>
              )}
            </div>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardBody className="break-words whitespace-pre-wrap text-[15px] leading-[1.8] text-zinc-800">
          {article.content}
        </CardBody>
      </Card>
    </UiSurface>
  );
}

export function HealthCheck() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    adminFetch("/admin/knowledge/health")
      .then((data) => {
        if (active) setHealth(data);
      })
      .catch((requestError) => {
        if (active) {
          setError(requestError?.message || "Could not run the health check.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  if (loading) return <LoadingState>Running health check…</LoadingState>;
  if (error || !health) {
    return (
      <UiSurface>
        <ActionFeedback error onRetry={() => setAttempt((value) => value + 1)}>
        {error || "Could not run the health check."}
        </ActionFeedback>
      </UiSurface>
    );
  }

  const issuesAvailable = Array.isArray(health.issues);
  const issues = issuesAvailable ? health.issues : [];
  const scoreIsAlert = typeof health.healthScore === "number" && health.healthScore < 60;

  return (
    <UiSurface as={Card}>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-4">
          <div
            className={`flex h-16 w-16 items-center justify-center rounded-md border text-22 font-medium u-nums ${
              scoreIsAlert
                ? "border-alert-fg bg-alert-bg text-alert-fg"
                : "border-zinc-300 bg-zinc-50 text-zinc-900"
            }`}
            aria-label={`Wiki health score: ${health.healthScore ?? "unavailable"}`}
          >
            {health.healthScore ?? "—"}
          </div>
          <div>
            <CardTitle className="text-18">Wiki health score</CardTitle>
            <p className="mt-1 text-ui-caption text-ink-secondary u-nums">
              {health.totalArticles ?? "Unavailable"} articles • {issuesAvailable ? issues.length : "Unavailable"} issues
            </p>
          </div>
        </div>
      </CardHeader>
      <CardBody>
        {!issuesAvailable ? (
          <ActionFeedback error>Health issues are unavailable.</ActionFeedback>
        ) : issues.length > 0 ? (
          <div className="space-y-2">
            {issues.slice(0, 15).map((issue, index) => (
              <div
                key={`${issue.article || issue.title || "issue"}-${index}`}
                className={`rounded-md border-l-2 bg-zinc-50 px-3 py-2 text-ui-body ${
                  issue.severity === "high" ? "border-alert-fg" : "border-zinc-400"
                }`}
              >
                <span className="font-medium text-zinc-900">
                  {issue.title || issue.article}
                </span>{" "}
                <span className="text-ink-secondary">— {issue.detail}</span>
              </div>
            ))}
            {issues.length > 15 && (
              <p className="px-3 text-ui-caption text-ink-secondary u-nums">
                … and {issues.length - 15} more
              </p>
            )}
          </div>
        ) : (
          <ActionFeedback>No issues found</ActionFeedback>
        )}
      </CardBody>
    </UiSurface>
  );
}
