import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  CardTitle,
  Field,
  Input,
} from "../../../components/ui";

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

export default function KnowledgeArticleDirectory({
  articles,
  categoryCounts,
  filterCategory,
  loading,
  error,
  onCategoryChange,
  onArticleOpen,
  onRetry,
  search,
  onSearchChange,
}) {
  return (
    <div className="space-y-4">
      {Object.keys(categoryCounts).length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {Object.entries(categoryCounts)
            .sort((left, right) => right[1] - left[1])
            .map(([category, count]) => {
              const selected = filterCategory === category;
              return (
                <Button
                  key={category}
                  variant={selected ? "primary" : "secondary"}
                  className="h-auto min-h-16 flex-col gap-1 py-3 text-center"
                  aria-pressed={selected}
                  aria-label={`${selected ? "Clear" : "Filter by"} ${category} category, ${count} articles`}
                  onClick={() => onCategoryChange(selected ? "" : category)}
                >
                  <span className="capitalize">{category}</span>
                  <span className="text-18 u-nums">{count}</span>
                </Button>
              );
            })}
        </div>
      )}

      <Field label="Search articles">
        <Input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search articles…"
        />
      </Field>

      {loading ? (
        <div className="min-h-40 rounded-md border-hairline border-zinc-200 bg-white p-4">
          <ActionFeedback className="h-full justify-center">
            Loading articles…
          </ActionFeedback>
        </div>
      ) : error ? (
        <ActionFeedback error onRetry={onRetry}>{error}</ActionFeedback>
      ) : articles.length === 0 ? (
        <Card>
          <CardBody className="py-12 text-center">
            <CardTitle className="text-18">No articles yet</CardTitle>
            <p className="mt-2 text-ui-body text-ink-secondary">
              Add source documents and compile them to build your knowledge base.
            </p>
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {articles.map((article) => {
            const tags = normalizeTags(article.tags);
            return (
              <Card key={article.id} className="min-w-0">
                <button
                  type="button"
                  className="u-focus-ring block min-h-24 w-full appearance-none rounded-md border-0 bg-white p-4 text-left text-ui-body hover:bg-zinc-50"
                  onClick={() => onArticleOpen(article.id)}
                  aria-label={`Open article: ${article.title}`}
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-14 font-medium leading-[1.4] text-zinc-900">
                        {article.title}
                      </h3>
                      <p className="mt-1 line-clamp-2 text-ui-caption text-ink-secondary">
                        {article.summary || article.path}
                      </p>
                    </div>
                    <span className="shrink-0 text-ui-caption text-ink-secondary u-nums">
                      {article.word_count}w
                    </span>
                  </div>
                  {tags.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2" aria-label="Article tags">
                      {tags.slice(0, 5).map((tag, index) => (
                        <Badge key={`${tag}-${index}`}>{tag}</Badge>
                      ))}
                    </div>
                  )}
                </button>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
