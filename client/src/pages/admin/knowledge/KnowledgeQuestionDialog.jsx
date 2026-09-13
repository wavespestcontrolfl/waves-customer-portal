import { useRef, useState } from "react";
import {
  ActionFeedback,
  Button,
  Dialog,
  DialogBody,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  UiSurface,
} from "../../../components/ui";
import { adminFetch } from "../../../utils/admin-fetch";

export default function KnowledgeQuestionDialog({ open, onClose }) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState(null);
  const [asking, setAsking] = useState(false);
  const [filingBack, setFilingBack] = useState(false);
  const [error, setError] = useState("");
  const askingRef = useRef(false);
  const filingBackRef = useRef(false);

  const handleAsk = async (event) => {
    event?.preventDefault();
    if (askingRef.current || !question.trim()) return;

    askingRef.current = true;
    setAsking(true);
    setResult(null);
    setError("");
    try {
      setResult(await adminFetch("/admin/knowledge/query", {
        method: "POST",
        body: JSON.stringify({ question }),
      }));
    } catch (requestError) {
      setError(requestError?.message || "Could not answer the question.");
    } finally {
      askingRef.current = false;
      setAsking(false);
    }
  };

  const handleFileBack = async () => {
    const queryId = result?.queryId;
    if (filingBackRef.current || !queryId || result.filedBack) return;

    filingBackRef.current = true;
    setFilingBack(true);
    setError("");
    try {
      await adminFetch("/admin/knowledge/file-back", {
        method: "POST",
        body: JSON.stringify({ queryId }),
      });
      setResult((previous) => previous?.queryId === queryId
        ? { ...previous, filedBack: true }
        : previous);
    } catch (requestError) {
      setError(requestError?.message || "Could not file this answer into the wiki.");
    } finally {
      filingBackRef.current = false;
      setFilingBack(false);
    }
  };

  const sourceNames = (result?.articleTitles || [])
    .map((article) => article.title || article)
    .join(", ") || (result?.articlesUsed || []).join(", ");

  return (
    <UiSurface density="comfortable">
      <Dialog open={open} onClose={onClose}>
        <DialogHeader>
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>Ask the knowledge base</DialogTitle>
            <Button
              variant="ghost"
              onClick={onClose}
              aria-label="Close question dialog"
            >
              Close
            </Button>
          </div>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <form className="space-y-3" onSubmit={handleAsk}>
            <Field label="Question">
              <Input
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="What's the max annual rate for Celsius WG?"
                autoFocus
              />
            </Field>
            <Button
              type="submit"
              loading={asking}
              disabled={!question.trim()}
            >
              Ask
            </Button>
          </form>

          {error && <ActionFeedback error>{error}</ActionFeedback>}

          {result && (
            <section className="space-y-3" aria-label="Answer">
              <div className="whitespace-pre-wrap rounded-md border-hairline border-zinc-200 bg-zinc-50 p-4 text-ui-body leading-relaxed text-zinc-800">
                {result.answer}
              </div>
              {sourceNames && (
                <p className="text-ui-caption text-ink-secondary">
                  Sources: {sourceNames}
                </p>
              )}
              <div className="ui-record-actions">
                <Button
                  variant="secondary"
                  disabled
                  title="Answer feedback is not available."
                >
                  Good
                </Button>
                <Button
                  variant="secondary"
                  disabled
                  title="Answer feedback is not available."
                >
                  Incomplete
                </Button>
                {!result.filedBack && (
                  result.queryId ? (
                    <Button
                      variant="secondary"
                      loading={filingBack}
                      onClick={handleFileBack}
                    >
                      File into wiki
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      disabled
                      aria-describedby="wiki-file-back-unavailable"
                    >
                      File into wiki
                    </Button>
                  )
                )}
                {result.filedBack && (
                  <span className="self-center text-ui-caption text-ink-secondary">
                    Filed
                  </span>
                )}
              </div>
              {!result.filedBack && !result.queryId && (
                <p
                  id="wiki-file-back-unavailable"
                  className="text-ui-caption text-ink-secondary"
                >
                  Filing into the wiki is unavailable for this answer.
                </p>
              )}
            </section>
          )}
        </DialogBody>
      </Dialog>
    </UiSurface>
  );
}
